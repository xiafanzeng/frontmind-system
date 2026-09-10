export type Role = "user" | "admin";
export type ClientType = "web" | "mobile";
export type ScheduleType = "none" | "daily" | "weekly";
export type ScreenshotPolicy = 0 | 1 | 2;
export type ProviderMode = "search" | "reasoning_search";

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
};

export type CompetitorInput = {
  name: string;
  aliases: string[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  brandName: string;
  brandAliases: string[];
  competitors: CompetitorInput[];
  timezone: string;
};

export type ProviderModel = {
  id: string;
  code: string;
  name: string;
  clientType: ClientType;
  enabled: boolean;
  verified: boolean;
  acceptanceRequired?: boolean;
  capabilities: {
    reasoning: boolean;
    screenshot: boolean;
    screenshotMention?: boolean;
    screenshotAll?: boolean;
    region: boolean;
    overseas: boolean;
  };
  acceptance?: {
    searchDefault: string;
    reasoningSearch: string;
    screenshotMention: string;
    screenshotAll: string;
    regionDefault: string;
    regionDomestic: string;
    regionOverseas: string;
    mobileNoRegion: string;
  };
};

export type RegionOption = {
  code: string;
  name: string;
  scope: "domestic" | "overseas";
};

export type MonitorPlatformInput = {
  platformId: string;
  providerCode: string;
  clientType: ClientType;
  mode: ProviderMode;
  screenshot: ScreenshotPolicy;
  regionCode: string | null;
};

export type MonitorInput = {
  name: string;
  competitors: CompetitorInput[];
  questions: string[];
  platforms: MonitorPlatformInput[];
  repetitions: number;
  schedule: {
    type: ScheduleType;
    timezone: string;
    localTime?: string;
    weekday?: number;
  };
};

export type MonitorSummary = {
  id: string;
  projectId: string;
  name: string;
  questionsCount: number;
  platformsCount: number;
  repetitions: number;
  scheduleLabel: string;
  status: "draft" | "active" | "paused";
  lastRun?: {
    id: string;
    status: RunStatus;
    completed: number;
    expected: number;
    completedAt?: string;
  };
  nextRunAt?: string;
  activeVersion?: number;
  waitingQuotaOccurrences?: number;
};

export type RunStatus =
  | "queued"
  | "waiting_quota"
  | "running"
  | "completed"
  | "partial_completed"
  | "failed"
  | "review_required"
  | "cancelled";

export type AttemptStatus =
  | "queued"
  | "submitting"
  | "submission_unknown"
  | "accepted"
  | "processing"
  | "completed"
  | "failed"
  | "stopped"
  | "error"
  | "cancelled_before_submit"
  | "review_required";

export type ResultSource = {
  id: string;
  title: string;
  url?: string;
  domain?: string;
  order: number;
  providerPosition?: number | null;
  citedText?: string;
  /** True only when the provider put the source in citationList. */
  isCited: boolean;
  /** Why the result's citation status can or cannot be trusted. */
  citationProvenance?: CitationProvenance;
  siteName?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
  /** Reserved for trusted API output; the UI does not fetch provider icon URLs. */
  iconUrl?: string | null;
};

export type CitationProvenance = "explicit" | "legacy_assumed" | "unavailable";

export type KeywordEvaluation = {
  keyword: string;
  nature: "positive" | "neutral" | "negative";
  context?: string | null;
};

export type ResultAsset = {
  id: string;
  type: "screenshot" | "image" | "video" | "goods";
  title?: string;
  url?: string;
  thumbnailUrl?: string;
  archiveStatus?: "pending" | "archived" | "failed" | "not_applicable";
};

export type RunAttempt = {
  id: string;
  /** Stable run identity used by the cross-run monitoring workspace. */
  runId?: string;
  questionId: string;
  question: string;
  /** Stable configured platform identity returned by monitoring read APIs. */
  platformId?: string;
  platformCode: string;
  platformName: string;
  clientType: ClientType;
  mode: ProviderMode;
  screenshotPolicy: ScreenshotPolicy;
  regionCode?: string;
  repetition: number;
  status: AttemptStatus;
  /** Truncated list copy; never render it as the authoritative answer body. */
  answerPreview?: string;
  answer?: string;
  reasoning?: string;
  capturedAt?: string;
  submittedAt?: string;
  terminalAt?: string;
  sentiment?: "positive" | "neutral" | "negative" | "unknown";
  brandMentioned?: boolean;
  mentionPosition?: number | null;
  /** Citation rows; inspect citationProvenance before treating legacy rows as explicit. */
  sources: ResultSource[];
  /** `legacy_assumed` and `unavailable` should be shown with a warning. */
  citationProvenance?: CitationProvenance;
  /** All provider-returned sources, including uncited discovery results. */
  allSources: ResultSource[];
  assets: ResultAsset[];
  searchKeywords?: string[];
  competitorRankings?: Array<Record<string, unknown>>;
  keywordEvaluations?: KeywordEvaluation[];
  categoryRanking?: Record<string, unknown> | null;
  revision?: number;
  resultUpdatedAt?: string;
  error?: string;
};

export type RunMetrics = {
  expected: number;
  queued: number;
  processing: number;
  completed: number;
  effectiveAnswers?: number;
  failed: number;
  stopped: number;
  mentionRate?: number;
  averageMentionPosition?: number;
  citations: number;
  uniqueDomains: number;
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    unknown: number;
  };
  modelPerformance?: RunModelPerformance[];
  competitorPerformance?: RunCompetitorPerformance[];
};

