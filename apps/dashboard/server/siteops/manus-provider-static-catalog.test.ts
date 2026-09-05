import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { VisualSelectionBundleV7 } from "../../shared/siteops";
import {
  canonicalSiteContentPlanSha256,
  siteContentPlanV2FromWire,
} from "../../shared/siteops-content-plan";
import { canonicalJson } from "../../shared/siteops-workflow";
import { ManusV2ApiError } from "../manus-v2-client";
import { siteOpsArtifactIdForIdempotency } from "./artifact-store";
import { knowledgeCoverageInventoryFromSnapshot } from "./site-content-plan";
import {
  FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_VERSION,
  NATIVE_RUNTIME_ROUTE_MODULE,
} from "./native-react-source";

const catalogMocks = vi.hoisted(() => ({
  requireActiveStaticTemplateCatalog: vi.fn(),
  requireStaticTemplateCatalogVersion: vi.fn(),
  openStaticTemplateCatalogVersionSource: vi.fn(),
  staticTemplateAdmissionEvidenceSha256: vi.fn(
    (input: { rawSourceSha256: string }) => input.rawSourceSha256,
  ),
}));

// This unit exercises catalog selection and transport only. Keep heavyweight
// browser build runtimes out of the module graph so it can run without a
// Playwright browser installation.
vi.mock("./build-runtime", () => ({}));
vi.mock("./native-react-build-runtime", () => ({
  NativeReactBuildError: class NativeReactBuildError extends Error {
    constructor(
      readonly code: string,
      readonly diagnostics: readonly {
        code: string;
        file: string | null;
        line: number | null;
        column: number | null;
      }[] = [],
    ) {
      super(code);
      this.name = "NativeReactBuildError";
    }
  },
}));
vi.mock("./native-visual-source", () => ({
  SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION: "2.7.0",
  SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION: "2.5.0",
  SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION: "2.8.0",
  VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE:
    "application/vnd.frontmind.visual-selection-bundle-v5+zip",
  VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES: 192 * 1024 * 1024,
  VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES: 52 * 1024 * 1024,
}));

vi.mock("./static-template-catalog", () => ({
  STATIC_TEMPLATE_SOURCE_MAX_BYTES: 192 * 1024 * 1024,
  requireActiveStaticTemplateCatalog:
    catalogMocks.requireActiveStaticTemplateCatalog,
  requireStaticTemplateCatalogVersion:
    catalogMocks.requireStaticTemplateCatalogVersion,
  openStaticTemplateCatalogVersionSource:
    catalogMocks.openStaticTemplateCatalogVersionSource,
  staticTemplateAdmissionEvidenceSha256:
    catalogMocks.staticTemplateAdmissionEvidenceSha256,
}));

import {
  createNativeSourceRuntimeRegistry,
  createManusSiteOpsProviderHandler,
  nativeSourcePrompt,
  nativeSourceSystemPromptForWorkflow,
  nativeTemplateCoordinateDirective,
  selectedStaticNativeSourceArchive,
  type NativeSourceRuntimeRegistry,
  type NativeSourceRuntimeRegistryEntry,
} from "./manus-provider";
import { NativeReactBuildError } from "./native-react-build-runtime";

const HASH = "a".repeat(64);
const PREVIEW_HASH = "b".repeat(64);
const COMMIT = "c".repeat(40);
const CATALOG_VERSION = "frontmind-static-template-catalog-v1";

function candidate(
  index: number,
  source: { bytes: number; sha256: string } = {
    bytes: 64 * 1024 * 1024,
    sha256: HASH,
  },
) {
  const order = index + 1;
  const catalogCandidateId = `static-template-${String(order).padStart(2, "0")}-template-${order}`;
  const rawSourceSha256 = createHash("sha256")
    .update(`raw-static-source-${order}`, "utf8")
    .digest("hex");
  const evidenceHash = (kind: string) =>
    createHash("sha256")
      .update(`${kind}:${catalogCandidateId}`, "utf8")
      .digest("hex");
  return {
    id: `sample-${order}`,
    sampleId: `sample-${order}`,
    label: String.fromCharCode(65 + index),
    title: `Template ${order}`,
    description: null,
    catalogVersion: CATALOG_VERSION,
    catalogPosition: order,
    catalogCandidateId,
    providerTemplateId: `provider/template-${order}`,
    providerSlug: `template-${order}`,
    providerVersion: COMMIT,
    sourceOwner: "provider",
    sourceRepo: "templates",
    sourceCommitSha: COMMIT,
    sourceSubdirectory: `templates/template-${order}`,
    sourceLicense: "MIT" as const,
    sourceAssetId: `${CATALOG_VERSION}/source/${catalogCandidateId}`,
    sourceArchiveSha256: source.sha256,
    sourceArchiveBytes: source.bytes,
    previewAssetId: `${CATALOG_VERSION}/preview/${catalogCandidateId}`,
    previewSha256: PREVIEW_HASH,
    previewMimeType: "image/png" as const,
    previewWidth: 1440,
    previewHeight: 900,
    executionAdmission: {
      status: "admitted" as const,
      rawSourceSha256,
      normalizedSourceSha256: source.sha256,
      sourceTreeSha256: evidenceHash("tree"),
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      deliveryContractSha256: evidenceHash("delivery-contract"),
      distSha256: evidenceHash("dist"),
      qaSha256: evidenceHash("qa"),
      browserReceiptSha256: evidenceHash("browser"),
      qaStatus: "passed" as const,
      admissionEvidenceSha256: rawSourceSha256,
    },
  };
}

function bundle(
  workflowVersion: "2.8.0" | "2.9.0" = "2.8.0",
): VisualSelectionBundleV7 {
  return {
    schemaVersion: 7,
    renderer: "frontmind_static_template_catalog_v1",
    workflowVersion,
    catalogVersion: CATALOG_VERSION,
    pageNumber: 1,
    pageSize: 8,
    pageCount: 4,
    displayTarget: 8,
    candidates: Array.from({ length: 8 }, (_, index) => ({
      ...candidate(index, {
        bytes: 64 * 1024 * 1024,
        sha256:
          index === 0
            ? HASH
            : createHash("sha256")
                .update(`static-source-${index}`, "utf8")
                .digest("hex"),
      }),
      previewSha256:
        index === 0
          ? PREVIEW_HASH
          : createHash("sha256")
              .update(`static-preview-${index}`, "utf8")
              .digest("hex"),
    })),
    selectedCandidateId: null,
    delegated: false,
    degradedReasons: [],
  };
}

function entryFor(selected: ReturnType<typeof candidate>) {
  const admission = selected.executionAdmission;
  return {
    order: selected.catalogPosition,
    page: 1,
    pageIndex: selected.catalogPosition - 1,
    candidateId: selected.catalogCandidateId,
    providerTemplateId: selected.providerTemplateId,
    providerSlug: selected.providerSlug,
    providerName: selected.title,
    providerDescription: selected.title,
    providerVersion: selected.providerVersion,
    sourceOwner: selected.sourceOwner,
    sourceRepo: selected.sourceRepo,
    sourceCommitSha: selected.sourceCommitSha,
    sourceSubdirectory: selected.sourceSubdirectory,
    sourceLicense: selected.sourceLicense,
    rawSourceAssetId: `${CATALOG_VERSION}/raw-source/${selected.catalogCandidateId}`,
    rawSourcePath: `raw-sources/${selected.catalogCandidateId}.zip`,
    rawSourceSha256: admission.rawSourceSha256,
    rawSourceBytes: selected.sourceArchiveBytes + 1,
    rawSourceFileCount: 110,
    rawSourceExpandedBytes: 130 * 1024 * 1024,
    sourceAssetId: selected.sourceAssetId,
    sourcePath: `sources/${selected.catalogCandidateId}.zip`,
    sourceSha256: selected.sourceArchiveSha256,
    sourceBytes: selected.sourceArchiveBytes,
    sourceFileCount: 100,
    sourceExpandedBytes: 128 * 1024 * 1024,
    previewAssetId: selected.previewAssetId,
    previewPath: `previews/${selected.catalogCandidateId}.png`,
    previewSha256: selected.previewSha256,
    previewBytes: 1_024,
    previewMimeType: selected.previewMimeType,
    previewWidth: selected.previewWidth,
    previewHeight: selected.previewHeight,
    tags: [],
    executionAdmission: {
      status: "admitted" as const,
      binding: {
        catalogVersion: selected.catalogVersion,
        candidateId: selected.catalogCandidateId,
        rawSourceSha256: admission.rawSourceSha256,
      },
      framework: "vite_react" as const,
      normalizedSourceAssetId: selected.sourceAssetId,
      normalizedSourcePath: `sources/${selected.catalogCandidateId}.zip`,
      normalizedSourceSha256: selected.sourceArchiveSha256,
      normalizedSourceBytes: selected.sourceArchiveBytes,
      normalizedSourceFileCount: 100,
      normalizedSourceExpandedBytes: 128 * 1024 * 1024,
      sourceTreeSha256: admission.sourceTreeSha256,
      runtimeContractSha256: admission.runtimeContractSha256,
      executionShellSha256: admission.executionShellSha256,
      deliveryContractAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/delivery-contract`,
      deliveryContractPath: `admissions/${selected.catalogCandidateId}/delivery-contract.json`,
      deliveryContractSha256: admission.deliveryContractSha256,
      deliveryContractBytes: 1024,
      distAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/dist`,
      distPath: `admissions/${selected.catalogCandidateId}/dist.zip`,
      distSha256: admission.distSha256,
      distBytes: 2048,
      qaAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/qa`,
      qaPath: `admissions/${selected.catalogCandidateId}/qa.json`,
      qaSha256: admission.qaSha256,
      qaBytes: 1024,
      browserReceiptAssetId: `${selected.catalogVersion}/admission/${selected.catalogCandidateId}/browser`,
      browserReceiptPath: `admissions/${selected.catalogCandidateId}/browser.json`,
      browserReceiptSha256: admission.browserReceiptSha256,
      browserReceiptBytes: 1024,
      qaStatus: admission.qaStatus,
      admissionEvidenceSha256: admission.admissionEvidenceSha256,
    },
  };
}

const temporaryRoots: string[] = [];

async function sha256File(sourcePath: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(sourcePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function testRuntimeEntry(label: "a" | "b"): NativeSourceRuntimeRegistryEntry {
  const hash = (kind: string) =>
    createHash("sha256").update(`${label}:${kind}`, "utf8").digest("hex");
  const coordinates = {
    contractVersion: `test-runtime-contract-${label}`,
    contractSha256: hash("contract"),
    executionShellVersion: `test-runtime-shell-${label}`,
    executionShellSha256: hash("shell"),
    preflightVersion: `test-runtime-preflight-${label}`,
    preflightSha256: hash("preflight"),
  };
  return {
    coordinates,
    attachments: ["contract", "shell", "preflight"].map((kind) => ({
      filename: `runtime-${label}-${kind}.json`,
      mime_type: "application/json",
      file_data: `data:application/json;base64,${Buffer.from(`${label}:${kind}`).toString("base64")}`,
    })),
    receiptSchema: z
      .object({
        operationToken: z.string(),
        baseSourceSha256: z.string(),
        archiveSha256: z.string(),
        fileCount: z.number().int(),
        preflightVersion: z.literal(coordinates.preflightVersion),
        preflightStatus: z.literal("passed"),
        preflightSha256: z.literal(coordinates.preflightSha256),
        runtimeContractVersion: z.literal(coordinates.contractVersion),
        runtimeContractSha256: z.literal(coordinates.contractSha256),
        executionShellSha256: z.literal(coordinates.executionShellSha256),
        executionBaselineSha256: z.string(),
        contentPlanSha256: z.string().optional(),
      })
      .strict(),
    validate: vi.fn(async () => {
      throw new Error("TEST_RUNTIME_VALIDATOR_MUST_NOT_RUN");
    }),
    audit: vi.fn(() => ({ ok: true, issues: [] })),
  };
}

function nativeResultEvents(input: {
  operationToken: string;
  receipt: Record<string, unknown>;
  archive: Buffer;
}) {
  const timestamp = Date.now();
  return [
    {
      id: `marker:${input.operationToken}`,
      type: "user_message",
      timestamp,
      user_message: {
        content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: input.operationToken })}`,
      },
    },
    {
      id: `receipt:${input.operationToken}`,
      type: "structured_output_result",
      timestamp: timestamp + 1,
      structured_output_result: { success: true, value: input.receipt },
    },
    {
      id: `source:${input.operationToken}`,
      type: "assistant_message",
      timestamp: timestamp + 2,
      assistant_message: {
        content: "source",
        attachments: [
          {
            filename: FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
            content_type: "application/zip",
            url: `data:application/zip;base64,${input.archive.toString("base64")}`,
          },
        ],
      },
    },
    {
      id: `stopped:${input.operationToken}`,
      type: "status_update",
      timestamp: timestamp + 3,
      status_update: { agent_status: "stopped" },
    },
  ];
}

