import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import { canonicalKnowledgeBaseSkillArchiveHash } from "../shared/knowledge-base-skill-archive-hash.js";
import {
  persistKnowledgeBaseSkillArchive,
  readKnowledgeBaseLocalSource,
} from "./knowledge-base-local-source-store";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";

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

const v5SkillArchiveCandidates = skillArchiveCandidates.map((candidate) =>
  path.join(path.dirname(candidate), "socratic-kb-builder-v5.skill"),
);

export interface KnowledgeBaseSkillSelection {
  version: string;
  contentHash?: string | null;
}

export interface KnowledgeBaseSkillPhysicalPin {
  physicalSha256?: string | null;
  archiveBytes?: number | null;
  storageKey?: string | null;
}

/** Compatibility call sites fail closed; old builds require an approved reset. */
export function knowledgeBasePinnedV4SkillSelection(input: {
  skillVersion: string;
  skillContentHash?: string | null;
}): never {
  void input;
  throw new Error(
    "RESET_REQUIRED: pre-v5 knowledge-base builds cannot load a runtime Skill",
  );
}

/** New materialized builds accept only the exact v5 logical archive pin. */
export function knowledgeBasePinnedV5SkillSelection(input: {
  skillVersion: string;
  skillContentHash?: string | null;
}): KnowledgeBaseSkillSelection & { version: "5"; contentHash: string } {
  const contentHash = String(input.skillContentHash || "")
    .trim()
    .toLowerCase();
  if (input.skillVersion !== "5" || !/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new Error(
      "Knowledge-base materialized build is missing its immutable Skill v5 content hash",
    );
  }
  return { version: "5", contentHash };
}

interface LoadedKnowledgeBaseSkill {
  instructions: string;
  contentHash: string;
  archivePath: string;
  /** Exact on-disk bytes selected for this immutable build pin. */
  physicalSha256: string;
  archiveBytes: number;
}

const skillArchiveCache = new Map<string, LoadedKnowledgeBaseSkill>();

async function physicalSkillArchiveDescriptor(archivePath: string) {
  const bytes = await fs.readFile(archivePath);
  return {
    bytes,
    physicalSha256: createHash("sha256").update(bytes).digest("hex"),
    archiveBytes: bytes.length,
  };
}

export const KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME =
  "socratic-kb-builder-v5.skill.zip";

