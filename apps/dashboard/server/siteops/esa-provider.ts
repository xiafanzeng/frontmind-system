import { createHash, randomUUID } from "node:crypto";

import * as EsaModels from "@alicloud/esa20240910";
import * as OpenApi from "@alicloud/openapi-client";
import { and, eq, gt, gte, inArray, ne } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";

import {
  knowledgeBaseSnapshots,
  messages,
  siteBuilds,
  siteBuildInputAssets,
  siteDeployments,
  siteDnsRecords,
  siteOperations,
  siteProjects,
  websiteStyleSampleBatches,
  workspaceSiteProfiles,
  type SiteOperation,
} from "../../drizzle/schema";
import { buildContractV2Schema } from "../../shared/siteops-design";
import {
  siteContentPlanV2Schema,
  type SiteContentPlanV2,
} from "../../shared/siteops-content-plan";
import { canonicalJson } from "../../shared/siteops-workflow";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import { getDb } from "../db";
import { persistSiteOpsArtifact, readSiteOpsArtifact } from "./artifact-store";
import { AliyunCredential, AliyunEsaClient } from "./aliyun-sdk-constructors";
import { materializeProductionSiteFromSource } from "./build-runtime";
import { inspectEsaRuntimeConfiguration } from "./esa-config";
import { fetchPinnedPublicHttps } from "./remote-preview";
import { siteOpsRevisionLineageFromRows } from "./manus-provider";
import { rebuildNativeReactProductionFromSource } from "./native-react-build-runtime";
import { validateNativeReactSourceArchive } from "./native-react-source";
import {
  isSiteOpsNativeVisualWorkflowVersion,
  SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION,
} from "./native-visual-source";
import {
  APPROVED_RESET_UNPUBLISH,
  approvedResetUnpublishFreshEpochMatches,
  approvedResetUnpublishNonRevisionCoordinatesMatch,
  approvedResetUnpublishProjectMatches,
  parseApprovedResetUnpublishInput,
  type ApprovedResetUnpublishInput,
} from "./rebuild-ticket";
import {
  registerSiteOpsProviderHandler,
  type SiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";

const ESA_ENDPOINT = "esa.cn-hangzhou.aliyuncs.com";
const ESA_TIMEOUT_MS = 15_000;
const MAX_DIST_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_DIST_FILES = 5_000;
const MAX_DIST_EXPANDED_BYTES = 120 * 1024 * 1024;
const MAX_CONTENT_PLAN_BYTES = 16 * 1024 * 1024;
const FRONTMIND_MARKER_PATH = "frontmind-deployment.json";
const DNS_TTL = 600;

const prepareInputSchema = z
  .object({
    prepareDomainBinding: z.literal(true),
    domain: z.string().trim().min(1).max(255),
    domainRevision: z.number().int().positive(),
    connectionId: z.string().uuid(),
  })
  .strict();

const productionMaterializationSchema = z
  .object({
    schemaVersion: z.literal(1),
    canonicalOrigin: z.string().url(),
    target: z.enum(["global_excluding_cn", "mainland_cn"]),
    sourceLocalAssetId: z.string().uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    contentPlanLocalAssetId: z.string().uuid().optional(),
    contentPlanSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    contractLocalAssetId: z.string().uuid(),
    contractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    productionSourceLocalAssetId: z.string().uuid(),
    productionSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    distLocalAssetId: z.string().uuid(),
    distSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    qaLocalAssetId: z.string().uuid(),
    qaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    provenanceLocalAssetId: z.string().uuid(),
    provenanceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    qaPolicyVersion: z.string().trim().min(1).max(64),
    materializedAt: z.string().datetime(),
  })
  .strict();

type DbExecutor = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type EsaRoutineView = {
  name: string;
  hasAssets: boolean;
  defaultRelatedRecord: string | null;
  production: {
    deploymentId: string;
    codeVersions: Array<{ codeVersion: string; percentage: number }>;
  } | null;
};

export type EsaCodeVersionView = {
  codeVersion: string;
  status: string;
  description: string | null;
  extraInfo: string | null;
  hasAssets: boolean;
};

export type EsaSiteView = {
  siteId: number;
  siteName: string;
  status: string;
  accessType: string;
  coverage: string;
  verifyCode: string | null;
  cnameZone: string | null;
};

type EsaSiteCoverage = "overseas" | "domestic";

export type EsaOssPostConfig = {
  url: string;
  key: string;
  accessKeyId: string;
  policy: string;
  signature: string;
  securityToken: string | null;
};

/** Direct, narrow SDK boundary. Tests inject this interface; production uses no CLI or gateway. */
export interface EsaDirectApi {
  getRoutine(name: string): Promise<EsaRoutineView | null>;
  createRoutine(input: { name: string; description: string }): Promise<void>;
  listCodeVersions(input: {
    name: string;
    marker: string;
  }): Promise<EsaCodeVersionView[]>;
  getCodeVersion(input: {
    name: string;
    codeVersion: string;
  }): Promise<EsaCodeVersionView | null>;
  createAssetsCodeVersion(input: {
    name: string;
    description: string;
    extraInfo: string;
  }): Promise<{ codeVersion: string; upload: EsaOssPostConfig }>;
  createProductionDeployment(input: {
    name: string;
    codeVersion: string;
  }): Promise<{ deploymentId: string }>;
  listSites(siteName: string): Promise<EsaSiteView[]>;
  createSite(input: {
    siteName: string;
    instanceId: string;
    coverage: EsaSiteCoverage;
  }): Promise<{ siteId: number; verifyCode: string | null }>;
  updateSiteCoverage(input: {
    siteId: number;
    coverage: EsaSiteCoverage;
  }): Promise<void>;
  verifySite(siteId: number): Promise<boolean>;
  getMatchSite(recordName: string): Promise<EsaSiteView | null>;
  listRelatedRecords(input: {
    name: string;
    recordName: string;
  }): Promise<Array<{ recordId: number; recordName: string; siteId: number }>>;
  createRelatedRecord(input: {
    name: string;
    recordName: string;
    siteId: number;
  }): Promise<void>;
  deleteRelatedRecord(input: {
    name: string;
    recordId: number;
    recordName: string;
    siteId: number;
  }): Promise<void>;
  deleteRoutine(name: string): Promise<void>;
  listEdgeRoutineRecords(input: {
    siteId: number;
    recordName: string;
  }): Promise<Array<{ recordName: string; recordCname: string }>>;
}

type EsaProviderDependencies = {
  getDb?: typeof getDb;
  persistArtifact?: typeof persistSiteOpsArtifact;
  readArtifact?: typeof readSiteOpsArtifact;
  materializeProduction?: typeof materializeProductionSiteFromSource;
  materializeNativeProduction?: typeof rebuildNativeReactProductionFromSource;
  fetch?: typeof globalThis.fetch;
  api?: EsaDirectApi;
  publicHttpsFetch?: typeof fetchPinnedPublicHttps;
};

class EsaProviderFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status:
      | "failed"
      | "attention_required"
      | "outcome_unknown" = "attention_required",
    readonly result?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EsaProviderFailure";
  }
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  return `${String(value.code ?? "")} ${String(value.name ?? "")} ${String(value.message ?? "")}`;
}

function isNotFound(error: unknown) {
  return /not.?found|does not exist|不存在|routine.*invalid/i.test(
    errorText(error),
  );
}

function normalizeHostname(value: string) {
  const hostname = value.trim().replace(/\.$/u, "").toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      hostname,
    )
  ) {
    throw new EsaProviderFailure(
      "ESA_HOSTNAME_INVALID",
      "ESA 绑定的 hostname 不是规范化 ASCII 域名。",
      "failed",
    );
  }
  return hostname;
}

function routineName(projectId: string) {
  return `frontmind-${projectId.replace(/-/gu, "").slice(0, 32)}`;
}

function versionMarker(deploymentId: string, distHash: string) {
  return `frontmind:${deploymentId}:${distHash}`;
}

function dnsRr(hostname: string, zone: string) {
  if (hostname === zone) return "@";
  const suffix = `.${zone}`;
  if (!hostname.endsWith(suffix)) {
    throw new EsaProviderFailure(
      "ESA_HOSTNAME_ZONE_MISMATCH",
      "canonical hostname 不属于当前客户域名版本。",
      "failed",
    );
  }
  return hostname.slice(0, -suffix.length);
}

function mapRoutine(name: string, body: any): EsaRoutineView {
  const production = (body?.envs ?? []).find(
    (entry: any) => String(entry?.env).toLowerCase() === "production",
  )?.codeDeploy;
  return {
    name,
    hasAssets: body?.hasAssets === true,
    defaultRelatedRecord: body?.defaultRelatedRecord ?? null,
    production: production?.deployId
      ? {
          deploymentId: String(production.deployId),
          codeVersions: (production.codeVersions ?? []).map((entry: any) => ({
            codeVersion: String(entry.codeVersion ?? ""),
            percentage: Number(entry.percentage ?? 0),
          })),
        }
      : null,
  };
}

function mapVersion(body: any): EsaCodeVersionView | null {
  if (!body?.codeVersion) return null;
  return {
    codeVersion: String(body.codeVersion),
    status: String(body.status ?? ""),
    description: body.codeDescription ?? null,
    extraInfo: body.extraInfo ?? null,
    hasAssets: body.hasAssets !== false,
  };
}

function mapSite(body: any): EsaSiteView | null {
  if (!body?.siteId || !body?.siteName) return null;
  return {
    siteId: Number(body.siteId),
    siteName: normalizeHostname(String(body.siteName)),
    status: String(body.status ?? ""),
    accessType: String(body.accessType ?? ""),
    coverage: String(body.coverage ?? ""),
    verifyCode: body.verifyCode ? String(body.verifyCode) : null,
    cnameZone: body.cnameZone ? String(body.cnameZone) : null,
  };
}

class OfficialEsaDirectApi implements EsaDirectApi {
  private readonly client: InstanceType<typeof AliyunEsaClient>;

  constructor() {
    const credential = new AliyunCredential();
    this.client = new AliyunEsaClient(
      new OpenApi.Config({
        credential,
        endpoint: ESA_ENDPOINT,
        protocol: "HTTPS",
        regionId: "cn-hangzhou",
        connectTimeout: ESA_TIMEOUT_MS,
        readTimeout: ESA_TIMEOUT_MS,
        userAgent: "frontmind-siteops/1.0",
      }),
    );
  }

