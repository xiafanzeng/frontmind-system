import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import axios from "axios";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import express from "express";
import JSZip from "jszip";
import mysql, {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import sharp from "sharp";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  apiCredentials,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeImportReceipts,
  knowledgeBaseSnapshots,
  messages,
  userDashboardContents,
} from "../drizzle/schema";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import {
  canonicalPackagedKnowledgeBaseLeafMarkdown,
  knowledgeBaseMarkdownSha256,
} from "../server/knowledge-base-package-validation";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
} from "../server/knowledge-base-artifact";
import { KNOWLEDGE_BASE_FINALIZATION_INPUT_FILENAME_PREFIX } from "../server/knowledge-base-finalization-input";
import { KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME } from "../server/knowledge-base-prompt-delivery";
import {
  formatKnowledgeBaseManifestEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
} from "../server/knowledge-base-progress";
import { KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH } from "../server/knowledge-base-tree-policy-rollout";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  assertServiceCapability: vi.fn(),
  assertKnowledgeBaseWritable: vi.fn(),
  createKnowledgeMonitoringHandoff: vi.fn(),
  getCredentialForUpstreamResource: vi.fn(),
  getDecryptedCredentialForKnowledgeBaseUploadReservation: vi.fn(),
  recordUpstreamResource: vi.fn(),
  upstreamBaseUrl: "",
  userId: 0,
  credentialId: "",
  credentialFingerprint: "",
  createKnowledgeSnapshotHook: undefined as
    | ((actual: (input: any) => Promise<any>, input: any) => Promise<any>)
    | undefined,
  readKnowledgeArchiveHook: undefined as
    | ((
        actual: (...args: any[]) => Promise<any>,
        ...args: any[]
      ) => Promise<any>)
    | undefined,
  getPresalesCredentialForResourceHook: undefined as
    | ((...args: any[]) => Promise<any>)
    | undefined,
  getPresalesTaskProjectBindingHook: undefined as
    | ((...args: any[]) => Promise<any>)
    | undefined,
}));

vi.mock("../server/db", () => ({ getDb: dependencies.getDb }));

vi.mock("../server/_core/safe-external-url", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/_core/safe-external-url")>();
  return {
    ...actual,
    assertSafeExternalUrl: (value: string) => new URL(value).toString(),
    safeExternalRequestOptions: { proxy: false, maxRedirects: 0 },
  };
});

vi.mock("../server/_core/express-auth", () => ({
  requireExpressAuth: (req: any, res: any, next: () => void) => {
    if (req.header("x-test-auth") !== "user") {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    req.frontmindUser = {
      id: dependencies.userId,
      username: "frontmind-mysql-e2e",
      displayName: "FrontMind超前智能",
      role: "user",
      adminAccessLevel: null,
      engineerRoleType: null,
      marketEdition: "domestic",
      isActive: true,
    };
    req.frontmindCredential = {
      id: dependencies.credentialId,
      userId: dependencies.userId,
      version: 1,
      label: "MySQL E2E credential",
      apiKey: "sk-mysql-e2e-only",
      fingerprint: dependencies.credentialFingerprint,
    };
    next();
  },
}));

vi.mock("../server/service-entitlement", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/service-entitlement")>();
  return {
    ...actual,
    assertServiceCapability: dependencies.assertServiceCapability,
  };
});

vi.mock("../server/knowledge-base-reset-service", () => ({
  assertKnowledgeBaseWritable: dependencies.assertKnowledgeBaseWritable,
}));

vi.mock("../server/delivery-role-service", () => ({
  assertDeliveryProjectContext: vi.fn(),
  createKnowledgeMonitoringHandoff:
    dependencies.createKnowledgeMonitoringHandoff,
}));

vi.mock("../server/auth-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/auth-service")>();
  return {
    ...actual,
    getCredentialForUpstreamResource:
      dependencies.getCredentialForUpstreamResource,
    getDecryptedCredentialForKnowledgeBaseUploadReservation:
      dependencies.getDecryptedCredentialForKnowledgeBaseUploadReservation,
    recordUpstreamResource: dependencies.recordUpstreamResource,
  };
});

vi.mock("../server/upstream-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/upstream-config")>();
  return {
    ...actual,
    getUpstreamBaseUrl: () => dependencies.upstreamBaseUrl,
    getFrontMindCredentials: (req: any) => ({
      apiKey: req.frontmindCredential?.apiKey || "",
      baseUrl: dependencies.upstreamBaseUrl,
    }),
  };
});

vi.mock("../server/dashboard-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/dashboard-service")>();
  return {
    ...actual,
    createKnowledgeSnapshot: (input: any) =>
      dependencies.createKnowledgeSnapshotHook
        ? dependencies.createKnowledgeSnapshotHook(
            actual.createKnowledgeSnapshot,
            input,
          )
        : actual.createKnowledgeSnapshot(input),
  };
});

vi.mock("../server/dashboard-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/dashboard-api")>();
  return {
    ...actual,
    readKnowledgeArchive: (...args: any[]) =>
      dependencies.readKnowledgeArchiveHook
        ? dependencies.readKnowledgeArchiveHook(
            actual.readKnowledgeArchive,
            ...args,
          )
        : actual.readKnowledgeArchive(...args),
  };
});

vi.mock("../server/presales-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/presales-service")>();
  return {
    ...actual,
    getPresalesCredentialForResource: (...args: any[]) =>
      dependencies.getPresalesCredentialForResourceHook
        ? dependencies.getPresalesCredentialForResourceHook(...args)
        : actual.getPresalesCredentialForResource(...args),
    getPresalesTaskProjectBinding: (...args: any[]) =>
      dependencies.getPresalesTaskProjectBindingHook
        ? dependencies.getPresalesTaskProjectBindingHook(...args)
        : actual.getPresalesTaskProjectBinding(...args),
  };
});

const ACCEPTANCE_ENV = "FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_KB_MYSQL_ACCEPTANCE_REQUIRED";
const DATABASE_MARKER = "frontmind_kb_acceptance";
const REPOSITORY_ROOT = path.resolve(process.cwd());
const PUBLIC_CONVERSATION_ID_PREFIX = "kb-mysql-e2e";
const FINAL_REVISION = 8;
const FINALIZATION_INPUT_FILENAME_PATTERN = new RegExp(
  `^${KNOWLEDGE_BASE_FINALIZATION_INPUT_FILENAME_PREFIX}-[a-f0-9]{16}\\.zip$`,
  "u",
);

type AcceptanceTarget = { url: string; databaseName: string };

export function parseKnowledgeBaseMysqlE2eAcceptanceTarget(
  rawValue: string | undefined,
): AcceptanceTarget {
  const value = rawValue?.trim();
  if (!value) throw new Error(`${ACCEPTANCE_ENV}_MISSING`);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_INVALID`);
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error(`${ACCEPTANCE_ENV}_MUST_USE_MYSQL`);
  }
  if (
    [...parsed.searchParams.keys()].some((key) =>
      ["database", "schema", "db"].includes(key.toLowerCase()),
    )
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_OVERRIDE_FORBIDDEN`);
  }

  const encodedDatabaseName = parsed.pathname.replace(/^\/+/, "");
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(encodedDatabaseName);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_INVALID`);
  }
  if (
    !databaseName ||
    databaseName.includes("/") ||
    !/^[A-Za-z0-9_$-]+$/u.test(databaseName) ||
    !databaseName.toLowerCase().includes(DATABASE_MARKER)
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_NOT_DISPOSABLE`);
  }
  return { url: value, databaseName };
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function effectiveCharacterCount(value: string) {
  return Array.from(
    value
      .replace(/\s/gu, "")
      .replace(
        /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/gu,
        "",
      ),
  ).length;
}

function formalDocument(title: string, narrative: string) {
  return `# ${title}

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## ${title}

${narrative}

<!-- FRONTMIND_FORMAL_CONTENT_END -->
`;
}

