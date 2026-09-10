import { describe, expect, it } from "vitest";
import { monitoringImportExecution, monitoringPublicExecution, publishingPublicExecution, siteOpsPublicExecution } from "./business-execution-adapters";
import { projectBusinessExecution } from "@shared/frontmind-general-execution";
import { workbenchPublicExecution } from "@/components/WorkbenchExecutionActivity";
const date = "2026-09-10T01:00:00Z";
describe("real business execution evidence", () => {
  it("has no fabricated activity when no events exist and rejects private labels", () => {
    expect(projectBusinessExecution("run", []).coverage).toBe("unavailable");
    expect(workbenchPublicExecution("run", [{ id: "a", timestamp: 1, status: "completed", label: "reservation private payload" }]).timeline).toEqual([]);
  });
  it("keeps website real steps in turn order and excludes arbitrary diagnostic labels", () => {
    const step = { operationKind: "site_build", buildId: "build", label: "provider request secret", status: "succeeded", completedAt: date } as const;
    const result = siteOpsPublicExecution([
      { ...step, id: "b:completed", stage: "completed", startedAt: "2026-09-10T01:00:03Z" },
      { ...step, id: "a:preparing", stage: "preparing", startedAt: date },
    ]);
    expect(result.timeline.map(entry => entry.id)).toEqual(["a:preparing", "b:completed"]);
    expect(JSON.stringify(result)).not.toMatch(/provider request secret/);
  });
  it("shows a queued monitor as preparation only and adds actual capture evidence later", () => {
    const run = { id: "run", status: "queued", createdAt: date, attempts: [] } as any;
    expect(monitoringPublicExecution(run).timeline.map(entry => entry.phase)).toEqual(["preparing_collection"]);
    expect(monitoringPublicExecution({ ...run, status: "running", startedAt: date, attempts: [{ capturedAt: date }] }).timeline.map(entry => entry.phase)).toEqual(["preparing_collection", "collecting", "showing_samples"]);
  });
  it("exposes actual publication failures but no raw result payload", () => {
    const result = publishingPublicExecution({ id: "batch", createdAt: date, status: "failed", items: [{ updatedAt: date, resultMessage: "secret internal" }] } as any);
    expect(result.timeline.at(-1)).toMatchObject({ phase: "showing_publication", status: "error" });
    expect(JSON.stringify(result)).not.toContain("secret internal");
  });
  it("shows only timestamped imported batch evidence and remains identical on refresh", () => {
    expect(monitoringImportExecution([{ batchKey: "old-with-no-time" }]).timeline).toEqual([]);
    const batches = [{ batchKey: "batch", importedAt: 1000, updatedAt: 2000, revision: 2, sampleCount: 8 }];
    const execution = monitoringImportExecution(batches);
    expect(execution.timeline.map(entry => entry.phase)).toEqual(["importing_samples", "showing_samples"]);
    expect(monitoringImportExecution(batches)).toEqual(execution);
  });
  it("deduplicates repeated events and sorts by owning turn and rank", () => {
    const entry = { id: "one", turnId: "turn", userSequence: 1, rank: 1, timestamp: 1, phase: "staging", status: "ended" } as const;
    const result = projectBusinessExecution("run", [{ ...entry, id: "two", rank: 2 }, entry, entry]);
    expect(result.timeline.map(item => item.id)).toEqual(["one", "two"]);
  });
});

describe("final manual truthful process regressions", () => {
  it("does not turn local batch creation into supplier acceptance", () => {
    const result = publishingPublicExecution({ id: "batch", createdAt: date, status: "queued", items: [] } as any);
    expect(result.timeline.map(entry => entry.phase)).toEqual(["creating_publication"]);
  });
  it("does not invent a sample organization operation at monitoring completion", () => {
    const result = monitoringPublicExecution({ id: "run", createdAt: date, startedAt: date, completedAt: date, status: "completed", attempts: [] } as any);
    expect(result.timeline.map(entry => entry.phase)).not.toContain("organizing_samples");
  });
  it("distinguishes a completed deployment from a generated preview", () => {
    const result = siteOpsPublicExecution([{ id: "deploy:completed", buildId: "build", operationKind: "deploy", stage: "completed", status: "succeeded", startedAt: date, completedAt: date, label: "完成" }]);
    expect(result.timeline[0]?.phase).toBe("publishing_site");
  });
});

it("shows every media item and distinguishes attempted submission from acceptance", () => {
  const result = publishingPublicExecution({ id: "batch", createdAt: date, status: "processing", items: [
    { id: "one", media: { name: "媒体甲" }, updatedAt: date, status: "submission_unknown", submissionAttempts: [{ id: "attempt", number: 1, startedAt: date, result: "submission_unknown" }] },
    { id: "two", media: { name: "媒体乙" }, updatedAt: date, submittedAt: date, status: "processing" },
  ] } as any);
  expect(result.timeline.filter(entry => entry.phase === "accepted_publication")).toHaveLength(1);
  expect(result.timeline.find(entry => entry.phase === "submitting_publication")).toMatchObject({ status: "waiting" });
  expect(result.timeline.filter(entry => entry.phase === "awaiting_publication")).toHaveLength(2);
});
