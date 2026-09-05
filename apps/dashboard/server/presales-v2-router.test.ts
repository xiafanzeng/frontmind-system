import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import { describe, expect, it, vi } from "vitest";

import presalesV2Router, {
  acceptedPresalesV2StructuredResult,
  bindPresalesV2TaskAssetProject,
  decodePresalesV2StructuredResultV2,
  decodePresalesV2StructuredResultV3,
  parsePresalesV2TaskCreate,
  presalesV2ArtifactBeforeRedirect,
  presalesV2PreparationFailureState,
  presalesV2AssistantAttachments,
  presalesV2PublicTask,
  presalesV2ReconcileTestHooks,
  presalesV2SafeEvents,
  type PresalesV2DispatchDependencies,
  type PresalesV2ReconcileDependencies,
} from "./presales-v2-router";
import {
  PRESALES_V2_CONTRACT_HASHES,
  resolvePresalesV2Contract,
} from "./presales-v2-contracts";
import { ManusV2ApiError, type ManusV2MessageEvent } from "./manus-v2-client";
import { resolveWebsiteProjectBusinessOwnerBinding } from "./agent-operation-service";
import {
  acquirePresalesV2Asset,
  acquirePresalesV2Task,
  hashPresalesV2Request,
  readPresalesV2Asset,
  readPresalesV2Task,
  updatePresalesV2Asset,
  updatePresalesV2Task,
  type PresalesV2AssetRecord,
  type PresalesV2TaskRecord,
} from "./presales-v2-store";

const HISTORICAL_OPTIMIZATION_FORECAST_CONTRACT_HASH =
  "96bdf3df50dbabaca2618e198c7599c2fc53b3e41bff9076b21efcc2a79886b2";

function taskRecord(
  overrides: Partial<PresalesV2TaskRecord> = {},
): PresalesV2TaskRecord {
  return {
    schemaVersion: 2,
    localTaskId: "00000000-0000-4000-8000-000000000001",
    operationId: "00000000-0000-4000-8000-000000000002",
    idempotencyHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    projectId: "project-acceptance-001",
    contract: {
      name: "website.question-recommendation",
      revision: 2,
      schemaHash:
        PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
    },
    profile: "frontmind-pro",
    upstreamModel: "manus-1.6-max",
    operationToken: "00000000-0000-4000-8000-000000000002",
    operationMarker: "secret-operation-marker",
    providerTitle: "private provider title",
    credentialId: "credential-secret-id",
    credentialVersion: 3,
    providerTaskId: "provider-task-secret",
    providerRequestId: "provider-request-secret",
    providerFileLeases: [
      {
        localAssetId: "00000000-0000-4000-8000-000000000003",
        providerFileId: "provider-file-secret",
        filename: "facts.pdf",
        expiresAt: 2_000_000_000,
        providerRequestId: "provider-file-request-secret",
        uploadState: "uploaded",
      },
    ],
    status: "succeeded",
    safeEvents: [{ id: "event-1", type: "status_update", timestamp: 1 }],
    structuredResult: { questions: [] },
    artifacts: [],
    errorCode: null,
    resultDeadlineAt: null,
    resultDecoderRevision: 3,
    createSearchUntil: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function uploadedAssetRecord(
  ordinal: number,
  projectId = "project-acceptance-001",
): PresalesV2AssetRecord {
  return {
    schemaVersion: 2,
    localAssetId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    idempotencyHash: String(ordinal).repeat(64).slice(0, 64),
    requestHash: String(ordinal + 1)
      .repeat(64)
      .slice(0, 64),
    projectId,
    filename: `asset-${ordinal}.pdf`,
    mimeType: "application/pdf",
    expectedBytes: 3,
    bytes: 3,
    sha256: "e".repeat(64),
    status: "uploaded",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function reconcileHarness(input: {
  record: PresalesV2TaskRecord;
  now: Date;
  events: ManusV2MessageEvent[];
}) {
  let current = input.record;
  let events = input.events;
  let now = input.now;
  const providerCalls = {
    findCreatedTask: vi.fn(),
    listAllMessages: vi.fn(async () => events),
    sendMessage: vi.fn(async () => ({
      requestId: "provider-request-redacted",
    })),
    createTask: vi.fn(),
    stopTask: vi.fn(),
    deleteTask: vi.fn(),
  };
  const localizeArtifact = vi.fn(async () => ({
    artifactId: "00000000-0000-4000-8000-000000000099",
    filename: "frontmind-knowledge-base.zip",
    mimeType: "application/zip",
    bytes: 1024,
    sha256: "c".repeat(64),
  }));
  const dependencies: PresalesV2ReconcileDependencies = {
    now: () => now,
    readTask: vi.fn(async (localTaskId) =>
      localTaskId === current.localTaskId ? current : null,
    ),
    updateTask: vi.fn(async (localTaskId, update) => {
      if (localTaskId !== current.localTaskId) return null;
      current = {
        ...update(current),
        updatedAt: now.toISOString(),
      };
      return current;
    }),
    isDispatchActive: vi.fn(() => false),
    resumePreparation: vi.fn(() => false),
    clientForTask: vi.fn(async () => providerCalls as never),
    localizeArtifact,
  };
  return {
    dependencies,
    providerCalls,
    localizeArtifact,
    current: () => current,
    setCurrent: (next: PresalesV2TaskRecord) => {
      current = next;
    },
    setEvents: (next: ManusV2MessageEvent[]) => {
      events = next;
    },
    setNow: (next: Date) => {
      now = next;
    },
  };
}

const compactStructuredSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "integer" },
    label: { type: "string" },
  },
  required: ["id", "label"],
};

const completeRecommendationQuestion = {
  id: "reputation-01",
  category: "reputation",
  question: "Is this company reliable?",
  questionEnglish: null,
  rationale: "Trust intent",
  enterpriseAnchor: null,
  offeringAnchor: null,
  competitorAnchor: null,
  qaIntent: null,
  evidenceRefs: [],
  selectable: true,
} as const;

function waitingStatusEvent(
  eventType: string | null,
  overrides: Partial<ManusV2MessageEvent> = {},
): ManusV2MessageEvent {
  return {
    id: "provider-waiting-event-secret",
    type: "status_update",
    timestamp: 10,
    status_update: {
      agent_status: "waiting",
      ...(eventType
        ? {
            status_detail: {
              waiting_for_event_id: "provider-waiting-input-secret",
              waiting_for_event_type: eventType,
              waiting_description: "sensitive waiting description",
            },
          }
        : {}),
    },
    ...overrides,
  };
}

function sampleRestrictedStructuredValue(schema: Record<string, unknown>): any {
  const allowed = Array.isArray(schema.enum) ? schema.enum : [];
  if (allowed.length > 0) return allowed[0];
  const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = rawTypes.find((item) => item !== "null") ?? "null";
  if (type === "null") return null;
  if (type === "string") return "sample";
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") {
    const properties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    return Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, child]) => [
        key,
        sampleRestrictedStructuredValue(child),
      ]),
    );
  }
  throw new Error(`unsupported test schema type: ${String(type)}`);
}

function providerDefaultRestrictedStructuredValue(
  schema: Record<string, unknown>,
): any {
  const allowed = Array.isArray(schema.enum) ? schema.enum : [];
  if (allowed.length > 0) return allowed[0];
  const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = rawTypes.find((item) => item !== "null") ?? "null";
  if (type === "null") return null;
  if (type === "string") return "";
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") {
    const properties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    return Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, child]) => [
        key,
        providerDefaultRestrictedStructuredValue(child),
      ]),
    );
  }
  throw new Error(`unsupported test schema type: ${String(type)}`);
}

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTestJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`)
    .join(",")}}`;
}

function meaningfulForecastValue(schema: Record<string, unknown>) {
  const value = providerDefaultRestrictedStructuredValue(schema) as Record<
    string,
    any
  >;
  value.scenario.actionIds = ["GEO_A1_entity_facts"];
  value.scenario.assumptions = ["企业按计划执行全部治理动作"];
  value.scenario.verificationWeeks = [2, 4];
  for (const dimension of Object.values(value.dimensions) as Array<
    Record<string, Record<string, any>>
  >) {
    for (const indicator of Object.values(dimension)) {
      indicator.gapClosureLow = 0.1;
      indicator.gapClosureHigh = 0.2;
      indicator.confidence = 0.8;
      indicator.actionIds = ["GEO_A1_entity_facts"];
      indicator.rationale = "完成实体事实治理后可形成可复测的条件改善";
      indicator.dependencies = ["按计划完成企业事实资产更新"];
      indicator.evidenceRefs = ["baseline:semantic-asset"];
      indicator.timeToSignalWeeks = 2;
      indicator.verificationMetric = "第 2 周和第 4 周按相同范围复测";
    }
  }
  value.roadmap = [
    {
      phase: 1,
      weeks: "第 1 周",
      title: "统一企业事实",
      actions: ["完成实体事实核验"],
      verificationGate: "事实资产通过内部复核",
    },
  ];
  value.summary = "在完整执行治理动作并保持相同采样范围的条件下复测。";
  value.executiveSummary = "本预测是四周条件规划，不构成效果保证。";
  for (const narrative of Object.values(value.dimensionNarratives) as Array<
    Record<string, string>
  >) {
    narrative.currentFinding = "当前基线存在可明确定位的语义资产缺口。";
    narrative.nextAction = "按路线图执行并在相同采样范围复测。";
  }
  value.limitations = ["结果依赖企业按计划执行并保持复测口径一致"];
  return value;
}

