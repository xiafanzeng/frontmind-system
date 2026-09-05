import { createHash } from "node:crypto";

import type { KnowledgeAsset, KnowledgeDocument } from "../shared/dashboard";

export type KnowledgeBasePackageNode = {
  leafId: string;
  title: string;
  branchId: string;
  branchTitle: string;
  ordinal: number;
  status: string;
  contentMarkdown: string | null;
  contentSha256?: string | null;
};

export type KnowledgeBaseExpectedOfficialLogoUpload = {
  sourceSha256: string;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export class KnowledgeBasePackageBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBasePackageBindingError";
  }
}

/**
 * Knowledge-node Markdown is stored and packaged by two independent systems.
 * Keep their byte identity stable without treating line-ending or trailing
 * whitespace differences as customer-visible content changes.
 */
export function canonicalKnowledgeBaseMarkdown(value: string) {
  return String(value || "")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/u, ""))
    .join("\n")
    .trim();
}

export function knowledgeBaseMarkdownSha256(value: string) {
  return createHash("sha256")
    .update(canonicalKnowledgeBaseMarkdown(value), "utf8")
    .digest("hex");
}

function normalizedIdentity(value: string | undefined) {
  return String(value || "")
    .normalize("NFKC")
    .trim();
}

function packageLeafDocuments(documents: readonly KnowledgeDocument[]) {
  return documents.filter((document) => document.kind === "leaf");
}

function physicalAssetsByHash(assets: readonly KnowledgeAsset[]) {
  const byHash = new Map<string, KnowledgeAsset>();
  for (const asset of assets) {
    const hash = normalizedIdentity(asset.sha256).toLowerCase();
    if (/^[a-f0-9]{64}$/u.test(hash) && !byHash.has(hash)) {
      byHash.set(hash, asset);
    }
  }
  return byHash;
}

/**
 * Older v3 packages could contain many visuals. Only a uniquely identified
 * primary brand badge may be promoted into the v4 Dashboard Logo slot.
 */
export function selectLegacyKnowledgeBaseLogoAsset(input: {
  assets: readonly KnowledgeAsset[];
  expectedLogoSha256?: string | null;
}) {
  const physicalAssets = physicalAssetsByHash(input.assets);
  const expected = normalizedIdentity(
    input.expectedLogoSha256 || undefined,
  ).toLowerCase();
  if (expected) {
    const matched = physicalAssets.get(expected);
    if (!matched) {
      throw new KnowledgeBasePackageBindingError(
        "历史最终 ZIP 未包含此前绑定的官方主 Logo",
      );
    }
    return matched;
  }

  const tiers = [
    [...physicalAssets.values()].filter(
      (asset) =>
        asset.assetType === "brand_identity" && asset.displayRole === "badge",
    ),
    [...physicalAssets.values()].filter(
      (asset) => asset.assetType === "brand_identity",
    ),
  ];
  for (const candidates of tiers) {
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      throw new KnowledgeBasePackageBindingError(
        "历史最终 ZIP 包含多个不同的品牌 Logo，无法安全选择官方主 Logo",
      );
    }
  }
  throw new KnowledgeBasePackageBindingError(
    "历史最终 ZIP 未唯一标记官方主 Logo，不能自动重新绑定",
  );
}

/**
 * Enterprise archives may wrap the customer-approved leaf in an outer report
 * shell with an internal evidence appendix. Only the single formal block is
 * the leaf document. Builder v4 is required to copy the approved Markdown into
 * that block byte-for-byte modulo canonical whitespace.
 */
export function canonicalPackagedKnowledgeBaseLeafMarkdown(value: string) {
  const content = String(value || "");
  const startMarker = "<!-- FRONTMIND_FORMAL_CONTENT_START -->";
  const endMarker = "<!-- FRONTMIND_FORMAL_CONTENT_END -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (
    start >= 0 &&
    end > start &&
    content.indexOf(startMarker, start + startMarker.length) < 0 &&
    content.indexOf(endMarker, end + endMarker.length) < 0
  ) {
    return canonicalKnowledgeBaseMarkdown(
      content.slice(start + startMarker.length, end),
    );
  }
  return canonicalKnowledgeBaseMarkdown(content);
}

/**
 * Initial v4 presentations from some providers already contain the package's
 * formal-content markers. Treat the single marked body as the approved leaf;
 * later presentations, which normally have no markers, remain byte-bound as
 * the complete projected Markdown. This prevents an impossible nested-marker
 * requirement while retaining the durable hash check for the stored value.
 */
export function canonicalApprovedKnowledgeBaseLeafMarkdown(value: string) {
  return canonicalPackagedKnowledgeBaseLeafMarkdown(value);
}

