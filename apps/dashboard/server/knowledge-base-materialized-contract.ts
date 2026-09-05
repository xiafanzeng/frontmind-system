import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";

import {
  DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS,
  ModelOutputRepairError,
  parseExactJson,
  repairStructuredJsonCandidate,
  type ModelOutputRepairRuleCode,
} from "../shared/model-output-repair";
import { customerSafeKnowledgeAssetLabel } from "../shared/knowledge-base-public-artifacts";
import {
  isKnowledgeBaseTextEvidencePath,
  KNOWLEDGE_BASE_WORKING_SET_POLICY,
} from "../shared/knowledge-base-working-set-policy";
import {
  canonicalizeKnowledgeBaseCompanyName,
  canonicalizeKnowledgeBaseWebsite,
  KnowledgeBaseCompanyIdentityNormalizationError,
} from "./knowledge-base-company-identity";
import { canonicalKnowledgeBaseMarkdown } from "./knowledge-base-package-validation";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/u;
const MAX_COMPRESSED_ARCHIVE_BYTES =
  KNOWLEDGE_BASE_WORKING_SET_POLICY.archive.maxCompressedBytes;
const MAX_UNCOMPRESSED_ARCHIVE_BYTES =
  KNOWLEDGE_BASE_WORKING_SET_POLICY.archive.maxUncompressedBytes;
const MAX_ENTRY_COUNT = KNOWLEDGE_BASE_WORKING_SET_POLICY.archive.maxEntryCount;
const MAX_COMPRESSION_RATIO =
  KNOWLEDGE_BASE_WORKING_SET_POLICY.archive.maxCompressionRatio;
const MAX_ASSET_BYTES = KNOWLEDGE_BASE_WORKING_SET_POLICY.archive.maxAssetBytes;
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const PATCH_WARNING_LIMIT =
  KNOWLEDGE_BASE_WORKING_SET_POLICY.archive.patchWarningLimit;
const MATERIALIZED_JSON_REPAIR_POLICY = {
  fenceLanguages: ["", "json"],
  aliases: {
    schema_version: "schemaVersion",
    operation_id: "operationId",
    build_id: "buildId",
    content_version: "contentVersion",
    tree_policy_version: "treePolicyVersion",
    research_coverage: "researchCoverage",
    evidence_ledger: "evidenceLedger",
    source_url: "sourceUrl",
    retrieved_at: "retrievedAt",
    leaf_id: "leafId",
    branch_id: "branchId",
    branch_title: "branchTitle",
    content_path: "contentPath",
    content_sha256: "contentSha256",
    evidence_paths: "evidencePaths",
    asset_ids: "assetIds",
    asset_id: "assetId",
    mime_type: "mimeType",
    document_ids: "documentIds",
  },
  numericKeys: [
    "schemaVersion",
    "generation",
    "contentVersion",
    "treePolicyVersion",
    "ordinal",
    "bytes",
    "width",
    "height",
  ],
  identityKeys: [
    "operation_id",
    "operationId",
    "build_id",
    "buildId",
    "leaf_id",
    "leafId",
    "branch_id",
    "branchId",
    "asset_id",
    "assetId",
  ],
} as const;

export const KNOWLEDGE_BASE_ASSET_TYPES = [
  "brand_identity",
  "product_ui",
  "product_diagram",
  "case_photo",
  "team_photo",
  "environment_photo",
  "certificate_badge",
  "document_figure",
  "customer_supplied",
  "other",
] as const;
export const KNOWLEDGE_BASE_ASSET_DISPLAY_ROLES = [
  "hero",
  "inline",
  "badge",
] as const;

type KnowledgeBaseAssetType = (typeof KNOWLEDGE_BASE_ASSET_TYPES)[number];
type KnowledgeBaseAssetDisplayRole =
  (typeof KNOWLEDGE_BASE_ASSET_DISPLAY_ROLES)[number];

const FORMAL_CONTENT_MARKERS = [
  ["FRONTMIND_FORMAL_CONTENT_START", "FRONTMIND_FORMAL_CONTENT_END"],
  [
    "<!-- FRONTMIND_FORMAL_CONTENT_START -->",
    "<!-- FRONTMIND_FORMAL_CONTENT_END -->",
  ],
] as const;
const INTERNAL_NODE_HEADINGS = new Set(["## 资料元数据", "## 证据与核验说明"]);
const INTERNAL_NODE_FIELD_RE =
  /^\s*(?:[-*+]\s+)?(?:documentRole|evidenceStatus|sourceIds|evidenceDocumentIds|sameBranchEvidenceDocumentIds|evidenceCharacters|formalCharacters|requiredFormalCharacters)\s*[:：=]/imu;
const FORMAL_CONTENT_MARKER_RE = /FRONTMIND_FORMAL_CONTENT_(?:START|END)/u;

type JsonObject = Record<string, unknown>;

export type KnowledgeBaseWorkingSetBranch = {
  branchId: string;
  title: string;
  ordinal: number;
};

export type KnowledgeBaseWorkingSetEvidence = {
  path: string;
  sha256: string;
  leafId: string;
  sourceUrl: string | null;
  retrievedAt: string | null;
};

export type KnowledgeBaseWorkingSetAsset = {
  assetId: string;
  path: string;
  sha256: string;
  mimeType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/gif"
    | "image/avif";
  bytes: number;
  width: number;
  height: number;
  provenance: JsonObject;
  documentIds: string[];
  assetType?: KnowledgeBaseAssetType;
  displayRole?: KnowledgeBaseAssetDisplayRole;
  caption?: string;
};

export type KnowledgeBasePatchAttachmentSourceProof = Readonly<{
  index: number;
  contentSha256: string;
  sizeBytes: number;
  mimeType: string;
}>;

export type KnowledgeBaseWorkingSetLeaf = {
  leafId: string;
  branchId: string;
  branchTitle: string;
  title: string;
  ordinal: number;
  contentPath: string;
  contentSha256: string;
  evidencePaths: string[];
  assetIds: string[];
  productFamilyId?: string;
};

export type KnowledgeBaseWorkingSetManifest = {
  kind: "frontmind.kb-working-set";
  schemaVersion: 1;
  operationId: string;
  buildId: string;
  generation: number;
  contentVersion: number;
  skill: {
    name: "socratic-kb-builder";
    version: "5";
    contentHash: string;
  };
  treePolicyVersion: 2;
  company: { name: string; website: string | null };
  researchCoverage: JsonObject;
  branches: KnowledgeBaseWorkingSetBranch[];
  evidenceLedger: KnowledgeBaseWorkingSetEvidence[];
  leaves: KnowledgeBaseWorkingSetLeaf[];
  assets: KnowledgeBaseWorkingSetAsset[];
  logo:
    | { status: "missing"; assetId: null }
    | { status: "available"; assetId: string };
  counts: { leaves: number; evidenceFiles: number; assets: number };
};

/**
 * Immutable coordinates owned by Dashboard for one initial materialization.
 * The provider must only copy these values into BUNDLE.json; it never derives
 * them from the Skill archive, customer files, or an earlier response.
 */
export type KnowledgeBaseWorkingSetExpectation = Readonly<{
  operationId: string;
  buildId: string;
  generation: number;
  contentVersion: number;
  skillContentHash: string;
  treePolicyVersion: number;
  companyName: string;
  companyWebsite: string | null;
  expectedUploadsRead?: number;
}>;

export type KnowledgeBaseInitialBundleExpectation = Readonly<
  Omit<
    KnowledgeBaseWorkingSetExpectation,
    "contentVersion" | "treePolicyVersion" | "expectedUploadsRead"
  > & {
    contentVersion: 1;
    treePolicyVersion: 2;
    expectedUploadsRead: number;
  }
>;

export type KnowledgeBaseNodePatchManifest = {
  kind: "frontmind.kb-node-patch";
  schemaVersion: 1;
  operationId: string;
  buildId: string;
  generation: number;
  baseContentVersion: number;
  baseWorkingSetSha256: string;
  targetLeafId: string;
  contentPath: string;
  contentSha256: string;
  evidence: {
    add: Array<Pick<KnowledgeBaseWorkingSetEvidence, "path" | "sha256">>;
    remove: string[];
  };
  assets: {
    add: KnowledgeBaseWorkingSetAsset[];
    remove: string[];
  };
};

export type ValidatedKnowledgeBaseWorkingSet = {
  manifest: KnowledgeBaseWorkingSetManifest;
  files: ReadonlyMap<string, Buffer>;
  /** Dashboard-authored deterministic bytes; Provider ZIP bytes are staging-only. */
  archiveBytes: Buffer;
  packageSha256: string;
  manifestSha256: string;
  warnings: Array<{
    code:
      | "RESULT_INCOMPLETE"
      | "EVIDENCE_INCOMPLETE"
      | "PRESENTATION_NORMALIZED"
      | "OPTIONAL_ASSET_SKIPPED"
      | "OPTIONAL_BINARY_EVIDENCE_SKIPPED"
      | "MANIFEST_NORMALIZED"
      | "SERVER_COORDINATE_NORMALIZED";
    area?: string;
  }>;
  droppedOptionalCount: number;
};

export type KnowledgeBaseResultProcessingStage =
  | "descriptor_search"
  | "download"
  | "archive_safety"
  | "manifest_parse"
  | "component_projection"
  | "canonical_validation"
  | "activation"
  | "presentation";

export type KnowledgeBaseNormalizationDiagnostic = Readonly<{
  code: ValidatedKnowledgeBaseWorkingSet["warnings"][number]["code"];
  area?: string;
}>;

export type KnowledgeBaseCanonicalPresentation = Readonly<{
  kind: "frontmind.kb-canonical-presentation";
  schemaVersion: 1;
  operationId: string;
  buildId: string;
  generation: number;
  contentVersion: number;
  completeness: "complete" | "partial";
  displayEligible: true;
  downstreamEligible: boolean;
  publishable: boolean;
  branches: ReadonlyArray<KnowledgeBaseWorkingSetBranch>;
  leaves: ReadonlyArray<
    Readonly<{
      leafId: string;
      branchId: string;
      title: string;
      ordinal: number;
      markdown: string;
      assetIds: readonly string[];
    }>
  >;
}>;

export type KnowledgeBaseInitialResultProvenance = Readonly<{
  exactBoundTask: true;
  directAssistantOutput: true;
  descriptorFilename: string;
}>;

export type KnowledgeBasePatchResultProvenance = Readonly<{
  exactBoundTask: true;
  directAssistantOutput: true;
  descriptorFilename: string;
  /** Set only while the active build/base/turn/leaf tuple is row-locked. */
  baseAuthorityLocked?: true;
}>;

export type KnowledgeBaseNormalizationOutcome =
  | Readonly<{
      kind: "accepted";
      mode: "initial" | "patch";
      completeness: "complete" | "partial";
      canonicalArchiveBytes: Buffer;
      manifest: KnowledgeBaseWorkingSetManifest;
      renderSnapshot: KnowledgeBaseCanonicalPresentation;
      diagnostics: KnowledgeBaseNormalizationDiagnostic[];
      packageSha256: string;
      manifestSha256: string;
      /** Strictly revalidated server-owned bytes used by activation. */
      workingSet: ValidatedKnowledgeBaseWorkingSet;
      /** Present only for a revision result. */
      sourcePatch?: ValidatedKnowledgeBaseNodePatch;
      /** Present only for a revision result. */
      changed?: boolean;
    }>
  | Readonly<{
      kind: "rejected";
      code:
        | "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID"
        | "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED";
      stage: KnowledgeBaseResultProcessingStage;
      resetRequired: true;
    }>;

export type ValidatedKnowledgeBaseNodePatch = {
  manifest: KnowledgeBaseNodePatchManifest;
  files: ReadonlyMap<string, Buffer>;
  archiveBytes: Buffer;
  packageSha256: string;
  manifestSha256: string;
  components: {
    content: "valid" | "invalid";
    evidence: "valid" | "invalid";
    assets: "valid" | "invalid";
  };
  warnings: Array<{
    code:
      | "MANIFEST_NORMALIZED"
      | "PRESENTATION_NORMALIZED"
      | "RESULT_INCOMPLETE"
      | "EVIDENCE_INCOMPLETE"
      | "OPTIONAL_ASSET_SKIPPED"
      | "SERVER_COORDINATE_NORMALIZED";
    area: "manifest" | "content" | "evidence" | "assets";
  }>;
  droppedComponents: {
    evidence: number;
    assets: number;
    presentationFields: number;
  };
};

export class KnowledgeBaseMaterializedContractError extends Error {
  readonly code = "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID";

  constructor(
    message: string,
    readonly category:
      | "contract"
      | "manifest_parse"
      | "frozen_source_conflict" = "contract",
  ) {
    super(message);
    this.name = "KnowledgeBaseMaterializedContractError";
  }
}

