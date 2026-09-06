import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CONTENT_PRODUCTION_CONFIRMATIONS,
  CONTENT_PRODUCTION_RUNNER_STATUSES,
  contentProductionActionSchema,
  contentProductionInputSchema,
  type ContentProductionJobKind,
} from "../shared/content-production";
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

function originalState(
  status: string,
  stage: string,
  jobKind: ContentProductionJobKind = "article",
  revision = 1,
) {
  const pause = CONTENT_PRODUCTION_CONFIRMATIONS.includes(status as any);
  return {
    schema_version: "4.11",
    artifact_type: "frontmind_content_job_state",
    workflow_version: "4.11",
    job_id: "job-original",
    job_kind: jobKind,
    stage,
    status,
    revision,
    created_at: "2026-09-06T10:00:00+00:00",
    updated_at: "2026-09-06T10:00:01+00:00",
    reference_pack: null,
    question: null,
    selected_pattern_id: null,
    selected_example_route: null,
    p0_route: null,
    flags: {},
    decisions: {},
    metadata: { internal: "not customer output" },
    current_pause: pause
      ? {
          contract: "frontmind-user-pause/v3",
          pause_type: status,
          title: "原始确认页",
          review_markdown_path: "/private/job/reviews/original.md",
          available_choices: ["原始选择"],
          full_text_links: ["/private/job/full.md"],
          source_links: [],
          revision,
          requires_user_input: true,
          user_pause: true,
          must_stop: true,
        }
      : null,
    pending_action: null,
  };
}
function observation(
  rank: number,
  status: string,
  stage: string,
  kind: ContentProductionJobKind = "article",
): ContentRunnerObservation {
  const raw = originalState(status, stage, kind, rank);
  raw.updated_at = `2026-09-06T10:00:${String(rank).padStart(2, "0")}+00:00`;
  return {
    providerRank: rank,
    eventId: `event-${rank}`,
    artifactId: `artifact-${rank}`,
    sha256: "a".repeat(64),
    state: parseContentRunnerState(Buffer.from(JSON.stringify(raw)))!,
  };
}
function context(mode: "single_article" | "p0" = "single_article") {
  return {
    revision: 1 as const,
    accountUserId: 7,
    purpose: "content_production" as const,
    knowledgeBase: null,
    knowledgeText: null,
    contentProduction: contentProductionInputSchema.parse({
      mode,
      enterpriseName: "Brand",
      knowledgeSource: "files",
    }),
  };
}

