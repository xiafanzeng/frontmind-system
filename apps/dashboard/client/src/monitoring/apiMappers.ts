import type { AppRouter } from "@frontmind/monitoring-api";
import type { inferRouterOutputs } from "@trpc/server";

import {
  calculateRunMetrics,
  type MonitorInput,
  type MonitorRun,
  type MonitorSummary,
  type ProjectSummary,
  type ProviderModel,
  type RegionOption,
  type RunAttempt,
  type RunMetrics,
  type RunStatus,
  type SessionUser,
} from "./domain";
import type { AdminAuditEntry, AdminRun, AdminUser } from "./pages/AdminPage";
import { mapBillingSummaryView } from "./billingAdapters";
import type { BillingSummaryView } from "./pages/SettingsPage";

type Outputs = inferRouterOutputs<AppRouter>;
type RunSourceOutput = Outputs["runs"]["get"]["sources"][number];
type RunDiscoveredSourceOutput =
  Outputs["runs"]["get"]["discoveredSources"][number];

function mapResultSource(source: RunSourceOutput | RunDiscoveredSourceOutput) {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    domain: source.domain,
    order: source.ordinal,
    providerPosition: source.providerPosition,
    citedText:
      "citedText" in source ? source.citedText || undefined : undefined,
    isCited:
      "isCited" in source
        ? source.isCited
        : source.citationProvenance === "explicit",
    citationProvenance: source.citationProvenance,
    siteName: source.siteName,
    summary: source.summary,
    publishedAt: source.publishedAt,
  };
}

export function mapSession(output: Outputs["auth"]["me"]): {
  user: SessionUser;
  billing: BillingSummaryView;
} {
  return {
    user: {
      id: output.user.id,
      username: output.user.username,
      displayName: output.user.username,
      role: output.user.role,
    },
    billing: mapBillingSummaryView(output.billing),
  };
}

export function mapProject(
  value: Outputs["projects"]["list"][number],
): ProjectSummary {
  return {
    id: value.id,
    name: value.name,
    brandName: value.mainBrand,
    brandAliases: value.aliases,
    competitors: value.competitors,
    timezone: value.timezone,
  };
}

export function mapProviderModel(
  value:
    | Outputs["platforms"]["list"][number]
    | Outputs["admin"]["platforms"]["list"][number],
): ProviderModel {
  return {
    id: value.id,
    code: value.providerCode,
    name: value.displayName,
    clientType: value.clientType,
    enabled: value.enabled,
    verified: value.verified,
    acceptanceRequired: value.acceptanceRequired,
    capabilities: {
      reasoning: value.supportsReasoning,
      screenshot: value.supportsScreenshot,
      screenshotMention:
        value.acceptance?.screenshotMention === "passed" ||
        (!value.acceptance && value.supportsScreenshot),
      screenshotAll:
        value.acceptance?.screenshotAll === "passed" ||
        (!value.acceptance && value.supportsScreenshot),
      region: value.supportsDomesticRegion,
      overseas: value.supportsOverseasRegion,
    },
    acceptance: value.acceptance,
  };
}

export function mapRegion(
  value: Outputs["regions"]["list"][number],
): RegionOption {
  return { code: value.code, name: value.name, scope: value.scope };
}

export function mapMonitor(
  value: Outputs["monitors"]["list"][number],
): MonitorSummary {
  const lastStatus = asRunStatus(value.lastRunStatus);
  return {
    id: value.id,
    projectId: value.projectId,
    name: value.name,
    questionsCount: Number(value.questionsCount),
    platformsCount: Number(value.platformsCount),
    repetitions: value.repetitions || 1,
    scheduleLabel: scheduleLabel(
      value.scheduleType,
      value.scheduleLocalTime,
      value.scheduleWeekday,
    ),
    status: value.status === "deleted" ? "paused" : value.status,
    activeVersion: Number(value.activeVersion),
    waitingQuotaOccurrences: Number(value.waitingQuotaOccurrences || 0),
    nextRunAt: iso(value.nextRunAt),
    lastRun:
      value.lastRunId && lastStatus
        ? {
            id: value.lastRunId,
            status: lastStatus,
            completed: Number(value.lastRunCompletedAttempts || 0),
            expected: Number(value.lastRunExpectedAttempts || 0),
            completedAt: iso(value.lastRunCompletedAt),
          }
        : undefined,
  };
}

