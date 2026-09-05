import { describe, expect, it } from "vitest";

import {
  aggregateManusUsageChangePage,
  getManusRollingCreditUsage,
} from "./manus-usage-service";

describe("Manus v2 usage history", () => {
  it("computes net consumption while excluding account grants without task IDs", () => {
    const startAt = Date.parse("2026-07-01T00:00:00.000Z");
    const endAt = Date.parse("2026-08-01T00:00:00.000Z");
    const result = aggregateManusUsageChangePage({
      startAt,
      endAt,
      entries: [
        {
          task_id: "cost",
          type: "cost",
          credits: -240,
          created_at: startAt / 1_000,
        },
        {
          task_id: "refund",
          type: "refund",
          credits: 35,
          created_at: startAt / 1_000 + 1,
        },
        {
          type: "grant",
          credits: 10_000,
          created_at: startAt / 1_000 + 2,
        },
        {
          task_id: "expired",
          type: "cost",
          credits: -500,
          created_at: startAt / 1_000 - 1,
        },
        {
          task_id: "future",
          type: "cost",
          credits: -900,
          created_at: endAt / 1_000,
        },
      ],
    });

    expect(result).toEqual({
      netUsed: 205,
      complete: true,
      reachedCutoff: false,
    });
  });

  it("uses only the API-key header, follows cursors, and stops on an all-expired page", async () => {
    const startAt = Date.parse("2026-07-01T00:00:00.000Z");
    const endAt = Date.parse("2026-08-01T00:00:00.000Z");
    const calls: Array<{ url: string; headers: Headers }> = [];
    const responses = [
      {
        ok: true,
        data: [
          {
            title: "Deleted conversation",
            task_id: "deleted-task",
            type: "cost",
            credits: -200,
            created_at: startAt / 1_000 + 10,
          },
          {
            task_id: "refund-task",
            type: "refund",
            credits: 25,
            created_at: startAt / 1_000 + 9,
          },
          {
            type: "grant",
            credits: 5_000,
            created_at: startAt / 1_000 + 8,
          },
        ],
        has_more: true,
        next_cursor: "next page",
      },
      {
        ok: true,
        data: [
          {
            task_id: "expired-task",
            type: "cost",
            credits: -999,
            created_at: startAt / 1_000 - 1,
          },
        ],
        has_more: true,
        next_cursor: "unused",
      },
    ];
    const fetchImpl = async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(request),
        headers: new Headers(init?.headers),
      });
      return Response.json(responses[calls.length - 1]);
    };

    const result = await getManusRollingCreditUsage({
      apiKey: "test-key-never-log",
      startAt,
      endAt,
      baseUrl: "https://api.example.test/",
      fetchImpl,
    });

    expect(result).toEqual({ totalUsed: 175, complete: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://api.example.test/v2/usage.list?limit=100",
    );
    expect(calls[1]?.url).toBe(
      "https://api.example.test/v2/usage.list?limit=100&cursor=next+page",
    );
    expect(calls[0]?.headers.get("x-manus-api-key")).toBe("test-key-never-log");
    expect(calls[0]?.headers.has("Authorization")).toBe(false);
    expect(calls[0]?.headers.has("API_KEY")).toBe(false);
  });

  it("marks truncated pagination incomplete instead of treating a partial sum as final", async () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    const result = await getManusRollingCreditUsage({
      apiKey: "test-key",
      startAt: now - 30 * 86_400_000,
      endAt: now,
      baseUrl: "https://api.example.test",
      maxPages: 1,
      fetchImpl: async () =>
        Response.json({
          ok: true,
          data: [
            {
              task_id: "task-1",
              type: "cost",
              credits: -40,
              created_at: now / 1_000 - 1,
            },
          ],
          has_more: true,
          next_cursor: "still-more",
        }),
    });

    expect(result).toEqual({ totalUsed: 40, complete: false });
  });

  it("follows more than twenty pages before declaring the rolling total complete", async () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    let calls = 0;
    const result = await getManusRollingCreditUsage({
      apiKey: "test-key",
      startAt: now - 30 * 86_400_000,
      endAt: now,
      baseUrl: "https://api.example.test",
      fetchImpl: async (request) => {
        calls += 1;
        const page = calls;
        const url = new URL(String(request));
        expect(url.searchParams.get("cursor")).toBe(
          page === 1 ? null : `cursor-${page}`,
        );
        return Response.json({
          ok: true,
          data: [
            {
              task_id: `task-${page}`,
              type: "cost",
              credits: -1,
              created_at: now / 1_000 - page,
            },
          ],
          has_more: page < 21,
          next_cursor: page < 21 ? `cursor-${page + 1}` : undefined,
        });
      },
    });

    expect(result).toEqual({ totalUsed: 21, complete: true });
    expect(calls).toBe(21);
  });

  it("marks a repeated cursor incomplete and never loops forever", async () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    let calls = 0;
    const result = await getManusRollingCreditUsage({
      apiKey: "test-key",
      startAt: now - 30 * 86_400_000,
      endAt: now,
      baseUrl: "https://api.example.test",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          ok: true,
          data: [
            {
              task_id: `task-${calls}`,
              type: "cost",
              credits: -10,
              created_at: now / 1_000 - calls,
            },
          ],
          has_more: true,
          next_cursor: "same-cursor",
        });
      },
    });

    expect(result).toEqual({ totalUsed: 20, complete: false });
    expect(calls).toBe(2);
  });

  it("rejects unknown change categories as incomplete", () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    expect(
      aggregateManusUsageChangePage({
        startAt: now - 1_000,
        endAt: now,
        entries: [
          {
            task_id: "task-1",
            type: "mystery",
            credits: -20,
            created_at: now / 1_000 - 0.5,
          },
        ],
      }),
    ).toMatchObject({ netUsed: 0, complete: false });
  });

  it("fails closed when usage rows omit or repeat their task identity", () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    const seenTaskIds = new Set<string>();
    const first = aggregateManusUsageChangePage({
      startAt: now - 1_000,
      endAt: now,
      seenTaskIds,
      entries: [
        {
          task_id: "same-task",
          type: "cost",
          credits: -20,
          created_at: now / 1_000 - 0.5,
        },
        { type: "cost", credits: -30, created_at: now / 1_000 - 0.4 },
      ],
    });
    const second = aggregateManusUsageChangePage({
      startAt: now - 1_000,
      endAt: now,
      seenTaskIds,
      entries: [
        {
          task_id: "same-task",
          type: "cost",
          credits: -20,
          created_at: now / 1_000 - 0.3,
        },
      ],
    });

    expect(first).toMatchObject({ netUsed: 20, complete: false });
    expect(second).toMatchObject({ netUsed: 0, complete: false });
  });
});
