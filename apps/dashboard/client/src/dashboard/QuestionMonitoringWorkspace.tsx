import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Layers3,
  MessageSquareQuote,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import MarkdownRenderer from "@/components/MarkdownRenderer";
import type { IntentQuestionGroup } from "@/components/ResponseLogicWorkspace";
import { trpc } from "@/lib/trpc";
import type { DashboardPayload } from "@shared/dashboard";
import {
  keywordCategoryKey,
  keywordCategoryTone,
} from "@shared/keyword-categories";
import "./question-monitoring-workspace.css";

const categoryOrder = ["reputation", "basic", "ranking", "comparison"] as const;

type CategoryMetadata = {
  label: string;
  eyebrow: string;
  description: string;
  tone: string;
  icon: LucideIcon;
};

const categoryMeta: Record<string, CategoryMetadata> = {
  reputation: {
    label: "美誉舆情",
    eyebrow: "美誉舆情",
    description: "信任证据、认可度与投入回报",
    tone: "plum",
    icon: MessageSquareQuote,
  },
  basic: {
    label: "产品场景",
    eyebrow: "产品场景",
    description: "产品、服务与使用决策场景",
    tone: "teal",
    icon: Layers3,
  },
  ranking: {
    label: "行业排名",
    eyebrow: "行业排名",
    description: "品类出现、答案位次与前五覆盖",
    tone: "amber",
    icon: BarChart3,
  },
  comparison: {
    label: "竞品对比",
    eyebrow: "竞品对比",
    description: "差异定位、比较边界与选择依据",
    tone: "blue",
    icon: Search,
  },
};

const managedCategoryIcons = [MessageSquareQuote, Layers3, BarChart3, Search];

type MonitoringIntent = {
  id: string;
  name: string;
  subtitle: string;
  questions: string[];
  questionIds?: string[];
};

type MonitoringCitation = {
  id?: string;
  title?: string;
  url?: string;
  media?: string;
  model?: string;
  domain?: string;
};

type MonitoringAnswer = {
  id?: string;
  sourceRecordId?: string;
  batchKey?: string;
  model?: string;
  modelName?: string;
  platform?: string;
  answerNo?: number;
  content?: string;
  citationCount?: number;
  monitorRank?: number;
  screenshotUrl?: string;
  collectedAt?: string;
  citations?: MonitoringCitation[];
};

type MonitoringQuestionRecord = {
  question: string;
  date?: string;
  answers: MonitoringAnswer[];
};

type MonitoringAnswerBook = {
  label?: string;
  platforms: Array<{
    name: string;
    questions: MonitoringQuestionRecord[];
  }>;
};

type ManagedMonitoringAnswer = DashboardPayload["monitoringAnswers"][number] & {
  sourceRecordId?: string;
  batchKey?: string;
  model?: string;
  modelName?: string;
};

const emptyMonitoringIntent: MonitoringIntent = {
  id: "",
  name: "",
  subtitle: "",
  questions: [],
};

export type MonitoringFilterOption = {
  value: string;
  label?: string;
  collectedAt?: string | number | null;
  dateKey?: string;
};

const modelLabelRules: ReadonlyArray<[RegExp, string]> = [
  [/(?:deep[\s_-]*seek|深度求索)/i, "DeepSeek"],
  [/(?:chat[\s_-]*gpt|openai|gpt[\s_-]*[345o])/i, "ChatGPT"],
  [/(?:通义|千问|qianwen|qwen)/i, "通义千问"],
  [/(?:豆包|doubao)/i, "豆包"],
  [/(?:腾讯)?元宝|yuanbao/i, "腾讯元宝"],
  [/(?:百度\s*(?:ai|智能)|文心|wenxin|ernie|baiduai)/i, "百度 AI"],
  [/(?:kimi|moonshot)/i, "Kimi"],
  [/(?:gemini|google\s*ai)/i, "Gemini"],
  [/(?:claude|anthropic)/i, "Claude"],
];

export function normalizeMonitoringModelName(value: unknown) {
  const normalized = cleanText(value).replace(/\s+/g, " ");
  if (!normalized) return "未标注模型";
  return (
    modelLabelRules.find(([pattern]) => pattern.test(normalized))?.[1] ||
    normalized
  );
}

