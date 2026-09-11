import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  access: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("./enterprise-project-service", () => ({
  resolveEnterpriseProjectScope: mocks.resolve,
}));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./dashboard-service", () => ({ assertWorkspaceAccess: mocks.access }));
import {
  listCustomerAiUsage,
  projectCustomerAiUsage,
} from "./customer-ai-usage";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";
import { MySqlDialect } from "drizzle-orm/mysql-core";
const base = {
  runId: "build",
  businessName: "知识库",
  status: "queued",
  startedAt: 1000,
  lastActivityAt: 2000,
  called: 0,
};
describe("customer task billing", () => {
  it("keeps an upload visible with no model invocation and merges its eventual transport once", () => {
    expect(projectCustomerAiUsage([base])[0]).toMatchObject({
      usageStatus: "none",
      inputTokens: "0",
      chargedTenThousandths: "0",
    });
    const [task] = projectCustomerAiUsage([
      base,
      {
        ...base,
        called: 1,
        eventCount: 2,
        inputTokens: "20",
        outputTokens: "4",
        cacheTokens: "3",
        chargedTenThousandths: "99",
        lastActivityAt: 3000,
      },
    ]);
    expect(task).toMatchObject({
      runId: "build",
      inputTokens: "20",
      outputTokens: "4",
      cacheTokens: "3",
      chargedTenThousandths: "99",
      usageStatus: "synced",
    });
  });
  it("distinguishes missing model usage and retains charges from a failed call without internal costs", () => {
    expect(
      projectCustomerAiUsage([{ ...base, called: 1 }])[0]?.usageStatus,
    ).toBe("syncing");
    const task = projectCustomerAiUsage([
      {
        ...base,
        called: 1,
        status: "failed",
        eventCount: 1,
        unknownEvents: 1,
        chargedTenThousandths: "12",
        costNanos: "999999",
        sessionId: "secret",
      } as any,
    ])[0];
    expect(task).toMatchObject({
      status: "失败",
      usageStatus: "partial",
      chargedTenThousandths: "12",
    });
    expect(JSON.stringify(task)).not.toMatch(/costNanos|999999|secret|session/);
  });
  it("uses real knowledge phases through a strict label allowlist", () => {
    expect(
      projectCustomerAiUsage([{ ...base, phase: "normalizing", called: 1 }])[0]
        ?.phase,
    ).toBe("整理结果");
    expect(
      projectCustomerAiUsage([
        { ...base, phase: "reservation provider request secret" },
      ])[0]?.phase,
    ).toBe("上传或准备资料");
  });
  it("reads a persisted upload stop and preserves previous-turn charges separately", () => {
    const stopped = {
      ...base,
      authoritative: 1,
      generation: 2,
      currentTurnInvocationState: "not_sent" as const,
      knowledgeBuildStatus: "confirming",
      knowledgeTurnStatus: "queued",
      knowledgeTurnMetadata: JSON.stringify({
        uploadControl: { state: "stopped" },
        awaitingClientAttachments: true,
        createAttemptState: "not_sent",
      }),
    };
    expect(projectCustomerAiUsage([stopped])[0]).toMatchObject({
      status: "已停止",
      phase: "上传已停止，未产生模型调用",
      usageStatus: "none",
    });
    expect(
      projectCustomerAiUsage([
        stopped,
        {
          ...base,
          generation: 2,
          taskId: "prior",
          turnId: "prior-turn",
          called: 1,
          eventCount: 1,
          chargedTenThousandths: "12",
        },
      ])[0],
    ).toMatchObject({
      status: "已停止",
      phase: "上传已停止，未产生模型调用",
      currentTurnInvocationState: "not_sent",
      chargedTenThousandths: "12",
      usageStatus: "synced",
    });
  });
  it("uses the same locally persisted normalization stage as upload and observation", () => {
    expect(
      projectCustomerAiUsage([
        {
          ...base,
          called: 1,
          knowledgeBuildStatus: "researching",
          knowledgeTurnStatus: "running",
          knowledgeTurnTaskId: "task",
          knowledgeTurnMetadata: {
            materializedResultDiagnostics: {
              resultProcessingStage: "canonical_validation",
            },
          },
          phase: "researching",
        },
      ])[0]?.phase,
    ).toBe("整理结果");
  });
  it("requires a current authenticated project scope before reading any task", async () => {
    await expect(
      listCustomerAiUsage({ id: 7 } as any, { page: 1 }),
    ).rejects.toThrow("请先选择企业项目");
    await expect(
      runWithEnterpriseProjectScope(
        {
          ownerUserId: 7,
          actorUserId: 8,
          enterpriseProjectId: "project-a",
          isLegacyDefault: false,
        },
        () => listCustomerAiUsage({ id: 7 } as any, { page: 1 }),
      ),
    ).rejects.toThrow();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it("supports the account page through an explicitly authorized project selection", async () => {
    mocks.resolve.mockResolvedValue({
      ownerUserId: 7,
      actorUserId: 7,
      enterpriseProjectId: "project-a",
      isLegacyDefault: false,
    });
    mocks.getDb.mockResolvedValue({
      transaction: (run: any) =>
        run({ execute: vi.fn().mockResolvedValue([[]]) }),
    });
    await expect(
      listCustomerAiUsage({ id: 7 } as any, {
        page: 1,
        enterpriseProjectId: "project-a",
      }),
    ).resolves.toMatchObject({ total: 0 });
    expect(mocks.resolve).toHaveBeenCalledWith({ id: 7 }, "project-a");
  });
  it("filters task and ledger independently to the project and reads only per-event charges", async () => {
    const statements: any[] = [];
    const execute = vi.fn(async (statement) => {
      statements.push(new MySqlDialect().sqlToQuery(statement));
      return [[]];
    });
    const transaction = vi.fn(async (run: any) => run({ execute }));
    mocks.getDb.mockResolvedValue({ transaction });
    await runWithEnterpriseProjectScope(
      {
        ownerUserId: 7,
        actorUserId: 7,
        enterpriseProjectId: "project-a",
        isLegacyDefault: false,
      },
      () => listCustomerAiUsage({ id: 7 } as any, { page: 1 }),
    );
    expect(mocks.access).toHaveBeenCalledWith({ id: 7 }, 7);
    const query = statements[0];
    expect(query.sql).toContain("LEFT JOIN");
    expect(query.sql).toContain("CONCAT('knowledge-node-edit:',ct.id)");
    expect(query.sql).not.toContain("ct.enterpriseProjectId IS NULL");
    expect(query.sql).toContain("FROM ai_cost_events");
    expect(query.sql).toContain(
      "o.operation_type='dashboard.provider.transport'",
    );
    expect(query.sql).toContain("LIKE 'managed-upload:%'");
    expect(query.sql).toContain(
      "REGEXP '^[0-9A-Fa-f-]{36}:attachment:[0-9]+:generation:[0-9]+$'",
    );
    expect(query.sql).not.toContain(
      "o.operation_type <> 'dashboard.provider.transport'",
    );
    expect(query.sql).not.toMatch(
      /session_snapshot|cost_nanos|encrypted|fingerprint/,
    );
    expect(
      query.params.filter((value: unknown) => value === "project-a"),
    ).toHaveLength(3);
    expect(statements[1].sql).toContain("ct.metadata AS knowledgeTurnMetadata");
    expect(statements[1].sql).toContain(
      "ct.buildId=b.id AND ct.buildGeneration=g.generation",
    );
    expect(statements[1].sql).toContain(
      "ct.userId=? AND ct.enterpriseProjectId=?",
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
    });
  });
});

describe("final manual usage regressions", () => {
  it("separates the same build across generations", () => {
    const tasks = projectCustomerAiUsage([
      { ...base, generation: 1, called: 1, eventCount: 1, inputTokens: "20" },
      { ...base, generation: 2, inputTokens: "0" },
    ] as any);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.inputTokens).sort()).toEqual(["0", "20"]);
  });
  it("uses authoritative business state even after a late transport sync", () => {
    const [task] = projectCustomerAiUsage([
      { ...base, authoritative: true, status: "published", phase: "published" },
      { ...base, called: 1, status: "running", lastActivityAt: 9000 },
    ] as any);
    expect(task).toMatchObject({
      status: "已完成",
      phase: "生成知识库",
      lastActivityAt: 9000,
    });
  });
  it("never claims no invocation for a dispatched request with an unknown result", () => {
    expect(
      projectCustomerAiUsage([
        { ...base, invocationState: "unknown", status: "result_pending" },
      ] as any)[0],
    ).toMatchObject({ usageStatus: "syncing" });
  });
  it("keeps complete tokens with unsettled cost in syncing status", () => {
    expect(
      projectCustomerAiUsage([
        {
          ...base,
          called: 1,
          eventCount: 1,
          unsettledEvents: 1,
          inputTokens: "10",
          outputTokens: "2",
        },
      ] as any)[0]?.usageStatus,
    ).toBe("partial");
  });
});

