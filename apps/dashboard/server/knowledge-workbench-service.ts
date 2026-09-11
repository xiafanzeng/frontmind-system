import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  conversationTurns,
  knowledgeBaseBuilds,
  knowledgeBaseBuildNodes,
  knowledgeBaseWorkingSets,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import { getDb } from "./db";
import { enterpriseOwnerPredicate } from "./enterprise-project-scope";
import {
  enterpriseResetStateTable,
  enterpriseResetStateOwnerPredicate,
} from "./enterprise-project-state-tables";
import { KnowledgeBaseMaterializedError } from "./knowledge-base-materialized-service";
import { readValidatedActiveKnowledgeBaseWorkingSet } from "./knowledge-base-materialized-assets";
import { isMaterializedBuildPublishable } from "./knowledge-base-materialized-quality";
import {
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import {
  knowledgeWorkbenchRecord,
  knowledgeWorkbenchStart,
  knowledgeWorkbenchStage,
} from "./knowledge-workbench-stage";
import type { KnowledgeBaseWorkingSetManifest } from "./knowledge-base-materialized-contract";

const coordinate = z.coerce.number().int().nonnegative();
export const knowledgeWorkbenchCoordinates = z
  .object({
    conversationId: z.string().trim().min(1).max(128),
    expectedGeneration: coordinate.positive(),
    expectedRevision: coordinate,
    expectedStateEpoch: coordinate,
    expectedContentVersion: coordinate.positive(),
    expectedResetRevision: coordinate,
  })
  .strict();
export const knowledgeInitialAcceptSchema = knowledgeWorkbenchCoordinates
  .extend({ clientRequestId: z.string().trim().min(1).max(128) })
  .strict();
function fail(
  code: ConstructorParameters<typeof KnowledgeBaseMaterializedError>[0],
  message: string,
): never {
  throw new KnowledgeBaseMaterializedError(code, message);
}

export function validateKnowledgeWorkbenchNodes(
  build: KnowledgeBaseBuild,
  nodes: KnowledgeBaseBuildNode[],
  manifest: KnowledgeBaseWorkingSetManifest,
) {
  if (
    manifest.buildId !== build.id ||
    manifest.generation !== build.generation ||
    manifest.contentVersion !== build.contentVersion ||
    !Array.isArray(manifest.leaves) ||
    !manifest.leaves.length ||
    manifest.leaves.length !== nodes.length ||
    nodes.length !== build.totalNodeCount ||
    new Set(manifest.leaves.map((leaf) => leaf.leafId)).size !== nodes.length ||
    new Set(nodes.map((node) => node.leafId)).size !== nodes.length
  )
    fail("INVALID_BUILD_STATE", "知识库整稿不完整，请重新读取后重试");
  for (const node of nodes) {
    const leaf = manifest.leaves.find((item) => item.leafId === node.leafId);
    const body = canonicalKnowledgeBaseMarkdown(node.contentMarkdown ?? "");
    if (
      !leaf ||
      !body.trim() ||
      node.contentVersion !== build.contentVersion ||
      leaf.title !== node.title ||
      leaf.branchId !== node.branchId ||
      knowledgeBaseMarkdownSha256(body) !== node.contentSha256 ||
      leaf.contentSha256 !== node.contentSha256
    )
      fail("INVALID_BUILD_STATE", "知识节点与整稿版本不一致，请重新读取后重试");
  }
  return createHash("sha256")
    .update(
      JSON.stringify(
        nodes
          .map((node) => [node.leafId, node.contentSha256])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ),
    )
    .digest("hex");
}

export async function loadKnowledgeWorkbenchSnapshot(
  tx: any,
  userId: number,
  input: z.infer<typeof knowledgeWorkbenchCoordinates>,
  lock = false,
) {
  const resetQuery = tx
    .select()
    .from(enterpriseResetStateTable())
    .where(enterpriseResetStateOwnerPredicate(userId))
    .limit(1);
  const reset = (await (lock ? resetQuery.for("update") : resetQuery))[0];
  if ((reset?.revision ?? 0) !== input.expectedResetRevision)
    fail("STALE_COORDINATES", "知识库已重置，请重新读取");
  const query = tx
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        enterpriseOwnerPredicate(knowledgeBaseBuilds, userId),
        eq(knowledgeBaseBuilds.conversationId, input.conversationId),
      ),
    )
    .limit(1);
  const build = (await (lock ? query.for("update") : query))[0] as
    | KnowledgeBaseBuild
    | undefined;
  if (!build) fail("BUILD_NOT_FOUND", "知识库构建不存在");
  if (build.generation !== input.expectedGeneration)
    fail("STALE_COORDINATES", "知识库代次已变化，请重新读取");
  const start = await knowledgeWorkbenchStart(tx, build, lock);
  return { build, start };
}

export function assertKnowledgeWorkbenchCoordinates(
  build: KnowledgeBaseBuild,
  input: z.infer<typeof knowledgeWorkbenchCoordinates>,
) {
  if (
    build.revision !== input.expectedRevision ||
    build.stateEpoch !== input.expectedStateEpoch ||
    build.contentVersion !== input.expectedContentVersion
  )
    fail("STALE_COORDINATES", "知识库工作稿已更新，请重新读取");
}

