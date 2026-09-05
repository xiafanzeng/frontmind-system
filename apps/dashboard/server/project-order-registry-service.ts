import { and, eq, sql } from "drizzle-orm";

import {
  knowledgeImportReceipts,
  websiteManualServiceOrders,
  websiteProjectDeletionTombstones,
  websiteProjectOrders,
  websiteUserProvisions,
  type InsertWebsiteProjectOrder,
  type WebsiteProjectOrder,
} from "../drizzle/schema";
import {
  projectOrderIntentCommitRequestSchema,
  projectOrderIntentCommitResponseSchema,
  projectOrderProjectDeleteResponseSchema,
  projectOrderProjectResponseSchema,
  projectOrderResponseSchema,
  projectOrderWriteRequestSchema,
  type ProjectOrder,
  type ProjectOrderIntentCommitRequest,
  type ProjectOrderIntentCommitResponse,
  type ProjectOrderProjectDeleteResponse,
  type ProjectOrderProjectResponse,
  type ProjectOrderResponse,
  type ProjectOrderState,
  type ProjectOrderWriteRequest,
} from "../shared/project-order-registry";
import { getDb } from "./db";
import {
  assertWebsiteProjectPhysicalDeleteEnabled,
  lockActiveWebsiteProjectLifecycle,
  WebsiteProjectInactiveError,
} from "./website-project-lifecycle";

const EARLIEST_SUPPORTED_ORDER_MS = Date.parse("2020-01-01T00:00:00.000Z");
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_PROJECT_ORDERS = 100;

export type ProjectOrderRegistryErrorCode =
  | "PROJECT_ORDER_CONFLICT"
  | "PROJECT_ORDER_PROJECT_DELETED"
  | "PROJECT_ORDER_TIMESTAMP_INVALID"
  | "PROJECT_ORDER_LIMIT_EXCEEDED"
  | "PROJECT_ORDER_DATABASE_UNAVAILABLE";

export class ProjectOrderRegistryError extends Error {
  constructor(
    public readonly code: ProjectOrderRegistryErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ProjectOrderRegistryError";
  }
}

export interface ProjectOrderRepository {
  findByOrderId(orderId: string): Promise<WebsiteProjectOrder | undefined>;
  findByAuthorizationDigest(
    digest: string,
  ): Promise<WebsiteProjectOrder | undefined>;
  listByProjectId(projectId: string): Promise<WebsiteProjectOrder[]>;
  isProjectDeleted(projectId: string): Promise<boolean>;
  insert(value: InsertWebsiteProjectOrder): Promise<WebsiteProjectOrder>;
  update(
    orderId: string,
    expectedRevision: number,
    value: {
      state: ProjectOrderState;
      paidAt: Date | null;
      fulfilledAt: Date | null;
      lastEventAt: Date;
    },
  ): Promise<WebsiteProjectOrder | undefined>;
  commitIntent(
    intentOrderId: string,
    expectedRevision: number,
    order: InsertWebsiteProjectOrder,
    closedAt: Date,
  ): Promise<
    { intent: WebsiteProjectOrder; order: WebsiteProjectOrder } | undefined
  >;
  deleteByProjectId(projectId: string): Promise<{
    deletedOrders: number;
    replayed: boolean;
  }>;
  ready(): Promise<void>;
}

export type ProjectOrderRegistryService = {
  record(input: ProjectOrderWriteRequest): Promise<{
    response: ProjectOrderResponse;
    replayed: boolean;
  }>;
  readProject(projectId: string): Promise<ProjectOrderProjectResponse>;
  deleteProject(projectId: string): Promise<{
    response: ProjectOrderProjectDeleteResponse;
    replayed: boolean;
  }>;
  commitIntent(
    intentOrderId: string,
    input: ProjectOrderIntentCommitRequest,
  ): Promise<{
    response: ProjectOrderIntentCommitResponse;
    replayed: boolean;
  }>;
  ready(): Promise<{ schemaVersion: 1; ready: true }>;
};

