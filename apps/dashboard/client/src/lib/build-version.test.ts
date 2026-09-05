import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

describe("FrontMind build version freshness check", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", originalFetch);
  });

  it("fails open within the bounded window when version.json stalls", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const {
      checkFrontMindBuildVersion,
      FRONTMIND_BUILD_VERSION_CHECK_MAX_WAIT_MS,
    } = await import("./build-version");

    const check = checkFrontMindBuildVersion();
    await vi.advanceTimersByTimeAsync(
      FRONTMIND_BUILD_VERSION_CHECK_MAX_WAIT_MS,
    );

    await expect(check).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      signal: expect.objectContaining({ aborted: true }),
    });
  });

  it("caches a confirmed current version for consecutive submissions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "test" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { checkFrontMindBuildVersion } = await import("./build-version");

    await expect(checkFrontMindBuildVersion()).resolves.toBe(true);
    await expect(checkFrontMindBuildVersion()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
