import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { domainToASCII, domainToUnicode } from "node:url";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  notInArray,
} from "drizzle-orm";
import { z } from "zod";
import {
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseSnapshots,
  localAssets,
  messages,
  presalesApiCredentials,
  siteBuildInputAssets,
  siteBuilds,
  siteDeployments,
  siteDnsRecords,
  siteOperations,
  siteProjects,
  siteProviderConnections,
  socialPackages,
  users,
  visualCandidatePoolPages,
  visualCandidatePools,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  workspaceSiteProfiles,
} from "../../drizzle/schema";
import {
  SITEOPS_DEFAULT_WORKFLOW,
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_MATERIALIZER_V2_6,
  SITEOPS_MATERIALIZER_V2_7,
  SITEOPS_MATERIALIZER_V2_8,
  SITEOPS_MATERIALIZER_V2_9,
  SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
  SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL,
  SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
  parseSiteOpsPersistedWorkflowCoordinates,
  siteBriefSchema,
  siteOpsActInputSchema,
  siteOpsAliyunConnectionInputSchema,
  siteOpsAliyunDomainListSchema,
  siteOpsObserveInputSchema,
  siteOpsSendMessageInputSchema,
  siteOpsVisualFailureCategorySchema,
  staticTemplateExecutionAdmissionEvidenceSchema,
  visualEvidenceV1Schema,
  type SiteOpsVisualFailureCategory,
  type SiteOpsActInput,
  type SiteBrief,
} from "../../shared/siteops";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "../../shared/siteops-branding";
import { createVisualEvidenceV1 } from "../../shared/siteops-workflow";
import {
  SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE,
  siteOpsInteractionStateSchema,
  siteOpsObservationV1Schema,
  type SiteOpsExecutionStep,
  type SiteOpsObservationV1,
} from "../../shared/siteops-contract";
import {
  referenceBlueprintForVisualCandidate,
  referenceBlueprintSchema,
  referenceBlueprintV3Schema,
  referenceBlueprintV4Schema,
  type ReferenceBlueprint,
} from "../../shared/siteops-design";
import {
  STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
  STATIC_TEMPLATE_CATALOG_VERSION,
  loadActiveStaticTemplateCatalog,
  requireActiveStaticTemplateCatalog,
  staticTemplateAdmissionEvidenceSha256,
} from "./static-template-catalog";
import {
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
} from "./native-react-source";
import {
  visualSearchOperationInputSchema,
  type VisualSearchOperationInput,
} from "../../shared/siteops-workflow";
import {
  managedAgentProfileSchema,
  normalizeManagedAgentProfile,
  type ManagedAgentProfile,
} from "../../shared/manus-agent-profile";
import {
  AuthServiceError,
  getDecryptedCredentialForUser,
  type AuthenticatedUser,
} from "../auth-service";
import { getDb } from "../db";
import { ownedFileContentResolver } from "../owned-file-content-resolver";
import { getServicePortal } from "../service-entitlement";
import { getTwentyFirstCredentialStatus } from "../twenty-first-service";
import { siteOpsProviderConfigured } from "./providers";
import {
  AliyunProviderError,
  bindAliyunCustomerAccountFromOAuth,
  disconnectAliyunCustomerConnection,
  getAliyunCustomerConnectionStatus,
  listAliyunCustomerDomains,
} from "./aliyun-provider";
import { createAliyunOAuthAuthorization } from "./aliyun-platform-service";
import { inspectEsaRuntimeConfiguration } from "./esa-config";
import {
  publicSiteOpsMessageText,
  sanitizeFrontMindPublicText,
} from "./public-errors";
import {
  assertSiteOpsServiceEntitlement,
  reserveSiteOpsQuota,
  siteOpsQuotaPeriodIds,
  SiteOpsQuotaError,
} from "./quota-service";
import {
  createSiteOpsRebuildTicket,
  loadSiteOpsRebuildRequest,
  SiteOpsRebuildTicketError,
} from "./rebuild-ticket";
import { customerVisibleStyleBatchStatusCondition } from "./visual-batch-visibility";
import { siteOpsTrustedFallbackPreviewFromResult } from "./trusted-fallback";
import {
  isSiteOpsPersistenceDatabaseError,
  safeSiteOpsPersistenceDiagnostics,
  siteOpsPersistenceTransactionOutcome,
} from "./persistence-diagnostics";
import {
  decodedRasterImageDimensions,
  imageMimeByExtension,
  isSupportedImageBytes,
} from "../knowledge-archive-image-validation";
import { persistSiteOpsArtifact } from "./artifact-store";

export type SiteOpsServiceErrorCode =
  | "CREDENTIAL_ROTATED"
  | "DATABASE_UNAVAILABLE"
  | "FEATURE_DISABLED"
  | "FORBIDDEN"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PROVIDER_NOT_CONFIGURED"
  | "REVISION_CONFLICT"
  | "STATE_CONFLICT"
  | "VISUAL_SELECTION_PERSISTENCE_FAILED";

export class SiteOpsServiceError extends Error {
  constructor(
    public readonly code: SiteOpsServiceErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SiteOpsServiceError";
  }
}

export const siteOpsActionAckV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    accepted: z.literal(true),
    clientRequestId: z.string().trim().min(8).max(128),
    operationId: z.string().uuid().nullable(),
    projectRevision: z.number().int().positive(),
    latestSequence: z.number().int().nonnegative(),
    interactionState: siteOpsInteractionStateSchema,
  })
  .strict();

export type SiteOpsActionAckV1 = z.infer<typeof siteOpsActionAckV1Schema>;

export function siteOpsServiceErrorFromQuota(error: SiteOpsQuotaError) {
  return new SiteOpsServiceError(
    error.code === "SITEOPS_ENTITLEMENT_REQUIRED"
      ? "FORBIDDEN"
      : "STATE_CONFLICT",
    error.message,
    error.statusCode,
  );
}

export function requireAcceptedSiteOpsRebuild(input: {
  acceptedForCurrentCycle: boolean;
}) {
  if (!input.acceptedForCurrentCycle) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先提交官网重制需求并等待 FrontMind 通过重置。",
      409,
    );
  }
}

export function siteOpsBuildWorkflowCoordinates(
  workflow:
    | typeof SITEOPS_MATERIALIZER_V2_5
    | typeof SITEOPS_MATERIALIZER_V2_6
    | typeof SITEOPS_MATERIALIZER_V2_7
    | typeof SITEOPS_MATERIALIZER_V2_8
    | typeof SITEOPS_MATERIALIZER_V2_9,
) {
  const persisted = parseSiteOpsPersistedWorkflowCoordinates({
    upstreamVersion: workflow.upstreamVersion,
    frontMindVersion: workflow.frontMindVersion,
    starterVersion: workflow.starterVersion,
    componentLibraryVersion: workflow.componentLibraryVersion,
  });
  return {
    workflowUpstreamVersion: persisted.upstreamVersion,
    workflowUpstreamHash: workflow.upstreamSha256,
    workflowVersion: persisted.frontMindVersion,
    workflowPackageHash: workflow.runtimeManifestSha256,
    starterVersion: persisted.starterVersion,
  } as const;
}

export function currentSiteOpsBuildWorkflowCoordinates() {
  return siteOpsBuildWorkflowCoordinates(SITEOPS_DEFAULT_WORKFLOW);
}

export function isSiteOpsOperationReplay(
  existing: { inputHash: string } | null | undefined,
  requestHash: string,
) {
  if (!existing) return false;
  if (existing.inputHash !== requestHash) {
    throw new SiteOpsServiceError(
      "IDEMPOTENCY_CONFLICT",
      "该请求标识已用于不同操作。",
      409,
    );
  }
  return true;
}

const uuidSchema = z.string().uuid();
const optionalUuidSchema = uuidSchema.optional();
const TWENTY_FIRST_OPERATION_MARKER_PREFIX = "siteops-21st-operation:";
const isStaticCatalogWorkflowVersion = (workflowVersion: string | null) =>
  workflowVersion === SITEOPS_MATERIALIZER_V2_8.frontMindVersion ||
  workflowVersion === SITEOPS_MATERIALIZER_V2_9.frontMindVersion;
const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\s/@?#\\]/u.test(value), "域名格式不正确");

export function normalizeSiteOpsDomain(value: string) {
  const withoutDot = value.trim().replace(/\.$/u, "");
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    isIP(ascii) !== 0 ||
    !ascii.includes(".") ||
    ascii
      .split(".")
      .some(
        (label) =>
          label.length < 1 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    throw new SiteOpsServiceError("INVALID_INPUT", "域名格式不正确。", 400);
  }
  return { domain: ascii, domainUnicode: domainToUnicode(ascii) || withoutDot };
}

export function isSiteOpsIcpApprovedForCurrentDomain(input: {
  icpStatus: string | null;
  icpNumber: string | null;
  icpDomainRevision: number | null;
  domainRevision: number;
}) {
  return Boolean(
    input.icpStatus === "approved" &&
      input.icpNumber?.trim() &&
      input.icpDomainRevision === input.domainRevision,
  );
}

function assertEnabled() {
  if (process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0") {
    throw new SiteOpsServiceError(
      "FEATURE_DISABLED",
      "AI 建站服务当前已暂停，请稍后重试。",
      503,
    );
  }
}

function assertCustomer(actor: AuthenticatedUser) {
  if (actor.role !== "user") {
    throw new SiteOpsServiceError(
      "FORBIDDEN",
      "只有客户本人可以操作 AI 建站会话。",
      403,
    );
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new SiteOpsServiceError(
      "DATABASE_UNAVAILABLE",
      "AI 建站服务暂时不可用，请稍后重试。",
      503,
    );
  }
  return db;
}

async function requireSiteOpsEntitlement(userId: number) {
  try {
    return assertSiteOpsServiceEntitlement(await getServicePortal(userId));
  } catch (error) {
    if (error instanceof SiteOpsQuotaError) {
      throw siteOpsServiceErrorFromQuota(error);
    }
    throw error;
  }
}

async function reserveSiteOpsDeliveryQuota(
  tx: any,
  input: {
    userId: number;
    portal: Awaited<ReturnType<typeof getServicePortal>>;
    quotaPool: "content_asset_publish" | "website_content_publish";
  },
) {
  try {
    return await reserveSiteOpsQuota(tx, {
      userId: input.userId,
      quotaPool: input.quotaPool,
      quotaPeriodIds: siteOpsQuotaPeriodIds(input.portal, input.quotaPool),
    });
  } catch (error) {
    if (error instanceof SiteOpsQuotaError) {
      throw siteOpsServiceErrorFromQuota(error);
    }
    throw error;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function compactKnowledgeText(value: unknown, max = 600) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[#>*_`|\[\]()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

const GENERIC_SITE_IDENTITY =
  /^(?:企业与品牌概览|品牌概览|公司介绍|企业介绍|关于我们|产品与服务|首页|知识库|企业概览)$/u;

function siteIdentityCandidate(value: unknown) {
  const candidate = compactKnowledgeText(value, 255)
    .replace(/^[\s「」『』“”"']+|[\s「」『』“”"']+$/gu, "")
    .replace(/(?:知识库|knowledge[\s_-]*base)$/iu, "")
    .trim();
  if (
    candidate.length < 2 ||
    candidate.length > 80 ||
    GENERIC_SITE_IDENTITY.test(candidate)
  ) {
    return "";
  }
  return candidate;
}

function companyIdentityFromPublicDocuments(
  documents: Array<
    (typeof knowledgeBaseSnapshots.$inferSelect)["documents"][number]
  >,
  sourceFileName: string,
) {
  const contents = documents.map((document) =>
    document.content.slice(0, 100_000),
  );
  const firstMatch = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      for (const content of contents) {
        const candidate = siteIdentityCandidate(content.match(pattern)?.[1]);
        if (candidate) return candidate;
      }
    }
    return "";
  };

  const publicBrand = firstMatch([
    /(?:对外品牌|品牌名称|品牌名)\s*[:：为是]\s*[「『“"']?([^「」『』“”"'\n，。；;]{2,80})/u,
    /(?:以|使用)\s*[「『“"']([^」』”"']{2,80})[」』”"']\s*(?:为|作为)\s*(?:对外)?品牌/u,
    /(?:以|使用)\s*([\p{L}\p{N}·&（）()\- ]{2,80})\s*(?:为|作为)\s*(?:对外)?品牌/u,
  ]);
  if (publicBrand) return { companyName: publicBrand, unresolved: false };

  const legalName = firstMatch([
    /(?:公司名称|企业名称)\s*[:：为是]\s*[「『“"']?([^「」『』“”"'\n，。；;]{2,80})/u,
  ]);
  if (legalName) return { companyName: legalName, unresolved: false };

  const introductoryName = firstMatch([
    /(?:^|[。！？\n])\s*([\p{L}\p{N}·&（）()\-]{2,80})\s*是一家[^。！？\n]{0,180}(?:公司|企业)/u,
  ]);
  if (introductoryName) {
    return { companyName: introductoryName, unresolved: false };
  }

  for (const document of documents) {
    const title = siteIdentityCandidate(document.title);
    if (title) return { companyName: title, unresolved: false };
  }
  const fileName = siteIdentityCandidate(
    sourceFileName.replace(/\.(?:zip|md)$/iu, ""),
  );
  if (fileName) return { companyName: fileName, unresolved: false };
  return { companyName: "待确认企业名称", unresolved: true };
}

export function siteBriefFromSnapshot(
  snapshot: typeof knowledgeBaseSnapshots.$inferSelect,
): SiteBrief {
  const publicDocuments = snapshot.documents.filter(
    (document) =>
      document.customerVisible !== false &&
      document.kind !== "evidence" &&
      // dashboard-core-v1 deliberately labels customer-confirmed leaf nodes as
      // needs_verification when their external evidence is incomplete. The
      // immutable active snapshot is still the customer's approved factual
      // source; keep its document ids in provenance and only exclude content
      // that the package itself classifies as inferred.
      document.evidenceStatus !== "inferred",
  );
  const idFor = (document: (typeof publicDocuments)[number]) =>
    String(document.id || document.path).slice(0, 191);
  const overview =
    publicDocuments.find((document) => document.kind === "overview") ??
    publicDocuments[0];
  const identity = companyIdentityFromPublicDocuments(
    publicDocuments,
    snapshot.sourceFileName,
  );
  const companyName = identity.companyName;
  const offeringDocuments = publicDocuments.filter((document) =>
    /(?:产品|服务|解决方案|业务)/u.test(
      `${document.branchTitle ?? ""} ${document.title}`,
    ),
  );
  const offerings = offeringDocuments
    .map((document) => compactKnowledgeText(document.title, 500))
    .filter(Boolean)
    .slice(0, 20);
  if (offerings.length === 0 && overview?.title) {
    offerings.push(compactKnowledgeText(overview.title, 500));
  }
  const audience = publicDocuments
    .flatMap((document) =>
      [
        ...document.content.matchAll(
          /(?:适用于|面向|服务于)\s*([^。；\n]{2,120})/gu,
        ),
      ].map((match) => compactKnowledgeText(match[1], 500)),
    )
    .filter(Boolean)
    .slice(0, 12);
  const contacts: SiteBrief["contacts"] = [];
  for (const document of publicDocuments) {
    const sourceDocumentIds = [idFor(document)];
    const content = document.content.slice(0, 100_000);
    const email = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
    const phone = content.match(
      /(?:\+?86[-\s]?)?(?:1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})/u,
    )?.[0];
    const address = content.match(
      /(?:地址|办公地址|联系地址)\s*[:：]\s*([^\n]{4,200})/u,
    )?.[1];
    if (email)
      contacts.push({ kind: "email", value: email, sourceDocumentIds });
    if (phone)
      contacts.push({ kind: "phone", value: phone, sourceDocumentIds });
    if (address) {
      contacts.push({
        kind: "address",
        value: compactKnowledgeText(address, 512),
        sourceDocumentIds,
      });
    }
    if (contacts.length >= 20) break;
  }
  const aboutIds = publicDocuments.slice(0, 8).map(idFor);
  const offeringIds = (
    offeringDocuments.length ? offeringDocuments : publicDocuments.slice(0, 8)
  ).map(idFor);
  const routeDocuments = (pattern: RegExp) =>
    publicDocuments.filter((document) =>
      pattern.test(
        `${document.branchTitle ?? ""} ${document.title} ${document.path}`,
      ),
    );
  const inventoryDocuments = {
    product: routeDocuments(/(?:产品|设备|软件|平台)/u),
    service: routeDocuments(/(?:服务|解决方案|业务)/u),
    application: routeDocuments(/(?:应用|场景|行业方案)/u),
    case_study: routeDocuments(/(?:案例|客户故事|实践)/u),
    blog: routeDocuments(/(?:博客|知识|科普|指南|洞察|白皮书)/u),
    company_news: routeDocuments(
      /(?:企业新闻|公司新闻|企业动态|公司动态|新闻中心)/u,
    ),
    faq: routeDocuments(/(?:FAQ|常见问题|问答|Q&A)/iu),
  } as const;
  const contentInventory: SiteBrief["contentInventory"] = {
    schemaVersion: 1,
    source: "frozen_knowledge_snapshot",
    entries: Object.entries(inventoryDocuments).flatMap(([kind, documents]) =>
      documents.length > 0
        ? [
            {
              kind: kind as keyof typeof inventoryDocuments,
              sourceDocumentIds: [
                ...new Set(documents.slice(0, 100).map(idFor)),
              ],
            },
          ]
        : [],
    ),
  };
  const conditionalRoute = (input: {
    id: string;
    slug: string;
    title: string;
    documents: typeof publicDocuments;
  }): SiteBrief["routes"][number] | null =>
    input.documents.length > 0
      ? {
          id: input.id,
          slug: input.slug,
          title: input.title,
          sourceDocumentIds: input.documents.slice(0, 100).map(idFor),
        }
      : null;
  const routes: SiteBrief["routes"] = [
    { id: "home", slug: "/", title: "首页", sourceDocumentIds: aboutIds },
    {
      id: "about",
      slug: "/about",
      title: "关于我们",
      sourceDocumentIds: aboutIds,
    },
    {
      id: "offerings",
      slug: "/offerings",
      title: "产品与服务",
      sourceDocumentIds: offeringIds,
    },
  ];
  for (const route of [
    conditionalRoute({
      id: "products",
      slug: "/products",
      title: "产品",
      documents: inventoryDocuments.product,
    }),
    conditionalRoute({
      id: "services",
      slug: "/services",
      title: "服务",
      documents: inventoryDocuments.service,
    }),
    conditionalRoute({
      id: "applications",
      slug: "/applications",
      title: "应用场景",
      documents: inventoryDocuments.application,
    }),
    conditionalRoute({
      id: "cases",
      slug: "/cases",
      title: "案例",
      documents: inventoryDocuments.case_study,
    }),
    conditionalRoute({
      id: "blog",
      slug: "/blog",
      title: "知识库",
      documents: inventoryDocuments.blog,
    }),
    conditionalRoute({
      id: "faq",
      slug: "/faq",
      title: "常见问题",
      documents: inventoryDocuments.faq,
    }),
  ]) {
    if (route && !routes.some((existing) => existing.slug === route.slug)) {
      routes.push(route);
    }
  }
  // Enterprise news is the sole always-addressable collection. An empty
  // snapshot inventory renders the host-owned legal empty state; it never
  // authorizes the provider to browse for or synthesize industry news.
  routes.push({
    id: "news",
    slug: "/news",
    title: "企业动态",
    sourceDocumentIds: [...new Set(inventoryDocuments.company_news.map(idFor))],
  });
  if (contacts.length > 0) {
    routes.push({
      id: "contact",
      slug: "/contact",
      title: "联系我们",
      sourceDocumentIds: [
        ...new Set(contacts.flatMap((item) => item.sourceDocumentIds)),
      ],
    });
  }
  const verifiedFacts = publicDocuments
    .flatMap((document) =>
      document.content
        .split(/\n\s*\n|(?<=[。！？])\s+/u)
        .map((statement) => compactKnowledgeText(statement, 2_000))
        .filter((statement) => statement.length >= 12)
        .slice(0, 4)
        .map((statement) => ({
          statement,
          sourceDocumentIds: [idFor(document)],
        })),
    )
    .slice(0, 120);
  const publicAssetIds = snapshot.assets
    .filter(
      (asset) =>
        Boolean(asset.id && asset.sha256) &&
        (asset.sourceKind === "official_logo_upload" ||
          (asset.ownership === "first_party" &&
            /logo/iu.test(`${asset.key} ${asset.path}`))),
    )
    .flatMap((asset) => (asset.id ? [asset.id] : []))
    .slice(0, 1);
  return siteBriefSchema.parse({
    companyName,
    primaryLanguage: "zh-CN",
    contacts,
    offerings,
    audience: audience.length > 0 ? audience : ["希望了解企业产品与服务的访客"],
    conversionGoal: contacts.length
      ? "帮助访客了解企业与产品，并通过已验证的联系方式进一步咨询"
      : "帮助访客准确了解企业与产品",
    contentInventory,
    routes,
    verifiedFacts,
    publicAssetIds,
    unknowns: [
      ...(identity.unresolved ? ["需要确认企业或品牌名称"] : []),
      ...(audience.length > 0 ? [] : ["需要进一步确认核心目标受众"]),
      ...(contacts.length > 0 ? [] : ["知识库中暂无可公开的已验证联系方式"]),
    ],
  });
}

export type VisualSearchReadiness =
  | { ready: true; brief: SiteBrief }
  | {
      ready: false;
      reason: "invalid_brief" | "no_public_facts" | "source_contract_mismatch";
      routeId?: string;
    };

/**
 * Validates the frozen SiteBrief immediately before visual-search reservation.
 * Company news is the only always-addressable collection with a legal empty
 * state: /news may have no sources only when the frozen inventory itself has
 * no company_news entry. Every other route remains source-bound.
 */
export function visualSearchReadiness(value: unknown): VisualSearchReadiness {
  const parsed = siteBriefSchema.safeParse(value);
  if (!parsed.success) {
    return { ready: false, reason: "invalid_brief" };
  }
  if (parsed.data.verifiedFacts.length === 0) {
    return { ready: false, reason: "no_public_facts" };
  }

  const hasCompanyNews = parsed.data.contentInventory.entries.some(
    (entry) => entry.kind === "company_news",
  );
  if (
    hasCompanyNews &&
    !parsed.data.routes.some(
      (route) => route.id === "news" && route.sourceDocumentIds.length > 0,
    )
  ) {
    return {
      ready: false,
      reason: "source_contract_mismatch",
      routeId: "news",
    };
  }
  const invalidRoute = parsed.data.routes.find((route) => {
    if (route.sourceDocumentIds.length > 0) return false;
    return !(route.id === "news" && route.slug === "/news" && !hasCompanyNews);
  });
  if (invalidRoute) {
    return {
      ready: false,
      reason: "source_contract_mismatch",
      routeId: invalidRoute.id,
    };
  }

  return { ready: true, brief: parsed.data };
}

function mergeCustomerBriefMessage(brief: SiteBrief, text: string): SiteBrief {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const nextContacts = [...brief.contacts];
  const addContact = (
    kind: SiteBrief["contacts"][number]["kind"],
    value: string,
  ) => {
    const compact = compactKnowledgeText(value, 512);
    if (
      compact &&
      !nextContacts.some(
        (item) =>
          item.kind === kind &&
          item.value.toLowerCase() === compact.toLowerCase(),
      )
    ) {
      // A value explicitly supplied in the authenticated customer conversation
      // is customer-confirmed input. It is not attributed to a snapshot document.
      nextContacts.push({ kind, value: compact, sourceDocumentIds: [] });
    }
  };
  for (const email of normalized.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
  ) ?? []) {
    addContact("email", email);
  }
  for (const phone of normalized.match(
    /(?:\+?86[-\s]?)?(?:1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})/gu,
  ) ?? []) {
    addContact("phone", phone);
  }
  const address = normalized.match(
    /(?:办公地址|联系地址|公司地址|地址)\s*[:：]\s*([^\n]{4,200})/u,
  )?.[1];
  if (address) addContact("address", address);

  const audienceValue = normalized.match(
    /(?:目标受众|核心受众|受众|面向)\s*[:：]\s*([^\n]{2,500})/u,
  )?.[1];
  const conversionValue = normalized.match(
    /(?:转化目标|核心目标|建站目标)\s*[:：]\s*([^\n]{2,500})/u,
  )?.[1];
  const audience = audienceValue
    ? [compactKnowledgeText(audienceValue, 500)]
    : brief.audience;
  const conversionGoal = compactKnowledgeText(
    conversionValue || normalized,
    500,
  );
  const hasNewContact = nextContacts.length > brief.contacts.length;

  return siteBriefSchema.parse({
    ...brief,
    contacts: nextContacts.slice(0, 20),
    audience,
    conversionGoal: conversionGoal || brief.conversionGoal,
    unknowns: brief.unknowns.filter((item) => {
      if (audienceValue && item.includes("目标受众")) return false;
      if (conversionValue && item.includes("转化")) return false;
      if (hasNewContact && item.includes("联系方式")) return false;
      return true;
    }),
  });
}

export function hashSiteOpsRequest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

const publicVisualFamilySchema = z.enum([
  "floating_orbit",
  "split_media",
  "editorial",
  "bento",
  "feature_grid",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "full_bleed_statement",
]);

function publicVisualMetadata(value: unknown) {
  const metadata =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const visualFamily = publicVisualFamilySchema.safeParse(metadata.heroFamily);
  const staticTemplate =
    metadata.renderer === "frontmind_static_template_catalog_v1";
  const executionAdmission =
    staticTemplateExecutionAdmissionEvidenceSchema.safeParse(
      metadata.executionAdmission,
    );
  const staticTemplateMetadata = staticTemplate
    ? staticTemplateSelectionMetadataSchema.safeParse(metadata)
    : null;
  const executionAdmissionBound =
    staticTemplateMetadata?.success === true &&
    executionAdmission.success &&
    executionAdmission.data.status === "admitted" &&
    executionAdmission.data.normalizedSourceSha256 ===
      metadata.sourceArchiveSha256 &&
    executionAdmission.data.runtimeContractSha256 ===
      NATIVE_RUNTIME_CONTRACT_V1_SHA256 &&
    executionAdmission.data.executionShellSha256 ===
      NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256;
  return {
    providerTitle:
      typeof metadata.title === "string" ? metadata.title.trim() : "",
    visualFamily: visualFamily.success ? visualFamily.data : null,
    executionAdmitted: !staticTemplate || executionAdmissionBound,
    executionUnavailableReason:
      staticTemplate &&
      executionAdmission.success &&
      executionAdmission.data.status === "unavailable"
        ? executionAdmission.data.reason
        : staticTemplate && !executionAdmissionBound
          ? "该模板尚未完成 FrontMind 执行准入，当前不可选择。"
          : null,
  };
}

const nativeTemplateSelectionMetadataSchema = z
  .object({
    schemaVersion: z.literal(6),
    renderer: z.literal("twenty_first_native_template_v1"),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z.string().trim().min(1).max(191),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    framework: z.enum(["vite_react", "next_static"]),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceDirectory: z.literal("source"),
    entrypoint: z.string().trim().min(1).max(240),
    workflowVersion: z
      .enum([
        SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
        SITEOPS_MATERIALIZER_V2_7.frontMindVersion,
      ])
      .optional(),
  })
  .passthrough();

export const staticTemplateSelectionMetadataSchema = z
  .object({
    schemaVersion: z.literal(7),
    renderer: z.literal("frontmind_static_template_catalog_v1"),
    workflowVersion: z.enum(["2.8.0", "2.9.0"]),
    catalogVersion: z.string().trim().min(1).max(191),
    catalogPosition: z.number().int().min(1).max(32),
    catalogCandidateId: z.string().trim().min(1).max(191),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z.string().trim().min(1).max(191),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    sourceOwner: z.string().trim().min(1).max(191),
    sourceRepo: z.string().trim().min(1).max(191),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceSubdirectory: z.string().trim().min(1).max(1_024).nullable(),
    sourceLicense: z.enum(["MIT", "Apache-2.0"]),
    sourceAssetId: z.string().trim().min(1).max(512),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceArchiveBytes: z
      .number()
      .int()
      .positive()
      .max(192 * 1024 * 1024),
    previewAssetId: z.string().trim().min(1).max(512),
    previewLocalAssetId: z.string().uuid().optional(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    previewMimeType: z.enum([
      "image/avif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
    previewWidth: z.number().int().positive().max(50_000),
    previewHeight: z.number().int().positive().max(50_000),
    executionAdmission:
      staticTemplateExecutionAdmissionEvidenceSchema.optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (
      value.executionAdmission?.status === "admitted" &&
      value.executionAdmission.normalizedSourceSha256 !==
        value.sourceArchiveSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceArchiveSha256"],
        message: "Static Template execution source is not admission-bound",
      });
    }
    if (
      value.executionAdmission?.status === "admitted" &&
      value.executionAdmission.runtimeContractSha256 !==
        NATIVE_RUNTIME_CONTRACT_V1_SHA256
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionAdmission", "runtimeContractSha256"],
        message: "Static Template runtime contract is not admission-bound",
      });
    }
    if (
      value.executionAdmission?.status === "admitted" &&
      value.executionAdmission.executionShellSha256 !==
        NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionAdmission", "executionShellSha256"],
        message: "Static Template execution shell is not admission-bound",
      });
    }
    if (
      value.executionAdmission?.status === "admitted" &&
      value.executionAdmission.admissionEvidenceSha256 !==
        staticTemplateAdmissionEvidenceSha256({
          catalogVersion: value.catalogVersion,
          candidateId: value.catalogCandidateId,
          rawSourceSha256: value.executionAdmission.rawSourceSha256,
          normalizedSourceSha256:
            value.executionAdmission.normalizedSourceSha256,
          sourceTreeSha256: value.executionAdmission.sourceTreeSha256,
          runtimeContractSha256: value.executionAdmission.runtimeContractSha256,
          executionShellSha256: value.executionAdmission.executionShellSha256,
          deliveryContractSha256:
            value.executionAdmission.deliveryContractSha256,
          distSha256: value.executionAdmission.distSha256,
          qaSha256: value.executionAdmission.qaSha256,
          browserReceiptSha256: value.executionAdmission.browserReceiptSha256,
          qaStatus: value.executionAdmission.qaStatus,
        })
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionAdmission", "admissionEvidenceSha256"],
        message: "Static Template admission evidence digest is not bound",
      });
    }
  });