type ProjectOrderRegistryServiceOptions = {
  repository?: ProjectOrderRepository;
  now?: () => Date;
};

function databaseUnavailable(_error?: unknown): never {
  throw new ProjectOrderRegistryError(
    "PROJECT_ORDER_DATABASE_UNAVAILABLE",
    "The project order registry is unavailable",
    503,
  );
}

function conflict(message: string): never {
  throw new ProjectOrderRegistryError("PROJECT_ORDER_CONFLICT", message, 409);
}

function projectDeleted(): never {
  throw new ProjectOrderRegistryError(
    "PROJECT_ORDER_PROJECT_DELETED",
    "The project has been permanently deleted",
    410,
  );
}

function mapInactiveProject(error: unknown): never {
  if (error instanceof WebsiteProjectInactiveError) projectDeleted();
  throw error;
}

function isDuplicateEntry(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "ER_DUP_ENTRY";
}

function publicOrder(row: WebsiteProjectOrder): ProjectOrder {
  return {
    orderId: row.orderId,
    projectId: row.projectId,
    purchaseType: row.purchaseType,
    amountFen: row.amountFen,
    authorizationDigest: row.authorizationDigest,
    state: row.state,
    checkoutExpiresAt: row.checkoutExpiresAt.toISOString(),
    eventAt: row.lastEventAt.toISOString(),
    ...(row.paidAt ? { paidAt: row.paidAt.toISOString() } : {}),
    ...(row.fulfilledAt ? { fulfilledAt: row.fulfilledAt.toISOString() } : {}),
  };
}

function orderResponse(row: WebsiteProjectOrder) {
  return projectOrderResponseSchema.parse({
    schemaVersion: 1,
    order: publicOrder(row),
  });
}

function intentCommitResponse(
  intent: WebsiteProjectOrder,
  order: WebsiteProjectOrder,
) {
  return projectOrderIntentCommitResponseSchema.parse({
    schemaVersion: 1,
    intent: publicOrder(intent),
    order: publicOrder(order),
  });
}

function sameImmutableOrder(row: WebsiteProjectOrder, value: ProjectOrder) {
  return (
    row.schemaVersion === 1 &&
    row.orderId === value.orderId &&
    row.projectId === value.projectId &&
    row.purchaseType === value.purchaseType &&
    row.amountFen === value.amountFen &&
    row.authorizationDigest === value.authorizationDigest &&
    row.checkoutExpiresAt.getTime() === Date.parse(value.checkoutExpiresAt)
  );
}

function mergeState(
  current: ProjectOrderState,
  incoming: ProjectOrderState,
): ProjectOrderState {
  if (
    current === "fulfilled" ||
    current === "terminal_failed" ||
    current === "closed"
  )
    return current;
  if (
    incoming === "fulfilled" ||
    incoming === "terminal_failed" ||
    incoming === "closed"
  )
    return incoming;
  if (incoming === "review_required") return "review_required";
  if (current === "review_required") {
    return incoming === "fulfilling" ? "fulfilling" : current;
  }
  const rank: Record<ProjectOrderState, number> = {
    pending: 0,
    paid: 1,
    fulfilling: 2,
    review_required: 2,
    fulfilled: 3,
    terminal_failed: 3,
    closed: 3,
  };
  return rank[incoming] > rank[current] ? incoming : current;
}

function sameMutableOrder(row: WebsiteProjectOrder, value: ProjectOrder) {
  return (
    row.state === value.state &&
    row.lastEventAt.getTime() === Date.parse(value.eventAt) &&
    (row.paidAt?.getTime() ?? null) ===
      (value.paidAt ? Date.parse(value.paidAt) : null) &&
    (row.fulfilledAt?.getTime() ?? null) ===
      (value.fulfilledAt ? Date.parse(value.fulfilledAt) : null)
  );
}

function assertEventTimestamp(value: string, now: Date) {
  const eventAt = Date.parse(value);
  if (
    eventAt < EARLIEST_SUPPORTED_ORDER_MS ||
    eventAt > now.getTime() + MAX_CLOCK_SKEW_MS
  ) {
    throw new ProjectOrderRegistryError(
      "PROJECT_ORDER_TIMESTAMP_INVALID",
      "eventAt is outside the supported order window",
      400,
    );
  }
  return eventAt;
}