export function monitorDetailToInput(
  output: Outputs["monitors"]["get"],
  models: ProviderModel[],
): MonitorInput {
  const platformModels = output.platforms.map((platform) =>
    models.find((model) => model.id === platform.platformId),
  );
  return {
    name: output.version.name,
    competitors: output.version.competitors,
    questions: output.questions.map((question) => question.questionSnapshot),
    platforms: output.platforms.map((platform, index) => ({
      platformId: platform.platformId,
      providerCode:
        platformModels[index]?.code || platform.providerCodeSnapshot,
      clientType: platform.clientType,
      mode: platform.mode,
      screenshot: asScreenshot(platform.screenshot),
      regionCode: platform.clientType === "mobile" ? null : platform.regionCode,
    })),
    repetitions: output.version.repetitions,
    schedule: {
      type: output.monitor.scheduleType,
      timezone: output.monitor.scheduleTimezone,
      localTime: output.monitor.scheduleLocalTime,
      weekday: output.monitor.scheduleWeekday || undefined,
    },
  };
}

export function monitorInputToConfiguration(
  value: MonitorInput,
  project: ProjectSummary,
  models: ProviderModel[],
) {
  return {
    name: value.name,
    brandAliases: project.brandAliases,
    competitors: value.competitors,
    questions: value.questions,
    platforms: value.platforms.map((selection) => {
      const model = models.find((item) => item.id === selection.platformId);
      return {
        platformId: selection.platformId,
        providerCode: selection.providerCode,
        clientType: selection.clientType,
        mode: selection.mode,
        screenshot: model?.capabilities.screenshot
          ? selection.screenshot
          : (0 as const),
        regionCode:
          selection.clientType === "mobile"
            ? null
            : model?.capabilities.overseas || model?.capabilities.region
              ? selection.regionCode
              : null,
      };
    }),
    repetitions: value.repetitions,
    schedule: {
      type: value.schedule.type,
      timezone: value.schedule.timezone,
      localTime: value.schedule.localTime || "09:00",
      weekday:
        value.schedule.type === "weekly" ? value.schedule.weekday || 1 : null,
    },
  };
}

export function mapMonitorDetailSummary(
  value: Outputs["monitors"]["get"],
  latestRun?: MonitorRun,
): MonitorSummary {
  return {
    id: value.monitor.id,
    projectId: value.monitor.projectId,
    name: value.version.name,
    questionsCount: value.questions.length,
    platformsCount: value.platforms.length,
    repetitions: value.version.repetitions,
    scheduleLabel: scheduleLabel(
      value.monitor.scheduleType,
      value.monitor.scheduleLocalTime,
      value.monitor.scheduleWeekday,
    ),
    status:
      value.monitor.status === "deleted" ? "paused" : value.monitor.status,
    activeVersion: value.version.version,
    nextRunAt: iso(value.monitor.nextRunAt),
    lastRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          completed: latestRun.metrics.completed,
          expected: latestRun.metrics.expected,
          completedAt: latestRun.completedAt,
        }
      : undefined,
  };
}

export function mapRunSummary(
  value: Outputs["runs"]["list"][number],
  monitorName: string,
  version = 1,
): MonitorRun {
  const effective = Number(value.metrics.effectiveAnswers || 0);
  const metrics: RunMetrics = {
    expected: value.expectedAttempts,
    queued: Math.max(0, value.expectedAttempts - value.submittedAttempts),
    processing: Math.max(
      0,
      value.submittedAttempts -
        value.completedAttempts -
        value.failedAttempts -
        value.stoppedAttempts,
    ),
    completed: value.completedAttempts,
    effectiveAnswers: effective,
    failed: value.failedAttempts,
    stopped: value.stoppedAttempts,
    mentionRate: effective
      ? Math.round(
          (Number(value.metrics.brandMentionedAnswers || 0) / effective) *
            1_000,
        ) / 10
      : undefined,
    averageMentionPosition:
      value.metrics.averageMentionPosition === null
        ? undefined
        : Number(value.metrics.averageMentionPosition),
    citations: Number(value.metrics.citationCount || 0),
    uniqueDomains: Number(value.metrics.uniqueDomainCount || 0),
    sentiment: {
      positive: Number(value.metrics.positiveCount || 0),
      neutral: Number(value.metrics.neutralCount || 0),
      negative: Number(value.metrics.negativeCount || 0),
      unknown: Number(value.metrics.unknownCount || 0),
    },
    modelPerformance: value.metrics.modelMetrics.map((model) => {
      const effectiveAnswers = Number(model.effectiveAnswers || 0);
      const mentionPositionCount = Number(model.mentionPositionCount || 0);
      return {
        platformId: model.platformId,
        providerCode: model.providerCode,
        clientType: model.clientType,
        mode: model.mode,
        effectiveAnswers,
        mentionRate: effectiveAnswers
          ? Math.round(
              (Number(model.brandMentionedAnswers || 0) / effectiveAnswers) *
                1_000,
            ) / 10
          : undefined,
        averageMentionPosition: mentionPositionCount
          ? Math.round(
              (Number(model.mentionPositionSum || 0) / mentionPositionCount) *
                10,
            ) / 10
          : undefined,
        citations: Number(model.citationCount || 0),
        sentiment: {
          positive: Number(model.positiveCount || 0),
          neutral: Number(model.neutralCount || 0),
          negative: Number(model.negativeCount || 0),
          unknown: Number(model.unknownCount || 0),
        },
      };
    }),
    competitorPerformance: value.metrics.competitorMetrics.map((competitor) => {
      const positionCount = Number(competitor.positionCount || 0);
      return {
        name: competitor.name,
        appearances: Number(competitor.appearances || 0),
        averagePosition: positionCount
          ? Math.round(
              (Number(competitor.positionSum || 0) / positionCount) * 10,
            ) / 10
          : undefined,
      };
    }),
  };
  return {
    id: value.id,
    monitorId: value.monitorId,
    monitorName,
    status: value.status,
    trigger: value.trigger,
    version: readNumericProperty(value, "configurationVersion") || version,
    createdAt: iso(value.createdAt)!,
    startedAt: iso(value.startedAt),
    completedAt: iso(value.completedAt),
    metrics,
    attempts: [],
    config: {
      brandName: "",
      brandAliases: [],
      competitors: [],
      questions: [],
      platforms: [],
      repetitions: 1,
      screenshotPolicy: 0,
      regionLabel: "供应商默认",
    },
  };
}

