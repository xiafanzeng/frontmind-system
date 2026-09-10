import {
  projectBusinessExecution,
  type BusinessExecutionPhase,
  type PublicBusinessEvidence,
} from "@shared/frontmind-general-execution";
import type { SiteOpsExecutionStep } from "@shared/siteops-contract";
import type { MonitorRun } from "@/monitoring/domain";
import type { PublicationBatch } from "@/monitoring/features/publishing/types";

const stamp = (value?: string | null) =>
  value ? Date.parse(value) : Number.NaN;
export function siteOpsPublicExecution(steps: readonly SiteOpsExecutionStep[]) {
  const phases: Record<SiteOpsExecutionStep["stage"], BusinessExecutionPhase> =
    {
      visual_searching: "preparing_assets",
      preparing: "reading_requirements",
      design_compiling: "preparing_assets",
      content_building: "generating_pages",
      qa_running: "checking_pages",
      completed: "previewing",
    };
  const statuses = {
    queued: "waiting",
    running: "running",
    succeeded: "ended",
    failed: "error",
    attention_required: "waiting",
    cancelled: "cancelled",
  } as const;
  const turnSequence = new Map<string, number>();
  // These are durable server steps. Never manufacture missing intermediate stages.
  return projectBusinessExecution(
    steps[0]?.buildId ?? "site-operations",
    [...steps]
      .sort(
        (a, b) =>
          stamp(a.startedAt) - stamp(b.startedAt) || a.id.localeCompare(b.id),
      )
      .map((step, rank) => {
        const turnId = step.id.split(":")[0]!;
        if (!turnSequence.has(turnId))
          turnSequence.set(turnId, turnSequence.size);
        return {
          id: step.id,
          turnId,
          userSequence: turnSequence.get(turnId),
          rank,
          timestamp: stamp(step.startedAt),
          phase: step.operationKind === "deploy" ? (step.stage === "qa_running" ? "verifying_site" : step.stage === "completed" ? "publishing_site" : "deploying_site") : step.operationKind === "build_revision" && step.stage === "preparing" ? "revising_site" : phases[step.stage],
          status: statuses[step.status],
          ...(step.completedAt ? { finishedAt: stamp(step.completedAt) } : {}),
        };
      }),
  );
}
export function monitoringPublicExecution(run: MonitorRun) {
  const terminal = [
    "completed",
    "partial_completed",
    "failed",
    "cancelled",
  ].includes(run.status);
  const status =
    run.status === "failed"
      ? "error"
      : run.status === "cancelled"
        ? "cancelled"
        : terminal
          ? "ended"
          : ["waiting_quota", "review_required"].includes(run.status)
            ? "waiting"
            : "running";
  const entries: PublicBusinessEvidence[] = [
    {
      id: `${run.id}:created`,
      turnId: run.id,
      rank: 0,
      timestamp: stamp(run.createdAt),
      phase: "preparing_collection",
      status: run.startedAt
        ? "ended"
        : status === "running"
          ? "waiting"
          : status,
    },
  ];
  if (run.startedAt)
    entries.push({
      id: `${run.id}:started`,
      turnId: run.id,
      rank: 1,
      timestamp: stamp(run.startedAt),
      phase: "collecting",
      status,
      ...(run.completedAt ? { finishedAt: stamp(run.completedAt) } : {}),
    });
  const samples = run.attempts
    .filter((attempt) => attempt.capturedAt)
    .sort((a, b) => stamp(a.capturedAt) - stamp(b.capturedAt));
  if (samples.length)
    entries.push({
      id: `${run.id}:samples`,
      turnId: run.id,
      rank: 2,
      timestamp: stamp(samples.at(-1)!.capturedAt),
      phase: "showing_samples",
      status: "ended",
    });
  if (run.completedAt)
    entries.push({
      id: `${run.id}:finished`,
      turnId: run.id,
      rank: 3,
      timestamp: stamp(run.completedAt),
      phase: "collection_result",
      status,
    });
  for (const [index, attempt] of run.attempts.entries()) {
    const subject = [attempt.platformName, attempt.question].filter(Boolean).join(" · ");
    if (attempt.submittedAt) entries.push({ id: `${run.id}:${attempt.id}:submitted`, turnId: run.id, rank: 1 + index / Math.max(1, run.attempts.length), timestamp: stamp(attempt.submittedAt), phase: "collecting", subject,
      status: ["submission_unknown", "review_required"].includes(attempt.status) ? "waiting" : attempt.status === "failed" ? "error" : attempt.terminalAt ? "ended" : "running" });
    if (attempt.terminalAt || attempt.resultUpdatedAt) entries.push({ id: `${run.id}:${attempt.id}:result:${attempt.revision ?? 0}`, turnId: run.id, rank: 2 + index / Math.max(1, run.attempts.length), timestamp: stamp(attempt.resultUpdatedAt ?? attempt.terminalAt), phase: attempt.answer ? "showing_samples" : "collection_result", subject,
      status: attempt.status === "completed" ? "ended" : attempt.status === "stopped" ? "cancelled" : "error" });
  }
  return projectBusinessExecution(run.id, entries);
}
export function publishingPublicExecution(batch: PublicationBatch) {
  const entries: PublicBusinessEvidence[] = [{ id: `${batch.id}:created`, turnId: batch.id, timestamp: stamp(batch.createdAt), rank: 0, phase: "creating_publication", status: "ended" }];
  for (const [index, item] of batch.items.entries()) {
    const subject = item.media?.name;
    const rank = 1 + index * 100;
    for (const attempt of item.submissionAttempts ?? []) {
      entries.push({ id: `${batch.id}:${item.id}:attempt:${attempt.id}`, turnId: batch.id, timestamp: stamp(attempt.startedAt), rank: rank + attempt.number, phase: "submitting_publication", subject,
        status: attempt.result === "succeeded" ? "ended" : attempt.result === "submission_unknown" ? "waiting" : attempt.result ? "error" : "running",
        ...(attempt.completedAt ? { finishedAt: stamp(attempt.completedAt) } : {}) });
    }
    if (item.submittedAt) entries.push({ id: `${batch.id}:${item.id}:accepted`, turnId: batch.id, timestamp: stamp(item.submittedAt), rank: rank + 90, phase: "accepted_publication", subject, status: "ended" });
    // Unknown outcomes and local failures are current recorded states, never proof of acceptance.
    if (item.updatedAt) entries.push({ id: `${batch.id}:${item.id}:result`, turnId: batch.id, timestamp: stamp(item.completedAt ?? item.updatedAt), rank: rank + 91,
      phase: ["queued", "submitting", "processing", "submission_unknown"].includes(item.status) ? "awaiting_publication" : "showing_publication", subject,
      status: ["failed", "auth_blocked"].includes(item.status) || batch.status === "failed" ? "error" : item.status === "success" ? "ended" : "waiting" });
  }
  return projectBusinessExecution(batch.id, entries);
}

/** Imported batches have durable acceptance/update times; opening the view adds no event. */
export function monitoringImportExecution(
  batches: readonly {
    batchKey: string;
    revision?: number;
    importedAt?: number;
    updatedAt?: number;
    sampleCount?: number;
    citationCount?: number;
  }[],
) {
  const latest = [...batches]
    .filter((batch) => Number.isFinite(batch.importedAt))
    .sort((a, b) => b.importedAt! - a.importedAt!)[0];
  if (!latest) return projectBusinessExecution("monitoring-imports", []);
  const runId = `monitoring-import:${latest.batchKey}`;
  const events: PublicBusinessEvidence[] = [
    {
      id: `${runId}:imported`,
      turnId: runId,
      rank: 0,
      timestamp: latest.importedAt!,
      phase: "importing_samples",
      status: "ended",
    },
  ];
  if (
    Number.isFinite(latest.updatedAt) &&
    (Number(latest.sampleCount) > 0 || Number(latest.citationCount) > 0)
  )
    events.push({
      id: `${runId}:${latest.revision ?? 1}:samples`,
      turnId: runId,
      rank: 1,
      timestamp: latest.updatedAt!,
      phase: "showing_samples",
      status: "ended",
    });
  return projectBusinessExecution(runId, events);
}
