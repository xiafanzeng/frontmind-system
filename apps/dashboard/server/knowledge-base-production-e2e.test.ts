import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";
import axios from "axios";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  apiCredentials,
  conversationTurns,
  conversations,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  messages,
  upstreamResources,
  userDashboardContents,
  users,
} from "../drizzle/schema";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import {
  canonicalPackagedKnowledgeBaseLeafMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import { canonicalizeKnowledgeBaseFinalArchive } from "./knowledge-base-package-canonicalization";
import {
  formatKnowledgeBaseManifestEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
} from "./knowledge-base-progress";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  assertServiceCapability: vi.fn(),
  assertKnowledgeBaseWritable: vi.fn(),
  createKnowledgeMonitoringHandoff: vi.fn(),
  getDecryptedCredentialForKnowledgeBaseReservation: vi.fn(),
  getCredentialForUpstreamResource: vi.fn(),
  recordUpstreamResource: vi.fn(),
  upstreamBaseUrl: "",
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));

vi.mock("./_core/safe-external-url", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./_core/safe-external-url")>();
  return {
    ...actual,
    assertSafeExternalUrl: (value: string) => new URL(value).toString(),
    safeExternalRequestOptions: { proxy: false, maxRedirects: 0 },
  };
});

vi.mock("./_core/express-auth", () => ({
  requireExpressAuth: (req: any, res: any, next: () => void) => {
    if (req.header("x-test-auth") !== "user") {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    req.frontmindUser = {
      id: 42,
      username: "frontmind-e2e",
      displayName: "FrontMind超前智能",
      role: "user",
      isActive: true,
    };
    req.frontmindCredential = {
      id: "credential-e2e",
      userId: 42,
      label: "E2E credential",
      apiKey: "sk-e2e-only",
    };
    next();
  },
}));

vi.mock("./service-entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-entitlement")>();
  return {
    ...actual,
    assertServiceCapability: dependencies.assertServiceCapability,
  };
});

vi.mock("./knowledge-base-reset-service", () => ({
  assertKnowledgeBaseWritable: dependencies.assertKnowledgeBaseWritable,
}));

vi.mock("./delivery-role-service", () => ({
  assertDeliveryProjectContext: vi.fn(),
  createKnowledgeMonitoringHandoff:
    dependencies.createKnowledgeMonitoringHandoff,
}));

vi.mock("./auth-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-service")>();
  return {
    ...actual,
    getDecryptedCredentialForKnowledgeBaseReservation:
      dependencies.getDecryptedCredentialForKnowledgeBaseReservation,
    getCredentialForUpstreamResource:
      dependencies.getCredentialForUpstreamResource,
    recordUpstreamResource: dependencies.recordUpstreamResource,
  };
});

vi.mock("./upstream-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upstream-config")>();
  return {
    ...actual,
    getUpstreamBaseUrl: () => dependencies.upstreamBaseUrl,
    getFrontMindCredentials: (req: any) => ({
      apiKey: req.frontmindCredential?.apiKey || "",
      baseUrl: dependencies.upstreamBaseUrl,
    }),
  };
});

const USER_ID = 42;
const PUBLIC_CONVERSATION_ID = "kb-production-e2e";
const STORED_CONVERSATION_ID = `u${USER_ID}:${PUBLIC_CONVERSATION_ID}`;
const TASK_ID = "task-final-package-e2e";
const FINAL_REVISION = 8;

type MemoryState = {
  credentials: Record<string, any>[];
  users: Record<string, any>[];
  dashboardContents: Record<string, any>[];
  builds: Record<string, any>[];
  nodes: Record<string, any>[];
  turns: Record<string, any>[];
  conversations: Record<string, any>[];
  messages: Record<string, any>[];
  snapshots: Record<string, any>[];
  resources: Record<string, any>[];
};

function rowsFor(table: unknown, state: MemoryState) {
  if (table === apiCredentials) return state.credentials;
  if (table === users) return state.users;
  if (table === userDashboardContents) return state.dashboardContents;
  if (table === knowledgeBaseBuilds) return state.builds;
  if (table === knowledgeBaseBuildNodes) return state.nodes;
  if (table === conversationTurns) return state.turns;
  if (table === conversations) return state.conversations;
  if (table === messages) return state.messages;
  if (table === knowledgeBaseSnapshots) return state.snapshots;
  if (table === upstreamResources) return state.resources;
  return [];
}

function equalityFilters(
  condition: unknown,
  result: Array<[string, unknown]> = [],
) {
  if (!condition || typeof condition !== "object") return result;
  const queryChunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(queryChunks)) return result;
  for (let index = 0; index < queryChunks.length; index += 1) {
    const column = queryChunks[index] as { name?: unknown } | undefined;
    if (typeof column?.name !== "string") continue;
    for (
      let paramIndex = index + 1;
      paramIndex < Math.min(queryChunks.length, index + 4);
      paramIndex += 1
    ) {
      const param = queryChunks[paramIndex] as
        | { value?: unknown; queryChunks?: unknown[] }
        | undefined;
      if (
        param?.constructor?.name === "Param" &&
        Object.prototype.hasOwnProperty.call(param, "value")
      ) {
        const operator = queryChunks
          .slice(index + 1, paramIndex)
          .flatMap((chunk) => {
            const value = (chunk as { value?: unknown })?.value;
            return Array.isArray(value) ? value : [];
          })
          .join("");
        if (/^\s*=\s*$/u.test(operator)) {
          result.push([column.name, param.value]);
        }
        break;
      }
    }
  }
  for (const chunk of queryChunks) {
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) {
      equalityFilters(chunk, result);
    }
  }
  return result;
}

function matchingRows(rows: Record<string, any>[], condition: unknown) {
  const filters = equalityFilters(condition);
  return filters.length === 0
    ? [...rows]
    : rows.filter((row) =>
        filters.every(
          ([field, expected]) =>
            !Object.prototype.hasOwnProperty.call(row, field) ||
            row[field] === expected,
        ),
      );
}

function queryRows(
  rows: Record<string, any>[],
  options: { cloneSelectedRows?: boolean } = {},
) {
  let selected = options.cloneSelectedRows
    ? rows.map((row) => ({ ...row }))
    : [...rows];
  const query = {
    where(condition: unknown) {
      selected = matchingRows(selected, condition);
      return query;
    },
    orderBy() {
      selected.sort((left, right) => {
        if ("ordinal" in left || "ordinal" in right) {
          return Number(left.ordinal || 0) - Number(right.ordinal || 0);
        }
        if ("version" in left || "version" in right) {
          return Number(right.version || 0) - Number(left.version || 0);
        }
        return Number(right.sequence || 0) - Number(left.sequence || 0);
      });
      return query;
    },
    limit(size: number) {
      selected = selected.slice(0, size);
      return query;
    },
    async for() {
      return selected;
    },
    then<TResult1 = Record<string, any>[], TResult2 = never>(
      resolve?:
        | ((value: Record<string, any>[]) => TResult1 | PromiseLike<TResult1>)
        | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(selected).then(resolve, reject);
    },
  };
  return query;
}

