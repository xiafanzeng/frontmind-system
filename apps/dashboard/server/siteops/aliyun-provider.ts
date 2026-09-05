import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  resolve4,
  resolve6,
  resolveCname,
  resolveTxt,
} from "node:dns/promises";
import { domainToASCII, domainToUnicode } from "node:url";

import * as AliDnsModels from "@alicloud/alidns20150109";
import * as OpenApi from "@alicloud/openapi-client";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  siteDnsRecords,
  siteOperations,
  siteProjects,
  siteProviderConnections,
  presalesApiCredentials,
  workspaceSiteProfiles,
  type SiteDnsRecord,
  type SiteOperation,
  type SiteProviderConnection,
} from "../../drizzle/schema";
import { approvedResetUnpublishInputSchema } from "./rebuild-ticket";
import {
  AuthServiceError,
  decryptCredentialSecret,
  encryptCredentialSecret,
} from "../auth-service";
import { getDb } from "../db";
import {
  ALIYUN_OAUTH_CREDENTIAL_SLOT,
  aliyunSdkErrorDetails,
  refreshAliyunOAuthAccessToken,
  revokeAliyunOAuthToken,
} from "./aliyun-platform-service";
import { AliyunDnsClient } from "./aliyun-sdk-constructors";
import {
  registerSiteOpsProviderHandler,
  type SiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";

const ALIDNS_ENDPOINT = "alidns.cn-hangzhou.aliyuncs.com";
const ALIYUN_REQUEST_TIMEOUT_MS = 12_000;
const DNS_PROPAGATION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DNS_TTL = 600;

const ownedConnectionInputSchema = z
  .object({
    projectId: z.string().uuid(),
    userId: z.number().int().positive(),
  })
  .strict();

const dnsOperationInputSchema = z
  .object({
    domainRevision: z.number().int().positive().optional(),
    connectionId: z.string().uuid(),
    dnsIntent: z.enum(["plan", "apply", "rollback"]),
    planOperationId: z.string().uuid().optional(),
    planHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    providerSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    approvedReset: approvedResetUnpublishInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.approvedReset && value.dnsIntent !== "rollback") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedReset"],
        message: "Approved reset coordinates are valid only for DNS rollback.",
      });
    }
    if (value.dnsIntent !== "plan" && value.domainRevision == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domainRevision"],
        message: "DNS 写入或回滚必须绑定域名版本。",
      });
    }
    if (value.dnsIntent === "apply") {
      for (const field of [
        "domainRevision",
        "planOperationId",
        "planHash",
        "providerSnapshotHash",
      ] as const) {
        if (value[field] == null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "DNS apply 必须绑定已生成的精确计划。",
          });
        }
      }
    }
  });

const domainSyncInputSchema = z
  .object({
    domainIntent: z.literal("sync"),
    connectionId: z.string().uuid(),
    domain: z.string().trim().min(1).max(255),
  })
  .strict();

const aliyunOperationInputSchema = z.union([
  domainSyncInputSchema,
  dnsOperationInputSchema,
]);

type DbExecutor = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type AliyunDnsRecordView = {
  recordId: string;
  rr: string;
  type: string;
  value: string;
  ttl: number;
  remark: string | null;
};

export interface AliyunDnsApi {
  listDomains(): Promise<AliyunDomainView[]>;
  getDomain(domain: string): Promise<AliyunDomainView | null>;
  listRecords(domain: string): Promise<AliyunDnsRecordView[]>;
  addRecord(input: {
    domain: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }): Promise<{ recordId: string; requestId: string | null }>;
  updateRecord(input: {
    recordId: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }): Promise<{ requestId: string | null }>;
  updateRemark(input: {
    recordId: string;
    remark: string;
  }): Promise<{ requestId: string | null }>;
  deleteRecord(recordId: string): Promise<{ requestId: string | null }>;
}

export type AliyunDomainView = {
  domain: string;
  displayDomain: string;
};

export interface AliyunProviderSdkFactory {
  dns(accessToken: string): AliyunDnsApi;
}

export type PublicDnsResolver = (input: {
  hostname: string;
  type: string;
}) => Promise<string[]>;

export class AliyunProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AliyunProviderError";
  }
}

export function assertAliyunDomainSelectionSafe(input: {
  sameDomain: boolean;
  hasExistingDomainState: boolean;
}) {
  if (!input.sameDomain && input.hasExistingDomainState) {
    throw new AliyunProviderError(
      "DOMAIN_SWITCH_REQUIRES_RESET",
      "当前项目已接入其他域名，请先申请重置并完成安全下线。",
    );
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeAliyunDomain(value: string) {
  const trimmed = value.trim().replace(/\.$/, "");
  const ascii = domainToASCII(trimmed).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.includes("..") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      ascii,
    )
  ) {
    throw new AliyunProviderError("INVALID_DOMAIN", "域名格式无效。");
  }
  return { ascii, unicode: domainToUnicode(ascii) || trimmed };
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new AliyunProviderError(
      "PROVIDER_TIMEOUT",
      "阿里云请求超时；系统不会盲目重发外部写操作。",
      true,
    );
  }
}

async function requireDb(): Promise<DbExecutor> {
  const db = await getDb();
  if (!db) {
    throw new AliyunProviderError(
      "DATABASE_UNAVAILABLE",
      "数据库未配置，无法执行阿里云操作。",
    );
  }
  return db;
}

function asDate(value: Date | string | number | null | undefined) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function affectedRows(value: unknown) {
  const header = Array.isArray(value)
    ? (value[0] as { affectedRows?: unknown } | undefined)
    : (value as { affectedRows?: unknown } | undefined);
  return Number(header?.affectedRows ?? 0);
}

function resultError(error: unknown): SiteOpsProviderResult {
  if (error instanceof AliyunProviderError) {
    return {
      status: error.outcomeUnknown ? "outcome_unknown" : "attention_required",
      code: error.code,
      message: error.message,
      result: error.details,
    };
  }
  return {
    status: "attention_required",
    code: "ALIYUN_PROVIDER_ERROR",
    message:
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "阿里云操作失败。",
  };
}

function bearerConfig(accessToken: string, endpoint: string) {
  return new OpenApi.Config({
    bearerToken: accessToken,
    endpoint,
    protocol: "HTTPS",
    regionId: "cn-hangzhou",
    connectTimeout: ALIYUN_REQUEST_TIMEOUT_MS,
    readTimeout: ALIYUN_REQUEST_TIMEOUT_MS,
    userAgent: "frontmind-siteops/3.0",
  });
}

class OfficialAliyunDnsApi implements AliyunDnsApi {
  private readonly client: InstanceType<typeof AliyunDnsClient>;

  constructor(accessToken: string) {
    this.client = new AliyunDnsClient(
      bearerConfig(accessToken, ALIDNS_ENDPOINT),
    );
  }

