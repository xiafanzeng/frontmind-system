import { describe, expect, it } from "vitest";
import { contentProductionInputSchema } from "../shared/content-production";
import {
  contentProductionPublicDto,
  parseContentRunnerState,
  reduceContentProductionProgress,
  type ContentRunnerObservation,
} from "./content-production-state";
import {
  contentProductionSystemAttachments,
  originalContentWorkflowArchive,
  CONTENT_WORKFLOW_SHA256,
} from "./content-production-runtime";
import { createHash } from "node:crypto";

const observation = (
  rank: number,
  stage: string,
  status: string,
): ContentRunnerObservation => ({
  providerRank: rank,
  eventId: `event-${rank}`,
  artifactId: `artifact-${rank}`,
  sha256: "a".repeat(64),
  state: parseContentRunnerState(
    Buffer.from(
      JSON.stringify({
        schema_version: "2.3.0",
        job_id: "job-original",
        workflow_mode: stage.startsWith("S") ? "prepare" : "article",
        updated_at: `2026-09-06T10:00:${String(rank).padStart(2, "0")}+00:00`,
        current_stage: stage,
        status,
      }),
    ),
  )!,
});
describe("original content workflow progress", () => {
  it("parses only actual compatible Runner state objects and excludes arbitrary internal fields", () => {
    expect(
      parseContentRunnerState(Buffer.from("Runner reached E10")),
    ).toBeNull();
    expect(
      observation(1, "E4", "awaiting_blueprint_confirmation").state,
    ).toMatchObject({ current_stage: "E4" });
    expect(observation(2, "E4", "awaiting_title_count").state).toBeNull();
    expect(parseContentRunnerState(Buffer.alloc(256 * 1024 + 1))).toBeNull();
  });
  it("retains the highest reached position while exposing the Runner's real corrected confirmation", () => {
    const initial = reduceContentProductionProgress(
      null,
      observation(1, "E4", "awaiting_blueprint_confirmation"),
      "single_article",
    );
    const corrected = reduceContentProductionProgress(
      initial,
      observation(2, "E2", "awaiting_pattern_confirmation"),
      "single_article",
    );
    expect(corrected.progressPosition).toBe(13);
    expect(corrected.completedConfirmations).toEqual([]);
    const context = {
      revision: 1 as const,
      accountUserId: 7,
      purpose: "content_production" as const,
      knowledgeBase: null,
      knowledgeText: null,
      contentProduction: contentProductionInputSchema.parse({
        mode: "single_article",
        enterpriseName: "Brand",
        knowledgeSource: "files",
      }),
    };
    expect(
      contentProductionPublicDto(context, {
        contentProductionProgress: corrected,
      }),
    ).toMatchObject({
      currentStage: "E2",
      confirmation: "awaiting_pattern_confirmation",
      availableActions: ["confirm_pattern"],
      progressPosition: 13,
    });
    expect(
      reduceContentProductionProgress(
        corrected,
        observation(1, "E4", "awaiting_blueprint_confirmation"),
        "single_article",
      ),
    ).toBe(corrected);
    const continued = reduceContentProductionProgress(
      corrected,
      observation(3, "E4", "awaiting_blueprint_confirmation"),
      "single_article",
    );
    expect(continued.completedConfirmations).toEqual([
      "awaiting_pattern_confirmation",
    ]);
  });
  it("accepts later states in the same native output event and ignores copied stale state in later events", () => {
    const pack = observation(4, "S9", "completed");
    const article = observation(4, "E4", "awaiting_blueprint_confirmation");
    pack.state.updated_at = "2026-09-06T10:00:04.123456+00:00";
    article.state.updated_at = "2026-09-06T10:00:04.123457+00:00";
    const initial = reduceContentProductionProgress(
      null,
      pack,
      "single_article",
    );
    const next = reduceContentProductionProgress(
      initial,
      article,
      "single_article",
    );
    expect(next.lastObservation.state.current_stage).toBe("E4");
    expect(next.progressPosition).toBe(13);
    expect(
      reduceContentProductionProgress(
        next,
        { ...pack, providerRank: 6 },
        "single_article",
      ),
    ).toBe(next);
  });
  it("does not mark skipped foundation research confirmed and requires the mode's real final stage", () => {
    const foundation = reduceContentProductionProgress(
      null,
      observation(1, "E4", "awaiting_blueprint_confirmation"),
      "foundation_article",
    );
    expect(foundation.completedConfirmations).toEqual([]);
    expect(
      reduceContentProductionProgress(
        null,
        observation(1, "S9", "completed"),
        "single_article",
      ).progressPosition,
    ).toBe(9);
    expect(
      reduceContentProductionProgress(
        null,
        observation(1, "S9", "completed"),
        "new_reference_pack",
      ).progressPosition,
    ).toBe(20);
    const titles = reduceContentProductionProgress(
      foundation,
      observation(2, "E10", "awaiting_title_count"),
      "foundation_article",
    );
    const complete = reduceContentProductionProgress(
      titles,
      observation(3, "E10", "completed"),
      "foundation_article",
    );
    expect(complete.progressPosition).toBe(20);
    expect(complete.completedConfirmations).toContain("awaiting_title_count");
  });
  it("mounts the original 2.3 ZIP unchanged and accepts existing local asset identities", () => {
    const input = contentProductionInputSchema.parse({
      mode: "single_article",
      enterpriseName: "Brand",
      knowledgeSource: "files",
      monitoringAnswerAssetIds: ["asset_abc123"],
      sourceWorkbookAssetId: "asset_xyz789",
    });
    const bytes = originalContentWorkflowArchive();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      CONTENT_WORKFLOW_SHA256,
    );
    const attachments = contentProductionSystemAttachments({
      revision: 1,
      accountUserId: 7,
      purpose: "content_production",
      knowledgeBase: null,
      knowledgeText: null,
      contentProduction: input,
    });
    expect(
      Buffer.from(attachments[0].file_data!.split(",")[1], "base64"),
    ).toEqual(bytes);
    expect(attachments).toHaveLength(1);
  });
});
