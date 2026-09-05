import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import axios, {
  AxiosHeaders,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from "axios";
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
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  knowledgeBaseWorkingSets,
  localAssets,
  messages,
  upstreamResources,
  userDashboardContents,
} from "../drizzle/schema";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import { knowledgeBaseLocalUploadHeaders } from "../shared/knowledge-base-local-upload";
import { KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT } from "../shared/knowledge-base-message";
import { knowledgeBaseLocalAssetIdentity } from "../server/knowledge-base-local-asset-upload";
import { knowledgeBaseMarkdownSha256 } from "../server/knowledge-base-package-validation";
import { KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME } from "../server/knowledge-base-prompt-delivery";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "../server/knowledge-base-tree-policy-rollout";

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
  apiKey: "",
}));

vi.mock("../server/db", () => ({ getDb: dependencies.getDb }));

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
      username: "frontmind-materialized-mysql-e2e",
      displayName: SYNTHETIC_COMPANY,
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
      label: "Synthetic materialized MySQL E2E credential",
      apiKey: dependencies.apiKey,
      fingerprint: dependencies.credentialFingerprint,
      agentProfile: "frontmind-pro",
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

const ACCEPTANCE_ENV = "FRONTMIND_KB_MANUS_V2_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_KB_MANUS_V2_MYSQL_ACCEPTANCE_REQUIRED";
const DATABASE_MARKER = "frontmind_kb_acceptance";
const REPOSITORY_ROOT = path.resolve(process.cwd());
const SYNTHETIC_COMPANY = "合成示例企业";
const SYNTHETIC_WEBSITE = "https://synthetic.invalid/";
const MATERIALIZED_LEAF_COUNT = 30;
const INCIDENT_CUSTOMER_ATTACHMENT_COUNT = 9;
const PROVIDER_BASE_URL = "https://fake.manus-v2.frontmind.test";
const PROVIDER_UPLOAD_ORIGIN = "https://upload.manus-v2.frontmind.test";
const PROVIDER_DOWNLOAD_ORIGIN = "https://download.manus-v2.frontmind.test";
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const RESEARCH_DIMENSION_IDS = [
  "enterprise_identity",
  "team_and_organization",
  "products_and_services",
  "capabilities_and_delivery",
  "industries_scenarios_and_cases",
  "differentiation_and_evidence",
  "cooperation_delivery_and_support",
] as const;

type AcceptanceTarget = { url: string; databaseName: string };

export function parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(
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
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
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

function messagePrompt(body: any) {
  const parts = Array.isArray(body?.message?.content)
    ? body.message.content
    : [];
  const text = parts.find((part: any) => part?.type === "text")?.text;
  if (typeof text !== "string" || !text) {
    throw new Error("FAKE_MANUS_V2_TEXT_PART_MISSING");
  }
  return text;
}

function requestBody(config: InternalAxiosRequestConfig) {
  if (typeof config.data !== "string") return config.data;
  try {
    return JSON.parse(config.data);
  } catch {
    return config.data;
  }
}

function uploadBytes(value: unknown) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("FAKE_MANUS_V2_UPLOAD_BYTES_INVALID");
}

const INLINE_MIME_TYPE_PATTERN =
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:;[ \t]*[A-Za-z0-9!#$%&'*+.^_`|~-]+=[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/u;

function materializeTaskAttachment(attachment: any) {
  const filename =
    typeof attachment?.filename === "string" ? attachment.filename : "";
  if (!filename || filename.length > 512) {
    throw new Error("FAKE_MANUS_V2_ATTACHMENT_FILENAME_INVALID");
  }
  const hasFileId =
    typeof attachment?.file_id === "string" && attachment.file_id.length > 0;
  const hasFileData =
    typeof attachment?.file_data === "string" &&
    attachment.file_data.length > 0;
  if (hasFileId === hasFileData) {
    throw new Error("FAKE_MANUS_V2_ATTACHMENT_SOURCE_INVALID");
  }
  if (hasFileId) {
    if (attachment.mime_type !== undefined) {
      throw new Error("FAKE_MANUS_V2_FILE_ID_MIME_FORBIDDEN");
    }
    return {
      source: "file_id" as const,
      filename,
      fileId: attachment.file_id as string,
    };
  }
  if (attachment.file_id !== undefined) {
    throw new Error("FAKE_MANUS_V2_INLINE_FILE_ID_FORBIDDEN");
  }
  const mimeType =
    typeof attachment?.mime_type === "string" ? attachment.mime_type : "";
  if (
    !mimeType ||
    mimeType.length > 255 ||
    !INLINE_MIME_TYPE_PATTERN.test(mimeType)
  ) {
    throw new Error("FAKE_MANUS_V2_INLINE_MIME_INVALID");
  }
  const prefix = `data:${mimeType};base64,`;
  if (!attachment.file_data.startsWith(prefix)) {
    throw new Error("FAKE_MANUS_V2_INLINE_DATA_URL_INVALID");
  }
  const encoded = attachment.file_data.slice(prefix.length);
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw new Error("FAKE_MANUS_V2_INLINE_BASE64_INVALID");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 1 || bytes.toString("base64") !== encoded) {
    throw new Error("FAKE_MANUS_V2_INLINE_BASE64_NON_CANONICAL");
  }
  return {
    source: "file_data" as const,
    filename,
    bytes,
    contentType: mimeType,
  };
}

function axiosResponse(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
  return {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "ERROR",
    headers: new AxiosHeaders(headers),
    config,
    data,
  };
}

function syntheticLeaf(index: number) {
  const leafId = `1.${index + 1}`;
  const title = `合成知识节点 ${index + 1}`;
  const visibleMarkdown = `# ${title}\n\n## 核心事实\n\n本验收节点只包含“合成产品代号 A”的完全合成资料，用于证明 Dashboard 一次物化全部内容、只在本地确认并生成最终客户包。节点编号为 ${leafId}，不引用任何客户文档、生产任务或真实 API 凭证。`;
  return { leafId, title, visibleMarkdown };
}

const syntheticLeaves = Array.from(
  { length: MATERIALIZED_LEAF_COUNT },
  (_, index) => syntheticLeaf(index),
);

function promptValue(prompt: string, key: string) {
  const prefix = `${key}=`;
  const line = prompt
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`FAKE_MANUS_V2_PROMPT_COORDINATE_MISSING:${key}`);
  return line.slice(prefix.length).trim();
}

