import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  assertDeliveryProjectContext,
  deliveryHistoryTimestamp,
  deliveryExecutionActorRole,
  formalMonitoringBatchOptionsScope,
  listFormalMonitoringBatchOptions,
} from "./delivery-role-service";

function queuedQueryResult(
  value: unknown[] | (() => unknown[]),
): Record<string, any> {
  const query: Record<string, any> = {};
  for (const method of [
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "orderBy",
    "limit",
    "for",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve: (rows: unknown[]) => unknown, reject: unknown) =>
    Promise.resolve(typeof value === "function" ? value() : value).then(
      resolve,
      reject as never,
    );
  return query;
}

function queuedDeliveryExecutor(
  selectResults: Array<unknown[] | (() => unknown[])>,
) {
  const queue = [...selectResults];
  const insertCalls: Array<{
    table: unknown;
    values: any;
    onDuplicateKeyUpdate?: unknown;
  }> = [];
  const executor = {
    select: vi.fn(() => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected select query");
      return queuedQueryResult(next);
    }),
    insert: vi.fn((table: unknown) => {
      const call: (typeof insertCalls)[number] = { table, values: undefined };
      const builder: Record<string, any> = {};
      builder.values = vi.fn((values: unknown) => {
        call.values = values;
        insertCalls.push(call);
        return builder;
      });
      builder.onDuplicateKeyUpdate = vi.fn((value: unknown) => {
        call.onDuplicateKeyUpdate = value;
        return Promise.resolve();
      });
      builder.then = (resolve: (value?: unknown) => unknown, reject: unknown) =>
        Promise.resolve().then(resolve, reject as never);
      return builder;
    }),
  };
  return { executor, insertCalls, queue };
}

