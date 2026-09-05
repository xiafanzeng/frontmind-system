import { and, asc, eq } from "drizzle-orm";
import {
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
} from "../drizzle/schema";
import { getDb } from "./db";
import { classifyKnowledgeBaseUserAction } from "./knowledge-base-progress-service";
import {
  MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES,
  MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES,
  declaredKnowledgeBaseCustomerUploadsForBuild,
  verifiedKnowledgeBaseCustomerUploadBytesForBuild,
  verifiedKnowledgeBaseOfficialLogoUploadForBuild,
} from "./knowledge-base-customer-upload";
import type { KnowledgeBaseClientAttachmentManifestItem } from "./knowledge-base-client-attachment-manifest";
import { KnowledgeBaseTurnReservationError } from "./knowledge-base-turn-service";
import { readKnowledgeBuildArtifact } from "./knowledge-build-artifact-store";
import { buildKnowledgeBaseFinalizationInput } from "./knowledge-base-finalization-input";
import {
  canonicalApprovedKnowledgeBaseLeafMarkdown,
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";

export async function loadKnowledgeBaseBuildRecord(
  userId: number,
  conversationId: string,
) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用");
  return (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.userId, userId),
          eq(knowledgeBaseBuilds.conversationId, conversationId),
        ),
      )
      .limit(1)
  )[0];
}

export async function loadKnowledgeBaseBuildRecordById(
  userId: number,
  buildId: string,
) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用");
  return (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, buildId),
          eq(knowledgeBaseBuilds.userId, userId),
        ),
      )
      .limit(1)
  )[0];
}

export async function assertKnowledgeBaseCustomerUploadCapacity(input: {
  userId: number;
  buildId: string;
  generation: number;
  officialLogoSha256?: string | null;
  officialLogoRequired: boolean;
  attachmentManifest: readonly KnowledgeBaseClientAttachmentManifestItem[];
}) {
  const incomingImages = input.attachmentManifest.flatMap((entry, index) => {
    if (
      !entry.mimeType.startsWith("image/") ||
      (input.officialLogoRequired && index === 0)
    ) {
      return [];
    }
    return [
      {
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
      },
    ];
  });
  if (incomingImages.length === 0) return;

  // One image larger than the aggregate allowance can never fit, even if
  // every other hashless slot later deduplicates. All other digest-free
  // reservations remain undecidable until staging binds the server SHA, so
  // they must not consume virtual capacity and falsely reject a duplicate.
  if (
    incomingImages.some(
      ({ sizeBytes }) => sizeBytes > MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES,
    )
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `单个知识库客户补充图片原始字节合计不得超过 ${Math.floor(MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES / (1024 * 1024))} MiB，请压缩后再上传`,
    );
  }
  const authoritativeIncomingImages = incomingImages.filter(
    (entry): entry is { sha256: string; sizeBytes: number } =>
      typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/u.test(entry.sha256),
  );
  if (authoritativeIncomingImages.length === 0) return;

  const existingCustomerUploads =
    await declaredKnowledgeBaseCustomerUploadsForBuild({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      officialLogoSha256: input.officialLogoSha256,
    });
  const uniqueHashes = new Set(
    existingCustomerUploads.map((entry) => entry.sourceSha256),
  );
  authoritativeIncomingImages.forEach(({ sha256 }) => uniqueHashes.add(sha256));
  if (uniqueHashes.size > MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `单个知识库最多保留 ${MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES} 张不同的客户补充图片`,
    );
  }

  const uniqueSizeByHash = new Map<string, number>();
  for (const upload of existingCustomerUploads) {
    if (upload.sizeBytes.length !== 1) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "已有客户图片账本的原始字节长度不一致，请联系管理员核验",
      );
    }
    uniqueSizeByHash.set(upload.sourceSha256, upload.sizeBytes[0]!);
  }
  for (const incoming of authoritativeIncomingImages) {
    const existingSize = uniqueSizeByHash.get(incoming.sha256);
    if (existingSize !== undefined && existingSize !== incoming.sizeBytes) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "客户图片哈希与字节长度不一致，请重新上传",
      );
    }
    uniqueSizeByHash.set(incoming.sha256, incoming.sizeBytes);
  }
  const aggregateBytes = [...uniqueSizeByHash.values()].reduce(
    (sum, sizeBytes) => sum + sizeBytes,
    0,
  );
  if (aggregateBytes > MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `单个知识库客户补充图片原始字节合计不得超过 ${Math.floor(MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES / (1024 * 1024))} MiB，请压缩后再上传`,
    );
  }
}

