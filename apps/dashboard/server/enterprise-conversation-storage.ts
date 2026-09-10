import { getEnterpriseProjectScope } from "./enterprise-project-context";
/** Legacy defaults retain historical storage IDs; new projects get a namespace. */
export function enterpriseConversationStoragePrefix(userId: number, projectAssignmentId: string | null = null) {
  const scope = getEnterpriseProjectScope();
  if (scope) {
    if (scope.ownerUserId !== userId) throw new Error("ENTERPRISE_PROJECT_OWNER_MISMATCH");
    if (!scope.isLegacyDefault) return `e${scope.enterpriseProjectId}:`;
  }
  return projectAssignmentId ? `p${projectAssignmentId}:` : `u${userId}:`;
}

/** One storage identity for every knowledge-base operation; request scope is verified upstream. */
export function knowledgeBaseSessionStorageId(userId: number, publicConversationId: string) {
  const publicId = String(publicConversationId || "").trim();
  if (!Number.isSafeInteger(userId) || userId < 1 || !publicId || publicId.length > 191) throw new Error("INVALID_KNOWLEDGE_BASE_SESSION_ID");
  // KB has always used the project namespace or account namespace, including delivery sessions.
  const id = `${enterpriseConversationStoragePrefix(userId)}${publicId}`;
  if (id.length > 191) throw new Error("INVALID_KNOWLEDGE_BASE_SESSION_ID");
  return id;
}