export async function readKnowledgeWorkbenchNodes(
  tx: any,
  build: KnowledgeBaseBuild,
) {
  const nodes = (await tx
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal))) as KnowledgeBaseBuildNode[];
  const workingSet = (
    await tx
      .select()
      .from(knowledgeBaseWorkingSets)
      .where(
        and(
          eq(knowledgeBaseWorkingSets.id, build.activeWorkingSetId ?? ""),
          eq(knowledgeBaseWorkingSets.buildId, build.id),
          eq(knowledgeBaseWorkingSets.generation, build.generation),
          eq(
            knowledgeBaseWorkingSets.contentVersion,
            build.contentVersion ?? 0,
          ),
          eq(knowledgeBaseWorkingSets.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!workingSet) fail("INVALID_BUILD_STATE", "知识库工作稿暂不可用");
  const manifest = workingSet.manifest as KnowledgeBaseWorkingSetManifest;
  const nodesSha256 = validateKnowledgeWorkbenchNodes(build, nodes, manifest);
  return { nodes, workingSet, manifest, nodesSha256 };
}

/** Reset → build → authoritative start turn. The first receipt is immutable. */
export async function acceptKnowledgeBaseInitialDraft(
  userId: number,
  value: unknown,
  executor?: any,
) {
  const input = knowledgeInitialAcceptSchema.parse(value);
  const requestHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const db = executor ?? (await getDb());
  if (!db) fail("DATABASE_UNAVAILABLE", "数据库暂不可用");
  return db.transaction(async (tx: any) => {
    const { build, start } = await loadKnowledgeWorkbenchSnapshot(
      tx,
      userId,
      input,
      true,
    );
    if (!start)
      fail("INVALID_BUILD_STATE", "知识库缺少唯一启动记录，请重新读取或重置");
    const metadata = knowledgeWorkbenchRecord(start.metadata);
    const workbench = knowledgeWorkbenchRecord(metadata.knowledgeWorkbench);
    const prior = knowledgeWorkbenchRecord(workbench.initialAcceptance);
    if (prior.buildId === build.id && prior.generation === build.generation) {
      if (
        prior.clientRequestId === input.clientRequestId &&
        prior.requestHash !== requestHash
      )
        fail("IDEMPOTENCY_CONFLICT", "同一确认请求不可用于不同版本");
      // Even a new request id cannot re-confirm changed nodes in this generation.
      return { accepted: true as const, unchanged: true, receipt: prior };
    }
    if (knowledgeWorkbenchStage(build, start).legacyPublished)
      return { accepted: true as const, unchanged: true, receipt: null };
    assertKnowledgeWorkbenchCoordinates(build, input);
    if (
      build.activeTurnId ||
      build.awaitingResponseSince ||
      !isMaterializedBuildPublishable(build) ||
      !["confirming", "ready_to_publish", "published"].includes(build.status)
    )
      fail("INVALID_BUILD_STATE", "请等待完整初稿生成后再整体确认");
    const { nodes, workingSet, nodesSha256 } =
      await readKnowledgeWorkbenchNodes(tx, build);
    const physical = await readValidatedActiveKnowledgeBaseWorkingSet({
      db: tx,
      build,
    });
    validateKnowledgeWorkbenchNodes(build, nodes, physical.validated.manifest);
    if (
      physical.row.id !== workingSet.id ||
      physical.row.packageSha256 !== workingSet.packageSha256
    )
      fail("INVALID_BUILD_STATE", "整稿文件校验未通过，请重新读取");
    const now = new Date();
    const receipt = {
      schemaVersion: 1,
      clientRequestId: input.clientRequestId,
      requestHash,
      buildId: build.id,
      generation: build.generation,
      revision: build.revision,
      contentVersion: build.contentVersion,
      workingSetId: workingSet.id,
      workingSetSha256: workingSet.packageSha256,
      nodesSha256,
      nodeCount: nodes.length,
      acceptedAt: now.toISOString(),
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: {
          ...metadata,
          knowledgeWorkbench: {
            ...workbench,
            schemaVersion: 1,
            initialAcceptance: receipt,
          },
        },
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, start.id));
    // Accepting the initial draft only unlocks the editing phase. Node states
    // keep driving the per-node walkthrough, so an unfinished build must keep
    // its revision/currentLeafId/presentation coordinates untouched — the
    // presentation guard rejects replies whenever presentation.revision !==
    // build.revision, and stale coordinates would break in-flight confirms.
    const walkthroughSettled = (status: string) =>
      status === "confirmed" || status === "direct_prefilled";
    const walkthroughComplete = nodes.every((node) =>
      walkthroughSettled(node.status),
    );
    if (walkthroughComplete) {
      await tx
        .update(knowledgeBaseBuilds)
        .set({
          status:
            build.status === "published" ? "published" : "ready_to_publish",
          currentLeafId: null,
          currentPresentationKey: null,
          confirmedCount: nodes.filter((node) => node.status === "confirmed")
            .length,
          directPrefilledCount: nodes.filter(
            (node) => node.status === "direct_prefilled",
          ).length,
          needsVerificationCount: 0,
          contentCompletedAt: now,
          revision: build.revision + 1,
          stateEpoch: build.stateEpoch + 1,
          updatedAt: now,
        })
        .where(eq(knowledgeBaseBuilds.id, build.id));
    }
    return { accepted: true as const, unchanged: false, receipt };
  });
}
