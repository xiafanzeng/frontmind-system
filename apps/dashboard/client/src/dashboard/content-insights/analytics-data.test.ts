import { describe, expect, it } from "vitest";
import type { Period } from "./shared";
import {
  ARTICLES,
  EMPTY_QA_FILTERS,
  QA_MODELS,
  QA_RECORDS,
  SEARCH_RECORDS,
  TRAFFIC_SOURCES,
  articleRows,
  filterQa,
  inPeriod,
  overviewSeries,
  overviewTotals,
  searchRows,
  trafficRows,
} from "./analytics-data";

const PERIOD: Period = { from: "2026-08-07", to: "2026-09-06", unit: "day" };
const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);

describe("synthetic analytics dates", () => {
  it("includes whole boundary days, allows open bounds and rejects invalid or reversed dates", () => {
    expect(inPeriod("2026-08-07 00:00:00", PERIOD)).toBe(true);
    expect(inPeriod("2026-09-06T23:59:59Z", PERIOD)).toBe(true);
    expect(inPeriod("2026-08-06 23:59:59", PERIOD)).toBe(false);
    expect(inPeriod("2026-09-07", PERIOD)).toBe(false);
    expect(inPeriod("2026-09-06", { from: "", to: "" })).toBe(true);
    expect(inPeriod("2026-09-06", { from: "", to: "2026-09-06" })).toBe(true);
    expect(inPeriod("2026-09-06", { from: "2026-09-06", to: "" })).toBe(true);
    expect(inPeriod("2026-02-30", { from: "", to: "" })).toBe(false);
    expect(inPeriod("not a date", PERIOD)).toBe(false);
    expect(inPeriod("2026-09-06", { from: "invalid", to: "" })).toBe(false);
    expect(
      inPeriod("2026-09-06", { from: "2026-09-07", to: "2026-08-07" }),
    ).toBe(false);
  });

  it("provides enough fully synthetic records to exercise pagination", () => {
    expect(ARTICLES.length).toBeGreaterThanOrEqual(26);
    expect(TRAFFIC_SOURCES.length).toBeGreaterThanOrEqual(16);
    expect(SEARCH_RECORDS.length).toBeGreaterThanOrEqual(4);
    expect(QA_RECORDS.length).toBeGreaterThanOrEqual(26);
    expect(articleRows(PERIOD).length).toBeGreaterThanOrEqual(26);
    expect(trafficRows(PERIOD).length).toBeGreaterThanOrEqual(16);
    expect(QA_MODELS).not.toContain("全部");
    expect(new Set(QA_RECORDS.map((row) => row.model))).toEqual(
      new Set(QA_MODELS),
    );
    expect(
      QA_RECORDS.every(
        (row) =>
          row.asker.startsWith("演示用户") &&
          row.sessionId.startsWith("demo-session-"),
      ),
    ).toBe(true);
    expect(
      QA_RECORDS.flatMap((row) => row.sources).every((source) =>
        new URL(source.url).hostname.endsWith(".example.com"),
      ),
    ).toBe(true);
  });
});

