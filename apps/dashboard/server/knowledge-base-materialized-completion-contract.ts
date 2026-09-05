/**
 * Version two is a birth-time capability fence. Only builds and turns created
 * with this exact marker may use the bounded task.stop completion fallback.
 * Historical materialized tasks intentionally have no marker.
 */
export const KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION =
  2 as const;

/**
 * The fixed assistant text closes the Provider task after the validated ZIP
 * is attached. Dashboard consumes only the ZIP; this sentence is only a
 * natural-convergence hint and is never evidence or rendered as knowledge
 * data.
 */
export const KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_SENTENCE =
  "已完成，知识库 ZIP 已附上。" as const;

export const KNOWLEDGE_BASE_MATERIALIZED_CANDIDATE_STABILITY_MS = 30_000;
export const KNOWLEDGE_BASE_MATERIALIZED_NATURAL_STOP_WINDOW_MS = 120_000;
export const KNOWLEDGE_BASE_MATERIALIZED_STOP_SETTLE_WINDOW_MS = 120_000;
export const KNOWLEDGE_BASE_MATERIALIZED_STOP_OUTCOME_UNKNOWN_WINDOW_MS =
  10 * 60_000;
export const KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_POLL_MS = 15_000;
