import { describe, expect, it } from "vitest";

import {
  aggregateManusUsageChangePage,
  getManusRollingCreditUsage,
  ManusUsageSyncError,
} from "./manus-usage-service";

describe("Manus v2 usage history", () => {
  it("treats omitted cost/refund credits as authoritative zero without coercing present values", () => {
    const startAt = Date.parse("2026-07-01T00:00:00.000Z");
    const endAt = Date.parse("2026-08-01T00:00:00.000Z");
    const result = aggregateManusUsageChangePage({
      startAt,
      endAt,
      entries: [
        {
          task_id: "zero-cost",
          type: "cost",
          created_at: startAt / 1_000,
        },
        {
          task_id: "zero-refund",
          type: "refund",
          created_at: startAt / 1_000 + 1,
        },
      ],
    });

    expect(result).toEqual({
      netUsed: 0,
      complete: true,
      reachedCutoff: false,
    });
  });

  it("keeps the observed 8,550 total complete when zero-cost rows omit credits", () => {
    const startAt = Date.parse("2026-07-01T00:00:00.000Z");
    const endAt = Date.parse("2026-08-01T00:00:00.000Z");
    const at = startAt / 1_000;
    const entries = [
      ...Array.from({ length: 15 }, (_, index) => ({
        type: "grant",
        credits: 1_000,
        created_at: at + index,
      })),
      ...[-2_000, -1_900, -1_800, -1_500, -1_350].map((credits, index) => ({
        task_id: `charged-${index}`,
        type: "cost",
        credits,
        created_at: at + 20 + index,
      })),
      ...Array.from({ length: 17 }, (_, index) => ({
        task_id: `zero-${index}`,
        type: "cost",
        created_at: at + 30 + index,
      })),
    ];

    expect(aggregateManusUsageChangePage({ startAt, endAt, entries })).toEqual({
      netUsed: 8_550,
      complete: true,
      reachedCutoff: false,
    });
  });

  it.each([null, "0", Number.NaN, Number.POSITIVE_INFINITY])(
    "marks an explicitly present invalid credits value %s partial",
    (credits) => {
      const now = Date.parse("2026-08-01T00:00:00.000Z");
      expect(
        aggregateManusUsageChangePage({
          startAt: now - 1_000,
          endAt: now,
          entries: [
            {
              task_id: "invalid-credits",
              type: "cost",
              credits,
              created_at: now / 1_000 - 0.5,
            },
          ],
        }),
      ).toMatchObject({ netUsed: 0, complete: false });
    },
  );

  it("requires grants to carry a finite numeric credits value", () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    expect(
      aggregateManusUsageChangePage({
        startAt: now - 1_000,
        endAt: now,
        entries: [
          {
            type: "grant",
            created_at: now / 1_000 - 0.5,
          },
        ],
      }),
    ).toMatchObject({ netUsed: 0, complete: false });
  });

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

  it("counts one cost and one refund for the same task as distinct accounting rows", () => {
    const startAt = Date.parse("2026-07-01T00:00:00.000Z");
    const endAt = Date.parse("2026-08-01T00:00:00.000Z");
    const result = aggregateManusUsageChangePage({
      startAt,
      endAt,
      seenTaskEntries: new Map<string, string>(),
      entries: [
        {
          task_id: "refunded-task",
          type: "cost",
          credits: -240,
          created_at: startAt / 1_000,
        },
        {
          task_id: "refunded-task",
          type: "refund",
          credits: 35,
          created_at: startAt / 1_000 + 1,
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

    expect(result).toEqual({
      totalUsed: 40,
      complete: false,
      issueCode: "PARTIAL_USAGE_SCAN",
    });
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

    expect(result).toEqual({
      totalUsed: 20,
      complete: false,
      issueCode: "PAGINATION_INVALID",
    });
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

  it("deduplicates byte-identical cross-page rows without degrading completeness", async () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    let calls = 0;
    const row = {
      task_id: "stable-task",
      type: "cost",
      credits: -20,
      created_at: now / 1_000 - 1,
    };
    const result = await getManusRollingCreditUsage({
      apiKey: "test-key",
      startAt: now - 30 * 86_400_000,
      endAt: now,
      baseUrl: "https://api.example.test",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          ok: true,
          data: [row],
          has_more: calls === 1,
          next_cursor: calls === 1 ? "next" : undefined,
        });
      },
    });

    expect(result).toEqual({ totalUsed: 20, complete: true });
    expect(calls).toBe(2);
  });

  it("retries one full scan and reports PAGE_DRIFT for conflicting task rows", async () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    let calls = 0;
    const result = await getManusRollingCreditUsage({
      apiKey: "test-key",
      startAt: now - 30 * 86_400_000,
      endAt: now,
      baseUrl: "https://api.example.test",
      fetchImpl: async () => {
        calls += 1;
        const page = (calls - 1) % 2;
        return Response.json({
          ok: true,
          data: [
            {
              task_id: "moving-task",
              type: "cost",
              credits: -20,
              created_at: now / 1_000 - 1 - page,
            },
          ],
          has_more: page === 0,
          next_cursor: page === 0 ? "next" : undefined,
        });
      },
    });

    expect(result).toEqual({
      totalUsed: 20,
      complete: false,
      issueCode: "PAGE_DRIFT",
    });
    expect(calls).toBe(4);
  });

  it.each([
    [401, "CREDENTIAL_REJECTED"],
    [403, "CREDENTIAL_REJECTED"],
    [429, "RATE_LIMITED"],
    [503, "UPSTREAM_UNAVAILABLE"],
  ] as const)(
    "classifies HTTP %s without exposing response contents",
    async (status, code) => {
      const now = Date.parse("2026-08-01T00:00:00.000Z");
      await expect(
        getManusRollingCreditUsage({
          apiKey: "test-key",
          startAt: now - 30 * 86_400_000,
          endAt: now,
          baseUrl: "https://api.example.test",
          fetchImpl: async () => new Response("sensitive", { status }),
        }),
      ).rejects.toMatchObject({ code } satisfies Partial<ManusUsageSyncError>);
    },
  );

  it("classifies timeouts and invalid JSON responses", async () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    const baseInput = {
      apiKey: "test-key",
      startAt: now - 30 * 86_400_000,
      endAt: now,
      baseUrl: "https://api.example.test",
    };
    await expect(
      getManusRollingCreditUsage({
        ...baseInput,
        fetchImpl: async () => {
          const error = new Error("timeout");
          error.name = "TimeoutError";
          throw error;
        },
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(
      getManusRollingCreditUsage({
        ...baseInput,
        fetchImpl: async () => new Response("not-json"),
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });
});
