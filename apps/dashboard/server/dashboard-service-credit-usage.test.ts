import { describe, expect, it } from "vitest";

import {
  aggregateSharedKeyCreditUsagePage,
  getShanghaiCalendarMonthPeriod,
  getShanghaiRollingUsagePeriod,
  projectManagedAgentUsageRows,
  usageContributionForCredential,
} from "./dashboard-service";

describe("shared API Key credit usage", () => {
  it("attributes ordinary v2 chat tasks without upstream_resources", () => {
    const projected = projectManagedAgentUsageRows([
      {
        providerTaskId: "provider-v2-running",
        apiCredentialId: "credential-v2-running",
        accountUserId: 42,
        status: "running",
      },
      {
        providerTaskId: "provider-v2-complete",
        apiCredentialId: "credential-v2-complete",
        accountUserId: 43,
        status: "succeeded",
      },
      {
        providerTaskId: null,
        apiCredentialId: "credential-v2-unknown",
        accountUserId: 44,
        status: "attention_required",
      },
    ]);

    expect(projected.ownerByTask).toEqual(
      new Map([
        ["provider-v2-running", 42],
        ["provider-v2-complete", 43],
      ]),
    );
    expect(
      projected.expectedTaskIdsByCredential.get("credential-v2-running"),
    ).toEqual(new Set(["provider-v2-running"]));
    expect([...projected.unsettledCredentialIds]).toEqual([
      "credential-v2-running",
      "credential-v2-unknown",
    ]);
  });

  it("keeps current physical Key pool totals separate from cross-history account usage", () => {
    const accountIds = new Set([42]);
    const oldA = usageContributionForCredential({
      creditUsage: 10,
      credentialFingerprint: "fingerprint-A",
      poolFingerprint: "fingerprint-C",
      ownerId: 42,
      accountIds,
    });
    const currentC = usageContributionForCredential({
      creditUsage: 20,
      credentialFingerprint: "fingerprint-C",
      poolFingerprint: "fingerprint-C",
      ownerId: 42,
      accountIds,
    });
    expect(oldA.poolUsed + currentC.poolUsed).toBe(20);
    expect(oldA.accountUsed + currentC.accountUsed).toBe(30);
  });

  it("shows the shared pool total without exposing another account's task details", () => {
    const now = Date.now();
    const result = aggregateSharedKeyCreditUsagePage({
      tasks: [
        {
          id: "task-current-account",
          created_at: now,
          metadata: {
            credit_usage: 120,
            task_title: "当前账号品牌分析",
          },
        },
        {
          id: "task-other-account",
          created_at: now,
          metadata: {
            credit_usage: 80,
            task_title: "其他账号机密任务",
          },
        },
      ],
      ownedTaskIds: new Set(["task-current-account"]),
      cutoff: now - 30 * 24 * 60 * 60 * 1_000,
      seenTaskIds: new Set(),
    });

    expect(result.totalUsed).toBe(200);
    expect(result.accountUsed).toBe(120);
    expect(result.recentTasks).toEqual([
      expect.objectContaining({
        id: "task-current-account",
        title: "当前账号品牌分析",
        creditUsage: 120,
      }),
    ]);
    expect(JSON.stringify(result.recentTasks)).not.toContain(
      "其他账号机密任务",
    );
  });

  it("does not count duplicate tasks twice across pages", () => {
    const now = Date.now();
    const seenTaskIds = new Set<string>();
    const task = {
      id: "task-shared-page-boundary",
      created_at: now,
      credit_usage: 36,
    };

    const first = aggregateSharedKeyCreditUsagePage({
      tasks: [task],
      ownedTaskIds: new Set(["task-shared-page-boundary"]),
      cutoff: now - 1_000,
      seenTaskIds,
    });
    const second = aggregateSharedKeyCreditUsagePage({
      tasks: [task],
      ownedTaskIds: new Set(["task-shared-page-boundary"]),
      cutoff: now - 1_000,
      seenTaskIds,
    });

    expect(first.totalUsed).toBe(36);
    expect(first.accountUsed).toBe(36);
    expect(second.totalUsed).toBe(0);
    expect(second.accountUsed).toBe(0);
    expect(second.recentTasks).toEqual([]);
  });

  it("does not stop at one out-of-order expired task", () => {
    const now = Date.parse("2026-08-02T08:00:00.000Z");
    const cutoff = now - 30 * 86_400_000;
    const result = aggregateSharedKeyCreditUsagePage({
      tasks: [
        { id: "old-first", created_at: cutoff - 1, credit_usage: 99 },
        { id: "new-later", created_at: cutoff + 1, credit_usage: 40 },
      ],
      ownedTaskIds: new Set(["new-later"]),
      cutoff,
      endExclusive: now,
      seenTaskIds: new Set(),
    });

    expect(result).toMatchObject({
      totalUsed: 40,
      accountUsed: 40,
      reachedCutoff: false,
      complete: true,
    });
  });

  it("stops once a complete page is entirely older than the rolling window", () => {
    const now = Date.parse("2026-08-02T08:00:00.000Z");
    const cutoff = now - 30 * 86_400_000;
    const result = aggregateSharedKeyCreditUsagePage({
      tasks: [
        { id: "old-a", created_at: cutoff - 1, credit_usage: 99 },
        { id: "old-b", created_at: cutoff - 2, credit_usage: 88 },
      ],
      ownedTaskIds: new Set(["old-a", "old-b"]),
      cutoff,
      endExclusive: now,
      seenTaskIds: new Set(),
    });

    expect(result).toMatchObject({
      totalUsed: 0,
      accountUsed: 0,
      reachedCutoff: true,
      complete: true,
    });
  });

  it("uses an exact rolling 30-day boundary while formatting in Asia/Shanghai", () => {
    const now = Date.parse("2026-08-02T08:00:00.000Z");
    const period = getShanghaiRollingUsagePeriod(30, now);
    expect(period).toMatchObject({
      label: "近 30 天",
      timezone: "Asia/Shanghai",
      startAt: Date.parse("2026-07-03T08:00:00.000Z"),
      endAt: now,
    });
    const result = aggregateSharedKeyCreditUsagePage({
      tasks: [
        { id: "at-cutoff", created_at: period.startAt, credit_usage: 30 },
        {
          id: "before-cutoff",
          created_at: period.startAt - 1,
          credit_usage: 99,
        },
      ],
      ownedTaskIds: new Set(["at-cutoff", "before-cutoff"]),
      cutoff: period.startAt,
      endExclusive: period.endAt,
      seenTaskIds: new Set(),
    });
    expect(result.totalUsed).toBe(30);
    expect(result.accountUsed).toBe(30);
  });

  it("uses a Beijing-time calendar month instead of a rolling 30-day window", () => {
    const period = getShanghaiCalendarMonthPeriod(
      Date.parse("2026-07-31T20:30:00.000Z"),
    );

    expect(period).toMatchObject({
      key: "2026-08",
      label: "2026 年 8 月",
      timezone: "Asia/Shanghai",
      startAt: Date.parse("2026-07-31T16:00:00.000Z"),
      endAt: Date.parse("2026-08-31T16:00:00.000Z"),
    });
  });

  it("excludes next-month tasks from both the Key pool and account ledger", () => {
    const period = getShanghaiCalendarMonthPeriod(
      Date.parse("2026-07-15T00:00:00.000Z"),
    );
    const result = aggregateSharedKeyCreditUsagePage({
      tasks: [
        {
          id: "next-month",
          created_at: period.endAt,
          credit_usage: 90,
        },
        {
          id: "current-month",
          created_at: period.endAt - 1,
          credit_usage: 45,
        },
      ],
      ownedTaskIds: new Set(["next-month", "current-month"]),
      cutoff: period.startAt,
      endExclusive: period.endAt,
      seenTaskIds: new Set(),
    });

    expect(result.totalUsed).toBe(45);
    expect(result.accountUsed).toBe(45);
    expect(result.recentTasks.map((task) => task.id)).toEqual([
      "current-month",
    ]);
  });
});