function memoryDatabase(
  state: MemoryState,
  options: { cloneSelectedRows?: boolean } = {},
) {
  const insertRows = (table: unknown, values: Array<Record<string, any>>) => {
    const now = new Date();
    for (const value of values) {
      if (table === knowledgeBaseBuilds) {
        const duplicate = state.builds.some(
          (build) =>
            build.id === value.id ||
            (build.userId === value.userId &&
              build.conversationId === value.conversationId),
        );
        if (duplicate) continue;
        state.builds.push({
          upstreamTaskId: null,
          generation: 1,
          stateEpoch: 0,
          activeTurnId: null,
          lastAppliedOperationKey: null,
          currentPresentationKey: null,
          revision: 0,
          currentLeafId: null,
          totalNodeCount: 0,
          confirmedCount: 0,
          directPrefilledCount: 0,
          needsVerificationCount: 0,
          lastReconciledHash: null,
          lastOutputLength: 0,
          lastOutputItemIds: [],
          lastTurnUserText: null,
          lastTurnAttachmentCount: 0,
          awaitingResponseSince: null,
          packageRevision: null,
          packageTaskId: null,
          packageOutputItemId: null,
          packageFileId: null,
          packageFilename: null,
          packageDescriptorHash: null,
          logoStorageKey: null,
          logoSha256: null,
          logoBytes: null,
          logoFilename: null,
          logoMimeType: null,
          packageStorageKey: null,
          packageArchiveSha256: null,
          packageSizeBytes: null,
          protocolErrorCode: null,
          protocolError: null,
          publishedSnapshotId: null,
          completedAt: null,
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
          ...value,
        });
        continue;
      }
      if (table === conversationTurns) {
        const duplicate = state.turns.some(
          (turn) =>
            turn.id === value.id ||
            turn.operationKey === value.operationKey ||
            (turn.conversationId === value.conversationId &&
              turn.clientRequestId === value.clientRequestId),
        );
        if (!duplicate) state.turns.push({ ...value });
        continue;
      }
      if (table === conversations) {
        if (!state.conversations.some((row) => row.id === value.id)) {
          state.conversations.push({
            apiCredentialId: null,
            projectAssignmentId: null,
            status: "running",
            upstreamTaskId: null,
            previousResponseId: null,
            taskUrl: null,
            lastKnownOutputLength: 0,
            deletedMessageIds: [],
            version: 1,
            startedAt: now,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            ...value,
          });
        }
        continue;
      }
      if (table === knowledgeBaseSnapshots) {
        state.snapshots.push(
          ...values.map((snapshot) => ({
            status: "active",
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            ...snapshot,
          })),
        );
        break;
      }
      if (table === upstreamResources) {
        if (
          !state.resources.some(
            (resource) =>
              resource.kind === value.kind &&
              resource.upstreamId === value.upstreamId,
          )
        ) {
          state.resources.push({ ...value });
        }
        continue;
      }
      if (table === messages) {
        if (!state.messages.some((message) => message.id === value.id)) {
          state.messages.push({ ...value });
        }
        continue;
      }
      if (table === knowledgeBaseBuildNodes) {
        state.nodes.push({
          transitionReason: null,
          contentMarkdown: null,
          contentSha256: null,
          lastUserInput: null,
          sourceUrls: [],
          imageUrls: [],
          lastTaskId: null,
          sourceTurnId: null,
          presentationKey: null,
          lastResponseAt: null,
          confirmedAt: null,
          createdAt: now,
          updatedAt: now,
          ...value,
        });
      }
    }
  };
  const db: any = {
    select() {
      return {
        from(table: unknown) {
          return queryRows(rowsFor(table, state), options);
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where(condition: unknown) {
              const targets = matchingRows(rowsFor(table, state), condition);
              targets.forEach((target) => Object.assign(target, values));
              return [{ affectedRows: targets.length }];
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, any> | Record<string, any>[]) {
          const values = Array.isArray(value) ? value : [value];
          let committed = false;
          const commit = () => {
            if (!committed) insertRows(table, values);
            committed = true;
          };
          return {
            async onDuplicateKeyUpdate() {
              commit();
            },
            then<TResult1 = void, TResult2 = never>(
              resolve?:
                | ((value: void) => TResult1 | PromiseLike<TResult1>)
                | null,
              reject?:
                | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                | null,
            ) {
              commit();
              return Promise.resolve().then(resolve, reject);
            },
          };
        },
      };
    },
    async transaction<T>(operation: (tx: any) => Promise<T>) {
      return operation(db);
    },
  };
  return db;
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

async function createFinalPackageFixture(
  input: {
    leafCount?: number;
    buildRevision?: number;
    schemaVersion?: 3 | 4;
    archiveLeafIdPrefix?: string;
    driftLastPackagedLeaf?: boolean;
  } = {},
) {
  const leafCount = input.leafCount ?? FINAL_REVISION;
  const buildRevision = input.buildRevision ?? leafCount;
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
  const logoSha256 = createHash("sha256").update(logo).digest("hex");
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

  const leafFiles: Array<{
    id: string;
    title: string;
    raw: string;
    contentMarkdown: string;
  }> = [];
  for (let index = 0; index < leafCount; index += 1) {
    const id = `1.${index + 1}`;
    const archiveId = `${input.archiveLeafIdPrefix || ""}${id}`;
    const title = `知识节点 ${index + 1}`;
    const narrative = `FrontMind超前智能${String.fromCodePoint(0x7532 + index).repeat(55)}`;
    const raw = formalDocument(`${id} ${title}`, narrative);
    const packagedRaw =
      input.driftLastPackagedLeaf && index === leafCount - 1
        ? formalDocument(
            `${id} ${title}`,
            `FrontMind超前智能${"异".repeat(55)}`,
          )
        : raw;
    const relativePath = `branches/products/leaf-${index + 1}.md`;
    zip.file(`${root}/${relativePath}`, packagedRaw);
    documents.push({
      id: archiveId,
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
    leafFiles.push({
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
    documentIds: [`${input.archiveLeafIdPrefix || ""}1.1`],
    sourcePageUrl: "https://www.frontmind.net/",
    sourceAssetUrl: "https://www.frontmind.net/frontmind-logo.png",
    sourceKind: "official_web",
    ownership: "first_party",
    assetType: "brand_identity",
    displayRole: "badge",
  };
  const assets = [asset];
  const customerVisibleCharacters =
    effectiveCharacterCount(overviewNarrative) +
    leafFiles.reduce((total, _leaf, index) => {
      const narrative = `FrontMind超前智能${String.fromCodePoint(0x7532 + index).repeat(55)}`;
      return total + effectiveCharacterCount(narrative);
    }, 0);
  const evidenceCharacters = effectiveCharacterCount(supporting[0][1]);

  zip.file(
    `${root}/00_completeness.json`,
    JSON.stringify({
      counts: {
        totalLeaves: leafCount,
        verifiedFirstParty: 0,
        verifiedAuthoritative: 0,
        supportedThirdParty: 0,
        inferred: 0,
        needsVerification: leafCount,
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
      schemaVersion: input.schemaVersion ?? 3,
      profile: "dashboard-enterprise-v1",
      buildRevision,
      documents,
      assets,
      counts: {
        totalFiles: documents.length + assets.length + 2,
        customerVisibleCharacters,
        evidenceCharacters,
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
    leaves: leafFiles,
  };
}

function initialState() {
  const now = new Date();
  return {
    credentials: [
      {
        id: "credential-e2e",
        userId: USER_ID,
        version: 1,
        status: "active",
      },
    ],
    users: [
      {
        id: USER_ID,
        username: "frontmind-e2e",
        displayName: "FrontMind超前智能",
        role: "user",
        isActive: true,
      },
    ],
    dashboardContents: [
      {
        userId: USER_ID,
        payload: createDefaultDashboardPayload("FrontMind超前智能"),
        sourceName: "e2e-dashboard.json",
        enterpriseIdentityBoundAt: now,
        revision: 1,
        updatedAt: now,
      },
    ],
    builds: [],
    nodes: [],
    turns: [],
    conversations: [
      {
        id: STORED_CONVERSATION_ID,
        userId: USER_ID,
        apiCredentialId: "credential-e2e",
        projectAssignmentId: null,
        title: "企业知识库构建",
        status: "running",
        upstreamTaskId: null,
        previousResponseId: null,
        taskUrl: null,
        lastKnownOutputLength: 0,
        deletedMessageIds: [],
        version: 0,
        startedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    messages: [],
    snapshots: [],
    resources: [],
  } satisfies MemoryState;
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

describe("knowledge-base production final-package acceptance", () => {
  let assetRoot = "";
  let upstreamServer: Server | undefined;
  let dashboardServer: Server | undefined;
  const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
  const previousRolloutPercent = process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT;
  const previousAxiosAdapter = axios.defaults.adapter;

  beforeAll(async () => {
    axios.defaults.adapter = "http";
    assetRoot = await mkdtemp(path.join(tmpdir(), "frontmind-kb-e2e-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
    // A stale rollout value must not disable the only supported build path.
    process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = "0";
    dependencies.assertServiceCapability.mockResolvedValue(undefined);
    dependencies.assertKnowledgeBaseWritable.mockResolvedValue(undefined);
    dependencies.createKnowledgeMonitoringHandoff.mockResolvedValue({
      created: [],
      assigned: false,
    });
    dependencies.getCredentialForUpstreamResource.mockResolvedValue({
      id: "credential-e2e",
      apiKey: "sk-e2e-only",
    });
    dependencies.getDecryptedCredentialForKnowledgeBaseReservation.mockResolvedValue(
      {
        id: "credential-e2e",
        userId: USER_ID,
        version: 1,
        apiKey: "sk-e2e-only",
        fingerprint: "e2e-fingerprint",
        status: "active",
        verifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    );
    dependencies.recordUpstreamResource.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await Promise.all([close(upstreamServer), close(dashboardServer)]);
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
    if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
  });

  it("initializes a completed v4 zero-image Manifest as a first-leaf Logo upload gate without accepting the same running output", async () => {
    const fixture = await createFinalPackageFixture();
    const state = initialState();
    const buildId = "12121212-1212-4121-8121-121212121212";
    const turnId = "34343434-3434-4343-8343-343434343434";
    const taskId = "task-v4-zero-image-initial";
    const operationKey = "operation-v4-zero-image-initial";
    const now = new Date("2026-08-04T00:00:00.000Z");
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "7".repeat(64),
      status: "researching",
      generation: 1,
      stateEpoch: 1,
      revision: 0,
      currentLeafId: null,
      totalNodeCount: 0,
      confirmedCount: 0,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: turnId,
      upstreamTaskId: taskId,
      lastAppliedOperationKey: null,
      currentPresentationKey: null,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "开始构建企业知识库",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: now,
      packageRevision: null,
      packageTaskId: null,
      packageOutputItemId: null,
      packageFileId: null,
      packageFilename: null,
      packageDescriptorHash: null,
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      protocolErrorCode: null,
      protocolError: null,
      publishedSnapshotId: null,
      completedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    state.turns.push({
      id: turnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId: "request-v4-zero-image-initial",
      buildId,
      buildGeneration: 1,
      operationKey,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: "8".repeat(64),
      upstreamIdempotencyKeyHash: "9".repeat(64),
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: true,
        userAttachmentCount: 0,
        recovery: {},
      },
      leaseExpiresAt: new Date("2026-08-04T00:05:00.000Z"),
      status: "running",
      upstreamTaskId: taskId,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    dependencies.getDb.mockResolvedValue(memoryDatabase(state));

    const manifest = formatKnowledgeBaseManifestEnvelope({
      kind: "frontmind.knowledge-base.manifest",
      schemaVersion: 2,
      operationId: operationKey,
      turnId,
      leaves: fixture.leaves.map((leaf) => ({
        id: leaf.id,
        title: leaf.title,
        branchId: "products",
        branchTitle: "产品与服务",
      })),
    });
    const output = [
      {
        id: "assistant-v4-zero-image-initial",
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
    ];
    const { reconcileKnowledgeBaseProgress } = await import(
      "./knowledge-base-progress-service"
    );

    const streaming = await reconcileKnowledgeBaseProgress({
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      taskId,
      userText: "开始构建企业知识库",
      attachmentCount: 0,
      output,
      upstreamStatus: "running",
    });
    expect(streaming.build).toMatchObject({
      status: "researching",
      revision: 0,
      currentLeafId: null,
      logoRequired: false,
    });
    expect(state.nodes).toHaveLength(0);
    expect(state.turns[0]).toMatchObject({ status: "running" });

    const completed = await reconcileKnowledgeBaseProgress({
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      taskId,
      userText: "开始构建企业知识库",
      attachmentCount: 0,
      output,
      upstreamStatus: "completed",
    });
    expect(completed.build).toMatchObject({
      status: "confirming",
      revision: 0,
      currentLeafId: fixture.leaves[0]!.id,
      logoRequired: true,
    });
    expect(completed.summary).toMatchObject({
      total: fixture.leaves.length,
      handled: 0,
      confirmed: 0,
      current: 1,
      overallPercent: 0,
    });
    expect(state.nodes).toHaveLength(fixture.leaves.length);
    expect(state.nodes[0]).toMatchObject({
      leafId: fixture.leaves[0]!.id,
      ordinal: 0,
      status: "current",
      contentMarkdown: fixture.leaves[0]!.contentMarkdown,
    });
    expect(state.builds[0]).toMatchObject({
      status: "confirming",
      revision: 0,
      currentLeafId: fixture.leaves[0]!.id,
      activeTurnId: null,
      logoStorageKey: null,
      logoSha256: null,
    });
    expect(state.turns[0]).toMatchObject({
      status: "completed",
      upstreamTaskId: taskId,
      errorCode: null,
    });
  });

  it("runs all 8 leaves from manifest and Logo through publish, Viewer and immutable ZIP download", async () => {
    const fixture = await createFinalPackageFixture();
    const state = initialState();
    dependencies.getDb.mockResolvedValue(memoryDatabase(state));
    const archiveSha256 = createHash("sha256")
      .update(fixture.archive)
      .digest("hex");
    const rejectedZip = await JSZip.loadAsync(fixture.archive);
    rejectedZip.comment = "semantically-valid-but-rejected-operation";
    const rejectedArchive = await rejectedZip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
    });
    expect(rejectedArchive.equals(fixture.archive)).toBe(false);
    const rejectedLogo = await sharp({
      create: {
        width: 24,
        height: 24,
        channels: 4,
        background: "#bb2200",
      },
    })
      .png()
      .toBuffer();
    const taskResults = new Map<
      string,
      { status: "awaiting_input" | "completed"; output: unknown[] }
    >();
    const upstream = express();
    upstream.use(express.json({ limit: "5mb" }));
    let upstreamBaseUrl = "";
    let uploadedFileSequence = 0;
    let authoritativeTaskReads = 0;
    let logoDownloads = 0;
    let packageDownloads = 0;
    let currentLogoBytes = rejectedLogo;
    let currentPackageBytes = rejectedArchive;
    let includeFinalPackage = true;
    const uploadedFileBytes = new Map<string, number>();
    const operationTaskPosts = new Map<string, number>();
    let rawTaskPosts = 0;
    let transientConfirmationFailuresRemaining = 1;
    const idempotentTaskResponses = new Map<
      string,
      { id: string; status: "awaiting_input" | "completed"; output: unknown[] }
    >();

    upstream.post("/v1/files", (req, res) => {
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
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
        const bytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
        expect(bytes).toBeGreaterThan(0);
        uploadedFileBytes.set(req.params.fileId, bytes);
        res.status(200).end();
      },
    );
    upstream.post("/v1/tasks", (req, res) => {
      rawTaskPosts += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      const prompt = String(req.body.prompt || "");
      const operationId = prompt.match(/"operationId":"([^"]+)"/u)?.[1];
      const turnId = prompt.match(/"turnId":"([^"]+)"/u)?.[1];
      expect(operationId).toBeTruthy();
      expect(turnId).toBeTruthy();
      const turn = state.turns.find((candidate) => candidate.id === turnId);
      expect(turn).toMatchObject({
        operationKey: operationId,
        status: "running",
      });
      expect(turn?.metadata?.attachmentsFrozen).toBe(true);
      expect(turn?.attachmentFileIds).toEqual(
        req.body.attachments.map((attachment: any) => attachment.file_id),
      );
      const idempotencyKey = String(req.header("idempotency-key") || "");
      expect(idempotencyKey).toBe(`frontmind-kb-v2:${operationId}`);
      const replay = idempotentTaskResponses.get(idempotencyKey);
      if (replay) {
        res.json(replay);
        return;
      }

      const isStart = turn!.operationType === "start";
      if (!isStart && transientConfirmationFailuresRemaining > 0) {
        transientConfirmationFailuresRemaining -= 1;
        res.status(503).json({ error: { message: "temporary overload" } });
        return;
      }
      operationTaskPosts.set(
        operationId!,
        (operationTaskPosts.get(operationId!) || 0) + 1,
      );
      const revision = Number(turn!.expectedRevision);
      if (isStart) {
        expect(req.body.taskId).toBeUndefined();
      } else {
        expect(req.body.taskId).toBe(state.builds[0]!.upstreamTaskId);
      }
      const isFinal = !isStart && revision === fixture.leaves.length - 1;
      const taskId = isStart
        ? "task-initial-manifest-e2e"
        : isFinal
          ? TASK_ID
          : `task-confirm-leaf-${revision + 1}`;
      let output: unknown[];
      if (isStart) {
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
                  value: `## 9.9 错误节点\n\n该正文不能写入首节点。\n${manifest}`,
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
        const progressText = formatKnowledgeBaseProgressEnvelope({
          kind: "frontmind.knowledge-base.progress",
          schemaVersion: 2,
          operationId: operationId!,
          turnId: turnId!,
          revision,
          transition: {
            leafId: leaf.id,
            from: "current",
            // The first final observation is deliberately inconsistent with
            // the user's confirm action. Its ZIP may be staged, but neither
            // the transition nor those bytes may be promoted.
            to: isFinal ? "direct_prefilled" : "confirmed",
            reason: `用户明确确认节点 ${leaf.id}`,
          },
        });
        const presentationText = formatKnowledgeBasePresentationEnvelope({
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
        const currentOperationOutput = [
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
                    progressText,
                    presentationText,
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
                    {
                      type: "output_image",
                      file_id: "forbidden-final-image",
                      file_name: "forbidden.png",
                      mime_type: "image/png",
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
                operationId: state.turns.find(
                  (candidate) => candidate.operationType === "start",
                )!.operationKey,
                turnId: state.turns.find(
                  (candidate) => candidate.operationType === "start",
                )!.id,
              },
              ...currentOperationOutput,
            ]
          : currentOperationOutput;
      }
      const taskResult = {
        id: taskId,
        status: (isFinal ? "completed" : "awaiting_input") as
          | "completed"
          | "awaiting_input",
        output,
      };
      idempotentTaskResponses.set(idempotencyKey, taskResult);
      taskResults.set(taskId, {
        status: taskResult.status,
        output,
      });
      res.json(taskResult);
    });
    upstream.get("/v1/tasks/:taskId", (req, res) => {
      authoritativeTaskReads += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      const result = taskResults.get(req.params.taskId);
      if (!result) {
        res.status(404).json({ error: "fixture task missing" });
        return;
      }
      res.json({
        id: req.params.taskId,
        status: result.status,
        output:
          req.params.taskId === TASK_ID && !includeFinalPackage
            ? result.output.flatMap((item: any) =>
                item.role === "assistant" && Array.isArray(item.content)
                  ? [
                      {
                        ...item,
                        content: item.content.filter(
                          (content: any) => content.type === "output_text",
                        ),
                      },
                    ]
                  : [],
              )
            : result.output,
      });
    });
    upstream.get("/v1/files/file-official-logo/content", (req, res) => {
      logoDownloads += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", String(currentLogoBytes.length));
      res.send(currentLogoBytes);
    });
    upstream.get("/v1/files/file-final-package/content", (req, res) => {
      packageDownloads += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(currentPackageBytes.length));
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="frontmind-knowledge-base.zip"',
      );
      res.send(currentPackageBytes);
    });
    const upstreamListener = await listen(upstream);
    upstreamServer = upstreamListener.server;
    upstreamBaseUrl = upstreamListener.baseUrl;
    dependencies.upstreamBaseUrl = upstreamListener.baseUrl;

    const { default: dashboardRouter } = await import("./dashboard-api");
    const { default: knowledgeBaseRouter } = await import(
      "./knowledge-base-api"
    );
    const { requireExpressAuth } = await import("./_core/express-auth");
    const dashboard = express();
    dashboard.use(express.json());
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
      const response = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base${pathname}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify(body),
        },
      );
      if (pathname === "/turn") {
        expect([200, 202]).toContain(response.status);
      } else {
        expect(response.status).toBe(200);
      }
      const payload = (await response.json()) as any;
      if (pathname !== "/turn" || payload.idempotent) return payload;
      expect(response.status).toBe(202);

      const clientRequestId = String(body.clientRequestId || "");
      const deadline = Date.now() + 5_000;
      let acceptedTurn: (typeof state.turns)[number] | undefined;
      while (Date.now() < deadline) {
        acceptedTurn = state.turns.find(
          (candidate) => candidate.clientRequestId === clientRequestId,
        );
        const build = state.builds.find(
          (candidate) => candidate.id === acceptedTurn?.buildId,
        );
        const isDeliberatelyRejectedFinalTurn =
          acceptedTurn?.expectedRevision === fixture.leaves.length - 1;
        const dispatchSettled = Boolean(
          acceptedTurn?.upstreamTaskId &&
            ((build && build.revision > acceptedTurn.expectedRevision) ||
              (isDeliberatelyRejectedFinalTurn && packageDownloads > 0) ||
              acceptedTurn.status === "completed" ||
              acceptedTurn.status === "failed" ||
              acceptedTurn.status === "cancelled" ||
              build?.activeTurnId !== acceptedTurn.id ||
              build?.status === "protocol_error"),
        );
        if (dispatchSettled) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(acceptedTurn?.upstreamTaskId).toBeTruthy();
      const observationResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/progress/${encodeURIComponent(String(body.conversationId || ""))}`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(observationResponse.status).toBe(200);
      const observed = (await observationResponse.json()) as any;
      return {
        ...payload,
        task: { id: acceptedTurn!.upstreamTaskId, status: "running" },
        observation: observed.observation,
        progress: observed.progress,
        interaction: observed.interaction,
      };
    };

    const startRequest = {
      conversationId: PUBLIC_CONVERSATION_ID,
      clientRequestId: "request-initial-manifest",
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
    };
    const rejectedInitialObservation = await postKnowledgeBase(
      "/start",
      startRequest,
    );
    const buildId = state.builds[0]!.id;
    const initialTaskId = rejectedInitialObservation.task.id as string;
    expect(state.nodes).toHaveLength(0);
    expect(state.builds[0]).toMatchObject({
      status: "researching",
      logoStorageKey: null,
      logoSha256: null,
    });
    expect(logoDownloads).toBe(1);

    // The provider replaces the same file ID with corrected bytes and a valid
    // first-node body. The rejected candidate must not poison this generation.
    const correctedInitialOutput = taskResults.get(initialTaskId)!.output;
    const correctedAssistant = correctedInitialOutput.find(
      (item: any) => item.id === "assistant-initial",
    ) as any;
    const manifestText = String(correctedAssistant.content[0].text.value).match(
      /<!--\s*FRONTMIND_KB_MANIFEST[\s\S]*?-->/u,
    )?.[0];
    correctedAssistant.content[0].text.value = `${fixture.leaves[0]!.contentMarkdown}\n${manifestText}`;
    currentLogoBytes = fixture.logo;
    const reconcileResponse = await fetch(
      `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "user",
        },
        body: JSON.stringify({
          conversationId: PUBLIC_CONVERSATION_ID,
          taskId: initialTaskId,
        }),
      },
    );
    expect(reconcileResponse.status).toBe(200);
    const initialObservation = (await reconcileResponse.json()) as any;
    const startTurn = state.turns.find(
      (turn) => turn.operationType === "start",
    )!;
    expect(initialObservation.observation).toMatchObject({
      generation: 1,
      authoritativeTaskId: initialTaskId,
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
        clientRequestId: startRequest.clientRequestId,
        revision: 0,
        leafId: "1.1",
        visibleMarkdown: fixture.leaves[0]!.contentMarkdown,
        imageState: "attached",
        resources: [
          expect.objectContaining({
            kind: "logo",
            sameOriginUrl: `/api/knowledge-base/artifacts/${buildId}/logo`,
            sha256: fixture.logoSha256,
          }),
        ],
      },
    });
    expect(state.nodes).toHaveLength(8);
    expect(state.nodes[0]).toMatchObject({
      leafId: "1.1",
      status: "current",
      contentMarkdown: fixture.leaves[0]!.contentMarkdown,
    });
    expect(
      state.nodes.slice(1).every((node) => node.status === "pending"),
    ).toBe(true);
    expect(logoDownloads).toBe(2);
    expect(startTurn).toMatchObject({
      status: "completed",
      upstreamTaskId: initialTaskId,
      attachmentFileIds: [expect.stringMatching(/^uploaded-skill-/u)],
      metadata: expect.objectContaining({ attachmentsFrozen: true }),
    });
    const startTaskPostCount = operationTaskPosts.get(startTurn.operationKey);
    const uploadedCountAfterStart = uploadedFileSequence;
    const repeatedStart = await postKnowledgeBase("/start", startRequest);
    expect(repeatedStart).toMatchObject({ idempotent: true, resumed: true });
    expect(operationTaskPosts.get(startTurn.operationKey)).toBe(
      startTaskPostCount,
    );
    expect(uploadedFileSequence).toBe(uploadedCountAfterStart);

    for (const conflictingStart of [
      {
        ...startRequest,
        operatorNotes: "与首次启动不同的输入",
      },
      {
        ...startRequest,
        clientRequestId: "request-conflicting-start",
      },
    ]) {
      const response = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/start`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify(conflictingStart),
        },
      );
      expect(response.status).toBe(409);
      const conflict = (await response.json()) as any;
      expect(conflict).toMatchObject({
        error: { code: "CONFLICT" },
        observation: {
          authoritativeTaskId: initialTaskId,
          interaction: {
            progress: {
              build: { revision: 0, currentLeafId: "1.1" },
            },
          },
        },
      });
    }
    expect(operationTaskPosts.get(startTurn.operationKey)).toBe(
      startTaskPostCount,
    );
    expect(uploadedFileSequence).toBe(uploadedCountAfterStart);

    let finalOperationKey = "";
    for (let index = 0; index < fixture.leaves.length; index += 1) {
      const leaf = fixture.leaves[index]!;
      const isFinal = index === fixture.leaves.length - 1;
      const turnRequest = {
        conversationId: PUBLIC_CONVERSATION_ID,
        clientRequestId: `request-confirm-${index + 1}`,
        userMessage: "确认",
        expectedRevision: index,
        expectedLeafId: leaf.id,
      };
      let result = await postKnowledgeBase("/turn", turnRequest);
      const expectedRevision = index + 1;
      const turn = state.turns.find(
        (candidate) =>
          candidate.clientRequestId === turnRequest.clientRequestId,
      )!;
      finalOperationKey = turn.operationKey;
      const turnTaskId = result.task.id;
      if (isFinal) {
        expect(state.builds[0]).toMatchObject({
          status: "confirming",
          revision: fixture.leaves.length - 1,
          currentLeafId: leaf.id,
          packageStorageKey: null,
        });
        expect(packageDownloads).toBe(1);
        const finalTask = taskResults.get(TASK_ID)!;
        const finalAssistant = finalTask.output.find(
          (item: any) => item.id === `assistant-confirm-${index + 1}`,
        ) as any;
        const finalText = finalAssistant.content.find(
          (content: any) => content.type === "output_text",
        );
        const rejectedFinalText = String(finalText.text.value);
        finalText.text.value = rejectedFinalText.replace(
          '"to":"direct_prefilled"',
          '"to":"confirmed"',
        );
        expect(finalText.text.value).not.toBe(rejectedFinalText);
        finalAssistant.content = finalAssistant.content.filter(
          (content: any) => content.type !== "output_image",
        );
        currentPackageBytes = fixture.archive;
        const response = await fetch(
          `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-auth": "user",
            },
            body: JSON.stringify({
              conversationId: PUBLIC_CONVERSATION_ID,
              taskId: TASK_ID,
            }),
          },
        );
        expect(response.status).toBe(200);
        result = await response.json();
      }
      expect(turn).toMatchObject({
        operationType: "confirm",
        expectedRevision: index,
        expectedLeafId: leaf.id,
        status: "completed",
        upstreamTaskId: turnTaskId,
        attachmentFileIds: [expect.stringMatching(/^uploaded-skill-/u)],
        metadata: expect.objectContaining({ attachmentsFrozen: true }),
      });
      if (isFinal) {
        expect(result.observation).toMatchObject({
          authoritativeTaskId: TASK_ID,
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
        // Keep the stale ZIP in the cumulative task. Historical package
        // recovery must select the persisted file identity rather than assume
        // a settled task contains only one ZIP descriptor.
        expect(taskResults.get(TASK_ID)!.output).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "stale-package-from-cumulative-history",
            }),
          ]),
        );
      } else {
        const nextLeaf = fixture.leaves[index + 1]!;
        expect(result.observation).toMatchObject({
          authoritativeTaskId: turnTaskId,
          notice: null,
          interaction: {
            interactionState: "awaiting_input",
            canReply: true,
            progress: {
              build: {
                status: "confirming",
                revision: expectedRevision,
                currentLeafId: nextLeaf.id,
              },
            },
          },
          approvedPresentation: {
            clientRequestId: turnRequest.clientRequestId,
            revision: expectedRevision,
            leafId: nextLeaf.id,
            visibleMarkdown: nextLeaf.contentMarkdown,
            imageState: "no_eligible_asset",
            resources: [],
          },
        });
      }
      expect(state.builds[0]!.confirmedCount).toBe(expectedRevision);
      const output = taskResults.get(turnTaskId)!.output;
      expect(
        output.some((item: any) =>
          JSON.stringify(item).match(/output_image|image\//u),
        ),
      ).toBe(false);
      const taskPostCount = operationTaskPosts.get(turn.operationKey);
      const uploadedCount = uploadedFileSequence;
      const repeated = await postKnowledgeBase("/turn", turnRequest);
      expect(repeated).toMatchObject({
        idempotent: true,
        task: { id: turnTaskId },
      });
      expect(operationTaskPosts.get(turn.operationKey)).toBe(taskPostCount);
      expect(uploadedFileSequence).toBe(uploadedCount);

      if (index === 0) {
        // The first application above used the operation tail. A later poll
        // of the very same task now expands to the provider's cumulative
        // snapshot, including the old Manifest and Logo. Replaying it several
        // times must be an immutable noop: no stale/protocol notice, no second
        // transition and no loss of the approved 1.2 presentation.
        const currentTask = taskResults.get(turnTaskId)!;
        currentTask.output = [
          ...taskResults.get(initialTaskId)!.output,
          ...currentTask.output,
        ];
        const epochAfterTail = state.builds[0]!.stateEpoch;
        const approvedContentAfterTail = state.nodes[1]!.contentMarkdown;
        const credentialReadsAfterTail =
          dependencies.getCredentialForUpstreamResource.mock.calls.length;
        const upstreamReadsAfterTail = authoritativeTaskReads;
        for (let replay = 0; replay < 3; replay += 1) {
          const response = await fetch(
            `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-test-auth": "user",
              },
              body: JSON.stringify({
                conversationId: PUBLIC_CONVERSATION_ID,
              }),
            },
          );
          expect(response.status).toBe(200);
          expect((await response.json()) as any).toMatchObject({
            observation: {
              notice: null,
              interaction: {
                interactionState: "awaiting_input",
                progress: {
                  build: {
                    status: "confirming",
                    revision: 1,
                    currentLeafId: "1.2",
                  },
                },
              },
              approvedPresentation: {
                revision: 1,
                leafId: "1.2",
                visibleMarkdown: fixture.leaves[1]!.contentMarkdown,
                resources: [],
              },
            },
          });
          expect(state.builds[0]).toMatchObject({
            stateEpoch: epochAfterTail,
            revision: 1,
            currentLeafId: "1.2",
            protocolError: null,
            protocolErrorCode: null,
          });
          expect(state.nodes[1]!.contentMarkdown).toBe(
            approvedContentAfterTail,
          );
        }
        // These three requests model focus/online wakes spanning the failure
        // debounce window. Even if the completed task's Key were deleted, its
        // reads timed out, or it returned 401, no credential/task access is
        // attempted after the approved 1.2 projection released activeTurnId.
        expect(
          dependencies.getCredentialForUpstreamResource.mock.calls.length,
        ).toBe(credentialReadsAfterTail);
        expect(authoritativeTaskReads).toBe(upstreamReadsAfterTail);
      }
    }

    expect(authoritativeTaskReads).toBe(2);
    expect(logoDownloads).toBe(2);
    expect(packageDownloads).toBe(2);
    // The Skill is a build-scoped immutable asset: upload it once at start,
    // then reuse the same owned file id for every confirmed leaf.
    expect(uploadedFileSequence).toBe(1);
    expect(uploadedFileBytes.size).toBe(1);
    expect(
      new Set(
        state.turns
          .flatMap((turn) => turn.attachmentFileIds || [])
          .filter((fileId) => /^uploaded-skill-/u.test(fileId)),
      ),
    ).toEqual(new Set(["uploaded-skill-1"]));
    expect(operationTaskPosts.size).toBe(9);
    expect([...operationTaskPosts.values()]).toEqual(Array(9).fill(1));
    expect(rawTaskPosts).toBe(10);
    expect(state.builds[0]).toMatchObject({
      id: buildId,
      // reservation + upstream binding + authoritative reconcile per operation
      stateEpoch: 27,
      lastAppliedOperationKey: finalOperationKey,
      protocolError: null,
      protocolErrorCode: null,
    });
    expect(
      state.turns
        .filter(
          (turn) =>
            turn.operationType === "start" || turn.operationType === "confirm",
        )
        .every((turn) => turn.status === "completed"),
    ).toBe(true);
    const presentationMessages = state.messages.filter(
      (message) => message.metadata?.knowledgeBase?.kind === "presentation",
    );
    expect(
      presentationMessages.map((message) => ({
        leafId: message.metadata.knowledgeBase.leafId,
        revision: message.metadata.knowledgeBase.revision,
        content: message.content,
      })),
    ).toEqual(
      fixture.leaves.map((leaf, revision) => ({
        leafId: leaf.id,
        revision,
        content: leaf.contentMarkdown,
      })),
    );
    expect(
      new Set(presentationMessages.map((message) => message.turnId)).size,
    ).toBe(8);
    expect(state.nodes.every((node) => node.status === "confirmed")).toBe(true);
    expect(
      state.nodes.map((node) => ({
        id: node.leafId,
        revisionContent: node.contentMarkdown,
        hash: node.contentSha256,
      })),
    ).toEqual(
      fixture.leaves.map((leaf) => ({
        id: leaf.id,
        revisionContent: leaf.contentMarkdown,
        hash: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
      })),
    );
    expect(state.builds[0]).toMatchObject({
      status: "ready_to_publish",
      revision: FINAL_REVISION,
      currentLeafId: null,
      confirmedCount: 8,
      packageRevision: FINAL_REVISION,
      packageArchiveSha256: archiveSha256,
      logoSha256: fixture.logoSha256,
    });
    const artifactStore = await import("./knowledge-build-artifact-store");
    const artifactBinding = await import(
      "./knowledge-base-artifact-binding-service"
    );
    const orphanCleanup =
      await artifactBinding.cleanupOrphanedKnowledgeBuildArtifactCandidates({
        olderThan: new Date(Date.now() + 1_000),
        limit: 100,
      });
    expect(orphanCleanup).toEqual({
      scanned: 4,
      deleted: 2,
      retained: 2,
      failed: 0,
    });
    expect(
      await artifactStore.readKnowledgeBuildArtifact({
        userId: USER_ID,
        buildId,
        generation: 1,
        kind: "logo",
        expectedSha256: fixture.logoSha256,
        expectedBytes: fixture.logo.length,
        storageKey: state.builds[0]!.logoStorageKey!,
      }),
    ).toEqual(fixture.logo);
    expect(
      await artifactStore.readKnowledgeBuildArtifact({
        userId: USER_ID,
        buildId,
        generation: 1,
        kind: "package",
        expectedSha256: archiveSha256,
        expectedBytes: fixture.archive.length,
        storageKey: state.builds[0]!.packageStorageKey!,
      }),
    ).toEqual(fixture.archive);
    const { getKnowledgeBaseObservationProjection } = await import(
      "./knowledge-base-progress-service"
    );

    // Backfill deliberately revoked publication eligibility because this
    // historical ready build had no Dashboard-owned package bytes. Recovery
    // must reread the same settled task; it must not reserve a new turn.
    await artifactStore.removeKnowledgeBuildArtifact({
      userId: USER_ID,
      buildId,
      generation: 1,
      kind: "package",
      storageKey: state.builds[0]!.packageStorageKey!,
    });
    const persistedPackageIdentity = {
      packageRevision: state.builds[0]!.packageRevision,
      packageTaskId: state.builds[0]!.packageTaskId,
      packageOutputItemId: state.builds[0]!.packageOutputItemId,
      packageFileId: state.builds[0]!.packageFileId,
      packageFilename: state.builds[0]!.packageFilename,
      packageDescriptorHash: state.builds[0]!.packageDescriptorHash,
    };
    expect(persistedPackageIdentity).toMatchObject({
      packageRevision: FINAL_REVISION,
      packageTaskId: TASK_ID,
      packageOutputItemId: expect.any(String),
      packageFileId: "file-final-package",
      packageDescriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    Object.assign(state.builds[0]!, {
      status: "protocol_error",
      stateEpoch: state.builds[0]!.stateEpoch + 1,
      protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
      protocolError:
        "历史知识库成品未能固化，请重新绑定通过校验的最终 ZIP 后再发布",
      ...persistedPackageIdentity,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      updatedAt: new Date("2026-08-01T00:01:00.000Z"),
    });
    const rebindStateEpoch = state.builds[0]!.stateEpoch;
    await expect(
      getKnowledgeBaseObservationProjection({
        userId: USER_ID,
        conversationId: PUBLIC_CONVERSATION_ID,
      }),
    ).resolves.toMatchObject({
      notice: {
        code: "PACKAGE_REBIND_REQUIRED",
        retryable: true,
      },
      package: null,
    });

    const turnCountBeforeRebind = state.turns.length;
    const readsBeforeRebind = authoritativeTaskReads;
    dependencies.getCredentialForUpstreamResource.mockResolvedValueOnce(null);
    const unavailableCredentialResponse = await fetch(
      `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "user",
        },
        body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
      },
    );
    expect(unavailableCredentialResponse.status).toBe(200);
    expect((await unavailableCredentialResponse.json()) as any).toMatchObject({
      observation: {
        notice: {
          code: "PACKAGE_REBIND_REQUIRED",
          retryable: true,
        },
      },
    });
    expect(authoritativeTaskReads).toBe(readsBeforeRebind);
    expect(state.builds[0]).toMatchObject({
      status: "protocol_error",
      stateEpoch: rebindStateEpoch,
      protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
    });
    expect(state.turns).toHaveLength(turnCountBeforeRebind);

    includeFinalPackage = false;
    const partialRebindResponse = await fetch(
      `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "user",
        },
        body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
      },
    );
    expect(partialRebindResponse.status).toBe(200);
    expect((await partialRebindResponse.json()) as any).toMatchObject({
      observation: {
        notice: {
          code: "PACKAGE_REBIND_REQUIRED",
          retryable: true,
        },
        package: null,
      },
    });
    expect(state.builds[0]).toMatchObject({
      status: "protocol_error",
      stateEpoch: rebindStateEpoch,
      protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
    });
    expect(state.turns).toHaveLength(turnCountBeforeRebind);

    includeFinalPackage = true;
    const rebindResponse = await fetch(
      `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "user",
        },
        body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
      },
    );
    expect(rebindResponse.status).toBe(200);
    const rebound = (await rebindResponse.json()) as any;
    expect(rebound.observation).toMatchObject({
      authoritativeTaskId: TASK_ID,
      notice: null,
      interaction: {
        interactionState: "ready_to_publish",
        canPublish: true,
      },
      package: {
        revision: FINAL_REVISION,
        sha256: archiveSha256,
        sizeBytes: fixture.archive.length,
      },
    });
    expect(authoritativeTaskReads).toBe(readsBeforeRebind + 2);
    expect(state.turns).toHaveLength(turnCountBeforeRebind);
    expect(state.builds[0]).toMatchObject({
      status: "ready_to_publish",
      stateEpoch: rebindStateEpoch + 1,
      packageRevision: FINAL_REVISION,
      packageTaskId: TASK_ID,
      packageArchiveSha256: archiveSha256,
      protocolError: null,
      protocolErrorCode: null,
    });

    // Historical incremental deployments could already have the authoritative
    // ZIP while the first-node Logo was never copied into Dashboard storage.
    // The dedicated rebind must recover the Logo from that same ZIP; merely
    // seeing durable package bytes is not enough to clear the notice.
    await artifactStore.removeKnowledgeBuildArtifact({
      userId: USER_ID,
      buildId,
      generation: 1,
      kind: "logo",
      storageKey: state.builds[0]!.logoStorageKey!,
    });
    const missingLogoRecoveryEpoch = state.builds[0]!.stateEpoch + 1;
    Object.assign(state.builds[0]!, {
      status: "protocol_error",
      stateEpoch: missingLogoRecoveryEpoch,
      protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
      protocolError: "历史 Logo 尚未完成固化",
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
    });
    const readsBeforeLogoRecovery = authoritativeTaskReads;
    const downloadsBeforeLogoRecovery = packageDownloads;
    const missingLogoRebindRequests = await Promise.all(
      [0, 1].map(() =>
        fetch(
          `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-auth": "user",
            },
            body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
          },
        ),
      ),
    );
    for (const response of missingLogoRebindRequests) {
      expect(response.status).toBe(200);
      expect((await response.json()) as any).toMatchObject({
        observation: {
          notice: null,
          interaction: { interactionState: "ready_to_publish" },
        },
      });
    }
    expect(state.builds[0]).toMatchObject({
      status: "ready_to_publish",
      stateEpoch: missingLogoRecoveryEpoch + 1,
      logoStorageKey: expect.any(String),
      logoSha256: fixture.logoSha256,
      logoBytes: fixture.logo.length,
      protocolError: null,
      protocolErrorCode: null,
    });
    expect(authoritativeTaskReads).toBeGreaterThanOrEqual(
      readsBeforeLogoRecovery + 1,
    );
    expect(authoritativeTaskReads).toBeLessThanOrEqual(
      readsBeforeLogoRecovery + 2,
    );
    expect(packageDownloads).toBe(downloadsBeforeLogoRecovery + 1);
    await expect(
      artifactStore.readKnowledgeBuildArtifact({
        userId: USER_ID,
        buildId,
        generation: 1,
        kind: "logo",
        storageKey: state.builds[0]!.logoStorageKey!,
        expectedSha256: fixture.logoSha256,
        expectedBytes: fixture.logo.length,
      }),
    ).resolves.toEqual(fixture.logo);

    // A legacy/inconsistent row may already point at verified immutable bytes
    // while retaining the rebind notice. Reconcile verifies those bytes and
    // clears only the recovery state without downloading or creating a turn.
    const durableRecoveryEpoch = state.builds[0]!.stateEpoch + 1;
    Object.assign(state.builds[0]!, {
      status: "protocol_error",
      stateEpoch: durableRecoveryEpoch,
      protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
      protocolError: "历史成品状态等待重新绑定",
    });
    const readsBeforeDurableRebind = authoritativeTaskReads;
    const downloadsBeforeDurableRebind = packageDownloads;
    const durableRebindResponse = await fetch(
      `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "user",
        },
        body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
      },
    );
    expect(durableRebindResponse.status).toBe(200);
    expect((await durableRebindResponse.json()) as any).toMatchObject({
      observation: {
        notice: null,
        interaction: { interactionState: "ready_to_publish" },
        package: { sha256: archiveSha256 },
      },
    });
    expect(state.builds[0]).toMatchObject({
      status: "ready_to_publish",
      stateEpoch: durableRecoveryEpoch + 1,
      protocolError: null,
      protocolErrorCode: null,
    });
    expect(authoritativeTaskReads).toBe(readsBeforeDurableRebind + 1);
    expect(packageDownloads).toBe(downloadsBeforeDurableRebind);
    expect(state.turns).toHaveLength(turnCountBeforeRebind);

    const repeatedRebindResponse = await fetch(
      `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "user",
        },
        body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
      },
    );
    expect(repeatedRebindResponse.status).toBe(200);
    expect((await repeatedRebindResponse.json()) as any).toMatchObject({
      observation: {
        notice: null,
        interaction: { interactionState: "ready_to_publish" },
      },
    });
    expect(authoritativeTaskReads).toBe(readsBeforeDurableRebind + 1);
    expect(packageDownloads).toBe(downloadsBeforeDurableRebind);
    expect(state.turns).toHaveLength(turnCountBeforeRebind);

    const unauthenticatedPublish = await fetch(
      `${dashboardListener.baseUrl}/api/dashboard/knowledge/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
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
        body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
      },
    );
    expect(publishResponse.status).toBe(200);
    const published = (await publishResponse.json()) as any;
    expect(published.kind).toBe("knowledge");
    expect(published.snapshot).toMatchObject({
      sourceBuildId: buildId,
      sourceBuildRevision: FINAL_REVISION,
      sourceTaskId: TASK_ID,
      sourceArtifactHash: archiveSha256,
      archiveHash: archiveSha256,
      archiveAvailable: true,
      imageCount: 1,
    });
    expect(state.builds[0]).toMatchObject({
      status: "published",
      revision: FINAL_REVISION,
      publishedSnapshotId: published.snapshot.id,
    });
    const { isAuthenticatedAdvancedKnowledgePublication } = await import(
      "./authenticated-knowledge-service"
    );
    expect(
      isAuthenticatedAdvancedKnowledgePublication({
        snapshot: state.snapshots[0] as any,
        build: state.builds[0] as any,
        notBefore: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ).toBe(true);

    const { getLatestKnowledgeSnapshot } = await import("./dashboard-service");
    const viewerSnapshot = await getLatestKnowledgeSnapshot(USER_ID);
    expect(viewerSnapshot).toMatchObject({
      id: published.snapshot.id,
      sourceBuildId: buildId,
      sourceBuildRevision: FINAL_REVISION,
      archiveHash: archiveSha256,
      archiveAvailable: true,
    });
    const viewerLeaves = viewerSnapshot!.documents
      .filter((document: any) => document.kind === "leaf")
      .sort((left: any, right: any) => left.order - right.order);
    expect(viewerLeaves).toHaveLength(8);
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
      state.nodes.map((node) => ({
        id: node.leafId,
        title: node.title,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
        order: node.ordinal,
        content: node.contentMarkdown,
      })),
    );
    expect(
      viewerLeaves.every(
        (document: any) =>
          !document.content.includes("FRONTMIND_FORMAL_CONTENT") &&
          knowledgeBaseMarkdownSha256(document.content) ===
            state.nodes[document.order]!.contentSha256,
      ),
    ).toBe(true);
    expect(viewerSnapshot!.assets).toEqual([
      expect.objectContaining({
        id: "official-logo",
        sha256: fixture.logoSha256,
        url: `/api/dashboard/knowledge/assets/${published.snapshot.id}/by-id/official-logo`,
      }),
    ]);

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
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
      archiveSha256,
    );

    const { readKnowledgeArchive } = await import("./dashboard-api");
    const unpacked = await readKnowledgeArchive(
      downloaded,
      "frontmind-knowledge-base.zip",
      "33333333-3333-4333-8333-333333333333",
      {
        validationProfile: "dashboard-enterprise-v1",
        archiveContractVersions: [3],
      },
    );
    expect(unpacked.packageBuildRevision).toBe(FINAL_REVISION);
    expect(unpacked.assets).toEqual([
      expect.objectContaining({
        id: "official-logo",
        sha256: fixture.logoSha256,
      }),
    ]);
    const unpackedLeaves = unpacked.documents
      .filter((document) => document.kind === "leaf")
      .sort((left, right) => left.order! - right.order!);
    expect(
      unpackedLeaves.map((document) => ({
        id: document.id,
        hash: knowledgeBaseMarkdownSha256(document.content),
      })),
    ).toEqual(
      state.nodes.map((node) => ({
        id: node.leafId,
        hash: node.contentSha256,
      })),
    );
  }, 120_000);

  it("recovers the original final turn when the same settled task appends its ZIP", async () => {
    const finalRevision = 45;
    const priorRevision = finalRevision - 1;
    const buildId = "99999999-9999-4999-8999-999999999999";
    const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const taskId = "task-late-final-package-e2e";
    const operationKey = "operation-late-final-package-e2e";
    const now = new Date("2026-08-03T00:00:00.000Z");
    const fixture = await createFinalPackageFixture({
      leafCount: finalRevision,
      buildRevision: finalRevision,
      schemaVersion: 4,
      archiveLeafIdPrefix: "leaf-",
      driftLastPackagedLeaf: true,
    });
    const sealedArchive = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: fixture.archive,
      nodes: fixture.leaves.map((leaf, ordinal) => ({
        leafId: leaf.id,
        title: leaf.title,
        branchId: "products",
        branchTitle: "产品与服务",
        ordinal,
        status: "confirmed",
        contentMarkdown: leaf.contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
      })),
      buildRevision: finalRevision,
    });
    expect(sealedArchive.changed).toBe(true);
    expect(sealedArchive.buffer.equals(fixture.archive)).toBe(false);
    const archiveSha256 = createHash("sha256")
      .update(sealedArchive.buffer)
      .digest("hex");
    const artifactStore = await import("./knowledge-build-artifact-store");
    const persistedLogo = await artifactStore.persistKnowledgeBuildArtifact({
      userId: USER_ID,
      buildId,
      generation: 1,
      kind: "logo",
      buffer: fixture.logo,
      expectedSha256: fixture.logoSha256,
    });
    const state = initialState();
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "4".repeat(64),
      status: "confirming",
      generation: 1,
      stateEpoch: 10,
      revision: priorRevision,
      currentLeafId: `1.${finalRevision}`,
      totalNodeCount: finalRevision,
      confirmedCount: priorRevision,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: turnId,
      upstreamTaskId: taskId,
      lastAppliedOperationKey: null,
      currentPresentationKey: "presentation-current-final-leaf",
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "确认",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: now,
      packageRevision: null,
      packageTaskId: null,
      packageOutputItemId: null,
      packageFileId: null,
      packageFilename: null,
      packageDescriptorHash: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      logoStorageKey: persistedLogo.storageKey,
      logoSha256: persistedLogo.sha256,
      logoBytes: persistedLogo.bytes,
      logoFilename: "frontmind-logo.png",
      logoMimeType: "image/png",
      protocolError: null,
      protocolErrorCode: null,
      publishedSnapshotId: null,
      completedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    state.nodes.push(
      ...fixture.leaves.map((leaf, ordinal) => ({
        id: `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`,
        buildId,
        leafId: leaf.id,
        branchId: "products",
        branchTitle: "产品与服务",
        title: leaf.title,
        ordinal,
        status: ordinal < priorRevision ? "confirmed" : "current",
        transitionReason:
          ordinal < priorRevision ? "已在先前轮次确认" : "当前最后节点",
        contentMarkdown: leaf.contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
        lastUserInput: null,
        sourceUrls: [],
        imageUrls: [],
        lastTaskId: null,
        sourceTurnId: null,
        presentationKey:
          ordinal === priorRevision
            ? "presentation-current-final-leaf"
            : `presentation-approved-${ordinal + 1}`,
        lastResponseAt: now,
        confirmedAt: ordinal < priorRevision ? now : null,
        createdAt: now,
        updatedAt: now,
      })),
    );
    state.turns.push({
      id: turnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId: "request-late-final-package-e2e",
      buildId,
      buildGeneration: 1,
      operationKey,
      operationType: "confirm",
      expectedRevision: priorRevision,
      expectedLeafId: `1.${finalRevision}`,
      requestHash: "5".repeat(64),
      upstreamIdempotencyKeyHash: "6".repeat(64),
      attachmentFileIds: [],
      metadata: { attachmentsFrozen: true, recovery: {} },
      leaseExpiresAt: new Date("2026-08-03T00:05:00.000Z"),
      status: "running",
      upstreamTaskId: taskId,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    // Real database reads return snapshots. Clone selected rows here so the
    // recovery CAS compares its pre-update stateEpoch with the rebound row,
    // rather than observing this in-memory adapter's Object.assign mutation.
    dependencies.getDb.mockResolvedValue(
      memoryDatabase(state, { cloneSelectedRows: true }),
    );

    const progressText = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: operationKey,
      turnId,
      revision: priorRevision,
      transition: {
        leafId: `1.${finalRevision}`,
        from: "current",
        to: "confirmed",
        reason: "用户明确确认最后节点",
      },
    });
    const presentationText = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 2,
      operationId: operationKey,
      turnId,
      revision: finalRevision,
      leafId: null,
      imageState: "not_applicable",
      assetIds: [],
      imageCount: 0,
    });
    const finalTextContent = {
      type: "output_text",
      text: {
        value: [
          `1.${finalRevision} 已确认。`,
          progressText,
          presentationText,
        ].join("\n"),
      },
    };
    const textOnlyOutput = [
      {
        id: "assistant-late-final-package",
        role: "assistant",
        type: "output_message",
        content: [finalTextContent],
      },
    ];

    const { reconcileKnowledgeBaseProgress } = await import(
      "./knowledge-base-progress-service"
    );
    vi.useFakeTimers();
    try {
      for (const second of [0, 5, 10]) {
        vi.setSystemTime(
          new Date(`2026-08-03T00:00:${String(second).padStart(2, "0")}.000Z`),
        );
        const progress = await reconcileKnowledgeBaseProgress({
          userId: USER_ID,
          conversationId: PUBLIC_CONVERSATION_ID,
          taskId,
          userText: "确认",
          attachmentCount: 0,
          output: textOnlyOutput,
          upstreamStatus: "completed",
        });
        expect(progress.build).toMatchObject({
          status: second === 10 ? "protocol_error" : "confirming",
          revision: priorRevision,
          currentLeafId: `1.${finalRevision}`,
        });
        expect(progress.summary).toMatchObject({
          total: finalRevision,
          handled: priorRevision,
          confirmed: priorRevision,
          current: 1,
          overallPercent: 98,
        });
      }
    } finally {
      vi.useRealTimers();
    }

    expect(state.builds[0]).toMatchObject({
      status: "protocol_error",
      stateEpoch: 11,
      revision: priorRevision,
      currentLeafId: `1.${finalRevision}`,
      confirmedCount: priorRevision,
      activeTurnId: turnId,
      upstreamTaskId: taskId,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      protocolErrorCode: "FINAL_PACKAGE_MISSING",
      packageRevision: null,
      packageTaskId: null,
      packageOutputItemId: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
    });
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      id: turnId,
      operationKey,
      status: "failed",
      upstreamTaskId: taskId,
      errorCode: "FINAL_PACKAGE_MISSING",
      leaseExpiresAt: null,
    });
    expect(
      state.nodes.filter((node) => node.status === "confirmed"),
    ).toHaveLength(priorRevision);
    expect(state.nodes[priorRevision]).toMatchObject({
      leafId: `1.${finalRevision}`,
      status: "current",
    });

    const outputWithLatePackage = [
      {
        ...textOnlyOutput[0],
        content: [
          finalTextContent,
          {
            type: "output_file",
            file_id: "file-late-final-package",
            file_name: "frontmind-knowledge-base.zip",
            mime_type: "application/zip",
          },
        ],
      },
    ];
    let taskReads = 0;
    let packageDownloads = 0;
    const upstream = express();
    upstream.get("/v1/tasks/:taskId", (req, res) => {
      taskReads += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      expect(req.params.taskId).toBe(taskId);
      res.json({
        id: taskId,
        status: "completed",
        output: outputWithLatePackage,
      });
    });
    upstream.get("/v1/files/file-late-final-package/content", (req, res) => {
      packageDownloads += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(fixture.archive.length));
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="frontmind-knowledge-base.zip"',
      );
      res.send(fixture.archive);
    });
    const upstreamListener = await listen(upstream);
    dependencies.upstreamBaseUrl = upstreamListener.baseUrl;
    dependencies.getCredentialForUpstreamResource.mockResolvedValue({
      id: "credential-e2e",
      apiKey: "sk-e2e-only",
    });

    let dashboardListener: Awaited<ReturnType<typeof listen>> | undefined;
    try {
      const { default: knowledgeBaseRouter } = await import(
        "./knowledge-base-api"
      );
      const { requireExpressAuth } = await import("./_core/express-auth");
      const dashboard = express();
      dashboard.use(express.json());
      dashboard.use(
        "/api/knowledge-base",
        requireExpressAuth,
        knowledgeBaseRouter,
      );
      dashboardListener = await listen(dashboard);

      const failedObservationResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/progress/${encodeURIComponent(PUBLIC_CONVERSATION_ID)}`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(failedObservationResponse.status).toBe(200);
      expect((await failedObservationResponse.json()) as any).toMatchObject({
        observation: {
          authoritativeTaskId: taskId,
          activeTurn: { id: turnId, status: "failed" },
          notice: {
            code: "FINAL_PACKAGE_MISSING",
            retryable: true,
            turnId,
          },
          interaction: {
            interactionState: "failed",
            progress: {
              build: {
                status: "protocol_error",
                revision: priorRevision,
                currentLeafId: `1.${finalRevision}`,
              },
              summary: {
                total: finalRevision,
                handled: priorRevision,
                confirmed: priorRevision,
                current: 1,
                overallPercent: 98,
              },
            },
          },
          package: null,
        },
      });

      const reconcile = () =>
        fetch(
          `${dashboardListener!.baseUrl}/api/knowledge-base/progress/reconcile`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-auth": "user",
            },
            body: JSON.stringify({
              conversationId: PUBLIC_CONVERSATION_ID,
              taskId,
            }),
          },
        );
      const recoveredResponse = await reconcile();
      expect(recoveredResponse.status).toBe(200);
      const recovered = (await recoveredResponse.json()) as any;
      expect(recovered.observation).toMatchObject({
        authoritativeTaskId: taskId,
        activeTurn: null,
        approvedPresentation: null,
        notice: null,
        interaction: {
          interactionState: "ready_to_publish",
          canReply: false,
          canPublish: true,
          progress: {
            build: {
              status: "ready_to_publish",
              revision: finalRevision,
              currentLeafId: null,
            },
            summary: {
              total: finalRevision,
              handled: finalRevision,
              confirmed: finalRevision,
              current: 0,
              overallPercent: 100,
            },
            packageAllowed: true,
          },
        },
        package: {
          revision: finalRevision,
          fileId: "file-late-final-package",
          sha256: archiveSha256,
          sizeBytes: sealedArchive.buffer.length,
        },
      });
      expect(taskReads).toBe(1);
      expect(packageDownloads).toBe(1);
      expect(state.turns).toHaveLength(1);
      expect(state.turns[0]).toMatchObject({
        id: turnId,
        operationKey,
        status: "completed",
        upstreamTaskId: taskId,
        errorCode: null,
        errorMessage: null,
        completedAt: expect.any(Date),
      });
      expect(
        state.turns[0]!.metadata?.recovery?.protocolFailureObservation,
      ).toBeUndefined();
      expect(state.builds[0]).toMatchObject({
        status: "ready_to_publish",
        stateEpoch: 13,
        revision: finalRevision,
        currentLeafId: null,
        totalNodeCount: finalRevision,
        confirmedCount: finalRevision,
        activeTurnId: null,
        upstreamTaskId: taskId,
        lastAppliedOperationKey: operationKey,
        packageRevision: finalRevision,
        packageTaskId: taskId,
        packageOutputItemId: expect.any(String),
        packageFileId: "file-late-final-package",
        packageDescriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageStorageKey: expect.any(String),
        packageArchiveSha256: archiveSha256,
        packageSizeBytes: sealedArchive.buffer.length,
        protocolError: null,
        protocolErrorCode: null,
      });
      expect(state.nodes.every((node) => node.status === "confirmed")).toBe(
        true,
      );
      expect(state.conversations[0]).toMatchObject({
        status: "completed",
        upstreamTaskId: taskId,
        previousResponseId: taskId,
      });
      await expect(
        artifactStore.readKnowledgeBuildArtifact({
          userId: USER_ID,
          buildId,
          generation: 1,
          kind: "package",
          storageKey: state.builds[0]!.packageStorageKey,
          expectedSha256: archiveSha256,
          expectedBytes: sealedArchive.buffer.length,
        }),
      ).resolves.toEqual(sealedArchive.buffer);

      const stableEpoch = state.builds[0]!.stateEpoch;
      const repeatedResponse = await reconcile();
      expect(repeatedResponse.status).toBe(200);
      expect((await repeatedResponse.json()) as any).toMatchObject({
        observation: {
          notice: null,
          interaction: {
            interactionState: "ready_to_publish",
            progress: {
              build: { status: "ready_to_publish", revision: finalRevision },
              summary: { handled: finalRevision, total: finalRevision },
              packageAllowed: true,
            },
          },
          package: { sha256: archiveSha256 },
        },
      });
      expect(state.builds[0]!.stateEpoch).toBe(stableEpoch);
      expect(state.turns).toHaveLength(1);
      expect(taskReads).toBe(1);
      expect(packageDownloads).toBe(1);
    } finally {
      await Promise.all([
        close(dashboardListener?.server),
        close(upstreamListener.server),
      ]);
    }
  }, 60_000);

  it("retries a failed final-package turn through a new provider task and publishes its scoped ZIP", async () => {
    const finalRevision = 45;
    const priorRevision = finalRevision - 1;
    const buildId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sourceTurnId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const oldTaskId = "task-final-package-missing-e2e";
    const newTaskId = "task-final-package-retry-e2e";
    const parentTaskId = "task-confirmed-parent-e2e";
    const skillFileId = "uploaded-skill-retry-e2e";
    const skillContentHash =
      "6aa4588410fd959c4693089238850b8f89a6a1f2a944ba92d841e6f5e849ad9b";
    const now = new Date("2026-08-03T01:00:00.000Z");
    const fixture = await createFinalPackageFixture({
      leafCount: finalRevision,
      buildRevision: finalRevision,
      schemaVersion: 4,
      archiveLeafIdPrefix: "leaf-",
      driftLastPackagedLeaf: true,
    });
    const sealedArchive = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: fixture.archive,
      nodes: fixture.leaves.map((leaf, ordinal) => ({
        leafId: leaf.id,
        title: leaf.title,
        branchId: "products",
        branchTitle: "产品与服务",
        ordinal,
        status: "confirmed",
        contentMarkdown: leaf.contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
      })),
      buildRevision: finalRevision,
    });
    expect(sealedArchive.changed).toBe(true);
    expect(sealedArchive.buffer.equals(fixture.archive)).toBe(false);
    const archiveSha256 = createHash("sha256")
      .update(sealedArchive.buffer)
      .digest("hex");
    const artifactStore = await import("./knowledge-build-artifact-store");
    const persistedLogo = await artifactStore.persistKnowledgeBuildArtifact({
      userId: USER_ID,
      buildId,
      generation: 1,
      kind: "logo",
      buffer: fixture.logo,
      expectedSha256: fixture.logoSha256,
    });
    const {
      createKnowledgeBaseOperationKey,
      createKnowledgeBaseUpstreamIdempotencyKey,
      hashKnowledgeBaseTurnRequest,
      hashKnowledgeBaseUpstreamIdempotencyKey,
    } = await import("./knowledge-base-turn-service");
    const sourceOperationKey = createKnowledgeBaseOperationKey({
      buildId,
      buildGeneration: 1,
      operationType: "confirm",
      expectedRevision: priorRevision,
      expectedLeafId: `1.${finalRevision}`,
    });
    const sourceRecovery = {
      kind: "turn",
      conversationId: PUBLIC_CONVERSATION_ID,
      parentTaskId,
      userMessage: "确认",
      attachments: [] as Array<{ file_id: string; filename: string }>,
      skillVersion: "4",
      skillContentHash,
    };
    const sourceRequestBody = {
      prompt: "original failed final-package prompt",
      agentProfile: "frontmind-pro",
      taskMode: "agent" as const,
      taskId: parentTaskId,
      attachments: [
        {
          file_id: skillFileId,
          filename: "socratic-kb-builder.skill.zip",
        },
      ],
    };

    let providerTaskPosts = 0;
    let providerTaskReads = 0;
    let packageDownloads = 0;
    let retryOperationKey = "";
    let retryTurnId = "";
    let retryTaskOutput: unknown[] = [];
    const upstream = express();
    upstream.use(express.json({ limit: "5mb" }));
    upstream.post("/v1/tasks", (req, res) => {
      providerTaskPosts += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      expect(req.body.taskId).toBe(parentTaskId);
      expect(req.body.taskId).not.toBe(oldTaskId);
      expect(req.body.attachments).toEqual(sourceRequestBody.attachments);
      const prompt = String(req.body.prompt || "");
      retryOperationKey = prompt.match(/"operationId":"([^"]+)"/u)?.[1] || "";
      retryTurnId = prompt.match(/"turnId":"([^"]+)"/u)?.[1] || "";
      expect(retryOperationKey).toBeTruthy();
      expect(retryOperationKey).not.toBe(sourceOperationKey);
      expect(retryTurnId).toBeTruthy();
      expect(retryTurnId).not.toBe(sourceTurnId);
      expect(req.header("idempotency-key")).toBe(
        createKnowledgeBaseUpstreamIdempotencyKey(retryOperationKey),
      );
      retryTaskOutput = [
        {
          id: "assistant-final-package-retry",
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_text",
              text: {
                value: [
                  `1.${finalRevision} 已确认。`,
                  '<!-- FRONTMIND_KB_PROGRESS\n{"revision":45,"node":"1.45","nodeTitle":"知识节点 45","status":"confirmed","action":"final_package","totalLeaves":45,"confirmedLeaves":45,"pendingLeaves":0,"currentLeafOrder":44,"schemaVersion":4,"buildProfile":"dashboard-enterprise-v1","validationResult":"VALID"}\n-->',
                ].join("\n"),
              },
            },
            {
              type: "output_file",
              file_id: "file-final-package-retry",
              file_name: "frontmind-knowledge-base.zip",
              mime_type: "application/zip",
            },
          ],
        },
      ];
      res.json({
        id: newTaskId,
        status: "completed",
        output: retryTaskOutput,
      });
    });
    upstream.get("/v1/tasks/:taskId", (req, res) => {
      providerTaskReads += 1;
      expect(req.params.taskId).toBe(newTaskId);
      res.json({
        id: newTaskId,
        status: "completed",
        output: retryTaskOutput,
      });
    });
    upstream.get("/v1/files/file-final-package-retry/content", (req, res) => {
      packageDownloads += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(fixture.archive.length));
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="frontmind-knowledge-base.zip"',
      );
      res.send(fixture.archive);
    });
    const upstreamListener = await listen(upstream);
    dependencies.upstreamBaseUrl = upstreamListener.baseUrl;

    const state = initialState();
    Object.assign(state.conversations[0]!, {
      status: "failed",
      upstreamTaskId: oldTaskId,
      previousResponseId: oldTaskId,
      version: 1,
      completedAt: now,
      updatedAt: now,
    });
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash,
      status: "protocol_error",
      generation: 1,
      stateEpoch: 11,
      revision: priorRevision,
      currentLeafId: `1.${finalRevision}`,
      totalNodeCount: finalRevision,
      confirmedCount: priorRevision,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: sourceTurnId,
      upstreamTaskId: oldTaskId,
      lastAppliedOperationKey: null,
      currentPresentationKey: "presentation-retry-current-final-leaf",
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "确认",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: null,
      packageRevision: null,
      packageTaskId: null,
      packageOutputItemId: null,
      packageFileId: null,
      packageFilename: null,
      packageDescriptorHash: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      logoStorageKey: persistedLogo.storageKey,
      logoSha256: persistedLogo.sha256,
      logoBytes: persistedLogo.bytes,
      logoFilename: "frontmind-logo.png",
      logoMimeType: "image/png",
      protocolError:
        "上游已确认最后节点，但未返回当前操作唯一的最终知识库 ZIP；本轮未提交，仍停留在最后节点",
      protocolErrorCode: "FINAL_PACKAGE_MISSING",
      publishedSnapshotId: null,
      completedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    state.nodes.push(
      ...fixture.leaves.map((leaf, ordinal) => ({
        id: `11111111-1111-4111-8111-${String(ordinal + 1).padStart(12, "0")}`,
        buildId,
        leafId: leaf.id,
        branchId: "products",
        branchTitle: "产品与服务",
        title: leaf.title,
        ordinal,
        status: ordinal < priorRevision ? "confirmed" : "current",
        transitionReason:
          ordinal < priorRevision ? "已在先前轮次确认" : "当前最后节点",
        contentMarkdown: leaf.contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
        lastUserInput: null,
        sourceUrls: [],
        imageUrls: [],
        lastTaskId: null,
        sourceTurnId: null,
        presentationKey:
          ordinal === priorRevision
            ? "presentation-retry-current-final-leaf"
            : `presentation-retry-approved-${ordinal + 1}`,
        lastResponseAt: now,
        confirmedAt: ordinal < priorRevision ? now : null,
        createdAt: now,
        updatedAt: now,
      })),
    );
    state.turns.push({
      id: sourceTurnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId: "request-original-final-package-e2e",
      buildId,
      buildGeneration: 1,
      operationKey: sourceOperationKey,
      operationType: "confirm",
      expectedRevision: priorRevision,
      expectedLeafId: `1.${finalRevision}`,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "confirm",
        generation: 1,
        revision: priorRevision,
        leafId: `1.${finalRevision}`,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        payload: {
          userMessage: sourceRecovery.userMessage,
          attachments: sourceRecovery.attachments,
          skillVersion: sourceRecovery.skillVersion,
          skillContentHash: sourceRecovery.skillContentHash,
        },
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(sourceOperationKey),
      ),
      attachmentFileIds: [skillFileId],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        recovery: sourceRecovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: upstreamListener.baseUrl,
          requestBody: sourceRequestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(sourceRequestBody),
          preparedAt: now.toISOString(),
        },
      },
      leaseExpiresAt: null,
      status: "failed",
      upstreamTaskId: oldTaskId,
      errorCode: "FINAL_PACKAGE_MISSING",
      errorMessage: "上游已确认最后节点，但未返回最终 ZIP",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    dependencies.getDb.mockResolvedValue(
      memoryDatabase(state, { cloneSelectedRows: true }),
    );

    let dashboardListener: Awaited<ReturnType<typeof listen>> | undefined;
    try {
      const { default: knowledgeBaseRouter } = await import(
        "./knowledge-base-api"
      );
      const { requireExpressAuth } = await import("./_core/express-auth");
      const dashboard = express();
      dashboard.use(express.json());
      dashboard.use(
        "/api/knowledge-base",
        requireExpressAuth,
        knowledgeBaseRouter,
      );
      dashboardListener = await listen(dashboard);

      const failedResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/progress/${encodeURIComponent(PUBLIC_CONVERSATION_ID)}`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(failedResponse.status).toBe(200);
      expect((await failedResponse.json()) as any).toMatchObject({
        observation: {
          authoritativeTaskId: oldTaskId,
          activeTurn: { id: sourceTurnId, status: "failed" },
          notice: {
            code: "FINAL_PACKAGE_MISSING",
            retryable: true,
            turnId: sourceTurnId,
          },
          interaction: {
            interactionState: "failed",
            progress: {
              build: {
                status: "protocol_error",
                revision: priorRevision,
                currentLeafId: `1.${finalRevision}`,
              },
              summary: {
                total: finalRevision,
                handled: priorRevision,
                current: 1,
                overallPercent: 98,
              },
            },
          },
          package: null,
        },
      });

      const retryResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/retry`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({
            conversationId: PUBLIC_CONVERSATION_ID,
            clientRequestId: "request-retry-final-package-e2e",
            expectedGeneration: 1,
            expectedRevision: priorRevision,
            expectedLeafId: `1.${finalRevision}`,
          }),
        },
      );
      const retried = (await retryResponse.json()) as any;
      expect({ status: retryResponse.status, retried }).toMatchObject({
        status: 200,
      });
      expect(retried).toMatchObject({
        task: { id: newTaskId },
        retried: true,
        observation: {
          authoritativeTaskId: newTaskId,
          activeTurn: null,
          approvedPresentation: null,
          notice: null,
          interaction: {
            interactionState: "ready_to_publish",
            canReply: false,
            canPublish: true,
            progress: {
              build: {
                status: "ready_to_publish",
                revision: finalRevision,
                currentLeafId: null,
              },
              summary: {
                total: finalRevision,
                handled: finalRevision,
                confirmed: finalRevision,
                current: 0,
                overallPercent: 100,
              },
              packageAllowed: true,
            },
          },
          package: {
            revision: finalRevision,
            fileId: "file-final-package-retry",
            sha256: archiveSha256,
            sizeBytes: sealedArchive.buffer.length,
          },
        },
      });
      expect(providerTaskPosts).toBe(1);
      expect(providerTaskReads).toBe(0);
      expect(packageDownloads).toBe(1);
      expect(retryOperationKey).toBeTruthy();
      expect(retryTurnId).toBeTruthy();

      expect(state.turns).toHaveLength(2);
      expect(
        state.turns.find((turn) => turn.id === sourceTurnId),
      ).toMatchObject({
        status: "failed",
        upstreamTaskId: oldTaskId,
        errorCode: "FINAL_PACKAGE_MISSING",
      });
      const retryTurn = state.turns.find((turn) => turn.id === retryTurnId);
      expect(retryTurn).toMatchObject({
        id: retryTurnId,
        operationKey: retryOperationKey,
        operationType: "retry",
        expectedRevision: priorRevision,
        expectedLeafId: `1.${finalRevision}`,
        status: "completed",
        upstreamTaskId: newTaskId,
        attachmentFileIds: [skillFileId],
        errorCode: null,
        metadata: expect.objectContaining({
          attachmentsFrozen: true,
          recovery: expect.objectContaining({
            retryOfTurnId: sourceTurnId,
            retryParentTaskId: parentTaskId,
          }),
        }),
      });
      expect(state.builds[0]).toMatchObject({
        status: "ready_to_publish",
        revision: finalRevision,
        currentLeafId: null,
        totalNodeCount: finalRevision,
        confirmedCount: finalRevision,
        activeTurnId: null,
        upstreamTaskId: newTaskId,
        lastAppliedOperationKey: retryOperationKey,
        packageRevision: finalRevision,
        packageTaskId: newTaskId,
        packageOutputItemId: expect.any(String),
        packageFileId: "file-final-package-retry",
        packageDescriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageStorageKey: expect.any(String),
        packageArchiveSha256: archiveSha256,
        packageSizeBytes: sealedArchive.buffer.length,
        protocolError: null,
        protocolErrorCode: null,
      });
      expect(state.builds[0]!.stateEpoch).toBeGreaterThan(11);
      expect(state.nodes.every((node) => node.status === "confirmed")).toBe(
        true,
      );
      expect(state.conversations[0]).toMatchObject({
        status: "completed",
        upstreamTaskId: newTaskId,
        previousResponseId: newTaskId,
      });
      await expect(
        artifactStore.readKnowledgeBuildArtifact({
          userId: USER_ID,
          buildId,
          generation: 1,
          kind: "package",
          storageKey: state.builds[0]!.packageStorageKey,
          expectedSha256: archiveSha256,
          expectedBytes: sealedArchive.buffer.length,
        }),
      ).resolves.toEqual(sealedArchive.buffer);

      const stableEpoch = state.builds[0]!.stateEpoch;
      const repeatedReconcile = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({
            conversationId: PUBLIC_CONVERSATION_ID,
            taskId: newTaskId,
          }),
        },
      );
      expect(repeatedReconcile.status).toBe(200);
      expect((await repeatedReconcile.json()) as any).toMatchObject({
        observation: {
          notice: null,
          interaction: {
            interactionState: "ready_to_publish",
            progress: {
              build: { status: "ready_to_publish", revision: finalRevision },
              packageAllowed: true,
            },
          },
          package: { sha256: archiveSha256 },
        },
      });
      expect(state.builds[0]!.stateEpoch).toBe(stableEpoch);
      expect(state.turns).toHaveLength(2);
      expect(providerTaskPosts).toBe(1);
      expect(providerTaskReads).toBe(0);
      expect(packageDownloads).toBe(1);
    } finally {
      await Promise.all([
        close(dashboardListener?.server),
        close(upstreamListener.server),
      ]);
    }
  }, 60_000);

  it("rejects a settled acknowledgement before first-Logo binding and unlocks an immediate retry", async () => {
    const state = initialState();
    const buildId = "77777777-7777-4777-8777-777777777777";
    const turnId = "88888888-8888-4888-8888-888888888888";
    const taskId = "task-acknowledgement-only";
    const now = new Date("2026-08-02T14:15:32.000Z");
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "d".repeat(64),
      status: "researching",
      generation: 1,
      stateEpoch: 2,
      revision: 0,
      currentLeafId: null,
      totalNodeCount: 0,
      confirmedCount: 0,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: turnId,
      upstreamTaskId: taskId,
      lastAppliedOperationKey: null,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      awaitingResponseSince: now,
      protocolError: null,
      protocolErrorCode: null,
      createdAt: now,
      updatedAt: now,
    });
    state.turns.push({
      id: turnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId: "request-acknowledgement-only",
      buildId,
      buildGeneration: 1,
      operationKey: "operation-acknowledgement-only",
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: "e".repeat(64),
      upstreamIdempotencyKeyHash: "f".repeat(64),
      attachmentFileIds: [],
      metadata: { recovery: {} },
      leaseExpiresAt: new Date("2026-08-02T14:20:32.000Z"),
      status: "running",
      upstreamTaskId: taskId,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    dependencies.getDb.mockResolvedValue(memoryDatabase(state));
    dependencies.getCredentialForUpstreamResource.mockResolvedValue({
      id: "credential-e2e",
      apiKey: "sk-e2e-only",
    });

    const getTask = vi.spyOn(axios, "get").mockResolvedValueOnce({
      status: 200,
      data: {
        id: taskId,
        status: "completed",
        output: [
          {
            id: "assistant-acknowledgement",
            role: "assistant",
            type: "message",
            content: "已收到。",
          },
        ],
      },
    } as any);
    const { default: knowledgeBaseRouter } = await import(
      "./knowledge-base-api"
    );
    const { requireExpressAuth } = await import("./_core/express-auth");
    const dashboard = express();
    dashboard.use(express.json());
    dashboard.use(
      "/api/knowledge-base",
      requireExpressAuth,
      knowledgeBaseRouter,
    );
    const listener = await listen(dashboard);
    try {
      const response = await fetch(
        `${listener.baseUrl}/api/knowledge-base/progress/reconcile`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
        },
      );
      expect(response.status).toBe(200);
      expect((await response.json()) as any).toMatchObject({
        observation: {
          interaction: {
            interactionState: "failed",
            progress: {
              build: {
                status: "protocol_error",
              },
            },
          },
          notice: {
            code: "UPSTREAM_ACKNOWLEDGEMENT_ONLY",
            retryable: true,
            message:
              "上游智能体仅返回了确认回执，未生成知识库正文；本轮未写入，现可安全重试",
          },
        },
      });
      expect(getTask).toHaveBeenCalledTimes(1);
      expect(state.builds[0]).toMatchObject({
        status: "protocol_error",
        stateEpoch: 3,
        activeTurnId: turnId,
        protocolErrorCode: "UPSTREAM_ACKNOWLEDGEMENT_ONLY",
        awaitingResponseSince: null,
        lastOutputLength: 0,
      });
      expect(state.turns[0]).toMatchObject({
        status: "failed",
        upstreamTaskId: taskId,
        errorCode: "UPSTREAM_ACKNOWLEDGEMENT_ONLY",
        leaseExpiresAt: null,
      });
    } finally {
      getTask.mockRestore();
      await close(listener.server);
    }
  });

  it("returns the durable third settled failure only for the exact active task", async () => {
    const state = initialState();
    const buildId = "44444444-4444-4444-8444-444444444444";
    const turnId = "55555555-5555-4555-8555-555555555555";
    const taskId = "task-active-failure";
    const approvedBody = "## 1.1 一句话定位\n\n最后正确正文。";
    const now = new Date("2026-08-01T00:00:00.000Z");
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      status: "confirming",
      generation: 1,
      stateEpoch: 4,
      revision: 0,
      currentLeafId: "1.1",
      activeTurnId: turnId,
      upstreamTaskId: taskId,
      lastAppliedOperationKey: null,
      protocolError: null,
      protocolErrorCode: null,
      awaitingResponseSince: now,
      createdAt: now,
      updatedAt: now,
    });
    state.nodes.push({
      id: "66666666-6666-4666-8666-666666666666",
      buildId,
      leafId: "1.1",
      branchId: "identity",
      branchTitle: "企业身份",
      title: "一句话定位",
      ordinal: 0,
      status: "current",
      contentMarkdown: approvedBody,
      contentSha256: knowledgeBaseMarkdownSha256(approvedBody),
      sourceTurnId: null,
      presentationKey: "presentation-current",
      createdAt: now,
      updatedAt: now,
    });
    state.turns.push({
      id: turnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId: "request-active-failure",
      buildId,
      buildGeneration: 1,
      operationKey: "operation-active-failure",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      requestHash: "b".repeat(64),
      upstreamIdempotencyKeyHash: "c".repeat(64),
      attachmentFileIds: [],
      metadata: { recovery: {} },
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      status: "running",
      upstreamTaskId: taskId,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    dependencies.getDb.mockResolvedValue(memoryDatabase(state));
    const {
      observeKnowledgeBaseProtocolFailure,
      reconcileKnowledgeBaseProgress,
    } = await import("./knowledge-base-progress-service");
    const observe = (second: number, observedTaskId = taskId) =>
      observeKnowledgeBaseProtocolFailure({
        userId: USER_ID,
        conversationId: PUBLIC_CONVERSATION_ID,
        taskId: observedTaskId,
        observationKey: "same-active-failure",
        code: "UPSTREAM_TASK_READ_FAILED",
        message: "读取知识库任务结果持续失败",
        observedAt: new Date(
          `2026-08-01T00:00:${String(second).padStart(2, "0")}.000Z`,
        ),
      });

    state.builds[0]!.activeTurnId = null;
    state.builds[0]!.lastAppliedOperationKey = "operation-active-failure";
    state.turns[0]!.status = "completed";
    state.turns[0]!.completedAt = now;
    for (const second of [0, 5, 10]) {
      await expect(observe(second)).resolves.toBe(false);
    }
    expect(state.builds[0]).toMatchObject({
      status: "confirming",
      stateEpoch: 4,
      activeTurnId: null,
      protocolError: null,
    });
    expect(state.nodes[0]!.contentMarkdown).toBe(approvedBody);

    state.builds[0]!.activeTurnId = turnId;
    state.builds[0]!.lastAppliedOperationKey = null;
    state.turns[0]!.status = "running";
    state.turns[0]!.completedAt = null;
    await expect(observe(0, "stale-task")).resolves.toBe(false);
    vi.useFakeTimers();
    try {
      for (const second of [0, 5, 10]) {
        vi.setSystemTime(
          new Date(`2026-08-01T00:00:${String(second).padStart(2, "0")}.000Z`),
        );
        const progress = await reconcileKnowledgeBaseProgress({
          userId: USER_ID,
          conversationId: PUBLIC_CONVERSATION_ID,
          taskId,
          output: [
            {
              role: "assistant",
              content: [
                { type: "output_text", text: "stable invalid terminal output" },
              ],
            },
          ],
          upstreamStatus: "completed",
        });
        expect(progress.build.status).toBe(
          second === 10 ? "protocol_error" : "confirming",
        );
      }
    } finally {
      vi.useRealTimers();
    }
    expect(state.builds[0]).toMatchObject({
      status: "protocol_error",
      stateEpoch: 5,
      activeTurnId: turnId,
      protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
    });
    expect(state.nodes[0]!.contentMarkdown).toBe(approvedBody);
    expect(state.turns[0]).toMatchObject({
      status: "failed",
      upstreamTaskId: taskId,
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      leaseExpiresAt: null,
    });
  });
});