  async getRoutine(name: string) {
    try {
      const response = await this.client.getRoutine(
        new EsaModels.GetRoutineRequest({ name }),
      );
      return response.body ? mapRoutine(name, response.body) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createRoutine(input: { name: string; description: string }) {
    const response = await this.client.createRoutine(
      new EsaModels.CreateRoutineRequest({
        name: input.name,
        description: input.description,
        hasAssets: true,
      }),
    );
    if (response.body?.status !== "OK")
      throw new Error("ESA_CREATE_ROUTINE_REJECTED");
  }

  async listCodeVersions(input: { name: string; marker: string }) {
    const response = await this.client.listRoutineCodeVersions(
      new EsaModels.ListRoutineCodeVersionsRequest({
        name: input.name,
        pageNumber: 1,
        pageSize: 20,
        searchKeyWord: input.marker,
      }),
    );
    return (response.body?.codeVersions ?? [])
      .map(mapVersion)
      .filter((entry): entry is EsaCodeVersionView => Boolean(entry))
      .filter(
        (entry) =>
          entry.description === input.marker ||
          entry.extraInfo?.includes(input.marker) === true,
      );
  }

  async getCodeVersion(input: { name: string; codeVersion: string }) {
    try {
      const response = await this.client.getRoutineCodeVersionInfo(
        new EsaModels.GetRoutineCodeVersionInfoRequest(input),
      );
      return mapVersion(response.body);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createAssetsCodeVersion(input: {
    name: string;
    description: string;
    extraInfo: string;
  }) {
    const response = await this.client.createRoutineWithAssetsCodeVersion(
      new EsaModels.CreateRoutineWithAssetsCodeVersionRequest({
        name: input.name,
        codeDescription: input.description,
        extraInfo: input.extraInfo,
        confOptions:
          new EsaModels.CreateRoutineWithAssetsCodeVersionRequestConfOptions({
            notFoundStrategy: "404Page",
          }),
      }),
    );
    const body = response.body;
    const upload = body?.ossPostConfig;
    if (
      !body?.codeVersion ||
      !upload?.url ||
      !upload.key ||
      !upload.OSSAccessKeyId ||
      !upload.policy ||
      !upload.signature
    ) {
      throw new Error("ESA_UPLOAD_CONFIGURATION_INCOMPLETE");
    }
    return {
      codeVersion: body.codeVersion,
      upload: {
        url: upload.url,
        key: upload.key,
        accessKeyId: upload.OSSAccessKeyId,
        policy: upload.policy,
        signature: upload.signature,
        securityToken: upload.XOssSecurityToken ?? null,
      },
    };
  }

  async createProductionDeployment(input: {
    name: string;
    codeVersion: string;
  }) {
    const response = await this.client.createRoutineCodeDeployment(
      new EsaModels.CreateRoutineCodeDeploymentRequest({
        name: input.name,
        env: "production",
        strategy: "percentage",
        codeVersions: [
          new EsaModels.CreateRoutineCodeDeploymentRequestCodeVersions({
            codeVersion: input.codeVersion,
            percentage: 100,
          }),
        ],
      }),
    );
    if (!response.body?.deploymentId)
      throw new Error("ESA_DEPLOYMENT_ID_MISSING");
    return { deploymentId: response.body.deploymentId };
  }

  async listSites(siteName: string) {
    const response = await this.client.listSites(
      new EsaModels.ListSitesRequest({
        siteName,
        siteSearchType: "exact",
        pageNumber: 1,
        pageSize: 20,
      }),
    );
    return (response.body?.sites ?? [])
      .map(mapSite)
      .filter((entry): entry is EsaSiteView => Boolean(entry))
      .filter((entry) => entry.siteName === siteName);
  }

  async createSite(input: {
    siteName: string;
    instanceId: string;
    coverage: EsaSiteCoverage;
  }) {
    const response = await this.client.createSite(
      new EsaModels.CreateSiteRequest({
        siteName: input.siteName,
        instanceId: input.instanceId,
        accessType: "CNAME",
        coverage: input.coverage,
      }),
    );
    if (!response.body?.siteId) throw new Error("ESA_SITE_ID_MISSING");
    return {
      siteId: response.body.siteId,
      verifyCode: response.body.verifyCode ?? null,
    };
  }

  async updateSiteCoverage(input: {
    siteId: number;
    coverage: EsaSiteCoverage;
  }) {
    await this.client.updateSiteCoverage(
      new EsaModels.UpdateSiteCoverageRequest(input),
    );
  }

  async verifySite(siteId: number) {
    const response = await this.client.verifySite(
      new EsaModels.VerifySiteRequest({ siteId }),
    );
    return response.body?.passed === true;
  }

  async getMatchSite(recordName: string) {
    try {
      const response = await this.client.getMatchSite(
        new EsaModels.GetMatchSiteRequest({ recordName }),
      );
      if (!response.body?.siteId || !response.body.siteName) return null;
      const sites = await this.listSites(response.body.siteName);
      return (
        sites.find((site) => site.siteId === response.body?.siteId) ?? null
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listRelatedRecords(input: { name: string; recordName: string }) {
    const response = await this.client.listRoutineRelatedRecords(
      new EsaModels.ListRoutineRelatedRecordsRequest({
        name: input.name,
        pageNumber: 1,
        pageSize: 20,
        searchKeyWord: input.recordName,
      }),
    );
    return (response.body?.relatedRecords ?? [])
      .filter(
        (entry) =>
          entry.recordName === input.recordName &&
          entry.siteId &&
          entry.recordId,
      )
      .map((entry) => ({
        recordId: Number(entry.recordId),
        recordName: String(entry.recordName),
        siteId: Number(entry.siteId),
      }));
  }

  async createRelatedRecord(input: {
    name: string;
    recordName: string;
    siteId: number;
  }) {
    const response = await this.client.createRoutineRelatedRecord(
      new EsaModels.CreateRoutineRelatedRecordRequest(input),
    );
    if (response.body?.status !== "OK")
      throw new Error("ESA_RELATED_RECORD_REJECTED");
  }

  async deleteRelatedRecord(input: {
    name: string;
    recordId: number;
    recordName: string;
    siteId: number;
  }) {
    try {
      const response = await this.client.deleteRoutineRelatedRecord(
        new EsaModels.DeleteRoutineRelatedRecordRequest(input),
      );
      if (response.body?.status !== "OK") {
        throw new Error("ESA_RELATED_RECORD_DELETE_REJECTED");
      }
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async deleteRoutine(name: string) {
    try {
      const response = await this.client.deleteRoutine(
        new EsaModels.DeleteRoutineRequest({ name }),
      );
      if (response.body?.status !== "OK") {
        throw new Error("ESA_ROUTINE_DELETE_REJECTED");
      }
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async listEdgeRoutineRecords(input: { siteId: number; recordName: string }) {
    const response = await this.client.listEdgeRoutineRecords(
      new EsaModels.ListEdgeRoutineRecordsRequest({
        siteId: input.siteId,
        recordName: input.recordName,
        recordMatchType: "exact",
        pageNumber: 1,
        pageSize: 20,
      }),
    );
    return (response.body?.records ?? [])
      .filter(
        (entry) =>
          entry.recordName === input.recordName && Boolean(entry.recordCname),
      )
      .map((entry) => ({
        recordName: String(entry.recordName),
        recordCname: String(entry.recordCname),
      }));
  }
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream,
  expectedBytes: number,
) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > expectedBytes || total > MAX_DIST_ZIP_BYTES) {
      throw new EsaProviderFailure(
        "ESA_DIST_SIZE_INVALID",
        "官网 dist ZIP 大小与冻结产物不一致。",
        "failed",
      );
    }
    chunks.push(buffer);
  }
  if (total !== expectedBytes) {
    throw new EsaProviderFailure(
      "ESA_DIST_SIZE_INVALID",
      "官网 dist ZIP 大小与冻结产物不一致。",
      "failed",
    );
  }
  return Buffer.concat(chunks, total);
}

async function streamFrozenContentPlan(
  stream: NodeJS.ReadableStream,
  expectedBytes: number,
) {
  if (expectedBytes < 1 || expectedBytes > MAX_CONTENT_PLAN_BYTES) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTENT_PLAN_INVALID",
      "冻结内容计划缺失或无效，不能生成 production 产物。",
      "failed",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > expectedBytes || total > MAX_CONTENT_PLAN_BYTES) {
      throw new EsaProviderFailure(
        "ESA_PRODUCTION_CONTENT_PLAN_INVALID",
        "冻结内容计划缺失或无效，不能生成 production 产物。",
        "failed",
      );
    }
    chunks.push(buffer);
  }
  if (total !== expectedBytes) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTENT_PLAN_INVALID",
      "冻结内容计划缺失或无效，不能生成 production 产物。",
      "failed",
    );
  }
  return Buffer.concat(chunks, total);
}

/** Converts a frozen dist ZIP to the assets/ layout used by Alibaba Cloud's esa-cli. */
export async function packageEsaStaticAssets(input: {
  distZip: Buffer;
  deploymentId: string;
  distHash: string;
}) {
  if (
    input.distZip.byteLength === 0 ||
    input.distZip.byteLength > MAX_DIST_ZIP_BYTES ||
    !/^[a-f0-9]{64}$/u.test(input.distHash)
  ) {
    throw new EsaProviderFailure(
      "ESA_DIST_SIZE_INVALID",
      "冻结的官网 dist ZIP 无效。",
      "failed",
    );
  }
  const source = await JSZip.loadAsync(input.distZip, {
    checkCRC32: true,
    createFolders: false,
  });
  const files = Object.values(source.files).filter((entry) => !entry.dir);
  if (files.length === 0 || files.length > MAX_DIST_FILES) {
    throw new EsaProviderFailure(
      "ESA_DIST_FILE_COUNT_INVALID",
      "官网 dist ZIP 文件数量超出允许范围。",
      "failed",
    );
  }
  const target = new JSZip();
  const stableDate = new Date("2000-01-01T00:00:00.000Z");
  let expanded = 0;
  for (const entry of files.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const original = (entry as typeof entry & { unsafeOriginalName?: string })
      .unsafeOriginalName;
    const unixPermissions = (
      entry as typeof entry & { unixPermissions?: number }
    ).unixPermissions;
    const name = entry.name.normalize("NFKC").replace(/^\/+|\/+$/gu, "");
    if (
      !name ||
      name !== entry.name ||
      (original && original !== entry.name) ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      (typeof unixPermissions === "number" &&
        (unixPermissions & 0o170000) === 0o120000) ||
      name === FRONTMIND_MARKER_PATH
    ) {
      throw new EsaProviderFailure(
        "ESA_DIST_PATH_INVALID",
        "官网 dist ZIP 包含不安全路径或保留文件名。",
        "failed",
      );
    }
    const bytes = await entry.async("nodebuffer");
    expanded += bytes.byteLength;
    if (expanded > MAX_DIST_EXPANDED_BYTES) {
      throw new EsaProviderFailure(
        "ESA_DIST_EXPANDED_SIZE_INVALID",
        "官网 dist ZIP 解压后超过安全上限。",
        "failed",
      );
    }
    target.file(`assets/${name}`, bytes, { date: stableDate });
  }
  target.file(
    `assets/${FRONTMIND_MARKER_PATH}`,
    `${JSON.stringify({ schemaVersion: 2, deploymentId: input.deploymentId, distSha256: input.distHash })}\n`,
    { date: stableDate },
  );
  for (const entry of Object.values(target.files)) entry.date = stableDate;
  return target.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
}

async function persistBoundary(
  db: DbExecutor,
  operation: SiteOperation,
  result: Record<string, unknown>,
  providerOperationId?: string,
) {
  if (!operation.leaseOwner) {
    throw new EsaProviderFailure(
      "ESA_OPERATION_LEASE_MISSING",
      "ESA 操作缺少有效租约，未提交外部变更。",
    );
  }
  await db
    .update(siteOperations)
    .set({
      result,
      ...(providerOperationId ? { providerOperationId } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(siteOperations.id, operation.id),
        eq(siteOperations.status, "running"),
        eq(siteOperations.leaseOwner, operation.leaseOwner),
      ),
    );
}

function mutationAffectedRows(result: unknown) {
  return Number(
    (Array.isArray(result)
      ? (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (result as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
  );
}

async function persistApprovedResetBoundary(
  db: DbExecutor,
  operation: SiteOperation,
  result: Record<string, unknown>,
) {
  if (!operation.leaseOwner) {
    throw new EsaProviderFailure(
      "ESA_OPERATION_LEASE_MISSING",
      "ESA 操作缺少有效租约，未提交外部变更。",
    );
  }
  const updated = await db
    .update(siteOperations)
    .set({ result, updatedAt: new Date() })
    .where(
      and(
        eq(siteOperations.id, operation.id),
        eq(siteOperations.status, "running"),
        eq(siteOperations.leaseOwner, operation.leaseOwner),
      ),
    );
  if (mutationAffectedRows(updated) !== 1) {
    throw new EsaProviderFailure(
      "ESA_OPERATION_LEASE_LOST",
      "ESA 操作租约已变化，未提交外部变更。",
      "failed",
    );
  }
}

async function loadApprovedResetProject(
  db: DbExecutor,
  operation: SiteOperation,
  reset: ApprovedResetUnpublishInput,
) {
  const rows = await db
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, operation.projectId),
        eq(siteProjects.userId, operation.userId),
      ),
    )
    .limit(1);
  const project = rows[0];
  if (!project || !approvedResetUnpublishProjectMatches(reset, project)) {
    throw new EsaProviderFailure(
      "SITEOPS_RESET_INVALIDATED",
      "官网重置坐标已变化，未向 ESA 提交下线操作。",
      "failed",
    );
  }
  return project;
}

const approvedResetExposureRemovedV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    intent: z.literal(APPROVED_RESET_UNPUBLISH),
    stage: z.literal("exposure_removed"),
  })
  .strict();

const approvedResetExposureRemovedV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    intent: z.literal(APPROVED_RESET_UNPUBLISH),
    stage: z.literal("exposure_removed"),
    resetOperationId: z.string().uuid(),
    projectId: z.string().uuid(),
    freshRootApplied: z.literal(true),
    minimumKnowledgeSnapshotVersion: z.number().int().positive(),
    resetAppliedProjectRevision: z.number().int().positive(),
  })
  .strict();

export const approvedResetSafeNoExposureProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    classification: z.literal("safe_no_exposure"),
    source: z.enum(["exact_coordinates", "migration_0065_revision_only"]),
    resetOperationId: z.string().uuid(),
    projectId: z.string().uuid(),
    expectedProjectRevision: z.number().int().positive(),
    observedProjectRevision: z.number().int().positive(),
    observedProjectUpdatedAt: z.string().datetime(),
  })
  .strict();

export type ApprovedResetSafeNoExposureProof = z.infer<
  typeof approvedResetSafeNoExposureProofSchema
>;