function fail(
  message: string,
  category: KnowledgeBaseMaterializedContractError["category"] = "contract",
): never {
  throw new KnowledgeBaseMaterializedContractError(message, category);
}

export function isKnowledgeBasePatchManifestParseError(error: unknown) {
  return (
    error instanceof KnowledgeBaseMaterializedContractError &&
    error.category === "manifest_parse"
  );
}

/**
 * Projects a provider-authored node into the one customer-visible Markdown
 * representation used by Working Set bytes, database rows and final packages.
 * The adapter only removes deterministic transport wrappers; it never rewrites
 * the customer's prose or guesses between multiple candidate bodies.
 */
export function projectKnowledgeBaseCustomerMarkdown(input: {
  leafTitle: string;
  markdown: string;
}) {
  const source = canonicalKnowledgeBaseMarkdown(input.markdown);
  const title = canonicalKnowledgeBaseMarkdown(input.leafTitle).replace(
    /\n+/gu,
    " ",
  );
  if (!source || !title) fail("节点客户正文不得为空");

  const lines = source.split("\n");
  let body = source;
  const matchedRanges: Array<{ start: number; end: number }> = [];
  for (const [startMarker, endMarker] of FORMAL_CONTENT_MARKERS) {
    const starts = lines.flatMap((line, index) =>
      line.trim() === startMarker ? [index] : [],
    );
    const ends = lines.flatMap((line, index) =>
      line.trim() === endMarker ? [index] : [],
    );
    if (starts.length || ends.length) {
      if (starts.length !== 1 || ends.length !== 1 || ends[0]! <= starts[0]!) {
        fail("节点正式正文标记不唯一或顺序无效");
      }
      matchedRanges.push({ start: starts[0]!, end: ends[0]! });
    }
  }
  if (matchedRanges.length > 1) fail("节点包含多组正式正文标记");
  if (matchedRanges.length === 1) {
    const range = matchedRanges[0]!;
    body = lines.slice(range.start + 1, range.end).join("\n");
  } else {
    const internalHeadingIndex = lines.findIndex((line) =>
      INTERNAL_NODE_HEADINGS.has(line.trim()),
    );
    if (internalHeadingIndex >= 0) {
      body = lines.slice(0, internalHeadingIndex).join("\n");
    }
  }

  body = canonicalKnowledgeBaseMarkdown(body);
  const bodyLines = body.split("\n");
  const firstLineTitle = bodyLines[0]?.match(/^#\s+(.+)$/u)?.[1]?.trim();
  if (firstLineTitle === title) {
    body = canonicalKnowledgeBaseMarkdown(bodyLines.slice(1).join("\n"));
  }
  if (
    !body ||
    FORMAL_CONTENT_MARKER_RE.test(body) ||
    body.split("\n").some((line) => INTERNAL_NODE_HEADINGS.has(line.trim())) ||
    INTERNAL_NODE_FIELD_RE.test(body)
  ) {
    fail("节点客户正文为空或仍包含内部元数据");
  }
  return canonicalKnowledgeBaseMarkdown(`# ${title}\n\n${body}`);
}

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    fail(`${label} 字段不符合合同`);
  }
}

function string(value: unknown, label: string, max = 1_024) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) fail(`${label} 无效`);
  return normalized;
}

function nullableString(value: unknown, label: string, max = 2_048) {
  if (value === null) return null;
  return string(value, label, max);
}

function integer(value: unknown, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} 无效`);
  }
  return Number(value);
}

function id(value: unknown, label: string) {
  const normalized = string(value, label, 191);
  if (!SAFE_ID_RE.test(normalized)) fail(`${label} 无效`);
  return normalized;
}

function digest(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail(`${label} 无效`);
  }
  return value;
}

function safeArchivePath(value: unknown, label: string) {
  const path = string(value, label, 1_024);
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`${label} 包含不安全路径`);
  }
  return path;
}

function decodeUtf8(bytes: Buffer, label: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} 不是有效 UTF-8`);
  }
}

function isTextEvidencePath(path: string) {
  return isKnowledgeBaseTextEvidencePath(path);
}

function authoritativeCoordinate<T extends string | number | null>(input: {
  raw: unknown;
  expected: T | undefined;
  parse: (value: unknown) => T;
  label: string;
  onNormalized: () => void;
}) {
  if (input.expected === undefined) return input.parse(input.raw);
  const expected = input.parse(input.expected);
  let equivalent = false;
  try {
    equivalent = input.parse(input.raw) === expected;
  } catch {
    equivalent = false;
  }
  if (!equivalent) input.onNormalized();
  return expected;
}

function stringArray(value: unknown, label: string, mapper = string) {
  if (!Array.isArray(value)) fail(`${label} 必须是数组`);
  return value.map((item, index) => mapper(item, `${label}[${index}]`));
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) fail(`${label} 包含重复项`);
}

async function loadSafeArchive(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_COMPRESSED_ARCHIVE_BYTES) {
    fail("ZIP 压缩字节数无效");
  }
  // JSZip indexes entries by decoded filename, so two identical central
  // directory names can otherwise collapse into one object property before
  // the semantic validator sees them. Inspect the bounded central directory
  // first and reject duplicate physical records (including archives that
  // require ZIP64/multi-disk interpretation, which this contract never emits).
  const endSearchStart = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= endSearchStart; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > bytes.length) {
    fail("ZIP central directory 无效");
  }
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const directoryDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const directoryBytes = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directoryBytes > endOffset
  ) {
    fail("ZIP central directory 坐标无效");
  }
  const centralNames = new Set<string>();
  let centralCursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      centralCursor + 46 > endOffset ||
      bytes.readUInt32LE(centralCursor) !== 0x02014b50
    ) {
      fail("ZIP central directory 条目无效");
    }
    const nameLength = bytes.readUInt16LE(centralCursor + 28);
    const extraLength = bytes.readUInt16LE(centralCursor + 30);
    const commentLength = bytes.readUInt16LE(centralCursor + 32);
    const entryEnd =
      centralCursor + 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || entryEnd > endOffset) {
      fail("ZIP central directory 文件名无效");
    }
    const physicalName = bytes
      .subarray(centralCursor + 46, centralCursor + 46 + nameLength)
      .toString("hex");
    if (centralNames.has(physicalName)) {
      fail("ZIP central directory 包含重复文件名");
    }
    centralNames.add(physicalName);
    centralCursor = entryEnd;
  }
  if (centralCursor !== directoryOffset + directoryBytes) {
    fail("ZIP central directory 长度无效");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    fail("ZIP 无法解析或 CRC 校验失败");
  }
  const entries = Object.values(zip.files);
  if (
    !entries.length ||
    entries.length !== totalEntries ||
    entries.length > MAX_ENTRY_COUNT
  ) {
    fail("ZIP 文件数量无效");
  }
  const files = new Map<string, Buffer>();
  const portablePaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    const raw = entry as typeof entry & {
      unsafeOriginalName?: string;
      unixPermissions?: number | string | null;
      _data?: { compressedSize?: number; uncompressedSize?: number };
    };
    const path = safeArchivePath(entry.name, "ZIP 文件名");
    if (raw.unsafeOriginalName && raw.unsafeOriginalName !== path) {
      fail("ZIP 包含路径穿越文件名");
    }
    const unixPermissions =
      typeof raw.unixPermissions === "string"
        ? Number.parseInt(raw.unixPermissions, 8)
        : raw.unixPermissions;
    if (
      entry.dir ||
      (typeof unixPermissions === "number" &&
        (unixPermissions & 0o170000) === 0o120000)
    ) {
      fail("ZIP 不得包含目录或符号链接");
    }
    if (files.has(path)) fail("ZIP 文件名重复");
    const portablePath = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (portablePaths.has(portablePath)) {
      fail("ZIP 文件名存在大小写或 Unicode 规范化冲突");
    }
    portablePaths.add(portablePath);
    const uncompressedHint = Number(raw._data?.uncompressedSize || 0);
    const compressedHint = Number(raw._data?.compressedSize || 0);
    if (
      uncompressedHint > 0 &&
      compressedHint > 0 &&
      uncompressedHint / compressedHint > MAX_COMPRESSION_RATIO
    ) {
      fail("ZIP 压缩比异常");
    }
    const payload = await entry.async("nodebuffer");
    totalBytes += payload.length;
    if (totalBytes > MAX_UNCOMPRESSED_ARCHIVE_BYTES) {
      fail("ZIP 解压总字节数超限");
    }
    files.set(path, payload);
  }
  return files;
}

function parseMaterializedJsonEnvelope(text: string, path: string) {
  if (text.length > DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS) {
    fail(`${path} 超过安全 JSON 上限`);
  }
  let parsed: unknown;
  let normalizations: ModelOutputRepairRuleCode[] = [];
  try {
    parsed = parseExactJson(text);
  } catch (exactError) {
    if (
      exactError instanceof ModelOutputRepairError &&
      exactError.code === "DUPLICATE_KEY"
    ) {
      fail(`${path} 包含重复 JSON 键`);
    }
    try {
      const repaired = repairStructuredJsonCandidate(
        text,
        MATERIALIZED_JSON_REPAIR_POLICY,
      );
      parsed = repaired.value;
      normalizations = repaired.ruleCodes;
    } catch (error) {
      if (
        error instanceof ModelOutputRepairError &&
        ["DUPLICATE_KEY", "MULTIPLE_CANDIDATES", "CONFLICTING_ALIAS"].includes(
          error.code,
        )
      ) {
        fail(`${path} 包含重复键、冲突别名或多个 JSON 值`);
      }
      fail(`${path} 不是有效 JSON`, "manifest_parse");
    }
  }
  if (typeof parsed === "string") {
    try {
      const repaired = repairStructuredJsonCandidate(
        text,
        MATERIALIZED_JSON_REPAIR_POLICY,
      );
      parsed = repaired.value;
      normalizations = repaired.ruleCodes;
    } catch (error) {
      if (
        error instanceof ModelOutputRepairError &&
        ["DUPLICATE_KEY", "MULTIPLE_CANDIDATES", "CONFLICTING_ALIAS"].includes(
          error.code,
        )
      ) {
        fail(`${path} 包含重复键、冲突别名或多个 JSON 值`);
      }
      fail(`${path} 不是有效 JSON`, "manifest_parse");
    }
  }
  return {
    value: object(parsed, path),
    normalizations,
  };
}

function parseJsonFileDetailed(
  files: ReadonlyMap<string, Buffer>,
  path: string,
) {
  const bytes = files.get(path);
  if (!bytes) fail(`ZIP 缺少 ${path}`, "manifest_parse");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseMaterializedJsonEnvelope(text, path);
  } catch (error) {
    if (error instanceof KnowledgeBaseMaterializedContractError) throw error;
    fail(`${path} 不是有效 JSON`, "manifest_parse");
  }
}