export function isNativeVisualSelectionMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.schemaVersion === 5 &&
      record.renderer === "twenty_first_native_react_v1") ||
    nativeTemplateSelectionMetadataSchema.safeParse(record).success ||
    staticTemplateSelectionMetadataSchema.safeParse(record).success
  );
}

export function siteOpsWorkflowForVisualSelectionMetadata(value: unknown) {
  const staticTemplate = staticTemplateSelectionMetadataSchema.safeParse(value);
  if (staticTemplate.success) {
    return staticTemplate.data.workflowVersion ===
      SITEOPS_MATERIALIZER_V2_9.frontMindVersion
      ? SITEOPS_MATERIALIZER_V2_9
      : SITEOPS_MATERIALIZER_V2_8;
  }
  const nativeTemplate = nativeTemplateSelectionMetadataSchema.safeParse(value);
  if (nativeTemplate.success) {
    // V6 existed before workflow 2.7. Historical rows intentionally have no
    // workflowVersion and must retain their original 2.5 Native semantics.
    return nativeTemplate.data.workflowVersion ===
      SITEOPS_MATERIALIZER_V2_7.frontMindVersion
      ? SITEOPS_MATERIALIZER_V2_7
      : SITEOPS_MATERIALIZER_V2_5;
  }
  if (isNativeVisualSelectionMetadata(value)) {
    return SITEOPS_MATERIALIZER_V2_5;
  }
  return SITEOPS_MATERIALIZER_V2_6;
}

export function freezeSiteOpsReferenceBlueprint(input: {
  sampleId: string;
  previewLocalAssetId?: string | null;
  note: string | null;
  sourceMetadata: unknown;
}) {
  const metadata =
    input.sourceMetadata &&
    typeof input.sourceMetadata === "object" &&
    !Array.isArray(input.sourceMetadata)
      ? (input.sourceMetadata as Record<string, unknown>)
      : {};
  const evidence = visualEvidenceV1Schema.safeParse(metadata.visualEvidence);
  const frozenV4 = referenceBlueprintV4Schema.safeParse(
    metadata.referenceBlueprint,
  );
  const frozenV3 = referenceBlueprintV3Schema.safeParse(
    metadata.referenceBlueprint,
  );
  const heroEligibility = z
    .object({
      eligible: z.literal(true),
      variant: z.enum([
        "centered_statement",
        "split_media",
        "editorial_modular",
        "immersive_visual",
      ]),
    })
    .passthrough()
    .safeParse(metadata.heroEligibility);
  const evidenceIsValid =
    evidence.success &&
    metadata.providerItemKey === evidence.data.providerItemKey &&
    createVisualEvidenceV1({
      evidenceKind: evidence.data.evidenceKind,
      providerItemKey: evidence.data.providerItemKey,
      metadataSha256: evidence.data.metadataSha256,
      providerResponseSha256: evidence.data.providerResponseSha256,
      previewSha256: evidence.data.previewSha256,
      taxonomyDerivationVersion: evidence.data.taxonomyDerivationVersion,
    }).evidenceSha256 === evidence.data.evidenceSha256;
  const metadataRealizationPreviewLocalAssetId = z
    .string()
    .uuid()
    .safeParse(metadata.realizationPreviewLocalAssetId);
  const metadataRealizationPreviewSha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .safeParse(metadata.realizationPreviewSha256);
  if (
    frozenV4.success &&
    evidence.success &&
    evidenceIsValid &&
    metadataRealizationPreviewLocalAssetId.success &&
    metadataRealizationPreviewSha256.success &&
    frozenV4.data.candidateId === input.sampleId &&
    frozenV4.data.providerItemKey === evidence.data.providerItemKey &&
    frozenV4.data.referencePreviewSha256 === evidence.data.previewSha256 &&
    (!input.previewLocalAssetId ||
      frozenV4.data.referencePreviewLocalAssetId ===
        input.previewLocalAssetId) &&
    frozenV4.data.previewLocalAssetId ===
      metadataRealizationPreviewLocalAssetId.data &&
    frozenV4.data.previewSha256 === metadataRealizationPreviewSha256.data
  ) {
    return frozenV4.data;
  }
  if (
    metadata.referenceBlueprint &&
    typeof metadata.referenceBlueprint === "object" &&
    !Array.isArray(metadata.referenceBlueprint) &&
    (metadata.referenceBlueprint as Record<string, unknown>).schemaVersion === 4
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选视觉方案已失效，请重新生成视觉候选后选择。",
      409,
    );
  }
  if (
    frozenV3.success &&
    evidence.success &&
    evidenceIsValid &&
    frozenV3.data.candidateId === input.sampleId &&
    frozenV3.data.providerItemKey === evidence.data.providerItemKey &&
    frozenV3.data.previewSha256 === evidence.data.previewSha256 &&
    (!input.previewLocalAssetId ||
      frozenV3.data.previewLocalAssetId === input.previewLocalAssetId)
  ) {
    return frozenV3.data;
  }
  if (!evidence.success || !heroEligibility.success || !evidenceIsValid) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选视觉方案已失效，请重新生成视觉候选后选择。",
      409,
    );
  }
  return referenceBlueprintForVisualCandidate({
    candidateId: input.sampleId,
    providerItemKey: evidence.data.providerItemKey,
    previewSha256: evidence.data.previewSha256,
    title: typeof metadata.title === "string" ? metadata.title : input.note,
    sourceUrl:
      typeof metadata.sourceUrl === "string" ? metadata.sourceUrl : null,
    heroEligibility: heroEligibility.data,
  });
}

export function referenceBlueprintForSiteOpsRevision(input: {
  parentWorkflowVersion: string;
  parentOperationInput: unknown;
  derivedReferenceBlueprint: ReferenceBlueprint;
}) {
  const operationInput =
    input.parentOperationInput &&
    typeof input.parentOperationInput === "object" &&
    !Array.isArray(input.parentOperationInput)
      ? (input.parentOperationInput as Record<string, unknown>)
      : null;
  const inherited = referenceBlueprintSchema.safeParse(
    operationInput?.referenceBlueprint,
  );
  const inheritedMatches =
    inherited.success &&
    inherited.data.candidateId ===
      input.derivedReferenceBlueprint.candidateId &&
    inherited.data.providerItemKey ===
      input.derivedReferenceBlueprint.providerItemKey &&
    inherited.data.previewSha256 ===
      input.derivedReferenceBlueprint.previewSha256 &&
    (inherited.data.schemaVersion !== 4 ||
      (input.derivedReferenceBlueprint.schemaVersion === 4 &&
        inherited.data.referencePreviewLocalAssetId ===
          input.derivedReferenceBlueprint.referencePreviewLocalAssetId &&
        inherited.data.referencePreviewSha256 ===
          input.derivedReferenceBlueprint.referencePreviewSha256 &&
        inherited.data.inspirationTaxonomySha256 ===
          input.derivedReferenceBlueprint.inspirationTaxonomySha256 &&
        inherited.data.styleSignature ===
          input.derivedReferenceBlueprint.styleSignature));
  if (input.parentWorkflowVersion.startsWith("2.") && !inheritedMatches) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前官网版本的冻结视觉构图合同不完整，不能静默改变视觉方向。",
      409,
    );
  }
  // A 2.x child inherits the exact immutable Blueprint, rather than running
  // its selection back through a mapping algorithm that may have evolved.
  // Legacy Astro parents have no Blueprint and are upgraded once from their
  // frozen selected visual evidence.
  return inherited.success && inheritedMatches
    ? inherited.data
    : input.derivedReferenceBlueprint;
}

async function appendMessage(
  tx: any,
  input: {
    conversationId: string;
    userId: number;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    turnId?: string | null;
    siteOps?: Record<string, unknown>;
  },
) {
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, input.conversationId));
  const sequence = Number(sequenceRows[0]?.sequence ?? 0) + 1;
  const id = randomUUID();
  await tx.insert(messages).values({
    id,
    conversationId: input.conversationId,
    turnId: input.turnId ?? null,
    userId: input.userId,
    role: input.role,
    content: input.content,
    sequence,
    metadata: input.siteOps ? { siteOps: input.siteOps } : {},
  });
  return { id, sequence };
}

async function loadOwnedProject(
  executor: any,
  userId: number,
  conversationId?: string,
  lock = false,
) {
  let query = executor
    .select()
    .from(siteProjects)
    .where(
      conversationId
        ? and(
            eq(siteProjects.userId, userId),
            eq(siteProjects.conversationId, conversationId),
          )
        : eq(siteProjects.userId, userId),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const rows = await query;
  return rows[0] ?? null;
}

export function projectStaticTemplateCatalogVisualReadiness(
  catalog: {
    workflowVersion: string;
    catalogVersion: string;
    pageSize: number;
    pageCount: number;
    entries: readonly {
      candidateId: string;
      executionAdmission: { status: "admitted" | "unavailable" };
    }[];
  } | null,
) {
  const requiredAdmissionReady = catalog?.entries.some(
    (entry) =>
      entry.candidateId === "static-template-22-hirael-agency-landing" &&
      entry.executionAdmission.status === "admitted",
  );
  const ready =
    isStaticCatalogWorkflowVersion(catalog?.workflowVersion ?? null) &&
    catalog?.catalogVersion === STATIC_TEMPLATE_CATALOG_VERSION &&
    catalog?.pageSize === STATIC_TEMPLATE_CATALOG_PAGE_SIZE &&
    catalog?.pageCount === STATIC_TEMPLATE_CATALOG_PAGE_COUNT &&
    requiredAdmissionReady;
  return {
    status: ready ? ("configured" as const) : ("not_configured" as const),
    reason: ready ? undefined : "固定 Template 目录尚未就绪，请联系 FrontMind",
  };
}

async function loadServiceReadiness(
  executor: any,
  input: { projectId: string; userId: number },
) {
  // Readiness is part of the larger observation projection. Keep these three
  // small lookups sequential so the outer four-query wave remains the actual
  // upper bound on database work for one observation.
  const platformCredentials = await executor
    .select({ slot: presalesApiCredentials.slot })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, "siteops_aliyun_oauth"),
        eq(presalesApiCredentials.status, "active"),
        eq(presalesApiCredentials.validationStatus, "verified"),
      ),
    );
  const aiBuilderCredentials = await executor
    .select({ id: apiCredentials.id })
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.userId, input.userId),
        eq(apiCredentials.status, "active"),
        eq(apiCredentials.validationStatus, "verified"),
        isNotNull(apiCredentials.verifiedAt),
        isNull(apiCredentials.deletedAt),
      ),
    )
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const connections = await executor
    .select({ status: siteProviderConnections.status })
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.projectId, input.projectId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
      ),
    )
    .limit(1);
  const hasAliyunOAuthCredential = platformCredentials.some(
    (row: { slot: string }) => row.slot === "siteops_aliyun_oauth",
  );
  let staticTemplateCatalog: Awaited<
    ReturnType<typeof loadActiveStaticTemplateCatalog>
  > = null;
  try {
    staticTemplateCatalog = await loadActiveStaticTemplateCatalog();
  } catch {
    staticTemplateCatalog = null;
  }
  const hasAiBuilderCredential = aiBuilderCredentials.length > 0;
  const aliyunFeatureEnabled =
    process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() === "1";
  const aliyunConnectionReady = connections[0]?.status === "active";
  const aliyunReady =
    aliyunFeatureEnabled && hasAliyunOAuthCredential && aliyunConnectionReady;
  const esa = inspectEsaRuntimeConfiguration({
    providerRegistered: siteOpsProviderConfigured("aliyun_esa"),
  });
  return {
    visuals: projectStaticTemplateCatalogVisualReadiness(staticTemplateCatalog),
    website: {
      status: hasAiBuilderCredential
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: hasAiBuilderCredential
        ? undefined
        : "AI 建站服务尚未就绪，请联系 FrontMind",
    },
    publishing: {
      status: esa.configured
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: esa.configured
        ? undefined
        : sanitizeFrontMindPublicText(esa.reason),
    },
    domain: {
      status: aliyunReady
        ? ("configured" as const)
        : ("not_configured" as const),
      reason: aliyunReady
        ? undefined
        : !aliyunFeatureEnabled
          ? "域名与发布服务尚未启用"
          : !hasAliyunOAuthCredential
            ? "域名与发布平台尚未配置完成"
            : "请先完成阿里云账号授权",
    },
  };
}

function requireEsaRuntimeConfigured() {
  const configuration = inspectEsaRuntimeConfiguration({
    providerRegistered: siteOpsProviderConfigured("aliyun_esa"),
  });
  if (!configuration.configured) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "发布服务尚未配置完成，请联系 FrontMind。",
      412,
    );
  }
}

const SITEOPS_EXECUTION_STAGE_LABELS = {
  visual_searching: "视觉候选搜索",
  preparing: "项目准备",
  design_compiling: "设计合同生成",
  content_building: "页面内容生成",
  qa_running: "质量校验",
  completed: "完成",
} as const;

type SiteOpsExecutionStage = keyof typeof SITEOPS_EXECUTION_STAGE_LABELS;

function publicExecutionStage(value: unknown): SiteOpsExecutionStage | null {
  if (value === "contract_ready" || value === "building") {
    return "content_building";
  }
  return [
    "visual_searching",
    "preparing",
    "design_compiling",
    "content_building",
    "qa_running",
    "completed",
  ].includes(String(value))
    ? (value as SiteOpsExecutionStage)
    : null;
}

function publicExecutionStatus(status: string) {
  if (status === "queued") return "queued" as const;
  if (status === "running" || status === "outcome_unknown") {
    return "running" as const;
  }
  if (status === "succeeded") return "succeeded" as const;
  if (status === "failed") return "failed" as const;
  if (status === "cancelled") return "cancelled" as const;
  return "attention_required" as const;
}

const ACTIVE_VISUAL_OPERATION_STATUSES = new Set([
  "queued",
  "running",
  "outcome_unknown",
]);

const TERMINAL_VISUAL_OPERATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "attention_required",
  "cancelled",
]);

type VisualOperationProjectionRow = {
  id?: string;
  status: string;
  input?: unknown;
  result?: unknown;
  errorCode?: string | null;
  createdAt?: Date | string | number | null;
  updatedAt?: Date | string | number | null;
  startedAt?: Date | string | number | null;
  completedAt?: Date | string | number | null;
};

function visualOperationAdmissionRevision(row: VisualOperationProjectionRow) {
  const parsed = visualSearchOperationInputSchema.safeParse(row.input);
  return parsed.success && "schemaVersion" in parsed.data
    ? parsed.data.admissionRevision
    : -1;
}