export function parseApprovedResetSafeNoExposureProof(value: unknown) {
  const parsed = approvedResetSafeNoExposureProofSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const ESA_PRE_MUTATION_CONFIGURATION_CODES = new Set([
  "ESA_RUNTIME_DISABLED",
  "ESA_INSTANCE_NOT_CONFIGURED",
  "ESA_SERVICE_IDENTITY_NOT_CONFIGURED",
  "DATABASE_UNAVAILABLE",
  "PROVIDER_NOT_CONFIGURED",
]);

type ApprovedResetExposureDeployment = {
  id: string;
  operationId: string | null;
  verification: Record<string, unknown> | null;
};

type ApprovedResetExposureOperation = {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  providerOperationId: string | null;
  providerTaskId: string | null;
  errorCode: string | null;
};

function isStrictCompletedApprovedReset(
  operation: ApprovedResetExposureOperation,
) {
  const reset = parseApprovedResetUnpublishInput(operation.input);
  if (
    operation.kind !== "rollback" ||
    operation.status !== "succeeded" ||
    !reset
  ) {
    return false;
  }
  const v1 = approvedResetExposureRemovedV1Schema.safeParse(operation.result);
  if (v1.success) return true;
  const v2 = approvedResetExposureRemovedV2Schema.safeParse(operation.result);
  return Boolean(
    v2.success &&
      v2.data.resetOperationId === operation.id &&
      v2.data.projectId === operation.projectId,
  );
}

function isPreMutationConfigurationFailure(
  operation: ApprovedResetExposureOperation,
) {
  return (
    ["failed", "attention_required", "cancelled"].includes(operation.status) &&
    typeof operation.errorCode === "string" &&
    ESA_PRE_MUTATION_CONFIGURATION_CODES.has(operation.errorCode) &&
    operation.result === null &&
    operation.providerOperationId === null &&
    operation.providerTaskId === null
  );
}

export function approvedResetExternalExposureClassification(input: {
  deployments: ApprovedResetExposureDeployment[];
  operations: ApprovedResetExposureOperation[];
}) {
  const resetInvalidatedOperationIds = new Set<string>();
  for (const deployment of input.deployments) {
    if (deployment.verification?.resetInvalidated !== true) {
      return "requires_esa_reconciliation" as const;
    }
    if (deployment.operationId) {
      resetInvalidatedOperationIds.add(deployment.operationId);
    }
  }
  for (const operation of input.operations) {
    if (resetInvalidatedOperationIds.has(operation.id)) continue;
    if (isStrictCompletedApprovedReset(operation)) continue;
    if (isPreMutationConfigurationFailure(operation)) continue;
    return "requires_esa_reconciliation" as const;
  }
  return "safe_no_exposure" as const;
}

function exactSafeNoExposureProof(input: {
  operation: SiteOperation;
  reset: ApprovedResetUnpublishInput;
  project: typeof siteProjects.$inferSelect;
}): ApprovedResetSafeNoExposureProof {
  return approvedResetSafeNoExposureProofSchema.parse({
    schemaVersion: 1,
    classification: "safe_no_exposure",
    source: "exact_coordinates",
    resetOperationId: input.operation.id,
    projectId: input.project.id,
    expectedProjectRevision: input.reset.expectedProjectRevision,
    observedProjectRevision: input.project.revision,
    observedProjectUpdatedAt: input.project.updatedAt.toISOString(),
  });
}

async function migration0065RevisionOnlyProof(input: {
  db: DbExecutor;
  operation: SiteOperation;
  reset: ApprovedResetUnpublishInput;
  project: typeof siteProjects.$inferSelect;
}) {
  const { operation, project, reset } = input;
  if (
    project.revision !== reset.expectedProjectRevision + 1 ||
    !approvedResetUnpublishNonRevisionCoordinatesMatch(reset, project) ||
    operation.result !== null ||
    operation.providerOperationId !== null ||
    operation.providerTaskId !== null ||
    !(operation.createdAt instanceof Date) ||
    !(project.updatedAt instanceof Date) ||
    project.updatedAt.getTime() <= operation.createdAt.getTime()
  ) {
    return null;
  }

  // 0065 has one intentionally recognizable data-migration fingerprint: it
  // soft-deletes legacy operation_recovery messages and increments every
  // SiteOps project revision in the same migration window. Requiring the
  // deleted message's revision and exact timestamp prevents an arbitrary
  // later project mutation from being mistaken for that one-time drift.
  const recoveryRows = await input.db
    .select({
      metadata: messages.metadata,
      sentAt: messages.sentAt,
      updatedAt: messages.updatedAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, project.conversationId),
        eq(messages.userId, operation.userId),
        eq(messages.deletedAt, project.updatedAt),
      ),
    )
    .limit(1_001);
  if (recoveryRows.length > 1_000) return null;
  const hasMigrationFingerprint = recoveryRows.some((row) => {
    const metadata =
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null;
    const siteOps =
      metadata?.siteOps &&
      typeof metadata.siteOps === "object" &&
      !Array.isArray(metadata.siteOps)
        ? (metadata.siteOps as Record<string, unknown>)
        : null;
    return (
      siteOps?.kind === "operation_recovery" &&
      siteOps.revision === reset.expectedProjectRevision &&
      row.sentAt.getTime() <= operation.createdAt.getTime() &&
      row.deletedAt?.getTime() === project.updatedAt.getTime() &&
      row.updatedAt.getTime() === project.updatedAt.getTime()
    );
  });
  if (!hasMigrationFingerprint) return null;

  // The migration proof is valid only while the reset remains the newest
  // website workflow fact. Any later operation, build, visual batch or sent
  // message is a real causal change and restores strict revision matching.
  const laterOperationRows = await input.db
    .select({ id: siteOperations.id })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, operation.projectId),
        eq(siteOperations.userId, operation.userId),
        gt(siteOperations.createdAt, operation.createdAt),
      ),
    )
    .limit(1);
  if (laterOperationRows.length > 0) return null;
  const laterBuildRows = await input.db
    .select({ id: siteBuilds.id })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.projectId, operation.projectId),
        eq(siteBuilds.userId, operation.userId),
        gt(siteBuilds.createdAt, operation.createdAt),
      ),
    )
    .limit(1);
  if (laterBuildRows.length > 0) return null;
  const laterVisualRows = await input.db
    .select({ id: websiteStyleSampleBatches.id })
    .from(websiteStyleSampleBatches)
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, operation.projectId),
        eq(websiteStyleSampleBatches.userId, operation.userId),
        gt(websiteStyleSampleBatches.createdAt, operation.createdAt),
      ),
    )
    .limit(1);
  if (laterVisualRows.length > 0) return null;
  const laterMessageRows = await input.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, project.conversationId),
        eq(messages.userId, operation.userId),
        gt(messages.sentAt, operation.createdAt),
      ),
    )
    .limit(1);
  if (laterMessageRows.length > 0) return null;

  return approvedResetSafeNoExposureProofSchema.parse({
    schemaVersion: 1,
    classification: "safe_no_exposure",
    source: "migration_0065_revision_only",
    resetOperationId: operation.id,
    projectId: project.id,
    expectedProjectRevision: reset.expectedProjectRevision,
    observedProjectRevision: project.revision,
    observedProjectUpdatedAt: project.updatedAt.toISOString(),
  });
}

async function loadApprovedResetSafeNoExposureCoordinates(input: {
  db: DbExecutor;
  operation: SiteOperation;
  reset: ApprovedResetUnpublishInput;
  allowMigration0065RevisionDrift: boolean;
}) {
  const rows = await input.db
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, input.operation.projectId),
        eq(siteProjects.userId, input.operation.userId),
      ),
    )
    .limit(1);
  const project = rows[0];
  if (
    !project ||
    (!approvedResetUnpublishNonRevisionCoordinatesMatch(input.reset, project) &&
      !approvedResetUnpublishFreshEpochMatches(input.reset, project))
  ) {
    throw new EsaProviderFailure(
      "SITEOPS_RESET_INVALIDATED",
      "官网重置坐标已变化，未向 ESA 提交下线操作。",
      "failed",
    );
  }
  if (approvedResetUnpublishProjectMatches(input.reset, project)) {
    return {
      project,
      proof: exactSafeNoExposureProof({
        operation: input.operation,
        reset: input.reset,
        project,
      }),
    };
  }
  const proof = input.allowMigration0065RevisionDrift
    ? await migration0065RevisionOnlyProof({
        db: input.db,
        operation: input.operation,
        reset: input.reset,
        project,
      })
    : null;
  if (!proof) {
    throw new EsaProviderFailure(
      "SITEOPS_RESET_INVALIDATED",
      "官网重置坐标已变化，未向 ESA 提交下线操作。",
      "failed",
    );
  }
  return { project, proof };
}

/**
 * A disabled ESA runtime may acknowledge a reset only when the current
 * database coordinates prove that there is no unresolved ESA exposure. A
 * strictly completed reset and reset-invalidated deployment rows are durable
 * proof of removal; unrelated historical rows are not treated as current
 * exposure merely because they exist.
 */
export async function approvedResetHasNoUnresolvedExternalExposure(input: {
  db: DbExecutor;
  operation: SiteOperation;
  reset: ApprovedResetUnpublishInput;
  allowCanonicalHostname?: boolean;
  allowMigration0065RevisionDrift?: boolean;
}) {
  const exposureEvidenceLimit = 1_000;
  if (input.operation.provider !== "aliyun_esa") return null;
  const coordinates = await loadApprovedResetSafeNoExposureCoordinates({
    db: input.db,
    operation: input.operation,
    reset: input.reset,
    allowMigration0065RevisionDrift:
      input.allowMigration0065RevisionDrift === true,
  });
  const { project } = coordinates;
  if (
    project.globalLiveDeploymentId !== null ||
    project.mainlandLiveDeploymentId !== null ||
    (project.canonicalHostname !== null && !input.allowCanonicalHostname)
  ) {
    return null;
  }
  const deploymentRows = await input.db
    .select({
      id: siteDeployments.id,
      operationId: siteDeployments.operationId,
      verification: siteDeployments.verification,
    })
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.projectId, input.operation.projectId),
        eq(siteDeployments.userId, input.operation.userId),
      ),
    )
    .limit(exposureEvidenceLimit + 1);
  const priorEsaOperationRows = await input.db
    .select({
      id: siteOperations.id,
      projectId: siteOperations.projectId,
      kind: siteOperations.kind,
      status: siteOperations.status,
      input: siteOperations.input,
      result: siteOperations.result,
      providerOperationId: siteOperations.providerOperationId,
      providerTaskId: siteOperations.providerTaskId,
      errorCode: siteOperations.errorCode,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.operation.projectId),
        eq(siteOperations.userId, input.operation.userId),
        eq(siteOperations.provider, "aliyun_esa"),
        ne(siteOperations.id, input.operation.id),
      ),
    )
    .limit(exposureEvidenceLimit + 1);
  // A bounded classifier must fail closed when its evidence window is
  // exhausted. Silent truncation could hide a later active deployment or
  // provider mutation boundary and incorrectly authorize a no-ESA reset.
  if (
    deploymentRows.length > exposureEvidenceLimit ||
    priorEsaOperationRows.length > exposureEvidenceLimit
  ) {
    return null;
  }
  if (
    coordinates.proof.source === "migration_0065_revision_only" &&
    deploymentRows.length > 0
  ) {
    return null;
  }
  return approvedResetExternalExposureClassification({
    deployments: deploymentRows,
    operations: priorEsaOperationRows,
  }) === "safe_no_exposure"
    ? coordinates.proof
    : null;
}

function logApprovedResetStage(input: {
  operation: SiteOperation;
  status: "started" | SiteOpsProviderResult["status"];
  stage?: string;
  latencyMs?: number;
}) {
  const release = process.env.FRONTMIND_BUILD_SHA?.trim() ?? "";
  console.info("[siteops-esa] reset_unpublish", {
    event: "siteops_reset_unpublish",
    stage: input.stage ?? "reset_unpublish",
    status: input.status,
    operationId: input.operation.id,
    projectId: input.operation.projectId,
    ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    releaseSha: /^[a-f0-9]{40}$/u.test(release) ? release : null,
  });
}

async function approvedResetExposureRemoved(input: {
  publicHttpsFetch: typeof fetchPinnedPublicHttps;
  operation: SiteOperation;
  reset: ApprovedResetUnpublishInput;
  signal: AbortSignal;
  state: Record<string, unknown>;
  safeNoExposureProof?: ApprovedResetSafeNoExposureProof;
}) {
  const hostname = input.reset.expectedCanonicalHostname;
  if (hostname) {
    const origin = `https://${normalizeHostname(hostname)}`;
    const attempt = input.operation.attempt ?? 0;
    const retryPublicVerification = (
      stage: "public_marker_propagating" | "public_marker_verification_retry",
      terminalCode: string,
      terminalMessage: string,
    ) => {
      const started =
        input.state.stage === stage
          ? Number(input.state.stageStartedAttempt ?? attempt)
          : attempt;
      const retryState = {
        schemaVersion: 1,
        intent: APPROVED_RESET_UNPUBLISH,
        stage,
        stageStartedAttempt: started,
      };
      if (input.state.stage === stage && attempt - started >= 10) {
        throw new EsaProviderFailure(
          terminalCode,
          terminalMessage,
          "outcome_unknown",
          retryState,
        );
      }
      return pendingState(retryState);
    };
    try {
      const { response } = await input.publicHttpsFetch({
        url: `${origin}/${FRONTMIND_MARKER_PATH}`,
        signal: input.signal,
        headers: { accept: "application/json" },
        maxRedirects: 2,
        allowedOrigin: origin,
      });
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
      } else if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return retryPublicVerification(
          "public_marker_verification_retry",
          "RESET_PUBLIC_MARKER_VERIFICATION_UNAVAILABLE",
          "旧网站公开标记暂时无法确认，数据库重置尚未执行。",
        );
      } else {
        const body = await readResponseTextBounded(response, 4_096);
        let marker: unknown = null;
        try {
          marker = JSON.parse(body);
        } catch {
          marker = null;
        }
        const deploymentId =
          marker && typeof marker === "object"
            ? String((marker as Record<string, unknown>).deploymentId ?? "")
            : "";
        const previousHeads = new Set(
          [
            input.reset.expectedGlobalLiveDeploymentId,
            input.reset.expectedMainlandLiveDeploymentId,
          ].filter((value): value is string => Boolean(value)),
        );
        if (deploymentId && previousHeads.has(deploymentId)) {
          return retryPublicVerification(
            "public_marker_propagating",
            "RESET_UNPUBLISH_OUTCOME_UNKNOWN",
            "旧网站公开标记长时间未消失，数据库重置尚未执行。",
          );
        }
        // A successful marker response is proof that some FrontMind marker is
        // still publicly reachable, not proof that the old exposure vanished.
        // Only an explicit 404/410 can advance the destructive DB finalize.
        return retryPublicVerification(
          "public_marker_verification_retry",
          "RESET_PUBLIC_MARKER_VERIFICATION_UNAVAILABLE",
          "旧网站公开标记暂时无法确认，数据库重置尚未执行。",
        );
      }
    } catch (error) {
      if (error instanceof EsaProviderFailure) throw error;
      input.signal.throwIfAborted();
      // A DNS/TLS/socket failure can be transient. It is not positive proof
      // that every public edge stopped serving the old FrontMind marker.
      return retryPublicVerification(
        "public_marker_verification_retry",
        "RESET_PUBLIC_MARKER_VERIFICATION_UNAVAILABLE",
        "旧网站公开标记暂时无法确认，数据库重置尚未执行。",
      );
    }
  }
  return {
    status: "succeeded",
    result: {
      schemaVersion: 1,
      intent: APPROVED_RESET_UNPUBLISH,
      stage: "exposure_removed",
      ...(input.safeNoExposureProof
        ? { safeNoExposureProof: input.safeNoExposureProof }
        : {}),
    },
    message: "旧网站已从 ESA 安全下线。",
  } satisfies SiteOpsProviderResult;
}