describe("Presales v2 public contract", () => {
  it("binds an owner once, replays it, and rejects relabeling", () => {
    expect(resolveWebsiteProjectBusinessOwnerBinding(null, "应祥")).toEqual({
      state: "bound",
      businessOwnerName: "应祥",
    });
    expect(resolveWebsiteProjectBusinessOwnerBinding("应祥", "应祥")).toEqual({
      state: "existing",
      businessOwnerName: "应祥",
    });
    expect(resolveWebsiteProjectBusinessOwnerBinding("应祥", null)).toEqual({
      state: "existing",
      businessOwnerName: "应祥",
    });
    expect(resolveWebsiteProjectBusinessOwnerBinding("应祥", "他人")).toEqual({
      state: "conflict",
    });
    expect(resolveWebsiteProjectBusinessOwnerBinding(null, null)).toEqual({
      state: "missing",
    });
  });

  it("replays the durable project bind after the local asset index was already bound", async () => {
    const asset = {
      schemaVersion: 2 as const,
      localAssetId: "00000000-0000-4000-8000-000000000003",
      idempotencyHash: "a".repeat(64),
      requestHash: "b".repeat(64),
      projectId: "project-acceptance-001",
      filename: "facts.pdf",
      mimeType: "application/pdf",
      expectedBytes: 3,
      bytes: 3,
      sha256: "c".repeat(64),
      status: "uploaded" as const,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const bindLocalRecord = vi.fn();
    const bindDurableRecord = vi.fn(async () => ({ id: asset.localAssetId }));

    await expect(
      bindPresalesV2TaskAssetProject(
        { asset, projectId: asset.projectId },
        { bindLocalRecord, bindDurableRecord },
      ),
    ).resolves.toBe(asset);
    expect(bindLocalRecord).not.toHaveBeenCalled();
    expect(bindDurableRecord).toHaveBeenCalledWith({
      localAssetId: asset.localAssetId,
      projectId: asset.projectId,
    });
  });

  it("keeps ambiguous file uploads attention-required for durable reconciliation", () => {
    expect(
      presalesV2PreparationFailureState(
        new (class extends Error {
          readonly outcomeUnknown = true;
        })(),
      ),
    ).toEqual({ status: "failed", errorCode: "TASK_PREPARATION_FAILED" });
    expect(
      presalesV2PreparationFailureState(
        new ManusV2ApiError(
          "file.upload.content",
          503,
          "HTTP_503",
          true,
          false,
        ),
      ),
    ).toEqual({
      status: "attention_required",
      errorCode: "FILE_UPLOAD_OUTCOME_UNKNOWN",
    });
    expect(
      presalesV2PreparationFailureState(
        new ManusV2ApiError(
          "file.upload.content",
          null,
          "TRANSPORT_UNKNOWN",
          false,
          true,
        ),
      ),
    ).toEqual({
      status: "attention_required",
      errorCode: "FILE_UPLOAD_OUTCOME_UNKNOWN",
    });
    expect(
      presalesV2PreparationFailureState(
        new ManusV2ApiError(
          "file.detail",
          null,
          "FILE_UPLOAD_CONFIRMATION_UNKNOWN",
          false,
          true,
        ),
      ),
    ).toEqual({
      status: "attention_required",
      errorCode: "FILE_UPLOAD_CONFIRMATION_UNKNOWN",
    });
    expect(
      presalesV2PreparationFailureState(
        new ManusV2ApiError(
          "file.upload.content",
          400,
          "HTTP_400",
          false,
          false,
        ),
      ),
    ).toEqual({ status: "failed", errorCode: "FILE_UPLOAD_REJECTED" });
    expect(
      presalesV2PreparationFailureState(
        new ManusV2ApiError(
          "file.detail",
          502,
          "FILE_ID_CONFLICT",
          false,
          true,
        ),
      ),
    ).toEqual({ status: "failed", errorCode: "FILE_UPLOAD_REJECTED" });
  });

  it("persists every exact uploaded lease before collecting attachments and creating once", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [],
      terminalAt: null,
    });
    const events: string[] = [];
    const assets = [1, 2, 3].map((ordinal) => uploadedAssetRecord(ordinal));
    const uploadFile = vi.fn(async (input: any) => {
      const ordinal = uploadFile.mock.calls.length;
      const candidate = {
        fileId: `provider-file-${ordinal}`,
        filename: input.filename,
        uploadUrl: "",
        uploadExpiresAt: 2_000_000_000,
        requestId: null,
      };
      await input.observer.onCandidateCreated(candidate);
      await input.observer.onPutStarted(candidate);
      await input.observer.onPutAccepted(candidate);
      return {
        ...candidate,
        detail: {
          ...candidate,
          status: "uploaded",
          bytes: 3,
          expiresAt: 2_000_000_000,
          contentType: "application/pdf",
        },
      };
    });
    const createTask = vi.fn(async (input: any) => {
      events.push("create");
      expect(input.attachments).toHaveLength(3);
      expect(current.providerFileLeases).toHaveLength(3);
      expect(
        current.providerFileLeases.every(
          (lease) => lease.uploadState === "uploaded",
        ),
      ).toBe(true);
      expect(events.filter((event) => event === "uploaded")).toHaveLength(3);
      return {
        taskId: "provider-created-once",
        taskUrl: null,
        taskTitle: null,
        requestId: "provider-request-created-once",
        raw: {},
      };
    });

    await presalesV2ReconcileTestHooks.dispatchTask(
      {
        record: current,
        assets,
        prompt: "recommend questions",
        contract: resolvePresalesV2Contract(current.contract),
        apiKey: "provider-key-not-logged",
      },
      {
        now: () => now,
        sleep: vi.fn(async () => undefined),
        readStoredBytes: vi.fn(async () => ({
          stored: {} as never,
          bytes: Buffer.from("pdf"),
        })),
        createClient: () => ({ uploadFile, createTask }) as never,
        updateTask: vi.fn(async (_localTaskId, update) => {
          current = update(current);
          return current;
        }),
        persistProviderFileLease: vi.fn(async ({ lease }) => {
          if (lease.uploadState === "uploaded") events.push("uploaded");
        }),
      },
    );

    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(createTask).toHaveBeenCalledOnce();
    expect(events).toEqual(["uploaded", "uploaded", "uploaded", "create"]);
  });

  it("confirms outcome-unknown and reuses uploaded candidates without retransmission", async () => {
    const now = new Date("2026-08-29T08:00:00.000Z");
    const asset = uploadedAssetRecord(11);
    const confirmedAsset = uploadedAssetRecord(15);
    const candidateExpiresAt = Math.floor(now.getTime() / 1_000) + 3_600;
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [
        {
          localAssetId: asset.localAssetId,
          providerFileId: "provider-file-outcome-unknown-secret",
          filename: asset.filename,
          expiresAt: candidateExpiresAt,
          providerRequestId: null,
          uploadState: "outcome_unknown",
        },
        {
          localAssetId: confirmedAsset.localAssetId,
          providerFileId: "provider-file-already-confirmed-secret",
          filename: confirmedAsset.filename,
          expiresAt: candidateExpiresAt,
          providerRequestId: null,
          uploadState: "uploaded",
        },
      ],
      preparation: {
        prompt: "sensitive customer prompt",
        assets: [
          {
            localAssetId: asset.localAssetId,
            filename: asset.filename,
            candidateAttempts: 1,
          },
          {
            localAssetId: confirmedAsset.localAssetId,
            filename: confirmedAsset.filename,
            candidateAttempts: 1,
          },
        ],
        providerCreateAttemptedAt: null,
      },
      terminalAt: null,
    });
    const uploadFile = vi.fn(async (input: any) => {
      expect(input.existingCandidate).toEqual({
        fileId: "provider-file-outcome-unknown-secret",
        filename: asset.filename,
      });
      return {
        ...input.existingCandidate,
        uploadUrl: "",
        uploadExpiresAt: 0,
        requestId: null,
        detail: {
          ...input.existingCandidate,
          status: "uploaded",
          bytes: 3,
          expiresAt: candidateExpiresAt,
          contentType: "application/pdf",
          requestId: null,
        },
      };
    });
    const createTask = vi.fn(async () => ({
      taskId: "provider-created-after-confirmation",
      taskUrl: null,
      taskTitle: null,
      requestId: null,
      raw: {},
    }));

    await presalesV2ReconcileTestHooks.dispatchTask(
      {
        record: current,
        assets: [asset, confirmedAsset],
        prompt: "sensitive customer prompt",
        contract: resolvePresalesV2Contract(current.contract),
        apiKey: "provider-key-not-logged",
      },
      {
        now: () => now,
        sleep: vi.fn(async () => undefined),
        readStoredBytes: vi.fn(async () => ({
          stored: {} as never,
          bytes: Buffer.from("pdf"),
        })),
        createClient: () => ({ uploadFile, createTask }) as never,
        updateTask: vi.fn(async (_localTaskId, update) => {
          current = update(current);
          return current;
        }),
        persistProviderFileLease: vi.fn(),
      },
    );

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledOnce();
    expect(current.providerFileLeases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerFileId: "provider-file-outcome-unknown-secret",
          uploadState: "uploaded",
        }),
        expect.objectContaining({
          providerFileId: "provider-file-already-confirmed-secret",
          uploadState: "uploaded",
        }),
      ]),
    );
    expect(current.preparation).toMatchObject({
      prompt: null,
      providerCreateAttemptedAt: now.toISOString(),
      assets: [{ candidateAttempts: 1 }, { candidateAttempts: 1 }],
    });
  });

  it("uses a second candidate only after transient confirmation failure and keeps logs redacted", async () => {
    const now = new Date("2026-08-29T08:00:00.000Z");
    const asset = uploadedAssetRecord(12);
    const firstProviderFileId = "provider-first-file-secret";
    const secondProviderFileId = "provider-second-file-secret";
    const prompt = "sensitive customer prompt that must not be logged";
    const candidateExpiresAt = Math.floor(now.getTime() / 1_000) + 3_600;
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [
        {
          localAssetId: asset.localAssetId,
          providerFileId: firstProviderFileId,
          filename: asset.filename,
          expiresAt: candidateExpiresAt,
          providerRequestId: null,
          uploadState: "outcome_unknown",
        },
      ],
      preparation: {
        prompt,
        assets: [
          {
            localAssetId: asset.localAssetId,
            filename: asset.filename,
            candidateAttempts: 1,
          },
        ],
        providerCreateAttemptedAt: null,
      },
      terminalAt: null,
    });
    const uploadFile = vi.fn(async (input: any) => {
      if (uploadFile.mock.calls.length === 1) {
        expect(input.existingCandidate?.fileId).toBe(firstProviderFileId);
        await input.observer.onConfirmationUnknown({
          ...input.existingCandidate,
          uploadUrl: "",
          uploadExpiresAt: 0,
          requestId: null,
        });
        throw new ManusV2ApiError(
          "file.detail",
          null,
          "FILE_UPLOAD_CONFIRMATION_UNKNOWN",
          false,
          true,
        );
      }
      expect(input.existingCandidate).toBeUndefined();
      const candidate = {
        fileId: secondProviderFileId,
        filename: asset.filename,
        uploadUrl: "",
        uploadExpiresAt: candidateExpiresAt,
        requestId: null,
      };
      await input.observer.onCandidateCreated(candidate);
      return {
        ...candidate,
        detail: {
          ...candidate,
          status: "uploaded",
          bytes: 3,
          expiresAt: candidateExpiresAt,
          contentType: "application/pdf",
        },
      };
    });
    const createTask = vi.fn(async (input: any) => {
      expect(input.attachments).toEqual([
        { file_id: secondProviderFileId, filename: asset.filename },
      ]);
      return {
        taskId: "provider-created-after-replacement",
        taskUrl: null,
        taskTitle: null,
        requestId: null,
        raw: {},
      };
    });
    const infoLog = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    try {
      await presalesV2ReconcileTestHooks.dispatchTask(
        {
          record: current,
          assets: [asset],
          prompt,
          contract: resolvePresalesV2Contract(current.contract),
          apiKey: "provider-key-not-logged",
        },
        {
          now: () => now,
          sleep: vi.fn(async () => undefined),
          readStoredBytes: vi.fn(async () => ({
            stored: {} as never,
            bytes: Buffer.from("pdf"),
          })),
          createClient: () => ({ uploadFile, createTask }) as never,
          updateTask: vi.fn(async (_localTaskId, update) => {
            current = update(current);
            return current;
          }),
          persistProviderFileLease: vi.fn(),
        },
      );
      const serializedLogs = JSON.stringify(infoLog.mock.calls);
      expect(serializedLogs).toContain(
        "PRESALES_V2_TRANSIENT_FILE_CANDIDATE_REPLACEMENT",
      );
      for (const secret of [
        prompt,
        asset.localAssetId,
        asset.filename,
        firstProviderFileId,
        secondProviderFileId,
      ]) {
        expect(serializedLogs).not.toContain(secret);
      }
    } finally {
      infoLog.mockRestore();
    }

    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(createTask).toHaveBeenCalledOnce();
    expect(current.providerFileLeases).toHaveLength(2);
    expect(current.preparation?.assets[0]?.candidateAttempts).toBe(2);
  });

  it("does not reserve a replacement after a deterministic Provider 4xx", async () => {
    const now = new Date("2026-08-29T08:00:00.000Z");
    const asset = uploadedAssetRecord(13);
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [],
      preparation: {
        prompt: "sensitive customer prompt",
        assets: [
          {
            localAssetId: asset.localAssetId,
            filename: asset.filename,
            candidateAttempts: 0,
          },
        ],
        providerCreateAttemptedAt: null,
      },
      terminalAt: null,
    });
    const uploadFile = vi.fn(async () => {
      throw new ManusV2ApiError(
        "file.upload.content",
        400,
        "HTTP_400",
        false,
        false,
      );
    });
    const createTask = vi.fn();

    await presalesV2ReconcileTestHooks.dispatchTask(
      {
        record: current,
        assets: [asset],
        prompt: "sensitive customer prompt",
        contract: resolvePresalesV2Contract(current.contract),
        apiKey: "provider-key-not-logged",
      },
      {
        now: () => now,
        readStoredBytes: vi.fn(async () => ({
          stored: {} as never,
          bytes: Buffer.from("pdf"),
        })),
        createClient: () => ({ uploadFile, createTask }) as never,
        updateTask: vi.fn(async (_localTaskId, update) => {
          current = update(current);
          return current;
        }),
        persistProviderFileLease: vi.fn(),
      },
    );

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(createTask).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      status: "failed",
      errorCode: "FILE_UPLOAD_REJECTED",
      preparation: {
        prompt: null,
        assets: [{ candidateAttempts: 1 }],
      },
    });
  });

  it("crosses the durable Provider create boundary at most once", async () => {
    const now = new Date("2026-08-29T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [],
      preparation: {
        prompt: "sensitive customer prompt",
        assets: [],
        providerCreateAttemptedAt: null,
      },
      terminalAt: null,
    });
    const createTask = vi.fn(async () => {
      throw new ManusV2ApiError(
        "task.create",
        null,
        "TRANSPORT_UNKNOWN",
        false,
        true,
      );
    });
    const dependencies: Partial<PresalesV2DispatchDependencies> = {
      now: () => now,
      createClient: () => ({ uploadFile: vi.fn(), createTask }) as never,
      updateTask: vi.fn(async (_localTaskId, update) => {
        current = update(current);
        return current;
      }),
      persistProviderFileLease: vi.fn(),
    };
    const dispatchInput = () => ({
      record: current,
      assets: [],
      prompt: "sensitive customer prompt",
      contract: resolvePresalesV2Contract(current.contract),
      apiKey: "provider-key-not-logged",
    });

    await presalesV2ReconcileTestHooks.dispatchTask(
      dispatchInput(),
      dependencies,
    );
    await presalesV2ReconcileTestHooks.dispatchTask(
      dispatchInput(),
      dependencies,
    );

    expect(createTask).toHaveBeenCalledOnce();
    expect(current).toMatchObject({
      status: "queued",
      providerTaskId: null,
      preparation: {
        prompt: null,
        providerCreateAttemptedAt: now.toISOString(),
      },
    });
  });

  it("continues after the same uploaded lease succeeds on its bounded retry", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [],
      terminalAt: null,
    });
    const asset = uploadedAssetRecord(5);
    const sleep = vi.fn(async () => undefined);
    const createTask = vi.fn(async () => ({
      taskId: "provider-after-lease-retry",
      taskUrl: null,
      taskTitle: null,
      requestId: null,
      raw: {},
    }));
    let leaseAttempt = 0;
    const persistProviderFileLease = vi.fn(async () => {
      leaseAttempt += 1;
      if (leaseAttempt === 1) throw new Error("transient SQL failure");
    });

    await presalesV2ReconcileTestHooks.dispatchTask(
      {
        record: current,
        assets: [asset],
        prompt: "recommend questions",
        contract: resolvePresalesV2Contract(current.contract),
        apiKey: "provider-key-not-logged",
      },
      {
        now: () => now,
        sleep,
        readStoredBytes: vi.fn(async () => ({
          stored: {} as never,
          bytes: Buffer.from("pdf"),
        })),
        createClient: () =>
          ({
            uploadFile: vi.fn(async () => ({
              fileId: "provider-file-retried-lease",
              filename: asset.filename,
              uploadUrl: "",
              uploadExpiresAt: 2_000_000_000,
              requestId: null,
              detail: {
                fileId: "provider-file-retried-lease",
                filename: asset.filename,
                status: "uploaded",
                bytes: 3,
                expiresAt: 2_000_000_000,
                contentType: "application/pdf",
                requestId: null,
              },
            })),
            createTask,
          }) as never,
        updateTask: vi.fn(async (_localTaskId, update) => {
          current = update(current);
          return current;
        }),
        persistProviderFileLease,
      },
    );

    expect(persistProviderFileLease).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(createTask).toHaveBeenCalledOnce();
    expect(current).toMatchObject({
      status: "running",
      providerTaskId: "provider-after-lease-retry",
    });
  });

  it("retries the same uploaded lease and never creates when persistence stays unavailable", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [],
      terminalAt: null,
    });
    const asset = uploadedAssetRecord(4);
    const createTask = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const persistProviderFileLease = vi.fn(async () => {
      throw new Error("lease SQL unavailable");
    });

    await presalesV2ReconcileTestHooks.dispatchTask(
      {
        record: current,
        assets: [asset],
        prompt: "recommend questions",
        contract: resolvePresalesV2Contract(current.contract),
        apiKey: "provider-key-not-logged",
      },
      {
        now: () => now,
        sleep,
        readStoredBytes: vi.fn(async () => ({
          stored: {} as never,
          bytes: Buffer.from("pdf"),
        })),
        createClient: () =>
          ({
            uploadFile: vi.fn(async () => ({
              fileId: "provider-file-persist",
              filename: asset.filename,
              uploadUrl: "",
              uploadExpiresAt: 2_000_000_000,
              requestId: null,
              detail: {
                fileId: "provider-file-persist",
                filename: asset.filename,
                status: "uploaded",
                bytes: 3,
                expiresAt: 2_000_000_000,
                contentType: "application/pdf",
                requestId: null,
              },
            })),
            createTask,
          }) as never,
        updateTask: vi.fn(async (_localTaskId, update) => {
          current = update(current);
          return current;
        }),
        persistProviderFileLease,
      },
    );

    expect(persistProviderFileLease).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1_000], [3_000]]);
    expect(createTask).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      status: "failed",
      errorCode: "FILE_LEASE_PERSIST_FAILED",
      providerTaskId: null,
    });
  });

  it("registers one process-local dispatch and releases the single-flight slot", async () => {
    const localTaskId = "00000000-0000-4000-8000-000000000301";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstAction = vi.fn(async () => gate);
    const duplicateAction = vi.fn(async () => undefined);

    const first = presalesV2ReconcileTestHooks.startDispatch(
      localTaskId,
      firstAction,
    );
    const replay = presalesV2ReconcileTestHooks.startDispatch(
      localTaskId,
      duplicateAction,
    );

    expect(replay).toBe(first);
    expect(presalesV2ReconcileTestHooks.isDispatchActive(localTaskId)).toBe(
      true,
    );
    await Promise.resolve();
    expect(firstAction).toHaveBeenCalledOnce();
    expect(duplicateAction).not.toHaveBeenCalled();

    release();
    await first;
    expect(presalesV2ReconcileTestHooks.isDispatchActive(localTaskId)).toBe(
      false,
    );
  });

  it("compensates an unexpected pre-create failure once without reopening a terminal write", async () => {
    const localTaskId = "00000000-0000-4000-8000-000000000302";
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      localTaskId,
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      terminalAt: null,
    });
    const updateTask = vi.fn(async (_localTaskId, update) => {
      current = update(current);
      return current;
    }) as PresalesV2DispatchDependencies["updateTask"];
    const dispatchError = new Error("pre-create write failed");
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await presalesV2ReconcileTestHooks.startDispatch(
        localTaskId,
        async () => {
          throw dispatchError;
        },
        (error) =>
          presalesV2ReconcileTestHooks.compensateDispatchFailure({
            localTaskId,
            error,
            phase: { providerCreateAttempted: false },
            dependencies: { now: () => now, updateTask },
          }),
      );
    } finally {
      errorLog.mockRestore();
    }

    expect(updateTask).toHaveBeenCalledOnce();
    expect(current).toMatchObject({
      status: "failed",
      errorCode: "TASK_PREPARATION_FAILED",
      terminalAt: now.toISOString(),
    });
  });

  it("preserves upload outcome-unknown when the first failure-state write is lost", async () => {
    const localTaskId = "00000000-0000-4000-8000-000000000304";
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      localTaskId,
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      terminalAt: null,
    });
    let updateAttempt = 0;
    const updateTask = vi.fn(async (_localTaskId, update) => {
      updateAttempt += 1;
      if (updateAttempt === 1) {
        throw new Error("failure state filesystem write unavailable");
      }
      current = update(current);
      return current;
    }) as PresalesV2DispatchDependencies["updateTask"];
    const dependencies: Partial<PresalesV2DispatchDependencies> = {
      now: () => now,
      readStoredBytes: vi.fn(async () => ({
        stored: {} as never,
        bytes: Buffer.from("pdf"),
      })),
      createClient: () =>
        ({
          uploadFile: vi.fn(async () => {
            throw new ManusV2ApiError(
              "file.upload.content",
              null,
              "TRANSPORT_UNKNOWN",
              false,
              true,
            );
          }),
          createTask: vi.fn(),
        }) as never,
      updateTask,
      persistProviderFileLease: vi.fn(),
    };
    const phase = { providerCreateAttempted: false };
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await presalesV2ReconcileTestHooks.startDispatch(
        localTaskId,
        () =>
          presalesV2ReconcileTestHooks.dispatchTask(
            {
              record: current,
              assets: [
                {
                  schemaVersion: 2,
                  localAssetId: "00000000-0000-4000-8000-000000000305",
                  idempotencyHash: "c".repeat(64),
                  requestHash: "d".repeat(64),
                  projectId: current.projectId,
                  filename: "facts.pdf",
                  mimeType: "application/pdf",
                  expectedBytes: 3,
                  bytes: 3,
                  sha256: "e".repeat(64),
                  status: "uploaded",
                  createdAt: now.toISOString(),
                  updatedAt: now.toISOString(),
                },
              ],
              prompt: "recommend questions",
              contract: resolvePresalesV2Contract(current.contract),
              apiKey: "provider-key-not-logged",
            },
            dependencies,
            phase,
          ),
        (error) =>
          presalesV2ReconcileTestHooks.compensateDispatchFailure({
            localTaskId,
            error,
            phase,
            dependencies,
          }),
      );
    } finally {
      errorLog.mockRestore();
    }

    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(current).toMatchObject({
      status: "attention_required",
      errorCode: "FILE_UPLOAD_OUTCOME_UNKNOWN",
      terminalAt: now.toISOString(),
    });
  });

  it("never marks a create-attempted task failed during outer compensation", async () => {
    const localTaskId = "00000000-0000-4000-8000-000000000303";
    let current = taskRecord({
      localTaskId,
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      terminalAt: null,
    });
    const updateTask = vi.fn(async (_localTaskId, update) => {
      current = update(current);
      return current;
    }) as PresalesV2DispatchDependencies["updateTask"];
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await presalesV2ReconcileTestHooks.startDispatch(
        localTaskId,
        async () => {
          throw new Error("create response persistence failed");
        },
        (error) =>
          presalesV2ReconcileTestHooks.compensateDispatchFailure({
            localTaskId,
            error,
            phase: { providerCreateAttempted: true },
            dependencies: { updateTask },
          }),
      );
    } finally {
      errorLog.mockRestore();
    }

    expect(updateTask).toHaveBeenCalledOnce();
    expect(current).toMatchObject({
      status: "queued",
      providerTaskId: null,
      errorCode: null,
      terminalAt: null,
    });
  });

  it("replays failed only for an outcome-known Provider create rejection", async () => {
    const localTaskId = "00000000-0000-4000-8000-000000000306";
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      localTaskId,
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      terminalAt: null,
    });
    let updateAttempt = 0;
    const updateTask = vi.fn(async (_localTaskId, update) => {
      updateAttempt += 1;
      if (updateAttempt === 2) {
        throw new Error("explicit rejection state write unavailable");
      }
      current = update(current);
      return current;
    }) as PresalesV2DispatchDependencies["updateTask"];
    const phase = {
      providerCreateAttempted: false,
      providerCreateKnownRejection: null as ManusV2ApiError | null,
    };
    const dependencies: Partial<PresalesV2DispatchDependencies> = {
      now: () => now,
      createClient: () =>
        ({
          uploadFile: vi.fn(),
          createTask: vi.fn(async () => {
            throw new ManusV2ApiError(
              "task.create",
              400,
              "INVALID_REQUEST",
              false,
              false,
            );
          }),
        }) as never,
      updateTask,
      persistProviderFileLease: vi.fn(),
    };
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await presalesV2ReconcileTestHooks.startDispatch(
        localTaskId,
        () =>
          presalesV2ReconcileTestHooks.dispatchTask(
            {
              record: current,
              assets: [],
              prompt: "recommend questions",
              contract: resolvePresalesV2Contract(current.contract),
              apiKey: "provider-key-not-logged",
            },
            dependencies,
            phase,
          ),
        (error) =>
          presalesV2ReconcileTestHooks.compensateDispatchFailure({
            localTaskId,
            error,
            phase,
            dependencies,
          }),
      );
    } finally {
      errorLog.mockRestore();
    }

    expect(updateTask).toHaveBeenCalledTimes(3);
    expect(current).toMatchObject({
      status: "failed",
      providerTaskId: null,
      errorCode: "INVALID_REQUEST",
      terminalAt: now.toISOString(),
    });
  });

  it("keeps a Provider create outcome-unknown queued for marker reconciliation", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      terminalAt: null,
    });
    const updateTask = vi.fn(async (_localTaskId, update) => {
      current = update(current);
      return current;
    }) as PresalesV2DispatchDependencies["updateTask"];
    const phase = {
      providerCreateAttempted: false,
      providerCreateKnownRejection: null as ManusV2ApiError | null,
    };

    await presalesV2ReconcileTestHooks.dispatchTask(
      {
        record: current,
        assets: [],
        prompt: "recommend questions",
        contract: resolvePresalesV2Contract(current.contract),
        apiKey: "provider-key-not-logged",
      },
      {
        now: () => now,
        createClient: () =>
          ({
            uploadFile: vi.fn(),
            createTask: vi.fn(async () => {
              throw new ManusV2ApiError(
                "task.create",
                null,
                "TRANSPORT_UNKNOWN",
                false,
                true,
              );
            }),
          }) as never,
        updateTask,
        persistProviderFileLease: vi.fn(),
      },
      phase,
    );

    expect(updateTask).toHaveBeenCalledOnce();
    expect(phase).toMatchObject({
      providerCreateAttempted: true,
      providerCreateKnownRejection: null,
    });
    expect(current).toMatchObject({
      status: "queued",
      providerTaskId: null,
      errorCode: null,
      terminalAt: null,
    });
  });

  it("replays the durable operation ensure after an acquired/existing insert race", async () => {
    const record = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
    });
    const ensureOperation = vi
      .fn()
      .mockRejectedValueOnce(new Error("duplicate insert race"))
      .mockResolvedValueOnce({ id: record.operationId });

    await expect(
      presalesV2ReconcileTestHooks.ensureOperationAfterReservation(
        record,
        ensureOperation as never,
      ),
    ).resolves.toEqual({ id: record.operationId });
    expect(ensureOperation).toHaveBeenCalledTimes(2);
    expect(ensureOperation).toHaveBeenNthCalledWith(1, record);
    expect(ensureOperation).toHaveBeenNthCalledWith(2, record);
  });

  it("refreshes create reconciliation immediately before Provider create", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      createSearchUntil: new Date(now.getTime() - 1).toISOString(),
      terminalAt: null,
    });
    const createTask = vi.fn(async () => {
      expect(current.createSearchUntil).toBe(
        new Date(now.getTime() + 5 * 60_000).toISOString(),
      );
      return {
        taskId: "provider-created-once",
        taskUrl: null,
        taskTitle: null,
        requestId: "provider-request-created-once",
        raw: {},
      };
    });
    const dependencies: Partial<PresalesV2DispatchDependencies> = {
      now: () => now,
      createClient: () => ({ uploadFile: vi.fn(), createTask }) as never,
      updateTask: vi.fn(async (localTaskId, update) => {
        if (localTaskId !== current.localTaskId) return null;
        current = update(current);
        return current;
      }) as PresalesV2DispatchDependencies["updateTask"],
      persistProviderFileLease: vi.fn(),
    };

    await presalesV2ReconcileTestHooks.dispatchTask(
      {
        record: current,
        assets: [],
        prompt: "recommend questions",
        contract: resolvePresalesV2Contract(current.contract),
        apiKey: "provider-key-not-logged",
      },
      dependencies,
    );

    expect(createTask).toHaveBeenCalledOnce();
    expect(current).toMatchObject({
      providerTaskId: "provider-created-once",
      providerRequestId: "provider-request-created-once",
      status: "running",
      errorCode: null,
      providerStartedAt: now.toISOString(),
      providerRunDeadlineAt: new Date(
        now.getTime() + 60 * 60_000,
      ).toISOString(),
    });
  });

  it("keeps a returned Provider task queued when its local binding write fails", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      terminalAt: null,
    });
    const createTask = vi.fn(async () => ({
      taskId: "provider-must-be-found-by-marker",
      taskUrl: null,
      taskTitle: null,
      requestId: "provider-request-known",
      raw: {},
    }));
    const updateTask = vi.fn(async (_localTaskId, update) => {
      const next = update(current);
      if (next.providerTaskId) throw new Error("binding store unavailable");
      current = next;
      return current;
    }) as PresalesV2DispatchDependencies["updateTask"];
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        presalesV2ReconcileTestHooks.dispatchTask(
          {
            record: current,
            assets: [],
            prompt: "recommend questions",
            contract: resolvePresalesV2Contract(current.contract),
            apiKey: "provider-key-not-logged",
          },
          {
            now: () => now,
            createClient: () => ({ uploadFile: vi.fn(), createTask }) as never,
            updateTask,
            persistProviderFileLease: vi.fn(),
          },
        ),
      ).rejects.toThrow("binding store unavailable");
    } finally {
      errorLog.mockRestore();
    }

    expect(createTask).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(current).toMatchObject({
      providerTaskId: null,
      status: "queued",
      errorCode: null,
    });
  });

  it("does not treat a non-null binding CAS no-op as Provider task ownership", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    let current = taskRecord({
      status: "queued",
      providerTaskId: null,
      providerRequestId: null,
      terminalAt: null,
    });
    let updateCount = 0;
    const updateTask = vi.fn(async (_localTaskId, update) => {
      updateCount += 1;
      if (updateCount === 1) current = update(current);
      // The binding write races a state transition and returns a legitimate,
      // non-null current record without applying the requested provider id.
      return current;
    }) as PresalesV2DispatchDependencies["updateTask"];
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        presalesV2ReconcileTestHooks.dispatchTask(
          {
            record: current,
            assets: [],
            prompt: "recommend questions",
            contract: resolvePresalesV2Contract(current.contract),
            apiKey: "provider-key-not-logged",
          },
          {
            now: () => now,
            createClient: () =>
              ({
                uploadFile: vi.fn(),
                createTask: vi.fn(async () => ({
                  taskId: "provider-cas-no-op-must-not-pass",
                  taskUrl: null,
                  taskTitle: null,
                  requestId: "provider-request-cas-no-op",
                  raw: {},
                })),
              }) as never,
            updateTask,
            persistProviderFileLease: vi.fn(),
          },
        ),
      ).rejects.toMatchObject({
        code: "TASK_PROVIDER_BIND_OUTCOME_UNKNOWN",
      });
      expect(errorLog).toHaveBeenCalledWith(
        "[Presales v2] Provider task binding persistence failed",
        expect.objectContaining({
          diagnosticCode: "PRESALES_V2_PROVIDER_BIND_PERSIST_FAILED",
        }),
      );
    } finally {
      errorLog.mockRestore();
    }

    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(current).toMatchObject({
      status: "queued",
      providerTaskId: null,
      errorCode: null,
    });
  });

  it("rejects caller-selected model/profile/task mode before any dispatch", () => {
    const body = {
      projectId: "project-acceptance-001",
      prompt: "recommend questions",
      localAssetIds: [],
      idempotencyKey: "recommendation-request-0001",
      contract: {
        name: "website.question-recommendation",
        revision: 2,
        schemaHash:
          PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
      },
    };
    expect(parsePresalesV2TaskCreate(body)).toEqual(body);
    expect(() =>
      parsePresalesV2TaskCreate(
        Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== "projectId"),
        ),
      ),
    ).toThrow();
    for (const forbidden of ["agentProfile", "model", "taskMode"] as const) {
      expect(() =>
        parsePresalesV2TaskCreate({ ...body, [forbidden]: "frontmind-base" }),
      ).toThrow();
    }
  });

  it("accepts a normalized owner only on the initial knowledge-base task", () => {
    const initial = {
      projectId: "project-owner-001",
      prompt: "build the candidate knowledge base",
      localAssetIds: [],
      idempotencyKey: "knowledge-base-owner-request-0001",
      contract: {
        name: "website.knowledge-base-candidate" as const,
        revision: 2 as const,
        schemaHash:
          PRESALES_V2_CONTRACT_HASHES["website.knowledge-base-candidate"],
      },
      businessOwnerName: " 应  祥 ",
    };
    expect(parsePresalesV2TaskCreate(initial)).toMatchObject({
      businessOwnerName: "应 祥",
    });
    expect(() =>
      parsePresalesV2TaskCreate({
        ...initial,
        businessOwnerName: undefined,
      }),
    ).toThrow();
    expect(() =>
      parsePresalesV2TaskCreate({
        ...initial,
        contract: {
          name: "website.question-recommendation",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
        },
      }),
    ).toThrow();
  });

  it("discards success:false values and returns accepted top-level objects unchanged", () => {
    expect(
      acceptedPresalesV2StructuredResult([
        {
          id: "event-failed",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: {
            success: false,
            value: { questions: [] },
            error: "no meaningful result",
          },
        },
      ]),
    ).toBeNull();
    const structuredResult = { questions: [{ id: "q1" }] };
    expect(
      acceptedPresalesV2StructuredResult([
        {
          id: "event-ready",
          type: "structured_output_result",
          timestamp: 3,
          structured_output_result: {
            success: true,
            value: structuredResult,
            error: null,
          },
        },
      ]),
    ).toBe(structuredResult);
  });

  it("decodes one complete JSON string from structured output while ignoring assistant text", () => {
    const decoded = decodePresalesV2StructuredResultV2(
      [
        {
          id: "assistant-is-not-authority",
          type: "assistant_message",
          timestamp: 4,
          assistant_message: {
            content: '{"id":99,"label":"must not be read"}',
          },
        },
        {
          id: "structured-string",
          type: "structured_output_result",
          timestamp: 3,
          structured_output_result: {
            success: true,
            value: '{"label":"ready","id":7}',
            error: null,
          },
        },
      ],
      compactStructuredSchema,
    );
    expect(decoded).toMatchObject({
      kind: "accepted",
      value: { id: 7, label: "ready" },
      source: "structured_json_string",
      eventId: "structured-string",
      eventTimestamp: 3,
      validCandidateCount: 1,
    });

    expect(
      decodePresalesV2StructuredResultV2(
        [
          {
            id: "assistant-only",
            type: "assistant_message",
            timestamp: 5,
            assistant_message: { content: '{"id":7,"label":"ready"}' },
          },
          {
            id: "fenced-structured-string",
            type: "structured_output_result",
            timestamp: 4,
            structured_output_result: {
              success: true,
              value: '```json\n{"id":7,"label":"ready"}\n```',
              error: null,
            },
          },
        ],
        compactStructuredSchema,
      ),
    ).toEqual({
      kind: "missing",
      structuredEventCount: 1,
      validCandidateCount: 0,
    });
  });

  it("deduplicates canonically identical candidates and rejects distinct coordinates", () => {
    const duplicateEvents: ManusV2MessageEvent[] = [
      {
        id: "object-coordinate",
        type: "structured_output_result",
        timestamp: 4,
        structured_output_result: {
          success: true,
          value: { id: 7, label: "ready" },
          error: null,
        },
      },
      {
        id: "string-coordinate",
        type: "structured_output_result",
        timestamp: 3,
        structured_output_result: {
          success: true,
          value: '{"label":"ready","id":7}',
          error: null,
        },
      },
    ];
    expect(
      decodePresalesV2StructuredResultV2(
        duplicateEvents,
        compactStructuredSchema,
      ),
    ).toMatchObject({
      kind: "accepted",
      validCandidateCount: 1,
      eventId: "object-coordinate",
    });

    const ambiguous = decodePresalesV2StructuredResultV2(
      [
        {
          id: "authoritative-stop",
          type: "status_update",
          timestamp: 2,
          status_update: { agent_status: "stopped" },
        },
        ...duplicateEvents,
        {
          id: "different-coordinate",
          type: "structured_output_result",
          timestamp: 5,
          structured_output_result: {
            success: true,
            value: { id: 8, label: "different" },
            error: null,
          },
        },
      ],
      compactStructuredSchema,
      { requireStoppedAuthority: true },
    );
    expect(ambiguous).toMatchObject({
      kind: "ambiguous",
      validCandidateCount: 2,
    });
  });

  it("rejects schema-invalid and oversized structured JSON strings", () => {
    const schemaInvalid = decodePresalesV2StructuredResultV2(
      [
        {
          id: "schema-invalid",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: {
            success: true,
            value: '{"id":7,"label":"ready","extra":true}',
            error: null,
          },
        },
      ],
      compactStructuredSchema,
    );
    expect(schemaInvalid).toMatchObject({ kind: "missing" });

    const oversized = decodePresalesV2StructuredResultV2(
      [
        {
          id: "oversized",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: {
            success: true,
            value: `{"id":7,"label":"${"x".repeat(2 * 1024 * 1024)}"}`,
            error: null,
          },
        },
      ],
      compactStructuredSchema,
    );
    expect(oversized).toMatchObject({ kind: "missing" });
  });

  it("recovers the stopped assistant JSON when Manus rejects an otherwise usable recommendation", () => {
    const contract = resolvePresalesV2Contract({
      name: "website.question-recommendation",
      revision: 2,
      schemaHash:
        PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
    });
    const questions = Array.from({ length: 20 }, (_, index) => ({
      id: `reputation-${String(index + 1).padStart(2, "0")}`,
      category: "reputation",
      question: `这家公司是否值得信赖？${index + 1}`,
      rationale: "品牌信任意图",
      evidenceRefs: [],
      selectable: true,
    }));
    const decoded = decodePresalesV2StructuredResultV3(
      [
        {
          id: "assistant-complete-json",
          type: "assistant_message",
          timestamp: 10,
          assistant_message: {
            content: `\uFEFF\`\`\`json\n${JSON.stringify({ questions })}\n\`\`\``,
          },
        },
        {
          id: "structured-rejected",
          type: "structured_output_result",
          timestamp: 11,
          structured_output_result: {
            success: false,
            value: { questions: [] },
            error: "schema extraction failed",
          },
        },
        {
          id: "provider-stopped",
          type: "status_update",
          timestamp: 12,
          status_update: { agent_status: "stopped" },
        },
      ],
      contract.name,
      contract.structuredOutputSchema!,
      { requireStoppedAuthority: true, allowAssistantFallback: true },
    );
    expect(decoded).toMatchObject({
      kind: "accepted",
      source: "assistant_json_fallback",
      eventId: "assistant-complete-json",
      value: {
        questions: expect.arrayContaining([
          expect.objectContaining({
            id: "reputation-01",
            questionEnglish: null,
            enterpriseAnchor: null,
            offeringAnchor: null,
            competitorAnchor: null,
            qaIntent: null,
          }),
        ]),
      },
    });
    if (decoded.kind === "accepted") {
      expect(decoded.value.questions).toHaveLength(20);
    }
  });

  it("keeps native structured success ahead of newer assistant and rejected-envelope candidates", () => {
    const contract = resolvePresalesV2Contract({
      name: "website.question-recommendation",
      revision: 2,
      schemaHash:
        PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
    });
    const question = (id: string) => ({
      id,
      category: "reputation",
      question: `问题 ${id}`,
      questionEnglish: null,
      rationale: "reason",
      enterpriseAnchor: null,
      offeringAnchor: null,
      competitorAnchor: null,
      qaIntent: null,
      evidenceRefs: [],
      selectable: true,
    });
    const decoded = decodePresalesV2StructuredResultV3(
      [
        {
          id: "native",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: {
            success: true,
            value: { questions: [question("native")] },
            error: null,
          },
        },
        {
          id: "rejected-value",
          type: "structured_output_result",
          timestamp: 3,
          structured_output_result: {
            success: false,
            value: { questions: [question("rejected")] },
            error: "extraction failed",
          },
        },
        {
          id: "assistant",
          type: "assistant_message",
          timestamp: 4,
          assistant_message: {
            content: JSON.stringify({ questions: [question("assistant")] }),
          },
        },
        {
          id: "stopped",
          type: "status_update",
          timestamp: 5,
          status_update: { agent_status: "stopped" },
        },
      ],
      contract.name,
      contract.structuredOutputSchema!,
      { requireStoppedAuthority: true, allowAssistantFallback: true },
    );
    expect(decoded).toMatchObject({
      kind: "accepted",
      source: "structured_object",
      eventId: "native",
      value: { questions: [{ id: "native" }] },
    });
  });

  it("rejects only the optimization forecast Provider default skeleton", () => {
    const forecast = resolvePresalesV2Contract({
      name: "website.optimization-forecast",
      revision: 2,
      schemaHash: PRESALES_V2_CONTRACT_HASHES["website.optimization-forecast"],
    });
    const forecastSchema = forecast.structuredOutputSchema! as Record<
      string,
      unknown
    >;
    const providerDefault = providerDefaultRestrictedStructuredValue(
      forecastSchema,
    ) as Record<string, unknown>;
    const legacyDefault = structuredClone(providerDefault);
    delete legacyDefault.brandMentionRateTarget;
    const legacyCanonical = canonicalTestJson(legacyDefault);
    expect(Buffer.byteLength(legacyCanonical, "utf8")).toBe(4_047);
    expect(createHash("sha256").update(legacyCanonical).digest("hex")).toBe(
      "29e03f5d2ba2c7fd327090db388167c8f24840953c041cbd00e9388a4dc80ddd",
    );

    for (const brandMentionRateTarget of [
      null,
      { low: 0.6, expected: 0.75, high: 0.9 },
    ]) {
      const skeleton = {
        ...structuredClone(providerDefault),
        brandMentionRateTarget,
      };
      expect(
        decodePresalesV2StructuredResultV3(
          [
            {
              id: "forecast-default",
              type: "structured_output_result",
              timestamp: 1,
              structured_output_result: {
                success: true,
                value: skeleton,
                error: null,
              },
            },
            {
              id: "forecast-stopped",
              type: "status_update",
              timestamp: 2,
              status_update: { agent_status: "stopped" },
            },
          ],
          forecast.name,
          forecastSchema,
          { requireStoppedAuthority: true, allowAssistantFallback: true },
        ),
      ).toEqual({
        kind: "missing",
        structuredEventCount: 1,
        validCandidateCount: 0,
      });
    }

    const assessment = resolvePresalesV2Contract({
      name: "website.current-state-assessment",
      revision: 2,
      schemaHash:
        PRESALES_V2_CONTRACT_HASHES["website.current-state-assessment"],
    });
    expect(
      decodePresalesV2StructuredResultV3(
        [
          {
            id: "assessment-default",
            type: "structured_output_result",
            timestamp: 1,
            structured_output_result: {
              success: true,
              value: providerDefaultRestrictedStructuredValue(
                assessment.structuredOutputSchema! as Record<string, unknown>,
              ),
              error: null,
            },
          },
          {
            id: "assessment-stopped",
            type: "status_update",
            timestamp: 2,
            status_update: { agent_status: "stopped" },
          },
        ],
        assessment.name,
        assessment.structuredOutputSchema!,
        { requireStoppedAuthority: true, allowAssistantFallback: true },
      ),
    ).toMatchObject({ kind: "accepted", source: "structured_object" });
  });

  it("uses meaningful assistant JSON when a forecast structured event is the Provider default", () => {
    const contract = resolvePresalesV2Contract({
      name: "website.optimization-forecast",
      revision: 2,
      schemaHash: PRESALES_V2_CONTRACT_HASHES["website.optimization-forecast"],
    });
    const schema = contract.structuredOutputSchema! as Record<string, unknown>;
    const providerDefault = providerDefaultRestrictedStructuredValue(schema);
    const assistantValue = meaningfulForecastValue(schema);
    assistantValue.brandMentionRateTarget = null;
    const decoded = decodePresalesV2StructuredResultV3(
      [
        {
          id: "forecast-default",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: {
            success: undefined,
            value: providerDefault,
            error: null,
          },
        },
        {
          id: "forecast-assistant",
          type: "assistant_message",
          timestamp: 2,
          assistant_message: { content: JSON.stringify(assistantValue) },
        },
        {
          id: "forecast-stopped",
          type: "status_update",
          timestamp: 3,
          status_update: { agent_status: "stopped" },
        },
      ],
      contract.name,
      schema,
      { requireStoppedAuthority: true, allowAssistantFallback: true },
    );
    expect(decoded).toMatchObject({
      kind: "accepted",
      source: "assistant_json_fallback",
      eventId: "forecast-assistant",
      value: { brandMentionRateTarget: null },
      validCandidateCount: 1,
    });
  });

  it("keeps a meaningful native forecast ahead of assistant fallback", () => {
    const contract = resolvePresalesV2Contract({
      name: "website.optimization-forecast",
      revision: 2,
      schemaHash: PRESALES_V2_CONTRACT_HASHES["website.optimization-forecast"],
    });
    const schema = contract.structuredOutputSchema! as Record<string, unknown>;
    const nativeValue = meaningfulForecastValue(schema);
    nativeValue.brandMentionRateTarget = {
      low: 0.6,
      expected: 0.75,
      high: 0.9,
    };
    const assistantValue = meaningfulForecastValue(schema);
    assistantValue.summary = "这是一个不同的、但同样符合传输合同的候选结果。";
    const decoded = decodePresalesV2StructuredResultV3(
      [
        {
          id: "forecast-native",
          type: "structured_output_result",
          timestamp: 1,
          structured_output_result: {
            success: true,
            value: nativeValue,
            error: null,
          },
        },
        {
          id: "forecast-assistant",
          type: "assistant_message",
          timestamp: 2,
          assistant_message: { content: JSON.stringify(assistantValue) },
        },
        {
          id: "forecast-stopped",
          type: "status_update",
          timestamp: 3,
          status_update: { agent_status: "stopped" },
        },
      ],
      contract.name,
      schema,
      { requireStoppedAuthority: true, allowAssistantFallback: true },
    );
    expect(decoded).toMatchObject({
      kind: "accepted",
      source: "structured_object",
      eventId: "forecast-native",
      value: {
        brandMentionRateTarget: {
          low: 0.6,
          expected: 0.75,
          high: 0.9,
        },
      },
    });
  });

  it("accepts stopped assistant fallback for all five structured contracts with only allowlisted completion", () => {
    const names = [
      "website.question-recommendation",
      "website.custom-question-classifier",
      "website.current-state-assessment",
      "website.optimization-forecast",
      "website.monitor-question-translation",
    ] as const;
    for (const name of names) {
      const contract = resolvePresalesV2Contract({
        name,
        revision: 2,
        schemaHash: PRESALES_V2_CONTRACT_HASHES[name],
      });
      const schema = contract.structuredOutputSchema! as Record<
        string,
        unknown
      >;
      const value = sampleRestrictedStructuredValue(schema) as Record<
        string,
        any
      >;
      if (name === "website.question-recommendation") {
        const questionSchema = (schema.properties as any).questions.items;
        const question = sampleRestrictedStructuredValue(questionSchema);
        for (const key of [
          "questionEnglish",
          "enterpriseAnchor",
          "offeringAnchor",
          "competitorAnchor",
          "qaIntent",
        ]) {
          delete question[key];
        }
        value.items = [question];
        delete value.questions;
      } else if (name === "website.custom-question-classifier") {
        delete value.questionEnglish;
      } else if (name === "website.current-state-assessment") {
        const firstDimension = Object.values(value.dimensions)[0] as Record<
          string,
          any
        >;
        delete (Object.values(firstDimension)[0] as Record<string, any>)
          .evidenceRefs;
        const properties = schema.properties as any;
        const platform = sampleRestrictedStructuredValue(
          properties.platformBreakdown.items,
        );
        delete platform.citationCount;
        delete platform.referenceCount;
        delete platform.evidenceRefs;
        value.platformBreakdown = [platform];
        const comparison = sampleRestrictedStructuredValue(
          properties.knowledgeVsAnswers.items,
        );
        delete comparison.kbEvidenceRefs;
        value.knowledgeVsAnswers = [comparison];
        const action = sampleRestrictedStructuredValue(
          properties.priorityActions.items,
        );
        delete action.evidenceRefs;
        value.priorityActions = [action];
      } else if (name === "website.optimization-forecast") {
        delete value.limitations;
      }
      const decoded = decodePresalesV2StructuredResultV3(
        [
          {
            id: `${name}-assistant`,
            type: "assistant_message",
            timestamp: 1,
            assistant_message: { content: JSON.stringify(value) },
          },
          {
            id: `${name}-stopped`,
            type: "status_update",
            timestamp: 2,
            status_update: { agent_status: "stopped" },
          },
        ],
        name,
        schema,
        { requireStoppedAuthority: true, allowAssistantFallback: true },
      );
      expect(decoded, name).toMatchObject({
        kind: "accepted",
        source: "assistant_json_fallback",
      });
      if (decoded.kind !== "accepted") continue;
      if (name === "website.question-recommendation") {
        expect(decoded.value.questions).toEqual([
          expect.objectContaining({ questionEnglish: null, qaIntent: null }),
        ]);
      } else if (name === "website.current-state-assessment") {
        expect(decoded.value).toMatchObject({
          platformBreakdown: [
            {
              citationCount: null,
              referenceCount: null,
              evidenceRefs: [],
            },
          ],
          knowledgeVsAnswers: [{ kbEvidenceRefs: [] }],
          priorityActions: [{ evidenceRefs: [] }],
        });
      } else if (name === "website.optimization-forecast") {
        expect(decoded.value.limitations).toEqual([]);
      }
    }
  });

  it("rejects assistant JSON before stopped authority and unsafe or duplicate-key JSON", () => {
    const contract = resolvePresalesV2Contract({
      name: "website.question-recommendation",
      revision: 2,
      schemaHash:
        PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
    });
    const decode = (content: string, stopped = true) =>
      decodePresalesV2StructuredResultV3(
        [
          {
            id: "assistant",
            type: "assistant_message",
            timestamp: 1,
            assistant_message: { content },
          },
          ...(stopped
            ? [
                {
                  id: "stopped",
                  type: "status_update",
                  timestamp: 2,
                  status_update: { agent_status: "stopped" },
                } satisfies ManusV2MessageEvent,
              ]
            : []),
        ],
        contract.name,
        contract.structuredOutputSchema!,
        { requireStoppedAuthority: true, allowAssistantFallback: true },
      );
    expect(decode('{"questions":[]}', false)).toMatchObject({
      kind: "missing",
    });
    expect(
      decodePresalesV2StructuredResultV3(
        [
          {
            id: "historical-stopped",
            type: "status_update",
            timestamp: 1,
            status_update: { agent_status: "stopped" },
          },
          {
            id: "new-operation",
            type: "user_message",
            timestamp: 2,
            user_message: { content: "continue" },
          },
          {
            id: "current-running",
            type: "status_update",
            timestamp: 3,
            status_update: { agent_status: "running" },
          },
          {
            id: "assistant-after-resume",
            type: "assistant_message",
            timestamp: 4,
            assistant_message: {
              content: JSON.stringify({
                questions: [completeRecommendationQuestion],
              }),
            },
          },
        ],
        contract.name,
        contract.structuredOutputSchema!,
        { requireStoppedAuthority: true, allowAssistantFallback: true },
      ),
    ).toMatchObject({ kind: "missing" });
    expect(
      decode('{"questions":[{"id":"one","id":"two","category":"reputation"}]}'),
    ).toMatchObject({ kind: "missing" });
    expect(
      decode(
        '{"questions":[{"id":"one","category":"reputation","__proto__":{}}]}',
      ),
    ).toMatchObject({ kind: "missing" });
    expect(
      decode(
        JSON.stringify({
          questions: [completeRecommendationQuestion],
          items: [{ ...completeRecommendationQuestion, id: "conflict" }],
        }),
      ),
    ).toMatchObject({ kind: "missing" });
    expect(
      decode(
        `${JSON.stringify({ questions: [completeRecommendationQuestion] })}\n${JSON.stringify({ questions: [completeRecommendationQuestion] })}`,
      ),
    ).toMatchObject({ kind: "missing" });
  });

  it("does not synthesize assessment source counts or translation digests", () => {
    for (const name of [
      "website.current-state-assessment",
      "website.monitor-question-translation",
    ] as const) {
      const contract = resolvePresalesV2Contract({
        name,
        revision: 2,
        schemaHash: PRESALES_V2_CONTRACT_HASHES[name],
      });
      const schema = contract.structuredOutputSchema! as Record<
        string,
        unknown
      >;
      const value = sampleRestrictedStructuredValue(schema) as Record<
        string,
        any
      >;
      if (name === "website.current-state-assessment") {
        const platform = sampleRestrictedStructuredValue(
          (schema.properties as any).platformBreakdown.items,
        );
        delete platform.sourceCount;
        value.platformBreakdown = [platform];
      } else {
        delete value.sourceQuestionSha256;
      }
      expect(
        decodePresalesV2StructuredResultV3(
          [
            {
              id: "assistant",
              type: "assistant_message",
              timestamp: 1,
              assistant_message: { content: JSON.stringify(value) },
            },
            {
              id: "stopped",
              type: "status_update",
              timestamp: 2,
              status_update: { agent_status: "stopped" },
            },
          ],
          name,
          schema,
          { requireStoppedAuthority: true, allowAssistantFallback: true },
        ),
        name,
      ).toMatchObject({ kind: "missing" });
    }
  });

  it("requires a stopped coordinate in the current event segment", () => {
    const candidate: ManusV2MessageEvent = {
      id: "structured-after-stop",
      type: "structured_output_result",
      timestamp: 20,
      structured_output_result: {
        success: true,
        value: { id: 7, label: "ready" },
        error: null,
      },
    };
    expect(
      decodePresalesV2StructuredResultV2([candidate], compactStructuredSchema, {
        requireStoppedAuthority: true,
      }),
    ).toMatchObject({ kind: "missing" });
    expect(
      decodePresalesV2StructuredResultV2(
        [
          {
            id: "stopped-before-result",
            type: "status_update",
            timestamp: 19,
            status_update: { agent_status: "stopped" },
          },
          candidate,
          {
            id: "late-running-projection",
            type: "status_update",
            timestamp: 21,
            status_update: { agent_status: "running" },
          },
        ],
        compactStructuredSchema,
        { requireStoppedAuthority: true },
      ),
    ).toMatchObject({ kind: "accepted", eventId: "structured-after-stop" });

    expect(
      decodePresalesV2StructuredResultV2(
        [
          {
            id: "historical-stopped",
            type: "status_update",
            timestamp: 10,
            status_update: { agent_status: "stopped" },
          },
          {
            id: "intervening-user-message",
            type: "user_message",
            timestamp: 11,
            user_message: { content: "continue" },
          },
          {
            id: "nearest-running-status",
            type: "status_update",
            timestamp: 12,
            status_update: { agent_status: "running" },
          },
          {
            ...candidate,
            id: "structured-after-resume",
            timestamp: 13,
          },
        ],
        compactStructuredSchema,
        { requireStoppedAuthority: true },
      ),
    ).toMatchObject({ kind: "missing" });
  });

  it("reads only documented assistant attachment coordinates", () => {
    expect(
      presalesV2AssistantAttachments([
        {
          id: "event-zip",
          type: "assistant_message",
          timestamp: 4,
          assistant_message: {
            content: "done",
            attachments: [
              {
                filename: "candidate.zip",
                url: "https://downloads.example/candidate.zip",
                content_type: "application/zip",
              },
              { file_id: "legacy-provider-file", filename: "legacy.zip" },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        eventId: "event-zip",
        attachmentIndex: 0,
        filename: "candidate.zip",
        contentType: "application/zip",
        url: "https://downloads.example/candidate.zip",
      },
    ]);
  });

  it("allows HTTPS artifact redirects but rejects HTTPS-to-HTTP downgrade", () => {
    expect(() =>
      presalesV2ArtifactBeforeRedirect({
        protocol: "https:",
        hostname: "downloads.example",
      }),
    ).not.toThrow();
    expect(() =>
      presalesV2ArtifactBeforeRedirect({
        protocol: "http:",
        hostname: "downloads.example",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UNSAFE_ARTIFACT_URL", status: 502 }),
    );
  });

  it("never exposes Provider, credential, marker, or model identity", () => {
    const publicTask = presalesV2PublicTask(
      taskRecord({
        providerStartedAt: "2026-08-15T12:00:00.000Z",
        providerRunDeadlineAt: "2026-08-15T12:30:00.000Z",
        providerRunDeadlineExceededAt: "2026-08-15T12:31:00.000Z",
        terminalAt: "2026-08-15T12:32:00.000Z",
        preparation: {
          prompt: "private durable preparation prompt",
          assets: [],
          providerCreateAttemptedAt: null,
        },
      }),
    );
    expect(publicTask).toMatchObject({
      providerStartedAt: "2026-08-15T12:00:00.000Z",
      terminalAt: "2026-08-15T12:32:00.000Z",
    });
    expect(publicTask).not.toHaveProperty("providerRunDeadlineAt");
    expect(publicTask).not.toHaveProperty("providerRunDeadlineExceededAt");
    const serialized = JSON.stringify(publicTask);
    expect(serialized).toContain("00000000-0000-4000-8000-000000000001");
    for (const secret of [
      "provider-task-secret",
      "provider-request-secret",
      "provider-file-secret",
      "credential-secret-id",
      "secret-operation-marker",
      "private durable preparation prompt",
      "manus-1.6-max",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("replaces Provider event identities with stable task-scoped local ids", () => {
    const providerEventId = "provider-event-secret-20260814";
    const providerEvents = [
      {
        id: providerEventId,
        type: "status_update",
        timestamp: 1_723_648_000_000,
      },
    ];
    const first = presalesV2SafeEvents(
      "00000000-0000-4000-8000-000000000001",
      providerEvents,
    );
    const rescanned = presalesV2SafeEvents(
      "00000000-0000-4000-8000-000000000001",
      first,
    );
    const otherTask = presalesV2SafeEvents(
      "00000000-0000-4000-8000-000000000099",
      providerEvents,
    );

    expect(first).toEqual(rescanned);
    expect(first[0]?.id).toMatch(/^safeevt_[a-f0-9]{64}$/u);
    expect(first[0]?.id).not.toBe(otherTask[0]?.id);
    expect(JSON.stringify(first)).not.toContain(providerEventId);

    const publicTask = presalesV2PublicTask(
      taskRecord({ safeEvents: providerEvents }),
    );
    expect(JSON.stringify(publicTask)).not.toContain(providerEventId);
    expect(publicTask.safeEvents).toEqual(first);
  });

  it("omits result until ready and emits only a safe retryability flag", () => {
    const running = presalesV2PublicTask(
      taskRecord({ status: "running", errorCode: null }),
    );
    expect(running).not.toHaveProperty("result");

    const failed = presalesV2PublicTask(
      taskRecord({ status: "failed", errorCode: "INVALID_OUTPUT" }),
    );
    expect(failed).not.toHaveProperty("result");
    expect(failed).toMatchObject({
      error: { code: "INVALID_OUTPUT", retryable: false },
    });
  });

  it.each(["queued", "running"] as const)(
    "continues reconciling a historical forecast contract from %s",
    async (status) => {
      const now = new Date("2026-08-23T10:00:00.000Z");
      const harness = reconcileHarness({
        now,
        events: [
          {
            id: `historical-forecast-${status}`,
            type: "status_update",
            timestamp: 1,
            status_update: { agent_status: "running" },
          },
        ],
        record: taskRecord({
          contract: {
            name: "website.optimization-forecast",
            revision: 2,
            schemaHash: HISTORICAL_OPTIMIZATION_FORECAST_CONTRACT_HASH,
          },
          profile: "frontmind-base",
          status,
          structuredResult: null,
          errorCode: null,
          terminalAt: null,
          providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
          providerRunDeadlineAt: new Date(
            now.getTime() + 29 * 60_000,
          ).toISOString(),
        }),
      });

      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        status: "running",
        structuredResult: null,
        errorCode: null,
      });
    },
  );

  it("uses the historical forecast schema only for the exact historical hash", async () => {
    const now = new Date("2026-08-23T10:00:00.000Z");
    const currentContract = resolvePresalesV2Contract({
      name: "website.optimization-forecast",
      revision: 2,
      schemaHash: PRESALES_V2_CONTRACT_HASHES["website.optimization-forecast"],
    });
    const legacyValue = meaningfulForecastValue(
      currentContract.structuredOutputSchema! as Record<string, unknown>,
    );
    delete legacyValue.brandMentionRateTarget;
    const legacyDefault = providerDefaultRestrictedStructuredValue(
      currentContract.structuredOutputSchema! as Record<string, unknown>,
    );
    delete legacyDefault.brandMentionRateTarget;
    const events: ManusV2MessageEvent[] = [
      {
        id: "historical-forecast-default",
        type: "structured_output_result",
        timestamp: 1,
        structured_output_result: {
          success: true,
          value: legacyDefault,
          error: null,
        },
      },
      {
        id: "historical-forecast-assistant",
        type: "assistant_message",
        timestamp: 2,
        assistant_message: { content: JSON.stringify(legacyValue) },
      },
      {
        id: "historical-forecast-stopped",
        type: "status_update",
        timestamp: 3,
        status_update: { agent_status: "stopped" },
      },
    ];
    const baseRecord = {
      profile: "frontmind-base" as const,
      status: "result_pending" as const,
      structuredResult: null,
      errorCode: null,
      terminalAt: null,
      resultDeadlineAt: new Date(now.getTime() + 60_000).toISOString(),
      providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
      providerRunDeadlineAt: new Date(
        now.getTime() + 29 * 60_000,
      ).toISOString(),
    };
    const historical = reconcileHarness({
      now,
      events,
      record: taskRecord({
        ...baseRecord,
        contract: {
          name: "website.optimization-forecast",
          revision: 2,
          schemaHash: HISTORICAL_OPTIMIZATION_FORECAST_CONTRACT_HASH,
        },
      }),
    });
    const current = reconcileHarness({
      now,
      events,
      record: taskRecord({
        ...baseRecord,
        contract: {
          name: "website.optimization-forecast",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.optimization-forecast"],
        },
      }),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        historical.current().localTaskId,
        historical.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "succeeded",
      structuredResult: legacyValue,
      resultSource: "assistant_json_fallback",
    });
    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        current.current().localTaskId,
        current.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "result_pending",
      structuredResult: null,
    });
  });

  it("does not admit the historical forecast hash for task creation or another contract", async () => {
    expect(() =>
      resolvePresalesV2Contract({
        name: "website.optimization-forecast",
        revision: 2,
        schemaHash: HISTORICAL_OPTIMIZATION_FORECAST_CONTRACT_HASH,
      }),
    ).toThrow(/CONTRACT_HASH_MISMATCH/u);

    const now = new Date("2026-08-23T10:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [
        {
          id: "other-contract-running",
          type: "status_update",
          timestamp: 1,
          status_update: { agent_status: "running" },
        },
      ],
      record: taskRecord({
        contract: {
          name: "website.question-recommendation",
          revision: 2,
          schemaHash: HISTORICAL_OPTIMIZATION_FORECAST_CONTRACT_HASH,
        },
        status: "running",
        structuredResult: null,
        terminalAt: null,
        providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 29 * 60_000,
        ).toISOString(),
      }),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).rejects.toMatchObject({
      code: "CONTRACT_HASH_MISMATCH",
      status: 409,
    });
  });

  it("reschedules durable pre-create preparation after a process restart without Provider I/O", async () => {
    const now = new Date("2026-08-29T08:00:00.000Z");
    const asset = uploadedAssetRecord(14);
    const harness = reconcileHarness({
      now,
      events: [],
      record: taskRecord({
        status: "queued",
        providerTaskId: null,
        providerRequestId: null,
        providerFileLeases: [],
        preparation: {
          prompt: "durable private prompt",
          assets: [
            {
              localAssetId: asset.localAssetId,
              filename: asset.filename,
              candidateAttempts: 1,
            },
          ],
          providerCreateAttemptedAt: null,
        },
        terminalAt: null,
      }),
    });
    vi.mocked(harness.dependencies.resumePreparation).mockReturnValue(true);

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "queued",
      providerTaskId: null,
    });
    expect(harness.dependencies.resumePreparation).toHaveBeenCalledOnce();
    expect(harness.dependencies.clientForTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.findCreatedTask).not.toHaveBeenCalled();
  });

  it("does not expire unknown-create while dispatch is active and uses only marker reconciliation after restart", async () => {
    const now = new Date("2026-08-16T08:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [
        {
          id: "provider-running-after-marker-match",
          type: "status_update",
          timestamp: 1,
          status_update: { agent_status: "running" },
        },
      ],
      record: taskRecord({
        status: "queued",
        providerTaskId: null,
        providerRequestId: null,
        createSearchUntil: new Date(now.getTime() - 1).toISOString(),
        preparation: {
          prompt: null,
          assets: [],
          providerCreateAttemptedAt: new Date(
            now.getTime() - 30_000,
          ).toISOString(),
        },
        terminalAt: null,
      }),
    });
    vi.mocked(harness.dependencies.isDispatchActive).mockReturnValue(true);

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "queued",
      providerTaskId: null,
      errorCode: null,
    });
    expect(harness.dependencies.clientForTask).not.toHaveBeenCalled();

    vi.mocked(harness.dependencies.isDispatchActive).mockReturnValue(false);
    harness.providerCalls.findCreatedTask.mockResolvedValueOnce({
      candidates: [],
      matches: [{ id: "provider-bound-from-operation-marker" }],
      unique: { id: "provider-bound-from-operation-marker" },
    } as never);
    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "running",
      providerTaskId: "provider-bound-from-operation-marker",
      errorCode: null,
      providerStartedAt: now.toISOString(),
      providerRunDeadlineAt: new Date(
        now.getTime() + 60 * 60_000,
      ).toISOString(),
    });
    expect(harness.providerCalls.findCreatedTask).toHaveBeenCalledOnce();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
  });

  it("does not accept a result when the latest operation status returned to running", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const events: ManusV2MessageEvent[] = [
      {
        id: "stopped-current-segment",
        type: "status_update",
        timestamp: 10,
        status_update: { agent_status: "stopped" },
      },
      {
        id: "current-running",
        type: "status_update",
        timestamp: 11,
        status_update: { agent_status: "running" },
      },
      {
        id: "assistant-after-resume",
        type: "assistant_message",
        timestamp: 12,
        assistant_message: {
          content: JSON.stringify({
            questions: [completeRecommendationQuestion],
          }),
        },
      },
    ];
    const harness = reconcileHarness({
      now,
      events,
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 29 * 60_000,
        ).toISOString(),
      }),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "running",
      structuredResult: null,
      resultDecoderRevision: 3,
      resultDeadlineAt: null,
    });
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it("keeps a newly bound running task when listMessages has not propagated yet", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const providerStartedAt = new Date(now.getTime() - 60_000).toISOString();
    const harness = reconcileHarness({
      now,
      events: [],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        terminalAt: null,
        providerStartedAt,
        providerRunDeadlineAt: new Date(
          Date.parse(providerStartedAt) + 30 * 60_000,
        ).toISOString(),
      }),
    });
    harness.providerCalls.listAllMessages.mockRejectedValueOnce(
      new ManusV2ApiError(
        "task.listMessages",
        404,
        "not_found",
        false,
        false,
        "provider-request-must-not-log",
      ),
    );

    try {
      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        status: "running",
        errorCode: null,
        terminalAt: null,
      });
      expect(harness.dependencies.updateTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.listAllMessages).toHaveBeenCalledOnce();
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
      expect(harness.providerCalls.createTask).not.toHaveBeenCalled();

      const serializedLogs = JSON.stringify(warn.mock.calls);
      expect(serializedLogs).toContain("not_found");
      for (const secret of [
        "provider-task-secret",
        "provider-request-must-not-log",
        "secret-operation-marker",
      ]) {
        expect(serializedLogs).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the persisted running state for an explicitly retryable listMessages read", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const providerStartedAt = new Date(
      now.getTime() - 10 * 60_000,
    ).toISOString();
    const harness = reconcileHarness({
      now,
      events: [],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        terminalAt: null,
        providerStartedAt,
        providerRunDeadlineAt: new Date(
          Date.parse(providerStartedAt) + 30 * 60_000,
        ).toISOString(),
      }),
    });
    harness.providerCalls.listAllMessages.mockRejectedValueOnce(
      new ManusV2ApiError(
        "task.listMessages",
        503,
        "PROVIDER_BUSY",
        true,
        false,
      ),
    );

    try {
      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        status: "running",
        errorCode: null,
        terminalAt: null,
      });
      expect(harness.dependencies.updateTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.listAllMessages).toHaveBeenCalledOnce();
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
      expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[Presales v2] transient Provider read deferred",
        {
          diagnosticCode: "PRESALES_V2_PROVIDER_READ_DEFERRED",
          operation: "task.listMessages",
          providerErrorCode: "provider_busy",
          status: 503,
          retryable: true,
          persistedStateFallback: true,
        },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not hide stale not-found or non-retryable listMessages failures", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const providerStartedAt = new Date(now.getTime() - 181_000).toISOString();
    const harness = reconcileHarness({
      now,
      events: [],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt,
        providerRunDeadlineAt: new Date(
          Date.parse(providerStartedAt) + 30 * 60_000,
        ).toISOString(),
      }),
    });
    const staleNotFound = new ManusV2ApiError(
      "task.listMessages",
      404,
      "not_found",
      true,
      false,
    );
    harness.providerCalls.listAllMessages.mockRejectedValueOnce(staleNotFound);

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).rejects.toBe(staleNotFound);
    expect(harness.dependencies.updateTask).not.toHaveBeenCalled();

    const credentialFailure = new ManusV2ApiError(
      "task.listMessages",
      401,
      "UNAUTHORIZED",
      false,
      false,
    );
    harness.providerCalls.listAllMessages.mockRejectedValueOnce(
      credentialFailure,
    );
    harness.setCurrent({
      ...harness.current(),
      providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
      providerRunDeadlineAt: new Date(
        now.getTime() + 29 * 60_000,
      ).toISOString(),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).rejects.toBe(credentialFailure);
    expect(harness.dependencies.updateTask).not.toHaveBeenCalled();
  });

  it.each([
    "AUTHENTICATION_REQUIRED",
    "PERMISSION_DENIED",
    "CONFIGURATION_INVALID",
    "CONTRACT_INVALID",
  ])(
    "does not hide permanent %s read failures marked retryable",
    async (code) => {
      const now = new Date("2026-08-15T13:00:00.000Z");
      const providerStartedAt = new Date(now.getTime() - 60_000).toISOString();
      const harness = reconcileHarness({
        now,
        events: [],
        record: taskRecord({
          status: "running",
          structuredResult: null,
          providerStartedAt,
          providerRunDeadlineAt: new Date(
            Date.parse(providerStartedAt) + 30 * 60_000,
          ).toISOString(),
        }),
      });
      const permanentFailure = new ManusV2ApiError(
        "task.listMessages",
        503,
        code,
        true,
        false,
      );
      harness.providerCalls.listAllMessages.mockRejectedValueOnce(
        permanentFailure,
      );

      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).rejects.toBe(permanentFailure);
      expect(harness.dependencies.updateTask).not.toHaveBeenCalled();
    },
  );

  it("uses the actual failure time when a Provider read crosses the run deadline", async () => {
    const startedAt = new Date("2026-08-15T13:00:00.000Z");
    const deadlineAt = new Date(startedAt.getTime() + 30 * 60_000);
    const requestStartedAt = new Date(deadlineAt.getTime() - 1_000);
    const failureAt = new Date(deadlineAt.getTime() + 1_000);
    const harness = reconcileHarness({
      now: requestStartedAt,
      events: [],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        terminalAt: null,
        providerStartedAt: startedAt.toISOString(),
        providerRunDeadlineAt: deadlineAt.toISOString(),
      }),
    });
    harness.providerCalls.listAllMessages.mockImplementationOnce(async () => {
      harness.setNow(failureAt);
      throw new ManusV2ApiError(
        "task.listMessages",
        503,
        "PROVIDER_BUSY",
        true,
        false,
      );
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "attention_required",
      errorCode: "PROVIDER_RUN_DEADLINE_EXCEEDED",
      providerRunDeadlineExceededAt: failureAt.toISOString(),
      terminalAt: failureAt.toISOString(),
    });
    expect(harness.dependencies.updateTask).toHaveBeenCalledOnce();
    expect(harness.providerCalls.listAllMessages).toHaveBeenCalledOnce();
  });

  it("does not log a free-form Provider error code", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const providerStartedAt = new Date(
      now.getTime() - 10 * 60_000,
    ).toISOString();
    const harness = reconcileHarness({
      now,
      events: [],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt,
        providerRunDeadlineAt: new Date(
          Date.parse(providerStartedAt) + 30 * 60_000,
        ).toISOString(),
      }),
    });
    const secretLikeCode = "customer-secret-token-value";
    harness.providerCalls.listAllMessages.mockRejectedValueOnce(
      new ManusV2ApiError(
        "task.listMessages",
        503,
        secretLikeCode,
        true,
        false,
      ),
    );

    try {
      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({ status: "running", errorCode: null });
      expect(warn).toHaveBeenCalledWith(
        "[Presales v2] transient Provider read deferred",
        expect.objectContaining({
          diagnosticCode: "PRESALES_V2_PROVIDER_READ_DEFERRED",
          providerErrorCode: "provider_read_failed",
          persistedStateFallback: true,
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secretLikeCode);
    } finally {
      warn.mockRestore();
    }
  });

  it("persists the real-incident assistant fallback without a repair message", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const questions = Array.from({ length: 20 }, (_, index) => {
      const {
        questionEnglish: _questionEnglish,
        enterpriseAnchor: _enterpriseAnchor,
        offeringAnchor: _offeringAnchor,
        competitorAnchor: _competitorAnchor,
        qaIntent: _qaIntent,
        ...question
      } = completeRecommendationQuestion;
      return { ...question, id: `question-${index + 1}` };
    });
    const harness = reconcileHarness({
      now,
      events: [
        {
          id: "assistant-result",
          type: "assistant_message",
          timestamp: 10,
          assistant_message: { content: JSON.stringify({ questions }) },
        },
        {
          id: "rejected-extraction",
          type: "structured_output_result",
          timestamp: 11,
          structured_output_result: {
            success: false,
            value: { questions: [] },
            error: "Extracted value does not conform to the provided schema",
          },
        },
        {
          id: "stopped",
          type: "status_update",
          timestamp: 12,
          status_update: { agent_status: "stopped" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 29 * 60_000,
        ).toISOString(),
      }),
    });
    const result = await presalesV2ReconcileTestHooks.reconcileTask(
      harness.current().localTaskId,
      harness.dependencies,
    );
    expect(result).toMatchObject({
      status: "succeeded",
      resultDecoderRevision: 3,
      resultSource: "assistant_json_fallback",
      resultHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.repair).toBeUndefined();
    expect(
      (result.structuredResult as { questions: unknown[] }).questions,
    ).toHaveLength(20);
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it("selects the latest native result in the authoritative stopped segment", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [
        {
          id: "current-running",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "running" },
        },
        {
          id: "first-valid-coordinate",
          type: "structured_output_result",
          timestamp: 11,
          structured_output_result: {
            success: true,
            value: {
              questions: [{ ...completeRecommendationQuestion, id: "earlier" }],
            },
            error: null,
          },
        },
        {
          id: "second-valid-coordinate",
          type: "structured_output_result",
          timestamp: 12,
          structured_output_result: {
            success: true,
            value: { questions: [completeRecommendationQuestion] },
            error: null,
          },
        },
        {
          id: "authoritative-stopped",
          type: "status_update",
          timestamp: 13,
          status_update: { agent_status: "stopped" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 29 * 60_000,
        ).toISOString(),
      }),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "succeeded",
      errorCode: null,
      structuredResult: { questions: [completeRecommendationQuestion] },
    });
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it("never lets a stale running observation overwrite a concurrently committed success", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [
        {
          id: "stale-running-status",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "running" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 29 * 60_000,
        ).toISOString(),
      }),
    });
    harness.providerCalls.listAllMessages.mockImplementationOnce(async () => {
      harness.setCurrent({
        ...harness.current(),
        status: "succeeded",
        structuredResult: { questions: [] },
        terminalAt: now.toISOString(),
      });
      return [
        {
          id: "stale-running-status",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "running" },
        },
      ];
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "succeeded",
      structuredResult: { questions: [] },
    });
  });

  it("never reopens a deterministic failure with a stale accepted result", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const events: ManusV2MessageEvent[] = [
      {
        id: "accepted-stop",
        type: "status_update",
        timestamp: 10,
        status_update: { agent_status: "stopped" },
      },
      {
        id: "accepted-result",
        type: "structured_output_result",
        timestamp: 11,
        structured_output_result: {
          success: true,
          value: { questions: [] },
          error: null,
        },
      },
    ];
    const harness = reconcileHarness({
      now,
      events,
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 29 * 60_000,
        ).toISOString(),
      }),
    });
    harness.providerCalls.listAllMessages.mockImplementationOnce(async () => {
      harness.setCurrent({
        ...harness.current(),
        status: "failed",
        errorCode: "RESULT_COORDINATE_AMBIGUOUS",
        resultDecoderRevision: 2,
        terminalAt: now.toISOString(),
      });
      return events;
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "RESULT_COORDINATE_AMBIGUOUS",
      structuredResult: null,
    });
  });

  it("keeps an unfinished revision-2 task read-only with zero Provider I/O", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [],
      record: taskRecord({
        status: "result_pending",
        resultDecoderRevision: 2,
        structuredResult: null,
        resultDeadlineAt: new Date(now.getTime() - 1).toISOString(),
      }),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "result_pending",
      resultDecoderRevision: 2,
      structuredResult: null,
    });
    expect(harness.providerCalls.listAllMessages).not.toHaveBeenCalled();
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "result_pending"] as const)(
    "keeps a provider-bound revision-2 knowledge-base task in %s read-only across repeated route reconciliation",
    async (status) => {
      const now = new Date("2026-08-15T13:00:00.000Z");
      const harness = reconcileHarness({
        now,
        events: [
          {
            id: "must-not-be-read",
            type: "status_update",
            timestamp: 1,
            status_update: { agent_status: "stopped" },
          },
        ],
        record: taskRecord({
          status,
          contract: {
            name: "website.knowledge-base-candidate",
            revision: 2,
            schemaHash:
              PRESALES_V2_CONTRACT_HASHES["website.knowledge-base-candidate"],
          },
          profile: "frontmind-base",
          resultDecoderRevision: 2,
          structuredResult: null,
          artifacts: [],
          resultDeadlineAt:
            status === "result_pending"
              ? new Date(now.getTime() - 1).toISOString()
              : null,
        }),
      });
      for (const _routeEntry of ["GET", "POST"] as const) {
        await expect(
          presalesV2ReconcileTestHooks.reconcileTask(
            harness.current().localTaskId,
            harness.dependencies,
          ),
        ).resolves.toMatchObject({
          status,
          resultDecoderRevision: 2,
          structuredResult: null,
          artifacts: [],
        });
      }
      expect(harness.dependencies.clientForTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.findCreatedTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.listAllMessages).not.toHaveBeenCalled();
      expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
      expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
      expect(harness.localizeArtifact).not.toHaveBeenCalled();
    },
  );

  it("converges a fresh revision-3 knowledge-base ZIP without structured decoding", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [
        {
          id: "initial-operation",
          type: "user_message",
          timestamp: 1,
          user_message: { content: "create knowledge base" },
        },
        {
          id: "zip-result",
          type: "assistant_message",
          timestamp: 2,
          assistant_message: {
            content: "completed",
            attachments: [
              {
                filename: "frontmind-knowledge-base.zip",
                content_type: "application/zip",
                url: "https://files.example.test/result.zip",
              },
            ],
          },
        },
        {
          id: "current-stopped",
          type: "status_update",
          timestamp: 3,
          status_update: { agent_status: "stopped" },
        },
      ],
      record: taskRecord({
        status: "running",
        contract: {
          name: "website.knowledge-base-candidate",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.knowledge-base-candidate"],
        },
        profile: "frontmind-base",
        resultDecoderRevision: 3,
        structuredResult: null,
        artifacts: [],
        providerStartedAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 29 * 60_000,
        ).toISOString(),
      }),
    });
    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "succeeded",
      resultDecoderRevision: 3,
      artifacts: [
        {
          artifactId: "00000000-0000-4000-8000-000000000099",
          filename: "frontmind-knowledge-base.zip",
          mimeType: "application/zip",
          bytes: 1024,
          sha256: "c".repeat(64),
        },
      ],
    });
    expect(harness.localizeArtifact).toHaveBeenCalledOnce();
    expect(harness.providerCalls.listAllMessages).toHaveBeenCalledOnce();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it("keeps a question cascade running and accepts its stopped structured result", async () => {
    const now = new Date("2026-08-29T07:00:00.000Z");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const harness = reconcileHarness({
      now,
      events: [
        waitingStatusEvent("cascadeJobCall"),
        {
          id: "assistant-body-secret",
          type: "assistant_message",
          timestamp: 11,
          assistant_message: { content: "sensitive provider body" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        errorCode: "STALE_ERROR",
        terminalAt: new Date(now.getTime() - 1_000).toISOString(),
        providerStartedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 55 * 60_000,
        ).toISOString(),
      }),
    });
    try {
      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        status: "running",
        structuredResult: null,
        errorCode: null,
        terminalAt: null,
      });
      expect(harness.current().safeEvents).toHaveLength(2);
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
      expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();

      harness.setEvents([
        {
          id: "question-result",
          type: "structured_output_result",
          timestamp: 20,
          structured_output_result: {
            success: true,
            value: { questions: [completeRecommendationQuestion] },
            error: null,
          },
        },
        {
          id: "question-stopped",
          type: "status_update",
          timestamp: 21,
          status_update: { agent_status: "stopped" },
        },
      ]);
      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        status: "succeeded",
        structuredResult: { questions: [completeRecommendationQuestion] },
        errorCode: null,
      });

      const serializedLogs = JSON.stringify(info.mock.calls);
      expect(serializedLogs).toContain('"waitingClassification":"cascade"');
      for (const secret of [
        "provider-waiting-event-secret",
        "provider-waiting-input-secret",
        "sensitive waiting description",
        "assistant-body-secret",
        "sensitive provider body",
      ]) {
        expect(serializedLogs).not.toContain(secret);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("keeps a knowledge-base cascade running and accepts its stopped ZIP", async () => {
    const now = new Date("2026-08-29T07:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [waitingStatusEvent("cascadeJobCall")],
      record: taskRecord({
        contract: {
          name: "website.knowledge-base-candidate",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.knowledge-base-candidate"],
        },
        profile: "frontmind-base",
        status: "running",
        structuredResult: null,
        artifacts: [],
        errorCode: null,
        terminalAt: null,
        providerStartedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 55 * 60_000,
        ).toISOString(),
      }),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "running",
      errorCode: null,
      terminalAt: null,
      artifacts: [],
    });
    expect(harness.localizeArtifact).not.toHaveBeenCalled();

    harness.setEvents([
      {
        id: "kb-zip-result",
        type: "assistant_message",
        timestamp: 20,
        assistant_message: {
          content: "completed",
          attachments: [
            {
              filename: "frontmind-knowledge-base.zip",
              content_type: "application/zip",
              url: "https://files.example.test/result.zip",
            },
          ],
        },
      },
      {
        id: "kb-stopped",
        type: "status_update",
        timestamp: 21,
        status_update: { agent_status: "stopped" },
      },
    ]);
    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "succeeded",
      errorCode: null,
      artifacts: [
        {
          artifactId: "00000000-0000-4000-8000-000000000099",
          filename: "frontmind-knowledge-base.zip",
        },
      ],
    });
    expect(harness.localizeArtifact).toHaveBeenCalledOnce();
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it("moves only canonical messageAskUser waiting into attention", async () => {
    const now = new Date("2026-08-29T07:00:00.000Z");
    const harness = reconcileHarness({
      now,
      events: [waitingStatusEvent("message-Ask_User")],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        errorCode: null,
        terminalAt: null,
        providerStartedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 55 * 60_000,
        ).toISOString(),
      }),
    });

    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "attention_required",
      errorCode: "PROVIDER_ACTION_REQUIRED",
      terminalAt: now.toISOString(),
    });
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it.each([
    ["mapreduceAction", "other"],
    [null, "missing"],
  ] as const)(
    "keeps %s waiting classified as %s running",
    async (eventType, classification) => {
      const now = new Date("2026-08-29T07:00:00.000Z");
      const info = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const harness = reconcileHarness({
        now,
        events: [waitingStatusEvent(eventType)],
        record: taskRecord({
          status: "running",
          structuredResult: null,
          errorCode: "STALE_ERROR",
          terminalAt: new Date(now.getTime() - 1_000).toISOString(),
          providerStartedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
          providerRunDeadlineAt: new Date(
            now.getTime() + 55 * 60_000,
          ).toISOString(),
        }),
      });
      try {
        await expect(
          presalesV2ReconcileTestHooks.reconcileTask(
            harness.current().localTaskId,
            harness.dependencies,
          ),
        ).resolves.toMatchObject({
          status: "running",
          errorCode: null,
          terminalAt: null,
        });
        expect(JSON.stringify(info.mock.calls)).toContain(
          `\"waitingClassification\":\"${classification}\"`,
        );
        expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
        expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
        expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
        expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    },
  );

  it("uses a 60 minute fallback deadline without rewriting persisted deadlines", async () => {
    const startedAt = new Date("2026-08-29T07:00:00.000Z");
    const beforeDeadline = new Date(startedAt.getTime() + 60 * 60_000 - 1);
    const before = reconcileHarness({
      now: beforeDeadline,
      events: [
        {
          id: "running-before-deadline",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "running" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        errorCode: null,
        terminalAt: null,
        providerStartedAt: startedAt.toISOString(),
        providerRunDeadlineAt: null,
      }),
    });
    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        before.current().localTaskId,
        before.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "running",
      providerRunDeadlineAt: new Date(
        startedAt.getTime() + 60 * 60_000,
      ).toISOString(),
    });

    const exactDeadline = new Date(startedAt.getTime() + 60 * 60_000);
    const atBoundary = reconcileHarness({
      now: exactDeadline,
      events: [
        {
          id: "running-at-deadline",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "running" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        errorCode: null,
        terminalAt: null,
        providerStartedAt: startedAt.toISOString(),
        providerRunDeadlineAt: null,
      }),
    });
    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        atBoundary.current().localTaskId,
        atBoundary.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "attention_required",
      errorCode: "PROVIDER_RUN_DEADLINE_EXCEEDED",
      providerRunDeadlineAt: exactDeadline.toISOString(),
    });

    const persistedDeadline = new Date(startedAt.getTime() + 30 * 60_000);
    const persisted = reconcileHarness({
      now: new Date(persistedDeadline.getTime() - 1),
      events: [
        {
          id: "legacy-running-before-persisted-deadline",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "running" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        errorCode: null,
        terminalAt: null,
        providerStartedAt: startedAt.toISOString(),
        providerRunDeadlineAt: persistedDeadline.toISOString(),
      }),
    });
    await expect(
      presalesV2ReconcileTestHooks.reconcileTask(
        persisted.current().localTaskId,
        persisted.dependencies,
      ),
    ).resolves.toMatchObject({
      status: "running",
      providerRunDeadlineAt: persistedDeadline.toISOString(),
    });
  });

  it.each([
    ["attention_required", "PROVIDER_ACTION_REQUIRED"],
    ["failed", "RESULT_INVALID_OR_MISSING"],
  ] as const)(
    "keeps historical %s terminal state frozen with zero Provider I/O",
    async (status, errorCode) => {
      const now = new Date("2026-08-29T07:00:00.000Z");
      const harness = reconcileHarness({
        now,
        events: [waitingStatusEvent("cascadeJobCall")],
        record: taskRecord({
          status,
          errorCode,
          structuredResult: null,
          terminalAt: new Date(now.getTime() - 60_000).toISOString(),
        }),
      });

      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({ status, errorCode });
      expect(harness.dependencies.clientForTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.listAllMessages).not.toHaveBeenCalled();
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
      expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
    },
  );

  it("fails after the 120 second result grace without repairing the Provider task", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const events: ManusV2MessageEvent[] = [
      {
        id: "provider-event-secret-stopped",
        type: "status_update",
        timestamp: 10,
        status_update: { agent_status: "stopped" },
      },
      {
        id: "assistant-empty-json",
        type: "assistant_message",
        timestamp: 11,
        assistant_message: { content: '{"questions":[]}' },
      },
    ];
    const harness = reconcileHarness({
      now,
      events,
      record: taskRecord({
        status: "result_pending",
        structuredResult: null,
        resultDeadlineAt: new Date(now.getTime() - 1).toISOString(),
        providerStartedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
        providerRunDeadlineAt: new Date(
          now.getTime() + 25 * 60_000,
        ).toISOString(),
      }),
    });

    const first = await presalesV2ReconcileTestHooks.reconcileTask(
      harness.current().localTaskId,
      harness.dependencies,
    );
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "RESULT_INVALID_OR_MISSING",
      resultDecoderRevision: 3,
    });
    await presalesV2ReconcileTestHooks.reconcileTask(
      harness.current().localTaskId,
      harness.dependencies,
    );
    expect(harness.providerCalls.listAllMessages).toHaveBeenCalledTimes(1);
    expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
    expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
    expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
  });

  it("turns a 30 minute provider run into read-only attention and later promotes the same task", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const harness = reconcileHarness({
      now,
      events: [
        {
          id: "provider-event-id-must-not-log",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "running" },
        },
        {
          id: "assistant-secret-event",
          type: "assistant_message",
          timestamp: 11,
          assistant_message: { content: "sensitive-provider-body" },
        },
      ],
      record: taskRecord({
        status: "running",
        structuredResult: null,
        providerStartedAt: new Date(now.getTime() - 31 * 60_000).toISOString(),
        providerRunDeadlineAt: new Date(now.getTime() - 60_000).toISOString(),
      }),
    });
    try {
      const timedOut = await presalesV2ReconcileTestHooks.reconcileTask(
        harness.current().localTaskId,
        harness.dependencies,
      );
      expect(timedOut).toMatchObject({
        status: "attention_required",
        errorCode: "PROVIDER_RUN_DEADLINE_EXCEEDED",
        providerRunDeadlineExceededAt: now.toISOString(),
      });
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
      expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();

      harness.setEvents([
        {
          id: "late-stopped",
          type: "status_update",
          timestamp: 20,
          status_update: { agent_status: "stopped" },
        },
        {
          id: "late-valid-result",
          type: "structured_output_result",
          timestamp: 21,
          structured_output_result: {
            success: true,
            value: { questions: [completeRecommendationQuestion] },
            error: null,
          },
        },
      ]);
      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        status: "succeeded",
        structuredResult: { questions: [completeRecommendationQuestion] },
      });
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();

      const serializedLogs = JSON.stringify(info.mock.calls);
      for (const secret of [
        "provider-task-secret",
        "provider-event-id-must-not-log",
        "assistant-secret-event",
        "sensitive-provider-body",
        "secret-operation-marker",
      ]) {
        expect(serializedLogs).not.toContain(secret);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("keeps an expired task in safe attention when the read-only Provider check is unavailable", async () => {
    const now = new Date("2026-08-15T13:00:00.000Z");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const harness = reconcileHarness({
      now,
      events: [],
      record: taskRecord({
        status: "attention_required",
        structuredResult: null,
        errorCode: "PROVIDER_RUN_DEADLINE_EXCEEDED",
        providerStartedAt: new Date(now.getTime() - 31 * 60_000).toISOString(),
        providerRunDeadlineAt: new Date(now.getTime() - 60_000).toISOString(),
        providerRunDeadlineExceededAt: new Date(
          now.getTime() - 30_000,
        ).toISOString(),
        terminalAt: new Date(now.getTime() - 30_000).toISOString(),
      }),
    });
    harness.providerCalls.listAllMessages.mockRejectedValueOnce(
      new Error("sensitive-provider-read-error"),
    );
    try {
      await expect(
        presalesV2ReconcileTestHooks.reconcileTask(
          harness.current().localTaskId,
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        status: "attention_required",
        errorCode: "PROVIDER_RUN_DEADLINE_EXCEEDED",
      });
      expect(harness.providerCalls.listAllMessages).toHaveBeenCalledTimes(1);
      expect(harness.providerCalls.sendMessage).not.toHaveBeenCalled();
      expect(harness.providerCalls.createTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.stopTask).not.toHaveBeenCalled();
      expect(harness.providerCalls.deleteTask).not.toHaveBeenCalled();
      expect(JSON.stringify(info.mock.calls)).not.toContain(
        "sensitive-provider-read-error",
      );
    } finally {
      info.mockRestore();
    }
  });

  it("returns a side-effect-free 409 from the legacy repair route", async () => {
    const previousToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    const token = "presales-v2-no-repair-test-token-20260816";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    const app = express();
    app.use("/api/internal/presales/v2", presalesV2Router);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/tasks/00000000-0000-4000-8000-000000000099/repair`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-frontmind-service-token": token,
          },
          body: JSON.stringify({ idempotencyKey: "unused-fresh-task-only" }),
        },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "TASK_REPAIR_NOT_AVAILABLE",
          status: 409,
          retryable: false,
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousToken === undefined) {
        delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
      } else {
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = previousToken;
      }
    }
  });

  it("serves GET and POST safely for provider-bound revision-2 knowledge-base tasks without credentials", async () => {
    const previousToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    const previousAssetDirectory = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    const assetDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-presales-v2-legacy-kb-"),
    );
    const token = "presales-v2-legacy-kb-test-token-20260816";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;
    const records: PresalesV2TaskRecord[] = [];
    for (const [index, status] of (
      ["queued", "running", "result_pending"] as const
    ).entries()) {
      const acquired = await acquirePresalesV2Task({
        idempotencyKey: `legacy-kb-route-${status}-request`,
        requestHash: String(index + 1).repeat(64),
        projectId: `project-legacy-kb-${status}`,
        contract: {
          name: "website.knowledge-base-candidate",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.knowledge-base-candidate"],
        },
        profile: "frontmind-base",
        upstreamModel: "manus-1.6",
        credentialId: `00000000-0000-4000-8000-0000000000${index + 10}`,
        credentialVersion: 1,
      });
      if (acquired.state === "conflict") {
        throw new Error("unexpected legacy KB task conflict");
      }
      const record = await updatePresalesV2Task(
        acquired.record.localTaskId,
        (current) => ({
          ...current,
          status,
          providerTaskId: `provider-task-${status}`,
          resultDecoderRevision: 2,
          resultDeadlineAt:
            status === "result_pending" ? new Date(0).toISOString() : null,
        }),
      );
      if (!record) throw new Error("legacy KB task update failed");
      records.push(record);
    }

    const app = express();
    app.use("/api/internal/presales/v2", presalesV2Router);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/internal/presales/v2`;
      for (const record of records) {
        const getResponse = await fetch(
          `${baseUrl}/tasks/${record.localTaskId}`,
          { headers: { "x-frontmind-service-token": token } },
        );
        expect(getResponse.status).toBe(200);
        await expect(getResponse.json()).resolves.toMatchObject({
          localTaskId: record.localTaskId,
          status: record.status,
        });
        const postResponse = await fetch(
          `${baseUrl}/tasks/${record.localTaskId}/repair`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-frontmind-service-token": token,
            },
            body: JSON.stringify({
              idempotencyKey: `legacy-kb-route-repair-${record.status}`,
            }),
          },
        );
        expect(postResponse.status).toBe(409);
        await expect(postResponse.json()).resolves.toMatchObject({
          error: { code: "TASK_REPAIR_NOT_AVAILABLE", status: 409 },
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(assetDirectory, { force: true, recursive: true });
      if (previousToken === undefined) {
        delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
      } else {
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = previousToken;
      }
      if (previousAssetDirectory === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetDirectory;
      }
    }
  });

  it("returns route-specific safe contract errors without logging request values", async () => {
    const previousToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    const token = "presales-v2-contract-test-token-20260815";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = express();
    app.use("/api/internal/presales/v2", presalesV2Router);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/api/internal/presales/v2`;
      const headers = {
        "content-type": "application/json",
        "x-frontmind-service-token": token,
      };
      const asset = await fetch(`${baseUrl}/assets`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: "asset-contract-invalid-request",
          filename: "facts.pdf",
          temporary: "must-not-appear-in-logs",
        }),
      });
      expect(asset.status).toBe(400);
      await expect(asset.json()).resolves.toEqual({
        error: {
          code: "ASSET_CREATE_CONTRACT_INVALID",
          status: 400,
          retryable: false,
        },
      });

      const task = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: "project-contract-invalid",
          prompt: "recommend questions",
          localAssetIds: [
            {
              localAssetId: "00000000-0000-4000-8000-000000000003",
              filename: "facts.pdf",
              temporary: "must-not-appear-in-logs",
            },
          ],
          idempotencyKey: "task-contract-invalid-request",
          contract: {
            name: "website.question-recommendation",
            revision: 2,
            schemaHash:
              PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
          },
        }),
      });
      expect(task.status).toBe(400);
      await expect(task.json()).resolves.toEqual({
        error: {
          code: "TASK_CREATE_CONTRACT_INVALID",
          status: 400,
          retryable: false,
        },
      });

      const serializedLogs = JSON.stringify(warn.mock.calls);
      expect(serializedLogs).toContain("$.[unrecognized]");
      expect(serializedLogs).toContain("$.localAssetIds.0.[unrecognized]");
      expect(serializedLogs).not.toContain("temporary");
      expect(serializedLogs).not.toContain("must-not-appear-in-logs");
    } finally {
      warn.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousToken === undefined) {
        delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
      } else {
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = previousToken;
      }
    }
  });

  it("rejects an idempotent asset tombstone instead of replaying it as success", async () => {
    const previousToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    const previousAssetDirectory = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    const assetDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-presales-v2-asset-tombstone-"),
    );
    const token = "presales-v2-asset-tombstone-test-token-20260815";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;
    const acquired = await acquirePresalesV2Asset({
      idempotencyKey: "asset-tombstone-request-0001",
      requestHash: hashPresalesV2Request({
        projectId: "project-asset-tombstone",
        filename: "facts.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      }),
      projectId: "project-asset-tombstone",
      filename: "facts.pdf",
      mimeType: "application/pdf",
      expectedBytes: 3,
    });
    if (acquired.state === "conflict") throw new Error("unexpected conflict");
    await updatePresalesV2Asset(acquired.record.localAssetId, (record) => ({
      ...record,
      status: "deleted",
    }));

    const app = express();
    app.use("/api/internal/presales/v2", presalesV2Router);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/assets`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-frontmind-service-token": token,
          },
          body: JSON.stringify({
            projectId: "project-asset-tombstone",
            idempotencyKey: "asset-tombstone-request-0001",
            filename: "facts.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
          }),
        },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "ASSET_TOMBSTONED_RESET_REQUIRED",
          status: 409,
          retryable: false,
        },
      });
      await expect(
        readPresalesV2Asset(acquired.record.localAssetId),
      ).resolves.toMatchObject({ status: "deleted" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(assetDirectory, { force: true, recursive: true });
      if (previousToken === undefined) {
        delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
      } else {
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = previousToken;
      }
      if (previousAssetDirectory === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetDirectory;
      }
    }
  });

  it("serves an idempotent retained project acknowledgement without mutating tasks", async () => {
    const previousToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    const previousAssetDirectory = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    const assetDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "frontmind-presales-v2-project-delete-"),
    );
    const token = "presales-v2-project-delete-test-token-20260814";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;

    const app = express();
    app.use("/api/internal/presales/v2", presalesV2Router);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/internal/presales/v2/projects/project-acceptance-001/tasks`,
          {
            method: "DELETE",
            headers: { "x-frontmind-service-token": token },
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          schemaVersion: 1,
          projectId: "project-acceptance-001",
          status: "deleted",
          deletedTasks: 0,
          deletedFiles: 0,
          pendingReservations: 0,
        });
      }

      const pendingRecord = await acquirePresalesV2Task({
        idempotencyKey: "pending-project-task-delete-test",
        requestHash: "f".repeat(64),
        projectId: "project-pending-001",
        contract: {
          name: "website.question-recommendation",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
        },
        profile: "frontmind-pro",
        upstreamModel: "manus-1.6-max",
        credentialId: "00000000-0000-4000-8000-000000000099",
        credentialVersion: 1,
      });
      const pending = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/projects/project-pending-001/tasks`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(pending.status).toBe(200);
      expect(await pending.json()).toEqual({
        schemaVersion: 1,
        projectId: "project-pending-001",
        status: "deleted",
        deletedTasks: 0,
        deletedFiles: 0,
        pendingReservations: 0,
      });
      await expect(
        readPresalesV2Task(pendingRecord.record.localTaskId),
      ).resolves.toMatchObject({
        status: "queued",
        providerTaskId: null,
        resultDecoderRevision: 3,
      });

      const revokedRecord = await acquirePresalesV2Task({
        idempotencyKey: "revoked-project-task-delete-test",
        requestHash: "e".repeat(64),
        projectId: "project-revoked-001",
        contract: {
          name: "website.knowledge-base-candidate",
          revision: 2,
          schemaHash:
            PRESALES_V2_CONTRACT_HASHES["website.knowledge-base-candidate"],
        },
        profile: "frontmind-base",
        upstreamModel: "manus-1.6",
        credentialId: "00000000-0000-4000-8000-000000000098",
        credentialVersion: 1,
      });
      expect(revokedRecord.record.resultDecoderRevision).toBe(3);
      await updatePresalesV2Task(
        revokedRecord.record.localTaskId,
        (record) => ({
          ...record,
          providerTaskId: "provider-task-from-revoked-key",
          status: "succeeded",
        }),
      );
      const revoked = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/projects/project-revoked-001/tasks`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({
        status: "deleted",
        deletedTasks: 0,
        pendingReservations: 0,
      });
      await expect(
        readPresalesV2Task(revokedRecord.record.localTaskId),
      ).resolves.toMatchObject({
        status: "succeeded",
        providerTaskId: "provider-task-from-revoked-key",
      });

      const retainedTask = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/tasks/${revokedRecord.record.localTaskId}`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(retainedTask.status).toBe(204);
      await expect(
        readPresalesV2Task(revokedRecord.record.localTaskId),
      ).resolves.toMatchObject({
        status: "succeeded",
        providerTaskId: "provider-task-from-revoked-key",
      });

      const retainedAsset = await acquirePresalesV2Asset({
        idempotencyKey: "retained-project-asset-delete-test",
        requestHash: "d".repeat(64),
        projectId: "project-revoked-001",
        filename: "retained.pdf",
        mimeType: "application/pdf",
        expectedBytes: 3,
      });
      if (retainedAsset.state === "conflict") {
        throw new Error("unexpected retained asset conflict");
      }
      const retainedFile = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/v2/assets/${retainedAsset.record.localAssetId}`,
        {
          method: "DELETE",
          headers: { "x-frontmind-service-token": token },
        },
      );
      expect(retainedFile.status).toBe(204);
      await expect(
        readPresalesV2Asset(retainedAsset.record.localAssetId),
      ).resolves.toMatchObject({ status: "pending" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(assetDirectory, { force: true, recursive: true });
      if (previousToken === undefined) {
        delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
      } else {
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = previousToken;
      }
      if (previousAssetDirectory === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetDirectory;
      }
    }
  });
});
