import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalKnowledgeBaseSkillArchiveHash } from "../shared/knowledge-base-skill-archive-hash.js";
import {
  packageSocraticKnowledgeBaseSkill,
  socraticKnowledgeBaseSkillEntries,
} from "./package-socratic-kb-skill.mjs";

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
      entryPath === "SKILL.md" ? "stable v5 instructions" : `A:${entryPath}`,
    );
  }
  return {
    root,
    sourceRoot,
    outputPath: path.join(root, "socratic-kb-builder-v5.skill"),
  };
}

describe("socratic knowledge-base Skill v5 packaging", () => {
  it("packages only the full Working Set and leaf-patch contract", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-kb-skill-contract-"),
    );
    temporaryRoots.push(root);
    const outputPath = path.join(root, "socratic-kb-builder-v5.skill");
    const result = await packageSocraticKnowledgeBaseSkill({
      sourceRoot: path.resolve(
        process.cwd(),
        "private-workflows/socratic-kb-builder",
      ),
      outputPath,
    });

    const archiveBytes = await fs.readFile(outputPath);
    const archive = await JSZip.loadAsync(archiveBytes);
    const entries = Object.keys(archive.files).sort();
    const skill = await archive.file("SKILL.md")!.async("string");
    const contract = await archive
      .file("references/materialized-working-set.md")!
      .async("string");
    const validator = await archive
      .file("scripts/validate_working_set.py")!
      .async("string");
    const policy = JSON.parse(
      await archive.file("references/working-set-policy.json")!.async("string"),
    );

    expect(entries).toEqual([...socraticKnowledgeBaseSkillEntries].sort());
    expect(skill).toContain("materialize_initial_bundle");
    expect(skill).toContain("revise_leaf_bundle");
    expect(skill).toContain("Every operation is a new top-level Manus v2 task");
    expect(skill.replace(/\s+/gu, " ")).toContain(
      "complete ZIP is the sole business result",
    );
    expect(skill).toContain("--expected-skill-content-hash");
    expect(skill).toContain("--expected-uploads-read");
    expect(skill).toContain("frozen logical content hash");
    expect(skill).toContain("customer-visible Markdown only");
    expect(skill).not.toContain(
      "place one polished customer-visible block between",
    );
    expect(skill).not.toContain("One leaf per turn");
    expect(skill).not.toContain("task.sendMessage");
    expect(skill).not.toContain("Pro Agent");
    expect(contract).toContain('"kind": "frontmind.kb-working-set"');
    expect(contract).toContain('"kind": "frontmind.kb-node-patch"');
    expect(contract).not.toContain('"researchCoverage": {}');
    for (const dimensionId of [
      "enterprise_identity",
      "team_and_organization",
      "products_and_services",
      "capabilities_and_delivery",
      "industries_scenarios_and_cases",
      "differentiation_and_evidence",
      "cooperation_delivery_and_support",
    ]) {
      expect(contract).toContain(`"id": "${dimensionId}"`);
    }
    expect(validator).toContain(
      'parser.add_argument("--expected-uploads-read"',
    );
    expect(validator).toContain("validate_research_coverage(");
    expect(validator).toContain("customer_markdown_title(");
    expect(validator).toContain("working-set-policy.json");
    expect(policy).toMatchObject({
      archive: { maxCompressionRatio: 200, maxEntryCount: 1500 },
      evidence: { textExtensions: [".md", ".markdown", ".txt"] },
    });
    expect(entries).not.toContain("scripts/validate_archive.py");
    expect(result.contentHash).toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(archiveBytes),
    );
    await expect(
      fs.readFile(
        path.join(root, `socratic-kb-builder-v5-${result.contentHash}.skill`),
      ),
    ).resolves.toEqual(archiveBytes);
  });

  it("pins reference changes under a new exact v5 hash", async () => {
    const input = await fixture();
    const first = await packageSocraticKnowledgeBaseSkill(input);
    const firstBytes = await fs.readFile(input.outputPath);
    await fs.writeFile(
      path.join(input.sourceRoot, "references/output-format.md"),
      "B:reference-only-change",
    );

    const second = await packageSocraticKnowledgeBaseSkill(input);

    expect(second.contentHash).not.toBe(first.contentHash);
    await expect(
      fs.readFile(
        path.join(
          input.root,
          `socratic-kb-builder-v5-${first.contentHash}.skill`,
        ),
      ),
    ).resolves.toEqual(firstBytes);
    expect(second.contentHash).toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(
        await fs.readFile(input.outputPath),
      ),
    );
  });

  it("never overwrites an immutable exact-hash archive", async () => {
    const input = await fixture();
    const first = await packageSocraticKnowledgeBaseSkill(input);
    const historicalPath = path.join(
      input.root,
      `socratic-kb-builder-v5-${first.contentHash}.skill`,
    );
    await fs.writeFile(historicalPath, "conflicting bytes");
    await fs.writeFile(
      path.join(input.sourceRoot, "references/output-format.md"),
      "B:reference-only-change",
    );

    await expect(packageSocraticKnowledgeBaseSkill(input)).rejects.toThrow(
      "conflicting bytes",
    );
  });
});
