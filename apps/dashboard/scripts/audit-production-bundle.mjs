import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { canonicalKnowledgeBaseSkillArchiveHash } from "../shared/knowledge-base-skill-archive-hash.js";
import { assertCleanProductionBuildSource } from "./assert-clean-build-source.mjs";
import { verifyBuildArtifactManifest } from "./build-artifact-identity.mjs";
import {
  createMigrationManifest,
  readMigrationManifest,
} from "./migration-manifest.mjs";
import { withoutValidatedProductionBundleBuildSourceSha } from "./production-bundle-policy-content.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const buildRoot = resolve(projectRoot, process.argv[2] || "dist");
const knowledgeBaseIncidentRepairCliSource = join(
  projectRoot,
  "server/knowledge-base-incident-repair-cli.ts",
);
const textExtensions = new Set([
  ".csv",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const forbiddenFileNames = new Set([
  "citation-distribution-20260723-171030.b64",
  "citation-distribution-20260727-101630.b64",
]);
const approvedBrandAssetNames = new Set(["cuhksz-emblem.png"]);
const approvedBrandText = [
  "/assets/cuhksz-emblem.png",
  "cuhksz-emblem.png",
  "香港中文大学（深圳）校徽",
  "香港中文大学（深圳）AI智能决策实验室",
];
const forbiddenFileNamePatterns = [
  {
    label: "encoded customer monitoring fixture",
    pattern: /\.b64$/i,
  },
  {
    label: "customer or acceptance fixture asset",
    pattern:
      /citation-distribution|cuhksz-emblem|hongxu-monitoring-fixture|acceptance-monitoring-fixture/i,
  },
  {
    label: "development-only response logic preview chunk",
    pattern: /ResponseLogicPreview/i,
  },
];

const legacyCustomerFixturePattern =
  /海天精工|taixinyimei|港中深|香港中文大学(?:（深圳）|\(深圳\))|CUHK(?:-Shenzhen)?|cuhksz|广东省录取分数线排名|北京市录取分数线及位次|宏旭|hongxu\.demo|摩托车骑行装备品牌推荐/i;
const retiredDashboardPortPattern = new RegExp(["30", "04"].join(""));
const forbiddenPatterns = [
  {
    label: "retired Dashboard port",
    pattern: retiredDashboardPortPattern,
  },
  {
    label: "preview route",
    pattern: /\/preview\/(?:admin|user)(?:\/|["'`])/,
  },
  {
    label: "preview component",
    pattern: /\bPreviewPages\b|\bPreviewAdmin(?:Users|Accounts|Presales)\b/,
  },
  {
    label: "fixed advanced/luxury price",
    pattern:
      /(?:¥|￥)?\s*(?:29,?800|89,?400)\s*(?:元)?\s*(?:\/|每)?\s*(?:季度|季)|\b(?:29800|89400|2_?980_?000|8_?940_?000)\b/,
  },
  {
    label: "fixed service price map",
    pattern: /\bWEBSITE_SERVICE_PRICE_FEN\b/,
  },
  {
    label: "example contract/order",
    pattern: /preview-luxury-(?:order|contract)/,
  },
  {
    label: "legacy tenant demo data",
    pattern: legacyCustomerFixturePattern,
  },
  {
    label: "legacy GEO demo bundle",
    pattern:
      /\bgeoAnswerBooks\b|\bglobalKeywordBank\b|\bhongxuGeoAnswerBooks\b|\bhongxuMonitoringFixtureCounts\b/,
  },
  {
    label: "development response-logic adapter",
    pattern: /\bresponseLogicPreviewAdapter\b/,
  },
  {
    label: "hardcoded response-logic preview answer",
    pattern:
      /我已载入当前问题的知识库预填内容|先给出可核验的判断，再解释判断依据与适配条件|企业知识库中已确认的品牌事实与方法依据|确认本轮补充信息的公开范围与对应权威来源/,
  },
  {
    label: "fixed response-logic preview timestamp",
    pattern: /2026-07-24T08:00:00\.000Z/,
  },
  {
    label: "hardcoded monitoring fixture URL",
    pattern: /citation-distribution-\d{8}-\d{6}\.b64/i,
  },
  {
    label: "example administrator/customer",
    pattern:
      /FrontMind 示例管理员|示例企业(?:\s*C)?|汉腾激光|preview-(?:ticket|admin|customer)/,
  },
  {
    label: "API key",
    pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/,
  },
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

function withoutApprovedBranding(content) {
  return approvedBrandText.reduce(
    (result, allowedText) => result.replaceAll(allowedText, ""),
    content,
  );
}

const requiredSkillFiles = [
  "private-workflows/socratic-kb-builder-v5.skill",
  "private-workflows/brand-question-portfolio.skill/SKILL.md",
  "private-workflows/brand-question-portfolio.skill/references/output-contract.md",
  "private-workflows/response-logic-builder.skill/SKILL.md",
  "private-workflows/response-logic-builder.skill/references/output-contract.md",
];

async function requiresKnowledgeBaseIncidentRepairCli() {
  try {
    const source = await lstat(knowledgeBaseIncidentRepairCliSource);
    if (!source.isFile()) {
      throw new Error("BUILD_INCIDENT_REPAIR_CLI_SOURCE_INVALID");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const knowledgeBaseIncidentRepairCliRequired =
  await requiresKnowledgeBaseIncidentRepairCli();
const requiredRuntimeFiles = [
  "index.js",
  ...(knowledgeBaseIncidentRepairCliRequired
    ? ["knowledge-base-incident-repair-cli.js"]
    : []),
  "pdf-prepare-worker.js",
  "release-db.js",
  "migration-manifest.json",
  "drizzle/meta/_journal.json",
  "drizzle/migration-policy.json",
  "verify-presales-file-roundtrip.js",
];
const runtimeSkillRoots = [
  "private-workflows/socratic-kb-builder-v5.skill",
  "private-workflows/brand-question-portfolio.skill",
  "private-workflows/response-logic-builder.skill",
];
const requiredKnowledgeBaseEntries = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/knowledge-tree.md",
  "references/materialized-working-set.md",
  "references/questioning-strategy.md",
  "references/output-format.md",
  "references/working-set-policy.json",
  "scripts/validate_working_set.py",
];
const allowedKnowledgeBaseArchiveEntries = new Set([
  ...requiredKnowledgeBaseEntries,
  "agents/",
  "references/",
  "scripts/",
]);

async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(path)));
    } else if (entry.isFile() && textExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

async function collectFiles(path) {
  const pathStat = await stat(path);
  if (pathStat.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectTestSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestSourceFiles(path)));
    } else if (
      entry.isFile() &&
      /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function containsJavaScriptString(bundle, value) {
  if (bundle.includes(value)) return true;
  const unicodeEscaped = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0x20 && codePoint <= 0x7e)) {
      return character;
    }
    if (codePoint <= 0xffff) {
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low
      .toString(16)
      .padStart(4, "0")}`;
  }).join("");
  return bundle.toLowerCase().includes(unicodeEscaped.toLowerCase());
}

try {
  const buildStat = await stat(buildRoot);
  if (!buildStat.isDirectory()) {
    throw new Error("dist is not a directory");
  }
} catch {
  console.error("Production bundle is missing. Run `pnpm build` first.");
  process.exit(1);
}

const artifactManifest = await verifyBuildArtifactManifest(buildRoot);
if (
  process.env.FRONTMIND_INTERNAL_RELEASE_AUDIT_STAGE &&
  process.env.FRONTMIND_INTERNAL_RELEASE_AUDIT_STAGE !==
    artifactManifest.buildSourceSha
) {
  throw new Error("BUILD_INTERNAL_AUDIT_STAGE_NOT_AUTHORIZED");
}
assertCleanProductionBuildSource({
  repositoryRoot: projectRoot,
  expectedBuildSha: artifactManifest.buildSourceSha,
  env: process.env,
});

const violations = [];
try {
  const skillRoot = join(buildRoot, "private-workflows");
  const skillNames = await readdir(skillRoot);
  const v5AliasName = "socratic-kb-builder-v5.skill";
  const v5AliasBytes = await readFile(join(skillRoot, v5AliasName));
  const canonicalHash =
    await canonicalKnowledgeBaseSkillArchiveHash(v5AliasBytes);
  const exactV5Name = `socratic-kb-builder-v5-${canonicalHash}.skill`;
  const allowedKnowledgeBaseArchives = new Set([v5AliasName, exactV5Name]);
  const knowledgeBaseArchives = skillNames.filter(
    (name) => name.startsWith("socratic-kb-builder") && name.endsWith(".skill"),
  );
  for (const name of knowledgeBaseArchives) {
    if (!allowedKnowledgeBaseArchives.has(name)) {
      violations.push({
        file: `private-workflows/${name}`,
        label: "legacy or unpinned knowledge-base Skill archive in runtime",
      });
    }
  }
  if (!skillNames.includes(exactV5Name)) {
    violations.push({
      file: `private-workflows/${exactV5Name}`,
      label: "missing exact-hash Skill v5 runtime artifact",
    });
  }
  for (const name of [v5AliasName, exactV5Name]) {
    const archivePath = join(skillRoot, name);
    const bytes = await readFile(archivePath);
    if (!bytes.equals(v5AliasBytes)) {
      violations.push({
        file: `private-workflows/${name}`,
        label: "Skill v5 alias and exact-hash artifact differ",
      });
    }
    const archive = await JSZip.loadAsync(bytes);
    const entryNames = Object.keys(archive.files);
    for (const [entryName, entry] of Object.entries(archive.files)) {
      const originalName = entry.unsafeOriginalName || entryName;
      if (
        originalName.startsWith("/") ||
        /^[A-Za-z]:/u.test(originalName) ||
        originalName.includes("\\") ||
        originalName.split("/").includes("..") ||
        !allowedKnowledgeBaseArchiveEntries.has(entryName)
      ) {
        violations.push({
          file: `${relative(projectRoot, archivePath)}:${entryName}`,
          label: "invalid Skill v5 archive entry",
        });
      }
      if (entry.dir) continue;
      const content = await entry.async("string");
      for (const rule of forbiddenPatterns) {
        if (rule.pattern.test(content)) {
          violations.push({
            file: `${relative(projectRoot, archivePath)}:${entryName}`,
            label: rule.label,
          });
        }
      }
    }
    for (const required of requiredKnowledgeBaseEntries) {
      if (!entryNames.includes(required)) {
        violations.push({
          file: relative(projectRoot, archivePath),
          label: `missing Skill entry ${required}`,
        });
      }
    }
    if (
      (await canonicalKnowledgeBaseSkillArchiveHash(bytes)) !== canonicalHash
    ) {
      violations.push({
        file: `private-workflows/${name}`,
        label: "Skill v5 artifact does not match its exact canonical hash",
      });
    }
  }
} catch {
  violations.push({
    file: "private-workflows/socratic-kb-builder-v5[-<hash>].skill",
    label: "Skill v5 runtime artifacts cannot be audited",
  });
}
for (const sourceRoot of ["client", "server"]) {
  for (const file of await collectTestSourceFiles(
    join(projectRoot, sourceRoot),
  )) {
    const content = withoutApprovedBranding(await readFile(file, "utf8"));
    if (legacyCustomerFixturePattern.test(content)) {
      violations.push({
        file: relative(projectRoot, file),
        label: "legacy customer data in test source",
      });
    }
  }
}

for (const relativePath of requiredSkillFiles) {
  try {
    const artifact = await stat(join(buildRoot, relativePath));
    if (!artifact.isFile() || artifact.size === 0) {
      throw new Error("not a non-empty file");
    }
  } catch {
    violations.push({
      file: relativePath,
      label: "missing runtime Skill artifact",
    });
  }
}

for (const relativePath of requiredRuntimeFiles) {
  try {
    const artifact = await stat(join(buildRoot, relativePath));
    if (!artifact.isFile() || artifact.size === 0) {
      throw new Error("not a non-empty file");
    }
  } catch {
    violations.push({
      file: relativePath,
      label: "missing production runtime file",
    });
  }
}

try {
  const [packagedManifest, reconstructedManifest] = await Promise.all([
    readMigrationManifest(join(buildRoot, "migration-manifest.json")),
    createMigrationManifest({ migrationsFolder: join(buildRoot, "drizzle") }),
  ]);
  if (
    packagedManifest.journalHash !== reconstructedManifest.journalHash ||
    packagedManifest.schemaHash !== reconstructedManifest.schemaHash ||
    packagedManifest.schemaSnapshot !== reconstructedManifest.schemaSnapshot
  ) {
    throw new Error("packaged migration journal or schema differs from source");
  }
} catch {
  violations.push({
    file: "migration-manifest.json",
    label: "invalid or inconsistent production migration manifest",
  });
}

for (const relativeRoot of runtimeSkillRoots) {
  const sourceRoot = join(projectRoot, relativeRoot);
  const builtRoot = join(buildRoot, relativeRoot);
  try {
    const [sourceStat, builtStat] = await Promise.all([
      stat(sourceRoot),
      stat(builtRoot),
    ]);
    if (sourceStat.isFile() !== builtStat.isFile()) {
      throw new Error("runtime Skill artifact type differs from source");
    }
    const [sourceFiles, builtFiles] = await Promise.all([
      collectFiles(sourceRoot),
      collectFiles(builtRoot),
    ]);
    const relativeFilePath = (root, file) =>
      stat(root).then((rootStat) =>
        rootStat.isFile() ? "." : relative(root, file),
      );
    const [sourceRelativeFiles, builtRelativeFiles] = await Promise.all([
      Promise.all(
        sourceFiles.map((file) => relativeFilePath(sourceRoot, file)),
      ),
      Promise.all(builtFiles.map((file) => relativeFilePath(builtRoot, file))),
    ]);
    sourceRelativeFiles.sort();
    builtRelativeFiles.sort();
    if (
      JSON.stringify(sourceRelativeFiles) !== JSON.stringify(builtRelativeFiles)
    ) {
      violations.push({
        file: relativeRoot,
        label: "runtime Skill file list differs from source",
      });
      continue;
    }
    for (const relativeFile of sourceRelativeFiles) {
      const sourceFile =
        relativeFile === "." ? sourceRoot : join(sourceRoot, relativeFile);
      const builtFile =
        relativeFile === "." ? builtRoot : join(builtRoot, relativeFile);
      const [sourceContent, builtContent] = await Promise.all([
        readFile(sourceFile),
        readFile(builtFile),
      ]);
      if (!sourceContent.equals(builtContent)) {
        violations.push({
          file:
            relativeFile === "."
              ? relativeRoot
              : `${relativeRoot}/${relativeFile}`,
          label: "runtime Skill content differs from source",
        });
      }
    }
  } catch {
    violations.push({
      file: relativeRoot,
      label: "runtime Skill artifact cannot be compared with source",
    });
  }
}

try {
  const versionPath = join(
    buildRoot,
    "public",
    "__frontmind__",
    "version.json",
  );
  const version = JSON.parse(await readFile(versionPath, "utf8"));
  if (
    typeof version.version !== "string" ||
    !/^[a-f0-9]{40}$/i.test(version.gitSha || "") ||
    version.gitSha.toLowerCase() !== artifactManifest.buildSourceSha ||
    !Number.isFinite(Date.parse(version.builtAt || "")) ||
    version.copyRevision !== "knowledge-collection-copy-v2"
  ) {
    throw new Error("invalid version fields");
  }

  const publicRoot = join(buildRoot, "public");
  const indexHtml = await readFile(join(publicRoot, "index.html"), "utf8");
  const javascriptAssets = Array.from(
    indexHtml.matchAll(/(?:src|href)=["']\/?(assets\/[^"'?]+\.js)/g),
    (match) => match[1],
  );
  if (!javascriptAssets.length) {
    throw new Error("index does not reference a hashed JavaScript asset");
  }
  const activeCopy =
    "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。";
  const [clientBundles, serverBundle] = await Promise.all([
    Promise.all(
      javascriptAssets.map((asset) =>
        readFile(join(publicRoot, asset), "utf8"),
      ),
    ),
    readFile(join(buildRoot, "index.js"), "utf8"),
  ]);
  if (!clientBundles.some((content) => content.includes(activeCopy))) {
    throw new Error("active copy is missing from loaded client assets");
  }
  if (!containsJavaScriptString(serverBundle, activeCopy)) {
    throw new Error("active copy is missing from the server bundle");
  }
  for (const releaseIdentityMarker of [
    artifactManifest.buildSourceSha,
    "/readyz",
  ]) {
    if (!serverBundle.includes(releaseIdentityMarker)) {
      throw new Error(
        `release identity marker is missing from server bundle: ${releaseIdentityMarker}`,
      );
    }
  }
  if (
    /\bfrom\s*["']vite["']|\bimport\s*\(\s*["']vite["']/u.test(serverBundle)
  ) {
    throw new Error("development Vite runtime leaked into server bundle");
  }
} catch {
  violations.push({
    file: "public/__frontmind__/version.json",
    label:
      "build identity, loaded assets, or active server copy is inconsistent",
  });
}

const allEntries = await readdir(buildRoot, {
  recursive: true,
  withFileTypes: true,
});
for (const entry of allEntries) {
  if (entry.isFile() && forbiddenFileNames.has(entry.name)) {
    violations.push({
      file: entry.name,
      label: "development-only monitoring data",
    });
  }
  if (entry.isFile()) {
    if (approvedBrandAssetNames.has(entry.name)) continue;
    for (const rule of forbiddenFileNamePatterns) {
      if (rule.pattern.test(entry.name)) {
        violations.push({
          file: entry.name,
          label: rule.label,
        });
      }
    }
  }
}
const validatedIdentityMetadata = new Set([
  "artifact-manifest.json",
  "build-source.json",
  "migration-manifest.json",
  "drizzle/meta/_journal.json",
  "drizzle/migration-policy.json",
  "public/__frontmind__/version.json",
]);
for (const file of await collectTextFiles(buildRoot)) {
  const artifactRelativePath = relative(buildRoot, file).split("\\").join("/");
  // These files are parsed and cryptographically validated above. Scanning
  // random hexadecimal hashes as prose would create probabilistic false
  // positives for numeric policy patterns such as the retired port.
  if (
    validatedIdentityMetadata.has(artifactRelativePath) ||
    /^drizzle\/meta\/\d{4}_snapshot\.json$/u.test(artifactRelativePath)
  ) {
    continue;
  }
  const content = withoutValidatedProductionBundleBuildSourceSha(
    withoutApprovedBranding(await readFile(file, "utf8")),
    artifactManifest.buildSourceSha,
  );
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(content)) {
      violations.push({
        file: relative(projectRoot, file),
        label: rule.label,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Production bundle audit failed:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.label}`);
  }
  process.exit(1);
}

console.log("Production bundle audit passed.");
