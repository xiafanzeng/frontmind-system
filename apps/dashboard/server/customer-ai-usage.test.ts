import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), access: vi.fn(), resolve: vi.fn() }));
vi.mock("./enterprise-project-service", () => ({ resolveEnterpriseProjectScope: mocks.resolve }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./dashboard-service", () => ({ assertWorkspaceAccess: mocks.access }));
import { listCustomerAiUsage, projectCustomerAiUsage } from "./customer-ai-usage";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";
import { MySqlDialect } from "drizzle-orm/mysql-core";
const base = { runId: "build", businessName: "知识库", status: "queued", startedAt: 1000, lastActivityAt: 2000, called: 0 };
describe("customer task billing", () => {
  it("keeps an upload visible with no model invocation and merges its eventual transport once", () => {
    expect(projectCustomerAiUsage([base])[0]).toMatchObject({ usageStatus: "none", inputTokens: "0", chargedTenThousandths: "0" });
    const [task] = projectCustomerAiUsage([base, { ...base, called: 1, eventCount: 2, inputTokens: "20", outputTokens: "4", cacheTokens: "3", chargedTenThousandths: "99", lastActivityAt: 3000 }]);
    expect(task).toMatchObject({ runId: "build", inputTokens: "20", outputTokens: "4", cacheTokens: "3", chargedTenThousandths: "99", usageStatus: "synced" });
  });
  it("distinguishes missing model usage and retains charges from a failed call without internal costs", () => {
    expect(projectCustomerAiUsage([{ ...base, called: 1 }])[0]?.usageStatus).toBe("syncing");
    const task = projectCustomerAiUsage([{ ...base, called: 1, status: "failed", eventCount: 1, unknownEvents: 1, chargedTenThousandths: "12", costNanos: "999999", sessionId: "secret" } as any])[0];
    expect(task).toMatchObject({ status: "失败", usageStatus: "partial", chargedTenThousandths: "12" });
    expect(JSON.stringify(task)).not.toMatch(/costNanos|999999|secret|session/);
  });
  it("uses real knowledge phases through a strict label allowlist", () => {
    expect(projectCustomerAiUsage([{ ...base, phase: "normalizing", called: 1 }])[0]?.phase).toBe("整理结果");
    expect(projectCustomerAiUsage([{ ...base, phase: "reservation provider request secret" }])[0]?.phase).toBe("上传或准备资料");
  });
  it("requires a current authenticated project scope before reading any task", async () => {
    await expect(listCustomerAiUsage({ id: 7 } as any, { page: 1 })).rejects.toThrow("请先选择企业项目");
    await expect(runWithEnterpriseProjectScope({ ownerUserId: 7, actorUserId: 8, enterpriseProjectId: "project-a", isLegacyDefault: false }, () => listCustomerAiUsage({ id: 7 } as any, { page: 1 }))).rejects.toThrow();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it("supports the account page through an explicitly authorized project selection", async () => {
    mocks.resolve.mockResolvedValue({ ownerUserId: 7, actorUserId: 7, enterpriseProjectId: "project-a", isLegacyDefault: false });
    mocks.getDb.mockResolvedValue({ execute: vi.fn().mockResolvedValue([[]]) });
    await expect(listCustomerAiUsage({ id: 7 } as any, { page: 1, enterpriseProjectId: "project-a" })).resolves.toMatchObject({ total: 0 });
    expect(mocks.resolve).toHaveBeenCalledWith({ id: 7 }, "project-a");
  });
  it("filters task and ledger independently to the project and reads only per-event charges", async () => {
    const statements: any[] = [];
    const execute = vi.fn(async statement => { statements.push(new MySqlDialect().sqlToQuery(statement)); return [[]]; });
    mocks.getDb.mockResolvedValue({ execute });
    await runWithEnterpriseProjectScope({ ownerUserId: 7, actorUserId: 7, enterpriseProjectId: "project-a", isLegacyDefault: false }, () => listCustomerAiUsage({ id: 7 } as any, { page: 1 }));
    expect(mocks.access).toHaveBeenCalledWith({ id: 7 }, 7);
    const query = statements[0];
    expect(query.sql).toContain("LEFT JOIN");
    expect(query.sql).toContain("FROM ai_cost_events");
    expect(query.sql).not.toMatch(/session_snapshot|cost_nanos|encrypted|fingerprint/);
    expect(query.params.filter((value: unknown) => value === "project-a")).toHaveLength(3);
  });
});
