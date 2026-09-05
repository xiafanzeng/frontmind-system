import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { installImmutableFileAtomically } from "./atomic-immutable-file";
import { knowledgeBaseUploadEvidenceStorageKey } from "./knowledge-base-upload-evidence-lifecycle";

const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_BYTES = 80 * 1024 * 1024;

export type PersistedKnowledgeBaseCustomerUpload = {
  sourceSha256: string;
  leafIds: string[];
  filenames: string[];
  mimeTypes: string[];
  fileIds: string[];
  sizeBytes: number[];
};

export type PersistedKnowledgeBaseOfficialLogoUpload = {
  turnId: string;
  leafId: string;
  index: number;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
};

export type PersistedKnowledgeBaseOfficialLogoProvenance =
  | {
      sourceKind: "official_web";
      sourcePageUrl: string;
      sourceAssetUrl: string;
    }
  | { sourceKind: "official_document"; sourceDocumentPath: string };

type EvidenceLedger = {
  schemaVersion: 1;
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
  expectedCustomerUploads: PersistedKnowledgeBaseCustomerUpload[];
  expectedOfficialLogoUpload?: PersistedKnowledgeBaseOfficialLogoUpload;
  expectedOfficialLogoProvenance?: PersistedKnowledgeBaseOfficialLogoProvenance;
};

export class KnowledgeBaseUploadEvidenceError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseUploadEvidenceError";
  }
}

function storageRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function assertIdentity(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
}) {
  if (
    !Number.isInteger(input.userId) ||
    input.userId <= 0 ||
    !BUILD_ID_PATTERN.test(input.buildId) ||
    !Number.isInteger(input.generation) ||
    input.generation <= 0 ||
    !SHA256_PATTERN.test(input.packageArchiveSha256)
  ) {
    throw new KnowledgeBaseUploadEvidenceError(
      "INVALID",
      "知识库客户上传证据所属构建无效",
    );
  }
}

function evidenceDirectory(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
}) {
  assertIdentity(input);
  return path.join(
    storageRoot(),
    ...knowledgeBaseUploadEvidenceStorageKey(input).split("/"),
    input.packageArchiveSha256,
  );
}

function buildEvidenceDirectory(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
}) {
  return path.dirname(evidenceDirectory(input));
}

function sharedCustomerUploadPath(
  input: {
    userId: number;
    buildId: string;
    generation: number;
    packageArchiveSha256: string;
  },
  sourceSha256: string,
) {
  return path.join(
    buildEvidenceDirectory(input),
    "customer-uploads",
    `${sourceSha256}.bin`,
  );
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalLedger(ledger: EvidenceLedger) {
  return Buffer.from(`${JSON.stringify(ledger)}\n`, "utf8");
}

function parseLedger(bytes: Buffer): EvidenceLedger {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new KnowledgeBaseUploadEvidenceError(
      "INTEGRITY_MISMATCH",
      "知识库客户上传证据账本无法解析",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeBaseUploadEvidenceError(
      "INTEGRITY_MISMATCH",
      "知识库客户上传证据账本无效",
    );
  }
  return value as EvidenceLedger;
}

async function installExact(target: string, bytes: Buffer) {
  await mkdir(path.dirname(target), { recursive: true });
  const result = await installImmutableFileAtomically({
    target,
    buffer: bytes,
  });
  if (result === "exists") {
    const existing = await readFile(target);
    if (
      existing.length !== bytes.length ||
      sha256(existing) !== sha256(bytes)
    ) {
      throw new KnowledgeBaseUploadEvidenceError(
        "INTEGRITY_MISMATCH",
        "知识库客户上传证据与既有不可变副本不一致",
      );
    }
  }
}

export async function persistKnowledgeBaseUploadEvidence(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
  expectedCustomerUploads: PersistedKnowledgeBaseCustomerUpload[];
  expectedOfficialLogoUpload?: PersistedKnowledgeBaseOfficialLogoUpload;
  expectedOfficialLogoProvenance?: PersistedKnowledgeBaseOfficialLogoProvenance;
  customerUploadBytes: ReadonlyMap<string, Buffer>;
}) {
  const directory = evidenceDirectory(input);
  let aggregateBytes = 0;
  for (const upload of input.expectedCustomerUploads) {
    const bytes = input.customerUploadBytes.get(upload.sourceSha256);
    if (
      !bytes ||
      sha256(bytes) !== upload.sourceSha256 ||
      !upload.sizeBytes.includes(bytes.length)
    ) {
      throw new KnowledgeBaseUploadEvidenceError(
        "INTEGRITY_MISMATCH",
        "客户上传原始字节与规范化证据账本不一致",
      );
    }
    aggregateBytes += bytes.length;
    if (aggregateBytes > MAX_EVIDENCE_BYTES) {
      throw new KnowledgeBaseUploadEvidenceError(
        "INVALID",
        "客户上传原始字节合计超过知识库证据封存上限",
      );
    }
    // Original customer bytes are content-addressed at build/generation scope.
    // A rejected package may be retried with a different archive hash without
    // making expiring presales storage a dependency or duplicating the bytes.
    await installExact(
      sharedCustomerUploadPath(input, upload.sourceSha256),
      bytes,
    );
  }
  const ledger: EvidenceLedger = {
    schemaVersion: 1,
    userId: input.userId,
    buildId: input.buildId,
    generation: input.generation,
    packageArchiveSha256: input.packageArchiveSha256,
    expectedCustomerUploads: input.expectedCustomerUploads,
    ...(input.expectedOfficialLogoUpload
      ? { expectedOfficialLogoUpload: input.expectedOfficialLogoUpload }
      : {}),
    ...(input.expectedOfficialLogoProvenance
      ? { expectedOfficialLogoProvenance: input.expectedOfficialLogoProvenance }
      : {}),
  };
  // Install the ledger last: its existence is the commit marker proving every
  // referenced source byte was durably installed first.
  await installExact(
    path.join(directory, "ledger.json"),
    canonicalLedger(ledger),
  );
  return ledger;
}