export function mapRunDetail(output: Outputs["runs"]["get"]): MonitorRun {
  const platformByOrdinal = new Map(
    output.configuration.platforms.map((platform) => [
      platform.ordinal,
      platform,
    ]),
  );
  const sourcesByRevision = groupBy(
    output.sources,
    (source) => source.revisionId,
  );
  const discoveredSourcesByRevision = groupBy(
    output.discoveredSources,
    (source) => source.revisionId,
  );
  const mediaByRevision = groupBy(output.media, (media) => media.revisionId);
  const attempts: RunAttempt[] = output.attempts.map(({ attempt, result }) => {
    const platform = platformByOrdinal.get(attempt.monitorPlatformOrdinal);
    const sources = result
      ? sourcesByRevision.get(result.currentRevisionId) || []
      : [];
    const discoveredSources = result
      ? discoveredSourcesByRevision.get(result.currentRevisionId) || []
      : [];
    const explicitSources =
      result?.citationProvenance === "explicit" ? sources : [];
    const media = result
      ? mediaByRevision.get(result.currentRevisionId) || []
      : [];
    return {
      id: attempt.id,
      questionId: `${output.run.monitorVersionId}:${attempt.monitorQuestionOrdinal}`,
      question: attempt.question,
      platformCode: attempt.providerCode,
      platformName: platform?.displayName || attempt.providerCode,
      clientType: attempt.clientType,
      mode: attempt.mode,
      screenshotPolicy: asScreenshot(attempt.screenshot),
      regionCode: attempt.regionCode || undefined,
      repetition: attempt.repetition,
      status: attempt.status,
      answer: result?.answerMarkdown || undefined,
      reasoning: result?.reasoningMarkdown || undefined,
      capturedAt: iso(result?.updatedAt) || iso(attempt.terminalAt),
      sentiment: result?.sentiment,
      brandMentioned: result?.brandMentioned,
      mentionPosition: result?.mentionPosition,
      sources: explicitSources.map(mapResultSource),
      citationProvenance: result?.citationProvenance,
      allSources: (discoveredSources.length ? discoveredSources : sources).map(
        mapResultSource,
      ),
      assets: media
        .filter((item) => item.type !== "raw_response")
        .map((item) => ({
          id: item.id,
          type: item.type as "screenshot" | "image" | "video" | "goods",
          title:
            item.type === "screenshot"
              ? "回答截图"
              : item.type === "goods"
                ? "商品附件"
                : item.type === "video"
                  ? "视频附件"
                  : "图片附件",
          url: item.accessPath || undefined,
          thumbnailUrl: item.thumbnailAccessPath || undefined,
          archiveStatus: item.archiveStatus,
        })),
      searchKeywords: result?.searchKeywords || [],
      competitorRankings: result?.competitorRankings || [],
      keywordEvaluations:
        result?.keywordEvaluations.map((evaluation) => ({
          keyword: evaluation.keyword,
          nature: evaluation.nature,
          context: evaluation.context,
        })) || [],
      categoryRanking: result?.categoryRanking || undefined,
      revision: result?.revision,
      resultUpdatedAt: iso(result?.updatedAt),
      error: attempt.errorMessage || undefined,
    };
  });
  const configPlatforms = output.configuration.platforms.map((platform) => ({
    platformId: platform.platformId,
    providerCode: platform.providerCodeSnapshot,
    displayName: platform.displayName || platform.providerCodeSnapshot,
    clientType: platform.clientType,
    mode: platform.mode,
    screenshotPolicy: asScreenshot(platform.screenshot),
    regionCode: platform.regionCode || undefined,
  }));
  const screenshotPolicies = output.configuration.platforms.map((platform) =>
    asScreenshot(platform.screenshot),
  );
  const regions = Array.from(
    new Set(
      output.configuration.platforms.flatMap((platform) =>
        platform.regionCode ? [platform.regionCode] : [],
      ),
    ),
  );
  return {
    id: output.run.id,
    monitorId: output.run.monitorId,
    monitorName: output.configuration.version.name,
    status: output.run.status,
    trigger: output.run.trigger,
    version: output.configuration.version.version,
    createdAt: iso(output.run.createdAt)!,
    startedAt: iso(output.run.startedAt),
    completedAt: iso(output.run.completedAt),
    metrics: calculateRunMetrics(attempts, output.run.expectedAttempts),
    attempts,
    config: {
      brandName: output.configuration.brand.mainBrand,
      brandAliases: output.configuration.version.brandAliases,
      competitors: output.configuration.version.competitors,
      questions: output.configuration.questions.map(
        (question) => question.questionSnapshot,
      ),
      platforms: configPlatforms,
      repetitions: output.configuration.version.repetitions,
      screenshotPolicy: screenshotPolicies.find((value) => value !== 0) ?? 0,
      regionLabel: regions.length ? regions.join("、") : "供应商默认",
    },
  };
}