async function handleApprovedResetUnpublish(input: {
  db: DbExecutor;
  api: EsaDirectApi;
  publicHttpsFetch: typeof fetchPinnedPublicHttps;
  operation: SiteOperation;
  reset: ApprovedResetUnpublishInput;
  signal: AbortSignal;
}) {
  const project = await loadApprovedResetProject(
    input.db,
    input.operation,
    input.reset,
  );
  const state = (input.operation.result ?? {}) as Record<string, unknown>;
  const name = routineName(project.id);
  let routine = await input.api.getRoutine(name);
  if (!routine) {
    return await approvedResetExposureRemoved({
      publicHttpsFetch: input.publicHttpsFetch,
      operation: input.operation,
      reset: input.reset,
      signal: input.signal,
      state,
    });
  }

  const hostname = input.reset.expectedCanonicalHostname;
  if (hostname) {
    const related = await input.api.listRelatedRecords({
      name,
      recordName: hostname,
    });
    const pendingRecordId = Number(state.relatedRecordId);
    const stageStartedAttempt = Number(state.stageStartedAttempt ?? 0);
    const pendingRelation = related.find(
      (entry) => entry.recordId === pendingRecordId,
    );
    if (pendingRelation && state.stage === "related_record_delete_unknown") {
      if ((input.operation.attempt ?? 0) - stageStartedAttempt < 5) {
        return pendingState(state);
      }
      throw new EsaProviderFailure(
        "ESA_RELATED_RECORD_DELETE_OUTCOME_UNKNOWN",
        "ESA 域名关联删除结果无法确认，系统没有重复提交删除。",
        "outcome_unknown",
        state,
      );
    }
    if (
      pendingRelation &&
      state.stage === "related_record_delete_propagating"
    ) {
      if ((input.operation.attempt ?? 0) - stageStartedAttempt < 10) {
        return pendingState(state);
      }
      throw new EsaProviderFailure(
        "ESA_RELATED_RECORD_DELETE_TIMEOUT",
        "ESA 域名关联删除长时间未在只读结果中生效。",
        "outcome_unknown",
        state,
      );
    }
    const relation = related[0];
    if (relation) {
      const boundary = {
        schemaVersion: 1,
        intent: APPROVED_RESET_UNPUBLISH,
        stage: "related_record_delete_unknown",
        stageStartedAttempt: input.operation.attempt ?? 0,
        relatedRecordId: relation.recordId,
        siteId: relation.siteId,
      };
      await persistApprovedResetBoundary(input.db, input.operation, boundary);
      input.signal.throwIfAborted();
      try {
        await input.api.deleteRelatedRecord({
          name,
          recordId: relation.recordId,
          recordName: hostname,
          siteId: relation.siteId,
        });
      } catch {
        return pendingState(boundary);
      }
      const observed = await input.api.listRelatedRecords({
        name,
        recordName: hostname,
      });
      if (observed.some((entry) => entry.recordId === relation.recordId)) {
        return pendingState({
          ...boundary,
          stage: "related_record_delete_propagating",
          stageStartedAttempt: input.operation.attempt ?? 0,
        });
      }
      // A Routine may contain more than one exact historical binding. Remove
      // one observed coordinate per lease and reconcile again before deleting
      // the Routine itself.
      if (observed.length > 0) {
        return pendingState({
          schemaVersion: 1,
          intent: APPROVED_RESET_UNPUBLISH,
          stage: "related_record_reconciling",
        });
      }
    }
  }

  routine = await input.api.getRoutine(name);
  if (!routine) {
    return await approvedResetExposureRemoved({
      publicHttpsFetch: input.publicHttpsFetch,
      operation: input.operation,
      reset: input.reset,
      signal: input.signal,
      state,
    });
  }
  if (state.stage === "routine_delete_unknown") {
    if (
      (input.operation.attempt ?? 0) - Number(state.stageStartedAttempt ?? 0) <
      5
    ) {
      return pendingState(state);
    }
    throw new EsaProviderFailure(
      "ESA_ROUTINE_DELETE_OUTCOME_UNKNOWN",
      "ESA Routine 删除结果无法确认，系统没有重复提交删除。",
      "outcome_unknown",
      state,
    );
  }
  if (state.stage === "routine_delete_propagating") {
    if (
      (input.operation.attempt ?? 0) - Number(state.stageStartedAttempt ?? 0) <
      10
    ) {
      return pendingState(state);
    }
    throw new EsaProviderFailure(
      "ESA_ROUTINE_DELETE_TIMEOUT",
      "ESA Routine 删除长时间未在只读结果中生效。",
      "outcome_unknown",
      state,
    );
  }
  const boundary = {
    schemaVersion: 1,
    intent: APPROVED_RESET_UNPUBLISH,
    stage: "routine_delete_unknown",
    stageStartedAttempt: input.operation.attempt ?? 0,
  };
  await persistApprovedResetBoundary(input.db, input.operation, boundary);
  input.signal.throwIfAborted();
  try {
    await input.api.deleteRoutine(name);
  } catch {
    return pendingState(boundary);
  }
  routine = await input.api.getRoutine(name);
  if (routine) {
    return pendingState({
      ...boundary,
      stage: "routine_delete_propagating",
      stageStartedAttempt: input.operation.attempt ?? 0,
    });
  }
  return await approvedResetExposureRemoved({
    publicHttpsFetch: input.publicHttpsFetch,
    operation: input.operation,
    reset: input.reset,
    signal: input.signal,
    state,
  });
}

async function loadDeploymentContext(db: DbExecutor, operation: SiteOperation) {
  const rows = await db
    .select({
      deployment: siteDeployments,
      project: siteProjects,
      build: siteBuilds,
    })
    .from(siteDeployments)
    .innerJoin(siteProjects, eq(siteProjects.id, siteDeployments.projectId))
    .innerJoin(
      siteBuilds,
      and(
        eq(siteBuilds.id, siteDeployments.buildId),
        eq(siteBuilds.projectId, siteDeployments.projectId),
        eq(siteBuilds.userId, siteDeployments.userId),
      ),
    )
    .where(
      and(
        eq(siteDeployments.operationId, operation.id),
        eq(siteDeployments.userId, operation.userId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new EsaProviderFailure(
      "ESA_DEPLOYMENT_CONTEXT_NOT_FOUND",
      "ESA 发布记录不存在。",
      "failed",
    );
  }
  return rows[0];
}

type DeploymentContext = Awaited<ReturnType<typeof loadDeploymentContext>>;
type ProductionMaterialization = z.infer<
  typeof productionMaterializationSchema
>;

function materializationFromVerification(
  verification: Record<string, unknown> | null,
) {
  if (!verification) return null;
  const parsed = productionMaterializationSchema.safeParse(
    verification.productionMaterialization,
  );
  return parsed.success ? parsed.data : null;
}

function assertFrozenProductionMaterialization(input: {
  context: DeploymentContext;
  materialization: ProductionMaterialization;
  canonicalOrigin: string;
}) {
  const { context, materialization, canonicalOrigin } = input;
  if (
    !context.build.sourceLocalAssetId ||
    !context.build.sourceHash ||
    materialization.canonicalOrigin !== canonicalOrigin ||
    materialization.target !== context.deployment.target ||
    materialization.sourceLocalAssetId !== context.build.sourceLocalAssetId ||
    materialization.sourceSha256 !== context.build.sourceHash ||
    (context.build.workflowVersion === SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION &&
      (materialization.contentPlanLocalAssetId !==
        context.build.contentPlanLocalAssetId ||
        materialization.contentPlanSha256 !==
          context.build.contentPlanSha256)) ||
    materialization.distLocalAssetId !== context.deployment.distLocalAssetId ||
    materialization.distSha256 !== context.deployment.distHash
  ) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_MATERIALIZATION_CONFLICT",
      "发布记录中的 production 产物与冻结源码、域名或目标不一致；未向 ESA 提交任何变更。",
      "failed",
    );
  }
}

async function persistCheckedArtifact(input: {
  persistArtifact: typeof persistSiteOpsArtifact;
  userId: number;
  projectId: string;
  kind: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  expectedSha256: string;
}) {
  const artifact = await input.persistArtifact({
    userId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    filename: input.filename,
    mimeType: input.mimeType,
    buffer: input.buffer,
  });
  if (artifact.contentSha256 !== input.expectedSha256) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_ARTIFACT_HASH_MISMATCH",
      "production 产物写入后的摘要与受控构建结果不一致；未向 ESA 提交任何变更。",
      "failed",
    );
  }
  return artifact;
}

/**
 * Materializes and freezes a hostname-specific production build before the
 * first ESA mutation. A retry either consumes this exact record or fails
 * closed; it can never fall back to the build's preview/noindex dist.
 */
function validatedProductionContentPlan(input: {
  workflowVersion: string;
  contentPlan: unknown;
  contentPlanSha256: string | null;
}) {
  if (input.workflowVersion !== SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION) {
    return undefined;
  }
  const parsed = siteContentPlanV2Schema.safeParse(input.contentPlan);
  if (
    !parsed.success ||
    !/^[a-f0-9]{64}$/u.test(input.contentPlanSha256 ?? "")
  ) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTENT_PLAN_INVALID",
      "冻结内容计划缺失或无效，不能生成 production 产物。",
      "failed",
    );
  }
  const actualSha256 = createHash("sha256")
    .update(`${canonicalJson(parsed.data)}\n`, "utf8")
    .digest("hex");
  if (actualSha256 !== input.contentPlanSha256) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTENT_PLAN_INVALID",
      "冻结内容计划缺失或无效，不能生成 production 产物。",
      "failed",
    );
  }
  return parsed.data;
}

export async function materializeSiteOpsProductionSource(input: {
  sourceZip: Buffer;
  sourceSha256: string;
  contentPlan: SiteContentPlanV2 | unknown | undefined;
  requiredUserMedia?: readonly {
    publicPath: string;
    contentSha256: string;
  }[];
  requiredKnowledgeMedia?: readonly {
    assetId: string;
    publicPath: string;
    contentSha256: string;
    routePaths: readonly string[];
  }[];
  build: Pick<
    typeof siteBuilds.$inferSelect,
    | "id"
    | "projectId"
    | "knowledgeSnapshotId"
    | "workflowVersion"
    | "selectionHash"
    | "contentPlanSha256"
    | "brief"
  >;
  target: "global_excluding_cn" | "mainland_cn";
  canonicalOrigin: string;
  materializeProduction: typeof materializeProductionSiteFromSource;
  materializeNativeProduction: typeof rebuildNativeReactProductionFromSource;
  signal: AbortSignal;
}) {
  if (!isSiteOpsNativeVisualWorkflowVersion(input.build.workflowVersion)) {
    return await input.materializeProduction({
      sourceZip: input.sourceZip,
      expectedSourceSha256: input.sourceSha256,
      canonicalOrigin: input.canonicalOrigin,
      target: input.target,
      timeoutMs: 70_000,
      abortSignal: input.signal,
    });
  }
  const contentPlan = validatedProductionContentPlan({
    workflowVersion: input.build.workflowVersion,
    contentPlan: input.contentPlan,
    contentPlanSha256: input.build.contentPlanSha256,
  });
  const archive = await JSZip.loadAsync(input.sourceZip, { checkCRC32: true });
  const fileCount = Object.values(archive.files).filter(
    (entry) => !entry.dir,
  ).length;
  const validatedSource = await validateNativeReactSourceArchive({
    archive: input.sourceZip,
    receipt: {
      operationToken: "frontmind-production-rebuild",
      baseSourceSha256: input.sourceSha256,
      archiveSha256: input.sourceSha256,
      fileCount,
    },
    expectedOperationToken: "frontmind-production-rebuild",
    expectedBaseSourceSha256: input.sourceSha256,
  });
  const native = await input.materializeNativeProduction({
    sourceZip: input.sourceZip,
    validatedSource,
    build: {
      id: input.build.id,
      projectId: input.build.projectId,
      knowledgeSnapshotId: input.build.knowledgeSnapshotId,
      workflowVersion: input.build.workflowVersion,
      selectionHash: input.build.selectionHash,
    },
    brief: input.build.brief,
    contentPlan,
    contentPlanSha256: input.build.contentPlanSha256,
    requiredUserMedia: input.requiredUserMedia,
    requiredKnowledgeMedia: input.requiredKnowledgeMedia,
    canonicalOrigin: input.canonicalOrigin,
    target: input.target,
    timeoutMs: 70_000,
    abortSignal: input.signal,
  });
  return {
    contractJson: native.contractJson,
    contractSha256: native.contractSha256,
    sourceZip: native.sourceZip,
    sourceSha256: native.sourceSha256,
    distZip: native.distZip,
    distSha256: native.distSha256,
    qaZip: native.visualQaZip,
    qaSha256: native.visualQaSha256,
    qaReport: JSON.parse(native.qaJson.toString("utf8")),
    buildDelivery: native.buildDelivery as never,
    provenanceJson: native.provenanceJson,
    provenanceSha256: native.provenanceSha256,
  } satisfies Awaited<ReturnType<typeof materializeProductionSiteFromSource>>;
}

