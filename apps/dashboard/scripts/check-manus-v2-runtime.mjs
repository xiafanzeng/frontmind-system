import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const toRepositoryPath = (absolutePath) =>
  path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");

async function existingFile(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next TypeScript/JavaScript resolution candidate.
    }
  }
  return null;
}

async function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  return existingFile([
    base,
    ...[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].map(
      (extension) => `${base}${extension}`,
    ),
    ...[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].map((extension) =>
      path.join(base, `index${extension}`),
    ),
  ]);
}

async function productionServerGraph() {
  const entry = path.join(repositoryRoot, "server/_core/index.ts");
  const pending = [entry];
  const reachable = new Set();
  const importPattern =
    /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?|\bimport\s*\()\s*["']([^"']+)["']/gu;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    const contents = await readFile(current, "utf8");
    for (const match of contents.matchAll(importPattern)) {
      const imported = await resolveRelativeImport(current, match[1]);
      if (imported && !reachable.has(imported)) pending.push(imported);
    }
  }
  return reachable;
}

const failures = [];
const reachable = await productionServerGraph();
const reachablePaths = new Set([...reachable].map(toRepositoryPath));

// These two files retain offline incident/audit code, but the production entry
// must never import them. Keeping the assertion here prevents an old v1 client
// from becoming reachable through an innocent-looking router registration.
for (const legacyModule of [
  "server/presales-proxy.ts",
  "server/knowledge-base-live-preview-api.ts",
]) {
  if (reachablePaths.has(legacyModule)) {
    failures.push(`LEGACY_V1_MODULE_BECAME_REACHABLE:${legacyModule}`);
  }
}