function visualOperationTimestamp(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** MySQL timestamps are second-precision in the current schema. Admission
 * revision is the monotonic visual-operation coordinate and therefore wins
 * before timestamps when a fast failure is retried in the same second. */
export function compareSiteOpsVisualOperationsNewestFirst(
  left: VisualOperationProjectionRow,
  right: VisualOperationProjectionRow,
) {
  const admissionDelta =
    visualOperationAdmissionRevision(right) -
    visualOperationAdmissionRevision(left);
  if (admissionDelta !== 0) return admissionDelta;
  for (const field of [
    "updatedAt",
    "completedAt",
    "startedAt",
    "createdAt",
  ] as const) {
    const delta =
      visualOperationTimestamp(right[field]) -
      visualOperationTimestamp(left[field]);
    if (delta !== 0) return delta;
  }
  return String(right.id ?? "").localeCompare(String(left.id ?? ""));
}

const VISUAL_FAILURE_CATEGORY_BY_ERROR_CODE: Readonly<
  Record<string, SiteOpsVisualFailureCategory>
> = {
  NATIVE_SOURCE_QUOTA_UNAVAILABLE: "provider_quota",
  NATIVE_SOURCE_CONTRACT_UNAVAILABLE: "get_component_contract",
  MCP_GET_COMPONENT_REQUIRED: "get_component_contract",
  MCP_CONTRACT_INCOMPATIBLE: "get_component_contract",
  NATIVE_SOURCE_CANDIDATES_UNAVAILABLE: "source_incomplete",
  NATIVE_SOURCE_CANDIDATE_PAGE_INCOMPLETE: "source_incomplete",
  NATIVE_SOURCE_DEPENDENCIES_UNAVAILABLE: "dependency_unsupported",
  NATIVE_SOURCE_UNSAFE: "source_unsafe",
  NATIVE_SOURCE_COMPILE_UNAVAILABLE: "compile_failed",
  NATIVE_SOURCE_BROWSER_UNAVAILABLE: "browser_unavailable",
  NATIVE_SOURCE_RENDER_UNAVAILABLE: "render_failed",
  NATIVE_TEMPLATE_CATALOG_UNAVAILABLE: "catalog_unavailable",
  NATIVE_TEMPLATE_ENTITLEMENT_REQUIRED: "entitlement_required",
  NATIVE_TEMPLATE_DOWNLOAD_UNAVAILABLE: "download_failed",
  NATIVE_TEMPLATE_DEPENDENCIES_UNAVAILABLE: "dependency_unsupported",
  NATIVE_TEMPLATE_COMPILE_UNAVAILABLE: "compile_failed",
  NATIVE_TEMPLATE_BROWSER_UNAVAILABLE: "browser_unavailable",
  NATIVE_TEMPLATE_RENDER_UNAVAILABLE: "render_failed",
  NATIVE_TEMPLATE_BUILD_POOL_INSUFFICIENT: "insufficient_live_templates",
  VISUAL_BOARD_PERSISTENCE_FAILED: "persistence_failed",
  VISUAL_SEARCH_DEADLINE_EXHAUSTED: "deadline_exhausted",
  VISUAL_SEARCH_TIMEOUT: "deadline_exhausted",
};

function projectNativeVisualFailureCategory(
  operation: VisualOperationProjectionRow | null | undefined,
) {
  const result =
    operation?.result &&
    typeof operation.result === "object" &&
    !Array.isArray(operation.result)
      ? (operation.result as Record<string, unknown>)
      : null;
  const recorded = siteOpsVisualFailureCategorySchema.safeParse(
    result?.templateFailureCategory,
  );
  if (recorded.success) return recorded.data;
  if (!operation?.errorCode) return null;
  if (operation.errorCode === "STATIC_TEMPLATE_CATALOG_OPERATION_INVALID") {
    return null;
  }
  if (operation.errorCode.startsWith("STATIC_TEMPLATE_CATALOG_")) {
    return "catalog_unavailable";
  }
  if (operation.errorCode.startsWith("STATIC_TEMPLATE_")) {
    return "persistence_failed";
  }
  return VISUAL_FAILURE_CATEGORY_BY_ERROR_CODE[operation.errorCode] ?? null;
}

function projectedVisualTargetPage(
  operation: VisualOperationProjectionRow | null | undefined,
  generatedPages: number,
): 1 | 2 | 3 | null {
  if (!operation) return null;
  const parsed = visualSearchOperationInputSchema.safeParse(operation.input);
  if (parsed.success && "schemaVersion" in parsed.data) {
    return parsed.data.page;
  }
  return Math.max(
    1,
    Math.min(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES, generatedPages + 1),
  ) as 1 | 2 | 3;
}

export function siteOpsVisualSelectionRecovery(input: {
  projectStatus: string;
  completePublishedPages: number;
  latestVisualOperationStatus: string | null;
  hasActiveVisualOperation: boolean;
  hasActiveBuild: boolean;
  hasBuildAttempt: boolean;
}) {
  return (
    ["visual_searching", "failed", "attention_required"].includes(
      input.projectStatus,
    ) &&
    input.completePublishedPages > 0 &&
    Boolean(
      input.latestVisualOperationStatus &&
        TERMINAL_VISUAL_OPERATION_STATUSES.has(
          input.latestVisualOperationStatus,
        ),
    ) &&
    !input.hasActiveVisualOperation &&
    !input.hasActiveBuild &&
    !input.hasBuildAttempt
  );
}

export function completePublishedVisualPageCount(input: {
  batches: Array<{ id: string; status: string }>;
  candidates: Array<{ batchId: string }>;
  pageSize?: 8 | 9;
  visibleStatuses?: readonly string[];
}) {
  const candidateCountByBatch = new Map<string, number>();
  for (const candidate of input.candidates) {
    candidateCountByBatch.set(
      candidate.batchId,
      (candidateCountByBatch.get(candidate.batchId) ?? 0) + 1,
    );
  }
  return input.batches.filter(
    (batch) =>
      (input.visibleStatuses ?? ["published"]).includes(batch.status) &&
      candidateCountByBatch.get(batch.id) ===
        (input.pageSize ?? SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE),
  ).length;
}

export function resolveVisualCatalogObservationCoordinates(input: {
  frozenVisualInput: Record<string, unknown> | null;
  hasAnyVisualOperation: boolean;
  visibleBatchCount: number;
}) {
  const pristineVisualCycle =
    !input.hasAnyVisualOperation && input.visibleBatchCount === 0;
  const workflowVersion =
    typeof input.frozenVisualInput?.workflowVersion === "string"
      ? input.frozenVisualInput.workflowVersion
      : pristineVisualCycle
        ? SITEOPS_DEFAULT_WORKFLOW.frontMindVersion
        : null;
  const catalogVersion =
    typeof input.frozenVisualInput?.catalogVersion === "string"
      ? input.frozenVisualInput.catalogVersion
      : pristineVisualCycle
        ? STATIC_TEMPLATE_CATALOG_VERSION
        : null;
  const staticCatalogVisualCycle =
    isStaticCatalogWorkflowVersion(workflowVersion);
  return {
    pristineVisualCycle,
    workflowVersion,
    catalogVersion,
    staticCatalogVisualCycle,
    pageSize: staticCatalogVisualCycle
      ? STATIC_TEMPLATE_CATALOG_PAGE_SIZE
      : SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
    pageCount: staticCatalogVisualCycle
      ? STATIC_TEMPLATE_CATALOG_PAGE_COUNT
      : SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
    defaultAvailability: pristineVisualCycle
      ? {
          availablePages: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
          reservedPages: 0,
        }
      : null,
  } as const;
}

export function projectSiteOpsVisualGeneration(input: {
  projectStatus: string;
  generatedPages: number;
  availablePages?: number | null;
  reservedPages?: number | null;
  latestVisualOperation?: VisualOperationProjectionRow | null;
  hasActiveVisualOperation: boolean;
  hasActiveBuild: boolean;
  hasBuildAttempt: boolean;
  workflowVersion?: string | null;
  catalogVersion?: string | null;
  pageSize?: 8 | 9;
  pageCount?: 3 | 4;
}) {
  const staticCatalogMode = isStaticCatalogWorkflowVersion(
    input.workflowVersion ?? null,
  );
  const maxPages = staticCatalogMode
    ? STATIC_TEMPLATE_CATALOG_PAGE_COUNT
    : SITEOPS_VISUAL_CANDIDATE_MAX_PAGES;
  const hasFrozenAvailability = Number.isInteger(input.availablePages);
  const availablePages = hasFrozenAvailability
    ? Math.max(
        input.generatedPages,
        Math.min(maxPages, Number(input.availablePages)),
      )
    : input.generatedPages;
  const reservedPages = Math.max(
    0,
    Math.min(
      availablePages - input.generatedPages,
      hasFrozenAvailability && Number.isInteger(input.reservedPages)
        ? Number(input.reservedPages)
        : 0,
    ),
  );
  const latestStatus = input.latestVisualOperation?.status ?? null;
  const recoveredSelection = siteOpsVisualSelectionRecovery({
    projectStatus: input.projectStatus,
    completePublishedPages: input.generatedPages,
    latestVisualOperationStatus: latestStatus,
    hasActiveVisualOperation: input.hasActiveVisualOperation,
    hasActiveBuild: input.hasActiveBuild,
    hasBuildAttempt: input.hasBuildAttempt,
  });
  const selectableStatus =
    input.projectStatus === "awaiting_visual_selection" || recoveredSelection;
  const canSelectExisting =
    input.generatedPages > 0 &&
    selectableStatus &&
    !input.hasActiveVisualOperation &&
    !input.hasActiveBuild;
  const terminalRetryableFailure =
    (latestStatus === "failed" || latestStatus === "attention_required") &&
    !input.hasActiveVisualOperation &&
    !input.hasActiveBuild &&
    !input.hasBuildAttempt;
  const retryableInitialFailure =
    input.generatedPages === 0 &&
    terminalRetryableFailure &&
    ["visual_searching", "failed", "attention_required"].includes(
      input.projectStatus,
    );
  const retryableSupplementalFailure =
    canSelectExisting && terminalRetryableFailure;
  const retryableError =
    retryableInitialFailure || retryableSupplementalFailure;
  return {
    status: input.hasActiveVisualOperation
      ? ("generating" as const)
      : retryableError
        ? ("retryable_error" as const)
        : ("idle" as const),
    targetPage: input.hasActiveVisualOperation
      ? projectedVisualTargetPage(
          input.latestVisualOperation,
          input.generatedPages,
        )
      : null,
    generatedPages: input.generatedPages,
    availablePages,
    reservedPages,
    maxPages,
    ...(input.workflowVersion
      ? { workflowVersion: input.workflowVersion }
      : {}),
    ...(input.catalogVersion ? { catalogVersion: input.catalogVersion } : {}),
    ...(input.pageSize ? { pageSize: input.pageSize } : {}),
    ...(input.pageCount ? { pageCount: input.pageCount } : {}),
    canGenerateMore:
      !staticCatalogMode &&
      (canSelectExisting || retryableInitialFailure) &&
      (hasFrozenAvailability
        ? input.generatedPages < availablePages
        : input.generatedPages < maxPages),
    canSelectExisting,
    retryAction: retryableError
      ? input.generatedPages === 0
        ? ("start" as const)
        : ("supplemental" as const)
      : null,
    failureCategory: retryableError
      ? projectNativeVisualFailureCategory(input.latestVisualOperation)
      : null,
    recoveredSelection,
  } as const;
}

export function projectSiteOpsObservationStatuses(input: {
  projectStatus: string;
  recoveredSelection: boolean;
}) {
  const projectStatus = input.recoveredSelection
    ? ("awaiting_visual_selection" as const)
    : input.projectStatus;
  return {
    projectStatus,
    interactionState:
      projectStatus === "draft" ? ("select_snapshot" as const) : projectStatus,
  };
}

export function projectSiteOpsExecutionSteps(input: {
  operations: Array<{
    id: string;
    buildId: string | null;
    kind: string;
    status: string;
    result?: Record<string, unknown> | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
  }>;
  timelineMessages: Array<{
    id: string;
    metadata: unknown;
    sentAt: Date;
  }>;
}): SiteOpsExecutionStep[] {
  const events = input.timelineMessages.flatMap((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const siteOps = (metadata.siteOps ?? {}) as Record<string, unknown>;
    const payload = (siteOps.payload ?? {}) as Record<string, unknown>;
    const stage = publicExecutionStage(payload.stage);
    return stage && typeof siteOps.subjectId === "string"
      ? [
          {
            id: row.id,
            operationId: siteOps.subjectId,
            buildId:
              typeof payload.buildId === "string" ? payload.buildId : null,
            stage,
            startedAt:
              typeof payload.occurredAt === "string" &&
              Number.isFinite(Date.parse(payload.occurredAt))
                ? new Date(payload.occurredAt)
                : row.sentAt,
          },
        ]
      : [];
  });
  return input.operations.flatMap((operation) => {
    if (
      !["visual_search", "site_build", "build_revision", "deploy"].includes(
        operation.kind,
      )
    ) {
      return [];
    }
    const operationKind = operation.kind as
      | "visual_search"
      | "site_build"
      | "build_revision"
      | "deploy";
    const fallbackMarker = siteOpsTrustedFallbackPreviewFromResult(
      operation.result,
    );
    const trustedFallback =
      fallbackMarker?.status === "bound" ? fallbackMarker : null;
    const fallbackCompletedAt = trustedFallback
      ? new Date(trustedFallback.createdAt)
      : null;
    const timelineCompletedAt = operation.completedAt ?? fallbackCompletedAt;
    const timelineStatus = trustedFallback ? "succeeded" : operation.status;
    if (operationKind === "visual_search") {
      const startedAt = operation.startedAt ?? operation.createdAt;
      return [
        {
          id: `${operation.id}:visual_searching`,
          operationKind,
          buildId: null,
          stage: "visual_searching" as const,
          label: SITEOPS_EXECUTION_STAGE_LABELS.visual_searching,
          status: publicExecutionStatus(timelineStatus),
          startedAt: startedAt.toISOString(),
          completedAt: timelineCompletedAt?.toISOString() ?? null,
        },
      ];
    }
    if (operationKind === "deploy") return [];
    const operationEvents = events
      .filter((item) => item.operationId === operation.id)
      .sort(
        (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
      );
    if (operationEvents.length === 0) {
      const startedAt = operation.startedAt ?? operation.createdAt;
      return [
        {
          id: `${operation.id}:legacy-total`,
          operationKind,
          buildId: operation.buildId,
          stage:
            timelineStatus === "succeeded"
              ? ("completed" as const)
              : ("preparing" as const),
          label: trustedFallback
            ? "官网基础预览"
            : timelineStatus === "succeeded"
              ? "官网制作"
              : "官网制作中",
          status: publicExecutionStatus(timelineStatus),
          startedAt: startedAt.toISOString(),
          completedAt: timelineCompletedAt?.toISOString() ?? null,
        },
      ];
    }
    const byStage = new Map<SiteOpsExecutionStage, (typeof events)[number]>();
    for (const event of operationEvents) {
      if (!byStage.has(event.stage)) byStage.set(event.stage, event);
    }
    if (!byStage.has("preparing")) {
      byStage.set("preparing", {
        id: `${operation.id}:preparing:fallback`,
        operationId: operation.id,
        buildId: operation.buildId,
        stage: "preparing",
        startedAt: operation.startedAt ?? operation.createdAt,
      });
    }
    const ordered = [
      "preparing",
      "design_compiling",
      "content_building",
      "qa_running",
    ].flatMap((stage) => {
      const event = byStage.get(stage as SiteOpsExecutionStage);
      return event ? [event] : [];
    });
    const projected: SiteOpsExecutionStep[] = ordered.map((event, index) => {
      const next = ordered[index + 1];
      const completedAt =
        next?.startedAt ??
        (timelineCompletedAt && timelineStatus !== "running"
          ? timelineCompletedAt
          : null);
      return {
        id: `${operation.id}:${event.stage}`,
        operationKind,
        buildId: operation.buildId,
        stage: event.stage,
        label: SITEOPS_EXECUTION_STAGE_LABELS[event.stage],
        status: next
          ? ("succeeded" as const)
          : publicExecutionStatus(timelineStatus),
        startedAt: event.startedAt.toISOString(),
        completedAt: completedAt?.toISOString() ?? null,
      };
    });
    if (operation.status === "succeeded" && operation.completedAt) {
      projected.push({
        id: `${operation.id}:completed`,
        operationKind,
        buildId: operation.buildId,
        stage: "completed",
        label: SITEOPS_EXECUTION_STAGE_LABELS.completed,
        status: "succeeded",
        startedAt: operation.completedAt.toISOString(),
        completedAt: operation.completedAt.toISOString(),
      });
    }
    return projected;
  });
}

export function projectSiteOpsBuildDelivery(input: {
  buildId: string;
  operations: readonly {
    buildId: string | null;
    status: string;
    kind: string;
    result?: Record<string, unknown> | null;
  }[];
}) {
  const operation = input.operations.find((candidate) => {
    if (
      candidate.buildId !== input.buildId ||
      (candidate.kind !== "site_build" && candidate.kind !== "build_revision")
    ) {
      return false;
    }
    if (candidate.status === "succeeded") return true;
    return (
      siteOpsTrustedFallbackPreviewFromResult(candidate.result)?.status ===
      "bound"
    );
  });
  const fallback = siteOpsTrustedFallbackPreviewFromResult(operation?.result);
  const rawDelivery =
    operation?.status === "succeeded"
      ? operation.result?.buildDelivery
      : fallback?.status === "bound"
        ? fallback.buildDelivery
        : null;
  const delivery =
    rawDelivery &&
    typeof rawDelivery === "object" &&
    !Array.isArray(rawDelivery)
      ? (rawDelivery as Record<string, unknown>)
      : null;
  const warningCodes = Array.isArray(delivery?.warningCodes)
    ? delivery.warningCodes.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0 && value.length <= 128,
      )
    : [];
  return delivery &&
    [
      "primary",
      "content_patch",
      "trusted_fallback",
      "twenty_first_native",
    ].includes(String(delivery.renderMode)) &&
    ["passed", "passed_with_warnings", "partial"].includes(
      String(delivery.qaStatus),
    )
    ? {
        renderMode: delivery.renderMode as
          | "primary"
          | "content_patch"
          | "trusted_fallback"
          | "twenty_first_native",
        qaStatus: delivery.qaStatus as
          | "passed"
          | "passed_with_warnings"
          | "partial",
        warningCodes: Array.from(new Set(warningCodes)).slice(0, 100),
      }
    : null;
}

const SITEOPS_BUILD_PHASE_WARNINGS = {
  source_waiting:
    "正在等待 AI 内容结果；基础预览会保留，超时后将使用企业资料中的可信默认内容。",
  source_repairing:
    "首次源码未通过安全检查，系统正在同一任务内自动修复；已选视觉参考仍会保留。",
  provider_sync_delayed:
    "AI 建站结果正在同步，系统会继续读取同一任务，不会重复创建或重复计费。",
  source_validating: "源码已返回，正在进行安全、格式和任务绑定校验。",
  compiling: "源码已通过输入校验，正在构建受控预览。",
  persisting_preview: "预览已完成构建，正在保存并绑定可展示版本。",
} as const;

type SiteOpsBuildPhase = keyof typeof SITEOPS_BUILD_PHASE_WARNINGS;

export function projectSiteOpsBuildProgress(input: {
  buildId: string;
  operations: readonly {
    buildId: string | null;
    status: string;
    kind: string;
    providerTaskId?: string | null;
    errorCode?: string | null;
    result?: Record<string, unknown> | null;
  }[];
}) {
  const operation = input.operations.find(
    (candidate) =>
      candidate.buildId === input.buildId &&
      (candidate.kind === "site_build" || candidate.kind === "build_revision"),
  );
  const result =
    operation?.result &&
    typeof operation.result === "object" &&
    !Array.isArray(operation.result)
      ? operation.result
      : null;
  if (operation?.status === "succeeded") {
    const delivery =
      result?.buildDelivery &&
      typeof result.buildDelivery === "object" &&
      !Array.isArray(result.buildDelivery)
        ? (result.buildDelivery as Record<string, unknown>)
        : null;
    const warningCodes = Array.isArray(delivery?.warningCodes)
      ? delivery.warningCodes
      : [];
    const partialContentPatch =
      delivery?.renderMode === "content_patch" &&
      warningCodes.includes(
        SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE,
      );
    return {
      buildPhase: null,
      recoverable: false,
      previewWarning: partialContentPatch
        ? "官网预览已生成，部分内容使用企业资料中的可信默认值。"
        : null,
    };
  }
  const rawPhase = String(result?.buildPhase ?? "");
  const legacyStage = String(result?.stage ?? "");
  const buildPhase = Object.prototype.hasOwnProperty.call(
    SITEOPS_BUILD_PHASE_WARNINGS,
    rawPhase,
  )
    ? (rawPhase as SiteOpsBuildPhase)
    : legacyStage === "native_repair_pending" ||
        legacyStage === "native_repair_send_unknown"
      ? ("source_repairing" as const)
      : null;
  const taskBound = Boolean(
    operation?.providerTaskId ||
      (typeof result?.taskId === "string" && result.taskId.trim()),
  );
  const fallbackBound =
    siteOpsTrustedFallbackPreviewFromResult(result)?.status === "bound";
  const fallbackStillReconciling = Boolean(
    fallbackBound &&
      operation &&
      ["queued", "running", "outcome_unknown"].includes(operation.status),
  );
  const recoverable = Boolean(
    fallbackStillReconciling ||
      (taskBound &&
        (buildPhase === "source_repairing" ||
          buildPhase === "source_waiting" ||
          buildPhase === "provider_sync_delayed" ||
          operation?.status === "attention_required" ||
          (operation?.status === "failed" &&
            operation.errorCode === "FRONTMIND_BUILD_SERVICE_UNAVAILABLE"))),
  );
  return {
    buildPhase,
    recoverable,
    previewWarning: fallbackBound
      ? operation?.status === "attention_required"
        ? "FrontMind 基础预览已保留；自动对账窗口已结束，运营可使用同一任务编号恢复结果读取，不会重新创建任务。"
        : "已生成仅使用冻结企业事实与 FrontMind 中性安全版式的基础预览；原 AI 任务仍按同一任务编号继续对账，不会重复创建或计费。"
      : buildPhase
        ? SITEOPS_BUILD_PHASE_WARNINGS[buildPhase]
        : null,
  };
}

type SiteOpsResetCycleMessageRow = {
  sentAt: Date;
  metadata?: unknown;
};

type SiteOpsResetCycleArtifactRow = {
  createdAt: Date;
  status?: string;
};

function isCompletedResetBoundaryMessage(row: SiteOpsResetCycleMessageRow) {
  if (!row.metadata || typeof row.metadata !== "object") return false;
  const siteOps = (row.metadata as Record<string, unknown>).siteOps;
  if (!siteOps || typeof siteOps !== "object" || Array.isArray(siteOps)) {
    return false;
  }
  const payload = (siteOps as Record<string, unknown>).payload;
  return Boolean(
    payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).reset === true &&
      (payload as Record<string, unknown>).unpublishCompleted === true,
  );
}

/**
 * MySQL timestamps can place rows superseded by the reset transaction on the
 * same instant as `currentTaskStartedAt`. Once a fresh-root reset succeeds,
 * only strictly newer workflow rows belong to the next customer cycle. The
 * one reset-completion message written by that transaction remains visible so
 * the customer has an explicit hand-off into the knowledge-base start action.
 */
type SiteOpsResetCycleRows = {
  successfulResetApplied: boolean;
  currentTaskStartedAt: Date;
  messageRows: SiteOpsResetCycleMessageRow[];
  timelineMessageRows: SiteOpsResetCycleMessageRow[];
  buildRows: SiteOpsResetCycleArtifactRow[];
  deploymentRows: SiteOpsResetCycleArtifactRow[];
  packageRows: SiteOpsResetCycleArtifactRow[];
  batchRows: SiteOpsResetCycleArtifactRow[];
  timelineOperationRows: SiteOpsResetCycleArtifactRow[];
};

type SiteOpsResetCycleProjectedRows<Input extends SiteOpsResetCycleRows> = Pick<
  Input,
  | "messageRows"
  | "timelineMessageRows"
  | "buildRows"
  | "deploymentRows"
  | "packageRows"
  | "batchRows"
  | "timelineOperationRows"
>;

export function projectSiteOpsCurrentResetCycle<
  Input extends SiteOpsResetCycleRows,
>(input: Input): SiteOpsResetCycleProjectedRows<Input> {
  if (!input.successfulResetApplied) {
    return {
      messageRows: input.messageRows,
      timelineMessageRows: input.timelineMessageRows,
      buildRows: input.buildRows,
      deploymentRows: input.deploymentRows,
      packageRows: input.packageRows,
      batchRows: input.batchRows,
      timelineOperationRows: input.timelineOperationRows,
    };
  }
  const boundary = input.currentTaskStartedAt.getTime();
  const newerMessage = (row: SiteOpsResetCycleMessageRow) =>
    row.sentAt.getTime() > boundary;
  const newerArtifact = (row: SiteOpsResetCycleArtifactRow) =>
    row.createdAt.getTime() > boundary;
  const currentArtifact = (row: SiteOpsResetCycleArtifactRow) =>
    newerArtifact(row) &&
    !["cancelled", "superseded"].includes(String(row.status ?? ""));
  return {
    messageRows: input.messageRows.filter(
      (row) =>
        newerMessage(row) ||
        (row.sentAt.getTime() === boundary &&
          isCompletedResetBoundaryMessage(row)),
    ),
    timelineMessageRows: input.timelineMessageRows.filter(newerMessage),
    buildRows: input.buildRows.filter(currentArtifact),
    deploymentRows: input.deploymentRows.filter(currentArtifact),
    packageRows: input.packageRows.filter(currentArtifact),
    batchRows: input.batchRows.filter(currentArtifact),
    timelineOperationRows: input.timelineOperationRows.filter(currentArtifact),
  } as SiteOpsResetCycleProjectedRows<Input>;
}

const siteOpsObservationFlights = new Map<string, Promise<unknown>>();

type SiteOpsKnowledgeSnapshotCandidate = Pick<
  typeof knowledgeBaseSnapshots.$inferSelect,
  "status" | "archiveHash"
>;

/**
 * SiteOps consumes the account's current published knowledge base. Website
 * task epochs isolate builds, revisions and local assets; they do not make an
 * otherwise active knowledge snapshot stale.
 */