describe("original v4.11 content workflow state", () => {
  it.each(CONTENT_PRODUCTION_CONFIRMATIONS)(
    "preserves native pause %s with revision and choices",
    (status) => {
      const state = parseContentRunnerState(
        Buffer.from(JSON.stringify(originalState(status, "original_stage"))),
      )!;
      expect(state.status).toBe(status);
      expect(state.current_pause).toMatchObject({
        revision: 1,
        available_choices: ["原始选择"],
      });
      expect(state).not.toHaveProperty("metadata");
      expect(state.current_pause).not.toHaveProperty("review_markdown_path");
      const progress = reduceContentProductionProgress(
        null,
        { ...observation(1, status, "original_stage"), state },
        "single_article",
      );
      expect(
        contentProductionPublicDto(context(), {
          contentProductionProgress: progress,
        }),
      ).toMatchObject({
        workflowVersion: "4.11.0",
        runnerRevision: 1,
        confirmation: status,
        choices: ["原始选择"],
        pauseTitle: "原始确认页",
      });
    },
  );
  it("accepts real research/synthesis statuses omitted from the ZIP's legacy JSON schema enum", () => {
    for (const status of [
      "running_positioning_market_research",
      "running_positioning_value_synthesis",
    ])
      expect(
        observation(1, status, "positioning", "reference_pack").state.status,
      ).toBe(status);
    expect(CONTENT_PRODUCTION_RUNNER_STATUSES).not.toContain(
      "awaiting_title_count",
    );
  });
  it("rejects prose, old state, mismatched pause revisions and unfinished terminal actions", () => {
    expect(
      parseContentRunnerState(Buffer.from("Runner reached E10")),
    ).toBeNull();
    expect(
      parseContentRunnerState(
        Buffer.from(
          JSON.stringify({
            schema_version: "2.3.0",
            workflow_mode: "article",
            current_stage: "E10",
            status: "completed",
          }),
        ),
      ),
    ).toBeNull();
    const raw = originalState(
      "awaiting_competitor_selection",
      "positioning",
      "reference_pack",
    );
    raw.current_pause!.revision = 2;
    expect(
      parseContentRunnerState(Buffer.from(JSON.stringify(raw))),
    ).toBeNull();
    raw.current_pause!.revision = 1;
    raw.current_pause!.pause_type = "awaiting_core_positioning_confirmation";
    expect(
      parseContentRunnerState(Buffer.from(JSON.stringify(raw))),
    ).toBeNull();
    expect(
      parseContentRunnerState(
        Buffer.from(
          JSON.stringify({
            ...originalState("completed", "E10"),
            pending_action: { action: "article_titles" },
          }),
        ),
      ),
    ).toBeNull();
    expect(observation(1, "completed", "article_production").state).toBeNull();
    expect(parseContentRunnerState(Buffer.alloc(256 * 1024 + 1))).toBeNull();
  });
  it("keeps lane forward, actual earlier corrections available, and only actual confirmed decisions", () => {
    const blueprint = observation(
      1,
      "awaiting_blueprint_confirmation",
      "blueprint",
    );
    blueprint.state.decisions.pattern = { revision: 1 };
    const initial = reduceContentProductionProgress(
      null,
      blueprint,
      "single_article",
    );
    expect(initial.completedConfirmations).toEqual([
      "awaiting_pattern_confirmation",
    ]);
    const corrected = reduceContentProductionProgress(
      initial,
      observation(2, "awaiting_pattern_confirmation", "E2"),
      "single_article",
    );
    expect(corrected.progressPosition).toBe(18);
    expect(corrected.completedConfirmations).toEqual([]);
    expect(
      contentProductionPublicDto(context(), {
        contentProductionProgress: corrected,
      }),
    ).toMatchObject({
      currentStage: "E2",
      confirmation: "awaiting_pattern_confirmation",
      availableActions: ["confirm_pattern", "revise_current_step"],
      progressPosition: 18,
    });
    expect(
      reduceContentProductionProgress(corrected, blueprint, "single_article"),
    ).toBe(corrected);
  });
  it("keeps competitor selection separate from final positioning confirmation", () => {
    const initial = reduceContentProductionProgress(
      null,
      observation(
        1,
        "awaiting_competitor_selection",
        "positioning",
        "reference_pack",
      ),
      "new_reference_pack",
    );
    expect(initial.progressPosition).toBe(4);
    const core = observation(
      2,
      "awaiting_core_positioning_confirmation",
      "positioning",
      "reference_pack",
    );
    core.state.decisions.comparison_scope = { confirmed: true };
    const next = reduceContentProductionProgress(
      initial,
      core,
      "new_reference_pack",
    );
    expect(next.progressPosition).toBe(6);
    expect(next.completedConfirmations).toEqual([
      "awaiting_competitor_selection",
    ]);
  });
  it("orders multiple state files in one event by real microseconds and ignores late stale copies", () => {
    const research = observation(
      4,
      "running_positioning_market_research",
      "positioning_research",
      "reference_pack",
    );
    const select = observation(
      4,
      "awaiting_competitor_selection",
      "positioning",
      "reference_pack",
    );
    research.state.updated_at = "2026-09-06T10:00:04.123456+00:00";
    select.state.updated_at = "2026-09-06T10:00:04.123457+00:00";
    const initial = reduceContentProductionProgress(
      null,
      research,
      "new_reference_pack",
    );
    const next = reduceContentProductionProgress(
      initial,
      select,
      "new_reference_pack",
    );
    expect(next.lastObservation.state.status).toBe(
      "awaiting_competitor_selection",
    );
    expect(
      reduceContentProductionProgress(
        next,
        { ...research, providerRank: 6 },
        "new_reference_pack",
      ),
    ).toBe(next);
  });
  it("requires the requested terminal rather than treating a prerequisite Pack as a written article", () => {
    const pack = observation(
      1,
      "positioning_ready",
      "reference_pack",
      "reference_pack",
    );
    expect(
      reduceContentProductionProgress(null, pack, "new_reference_pack")
        .progressPosition,
    ).toBe(20);
    expect(
      reduceContentProductionProgress(null, pack, "p0").progressPosition,
    ).toBe(7);
    expect(
      reduceContentProductionProgress(null, pack, "single_article")
        .progressPosition,
    ).toBe(7);
    const p0 = observation(2, "p0_ready", "reference_pack", "p0");
    p0.state.p0_route = "import";
    expect(
      reduceContentProductionProgress(null, p0, "p0").progressPosition,
    ).toBe(20);
    expect(
      reduceContentProductionProgress(null, p0, "import_foundation")
        .progressPosition,
    ).toBe(20);
    expect(
      reduceContentProductionProgress(null, p0, "single_article")
        .progressPosition,
    ).toBe(12);
    const article = observation(3, "completed", "E10");
    expect(
      reduceContentProductionProgress(null, article, "single_article")
        .progressPosition,
    ).toBe(20);
    expect(
      reduceContentProductionProgress(null, article, "p0").progressPosition,
    ).toBe(19);
  });
  it("does not reuse old v2.3 progress as v4.11 completion", () => {
    expect(
      contentProductionPublicDto(context(), {
        contentProductionProgress: {
          revision: 1,
          progressPosition: 20,
          completedConfirmations: ["awaiting_title_count"],
        },
      }),
    ).toMatchObject({
      source: "awaiting_runner",
      progressPosition: 0,
      runnerRevision: null,
    });
  });
  it("mounts the precise original v4.11 ZIP unchanged and preserves existing asset identities", () => {
    const input = contentProductionInputSchema.parse({
      mode: "single_article",
      enterpriseName: "Brand",
      knowledgeSource: "files",
      questionId: "q001",
      monitoringAnswerAssetIds: ["asset_abc123"],
      sourceWorkbookAssetId: "asset_xyz789",
    });
    const bytes = originalContentWorkflowArchive();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      CONTENT_WORKFLOW_SHA256,
    );
    expect(CONTENT_WORKFLOW_SHA256).toBe(
      "fc73c4334d57dc7b4382cc6a0be3d9ffe498aa168273032b9d0d8a7fba462bcb",
    );
    const attachments = contentProductionSystemAttachments({
      ...context(),
      contentProduction: input,
    });
    expect(
      Buffer.from(attachments[0].file_data!.split(",")[1], "base64").equals(
        bytes,
      ),
    ).toBe(true);
    expect(attachments).toHaveLength(1);
  });
});

