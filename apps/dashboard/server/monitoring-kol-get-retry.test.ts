// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { KolClient } from "../../../packages/monitoring-provider-kol/src/client";
import { loadWorkerConfig } from "../../../apps/monitoring-worker/src/config";

const resourcePage = () =>
  Response.json({
    success: true,
    status: 200,
    data: [],
    pagination: {
      current_page: 721,
      last_page: 1837,
      per_page: 50,
      total: 91832,
    },
  });

function subject(
  responses: (() => Response)[],
  options: Partial<ConstructorParameters<typeof KolClient>[0]> = {},
) {
  const requests: { method: string; url: string }[] = [];
  const sleep = vi.fn(async (_milliseconds: number) => {});
  const client = new KolClient({
    baseUrl: "https://api.kol.test",
    mode: "live",
    accessToken: "test-token",
    realEnabled: true,
    publishEnabled: true,
    createOrderEncoding: "form",
    sleep,
    ...options,
    fetch: async (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected test request");
      return response();
    },
  });
  return { client, requests, sleep };
}

describe("KOL same-page transient GET recovery", () => {
  it("keeps the same catalog page and token through temporary HTML and empty responses", async () => {
    const { client, requests, sleep } = subject([
      () => new Response("<html>Temporary proxy error</html>"),
      () => new Response(""),
      () => new Response("{truncated"),
      resourcePage,
    ]);
    expect((await client.listResources(721)).pagination.currentPage).toBe(721);
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((r) => `${r.method} ${r.url}`)).size).toBe(1);
    expect(new URL(requests[0]!.url).searchParams.get("page")).toBe("721");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });

  it("stops a persistently malformed page after the finite GET budget", async () => {
    const { client, requests, sleep } = subject(
      Array.from(
        { length: 5 },
        () => () => new Response("<html>Unavailable</html>"),
      ),
    );
    await expect(client.listResources(721)).rejects.toMatchObject({
      code: "invalid_response",
      retryable: true,
    });
    expect(requests).toHaveLength(5);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it.each([
    [undefined, 1000],
    ["", 1000],
    ["n/a", 1000],
    ["0", 0],
    ["2", 2000],
  ])(
    "backs off a temporary HTTP failure with Retry-After %s",
    async (value, delay) => {
      const { client, sleep } = subject([
        () =>
          Response.json(
            { status: 503 },
            {
              status: 503,
              headers: value === undefined ? {} : { "retry-after": value },
            },
          ),
        resourcePage,
      ]);
      await client.listResources(721);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([delay]);
    },
  );

  it("retries a network interruption without replaying earlier catalog pages", async () => {
    const { client, requests, sleep } = subject([
      () => {
        throw new TypeError("fetch failed");
      },
      resourcePage,
    ]);
    await client.listResources(721);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it.each([
    () => new Response("Bad request", { status: 400 }),
    () =>
      new Response("too large", { headers: { "content-length": "999999999" } }),
    () => Response.json({ status: 200, data: "wrong shape" }),
  ])(
    "does not retry a permanent HTTP, size or schema rejection",
    async (response) => {
      const { client, requests, sleep } = subject([response]);
      await expect(client.listResources(721)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(requests).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("never retries an order POST when the upstream returns temporary HTML", async () => {
    const { client, requests, sleep } = subject([
      () => new Response("<html>Unavailable</html>", { status: 503 }),
    ]);
    await expect(
      client.createOrder({
        resourceId: 1,
        title: "测试",
        html: "<p>仅测试</p>",
      }),
    ).rejects.toMatchObject({ code: "submission_unknown" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses the same finite defaults in the production worker and preserves explicit overrides", () => {
    const env = {
      NODE_ENV: "production",
      OBJECT_STORE_DRIVER: "local",
      ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: "true",
      LOCAL_OBJECT_STORE_DIR: "/tmp/frontmind-test-storage",
      MOLI_API_TOKEN: "test-moli-token",
      PUBLISHER_FEATURE_ENABLED: "true",
      PUBLISHER_PROVIDER_ENABLED: "true",
      PUBLISHER_MODE: "live",
      PUBLISHER_PUBLIC_ORIGIN: "https://dashboard.test",
      PUBLISHER_KOL_BASE_URL: "https://api.kol.test",
      PUBLISHER_KOL_ACCESS_TOKEN: "test-token",
    };
    expect(loadWorkerConfig(env).publisher).toMatchObject({
      maxGetAttempts: 5,
      getRetryBaseMs: 1000,
    });
    expect(
      loadWorkerConfig({
        ...env,
        PUBLISHER_GET_MAX_ATTEMPTS: "2",
        PUBLISHER_GET_RETRY_BASE_MS: "50",
      }).publisher,
    ).toMatchObject({ maxGetAttempts: 2, getRetryBaseMs: 50 });
  });
});
