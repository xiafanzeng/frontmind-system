import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { assertCustomerProjectBusinessWrite, lockCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import type { AuthenticatedUser } from "./auth-service";
import { monitorConfigurationSchema } from "../../../packages/monitoring-contracts/src/monitoring";
import { runWithMonitoringEnterpriseScope } from "../../../packages/monitoring-db/src/enterprise-scope";

const databaseUrl = process.env.FRONTMIND_CUSTOMER_PROJECT_TEST_DATABASE_URL;
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe("customer project business authorization", () => {
  it("rejects mismatched target and actor before accessing storage", async () => {
    const scope = { enterpriseProjectId: randomUUID(), ownerUserId: 1, actorUserId: 2, isLegacyDefault: false };
    await runWithEnterpriseProjectScope(scope, async () => {
      await expect(assertCustomerProjectBusinessWrite({ id: 2, role: "admin", adminAccessLevel: "system_admin" }, 3, { executor: {} })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(assertCustomerProjectBusinessWrite({ id: 4, role: "user" }, 1, { executor: {} })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    await expect(assertCustomerProjectBusinessWrite({ id: 2, role: "admin", adminAccessLevel: "system_admin" }, 1, { executor: {} })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("leaves unscoped historical worker callbacks outside admission", async () => {
    await expect(lockCustomerProjectBusinessWrite({}, 1)).resolves.toBeUndefined();
  });
});

describe.skipIf(!databaseUrl)("customer project native admission MySQL", () => {
  let db: any;
  let schema: typeof import("../drizzle/schema");
  let tables: typeof import("../../../packages/monitoring-db/src/schema");
  let service: typeof import("./enterprise-project-service");
  let deleteProject: typeof import("./enterprise-project-deletion")["deleteEnterpriseProject"];
  let dashboard: typeof import("./dashboard-service");
  let repository: InstanceType<typeof import("../../../packages/monitoring-db/src/repositories")["MonitoringRepository"]>;
  let publishing: InstanceType<typeof import("../../../packages/monitoring-db/src/publisher-repository")["PublishingRepository"]>;
  let owner: AuthenticatedUser, other: AuthenticatedUser, admin: AuthenticatedUser, delivery: AuthenticatedUser;
  let monitoringOwner: string;
  let configuration: ReturnType<typeof monitorConfigurationSchema.parse>;
  const audit = () => ({ actorId: monitoringOwner, actorRole: "user" as const, requestId: randomUUID() });
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/acceptance/.test(url.pathname)) throw new Error("Local isolated acceptance database required");
    process.env.DATABASE_URL = databaseUrl;
    db = (await (await import("./db")).getDb())!;
    schema = await import("../drizzle/schema");
    tables = await import("../../../packages/monitoring-db/src/schema");
    service = await import("./enterprise-project-service");
    deleteProject = (await import("./enterprise-project-deletion")).deleteEnterpriseProject;
    dashboard = await import("./dashboard-service");
    const createActor = async (role: "user" | "admin", level?: "system_admin" | "delivery_admin") => {
      const username = `business-${randomUUID().slice(0, 12)}`;
      await db.insert(schema.users).values({ username, role, isActive: true, adminAccessLevel: level });
      const [row] = await db.select().from(schema.users).where(eq(schema.users.username, username));
      return row as AuthenticatedUser;
    };
    owner = await createActor("user"); other = await createActor("user");
    admin = await createActor("admin", "system_admin"); delivery = await createActor("admin", "delivery_admin");
    monitoringOwner = randomUUID();
    await db.insert(tables.users).values({ id: monitoringOwner, username: `native-${randomUUID()}`, passwordHash: "local-test-only", passwordChangedAt: new Date() });
    await db.insert(schema.monitoringAccountLinks).values({ dashboardUserId: owner.id, monitoringUserId: monitoringOwner });
    await db.insert(tables.moneyWallets).values({ userId: monitoringOwner, balanceTenThousandths: 1_000_000n });
    const platformId = randomUUID(), providerCode = `test-${randomUUID().slice(0, 8)}`;
    await db.insert(tables.platformCatalog).values({ id: platformId, providerCode, displayName: "验收平台", clientType: "web", pricingClass: "domestic", enabled: true, verified: true, discoveredAt: new Date() });
    const pricingId = randomUUID();
    await db.insert(tables.pricingVersions).values({ id: pricingId, code: `acceptance-${randomUUID()}`, sourceUrl: "https://example.invalid/test", effectiveFrom: new Date(Date.now() + 60_000) });
    await db.insert(tables.pricingItems).values({ id: randomUUID(), pricingVersionId: pricingId, pricingClass: "domestic", mode: "search", screenshotEnabled: false, amountTenThousandths: 10n });
    configuration = monitorConfigurationSchema.parse({ name: "测试监控", questions: ["验收问题"], platforms: [{ platformId, providerCode, clientType: "web", mode: "search", screenshot: 0, regionCode: null }], repetitions: 1 });
    repository = new (await import("../../../packages/monitoring-db/src/repositories")).MonitoringRepository(db);
    publishing = new (await import("../../../packages/monitoring-db/src/publisher-repository")).PublishingRepository(db);
  });
  afterAll(async () => { if (db) await (await import("./db")).closeDbForOneShotMaintenance(); });
  const project = () => service.createEnterpriseProject(owner, { name: "真实事务验收", clientRequestId: randomUUID() });
  const scoped = <T>(p: { id: string }, actor: AuthenticatedUser, run: () => T): T => runWithEnterpriseProjectScope({ enterpriseProjectId: p.id, ownerUserId: owner.id, actorUserId: actor.id, isLegacyDefault: false }, run);
  const monitorScoped = <T>(p: { id: string }, run: () => T, before?: (tx: any) => Promise<void>): T => scoped(p, owner, () => runWithMonitoringEnterpriseScope({ enterpriseProjectId: p.id, ownerId: monitoringOwner, beforeBusinessWrite: before ?? (tx => lockCustomerProjectBusinessWrite(tx, owner.id, owner)) }, run));
  const remove = (p: { id: string; revision: number }) => deleteProject(owner, { enterpriseProjectId: p.id, expectedRevision: p.revision });
  const write = (p: { id: string }, actor = owner, hooks: { beforeWrite?: (tx: any) => Promise<void> } = {}) => scoped(p, actor, () => dashboard.updateDashboardWorkspace({ userId: owner.id, actorUserId: actor.id, payload: createDefaultDashboardPayload("真实事务验收"), sourceName: "事务测试", expectedRevision: 0, businessSubmission: true, ...hooks }));
  const monitorProject = (p: { id: string }) => monitorScoped(p, () => repository.createProject(monitoringOwner, { name: "监控子项目", mainBrand: "测试品牌", aliases: [], competitors: [], timezone: "Asia/Shanghai" }, audit()));

  it("allows system and assigned delivery admin; rejects other customers and revoked assignments", async () => {
    const p = await project();
    await scoped(p, admin, () => assertCustomerProjectBusinessWrite(admin, owner.id));
    await expect(scoped(p, delivery, () => assertCustomerProjectBusinessWrite(delivery, owner.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.insert(schema.userAdminAssignments).values({ userId: owner.id, adminId: delivery.id });
    await scoped(p, delivery, () => assertCustomerProjectBusinessWrite(delivery, owner.id));
    await write(p, delivery);
    await expect(scoped(p, other, () => assertCustomerProjectBusinessWrite(other, owner.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.delete(schema.userAdminAssignments).where(and(eq(schema.userAdminAssignments.userId, owner.id), eq(schema.userAdminAssignments.adminId, delivery.id)));
    // Scope captured before revocation is not authority for a later commit.
    await expect(write(await project(), delivery)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rechecks revoked delivery assignment after an earlier repeatable-read snapshot", async () => {
    const p = await project(), read = gate(), release = gate();
    await db.insert(schema.userAdminAssignments).values({ userId: owner.id, adminId: delivery.id });
    const pending = scoped(p, delivery, () => db.transaction(async (tx: any) => {
      // Native monitoring reads immutable ownership before obtaining its locks.
      await tx.select().from(schema.userAdminAssignments).where(eq(schema.userAdminAssignments.userId, owner.id));
      read.resolve(); await release.promise;
      await lockCustomerProjectBusinessWrite(tx, owner.id, delivery);
    })).then(() => ({ ok: true }), (error: any) => ({ error }));
    await read.promise;
    await db.delete(schema.userAdminAssignments).where(and(eq(schema.userAdminAssignments.userId, owner.id), eq(schema.userAdminAssignments.adminId, delivery.id)));
    release.resolve();
    const result = await pending;
    expect("error" in result && result.error.code).toBe("NOT_FOUND");
  });

  it("serializes dashboard save before deletion and retains its committed content", async () => {
    const p = await project(), locked = gate(), release = gate();
    const saving = write(p, owner, { beforeWrite: async () => { locked.resolve(); await release.promise; } });
    await locked.promise;
    const deleting = remove(p);
    release.resolve();
    await saving; await deleting;
    const [stored] = await db.select().from(schema.enterpriseProjectDashboardContents).where(eq(schema.enterpriseProjectDashboardContents.enterpriseProjectId, p.id));
    expect(stored.revision).toBe(1);
  });

  it("waits on an in-flight archive and refuses the write when the archive commits", async () => {
    const p = await project(), locked = gate(), release = gate();
    // The archive changes precisely the row protected by the production
    // deletion transaction; hold it open to exercise MySQL's waiting writer.
    const archiving = db.transaction(async (tx: any) => {
      await tx.select().from(schema.enterpriseProjects).where(eq(schema.enterpriseProjects.id, p.id)).limit(1).for("update");
      await tx.update(schema.enterpriseProjects).set({ archivedAt: new Date(), revision: p.revision + 1 }).where(eq(schema.enterpriseProjects.id, p.id));
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const saving = write(p).then(value => ({ value }), error => ({ error }));
    release.resolve(); await archiving;
    const result = await saving;
    expect("error" in result && result.error.code).toBe("NOT_FOUND");
    const [stored] = await db.select().from(schema.enterpriseProjectDashboardContents).where(eq(schema.enterpriseProjectDashboardContents.enterpriseProjectId, p.id));
    expect(stored.revision).toBe(0);
  });

  it("rolls back a failed dashboard transaction, then blocks all fresh scoped writes after deletion", async () => {
    const p = await project();
    await expect(write(p, owner, { beforeWrite: async () => { throw new Error("forced-rollback"); } })).rejects.toThrow("forced-rollback");
    const [stored] = await db.select().from(schema.enterpriseProjectDashboardContents).where(eq(schema.enterpriseProjectDashboardContents.enterpriseProjectId, p.id));
    expect(stored.revision).toBe(0);
    await remove(p);
    await expect(write(p)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scoped(p, owner, () => import("./enterprise-project-questions").then(s => s.selectEnterpriseQuestion({ userId: owner.id, actorUserId: owner.id, question: "新问题", category: "brand" as never })))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(monitorScoped(p, () => publishing.createPublisherArticle(monitoringOwner, "新稿件"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["update", "createAndRun", "updateAndRun"] as const)("takes enterprise admission before business locks for %s", async action => {
    const p = await project();
    const child = await monitorProject(p);
    const monitor = await monitorScoped(p, () => repository.createMonitor(monitoringOwner, child.id, configuration, audit()));
    const locked = gate(), release = gate();
    let held = false;
    const submitting = monitorScoped(p, () => action === "update"
      ? repository.updateMonitor(monitoringOwner, monitor.monitorId, { ...configuration, name: "更新名称" }, audit())
      : action === "createAndRun"
        ? repository.createMonitorAndRun(monitoringOwner, child.id, configuration, randomUUID(), audit())
        : repository.updateMonitorAndRun(monitoringOwner, monitor.monitorId, configuration, randomUUID(), audit()),
    async tx => { await lockCustomerProjectBusinessWrite(tx, owner.id, owner); if (!held) { held = true; locked.resolve(); await release.promise; } });
    await locked.promise;
    const deleting = remove(p).then(value => ({ value }), error => ({ error }));
    release.resolve();
    await submitting;
    const deletion = await deleting;
    if (action === "update") expect("value" in deletion).toBe(true);
    else expect("error" in deletion && deletion.error.message).toContain("问题监控");
  });

  it("rejects config/run admission when deletion won and keeps independent worker protocol callable", async () => {
    const p = await project(), child = await monitorProject(p);
    const monitor = await monitorScoped(p, () => repository.createMonitor(monitoringOwner, child.id, configuration, audit()));
    await remove(p);
    for (const submit of [
      () => repository.updateMonitor(monitoringOwner, monitor.monitorId, configuration, audit()),
      () => repository.createMonitorAndRun(monitoringOwner, child.id, configuration, randomUUID(), audit()),
      () => repository.updateMonitorAndRun(monitoringOwner, monitor.monitorId, configuration, randomUUID(), audit()),
    ]) await expect(monitorScoped(p, submit)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Original positional createRun signature, without any Dashboard callback.
    await expect(repository.createRun(monitoringOwner, monitor.monitorId, randomUUID(), "scheduled")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [versions] = await db.select().from(tables.monitorVersions).where(eq(tables.monitorVersions.monitorId, monitor.monitorId));
    expect(versions.version).toBe(1);
  });
});
