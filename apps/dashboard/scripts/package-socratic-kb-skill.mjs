import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import {
  canonicalKnowledgeBaseSkillArchiveHash,
  legacyKnowledgeBaseSkillInstructionHash,
} from "../shared/knowledge-base-skill-archive-hash.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(
  projectRoot,
  "private-workflows",
  "socratic-kb-builder",
);
const outputPath = path.join(
  projectRoot,
  "private-workflows",
  "socratic-kb-builder-v4.skill",
);
const fixedDate = new Date("2000-01-01T00:00:00.000Z");

export const socraticKnowledgeBaseSkillEntries = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/knowledge-tree.md",
  "references/output-format.md",
  "references/questioning-strategy.md",
  "scripts/validate_archive.py",
];

async function readRequiredSource(root, relativePath) {
  const content = await fs.readFile(path.join(root, relativePath));
  if (content.length === 0) {
    throw new Error(`Skill source is empty: ${relativePath}`);
  }
  return content;
}

async function writeHistoricalArchiveNoClobber(targetPath, archive) {
  try {
    await fs.writeFile(targetPath, archive, { flag: "wx" });
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const existing = await fs.readFile(targetPath);
  if (!existing.equals(archive)) {
    throw new Error(
      `Refusing to overwrite immutable historical Skill archive: ${targetPath}`,
    );
  }
}

async function historicalArchiveExists(targetPath, archive) {
  try {
    const existing = await fs.readFile(targetPath);
    if (!existing.equals(archive)) {
      throw new Error(
        `Immutable historical Skill archive has conflicting bytes: ${targetPath}`,
      );
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function preserveExistingSkillArchive(
  selectedOutputPath,
  archive,
  contentHash,
) {
  const canonicalPath = path.join(
    path.dirname(selectedOutputPath),
    `socratic-kb-builder-v4-${contentHash}.skill`,
  );
  const alreadyCanonical = await historicalArchiveExists(
    canonicalPath,
    archive,
  );
  if (alreadyCanonical) return;

  // A pre-canonical active archive may still be referenced by the historical
  // SKILL.md-only pin. Write that compatibility alias before the canonical
  // marker so an interrupted migration can safely retry.
  const legacyHash = await legacyKnowledgeBaseSkillInstructionHash(archive);
  await writeHistoricalArchiveNoClobber(
    path.join(
      path.dirname(selectedOutputPath),
      `socratic-kb-builder-v4-${legacyHash}.skill`,
    ),
    archive,
  );
  await writeHistoricalArchiveNoClobber(canonicalPath, archive);
}

export async function packageSocraticKnowledgeBaseSkill(options = {}) {
  const selectedSourceRoot = options.sourceRoot || sourceRoot;
  const selectedOutputPath = options.outputPath || outputPath;
  const zip = new JSZip();
  for (const relativePath of [...socraticKnowledgeBaseSkillEntries].sort()) {
    zip.file(
      relativePath,
      await readRequiredSource(selectedSourceRoot, relativePath),
      {
        binary: true,
        createFolders: false,
        date: fixedDate,
        unixPermissions: relativePath.endsWith(".py") ? 0o100755 : 0o100644,
      },
    );
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  const contentHash = await canonicalKnowledgeBaseSkillArchiveHash(archive);
  let existing = null;
  try {
    existing = await fs.readFile(selectedOutputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let deployedArchive = archive;
  if (!existing) {
    await fs.writeFile(selectedOutputPath, archive);
  } else {
    const existingContentHash =
      await canonicalKnowledgeBaseSkillArchiveHash(existing);
    if (existingContentHash === contentHash) {
      // A ZIP implementation or metadata change may alter container bytes
      // while preserving every logical entry. Keep the deployed bytes and
      // migrate their old SKILL-only alias exactly once.
      deployedArchive = existing;
      await preserveExistingSkillArchive(
        selectedOutputPath,
        existing,
        existingContentHash,
      );
    } else {
      await preserveExistingSkillArchive(
        selectedOutputPath,
        existing,
        existingContentHash,
      );
      await fs.writeFile(selectedOutputPath, archive);
    }
  }
  await writeHistoricalArchiveNoClobber(
    path.join(
      path.dirname(selectedOutputPath),
      `socratic-kb-builder-v4-${contentHash}.skill`,
    ),
    deployedArchive,
  );
  return {
    outputPath: selectedOutputPath,
    bytes: deployedArchive.length,
    sha256: contentHash,
    contentHash,
    archiveSha256: createHash("sha256").update(deployedArchive).digest("hex"),
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await packageSocraticKnowledgeBaseSkill();
  console.log(
    `Packaged deterministic Skill: ${path.relative(projectRoot, result.outputPath)} ` +
      `(${result.bytes} bytes, sha256=${result.sha256})`,
  );
}
