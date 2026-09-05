import { describe, expect, it } from "vitest";

import type {
  InsertWebsiteProjectOrder,
  WebsiteProjectOrder,
} from "../drizzle/schema";
import {
  knowledgeImportReceipts,
  websiteManualServiceOrders,
  websiteProjectOrders,
  websiteUserProvisions,
} from "../drizzle/schema";
import type {
  ProjectOrder,
  ProjectOrderWriteRequest,
} from "../shared/project-order-registry";
import {
  createProjectOrderRegistryService,
  deleteWebsiteProjectBusinessRows,
  type ProjectOrderRepository,
} from "./project-order-registry-service";
import { WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED } from "./website-project-lifecycle";

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
  readonly deletedProjects = new Set<string>();
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

  async isProjectDeleted(projectId: string) {
    if (this.failReads) throw new Error("database unavailable");
    return this.deletedProjects.has(projectId);
  }

  async insert(value: InsertWebsiteProjectOrder) {
    if (this.deletedProjects.has(value.projectId)) {
      throw new Error("deleted project");
    }
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
    if (this.deletedProjects.has(order.projectId)) {
      throw new Error("deleted project");
    }
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

  async deleteByProjectId(projectId: string) {
    const replayed = this.deletedProjects.has(projectId);
    this.deletedProjects.add(projectId);
    let deletedOrders = 0;
    for (const [orderId, order] of this.rows) {
      if (order.projectId !== projectId) continue;
      this.rows.delete(orderId);
      deletedOrders += 1;
    }
    return { deletedOrders, replayed: replayed && deletedOrders === 0 };
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
  it.runIf(WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
    "physically removes only project-scoped business registries behind the delete fence",
    async () => {
      const deletedTables: unknown[] = [];
      const tx = {
        delete(table: unknown) {
          deletedTables.push(table);
          return {
            where: async () => [
              { affectedRows: table === websiteProjectOrders ? 2 : 1 },
            ],
          };
        },
      };

      await expect(
        deleteWebsiteProjectBusinessRows(tx, "project-20260728-0001"),
      ).resolves.toEqual([{ affectedRows: 2 }]);
      expect(deletedTables).toEqual([
        knowledgeImportReceipts,
        websiteManualServiceOrders,
        websiteUserProvisions,
        websiteProjectOrders,
      ]);
    },
  );

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

  it.runIf(WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
    "physically deletes every project order and makes retries idempotent",
    async () => {
      const { registry } = service();
      await registry.record(request(pendingOrder()));
      await registry.record(
        request(
          pendingOrder({
            orderId: "order-20260728-0002",
            authorizationDigest: "b".repeat(64),
          }),
        ),
      );
      await registry.record(
        request(
          pendingOrder({
            orderId: "order-20260728-other",
            projectId: "project-20260728-other",
            authorizationDigest: "c".repeat(64),
          }),
        ),
      );

      await expect(
        registry.deleteProject("project-20260728-0001"),
      ).resolves.toEqual({
        response: {
          schemaVersion: 1,
          projectId: "project-20260728-0001",
          deletedOrders: 2,
        },
        replayed: false,
      });
      await expect(
        registry.readProject("project-20260728-0001"),
      ).rejects.toMatchObject({
        code: "PROJECT_ORDER_PROJECT_DELETED",
        status: 410,
      });
      await expect(
        registry.readProject("project-20260728-other"),
      ).resolves.toMatchObject({
        orders: [{ orderId: "order-20260728-other" }],
      });
      await expect(
        registry.deleteProject("project-20260728-0001"),
      ).resolves.toEqual({
        response: {
          schemaVersion: 1,
          projectId: "project-20260728-0001",
          deletedOrders: 0,
        },
        replayed: true,
      });
      await expect(
        registry.record(
          request(
            pendingOrder({
              orderId: "order-20260728-late",
              authorizationDigest: "d".repeat(64),
            }),
          ),
        ),
      ).rejects.toMatchObject({
        code: "PROJECT_ORDER_PROJECT_DELETED",
        status: 410,
      });
    },
  );

  it.runIf(!WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
    "rejects physical deletion before the repository can mutate D0 state",
    async () => {
      const { registry, repository } = service();
      await expect(
        registry.deleteProject("project-20260728-0001"),
      ).rejects.toThrow("physical deletion is disabled");
      expect(repository.deletedProjects.size).toBe(0);
      expect(repository.rows.size).toBe(0);
    },
  );

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