async function loadKnowledgeBaseSkillArchiveInternal(
  selection: KnowledgeBaseSkillSelection,
  allowHistoricalAlias: boolean,
) {
  if (selection.version !== "5") {
    throw new Error(
      "RESET_REQUIRED: pre-v5 knowledge-base builds cannot load a runtime Skill",
    );
  }
  const requestedContentHash = String(selection.contentHash || "")
    .trim()
    .toLowerCase();
  if (
    requestedContentHash &&
    requestedContentHash !== KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH
  ) {
    throw new Error(
      "RESET_REQUIRED: knowledge-base Skill v5 pin is not the current exact runtime archive",
    );
  }
  const version = "5" as const;
  const cacheKey = `${allowHistoricalAlias ? "historical" : "strict"}:${version}:${selection.contentHash || "latest"}`;
  const cached = skillArchiveCache.get(cacheKey);
  if (cached) {
    if (selection.contentHash && selection.contentHash !== cached.contentHash) {
      throw new Error(
        `Knowledge-base Skill v${version} content hash does not match the active build`,
      );
    }
    // Never trust the filename or process cache alone. A historical alias can
    // be replaced on disk during a rollout; re-read and validate the exact
    // bytes before returning the pinned archive to any new operation.
    const { bytes: _bytes, ...physical } = await physicalSkillArchiveDescriptor(
      cached.archivePath,
    );
    if (
      physical.physicalSha256 !== cached.physicalSha256 ||
      physical.archiveBytes !== cached.archiveBytes
    ) {
      skillArchiveCache.delete(cacheKey);
      throw new Error(
        `Knowledge-base Skill v${version} physical archive does not match the active build`,
      );
    }
    return { ...cached, ...physical };
  }

  let lastError: unknown;
  let contentHashMismatchError: Error | null = null;
  const candidates = selection.contentHash
    ? v5SkillArchiveCandidates.map((candidate) =>
        path.join(
          path.dirname(candidate),
          `socratic-kb-builder-v5-${selection.contentHash}.skill`,
        ),
      )
    : v5SkillArchiveCandidates;
  for (const candidate of candidates) {
    try {
      const archive = await fs.readFile(candidate);
      const zip = await JSZip.loadAsync(archive);
      const entries = [["SKILL.md", "Skill"]] as const;

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
        await canonicalKnowledgeBaseSkillArchiveHash(archive);
      if (
        selection.contentHash &&
        canonicalArchiveHash !== selection.contentHash
      ) {
        contentHashMismatchError = new Error(
          `Knowledge-base Skill v${version} content hash does not match the active build`,
        );
        continue;
      }
      const loaded = {
        instructions,
        contentHash: selection.contentHash || canonicalArchiveHash,
        archivePath: candidate,
        physicalSha256: createHash("sha256").update(archive).digest("hex"),
        archiveBytes: archive.length,
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

export async function loadKnowledgeBaseSkillArchive(
  selection: KnowledgeBaseSkillSelection = { version: "5" },
) {
  return loadKnowledgeBaseSkillArchiveInternal(selection, false);
}

async function readKnowledgeBaseReleaseSkillArchiveAttachment(
  selection: KnowledgeBaseSkillSelection,
  allowHistoricalAlias: boolean,
) {
  const loaded = await loadKnowledgeBaseSkillArchiveInternal(
    selection,
    allowHistoricalAlias,
  );
  const physical = await physicalSkillArchiveDescriptor(loaded.archivePath);
  if (
    physical.physicalSha256 !== loaded.physicalSha256 ||
    physical.archiveBytes !== loaded.archiveBytes
  ) {
    throw new Error(
      "Knowledge-base Skill physical archive changed after selection",
    );
  }
  const retained = await persistKnowledgeBaseSkillArchive(physical.bytes);
  return {
    filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
    bytes: physical.bytes,
    contentHash: loaded.contentHash,
    physicalSha256: retained.contentSha256,
    archiveBytes: retained.sizeBytes,
    storageKey: retained.storageKey,
  };
}

export async function readKnowledgeBaseSkillArchiveAttachment(
  selection: KnowledgeBaseSkillSelection = { version: "5" },
) {
  return readKnowledgeBaseReleaseSkillArchiveAttachment(selection, false);
}

/** Read an exact v5 physical pin from Dashboard storage or the exact release archive. */
export async function readKnowledgeBasePinnedSkillArchiveAttachment(
  input: KnowledgeBaseSkillSelection & KnowledgeBaseSkillPhysicalPin,
) {
  if (input.version !== "5") {
    throw new Error(
      "RESET_REQUIRED: pre-v5 knowledge-base builds cannot load a runtime Skill",
    );
  }
  const logicalContentHash = String(input.contentHash || "")
    .trim()
    .toLowerCase();
  if (!logicalContentHash) {
    throw new Error("Knowledge-base Skill logical build pin is missing");
  }
  const physicalSha256 = String(input.physicalSha256 || "")
    .trim()
    .toLowerCase();
  const archiveBytes = input.archiveBytes ?? null;
  const storageKey = String(input.storageKey || "").trim();
  const hasSha = physicalSha256.length > 0;
  const hasBytes = archiveBytes !== null;
  const controlledStorageKey = storageKey && !path.isAbsolute(storageKey);

  if (controlledStorageKey) {
    if (
      !/^[a-f0-9]{64}$/u.test(physicalSha256) ||
      !Number.isSafeInteger(archiveBytes) ||
      Number(archiveBytes) < 1
    ) {
      throw new Error(
        "Knowledge-base Skill durable physical pin is incomplete",
      );
    }
    const bytes = await readKnowledgeBaseLocalSource({
      storageKey,
      contentSha256: physicalSha256,
      sizeBytes: Number(archiveBytes),
    });
    return {
      filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
      bytes,
      contentHash: logicalContentHash,
      physicalSha256,
      archiveBytes: Number(archiveBytes),
      storageKey,
    };
  }

  if (hasSha !== hasBytes) {
    throw new Error("Knowledge-base Skill physical pin is incomplete");
  }
  if (
    hasSha &&
    (!/^[a-f0-9]{64}$/u.test(physicalSha256) ||
      !Number.isSafeInteger(archiveBytes) ||
      Number(archiveBytes) < 1)
  ) {
    throw new Error("Knowledge-base Skill physical pin is invalid");
  }

  const archive = await readKnowledgeBaseReleaseSkillArchiveAttachment(
    {
      version: input.version,
      contentHash: input.contentHash,
    },
    true,
  );
  if (
    (hasSha && archive.physicalSha256 !== physicalSha256) ||
    (hasBytes && archive.archiveBytes !== archiveBytes)
  ) {
    throw new Error(
      "Knowledge-base Skill release archive does not match the build physical pin",
    );
  }
  return archive;
}

export async function getKnowledgeBaseSkillDescriptor(
  selection: KnowledgeBaseSkillSelection = { version: "5" },
) {
  if (selection.version !== "5") {
    throw new Error(
      "RESET_REQUIRED: pre-v5 knowledge-base builds cannot load a runtime Skill",
    );
  }
  const version = "5" as const;
  const archive = await readKnowledgeBaseSkillArchiveAttachment({
    version,
    contentHash: selection.contentHash,
  });
  return {
    name: "socratic-kb-builder",
    version,
    contentHash: archive.contentHash,
    physicalSha256: archive.physicalSha256,
    archiveBytes: archive.archiveBytes,
    storageKey: archive.storageKey,
  };
}
