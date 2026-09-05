import { and, desc, eq, gte } from "drizzle-orm";

import {
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  type KnowledgeBaseBuild,
  type KnowledgeBaseSnapshot,
} from "../drizzle/schema";
import {
  KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES,
  KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES,
} from "./knowledge-base-progress";
import { knowledgeBasePublicationBindingHash } from "./knowledge-base-publication-binding";
import { getDb } from "./db";

export function isAuthenticatedAdvancedKnowledgePublication(input: {
  snapshot: Pick<
    KnowledgeBaseSnapshot,
    | "id"
    | "userId"
    | "sourceBuildId"
    | "sourceBuildRevision"
    | "sourceTaskId"
    | "sourceArtifactHash"
    | "archiveHash"
    | "createdAt"
  >;
  build: Pick<
    KnowledgeBaseBuild,
    | "id"
    | "userId"
    | "status"
    | "revision"
    | "currentLeafId"
    | "totalNodeCount"
    | "confirmedCount"
    | "directPrefilledCount"
    | "needsVerificationCount"
    | "upstreamTaskId"
    | "packageRevision"
    | "packageTaskId"
    | "packageDescriptorHash"
    | "packageArchiveSha256"
    | "publishedSnapshotId"
    | "publishedAt"
    | "createdAt"
  >;
  notBefore: Date;
}) {
  const { snapshot, build } = input;
  const handled = build.confirmedCount + build.directPrefilledCount;
  const publicationBindingHash = knowledgeBasePublicationBindingHash(build);
  return (
    snapshot.createdAt.getTime() >= input.notBefore.getTime() &&
    build.createdAt.getTime() >= input.notBefore.getTime() &&
    snapshot.userId === build.userId &&
    snapshot.sourceBuildId === build.id &&
    snapshot.sourceBuildRevision === build.revision &&
    snapshot.sourceBuildRevision === build.packageRevision &&
    snapshot.sourceTaskId === build.upstreamTaskId &&
    snapshot.sourceTaskId === build.packageTaskId &&
    Boolean(snapshot.sourceArtifactHash) &&
    snapshot.sourceArtifactHash === publicationBindingHash &&
    Boolean(snapshot.archiveHash) &&
    (!build.packageArchiveSha256 ||
      snapshot.archiveHash === build.packageArchiveSha256) &&
    build.status === "published" &&
    build.publishedSnapshotId === snapshot.id &&
    Boolean(build.publishedAt) &&
    build.currentLeafId === null &&
    build.totalNodeCount >= KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES &&
    build.totalNodeCount <= KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES &&
    handled === build.totalNodeCount &&
    build.needsVerificationCount === 0
  );
}

export async function getLatestAuthenticatedKnowledgeSnapshot(input: {
  userId: number;
  notBefore: Date;
}) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({
      snapshot: knowledgeBaseSnapshots,
      build: knowledgeBaseBuilds,
    })
    .from(knowledgeBaseSnapshots)
    .innerJoin(
      knowledgeBaseBuilds,
      and(
        eq(knowledgeBaseBuilds.id, knowledgeBaseSnapshots.sourceBuildId),
        eq(knowledgeBaseBuilds.userId, knowledgeBaseSnapshots.userId),
        eq(knowledgeBaseBuilds.publishedSnapshotId, knowledgeBaseSnapshots.id),
      ),
    )
    .where(
      and(
        eq(knowledgeBaseSnapshots.userId, input.userId),
        gte(knowledgeBaseSnapshots.createdAt, input.notBefore),
      ),
    )
    .orderBy(desc(knowledgeBaseSnapshots.version));
  const authenticated = rows.find((row) =>
    isAuthenticatedAdvancedKnowledgePublication({
      snapshot: row.snapshot,
      build: row.build,
      notBefore: input.notBefore,
    }),
  );
  return authenticated?.snapshot ?? null;
}
