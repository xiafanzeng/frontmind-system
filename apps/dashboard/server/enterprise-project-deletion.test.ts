import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { assertEnterpriseProjectActive } from "./enterprise-project-lifecycle";
import { assertMonitoringEnterpriseProjectActive } from "../../../packages/monitoring-db/src/enterprise-lifecycle";

describe("enterprise deletion admission fence", () => {
  it("does not gate account-level general work or settlement", async () => {
    const tx = {} as never;
    await assertEnterpriseProjectActive(tx, null, 7);
    await assertMonitoringEnterpriseProjectActive(tx, null, "owner");
  });
  it("checks persisted owner and archive state under a database lock", async () => {
    const seen: string[] = [];
    for (const rows of [[], [{ id: "project", archivedAt: new Date() }]]) {
      await expect(assertMonitoringEnterpriseProjectActive({ execute: async query => {
        const parsed = new MySqlDialect().sqlToQuery(query);
        seen.push(parsed.sql);
        expect(parsed.params).toEqual(["project", "owner"]);
        return [rows];
      } }, "project", "owner")).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(seen.every(query => query.includes("FOR UPDATE") && query.includes("monitoring_account_links"))).toBe(true);
  });
});

// Uses a dedicated, fully migrated local schema; never clears shared fixtures.
const acceptanceUrl = process.env.FRONTMIND_ENTERPRISE_DELETION_TEST_DATABASE_URL;
describe.skipIf(!acceptanceUrl)("enterprise deletion MySQL acceptance", () => {
  let db: NonNullable<Awaited<ReturnType<typeof import("./db")["getDb"]>>>;
  let service: typeof import("./enterprise-project-service");
  let remove: typeof import("./enterprise-project-deletion")["deleteEnterpriseProject"];
  let schema: typeof import("../drizzle/schema");
  let owner: { id: number; username: string; displayName: string; role: "user" };
  let stranger: typeof owner;
  let delivery: typeof owner & { adminAccessLevel?: "delivery_admin" };
  let walletOwner: string;
  beforeAll(async () => {
    const url = new URL(acceptanceUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !["/fm_project_deletion_acceptance_operator", "/frontmind_workspace_acceptance"].includes(url.pathname))
      throw new Error("Dedicated local enterprise deletion acceptance schema required");
    process.env.DATABASE_URL = acceptanceUrl;
    process.env.NODE_ENV = "test";
    db = (await (await import("./db")).getDb())!;
    schema = await import("../drizzle/schema");
    service = await import("./enterprise-project-service");
    remove = (await import("./enterprise-project-deletion")).deleteEnterpriseProject;
    const createActor = async () => {
      const username = `delete-${randomUUID().slice(0, 16)}`;
      await db.insert(schema.users).values({ username, role: "user" });
      const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username));
      return { id: user!.id, username, displayName: "删除验收", role: "user" as const };
    };
    owner = await createActor(); stranger = await createActor(); delivery = await createActor();
    walletOwner = randomUUID();
    const monitoringTables = await import("../../../packages/monitoring-db/src/schema");
    await db.insert(monitoringTables.users).values({ id: walletOwner, username: `deletion-${randomUUID()}`, passwordHash: "local-acceptance-only", passwordChangedAt: new Date() });
    await db.insert(monitoringTables.moneyWallets).values({ userId: walletOwner });
    await db.insert(schema.monitoringAccountLinks).values({ dashboardUserId: owner.id, monitoringUserId: walletOwner });
  });
  afterAll(async () => { if (db) await (await import("./db")).closeDbForOneShotMaintenance(); });
  const create = () => service.createEnterpriseProject(owner, { name: "删除验收项目", clientRequestId: randomUUID() });
  const intent = (project: { id: string; revision: number }) => ({ enterpriseProjectId: project.id, expectedRevision: project.revision });
  const operation = (projectId: string) => ({ id: randomUUID(), provider: "zhipu", scope: "managed_user" as const, accountUserId: owner.id, enterpriseProjectId: projectId, operationType: "knowledge.research", idempotencyKeyHash: randomUUID().replaceAll("-", ""), requestHash: "a".repeat(64), contractName: "acceptance", contractRevision: 1, schemaHash: "a".repeat(64), apiCredentialId: randomUUID(), credentialVersion: 1, publicProfile: "high", upstreamModel: "glm-5.3" });

  it("permanently hides the project, preserves content and safely replays one deletion", async () => {
    const project = await create();
    const request = intent(project);
    const results = await Promise.all([remove(owner, request), remove(owner, request)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].revision).toBe(project.revision + 1);
    expect((await service.listEnterpriseProjects(owner)).projects.some(row => row.id === project.id)).toBe(false);
    await expect(service.resolveEnterpriseProjectScope(owner, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.createEnterpriseProject(owner, { name: project.name, clientRequestId: project.clientRequestId! })).rejects.toMatchObject({ code: "CONFLICT" });
    const [content] = await db.select().from(schema.enterpriseProjectDashboardContents).where(eq(schema.enterpriseProjectDashboardContents.enterpriseProjectId, project.id));
    expect(content).toBeDefined();
    await expect(remove(owner, { ...request, expectedRevision: results[0].revision })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("deletes the last project of an empty account without provisioning a monitoring account or replacement project", async () => {
    const username = `empty-${randomUUID().slice(0, 16)}`;
    await db.insert(schema.users).values({ username, role: "user" });
    const [row] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username));
    const actor = { id: row!.id, username, displayName: "无项目验收", role: "user" as const };
    expect(await service.listEnterpriseProjects(actor)).toEqual({ projects: [] });
    expect(await service.listEnterpriseProjects(actor)).toEqual({ projects: [] });
    const project = await service.createEnterpriseProject(actor, { name: "唯一企业项目", clientRequestId: randomUUID() });
    await remove(actor, intent(project));
    expect(await service.listEnterpriseProjects(actor)).toEqual({ projects: [] });
    expect(await service.listEnterpriseProjects(actor)).toEqual({ projects: [] });
    expect(await db.select().from(schema.monitoringAccountLinks).where(eq(schema.monitoringAccountLinks.dashboardUserId, actor.id))).toHaveLength(0);
    const retained = await db.select().from(schema.enterpriseProjects).where(eq(schema.enterpriseProjects.ownerUserId, actor.id));
    expect(retained).toHaveLength(1);
    expect(retained[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it("enforces owner, administrator assignment and optimistic revision", async () => {
    const project = await create();
    await expect(remove(stranger, intent(project))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const admin = { ...delivery, role: "admin" as const, adminAccessLevel: "delivery_admin" as const };
    await expect(remove(admin, intent(project))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const renamed = await service.renameEnterpriseProject(owner, { ...intent(project), name: "改名" });
    await expect(remove(owner, intent(project))).rejects.toMatchObject({ code: "CONFLICT" });
    await db.insert(schema.userAdminAssignments).values({ userId: owner.id, adminId: delivery.id });
    await expect(remove(admin, intent(renamed))).resolves.toMatchObject({ enterpriseProjectId: project.id });
    await expect(remove(stranger, intent(renamed))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects queued, unknown and pending-cost AI work, then retains settled billing", async () => {
    const project = await create();
    const op = operation(project.id);
    await db.insert(schema.agentOperations).values(op);
    await expect(remove(owner, intent(project))).rejects.toThrow("正在运行或待核算");
    await db.update(schema.agentOperations).set({ status: "attention_required" }).where(eq(schema.agentOperations.id, op.id));
    await expect(remove(owner, intent(project))).rejects.toThrow("AI 智能体");
    await db.update(schema.agentOperations).set({ status: "succeeded" }).where(eq(schema.agentOperations.id, op.id));
    const chargeId = randomUUID();
    await db.insert(schema.aiChargeCommands).values({ id: chargeId, localTaskId: randomUUID(), commandKey: "send", operationId: op.id, accountUserId: owner.id, walletUserId: walletOwner, enterpriseProjectId: project.id, sessionId: randomUUID(), model: "glm-5.3", effort: "high", pricingVersion: "test", state: "pending_cost" });
    await expect(remove(owner, intent(project))).rejects.toThrow("待核算");
    await db.update(schema.aiChargeCommands).set({ state: "settled", consumedTenThousandths: 37n }).where(eq(schema.aiChargeCommands.id, chargeId));
    await remove(owner, intent(project));
    const [retained] = await db.select().from(schema.aiChargeCommands).where(eq(schema.aiChargeCommands.id, chargeId));
    expect(retained?.consumedTenThousandths).toBe(37n);
    // Late accounting facts remain writable after UI deletion.
    await db.update(schema.aiChargeCommands).set({ consumedTenThousandths: 39n }).where(eq(schema.aiChargeCommands.id, chargeId));
    const [settled] = await db.select().from(schema.aiChargeCommands).where(eq(schema.aiChargeCommands.id, chargeId));
    expect(settled?.consumedTenThousandths).toBe(39n);
  });

  it("waits for admitted work and refuses deletion when that transaction commits", async () => {
    const project = await create();
    let admitted!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const work = db.transaction(async tx => {
      await assertEnterpriseProjectActive(tx, project.id, owner.id);
      admitted();
      await hold;
      await tx.insert(schema.agentOperations).values(operation(project.id));
    });
    await started;
    const deleting = remove(owner, intent(project));
    release();
    await work;
    await expect(deleting).rejects.toThrow("正在运行或待核算");
  });

  it("requires active monitoring and provider-unknown media orders to finish", async () => {
    const project = await create();
    const tables = await import("../../../packages/monitoring-db/src/schema");
    const projectId = randomUUID(), runId = randomUUID(), brandId = randomUUID(), monitorId = randomUUID(), versionId = randomUUID();
    await db.insert(tables.projects).values({ id: projectId, enterpriseProjectId: project.id, ownerId: walletOwner, name: "运行监控", timezone: "Asia/Shanghai" });
    await db.insert(tables.projectBrandVersions).values({ id: brandId, projectId, version: 1, mainBrand: "验收", aliases: [], competitors: [], createdBy: walletOwner });
    await db.insert(tables.monitors).values({ id: monitorId, ownerId: walletOwner, projectId, name: "验收" });
    await db.insert(tables.monitorVersions).values({ id: versionId, monitorId, projectBrandVersionId: brandId, version: 1, name: "验收", brandAliases: [], competitors: [], repetitions: 1, expectedAttempts: 1, configurationHash: "a".repeat(64), createdBy: walletOwner });
    await db.insert(tables.runs).values({ id: runId, ownerId: walletOwner, projectId, projectBrandVersionId: brandId, monitorId, monitorVersionId: versionId, trigger: "manual", idempotencyKey: randomUUID(), expectedAttempts: 1, status: "running" });
    await expect(remove(owner, intent(project))).rejects.toThrow("问题监控");
    await db.update(tables.runs).set({ status: "completed" }).where(eq(tables.runs.id, runId));
    const itemId = randomUUID(), batchId = randomUUID(), mediaResourceId = randomUUID();
    const { PublishingRepository } = await import("../../../packages/monitoring-db/src/publisher-repository");
    const { runWithMonitoringEnterpriseScope } = await import("../../../packages/monitoring-db/src/enterprise-scope");
    await runWithMonitoringEnterpriseScope({ enterpriseProjectId: project.id, ownerId: walletOwner }, async () => {
      const publishing = new PublishingRepository(db as never);
      const article = await publishing.createPublisherArticle(walletOwner, "测试文章");
      const saved = await publishing.savePublisherArticle(walletOwner, { articleId: article.id, expectedRevision: article.revision, workingName: article.workingName, editorJson: {}, canonicalHtml: "<p>测试文章</p>", plainText: "测试文章" });
      const version = await publishing.freezePublisherArticle(walletOwner, { articleId: article.id, expectedRevision: saved.revision, idempotencyKey: randomUUID() });
      const draft = await publishing.savePublisherDraft(walletOwner, { articleVersionId: version.id, expectedRevision: 0, items: [] });
      await db.insert(tables.publisherBatches).values({ id: batchId, ownerId: walletOwner, draftId: draft.id, articleVersionId: version.id, mode: "mock", quotedTotalTenThousandths: 10n, quoteFingerprint: "a".repeat(64), preflightRevision: "test", preflightSnapshot: {}, idempotencyKey: randomUUID() });
    });
    await db.insert(tables.publisherMediaResources).values({ id: mediaResourceId, externalResourceId: randomUUID(), catalogRevision: "test", name: "测试媒体", priceTenThousandths: 10n, rawPayload: {}, payloadHash: "a".repeat(64), logoCandidateHash: "a".repeat(64), lastSeenAt: new Date() });
    await db.insert(tables.publisherItems).values({ id: itemId, enterpriseProjectId: project.id, ownerId: walletOwner, batchId, mediaResourceId, externalResourceId: randomUUID(), mediaNameSnapshot: "测试媒体", mediaMetadataSnapshot: {}, submissionTitle: "测试文章", articleContentHash: "a".repeat(64), catalogRevision: "test", preflightBlockers: [], preflightWarnings: [], submissionKey: randomUUID(), status: "submission_unknown", fundsStatus: "frozen" });
    await expect(remove(owner, intent(project))).rejects.toThrow("媒体发布");
    await db.update(tables.publisherItems).set({ status: "failed" }).where(eq(tables.publisherItems.id, itemId));
    await expect(remove(owner, intent(project))).rejects.toThrow("待核算");
    await db.update(tables.publisherItems).set({ fundsStatus: "released" }).where(eq(tables.publisherItems.id, itemId));
    await remove(owner, intent(project));
    expect(await db.select().from(tables.runs).where(eq(tables.runs.id, runId))).toHaveLength(1);
    expect(await db.select().from(tables.publisherItems).where(eq(tables.publisherItems.id, itemId))).toHaveLength(1);
  });

  it("keeps knowledge and SiteOps tasks accessible until their outcomes are terminal", async () => {
    const project = await create();
    const turnId = randomUUID(), siteId = randomUUID(), operationId = randomUUID(), conversationId = randomUUID(), siteConversationId = randomUUID();
    await db.insert(schema.conversations).values([{ id: conversationId, enterpriseProjectId: project.id, userId: owner.id, title: "知识库验收" }, { id: siteConversationId, enterpriseProjectId: project.id, userId: owner.id, title: "建站验收" }]);
    await db.insert(schema.conversationTurns).values({ id: turnId, enterpriseProjectId: project.id, conversationId, userId: owner.id, clientRequestId: randomUUID(), status: "running" });
    await expect(remove(owner, intent(project))).rejects.toThrow("知识库或内容制作");
    await db.update(schema.conversationTurns).set({ status: "completed" }).where(eq(schema.conversationTurns.id, turnId));
    await db.insert(schema.siteProjects).values({ id: siteId, enterpriseProjectId: project.id, userId: owner.id, conversationId: siteConversationId });
    await db.insert(schema.siteOperations).values({ id: operationId, projectId: siteId, userId: owner.id, kind: "deploy", status: "outcome_unknown", clientRequestId: randomUUID(), inputHash: "a".repeat(64), input: {} });
    await expect(remove(owner, intent(project))).rejects.toThrow("建站或内容制作");
    await db.update(schema.siteOperations).set({ status: "succeeded" }).where(eq(schema.siteOperations.id, operationId));
    await expect(remove(owner, intent(project))).resolves.toMatchObject({ enterpriseProjectId: project.id });
  });

  it("pauses schedules and rejects stale AI, manual/worker monitoring and media admission", async () => {
    const project = await create();
    const monitorProjectId = randomUUID(), monitorId = randomUUID();
    await db.execute(sql`INSERT INTO projects (id, enterprise_project_id, owner_id, name, timezone) VALUES (${monitorProjectId}, ${project.id}, ${walletOwner}, '验收监控', 'Asia/Shanghai')`);
    await db.execute(sql`INSERT INTO monitors (id, owner_id, project_id, name, status, schedule_type, next_run_at) VALUES (${monitorId}, ${walletOwner}, ${monitorProjectId}, '自动计划', 'active', 'daily', NOW())`);
    await remove(owner, intent(project));
    const [paused] = await db.execute(sql`SELECT status, next_run_at FROM monitors WHERE id = ${monitorId}`) as unknown as [Array<{ status: string; next_run_at: Date | null }>];
    expect(paused[0]).toEqual({ status: "paused", next_run_at: null });
    await expect(db.transaction(tx => assertEnterpriseProjectActive(tx, project.id, owner.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { MonitoringRepository } = await import("../../../packages/monitoring-db/src/repositories");
    const { PublishingRepository } = await import("../../../packages/monitoring-db/src/publisher-repository");
    const { runWithMonitoringEnterpriseScope } = await import("../../../packages/monitoring-db/src/enterprise-scope");
    const monitoring = new MonitoringRepository(db as never);
    // No ALS scope, matching the scheduler; the stored project still blocks it.
    await expect(monitoring.createRun(walletOwner, monitorId, randomUUID(), "scheduled")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(monitoring.createRun(walletOwner, monitorId, randomUUID(), "manual")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(monitoring.setMonitorPaused(walletOwner, monitorId, false, {} as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const publishing = new PublishingRepository(db as never);
    await expect(runWithMonitoringEnterpriseScope({ enterpriseProjectId: project.id, ownerId: walletOwner }, () => publishing.submitPublisherDraft(walletOwner, { idempotencyKey: randomUUID() } as never))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
