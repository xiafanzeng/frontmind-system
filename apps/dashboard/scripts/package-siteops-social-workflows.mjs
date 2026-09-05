import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const SITEOPS_SOCIAL_WORKFLOWS = {
  wechat: {
    channel: "wechat",
    version: "1.0.0",
    directory: "siteops-wechat-package-v1.0.0",
    imageCount: 3,
    width: 1410,
    height: 600,
  },
  xiaohongshu: {
    channel: "xiaohongshu",
    version: "1.0.0",
    directory: "siteops-xiaohongshu-package-v1.0.0",
    imageCount: 9,
    width: 1080,
    height: 1440,
  },
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function workflowFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    if (entry.name === "MANIFEST.json") continue;
    if (!entry.isFile()) {
      throw new Error(`Social workflow contains a non-file: ${entry.name}`);
    }
    const bytes = await fs.readFile(path.join(root, entry.name));
    files.push({
      path: entry.name,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return files;
}

export async function createSiteOpsSocialWorkflowManifest(channel) {
  const definition = SITEOPS_SOCIAL_WORKFLOWS[channel];
  if (!definition) throw new Error(`Unknown SiteOps social channel: ${channel}`);
  const root = path.join(projectRoot, "private-workflows", definition.directory);
  return {
    schema: "frontmind-runtime-workflow-manifest/v1",
    name: `frontmind-siteops-${channel}-package`,
    channel,
    version: definition.version,
    entrypoint: "SKILL.md",
    hashScope: "all regular files except MANIFEST.json",
    files: await workflowFiles(root),
  };
}

export async function verifySiteOpsSocialWorkflow(channel) {
  const definition = SITEOPS_SOCIAL_WORKFLOWS[channel];
  if (!definition) throw new Error(`Unknown SiteOps social channel: ${channel}`);
  const root = path.join(projectRoot, "private-workflows", definition.directory);
  const expected = await createSiteOpsSocialWorkflowManifest(channel);
  const actualBytes = await fs.readFile(path.join(root, "MANIFEST.json"));
  const actual = JSON.parse(actualBytes.toString("utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SiteOps ${channel} workflow manifest is stale`);
  }
  const contract = JSON.parse(
    await fs.readFile(path.join(root, "runtime-contract.json"), "utf8"),
  );
  if (
    contract.channel !== definition.channel ||
    contract.version !== definition.version ||
    contract.hostOwnsArchive !== true ||
    contract.automatedPublishing !== false ||
    contract.accountCredentialsAllowed !== false ||
    contract.brandSource !== "customer-company-name" ||
    contract.sourceMappingRequired !== true ||
    contract.images?.count !== definition.imageCount ||
    contract.images?.width !== definition.width ||
    contract.images?.height !== definition.height ||
    contract.images?.mimeType !== "image/png"
  ) {
    throw new Error(`SiteOps ${channel} runtime contract is invalid`);
  }
  const packageText = (
    await Promise.all(
      expected.files.map((entry) =>
        fs.readFile(path.join(root, entry.path), "utf8"),
      ),
    )
  ).join("\n");
  const forbiddenBrand = new RegExp(`GEO${"学术"}${"追踪"}`, "u");
  if (
    forbiddenBrand.test(packageText) ||
    /(?:access[_ -]?token|api[_ -]?key|session[_ -]?cookie)\s*[:=]/iu.test(
      packageText,
    )
  ) {
    throw new Error(`SiteOps ${channel} workflow contains a brand or credential`);
  }
  return {
    ...expected,
    manifestSha256: sha256(actualBytes),
  };
}

export async function verifyAllSiteOpsSocialWorkflows() {
  return Promise.all(
    Object.keys(SITEOPS_SOCIAL_WORKFLOWS).map((channel) =>
      verifySiteOpsSocialWorkflow(channel),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    for (const channel of Object.keys(SITEOPS_SOCIAL_WORKFLOWS)) {
      const definition = SITEOPS_SOCIAL_WORKFLOWS[channel];
      const manifest = await createSiteOpsSocialWorkflowManifest(channel);
      await fs.writeFile(
        path.join(
          projectRoot,
          "private-workflows",
          definition.directory,
          "MANIFEST.json",
        ),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
  }
  const verified = await verifyAllSiteOpsSocialWorkflows();
  console.log(
    `Verified ${verified.length} SiteOps social workflows: ${verified
      .map((item) => `${item.channel}@${item.version}`)
      .join(", ")}`,
  );
}
