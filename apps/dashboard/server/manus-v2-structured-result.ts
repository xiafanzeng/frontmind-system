export type ManusV2StructuredResultEnvelope =
  | { kind: "accepted"; value: unknown }
  | { kind: "rejected"; code: "STRUCTURED_OUTPUT_REJECTED" }
  | { kind: "missing"; code: "STRUCTURED_OUTPUT_MISSING" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Manus documents `success`, `value` and `error` as one result envelope. A
 * failed extraction may still carry a schema-shaped zero value, so `value`
 * alone is never business authority.
 */
export function classifyManusV2StructuredResultEnvelope(
  input: unknown,
): ManusV2StructuredResultEnvelope {
  const result = record(input);
  if (!result) {
    return { kind: "missing", code: "STRUCTURED_OUTPUT_MISSING" };
  }
  const error = result.error;
  const hasNonemptyError =
    error !== undefined &&
    error !== null &&
    (typeof error !== "string" || error.trim().length > 0);
  // A provider-declared extraction rejection is authoritative even when the
  // result omits `value`. SiteOps uses this explicit rejection to unlock its
  // strict, token-bound JSON attachment fallback.
  if (result.success === false || hasNonemptyError) {
    return { kind: "rejected", code: "STRUCTURED_OUTPUT_REJECTED" };
  }
  if (result.value === undefined) {
    return { kind: "missing", code: "STRUCTURED_OUTPUT_MISSING" };
  }
  if (result.success !== true) {
    return { kind: "rejected", code: "STRUCTURED_OUTPUT_REJECTED" };
  }
  return { kind: "accepted", value: result.value };
}
