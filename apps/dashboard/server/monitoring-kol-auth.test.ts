// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { KolClient } from "../../../packages/monitoring-provider-kol/src/client";
import { loadWorkerConfig } from "../../../apps/monitoring-worker/src/config";

const credentials = {
  apiKey: "test-api-key",
  mobile: "test-mobile",
  password: "test-password",
  identity: "advertiser",
  captcha: "test-captcha",
  captchaToken: "test-captcha-token",
};
const page = () =>
  Response.json({
    success: true,
    status: 200,
    data: [],
    pagination: { current_page: 1, last_page: 1, per_page: 50, total: 0 },
  });
const token = () =>
  Response.json({
    success: true,
    status: 200,
    data: { token: "test-refreshed-token" },
  });
function subject(
  responses: (() => Response)[],
  options: Partial<ConstructorParameters<typeof KolClient>[0]> = {},
) {
  const calls: { method: string; path: string; token: string | null }[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        token:
          url.searchParams.get("token") ??
          new Headers(init?.headers).get("authorization"),
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected network request in test");
      return response();
    },
  );
  const client = new KolClient({
    baseUrl: "https://api.kol.test",
    mode: "live",
    accessToken: "test-supplied-token",
    ...credentials,
    maxGetAttempts: 1,
    realEnabled: true,
    publishEnabled: true,
    createOrderEncoding: "form",
    ...options,
    fetch: fetchImpl,
  });
  return { client, calls, fetchImpl };
}

describe("KOL explicit token plus account refresh", () => {
  it("reuses a supplied token without login, even when its local JWT expiry is old", async () => {
    const expiredToken = `test.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.test`;
    const { client, calls } = subject([page, page], {
      accessToken: expiredToken,
    });
    await client.listResources();
    await client.listResources();
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (call) => call.method === "GET" && call.token === expiredToken,
      ),
    ).toBe(true);
  });
  it.each([401, 200])(
    "refreshes once after a safe GET reports 401 with HTTP %s",
    async (httpStatus) => {
      const { client, calls, fetchImpl } = subject([
        () =>
          Response.json(
            { success: false, status: 401 },
            { status: httpStatus },
          ),
        token,
        page,
        () => Response.json({ success: true, status: 200, data: [] }),
      ]);
      await client.listResources();
      await client.listOrders();
      expect(calls).toEqual([
        {
          method: "GET",
          path: "/api/news_resource_2/data",
          token: "test-supplied-token",
        },
        { method: "POST", path: "/api/auth/authenticate", token: null },
        {
          method: "GET",
          path: "/api/news_resource_2/data",
          token: "test-refreshed-token",
        },
        {
          method: "GET",
          path: "/api/news_order",
          token: "Bearer test-refreshed-token",
        },
      ]);
      expect(
        Object.fromEntries(
          new URLSearchParams(
            fetchImpl.mock.calls[1]![1]!.body as URLSearchParams,
          ),
        ),
      ).toEqual({
        mobile: credentials.mobile,
        password: credentials.password,
        api_key: credentials.apiKey,
        identity: credentials.identity,
        captcha: credentials.captcha,
        captcha_token: credentials.captchaToken,
      });
    },
  );
  it("refreshes on an actual HTTP 401 even without a JSON error envelope", async () => {
    const { client, calls } = subject([
      () => new Response("Unauthorized", { status: 401 }),
      token,
      page,
    ]);
    await client.listResources();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/news_resource_2/data",
      "/api/auth/authenticate",
      "/api/news_resource_2/data",
    ]);
  });
  it("does not log in for a forbidden 403 response", async () => {
    const { client, calls } = subject([
      () => Response.json({ status: 403 }, { status: 403 }),
    ]);
    await expect(client.listResources()).rejects.toMatchObject({
      code: "authentication_blocked",
    });
    expect(calls).toHaveLength(1);
  });
  it("fails closed when only a token or incomplete login credentials are configured", async () => {
    for (const extra of [
      { apiKey: undefined },
      {
        apiKey: undefined,
        mobile: undefined,
        password: undefined,
        identity: undefined,
        captcha: undefined,
        captchaToken: undefined,
      },
    ]) {
      const { client, calls } = subject(
        [() => Response.json({ status: 401 }, { status: 401 })],
        extra,
      );
      await expect(client.listResources()).rejects.toMatchObject({
        code: "authentication_blocked",
      });
      await expect(client.listResources()).rejects.toMatchObject({
        code: "authentication_blocked",
      });
      expect(calls).toHaveLength(1);
    }
  });
  it("stops after one refresh if the renewed token is also rejected", async () => {
    const rejected = () => Response.json({ status: 401 }, { status: 401 });
    const { client, calls } = subject([rejected, token, rejected]);
    await expect(client.listResources()).rejects.toMatchObject({
      code: "authentication_blocked",
    });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/news_resource_2/data",
      "/api/auth/authenticate",
      "/api/news_resource_2/data",
    ]);
  });
  it("never refreshes or repeats a non-idempotent order POST after a 401", async () => {
    const { client, calls } = subject([
      () => Response.json({ status: 401 }, { status: 401 }),
    ]);
    const order = { resourceId: 1, title: "测试订单", html: "<p>仅测试</p>" };
    await expect(client.createOrder(order)).rejects.toMatchObject({
      code: "submission_unknown",
    });
    await expect(client.createOrder(order)).rejects.toMatchObject({
      code: "authentication_blocked",
    });
    expect(calls).toEqual([
      { method: "POST", path: "/api/news_order", token: null },
    ]);
  });
  it("retains the existing account-only login path", async () => {
    const { client, calls } = subject([token, page], {
      accessToken: undefined,
    });
    await client.listResources();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/authenticate",
      "/api/news_resource_2/data",
    ]);
  });
});

const workerEnv = {
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
  PUBLISHER_KOL_ACCESS_TOKEN: "test-supplied-token",
};
const loginEnv = {
  PUBLISHER_KOL_API_KEY: credentials.apiKey,
  PUBLISHER_KOL_MOBILE: credentials.mobile,
  PUBLISHER_KOL_PASSWORD: credentials.password,
  PUBLISHER_KOL_IDENTITY: credentials.identity,
  PUBLISHER_KOL_CAPTCHA: credentials.captcha,
  PUBLISHER_KOL_CAPTCHA_TOKEN: credentials.captchaToken,
};
describe("KOL Worker authentication configuration", () => {
  it("keeps all six configured fields alongside an explicit token", () => {
    expect(
      loadWorkerConfig({ ...workerEnv, ...loginEnv }).publisher,
    ).toMatchObject({ accessToken: "test-supplied-token", ...credentials });
  });
  it("preserves token-only startup with absent, partial or placeholder legacy login fields", () => {
    for (const extra of [
      {},
      { PUBLISHER_KOL_API_KEY: "test-partial" },
      { ...loginEnv, PUBLISHER_KOL_PASSWORD: "replace-me" },
    ]) {
      const config = loadWorkerConfig({ ...workerEnv, ...extra }).publisher;
      expect(config.accessToken).toBe("test-supplied-token");
      expect(config.apiKey).toBeUndefined();
      expect(config.password).toBeUndefined();
    }
  });
  it("still requires complete account configuration without an explicit token", () => {
    expect(() =>
      loadWorkerConfig({ ...workerEnv, PUBLISHER_KOL_ACCESS_TOKEN: undefined }),
    ).toThrow("all six");
    expect(
      loadWorkerConfig({
        ...workerEnv,
        ...loginEnv,
        PUBLISHER_KOL_ACCESS_TOKEN: undefined,
      }).publisher,
    ).toMatchObject(credentials);
  });
});
