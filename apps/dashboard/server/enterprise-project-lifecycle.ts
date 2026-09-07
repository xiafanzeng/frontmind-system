import { and, eq } from "drizzle-orm";
import { enterpriseProjects } from "../drizzle/schema";
import { AuthServiceError } from "./auth-service";

/** New work and deletion serialize on this row. Never use this for settlement. */
export async function assertEnterpriseProjectActive(
  tx: any,
  enterpriseProjectId: string | null | undefined,
  ownerUserId: number,
) {
  if (!enterpriseProjectId) return;
  const [project] = await tx.select({ id: enterpriseProjects.id, archivedAt: enterpriseProjects.archivedAt }).from(enterpriseProjects)
    .where(and(eq(enterpriseProjects.id, enterpriseProjectId), eq(enterpriseProjects.ownerUserId, ownerUserId)))
    .limit(1).for("update");
  if (!project || project.archivedAt)
    throw new AuthServiceError("NOT_FOUND", "企业项目不存在或已删除");
}
