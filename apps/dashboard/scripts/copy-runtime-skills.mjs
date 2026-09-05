import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageSocraticKnowledgeBaseSkill } from "./package-socratic-kb-skill.mjs";
import {
  SITEOPS_RUNTIME_VERSION,
  verifySiteOpsRuntimeWorkflow,
  verifyUpstreamSiteOpsWorkflow,
} from "./package-siteops-workflow.mjs";
import { verifyAllSiteOpsSocialWorkflows } from "./package-siteops-social-workflows.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(projectRoot, "private-workflows");
const outputRoot = path.join(projectRoot, "dist", "private-workflows");
const materializedSkill = await packageSocraticKnowledgeBaseSkill();
await verifyUpstreamSiteOpsWorkflow();
await verifySiteOpsRuntimeWorkflow();
await verifyAllSiteOpsSocialWorkflows();
const exactMaterializedSkill = `socratic-kb-builder-v5-${materializedSkill.contentHash}.skill`;
const currentSiteOpsWorkflow = `react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}`;
const skillArtifacts = [
  "socratic-kb-builder-v5.skill",
  exactMaterializedSkill,
  "brand-question-portfolio.skill",
  "response-logic-builder.skill",
  "generate-brand-question-universe",
  "astro-company-site-workflow-v1.0.0.zip",
  "astro-company-site-workflow-v1.0.0.sha256",
  "astro-company-site-workflow-v1.1.0",
  "astro-company-site-workflow-v1.2.0",
  "astro-company-site-workflow-v1.3.0",
  "astro-company-site-workflow-v1.4.0",
  "astro-company-site-workflow-v1.5.0",
  "astro-company-site-workflow-v1.6.0",
  "react-static-company-site-workflow-v2.0.0",
  "react-static-company-site-workflow-v2.1.0",
  "react-static-company-site-workflow-v2.2.0",
  "react-static-company-site-workflow-v2.3.0",
  "react-static-company-site-workflow-v2.4.0",
  currentSiteOpsWorkflow,
  "siteops-wechat-package-v1.0.0",
  "siteops-xiaohongshu-package-v1.0.0",
];
const requiredFiles = [
  "socratic-kb-builder-v5.skill",
  exactMaterializedSkill,
  "brand-question-portfolio.skill/SKILL.md",
  "brand-question-portfolio.skill/references/output-contract.md",
  "response-logic-builder.skill/SKILL.md",
  "response-logic-builder.skill/references/output-contract.md",
  "generate-brand-question-universe/upstream/MANIFEST.json",
  "generate-brand-question-universe/upstream/generate-brand-question-universe-final-v2-20260819.zip",
  "generate-brand-question-universe/frontmind-adapter-v1.0.0/MANIFEST.json",
  "generate-brand-question-universe/frontmind-adapter-v1.0.0/SKILL.md",
  "generate-brand-question-universe/frontmind-adapter-v1.0.0/runtime-contract.json",
  "astro-company-site-workflow-v1.0.0.zip",
  "astro-company-site-workflow-v1.0.0.sha256",
  "astro-company-site-workflow-v1.1.0/MANIFEST.json",
  "astro-company-site-workflow-v1.1.0/SKILL.md",
  "astro-company-site-workflow-v1.1.0/runtime-contract.json",
  "astro-company-site-workflow-v1.1.0/adapters/frontmind-dashboard.md",
  "astro-company-site-workflow-v1.1.0/schemas/frontmind-run-envelope.schema.json",
  "astro-company-site-workflow-v1.1.0/assets/astro-static-starter/package.json",
  "astro-company-site-workflow-v1.2.0/MANIFEST.json",
  "astro-company-site-workflow-v1.2.0/SKILL.md",
  "astro-company-site-workflow-v1.2.0/runtime-contract.json",
  "astro-company-site-workflow-v1.2.0/adapters/frontmind-dashboard.md",
  "astro-company-site-workflow-v1.2.0/schemas/frontmind-run-envelope.schema.json",
  "astro-company-site-workflow-v1.2.0/assets/host-starter-contract.json",
  "astro-company-site-workflow-v1.3.0/MANIFEST.json",
  "astro-company-site-workflow-v1.3.0/SKILL.md",
  "astro-company-site-workflow-v1.3.0/runtime-contract.json",
  "astro-company-site-workflow-v1.3.0/adapters/frontmind-dashboard.md",
  "astro-company-site-workflow-v1.3.0/schemas/frontmind-run-envelope.schema.json",
  "astro-company-site-workflow-v1.3.0/assets/host-starter-contract.json",
  "astro-company-site-workflow-v1.4.0/MANIFEST.json",
  "astro-company-site-workflow-v1.4.0/SKILL.md",
  "astro-company-site-workflow-v1.4.0/runtime-contract.json",
  "astro-company-site-workflow-v1.4.0/adapters/frontmind-dashboard.md",
  "astro-company-site-workflow-v1.4.0/schemas/frontmind-run-envelope.schema.json",
  "astro-company-site-workflow-v1.4.0/schemas/site-design-wire-v1.schema.json",
  "astro-company-site-workflow-v1.4.0/schemas/page-content-wire-v1.schema.json",
  "astro-company-site-workflow-v1.4.0/assets/host-starter-contract.json",
  "astro-company-site-workflow-v1.5.0/MANIFEST.json",
  "astro-company-site-workflow-v1.5.0/SKILL.md",
  "astro-company-site-workflow-v1.5.0/runtime-contract.json",
  "astro-company-site-workflow-v1.5.0/adapters/frontmind-dashboard.md",
  "astro-company-site-workflow-v1.5.0/schemas/frontmind-run-envelope.schema.json",
  "astro-company-site-workflow-v1.5.0/schemas/site-design-wire-v2.schema.json",
  "astro-company-site-workflow-v1.5.0/schemas/page-content-wire-v2.schema.json",
  "astro-company-site-workflow-v1.5.0/assets/host-starter-contract.json",
  "astro-company-site-workflow-v1.6.0/MANIFEST.json",
  "astro-company-site-workflow-v1.6.0/SKILL.md",
  "astro-company-site-workflow-v1.6.0/runtime-contract.json",
  "astro-company-site-workflow-v1.6.0/adapters/frontmind-dashboard.md",
  "astro-company-site-workflow-v1.6.0/schemas/frontmind-run-envelope.schema.json",
  "astro-company-site-workflow-v1.6.0/schemas/site-design-wire-v2.schema.json",
  "astro-company-site-workflow-v1.6.0/schemas/page-content-wire-v2.schema.json",
  "astro-company-site-workflow-v1.6.0/schemas/materialization-stage-v1.schema.json",
  "astro-company-site-workflow-v1.6.0/assets/host-starter-contract.json",
  "react-static-company-site-workflow-v2.0.0/MANIFEST.json",
  "react-static-company-site-workflow-v2.0.0/SKILL.md",
  "react-static-company-site-workflow-v2.0.0/runtime-contract.json",
  "react-static-company-site-workflow-v2.0.0/adapters/frontmind-dashboard.md",
  "react-static-company-site-workflow-v2.0.0/schemas/frontmind-run-envelope.schema.json",
  "react-static-company-site-workflow-v2.0.0/schemas/site-design-wire-v3.schema.json",
  "react-static-company-site-workflow-v2.0.0/schemas/page-content-wire-v2.schema.json",
  "react-static-company-site-workflow-v2.0.0/schemas/materialization-stage-v2.schema.json",
  "react-static-company-site-workflow-v2.0.0/assets/host-starter-contract.json",
  "react-static-company-site-workflow-v2.1.0/MANIFEST.json",
  "react-static-company-site-workflow-v2.1.0/SKILL.md",
  "react-static-company-site-workflow-v2.1.0/runtime-contract.json",
  "react-static-company-site-workflow-v2.1.0/adapters/frontmind-dashboard.md",
  "react-static-company-site-workflow-v2.1.0/schemas/frontmind-run-envelope.schema.json",
  "react-static-company-site-workflow-v2.1.0/schemas/site-design-wire-v3.schema.json",
  "react-static-company-site-workflow-v2.1.0/schemas/page-content-wire-v2.schema.json",
  "react-static-company-site-workflow-v2.1.0/schemas/materialization-stage-v2.schema.json",
  "react-static-company-site-workflow-v2.1.0/assets/host-starter-contract.json",
  "react-static-company-site-workflow-v2.2.0/MANIFEST.json",
  "react-static-company-site-workflow-v2.2.0/SKILL.md",
  "react-static-company-site-workflow-v2.2.0/runtime-contract.json",
  "react-static-company-site-workflow-v2.2.0/adapters/frontmind-dashboard.md",
  "react-static-company-site-workflow-v2.2.0/schemas/frontmind-run-envelope.schema.json",
  "react-static-company-site-workflow-v2.2.0/schemas/site-design-wire-v3.schema.json",
  "react-static-company-site-workflow-v2.2.0/schemas/page-content-wire-v3.schema.json",
  "react-static-company-site-workflow-v2.2.0/schemas/materialization-stage-v2.schema.json",
  "react-static-company-site-workflow-v2.2.0/assets/host-starter-contract.json",
  "react-static-company-site-workflow-v2.3.0/MANIFEST.json",
  "react-static-company-site-workflow-v2.3.0/SKILL.md",
  "react-static-company-site-workflow-v2.3.0/runtime-contract.json",
  "react-static-company-site-workflow-v2.3.0/adapters/frontmind-dashboard.md",
  "react-static-company-site-workflow-v2.3.0/schemas/frontmind-run-envelope.schema.json",
  "react-static-company-site-workflow-v2.3.0/schemas/site-design-wire-v3.schema.json",
  "react-static-company-site-workflow-v2.3.0/schemas/page-content-wire-v3.schema.json",
  "react-static-company-site-workflow-v2.3.0/schemas/materialization-stage-v2.schema.json",
  "react-static-company-site-workflow-v2.3.0/assets/host-starter-contract.json",
  "react-static-company-site-workflow-v2.4.0/MANIFEST.json",
  "react-static-company-site-workflow-v2.4.0/SKILL.md",
  "react-static-company-site-workflow-v2.4.0/runtime-contract.json",
  "react-static-company-site-workflow-v2.4.0/adapters/frontmind-dashboard.md",
  "react-static-company-site-workflow-v2.4.0/schemas/frontmind-run-envelope.schema.json",
  "react-static-company-site-workflow-v2.4.0/schemas/site-content-draft-v1.schema.json",
  "react-static-company-site-workflow-v2.4.0/schemas/materialization-stage-v3.schema.json",
  "react-static-company-site-workflow-v2.4.0/assets/host-starter-contract.json",
  "react-static-company-site-workflow-v2.4.0/assets/materializer-contract.json",
  `${currentSiteOpsWorkflow}/MANIFEST.json`,
  `${currentSiteOpsWorkflow}/SKILL.md`,
  `${currentSiteOpsWorkflow}/UPSTREAM.json`,
  `${currentSiteOpsWorkflow}/VERSION`,
  `${currentSiteOpsWorkflow}/runtime-contract.json`,
  `${currentSiteOpsWorkflow}/adapters/frontmind-dashboard.md`,
  `${currentSiteOpsWorkflow}/schemas/frontmind-run-envelope.schema.json`,
  `${currentSiteOpsWorkflow}/schemas/site-content-patch-wire-v1.schema.json`,
  `${currentSiteOpsWorkflow}/schemas/materialization-stage-v3.schema.json`,
  `${currentSiteOpsWorkflow}/assets/host-starter-contract.json`,
  `${currentSiteOpsWorkflow}/assets/materializer-contract.json`,
  "siteops-wechat-package-v1.0.0/MANIFEST.json",
  "siteops-wechat-package-v1.0.0/SKILL.md",
  "siteops-wechat-package-v1.0.0/runtime-contract.json",
  "siteops-xiaohongshu-package-v1.0.0/MANIFEST.json",
  "siteops-xiaohongshu-package-v1.0.0/SKILL.md",
  "siteops-xiaohongshu-package-v1.0.0/runtime-contract.json",
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
