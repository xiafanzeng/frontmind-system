import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  like,
  lte,
  or,
} from "drizzle-orm";

import {
  monitoringBatches,
  monitoringCitationRecords,
  monitoringSamples,
  users,
  workspaceQuestions,
} from "../drizzle/schema";
import type {
  ListMonitoringCitationsInput,
  ListMonitoringSampleCitationsInput,
  ListMonitoringSamplesInput,
  MonitoringCitationSummaryInput,
  MonitoringFilterOptionsInput,
  ReplaceMonitoringBatchInput,
} from "../shared/monitoring";
import type { DashboardMonitoringCurrentTemplate } from "../shared/dashboard";
import type { ServicePortal } from "../shared/service-portal";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { assertWorkspaceAccess } from "./dashboard-service";
import { getDb } from "./db";
import {
  assertServiceCapability,
  getServicePortal,
} from "./service-entitlement";

type MonitoringQuestion = {
  id: string;
  question: string;
};

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function parseDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "监控数据日期格式无效");
  }
  return date;
}

function optionalDate(value?: string) {
  return value ? parseDate(value) : null;
}

const BEIJING_TIME_ZONE_OFFSET = "+08:00";

export function parseMonitoringDateBoundary(
  value: string,
  boundary: "from" | "to",
) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = new Date(`${value}T00:00:00${BEIJING_TIME_ZONE_OFFSET}`);
    if (!Number.isFinite(start.getTime())) {
      throw new AuthServiceError("INVALID_CREDENTIAL", "监控数据日期格式无效");
    }
    return boundary === "from"
      ? start
      : new Date(start.getTime() + 24 * 60 * 60 * 1_000 - 1);
  }
  return parseDate(value);
}

export function monitoringBeijingDate(value: Date | number | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function latestMonitoringBatchesByBeijingDate<
  T extends {
    collectedAt: Date | number | string;
    updatedAt?: Date | number | string;
    revision?: number;
  },
>(batches: readonly T[]) {
  const selected = new Map<string, T>();
  const timestamp = (value: Date | number | string | undefined) => {
    if (value === undefined) return Number.NEGATIVE_INFINITY;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime())
      ? date.getTime()
      : Number.NEGATIVE_INFINITY;
  };
  for (const batch of batches) {
    const dateKey = monitoringBeijingDate(batch.collectedAt);
    if (!dateKey) continue;
    const current = selected.get(dateKey);
    if (
      !current ||
      timestamp(batch.updatedAt) > timestamp(current.updatedAt) ||
      (timestamp(batch.updatedAt) === timestamp(current.updatedAt) &&
        Number(batch.revision || 0) > Number(current.revision || 0)) ||
      (timestamp(batch.updatedAt) === timestamp(current.updatedAt) &&
        Number(batch.revision || 0) === Number(current.revision || 0) &&
        timestamp(batch.collectedAt) > timestamp(current.collectedAt))
    ) {
      selected.set(dateKey, batch);
    }
  }
  return [...selected.entries()].sort(([left], [right]) =>
    right.localeCompare(left),
  );
}

const modelAliases: ReadonlyArray<[RegExp, string]> = [
  [/(?:chatgpt|openai|gpt)/i, "chatgpt"],
  [/deep[\s_-]*seek/i, "deepseek"],
  [/(?:豆包|dou[\s_-]*bao)/i, "doubao"],
  [/(?:通义千问|千问|tongyi|qianwen|qwen)/i, "qianwen"],
  [/(?:百度\s*(?:ai|智能)|baiduai|文心一言|文心|ernie)/i, "baiduai"],
  [/(?:腾讯元宝|元宝|yuanbao)/i, "yuanbao"],
  [/(?:kimi|月之暗面)/i, "kimi"],
];

export function monitoringModelKey(value: string) {
  const normalized = normalizedText(value).toLocaleLowerCase("zh-CN");
  for (const [pattern, key] of modelAliases) {
    if (pattern.test(normalized)) return key;
  }
  return (
    normalized
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 128) || "unknown"
  );
}

/**
 * Monitoring filters travel over the API as canonical model keys, while
 * imported rows retain their original platform/model labels for display.
 * Resolve the key back to every matching stored label before building SQL so
 * aliases such as `deepseek`, `DeepSeek` and `Deep Seek` share one scope.
 */
export function matchingMonitoringModelLabels(
  availableLabels: readonly string[],
  requestedModel: string,
) {
  const requestedIdentity = normalizedIdentity(requestedModel);
  const requestedKey = monitoringModelKey(requestedModel);
  return [
    ...new Set(
      availableLabels.filter(
        (label) =>
          normalizedIdentity(label) === requestedIdentity ||
          monitoringModelKey(label) === requestedKey,
      ),
    ),
  ];
}

function likePattern(value: string) {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function uniqueSourceIds(
  rows: ReadonlyArray<{ sourceRecordId: string }>,
  label: string,
) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.sourceRecordId)) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        `${label}存在重复的 sourceRecordId：${row.sourceRecordId}`,
      );
    }
    ids.add(row.sourceRecordId);
  }
}

function requireQuestion(
  questionById: ReadonlyMap<string, MonitoringQuestion>,
  questionId: string,
) {
  const question = questionById.get(questionId);
  if (!question) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      `问题 ${questionId} 未由管理员配置，不能导入监控数据`,
    );
  }
  return question;
}

function domainFromUrl(value: string) {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, "zh-CN");
}

function hostnameFromValue(value: string) {
  const normalized = normalizedText(value);
  if (!normalized) return "";
  const candidate = normalized.startsWith("//")
    ? `https:${normalized}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(normalized)
      ? normalized
      : `https://${normalized}`;
  try {
    return new URL(candidate).hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeCitationDomain(domain: string, url: string) {
  return hostnameFromValue(domain) || hostnameFromValue(url);
}

const TRACKING_QUERY_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "spm",
]);