export function siteOpsKnowledgeSnapshotSelectableForProject(input: {
  snapshot: SiteOpsKnowledgeSnapshotCandidate;
  project?: Pick<
    typeof siteProjects.$inferSelect,
    | "minimumKnowledgeSnapshotVersion"
    | "knowledgeInputEpochId"
    | "currentTaskStartedAt"
  >;
  provenance?: {
    freshBuildIds: ReadonlySet<string>;
    freshImportSnapshotIds: ReadonlySet<string>;
  };
}) {
  return (
    input.snapshot.status === "active" &&
    typeof input.snapshot.archiveHash === "string" &&
    /^[a-f0-9]{64}$/u.test(input.snapshot.archiveHash)
  );
}

function siteOpsKnowledgeSnapshotAvailable(
  snapshot: SiteOpsKnowledgeSnapshotCandidate,
) {
  return siteOpsKnowledgeSnapshotSelectableForProject({ snapshot });
}

export async function runSiteOpsObservationQueries(
  tasks: ReadonlyArray<() => Promise<unknown>>,
  concurrency = 4,
) {
  const width = Math.max(1, Math.min(4, Math.trunc(concurrency)));
  const results: unknown[] = [];
  for (let offset = 0; offset < tasks.length; offset += width) {
    const wave = tasks.slice(offset, offset + width);
    results.push(...(await Promise.all(wave.map((task) => task()))));
  }
  return results;
}

export function siteOpsObservationFlightKey(input: {
  userId: number;
  project: Pick<
    typeof siteProjects.$inferSelect,
    "id" | "revision" | "currentTaskStartedAt"
  >;
  afterSequence?: number;
}) {
  return [
    input.userId,
    input.project.id,
    input.project.revision,
    input.project.currentTaskStartedAt.toISOString(),
    input.afterSequence ?? "full",
  ].join(":");
}

export async function runSiteOpsObservationSingleFlight<T>(
  key: string,
  task: () => Promise<T>,
) {
  const existing = siteOpsObservationFlights.get(key);
  if (existing) return existing as Promise<T>;

  const flight = task();
  siteOpsObservationFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (siteOpsObservationFlights.get(key) === flight) {
      siteOpsObservationFlights.delete(key);
    }
  }
}

async function projectObservationOnce(
  executor: any,
  input: {
    userId: number;
    project: typeof siteProjects.$inferSelect;
    afterSequence?: number;
  },
) {
  const messagePredicate =
    input.afterSequence === undefined
      ? and(
          eq(messages.conversationId, input.project.conversationId),
          isNull(messages.deletedAt),
          gte(messages.sentAt, input.project.currentTaskStartedAt),
        )
      : and(
          eq(messages.conversationId, input.project.conversationId),
          isNull(messages.deletedAt),
          gte(messages.sentAt, input.project.currentTaskStartedAt),
          gt(messages.sequence, input.afterSequence),
        );
  const [
    rawMessageRows,
    rawTimelineMessageRows,
    rawBuildRows,
    rawDeploymentRows,
    rawPackageRows,
    serviceReadiness,
    snapshotRows,
    rawBatchRows,
    rawTimelineOperationRows,
    connectionRows,
    profileRows,
    activeAliyunOperationRows,
    currentVisualPoolRows,
    rebuildRequest,
  ] = (await runSiteOpsObservationQueries([
    () =>
      executor
        .select()
        .from(messages)
        .where(messagePredicate)
        .orderBy(asc(messages.sequence))
        .limit(500),
    () =>
      executor
        .select({
          id: messages.id,
          metadata: messages.metadata,
          sentAt: messages.sentAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, input.project.conversationId),
            isNull(messages.deletedAt),
            gte(messages.sentAt, input.project.currentTaskStartedAt),
          ),
        )
        .orderBy(asc(messages.sequence))
        .limit(500),
    () =>
      executor
        .select()
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.projectId, input.project.id),
            eq(siteBuilds.userId, input.userId),
            gte(siteBuilds.createdAt, input.project.currentTaskStartedAt),
          ),
        )
        .orderBy(desc(siteBuilds.ordinal))
        .limit(50),
    () =>
      executor
        .select()
        .from(siteDeployments)
        .where(
          and(
            eq(siteDeployments.projectId, input.project.id),
            eq(siteDeployments.userId, input.userId),
            gte(siteDeployments.createdAt, input.project.currentTaskStartedAt),
          ),
        )
        .orderBy(desc(siteDeployments.createdAt))
        .limit(50),
    () =>
      executor
        .select()
        .from(socialPackages)
        .where(
          and(
            eq(socialPackages.projectId, input.project.id),
            eq(socialPackages.userId, input.userId),
            gte(socialPackages.createdAt, input.project.currentTaskStartedAt),
          ),
        )
        .orderBy(desc(socialPackages.createdAt))
        .limit(50),
    () =>
      loadServiceReadiness(executor, {
        projectId: input.project.id,
        userId: input.userId,
      }),
    () =>
      executor
        .select()
        .from(knowledgeBaseSnapshots)
        .where(
          and(
            eq(knowledgeBaseSnapshots.userId, input.userId),
            eq(knowledgeBaseSnapshots.status, "active"),
          ),
        )
        .orderBy(desc(knowledgeBaseSnapshots.version))
        .limit(200),
    () =>
      executor
        .select()
        .from(websiteStyleSampleBatches)
        .where(
          and(
            eq(websiteStyleSampleBatches.userId, input.userId),
            eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
            eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
            gte(
              websiteStyleSampleBatches.createdAt,
              input.project.currentTaskStartedAt,
            ),
            customerVisibleStyleBatchStatusCondition(),
          ),
        )
        .orderBy(desc(websiteStyleSampleBatches.ordinal))
        .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES + 1),
    () =>
      executor
        .select({
          id: siteOperations.id,
          buildId: siteOperations.buildId,
          kind: siteOperations.kind,
          status: siteOperations.status,
          input: siteOperations.input,
          provider: siteOperations.provider,
          providerTaskId: siteOperations.providerTaskId,
          result: siteOperations.result,
          errorCode: siteOperations.errorCode,
          startedAt: siteOperations.startedAt,
          completedAt: siteOperations.completedAt,
          createdAt: siteOperations.createdAt,
          updatedAt: siteOperations.updatedAt,
        })
        .from(siteOperations)
        .where(
          and(
            eq(siteOperations.projectId, input.project.id),
            eq(siteOperations.userId, input.userId),
            gte(siteOperations.createdAt, input.project.currentTaskStartedAt),
            inArray(siteOperations.kind, [
              "visual_search",
              "site_build",
              "build_revision",
              "deploy",
            ]),
          ),
        )
        .orderBy(desc(siteOperations.createdAt))
        .limit(50),
    () =>
      executor
        .select()
        .from(siteProviderConnections)
        .where(
          and(
            eq(siteProviderConnections.projectId, input.project.id),
            eq(siteProviderConnections.userId, input.userId),
            eq(siteProviderConnections.provider, "aliyun_cn"),
          ),
        )
        .limit(1),
    () =>
      executor
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, input.userId))
        .limit(1),
    () =>
      executor
        .select({ id: siteOperations.id })
        .from(siteOperations)
        .where(
          and(
            eq(siteOperations.projectId, input.project.id),
            eq(siteOperations.userId, input.userId),
            inArray(siteOperations.provider, ["aliyun_esa", "aliyun_alidns"]),
            inArray(siteOperations.status, [
              "queued",
              "running",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1),
    () =>
      executor
        .select({ id: visualCandidatePools.id })
        .from(visualCandidatePools)
        .where(
          and(
            eq(visualCandidatePools.projectId, input.project.id),
            eq(visualCandidatePools.userId, input.userId),
            eq(
              visualCandidatePools.taskStartedAt,
              input.project.currentTaskStartedAt,
            ),
            inArray(visualCandidatePools.status, ["active", "selected"]),
          ),
        )
        .orderBy(desc(visualCandidatePools.createdAt))
        .limit(1),
    () =>
      loadSiteOpsRebuildRequest(executor, {
        userId: input.userId,
        projectId: input.project.id,
        currentBuildId: input.project.currentBuildId,
        hasWorkflowProgress: Boolean(
          input.project.currentBuildId ||
            input.project.currentKnowledgeSnapshotId ||
            input.project.status !== "draft",
        ),
      }),
  ])) as any[];

  const {
    messageRows,
    timelineMessageRows,
    buildRows,
    deploymentRows,
    packageRows,
    batchRows,
    timelineOperationRows,
  } = projectSiteOpsCurrentResetCycle({
    successfulResetApplied:
      input.project.knowledgeInputEpochId !== null ||
      rebuildRequest.resetApplied ||
      rawTimelineMessageRows.some(
        (row: { sentAt: Date; metadata: unknown }) =>
          row.sentAt.getTime() ===
            input.project.currentTaskStartedAt.getTime() &&
          isCompletedResetBoundaryMessage(row),
      ),
    currentTaskStartedAt: input.project.currentTaskStartedAt,
    messageRows: rawMessageRows,
    timelineMessageRows: rawTimelineMessageRows,
    buildRows: rawBuildRows,
    deploymentRows: rawDeploymentRows,
    packageRows: rawPackageRows,
    batchRows: rawBatchRows,
    timelineOperationRows: rawTimelineOperationRows,
  });
  const selectableSnapshotRows = snapshotRows.filter(
    (snapshot: typeof knowledgeBaseSnapshots.$inferSelect) =>
      siteOpsKnowledgeSnapshotAvailable(snapshot),
  );
  const visibleBuildIds = buildRows.map(
    (row: typeof siteBuilds.$inferSelect) => row.id,
  );
  const buildInputRows =
    visibleBuildIds.length > 0
      ? await executor
          .select()
          .from(siteBuildInputAssets)
          .where(
            and(
              inArray(siteBuildInputAssets.buildId, visibleBuildIds),
              eq(siteBuildInputAssets.projectId, input.project.id),
              eq(siteBuildInputAssets.userId, input.userId),
              eq(
                siteBuildInputAssets.taskStartedAt,
                input.project.currentTaskStartedAt,
              ),
            ),
          )
      : [];
  const buildInputsByBuildId = new Map<
    string,
    Array<typeof siteBuildInputAssets.$inferSelect>
  >();
  for (const asset of buildInputRows as Array<
    typeof siteBuildInputAssets.$inferSelect
  >) {
    const current = buildInputsByBuildId.get(asset.buildId) ?? [];
    current.push(asset);
    buildInputsByBuildId.set(asset.buildId, current);
  }

  const frozenVisualOperation = timelineOperationRows
    .filter((row: { kind: string }) => row.kind === "visual_search")
    .sort(compareSiteOpsVisualOperationsNewestFirst)
    .find((row: { input?: unknown }) => {
      const parsed = row.input as Record<string, unknown> | null | undefined;
      return typeof parsed?.workflowVersion === "string";
    });
  const frozenVisualInput = (frozenVisualOperation?.input ?? null) as Record<
    string,
    unknown
  > | null;
  const visualCoordinates = resolveVisualCatalogObservationCoordinates({
    frozenVisualInput,
    hasAnyVisualOperation: timelineOperationRows.some(
      (row: { kind: string }) => row.kind === "visual_search",
    ),
    visibleBatchCount: batchRows.length,
  });
  const {
    workflowVersion: visualWorkflowVersion,
    catalogVersion: visualCatalogVersion,
    staticCatalogVisualCycle,
    pageSize: visualPageSize,
    pageCount: visualPageCount,
  } = visualCoordinates;

  const publishedBatchRows = batchRows
    .filter(
      (row: typeof websiteStyleSampleBatches.$inferSelect) =>
        row.status === "published",
    )
    .sort(
      (
        left: typeof websiteStyleSampleBatches.$inferSelect,
        right: typeof websiteStyleSampleBatches.$inferSelect,
      ) => left.ordinal - right.ordinal,
    )
    .slice(0, visualPageCount);
  const visibleBatchRows = staticCatalogVisualCycle
    ? batchRows
        .filter((row: typeof websiteStyleSampleBatches.$inferSelect) =>
          ["published", "selected"].includes(row.status),
        )
        .sort(
          (
            left: typeof websiteStyleSampleBatches.$inferSelect,
            right: typeof websiteStyleSampleBatches.$inferSelect,
          ) => left.ordinal - right.ordinal,
        )
        .slice(0, STATIC_TEMPLATE_CATALOG_PAGE_COUNT)
    : publishedBatchRows.length > 0
      ? publishedBatchRows
      : batchRows
          .filter(
            (row: typeof websiteStyleSampleBatches.$inferSelect) =>
              row.status === "selected",
          )
          .slice(0, 1);
  const visibleBatchIds = visibleBatchRows.map(
    (row: typeof websiteStyleSampleBatches.$inferSelect) => row.id,
  );
  const candidateRows =
    visibleBatchIds.length > 0
      ? await executor
          .select()
          .from(websiteStyleSamples)
          .where(inArray(websiteStyleSamples.batchId, visibleBatchIds))
          .limit(
            staticCatalogVisualCycle
              ? STATIC_TEMPLATE_CATALOG_PAGE_COUNT *
                  STATIC_TEMPLATE_CATALOG_PAGE_SIZE
              : SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL,
          )
      : [];
  const completePublishedPages = completePublishedVisualPageCount({
    batches: staticCatalogVisualCycle ? visibleBatchRows : publishedBatchRows,
    candidates: candidateRows,
    pageSize: visualPageSize,
    ...(staticCatalogVisualCycle
      ? { visibleStatuses: ["published", "selected"] }
      : {}),
  });
  const visualOperationRows = timelineOperationRows
    .filter((row: { kind: string }) => row.kind === "visual_search")
    .sort(compareSiteOpsVisualOperationsNewestFirst);
  const latestVisualOperation = visualOperationRows[0] ?? null;
  const operationPoolAvailability = visualOperationRows
    .map((row: { result?: unknown }) =>
      row.result && typeof row.result === "object" && !Array.isArray(row.result)
        ? (row.result as Record<string, unknown>)
        : null,
    )
    .find(
      (result: Record<string, unknown> | null) =>
        result && Number.isInteger(result.availablePages),
    );
  const currentVisualPoolPageRows = currentVisualPoolRows[0]
    ? await executor
        .select({
          pageNumber: visualCandidatePoolPages.pageNumber,
          status: visualCandidatePoolPages.status,
        })
        .from(visualCandidatePoolPages)
        .where(eq(visualCandidatePoolPages.poolId, currentVisualPoolRows[0].id))
        .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES)
    : [];
  const frozenPoolAvailability =
    currentVisualPoolPageRows.length > 0
      ? {
          availablePages: Math.max(
            ...currentVisualPoolPageRows.map(
              (row: { pageNumber: number }) => row.pageNumber,
            ),
          ),
          reservedPages: currentVisualPoolPageRows.filter(
            (row: { status: string }) => row.status === "reserved",
          ).length,
        }
      : (operationPoolAvailability ?? visualCoordinates.defaultAvailability);
  const activeVisualOperationRows = visualOperationRows.filter(
    (row: { status: string }) =>
      ACTIVE_VISUAL_OPERATION_STATUSES.has(row.status),
  );
  const terminalVisualOperationIds = new Set(
    visualOperationRows
      .filter((row: { status: string }) =>
        TERMINAL_VISUAL_OPERATION_STATUSES.has(row.status),
      )
      .map((row: { id: string }) => row.id),
  );
  const messagesProjected = messageRows.flatMap(
    (row: typeof messages.$inferSelect) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const siteOps = metadata.siteOps as Record<string, unknown> | undefined;
      const originalPayload = siteOps?.payload as
        | Record<string, unknown>
        | undefined;
      if (
        originalPayload?.visibility === "timeline" ||
        originalPayload?.timelineOnly === true
      ) {
        return [];
      }
      if (
        siteOps?.kind === "build_progress" &&
        originalPayload?.stage === "visual_searching" &&
        typeof siteOps.subjectId === "string" &&
        terminalVisualOperationIds.has(siteOps.subjectId)
      ) {
        return [];
      }
      const statusProjectedMetadata =
        siteOps?.status === "active" &&
        Number(siteOps.revision) !== input.project.revision
          ? { ...metadata, siteOps: { ...siteOps, status: "expired" } }
          : metadata;
      const statusProjectedSiteOps = statusProjectedMetadata.siteOps as
        | Record<string, unknown>
        | undefined;
      const payload = statusProjectedSiteOps?.payload as
        | Record<string, unknown>
        | undefined;
      const projectedMetadata = statusProjectedSiteOps
        ? {
            ...statusProjectedMetadata,
            siteOps: {
              ...statusProjectedSiteOps,
              subjectId: row.id,
              payload: {},
            },
          }
        : statusProjectedMetadata;
      const projectedContent =
        originalPayload?.reset === true &&
        originalPayload?.unpublishCompleted === true
          ? "旧网站已安全下线，旧建站流程已清空；企业知识库保持不变，可创建全新官网任务。"
          : row.content;
      return [
        {
          id: row.id,
          role: row.role,
          content:
            row.role === "assistant" && siteOps
              ? publicSiteOpsMessageText({
                  content: projectedContent,
                  errorCode:
                    typeof payload?.errorCode === "string"
                      ? payload.errorCode
                      : null,
                  operationStatus:
                    payload?.operationStatus === "failed" ||
                    payload?.operationStatus === "attention_required" ||
                    payload?.operationStatus === "outcome_unknown"
                      ? payload.operationStatus
                      : null,
                })
              : projectedContent,
          sequence: row.sequence,
          metadata: projectedMetadata,
          sentAt: row.sentAt.toISOString(),
        },
      ];
    },
  );
  const selectedSampleIds = new Set(
    buildRows
      .filter(
        (build: typeof siteBuilds.$inferSelect) =>
          !["cancelled", "superseded"].includes(build.status),
      )
      .flatMap((build: typeof siteBuilds.$inferSelect) =>
        build.styleSampleId ? [build.styleSampleId] : [],
      ),
  );
  const projectVisualCandidate = (
    row: typeof websiteStyleSamples.$inferSelect,
  ) => {
    const { providerTitle, ...heroMetadata } = publicVisualMetadata(
      row.sourceMetadata,
    );
    return {
      id: row.id,
      label: row.label,
      title: providerTitle || row.note?.trim() || `视觉方向 ${row.label}`,
      previewUrl: `/api/site-ops/style-previews/${row.id}`,
      note: row.note,
      ...heroMetadata,
      selected: selectedSampleIds.has(row.id),
    };
  };
  const visualCandidatePages = visibleBatchRows.flatMap(
    (
      batch: typeof websiteStyleSampleBatches.$inferSelect,
      pageIndex: number,
    ) => {
      const candidates = candidateRows
        .filter(
          (row: typeof websiteStyleSamples.$inferSelect) =>
            row.batchId === batch.id,
        )
        .sort(
          (
            left: typeof websiteStyleSamples.$inferSelect,
            right: typeof websiteStyleSamples.$inferSelect,
          ) => left.sortOrder - right.sortOrder,
        )
        .map(projectVisualCandidate);
      return candidates.length === visualPageSize
        ? [{ batchId: batch.id, page: pageIndex + 1, candidates }]
        : [];
    },
  );
  const visualCandidates =
    visualCandidatePages[visualCandidatePages.length - 1]?.candidates ?? [];
  const hasActiveBuild = buildRows.some((row: typeof siteBuilds.$inferSelect) =>
    NONTERMINAL_BUILD_STATUSES.includes(
      row.status as (typeof NONTERMINAL_BUILD_STATUSES)[number],
    ),
  );
  const hasBuildAttempt = buildRows.some(
    (row: typeof siteBuilds.$inferSelect) =>
      !["cancelled", "superseded"].includes(row.status),
  );
  const visualGeneration = projectSiteOpsVisualGeneration({
    projectStatus: input.project.status,
    generatedPages: completePublishedPages,
    availablePages:
      typeof frozenPoolAvailability?.availablePages === "number"
        ? frozenPoolAvailability.availablePages
        : null,
    reservedPages:
      typeof frozenPoolAvailability?.reservedPages === "number"
        ? frozenPoolAvailability.reservedPages
        : null,
    latestVisualOperation,
    hasActiveVisualOperation: activeVisualOperationRows.length > 0,
    hasActiveBuild,
    hasBuildAttempt,
    workflowVersion: visualWorkflowVersion,
    catalogVersion: visualCatalogVersion,
    pageSize: visualPageSize,
    pageCount: visualPageCount,
  });
  const projectedStatuses = projectSiteOpsObservationStatuses({
    projectStatus: input.project.status,
    recoveredSelection: visualGeneration.recoveredSelection,
  });
  const observation = {
    schemaVersion: 1 as const,
    executionKind: "site_ops" as const,
    serviceReadiness,
    aliyunConnection: connectionRows[0]
      ? {
          configured: connectionRows[0].status === "active",
          status:
            connectionRows[0].status === "active"
              ? ("active" as const)
              : connectionRows[0].status === "invalid"
                ? ("attention_required" as const)
                : ("not_connected" as const),
          verifiedAt: connectionRows[0].verifiedAt?.toISOString() ?? null,
          canDisconnect: activeAliyunOperationRows.length === 0,
        }
      : {
          configured: false,
          status: "not_connected" as const,
          verifiedAt: null,
          canDisconnect: true,
        },
    domainState: profileRows[0]
      ? {
          domain: profileRows[0].normalizedAsciiDomain ?? profileRows[0].domain,
          displayDomain:
            profileRows[0].unicodeDisplayDomain ?? profileRows[0].domain,
          revision: profileRows[0].domainRevision,
          ownershipStatus: profileRows[0].domainOwnershipStatus,
          dnsStatus: profileRows[0].dnsStatus,
          icpStatus: profileRows[0].icpStatus,
          icpDomainRevision: profileRows[0].icpDomainRevision,
          icpVerifiedAt: profileRows[0].icpVerifiedAt?.toISOString() ?? null,
        }
      : null,
    project: {
      id: input.project.id,
      conversationId: input.project.conversationId,
      currentKnowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
      primaryLanguage: input.project.primaryLanguage,
      canonicalHostname: input.project.canonicalHostname,
      status: projectedStatuses.projectStatus,
      revision: input.project.revision,
      updatedAt: input.project.updatedAt.toISOString(),
    },
    brief: (() => {
      const parsed = siteBriefSchema.safeParse(input.project.brief);
      return parsed.success ? parsed.data : null;
    })(),
    knowledgeSnapshots: selectableSnapshotRows.map(
      (row: typeof knowledgeBaseSnapshots.$inferSelect) => ({
        id: row.id,
        label: `v${row.version} · ${row.sourceFileName}`,
        sourceProfile: null,
        createdAt: row.createdAt.toISOString(),
        active: row.id === input.project.currentKnowledgeSnapshotId,
      }),
    ),
    messages: messagesProjected,
    visualCandidates,
    visualCandidatePages,
    visualGeneration: {
      status: visualGeneration.status,
      targetPage: visualGeneration.targetPage,
      generatedPages: visualGeneration.generatedPages,
      availablePages: visualGeneration.availablePages,
      reservedPages: visualGeneration.reservedPages,
      maxPages: visualGeneration.maxPages,
      canGenerateMore: visualGeneration.canGenerateMore,
      canSelectExisting: visualGeneration.canSelectExisting,
      retryAction: visualGeneration.retryAction,
      failureCategory: visualGeneration.failureCategory,
      ...(visualGeneration.workflowVersion
        ? { workflowVersion: visualGeneration.workflowVersion }
        : {}),
      ...(visualGeneration.catalogVersion
        ? { catalogVersion: visualGeneration.catalogVersion }
        : {}),
      ...(visualGeneration.pageSize
        ? { pageSize: visualGeneration.pageSize }
        : {}),
      ...(visualGeneration.pageCount
        ? { pageCount: visualGeneration.pageCount }
        : {}),
    },
    executionSteps: projectSiteOpsExecutionSteps({
      operations: timelineOperationRows,
      timelineMessages: timelineMessageRows,
    }),
    builds: buildRows.map((row: typeof siteBuilds.$inferSelect) => {
      const buildDelivery = projectSiteOpsBuildDelivery({
        buildId: row.id,
        operations: timelineOperationRows,
      });
      const buildProgress = projectSiteOpsBuildProgress({
        buildId: row.id,
        operations: timelineOperationRows,
      });
      return {
        id: row.id,
        parentBuildId: row.parentBuildId,
        ordinal: row.ordinal,
        status: row.status,
        previewUrl: row.distLocalAssetId
          ? `/api/site-ops/builds/${row.id}/preview/`
          : null,
        sourceUrl: row.sourceLocalAssetId
          ? `/api/site-ops/builds/${row.id}/source`
          : null,
        contentPlan: {
          status:
            row.contentPlanLocalAssetId && row.contentPlanSha256
              ? ("ready" as const)
              : ("pending" as const),
          sha256:
            row.contentPlanLocalAssetId && row.contentPlanSha256
              ? row.contentPlanSha256
              : null,
        },
        revisionInputs: (buildInputsByBuildId.get(row.id) ?? [])
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((asset) => ({
            filename: asset.filename,
            mimeType: asset.mimeType as
              | "image/png"
              | "image/jpeg"
              | "image/webp",
            sizeBytes: asset.sizeBytes,
            publicPath: asset.publicPath,
          })),
        buildDelivery,
        ...buildProgress,
        needsHelp:
          row.status === "failed" || row.status === "attention_required",
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    deployments: deploymentRows.map(
      (row: typeof siteDeployments.$inferSelect) => ({
        id: row.id,
        buildId: row.buildId,
        target: row.target,
        publicUrl: row.publicUrl,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    socialPackages: packageRows.map(
      (row: typeof socialPackages.$inferSelect) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        archiveUrl: row.archiveLocalAssetId
          ? `/api/site-ops/social-packages/${row.id}/archive`
          : null,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    rebuildRequest: {
      allowed: rebuildRequest.allowed,
      ticketId: rebuildRequest.ticketId,
      status: rebuildRequest.status,
      resetApplied: rebuildRequest.resetApplied,
      resetPending: rebuildRequest.resetPending,
      resetSourceBuildId: rebuildRequest.resetSourceBuildId,
    },
    interactionState: projectedStatuses.interactionState,
    latestSequence: Math.max(
      input.afterSequence ?? 0,
      ...messageRows.map((row: typeof messages.$inferSelect) => row.sequence),
    ),
  };
  return siteOpsObservationV1Schema.parse(observation);
}

async function projectObservation(
  executor: any,
  input: {
    userId: number;
    project: typeof siteProjects.$inferSelect;
    afterSequence?: number;
  },
) {
  const key = siteOpsObservationFlightKey(input);
  return runSiteOpsObservationSingleFlight(key, () =>
    projectObservationOnce(executor, input),
  );
}

export async function openSiteOps(actor: AuthenticatedUser) {
  assertEnabled();
  assertCustomer(actor);
  await requireSiteOpsEntitlement(actor.id);
  const db = await requireDb();
  const project = await db.transaction(async (tx: any) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1)
      .for("update");
    const existing = await loadOwnedProject(tx, actor.id, undefined, true);
    if (existing) return existing;

    const projectId = randomUUID();
    const conversationId = `siteops:${actor.id}`;
    await tx.insert(conversations).values({
      id: conversationId,
      userId: actor.id,
      title: "官网任务与AI建站",
      status: "awaiting_input",
      version: 1,
    });
    await tx.insert(siteProjects).values({
      id: projectId,
      userId: actor.id,
      conversationId,
      status: "draft",
      revision: 1,
    });
    await appendMessage(tx, {
      conversationId,
      userId: actor.id,
      role: "assistant",
      content:
        "点击下方按钮，FrontMind 将自动连接当前企业知识库并开始整理建站资料。",
      siteOps: {
        kind: "brief_question",
        subjectId: projectId,
        revision: 1,
        status: "active",
        payload: { requested: "current_knowledge" },
      },
    });
    const inserted = await loadOwnedProject(tx, actor.id, conversationId);
    if (!inserted) throw new Error("SITEOPS_PROJECT_INSERT_FAILED");
    return inserted;
  });
  return projectObservation(db, { userId: actor.id, project });
}

export async function observeSiteOps(actor: AuthenticatedUser, value: unknown) {
  assertEnabled();
  assertCustomer(actor);
  await requireSiteOpsEntitlement(actor.id);
  const input = siteOpsObserveInputSchema.parse(value);
  const db = await requireDb();
  const project = await loadOwnedProject(db, actor.id, input.conversationId);
  if (!project) {
    throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
  }
  return projectObservation(db, {
    userId: actor.id,
    project,
    afterSequence: input.afterSequence,
  });
}

function translateAliyunConnectionError(error: unknown): never {
  if (error instanceof SiteOpsServiceError) throw error;
  if (error instanceof AuthServiceError) {
    if (error.code === "INVALID_CREDENTIAL" || error.code === "NOT_FOUND") {
      throw new SiteOpsServiceError(
        "PROVIDER_NOT_CONFIGURED",
        "阿里云连接配置需要 FrontMind 管理员更新。",
        409,
      );
    }
    if (
      error.code === "RATE_LIMITED" ||
      error.code === "UPSTREAM_UNAVAILABLE"
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "阿里云授权服务暂时不可用，请稍后重试。",
        503,
      );
    }
  }
  if (error instanceof AliyunProviderError) {
    const notFound = [
      "PROJECT_NOT_FOUND",
      "ALIYUN_CONNECTION_NOT_FOUND",
    ].includes(error.code);
    const invalid = ["INVALID_DOMAIN", "ALIYUN_DOMAIN_NOT_OWNED"].includes(
      error.code,
    );
    const authorizationNeeded = [
      "ALIYUN_REAUTHORIZATION_REQUIRED",
      "ALIYUN_OAUTH_CREDENTIAL_RETIRED",
    ].includes(error.code);
    throw new SiteOpsServiceError(
      invalid ? "INVALID_INPUT" : notFound ? "NOT_FOUND" : "STATE_CONFLICT",
      error.code === "INVALID_DOMAIN"
        ? "域名格式不正确，请检查后重试。"
        : error.code === "ALIYUN_DOMAIN_NOT_OWNED"
          ? "该域名不属于当前阿里云账号，请选择账号内已购买的域名。"
          : notFound
            ? "当前项目或连接不存在，请刷新后重试。"
            : authorizationNeeded
              ? "阿里云授权已失效，请重新连接后继续。"
              : error.message,
      invalid ? 400 : notFound ? 404 : 409,
    );
  }
  throw error;
}

async function requireOwnedAliyunProject(
  actor: AuthenticatedUser,
  conversationId: string,
) {
  assertEnabled();
  assertCustomer(actor);
  await requireSiteOpsEntitlement(actor.id);
  const db = await requireDb();
  const project = await loadOwnedProject(db, actor.id, conversationId);
  if (!project) {
    throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
  }
  return project;
}

export async function getSiteOpsAliyunConnection(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    const status = await getAliyunCustomerConnectionStatus({
      projectId: project.id,
      userId: actor.id,
    });
    return {
      configured: status.status === "active",
      status:
        status.status === "active"
          ? ("active" as const)
          : status.status === "invalid"
            ? ("attention_required" as const)
            : ("not_connected" as const),
      verifiedAt: status.verifiedAt
        ? new Date(status.verifiedAt).toISOString()
        : null,
      canDisconnect: status.canDisconnect,
    };
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function beginSiteOpsAliyunOAuth(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    return await createAliyunOAuthAuthorization({
      projectId: project.id,
      userId: actor.id,
    });
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function listSiteOpsAliyunDomains(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    return siteOpsAliyunDomainListSchema.parse(
      await listAliyunCustomerDomains({
        projectId: project.id,
        userId: actor.id,
      }),
    );
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function completeSiteOpsAliyunOAuth(input: {
  actor: AuthenticatedUser;
  credentialId: string;
  projectId: string;
  accountUid: string;
  refreshToken: string;
}) {
  assertEnabled();
  assertCustomer(input.actor);
  await requireSiteOpsEntitlement(input.actor.id);
  const credentialId = z.string().uuid().parse(input.credentialId);
  const projectId = z.string().uuid().parse(input.projectId);
  try {
    await bindAliyunCustomerAccountFromOAuth({
      projectId,
      userId: input.actor.id,
      credentialId,
      accountUid: input.accountUid,
      refreshToken: input.refreshToken,
    });
    return { connected: true as const };
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

export async function disconnectSiteOpsAliyunConnection(
  actor: AuthenticatedUser,
  value: unknown,
) {
  const input = siteOpsAliyunConnectionInputSchema.parse(value);
  const project = await requireOwnedAliyunProject(actor, input.conversationId);
  try {
    return await disconnectAliyunCustomerConnection({
      projectId: project.id,
      userId: actor.id,
    });
  } catch (error) {
    translateAliyunConnectionError(error);
  }
}

const SITEOPS_REVISION_WORKFLOW_VERSION = "2.9.0";
const SITEOPS_REVISION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const SITEOPS_UNBOUND_INPUT_RETENTION_MS = 24 * 60 * 60 * 1_000;

type FrozenSiteOpsRevisionInputAsset = {
  id: string;
  sourceAssetId: string;
  localAssetId: string;
  ordinal: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  width: number;
  height: number;
  publicPath: string;
  siteOpsKnowledgeInputEpochId: string | null;
  taskStartedAt: Date;
};

async function revisionInputBytes(
  stream: AsyncIterable<unknown>,
  expectedSize?: number,
) {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
    sizeBytes += chunk.length;
    if (sizeBytes > SITEOPS_REVISION_IMAGE_MAX_BYTES) {
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "单张图片不能超过 8 MiB。",
        400,
      );
    }
    chunks.push(chunk);
  }
  if (
    sizeBytes < 1 ||
    (expectedSize !== undefined && sizeBytes !== expectedSize)
  ) {
    throw new SiteOpsServiceError(
      "INVALID_INPUT",
      "图片内容不完整，请重新上传。",
      400,
    );
  }
  return Buffer.concat(chunks, sizeBytes);
}

async function freezeSiteOpsRevisionInputAssets(input: {
  db: Awaited<ReturnType<typeof requireDb>>;
  actor: AuthenticatedUser;
  conversationId: string;
  clientRequestId: string;
  localAssetIds: string[];
}) {
  if (input.localAssetIds.length === 0) return [];
  const project = await loadOwnedProject(
    input.db,
    input.actor.id,
    input.conversationId,
  );
  if (!project?.knowledgeInputEpochId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前任务不支持带图片修改，请批准重置后重新生成官网。",
      409,
    );
  }
  const knowledgeInputEpochId = project.knowledgeInputEpochId;
  if (
    !project.currentBuildId ||
    ![
      "preview_ready",
      "approved",
      "live",
      "failed",
      "attention_required",
    ].includes(project.status)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "图片只能在首轮官网预览生成后加入修改版本。",
      409,
    );
  }
  const parentRows = await input.db
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, project.currentBuildId),
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, input.actor.id),
        gte(siteBuilds.createdAt, project.currentTaskStartedAt),
      ),
    )
    .limit(1);
  const parent = parentRows[0];
  if (
    !parent ||
    parent.workflowVersion !== SITEOPS_REVISION_WORKFLOW_VERSION ||
    !parent.sourceLocalAssetId ||
    !parent.sourceHash ||
    !parent.contentPlanLocalAssetId ||
    !parent.contentPlanSha256
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前预览不支持带图片修改，请批准重置后重新生成官网。",
      409,
    );
  }

  const frozen: FrozenSiteOpsRevisionInputAsset[] = [];
  const publicPaths = new Set<string>();
  let totalInputBytes = 0;
  for (const [index, sourceAssetId] of input.localAssetIds.entries()) {
    const sourceRows = await input.db
      .select({ id: localAssets.id })
      .from(localAssets)
      .where(
        and(
          eq(localAssets.id, sourceAssetId),
          eq(localAssets.scope, "managed_user"),
          eq(localAssets.accountUserId, input.actor.id),
          isNull(localAssets.presalesProjectId),
          gt(localAssets.retainUntil, new Date()),
          eq(localAssets.siteOpsKnowledgeInputEpochId, knowledgeInputEpochId),
        ),
      )
      .limit(1);
    if (!sourceRows[0]) {
      throw new SiteOpsServiceError(
        "FORBIDDEN",
        "图片不存在、已过期或不属于当前建站任务，请重新上传。",
        403,
      );
    }
    let resolved: Awaited<ReturnType<typeof ownedFileContentResolver.resolve>>;
    try {
      resolved = await ownedFileContentResolver.resolve({
        ownerUserId: input.actor.id,
        fileId: sourceAssetId,
        expectedSourceKind: "managed_local_asset",
      });
    } catch {
      throw new SiteOpsServiceError(
        "FORBIDDEN",
        "图片不存在、已过期或不属于当前账号，请重新上传。",
        403,
      );
    }
    const extension = path.extname(resolved.filename).toLowerCase();
    const mimeType = imageMimeByExtension[extension];
    if (
      !mimeType ||
      ![".png", ".jpg", ".jpeg", ".webp"].includes(extension) ||
      resolved.mimeType.toLowerCase() !== mimeType
    ) {
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "仅支持 PNG、JPEG 或 WebP 图片。",
        400,
      );
    }
    const bytes = await revisionInputBytes(resolved.stream, resolved.sizeBytes);
    totalInputBytes += bytes.length;
    if (totalInputBytes > 32 * 1024 * 1024) {
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "本次图片总大小不能超过 32 MiB。",
        400,
      );
    }
    if (!isSupportedImageBytes(extension, bytes)) {
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "图片格式与内容不一致，请重新上传。",
        400,
      );
    }
    const dimensions = await decodedRasterImageDimensions(extension, bytes);
    if (!dimensions) {
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "图片无法安全解码或像素尺寸过大。",
        400,
      );
    }
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    if (resolved.sha256 && resolved.sha256.toLowerCase() !== contentSha256) {
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "图片完整性校验失败，请重新上传。",
        400,
      );
    }
    const publicExtension = extension === ".jpeg" ? ".jpg" : extension;
    const publicPath = `/frontmind-user-media/${contentSha256}${publicExtension}`;
    if (publicPaths.has(publicPath)) {
      throw new SiteOpsServiceError(
        "INVALID_INPUT",
        "请移除内容重复的图片后再提交。",
        400,
      );
    }
    publicPaths.add(publicPath);
    const stable = await persistSiteOpsArtifact({
      userId: input.actor.id,
      projectId: project.id,
      kind: "revision-input",
      filename: `frontmind-user-media-${contentSha256}${publicExtension}`,
      mimeType,
      buffer: bytes,
      maxBytes: SITEOPS_REVISION_IMAGE_MAX_BYTES,
      idempotencyKey: `${input.clientRequestId}:${sourceAssetId}:${contentSha256}`,
      retainUntil: new Date(Date.now() + SITEOPS_UNBOUND_INPUT_RETENTION_MS),
    });
    frozen.push({
      id: randomUUID(),
      sourceAssetId,
      localAssetId: stable.id,
      ordinal: index + 1,
      filename: resolved.filename,
      mimeType,
      sizeBytes: bytes.length,
      contentSha256,
      width: dimensions.width,
      height: dimensions.height,
      publicPath,
      siteOpsKnowledgeInputEpochId: knowledgeInputEpochId,
      taskStartedAt: project.currentTaskStartedAt,
    });
  }
  return frozen;
}

