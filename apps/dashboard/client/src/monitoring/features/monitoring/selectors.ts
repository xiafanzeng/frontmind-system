import type { CompetitorInput, MonitorRun, RunAttempt } from "../../domain";
import type {
  AttemptMetricRow,
  DateRange,
  SourceAggregate,
  SourceScope,
} from "./types";
import { attemptModelKey } from "./types";
import { calendarDateRangeToUtc } from "./queryState";

export function filterRunsByRange(
  runs: MonitorRun[],
  range: DateRange,
  from: string,
  to: string,
  timezone: string,
) {
  void range;
  const bounds = calendarDateRangeToUtc(from, to, timezone);
  const fromTimestamp = Date.parse(bounds.from);
  const toTimestamp = Date.parse(bounds.to);
  return runs.filter((run) => {
    const timestamp = Date.parse(run.createdAt);
    return (
      Number.isFinite(timestamp) &&
      timestamp >= fromTimestamp &&
      timestamp < toTimestamp
    );
  });
}

export function filterAttempts(
  run: MonitorRun | undefined,
  question?: string,
  model?: string,
) {
  return (
    run?.attempts.filter(
      (attempt) =>
        (!question || attempt.questionId === question) &&
        (!model || attemptModelKey(attempt) === model),
    ) || []
  );
}

export function aggregateSources(attempts: RunAttempt[], scope: SourceScope) {
  const result = new Map<string, SourceAggregate>();
  for (const attempt of attempts) {
    const sources = visibleSourcesForAttempt(attempt, scope);
    for (const source of sources) {
      const key =
        source.url ||
        source.domain ||
        source.title ||
        `${attempt.id}:${source.id}`;
      const current = result.get(key) || {
        key,
        title: source.title,
        domain: source.domain || source.siteName || source.title,
        url: safeExternalUrl(source.url),
        count: 0,
        answerIds: new Set<string>(),
      };
      current.count += 1;
      current.answerIds.add(attempt.id);
      result.set(key, current);
    }
  }
  return [...result.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.domain.localeCompare(right.domain, "zh-CN"),
  );
}

export function visibleSourcesForAttempt(
  attempt: RunAttempt,
  scope: SourceScope,
) {
  const trustedCitationKeys = new Set(
    attempt.citationProvenance === "explicit"
      ? attempt.sources
          .filter(
            (source) =>
              source.isCited &&
              (!source.citationProvenance ||
                source.citationProvenance === "explicit"),
          )
          .map((source) => source.url || source.id)
      : [],
  );
  if (scope === "cited") {
    return attempt.sources.filter((source) =>
      trustedCitationKeys.has(source.url || source.id),
    );
  }
  if (scope === "discovered") {
    if (attempt.citationProvenance !== "explicit") return [];
    return attempt.allSources.filter(
      (source) => !trustedCitationKeys.has(source.url || source.id),
    );
  }
  return attempt.allSources;
}

export function buildMetricRows(attempts: RunAttempt[]): AttemptMetricRow[] {
  const groups = new Map<string, RunAttempt[]>();
  for (const attempt of attempts) {
    const key = attempt.questionId;
    groups.set(key, [...(groups.get(key) || []), attempt]);
  }
  return [...groups.entries()].map(([key, items]) => {
    const effective = items.filter(
      (attempt) => attempt.status === "completed" && attempt.answer?.trim(),
    );
    const mentioned = effective.filter(
      (attempt) => attempt.brandMentioned === true,
    );
    const positions = mentioned
      .map((attempt) => attempt.mentionPosition)
      .filter((value): value is number => typeof value === "number");
    const rateAt = (maximum: number) =>
      effective.length
        ? (effective.filter(
            (attempt) =>
              attempt.brandMentioned === true &&
              typeof attempt.mentionPosition === "number" &&
              attempt.mentionPosition <= maximum,
          ).length /
            effective.length) *
          100
        : undefined;
    const sentiment = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
    for (const attempt of effective) {
      sentiment[attempt.sentiment || "unknown"] += 1;
    }
    return {
      key,
      question: items[0]?.question || "—",
      total: items.length,
      completed: items.filter((attempt) => attempt.status === "completed")
        .length,
      effective: effective.length,
      mentionRate: effective.length
        ? (mentioned.length / effective.length) * 100
        : undefined,
      top1Rate: rateAt(1),
      top3Rate: rateAt(3),
      top10Rate: rateAt(10),
      averagePosition: positions.length
        ? positions.reduce((sum, value) => sum + value, 0) / positions.length
        : undefined,
      citations: items.reduce(
        (sum, attempt) => sum + attempt.sources.length,
        0,
      ),
      sentiment,
    };
  });
}

