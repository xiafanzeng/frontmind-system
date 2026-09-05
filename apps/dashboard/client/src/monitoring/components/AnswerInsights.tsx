import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, CircleHelp, FileSearch, Quote, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import type { KeywordEvaluation, ResultSource, RunAttempt } from "../domain";

type Sentiment = "positive" | "neutral" | "negative" | "unknown";
type EvaluatedSentiment = Exclude<Sentiment, "unknown">;

const KEYWORD_PREVIEW_LIMIT = 16;

const sentimentMeta: Record<
  Sentiment,
  { label: string; shortLabel: string; color: string }
> = {
  positive: { label: "正面", shortLabel: "正", color: "#17a980" },
  neutral: { label: "中性", shortLabel: "中", color: "#8b9bb1" },
  negative: { label: "负面", shortLabel: "负", color: "#eb4f6f" },
  unknown: { label: "未知", shortLabel: "未", color: "#d4d9e2" },
};

export type KeywordInsight = {
  key: string;
  keyword: string;
  normalizedKeyword: string;
  nature: EvaluatedSentiment;
  answerCount: number;
  occurrences: number;
  conflicted: boolean;
  contexts: Array<{
    attemptId: string;
    question: string;
    platformName: string;
    context?: string;
  }>;
};

export type SentimentInsights = {
  effectiveAnswers: number;
  knownAnswers: number;
  counts: Record<Sentiment, number>;
  keywords: Record<EvaluatedSentiment, KeywordInsight[]>;
};

type MutableKeywordInsight = {
  normalizedKeyword: string;
  nature: EvaluatedSentiment;
  answerIds: Set<string>;
  occurrences: number;
  displayNames: Map<string, number>;
  contexts: KeywordInsight["contexts"];
};

export function effectiveAnswerAttempts(attempts: RunAttempt[]) {
  return attempts.filter(
    (attempt) =>
      attempt.status === "completed" && Boolean(attempt.answer?.trim()),
  );
}

export function normalizeInsightKeyword(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
}

export function buildSentimentInsights(
  attempts: RunAttempt[],
): SentimentInsights {
  const effective = effectiveAnswerAttempts(attempts);
  const counts: Record<Sentiment, number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
    unknown: 0,
  };
  const grouped = new Map<string, MutableKeywordInsight>();
  const naturesByKeyword = new Map<string, Set<EvaluatedSentiment>>();

  for (const attempt of effective) {
    const sentiment = isSentiment(attempt.sentiment)
      ? attempt.sentiment
      : "unknown";
    counts[sentiment] += 1;

    const seenInAnswer = new Set<string>();
    for (const evaluation of attempt.keywordEvaluations || []) {
      if (!isKeywordEvaluation(evaluation)) continue;
      const displayName = evaluation.keyword
        .normalize("NFKC")
        .trim()
        .replace(/\s+/gu, " ");
      const normalizedKeyword = normalizeInsightKeyword(displayName);
      if (!normalizedKeyword) continue;
      const key = `${evaluation.nature}:${normalizedKeyword}`;
      if (seenInAnswer.has(key)) continue;
      seenInAnswer.add(key);

      const current: MutableKeywordInsight = grouped.get(key) || {
        normalizedKeyword,
        nature: evaluation.nature,
        answerIds: new Set<string>(),
        occurrences: 0,
        displayNames: new Map<string, number>(),
        contexts: [],
      };
      current.answerIds.add(attempt.id);
      current.occurrences += 1;
      current.displayNames.set(
        displayName,
        (current.displayNames.get(displayName) || 0) + 1,
      );
      const context = evaluation.context?.trim()
        ? evaluation.context
        : undefined;
      current.contexts.push({
        attemptId: attempt.id,
        question: attempt.question,
        platformName: attempt.platformName,
        context,
      });
      grouped.set(key, current);

      const natures = naturesByKeyword.get(normalizedKeyword) || new Set();
      natures.add(evaluation.nature);
      naturesByKeyword.set(normalizedKeyword, natures);
    }
  }

  const keywords: SentimentInsights["keywords"] = {
    positive: [],
    neutral: [],
    negative: [],
  };
  for (const [key, item] of grouped) {
    const keyword = [...item.displayNames.entries()].sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount ||
        leftName.localeCompare(rightName, "zh-CN", { sensitivity: "base" }),
    )[0]?.[0];
    if (!keyword) continue;
    keywords[item.nature].push({
      key,
      keyword,
      normalizedKeyword: item.normalizedKeyword,
      nature: item.nature,
      answerCount: item.answerIds.size,
      occurrences: item.occurrences,
      conflicted: (naturesByKeyword.get(item.normalizedKeyword)?.size || 0) > 1,
      contexts: item.contexts,
    });
  }
  for (const nature of ["positive", "neutral", "negative"] as const) {
    keywords[nature].sort(
      (left, right) =>
        right.answerCount - left.answerCount ||
        right.occurrences - left.occurrences ||
        left.keyword.localeCompare(right.keyword, "zh-CN", {
          sensitivity: "base",
        }),
    );
  }

  return {
    effectiveAnswers: effective.length,
    knownAnswers: effective.length - counts.unknown,
    counts,
    keywords,
  };
}

