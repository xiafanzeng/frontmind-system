import { describe, expect, it } from "vitest";

import type {
  InsertWebsiteProjectOrder,
  WebsiteProjectOrder,
} from "../drizzle/schema";
import type {
  ProjectOrder,
  ProjectOrderWriteRequest,
} from "../shared/project-order-registry";
import {
  createProjectOrderRegistryService,
  type ProjectOrderRepository,
} from "./project-order-registry-service";

const NOW = new Date("2026-07-28T10:00:00.000Z");

function pendingOrder(patch: Partial<ProjectOrder> = {}): ProjectOrder {
  return {
    orderId: "order-20260728-0001",
    projectId: "project-20260728-0001",
    purchaseType: "monitoring",
    amountFen: 400,
    authorizationDigest: "a".repeat(64),
    state: "pending",
    checkoutExpiresAt: "2026-07-29T08:00:00.000Z",
    eventAt: "2026-07-28T08:00:00.000Z",
    ...patch,
  };
}

function request(order: ProjectOrder): ProjectOrderWriteRequest {
  return { schemaVersion: 1, order };
}

class MemoryProjectOrderRepository implements ProjectOrderRepository {
  readonly rows = new Map<string, WebsiteProjectOrder>();
  failReads = false;

  async findByOrderId(orderId: string) {
    if (this.failReads) throw new Error("database unavailable");
    return this.rows.get(orderId);
  }

  async findByAuthorizationDigest(digest: string) {
    if (this.failReads) throw new Error("database unavailable");
    return Array.from(this.rows.values()).find(
      (row) => row.authorizationDigest === digest,
    );
  }

  async listByProjectId(projectId: string) {
    if (this.failReads) throw new Error("database unavailable");
    return Array.from(this.rows.values()).filter(
      (row) => row.projectId === projectId,
    );
  }

  async insert(value: InsertWebsiteProjectOrder) {
    if (
      this.rows.has(value.orderId) ||
      Array.from(this.rows.values()).some(
        (row) => row.authorizationDigest === value.authorizationDigest,
      )
    ) {
      throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
    }
    const now = NOW;
    const row: WebsiteProjectOrder = {
      orderId: value.orderId,
      schemaVersion: value.schemaVersion ?? 1,
      projectId: value.projectId,
      purchaseType: value.purchaseType,
      amountFen: value.amountFen,
      authorizationDigest: value.authorizationDigest,
      state: value.state,
      checkoutExpiresAt: value.checkoutExpiresAt,
      paidAt: value.paidAt ?? null,
      fulfilledAt: value.fulfilledAt ?? null,
      lastEventAt: value.lastEventAt,
      revision: value.revision ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.orderId, row);
    return row;
  }

  async update(
    orderId: string,
    expectedRevision: number,
    value: {
      state: WebsiteProjectOrder["state"];
      paidAt: Date | null;
      fulfilledAt: Date | null;
      lastEventAt: Date;
    },
  ) {
    const current = this.rows.get(orderId);
    if (!current || current.revision !== expectedRevision) return undefined;
    const next: WebsiteProjectOrder = {
      ...current,
      ...value,
      revision: current.revision + 1,
      updatedAt: NOW,
    };
    this.rows.set(orderId, next);
    return next;
  }

  async commitIntent(
    intentOrderId: string,
    expectedRevision: number,
    order: InsertWebsiteProjectOrder,
    closedAt: Date,
  ) {
    const intent = this.rows.get(intentOrderId);
    if (
      !intent ||
      intent.state !== "pending" ||
      intent.revision !== expectedRevision
    ) {
      return undefined;
    }
    const stored = await this.insert(order);
    const closed: WebsiteProjectOrder = {
      ...intent,
      state: "closed",
      lastEventAt: closedAt,
      revision: intent.revision + 1,
      updatedAt: NOW,
    };
    this.rows.set(intentOrderId, closed);
    return { intent: closed, order: stored };
  }

  async ready() {
    if (this.failReads) throw new Error("database unavailable");
  }
}

function service(repository = new MemoryProjectOrderRepository()) {
  return {
    repository,
    registry: createProjectOrderRegistryService({
      repository,
      now: () => NOW,
    }),
  };
}