export function calculateEvidenceMetrics(attempts: RunAttempt[]) {
  return calculateSubjectMetrics(attempts, "self");
}

type NormalizedRanking = {
  name: string;
  mentioned: boolean;
  position?: number;
};

export type MonitoringProjectionSubject =
  "self" | { name: string; aliases?: readonly string[] };

function normalizedSubjectName(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function rankingRecord(
  value: Record<string, unknown>,
): NormalizedRanking | undefined {
  const subject =
    value.subject && typeof value.subject === "object"
      ? (value.subject as Record<string, unknown>)
      : undefined;
  const rawName = value.name ?? value.brandName ?? subject?.name;
  if (typeof rawName !== "string" || !rawName.trim()) return;
  const rawPosition = value.position ?? value.rank ?? value.ranking;
  const position =
    typeof rawPosition === "number" &&
    Number.isFinite(rawPosition) &&
    rawPosition > 0
      ? rawPosition
      : typeof rawPosition === "string" &&
          Number.isFinite(Number(rawPosition)) &&
          Number(rawPosition) > 0
        ? Number(rawPosition)
        : undefined;
  return {
    name: rawName.trim(),
    mentioned:
      typeof value.mentioned === "boolean"
        ? value.mentioned
        : Boolean(position),
    position,
  };
}

function rankingForSubject(attempt: RunAttempt, names: Set<string>) {
  const matches = (attempt.competitorRankings || [])
    .map(rankingRecord)
    .filter((ranking): ranking is NormalizedRanking =>
      Boolean(ranking && names.has(normalizedSubjectName(ranking.name))),
    );
  if (!matches.length) return;
  const mentioned = matches.some((ranking) => ranking.mentioned);
  const positions = matches.flatMap((ranking) =>
    ranking.mentioned && typeof ranking.position === "number"
      ? [ranking.position]
      : [],
  );
  return {
    name: matches[0]!.name,
    mentioned,
    position: positions.length ? Math.min(...positions) : undefined,
  };
}

function competitorNames(
  subject: Exclude<MonitoringProjectionSubject, "self">,
) {
  return new Set(
    [subject.name, ...(subject.aliases || [])].map(normalizedSubjectName),
  );
}

function matchingRunCompetitor(
  subject: Exclude<MonitoringProjectionSubject, "self">,
  competitors: readonly CompetitorInput[],
) {
  const selectedNames = competitorNames(subject);
  return competitors.find((competitor) =>
    [competitor.name, ...competitor.aliases]
      .map(normalizedSubjectName)
      .some((name) => selectedNames.has(name)),
  );
}

function subjectFact(
  attempt: RunAttempt,
  subject: MonitoringProjectionSubject,
  names?: Set<string>,
) {
  if (subject === "self") {
    return {
      mentioned: attempt.brandMentioned === true,
      position: attempt.mentionPosition ?? undefined,
    };
  }
  return (
    rankingForSubject(attempt, names || competitorNames(subject)) || {
      mentioned: false,
    }
  );
}

export function projectAttemptsForSubject(
  attempts: RunAttempt[],
  subject: MonitoringProjectionSubject,
) {
  if (subject === "self") return attempts;
  const names = competitorNames(subject);
  return attempts.map((attempt) => {
    const fact = subjectFact(attempt, subject, names);
    return {
      ...attempt,
      brandMentioned: fact.mentioned,
      mentionPosition: fact.mentioned ? fact.position : undefined,
    };
  });
}

export function projectAttemptsForRunSubject(
  attempts: RunAttempt[],
  subject: MonitoringProjectionSubject,
  runCompetitors: readonly CompetitorInput[],
) {
  if (subject === "self") return attempts;
  const historicalSubject = matchingRunCompetitor(subject, runCompetitors);
  if (historicalSubject) {
    return projectAttemptsForSubject(attempts, historicalSubject);
  }
  return attempts.map((attempt) => ({
    ...attempt,
    brandMentioned: false,
    mentionPosition: undefined,
  }));
}

export function calculateSubjectMetrics(
  attempts: RunAttempt[],
  subject: MonitoringProjectionSubject,
) {
  const rows = buildMetricRows(attempts);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const completed = rows.reduce((sum, row) => sum + row.completed, 0);
  const effectiveAttempts = attempts.filter(
    (attempt) => attempt.status === "completed" && attempt.answer?.trim(),
  );
  const competitorNames =
    subject === "self"
      ? undefined
      : new Set(
          [subject.name, ...(subject.aliases || [])].map(normalizedSubjectName),
        );
  const facts = effectiveAttempts.map((attempt) =>
    subjectFact(attempt, subject, competitorNames),
  );
  const mentioned = facts.filter((fact) => fact.mentioned);
  const positions = mentioned
    .map((fact) => fact.position)
    .filter((value): value is number => typeof value === "number");
  const rateAt = (maximum: number) =>
    effectiveAttempts.length
      ? (facts.filter(
          (fact) =>
            fact.mentioned &&
            typeof fact.position === "number" &&
            fact.position <= maximum,
        ).length /
          effectiveAttempts.length) *
        100
      : undefined;
  return {
    total,
    completed,
    effective: effectiveAttempts.length,
    mentionRate: effectiveAttempts.length
      ? (mentioned.length / effectiveAttempts.length) * 100
      : undefined,
    top1Rate: rateAt(1),
    top3Rate: rateAt(3),
    top10Rate: rateAt(10),
    averagePosition: positions.length
      ? positions.reduce((sum, value) => sum + value, 0) / positions.length
      : undefined,
    citations: effectiveAttempts.reduce(
      (sum, attempt) => sum + attempt.sources.length,
      0,
    ),
  };
}

export type CompetitorMetricRow = {
  name: string;
  attempts: number;
  mentions: number;
  mentionRate?: number;
  averagePosition?: number;
  top1Rate?: number;
  top3Rate?: number;
  top10Rate?: number;
};

export function buildCompetitorRows(
  attempts: RunAttempt[],
  competitors: CompetitorInput[],
): CompetitorMetricRow[] {
  return competitors.map((competitor) => {
    const metrics = calculateSubjectMetrics(attempts, competitor);
    const effective = attempts.filter(
      (attempt) => attempt.status === "completed" && attempt.answer?.trim(),
    );
    const names = new Set(
      [competitor.name, ...competitor.aliases].map(normalizedSubjectName),
    );
    const mentions = effective.filter(
      (attempt) => rankingForSubject(attempt, names)?.mentioned,
    ).length;
    return {
      name: competitor.name,
      attempts: metrics.effective,
      mentions,
      mentionRate: metrics.mentionRate,
      averagePosition: metrics.averagePosition,
      top1Rate: metrics.top1Rate,
      top3Rate: metrics.top3Rate,
      top10Rate: metrics.top10Rate,
    };
  });
}

export function safeExternalUrl(value?: string) {
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

const archivedMediaPathPattern =
  /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\?variant=(?:display|thumbnail))?$/iu;

export function safeArchivedMediaUrl(value?: string) {
  return value && archivedMediaPathPattern.test(value) ? value : undefined;
}

export function archivedMediaAttachmentUrl(value?: string) {
  const safeUrl = safeArchivedMediaUrl(value);
  if (!safeUrl) return;
  const parsed = new URL(safeUrl, "https://frontmind.invalid");
  parsed.searchParams.set("disposition", "attachment");
  return `${parsed.pathname}${parsed.search}`;
}