/**
 * Deletes project-scoped Website fulfillment registries after the lifecycle
 * row is locked in deleting state. Independent users, signed contract files,
 * service contracts and immutable payment receipts intentionally live in
 * other tables and are not removed here.
 */
export async function deleteWebsiteProjectBusinessRows(
  tx: any,
  projectId: string,
) {
  assertWebsiteProjectPhysicalDeleteEnabled();
  await tx
    .delete(knowledgeImportReceipts)
    .where(eq(knowledgeImportReceipts.projectId, projectId));
  await tx
    .delete(websiteManualServiceOrders)
    .where(eq(websiteManualServiceOrders.projectId, projectId));
  await tx
    .delete(websiteUserProvisions)
    .where(eq(websiteUserProvisions.projectId, projectId));
  return tx
    .delete(websiteProjectOrders)
    .where(eq(websiteProjectOrders.projectId, projectId));
}

async function defaultRepository(): Promise<ProjectOrderRepository> {
  const db = await getDb();
  if (!db) databaseUnavailable();

  const findByOrderId = async (orderId: string) => {
    const rows = await db
      .select()
      .from(websiteProjectOrders)
      .where(eq(websiteProjectOrders.orderId, orderId))
      .limit(1);
    return rows[0];
  };

  return {
    findByOrderId,
    async findByAuthorizationDigest(digest) {
      const rows = await db
        .select()
        .from(websiteProjectOrders)
        .where(eq(websiteProjectOrders.authorizationDigest, digest))
        .limit(1);
      return rows[0];
    },
    async listByProjectId(projectId) {
      return db
        .select()
        .from(websiteProjectOrders)
        .where(eq(websiteProjectOrders.projectId, projectId))
        .limit(MAX_PROJECT_ORDERS + 1);
    },
    async isProjectDeleted(projectId) {
      const rows = await db
        .select({ status: websiteProjectDeletionTombstones.status })
        .from(websiteProjectDeletionTombstones)
        .where(eq(websiteProjectDeletionTombstones.projectId, projectId))
        .limit(1);
      return Boolean(rows[0] && rows[0].status !== "active");
    },
    async insert(value) {
      return db.transaction(async (tx) => {
        await lockActiveWebsiteProjectLifecycle(tx, value.projectId);
        await tx.insert(websiteProjectOrders).values(value);
        const rows = await tx
          .select()
          .from(websiteProjectOrders)
          .where(eq(websiteProjectOrders.orderId, value.orderId))
          .limit(1);
        if (!rows[0]) databaseUnavailable();
        return rows[0];
      });
    },
    async update(orderId, expectedRevision, value) {
      return db.transaction(async (tx) => {
        const current = await tx
          .select({ projectId: websiteProjectOrders.projectId })
          .from(websiteProjectOrders)
          .where(eq(websiteProjectOrders.orderId, orderId))
          .limit(1);
        if (!current[0]) return undefined;
        await lockActiveWebsiteProjectLifecycle(tx, current[0].projectId);
        const result = await tx
          .update(websiteProjectOrders)
          .set({
            ...value,
            revision: sql`${websiteProjectOrders.revision} + 1`,
          })
          .where(
            and(
              eq(websiteProjectOrders.orderId, orderId),
              eq(websiteProjectOrders.revision, expectedRevision),
            ),
          );
        if (!result[0]?.affectedRows) return undefined;
        const rows = await tx
          .select()
          .from(websiteProjectOrders)
          .where(eq(websiteProjectOrders.orderId, orderId))
          .limit(1);
        return rows[0];
      });
    },
    async commitIntent(intentOrderId, expectedRevision, order, closedAt) {
      return db.transaction(async (tx) => {
        await lockActiveWebsiteProjectLifecycle(tx, order.projectId);
        await tx.insert(websiteProjectOrders).values(order);
        const result = await tx
          .update(websiteProjectOrders)
          .set({
            state: "closed",
            lastEventAt: closedAt,
            revision: sql`${websiteProjectOrders.revision} + 1`,
          })
          .where(
            and(
              eq(websiteProjectOrders.orderId, intentOrderId),
              eq(websiteProjectOrders.revision, expectedRevision),
              eq(websiteProjectOrders.state, "pending"),
            ),
          );
        if (!result[0]?.affectedRows) {
          throw Object.assign(new Error("project order intent changed"), {
            code: "PROJECT_ORDER_COMMIT_RACE",
          });
        }
        const [intents, orders] = await Promise.all([
          tx
            .select()
            .from(websiteProjectOrders)
            .where(eq(websiteProjectOrders.orderId, intentOrderId))
            .limit(1),
          tx
            .select()
            .from(websiteProjectOrders)
            .where(eq(websiteProjectOrders.orderId, order.orderId))
            .limit(1),
        ]);
        if (!intents[0] || !orders[0]) databaseUnavailable();
        return { intent: intents[0], order: orders[0] };
      });
    },
    async deleteByProjectId(projectId) {
      assertWebsiteProjectPhysicalDeleteEnabled();
      return db.transaction(async (tx) => {
        await tx
          .insert(websiteProjectDeletionTombstones)
          .values({
            projectId,
            schemaVersion: 1,
            status: "deleting",
            deletionRequestedAt: new Date(),
          })
          .onDuplicateKeyUpdate({
            set: { projectId },
          });
        const tombstones = await tx
          .select({ status: websiteProjectDeletionTombstones.status })
          .from(websiteProjectDeletionTombstones)
          .where(eq(websiteProjectDeletionTombstones.projectId, projectId))
          .limit(1)
          .for("update");
        if (!tombstones[0]) databaseUnavailable();
        if (tombstones[0].status === "active") {
          await tx
            .update(websiteProjectDeletionTombstones)
            .set({
              status: "deleting",
              deletionRequestedAt: new Date(),
              completedAt: null,
            })
            .where(eq(websiteProjectDeletionTombstones.projectId, projectId));
        }
        const result = await deleteWebsiteProjectBusinessRows(tx, projectId);
        const deletedOrders = Number(result[0]?.affectedRows ?? 0);
        return {
          deletedOrders,
          replayed: tombstones[0].status !== "active" && deletedOrders === 0,
        };
      });
    },
    async ready() {
      await Promise.all([
        db
          .select({ schemaVersion: websiteProjectOrders.schemaVersion })
          .from(websiteProjectOrders)
          .limit(1),
        db
          .select({
            schemaVersion: websiteProjectDeletionTombstones.schemaVersion,
          })
          .from(websiteProjectDeletionTombstones)
          .limit(1),
      ]);
    },
  };
}

