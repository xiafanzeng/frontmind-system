import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import { afterEach, describe, expect, it } from "vitest";

import {
  packageSocraticKnowledgeBaseSkill,
  socraticKnowledgeBaseSkillEntries,
} from "./package-socratic-kb-skill.mjs";
import {
  canonicalKnowledgeBaseSkillArchiveHash,
  legacyKnowledgeBaseSkillInstructionHash,
} from "../shared/knowledge-base-skill-archive-hash.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmind-kb-skill-"));
  temporaryRoots.push(root);
  const sourceRoot = path.join(root, "source");
  for (const entryPath of socraticKnowledgeBaseSkillEntries) {
    await fs.mkdir(path.dirname(path.join(sourceRoot, entryPath)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(sourceRoot, entryPath),
      entryPath === "SKILL.md" ? "stable Skill instructions" : `A:${entryPath}`,
    );
  }
  return {
    root,
    sourceRoot,
    outputPath: path.join(root, "socratic-kb-builder-v4.skill"),
  };
}

describe("socratic knowledge-base Skill packaging", () => {
  it("packages the schema-v4 customer-upload archive contract", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-kb-skill-contract-"),
    );
    temporaryRoots.push(root);
    const outputPath = path.join(root, "socratic-kb-builder-v4.skill");
    await packageSocraticKnowledgeBaseSkill({
      sourceRoot: path.resolve(
        process.cwd(),
        "private-workflows/socratic-kb-builder",
      ),
      outputPath,
    });

    const archive = await JSZip.loadAsync(await fs.readFile(outputPath));
    const skill = await archive.file("SKILL.md")!.async("string");
    const outputContract = await archive
      .file("references/output-format.md")!
      .async("string");
    const questioningStrategy = await archive
      .file("references/questioning-strategy.md")!
      .async("string");
    const validator = await archive
      .file("scripts/validate_archive.py")!
      .async("string");

    expect(skill).toContain("`schemaVersion: 4`");
    expect(skill).toContain("sourceUploadSha256");
    for (const instructions of [
      skill,
      outputContract,
      questioningStrategy,
    ]) {
      const normalizedInstructions = instructions.replace(/\s+/g, " ");
      expect(normalizedInstructions).toContain("image-free");
      expect(normalizedInstructions).toContain(
        "actually attach exactly one `application/zip` typed `output_file`",
      );
      expect(normalizedInstructions).toContain("present in the task `output`");
      expect(normalizedInstructions).toContain(
        "will be generated now, soon or later",
      );
      expect(normalizedInstructions).not.toContain("text-only");
    }
    expect(outputContract).toContain('"schemaVersion": 4');
    expect(outputContract).toContain('"sourceKind": "user_upload"');
    expect(validator).toContain("MAX_USER_UPLOAD_IMAGES = 99");
    expect(validator).toContain("duplicate original customer upload hash");
    expect(validator).not.toContain("CUSTOMER_FORMAL_LEAKAGE");
    expect(validator).not.toContain("CUSTOMER_OR_PROCUREMENT_ADVICE");
    expect(skill).toContain("not a vocabulary-based runtime gate");
    expect(outputContract).toContain("does not screen formal prose");
  });

  it("pins reference-only changes and preserves canonical plus legacy aliases", async () => {
    const input = await fixture();
    const first = await packageSocraticKnowledgeBaseSkill(input);
    const firstBytes = await fs.readFile(input.outputPath);
    const firstLegacyHash =
      await legacyKnowledgeBaseSkillInstructionHash(firstBytes);
    // Simulate an archive deployed before canonical aliases were introduced.
    await fs.rm(
      path.join(
        input.root,
        `socratic-kb-builder-v4-${first.contentHash}.skill`,
      ),
    );

    await fs.writeFile(
      path.join(input.sourceRoot, "references/output-format.md"),
      "B:reference-only-change",
    );
    const second = await packageSocraticKnowledgeBaseSkill(input);

    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.contentHash).toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(
        await fs.readFile(input.outputPath),
      ),
    );
    await expect(
      fs.readFile(
        path.join(
          input.root,
          `socratic-kb-builder-v4-${first.contentHash}.skill`,
        ),
      ),
    ).resolves.toEqual(firstBytes);
    await expect(
      fs.readFile(
        path.join(
          input.root,
          `socratic-kb-builder-v4-${firstLegacyHash}.skill`,
        ),
      ),
    ).resolves.toEqual(firstBytes);
  });

  it("never overwrites an existing historical filename with different bytes", async () => {
    const input = await fixture();
    const first = await packageSocraticKnowledgeBaseSkill(input);
    const firstBytes = await fs.readFile(input.outputPath);
    const historicalPath = path.join(
      input.root,
      `socratic-kb-builder-v4-${first.contentHash}.skill`,
    );
    await fs.writeFile(historicalPath, "conflicting historical bytes");
    await fs.writeFile(
      path.join(input.sourceRoot, "references/output-format.md"),
      "B:reference-only-change",
    );

    await expect(packageSocraticKnowledgeBaseSkill(input)).rejects.toThrow(
      "conflicting bytes",
    );
    expect(await fs.readFile(historicalPath, "utf8")).toBe(
      "conflicting historical bytes",
    );
    expect(await fs.readFile(input.outputPath)).toEqual(firstBytes);
  });
});