export function knowledgeBaseTurnRequiresFinalPackage(input: {
  skillVersion: string;
  currentLeafId: string | null;
  totalNodeCount: number;
  confirmedCount: number;
  directPrefilledCount: number;
  action: ReturnType<typeof classifyKnowledgeBaseUserAction>;
}) {
  return Boolean(
    input.skillVersion === "4" &&
      input.currentLeafId &&
      input.totalNodeCount > 0 &&
      (input.action === "confirm" || input.action === "direct_prefill") &&
      input.confirmedCount + input.directPrefilledCount + 1 ===
        input.totalNodeCount,
  );
}

export async function buildFinalizationInputForTurn(input: {
  userId: number;
  buildId: string;
  generation: number;
  operationId: string;
  turnId: string;
  buildRevision: number;
  transitionTarget: "confirmed" | "direct_prefilled";
}) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用，无法生成最终交付输入");
  const build = await loadKnowledgeBaseBuildRecordById(
    input.userId,
    input.buildId,
  );
  if (
    !build ||
    build.generation !== input.generation ||
    build.skillVersion !== "4" ||
    !build.currentLeafId ||
    !build.logoStorageKey ||
    !build.logoSha256 ||
    !build.logoBytes ||
    !build.logoFilename ||
    !build.logoMimeType ||
    build.activeTurnId !== input.turnId ||
    build.status !== "confirming" ||
    build.revision + 1 !== input.buildRevision
  ) {
    throw new Error("最终交付输入与当前知识库构建不匹配");
  }
  const nodes = await db
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
  if (
    nodes.length !== build.totalNodeCount ||
    nodes.some((node, index) => node.ordinal !== index) ||
    nodes.at(-1)?.leafId !== build.currentLeafId ||
    !["current", "needs_verification"].includes(nodes.at(-1)?.status || "") ||
    nodes
      .slice(0, -1)
      .some(
        (node) =>
          node.status !== "confirmed" && node.status !== "direct_prefilled",
      ) ||
    nodes.filter((node) => node.status === "confirmed").length !==
      build.confirmedCount ||
    nodes.filter((node) => node.status === "direct_prefilled").length !==
      build.directPrefilledCount
  ) {
    throw new Error("最终交付输入的知识树不完整");
  }
  const logoBytes = await readKnowledgeBuildArtifact({
    userId: input.userId,
    buildId: build.id,
    generation: input.generation,
    kind: "logo",
    expectedSha256: build.logoSha256,
    expectedBytes: build.logoBytes,
    storageKey: build.logoStorageKey,
  });
  const [officialLogoUpload, customerUploads] = await Promise.all([
    verifiedKnowledgeBaseOfficialLogoUploadForBuild({
      userId: input.userId,
      buildId: build.id,
      generation: input.generation,
      expectedLogoSha256: build.logoSha256,
    }),
    verifiedKnowledgeBaseCustomerUploadBytesForBuild({
      userId: input.userId,
      buildId: build.id,
      generation: input.generation,
      officialLogoSha256: build.logoSha256,
    }),
  ]);
  return buildKnowledgeBaseFinalizationInput({
    companyName: build.companyName,
    operationId: input.operationId,
    turnId: input.turnId,
    buildRevision: input.buildRevision,
    treePolicyVersion: build.treePolicyVersion,
    nodes: nodes.map((node) => {
      const storedMarkdown = canonicalKnowledgeBaseMarkdown(
        node.contentMarkdown || "",
      );
      const storedSha256 = knowledgeBaseMarkdownSha256(storedMarkdown);
      if (node.contentSha256 && node.contentSha256 !== storedSha256) {
        throw new Error(`知识节点 ${node.leafId} 的权威正文哈希不一致`);
      }
      const contentMarkdown =
        canonicalApprovedKnowledgeBaseLeafMarkdown(storedMarkdown);
      const contentSha256 = knowledgeBaseMarkdownSha256(contentMarkdown);
      return {
        id: node.leafId,
        title: node.title,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
        order: node.ordinal,
        status:
          node.leafId === build.currentLeafId
            ? input.transitionTarget
            : node.status,
        contentMarkdown,
        contentSha256,
        sourceUrls: [...new Set(node.sourceUrls || [])],
        imageUrls: [...new Set(node.imageUrls || [])],
      };
    }),
    assets: [
      {
        kind: "official_logo" as const,
        filename: officialLogoUpload?.filename || build.logoFilename,
        mimeType: officialLogoUpload?.mimeType || build.logoMimeType,
        sha256: build.logoSha256,
        bytes: logoBytes,
        // The Logo is always displayed as the first-node brand badge. A
        // provenance-repair upload may occur at the final leaf, but that
        // administrative ledger must never move the asset's document binding.
        documentIds: [nodes[0]!.leafId],
        sourceFileIds: officialLogoUpload ? [officialLogoUpload.fileId] : [],
        ...(officialLogoUpload
          ? { sourceKind: "official_logo_upload" as const }
          : {}),
        ...(officialLogoUpload
          ? {
              sourceUploadIndex: officialLogoUpload.index,
              sourceUploadFileId: officialLogoUpload.fileId,
              sourceUploadFilename: officialLogoUpload.filename,
              sourceUploadMimeType: officialLogoUpload.mimeType,
              sourceUploadSizeBytes: officialLogoUpload.sizeBytes,
              sourceUploadSha256: officialLogoUpload.sourceSha256,
            }
          : {}),
      },
      ...customerUploads.map((upload) => ({
        kind: "customer_upload" as const,
        filename: upload.filename,
        mimeType: upload.mimeType,
        sha256: upload.sourceSha256,
        bytes: upload.bytes,
        documentIds: upload.leafIds,
        sourceFileIds: upload.fileIds,
        sourceKind: "user_upload",
        sourceUploadFilename: upload.filename,
        sourceUploadMimeType: upload.mimeType,
        sourceUploadSha256: upload.sourceSha256,
      })),
    ],
  });
}