async function createProviderHarness(input: {
  sourcePath: string;
  sourceBytes: number;
  sourceSha256: string;
  failCreateUnknownOnce?: boolean;
  createOutcomeUnknownOnce?: boolean;
  createRetryableOnce?: boolean;
  sendOutcomeUnknownOnce?: boolean;
  sendRetryableOnce?: boolean;
  feedback?: string;
  nativeSourceRuntimeRegistry?: NativeSourceRuntimeRegistry;
  materializeNativeSite?: (input: any) => Promise<any>;
  persistArtifact?: (input: any) => Promise<any>;
  workflowVersion?: "2.8.0" | "2.9.0";
  extraArtifacts?: Map<
    string,
    { bytes: Buffer; mimeType: "application/json" | "application/zip" }
  >;
}) {
  const selected = candidate(0, {
    bytes: input.sourceBytes,
    sha256: input.sourceSha256,
  });
  const staticBundle = bundle(input.workflowVersion);
  staticBundle.candidates[0] = selected;
  const entry = entryFor(selected);
  catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
    catalogVersion: CATALOG_VERSION,
    entries: [entry],
  });
  catalogMocks.openStaticTemplateCatalogVersionSource.mockImplementation(
    async () => ({
      entry,
      path: input.sourcePath,
      stream: createReadStream(input.sourcePath),
    }),
  );

  const selectionBytes = Buffer.from(JSON.stringify(staticBundle), "utf8");
  const selectionSha256 = createHash("sha256")
    .update(selectionBytes)
    .digest("hex");
  const snapshotBytes = Buffer.from("x", "utf8");
  const snapshotSha256 = createHash("sha256")
    .update(snapshotBytes)
    .digest("hex");
  const operation = {
    id: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000002",
    userId: 7,
    conversationTurnId: null,
    buildId: "30000000-0000-4000-8000-000000000003",
    kind: "site_build",
    status: "running",
    clientRequestId: "request-static-template",
    inputHash: "d".repeat(64),
    input: {
      credentialScope: "customer",
      buildId: "30000000-0000-4000-8000-000000000003",
      manusCredentialId: "40000000-0000-4000-8000-000000000004",
      manusCredentialVersion: 9,
      agentProfile: "frontmind-base",
      ...(input.feedback ? { feedback: input.feedback } : {}),
    },
    provider: "manus",
    providerOperationId: null,
    providerTaskId: null,
    leaseOwner: "lease-static-template",
    leaseExpiresAt: new Date(Date.now() + 12 * 60_000),
    attempt: 1,
    result: null,
    errorCode: null,
    errorMessage: null,
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;
  const brief = {
    companyName: "星河智造",
    primaryLanguage: "zh-CN",
    contacts: [],
    offerings: ["设备服务"],
    audience: ["制造企业"],
    conversionGoal: "联系咨询",
    routes: [
      {
        id: "home",
        slug: "/",
        title: "首页",
        sourceDocumentIds: ["overview"],
      },
    ],
    verifiedFacts: [
      {
        statement: "星河智造提供设备服务。",
        sourceDocumentIds: ["overview"],
      },
    ],
    publicAssetIds: [],
    unknowns: [],
  };
  const context = {
    build: {
      id: operation.buildId,
      projectId: operation.projectId,
      userId: operation.userId,
      knowledgeSnapshotId: "50000000-0000-4000-8000-000000000005",
      knowledgeArchiveHash: snapshotSha256,
      workflowVersion: input.workflowVersion ?? "2.8.0",
      brief,
      selectionHash: createHash("sha256")
        .update("static-selection", "utf8")
        .digest("hex"),
      repairAttempts: 0,
      parentBuildId: null,
      upstreamManusTaskId: null as string | null,
      contractLocalAssetId: null,
      sourceLocalAssetId: null,
      distLocalAssetId: null,
      qaLocalAssetId: null,
      provenanceLocalAssetId: null,
      contentPlanLocalAssetId: null as string | null,
      contentPlanSha256: null as string | null,
      status: "queued",
    },
    project: { id: operation.projectId },
    snapshot: {
      id: "50000000-0000-4000-8000-000000000005",
      userId: operation.userId,
      archiveHash: snapshotSha256,
      totalBytes: snapshotBytes.length,
      sourceBuildId: null,
      sourceBuildRevision: null,
      assets: [],
      documents: [
        {
          id: "overview",
          path: "overview.md",
          title: "企业简介",
          content: "星河智造提供设备服务。",
          kind: "leaf" as const,
          evidenceStatus: "verified_first_party" as const,
          customerVisible: true,
        },
      ],
    },
    sample: {
      id: selected.id,
      batchId: "70000000-0000-4000-8000-000000000007",
      previewLocalAssetId: null,
      sourceMetadata: {
        schemaVersion: 7,
        renderer: staticBundle.renderer,
        workflowVersion: staticBundle.workflowVersion,
        ...selected,
      },
    },
    batch: {
      selectionBundleLocalAssetId: "90000000-0000-4000-8000-000000000009",
      selectionBundleHash: selectionSha256,
    },
  };
  const query: any = {};
  query.from = () => query;
  query.innerJoin = () => query;
  query.where = () => query;
  query.limit = async () => [context];
  let persistedOperationResult: unknown = null;
  let failCreateUnknownOnce = input.failCreateUnknownOnce ?? false;
  const db = {
    select: () => query,
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if ("result" in values) {
            const state = values.result as { stage?: string };
            if (failCreateUnknownOnce && state.stage === "create_unknown") {
              failCreateUnknownOnce = false;
              throw new Error("SITEOPS_OPERATION_LEASE_LOST");
            }
            persistedOperationResult = values.result;
          } else {
            Object.assign(context.build, values);
          }
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  };
  const uploadFile = vi.fn(async () => ({
    fileId: "provider-static-source",
    detail: { expiresAt: Math.floor(Date.now() / 1_000) + 60 * 60 },
  }));
  let createOutcomeUnknownOnce = input.createOutcomeUnknownOnce ?? false;
  let createRetryableOnce = input.createRetryableOnce ?? false;
  const createTask = vi.fn(async () => {
    if (createOutcomeUnknownOnce) {
      createOutcomeUnknownOnce = false;
      throw new ManusV2ApiError(
        "task.create",
        null,
        "TRANSPORT_UNKNOWN",
        true,
        true,
      );
    }
    if (createRetryableOnce) {
      createRetryableOnce = false;
      throw new ManusV2ApiError(
        "task.create",
        429,
        "HTTP_429",
        true,
        false,
        null,
        25_000,
      );
    }
    return { taskId: "static-manus-task" };
  });
  const findCreatedTask = vi.fn(async () => {
    const task = { id: "static-manus-task" };
    return {
      candidates: [task],
      matches: [task],
      unresolved: [],
      unresolvedEvidenceCount: 0,
      unique: task,
    };
  });
  let sendOutcomeUnknownOnce = input.sendOutcomeUnknownOnce ?? false;
  let sendRetryableOnce = input.sendRetryableOnce ?? false;
  const sendMessage = vi.fn(async () => {
    if (sendOutcomeUnknownOnce) {
      sendOutcomeUnknownOnce = false;
      throw new ManusV2ApiError(
        "task.sendMessage",
        null,
        "TRANSPORT_UNKNOWN",
        true,
        true,
      );
    }
    if (sendRetryableOnce) {
      sendRetryableOnce = false;
      throw new ManusV2ApiError(
        "task.sendMessage",
        429,
        "HTTP_429",
        true,
        false,
        null,
        25_000,
      );
    }
  });
  const client = {
    uploadFile,
    createTask,
    sendMessage,
    findCreatedTask,
    taskDetail: vi.fn(async () => ({ status: "running" })),
    listAllMessages: vi.fn(async () => []),
  };
  const handler = createManusSiteOpsProviderHandler({
    getDb: async () => db as never,
    getCredential: async () => ({
      id: operation.input.manusCredentialId,
      userId: operation.userId,
      version: operation.input.manusCredentialVersion,
      apiKey: "customer-personal-key",
    }),
    createClient: () => client as never,
    readSnapshotArchive: async () => snapshotBytes,
    readArtifact: async (artifactInput) => {
      const extra = input.extraArtifacts?.get(artifactInput.localAssetId);
      if (extra) {
        return {
          row: {
            id: artifactInput.localAssetId,
            scope: "managed_user",
            accountUserId: operation.userId,
            storageKey: `siteops:${operation.projectId}:fixture:${artifactInput.localAssetId}`,
            mimeType: extra.mimeType,
            contentSha256: createHash("sha256")
              .update(extra.bytes)
              .digest("hex"),
            sizeBytes: extra.bytes.length,
          },
          stored: {
            sizeBytes: extra.bytes.length,
            createReadStream: () => Readable.from([extra.bytes]),
          },
        } as never;
      }
      return (
        artifactInput.localAssetId === context.batch.selectionBundleLocalAssetId
          ? {
              row: {
                id: context.batch.selectionBundleLocalAssetId,
                scope: "managed_user",
                accountUserId: operation.userId,
                storageKey: `siteops:${operation.projectId}:static-selection`,
                mimeType: "application/json",
                contentSha256: selectionSha256,
                sizeBytes: selectionBytes.length,
              },
              stored: {
                sizeBytes: selectionBytes.length,
                createReadStream: () => Readable.from([selectionBytes]),
              },
            }
          : null
      ) as never;
    },
    materializeSite: vi.fn() as never,
    materializeNativeSite: (input.materializeNativeSite ?? vi.fn()) as never,
    materializeNativeTrustedFallbackSite: vi.fn() as never,
    persistArtifact: (input.persistArtifact ?? vi.fn()) as never,
    generateSocial: vi.fn() as never,
    ...(input.nativeSourceRuntimeRegistry
      ? { nativeSourceRuntimeRegistry: input.nativeSourceRuntimeRegistry }
      : {}),
  });
  return {
    client,
    context,
    createTask,
    getPersistedOperationResult: () => persistedOperationResult,
    handler,
    operation,
    selected,
    uploadFile,
  };
}

