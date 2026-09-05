import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";

import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";
import {
  KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY,
  knowledgeBaseTreePolicy,
} from "./knowledge-base-progress";

export const KNOWLEDGE_BASE_FINALIZATION_INPUT_FILENAME_PREFIX =
  "frontmind-kb-finalization-input";

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");

type FinalizationNode = {
  id: string;
  title: string;
  branchId: string;
  branchTitle: string;
  order: number;
  status: string;
  contentMarkdown: string;
  contentSha256: string;
  sourceUrls?: string[];
  imageUrls?: string[];
};

type FinalizationAsset = {
  kind: "official_logo" | "customer_upload";
  filename: string;
  mimeType: string;
  sha256: string;
  bytes: Buffer;
  documentIds: string[];
  sourceFileIds?: string[];
  sourceKind?: string;
  sourceUploadIndex?: number;
  sourceUploadFileId?: string;
  sourceUploadFilename?: string;
  sourceUploadMimeType?: string;
  sourceUploadSizeBytes?: number;
  sourceUploadSha256?: string;
  sourcePageUrl?: string;
  sourceAssetUrl?: string;
  sourceDocumentPath?: string;
};

function safeSegment(value: string, fallback: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/\0\r\n]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  return normalized.slice(0, 180) || fallback;
}

function assertAsset(asset: FinalizationAsset) {
  const actualSha256 = createHash("sha256").update(asset.bytes).digest("hex");
  if (
    !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
    actualSha256 !== asset.sha256 ||
    asset.bytes.length < 1 ||
    !asset.mimeType.startsWith("image/")
  ) {
    throw new Error(`FINALIZATION_INPUT_ASSET_INVALID:${asset.kind}`);
  }
}

function validHttpUrl(value: string | undefined) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Deterministic, server-owned handoff for the final model turn. It is an input
 * bundle, never the customer deliverable: the provider must still construct
 * the complete dashboard-enterprise-v1 archive and pass the bundled Skill
 * validator. Keeping exact approved prose and original image bytes together
 * removes any dependency on an upstream task's implicit workspace lifetime.
 */
