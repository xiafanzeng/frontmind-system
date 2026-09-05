import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import {
  canonicalKnowledgeBaseSkillArchiveHash,
  legacyKnowledgeBaseSkillInstructionHash,
} from "../shared/knowledge-base-skill-archive-hash.js";

const configuredKnowledgeBaseSkillPath =
  process.env.FRONTMIND_KB_SKILL_PATH?.trim();
if (
  configuredKnowledgeBaseSkillPath &&
  !path.isAbsolute(configuredKnowledgeBaseSkillPath)
) {
  throw new Error("FRONTMIND_KB_SKILL_PATH must be an absolute path");
}

const skillArchiveCandidates = configuredKnowledgeBaseSkillPath
  ? [configuredKnowledgeBaseSkillPath]
  : [
      path.resolve(
        import.meta.dirname,
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        process.cwd(),
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "private-workflows",
        "socratic-kb-builder.skill",
      ),
    ];

const legacySkillArchiveCandidates = configuredKnowledgeBaseSkillPath
  ? [
      path.join(
        path.dirname(configuredKnowledgeBaseSkillPath),
        "socratic-kb-builder-v1.skill",
      ),
    ]
  : skillArchiveCandidates.map((candidate) =>
      path.join(path.dirname(candidate), "socratic-kb-builder-v1.skill"),
    );
const v3SkillArchiveCandidates = skillArchiveCandidates.map((candidate) =>
  path.join(path.dirname(candidate), "socratic-kb-builder-v3.skill"),
);
const v4SkillArchiveCandidates = skillArchiveCandidates.map((candidate) =>
  path.join(path.dirname(candidate), "socratic-kb-builder-v4.skill"),
);

export interface KnowledgeBaseSkillSelection {
  version: string;
  contentHash?: string | null;
}

interface LoadedKnowledgeBaseSkill {
  instructions: string;
  contentHash: string;
  archivePath: string;
}

const skillArchiveCache = new Map<string, LoadedKnowledgeBaseSkill>();

export const KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME =
  "socratic-kb-builder.skill.zip";

export async function loadKnowledgeBaseSkillArchive(
  selection: KnowledgeBaseSkillSelection = { version: "4" },
) {
  const version =
    selection.version === "1"
      ? "1"
      : selection.version === "2"
        ? "2"
        : selection.version === "3"
          ? "3"
          : "4";
  const cacheKey = `${version}:${selection.contentHash || "latest"}`;
  const cached = skillArchiveCache.get(cacheKey);
  if (cached) {
    if (selection.contentHash && selection.contentHash !== cached.contentHash) {
      throw new Error(
        `Knowledge-base Skill v${version} content hash does not match the active build`,
      );
    }
    return cached;
  }

  let lastError: unknown;
  let contentHashMismatchError: Error | null = null;
  const candidates =
    version === "1"
      ? legacySkillArchiveCandidates
      : version === "2"
        ? skillArchiveCandidates
        : version === "3"
          ? [
              ...(selection.contentHash
                ? v3SkillArchiveCandidates.map((candidate) =>
                    path.join(
                      path.dirname(candidate),
                      `socratic-kb-builder-v3-${selection.contentHash}.skill`,
                    ),
                  )
                : []),
              ...v3SkillArchiveCandidates,
            ]
          : [
              ...(selection.contentHash
                ? v4SkillArchiveCandidates.map((candidate) =>
                    path.join(
                      path.dirname(candidate),
                      `socratic-kb-builder-v4-${selection.contentHash}.skill`,
                    ),
                  )
                : []),
              ...v4SkillArchiveCandidates,
            ];
  for (const candidate of candidates) {
    try {
      const archive = await fs.readFile(candidate);
      const zip = await JSZip.loadAsync(archive);
      const entries =
        version !== "1"
          ? ([["SKILL.md", "Skill"]] as const)
          : ([
              ["SKILL.md", "Skill"],
              ["references/knowledge-tree.md", "Knowledge Tree"],
              ["references/questioning-strategy.md", "Questioning Strategy"],
              ["references/output-format.md", "Output Format"],
            ] as const);

      const sections: string[] = [];
      for (const [entryName, title] of entries) {
        const entry = zip.file(entryName);
        if (!entry) {
          throw new Error(`Missing ${entryName} in socratic-kb-builder.skill`);
        }
        const content = await entry.async("string");
        sections.push(`# ${title}\n\n${content.trim()}`);
      }

      const instructions = sections.join("\n\n---\n\n");
      const canonicalArchiveHash =
        version === "3" || version === "4"
          ? await canonicalKnowledgeBaseSkillArchiveHash(archive)
          : null;
      const legacyInstructionHash =
        version === "3" || version === "4"
          ? await legacyKnowledgeBaseSkillInstructionHash(archive)
          : null;
      const historicalInstructionHash = createHash("sha256")
        .update(instructions)
        .digest("hex");
      const acceptedHashes = new Set(
        [
          canonicalArchiveHash,
          legacyInstructionHash,
          version === "3" || version === "4" ? null : historicalInstructionHash,
        ].filter(Boolean),
      );
      const exactHistoricalAlias = Boolean(
        selection.contentHash &&
          path.basename(candidate) ===
            `socratic-kb-builder-v${version}-${selection.contentHash}.skill`,
      );
      if (
        selection.contentHash &&
        !acceptedHashes.has(selection.contentHash) &&
        !exactHistoricalAlias
      ) {
        contentHashMismatchError = new Error(
          `Knowledge-base Skill v${version} content hash does not match the active build`,
        );
        continue;
      }
      const loaded = {
        instructions,
        // New v3/v4 builds pin the full logical archive. Old deployments used
        // more than one hash algorithm; an exact immutable historical alias is
        // therefore an explicit compatibility mapping. Keep returning the
        // selected pin so recovery never rewrites durable build identity.
        contentHash:
          selection.contentHash ||
          canonicalArchiveHash ||
          historicalInstructionHash,
        archivePath: candidate,
      };
      skillArchiveCache.set(cacheKey, loaded);
      return loaded;
    } catch (error) {
      lastError = error;
    }
  }

  if (contentHashMismatchError) {
    throw contentHashMismatchError;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load socratic-kb-builder Skill v${version}`);
}

export async function readKnowledgeBaseSkillArchiveAttachment(
  selection: KnowledgeBaseSkillSelection = { version: "4" },
) {
  const loaded = await loadKnowledgeBaseSkillArchive(selection);
  const bytes = await fs.readFile(loaded.archivePath);
  return {
    filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
    bytes,
    contentHash: loaded.contentHash,
  };
}

export async function getKnowledgeBaseSkillDescriptor(
  selection: KnowledgeBaseSkillSelection = { version: "4" },
) {
  const version =
    selection.version === "1"
      ? "1"
      : selection.version === "2"
        ? "2"
        : selection.version === "3"
          ? "3"
          : "4";
  const loaded = await loadKnowledgeBaseSkillArchive({
    version,
    contentHash: selection.contentHash,
  });
  return {
    name: "socratic-kb-builder",
    version,
    contentHash: loaded.contentHash,
  };
}