export async function sendSiteOpsMessage(
  actor: AuthenticatedUser,
  value: unknown,
) {
  assertEnabled();
  assertCustomer(actor);
  const entitlement = await requireSiteOpsEntitlement(actor.id);
  const input = siteOpsSendMessageInputSchema.parse(value);
  const request = {
    action: "brief_message",
    text: input.text,
    localAssetIds: [...input.localAssetIds].sort(),
  } as const;
  const requestHash = hashSiteOpsRequest(request);
  const db = await requireDb();
  // A committed child may already have moved the project to `building` when
  // the HTTP response is lost. Prove an exact replay before re-freezing its
  // inputs; the transaction below repeats this check to close concurrent
  // first-writer races.
  const replayProject = await loadOwnedProject(
    db,
    actor.id,
    input.conversationId,
  );
  if (!replayProject) {
    throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
  }
  const replayRows = await db
    .select()
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, replayProject.id),
        eq(siteOperations.clientRequestId, input.clientRequestId),
        gte(siteOperations.createdAt, replayProject.currentTaskStartedAt),
      ),
    )
    .limit(1);
  if (isSiteOpsOperationReplay(replayRows[0], requestHash)) {
    return observeSiteOps(actor, { conversationId: input.conversationId });
  }
  const revisionInputAssets = await freezeSiteOpsRevisionInputAssets({
    db,
    actor,
    conversationId: input.conversationId,
    clientRequestId: input.clientRequestId,
    localAssetIds: input.localAssetIds,
  });
  await db.transaction(async (tx: any) => {
    const project = await loadOwnedProject(
      tx,
      actor.id,
      input.conversationId,
      true,
    );
    if (!project) {
      throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
    }
    // A reset approval already created a new local epoch. Conversation and
    // build work may continue while the old external exposure is reconciled;
    // publish/DNS mutations are gated at the action boundary below.
    const existing = await tx
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.clientRequestId, input.clientRequestId),
          gte(siteOperations.createdAt, project.currentTaskStartedAt),
        ),
      )
      .limit(1);
    if (isSiteOpsOperationReplay(existing[0], requestHash)) return;
    if (project.revision !== input.expectedProjectRevision) {
      throw new SiteOpsServiceError(
        "REVISION_CONFLICT",
        "建站项目已更新，请刷新后重试。",
        409,
      );
    }
    const turnId = randomUUID();
    await tx.insert(conversationTurns).values({
      id: turnId,
      conversationId: project.conversationId,
      userId: actor.id,
      clientRequestId: input.clientRequestId,
      operationKey: `siteops:${hashSiteOpsRequest({
        projectId: project.id,
        clientRequestId: input.clientRequestId,
      })}`,
      operationType: "site_ops",
      expectedRevision: input.expectedProjectRevision,
      requestHash,
      status: "completed",
      completedAt: new Date(),
      metadata: { executionKind: "site_ops" },
    });
    if (
      project.currentBuildId &&
      [
        "preview_ready",
        "approved",
        "live",
        "failed",
        "attention_required",
      ].includes(project.status)
    ) {
      await handleRevision(tx, {
        actor,
        project,
        entitlement,
        turnId,
        requestId: input.clientRequestId,
        requestHash,
        payload: {
          buildId: project.currentBuildId,
          feedback: input.text,
        },
        inputAssets: revisionInputAssets,
      });
      return;
    }
    const operationId = randomUUID();
    await tx.insert(siteOperations).values({
      id: operationId,
      projectId: project.id,
      userId: actor.id,
      conversationTurnId: turnId,
      kind: "brief_message",
      status: "succeeded",
      clientRequestId: input.clientRequestId,
      inputHash: requestHash,
      input: request,
      completedAt: new Date(),
    });
    await appendMessage(tx, {
      conversationId: project.conversationId,
      userId: actor.id,
      role: "user",
      content: input.text,
      turnId,
    });
    const existingBrief = siteBriefSchema.safeParse(project.brief);
    const nextBrief =
      project.status === "collecting_brief" && existingBrief.success
        ? mergeCustomerBriefMessage(existingBrief.data, input.text)
        : project.brief;
    if (project.status === "collecting_brief" && existingBrief.success) {
      await appendMessage(tx, {
        conversationId: project.conversationId,
        userId: actor.id,
        role: "assistant",
        content: "已记录你补充的信息。资料完整后即可生成视觉候选。",
        turnId,
        siteOps: {
          kind: "brief_question",
          subjectId: project.id,
          revision: project.revision + 1,
          status: "active",
          payload: { updated: true },
        },
      });
    }
    await tx
      .update(siteProjects)
      .set({
        status:
          project.status === "draft" ? "collecting_brief" : project.status,
        brief: nextBrief,
        revision: project.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteProjects.id, project.id),
          eq(siteProjects.revision, project.revision),
        ),
      );
  });
  return observeSiteOps(actor, { conversationId: input.conversationId });
}

export function parseSiteOpsActionPayload(
  action: SiteOpsActInput["action"],
  raw: unknown,
) {
  switch (action) {
    case "request_rebuild":
      return z
        .object({ reason: z.string().trim().max(4_000).optional() })
        .strict()
        .parse(raw);
    case "select_snapshot":
      return z
        .object({ knowledgeSnapshotId: uuidSchema.optional() })
        .strict()
        .parse(raw);
    case "start_visual_search":
    case "reselect_visual":
      return z.object({}).strict().parse(raw);
    case "select_visual":
      return z.object({ sampleId: uuidSchema }).strict().parse(raw);
    case "delegate_visual":
      // The public observation intentionally does not expose the internal
      // batch id. The server resolves the newest active board for this
      // project and then makes the deterministic highest-score choice.
      return z.object({}).strict().parse(raw);
    case "approve_build":
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "官网制作和检查完成后会自动批准，无需重复操作。",
        409,
      );
    case "request_revision":
      return z
        .object({
          buildId: uuidSchema,
          feedback: z.string().trim().min(1).max(20_000),
        })
        .strict()
        .parse(raw);
    case "publish_global":
    case "publish_mainland":
      return z
        .object({
          buildId: uuidSchema,
          expectedHeadDeploymentId: optionalUuidSchema,
        })
        .strict()
        .parse(raw);
    case "rollback":
      return z.object({ deploymentId: uuidSchema }).strict().parse(raw);
    case "create_wechat_package":
    case "create_xiaohongshu_package":
      return z
        .object({ topic: z.string().trim().min(1).max(500).optional() })
        .strict()
        .parse(raw);
    case "domain_sync": {
      const parsed = z.object({ domain: domainSchema }).strict().parse(raw);
      return normalizeSiteOpsDomain(parsed.domain);
    }
  }
}

export function siteOpsResetPendingBlocksAction(
  action: SiteOpsActInput["action"],
) {
  return [
    "request_rebuild",
    "publish_global",
    "publish_mainland",
    "rollback",
    "domain_sync",
  ].includes(action);
}

type TwentyFirstReferenceAdmission = {
  version: number;
  fingerprint: string;
};

export function requireTwentyFirstReferenceAdmission(
  status: Awaited<ReturnType<typeof getTwentyFirstCredentialStatus>>,
): TwentyFirstReferenceAdmission {
  if (
    !status.configured ||
    status.version === null ||
    status.fingerprint === null ||
    status.capabilities?.search !== true
  ) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "21st 视觉参考检索连接暂时不可用，请稍后重试。",
      409,
    );
  }
  return { version: status.version, fingerprint: status.fingerprint };
}

async function ensureActiveProviderCredential(
  tx: any,
  slot: "site_builder_21st",
) {
  const rows = await tx
    .select({
      id: presalesApiCredentials.id,
      version: presalesApiCredentials.version,
      fingerprint: presalesApiCredentials.fingerprint,
    })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, slot),
        eq(presalesApiCredentials.status, "active"),
        eq(presalesApiCredentials.validationStatus, "verified"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "系统管理员尚未配置有效的 21st API Key。",
      412,
    );
  }
  return row;
}

async function ensureActiveCustomerAiCredential(tx: any, userId: number) {
  const rows = await tx
    .select()
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.userId, userId),
        eq(apiCredentials.status, "active"),
        eq(apiCredentials.validationStatus, "verified"),
        isNotNull(apiCredentials.verifiedAt),
        isNull(apiCredentials.deletedAt),
      ),
    )
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "当前账号尚未配置有效的 AI 建站 API Key。",
      412,
    );
  }
  return row;
}

export function resolveSiteOpsAgentProfile(input: {
  requested?: unknown;
  parentOperationInput?: unknown;
  credentialDefault?: unknown;
}): ManagedAgentProfile {
  const requested = managedAgentProfileSchema.safeParse(input.requested);
  if (requested.success) return requested.data;
  const parentInput =
    input.parentOperationInput &&
    typeof input.parentOperationInput === "object" &&
    !Array.isArray(input.parentOperationInput)
      ? (input.parentOperationInput as Record<string, unknown>)
      : {};
  const parent = managedAgentProfileSchema.safeParse(parentInput.agentProfile);
  if (parent.success) return parent.data;
  return normalizeManagedAgentProfile(input.credentialDefault);
}