async function createFinalPackageFixture(input?: {
  officialLogoSourceAssetUrl?: string;
}) {
  const root = "FrontMind超前智能_knowledge_base";
  const zip = new JSZip();
  const logo = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: "#173c36",
    },
  })
    .png()
    .toBuffer();
  const logoSha256 = sha256(logo);
  const documents: Array<Record<string, unknown>> = [];
  const supporting = [
    ["README.md", "FrontMind超前智能 企业知识库"],
    ["00_knowledge_tree.md", "#"],
    ["00_crawl_coverage_report.md", "#"],
    ["00_web_intelligence_report.md", "#"],
    ["00_source_index.md", "#"],
    ["09_media_assets/asset_inventory.md", "#"],
    ["10_reference_assets/reference_asset_inventory.md", "#"],
  ] as const;
  for (const [index, [relativePath, content]] of supporting.entries()) {
    zip.file(`${root}/${relativePath}`, content);
    documents.push({
      id: `support-${index + 1}`,
      path: relativePath,
      kind: "index",
      title: relativePath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    });
  }

  const overviewNarrative = `FrontMind超前智能${"总".repeat(70)}`;
  const overviewPath = "branches/products/00_overview.md";
  zip.file(
    `${root}/${overviewPath}`,
    formalDocument("产品与服务综述", overviewNarrative),
  );
  documents.push({
    id: "overview-products",
    path: overviewPath,
    kind: "overview",
    title: "产品与服务综述",
    branchId: "products",
    branchTitle: "产品与服务",
    order: 100,
    evidenceStatus: "needs_verification",
    sourceIds: [],
    evidenceDocumentIds: [],
    assetIds: [],
    customerVisible: true,
    evidenceCharacters: 0,
    requiredFormalCharacters: 60,
    contentStatus: "needs_verification",
  });

  const leaves: Array<{
    id: string;
    title: string;
    raw: string;
    contentMarkdown: string;
  }> = [];
  for (let index = 0; index < FINAL_REVISION; index += 1) {
    const id = `1.${index + 1}`;
    const title = `知识节点 ${index + 1}`;
    const narrative = `FrontMind超前智能${String.fromCodePoint(
      0x7532 + index,
    ).repeat(55)}`;
    const raw = formalDocument(`${id} ${title}`, narrative);
    const relativePath = `branches/products/leaf-${index + 1}.md`;
    zip.file(`${root}/${relativePath}`, raw);
    documents.push({
      id,
      path: relativePath,
      kind: "leaf",
      title,
      branchId: "products",
      branchTitle: "产品与服务",
      productFamilyId: "frontmind-enterprise-ai",
      order: index,
      evidenceStatus: "needs_verification",
      sourceIds: [],
      evidenceDocumentIds: [],
      assetIds: index === 0 ? ["official-logo"] : [],
      customerVisible: true,
      evidenceCharacters: 0,
      requiredFormalCharacters: 40,
      contentStatus: "needs_verification",
    });
    leaves.push({
      id,
      title,
      raw,
      contentMarkdown: canonicalPackagedKnowledgeBaseLeafMarkdown(raw),
    });
  }

  const logoPath = "09_media_assets/frontmind-logo.png";
  zip.file(`${root}/${logoPath}`, logo);
  const asset = {
    id: "official-logo",
    path: logoPath,
    sha256: logoSha256,
    mimeType: "image/png",
    bytes: logo.length,
    width: 256,
    height: 256,
    caption: "FrontMind超前智能官方主 Logo",
    alt: "FrontMind超前智能 Logo",
    branchId: "products",
    documentIds: ["1.1"],
    sourcePageUrl: "https://www.frontmind.net/",
    sourceAssetUrl:
      input?.officialLogoSourceAssetUrl ||
      "https://www.frontmind.net/frontmind-logo.png",
    sourceKind: "official_web",
    ownership: "first_party",
    assetType: "brand_identity",
    displayRole: "badge",
  };
  const assets = [asset];
  const customerVisibleCharacters =
    effectiveCharacterCount(overviewNarrative) +
    leaves.reduce((total, _leaf, index) => {
      const narrative = `FrontMind超前智能${String.fromCodePoint(
        0x7532 + index,
      ).repeat(55)}`;
      return total + effectiveCharacterCount(narrative);
    }, 0);

  zip.file(
    `${root}/00_completeness.json`,
    JSON.stringify({
      counts: {
        totalLeaves: FINAL_REVISION,
        verifiedFirstParty: 0,
        verifiedAuthoritative: 0,
        supportedThirdParty: 0,
        inferred: 0,
        needsVerification: FINAL_REVISION,
        notApplicable: 0,
      },
      acquisition: {
        officialPages: { completed: 1, total: 1 },
        images: { completed: 1, total: 1 },
        documents: { completed: 0, total: 0 },
        webQueries: { completed: 0, total: 0 },
      },
      gaps: [],
      evaluatedAt: "2026-08-01T00:00:00.000Z",
    }),
  );
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 4,
      profile: "dashboard-enterprise-v1",
      buildRevision: FINAL_REVISION,
      documents,
      assets,
      counts: {
        totalFiles: documents.length + assets.length + 2,
        customerVisibleCharacters,
        evidenceCharacters: effectiveCharacterCount(supporting[0][1]),
        packagedImages: 1,
      },
      imageSelection: {
        status: "target_met",
        discoveredCandidateImages: 1,
        inspectedCandidateImages: 1,
        eligibleFirstPartyImages: 1,
        rejectedCandidateImages: 0,
        scannedSourcePages: 1,
        discoveryMethods: ["img"],
        candidates: [
          {
            url: asset.sourceAssetUrl,
            sourcePageUrl: asset.sourcePageUrl,
            method: "img",
            status: "eligible",
            assetId: asset.id,
          },
        ],
        rejectionReasons: [],
        stopReason: "已核验官方主 Logo",
      },
    }),
  );

  return {
    archive: await zip.generateAsync({ type: "nodebuffer" }),
    logo,
    logoSha256,
    leaves,
  };
}