it("keeps a new unknown turn pending when earlier turns already have charges", () => {
  expect(
    projectCustomerAiUsage([
      {
        ...base,
        authoritative: true,
        invocationState: "called",
        currentTurnInvocationState: "unknown",
      },
      {
        ...base,
        taskId: "prior",
        turnId: "prior-turn",
        called: 1,
        eventCount: 1,
        chargedTenThousandths: "12",
      },
    ] as any)[0],
  ).toMatchObject({
    usageStatus: "partial",
    chargedTenThousandths: "12",
    currentTurnInvocationState: "unknown",
  });
});

it("does not flag a published local confirmation as an unknown model call", () => {
  const [task] = projectCustomerAiUsage([
    {
      ...base,
      authoritative: true,
      status: "completed",
      knowledgeBuildStatus: "published",
      knowledgeTurnStatus: "completed",
      knowledgeTurnOperationType: "local_confirm",
      knowledgeTurnMetadata: { providerRequestCount: 0 },
      currentTurnInvocationState: "unknown",
      invocationState: "called",
      eventCount: 2,
      inputTokens: "100",
      outputTokens: "20",
    } as any,
  ]);
  expect(task).toMatchObject({
    currentTurnInvocationState: "not_sent",
    usageStatus: "synced",
  });
});

it("keeps an unknown published revise visible for investigation", () => {
  const [task] = projectCustomerAiUsage([
    {
      ...base,
      authoritative: true,
      status: "completed",
      knowledgeBuildStatus: "published",
      knowledgeTurnStatus: "completed",
      knowledgeTurnOperationType: "revise",
      currentTurnInvocationState: "unknown",
      invocationState: "called",
      eventCount: 2,
    } as any,
  ]);
  expect(task?.usageStatus).toBe("partial");
  expect(task?.currentTurnInvocationState).toBe("unknown");
});

