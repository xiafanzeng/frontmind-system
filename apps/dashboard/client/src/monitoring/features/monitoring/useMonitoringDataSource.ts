import type { AppRouter } from "@frontmind/monitoring-api";
import type { inferRouterOutputs } from "@trpc/server";

import type { ResultSource, RunAttempt } from "../../domain";
import { trpc } from "../../trpc";
import { calendarDateRangeToUtc } from "./queryState";
import type { MonitoringQueryState, MonitoringTab } from "./types";

type ApiOutputs = inferRouterOutputs<AppRouter>;
export type MonitoringSummaryData = ApiOutputs["monitoring"]["summary"];
export type MonitoringAnalysisData = ApiOutputs["monitoring"]["analysis"];
export type MonitoringAnswerListItem =
  ApiOutputs["monitoring"]["answers"]["list"]["items"][number];
export type MonitoringAnswerDetail = ApiOutputs["monitoring"]["answers"]["get"];

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function analysisKind(tab: MonitoringTab) {
  return (
    ["metrics", "trends", "competitors", "citations", "sources"] as const
  ).find((kind) => kind === tab);
}

function sourceFromApi(
  source: Pick<
    MonitoringAnswerDetail["referenceList"][number],
    | "id"
    | "title"
    | "url"
    | "domain"
    | "ordinal"
    | "providerPosition"
    | "siteName"
    | "summary"
    | "publishedAt"
  >,
  isCited: boolean,
  citationProvenance: MonitoringAnswerDetail["citationProvenance"],
): ResultSource {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    domain: source.domain,
    order: source.ordinal,
    providerPosition: source.providerPosition,
    isCited,
    citationProvenance,
    siteName: source.siteName,
    summary: source.summary,
    publishedAt: source.publishedAt,
  };
}

function sourceIdentityKeys(source: Pick<ResultSource, "id" | "url">) {
  const keys = [`id:${source.id}`];
  if (!source.url) return keys;
  try {
    const url = new URL(source.url);
    url.hash = "";
    keys.unshift(`url:${url.toString()}`);
  } catch {
    const url = source.url.trim();
    if (url) keys.unshift(`url:${url}`);
  }
  return keys;
}

function mergeAnswerSources(
  references: readonly ResultSource[],
  citations: readonly ResultSource[],
) {
  const merged: ResultSource[] = [];
  const indexByIdentity = new Map<string, number>();
  const accept = (source: ResultSource) => {
    const keys = sourceIdentityKeys(source);
    const existingIndex = keys
      .map((key) => indexByIdentity.get(key))
      .find((index): index is number => index !== undefined);
    if (existingIndex === undefined) {
      const index = merged.push(source) - 1;
      for (const key of keys) indexByIdentity.set(key, index);
      return;
    }
    const existing = merged[existingIndex]!;
    const next = {
      ...existing,
      title: existing.title || source.title,
      url: existing.url || source.url,
      domain: existing.domain || source.domain,
      providerPosition:
        existing.providerPosition ?? source.providerPosition ?? null,
      citedText: existing.citedText || source.citedText,
      isCited: existing.isCited || source.isCited,
      citationProvenance:
        existing.citationProvenance ?? source.citationProvenance,
      siteName: existing.siteName ?? source.siteName,
      summary: existing.summary ?? source.summary,
      publishedAt: existing.publishedAt ?? source.publishedAt,
    } satisfies ResultSource;
    merged[existingIndex] = next;
    for (const key of sourceIdentityKeys(next)) {
      indexByIdentity.set(key, existingIndex);
    }
    for (const key of keys) indexByIdentity.set(key, existingIndex);
  };
  references.forEach(accept);
  citations.forEach(accept);
  return merged;
}

export function attemptFromList(item: MonitoringAnswerListItem): RunAttempt {
  return {
    id: item.answerId,
    runId: item.runId,
    questionId: item.questionId,
    question: item.question,
    platformId: item.platform.id,
    platformCode: item.platform.providerCode,
    platformName: item.platform.displayName,
    clientType: item.platform.clientType,
    mode: item.platform.mode,
    screenshotPolicy: 0,
    repetition: item.repetition,
    status: item.status,
    answerPreview: item.result?.answerPreview,
    capturedAt: item.result?.updatedAt
      ? new Date(item.result.updatedAt).toISOString()
      : undefined,
    sentiment: item.result?.sentiment,
    brandMentioned: item.result?.mentioned,
    mentionPosition: item.result?.position,
    citationProvenance: item.result?.citationProvenance,
    sources: [],
    allSources: [],
    assets: [],
  };
}

