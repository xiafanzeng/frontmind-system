import JSZip from "jszip";

import {
  effectiveKnowledgeArchiveCharacterCount,
  knowledgeArchiveFormalText,
  markedKnowledgeArchiveFormalContent,
} from "./knowledge-archive-text-utils";
import {
  canonicalApprovedKnowledgeBaseLeafMarkdown,
  type KnowledgeBasePackageNode,
} from "./knowledge-base-package-validation";

const PACKAGE_MANIFEST_FILENAME = "00_package_manifest.json";
const FORMAL_CONTENT_START = "<!-- FRONTMIND_FORMAL_CONTENT_START -->";
const FORMAL_CONTENT_END = "<!-- FRONTMIND_FORMAL_CONTENT_END -->";
const CANONICAL_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function normalized(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .trim();
}

export class KnowledgeBasePackageCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBasePackageCanonicalizationError";
  }
}

function replaceFormalContent(content: string, approved: string) {
  const start = content.indexOf(FORMAL_CONTENT_START);
  const end = content.indexOf(FORMAL_CONTENT_END);
  if (
    start < 0 ||
    end <= start ||
    content.indexOf(
      FORMAL_CONTENT_START,
      start + FORMAL_CONTENT_START.length,
    ) >= 0 ||
    content.indexOf(FORMAL_CONTENT_END, end + FORMAL_CONTENT_END.length) >= 0
  ) {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP 叶子缺少唯一且有序的正式正文标记",
    );
  }
  return `${content.slice(0, start + FORMAL_CONTENT_START.length).trimEnd()}\n\n${approved}\n\n${content.slice(end).trimStart()}`;
}

function customerVisibleCharacterCount(input: {
  archive: JSZip;
  rootPrefix: string;
  documents: JsonRecord[];
  replacements: Map<string, string>;
}) {
  return Promise.all(
    input.documents
      .filter((document) => document.customerVisible === true)
      .map(async (document) => {
        const relativePath = normalized(document.path).replace(/^\/+/, "");
        const archivePath = `${input.rootPrefix}${relativePath}`;
        const content =
          input.replacements.get(archivePath) ||
          (await input.archive.file(archivePath)!.async("string"));
        const formal = markedKnowledgeArchiveFormalContent(content);
        if (formal === undefined) {
          throw new KnowledgeBasePackageCanonicalizationError(
            `最终 ZIP 正式文档标记无效：${relativePath}`,
          );
        }
        return effectiveKnowledgeArchiveCharacterCount(
          knowledgeArchiveFormalText(formal),
        );
      }),
  ).then((counts) => counts.reduce((sum, count) => sum + count, 0));
}

/**
 * Turn a provider-produced, independently valid v4 archive into the exact
 * customer-approved build. Only formal leaf bodies and their derived visible
 * character count are rewritten. Provider document IDs and asset links remain
 * intact so references elsewhere in the archive cannot become dangling. The
 * full archive and build-binding validators run again on the result.
 */