export function shouldBindKnowledgeBaseInitialLogo(
  skillVersion: string,
  descriptorCount: number,
) {
  return descriptorCount > 0 && skillVersion !== "3";
}

export function knowledgeBaseBuildRequiresOfficialLogo(build: {
  providerProtocol?: string | null;
  skillVersion: string;
  status: string;
  revision: number;
  currentLeafId: string | null;
  totalNodeCount: number;
  confirmedCount: number;
  directPrefilledCount: number;
  logoSha256: string | null;
}) {
  return (
    build.providerProtocol !== "manus_v2" &&
    build.skillVersion === "4" &&
    build.status === "confirming" &&
    build.revision === 0 &&
    Boolean(build.currentLeafId) &&
    build.totalNodeCount > 0 &&
    build.confirmedCount === 0 &&
    build.directPrefilledCount === 0 &&
    !build.logoSha256
  );
}

export function knowledgeBaseManifestRepeatsOfficialLogo(
  build: { logoSha256: string | null },
  manifest: readonly KnowledgeBaseClientAttachmentManifestItem[],
) {
  const logoSha256 = String(build.logoSha256 || "")
    .trim()
    .toLowerCase();
  return Boolean(
    logoSha256 &&
      manifest.some(
        (item) => typeof item.sha256 === "string" && item.sha256 === logoSha256,
      ),
  );
}

export function assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
  build: { logoSha256: string | null },
  manifest: readonly KnowledgeBaseClientAttachmentManifestItem[],
) {
  if (knowledgeBaseManifestRepeatsOfficialLogo(build, manifest)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传",
    );
  }
}
