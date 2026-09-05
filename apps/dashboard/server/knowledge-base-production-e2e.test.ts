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
  localAssets,
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
  formatKnowledgeBaseReopenEnvelope,
} from "./knowledge-base-progress";
import {
  createKnowledgeBaseOperationKey,
  createKnowledgeBaseUpstreamIdempotencyKey,
  hashKnowledgeBaseTurnRequest,
  hashKnowledgeBaseUpstreamIdempotencyKey,
  inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority,
  inspectKnowledgeBaseRetryAuthority,
} from "./knowledge-base-turn-service";
import {
  KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
  KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
} from "./knowledge-base-tree-policy-rollout";

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
  localAssets: Record<string, any>[];
};

function rowsFor(table: unknown, state: MemoryState) {
  if (table === apiCredentials) return state.credentials;
  if (table === users) return state.users;
  if (table === userDashboardContents) return state.dashboardContents;
  if (table === knowledgeBaseBuilds) {
    for (const build of state.builds) {
      if (!Object.prototype.hasOwnProperty.call(build, "treePolicyVersion")) {
        build.treePolicyVersion = 1;
      }
      if (
        !Object.prototype.hasOwnProperty.call(build, "initialResearchCoverage")
      ) {
        build.initialResearchCoverage = null;
      }
    }
    return state.builds;
  }
  if (table === knowledgeBaseBuildNodes) return state.nodes;
  if (table === conversationTurns) return state.turns;
  if (table === conversations) return state.conversations;
  if (table === messages) return state.messages;
  if (table === knowledgeBaseSnapshots) return state.snapshots;
  if (table === upstreamResources) return state.resources;
  if (table === localAssets) return state.localAssets;
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
  options: {
    cloneSelectedRows?: boolean;
    transactional?: boolean;
    failUpdate?: (
      table: unknown,
      values: Record<string, unknown>,
    ) => Error | undefined;
  } = {},
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
          treePolicyVersion: 1,
          initialResearchCoverage: null,
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
              const failure = options.failUpdate?.(table, values);
              if (failure) throw failure;
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
      if (!options.transactional) return operation(db);
      const snapshot = structuredClone(state);
      try {
        return await operation(db);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
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

function completeResearchCoverage(leafIds: string[]) {
  const dimensionIds = [
    "enterprise_identity",
    "team_and_organization",
    "products_and_services",
    "capabilities_and_delivery",
    "industries_scenarios_and_cases",
    "differentiation_and_evidence",
    "cooperation_delivery_and_support",
  ] as const;
  return {
    officialPages: {
      discovered: 12,
      attempted: 12,
      succeeded: 12,
      failed: 0,
    },
    publicQueries: 6,
    officialDocuments: 0,
    uploadsRead: 0,
    sourceCount: 12,
    productFamilies: [
      {
        id: "frontmind-enterprise-ai",
        name: "FrontMind 企业智能产品族",
        leafIds,
      },
    ],
    dimensions: dimensionIds.map((id, index) => ({
      id,
      status: "gap" as const,
      leafIds: [leafIds[index]!],
    })),
    stopReason: "coverage_complete" as const,
  };
}

async function createFinalPackageFixture(
  input: {
    leafCount?: number;
    buildRevision?: number;
    schemaVersion?: 3 | 4;
    archiveLeafIdPrefix?: string;
    driftLastPackagedLeaf?: boolean;
    officialLogoSourcePageUrl?: string;
    officialLogoSourceAssetUrl?: string;
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
    sourcePageUrl:
      input.officialLogoSourcePageUrl || "https://www.frontmind.net/",
    sourceAssetUrl:
      input.officialLogoSourceAssetUrl ||
      "https://www.frontmind.net/frontmind-logo.png",
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
    localAssets: [],
  } satisfies MemoryState;
}

function completedOfficialLogoProvenanceTurn(input: {
  id: string;
  buildId: string;
  generation: number;
  now: Date;
}) {
  return {
    id: input.id,
    conversationId: STORED_CONVERSATION_ID,
    userId: USER_ID,
    apiCredentialId: "credential-e2e",
    clientRequestId: `request-${input.id}`,
    buildId: input.buildId,
    buildGeneration: input.generation,
    operationKey: `operation-${input.id}`,
    operationType: "start",
    expectedRevision: 0,
    expectedLeafId: null,
    requestHash: "8".repeat(64),
    upstreamIdempotencyKeyHash: "9".repeat(64),
    attachmentFileIds: [],
    metadata: {
      boundOfficialLogoProvenance: {
        sourceKind: "official_web",
        sourcePageUrl: "https://www.frontmind.net/",
        sourceAssetUrl: "https://www.frontmind.net/frontmind-logo.png",
      },
    },
    leaseExpiresAt: null,
    status: "completed",
    upstreamTaskId: `task-${input.id}`,
    errorCode: null,
    errorMessage: null,
    startedAt: input.now,
    completedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
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

  it("binds optional materialized v5 Logos locally with atomic CAS and no Working Set mutation", async () => {
    const state = initialState();
    const buildId = "31313131-3131-4313-8313-313131313131";
    const leafIds = Array.from({ length: 30 }, (_, index) => `1.${index + 1}`);
    const now = new Date("2026-08-16T04:28:00.000Z");
    const content = "# 企业身份与定位\n\n这是客户可见的企业身份正文。";
    const presentationKey = "presentation-materialized-logo-0";
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      executionMode: "materialized_bundle_v1",
      providerProtocol: "manus_v2",
      skillName: "socratic-kb-builder",
      skillVersion: "5",
      skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
      treePolicyVersion: 2,
      generation: 1,
      stateEpoch: 4,
      revision: 0,
      status: "confirming",
      activeTurnId: null,
      activeWorkingSetId: "working-set-immutable",
      contentVersion: 1,
      currentLeafId: leafIds[0],
      currentPresentationKey: presentationKey,
      totalNodeCount: leafIds.length,
      confirmedCount: 0,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      initialResearchCoverage: completeResearchCoverage(leafIds),
      handoffProvenance: {
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        materializedQuality: {
          completeness: "complete",
          stats: {
            acceptedCount: leafIds.length,
            expectedCount: 30,
            droppedCount: 0,
          },
          warnings: [],
          downstreamEligible: true,
          publishable: true,
        },
      },
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
      createdAt: now,
      updatedAt: now,
    });
    state.nodes.push({
      id: "node-materialized-logo",
      buildId,
      leafId: leafIds[0],
      branchId: "identity",
      branchTitle: "企业身份",
      title: "企业身份与定位",
      ordinal: 0,
      status: "current",
      transitionReason: "materialized_initial_current",
      contentMarkdown: content,
      contentSha256: knowledgeBaseMarkdownSha256(content),
      contentVersion: 1,
      sourceUrls: [],
      imageUrls: [],
      assetRefs: [],
      lastTaskId: null,
      sourceTurnId: "turn-materialized-initial",
      presentationKey,
      lastResponseAt: now,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const database = memoryDatabase(state, { transactional: true });
    const transaction = database.transaction.bind(database);
    let transactionQueue = Promise.resolve();
    database.transaction = <T>(operation: (tx: any) => Promise<T>) => {
      const result = transactionQueue.then(() => transaction(operation));
      transactionQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    dependencies.getDb.mockResolvedValue(database);
    const { bindMaterializedKnowledgeBaseOfficialLogoLocally } = await import(
      "./knowledge-base-materialized-service"
    );
    const png = async (color: string) =>
      sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: color,
        },
      })
        .png()
        .toBuffer();
    const uploadInput = async (input: {
      clientRequestId: string;
      bytes: Buffer;
      expectedRevision?: number;
      expectedPresentationKey?: string;
    }) => {
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      return bindMaterializedKnowledgeBaseOfficialLogoLocally({
        userId: USER_ID,
        conversationId: PUBLIC_CONVERSATION_ID,
        buildId,
        clientRequestId: input.clientRequestId,
        expectedGeneration: 1,
        expectedRevision:
          input.expectedRevision ?? Number(state.builds[0]!.revision),
        expectedLeafId: leafIds[0]!,
        expectedPresentationKey:
          input.expectedPresentationKey ??
          String(state.builds[0]!.currentPresentationKey),
        upload: {
          fileId: `file-${input.clientRequestId}`,
          filename: "brand.png",
          mimeType: "image/png",
          sizeBytes: input.bytes.length,
          sourceSha256: digest,
        },
        bytes: input.bytes,
        boundAt: now,
      });
    };

    const firstBytes = await png("#173c36");
    const firstInput = {
      clientRequestId: "logo-first",
      bytes: firstBytes,
      expectedRevision: 0,
      expectedPresentationKey: presentationKey,
    };
    const first = await uploadInput(firstInput);
    expect(first).toMatchObject({
      execution: "local",
      disposition: "logo_bound",
      revision: 1,
      stateEpoch: 5,
      contentVersion: 1,
      workingSetId: "working-set-immutable",
    });
    expect(state.builds[0]).toMatchObject({
      activeWorkingSetId: "working-set-immutable",
      contentVersion: 1,
      revision: 1,
      stateEpoch: 5,
      logoSha256: createHash("sha256").update(firstBytes).digest("hex"),
    });
    expect(state.turns.at(-1)).toMatchObject({
      operationType: "local_logo",
      apiCredentialId: null,
      upstreamTaskId: null,
      status: "completed",
      metadata: {
        execution: "local",
        providerRequestCount: 0,
        disposition: "logo_bound",
        contentVersion: 1,
      },
    });

    const replay = await uploadInput(firstInput);
    expect(replay).toMatchObject({
      disposition: "idempotent",
      revision: 1,
      stateEpoch: 5,
      contentVersion: 1,
      workingSetId: "working-set-immutable",
    });
    expect(state.builds[0]).toMatchObject({ revision: 1, stateEpoch: 5 });

    const same = await uploadInput({
      clientRequestId: "logo-same-bytes",
      bytes: firstBytes,
    });
    expect(same).toMatchObject({
      disposition: "logo_unchanged",
      revision: 1,
      stateEpoch: 5,
      contentVersion: 1,
    });
    expect(state.builds[0]).toMatchObject({ revision: 1, stateEpoch: 5 });
    const firstStorageKey = state.builds[0]!.logoStorageKey;

    const replacementBytes = await png("#8b5cf6");
    const replacement = await uploadInput({
      clientRequestId: "logo-replacement",
      bytes: replacementBytes,
    });
    expect(replacement).toMatchObject({
      disposition: "logo_bound",
      revision: 2,
      contentVersion: 1,
    });
    expect(state.builds[0]!.logoStorageKey).not.toBe(firstStorageKey);

    const concurrentRevision = state.builds[0]!.revision;
    const concurrentPresentationKey = state.builds[0]!.currentPresentationKey;
    const concurrent = await Promise.allSettled([
      uploadInput({
        clientRequestId: "logo-concurrent-a",
        bytes: await png("#be123c"),
        expectedRevision: concurrentRevision,
        expectedPresentationKey: concurrentPresentationKey,
      }),
      uploadInput({
        clientRequestId: "logo-concurrent-b",
        bytes: await png("#0369a1"),
        expectedRevision: concurrentRevision,
        expectedPresentationKey: concurrentPresentationKey,
      }),
    ]);
    expect(
      concurrent.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((entry) => entry.status === "rejected"),
    ).toHaveLength(1);
    expect(state.builds[0]).toMatchObject({
      activeWorkingSetId: "working-set-immutable",
      contentVersion: 1,
      revision: 3,
      stateEpoch: 7,
    });

    const apiLogoBytes = await png("#15803d");
    const apiLogoSha256 = createHash("sha256")
      .update(apiLogoBytes)
      .digest("hex");
    const apiLogoFileId = "managed-materialized-local-logo";
    const apiLogoStorageKey = `frontmind-v2:${apiLogoFileId}`;
    const apiLogoRetainUntil = new Date("2099-01-01T00:00:00.000Z");
    const { Readable } = await import("node:stream");
    const presalesStore = await import("./presales-file-store");
    await presalesStore.recordPresalesFileDescriptor({
      fileId: apiLogoFileId,
      filename: "api-brand.png",
      mimeType: "image/png",
      sizeBytes: apiLogoBytes.length,
    });
    const stagedApiLogo = await presalesStore.stagePresalesFileContent({
      fileId: apiLogoFileId,
      stream: Readable.from([apiLogoBytes]),
      maxBytes: 1024 * 1024,
    });
    await stagedApiLogo.commit({
      filename: "api-brand.png",
      mimeType: "image/png",
      uploadedAt: now,
      contentExpiresAt: apiLogoRetainUntil,
    });
    state.localAssets.push({
      id: apiLogoFileId,
      scope: "managed_user",
      accountUserId: USER_ID,
      presalesProjectId: null,
      filename: "api-brand.png",
      mimeType: "image/png",
      sizeBytes: apiLogoBytes.length,
      contentSha256: apiLogoSha256,
      storageKey: apiLogoStorageKey,
      storageKeyHash: createHash("sha256")
        .update(apiLogoStorageKey)
        .digest("hex"),
      refCount: 1,
      retainUntil: apiLogoRetainUntil,
      createdAt: now,
    });
    let providerRequestCount = 0;
    const provider = express();
    provider.use((_req, res) => {
      providerRequestCount += 1;
      res.status(500).json({ error: "provider must not be called" });
    });
    const providerListener = await listen(provider);
    dependencies.upstreamBaseUrl = providerListener.baseUrl;
    const credentialReadsBefore =
      dependencies.getDecryptedCredentialForKnowledgeBaseReservation.mock.calls
        .length;
    const knowledgeBaseApi = await import("./knowledge-base-api");
    const knowledgeBaseRouter = knowledgeBaseApi.default;
    const { requireExpressAuth } = await import("./_core/express-auth");
    const dashboard = express();
    dashboard.use(express.json());
    dashboard.use(
      "/api/knowledge-base",
      requireExpressAuth,
      knowledgeBaseRouter,
    );
    const dashboardListener = await listen(dashboard);
    try {
      const apiResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/turn`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({
            conversationId: PUBLIC_CONVERSATION_ID,
            clientRequestId: "logo-api-local",
            userMessage: "",
            submissionKind: "logo",
            attachments: [
              {
                file_id: apiLogoFileId,
                filename: "api-brand.png",
              },
            ],
            expectedGeneration: 1,
            expectedRevision: state.builds[0]!.revision,
            expectedLeafId: leafIds[0],
            expectedPresentationKey: state.builds[0]!.currentPresentationKey,
          }),
        },
      );
      const apiBody = await apiResponse.json();
      expect(apiResponse.status, JSON.stringify(apiBody)).toBe(200);
      expect(apiBody).toMatchObject({
        accepted: true,
        execution: "local",
        disposition: "logo_bound",
        contentVersion: 1,
        workingSetId: "working-set-immutable",
      });
      expect(providerRequestCount).toBe(0);
      expect(
        dependencies.getDecryptedCredentialForKnowledgeBaseReservation.mock
          .calls.length,
      ).toBe(credentialReadsBefore);
      expect(state.turns.at(-1)).toMatchObject({
        operationType: "local_logo",
        apiCredentialId: null,
        upstreamTaskId: null,
        metadata: { providerRequestCount: 0 },
      });
      expect(state.builds[0]).toMatchObject({
        activeWorkingSetId: "working-set-immutable",
        contentVersion: 1,
        revision: 4,
        stateEpoch: 8,
      });
    } finally {
      await Promise.all([
        close(dashboardListener.server),
        close(providerListener.server),
      ]);
      await presalesStore.removeStoredPresalesFile(apiLogoFileId);
    }

    const beforeBadImage = {
      revision: state.builds[0]!.revision,
      stateEpoch: state.builds[0]!.stateEpoch,
      logoSha256: state.builds[0]!.logoSha256,
    };
    await expect(
      uploadInput({
        clientRequestId: "logo-bad-image",
        bytes: Buffer.from("not-an-image", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(state.builds[0]).toMatchObject(beforeBadImage);
    expect(state.builds[0]).toMatchObject({
      activeWorkingSetId: "working-set-immutable",
      contentVersion: 1,
    });

    const currentLogoStorageKey = state.builds[0]!.logoStorageKey;
    if (currentLogoStorageKey) {
      const artifactStore = await import("./knowledge-build-artifact-store");
      await artifactStore.removeKnowledgeBuildArtifact({
        userId: USER_ID,
        buildId,
        generation: 1,
        kind: "logo",
        storageKey: currentLogoStorageKey,
      });
    }
  });

  it.skip("retires production canonical-create rejection recovery", async () => {
    const state = initialState();
    const buildId = "19191919-1919-4191-8191-191919191919";
    const turnId = "20202020-2020-4202-8202-202020202020";
    const now = new Date("2026-08-14T07:52:00.000Z");
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      providerProtocol: "manus_v2",
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      canonicalCredentialId: null,
      canonicalTaskState: "creating",
      canonicalTaskUrl: null,
      canonicalTaskCreatedAt: null,
      handoffProvenance: null,
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "7".repeat(64),
      skillArchiveSha256: "8".repeat(64),
      skillArchiveBytes: 128,
      skillArchiveStorageKey: "skills/frontmind.zip",
      treePolicyVersion: 2,
      initialResearchCoverage: null,
      status: "confirming",
      generation: 1,
      stateEpoch: 96,
      revision: 0,
      currentLeafId: null,
      totalNodeCount: 0,
      confirmedCount: 0,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: turnId,
      upstreamTaskId: null,
      lastAppliedOperationKey: null,
      currentPresentationKey: null,
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "开始构建企业知识库",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: now,
      contentCompletedAt: null,
      packageStatus: "not_started",
      packageAttemptCount: 0,
      packageNextRetryAt: null,
      packageLastErrorCode: null,
      packageRevision: null,
      packageTaskId: null,
      packageOutputItemId: null,
      packageFileId: null,
      packageFilename: null,
      packageDescriptorHash: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
      protocolErrorCode: "MANUS_V2_CREATE_REJECTED",
      protocolError: "provider detail must stay private",
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
      clientRequestId: "request-confirming-create-rejected",
      buildId,
      buildGeneration: 1,
      operationKey: "operation-confirming-create-rejected",
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: "a".repeat(64),
      upstreamIdempotencyKeyHash: "b".repeat(64),
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: true,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "rejected",
        createAttemptState: "rejected",
        providerReasonCategory: "invalid_argument",
        providerRejectionStatus: 400,
        operationToken: "operation-confirming-create-rejected",
        expectedAttachmentCount: 0,
        userAttachmentCount: 0,
        recovery: {
          kind: "start",
          conversationId: PUBLIC_CONVERSATION_ID,
          companyName: "FrontMind超前智能",
          attachments: [],
        },
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: {
            prompt: "frozen",
            agentProfile: "frontmind-standard",
            attachments: [],
          },
          bodySha256: "c".repeat(64),
          preparedAt: now.toISOString(),
        },
      },
      leaseExpiresAt: null,
      status: "failed",
      upstreamTaskId: null,
      errorCode: "MANUS_V2_CREATE_REJECTED",
      errorMessage: "provider detail must stay private",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    dependencies.getDb.mockResolvedValue(
      memoryDatabase(state, { transactional: true }),
    );

    let providerRequests = 0;
    const provider = express();
    provider.use((_req, res) => {
      providerRequests += 1;
      res.status(500).json({ error: "provider must not be called" });
    });
    const providerListener = await listen(provider);
    const previousUpstreamBaseUrl = dependencies.upstreamBaseUrl;
    dependencies.upstreamBaseUrl = providerListener.baseUrl;
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
      const reconcile = () =>
        fetch(
          `${dashboardListener!.baseUrl}/api/knowledge-base/progress/reconcile`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-test-auth": "user",
            },
            body: JSON.stringify({ conversationId: PUBLIC_CONVERSATION_ID }),
          },
        );

      const frozenSource = structuredClone(state.turns[0]);
      const firstResponse = await reconcile();
      expect(firstResponse.status).toBe(200);
      const first = (await firstResponse.json()) as any;
      expect(first).toMatchObject({
        observation: {
          stateEpoch: 97,
          syncState: "attention_required",
          activeTurn: null,
          notice: {
            code: "FRONTMIND_KB_RETRY_AVAILABLE",
            recoveryAction: "retry_request",
            recoveryToken: expect.stringMatching(/^[a-f0-9]{64}$/u),
            turnId: null,
          },
          interaction: {
            interactionState: "failed",
            progress: { build: { status: "protocol_error" } },
          },
        },
      });
      expect(state.builds[0]).toMatchObject({
        status: "protocol_error",
        activeTurnId: null,
        canonicalTaskState: "attention_required",
        stateEpoch: 97,
        awaitingResponseSince: null,
        handoffProvenance: {
          recoverySourceTurnId: turnId,
          terminalRecovery: {
            action: "retry_compatible_create",
            recoveryStateSha256: first.observation.notice.recoveryToken,
          },
        },
      });
      expect(state.conversations[0]).toMatchObject({
        status: "failed",
        version: 1,
        completedAt: expect.any(Date),
      });
      expect(state.turns[0]).toStrictEqual(frozenSource);
      expect(first.observation.interaction.interactionState).not.toBe(
        "executing",
      );
      expect(JSON.stringify(first).toLowerCase()).not.toContain("manus");
      expect(JSON.stringify(first)).not.toContain("系统正在恢复当前操作");
      expect(providerRequests).toBe(0);

      const stableBuild = structuredClone(state.builds[0]);
      const stableConversation = structuredClone(state.conversations[0]);
      const stableTurn = structuredClone(state.turns[0]);
      const secondResponse = await reconcile();
      expect(secondResponse.status).toBe(200);
      const second = (await secondResponse.json()) as any;
      expect(second.observation).toMatchObject({
        stateEpoch: 97,
        syncState: "attention_required",
        activeTurn: null,
        notice: {
          recoveryAction: "retry_request",
          recoveryToken: first.observation.notice.recoveryToken,
        },
        interaction: { interactionState: "failed" },
      });
      expect(state.builds[0]).toStrictEqual(stableBuild);
      expect(state.conversations[0]).toStrictEqual(stableConversation);
      expect(state.turns[0]).toStrictEqual(stableTurn);
      expect(state.turns).toHaveLength(1);
      expect(providerRequests).toBe(0);

      const generationTwoTurnId = "21212121-2121-4212-8212-212121212121";
      state.builds[0] = {
        ...state.builds[0]!,
        generation: 2,
        stateEpoch: 38,
        status: "protocol_error",
        activeTurnId: generationTwoTurnId,
        canonicalTaskId: null,
        canonicalTaskGeneration: 2,
        canonicalCredentialId: "credential-e2e",
        canonicalTaskState: "creating",
        handoffProvenance: {
          schemaVersion: 1,
          sourceGeneration: 1,
          targetGeneration: 2,
          credentialMode: "current_rebind",
        },
        awaitingResponseSince: now,
      };
      state.turns[0] = {
        ...state.turns[0]!,
        id: generationTwoTurnId,
        clientRequestId: "request-generation-two-create-rejected",
        buildGeneration: 2,
        operationKey: "operation-generation-two-create-rejected",
        status: "running",
        leaseExpiresAt: new Date("2026-08-14T08:10:00.000Z"),
        completedAt: null,
        metadata: {
          attachmentsFrozen: true,
          providerProtocol: "manus_v2",
          providerMethod: "task.create",
          providerAttemptState: "rejected",
          createAttemptState: "rejected",
          providerReasonCategory: "invalid_argument",
          providerRejectionStatus: 400,
          dispatchState: "recovering",
          failureClass: "recoverable_same_turn",
          recoveryAction: "reconcile",
          canRegenerate: false,
          repairKind: "canonical_credential_rebind",
          operationToken: "operation-generation-two-create-rejected",
          expectedAttachmentCount: 0,
          userAttachmentCount: 0,
          recovery: {
            kind: "start",
            conversationId: PUBLIC_CONVERSATION_ID,
            companyName: "FrontMind超前智能",
            attachments: [],
          },
          preparedDispatch: {
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "frozen generation two",
              agentProfile: "frontmind-standard",
              attachments: [],
            },
            bodySha256: "d".repeat(64),
            preparedAt: now.toISOString(),
          },
        },
      };
      state.conversations[0] = {
        ...state.conversations[0]!,
        status: "running",
        version: 4,
        completedAt: null,
      };

      const generationTwoResponse = await reconcile();
      expect(generationTwoResponse.status).toBe(200);
      const generationTwo = (await generationTwoResponse.json()) as any;
      expect(generationTwo.observation).toMatchObject({
        stateEpoch: 39,
        generation: 2,
        syncState: "attention_required",
        activeTurn: null,
        notice: {
          code: "FRONTMIND_KB_RETRY_AVAILABLE",
          recoveryAction: "retry_request",
          recoveryToken: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        interaction: {
          interactionState: "failed",
          progress: { build: { status: "protocol_error" } },
        },
      });
      expect(state.builds[0]).toMatchObject({
        generation: 2,
        stateEpoch: 39,
        status: "protocol_error",
        activeTurnId: null,
        canonicalTaskState: "attention_required",
        handoffProvenance: {
          sourceGeneration: 1,
          targetGeneration: 2,
          recoverySourceTurnId: generationTwoTurnId,
          terminalRecovery: {
            action: "retry_compatible_create",
            recoveryStateSha256: generationTwo.observation.notice.recoveryToken,
          },
        },
      });
      expect(state.turns[0]).toMatchObject({
        id: generationTwoTurnId,
        status: "failed",
        upstreamTaskId: null,
        leaseExpiresAt: null,
        metadata: {
          createAttemptState: "rejected",
          providerAttemptState: "rejected",
          dispatchState: "failed",
          failureClass: "requires_user_fix",
          recoveryAction: "retry_request",
        },
      });
      expect(state.conversations[0]).toMatchObject({
        status: "failed",
        version: 5,
        completedAt: expect.any(Date),
      });
      expect(JSON.stringify(generationTwo).toLowerCase()).not.toContain(
        "manus",
      );
      expect(JSON.stringify(generationTwo)).not.toContain(
        "系统正在恢复当前操作",
      );
      expect(providerRequests).toBe(0);

      const stableGenerationTwoBuild = structuredClone(state.builds[0]);
      const stableGenerationTwoTurn = structuredClone(state.turns[0]);
      const stableGenerationTwoConversation = structuredClone(
        state.conversations[0],
      );
      const repeatedGenerationTwoResponse = await reconcile();
      expect(repeatedGenerationTwoResponse.status).toBe(200);
      expect(
        ((await repeatedGenerationTwoResponse.json()) as any).observation,
      ).toMatchObject({
        stateEpoch: 39,
        activeTurn: null,
        notice: {
          recoveryAction: "retry_request",
          recoveryToken: generationTwo.observation.notice.recoveryToken,
        },
        interaction: { interactionState: "failed" },
      });
      expect(state.builds[0]).toStrictEqual(stableGenerationTwoBuild);
      expect(state.turns[0]).toStrictEqual(stableGenerationTwoTurn);
      expect(state.conversations[0]).toStrictEqual(
        stableGenerationTwoConversation,
      );
      expect(providerRequests).toBe(0);
    } finally {
      dependencies.upstreamBaseUrl = previousUpstreamBaseUrl;
      await Promise.all([
        close(dashboardListener?.server),
        close(providerListener.server),
      ]);
    }
  });

  // Pre-v5 provider-task recovery is intentionally unsupported. Old builds now
  // fail closed as RESET_REQUIRED; v5 initial/revision/confirm coverage lives in
  // knowledge-base-materialized-contract.test.ts and knowledge-base-api.test.ts.
  it.skip("retires completed v4 zero-image Manifest recovery", async () => {
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
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "output_pending",
        operationToken: operationKey,
        lastSeenEventIds: ["event-initial-result"],
        manusV2Lifecycle: { waitingEventId: "event-waiting" },
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
      metadata: {
        attachmentsFrozen: true,
        userAttachmentCount: 0,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "accepted",
        operationToken: operationKey,
        lastSeenEventIds: ["event-initial-result"],
        manusV2Lifecycle: { waitingEventId: "event-waiting" },
        recovery: {},
      },
    });

    const recoveredOutput = [
      {
        id: "recovered-v4-initial-logo",
        type: "output_image",
        file_id: "file-recovered-v4-initial-logo",
        filename: "company-logo.png",
        mime_type: "image/png",
      },
      ...output,
    ];
    const recoveryUpstream = express();
    recoveryUpstream.use(express.json());
    let sourceTaskReads = 0;
    let sourceLogoDownloads = 0;
    recoveryUpstream.get("/v1/tasks/:taskId", (req, res) => {
      sourceTaskReads += 1;
      expect(req.params.taskId).toBe(taskId);
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.json({ id: taskId, status: "completed", output: recoveredOutput });
    });
    recoveryUpstream.get(
      "/v1/files/file-recovered-v4-initial-logo/content",
      (req, res) => {
        sourceLogoDownloads += 1;
        expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", String(fixture.logo.length));
        res.send(fixture.logo);
      },
    );
    const recoveryUpstreamListener = await listen(recoveryUpstream);
    dependencies.upstreamBaseUrl = recoveryUpstreamListener.baseUrl;
    const { default: knowledgeBaseRouter } = await import(
      "./knowledge-base-api"
    );
    const { requireExpressAuth } = await import("./_core/express-auth");
    const recoveryDashboard = express();
    recoveryDashboard.use(express.json());
    recoveryDashboard.use(
      "/api/knowledge-base",
      requireExpressAuth,
      knowledgeBaseRouter,
    );
    const recoveryDashboardListener = await listen(recoveryDashboard);
    const turnCountBeforeRecovery = state.turns.length;
    try {
      const response = await fetch(
        `${recoveryDashboardListener.baseUrl}/api/knowledge-base/progress/reconcile`,
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
      expect(response.status).toBe(200);
      const recovered = (await response.json()) as any;
      expect(recovered.observation.interaction.progress.build).toMatchObject({
        status: "confirming",
        revision: 0,
        currentLeafId: fixture.leaves[0]!.id,
        logoRequired: false,
      });
      expect(state.builds[0]).toMatchObject({
        activeTurnId: null,
        upstreamTaskId: taskId,
        logoSha256: fixture.logoSha256,
        logoBytes: fixture.logo.length,
      });
      expect(state.turns).toHaveLength(turnCountBeforeRecovery);
      expect(sourceTaskReads).toBe(1);
      expect(sourceLogoDownloads).toBe(1);
    } finally {
      await Promise.all([
        close(recoveryDashboardListener.server),
        close(recoveryUpstreamListener.server),
      ]);
      const recoveredLogoStorageKey = state.builds[0]?.logoStorageKey;
      if (recoveredLogoStorageKey) {
        const artifactStore = await import("./knowledge-build-artifact-store");
        await artifactStore.removeKnowledgeBuildArtifact({
          userId: USER_ID,
          buildId,
          generation: 1,
          kind: "logo",
          storageKey: recoveredLogoStorageKey,
        });
      }
    }
  });

  it("keeps an atomic pre-v5 rollback reset-only when turn completion fails", async () => {
    const fixture = await createFinalPackageFixture();
    const state = initialState();
    const buildId = "24242424-2424-4242-8242-242424242424";
    const turnId = "25252525-2525-4252-8252-252525252525";
    const taskId = "task-v4-atomic-transition";
    const operationKey = "operation-v4-atomic-transition";
    const now = new Date("2026-08-04T01:00:00.000Z");
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "2".repeat(64),
      treePolicyVersion: 1,
      initialResearchCoverage: null,
      status: "confirming",
      generation: 1,
      stateEpoch: 2,
      revision: 0,
      currentLeafId: fixture.leaves[0]!.id,
      totalNodeCount: fixture.leaves.length,
      confirmedCount: 0,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: turnId,
      upstreamTaskId: taskId,
      lastAppliedOperationKey: null,
      currentPresentationKey: "presentation-current-1",
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
    state.nodes.push(
      ...fixture.leaves.map((leaf, ordinal) => ({
        id: `25252525-2525-4252-8252-${String(ordinal + 1).padStart(12, "0")}`,
        buildId,
        leafId: leaf.id,
        branchId: "products",
        branchTitle: "产品与服务",
        title: leaf.title,
        ordinal,
        status: ordinal === 0 ? "current" : "pending",
        transitionReason: null,
        contentMarkdown: ordinal === 0 ? leaf.contentMarkdown : null,
        contentSha256:
          ordinal === 0
            ? knowledgeBaseMarkdownSha256(leaf.contentMarkdown)
            : null,
        lastUserInput: null,
        sourceUrls: [],
        imageUrls: [],
        lastTaskId: ordinal === 0 ? taskId : null,
        sourceTurnId: ordinal === 0 ? "turn-initial" : null,
        presentationKey: ordinal === 0 ? "presentation-current-1" : null,
        lastResponseAt: ordinal === 0 ? now : null,
        confirmedAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    );
    state.turns.push({
      id: turnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId: "request-v4-atomic-transition",
      buildId,
      buildGeneration: 1,
      operationKey,
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: fixture.leaves[0]!.id,
      requestHash: "3".repeat(64),
      upstreamIdempotencyKeyHash: "4".repeat(64),
      attachmentFileIds: [],
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.sendMessage",
        providerAttemptState: "output_pending",
        operationToken: operationKey,
        lastSeenEventIds: ["event-transition-result"],
        recovery: { outputCursor: 1 },
      },
      leaseExpiresAt: new Date("2026-08-04T01:05:00.000Z"),
      status: "running",
      upstreamTaskId: taskId,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const frozenState = structuredClone(state);
    let rejectedCompletionWrites = 0;
    dependencies.getDb.mockResolvedValue(
      memoryDatabase(state, {
        transactional: true,
        failUpdate(table, values) {
          if (table === conversationTurns && values.status === "completed") {
            rejectedCompletionWrites += 1;
            return new Error("injected turn completion write failure");
          }
          return undefined;
        },
      }),
    );

    const progressText = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: operationKey,
      turnId,
      revision: 0,
      transition: {
        leafId: fixture.leaves[0]!.id,
        from: "current",
        to: "confirmed",
        reason: "用户明确确认当前节点",
      },
    });
    const presentationText = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 2,
      operationId: operationKey,
      turnId,
      revision: 1,
      leafId: fixture.leaves[1]!.id,
      imageState: "no_eligible_asset",
      assetIds: [],
      imageCount: 0,
    });
    const { reconcileKnowledgeBaseProgress } = await import(
      "./knowledge-base-progress-service"
    );
    const progress = await reconcileKnowledgeBaseProgress({
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      taskId,
      userText: "确认",
      attachmentCount: 0,
      output: [
        {
          id: "assistant-v4-atomic-transition",
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_text",
              text: {
                value: `${fixture.leaves[1]!.contentMarkdown}\n${progressText}\n${presentationText}`,
              },
            },
          ],
        },
      ],
      upstreamStatus: "running",
    });

    expect(rejectedCompletionWrites).toBe(1);
    expect(progress.build).toMatchObject({
      status: "protocol_error",
      executionMode: "legacy_conversational",
      protocolError: expect.stringContaining("RESET_REQUIRED"),
      revision: 0,
      currentLeafId: fixture.leaves[0]!.id,
    });
    expect(state).toEqual(frozenState);
    expect(state.turns[0]!.metadata).toMatchObject({
      providerAttemptState: "output_pending",
      lastSeenEventIds: ["event-transition-result"],
      recovery: { outputCursor: 1 },
    });
  });

  it("projects a migrated pre-v5 reopen result as RESET_REQUIRED", async () => {
    const fixture = await createFinalPackageFixture();
    const state = initialState();
    const buildId = "26262626-2626-4262-8262-262626262626";
    const turnId = "27272727-2727-4272-8272-272727272727";
    const taskId = "task-v2-migrated-reopen";
    const operationKey = "operation-v2-migrated-reopen";
    const revision = fixture.leaves.length;
    const reopenedLeaf = fixture.leaves[2]!;
    const now = new Date("2026-08-04T02:00:00.000Z");
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "",
      skillName: "socratic-kb-builder",
      skillVersion: "3",
      skillContentHash: "6".repeat(64),
      treePolicyVersion: 1,
      initialResearchCoverage: null,
      providerProtocol: "manus_v2",
      status: "confirming",
      generation: 1,
      stateEpoch: 5,
      revision,
      currentLeafId: null,
      totalNodeCount: revision,
      confirmedCount: revision,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: turnId,
      upstreamTaskId: taskId,
      lastAppliedOperationKey: "operation-before-reopen",
      currentPresentationKey: null,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "请重新核验第三个节点",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: now,
      packageStatus: "ready",
      packageAttemptCount: 1,
      packageRevision: revision,
      packageTaskId: "task-before-reopen",
      packageOutputItemId: "output-before-reopen",
      packageFileId: "file-before-reopen",
      packageFilename: "before-reopen.zip",
      packageDescriptorHash: "7".repeat(64),
      packageStorageKey: "knowledge-builds/before-reopen.zip",
      packageArchiveSha256: "8".repeat(64),
      packageSizeBytes: 1234,
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
      protocolErrorCode: null,
      protocolError: null,
      publishedSnapshotId: null,
      completedAt: now,
      contentCompletedAt: now,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    state.nodes.push(
      ...fixture.leaves.map((leaf, ordinal) => ({
        id: `27272727-2727-4272-8272-${String(ordinal + 1).padStart(12, "0")}`,
        buildId,
        leafId: leaf.id,
        branchId: "products",
        branchTitle: "产品与服务",
        title: leaf.title,
        ordinal,
        status: "confirmed",
        transitionReason: "历史节点已确认",
        contentMarkdown: leaf.contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
        lastUserInput: null,
        sourceUrls: [],
        imageUrls: [],
        lastTaskId: "task-before-reopen",
        sourceTurnId: `turn-before-reopen-${ordinal + 1}`,
        presentationKey: `presentation-before-reopen-${ordinal + 1}`,
        lastResponseAt: now,
        confirmedAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    );
    state.turns.push({
      id: turnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId: "request-v2-migrated-reopen",
      buildId,
      buildGeneration: 1,
      operationKey,
      operationType: "revise",
      expectedRevision: revision,
      expectedLeafId: null,
      requestHash: "9".repeat(64),
      upstreamIdempotencyKeyHash: "a".repeat(64),
      attachmentFileIds: [],
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.sendMessage",
        providerAttemptState: "output_pending",
        operationToken: operationKey,
        lastSeenEventIds: ["event-reopen-result"],
        recovery: { migratedFrom: "legacy_v1" },
      },
      leaseExpiresAt: new Date("2026-08-04T02:05:00.000Z"),
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
    const reopenEnvelope = formatKnowledgeBaseReopenEnvelope({
      kind: "frontmind.knowledge-base.reopen",
      schemaVersion: 1,
      revision,
      leafId: reopenedLeaf.id,
      reason: "客户要求重新核验该节点",
    });
    const presentationEnvelope = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 1,
      revision: revision + 1,
      leafId: reopenedLeaf.id,
      imageState: "no_eligible_asset",
      assetIds: [],
      imageCount: 0,
    });
    const { reconcileKnowledgeBaseProgress } = await import(
      "./knowledge-base-progress-service"
    );
    const progress = await reconcileKnowledgeBaseProgress({
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      taskId,
      userText: "请重新核验第三个节点",
      attachmentCount: 0,
      output: [
        {
          id: "assistant-v2-migrated-reopen",
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_text",
              text: {
                value: `${reopenedLeaf.contentMarkdown}\n${reopenEnvelope}\n${presentationEnvelope}`,
              },
            },
          ],
        },
      ],
      upstreamStatus: "completed",
    });

    expect(progress.build).toMatchObject({
      status: "protocol_error",
      executionMode: "legacy_conversational",
      protocolError: expect.stringContaining("RESET_REQUIRED"),
      revision: revision + 1,
      currentLeafId: reopenedLeaf.id,
    });
  });

  it.skip("retires historical Skill-v4 archive rebinding", async () => {
    const buildId = "13131313-1313-4131-8131-131313131313";
    const taskId = "task-historical-v4-schema3";
    const fileId = "file-historical-v4-schema3";
    const now = new Date("2026-08-05T00:00:00.000Z");
    const fixture = await createFinalPackageFixture({
      leafCount: FINAL_REVISION,
      buildRevision: FINAL_REVISION,
      schemaVersion: 3,
    });
    const fixtureSha256 = createHash("sha256")
      .update(fixture.archive)
      .digest("hex");
    const state = initialState();
    state.builds.push({
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "3".repeat(64),
      status: "protocol_error",
      generation: 1,
      stateEpoch: 7,
      revision: FINAL_REVISION,
      currentLeafId: null,
      totalNodeCount: FINAL_REVISION,
      confirmedCount: FINAL_REVISION,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      activeTurnId: null,
      upstreamTaskId: taskId,
      lastAppliedOperationKey: "operation-historical-v4-schema3",
      currentPresentationKey: null,
      lastReconciledHash: null,
      lastOutputLength: 1,
      lastOutputItemIds: ["assistant-historical-v4-schema3"],
      lastTurnUserText: "确认",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: null,
      packageRevision: FINAL_REVISION,
      packageTaskId: taskId,
      packageOutputItemId: null,
      packageFileId: fileId,
      packageFilename: "historical-v4-schema3.zip",
      packageDescriptorHash: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
      protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
      protocolError: "历史成品需要重新绑定",
      publishedSnapshotId: null,
      completedAt: now,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    state.nodes.push(
      ...fixture.leaves.map((leaf, ordinal) => ({
        id: `13131313-1313-4131-8131-${String(ordinal + 1).padStart(12, "0")}`,
        buildId,
        leafId: leaf.id,
        branchId: "products",
        branchTitle: "产品与服务",
        title: leaf.title,
        ordinal,
        status: "confirmed",
        transitionReason: "历史生产版本已确认",
        contentMarkdown: leaf.contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
        lastUserInput: null,
        sourceUrls: [],
        imageUrls: [],
        lastTaskId: taskId,
        sourceTurnId: null,
        presentationKey: `historical-presentation-${ordinal + 1}`,
        lastResponseAt: now,
        confirmedAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const provenanceTurn = completedOfficialLogoProvenanceTurn({
      id: "14141414-1414-4141-8141-141414141414",
      buildId,
      generation: 1,
      now,
    });
    provenanceTurn.metadata.boundOfficialLogoProvenance = {
      sourceKind: "official_web",
      sourcePageUrl: "https://new-ledger.example.com/",
      sourceAssetUrl: "https://new-ledger.example.com/logo.png",
    };
    state.turns.push(provenanceTurn);
    dependencies.getDb.mockResolvedValue(
      memoryDatabase(state, { cloneSelectedRows: true }),
    );

    const providerOutput = [
      {
        id: "assistant-historical-v4-schema3",
        role: "assistant",
        type: "output_message",
        content: [
          {
            type: "output_file",
            file_id: fileId,
            file_name: "historical-v4-schema3.zip",
            mime_type: "application/zip",
          },
        ],
      },
    ];
    const upstream = express();
    upstream.get(`/v1/files/${fileId}/content`, (req, res) => {
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(fixture.archive.length));
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="historical-v4-schema3.zip"',
      );
      res.send(fixture.archive);
    });
    const upstreamListener = await listen(upstream);
    dependencies.upstreamBaseUrl = upstreamListener.baseUrl;

    let dashboardListener: Awaited<ReturnType<typeof listen>> | undefined;
    try {
      const { bindKnowledgeBaseReadyPackage } = await import(
        "./knowledge-base-artifact-binding-service"
      );
      const rebound = await bindKnowledgeBaseReadyPackage({
        userId: USER_ID,
        buildId,
        generation: 1,
        taskId,
        output: providerOutput,
        apiKey: "sk-e2e-only",
        baseUrl: upstreamListener.baseUrl,
      });
      expect(rebound).toMatchObject({
        idempotent: false,
        sha256: fixtureSha256,
        bytes: fixture.archive.length,
      });
      expect(state.builds[0]).toMatchObject({
        status: "ready_to_publish",
        protocolError: null,
        protocolErrorCode: null,
        revision: FINAL_REVISION,
        packageRevision: FINAL_REVISION,
        packageArchiveSha256: fixtureSha256,
        packageSizeBytes: fixture.archive.length,
        packageStorageKey: expect.any(String),
        logoSha256: fixture.logoSha256,
        logoBytes: fixture.logo.length,
        logoStorageKey: expect.any(String),
      });

      const { default: artifactRouter } = await import(
        "./knowledge-base-artifact-api"
      );
      const { default: dashboardRouter } = await import("./dashboard-api");
      const { requireExpressAuth } = await import("./_core/express-auth");
      const dashboard = express();
      dashboard.use(express.json());
      dashboard.use(
        "/api/knowledge-base/artifacts",
        requireExpressAuth,
        artifactRouter,
      );
      dashboard.use("/api/dashboard", dashboardRouter);
      dashboardListener = await listen(dashboard);

      const artifactResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/artifacts/${buildId}/package`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(artifactResponse.status).toBe(200);
      expect(Buffer.from(await artifactResponse.arrayBuffer())).toEqual(
        fixture.archive,
      );

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
      expect(published.snapshot).toMatchObject({
        sourceBuildId: buildId,
        sourceBuildRevision: FINAL_REVISION,
        archiveHash: fixtureSha256,
        imageCount: 1,
      });
      expect(state.builds[0]).toMatchObject({
        status: "published",
        publishedSnapshotId: published.snapshot.id,
      });
      expect(
        state.snapshots[0]!.documents.filter(
          (document: any) => document.kind === "leaf",
        ).map((document: any) => document.id),
      ).toEqual(fixture.leaves.map((leaf) => leaf.id));
    } finally {
      await Promise.all([
        close(dashboardListener?.server),
        close(upstreamListener.server),
      ]);
    }
  }, 60_000);

  it("does not expose pre-v5 provider finalization as publishable content", async () => {
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
      driftLastPackagedLeaf: true,
    });
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
      metadata: {
        attachmentsFrozen: true,
        providerProtocol: "manus_v2",
        providerMethod: "task.sendMessage",
        providerAttemptState: "sending",
        operationToken: operationKey,
        lastSeenEventIds: ["event-final-result"],
        providerRejectionCount: 0,
        recovery: { outputCursor: 45 },
      },
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
    state.turns.push(
      completedOfficialLogoProvenanceTurn({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        buildId,
        generation: 1,
        now,
      }),
    );
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
    const completedProgress = await reconcileKnowledgeBaseProgress({
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      taskId,
      userText: "确认",
      attachmentCount: 0,
      output: textOnlyOutput,
      upstreamStatus: "completed",
    });
    expect(completedProgress.build).toMatchObject({
      status: "protocol_error",
      executionMode: "legacy_conversational",
      protocolError: expect.stringContaining("RESET_REQUIRED"),
      revision: finalRevision,
      currentLeafId: null,
    });
    expect(completedProgress.packageAllowed).toBe(false);
  }, 60_000);

  it.skip("retires settled legacy task late-ZIP recovery", async () => {
    // Tree policy v1 is the smallest production archive contract (8 leaves).
    // Keep this fixture compact without reviving the deleted 30/45-leaf flow.
    const finalRevision = 8;
    const priorRevision = finalRevision - 1;
    const buildId = "15151515-1515-4151-8151-151515151515";
    const turnId = "16161616-1616-4161-8161-161616161616";
    const taskId = "task-settled-legacy-late-zip";
    const operationKey = "operation-settled-legacy-late-zip";
    const fileId = "file-settled-legacy-late-zip";
    const now = new Date("2026-08-06T00:00:00.000Z");
    const fixture = await createFinalPackageFixture({
      leafCount: finalRevision,
      buildRevision: finalRevision,
      schemaVersion: 4,
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
    Object.assign(state.conversations[0]!, {
      status: "failed",
      upstreamTaskId: taskId,
      previousResponseId: taskId,
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
      upstreamTaskId: taskId,
      providerProtocol: "legacy_v1",
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      canonicalCredentialId: null,
      canonicalTaskState: "unbound",
      canonicalTaskUrl: null,
      canonicalTaskCreatedAt: null,
      handoffProvenance: null,
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "4".repeat(64),
      treePolicyVersion: 1,
      initialResearchCoverage: null,
      status: "protocol_error",
      generation: 1,
      stateEpoch: 11,
      activeTurnId: turnId,
      lastAppliedOperationKey: null,
      currentPresentationKey: "presentation-settled-legacy-final-leaf",
      revision: priorRevision,
      currentLeafId: `1.${finalRevision}`,
      totalNodeCount: finalRevision,
      confirmedCount: priorRevision,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
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
      skillArchiveSha256: null,
      skillArchiveBytes: null,
      skillArchiveStorageKey: null,
      contentCompletedAt: null,
      packageStatus: "not_started",
      packageAttemptCount: 0,
      packageNextRetryAt: null,
      packageLastErrorCode: "FINAL_PACKAGE_MISSING",
      logoStorageKey: persistedLogo.storageKey,
      logoSha256: persistedLogo.sha256,
      logoBytes: persistedLogo.bytes,
      logoFilename: "frontmind-logo.png",
      logoMimeType: "image/png",
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      protocolErrorCode: "FINAL_PACKAGE_MISSING",
      protocolError: "最终知识库 ZIP 尚未随同一已结束任务到达",
      publishedSnapshotId: null,
      completedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    state.nodes.push(
      ...fixture.leaves.map((leaf, ordinal) => ({
        id: `15151515-1515-4151-8151-${String(ordinal + 1).padStart(12, "0")}`,
        buildId,
        leafId: leaf.id,
        branchId: "products",
        branchTitle: "产品与服务",
        title: leaf.title,
        ordinal,
        status: ordinal < priorRevision ? "confirmed" : "current",
        transitionReason:
          ordinal < priorRevision ? "历史节点已确认" : "等待最终确认结算",
        contentMarkdown: leaf.contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(leaf.contentMarkdown),
        lastUserInput: null,
        sourceUrls: [],
        imageUrls: [],
        lastTaskId: taskId,
        sourceTurnId: null,
        presentationKey:
          ordinal === priorRevision
            ? "presentation-settled-legacy-final-leaf"
            : `presentation-settled-legacy-${ordinal + 1}`,
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
      clientRequestId: "request-settled-legacy-late-zip",
      buildId,
      buildGeneration: 1,
      operationKey,
      operationType: "confirm",
      expectedRevision: priorRevision,
      expectedLeafId: `1.${finalRevision}`,
      requestHash: "5".repeat(64),
      upstreamIdempotencyKeyHash: "6".repeat(64),
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 0,
        userAttachmentCount: 0,
        providerProtocol: "legacy_v1",
        dispatchState: "failed",
        failureClass: "recoverable_same_turn",
        recoveryAction: "reconcile",
        canRegenerate: false,
        recovery: {
          protocolFailureObservation: {
            observationKeyHash: "7".repeat(64),
            count: 3,
            firstObservedAt: "2026-08-05T23:59:50.000Z",
            lastObservedAt: now.toISOString(),
          },
        },
      },
      leaseExpiresAt: null,
      status: "failed",
      upstreamTaskId: taskId,
      errorCode: "FINAL_PACKAGE_MISSING",
      errorMessage: "最终知识库 ZIP 尚未随同一已结束任务到达",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
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
    const finalText = `${progressText}\n${presentationText}`;
    let providerOutput: unknown[] = [
      {
        id: "assistant-settled-legacy-final",
        role: "assistant",
        type: "output_message",
        operationId: operationKey,
        turnId,
        taskId,
        generation: 1,
        content: [
          { type: "output_text", text: { value: finalText } },
          {
            type: "output_file",
            file_id: fileId,
            file_name: "frontmind-knowledge-base.zip",
            mime_type: "application/zip",
          },
        ],
      },
    ];
    let providerPackageBytes = fixture.archive;
    let taskReads = 0;
    let taskCreates = 0;
    let packageDownloads = 0;
    const upstream = express();
    upstream.use(express.json());
    upstream.post("/v1/tasks", (_req, res) => {
      taskCreates += 1;
      res.status(500).json({ error: { code: "UNEXPECTED_TASK_CREATE" } });
    });
    upstream.get("/v1/tasks/:taskId", (req, res) => {
      taskReads += 1;
      expect(req.params.taskId).toBe(taskId);
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.json({ id: taskId, status: "completed", output: providerOutput });
    });
    upstream.get(`/v1/files/${fileId}/content`, (req, res) => {
      packageDownloads += 1;
      expect(req.header("authorization")).toBe("Bearer sk-e2e-only");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(providerPackageBytes.length));
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="frontmind-knowledge-base.zip"',
      );
      res.send(providerPackageBytes);
    });
    const upstreamListener = await listen(upstream);
    dependencies.upstreamBaseUrl = upstreamListener.baseUrl;

    let dashboardListener: Awaited<ReturnType<typeof listen>> | undefined;
    try {
      const { default: knowledgeBaseRouter } = await import(
        "./knowledge-base-api"
      );
      const { default: artifactRouter } = await import(
        "./knowledge-base-artifact-api"
      );
      const { default: dashboardRouter } = await import("./dashboard-api");
      const { requireExpressAuth } = await import("./_core/express-auth");
      const dashboard = express();
      dashboard.use(express.json());
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
      dashboardListener = await listen(dashboard);

      const postKnowledgeBase = (pathSuffix: string, body: unknown) =>
        fetch(`${dashboardListener!.baseUrl}/api/knowledge-base${pathSuffix}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify(body),
        });
      const retryResponse = await postKnowledgeBase("/retry", {
        conversationId: PUBLIC_CONVERSATION_ID,
        clientRequestId: "must-not-create-a-retry-turn",
        expectedGeneration: 1,
        expectedRevision: priorRevision,
        expectedLeafId: `1.${finalRevision}`,
      });
      expect({
        status: retryResponse.status,
        body: await retryResponse.json(),
      }).toMatchObject({
        status: 409,
        body: {
          error: { code: "CONFLICT" },
          observation: {
            authoritativeTaskId: taskId,
            notice: {
              code: "FINAL_PACKAGE_MISSING",
              recoveryAction: "reconcile",
              canRegenerate: false,
              turnId,
            },
          },
        },
      });
      expect(state.turns).toHaveLength(1);
      expect(taskCreates).toBe(0);
      expect(taskReads).toBe(0);

      const reconcile = () =>
        postKnowledgeBase("/progress/reconcile", {
          conversationId: PUBLIC_CONVERSATION_ID,
          taskId,
        });
      const recoveredResponse = await reconcile();
      expect(recoveredResponse.status).toBe(200);
      const recovered = (await recoveredResponse.json()) as any;
      expect(recovered.observation).toMatchObject({
        authoritativeTaskId: taskId,
        activeTurn: null,
        notice: null,
        contentState: "completed",
        packageState: "ready",
        publicationState: "draft",
        interaction: {
          interactionState: "ready_to_publish",
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
          fileId,
          sha256: archiveSha256,
          sizeBytes: sealedArchive.buffer.length,
        },
      });
      expect(taskCreates).toBe(0);
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
      });
      expect(
        state.turns[0]!.metadata?.recovery?.protocolFailureObservation,
      ).toBeUndefined();
      expect(state.builds[0]).toMatchObject({
        status: "ready_to_publish",
        stateEpoch: 13,
        revision: finalRevision,
        currentLeafId: null,
        confirmedCount: finalRevision,
        activeTurnId: null,
        upstreamTaskId: taskId,
        canonicalTaskId: null,
        lastAppliedOperationKey: operationKey,
        contentCompletedAt: expect.any(Date),
        packageStatus: "ready",
        packageRevision: finalRevision,
        packageTaskId: taskId,
        packageFileId: fileId,
        packageStorageKey: expect.any(String),
        packageArchiveSha256: archiveSha256,
        packageSizeBytes: sealedArchive.buffer.length,
        protocolError: null,
        protocolErrorCode: null,
      });
      expect(state.nodes.every((node) => node.status === "confirmed")).toBe(
        true,
      );
      const completionReceipt = state.messages.find(
        (message) => message.metadata?.knowledgeBase?.kind === "completion",
      );
      expect(completionReceipt).toMatchObject({
        role: "assistant",
        turnId,
        sequence: expect.any(Number),
        metadata: {
          knowledgeBase: {
            serverOwned: true,
            buildId,
            generation: 1,
            operationKey,
            revision: finalRevision,
            leafId: null,
          },
        },
      });
      expect(recovered.observation.displaySequence).toBe(
        completionReceipt!.sequence,
      );
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
      const repeatedReconcile = await reconcile();
      expect(repeatedReconcile.status).toBe(200);
      expect((await repeatedReconcile.json()) as any).toMatchObject({
        observation: {
          authoritativeTaskId: taskId,
          displaySequence: completionReceipt!.sequence,
          package: { sha256: archiveSha256 },
        },
      });
      expect(state.builds[0]!.stateEpoch).toBe(stableEpoch);
      expect(state.turns).toHaveLength(1);
      expect(taskCreates).toBe(0);
      expect(taskReads).toBe(1);
      expect(packageDownloads).toBe(1);

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
      expect(published.snapshot).toMatchObject({
        sourceBuildId: buildId,
        sourceBuildRevision: finalRevision,
        sourceTaskId: taskId,
        sourceArtifactHash: archiveSha256,
        archiveHash: archiveSha256,
        archiveAvailable: true,
      });
      expect(state.builds[0]).toMatchObject({
        status: "published",
        publishedSnapshotId: published.snapshot.id,
        packageArchiveSha256: archiveSha256,
      });
      expect(state.snapshots).toHaveLength(1);
      const publishedSnapshotRow = structuredClone(state.snapshots[0]);
      const publishedReceipt = structuredClone(completionReceipt);

      const downloadPublishedArchive = () =>
        fetch(
          `${dashboardListener!.baseUrl}/api/dashboard/knowledge/snapshots/${published.snapshot.id}/archive`,
          { headers: { "x-test-auth": "user" } },
        );
      const firstDownload = await downloadPublishedArchive();
      expect(firstDownload.status).toBe(200);
      expect(Buffer.from(await firstDownload.arrayBuffer())).toEqual(
        sealedArchive.buffer,
      );

      // Simulate a provider mutating both output and bytes behind the same
      // settled task/file IDs after publication. Published projection and
      // download authority must remain entirely Dashboard-owned.
      providerOutput = [
        {
          id: "assistant-settled-legacy-final",
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_text",
              text: { value: "late untrusted replacement output" },
            },
            {
              type: "output_file",
              file_id: fileId,
              file_name: "frontmind-knowledge-base.zip",
              mime_type: "application/zip",
            },
          ],
        },
      ];
      providerPackageBytes = Buffer.from("late untrusted replacement bytes");

      const immutableReconcile = await reconcile();
      expect(immutableReconcile.status).toBe(200);
      expect((await immutableReconcile.json()) as any).toMatchObject({
        observation: {
          displaySequence: completionReceipt!.sequence,
          contentState: "completed",
          packageState: "ready",
          publicationState: "published",
          package: { sha256: archiveSha256 },
        },
      });
      const repeatedPublish = await fetch(
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
      expect(repeatedPublish.status).toBe(200);
      expect((await repeatedPublish.json()) as any).toMatchObject({
        idempotent: true,
        snapshot: { id: published.snapshot.id, archiveHash: archiveSha256 },
      });
      const secondDownload = await downloadPublishedArchive();
      expect(secondDownload.status).toBe(200);
      expect(Buffer.from(await secondDownload.arrayBuffer())).toEqual(
        sealedArchive.buffer,
      );
      expect(state.snapshots).toHaveLength(1);
      expect(state.snapshots[0]).toStrictEqual(publishedSnapshotRow);
      expect(
        state.messages.find(
          (message) => message.metadata?.knowledgeBase?.kind === "completion",
        ),
      ).toStrictEqual(publishedReceipt);
      expect(state.builds[0]).toMatchObject({
        status: "published",
        publishedSnapshotId: published.snapshot.id,
        packageArchiveSha256: archiveSha256,
        packageSizeBytes: sealedArchive.buffer.length,
      });
      expect(taskCreates).toBe(0);
      expect(taskReads).toBe(1);
      expect(packageDownloads).toBe(1);
    } finally {
      await Promise.all([
        close(dashboardListener?.server),
        close(upstreamListener.server),
      ]);
    }
  }, 60_000);

  it.skip("retires provider final-package repair turns", async () => {
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
      driftLastPackagedLeaf: true,
    });
    const providerArchiveZip = await JSZip.loadAsync(fixture.archive);
    const providerManifestEntry = Object.values(providerArchiveZip.files).find(
      (entry) => entry.name.endsWith("/00_package_manifest.json"),
    );
    expect(providerManifestEntry).toBeTruthy();
    const providerManifest = JSON.parse(
      await providerManifestEntry!.async("string"),
    );
    providerManifest.counts.customerVisibleCharacters += 615;
    providerArchiveZip.file(
      providerManifestEntry!.name,
      JSON.stringify(providerManifest),
    );
    const providerArchive = await providerArchiveZip.generateAsync({
      type: "nodebuffer",
    });
    const sealedArchive = await canonicalizeKnowledgeBaseFinalArchive({
      buffer: providerArchive,
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
    expect(sealedArchive.buffer.equals(providerArchive)).toBe(false);
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
    let uploadedFileSequence = 0;
    let retryOperationKey = "";
    let retryTurnId = "";
    let retryTaskOutput: unknown[] = [];
    const uploadedFileBytes = new Map<string, Buffer>();
    const uploadedFileNames = new Map<string, string>();
    const upstream = express();
    upstream.use(express.json({ limit: "5mb" }));
    let upstreamBaseUrl = "";
    upstream.post("/v1/files", (req, res) => {
      expect(req.header("api_key")).toBe("sk-e2e-only");
      expect(req.header("authorization")).toBeUndefined();
      const filename = String(req.body.filename || "");
      expect(
        filename === "socratic-kb-builder.skill.zip" ||
          /^frontmind-kb-finalization-input-[a-f0-9]{16}\.zip$/u.test(filename),
      ).toBe(true);
      const kind = filename.startsWith("socratic-") ? "skill" : "finalization";
      const fileId = `uploaded-${kind}-retry-${++uploadedFileSequence}`;
      uploadedFileNames.set(fileId, filename);
      res.json({
        id: fileId,
        upload_url: `${upstreamBaseUrl}/uploads/${fileId}`,
      });
    });
    upstream.put(
      "/uploads/:fileId",
      express.raw({ type: "*/*", limit: "100mb" }),
      (req, res) => {
        expect(req.header("authorization")).toBeUndefined();
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        expect(bytes.length).toBeGreaterThan(0);
        uploadedFileBytes.set(req.params.fileId, Buffer.from(bytes));
        res.status(200).end();
      },
    );
    upstream.get("/v1/files/:fileId", (req, res) => {
      expect(req.header("api_key")).toBe("sk-e2e-only");
      expect(req.header("authorization")).toBeUndefined();
      const filename = uploadedFileNames.get(req.params.fileId);
      if (!filename || !uploadedFileBytes.has(req.params.fileId)) {
        res.status(404).json({ error: { code: "FILE_NOT_FOUND" } });
        return;
      }
      res.json({ id: req.params.fileId, filename, status: "uploaded" });
    });
    upstream.post("/v1/tasks", (req, res) => {
      providerTaskPosts += 1;
      expect(req.header("api_key")).toBe("sk-e2e-only");
      expect(req.header("authorization")).toBeUndefined();
      expect(req.header("idempotency-key")).toBeUndefined();
      expect(req.body.taskMode).toBeUndefined();
      expect(req.body.taskId).toBeUndefined();
      const attachmentFilenames = req.body.attachments.map(
        (attachment: any) => attachment.filename,
      );
      expect(attachmentFilenames[0]).toBe("socratic-kb-builder.skill.zip");
      expect(attachmentFilenames[1]).toMatch(
        /^frontmind-kb-finalization-input-[a-f0-9]{16}\.zip$/u,
      );
      expect(req.body.attachments).toHaveLength(2);
      for (const attachment of req.body.attachments) {
        expect(
          uploadedFileBytes.get(attachment.file_id)?.length,
        ).toBeGreaterThan(0);
      }
      const prompt = String(req.body.prompt || "");
      expect(Array.from(prompt).length).toBeLessThanOrEqual(3_000);
      retryOperationKey =
        prompt.match(/"operationId":"([^"]+)"/u)?.[1] ||
        prompt.match(/operationId=([^；;\s]+)/u)?.[1] ||
        "";
      retryTurnId =
        prompt.match(/"turnId":"([^"]+)"/u)?.[1] ||
        prompt.match(/turnId=([^。；;\s]+)/u)?.[1] ||
        "";
      expect(retryOperationKey).toBeTruthy();
      expect(retryOperationKey).not.toBe(sourceOperationKey);
      expect(retryTurnId).toBeTruthy();
      expect(retryTurnId).not.toBe(sourceTurnId);
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
                  `<!-- FRONTMIND_KB_PROGRESS\n${JSON.stringify({
                    kind: "frontmind.knowledge-base.progress",
                    schemaVersion: 2,
                    operationId: retryOperationKey,
                    turnId: retryTurnId,
                    revision: priorRevision,
                    transition: {
                      leafId: `1.${finalRevision}`,
                      from: "current",
                      to: "confirmed",
                      reason: "用户明确确认",
                    },
                  })}\n-->`,
                  `<!-- FRONTMIND_KB_PRESENTATION\n${JSON.stringify({
                    kind: "frontmind.knowledge-base.presentation",
                    schemaVersion: 2,
                    operationId: retryOperationKey,
                    turnId: retryTurnId,
                    revision: finalRevision,
                    leafId: null,
                    imageState: "not_applicable",
                    assetIds: [],
                    imageCount: 0,
                  })}\n-->`,
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
      res.setHeader("Content-Length", String(providerArchive.length));
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="frontmind-knowledge-base.zip"',
      );
      res.send(providerArchive);
    });
    const upstreamListener = await listen(upstream);
    upstreamBaseUrl = upstreamListener.baseUrl;
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
        "最终知识库 ZIP 未通过当前操作的完整性校验；本轮未提交，仍停留在最后节点",
      protocolErrorCode: "FINAL_PACKAGE_INVALID",
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
        failureClass: "terminal_requires_regeneration",
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
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
      errorCode: "FINAL_PACKAGE_INVALID",
      errorMessage: "最终 ZIP 未通过完整性校验",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    state.turns.push(
      completedOfficialLogoProvenanceTurn({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        buildId,
        generation: 1,
        now,
      }),
    );
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
            code: "FINAL_PACKAGE_INVALID",
            retryable: true,
            failureClass: "terminal_requires_regeneration",
            recoveryAction: "regenerate_turn",
            canRegenerate: true,
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

      const sourceBeforeRejectedRetry = state.turns.find(
        (turn) => turn.id === sourceTurnId,
      )!;
      const legalSourceMetadata = sourceBeforeRejectedRetry.metadata;
      const legalSourceUpstreamTaskId =
        sourceBeforeRejectedRetry.upstreamTaskId;
      const legalBuildUpstreamTaskId = state.builds[0]!.upstreamTaskId;
      const legalProtocolErrorCode = state.builds[0]!.protocolErrorCode;
      const legalProtocolError = state.builds[0]!.protocolError;
      const turnsBeforeRejectedRetry = state.turns.length;
      const taskPostsBeforeRejectedRetry = providerTaskPosts;

      sourceBeforeRejectedRetry.metadata = {
        ...(legalSourceMetadata as Record<string, unknown>),
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
        canRegenerate: false,
        createAttemptState: "rejected",
      };
      sourceBeforeRejectedRetry.upstreamTaskId = null;
      sourceBeforeRejectedRetry.errorCode = "UPSTREAM_CREATE_HTTP_401";
      sourceBeforeRejectedRetry.errorMessage = "上游已明确拒绝当前任务创建凭证";
      state.builds[0]!.upstreamTaskId = null;
      state.builds[0]!.protocolErrorCode = "UPSTREAM_CREATE_HTTP_401";
      state.builds[0]!.protocolError = "上游已明确拒绝当前任务创建凭证";
      const rejectedCredentialTurnSnapshot = structuredClone(
        sourceBeforeRejectedRetry,
      );
      const rejectedCredentialBuildSnapshot = structuredClone(state.builds[0]);

      const rejectedCredentialReconcileResponse = await fetch(
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
      expect({
        status: rejectedCredentialReconcileResponse.status,
        body: await rejectedCredentialReconcileResponse.json(),
      }).toMatchObject({
        status: 200,
        body: {
          observation: {
            authoritativeTaskId: null,
            activeTurn: {
              id: sourceTurnId,
              createAttemptState: "rejected",
              recoveryAction: "update_credential",
            },
            notice: {
              code: "UPSTREAM_CREATE_HTTP_401",
              recoveryAction: "update_credential",
              canRegenerate: false,
              turnId: sourceTurnId,
            },
          },
        },
      });
      expect(sourceBeforeRejectedRetry).toStrictEqual(
        rejectedCredentialTurnSnapshot,
      );
      expect(state.builds[0]).toStrictEqual(rejectedCredentialBuildSnapshot);
      expect(providerTaskPosts).toBe(taskPostsBeforeRejectedRetry);

      sourceBeforeRejectedRetry.metadata = {
        ...(legalSourceMetadata as Record<string, unknown>),
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
        createAttemptState: "rejected",
      };
      sourceBeforeRejectedRetry.errorCode = "UPSTREAM_CREATE_3";
      sourceBeforeRejectedRetry.errorMessage = "上游已明确拒绝创建本轮任务";
      state.builds[0]!.protocolErrorCode = "UPSTREAM_CREATE_3";
      state.builds[0]!.protocolError = "上游已明确拒绝创建本轮任务";

      const rejectedRetryResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/retry`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({
            conversationId: PUBLIC_CONVERSATION_ID,
            clientRequestId: "request-rejected-create-must-not-retry",
            expectedGeneration: 1,
            expectedRevision: priorRevision,
            expectedLeafId: `1.${finalRevision}`,
          }),
        },
      );
      expect({
        status: rejectedRetryResponse.status,
        body: await rejectedRetryResponse.json(),
      }).toMatchObject({
        status: 409,
        body: {
          error: { code: "CONFLICT" },
          observation: {
            notice: {
              code: "UPSTREAM_CREATE_3",
              recoveryAction: "contact_support",
              canRegenerate: false,
              turnId: sourceTurnId,
            },
          },
        },
      });
      expect(state.turns).toHaveLength(turnsBeforeRejectedRetry);
      expect(providerTaskPosts).toBe(taskPostsBeforeRejectedRetry);
      expect(
        state.turns.find((turn) => turn.id === sourceTurnId),
      ).toMatchObject({
        status: "failed",
        errorCode: "UPSTREAM_CREATE_3",
        metadata: {
          createAttemptState: "rejected",
          recoveryAction: "contact_support",
        },
      });
      const rejectedCreateSnapshot = structuredClone(sourceBeforeRejectedRetry);
      const rejectedBuildSnapshot = structuredClone(state.builds[0]);
      const rejectedAttachmentRepairResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/turn/replace-attachments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({
            conversationId: PUBLIC_CONVERSATION_ID,
            clientRequestId: "rejected-create-attachment-repair",
            expectedGeneration: 1,
            expectedRevision: priorRevision,
            expectedLeafId: `1.${finalRevision}`,
            attachments: [
              { file_id: "replacement-file", filename: "replacement.pdf" },
            ],
            attachmentManifest: [
              {
                filename: "replacement.pdf",
                sizeBytes: 100,
                mimeType: "application/pdf",
                lastModified: 1,
                sha256: "f".repeat(64),
              },
            ],
          }),
        },
      );
      expect({
        status: rejectedAttachmentRepairResponse.status,
        body: await rejectedAttachmentRepairResponse.json(),
      }).toMatchObject({
        status: 409,
        body: {
          error: { code: "KNOWLEDGE_BASE_ATTACHMENT_REPAIR_CONFLICT" },
          observation: {
            notice: {
              code: "UPSTREAM_CREATE_3",
              turnId: sourceTurnId,
            },
          },
        },
      });
      expect(sourceBeforeRejectedRetry).toStrictEqual(rejectedCreateSnapshot);
      expect(state.builds[0]).toStrictEqual(rejectedBuildSnapshot);
      expect(state.turns).toHaveLength(turnsBeforeRejectedRetry);
      expect(providerTaskPosts).toBe(taskPostsBeforeRejectedRetry);

      sourceBeforeRejectedRetry.metadata = legalSourceMetadata;
      sourceBeforeRejectedRetry.upstreamTaskId = legalSourceUpstreamTaskId;
      sourceBeforeRejectedRetry.errorCode = "FINAL_PACKAGE_INVALID";
      sourceBeforeRejectedRetry.errorMessage = "最终 ZIP 未通过完整性校验";
      state.builds[0]!.upstreamTaskId = legalBuildUpstreamTaskId;
      state.builds[0]!.protocolErrorCode = legalProtocolErrorCode;
      state.builds[0]!.protocolError = legalProtocolError;

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
      const acceptedRetry = (await retryResponse.json()) as any;
      expect({ status: retryResponse.status, acceptedRetry }).toMatchObject({
        status: 202,
        acceptedRetry: {
          accepted: true,
          reservation: {
            dispatchState: "recovering",
            upstreamTaskId: null,
            canRegenerate: false,
          },
        },
      });
      const retryDeadline = Date.now() + 5_000;
      while (
        Date.now() < retryDeadline &&
        state.builds[0]?.status !== "ready_to_publish"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const retryProgressResponse = await fetch(
        `${dashboardListener.baseUrl}/api/knowledge-base/progress/${encodeURIComponent(PUBLIC_CONVERSATION_ID)}`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(retryProgressResponse.status).toBe(200);
      const retried = (await retryProgressResponse.json()) as any;
      expect(retried).toMatchObject({
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
      expect(uploadedFileSequence).toBe(2);
      const uploadedNames = [...uploadedFileNames.values()];
      expect(uploadedNames[0]).toBe("socratic-kb-builder.skill.zip");
      expect(uploadedNames[1]).toMatch(
        /^frontmind-kb-finalization-input-[a-f0-9]{16}\.zip$/u,
      );
      expect(uploadedFileBytes.size).toBe(2);
      expect(retryOperationKey).toBeTruthy();
      expect(retryTurnId).toBeTruthy();

      expect(state.turns).toHaveLength(3);
      expect(
        state.turns.find((turn) => turn.id === sourceTurnId),
      ).toMatchObject({
        status: "failed",
        upstreamTaskId: oldTaskId,
        errorCode: "FINAL_PACKAGE_INVALID",
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
        attachmentFileIds: [
          expect.stringMatching(/^uploaded-skill-retry-/u),
          expect.stringMatching(/^uploaded-finalization-retry-/u),
        ],
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
      expect(state.turns).toHaveLength(3);
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

  it.skip("retires legacy first-Logo acknowledgement retries", async () => {
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

    const getTask = vi.spyOn(axios, "get").mockResolvedValue({
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
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let payload: any;
      for (const [index, seconds] of [0, 5, 10].entries()) {
        vi.setSystemTime(new Date(now.getTime() + seconds * 1_000));
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
        payload = (await response.json()) as any;
        if (index < 2) {
          expect(payload).toMatchObject({
            observation: {
              interaction: {
                interactionState: "executing",
                progress: { build: { status: "researching" } },
              },
              notice: null,
            },
          });
        }
      }
      expect(payload).toMatchObject({
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
      expect(getTask).toHaveBeenCalledTimes(3);
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
      vi.useRealTimers();
      getTask.mockRestore();
      await close(listener.server);
    }
  });

  it("keeps every settled pre-v5 failure projection reset-only", async () => {
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
        expect(progress.build).toMatchObject({
          status: "protocol_error",
          executionMode: "legacy_conversational",
          protocolError: expect.stringContaining("RESET_REQUIRED"),
        });
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

  it.skip("retires legacy protocol-terminal HTTP recovery", async () => {
    const state = initialState();
    const buildId = "77777777-7777-4777-8777-777777777777";
    const turnId = "88888888-8888-4888-8888-888888888888";
    const taskId = "task-legacy-protocol-start";
    const clientRequestId = "request-legacy-protocol-start";
    const completedAt = new Date("2026-08-01T00:00:10.000Z");
    const userAttachment = {
      file_id: "customer-file-legacy-start",
      filename: "company-profile.pdf",
    };
    const recovery = {
      kind: "start",
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
      operatorNotes: "",
      attachments: [userAttachment],
      skillVersion: "4",
      skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
      includePrefill: false,
      prefillSnapshotId: null,
      instructionsAttachmentRequired: true,
      protocolFailureObservation: {
        observationKeyHash: "a".repeat(64),
        count: 3,
        firstObservedAt: "2026-08-01T00:00:00.000Z",
        lastObservedAt: "2026-08-01T00:00:10.000Z",
      },
    };
    const preparedBody = {
      prompt: "Pinned legacy start prompt",
      agentProfile: "FrontMind-Pro",
      taskMode: "agent" as const,
      attachments: [
        {
          file_id: "skill-file-legacy-start",
          filename: "socratic-kb-builder.skill.zip",
        },
        userAttachment,
      ],
    };
    const operationKey = createKnowledgeBaseOperationKey({
      buildId,
      buildGeneration: 1,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
    });
    const requestPayload = {
      companyName: recovery.companyName,
      companyWebsite: recovery.companyWebsite,
      operatorNotes: recovery.operatorNotes,
      attachments: recovery.attachments,
      skillVersion: recovery.skillVersion,
      skillContentHash: recovery.skillContentHash,
      prefillSnapshotId: recovery.prefillSnapshotId,
    };
    const build = {
      id: buildId,
      userId: USER_ID,
      conversationId: PUBLIC_CONVERSATION_ID,
      companyName: recovery.companyName,
      companyWebsite: recovery.companyWebsite,
      skillName: "socratic-kb-builder",
      skillVersion: recovery.skillVersion,
      skillContentHash: recovery.skillContentHash,
      treePolicyVersion: 2,
      status: "protocol_error",
      generation: 1,
      stateEpoch: 3,
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
      initialResearchCoverage: null,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "开始构建企业知识库",
      lastTurnAttachmentCount: 1,
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
      protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
      protocolError: "知识库任务返回了无法识别的进度协议",
      publishedSnapshotId: null,
      completedAt: null,
      publishedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: completedAt,
    };
    const turn = {
      id: turnId,
      conversationId: STORED_CONVERSATION_ID,
      userId: USER_ID,
      apiCredentialId: "credential-e2e",
      clientRequestId,
      buildId,
      buildGeneration: 1,
      operationKey,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "start",
        generation: 1,
        revision: 0,
        leafId: null,
        expectedAttachmentCount: 2,
        userAttachmentCount: 1,
        payload: requestPayload,
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      attachmentFileIds: ["skill-file-legacy-start", userAttachment.file_id],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 1,
        dispatchingAt: "2026-07-31T23:59:59.000Z",
        recovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.invalid",
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          requestBody: preparedBody,
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
      },
      leaseExpiresAt: null,
      status: "failed",
      upstreamTaskId: taskId,
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      errorMessage: "知识库任务返回了无法识别的进度协议",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      completedAt,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: completedAt,
    };
    state.builds.push(build);
    state.turns.push(turn);
    dependencies.getDb.mockResolvedValue(memoryDatabase(state));

    expect(
      inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority(
        turn as any,
        build as any,
      ),
    ).toBe(true);
    expect(inspectKnowledgeBaseRetryAuthority(turn as any, build as any)).toBe(
      null,
    );

    const frozenState = structuredClone(state);
    const providerGet = vi.spyOn(axios, "get");
    const providerPost = vi.spyOn(axios, "post");
    const providerPut = vi.spyOn(axios, "put");
    const providerDelete = vi.spyOn(axios, "delete");
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
    const assertFrozen = () => {
      expect(state).toStrictEqual(frozenState);
      expect(providerGet).not.toHaveBeenCalled();
      expect(providerPost).not.toHaveBeenCalled();
      expect(providerPut).not.toHaveBeenCalled();
      expect(providerDelete).not.toHaveBeenCalled();
    };
    const postJson = (route: string, body: unknown) =>
      fetch(`${listener.baseUrl}/api/knowledge-base${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "user",
        },
        body: JSON.stringify(body),
      });
    try {
      const getResponse = await fetch(
        `${listener.baseUrl}/api/knowledge-base/progress/${encodeURIComponent(PUBLIC_CONVERSATION_ID)}`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(getResponse.status).toBe(200);
      expect((await getResponse.json()) as any).toMatchObject({
        observation: {
          activeTurn: {
            id: turnId,
            status: "failed",
            dispatchState: "failed",
            failureClass: "terminal_nonregenerable",
            recoveryAction: "contact_support",
            canRegenerate: false,
          },
          notice: {
            code: "PROGRESS_PROTOCOL_INVALID",
            retryable: false,
            failureClass: "terminal_nonregenerable",
            recoveryAction: "contact_support",
            canRegenerate: false,
            turnId,
          },
        },
      });
      assertFrozen();

      dependencies.assertKnowledgeBaseWritable.mockClear();
      dependencies.assertKnowledgeBaseWritable.mockRejectedValueOnce(
        new Error("legacy replay must precede the write gate"),
      );
      dependencies.getCredentialForUpstreamResource.mockClear();
      dependencies.getCredentialForUpstreamResource.mockRejectedValueOnce(
        new Error("legacy replay must precede attachment ownership lookup"),
      );
      const startResponse = await postJson("/start", {
        conversationId: PUBLIC_CONVERSATION_ID,
        clientRequestId,
        companyName: recovery.companyName,
        companyWebsite: recovery.companyWebsite,
        operatorNotes: recovery.operatorNotes,
        attachments: recovery.attachments,
      });
      expect(startResponse.status).toBe(200);
      const startPayload = (await startResponse.json()) as any;
      expect(startPayload).not.toHaveProperty("error");
      expect(startPayload).toMatchObject({
        reservation: {
          state: "terminal",
          dispatchState: "failed",
          turnId,
          clientRequestId,
          generation: 1,
          revision: 0,
          leafId: null,
          upstreamTaskId: taskId,
          failureClass: "terminal_nonregenerable",
          recoveryAction: "contact_support",
          canRegenerate: false,
        },
        idempotent: true,
        resumed: true,
        observation: {
          notice: {
            code: "PROGRESS_PROTOCOL_INVALID",
            retryable: false,
          },
        },
      });
      expect(dependencies.assertKnowledgeBaseWritable).not.toHaveBeenCalled();
      expect(
        dependencies.getCredentialForUpstreamResource,
      ).not.toHaveBeenCalled();
      assertFrozen();

      const mismatchedStartResponse = await postJson("/start", {
        conversationId: PUBLIC_CONVERSATION_ID,
        clientRequestId,
        companyName: recovery.companyName,
        companyWebsite: recovery.companyWebsite,
        operatorNotes: "different operator notes",
        attachments: recovery.attachments,
      });
      expect(mismatchedStartResponse.status).toBe(409);
      expect((await mismatchedStartResponse.json()) as any).toMatchObject({
        error: { code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH" },
        reservationCreated: false,
      });
      expect(dependencies.assertKnowledgeBaseWritable).not.toHaveBeenCalled();
      expect(
        dependencies.getCredentialForUpstreamResource,
      ).not.toHaveBeenCalled();
      assertFrozen();

      const freshClientRequestResponse = await postJson("/start", {
        conversationId: PUBLIC_CONVERSATION_ID,
        clientRequestId: "fresh-legacy-client-request",
        companyName: recovery.companyName,
        companyWebsite: recovery.companyWebsite,
        operatorNotes: recovery.operatorNotes,
        attachments: recovery.attachments,
      });
      expect(freshClientRequestResponse.status).toBe(410);
      expect((await freshClientRequestResponse.json()) as any).toMatchObject({
        error: { code: "KNOWLEDGE_BASE_START_RESERVATION_REQUIRED" },
        reservationCreated: false,
      });
      expect(dependencies.assertKnowledgeBaseWritable).not.toHaveBeenCalled();
      expect(
        dependencies.getCredentialForUpstreamResource,
      ).not.toHaveBeenCalled();
      assertFrozen();

      dependencies.assertKnowledgeBaseWritable
        .mockReset()
        .mockResolvedValue(undefined);
      dependencies.getCredentialForUpstreamResource
        .mockReset()
        .mockResolvedValue({
          id: "credential-e2e",
          apiKey: "sk-e2e-only",
        });
      const retryResponse = await postJson("/retry", {
        conversationId: PUBLIC_CONVERSATION_ID,
        clientRequestId: "legacy-start-must-not-retry",
        expectedGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
      });
      expect(retryResponse.status).toBe(409);
      expect((await retryResponse.json()) as any).toMatchObject({
        error: { code: "CONFLICT" },
        observation: {
          notice: {
            code: "PROGRESS_PROTOCOL_INVALID",
            recoveryAction: "contact_support",
            canRegenerate: false,
          },
        },
      });
      assertFrozen();

      const reconcileResponse = await postJson("/progress/reconcile", {
        conversationId: PUBLIC_CONVERSATION_ID,
        taskId,
      });
      expect(reconcileResponse.status).toBe(200);
      expect((await reconcileResponse.json()) as any).toMatchObject({
        observation: {
          notice: {
            code: "PROGRESS_PROTOCOL_INVALID",
            retryable: false,
            recoveryAction: "contact_support",
            canRegenerate: false,
          },
        },
      });
      assertFrozen();

      const replacementResponse = await postJson("/turn/replace-attachments", {
        conversationId: PUBLIC_CONVERSATION_ID,
        clientRequestId: "legacy-start-must-not-replace",
        expectedGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        attachments: [
          { file_id: "replacement-must-not-bind", filename: "safe.pdf" },
        ],
        attachmentManifest: [
          {
            filename: "safe.pdf",
            sizeBytes: 100,
            mimeType: "application/pdf",
            lastModified: 1,
            sha256: "f".repeat(64),
          },
        ],
      });
      expect(replacementResponse.status).toBe(409);
      expect((await replacementResponse.json()) as any).toMatchObject({
        error: { code: "KNOWLEDGE_BASE_ATTACHMENT_REPAIR_CONFLICT" },
        observation: {
          notice: {
            code: "PROGRESS_PROTOCOL_INVALID",
            recoveryAction: "contact_support",
            canRegenerate: false,
          },
        },
      });
      assertFrozen();

      const { claimKnowledgeBaseTurnForRecovery } = await import(
        "./knowledge-base-turn-service"
      );
      const { claimKnowledgeBaseOpenRecoveryBuild } = await import(
        "./knowledge-base-open-recovery-lease"
      );
      await expect(
        claimKnowledgeBaseTurnForRecovery(
          { turnId, now: new Date("2026-08-02T00:00:00.000Z") },
          memoryDatabase(state),
        ),
      ).resolves.toBeNull();
      await expect(
        claimKnowledgeBaseOpenRecoveryBuild(
          {
            buildId,
            expectedGeneration: 1,
            expectedStateEpoch: build.stateEpoch,
            expectedTaskId: taskId,
            now: new Date("2026-08-02T00:00:00.000Z"),
          },
          memoryDatabase(state),
        ),
      ).resolves.toBeNull();
      assertFrozen();
    } finally {
      dependencies.assertKnowledgeBaseWritable
        .mockReset()
        .mockResolvedValue(undefined);
      dependencies.getCredentialForUpstreamResource
        .mockReset()
        .mockResolvedValue({
          id: "credential-e2e",
          apiKey: "sk-e2e-only",
        });
      providerGet.mockRestore();
      providerPost.mockRestore();
      providerPut.mockRestore();
      providerDelete.mockRestore();
      await close(listener.server);
    }
  });
});