describe("analytics period aggregation", () => {
  it("fills all daily buckets including quiet days and aggregates the same values by month", () => {
    const daily = overviewSeries(PERIOD);
    expect(daily).toHaveLength(31);
    expect(daily[0].date).toBe("2026-08-07");
    expect(daily.at(-1)?.date).toBe("2026-09-06");
    expect(daily.find((row) => row.date === "2026-09-02")).toEqual({
      date: "2026-09-02",
      pv: 0,
      uv: 0,
      likes: 0,
      dislikes: 0,
      feedback: 0,
    });
    const monthly = overviewSeries({ ...PERIOD, unit: "month" });
    expect(monthly.map((row) => row.date)).toEqual(["2026-08", "2026-09"]);
    for (const month of monthly) {
      for (const key of [
        "pv",
        "uv",
        "likes",
        "dislikes",
        "feedback",
      ] as const) {
        expect(month[key]).toBe(
          sum(
            daily
              .filter((day) => day.date.startsWith(month.date))
              .map((day) => day[key]),
          ),
        );
      }
    }
    const totals = overviewTotals(PERIOD);
    for (const key of ["pv", "uv", "likes", "dislikes", "feedback"] as const) {
      expect(totals[key]).toBe(sum(daily.map((day) => day[key])));
      expect(totals[key]).toBe(
        sum(articleRows(PERIOD).map((article) => article[key])),
      );
    }
    expect(overviewTotals({ ...PERIOD, unit: "month" })).toEqual(totals);
    expect(totals.mb).toBeGreaterThan(0);
  });

  it("recomputes period totals and last activity rather than reusing all-time row values", () => {
    const narrow: Period = {
      from: "2026-09-06",
      to: "2026-09-06",
      unit: "day",
    };
    expect(articleRows(narrow).length).toBeGreaterThan(0);
    expect(
      articleRows(narrow).every((row) =>
        row.lastVisited.startsWith(narrow.from),
      ),
    ).toBe(true);
    expect(
      trafficRows(narrow).every((row) =>
        row.lastVisited.startsWith(narrow.from),
      ),
    ).toBe(true);
    expect(
      searchRows(narrow).every((row) =>
        row.lastSearched.startsWith(narrow.from),
      ),
    ).toBe(true);
    expect(overviewTotals(narrow).pv).toBeLessThan(overviewTotals(PERIOD).pv);
    expect(sum(articleRows(narrow).map((row) => row.pv))).toBe(
      overviewTotals(narrow).pv,
    );
    const all = overviewTotals({ from: "", to: "", unit: "day" });
    expect(all.pv).toBeGreaterThan(overviewTotals(PERIOD).pv);
    expect(overviewSeries({ from: "", to: "", unit: "day" })[0].date).toBe(
      "2026-08-04",
    );
  });

  it("clears tables and totals for an empty interval while retaining zero chart buckets", () => {
    const empty: Period = { from: "2027-01-01", to: "2027-01-03", unit: "day" };
    expect(articleRows(empty)).toEqual([]);
    expect(trafficRows(empty)).toEqual([]);
    expect(searchRows(empty)).toEqual([]);
    expect(overviewTotals(empty)).toEqual({
      pv: 0,
      uv: 0,
      mb: 0,
      likes: 0,
      dislikes: 0,
      feedback: 0,
    });
    expect(overviewSeries(empty)).toHaveLength(3);
    expect(
      overviewSeries(empty).every((row) => row.pv === 0 && row.uv === 0),
    ).toBe(true);
    expect(overviewSeries({ ...empty, from: "2027-02-01" })).toEqual([]);
  });
});

describe("AI question filtering", () => {
  it("ANDs every field, matches text without case sensitivity and includes boundary dates", () => {
    const target = QA_RECORDS.find(
      (row) => row.internet && row.answer && inPeriod(row.createdAt, PERIOD),
    )!;
    const date = target.createdAt.slice(0, 10);
    const filters = {
      ...EMPTY_QA_FILTERS,
      asker: target.asker,
      channel: target.channel,
      answerState: "有回答",
      question: target.question,
      answer: target.answer.slice(0, 8),
      sessionId: ` ${target.sessionId.toUpperCase()} `,
      model: target.model.toLowerCase(),
      internet: "是",
      from: date,
      to: date,
    };
    expect(filterQa(filters)).toEqual([target]);
    expect(filterQa({ ...filters, internet: "否" })).toEqual([]);
    expect(filterQa({ ...filters, answerState: "无回答" })).toEqual([]);
    expect(filterQa({ ...filters, question: "不存在的演示问题" })).toEqual([]);
  });

  it("distinguishes unanswered records and does not retain stale results after reset", () => {
    const unanswered = filterQa({ ...EMPTY_QA_FILTERS, answerState: "无回答" });
    expect(unanswered.length).toBeGreaterThan(0);
    expect(
      unanswered.every((row) => row.answer === "" && row.sources.length === 0),
    ).toBe(true);
    expect(filterQa({ ...EMPTY_QA_FILTERS, from: "2027-01-01" })).toEqual([]);
    expect(filterQa(EMPTY_QA_FILTERS)).toEqual(QA_RECORDS);
    expect(
      filterQa({ ...EMPTY_QA_FILTERS, from: PERIOD.from, to: PERIOD.to })
        .length,
    ).toBeLessThan(QA_RECORDS.length);
  });
});
