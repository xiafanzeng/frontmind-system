export const KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION =
  "kb-v4-authorized-workflow-2026-08-09";

export type KnowledgeBaseOperationTelemetryEvent =
  | "turn_replay_hit"
  | "turn_replay_mismatch"
  | "stale_presentation_submission"
  | "logo_upload_candidate_staged"
  | "logo_upload_candidate_promoted"
  | "logo_upload_candidate_recovered"
  | "logo_upload_candidate_rejected"
  | "initial_logo_accepted"
  | "initial_logo_degraded_to_upload";

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,255}$/u;

function safeIdentifier(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return SAFE_IDENTIFIER.test(normalized) ? normalized : undefined;
}

/**
 * Emit only bounded application state. Customer text, filenames, URLs and
 * provider output are deliberately absent from this API.
 */
export function knowledgeBaseOperationTelemetryRecord(input: {
  event: KnowledgeBaseOperationTelemetryEvent;
  buildId?: string | null;
  turnId?: string | null;
  reasonCode?: string | null;
  adoptedWinner?: boolean;
}) {
  const buildId = safeIdentifier(input.buildId);
  const turnId = safeIdentifier(input.turnId);
  const reasonCode = safeIdentifier(input.reasonCode);
  return {
    event: input.event,
    promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
    ...(buildId ? { buildId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(input.adoptedWinner === true ? { adoptedWinner: true } : {}),
  };
}

export function logKnowledgeBaseOperationTelemetry(
  input: Parameters<typeof knowledgeBaseOperationTelemetryRecord>[0],
) {
  const record = knowledgeBaseOperationTelemetryRecord(input);
  console.info(
    `[KnowledgeBaseOperation] ${record.event}`,
    JSON.stringify(record),
  );
}

export type KnowledgeBaseDispatchPhase =
  | "validate_ledger"
  | "skill"
  | "prefill"
  | "instructions"
  | "freeze"
  | "prepare"
  | "map"
  | "task_create";

const DISPATCH_CREATE_STATES = new Set([
  "not_sent",
  "sending",
  "acknowledged",
  "rejected",
  "unknown",
]);

function safeCount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

/**
 * Strict diagnostic envelope for the pre-provider knowledge-base pipeline.
 * Its input surface deliberately has no filename, content, URL, task id or
 * Provider id field, making accidental secret expansion a type-level error.
 */
export function knowledgeBaseDispatchPhaseTelemetryRecord(input: {
  phase: KnowledgeBaseDispatchPhase;
  traceId?: string | null;
  errorCode?: string | null;
  userCount?: number;
  expectedCount?: number;
  stagedCount?: number;
  generatedReservationCount?: number;
  mappingCount?: number;
  createState?: string | null;
}) {
  const traceId = safeIdentifier(input.traceId);
  const errorCode = safeIdentifier(input.errorCode);
  const userCount = safeCount(input.userCount);
  const expectedCount = safeCount(input.expectedCount);
  const stagedCount = safeCount(input.stagedCount);
  const generatedReservationCount = safeCount(input.generatedReservationCount);
  const mappingCount = safeCount(input.mappingCount);
  const createState = DISPATCH_CREATE_STATES.has(
    String(input.createState || ""),
  )
    ? String(input.createState)
    : undefined;
  return {
    event: "dispatch_phase" as const,
    phase: input.phase,
    ...(traceId ? { traceId } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(userCount !== undefined ? { userCount } : {}),
    ...(expectedCount !== undefined ? { expected: expectedCount } : {}),
    ...(stagedCount !== undefined ? { staged: stagedCount } : {}),
    ...(generatedReservationCount !== undefined
      ? { generatedReservation: generatedReservationCount }
      : {}),
    ...(mappingCount !== undefined ? { mapping: mappingCount } : {}),
    ...(createState ? { createState } : {}),
  };
}

export function logKnowledgeBaseDispatchPhaseTelemetry(
  input: Parameters<typeof knowledgeBaseDispatchPhaseTelemetryRecord>[0],
) {
  const record = knowledgeBaseDispatchPhaseTelemetryRecord(input);
  console.info(
    `[KnowledgeBaseDispatch] ${record.phase}`,
    JSON.stringify(record),
  );
}
