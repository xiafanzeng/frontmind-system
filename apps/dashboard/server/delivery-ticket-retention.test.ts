import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DELIVERY_TICKET_RETENTION_LOCK_NAME,
  buildDeliveryTicketRetentionFacts,
  deleteDeliveryTicketImmediately,
  deliveryTicketRetentionAffectedRows,
  deliveryTicketRetentionCandidateCondition,
  getDeliveryTicketRetentionCutoff,
  isDeliveryTicketRetentionEligible,
  runDeliveryTicketRetentionCleanup,
  startDeliveryTicketRetentionScheduler,
  type DeliveryTicketRetentionResult,
} from "./delivery-ticket-retention";
import {
  deliveryRedirectPreviews,
  deliveryTickets,
  deliveryWorkflowMilestones,
  knowledgeBaseResetRequests,
  knowledgeBaseSnapshots,
  serviceQuotaPeriods,
  users,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  websiteStyleWorkflows,
  workspaceQuestions,
} from "../drizzle/schema";

const DAY_MS = 24 * 60 * 60 * 1_000;

function retentionResult(): DeliveryTicketRetentionResult {
  return {
    cutoff: new Date("2026-07-03T08:30:00.000Z"),
    batches: 1,
    tickets: 2,
    milestones: 1,
    quotaFacts: 2,
    styleBatches: 0,
    redirectPreviews: 0,
    resetRequests: 0,
  };
}