export async function readKnowledgeBaseUploadEvidence(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
}) {
  const directory = evidenceDirectory(input);
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(directory, "ledger.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KnowledgeBaseUploadEvidenceError(
        "NOT_FOUND",
        "知识库客户上传证据尚未永久封存",
      );
    }
    throw error;
  }
  const ledger = parseLedger(bytes);
  const expectedIdentity = {
    schemaVersion: 1,
    userId: input.userId,
    buildId: input.buildId,
    generation: input.generation,
    packageArchiveSha256: input.packageArchiveSha256,
  };
  if (
    ledger.schemaVersion !== expectedIdentity.schemaVersion ||
    ledger.userId !== expectedIdentity.userId ||
    ledger.buildId !== expectedIdentity.buildId ||
    ledger.generation !== expectedIdentity.generation ||
    ledger.packageArchiveSha256 !== expectedIdentity.packageArchiveSha256 ||
    !Array.isArray(ledger.expectedCustomerUploads)
  ) {
    throw new KnowledgeBaseUploadEvidenceError(
      "INTEGRITY_MISMATCH",
      "知识库客户上传证据账本与当前构建不匹配",
    );
  }
  // Re-serialize to reject non-canonical/tampered ledgers even if JSON.parse
  // would otherwise accept them.
  if (!bytes.equals(canonicalLedger(ledger))) {
    throw new KnowledgeBaseUploadEvidenceError(
      "INTEGRITY_MISMATCH",
      "知识库客户上传证据账本不是权威规范格式",
    );
  }
  return ledger;
}

