import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, count } from "drizzle-orm";
import { getDb } from "./db";
import { deleteEnterpriseProject } from "./enterprise-project-deletion";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";
import {
  users,
  enterpriseProjects,
  enterpriseProjectQuestions,
  monitoringBatches,
  monitoringSamples,
  dashboardImportPreflights,
  workspaceAuditEvents,
  enterpriseProjectDashboardContents,
  userAdminAssignments,
} from "../drizzle/schema";
import {
  previewProjectMonitoringImport,
  commitProjectMonitoringImport,
  recoverProjectMonitoringImport,
  type ProjectMonitoringImportPlan,
} from "./project-monitoring-import-service";
import {
  issueProjectMonitoringPreflight,
  verifyProjectMonitoringPreflight,
} from "./dashboard-import-preflight-service";
import {
  listWorkspaceWorkRecords,
  decodeWorkRecordsCursor,
  encodeWorkRecordsCursor,
} from "./workspace-work-record-service";
import { workRecordResourceRef } from "./workspace-work-record-contract";
import {
  getMonitoringFilterOptions,
  listMonitoringSamples,
  getMonitoringCurrentTemplateBatches,
} from "./monitoring-service";
import { listMonitoringSamplesSchema } from "../shared/monitoring";
import type { AuthenticatedUser } from "./auth-service";

const mysqlUrl = process.env.FRONTMIND_MONITORING_IMPORT_TEST_MYSQL_URL;
describe("project monitoring public boundaries", () => {
  it("retains ordinary customer monitoring import denial", async () => {
    await expect(
      previewProjectMonitoringImport({
        actor: { id: 7, role: "user" } as AuthenticatedUser,
        userId: 7,
        revision: 0,
        fileHash: "a".repeat(64),
        plan: { operationKind: "import", batches: [] },
      }),
    ).rejects.toThrow("管理员");
  });
  it("binds and authenticates pagination and permits only customer result routes", () => {
    const cursor = encodeWorkRecordsCursor(
      "a".repeat(64),
      Date.now(),
      randomUUID(),
    );
    expect(decodeWorkRecordsCursor(cursor, "a".repeat(64))).toMatchObject({
      scope: "a".repeat(64),
    });
    expect(() => decodeWorkRecordsCursor(cursor, "b".repeat(64))).toThrow();
    expect(() =>
      decodeWorkRecordsCursor(`${cursor}x`, "a".repeat(64)),
    ).toThrow();
    expect(
      workRecordResourceRef(
        "monitoring",
        "project",
        "https://evil.test/admin?token=secret",
      ),
    ).toBe("/monitoring-system?enterpriseProjectId=project&monitoringData=1");
  });
});

