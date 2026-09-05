// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appRouter } from "../../../packages/monitoring-api/src/router";
import { createApiApp } from "../../../packages/monitoring-api/src/server";
import { runtimeConfigSchema } from "../../../packages/monitoring-config/src/index";
import { loadWorkerConfig } from "../../../apps/monitoring-worker/src/config";
import { dashboardMonitoringUserId } from "../../../packages/monitoring-db/src/dashboard-account-links";
import type { ApiContext } from "../../../packages/monitoring-api/src/context";

const config = runtimeConfigSchema.parse({ NODE_ENV: "test", DATABASE_URL: "mysql://localhost/test", PUBLIC_ORIGIN: "http://dashboard.test" });
function context(role: "user" | "admin" | null) {
  const repository = { listProjects: vi.fn().mockResolvedValue([]), getAdminOverview: vi.fn() };
  return {
    user: role ? { id: "11111111-1111-5111-8111-111111111111", username: "dashboard-account", role, status: "active" } : null,
    repository, config, auth: { resolve: vi.fn().mockResolvedValue(null) },
    paymentConfiguration: { publicState: { configured: false, onlinePayment: { configured: false, provider: null, methods: [] }, bankTransfer: { configured: false } } },
    request: {} as never, response: {} as never, session: null, tokenHash: null,
    audit: { actorId: null, actorRole: null, ipHash: null },
  } as unknown as ApiContext;
}