function normalizeCitationUrl(value: string) {
  const normalized = normalizedText(value);
  if (!normalized) return "";
  const candidate = normalized.startsWith("//")
    ? `https:${normalized}`
    : /^https?:\/\//i.test(normalized)
      ? normalized
      : `https://${normalized}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hostname = url.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.startsWith("utm_") ||
        TRACKING_QUERY_PARAMETERS.has(lowerKey)
      ) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizedIdentity(value: string) {
  return normalizedText(value).toLocaleLowerCase("zh-CN");
}

function increment(map: Map<string, number>, value: string) {
  if (!value) return;
  map.set(value, (map.get(value) ?? 0) + 1);
}

function preferredValue(values: ReadonlyMap<string, number>) {
  return [...values]
    .sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || compareText(left, right),
    )
    .at(0)?.[0];
}

type MonitoringCitationSummaryRow = {
  title: string;
  url: string;
  media: string;
  domain: string;
};

/**
 * Builds the two citation-analysis tables from raw batch records. Counts are
 * occurrence counts; normalization only collapses equivalent channel/content
 * identities and never invents missing citations.
 */
export function summarizeMonitoringCitations(
  rows: readonly MonitoringCitationSummaryRow[],
) {
  type ChannelAccumulator = {
    citationCount: number;
    mediaNames: Map<string, number>;
    fallbackNames: Map<string, number>;
    domain: string;
  };
  type ContentAccumulator = {
    citationCount: number;
    titles: Map<string, number>;
    urls: Map<string, number>;
    mediaNames: Map<string, number>;
    fallbackNames: Map<string, number>;
    domains: Map<string, number>;
  };

  const channelByIdentity = new Map<string, ChannelAccumulator>();
  const contentByIdentity = new Map<string, ContentAccumulator>();

  for (const row of rows) {
    const media = normalizedText(row.media);
    const domain = normalizeCitationDomain(row.domain, row.url);
    const channelFallback = domain || "未知来源";
    const channelIdentity = domain
      ? `domain:${domain}`
      : `media:${normalizedIdentity(media || channelFallback)}`;
    const channel = channelByIdentity.get(channelIdentity) ?? {
      citationCount: 0,
      mediaNames: new Map(),
      fallbackNames: new Map(),
      domain,
    };
    channel.citationCount += 1;
    increment(channel.mediaNames, media);
    increment(channel.fallbackNames, channelFallback);
    channelByIdentity.set(channelIdentity, channel);

    const title = normalizedText(row.title);
    const url = normalizeCitationUrl(row.url);
    const contentIdentity = url
      ? `url:${url}`
      : `title:${normalizedIdentity(title)}|${channelIdentity}`;
    const content = contentByIdentity.get(contentIdentity) ?? {
      citationCount: 0,
      titles: new Map(),
      urls: new Map(),
      mediaNames: new Map(),
      fallbackNames: new Map(),
      domains: new Map(),
    };
    content.citationCount += 1;
    increment(content.titles, title);
    increment(content.urls, url);
    increment(content.mediaNames, media);
    increment(content.fallbackNames, channelFallback);
    increment(content.domains, domain);
    contentByIdentity.set(contentIdentity, content);
  }

  const totalCitations = rows.length;
  const share = (citationCount: number) =>
    totalCitations > 0 ? citationCount / totalCitations : 0;
  const channels = [...channelByIdentity.values()]
    .map((channel) => ({
      name:
        preferredValue(channel.mediaNames) ??
        preferredValue(channel.fallbackNames) ??
        "未知来源",
      domain: channel.domain,
      citationCount: channel.citationCount,
      share: share(channel.citationCount),
    }))
    .sort(
      (left, right) =>
        right.citationCount - left.citationCount ||
        compareText(left.name, right.name),
    );
  const contents = [...contentByIdentity.values()]
    .map((content) => {
      const url = preferredValue(content.urls) ?? "";
      return {
        title: (preferredValue(content.titles) ?? url) || "未命名内容",
        url,
        channelName:
          preferredValue(content.mediaNames) ??
          preferredValue(content.fallbackNames) ??
          "未知来源",
        domain: preferredValue(content.domains) ?? "",
        citationCount: content.citationCount,
        share: share(content.citationCount),
      };
    })
    .sort(
      (left, right) =>
        right.citationCount - left.citationCount ||
        compareText(left.title, right.title),
    );

  return { totalCitations, channels, contents };
}

export type QuestionMonitoringScopeMode =
  | "current"
  | "historical_exact"
  | "lineage";

export async function resolveQuestionMonitoringScopeWithDb(
  db: Awaited<ReturnType<typeof requireDb>>,
  userId: number,
  requestedQuestionId: string,
  mode: QuestionMonitoringScopeMode = "current",
) {
  const matches = await db
    .select({
      id: workspaceQuestions.id,
      externalQuestionId: workspaceQuestions.externalQuestionId,
      sourceQuestionId: workspaceQuestions.sourceQuestionId,
      question: workspaceQuestions.question,
      status: workspaceQuestions.status,
      selectionApprovalStatus: workspaceQuestions.selectionApprovalStatus,
    })
    .from(workspaceQuestions)
    .where(
      and(
        eq(workspaceQuestions.userId, userId),
        or(
          eq(workspaceQuestions.id, requestedQuestionId),
          eq(workspaceQuestions.externalQuestionId, requestedQuestionId),
          eq(workspaceQuestions.sourceQuestionId, requestedQuestionId),
        ),
      ),
    );
  const exactMatch = matches.find((row) => row.id === requestedQuestionId);
  if (mode === "historical_exact") {
    return {
      questionIds: [requestedQuestionId],
      currentQuestion: exactMatch?.question,
    };
  }

  const activeMatches = matches.filter(
    (row) =>
      row.status === "selected" && row.selectionApprovalStatus === "approved",
  );
  const directActiveMatch = activeMatches.find(
    (row) => row.id === requestedQuestionId,
  );
  const activeQuestionTexts = new Set(activeMatches.map((row) => row.question));
  if (mode === "current") {
    const currentMatch =
      directActiveMatch ??
      (activeMatches.length === 1 ? activeMatches[0] : undefined);
    return {
      questionIds: currentMatch ? [currentMatch.id] : [requestedQuestionId],
      currentQuestion:
        currentMatch?.question ??
        (activeQuestionTexts.size === 1
          ? [...activeQuestionTexts][0]!
          : undefined),
    };
  }

  const rootIds = new Set(matches.map((row) => row.sourceQuestionId ?? row.id));
  const lineageRows = rootIds.size
    ? await db
        .select({
          id: workspaceQuestions.id,
          externalQuestionId: workspaceQuestions.externalQuestionId,
        })
        .from(workspaceQuestions)
        .where(
          and(
            eq(workspaceQuestions.userId, userId),
            or(
              inArray(workspaceQuestions.id, [...rootIds]),
              inArray(workspaceQuestions.sourceQuestionId, [...rootIds]),
            ),
          ),
        )
    : [];
  return {
    questionIds: [
      ...new Set(
        [
          requestedQuestionId,
          ...matches.flatMap((row) => [
            row.id,
            row.externalQuestionId,
            row.sourceQuestionId,
          ]),
          ...lineageRows.flatMap((row) => [row.id, row.externalQuestionId]),
        ].filter((value): value is string => Boolean(value)),
      ),
    ],
    currentQuestion:
      directActiveMatch?.question ??
      (activeQuestionTexts.size === 1
        ? [...activeQuestionTexts][0]!
        : undefined),
  };
}

async function resolveQuestionLineageIdsWithDb(
  db: Awaited<ReturnType<typeof requireDb>>,
  userId: number,
  requestedQuestionId: string,
) {
  return (
    await resolveQuestionMonitoringScopeWithDb(
      db,
      userId,
      requestedQuestionId,
      "lineage",
    )
  ).questionIds;
}

export async function resolveQuestionLineageIds(
  userId: number,
  requestedQuestionId: string,
) {
  return resolveQuestionLineageIdsWithDb(
    await requireDb(),
    userId,
    requestedQuestionId,
  );
}

/**
 * Resolves the server-owned quota-period boundary for monitoring reads.
 * Active services see only their current period(s); expired or cancelled
 * services retain access to previously imported monitoring batches. Returning
 * `undefined` is reserved for compatibility users and legacy unclassified
 * historical batches, where tenant ownership remains the hard boundary.
 */
export function deriveMonitoringReadQuotaPeriodIds(input: {
  serviceStatus: ServicePortal["service"]["status"];
  capabilityAllowed: boolean;
  compatibilityMode: boolean;
  currentQuotaPeriodIds: readonly string[];
  compatibilityQuotaPeriodIds?: readonly string[];
  historicalQuotaPeriodIds?: readonly (string | null)[];
}): string[] | undefined {
  if (input.serviceStatus === "unconfigured" && input.compatibilityMode) {
    return undefined;
  }
  if (!input.capabilityAllowed) return [];

  if (
    input.serviceStatus === "expired" ||
    input.serviceStatus === "cancelled"
  ) {
    const historical = input.historicalQuotaPeriodIds ?? [];
    // Legacy batches may predate quota-period classification. At this point
    // every batch is still constrained by userId and the service is no longer
    // writable, so tenant-wide history is the compatible safe fallback.
    if (historical.some((periodId) => periodId === null)) return undefined;
    return [
      ...new Set(historical.filter((value): value is string => Boolean(value))),
    ];
  }

  return [
    ...new Set([
      ...input.currentQuotaPeriodIds,
      ...(input.compatibilityQuotaPeriodIds ?? []),
    ]),
  ];
}

export async function resolveMonitoringReadQuotaPeriodIds(
  userId: number,
): Promise<string[] | undefined> {
  const portal = await getServicePortal(userId);
  const compatibilityMode = portal.entitlementRollout.mode === "compatibility";
  const needsHistoricalPeriods =
    portal.capabilities.monitoring.allowed &&
    (portal.service.status === "expired" ||
      portal.service.status === "cancelled");
  const historicalQuotaPeriodIds = needsHistoricalPeriods
    ? (
        await (await requireDb())
          .select({ quotaPeriodId: monitoringBatches.quotaPeriodId })
          .from(monitoringBatches)
          .where(eq(monitoringBatches.userId, userId))
          .groupBy(monitoringBatches.quotaPeriodId)
      ).map((row) => row.quotaPeriodId)
    : undefined;

  return deriveMonitoringReadQuotaPeriodIds({
    serviceStatus: portal.service.status,
    capabilityAllowed: portal.capabilities.monitoring.allowed,
    compatibilityMode,
    currentQuotaPeriodIds: portal.quotaPeriods.map((period) => period.periodId),
    // During a rollback, image 6dd200ca binds monitoring imports to the
    // question's annual ordinal-0 anchor. Keep that persisted output readable
    // after roll-forward without ever using the anchor for new writes.
    compatibilityQuotaPeriodIds:
      portal.service.planCode === "luxury" &&
      (portal.service.planVersion ?? 1) >= 2
        ? portal.purchasedQuestions.map((question) => question.quotaPeriodId)
        : [],
    historicalQuotaPeriodIds,
  });
}

/**
 * Builds tenant-owned database rows from a strict import contract. Neither
 * child records nor client question text can choose their user/batch identity.
 */
export function buildMonitoringBatchRows(input: {
  userId: number;
  batchId: string;
  value: ReplaceMonitoringBatchInput;
  questions: readonly MonitoringQuestion[];
  idFactory?: () => string;
}) {
  const idFactory = input.idFactory ?? randomUUID;
  const questionById = new Map(
    input.questions.map((question) => [question.id, question]),
  );
  const batchCollectedAt = parseDate(input.value.collectedAt);
  uniqueSourceIds(input.value.samples, "监控样本");
  uniqueSourceIds(input.value.citations, "引用记录");

  const sampleIdBySourceId = new Map<string, string>();
  const sampleInputBySourceId = new Map(
    input.value.samples.map((sample) => [sample.sourceRecordId, sample]),
  );
  for (const sample of input.value.samples) {
    sampleIdBySourceId.set(sample.sourceRecordId, idFactory());
  }

  const linkedCitationCounts = new Map<string, number>();
  const citations = input.value.citations.map((citation) => {
    const question = requireQuestion(questionById, citation.questionId);
    let sampleId: string | null = null;
    if (citation.sampleSourceRecordId) {
      const sample = sampleInputBySourceId.get(citation.sampleSourceRecordId);
      sampleId = sampleIdBySourceId.get(citation.sampleSourceRecordId) ?? null;
      if (!sample || !sampleId) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          `引用记录 ${citation.sourceRecordId} 指向了不存在的监控样本`,
        );
      }
      if (sample.questionId !== citation.questionId) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          `引用记录 ${citation.sourceRecordId} 与关联样本的问题不一致`,
        );
      }
      linkedCitationCounts.set(
        citation.sampleSourceRecordId,
        (linkedCitationCounts.get(citation.sampleSourceRecordId) ?? 0) + 1,
      );
    }
    return {
      id: idFactory(),
      userId: input.userId,
      batchId: input.batchId,
      sampleId,
      sourceRecordId: citation.sourceRecordId,
      questionId: citation.questionId,
      question: question.question,
      model: citation.model,
      title: citation.title,
      url: citation.url,
      media: citation.media,
      domain: citation.domain || domainFromUrl(citation.url),
      publishedAt: optionalDate(citation.publishedAt),
      collectedAt: citation.collectedAt
        ? parseDate(citation.collectedAt)
        : batchCollectedAt,
    };
  });

  const samples = input.value.samples.map((sample) => {
    const question = requireQuestion(questionById, sample.questionId);
    const linkedCitationCount =
      linkedCitationCounts.get(sample.sourceRecordId) ?? 0;
    return {
      id: sampleIdBySourceId.get(sample.sourceRecordId)!,
      userId: input.userId,
      batchId: input.batchId,
      sourceRecordId: sample.sourceRecordId,
      questionId: sample.questionId,
      question: question.question,
      platform: sample.platform,
      answerNo: sample.answerNo,
      content: sample.content,
      citationCount: Math.max(
        sample.citationCount ?? linkedCitationCount,
        linkedCitationCount,
      ),
      monitorRank: sample.monitorRank ?? null,
      screenshotUrl: sample.screenshotUrl || null,
      collectedAt: sample.collectedAt
        ? parseDate(sample.collectedAt)
        : batchCollectedAt,
    };
  });

  return { samples, citations, collectedAt: batchCollectedAt };
}

type MonitoringCurrentTemplateBatch =
  DashboardMonitoringCurrentTemplate["batches"][number];

type MonitoringTemplateBatchRow = Pick<
  typeof monitoringBatches.$inferSelect,
  "id" | "batchKey" | "revision" | "sourceName" | "collectedAt" | "updatedAt"
>;

type MonitoringTemplateSampleRow = Pick<
  typeof monitoringSamples.$inferSelect,
  | "id"
  | "batchId"
  | "sourceRecordId"
  | "questionId"
  | "platform"
  | "answerNo"
  | "content"
  | "citationCount"
  | "monitorRank"
  | "screenshotUrl"
  | "collectedAt"
>;

type MonitoringTemplateCitationRow = Pick<
  typeof monitoringCitationRecords.$inferSelect,
  | "batchId"
  | "sourceRecordId"
  | "sampleId"
  | "questionId"
  | "model"
  | "title"
  | "url"
  | "media"
  | "domain"
  | "publishedAt"
  | "collectedAt"
>;

type MonitoringTemplateTransactionHook = (
  tx: any,
  batches?: Array<{
    batchKey: string;
    revision: number;
    sampleCount: number;
    citationCount: number;
  }>,
) => Promise<void>;

type MonitoringBatchWriteResult = {
  batchId: string;
  batchKey: string;
  revision: number;
  sampleCount: number;
  citationCount: number;
  collectedAt: number;
  idempotent: boolean;
};

type MonitoringBatchTransactionHook = (
  tx: any,
  result?: MonitoringBatchWriteResult,
) => Promise<void>;

async function monitoringCurrentTemplateBatchesFromExecutor(input: {
  executor: any;
  userId: number;
  quotaPeriodIds: string[];
  lockBatches?: boolean;
}): Promise<MonitoringCurrentTemplateBatch[]> {
  if (input.quotaPeriodIds.length === 0) return [];
  let batchQuery = input.executor
    .select({
      id: monitoringBatches.id,
      batchKey: monitoringBatches.batchKey,
      revision: monitoringBatches.revision,
      sourceName: monitoringBatches.sourceName,
      collectedAt: monitoringBatches.collectedAt,
      updatedAt: monitoringBatches.updatedAt,
    })
    .from(monitoringBatches)
    .where(
      and(
        eq(monitoringBatches.userId, input.userId),
        inArray(monitoringBatches.quotaPeriodId, input.quotaPeriodIds),
      ),
    )
    .orderBy(
      desc(monitoringBatches.collectedAt),
      desc(monitoringBatches.updatedAt),
    )
    .limit(101);
  if (input.lockBatches) batchQuery = batchQuery.for("update");
  const batchRows = (await batchQuery) as MonitoringTemplateBatchRow[];
  if (batchRows.length > 100) {
    throw new AuthServiceError(
      "CONFLICT",
      "当前服务监控批次超过 100 个，不能生成单份当前内容模板。",
    );
  }
  if (batchRows.length === 0) return [];
  const batchIds = batchRows.map((batch) => batch.id);
  const [rawSampleRows, rawCitationRows] = await Promise.all([
    input.executor
      .select({
        id: monitoringSamples.id,
        batchId: monitoringSamples.batchId,
        sourceRecordId: monitoringSamples.sourceRecordId,
        questionId: monitoringSamples.questionId,
        platform: monitoringSamples.platform,
        answerNo: monitoringSamples.answerNo,
        content: monitoringSamples.content,
        citationCount: monitoringSamples.citationCount,
        monitorRank: monitoringSamples.monitorRank,
        screenshotUrl: monitoringSamples.screenshotUrl,
        collectedAt: monitoringSamples.collectedAt,
      })
      .from(monitoringSamples)
      .where(
        and(
          eq(monitoringSamples.userId, input.userId),
          inArray(monitoringSamples.batchId, batchIds),
        ),
      )
      .orderBy(
        asc(monitoringSamples.batchId),
        asc(monitoringSamples.collectedAt),
        asc(monitoringSamples.id),
      ),
    input.executor
      .select({
        batchId: monitoringCitationRecords.batchId,
        sourceRecordId: monitoringCitationRecords.sourceRecordId,
        sampleId: monitoringCitationRecords.sampleId,
        questionId: monitoringCitationRecords.questionId,
        model: monitoringCitationRecords.model,
        title: monitoringCitationRecords.title,
        url: monitoringCitationRecords.url,
        media: monitoringCitationRecords.media,
        domain: monitoringCitationRecords.domain,
        publishedAt: monitoringCitationRecords.publishedAt,
        collectedAt: monitoringCitationRecords.collectedAt,
      })
      .from(monitoringCitationRecords)
      .where(
        and(
          eq(monitoringCitationRecords.userId, input.userId),
          inArray(monitoringCitationRecords.batchId, batchIds),
        ),
      )
      .orderBy(
        asc(monitoringCitationRecords.batchId),
        asc(monitoringCitationRecords.collectedAt),
        asc(monitoringCitationRecords.id),
      ),
  ]);
  const sampleRows = rawSampleRows as MonitoringTemplateSampleRow[];
  const citationRows = rawCitationRows as MonitoringTemplateCitationRow[];
  const samplesByBatch = new Map<
    string,
    MonitoringCurrentTemplateBatch["samples"]
  >();
  const citationsByBatch = new Map<
    string,
    MonitoringCurrentTemplateBatch["citations"]
  >();
  const sampleSourceIdByInternalId = new Map(
    sampleRows.map((sample) => [sample.id, sample.sourceRecordId]),
  );
  for (const sample of sampleRows) {
    const rows = samplesByBatch.get(sample.batchId) ?? [];
    rows.push({
      sourceRecordId: sample.sourceRecordId,
      questionId: sample.questionId,
      platform: sample.platform,
      answerNo: sample.answerNo,
      content: sample.content,
      citationCount: sample.citationCount,
      ...(sample.monitorRank === null
        ? {}
        : { monitorRank: sample.monitorRank }),
      screenshotUrl: sample.screenshotUrl || "",
      collectedAt: sample.collectedAt.toISOString(),
    });
    samplesByBatch.set(sample.batchId, rows);
  }
  for (const citation of citationRows) {
    const rows = citationsByBatch.get(citation.batchId) ?? [];
    const sampleSourceRecordId = citation.sampleId
      ? sampleSourceIdByInternalId.get(citation.sampleId)
      : undefined;
    rows.push({
      sourceRecordId: citation.sourceRecordId,
      questionId: citation.questionId,
      ...(sampleSourceRecordId ? { sampleSourceRecordId } : {}),
      model: citation.model,
      title: citation.title,
      url: citation.url,
      media: citation.media,
      domain: citation.domain,
      ...(citation.publishedAt
        ? { publishedAt: citation.publishedAt.toISOString() }
        : {}),
      collectedAt: citation.collectedAt.toISOString(),
    });
    citationsByBatch.set(citation.batchId, rows);
  }
  return batchRows.map((batch) => ({
    batchKey: batch.batchKey,
    revision: batch.revision,
    sourceName: batch.sourceName,
    collectedAt: batch.collectedAt.toISOString(),
    samples: samplesByBatch.get(batch.id) ?? [],
    citations: citationsByBatch.get(batch.id) ?? [],
  }));
}

export async function getMonitoringCurrentTemplateBatches(input: {
  actor: AuthenticatedUser;
  userId: number;
}) {
  if (input.actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Administrator permission is required",
    );
  }
  await assertWorkspaceAccess(input.actor, input.userId);
  const portal = await assertServiceCapability(input.userId, "monitoring");
  const db = await requireDb();
  return monitoringCurrentTemplateBatchesFromExecutor({
    executor: db,
    userId: input.userId,
    quotaPeriodIds: portal.quotaPeriods.map((period) => period.periodId),
  });
}

function monitoringTemplateBatchContent(batch: MonitoringCurrentTemplateBatch) {
  return JSON.stringify({
    sourceName: batch.sourceName,
    collectedAt: batch.collectedAt,
    samples: batch.samples,
    citations: batch.citations,
  });
}

/**
 * Replaces the revision-bound current monitoring batches atomically. Raw XLSX
 * imports still create a new batch; this path is reserved for a downloaded
 * current-content JSON template and cannot add or remove a batch.
 */
export async function replaceMonitoringCurrentTemplateBatches(input: {
  actor: AuthenticatedUser;
  userId: number;
  batches: MonitoringCurrentTemplateBatch[];
  beforeWrite?: MonitoringTemplateTransactionHook;
  afterWrite?: MonitoringTemplateTransactionHook;
}) {
  if (input.actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Administrator permission is required",
    );
  }
  await assertWorkspaceAccess(input.actor, input.userId);
  const portal = await assertServiceCapability(input.userId, "monitoring");
  const quotaPeriodIds = portal.quotaPeriods.map((period) => period.periodId);
  const questionIds = new Set(
    input.batches.flatMap((batch) => [
      ...batch.samples.map((sample) => sample.questionId),
      ...batch.citations.map((citation) => citation.questionId),
    ]),
  );
  const questions = [
    ...new Map(
      portal.purchasedQuestions.flatMap((question) =>
        [question.id, question.externalQuestionId, question.sourceQuestionId]
          .filter((id): id is string => Boolean(id))
          .map((id) => [id, { id, question: question.question }] as const),
      ),
    ).values(),
  ];
  for (const questionId of questionIds) {
    if (!questions.some((question) => question.id === questionId)) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        `问题 ${questionId} 不属于当前服务，不能发布监控模板`,
      );
    }
  }
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new AuthServiceError("NOT_FOUND", "User not found");
    }
    await input.beforeWrite?.(tx);
    const current = await monitoringCurrentTemplateBatchesFromExecutor({
      executor: tx,
      userId: input.userId,
      quotaPeriodIds,
      lockBatches: true,
    });
    const currentByKey = new Map(
      current.map((batch) => [batch.batchKey, batch]),
    );
    if (
      current.length !== input.batches.length ||
      input.batches.some((batch) => !currentByKey.has(batch.batchKey))
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "监控批次目录已变化，请重新下载当前内容模板。",
      );
    }
    for (const batch of input.batches) {
      const currentBatch = currentByKey.get(batch.batchKey)!;
      if (batch.revision !== currentBatch.revision) {
        throw new AuthServiceError(
          "CONFLICT",
          `监控批次 ${batch.batchKey} 已更新到 R${currentBatch.revision}，请重新下载当前内容模板。`,
        );
      }
    }
    const changed = input.batches.filter(
      (batch) =>
        monitoringTemplateBatchContent(batch) !==
        monitoringTemplateBatchContent(currentByKey.get(batch.batchKey)!),
    );
    if (changed.length === 0) {
      throw new AuthServiceError(
        "CONFLICT",
        "监控当前内容模板与正式数据一致，无需发布。",
      );
    }
    const existingRows = await tx
      .select({
        id: monitoringBatches.id,
        batchKey: monitoringBatches.batchKey,
      })
      .from(monitoringBatches)
      .where(
        and(
          eq(monitoringBatches.userId, input.userId),
          inArray(
            monitoringBatches.batchKey,
            changed.map((batch) => batch.batchKey),
          ),
        ),
      )
      .for("update");
    const idByKey = new Map(
      existingRows.map((batch) => [batch.batchKey, batch.id]),
    );
    const results: Array<{
      batchKey: string;
      revision: number;
      sampleCount: number;
      citationCount: number;
    }> = [];
    for (const batch of changed) {
      const batchId = idByKey.get(batch.batchKey);
      if (!batchId) {
        throw new AuthServiceError(
          "CONFLICT",
          `监控批次 ${batch.batchKey} 已不存在，请重新下载当前内容模板。`,
        );
      }
      const rows = buildMonitoringBatchRows({
        userId: input.userId,
        batchId,
        value: {
          userId: input.userId,
          batchKey: batch.batchKey,
          sourceName: batch.sourceName,
          collectedAt: batch.collectedAt,
          samples: batch.samples,
          citations: batch.citations,
        },
        questions,
      });
      await tx
        .delete(monitoringCitationRecords)
        .where(
          and(
            eq(monitoringCitationRecords.userId, input.userId),
            eq(monitoringCitationRecords.batchId, batchId),
          ),
        );
      await tx
        .delete(monitoringSamples)
        .where(
          and(
            eq(monitoringSamples.userId, input.userId),
            eq(monitoringSamples.batchId, batchId),
          ),
        );
      const revision = batch.revision + 1;
      await tx
        .update(monitoringBatches)
        .set({
          sourceName: batch.sourceName,
          collectedAt: rows.collectedAt,
          sampleCount: rows.samples.length,
          citationCount: rows.citations.length,
          revision,
          importedByUserId: input.actor.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(monitoringBatches.id, batchId),
            eq(monitoringBatches.userId, input.userId),
          ),
        );
      for (let offset = 0; offset < rows.samples.length; offset += 500) {
        await tx
          .insert(monitoringSamples)
          .values(rows.samples.slice(offset, offset + 500));
      }
      for (let offset = 0; offset < rows.citations.length; offset += 500) {
        await tx
          .insert(monitoringCitationRecords)
          .values(rows.citations.slice(offset, offset + 500));
      }
      results.push({
        batchKey: batch.batchKey,
        revision,
        sampleCount: rows.samples.length,
        citationCount: rows.citations.length,
      });
    }
    await input.afterWrite?.(tx, results);
    return results;
  });
}

export function resolveMonitoringBatchQuotaScope(input: {
  portal: Pick<ServicePortal, "service" | "quotas" | "quotaPeriods">;
  referencedQuestions: Array<
    Pick<
      ServicePortal["purchasedQuestions"][number],
      "contractId" | "quotaPeriodId"
    >
  >;
}) {
  const contractIds = new Set(
    input.referencedQuestions
      .map((question) => question.contractId)
      .filter((id): id is string => Boolean(id)),
  );
  const quotaPeriodIds = new Set(
    input.referencedQuestions
      .map((question) => question.quotaPeriodId)
      .filter((id): id is string => Boolean(id)),
  );
  const contractId = [...contractIds][0] ?? null;
  const progressiveLuxury =
    input.portal.service.planCode === "luxury" &&
    (input.portal.service.planVersion ?? 1) >= 2 &&
    contractId === input.portal.service.contractId;
  const quotaPeriodId = progressiveLuxury
    ? (input.portal.quotas?.periodId ?? null)
    : ([...quotaPeriodIds][0] ?? null);
  const legacyScopeIsActive = Boolean(
    contractId &&
      quotaPeriodId &&
      input.portal.quotaPeriods.some(
        (period) =>
          period.contractId === contractId && period.periodId === quotaPeriodId,
      ),
  );
  if (
    contractIds.size !== 1 ||
    !quotaPeriodId ||
    (progressiveLuxury
      ? contractId !== input.portal.service.contractId
      : quotaPeriodIds.size !== 1 || !legacyScopeIsActive)
  ) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "一次监控导入只能包含同一合同与有效额度周期内的当前服务问题",
    );
  }
  return { contractId, quotaPeriodId, progressiveLuxury };
}

export async function replaceMonitoringBatch(input: {
  actor: AuthenticatedUser;
  value: ReplaceMonitoringBatchInput;
  forceReplace?: boolean;
  beforeWrite?: MonitoringBatchTransactionHook;
  afterWrite?: MonitoringBatchTransactionHook;
  transaction?: any;
}) {
  if (input.actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Administrator permission is required",
    );
  }
  await assertWorkspaceAccess(input.actor, input.value.userId);
  const portal = await assertServiceCapability(
    input.value.userId,
    "monitoring",
  );
  const referencedQuestionIds = new Set([
    ...input.value.samples.map((sample) => sample.questionId),
    ...input.value.citations.map((citation) => citation.questionId),
  ]);
  const referencedQuestions = portal.purchasedQuestions.filter((question) =>
    [question.id, question.externalQuestionId, question.sourceQuestionId]
      .filter((id): id is string => Boolean(id))
      .some((id) => referencedQuestionIds.has(id)),
  );
  const { contractId, quotaPeriodId } = resolveMonitoringBatchQuotaScope({
    portal,
    referencedQuestions,
  });
  const questions = [
    ...new Map(
      portal.purchasedQuestions.flatMap((question) =>
        [question.id, question.externalQuestionId, question.sourceQuestionId]
          .filter((id): id is string => Boolean(id))
          .map((id) => [id, { id, question: question.question }] as const),
      ),
    ).values(),
  ];
  const db = await requireDb();

  let result!: MonitoringBatchWriteResult;
  const writeBatch = async (tx: any) => {
    // Locking the tenant serializes replacements of the same external batch
    // key and prevents a concurrent first import from violating its unique key.
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.value.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new AuthServiceError("NOT_FOUND", "User not found");
    }
    await input.beforeWrite?.(tx);

    const existingRows = await tx
      .select({
        id: monitoringBatches.id,
        revision: monitoringBatches.revision,
        contractId: monitoringBatches.contractId,
        quotaPeriodId: monitoringBatches.quotaPeriodId,
        sampleCount: monitoringBatches.sampleCount,
        citationCount: monitoringBatches.citationCount,
        collectedAt: monitoringBatches.collectedAt,
      })
      .from(monitoringBatches)
      .where(
        and(
          eq(monitoringBatches.userId, input.value.userId),
          eq(monitoringBatches.quotaPeriodId, quotaPeriodId),
          eq(monitoringBatches.batchKey, input.value.batchKey),
        ),
      )
      .limit(1)
      .for("update");
    const existing = existingRows[0];
    if (
      existing &&
      !input.forceReplace &&
      input.value.batchKey.startsWith("dashboard-import:sha256:")
    ) {
      result = {
        batchId: existing.id,
        batchKey: input.value.batchKey,
        revision: existing.revision,
        sampleCount: existing.sampleCount,
        citationCount: existing.citationCount,
        collectedAt: existing.collectedAt.getTime(),
        idempotent: true,
      };
      await input.afterWrite?.(tx, result);
      return;
    }
    const batchId = existing?.id ?? randomUUID();
    const rows = buildMonitoringBatchRows({
      userId: input.value.userId,
      batchId,
      value: input.value,
      questions,
    });
    const revision = (existing?.revision ?? 0) + 1;

    if (existing) {
      await tx
        .delete(monitoringCitationRecords)
        .where(
          and(
            eq(monitoringCitationRecords.userId, input.value.userId),
            eq(monitoringCitationRecords.batchId, batchId),
          ),
        );
      await tx
        .delete(monitoringSamples)
        .where(
          and(
            eq(monitoringSamples.userId, input.value.userId),
            eq(monitoringSamples.batchId, batchId),
          ),
        );
      await tx
        .update(monitoringBatches)
        .set({
          sourceName: input.value.sourceName,
          collectedAt: rows.collectedAt,
          sampleCount: rows.samples.length,
          citationCount: rows.citations.length,
          revision,
          importedByUserId: input.actor.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(monitoringBatches.id, batchId),
            eq(monitoringBatches.userId, input.value.userId),
          ),
        );
    } else {
      await tx.insert(monitoringBatches).values({
        id: batchId,
        userId: input.value.userId,
        contractId,
        quotaPeriodId,
        batchKey: input.value.batchKey,
        sourceName: input.value.sourceName,
        collectedAt: rows.collectedAt,
        sampleCount: rows.samples.length,
        citationCount: rows.citations.length,
        revision,
        importedByUserId: input.actor.id,
      });
    }

    for (let offset = 0; offset < rows.samples.length; offset += 500) {
      await tx
        .insert(monitoringSamples)
        .values(rows.samples.slice(offset, offset + 500));
    }
    for (let offset = 0; offset < rows.citations.length; offset += 500) {
      await tx
        .insert(monitoringCitationRecords)
        .values(rows.citations.slice(offset, offset + 500));
    }

    result = {
      batchId,
      batchKey: input.value.batchKey,
      revision,
      sampleCount: rows.samples.length,
      citationCount: rows.citations.length,
      collectedAt: rows.collectedAt.getTime(),
      idempotent: false,
    };
    await input.afterWrite?.(tx, result);
  };
  if (input.transaction) {
    await writeBatch(input.transaction);
  } else {
    await db.transaction(writeBatch);
  }
  return result;
}

export async function mergeQuestionOnlyCitationsIntoMonitoringBatch(input: {
  actor: AuthenticatedUser;
  targetUserId: number;
  targetBatchKey: string;
  value: ReplaceMonitoringBatchInput;
  beforeWrite?: MonitoringBatchTransactionHook;
  afterWrite?: MonitoringBatchTransactionHook;
}) {
  if (
    input.value.samples.length > 0 ||
    input.value.citations.some((citation) => citation.sampleSourceRecordId)
  ) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有未绑定答案的问题级引用可以合并到目标监控批次",
    );
  }
  if (input.actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Administrator permission is required",
    );
  }
  await assertWorkspaceAccess(input.actor, input.targetUserId);
  const portal = await assertServiceCapability(
    input.targetUserId,
    "monitoring",
  );
  const quotaPeriodIds = portal.quotaPeriods.map((period) => period.periodId);
  if (quotaPeriodIds.length === 0) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "当前服务周期没有可写入的监控批次",
    );
  }
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.targetUserId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new AuthServiceError("NOT_FOUND", "User not found");
    }
    await input.beforeWrite?.(tx);
    const batchRows = await tx
      .select({
        id: monitoringBatches.id,
        batchKey: monitoringBatches.batchKey,
        sourceName: monitoringBatches.sourceName,
        collectedAt: monitoringBatches.collectedAt,
        revision: monitoringBatches.revision,
        sampleCount: monitoringBatches.sampleCount,
        citationCount: monitoringBatches.citationCount,
      })
      .from(monitoringBatches)
      .where(
        and(
          eq(monitoringBatches.userId, input.targetUserId),
          eq(monitoringBatches.batchKey, input.targetBatchKey),
          inArray(monitoringBatches.quotaPeriodId, quotaPeriodIds),
        ),
      )
      .orderBy(desc(monitoringBatches.updatedAt))
      .limit(1)
      .for("update");
    const batch = batchRows[0];
    if (!batch) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "目标监控批次不存在或不属于当前服务周期",
      );
    }
    const [sampleRows, citationRows] = await Promise.all([
      tx
        .select({
          id: monitoringSamples.id,
          sourceRecordId: monitoringSamples.sourceRecordId,
          questionId: monitoringSamples.questionId,
          platform: monitoringSamples.platform,
          answerNo: monitoringSamples.answerNo,
          content: monitoringSamples.content,
          citationCount: monitoringSamples.citationCount,
          monitorRank: monitoringSamples.monitorRank,
          screenshotUrl: monitoringSamples.screenshotUrl,
          collectedAt: monitoringSamples.collectedAt,
        })
        .from(monitoringSamples)
        .where(
          and(
            eq(monitoringSamples.userId, input.targetUserId),
            eq(monitoringSamples.batchId, batch.id),
          ),
        ),
      tx
        .select({
          sourceRecordId: monitoringCitationRecords.sourceRecordId,
          sampleId: monitoringCitationRecords.sampleId,
          questionId: monitoringCitationRecords.questionId,
          model: monitoringCitationRecords.model,
          title: monitoringCitationRecords.title,
          url: monitoringCitationRecords.url,
          media: monitoringCitationRecords.media,
          domain: monitoringCitationRecords.domain,
          publishedAt: monitoringCitationRecords.publishedAt,
          collectedAt: monitoringCitationRecords.collectedAt,
        })
        .from(monitoringCitationRecords)
        .where(
          and(
            eq(monitoringCitationRecords.userId, input.targetUserId),
            eq(monitoringCitationRecords.batchId, batch.id),
          ),
        ),
    ]);
    if (sampleRows.length === 0) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        "目标监控批次没有答案明细，无法承载问题级引用分析",
      );
    }
    assertQuestionOnlyCitationTargetCompatibility({
      samples: sampleRows,
      citations: input.value.citations,
    });
    const sampleSourceIdById = new Map(
      sampleRows.map((sample) => [sample.id, sample.sourceRecordId]),
    );
    const existingCitations: ReplaceMonitoringBatchInput["citations"] =
      citationRows.map((citation) => ({
        sourceRecordId: citation.sourceRecordId,
        questionId: citation.questionId,
        sampleSourceRecordId: citation.sampleId
          ? sampleSourceIdById.get(citation.sampleId)
          : undefined,
        model: citation.model,
        title: citation.title,
        url: citation.url,
        media: citation.media,
        domain: citation.domain,
        publishedAt: citation.publishedAt?.toISOString(),
        collectedAt: citation.collectedAt.toISOString(),
      }));
    const linkedCitations = existingCitations.filter(
      (citation) => citation.sampleSourceRecordId,
    );
    const unlinkedCitations = existingCitations.filter(
      (citation) => !citation.sampleSourceRecordId,
    );
    const linkedCitationIds = new Set(
      linkedCitations.map((citation) => citation.sourceRecordId),
    );
    for (const citation of input.value.citations) {
      if (linkedCitationIds.has(citation.sourceRecordId)) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          `引用记录 ID 与目标批次中已精确关联的记录冲突：${citation.sourceRecordId}`,
        );
      }
    }
    const comparableCitations = (
      values: ReplaceMonitoringBatchInput["citations"],
    ) =>
      values
        .map((value) => ({
          sourceRecordId: value.sourceRecordId,
          questionId: value.questionId,
          model: value.model,
          title: value.title,
          url: value.url,
          media: value.media,
          domain: value.domain || "",
          publishedAt: value.publishedAt || "",
          collectedAt: value.collectedAt || "",
        }))
        .sort((left, right) =>
          left.sourceRecordId.localeCompare(right.sourceRecordId),
        );
    if (
      JSON.stringify(comparableCitations(unlinkedCitations)) ===
      JSON.stringify(comparableCitations(input.value.citations))
    ) {
      const result = {
        batchId: batch.id,
        batchKey: batch.batchKey,
        revision: batch.revision,
        sampleCount: batch.sampleCount,
        citationCount: batch.citationCount,
        collectedAt: batch.collectedAt.getTime(),
        addedCitationCount: 0,
        idempotent: true,
      };
      await input.afterWrite?.(tx, result);
      return result;
    }
    const samples: ReplaceMonitoringBatchInput["samples"] = sampleRows.map(
      (sample) => ({
        sourceRecordId: sample.sourceRecordId,
        questionId: sample.questionId,
        platform: sample.platform,
        answerNo: sample.answerNo,
        content: sample.content,
        citationCount: sample.citationCount,
        monitorRank: sample.monitorRank ?? undefined,
        screenshotUrl: sample.screenshotUrl || "",
        collectedAt: sample.collectedAt.toISOString(),
      }),
    );
    const result = await replaceMonitoringBatch({
      actor: input.actor,
      forceReplace: true,
      transaction: tx,
      afterWrite: input.afterWrite,
      value: {
        userId: input.targetUserId,
        batchKey: batch.batchKey,
        sourceName: batch.sourceName,
        collectedAt: batch.collectedAt.toISOString(),
        samples,
        // The uploaded legacy workbook is the complete question-level ledger
        // for this target batch. Keep exact sample links and atomically replace
        // only the unbound citation rows.
        citations: [...linkedCitations, ...input.value.citations],
      },
    });
    return {
      ...result,
      addedCitationCount: input.value.citations.length,
      replacedCitationCount: unlinkedCitations.length,
      idempotent: false,
    };
  });
}

export function assertQuestionOnlyCitationTargetCompatibility(input: {
  samples: ReadonlyArray<{
    questionId: string;
    platform: string;
    collectedAt: Date | number | string;
  }>;
  citations: ReadonlyArray<{
    questionId: string;
    model: string;
    collectedAt?: string;
    publishedAt?: string;
  }>;
}) {
  const sampleScopes = new Set(
    input.samples.map(
      (sample) =>
        `${sample.questionId}\u001f${monitoringModelKey(sample.platform)}\u001f${monitoringBeijingDate(sample.collectedAt)}`,
    ),
  );
  const mismatches = input.citations.filter((citation) => {
    const date = monitoringBeijingDate(
      citation.collectedAt || citation.publishedAt || "",
    );
    return !sampleScopes.has(
      `${citation.questionId}\u001f${monitoringModelKey(citation.model)}\u001f${date}`,
    );
  });
  if (mismatches.length > 0) {
    const first = mismatches[0]!;
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      `引用文件与目标答案批次不匹配：问题 ${first.questionId}、模型 ${first.model}、日期 ${monitoringBeijingDate(first.collectedAt || first.publishedAt || "") || "未标注"}`,
    );
  }
}

export async function listMonitoringSamples(input: {
  userId: number;
  filters: ListMonitoringSamplesInput;
  quotaPeriodIds?: string[];
  questionScopeMode?: Exclude<QuestionMonitoringScopeMode, "lineage">;
}) {
  const db = await requireDb();
  const { filters } = input;
  if (input.quotaPeriodIds && input.quotaPeriodIds.length === 0) {
    return {
      items: [],
      total: 0,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }
  const conditions = [eq(monitoringSamples.userId, input.userId)];
  if (input.quotaPeriodIds) {
    conditions.push(
      inArray(monitoringBatches.quotaPeriodId, input.quotaPeriodIds),
    );
  }
  const questionScope = filters.questionId
    ? await resolveQuestionMonitoringScopeWithDb(
        db,
        input.userId,
        filters.questionId,
        input.questionScopeMode,
      )
    : undefined;
  if (questionScope) {
    conditions.push(
      inArray(monitoringSamples.questionId, questionScope.questionIds),
    );
    if (questionScope.currentQuestion) {
      conditions.push(
        eq(monitoringSamples.question, questionScope.currentQuestion),
      );
    }
  }
  if (filters.batchKey) {
    conditions.push(eq(monitoringBatches.batchKey, filters.batchKey));
  }
  if (filters.from) {
    conditions.push(
      gte(
        monitoringSamples.collectedAt,
        parseMonitoringDateBoundary(filters.from, "from"),
      ),
    );
  }
  if (filters.to) {
    conditions.push(
      lte(
        monitoringSamples.collectedAt,
        parseMonitoringDateBoundary(filters.to, "to"),
      ),
    );
  }
  if (filters.query) {
    const pattern = likePattern(filters.query);
    conditions.push(
      or(
        like(monitoringSamples.question, pattern),
        like(monitoringSamples.content, pattern),
        like(monitoringSamples.platform, pattern),
      )!,
    );
  }
  const requestedModel = filters.model || filters.platform;
  if (requestedModel) {
    const availablePlatforms = await db
      .select({ value: monitoringSamples.platform })
      .from(monitoringSamples)
      .innerJoin(
        monitoringBatches,
        and(
          eq(monitoringBatches.id, monitoringSamples.batchId),
          eq(monitoringBatches.userId, input.userId),
        ),
      )
      .where(and(...conditions))
      .groupBy(monitoringSamples.platform)
      .limit(500);
    const matchedPlatforms = matchingMonitoringModelLabels(
      availablePlatforms.map((row) => row.value),
      requestedModel,
    );
    conditions.push(
      matchedPlatforms.length > 0
        ? inArray(monitoringSamples.platform, matchedPlatforms)
        : eq(monitoringSamples.platform, "\u0000"),
    );
  }
  const where = and(...conditions);
  const [totalRows, rows] = await Promise.all([
    db
      .select({ value: count() })
      .from(monitoringSamples)
      .innerJoin(
        monitoringBatches,
        and(
          eq(monitoringBatches.id, monitoringSamples.batchId),
          eq(monitoringBatches.userId, input.userId),
        ),
      )
      .where(where),
    db
      .select({
        id: monitoringSamples.id,
        sourceRecordId: monitoringSamples.sourceRecordId,
        questionId: monitoringSamples.questionId,
        question: monitoringSamples.question,
        platform: monitoringSamples.platform,
        answerNo: monitoringSamples.answerNo,
        content: monitoringSamples.content,
        citationCount: monitoringSamples.citationCount,
        monitorRank: monitoringSamples.monitorRank,
        screenshotUrl: monitoringSamples.screenshotUrl,
        collectedAt: monitoringSamples.collectedAt,
        batchKey: monitoringBatches.batchKey,
        sourceName: monitoringBatches.sourceName,
        batchRevision: monitoringBatches.revision,
      })
      .from(monitoringSamples)
      .innerJoin(
        monitoringBatches,
        and(
          eq(monitoringBatches.id, monitoringSamples.batchId),
          eq(monitoringBatches.userId, input.userId),
        ),
      )
      .where(where)
      .orderBy(
        filters.sortOrder === "asc"
          ? asc(monitoringSamples.collectedAt)
          : desc(monitoringSamples.collectedAt),
        asc(monitoringSamples.id),
      )
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize),
  ]);
  return {
    items: rows.map((row) => ({
      ...row,
      collectedAt: row.collectedAt.getTime(),
      collectedDate: monitoringBeijingDate(row.collectedAt),
      modelKey: monitoringModelKey(row.platform),
      modelLabel: row.platform,
    })),
    total: Number(totalRows[0]?.value ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

type ScopedMonitoringSample = {
  id: string;
  sourceRecordId: string;
  userId: number;
  batchId: string;
  questionId: string;
  question: string;
  batchKey: string;
  quotaPeriodId: string | null;
};

function monitoringSampleNotFound(): never {
  throw new AuthServiceError(
    "NOT_FOUND",
    "监控答案不存在或不属于当前批次、问题及有效服务周期",
  );
}

/**
 * The SQL query already applies this scope. Keeping the explicit assertion
 * makes the trust boundary visible and prevents a future query adapter or
 * mocked repository from accidentally returning a cross-tenant sample.
 */
export function assertMonitoringCitationSampleScope(input: {
  sample: ScopedMonitoringSample | undefined;
  requestedSampleId: string;
  userId: number;
  batchKey?: string;
  questionIds?: readonly string[];
  currentQuestion?: string;
  quotaPeriodIds?: readonly string[];
}) {
  const { sample } = input;
  if (
    !sample ||
    sample.userId !== input.userId ||
    (sample.id !== input.requestedSampleId &&
      sample.sourceRecordId !== input.requestedSampleId) ||
    (input.batchKey !== undefined && sample.batchKey !== input.batchKey) ||
    (input.questionIds !== undefined &&
      !input.questionIds.includes(sample.questionId)) ||
    (input.currentQuestion !== undefined &&
      sample.question !== input.currentQuestion) ||
    (input.quotaPeriodIds !== undefined &&
      (!sample.quotaPeriodId ||
        !input.quotaPeriodIds.includes(sample.quotaPeriodId)))
  ) {
    monitoringSampleNotFound();
  }
  return sample;
}

async function requireScopedMonitoringSample(input: {
  db: Awaited<ReturnType<typeof requireDb>>;
  userId: number;
  sampleId: string;
  batchKey?: string;
  questionIds?: readonly string[];
  currentQuestion?: string;
  quotaPeriodIds?: readonly string[];
  strictInternalId?: boolean;
}) {
  if (input.quotaPeriodIds && input.quotaPeriodIds.length === 0) {
    monitoringSampleNotFound();
  }
  const conditions = [
    eq(monitoringSamples.userId, input.userId),
    eq(monitoringBatches.userId, input.userId),
    input.strictInternalId
      ? eq(monitoringSamples.id, input.sampleId)
      : or(
          eq(monitoringSamples.id, input.sampleId),
          eq(monitoringSamples.sourceRecordId, input.sampleId),
        )!,
  ];
  if (input.batchKey) {
    conditions.push(eq(monitoringBatches.batchKey, input.batchKey));
  }
  if (input.questionIds) {
    conditions.push(inArray(monitoringSamples.questionId, input.questionIds));
  }
  if (input.currentQuestion) {
    conditions.push(eq(monitoringSamples.question, input.currentQuestion));
  }
  if (input.quotaPeriodIds) {
    conditions.push(
      inArray(monitoringBatches.quotaPeriodId, input.quotaPeriodIds),
    );
  }
  const rows = await input.db
    .select({
      id: monitoringSamples.id,
      sourceRecordId: monitoringSamples.sourceRecordId,
      userId: monitoringSamples.userId,
      batchId: monitoringSamples.batchId,
      questionId: monitoringSamples.questionId,
      question: monitoringSamples.question,
      batchKey: monitoringBatches.batchKey,
      quotaPeriodId: monitoringBatches.quotaPeriodId,
    })
    .from(monitoringSamples)
    .innerJoin(
      monitoringBatches,
      and(
        eq(monitoringBatches.id, monitoringSamples.batchId),
        eq(monitoringBatches.userId, input.userId),
      ),
    )
    .where(and(...conditions))
    .limit(1);
  return assertMonitoringCitationSampleScope({
    sample: rows[0],
    requestedSampleId: input.sampleId,
    userId: input.userId,
    batchKey: input.batchKey,
    questionIds: input.questionIds,
    currentQuestion: input.currentQuestion,
    quotaPeriodIds: input.quotaPeriodIds,
  });
}

export async function listMonitoringCitations(input: {
  userId: number;
  filters: ListMonitoringCitationsInput;
  quotaPeriodIds?: string[];
  questionScopeMode?: Exclude<QuestionMonitoringScopeMode, "lineage">;
}) {
  const db = await requireDb();
  const { filters } = input;
  if (
    input.quotaPeriodIds &&
    input.quotaPeriodIds.length === 0 &&
    !filters.sampleId
  ) {
    return {
      items: [],
      total: 0,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }
  const questionScope = filters.questionId
    ? await resolveQuestionMonitoringScopeWithDb(
        db,
        input.userId,
        filters.questionId,
        input.questionScopeMode,
      )
    : undefined;
  const questionIds = questionScope?.questionIds;
  const scopedSample = filters.sampleId
    ? await requireScopedMonitoringSample({
        db,
        userId: input.userId,
        sampleId: filters.sampleId,
        batchKey: filters.batchKey,
        questionIds,
        currentQuestion: questionScope?.currentQuestion,
        quotaPeriodIds: input.quotaPeriodIds,
      })
    : undefined;
  const conditions = [eq(monitoringCitationRecords.userId, input.userId)];
  if (input.quotaPeriodIds) {
    conditions.push(
      inArray(monitoringBatches.quotaPeriodId, input.quotaPeriodIds),
    );
  }
  if (scopedSample) {
    conditions.push(
      eq(monitoringCitationRecords.sampleId, scopedSample.id),
      eq(monitoringCitationRecords.batchId, scopedSample.batchId),
      eq(monitoringCitationRecords.questionId, scopedSample.questionId),
    );
    if (questionScope?.currentQuestion) {
      conditions.push(
        eq(monitoringCitationRecords.question, questionScope.currentQuestion),
      );
    }
  } else if (questionIds) {
    conditions.push(inArray(monitoringCitationRecords.questionId, questionIds));
    if (questionScope?.currentQuestion) {
      conditions.push(
        eq(monitoringCitationRecords.question, questionScope.currentQuestion),
      );
    }
  }
  if (filters.batchKey) {
    conditions.push(eq(monitoringBatches.batchKey, filters.batchKey));
  }
  if (filters.media) {
    conditions.push(eq(monitoringCitationRecords.media, filters.media));
  }
  if (filters.domain) {
    conditions.push(eq(monitoringCitationRecords.domain, filters.domain));
  }
  if (filters.from) {
    conditions.push(
      gte(
        monitoringCitationRecords.collectedAt,
        parseMonitoringDateBoundary(filters.from, "from"),
      ),
    );
  }
  if (filters.to) {
    conditions.push(
      lte(
        monitoringCitationRecords.collectedAt,
        parseMonitoringDateBoundary(filters.to, "to"),
      ),
    );
  }
  if (filters.query) {
    const pattern = likePattern(filters.query);
    conditions.push(
      or(
        like(monitoringCitationRecords.question, pattern),
        like(monitoringCitationRecords.title, pattern),
        like(monitoringCitationRecords.media, pattern),
        like(monitoringCitationRecords.domain, pattern),
        like(monitoringCitationRecords.url, pattern),
      )!,
    );
  }
  if (filters.model) {
    const availableModels = await db
      .select({ value: monitoringCitationRecords.model })
      .from(monitoringCitationRecords)
      .innerJoin(
        monitoringBatches,
        and(
          eq(monitoringBatches.id, monitoringCitationRecords.batchId),
          eq(monitoringBatches.userId, input.userId),
        ),
      )
      .where(and(...conditions))
      .groupBy(monitoringCitationRecords.model)
      .limit(500);
    const matchedModels = matchingMonitoringModelLabels(
      availableModels.map((row) => row.value),
      filters.model,
    );
    conditions.push(
      matchedModels.length > 0
        ? inArray(monitoringCitationRecords.model, matchedModels)
        : eq(monitoringCitationRecords.model, "\u0000"),
    );
  }
  const where = and(...conditions);
  const sortColumn =
    filters.sortBy === "publishedAt"
      ? monitoringCitationRecords.publishedAt
      : filters.sortBy === "question"
        ? monitoringCitationRecords.question
        : filters.sortBy === "model"
          ? monitoringCitationRecords.model
          : filters.sortBy === "title"
            ? monitoringCitationRecords.title
            : filters.sortBy === "media"
              ? monitoringCitationRecords.media
              : monitoringCitationRecords.collectedAt;
  const [totalRows, rows] = await Promise.all([
    db
      .select({ value: count() })
      .from(monitoringCitationRecords)
      .innerJoin(
        monitoringBatches,
        and(
          eq(monitoringBatches.id, monitoringCitationRecords.batchId),
          eq(monitoringBatches.userId, input.userId),
        ),
      )
      .where(where),
    db
      .select({
        id: monitoringCitationRecords.id,
        sourceRecordId: monitoringCitationRecords.sourceRecordId,
        sampleId: monitoringCitationRecords.sampleId,
        questionId: monitoringCitationRecords.questionId,
        question: monitoringCitationRecords.question,
        model: monitoringCitationRecords.model,
        title: monitoringCitationRecords.title,
        url: monitoringCitationRecords.url,
        media: monitoringCitationRecords.media,
        domain: monitoringCitationRecords.domain,
        publishedAt: monitoringCitationRecords.publishedAt,
        collectedAt: monitoringCitationRecords.collectedAt,
        batchKey: monitoringBatches.batchKey,
        sourceName: monitoringBatches.sourceName,
        batchRevision: monitoringBatches.revision,
      })
      .from(monitoringCitationRecords)
      .innerJoin(
        monitoringBatches,
        and(
          eq(monitoringBatches.id, monitoringCitationRecords.batchId),
          eq(monitoringBatches.userId, input.userId),
        ),
      )
      .where(where)
      .orderBy(
        filters.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn),
        asc(monitoringCitationRecords.id),
      )
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize),
  ]);
  return {
    items: rows.map((row) => ({
      ...row,
      publishedAt: row.publishedAt?.getTime() ?? null,
      collectedAt: row.collectedAt.getTime(),
    })),
    total: Number(totalRows[0]?.value ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/**
 * Returns only citations bound to one server-generated sample ID. This
 * deliberately does not accept sourceRecordId so a caller cannot make a
 * question-level citation look like evidence for a specific answer.
 */
export async function listMonitoringSampleCitations(input: {
  userId: number;
  value: ListMonitoringSampleCitationsInput;
  quotaPeriodIds?: string[];
}) {
  const db = await requireDb();
  const questionScope = await resolveQuestionMonitoringScopeWithDb(
    db,
    input.userId,
    input.value.questionId,
  );
  const sample = await requireScopedMonitoringSample({
    db,
    userId: input.userId,
    sampleId: input.value.sampleId,
    batchKey: input.value.batchKey,
    questionIds: questionScope.questionIds,
    currentQuestion: questionScope.currentQuestion,
    quotaPeriodIds: input.quotaPeriodIds,
    strictInternalId: true,
  });
  const baseConditions = [
    eq(monitoringCitationRecords.userId, input.userId),
    eq(monitoringCitationRecords.batchId, sample.batchId),
    eq(monitoringCitationRecords.questionId, sample.questionId),
    eq(monitoringCitationRecords.sampleId, sample.id),
    ...(questionScope.currentQuestion
      ? [eq(monitoringCitationRecords.question, questionScope.currentQuestion)]
      : []),
  ];
  const [totalRows, rows] = await Promise.all([
    db
      .select({ value: count() })
      .from(monitoringCitationRecords)
      .where(and(...baseConditions)),
    db
      .select({
        id: monitoringCitationRecords.id,
        sourceRecordId: monitoringCitationRecords.sourceRecordId,
        sampleId: monitoringCitationRecords.sampleId,
        questionId: monitoringCitationRecords.questionId,
        question: monitoringCitationRecords.question,
        model: monitoringCitationRecords.model,
        title: monitoringCitationRecords.title,
        url: monitoringCitationRecords.url,
        media: monitoringCitationRecords.media,
        domain: monitoringCitationRecords.domain,
        publishedAt: monitoringCitationRecords.publishedAt,
        collectedAt: monitoringCitationRecords.collectedAt,
      })
      .from(monitoringCitationRecords)
      .where(
        and(
          ...baseConditions,
          ...(input.value.cursor
            ? [gt(monitoringCitationRecords.id, input.value.cursor)]
            : []),
        ),
      )
      .orderBy(asc(monitoringCitationRecords.id))
      .limit(input.value.limit + 1),
  ]);
  const hasMore = rows.length > input.value.limit;
  const pageRows = hasMore ? rows.slice(0, input.value.limit) : rows;
  return {
    items: pageRows.map((row) => ({
      ...row,
      publishedAt: row.publishedAt?.getTime() ?? null,
      collectedAt: row.collectedAt.getTime(),
    })),
    total: Number(totalRows[0]?.value ?? 0),
    nextCursor: hasMore ? (pageRows.at(-1)?.id ?? null) : null,
  };
}

export async function getMonitoringCitationSummary(input: {
  userId: number;
  value: MonitoringCitationSummaryInput;
  quotaPeriodIds?: string[];
}) {
  const emptyResult = {
    batchKey: input.value.batchKey ?? null,
    questionId: input.value.questionId,
    from: input.value.from ?? null,
    to: input.value.to ?? null,
    model: input.value.model ?? null,
    ...summarizeMonitoringCitations([]),
  };
  if (input.quotaPeriodIds && input.quotaPeriodIds.length === 0) {
    return emptyResult;
  }

  const db = await requireDb();
  const questionScope = await resolveQuestionMonitoringScopeWithDb(
    db,
    input.userId,
    input.value.questionId,
  );
  const citationConditions = [
    eq(monitoringCitationRecords.userId, input.userId),
    eq(monitoringBatches.userId, input.userId),
    inArray(monitoringCitationRecords.questionId, questionScope.questionIds),
    ...(questionScope.currentQuestion
      ? [eq(monitoringCitationRecords.question, questionScope.currentQuestion)]
      : []),
  ];
  if (input.value.batchKey) {
    citationConditions.push(
      eq(monitoringBatches.batchKey, input.value.batchKey),
    );
  }
  if (input.value.from) {
    citationConditions.push(
      gte(
        monitoringCitationRecords.collectedAt,
        parseMonitoringDateBoundary(input.value.from, "from"),
      ),
    );
  }
  if (input.value.to) {
    citationConditions.push(
      lte(
        monitoringCitationRecords.collectedAt,
        parseMonitoringDateBoundary(input.value.to, "to"),
      ),
    );
  }
  if (input.quotaPeriodIds) {
    citationConditions.push(
      inArray(monitoringBatches.quotaPeriodId, input.quotaPeriodIds),
    );
  }
  if (input.value.model) {
    const availableModels = await db
      .select({ value: monitoringCitationRecords.model })
      .from(monitoringCitationRecords)
      .innerJoin(
        monitoringBatches,
        and(
          eq(monitoringBatches.id, monitoringCitationRecords.batchId),
          eq(monitoringBatches.userId, input.userId),
        ),
      )
      .where(and(...citationConditions))
      .groupBy(monitoringCitationRecords.model)
      .limit(500);
    const matchedModels = matchingMonitoringModelLabels(
      availableModels.map((row) => row.value),
      input.value.model,
    );
    citationConditions.push(
      matchedModels.length > 0
        ? inArray(monitoringCitationRecords.model, matchedModels)
        : eq(monitoringCitationRecords.model, "\u0000"),
    );
  }
  const rows = await db
    .select({
      title: monitoringCitationRecords.title,
      url: monitoringCitationRecords.url,
      media: monitoringCitationRecords.media,
      domain: monitoringCitationRecords.domain,
    })
    .from(monitoringCitationRecords)
    .innerJoin(
      monitoringBatches,
      and(
        eq(monitoringBatches.id, monitoringCitationRecords.batchId),
        eq(monitoringBatches.userId, input.userId),
      ),
    )
    .where(and(...citationConditions));
  return {
    batchKey: input.value.batchKey ?? null,
    questionId: input.value.questionId,
    from: input.value.from ?? null,
    to: input.value.to ?? null,
    model: input.value.model ?? null,
    ...summarizeMonitoringCitations(rows),
  };
}

export async function getMonitoringFilterOptions(
  userId: number,
  quotaPeriodIds?: string[],
  filters: MonitoringFilterOptionsInput = {},
) {
  const db = await requireDb();
  const emptyOptions = {
    batches: [],
    selectedBatchKey: filters.batchKey ?? null,
    questions: [],
    platforms: [],
    models: [],
    modelOptions: [],
    dates: [],
    dateOptions: [],
    media: [],
    domains: [],
  };
  if (quotaPeriodIds && quotaPeriodIds.length === 0) {
    return emptyOptions;
  }
  const batches = await db
    .select({
      id: monitoringBatches.id,
      batchKey: monitoringBatches.batchKey,
      sourceName: monitoringBatches.sourceName,
      collectedAt: monitoringBatches.collectedAt,
      revision: monitoringBatches.revision,
      sampleCount: monitoringBatches.sampleCount,
      citationCount: monitoringBatches.citationCount,
      updatedAt: monitoringBatches.updatedAt,
    })
    .from(monitoringBatches)
    .where(
      and(
        eq(monitoringBatches.userId, userId),
        ...(quotaPeriodIds
          ? [inArray(monitoringBatches.quotaPeriodId, quotaPeriodIds)]
          : []),
      ),
    )
    .orderBy(
      desc(monitoringBatches.collectedAt),
      desc(monitoringBatches.updatedAt),
    )
    .limit(100);
  const publicBatches = batches.map(
    ({ id: _id, updatedAt: _updatedAt, ...batch }) => ({
      ...batch,
      collectedAt: batch.collectedAt.getTime(),
    }),
  );
  if (batches.length === 0) {
    return { ...emptyOptions, batches: publicBatches };
  }
  const questionScope = filters.questionId
    ? await resolveQuestionMonitoringScopeWithDb(db, userId, filters.questionId)
    : undefined;
  const questionIds = questionScope?.questionIds;
  let eligibleBatches = batches;
  if (questionIds) {
    const [sampleBatchRows, citationBatchRows] = await Promise.all([
      db
        .select({ id: monitoringSamples.batchId })
        .from(monitoringSamples)
        .where(
          and(
            eq(monitoringSamples.userId, userId),
            inArray(
              monitoringSamples.batchId,
              batches.map((batch) => batch.id),
            ),
            inArray(monitoringSamples.questionId, questionIds),
            ...(questionScope?.currentQuestion
              ? [eq(monitoringSamples.question, questionScope.currentQuestion)]
              : []),
          ),
        )
        .groupBy(monitoringSamples.batchId),
      db
        .select({ id: monitoringCitationRecords.batchId })
        .from(monitoringCitationRecords)
        .where(
          and(
            eq(monitoringCitationRecords.userId, userId),
            inArray(
              monitoringCitationRecords.batchId,
              batches.map((batch) => batch.id),
            ),
            inArray(monitoringCitationRecords.questionId, questionIds),
            ...(questionScope?.currentQuestion
              ? [
                  eq(
                    monitoringCitationRecords.question,
                    questionScope.currentQuestion,
                  ),
                ]
              : []),
          ),
        )
        .groupBy(monitoringCitationRecords.batchId),
    ]);
    const eligibleIds = new Set(
      [...sampleBatchRows, ...citationBatchRows].map((row) => row.id),
    );
    eligibleBatches = batches.filter((batch) => eligibleIds.has(batch.id));
  }
  const selectedBatch =
    (filters.batchKey
      ? eligibleBatches.find((batch) => batch.batchKey === filters.batchKey)
      : eligibleBatches[0]) ?? null;
  if (!selectedBatch) {
    return {
      ...emptyOptions,
      batches: publicBatches,
    };
  }
  const selectedBatchIds = filters.batchKey
    ? [selectedBatch.id]
    : eligibleBatches.map((batch) => batch.id);
  const dateOptions = latestMonitoringBatchesByBeijingDate(eligibleBatches).map(
    ([dateKey, batch]) => ({
      value: batch.batchKey,
      batchKey: batch.batchKey,
      dateKey,
      collectedAt: batch.collectedAt.getTime(),
      revision: batch.revision,
      sourceName: batch.sourceName,
    }),
  );
  const sampleScope = and(
    eq(monitoringSamples.userId, userId),
    inArray(monitoringSamples.batchId, selectedBatchIds),
    ...(questionIds
      ? [inArray(monitoringSamples.questionId, questionIds)]
      : []),
    ...(questionScope?.currentQuestion
      ? [eq(monitoringSamples.question, questionScope.currentQuestion)]
      : []),
  );
  const citationScope = and(
    eq(monitoringCitationRecords.userId, userId),
    inArray(monitoringCitationRecords.batchId, selectedBatchIds),
    ...(questionIds
      ? [inArray(monitoringCitationRecords.questionId, questionIds)]
      : []),
    ...(questionScope?.currentQuestion
      ? [eq(monitoringCitationRecords.question, questionScope.currentQuestion)]
      : []),
  );
  const [
    sampleQuestions,
    citationQuestions,
    platforms,
    citationModels,
    sampleDates,
    citationDates,
    media,
    domains,
  ] = await Promise.all([
    db
      .select({
        id: monitoringSamples.questionId,
        label: monitoringSamples.question,
      })
      .from(monitoringSamples)
      .where(sampleScope)
      .groupBy(monitoringSamples.questionId, monitoringSamples.question)
      .orderBy(asc(monitoringSamples.question))
      .limit(500),
    db
      .select({
        id: monitoringCitationRecords.questionId,
        label: monitoringCitationRecords.question,
      })
      .from(monitoringCitationRecords)
      .where(citationScope)
      .groupBy(
        monitoringCitationRecords.questionId,
        monitoringCitationRecords.question,
      )
      .orderBy(asc(monitoringCitationRecords.question))
      .limit(500),
    db
      .select({ value: monitoringSamples.platform })
      .from(monitoringSamples)
      .where(sampleScope)
      .groupBy(monitoringSamples.platform)
      .orderBy(asc(monitoringSamples.platform))
      .limit(500),
    db
      .select({ value: monitoringCitationRecords.model })
      .from(monitoringCitationRecords)
      .where(citationScope)
      .groupBy(monitoringCitationRecords.model)
      .orderBy(asc(monitoringCitationRecords.model))
      .limit(500),
    db
      .select({ value: monitoringSamples.collectedAt })
      .from(monitoringSamples)
      .where(sampleScope)
      .groupBy(monitoringSamples.collectedAt)
      .orderBy(desc(monitoringSamples.collectedAt))
      .limit(1_000),
    db
      .select({ value: monitoringCitationRecords.collectedAt })
      .from(monitoringCitationRecords)
      .where(citationScope)
      .groupBy(monitoringCitationRecords.collectedAt)
      .orderBy(desc(monitoringCitationRecords.collectedAt))
      .limit(1_000),
    db
      .select({ value: monitoringCitationRecords.media })
      .from(monitoringCitationRecords)
      .where(citationScope)
      .groupBy(monitoringCitationRecords.media)
      .orderBy(asc(monitoringCitationRecords.media))
      .limit(500),
    db
      .select({ value: monitoringCitationRecords.domain })
      .from(monitoringCitationRecords)
      .where(citationScope)
      .groupBy(monitoringCitationRecords.domain)
      .orderBy(asc(monitoringCitationRecords.domain))
      .limit(500),
  ]);

  const questionById = new Map<string, string>();
  for (const question of [...sampleQuestions, ...citationQuestions]) {
    questionById.set(question.id, question.label);
  }
  const modelOptionByKey = new Map<string, { key: string; label: string }>();
  for (const label of [
    ...platforms.map((row) => row.value),
    ...citationModels.map((row) => row.value),
  ].filter(Boolean)) {
    const key = monitoringModelKey(label);
    if (!modelOptionByKey.has(key)) {
      modelOptionByKey.set(key, { key, label });
    }
  }
  const dates = [
    ...new Set(
      [...sampleDates, ...citationDates]
        .map((row) => monitoringBeijingDate(row.value))
        .filter(Boolean),
    ),
  ].sort((left, right) => right.localeCompare(left));
  return {
    batches: publicBatches,
    selectedBatchKey: selectedBatch.batchKey,
    questions: [...questionById].map(([id, label]) => ({ id, label })),
    platforms: platforms.map((row) => row.value).filter(Boolean),
    // models remains a label list for old clients; modelOptions is canonical.
    models: [...modelOptionByKey.values()].map((model) => model.label),
    modelOptions: [...modelOptionByKey.values()],
    dates,
    dateOptions,
    media: media.map((row) => row.value).filter(Boolean),
    domains: domains.map((row) => row.value).filter(Boolean),
  };
}