async function createDynamicReceiptHarness(input?: {
  materializeNativeSite?: (value: any) => Promise<any>;
  persistArtifact?: (value: any) => Promise<any>;
}) {
  const sourceBytes = Buffer.from("verified-dynamic-template", "utf8");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v29-receipt-"));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, "template.zip");
  const handle = await open(sourcePath, "w");
  await handle.writeFile(sourceBytes);
  await handle.close();
  const extraArtifacts = new Map<
    string,
    { bytes: Buffer; mimeType: "application/json" | "application/zip" }
  >();
  const runtime = testRuntimeEntry("a");
  const harness = await createProviderHarness({
    sourcePath,
    sourceBytes: sourceBytes.length,
    sourceSha256,
    workflowVersion: "2.9.0",
    extraArtifacts,
    materializeNativeSite: input?.materializeNativeSite,
    persistArtifact: input?.persistArtifact,
    nativeSourceRuntimeRegistry: createNativeSourceRuntimeRegistry({
      current: runtime,
    }),
  });
  const inventory = knowledgeCoverageInventoryFromSnapshot(
    harness.context.snapshot as never,
  );
  const inventorySha256 = canonicalSiteContentPlanSha256(inventory);
  const planOperationToken = `siteops-content-plan:${harness.operation.id}:0`;
  const plan = siteContentPlanV2FromWire(
    {
      wireSchemaVersion: 2,
      operationToken: planOperationToken,
      inventorySha256,
      routes: [
        {
          routeId: "home",
          path: "/",
          title: "首页",
          navigation: "primary",
          parentPath: null,
          detailOfPath: null,
          purpose: "介绍企业",
          userQuestions: ["企业提供什么？"],
          h1: "星河智造",
          summary: "可信的设备服务。",
          ctaLabel: null,
          ctaTargetPath: null,
        },
      ],
      sections: [
        {
          routeId: "home",
          sectionId: "overview",
          blockKind: "prose",
          heading: "企业简介",
          purpose: "呈现企业事实",
          body: "星河智造提供设备服务。",
          sourceDocumentIds: ["overview"],
          evidenceExcerpts: ["星河智造提供设备服务。"],
          mediaIds: [],
          entityIds: [],
          faqIds: [],
        },
      ],
      navigation: [{ label: "首页", targetPath: "/" }],
      coverage: [
        {
          sourceDocumentId: "overview",
          status: "used",
          routeIds: ["home"],
          omissionReason: null,
        },
      ],
    },
    { operationToken: planOperationToken, inventorySha256 },
  );
  const planBytes = Buffer.from(`${canonicalJson(plan)}\n`, "utf8");
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const planLocalAssetId = "61000000-0000-4000-8000-000000000006";
  extraArtifacts.set(planLocalAssetId, {
    bytes: planBytes,
    mimeType: "application/json",
  });
  const taskId = "dynamic-manus-task";
  harness.context.build.upstreamManusTaskId = taskId;
  harness.context.build.contentPlanLocalAssetId = planLocalAssetId;
  harness.context.build.contentPlanSha256 = planSha256;
  const state = {
    schemaVersion: 2,
    stage: "native_source_send_ready",
    taskId,
    attempts: { extraction: 0, design: 0, content: 0, materialization: 0 },
    nativeSourceContractVersion: 2,
    nativeSourceRuntimeCoordinates: runtime.coordinates,
    nativeRepairAttempt: 0,
    contentPlanAttempt: 0,
    contentPlanOperationToken: planOperationToken,
    contentPlanInventorySha256: inventorySha256,
    contentPlanLocalAssetId: planLocalAssetId,
    contentPlanSha256: planSha256,
    buildPhase: "source_waiting",
  } as const;
  return { harness, planSha256, runtime, sourceSha256, state, taskId };
}

async function createDynamicPlanningHarness() {
  const sourceBytes = Buffer.from("verified-dynamic-planning-template", "utf8");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v29-plan-"));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, "template.zip");
  const handle = await open(sourcePath, "w");
  await handle.writeFile(sourceBytes);
  await handle.close();
  return createProviderHarness({
    sourcePath,
    sourceBytes: sourceBytes.length,
    sourceSha256,
    workflowVersion: "2.9.0",
    nativeSourceRuntimeRegistry: createNativeSourceRuntimeRegistry({
      current: testRuntimeEntry("a"),
    }),
  });
}

function decodeInlineJsonAttachment(
  attachments: readonly Record<string, unknown>[],
  filename: string,
) {
  const attachment = attachments.find((item) => item.filename === filename);
  expect(attachment).toBeDefined();
  expect(attachment).not.toHaveProperty("file_id");
  expect(attachment?.mime_type).toBe("application/json");
  const fileData = String(attachment?.file_data ?? "");
  expect(fileData).toMatch(/^data:application\/json;base64,/u);
  return JSON.parse(
    Buffer.from(fileData.split(",", 2)[1]!, "base64").toString("utf8"),
  ) as Record<string, any>;
}

async function createNativeNoOutputHarness() {
  const { harness, state, taskId } = await createDynamicReceiptHarness();
  const created = await harness.handler({
    operation: {
      ...harness.operation,
      providerTaskId: taskId,
      result: state,
    } as never,
    signal: new AbortController().signal,
    assertLeaseActive: async () => undefined,
  });
  return {
    harness,
    created,
    taskId,
    initialSendCount: harness.client.sendMessage.mock.calls.length,
    operationToken: `siteops-native-source:${harness.operation.id}:0`,
  };
}