it("keeps customer ownership in repositories and grants admins only their own customer workspace", async () => {
  for (const role of ["user", "admin"] as const) {
    const ctx = context(role);
    await expect(appRouter.createCaller(ctx).projects.list()).resolves.toEqual([]);
    expect(ctx.repository.listProjects).toHaveBeenCalledWith(ctx.user!.id);
  }
});
it("requires Dashboard system-admin mapping for the admin API", async () => {
  await expect(appRouter.createCaller(context("user")).admin.overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(appRouter.createCaller(context(null)).projects.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
it("blocks separate credential/account mutation in the monitoring module", async () => {
  const caller = appRouter.createCaller(context("admin"));
  await expect(caller.auth.changePassword({ currentPassword: "old-password", newPassword: "new-password-123" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(caller.admin.users.create({ username: "new-account", password: "new-password-123", role: "user" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
it("produces stable, distinct UUIDs for canonical integer accounts", () => {
  expect(dashboardMonitoringUserId(42)).toEqual(dashboardMonitoringUserId(42));
  expect(dashboardMonitoringUserId(42)).not.toEqual(dashboardMonitoringUserId(43));
  expect(dashboardMonitoringUserId(42)).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  for (const id of [0, -1, 1.2, NaN]) expect(() => dashboardMonitoringUserId(id)).toThrow();
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});
it("mounts the full API under the Dashboard prefix and keeps login/CSRF boundaries", async () => {
  const ctx = context(null);
  const app = express();
  app.use("/api/monitoring", createApiApp({ repository: ctx.repository, auth: ctx.auth, config, paymentConfiguration: ctx.paymentConfiguration }));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await fetch(`${origin}/api/monitoring/healthz`)).status).toBe(200);
  expect((await fetch(`${origin}/api/monitoring/auth/login`, { method: "POST" })).status).toBe(410);
  expect((await fetch(`${origin}/api/monitoring/trpc/projects.list`)).status).toBe(401);
  expect((await fetch(`${origin}/api/monitoring/trpc/projects.create`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://attacker.test" }, body: "{}" })).status).toBe(403);
});

describe("explicit persistent local storage in production", () => {
  const env = {
    NODE_ENV: "production", DATABASE_URL: "mysql://localhost/test", EMBEDDED_DASHBOARD: true,
    SESSION_SECRET: "test-only-secret-with-more-than-thirty-two-characters", PUBLIC_ORIGIN: "https://dashboard.test",
    OBJECT_STORE_DRIVER: "local", LOCAL_OBJECT_STORE_DIR: "/var/lib/frontmind/monitoring-assets",
    MOLI_API_TOKEN: "test-only-token",
  };
  it("requires explicit enablement in both API and worker", () => {
    expect(() => runtimeConfigSchema.parse(env)).toThrow();
    expect(() => loadWorkerConfig(env as unknown as NodeJS.ProcessEnv)).toThrow();
    const enabled = { ...env, ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: "true" };
    expect(runtimeConfigSchema.parse(enabled).NODE_ENV).toBe("production");
    expect(loadWorkerConfig(enabled as unknown as NodeJS.ProcessEnv).objectStore.driver).toBe("local");
    expect(() => runtimeConfigSchema.parse({ ...enabled, LOCAL_OBJECT_STORE_DIR: "/" })).toThrow();
    expect(() => loadWorkerConfig({ ...enabled, LOCAL_OBJECT_STORE_DIR: "/" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});


it("keeps DOCX processing available with no KOL client or mock catalog", async () => {
  const { createPublisherWorkerEngine, unavailablePublishingProvider } = await import("../../../apps/monitoring-worker/src/publishing/bootstrap");
  const publisher = loadWorkerConfig({
    NODE_ENV: "production", OBJECT_STORE_DRIVER: "local",
    LOCAL_OBJECT_STORE_DIR: "/var/lib/frontmind/monitoring-assets", ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: "true",
    MOLI_API_TOKEN: "test-only-token", PUBLISHER_FEATURE_ENABLED: "true", PUBLISHER_PROVIDER_ENABLED: "false",
    PUBLISHER_PUBLIC_ORIGIN: "https://dashboard.test",
  }).publisher;
  expect(publisher).toMatchObject({ enabled: true, providerEnabled: false, mode: "live", accessToken: undefined });
  await expect(unavailablePublishingProvider("live").listResources()).rejects.toThrow("not configured");
  const controller = new AbortController();
  const repository = {
    leasePublisherJobs: vi.fn(async () => { controller.abort(); return []; }),
    enqueuePublisherMaintenanceJobs: vi.fn(),
    recoverExpiredPublisherSubmissions: vi.fn().mockResolvedValue(0),
    claimExpiredPublisherObjectLeases: vi.fn().mockResolvedValue([]),
  };
  const worker = createPublisherWorkerEngine({
    config: publisher, repository: repository as never,
    objectStore: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await worker.run(controller.signal);
  expect(repository.leasePublisherJobs).toHaveBeenCalledWith(expect.objectContaining({ allowedTypes: ["import_docx", "purge_publisher_assets"] }));
  expect(repository.enqueuePublisherMaintenanceJobs).not.toHaveBeenCalled();
});

describe("production platform acceptance", () => {
  const ownerId = "11111111-1111-5111-8111-111111111111";
  const input = {
    ownerId, projectId: "22222222-2222-5222-8222-222222222222",
    platformIds: ["33333333-3333-5333-8333-333333333333"], question: "介绍公开品牌",
    domesticRegionCode: null, overseasRegionCode: null,
    planFingerprint: "a".repeat(64), confirmedTotalAmountTenThousandths: "9000",
    idempotencyKey: `platform-acceptance:${"a".repeat(64)}`,
  };
  const batch = {
    id: "44444444-4444-5444-8444-444444444444", ownerId, projectId: input.projectId,
    requestedBy: ownerId, planFingerprint: input.planFingerprint, questionHash: "b".repeat(64),
    status: "running", attemptCount: 7, totalAmountTenThousandths: "9000",
    idempotencyKey: input.idempotencyKey, startedAt: new Date(), completedAt: null,
    createdAt: new Date(), updatedAt: new Date(), checks: [],
  };
  function acceptanceContext(role: "admin" | "user" | null, budget: bigint) {
    const ctx = context(role);
    ctx.config = { ...ctx.config, NODE_ENV: "production", DATABASE_URL: "mysql://database.internal/monitoring", MONITORING_ACCEPTANCE_MAX_TEN_THOUSANDTHS: budget };
    ctx.audit = { ...ctx.audit, actorId: ctx.user?.id ?? null, actorRole: ctx.user?.role ?? null };
    ctx.repository.startPlatformAcceptanceBatch = vi.fn().mockResolvedValue(batch);
    return ctx;
  }
  it("keeps paid production probes disabled by the default zero budget", async () => {
    expect(config.MONITORING_ACCEPTANCE_MAX_TEN_THOUSANDTHS).toBe(0n);
    const ctx = acceptanceContext("admin", 0n);
    await expect(appRouter.createCaller(ctx).admin.platforms.acceptance.start(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(ctx.repository.startPlatformAcceptanceBatch).not.toHaveBeenCalled();
  });
  it("allows authenticated production admins at the exact explicit budget and preserves confirmation and audit", async () => {
    const ctx = acceptanceContext("admin", 9000n);
    await expect(appRouter.createCaller(ctx).admin.platforms.acceptance.start(input)).resolves.toMatchObject({ id: batch.id });
    expect(ctx.repository.startPlatformAcceptanceBatch).toHaveBeenCalledTimes(1);
    expect(ctx.repository.startPlatformAcceptanceBatch).toHaveBeenCalledWith(input, ctx.audit);
    expect(ctx.config.NODE_ENV).toBe("production");
  });
  it("rejects over-budget plans before dispatch", async () => {
    const ctx = acceptanceContext("admin", 8999n);
    await expect(appRouter.createCaller(ctx).admin.platforms.acceptance.start(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(ctx.repository.startPlatformAcceptanceBatch).not.toHaveBeenCalled();
  });
  it.each(["user", null] as const)("rejects non-administrator %s before dispatch", async (role) => {
    const ctx = acceptanceContext(role, 9000n);
    await expect(appRouter.createCaller(ctx).admin.platforms.acceptance.start(input)).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
    expect(ctx.repository.startPlatformAcceptanceBatch).not.toHaveBeenCalled();
  });
  it("preserves authoritative repository rejection of stale plans", async () => {
    const { RepositoryError } = await import("@frontmind/monitoring-db");
    const ctx = acceptanceContext("admin", 9000n);
    vi.mocked(ctx.repository.startPlatformAcceptanceBatch).mockRejectedValue(new RepositoryError("CONFLICT", "Fresh quote required"));
    await expect(appRouter.createCaller(ctx).admin.platforms.acceptance.start(input)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