describe("delivery history timestamps", () => {
  it("accepts decoded dates and raw driver timestamp strings", () => {
    const date = new Date("2026-07-31T08:00:00.000Z");

    expect(deliveryHistoryTimestamp(date)).toBe(date.getTime());
    expect(deliveryHistoryTimestamp("2026-07-31T08:00:00.000Z")).toBe(
      date.getTime(),
    );
  });

  it("returns a controlled Chinese error for invalid driver values", () => {
    expect(() => deliveryHistoryTimestamp("not-a-date")).toThrow(
      "任务记录的时间数据无效，请稍后重试",
    );
  });
});
describe("formal monitoring batch completion options", () => {
  it("scopes options to the customer and batches containing formal samples", () => {
    const query = new MySqlDialect().sqlToQuery(
      formalMonitoringBatchOptionsScope({
        userId: 42,
        scopes: [
          {
            contractId: "contract-current",
            quotaPeriodId: "period-current",
          },
        ],
      }) as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );

    expect(query.sql).toContain("`monitoring_batches`.`userId` = ?");
    expect(query.sql).toContain("`monitoring_batches`.`contractId` = ?");
    expect(query.sql).toContain("`monitoring_batches`.`quotaPeriodId` = ?");
    expect(query.sql).toContain("`monitoring_batches`.`sampleCount` > ?");
    expect(query.params).toEqual([42, "contract-current", "period-current", 0]);

    const parallelBasicQuery = new MySqlDialect().sqlToQuery(
      formalMonitoringBatchOptionsScope({
        userId: 42,
        scopes: [
          { contractId: "basic-a", quotaPeriodId: "basic-period-a" },
          { contractId: "basic-b", quotaPeriodId: "basic-period-b" },
        ],
      }) as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    expect(parallelBasicQuery.params).toEqual([
      42,
      "basic-a",
      "basic-period-a",
      "basic-b",
      "basic-period-b",
      0,
    ]);
  });

  it("returns only the non-sensitive fields required by the completion selector", async () => {
    const { executor, queue } = queuedDeliveryExecutor([
      [
        {
          batchKey: "formal-batch-2026-08",
          sourceName: "正式监控.xlsx",
          collectedAt: new Date("2026-08-08T03:00:00.000Z"),
          sampleCount: 24,
        },
        {
          batchKey: "formal-batch-2026-08",
          sourceName: "历史同名批次.xlsx",
          collectedAt: new Date("2026-07-08T03:00:00.000Z"),
          sampleCount: 10,
        },
      ],
    ]);

    await expect(
      listFormalMonitoringBatchOptions({
        executor,
        userId: 42,
        activeQuotaSelection: {
          primaryContract: {
            id: "contract-current",
            planCode: "luxury",
            planVersion: 2,
          },
          scopes: [
            {
              contract: {
                id: "contract-current",
                planCode: "luxury",
                planVersion: 2,
              },
              period: { id: "period-current" },
            },
          ],
        } as any,
      }),
    ).resolves.toEqual([
      {
        batchKey: "formal-batch-2026-08",
        sourceName: "正式监控.xlsx",
        collectedAt: Date.parse("2026-08-08T03:00:00.000Z"),
        sampleCount: 24,
      },
    ]);
    expect(queue).toHaveLength(0);
  });

  it("keeps parallel active Basic periods in the formal batch scope", async () => {
    const activeStart = new Date("2020-01-01T00:00:00.000Z");
    const activeEnd = new Date("2099-01-01T00:00:00.000Z");
    const { executor, queue } = queuedDeliveryExecutor([
      [
        {
          id: "basic-a",
          userId: 42,
          planCode: "basic",
          planVersion: 1,
          status: "active",
          startsAt: activeStart,
          endsAt: activeEnd,
          revision: 2,
          replacesContractIds: [],
        },
        {
          id: "basic-b",
          userId: 42,
          planCode: "basic",
          planVersion: 1,
          status: "active",
          startsAt: activeStart,
          endsAt: activeEnd,
          revision: 1,
          replacesContractIds: [],
        },
      ],
      [
        {
          id: "basic-period-a",
          contractId: "basic-a",
          userId: 42,
          ordinal: 1,
          startsAt: activeStart,
          endsAt: activeEnd,
        },
        {
          id: "basic-period-b",
          contractId: "basic-b",
          userId: 42,
          ordinal: 1,
          startsAt: activeStart,
          endsAt: activeEnd,
        },
      ],
      [
        {
          batchKey: "basic-a-batch",
          sourceName: "Basic A.xlsx",
          collectedAt: new Date("2026-08-08T03:00:00.000Z"),
          sampleCount: 1,
        },
        {
          batchKey: "basic-b-batch",
          sourceName: "Basic B.xlsx",
          collectedAt: new Date("2026-08-09T03:00:00.000Z"),
          sampleCount: 1,
        },
      ],
    ]);

    await expect(
      listFormalMonitoringBatchOptions({ executor, userId: 42 }),
    ).resolves.toEqual([
      expect.objectContaining({ batchKey: "basic-a-batch" }),
      expect.objectContaining({ batchKey: "basic-b-batch" }),
    ]);
    expect(queue).toHaveLength(0);
  });
});

describe("engineer project authorization", () => {
  it("allows engineers and system admins while excluding delivery admins", () => {
    expect(
      deliveryExecutionActorRole({
        role: "delivery_member",
        username: "engineer",
      } as any),
    ).toBe("delivery_member");
    expect(
      deliveryExecutionActorRole({
        role: "admin",
        username: "root-admin",
        adminAccessLevel: "system_admin",
      } as any),
    ).toBe("admin");
    expect(
      deliveryExecutionActorRole({
        role: "admin",
        username: "delivery-admin",
        adminAccessLevel: "delivery_admin",
      } as any),
    ).toBeNull();
  });

  const actor = {
    id: 9,
    role: "delivery_member",
    username: "engineer",
    engineerRoleType: "monitoring_optimization_engineer",
  } as any;
  const assignment = {
    projectAssignmentId: "assignment-1",
    customerUserId: 42,
    roleType: "monitoring_optimization_engineer",
    marketEdition: "domestic",
    customerUsername: "customer",
  };
  it("rejects customer and delivery-admin access before reading projects", async () => {
    const executor = { select: vi.fn() };
    for (const user of [
      { id: 7, role: "user" },
      { id: 1, role: "admin", adminAccessLevel: "delivery_admin" },
    ]) {
      await expect(
        assertDeliveryProjectContext({
          actor: user as any,
          projectAssignmentId: "assignment-1",
          executor,
        }),
      ).rejects.toThrow("需要工程师或系统管理员权限");
    }
    expect(executor.select).not.toHaveBeenCalled();
  });
  it("allows an assigned AI role for a domestic operator without a service contract", async () => {
    const {executor} = queuedDeliveryExecutor([[{...assignment,roleType:"ai_operations_engineer"}],[]]);
    await expect(assertDeliveryProjectContext({actor:{...actor,engineerRoleType:"ai_operations_engineer"},projectAssignmentId:"assignment-1",executor})).resolves.toMatchObject({customerUserId:42,roleType:"ai_operations_engineer"});
  });
  it("rejects an assignment for a different customer", async () => {
    const { executor } = queuedDeliveryExecutor([[assignment]]);
    await expect(
      assertDeliveryProjectContext({
        actor,
        projectAssignmentId: "assignment-1",
        customerUserId: 43,
        executor,
      }),
    ).rejects.toThrow("客户与当前项目岗位不匹配");
  });
  it("rejects an engineer with a different project role", async () => {
    const { executor } = queuedDeliveryExecutor([
      [{ ...assignment, roleType: "ai_operations_engineer" }],
    ]);
    await expect(
      assertDeliveryProjectContext({
        actor,
        projectAssignmentId: "assignment-1",
        executor,
      }),
    ).rejects.toThrow("当前客户项目岗位不存在");
  });
  it("returns the assigned customer only within an enabled service plan", async () => {
    const { executor, queue } = queuedDeliveryExecutor([
      [assignment],
      [
        {
          id: "contract-1",
          userId: 42,
          planCode: "advanced",
          planVersion: 1,
          status: "active",
          startsAt: new Date("2020-01-01"),
          endsAt: new Date("2099-01-01"),
          revision: 1,
        },
      ],
    ]);
    await expect(
      assertDeliveryProjectContext({
        actor,
        projectAssignmentId: "assignment-1",
        customerUserId: 42,
        executor,
      }),
    ).resolves.toMatchObject({
      customerUserId: 42,
      roleType: "monitoring_optimization_engineer",
    });
    expect(queue).toHaveLength(0);
  });
});