function monitoringModelIdentity(value: unknown) {
  return normalizeMonitoringModelName(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function monitoringDateKey(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const normalized = String(value).trim();
  const directDate = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (directDate) return `${directDate[1]}-${directDate[2]}-${directDate[3]}`;
  const timestamp = typeof value === "number" ? value : Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return normalized;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : normalized;
}

function monitoringDateLabel(value: unknown) {
  const dateKey = monitoringDateKey(value);
  if (!dateKey) return "未标注日期";
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateKey;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function cleanText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\[\]\(@[^)]*\)/g, "")
    .replace(/\[citation:\d+\]/g, "")
    .replace(/@replace=\d+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFFFD]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanAnswerContent(value: unknown) {
  return cleanText(value)
    .replace(
      /如果你[^。！？\n]{0,120}(?:问我|继续问我|再问我|告诉我|需要)[^。！？\n]*[。！？～~]?/g,
      "",
    )
    .replace(
      /如需[^。！？\n]{0,120}(?:问我|了解|联系|获取)[^。！？\n]*[。！？～~]?/g,
      "",
    )
    .replace(/需要我[^。！？\n]{0,120}[吗么][？?]?/g, "")
    .replace(/要不要我[^。！？\n]{0,120}[？?]?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeHttpUrl(value: unknown) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function domainFromCitation(citation: MonitoringCitation) {
  const explicitDomain = cleanText(citation?.domain);
  if (explicitDomain) return explicitDomain;
  const href = safeHttpUrl(citation?.url || "");
  if (!href) return "";
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function compareCollectedAt(first: unknown, second: unknown) {
  const firstTime = Date.parse(String(first || ""));
  const secondTime = Date.parse(String(second || ""));
  if (Number.isFinite(firstTime) && Number.isFinite(secondTime)) {
    return secondTime - firstTime;
  }
  return String(second || "").localeCompare(String(first || ""), "zh-CN");
}

function buildManagedMonitoringData(
  questionGroups: IntentQuestionGroup[] | undefined,
  monitoringAnswers: ManagedMonitoringAnswer[] | undefined,
) {
  if (!Array.isArray(questionGroups)) return null;

  const answers = Array.isArray(monitoringAnswers) ? monitoringAnswers : [];
  const questionById = new Map<
    string,
    {
      group: IntentQuestionGroup;
      question: IntentQuestionGroup["questions"][number];
    }
  >();
  questionGroups.forEach((group) => {
    (group.questions || []).forEach((question) => {
      questionById.set(question.id, { group, question });
    });
  });

  const answerBooks: Record<string, MonitoringAnswerBook> = {};
  const meta: Record<string, CategoryMetadata> = {};
  const intents = questionGroups.map((group, groupIndex) => {
    const groupAnswers = answers.filter(
      (answer) => questionById.get(answer.questionId)?.group.id === group.id,
    );
    const platforms = new Map<string, Map<string, MonitoringQuestionRecord>>();

    groupAnswers.forEach((answer) => {
      const questionEntry = questionById.get(answer.questionId);
      if (!questionEntry) return;
      const platformName = answer.platform || "未标注平台";
      if (!platforms.has(platformName)) platforms.set(platformName, new Map());
      const platformQuestions = platforms.get(platformName)!;
      if (!platformQuestions.has(questionEntry.question.question)) {
        platformQuestions.set(questionEntry.question.question, {
          question: questionEntry.question.question,
          answers: [],
        });
      }
      platformQuestions.get(questionEntry.question.question)!.answers.push({
        id: answer.id,
        sourceRecordId: answer.sourceRecordId,
        batchKey: answer.batchKey,
        model: answer.model || answer.modelName || answer.platform,
        answerNo: answer.answerNo,
        content: answer.content,
        citationCount: answer.citationCount,
        monitorRank: answer.monitorRank,
        screenshotUrl: answer.screenshotUrl,
        collectedAt: answer.collectedAt || "",
        citations: answer.citations || [],
      });
    });

    answerBooks[group.id] = {
      label: group.title,
      platforms: [...platforms.entries()].map(([name, questions]) => ({
        name,
        questions: [...questions.values()],
      })),
    };

    const semanticTone =
      keywordCategoryTone(group.id) || keywordCategoryTone(group.title);
    meta[group.id] = {
      label: group.title,
      eyebrow: group.title,
      description: group.subtitle || "企业问题监测",
      tone: semanticTone || group.tone || "plum",
      icon: managedCategoryIcons[groupIndex % managedCategoryIcons.length],
    };

    return {
      id: group.id,
      name: group.title,
      subtitle: group.subtitle || "企业问题监测",
      questions: (group.questions || []).map((question) => question.question),
      questionIds: (group.questions || []).map((question) => question.id),
    };
  });

  return { intents, answerBooks, meta };
}

function questionAnswers(book: unknown, question: string) {
  const normalizedBook =
    book && typeof book === "object"
      ? (book as Partial<MonitoringAnswerBook>)
      : undefined;
  const answers = (normalizedBook?.platforms || []).flatMap((platform) => {
    const record = (platform.questions || []).find(
      (item) => item.question === question,
    );
    if (!record) return [];
    return (record.answers || []).map((answer) => ({
      ...answer,
      platform: platform.name,
      model: answer.model || platform.name,
      question: record.question,
      collectedAt: answer.collectedAt || record.date || "",
    }));
  });

  return answers.sort((first, second) => {
    const dateResult = compareCollectedAt(
      first.collectedAt,
      second.collectedAt,
    );
    if (dateResult !== 0) return dateResult;
    const platformResult = String(first.platform || "").localeCompare(
      String(second.platform || ""),
      "zh-CN",
    );
    if (platformResult !== 0) return platformResult;
    const answerNumberResult =
      Number(first.answerNo || 0) - Number(second.answerNo || 0);
    if (answerNumberResult !== 0) return answerNumberResult;
    return String(first.id || "").localeCompare(
      String(second.id || ""),
      "zh-CN",
    );
  });
}

function CitationList({
  citations,
  emptyMessage,
}: {
  citations: MonitoringCitation[];
  emptyMessage: string;
}) {
  if (citations.length === 0) {
    return (
      <div className="question-monitor-source-state empty">
        <strong>当前答案暂无精确信源</strong>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="question-monitor-source-list">
      {citations.map((citation, index) => {
        const href = safeHttpUrl(citation.url || "");
        const domain = domainFromCitation(citation);
        const title =
          cleanText(citation.title) ||
          domain ||
          href ||
          `引用信源 ${index + 1}`;
        const channel =
          cleanText(citation.media || citation.model) || "未标注来源";
        return (
          <article
            className="question-monitor-source-card"
            key={citation.id || `${citation.url || title}-${index}`}
          >
            <div className="question-monitor-source-title">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {title}
                  <ExternalLink aria-hidden="true" size={13} />
                </a>
              ) : (
                <strong>{title}</strong>
              )}
            </div>
            {href && <p title={href}>{href}</p>}
            <div className="question-monitor-source-tags">
              <span>{channel}</span>
              {domain && <span>{domain}</span>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

const CITATION_PAGE_SIZE = 10;

function CitationPagination({
  page,
  pageSize,
  total,
  loading,
  canGoNext,
  onPrevious,
  onNext,
}: {
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  canGoNext?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <nav
      className="question-monitor-source-pagination"
      aria-label="引用来源分页"
    >
      <button
        type="button"
        aria-label="上一页引用"
        disabled={loading || page <= 1}
        onClick={onPrevious}
      >
        <ChevronLeft aria-hidden="true" size={15} />
      </button>
      <span>
        {page} / {totalPages}
      </span>
      <button
        type="button"
        aria-label="下一页引用"
        disabled={loading || !(canGoNext ?? page < totalPages)}
        onClick={onNext}
      >
        <ChevronRight aria-hidden="true" size={15} />
      </button>
    </nav>
  );
}

function ManagedAnswerSources({
  answer,
  batchKey,
  questionId,
}: {
  answer: any;
  batchKey: string;
  questionId: string;
}) {
  const sampleId = answer?.id || "";
  const [cursorState, setCursorState] = useState<{
    cursor: string | undefined;
    previousCursors: Array<string | undefined>;
    page: number;
  }>({
    cursor: undefined,
    previousCursors: [],
    page: 1,
  });
  const citationQuery = trpc.workspace.monitoring.sampleCitations.useQuery(
    {
      sampleId,
      questionId,
      batchKey,
      cursor: cursorState.cursor,
      limit: CITATION_PAGE_SIZE,
    },
    {
      enabled: Boolean(sampleId && questionId && batchKey),
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  );

  useEffect(() => {
    setCursorState({ cursor: undefined, previousCursors: [], page: 1 });
  }, [batchKey, questionId, sampleId]);

  if (citationQuery.isLoading) {
    return (
      <div className="question-monitor-source-state" role="status">
        <span aria-hidden="true" />
        正在匹配当前答案的引用信源…
      </div>
    );
  }

  if (citationQuery.error) {
    return (
      <div className="question-monitor-source-state error" role="alert">
        当前答案的引用信源暂时无法读取，请稍后重试。
      </div>
    );
  }

  const citations = citationQuery.data?.items || [];
  const total = Math.max(0, Number(citationQuery.data?.total || 0));
  const totalPages = Math.max(1, Math.ceil(total / CITATION_PAGE_SIZE));
  const safePage = Math.min(cursorState.page, totalPages);
  const nextCursor = citationQuery.data?.nextCursor || null;

  return (
    <div className="question-monitor-source-results">
      <div className="question-monitor-source-summary" aria-live="polite">
        共 {total} 条引用
      </div>
      <CitationList
        citations={citations}
        emptyMessage="仅展示与当前答案样本精确绑定的引用；未关联样本的记录不会在这里混入。"
      />
      <CitationPagination
        page={safePage}
        pageSize={CITATION_PAGE_SIZE}
        total={total}
        loading={citationQuery.isFetching}
        canGoNext={Boolean(nextCursor)}
        onPrevious={() =>
          setCursorState((current) => {
            const previousCursors = current.previousCursors.slice(0, -1);
            return {
              cursor: current.previousCursors.at(-1),
              previousCursors,
              page: Math.max(1, current.page - 1),
            };
          })
        }
        onNext={() => {
          if (!nextCursor) return;
          setCursorState((current) => ({
            cursor: nextCursor,
            previousCursors: [...current.previousCursors, current.cursor],
            page: current.page + 1,
          }));
        }}
      />
    </div>
  );
}

function InlineAnswerSources({ answer }: { answer: any }) {
  const [page, setPage] = useState(1);
  const citations = answer?.citations || [];
  const total = citations.length;
  const totalPages = Math.max(1, Math.ceil(total / CITATION_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = citations.slice(
    (safePage - 1) * CITATION_PAGE_SIZE,
    safePage * CITATION_PAGE_SIZE,
  );

  useEffect(() => {
    setPage(1);
  }, [answer?.id]);

  return (
    <div className="question-monitor-source-results">
      <div className="question-monitor-source-summary" aria-live="polite">
        共 {total} 条引用
      </div>
      <CitationList
        citations={pageItems}
        emptyMessage="当前预览答案没有附带引用明细。"
      />
      <CitationPagination
        page={safePage}
        pageSize={CITATION_PAGE_SIZE}
        total={total}
        loading={false}
        onPrevious={() => setPage((current) => Math.max(1, current - 1))}
        onNext={() => setPage((current) => Math.min(totalPages, current + 1))}
      />
    </div>
  );
}

function AnswerSources({
  answer,
  batchKey,
  managed,
  monitoringAnswersError,
  monitoringAnswersLoading,
  questionId,
}: {
  answer: any;
  batchKey: string;
  managed: boolean;
  monitoringAnswersError: boolean;
  monitoringAnswersLoading: boolean;
  questionId: string;
}) {
  if (monitoringAnswersLoading) {
    return (
      <div className="question-monitor-source-state" role="status">
        <span aria-hidden="true" />
        正在读取当前问题的答案样本…
      </div>
    );
  }
  if (monitoringAnswersError) {
    return (
      <div className="question-monitor-source-state error" role="alert">
        当前问题的答案样本暂时无法读取，请稍后重试。
      </div>
    );
  }
  if (!answer) {
    return (
      <div className="question-monitor-source-state empty">
        <strong>暂无可匹配的答案</strong>
        <p>答案样本采集完成后，这里会展示其精确引用信源。</p>
      </div>
    );
  }
  if (managed) {
    return (
      <ManagedAnswerSources
        key={`${batchKey}:${questionId}:${answer.sourceRecordId || answer.id}`}
        answer={answer}
        batchKey={batchKey}
        questionId={questionId}
      />
    );
  }
  return <InlineAnswerSources key={answer.id} answer={answer} />;
}

export type QuestionMonitoringWorkspaceProps = {
  questionGroups?: IntentQuestionGroup[];
  monitoringAnswers?: ManagedMonitoringAnswer[];
  batchKey?: string;
  modelOptions?: Array<string | MonitoringFilterOption>;
  dateOptions?: MonitoringFilterOption[];
  selectedModel?: string;
  selectedDateFrom?: string;
  selectedDateTo?: string;
  onSelectedDateFromChange?: (date: string) => void;
  onSelectedDateToChange?: (date: string) => void;
  /** @deprecated Kept only for older preview fixtures. */
  selectedDate?: string;
  onSelectedModelChange?: (model: string) => void;
  /** @deprecated Use the date-range callbacks. */
  onSelectedDateChange?: (date: string) => void;
  onSelectedQuestionIdChange?: (questionId: string) => void;
  onSelectedQuestionChange?: (question: string) => void;
  distributionContent?: ReactNode;
  citationMode?: "server" | "inline";
  monitoringAnswersLoading?: boolean;
  monitoringAnswersError?: boolean;
  totalAnswerCount?: number;
  hasMoreAnswers?: boolean;
  loadingMoreAnswers?: boolean;
  onLoadMoreAnswers?: () => void;
  /** Development acceptance fixtures; formal callers must omit these. */
  previewIntents?: Array<{
    id: string;
    name: string;
    subtitle?: string;
    questions?: string[];
  }>;
  /** Development acceptance fixtures; formal callers must omit these. */
  previewAnswerBooks?: Record<string, unknown>;
};

export default function QuestionMonitoringWorkspace({
  questionGroups,
  monitoringAnswers,
  batchKey = "",
  modelOptions,
  dateOptions,
  selectedModel,
  selectedDateFrom,
  selectedDateTo,
  onSelectedDateFromChange,
  onSelectedDateToChange,
  selectedDate,
  onSelectedModelChange,
  onSelectedDateChange,
  onSelectedQuestionIdChange,
  onSelectedQuestionChange,
  distributionContent,
  citationMode,
  monitoringAnswersLoading = false,
  monitoringAnswersError = false,
  totalAnswerCount,
  hasMoreAnswers = false,
  loadingMoreAnswers = false,
  onLoadMoreAnswers,
  previewIntents = [],
  previewAnswerBooks = {},
}: QuestionMonitoringWorkspaceProps = {}) {
  const managedData = useMemo(
    () => buildManagedMonitoringData(questionGroups, monitoringAnswers),
    [monitoringAnswers, questionGroups],
  );
  const orderedIntents = useMemo<MonitoringIntent[]>(() => {
    if (managedData) return managedData.intents;
    return categoryOrder.flatMap((id) => {
      const intent = previewIntents.find((candidate) => candidate.id === id);
      return intent
        ? [
            {
              ...intent,
              subtitle: intent.subtitle || "",
              questions: intent.questions || [],
            },
          ]
        : [];
    });
  }, [managedData, previewIntents]);
  const activeAnswerBooks = managedData?.answerBooks || previewAnswerBooks;
  const activeCategoryMeta: Record<string, CategoryMetadata> =
    managedData?.meta || categoryMeta;
  const [selectedIntentId, setSelectedIntentId] = useState(
    orderedIntents[0]?.id || "reputation",
  );
  const selectedIntent =
    orderedIntents.find((intent) => intent.id === selectedIntentId) ||
    orderedIntents[0] ||
    emptyMonitoringIntent;
  const [selectedQuestion, setSelectedQuestion] = useState(
    selectedIntent.questions?.[0] || "",
  );
  const [localSelectedModel, setLocalSelectedModel] = useState("");
  const [localSelectedDateFrom, setLocalSelectedDateFrom] = useState("");
  const [localSelectedDateTo, setLocalSelectedDateTo] = useState("");
  const [answerIndex, setAnswerIndex] = useState(0);
  const answerBodyRef = useRef<HTMLDivElement>(null);
  const advanceAfterLoadRef = useRef(false);
  const sourceBodyRef = useRef<HTMLDivElement>(null);

  const questionIndex = Math.max(
    0,
    selectedIntent.questions.indexOf(selectedQuestion),
  );
  const managedQuestionId = useMemo(() => {
    if (!managedData) return "";
    return selectedIntent.questionIds?.[questionIndex] || "";
  }, [managedData, questionIndex, selectedIntent]);
  const unfilteredAnswers = useMemo(
    () =>
      questionAnswers(activeAnswerBooks[selectedIntent.id], selectedQuestion),
    [activeAnswerBooks, selectedIntent.id, selectedQuestion],
  );
  const effectiveModelOptions = useMemo(() => {
    const source =
      modelOptions && modelOptions.length > 0
        ? modelOptions
        : unfilteredAnswers.map((answer) => answer.model || answer.platform);
    const seen = new Set<string>();
    return source.flatMap((option) => {
      const value =
        typeof option === "string" ? option : String(option?.value || "");
      if (!value) return [];
      const identity = monitoringModelIdentity(value);
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [
        {
          value,
          label: normalizeMonitoringModelName(
            typeof option === "string" ? option : option.label || value,
          ),
          identity,
        },
      ];
    });
  }, [modelOptions, unfilteredAnswers]);
  const effectiveDateOptions = useMemo<
    Array<{ value: string; dateKey: string; label: string }>
  >(() => {
    const source: MonitoringFilterOption[] =
      dateOptions && dateOptions.length > 0
        ? dateOptions
        : unfilteredAnswers.map((answer) => ({
            value: monitoringDateKey(answer.collectedAt),
            collectedAt: answer.collectedAt,
          }));
    const seen = new Set<string>();
    return source.flatMap((option) => {
      const value = String(option?.value || "");
      if (!value || seen.has(value)) return [];
      seen.add(value);
      const dateKey =
        option.dateKey ||
        monitoringDateKey(option.collectedAt) ||
        monitoringDateKey(value);
      return [
        {
          value,
          dateKey,
          label:
            option.label ||
            monitoringDateLabel(option.collectedAt || option.dateKey || value),
        },
      ];
    });
  }, [dateOptions, unfilteredAnswers]);
  const requestedModel =
    selectedModel === undefined ? localSelectedModel : selectedModel;
  const activeModel = effectiveModelOptions.some(
    (option) => option.value === requestedModel,
  )
    ? requestedModel
    : effectiveModelOptions[0]?.value || "";
  const availableDateKeys = useMemo(
    () =>
      [
        ...new Set(
          effectiveDateOptions
            .map((option) => option.dateKey || monitoringDateKey(option.value))
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort(),
    [effectiveDateOptions],
  );
  const legacyDateKey =
    effectiveDateOptions.find((option) => option.value === selectedDate)
      ?.dateKey || monitoringDateKey(selectedDate);
  const requestedDateFrom =
    selectedDateFrom !== undefined
      ? selectedDateFrom
      : selectedDate !== undefined
        ? legacyDateKey
        : localSelectedDateFrom;
  const requestedDateTo =
    selectedDateTo !== undefined
      ? selectedDateTo
      : selectedDate !== undefined
        ? legacyDateKey
        : localSelectedDateTo;
  const activeDateFrom = availableDateKeys.includes(requestedDateFrom)
    ? requestedDateFrom
    : availableDateKeys[0] || "";
  const activeDateTo = availableDateKeys.includes(requestedDateTo)
    ? requestedDateTo
    : availableDateKeys.at(-1) || "";
  const answers = useMemo(() => {
    const modelIdentity = activeModel
      ? monitoringModelIdentity(activeModel)
      : "";
    return unfilteredAnswers.filter((answer) => {
      const matchesModel =
        !modelIdentity ||
        monitoringModelIdentity(answer.model || answer.platform) ===
          modelIdentity;
      const answerDate = monitoringDateKey(answer.collectedAt);
      const matchesDate =
        !answerDate ||
        ((!activeDateFrom || answerDate >= activeDateFrom) &&
          (!activeDateTo || answerDate <= activeDateTo));
      return matchesModel && matchesDate;
    });
  }, [activeDateFrom, activeDateTo, activeModel, unfilteredAnswers]);
  const safeAnswerIndex = Math.min(
    answerIndex,
    Math.max(0, answers.length - 1),
  );
  const displayedAnswerTotal = Math.max(
    answers.length,
    Number(totalAnswerCount || 0),
  );
  const currentAnswer = answers[safeAnswerIndex] || null;
  const usesServerCitations =
    citationMode === "server" ||
    (citationMode !== "inline" &&
      Boolean(managedData && onSelectedQuestionIdChange));

  useEffect(() => {
    if (activeModel === requestedModel) return;
    onSelectedModelChange?.(activeModel);
  }, [
    activeModel,
    effectiveModelOptions,
    onSelectedModelChange,
    requestedModel,
    selectedModel,
  ]);

  useEffect(() => {
    if (activeDateFrom === requestedDateFrom) return;
    if (selectedDateFrom === undefined && selectedDate === undefined) {
      setLocalSelectedDateFrom(activeDateFrom);
    }
    onSelectedDateFromChange?.(activeDateFrom);
  }, [
    activeDateFrom,
    onSelectedDateFromChange,
    requestedDateFrom,
    selectedDate,
    selectedDateFrom,
  ]);

  useEffect(() => {
    if (activeDateTo === requestedDateTo) return;
    if (selectedDateTo === undefined && selectedDate === undefined) {
      setLocalSelectedDateTo(activeDateTo);
    }
    onSelectedDateToChange?.(activeDateTo);
  }, [
    activeDateTo,
    onSelectedDateToChange,
    requestedDateTo,
    selectedDate,
    selectedDateTo,
  ]);

  useEffect(() => {
    if (
      orderedIntents.length === 0 ||
      selectedIntent.questions.includes(selectedQuestion)
    ) {
      return;
    }
    setSelectedIntentId(orderedIntents[0]?.id || "");
    setSelectedQuestion(orderedIntents[0]?.questions?.[0] || "");
    setAnswerIndex(0);
  }, [orderedIntents, selectedIntent, selectedQuestion]);

  useEffect(() => {
    if (managedQuestionId) {
      onSelectedQuestionIdChange?.(managedQuestionId);
    }
  }, [managedQuestionId, onSelectedQuestionIdChange]);

  useEffect(() => {
    onSelectedQuestionChange?.(selectedQuestion);
  }, [onSelectedQuestionChange, selectedQuestion]);

  useEffect(() => {
    if (answerIndex !== safeAnswerIndex) setAnswerIndex(safeAnswerIndex);
  }, [answerIndex, safeAnswerIndex]);

  useEffect(() => {
    advanceAfterLoadRef.current = false;
    setAnswerIndex(0);
  }, [
    activeDateFrom,
    activeDateTo,
    activeModel,
    managedQuestionId,
    selectedQuestion,
  ]);

  useEffect(() => {
    if (advanceAfterLoadRef.current && answers.length > safeAnswerIndex + 1) {
      advanceAfterLoadRef.current = false;
      setAnswerIndex(safeAnswerIndex + 1);
    }
  }, [answers.length, safeAnswerIndex]);

  useEffect(() => {
    if (answerBodyRef.current) answerBodyRef.current.scrollTop = 0;
    if (sourceBodyRef.current) sourceBodyRef.current.scrollTop = 0;
  }, [currentAnswer?.id, selectedQuestion]);

  function selectCategory(intent: MonitoringIntent) {
    advanceAfterLoadRef.current = false;
    setSelectedIntentId(intent.id);
    setSelectedQuestion(intent.questions[0] || "");
    setAnswerIndex(0);
  }

  function selectQuestionValue(question: string) {
    if (!selectedIntent.questions.includes(question)) return;
    advanceAfterLoadRef.current = false;
    setSelectedQuestion(question);
    setAnswerIndex(0);
  }

  function selectModelValue(model: string) {
    advanceAfterLoadRef.current = false;
    if (selectedModel === undefined) setLocalSelectedModel(model);
    onSelectedModelChange?.(model);
    setAnswerIndex(0);
  }

  function selectDateFromValue(date: string) {
    advanceAfterLoadRef.current = false;
    if (selectedDateFrom === undefined) setLocalSelectedDateFrom(date);
    onSelectedDateFromChange?.(date);
    if (activeDateTo && date > activeDateTo) {
      if (selectedDateTo === undefined) setLocalSelectedDateTo(date);
      onSelectedDateToChange?.(date);
    }
    onSelectedDateChange?.(date);
    setAnswerIndex(0);
  }

  function selectDateToValue(date: string) {
    advanceAfterLoadRef.current = false;
    if (selectedDateTo === undefined) setLocalSelectedDateTo(date);
    onSelectedDateToChange?.(date);
    if (activeDateFrom && date < activeDateFrom) {
      if (selectedDateFrom === undefined) setLocalSelectedDateFrom(date);
      onSelectedDateFromChange?.(date);
    }
    setAnswerIndex(0);
  }

  function showNextAnswer() {
    if (safeAnswerIndex < answers.length - 1) {
      setAnswerIndex((current) => current + 1);
      return;
    }
    if (!hasMoreAnswers || loadingMoreAnswers || !onLoadMoreAnswers) return;
    advanceAfterLoadRef.current = true;
    onLoadMoreAnswers();
  }

  if (orderedIntents.length === 0) {
    return (
      <section className="page-shell question-monitor-page">
        <header className="question-monitor-header">
          <div className="question-monitor-header-copy">
            <span>MindPromise智诺 / 进度监控 / 问题监控</span>
            <h2>问题监控</h2>
            <p>管理员发布问题清单后，可在这里查看各平台的监测样本。</p>
          </div>
        </header>
        <MonitoringDistributionSection>
          {distributionContent}
        </MonitoringDistributionSection>
      </section>
    );
  }

  return (
    <section className="page-shell question-monitor-page">
      <header className="question-monitor-header">
        <div className="question-monitor-header-copy">
          <span>MindPromise智诺 / 进度监控 / 问题监控</span>
          <h2>问题监控</h2>
          <p>持续追踪核心问题在主流 AI 平台中的真实回答与精确引用来源。</p>
        </div>
      </header>

      <div className="question-monitor-workspace-grid">
        <nav className="question-monitor-categories" aria-label="问题监控维度">
          <header>
            <span>问题分类</span>
            <small>选择分类后，在问题框中选择要查看的问题</small>
          </header>
          {orderedIntents.map((intent) => {
            const meta = activeCategoryMeta[intent.id];
            const Icon = meta.icon;
            const active = intent.id === selectedIntent.id;
            const categoryKey =
              keywordCategoryKey(intent.id) || keywordCategoryKey(meta.label);
            return (
              <button
                type="button"
                key={intent.id}
                data-category={categoryKey || undefined}
                className={`${meta.tone} ${active ? "active" : ""}`}
                aria-pressed={active}
                onClick={() => selectCategory(intent)}
              >
                <span className="question-monitor-category-icon">
                  <Icon aria-hidden="true" size={18} />
                </span>
                <span>
                  {meta.eyebrow && meta.eyebrow !== meta.label ? (
                    <small>{meta.eyebrow}</small>
                  ) : null}
                  <strong>{meta.label}</strong>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="question-monitor-workspace-main">
          <section
            className="question-monitor-browser"
            aria-labelledby="question-monitor-browser-title"
          >
            <header className="question-monitor-browser-header">
              <h3 id="question-monitor-browser-title">答案浏览</h3>
              <div className="question-monitor-filter-grid">
                <label className="question-monitor-filter question">
                  <span>问题</span>
                  <div className="question-monitor-question-switcher">
                    <select
                      aria-label="监控问题"
                      value={selectedQuestion}
                      onChange={(event) =>
                        selectQuestionValue(event.currentTarget.value)
                      }
                    >
                      {selectedIntent.questions.map((question) => (
                        <option key={question} value={question}>
                          {cleanText(question)}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                <label className="question-monitor-filter">
                  <span>模型</span>
                  <select
                    aria-label="监控模型"
                    value={activeModel}
                    disabled={effectiveModelOptions.length === 0}
                    onChange={(event) =>
                      selectModelValue(event.currentTarget.value)
                    }
                  >
                    {effectiveModelOptions.length === 0 ? (
                      <option value="">暂无模型</option>
                    ) : (
                      effectiveModelOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="question-monitor-filter">
                  <span>开始日期</span>
                  <input
                    type="date"
                    aria-label="监控开始日期"
                    value={activeDateFrom}
                    min={availableDateKeys[0]}
                    max={activeDateTo || availableDateKeys.at(-1)}
                    disabled={effectiveDateOptions.length === 0}
                    onChange={(event) =>
                      selectDateFromValue(event.currentTarget.value)
                    }
                  />
                </label>
                <label className="question-monitor-filter">
                  <span>结束日期</span>
                  <input
                    type="date"
                    aria-label="监控结束日期"
                    value={activeDateTo}
                    min={activeDateFrom || availableDateKeys[0]}
                    max={availableDateKeys.at(-1)}
                    disabled={effectiveDateOptions.length === 0}
                    onChange={(event) =>
                      selectDateToValue(event.currentTarget.value)
                    }
                  />
                </label>
              </div>
            </header>

            <div
              className="question-monitor-announcement"
              aria-live="polite"
              aria-atomic="true"
            >
              {answers.length > 0
                ? `所选范围共有 ${displayedAnswerTotal} 条具体回答，正在查看第 ${safeAnswerIndex + 1} 条。`
                : monitoringAnswersLoading
                  ? "正在读取答案样本。"
                  : "暂无答案样本。"}
            </div>

            <div className="question-monitor-browser-grid">
              <section
                className="question-monitor-answer-pane"
                aria-labelledby="question-monitor-answer-pane-title"
              >
                <header>
                  <div className="question-monitor-pane-title">
                    <span id="question-monitor-answer-pane-title">
                      答案内容
                    </span>
                  </div>
                  <div className="question-monitor-answer-switcher">
                    <button
                      type="button"
                      aria-label="上一条答案"
                      disabled={safeAnswerIndex === 0 || answers.length === 0}
                      onClick={() =>
                        setAnswerIndex((current) => Math.max(0, current - 1))
                      }
                    >
                      <ChevronLeft aria-hidden="true" size={18} />
                    </button>
                    <span aria-label="当前答案序号">
                      {answers.length > 0 ? safeAnswerIndex + 1 : 0} /{" "}
                      {displayedAnswerTotal}
                    </span>
                    <button
                      type="button"
                      aria-label="下一条答案"
                      disabled={
                        answers.length === 0 ||
                        loadingMoreAnswers ||
                        (safeAnswerIndex >= answers.length - 1 &&
                          !hasMoreAnswers)
                      }
                      onClick={showNextAnswer}
                    >
                      <ChevronRight aria-hidden="true" size={18} />
                    </button>
                  </div>
                </header>

                {monitoringAnswersLoading ? (
                  <div className="question-monitor-answer-state" role="status">
                    <span aria-hidden="true" />
                    正在读取当前问题的答案样本…
                  </div>
                ) : monitoringAnswersError ? (
                  <div
                    className="question-monitor-answer-state error"
                    role="alert"
                  >
                    当前问题的答案样本暂时无法读取，请稍后重试。
                  </div>
                ) : currentAnswer ? (
                  <div
                    className="question-monitor-answer-body"
                    ref={answerBodyRef}
                  >
                    <MarkdownRenderer
                      content={
                        cleanAnswerContent(currentAnswer.content) ||
                        "当前答案没有可展示的正文。"
                      }
                    />
                  </div>
                ) : (
                  <div className="question-monitor-answer-empty">
                    <strong>等待同步答案记录</strong>
                    <p>查看各AI平台的答案与引用信源记录</p>
                  </div>
                )}
              </section>

              <aside
                className="question-monitor-source-pane"
                aria-labelledby="question-monitor-source-pane-title"
              >
                <header>
                  <div>
                    <span id="question-monitor-source-pane-title">
                      该答案引用来源
                    </span>
                    <small>仅展示与当前答案精确绑定的记录</small>
                  </div>
                </header>
                <div
                  className="question-monitor-source-body"
                  ref={sourceBodyRef}
                >
                  <AnswerSources
                    answer={currentAnswer}
                    batchKey={currentAnswer?.batchKey || batchKey}
                    managed={usesServerCitations}
                    monitoringAnswersError={monitoringAnswersError}
                    monitoringAnswersLoading={monitoringAnswersLoading}
                    questionId={managedQuestionId}
                  />
                </div>
              </aside>
            </div>
          </section>

          <MonitoringDistributionSection>
            {distributionContent}
          </MonitoringDistributionSection>
        </div>
      </div>
    </section>
  );
}

function MonitoringDistributionSection({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <section className="question-monitor-distribution" aria-label="渠道分发">
      {children}
    </section>
  );
}
