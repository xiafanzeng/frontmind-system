import { and, eq } from "drizzle-orm";
import { enterpriseProjectResetStates, enterpriseProjectSiteProfiles, knowledgeBaseResetStates, workspaceSiteProfiles } from "../drizzle/schema";
import { enterpriseProjectIdForOwner, getEnterpriseProjectScope } from "./enterprise-project-scope";

export function enterpriseResetStateTable() {
  return (getEnterpriseProjectScope() ? enterpriseProjectResetStates : knowledgeBaseResetStates) as typeof knowledgeBaseResetStates;
}
export function enterpriseResetStateOwnerPredicate(userId: number) {
  const id = enterpriseProjectIdForOwner(userId);
  return id ? and(eq(enterpriseProjectResetStates.enterpriseProjectId, id), eq(enterpriseProjectResetStates.userId, userId))! : eq(knowledgeBaseResetStates.userId, userId);
}
export function enterpriseSiteProfileTable() {
  return (getEnterpriseProjectScope() ? enterpriseProjectSiteProfiles : workspaceSiteProfiles) as typeof workspaceSiteProfiles;
}
export function enterpriseSiteProfileOwnerPredicate(userId: number) {
  const id = enterpriseProjectIdForOwner(userId);
  return id ? and(eq(enterpriseProjectSiteProfiles.enterpriseProjectId, id), eq(enterpriseProjectSiteProfiles.userId, userId))! : eq(workspaceSiteProfiles.userId, userId);
}
