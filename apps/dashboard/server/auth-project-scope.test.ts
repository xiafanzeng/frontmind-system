import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));

import {
  conversations,
  deliveryProjectAssignments,
  deliveryTickets,
  sessions,
  upstreamResources,
  userPasswordSetupTokens,
  users,
} from "../drizzle/schema";
import { deleteManagedUser, getOwnedUpstreamResourceIds } from "./auth-service";

const dialect = new MySqlDialect();

function sqlQuery(expression: unknown) {
  return dialect.sqlToQuery(
    expression as Parameters<MySqlDialect["sqlToQuery"]>[0],
  );
}

describe("upstream resource project scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not let account scope match a project-scoped ledger and isolates projects A and B", async () => {
    const ledger = [
      {
        userId: 42,
        projectAssignmentId: "project-a",
        kind: "task",
        upstreamId: "task-a",
      },
    ];
    const predicates: ReturnType<typeof sqlQuery>[] = [];
    dependencies.getDb.mockResolvedValue({
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(upstreamResources);
          return {
            where: async (expression: unknown) => {
              const query = sqlQuery(expression);
              predicates.push(query);
              const requiresAccountScope = query.sql.includes(
                "`upstream_resources`.`projectAssignmentId` is null",
              );
              const projectAssignmentId = requiresAccountScope
                ? null
                : String(query.params[0]);
              return ledger
                .filter((row) =>
                  requiresAccountScope
                    ? row.userId === 42 && row.projectAssignmentId == null
                    : row.projectAssignmentId === projectAssignmentId,
                )
                .map(({ upstreamId }) => ({ upstreamId }));
            },
          };
        },
      }),
    });

    await expect(
      getOwnedUpstreamResourceIds(42, "task", ["task-a"]),
    ).resolves.toEqual(new Set());
    await expect(
      getOwnedUpstreamResourceIds(42, "task", ["task-a"], "project-b"),
    ).resolves.toEqual(new Set());
    await expect(
      getOwnedUpstreamResourceIds(42, "task", ["task-a"], "project-a"),
    ).resolves.toEqual(new Set(["task-a"]));

    expect(predicates[0]?.sql).toContain(
      "`upstream_resources`.`projectAssignmentId` is null",
    );
    expect(predicates[1]).toMatchObject({
      params: ["project-b", "task", "task-a"],
    });
    expect(predicates[2]).toMatchObject({
      params: ["project-a", "task", "task-a"],
    });
  });
});

describe("engineer account history retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deactivates instead of deleting an engineer whose transferred project history remains", async () => {
    const updates: Array<{
      table: unknown;
      values: Record<string, unknown>;
    }> = [];
    const deletes: unknown[] = [];
    const historyPredicates: ReturnType<typeof sqlQuery>[] = [];
    const rowsFor = (table: unknown) => {
      if (table === users) {
        return [
          {
            id: 42,
            username: "former-engineer",
            role: "delivery_member",
            isActive: true,
          },
        ];
      }
      if (table === deliveryProjectAssignments || table === deliveryTickets) {
        return [];
      }
      if (table === upstreamResources) {
        return [{ id: "project-file-ledger" }];
      }
      if (table === conversations) return [];
      throw new Error(`unexpected select table: ${String(table)}`);
    };
    const database: any = {
      select: () => ({
        from: (table: unknown) => ({
          where: (expression: unknown) => ({
            limit: () => ({
              for: async () => {
                if (table === upstreamResources || table === conversations) {
                  historyPredicates.push(sqlQuery(expression));
                }
                return rowsFor(table);
              },
            }),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push({ table, values });
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: async () => {
          deletes.push(table);
        },
      }),
      transaction: async (operation: (tx: unknown) => unknown) =>
        operation(database),
    };
    dependencies.getDb.mockResolvedValue(database);

    await expect(deleteManagedUser(7, 42)).resolves.toEqual({
      disposition: "deactivated_for_history",
    });

    expect(deletes).toEqual([]);
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          table: users,
          values: expect.objectContaining({ isActive: false }),
        },
        {
          table: userPasswordSetupTokens,
          values: expect.objectContaining({ consumedAt: expect.any(Date) }),
        },
        {
          table: sessions,
          values: expect.objectContaining({ revokedAt: expect.any(Date) }),
        },
      ]),
    );
    expect(historyPredicates).toHaveLength(2);
    for (const predicate of historyPredicates) {
      expect(predicate.sql).toContain("`projectAssignmentId` is not null");
      expect(predicate.params).toContain(42);
    }
  });
});
