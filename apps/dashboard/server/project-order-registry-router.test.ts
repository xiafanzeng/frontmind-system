import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProvisioningRouter } from "./provisioning-router";
import { ProjectOrderRegistryError } from "./project-order-registry-service";
import { WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED } from "./website-project-lifecycle";

const SERVICE_TOKEN = "project-order-router-token-at-least-32-characters";
const servers: Server[] = [];

const order = {
  orderId: "order-20260728-0001",
  projectId: "project-20260728-0001",
  purchaseType: "monitoring" as const,
  amountFen: 400,
  authorizationDigest: "a".repeat(64),
  state: "pending" as const,
  checkoutExpiresAt: "2026-07-29T08:00:00.000Z",
  eventAt: "2026-07-28T08:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function startApp(projectOrders: any) {
  const app = express();
  app.use(
    "/api/internal/provisioning",
    createProvisioningRouter({
      env: {
        FRONTMIND_PROVISIONING_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      projectOrders,
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/internal/provisioning/project-orders`;
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    record: vi.fn(),
    commitIntent: vi.fn(),
    readProject: vi.fn(),
    deleteProject: vi.fn(),
    ready: vi.fn().mockResolvedValue({ schemaVersion: 1, ready: true }),
    ...overrides,
  };
}

describe("project-order registry internal routes", () => {
  it("authenticates before parsing or touching the registry", async () => {
    const projectOrders = service();
    const url = await startApp(projectOrders);
    const response = await fetch(`${url}/${order.orderId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-frontmind-provisioning-token": "wrong-token",
      },
      body: "{",
    });

    expect(response.status).toBe(401);
    expect(projectOrders.record).not.toHaveBeenCalled();
    expect(projectOrders.readProject).not.toHaveBeenCalled();
  });

  it("records an order idempotently and requires the path binding", async () => {
    const responseBody = { schemaVersion: 1 as const, order };
    const projectOrders = service({
      record: vi
        .fn()
        .mockResolvedValueOnce({ response: responseBody, replayed: false })
        .mockResolvedValueOnce({ response: responseBody, replayed: true }),
    });
    const url = await startApp(projectOrders);
    const init = {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify({ schemaVersion: 1, order }),
    };

    const created = await fetch(`${url}/${order.orderId}`, init);
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual(responseBody);

    const replay = await fetch(`${url}/${order.orderId}`, init);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    const mismatch = await fetch(`${url}/order-20260728-other`, init);
    expect(mismatch.status).toBe(400);
    expect(projectOrders.record).toHaveBeenCalledTimes(2);
  });

  it("returns the project-wide durable deletion decision", async () => {
    const responseBody = {
      schemaVersion: 1 as const,
      projectId: order.projectId,
      blockDeletion: true,
      orders: [order],
    };
    const projectOrders = service({
      readProject: vi.fn().mockResolvedValue(responseBody),
    });
    const url = await startApp(projectOrders);
    const response = await fetch(`${url}/projects/${order.projectId}`, {
      headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(projectOrders.readProject).toHaveBeenCalledWith(order.projectId);
  });

  it.runIf(WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
    "physically deletes project orders behind the service-token boundary",
    async () => {
      const projectOrders = service({
        deleteProject: vi
          .fn()
          .mockResolvedValueOnce({
            response: {
              schemaVersion: 1,
              projectId: order.projectId,
              deletedOrders: 2,
            },
            replayed: false,
          })
          .mockResolvedValueOnce({
            response: {
              schemaVersion: 1,
              projectId: order.projectId,
              deletedOrders: 0,
            },
            replayed: true,
          }),
      });
      const url = await startApp(projectOrders);
      const endpoint = `${url}/projects/${order.projectId}`;

      const unauthorized = await fetch(endpoint, { method: "DELETE" });
      expect(unauthorized.status).toBe(401);
      expect(projectOrders.deleteProject).not.toHaveBeenCalled();

      const deleted = await fetch(endpoint, {
        method: "DELETE",
        headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
      });
      expect(deleted.status).toBe(200);
      await expect(deleted.json()).resolves.toEqual({
        schemaVersion: 1,
        projectId: order.projectId,
        deletedOrders: 2,
      });
      expect(deleted.headers.get("idempotent-replayed")).toBeNull();

      const replay = await fetch(endpoint, {
        method: "DELETE",
        headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
      });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual({
        schemaVersion: 1,
        projectId: order.projectId,
        deletedOrders: 0,
      });
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(projectOrders.deleteProject).toHaveBeenNthCalledWith(
        1,
        order.projectId,
      );
    },
  );

  it.runIf(!WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
    "rejects project deletion before invoking the registry in D0",
    async () => {
      const projectOrders = service();
      const url = await startApp(projectOrders);
      const response = await fetch(`${url}/projects/${order.projectId}`, {
        method: "DELETE",
        headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "PROJECT_DELETE_DISABLED" },
      });
      expect(projectOrders.deleteProject).not.toHaveBeenCalled();
    },
  );

  it("commits a durable checkout intent before returning the real order", async () => {
    const intent = {
      ...order,
      orderId: "intent-20260728-0001",
      authorizationDigest: "f".repeat(64),
      state: "closed" as const,
    };
    const responseBody = {
      schemaVersion: 1 as const,
      intent,
      order,
    };
    const projectOrders = service({
      commitIntent: vi
        .fn()
        .mockResolvedValue({ response: responseBody, replayed: false }),
    });
    const url = await startApp(projectOrders);
    const baseUrl = url.replace(/\/project-orders$/, "");
    const response = await fetch(
      `${baseUrl}/project-order-intents/${intent.orderId}/commit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
        body: JSON.stringify({ schemaVersion: 1, order }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(projectOrders.commitIntent).toHaveBeenCalledWith(intent.orderId, {
      schemaVersion: 1,
      order,
    });
  });

  it("exposes a real authenticated registry readiness gate", async () => {
    const projectOrders = service();
    const url = await startApp(projectOrders);
    const ready = await fetch(`${url}/ready`, {
      headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
    });

    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      schemaVersion: 1,
      ready: true,
    });
    expect(projectOrders.ready).toHaveBeenCalledTimes(1);
  });

  it("preserves stable registry errors for fail-closed callers", async () => {
    const projectOrders = service({
      readProject: vi
        .fn()
        .mockRejectedValue(
          new ProjectOrderRegistryError(
            "PROJECT_ORDER_DATABASE_UNAVAILABLE",
            "The project order registry is unavailable",
            503,
          ),
        ),
    });
    const url = await startApp(projectOrders);
    const response = await fetch(`${url}/projects/${order.projectId}`, {
      headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PROJECT_ORDER_DATABASE_UNAVAILABLE",
        message: "The project order registry is unavailable",
      },
    });
  });
});
