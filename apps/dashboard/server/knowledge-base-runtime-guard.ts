export function knowledgeBaseWritesAreEmergencyBlocked() {
  if (
    /^(?:1|true|yes|on)$/iu.test(
      process.env.KNOWLEDGE_BASE_WRITES_DISABLED || "",
    )
  ) {
    return {
      reason: "KNOWLEDGE_BASE_WRITES_DISABLED",
      activatedAt: null,
    };
  }
  return null;
}