export function freezeSiteOpsCustomerAiCredential(input: {
  credential: { id: string; version: number; agentProfile?: unknown };
  requestedProfile?: unknown;
  parentOperationInput?: unknown;
}) {
  return {
    manusCredentialId: input.credential.id,
    manusCredentialVersion: input.credential.version,
    credentialScope: "customer" as const,
    agentProfile: resolveSiteOpsAgentProfile({
      requested: input.requestedProfile,
      parentOperationInput: input.parentOperationInput,
      credentialDefault: input.credential.agentProfile,
    }),
  };
}

export async function resolvePinnedTwentyFirstCredentialForBatch(
  tx: any,
  input: {
    engineerNote: string | null;
    projectId: string;
    userId: number;
    knowledgeSnapshotId: string;
    workflowVersion: string;
  },
) {
  const operationId = input.engineerNote?.startsWith(
    TWENTY_FIRST_OPERATION_MARKER_PREFIX,
  )
    ? input.engineerNote.slice(TWENTY_FIRST_OPERATION_MARKER_PREFIX.length)
    : "";
  if (!uuidSchema.safeParse(operationId).success) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉批次缺少可核验的 21st 检索凭据来源。",
      409,
    );
  }
  const operationRows = await tx
    .select({ input: siteOperations.input })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.id, operationId),
        eq(siteOperations.projectId, input.projectId),
        eq(siteOperations.userId, input.userId),
        eq(siteOperations.kind, "visual_search"),
        eq(siteOperations.provider, "21st"),
        eq(siteOperations.status, "succeeded"),
      ),
    )
    .limit(1);
  const frozen = visualSearchOperationInputSchema.safeParse(
    operationRows[0]?.input,
  );
  if (
    !frozen.success ||
    frozen.data.knowledgeSnapshotId !== input.knowledgeSnapshotId ||
    frozen.data.workflowVersion !== input.workflowVersion
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉批次与当前知识库、工作流或检索凭据不一致，请重新检索。",
      409,
    );
  }
  assertCurrentVisualWorkflowVersion(frozen.data.workflowVersion);
  if (
    "schemaVersion" in frozen.data &&
    (frozen.data.schemaVersion === 3 || frozen.data.schemaVersion === 4) &&
    isStaticCatalogWorkflowVersion(frozen.data.workflowVersion)
  ) {
    return null;
  }
  if (!("credentialId" in frozen.data)) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉批次缺少可核验的历史检索凭据坐标。",
      409,
    );
  }
  const credentialRows = await tx
    .select({
      id: presalesApiCredentials.id,
      version: presalesApiCredentials.version,
    })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, frozen.data.credentialId),
        eq(presalesApiCredentials.slot, "site_builder_21st"),
      ),
    )
    .limit(1);
  const credential = credentialRows[0];
  if (!credential || credential.version !== frozen.data.credentialVersion) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉检索固定的 21st 凭据版本记录不存在。",
      409,
    );
  }
  return credential;
}

export function assertCurrentVisualWorkflowVersion(workflowVersion: string) {
  if (
    workflowVersion !== SITEOPS_MATERIALIZER_V2_5.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_6.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_7.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_8.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_9.frontMindVersion
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉检索使用的历史建站合同无法继续，请重新检索视觉方向后再继续。",
      409,
    );
  }
}

export function createVisualSearchOperationInput(
  input: VisualSearchOperationInput,
) {
  return visualSearchOperationInputSchema.parse(input);
}

export function siteOpsVisualCycleWorkflowVersion(
  frozenInputs: readonly unknown[],
) {
  const parsedInputs = frozenInputs.map((value) =>
    visualSearchOperationInputSchema.safeParse(value),
  );
  if (
    parsedInputs.length < 1 ||
    parsedInputs.some((result) => !result.success)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮视觉候选的冻结工作流无法核验，请重置后重新检索。",
      409,
    );
  }
  const workflows = new Set(
    parsedInputs.map((result) => result.data!.workflowVersion),
  );
  if (workflows.size !== 1) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮视觉候选的冻结工作流不一致，请重置后重新检索。",
      409,
    );
  }
  const workflowVersion = [...workflows][0];
  if (
    workflowVersion !== SITEOPS_MATERIALIZER_V2_5.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_6.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_7.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_8.frontMindVersion &&
    workflowVersion !== SITEOPS_MATERIALIZER_V2_9.frontMindVersion
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮视觉候选使用的历史工作流无法继续，请重置后重新检索。",
      409,
    );
  }
  return workflowVersion;
}

async function frozenSupplementalVisualWorkflowVersion(
  tx: any,
  input: {
    batches: readonly { engineerNote: string | null }[];
    projectId: string;
    userId: number;
    knowledgeSnapshotId: string;
    credentialId: string;
    credentialVersion: number;
  },
) {
  const operationIds = input.batches.map((batch) => {
    const value = batch.engineerNote?.startsWith(
      TWENTY_FIRST_OPERATION_MARKER_PREFIX,
    )
      ? batch.engineerNote.slice(TWENTY_FIRST_OPERATION_MARKER_PREFIX.length)
      : "";
    if (!uuidSchema.safeParse(value).success) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "现有视觉候选缺少冻结工作流坐标，请重置后重新检索。",
        409,
      );
    }
    return value;
  });
  const uniqueOperationIds = [...new Set(operationIds)];
  const rows = await tx
    .select({ id: siteOperations.id, input: siteOperations.input })
    .from(siteOperations)
    .where(
      and(
        inArray(siteOperations.id, uniqueOperationIds),
        eq(siteOperations.projectId, input.projectId),
        eq(siteOperations.userId, input.userId),
        eq(siteOperations.kind, "visual_search"),
        eq(siteOperations.provider, "21st"),
        eq(siteOperations.status, "succeeded"),
      ),
    );
  if (rows.length !== uniqueOperationIds.length) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "现有视觉候选的冻结工作流无法核验，请重置后重新检索。",
      409,
    );
  }
  const frozenInputs = rows.map((row: { input: unknown }) => row.input);
  for (const frozenInput of frozenInputs) {
    const parsed = visualSearchOperationInputSchema.parse(frozenInput);
    if (
      parsed.knowledgeSnapshotId !== input.knowledgeSnapshotId ||
      !("credentialId" in parsed) ||
      parsed.credentialId !== input.credentialId ||
      parsed.credentialVersion !== input.credentialVersion
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "现有视觉候选与当前知识库或检索凭据不一致，请重置后重新检索。",
        409,
      );
    }
  }
  return siteOpsVisualCycleWorkflowVersion(frozenInputs);
}

async function createActionTurn(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    requestId: string;
    requestHash: string;
    action: SiteOpsActInput["action"];
  },
) {
  const turnId = randomUUID();
  await tx.insert(conversationTurns).values({
    id: turnId,
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    clientRequestId: input.requestId,
    operationKey: `siteops:${hashSiteOpsRequest({
      projectId: input.project.id,
      clientRequestId: input.requestId,
    })}`,
    operationType: "site_ops",
    expectedRevision: input.project.revision,
    requestHash: input.requestHash,
    status: "completed",
    completedAt: new Date(),
    metadata: { executionKind: "site_ops", action: input.action },
  });
  return turnId;
}

async function reserveOperation(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    clientRequestId: string;
    requestHash: string;
    payload: Record<string, unknown>;
    kind: typeof siteOperations.$inferInsert.kind;
    buildId?: string;
    status?: typeof siteOperations.$inferInsert.status;
    provider?: string;
  },
) {
  const id = randomUUID();
  await tx.insert(siteOperations).values({
    id,
    projectId: input.project.id,
    userId: input.actor.id,
    conversationTurnId: input.turnId,
    buildId: input.buildId,
    kind: input.kind,
    status: input.status ?? "queued",
    clientRequestId: input.clientRequestId,
    inputHash: input.requestHash,
    input: input.payload,
    provider: input.provider,
    completedAt: input.status === "succeeded" ? new Date() : undefined,
  });
  return id;
}

function siteOpsMutationAffectedRows(value: unknown) {
  const header = Array.isArray(value)
    ? (value[0] as { affectedRows?: unknown } | undefined)
    : (value as { affectedRows?: unknown } | undefined);
  return Number(header?.affectedRows ?? 0);
}

async function handleRequestRebuild(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { reason?: string };
  },
) {
  const now = new Date();
  let created: {
    ticketId: string;
    buildId: string | null;
    resubmitted: boolean;
  };
  try {
    created = await createSiteOpsRebuildTicket(tx, {
      userId: input.actor.id,
      projectId: input.project.id,
      currentBuildId: input.project.currentBuildId,
      clientRequestId: input.requestId,
      reason: input.payload.reason,
      quotaPeriodIds: Array.from(
        new Set([
          ...siteOpsQuotaPeriodIds(
            input.entitlement,
            "website_content_publish",
          ),
          ...siteOpsQuotaPeriodIds(input.entitlement, "content_asset_publish"),
        ]),
      ),
      now,
    });
  } catch (error) {
    if (error instanceof SiteOpsQuotaError) {
      throw siteOpsServiceErrorFromQuota(error);
    }
    if (error instanceof SiteOpsRebuildTicketError) {
      throw new SiteOpsServiceError(
        error.code === "DELIVERY_OWNER_NOT_ASSIGNED" ||
        error.code === "ENTITLEMENT_NOT_FOUND"
          ? "FORBIDDEN"
          : "STATE_CONFLICT",
        error.message,
        error.code === "DELIVERY_OWNER_NOT_ASSIGNED" ||
        error.code === "ENTITLEMENT_NOT_FOUND"
          ? 412
          : 409,
      );
    }
    throw error;
  }
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      action: "request_rebuild",
      ticketId: created.ticketId,
      ...(created.buildId ? { sourceBuildId: created.buildId } : {}),
    },
    kind: "brief_message",
    ...(created.buildId ? { buildId: created.buildId } : {}),
    status: "succeeded",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: created.resubmitted
      ? "官网重制需求已再次提交。当前制作流程暂不受影响，FrontMind 通过后会重新开启全新流程。"
      : "官网重制需求已提交。当前制作流程暂不受影响，FrontMind 通过后会重新开启全新流程。",
    siteOps: {
      kind: "build_progress",
      subjectId: created.ticketId,
      revision: input.project.revision,
      status: "resolved",
      payload: { rebuildTicketId: created.ticketId, status: "submitted" },
    },
  });
}

const IN_FLIGHT_DEPLOYMENT_STATUSES = [
  "reserved",
  "deploying",
  "verifying",
] as const;

const NONTERMINAL_BUILD_STATUSES = [
  "preparing",
  "visual_searching",
  "awaiting_visual_selection",
  "design_compiling",
  "contract_ready",
  "building",
  "qa_running",
] as const;

export function assertSiteOpsSnapshotChangeState(input: {
  sameSnapshot: boolean;
  activeBuild: boolean;
  activeDeployment: boolean;
  activeVisualSearch: boolean;
}) {
  if (input.sameSnapshot) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选知识库已经是当前版本。",
      409,
    );
  }
  if (input.activeBuild || input.activeDeployment || input.activeVisualSearch) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前仍有视觉检索、建站或发布任务在运行；完成后才能重新连接知识库。",
      409,
    );
  }
}

/**
 * The project row is already locked by actOnSiteOps. Locking the matching
 * deployment row as well makes admission explicit and prevents a second
 * request for the same target from reserving another ESA side effect. An
 * identical clientRequestId is replayed before reaching this boundary.
 */
export async function assertSiteOpsDeploymentTargetAvailable(
  tx: any,
  input: {
    projectId: string;
    target: "global_excluding_cn" | "mainland_cn";
  },
) {
  const rows = await tx
    .select({
      id: siteDeployments.id,
      buildId: siteDeployments.buildId,
      intent: siteDeployments.intent,
      status: siteDeployments.status,
    })
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.projectId, input.projectId),
        inArray(siteDeployments.status, IN_FLIGHT_DEPLOYMENT_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  if (rows[0]) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      `当前域名已有${rows[0].intent === "rollback" ? "回滚" : "发布"}任务正在${rows[0].status === "verifying" ? "验证" : "处理"}，不同发布区域不能同时操作。`,
      409,
    );
  }
}

async function handleSelectSnapshot(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { knowledgeSnapshotId?: string };
  },
) {
  if (input.project.status !== "draft") {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前官网任务已经连接知识库；如需重新开始，请先提交官网重置申请。",
      409,
    );
  }
  const lockedUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.actor.id))
    .limit(1)
    .for("update");
  if (!lockedUsers[0]) {
    throw new SiteOpsServiceError(
      "NOT_FOUND",
      "当前账号不可用，请刷新后重新登录。",
      404,
    );
  }
  const rows = await tx
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.userId, input.actor.id),
        eq(knowledgeBaseSnapshots.status, "active"),
      ),
    )
    .orderBy(
      desc(knowledgeBaseSnapshots.version),
      desc(knowledgeBaseSnapshots.createdAt),
      desc(knowledgeBaseSnapshots.id),
    )
    .limit(200)
    .for("update");
  const snapshot = rows.find(
    (row: typeof knowledgeBaseSnapshots.$inferSelect) =>
      siteOpsKnowledgeSnapshotAvailable(row),
  );
  if (!snapshot) {
    throw new SiteOpsServiceError(
      "NOT_FOUND",
      "当前账号还没有可用于建站的已发布知识库",
      404,
    );
  }
  if (
    input.payload.knowledgeSnapshotId &&
    input.payload.knowledgeSnapshotId !== snapshot.id
  ) {
    throw new SiteOpsServiceError(
      "REVISION_CONFLICT",
      "当前知识库已更新，请刷新后从当前知识库开始建站。",
      409,
    );
  }
  const brief = siteBriefFromSnapshot(snapshot);
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      knowledgeSnapshotId: snapshot.id,
      knowledgeArchiveHash: snapshot.archiveHash,
    },
    kind: "brief_message",
    status: "succeeded",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: "从当前企业知识库开始建站",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      "已连接当前企业知识库，FrontMind 正在整理建站资料；未确认的信息不会写入官网。",
    siteOps: {
      kind: "brief_question",
      subjectId: input.project.id,
      revision: input.project.revision + 1,
      status: "active",
      payload: { knowledgeSnapshotId: snapshot.id },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: snapshot.id,
      brief,
      primaryLanguage: brief.primaryLanguage,
      status: "collecting_brief",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
}

export function visualSearchAllowedForProjectStatus(
  status: string,
  reselect = false,
) {
  return (
    reselect
      ? [
          "awaiting_visual_selection",
          "visual_searching",
          "failed",
          "attention_required",
        ]
      : ["collecting_brief"]
  ).includes(status);
}

async function handleVisualSearch(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: Record<string, unknown>;
    reselect?: boolean;
    expectedCredential?: TwentyFirstReferenceAdmission;
  },
) {
  if (
    !visualSearchAllowedForProjectStatus(input.project.status, input.reselect)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      input.reselect
        ? "当前建站任务尚未结束，不能并行重新检索视觉方向。"
        : "当前阶段不能开始视觉检索。",
      409,
    );
  }
  if (!input.project.currentKnowledgeSnapshotId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先从当前企业知识库开始建站。",
      409,
    );
  }
  if (input.reselect) {
    const existingBuilds = await tx
      .select({ id: siteBuilds.id })
      .from(siteBuilds)
      .where(
        and(
          eq(siteBuilds.projectId, input.project.id),
          eq(siteBuilds.userId, input.actor.id),
          gte(siteBuilds.createdAt, input.project.currentTaskStartedAt),
          notInArray(siteBuilds.status, ["cancelled", "superseded"]),
        ),
      )
      .limit(1)
      .for("update");
    if (existingBuilds[0]) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "当前周期已经生成官网版本；如需更换视觉方案，请先完成官网重制重置。",
        409,
      );
    }
  }
  const currentVisualBatches = await tx
    .select({
      id: websiteStyleSampleBatches.id,
      engineerNote: websiteStyleSampleBatches.engineerNote,
      status: websiteStyleSampleBatches.status,
    })
    .from(websiteStyleSampleBatches)
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        ne(websiteStyleSampleBatches.status, "superseded"),
        gte(
          websiteStyleSampleBatches.createdAt,
          input.project.currentTaskStartedAt,
        ),
      ),
    )
    .limit(STATIC_TEMPLATE_CATALOG_PAGE_COUNT)
    .for("update");
  const currentPublishedBatches = currentVisualBatches.filter(
    (batch: { status: string }) => batch.status === "published",
  );
  const visualOperationRows = await tx
    .select({
      id: siteOperations.id,
      input: siteOperations.input,
      status: siteOperations.status,
      provider: siteOperations.provider,
      createdAt: siteOperations.createdAt,
      updatedAt: siteOperations.updatedAt,
      startedAt: siteOperations.startedAt,
      completedAt: siteOperations.completedAt,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.actor.id),
        eq(siteOperations.kind, "visual_search"),
        gte(siteOperations.createdAt, input.project.currentTaskStartedAt),
      ),
    )
    .for("update");
  const parsedVisualInputs = visualOperationRows.map(
    (row: { input: unknown }) =>
      visualSearchOperationInputSchema.safeParse(row.input),
  );
  if (
    parsedVisualInputs.some(
      (result: { success: boolean }) => !result.success,
    ) ||
    visualOperationRows.some(
      (row: { provider: string | null }) => row.provider !== "21st",
    )
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮视觉候选的冻结工作流无法核验，请重置后重新检索。",
      409,
    );
  }
  if (visualOperationRows.length === 0 && currentVisualBatches.length > 0) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "现有视觉候选缺少可核验的冻结工作流坐标，请重置后重新检索。",
      409,
    );
  }
  const frozenVisualInputs: VisualSearchOperationInput[] =
    parsedVisualInputs.map(
      (result: { data?: VisualSearchOperationInput }) => result.data!,
    );
  if (
    frozenVisualInputs.some(
      (frozen) =>
        frozen.knowledgeSnapshotId !== input.project.currentKnowledgeSnapshotId,
    )
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮视觉候选与当前知识库不一致，请重置后重新检索。",
      409,
    );
  }
  const frozenWorkflowVersion =
    frozenVisualInputs.length > 0
      ? siteOpsVisualCycleWorkflowVersion(frozenVisualInputs)
      : SITEOPS_DEFAULT_WORKFLOW.frontMindVersion;
  const staticCatalogVisualCycle =
    frozenVisualInputs.length === 0 ||
    frozenVisualInputs.some(
      (frozen) =>
        "schemaVersion" in frozen &&
        (frozen.schemaVersion === 3 || frozen.schemaVersion === 4) &&
        isStaticCatalogWorkflowVersion(frozen.workflowVersion),
    );
  const historicalCredentialCoordinates = new Set(
    staticCatalogVisualCycle
      ? []
      : frozenVisualInputs.map((frozen) =>
          "credentialId" in frozen
            ? `${frozen.credentialId}:${frozen.credentialVersion}`
            : "",
        ),
  );
  if (!staticCatalogVisualCycle && historicalCredentialCoordinates.size !== 1) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮视觉候选的冻结检索凭据不一致，请重置后重新检索。",
      409,
    );
  }
  const activeVisualRows = visualOperationRows.filter(
    (row: { status: string }) =>
      ACTIVE_VISUAL_OPERATION_STATUSES.has(row.status),
  );
  if (activeVisualRows[0]) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前视觉候选仍在生成，请等待本次生成完成后再试。",
      409,
    );
  }
  if (input.reselect && staticCatalogVisualCycle) {
    if (currentVisualBatches.length > 0) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "内置模板已载入，请直接选择；状态异常时请重置后重新开始。",
        409,
      );
    }
    const latestVisualOperation = [...visualOperationRows].sort(
      compareSiteOpsVisualOperationsNewestFirst,
    )[0];
    if (
      latestVisualOperation &&
      !["failed", "attention_required"].includes(latestVisualOperation.status)
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "内置模板载入状态无法安全重试，请重置后重新开始。",
        409,
      );
    }
  }
  if (input.reselect && !staticCatalogVisualCycle) {
    const cycleOperationsById = new Map(
      visualOperationRows.map((row: { id: string }) => [row.id, row]),
    );
    for (const batch of currentPublishedBatches) {
      const operationId = batch.engineerNote?.startsWith(
        TWENTY_FIRST_OPERATION_MARKER_PREFIX,
      )
        ? batch.engineerNote.slice(TWENTY_FIRST_OPERATION_MARKER_PREFIX.length)
        : "";
      const frozenOperation = cycleOperationsById.get(operationId) as
        | { status: string }
        | undefined;
      if (
        !uuidSchema.safeParse(operationId).success ||
        frozenOperation?.status !== "succeeded"
      ) {
        throw new SiteOpsServiceError(
          "STATE_CONFLICT",
          "现有视觉候选的冻结工作流无法核验，请重置后重新检索。",
          409,
        );
      }
    }
  }
  if (
    input.reselect &&
    currentPublishedBatches.length >= STATIC_TEMPLATE_CATALOG_PAGE_COUNT
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "固定目录的 32 个完整 Template 已全部展示，请直接选择一个方向。",
      409,
    );
  }
  if (
    input.reselect &&
    currentPublishedBatches.length >= SITEOPS_VISUAL_CANDIDATE_MAX_PAGES
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "本轮已生成全部 27 个视觉候选，请从三个候选组中选择一个方向。",
      409,
    );
  }
  const readiness = visualSearchReadiness(input.project.brief);
  if (!readiness.ready) {
    if (readiness.reason !== "no_public_facts") {
      console.error("[SiteOps] visual_search_readiness_failed", {
        event: "siteops_visual_search_readiness_failed",
        projectId: input.project.id,
        projectRevision: input.project.revision,
        reason: readiness.reason,
        routeId: readiness.routeId ?? null,
      });
    }
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      readiness.reason === "no_public_facts"
        ? "当前知识库没有足够的可公开事实与来源，需先补齐知识库后再检索视觉方向。"
        : "FrontMind暂时无法整理建站资料，请刷新后重试。",
      409,
    );
  }
  const mode =
    !staticCatalogVisualCycle && currentPublishedBatches.length > 0
      ? ("supplemental" as const)
      : ("initial" as const);
  const page = (mode === "initial" ? 1 : currentPublishedBatches.length + 1) as
    | 1
    | 2
    | 3;
  const staticCatalog = staticCatalogVisualCycle
    ? await requireActiveStaticTemplateCatalog()
    : null;
  const credential = staticCatalogVisualCycle
    ? null
    : await ensureActiveProviderCredential(tx, "site_builder_21st");
  if (
    credential &&
    input.expectedCredential &&
    (credential.version !== input.expectedCredential.version ||
      credential.fingerprint !== input.expectedCredential.fingerprint)
  ) {
    throw new SiteOpsServiceError(
      "CREDENTIAL_ROTATED",
      "21st 视觉参考连接已更新，请刷新后重试。",
      409,
    );
  }
  const workflowVersion = staticCatalogVisualCycle
    ? frozenWorkflowVersion
    : mode === "supplemental"
      ? await frozenSupplementalVisualWorkflowVersion(tx, {
          batches: currentPublishedBatches,
          projectId: input.project.id,
          userId: input.actor.id,
          knowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
          credentialId: credential!.id,
          credentialVersion: credential!.version,
        })
      : frozenWorkflowVersion;
  if (!staticCatalogVisualCycle && mode === "initial") {
    const expectedHistoricalCredential =
      [...historicalCredentialCoordinates][0] ?? "";
    if (
      expectedHistoricalCredential !==
      `${credential!.id}:${credential!.version}`
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "本轮视觉候选与当前检索凭据不一致，请重置后重新检索。",
        409,
      );
    }
  }
  const admissionRevision = input.project.revision + 1;
  const operationPayload = createVisualSearchOperationInput(
    staticCatalogVisualCycle
      ? workflowVersion === SITEOPS_MATERIALIZER_V2_9.frontMindVersion
        ? {
            schemaVersion: 4,
            knowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
            workflowVersion: SITEOPS_MATERIALIZER_V2_9.frontMindVersion,
            catalogVersion: staticCatalog!.catalogVersion,
            mode: "initial",
            page: 1,
            admissionRevision,
          }
        : {
            schemaVersion: 3,
            knowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
            workflowVersion: SITEOPS_MATERIALIZER_V2_8.frontMindVersion,
            catalogVersion: staticCatalog!.catalogVersion,
            mode: "initial",
            page: 1,
            admissionRevision,
          }
      : {
          schemaVersion: 2,
          knowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
          credentialId: credential!.id,
          credentialVersion: credential!.version,
          workflowVersion,
          mode,
          page,
          admissionRevision,
        },
  );
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: operationPayload,
    kind: "visual_search",
    provider: "21st",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: staticCatalogVisualCycle
      ? "正在载入 32 个固定完整 Template，完成后将按四页展示。"
      : `正在生成第 ${page} 组全新视觉候选；前面展示过的参考不会重复。`,
    siteOps: {
      kind: "build_progress",
      subjectId: operationId,
      revision: admissionRevision,
      status: "active",
      payload: {
        stage: "visual_searching",
        targets: staticCatalogVisualCycle
          ? [
              STATIC_TEMPLATE_CATALOG_PAGE_COUNT *
                STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
            ]
          : [18, 12, 9],
        page,
        mode,
      },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      status:
        mode === "supplemental"
          ? "awaiting_visual_selection"
          : "visual_searching",
      revision: admissionRevision,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
  console.info("[SiteOps] visual_generation_admitted", {
    event: "siteops_visual_generation_admitted",
    operationId,
    projectId: input.project.id,
    mode,
    page,
    admissionRevision,
  });
}