describe.skipIf(!mysqlUrl)("project monitoring atomic MySQL imports", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let actor: AuthenticatedUser,
    ownerId: number,
    projectId: string,
    otherProjectId: string,
    questionId: string;
  const scope = () => ({
    enterpriseProjectId: projectId,
    ownerUserId: ownerId,
    actorUserId: actor.id,
    isLegacyDefault: false,
  });
  const scoped = <T>(action: () => T) =>
    runWithEnterpriseProjectScope(scope(), action);
  const scopedProject = <T>(id: string, action: () => T) =>
    runWithEnterpriseProjectScope(
      { ...scope(), enterpriseProjectId: id },
      action,
    );
  const request = (revision = 0, hash = "a".repeat(64)) => ({
    actor,
    userId: ownerId,
    revision,
    fileHash: hash,
  });
  const plan = (
    key: string,
    amount = 1,
    question = questionId,
  ): ProjectMonitoringImportPlan => ({
    operationKind: "import",
    batches: Array.from({ length: amount }, (_, i) => ({
      userId: ownerId,
      batchKey: `${key}:${i}`,
      sourceName: "验收监控.xlsx",
      collectedAt: "2026-09-10T02:00:00.000Z",
      samples: [
        {
          sourceRecordId: `answer-${i}`,
          questionId: question,
          platform: "DeepSeek",
          answerNo: 1,
          content: "真实回答",
          screenshotUrl: "",
          monitorRank: 2,
        },
      ],
      citations: [
        {
          sourceRecordId: `citation-${i}`,
          questionId: question,
          sampleSourceRecordId: `answer-${i}`,
          model: "deepseek",
          title: "引用",
          url: "https://example.com/evidence",
          media: "资料",
          domain: "example.com",
        },
      ],
    })),
  });
  beforeAll(async () => {
    const url = new URL(mysqlUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.includes("acceptance")
    )
      throw new Error("Requires a disposable local acceptance database");
    process.env.DATABASE_URL = mysqlUrl;
    db = (await getDb())!;
    const suffix = randomUUID().slice(0, 12);
    await db.insert(users).values([
      { username: `monitor-owner-${suffix}`, role: "user", isActive: true },
      {
        username: `monitor-admin-${suffix}`,
        role: "admin",
        adminAccessLevel: "delivery_admin",
        isActive: true,
      },
    ]);
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, `monitor-owner-${suffix}`));
    [actor] = (await db
      .select()
      .from(users)
      .where(
        eq(users.username, `monitor-admin-${suffix}`),
      )) as AuthenticatedUser[];
    ownerId = owner!.id;
    projectId = randomUUID();
    otherProjectId = randomUUID();
    questionId = randomUUID();
    await db.insert(userAdminAssignments).values({
      userId: ownerId,
      adminId: actor.id,
      assignedByUserId: actor.id,
    });
    await db.insert(enterpriseProjects).values([
      { id: projectId, ownerUserId: ownerId, name: "导入验收 A" },
      { id: otherProjectId, ownerUserId: ownerId, name: "导入验收 B" },
    ]);
    await db.insert(enterpriseProjectQuestions).values({
      id: questionId,
      enterpriseProjectId: projectId,
      userId: ownerId,
      question: "产品适合哪些客户？",
      category: "industry",
      status: "selected",
      ordinal: 1,
    });
  });
  it("keeps previews read-only and commits 105 batches once across concurrent nonces, then restores expired successful requests", async () => {
    const input = { ...request(), plan: plan("all", 105) };
    const before = (
      await db.select({ n: count() }).from(dashboardImportPreflights)
    )[0]!.n;
    const first = await scoped(() => previewProjectMonitoringImport(input));
    const second = await scoped(() => previewProjectMonitoringImport(input));
    expect(first.newBatchCount).toBe(105);
    expect(first.preflightToken).toBeTruthy();
    expect(
      (await db.select({ n: count() }).from(dashboardImportPreflights))[0]!.n,
    ).toBe(before);
    expect(
      await db
        .select()
        .from(monitoringBatches)
        .where(eq(monitoringBatches.userId, ownerId)),
    ).toHaveLength(0);
    const [one, two] = await Promise.all([
      scoped(() =>
        commitProjectMonitoringImport({
          ...input,
          token: first.preflightToken,
        }),
      ),
      scoped(() =>
        commitProjectMonitoringImport({
          ...input,
          token: second.preflightToken,
        }),
      ),
    ]);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(one.resultSummary.dashboardRevision).toBe(1);
    const batches = await db
      .select()
      .from(monitoringBatches)
      .where(eq(monitoringBatches.userId, ownerId));
    expect(batches).toHaveLength(105);
    expect(
      batches.every((row) => row.quotaPeriodId === null && row.revision === 1),
    ).toBe(true);
    expect(
      (
        await db
          .select({ n: count() })
          .from(dashboardImportPreflights)
          .where(eq(dashboardImportPreflights.workspaceUserId, ownerId))
      )[0]!.n,
    ).toBe(1);
    const records = await scoped(() =>
      listWorkspaceWorkRecords(actor, { module: "monitoring", limit: 20 }),
    );
    expect(records.records).toHaveLength(1);
    expect(Object.keys(records.records[0]!)).toEqual([
      "id",
      "module",
      "title",
      "summary",
      "status",
      "createdAt",
      "resourceRef",
    ]);
    expect(records.records[0]!.resourceRef).toContain(
      "monitoringBatchKey=all%3A0",
    );
    expect(
      (
        await runWithEnterpriseProjectScope(
          { ...scope(), enterpriseProjectId: otherProjectId },
          () =>
            listWorkspaceWorkRecords(actor, {
              module: "monitoring",
              limit: 20,
            }),
        )
      ).records,
    ).toHaveLength(0);
    expect(
      (await scoped(() => getMonitoringFilterOptions(ownerId))).batches,
    ).toHaveLength(105);
    expect(
      await scoped(() =>
        getMonitoringCurrentTemplateBatches({ actor, userId: ownerId }),
      ),
    ).toHaveLength(105);
    const page = await scoped(() =>
      listMonitoringSamples({
        userId: ownerId,
        filters: listMonitoringSamplesSchema.parse({ pageSize: 25 }),
      }),
    );
    expect(page.items).toHaveLength(25);
    expect(page.total).toBe(105);
    expect(page.totals).toMatchObject({
      sampleCount: 105,
      citationCount: 105,
      rankedSampleCount: 105,
      top3SampleCount: 105,
      averageRank: 2,
    });
    const verified = verifyProjectMonitoringPreflight({
      token: first.preflightToken,
      binding: {
        actorId: actor.id,
        workspaceUserId: ownerId,
        enterpriseProjectId: projectId,
        module: "monitoring",
        revision: 0,
        fileHash: input.fileHash,
      },
    });
    const expired = issueProjectMonitoringPreflight({
      binding: verified,
      now: new Date(Date.now() - 120_000),
      ttlSeconds: 60,
    });
    await db
      .update(enterpriseProjectDashboardContents)
      .set({ revision: 2 })
      .where(
        eq(enterpriseProjectDashboardContents.enterpriseProjectId, projectId),
      );
    const restored = await scoped(() =>
      recoverProjectMonitoringImport({
        ...request(),
        token: expired.preflightToken,
      }),
    );
    expect(restored?.replayed).toBe(true);
    expect(restored?.resultSummary.dashboardRevision).toBe(1);
    await expect(
      scoped(() =>
        recoverProjectMonitoringImport({
          ...request(),
          fileHash: "b".repeat(64),
          token: expired.preflightToken,
        }),
      ),
    ).rejects.toThrow();
    const unchanged = await scoped(() =>
      previewProjectMonitoringImport({ ...request(2), plan: input.plan }),
    );
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged.preflightToken).toBeUndefined();
  }, 60_000);
  async function freshDeleteFixture(label: string) {
    const id = randomUUID();
    const qid = randomUUID();
    await db
      .insert(enterpriseProjects)
      .values({ id, ownerUserId: ownerId, name: label });
    await db.insert(enterpriseProjectQuestions).values({
      id: qid,
      enterpriseProjectId: id,
      userId: ownerId,
      question: `${label}问题`,
      category: "industry",
      status: "selected",
      ordinal: 1,
    });
    return { id, qid };
  }
  it("serializes import before delete: import commits, then delete archives and preserves the batch", async () => {
    const fixture = await freshDeleteFixture("导入先行");
    const input = { ...request(), plan: plan("import-first", 1, fixture.qid) };
    const preview = await scopedProject(fixture.id, () =>
      previewProjectMonitoringImport(input),
    );
    const committed = await scopedProject(fixture.id, () =>
      commitProjectMonitoringImport({
        ...input,
        token: preview.preflightToken,
      }),
    );
    expect(committed.replayed).toBe(false);
    const deleted = await deleteEnterpriseProject(actor, {
      enterpriseProjectId: fixture.id,
      expectedRevision: 1,
    });
    expect(deleted.revision).toBe(2);
    expect(
      (
        await db
          .select()
          .from(monitoringBatches)
          .where(
            and(
              eq(monitoringBatches.enterpriseProjectId, fixture.id),
              eq(monitoringBatches.userId, ownerId),
            ),
          )
      ).length,
    ).toBe(1);
  }, 30_000);
  it("serializes delete before import: the waiting import is denied and consumes no nonce", async () => {
    const fixture = await freshDeleteFixture("删除先行");
    const input = { ...request(), plan: plan("delete-first", 1, fixture.qid) };
    const preview = await scopedProject(fixture.id, () =>
      previewProjectMonitoringImport(input),
    );
    const nonceBefore = Number(
      (await db.select({ n: count() }).from(dashboardImportPreflights)).at(0)
        ?.n ?? 0,
    );
    let release!: () => void;
    let signalLocked!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockReached = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const hold = db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1)
        .for("update");
      await tx
        .select({ id: enterpriseProjects.id })
        .from(enterpriseProjects)
        .where(eq(enterpriseProjects.id, fixture.id))
        .limit(1)
        .for("update");
      signalLocked();
      await held;
    });
    await lockReached;
    const deletion = deleteEnterpriseProject(actor, {
      enterpriseProjectId: fixture.id,
      expectedRevision: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const importing = scopedProject(fixture.id, () =>
      commitProjectMonitoringImport({
        ...input,
        token: preview.preflightToken,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await hold;
    await deletion;
    await expect(importing).rejects.toMatchObject({ code: "NOT_FOUND" });
    const nonceAfter = Number(
      (await db.select({ n: count() }).from(dashboardImportPreflights)).at(0)
        ?.n ?? 0,
    );
    expect(nonceAfter).toBe(nonceBefore);
    expect(
      await db
        .select()
        .from(monitoringBatches)
        .where(eq(monitoringBatches.enterpriseProjectId, fixture.id)),
    ).toHaveLength(0);
  }, 30_000);
  it("preserves exact citation links during an explicit revision-bound merge and paginates one record per successful operation", async () => {
    const mergePlan: ProjectMonitoringImportPlan = {
      operationKind: "merge-citations",
      targetBatchKey: "all:0",
      expectedBatchRevisions: { "all:0": 1 },
      batches: [
        {
          ...plan("new-citations").batches[0]!,
          samples: [],
          citations: [
            {
              sourceRecordId: "question-only",
              questionId,
              model: "deepseek",
              title: "问题级引用",
              url: "https://example.com/question",
              domain: "example.com",
              media: "资料",
              collectedAt: "2026-09-10T02:00:00.000Z",
            },
          ],
        },
      ],
    };
    const input = {
      ...request(2, "d".repeat(64)),
      targetBatchKey: "all:0",
      plan: mergePlan,
    };
    const preview = await scoped(() => previewProjectMonitoringImport(input));
    expect(preview).toMatchObject({
      updatedBatchCount: 1,
      sampleCount: 1,
      citationCount: 2,
    });
    const result = await scoped(() =>
      commitProjectMonitoringImport({
        ...input,
        token: preview.preflightToken,
      }),
    );
    expect(result.resultSummary.dashboardRevision).toBe(3);
    const current = await scoped(() =>
      getMonitoringCurrentTemplateBatches({ actor, userId: ownerId }),
    );
    const batch = current.find((row) => row.batchKey === "all:0")!;
    expect(batch.revision).toBe(2);
    expect(batch.citations).toHaveLength(2);
    expect(
      batch.citations.find((row) => row.sourceRecordId === "citation-0")
        ?.sampleSourceRecordId,
    ).toBe("answer-0");
    expect(
      batch.citations.find((row) => row.sourceRecordId === "question-only")
        ?.sampleSourceRecordId,
    ).toBeUndefined();
    const first = await scoped(() =>
      listWorkspaceWorkRecords(actor, { module: "monitoring", limit: 1 }),
    );
    const second = await scoped(() =>
      listWorkspaceWorkRecords(actor, {
        module: "monitoring",
        limit: 1,
        cursor: first.nextCursor!,
      }),
    );
    expect(first.nextCursor).toBeTruthy();
    expect(second.nextCursor).toBeNull();
    expect(first.records[0]?.id).not.toBe(second.records[0]?.id);
    const [customer] = await db
      .select()
      .from(users)
      .where(eq(users.id, ownerId));
    const customerRecords = await runWithEnterpriseProjectScope(
      { ...scope(), actorUserId: ownerId },
      () =>
        listWorkspaceWorkRecords(customer as AuthenticatedUser, {
          module: "monitoring",
          limit: 20,
        }),
    );
    expect(customerRecords.records).toHaveLength(2);
  }, 30_000);
  it("rolls back business rows, dashboard revision, nonce and audit on a late failure; refuses revoked assignments and archived projects", async () => {
    const input = { ...request(3, "c".repeat(64)), plan: plan("rollback") };
    const preview = await scoped(() => previewProjectMonitoringImport(input));
    // The audit writer fails only after real batch writes and nonce insertion.
    const brokenActor = {
      ...actor,
      username: undefined,
    } as unknown as AuthenticatedUser;
    await expect(
      scoped(() =>
        commitProjectMonitoringImport({
          ...input,
          actor: brokenActor,
          token: preview.preflightToken,
        }),
      ),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(monitoringBatches)
        .where(
          and(
            eq(monitoringBatches.userId, ownerId),
            eq(monitoringBatches.batchKey, "rollback:0"),
          ),
        ),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(enterpriseProjectDashboardContents)
          .where(
            eq(
              enterpriseProjectDashboardContents.enterpriseProjectId,
              projectId,
            ),
          )
      )[0]!.revision,
    ).toBe(3);
    const token = verifyProjectMonitoringPreflight({
      token: preview.preflightToken,
      binding: {
        actorId: actor.id,
        workspaceUserId: ownerId,
        enterpriseProjectId: projectId,
        module: "monitoring",
        revision: 3,
        fileHash: input.fileHash,
      },
    });
    expect(
      await db
        .select()
        .from(dashboardImportPreflights)
        .where(eq(dashboardImportPreflights.id, token.nonce)),
    ).toHaveLength(0);
    await db
      .delete(userAdminAssignments)
      .where(
        and(
          eq(userAdminAssignments.userId, ownerId),
          eq(userAdminAssignments.adminId, actor.id),
        ),
      );
    await expect(
      scoped(() =>
        commitProjectMonitoringImport({
          ...input,
          token: preview.preflightToken,
        }),
      ),
    ).rejects.toThrow();
    await db.insert(userAdminAssignments).values({
      userId: ownerId,
      adminId: actor.id,
      assignedByUserId: actor.id,
    });
    await db
      .update(enterpriseProjects)
      .set({ archivedAt: new Date() })
      .where(eq(enterpriseProjects.id, projectId));
    await expect(
      scoped(() =>
        commitProjectMonitoringImport({
          ...input,
          token: preview.preflightToken,
        }),
      ),
    ).rejects.toThrow("删除");
  }, 30_000);
});