async function listen(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function waitForMysqlRowLockWaiters(
  pool: Pool,
  minimum: number,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT CAST(w.REQUESTING_ENGINE_TRANSACTION_ID AS CHAR) AS transactionId,
              requested.OBJECT_NAME AS objectName,
              requested.INDEX_NAME AS indexName,
              requested.LOCK_MODE AS lockMode,
              requested.LOCK_DATA AS lockData
         FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA = DATABASE()
          AND requested.OBJECT_NAME = 'knowledge_base_builds'`,
    );
    const transactionIds = new Set(
      rows.map((row) => String(row.transactionId || "")).filter(Boolean),
    );
    if (transactionIds.size >= minimum) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`MYSQL_ROW_LOCK_BARRIER_TIMEOUT:${minimum}`);
}

describe("knowledge-base MySQL E2E acceptance URL guard", () => {
  it("accepts only an explicitly named disposable MySQL acceptance database", () => {
    expect(
      parseKnowledgeBaseMysqlE2eAcceptanceTarget(
        "mysql://tester:secret@127.0.0.1:3306/frontmind_kb_acceptance_ci_01",
      ).databaseName,
    ).toBe("frontmind_kb_acceptance_ci_01");

    for (const unsafe of [
      undefined,
      "postgres://tester:secret@127.0.0.1/frontmind_kb_acceptance",
      "mysql://tester:secret@127.0.0.1/frontmind_production",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance/other",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance?database=frontmind_production",
    ]) {
      expect(() =>
        parseKnowledgeBaseMysqlE2eAcceptanceTarget(unsafe),
      ).toThrow();
    }
  });
});

const acceptanceUrl = process.env[ACCEPTANCE_ENV]?.trim();
if (process.env[REQUIRED_ENV] === "1" && !acceptanceUrl) {
  throw new Error(`${ACCEPTANCE_ENV}_REQUIRED_FOR_RELEASE_GATE`);
}
const mysqlDescribe = acceptanceUrl ? describe.sequential : describe.skip;

mysqlDescribe(
  "knowledge-base production controllers on disposable real MySQL",
  () => {
    let pool: Pool;
    let executor: ReturnType<typeof drizzle>;
    let assetRoot = "";
    let upstreamServer: Server | undefined;
    let dashboardServer: Server | undefined;
    let userId: number | null = null;
    let acceptancePassed = false;
    const runId = randomUUID().replaceAll("-", "");
    const publicConversationId = `${PUBLIC_CONVERSATION_ID_PREFIX}-${runId}`;
    const credentialId = randomUUID();
    const upstreamApiKey = "sk-mysql-e2e-only";
    const credentialFingerprint = `fp_${sha256(upstreamApiKey).slice(0, 16)}`;
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    const previousRolloutPercent = process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT;
    const previousTreePolicyWriter =
      process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
    const previousManusV2Writer = process.env.FRONTMIND_KB_MANUS_V2_WRITER;
    const previousAxiosAdapter = axios.defaults.adapter;
    const stagedImportAssets = new Map<string, string>();

    async function createCompletedWebsiteProvision(projectId: string) {
      const identity = sha256(projectId);
      await pool.execute(
        `INSERT INTO website_user_provisions
           (id, idempotencyKeyHash, requestHash, projectId, companyName,
            orderId, tradeNo, amountFen, paidAt, serviceCategory,
            questionId, question, contractTemplateVersion,
            contractDocumentSha256, requestedUsername,
            requestedDisplayName, userId, status, completedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), 'product_scenario',
                 ?, ?, 'mysql-e2e-v1', ?, ?, ?, ?, 'completed', NOW())`,
        [
          randomUUID(),
          identity,
          sha256(`request:${projectId}`),
          projectId,
          "FrontMind超前智能",
          `order-${identity.slice(0, 24)}`,
          `trade-${identity.slice(0, 48)}`,
          `question-${identity.slice(0, 24)}`,
          "知识库导入并发验收",
          sha256(`contract:${projectId}`),
          `kb_${identity.slice(0, 20)}`,
          "FrontMind超前智能",
          userId,
        ],
      );
    }

    async function createKnowledgeImportHarness(label: string) {
      const projectId = `kb-import-${label}-${runId}`.slice(0, 80);
      const taskId = `task-${label}-${runId}`;
      const outputItemId = `output-${label}`;
      const fileId = `file-${label}`;
      const filename = `${label}.zip`;
      const zip = new JSZip();
      zip.file("fixture.txt", `FrontMind ${label}`);
      const archive = await zip.generateAsync({ type: "nodebuffer" });
      const output = [
        {
          id: outputItemId,
          type: "output_file",
          file_id: fileId,
          filename,
          mime_type: "application/zip",
        },
      ];
      const descriptor = collectKnowledgeArchiveDescriptors(output)[0]!;
      const descriptorHash = knowledgeArchiveDescriptorHash(descriptor);

      await createCompletedWebsiteProvision(projectId);
      const upstream = express();
      upstream.get("/v1/tasks/:taskId", (req, res) => {
        res.json({
          task: {
            id: req.params.taskId,
            status: "completed",
            output,
          },
        });
      });
      upstream.get("/v1/files/:fileId/content", (_req, res) => {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", String(archive.length));
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.send(archive);
      });
      const listener = await listen(upstream);
      dependencies.upstreamBaseUrl = listener.baseUrl;
      dependencies.getPresalesTaskProjectBindingHook = async (
        requestedTaskId: string,
      ) =>
        requestedTaskId === taskId
          ? {
              projectId,
              apiCredentialId: credentialId,
              credentialVersion: 1,
              taskId,
            }
          : null;
      dependencies.getPresalesCredentialForResourceHook = async (
        resourceType: string,
        requestedTaskId: string,
      ) =>
        resourceType === "task" && requestedTaskId === taskId
          ? {
              id: credentialId,
              version: 1,
              apiKey: upstreamApiKey,
            }
          : null;
      dependencies.readKnowledgeArchiveHook = async (
        _actual,
        _buffer: Buffer,
        _sourceFileName: string,
        snapshotId: string,
      ) => {
        const assetKey = `mysql-import-${snapshotId}.bin`;
        const bytes = Buffer.from(`asset:${snapshotId}`, "utf8");
        await mkdir(assetRoot, { recursive: true });
        await writeFile(path.join(assetRoot, assetKey), bytes);
        stagedImportAssets.set(snapshotId, assetKey);
        return {
          storedAssetKeys: [assetKey],
          documents: [
            {
              id: `readme-${snapshotId}`,
              path: "README.md",
              title: "FrontMind超前智能",
              content: "FrontMind超前智能知识库导入并发验收",
              kind: "overview",
              customerVisible: true,
            },
          ],
          assets: [
            {
              id: `asset-${snapshotId}`,
              key: assetKey,
              path: "assets/fixture.bin",
              mimeType: "application/octet-stream",
              size: bytes.length,
              sha256: sha256(bytes),
            },
          ],
        };
      };

      return {
        projectId,
        taskId,
        archive,
        request: {
          projectId,
          idempotencyKey: `idempotency-${label}-${runId}`,
          value: {
            schemaVersion: 2 as const,
            companyName: "FrontMind超前智能",
            taskId,
            outputItemId,
            fileId,
            descriptorHash,
            artifactSha256: sha256(archive),
            filename,
          },
        },
        close: () => close(listener.server),
      };
    }

    afterEach(() => {
      dependencies.createKnowledgeSnapshotHook = undefined;
      dependencies.readKnowledgeArchiveHook = undefined;
      dependencies.getPresalesCredentialForResourceHook = undefined;
      dependencies.getPresalesTaskProjectBindingHook = undefined;
    });

    beforeAll(async () => {
      const target = parseKnowledgeBaseMysqlE2eAcceptanceTarget(acceptanceUrl);
      pool = mysql.createPool({
        uri: target.url,
        connectionLimit: 16,
        multipleStatements: false,
      });
      const [databaseRows] = await pool.query<RowDataPacket[]>(
        "SELECT DATABASE() AS databaseName",
      );
      expect(String(databaseRows[0]?.databaseName || "")).toBe(
        target.databaseName,
      );
      const [preMigrationRows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS tableCount
           FROM information_schema.tables
          WHERE table_schema = DATABASE()`,
      );
      if (Number(preMigrationRows[0]?.tableCount || 0) !== 0) {
        throw new Error(`${ACCEPTANCE_ENV}_DATABASE_MUST_BE_EMPTY`);
      }

      executor = drizzle(pool);
      await migrate(executor, {
        migrationsFolder: path.join(REPOSITORY_ROOT, "drizzle"),
      });
      const journal = JSON.parse(
        await readFile(
          path.join(REPOSITORY_ROOT, "drizzle/meta/_journal.json"),
          "utf8",
        ),
      ) as { entries: Array<{ tag?: string }> };
      const [ledgerRows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
      );
      expect(Number(ledgerRows[0]?.migrationCount || 0)).toBe(
        journal.entries.length,
      );
      // Anchor this E2E to the knowledge/API migration chain instead of the
      // moving journal tail, which may contain newer unrelated migrations.
      expect(journal.entries.slice(45, 49).map((entry) => entry.tag)).toEqual([
        "0045_knowledge_base_state_machine",
        "0046_api_usage_snapshot_claims",
        "0047_api_usage_task_ledger",
        "0048_api_usage_coverage_claims",
      ]);

      const [engineRows] = await pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS tableName, ENGINE AS engine
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN (
              'knowledge_base_builds', 'knowledge_base_build_nodes',
              'conversation_turns', 'conversations',
              'knowledge_base_snapshots'
            )`,
      );
      expect(engineRows).toHaveLength(5);
      expect(engineRows.every((row) => row.engine === "InnoDB")).toBe(true);

      const [userResult] = await pool.execute<ResultSetHeader>(
        `INSERT INTO users
           (openId, username, displayName, role, marketEdition, isActive)
         VALUES (?, ?, ?, 'user', 'domestic', 1)`,
        [
          `kb-mysql-e2e-${runId}`.slice(0, 64),
          `kb_mysql_e2e_${runId}`.slice(0, 64),
          "FrontMind超前智能",
        ],
      );
      userId = userResult.insertId;
      dependencies.userId = userId;
      dependencies.credentialId = credentialId;
      dependencies.credentialFingerprint = credentialFingerprint;

      await executor.insert(apiCredentials).values({
        id: credentialId,
        userId,
        version: 1,
        encryptionVersion: 1,
        encryptedKey: "acceptance-only-not-a-real-secret",
        encryptionIv: "0".repeat(32),
        encryptionAuthTag: "0".repeat(32),
        fingerprint: credentialFingerprint,
        status: "active",
        validationStatus: "verified",
        verifiedAt: new Date(),
      });
      await executor.insert(userDashboardContents).values({
        userId,
        payload: createDefaultDashboardPayload("FrontMind超前智能"),
        sourceName: "mysql-e2e-dashboard.json",
        enterpriseIdentityBoundAt: new Date(),
        revision: 1,
      });

      dependencies.getDb.mockResolvedValue(executor);
      dependencies.assertServiceCapability.mockResolvedValue(undefined);
      dependencies.assertKnowledgeBaseWritable.mockResolvedValue(undefined);
      dependencies.createKnowledgeMonitoringHandoff.mockResolvedValue({
        created: [],
        assigned: false,
      });
      const decryptedCredential = {
        id: credentialId,
        userId,
        version: 1,
        apiKey: upstreamApiKey,
        fingerprint: credentialFingerprint,
        status: "active",
        validationStatus: "verified",
      };
      dependencies.getCredentialForUpstreamResource.mockResolvedValue(
        decryptedCredential,
      );
      dependencies.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockResolvedValue(
        decryptedCredential,
      );
      dependencies.recordUpstreamResource.mockResolvedValue(undefined);

      assetRoot = await mkdtemp(path.join(tmpdir(), "frontmind-kb-mysql-e2e-"));
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
      process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = "100";
      process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER = "false";
      // This fixture deliberately preserves legacy transport coverage. The
      // separate v2 acceptance owns the create-once/send-many contract.
      process.env.FRONTMIND_KB_MANUS_V2_WRITER = "false";
      axios.defaults.adapter = "http";
    }, 300_000);

    afterAll(async () => {
      let cleanupError: unknown;
      const preserveCleanupError = (error: unknown) => {
        if (!cleanupError) cleanupError = error;
      };
      const serverClosures = await Promise.allSettled([
        close(upstreamServer),
        close(dashboardServer),
      ]);
      for (const result of serverClosures) {
        if (result.status === "rejected") {
          preserveCleanupError(result.reason);
        }
      }
      try {
        if (pool && userId) {
          // Generated skill uploads are durably recorded in the security
          // ownership ledger. That ledger intentionally RESTRICTs credential
          // deletion, so remove the account-owned ledger rows before deleting
          // the credential (the same ordering used by managed-user deletion).
          await pool.execute(
            "DELETE FROM upstream_resources WHERE userId = ?",
            [userId],
          );
          await pool.execute(
            "UPDATE knowledge_base_builds SET publishedSnapshotId = NULL WHERE userId = ?",
            [userId],
          );
          await pool.execute(
            "DELETE FROM knowledge_base_snapshots WHERE userId = ?",
            [userId],
          );
          await pool.execute(
            "DELETE FROM knowledge_base_builds WHERE userId = ?",
            [userId],
          );
          await pool.execute("DELETE FROM conversations WHERE userId = ?", [
            userId,
          ]);
          await pool.execute(
            "DELETE FROM user_dashboard_contents WHERE userId = ?",
            [userId],
          );
          await pool.execute("DELETE FROM api_credentials WHERE userId = ?", [
            userId,
          ]);
          await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
          const [remaining] = await pool.query<RowDataPacket[]>(
            `SELECT
               (SELECT COUNT(*) FROM users WHERE id = ?) AS users,
               (SELECT COUNT(*) FROM knowledge_base_builds WHERE userId = ?) AS builds,
               (SELECT COUNT(*) FROM conversations WHERE userId = ?) AS conversations,
               (SELECT COUNT(*) FROM knowledge_base_snapshots WHERE userId = ?) AS snapshots,
               (SELECT COUNT(*) FROM upstream_resources WHERE userId = ?) AS resources,
               (SELECT COUNT(*) FROM api_credentials WHERE userId = ?) AS credentials`,
            [userId, userId, userId, userId, userId, userId],
          );
          expect(remaining[0]).toMatchObject({
            users: 0,
            builds: 0,
            conversations: 0,
            snapshots: 0,
            resources: 0,
            credentials: 0,
          });
        }
      } catch (error) {
        preserveCleanupError(error);
      }

      try {
        if (pool) await pool.end();
      } catch (error) {
        preserveCleanupError(error);
      }
      try {
        if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
      } catch (error) {
        preserveCleanupError(error);
      }
      axios.defaults.adapter = previousAxiosAdapter;
      if (previousAssetRoot === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
      }
      if (previousRolloutPercent === undefined) {
        delete process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT;
      } else {
        process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = previousRolloutPercent;
      }
      if (previousTreePolicyWriter === undefined) {
        delete process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
      } else {
        process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER =
          previousTreePolicyWriter;
      }
      if (previousManusV2Writer === undefined) {
        delete process.env.FRONTMIND_KB_MANUS_V2_WRITER;
      } else {
        process.env.FRONTMIND_KB_MANUS_V2_WRITER = previousManusV2Writer;
      }
      if (cleanupError) throw cleanupError;
      if (acceptancePassed) {
        console.log("KB_MYSQL_E2E_ACCEPTANCE_COMPLETE");
      }
    }, 120_000);

    it("runs the legacy v1 start/turn/reconcile/publish/view/download path for all eight leaves", async () => {
      expect(userId).not.toBeNull();
      const upstream = express();
      upstream.use(express.json({ limit: "5mb" }));
      const upstreamListener = await listen(upstream);
      upstreamServer = upstreamListener.server;
      const upstreamBaseUrl = upstreamListener.baseUrl;
      dependencies.upstreamBaseUrl = upstreamBaseUrl;
      const fixture = await createFinalPackageFixture({
        officialLogoSourceAssetUrl: `${upstreamBaseUrl}/v1/files/file-official-logo/content`,
      });
      const archiveSha256 = sha256(fixture.archive);
      const finalTaskId = `task-final-package-${runId}`;
      const taskResults = new Map<
        string,
        { status: "awaiting_input" | "completed"; output: unknown[] }
      >();
      const operationTaskPosts = new Map<string, number>();
      const uploadedFileBytes = new Map<string, number>();
      const uploadedFileNames = new Map<string, string>();
      let uploadedFileSequence = 0;
      let authoritativeTaskReads = 0;
      let logoDownloads = 0;
      let packageDownloads = 0;
      let initialOperationId = "";
      let initialTurnId = "";
      upstream.post("/v1/files", (req, res) => {
        expect(req.header("api_key")).toBe(upstreamApiKey);
        expect(req.header("authorization")).toBeUndefined();
        const filename = String(req.body.filename || "");
        expect(
          filename === "socratic-kb-builder.skill.zip" ||
            filename === KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME ||
            FINALIZATION_INPUT_FILENAME_PATTERN.test(filename),
        ).toBe(true);
        const kind = filename.startsWith("socratic-")
          ? "skill"
          : filename.includes("finalization")
            ? "finalization"
            : "instructions";
        const fileId = `uploaded-${kind}-${++uploadedFileSequence}`;
        uploadedFileNames.set(fileId, filename);
        res.json({
          id: fileId,
          upload_url: `${upstreamBaseUrl}/uploads/${fileId}`,
        });
      });
      upstream.put(
        "/uploads/:fileId",
        express.raw({ type: "*/*", limit: "50mb" }),
        (req, res) => {
          expect(req.header("authorization")).toBeUndefined();
          const byteLength = Buffer.isBuffer(req.body) ? req.body.length : 0;
          expect(byteLength).toBeGreaterThan(0);
          uploadedFileBytes.set(req.params.fileId, byteLength);
          res.status(200).end();
        },
      );
      upstream.get("/v1/files/:fileId", (req, res) => {
        expect(req.header("api_key")).toBe(upstreamApiKey);
        expect(req.header("authorization")).toBeUndefined();
        const filename = uploadedFileNames.get(req.params.fileId);
        if (!filename) {
          res.status(404).json({ error: "fixture file missing" });
          return;
        }
        res.json({
          id: req.params.fileId,
          filename,
          status: uploadedFileBytes.has(req.params.fileId)
            ? "uploaded"
            : "pending",
        });
      });
      upstream.post("/v1/tasks", async (req, res, next) => {
        try {
          expect(req.header("api_key")).toBe(upstreamApiKey);
          expect(req.header("authorization")).toBeUndefined();
          expect(req.header("idempotency-key")).toBeUndefined();
          expect(Object.keys(req.body).sort()).toEqual([
            "agentProfile",
            "attachments",
            "prompt",
          ]);
          expect(req.body.agentProfile).toBe("manus-1.6-max");
          expect(req.body.taskId).toBeUndefined();
          expect(req.body.taskMode).toBeUndefined();
          const prompt = String(req.body.prompt || "");
          expect(Array.from(prompt).length).toBeLessThanOrEqual(3_000);
          const operationId =
            prompt.match(/"operationId":"([^"]+)"/u)?.[1] ||
            prompt.match(/operationId=([^；;\s]+)/u)?.[1];
          const turnId =
            prompt.match(/"turnId":"([^"]+)"/u)?.[1] ||
            prompt.match(/turnId=([^。；;\s]+)/u)?.[1];
          expect(operationId).toBeTruthy();
          expect(turnId).toBeTruthy();
          const turn = (
            await executor
              .select()
              .from(conversationTurns)
              .where(eq(conversationTurns.id, turnId!))
              .limit(1)
          )[0];
          expect(turn).toMatchObject({
            operationKey: operationId,
            status: "running",
          });
          expect((turn.metadata as any)?.attachmentsFrozen).toBe(true);
          expect(turn.attachmentFileIds).toEqual(
            req.body.attachments.map((attachment: any) => attachment.file_id),
          );
          const systemInputAttachment = req.body.attachments.find(
            (attachment: any) =>
              attachment.filename === KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME ||
              FINALIZATION_INPUT_FILENAME_PATTERN.test(attachment.filename),
          );
          expect(systemInputAttachment).toBeTruthy();
          expect(
            uploadedFileBytes.get(systemInputAttachment.file_id),
          ).toBeGreaterThan(0);
          operationTaskPosts.set(
            operationId!,
            (operationTaskPosts.get(operationId!) || 0) + 1,
          );

          const revision = Number(turn.expectedRevision);
          const isStart = turn.operationType === "start";
          const isFinal = !isStart && revision === FINAL_REVISION - 1;

          const taskId = isStart
            ? `task-initial-manifest-${runId}`
            : isFinal
              ? finalTaskId
              : `task-confirm-${revision + 1}-${runId}`;
          let output: unknown[];
          if (isStart) {
            initialOperationId = operationId!;
            initialTurnId = turnId!;
            const manifest = formatKnowledgeBaseManifestEnvelope({
              kind: "frontmind.knowledge-base.manifest",
              schemaVersion: 2,
              operationId: operationId!,
              turnId: turnId!,
              officialLogo: {
                sourceKind: "official_web",
                sourcePageUrl: "https://www.frontmind.net/",
                sourceAssetUrl: `${upstreamBaseUrl}/v1/files/file-official-logo/content`,
              },
              leaves: fixture.leaves.map((leaf) => ({
                id: leaf.id,
                title: leaf.title,
                branchId: "products",
                branchTitle: "产品与服务",
              })),
            });
            output = [
              {
                id: "assistant-initial",
                role: "assistant",
                type: "output_message",
                content: [
                  {
                    type: "output_text",
                    text: {
                      value: `${fixture.leaves[0]!.contentMarkdown}\n${manifest}`,
                    },
                  },
                ],
              },
              {
                id: "official-logo-output",
                type: "output_image",
                file_id: "file-official-logo",
                file_name: "frontmind-logo.png",
                mime_type: "image/png",
              },
            ];
          } else {
            const leaf = fixture.leaves[revision]!;
            const progress = formatKnowledgeBaseProgressEnvelope({
              kind: "frontmind.knowledge-base.progress",
              schemaVersion: 2,
              operationId: operationId!,
              turnId: turnId!,
              revision,
              transition: {
                leafId: leaf.id,
                from: "current",
                to: "confirmed",
                reason: `用户明确确认节点 ${leaf.id}`,
              },
            });
            const presentation = formatKnowledgeBasePresentationEnvelope({
              kind: "frontmind.knowledge-base.presentation",
              schemaVersion: 2,
              operationId: operationId!,
              turnId: turnId!,
              revision: revision + 1,
              leafId: isFinal ? null : fixture.leaves[revision + 1]!.id,
              imageState: isFinal ? "not_applicable" : "no_eligible_asset",
              assetIds: [],
              imageCount: 0,
            });
            const currentOperationOutput: unknown[] = [
              {
                id: `assistant-confirm-${revision + 1}`,
                role: "assistant",
                type: "output_message",
                content: [
                  {
                    type: "output_text",
                    text: {
                      value: [
                        isFinal
                          ? `${leaf.id} 已确认。`
                          : fixture.leaves[revision + 1]!.contentMarkdown,
                        progress,
                        presentation,
                      ].join("\n"),
                    },
                  },
                  ...(isFinal
                    ? [
                        {
                          type: "output_file",
                          file_id: "file-final-package",
                          file_name: "frontmind-knowledge-base.zip",
                          mime_type: "application/zip",
                        },
                      ]
                    : []),
                ],
              },
            ];
            output = isFinal
              ? [
                  {
                    id: "stale-package-from-cumulative-history",
                    type: "output_file",
                    file_id: "file-stale-package",
                    file_name: "stale-knowledge-base.zip",
                    mime_type: "application/zip",
                    operationId: initialOperationId,
                    turnId: initialTurnId,
                  },
                  ...currentOperationOutput,
                ]
              : currentOperationOutput;
            expect(JSON.stringify(output)).not.toMatch(
              /output_image|image\/(?:png|jpeg|webp)|!\[[^\]]*\]\(/u,
            );
          }

          const result = {
            id: taskId,
            status: (isFinal ? "completed" : "awaiting_input") as
              | "completed"
              | "awaiting_input",
            output,
          };
          taskResults.set(taskId, { status: result.status, output });
          res.json(result);
        } catch (error) {
          next(error);
        }
      });
      upstream.get("/v1/tasks/:taskId", (req, res) => {
        authoritativeTaskReads += 1;
        expect(req.header("authorization")).toBe(`Bearer ${upstreamApiKey}`);
        const result = taskResults.get(req.params.taskId);
        if (!result) {
          res.status(404).json({ error: "fixture task missing" });
          return;
        }
        res.json({ id: req.params.taskId, ...result });
      });
      upstream.get("/v1/files/file-official-logo/content", (req, res) => {
        logoDownloads += 1;
        expect(req.header("authorization")).toBe(`Bearer ${upstreamApiKey}`);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", String(fixture.logo.length));
        res.send(fixture.logo);
      });
      upstream.get("/v1/files/file-final-package/content", (req, res) => {
        packageDownloads += 1;
        expect(req.header("authorization")).toBe(`Bearer ${upstreamApiKey}`);
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", String(fixture.archive.length));
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="frontmind-knowledge-base.zip"',
        );
        res.send(fixture.archive);
      });
      upstream.use(
        (
          error: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          res.status(500).json({
            error: error instanceof Error ? error.message : "fixture failure",
          });
        },
      );

      const { default: dashboardRouter, readKnowledgeArchive } = await import(
        "../server/dashboard-api"
      );
      const { default: knowledgeBaseRouter } = await import(
        "../server/knowledge-base-api"
      );
      const { default: artifactRouter } = await import(
        "../server/knowledge-base-artifact-api"
      );
      const { requireExpressAuth } = await import(
        "../server/_core/express-auth"
      );
      const dashboard = express();
      dashboard.use(express.json({ limit: "5mb" }));
      dashboard.use(
        "/api/knowledge-base/artifacts",
        requireExpressAuth,
        artifactRouter,
      );
      dashboard.use(
        "/api/knowledge-base",
        requireExpressAuth,
        knowledgeBaseRouter,
      );
      dashboard.use("/api/dashboard", dashboardRouter);
      const dashboardListener = await listen(dashboard);
      dashboardServer = dashboardListener.server;

      const postKnowledgeBase = async (
        pathname: "/start/reserve" | "/turn/dispatch" | "/turn",
        body: Record<string, unknown>,
      ) => {
        const requestBody = JSON.stringify(body);
        const send = async () => {
          const response = await fetch(
            `${dashboardListener.baseUrl}/api/knowledge-base${pathname}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-test-auth": "user",
              },
              body: requestBody,
            },
          );
          const payload = (await response.json()) as any;
          if (
            response.status === 200 &&
            payload.observation?.interaction?.interactionState === "failed"
          ) {
            throw new Error(
              `${pathname} projection failed: ${JSON.stringify(payload.observation.notice)}`,
            );
          }
          if (response.status === 202) {
            expect(
              payload.accepted === true || payload.idempotent === true,
            ).toBe(true);
            // The replay can observe the same durable reservation after the
            // asynchronous dispatcher has already bound its provider task.
            // Both in-flight states intentionally remain HTTP 202.
            expect(["pending", "bound"]).toContain(payload.reservation.state);
            expect(payload.reservation).toEqual(
              expect.objectContaining({
                turnId: expect.any(String),
              }),
            );
            expect(payload.reservation).toHaveProperty("upstreamTaskId");
            expect(["bound", "recovering"]).toContain(
              payload.reservation.dispatchState,
            );
            if (payload.reservation.state === "bound") {
              expect(payload.reservation.dispatchState).toBe("bound");
            }
            if (payload.reservation.dispatchState === "bound") {
              expect(typeof payload.reservation.upstreamTaskId).toBe("string");
              expect(payload.reservation.upstreamTaskId.length).toBeGreaterThan(
                0,
              );
            } else {
              expect(payload.reservation.upstreamTaskId).toBeNull();
            }
          } else if (
            response.status !== 200 &&
            !(
              pathname === "/start/reserve" &&
              response.status === 201 &&
              payload.accepted === true &&
              payload.reservation?.state === "awaiting_attachments"
            )
          ) {
            throw new Error(
              `${pathname} returned ${response.status}: ${JSON.stringify(payload)}`,
            );
          }
          return { response, payload };
        };

        let { response, payload } = await send();
        // Reservation is intentionally a pure Dashboard commit. A 201 receipt
        // is complete even though its observation is still "executing"; only
        // the following explicit dispatch owns Provider progress polling.
        if (pathname === "/start/reserve" && response.status === 201) {
          return payload;
        }
        const projectionPending = () =>
          response.status === 202 ||
          payload.task?.status === "running" ||
          payload.observation?.interaction?.interactionState === "executing";
        if (!projectionPending()) return payload;

        // Model one disconnected/lost accepted response exactly as the real
        // client does: back off, then replay the same serialized bytes once.
        // Subsequent waiting is observation-only, so this test exercises
        // idempotency without creating an artificial hot-POST lock storm.
        await new Promise((resolve) => setTimeout(resolve, 500));
        ({ response, payload } = await send());
        if (!projectionPending()) return payload;

        const deadline = Date.now() + 30_000;
        let lastObserved: any = payload;
        do {
          const observationResponse = await fetch(
            `${dashboardListener.baseUrl}/api/knowledge-base/progress/${encodeURIComponent(String(body.conversationId || ""))}`,
            { headers: { "x-test-auth": "user" } },
          );
          expect(observationResponse.status).toBe(200);
          const observed = (await observationResponse.json()) as any;
          lastObserved = observed;
          if (
            observed.observation?.interaction?.interactionState === "failed"
          ) {
            throw new Error(
              `${pathname} projection failed: ${JSON.stringify(observed.observation.notice)}`,
            );
          }
          if (
            observed.observation?.interaction?.interactionState !==
              "executing" &&
            observed.observation?.authoritativeTaskId
          ) {
            return {
              ...payload,
              task: {
                id: observed.observation.authoritativeTaskId,
                status: "running",
              },
              observation: observed.observation,
              progress: observed.progress,
              interaction: observed.interaction,
            };
          }

          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);

        throw new Error(
          `${pathname} did not settle after an accepted response: ${JSON.stringify(lastObserved)}`,
        );
      };
      const reconcileKnowledgeBase = async (taskId?: string) => {
        const response = await fetch(
          `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-auth": "user",
            },
            body: JSON.stringify({
              conversationId: publicConversationId,
              ...(taskId ? { taskId } : {}),
            }),
          },
        );
        const payload = (await response.json()) as any;
        if (response.status !== 200) {
          throw new Error(
            `/progress/reconcile returned ${response.status}: ${JSON.stringify(payload)}`,
          );
        }
        return payload.observation;
      };

      const startRequest = {
        conversationId: publicConversationId,
        clientRequestId: `request-initial-${runId}`,
        companyName: "FrontMind超前智能",
        companyWebsite: "https://www.frontmind.net/",
        attachmentManifest: [],
      };
      const reservedStart = await postKnowledgeBase(
        "/start/reserve",
        startRequest,
      );
      expect(reservedStart.reservation).toMatchObject({
        turnId: expect.any(String),
        requiresUpload: false,
      });
      const initial = await postKnowledgeBase("/turn/dispatch", {
        conversationId: publicConversationId,
        turnId: reservedStart.reservation.turnId,
        clientRequestId: startRequest.clientRequestId,
        attachmentManifest: [],
      });
      const build = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.conversationId, publicConversationId))
          .limit(1)
      )[0];
      expect(build).toBeTruthy();
      expect(build).toMatchObject({
        treePolicyVersion: 1,
        skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
      });
      expect(initial.observation).toMatchObject({
        generation: 1,
        notice: null,
        interaction: {
          interactionState: "awaiting_input",
          canReply: true,
          progress: {
            build: {
              status: "confirming",
              revision: 0,
              currentLeafId: "1.1",
            },
          },
        },
        approvedPresentation: {
          revision: 0,
          leafId: "1.1",
          visibleMarkdown: fixture.leaves[0]!.contentMarkdown,
          imageState: "attached",
          resources: [
            expect.objectContaining({
              kind: "logo",
              sameOriginUrl: `/api/knowledge-base/artifacts/${build.id}/logo`,
              sha256: fixture.logoSha256,
            }),
          ],
        },
      });
      const readsAfterInitialProjection = authoritativeTaskReads;
      for (let replay = 0; replay < 2; replay += 1) {
        expect(await reconcileKnowledgeBase(initial.task.id)).toMatchObject({
          notice: null,
          interaction: {
            interactionState: "awaiting_input",
            progress: {
              build: { revision: 0, currentLeafId: "1.1" },
            },
          },
        });
      }
      expect(authoritativeTaskReads).toBe(readsAfterInitialProjection);

      const unauthenticatedLogo = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/artifacts/${build.id}/logo`,
      );
      expect(unauthenticatedLogo.status).toBe(401);
      const logoResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/artifacts/${build.id}/logo`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(logoResponse.status).toBe(200);
      expect(Buffer.from(await logoResponse.arrayBuffer())).toEqual(
        fixture.logo,
      );
      expect(logoResponse.headers.get("etag")).toBe(
        `"sha256-${fixture.logoSha256}"`,
      );

      const initialNodes = await executor
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
        .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
      expect(initialNodes).toHaveLength(FINAL_REVISION);
      expect(initialNodes[0]).toMatchObject({
        leafId: "1.1",
        status: "current",
        contentMarkdown: fixture.leaves[0]!.contentMarkdown,
      });
      expect(
        initialNodes.slice(1).every((node) => node.status === "pending"),
      ).toBe(true);
      // The first turn downloads only the provider-returned raster Logo. The
      // official-web URL proves first-party provenance but may point to a
      // different source representation such as SVG, so it is not fetched for
      // byte equality here. Finalization reuses the durable bound bytes.
      expect(logoDownloads).toBe(1);

      const startTurn = (
        await executor
          .select()
          .from(conversationTurns)
          .where(
            eq(conversationTurns.clientRequestId, startRequest.clientRequestId),
          )
          .limit(1)
      )[0];
      expect(startTurn).toMatchObject({
        status: "completed",
        upstreamTaskId: initial.task.id,
        attachmentFileIds: expect.arrayContaining([
          expect.stringMatching(/^uploaded-skill-/u),
          expect.stringMatching(/^uploaded-instructions-/u),
        ]),
        metadata: expect.objectContaining({ attachmentsFrozen: true }),
      });
      expect(startTurn.attachmentFileIds).toHaveLength(2);
      const startPostCount = operationTaskPosts.get(startTurn.operationKey!);
      const uploadCountAfterStart = uploadedFileSequence;
      const repeatedStart = await postKnowledgeBase("/turn/dispatch", {
        conversationId: publicConversationId,
        turnId: reservedStart.reservation.turnId,
        clientRequestId: startRequest.clientRequestId,
        attachmentManifest: [],
      });
      // A repeated explicit dispatch is an idempotent receipt replay. The
      // `resumed` hint is reserved for recovery endpoints and is not part of
      // the dispatch replay contract.
      expect(repeatedStart).toMatchObject({ idempotent: true });
      expect(operationTaskPosts.get(startTurn.operationKey!)).toBe(
        startPostCount,
      );
      expect(uploadedFileSequence).toBe(uploadCountAfterStart);

      let finalTurnOperationKey: string | null = null;
      for (let index = 0; index < fixture.leaves.length; index += 1) {
        const leaf = fixture.leaves[index]!;
        const isFinal = index === fixture.leaves.length - 1;
        const request = {
          conversationId: publicConversationId,
          clientRequestId: `request-confirm-${index + 1}-${runId}`,
          userMessage: "确认",
          expectedRevision: index,
          expectedLeafId: leaf.id,
        };
        const result = await postKnowledgeBase("/turn", request);
        const turn = (
          await executor
            .select()
            .from(conversationTurns)
            .where(
              eq(conversationTurns.clientRequestId, request.clientRequestId),
            )
            .limit(1)
        )[0];
        expect(turn).toMatchObject({
          operationType: "confirm",
          expectedRevision: index,
          expectedLeafId: leaf.id,
          status: "completed",
          upstreamTaskId: result.task.id,
          attachmentFileIds: expect.arrayContaining([
            expect.stringMatching(/^uploaded-skill-/u),
            expect.stringMatching(
              isFinal ? /^uploaded-finalization-/u : /^uploaded-instructions-/u,
            ),
          ]),
          metadata: expect.objectContaining({ attachmentsFrozen: true }),
          completedAt: expect.any(Date),
          leaseExpiresAt: null,
        });
        expect(turn.attachmentFileIds).toHaveLength(2);
        if (isFinal) finalTurnOperationKey = turn.operationKey;
        if (isFinal) {
          expect(result.observation).toMatchObject({
            authoritativeTaskId: finalTaskId,
            approvedPresentation: {
              revision: FINAL_REVISION - 1,
              leafId: leaf.id,
              visibleMarkdown: leaf.contentMarkdown,
            },
            notice: null,
            interaction: {
              interactionState: "ready_to_publish",
              canReply: false,
              canPublish: true,
              progress: {
                build: {
                  status: "ready_to_publish",
                  revision: FINAL_REVISION,
                  currentLeafId: null,
                },
              },
            },
            package: {
              revision: FINAL_REVISION,
              sha256: archiveSha256,
              sizeBytes: fixture.archive.length,
            },
          });
        } else {
          const nextLeaf = fixture.leaves[index + 1]!;
          expect(result.observation).toMatchObject({
            notice: null,
            interaction: {
              interactionState: "awaiting_input",
              canReply: true,
              progress: {
                build: {
                  status: "confirming",
                  revision: index + 1,
                  currentLeafId: nextLeaf.id,
                },
              },
            },
            approvedPresentation: {
              revision: index + 1,
              leafId: nextLeaf.id,
              visibleMarkdown: nextLeaf.contentMarkdown,
              imageState: "no_eligible_asset",
              resources: [],
            },
          });
          const readsBeforeSettledReconcile = authoritativeTaskReads;
          expect(await reconcileKnowledgeBase(result.task.id)).toMatchObject({
            notice: null,
            interaction: {
              interactionState: "awaiting_input",
              progress: {
                build: {
                  revision: index + 1,
                  currentLeafId: nextLeaf.id,
                },
              },
            },
          });
          expect(authoritativeTaskReads).toBe(readsBeforeSettledReconcile);
        }
        const postCount = operationTaskPosts.get(turn.operationKey!);
        const uploadCount = uploadedFileSequence;
        const repeated = await postKnowledgeBase("/turn", request);
        expect(repeated).toMatchObject({
          idempotent: true,
          task: { id: result.task.id },
        });
        expect(operationTaskPosts.get(turn.operationKey!)).toBe(postCount);
        expect(uploadedFileSequence).toBe(uploadCount);
      }

      const readsBeforeImmutableReconcile = authoritativeTaskReads;
      expect(await reconcileKnowledgeBase(finalTaskId)).toMatchObject({
        notice: null,
        interaction: {
          interactionState: "ready_to_publish",
          canPublish: true,
          progress: {
            build: {
              revision: FINAL_REVISION,
              currentLeafId: null,
            },
          },
        },
      });
      expect(authoritativeTaskReads).toBe(readsBeforeImmutableReconcile);

      expect(logoDownloads).toBe(1);
      expect(packageDownloads).toBe(1);
      // Every operation projects the provider's create-task response directly.
      // Later focus/online reconcile calls are immutable local reads.
      expect(authoritativeTaskReads).toBe(0);
      // The Skill bytes are build-pinned, but every operation gets a freshly
      // verified short-lived provider file capability. Each operation also
      // gets one operation-bound server input file; the last uses the
      // finalization ZIP.
      expect(uploadedFileSequence).toBe((FINAL_REVISION + 1) * 2);
      expect(uploadedFileBytes.size).toBe((FINAL_REVISION + 1) * 2);
      expect(
        [...uploadedFileNames.values()].filter(
          (filename) => filename === "socratic-kb-builder.skill.zip",
        ),
      ).toHaveLength(FINAL_REVISION + 1);
      expect(
        [...uploadedFileNames.values()].filter(
          (filename) => filename === KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
        ),
      ).toHaveLength(FINAL_REVISION);
      expect(
        [...uploadedFileNames.values()].filter((filename) =>
          FINALIZATION_INPUT_FILENAME_PATTERN.test(filename),
        ),
      ).toHaveLength(1);
      expect(
        new Set(
          (await executor.select().from(conversationTurns))
            .flatMap((turn) => turn.attachmentFileIds || [])
            .filter((fileId) => /^uploaded-skill-/u.test(fileId)),
        ).size,
      ).toBe(FINAL_REVISION + 1);
      expect(operationTaskPosts.size).toBe(FINAL_REVISION + 1);
      expect([...operationTaskPosts.values()]).toEqual(
        Array(FINAL_REVISION + 1).fill(1),
      );
      const [resourceLedgerRows] = await pool.query<RowDataPacket[]>(
        `SELECT
           COUNT(*) AS resourceCount,
           SUM(kind = 'file') AS fileResourceCount,
           COUNT(DISTINCT apiCredentialId) AS credentialCount
         FROM upstream_resources
         WHERE userId = ?`,
        [userId],
      );
      expect(Number(resourceLedgerRows[0]?.resourceCount || 0)).toBe(
        (FINAL_REVISION + 1) * 2,
      );
      expect(Number(resourceLedgerRows[0]?.fileResourceCount || 0)).toBe(
        (FINAL_REVISION + 1) * 2,
      );
      expect(Number(resourceLedgerRows[0]?.credentialCount || 0)).toBe(1);

      const finalBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0];
      expect(finalBuild).toMatchObject({
        status: "ready_to_publish",
        activeTurnId: null,
        lastAppliedOperationKey: finalTurnOperationKey,
        revision: FINAL_REVISION,
        currentLeafId: null,
        confirmedCount: FINAL_REVISION,
        packageRevision: FINAL_REVISION,
        packageArchiveSha256: archiveSha256,
        logoSha256: fixture.logoSha256,
        protocolError: null,
        protocolErrorCode: null,
      });
      const finalNodes = await executor
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
        .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
      expect(finalNodes).toHaveLength(FINAL_REVISION);
      expect(finalNodes.every((node) => node.status === "confirmed")).toBe(
        true,
      );
      expect(
        finalNodes.map((node) => ({
          id: node.leafId,
          hash: node.contentSha256,
          images: node.imageUrls,
        })),
      ).toEqual(
        fixture.leaves.map((leaf) => ({
          id: leaf.id,
          hash: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
          images: [],
        })),
      );
      const presentationMessages = (
        await executor
          .select()
          .from(messages)
          .where(eq(messages.userId, userId!))
          .orderBy(asc(messages.sequence))
      ).filter(
        (message) =>
          (message.metadata as any)?.knowledgeBase?.kind === "presentation",
      );
      expect(presentationMessages).toHaveLength(FINAL_REVISION);
      expect(
        presentationMessages.map((message) => ({
          leafId: (message.metadata as any).knowledgeBase.leafId,
          content: message.content,
        })),
      ).toEqual(
        fixture.leaves.map((leaf) => ({
          leafId: leaf.id,
          content: leaf.contentMarkdown,
        })),
      );

      const unauthenticatedPackage = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/artifacts/${build.id}/package`,
      );
      expect(unauthenticatedPackage.status).toBe(401);
      const packageResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/artifacts/${build.id}/package`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(packageResponse.status).toBe(200);
      const durablePackage = Buffer.from(await packageResponse.arrayBuffer());
      expect(durablePackage).toEqual(fixture.archive);
      expect(sha256(durablePackage)).toBe(archiveSha256);

      const unauthenticatedPublish = await fetch(
        `${dashboardListener.baseUrl}/api/dashboard/knowledge/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: publicConversationId }),
        },
      );
      expect(unauthenticatedPublish.status).toBe(401);
      const publishResponse = await fetch(
        `${dashboardListener.baseUrl}/api/dashboard/knowledge/publish`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({ conversationId: publicConversationId }),
        },
      );
      expect(publishResponse.status).toBe(200);
      const published = (await publishResponse.json()) as any;
      expect(published).toMatchObject({
        kind: "knowledge",
        snapshot: {
          sourceBuildId: build.id,
          sourceBuildRevision: FINAL_REVISION,
          sourceTaskId: finalTaskId,
          sourceArtifactHash: archiveSha256,
          archiveHash: archiveSha256,
          archiveAvailable: true,
          imageCount: 1,
        },
      });

      const databaseSnapshot = (
        await executor
          .select()
          .from(knowledgeBaseSnapshots)
          .where(eq(knowledgeBaseSnapshots.id, published.snapshot.id))
          .limit(1)
      )[0];
      expect(databaseSnapshot).toBeTruthy();
      const { getLatestKnowledgeSnapshot } = await import(
        "../server/dashboard-service"
      );
      const viewerSnapshot = await getLatestKnowledgeSnapshot(userId!);
      expect(viewerSnapshot).toMatchObject({
        id: published.snapshot.id,
        sourceBuildId: build.id,
        sourceBuildRevision: FINAL_REVISION,
        archiveHash: archiveSha256,
        archiveAvailable: true,
      });
      const viewerLeaves = viewerSnapshot!.documents
        .filter((document: any) => document.kind === "leaf")
        .sort((left: any, right: any) => left.order - right.order);
      expect(
        viewerLeaves.map((document: any) => ({
          id: document.id,
          title: document.title,
          branchId: document.branchId,
          branchTitle: document.branchTitle,
          order: document.order,
          content: document.content,
        })),
      ).toEqual(
        finalNodes.map((node) => ({
          id: node.leafId,
          title: node.title,
          branchId: node.branchId,
          branchTitle: node.branchTitle,
          order: node.ordinal,
          content: node.contentMarkdown,
        })),
      );
      expect(viewerSnapshot!.assets).toEqual([
        expect.objectContaining({
          id: "official-logo",
          sha256: fixture.logoSha256,
          url: `/api/dashboard/knowledge/assets/${published.snapshot.id}/by-id/official-logo`,
        }),
      ]);
      const publishedLogoUrl = `${dashboardListener.baseUrl}/api/dashboard/knowledge/assets/${published.snapshot.id}/by-id/official-logo`;
      const unauthenticatedPublishedLogo = await fetch(publishedLogoUrl);
      expect(unauthenticatedPublishedLogo.status).toBe(401);
      const publishedLogoResponse = await fetch(publishedLogoUrl, {
        headers: { "x-test-auth": "user" },
      });
      expect(publishedLogoResponse.status).toBe(200);
      expect(Buffer.from(await publishedLogoResponse.arrayBuffer())).toEqual(
        fixture.logo,
      );

      const unauthenticatedDownload = await fetch(
        `${dashboardListener.baseUrl}/api/dashboard/knowledge/snapshots/${published.snapshot.id}/archive`,
      );
      expect(unauthenticatedDownload.status).toBe(401);
      const downloadResponse = await fetch(
        `${dashboardListener.baseUrl}/api/dashboard/knowledge/snapshots/${published.snapshot.id}/archive`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(downloadResponse.status).toBe(200);
      expect(downloadResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
      expect(downloaded).toEqual(fixture.archive);
      expect(sha256(downloaded)).toBe(archiveSha256);

      const unpacked = await readKnowledgeArchive(
        downloaded,
        "frontmind-knowledge-base.zip",
        randomUUID(),
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersions: [4],
        },
      );
      const unpackedLeaves = unpacked.documents
        .filter((document) => document.kind === "leaf")
        .sort((left, right) => left.order! - right.order!);
      const normalizedDatabaseLeaves = finalNodes.map((node) => ({
        id: node.leafId,
        title: node.title,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
        order: node.ordinal,
        hash: node.contentSha256,
      }));
      expect(
        unpackedLeaves.map((document) => ({
          id: document.id,
          title: document.title,
          branchId: document.branchId,
          branchTitle: document.branchTitle,
          order: document.order,
          hash: knowledgeBaseMarkdownSha256(document.content),
        })),
      ).toEqual(normalizedDatabaseLeaves);
      expect(
        viewerLeaves.map((document: any) => ({
          id: document.id,
          title: document.title,
          branchId: document.branchId,
          branchTitle: document.branchTitle,
          order: document.order,
          hash: knowledgeBaseMarkdownSha256(document.content),
        })),
      ).toEqual(normalizedDatabaseLeaves);
      expect(unpacked.assets).toEqual([
        expect.objectContaining({
          id: "official-logo",
          sha256: fixture.logoSha256,
        }),
      ]);

      const finalPersistedBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0];
      expect(finalPersistedBuild).toMatchObject({
        status: "published",
        publishedSnapshotId: published.snapshot.id,
        protocolError: null,
        protocolErrorCode: null,
      });
      acceptancePassed = true;
    }, 300_000);

    it("lets only the newest receipt claimant commit and confines loser cleanup to its own files", async () => {
      const harness = await createKnowledgeImportHarness("claim-takeover");
      try {
        const { importWebsiteKnowledgeArtifact } = await import(
          "../server/knowledge-import-service"
        );
        const { isKnowledgeSnapshotArchiveAvailable } = await import(
          "../server/knowledge-snapshot-archive-store"
        );
        const firstClaimStaged = deferred();
        const releaseFirstClaim = deferred();
        let createAttempts = 0;
        let losingSnapshotId = "";
        let winningSnapshotId = "";
        dependencies.createKnowledgeSnapshotHook = async (actual, input) => {
          createAttempts += 1;
          if (createAttempts === 1) {
            losingSnapshotId = input.snapshotId;
            firstClaimStaged.resolve();
            await releaseFirstClaim.promise;
          } else {
            winningSnapshotId = input.snapshotId;
          }
          return actual(input);
        };

        const firstWorker = importWebsiteKnowledgeArtifact(harness.request);
        void firstWorker.catch((error) => firstClaimStaged.reject(error));
        await firstClaimStaged.promise;
        await pool.execute(
          `UPDATE knowledge_import_receipts
              SET updatedAt = '2000-01-01 00:00:00'
            WHERE idempotencyKeyHash = ?`,
          [sha256(harness.request.idempotencyKey)],
        );

        const secondWorker = await importWebsiteKnowledgeArtifact({
          ...harness.request,
          now: new Date(),
        });
        releaseFirstClaim.resolve();
        const firstWorkerReplay = await firstWorker;

        expect(createAttempts).toBe(2);
        expect(losingSnapshotId).not.toBe(winningSnapshotId);
        expect(secondWorker).toMatchObject({
          replayed: false,
          snapshot: { id: winningSnapshotId },
        });
        expect(firstWorkerReplay).toMatchObject({
          replayed: true,
          snapshot: { id: winningSnapshotId },
        });
        const receipt = (
          await executor
            .select()
            .from(knowledgeImportReceipts)
            .where(
              eq(
                knowledgeImportReceipts.idempotencyKeyHash,
                sha256(harness.request.idempotencyKey),
              ),
            )
            .limit(1)
        )[0];
        expect(receipt).toMatchObject({
          status: "completed",
          revision: 2,
          snapshotId: winningSnapshotId,
        });
        const [snapshotRows] = await pool.query<RowDataPacket[]>(
          "SELECT id FROM knowledge_base_snapshots WHERE id IN (?, ?)",
          [losingSnapshotId, winningSnapshotId],
        );
        expect(snapshotRows.map((row) => row.id)).toEqual([winningSnapshotId]);
        await expect(
          isKnowledgeSnapshotArchiveAvailable({
            userId: userId!,
            snapshotId: winningSnapshotId,
          }),
        ).resolves.toBe(true);
        await expect(
          isKnowledgeSnapshotArchiveAvailable({
            userId: userId!,
            snapshotId: losingSnapshotId,
          }),
        ).resolves.toBe(false);
        await expect(
          access(
            path.join(assetRoot, stagedImportAssets.get(winningSnapshotId)!),
          ),
        ).resolves.toBeUndefined();
        await expect(
          access(
            path.join(assetRoot, stagedImportAssets.get(losingSnapshotId)!),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await harness.close();
      }
    }, 120_000);

    it("retries safely after an archive write followed by a pre-commit failure", async () => {
      const harness = await createKnowledgeImportHarness("precommit-retry");
      try {
        const { importWebsiteKnowledgeArtifact } = await import(
          "../server/knowledge-import-service"
        );
        const { isKnowledgeSnapshotArchiveAvailable } = await import(
          "../server/knowledge-snapshot-archive-store"
        );
        let failedSnapshotId = "";
        dependencies.createKnowledgeSnapshotHook = async (_actual, input) => {
          failedSnapshotId = input.snapshotId;
          throw new Error("MYSQL_E2E_PRECOMMIT_FAULT");
        };

        await expect(
          importWebsiteKnowledgeArtifact(harness.request),
        ).rejects.toThrow("MYSQL_E2E_PRECOMMIT_FAULT");
        expect(failedSnapshotId).not.toBe("");
        await expect(
          isKnowledgeSnapshotArchiveAvailable({
            userId: userId!,
            snapshotId: failedSnapshotId,
          }),
        ).resolves.toBe(false);
        await expect(
          access(
            path.join(assetRoot, stagedImportAssets.get(failedSnapshotId)!),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });

        dependencies.createKnowledgeSnapshotHook = undefined;
        const retried = await importWebsiteKnowledgeArtifact(harness.request);
        expect(retried).toMatchObject({
          replayed: false,
          snapshot: { id: expect.any(String) },
        });
        expect(retried.snapshot.id).not.toBe(failedSnapshotId);
        const receipt = (
          await executor
            .select()
            .from(knowledgeImportReceipts)
            .where(
              eq(
                knowledgeImportReceipts.idempotencyKeyHash,
                sha256(harness.request.idempotencyKey),
              ),
            )
            .limit(1)
        )[0];
        expect(receipt).toMatchObject({
          status: "completed",
          revision: 2,
          snapshotId: retried.snapshot.id,
        });
      } finally {
        await harness.close();
      }
    }, 120_000);

    it("replays the exact receipt snapshot after commit succeeds but its response is lost", async () => {
      const harness = await createKnowledgeImportHarness("postcommit-replay");
      try {
        const { importWebsiteKnowledgeArtifact } = await import(
          "../server/knowledge-import-service"
        );
        let committedSnapshotId = "";
        let loseResponse = true;
        dependencies.createKnowledgeSnapshotHook = async (actual, input) => {
          const snapshot = await actual(input);
          committedSnapshotId = snapshot.id;
          if (loseResponse) {
            loseResponse = false;
            throw new Error("MYSQL_E2E_POSTCOMMIT_RESPONSE_LOST");
          }
          return snapshot;
        };

        const recovered = await importWebsiteKnowledgeArtifact(harness.request);
        expect(recovered).toMatchObject({
          replayed: true,
          snapshot: { id: committedSnapshotId },
        });
        dependencies.createKnowledgeSnapshotHook = undefined;
        const replayed = await importWebsiteKnowledgeArtifact(harness.request);
        expect(replayed).toMatchObject({
          replayed: true,
          snapshot: { id: committedSnapshotId },
        });
        const [rows] = await pool.query<RowDataPacket[]>(
          "SELECT id FROM knowledge_base_snapshots WHERE id = ?",
          [committedSnapshotId],
        );
        expect(rows).toHaveLength(1);
        const receipt = (
          await executor
            .select()
            .from(knowledgeImportReceipts)
            .where(
              eq(
                knowledgeImportReceipts.idempotencyKeyHash,
                sha256(harness.request.idempotencyKey),
              ),
            )
            .limit(1)
        )[0];
        expect(receipt).toMatchObject({
          status: "completed",
          snapshotId: committedSnapshotId,
        });
      } finally {
        await harness.close();
      }
    }, 120_000);

    it("returns each caller's explicit snapshot ID under concurrent creation", async () => {
      const { createKnowledgeSnapshot } = await import(
        "../server/dashboard-service"
      );
      const leftId = randomUUID();
      const rightId = randomUUID();
      const create = (snapshotId: string, marker: string) =>
        createKnowledgeSnapshot({
          snapshotId,
          userId: userId!,
          actorUserId: userId!,
          sourceFileName: `${marker}.zip`,
          documents: [
            {
              id: marker,
              path: `${marker}.md`,
              title: marker,
              content: marker,
              kind: "other" as const,
              customerVisible: true,
            },
          ],
          assets: [],
          totalBytes: marker.length,
        });

      const [left, right] = await Promise.all([
        create(leftId, "left-concurrent-snapshot"),
        create(rightId, "right-concurrent-snapshot"),
      ]);
      expect(left.id).toBe(leftId);
      expect(right.id).toBe(rightId);
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM knowledge_base_snapshots WHERE id IN (?, ?) ORDER BY id",
        [leftId, rightId],
      );
      expect(rows.map((row) => row.id)).toEqual([leftId, rightId].sort());
    }, 120_000);

    it("serializes same-build task binding with browser snapshot sync without deadlock or KB ghost rewrites", async () => {
      const {
        bindKnowledgeBaseTurnUpstreamTask,
        reserveKnowledgeBaseStartBuild,
      } = await import("../server/knowledge-base-turn-service");
      const { persistSnapshot } = await import("../server/conversation-router");
      const { knowledgeBaseNewBuildPolicyBinding } = await import(
        "../server/knowledge-base-tree-policy-rollout"
      );
      const policy = knowledgeBaseNewBuildPolicyBinding({
        FRONTMIND_KB_TREE_POLICY_V2_WRITER: "true",
      } as NodeJS.ProcessEnv);
      const publicBarrierConversationId = `kb-barrier-${runId}`;
      const started = await reserveKnowledgeBaseStartBuild(
        {
          userId: userId!,
          expectedResetRevision: 0,
          conversationId: publicBarrierConversationId,
          clientRequestId: `kb-barrier-start-${runId}`,
          companyName: "FrontMind MySQL Barrier",
          companyWebsite: "https://barrier.invalid",
          skillName: "socratic-kb-builder",
          skillVersion: policy.skillVersion,
          skillContentHash: policy.skillContentHash,
          treePolicyVersion: policy.treePolicyVersion,
          apiCredentialId: credentialId,
          userText: "开始构建企业知识库",
          expectedAttachmentCount: 0,
          requestPayload: { kind: "mysql-bind-snapshot-barrier", runId },
          recoveryMetadata: {
            kind: "start",
            conversationId: publicBarrierConversationId,
            skillVersion: policy.skillVersion,
            skillContentHash: policy.skillContentHash,
          },
          leaseMs: 30_000,
        },
        executor,
      );
      if (started.reservation.state !== "acquired") {
        throw new Error("MYSQL_BARRIER_START_RESERVATION_NOT_ACQUIRED");
      }
      const { build, reservation } = started;
      const storageConversationId = reservation.turn.conversationId;
      const [serverRowsBefore] = await pool.query<RowDataPacket[]>(
        `SELECT id, turnId, content, sequence, metadata
           FROM messages WHERE conversationId = ? AND turnId = ?`,
        [storageConversationId, reservation.turn.id],
      );
      expect(serverRowsBefore).toHaveLength(1);
      const serverMessageBefore = structuredClone(serverRowsBefore[0]);

      // Reproduce the production sequence shape: an ordinary browser row at
      // seq 0 and an immutable server-owned KB row at seq 1. Snapshot sync may
      // delete/reinsert only the former and must allocate new rows above the
      // full conversation maximum.
      await pool.execute("UPDATE messages SET sequence = 1 WHERE id = ?", [
        serverMessageBefore.id,
      ]);
      const existingOrdinaryPublicId = `ordinary-before-${runId}`;
      const existingOrdinaryStorageId = `u${userId}:${existingOrdinaryPublicId}`;
      await pool.execute(
        `INSERT INTO messages
           (id, conversationId, turnId, userId, role, content, sequence,
            sentAt, createdAt, updatedAt)
         VALUES (?, ?, NULL, ?, 'user', ?, 0, NOW(), NOW(), NOW())`,
        [
          existingOrdinaryStorageId,
          storageConversationId,
          userId,
          "existing ordinary browser message",
        ],
      );

      const nextOrdinaryPublicId = `ordinary-after-${runId}`;
      const snapshot = {
        id: publicBarrierConversationId,
        title: "MySQL bind/snapshot barrier",
        messages: [
          {
            id: existingOrdinaryPublicId,
            role: "user" as const,
            content: "existing ordinary browser message",
            timestamp: Date.now() - 1_000,
          },
          {
            id: nextOrdinaryPublicId,
            role: "assistant" as const,
            content: "new ordinary browser message",
            timestamp: Date.now(),
          },
        ],
        status: "running" as const,
        createdAt: Date.now() - 5_000,
        updatedAt: Date.now(),
        deletedMessageIds: [],
      };
      const providerTaskId = `provider-barrier-${runId}`;
      const blocker = await pool.getConnection();
      let blockerReleased = false;
      let barrierFailure: unknown;
      const operations: Promise<unknown>[] = [];
      try {
        await blocker.beginTransaction();
        await blocker.execute(
          "SELECT id FROM knowledge_base_builds WHERE id = ? FOR UPDATE",
          [build.id],
        );

        // Deliberately bypass the retry wrapper here: a real 1213/1205 must be
        // observable and fail this release gate instead of succeeding on a
        // hidden second attempt.
        const syncing = executor.transaction(
          (tx) => persistSnapshot(tx, userId!, snapshot),
          { isolationLevel: "read committed", accessMode: "read write" },
        );
        operations.push(syncing);
        const snapshotWaiters = await waitForMysqlRowLockWaiters(pool, 1);
        const snapshotTransactions = new Set(
          snapshotWaiters.map((row) => String(row.transactionId)),
        );
        expect(snapshotTransactions.size).toBe(1);

        const binding = bindKnowledgeBaseTurnUpstreamTask(
          {
            userId: userId!,
            turnId: reservation.turn.id,
            leaseToken: reservation.leaseToken,
            upstreamTaskId: providerTaskId,
          },
          executor,
        );
        operations.push(binding);
        const allWaiters = await waitForMysqlRowLockWaiters(pool, 2);
        const allTransactions = new Set(
          allWaiters.map((row) => String(row.transactionId)),
        );
        expect(allTransactions.size).toBe(2);
        const bindingTransactions = [...allTransactions].filter(
          (transactionId) => !snapshotTransactions.has(transactionId),
        );
        expect(bindingTransactions).toHaveLength(1);

        // This is the lock-order proof, not merely an eventual-success check.
        // The historical turn -> build implementation would already own an X
        // record lock on this turn while waiting behind the snapshot's build
        // request, and this assertion would fail before the blocker is freed.
        const [prematureTurnLocks] = await pool.query<RowDataPacket[]>(
          `SELECT OBJECT_NAME AS objectName, LOCK_TYPE AS lockType,
                  LOCK_MODE AS lockMode, LOCK_STATUS AS lockStatus,
                  LOCK_DATA AS lockData
             FROM performance_schema.data_locks
            WHERE OBJECT_SCHEMA = DATABASE()
              AND OBJECT_NAME = 'conversation_turns'
              AND ENGINE_TRANSACTION_ID = ?
              AND LOCK_TYPE = 'RECORD'
              AND LOCK_STATUS = 'GRANTED'
              AND LOCK_MODE LIKE 'X%'`,
          [bindingTransactions[0]],
        );
        expect(prematureTurnLocks).toEqual([]);

        await blocker.commit();
        blockerReleased = true;
      } catch (error) {
        barrierFailure = error;
      } finally {
        if (!blockerReleased) await blocker.rollback().catch(() => undefined);
        blocker.release();
      }
      const settled = await Promise.allSettled(operations);
      if (barrierFailure) throw barrierFailure;
      const rejected = settled.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(
        rejected.map((result) => {
          const reason = result.reason as {
            code?: unknown;
            errno?: unknown;
            cause?: { code?: unknown; errno?: unknown };
          };
          return String(
            reason?.code ||
              reason?.cause?.code ||
              reason?.errno ||
              reason?.cause?.errno ||
              "UNKNOWN",
          );
        }),
      ).toEqual([]);

      const [boundRows] = await pool.query<RowDataPacket[]>(
        `SELECT t.upstreamTaskId AS turnTaskId,
                b.upstreamTaskId AS buildTaskId, b.activeTurnId
           FROM conversation_turns t
           JOIN knowledge_base_builds b ON b.id = t.buildId
          WHERE t.id = ?`,
        [reservation.turn.id],
      );
      expect(boundRows).toEqual([
        expect.objectContaining({
          turnTaskId: providerTaskId,
          buildTaskId: providerTaskId,
          activeTurnId: reservation.turn.id,
        }),
      ]);

      const [messageRowsAfter] = await pool.query<RowDataPacket[]>(
        `SELECT id, turnId, content, sequence, metadata
           FROM messages WHERE conversationId = ? ORDER BY sequence`,
        [storageConversationId],
      );
      expect(
        messageRowsAfter.map((row) => ({
          id: row.id,
          turnId: row.turnId,
          sequence: Number(row.sequence),
        })),
      ).toEqual([
        {
          id: existingOrdinaryStorageId,
          turnId: null,
          sequence: 0,
        },
        {
          id: serverMessageBefore.id,
          turnId: reservation.turn.id,
          sequence: 1,
        },
        {
          id: `u${userId}:${nextOrdinaryPublicId}`,
          turnId: null,
          sequence: 2,
        },
      ]);
      const serverMessageAfter = messageRowsAfter[1]!;
      expect(serverMessageAfter).toMatchObject({
        id: serverMessageBefore.id,
        turnId: serverMessageBefore.turnId,
        content: serverMessageBefore.content,
        metadata: serverMessageBefore.metadata,
      });
      expect(
        messageRowsAfter.filter((row) => row.turnId === reservation.turn.id),
      ).toHaveLength(1);
    }, 120_000);
  },
);