async function buildSyntheticMaterializedWorkingSet(prompt: string) {
  expect(prompt).toContain("operation=materialize_initial_bundle");
  expect(prompt).toContain("一次生成全部 30–115 个真实叶子");
  expect(prompt).not.toContain("FRONTMIND_MANUS_V2_OPERATION_CONTRACT=");
  const coordinates = {
    operationId: promptValue(prompt, "operationId"),
    buildId: promptValue(prompt, "buildId"),
    generation: Number(promptValue(prompt, "generation")),
    contentVersion: Number(promptValue(prompt, "contentVersion")),
    companyName: promptValue(prompt, "company.name"),
    companyWebsite: promptValue(prompt, "company.website"),
  };
  expect(JSON.parse(promptValue(prompt, "researchWebsites"))).toEqual([
    SYNTHETIC_WEBSITE,
  ]);
  expect(coordinates).toMatchObject({ generation: 1, contentVersion: 1 });
  const zip = new JSZip();
  const logoBytes = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 63, g: 37, b: 116, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  zip.file("assets/official-logo.png", logoBytes, {
    date: FIXED_ZIP_DATE,
    createFolders: false,
  });
  const evidenceLedger = Array.from({ length: 12 }, (_, index) => {
    const path = `evidence/${String(index + 1).padStart(4, "0")}.md`;
    const content = `# 合成公开信源 ${index + 1}\n\n本文件仅用于验证 Working Set 的证据账本与研究覆盖计数一致，不包含任何客户资料。`;
    zip.file(path, content, {
      date: FIXED_ZIP_DATE,
      createFolders: false,
    });
    return {
      path,
      sha256: sha256(content),
      leafId: syntheticLeaves[index]!.leafId,
      sourceUrl: `https://example.test/research/${index + 1}`,
      retrievedAt: FIXED_ZIP_DATE.toISOString(),
    };
  });
  const leaves = syntheticLeaves.map((leaf, index) => {
    const contentPath = `nodes/${String(index + 1).padStart(4, "0")}.md`;
    zip.file(contentPath, leaf.visibleMarkdown, {
      date: FIXED_ZIP_DATE,
      createFolders: false,
    });
    return {
      leafId: leaf.leafId,
      branchId: "synthetic-products",
      branchTitle: "合成产品",
      title: leaf.title,
      ordinal: index,
      contentPath,
      contentSha256: sha256(leaf.visibleMarkdown),
      evidencePaths:
        index < evidenceLedger.length ? [evidenceLedger[index]!.path] : [],
      assetIds: [],
    };
  });
  const manifest = {
    kind: "frontmind.kb-working-set",
    schemaVersion: 1,
    operationId: coordinates.operationId,
    buildId: coordinates.buildId,
    generation: coordinates.generation,
    contentVersion: coordinates.contentVersion,
    skill: {
      name: "socratic-kb-builder",
      version: "5",
      contentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    },
    treePolicyVersion: 2,
    company: {
      name: coordinates.companyName,
      website:
        coordinates.companyWebsite === "null"
          ? null
          : coordinates.companyWebsite,
    },
    researchCoverage: {
      officialPages: {
        discovered: 12,
        attempted: 12,
        succeeded: 12,
        failed: 0,
      },
      publicQueries: 6,
      officialDocuments: 0,
      uploadsRead: 0,
      sourceCount: evidenceLedger.length,
      productFamilies: [
        {
          id: "synthetic-product",
          name: "合成产品代号 A",
          leafIds: leaves.map((leaf) => leaf.leafId),
        },
      ],
      dimensions: RESEARCH_DIMENSION_IDS.map((id, index) => ({
        id,
        status: "covered",
        leafIds: [leaves[index]!.leafId],
      })),
      stopReason: "coverage_complete",
    },
    branches: [
      { branchId: "synthetic-products", title: "合成产品", ordinal: 0 },
    ],
    evidenceLedger,
    leaves,
    assets: [
      {
        assetId: "official-logo",
        path: "assets/official-logo.png",
        sha256: sha256(logoBytes),
        mimeType: "image/png",
        bytes: logoBytes.length,
        width: 2,
        height: 2,
        provenance: { kind: "synthetic-acceptance" },
        documentIds: [],
      },
    ],
    logo: { status: "available", assetId: "official-logo" },
    counts: {
      leaves: MATERIALIZED_LEAF_COUNT,
      evidenceFiles: evidenceLedger.length,
      assets: 1,
    },
  };
  zip.file("BUNDLE.json", JSON.stringify(manifest), {
    date: FIXED_ZIP_DATE,
    createFolders: false,
  });
  return {
    filename: `frontmind-kb-bundle-${coordinates.operationId}.zip`,
    bytes: await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
  };
}

type FakeProviderState = {
  adapter: AxiosAdapter;
  fileUploads: Array<{ id: string; filename: string }>;
  fileDetailCalls: string[];
  uploadedFiles: Map<
    string,
    { filename: string; bytes: Buffer | null; contentType: string | null }
  >;
  taskCreateBodies: any[];
  taskSendBodies: any[];
  taskUpdateBodies: any[];
  taskListCalls: number;
  providerCalls: string[];
  rejectProviderCalls: boolean;
  rejectedCallCount: number;
  bundleDownloads: number;
  taskId: string;
  taskEvents: Map<string, Array<Record<string, unknown>>>;
};