export type RunModelPerformance = {
  platformId: string;
  providerCode: string;
  clientType: ClientType;
  mode: ProviderMode;
  effectiveAnswers: number;
  mentionRate?: number;
  averageMentionPosition?: number;
  citations: number;
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    unknown: number;
  };
};

export type RunCompetitorPerformance = {
  name: string;
  appearances: number;
  averagePosition?: number;
};

export type MonitorRun = {
  id: string;
  monitorId: string;
  monitorName: string;
  status: RunStatus;
  trigger: "manual" | "scheduled" | "catch_up";
  version: number;
  /** Authoritative instant used to include the run in monitoring date ranges. */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metrics: RunMetrics;
  attempts: RunAttempt[];
  config: {
    brandName: string;
    brandAliases: string[];
    competitors: CompetitorInput[];
    questions: string[];
    platforms: Array<{
      platformId: string;
      providerCode: string;
      displayName: string;
      clientType: ClientType;
      mode: ProviderMode;
      screenshotPolicy: ScreenshotPolicy;
      regionCode?: string;
    }>;
    repetitions: number;
    screenshotPolicy: ScreenshotPolicy;
    regionLabel: string;
  };
};

export function dedupeQuestions(value: string) {
  const seen = new Set<string>();
  let removed = 0;
  const questions: string[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const question = raw.trim();
    if (!question) continue;
    if (seen.has(question)) {
      removed += 1;
      continue;
    }
    seen.add(question);
    questions.push(question);
  }
  return { questions, removed };
}

export function calculateAttempts(
  questionCount: number,
  platformCount: number,
  repetitions: number,
) {
  return questionCount * platformCount * repetitions;
}

export function calculateRunMetrics(
  attempts: RunAttempt[],
  expected: number,
): RunMetrics {
  const completed = attempts.filter(
    (attempt) =>
      attempt.status === "completed" && Boolean(attempt.answer?.trim()),
  );
  const failed = attempts.filter(
    (attempt) => attempt.status === "failed" || attempt.status === "error",
  ).length;
  const stopped = attempts.filter(
    (attempt) =>
      attempt.status === "stopped" ||
      attempt.status === "cancelled_before_submit",
  ).length;
  const processing = attempts.filter((attempt) =>
    [
      "submitting",
      "submission_unknown",
      "accepted",
      "processing",
      "review_required",
    ].includes(attempt.status),
  ).length;
  const queued = attempts.filter(
    (attempt) => attempt.status === "queued",
  ).length;
  const mentions = completed.filter((attempt) => attempt.brandMentioned);
  const positions = completed.flatMap((attempt) =>
    attempt.mentionPosition ? [attempt.mentionPosition] : [],
  );
  const domains = new Set(
    completed.flatMap((attempt) =>
      attempt.sources.map((source) => source.domain).filter(Boolean),
    ) as string[],
  );
  const sentiment = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
  for (const attempt of completed)
    sentiment[attempt.sentiment || "unknown"] += 1;
  return {
    expected,
    queued,
    processing,
    completed: completed.length,
    effectiveAnswers: completed.length,
    failed,
    stopped,
    mentionRate: completed.length
      ? Math.round((mentions.length / completed.length) * 1_000) / 10
      : undefined,
    averageMentionPosition: positions.length
      ? Math.round(
          (positions.reduce((sum, position) => sum + position, 0) /
            positions.length) *
            10,
        ) / 10
      : undefined,
    citations: completed.reduce(
      (sum, attempt) => sum + attempt.sources.length,
      0,
    ),
    uniqueDomains: domains.size,
    sentiment,
  };
}

export function runStatusLabel(status: RunStatus) {
  const labels: Record<RunStatus, string> = {
    queued: "排队中",
    waiting_quota: "余额不足待执行",
    running: "采集中",
    completed: "已完成",
    partial_completed: "部分完成",
    failed: "采集失败",
    review_required: "需要复核",
    cancelled: "已取消",
  };
  return labels[status];
}

export function monitorStatusLabel(status: MonitorSummary["status"]) {
  const labels: Record<MonitorSummary["status"], string> = {
    draft: "待启动",
    active: "运行中",
    paused: "已暂停",
  };
  return labels[status];
}

export function attemptStatusLabel(status: AttemptStatus) {
  const labels: Record<AttemptStatus, string> = {
    queued: "等待",
    submitting: "提交中",
    submission_unknown: "提交待确认",
    accepted: "已受理",
    processing: "处理中",
    completed: "完成",
    failed: "失败",
    stopped: "已停止",
    error: "异常",
    cancelled_before_submit: "已取消",
    review_required: "需复核",
  };
  return labels[status];
}

export function formatDateTime(value?: string) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}
