import { eq } from "drizzle-orm";

import { websiteProjectDeletionTombstones } from "../drizzle/schema";

/**
 * Wave D1 enables physical deletion after the D0 schema expansion and every
 * project writer's lifecycle fence have shipped together.
 */
export const WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED = true as const;

export class WebsiteProjectInactiveError extends Error {
  constructor(public readonly projectId: string) {
    super("The project has been permanently deleted");
    this.name = "WebsiteProjectInactiveError";
  }
}

/**
 * Creates the lifecycle row for legacy projects and locks it in the same
 * transaction as the caller's write. A no-op duplicate update is deliberate:
 * it serializes a first writer racing another first writer without changing a
 * non-active status.
 */
export async function lockActiveWebsiteProjectLifecycle(
  tx: any,
  projectId: string,
) {
  await tx
    .insert(websiteProjectDeletionTombstones)
    .values({ projectId, schemaVersion: 1, status: "active" })
    .onDuplicateKeyUpdate({ set: { projectId } });

  const rows = await tx
    .select({ status: websiteProjectDeletionTombstones.status })
    .from(websiteProjectDeletionTombstones)
    .where(eq(websiteProjectDeletionTombstones.projectId, projectId))
    .limit(1)
    .for("update");

  if (!rows[0] || rows[0].status !== "active") {
    throw new WebsiteProjectInactiveError(projectId);
  }
}

export function assertWebsiteProjectPhysicalDeleteEnabled() {
  if (!WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED) {
    throw new Error("Website project physical deletion is disabled in Wave D0");
  }
}