  async listDomains() {
    const domains = new Map<string, AliyunDomainView>();
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.client.describeDomains(
        new AliDnsModels.DescribeDomainsRequest({
          pageNumber: page,
          pageSize: 100,
          lang: "en",
        }),
      );
      const entries = response.body?.domains?.domain ?? [];
      for (const rawEntry of entries) {
        const entry = rawEntry as typeof rawEntry & { aliDomain?: boolean };
        if (entry.aliDomain !== true || !entry.domainName) continue;
        const normalized = normalizeAliyunDomain(entry.domainName);
        domains.set(normalized.ascii, {
          domain: normalized.ascii,
          displayDomain: normalized.unicode,
        });
      }
      if (entries.length < 100) break;
    }
    return [...domains.values()].sort((left, right) =>
      left.domain.localeCompare(right.domain),
    );
  }

  async getDomain(domain: string) {
    const requested = normalizeAliyunDomain(domain);
    try {
      const response = await this.client.describeDomainInfo(
        new AliDnsModels.DescribeDomainInfoRequest({
          domainName: requested.ascii,
          lang: "en",
          needDetailAttributes: false,
        }),
      );
      const body = response.body;
      if (body?.aliDomain !== true || !body.domainName) return null;
      const observed = normalizeAliyunDomain(body.domainName);
      if (observed.ascii !== requested.ascii) return null;
      return { domain: observed.ascii, displayDomain: observed.unicode };
    } catch (error) {
      const details = aliyunSdkErrorDetails(error);
      if (
        details.statusCode === 404 ||
        /(?:DomainNotExist|InvalidDomainName\.NoExist)/iu.test(
          details.providerCode ?? "",
        )
      ) {
        return null;
      }
      throw error;
    }
  }

  async listRecords(domain: string) {
    const records: AliyunDnsRecordView[] = [];
    let page = 1;
    while (page <= 20) {
      const response = await this.client.describeDomainRecords(
        new AliDnsModels.DescribeDomainRecordsRequest({
          domainName: domain,
          pageNumber: page,
          pageSize: 500,
          searchMode: "COMBINATION",
          lang: "en",
        }),
      );
      const entries = response.body?.domainRecords?.record ?? [];
      records.push(
        ...entries.flatMap((record) =>
          record.recordId && record.RR && record.type && record.value
            ? [
                {
                  recordId: record.recordId,
                  rr: record.RR,
                  type: record.type.toUpperCase(),
                  value: record.value,
                  ttl: record.TTL ?? DEFAULT_DNS_TTL,
                  remark: record.remark ?? null,
                },
              ]
            : [],
        ),
      );
      if (entries.length < 500) break;
      page += 1;
    }
    return records;
  }

  async addRecord(input: {
    domain: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }) {
    const response = await this.client.addDomainRecord(
      new AliDnsModels.AddDomainRecordRequest({
        domainName: input.domain,
        RR: input.rr,
        type: input.type,
        value: input.value,
        TTL: input.ttl,
        lang: "en",
      }),
    );
    const recordId = response.body?.recordId;
    if (!recordId) {
      throw new AliyunProviderError(
        "ALIDNS_RECORD_ID_MISSING",
        "AliDNS 未返回 RecordId；不会自动重复新增记录。",
        true,
      );
    }
    return { recordId, requestId: response.body?.requestId ?? null };
  }

  async updateRecord(input: {
    recordId: string;
    rr: string;
    type: string;
    value: string;
    ttl: number;
  }) {
    const response = await this.client.updateDomainRecord(
      new AliDnsModels.UpdateDomainRecordRequest({
        recordId: input.recordId,
        RR: input.rr,
        type: input.type,
        value: input.value,
        TTL: input.ttl,
        lang: "en",
      }),
    );
    return { requestId: response.body?.requestId ?? null };
  }

  async updateRemark(input: { recordId: string; remark: string }) {
    const response = await this.client.updateDomainRecordRemark(
      new AliDnsModels.UpdateDomainRecordRemarkRequest({
        recordId: input.recordId,
        remark: input.remark,
        lang: "en",
      }),
    );
    return { requestId: response.body?.requestId ?? null };
  }

  async deleteRecord(recordId: string) {
    const response = await this.client.deleteDomainRecord(
      new AliDnsModels.DeleteDomainRecordRequest({ recordId, lang: "en" }),
    );
    return { requestId: response.body?.requestId ?? null };
  }
}

export class OfficialAliyunProviderSdkFactory
  implements AliyunProviderSdkFactory
{
  dns(accessToken: string) {
    return new OfficialAliyunDnsApi(accessToken);
  }
}

function refreshTokenAad(input: {
  connectionId: string;
  accountUid: string;
  oauthCredentialId: string;
}) {
  return [
    "frontmind-aliyun-oauth-refresh:v1",
    input.connectionId,
    input.accountUid,
    input.oauthCredentialId,
  ].join(":");
}

export function sealAliyunRefreshToken(input: {
  connectionId: string;
  accountUid: string;
  oauthCredentialId: string;
  refreshToken: string;
}) {
  const encrypted = encryptCredentialSecret(
    refreshTokenAad(input),
    input.refreshToken,
  );
  return {
    encryptionVersion: encrypted.encryptionVersion,
    encryptedRefreshToken: encrypted.encryptedKey,
    encryptionIv: encrypted.encryptionIv,
    encryptionAuthTag: encrypted.encryptionAuthTag,
  };
}

export function openAliyunRefreshToken(
  connection: Pick<
    SiteProviderConnection,
    | "id"
    | "accountUid"
    | "oauthCredentialId"
    | "encryptionVersion"
    | "encryptedRefreshToken"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(
    refreshTokenAad({
      connectionId: connection.id,
      accountUid: connection.accountUid,
      oauthCredentialId: connection.oauthCredentialId,
    }),
    {
      encryptionVersion: connection.encryptionVersion,
      encryptedKey: connection.encryptedRefreshToken,
      encryptionIv: connection.encryptionIv,
      encryptionAuthTag: connection.encryptionAuthTag,
    },
  );
}

type AliyunOAuthTokenRefresher = typeof refreshAliyunOAuthAccessToken;