export function productionContractMatchesFrozenBuild(input: {
  contractValue: Record<string, unknown>;
  build: Pick<
    typeof siteBuilds.$inferSelect,
    "id" | "projectId" | "workflowVersion" | "sourceHash" | "contentPlanSha256"
  >;
  canonicalOrigin: string;
  target: "global_excluding_cn" | "mainland_cn";
}) {
  const { build, canonicalOrigin, contractValue, target } = input;
  if (contractValue.contractKind === "twenty_first_native_build_contract") {
    const requiresFrozenContentPlan =
      build.workflowVersion === SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION;
    return (
      contractValue.renderer === "twenty_first_native_react_v1" &&
      contractValue.buildId === build.id &&
      contractValue.projectId === build.projectId &&
      contractValue.mode === "production" &&
      contractValue.canonicalOrigin === canonicalOrigin &&
      contractValue.target === target &&
      contractValue.sourceSha256 === build.sourceHash &&
      (!requiresFrozenContentPlan ||
        (/^[a-f0-9]{64}$/u.test(build.contentPlanSha256 ?? "") &&
          contractValue.contentPlanSha256 === build.contentPlanSha256))
    );
  }
  const parsed = buildContractV2Schema.safeParse(contractValue);
  return (
    parsed.success &&
    parsed.data.seo.environment === "production" &&
    parsed.data.target.environment === target &&
    parsed.data.target.canonicalOrigin === canonicalOrigin
  );
}

async function readFrozenProductionContentPlan(input: {
  context: DeploymentContext;
  operation: SiteOperation;
  readArtifact: typeof readSiteOpsArtifact;
}) {
  const { build } = input.context;
  if (build.workflowVersion !== SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION) {
    return undefined;
  }
  if (!build.contentPlanLocalAssetId || !build.contentPlanSha256) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTENT_PLAN_NOT_FOUND",
      "已批准版本缺少冻结内容计划，不能生成 production 产物。",
      "failed",
    );
  }
  try {
    const artifact = await input.readArtifact({
      userId: input.operation.userId,
      localAssetId: build.contentPlanLocalAssetId,
      expectedSha256: build.contentPlanSha256,
      expectedMimeTypes: ["application/json"],
    });
    if (!artifact) {
      throw new EsaProviderFailure(
        "ESA_PRODUCTION_CONTENT_PLAN_NOT_FOUND",
        "已批准版本缺少冻结内容计划，不能生成 production 产物。",
        "failed",
      );
    }
    const bytes = await streamFrozenContentPlan(
      artifact.stored.createReadStream(),
      artifact.row.sizeBytes,
    );
    const candidate = JSON.parse(bytes.toString("utf8")) as unknown;
    return validatedProductionContentPlan({
      workflowVersion: build.workflowVersion,
      contentPlan: candidate,
      contentPlanSha256: build.contentPlanSha256,
    });
  } catch (error) {
    if (error instanceof EsaProviderFailure) throw error;
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTENT_PLAN_INVALID",
      "冻结内容计划缺失或无效，不能生成 production 产物。",
      "failed",
    );
  }
}

