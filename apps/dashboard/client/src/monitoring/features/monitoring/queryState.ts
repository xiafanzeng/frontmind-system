import { projectResourceUrl, projectWorkspaceUrl } from "@/lib/enterprise-project";
import type { MonitorRun, MonitorSummary } from "../../domain";
import {
  MONITORING_TABS,
  attemptModelKey,
  type DateRange,
  type MonitoringQueryContext,
  type MonitoringQueryState,
  type SourceScope,
} from "./types";

const tabIds = new Set<string>(MONITORING_TABS.map((tab) => tab.id));
const ranges = new Set<string>(["7d", "30d", "90d", "custom"]);
const sourceScopes = new Set<string>(["all", "cited", "discovered"]);
const projectScopedParameters = [
  "monitor",
  "run",
  "question",
  "model",
  "answerQuestion",
  "answer",
  "sourceScope",
  "fullscreen",
  "subject",
] as const;

export function monitoringProjectIdFromSearch(
  search: string,
  projects: readonly { id: string }[],
  fallbackId?: string,
) {
  const requested = new URLSearchParams(search).get("project");
  if (requested !== null) {
    return (
      projects.find((project) => project.id === requested)?.id ??
      projects[0]?.id
    );
  }
  return (
    projects.find((project) => project.id === fallbackId)?.id ?? projects[0]?.id
  );
}