async function selectVisualSample(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
    turnId: string;
    requestId: string;
    requestHash: string;
    rebuildRequest: Awaited<ReturnType<typeof loadSiteOpsRebuildRequest>>;
    sampleId?: string;
    batchId?: string;
    delegated: boolean;
  },
) {
  if (!input.project.currentKnowledgeSnapshotId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先从当前企业知识库开始建站。",
      409,
    );
  }
  const buildAttemptRows = await tx
    .select({ id: siteBuilds.id, status: siteBuilds.status })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.actor.id),
        gte(siteBuilds.createdAt, input.project.currentTaskStartedAt),
        notInArray(siteBuilds.status, ["cancelled", "superseded"]),
      ),
    )
    .orderBy(desc(siteBuilds.ordinal))
    .limit(50)
    .for("update");
  if (
    buildAttemptRows.some((row: { status: string }) =>
      NONTERMINAL_BUILD_STATUSES.includes(
        row.status as (typeof NONTERMINAL_BUILD_STATUSES)[number],
      ),
    )
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前已有建站任务在运行，不能并行创建第二个根版本。",
      409,
    );
  }
  const activeVisualRows = await tx
    .select({ id: siteOperations.id })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.actor.id),
        eq(siteOperations.kind, "visual_search"),
        gte(siteOperations.createdAt, input.project.currentTaskStartedAt),
        inArray(siteOperations.status, [
          "queued",
          "running",
          "outcome_unknown",
        ]),
      ),
    )
    .limit(1);
  if (activeVisualRows[0]) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "新的视觉候选仍在生成，完成后即可选择。",
      409,
    );
  }
  let recoveredSelection = false;
  if (input.project.status !== "awaiting_visual_selection") {
    const latestVisualRows = await tx
      .select({
        id: siteOperations.id,
        status: siteOperations.status,
        input: siteOperations.input,
        createdAt: siteOperations.createdAt,
        updatedAt: siteOperations.updatedAt,
        startedAt: siteOperations.startedAt,
        completedAt: siteOperations.completedAt,
      })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.actor.id),
          eq(siteOperations.kind, "visual_search"),
          gte(siteOperations.createdAt, input.project.currentTaskStartedAt),
        ),
      )
      .orderBy(desc(siteOperations.createdAt))
      .limit(10)
      .for("update");
    const latestVisualOperation = [...latestVisualRows].sort(
      compareSiteOpsVisualOperationsNewestFirst,
    )[0];
    const latestVisualInput = latestVisualOperation?.input as
      | Record<string, unknown>
      | undefined;
    const recoveryStaticCatalog = isStaticCatalogWorkflowVersion(
      typeof latestVisualInput?.workflowVersion === "string"
        ? latestVisualInput.workflowVersion
        : null,
    );
    const recoveryPageCount = recoveryStaticCatalog
      ? STATIC_TEMPLATE_CATALOG_PAGE_COUNT
      : SITEOPS_VISUAL_CANDIDATE_MAX_PAGES;
    const recoveryPageSize = recoveryStaticCatalog
      ? STATIC_TEMPLATE_CATALOG_PAGE_SIZE
      : SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE;
    const publishedRows = await tx
      .select({ id: websiteStyleSampleBatches.id })
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
          eq(websiteStyleSampleBatches.userId, input.actor.id),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.status, "published"),
          gte(
            websiteStyleSampleBatches.createdAt,
            input.project.currentTaskStartedAt,
          ),
        ),
      )
      .limit(recoveryPageCount)
      .for("update");
    const publishedIds = publishedRows.map((row: { id: string }) => row.id);
    const publishedSamples =
      publishedIds.length > 0
        ? await tx
            .select({ batchId: websiteStyleSamples.batchId })
            .from(websiteStyleSamples)
            .where(inArray(websiteStyleSamples.batchId, publishedIds))
            .limit(recoveryPageCount * recoveryPageSize)
        : [];
    const samplesPerBatch = new Map<string, number>();
    for (const row of publishedSamples as Array<{ batchId: string }>) {
      samplesPerBatch.set(
        row.batchId,
        (samplesPerBatch.get(row.batchId) ?? 0) + 1,
      );
    }
    const completePublishedPages = publishedIds.filter(
      (id: string) => samplesPerBatch.get(id) === recoveryPageSize,
    ).length;
    recoveredSelection = siteOpsVisualSelectionRecovery({
      projectStatus: input.project.status,
      completePublishedPages,
      latestVisualOperationStatus: latestVisualOperation?.status ?? null,
      hasActiveVisualOperation: false,
      hasActiveBuild: false,
      hasBuildAttempt: buildAttemptRows.length > 0,
    });
    if (!recoveredSelection) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "当前阶段不能再次选择视觉方向；需要重选时请先创建新的视觉检索。",
        409,
      );
    }
  }
  if (recoveredSelection) {
    console.info("[SiteOps] visual_selection_recovered", {
      event: "siteops_visual_selection_recovered",
      projectId: input.project.id,
      projectStatus: input.project.status,
      projectRevision: input.project.revision,
    });
  }
  const batchId = input.batchId;
  const sampleRows = await tx
    .select({ sample: websiteStyleSamples, batch: websiteStyleSampleBatches })
    .from(websiteStyleSamples)
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        input.sampleId
          ? eq(websiteStyleSamples.id, input.sampleId)
          : batchId
            ? eq(websiteStyleSamples.batchId, batchId)
            : eq(websiteStyleSampleBatches.status, "published"),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
        gte(
          websiteStyleSampleBatches.createdAt,
          input.project.currentTaskStartedAt,
        ),
      ),
    );
  if (
    sampleRows.length < 1 ||
    sampleRows.length >
      STATIC_TEMPLATE_CATALOG_PAGE_COUNT * STATIC_TEMPLATE_CATALOG_PAGE_SIZE
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "视觉候选尚未准备完成，请刷新后重试。",
      409,
    );
  }
  const selectableRows = sampleRows as Array<{
    sample: typeof websiteStyleSamples.$inferSelect;
    batch: typeof websiteStyleSampleBatches.$inferSelect;
  }>;
  let selected = selectableRows[0];
  if (input.delegated) {
    const containsStaticCatalogRows = selectableRows.some(
      ({ sample }) =>
        sample.sourceMetadata &&
        typeof sample.sourceMetadata === "object" &&
        !Array.isArray(sample.sourceMetadata) &&
        (sample.sourceMetadata as Record<string, unknown>).renderer ===
          "frontmind_static_template_catalog_v1",
    );
    if (containsStaticCatalogRows) {
      const admittedStaticRows = selectableRows
        .flatMap((row) => {
          const parsed = staticTemplateSelectionMetadataSchema.safeParse(
            row.sample.sourceMetadata,
          );
          return parsed.success &&
            parsed.data.executionAdmission?.status === "admitted"
            ? [{ row, catalogPosition: parsed.data.catalogPosition }]
            : [];
        })
        .sort(
          (left, right) =>
            left.catalogPosition - right.catalogPosition ||
            left.row.sample.id.localeCompare(right.row.sample.id),
        );
      if (!admittedStaticRows[0]) {
        throw new SiteOpsServiceError(
          "STATE_CONFLICT",
          "固定模板目录尚无已完成 FrontMind 执行准入的候选。",
          409,
        );
      }
      selected = admittedStaticRows[0].row;
    } else {
      selected = [...selectableRows].sort(
        (left, right) =>
          Number(right.sample.sourceMetadata?.score ?? 0) -
          Number(left.sample.sourceMetadata?.score ?? 0),
      )[0];
    }
  }
  const selectedStaticTemplate =
    staticTemplateSelectionMetadataSchema.safeParse(
      selected?.sample.sourceMetadata,
    );
  const selectedClaimsStaticTemplate = Boolean(
    selected?.sample.sourceMetadata &&
      typeof selected.sample.sourceMetadata === "object" &&
      !Array.isArray(selected.sample.sourceMetadata) &&
      (selected.sample.sourceMetadata as Record<string, unknown>).renderer ===
        "frontmind_static_template_catalog_v1",
  );
  const selectedStaticPreviewCoordinateMatches = selectedStaticTemplate.success
    ? Boolean(
        selected?.sample.previewLocalAssetId &&
          selectedStaticTemplate.data.previewLocalAssetId ===
            selected.sample.previewLocalAssetId,
      )
    : true;
  if (selectedClaimsStaticTemplate && !selectedStaticTemplate.success) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选固定模板的执行准入证明无法通过校验。",
      409,
    );
  }
  if (
    selectedStaticTemplate.success &&
    selectedStaticTemplate.data.executionAdmission?.status !== "admitted"
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      selectedStaticTemplate.data.executionAdmission?.status === "unavailable"
        ? selectedStaticTemplate.data.executionAdmission.reason
        : "该模板尚未完成 FrontMind 执行准入，当前不可选择。",
      409,
    );
  }
  if (
    !selected?.sample.sourceMetadata ||
    (!selected.sample.previewLocalAssetId && !selectedStaticTemplate.success) ||
    !selectedStaticPreviewCoordinateMatches
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选视觉参考缺少受控预览或来源证明。",
      409,
    );
  }
  const selectedMetadata = selected.sample.sourceMetadata as unknown as Record<
    string,
    unknown
  >;
  const selectedMetadataRecord = selectedMetadata as unknown as Record<
    string,
    unknown
  >;
  const nativeVisual = isNativeVisualSelectionMetadata(selectedMetadataRecord);
  const selectedWorkflow = siteOpsWorkflowForVisualSelectionMetadata(
    selectedMetadataRecord,
  );
  const buildWorkflowCoordinates =
    siteOpsBuildWorkflowCoordinates(selectedWorkflow);
  if (!nativeVisual) {
    const selectedEvidence = visualEvidenceV1Schema.safeParse(
      selectedMetadata.visualEvidence,
    );
    if (
      !selectedEvidence.success ||
      selectedMetadata.providerItemKey !==
        selectedEvidence.data.providerItemKey ||
      createVisualEvidenceV1({
        evidenceKind: selectedEvidence.data.evidenceKind,
        providerItemKey: selectedEvidence.data.providerItemKey,
        metadataSha256: selectedEvidence.data.metadataSha256,
        providerResponseSha256: selectedEvidence.data.providerResponseSha256,
        previewSha256: selectedEvidence.data.previewSha256,
        taxonomyDerivationVersion:
          selectedEvidence.data.taxonomyDerivationVersion,
      }).evidenceSha256 !== selectedEvidence.data.evidenceSha256
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "所选视觉参考的冻结证据无法通过校验，请重新检索后选择。",
        409,
      );
    }
  }
  const referenceBlueprint = nativeVisual
    ? null
    : freezeSiteOpsReferenceBlueprint({
        sampleId: selected.sample.id,
        previewLocalAssetId: selected.sample.previewLocalAssetId,
        note: selected.sample.note,
        sourceMetadata: selectedMetadataRecord,
      });
  const snapshotRows = await tx
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.project.currentKnowledgeSnapshotId),
        eq(knowledgeBaseSnapshots.userId, input.actor.id),
      ),
    )
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot?.archiveHash) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前企业知识库校验尚未完成，暂时不能开始制作官网。",
      409,
    );
  }
  const credential = await resolvePinnedTwentyFirstCredentialForBatch(tx, {
    engineerNote: selected.batch.engineerNote,
    projectId: input.project.id,
    userId: input.actor.id,
    knowledgeSnapshotId: snapshot.id,
    workflowVersion: selectedWorkflow.frontMindVersion,
  });
  const aiCredential = await ensureActiveCustomerAiCredential(
    tx,
    input.actor.id,
  );
  const aiCredentialBinding = freezeSiteOpsCustomerAiCredential({
    credential: aiCredential,
  });
  const parentBuildId = input.project.currentBuildId;
  if (parentBuildId) {
    requireAcceptedSiteOpsRebuild(input.rebuildRequest);
  }
  const quotaPeriodId = await reserveSiteOpsDeliveryQuota(tx, {
    userId: input.actor.id,
    portal: input.entitlement,
    quotaPool: "website_content_publish",
  });
  const ordinalRows = await tx
    .select({ ordinal: max(siteBuilds.ordinal) })
    .from(siteBuilds)
    .where(eq(siteBuilds.projectId, input.project.id));
  const buildId = randomUUID();
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "selected", updatedAt: new Date() })
    .where(
      and(
        eq(websiteStyleSampleBatches.id, selected.batch.id),
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  if (!isStaticCatalogWorkflowVersion(selectedWorkflow.frontMindVersion)) {
    await tx
      .update(websiteStyleSampleBatches)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
          eq(websiteStyleSampleBatches.userId, input.actor.id),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.status, "published"),
          ne(websiteStyleSampleBatches.id, selected.batch.id),
        ),
      );
  }
  const selectedPoolPageRows = await tx
    .select({
      id: visualCandidatePoolPages.id,
      poolId: visualCandidatePoolPages.poolId,
    })
    .from(visualCandidatePoolPages)
    .where(eq(visualCandidatePoolPages.batchId, selected.batch.id))
    .limit(1)
    .for("update");
  if (selectedPoolPageRows[0]) {
    const now = new Date();
    await tx
      .update(visualCandidatePoolPages)
      .set({ status: "selected", updatedAt: now })
      .where(eq(visualCandidatePoolPages.id, selectedPoolPageRows[0].id));
    await tx
      .update(visualCandidatePoolPages)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(visualCandidatePoolPages.poolId, selectedPoolPageRows[0].poolId),
          ne(visualCandidatePoolPages.id, selectedPoolPageRows[0].id),
        ),
      );
    await tx
      .update(visualCandidatePools)
      .set({ status: "selected", updatedAt: now })
      .where(
        and(
          eq(visualCandidatePools.id, selectedPoolPageRows[0].poolId),
          eq(visualCandidatePools.status, "active"),
        ),
      );
  } else {
    // A legacy first page may predate candidate pools while page two/three
    // were frozen by the backfill path. Selecting that legacy page still
    // closes the task-scoped active pool so reserved pages cannot remain
    // customer-selectable or pinned forever.
    const activePoolRows = await tx
      .select({ id: visualCandidatePools.id })
      .from(visualCandidatePools)
      .where(
        and(
          eq(visualCandidatePools.projectId, input.project.id),
          eq(visualCandidatePools.userId, input.actor.id),
          eq(
            visualCandidatePools.taskStartedAt,
            input.project.currentTaskStartedAt,
          ),
          eq(visualCandidatePools.knowledgeSnapshotId, snapshot.id),
          eq(visualCandidatePools.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (activePoolRows[0]) {
      const now = new Date();
      await tx
        .update(visualCandidatePoolPages)
        .set({ status: "superseded", updatedAt: now })
        .where(eq(visualCandidatePoolPages.poolId, activePoolRows[0].id));
      await tx
        .update(visualCandidatePools)
        .set({ status: "superseded", updatedAt: now })
        .where(
          and(
            eq(visualCandidatePools.id, activePoolRows[0].id),
            eq(visualCandidatePools.status, "active"),
          ),
        );
    }
  }
  await tx.insert(siteBuilds).values({
    id: buildId,
    projectId: input.project.id,
    userId: input.actor.id,
    parentBuildId,
    quotaPeriodId,
    quotaState: "reserved",
    knowledgeSnapshotId: snapshot.id,
    knowledgeArchiveHash: snapshot.archiveHash,
    ordinal: Number(ordinalRows[0]?.ordinal ?? 0) + 1,
    ...buildWorkflowCoordinates,
    twentyFirstCredentialId: credential?.id ?? null,
    twentyFirstCredentialVersion: credential?.version ?? null,
    styleSampleId: selected.sample.id,
    styleRevision: input.project.revision,
    brief: input.project.brief ?? {},
    selectionHash:
      selected.batch.selectionBundleHash ??
      hashSiteOpsRequest(selected.sample.sourceMetadata),
    status: "preparing",
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      buildId,
      ...(parentBuildId ? { childBuildId: buildId, parentBuildId } : {}),
      styleSampleId: selected.sample.id,
      delegated: input.delegated,
      workflowVersion: selectedWorkflow.frontMindVersion,
      ...(referenceBlueprint ? { referenceBlueprint } : {}),
      ...aiCredentialBinding,
    },
    kind: parentBuildId ? "build_revision" : "site_build",
    buildId,
    provider: "manus",
  });
  if (parentBuildId === null && input.project.knowledgeInputEpochId !== null) {
    const release = process.env.FRONTMIND_BUILD_SHA?.trim() ?? "";
    console.info("[siteops] fresh_root_created", {
      event: "siteops_fresh_root_created",
      stage: "fresh_root_created",
      projectId: input.project.id,
      buildId,
      operationId,
      projectRevision: input.project.revision,
      releaseSha: /^[a-f0-9]{40}$/u.test(release) ? release : null,
    });
  }
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: input.delegated
      ? `已委托 AI 选择最高分视觉方向：${selected.sample.label}`
      : `已选择视觉方向：${selected.sample.label}`,
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "视觉方向已锁定，建站任务将自动继续，不需要第二次风格确认。",
    siteOps: {
      kind: "build_progress",
      subjectId: operationId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { stage: "preparing", buildId },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      ...(parentBuildId ? {} : { currentBuildId: buildId }),
      status: "building",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
}

async function handleApproveBuild(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { buildId: string };
  },
) {
  const rows = await tx
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, input.payload.buildId),
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.actor.id),
        gte(siteBuilds.createdAt, input.project.currentTaskStartedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!rows[0]) {
    throw new SiteOpsServiceError("NOT_FOUND", "官网版本不存在。", 404);
  }
  if (rows[0].status !== "preview_ready") {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "只有已通过 QA 的私有预览才能批准。",
      409,
    );
  }
  await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: input.payload,
    kind: "brief_message",
    buildId: rows[0].id,
    status: "succeeded",
  });
  const now = new Date();
  await tx
    .update(siteBuilds)
    .set({ status: "approved", approvedAt: now, updatedAt: now })
    .where(eq(siteBuilds.id, rows[0].id));
  await tx
    .update(siteProjects)
    .set({
      currentBuildId: rows[0].id,
      status: "approved",
      revision: input.project.revision + 1,
      updatedAt: now,
    })
    .where(eq(siteProjects.id, input.project.id));
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: "已批准当前官网预览。",
  });
}

async function handleRevision(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { buildId: string; feedback: string };
    inputAssets?: FrozenSiteOpsRevisionInputAsset[];
  },
) {
  if (!input.project.knowledgeInputEpochId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前任务不支持对话修订，请批准重置后重新生成官网。",
      409,
    );
  }
  const rows = await tx
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, input.payload.buildId),
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.actor.id),
        gte(siteBuilds.createdAt, input.project.currentTaskStartedAt),
      ),
    )
    .limit(1)
    .for("update");
  const parent = rows[0];
  if (
    !parent ||
    !["preview_ready", "approved", "failed", "attention_required"].includes(
      parent.status,
    )
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "只能修改已生成的私有预览版本。",
      409,
    );
  }
  if (!parent.styleSampleId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前官网版本缺少可冻结的视觉方案，请提交官网重制需求。",
      409,
    );
  }
  if (
    parent.workflowVersion !== SITEOPS_REVISION_WORKFLOW_VERSION ||
    !parent.sourceLocalAssetId ||
    !parent.sourceHash ||
    !parent.contentPlanLocalAssetId ||
    !parent.contentPlanSha256
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前预览缺少 2.9 修订源码或内容计划基线，请批准重置后重新生成官网。",
      409,
    );
  }
  const styleRows = await tx
    .select({ sample: websiteStyleSamples })
    .from(websiteStyleSamples)
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        eq(websiteStyleSamples.id, parent.styleSampleId),
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.actor.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        gte(
          websiteStyleSampleBatches.createdAt,
          input.project.currentTaskStartedAt,
        ),
      ),
    )
    .limit(1);
  const styleSample = styleRows[0]?.sample;
  if (!styleSample?.previewLocalAssetId || !styleSample.sourceMetadata) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前官网版本的视觉方案不完整，请提交官网重制需求。",
      409,
    );
  }
  const styleMetadata = styleSample.sourceMetadata as unknown as Record<
    string,
    unknown
  >;
  const nativeVisual = isNativeVisualSelectionMetadata(styleMetadata);
  const selectedWorkflow =
    siteOpsWorkflowForVisualSelectionMetadata(styleMetadata);
  const selectedWorkflowVersion: string = selectedWorkflow.frontMindVersion;
  if (selectedWorkflowVersion !== SITEOPS_REVISION_WORKFLOW_VERSION) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前视觉方案不支持连续修订，请批准重置后重新生成官网。",
      409,
    );
  }
  const buildWorkflowCoordinates =
    siteOpsBuildWorkflowCoordinates(selectedWorkflow);
  const derivedReferenceBlueprint = nativeVisual
    ? null
    : freezeSiteOpsReferenceBlueprint({
        sampleId: styleSample.id,
        previewLocalAssetId: styleSample.previewLocalAssetId,
        note: styleSample.note,
        sourceMetadata: styleSample.sourceMetadata,
      });
  const aiCredential = await ensureActiveCustomerAiCredential(
    tx,
    input.actor.id,
  );
  const parentOperationRows = await tx
    .select({ input: siteOperations.input })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.actor.id),
        eq(siteOperations.buildId, parent.id),
        gte(siteOperations.createdAt, input.project.currentTaskStartedAt),
        inArray(siteOperations.kind, ["site_build", "build_revision"]),
      ),
    )
    .orderBy(desc(siteOperations.createdAt))
    .limit(1);
  const parentOperationInput = parentOperationRows[0]?.input;
  const referenceBlueprint = derivedReferenceBlueprint
    ? referenceBlueprintForSiteOpsRevision({
        parentWorkflowVersion: parent.workflowVersion,
        parentOperationInput,
        derivedReferenceBlueprint,
      })
    : null;
  const aiCredentialBinding = freezeSiteOpsCustomerAiCredential({
    credential: aiCredential,
    parentOperationInput,
  });
  const quotaPeriodId = await reserveSiteOpsDeliveryQuota(tx, {
    userId: input.actor.id,
    portal: input.entitlement,
    quotaPool: "website_content_publish",
  });
  const ordinalRows = await tx
    .select({ ordinal: max(siteBuilds.ordinal) })
    .from(siteBuilds)
    .where(eq(siteBuilds.projectId, input.project.id));
  const buildId = randomUUID();
  await tx.insert(siteBuilds).values({
    id: buildId,
    projectId: parent.projectId,
    userId: parent.userId,
    knowledgeSnapshotId: parent.knowledgeSnapshotId,
    knowledgeArchiveHash: parent.knowledgeArchiveHash,
    parentBuildId: parent.id,
    quotaPeriodId,
    quotaState: "reserved",
    ordinal: Number(ordinalRows[0]?.ordinal ?? 0) + 1,
    // A revision is a new immutable build. Freeze the current workflow,
    // starter and materializer as one coordinate set instead of pairing the
    // current host runtime with a historical parent's contract.
    ...buildWorkflowCoordinates,
    twentyFirstCredentialId: parent.twentyFirstCredentialId,
    twentyFirstCredentialVersion: parent.twentyFirstCredentialVersion,
    styleSampleId: parent.styleSampleId,
    styleRevision: parent.styleRevision,
    brief: parent.brief,
    selectionHash: parent.selectionHash,
    status: "preparing",
  });
  const inputAssets = input.inputAssets ?? [];
  if (inputAssets.length > 0) {
    if (
      inputAssets.some(
        (asset) =>
          asset.taskStartedAt.getTime() !==
            input.project.currentTaskStartedAt.getTime() ||
          asset.siteOpsKnowledgeInputEpochId !==
            input.project.knowledgeInputEpochId,
      )
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "本次图片已不属于当前建站任务，请重新上传。",
        409,
      );
    }
    await tx.insert(siteBuildInputAssets).values(
      inputAssets.map((asset) => ({
        ...asset,
        buildId,
        projectId: input.project.id,
        userId: input.actor.id,
      })),
    );
    await tx
      .update(localAssets)
      .set({ retainUntil: null })
      .where(
        and(
          inArray(
            localAssets.id,
            inputAssets.map((asset) => asset.localAssetId),
          ),
          eq(localAssets.accountUserId, input.actor.id),
        ),
      );
  }
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      ...input.payload,
      childBuildId: buildId,
      workflowVersion: selectedWorkflowVersion,
      revisionBaseline: {
        schemaVersion: 1,
        parentBuildId: parent.id,
        sourceLocalAssetId: parent.sourceLocalAssetId,
        sourceSha256: parent.sourceHash,
        contentPlanLocalAssetId: parent.contentPlanLocalAssetId,
        contentPlanSha256: parent.contentPlanSha256,
      },
      revisionInputAssets: inputAssets.map((asset) => ({
        schemaVersion: 1,
        localAssetId: asset.localAssetId,
        filename: asset.filename,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        contentSha256: asset.contentSha256,
        width: asset.width,
        height: asset.height,
        publicPath: asset.publicPath,
        siteOpsKnowledgeInputEpochId: asset.siteOpsKnowledgeInputEpochId,
      })),
      ...(referenceBlueprint ? { referenceBlueprint } : {}),
      ...aiCredentialBinding,
    },
    kind: "build_revision",
    buildId,
    provider: "manus",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "user",
    turnId: input.turnId,
    content: input.payload.feedback,
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "已保留原版本并创建新的修改版本。",
    siteOps: {
      kind: "build_progress",
      subjectId: operationId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { stage: "revision", buildId, parentBuildId: parent.id },
    },
  });
  await tx
    .update(siteProjects)
    .set({
      status: "building",
      revision: input.project.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(siteProjects.id, input.project.id));
}