it("uses completed initial-turn state instead of the preceding normalization stage", () => {
  const [task] = projectCustomerAiUsage([
    {
      ...base,
      authoritative: true,
      status: "confirming",
      phase: "normalizing",
      knowledgeBuildStatus: "confirming",
      knowledgeTurnStatus: "completed",
      knowledgeTurnTaskId: "session-initial",
      called: 1,
      currentTurnInvocationState: "called",
      taskId: "initial-task",
      turnId: "initial-turn",
      eventCount: 1,
      inputTokens: "108558",
      chargedTenThousandths: "47281",
    },
  ] as any);
  expect(task).toMatchObject({
    status: "已完成",
    phase: "生成知识库",
    inputTokens: "108558",
    chargedTenThousandths: "47281",
    usageStatus: "synced",
  });
});

it("keeps acknowledged file preparation distinct from an unknown model dispatch", () => {
  const rows = [
    {
      ...base,
      authoritative: true,
      status: "researching",
      knowledgeBuildStatus: "researching",
      knowledgeTurnStatus: "queued",
      knowledgeTurnMetadata: { preparedDispatch: {} },
      currentTurnInvocationState: "not_sent",
    },
  ];
  expect(projectCustomerAiUsage(rows as any)[0]).toMatchObject({
    status: "准备调研",
    phase: "准备调研",
    usageStatus: "none",
  });
  expect(
    projectCustomerAiUsage([
      {
        ...rows[0],
        currentTurnInvocationState: "unknown",
        invocationState: "unknown",
      },
    ] as any)[0],
  ).toMatchObject({
    status: "等待确认",
    phase: "启动结果待确认",
    usageStatus: "syncing",
  });
});


it.each([undefined, null, false, "", 1])("keeps a local turn pending without explicit zero provider requests (%s)", (providerRequestCount) => {
  const [task] = projectCustomerAiUsage([{
    ...base, authoritative: true, status: "completed", knowledgeBuildStatus: "published",
    knowledgeTurnStatus: "completed", knowledgeTurnOperationType: "local_confirm",
    knowledgeTurnMetadata: { providerRequestCount }, currentTurnInvocationState: "unknown",
    invocationState: "called", eventCount: 2,
  } as any]);
  expect(task).toMatchObject({ currentTurnInvocationState: "unknown", usageStatus: "partial" });
});