export function writeMonitoringProjectSelection(
  projectId: string,
  mode: "push" | "replace" = "push",
) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.set("project", projectId);
  for (const key of projectScopedParameters) params.delete(key);
  const search = params.toString();
  const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](
    window.history.state,
    "",
    url,
  );
}
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function monitoringLocalCalendarDate(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function shiftCalendarDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function monitoringDateWindow(
  range: Exclude<DateRange, "custom">,
  timezone: string,
  now = new Date(),
) {
  const today = monitoringLocalCalendarDate(now, timezone);
  const days = Number.parseInt(range, 10);
  return {
    from: shiftCalendarDate(today, -(days - 1)),
    to: shiftCalendarDate(today, 1),
  };
}

function validCalendarDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

function timezoneOffsetMilliseconds(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  const renderedAsUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return renderedAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function calendarMidnightUtc(value: string, timezone: string) {
  if (!validCalendarDate(value)) throw new Error(`无效日历日期：${value}`);
  const [year, month, day] = value.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = target - timezoneOffsetMilliseconds(new Date(guess), timezone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

export function calendarDateRangeToUtc(
  from: string,
  to: string,
  timezone: string,
) {
  if (!validCalendarDate(from) || !validCalendarDate(to) || from >= to) {
    throw new Error("日期范围必须是有效且递增的日历日期。");
  }
  return {
    from: calendarMidnightUtc(from, timezone),
    to: calendarMidnightUtc(to, timezone),
  };
}

function matchingRun(
  runId: string | null | undefined,
  monitorId: string | undefined,
  runs: MonitorRun[],
) {
  return runs.find(
    (run) => run.id === runId && (!monitorId || run.monitorId === monitorId),
  );
}

function firstMonitor(monitors: MonitorSummary[], requested?: string | null) {
  return monitors.find((monitor) => monitor.id === requested) || monitors[0];
}

export function readMonitoringQuery(
  search: string,
  context: MonitoringQueryContext,
): MonitoringQueryState {
  const params = new URLSearchParams(search);
  const timezone = context.project?.timezone || "Asia/Shanghai";
  const rawRange = params.get("range") || "7d";
  const range = ranges.has(rawRange) ? (rawRange as DateRange) : "7d";
  const requestedFrom = params.get("from");
  const requestedTo = params.get("to");
  const customWindowValid =
    range === "custom" &&
    validCalendarDate(requestedFrom) &&
    validCalendarDate(requestedTo) &&
    requestedFrom! < requestedTo!;
  const normalizedRange = customWindowValid
    ? range
    : range === "custom"
      ? "7d"
      : range;
  const window =
    normalizedRange === "custom"
      ? { from: requestedFrom!, to: requestedTo! }
      : monitoringDateWindow(normalizedRange, timezone);
  const utcWindow = calendarDateRangeToUtc(window.from, window.to, timezone);
  const fromTimestamp = Date.parse(utcWindow.from);
  const toTimestamp = Date.parse(utcWindow.to);
  const scopedRuns = context.runs.filter((candidate) => {
    const timestamp = Date.parse(candidate.createdAt);
    return (
      Number.isFinite(timestamp) &&
      timestamp >= fromTimestamp &&
      timestamp < toTimestamp
    );
  });
  const monitor = firstMonitor(context.monitors, params.get("monitor"));
  const monitorId = monitor?.id;
  const explicitRun = matchingRun(params.get("run"), monitorId, scopedRuns);
  const fallbackRun =
    context.currentRun?.monitorId === monitorId &&
    scopedRuns.some((candidate) => candidate.id === context.currentRun?.id)
      ? context.currentRun
      : scopedRuns.find((run) => run.monitorId === monitorId);
  const run = explicitRun || fallbackRun;
  const requestedRunId = params.get("run") || undefined;
  const runId =
    explicitRun?.id ||
    (requestedRunId &&
    (context.allowUnresolved || context.runIds?.includes(requestedRunId))
      ? requestedRunId
      : fallbackRun?.id);
  const attempts = context.attempts || run?.attempts || [];
  const questions = new Set([
    ...attempts.map((attempt) => attempt.questionId),
    ...(context.questionIds || []),
  ]);
  const models = new Set([
    ...attempts.map(attemptModelKey),
    ...(context.modelIds || []),
  ]);
  const requestedQuestion = params.get("question") || undefined;
  const requestedModel = params.get("model") || undefined;
  const question =
    questions.has(requestedQuestion || "") || context.allowUnresolved
      ? requestedQuestion
      : undefined;
  const model =
    models.has(requestedModel || "") || context.allowUnresolved
      ? requestedModel
      : undefined;
  const filteredAttempts =
    attempts.filter(
      (attempt) =>
        (!question || attempt.questionId === question) &&
        (!model || attemptModelKey(attempt) === model),
    ) || [];
  const availableAnswerQuestions = new Set(
    filteredAttempts.map((attempt) => attempt.questionId),
  );
  const requestedAnswerQuestion = params.get("answerQuestion") || undefined;
  const answerQuestion =
    availableAnswerQuestions.has(requestedAnswerQuestion || "") ||
    context.allowUnresolved
      ? requestedAnswerQuestion
      : filteredAttempts[0]?.questionId;
  const answerAttempts = filteredAttempts.filter(
    (attempt) => !answerQuestion || attempt.questionId === answerQuestion,
  );
  const requestedAnswer = params.get("answer") || undefined;
  const answerId =
    answerAttempts.some((attempt) => attempt.id === requestedAnswer) ||
    context.allowUnresolved
      ? requestedAnswer
      : answerAttempts.find(
          (attempt) => attempt.status === "completed" && attempt.answer?.trim(),
        )?.id || answerAttempts[0]?.id;
  const rawTab = params.get("tab") || "overview";
  const rawSourceScope = params.get("sourceScope") || "all";
  const rawSubject = params.get("subject") || "self";
  const availableCompetitors = run?.config.competitors || [];
  const competitorName = rawSubject.startsWith("competitor:")
    ? rawSubject.slice("competitor:".length)
    : undefined;
  const subject =
    rawSubject === "self" ||
    (context.allowUnresolved && Boolean(competitorName?.trim())) ||
    context.subjects?.includes(rawSubject as MonitoringQueryState["subject"]) ||
    availableCompetitors.some(
      (competitor) => competitor.name === competitorName,
    )
      ? (rawSubject as MonitoringQueryState["subject"])
      : "self";

  return {
    projectId: context.project?.id,
    monitorId,
    tab: tabIds.has(rawTab)
      ? (rawTab as MonitoringQueryState["tab"])
      : "overview",
    subject,
    runId,
    question,
    model,
    range: normalizedRange,
    from: window.from,
    to: window.to,
    answerQuestion,
    answerId,
    sourceScope: sourceScopes.has(rawSourceScope)
      ? (rawSourceScope as SourceScope)
      : "all",
    fullscreen: params.get("fullscreen") === "1",
  };
}

export function monitoringQueryString(state: MonitoringQueryState) {
  const params = new URLSearchParams();
  params.set("project", state.projectId || "");
  params.set("monitor", state.monitorId || "");
  params.set("tab", state.tab);
  params.set("subject", state.subject);
  if (state.runId) params.set("run", state.runId);
  params.set("question", state.question || "");
  params.set("model", state.model || "");
  params.set("range", state.range);
  params.set("from", state.from);
  params.set("to", state.to);
  params.set("answerQuestion", state.answerQuestion || "");
  params.set("answer", state.answerId || "");
  if (state.sourceScope !== "all") {
    params.set("sourceScope", state.sourceScope);
  }
  if (state.fullscreen) params.set("fullscreen", "1");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function writeMonitoringQuery(
  state: MonitoringQueryState,
  mode: "push" | "replace" = "push",
) {
  if (typeof window === "undefined") return;
  const url = projectWorkspaceUrl(`${window.location.pathname}${monitoringQueryString(state)}${window.location.hash}`);
  window.history[mode === "push" ? "pushState" : "replaceState"](
    window.history.state,
    "",
    url,
  );
}

export function monitoringExportHref(
  state: MonitoringQueryState,
  timezone: string,
) {
  if (state.tab === "goods" || state.tab === "videos") return;
  if (!state.monitorId || !uuidPattern.test(state.monitorId)) return;
  const bounds = calendarDateRangeToUtc(state.from, state.to, timezone);
  const params = new URLSearchParams({
    from: bounds.from,
    to: bounds.to,
    subject: state.subject === "self" ? "self" : "competitor",
    section: state.tab,
  });
  if (state.subject.startsWith("competitor:")) {
    params.set("competitor", state.subject.slice("competitor:".length));
  }
  if (state.question && uuidPattern.test(state.question)) {
    params.set("questionId", state.question);
  }
  if (state.model && uuidPattern.test(state.model)) {
    params.set("platformId", state.model);
  }
  return projectResourceUrl(
    `/api/monitoring/downloads/monitoring/${state.monitorId}.xlsx?${params.toString()}`,
  );
}
