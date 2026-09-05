export type MoliProviderMode =
  "standard" | "reasoning" | "search" | "reasoning_search";
export type MoliScreenshotPolicy = 0 | 1 | 2;
export type MoliClientType = "web" | "mobile";

export type MoliTaskStatus =
  | "pending"
  | "processing"
  | "completed"
  | "partial_completed"
  | "failed"
  | "stopped"
  | "unknown";

export type MoliSubTaskStatus =
  | "pending"
  | "assigned"
  | "processing"
  | "completed"
  | "stopped"
  | "failed"
  | "error"
  | "unknown";

export type MoliSentiment = "positive" | "neutral" | "negative";
export type MoliCitationProvenance = "explicit" | "unavailable";

export interface MoliKeywordEvaluation {
  keyword: string;
  nature: MoliSentiment;
  context?: string;
}

export interface MoliCompetitorInput {
  name: string;
  aliases?: readonly string[];
}

export interface SubmitSingleAttemptInput {
  attemptId: string;
  consumerTaskId?: string;
  monitorKeyword?: string;
  monitorKeywordAliases?: readonly string[];
  competitors?: readonly MoliCompetitorInput[];
  prompt: string;
  platform: string;
  clientType: MoliClientType;
  mode: MoliProviderMode;
  screenshot: MoliScreenshotPolicy;
  regionCode?: string;
  callbackUrl?: string;
}

export interface SubmitTaskResponse {
  taskId: string;
  /** Present only when the 1x1 submission response identifies exactly one child task. */
  subTaskId?: string;
  totalTask?: number;
  consumerTaskId: string;
  createdAt?: Date;
  rawCreatedAt?: string | number;
  raw: unknown;
}

export interface MoliModel {
  platform: string;
  name: string;
  clientType: MoliClientType;
  displayName?: string;
  enabledByProvider?: boolean;
  raw: Readonly<Record<string, unknown>>;
}

export interface MoliRegion {
  code: string;
  name: string;
  scope: "domestic" | "overseas";
  raw: Readonly<Record<string, unknown>>;
}

export interface MoliTaskStatusResponse {
  taskId: string;
  status: MoliTaskStatus;
  total?: number;
  completed?: number;
  failed?: number;
  updatedAt?: Date;
  rawUpdatedAt?: string | number;
  raw: unknown;
}

export interface MoliReference {
  title?: string;
  url: string;
  domain?: string;
  siteName?: string;
  snippet?: string;
  publishedAt?: string;
  iconUrl?: string;
  position?: number;
  raw: Readonly<Record<string, unknown>>;
}

export interface MoliMedia {
  kind: "screenshot" | "image" | "video" | "goods" | "other";
  url: string;
  title?: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface MoliResultItem {
  subTaskId?: string;
  platform?: string;
  status: MoliSubTaskStatus;
  answerContent: string;
  reasoningProcess?: string;
  searchKeywords: readonly string[];
  /** Sources actually cited in the answer. Empty when citationList is unavailable. */
  references: readonly MoliReference[];
  /** Whether the provider explicitly returned citationList for this result. */
  citationProvenance: MoliCitationProvenance;
  /** Every source returned by the provider, whether cited in the final answer or not. */
  allReferences: readonly MoliReference[];
  media: readonly MoliMedia[];
  sentiment?: MoliSentiment;
  mentionPosition?: number;
  mentionContext?: string;
  competitorRankings?: unknown;
  allRankings?: unknown;
  categoryRanking?: unknown;
  keywordEvaluations?: readonly MoliKeywordEvaluation[];
  amount?: string;
  errorMessage?: string;
  updatedAt?: Date;
  rawUpdatedAt?: string | number;
  /** Deliberately excludes provider-generated recommendedQuestions. */
  raw: Readonly<Record<string, unknown>>;
}

export interface MoliTaskResult {
  taskId: string;
  status: MoliTaskStatus;
  items: readonly MoliResultItem[];
  raw: unknown;
}

export interface MoliBalance {
  currentBalance?: string;
  available?: string;
  frozen?: string;
  currency?: string;
  raw: unknown;
}

export interface MoliBillingSummary {
  startDate?: string;
  endDate?: string;
  totalAmount?: string;
  taskCount?: number;
  raw: unknown;
}

export interface MoliBillingRecord {
  id?: string;
  taskId?: string;
  subTaskId?: string;
  consumerTaskId?: string;
  amount?: string;
  status?: string;
  occurredAt?: Date;
  rawOccurredAt?: string | number;
  taskCreatedAt?: Date;
  rawTaskCreatedAt?: string | number;
  taskCompletedAt?: Date;
  rawTaskCompletedAt?: string | number;
  description?: string;
  aiModel?: string;
  aiModelText?: string;
  question?: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface MoliBillingRecordsPage {
  records: readonly MoliBillingRecord[];
  page?: number;
  pageSize?: number;
  total?: number;
  raw: unknown;
}

export interface BillingQuery {
  startDate: string;
  endDate: string;
  aiModel?: string;
  taskId?: string;
  pageNum?: number;
  pageSize?: number;
}

export interface MoliClientOptions {
  token: string;
  origin?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  userAgent?: string;
}