async function handlePublish(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { buildId: string; expectedHeadDeploymentId?: string };
    target: "global_excluding_cn" | "mainland_cn";
  },
) {
  requireEsaRuntimeConfigured();
  const [buildRows, profileRows] = await Promise.all([
    tx
      .select()
      .from(siteBuilds)
      .where(
        and(
          eq(siteBuilds.id, input.payload.buildId),
          eq(siteBuilds.projectId, input.project.id),
          eq(siteBuilds.userId, input.actor.id),
          gte(siteBuilds.createdAt, input.project.currentTaskStartedAt),
        ),
      )
      .limit(1),
    tx
      .select()
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.actor.id))
      .limit(1),
  ]);
  const build = buildRows[0];
  const profile = profileRows[0];
  if (
    !build ||
    build.id !== input.project.currentBuildId ||
    build.status !== "approved" ||
    !build.distLocalAssetId ||
    !build.distHash
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "只有已批准且具有固定 dist 摘要的版本才能发布。",
      409,
    );
  }
  if (
    !profile ||
    profile.domainStatus !== "completed" ||
    profile.domainOwnershipStatus !== "verified" ||
    profile.dnsStatus !== "active" ||
    !profile.normalizedAsciiDomain
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "域名与网站配置尚未完成验证。",
      409,
    );
  }
  if (
    input.target === "mainland_cn" &&
    !isSiteOpsIcpApprovedForCurrentDomain(profile)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "大陆发布需要当前域名版本已通过 ICP 备案。",
      409,
    );
  }
  const currentHead =
    input.target === "mainland_cn"
      ? input.project.mainlandLiveDeploymentId
      : input.project.globalLiveDeploymentId;
  if ((input.payload.expectedHeadDeploymentId ?? null) !== currentHead) {
    throw new SiteOpsServiceError(
      "REVISION_CONFLICT",
      "线上版本已变化，请刷新后重试。",
      409,
    );
  }
  await assertSiteOpsDeploymentTargetAvailable(tx, {
    projectId: input.project.id,
    target: input.target,
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: { ...input.payload, target: input.target },
    kind: "deploy",
    buildId: build.id,
    provider: "aliyun_esa",
  });
  const deploymentId = randomUUID();
  await tx.insert(siteDeployments).values({
    id: deploymentId,
    projectId: input.project.id,
    userId: input.actor.id,
    buildId: build.id,
    operationId,
    target: input.target,
    intent: "deploy",
    expectedHeadDeploymentId: currentHead,
    distLocalAssetId: build.distLocalAssetId,
    distHash: build.distHash,
    domainRevision: profile.domainRevision,
    status: "reserved",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "已锁定精确官网版本并提交发布任务。旧站会保留到新版本验证成功。",
    siteOps: {
      kind: "release_status",
      subjectId: deploymentId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { target: input.target, status: "reserved" },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

async function handleRollback(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { deploymentId: string };
  },
) {
  requireEsaRuntimeConfigured();
  const rows = await tx
    .select()
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.id, input.payload.deploymentId),
        eq(siteDeployments.projectId, input.project.id),
        eq(siteDeployments.userId, input.actor.id),
        gte(siteDeployments.createdAt, input.project.currentTaskStartedAt),
        inArray(siteDeployments.status, ["active", "superseded"]),
      ),
    )
    .limit(1);
  const targetDeployment = rows[0];
  const resetInvalidated = Boolean(
    targetDeployment?.verification &&
      typeof targetDeployment.verification === "object" &&
      !Array.isArray(targetDeployment.verification) &&
      (targetDeployment.verification as Record<string, unknown>)
        .resetInvalidated,
  );
  if (!targetDeployment || resetInvalidated) {
    throw new SiteOpsServiceError(
      "NOT_FOUND",
      "可回滚的历史发布版本不存在。",
      404,
    );
  }
  const currentHead =
    targetDeployment.target === "mainland_cn"
      ? input.project.mainlandLiveDeploymentId
      : input.project.globalLiveDeploymentId;
  if (currentHead === targetDeployment.id) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "所选版本已经是当前线上版本。",
      409,
    );
  }
  const profileRows = await tx
    .select()
    .from(workspaceSiteProfiles)
    .where(eq(workspaceSiteProfiles.userId, input.actor.id))
    .limit(1);
  const profile = profileRows[0];
  if (!profile || profile.domainRevision !== targetDeployment.domainRevision) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "历史版本属于不同的域名版本，不能直接回滚。",
      409,
    );
  }
  if (
    targetDeployment.target === "mainland_cn" &&
    (profile.icpStatus !== "approved" ||
      !profile.icpNumber ||
      profile.icpDomainRevision !== profile.domainRevision)
  ) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "大陆回滚仍需要当前域名版本已通过 ICP 备案。",
      409,
    );
  }
  await assertSiteOpsDeploymentTargetAvailable(tx, {
    projectId: input.project.id,
    target: targetDeployment.target,
  });
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      targetDeploymentId: targetDeployment.id,
      expectedHeadDeploymentId: currentHead,
      target: targetDeployment.target,
    },
    kind: "rollback",
    buildId: targetDeployment.buildId,
    provider: "aliyun_esa",
  });
  const deploymentId = randomUUID();
  await tx.insert(siteDeployments).values({
    id: deploymentId,
    projectId: input.project.id,
    userId: input.actor.id,
    buildId: targetDeployment.buildId,
    operationId,
    target: targetDeployment.target,
    intent: "rollback",
    rollbackOfDeploymentId: targetDeployment.id,
    expectedHeadDeploymentId: currentHead,
    distLocalAssetId: targetDeployment.distLocalAssetId,
    distHash: targetDeployment.distHash,
    domainRevision: targetDeployment.domainRevision,
    status: "reserved",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content: "已提交恢复历史官网版本；如验证未完成，当前线上网站不会变化。",
    siteOps: {
      kind: "release_status",
      subjectId: deploymentId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { target: targetDeployment.target, status: "reserved" },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

async function handleSocialPackage(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    entitlement: Awaited<ReturnType<typeof getServicePortal>>;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { topic?: string };
    channel: "wechat" | "xiaohongshu";
  },
) {
  if (!input.project.currentKnowledgeSnapshotId) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "请先从当前企业知识库开始建站。",
      409,
    );
  }
  const aiCredential = await ensureActiveCustomerAiCredential(
    tx,
    input.actor.id,
  );
  const aiCredentialBinding = freezeSiteOpsCustomerAiCredential({
    credential: aiCredential,
  });
  const quotaPeriodId = await reserveSiteOpsDeliveryQuota(tx, {
    userId: input.actor.id,
    portal: input.entitlement,
    quotaPool: "content_asset_publish",
  });
  const packageId = randomUUID();
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: {
      ...input.payload,
      channel: input.channel,
      packageId,
      ...aiCredentialBinding,
    },
    kind: "social_package",
    provider: "manus",
  });
  await tx.insert(socialPackages).values({
    id: packageId,
    projectId: input.project.id,
    userId: input.actor.id,
    knowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
    operationId,
    quotaPeriodId,
    quotaState: "reserved",
    channel: input.channel,
    status: "queued",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      input.channel === "wechat"
        ? "微信公众号内容包已进入生成队列。"
        : "小红书 01–09 内容包已进入生成队列。",
    siteOps: {
      kind: "social_package",
      subjectId: packageId,
      revision: input.project.revision + 1,
      status: "active",
      payload: { channel: input.channel, status: "queued" },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

async function requireAliyunConnection(tx: any, projectId: string) {
  const rows = await tx
    .select()
    .from(siteProviderConnections)
    .where(
      and(
        eq(siteProviderConnections.projectId, projectId),
        eq(siteProviderConnections.provider, "aliyun_cn"),
        eq(siteProviderConnections.status, "active"),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "请先一键连接阿里云账号。",
      412,
    );
  }
  if (
    process.env.FRONTMIND_ALIYUN_DOMAIN_ENABLED?.trim() !== "1" ||
    !siteOpsProviderConfigured("aliyun_alidns")
  ) {
    throw new SiteOpsServiceError(
      "PROVIDER_NOT_CONFIGURED",
      "域名解析服务尚未配置完成，请联系 FrontMind。",
      412,
    );
  }
  return rows[0];
}

async function handleDomainSync(
  tx: any,
  input: {
    actor: AuthenticatedUser;
    project: typeof siteProjects.$inferSelect;
    turnId: string;
    requestId: string;
    requestHash: string;
    payload: { domain: string; domainUnicode: string };
  },
) {
  const connection = await requireAliyunConnection(tx, input.project.id);
  const [activeRows, profileRows, dnsEvidence] = await Promise.all([
    tx
      .select({ id: siteOperations.id })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.project.id),
          eq(siteOperations.userId, input.actor.id),
          inArray(siteOperations.provider, ["aliyun_alidns", "aliyun_esa"]),
          inArray(siteOperations.status, [
            "queued",
            "running",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(1),
    tx
      .select({
        domain: workspaceSiteProfiles.domain,
        normalizedAsciiDomain: workspaceSiteProfiles.normalizedAsciiDomain,
        providerAccountUid: workspaceSiteProfiles.providerAccountUid,
        domainOwnershipStatus: workspaceSiteProfiles.domainOwnershipStatus,
        dnsStatus: workspaceSiteProfiles.dnsStatus,
      })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, input.actor.id))
      .limit(1),
    tx
      .select({ id: siteDnsRecords.id })
      .from(siteDnsRecords)
      .where(
        and(
          eq(siteDnsRecords.projectId, input.project.id),
          eq(siteDnsRecords.userId, input.actor.id),
        ),
      )
      .limit(1),
  ]);
  if (activeRows.length > 0) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前域名正在自动接入或等待解析确认，请稍后刷新。",
      409,
    );
  }
  const profile = profileRows[0];
  const sameDomain =
    profile?.normalizedAsciiDomain === input.payload.domain &&
    profile?.providerAccountUid === connection.accountUid;
  const hasExistingDomainState = Boolean(
    profile?.domain ||
      profile?.normalizedAsciiDomain ||
      profile?.providerAccountUid ||
      profile?.domainOwnershipStatus ||
      profile?.dnsStatus ||
      input.project.canonicalHostname ||
      input.project.globalLiveDeploymentId ||
      input.project.mainlandLiveDeploymentId ||
      dnsEvidence.length > 0,
  );
  if (!sameDomain && hasExistingDomainState) {
    throw new SiteOpsServiceError(
      "STATE_CONFLICT",
      "当前项目已接入其他域名，请先申请重置并完成安全下线。",
      409,
    );
  }
  const providerPayload = {
    connectionId: connection.id,
    domainIntent: "sync" as const,
    domain: input.payload.domain,
  };
  const operationId = await reserveOperation(tx, {
    actor: input.actor,
    project: input.project,
    turnId: input.turnId,
    clientRequestId: input.requestId,
    requestHash: input.requestHash,
    payload: providerPayload,
    kind: "domain_sync",
    provider: "aliyun_alidns",
  });
  await appendMessage(tx, {
    conversationId: input.project.conversationId,
    userId: input.actor.id,
    role: "assistant",
    turnId: input.turnId,
    content:
      "已选中域名，FrontMind 正在自动验证并配置解析；遇到已有记录冲突时会停止，不会覆盖。",
    siteOps: {
      kind: "domain_status",
      subjectId: operationId,
      revision: input.project.revision + 1,
      status: "active",
      payload: {
        action: "domain_sync",
        domain: input.payload.domain,
        status: "reserved",
      },
    },
  });
  await tx
    .update(siteProjects)
    .set({ revision: input.project.revision + 1, updatedAt: new Date() })
    .where(eq(siteProjects.id, input.project.id));
}

async function projectSiteOpsActionAck(
  executor: any,
  input: {
    actorId: number;
    projectId: string;
    conversationId: string;
    clientRequestId: string;
  },
): Promise<SiteOpsActionAckV1> {
  const [projectRows, operationRows, sequenceRows] = await Promise.all([
    executor
      .select({
        revision: siteProjects.revision,
        status: siteProjects.status,
      })
      .from(siteProjects)
      .where(
        and(
          eq(siteProjects.id, input.projectId),
          eq(siteProjects.userId, input.actorId),
        ),
      )
      .limit(1),
    executor
      .select({ id: siteOperations.id })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, input.projectId),
          eq(siteOperations.userId, input.actorId),
          eq(siteOperations.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1),
    executor
      .select({ sequence: max(messages.sequence) })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          isNull(messages.deletedAt),
        ),
      ),
  ]);
  const project = projectRows[0];
  if (!project) {
    throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
  }
  return siteOpsActionAckV1Schema.parse({
    schemaVersion: 1,
    accepted: true,
    clientRequestId: input.clientRequestId,
    operationId: operationRows[0]?.id ?? null,
    projectRevision: project.revision,
    latestSequence: Number(sequenceRows[0]?.sequence ?? 0),
    interactionState:
      project.status === "draft" ? "select_snapshot" : project.status,
  });
}

export async function actOnSiteOpsFast(
  actor: AuthenticatedUser,
  value: unknown,
) {
  assertEnabled();
  assertCustomer(actor);
  const input = siteOpsActInputSchema.parse(value);
  const entitlement = await requireSiteOpsEntitlement(actor.id);
  const payload = parseSiteOpsActionPayload(
    input.action,
    input.input,
  ) as Record<string, unknown>;
  const requestHash = hashSiteOpsRequest({ action: input.action, payload });
  const db = await requireDb();
  let visualSelectionProjectId: string | null = null;
  const transaction = db.transaction(async (tx: any) => {
    const project = await loadOwnedProject(
      tx,
      actor.id,
      input.conversationId,
      true,
    );
    if (!project) {
      throw new SiteOpsServiceError("NOT_FOUND", "AI 建站会话不存在。", 404);
    }
    visualSelectionProjectId = project.id;
    const resetGate = await loadSiteOpsRebuildRequest(tx, {
      userId: actor.id,
      projectId: project.id,
      currentBuildId: project.currentBuildId,
      hasWorkflowProgress: true,
    });
    if (
      resetGate.resetPending &&
      siteOpsResetPendingBlocksAction(input.action)
    ) {
      throw new SiteOpsServiceError(
        "STATE_CONFLICT",
        "旧网站正在安全下线；完成前可以继续本地建站，但不能发起新的发布或域名操作。",
        409,
      );
    }
    const existing = await tx
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.clientRequestId, input.clientRequestId),
          gte(siteOperations.createdAt, project.currentTaskStartedAt),
        ),
      )
      .limit(1);
    const existingTurns = await tx
      .select({
        id: conversationTurns.id,
        requestHash: conversationTurns.requestHash,
        metadata: conversationTurns.metadata,
      })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, project.conversationId),
          eq(conversationTurns.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    const existingTurn = existingTurns[0];
    const operationReplay = isSiteOpsOperationReplay(existing[0], requestHash);
    const turnReplay = isSiteOpsOperationReplay(
      existingTurn ? { inputHash: existingTurn.requestHash ?? "" } : undefined,
      requestHash,
    );
    if (operationReplay || turnReplay) {
      const storedAck = siteOpsActionAckV1Schema.safeParse(
        existingTurn?.metadata?.actFastAck,
      );
      if (storedAck.success) return storedAck.data;
      const replayAck = await projectSiteOpsActionAck(tx, {
        actorId: actor.id,
        projectId: project.id,
        conversationId: project.conversationId,
        clientRequestId: input.clientRequestId,
      });
      if (existingTurn) {
        await tx
          .update(conversationTurns)
          .set({
            metadata: {
              ...(existingTurn.metadata ?? {}),
              actFastAck: replayAck,
            },
          })
          .where(eq(conversationTurns.id, existingTurn.id));
      }
      return replayAck;
    }
    if (project.revision !== input.expectedRevision) {
      throw new SiteOpsServiceError(
        "REVISION_CONFLICT",
        "建站项目已更新，请刷新后重试。",
        409,
      );
    }
    if (input.messageId) {
      const cardMessages = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.conversationId, project.conversationId),
            eq(messages.userId, actor.id),
            isNull(messages.deletedAt),
            gte(messages.sentAt, project.currentTaskStartedAt),
          ),
        )
        .limit(1);
      const siteOps = cardMessages[0]?.metadata?.siteOps as
        | Record<string, unknown>
        | undefined;
      if (
        !siteOps ||
        (input.cardKind && siteOps.kind !== input.cardKind) ||
        Number(siteOps.revision) !== input.expectedRevision ||
        siteOps.status !== "active"
      ) {
        throw new SiteOpsServiceError(
          "REVISION_CONFLICT",
          "该操作卡片已过期，请刷新后重试。",
          409,
        );
      }
    }
    const turnId = await createActionTurn(tx, {
      actor,
      project,
      requestId: input.clientRequestId,
      requestHash,
      action: input.action,
    });
    const common = {
      actor,
      project,
      entitlement,
      turnId,
      requestId: input.clientRequestId,
      requestHash,
    };
    switch (input.action) {
      case "request_rebuild":
        await handleRequestRebuild(tx, {
          ...common,
          payload: payload as { reason?: string },
        });
        break;
      case "select_snapshot":
        await handleSelectSnapshot(tx, {
          ...common,
          payload: payload as { knowledgeSnapshotId?: string },
        });
        break;
      case "start_visual_search":
        await handleVisualSearch(tx, {
          ...common,
          payload,
        });
        break;
      case "reselect_visual":
        await handleVisualSearch(tx, {
          ...common,
          payload,
          reselect: true,
        });
        break;
      case "select_visual":
        await selectVisualSample(tx, {
          ...common,
          rebuildRequest: resetGate,
          sampleId: String(payload.sampleId),
          delegated: false,
        });
        break;
      case "delegate_visual":
        await selectVisualSample(tx, {
          ...common,
          rebuildRequest: resetGate,
          delegated: true,
        });
        break;
      case "approve_build":
        await handleApproveBuild(tx, {
          ...common,
          payload: payload as { buildId: string },
        });
        break;
      case "request_revision":
        await handleRevision(tx, {
          ...common,
          payload: payload as { buildId: string; feedback: string },
        });
        break;
      case "publish_global":
      case "publish_mainland":
        await handlePublish(tx, {
          ...common,
          payload: payload as {
            buildId: string;
            expectedHeadDeploymentId?: string;
          },
          target:
            input.action === "publish_mainland"
              ? "mainland_cn"
              : "global_excluding_cn",
        });
        break;
      case "create_wechat_package":
      case "create_xiaohongshu_package":
        await handleSocialPackage(tx, {
          ...common,
          payload: payload as { topic?: string },
          channel:
            input.action === "create_wechat_package" ? "wechat" : "xiaohongshu",
        });
        break;
      case "rollback":
        await handleRollback(tx, {
          ...common,
          payload: payload as { deploymentId: string },
        });
        break;
      case "domain_sync":
        await handleDomainSync(tx, {
          ...common,
          payload: payload as { domain: string; domainUnicode: string },
        });
        break;
    }
    const ack = await projectSiteOpsActionAck(tx, {
      actorId: actor.id,
      projectId: project.id,
      conversationId: project.conversationId,
      clientRequestId: input.clientRequestId,
    });
    await tx
      .update(conversationTurns)
      .set({
        metadata: {
          executionKind: "site_ops",
          action: input.action,
          actFastAck: ack,
        },
      })
      .where(eq(conversationTurns.id, turnId));
    return ack;
  });
  return transaction.catch((error: unknown) => {
    if (
      (input.action !== "select_visual" &&
        input.action !== "delegate_visual") ||
      error instanceof SiteOpsServiceError ||
      !isSiteOpsPersistenceDatabaseError(error)
    ) {
      throw error;
    }
    const release = process.env.FRONTMIND_BUILD_SHA?.trim() ?? "";
    console.error("[SiteOps] visual_selection_persistence_failed", {
      event: "siteops_visual_selection_persistence_failed",
      action: input.action,
      stage: "transaction",
      projectId: visualSelectionProjectId,
      expectedRevision: input.expectedRevision,
      releaseSha: /^[a-f0-9]{40}$/u.test(release) ? release : null,
      ...safeSiteOpsPersistenceDiagnostics(error),
      transactionOutcome: siteOpsPersistenceTransactionOutcome(error),
    });
    throw new SiteOpsServiceError(
      "VISUAL_SELECTION_PERSISTENCE_FAILED",
      "建站任务未能创建，所选模板尚未生效。无需重新载入模板，请重试选择。",
      503,
    );
  });
}

export async function actOnSiteOps(actor: AuthenticatedUser, value: unknown) {
  const input = siteOpsActInputSchema.parse(value);
  await actOnSiteOpsFast(actor, input);
  return observeSiteOps(actor, { conversationId: input.conversationId });
}