export function createProjectOrderRegistryService(
  options: ProjectOrderRegistryServiceOptions = {},
): ProjectOrderRegistryService {
  const repository = async () => options.repository ?? defaultRepository();
  const now = options.now ?? (() => new Date());

  return {
    async record(input) {
      const { order } = projectOrderWriteRequestSchema.parse(input);
      const eventAt = assertEventTimestamp(order.eventAt, now());

      try {
        const store = await repository();
        if (await store.isProjectDeleted(order.projectId)) projectDeleted();
        let existing = await store.findByOrderId(order.orderId);
        if (!existing) {
          const existingAuthorization = await store.findByAuthorizationDigest(
            order.authorizationDigest,
          );
          if (existingAuthorization) {
            conflict(
              "The payment authorization is already bound to another order",
            );
          }
          try {
            const stored = await store.insert({
              orderId: order.orderId,
              schemaVersion: 1,
              projectId: order.projectId,
              purchaseType: order.purchaseType,
              amountFen: order.amountFen,
              authorizationDigest: order.authorizationDigest,
              state: order.state,
              checkoutExpiresAt: new Date(order.checkoutExpiresAt),
              paidAt: order.paidAt ? new Date(order.paidAt) : null,
              fulfilledAt: order.fulfilledAt
                ? new Date(order.fulfilledAt)
                : null,
              lastEventAt: new Date(order.eventAt),
              revision: 1,
            });
            return { response: orderResponse(stored), replayed: false };
          } catch (error) {
            if (!isDuplicateEntry(error)) throw error;
            existing = await store.findByOrderId(order.orderId);
            if (!existing) {
              conflict(
                "The order or payment authorization is already registered",
              );
            }
          }
        }

        if (!sameImmutableOrder(existing, order)) {
          conflict("The order is already bound to a different project scope");
        }
        if (
          existing.paidAt &&
          order.paidAt &&
          existing.paidAt.getTime() !== Date.parse(order.paidAt)
        ) {
          conflict("paidAt conflicts with the registered payment fact");
        }
        if (
          existing.fulfilledAt &&
          order.fulfilledAt &&
          existing.fulfilledAt.getTime() !== Date.parse(order.fulfilledAt)
        ) {
          conflict("fulfilledAt conflicts with the registered delivery fact");
        }
        if (sameMutableOrder(existing, order)) {
          return { response: orderResponse(existing), replayed: true };
        }

        for (let attempt = 0; attempt < 4; attempt += 1) {
          const nextState = mergeState(existing.state, order.state);
          const paidAt =
            existing.paidAt ?? (order.paidAt ? new Date(order.paidAt) : null);
          const fulfilledAt =
            existing.fulfilledAt ??
            (nextState === "fulfilled" && order.fulfilledAt
              ? new Date(order.fulfilledAt)
              : null);
          const lastEventAt = new Date(
            Math.max(existing.lastEventAt.getTime(), eventAt),
          );
          const updated = await store.update(
            existing.orderId,
            existing.revision,
            {
              state: nextState,
              paidAt,
              fulfilledAt,
              lastEventAt,
            },
          );
          if (updated) {
            return { response: orderResponse(updated), replayed: false };
          }
          const raced = await store.findByOrderId(existing.orderId);
          if (!raced) {
            if (await store.isProjectDeleted(order.projectId)) {
              projectDeleted();
            }
            databaseUnavailable();
          }
          existing = raced;
          if (!sameImmutableOrder(existing, order)) {
            conflict("The order changed to a different project scope");
          }
          if (
            ["fulfilled", "terminal_failed", "closed"].includes(
              existing.state,
            ) ||
            sameMutableOrder(existing, order)
          ) {
            return { response: orderResponse(existing), replayed: true };
          }
        }
        databaseUnavailable();
      } catch (error) {
        mapInactiveProject(error);
        if (error instanceof ProjectOrderRegistryError) throw error;
        databaseUnavailable(error);
      }
    },

    async readProject(projectId) {
      try {
        const store = await repository();
        if (await store.isProjectDeleted(projectId)) projectDeleted();
        const rows = await store.listByProjectId(projectId);
        if (rows.length > MAX_PROJECT_ORDERS) {
          throw new ProjectOrderRegistryError(
            "PROJECT_ORDER_LIMIT_EXCEEDED",
            "The project has too many registered orders for an automatic deletion decision",
            409,
          );
        }
        return projectOrderProjectResponseSchema.parse({
          schemaVersion: 1,
          projectId,
          blockDeletion: rows.some(
            (row) =>
              !["fulfilled", "terminal_failed", "closed"].includes(row.state),
          ),
          orders: rows.map(publicOrder),
        });
      } catch (error) {
        if (error instanceof ProjectOrderRegistryError) throw error;
        databaseUnavailable(error);
      }
    },

    async deleteProject(projectId) {
      assertWebsiteProjectPhysicalDeleteEnabled();
      try {
        const result = await (await repository()).deleteByProjectId(projectId);
        return {
          response: projectOrderProjectDeleteResponseSchema.parse({
            schemaVersion: 1,
            projectId,
            deletedOrders: result.deletedOrders,
          }),
          replayed: result.replayed,
        };
      } catch (error) {
        mapInactiveProject(error);
        if (error instanceof ProjectOrderRegistryError) throw error;
        databaseUnavailable(error);
      }
    },

    async commitIntent(intentOrderId, input) {
      const { order } = projectOrderIntentCommitRequestSchema.parse(input);
      assertEventTimestamp(order.eventAt, now());
      if (intentOrderId === order.orderId) {
        conflict("The checkout order must differ from its reservation intent");
      }

      try {
        const store = await repository();
        if (await store.isProjectDeleted(order.projectId)) projectDeleted();
        let intent = await store.findByOrderId(intentOrderId);
        if (!intent) {
          if (await store.isProjectDeleted(order.projectId)) projectDeleted();
          conflict("The checkout reservation intent does not exist");
        }
        if (
          intent.projectId !== order.projectId ||
          intent.purchaseType !== order.purchaseType ||
          intent.amountFen !== order.amountFen
        ) {
          conflict("The checkout does not match its reservation intent");
        }

        let existingOrder = await store.findByOrderId(order.orderId);
        if (existingOrder) {
          if (!sameImmutableOrder(existingOrder, order)) {
            conflict("The checkout order is bound to a different project");
          }
          if (intent.state === "pending") {
            const closed = await store.update(intent.orderId, intent.revision, {
              state: "closed",
              paidAt: null,
              fulfilledAt: null,
              lastEventAt: new Date(
                Math.max(
                  intent.lastEventAt.getTime(),
                  Date.parse(order.eventAt),
                ),
              ),
            });
            if (!closed) {
              intent = (await store.findByOrderId(intent.orderId)) ?? intent;
            } else {
              intent = closed;
            }
          }
          if (intent.state !== "closed") {
            if (await store.isProjectDeleted(order.projectId)) {
              projectDeleted();
            }
            conflict("The checkout reservation could not be closed");
          }
          return {
            response: intentCommitResponse(intent, existingOrder),
            replayed: true,
          };
        }
        if (intent.state !== "pending") {
          conflict("The checkout reservation is no longer pending");
        }
        const existingAuthorization = await store.findByAuthorizationDigest(
          order.authorizationDigest,
        );
        if (existingAuthorization) {
          conflict(
            "The payment authorization is already bound to another order",
          );
        }

        try {
          const committed = await store.commitIntent(
            intent.orderId,
            intent.revision,
            {
              orderId: order.orderId,
              schemaVersion: 1,
              projectId: order.projectId,
              purchaseType: order.purchaseType,
              amountFen: order.amountFen,
              authorizationDigest: order.authorizationDigest,
              state: "pending",
              checkoutExpiresAt: new Date(order.checkoutExpiresAt),
              paidAt: null,
              fulfilledAt: null,
              lastEventAt: new Date(order.eventAt),
              revision: 1,
            },
            new Date(order.eventAt),
          );
          if (committed) {
            return {
              response: intentCommitResponse(committed.intent, committed.order),
              replayed: false,
            };
          }
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (
            !isDuplicateEntry(error) &&
            code !== "PROJECT_ORDER_COMMIT_RACE"
          ) {
            throw error;
          }
        }

        intent = (await store.findByOrderId(intent.orderId)) ?? intent;
        existingOrder = await store.findByOrderId(order.orderId);
        if (
          intent.state === "closed" &&
          existingOrder &&
          sameImmutableOrder(existingOrder, order)
        ) {
          return {
            response: intentCommitResponse(intent, existingOrder),
            replayed: true,
          };
        }
        if (await store.isProjectDeleted(order.projectId)) projectDeleted();
        conflict("The checkout reservation commit conflicted");
      } catch (error) {
        mapInactiveProject(error);
        if (error instanceof ProjectOrderRegistryError) throw error;
        databaseUnavailable(error);
      }
    },

    async ready() {
      try {
        await (await repository()).ready();
        return { schemaVersion: 1, ready: true };
      } catch (error) {
        if (error instanceof ProjectOrderRegistryError) throw error;
        databaseUnavailable(error);
      }
    },
  };
}