function immediateDeletionDatabase(input: {
  ticketRows: any[];
  userRows?: any[];
  styleBatchRows?: any[];
  resetRequestRows?: any[];
  milestoneRows?: any[];
}) {
  const selectedTables: unknown[] = [];
  const updatedTables: unknown[] = [];
  const deletedTables: unknown[] = [];
  const insertedTables: unknown[] = [];
  const writePredicates: Array<{
    operation: "update" | "delete";
    table: unknown;
    expression: unknown;
  }> = [];
  const selectPredicates: Array<{ table: unknown; expression: unknown }> = [];
  const rowsForTable = (table: unknown) => {
    if (table === users) {
      return input.userRows ?? [{ id: input.ticketRows[0]?.userId ?? 7 }];
    }
    if (table === deliveryTickets) return input.ticketRows;
    if (table === serviceQuotaPeriods) return [{ id: "period-1" }];
    if (table === knowledgeBaseResetRequests) {
      return input.resetRequestRows ?? [];
    }
    if (table === deliveryWorkflowMilestones) return input.milestoneRows ?? [];
    if (table === websiteStyleSampleBatches) {
      return input.styleBatchRows ?? [];
    }
    return [];
  };
  const selectable = () => {
    let table: unknown;
    const chain: any = {
      from(value: unknown) {
        table = value;
        selectedTables.push(value);
        return chain;
      },
      where(expression: unknown) {
        selectPredicates.push({ table, expression });
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      for() {
        return chain;
      },
      then(
        resolve: (value: any[]) => unknown,
        reject: (error: unknown) => unknown,
      ) {
        return Promise.resolve(rowsForTable(table)).then(resolve, reject);
      },
    };
    return chain;
  };
  const writeable = (table: unknown, operation: "update" | "delete") => {
    (operation === "update" ? updatedTables : deletedTables).push(table);
    const chain: any = {
      set() {
        return chain;
      },
      where(expression: unknown) {
        writePredicates.push({ operation, table, expression });
        return chain;
      },
      then(
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) {
        const affectedRows =
          operation === "delete" &&
          (table === deliveryTickets || table === knowledgeBaseResetRequests)
            ? 1
            : 0;
        return Promise.resolve({ affectedRows }).then(resolve, reject);
      },
    };
    return chain;
  };
  const tx: any = {
    select: vi.fn(() => selectable()),
    update: vi.fn((table: unknown) => writeable(table, "update")),
    delete: vi.fn((table: unknown) => writeable(table, "delete")),
    insert: vi.fn((table: unknown) => {
      insertedTables.push(table);
      const chain: any = {
        values() {
          return chain;
        },
        onDuplicateKeyUpdate() {
          return chain;
        },
        then(
          resolve: (value: unknown) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          return Promise.resolve({ affectedRows: 1 }).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return {
    database: { transaction: (run: (executor: any) => unknown) => run(tx) },
    selectedTables,
    updatedTables,
    deletedTables,
    insertedTables,
    selectPredicates,
    writePredicates,
  };
}

describe("delivery ticket retention", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calculates an exact 30-day cutoff and rejects invalid retention days", () => {
    const now = new Date("2026-08-02T08:30:00.000Z");

    const cutoff = getDeliveryTicketRetentionCutoff(30, now);

    expect(cutoff.toISOString()).toBe("2026-07-03T08:30:00.000Z");
    expect(now.getTime() - cutoff.getTime()).toBe(30 * DAY_MS);
    expect(() => getDeliveryTicketRetentionCutoff(0, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
    expect(() => getDeliveryTicketRetentionCutoff(-1, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
    expect(() => getDeliveryTicketRetentionCutoff(1.5, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
    expect(() => getDeliveryTicketRetentionCutoff(Number.NaN, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
  });

  it("only makes terminal tickets older than the cutoff eligible", () => {
    const cutoff = new Date("2026-07-03T08:30:00.000Z");

    expect(
      isDeliveryTicketRetentionEligible(
        { status: "completed", resolvedAt: new Date(cutoff.getTime() - 1) },
        cutoff,
      ),
    ).toBe(true);
    expect(
      isDeliveryTicketRetentionEligible(
        { status: "completed", resolvedAt: new Date(cutoff) },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isDeliveryTicketRetentionEligible(
        { status: "in_progress", resolvedAt: new Date(cutoff.getTime() - 1) },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isDeliveryTicketRetentionEligible(
        { status: "cancelled", resolvedAt: null },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isDeliveryTicketRetentionEligible(
        {
          status: "rejected",
          resolvedAt: null,
          updatedAt: new Date(cutoff.getTime() - 1),
        },
        cutoff,
      ),
    ).toBe(true);
  });

  it("reads affected row counts from direct and mysql2 tuple results", () => {
    expect(deliveryTicketRetentionAffectedRows({ rowsAffected: 2 })).toBe(2);
    expect(deliveryTicketRetentionAffectedRows([{ affectedRows: 3 }, []])).toBe(
      3,
    );
  });

  it("keeps workflow children out of automatic retention candidates", () => {
    const query = new MySqlDialect().sqlToQuery(
      deliveryTicketRetentionCandidateCondition(
        new Date("2026-07-03T08:30:00.000Z"),
      ) as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );

    expect(query.sql).toContain("`delivery_tickets`.`parentTicketId` is null");
    expect(query.sql).toContain("`delivery_tickets`.`rootTicketId` is null");
  });

  it("cascades a deleted workflow root while retaining parent unlinking for nested steps", () => {
    const foreignKeys = getTableConfig(deliveryTickets).foreignKeys;
    const rootForeignKey = foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() === "delivery_tickets_root_ticket_fk",
    );
    const parentForeignKey = foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() === "delivery_tickets_parent_ticket_fk",
    );

    expect(rootForeignKey?.onDelete).toBe("cascade");
    expect(parentForeignKey?.onDelete).toBe("set null");
  });

  it("aggregates used quota and merges completed workflow milestones", () => {
    const facts = buildDeliveryTicketRetentionFacts([
      {
        id: "ticket-1",
        userId: 7,
        quotaPeriodId: "period-b",
        quotaPool: "content_asset_publish",
        quotaState: "consumed",
        status: "completed",
        operation: "content_asset_publish",
        contentAssetIds: ["asset-a", " asset-b ", "asset-a", ""],
        resolvedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        id: "ticket-2",
        userId: 7,
        quotaPeriodId: "period-b",
        quotaPool: "content_asset_publish",
        quotaState: "consumed",
        status: "completed",
        operation: "content_asset_publish",
        contentAssetIds: ["asset-b", "asset-c"],
        resolvedAt: new Date("2026-06-03T00:00:00.000Z"),
      },
      {
        id: "ticket-3",
        userId: 7,
        quotaPeriodId: "period-b",
        quotaPool: "website_content_publish",
        quotaState: "consumed",
        status: "rejected",
        operation: "website_content_publish",
        contentAssetIds: ["must-not-be-archived-as-a-milestone"],
        resolvedAt: new Date("2026-06-04T00:00:00.000Z"),
      },
      {
        id: "ticket-4",
        userId: 7,
        quotaPeriodId: "period-a",
        quotaPool: null,
        quotaState: "released",
        status: "completed",
        operation: "question_catalog",
        contentAssetIds: [],
        resolvedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
      {
        id: "ticket-5",
        userId: 8,
        quotaPeriodId: "period-a",
        quotaPool: "website_content_publish",
        quotaState: "reserved",
        status: "completed",
        operation: null,
        contentAssetIds: [],
        resolvedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
      {
        id: "ticket-6",
        userId: 7,
        quotaPeriodId: "period-a",
        quotaPool: null,
        quotaState: "consumed",
        status: "completed",
        operation: "website_build",
        contentAssetIds: [],
        resolvedAt: new Date("2026-06-05T00:00:00.000Z"),
      },
    ] as any);

    expect(facts.quotaDeltas).toEqual([
      {
        quotaPeriodId: "period-a",
        quotaPool: "website_content_publish",
        count: 1,
      },
      {
        quotaPeriodId: "period-b",
        quotaPool: "content_asset_publish",
        count: 2,
      },
      {
        quotaPeriodId: "period-b",
        quotaPool: "website_content_publish",
        count: 1,
      },
    ]);
    expect(facts.milestones).toEqual([
      {
        userId: 7,
        operation: "content_asset_publish",
        contentAssetIds: ["asset-a", "asset-b", "asset-c"],
        completedAt: new Date("2026-06-03T00:00:00.000Z"),
      },
      {
        userId: 7,
        operation: "question_catalog",
        contentAssetIds: [],
        completedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
      {
        userId: 7,
        operation: "website_build",
        contentAssetIds: [],
        completedAt: new Date("2026-06-05T00:00:00.000Z"),
      },
    ]);
  });

  it("permanently deletes one exact active demand and restores its pending question review", async () => {
    const fixture = immediateDeletionDatabase({
      ticketRows: [
        {
          id: "ticket-active",
          userId: 7,
          quotaPeriodId: "period-1",
          quotaPool: null,
          quotaState: "consumed",
          status: "submitted",
          category: "question_review",
          operation: "question_maintenance",
          sourceQuestionId: "question-1",
          contentAssetIds: [],
          revision: 3,
          resolvedAt: null,
          updatedAt: new Date("2026-08-08T08:00:00.000Z"),
        },
      ],
    });

    await expect(
      deleteDeliveryTicketImmediately({
        database: fixture.database,
        userId: 7,
        ticketId: "ticket-active",
        expectedRevision: 3,
        now: new Date("2026-08-08T09:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ outcome: "deleted", tickets: 1 });

    expect(fixture.updatedTables).toContain(workspaceQuestions);
    expect(fixture.updatedTables).toContain(knowledgeBaseSnapshots);
    expect(fixture.updatedTables).not.toContain(serviceQuotaPeriods);
    expect(
      fixture.deletedTables.filter((table) => table === deliveryTickets),
    ).toHaveLength(1);
    expect(fixture.selectedTables.slice(0, 3)).toEqual([
      users,
      knowledgeBaseResetRequests,
      deliveryTickets,
    ]);

    const resetPredicate = fixture.selectPredicates.find(
      (entry) => entry.table === knowledgeBaseResetRequests,
    );
    expect(resetPredicate).toBeDefined();
    expect(
      new MySqlDialect().sqlToQuery(resetPredicate!.expression as any).params,
    ).toEqual(["ticket-active", 7]);

    const questionPredicate = fixture.writePredicates.find(
      (entry) =>
        entry.operation === "update" && entry.table === workspaceQuestions,
    );
    expect(questionPredicate).toBeDefined();
    const query = new MySqlDialect().sqlToQuery(
      questionPredicate!.expression as any,
    );
    expect(query.sql).toContain("`workspace_questions`.`id` = ?");
    expect(query.sql).toContain("`workspace_questions`.`userId` = ?");
    expect(query.sql).toContain("`workspace_questions`.`quotaPeriodId` = ?");
    expect(query.sql).toContain("`workspace_questions`.`status` = ?");
    expect(query.sql).toContain(
      "`workspace_questions`.`selectionApprovalStatus` = ?",
    );
    expect(query.params).toEqual([
      "question-1",
      7,
      "period-1",
      "candidate",
      "pending",
    ]);
  });

  it("refuses to permanently delete one workflow child", async () => {
    const fixture = immediateDeletionDatabase({
      ticketRows: [
        {
          id: "workflow-child",
          parentTicketId: "workflow-parent",
          rootTicketId: "workflow-root",
          isWorkflowContainer: false,
          userId: 7,
          quotaPeriodId: "period-1",
          quotaPool: null,
          quotaState: "consumed",
          status: "completed",
          category: "site_check",
          operation: "site_check",
          sourceQuestionId: null,
          contentAssetIds: [],
          revision: 2,
          resolvedAt: new Date("2026-08-08T08:00:00.000Z"),
          updatedAt: new Date("2026-08-08T08:00:00.000Z"),
        },
      ],
    });

    await expect(
      deleteDeliveryTicketImmediately({
        database: fixture.database,
        userId: 7,
        ticketId: "workflow-child",
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({
      outcome: "workflow_child_forbidden",
      tickets: 0,
    });
    expect(fixture.updatedTables).toHaveLength(0);
    expect(fixture.deletedTables).toHaveLength(0);
    expect(fixture.insertedTables).toHaveLength(0);
  });

  it("stops an exact deletion at the per-user mutex when the workspace owner is absent", async () => {
    const fixture = immediateDeletionDatabase({
      userRows: [],
      ticketRows: [
        {
          id: "ticket-orphaned",
          userId: 7,
          quotaPeriodId: "period-1",
          quotaPool: null,
          quotaState: "released",
          status: "submitted",
          category: "question_review",
          operation: "question_maintenance",
          sourceQuestionId: "question-1",
          contentAssetIds: [],
          revision: 1,
          resolvedAt: null,
          updatedAt: new Date("2026-08-08T08:00:00.000Z"),
        },
      ],
    });

    await expect(
      deleteDeliveryTicketImmediately({
        database: fixture.database,
        userId: 7,
        ticketId: "ticket-orphaned",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: "not_found", tickets: 0 });

    expect(fixture.selectedTables).toEqual([users]);
    expect(fixture.updatedTables).toHaveLength(0);
    expect(fixture.deletedTables).toHaveLength(0);
  });

  it("archives terminal facts and removes linked delivery artifacts before the exact demand", async () => {
    const fixture = immediateDeletionDatabase({
      ticketRows: [
        {
          id: "ticket-terminal",
          userId: 7,
          quotaPeriodId: "period-1",
          quotaPool: "content_asset_publish",
          quotaState: "consumed",
          status: "completed",
          category: "company_news",
          operation: "content_asset_publish",
          sourceQuestionId: null,
          contentAssetIds: ["asset-1"],
          revision: 5,
          resolvedAt: new Date("2026-08-08T08:00:00.000Z"),
          updatedAt: new Date("2026-08-08T08:00:00.000Z"),
        },
      ],
      styleBatchRows: [{ id: "style-batch-1" }],
      resetRequestRows: [{ id: "reset-1", ticketId: "ticket-terminal" }],
    });

    await expect(
      deleteDeliveryTicketImmediately({
        database: fixture.database,
        userId: 7,
        ticketId: "ticket-terminal",
        expectedRevision: 5,
        now: new Date("2026-08-08T09:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      outcome: "deleted",
      tickets: 1,
      milestones: 1,
      quotaFacts: 1,
      styleBatches: 1,
      resetRequests: 1,
    });

    expect(fixture.updatedTables).toContain(serviceQuotaPeriods);
    expect(fixture.updatedTables).toContain(websiteStyleWorkflows);
    expect(fixture.deletedTables).toEqual(
      expect.arrayContaining([
        websiteStyleSamples,
        websiteStyleSampleBatches,
        deliveryRedirectPreviews,
        knowledgeBaseResetRequests,
        deliveryTickets,
      ]),
    );
    expect(fixture.insertedTables).toContain(deliveryWorkflowMilestones);
  });

  it("does not delete anything when the exact demand revision is stale", async () => {
    const fixture = immediateDeletionDatabase({
      ticketRows: [
        {
          id: "ticket-current",
          userId: 7,
          quotaPeriodId: "period-1",
          quotaPool: null,
          quotaState: "released",
          status: "submitted",
          category: "question_catalog",
          operation: "question_catalog",
          sourceQuestionId: null,
          contentAssetIds: [],
          revision: 4,
          resolvedAt: null,
          updatedAt: new Date("2026-08-08T08:00:00.000Z"),
        },
      ],
    });

    await expect(
      deleteDeliveryTicketImmediately({
        database: fixture.database,
        userId: 7,
        ticketId: "ticket-current",
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({
      outcome: "revision_conflict",
      currentRevision: 4,
      tickets: 0,
    });
    expect(fixture.deletedTables).toHaveLength(0);
  });

  it("does not widen an exact deletion when the target demand is absent", async () => {
    const fixture = immediateDeletionDatabase({ ticketRows: [] });

    await expect(
      deleteDeliveryTicketImmediately({
        database: fixture.database,
        userId: 7,
        ticketId: "missing-ticket",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: "not_found", tickets: 0 });
    expect(fixture.deletedTables).toHaveLength(0);
    expect(fixture.updatedTables).toHaveLength(0);
  });

  it("skips cleanup and closes the connection when the MySQL lock is busy", async () => {
    const query = vi.fn().mockResolvedValue([[{ acquired: 0 }], {}]);
    const end = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn();

    await expect(
      runDeliveryTicketRetentionCleanup({
        databaseUrl: "mysql://retention.test/database",
        createConnection: async () => ({ query, end }) as any,
        cleanup,
      }),
    ).resolves.toEqual({ acquired: false, result: null });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("SELECT GET_LOCK(?, 0) AS acquired", [
      DELIVERY_TICKET_RETENTION_LOCK_NAME,
    ]);
    expect(cleanup).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup under the MySQL lock, releases it, and closes the connection", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ acquired: 1 }], {}])
      .mockResolvedValueOnce([[{ released: 1 }], {}]);
    const end = vi.fn().mockResolvedValue(undefined);
    const result = retentionResult();
    const cleanup = vi.fn().mockResolvedValue(result);

    await expect(
      runDeliveryTicketRetentionCleanup({
        databaseUrl: "mysql://retention.test/database",
        createConnection: async () => ({ query, end }) as any,
        cleanup,
      }),
    ).resolves.toEqual({ acquired: true, result });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT RELEASE_LOCK(?) AS released",
      [DELIVERY_TICKET_RETENTION_LOCK_NAME],
    );
    expect(end).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[1],
    );
  });

  it("releases the MySQL lock and closes the connection when cleanup fails", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ acquired: 1 }], {}])
      .mockResolvedValueOnce([[{ released: 1 }], {}]);
    const end = vi.fn().mockResolvedValue(undefined);
    const cleanupError = new Error("cleanup transaction failed");
    const cleanup = vi.fn().mockRejectedValue(cleanupError);

    await expect(
      runDeliveryTicketRetentionCleanup({
        databaseUrl: "mysql://retention.test/database",
        createConnection: async () => ({ query, end }) as any,
        cleanup,
      }),
    ).rejects.toBe(cleanupError);

    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT RELEASE_LOCK(?) AS released",
      [DELIVERY_TICKET_RETENTION_LOCK_NAME],
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("prevents overlapping scheduler runs", async () => {
    vi.useFakeTimers();
    let finishFirstRun!: (value: { acquired: false; result: null }) => void;
    const firstRun = new Promise<{ acquired: false; result: null }>(
      (resolve) => {
        finishFirstRun = resolve;
      },
    );
    const run = vi
      .fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue({ acquired: false, result: null });
    const stop = startDeliveryTicketRetentionScheduler({
      initialDelayMs: 10,
      intervalMs: 10,
      run,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(1);

    finishFirstRun({ acquired: false, result: null });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });
});
