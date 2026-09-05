import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { installImmutableFileAtomically } from "./atomic-immutable-file";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

export class KnowledgeBaseLocalSourceError extends Error {
  constructor(
    readonly code: "INVALID" | "NOT_FOUND" | "INTEGRITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseLocalSourceError";
  }
}

function storageRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertBytes(bytes: Buffer) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > MAX_SOURCE_BYTES
  ) {
    throw new KnowledgeBaseLocalSourceError(
      "INVALID",
      "Knowledge-base source bytes are outside the supported range",
    );
  }
}

function assertStorageKey(storageKey: string) {
  const normalized = String(storageKey || "").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new KnowledgeBaseLocalSourceError(
      "INVALID",
      "Knowledge-base source storage key is invalid",
    );
  }
  const resolved = path.resolve(storageRoot(), normalized);
  const relative = path.relative(storageRoot(), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new KnowledgeBaseLocalSourceError(
      "INVALID",
      "Knowledge-base source storage key escapes its asset root",
    );
  }
  return { storageKey: normalized, target: resolved };
}

async function install(storageKey: string, bytes: Buffer) {
  assertBytes(bytes);
  const { target } = assertStorageKey(storageKey);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
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
      throw new KnowledgeBaseLocalSourceError(
        "INTEGRITY_MISMATCH",
        "An immutable knowledge-base source key contains different bytes",
      );
    }
  }
}

/**
 * Captures server-generated attachment bytes before the first provider file
 * operation. The generic copy closes the crash window before a build-owned
 * copy can be installed by the v2 attachment mapper.
 */
export async function persistKnowledgeBaseGeneratedSource(bytes: Buffer) {
  assertBytes(bytes);
  const contentSha256 = sha256(bytes);
  const storageKey = `knowledge-base/generated-sources/${contentSha256}.bin`;
  await install(storageKey, bytes);
  return { storageKey, contentSha256, sizeBytes: bytes.length };
}

/**
 * Retain the exact physical Skill archive independently from a release image.
 * The returned key is deliberately relative to the Dashboard asset root so a
 * build pin remains readable after deploys move or remove the release alias.
 */
export async function persistKnowledgeBaseSkillArchive(bytes: Buffer) {
  assertBytes(bytes);
  const contentSha256 = sha256(bytes);
  const storageKey = `knowledge-base/skill-archives/${contentSha256}.skill.zip`;
  await install(storageKey, bytes);
  return { storageKey, contentSha256, sizeBytes: bytes.length };
}

/** Install an immutable source under its build/generation retention scope. */
export async function persistKnowledgeBaseBuildSource(input: {
  userId: number;
  buildId: string;
  generation: number;
  bytes: Buffer;
}) {
  assertBytes(input.bytes);
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    !BUILD_ID_PATTERN.test(input.buildId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  ) {
    throw new KnowledgeBaseLocalSourceError(
      "INVALID",
      "Knowledge-base build source identity is invalid",
    );
  }
  const contentSha256 = sha256(input.bytes);
  const storageKey = [
    "knowledge-base",
    "build-sources",
    String(input.userId),
    input.buildId.toLowerCase(),
    `g${input.generation}`,
    `${contentSha256}.bin`,
  ].join("/");
  await install(storageKey, input.bytes);
  return { storageKey, contentSha256, sizeBytes: input.bytes.length };
}

export async function readKnowledgeBaseLocalSource(input: {
  storageKey: string;
  contentSha256: string;
  sizeBytes: number;
}) {
  if (
    !SHA256_PATTERN.test(input.contentSha256) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_SOURCE_BYTES
  ) {
    throw new KnowledgeBaseLocalSourceError(
      "INVALID",
      "Knowledge-base source descriptor is invalid",
    );
  }
  const { target } = assertStorageKey(input.storageKey);
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KnowledgeBaseLocalSourceError(
        "NOT_FOUND",
        "Knowledge-base retained source bytes are unavailable",
      );
    }
    throw error;
  }
  if (
    bytes.length !== input.sizeBytes ||
    sha256(bytes) !== input.contentSha256
  ) {
    throw new KnowledgeBaseLocalSourceError(
      "INTEGRITY_MISMATCH",
      "Knowledge-base retained source bytes failed their immutable proof",
    );
  }
  return bytes;
}