export async function readKnowledgeBasePersistedCustomerUploadBytes(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
  sourceSha256: string;
}) {
  if (!SHA256_PATTERN.test(input.sourceSha256)) {
    throw new KnowledgeBaseUploadEvidenceError(
      "INVALID",
      "客户上传图片哈希无效",
    );
  }
  const ledger = await readKnowledgeBaseUploadEvidence(input);
  const upload = ledger.expectedCustomerUploads.find(
    (candidate) => candidate.sourceSha256 === input.sourceSha256,
  );
  if (!upload) {
    throw new KnowledgeBaseUploadEvidenceError(
      "NOT_FOUND",
      "客户上传图片不属于当前知识库成品",
    );
  }
  const sharedTarget = sharedCustomerUploadPath(input, input.sourceSha256);
  // Compatibility with the first durable-evidence layout, which placed a
  // copy under each package hash before build-level reuse was introduced.
  const legacyTarget = path.join(
    evidenceDirectory(input),
    "customer-uploads",
    `${input.sourceSha256}.bin`,
  );
  let fileStat;
  let bytes: Buffer;
  try {
    [fileStat, bytes] = await Promise.all([
      stat(sharedTarget),
      readFile(sharedTarget),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      [fileStat, bytes] = await Promise.all([
        stat(legacyTarget),
        readFile(legacyTarget),
      ]);
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw legacyError;
      }
      throw new KnowledgeBaseUploadEvidenceError(
        "NOT_FOUND",
        "客户上传图片的永久证据字节缺失",
      );
    }
  }
  if (
    !fileStat.isFile() ||
    fileStat.size !== bytes.length ||
    !upload.sizeBytes.includes(bytes.length) ||
    sha256(bytes) !== upload.sourceSha256
  ) {
    throw new KnowledgeBaseUploadEvidenceError(
      "INTEGRITY_MISMATCH",
      "客户上传图片的永久证据字节完整性不一致",
    );
  }
  return bytes;
}

function evidencePayload(input: {
  expectedCustomerUploads: PersistedKnowledgeBaseCustomerUpload[];
  expectedOfficialLogoUpload?: PersistedKnowledgeBaseOfficialLogoUpload;
  expectedOfficialLogoProvenance?: PersistedKnowledgeBaseOfficialLogoProvenance;
}) {
  return JSON.stringify({
    expectedCustomerUploads: input.expectedCustomerUploads,
    ...(input.expectedOfficialLogoUpload
      ? { expectedOfficialLogoUpload: input.expectedOfficialLogoUpload }
      : {}),
    ...(input.expectedOfficialLogoProvenance
      ? { expectedOfficialLogoProvenance: input.expectedOfficialLogoProvenance }
      : {}),
  });
}

/**
 * Reuse only a fully committed ledger from this exact build generation. The
 * caller supplies the current authenticated turn ledger; byte reuse is denied
 * unless every customer upload and Logo provenance field matches exactly.
 */
export async function readReusableKnowledgeBaseUploadEvidenceBytes(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
  expectedCustomerUploads: PersistedKnowledgeBaseCustomerUpload[];
  expectedOfficialLogoUpload?: PersistedKnowledgeBaseOfficialLogoUpload;
  expectedOfficialLogoProvenance?: PersistedKnowledgeBaseOfficialLogoProvenance;
}) {
  const root = buildEvidenceDirectory(input);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KnowledgeBaseUploadEvidenceError(
        "NOT_FOUND",
        "当前构建没有可复用的永久上传证据",
      );
    }
    throw error;
  }
  const expectedPayload = evidencePayload(input);
  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        SHA256_PATTERN.test(entry.name) &&
        entry.name !== input.packageArchiveSha256,
    )
    .map((entry) => entry.name)
    .sort();
  for (const packageArchiveSha256 of candidates) {
    let ledger: EvidenceLedger;
    try {
      ledger = await readKnowledgeBaseUploadEvidence({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        packageArchiveSha256,
      });
    } catch (error) {
      // A directory without its final ledger marker is an interrupted write,
      // not committed evidence. A committed but corrupt ledger remains fatal.
      if (
        error instanceof KnowledgeBaseUploadEvidenceError &&
        error.code === "NOT_FOUND"
      ) {
        continue;
      }
      throw error;
    }
    if (evidencePayload(ledger) !== expectedPayload) continue;
    const bytes = new Map<string, Buffer>();
    for (const upload of input.expectedCustomerUploads) {
      bytes.set(
        upload.sourceSha256,
        await readKnowledgeBasePersistedCustomerUploadBytes({
          userId: input.userId,
          buildId: input.buildId,
          generation: input.generation,
          packageArchiveSha256,
          sourceSha256: upload.sourceSha256,
        }),
      );
    }
    return bytes;
  }
  throw new KnowledgeBaseUploadEvidenceError(
    "NOT_FOUND",
    "当前构建没有与客户上传账本完全一致的永久证据",
  );
}