describe("native v4.11 user actions", () => {
  it("requires observed revision and removes obsolete title-count/pack-summary actions", () => {
    expect(
      contentProductionActionSchema.safeParse({ kind: "confirm_competitors" })
        .success,
    ).toBe(false);
    expect(
      contentProductionActionSchema.safeParse({
        kind: "confirm_competitors",
        revision: 4,
      }).success,
    ).toBe(true);
    expect(
      contentProductionActionSchema.safeParse({
        kind: "set_title_count",
        revision: 4,
        titleCount: 8,
      }).success,
    ).toBe(false);
    expect(
      contentProductionActionSchema.safeParse({
        kind: "confirm_pack",
        revision: 4,
      }).success,
    ).toBe(false);
    expect(
      contentProductionActionSchema.safeParse({
        kind: "confirm_pattern",
        revision: 4,
        selectedPattern: "P00",
      }).success,
    ).toBe(false);
    expect(
      contentProductionActionSchema.safeParse({
        kind: "confirm_pattern",
        revision: 4,
        selectedPattern: "P06",
      }).success,
    ).toBe(true);
  });
  it("requires explicit requirements and AI recognition without choosing for the user", () => {
    const base = {
      kind: "submit_response_brief",
      revision: 3,
      aiBrandRecognition: "uncertain",
    };
    expect(contentProductionActionSchema.safeParse(base).success).toBe(false);
    expect(
      contentProductionActionSchema.safeParse({
        ...base,
        noExtraRequirements: true,
      }).success,
    ).toBe(true);
    expect(
      contentProductionActionSchema.safeParse({
        ...base,
        requirements: "说明交付范围",
      }).success,
    ).toBe(true);
    expect(
      contentProductionActionSchema.safeParse({
        ...base,
        requirements: "说明交付范围",
        noExtraRequirements: true,
      }).success,
    ).toBe(false);
    expect(
      contentProductionActionSchema.safeParse({
        kind: "submit_response_brief",
        revision: 3,
        noExtraRequirements: true,
      }).success,
    ).toBe(false);
  });
});
