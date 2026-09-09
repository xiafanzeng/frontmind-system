import { and, eq, isNull } from "drizzle-orm";
import {
  publisherArticles,
  publisherArticleVersions,
  publisherDrafts,
  publisherBatches,
  runs,
} from "./schema";

/** Read-only bridge: the caller supplies its transaction and authenticated
 * account projection. Keep column predicates in the owning schema package. */
export async function findWorkbenchPublishingResource(
  executor: any,
  input: {
    ownerId: string;
    enterpriseProjectId: string | null;
    kind:
      | "article"
      | "article_version"
      | "publication_draft"
      | "publication_batch";
    id: string;
  },
) {
  const table = {
    article: publisherArticles,
    article_version: publisherArticleVersions,
    publication_draft: publisherDrafts,
    publication_batch: publisherBatches,
  }[input.kind];
  const [row] = await executor
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.id, input.id),
        eq(table.ownerId, input.ownerId),
        input.enterpriseProjectId
          ? eq(table.enterpriseProjectId, input.enterpriseProjectId)
          : isNull(table.enterpriseProjectId),
      ),
    )
    .limit(1);
  return row as { id: string } | undefined;
}
export async function findWorkbenchMonitoringRun(
  executor: any,
  ownerId: string,
  id: string,
) {
  const [row] = await executor
    .select({ id: runs.id, projectId: runs.projectId })
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.ownerId, ownerId)))
    .limit(1);
  return row as { id: string; projectId: string } | undefined;
}
