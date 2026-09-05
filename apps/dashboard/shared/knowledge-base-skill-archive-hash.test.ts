import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  canonicalKnowledgeBaseSkillArchiveHash,
  legacyKnowledgeBaseSkillInstructionHash,
} from "./knowledge-base-skill-archive-hash.js";

async function archive(
  entries: Array<[string, string]>,
  date = new Date("2000-01-01T00:00:00.000Z"),
) {
  const zip = new JSZip();
  for (const [entryPath, content] of entries) {
    zip.file(entryPath, content, { date, createFolders: false });
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("knowledge-base Skill archive hash", () => {
  it("hashes every sorted path and raw entry byte, independent of ZIP order", async () => {
    const left = await archive([
      ["SKILL.md", "same instructions"],
      ["references/output-format.md", "reference A"],
    ]);
    const reordered = await archive(
      [
        ["references/output-format.md", "reference A"],
        ["SKILL.md", "same instructions"],
      ],
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const referenceOnlyChange = await archive([
      ["SKILL.md", "same instructions"],
      ["references/output-format.md", "reference B"],
    ]);

    expect(await canonicalKnowledgeBaseSkillArchiveHash(left)).toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(reordered),
    );
    expect(await canonicalKnowledgeBaseSkillArchiveHash(left)).not.toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(referenceOnlyChange),
    );
    expect(await legacyKnowledgeBaseSkillInstructionHash(left)).toBe(
      await legacyKnowledgeBaseSkillInstructionHash(referenceOnlyChange),
    );
  });

  it("uses length prefixes so path/content concatenations cannot collide", async () => {
    const left = await archive([["ab", "c"]]);
    const right = await archive([["a", "bc"]]);
    expect(await canonicalKnowledgeBaseSkillArchiveHash(left)).not.toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(right),
    );
  });
});
