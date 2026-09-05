import { createHash } from "node:crypto";

import JSZip from "jszip";

function lengthPrefix(length) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError("Skill archive entry length is invalid");
  }
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

function compareEntryPaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Hash the logical archive rather than ZIP container metadata. Every
 * non-directory entry participates, ordered by its exact UTF-8 path. Both the
 * path and decompressed raw bytes are length-prefixed to prevent ambiguous
 * concatenations such as ("ab", "c") and ("a", "bc").
 */
export async function canonicalKnowledgeBaseSkillArchiveHash(archive) {
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => compareEntryPaths(left.name, right.name));
  if (entries.length === 0) {
    throw new Error("Knowledge-base Skill archive contains no files");
  }

  const hash = createHash("sha256");
  for (const entry of entries) {
    const entryPath = Buffer.from(entry.name, "utf8");
    const bytes = await entry.async("nodebuffer");
    hash.update(lengthPrefix(entryPath.length));
    hash.update(entryPath);
    hash.update(lengthPrefix(bytes.length));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Historical v3/v4 builds persisted this SKILL.md-only hash. */
export async function legacyKnowledgeBaseSkillInstructionHash(archive) {
  const zip = await JSZip.loadAsync(archive);
  const skill = await zip.file("SKILL.md")?.async("string");
  if (!skill) {
    throw new Error("Knowledge-base Skill archive is missing SKILL.md");
  }
  return createHash("sha256")
    .update(`# Skill\n\n${skill.trim()}`)
    .digest("hex");
}