export function attemptFromDetail(detail: MonitoringAnswerDetail): RunAttempt {
  const cited = detail.citationList.map((source) => ({
    ...sourceFromApi(source, true, detail.citationProvenance),
    citedText: source.citedText || undefined,
  }));
  const references = detail.referenceList.map((source) =>
    sourceFromApi(source, source.isCited, detail.citationProvenance),
  );
  return {
    id: detail.answerId,
    runId: detail.runId,
    questionId: detail.questionId,
    question: detail.question,
    platformId: detail.platform.id,
    platformCode: detail.platform.providerCode,
    platformName: detail.platform.displayName,
    clientType: detail.platform.clientType,
    mode: detail.platform.mode,
    screenshotPolicy: detail.archivedScreenshots.length ? 1 : 0,
    repetition: detail.repetition,
    status: detail.status,
    answer: detail.answerMarkdown,
    reasoning: detail.reasoningMarkdown || undefined,
    capturedAt: new Date(detail.runCreatedAt).toISOString(),
    sentiment: detail.sentiment,
    brandMentioned: detail.mentioned,
    mentionPosition: detail.position,
    citationProvenance: detail.citationProvenance,
    sources: cited,
    allSources: mergeAnswerSources(references, cited),
    assets: detail.archivedScreenshots.map((asset) => ({
      id: asset.id,
      type: "screenshot" as const,
      title: "回答截图",
      url: asset.accessPath || undefined,
      thumbnailUrl: asset.thumbnailAccessPath || undefined,
      archiveStatus: asset.archiveStatus,
    })),
    searchKeywords: detail.searchKeywords,
    competitorRankings: detail.rankings
      .filter((ranking) => ranking.subject.kind === "competitor")
      .map((ranking) => ({
        name: ranking.subject.name,
        mentioned: ranking.mentioned,
        position: ranking.position,
      })),
  };
}

export function attemptsFromAnswerPages(
  pages: readonly { items: readonly MonitoringAnswerListItem[] }[] | undefined,
) {
  return pages?.flatMap((page) => page.items.map(attemptFromList)) || [];
}

export function answerDetailLoadDecision(
  answerId: string | undefined,
  tab: MonitoringTab,
  answersReady: boolean,
  items: readonly MonitoringAnswerListItem[],
) {
  const validAnswerId = Boolean(answerId && uuidPattern.test(answerId));
  const listedItem = validAnswerId
    ? items.find((item) => item.answerId === answerId)
    : undefined;
  const listedWithoutResult = Boolean(listedItem && listedItem.result === null);
  return {
    validAnswerId,
    listedWithoutResult,
    shouldFetch:
      tab === "answers" &&
      answersReady &&
      validAnswerId &&
      !listedWithoutResult,
  };
}

export function monitoringAnswerMatchesScope(
  detail: MonitoringAnswerDetail,
  bounds: { from: string; to: string },
  scope: {
    questionId?: string;
    platformId?: string;
    subject: { kind: "self" } | { kind: "competitor"; name: string };
  },
) {
  const timestamp = new Date(detail.runCreatedAt).getTime();
  // A subject selects the metrics projection for the same answer set; it is
  // not an answer-list dimension. In particular, a historical answer can use
  // the former canonical competitor name while the active version reaches it
  // through an alias. That alias bridge is intentionally resolved server-side
  // and is not present in answer-detail rankings, so comparing ranking names
  // here would reject a valid cross-version deep link.
  return (
    timestamp >= new Date(bounds.from).getTime() &&
    timestamp < new Date(bounds.to).getTime() &&
    (!scope.questionId || detail.questionId === scope.questionId) &&
    (!scope.platformId || detail.platform.id === scope.platformId)
  );
}