const localV1AliasFiles = new Set([
  "server/manus-proxy.ts",
  "server/_core/frontmind-proxy-policy.ts",
  "server/_core/upstream-credential.ts",
]);
const v1Endpoint = /\/v1\/(?:tasks|responses|files)(?:\/|\b)/u;
const directV1Egress = [
  /https:\/\/api\.manus\.ai\/v1\/(?:tasks|responses|files)(?:\/|\b)/u,
  /getUpstreamBaseUrl\(\)[\s\S]{0,100}\/v1\/(?:tasks|responses|files)(?:\/|\b)/u,
  /(?:fetch|axios\.(?:get|post|put|patch|delete|request))\s*\([\s\S]{0,240}\/v1\/(?:tasks|responses|files)(?:\/|\b)/u,
];

for (const absolutePath of reachable) {
  const relativePath = toRepositoryPath(absolutePath);
  const contents = await readFile(absolutePath, "utf8");
  if (v1Endpoint.test(contents) && !localV1AliasFiles.has(relativePath)) {
    failures.push(`REACHABLE_MANUS_V1_ENDPOINT:${relativePath}`);
  }
  if (directV1Egress.some((pattern) => pattern.test(contents))) {
    failures.push(`REACHABLE_MANUS_V1_NETWORK_EGRESS:${relativePath}`);
  }
}

const mountedLegacyRouter = await readFile(
  path.join(repositoryRoot, "server/manus-proxy.ts"),
  "utf8",
);
if (
  !/function\s+legacyBlindProviderProxyDisabled\(\)\s*\{\s*return true;\s*\}/u.test(
    mountedLegacyRouter,
  )
) {
  failures.push("LEGACY_BLIND_PROXY_KILL_SWITCH_NOT_CONSTANT_TRUE");
}
if (
  /(?:axios\s*\(\s*axiosConfig|axios\.request\s*\(\s*axiosConfig|fetch\s*\(\s*targetUrl)/u.test(
    mountedLegacyRouter,
  )
) {
  failures.push("LEGACY_BLIND_PROXY_NETWORK_DISPATCH_PRESENT");
}

const smokePath = path.join(
  repositoryRoot,
  "scripts/smoke-response-logic-pro.ts",
);
const smoke = await readFile(smokePath, "utf8");
if (
  !smoke.includes("ManusV2Client") ||
  !smoke.includes("structuredOutputSchema") ||
  v1Endpoint.test(smoke)
) {
  failures.push("RESPONSE_LOGIC_SMOKE_NOT_V2_ONLY");
}

// Knowledge-base runtime is v5 materialized-only. Historical columns and
// offline repair helpers stay append-only in the repository, but the mounted
// worker must reject their execution mode before any Provider preparation or
// POST and must never schedule the old local-rehydrate release sweep.
const knowledgeBaseApiSource = await readFile(
  path.join(repositoryRoot, "server/knowledge-base-api.ts"),
  "utf8",
);
const dispatchStart = knowledgeBaseApiSource.indexOf(
  "async function dispatchKnowledgeBaseRecoveryClaim(",
);
const dispatchEnd = knowledgeBaseApiSource.indexOf(
  "export const knowledgeBaseTerminalAnchorRecoveryTestHooks",
  dispatchStart,
);
const dispatchSource = knowledgeBaseApiSource.slice(dispatchStart, dispatchEnd);
const missingBuildFence = dispatchSource.indexOf("if (!existingBuild)");
const resetFence = dispatchSource.indexOf(
  "existingBuild.executionMode !==",
);
const materializedDispatch = dispatchSource.indexOf(
  "dispatchMaterializedKnowledgeBaseClaim({",
);
if (
  dispatchStart < 0 ||
  dispatchEnd <= dispatchStart ||
  missingBuildFence < 0 ||
  resetFence < 0 ||
  missingBuildFence >= resetFence ||
  !dispatchSource
    .slice(missingBuildFence, resetFence)
    .includes('"BUILD_NOT_FOUND"') ||
  !dispatchSource.includes("MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE") ||
  !dispatchSource.includes('existingBuild.skillVersion !== "5"') ||
  !dispatchSource.includes('existingBuild.providerProtocol !== "manus_v2"') ||
  materializedDispatch <= resetFence
) {
  failures.push("KNOWLEDGE_BASE_LEGACY_DISPATCH_RESET_FENCE_MISSING");
}

for (const retiredSymbol of [
  "reconcileRecoveredKnowledgeBaseTask",
  "reconcilePolledManusV2KnowledgeBaseTask",
  "repairStoppedManusV2KnowledgeBaseFormat",
  "activateKnowledgeBaseManusV2Handoff",
  "findCreatedTask",
  "task.sendMessage",
]) {
  if (knowledgeBaseApiSource.includes(retiredSymbol)) {
    failures.push(`KNOWLEDGE_BASE_RETIRED_RUNTIME_PRESENT:${retiredSymbol}`);
  }
}

const runtimeEntry = await readFile(
  path.join(repositoryRoot, "server/_core/index.ts"),
  "utf8",
);
if (runtimeEntry.includes("releaseGeneratedAttachmentInvalidPreproviderTurns")) {
  failures.push("KNOWLEDGE_BASE_LEGACY_PREPROVIDER_SWEEP_MOUNTED");
}

if (
  reachablePaths.has("server/knowledge-base-manus-v2-rollout.ts") ||
  reachablePaths.has("server/knowledge-base-active-v2-migration-core.ts") ||
  reachablePaths.has("server/knowledge-base-manus-v2-lifecycle.ts") ||
  reachablePaths.has("server/knowledge-base-incident-repair.ts")
) {
  failures.push("KNOWLEDGE_BASE_RETIRED_RECOVERY_MODULE_REACHABLE");
}

const openRecoverySource = await readFile(
  path.join(repositoryRoot, "server/knowledge-base-open-recovery-lease.ts"),
  "utf8",
);
if (
  !openRecoverySource.includes(
    'build.executionMode !== "materialized_bundle_v1"',
  ) ||
  !openRecoverySource.includes('build.skillVersion !== "5"') ||
  !openRecoverySource.includes('build.providerProtocol !== "manus_v2"')
) {
  failures.push("KNOWLEDGE_BASE_OPEN_RECOVERY_V5_FENCE_MISSING");
}

const replaceRouteStart = knowledgeBaseApiSource.indexOf(
  'router.post("/turn/replace-attachments"',
);
const retryRouteStart = knowledgeBaseApiSource.indexOf(
  'router.post("/retry"',
  replaceRouteStart,
);
const replaceRoute = knowledgeBaseApiSource.slice(
  replaceRouteStart,
  retryRouteStart,
);
const retryRouteEnd = knowledgeBaseApiSource.indexOf(
  'router.get("/progress/:conversationId"',
  retryRouteStart,
);
const retryRoute = knowledgeBaseApiSource.slice(retryRouteStart, retryRouteEnd);
if (
  replaceRouteStart < 0 ||
  retryRouteStart <= replaceRouteStart ||
  retryRouteEnd <= retryRouteStart ||
  !replaceRoute.includes("res.status(410)") ||
  !replaceRoute.includes('code: "RESET_REQUIRED"') ||
  !retryRoute.includes("res.status(410)") ||
  !retryRoute.includes('code: "RESET_REQUIRED"')
) {
  failures.push("KNOWLEDGE_BASE_RETIRED_REBUILD_ROUTES_NOT_410");
}

const turnServiceSource = await readFile(
  path.join(repositoryRoot, "server/knowledge-base-turn-service.ts"),
  "utf8",
);
const replaceServiceStart = turnServiceSource.indexOf(
  "export async function replaceKnowledgeBaseTurnAttachmentsAfterUserFix(",
);
if (replaceServiceStart >= 0) {
  failures.push("KNOWLEDGE_BASE_RETIRED_ATTACHMENT_REBUILD_SERVICE_PRESENT");
}

// Website-facing task JSON is projected by one allowlist function. Provider
// identifiers stay in the durable store and must not be copied into that DTO.
const presalesRouter = await readFile(
  path.join(repositoryRoot, "server/presales-v2-router.ts"),
  "utf8",
);
const publicTaskProjection = presalesRouter.match(
  /export function presalesV2PublicTask[\s\S]*?\n\}\n\nasync function requireActiveCredential/u,
)?.[0];
if (!publicTaskProjection) {
  failures.push("PRESALES_V2_PUBLIC_TASK_PROJECTION_MISSING");
} else if (
  /provider(?:Task|File|Event|Request)|signedUrl|signed_url|rawOutput|raw_output|upload_url|\btask_id\b|\bfile_id\b/iu.test(
    publicTaskProjection,
  )
) {
  failures.push("PRESALES_V2_PUBLIC_TASK_PROVIDER_FIELD_EXPOSED");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `MANUS_V2_RUNTIME_GOVERNANCE_OK reachableServerModules=${reachable.size} legacyAuditModules=2`,
  );
}