export async function buildKnowledgeBaseFinalizationInput(input: {
  companyName: string;
  operationId: string;
  turnId: string;
  buildRevision: number;
  treePolicyVersion?: number;
  nodes: FinalizationNode[];
  assets: FinalizationAsset[];
}) {
  const depthPolicy = knowledgeBaseTreePolicy(
    input.treePolicyVersion ?? KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY,
  );
  if (
    !input.companyName.trim() ||
    !input.operationId.trim() ||
    !input.turnId.trim() ||
    !Number.isSafeInteger(input.buildRevision) ||
    input.buildRevision < 1 ||
    input.nodes.length < depthPolicy.minLeaves ||
    input.nodes.length > depthPolicy.maxLeaves
  ) {
    throw new Error("FINALIZATION_INPUT_COORDINATES_INVALID");
  }
  const nodes = [...input.nodes].sort(
    (left, right) => left.order - right.order,
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (
    nodeIds.size !== nodes.length ||
    nodes.some(
      (node, index) =>
        node.order !== index ||
        !node.id.trim() ||
        !node.title.trim() ||
        !node.branchId.trim() ||
        !node.branchTitle.trim() ||
        (node.status !== "confirmed" && node.status !== "direct_prefilled") ||
        !node.contentMarkdown.trim() ||
        node.contentMarkdown.includes("FRONTMIND_FORMAL_CONTENT_START") ||
        node.contentMarkdown.includes("FRONTMIND_FORMAL_CONTENT_END") ||
        knowledgeBaseMarkdownSha256(node.contentMarkdown) !==
          node.contentSha256,
    )
  ) {
    throw new Error("FINALIZATION_INPUT_NODE_INVALID");
  }
  input.assets.forEach(assertAsset);
  if (
    // Customer uploads are admission-capped at 80 MiB and the separately
    // validated official Logo at 15 MiB. Keep the final handoff consistent
    // with those earlier limits so an accepted build cannot deadlock here.
    input.assets.reduce((sum, asset) => sum + asset.bytes.length, 0) >
      95 * 1024 * 1024 ||
    input.assets.length > 100 ||
    new Set(input.assets.map((asset) => asset.sha256)).size !==
      input.assets.length ||
    input.assets.some(
      (asset) =>
        asset.documentIds.length < 1 ||
        asset.documentIds.some((documentId) => !nodeIds.has(documentId)),
    ) ||
    input.assets.filter((asset) => asset.kind === "official_logo").length !== 1
  ) {
    throw new Error("FINALIZATION_INPUT_LOGO_REQUIRED");
  }
  const officialLogo = input.assets.find(
    (asset) => asset.kind === "official_logo",
  )!;
  if (
    officialLogo.documentIds.length !== 1 ||
    officialLogo.documentIds[0] !== nodes[0]!.id
  ) {
    throw new Error("FINALIZATION_INPUT_LOGO_BINDING_INVALID");
  }
  if (
    (officialLogo.sourceKind !== undefined &&
      !["official_web", "official_document", "official_logo_upload"].includes(
        officialLogo.sourceKind,
      )) ||
    (officialLogo.sourceKind === "official_web" &&
      (!validHttpUrl(officialLogo.sourcePageUrl) ||
        !validHttpUrl(officialLogo.sourceAssetUrl))) ||
    (officialLogo.sourceKind === "official_document" &&
      !officialLogo.sourceDocumentPath) ||
    (officialLogo.sourceKind === "official_logo_upload" &&
      (officialLogo.sourceUploadIndex !== 0 ||
        !officialLogo.sourceUploadFileId ||
        officialLogo.sourceUploadFilename !== officialLogo.filename ||
        officialLogo.sourceUploadMimeType !== officialLogo.mimeType ||
        officialLogo.sourceUploadSizeBytes !== officialLogo.bytes.length ||
        officialLogo.sourceUploadSha256 !== officialLogo.sha256)) ||
    input.assets.some(
      (asset) =>
        asset.kind === "customer_upload" &&
        (asset.sourceKind !== "user_upload" ||
          !asset.sourceUploadFilename ||
          !asset.sourceUploadMimeType ||
          !asset.sourceUploadSha256 ||
          asset.sourceUploadIndex !== undefined ||
          asset.sourceUploadFileId !== undefined ||
          asset.sourceUploadSizeBytes !== undefined),
    )
  ) {
    throw new Error("FINALIZATION_INPUT_ASSET_PROVENANCE_INVALID");
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const zip = new JSZip();
  const assetLedger = [...input.assets]
    .sort((left, right) =>
      `${left.kind}:${left.sha256}`.localeCompare(
        `${right.kind}:${right.sha256}`,
      ),
    )
    .map((asset, index) => {
      const archiveInputPath = `assets/${String(index + 1).padStart(3, "0")}_${asset.kind}_${safeSegment(asset.filename, "image")}`;
      const documentIds = [...new Set(asset.documentIds)].sort(
        (left, right) => nodeById.get(left)!.order - nodeById.get(right)!.order,
      );
      zip.file(archiveInputPath, asset.bytes, {
        binary: true,
        // Implicit JSZip directory entries use the wall clock even when the
        // file entry has a fixed date, so two otherwise identical builds can
        // differ when they straddle a ZIP timestamp tick under load.
        createFolders: false,
        date: FIXED_ZIP_DATE,
        unixPermissions: 0o100644,
      });
      return {
        kind: asset.kind,
        input: {
          path: archiveInputPath,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.bytes.length,
          sha256: asset.sha256,
          managedFileIds: [...new Set(asset.sourceFileIds || [])].sort(),
        },
        requiredManifest: {
          branchId: nodeById.get(documentIds[0]!)!.branchId,
          documentIds,
          ...(asset.sourceKind ? { sourceKind: asset.sourceKind } : {}),
          ownership: "first_party",
          assetType:
            asset.kind === "official_logo"
              ? "brand_identity"
              : "customer_supplied",
          displayRole: asset.kind === "official_logo" ? "badge" : "inline",
          ...(asset.sourceUploadIndex !== undefined
            ? { sourceUploadIndex: asset.sourceUploadIndex }
            : {}),
          ...(asset.sourceUploadFileId
            ? { sourceUploadFileId: asset.sourceUploadFileId }
            : {}),
          ...(asset.sourceUploadFilename
            ? { sourceUploadFilename: asset.sourceUploadFilename }
            : {}),
          ...(asset.sourceUploadMimeType
            ? { sourceUploadMimeType: asset.sourceUploadMimeType }
            : {}),
          ...(asset.sourceUploadSizeBytes !== undefined
            ? { sourceUploadSizeBytes: asset.sourceUploadSizeBytes }
            : {}),
          ...(asset.sourceUploadSha256
            ? { sourceUploadSha256: asset.sourceUploadSha256 }
            : {}),
          ...(asset.sourcePageUrl
            ? { sourcePageUrl: asset.sourcePageUrl }
            : {}),
          ...(asset.sourceAssetUrl
            ? { sourceAssetUrl: asset.sourceAssetUrl }
            : {}),
          ...(asset.sourceDocumentPath
            ? { sourceDocumentPath: asset.sourceDocumentPath }
            : {}),
        },
      };
    });

  for (const node of nodes) {
    const nodePath = `approved_nodes/${String(node.order).padStart(3, "0")}_${safeSegment(node.id, "leaf")}.md`;
    zip.file(nodePath, node.contentMarkdown, {
      binary: false,
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }

  const ledger = {
    kind: "frontmind.knowledge-base.finalization-input",
    schemaVersion: 1,
    companyName: input.companyName,
    operationId: input.operationId,
    turnId: input.turnId,
    requiredPackage: {
      schemaVersion: 4,
      profile: "dashboard-enterprise-v1",
      buildRevision: input.buildRevision,
      treePolicyVersion: depthPolicy.version,
      minLeaves: depthPolicy.minLeaves,
      maxLeaves: depthPolicy.maxLeaves,
    },
    nodes: nodes.map((node) => ({
      ...node,
      approvedContentPath: `approved_nodes/${String(node.order).padStart(3, "0")}_${safeSegment(node.id, "leaf")}.md`,
    })),
    assets: assetLedger,
  };
  zip.file("FINALIZATION_INPUT.json", `${JSON.stringify(ledger, null, 2)}\n`, {
    binary: false,
    date: FIXED_ZIP_DATE,
    unixPermissions: 0o100644,
  });
  zip.file(
    "README.md",
    [
      "# FrontMind finalization input",
      "",
      "This is server-owned INPUT, not the final customer archive.",
      "Read FINALIZATION_INPUT.json and every bundled byte. Build the complete schema v4 dashboard-enterprise-v1 ZIP using references/output-format.md from the attached Skill.",
      "Copy each approved node body byte-for-byte. For every packaged asset, copy FINALIZATION_INPUT.json.assets[].requiredManifest field-for-field without additions, omissions, inference or substitution. System input files are not customer uploads. Never invent sourceUpload* values: they are permitted only when the exact field is present in requiredManifest.",
      "The official Logo must use the bound original bytes. Every customer upload must yield one physical packaged asset; convert unsupported input formats only as required by output-format.md and preserve the exact server-authored sourceUpload provenance. Placeholder README/TXT assets are forbidden.",
      "Run the exact validation command stated in the current turn prompt, including the finalization-input filename, SHA-256, operationId and turnId flags; attach FINAL.zip only after exit code 0 and `VALID dashboard-enterprise-v1 archive`.",
      "",
    ].join("\n"),
    {
      binary: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    },
  );

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    filename: `${KNOWLEDGE_BASE_FINALIZATION_INPUT_FILENAME_PREFIX}-${sha256.slice(0, 16)}.zip`,
    bytes,
    sha256,
    assetCount: assetLedger.length,
  };
}