export function mapAdminUser(
  value: Outputs["admin"]["users"]["list"][number],
): AdminUser {
  return {
    id: value.id,
    username: value.username,
    role: value.role,
    active: value.status === "active",
    granted: Number(value.grantedUnits || 0),
    consumed: Number(value.consumedUnits || 0),
    reserved: Number(value.reservedUnits || 0),
    lastSeenAt: iso(value.lastLoginAt),
  };
}

export function mapAdminRun(
  value: Outputs["admin"]["runs"]["list"][number],
): AdminRun {
  return {
    id: value.run.id,
    username: value.username,
    monitorName: value.monitorName,
    status: value.run.status,
    expected: value.run.expectedAttempts,
    completed: value.run.completedAttempts,
    failed: value.run.failedAttempts,
    createdAt: iso(value.run.createdAt),
    startedAt: iso(value.run.startedAt),
    completedAt: iso(value.run.completedAt),
  };
}

export function mapAdminOperationRun(
  value: Outputs["admin"]["operations"]["list"]["items"][number],
): AdminRun {
  return {
    ...mapAdminRun(value),
    userId: value.userId,
  };
}

export function mapAudit(
  value: Outputs["admin"]["audit"]["list"][number],
): AdminAuditEntry {
  return {
    id: value.id,
    actorId: value.actorId || undefined,
    actorRole: value.actorRole || undefined,
    action: value.action,
    targetType: value.targetType,
    targetIdHash: value.targetIdHash || undefined,
    createdAt: iso(value.createdAt),
  };
}

function scheduleLabel(
  type: "none" | "daily" | "weekly",
  localTime: string,
  weekday: number | null,
) {
  if (type === "none") return "手动执行";
  if (type === "daily") return `每日 ${localTime}`;
  return `每周${["一", "二", "三", "四", "五", "六", "日"][(weekday || 1) - 1]} ${localTime}`;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function asRunStatus(value: string | null): RunStatus | undefined {
  return [
    "queued",
    "waiting_quota",
    "running",
    "completed",
    "partial_completed",
    "failed",
    "review_required",
    "cancelled",
  ].includes(value || "")
    ? (value as RunStatus)
    : undefined;
}

function asScreenshot(value: number): 0 | 1 | 2 {
  return value === 1 || value === 2 ? value : 0;
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items)
    grouped.set(key(item), [...(grouped.get(key(item)) || []), item]);
  return grouped;
}

function readNumericProperty(value: object, key: string) {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number"
    ? candidate
    : typeof candidate === "string"
      ? Number(candidate)
      : undefined;
}
