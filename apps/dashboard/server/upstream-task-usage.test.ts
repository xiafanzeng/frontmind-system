import { describe, expect, it } from "vitest";

import {
  buildRollingUsageTaskParams,
  parseRollingUsageTaskPayload,
  usagePageReachedCutoff,
} from "./upstream-task-usage";

describe("rolling task usage pagination", () => {
  it("asks the upstream task index for only the rolling window", () => {
    const params = buildRollingUsageTaskParams({
      limit: 100,
      startAt: Date.parse("2026-07-03T08:00:00.250Z"),
      endAt: Date.parse("2026-08-02T08:00:00.750Z"),
      after: "task-cursor",
    });

    expect(Object.fromEntries(params)).toEqual({
      limit: "100",
      order: "desc",
      orderBy: "created_at",
      createdAfter: "1783065599",
      createdBefore: "1785657602",
      after: "task-cursor",
    });
  });

  it("stops only after a complete page is entirely before the window", () => {
    expect(
      usagePageReachedCutoff({
        complete: true,
        datedTaskCount: 100,
        expiredTaskCount: 100,
      }),
    ).toBe(true);
    expect(
      usagePageReachedCutoff({
        complete: true,
        datedTaskCount: 100,
        expiredTaskCount: 99,
      }),
    ).toBe(false);
    expect(
      usagePageReachedCutoff({
        complete: false,
        datedTaskCount: 100,
        expiredTaskCount: 100,
      }),
    ).toBe(false);
  });

  it("degrades malformed legacy attribution payloads without throwing", async () => {
    await expect(
      parseRollingUsageTaskPayload(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      parseRollingUsageTaskPayload(Response.json({ ok: true, data: {} })),
    ).resolves.toBeNull();
    await expect(
      parseRollingUsageTaskPayload(
        Response.json({ ok: true, data: [{ id: "task-1" }] }),
      ),
    ).resolves.toMatchObject({ data: [{ id: "task-1" }] });
  });
});
