import { createHash } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";

import {
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import type { KnowledgeAsset, KnowledgeDocument } from "../shared/dashboard";
import {
  customerSafeKnowledgeFilename,
  customerSafeKnowledgeText,
  customerSafeKnowledgeUrls,
} from "../shared/knowledge-base-public-artifacts";
import { getDb } from "./db";
import {
  knowledgeBuildArtifactLocalPackageStorageKey,
  persistKnowledgeBuildArtifact,
  readKnowledgeBuildArtifact,
} from "./knowledge-build-artifact-store";
import {
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import { readValidatedActiveKnowledgeBaseWorkingSet } from "./knowledge-base-materialized-assets";
import type { ValidatedKnowledgeBaseWorkingSet } from "./knowledge-base-materialized-contract";
import { isMaterializedBuildPublishable } from "./knowledge-base-materialized-quality";
import { knowledgeBasePackageWriterTaskId } from "./knowledge-base-publication-binding";

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const PACKAGE_KIND = "frontmind.dashboard-owned-knowledge-package" as const;
const PACKAGE_PROFILE = "dashboard-core-v1" as const;
const ROOT_DIRECTORY = "frontmind_knowledge_base";
const MANIFEST_PATH = `${ROOT_DIRECTORY}/00_package_manifest.json`;
const SUPPORTING_PATHS = [
  "README.md",
  "00_knowledge_tree.md",
  "00_source_index.md",
  "reports/package-status.md",
] as const;
// A permanently corrupt local projection must not consume one recovery slot
// forever. The accepted completion receipt remains visible; an operator can
// explicitly resume this build after correcting its local cause.
export const MAX_AUTOMATIC_PACKAGE_ATTEMPTS = 8;

const packageDocumentSchema = z
  .object({
    id: z.string().min(1).max(191),
    title: z.string().min(1).max(512),
    branchId: z.string().min(1).max(191),
    branchTitle: z.string().min(1).max(512),
    order: z.number().int().nonnegative(),
    path: z.string().regex(/^nodes\/[0-9]{4}\.md$/u),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceUrls: z.array(z.string().url()).max(500),
    imageUrls: z.array(z.string().url()).max(500),
    evidencePaths: z.array(z.string().min(1).max(2_048)).max(1_500).default([]),
    assetIds: z.array(z.string().min(1).max(191)).max(100).default([]),
  })
  .strict();

const packageOfficialLogoSchema = z
  .object({
    id: z.literal("official-logo"),
    kind: z.literal("official_logo"),
    path: z.string().regex(/^assets\/official-logo\.(png|jpg|webp|avif|gif)$/u),
    filename: z.string().min(1).max(512),
    mimeType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/avif",
      "image/gif",
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
  })
  .strict();

const packageWorkingSetAssetSchema = z
  .object({
    id: z.string().min(1).max(191),
    kind: z.literal("working_set_asset"),
    path: z.string().min(1).max(2_048),
    sourcePath: z.string().min(1).max(1_024),
    filename: z.string().min(1).max(512),
    mimeType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/avif",
      "image/gif",
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    provenance: z.record(z.string(), z.unknown()),
    documentIds: z.array(z.string().min(1).max(191)).max(115),
  })
  .strict();

const packageAssetSchema = z.discriminatedUnion("kind", [
  packageOfficialLogoSchema,
  packageWorkingSetAssetSchema,
]);

const packageEvidenceSchema = z
  .object({
    path: z.string().min(1).max(2_048),
    sourcePath: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
    leafId: z.string().min(1).max(191),
    sourceUrl: z.string().url().nullable(),
    retrievedAt: z.string().min(1).max(64).nullable(),
  })
  .strict();

const packageManifestSchema = z
  .object({
    kind: z.literal(PACKAGE_KIND),
    schemaVersion: z.literal(1),
    profile: z.literal(PACKAGE_PROFILE),
    buildId: z.string().uuid(),
    generation: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    companyName: z.string().min(1).max(255),
    documents: z.array(packageDocumentSchema).min(1).max(115),
    evidence: z.array(packageEvidenceSchema).max(1_500).default([]),
    assets: z.array(packageAssetSchema).max(101).default([]),
    missing_optional_assets: z.array(z.string().min(1).max(128)).max(50),
    counts: z
      .object({
        nodes: z.number().int().positive(),
        files: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type DashboardOwnedKnowledgePackageManifest = z.infer<
  typeof packageManifestSchema
>;

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertBuildCoordinates(
  build: Pick<
    KnowledgeBaseBuild,
    "id" | "generation" | "revision" | "companyName"
  >,
) {
  if (
    !z.string().uuid().safeParse(build.id).success ||
    !Number.isSafeInteger(build.generation) ||
    build.generation < 1 ||
    !Number.isSafeInteger(build.revision) ||
    build.revision < 0 ||
    !String(build.companyName || "").trim()
  ) {
    throw new Error("LOCAL_PACKAGE_BUILD_COORDINATES_INVALID");
  }
}

function packageNodes(
  nodes: readonly Pick<
    KnowledgeBaseBuildNode,
    | "leafId"
    | "title"
    | "branchId"
    | "branchTitle"
    | "ordinal"
    | "status"
    | "contentMarkdown"
    | "contentSha256"
    | "sourceUrls"
    | "imageUrls"
    | "assetRefs"
  >[],
) {
  const ordered = [...nodes].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  if (
    ordered.length === 0 ||
    ordered.length > 115 ||
    ordered.some(
      (node, index) =>
        node.ordinal !== index ||
        (node.status !== "confirmed" && node.status !== "direct_prefilled"),
    )
  ) {
    throw new Error("LOCAL_PACKAGE_CORE_NODES_INCOMPLETE");
  }
  return ordered.map((node, index) => {
    const authoritativeContent = canonicalKnowledgeBaseMarkdown(
      node.contentMarkdown || "",
    );
    if (!authoritativeContent) {
      throw new Error("LOCAL_PACKAGE_CORE_NODE_EMPTY");
    }
    const authoritativeSha256 =
      knowledgeBaseMarkdownSha256(authoritativeContent);
    if (node.contentSha256 && node.contentSha256 !== authoritativeSha256) {
      throw new Error("LOCAL_PACKAGE_CORE_NODE_HASH_MISMATCH");
    }
    const content = canonicalKnowledgeBaseMarkdown(
      customerSafeKnowledgeText(authoritativeContent),
    );
    const contentSha256 = knowledgeBaseMarkdownSha256(content);
    return {
      metadata: {
        id: customerSafeKnowledgeText(node.leafId),
        title: customerSafeKnowledgeText(node.title),
        branchId: customerSafeKnowledgeText(node.branchId),
        branchTitle: customerSafeKnowledgeText(node.branchTitle),
        order: index,
        path: `nodes/${String(index + 1).padStart(4, "0")}.md`,
        contentSha256,
        sourceUrls: customerSafeKnowledgeUrls(node.sourceUrls),
        imageUrls: customerSafeKnowledgeUrls(node.imageUrls),
        evidencePaths: [] as string[],
        assetIds: [] as string[],
      },
      content,
    };
  });
}

function addDeterministicFile(
  zip: JSZip,
  path: string,
  value: string | Buffer,
) {
  zip.file(path, value, {
    binary: Buffer.isBuffer(value),
    date: FIXED_ZIP_DATE,
    unixPermissions: 0o100644,
    createFolders: false,
  });
}

const LOGO_EXTENSION_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
} as const;

type DashboardOwnedPackageLogo = {
  buffer: Buffer;
  filename: string;
  mimeType: keyof typeof LOGO_EXTENSION_BY_MIME;
  sha256: string;
  bytes: number;
};

function packageLogo(logo?: DashboardOwnedPackageLogo | null) {
  if (!logo) return null;
  const sourceFilename = String(logo.filename || "").trim();
  const filename = customerSafeKnowledgeFilename(
    sourceFilename,
    "FrontMind-logo",
  );
  const extension = LOGO_EXTENSION_BY_MIME[logo.mimeType];
  const digest = sha256(logo.buffer);
  if (
    !sourceFilename ||
    filename.length > 512 ||
    !extension ||
    !Number.isSafeInteger(logo.bytes) ||
    logo.bytes <= 0 ||
    logo.buffer.length !== logo.bytes ||
    !/^[a-f0-9]{64}$/u.test(logo.sha256) ||
    digest !== logo.sha256
  ) {
    throw new Error("LOCAL_PACKAGE_OPTIONAL_LOGO_INTEGRITY_MISMATCH");
  }
  return {
    metadata: {
      id: "official-logo" as const,
      kind: "official_logo" as const,
      path: `assets/official-logo.${extension}`,
      filename,
      mimeType: logo.mimeType,
      sha256: digest,
      bytes: logo.bytes,
    },
    buffer: logo.buffer,
  };
}

function packagedWorkingSetPath(sourcePath: string) {
  return `working-set/${sourcePath}`;
}

function packageMaterializedWorkingSet(input: {
  build: Pick<KnowledgeBaseBuild, "id" | "generation" | "companyName">;
  nodes: readonly KnowledgeBaseBuildNode[];
  workingSet?: ValidatedKnowledgeBaseWorkingSet;
}) {
  if (!input.workingSet) {
    return {
      evidence: [] as Array<z.infer<typeof packageEvidenceSchema>>,
      assets: [] as Array<z.infer<typeof packageWorkingSetAssetSchema>>,
      files: [] as Array<[string, Buffer]>,
      leafBindings: new Map<
        string,
        { evidencePaths: string[]; assetIds: string[] }
      >(),
    };
  }
  const { manifest, files } = input.workingSet;
  if (
    manifest.buildId !== input.build.id ||
    manifest.generation !== input.build.generation ||
    manifest.company.name !== input.build.companyName ||
    manifest.leaves.length !== input.nodes.length
  ) {
    throw new Error("LOCAL_PACKAGE_WORKING_SET_COORDINATES_MISMATCH");
  }
  const orderedNodes = [...input.nodes].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const leafBindings = new Map<
    string,
    { evidencePaths: string[]; assetIds: string[] }
  >();
  for (const [index, leaf] of manifest.leaves.entries()) {
    const node = orderedNodes[index];
    const bytes = files.get(leaf.contentPath);
    const content = canonicalKnowledgeBaseMarkdown(
      bytes?.toString("utf8") || "",
    );
    const nodeContent = canonicalKnowledgeBaseMarkdown(
      node?.contentMarkdown || "",
    );
    if (
      !node ||
      node.ordinal !== leaf.ordinal ||
      node.leafId !== leaf.leafId ||
      node.branchId !== leaf.branchId ||
      node.branchTitle !== leaf.branchTitle ||
      node.title !== leaf.title ||
      content !== nodeContent ||
      knowledgeBaseMarkdownSha256(content) !== node.contentSha256 ||
      JSON.stringify([...(node.assetRefs || [])].sort()) !==
        JSON.stringify([...leaf.assetIds].sort())
    ) {
      throw new Error("LOCAL_PACKAGE_WORKING_SET_NODE_AUTHORITY_MISMATCH");
    }
    leafBindings.set(customerSafeKnowledgeText(leaf.leafId), {
      evidencePaths: leaf.evidencePaths.map(packagedWorkingSetPath),
      assetIds: [...leaf.assetIds],
    });
  }
  const evidence = manifest.evidenceLedger.map((entry) => {
    const bytes = files.get(entry.path);
    if (!bytes || sha256(bytes) !== entry.sha256) {
      throw new Error("LOCAL_PACKAGE_WORKING_SET_EVIDENCE_HASH_MISMATCH");
    }
    return {
      path: packagedWorkingSetPath(entry.path),
      sourcePath: entry.path,
      sha256: entry.sha256,
      bytes: bytes.length,
      leafId: entry.leafId,
      sourceUrl: customerSafeKnowledgeUrls([entry.sourceUrl])[0] ?? null,
      retrievedAt: entry.retrievedAt,
    };
  });
  const assets = manifest.assets.map((asset) => {
    const bytes = files.get(asset.path);
    if (
      !bytes ||
      bytes.length !== asset.bytes ||
      sha256(bytes) !== asset.sha256
    ) {
      throw new Error("LOCAL_PACKAGE_WORKING_SET_ASSET_HASH_MISMATCH");
    }
    return {
      id: asset.assetId,
      kind: "working_set_asset" as const,
      path: packagedWorkingSetPath(asset.path),
      sourcePath: asset.path,
      filename: customerSafeKnowledgeFilename(
        asset.path,
        `${asset.assetId}.img`,
      ),
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      provenance: asset.provenance,
      documentIds: [...asset.documentIds],
    };
  });
  return {
    evidence,
    assets,
    leafBindings,
    files: [
      ...evidence.map(
        (entry) =>
          [entry.path, files.get(entry.sourcePath)!] as [string, Buffer],
      ),
      ...assets.map(
        (asset) =>
          [asset.path, files.get(asset.sourcePath)!] as [string, Buffer],
      ),
    ],
  };
}

export async function buildDashboardOwnedKnowledgePackage(input: {
  build: Pick<
    KnowledgeBaseBuild,
    "id" | "generation" | "revision" | "companyName" | "logoStorageKey"
  >;
  nodes: readonly KnowledgeBaseBuildNode[];
  logo?: DashboardOwnedPackageLogo | null;
  materializedWorkingSet?: ValidatedKnowledgeBaseWorkingSet;
}) {
  assertBuildCoordinates(input.build);
  const packaged = packageNodes(input.nodes);
  const logo = packageLogo(input.logo);
  const materialized = packageMaterializedWorkingSet({
    build: input.build,
    nodes: input.nodes,
    workingSet: input.materializedWorkingSet,
  });
  for (const item of packaged) {
    const binding = materialized.leafBindings.get(item.metadata.id);
    if (binding) {
      item.metadata.evidencePaths = binding.evidencePaths;
      item.metadata.assetIds = binding.assetIds;
    }
  }
  const companyName = customerSafeKnowledgeText(input.build.companyName).trim();
  const missingOptionalAssets = [
    ...(logo ? [] : ["official_logo"]),
    "supplement_overview",
    ...(materialized.evidence.length ? [] : ["supplement_evidence_index"]),
  ];
  const supportingFiles: Array<[string, string]> = [
    [
      "README.md",
      `# ${companyName} 企业知识库\n\n本归档由 Dashboard 从已接受节点确定性生成。缺失的可选资源不会影响正文完整性。\n`,
    ],
    [
      "00_knowledge_tree.md",
      `# 知识树\n\n${packaged
        .map(
          ({ metadata }) =>
            `- ${metadata.branchTitle} / ${metadata.id} ${metadata.title}`,
        )
        .join("\n")}\n`,
    ],
    [
      "00_source_index.md",
      `# 来源索引\n\n${packaged
        .map(({ metadata }) => {
          const urls = [...metadata.sourceUrls, ...metadata.imageUrls];
          const evidencePaths = metadata.evidencePaths;
          return `## ${metadata.id} ${metadata.title}\n\n${
            urls.length > 0 || evidencePaths.length > 0
              ? [
                  ...urls.map((url) => `- ${url}`),
                  ...evidencePaths.map((evidencePath) => `- ${evidencePath}`),
                ].join("\n")
              : "- 未附加可公开来源；以已接受正文为准。"
          }`;
        })
        .join("\n\n")}\n`,
    ],
    [
      "reports/package-status.md",
      `# 打包状态\n\n缺失的可选资源：${missingOptionalAssets.join("、") || "无"}\n`,
    ],
  ];
  const manifest: DashboardOwnedKnowledgePackageManifest = {
    kind: PACKAGE_KIND,
    schemaVersion: 1,
    profile: PACKAGE_PROFILE,
    buildId: input.build.id,
    generation: input.build.generation,
    revision: input.build.revision,
    companyName,
    documents: packaged.map((item) => item.metadata),
    evidence: materialized.evidence,
    assets: [...(logo ? [logo.metadata] : []), ...materialized.assets],
    missing_optional_assets: missingOptionalAssets,
    counts: {
      nodes: packaged.length,
      files:
        packaged.length +
        supportingFiles.length +
        1 +
        (logo ? 1 : 0) +
        materialized.files.length,
    },
  };
  packageManifestSchema.parse(manifest);
  const zip = new JSZip();
  // JSZip otherwise creates implicit parent directories with `new Date()`.
  // Those directory timestamps make identical accepted receipts produce
  // different package bytes across retries and process restarts.
  zip.file(`${ROOT_DIRECTORY}/`, null, {
    dir: true,
    date: FIXED_ZIP_DATE,
    unixPermissions: 0o40755,
    createFolders: false,
  });
  zip.file(`${ROOT_DIRECTORY}/reports/`, null, {
    dir: true,
    date: FIXED_ZIP_DATE,
    unixPermissions: 0o40755,
    createFolders: false,
  });
  zip.file(`${ROOT_DIRECTORY}/nodes/`, null, {
    dir: true,
    date: FIXED_ZIP_DATE,
    unixPermissions: 0o40755,
    createFolders: false,
  });
  if (logo) {
    zip.file(`${ROOT_DIRECTORY}/assets/`, null, {
      dir: true,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o40755,
      createFolders: false,
    });
  }
  for (const [relativePath, content] of supportingFiles.sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    addDeterministicFile(zip, `${ROOT_DIRECTORY}/${relativePath}`, content);
  }
  for (const item of packaged) {
    addDeterministicFile(
      zip,
      `${ROOT_DIRECTORY}/${item.metadata.path}`,
      item.content,
    );
  }
  if (logo) {
    addDeterministicFile(
      zip,
      `${ROOT_DIRECTORY}/${logo.metadata.path}`,
      logo.buffer,
    );
  }
  for (const [relativePath, bytes] of materialized.files.sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    addDeterministicFile(zip, `${ROOT_DIRECTORY}/${relativePath}`, bytes);
  }
  addDeterministicFile(zip, MANIFEST_PATH, canonicalJson(manifest));
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  return { buffer, sha256: sha256(buffer), manifest };
}

export async function readDashboardOwnedKnowledgePackage(input: {
  buffer: Buffer;
  expected: {
    buildId: string;
    generation: number;
    revision: number;
    companyName: string;
  };
  nodes?: readonly KnowledgeBaseBuildNode[];
  storeAsset?: (input: {
    id: string;
    path: string;
    mimeType: string;
    sha256: string;
    buffer: Buffer;
  }) => Promise<string>;
}) {
  const zip = await JSZip.loadAsync(input.buffer, { checkCRC32: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (
    entries.length === 0 ||
    entries.length > 1_600 ||
    entries.some(
      (entry) =>
        !entry.name.startsWith(`${ROOT_DIRECTORY}/`) ||
        entry.name.includes("../") ||
        entry.name.includes("\\") ||
        entry.name.includes("\u0000"),
    )
  ) {
    throw new Error("LOCAL_PACKAGE_STRUCTURE_INVALID");
  }
  const manifestEntry = zip.file(MANIFEST_PATH);
  if (!manifestEntry) throw new Error("LOCAL_PACKAGE_MANIFEST_MISSING");
  const manifest = packageManifestSchema.parse(
    JSON.parse(await manifestEntry.async("string")),
  );
  if (
    manifest.buildId !== input.expected.buildId ||
    manifest.generation !== input.expected.generation ||
    manifest.revision !== input.expected.revision ||
    manifest.companyName !==
      customerSafeKnowledgeText(input.expected.companyName).trim() ||
    manifest.counts.nodes !== manifest.documents.length ||
    manifest.counts.files !== entries.length
  ) {
    throw new Error("LOCAL_PACKAGE_COORDINATES_MISMATCH");
  }
  const declaredPaths = new Set([
    MANIFEST_PATH,
    ...SUPPORTING_PATHS.map(
      (relativePath) => `${ROOT_DIRECTORY}/${relativePath}`,
    ),
    ...manifest.documents.map(
      (document) => `${ROOT_DIRECTORY}/${document.path}`,
    ),
    ...manifest.evidence.map(
      (evidence) => `${ROOT_DIRECTORY}/${evidence.path}`,
    ),
    ...manifest.assets.map((asset) => `${ROOT_DIRECTORY}/${asset.path}`),
  ]);
  if (
    declaredPaths.size !== entries.length ||
    entries.some((entry) => !declaredPaths.has(entry.name))
  ) {
    throw new Error("LOCAL_PACKAGE_UNREGISTERED_FILE");
  }
  const orderedNodes = input.nodes
    ? [...input.nodes].sort((left, right) => left.ordinal - right.ordinal)
    : undefined;
  const documents: KnowledgeDocument[] = [];
  for (const metadata of manifest.documents) {
    const entry = zip.file(`${ROOT_DIRECTORY}/${metadata.path}`);
    if (!entry) throw new Error("LOCAL_PACKAGE_NODE_MISSING");
    const content = canonicalKnowledgeBaseMarkdown(await entry.async("string"));
    if (knowledgeBaseMarkdownSha256(content) !== metadata.contentSha256) {
      throw new Error("LOCAL_PACKAGE_NODE_HASH_MISMATCH");
    }
    const node = orderedNodes?.[metadata.order];
    const authoritativeContent = canonicalKnowledgeBaseMarkdown(
      node?.contentMarkdown || "",
    );
    const projectedContent = canonicalKnowledgeBaseMarkdown(
      customerSafeKnowledgeText(authoritativeContent),
    );
    if (
      input.nodes &&
      (!node ||
        (node.status !== "confirmed" && node.status !== "direct_prefilled") ||
        node.ordinal !== metadata.order ||
        customerSafeKnowledgeText(node.leafId) !== metadata.id ||
        customerSafeKnowledgeText(node.title) !== metadata.title ||
        customerSafeKnowledgeText(node.branchId) !== metadata.branchId ||
        customerSafeKnowledgeText(node.branchTitle) !== metadata.branchTitle ||
        knowledgeBaseMarkdownSha256(projectedContent) !==
          metadata.contentSha256 ||
        content !== projectedContent ||
        JSON.stringify(customerSafeKnowledgeUrls(node.sourceUrls)) !==
          JSON.stringify(metadata.sourceUrls) ||
        JSON.stringify(customerSafeKnowledgeUrls(node.imageUrls)) !==
          JSON.stringify(metadata.imageUrls) ||
        JSON.stringify([...(node.assetRefs || [])].sort()) !==
          JSON.stringify([...metadata.assetIds].sort()) ||
        (node.contentSha256 !== null &&
          node.contentSha256 !== undefined &&
          knowledgeBaseMarkdownSha256(authoritativeContent) !==
            node.contentSha256))
    ) {
      throw new Error("LOCAL_PACKAGE_NODE_AUTHORITY_MISMATCH");
    }
    documents.push({
      id: metadata.id,
      path: `${ROOT_DIRECTORY}/${metadata.path}`,
      title: metadata.title,
      content,
      kind: "leaf",
      branchId: metadata.branchId,
      branchTitle: metadata.branchTitle,
      order: metadata.order,
      evidenceStatus: "needs_verification",
      sourceIds: metadata.sourceUrls,
      evidenceDocumentIds: metadata.evidencePaths,
      assetIds: metadata.assetIds,
      customerVisible: true,
      evidenceCharacters: 0,
      requiredFormalCharacters: 0,
      contentStatus: "needs_verification",
    });
  }
  if (input.nodes && documents.length !== input.nodes.length) {
    throw new Error("LOCAL_PACKAGE_NODE_COUNT_MISMATCH");
  }
  for (const metadata of manifest.evidence) {
    const entry = zip.file(`${ROOT_DIRECTORY}/${metadata.path}`);
    if (!entry) throw new Error("LOCAL_PACKAGE_EVIDENCE_MISSING");
    const buffer = await entry.async("nodebuffer");
    if (
      buffer.length !== metadata.bytes ||
      sha256(buffer) !== metadata.sha256 ||
      !buffer.toString("utf8").trim()
    ) {
      throw new Error("LOCAL_PACKAGE_EVIDENCE_HASH_MISMATCH");
    }
    const document = manifest.documents.find(
      (candidate) => candidate.id === metadata.leafId,
    );
    if (!document?.evidencePaths.includes(metadata.path)) {
      throw new Error("LOCAL_PACKAGE_EVIDENCE_BINDING_MISMATCH");
    }
  }
  const referencedEvidence = new Set(
    manifest.documents.flatMap((document) => document.evidencePaths),
  );
  if (
    referencedEvidence.size !== manifest.evidence.length ||
    manifest.evidence.some((evidence) => !referencedEvidence.has(evidence.path))
  ) {
    throw new Error("LOCAL_PACKAGE_EVIDENCE_BINDING_MISMATCH");
  }
  const assets: KnowledgeAsset[] = [];
  const storedAssetKeys: string[] = [];
  for (const metadata of manifest.assets) {
    const entry = zip.file(`${ROOT_DIRECTORY}/${metadata.path}`);
    if (!entry) throw new Error("LOCAL_PACKAGE_ASSET_MISSING");
    const buffer = await entry.async("nodebuffer");
    if (
      buffer.length !== metadata.bytes ||
      sha256(buffer) !== metadata.sha256
    ) {
      throw new Error("LOCAL_PACKAGE_ASSET_HASH_MISMATCH");
    }
    const key = input.storeAsset
      ? await input.storeAsset({
          id: metadata.id,
          path: metadata.path,
          mimeType: metadata.mimeType,
          sha256: metadata.sha256,
          buffer,
        })
      : metadata.sha256;
    if (!String(key || "").trim()) {
      throw new Error("LOCAL_PACKAGE_ASSET_STORAGE_FAILED");
    }
    if (input.storeAsset) storedAssetKeys.push(key);
    assets.push(
      metadata.kind === "official_logo"
        ? {
            id: metadata.id,
            key,
            path: `${ROOT_DIRECTORY}/${metadata.path}`,
            mimeType: metadata.mimeType,
            size: metadata.bytes,
            sha256: metadata.sha256,
            caption: "企业官方主 Logo",
            alt: "企业官方主 Logo",
            sourceKind: "official_logo_upload",
            ownership: "first_party",
            assetType: "brand_identity",
            displayRole: "badge",
          }
        : {
            id: metadata.id,
            key,
            path: `${ROOT_DIRECTORY}/${metadata.path}`,
            mimeType: metadata.mimeType,
            size: metadata.bytes,
            sha256: metadata.sha256,
            width: metadata.width,
            height: metadata.height,
            documentIds: metadata.documentIds,
            sourceDocumentPath: metadata.sourcePath,
            sourceKind: "official_document",
            ownership: "unknown",
            assetType: "other",
            displayRole: "inline",
          },
    );
  }
  const referencedAssets = new Set(
    manifest.documents.flatMap((document) => document.assetIds),
  );
  const workingSetAssets = manifest.assets.filter(
    (asset) => asset.kind === "working_set_asset",
  );
  const workingSetAssetIds = new Set(workingSetAssets.map((asset) => asset.id));
  if (
    [...referencedAssets].some((assetId) => !workingSetAssetIds.has(assetId)) ||
    workingSetAssets.some(
      (asset) =>
        JSON.stringify([...asset.documentIds].sort()) !==
        JSON.stringify(
          manifest.documents
            .filter((document) => document.assetIds.includes(asset.id))
            .map((document) => document.id)
            .sort(),
        ),
    )
  ) {
    throw new Error("LOCAL_PACKAGE_ASSET_BINDING_MISMATCH");
  }
  return {
    manifest,
    documents,
    assets,
    storedAssetKeys,
    packageBuildRevision: manifest.revision,
    packageSchemaVersion: 1 as const,
  };
}

export function isDashboardOwnedKnowledgePackageBuild(
  build: Pick<KnowledgeBaseBuild, "packageOutputItemId">,
) {
  return String(build.packageOutputItemId || "").startsWith("dashboard-local:");
}

function packageRetryAt(attempt: number, now: Date) {
  const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempt, 8));
  return new Date(now.getTime() + delay);
}

export function nextKnowledgeBasePackageFailure(input: {
  packageAttemptCount: number;
  now: Date;
  errorCode: string;
}) {
  const packageAttemptCount = input.packageAttemptCount + 1;
  const terminal =
    input.errorCode === "MATERIALIZED_BUILD_NOT_PUBLISHABLE" ||
    packageAttemptCount >= MAX_AUTOMATIC_PACKAGE_ATTEMPTS;
  return {
    packageStatus: terminal
      ? ("attention_required" as const)
      : ("retrying" as const),
    packageAttemptCount,
    packageNextRetryAt: terminal
      ? null
      : packageRetryAt(packageAttemptCount, input.now),
    packageLastErrorCode: input.errorCode,
  };
}

/** A stale concurrent sweep did no durable work and must not affect metrics. */
export function knowledgeBasePackageSweepWriteApplied(result: unknown) {
  if (!Array.isArray(result)) return false;
  const header = result[0];
  return Boolean(
    header &&
      typeof header === "object" &&
      "affectedRows" in header &&
      (header as { affectedRows?: unknown }).affectedRows,
  );
}

export async function runKnowledgeBasePackageSweep(limit = 8) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const now = new Date();
  const candidates = await db
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.status, "ready_to_publish"),
        inArray(knowledgeBaseBuilds.packageStatus, ["preparing", "retrying"]),
      ),
    )
    .orderBy(
      asc(knowledgeBaseBuilds.packageNextRetryAt),
      asc(knowledgeBaseBuilds.id),
    )
    .limit(Math.max(1, Math.min(50, limit * 3)));
  let ready = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (
      !candidate.contentCompletedAt ||
      (candidate.packageNextRetryAt && candidate.packageNextRetryAt > now) ||
      ready + failed >= limit
    ) {
      continue;
    }
    const nodes = await db
      .select()
      .from(knowledgeBaseBuildNodes)
      .where(eq(knowledgeBaseBuildNodes.buildId, candidate.id))
      .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
    try {
      if (
        candidate.executionMode === "materialized_bundle_v1" &&
        !isMaterializedBuildPublishable(candidate, {
          knownLeafIds: nodes.map((node) => node.leafId),
        })
      ) {
        throw new Error("MATERIALIZED_BUILD_NOT_PUBLISHABLE");
      }
      const materializedWorkingSet =
        candidate.executionMode === "materialized_bundle_v1"
          ? (
              await readValidatedActiveKnowledgeBaseWorkingSet({
                db,
                build: candidate,
              })
            ).validated
          : undefined;
      const logo =
        candidate.logoStorageKey &&
        candidate.logoSha256 &&
        candidate.logoBytes &&
        candidate.logoFilename &&
        candidate.logoMimeType &&
        candidate.logoMimeType in LOGO_EXTENSION_BY_MIME
          ? await readKnowledgeBuildArtifact({
              userId: candidate.userId,
              buildId: candidate.id,
              generation: candidate.generation,
              kind: "logo",
              expectedSha256: candidate.logoSha256,
              expectedBytes: candidate.logoBytes,
              storageKey: candidate.logoStorageKey,
            })
              .then((buffer) => ({
                buffer,
                filename: candidate.logoFilename!,
                mimeType:
                  candidate.logoMimeType! as keyof typeof LOGO_EXTENSION_BY_MIME,
                sha256: candidate.logoSha256!,
                bytes: candidate.logoBytes!,
              }))
              // Logo is optional for package readiness. A missing/corrupt
              // Logo is declared in the manifest instead of rolling content
              // completion back or consuming the package retry budget.
              .catch(() => null)
          : null;
      const built = await buildDashboardOwnedKnowledgePackage({
        build: candidate,
        nodes,
        logo,
        materializedWorkingSet,
      });
      const stored = await persistKnowledgeBuildArtifact({
        userId: candidate.userId,
        buildId: candidate.id,
        generation: candidate.generation,
        kind: "package",
        buffer: built.buffer,
        expectedSha256: built.sha256,
        storageKey: knowledgeBuildArtifactLocalPackageStorageKey({
          userId: candidate.userId,
          buildId: candidate.id,
          generation: candidate.generation,
          revision: candidate.revision,
        }),
      });
      const taskId = knowledgeBasePackageWriterTaskId(candidate);
      const result = await db
        .update(knowledgeBaseBuilds)
        .set({
          packageStatus: "ready",
          packageAttemptCount: candidate.packageAttemptCount + 1,
          packageNextRetryAt: null,
          packageLastErrorCode: null,
          packageRevision: candidate.revision,
          packageTaskId: taskId,
          packageOutputItemId: `dashboard-local:${candidate.id}:${candidate.revision}`,
          packageFileId: null,
          packageFilename: `${candidate.companyName}-knowledge-base.zip`.slice(
            0,
            512,
          ),
          packageDescriptorHash: sha256(
            `dashboard-local:${candidate.id}:${candidate.generation}:${candidate.revision}:${built.sha256}`,
          ),
          packageStorageKey: stored.storageKey,
          packageArchiveSha256: stored.sha256,
          packageSizeBytes: stored.bytes,
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, candidate.id),
            eq(knowledgeBaseBuilds.userId, candidate.userId),
            eq(knowledgeBaseBuilds.generation, candidate.generation),
            eq(knowledgeBaseBuilds.revision, candidate.revision),
            eq(knowledgeBaseBuilds.status, "ready_to_publish"),
            eq(
              knowledgeBaseBuilds.packageAttemptCount,
              candidate.packageAttemptCount,
            ),
            inArray(knowledgeBaseBuilds.packageStatus, [
              "preparing",
              "retrying",
            ]),
          ),
        );
      if (knowledgeBasePackageSweepWriteApplied(result)) ready += 1;
    } catch (error) {
      const errorCode =
        error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)
          ? error.message
          : "LOCAL_PACKAGE_BUILD_FAILED";
      const failure = nextKnowledgeBasePackageFailure({
        packageAttemptCount: candidate.packageAttemptCount,
        now,
        errorCode,
      });
      const result = await db
        .update(knowledgeBaseBuilds)
        .set(failure)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, candidate.id),
            eq(knowledgeBaseBuilds.userId, candidate.userId),
            eq(knowledgeBaseBuilds.generation, candidate.generation),
            eq(knowledgeBaseBuilds.revision, candidate.revision),
            eq(
              knowledgeBaseBuilds.packageAttemptCount,
              candidate.packageAttemptCount,
            ),
            inArray(knowledgeBaseBuilds.packageStatus, [
              "preparing",
              "retrying",
            ]),
          ),
        );
      if (knowledgeBasePackageSweepWriteApplied(result)) failed += 1;
    }
  }
  return { scanned: candidates.length, ready, failed };
}