async function loadOwnedAliyunConnection(
  db: DbExecutor,
  rawInput: { projectId: string; userId: number },
) {
  const input = ownedConnectionInputSchema.parse(rawInput);
  const rows = await db
    .select()
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.projectId, input.projectId),
        eq(siteProviderConnections.userId, input.userId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function transitionAliyunConnectionState(input: {
  db: DbExecutor;
  connection: SiteProviderConnection;
  status: "invalid" | "revoked";
  lastErrorCode: string | null;
  overwriteRefreshToken?: boolean;
}) {
  await input.db.transaction(async (tx) => {
    const projectRows = await tx
      .select({ id: siteProjects.id, revision: siteProjects.revision })
      .from(siteProjects)
      .where(eq(siteProjects.id, input.connection.projectId))
      .limit(1)
      .for("update");
    const connectionRows = await tx
      .select({ status: siteProviderConnections.status })
      .from(siteProviderConnections)
      .where(eq(siteProviderConnections.id, input.connection.id))
      .limit(1)
      .for("update");
    const project = projectRows[0];
    const current = connectionRows[0];
    if (
      !project ||
      !current ||
      current.status === input.status ||
      (input.status === "invalid" && current.status !== "active")
    ) {
      return;
    }
    const now = new Date();
    await tx
      .update(siteProviderConnections)
      .set({
        status: input.status,
        lastErrorCode: input.lastErrorCode,
        ...(input.overwriteRefreshToken
          ? {
              encryptedRefreshToken: randomBytes(32).toString("base64"),
              encryptionIv: randomBytes(12).toString("base64"),
              encryptionAuthTag: randomBytes(16).toString("base64"),
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(siteProviderConnections.id, input.connection.id));
    await tx
      .update(siteProjects)
      .set({ revision: project.revision + 1, updatedAt: now })
      .where(eq(siteProjects.id, project.id));
  });
}

async function createAliyunDnsApiForConnection(input: {
  db: DbExecutor;
  connection: SiteProviderConnection;
  factory: AliyunProviderSdkFactory;
  refreshAccessToken?: AliyunOAuthTokenRefresher;
}) {
  if (input.connection.status !== "active") {
    throw new AliyunProviderError(
      "ALIYUN_REAUTHORIZATION_REQUIRED",
      "阿里云授权已失效，请重新连接后继续。",
    );
  }
  const sealedRefreshToken = openAliyunRefreshToken(input.connection);
  try {
    const refreshed = await (
      input.refreshAccessToken ?? refreshAliyunOAuthAccessToken
    )({
      credentialId: input.connection.oauthCredentialId,
      refreshToken: sealedRefreshToken,
    });
    if (refreshed.refreshToken !== sealedRefreshToken) {
      await input.db
        .update(siteProviderConnections)
        .set({
          ...sealAliyunRefreshToken({
            connectionId: input.connection.id,
            accountUid: input.connection.accountUid,
            oauthCredentialId: input.connection.oauthCredentialId,
            refreshToken: refreshed.refreshToken,
          }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(siteProviderConnections.id, input.connection.id),
            eq(siteProviderConnections.status, "active"),
          ),
        );
    }
    return input.factory.dns(refreshed.accessToken);
  } catch (error) {
    if (
      error instanceof AuthServiceError &&
      error.code === "INVALID_CREDENTIAL"
    ) {
      await transitionAliyunConnectionState({
        db: input.db,
        connection: input.connection,
        status: "invalid",
        lastErrorCode: "ALIYUN_OAUTH_INVALID_GRANT",
      });
      throw new AliyunProviderError(
        "ALIYUN_REAUTHORIZATION_REQUIRED",
        "阿里云授权已失效，请重新连接后继续。",
      );
    }
    throw error;
  }
}

async function invalidateAliyunConnectionOnUnauthorized(input: {
  db: DbExecutor;
  connection: SiteProviderConnection;
  error: unknown;
}) {
  if (aliyunSdkErrorDetails(input.error).statusCode !== 401) return;
  await transitionAliyunConnectionState({
    db: input.db,
    connection: input.connection,
    status: "invalid",
    lastErrorCode: "ALIYUN_OAUTH_UNAUTHORIZED",
  });
}

export async function listAliyunDomainsForConnection(
  rawInput: { projectId: string; userId: number },
  options?: {
    factory?: AliyunProviderSdkFactory;
    refreshAccessToken?: AliyunOAuthTokenRefresher;
  },
) {
  const db = await requireDb();
  const connection = await loadOwnedAliyunConnection(db, rawInput);
  if (!connection) {
    throw new AliyunProviderError(
      "ALIYUN_CONNECTION_NOT_FOUND",
      "请先连接阿里云账号。",
    );
  }
  const api = await createAliyunDnsApiForConnection({
    db,
    connection,
    factory: options?.factory ?? new OfficialAliyunProviderSdkFactory(),
    refreshAccessToken: options?.refreshAccessToken,
  });
  try {
    return { domains: await api.listDomains() };
  } catch (error) {
    await invalidateAliyunConnectionOnUnauthorized({ db, connection, error });
    throw error;
  }
}

export const listAliyunCustomerDomains = listAliyunDomainsForConnection;

export async function bindAliyunCustomerAccountFromOAuth(rawInput: {
  projectId: string;
  userId: number;
  credentialId: string;
  accountUid: string;
  refreshToken: string;
}) {
  const input = z
    .object({
      projectId: z.string().uuid(),
      userId: z.number().int().positive(),
      credentialId: z.string().uuid(),
      accountUid: z
        .string()
        .trim()
        .regex(/^\d{6,64}$/),
      refreshToken: z.string().min(8).max(16_384),
    })
    .strict()
    .parse(rawInput);
  const db = await requireDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [
      projects,
      credentials,
      connections,
      activeExternalOperations,
      profiles,
      dnsEvidence,
    ] = await Promise.all([
      tx
        .select({
          id: siteProjects.id,
          revision: siteProjects.revision,
          canonicalHostname: siteProjects.canonicalHostname,
          globalLiveDeploymentId: siteProjects.globalLiveDeploymentId,
          mainlandLiveDeploymentId: siteProjects.mainlandLiveDeploymentId,
        })
        .from(siteProjects)
        .where(
          and(
            eq(siteProjects.id, input.projectId),
            eq(siteProjects.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update"),
      tx
        .select({ id: presalesApiCredentials.id })
        .from(presalesApiCredentials)
        .where(
          and(
            eq(presalesApiCredentials.id, input.credentialId),
            eq(presalesApiCredentials.slot, ALIYUN_OAUTH_CREDENTIAL_SLOT),
            eq(presalesApiCredentials.status, "active"),
          ),
        )
        .limit(1),
      tx
        .select()
        .from(siteProviderConnections)
        .where(
          and(
            eq(siteProviderConnections.projectId, input.projectId),
            eq(siteProviderConnections.provider, "aliyun_cn"),
          ),
        )
        .limit(1)
        .for("update"),
      tx
        .select({ id: siteOperations.id })
        .from(siteOperations)
        .where(
          and(
            eq(siteOperations.projectId, input.projectId),
            eq(siteOperations.userId, input.userId),
            inArray(siteOperations.provider, ["aliyun_alidns", "aliyun_esa"]),
            inArray(siteOperations.status, [
              "queued",
              "running",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1)
        .for("update"),
      tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, input.userId))
        .limit(1)
        .for("update"),
      tx
        .select({ id: siteDnsRecords.id })
        .from(siteDnsRecords)
        .where(
          and(
            eq(siteDnsRecords.projectId, input.projectId),
            eq(siteDnsRecords.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update"),
    ]);
    if (!projects[0]) {
      throw new AliyunProviderError(
        "PROJECT_NOT_FOUND",
        "当前官网项目不存在或不属于该用户。",
      );
    }
    if (!credentials[0]) {
      throw new AliyunProviderError(
        "ALIYUN_OAUTH_CREDENTIAL_RETIRED",
        "本次授权使用的阿里云 OAuth 应用配置已失效。",
      );
    }
    const existing = connections[0];
    const changingAccount =
      existing !== undefined && existing.accountUid !== input.accountUid;
    if (changingAccount && activeExternalOperations.length > 0) {
      throw new AliyunProviderError(
        "CONNECTION_IN_USE",
        "仍有域名解析或网站下线操作正在执行，请等待完成后重试。",
      );
    }
    const profile = profiles[0];
    const hasPublishedDomainState = Boolean(
      profile?.domain ||
        profile?.normalizedAsciiDomain ||
        profile?.providerAccountUid ||
        profile?.domainOwnershipStatus ||
        profile?.dnsStatus ||
        profile?.icpDomainRevision ||
        projects[0].canonicalHostname ||
        projects[0].globalLiveDeploymentId ||
        projects[0].mainlandLiveDeploymentId ||
        dnsEvidence.length > 0,
    );
    if (changingAccount && hasPublishedDomainState) {
      throw new AliyunProviderError(
        "ALIYUN_ACCOUNT_CHANGE_REQUIRES_RESET",
        "当前项目仍绑定原阿里云账号的域名，请先申请重置并完成安全下线。",
      );
    }
    const connectionId = existing?.id ?? randomUUID();
    const sealed = sealAliyunRefreshToken({
      connectionId,
      accountUid: input.accountUid,
      oauthCredentialId: input.credentialId,
      refreshToken: input.refreshToken,
    });
    const values = {
      projectId: input.projectId,
      userId: input.userId,
      provider: "aliyun_cn" as const,
      accountUid: input.accountUid,
      oauthCredentialId: input.credentialId,
      ...sealed,
      capabilities: ["alidns_read", "alidns_write"],
      status: "active" as const,
      verifiedAt: now,
      lastErrorCode: null,
      updatedAt: now,
    };
    if (existing) {
      await tx
        .update(siteProviderConnections)
        .set(values)
        .where(eq(siteProviderConnections.id, existing.id));
    } else {
      await tx.insert(siteProviderConnections).values({
        id: connectionId,
        ...values,
        createdAt: now,
      });
    }
    await tx
      .update(presalesApiCredentials)
      .set({
        validationStatus: "verified",
        verifiedAt: now,
        updatedAt: now,
      })
      .where(eq(presalesApiCredentials.id, input.credentialId));
    if (changingAccount) {
      if (profile) {
        await tx
          .update(workspaceSiteProfiles)
          .set({
            domain: null,
            normalizedAsciiDomain: null,
            unicodeDisplayDomain: null,
            domainRevision: profile.domainRevision + 1,
            providerAccountUid: null,
            domainOwnershipStatus: null,
            dnsStatus: null,
            domainStatus: "not_started",
            domainVerifiedAt: null,
            icpDomainRevision: null,
            icpProvince: null,
            icpNumber: null,
            icpStatus: "not_submitted",
            icpVerifiedAt: null,
            revision: profile.revision + 1,
            updatedByUserId: input.userId,
            updatedAt: now,
          })
          .where(eq(workspaceSiteProfiles.userId, input.userId));
      }
    }
    await tx
      .update(siteProjects)
      .set({
        ...(changingAccount ? { canonicalHostname: null } : {}),
        revision: projects[0].revision + 1,
        updatedAt: now,
      })
      .where(eq(siteProjects.id, input.projectId));
    return {
      connectionId,
      accountUid: input.accountUid,
      status: "active" as const,
      capabilities: ["alidns_read", "alidns_write"] as const,
    };
  });
}

export async function getAliyunCustomerConnectionStatus(rawInput: {
  projectId: string;
  userId: number;
}) {
  const db = await requireDb();
  const connection = await loadOwnedAliyunConnection(db, rawInput);
  if (!connection) {
    return {
      configured: false,
      connectionId: null,
      accountUid: null,
      status: null,
      capabilities: [] as string[],
      verifiedAt: null,
      lastErrorCode: null,
      canDisconnect: false,
    };
  }
  const inFlight = await db
    .select({ id: siteOperations.id })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, connection.projectId),
        eq(siteOperations.userId, connection.userId),
        inArray(siteOperations.provider, ["aliyun_alidns", "aliyun_esa"]),
        inArray(siteOperations.status, [
          "queued",
          "running",
          "outcome_unknown",
        ]),
      ),
    )
    .limit(1);
  return {
    configured: connection.status === "active",
    connectionId: connection.id,
    accountUid: connection.accountUid,
    status: connection.status,
    capabilities: connection.capabilities,
    verifiedAt: connection.verifiedAt?.getTime() ?? null,
    lastErrorCode: connection.lastErrorCode,
    canDisconnect: inFlight.length === 0 && connection.status !== "revoked",
  };
}

export async function disconnectAliyunCustomerConnection(
  rawInput: { projectId: string; userId: number },
  options?: { fetchImpl?: typeof fetch },
) {
  const db = await requireDb();
  const connection = await loadOwnedAliyunConnection(db, rawInput);
  if (!connection) return { disconnected: true as const, revokedRemote: false };
  const status = await getAliyunCustomerConnectionStatus(rawInput);
  if (!status.canDisconnect) {
    throw new AliyunProviderError(
      "CONNECTION_IN_USE",
      "仍有域名解析操作正在执行或等待对账，暂不能断开连接。",
    );
  }
  let revokedRemote = false;
  try {
    const result = await revokeAliyunOAuthToken({
      credentialId: connection.oauthCredentialId,
      refreshToken: openAliyunRefreshToken(connection),
      fetchImpl: options?.fetchImpl,
    });
    revokedRemote = result.revoked;
  } catch {
    // Local revocation is authoritative for FrontMind. Alibaba Cloud revoke is
    // deliberately best-effort so a transient identity outage cannot retain
    // an otherwise disconnected customer grant in this product.
  }
  await transitionAliyunConnectionState({
    db,
    connection,
    status: "revoked",
    lastErrorCode: null,
    overwriteRefreshToken: true,
  });
  return { disconnected: true as const, revokedRemote };
}

export async function requireAliyunOwnedDomain(
  api: AliyunDnsApi,
  requestedDomain: string,
) {
  const requested = normalizeAliyunDomain(requestedDomain);
  const matched = await api.getDomain(requested.ascii);
  if (!matched) {
    throw new AliyunProviderError(
      "ALIYUN_DOMAIN_NOT_OWNED",
      "该域名不在当前阿里云账号的已购买域名列表中。",
    );
  }
  return matched;
}

export type AliyunDnsPlanItem = {
  id: string;
  action:
    | "create"
    | "update"
    | "adopt"
    | "verify"
    | "rollback_delete"
    | "rollback_verify"
    | "conflict"
    | "unknown";
  current: AliyunDnsRecordView | null;
  reason: string | null;
};

export type AliyunDnsBoundPlanItem = {
  id: string;
  action: AliyunDnsPlanItem["action"];
  rr: string;
  type: string;
  expectedValue: string;
  expectedTtl: number;
  current: AliyunDnsRecordView | null;
  reason: string | null;
};

type AliyunDnsExpectationGuard = {
  schemaVersion: 1;
  mode: "apply" | "rollback";
  domain: string;
  revision: number;
  expectedRecordsHash: string;
};

type AliyunDnsTargetProfile = Pick<
  typeof workspaceSiteProfiles.$inferSelect,
  | "normalizedAsciiDomain"
  | "domainRevision"
  | "domainStatus"
  | "domainOwnershipStatus"
>;

/**
 * Hash only the FrontMind-owned desired state. Provider observations, status,
 * RecordIds acquired during an apply, and verification timestamps deliberately
 * do not participate, so a retry can reconcile normal DNS propagation without
 * accepting a changed desired tuple. Rollback additionally freezes the exact
 * owned RecordId. The OAuth-only contract never overwrites an unowned record,
 * so rollback removes only the exact FrontMind-owned record instead of
 * manufacturing a customer-looking record from an older FrontMind value.
 */
export function aliyunDnsExpectedRecordsHash(input: {
  mode: "apply" | "rollback";
  domain: string;
  revision: number;
  records: Array<
    Pick<
      SiteDnsRecord,
      | "id"
      | "domainAscii"
      | "domainRevision"
      | "recordType"
      | "rr"
      | "expectedValue"
      | "expectedTtl"
      | "remarkMarker"
      | "providerRecordId"
    >
  >;
}) {
  return sha256(
    stableJson({
      schemaVersion: 1,
      mode: input.mode,
      domain: normalizeAliyunDomain(input.domain).ascii,
      revision: input.revision,
      records: [...input.records]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => ({
          id: record.id,
          domain: normalizeAliyunDomain(record.domainAscii).ascii,
          revision: record.domainRevision,
          type: record.recordType.toUpperCase(),
          rr: record.rr.toLowerCase(),
          expectedValue: normalizedDnsValue(
            record.recordType,
            record.expectedValue,
          ),
          expectedTtl: record.expectedTtl,
          remarkMarker: record.remarkMarker,
          ...(input.mode === "rollback"
            ? {
                providerRecordId: record.providerRecordId,
              }
            : {}),
        })),
    }),
  );
}

export function assertAliyunDnsTargetCurrent(
  profile: AliyunDnsTargetProfile | null,
  expected: { domain: string; revision: number },
) {
  const currentDomain = profile?.normalizedAsciiDomain
    ? normalizeAliyunDomain(profile.normalizedAsciiDomain).ascii
    : null;
  const expectedDomain = normalizeAliyunDomain(expected.domain).ascii;
  if (
    currentDomain !== expectedDomain ||
    profile?.domainRevision !== expected.revision ||
    profile?.domainStatus !== "completed" ||
    profile?.domainOwnershipStatus !== "verified"
  ) {
    throw new AliyunProviderError(
      "DNS_DOMAIN_REVISION_STALE",
      "当前官网域名或域名版本已变化；未执行任何 DNS 写入，请重新生成配置方案。",
    );
  }
}

export function bindAliyunDnsPlan(input: {
  domain: string;
  revision: number;
  expectedRecords: SiteDnsRecord[];
  plan: AliyunDnsPlanItem[];
}) {
  const items = input.plan.map((item): AliyunDnsBoundPlanItem => {
    const expected = input.expectedRecords.find((row) => row.id === item.id);
    if (!expected) {
      throw new AliyunProviderError(
        "DNS_EXPECTATION_INVALID",
        "DNS 计划引用了不存在的期望记录。",
      );
    }
    return {
      id: item.id,
      action: item.action,
      rr: expected.rr,
      type: expected.recordType.toUpperCase(),
      expectedValue: expected.expectedValue,
      expectedTtl: expected.expectedTtl,
      current: item.current
        ? {
            recordId: item.current.recordId,
            rr: item.current.rr,
            type: item.current.type.toUpperCase(),
            value: item.current.value,
            ttl: item.current.ttl,
            remark: item.current.remark,
          }
        : null,
      reason: item.reason,
    };
  });
  const providerSnapshotHash = sha256(
    stableJson({
      schemaVersion: 1,
      domain: input.domain,
      revision: input.revision,
      records: items.map((item) => ({ id: item.id, current: item.current })),
    }),
  );
  const planHash = sha256(
    stableJson({
      schemaVersion: 1,
      domain: input.domain,
      revision: input.revision,
      providerSnapshotHash,
      items,
    }),
  );
  return {
    items,
    providerSnapshotHash,
    planHash,
    canApply: items.every(
      (item) => item.action !== "conflict" && item.action !== "unknown",
    ),
  };
}

function normalizedDnsValue(type: string, value: string) {
  const trimmed = value.trim();
  if (type.toUpperCase() === "CNAME") {
    return trimmed.replace(/\.$/, "").toLowerCase();
  }
  if (type.toUpperCase() === "TXT") {
    return trimmed.replace(/^"|"$/g, "");
  }
  return trimmed.toLowerCase();
}

function sameDnsTuple(
  current: AliyunDnsRecordView,
  expected: Pick<
    SiteDnsRecord,
    "rr" | "recordType" | "expectedValue" | "expectedTtl"
  >,
) {
  return (
    current.rr.toLowerCase() === expected.rr.toLowerCase() &&
    current.type.toUpperCase() === expected.recordType.toUpperCase() &&
    normalizedDnsValue(current.type, current.value) ===
      normalizedDnsValue(expected.recordType, expected.expectedValue) &&
    current.ttl === expected.expectedTtl
  );
}

function sameDnsOwner(
  current: AliyunDnsRecordView,
  expected: Pick<SiteDnsRecord, "providerRecordId" | "remarkMarker">,
) {
  return (
    Boolean(expected.providerRecordId) &&
    current.recordId === expected.providerRecordId &&
    current.remark === expected.remarkMarker
  );
}

export function planAliyunDnsRecords(
  expectedRecords: SiteDnsRecord[],
  currentRecords: AliyunDnsRecordView[],
  mode: "apply" | "rollback" = "apply",
): AliyunDnsPlanItem[] {
  return expectedRecords.map((expected): AliyunDnsPlanItem => {
    const type = expected.recordType.toUpperCase();
    if (!["TXT", "CNAME", "A", "AAAA"].includes(type)) {
      return {
        id: expected.id,
        action: "conflict",
        current: null,
        reason: `FrontMind 不管理 ${type} 记录。`,
      };
    }
    const tupleRecords = currentRecords.filter(
      (current) =>
        current.rr.toLowerCase() === expected.rr.toLowerCase() &&
        current.type.toUpperCase() === type,
    );
    const byId = expected.providerRecordId
      ? (currentRecords.find(
          (current) => current.recordId === expected.providerRecordId,
        ) ?? null)
      : null;
    if (mode === "rollback") {
      if (!byId) {
        return {
          id: expected.id,
          action: "rollback_verify",
          current: null,
          reason: null,
        };
      }
      if (!sameDnsOwner(byId, expected)) {
        return {
          id: expected.id,
          action: "conflict",
          current: byId,
          reason: "RecordId 或 FrontMind remark 不再匹配，拒绝回滚。",
        };
      }
      if (!sameDnsTuple(byId, expected)) {
        return {
          id: expected.id,
          action: "conflict",
          current: byId,
          reason: "记录已被客户后续修改，拒绝覆盖或删除。",
        };
      }
      return {
        id: expected.id,
        action: "rollback_delete",
        current: byId,
        reason: null,
      };
    }
    if (expected.providerRecordId) {
      if (!byId || !sameDnsOwner(byId, expected)) {
        const unresolvedWrite =
          ["applying", "propagating", "outcome_unknown"].includes(
            expected.status,
          ) &&
          (!byId || byId.recordId === expected.providerRecordId);
        return {
          id: expected.id,
          action: unresolvedWrite ? "unknown" : "conflict",
          current: byId,
          reason: unresolvedWrite
            ? "RecordId/remark 尚未在控制面同时可见；只读等待，不重复写入。"
            : "RecordId 与 FrontMind remark 必须同时匹配后才能更新。",
        };
      }
      if (
        ["applying", "propagating", "outcome_unknown"].includes(
          expected.status,
        ) &&
        !sameDnsTuple(byId, expected)
      ) {
        return {
          id: expected.id,
          action: "unknown",
          current: byId,
          reason: "先前更新结果未知，当前值仍不匹配；拒绝自动再次发送 Update。",
        };
      }
      return {
        id: expected.id,
        action: sameDnsTuple(byId, expected) ? "verify" : "update",
        current: byId,
        reason: null,
      };
    }
    const recoverable = tupleRecords.filter(
      (current) =>
        current.remark === expected.remarkMarker &&
        sameDnsTuple(current, expected),
    );
    if (recoverable.length === 1 && tupleRecords.length === 1) {
      return {
        id: expected.id,
        action: "adopt",
        current: recoverable[0],
        reason: null,
      };
    }
    if (tupleRecords.length > 0) {
      return {
        id: expected.id,
        action: "conflict",
        current: tupleRecords[0],
        reason: "相同 RR/type 已有非 FrontMind 记录，拒绝覆盖。",
      };
    }
    if (["applying", "outcome_unknown"].includes(expected.status)) {
      return {
        id: expected.id,
        action: "unknown",
        current: null,
        reason:
          "先前写入结果未知且无法按精确 tuple+remark 对账，拒绝重复新增。",
      };
    }
    return { id: expected.id, action: "create", current: null, reason: null };
  });
}

export function isExplicitPublicDnsAbsence(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return code === "ENODATA" || code === "ENOTFOUND";
}

function publicDnsResolutionErrorCode(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)
    ? code
    : "DNS_RESOLUTION_UNAVAILABLE";
}

async function defaultPublicDnsResolver(input: {
  hostname: string;
  type: string;
}) {
  try {
    switch (input.type.toUpperCase()) {
      case "A":
        return await resolve4(input.hostname);
      case "AAAA":
        return await resolve6(input.hostname);
      case "CNAME":
        return await resolveCname(input.hostname);
      case "TXT":
        return (await resolveTxt(input.hostname)).map((parts) =>
          parts.join(""),
        );
      default:
        return [];
    }
  } catch (error) {
    if (isExplicitPublicDnsAbsence(error)) return [];
    throw error;
  }
}

function dnsHostname(domain: string, rr: string) {
  return rr === "@" ? domain : `${rr}.${domain}`;
}

async function verifyPublicDns(
  records: SiteDnsRecord[],
  resolver: PublicDnsResolver,
) {
  const observations = await Promise.all(
    records.map(async (record) => {
      let values: string[];
      try {
        values = await resolver({
          hostname: dnsHostname(record.domainAscii, record.rr),
          type: record.recordType,
        });
      } catch (error) {
        return {
          id: record.id,
          values: [],
          matched: false,
          unavailable: true,
          errorCode: publicDnsResolutionErrorCode(error),
        };
      }
      const expected = normalizedDnsValue(
        record.recordType,
        record.expectedValue,
      );
      return {
        id: record.id,
        values,
        matched: values.some(
          (value) => normalizedDnsValue(record.recordType, value) === expected,
        ),
        unavailable: false,
        errorCode: null,
      };
    }),
  );
  return {
    ok: observations.every((observation) => observation.matched),
    observations,
  };
}

export async function verifyPublicDnsRollback(
  records: SiteDnsRecord[],
  resolver: PublicDnsResolver,
) {
  const observations = await Promise.all(
    records.map(async (record) => {
      let values: string[];
      try {
        values = await resolver({
          hostname: dnsHostname(record.domainAscii, record.rr),
          type: record.recordType,
        });
      } catch (error) {
        return {
          id: record.id,
          values: [],
          target: "absent" as const,
          matched: false,
          unavailable: true,
          errorCode: publicDnsResolutionErrorCode(error),
        };
      }
      const expectedFrontMindValue = normalizedDnsValue(
        record.recordType,
        record.expectedValue,
      );
      return {
        id: record.id,
        values,
        target: "absent" as const,
        matched: !values.some(
          (value) =>
            normalizedDnsValue(record.recordType, value) ===
            expectedFrontMindValue,
        ),
        unavailable: false,
        errorCode: null,
      };
    }),
  );
  return {
    ok: observations.every((observation) => observation.matched),
    observations,
  };
}

async function loadActiveConnectionForOperation(
  db: DbExecutor,
  operation: SiteOperation,
) {
  const rows = await db
    .select()
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.projectId, operation.projectId),
        eq(siteProviderConnections.userId, operation.userId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
      ),
    )
    .limit(1);
  const connection = rows[0];
  if (!connection) {
    throw new AliyunProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "客户阿里云连接不存在。",
    );
  }
  return connection;
}

async function loadDnsRows(
  db: DbExecutor,
  operation: SiteOperation,
  requestedRevision?: number,
) {
  let revision = requestedRevision;
  if (!revision) {
    const profiles = await db
      .select({ revision: workspaceSiteProfiles.domainRevision })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, operation.userId))
      .limit(1);
    revision = profiles[0]?.revision;
  }
  if (!revision) {
    throw new AliyunProviderError(
      "DOMAIN_REVISION_REQUIRED",
      "当前项目没有可规划的域名版本。",
    );
  }
  const rows = await db
    .select()
    .from(siteDnsRecords)
    .where(
      and(
        eq(siteDnsRecords.projectId, operation.projectId),
        eq(siteDnsRecords.userId, operation.userId),
        eq(siteDnsRecords.domainRevision, revision),
      ),
    );
  if (rows.length === 0) {
    throw new AliyunProviderError(
      "DNS_EXPECTATION_NOT_READY",
      "ESA 尚未生成该域名版本的期望 TXT/CNAME，未执行 DNS 写入。",
    );
  }
  const domains = new Set(rows.map((row) => row.domainAscii));
  if (domains.size !== 1) {
    throw new AliyunProviderError(
      "DNS_EXPECTATION_INVALID",
      "同一域名版本包含多个域名，拒绝执行。",
    );
  }
  return { revision, domain: rows[0].domainAscii, rows };
}

const dnsExpectationGuardSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["apply", "rollback"]),
    domain: z.string().min(1),
    revision: z.number().int().positive(),
    expectedRecordsHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const dnsPlanResultSchema = z
  .object({
    domain: z.string().min(1),
    revision: z.number().int().positive(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    providerSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    plan: z.array(
      z
        .object({
          id: z.string().min(1),
          rr: z.string().min(1),
          type: z.string().min(1),
          expectedValue: z.string(),
          expectedTtl: z.number().int().positive(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function expectationGuardFromResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = dnsExpectationGuardSchema.safeParse(
    (value as Record<string, unknown>).dnsExpectationGuard,
  );
  return parsed.success ? parsed.data : null;
}

function withDnsExpectationGuard<T extends SiteOpsProviderResult>(
  result: T,
  guard: AliyunDnsExpectationGuard | null,
): T {
  if (!guard) return result;
  return {
    ...result,
    result: {
      ...(result.result ?? {}),
      dnsExpectationGuard: guard,
    },
  } as T;
}

async function assertCurrentDnsTarget(
  db: DbExecutor,
  operation: SiteOperation,
  expected: { domain: string; revision: number },
) {
  const profiles = await db
    .select({
      normalizedAsciiDomain: workspaceSiteProfiles.normalizedAsciiDomain,
      domainRevision: workspaceSiteProfiles.domainRevision,
      domainStatus: workspaceSiteProfiles.domainStatus,
      domainOwnershipStatus: workspaceSiteProfiles.domainOwnershipStatus,
    })
    .from(workspaceSiteProfiles)
    .where(eq(workspaceSiteProfiles.userId, operation.userId))
    .limit(1);
  assertAliyunDnsTargetCurrent(profiles[0] ?? null, expected);
}

async function loadApplyPlanExpectationHash(input: {
  db: DbExecutor;
  operation: SiteOperation;
  parsed: z.infer<typeof dnsOperationInputSchema>;
  expected: { domain: string; revision: number };
}) {
  const planRows = await input.db
    .select({ input: siteOperations.input, result: siteOperations.result })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.id, input.parsed.planOperationId!),
        eq(siteOperations.projectId, input.operation.projectId),
        eq(siteOperations.userId, input.operation.userId),
        eq(siteOperations.kind, "dns_apply"),
        eq(siteOperations.provider, "aliyun_alidns"),
        eq(siteOperations.status, "succeeded"),
      ),
    )
    .limit(1);
  const planOperation = planRows[0];
  const planInput = dnsOperationInputSchema.safeParse(planOperation?.input);
  const planResult = dnsPlanResultSchema.safeParse(planOperation?.result);
  if (
    !planInput.success ||
    planInput.data.dnsIntent !== "plan" ||
    !planResult.success ||
    planResult.data.domain !== input.expected.domain ||
    planResult.data.revision !== input.expected.revision ||
    planResult.data.planHash !== input.parsed.planHash ||
    planResult.data.providerSnapshotHash !== input.parsed.providerSnapshotHash
  ) {
    throw new AliyunProviderError(
      "DNS_PLAN_REFERENCE_INVALID",
      "原始 DNS 配置方案已失效；未执行任何写入，请重新生成配置方案。",
    );
  }
  const deterministicRemark = `frontmind:${input.operation.projectId}:${input.expected.revision}`;
  return aliyunDnsExpectedRecordsHash({
    mode: "apply",
    domain: input.expected.domain,
    revision: input.expected.revision,
    records: planResult.data.plan.map((item) => ({
      id: item.id,
      domainAscii: input.expected.domain,
      domainRevision: input.expected.revision,
      recordType: item.type,
      rr: item.rr,
      expectedValue: item.expectedValue,
      expectedTtl: item.expectedTtl,
      remarkMarker: deterministicRemark,
      providerRecordId: null,
      beforeValue: null,
      beforeTtl: null,
    })),
  });
}

async function freezeDnsExpectation(input: {
  db: DbExecutor;
  operation: SiteOperation;
  parsed: z.infer<typeof dnsOperationInputSchema>;
  expected: { domain: string; revision: number; rows: SiteDnsRecord[] };
  mode: "apply" | "rollback";
}) {
  const currentHash = aliyunDnsExpectedRecordsHash({
    mode: input.mode,
    domain: input.expected.domain,
    revision: input.expected.revision,
    records: input.expected.rows,
  });
  const frozenHash =
    input.mode === "apply"
      ? await loadApplyPlanExpectationHash(input)
      : (expectationGuardFromResult(input.operation.result)
          ?.expectedRecordsHash ?? currentHash);
  const existingGuard = expectationGuardFromResult(input.operation.result);
  if (
    currentHash !== frozenHash ||
    (existingGuard &&
      (existingGuard.mode !== input.mode ||
        existingGuard.domain !== input.expected.domain ||
        existingGuard.revision !== input.expected.revision ||
        existingGuard.expectedRecordsHash !== frozenHash))
  ) {
    throw new AliyunProviderError(
      "DNS_EXPECTATION_DRIFTED",
      "DNS 期望记录已变化；未执行任何写入，请重新生成配置方案。",
    );
  }
  const guard: AliyunDnsExpectationGuard = {
    schemaVersion: 1,
    mode: input.mode,
    domain: input.expected.domain,
    revision: input.expected.revision,
    expectedRecordsHash: frozenHash,
  };
  if (!existingGuard) {
    if (!input.operation.leaseOwner) {
      throw new AliyunProviderError(
        "DNS_OPERATION_LEASE_LOST",
        "DNS 操作租约已失效；未执行任何写入。",
      );
    }
    const priorResult =
      input.operation.result &&
      typeof input.operation.result === "object" &&
      !Array.isArray(input.operation.result)
        ? input.operation.result
        : {};
    const updated = await input.db
      .update(siteOperations)
      .set({
        result: { ...priorResult, dnsExpectationGuard: guard },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteOperations.id, input.operation.id),
          eq(siteOperations.leaseOwner, input.operation.leaseOwner),
        ),
      );
    if (affectedRows(updated) !== 1) {
      throw new AliyunProviderError(
        "DNS_OPERATION_LEASE_LOST",
        "DNS 操作租约已失效；未执行任何写入。",
      );
    }
  }
  return guard;
}

async function markDnsConflict(db: DbExecutor, item: AliyunDnsPlanItem) {
  await db
    .update(siteDnsRecords)
    .set({
      status: item.action === "unknown" ? "outcome_unknown" : "conflict",
      errorCode:
        item.action === "unknown" ? "DNS_OUTCOME_UNKNOWN" : "DNS_CONFLICT",
      errorMessage: item.reason,
      observedValue: item.current?.value,
      observedTtl: item.current?.ttl,
      updatedAt: new Date(),
    })
    .where(eq(siteDnsRecords.id, item.id));
}

async function applyDnsItem(
  db: DbExecutor,
  api: AliyunDnsApi,
  row: SiteDnsRecord,
  item: AliyunDnsPlanItem,
  beforeProviderMutation: () => Promise<void>,
) {
  if (item.action === "adopt" && item.current) {
    await db
      .update(siteDnsRecords)
      .set({
        providerRecordId: item.current.recordId,
        observedValue: item.current.value,
        observedTtl: item.current.ttl,
        status: "propagating",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
    return;
  }
  if (item.action === "verify") {
    await db
      .update(siteDnsRecords)
      .set({
        observedValue: item.current?.value,
        observedTtl: item.current?.ttl,
        status: "propagating",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
    return;
  }
  if (item.action === "rollback_verify") {
    await db
      .update(siteDnsRecords)
      .set({
        status: "rolled_back",
        observedValue: null,
        observedTtl: null,
        verifiedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
    return;
  }
  // Keep the target check outside the mutation catch: if it fails, no provider
  // request was attempted and the record must not be mislabeled outcome_unknown.
  await beforeProviderMutation();
  await db
    .update(siteDnsRecords)
    .set({ status: "applying", updatedAt: new Date() })
    .where(eq(siteDnsRecords.id, row.id));
  try {
    if (item.action === "create") {
      const created = await api.addRecord({
        domain: row.domainAscii,
        rr: row.rr,
        type: row.recordType,
        value: row.expectedValue,
        ttl: row.expectedTtl,
      });
      // RecordId is persisted before the second provider mutation. If setting
      // the remark loses its response, the next sweep reconciles by id+remark.
      await db
        .update(siteDnsRecords)
        .set({ providerRecordId: created.recordId, updatedAt: new Date() })
        .where(eq(siteDnsRecords.id, row.id));
      await beforeProviderMutation();
      await api.updateRemark({
        recordId: created.recordId,
        remark: row.remarkMarker,
      });
    } else if (item.action === "update" && item.current) {
      await api.updateRecord({
        recordId: item.current.recordId,
        rr: row.rr,
        type: row.recordType,
        value: row.expectedValue,
        ttl: row.expectedTtl,
      });
    } else if (item.action === "rollback_delete" && item.current) {
      await api.deleteRecord(item.current.recordId);
      await db
        .update(siteDnsRecords)
        .set({
          status: "rolled_back",
          observedValue: null,
          observedTtl: null,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(siteDnsRecords.id, row.id));
      return;
    }
    await db
      .update(siteDnsRecords)
      .set({
        status: "propagating",
        observedValue: row.expectedValue,
        observedTtl: row.expectedTtl,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
  } catch (error) {
    await db
      .update(siteDnsRecords)
      .set({
        status: "outcome_unknown",
        errorCode: "ALIDNS_OUTCOME_UNKNOWN",
        errorMessage:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : "AliDNS 写入结果未知。",
        updatedAt: new Date(),
      })
      .where(eq(siteDnsRecords.id, row.id));
    throw new AliyunProviderError(
      "ALIDNS_OUTCOME_UNKNOWN",
      "AliDNS 写入结果未知；系统将按 RecordId、精确 tuple 和 remark 只读对账，不会盲目重发。",
      true,
    );
  }
}

async function handleDomainSync(input: {
  db: DbExecutor;
  operation: SiteOperation;
  parsed: z.infer<typeof domainSyncInputSchema>;
  connection: SiteProviderConnection;
  api: AliyunDnsApi;
}): Promise<SiteOpsProviderResult> {
  if (input.operation.kind !== "domain_sync") {
    throw new AliyunProviderError(
      "DOMAIN_SYNC_KIND_MISMATCH",
      "域名接入操作类型不匹配。",
    );
  }
  const selected = await requireAliyunOwnedDomain(
    input.api,
    input.parsed.domain,
  );
  const now = new Date();
  const domainRevision = await input.db.transaction(async (tx) => {
    const [projects, profiles, dnsEvidence] = await Promise.all([
      tx
        .select()
        .from(siteProjects)
        .where(
          and(
            eq(siteProjects.id, input.operation.projectId),
            eq(siteProjects.userId, input.operation.userId),
          ),
        )
        .limit(1)
        .for("update"),
      tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, input.operation.userId))
        .limit(1)
        .for("update"),
      tx
        .select({ id: siteDnsRecords.id })
        .from(siteDnsRecords)
        .where(
          and(
            eq(siteDnsRecords.projectId, input.operation.projectId),
            eq(siteDnsRecords.userId, input.operation.userId),
          ),
        )
        .limit(1)
        .for("update"),
    ]);
    const project = projects[0];
    const profile = profiles[0];
    if (!project || !profile) {
      throw new AliyunProviderError(
        "SITE_PROFILE_NOT_FOUND",
        "当前账号尚未初始化官网域名配置。",
      );
    }
    const sameDomain =
      profile.normalizedAsciiDomain === selected.domain &&
      profile.providerAccountUid === input.connection.accountUid;
    const hasExistingDomainState = Boolean(
      profile.domain ||
        profile.normalizedAsciiDomain ||
        profile.providerAccountUid ||
        profile.domainOwnershipStatus ||
        profile.dnsStatus ||
        profile.icpDomainRevision ||
        project.canonicalHostname ||
        project.globalLiveDeploymentId ||
        project.mainlandLiveDeploymentId ||
        dnsEvidence.length > 0,
    );
    assertAliyunDomainSelectionSafe({ sameDomain, hasExistingDomainState });
    const alreadyVerified =
      sameDomain &&
      profile.domainStatus === "completed" &&
      profile.domainOwnershipStatus === "verified";
    const nextDomainRevision = sameDomain
      ? profile.domainRevision
      : profile.domainRevision + 1;
    if (alreadyVerified && project.canonicalHostname === selected.domain) {
      return nextDomainRevision;
    }
    await tx
      .update(workspaceSiteProfiles)
      .set({
        domain: selected.displayDomain,
        normalizedAsciiDomain: selected.domain,
        unicodeDisplayDomain: selected.displayDomain,
        domainRevision: nextDomainRevision,
        providerAccountUid: input.connection.accountUid,
        domainStatus: "completed",
        domainOwnershipStatus: "verified",
        domainVerifiedAt: now,
        dnsStatus: alreadyVerified ? profile.dnsStatus : "pending",
        ...(sameDomain
          ? {}
          : {
              icpDomainRevision: null,
              icpProvince: null,
              icpNumber: null,
              icpStatus: "not_submitted" as const,
              icpVerifiedAt: null,
            }),
        revision: profile.revision + 1,
        updatedByUserId: input.operation.userId,
        updatedAt: now,
      })
      .where(eq(workspaceSiteProfiles.userId, input.operation.userId));
    await tx
      .update(siteProjects)
      .set({
        canonicalHostname: selected.domain,
        ...(!sameDomain ? { mainlandLiveDeploymentId: null } : {}),
        updatedAt: now,
      })
      .where(eq(siteProjects.id, project.id));
    return nextDomainRevision;
  });
  return {
    status: "succeeded",
    result: {
      domain: selected.domain,
      displayDomain: selected.displayDomain,
      domainRevision,
      phase: "domain_synced",
    },
    message: "域名已接入，FrontMind 正在自动配置解析。",
  };
}

export function createAliyunDnsProviderHandler(options?: {
  factory?: AliyunProviderSdkFactory;
  publicResolver?: PublicDnsResolver;
  refreshAccessToken?: AliyunOAuthTokenRefresher;
}): SiteOpsProviderHandler {
  const factory = options?.factory ?? new OfficialAliyunProviderSdkFactory();
  const publicResolver = options?.publicResolver ?? defaultPublicDnsResolver;
  return async ({ operation, signal }) => {
    let activeConnection: SiteProviderConnection | null = null;
    let expectationGuard: AliyunDnsExpectationGuard | null = null;
    const finish = <T extends SiteOpsProviderResult>(result: T) =>
      withDnsExpectationGuard(result, expectationGuard);
    try {
      if (process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() !== "1") {
        throw new AliyunProviderError(
          "PROVIDER_NOT_CONFIGURED",
          "AliDNS 自动化未启用；未写入任何解析记录。",
        );
      }
      assertNotAborted(signal);
      const db = await requireDb();
      const input = aliyunOperationInputSchema.parse(operation.input);
      const connection = await loadActiveConnectionForOperation(db, operation);
      activeConnection = connection;
      if (input.connectionId !== connection.id) {
        throw new AliyunProviderError(
          "DNS_CONNECTION_MISMATCH",
          "DNS 操作绑定的客户连接不一致。",
        );
      }
      const api = await createAliyunDnsApiForConnection({
        db,
        connection,
        factory,
        refreshAccessToken: options?.refreshAccessToken,
      });
      if ("domainIntent" in input) {
        return await handleDomainSync({
          db,
          operation,
          parsed: input,
          connection,
          api,
        });
      }
      const expected = await loadDnsRows(db, operation, input.domainRevision);
      const mode = input.dnsIntent === "rollback" ? "rollback" : "apply";
      if (input.dnsIntent !== "plan") {
        // A queued DNS write must not survive a later hostname/revision switch.
        // Freeze the desired tuple before the first provider mutation; retries
        // may observe propagation but may not accept changed expectations.
        await assertCurrentDnsTarget(db, operation, expected);
        expectationGuard = await freezeDnsExpectation({
          db,
          operation,
          parsed: input,
          expected,
          mode,
        });
      }
      const current = await api.listRecords(expected.domain);
      const plan = planAliyunDnsRecords(expected.rows, current, mode);
      const boundPlan = bindAliyunDnsPlan({
        domain: expected.domain,
        revision: expected.revision,
        expectedRecords: expected.rows,
        plan,
      });
      if (
        input.dnsIntent === "apply" &&
        !operation.result &&
        (operation.attempt ?? 0) <= 1 &&
        (input.planHash !== boundPlan.planHash ||
          input.providerSnapshotHash !== boundPlan.providerSnapshotHash)
      ) {
        return finish({
          status: "attention_required",
          code: "DNS_PLAN_DRIFTED",
          message:
            "DNS 期望记录或供应商当前记录已变化；没有执行写入，请重新生成精确差异计划。",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            expectedPlanHash: input.planHash,
            observedPlanHash: boundPlan.planHash,
            expectedProviderSnapshotHash: input.providerSnapshotHash,
            observedProviderSnapshotHash: boundPlan.providerSnapshotHash,
            plan: boundPlan.items,
            canApply: false,
          },
        });
      }
      const blocked = plan.filter(
        (item) => item.action === "conflict" || item.action === "unknown",
      );
      for (const item of blocked) await markDnsConflict(db, item);
      if (blocked.length > 0) {
        const onlyUnknown = blocked.every((item) => item.action === "unknown");
        const age =
          Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
        if (onlyUnknown && age < DNS_PROPAGATION_TIMEOUT_MS) {
          return finish({
            status: "pending",
            nextPollMs: 15_000,
            result: {
              domain: expected.domain,
              revision: expected.revision,
              phase: "dns_write_reconciling",
              plan: boundPlan.items,
              planHash: boundPlan.planHash,
              providerSnapshotHash: boundPlan.providerSnapshotHash,
              canApply: false,
            },
          });
        }
        return finish({
          status: "attention_required",
          code: blocked.some((item) => item.action === "unknown")
            ? "DNS_OUTCOME_UNKNOWN"
            : "DNS_CONFLICT",
          message:
            "DNS 中存在非 FrontMind 记录、所有权标记不一致或未知写入结果；未覆盖客户记录。",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            plan: boundPlan.items,
            planHash: boundPlan.planHash,
            providerSnapshotHash: boundPlan.providerSnapshotHash,
            canApply: false,
          },
        });
      }
      if (input.dnsIntent === "plan") {
        return finish({
          status: "succeeded",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            plan: boundPlan.items,
            planHash: boundPlan.planHash,
            providerSnapshotHash: boundPlan.providerSnapshotHash,
            canApply: boundPlan.canApply,
          },
          message: "DNS 精确差异计划已生成，尚未写入任何记录。",
        });
      }
      for (const item of plan) {
        assertNotAborted(signal);
        const row = expected.rows.find((entry) => entry.id === item.id)!;
        await assertCurrentDnsTarget(db, operation, expected);
        await applyDnsItem(db, api, row, item, async () => {
          assertNotAborted(signal);
          await assertCurrentDnsTarget(db, operation, expected);
        });
      }
      if (mode === "rollback") {
        const refreshed = await db
          .select()
          .from(siteDnsRecords)
          .where(
            and(
              eq(siteDnsRecords.projectId, operation.projectId),
              eq(siteDnsRecords.domainRevision, expected.revision),
            ),
          );
        const publicVerification = await verifyPublicDnsRollback(
          refreshed,
          publicResolver,
        );
        if (!publicVerification.ok) {
          const age =
            Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
          if (age < DNS_PROPAGATION_TIMEOUT_MS) {
            return finish({
              status: "pending",
              nextPollMs: 15_000,
              result: {
                domain: expected.domain,
                revision: expected.revision,
                phase: "dns_rollback_propagating",
                publicVerification,
              },
            });
          }
          return finish({
            status: "attention_required",
            code: "DNS_ROLLBACK_PROPAGATION_TIMEOUT",
            message:
              "AliDNS 控制面已安全回滚，但公共解析尚未确认旧 FrontMind 记录消失。",
            result: {
              domain: expected.domain,
              revision: expected.revision,
              publicVerification,
            },
          });
        }
        await db
          .update(workspaceSiteProfiles)
          .set({ dnsStatus: "rolled_back", updatedAt: new Date() })
          .where(
            and(
              eq(workspaceSiteProfiles.userId, operation.userId),
              eq(workspaceSiteProfiles.domainRevision, expected.revision),
            ),
          );
        return finish({
          status: "succeeded",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            rolledBack: true,
            publicVerification,
          },
          message: "仅 FrontMind 管理且未被客户后续修改的 DNS 记录已回滚。",
        });
      }
      const refreshed = await db
        .select()
        .from(siteDnsRecords)
        .where(
          and(
            eq(siteDnsRecords.projectId, operation.projectId),
            eq(siteDnsRecords.domainRevision, expected.revision),
          ),
        );
      const authoritativeRecords = await api.listRecords(expected.domain);
      const authoritativePlan = planAliyunDnsRecords(
        refreshed,
        authoritativeRecords,
        "apply",
      );
      const unresolvedAuthoritative = authoritativePlan.filter(
        (item) => item.action !== "verify" && item.action !== "adopt",
      );
      if (unresolvedAuthoritative.length > 0) {
        for (const item of unresolvedAuthoritative) {
          await db
            .update(siteDnsRecords)
            .set({
              status: "outcome_unknown",
              errorCode: "ALIDNS_CONTROL_PLANE_PENDING",
              errorMessage: item.reason ?? "AliDNS 控制面尚未返回期望记录。",
              updatedAt: new Date(),
            })
            .where(eq(siteDnsRecords.id, item.id));
        }
        const age =
          Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
        if (age < DNS_PROPAGATION_TIMEOUT_MS) {
          return finish({
            status: "pending",
            nextPollMs: 15_000,
            result: {
              domain: expected.domain,
              revision: expected.revision,
              phase: "dns_authoritative_reconciling",
              authoritativePlan,
            },
          });
        }
        return finish({
          status: "attention_required",
          code: "ALIDNS_CONTROL_PLANE_MISMATCH",
          message:
            "AliDNS 控制面未能确认精确 RecordId、tuple 与 remark；系统没有重复写入。",
          result: {
            domain: expected.domain,
            revision: expected.revision,
            authoritativePlan,
          },
        });
      }
      const publicVerification = await verifyPublicDns(
        refreshed,
        publicResolver,
      );
      if (!publicVerification.ok) {
        const age =
          Date.now() - (asDate(operation.createdAt)?.getTime() ?? Date.now());
        if (age >= DNS_PROPAGATION_TIMEOUT_MS) {
          return finish({
            status: "attention_required",
            code: "DNS_PROPAGATION_TIMEOUT",
            message: "AliDNS 控制面已写入，但公共解析在时限内未一致。",
            result: {
              domain: expected.domain,
              revision: expected.revision,
              publicVerification,
            },
          });
        }
        return finish({
          status: "pending",
          nextPollMs: 15_000,
          result: {
            domain: expected.domain,
            revision: expected.revision,
            phase: "dns_propagating",
            publicVerification,
          },
        });
      }
      await db
        .update(siteDnsRecords)
        .set({
          status: "active",
          verifiedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(siteDnsRecords.projectId, operation.projectId),
            eq(siteDnsRecords.domainRevision, expected.revision),
          ),
        );
      const hasCanonicalCname = refreshed.some(
        (record) => record.recordType.toUpperCase() === "CNAME",
      );
      await db
        .update(workspaceSiteProfiles)
        .set({
          dnsStatus: hasCanonicalCname ? "active" : "pending_esa_binding",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workspaceSiteProfiles.userId, operation.userId),
            eq(workspaceSiteProfiles.domainRevision, expected.revision),
          ),
        );
      return finish({
        status: "succeeded",
        result: {
          domain: expected.domain,
          revision: expected.revision,
          publicVerification,
        },
        message: hasCanonicalCname
          ? "AliDNS 控制面与公共解析均已验证。"
          : "ESA 所有权 TXT 已验证；请再次生成 DNS 计划以取得精确 CNAME。",
      });
    } catch (error) {
      if (activeConnection) {
        const db = await getDb();
        if (db) {
          await invalidateAliyunConnectionOnUnauthorized({
            db,
            connection: activeConnection,
            error,
          });
        }
      }
      return finish(resultError(error));
    }
  };
}

let registeredAliyunProviders = false;

/** Registers the OAuth-only AliDNS handler once; no registration on import. */
export function registerAliyunSiteOpsProviders(options?: {
  factory?: AliyunProviderSdkFactory;
  publicResolver?: PublicDnsResolver;
  refreshAccessToken?: AliyunOAuthTokenRefresher;
}) {
  if (registeredAliyunProviders) return () => undefined;
  const unregisterDns = registerSiteOpsProviderHandler(
    "aliyun_alidns",
    createAliyunDnsProviderHandler({
      factory: options?.factory,
      publicResolver: options?.publicResolver,
      refreshAccessToken: options?.refreshAccessToken,
    }),
  );
  registeredAliyunProviders = true;
  return () => {
    unregisterDns();
    registeredAliyunProviders = false;
  };
}