export async function canonicalizeKnowledgeBaseFinalArchive(input: {
  buffer: Buffer;
  nodes: readonly KnowledgeBasePackageNode[];
  buildRevision: number;
}) {
  const archive = await JSZip.loadAsync(input.buffer, { checkCRC32: true });
  const manifestEntries = Object.values(archive.files).filter(
    (entry) =>
      !entry.dir &&
      (entry.name === PACKAGE_MANIFEST_FILENAME ||
        entry.name.endsWith(`/${PACKAGE_MANIFEST_FILENAME}`)),
  );
  if (manifestEntries.length !== 1) {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP 必须包含唯一 package manifest",
    );
  }
  const manifestEntry = manifestEntries[0]!;
  const rootPrefix = manifestEntry.name.slice(
    0,
    manifestEntry.name.length - PACKAGE_MANIFEST_FILENAME.length,
  );
  let manifest: JsonRecord;
  try {
    manifest = JSON.parse(await manifestEntry.async("string")) as JsonRecord;
  } catch {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP package manifest 不是有效 JSON",
    );
  }
  if (
    manifest.schemaVersion !== 4 ||
    manifest.profile !== "dashboard-enterprise-v1"
  ) {
    return { buffer: input.buffer, changed: false };
  }
  if (!Number.isSafeInteger(input.buildRevision) || input.buildRevision < 1) {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP 权威构建版本无效",
    );
  }

  const documents = Array.isArray(manifest.documents)
    ? manifest.documents.map(record)
    : [];
  if (documents.some((document) => !document)) {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP package manifest 文档清单无效",
    );
  }
  const typedDocuments = documents as JsonRecord[];
  const leaves = typedDocuments
    .filter((document) => document.kind === "leaf")
    .sort((left, right) => Number(left.order) - Number(right.order));
  const nodes = [...input.nodes].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  if (
    leaves.length !== nodes.length ||
    leaves.length === 0 ||
    nodes.some((node, index) => node.ordinal !== index) ||
    leaves.some(
      (leaf, index) =>
        !Number.isSafeInteger(leaf.order) || Number(leaf.order) !== index,
    )
  ) {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP 叶子数量或顺序无法与权威知识树一一对应",
    );
  }

  const replacements = new Map<string, string>();
  const seenDocumentIds = new Set<string>();
  const seenLeafIds = new Set<string>();
  const nodeByDocumentId = new Map<string, KnowledgeBasePackageNode>();
  if (manifest.buildRevision !== input.buildRevision) {
    throw new KnowledgeBasePackageCanonicalizationError(
      `最终 ZIP buildRevision 与权威版本不一致：期望 ${input.buildRevision}，实际 ${String(manifest.buildRevision ?? "缺失")}`,
    );
  }
  let changed = false;

  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index]!;
    const node = nodes[index]!;
    const oldId = normalized(leaf.id);
    const leafId = normalized(node.leafId);
    const approved = canonicalApprovedKnowledgeBaseLeafMarkdown(
      node.contentMarkdown || "",
    );
    if (
      !oldId ||
      seenDocumentIds.has(oldId) ||
      !leafId ||
      seenLeafIds.has(leafId) ||
      (oldId !== leafId && oldId !== `leaf-${leafId}`) ||
      !approved
    ) {
      throw new KnowledgeBasePackageCanonicalizationError(
        `最终 ZIP 第 ${index + 1} 个叶子无法与权威标识 ${leafId || "<empty>"} 唯一对应`,
      );
    }
    if (
      leaf.title !== node.title ||
      leaf.branchId !== node.branchId ||
      leaf.branchTitle !== node.branchTitle ||
      leaf.order !== node.ordinal
    ) {
      throw new KnowledgeBasePackageCanonicalizationError(
        `最终 ZIP 叶子元数据与权威知识树不一致：${leafId}`,
      );
    }
    seenDocumentIds.add(oldId);
    seenLeafIds.add(leafId);
    nodeByDocumentId.set(oldId, node);

    const relativePath = normalized(leaf.path).replace(/^\/+/, "");
    const archivePath = `${rootPrefix}${relativePath}`;
    const entry = archive.file(archivePath);
    if (!entry) {
      throw new KnowledgeBasePackageCanonicalizationError(
        `最终 ZIP 缺少叶子文件：${relativePath || oldId}`,
      );
    }
    const originalContent = await entry.async("string");
    const canonicalContent = replaceFormalContent(originalContent, approved);
    if (canonicalContent !== originalContent) {
      replacements.set(archivePath, canonicalContent);
      changed = true;
    }
  }

  const assets = Array.isArray(manifest.assets)
    ? manifest.assets.map(record)
    : [];
  if (assets.some((asset) => !asset)) {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP package manifest 素材清单无效",
    );
  }
  for (const asset of assets as JsonRecord[]) {
    if (!Array.isArray(asset.documentIds)) continue;
    const documentIds = asset.documentIds.map(normalized);
    if (
      new Set(documentIds).size !== documentIds.length ||
      documentIds.some((id) => !id)
    ) {
      throw new KnowledgeBasePackageCanonicalizationError(
        `最终 ZIP 素材节点绑定无效：${normalized(asset.id) || "<unknown>"}`,
      );
    }
    const primaryNode = documentIds
      .map((documentId) => nodeByDocumentId.get(documentId))
      .filter((node): node is KnowledgeBasePackageNode => Boolean(node))
      .sort((left, right) => left.ordinal - right.ordinal)[0];
    if (primaryNode && asset.branchId !== primaryNode.branchId) {
      throw new KnowledgeBasePackageCanonicalizationError(
        `最终 ZIP 素材分支与权威节点不一致：${normalized(asset.id) || "<unknown>"}`,
      );
    }
  }

  const visibleCharacters = await customerVisibleCharacterCount({
    archive,
    rootPrefix,
    documents: typedDocuments,
    replacements,
  });
  const counts = record(manifest.counts);
  if (!counts) {
    throw new KnowledgeBasePackageCanonicalizationError(
      "最终 ZIP package manifest 计数清单无效",
    );
  }
  if (counts.customerVisibleCharacters !== visibleCharacters) {
    counts.customerVisibleCharacters = visibleCharacters;
    changed = true;
  }

  if (!changed) return { buffer: input.buffer, changed: false };
  replacements.set(
    manifestEntry.name,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const canonical = new JSZip();
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  for (const entry of entries) {
    const replacement = replacements.get(entry.name);
    const bytes =
      replacement === undefined
        ? await entry.async("nodebuffer")
        : Buffer.from(replacement, "utf8");
    canonical.file(entry.name, bytes, {
      binary: true,
      createFolders: false,
      date: CANONICAL_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const buffer = Buffer.from(
    await canonical.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    }),
  );
  return { buffer, changed: true };
}