/**
 * Bind a validated enterprise archive to the exact build that the customer
 * confirmed. Package self-consistency is not enough: a model could otherwise
 * replace one leaf with another while keeping counts and manifest hashes valid.
 */
export function assertKnowledgeBasePackageMatchesBuild(input: {
  nodes: readonly KnowledgeBasePackageNode[];
  documents: readonly KnowledgeDocument[];
  assets: readonly KnowledgeAsset[];
  expectedLogoSha256: string;
  packageSchemaVersion?: 1 | 2 | 3 | 4;
  expectedCustomerUploads?: readonly {
    sourceSha256: string;
    leafIds: readonly string[];
    filenames: readonly string[];
    mimeTypes: readonly string[];
  }[];
  expectedOfficialLogoUpload?: KnowledgeBaseExpectedOfficialLogoUpload;
  requireExactContent?: boolean;
  /**
   * Builder v3 used sparse document orders (10, 20, ...) and could package
   * additional first-party visuals. Keep the semantic order and the exact
   * approved Logo/content binding without pretending those archives were v4.
   */
  legacyV3Compatibility?: boolean;
}) {
  const handledNodes = input.nodes
    .filter(
      (node) =>
        node.status === "confirmed" || node.status === "direct_prefilled",
    )
    .sort((left, right) => left.ordinal - right.ordinal);
  if (handledNodes.length !== input.nodes.length || handledNodes.length === 0) {
    throw new KnowledgeBasePackageBindingError(
      "知识库仍有未确认节点，不能绑定最终 ZIP",
    );
  }

  const leafDocuments = packageLeafDocuments(input.documents);
  if (leafDocuments.length !== handledNodes.length) {
    throw new KnowledgeBasePackageBindingError(
      `最终 ZIP 叶子数量与已确认节点不一致：期望 ${handledNodes.length}，实际 ${leafDocuments.length}`,
    );
  }

  const documentsById = new Map<string, KnowledgeDocument>();
  for (const document of leafDocuments) {
    const id = normalizedIdentity(document.id);
    if (!id || documentsById.has(id)) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 包含空白或重复的叶子标识：${id || "<empty>"}`,
      );
    }
    documentsById.set(id, document);
  }

  const documentIdByLeafId = new Map<string, string>();
  const leafIdByDocumentId = new Map<string, string>();
  for (const node of handledNodes) {
    const leafId = normalizedIdentity(node.leafId);
    const acceptedDocumentIds =
      input.packageSchemaVersion === 4 ? [leafId, `leaf-${leafId}`] : [leafId];
    const matches = acceptedDocumentIds.filter((id) => documentsById.has(id));
    if (matches.length === 0) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 缺少已确认节点：${node.leafId}`,
      );
    }
    if (matches.length !== 1 || leafIdByDocumentId.has(matches[0]!)) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点标识无法与已确认版本唯一对应：${node.leafId}`,
      );
    }
    documentIdByLeafId.set(node.leafId, matches[0]!);
    leafIdByDocumentId.set(matches[0]!, node.leafId);
  }

  if (input.legacyV3Compatibility) {
    const orderedDocuments = [...leafDocuments].sort((left, right) => {
      const leftOrder = left.order;
      const rightOrder = right.order;
      if (!Number.isInteger(leftOrder) || !Number.isInteger(rightOrder)) {
        return 0;
      }
      return leftOrder! - rightOrder!;
    });
    const orders = orderedDocuments.map((document) => document.order);
    if (
      orders.some((order) => !Number.isInteger(order) || order! < 0) ||
      new Set(orders).size !== orders.length ||
      orderedDocuments.some(
        (document, index) =>
          normalizedIdentity(document.id) !== handledNodes[index]?.leafId,
      )
    ) {
      throw new KnowledgeBasePackageBindingError(
        "历史最终 ZIP 节点顺序与已确认版本不一致",
      );
    }
  }

  for (const node of handledNodes) {
    const documentId = documentIdByLeafId.get(node.leafId);
    const document = documentId ? documentsById.get(documentId) : undefined;
    if (!document) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 缺少已确认节点：${node.leafId}`,
      );
    }
    if (normalizedIdentity(document.title) !== normalizedIdentity(node.title)) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点标题与已确认版本不一致：${node.leafId}`,
      );
    }
    if (
      normalizedIdentity(document.branchId) !==
        normalizedIdentity(node.branchId) ||
      normalizedIdentity(document.branchTitle) !==
        normalizedIdentity(node.branchTitle)
    ) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点分支与已确认版本不一致：${node.leafId}`,
      );
    }
    if (!input.legacyV3Compatibility && document.order !== node.ordinal) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点顺序与已确认版本不一致：${node.leafId}`,
      );
    }

    const packagedContent = canonicalPackagedKnowledgeBaseLeafMarkdown(
      document.content,
    );
    const storedContent = canonicalKnowledgeBaseMarkdown(
      node.contentMarkdown || "",
    );
    const acceptedContent =
      canonicalApprovedKnowledgeBaseLeafMarkdown(storedContent);
    if (!packagedContent || !acceptedContent) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 或已确认节点正文为空：${node.leafId}`,
      );
    }
    const storedHash = knowledgeBaseMarkdownSha256(storedContent);
    if (node.contentSha256 && node.contentSha256 !== storedHash) {
      throw new KnowledgeBasePackageBindingError(
        `数据库节点正文哈希无效：${node.leafId}`,
      );
    }
    const acceptedHash = knowledgeBaseMarkdownSha256(acceptedContent);
    if (
      input.requireExactContent !== false &&
      knowledgeBaseMarkdownSha256(packagedContent) !== acceptedHash
    ) {
      throw new KnowledgeBasePackageBindingError(
        `最终 ZIP 节点正文与客户已确认版本不一致：${node.leafId}`,
      );
    }
  }

  const expectedLogoSha256 = normalizedIdentity(
    input.expectedLogoSha256,
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedLogoSha256)) {
    throw new KnowledgeBasePackageBindingError(
      "首轮官方主 Logo 尚未完成字节级绑定",
    );
  }
  const isCustomerUploadContract = input.packageSchemaVersion === 4;
  const officialAssets = isCustomerUploadContract
    ? input.assets.filter((asset) => asset.sourceKind !== "user_upload")
    : input.assets;
  const customerAssets = isCustomerUploadContract
    ? input.assets.filter((asset) => asset.sourceKind === "user_upload")
    : [];
  const officialHashes = Array.from(
    new Set(
      officialAssets
        .map((asset) => normalizedIdentity(asset.sha256).toLowerCase())
        .filter((hash) => /^[a-f0-9]{64}$/u.test(hash)),
    ),
  );
  const logoMatches = officialHashes.filter(
    (hash) => hash === expectedLogoSha256,
  );
  if (
    (input.legacyV3Compatibility && logoMatches.length !== 1) ||
    (!input.legacyV3Compatibility &&
      (officialAssets.length !== 1 ||
        officialHashes.length !== 1 ||
        officialHashes[0] !== expectedLogoSha256))
  ) {
    throw new KnowledgeBasePackageBindingError(
      input.legacyV3Compatibility
        ? "历史最终 ZIP 未包含首轮已绑定的唯一官方主 Logo"
        : "最终 ZIP 必须只包含首轮已绑定的同一张官方主 Logo",
    );
  }

  const officialLogoUploadAssets = officialAssets.filter(
    (asset) => asset.sourceKind === "official_logo_upload",
  );
  const expectedOfficialLogoUpload = input.expectedOfficialLogoUpload;
  if (expectedOfficialLogoUpload) {
    if (!isCustomerUploadContract) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传的官方主 Logo 必须使用 Dashboard v4 最终 ZIP 合同",
      );
    }
    const expectedSourceSha256 = normalizedIdentity(
      expectedOfficialLogoUpload.sourceSha256,
    ).toLowerCase();
    const expectedFileId = normalizedIdentity(
      expectedOfficialLogoUpload.fileId,
    );
    const expectedFilename = normalizedIdentity(
      expectedOfficialLogoUpload.filename,
    );
    const expectedMimeType = normalizedIdentity(
      expectedOfficialLogoUpload.mimeType,
    ).toLowerCase();
    const expectedSizeBytes = expectedOfficialLogoUpload.sizeBytes;
    if (
      expectedSourceSha256 !== expectedLogoSha256 ||
      !expectedFileId ||
      !expectedFilename ||
      !expectedMimeType.startsWith("image/") ||
      !Number.isSafeInteger(expectedSizeBytes) ||
      expectedSizeBytes < 1
    ) {
      throw new KnowledgeBasePackageBindingError(
        "服务端官方主 Logo 上传账本无效或未与已绑定 Logo 字节对齐",
      );
    }
    const uploadedLogo = officialLogoUploadAssets[0];
    if (
      officialLogoUploadAssets.length !== 1 ||
      !uploadedLogo ||
      normalizedIdentity(uploadedLogo.sha256).toLowerCase() !==
        expectedLogoSha256 ||
      uploadedLogo.size !== expectedSizeBytes ||
      uploadedLogo.sourceUploadIndex !== 0 ||
      normalizedIdentity(uploadedLogo.sourceUploadFileId) !== expectedFileId ||
      normalizedIdentity(uploadedLogo.sourceUploadFilename) !==
        expectedFilename ||
      normalizedIdentity(uploadedLogo.sourceUploadMimeType).toLowerCase() !==
        expectedMimeType ||
      uploadedLogo.sourceUploadSizeBytes !== expectedSizeBytes ||
      normalizedIdentity(uploadedLogo.sourceUploadSha256).toLowerCase() !==
        expectedSourceSha256 ||
      uploadedLogo.ownership !== "first_party" ||
      uploadedLogo.assetType !== "brand_identity" ||
      uploadedLogo.displayRole !== "badge" ||
      uploadedLogo.sourcePageUrl !== undefined ||
      uploadedLogo.sourceAssetUrl !== undefined ||
      uploadedLogo.sourceDocumentPath !== undefined
    ) {
      throw new KnowledgeBasePackageBindingError(
        "最终 ZIP 的客户上传官方主 Logo 与服务端原始上传账本不一致",
      );
    }
  } else if (
    isCustomerUploadContract &&
    (officialLogoUploadAssets.length > 0 ||
      officialAssets.some(
        (asset) =>
          asset.sourceKind !== "official_web" &&
          asset.sourceKind !== "official_document",
      ))
  ) {
    throw new KnowledgeBasePackageBindingError(
      "最终 ZIP 声明了客户上传官方主 Logo，但服务端没有对应上传账本",
    );
  }

  if (isCustomerUploadContract) {
    const expectedUploads = input.expectedCustomerUploads || [];
    const expectedByHash = new Map(
      expectedUploads.map((upload) => [
        normalizedIdentity(upload.sourceSha256).toLowerCase(),
        upload,
      ]),
    );
    const customerBySourceHash = new Map<string, KnowledgeAsset>();
    for (const asset of customerAssets) {
      const sourceHash = normalizedIdentity(
        asset.sourceUploadSha256,
      ).toLowerCase();
      if (
        !/^[a-f0-9]{64}$/u.test(sourceHash) ||
        customerBySourceHash.has(sourceHash)
      ) {
        throw new KnowledgeBasePackageBindingError(
          "最终 ZIP 包含无效或重复的客户上传图片来源哈希",
        );
      }
      customerBySourceHash.set(sourceHash, asset);
    }
    if (
      expectedByHash.size !== expectedUploads.length ||
      customerBySourceHash.size !== expectedByHash.size ||
      [...expectedByHash.keys()].some(
        (sourceHash) => !customerBySourceHash.has(sourceHash),
      )
    ) {
      throw new KnowledgeBasePackageBindingError(
        "最终 ZIP 的客户上传图片与服务端已留存上传清单不一致",
      );
    }
    for (const [sourceHash, expected] of expectedByHash) {
      if (!/^[a-f0-9]{64}$/u.test(sourceHash)) {
        throw new KnowledgeBasePackageBindingError(
          "服务端客户上传图片清单包含无效来源哈希",
        );
      }
      const asset = customerBySourceHash.get(sourceHash)!;
      const filename = normalizedIdentity(asset.sourceUploadFilename);
      const mimeType = normalizedIdentity(
        asset.sourceUploadMimeType,
      ).toLowerCase();
      const expectedLeafIds = [
        ...new Set(expected.leafIds.map(normalizedIdentity)),
      ]
        .filter(Boolean)
        .sort();
      const packagedLeafIds = [
        ...new Set(
          (asset.documentIds || [])
            .map(normalizedIdentity)
            .map(
              (documentId) => leafIdByDocumentId.get(documentId) || documentId,
            ),
        ),
      ]
        .filter(Boolean)
        .sort();
      if (
        asset.assetType !== "customer_supplied" ||
        asset.displayRole !== "inline" ||
        !expected.filenames.map(normalizedIdentity).includes(filename) ||
        !expected.mimeTypes
          .map((value) => normalizedIdentity(value).toLowerCase())
          .includes(mimeType) ||
        expectedLeafIds.length === 0 ||
        expectedLeafIds.length !== packagedLeafIds.length ||
        expectedLeafIds.some(
          (leafId, index) => leafId !== packagedLeafIds[index],
        )
      ) {
        throw new KnowledgeBasePackageBindingError(
          `最终 ZIP 客户上传图片的来源或节点绑定不一致：${filename || sourceHash}`,
        );
      }
    }
  } else if ((input.expectedCustomerUploads || []).length > 0) {
    throw new KnowledgeBasePackageBindingError(
      "旧版最终 ZIP 合同不能绑定客户上传图片",
    );
  }

  return {
    leafCount: handledNodes.length,
    logoSha256: expectedLogoSha256,
    customerUploadCount: customerAssets.length,
    contentHashes: handledNodes.map((node) => ({
      leafId: node.leafId,
      sha256: knowledgeBaseMarkdownSha256(node.contentMarkdown || ""),
    })),
  };
}
