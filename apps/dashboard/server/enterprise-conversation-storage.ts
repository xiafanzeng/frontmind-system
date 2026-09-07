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