function isSentiment(value: RunAttempt["sentiment"]): value is Sentiment {
  return ["positive", "neutral", "negative", "unknown"].includes(value || "");
}

function isKeywordEvaluation(
  value: KeywordEvaluation,
): value is KeywordEvaluation & { nature: EvaluatedSentiment } {
  return (
    typeof value.keyword === "string" &&
    ["positive", "neutral", "negative"].includes(value.nature)
  );
}

export function sentimentLabel(value?: RunAttempt["sentiment"]) {
  return sentimentMeta[isSentiment(value) ? value : "unknown"].label;
}

function percentage(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

function SentimentMethodDialog() {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="insight-help-button"
          aria-label="查看情感倾向统计说明"
        >
          <CircleHelp size={15} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal
        container={document.getElementById("monitoring-module-portals")}
      >
        <Dialog.Overlay className="insight-dialog-overlay" />
        <Dialog.Content className="insight-dialog-content">
          <div className="insight-dialog-head">
            <div>
              <Dialog.Title>情感倾向统计说明</Dialog.Title>
              <Dialog.Description>
                仅解释当前运行中供应商返回的答案级证据。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭情感倾向统计说明">
                <X size={17} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <div className="insight-method-grid">
            <section>
              <strong>标准</strong>
              <p>
                只统计状态为“完成”且正文非空的回答。正面、中性、负面来自 API 的
                sentiment；未返回或不可识别时归入“未知”。
              </p>
            </section>
            <section>
              <strong>含义</strong>
              <p>
                情感表示该回答对监控品牌的表达倾向，不等同于用户口碑、市场评价或权威结论。
              </p>
            </section>
            <section>
              <strong>如何使用</strong>
              <p>
                三类已判定占比以“已判定回答”为分母；未知单列，并以全部有效回答为分母。关键词只来自
                keywordEvaluations，不从正文或检索词猜测。
              </p>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function KeywordContextDialog({ item }: { item: KeywordInsight }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="keyword-insight-row"
          aria-label={`查看关键词“${item.keyword}”的判断上下文`}
        >
          <span className="keyword-rank-bar" aria-hidden="true">
            <i
              style={{ width: `${Math.min(100, 28 + item.answerCount * 12)}%` }}
            />
          </span>
          <strong>{item.keyword}</strong>
          <small>
            {item.answerCount} 个回答 · {item.occurrences} 次
          </small>
          {item.conflicted && <em>分类有差异</em>}
          <ArrowUpRight size={13} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal
        container={document.getElementById("monitoring-module-portals")}
      >
        <Dialog.Overlay className="insight-dialog-overlay" />
        <Dialog.Content className="insight-dialog-content keyword-context-dialog">
          <div className="insight-dialog-head">
            <div>
              <Dialog.Title>{item.keyword}</Dialog.Title>
              <Dialog.Description>
                API 判断为{sentimentMeta[item.nature].label} · 涉及{" "}
                {item.answerCount}
                个有效回答
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label={`关闭“${item.keyword}”上下文`}>
                <X size={17} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          {item.conflicted && (
            <p className="keyword-conflict-note" role="note">
              同一归一化关键词在不同回答中出现了不同情感分类；这里保留 API
              的原始分类，不合并推断。
            </p>
          )}
          <div className="keyword-context-list">
            {item.contexts.map((context, index) => (
              <article key={`${context.attemptId}:${index}`}>
                <header>
                  <span>{context.platformName}</span>
                  <small>{context.question}</small>
                </header>
                {context.context ? (
                  <div className="keyword-context-markdown">
                    <ReactMarkdown
                      skipHtml
                      components={safeContextMarkdownComponents}
                    >
                      {context.context}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p>API 未返回该关键词的具体上下文。</p>
                )}
              </article>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const safeContextMarkdownComponents = {
  a: ({
    children,
    href,
    ...properties
  }: React.ComponentPropsWithoutRef<"a">) => {
    const safeUrl = safeContextExternalUrl(href);
    return safeUrl ? (
      <a
        {...properties}
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: ({ alt }: React.ComponentPropsWithoutRef<"img">) => (
    <span className="blocked-markdown-image" role="note">
      外部图片已拦截{alt ? `：${alt}` : ""}
    </span>
  ),
};

function safeContextExternalUrl(value?: string) {
  if (!value) return;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url.toString()
      : undefined;
  } catch {
    return;
  }
}

function KeywordColumn({
  nature,
  items,
}: {
  nature: EvaluatedSentiment;
  items: KeywordInsight[];
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const hasMore = items.length > KEYWORD_PREVIEW_LIMIT;
  const visible = expanded ? items : items.slice(0, KEYWORD_PREVIEW_LIMIT);
  const sentimentLabel = sentimentMeta[nature].label;

  return (
    <article
      className={`keyword-cloud-card ${nature} ${expanded ? "expanded" : ""}`}
    >
      <header>
        <div>
          <span className="sentiment-dot" aria-hidden="true" />
          <strong>{sentimentLabel}关键词</strong>
        </div>
        <small>{items.length} 个</small>
      </header>
      {visible.length ? (
        <div className="keyword-insight-list" id={listId}>
          {visible.map((item) => (
            <KeywordContextDialog key={item.key} item={item} />
          ))}
        </div>
      ) : (
        <div className="insight-empty-mini">
          API 暂未返回{sentimentLabel}关键词评价
        </div>
      )}
      {hasMore && (
        <footer>
          <span>
            {expanded
              ? `按涉及回答数排序，已展示全部 ${items.length} 个`
              : `按涉及回答数排序，默认展示前 ${KEYWORD_PREVIEW_LIMIT} 个`}
          </span>
          <button
            type="button"
            aria-controls={listId}
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开全部"}${sentimentLabel}关键词（共 ${items.length} 个）`}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "收起" : "展开全部"}
          </button>
        </footer>
      )}
    </article>
  );
}

export function AnswerSentimentInsights({
  attempts,
}: {
  attempts: RunAttempt[];
}) {
  const insight = useMemo(() => buildSentimentInsights(attempts), [attempts]);
  const total = insight.effectiveAnswers;
  const positiveEnd = percentage(insight.counts.positive, insight.knownAnswers);
  const neutralEnd =
    positiveEnd + percentage(insight.counts.neutral, insight.knownAnswers);
  const donut = insight.knownAnswers
    ? `conic-gradient(${sentimentMeta.positive.color} 0 ${positiveEnd}%, ${sentimentMeta.neutral.color} ${positiveEnd}% ${neutralEnd}%, ${sentimentMeta.negative.color} ${neutralEnd}% 100%)`
    : "#eef0f4";

  return (
    <div className="answer-insights">
      <div className="sentiment-overview-grid">
        <article className="sentiment-summary-card">
          <header>
            <div>
              <strong>回答情感分布</strong>
              <SentimentMethodDialog />
            </div>
            <small>四桶统计</small>
          </header>
          <div className="sentiment-donut-wrap">
            <div
              className="sentiment-donut"
              style={{ background: donut }}
              role="img"
              aria-label={`已判定回答 ${insight.knownAnswers} 个，正面 ${insight.counts.positive} 个，中性 ${insight.counts.neutral} 个，负面 ${insight.counts.negative} 个`}
            >
              <div>
                <strong>{insight.knownAnswers}</strong>
                <span>已判定回答</span>
              </div>
            </div>
            <div className="sentiment-legend">
              {(
                ["positive", "neutral", "negative"] as EvaluatedSentiment[]
              ).map((nature) => (
                <div key={nature}>
                  <span
                    style={{ background: sentimentMeta[nature].color }}
                    aria-hidden="true"
                  />
                  <strong>{sentimentMeta[nature].label}</strong>
                  <b>{insight.counts[nature]}</b>
                  <small>
                    {percentage(insight.counts[nature], insight.knownAnswers)}%
                  </small>
                </div>
              ))}
            </div>
          </div>
          <div className="unknown-sentiment-note">
            <span
              style={{ background: sentimentMeta.unknown.color }}
              aria-hidden="true"
            />
            <strong>未判定 {insight.counts.unknown}</strong>
            <small>
              / 有效回答 {total} · 占比{" "}
              {percentage(insight.counts.unknown, total)}%
            </small>
          </div>
          <footer>
            已判定 {insight.knownAnswers} / {total} 个有效回答；正/中/负占比以
            {insight.knownAnswers} 个已判定回答为分母，未知占比以 {total}
            个有效回答为分母。
          </footer>
        </article>
        <article className="sentiment-method-card">
          <span>口径说明</span>
          <strong>供应商答案级证据</strong>
          <p>
            情感与关键词均来自 API
            明确字段。未返回数据会如实显示为空或未知，不使用正文、检索词进行补猜。
          </p>
          <dl>
            <div>
              <dt>有效回答</dt>
              <dd>{total}</dd>
            </div>
            <div>
              <dt>已判定</dt>
              <dd>{insight.knownAnswers}</dd>
            </div>
            <div>
              <dt>关键词证据</dt>
              <dd>
                {Object.values(insight.keywords).reduce(
                  (sum, items) => sum + items.length,
                  0,
                )}
              </dd>
            </div>
          </dl>
        </article>
      </div>
      <div className="keyword-cloud-grid">
        {(["positive", "neutral", "negative"] as const).map((nature) => (
          <KeywordColumn
            key={nature}
            nature={nature}
            items={insight.keywords[nature]}
          />
        ))}
      </div>
    </div>
  );
}

export type SourceScope = "citations" | "all";
export const INDUSTRY_SOURCE_PAGE_SIZE = 25;

export type SourceInsight = {
  key: string;
  mediaName: string;
  domain: string;
  category: string;
  occurrences: number;
  uniqueContents: number;
  answerCount: number;
  latestPublishedAt?: string;
  sampleTitle?: string;
  answers: Array<{
    attemptId: string;
    question: string;
    platformName: string;
    clientType: RunAttempt["clientType"];
  }>;
};

export type SourceInsights = {
  rows: SourceInsight[];
  occurrences: number;
  uniqueContents: number;
  answerCount: number;
};

type MutableSourceInsight = {
  key: string;
  mediaName: string;
  domain: string;
  category: string;
  occurrences: number;
  contents: Set<string>;
  answers: Map<
    string,
    {
      attemptId: string;
      question: string;
      platformName: string;
      clientType: RunAttempt["clientType"];
    }
  >;
  latestPublishedAt?: string;
  sampleTitle?: string;
};

export function buildSourceInsights(
  attempts: RunAttempt[],
  scope: SourceScope = "citations",
): SourceInsights {
  const effective = effectiveAnswerAttempts(attempts);
  const grouped = new Map<string, MutableSourceInsight>();
  const allContents = new Set<string>();
  const answersWithSources = new Set<string>();

  for (const attempt of effective) {
    const sourceList =
      scope === "all"
        ? attempt.allSources
        : citationProvenanceForDisplay(attempt) === "explicit"
          ? attempt.sources
          : [];
    const seenInAnswer = new Set<string>();
    for (const source of sourceList) {
      const contentKey = canonicalSourceContent(source);
      if (seenInAnswer.has(contentKey)) continue;
      seenInAnswer.add(contentKey);
      allContents.add(contentKey);
      answersWithSources.add(attempt.id);

      const mediaName = sourceMediaName(source);
      const domain = sourceDomain(source);
      const normalizedDomain = normalizeInsightKeyword(domain);
      const key = normalizedDomain
        ? `domain:${normalizedDomain}`
        : `site:${normalizeInsightKeyword(mediaName || "未分类来源")}`;
      const current: MutableSourceInsight = grouped.get(key) || {
        key,
        mediaName: mediaName || domain || "未分类来源",
        domain: domain || "未知域名",
        category: classifySource(source),
        occurrences: 0,
        contents: new Set<string>(),
        answers: new Map(),
      };
      current.occurrences += 1;
      current.contents.add(contentKey);
      current.answers.set(attempt.id, {
        attemptId: attempt.id,
        question: attempt.question,
        platformName: attempt.platformName,
        clientType: attempt.clientType,
      });
      current.sampleTitle ||= source.title || source.summary || undefined;
      const publishedAt = normalizedPublishedAt(source.publishedAt);
      if (
        publishedAt &&
        (!current.latestPublishedAt || publishedAt > current.latestPublishedAt)
      )
        current.latestPublishedAt = publishedAt;
      grouped.set(key, current);
    }
  }

  const rows = [...grouped.values()]
    .map((item): SourceInsight => ({
      key: item.key,
      mediaName: item.mediaName,
      domain: item.domain,
      category: item.category,
      occurrences: item.occurrences,
      uniqueContents: item.contents.size,
      answerCount: item.answers.size,
      latestPublishedAt: item.latestPublishedAt,
      sampleTitle: item.sampleTitle,
      answers: [...item.answers.values()],
    }))
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        right.uniqueContents - left.uniqueContents ||
        left.mediaName.localeCompare(right.mediaName, "zh-CN", {
          sensitivity: "base",
        }),
    );

  return {
    rows,
    occurrences: rows.reduce((sum, row) => sum + row.occurrences, 0),
    uniqueContents: allContents.size,
    answerCount: answersWithSources.size,
  };
}

function sourceMediaName(source: ResultSource) {
  return source.siteName?.normalize("NFKC").trim() || sourceDomain(source);
}

function sourceDomain(source: ResultSource) {
  let domain = source.domain?.trim();
  if (!domain && source.url) {
    try {
      domain = new URL(source.url).hostname;
    } catch {
      return "";
    }
  }
  return (domain || "").toLocaleLowerCase().replace(/^www\./u, "");
}

function canonicalSourceContent(source: ResultSource) {
  if (source.url) {
    try {
      const url = new URL(source.url);
      url.hash = "";
      return url.toString();
    } catch {
      // Fall through to a stable title/domain key for malformed historical URLs.
    }
  }
  return `${sourceDomain(source)}:${normalizeInsightKeyword(source.title || source.summary || source.id)}`;
}

function normalizedPublishedAt(value?: string | null) {
  const match = value?.trim().match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0];
}

export function classifySource(source: ResultSource) {
  const domain = sourceDomain(source);
  const haystack = [domain, source.siteName, source.title, source.url]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();

  if (/\.gov\.cn\b|government|政府|政务|国务院/u.test(haystack))
    return "政府机构";
  if (
    /\.edu\.cn\b|arxiv|doi\.org|cnki|万方|维普|期刊|学报|论文|researchgate/u.test(
      haystack,
    )
  )
    return "学术研究";
  if (/wikipedia|baike|百科/u.test(haystack)) return "百科知识";
  if (
    /(?:^|\.)(?:bilibili\.com|youtube\.com|youtu\.be|youku\.com|douyin\.com|iesdouyin\.com|ixigua\.com|v\.qq\.com)$/u.test(
      domain,
    ) ||
    /视频/u.test(haystack)
  )
    return "视频媒体";
  if (
    /(?:^|\.)(?:weibo\.com|zhihu\.com|xiaohongshu\.com|douban\.com|reddit\.com)$/u.test(
      domain,
    ) ||
    /微博|知乎|小红书/u.test(haystack)
  )
    return "社交社区";
  if (
    /(?:^|\.)(?:juejin\.cn|csdn\.net|cnblogs\.com|segmentfault\.com|stackoverflow\.com|github\.com|gitlab\.com)$/u.test(
      domain,
    ) ||
    /\b(?:developer|technical|technology)\s+(?:community|forum)\b|(?:开发者|技术|开源)\s*社区|\bgeo\s*社区|社区\s*(?:开发者|技术|开源)|社区\s*geo\b/u.test(
      haystack,
    )
  )
    return "技术社区";
  if (
    /(?:^|\.)(?:36kr\.com|jiemian\.com|ithome\.com|cyzone\.cn|toutiao\.com|zgswcn\.com|xinhuanet\.com|people\.com\.cn|chinanews\.com|sina\.com|sina\.com\.cn|sohu\.com|163\.com|yicai\.com|caixin\.com|thepaper\.cn|medsci\.cn|secrss\.com)$/u.test(
      domain,
    )
  )
    return "新闻资讯";
  if (/\.pdf(?:\?|$)|docs?\.|文档|白皮书|报告/u.test(haystack))
    return "文档资源";
  if (
    /news|36kr|xinhua|people\.com|chinanews|sina|sohu|163\.com|yicai|caixin|财经|新闻|日报|时报/u.test(
      haystack,
    )
  )
    return "新闻资讯";
  return "其他站点";
}

export function IndustrySourceInsights({
  attempts,
  onOpenAttempt,
}: {
  attempts: RunAttempt[];
  onOpenAttempt: (attemptId: string) => void;
}) {
  const effective = effectiveAnswerAttempts(attempts);
  const hasDiscoveredSources = effective.some((attempt) => {
    const provenance = citationProvenanceForDisplay(attempt);
    return (
      attempt.allSources.length > attempt.sources.length ||
      attempt.allSources.some((source) => !source.isCited) ||
      (provenance !== "explicit" && attempt.allSources.length > 0)
    );
  });
  const citationEvidence = effective.reduce(
    (counts, attempt) => {
      const provenance = citationProvenanceForDisplay(attempt);
      counts[provenance] += 1;
      return counts;
    },
    { explicit: 0, legacy_assumed: 0, unavailable: 0 },
  );
  const citationEvidenceWarnings = [
    citationEvidence.legacy_assumed
      ? `${citationEvidence.legacy_assumed} 个有效回答来自旧版兼容数据，无法证明供应商返回过 citationList；兼容来源仅在“全部返回来源”展示，不计入实际引用。`
      : "",
    citationEvidence.unavailable
      ? `${citationEvidence.unavailable} 个有效回答未返回可用的 citationList；referenceList 仅作为发现来源展示，不计入实际引用。`
      : "",
  ].filter(Boolean);
  const [scope, setScope] = useState<SourceScope>("citations");
  const [page, setPage] = useState(1);
  const [activeSource, setActiveSource] = useState<SourceInsight | null>(null);
  const scopeDescriptionId = useId();
  const sourceDialogTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreSourceTrigger = useRef(true);
  const insight = useMemo(
    () => buildSourceInsights(attempts, scope),
    [attempts, scope],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(insight.rows.length / INDUSTRY_SOURCE_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  const visibleRows = useMemo(
    () =>
      insight.rows.slice(
        (currentPage - 1) * INDUSTRY_SOURCE_PAGE_SIZE,
        currentPage * INDUSTRY_SOURCE_PAGE_SIZE,
      ),
    [currentPage, insight.rows],
  );

  useEffect(() => {
    setPage((current) => Math.min(Math.max(current, 1), pageCount));
  }, [pageCount]);

  const changeScope = (nextScope: SourceScope) => {
    setScope(nextScope);
    setPage(1);
    setActiveSource(null);
  };

  return (
    <div className="industry-source-insights">
      <div className="source-scope-toolbar">
        <div
          role="group"
          aria-label="引用来源统计范围"
          aria-describedby={scopeDescriptionId}
        >
          <button
            type="button"
            className={scope === "citations" ? "active" : ""}
            aria-pressed={scope === "citations"}
            onClick={() => changeScope("citations")}
          >
            实际引用
          </button>
          <button
            type="button"
            className={scope === "all" ? "active" : ""}
            aria-pressed={scope === "all"}
            disabled={!hasDiscoveredSources}
            onClick={() => changeScope("all")}
          >
            全部返回来源
          </button>
        </div>
        <p id={scopeDescriptionId} aria-live="polite">
          {scope === "citations"
            ? "默认只聚合供应商 citationList 中的真实引用。"
            : "当前包含 referenceList 中未被答案实际引用的发现来源。"}
        </p>
      </div>
      {citationEvidenceWarnings.length > 0 && (
        <p className="source-provenance-note" role="note">
          {citationEvidenceWarnings.join(" ")}
        </p>
      )}
      <div className="source-summary-grid">
        <article>
          <Quote size={16} aria-hidden="true" />
          <span>{scope === "citations" ? "引用次数" : "来源出现次数"}</span>
          <strong>{insight.occurrences}</strong>
        </article>
        <article>
          <FileSearch size={16} aria-hidden="true" />
          <span>独立内容</span>
          <strong>{insight.uniqueContents}</strong>
        </article>
        <article>
          <span className="source-summary-glyph" aria-hidden="true">
            答
          </span>
          <span>涉及回答</span>
          <strong>{insight.answerCount}</strong>
        </article>
        <article>
          <span className="source-summary-glyph" aria-hidden="true">
            媒
          </span>
          <span>媒体来源</span>
          <strong>{insight.rows.length}</strong>
        </article>
      </div>
      {insight.rows.length ? (
        <>
          <div
            className="source-table-wrap"
            role="region"
            aria-label="引用来源排行表格，可横向滚动"
            tabIndex={0}
          >
            <table className="industry-source-table">
              <caption>
                媒体排行；来源类型由 FrontMind
                本地确定性规则分类，不是供应商或权威行业标签。
              </caption>
              <thead>
                <tr>
                  <th scope="col">媒体来源</th>
                  <th scope="col">来源类型（本地规则分类）</th>
                  <th scope="col">
                    {scope === "citations" ? "引用次数" : "出现次数"}
                  </th>
                  <th scope="col">独立内容</th>
                  <th scope="col">涉及回答</th>
                  <th scope="col">占比</th>
                  <th scope="col">最近发布日期</th>
                  <th scope="col" aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => (
                  <tr key={row.key}>
                    <th scope="row">
                      <span
                        className={`source-rank ${(currentPage - 1) * INDUSTRY_SOURCE_PAGE_SIZE + index < 3 ? "top" : ""}`}
                      >
                        {(currentPage - 1) * INDUSTRY_SOURCE_PAGE_SIZE +
                          index +
                          1}
                      </span>
                      <span className="source-letter" aria-hidden="true">
                        {row.mediaName.slice(0, 1).toLocaleUpperCase()}
                      </span>
                      <span>
                        <strong>{row.mediaName}</strong>
                        <small>{row.domain}</small>
                      </span>
                    </th>
                    <td>
                      <span
                        className={`source-category category-${categorySlug(row.category)}`}
                      >
                        {row.category}
                      </span>
                    </td>
                    <td>{row.occurrences}</td>
                    <td>{row.uniqueContents}</td>
                    <td>{row.answerCount}</td>
                    <td>{percentage(row.occurrences, insight.occurrences)}%</td>
                    <td>{row.latestPublishedAt || "未知"}</td>
                    <td>
                      <button
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={activeSource?.key === row.key}
                        aria-label={`查看“${row.mediaName}”涉及的 ${row.answerCount} 条回答`}
                        onClick={(event) => {
                          sourceDialogTrigger.current = event.currentTarget;
                          restoreSourceTrigger.current = true;
                          setActiveSource(row);
                        }}
                      >
                        查看 {row.answerCount} 条回答
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="source-pagination" aria-label="引用来源分页">
            <p aria-live="polite">
              第 {currentPage} / {pageCount} 页 · 共 {insight.rows.length}
              个媒体来源 · 每页最多 {INDUSTRY_SOURCE_PAGE_SIZE} 个
            </p>
            <div>
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                disabled={currentPage >= pageCount}
                onClick={() =>
                  setPage((current) => Math.min(pageCount, current + 1))
                }
              >
                下一页
              </button>
            </div>
          </nav>
        </>
      ) : (
        <div className="analysis-placeholder source-insight-empty">
          <FileSearch size={27} aria-hidden="true" />
          <strong>
            {scope === "citations"
              ? "平台未返回实际引用"
              : "平台未返回可追溯来源"}
          </strong>
          <span>
            {scope === "citations"
              ? "这里只统计供应商明确放入 citationList 的来源，不会把搜索结果混入。"
              : "当前有效回答没有可聚合的 referenceList 来源。"}
          </span>
        </div>
      )}
      <p className="source-classification-note">
        “来源类型”仅用于本页分组展示，由域名、站点名、标题和 URL
        的本地规则确定；无法可靠识别时统一归为“其他站点”。
      </p>
      <SourceAnswersDialog
        row={activeSource}
        onOpenChange={(open) => {
          if (!open) setActiveSource(null);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreSourceTrigger.current)
            sourceDialogTrigger.current?.focus({ preventScroll: true });
          restoreSourceTrigger.current = true;
        }}
        onOpenAttempt={(attemptId) => {
          restoreSourceTrigger.current = false;
          onOpenAttempt(attemptId);
        }}
      />
    </div>
  );
}

function citationProvenanceForDisplay(attempt: RunAttempt) {
  if (attempt.citationProvenance) return attempt.citationProvenance;
  if (
    attempt.sources.length > 0 &&
    attempt.sources.every((source) => source.citationProvenance === "explicit")
  )
    return "explicit";
  if (
    attempt.sources.some(
      (source) => source.citationProvenance === "legacy_assumed",
    )
  )
    return "legacy_assumed";
  return "unavailable";
}

function SourceAnswersDialog({
  row,
  onOpenChange,
  onCloseAutoFocus,
  onOpenAttempt,
}: {
  row: SourceInsight | null;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  onOpenAttempt: (attemptId: string) => void;
}) {
  return (
    <Dialog.Root open={Boolean(row)} onOpenChange={onOpenChange}>
      {row && (
        <Dialog.Portal
          container={document.getElementById("monitoring-module-portals")}
        >
          <Dialog.Overlay className="insight-dialog-overlay" />
          <Dialog.Content
            className="insight-dialog-content source-answers-dialog"
            onCloseAutoFocus={onCloseAutoFocus}
          >
            <div className="insight-dialog-head">
              <div>
                <Dialog.Title>{row.mediaName} 的关联回答</Dialog.Title>
                <Dialog.Description>
                  共涉及 {row.answerCount} 个有效回答；选择后返回对应回答证据。
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={`关闭“${row.mediaName}”关联回答`}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <div className="source-answer-list">
              {row.answers.map((answer, index) => (
                <Dialog.Close asChild key={answer.attemptId}>
                  <button
                    type="button"
                    aria-label={`查看${answer.platformName}${answer.clientType === "web" ? "网页版" : "手机版"}关于“${answer.question}”的回答`}
                    onClick={() => onOpenAttempt(answer.attemptId)}
                  >
                    <span>{index + 1}</span>
                    <strong>{answer.question}</strong>
                    <small>
                      {answer.platformName}（
                      {answer.clientType === "web" ? "网页版" : "手机版"}）
                    </small>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                </Dialog.Close>
              ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}

function categorySlug(category: string) {
  const labels: Record<string, string> = {
    新闻资讯: "news",
    政府机构: "government",
    学术研究: "academic",
    百科知识: "encyclopedia",
    视频媒体: "video",
    社交社区: "social",
    技术社区: "technology",
    文档资源: "document",
    其他站点: "other",
  };
  return labels[category] || "other";
}
