import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageSocraticKnowledgeBaseSkill } from "./package-socratic-kb-skill.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(projectRoot, "private-workflows");
const outputRoot = path.join(projectRoot, "dist", "private-workflows");
// Packaging can create immutable canonical/legacy aliases for the previously
// active v4 archive. Discover compatibility artifacts only after that step so
// the same deployment always contains every pin the server may resolve.
await packageSocraticKnowledgeBaseSkill();
const skillArtifacts = [
  "socratic-kb-builder.skill",
  "socratic-kb-builder-v1.skill",
  "socratic-kb-builder-v3.skill",
  "socratic-kb-builder-v4.skill",
  "brand-question-portfolio.skill",
  "response-logic-builder.skill",
];
const compatibilitySkillArtifacts = (await fs.readdir(sourceRoot)).filter(
  (name) => /^socratic-kb-builder-v[34]-[a-f0-9]{64}\.skill$/.test(name),
);
skillArtifacts.push(...compatibilitySkillArtifacts);
const requiredFiles = [
  "socratic-kb-builder.skill",
  "socratic-kb-builder-v1.skill",
  "socratic-kb-builder-v3.skill",
  "socratic-kb-builder-v4.skill",
  "brand-question-portfolio.skill/SKILL.md",
  "brand-question-portfolio.skill/references/output-contract.md",
  "response-logic-builder.skill/SKILL.md",
  "response-logic-builder.skill/references/output-contract.md",
];

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });

for (const artifact of skillArtifacts) {
  await fs.cp(
    path.join(sourceRoot, artifact),
    path.join(outputRoot, artifact),
    {
      recursive: true,
      force: true,
    },
  );
}

for (const relativePath of requiredFiles) {
  const artifact = await fs.stat(path.join(outputRoot, relativePath));
  if (!artifact.isFile() || artifact.size === 0) {
    throw new Error(
      `Runtime Skill artifact is missing or empty: ${relativePath}`,
    );
  }
}

console.log(
  `Copied ${skillArtifacts.length} runtime Skill artifacts into dist/private-workflows.`,
);