function createFakeManusV2Provider(input: {
  apiKey: string;
  taskId: string;
}): FakeProviderState {
  let fileSequence = 0;
  let eventSequence = 0;
  const uploadedFiles: FakeProviderState["uploadedFiles"] = new Map();
  const taskEvents: FakeProviderState["taskEvents"] = new Map();
  const state: FakeProviderState = {
    adapter: undefined as unknown as AxiosAdapter,
    fileUploads: [],
    fileDetailCalls: [],
    uploadedFiles,
    taskCreateBodies: [],
    taskSendBodies: [],
    taskUpdateBodies: [],
    taskListCalls: 0,
    providerCalls: [],
    rejectProviderCalls: false,
    rejectedCallCount: 0,
    bundleDownloads: 0,
    taskId: input.taskId,
    taskEvents,
  };

  const assertProviderCredential = (config: InternalAxiosRequestConfig) => {
    const headers = AxiosHeaders.from(config.headers);
    expect(headers.get("x-manus-api-key")).toBe(input.apiKey);
    expect(headers.has("authorization")).toBe(false);
  };

  const appendMaterializedEvents = async (taskId: string, body: any) => {
    const prompt = messagePrompt(body);
    expect(body.structured_output_schema).toBeUndefined();
    expect(body.locale).toBe("zh-CN");
    const attachments = (body.message.content as any[]).filter(
      (part) => part?.type === "file",
    );
    const materializedAttachments = attachments.map((attachment) => {
      const materialized = materializeTaskAttachment(attachment);
      if (materialized.source === "file_data") return materialized;
      const file = uploadedFiles.get(materialized.fileId);
      if (!file?.bytes?.length) {
        throw new Error("FAKE_MANUS_V2_REFERENCED_FILE_NOT_UPLOADED");
      }
      expect(materialized.filename).toBe(file.filename);
      return {
        ...materialized,
        bytes: file.bytes,
        contentType: file.contentType,
      };
    });
    const instructionsAttachment = materializedAttachments.find(
      (attachment) =>
        attachment.filename === KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
    );
    if (!instructionsAttachment) {
      throw new Error("FAKE_MANUS_V2_INSTRUCTIONS_MISSING");
    }
    if (instructionsAttachment.source !== "file_data") {
      throw new Error("FAKE_MANUS_V2_INSTRUCTIONS_MUST_BE_INLINE");
    }
    expect(instructionsAttachment.contentType).toBe(
      "text/plain; charset=utf-8",
    );
    const instructions = new TextDecoder("utf-8", { fatal: true }).decode(
      instructionsAttachment.bytes,
    );
    expect(prompt).toContain(KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME);
    expect(prompt).toContain(`SHA-256=${sha256(instructions)}`);
    expect(prompt).not.toContain("operation=materialize_initial_bundle");
    const bundle = await buildSyntheticMaterializedWorkingSet(instructions);
    const at = Date.now() + eventSequence * 10;
    taskEvents.set(taskId, [
      {
        id: `event-user-${++eventSequence}`,
        type: "user_message",
        timestamp: at,
        user_message: { content: prompt },
      },
      {
        id: `event-bundle-${++eventSequence}`,
        type: "assistant_message",
        timestamp: at + 1,
        assistant_message: {
          content: "",
          attachments: [
            {
              type: "file",
              filename: bundle.filename,
              content_type: "application/zip",
              url: `${PROVIDER_DOWNLOAD_ORIGIN}/${encodeURIComponent(taskId)}/${encodeURIComponent(bundle.filename)}`,
            },
          ],
        },
      },
      {
        id: `event-status-${++eventSequence}`,
        type: "status_update",
        timestamp: at + 2,
        status_update: { agent_status: "stopped" },
      },
    ]);
    uploadedFiles.set(`bundle:${taskId}`, {
      filename: bundle.filename,
      bytes: bundle.bytes,
      contentType: "application/zip",
    });
  };

  state.adapter = async (config) => {
    const method = String(config.method || "get").toLowerCase();
    const url = new URL(String(config.url || ""), PROVIDER_BASE_URL);
    state.providerCalls.push(`${method}:${url.origin}${url.pathname}`);
    if (state.rejectProviderCalls) {
      state.rejectedCallCount += 1;
      throw new Error("FAKE_MANUS_V2_CREDENTIAL_REVOKED");
    }

    if (url.origin === PROVIDER_DOWNLOAD_ORIGIN && method === "get") {
      const taskId = decodeURIComponent(url.pathname.split("/")[1] || "");
      const bundle = uploadedFiles.get(`bundle:${taskId}`);
      if (!bundle?.bytes) throw new Error("FAKE_MANUS_V2_BUNDLE_NOT_FOUND");
      state.bundleDownloads += 1;
      return axiosResponse(config, 200, Readable.from(bundle.bytes), {
        "content-type": "application/zip",
        "content-length": String(bundle.bytes.length),
        "content-disposition": `attachment; filename="${bundle.filename}"`,
      });
    }

    if (url.origin === PROVIDER_UPLOAD_ORIGIN && method === "put") {
      const fileId = decodeURIComponent(url.pathname.split("/").at(-1) || "");
      const file = uploadedFiles.get(fileId);
      if (!file) throw new Error("FAKE_MANUS_V2_UPLOAD_FILE_NOT_FOUND");
      const bytes = uploadBytes(config.data);
      file.bytes = bytes;
      file.contentType = String(
        AxiosHeaders.from(config.headers).get("content-type") ||
          "application/octet-stream",
      );
      expect(
        String(AxiosHeaders.from(config.headers).get("content-length")),
      ).toBe(String(bytes.length));
      return axiosResponse(config, 200, { ok: true });
    }

    if (url.origin !== PROVIDER_BASE_URL) {
      throw new Error(`FAKE_MANUS_V2_UNEXPECTED_ORIGIN:${url.origin}`);
    }
    assertProviderCredential(config);

    if (method === "post" && url.pathname === "/v2/file.upload") {
      const body = requestBody(config) as { filename?: unknown };
      const filename = String(body?.filename || "");
      expect(filename).toBeTruthy();
      const fileId = `fake-v2-file-${++fileSequence}`;
      uploadedFiles.set(fileId, { filename, bytes: null, contentType: null });
      state.fileUploads.push({ id: fileId, filename });
      return axiosResponse(config, 200, {
        ok: true,
        file: { id: fileId, filename },
        upload_url: `${PROVIDER_UPLOAD_ORIGIN}/content/${encodeURIComponent(fileId)}`,
        upload_expires_at: Math.floor(Date.now() / 1_000) + 180,
        request_id: `request-file-${fileSequence}`,
      });
    }

    if (method === "get" && url.pathname === "/v2/file.detail") {
      const fileId = String((config.params as any)?.file_id || "");
      const file = uploadedFiles.get(fileId);
      if (!file) {
        return axiosResponse(config, 404, {
          ok: false,
          error: { code: "FILE_NOT_FOUND" },
        });
      }
      state.fileDetailCalls.push(fileId);
      return axiosResponse(config, 200, {
        ok: true,
        file: {
          id: fileId,
          filename: file.filename,
          status: file.bytes ? "uploaded" : "pending",
          bytes: file.bytes?.length ?? null,
          expires_at: Math.floor(Date.now() / 1_000) + 48 * 60 * 60,
          content_type: file.contentType,
        },
        request_id: `request-detail-${state.fileDetailCalls.length}`,
      });
    }

    if (method === "post" && url.pathname === "/v2/task.create") {
      const body = requestBody(config) as any;
      state.taskCreateBodies.push(body);
      expect(state.taskCreateBodies).toHaveLength(1);
      expect(body).toMatchObject({
        interactive_mode: false,
        hide_in_task_list: false,
        share_visibility: "private",
        locale: "zh-CN",
      });
      expect(body.title).toEqual(expect.any(String));
      await appendMaterializedEvents(input.taskId, body);
      return axiosResponse(config, 200, {
        ok: true,
        task_id: input.taskId,
        task_url: `https://manus.im/app/${input.taskId}`,
        task_title: body.title,
        request_id: "request-task-create-1",
      });
    }

    if (method === "post" && url.pathname === "/v2/task.sendMessage") {
      state.taskSendBodies.push(requestBody(config));
      throw new Error("MATERIALIZED_ACCEPTANCE_FORBIDS_TASK_SEND_MESSAGE");
    }

    if (method === "get" && url.pathname === "/v2/task.listMessages") {
      state.taskListCalls += 1;
      const taskId = String((config.params as any)?.task_id || "");
      expect(taskId).toBe(input.taskId);
      return axiosResponse(config, 200, {
        ok: true,
        task_id: taskId,
        messages: taskEvents.get(taskId) || [],
        has_more: false,
        next_cursor: null,
        request_id: `request-task-list-${state.taskListCalls}`,
      });
    }

    if (method === "post" && url.pathname === "/v2/task.update") {
      const body = requestBody(config) as any;
      state.taskUpdateBodies.push(body);
      expect(body).toEqual({
        task_id: input.taskId,
        enable_visible_in_task_list: true,
      });
      return axiosResponse(config, 200, {
        ok: true,
        task_id: input.taskId,
        request_id: `request-task-update-${state.taskUpdateBodies.length}`,
      });
    }

    throw new Error(
      `FAKE_MANUS_V2_UNEXPECTED_REQUEST:${method}:${url.pathname}`,
    );
  };
  return state;
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

async function waitFor<T>(input: {
  label: string;
  read: () => Promise<T>;
  accept: (value: T) => boolean;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (input.timeoutMs ?? 45_000);
  let last: T | undefined;
  do {
    last = await input.read();
    if (input.accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(
    `${input.label} did not settle: ${JSON.stringify(last, null, 2)}`,
  );
}

describe("knowledge-base materialized Manus v2 MySQL E2E URL guard", () => {
  it("accepts only an explicitly named disposable MySQL acceptance database", () => {
    expect(
      parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(
        "mysql://tester:secret@127.0.0.1:3306/frontmind_kb_acceptance_materialized_ci_01",
      ).databaseName,
    ).toBe("frontmind_kb_acceptance_materialized_ci_01");
    for (const unsafe of [
      undefined,
      "postgres://tester:secret@127.0.0.1/frontmind_kb_acceptance_materialized",
      "mysql://tester:secret@127.0.0.1/frontmind_materialized_production",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance/other",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance?database=production",
    ]) {
      expect(() =>
        parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(unsafe),
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
  "knowledge-base materialized v5 controllers on disposable real MySQL",
  () => {
    let pool: Pool;
    let executor: ReturnType<typeof drizzle>;
    let assetRoot = "";
    let dashboardServer: Server | undefined;
    let dashboardBaseUrl = "";
    let userId: number | null = null;
    let fakeProvider: FakeProviderState;
    let acceptancePassed = false;
    const runId = randomUUID().replaceAll("-", "");
    const publicConversationId = `kb-materialized-e2e-${runId}`;
    const credentialId = randomUUID();
    const upstreamApiKey = "sk-synthetic-materialized-mysql-e2e-only";
    const credentialFingerprint = `fp_${sha256(upstreamApiKey).slice(0, 16)}`;
    const initialTaskId = `task-v2-materialized-${runId}`;
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    const previousTreePolicyWriter =
      process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
    const previousManusV2Writer = process.env.FRONTMIND_KB_MANUS_V2_WRITER;
    const previousUpstreamBaseUrl = process.env.FRONTMIND_UPSTREAM_BASE_URL;
    const previousCredentialEncryptionKey =
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    const previousAxiosAdapter = axios.defaults.adapter;

    const getProgress = async () => {
      const response = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base/progress/${encodeURIComponent(publicConversationId)}`,
        { headers: { "x-test-auth": "user" } },
      );
      const payload = (await response.json()) as any;
      if (response.status !== 200) {
        throw new Error(
          `/progress returned ${response.status}: ${JSON.stringify(payload)}`,
        );
      }
      if (payload.observation?.interaction?.interactionState === "failed") {
        throw new Error(
          `knowledge-base projection failed: ${JSON.stringify(payload.observation.notice)}`,
        );
      }
      return payload;
    };

    const postKnowledgeBase = async (
      pathname:
        | "/start/reserve"
        | "/turn/reserve"
        | "/turn/attachments/stage"
        | "/turn/attachments/resume"
        | "/turn/attachments/cancel"
        | "/turn/dispatch"
        | "/confirm",
      body: Record<string, unknown>,
    ) => {
      const response = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base${pathname}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify(body),
        },
      );
      const payload = (await response.json()) as any;
      if (![200, 201, 202].includes(response.status)) {
        throw new Error(
          `${pathname} returned ${response.status}: ${JSON.stringify(payload)}`,
        );
      }
      return payload;
    };

    const uploadKnowledgeBaseLocalAsset = async (input: {
      conversationId: string;
      turnId: string;
      clientRequestId: string;
      expectedResetRevision: number;
      itemId: string;
      ordinal: number;
      filename: string;
      mimeType: string;
      bytes: Buffer;
    }) => {
      const response = await fetch(
        `${dashboardBaseUrl}/api/frontmind/v2/assets`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-frontmind-filename": encodeURIComponent(input.filename),
            "x-frontmind-mime": input.mimeType,
            "x-frontmind-size": String(input.bytes.length),
            "x-test-auth": "user",
            ...knowledgeBaseLocalUploadHeaders(
              {
                conversationId: input.conversationId,
                turnId: input.turnId,
                clientRequestId: input.clientRequestId,
                itemId: input.itemId,
                expectedResetRevision: input.expectedResetRevision,
                ordinal: input.ordinal,
              },
              1,
            ),
          },
          body: input.bytes,
        },
      );
      const payload = (await response.json()) as any;
      if (![200, 201].includes(response.status)) {
        throw new Error(
          `/api/frontmind/v2/assets returned ${response.status}: ${JSON.stringify(payload)}`,
        );
      }
      return payload;
    };

    beforeAll(async () => {
      const target =
        parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(acceptanceUrl);
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
      expect(
        journal.entries.some((entry) => entry.tag === "0062_hard_glorian"),
      ).toBe(true);
      const [engineRows] = await pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS tableName, ENGINE AS engine
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN (
              'knowledge_base_builds', 'knowledge_base_build_nodes',
              'knowledge_base_working_sets', 'knowledge_base_executions',
              'conversation_turns', 'conversations', 'messages',
              'upstream_resources'
            )`,
      );
      expect(engineRows).toHaveLength(8);
      expect(engineRows.every((row) => row.engine === "InnoDB")).toBe(true);

      const [userResult] = await pool.execute<ResultSetHeader>(
        `INSERT INTO users
           (openId, username, displayName, role, marketEdition, isActive)
         VALUES (?, ?, ?, 'user', 'domestic', 1)`,
        [
          `kb-materialized-${runId}`.slice(0, 64),
          `kb_materialized_${runId}`.slice(0, 64),
          SYNTHETIC_COMPANY,
        ],
      );
      userId = userResult.insertId;
      dependencies.userId = userId;
      dependencies.credentialId = credentialId;
      dependencies.credentialFingerprint = credentialFingerprint;
      dependencies.apiKey = upstreamApiKey;
      dependencies.upstreamBaseUrl = PROVIDER_BASE_URL;

      await executor.insert(apiCredentials).values({
        id: credentialId,
        userId,
        version: 1,
        encryptionVersion: 1,
        encryptedKey: "synthetic-acceptance-placeholder",
        encryptionIv: "synthetic-acceptance-placeholder",
        encryptionAuthTag: "synthetic-acceptance-placeholder",
        fingerprint: credentialFingerprint,
        agentProfile: "frontmind-pro",
        status: "active",
        validationStatus: "verified",
        verifiedAt: new Date(),
      });
      await executor.insert(userDashboardContents).values({
        userId,
        payload: createDefaultDashboardPayload(SYNTHETIC_COMPANY),
        sourceName: "synthetic-materialized-mysql-e2e.json",
        enterpriseIdentityBoundAt: new Date(),
        revision: 1,
      });

      const decryptedCredential = {
        id: credentialId,
        userId,
        version: 1,
        apiKey: upstreamApiKey,
        fingerprint: credentialFingerprint,
        agentProfile: "frontmind-pro",
        upstreamModel: "manus-1.6-max" as const,
        status: "active",
        validationStatus: "verified",
        verifiedAt: new Date(),
      };
      dependencies.getDb.mockResolvedValue(executor);
      dependencies.assertServiceCapability.mockResolvedValue(undefined);
      dependencies.assertKnowledgeBaseWritable.mockResolvedValue(undefined);
      dependencies.createKnowledgeMonitoringHandoff.mockResolvedValue({
        created: [],
        assigned: false,
      });
      dependencies.getCredentialForUpstreamResource.mockResolvedValue(
        decryptedCredential,
      );
      dependencies.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockResolvedValue(
        decryptedCredential,
      );
      dependencies.recordUpstreamResource.mockResolvedValue(undefined);

      assetRoot = await mkdtemp(
        path.join(tmpdir(), "frontmind-kb-materialized-mysql-e2e-"),
      );
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
      process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER = "true";
      process.env.FRONTMIND_KB_MANUS_V2_WRITER = "true";
      process.env.FRONTMIND_UPSTREAM_BASE_URL = PROVIDER_BASE_URL;
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 73).toString("base64")}`;

      fakeProvider = createFakeManusV2Provider({
        apiKey: upstreamApiKey,
        taskId: initialTaskId,
      });
      axios.defaults.adapter = fakeProvider.adapter;

      const { default: knowledgeBaseRouter } = await import(
        "../server/knowledge-base-api"
      );
      const { default: artifactRouter } = await import(
        "../server/knowledge-base-artifact-api"
      );
      const { default: dashboardRouter } = await import(
        "../server/dashboard-api"
      );
      const { default: frontmindV2ChatRouter } = await import(
        "../server/frontmind-v2-chat-router"
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
      dashboard.use(
        "/api/frontmind/v2",
        requireExpressAuth,
        frontmindV2ChatRouter,
      );
      dashboard.use("/api/dashboard", dashboardRouter);
      const listener = await listen(dashboard);
      dashboardServer = listener.server;
      dashboardBaseUrl = listener.baseUrl;
    }, 300_000);

    afterAll(async () => {
      let cleanupError: unknown;
      const preserveCleanupError = (error: unknown) => {
        if (!cleanupError) cleanupError = error;
      };
      try {
        await close(dashboardServer);
      } catch (error) {
        preserveCleanupError(error);
      }
      try {
        if (pool && userId) {
          await pool.execute(
            "DELETE FROM upstream_resources WHERE userId = ?",
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
      const restoreEnvironment = (
        key: string,
        previous: string | undefined,
      ) => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      };
      restoreEnvironment("FRONTMIND_DASHBOARD_ASSET_DIR", previousAssetRoot);
      restoreEnvironment(
        "FRONTMIND_KB_TREE_POLICY_V2_WRITER",
        previousTreePolicyWriter,
      );
      restoreEnvironment("FRONTMIND_KB_MANUS_V2_WRITER", previousManusV2Writer);
      restoreEnvironment(
        "FRONTMIND_UPSTREAM_BASE_URL",
        previousUpstreamBaseUrl,
      );
      restoreEnvironment(
        "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
        previousCredentialEncryptionKey,
      );
      if (cleanupError) throw cleanupError;
      if (acceptancePassed) {
        console.log("KB_MATERIALIZED_MYSQL_E2E_ACCEPTANCE_COMPLETE");
      }
    }, 120_000);

    it("creates one v2 task, recovers and releases a lost-response revise upload, confirms locally after revoke, and builds the final ZIP", async () => {
      expect(userId).not.toBeNull();
      const startRequest = {
        conversationId: publicConversationId,
        clientRequestId: `start-${runId}`,
        companyName: SYNTHETIC_COMPANY,
        companyWebsite: SYNTHETIC_WEBSITE,
        operatorNotes: "仅包含合成验收资料",
        attachmentManifest: [],
        expectedResetRevision: 0,
      };
      const reserved = await postKnowledgeBase("/start/reserve", startRequest);
      expect(reserved).toMatchObject({
        accepted: true,
        reservationCreated: true,
        reservation: {
          turnId: expect.any(String),
          requiresUpload: false,
        },
      });
      expect(fakeProvider.providerCalls).toHaveLength(0);

      await postKnowledgeBase("/turn/dispatch", {
        conversationId: publicConversationId,
        turnId: reserved.reservation.turnId,
        clientRequestId: startRequest.clientRequestId,
        attachmentManifest: [],
        expectedResetRevision: 0,
      });
      let progress = await waitFor({
        label: "initial complete materialized Working Set",
        read: getProgress,
        accept: (payload) =>
          payload.observation?.interaction?.interactionState ===
            "awaiting_input" &&
          payload.progress?.build?.contentVersion === 1 &&
          payload.progress?.summary?.total === MATERIALIZED_LEAF_COUNT &&
          payload.observation?.approvedPresentation?.leafId === "1.1",
      });
      expect(fakeProvider.taskCreateBodies).toHaveLength(1);
      expect(fakeProvider.taskSendBodies).toHaveLength(0);
      expect(fakeProvider.taskUpdateBodies).toHaveLength(0);
      expect(fakeProvider.bundleDownloads).toBe(1);
      expect(fakeProvider.fileUploads).toHaveLength(0);
      expect(fakeProvider.fileDetailCalls).toHaveLength(0);

      const build = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.conversationId, publicConversationId))
          .limit(1)
      )[0]!;
      expect(build).toMatchObject({
        executionMode: "materialized_bundle_v1",
        providerProtocol: "manus_v2",
        skillVersion: "5",
        skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
        contentVersion: 1,
        status: "confirming",
        revision: 0,
        currentLeafId: "1.1",
        totalNodeCount: MATERIALIZED_LEAF_COUNT,
        confirmedCount: 0,
        upstreamTaskId: null,
        canonicalTaskId: null,
      });
      expect(build.activeWorkingSetId).toEqual(expect.any(String));
      expect(build.logoSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(build.initialResearchCoverage).toEqual(
        expect.objectContaining({
          officialPages: expect.objectContaining({ succeeded: 12 }),
          publicQueries: 6,
          uploadsRead: 0,
          stopReason: "coverage_complete",
        }),
      );
      expect(build.handoffProvenance).toMatchObject({
        materializedQuality: {
          completeness: "complete",
          downstreamEligible: true,
          publishable: true,
        },
      });

      const workingSets = await executor
        .select()
        .from(knowledgeBaseWorkingSets)
        .where(eq(knowledgeBaseWorkingSets.buildId, build.id));
      expect(workingSets).toHaveLength(1);
      expect(workingSets[0]).toMatchObject({
        id: build.activeWorkingSetId,
        generation: 1,
        contentVersion: 1,
        status: "active",
      });

      const materializedNodes = await executor
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
        .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
      expect(materializedNodes).toHaveLength(MATERIALIZED_LEAF_COUNT);
      expect(materializedNodes[0]!.status).toBe("current");
      expect(
        materializedNodes.slice(1).every((node) => node.status === "pending"),
      ).toBe(true);
      expect(
        materializedNodes.every(
          (node, index) =>
            node.contentVersion === 1 &&
            node.contentMarkdown === syntheticLeaves[index]!.visibleMarkdown &&
            node.contentSha256 ===
              knowledgeBaseMarkdownSha256(
                syntheticLeaves[index]!.visibleMarkdown,
              ),
        ),
      ).toBe(true);

      // Production-incident shape: the browser reserved nine customer files
      // (plus the three v5 server-owned attachments), staged files 1-3, then
      // lost the response after Dashboard durably committed file 4. Recovery
      // must discover those bytes without dispatching and cancellation must
      // return the exact materialized leaf/Working Set to awaiting input.
      const incidentClientRequestId = `lost-upload-${runId}`;
      const incidentAttachments = Array.from(
        { length: INCIDENT_CUSTOMER_ATTACHMENT_COUNT },
        (_, index) => {
          const ordinal = index + 1;
          const bytes = Buffer.from(
            `synthetic lost-response attachment ${ordinal} ${runId}`,
            "utf8",
          );
          return {
            itemId: `incident-${runId.slice(0, 24)}-${ordinal}`,
            ordinal,
            total: INCIDENT_CUSTOMER_ATTACHMENT_COUNT,
            filename: `incident-attachment-${ordinal}.jpg`,
            mimeType: "image/jpeg",
            lastModified: FIXED_ZIP_DATE.getTime() + ordinal,
            sizeBytes: bytes.length,
            bytes,
          };
        },
      );
      const incidentManifest = incidentAttachments.map(
        ({ bytes: _bytes, ...entry }) => entry,
      );
      const invariantBeforeIncident = {
        currentLeafId: build.currentLeafId,
        revision: build.revision,
        contentVersion: build.contentVersion,
        currentPresentationKey: build.currentPresentationKey,
        activeWorkingSetId: build.activeWorkingSetId,
        workingSet: { ...workingSets[0]! },
        currentNode: { ...materializedNodes[0]! },
      };
      const providerCallsBeforeIncident = fakeProvider.providerCalls.length;
      const taskCreatesBeforeIncident = fakeProvider.taskCreateBodies.length;
      const incidentReservation = await postKnowledgeBase("/turn/reserve", {
        conversationId: publicConversationId,
        clientRequestId: incidentClientRequestId,
        userMessage: "补充九份完全合成的验收资料",
        attachmentManifest: incidentManifest,
        expectedGeneration: 1,
        expectedRevision: invariantBeforeIncident.revision,
        expectedResetRevision: 0,
        expectedLeafId: invariantBeforeIncident.currentLeafId,
        expectedPresentationKey: invariantBeforeIncident.currentPresentationKey,
      });
      expect(incidentReservation.reservation).toMatchObject({
        state: "awaiting_attachments",
        turnId: expect.any(String),
        clientRequestId: incidentClientRequestId,
        stagedAttachmentCount: 0,
        expectedAttachmentCount: INCIDENT_CUSTOMER_ATTACHMENT_COUNT,
        requiresUpload: true,
        createAttemptState: "not_sent",
      });
      const incidentTurnId = String(incidentReservation.reservation.turnId);
      const reservedIncidentTurn = (
        await executor
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.id, incidentTurnId))
          .limit(1)
      )[0]!;
      expect(reservedIncidentTurn).toMatchObject({
        operationType: "revise",
        status: "queued",
        upstreamTaskId: null,
        attachmentFileIds: [],
      });
      expect(reservedIncidentTurn.metadata).toMatchObject({
        userAttachmentCount: INCIDENT_CUSTOMER_ATTACHMENT_COUNT,
        expectedAttachmentCount: INCIDENT_CUSTOMER_ATTACHMENT_COUNT + 3,
        awaitingClientAttachments: true,
        attachmentsFrozen: false,
        clientStagedAttachments: [],
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        dispatchState: "reserved",
      });

      const uploadReceipts: any[] = [];
      for (const attachment of incidentAttachments.slice(0, 4)) {
        const receipt = await uploadKnowledgeBaseLocalAsset({
          conversationId: publicConversationId,
          turnId: incidentTurnId,
          clientRequestId: incidentClientRequestId,
          expectedResetRevision: 0,
          itemId: attachment.itemId,
          ordinal: attachment.ordinal,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
        });
        const identity = knowledgeBaseLocalAssetIdentity({
          userId: userId!,
          projectAssignmentId: null,
          coordinate: {
            conversationId: publicConversationId,
            turnId: incidentTurnId,
            clientRequestId: incidentClientRequestId,
            itemId: attachment.itemId,
            expectedResetRevision: 0,
            ordinal: attachment.ordinal,
          },
          sizeBytes: attachment.sizeBytes,
        });
        expect(receipt).toMatchObject({
          localAssetId: identity.localAssetId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          bytes: attachment.sizeBytes,
          sha256: sha256(attachment.bytes),
          replayed: false,
        });
        uploadReceipts.push(receipt);
      }

      for (let index = 0; index < 3; index += 1) {
        const attachment = incidentAttachments[index]!;
        const staged = await postKnowledgeBase("/turn/attachments/stage", {
          conversationId: publicConversationId,
          turnId: incidentTurnId,
          clientRequestId: incidentClientRequestId,
          attachmentManifest: incidentManifest,
          expectedResetRevision: 0,
          index,
          attachment: {
            file_id: uploadReceipts[index]!.localAssetId,
            filename: attachment.filename,
          },
        });
        expect(staged.reservation).toMatchObject({
          turnId: incidentTurnId,
          stagedAttachmentCount: index + 1,
          expectedAttachmentCount: INCIDENT_CUSTOMER_ATTACHMENT_COUNT,
          requiresUpload: true,
        });
      }

      const incidentBeforeResume = (
        await executor
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.id, incidentTurnId))
          .limit(1)
      )[0]!;
      expect(incidentBeforeResume.attachmentFileIds).toEqual(
        uploadReceipts.slice(0, 3).map((receipt) => receipt.localAssetId),
      );
      expect(
        (incidentBeforeResume.metadata as any).clientStagedAttachments,
      ).toHaveLength(3);
      const retainedFourth = (
        await executor
          .select()
          .from(localAssets)
          .where(eq(localAssets.id, uploadReceipts[3]!.localAssetId))
          .limit(1)
      )[0]!;
      expect(retainedFourth).toMatchObject({
        scope: "managed_user",
        accountUserId: userId,
        filename: incidentAttachments[3]!.filename,
        mimeType: incidentAttachments[3]!.mimeType,
        sizeBytes: incidentAttachments[3]!.sizeBytes,
        contentSha256: sha256(incidentAttachments[3]!.bytes),
      });

      const resumedIncident = await postKnowledgeBase(
        "/turn/attachments/resume",
        {
          conversationId: publicConversationId,
          turnId: incidentTurnId,
          clientRequestId: incidentClientRequestId,
          expectedResetRevision: 0,
        },
      );
      expect(resumedIncident).toMatchObject({
        stagedCustomerAttachmentCount: 4,
        retainedCustomerAttachmentCount: 4,
        readyToDispatch: false,
        missingCustomerAttachments: incidentManifest
          .slice(4)
          .map(({ total: _total, ...entry }) => entry),
        attachmentManifest: incidentManifest,
      });
      const incidentAfterResume = (
        await executor
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.id, incidentTurnId))
          .limit(1)
      )[0]!;
      expect(incidentAfterResume).toMatchObject({
        status: "queued",
        upstreamTaskId: null,
        attachmentFileIds: uploadReceipts.map(
          (receipt) => receipt.localAssetId,
        ),
      });
      expect(
        (incidentAfterResume.metadata as any).clientStagedAttachments,
      ).toHaveLength(4);
      expect(fakeProvider.providerCalls).toHaveLength(
        providerCallsBeforeIncident,
      );
      expect(fakeProvider.taskCreateBodies).toHaveLength(
        taskCreatesBeforeIncident,
      );

      const cancelledIncident = await postKnowledgeBase(
        "/turn/attachments/cancel",
        {
          conversationId: publicConversationId,
          turnId: incidentTurnId,
          clientRequestId: incidentClientRequestId,
          expectedResetRevision: 0,
        },
      );
      expect(cancelledIncident).toMatchObject({
        cancelled: true,
        knowledgeObservation: {
          interaction: { interactionState: "awaiting_input" },
          approvedPresentation: {
            leafId: invariantBeforeIncident.currentLeafId,
            presentationKey: invariantBeforeIncident.currentPresentationKey,
          },
        },
      });
      const [buildAfterIncident, workingSetAfterIncident, nodeAfterIncident] =
        await Promise.all([
          executor
            .select()
            .from(knowledgeBaseBuilds)
            .where(eq(knowledgeBaseBuilds.id, build.id))
            .limit(1)
            .then((rows) => rows[0]!),
          executor
            .select()
            .from(knowledgeBaseWorkingSets)
            .where(eq(knowledgeBaseWorkingSets.id, build.activeWorkingSetId!))
            .limit(1)
            .then((rows) => rows[0]!),
          executor
            .select()
            .from(knowledgeBaseBuildNodes)
            .where(eq(knowledgeBaseBuildNodes.id, materializedNodes[0]!.id))
            .limit(1)
            .then((rows) => rows[0]!),
        ]);
      expect(buildAfterIncident).toMatchObject({
        activeTurnId: null,
        status: "confirming",
        currentLeafId: invariantBeforeIncident.currentLeafId,
        revision: invariantBeforeIncident.revision,
        contentVersion: invariantBeforeIncident.contentVersion,
        currentPresentationKey: invariantBeforeIncident.currentPresentationKey,
        activeWorkingSetId: invariantBeforeIncident.activeWorkingSetId,
      });
      expect(workingSetAfterIncident).toEqual(
        invariantBeforeIncident.workingSet,
      );
      expect(nodeAfterIncident).toEqual(invariantBeforeIncident.currentNode);
      const cancelledIncidentTurn = (
        await executor
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.id, incidentTurnId))
          .limit(1)
      )[0]!;
      expect(cancelledIncidentTurn).toMatchObject({
        status: "cancelled",
        upstreamTaskId: null,
        errorCode: "KNOWLEDGE_BASE_REVISION_UPLOAD_CANCELLED",
      });
      const incidentConversation = (
        await executor
          .select()
          .from(conversations)
          .where(eq(conversations.id, cancelledIncidentTurn.conversationId))
          .limit(1)
      )[0]!;
      expect(incidentConversation.status).toBe("awaiting_input");
      expect(fakeProvider.providerCalls).toHaveLength(
        providerCallsBeforeIncident,
      );
      expect(fakeProvider.taskCreateBodies).toHaveLength(
        taskCreatesBeforeIncident,
      );
      progress = { observation: cancelledIncident.knowledgeObservation };

      await executor
        .update(apiCredentials)
        .set({
          status: "deleted",
          validationStatus: "invalid",
          deletedAt: new Date(),
        })
        .where(eq(apiCredentials.id, credentialId));
      fakeProvider.rejectProviderCalls = true;
      const providerCallsBeforeConfirmation = fakeProvider.providerCalls.length;

      for (let index = 0; index < MATERIALIZED_LEAF_COUNT; index += 1) {
        const leaf = syntheticLeaves[index]!;
        const observation = progress.observation;
        const observationProgress = observation.interaction.progress;
        expect(observation.approvedPresentation).toMatchObject({
          leafId: leaf.leafId,
          revision: index,
          visibleMarkdown: leaf.visibleMarkdown,
        });
        const confirmation = await postKnowledgeBase("/confirm", {
          conversationId: publicConversationId,
          clientRequestId: `confirm-${index + 1}-${runId}`,
          expectedGeneration: observation.generation,
          expectedResetRevision: 0,
          expectedStateEpoch: observation.stateEpoch,
          expectedRevision: observationProgress.build.revision,
          expectedLeafId: leaf.leafId,
          expectedPresentationKey:
            observation.approvedPresentation.presentationKey,
          expectedContentVersion: observationProgress.build.contentVersion,
        });
        expect(confirmation).toMatchObject({
          accepted: true,
          execution: "local",
          disposition:
            index === MATERIALIZED_LEAF_COUNT - 1 ? "completed" : "advanced",
        });
        expect(fakeProvider.providerCalls).toHaveLength(
          providerCallsBeforeConfirmation,
        );
        progress = { observation: confirmation.observation };
      }

      expect(fakeProvider.rejectedCallCount).toBe(0);
      expect(fakeProvider.taskCreateBodies).toHaveLength(1);
      expect(fakeProvider.taskSendBodies).toHaveLength(0);
      expect(progress.observation).toMatchObject({
        contentState: "completed",
        packageState: "preparing",
        interaction: {
          progress: {
            build: {
              revision: MATERIALIZED_LEAF_COUNT,
              currentLeafId: null,
              contentVersion: 1,
            },
            summary: {
              total: MATERIALIZED_LEAF_COUNT,
              confirmed: MATERIALIZED_LEAF_COUNT,
            },
          },
        },
      });

      const completedBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0]!;
      expect(completedBuild).toMatchObject({
        status: "ready_to_publish",
        revision: MATERIALIZED_LEAF_COUNT,
        confirmedCount: MATERIALIZED_LEAF_COUNT,
        currentLeafId: null,
        activeTurnId: null,
        packageStatus: "preparing",
        activeWorkingSetId: build.activeWorkingSetId,
        contentVersion: 1,
      });

      const turns = await executor
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.userId, userId!));
      const initialTurns = turns.filter(
        (turn) => turn.operationType === "start",
      );
      const localConfirmTurns = turns.filter(
        (turn) => turn.operationType === "local_confirm",
      );
      expect(initialTurns).toHaveLength(1);
      expect(initialTurns[0]).toMatchObject({
        status: "completed",
        upstreamTaskId: initialTaskId,
        apiCredentialId: credentialId,
      });
      expect(localConfirmTurns).toHaveLength(MATERIALIZED_LEAF_COUNT);
      expect(
        localConfirmTurns.every(
          (turn) =>
            turn.status === "completed" &&
            turn.upstreamTaskId === null &&
            turn.apiCredentialId === null &&
            (turn.metadata as any).execution === "local" &&
            (turn.metadata as any).providerRequestCount === 0,
        ),
      ).toBe(true);

      const acceptedMessages = await executor
        .select()
        .from(messages)
        .where(eq(messages.userId, userId!))
        .orderBy(asc(messages.sequence));
      const presentations = acceptedMessages.filter(
        (message) =>
          (message.metadata as any)?.knowledgeBase?.kind === "presentation",
      );
      const completions = acceptedMessages.filter(
        (message) =>
          (message.metadata as any)?.knowledgeBase?.kind === "completion",
      );
      expect(presentations).toHaveLength(MATERIALIZED_LEAF_COUNT);
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        role: "assistant",
        content: KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT,
      });

      const confirmedNodes = await executor
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
        .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
      expect(confirmedNodes).toHaveLength(MATERIALIZED_LEAF_COUNT);
      expect(confirmedNodes.every((node) => node.status === "confirmed")).toBe(
        true,
      );

      const resources = await executor
        .select()
        .from(upstreamResources)
        .where(eq(upstreamResources.userId, userId!));
      expect(resources.filter((resource) => resource.kind === "task")).toEqual([
        expect.objectContaining({
          upstreamId: initialTaskId,
          apiCredentialId: credentialId,
        }),
      ]);

      const {
        runKnowledgeBasePackageSweep,
        readDashboardOwnedKnowledgePackage,
      } = await import("../server/knowledge-base-local-package");
      const packageSettlement = await waitFor({
        label: "Dashboard local final package",
        read: async () => {
          const sweep = await runKnowledgeBasePackageSweep(1);
          const projection = await getProgress();
          return { sweep, projection };
        },
        accept: ({ sweep, projection }) => {
          if (sweep.failed !== 0) {
            throw new Error(`local package failed: ${JSON.stringify(sweep)}`);
          }
          return projection.observation?.packageState === "ready";
        },
      });
      progress = packageSettlement.projection;
      expect(fakeProvider.providerCalls).toHaveLength(
        providerCallsBeforeConfirmation,
      );
      expect(progress.observation).toMatchObject({
        contentState: "completed",
        packageState: "ready",
        package: {
          revision: MATERIALIZED_LEAF_COUNT,
          outputItemId: `dashboard-local:${build.id}:${MATERIALIZED_LEAF_COUNT}`,
          downloadPath: `/api/knowledge-base/artifacts/${build.id}/package`,
          mimeType: "application/zip",
        },
      });

      const unauthenticatedPackage = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base/artifacts/${build.id}/package`,
      );
      expect(unauthenticatedPackage.status).toBe(401);
      const packageResponse = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base/artifacts/${build.id}/package`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(packageResponse.status).toBe(200);
      const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
      const packageBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0]!;
      expect(packageBuild).toMatchObject({
        packageStatus: "ready",
        packageAttemptCount: 1,
        packageRevision: MATERIALIZED_LEAF_COUNT,
        packageTaskId: `dashboard-materialized:${build.id}:1`,
        packageOutputItemId: `dashboard-local:${build.id}:${MATERIALIZED_LEAF_COUNT}`,
        packageFileId: null,
        packageArchiveSha256: sha256(packageBytes),
        packageSizeBytes: packageBytes.length,
      });
      const parsedPackage = await readDashboardOwnedKnowledgePackage({
        buffer: packageBytes,
        expected: {
          buildId: build.id,
          generation: 1,
          revision: MATERIALIZED_LEAF_COUNT,
          companyName: SYNTHETIC_COMPANY,
        },
        nodes: confirmedNodes,
      });
      expect(parsedPackage.documents).toHaveLength(MATERIALIZED_LEAF_COUNT);
      expect(parsedPackage.manifest.missing_optional_assets).not.toContain(
        "official_logo",
      );
      expect(fakeProvider.rejectedCallCount).toBe(0);
      expect(fakeProvider.taskCreateBodies).toHaveLength(1);
      expect(fakeProvider.taskSendBodies).toHaveLength(0);

      const publishResponse = await fetch(
        `${dashboardBaseUrl}/api/dashboard/knowledge/publish`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({ conversationId: publicConversationId }),
        },
      );
      const publication = (await publishResponse.json()) as any;
      expect(publishResponse.status).toBe(200);
      expect(publication.snapshot).toMatchObject({
        archiveHash: sha256(packageBytes),
        archiveAvailable: true,
      });
      expect(publication.snapshot).not.toHaveProperty("sourceBuildId");
      expect(publication.snapshot).not.toHaveProperty("sourceBuildRevision");
      expect(publication.snapshot).not.toHaveProperty("sourceTaskId");
      expect(publication.snapshot).not.toHaveProperty("sourceArtifactHash");
      const publishedSnapshot = (
        await executor
          .select()
          .from(knowledgeBaseSnapshots)
          .where(eq(knowledgeBaseSnapshots.id, publication.snapshot.id))
          .limit(1)
      )[0]!;
      expect(publishedSnapshot).toMatchObject({
        sourceBuildId: build.id,
        sourceBuildRevision: MATERIALIZED_LEAF_COUNT,
        sourceTaskId: `dashboard-materialized:${build.id}:1`,
        sourceArtifactHash: sha256(packageBytes),
        archiveHash: sha256(packageBytes),
      });
      const publishedBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0]!;
      expect(publishedBuild).toMatchObject({
        status: "published",
        publishedSnapshotId: publication.snapshot.id,
        initialResearchCoverage: expect.objectContaining({
          publicQueries: 6,
          uploadsRead: 0,
          stopReason: "coverage_complete",
        }),
      });

      acceptancePassed = true;
    }, 300_000);
  },
);