describe("durable website project-order registry", () => {
  it("registers a pending checkout and blocks project deletion", async () => {
    const { registry } = service();
    const created = await registry.record(request(pendingOrder()));

    expect(created.replayed).toBe(false);
    expect(created.response.order).toMatchObject({
      state: "pending",
      projectId: "project-20260728-0001",
    });
    await expect(
      registry.readProject("project-20260728-0001"),
    ).resolves.toMatchObject({
      blockDeletion: true,
      orders: [{ state: "pending" }],
    });
  });

  it("keeps a durable intent blocking until the real checkout is atomically committed", async () => {
    const { registry } = service();
    const intent = pendingOrder({
      orderId: "intent-20260728-0001",
      authorizationDigest: "f".repeat(64),
    });
    await registry.record(request(intent));
    await expect(registry.readProject(intent.projectId)).resolves.toMatchObject(
      { blockDeletion: true },
    );

    const committed = await registry.commitIntent(intent.orderId, {
      schemaVersion: 1,
      order: pendingOrder(),
    });
    expect(committed.replayed).toBe(false);
    expect(committed.response).toMatchObject({
      intent: { state: "closed" },
      order: { state: "pending" },
    });
    await expect(registry.readProject(intent.projectId)).resolves.toMatchObject(
      {
        blockDeletion: true,
        orders: expect.arrayContaining([
          expect.objectContaining({ state: "closed" }),
          expect.objectContaining({ state: "pending" }),
        ]),
      },
    );
  });

  it("advances payment and fulfillment monotonically without terminal rollback", async () => {
    const { registry } = service();
    await registry.record(request(pendingOrder()));
    await registry.record(
      request(
        pendingOrder({
          state: "paid",
          paidAt: "2026-07-28T08:05:00.000Z",
          eventAt: "2026-07-28T08:05:00.000Z",
        }),
      ),
    );
    await registry.record(
      request(
        pendingOrder({
          state: "fulfilling",
          paidAt: "2026-07-28T08:05:00.000Z",
          eventAt: "2026-07-28T08:06:00.000Z",
        }),
      ),
    );
    await registry.record(
      request(
        pendingOrder({
          state: "fulfilled",
          paidAt: "2026-07-28T08:05:00.000Z",
          fulfilledAt: "2026-07-28T08:20:00.000Z",
          eventAt: "2026-07-28T08:20:00.000Z",
        }),
      ),
    );

    await registry.record(
      request(
        pendingOrder({
          state: "paid",
          paidAt: "2026-07-28T08:05:00.000Z",
          eventAt: "2026-07-28T08:07:00.000Z",
        }),
      ),
    );
    await expect(
      registry.readProject("project-20260728-0001"),
    ).resolves.toMatchObject({
      blockDeletion: false,
      orders: [
        {
          state: "fulfilled",
          fulfilledAt: "2026-07-28T08:20:00.000Z",
        },
      ],
    });
  });

  it("treats an explicit non-retryable terminal failure as non-blocking", async () => {
    const { registry } = service();
    await registry.record(request(pendingOrder()));
    await registry.record(
      request(
        pendingOrder({
          state: "terminal_failed",
          paidAt: "2026-07-28T08:05:00.000Z",
          eventAt: "2026-07-28T08:10:00.000Z",
        }),
      ),
    );
    await registry.record(
      request(
        pendingOrder({
          state: "fulfilling",
          paidAt: "2026-07-28T08:05:00.000Z",
          eventAt: "2026-07-28T08:09:00.000Z",
        }),
      ),
    );

    await expect(
      registry.readProject("project-20260728-0001"),
    ).resolves.toMatchObject({
      blockDeletion: false,
      orders: [{ state: "terminal_failed" }],
    });
  });

  it("rejects order-scope and authorization uniqueness conflicts", async () => {
    const { registry } = service();
    await registry.record(request(pendingOrder()));

    await expect(
      registry.record(
        request(
          pendingOrder({
            projectId: "project-20260728-other",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "PROJECT_ORDER_CONFLICT", status: 409 });

    await expect(
      registry.record(
        request(
          pendingOrder({
            orderId: "order-20260728-0002",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "PROJECT_ORDER_CONFLICT", status: 409 });
  });

  it("fails closed when the project registry cannot be read", async () => {
    const { registry, repository } = service();
    repository.failReads = true;

    await expect(
      registry.readProject("project-20260728-0001"),
    ).rejects.toMatchObject({
      code: "PROJECT_ORDER_DATABASE_UNAVAILABLE",
      status: 503,
    });
    await expect(registry.ready()).rejects.toMatchObject({
      code: "PROJECT_ORDER_DATABASE_UNAVAILABLE",
      status: 503,
    });
  });
});
