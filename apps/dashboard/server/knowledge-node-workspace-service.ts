import { lockCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { knowledgeWorkbenchEditingAllowed } from "./knowledge-workbench-stage";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseWorkingSets,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import type {
  KnowledgeNodeDetailsDto,
  KnowledgeNodeSearchResult,
  KnowledgeNodeSaveResult,
} from "../shared/knowledge-node-workspace";
import { getDb } from "./db";
import {
  enterpriseOwnerPredicate,
  enterpriseProjectUrl,
} from "./enterprise-project-scope";
import {
  enterpriseResetStateTable,
  enterpriseResetStateOwnerPredicate,
} from "./enterprise-project-state-tables";
import {
  KnowledgeBaseMaterializedError,
  selectMaterializedKnowledgeBaseNode,
} from "./knowledge-base-materialized-service";
import {
  projectKnowledgeBaseCustomerMarkdown,
  type KnowledgeBaseWorkingSetManifest,
} from "./knowledge-base-materialized-contract";
import { knowledgeBaseWorkingSetAssetInternalIdentity } from "./knowledge-base-materialized-assets";
import { knowledgeBasePublicResource } from "./knowledge-base-public-resource";
import { isMaterializedBuildPublishable } from "./knowledge-base-materialized-quality";
import {
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import { knowledgeBaseWritesAreEmergencyBlocked } from "./knowledge-base-runtime-guard";
import {
  knowledgeBaseMaterializedCompletionContractVersion,
  knowledgeBaseMaterializedRecoveryContractVersion,
  KnowledgeBaseTurnReservationError,
  reserveKnowledgeBaseTurnInTransaction,
  type KnowledgeBaseRecoveryClaim,
} from "./knowledge-base-turn-service";
import { KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION } from "./knowledge-base-materialized-completion-contract";
import { knowledgeBaseObservationConversationStorageId } from "./knowledge-base-progress-service";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";
import { dispatchManualKnowledgeNodeEdit } from "./knowledge-node-manual-edit-service";

const id = z.string().trim().min(1).max(128);
const coordinate = z.number().int().nonnegative();
export const knowledgeNodeContentQuerySchema = z
  .object({
    conversationId: id,
    leafId: id,
    expectedGeneration: z.coerce.number().int().positive(),
    expectedContentVersion: z.coerce.number().int().positive(),
  })
  .strict();
export const knowledgeNodeSearchSchema = z
  .object({
    conversationId: id,
    query: z.string().trim().min(1).max(200),
    expectedGeneration: z.coerce.number().int().positive(),
    expectedContentVersion: z.coerce.number().int().positive(),
    expectedResetRevision: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export const knowledgeNodeSaveSchema = z
  .object({
    conversationId: id,
    leafId: id,
    clientRequestId: id,
    expectedGeneration: coordinate.positive(),
    expectedRevision: coordinate,
    expectedStateEpoch: coordinate,
    expectedContentVersion: coordinate.positive(),
    expectedResetRevision: coordinate,
    contentMarkdown: z
      .string()
      .min(1)
      .max(300_000)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

function fail(
  code: KnowledgeBaseMaterializedError["code"],
  message: string,
): never {
  throw new KnowledgeBaseMaterializedError(code, message);
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
async function requireDb() {
  const db = await getDb();
  if (!db) fail("DATABASE_UNAVAILABLE", "数据库暂不可用，请稍后重试");
  return db;
}

function assertCurrentBuild(build: KnowledgeBaseBuild) {
  if (
    build.executionMode !== "materialized_bundle_v1" ||
    build.providerProtocol !== "manus_v2" ||
    build.skillVersion !== "5" ||
    build.skillContentHash !==
      KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
    knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
    knowledgeBaseMaterializedCompletionContractVersion(build) !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
  )
    fail("RESET_REQUIRED", "旧知识库请重置后重新上传资料并创建全新任务");
}

async function ownedBuild(
  tx: any,
  userId: number,
  conversationId: string,
  lock = false,
) {
  const query = tx
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        enterpriseOwnerPredicate(knowledgeBaseBuilds, userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
      ),
    )
    .limit(1);
  const build = (await (lock ? query.for("update") : query))[0] as
    | KnowledgeBaseBuild
    | undefined;
  if (!build) fail("BUILD_NOT_FOUND", "知识库构建不存在");
  assertCurrentBuild(build);
  return build;
}

/** This reads the durable projection only. Actual image bytes remain behind
 * the existing authenticated endpoint, which validates the archived bytes. */
async function materializedNode(
  tx: any,
  build: KnowledgeBaseBuild,
  leafId: string,
) {
  const node = (
    await tx
      .select()
      .from(knowledgeBaseBuildNodes)
      .where(
        and(
          eq(knowledgeBaseBuildNodes.buildId, build.id),
          eq(knowledgeBaseBuildNodes.leafId, leafId),
        ),
      )
      .limit(1)
  )[0] as KnowledgeBaseBuildNode | undefined;
  if (!node) fail("BUILD_NOT_FOUND", "知识节点不存在");
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
  const manifest = workingSet?.manifest as
    | KnowledgeBaseWorkingSetManifest
    | undefined;
  const leaf = manifest?.leaves?.find((item) => item.leafId === leafId);
  const contentMarkdown = canonicalKnowledgeBaseMarkdown(
    node.contentMarkdown ?? "",
  );
  if (
    !workingSet ||
    !manifest ||
    !leaf ||
    !Array.isArray(manifest.assets) ||
    manifest.buildId !== build.id ||
    manifest.generation !== build.generation ||
    manifest.contentVersion !== build.contentVersion ||
    node.contentVersion !== build.contentVersion ||
    leaf.title !== node.title ||
    leaf.branchId !== node.branchId ||
    !contentMarkdown ||
    knowledgeBaseMarkdownSha256(contentMarkdown) !== node.contentSha256 ||
    leaf.contentSha256 !== node.contentSha256
  )
    fail(
      "INVALID_BUILD_STATE",
      "当前节点的内容版本暂不可读，请重新读取或重置知识库",
    );
  return { node, workingSet, manifest, leaf, contentMarkdown };
}

export function knowledgeNodeEditCapability(build: KnowledgeBaseBuild, editingAllowed = true) {
  const reason = !editingAllowed ? "请先整体确认知识库初稿，再修改节点" : knowledgeBaseWritesAreEmergencyBlocked()
    ? "知识库写入已临时关闭，请稍后重试"
    : build.activeTurnId || build.awaitingResponseSince
      ? "请等待当前操作完成后再编辑"
      : !isMaterializedBuildPublishable(build)
        ? "当前内容不完整，仅可预览；请重置后重新上传资料"
        : !["confirming", "ready_to_publish", "published"].includes(
              build.status,
            )
          ? "当前任务不可编辑，请重新读取或重置知识库"
          : null;
  return { allowed: reason === null, reason };
}

export async function getKnowledgeNodeDetails(
  userId: number,
  value: unknown,
): Promise<KnowledgeNodeDetailsDto> {
  const input = knowledgeNodeContentQuerySchema.parse(value);
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    const build = await ownedBuild(tx, userId, input.conversationId);
    if (
      build.generation !== input.expectedGeneration ||
      build.contentVersion !== input.expectedContentVersion
    )
      fail("STALE_COORDINATES", "知识库内容已更新，请重新读取当前节点");
    const { node, manifest, leaf, contentMarkdown } = await materializedNode(
      tx,
      build,
      input.leafId,
    );
    const state = (
      await tx
        .select({ revision: enterpriseResetStateTable().revision })
        .from(enterpriseResetStateTable())
        .where(enterpriseResetStateOwnerPredicate(userId))
        .limit(1)
    )[0];
    const resources = leaf.assetIds.map((assetId) => {
      const asset = manifest.assets.find(
        (candidate) => candidate.assetId === assetId,
      );
      if (
        !asset ||
        !asset.documentIds.includes(leaf.leafId) ||
        !/^[a-f0-9]{64}$/u.test(asset.sha256)
      )
        fail("INVALID_BUILD_STATE", "当前节点的图片关联暂不可读");
      const resource = knowledgeBasePublicResource({
        buildId: build.id,
        kind: "working_set_asset",
        internalIdentity: knowledgeBaseWorkingSetAssetInternalIdentity({
          leafId: leaf.leafId,
          asset,
        }),
        contentSha256: asset.sha256,
        mimeType: asset.mimeType,
        sizeBytes: asset.bytes,
        caption: asset.caption,
      });
      return {
        ...resource,
        sameOriginUrl: enterpriseProjectUrl(resource.sameOriginUrl),
      };
    });
    const capability = knowledgeNodeEditCapability(build, await knowledgeWorkbenchEditingAllowed(tx, build));
    return {
      coordinates: {
        buildId: build.id,
        conversationId: build.conversationId,
        leafId: node.leafId,
        generation: build.generation,
        revision: build.revision,
        stateEpoch: build.stateEpoch,
        contentVersion: build.contentVersion!,
        resetRevision: state?.revision ?? 0,
      },
      node: {
        leafId: node.leafId,
        title: node.title,
        status: node.status,
        contentMarkdown,
      },
      resources,
      capabilities: {
        directEdit: capability,
        aiEdit: { ...capability },
        manageImages: { ...capability },
      },
    };
  });
}

function knowledgeNodeSearchSnippet(content: string, query: string) {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const index = normalized.toLocaleLowerCase().indexOf(query);
  if (index < 0) return normalized.slice(0, 180);
  const start = Math.max(0, index - 72);
  const end = Math.min(normalized.length, index + query.length + 108);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

/** Search the current, owner-scoped working set without exposing stale nodes. */
export async function searchKnowledgeNodes(
  userId: number,
  value: unknown,
): Promise<KnowledgeNodeSearchResult> {
  const input = knowledgeNodeSearchSchema.parse(value);
  const db = await requireDb();
  return db.transaction(async (tx: any) => {
    const build = await ownedBuild(tx, userId, input.conversationId);
    if (
      build.generation !== input.expectedGeneration ||
      build.contentVersion !== input.expectedContentVersion
    )
      fail("STALE_COORDINATES", "知识库内容已更新，请重新搜索当前内容");
    const state = (
      await tx
        .select({ revision: enterpriseResetStateTable().revision })
        .from(enterpriseResetStateTable())
        .where(enterpriseResetStateOwnerPredicate(userId))
        .limit(1)
    )[0];
    const resetRevision = state?.revision ?? 0;
    if (
      input.expectedResetRevision !== undefined &&
      resetRevision !== input.expectedResetRevision
    )
      fail("STALE_COORDINATES", "知识库已重置，请重新搜索当前内容");
    const workingSet = (
      await tx
        .select()
        .from(knowledgeBaseWorkingSets)
        .where(
          and(
            eq(knowledgeBaseWorkingSets.id, build.activeWorkingSetId ?? ""),
            eq(knowledgeBaseWorkingSets.buildId, build.id),
            eq(knowledgeBaseWorkingSets.generation, build.generation),
            eq(knowledgeBaseWorkingSets.contentVersion, build.contentVersion ?? 0),
            eq(knowledgeBaseWorkingSets.status, "active"),
          ),
        )
        .limit(1)
    )[0] as { manifest?: KnowledgeBaseWorkingSetManifest } | undefined;
    const manifest = workingSet?.manifest;
    if (!manifest || manifest.buildId !== build.id)
      fail("INVALID_BUILD_STATE", "当前知识库内容暂不可搜索，请重新读取");
    const leavesById = new Map(manifest.leaves.map((leaf) => [leaf.leafId, leaf]));
    const nodes = (await tx
      .select()
      .from(knowledgeBaseBuildNodes)
      .where(eq(knowledgeBaseBuildNodes.buildId, build.id))) as KnowledgeBaseBuildNode[];
    const normalizedQuery = input.query.toLocaleLowerCase();
    const matches = nodes.flatMap((node) => {
      const leaf = leavesById.get(node.leafId);
      const content = node.contentMarkdown
        ? canonicalKnowledgeBaseMarkdown(node.contentMarkdown)
        : "";
      if (
        !leaf ||
        node.contentVersion !== build.contentVersion ||
        !content ||
        !node.contentSha256 ||
        knowledgeBaseMarkdownSha256(content) !== node.contentSha256 ||
        leaf.contentSha256 !== node.contentSha256
      )
        return [];
      const titleMatched = node.title.toLocaleLowerCase().includes(normalizedQuery);
      const contentMatched = content.toLocaleLowerCase().includes(normalizedQuery);
      if (!titleMatched && !contentMatched) return [];
      return [{
        leafId: node.leafId,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
        title: node.title,
        status: node.status,
        snippet: knowledgeNodeSearchSnippet(
          contentMatched ? content : node.title,
          normalizedQuery,
        ),
        matchFields: [
          ...(titleMatched ? ["title" as const] : []),
          ...(contentMatched ? ["content" as const] : []),
        ],
      }];
    });
    matches.sort((left, right) => left.title.localeCompare(right.title, "zh-Hans"));
    return {
      coordinates: {
        buildId: build.id,
        conversationId: build.conversationId,
        generation: build.generation,
        contentVersion: build.contentVersion!,
        resetRevision,
      },
      matches,
    };
  });
}

export async function saveKnowledgeNodeContent(
  userId: number,
  value: unknown,
): Promise<Omit<KnowledgeNodeSaveResult, "observation">> {
  const input = knowledgeNodeSaveSchema.parse(value);
  const inputHash = hash(JSON.stringify(input));
  const db = await requireDb();
  const result = await db.transaction(async (tx: any) => {
    await lockCustomerProjectBusinessWrite(tx, userId);
    // Reset -> build -> turn matches reset/start ownership. Selection and
    // reservation commit together; no separate browser select can race here.
    const state = (
      await tx
        .select({ revision: enterpriseResetStateTable().revision })
        .from(enterpriseResetStateTable())
        .where(enterpriseResetStateOwnerPredicate(userId))
        .limit(1)
        .for("update")
    )[0];
    if (!state || state.revision !== input.expectedResetRevision)
      fail("STALE_COORDINATES", "知识库已重置，请重新读取后编辑");
    const build = await ownedBuild(tx, userId, input.conversationId, true);
    const storedConversationId = knowledgeBaseObservationConversationStorageId(
      userId,
      input.conversationId,
    );
    const previous = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            enterpriseOwnerPredicate(conversationTurns, userId),
            eq(conversationTurns.conversationId, storedConversationId),
            eq(conversationTurns.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (previous) {
      const recovery = record(record(previous.metadata).recovery);
      if (
        recovery.nodeEditMode !== "manual_v1" ||
        recovery.manualInputHash !== inputHash ||
        previous.buildId !== build.id ||
        previous.buildGeneration !== input.expectedGeneration
      )
        fail("IDEMPOTENCY_CONFLICT", "本次保存标识已用于其他内容，请重新提交");
      if (previous.status === "failed" || previous.status === "cancelled")
        fail(
          "INVALID_BUILD_STATE",
          "本次保存未成功，原文已保留；请重新读取后再次提交",
        );
      if (previous.status !== "completed")
        throw new KnowledgeBaseTurnReservationError(
          "IDEMPOTENCY_PENDING",
          "本次保存仍在处理中，请稍后重新读取",
          1_000,
        );
      return { unchanged: recovery.unchanged === true, claim: null };
    }
    if (
      build.generation !== input.expectedGeneration ||
      build.revision !== input.expectedRevision ||
      build.stateEpoch !== input.expectedStateEpoch ||
      build.contentVersion !== input.expectedContentVersion
    )
      fail(
        "STALE_COORDINATES",
        "节点已被更新，当前修改尚未保存；请重新读取最新内容",
      );
    const capability = knowledgeNodeEditCapability(build, await knowledgeWorkbenchEditingAllowed(tx, build));
    if (!capability.allowed) fail("INVALID_BUILD_STATE", capability.reason!);
    const current = await materializedNode(tx, build, input.leafId);
    const contentMarkdown = projectKnowledgeBaseCustomerMarkdown({
      leafTitle: current.node.title,
      markdown: input.contentMarkdown,
    });
    if (contentMarkdown.length > 300_000)
      fail("INVALID_BUILD_STATE", "节点正文超过允许长度");
    const recoveryMetadata = {
      kind: "turn",
      nodeEditMode: "manual_v1",
      conversationId: input.conversationId,
      manualInputHash: inputHash,
      contentMarkdown,
      contentSha256: hash(contentMarkdown),
      baseContentVersion: build.contentVersion,
      baseWorkingSetId: current.workingSet.id,
      sourceResetRevision: input.expectedResetRevision,
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
      attachments: [],
    };
    if (contentMarkdown === current.contentMarkdown) {
      const now = new Date();
      await tx.insert(conversationTurns).values({
        id: randomUUID(),
        userId,
        conversationId: storedConversationId,
        apiCredentialId: null,
        clientRequestId: input.clientRequestId,
        buildId: build.id,
        buildGeneration: build.generation,
        operationKey: `manual-unchanged:${hash(`${build.id}:${input.clientRequestId}`)}`,
        operationType: "revise",
        expectedRevision: build.revision,
        expectedLeafId: input.leafId,
        requestHash: inputHash,
        attachmentFileIds: [],
        metadata: {
          execution: "local",
          providerRequestCount: 0,
          recovery: { ...recoveryMetadata, unchanged: true },
        },
        status: "completed",
        startedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { unchanged: true, claim: null };
    }
    await selectMaterializedKnowledgeBaseNode(
      {
        userId,
        conversationId: input.conversationId,
        clientRequestId: `manual-select:${hash(`${build.id}:${input.clientRequestId}`)}`,
        leafId: input.leafId,
        expectedGeneration: build.generation,
        expectedRevision: build.revision,
        expectedStateEpoch: build.stateEpoch,
      },
      tx,
    );
    const selected = await ownedBuild(tx, userId, input.conversationId, true);
    const reservation = await reserveKnowledgeBaseTurnInTransaction(
      {
        userId,
        buildId: selected.id,
        clientRequestId: input.clientRequestId,
        operationType: "revise",
        expectedGeneration: selected.generation,
        expectedRevision: selected.revision,
        expectedLeafId: input.leafId,
        expectedPresentationKey: selected.currentPresentationKey ?? undefined,
        requestPayload: input,
        clientIntent: { nodeEditMode: "manual_v1", ...input },
        apiCredentialId: null,
        userText: "直接编辑节点正文",
        userAttachmentCount: 0,
        expectedAttachmentCount: 0,
        attachmentFileIds: [],
        sourceResetRevision: input.expectedResetRevision,
        recoveryMetadata,
      },
      tx,
    );
    if (reservation.state !== "acquired")
      fail("IDEMPOTENCY_CONFLICT", "当前保存尚未结束，请稍后重新读取");
    return {
      unchanged: false,
      claim: {
        ...reservation,
        recoveryMetadata,
        preparedDispatch: null,
      } satisfies KnowledgeBaseRecoveryClaim,
    };
  });
  if (result.claim) await dispatchManualKnowledgeNodeEdit(result.claim);
  return { accepted: true, unchanged: result.unchanged };
}