function nativeWaitingWithoutOutputEvents(input: {
  operationToken: string;
  waitingEventId: string;
  waitingEventType: string;
}) {
  return [
    {
      id: `marker:${input.operationToken}`,
      type: "user_message",
      timestamp: 1,
      user_message: {
        content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: input.operationToken })}`,
      },
    },
    {
      id: `waiting:${input.waitingEventId}`,
      type: "status_update",
      timestamp: 2,
      status_update: {
        agent_status: "waiting",
        status_detail: {
          waiting_for_event_id: input.waitingEventId,
          waiting_for_event_type: input.waitingEventType,
        },
      },
    },
  ];
}

function nativeTerminalWithoutOutputEvents(
  operationToken: string,
  status: "stopped" | "failed",
) {
  return [
    {
      id: `marker:${operationToken}`,
      type: "user_message",
      timestamp: 1,
      user_message: {
        content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
      },
    },
    {
      id: `${status}:${operationToken}`,
      type: "status_update",
      timestamp: 2,
      status_update: { agent_status: status },
    },
  ];
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("V7 static Template Manus source", () => {
  it("sends the exact dynamically bound flat content-plan contract on initial planning", async () => {
    const harness = await createDynamicPlanningHarness();
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      harness.context.snapshot as never,
    );
    const inventorySha256 = canonicalSiteContentPlanSha256(inventory);
    const operationToken = `siteops-content-plan:${harness.operation.id}:0`;

    const result = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        stage: "content_plan_pending",
        contentPlanOperationToken: operationToken,
        contentPlanInventorySha256: inventorySha256,
      },
    });
    const createInput = harness.createTask.mock.calls[0]![0] as any;
    expect(Array.from(createInput.prompt).length).toBeLessThanOrEqual(3_000);
    expect(createInput.prompt).toContain(
      "顶层仅允许 wireSchemaVersion、operationToken、inventorySha256、routes、sections、navigation、coverage",
    );
    expect(createInput.prompt).toContain("routes 内绝对不得嵌套 sections");
    expect(createInput.prompt).toContain(
      "每个 section（包括 hero、CTA 和纯结构区块）的 sourceDocumentIds 与 evidenceExcerpts 都必须至少各有一项",
    );
    expect(createInput.prompt).toContain("section 的来源与摘录数组不得为空");
    expect(createInput.prompt).toContain("不得使用 schemaVersion、pages");
    const contract = decodeInlineJsonAttachment(
      createInput.attachments,
      "frontmind-site-content-plan-wire-v2-contract.json",
    );
    expect(contract).toMatchObject({
      contractName: "SiteContentPlanWireV2",
      contractRevision: 2,
      outputFilename: "frontmind-site-content-plan-v2.json",
      coordinates: {
        operationToken,
        inventorySha256,
        sourceDocumentIds: ["overview"],
      },
      shapeRules: {
        exactTopLevelFields: [
          "wireSchemaVersion",
          "operationToken",
          "inventorySha256",
          "routes",
          "sections",
          "navigation",
          "coverage",
        ],
        sectionsAreTopLevelAndFlat: true,
        everySectionHasAtLeastOneVerbatimSource: true,
        everySourceDocumentMustAppearExactlyOnceInCoverage: true,
        additionalPropertiesAllowed: false,
      },
    });
    expect(Object.keys(contract.jsonSchema.properties)).toEqual([
      "coverage",
      "inventorySha256",
      "navigation",
      "operationToken",
      "routes",
      "sections",
      "wireSchemaVersion",
    ]);
    expect(contract.jsonSchema.properties.operationToken.enum).toEqual([
      operationToken,
    ]);
    expect(contract.jsonSchema.properties.inventorySha256.enum).toEqual([
      inventorySha256,
    ]);
    expect(
      contract.jsonSchema.properties.coverage.items.properties.sourceDocumentId,
    ).toEqual({ type: "string" });
    expect(
      contract.jsonSchema.properties.sections.items.properties.sourceDocumentIds
        .items,
    ).toEqual({ type: "string" });
    expect(
      contract.jsonSchema.properties.routes.items.properties,
    ).not.toHaveProperty("sections");
    expect(contract.jsonSchema).toEqual(createInput.structuredOutputSchema);
  });

  it("rebinds the same exact content-plan contract to the one repair operation", async () => {
    const harness = await createDynamicPlanningHarness();
    const initial = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      harness.context.snapshot as never,
    );
    const inventorySha256 = canonicalSiteContentPlanSha256(inventory);
    const repairToken = `siteops-content-plan:${harness.operation.id}:1`;

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: "static-manus-task",
        result: {
          ...(initial.result as Record<string, unknown>),
          stage: "content_plan_repair_send_ready",
          taskId: "static-manus-task",
          contentPlanAttempt: 1,
          contentPlanOperationToken: repairToken,
          providerNextPollAt: undefined,
        },
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        stage: "content_plan_repair_pending",
        contentPlanOperationToken: repairToken,
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    const sendInput = harness.client.sendMessage.mock.calls[0]![0] as any;
    expect(sendInput.prompt).toContain("上一份计划未通过严格合同");
    expect(sendInput.prompt).toContain(
      `operationToken 必须精确为 ${repairToken}`,
    );
    const contract = decodeInlineJsonAttachment(
      sendInput.attachments,
      "frontmind-site-content-plan-wire-v2-contract.json",
    );
    expect(contract.coordinates).toEqual({
      operationToken: repairToken,
      inventorySha256,
      sourceDocumentIds: ["overview"],
    });
    expect(contract.jsonSchema.properties.operationToken.enum).toEqual([
      repairToken,
    ]);
    expect(contract.jsonSchema.properties.inventorySha256.enum).toEqual([
      inventorySha256,
    ]);
    expect(contract.jsonSchema).toEqual(sendInput.structuredOutputSchema);
  });

  it("sends the assistant JSON section-source diagnostic instead of the rejected structured placeholder", async () => {
    const harness = await createDynamicPlanningHarness();
    const initial = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const inventory = knowledgeCoverageInventoryFromSnapshot(
      harness.context.snapshot as never,
    );
    const inventorySha256 = canonicalSiteContentPlanSha256(inventory);
    const operationToken = `siteops-content-plan:${harness.operation.id}:0`;
    const placeholder = {
      wireSchemaVersion: 2,
      operationToken,
      inventorySha256,
      routes: [],
      sections: [],
      navigation: [],
      coverage: [],
    };
    const assistantPlan = {
      wireSchemaVersion: 2,
      operationToken,
      inventorySha256,
      routes: [
        {
          routeId: "home",
          path: "/",
          title: "首页",
          navigation: "primary",
          parentPath: null,
          detailOfPath: null,
          purpose: "介绍企业",
          userQuestions: ["企业提供什么？"],
          h1: "星河智造",
          summary: "可信的设备服务。",
          ctaLabel: null,
          ctaTargetPath: null,
        },
      ],
      sections: [
        {
          routeId: "home",
          sectionId: "cta",
          blockKind: "cta",
          heading: "了解服务",
          purpose: "引导咨询",
          body: "了解设备服务。",
          sourceDocumentIds: [],
          evidenceExcerpts: [],
          mediaIds: [],
          entityIds: [],
          faqIds: [],
        },
      ],
      navigation: [{ label: "首页", targetPath: "/" }],
      coverage: [
        {
          sourceDocumentId: "overview",
          status: "used",
          routeIds: ["home"],
          omissionReason: null,
        },
      ],
    };
    harness.client.listAllMessages.mockResolvedValue([
      {
        id: "plan-marker",
        type: "user_message",
        timestamp: 1,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
        },
      },
      {
        id: "plan-structured-placeholder",
        type: "structured_output_result",
        timestamp: 2,
        structured_output_result: {
          success: false,
          error: "Failed to extract structured output",
          value: placeholder,
        },
      },
      {
        id: "plan-assistant-json",
        type: "assistant_message",
        timestamp: 3,
        assistant_message: { content: JSON.stringify(assistantPlan) },
      },
    ] as never);

    const repaired = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: "static-manus-task",
        result: initial.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(repaired).toMatchObject({
      status: "pending",
      result: { stage: "content_plan_repair_pending" },
    });
    const sendInput = harness.client.sendMessage.mock.calls[0]![0] as any;
    expect(sendInput.prompt).toContain(
      "CONTENT_PLAN_SCHEMA_TOO_SMALL@sections.0.sourceDocumentIds",
    );
    expect(sendInput.prompt).toContain(
      "CONTENT_PLAN_SCHEMA_TOO_SMALL@sections.0.evidenceExcerpts",
    );
    expect(sendInput.prompt).not.toContain(
      "CONTENT_PLAN_SCHEMA_TOO_SMALL@routes",
    );
  });

  it("freezes the 2.9 content plan SHA in the initial source prompt and receipt", async () => {
    expect(nativeSourceSystemPromptForWorkflow("2.9.0")).toContain(
      "frontmind-site-content-plan-v2.json",
    );
    expect(nativeSourceSystemPromptForWorkflow("2.9.0")).toContain(
      "每个包含 JSX 的模块都必须显式绑定或 import React",
    );
    expect(nativeSourceSystemPromptForWorkflow("2.9.0")).toContain(
      "无 pageerror、console.error 和空白 root",
    );
    expect(nativeSourceSystemPromptForWorkflow("2.9.0")).toContain(
      "window.canonicalSitePathname()",
    );
    expect(nativeSourceSystemPromptForWorkflow("2.9.0")).toContain(
      "回退 window.location.pathname",
    );
    expect(nativeSourceSystemPromptForWorkflow("2.9.0")).toContain(
      "可见链接文字必须包含计划 cta.label",
    );
    const { harness, planSha256, state, taskId } =
      await createDynamicReceiptHarness();
    const initial = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: state,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(initial).toMatchObject({
      status: "pending",
      result: { stage: "native_source_pending", contentPlanSha256: planSha256 },
    });
    const initialSend = harness.client.sendMessage.mock.calls[0]![0] as any;
    expect(Array.from(initialSend.prompt).length).toBeLessThanOrEqual(3_000);
    expect(initialSend.prompt).toContain(`sha256=${planSha256}`);
    expect(initialSend.structuredOutputSchema.required).toContain(
      "contentPlanSha256",
    );
    expect(
      initialSend.structuredOutputSchema.properties.contentPlanSha256.enum,
    ).toEqual([planSha256]);
  });

  it("keeps a media revision source prompt inside the upstream character budget", () => {
    const prompt = nativeSourcePrompt({
      operationToken:
        "siteops-native-source:30000000-0000-4000-8000-000000000001:0",
      baseSourceSha256: HASH,
      contractVersion: 2,
      workflowVersion: "2.9.0",
      runtimeCoordinates: {
        contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
        contractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
        executionShellVersion: NATIVE_RUNTIME_EXECUTION_SHELL_VERSION,
        executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
        preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
        preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
      },
      hasCustomerFeedback: true,
      hasRevisionMedia: true,
      hasRevisionBaseline: true,
      hasKnowledgeMedia: true,
      templateCoordinateInstruction: "精确模板坐标与入口。".repeat(20),
      contentPlanSha256: PREVIEW_HASH,
    });

    expect(Array.from(prompt).length).toBeLessThanOrEqual(3_000);
  });

  it("freezes the 2.9 content plan SHA in repair prompts and receipts", async () => {
    const { harness, planSha256, state, taskId } =
      await createDynamicReceiptHarness();
    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    const repair = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: {
          ...state,
          stage: "native_repair_send_ready",
          nativeRepairAttempt: 1,
          nativeLastErrorSignature: "f".repeat(64),
          nativeRepairInput: {
            attempt: 1,
            kind: "hard_safety",
            diagnostics: [
              {
                code: "NATIVE_BUILD_CONTENT_PLAN_INVALID",
                file: null,
                line: null,
                column: null,
              },
            ],
          },
          phaseOperationToken: repairToken,
          buildPhase: "source_repairing",
        },
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(repair).toMatchObject({
      status: "pending",
      result: { nativeRepairAttempt: 1, contentPlanSha256: planSha256 },
    });
    const repairSend = harness.client.sendMessage.mock.calls[0]![0] as any;
    expect(repairSend.prompt).toContain(`sha256=${planSha256}`);
    expect(repairSend.prompt).toContain(
      "每个包含 JSX 的模块都必须显式绑定或 import React",
    );
    expect(repairSend.prompt).toContain("允许保留不改变含义的模板装饰");
    expect(repairSend.prompt).toContain(
      "无 pageerror、console.error 或空白 root",
    );
    expect(repairSend.structuredOutputSchema.required).toContain(
      "contentPlanSha256",
    );
    expect(
      repairSend.structuredOutputSchema.properties.contentPlanSha256.enum,
    ).toEqual([planSha256]);
  });

  it("sends a V2 browser render failure back to the same Manus task for bounded repair", async () => {
    const materializeNativeSite = vi.fn(async () => {
      throw new NativeReactBuildError("NATIVE_BUILD_RENDER_FAILED");
    });
    const persistArtifact = vi.fn(async (artifactInput: any) => ({
      id: siteOpsArtifactIdForIdempotency({
        userId: artifactInput.userId,
        projectId: artifactInput.projectId,
        kind: artifactInput.kind,
        idempotencyKey: artifactInput.idempotencyKey,
      }),
      contentSha256: createHash("sha256")
        .update(artifactInput.buffer)
        .digest("hex"),
      sizeBytes: artifactInput.buffer.length,
    }));
    const { harness, planSha256, runtime, sourceSha256, state, taskId } =
      await createDynamicReceiptHarness({
        materializeNativeSite,
        persistArtifact,
      });
    const sourcePending = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: state,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const operationToken = `siteops-native-source:${harness.operation.id}:0`;
    const archive = Buffer.from("render-failed-provider-source", "utf8");
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const receipt = {
      operationToken,
      baseSourceSha256: sourceSha256,
      archiveSha256,
      fileCount: 4,
      preflightVersion: runtime.coordinates.preflightVersion,
      preflightStatus: "passed" as const,
      preflightSha256: runtime.coordinates.preflightSha256,
      runtimeContractVersion: runtime.coordinates.contractVersion,
      runtimeContractSha256: runtime.coordinates.contractSha256,
      executionShellSha256: runtime.coordinates.executionShellSha256,
      executionBaselineSha256: sourceSha256,
      contentPlanSha256: planSha256,
    };
    const files = new Map<string, Buffer>([
      ["package.json", Buffer.from('{"dependencies":{}}', "utf8")],
      ["index.html", Buffer.from('<div id="root"></div>', "utf8")],
      ["src/main.tsx", Buffer.from("export {};", "utf8")],
      [NATIVE_RUNTIME_ROUTE_MODULE, Buffer.from("export {};", "utf8")],
    ]);
    vi.mocked(runtime.validate).mockResolvedValue({
      receipt,
      archiveSha256,
      sourceSha256: archiveSha256,
      sourceZip: archive,
      fileCount: files.size,
      htmlEntrypoint: "index.html",
      entrypoint: "src/main.tsx",
      packageJson: {},
      files,
    } as never);
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeResultEvents({ operationToken, receipt, archive }),
    );

    const repaired = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: sourcePending.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(repaired).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
        buildPhase: "source_repairing",
      },
    });
    expect(materializeNativeSite).toHaveBeenCalledTimes(1);
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(2);
    const repairSend = harness.client.sendMessage.mock.calls[1]![0] as any;
    expect(repairSend.prompt).toContain(
      "每个包含 JSX 的模块都必须显式绑定或 import React",
    );
    const diagnostics = decodeInlineJsonAttachment(
      repairSend.attachments,
      "frontmind-native-runtime-diagnostics-v1.json",
    );
    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      attempt: 1,
      kind: "hard_safety",
      diagnostics: [
        {
          code: "NATIVE_BUILD_RENDER_FAILED",
          file: null,
          line: null,
          column: null,
        },
      ],
    });
  });

  it("adds the static application-capability boundary without changing the Template adaptation contract", () => {
    const prompt = nativeSourceSystemPromptForWorkflow("2.8.0");
    expect(prompt).not.toBe(nativeSourceSystemPromptForWorkflow("2.7.0"));
    expect(prompt).toContain("不得把模板改造成通用卡片站");
    expect(prompt).toContain(
      "不得保留或新增认证、支付、订阅、数据库、管理后台、聊天机器人、外部统计、第三方 webhook、服务端 API 或知识库未要求的其他运行时能力；模板原有此类能力时，必须移除对应入口、表单和误导性 CTA。",
    );
    expect(prompt).toContain("FrontMind 宿主管理的 Vite SPA");
    expect(prompt).toContain(
      "企业 dossier、SiteBrief 和已验证媒体是唯一企业事实来源",
    );
    expect(prompt).toContain("frontmind-native-preflight-v2.mjs");
    const selected = candidate(0);
    const directive = nativeTemplateCoordinateDirective({
      bundle: { schemaVersion: 7 },
      candidate: selected,
    } as never);
    expect(directive).not.toBeNull();
    const encoded = directive!.attachment.file_data.split(",", 2)[1]!;
    const coordinate = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(coordinate).toMatchObject({
      schemaVersion: 1,
      sourceFormat: "static_catalog_archive_v1",
      catalogVersion: CATALOG_VERSION,
      catalogCandidateId: selected.catalogCandidateId,
      sourceAssetId: selected.sourceAssetId,
      providerSlug: selected.providerSlug,
      sourceSubdirectory: selected.sourceSubdirectory,
      sourceArchiveSha256: selected.sourceArchiveSha256,
    });
    expect(coordinate).not.toHaveProperty("entrypoint");
    expect(coordinate).not.toHaveProperty("sourceRoot");
    expect(directive!.promptInstruction).toContain("从源码确定入口");
  });

  it("buffers a verified catalog source only when it is within the 20 MiB inline boundary", async () => {
    const sourceBytes = Buffer.from("verified-small-static-template", "utf8");
    const selected = candidate(0, {
      bytes: sourceBytes.byteLength,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    });
    const entry = entryFor(selected);
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-inline-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
      catalogVersion: CATALOG_VERSION,
      entries: [entry],
    });
    catalogMocks.openStaticTemplateCatalogVersionSource.mockResolvedValue({
      entry,
      path: sourcePath,
      stream: createReadStream(sourcePath),
    });

    const staticBundle = bundle();
    staticBundle.candidates[0] = selected;
    const result = await selectedStaticNativeSourceArchive({
      bundle: staticBundle,
      selectedCandidateId: selected.id,
    });

    expect(result.archiveBytes).toEqual(sourceBytes);
    expect(result.archiveByteLength).toBe(sourceBytes.byteLength);
    expect(result.archiveSha256).toBe(selected.sourceArchiveSha256);
  });

  it("streams the frozen 64 MiB catalog version after active switches and returns fresh streams", async () => {
    const selected = candidate(0);
    const entry = entryFor(selected);
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-source-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.truncate(selected.sourceArchiveBytes);
    await handle.close();
    catalogMocks.requireActiveStaticTemplateCatalog.mockResolvedValue({
      catalogVersion: "future-static-catalog-v2",
      entries: [],
    });
    catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
      catalogVersion: CATALOG_VERSION,
      entries: [entry],
    });
    catalogMocks.openStaticTemplateCatalogVersionSource.mockResolvedValue({
      entry,
      path: sourcePath,
      stream: createReadStream(sourcePath),
    });

    const result = await selectedStaticNativeSourceArchive({
      bundle: bundle(),
      selectedCandidateId: selected.id,
    });

    expect(result.archiveBytes).toBeNull();
    expect(result.archiveByteLength).toBe(64 * 1024 * 1024);
    expect(result.archiveSha256).toBe(HASH);
    expect(
      catalogMocks.requireStaticTemplateCatalogVersion,
    ).toHaveBeenCalledWith(CATALOG_VERSION);
    expect(
      catalogMocks.openStaticTemplateCatalogVersionSource,
    ).toHaveBeenCalledWith(CATALOG_VERSION, selected.catalogCandidateId);
    expect(
      catalogMocks.requireActiveStaticTemplateCatalog,
    ).not.toHaveBeenCalled();
    const first = result.createArchiveReadStream();
    const second = result.createArchiveReadStream();
    expect(first).not.toBe(second);
    first.destroy();
    second.destroy();
  });

  it("keeps a small V7 source inline when the provider task is created", async () => {
    const sourceBytes = Buffer.from("verified-inline-static-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-task-inline-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      feedback: "将首页 CTA 改为预约演示。",
    });

    const result = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: { stage: "native_source_pending" },
    });
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    const createInput = harness.createTask.mock.calls[0]![0] as any;
    expect(Array.from(createInput.prompt).length).toBeLessThanOrEqual(3_000);
    const sourceAttachment = createInput.attachments.find(
      (attachment: any) =>
        attachment.filename === "frontmind-selected-21st-source-v1.zip",
    );
    expect(sourceAttachment).not.toHaveProperty("file_id");
    expect(
      Buffer.from(sourceAttachment.file_data.split(",", 2)[1], "base64"),
    ).toEqual(sourceBytes);
    expect(result.result).not.toHaveProperty("nativeInputProviderFile");
  });

  it("reconciles create outcome-unknown without creating a second task", async () => {
    const sourceBytes = Buffer.from("verified-inline-static-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-create-unknown-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      createOutcomeUnknownOnce: true,
    });

    const first = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(first).toMatchObject({
      status: "pending",
      result: {
        stage: "create_unknown",
        nativeSourceContractVersion: 2,
      },
    });

    const reconciled = await harness.handler({
      operation: {
        ...harness.operation,
        result: first.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(reconciled).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: {
        stage: "native_source_pending",
        taskId: "static-manus-task",
      },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    expect(harness.client.findCreatedTask).toHaveBeenCalledTimes(1);
    expect(harness.client.sendMessage).not.toHaveBeenCalled();
    expect(harness.client.taskDetail).not.toHaveBeenCalled();
    expect(harness.client.listAllMessages).not.toHaveBeenCalled();
  });

  it("retries a known retryable create rejection from a durable ready state", async () => {
    const sourceBytes = Buffer.from("verified-create-retry-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-create-retry-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      createRetryableOnce: true,
    });

    const first = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(first).toMatchObject({
      status: "pending",
      result: {
        stage: "native_input_ready",
        nativeSourceContractVersion: 2,
      },
    });
    expect(first.result).toHaveProperty("providerNextPollAt");
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    expect(harness.client.findCreatedTask).not.toHaveBeenCalled();

    const beforeRetry = await harness.handler({
      operation: {
        ...harness.operation,
        result: first.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(beforeRetry).toMatchObject({
      status: "pending",
      result: { stage: "native_input_ready" },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(1);

    const retried = await harness.handler({
      operation: {
        ...harness.operation,
        result: {
          ...first.result,
          providerNextPollAt: new Date(Date.now() - 1).toISOString(),
        },
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(retried).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: {
        stage: "native_source_pending",
        taskId: "static-manus-task",
      },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(2);
    expect(harness.client.findCreatedTask).not.toHaveBeenCalled();
  });

  it("replays frozen runtime A after deployment B becomes current", async () => {
    const sourceBytes = Buffer.from("verified-runtime-replay-template", "utf8");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-runtime-replay-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();

    const runtimeA = testRuntimeEntry("a");
    const runtimeB = testRuntimeEntry("b");
    const deploymentA = createNativeSourceRuntimeRegistry({
      current: runtimeA,
      entries: [runtimeA, runtimeB],
    });
    const deploymentB = createNativeSourceRuntimeRegistry({
      current: runtimeB,
      entries: [runtimeA, runtimeB],
    });
    const operationToken =
      "siteops-native-source:10000000-0000-4000-8000-000000000001:0";
    const runtimeArchive = Buffer.from("runtime-a-provider-source", "utf8");
    const runtimeArchiveSha256 = createHash("sha256")
      .update(runtimeArchive)
      .digest("hex");
    const runtimeReceipt = {
      operationToken,
      baseSourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      archiveSha256: runtimeArchiveSha256,
      fileCount: 4,
      preflightVersion: runtimeA.coordinates.preflightVersion,
      preflightStatus: "passed",
      preflightSha256: runtimeA.coordinates.preflightSha256,
      runtimeContractVersion: runtimeA.coordinates.contractVersion,
      runtimeContractSha256: runtimeA.coordinates.contractSha256,
      executionShellSha256: runtimeA.coordinates.executionShellSha256,
      executionBaselineSha256: createHash("sha256")
        .update(sourceBytes)
        .digest("hex"),
    } as const;
    const runtimeFiles = new Map<string, Buffer>([
      ["package.json", Buffer.from('{"dependencies":{}}', "utf8")],
      ["index.html", Buffer.from('<div id="root"></div>', "utf8")],
      ["src/main.tsx", Buffer.from("export {};", "utf8")],
      [NATIVE_RUNTIME_ROUTE_MODULE, Buffer.from("export {};", "utf8")],
    ]);
    vi.mocked(runtimeA.validate).mockResolvedValue({
      receipt: runtimeReceipt,
      archiveSha256: runtimeArchiveSha256,
      sourceSha256: runtimeArchiveSha256,
      sourceZip: runtimeArchive,
      fileCount: runtimeFiles.size,
      htmlEntrypoint: "index.html",
      entrypoint: "src/main.tsx",
      packageJson: {},
      files: runtimeFiles,
    } as never);
    vi.mocked(runtimeB.audit).mockImplementation(() => {
      throw new Error("DEPLOYMENT_B_AUDITOR_MUST_NOT_RUN");
    });
    const artifactBytes = {
      contractJson: Buffer.from('{"contractKind":"test"}', "utf8"),
      distZip: Buffer.from("runtime-a-dist", "utf8"),
      qaJson: Buffer.from('{"passed":true,"mode":"preview"}', "utf8"),
      visualQaZip: Buffer.from("runtime-a-qa", "utf8"),
      provenanceJson: Buffer.from("{}\n", "utf8"),
    };
    const materializeNativeSite = vi.fn(async (materializeInput: any) => {
      expect(materializeInput.runtimeAudit).toBe(runtimeA.audit);
      expect(
        materializeInput.runtimeAudit({
          files: materializeInput.validatedSource.files,
          expectedRoutePaths: ["/"],
        }),
      ).toEqual({ ok: true, issues: [] });
      return {
        contractJson: artifactBytes.contractJson,
        contractSha256: createHash("sha256")
          .update(artifactBytes.contractJson)
          .digest("hex"),
        sourceZip: runtimeArchive,
        sourceSha256: runtimeArchiveSha256,
        distZip: artifactBytes.distZip,
        distSha256: createHash("sha256")
          .update(artifactBytes.distZip)
          .digest("hex"),
        qaJson: artifactBytes.qaJson,
        qaSha256: createHash("sha256")
          .update(artifactBytes.qaJson)
          .digest("hex"),
        visualQaZip: artifactBytes.visualQaZip,
        visualQaSha256: createHash("sha256")
          .update(artifactBytes.visualQaZip)
          .digest("hex"),
        provenanceJson: artifactBytes.provenanceJson,
        provenanceSha256: createHash("sha256")
          .update(artifactBytes.provenanceJson)
          .digest("hex"),
        buildLog: Buffer.from("ok", "utf8"),
        files: new Map(),
        buildDelivery: {
          renderMode: "twenty_first_native",
          qaStatus: "passed",
          warningCodes: [],
        },
      };
    });
    const persistArtifact = vi.fn(async (artifactInput: any) => ({
      id: siteOpsArtifactIdForIdempotency({
        userId: artifactInput.userId,
        projectId: artifactInput.projectId,
        kind: artifactInput.kind,
        idempotencyKey: artifactInput.idempotencyKey,
      }),
      contentSha256: createHash("sha256")
        .update(artifactInput.buffer)
        .digest("hex"),
      sizeBytes: artifactInput.buffer.length,
    }));
    let deployed = deploymentA;
    const registry: NativeSourceRuntimeRegistry = {
      get current() {
        return deployed.current;
      },
      resolve(coordinates) {
        return deployed.resolve(coordinates);
      },
    };
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      failCreateUnknownOnce: true,
      nativeSourceRuntimeRegistry: registry,
      materializeNativeSite,
      persistArtifact,
    });

    await expect(
      harness.handler({
        operation: harness.operation as never,
        signal: new AbortController().signal,
        assertLeaseActive: async () => undefined,
      }),
    ).rejects.toThrow("SITEOPS_OPERATION_LEASE_LOST");
    const frozen = harness.getPersistedOperationResult() as Record<
      string,
      unknown
    >;
    expect(frozen).toMatchObject({
      stage: "native_input_ready",
      nativeSourceContractVersion: 2,
      nativeSourceRuntimeCoordinates: runtimeA.coordinates,
    });

    deployed = deploymentB;
    const resumed = await harness.handler({
      operation: { ...harness.operation, result: frozen } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(resumed).toMatchObject({
      status: "pending",
      result: {
        nativeSourceRuntimeCoordinates: runtimeA.coordinates,
      },
    });
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    const createInput = harness.createTask.mock.calls[0]![0] as any;
    expect(
      createInput.attachments.some(
        (attachment: any) => attachment.filename === "runtime-a-contract.json",
      ),
    ).toBe(true);
    expect(
      createInput.attachments.some((attachment: any) =>
        String(attachment.filename).startsWith("runtime-b-"),
      ),
    ).toBe(false);
    expect(
      createInput.structuredOutputSchema.properties.runtimeContractSha256.enum,
    ).toEqual([runtimeA.coordinates.contractSha256]);
    expect(createInput.structuredOutputSchema.required).not.toContain(
      "contentPlanSha256",
    );
    expect(createInput.structuredOutputSchema.properties).not.toHaveProperty(
      "contentPlanSha256",
    );

    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeResultEvents({
        operationToken,
        receipt: runtimeReceipt,
        archive: runtimeArchive,
      }),
    );
    const finished = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: "static-manus-task",
        result: resumed.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(finished).toMatchObject({
      status: "succeeded",
      projectStatus: "preview_ready",
      buildStatus: "preview_ready",
      result: {
        artifactBindings: {
          contract: expect.any(Object),
          source: expect.any(Object),
          dist: expect.any(Object),
          qa: expect.any(Object),
          provenance: expect.any(Object),
        },
      },
    });
    expect(runtimeA.validate).toHaveBeenCalledTimes(1);
    expect(runtimeA.audit).toHaveBeenCalledTimes(2);
    expect(runtimeB.audit).not.toHaveBeenCalled();
    expect(materializeNativeSite).toHaveBeenCalledTimes(1);
  });

  it("turns one messageAskUser wait into one same-task native repair and never loops on the same event", async () => {
    const { harness, created, taskId, initialSendCount, operationToken } =
      await createNativeNoOutputHarness();
    const waitingEventId = "native-source-question-1";
    harness.client.taskDetail.mockResolvedValue({ status: "waiting" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeWaitingWithoutOutputEvents({
        operationToken,
        waitingEventId,
        waitingEventType: "messageAskUser",
      }),
    );

    const repaired = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    const missingOutputSignature = createHash("sha256")
      .update(
        JSON.stringify({ code: "SITEOPS_NATIVE_SOURCE_OUTPUT_UNAVAILABLE" }),
        "utf8",
      )
      .digest("hex");
    expect(repaired).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        taskId,
        nativeRepairAttempt: 1,
        nativeLastErrorSignature: missingOutputSignature,
        phaseOperationToken: repairToken,
        handledWaitingEventId: waitingEventId,
        handledWaitingAt: expect.any(String),
        buildPhase: "source_repairing",
      },
    });
    expect(harness.createTask).not.toHaveBeenCalled();
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(
      initialSendCount + 1,
    );
    expect(harness.client.sendMessage.mock.calls.at(-1)![0]).toMatchObject({
      taskId,
    });
    const diagnosticsAttachment = (
      harness.client.sendMessage.mock.calls.at(-1)![0] as any
    ).attachments.find(
      (attachment: any) =>
        attachment.filename === "frontmind-native-runtime-diagnostics-v1.json",
    );
    const diagnostics = JSON.parse(
      Buffer.from(
        diagnosticsAttachment.file_data.split(",", 2)[1],
        "base64",
      ).toString("utf8"),
    );
    expect(diagnostics).toMatchObject({
      attempt: 1,
      kind: "hard_safety",
      diagnostics: [
        expect.objectContaining({
          code: "SITEOPS_NATIVE_SOURCE_OUTPUT_UNAVAILABLE",
        }),
      ],
    });

    harness.client.listAllMessages.mockResolvedValue(
      nativeWaitingWithoutOutputEvents({
        operationToken: repairToken,
        waitingEventId,
        waitingEventType: "messageAskUser",
      }),
    );
    const repeated = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: repaired.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(repeated).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
        phaseOperationToken: repairToken,
        handledWaitingEventId: waitingEventId,
      },
    });
    expect(harness.createTask).not.toHaveBeenCalled();
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(
      initialSendCount + 1,
    );

    harness.client.listAllMessages.mockResolvedValue(
      nativeWaitingWithoutOutputEvents({
        operationToken: repairToken,
        waitingEventId: "native-source-question-2",
        waitingEventType: "messageAskUser",
      }),
    );
    const differentRepeat = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: repeated.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(differentRepeat).toMatchObject({
      status: "failed",
      code: "SITEOPS_NATIVE_SOURCE_OUTPUT_UNAVAILABLE",
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(
      initialSendCount + 1,
    );
  });

  it("fails closed when native source waiting requests any action other than messageAskUser", async () => {
    const { harness, created, taskId, initialSendCount, operationToken } =
      await createNativeNoOutputHarness();
    harness.client.taskDetail.mockResolvedValue({ status: "waiting" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeWaitingWithoutOutputEvents({
        operationToken,
        waitingEventId: "native-deploy-approval",
        waitingEventType: "deploy",
      }),
    );

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
    });
    expect(harness.createTask).not.toHaveBeenCalled();
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(initialSendCount);
  });

  it("does not retry a quota-limited native source terminal", async () => {
    const { harness, created, taskId, initialSendCount, operationToken } =
      await createNativeNoOutputHarness();
    harness.client.taskDetail.mockResolvedValue({ status: "error" });
    harness.client.listAllMessages.mockResolvedValue([
      {
        id: `marker:${operationToken}`,
        type: "user_message",
        timestamp: 1,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
        },
      },
      {
        id: `quota:${operationToken}`,
        type: "error_message",
        timestamp: 2,
        error_message: {
          content: "Insufficient provider credits",
          error_type: "quota_limit",
        },
      },
      {
        id: `error:${operationToken}`,
        type: "status_update",
        timestamp: 3,
        status_update: { agent_status: "error" },
      },
    ]);

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      result: {
        stage: "native_source_pending",
        nativeRepairAttempt: 0,
        phaseOperationToken: operationToken,
      },
    });
    expect(harness.createTask).not.toHaveBeenCalled();
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(initialSendCount);
  });

  it("prioritizes a typed quota terminal over a stale messageAskUser wait", async () => {
    const { harness, created, taskId, initialSendCount, operationToken } =
      await createNativeNoOutputHarness();
    const waitingEventId = "quota-race-question";
    harness.client.taskDetail.mockResolvedValue({ status: "error" });
    harness.client.listAllMessages.mockResolvedValue([
      {
        id: `marker:${operationToken}`,
        type: "user_message",
        timestamp: 1,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
        },
      },
      {
        id: `quota:${operationToken}`,
        type: "error_message",
        timestamp: 2,
        error_message: {
          content: "Provider quota unavailable",
          error_type: "quota_limit",
        },
      },
      {
        id: `waiting:${waitingEventId}`,
        type: "status_update",
        timestamp: 3,
        status_update: {
          agent_status: "waiting",
          status_detail: {
            waiting_for_event_id: waitingEventId,
            waiting_for_event_type: "messageAskUser",
          },
        },
      },
    ]);

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      result: {
        nativeRepairAttempt: 0,
        phaseOperationToken: operationToken,
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(initialSendCount);
  });

  it("does not enter stopped-result grace or retry after a typed quota error", async () => {
    const { harness, created, taskId, initialSendCount, operationToken } =
      await createNativeNoOutputHarness();
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue([
      {
        id: `marker:${operationToken}`,
        type: "user_message",
        timestamp: 1,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
        },
      },
      {
        id: `running:${operationToken}`,
        type: "status_update",
        timestamp: 2,
        status_update: { agent_status: "running" },
      },
      {
        id: `quota:${operationToken}`,
        type: "error_message",
        timestamp: 3,
        error_message: {
          content: "Provider quota unavailable",
          error_type: "quota_limit",
        },
      },
      {
        id: `stopped:${operationToken}`,
        type: "status_update",
        timestamp: 4,
        status_update: { agent_status: "stopped" },
      },
    ]);

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      result: {
        nativeRepairAttempt: 0,
        phaseOperationToken: operationToken,
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(initialSendCount);
  });

  it("ignores a quota error from an execution episode that later recovered", async () => {
    const { harness, created, taskId, initialSendCount, operationToken } =
      await createNativeNoOutputHarness();
    harness.client.taskDetail.mockResolvedValue({ status: "error" });
    harness.client.listAllMessages.mockResolvedValue([
      {
        id: `marker:${operationToken}`,
        type: "user_message",
        timestamp: 1,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
        },
      },
      {
        id: `running-before:${operationToken}`,
        type: "status_update",
        timestamp: 2,
        status_update: { agent_status: "running" },
      },
      {
        id: `old-quota:${operationToken}`,
        type: "error_message",
        timestamp: 3,
        error_message: {
          content: "Old provider quota error",
          error_type: "quota_limit",
        },
      },
      {
        id: `old-error:${operationToken}`,
        type: "status_update",
        timestamp: 4,
        status_update: { agent_status: "error" },
      },
      {
        id: `recovered:${operationToken}`,
        type: "status_update",
        timestamp: 5,
        status_update: { agent_status: "running" },
      },
      {
        id: `current-error-envelope:${operationToken}`,
        type: "error_message",
        timestamp: 6,
        error_message: {
          content: "Current source delivery failed",
          error_type: "source_delivery_failed",
        },
      },
      {
        id: `current-error:${operationToken}`,
        type: "status_update",
        timestamp: 7,
        status_update: { agent_status: "error" },
      },
    ]);

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
        phaseOperationToken: `siteops-native-source:${harness.operation.id}:1`,
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(
      initialSendCount + 1,
    );
  });

  it("does not infer quota exhaustion from untyped provider error text", async () => {
    const { harness, created, taskId, initialSendCount, operationToken } =
      await createNativeNoOutputHarness();
    harness.client.taskDetail.mockResolvedValue({ status: "error" });
    harness.client.listAllMessages.mockResolvedValue([
      {
        id: `marker:${operationToken}`,
        type: "user_message",
        timestamp: 1,
        user_message: {
          content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
        },
      },
      {
        id: `untyped:${operationToken}`,
        type: "error_message",
        timestamp: 2,
        error_message: {
          content: "This prose mentions insufficient credits but is untyped",
        },
      },
      {
        id: `error:${operationToken}`,
        type: "status_update",
        timestamp: 3,
        status_update: { agent_status: "error" },
      },
    ]);

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(
      initialSendCount + 1,
    );
  });

  it.each(["stopped", "failed"] as const)(
    "schedules one same-task repair when native source %s has no receipt or ZIP",
    async (terminalStatus) => {
      const { harness, created, taskId, initialSendCount, operationToken } =
        await createNativeNoOutputHarness();
      harness.client.taskDetail.mockResolvedValue({ status: terminalStatus });
      harness.client.listAllMessages.mockResolvedValue(
        nativeTerminalWithoutOutputEvents(operationToken, terminalStatus),
      );
      const expiredAt = new Date(Date.now() - 301_000).toISOString();
      const state = {
        ...(created.result as Record<string, unknown>),
        ...(terminalStatus === "stopped"
          ? {
              resultPendingSince: expiredAt,
              resultPendingOperationToken: operationToken,
              providerStoppedAt: expiredAt,
              providerStoppedOperationToken: operationToken,
            }
          : {}),
      };

      const result = await harness.handler({
        operation: {
          ...harness.operation,
          providerTaskId: taskId,
          result: state,
        } as never,
        signal: new AbortController().signal,
        assertLeaseActive: async () => undefined,
      });

      expect(result).toMatchObject({
        status: "pending",
        providerTaskId: taskId,
        result: {
          stage: "native_repair_pending",
          taskId,
          nativeRepairAttempt: 1,
          phaseOperationToken: `siteops-native-source:${harness.operation.id}:1`,
          buildPhase: "source_repairing",
        },
      });
      expect(harness.createTask).not.toHaveBeenCalled();
      expect(harness.client.sendMessage).toHaveBeenCalledTimes(
        initialSendCount + 1,
      );
      const repairInput = harness.client.sendMessage.mock.calls.at(
        -1,
      )![0] as any;
      expect(repairInput.taskId).toBe(taskId);
      const diagnosticsAttachment = repairInput.attachments.find(
        (attachment: any) =>
          attachment.filename ===
          "frontmind-native-runtime-diagnostics-v1.json",
      );
      const diagnostics = JSON.parse(
        Buffer.from(
          diagnosticsAttachment.file_data.split(",", 2)[1],
          "base64",
        ).toString("utf8"),
      );
      expect(diagnostics.diagnostics).toEqual([
        expect.objectContaining({
          code: "SITEOPS_NATIVE_SOURCE_OUTPUT_UNAVAILABLE",
        }),
      ]);
    },
  );

  it("keeps a historical V1 task terminal and never sends a repair", async () => {
    const sourceBytes = Buffer.from("verified-v1-template", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-v1-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
    });
    const taskId = "historical-v1-task";
    harness.context.build.upstreamManusTaskId = taskId;
    const operationToken = `siteops-native-source:${harness.operation.id}:0`;
    const invalidArchive = Buffer.from("not-a-zip", "utf8");
    const receipt = {
      operationToken,
      baseSourceSha256: sourceSha256,
      archiveSha256: createHash("sha256").update(invalidArchive).digest("hex"),
      fileCount: 1,
    };
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeResultEvents({ operationToken, receipt, archive: invalidArchive }),
    );
    const state = {
      schemaVersion: 2,
      stage: "native_source_pending",
      taskId,
      attempts: {
        extraction: 0,
        design: 0,
        content: 0,
        materialization: 0,
      },
      nativeRepairAttempt: 0,
      phaseOperationToken: operationToken,
      buildPhase: "source_waiting",
    };

    const result = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: state,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "NATIVE_SOURCE_ZIP_INVALID",
    });
    expect(harness.client.sendMessage).not.toHaveBeenCalled();
    expect(harness.createTask).not.toHaveBeenCalled();
    expect(harness.uploadFile).not.toHaveBeenCalled();
  });

  it("keeps V2 repair on the frozen runtime and reconciles an unknown send without resending", async () => {
    const sourceBytes = Buffer.from("verified-v2-template", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(path.join(os.tmpdir(), "frontmind-v7-v2-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
      sendOutcomeUnknownOnce: true,
    });
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(created.status).toBe("pending");
    const frozenCoordinates = (created.result as any)
      .nativeSourceRuntimeCoordinates;
    const taskId = String(created.providerTaskId);
    const operationToken = `siteops-native-source:${harness.operation.id}:0`;
    const invalidArchive = Buffer.from("not-a-v2-zip", "utf8");
    const receipt = {
      operationToken,
      baseSourceSha256: sourceSha256,
      archiveSha256: createHash("sha256").update(invalidArchive).digest("hex"),
      fileCount: 1,
      preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
      preflightStatus: "passed",
      preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
      runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      executionBaselineSha256: sourceSha256,
    };
    const baselineEvents = nativeResultEvents({
      operationToken,
      receipt,
      archive: invalidArchive,
    });
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(baselineEvents);

    const repairUnknown = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    expect(repairUnknown).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_send_unknown",
        nativeSourceContractVersion: 2,
        nativeSourceRuntimeCoordinates: frozenCoordinates,
        nativeRepairAttempt: 1,
        phaseOperationToken: repairToken,
        buildPhase: "source_repairing",
      },
    });
    const persistedRepairUnknown = JSON.parse(
      JSON.stringify(repairUnknown.result),
    );
    expect(persistedRepairUnknown).not.toHaveProperty("nativeSourceFileId");
    expect(persistedRepairUnknown).not.toHaveProperty(
      "nativeSourceAttachmentScope",
    );
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    const repairInput = harness.client.sendMessage.mock.calls[0]![0] as any;
    expect(Array.from(repairInput.prompt).length).toBeLessThanOrEqual(3_000);
    expect(
      repairInput.structuredOutputSchema.properties.runtimeContractSha256.enum,
    ).toEqual([frozenCoordinates.contractSha256]);
    expect(repairInput.structuredOutputSchema.required).not.toContain(
      "contentPlanSha256",
    );
    expect(repairInput.structuredOutputSchema.properties).not.toHaveProperty(
      "contentPlanSha256",
    );

    harness.client.taskDetail.mockResolvedValue({ status: "running" });
    harness.client.listAllMessages.mockResolvedValue(baselineEvents);
    const reconciled = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: repairUnknown.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(reconciled).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_send_unknown",
        nativeRepairAttempt: 1,
        phaseOperationToken: repairToken,
        nativeSourceRuntimeCoordinates: frozenCoordinates,
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.createTask).toHaveBeenCalledTimes(1);
  });

  it("repairs an aggregate V2 route-manifest mismatch before materialization", async () => {
    const sourceBytes = Buffer.from("verified-v2-route-baseline", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-route-repair-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
    });
    (harness.context.build.brief.routes as Array<Record<string, unknown>>).push(
      {
        id: "about",
        slug: "/about/",
        title: "关于我们",
        sourceDocumentIds: ["overview"],
      },
    );
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const taskId = String(created.providerTaskId);
    const operationToken = `siteops-native-source:${harness.operation.id}:0`;
    const sourceZip = new JSZip();
    for (const file of NATIVE_RUNTIME_EXECUTION_SHELL_V1.files) {
      sourceZip.file(file.path, file.text);
    }
    sourceZip.file(
      NATIVE_RUNTIME_ROUTE_MODULE,
      'import Home from "./home";\nexport const FRONTMIND_ROUTE_PATHS = ["/"] as const;\nexport default function FrontMindRoutes() { return <Home />; }\n',
    );
    sourceZip.file(
      "src/home.tsx",
      "export default function Home() { return <main>首页</main>; }\n",
    );
    const archive = await sourceZip.generateAsync({ type: "nodebuffer" });
    const receipt = {
      operationToken,
      baseSourceSha256: sourceSha256,
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
      fileCount: NATIVE_RUNTIME_EXECUTION_SHELL_V1.files.length + 2,
      preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
      preflightStatus: "passed",
      preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
      runtimeContractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
      executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      executionBaselineSha256: sourceSha256,
    };
    harness.client.taskDetail.mockResolvedValue({ status: "stopped" });
    harness.client.listAllMessages.mockResolvedValue(
      nativeResultEvents({ operationToken, receipt, archive }),
    );

    const repaired = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: created.result,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(repaired).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
        buildPhase: "source_repairing",
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    const repairInput = harness.client.sendMessage.mock.calls[0]![0] as any;
    expect(repairInput.prompt).toContain(
      "fileCount 必须填写最终 ZIP 的非目录文件条目数（不计目录项）",
    );
    const diagnosticsAttachment = repairInput.attachments.find(
      (attachment: any) =>
        attachment.filename === "frontmind-native-runtime-diagnostics-v1.json",
    );
    const diagnostics = JSON.parse(
      Buffer.from(
        diagnosticsAttachment.file_data.split(",", 2)[1],
        "base64",
      ).toString("utf8"),
    );
    expect(diagnostics).toMatchObject({
      attempt: 1,
      kind: "hard_safety",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "ROUTE_MANIFEST_MISMATCH" }),
      ]),
    });
  });

  it("resumes a persisted repair-send-ready phase without reusing prior intake state", async () => {
    const sourceBytes = Buffer.from("verified-v2-ready-replay", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-repair-ready-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
    });
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const taskId = String(created.providerTaskId);
    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    const readyState = {
      ...(created.result as Record<string, unknown>),
      stage: "native_repair_send_ready",
      taskId,
      nativeRepairAttempt: 1,
      nativeLastErrorSignature: "f".repeat(64),
      nativeRepairInput: {
        attempt: 1,
        kind: "hard_safety",
        diagnostics: [
          {
            code: "NATIVE_SOURCE_ZIP_INVALID",
            file: null,
            line: null,
            column: null,
          },
        ],
      },
      nativeSourceFileId: undefined,
      nativeSourceAttachmentEventId: undefined,
      nativeSourceAttachmentIdentity: undefined,
      nativeSourceAttachmentScope: undefined,
      nativeSourceStaging: undefined,
      buildCheckpoint: undefined,
      phaseOperationToken: repairToken,
      phaseStartedAt: new Date().toISOString(),
      providerSyncStartedAt: new Date().toISOString(),
      buildPhase: "source_repairing",
    };

    const resumed = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: readyState,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(resumed).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      result: {
        stage: "native_repair_pending",
        nativeRepairAttempt: 1,
        phaseOperationToken: repairToken,
        buildPhase: "source_repairing",
      },
    });
    expect(resumed.result).not.toHaveProperty("nativeRepairInput");
    expect(resumed.result).not.toHaveProperty("nativeSourceAttachmentIdentity");
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.client.taskDetail).not.toHaveBeenCalled();
    expect(harness.client.listAllMessages).not.toHaveBeenCalled();
  });

  it("returns an explicitly rejected retryable repair POST to durable send-ready", async () => {
    const sourceBytes = Buffer.from("verified-v2-ready-retry", "utf8");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-repair-retry-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.writeFile(sourceBytes);
    await handle.close();
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes: sourceBytes.length,
      sourceSha256,
      sendRetryableOnce: true,
    });
    const created = await harness.handler({
      operation: harness.operation as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    const taskId = String(created.providerTaskId);
    const repairToken = `siteops-native-source:${harness.operation.id}:1`;
    const readyState = {
      ...(created.result as Record<string, unknown>),
      stage: "native_repair_send_ready",
      taskId,
      nativeRepairAttempt: 1,
      nativeLastErrorSignature: "e".repeat(64),
      nativeRepairInput: {
        attempt: 1,
        kind: "hard_safety",
        diagnostics: [
          {
            code: "NATIVE_SOURCE_ZIP_INVALID",
            file: null,
            line: null,
            column: null,
          },
        ],
      },
      phaseOperationToken: repairToken,
      phaseStartedAt: new Date().toISOString(),
      buildPhase: "source_repairing",
    };

    const retry = await harness.handler({
      operation: {
        ...harness.operation,
        providerTaskId: taskId,
        result: readyState,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });

    expect(retry).toMatchObject({
      status: "pending",
      providerTaskId: taskId,
      nextPollMs: 25_000,
      result: {
        stage: "native_repair_send_ready",
        nativeRepairAttempt: 1,
        nativeRepairInput: { attempt: 1 },
        providerNextPollAt: expect.any(String),
      },
    });
    expect(harness.client.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.client.taskDetail).not.toHaveBeenCalled();
    expect(harness.client.listAllMessages).not.toHaveBeenCalled();
  });

  it("persists and reuses a streamed V7 upload above 52 MiB across worker reclaim", async () => {
    const sourceBytes = 64 * 1024 * 1024;
    const root = await mkdtemp(
      path.join(os.tmpdir(), "frontmind-v7-task-stream-"),
    );
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "template.zip");
    const handle = await open(sourcePath, "w");
    await handle.truncate(sourceBytes);
    await handle.close();
    const sourceSha256 = await sha256File(sourcePath);
    const harness = await createProviderHarness({
      sourcePath,
      sourceBytes,
      sourceSha256,
      failCreateUnknownOnce: true,
    });

    await expect(
      harness.handler({
        operation: harness.operation as never,
        signal: new AbortController().signal,
        assertLeaseActive: async () => undefined,
      }),
    ).rejects.toThrow("SITEOPS_OPERATION_LEASE_LOST");

    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.createTask).not.toHaveBeenCalled();
    const uploadInput = harness.uploadFile.mock.calls[0]![0] as any;
    expect(uploadInput).toMatchObject({
      filename: "frontmind-selected-21st-source-v1.zip",
      byteLength: sourceBytes,
      contentType: "application/zip",
    });
    expect(uploadInput).not.toHaveProperty("bytes");
    const firstUploadStream = uploadInput.createReadStream();
    const secondUploadStream = uploadInput.createReadStream();
    expect(firstUploadStream).not.toBe(secondUploadStream);
    expect(path.resolve(String(firstUploadStream.path))).toBe(
      path.resolve(sourcePath),
    );
    firstUploadStream.destroy();
    secondUploadStream.destroy();

    const uploadedState = harness.getPersistedOperationResult() as any;
    expect(uploadedState).toMatchObject({
      schemaVersion: 2,
      stage: "native_input_ready",
      nativeInputProviderFile: {
        sourceArchiveSha256: sourceSha256,
        bytes: sourceBytes,
        filename: "frontmind-selected-21st-source-v1.zip",
        fileId: "provider-static-source",
        status: "uploaded",
      },
    });
    expect(sourceBytes).toBeGreaterThan(52 * 1024 * 1024);

    const reclaimed = await harness.handler({
      operation: {
        ...harness.operation,
        result: uploadedState,
      } as never,
      signal: new AbortController().signal,
      assertLeaseActive: async () => undefined,
    });
    expect(reclaimed).toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
      result: {
        stage: "native_source_pending",
        nativeInputProviderFile: {
          bytes: sourceBytes,
          fileId: "provider-static-source",
        },
      },
    });
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.createTask).toHaveBeenCalledTimes(1);
    const createInput = harness.createTask.mock.calls[0]![0] as any;
    const sourceAttachment = createInput.attachments.find(
      (attachment: any) =>
        attachment.filename === "frontmind-selected-21st-source-v1.zip",
    );
    expect(sourceAttachment).toEqual({
      file_id: "provider-static-source",
      filename: "frontmind-selected-21st-source-v1.zip",
    });

    await expect(
      harness.handler({
        operation: {
          ...harness.operation,
          providerTaskId: "static-manus-task",
          result: reclaimed.result,
        } as never,
        signal: new AbortController().signal,
        assertLeaseActive: async () => undefined,
      }),
    ).resolves.toMatchObject({
      status: "pending",
      providerTaskId: "static-manus-task",
    });
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.createTask).toHaveBeenCalledTimes(1);
  });

  it("rejects a V7 source asset coordinate before opening catalog bytes", async () => {
    const selected = candidate(0);
    const entry = entryFor(selected);
    catalogMocks.requireStaticTemplateCatalogVersion.mockResolvedValue({
      catalogVersion: CATALOG_VERSION,
      entries: [entry],
    });
    const invalid = bundle();
    invalid.candidates[0] = {
      ...invalid.candidates[0],
      sourceAssetId: `${CATALOG_VERSION}/source/wrong-template`,
    };

    await expect(
      selectedStaticNativeSourceArchive({
        bundle: invalid,
        selectedCandidateId: selected.id,
      }),
    ).rejects.toMatchObject({
      code: "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
    });
    expect(
      catalogMocks.openStaticTemplateCatalogVersionSource,
    ).not.toHaveBeenCalled();
  });
});