function parseJsonFile(files: ReadonlyMap<string, Buffer>, path: string) {
  return parseJsonFileDetailed(files, path).value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function canonicalWorkingSetArchive(input: {
  manifest: KnowledgeBaseWorkingSetManifest;
  files: ReadonlyMap<string, Buffer>;
}) {
  const files = new Map<string, Buffer>();
  const leaves = input.manifest.leaves.map((leaf) => {
    const source = input.files.get(leaf.contentPath);
    if (!source) fail(`节点 ${leaf.leafId} 正文不存在`);
    const decoded = decodeUtf8(source, `节点 ${leaf.leafId} 正文`);
    const markdown = projectKnowledgeBaseCustomerMarkdown({
      leafTitle: leaf.title,
      markdown: decoded,
    });
    const bytes = Buffer.from(markdown, "utf8");
    files.set(leaf.contentPath, bytes);
    return { ...leaf, contentSha256: sha256(bytes) };
  });
  for (const evidence of input.manifest.evidenceLedger) {
    const bytes = input.files.get(evidence.path);
    if (!bytes) fail(`证据 ${evidence.path} 不存在`);
    files.set(evidence.path, bytes);
    evidence.sha256 = sha256(bytes);
  }
  for (const asset of input.manifest.assets) {
    const bytes = input.files.get(asset.path);
    if (!bytes) fail(`资产 ${asset.assetId} 不存在`);
    files.set(asset.path, bytes);
    asset.sha256 = sha256(bytes);
    asset.bytes = bytes.length;
  }
  const manifest: KnowledgeBaseWorkingSetManifest = {
    ...input.manifest,
    leaves,
    counts: {
      leaves: leaves.length,
      evidenceFiles: input.manifest.evidenceLedger.length,
      assets: input.manifest.assets.length,
    },
  };
  const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
  files.set("BUNDLE.json", manifestBytes);
  const zip = new JSZip();
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    zip.file(path, bytes, {
      binary: true,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }
  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  return {
    manifest,
    files,
    archiveBytes,
    packageSha256: sha256(archiveBytes),
    manifestSha256: sha256(manifestBytes),
  };
}

async function canonicalPatchArchive(input: {
  manifest: KnowledgeBaseNodePatchManifest;
  files: ReadonlyMap<string, Buffer>;
}) {
  const files = new Map<string, Buffer>();
  const content = input.files.get(input.manifest.contentPath);
  if (content) files.set(input.manifest.contentPath, content);
  for (const evidence of input.manifest.evidence.add) {
    const bytes = input.files.get(evidence.path);
    if (!bytes) fail(`canonical Patch 缺少证据 ${evidence.path}`);
    files.set(evidence.path, bytes);
  }
  for (const asset of input.manifest.assets.add) {
    const bytes = input.files.get(asset.path);
    if (!bytes) fail(`canonical Patch 缺少资产 ${asset.assetId}`);
    files.set(asset.path, bytes);
  }
  const manifestBytes = Buffer.from(stableJson(input.manifest), "utf8");
  files.set("PATCH.json", manifestBytes);
  const zip = new JSZip();
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    zip.file(path, bytes, {
      binary: true,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }
  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  return {
    files,
    archiveBytes,
    packageSha256: sha256(archiveBytes),
    manifestSha256: sha256(manifestBytes),
  };
}

function declaredFile(input: {
  files: ReadonlyMap<string, Buffer>;
  path: unknown;
  expectedSha256: unknown;
  label: string;
}) {
  const path = safeArchivePath(input.path, `${input.label}.path`);
  const expectedSha256 = digest(input.expectedSha256, `${input.label}.sha256`);
  const bytes = input.files.get(path);
  if (!bytes) fail(`${input.label} 文件不存在`);
  if (sha256(bytes) !== expectedSha256) fail(`${input.label} 哈希不一致`);
  return { path, bytes, sha256: expectedSha256 };
}

function actualDeclaredFile(input: {
  files: ReadonlyMap<string, Buffer>;
  path: unknown;
  label: string;
}) {
  const path = safeArchivePath(input.path, `${input.label}.path`);
  const bytes = input.files.get(path);
  if (!bytes) fail(`${input.label} 文件不存在`);
  return { path, bytes, sha256: sha256(bytes) };
}

function imageMagicMatches(mimeType: string, bytes: Buffer) {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
  }
  if (mimeType === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (mimeType === "image/avif") {
    return (
      bytes.length >= 16 &&
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      (bytes.subarray(8, 32).includes(Buffer.from("avif")) ||
        bytes.subarray(8, 32).includes(Buffer.from("avis")))
    );
  }
  return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
}

function imageMimeTypeFromBytes(
  bytes: Buffer,
): KnowledgeBaseWorkingSetAsset["mimeType"] | null {
  return (
    (
      [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
      ] as const
    ).find((mimeType) => imageMagicMatches(mimeType, bytes)) ?? null
  );
}

const REQUIRED_ASSET_KEYS = [
  "assetId",
  "path",
  "sha256",
  "mimeType",
  "bytes",
  "width",
  "height",
  "provenance",
  "documentIds",
] as const;
const PRESENTATION_ASSET_KEYS = [
  "assetType",
  "displayRole",
  "caption",
] as const;

function requiredKeys(
  value: JsonObject,
  required: readonly string[],
  label: string,
) {
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail(`${label} 字段不符合合同`);
  }
}

function canonicalAssetPresentation(input: {
  value: JsonObject;
  onNormalized?: (count: number) => void;
}) {
  let normalizedCount = Object.keys(input.value).filter(
    (key) =>
      !REQUIRED_ASSET_KEYS.includes(
        key as (typeof REQUIRED_ASSET_KEYS)[number],
      ) &&
      !PRESENTATION_ASSET_KEYS.includes(
        key as (typeof PRESENTATION_ASSET_KEYS)[number],
      ),
  ).length;
  const assetType = KNOWLEDGE_BASE_ASSET_TYPES.includes(
    input.value.assetType as KnowledgeBaseAssetType,
  )
    ? (input.value.assetType as KnowledgeBaseAssetType)
    : undefined;
  if (input.value.assetType !== undefined && !assetType) normalizedCount += 1;
  const displayRole = KNOWLEDGE_BASE_ASSET_DISPLAY_ROLES.includes(
    input.value.displayRole as KnowledgeBaseAssetDisplayRole,
  )
    ? (input.value.displayRole as KnowledgeBaseAssetDisplayRole)
    : undefined;
  if (input.value.displayRole !== undefined && !displayRole) {
    normalizedCount += 1;
  }
  const captionCandidate =
    typeof input.value.caption === "string" && input.value.caption.length <= 512
      ? customerSafeKnowledgeAssetLabel(input.value.caption)
      : undefined;
  if (input.value.caption !== undefined && !captionCandidate) {
    normalizedCount += 1;
  }
  if (normalizedCount) input.onNormalized?.(normalizedCount);
  return {
    ...(assetType ? { assetType } : {}),
    ...(displayRole ? { displayRole } : {}),
    ...(captionCandidate ? { caption: captionCandidate } : {}),
  };
}

async function parseAsset(input: {
  value: unknown;
  files: ReadonlyMap<string, Buffer>;
  label: string;
  recomputeDerived?: boolean;
  onPresentationNormalized?: (count: number) => void;
}) {
  const value = object(input.value, input.label);
  requiredKeys(value, REQUIRED_ASSET_KEYS, input.label);
  const file = input.recomputeDerived
    ? actualDeclaredFile({
        files: input.files,
        path: value.path,
        label: input.label,
      })
    : declaredFile({
        files: input.files,
        path: value.path,
        expectedSha256: value.sha256,
        label: input.label,
      });
  const declaredMimeType = input.recomputeDerived
    ? null
    : string(value.mimeType, `${input.label}.mimeType`, 64);
  const mimeType = input.recomputeDerived
    ? imageMimeTypeFromBytes(file.bytes)
    : declaredMimeType &&
        imageMimeTypeFromBytes(file.bytes) === declaredMimeType
      ? (declaredMimeType as KnowledgeBaseWorkingSetAsset["mimeType"])
      : null;
  if (
    !file.bytes.length ||
    file.bytes.length > MAX_ASSET_BYTES ||
    !mimeType ||
    (!input.recomputeDerived &&
      integer(value.bytes, `${input.label}.bytes`, 1) !== file.bytes.length)
  ) {
    fail(`${input.label} 图片字节无效`);
  }
  let metadata: { width?: number; height?: number };
  try {
    const image = sharp(file.bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    metadata = await image.metadata();
    await image.stats();
  } catch {
    fail(`${input.label} 图片无法解码`);
  }
  const width = integer(metadata.width, `${input.label}.actualWidth`, 1);
  const height = integer(metadata.height, `${input.label}.actualHeight`, 1);
  if (
    !input.recomputeDerived &&
    (integer(value.width, `${input.label}.width`, 1) !== width ||
      integer(value.height, `${input.label}.height`, 1) !== height)
  ) {
    fail(`${input.label} 图片尺寸不一致`);
  }
  const documentIds = input.recomputeDerived
    ? []
    : stringArray(value.documentIds, `${input.label}.documentIds`, id);
  if (!input.recomputeDerived) {
    assertUnique(documentIds, `${input.label}.documentIds`);
  }
  return {
    assetId: id(value.assetId, `${input.label}.assetId`),
    path: file.path,
    sha256: file.sha256,
    mimeType: mimeType as KnowledgeBaseWorkingSetAsset["mimeType"],
    bytes: file.bytes.length,
    width,
    height,
    provenance: object(value.provenance, `${input.label}.provenance`),
    documentIds,
    ...canonicalAssetPresentation({
      value,
      onNormalized: input.onPresentationNormalized,
    }),
  } satisfies KnowledgeBaseWorkingSetAsset;
}

function assertExpected(
  actual: string | number | null,
  expected: string | number | null | undefined,
  label: string,
) {
  if (expected !== undefined && actual !== expected)
    fail(`${label} 与任务坐标不一致`);
}

async function validateKnowledgeBaseWorkingSetArchiveInternal(
  bytes: Buffer,
  expected: Partial<KnowledgeBaseWorkingSetExpectation>,
  verifyCanonicalRoundtrip: boolean,
): Promise<ValidatedKnowledgeBaseWorkingSet> {
  const files = await loadSafeArchive(bytes);
  if (files.has("PATCH.json")) {
    fail("初始 Working Set 必须且只能包含 BUNDLE.json 合同");
  }
  if (!files.has("BUNDLE.json")) {
    fail("初始 Working Set 缺少 BUNDLE.json 合同", "manifest_parse");
  }
  const parsedEnvelope = parseJsonFileDetailed(files, "BUNDLE.json");
  const raw = parsedEnvelope.value;
  requiredKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "operationId",
      "buildId",
      "generation",
      "contentVersion",
      "skill",
      "treePolicyVersion",
      "company",
      "researchCoverage",
      "branches",
      "evidenceLedger",
      "leaves",
      "assets",
      "logo",
      "counts",
    ],
    "BUNDLE.json",
  );
  const warnings: ValidatedKnowledgeBaseWorkingSet["warnings"] = [];
  const warningKeys = new Set<string>();
  const warn = (
    warning: ValidatedKnowledgeBaseWorkingSet["warnings"][number],
  ) => {
    const key = `${warning.code}:${warning.area ?? ""}`;
    if (!warningKeys.has(key)) warnings.push(warning);
    warningKeys.add(key);
  };
  if (parsedEnvelope.normalizations.length) {
    warn({ code: "MANIFEST_NORMALIZED", area: "manifest" });
  }
  const coordinateNormalized = () =>
    warn({ code: "SERVER_COORDINATE_NORMALIZED", area: "manifest" });
  if (raw.kind !== "frontmind.kb-working-set" || raw.schemaVersion !== 1) {
    fail("Working Set 合同版本无效");
  }
  const operationId = string(raw.operationId, "operationId", 128);
  assertExpected(operationId, expected.operationId, "operationId");
  const buildId = authoritativeCoordinate({
    raw: raw.buildId,
    expected: expected.buildId,
    parse: (value) => string(value, "buildId", 36),
    label: "buildId",
    onNormalized: coordinateNormalized,
  });
  const generation = authoritativeCoordinate({
    raw: raw.generation,
    expected: expected.generation,
    parse: (value) => integer(value, "generation", 1),
    label: "generation",
    onNormalized: coordinateNormalized,
  });
  const contentVersion = authoritativeCoordinate({
    raw: raw.contentVersion,
    expected: expected.contentVersion,
    parse: (value) => integer(value, "contentVersion", 1),
    label: "contentVersion",
    onNormalized: coordinateNormalized,
  });

  let rawSkillHash: unknown;
  try {
    const skillRaw = object(raw.skill, "skill");
    rawSkillHash = skillRaw.contentHash;
    if (skillRaw.name !== "socratic-kb-builder" || skillRaw.version !== "5") {
      coordinateNormalized();
    }
  } catch {
    coordinateNormalized();
  }
  const skillHash = authoritativeCoordinate({
    raw: rawSkillHash,
    expected: expected.skillContentHash,
    parse: (value) => digest(value, "skill.contentHash"),
    label: "skill.contentHash",
    onNormalized: coordinateNormalized,
  });
  const treePolicyVersion = authoritativeCoordinate({
    raw: raw.treePolicyVersion,
    expected: expected.treePolicyVersion,
    parse: (value) => integer(value, "treePolicyVersion", 1),
    label: "treePolicyVersion",
    onNormalized: coordinateNormalized,
  });
  if (treePolicyVersion !== 2) fail("treePolicyVersion 必须为 2");

  let actualCompanyName: string | undefined;
  let actualCompanyWebsite: string | null | undefined;
  try {
    const companyRaw = object(raw.company, "company");
    actualCompanyName = canonicalizeKnowledgeBaseCompanyName(
      string(companyRaw.name, "company.name", 255),
    );
    actualCompanyWebsite = canonicalizeKnowledgeBaseWebsite(
      companyRaw.website === null
        ? null
        : nullableString(companyRaw.website, "company.website"),
    );
  } catch (error) {
    if (
      expected.companyName === undefined ||
      expected.companyWebsite === undefined
    ) {
      if (error instanceof KnowledgeBaseCompanyIdentityNormalizationError) {
        fail(error.message);
      }
      if (error instanceof KnowledgeBaseMaterializedContractError) throw error;
      fail("company 坐标无效");
    }
    coordinateNormalized();
  }
  let expectedCompanyName: string | undefined;
  let expectedCompanyWebsite: string | null | undefined;
  try {
    expectedCompanyName =
      expected.companyName === undefined
        ? undefined
        : canonicalizeKnowledgeBaseCompanyName(expected.companyName);
    expectedCompanyWebsite =
      expected.companyWebsite === undefined
        ? undefined
        : canonicalizeKnowledgeBaseWebsite(expected.companyWebsite);
  } catch (error) {
    if (error instanceof KnowledgeBaseCompanyIdentityNormalizationError) {
      fail(error.message);
    }
    throw error;
  }
  if (
    expectedCompanyName !== undefined &&
    actualCompanyName !== expectedCompanyName
  ) {
    coordinateNormalized();
  }
  if (
    expectedCompanyWebsite !== undefined &&
    actualCompanyWebsite !== expectedCompanyWebsite
  ) {
    coordinateNormalized();
  }
  const company = {
    name: expectedCompanyName ?? actualCompanyName!,
    website:
      expectedCompanyWebsite === undefined
        ? actualCompanyWebsite!
        : expectedCompanyWebsite,
  };
  if (!company.name || company.website === undefined) {
    fail("company 坐标无效");
  }
  let researchCoverage: JsonObject;
  try {
    researchCoverage = object(raw.researchCoverage, "researchCoverage");
  } catch (error) {
    if (!(error instanceof KnowledgeBaseMaterializedContractError)) throw error;
    researchCoverage = {};
    warn({ code: "RESULT_INCOMPLETE", area: "researchCoverage" });
  }
  let droppedOptionalCount = 0;
  const canonicalInputFiles = new Map(files);

  if (!Array.isArray(raw.branches) || !raw.branches.length) {
    fail("branches 不能为空");
  }
  const branches: KnowledgeBaseWorkingSetBranch[] = [];
  for (const [index, item] of raw.branches.entries()) {
    try {
      const branch = object(item, `branches[${index}]`);
      requiredKeys(
        branch,
        ["branchId", "title", "ordinal"],
        `branches[${index}]`,
      );
      if (branch.ordinal !== index) coordinateNormalized();
      branches.push({
        branchId: id(branch.branchId, `branches[${index}].branchId`),
        title: string(branch.title, `branches[${index}].title`, 255),
        ordinal: branches.length,
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedOptionalCount += 1;
      warn({ code: "RESULT_INCOMPLETE", area: "branches" });
    }
  }
  if (!branches.length) fail("Working Set 未保留任何安全分支");
  assertUnique(
    branches.map((branch) => branch.branchId),
    "branchId",
  );
  const branchById = new Map(
    branches.map((branch) => [branch.branchId, branch]),
  );

  if (!Array.isArray(raw.evidenceLedger)) fail("evidenceLedger 必须是数组");
  const rawEvidenceIdentities: Array<{
    index: number;
    value: JsonObject;
    path: string;
  }> = [];
  for (const [index, item] of raw.evidenceLedger.entries()) {
    try {
      const evidence = object(item, `evidenceLedger[${index}]`);
      requiredKeys(
        evidence,
        ["path", "sha256", "leafId", "sourceUrl", "retrievedAt"],
        `evidenceLedger[${index}]`,
      );
      rawEvidenceIdentities.push({
        index,
        value: evidence,
        path: safeArchivePath(evidence.path, `evidenceLedger[${index}].path`),
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedOptionalCount += 1;
      warn({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
    }
  }
  const evidencePathCounts = new Map<string, number>();
  for (const entry of rawEvidenceIdentities) {
    evidencePathCounts.set(
      entry.path,
      (evidencePathCounts.get(entry.path) ?? 0) + 1,
    );
  }
  const conflictedEvidencePaths = new Set(
    [...evidencePathCounts]
      .filter(([, count]) => count > 1)
      .map(([path]) => path),
  );
  const droppedEvidencePaths = new Set<string>(conflictedEvidencePaths);
  if (conflictedEvidencePaths.size) {
    droppedOptionalCount += rawEvidenceIdentities.filter((entry) =>
      conflictedEvidencePaths.has(entry.path),
    ).length;
    warn({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
  }
  const dropEvidence = (
    path: string,
    code: "EVIDENCE_INCOMPLETE" | "OPTIONAL_BINARY_EVIDENCE_SKIPPED",
  ) => {
    if (droppedEvidencePaths.has(path)) return;
    droppedOptionalCount += 1;
    droppedEvidencePaths.add(path);
    warn({ code, area: "evidence" });
  };
  let evidenceLedger: KnowledgeBaseWorkingSetEvidence[] = [];
  for (const entry of rawEvidenceIdentities) {
    // A duplicate declaration is ambiguous even when both declarations happen
    // to carry the same metadata. Drop the complete path conflict group so no
    // array order can decide which optional evidence survives.
    if (conflictedEvidencePaths.has(entry.path)) continue;
    if (!isTextEvidencePath(entry.path)) {
      dropEvidence(entry.path, "OPTIONAL_BINARY_EVIDENCE_SKIPPED");
      continue;
    }
    try {
      const file = actualDeclaredFile({
        files,
        path: entry.path,
        label: `evidenceLedger[${entry.index}]`,
      });
      const decoded = decodeUtf8(file.bytes, `evidenceLedger[${entry.index}]`);
      if (!decoded.trim()) fail("证据文件不得为空");
      evidenceLedger.push({
        path: file.path,
        sha256: file.sha256,
        leafId: id(entry.value.leafId, `evidenceLedger[${entry.index}].leafId`),
        sourceUrl: nullableString(
          entry.value.sourceUrl,
          `evidenceLedger[${entry.index}].sourceUrl`,
        ),
        retrievedAt: nullableString(
          entry.value.retrievedAt,
          `evidenceLedger[${entry.index}].retrievedAt`,
          64,
        ),
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      dropEvidence(entry.path, "EVIDENCE_INCOMPLETE");
    }
  }
  const evidenceByPath = new Map(
    evidenceLedger.map((entry) => [entry.path, entry]),
  );

  if (!Array.isArray(raw.assets) || raw.assets.length > 100) {
    fail("assets 数量无效");
  }
  const rawAssetIdentities: Array<{
    index: number;
    value: unknown;
    assetId: string;
    path: string;
  }> = [];
  for (const [index, value] of raw.assets.entries()) {
    try {
      const asset = object(value, `assets[${index}]`);
      rawAssetIdentities.push({
        index,
        value,
        assetId: id(asset.assetId, `assets[${index}].assetId`),
        path: safeArchivePath(asset.path, `assets[${index}].path`),
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedOptionalCount += 1;
      warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
    }
  }
  const assetIdCounts = new Map<string, number>();
  const assetPathCounts = new Map<string, number>();
  for (const entry of rawAssetIdentities) {
    assetIdCounts.set(
      entry.assetId,
      (assetIdCounts.get(entry.assetId) ?? 0) + 1,
    );
    assetPathCounts.set(entry.path, (assetPathCounts.get(entry.path) ?? 0) + 1);
  }
  const conflictedAssetIndexes = new Set(
    rawAssetIdentities
      .filter(
        (entry) =>
          (assetIdCounts.get(entry.assetId) ?? 0) > 1 ||
          (assetPathCounts.get(entry.path) ?? 0) > 1,
      )
      .map((entry) => entry.index),
  );
  const assets: KnowledgeBaseWorkingSetAsset[] = [];
  const droppedAssetIds = new Set(
    rawAssetIdentities
      .filter((entry) => conflictedAssetIndexes.has(entry.index))
      .map((entry) => entry.assetId),
  );
  if (conflictedAssetIndexes.size) {
    droppedOptionalCount += conflictedAssetIndexes.size;
    warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
  }
  for (const entry of rawAssetIdentities) {
    // Identity/path collisions are optional-component failures. Drop every
    // member of the conflict group instead of choosing by Provider order.
    if (conflictedAssetIndexes.has(entry.index)) continue;
    try {
      assets.push(
        await parseAsset({
          value: entry.value,
          files,
          label: `assets[${entry.index}]`,
          recomputeDerived: true,
          onPresentationNormalized: () => {
            warn({
              code: "PRESENTATION_NORMALIZED",
              area: "assets",
            });
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedAssetIds.add(entry.assetId);
      droppedOptionalCount += 1;
      warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
    }
  }
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));

  if (
    !Array.isArray(raw.leaves) ||
    raw.leaves.length < 1 ||
    raw.leaves.length > 115
  ) {
    fail("Working Set 必须包含 1–115 个安全叶子节点");
  }
  const rawLeafIdentities: Array<{
    index: number;
    value: JsonObject;
    leafId: string;
    contentPath: string;
  }> = [];
  for (const [index, item] of raw.leaves.entries()) {
    try {
      const leaf = object(item, `leaves[${index}]`);
      rawLeafIdentities.push({
        index,
        value: leaf,
        leafId: id(leaf.leafId, `leaves[${index}].leafId`),
        contentPath: safeArchivePath(
          leaf.contentPath,
          `leaves[${index}].contentPath`,
        ),
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedOptionalCount += 1;
      warn({ code: "RESULT_INCOMPLETE", area: "nodes" });
    }
  }
  assertUnique(
    rawLeafIdentities.map((leaf) => leaf.leafId),
    "leafId",
  );
  assertUnique(
    rawLeafIdentities.map((leaf) => leaf.contentPath),
    "contentPath",
  );
  const parsedLeaves: KnowledgeBaseWorkingSetLeaf[] = [];
  for (const entry of rawLeafIdentities) {
    const { index, value: leaf, leafId } = entry;
    try {
      requiredKeys(
        leaf,
        [
          "leafId",
          "branchId",
          "branchTitle",
          "title",
          "ordinal",
          "contentPath",
          "contentSha256",
          "evidencePaths",
          "assetIds",
        ],
        `leaves[${index}]`,
      );
      if (leaf.ordinal !== index) coordinateNormalized();
      const branchId = id(leaf.branchId, `leaves[${index}].branchId`);
      const branch = branchById.get(branchId);
      const branchTitle = string(
        leaf.branchTitle,
        `leaves[${index}].branchTitle`,
        255,
      );
      if (!branch || branch.title !== branchTitle) {
        fail("leaf branch 不存在或标题不一致");
      }
      const title = string(leaf.title, `leaves[${index}].title`, 512);
      const content = actualDeclaredFile({
        files,
        path: entry.contentPath,
        label: `leaves[${index}].content`,
      });
      const decodedContent = decodeUtf8(
        content.bytes,
        `leaves[${index}].content`,
      );
      const projectedContent = projectKnowledgeBaseCustomerMarkdown({
        leafTitle: title,
        markdown: decodedContent,
      });
      canonicalInputFiles.set(
        content.path,
        Buffer.from(projectedContent, "utf8"),
      );
      const declaredEvidencePaths: string[] = [];
      if (Array.isArray(leaf.evidencePaths)) {
        for (const [pathIndex, value] of leaf.evidencePaths.entries()) {
          try {
            const path = safeArchivePath(
              value,
              `leaves[${index}].evidencePaths[${pathIndex}]`,
            );
            if (!declaredEvidencePaths.includes(path)) {
              declaredEvidencePaths.push(path);
            }
          } catch (error) {
            if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
              throw error;
            }
            droppedOptionalCount += 1;
            warn({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
          }
        }
      } else {
        droppedOptionalCount += 1;
        warn({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
      }
      const declaredAssetIds: string[] = [];
      if (Array.isArray(leaf.assetIds)) {
        for (const [assetIndex, value] of leaf.assetIds.entries()) {
          try {
            const assetId = id(
              value,
              `leaves[${index}].assetIds[${assetIndex}]`,
            );
            if (!declaredAssetIds.includes(assetId)) {
              declaredAssetIds.push(assetId);
            }
          } catch (error) {
            if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
              throw error;
            }
            droppedOptionalCount += 1;
            warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
          }
        }
      } else {
        droppedOptionalCount += 1;
        warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
      }
      const evidencePaths = declaredEvidencePaths.filter((path) => {
        const retained = evidenceByPath.get(path)?.leafId === leafId;
        if (!retained) dropEvidence(path, "EVIDENCE_INCOMPLETE");
        return retained;
      });
      const assetIds = declaredAssetIds.filter((assetId) => {
        const retained = assetById.has(assetId);
        if (!retained && !droppedAssetIds.has(assetId)) {
          droppedOptionalCount += 1;
          warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
        }
        return retained;
      });
      let productFamilyId: string | undefined;
      if (leaf.productFamilyId !== undefined) {
        try {
          productFamilyId = id(
            leaf.productFamilyId,
            `leaves[${index}].productFamilyId`,
          );
        } catch (error) {
          if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
            throw error;
          }
          warn({ code: "PRESENTATION_NORMALIZED", area: "nodes" });
        }
      }
      parsedLeaves.push({
        leafId,
        branchId,
        branchTitle,
        title,
        ordinal: parsedLeaves.length,
        contentPath: content.path,
        contentSha256: sha256(Buffer.from(projectedContent, "utf8")),
        evidencePaths,
        assetIds,
        ...(productFamilyId ? { productFamilyId } : {}),
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      droppedOptionalCount += 1;
      warn({ code: "RESULT_INCOMPLETE", area: "nodes" });
    }
  }
  const leaves = parsedLeaves;
  if (!leaves.length) fail("Working Set 未保留任何安全叶子节点");
  const leafIds = new Set(leaves.map((leaf) => leaf.leafId));
  const referencedEvidence = new Set(
    leaves.flatMap((leaf) => leaf.evidencePaths),
  );
  const retainedEvidenceLedger = evidenceLedger.filter(
    (entry) => leafIds.has(entry.leafId) && referencedEvidence.has(entry.path),
  );
  if (retainedEvidenceLedger.length !== evidenceLedger.length) {
    for (const entry of evidenceLedger) {
      if (!retainedEvidenceLedger.includes(entry)) {
        dropEvidence(entry.path, "EVIDENCE_INCOMPLETE");
      }
    }
  }
  evidenceLedger = retainedEvidenceLedger;
  if (
    expected.expectedUploadsRead !== undefined &&
    (!Number.isSafeInteger(expected.expectedUploadsRead) ||
      expected.expectedUploadsRead < 0 ||
      expected.expectedUploadsRead > 100)
  ) {
    fail("客户上传资料计数坐标无效");
  }
  researchCoverage = {
    ...researchCoverage,
    ...(expected.expectedUploadsRead === undefined
      ? {}
      : { uploadsRead: expected.expectedUploadsRead }),
    sourceCount: evidenceLedger.length,
  };
  if (
    expected.expectedUploadsRead !== undefined &&
    (!raw.researchCoverage ||
      typeof raw.researchCoverage !== "object" ||
      Array.isArray(raw.researchCoverage) ||
      (raw.researchCoverage as JsonObject).uploadsRead !==
        expected.expectedUploadsRead)
  ) {
    coordinateNormalized();
  }
  for (const asset of assets) {
    const expectedDocuments = leaves
      .filter((leaf) => leaf.assetIds.includes(asset.assetId))
      .map((leaf) => leaf.leafId)
      .sort();
    asset.documentIds = expectedDocuments;
    if (asset.provenance.sourceKind === "user_upload") {
      asset.assetType = "customer_supplied";
      asset.displayRole = "inline";
    }
  }

  let logo: KnowledgeBaseWorkingSetManifest["logo"] = {
    status: "missing",
    assetId: null,
  };
  try {
    const logoRaw = object(raw.logo, "logo");
    requiredKeys(logoRaw, ["status", "assetId"], "logo");
    if (logoRaw.status === "missing" && logoRaw.assetId === null) {
      logo = { status: "missing", assetId: null };
    } else if (logoRaw.status === "available") {
      const assetId = id(logoRaw.assetId, "logo.assetId");
      logo = assetById.has(assetId)
        ? { status: "available", assetId }
        : { status: "missing", assetId: null };
      const officialLogo = assetById.get(assetId);
      if (officialLogo) {
        officialLogo.assetType = "brand_identity";
        officialLogo.displayRole = "badge";
      }
      if (!assetById.has(assetId) && !droppedAssetIds.has(assetId)) {
        warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "logo" });
        droppedOptionalCount += 1;
      }
    } else {
      fail("Logo 状态无效");
    }
  } catch (error) {
    if (!(error instanceof KnowledgeBaseMaterializedContractError)) throw error;
    warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "logo" });
    droppedOptionalCount += 1;
  }
  const counts = {
    leaves: leaves.length,
    evidenceFiles: evidenceLedger.length,
    assets: assets.length,
  };
  if (
    stableJson(raw.counts) !== stableJson(counts) ||
    files.size !==
      1 +
        rawLeafIdentities.length +
        rawEvidenceIdentities.length +
        rawAssetIdentities.length
  ) {
    coordinateNormalized();
  }
  const manifest: KnowledgeBaseWorkingSetManifest = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId,
    buildId,
    generation,
    contentVersion,
    skill: {
      name: "socratic-kb-builder",
      version: "5",
      contentHash: skillHash,
    },
    treePolicyVersion: treePolicyVersion as 2,
    company,
    researchCoverage,
    branches,
    evidenceLedger,
    leaves,
    assets,
    logo,
    counts,
  };
  const canonical = await canonicalWorkingSetArchive({
    manifest,
    files: canonicalInputFiles,
  });
  if (verifyCanonicalRoundtrip) {
    const roundtrip = await validateKnowledgeBaseWorkingSetArchiveInternal(
      canonical.archiveBytes,
      expected,
      false,
    );
    if (
      stableJson(roundtrip.manifest) !== stableJson(canonical.manifest) ||
      !roundtrip.archiveBytes.equals(canonical.archiveBytes)
    ) {
      fail("canonical Working Set 自校验不一致");
    }
  }
  return {
    ...canonical,
    warnings,
    droppedOptionalCount,
  };
}

export async function validateKnowledgeBaseWorkingSetArchive(
  bytes: Buffer,
  expected: Partial<KnowledgeBaseWorkingSetExpectation> = {},
): Promise<ValidatedKnowledgeBaseWorkingSet> {
  return validateKnowledgeBaseWorkingSetArchiveInternal(bytes, expected, true);
}

function canonicalPresentationSnapshot(input: {
  validated: ValidatedKnowledgeBaseWorkingSet;
  completeness: "complete" | "partial";
}) {
  const snapshot: KnowledgeBaseCanonicalPresentation = {
    kind: "frontmind.kb-canonical-presentation",
    schemaVersion: 1,
    operationId: input.validated.manifest.operationId,
    buildId: input.validated.manifest.buildId,
    generation: input.validated.manifest.generation,
    contentVersion: input.validated.manifest.contentVersion,
    completeness: input.completeness,
    displayEligible: true,
    downstreamEligible: input.completeness === "complete",
    publishable: input.completeness === "complete",
    branches: input.validated.manifest.branches,
    leaves: input.validated.manifest.leaves.map((leaf) => ({
      leafId: leaf.leafId,
      branchId: leaf.branchId,
      title: leaf.title,
      ordinal: leaf.ordinal,
      markdown: decodeUtf8(
        input.validated.files.get(leaf.contentPath)!,
        `canonical presentation ${leaf.leafId}`,
      ),
      assetIds: leaf.assetIds,
    })),
  };
  const roundtrip = JSON.parse(stableJson(snapshot)) as unknown;
  if (stableJson(roundtrip) !== stableJson(snapshot)) {
    fail("canonical presentation 自校验不一致");
  }
  return snapshot;
}

async function salvageInitialWorkingSetAsFlatView(input: {
  archiveBytes: Buffer;
  authority: KnowledgeBaseInitialBundleExpectation;
  provenance: KnowledgeBaseInitialResultProvenance;
}): Promise<ValidatedKnowledgeBaseWorkingSet> {
  const expectedFilename = `frontmind-kb-bundle-${input.authority.operationId}.zip`;
  if (
    !input.provenance.exactBoundTask ||
    !input.provenance.directAssistantOutput ||
    input.provenance.descriptorFilename !== expectedFilename
  ) {
    fail("flat fallback 缺少 exact task/direct assistant/descriptor 归属证明");
  }
  const files = await loadSafeArchive(input.archiveBytes);
  if (files.has("PATCH.json")) fail("flat fallback 不接受 Patch ZIP");
  const jsonEntries = [...files.keys()].filter((path) =>
    path.toLowerCase().endsWith(".json"),
  );
  if (
    jsonEntries.some((path) => path !== "BUNDLE.json") ||
    jsonEntries.length > 1
  ) {
    fail("flat fallback 不接受多个或未知 manifest");
  }
  if (files.has("BUNDLE.json")) {
    try {
      parseJsonFileDetailed(files, "BUNDLE.json");
      fail("可解析 manifest 不允许进入 flat fallback");
    } catch (error) {
      if (
        !(error instanceof KnowledgeBaseMaterializedContractError) ||
        error.category !== "manifest_parse"
      ) {
        throw error;
      }
    }
  } else if (jsonEntries.length) {
    fail("flat fallback manifest 归属不明确");
  }

  const nodeEntries = [...files.entries()]
    .filter(([path]) => path.startsWith("nodes/"))
    .sort(([left], [right]) => left.localeCompare(right));
  if (!nodeEntries.length || nodeEntries.length > 115) {
    fail("flat fallback 必须包含 1–115 个连续节点");
  }
  const canonicalFiles = new Map<string, Buffer>();
  const leaves: KnowledgeBaseWorkingSetLeaf[] = [];
  for (const [index, [path, bytes]] of nodeEntries.entries()) {
    const expectedPath = `nodes/${String(index + 1).padStart(4, "0")}.md`;
    if (path !== expectedPath) {
      fail("flat fallback 节点必须从 nodes/0001.md 连续编号");
    }
    const decoded = canonicalKnowledgeBaseMarkdown(
      decodeUtf8(bytes, `flat fallback ${path}`),
    );
    const title =
      decoded
        .split("\n", 1)[0]
        ?.match(/^#\s+(.+)$/u)?.[1]
        ?.trim() || `已恢复节点 ${index + 1}`;
    const markdown = projectKnowledgeBaseCustomerMarkdown({
      leafTitle: title,
      markdown: decoded,
    });
    const canonicalBytes = Buffer.from(markdown, "utf8");
    canonicalFiles.set(path, canonicalBytes);
    leaves.push({
      leafId: `recovered.${index + 1}`,
      branchId: "recovered_view_only",
      branchTitle: "已恢复内容",
      title,
      ordinal: index,
      contentPath: path,
      contentSha256: sha256(canonicalBytes),
      evidencePaths: [],
      assetIds: [],
    });
  }
  const manifest: KnowledgeBaseWorkingSetManifest = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId: input.authority.operationId,
    buildId: input.authority.buildId,
    generation: input.authority.generation,
    contentVersion: input.authority.contentVersion,
    skill: {
      name: "socratic-kb-builder",
      version: "5",
      contentHash: input.authority.skillContentHash,
    },
    treePolicyVersion: 2,
    company: {
      name: canonicalizeKnowledgeBaseCompanyName(input.authority.companyName),
      website: canonicalizeKnowledgeBaseWebsite(input.authority.companyWebsite),
    },
    researchCoverage: {
      uploadsRead: input.authority.expectedUploadsRead,
      sourceCount: 0,
      recoveryMode: "flat_view_only",
    },
    branches: [
      { branchId: "recovered_view_only", title: "已恢复内容", ordinal: 0 },
    ],
    evidenceLedger: [],
    leaves,
    assets: [],
    logo: { status: "missing", assetId: null },
    counts: { leaves: leaves.length, evidenceFiles: 0, assets: 0 },
  };
  const canonical = await canonicalWorkingSetArchive({
    manifest,
    files: canonicalFiles,
  });
  const revalidated = await validateKnowledgeBaseWorkingSetArchiveInternal(
    canonical.archiveBytes,
    input.authority,
    true,
  );
  const ignoredCount = [...files.keys()].filter(
    (path) => path !== "BUNDLE.json" && !path.startsWith("nodes/"),
  ).length;
  return {
    ...revalidated,
    warnings: [
      { code: "MANIFEST_NORMALIZED", area: "manifest" },
      { code: "RESULT_INCOMPLETE", area: "nodes" },
    ],
    droppedOptionalCount: ignoredCount,
  };
}

function resultStageForContractError(
  error: KnowledgeBaseMaterializedContractError,
): KnowledgeBaseResultProcessingStage {
  if (error.category === "manifest_parse") return "manifest_parse";
  if (/ZIP|路径|符号链接|压缩|文件名|archive/iu.test(error.message)) {
    return "archive_safety";
  }
  if (/canonical|自校验/iu.test(error.message)) {
    return "canonical_validation";
  }
  return "component_projection";
}

/**
 * Total data boundary for one fresh initial Provider result. Ordinary parser,
 * ZIP, image and serialization failures become a stable rejected outcome;
 * process-level failures such as OOM remain outside this JavaScript boundary.
 */
export async function normalizeMaterializedKnowledgeBaseResult(
  input:
    | {
        mode: "initial";
        archiveBytes: Buffer;
        authority: KnowledgeBaseInitialBundleExpectation;
        provenance: KnowledgeBaseInitialResultProvenance;
      }
    | {
        mode: "patch";
        archiveBytes: Buffer;
        authority: Required<
          Omit<KnowledgeBaseNodePatchExpectation, "attachmentSourceProofs">
        > & {
          attachmentSourceProofs: readonly KnowledgeBasePatchAttachmentSourceProof[];
        };
        provenance: KnowledgeBasePatchResultProvenance;
        base: ValidatedKnowledgeBaseWorkingSet;
      },
): Promise<KnowledgeBaseNormalizationOutcome> {
  if (input.mode === "patch") {
    return normalizeMaterializedKnowledgeBasePatchResult(input);
  }
  try {
    let validated: ValidatedKnowledgeBaseWorkingSet;
    try {
      validated = await validateKnowledgeBaseWorkingSetArchive(
        input.archiveBytes,
        input.authority,
      );
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        return {
          kind: "rejected",
          code: "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
          stage: "canonical_validation",
          resetRequired: true,
        };
      }
      try {
        validated = await salvageInitialWorkingSetAsFlatView(input);
      } catch (fallbackError) {
        return {
          kind: "rejected",
          code:
            fallbackError instanceof KnowledgeBaseMaterializedContractError
              ? "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID"
              : "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
          stage: resultStageForContractError(error),
          resetRequired: true,
        };
      }
    }
    // Optional evidence/assets, deterministic manifest repair and server-owned
    // coordinate rewrites are diagnostics, not missing customer content. Only
    // a real node projection loss (including the explicit flat view fallback)
    // or an initial set below the deep-knowledge body floor is display-only.
    const droppedBody = validated.warnings.some(
      (warning) =>
        warning.code === "RESULT_INCOMPLETE" && warning.area === "nodes",
    );
    const retainedBodyComplete =
      validated.manifest.leaves.length >= 30 &&
      validated.manifest.leaves.length <= 115;
    const completeness =
      droppedBody || !retainedBodyComplete ? "partial" : "complete";
    const renderSnapshot = canonicalPresentationSnapshot({
      validated,
      completeness,
    });
    return {
      kind: "accepted",
      mode: "initial",
      completeness,
      canonicalArchiveBytes: validated.archiveBytes,
      manifest: validated.manifest,
      renderSnapshot,
      diagnostics: validated.warnings,
      packageSha256: validated.packageSha256,
      manifestSha256: validated.manifestSha256,
      workingSet: validated,
    };
  } catch (error) {
    return {
      kind: "rejected",
      code:
        error instanceof KnowledgeBaseMaterializedContractError
          ? "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID"
          : "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
      stage: "presentation",
      resetRequired: true,
    };
  }
}

export type KnowledgeBaseNodePatchExpectation = {
  operationId?: string;
  buildId?: string;
  generation?: number;
  baseContentVersion?: number;
  baseWorkingSetSha256?: string;
  targetLeafId?: string;
  attachmentSourceProofs?: readonly KnowledgeBasePatchAttachmentSourceProof[];
};

function normalizedMediaType(value: unknown) {
  return typeof value === "string"
    ? value.split(";", 1)[0]!.trim().toLowerCase()
    : "";
}

function imageExtension(mimeType: KnowledgeBaseWorkingSetAsset["mimeType"]) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
}

function normalizedAttachmentSourceProofs(
  proofs: KnowledgeBaseNodePatchExpectation["attachmentSourceProofs"],
) {
  if (!proofs) return [];
  const normalized = proofs.map((proof, proofIndex) => {
    const index = integer(
      proof.index,
      `attachmentSourceProofs[${proofIndex}].index`,
    );
    const contentSha256 = digest(
      proof.contentSha256,
      `attachmentSourceProofs[${proofIndex}].contentSha256`,
    );
    const sizeBytes = integer(
      proof.sizeBytes,
      `attachmentSourceProofs[${proofIndex}].sizeBytes`,
      1,
    );
    const mimeType = normalizedMediaType(proof.mimeType);
    if (!mimeType) fail("attachmentSourceProofs MIME 无效");
    return { index, contentSha256, sizeBytes, mimeType };
  });
  assertUnique(
    normalized.map((proof) => String(proof.index)),
    "attachmentSourceProofs.index",
  );
  return normalized;
}

function rawAssetClaimsFrozenUpload(value: JsonObject) {
  const provenance =
    value.provenance &&
    typeof value.provenance === "object" &&
    !Array.isArray(value.provenance)
      ? (value.provenance as JsonObject)
      : {};
  return (
    value.assetType === "customer_supplied" ||
    provenance.sourceKind === "user_upload" ||
    provenance.originalUploadSha256 !== undefined ||
    provenance.sourceUploadSha256 !== undefined
  );
}

function assertFrozenUploadClaimsMatch(input: {
  raw: JsonObject;
  asset: KnowledgeBaseWorkingSetAsset;
  proof: ReturnType<typeof normalizedAttachmentSourceProofs>[number];
}) {
  const provenance = object(input.raw.provenance, "asset.provenance");
  for (const claimed of [
    provenance.originalUploadSha256,
    provenance.sourceUploadSha256,
  ]) {
    if (claimed !== undefined && claimed !== input.proof.contentSha256) {
      fail(
        "Patch frozen upload 哈希声明与 Dashboard 证明不一致",
        "frozen_source_conflict",
      );
    }
  }
  if (
    input.asset.sha256 !== input.proof.contentSha256 ||
    input.asset.bytes !== input.proof.sizeBytes ||
    normalizedMediaType(input.asset.mimeType) !== input.proof.mimeType
  ) {
    fail(
      "Patch frozen upload 的字节、MIME 或哈希与 Dashboard 证明不一致",
      "frozen_source_conflict",
    );
  }
}

function canonicalFrozenUploadAsset(input: {
  operationId: string;
  targetLeafId: string;
  asset: KnowledgeBaseWorkingSetAsset;
  proof: ReturnType<typeof normalizedAttachmentSourceProofs>[number];
}) {
  const stableIdentity = sha256(
    `frontmind.kb-patch-asset.v1\0${input.operationId}\0${input.proof.contentSha256}`,
  ).slice(0, 32);
  return {
    ...input.asset,
    assetId: `asset-${stableIdentity}`,
    path: `assets/${input.targetLeafId}/${stableIdentity}.${imageExtension(input.asset.mimeType)}`,
    provenance: {
      sourceKind: "user_upload",
      ownership: "first_party",
      sourceUploadIndex: input.proof.index,
      sourceUploadMimeType: input.asset.mimeType,
      sourceUploadSizeBytes: input.asset.bytes,
      sourceUploadSha256: input.asset.sha256,
    },
    documentIds: [input.targetLeafId],
    assetType: "customer_supplied",
    displayRole: "inline",
  } satisfies KnowledgeBaseWorkingSetAsset;
}

async function validateKnowledgeBaseNodePatchArchiveInternal(
  bytes: Buffer,
  expected: KnowledgeBaseNodePatchExpectation,
  verifyCanonicalRoundtrip: boolean,
): Promise<ValidatedKnowledgeBaseNodePatch> {
  const files = await loadSafeArchive(bytes);
  if (!files.has("PATCH.json") || files.has("BUNDLE.json")) {
    fail("Revision 必须且只能包含 PATCH.json 合同", "manifest_parse");
  }
  const parsedEnvelope = parseJsonFileDetailed(files, "PATCH.json");
  const raw = parsedEnvelope.value;
  const warnings: ValidatedKnowledgeBaseNodePatch["warnings"] = [];
  const warningKeys = new Set<string>();
  const droppedComponents = {
    evidence: 0,
    assets: 0,
    presentationFields: 0,
  };
  const warn = (
    warning: ValidatedKnowledgeBaseNodePatch["warnings"][number],
  ) => {
    const key = `${warning.code}:${warning.area}`;
    if (!warningKeys.has(key) && warnings.length < PATCH_WARNING_LIMIT) {
      warnings.push(warning);
    }
    warningKeys.add(key);
  };
  if (parsedEnvelope.normalizations.length) {
    warn({ code: "MANIFEST_NORMALIZED", area: "manifest" });
  }
  exactKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "operationId",
      "buildId",
      "generation",
      "baseContentVersion",
      "baseWorkingSetSha256",
      "targetLeafId",
      "contentPath",
      "contentSha256",
      "evidence",
      "assets",
    ],
    "PATCH.json",
  );
  if (raw.kind !== "frontmind.kb-node-patch" || raw.schemaVersion !== 1) {
    fail("Patch 合同版本无效");
  }
  const operationId = string(raw.operationId, "operationId", 128);
  const coordinateNormalized = () =>
    warn({ code: "SERVER_COORDINATE_NORMALIZED", area: "manifest" });
  const buildId = authoritativeCoordinate({
    raw: raw.buildId,
    expected: expected.buildId,
    parse: (value) => string(value, "buildId", 36),
    label: "buildId",
    onNormalized: coordinateNormalized,
  });
  const generation = authoritativeCoordinate({
    raw: raw.generation,
    expected: expected.generation,
    parse: (value) => integer(value, "generation", 1),
    label: "generation",
    onNormalized: coordinateNormalized,
  });
  const baseContentVersion = authoritativeCoordinate({
    raw: raw.baseContentVersion,
    expected: expected.baseContentVersion,
    parse: (value) => integer(value, "baseContentVersion", 1),
    label: "baseContentVersion",
    onNormalized: coordinateNormalized,
  });
  const baseWorkingSetSha256 = digest(
    raw.baseWorkingSetSha256,
    "baseWorkingSetSha256",
  );
  const targetLeafId = id(raw.targetLeafId, "targetLeafId");
  assertExpected(operationId, expected.operationId, "operationId");
  assertExpected(
    baseWorkingSetSha256,
    expected.baseWorkingSetSha256,
    "baseWorkingSetSha256",
  );
  assertExpected(targetLeafId, expected.targetLeafId, "targetLeafId");
  const sourceProofs = normalizedAttachmentSourceProofs(
    expected.attachmentSourceProofs,
  );
  const contentPath = safeArchivePath(raw.contentPath, "patch.content.path");
  let contentStatus: "valid" | "invalid" = "valid";
  let content = {
    path: contentPath,
    sha256: files.has(contentPath)
      ? sha256(files.get(contentPath)!)
      : "0".repeat(64),
  };
  try {
    const declaredContent = declaredFile({
      files,
      path: contentPath,
      expectedSha256: raw.contentSha256,
      label: "patch.content",
    });
    const decoded = decodeUtf8(declaredContent.bytes, "Patch 正文");
    if (!canonicalKnowledgeBaseMarkdown(decoded)) fail("Patch 正文不得为空");
    content = {
      path: declaredContent.path,
      sha256: declaredContent.sha256,
    };
  } catch (error) {
    if (!(error instanceof KnowledgeBaseMaterializedContractError)) throw error;
    contentStatus = "invalid";
    content = { path: contentPath, sha256: "0".repeat(64) };
    warn({ code: "RESULT_INCOMPLETE", area: "content" });
  }

  const evidenceRaw = object(raw.evidence, "evidence");
  exactKeys(evidenceRaw, ["add", "remove"], "evidence");
  if (!Array.isArray(evidenceRaw.add)) fail("evidence.add 必须是数组");
  const evidenceInputs = evidenceRaw.add.map((item, index) => {
    const row = object(item, `evidence.add[${index}]`);
    exactKeys(row, ["path", "sha256"], `evidence.add[${index}]`);
    const path = safeArchivePath(row.path, `evidence.add[${index}].path`);
    if (!path.startsWith(`evidence/${targetLeafId}/`)) {
      fail("Patch 证据必须属于目标节点");
    }
    return { index, path, sha256: row.sha256 };
  });
  const evidenceRemove = stringArray(
    evidenceRaw.remove,
    "evidence.remove",
    safeArchivePath,
  );
  assertUnique(
    evidenceInputs.map((entry) => entry.path),
    "evidence.add.path",
  );
  assertUnique(evidenceRemove, "evidence.remove");
  let evidenceStatus: "valid" | "invalid" = "valid";
  const parsedEvidenceAdd: Array<{ path: string; sha256: string }> = [];
  for (const entry of evidenceInputs) {
    if (!isTextEvidencePath(entry.path)) {
      evidenceStatus = "invalid";
      droppedComponents.evidence += 1;
      warn({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
      continue;
    }
    try {
      const file = declaredFile({
        files,
        path: entry.path,
        expectedSha256: entry.sha256,
        label: `evidence.add[${entry.index}]`,
      });
      const decoded = decodeUtf8(file.bytes, `evidence.add[${entry.index}]`);
      if (!decoded.trim()) fail("Patch 证据不得为空");
      parsedEvidenceAdd.push({ path: file.path, sha256: file.sha256 });
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      evidenceStatus = "invalid";
      droppedComponents.evidence += 1;
      warn({ code: "EVIDENCE_INCOMPLETE", area: "evidence" });
    }
  }
  const evidenceAdd = parsedEvidenceAdd;

  const assetsRaw = object(raw.assets, "assets");
  exactKeys(assetsRaw, ["add", "remove"], "assets");
  if (!Array.isArray(assetsRaw.add)) fail("assets.add 必须是数组");
  const assetInputs = assetsRaw.add.map((value, index) => {
    const asset = object(value, `assets.add[${index}]`);
    requiredKeys(asset, REQUIRED_ASSET_KEYS, `assets.add[${index}]`);
    const assetId = id(asset.assetId, `assets.add[${index}].assetId`);
    const path = safeArchivePath(asset.path, `assets.add[${index}].path`);
    const documentIds = stringArray(
      asset.documentIds,
      `assets.add[${index}].documentIds`,
      id,
    );
    if (documentIds.length !== 1 || documentIds[0] !== targetLeafId) {
      fail("Patch 新资产只能绑定目标节点");
    }
    return { index, value, assetId, path };
  });
  assertUnique(
    assetInputs.map((asset) => asset.assetId),
    "assets.add.assetId",
  );
  assertUnique(
    assetInputs.map((asset) => asset.path),
    "assets.add.path",
  );
  const assetsRemove = stringArray(assetsRaw.remove, "assets.remove", id);
  assertUnique(assetsRemove, "assets.remove");
  if (
    assetInputs.some((asset) => assetsRemove.includes(asset.assetId)) ||
    evidenceInputs.some((entry) => evidenceRemove.includes(entry.path))
  ) {
    fail("Patch 同一组件不得同时新增和删除");
  }
  let assetsStatus: "valid" | "invalid" = "valid";
  const parsedAssetsAdd: KnowledgeBaseWorkingSetAsset[] = [];
  const canonicalFiles = new Map(files);
  for (const entry of assetInputs) {
    const rawAsset = object(entry.value, `assets.add[${entry.index}]`);
    const claimsFrozen = rawAssetClaimsFrozenUpload(rawAsset);
    const rawAssetBytes = files.get(entry.path);
    const detectedMimeType = rawAssetBytes
      ? imageMimeTypeFromBytes(rawAssetBytes)
      : null;
    const matchingProofs = rawAssetBytes
      ? sourceProofs.filter(
          (proof) =>
            proof.contentSha256 === sha256(rawAssetBytes) &&
            proof.sizeBytes === rawAssetBytes.length &&
            proof.mimeType === detectedMimeType,
        )
      : [];
    if (matchingProofs.length > 1) {
      fail("Patch 图片对应多个 frozen upload 证明", "frozen_source_conflict");
    }
    if (claimsFrozen && matchingProofs.length !== 1) {
      fail(
        "Patch 声称使用 frozen upload，但无法绑定 Dashboard 证明",
        "frozen_source_conflict",
      );
    }
    const proof = matchingProofs[0];
    try {
      if (
        proof &&
        (digest(rawAsset.sha256, `assets.add[${entry.index}].sha256`) !==
          proof.contentSha256 ||
          integer(rawAsset.bytes, `assets.add[${entry.index}].bytes`, 1) !==
            proof.sizeBytes ||
          normalizedMediaType(
            string(
              rawAsset.mimeType,
              `assets.add[${entry.index}].mimeType`,
              64,
            ),
          ) !== proof.mimeType)
      ) {
        fail(
          "Patch frozen upload 的字节、MIME 或哈希声明不一致",
          "frozen_source_conflict",
        );
      }
      const parsedAsset = await parseAsset({
        value: entry.value,
        files,
        label: `assets.add[${entry.index}]`,
        // Frozen browser bytes are the authority for derived dimensions and
        // encoding metadata. Provider presentation declarations cannot turn
        // those already-proven bytes into an optional invalid component.
        recomputeDerived: Boolean(proof),
        onPresentationNormalized: (count) => {
          droppedComponents.presentationFields += count;
          warn({ code: "PRESENTATION_NORMALIZED", area: "assets" });
        },
      });
      const canonicalAsset = proof
        ? (() => {
            assertFrozenUploadClaimsMatch({
              raw: rawAsset,
              asset: parsedAsset,
              proof,
            });
            return canonicalFrozenUploadAsset({
              operationId,
              targetLeafId,
              asset: parsedAsset,
              proof,
            });
          })()
        : parsedAsset;
      const assetBytes = rawAssetBytes!;
      canonicalFiles.set(canonicalAsset.path, assetBytes);
      parsedAssetsAdd.push(canonicalAsset);
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
      if (
        claimsFrozen ||
        proof ||
        error.category === "frozen_source_conflict"
      ) {
        throw error.category === "frozen_source_conflict"
          ? error
          : new KnowledgeBaseMaterializedContractError(
              "Patch frozen upload 图片未通过字节校验",
              "frozen_source_conflict",
            );
      }
      assetsStatus = "invalid";
      droppedComponents.assets += 1;
      warn({ code: "OPTIONAL_ASSET_SKIPPED", area: "assets" });
    }
  }
  const assetsAdd = parsedAssetsAdd;
  assertUnique(
    assetsAdd.map((asset) => asset.assetId),
    "canonical assets.add.assetId",
  );
  assertUnique(
    assetsAdd.map((asset) => asset.path),
    "canonical assets.add.path",
  );

  const declared = new Set(
    [
      "PATCH.json",
      contentPath,
      ...evidenceInputs.map((entry) => entry.path),
      ...assetInputs.map((asset) => asset.path),
    ].filter((path) => files.has(path)),
  );
  if (
    declared.size !== files.size ||
    [...files.keys()].some((path) => !declared.has(path))
  ) {
    fail("Patch ZIP 包含未登记文件或重复文件引用");
  }
  if (contentStatus === "valid") {
    const markdown = canonicalKnowledgeBaseMarkdown(
      decodeUtf8(files.get(contentPath)!, "Patch 正文"),
    );
    const canonicalContent = Buffer.from(markdown, "utf8");
    canonicalFiles.set(contentPath, canonicalContent);
    content = { path: contentPath, sha256: sha256(canonicalContent) };
  } else {
    canonicalFiles.delete(contentPath);
  }
  const manifest: KnowledgeBaseNodePatchManifest = {
    kind: "frontmind.kb-node-patch",
    schemaVersion: 1,
    operationId,
    buildId,
    generation,
    baseContentVersion,
    baseWorkingSetSha256,
    targetLeafId,
    contentPath: content.path,
    contentSha256: content.sha256,
    evidence: { add: evidenceAdd, remove: evidenceRemove },
    assets: { add: assetsAdd, remove: assetsRemove },
  };
  const canonical = await canonicalPatchArchive({
    manifest,
    files: canonicalFiles,
  });
  const result: ValidatedKnowledgeBaseNodePatch = {
    manifest,
    ...canonical,
    components: {
      content: contentStatus,
      evidence: evidenceStatus,
      assets: assetsStatus,
    },
    warnings,
    droppedComponents,
  };
  if (verifyCanonicalRoundtrip) {
    const roundtrip = await validateKnowledgeBaseNodePatchArchiveInternal(
      canonical.archiveBytes,
      expected,
      false,
    );
    if (
      stableJson(roundtrip.manifest) !== stableJson(manifest) ||
      !roundtrip.archiveBytes.equals(canonical.archiveBytes)
    ) {
      fail("canonical Patch 自校验不一致");
    }
  }
  return result;
}

export async function validateKnowledgeBaseNodePatchArchive(
  bytes: Buffer,
  expected: KnowledgeBaseNodePatchExpectation = {},
): Promise<ValidatedKnowledgeBaseNodePatch> {
  return validateKnowledgeBaseNodePatchArchiveInternal(bytes, expected, true);
}

/**
 * Rebuild the narrowest possible Patch after the caller has locked the active
 * build, Working Set and current revise turn. This function has no discovery
 * behavior: it accepts exactly one expected node and only image bytes that
 * bind one-to-one to the supplied Dashboard-frozen attachment proofs.
 */
export async function salvageKnowledgeBaseNodePatchArchive(input: {
  bytes: Buffer;
  expected: Required<
    Omit<KnowledgeBaseNodePatchExpectation, "attachmentSourceProofs">
  > & {
    attachmentSourceProofs: readonly KnowledgeBasePatchAttachmentSourceProof[];
  };
  dbAuthorityLocked: true;
}): Promise<ValidatedKnowledgeBaseNodePatch> {
  void input.dbAuthorityLocked;
  const files = await loadSafeArchive(input.bytes);
  if (files.has("BUNDLE.json")) {
    fail("salvage 不接受 initial Working Set");
  }
  const jsonEntries = [...files.keys()].filter((path) =>
    path.toLowerCase().endsWith(".json"),
  );
  if (
    jsonEntries.some((path) => path !== "PATCH.json") ||
    jsonEntries.length > 1
  ) {
    fail("salvage 不接受多个或未知 manifest");
  }
  if (files.has("PATCH.json")) {
    try {
      parseJsonFileDetailed(files, "PATCH.json");
      fail("可解析 manifest 不允许进入 salvage");
    } catch (error) {
      if (!isKnowledgeBasePatchManifestParseError(error)) throw error;
    }
  }

  const operationId = string(input.expected.operationId, "operationId", 128);
  const buildId = string(input.expected.buildId, "buildId", 36);
  const generation = integer(input.expected.generation, "generation", 1);
  const baseContentVersion = integer(
    input.expected.baseContentVersion,
    "baseContentVersion",
    1,
  );
  const baseWorkingSetSha256 = digest(
    input.expected.baseWorkingSetSha256,
    "baseWorkingSetSha256",
  );
  const targetLeafId = id(input.expected.targetLeafId, "targetLeafId");
  const proofs = normalizedAttachmentSourceProofs(
    input.expected.attachmentSourceProofs,
  );
  const nodePath = `node/${targetLeafId}.md`;
  const nodeEntries = [...files.keys()].filter((path) =>
    path.startsWith("node/"),
  );
  if (nodeEntries.length !== 1 || nodeEntries[0] !== nodePath) {
    fail("salvage 必须且只能包含当前目标节点正文");
  }
  const contentBytes = files.get(nodePath)!;
  const decoded = decodeUtf8(contentBytes, "salvage 节点正文");
  const markdown = canonicalKnowledgeBaseMarkdown(decoded);
  if (!markdown) fail("salvage 节点正文为空");

  const canonicalFiles = new Map<string, Buffer>();
  const canonicalContent = Buffer.from(markdown, "utf8");
  canonicalFiles.set(nodePath, canonicalContent);
  const assets: KnowledgeBaseWorkingSetAsset[] = [];
  const consumedProofIndexes = new Set<number>();
  const otherEntries = [...files.entries()].filter(
    ([path]) => path !== "PATCH.json" && path !== nodePath,
  );
  for (const [rawPath, assetBytes] of otherEntries) {
    if (!rawPath.startsWith(`assets/${targetLeafId}/`)) {
      fail("salvage 额外图片必须位于当前目标节点资产目录");
    }
    const mimeType = imageMimeTypeFromBytes(assetBytes);
    if (
      !mimeType ||
      !assetBytes.length ||
      assetBytes.length > MAX_ASSET_BYTES
    ) {
      fail("salvage ZIP 包含未知或不可安全解码的额外文件");
    }
    const assetSha256 = sha256(assetBytes);
    const matches = proofs.filter(
      (proof) =>
        proof.contentSha256 === assetSha256 &&
        proof.sizeBytes === assetBytes.length &&
        proof.mimeType === mimeType,
    );
    if (matches.length !== 1 || consumedProofIndexes.has(matches[0]!.index)) {
      fail(
        "salvage 图片无法与 frozen upload 一一绑定",
        "frozen_source_conflict",
      );
    }
    let metadata: { width?: number; height?: number };
    try {
      const image = sharp(assetBytes, {
        animated: false,
        failOn: "warning",
        limitInputPixels: 40_000_000,
      });
      metadata = await image.metadata();
      await image.stats();
    } catch {
      fail("salvage 图片无法安全解码", "frozen_source_conflict");
    }
    const proof = matches[0]!;
    consumedProofIndexes.add(proof.index);
    const rawAsset: KnowledgeBaseWorkingSetAsset = {
      assetId: `salvage-${assets.length + 1}`,
      path: rawPath,
      sha256: assetSha256,
      mimeType,
      bytes: assetBytes.length,
      width: integer(metadata.width, "salvage asset width", 1),
      height: integer(metadata.height, "salvage asset height", 1),
      provenance: {},
      documentIds: [targetLeafId],
    };
    const asset = canonicalFrozenUploadAsset({
      operationId,
      targetLeafId,
      asset: rawAsset,
      proof,
    });
    canonicalFiles.set(asset.path, assetBytes);
    assets.push(asset);
  }
  assertUnique(
    assets.map((asset) => asset.assetId),
    "salvage assetId",
  );
  assertUnique(
    assets.map((asset) => asset.path),
    "salvage asset.path",
  );
  const manifest: KnowledgeBaseNodePatchManifest = {
    kind: "frontmind.kb-node-patch",
    schemaVersion: 1,
    operationId,
    buildId,
    generation,
    baseContentVersion,
    baseWorkingSetSha256,
    targetLeafId,
    contentPath: nodePath,
    contentSha256: sha256(canonicalContent),
    evidence: { add: [], remove: [] },
    assets: { add: assets, remove: [] },
  };
  const canonical = await canonicalPatchArchive({
    manifest,
    files: canonicalFiles,
  });
  const validated = await validateKnowledgeBaseNodePatchArchiveInternal(
    canonical.archiveBytes,
    input.expected,
    true,
  );
  return {
    ...validated,
    warnings: (
      [
        { code: "MANIFEST_NORMALIZED", area: "manifest" },
        ...validated.warnings,
      ] satisfies ValidatedKnowledgeBaseNodePatch["warnings"]
    ).slice(0, PATCH_WARNING_LIMIT),
  };
}

function assertPatchBaseAuthority(input: {
  base: ValidatedKnowledgeBaseWorkingSet;
  authority: Required<
    Omit<KnowledgeBaseNodePatchExpectation, "attachmentSourceProofs">
  >;
}) {
  const target = input.base.manifest.leaves.find(
    (leaf) => leaf.leafId === input.authority.targetLeafId,
  );
  if (
    input.base.manifest.buildId !== input.authority.buildId ||
    input.base.manifest.generation !== input.authority.generation ||
    input.base.manifest.contentVersion !== input.authority.baseContentVersion ||
    input.base.packageSha256 !== input.authority.baseWorkingSetSha256 ||
    !target
  ) {
    fail("Patch frozen base/target authority 不一致");
  }
}

function assertPatchRemovalOwnership(input: {
  base: KnowledgeBaseWorkingSetManifest;
  patch: KnowledgeBaseNodePatchManifest;
}) {
  const targetLeaf = input.base.leaves.find(
    (leaf) => leaf.leafId === input.patch.targetLeafId,
  );
  if (!targetLeaf) fail("Patch 目标节点不存在");
  const targetEvidencePaths = new Set(targetLeaf.evidencePaths);
  const targetAssetIds = new Set(targetLeaf.assetIds);
  const evidenceByPath = new Map(
    input.base.evidenceLedger.map((entry) => [entry.path, entry]),
  );
  const assetById = new Map(
    input.base.assets.map((asset) => [asset.assetId, asset]),
  );
  if (
    input.patch.evidence.remove.some((path) => {
      const evidence = evidenceByPath.get(path);
      return (
        !targetEvidencePaths.has(path) ||
        !evidence ||
        evidence.leafId !== input.patch.targetLeafId
      );
    }) ||
    input.patch.assets.remove.some((assetId) => {
      const asset = assetById.get(assetId);
      return (
        !targetAssetIds.has(assetId) ||
        !asset ||
        asset.documentIds.length !== 1 ||
        asset.documentIds[0] !== input.patch.targetLeafId
      );
    })
  ) {
    fail("Patch 试图删除不属于目标节点的证据或资产");
  }
}

function patchedEvidenceLedger(input: {
  manifest: KnowledgeBaseWorkingSetManifest;
  patch: KnowledgeBaseNodePatchManifest;
}) {
  const remove = new Set(input.patch.evidence.remove);
  return [
    ...input.manifest.evidenceLedger.filter((entry) => !remove.has(entry.path)),
    ...input.patch.evidence.add.map((entry) => ({
      ...entry,
      leafId: input.patch.targetLeafId,
      sourceUrl: null,
      retrievedAt: null,
    })),
  ];
}

async function composeNormalizedKnowledgeBasePatch(input: {
  base: ValidatedKnowledgeBaseWorkingSet;
  patch: ValidatedKnowledgeBaseNodePatch;
}) {
  assertPatchRemovalOwnership({
    base: input.base.manifest,
    patch: input.patch.manifest,
  });
  const targetLeafId = input.patch.manifest.targetLeafId;
  const previousLeaf = input.base.manifest.leaves.find(
    (leaf) => leaf.leafId === targetLeafId,
  )!;
  const previousContentBytes = input.base.files.get(previousLeaf.contentPath)!;
  let contentBytes = previousContentBytes;
  let contentChanged = false;
  if (input.patch.components.content === "valid") {
    try {
      const projected = projectKnowledgeBaseCustomerMarkdown({
        leafTitle: previousLeaf.title,
        markdown: decodeUtf8(
          input.patch.files.get(input.patch.manifest.contentPath)!,
          "Patch 正文",
        ),
      });
      contentBytes = Buffer.from(projected, "utf8");
      contentChanged = !contentBytes.equals(previousContentBytes);
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        throw error;
      }
    }
  }
  const evidencePatch =
    input.patch.components.evidence === "valid"
      ? input.patch.manifest.evidence
      : { add: input.patch.manifest.evidence.add, remove: [] };
  const assetPatch =
    input.patch.components.assets === "valid"
      ? input.patch.manifest.assets
      : { add: input.patch.manifest.assets.add, remove: [] };
  const removedEvidence = new Set(evidencePatch.remove);
  const removedAssets = new Set(assetPatch.remove);
  const changed =
    contentChanged ||
    evidencePatch.add.length > 0 ||
    evidencePatch.remove.length > 0 ||
    assetPatch.add.length > 0 ||
    assetPatch.remove.length > 0;
  if (!changed) return { changed: false as const, validated: input.base };

  const effectivePatch: KnowledgeBaseNodePatchManifest = {
    ...input.patch.manifest,
    evidence: evidencePatch,
    assets: assetPatch,
  };
  const evidenceLedger = patchedEvidenceLedger({
    manifest: input.base.manifest,
    patch: effectivePatch,
  });
  const assets = [
    ...input.base.manifest.assets.filter(
      (asset) => !removedAssets.has(asset.assetId),
    ),
    ...assetPatch.add,
  ];
  assertUnique(
    assets.map((asset) => asset.assetId),
    "Patch canonical assetId",
  );
  assertUnique(
    assets.map((asset) => asset.path),
    "Patch canonical asset path",
  );
  const addedEvidencePaths = evidencePatch.add.map((entry) => entry.path);
  const addedAssetIds = assetPatch.add.map((asset) => asset.assetId);
  const leaves = input.base.manifest.leaves.map((leaf) =>
    leaf.leafId === targetLeafId
      ? {
          ...leaf,
          contentSha256: sha256(contentBytes),
          evidencePaths: [
            ...leaf.evidencePaths.filter((path) => !removedEvidence.has(path)),
            ...addedEvidencePaths,
          ],
          assetIds: [
            ...leaf.assetIds.filter((assetId) => !removedAssets.has(assetId)),
            ...addedAssetIds,
          ],
        }
      : leaf,
  );
  const manifest: KnowledgeBaseWorkingSetManifest = {
    ...input.base.manifest,
    operationId: input.patch.manifest.operationId,
    contentVersion: input.base.manifest.contentVersion + 1,
    evidenceLedger,
    leaves,
    assets,
    logo:
      input.base.manifest.logo.status === "available" &&
      removedAssets.has(input.base.manifest.logo.assetId)
        ? { status: "missing", assetId: null }
        : input.base.manifest.logo,
    counts: {
      leaves: leaves.length,
      evidenceFiles: evidenceLedger.length,
      assets: assets.length,
    },
  };
  const files = new Map(input.base.files);
  files.delete("BUNDLE.json");
  files.set(previousLeaf.contentPath, contentBytes);
  for (const path of removedEvidence) files.delete(path);
  for (const asset of input.base.manifest.assets) {
    if (removedAssets.has(asset.assetId)) files.delete(asset.path);
  }
  for (const evidence of evidencePatch.add) {
    files.set(evidence.path, input.patch.files.get(evidence.path)!);
  }
  for (const asset of assetPatch.add) {
    files.set(asset.path, input.patch.files.get(asset.path)!);
  }
  const canonical = await canonicalWorkingSetArchive({ manifest, files });
  const validated = await validateKnowledgeBaseWorkingSetArchiveInternal(
    canonical.archiveBytes,
    {
      operationId: manifest.operationId,
      buildId: manifest.buildId,
      generation: manifest.generation,
      contentVersion: manifest.contentVersion,
      skillContentHash: manifest.skill.contentHash,
      treePolicyVersion: manifest.treePolicyVersion,
      companyName: manifest.company.name,
      companyWebsite: manifest.company.website,
    },
    true,
  );
  return { changed: true as const, validated };
}

async function normalizeMaterializedKnowledgeBasePatchResult(input: {
  mode: "patch";
  archiveBytes: Buffer;
  authority: Required<
    Omit<KnowledgeBaseNodePatchExpectation, "attachmentSourceProofs">
  > & {
    attachmentSourceProofs: readonly KnowledgeBasePatchAttachmentSourceProof[];
  };
  provenance: KnowledgeBasePatchResultProvenance;
  base: ValidatedKnowledgeBaseWorkingSet;
}): Promise<KnowledgeBaseNormalizationOutcome> {
  try {
    assertPatchBaseAuthority({ base: input.base, authority: input.authority });
    let sourcePatch: ValidatedKnowledgeBaseNodePatch;
    let recoveredViewOnly = false;
    try {
      sourcePatch = await validateKnowledgeBaseNodePatchArchiveInternal(
        input.archiveBytes,
        input.authority,
        true,
      );
    } catch (error) {
      if (!(error instanceof KnowledgeBaseMaterializedContractError)) {
        return {
          kind: "rejected",
          code: "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
          stage: "canonical_validation",
          resetRequired: true,
        };
      }
      const expectedFilename = `frontmind-kb-patch-${input.authority.operationId}.zip`;
      if (
        error.category !== "manifest_parse" ||
        !input.provenance.baseAuthorityLocked ||
        !input.provenance.exactBoundTask ||
        !input.provenance.directAssistantOutput ||
        input.provenance.descriptorFilename !== expectedFilename
      ) {
        return {
          kind: "rejected",
          code: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
          stage: resultStageForContractError(error),
          resetRequired: true,
        };
      }
      try {
        sourcePatch = await salvageKnowledgeBaseNodePatchArchive({
          bytes: input.archiveBytes,
          expected: input.authority,
          dbAuthorityLocked: true,
        });
        recoveredViewOnly = true;
      } catch (fallbackError) {
        return {
          kind: "rejected",
          code:
            fallbackError instanceof KnowledgeBaseMaterializedContractError
              ? "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID"
              : "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
          stage:
            fallbackError instanceof KnowledgeBaseMaterializedContractError
              ? resultStageForContractError(fallbackError)
              : "canonical_validation",
          resetRequired: true,
        };
      }
    }
    const composed = await composeNormalizedKnowledgeBasePatch({
      base: input.base,
      patch: sourcePatch,
    });
    const completeness = recoveredViewOnly ? "partial" : "complete";
    const diagnostics: KnowledgeBaseNormalizationDiagnostic[] = [
      ...sourcePatch.warnings,
      ...(recoveredViewOnly
        ? ([{ code: "RESULT_INCOMPLETE", area: "nodes" }] as const)
        : []),
    ];
    const renderSnapshot = canonicalPresentationSnapshot({
      validated: composed.validated,
      completeness,
    });
    return {
      kind: "accepted",
      mode: "patch",
      completeness,
      canonicalArchiveBytes: composed.validated.archiveBytes,
      manifest: composed.validated.manifest,
      renderSnapshot,
      diagnostics,
      packageSha256: composed.validated.packageSha256,
      manifestSha256: composed.validated.manifestSha256,
      workingSet: composed.validated,
      sourcePatch,
      changed: composed.changed,
    };
  } catch (error) {
    return {
      kind: "rejected",
      code:
        error instanceof KnowledgeBaseMaterializedContractError
          ? "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID"
          : "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
      stage:
        error instanceof KnowledgeBaseMaterializedContractError
          ? resultStageForContractError(error)
          : "presentation",
      resetRequired: true,
    };
  }
}

export const MATERIALIZED_KNOWLEDGE_BASE_ZIP_LIMITS = {
  maxCompressedBytes: MAX_COMPRESSED_ARCHIVE_BYTES,
  maxUncompressedBytes: MAX_UNCOMPRESSED_ARCHIVE_BYTES,
  // Compatibility projection for callers that predate split limits.
  maxCompressedOrExpandedBytes: Math.min(
    MAX_COMPRESSED_ARCHIVE_BYTES,
    MAX_UNCOMPRESSED_ARCHIVE_BYTES,
  ),
  maxEntryCount: MAX_ENTRY_COUNT,
  maxCompressionRatio: MAX_COMPRESSION_RATIO,
} as const;
