import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManusV2AccountRateLimiter,
  MANUS_V2_DEFAULT_RATE_LIMIT_SCOPE,
  MANUS_V2_RATE_LIMITS,
  ManusV2Client,
  type ManusV2RateLimitLane,
  type ManusV2RateLimiter,
} from "./manus-v2-client";

afterEach(() => vi.restoreAllMocks());

describe("Manus v2 account-scope rate limiter", () => {
  it.each([
    ["taskWrite", MANUS_V2_RATE_LIMITS.taskWrite],
    ["read", MANUS_V2_RATE_LIMITS.read],
    ["fileWrite", MANUS_V2_RATE_LIMITS.fileWrite],
  ] as const)("keeps the 10%% reserve for the %s lane", async (lane, limit) => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = createManusV2AccountRateLimiter({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    for (let index = 0; index <= limit; index += 1) {
      await limiter.acquire({ scope: "managed-user:42", lane });
    }

    expect(sleeps).toEqual([60_000]);
  });

  it("shares the unknown-account allowance across API-key rotations", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = createManusV2AccountRateLimiter({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    vi.spyOn(axios.Axios.prototype, "post").mockImplementation(
      async (_url, body) => ({
        status: 200,
        data: {
          ok: true,
          task_id: `task-${String((body as { title?: string }).title)}`,
        },
      }),
    );
    const firstKey = new ManusV2Client({
      baseUrl: "https://mock.manus.test",
      apiKey: "first-key",
      rateLimiter: limiter,
    });
    const rotatedKey = new ManusV2Client({
      baseUrl: "https://mock.manus.test",
      apiKey: "rotated-key",
      rateLimiter: limiter,
    });

    for (let index = 0; index <= MANUS_V2_RATE_LIMITS.taskWrite; index += 1) {
      const client = index % 2 === 0 ? firstKey : rotatedKey;
      await client.createTask({
        prompt: `operation ${index}`,
        title: String(index),
      });
    }

    expect(sleeps).toEqual([60_000]);
  });

  it("isolates explicitly resolved Manus account scopes", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = createManusV2AccountRateLimiter({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    for (let index = 0; index < MANUS_V2_RATE_LIMITS.taskWrite; index += 1) {
      await limiter.acquire({ scope: "managed-user:1", lane: "taskWrite" });
      await limiter.acquire({ scope: "managed-user:2", lane: "taskWrite" });
    }
    expect(sleeps).toEqual([]);

    await limiter.acquire({ scope: "managed-user:1", lane: "taskWrite" });
    expect(sleeps).toEqual([60_000]);
  });

  it("maps Gateway reads, task writes, and file writes to independent lanes", async () => {
    const admissions: Array<{
      scope: string;
      lane: ManusV2RateLimitLane;
    }> = [];
    const limiter: ManusV2RateLimiter = {
      acquire: async (input) => {
        admissions.push(input);
      },
    };
    vi.spyOn(axios.Axios.prototype, "post").mockImplementation(async (url) => {
      if (String(url).endsWith("/v2/task.create")) {
        return { status: 200, data: { ok: true, task_id: "task-1" } };
      }
      return {
        status: 200,
        data: {
          ok: true,
          upload_url: "https://uploads.manus.test/one",
          upload_expires_at: 2_000_000_000,
          file: { id: "file-1", filename: "facts.pdf" },
        },
      };
    });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: { ok: true, data: [], has_more: false },
    });
    const client = new ManusV2Client({
      baseUrl: "https://mock.manus.test",
      apiKey: "secret-key",
      rateLimitScope: "managed-user:7",
      rateLimiter: limiter,
    });

    await client.createTask({ prompt: "start" });
    await client.probeCredential();
    await client.createFile("facts.pdf");

    expect(admissions).toEqual([
      { scope: "managed-user:7", lane: "taskWrite" },
      { scope: "managed-user:7", lane: "read" },
      { scope: "managed-user:7", lane: "fileWrite" },
    ]);
  });

  it("uses one conservative scope when no account has been resolved", async () => {
    const admissions: string[] = [];
    const limiter: ManusV2RateLimiter = {
      acquire: async ({ scope }) => {
        admissions.push(scope);
      },
    };
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: { ok: true, data: [], has_more: false },
    });
    const client = new ManusV2Client({
      baseUrl: "https://mock.manus.test",
      apiKey: "secret-key",
      rateLimiter: limiter,
    });

    await client.probeCredential();

    expect(admissions).toEqual([MANUS_V2_DEFAULT_RATE_LIMIT_SCOPE]);
  });
});