export async function loadFrozenProductionMediaRequirements(input: {
  db: DbExecutor;
  context: DeploymentContext;
  operation: SiteOperation;
  contentPlan: SiteContentPlanV2 | undefined;
}) {
  if (!input.contentPlan) {
    return {
      requiredUserMedia: [] as Array<{
        publicPath: string;
        contentSha256: string;
      }>,
      requiredKnowledgeMedia: [] as Array<{
        assetId: string;
        publicPath: string;
        contentSha256: string;
        routePaths: string[];
      }>,
    };
  }
  const failUserMedia = (): never => {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_REVISION_MEDIA_INVALID",
      "连续修订的冻结图片来源链缺失或无效，不能生成 production 产物。",
      "failed",
    );
  };
  let userMediaRows: Array<typeof siteBuildInputAssets.$inferSelect> = [];
  if (input.context.build.parentBuildId) {
    try {
      const builds = (await input.db
        .select()
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.projectId, input.context.build.projectId),
            eq(siteBuilds.userId, input.operation.userId),
            gte(
              siteBuilds.createdAt,
              input.context.project.currentTaskStartedAt,
            ),
          ),
        )) as Array<typeof siteBuilds.$inferSelect>;
      const buildIds = builds.map((row) => row.id);
      if (buildIds.length === 0) failUserMedia();
      const [operations, assets] = await Promise.all([
        input.db
          .select()
          .from(siteOperations)
          .where(inArray(siteOperations.buildId, buildIds)),
        input.db
          .select()
          .from(siteBuildInputAssets)
          .where(inArray(siteBuildInputAssets.buildId, buildIds)),
      ]);
      userMediaRows = siteOpsRevisionLineageFromRows({
        currentBuild: input.context.build,
        projectId: input.context.build.projectId,
        userId: input.operation.userId,
        taskStartedAt: input.context.project.currentTaskStartedAt,
        knowledgeInputEpochId: input.context.project.knowledgeInputEpochId,
        builds,
        operations,
        assets,
        includeCurrentBuild: true,
      }).assets.map(({ row }) => row);
    } catch (error) {
      if (error instanceof EsaProviderFailure) throw error;
      failUserMedia();
    }
  } else {
    const unexpectedRootAssets = await input.db
      .select()
      .from(siteBuildInputAssets)
      .where(
        and(
          eq(siteBuildInputAssets.buildId, input.context.build.id),
          eq(siteBuildInputAssets.projectId, input.context.build.projectId),
          eq(siteBuildInputAssets.userId, input.operation.userId),
        ),
      );
    if (unexpectedRootAssets.length > 0) failUserMedia();
  }
  const expectedExtension = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ] as const);
  const customerMediaById = new Map<string, (typeof userMediaRows)[number]>();
  const uniqueUserMediaByPublicPath = new Map<
    string,
    (typeof userMediaRows)[number]
  >();
  const userMediaByLocalAsset = new Map<
    string,
    (typeof userMediaRows)[number]
  >();
  const sameRenderedMedia = (
    left: (typeof userMediaRows)[number],
    right: (typeof userMediaRows)[number],
  ) =>
    left.publicPath === right.publicPath &&
    left.contentSha256 === right.contentSha256 &&
    left.mimeType === right.mimeType &&
    left.sizeBytes === right.sizeBytes &&
    left.width === right.width &&
    left.height === right.height;
  for (const asset of userMediaRows) {
    const extension = expectedExtension.get(
      asset.mimeType as "image/jpeg" | "image/png" | "image/webp",
    );
    const customerMediaId = `customer-media:${createHash("sha256")
      .update(asset.publicPath, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    if (
      !extension ||
      !/^[a-f0-9]{64}$/u.test(asset.contentSha256) ||
      asset.publicPath !==
        `/frontmind-user-media/${asset.contentSha256}.${extension}` ||
      asset.sizeBytes < 1 ||
      asset.sizeBytes > 8 * 1024 * 1024 ||
      asset.width < 1 ||
      asset.height < 1
    ) {
      failUserMedia();
    }
    const samePath = uniqueUserMediaByPublicPath.get(asset.publicPath);
    const sameLocalAsset = userMediaByLocalAsset.get(asset.localAssetId);
    const sameCustomerId = customerMediaById.get(customerMediaId);
    if (
      (samePath && !sameRenderedMedia(samePath, asset)) ||
      (sameLocalAsset && !sameRenderedMedia(sameLocalAsset, asset)) ||
      (sameCustomerId && !sameRenderedMedia(sameCustomerId, asset))
    ) {
      failUserMedia();
    }
    if (samePath) {
      if (!sameLocalAsset) userMediaByLocalAsset.set(asset.localAssetId, asset);
      continue;
    }
    uniqueUserMediaByPublicPath.set(asset.publicPath, asset);
    userMediaByLocalAsset.set(asset.localAssetId, asset);
    customerMediaById.set(customerMediaId, asset);
  }
  const routePathsByMediaId = new Map<string, Set<string>>();
  const selectedCustomerMediaIds = new Set<string>();
  for (const route of input.contentPlan.routes) {
    for (const mediaId of new Set(
      route.sections.flatMap((section) => section.mediaIds),
    )) {
      if (mediaId.startsWith("customer-media:")) {
        if (
          !/^customer-media:[a-f0-9]{32}$/u.test(mediaId) ||
          !customerMediaById.has(mediaId)
        ) {
          failUserMedia();
        }
        selectedCustomerMediaIds.add(mediaId);
        continue;
      }
      const routePaths = routePathsByMediaId.get(mediaId) ?? new Set<string>();
      routePaths.add(route.path);
      routePathsByMediaId.set(mediaId, routePaths);
    }
  }
  const requiredUserMedia = [...selectedCustomerMediaIds].map((mediaId) => {
    const asset = customerMediaById.get(mediaId);
    if (!asset) return failUserMedia();
    return {
      publicPath: asset.publicPath,
      contentSha256: asset.contentSha256,
    };
  });
  if (routePathsByMediaId.size === 0) {
    return { requiredUserMedia, requiredKnowledgeMedia: [] };
  }
  const snapshotRows = await input.db
    .select({ assets: knowledgeBaseSnapshots.assets })
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.context.build.knowledgeSnapshotId),
        eq(knowledgeBaseSnapshots.userId, input.operation.userId),
      ),
    )
    .limit(1);
  const snapshotAssets = snapshotRows[0]?.assets;
  if (!snapshotAssets) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTENT_PLAN_MEDIA_INVALID",
      "冻结内容计划引用的知识图片缺失或无效，不能生成 production 产物。",
      "failed",
    );
  }
  const requiredKnowledgeMedia = [...routePathsByMediaId].map(
    ([assetId, routePaths]) => {
      const matches = snapshotAssets.filter((asset) => asset.id === assetId);
      const asset = matches[0];
      const extension = asset
        ? expectedExtension.get(
            asset.mimeType as "image/jpeg" | "image/png" | "image/webp",
          )
        : undefined;
      if (
        matches.length !== 1 ||
        !asset ||
        asset.ownership !== "first_party" ||
        !extension ||
        !/^[a-f0-9]{64}$/u.test(asset.sha256 ?? "") ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 1 ||
        asset.size > 8 * 1024 * 1024
      ) {
        throw new EsaProviderFailure(
          "ESA_PRODUCTION_CONTENT_PLAN_MEDIA_INVALID",
          "冻结内容计划引用的知识图片缺失或无效，不能生成 production 产物。",
          "failed",
        );
      }
      return {
        assetId,
        publicPath: `/frontmind-knowledge-media/${asset.sha256}.${extension}`,
        contentSha256: asset.sha256!,
        routePaths: [...routePaths],
      };
    },
  );
  return { requiredUserMedia, requiredKnowledgeMedia };
}

async function ensureProductionMaterialization(input: {
  db: DbExecutor;
  operation: SiteOperation;
  context: DeploymentContext;
  canonicalOrigin: string;
  readArtifact: typeof readSiteOpsArtifact;
  persistArtifact: typeof persistSiteOpsArtifact;
  materializeProduction: typeof materializeProductionSiteFromSource;
  materializeNativeProduction: typeof rebuildNativeReactProductionFromSource;
  signal: AbortSignal;
}) {
  const existing = materializationFromVerification(
    input.context.deployment.verification,
  );
  if (existing) {
    assertFrozenProductionMaterialization({
      context: input.context,
      materialization: existing,
      canonicalOrigin: input.canonicalOrigin,
    });
    return {
      context: input.context,
      materialization: existing,
      created: false,
    };
  }
  if (
    !input.context.build.sourceLocalAssetId ||
    !input.context.build.sourceHash
  ) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_SOURCE_NOT_FOUND",
      "已批准版本缺少冻结 source ZIP，不能生成 production 产物。",
      "failed",
    );
  }
  if (input.signal.aborted) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_MATERIALIZATION_ABORTED",
      "production 产物生成在开始前已超时；未向 ESA 提交任何变更。",
    );
  }
  const sourceArtifact = await input.readArtifact({
    userId: input.operation.userId,
    localAssetId: input.context.build.sourceLocalAssetId,
    expectedSha256: input.context.build.sourceHash,
    expectedMimeTypes: ["application/zip"],
  });
  if (!sourceArtifact) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_SOURCE_NOT_FOUND",
      "冻结 source ZIP 不存在，不能生成 production 产物。",
      "failed",
    );
  }
  const sourceZip = await streamToBuffer(
    sourceArtifact.stored.createReadStream(),
    sourceArtifact.row.sizeBytes,
  );
  const contentPlan = await readFrozenProductionContentPlan({
    context: input.context,
    operation: input.operation,
    readArtifact: input.readArtifact,
  });
  const mediaRequirements = await loadFrozenProductionMediaRequirements({
    db: input.db,
    context: input.context,
    operation: input.operation,
    contentPlan,
  });
  let output: Awaited<ReturnType<typeof materializeProductionSiteFromSource>>;
  try {
    output = await materializeSiteOpsProductionSource({
      sourceZip,
      sourceSha256: input.context.build.sourceHash,
      contentPlan,
      ...mediaRequirements,
      build: input.context.build,
      target: input.context.deployment.target,
      canonicalOrigin: input.canonicalOrigin,
      materializeProduction: input.materializeProduction,
      materializeNativeProduction: input.materializeNativeProduction,
      signal: input.signal,
    });
  } catch (error) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_MATERIALIZATION_FAILED",
      "production 产物生成或 QA 未通过；未向 ESA 提交任何变更。",
      "failed",
    );
  }
  const contractValue = JSON.parse(
    output.contractJson.toString("utf8"),
  ) as Record<string, unknown>;
  const contractValid = productionContractMatchesFrozenBuild({
    contractValue,
    build: input.context.build,
    canonicalOrigin: input.canonicalOrigin,
    target: input.context.deployment.target,
  });
  if (
    !contractValid ||
    output.qaReport.mode !== "production" ||
    output.qaReport.passed !== true
  ) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_CONTRACT_INVALID",
      "受控构建没有生成精确 production target、canonical 或通过的 QA；未向 ESA 提交任何变更。",
      "failed",
    );
  }
  if (input.signal.aborted) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_MATERIALIZATION_ABORTED",
      "production 产物生成后任务已超时；未向 ESA 提交任何变更。",
    );
  }
  const artifactPrefix = `${input.context.deployment.id}-production`;
  const common = {
    persistArtifact: input.persistArtifact,
    userId: input.operation.userId,
    projectId: input.operation.projectId,
  };
  const contractArtifact = await persistCheckedArtifact({
    ...common,
    kind: "site-production-contract",
    filename: `${artifactPrefix}-contract.json`,
    mimeType: "application/json",
    buffer: output.contractJson,
    expectedSha256: output.contractSha256,
  });
  const productionSourceArtifact = await persistCheckedArtifact({
    ...common,
    kind: "site-production-source",
    filename: `${artifactPrefix}-source.zip`,
    mimeType: "application/zip",
    buffer: output.sourceZip,
    expectedSha256: output.sourceSha256,
  });
  const distArtifact = await persistCheckedArtifact({
    ...common,
    kind: "site-production-dist",
    filename: `${artifactPrefix}-dist.zip`,
    mimeType: "application/zip",
    buffer: output.distZip,
    expectedSha256: output.distSha256,
  });
  const qaArtifact = await persistCheckedArtifact({
    ...common,
    kind: "site-production-qa",
    filename: `${artifactPrefix}-qa.zip`,
    mimeType: "application/zip",
    buffer: output.qaZip,
    expectedSha256: output.qaSha256,
  });
  const provenanceArtifact = await persistCheckedArtifact({
    ...common,
    kind: "site-production-provenance",
    filename: `${artifactPrefix}-provenance.json`,
    mimeType: "application/json",
    buffer: output.provenanceJson,
    expectedSha256: output.provenanceSha256,
  });
  const materialization = productionMaterializationSchema.parse({
    schemaVersion: 1,
    canonicalOrigin: input.canonicalOrigin,
    target: input.context.deployment.target,
    sourceLocalAssetId: input.context.build.sourceLocalAssetId,
    sourceSha256: input.context.build.sourceHash,
    ...(input.context.build.workflowVersion ===
    SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION
      ? {
          contentPlanLocalAssetId: input.context.build.contentPlanLocalAssetId,
          contentPlanSha256: input.context.build.contentPlanSha256,
        }
      : {}),
    contractLocalAssetId: contractArtifact.id,
    contractSha256: output.contractSha256,
    productionSourceLocalAssetId: productionSourceArtifact.id,
    productionSourceSha256: output.sourceSha256,
    distLocalAssetId: distArtifact.id,
    distSha256: output.distSha256,
    qaLocalAssetId: qaArtifact.id,
    qaSha256: output.qaSha256,
    provenanceLocalAssetId: provenanceArtifact.id,
    provenanceSha256: output.provenanceSha256,
    qaPolicyVersion: output.qaReport.policyVersion,
    materializedAt: new Date().toISOString(),
  });
  const previousVerification =
    input.context.deployment.verification ?? ({} as Record<string, unknown>);
  await input.db
    .update(siteDeployments)
    .set({
      distLocalAssetId: materialization.distLocalAssetId,
      distHash: materialization.distSha256,
      verification: {
        ...previousVerification,
        productionMaterialization: materialization,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(siteDeployments.id, input.context.deployment.id),
        eq(siteDeployments.operationId, input.operation.id),
        eq(siteDeployments.status, "reserved"),
        eq(
          siteDeployments.distLocalAssetId,
          input.context.deployment.distLocalAssetId,
        ),
        eq(siteDeployments.distHash, input.context.deployment.distHash),
      ),
    );
  const refreshed = await loadDeploymentContext(input.db, input.operation);
  const frozen = materializationFromVerification(
    refreshed.deployment.verification,
  );
  if (!frozen) {
    throw new EsaProviderFailure(
      "ESA_PRODUCTION_MATERIALIZATION_CAS_CONFLICT",
      "production 产物冻结时发布记录已变化；未向 ESA 提交任何变更。",
      "failed",
    );
  }
  assertFrozenProductionMaterialization({
    context: refreshed,
    materialization: frozen,
    canonicalOrigin: input.canonicalOrigin,
  });
  return { context: refreshed, materialization: frozen, created: true };
}

async function ensureRoutine(input: {
  db: DbExecutor;
  api: EsaDirectApi;
  operation: SiteOperation;
  name: string;
  state: Record<string, unknown>;
}) {
  const existing = await input.api.getRoutine(input.name);
  if (existing) {
    if (!existing.hasAssets) {
      throw new EsaProviderFailure(
        "ESA_ROUTINE_TYPE_MISMATCH",
        "同名 ESA Routine 不是静态资产项目。",
        "failed",
      );
    }
    return existing;
  }
  if (input.state.stage === "routine_create_unknown") {
    if ((input.operation.attempt ?? 0) < 5) return null;
    throw new EsaProviderFailure(
      "ESA_ROUTINE_CREATE_OUTCOME_UNKNOWN",
      "ESA Routine 创建响应丢失且只读查询未找到唯一结果；系统没有重复创建。",
    );
  }
  const next = {
    ...input.state,
    stage: "routine_create_unknown",
    routineName: input.name,
  };
  await persistBoundary(input.db, input.operation, next);
  try {
    await input.api.createRoutine({
      name: input.name,
      description: `FrontMind SiteOps project ${input.operation.projectId}`,
    });
  } catch {
    return null;
  }
  return input.api.getRoutine(input.name);
}

export function coverageForTarget(
  target: "global_excluding_cn" | "mainland_cn",
): EsaSiteCoverage {
  return target === "mainland_cn" ? "domestic" : "overseas";
}

async function ensureSiteCoverage(input: {
  db: DbExecutor;
  api: EsaDirectApi;
  operation: SiteOperation;
  site: EsaSiteView;
  recordName: string;
  target: "global_excluding_cn" | "mainland_cn";
  state: Record<string, unknown>;
}) {
  const expectedCoverage = coverageForTarget(input.target);
  if (input.site.coverage.trim().toLowerCase() === expectedCoverage) {
    return input.site;
  }
  if (input.state.stage === "coverage_update_unknown") {
    if ((input.operation.attempt ?? 0) < 8) return null;
    throw new EsaProviderFailure(
      "ESA_COVERAGE_UPDATE_OUTCOME_UNKNOWN",
      `ESA coverage 更新响应丢失且只读查询仍不是 ${expectedCoverage}；系统没有重复提交。`,
    );
  }
  const pending = {
    ...input.state,
    stage: "coverage_update_unknown",
    siteId: input.site.siteId,
    expectedCoverage,
  };
  await persistBoundary(input.db, input.operation, pending);
  try {
    await input.api.updateSiteCoverage({
      siteId: input.site.siteId,
      coverage: expectedCoverage,
    });
  } catch {
    return null;
  }
  try {
    const observed = await input.api.getMatchSite(input.recordName);
    return observed?.coverage.trim().toLowerCase() === expectedCoverage
      ? observed
      : null;
  } catch {
    return null;
  }
}

async function uploadOssForm(input: {
  fetchImpl: typeof globalThis.fetch;
  upload: EsaOssPostConfig;
  packageBytes: Buffer;
  signal: AbortSignal;
}) {
  const url = new URL(input.upload.url);
  const ossHostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !(
      ossHostname === "aliyuncs.com" ||
      ossHostname.endsWith(".aliyuncs.com") ||
      ossHostname.endsWith(".aliyuncs.com.cn")
    )
  ) {
    throw new EsaProviderFailure(
      "ESA_OSS_UPLOAD_URL_UNSAFE",
      "ESA 返回了不安全的 OSS 上传地址。",
      "failed",
    );
  }
  const form = new FormData();
  form.set("OSSAccessKeyId", input.upload.accessKeyId);
  form.set("Signature", input.upload.signature);
  if (input.upload.securityToken)
    form.set("x-oss-security-token", input.upload.securityToken);
  form.set("policy", input.upload.policy);
  form.set("key", input.upload.key);
  form.set(
    "file",
    new Blob([new Uint8Array(input.packageBytes)], { type: "application/zip" }),
    "siteops-assets.zip",
  );
  const response = await input.fetchImpl(url, {
    method: "POST",
    body: form,
    redirect: "error",
    signal: input.signal,
  });
  if (response.status !== 200 && response.status !== 204) {
    throw new EsaProviderFailure(
      `ESA_OSS_UPLOAD_HTTP_${response.status}`,
      "ESA OSS 明确拒绝了静态资产上传；系统不会用同一版本盲目重传。",
    );
  }
}

async function readResponseTextBounded(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new EsaProviderFailure(
      "ESA_PUBLIC_RESPONSE_TOO_LARGE",
      "ESA 线上验证响应超过安全上限。",
      "failed",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new EsaProviderFailure(
          "ESA_PUBLIC_RESPONSE_TOO_LARGE",
          "ESA 线上验证响应超过安全上限。",
          "failed",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function available(status: string) {
  return status.trim().toLowerCase() === "available";
}

function initializing(status: string) {
  return ["", "init", "initializing", "processing", "pending"].includes(
    status.trim().toLowerCase(),
  );
}

async function resolveCodeVersion(input: {
  db: DbExecutor;
  api: EsaDirectApi;
  operation: SiteOperation;
  context: Awaited<ReturnType<typeof loadDeploymentContext>>;
  name: string;
  state: Record<string, unknown>;
  fetchImpl: typeof globalThis.fetch;
  readArtifact: typeof readSiteOpsArtifact;
  signal: AbortSignal;
}) {
  const marker = versionMarker(
    input.context.deployment.id,
    input.context.deployment.distHash,
  );
  let codeVersion =
    typeof input.state.codeVersion === "string"
      ? input.state.codeVersion
      : null;
  if (!codeVersion && input.state.stage === "version_create_unknown") {
    const matches = await input.api.listCodeVersions({
      name: input.name,
      marker,
    });
    if (matches.length === 0 && (input.operation.attempt ?? 0) < 5) return null;
    if (matches.length !== 1) {
      throw new EsaProviderFailure(
        "ESA_CODE_VERSION_CREATE_OUTCOME_UNKNOWN",
        matches.length > 1
          ? "ESA 返回多个相同冻结指纹的代码版本，拒绝猜测。"
          : "ESA 代码版本创建响应丢失且只读查询未找到结果；系统没有重复创建。",
      );
    }
    codeVersion = matches[0].codeVersion;
  }
  if (codeVersion) {
    const info = await input.api.getCodeVersion({
      name: input.name,
      codeVersion,
    });
    if (!info)
      throw new EsaProviderFailure(
        "ESA_CODE_VERSION_NOT_FOUND",
        "已冻结的 ESA 代码版本不存在。",
      );
    if (available(info.status)) return codeVersion;
    if (initializing(info.status)) {
      if ((input.operation.attempt ?? 0) < 30) return null;
      throw new EsaProviderFailure(
        "ESA_CODE_VERSION_PROCESSING_TIMEOUT",
        "ESA 静态资产版本长时间未完成；系统没有重复上传。",
      );
    }
    throw new EsaProviderFailure(
      "ESA_CODE_VERSION_FAILED",
      `ESA 静态资产版本处理失败：${info.status || "unknown"}`,
      "failed",
    );
  }
  const artifact = await input.readArtifact({
    userId: input.operation.userId,
    localAssetId: input.context.deployment.distLocalAssetId,
    expectedSha256: input.context.deployment.distHash,
    expectedMimeTypes: ["application/zip"],
  });
  if (!artifact)
    throw new EsaProviderFailure(
      "ESA_DIST_NOT_FOUND",
      "冻结的官网 dist ZIP 不存在。",
      "failed",
    );
  const dist = await streamToBuffer(
    artifact.stored.createReadStream(),
    artifact.row.sizeBytes,
  );
  const packageBytes = await packageEsaStaticAssets({
    distZip: dist,
    deploymentId: input.context.deployment.id,
    distHash: input.context.deployment.distHash,
  });
  const createState = {
    ...input.state,
    stage: "version_create_unknown",
    routineName: input.name,
    marker,
  };
  await persistBoundary(input.db, input.operation, createState);
  let created: Awaited<ReturnType<EsaDirectApi["createAssetsCodeVersion"]>>;
  try {
    created = await input.api.createAssetsCodeVersion({
      name: input.name,
      description: marker,
      extraInfo: JSON.stringify({
        source: "frontmind-siteops",
        marker,
        deploymentId: input.context.deployment.id,
        distSha256: input.context.deployment.distHash,
      }),
    });
  } catch {
    return null;
  }
  const uploadState = {
    ...createState,
    stage: "upload_unknown",
    codeVersion: created.codeVersion,
  };
  await persistBoundary(input.db, input.operation, uploadState);
  try {
    await uploadOssForm({
      fetchImpl: input.fetchImpl,
      upload: created.upload,
      packageBytes,
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof EsaProviderFailure) throw error;
    return null;
  }
  await persistBoundary(input.db, input.operation, {
    ...uploadState,
    stage: "version_processing",
  });
  return null;
}

async function verifyLiveSite(input: {
  publicHttpsFetch: typeof fetchPinnedPublicHttps;
  deploymentId: string;
  expectedDistHash: string;
  expectedHostname: string;
  signal: AbortSignal;
}) {
  const origin = `https://${input.expectedHostname}`;
  let markerResponse: Response;
  let response: Response;
  try {
    ({ response: markerResponse } = await input.publicHttpsFetch({
      url: `${origin}/${FRONTMIND_MARKER_PATH}`,
      signal: input.signal,
      headers: { accept: "application/json" },
      maxRedirects: 2,
      allowedOrigin: origin,
    }));
  } catch {
    throw new EsaProviderFailure(
      "ESA_PUBLIC_HTTPS_UNSAFE",
      "ESA 线上标记未通过逐跳 DNS 固定与实际 socket peer 公网校验。",
      "failed",
    );
  }
  const markerText = await readResponseTextBounded(markerResponse, 4_096);
  let marker: unknown;
  try {
    marker = JSON.parse(markerText);
  } catch {
    marker = null;
  }
  if (
    !markerResponse.ok ||
    !marker ||
    typeof marker !== "object" ||
    (marker as any).deploymentId !== input.deploymentId ||
    (marker as any).distSha256 !== input.expectedDistHash
  ) {
    throw new EsaProviderFailure(
      "ESA_PUBLIC_FINGERPRINT_INVALID",
      "线上静态标记与冻结 dist 摘要不一致，当前 live head 保持不变。",
      "failed",
    );
  }
  try {
    ({ response } = await input.publicHttpsFetch({
      url: `${origin}/`,
      signal: input.signal,
      headers: { accept: "text/html" },
      maxRedirects: 2,
      allowedOrigin: origin,
    }));
  } catch {
    throw new EsaProviderFailure(
      "ESA_PUBLIC_HTTPS_UNSAFE",
      "ESA 线上首页未通过逐跳 DNS 固定与实际 socket peer 公网校验。",
      "failed",
    );
  }
  const html = await readResponseTextBounded(response, 5 * 1024 * 1024);
  if (
    !response.ok ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/html") ||
    html.length < 100
  ) {
    throw new EsaProviderFailure(
      "ESA_PUBLIC_HTML_INVALID",
      "ESA 线上首页未通过 HTTPS/HTML 验证。",
      "failed",
    );
  }
  const escaped = input.expectedHostname.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const canonicalPatterns = [
    new RegExp(
      `<link[^>]+rel=["']canonical["'][^>]+href=["']https://${escaped}/?["']`,
      "iu",
    ),
    new RegExp(
      `<link[^>]+href=["']https://${escaped}/?["'][^>]+rel=["']canonical["']`,
      "iu",
    ),
  ];
  if (!canonicalPatterns.some((pattern) => pattern.test(html))) {
    throw new EsaProviderFailure(
      "ESA_CANONICAL_INVALID",
      "线上首页 canonical 与当前 hostname 不一致。",
      "failed",
    );
  }
  return {
    https: true,
    distHash: input.expectedDistHash,
    canonicalHostname: input.expectedHostname,
    verifiedAt: new Date().toISOString(),
  };
}

