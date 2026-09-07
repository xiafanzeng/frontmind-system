import type {
  MonitorRun,
  MonitorSummary,
  ProjectSummary,
  RunAttempt,
} from "../../domain";

export const MONITORING_TABS = [
  { id: "overview", label: "指标看板" },
  { id: "answers", label: "问答明细" },
  { id: "metrics", label: "指标明细" },
  { id: "trends", label: "趋势分析" },
  { id: "competitors", label: "竞品排名" },
  { id: "citations", label: "引用分析" },
  { id: "sources", label: "信源分布" },
  { id: "goods", label: "商品统计" },
  { id: "videos", label: "视频统计" },
] as const;

export type MonitoringTab = (typeof MONITORING_TABS)[number]["id"];
export type SourceScope = "all" | "cited" | "discovered";
export type DateRange = "7d" | "30d" | "90d" | "custom";
export type MonitoringSubject = "self" | `competitor:${string}`;

export type MonitoringQueryState = {
  projectId?: string;
  monitorId?: string;
  tab: MonitoringTab;
  subject: MonitoringSubject;
  runId?: string;
  question?: string;
  model?: string;
  range: DateRange;
  from: string;
  to: string;
  answerQuestion?: string;
  answerId?: string;
  sourceScope: SourceScope;
  fullscreen: boolean;
};

export type MonitoringQueryContext = {
  project?: ProjectSummary;
  monitors: MonitorSummary[];
  runs: MonitorRun[];
  currentRun?: MonitorRun;
  attempts?: RunAttempt[];
  runIds?: string[];
  questionIds?: string[];
  modelIds?: string[];
  subjects?: MonitoringSubject[];
  allowUnresolved?: boolean;
};

export type SourceAggregate = {
  key: string;
  title: string;
  domain: string;
  url?: string;
  count: number;
  answerIds: Set<string>;
};

export type AttemptMetricRow = {
  key: string;
  question: string;
  total: number;
  completed: number;
  effective: number;
  mentionRate?: number;
  top1Rate?: number;
  top3Rate?: number;
  top10Rate?: number;
  averagePosition?: number;
  citations: number;
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    unknown: number;
  };
};

export function attemptModelKey(attempt: RunAttempt) {
  return attempt.platformId || `${attempt.platformCode}:${attempt.clientType}`;
}

export function clientTypeLabel(clientType: RunAttempt["clientType"]) {
  return clientType === "web" ? "网页版" : "手机版";
}

export function attemptModelLabel(attempt: RunAttempt) {
  return `${attempt.platformName}（${clientTypeLabel(attempt.clientType)}）`;
}
