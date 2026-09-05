let invariantWriteBlock: { reason: string; activatedAt: Date } | null = null;

export function activateKnowledgeBaseInvariantWriteBlock(reason: string) {
  if (!invariantWriteBlock) {
    invariantWriteBlock = {
      reason: String(reason || "knowledge-base invariant failure").slice(0, 500),
      activatedAt: new Date(),
    };
  }
  return invariantWriteBlock;
}

export function knowledgeBaseWritesAreEmergencyBlocked() {
  if (/^(?:1|true|yes|on)$/iu.test(process.env.KNOWLEDGE_BASE_WRITES_DISABLED || "")) {
    return {
      reason: "KNOWLEDGE_BASE_WRITES_DISABLED",
      activatedAt: null,
    };
  }
  return invariantWriteBlock;
}

/** Test/admin recovery hook; production should restart only after P0 repair. */
export function clearKnowledgeBaseInvariantWriteBlock() {
  invariantWriteBlock = null;
}