async function upsertDnsExpectation(input: {
  db: DbExecutor;
  operation: SiteOperation;
  domain: string;
  revision: number;
  rr: string;
  type: "TXT" | "CNAME";
  value: string;
}) {
  const marker = `frontmind:${input.operation.projectId}:${input.revision}`;
  const rows = await input.db
    .select()
    .from(siteDnsRecords)
    .where(
      and(
        eq(siteDnsRecords.projectId, input.operation.projectId),
        eq(siteDnsRecords.userId, input.operation.userId),
        eq(siteDnsRecords.domainRevision, input.revision),
        eq(siteDnsRecords.rr, input.rr),
        eq(siteDnsRecords.recordType, input.type),
      ),
    )
    .limit(1);
  const current = rows[0];
  if (!current) {
    await input.db.insert(siteDnsRecords).values({
      id: randomUUID(),
      projectId: input.operation.projectId,
      userId: input.operation.userId,
      domainAscii: input.domain,
      domainRevision: input.revision,
      rr: input.rr,
      recordType: input.type,
      expectedValue: input.value,
      expectedTtl: DNS_TTL,
      remarkMarker: marker,
      status: "planned",
    });
    return;
  }
  if (current.domainAscii !== input.domain || current.remarkMarker !== marker) {
    throw new EsaProviderFailure(
      "ESA_DNS_EXPECTATION_CONFLICT",
      "当前域名版本已有不同所有权的 DNS 期望记录。",
    );
  }
  if (
    current.expectedValue !== input.value ||
    current.expectedTtl !== DNS_TTL
  ) {
    await input.db
      .update(siteDnsRecords)
      .set({
        expectedValue: input.value,
        expectedTtl: DNS_TTL,
        status: "planned",
        verifiedAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, current.id));
  }
}

async function handlePrepareDomainBinding(input: {
  db: DbExecutor;
  api: EsaDirectApi;
  operation: SiteOperation;
  parsed: z.infer<typeof prepareInputSchema>;
}): Promise<SiteOpsProviderResult> {
  const [profileRows, projectRows] = await Promise.all([
    input.db
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.operation.userId))
      .limit(1),
    input.db
      .select()
      .from(siteProjects)
      .where(
        and(
          eq(siteProjects.id, input.operation.projectId),
          eq(siteProjects.userId, input.operation.userId),
        ),
      )
      .limit(1),
  ]);
  const profile = profileRows[0];
  const project = projectRows[0];
  const domain = normalizeHostname(input.parsed.domain);
  if (
    !profile ||
    !project ||
    profile.domainRevision !== input.parsed.domainRevision ||
    profile.normalizedAsciiDomain !== domain ||
    profile.domainOwnershipStatus !== "verified" ||
    profile.domainStatus !== "completed"
  ) {
    throw new EsaProviderFailure(
      "ESA_DOMAIN_REVISION_INVALID",
      "ESA DNS 计划不属于当前已验证域名版本。",
    );
  }
  const hostname = normalizeHostname(project.canonicalHostname ?? domain);
  const rr = dnsRr(hostname, domain);
  const state = (input.operation.result ?? {}) as Record<string, unknown>;
  let sites = await input.api.listSites(domain);
  if (sites.length > 1) {
    throw new EsaProviderFailure(
      "ESA_SITE_AMBIGUOUS",
      "FrontMind ESA 账号中存在多个同名站点，拒绝猜测。",
    );
  }
  if (sites.length === 0) {
    if (state.stage === "site_create_unknown") {
      if ((input.operation.attempt ?? 0) < 5) {
        return {
          status: "pending",
          nextPollMs: 15_000,
          result: state,
        };
      }
      throw new EsaProviderFailure(
        "ESA_SITE_CREATE_OUTCOME_UNKNOWN",
        "ESA 站点创建响应丢失且只读查询未找到结果；系统没有重复创建。",
      );
    }
    const instanceId = process.env.FRONTMIND_ESA_INSTANCE_ID?.trim();
    if (!instanceId) {
      throw new EsaProviderFailure(
        "ESA_INSTANCE_NOT_CONFIGURED",
        "FrontMind 托管 ESA 套餐实例尚未配置。",
      );
    }
    const pending = {
      stage: "site_create_unknown",
      domain,
      domainRevision: input.parsed.domainRevision,
    };
    await persistBoundary(input.db, input.operation, pending);
    try {
      const created = await input.api.createSite({
        siteName: domain,
        instanceId,
        // A new unfiled domain must never start with Chinese-mainland
        // acceleration. Publication can switch to domestic only after the
        // exact mainland target passes the service's ICP gate.
        coverage: "overseas",
      });
      sites = [
        {
          siteId: created.siteId,
          siteName: domain,
          status: "pending",
          accessType: "CNAME",
          coverage: "overseas",
          verifyCode: created.verifyCode,
          cnameZone: null,
        },
      ];
    } catch {
      return { status: "pending", nextPollMs: 15_000, result: pending };
    }
  }
  let site = sites[0];
  if (site.accessType.toUpperCase() !== "CNAME") {
    throw new EsaProviderFailure(
      "ESA_SITE_ACCESS_TYPE_MISMATCH",
      "当前 ESA 站点不是 CNAME 接入，FrontMind 不会修改 NS。",
    );
  }
  if (!site.verifyCode && site.status.toLowerCase() !== "active") {
    site = (await input.api.listSites(domain))[0] ?? site;
  }
  if (site.status.toLowerCase() !== "active") {
    if (!site.verifyCode) {
      throw new EsaProviderFailure(
        "ESA_SITE_VERIFY_CODE_MISSING",
        "ESA 未返回站点所有权 TXT 验证值。",
      );
    }
    await upsertDnsExpectation({
      db: input.db,
      operation: input.operation,
      domain,
      revision: input.parsed.domainRevision,
      rr: "_esaauth",
      type: "TXT",
      value: site.verifyCode,
    });
    const txtRows = await input.db
      .select()
      .from(siteDnsRecords)
      .where(
        and(
          eq(siteDnsRecords.projectId, input.operation.projectId),
          eq(siteDnsRecords.domainRevision, input.parsed.domainRevision),
          eq(siteDnsRecords.rr, "_esaauth"),
          eq(siteDnsRecords.recordType, "TXT"),
        ),
      )
      .limit(1);
    if (txtRows[0]?.status !== "active") {
      await input.db
        .update(workspaceSiteProfiles)
        .set({ dnsStatus: "pending_esa_verification", updatedAt: new Date() })
        .where(eq(workspaceSiteProfiles.userId, input.operation.userId));
      return {
        status: "succeeded",
        result: {
          phase: "esa_site_verification_dns_ready",
          domain,
          domainRevision: input.parsed.domainRevision,
          siteId: site.siteId,
        },
        message: "ESA 域名所有权 TXT 已生成；请先应用并验证该条 AliDNS 记录。",
      };
    }
    if (state.stage === "site_activation_propagating") {
      if ((input.operation.attempt ?? 0) < 10) {
        return { status: "pending", nextPollMs: 15_000, result: state };
      }
      throw new EsaProviderFailure(
        "ESA_SITE_ACTIVATION_TIMEOUT",
        "ESA 已接受所有权验证，但站点仍未激活。",
      );
    }
    if (state.stage === "site_verify_unknown") {
      site = (await input.api.listSites(domain))[0] ?? site;
      if (site.status.toLowerCase() !== "active") {
        if ((input.operation.attempt ?? 0) < 5) {
          return { status: "pending", nextPollMs: 15_000, result: state };
        }
        throw new EsaProviderFailure(
          "ESA_SITE_VERIFY_OUTCOME_UNKNOWN",
          "ESA 站点验证响应丢失且只读状态仍未激活；系统没有重复提交验证。",
        );
      }
    } else {
      const pending = {
        stage: "site_verify_unknown",
        domain,
        domainRevision: input.parsed.domainRevision,
        siteId: site.siteId,
      };
      await persistBoundary(input.db, input.operation, pending);
      let passed = false;
      try {
        passed = await input.api.verifySite(site.siteId);
      } catch {
        return { status: "pending", nextPollMs: 15_000, result: pending };
      }
      if (!passed) {
        throw new EsaProviderFailure(
          "ESA_SITE_VERIFICATION_PENDING",
          "ESA 尚未确认 TXT 解析；请等待公共解析生效后重新生成 DNS 计划。",
        );
      }
      site = (await input.api.listSites(domain))[0] ?? site;
      if (site.status.toLowerCase() !== "active") {
        return {
          status: "pending",
          nextPollMs: 15_000,
          result: {
            stage: "site_activation_propagating",
            domain,
            domainRevision: input.parsed.domainRevision,
            siteId: site.siteId,
          },
        };
      }
    }
  }
  const name = routineName(project.id);
  const ensured = await ensureRoutine({
    db: input.db,
    api: input.api,
    operation: input.operation,
    name,
    state,
  });
  if (!ensured) {
    return {
      status: "pending",
      nextPollMs: 15_000,
      result: { stage: "routine_create_unknown", routineName: name },
    };
  }
  let related = await input.api.listRelatedRecords({
    name,
    recordName: hostname,
  });
  if (related.length === 0) {
    if (state.stage === "related_record_propagating") {
      if ((input.operation.attempt ?? 0) < 10) {
        return { status: "pending", nextPollMs: 15_000, result: state };
      }
      throw new EsaProviderFailure(
        "ESA_RELATED_RECORD_PROPAGATION_TIMEOUT",
        "ESA custom domain 绑定长时间未出现在只读结果中。",
      );
    }
    if (state.stage === "related_record_create_unknown") {
      if ((input.operation.attempt ?? 0) < 5) {
        return { status: "pending", nextPollMs: 15_000, result: state };
      }
      throw new EsaProviderFailure(
        "ESA_RELATED_RECORD_OUTCOME_UNKNOWN",
        "ESA custom domain 绑定响应丢失且只读查询未找到结果；系统没有重复绑定。",
      );
    }
    const pending = {
      stage: "related_record_create_unknown",
      routineName: name,
      siteId: site.siteId,
      recordName: hostname,
    };
    await persistBoundary(input.db, input.operation, pending);
    try {
      await input.api.createRelatedRecord({
        name,
        recordName: hostname,
        siteId: site.siteId,
      });
    } catch {
      return { status: "pending", nextPollMs: 15_000, result: pending };
    }
    related = await input.api.listRelatedRecords({
      name,
      recordName: hostname,
    });
    if (related.length === 0) {
      return {
        status: "pending",
        nextPollMs: 15_000,
        result: { ...pending, stage: "related_record_propagating" },
      };
    }
  }
  if (related.length !== 1 || related[0].siteId !== site.siteId) {
    throw new EsaProviderFailure(
      "ESA_RELATED_RECORD_AMBIGUOUS",
      "ESA custom domain 绑定未形成唯一精确结果。",
    );
  }
  const records = await input.api.listEdgeRoutineRecords({
    siteId: site.siteId,
    recordName: hostname,
  });
  if (records.length !== 1) {
    return {
      status: "pending",
      nextPollMs: 15_000,
      result: {
        stage: "related_record_propagating",
        routineName: name,
        siteId: site.siteId,
        recordName: hostname,
      },
    };
  }
  const cname = normalizeHostname(records[0].recordCname);
  await upsertDnsExpectation({
    db: input.db,
    operation: input.operation,
    domain,
    revision: input.parsed.domainRevision,
    rr,
    type: "CNAME",
    value: cname,
  });
  await input.db
    .update(workspaceSiteProfiles)
    .set({ dnsStatus: "pending_cname", updatedAt: new Date() })
    .where(eq(workspaceSiteProfiles.userId, input.operation.userId));
  return {
    status: "succeeded",
    result: {
      phase: "esa_cname_ready",
      domain,
      hostname,
      domainRevision: input.parsed.domainRevision,
      siteId: site.siteId,
      routineName: name,
      cname,
    },
    message:
      "ESA custom domain 已绑定，并生成精确 CNAME；请查看差异后应用 AliDNS。",
  };
}

