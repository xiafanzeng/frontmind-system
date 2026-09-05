import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  apiCredentials,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
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
  formatKnowledgeBaseManifestEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
} from "../server/knowledge-base-progress";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  assertServiceCapability: vi.fn(),
  assertKnowledgeBaseWritable: vi.fn(),
  createKnowledgeMonitoringHandoff: vi.fn(),
  getCredentialForUpstreamResource: vi.fn(),
  recordUpstreamResource: vi.fn(),
  upstreamBaseUrl: "",
  userId: 0,
  credentialId: "",
  credentialFingerprint: "",
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

const ACCEPTANCE_ENV = "FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_KB_MYSQL_ACCEPTANCE_REQUIRED";
const DATABASE_MARKER = "frontmind_kb_acceptance";
const REPOSITORY_ROOT = path.resolve(process.cwd());
const PUBLIC_CONVERSATION_ID_PREFIX = "kb-mysql-e2e";
const FINAL_REVISION = 8;

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

async function createFinalPackageFixture() {
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
    sourceAssetUrl: "https://www.frontmind.net/frontmind-logo.png",
    sourceKind: "official_web",
    ownership: "first_party",
    assetType: "brand_identity",
    displayRole: "badge",
  };
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
      schemaVersion: 3,
      profile: "dashboard-enterprise-v1",
      buildRevision: FINAL_REVISION,
      documents,
      assets: [asset],
      counts: {
        totalFiles: documents.length + 3,
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
    const previousAxiosAdapter = axios.defaults.adapter;

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
      dependencies.recordUpstreamResource.mockResolvedValue(undefined);

      assetRoot = await mkdtemp(path.join(tmpdir(), "frontmind-kb-mysql-e2e-"));
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
      process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = "100";
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
      if (cleanupError) throw cleanupError;
      if (acceptancePassed) {
        console.log("KB_MYSQL_E2E_ACCEPTANCE_COMPLETE");
      }
    }, 120_000);

    it("runs the real start/turn/reconcile/publish/view/download path for all eight leaves", async () => {
      expect(userId).not.toBeNull();
      const fixture = await createFinalPackageFixture();
      const archiveSha256 = sha256(fixture.archive);
      const finalTaskId = `task-final-package-${runId}`;
      const taskResults = new Map<
        string,
        { status: "awaiting_input" | "completed"; output: unknown[] }
      >();
      const operationTaskPosts = new Map<string, number>();
      const idempotentTaskResponses = new Map<
        string,
        {
          id: string;
          status: "awaiting_input" | "completed";
          output: unknown[];
        }
      >();
      const uploadedFileBytes = new Map<string, number>();
      let uploadedFileSequence = 0;
      let authoritativeTaskReads = 0;
      let logoDownloads = 0;
      let packageDownloads = 0;
      let initialOperationId = "";
      let initialTurnId = "";
      let upstreamBaseUrl = "";

      const upstream = express();
      upstream.use(express.json({ limit: "5mb" }));
      upstream.post("/v1/files", (req, res) => {
        expect(req.header("authorization")).toBe(`Bearer ${upstreamApiKey}`);
        expect(req.body.filename).toBe("socratic-kb-builder.skill.zip");
        const fileId = `uploaded-skill-${++uploadedFileSequence}`;
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
      upstream.post("/v1/tasks", async (req, res, next) => {
        try {
          expect(req.header("authorization")).toBe(`Bearer ${upstreamApiKey}`);
          const prompt = String(req.body.prompt || "");
          const operationId = prompt.match(/"operationId":"([^"]+)"/u)?.[1];
          const turnId = prompt.match(/"turnId":"([^"]+)"/u)?.[1];
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

          const idempotencyKey = String(req.header("idempotency-key") || "");
          expect(idempotencyKey).toBe(`frontmind-kb-v2:${operationId}`);
          const replay = idempotentTaskResponses.get(idempotencyKey);
          if (replay) {
            res.json(replay);
            return;
          }
          operationTaskPosts.set(
            operationId!,
            (operationTaskPosts.get(operationId!) || 0) + 1,
          );

          const revision = Number(turn.expectedRevision);
          const isStart = turn.operationType === "start";
          const isFinal = !isStart && revision === FINAL_REVISION - 1;
          if (isStart) {
            expect(req.body.taskId).toBeUndefined();
          } else {
            const build = (
              await executor
                .select()
                .from(knowledgeBaseBuilds)
                .where(eq(knowledgeBaseBuilds.id, turn.buildId!))
                .limit(1)
            )[0];
            expect(req.body.taskId).toBe(build.upstreamTaskId);
          }

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
          idempotentTaskResponses.set(idempotencyKey, result);
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

      const upstreamListener = await listen(upstream);
      upstreamServer = upstreamListener.server;
      upstreamBaseUrl = upstreamListener.baseUrl;
      dependencies.upstreamBaseUrl = upstreamBaseUrl;

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
        pathname: "/start" | "/turn",
        body: Record<string, unknown>,
      ) => {
        const requestBody = JSON.stringify(body);
        let lastPayload: unknown;
        for (let attempt = 0; attempt < 400; attempt += 1) {
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
          lastPayload = payload;
          if (
            pathname === "/turn" &&
            response.status === 200 &&
            payload.idempotent === true &&
            payload.task?.status === "running"
          ) {
            // Binding the single upstream task is progress, not completion.
            // Keep replaying the same logical request until reconciliation has
            // atomically completed the turn and advanced the build.
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          if (response.status === 200) return payload;
          if (
            pathname === "/turn" &&
            response.status === 202 &&
            (payload.accepted === true || payload.idempotent === true)
          ) {
            // The public contract acknowledges the durable turn before the
            // upstream POST. Replaying these exact bytes models a lost 202 and
            // must converge on the same turn/task without a second dispatch.
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          throw new Error(
            `${pathname} returned ${response.status}: ${JSON.stringify(payload)}`,
          );
        }
        throw new Error(
          `${pathname} did not settle after an accepted response: ${JSON.stringify(lastPayload)}`,
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
      };
      const initial = await postKnowledgeBase("/start", startRequest);
      const build = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.conversationId, publicConversationId))
          .limit(1)
      )[0];
      expect(build).toBeTruthy();
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
      const startPostCount = operationTaskPosts.get(startTurn.operationKey!);
      const uploadCountAfterStart = uploadedFileSequence;
      const repeatedStart = await postKnowledgeBase("/start", startRequest);
      expect(repeatedStart).toMatchObject({ idempotent: true, resumed: true });
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
          completedAt: expect.any(Date),
          leaseExpiresAt: null,
        });
        if (isFinal) finalTurnOperationKey = turn.operationKey;
        if (isFinal) {
          expect(result.observation).toMatchObject({
            authoritativeTaskId: finalTaskId,
            approvedPresentation: null,
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
      // The helper above replays an accepted 202 until the durable local
      // projection settles. Focus/online reconcile wakes after that point must
      // remain local immutable reads, not redundant provider GETs.
      expect(authoritativeTaskReads).toBe(0);
      expect(uploadedFileSequence).toBe(1);
      expect(uploadedFileBytes.size).toBe(1);
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
      expect(Number(resourceLedgerRows[0]?.resourceCount || 0)).toBe(1);
      expect(Number(resourceLedgerRows[0]?.fileResourceCount || 0)).toBe(1);
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
          archiveContractVersions: [3],
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
  },
);
