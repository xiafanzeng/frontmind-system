import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  start: vi.fn(),
  send: vi.fn(),
  assertCapability: vi.fn(),
}));

vi.mock("./jenova-brand-tracking-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./jenova-brand-tracking-service")>();
  return {
    ...actual,
    startJenovaBrandTrackingSession: serviceMocks.start,
    sendJenovaBrandTrackingMessage: serviceMocks.send,
  };
});
vi.mock("./service-entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-entitlement")>();
  return {
    ...actual,
    assertServiceCapability: serviceMocks.assertCapability,
  };
});

import brandTrackingApi from "./brand-tracking-api";
import type { AuthenticatedUser } from "./auth-service";
import { JenovaBrandTrackingError } from "./jenova-brand-tracking-service";

const privateProvider = ["Jeno", "va"].join("");
const alternatePrivateProvider = ["Ma", "nus"].join("");

let server: Server | null = null;

beforeEach(() => {
  serviceMocks.assertCapability.mockResolvedValue({});
});

afterEach(async () => {
  serviceMocks.start.mockReset();
  serviceMocks.send.mockReset();
  serviceMocks.assertCapability.mockReset();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function appUrl(authenticated = true) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  if (authenticated) {
    app.use((req, _res, next) => {
      (req as typeof req & { frontmindUser: AuthenticatedUser }).frontmindUser =
        {
          id: 7,
          openId: null,
          username: "overseas-user",
          displayName: "海外客户",
          name: "海外客户",
          email: null,
          loginMethod: "password",
          role: "user",
          marketEdition: "overseas",
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSignedIn: null,
        };
      next();
    });
  }
  app.use("/api/brand-tracking", brandTrackingApi);
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return `http://127.0.0.1:${address.port}`;
}

function paidPostHeaders(baseUrl: string) {
  return {
    "content-type": "application/json",
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
  };
}

describe("Jenova brand tracking SSE API", () => {
  it("rejects direct session creation when the plan does not include brand tracking", async () => {
    const { ServiceEntitlementError } = await import("./service-entitlement");
    serviceMocks.assertCapability.mockRejectedValueOnce(
      new ServiceEntitlementError(
        "CAPABILITY_UPGRADE_REQUIRED",
        "当前版本不包含此能力，可升级进阶版或豪华版解锁。",
        403,
      ),
    );
    const baseUrl = await appUrl();
    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: paidPostHeaders(baseUrl),
      body: JSON.stringify({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CAPABILITY_UPGRADE_REQUIRED" },
    });
    expect(serviceMocks.assertCapability).toHaveBeenCalledWith(
      7,
      "brandTracking",
    );
    expect(serviceMocks.start).not.toHaveBeenCalled();
  });

  it("relays the normalized session/delta/progress/usage/end contract", async () => {
    serviceMocks.start.mockImplementation(async ({ emit }) => {
      await emit({
        event: "session",
        data: {
          sessionId: "session-1",
          title: "品牌追踪会话",
          status: "active",
          messageId: "turn-1:assistant",
        },
      });
      await emit({
        event: "delta",
        data: {
          messageId: "turn-1:assistant",
          text: "第一步",
          content: "第一步",
        },
      });
      await emit({
        event: "progress",
        data: { messageId: "turn-1:assistant", message: "检索中" },
      });
      await emit({
        event: "usage",
        data: {
          messageId: "turn-1:assistant",
          cost: "0.13500000",
          usageCost: "0.12500000",
          sessionFee: "0.01000000",
          totalCost: "0.13500000",
        },
      });
      await emit({
        event: "end",
        data: {
          sessionId: "session-1",
          messageId: "turn-1:assistant",
          status: "completed",
        },
      });
    });
    const baseUrl = await appUrl();
    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: paidPostHeaders(baseUrl),
      body: JSON.stringify({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    for (const expected of [
      "event: session",
      "event: delta",
      '"text":"第一步"',
      '"message":"检索中"',
      '"cost":"0.13500000"',
      "event: end",
    ]) {
      expect(body).toContain(expected);
    }
    expect(serviceMocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("projects every customer SSE payload through the neutral brand boundary", async () => {
    serviceMocks.start.mockImplementation(async ({ emit }) => {
      await emit({
        event: "delta",
        data: {
          messageId: "turn-1:assistant",
          text: `${privateProvider} 已启动`,
          content: `${privateProvider} 已启动`,
          file_url: "https://provider.example/file/1",
        },
      });
      await emit({
        event: "progress",
        data: {
          messageId: "turn-1:assistant",
          message: `${alternatePrivateProvider}_V2 正在处理`,
          imageUrl: "https://provider.example/image/1",
        },
      });
      await emit({
        event: "warning",
        data: {
          messageId: "turn-1:assistant",
          code: `${privateProvider.toUpperCase()}_SOURCE_WARNING`,
          message: `${privateProvider} 返回警告`,
        },
      });
      await emit({
        event: "error",
        data: {
          code: `${alternatePrivateProvider.toUpperCase()}_V2_REJECTED`,
          message: `${alternatePrivateProvider} 拒绝了请求`,
          recoverable: false,
        },
      });
    });
    const baseUrl = await appUrl();
    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: paidPostHeaders(baseUrl),
      body: JSON.stringify({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("FrontMind 已启动");
    expect(body).toContain("FrontMind 正在处理");
    expect(body).toContain('"code":null');
    expect(body).toContain('"code":"UPSTREAM_UNAVAILABLE"');
    expect(body).not.toContain("file_url");
    expect(body).not.toContain("imageUrl");
    expect(body).not.toMatch(
      new RegExp(`${privateProvider}|${alternatePrivateProvider}`, "iu"),
    );
  });

  it("requires authenticated middleware state", async () => {
    const baseUrl = await appUrl(false);
    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: paidPostHeaders(baseUrl),
      body: JSON.stringify({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    expect(response.status).toBe(401);
    expect(serviceMocks.start).not.toHaveBeenCalled();
  });

  it("ignores forged kickoff fields and forwards only the request identity", async () => {
    serviceMocks.start.mockImplementation(async ({ emit }) => {
      await emit({
        event: "end",
        data: {
          sessionId: "session-authoritative",
          messageId: "turn-authoritative:assistant",
          status: "completed",
        },
      });
    });
    const baseUrl = await appUrl();
    const clientRequestId = "55555555-5555-4555-8555-555555555555";
    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: paidPostHeaders(baseUrl),
      body: JSON.stringify({
        clientRequestId,
        brandName: "伪造品牌",
        variants: "伪造变体",
        platforms: ["fake"],
        timeRange: "过去30天",
        hiddenKickoff: "伪造提示",
      }),
    });

    expect(response.status).toBe(200);
    expect(serviceMocks.start).toHaveBeenCalledTimes(1);
    const call = serviceMocks.start.mock.calls[0]?.[0];
    expect(call).toMatchObject({ clientRequestId });
    expect(call).not.toHaveProperty("brandName");
    expect(call).not.toHaveProperty("variants");
    expect(call).not.toHaveProperty("platforms");
    expect(call).not.toHaveProperty("timeRange");
    expect(call).not.toHaveProperty("hiddenKickoff");
  });

  it("rejects a cross-site JSON request before starting a paid run", async () => {
    const baseUrl = await appUrl();
    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CROSS_SITE_REQUEST_FORBIDDEN",
        message: "品牌追踪请求必须来自当前站点",
      },
    });
    expect(serviceMocks.start).not.toHaveBeenCalled();
  });

  it("rejects form posts even when their Origin is same-site", async () => {
    const baseUrl = await appUrl();
    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      }),
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "品牌追踪请求必须使用 JSON",
      },
    });
    expect(serviceMocks.start).not.toHaveBeenCalled();
  });

  it("forwards continuation session, content, and request identifiers", async () => {
    serviceMocks.send.mockImplementation(async ({ emit, sessionId }) => {
      await emit({
        event: "end",
        data: {
          sessionId,
          messageId: "turn-2:assistant",
          status: "completed",
        },
      });
    });
    const baseUrl = await appUrl();
    const clientRequestId = "22222222-2222-4222-8222-222222222222";

    const response = await fetch(
      `${baseUrl}/api/brand-tracking/sessions/session%20alpha/messages`,
      {
        method: "POST",
        headers: paidPostHeaders(baseUrl),
        body: JSON.stringify({
          content: "请继续分析海外社交媒体。",
          clientRequestId,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: end");
    expect(serviceMocks.send).toHaveBeenCalledTimes(1);
    expect(serviceMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session alpha",
        content: "请继续分析海外社交媒体。",
        clientRequestId,
        actor: expect.objectContaining({ id: 7, marketEdition: "overseas" }),
        emit: expect.any(Function),
      }),
    );
  });

  it("maps a pre-stream service error to JSON status and Retry-After", async () => {
    serviceMocks.start.mockRejectedValue(
      new JenovaBrandTrackingError(
        "UPSTREAM_UNAVAILABLE",
        "Jenova 正在限流，请稍后重试",
        429,
        2_501,
      ),
    );
    const baseUrl = await appUrl();

    const response = await fetch(`${baseUrl}/api/brand-tracking/sessions`, {
      method: "POST",
      headers: paidPostHeaders(baseUrl),
      body: JSON.stringify({
        clientRequestId: "33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("retry-after")).toBe("3");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "FrontMind 正在限流，请稍后重试",
      },
    });
  });

  it("continues the service once after a client disconnects from the stream", async () => {
    let releaseService!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    let serviceFinished = false;
    serviceMocks.start.mockImplementation(async ({ emit }) => {
      await emit({
        event: "session",
        data: {
          sessionId: "session-disconnect",
          title: "品牌追踪会话",
          status: "active",
          messageId: "turn-disconnect:assistant",
        },
      });
      await mayFinish;
      await emit({
        event: "end",
        data: {
          sessionId: "session-disconnect",
          messageId: "turn-disconnect:assistant",
          status: "completed",
        },
      });
      serviceFinished = true;
    });
    const baseUrl = await appUrl();
    const url = new URL(`${baseUrl}/api/brand-tracking/sessions`);

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: paidPostHeaders(baseUrl),
        },
        (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        },
      );
      request.once("error", reject);
      request.end(
        JSON.stringify({
          clientRequestId: "44444444-4444-4444-8444-444444444444",
        }),
      );
    });

    releaseService();
    await vi.waitFor(() => expect(serviceFinished).toBe(true));
    expect(serviceMocks.start).toHaveBeenCalledTimes(1);
    expect(serviceMocks.send).not.toHaveBeenCalled();
  });
});