function pendingState(
  state: Record<string, unknown>,
  providerOperationId?: string,
): SiteOpsProviderResult {
  return {
    status: "pending",
    result: state,
    ...(providerOperationId ? { providerOperationId } : {}),
    nextPollMs: 10_000,
  };
}

function failure(error: unknown): SiteOpsProviderResult {
  if (error instanceof EsaProviderFailure) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      result: error.result,
    };
  }
  return {
    status: "attention_required",
    code: "ESA_PROVIDER_FAILED",
    message: "ESA 发布暂时无法安全推进，请稍后重试或由运营人员处理。",
  };
}

export function createEsaSiteOpsProviderHandler(
  dependencies: EsaProviderDependencies = {},
): SiteOpsProviderHandler {
  const dbGetter = dependencies.getDb ?? getDb;
  const persistArtifact =
    dependencies.persistArtifact ?? persistSiteOpsArtifact;
  const readArtifact = dependencies.readArtifact ?? readSiteOpsArtifact;
  const materializeProduction =
    dependencies.materializeProduction ?? materializeProductionSiteFromSource;
  const materializeNativeProduction =
    dependencies.materializeNativeProduction ??
    rebuildNativeReactProductionFromSource;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const publicHttpsFetch =
    dependencies.publicHttpsFetch ?? fetchPinnedPublicHttps;
  let api = dependencies.api;
  return async ({ operation, signal }) => {
    try {
      const approvedReset = parseApprovedResetUnpublishInput(operation.input);
      if (approvedReset && operation.kind !== "rollback") {
        throw new EsaProviderFailure(
          "SITEOPS_RESET_OPERATION_KIND_INVALID",
          "官网重置下线只能由专用 rollback 操作执行。",
          "failed",
        );
      }
      const runtimeConfiguration = inspectEsaRuntimeConfiguration({
        providerRegistered: true,
      });
      let db: Awaited<ReturnType<typeof dbGetter>> | null | undefined;
      if (approvedReset) {
        db = await dbGetter();
        if (!db) {
          throw new EsaProviderFailure(
            "DATABASE_UNAVAILABLE",
            "ESA 发布数据库暂时不可用。",
          );
        }
        if (!runtimeConfiguration.configured) {
          const startedAt = Date.now();
          logApprovedResetStage({ operation, status: "started" });
          const safeNoop = await approvedResetHasNoUnresolvedExternalExposure({
            db,
            operation,
            reset: approvedReset,
            allowCanonicalHostname: true,
            allowMigration0065RevisionDrift: true,
          });
          if (!safeNoop) {
            throw new EsaProviderFailure(
              runtimeConfiguration.code,
              `${runtimeConfiguration.reason}；存在尚未解除的 ESA 暴露证据，未执行未经核验的重置。`,
            );
          }
          const resetResult = approvedReset.expectedCanonicalHostname
            ? await approvedResetExposureRemoved({
                publicHttpsFetch,
                operation,
                reset: approvedReset,
                signal,
                state:
                  operation.result && typeof operation.result === "object"
                    ? operation.result
                    : {},
                safeNoExposureProof: safeNoop,
              })
            : ({
                status: "succeeded",
                result: {
                  schemaVersion: 1,
                  intent: APPROVED_RESET_UNPUBLISH,
                  stage: "exposure_removed",
                  safeNoExposureProof: safeNoop,
                },
                message: "未发现尚未解除的 ESA 暴露，已安全确认无需下线。",
              } satisfies SiteOpsProviderResult);
          logApprovedResetStage({
            operation,
            status: resetResult.status,
            stage: "exposure_removed",
            latencyMs: Date.now() - startedAt,
          });
          return resetResult;
        }
      }
      if (!runtimeConfiguration.configured) {
        throw new EsaProviderFailure(
          runtimeConfiguration.code,
          `${runtimeConfiguration.reason}；没有创建虚假发布。`,
        );
      }
      db ??= await dbGetter();
      if (!db)
        throw new EsaProviderFailure(
          "DATABASE_UNAVAILABLE",
          "ESA 发布数据库暂时不可用。",
        );
      api ??= new OfficialEsaDirectApi();
      const prepare = prepareInputSchema.safeParse(operation.input);
      if (prepare.success) {
        return await handlePrepareDomainBinding({
          db,
          api,
          operation,
          parsed: prepare.data,
        });
      }
      if (approvedReset) {
        const startedAt = Date.now();
        logApprovedResetStage({ operation, status: "started" });
        const resetResult = await handleApprovedResetUnpublish({
          db,
          api,
          publicHttpsFetch,
          operation,
          reset: approvedReset,
          signal,
        });
        logApprovedResetStage({
          operation,
          status: resetResult.status,
          stage:
            resetResult.result && typeof resetResult.result.stage === "string"
              ? resetResult.result.stage
              : undefined,
          latencyMs: Date.now() - startedAt,
        });
        return resetResult;
      }

      let context = await loadDeploymentContext(db, operation);
      const state = (operation.result ?? {}) as Record<string, unknown>;
      const name = routineName(context.project.id);
      const hostname = normalizeHostname(
        context.project.canonicalHostname ?? "",
      );
      const production = await ensureProductionMaterialization({
        db,
        operation,
        context,
        canonicalOrigin: `https://${hostname}`,
        readArtifact,
        persistArtifact,
        materializeProduction,
        materializeNativeProduction,
        signal,
      });
      context = production.context;
      if (production.created) {
        return {
          status: "pending",
          nextPollMs: 2_000,
          result: {
            ...state,
            stage: "production_materialized",
            productionDistHash: production.materialization.distSha256,
          },
        };
      }
      const ensured = await ensureRoutine({ db, api, operation, name, state });
      if (!ensured) {
        return pendingState({
          ...state,
          stage: "routine_create_unknown",
          routineName: name,
        });
      }
      let matchedSite = await api.getMatchSite(hostname);
      if (!matchedSite || matchedSite.status.toLowerCase() !== "active") {
        throw new EsaProviderFailure(
          "ESA_DOMAIN_BINDING_NOT_READY",
          "canonical hostname 尚未在 FrontMind ESA 账号完成验证和绑定。",
        );
      }
      const coveredSite = await ensureSiteCoverage({
        db,
        api,
        operation,
        site: matchedSite,
        recordName: hostname,
        target: context.deployment.target,
        state,
      });
      if (!coveredSite) {
        const rows = await db
          .select({ result: siteOperations.result })
          .from(siteOperations)
          .where(eq(siteOperations.id, operation.id))
          .limit(1);
        return pendingState(
          (rows[0]?.result as Record<string, unknown> | null) ?? state,
        );
      }
      matchedSite = coveredSite;
      const codeVersion = await resolveCodeVersion({
        db,
        api,
        operation,
        context,
        name,
        state,
        fetchImpl,
        readArtifact,
        signal,
      });
      if (!codeVersion) {
        const rows = await db
          .select({ result: siteOperations.result })
          .from(siteOperations)
          .where(eq(siteOperations.id, operation.id))
          .limit(1);
        return pendingState(
          (rows[0]?.result as Record<string, unknown> | null) ?? state,
        );
      }
      let routine = await api.getRoutine(name);
      const exactProduction =
        routine?.production?.codeVersions.length === 1 &&
        routine.production.codeVersions[0].codeVersion === codeVersion &&
        routine.production.codeVersions[0].percentage === 100;
      let providerDeploymentId = exactProduction
        ? routine!.production!.deploymentId
        : operation.providerOperationId;
      if (!exactProduction) {
        if (
          state.stage === "deployment_submit_unknown" ||
          state.stage === "deployment_verifying"
        ) {
          if ((operation.attempt ?? 0) < 15) {
            return pendingState(state, providerDeploymentId ?? undefined);
          }
          throw new EsaProviderFailure(
            "ESA_DEPLOYMENT_OUTCOME_UNKNOWN",
            "ESA 部署响应丢失且只读查询未发现精确 codeVersion；系统没有重复部署。",
          );
        }
        const deployState = {
          ...state,
          stage: "deployment_submit_unknown",
          routineName: name,
          codeVersion,
        };
        await persistBoundary(db, operation, deployState);
        try {
          const deployment = await api.createProductionDeployment({
            name,
            codeVersion,
          });
          providerDeploymentId = deployment.deploymentId;
          await persistBoundary(
            db,
            operation,
            { ...deployState, stage: "deployment_verifying" },
            providerDeploymentId,
          );
        } catch {
          return pendingState(deployState);
        }
        routine = await api.getRoutine(name);
        const observed =
          routine?.production?.codeVersions.length === 1 &&
          routine.production.codeVersions[0].codeVersion === codeVersion &&
          routine.production.codeVersions[0].percentage === 100;
        if (!observed) {
          return pendingState(
            { ...deployState, stage: "deployment_verifying" },
            providerDeploymentId ?? undefined,
          );
        }
        providerDeploymentId = routine!.production!.deploymentId;
      }
      let related = await api.listRelatedRecords({
        name,
        recordName: hostname,
      });
      if (related.length === 0) {
        const stageStartedAttempt = Number(state.stageStartedAttempt ?? 0);
        if (state.stage === "related_record_create_unknown") {
          if ((operation.attempt ?? 0) - stageStartedAttempt < 5) {
            return pendingState(state, providerDeploymentId ?? undefined);
          }
          throw new EsaProviderFailure(
            "ESA_RELATED_RECORD_OUTCOME_UNKNOWN",
            "ESA custom domain 绑定响应丢失且只读查询未找到结果；系统没有重复绑定。",
          );
        }
        if (state.stage === "related_record_propagating") {
          if ((operation.attempt ?? 0) - stageStartedAttempt < 10) {
            return pendingState(state, providerDeploymentId ?? undefined);
          }
          throw new EsaProviderFailure(
            "ESA_RELATED_RECORD_PROPAGATION_TIMEOUT",
            "ESA custom domain 绑定长时间未出现在只读结果中。",
          );
        }
        const relationState = {
          ...state,
          stage: "related_record_create_unknown",
          stageStartedAttempt: operation.attempt ?? 0,
          siteId: matchedSite.siteId,
        };
        await persistBoundary(
          db,
          operation,
          relationState,
          providerDeploymentId ?? undefined,
        );
        try {
          await api.createRelatedRecord({
            name,
            recordName: hostname,
            siteId: matchedSite.siteId,
          });
        } catch {
          return pendingState(relationState, providerDeploymentId ?? undefined);
        }
        related = await api.listRelatedRecords({
          name,
          recordName: hostname,
        });
        if (related.length === 0) {
          return pendingState(
            {
              ...relationState,
              stage: "related_record_propagating",
              stageStartedAttempt: operation.attempt ?? 0,
            },
            providerDeploymentId ?? undefined,
          );
        }
      }
      if (related.length !== 1 || related[0].siteId !== matchedSite.siteId) {
        throw new EsaProviderFailure(
          "ESA_DOMAIN_BINDING_NOT_READY",
          "canonical hostname 未形成唯一精确的 SiteOps Routine 绑定。",
        );
      }
      const publicVerification = await verifyLiveSite({
        publicHttpsFetch,
        deploymentId: context.deployment.id,
        expectedDistHash: context.deployment.distHash,
        expectedHostname: hostname,
        signal,
      });
      const verification = {
        productionMaterialization: production.materialization,
        public: publicVerification,
      };
      const publicUrl = `https://${hostname}/`;
      await db
        .update(siteDeployments)
        .set({
          providerDeploymentId,
          publicUrl,
          status: "verifying",
          verification,
          updatedAt: new Date(),
        })
        .where(eq(siteDeployments.id, context.deployment.id));
      return {
        status: "succeeded",
        providerOperationId: providerDeploymentId ?? undefined,
        projectStatus: "live",
        result: {
          deploymentId: context.deployment.id,
          providerDeploymentId,
          publicUrl,
          distHash: context.deployment.distHash,
          target: context.deployment.target,
          coverage: coverageForTarget(context.deployment.target),
          codeVersion,
          routineName: name,
          verification,
        },
        message:
          context.deployment.intent === "rollback"
            ? "历史官网版本已在 ESA 重新部署并完成精确版本验证。"
            : "官网已直接发布到 ESA，并通过 HTTPS、冻结摘要与 canonical 验证。",
      };
    } catch (error) {
      console.error("[SiteOpsESA] provider_failed", {
        event: "siteops_esa_provider_failed",
        operationId: operation.id,
        projectId: operation.projectId,
        kind: operation.kind,
        error: runtimeErrorForLog(error),
      });
      return failure(error);
    }
  };
}

let registered = false;

export function registerEsaSiteOpsProvider(
  dependencies: EsaProviderDependencies = {},
) {
  if (registered) return () => undefined;
  const unregister = registerSiteOpsProviderHandler(
    "aliyun_esa",
    createEsaSiteOpsProviderHandler(dependencies),
  );
  registered = true;
  return () => {
    unregister();
    registered = false;
  };
}