export function useMonitoringDataSource({
  enabled,
  query,
  timezone,
}: {
  enabled: boolean;
  query: MonitoringQueryState;
  timezone: string;
}) {
  const validMonitor = Boolean(
    enabled && query.monitorId && uuidPattern.test(query.monitorId),
  );
  const bounds = calendarDateRangeToUtc(query.from, query.to, timezone);
  const catalogScope = {
    monitorId: validMonitor ? query.monitorId! : NIL_ID,
    from: new Date(bounds.from),
    to: new Date(bounds.to),
    subject: { kind: "self" } as const,
  };
  const catalog = trpc.monitoring.summary.useQuery(catalogScope, {
    enabled: validMonitor,
    staleTime: 30_000,
  });
  const validQuestion = Boolean(
    query.question &&
    catalog.data?.filters.questions.some((item) => item.id === query.question),
  );
  const validModel = Boolean(
    query.model &&
    catalog.data?.filters.platforms.some((item) => item.id === query.model),
  );
  const competitorName = query.subject.startsWith("competitor:")
    ? query.subject.slice("competitor:".length)
    : undefined;
  const validCompetitor = Boolean(
    competitorName &&
    catalog.data?.filters.subjects.some(
      (item) => item.kind === "competitor" && item.name === competitorName,
    ),
  );
  const scope = {
    ...catalogScope,
    subject: validCompetitor
      ? ({ kind: "competitor", name: competitorName! } as const)
      : ({ kind: "self" } as const),
    ...(validQuestion ? { questionId: query.question! } : {}),
    ...(validModel ? { platformId: query.model! } : {}),
  };
  const summary = trpc.monitoring.summary.useQuery(scope, {
    enabled: validMonitor && catalog.isSuccess,
    staleTime: 30_000,
  });
  const answers = trpc.monitoring.answers.list.useInfiniteQuery(
    { scope, limit: 50 },
    {
      enabled: validMonitor && catalog.isSuccess && query.tab === "answers",
      staleTime: 15_000,
      getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    },
  );
  const answerItems = answers.data?.pages.flatMap((page) => page.items) || [];
  const detailDecision = answerDetailLoadDecision(
    query.answerId,
    query.tab,
    answers.isSuccess,
    answerItems,
  );
  const answerDetail = trpc.monitoring.answers.get.useQuery(
    {
      monitorId: validMonitor ? query.monitorId! : NIL_ID,
      answerId: detailDecision.validAnswerId ? query.answerId! : NIL_ID,
      subject: scope.subject,
    },
    {
      enabled: validMonitor && catalog.isSuccess && detailDecision.shouldFetch,
      staleTime: 30_000,
    },
  );
  const kind = analysisKind(query.tab);
  const analysis = trpc.monitoring.analysis.useQuery(
    { scope, kind: kind || "metrics" },
    {
      enabled: validMonitor && catalog.isSuccess && Boolean(kind),
      staleTime: 30_000,
    },
  );
  const listAttempts = attemptsFromAnswerPages(answers.data?.pages);
  const detailMatchesScope = Boolean(
    answerDetail.data &&
    monitoringAnswerMatchesScope(answerDetail.data, bounds, scope),
  );
  const detailAttempt =
    answerDetail.data && detailMatchesScope
      ? attemptFromDetail(answerDetail.data)
      : undefined;
  const attempts = detailAttempt
    ? listAttempts.some((attempt) => attempt.id === detailAttempt.id)
      ? listAttempts.map((attempt) =>
          attempt.id === detailAttempt.id ? detailAttempt : attempt,
        )
      : [detailAttempt, ...listAttempts]
    : listAttempts;

  return {
    summary: summary.data,
    attempts,
    detailAttempt,
    analysis: analysis.data,
    summaryReady: catalog.isSuccess && summary.isSuccess,
    answersReady: query.tab !== "answers" || answers.isSuccess,
    answerDetailLoading:
      detailDecision.shouldFetch &&
      (answerDetail.isLoading || answerDetail.isFetching),
    answerDetailSettled:
      query.tab !== "answers" ||
      !query.answerId ||
      !detailDecision.validAnswerId ||
      detailDecision.listedWithoutResult ||
      answerDetail.isSuccess ||
      answerDetail.isError,
    hasMoreAnswers: Boolean(answers.hasNextPage),
    loadingMoreAnswers: answers.isFetchingNextPage,
    loadMoreAnswers: async () => {
      if (answers.hasNextPage && !answers.isFetchingNextPage) {
        await answers.fetchNextPage();
      }
    },
    loading:
      catalog.isLoading ||
      summary.isLoading ||
      answers.isLoading ||
      answerDetail.isLoading ||
      analysis.isLoading,
    error:
      catalog.error?.message ||
      summary.error?.message ||
      answers.error?.message ||
      (detailDecision.shouldFetch ? answerDetail.error?.message : undefined) ||
      analysis.error?.message,
    refresh: async () => {
      const requests: Array<Promise<unknown>> = [
        catalog.refetch(),
        summary.refetch(),
      ];
      if (query.tab === "answers") requests.push(answers.refetch());
      if (detailDecision.shouldFetch) {
        requests.push(answerDetail.refetch());
      }
      if (kind) requests.push(analysis.refetch());
      await Promise.all(requests);
    },
  };
}
