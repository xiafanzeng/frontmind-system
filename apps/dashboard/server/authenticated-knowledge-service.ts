import { and, desc, eq, gte } from "drizzle-orm";

import {
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  type KnowledgeBaseBuild,
  type KnowledgeBaseSnapshot,
} from "../drizzle/schema";
import {
  knowledgeBaseTreePolicy,
  validateStoredKnowledgeBaseResearchCoverage,
} from "./knowledge-base-progress";
import {
  knowledgeBasePackageWriterTaskId,
  knowledgeBasePublicationBindingHash,
} from "./knowledge-base-publication-binding";
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
    | "status"
    | "createdAt"
  >;
  build: Pick<
    KnowledgeBaseBuild,
    | "id"
    | "userId"
    | "generation"
    | "executionMode"
    | "status"
    | "revision"
    | "currentLeafId"
    | "totalNodeCount"
    | "confirmedCount"
    | "directPrefilledCount"
    | "needsVerificationCount"
    | "upstreamTaskId"
    | "canonicalTaskId"
    | "packageRevision"
    | "packageTaskId"
    | "packageDescriptorHash"
    | "packageArchiveSha256"
    | "publishedSnapshotId"
    | "publishedAt"
    | "createdAt"
    | "treePolicyVersion"
    | "initialResearchCoverage"
  >;
  notBefore: Date;
}) {
  const { snapshot, build } = input;
  const handled = build.confirmedCount + build.directPrefilledCount;
  const depthPolicy = knowledgeBaseTreePolicy(build.treePolicyVersion);
  let researchCoverageValid = depthPolicy.version === 1;
  if (depthPolicy.version === 2) {
    try {
      validateStoredKnowledgeBaseResearchCoverage(
        build.initialResearchCoverage,
        { totalLeafCount: build.totalNodeCount },
      );
      researchCoverageValid = true;
    } catch {
      researchCoverageValid = false;
    }
  }
  const publicationBindingHash = knowledgeBasePublicationBindingHash(build);
  return (
    snapshot.status === "active" &&
    snapshot.createdAt.getTime() >= input.notBefore.getTime() &&
    build.createdAt.getTime() >= input.notBefore.getTime() &&
    snapshot.userId === build.userId &&
    snapshot.sourceBuildId === build.id &&
    snapshot.sourceBuildRevision === build.revision &&
    snapshot.sourceBuildRevision === build.packageRevision &&
    snapshot.sourceTaskId === knowledgeBasePackageWriterTaskId(build) &&
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
    build.totalNodeCount >= depthPolicy.minLeaves &&
    build.totalNodeCount <= depthPolicy.maxLeaves &&
    researchCoverageValid &&
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
        eq(knowledgeBaseSnapshots.status, "active"),
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
