import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  users,
  enterpriseProjects,
  enterpriseProjectQuestions,
  responseLogicEntries,
} from "../drizzle/schema";
const dependencies = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../server/db", () => ({ getDb: dependencies.getDb }));
import { runWithEnterpriseProjectScope } from "../server/enterprise-project-scope";
import {
  selectEnterpriseQuestion,
  confirmEnterpriseQuestionIntent,
} from "../server/enterprise-project-questions";
import {
  saveResponseLogicEntry,
  listResponseLogicEntries,
} from "../server/response-logic-service";
import { getDashboardQuestion } from "../server/dashboard-service";
import { assertServiceCapability } from "../server/service-entitlement";
const url = process.env.FRONTMIND_RESPONSE_LOGIC_MYSQL_ACCEPTANCE_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("response logic in a migrated isolated MySQL project", () => {
  let pool: Pool;
  let executor: ReturnType<typeof drizzle>;
  let ownerId: number;
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const runId = randomUUID();
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      target.protocol !== "mysql:" ||
      !/^\/[A-Za-z0-9_]*frontmind_kb_acceptance[A-Za-z0-9_]*$/.test(
        target.pathname,
      ) ||
      target.search
    )
      throw new Error("DISPOSABLE_MYSQL_TARGET_REQUIRED");
    pool = mysql.createPool({ uri: url!, timezone: "Z", connectionLimit: 4 });
    pool.on("connection", (connection) => {
      connection.query("SET SESSION time_zone = '+00:00'");
    });
    const [tables] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('enterprise_projects','enterprise_project_questions','response_logic_entries')",
    );
    expect(Number(tables[0].count)).toBe(3);
    executor = drizzle(pool);
    dependencies.getDb.mockResolvedValue(executor);
    const result = await executor
      .insert(users)
      .values({
        openId: `rl-${runId}`,
        username: `rl-${runId}`,
        displayName: "Response logic acceptance",
      });
    ownerId = Number(result[0].insertId);
    await executor.insert(enterpriseProjects).values([
      { id: projectId, ownerUserId: ownerId, name: "应答逻辑隔离验收" },
      { id: otherProjectId, ownerUserId: ownerId, name: "另一个隔离项目" },
    ]);
  });
  afterAll(async () => {
    if (executor && ownerId) {
      await executor
        .delete(responseLogicEntries)
        .where(eq(responseLogicEntries.userId, ownerId));
      await executor
        .delete(enterpriseProjectQuestions)
        .where(eq(enterpriseProjectQuestions.userId, ownerId));
      await executor
        .delete(enterpriseProjects)
        .where(eq(enterpriseProjects.ownerUserId, ownerId));
      await executor.delete(users).where(eq(users.id, ownerId));
    }
    if (pool) await pool.end();
  });
  it("saves the first confirmed-project question draft, returns it in scope, and advances revisions without creating duplicates", async () => {
    const scope = {
      enterpriseProjectId: projectId,
      ownerUserId: ownerId,
      actorUserId: ownerId,
      isLegacyDefault: false,
    };
    await runWithEnterpriseProjectScope(scope, async () => {
      await expect(
        assertServiceCapability(ownerId, "responseLogic"),
      ).rejects.toMatchObject({
        code: "KNOWLEDGE_SNAPSHOT_NOT_FOUND",
        statusCode: 409,
        message: "请先完成并发布当前项目的知识库",
      });
      const selected = await selectEnterpriseQuestion({
        userId: ownerId,
        actorUserId: ownerId,
        question: "隔离企业适合哪些产品场景？",
        category: "product_scenario",
        clientRequestId: runId,
      });
      await executor
        .update(enterpriseProjectQuestions)
        .set({ intent: "明确产品适配边界" })
        .where(eq(enterpriseProjectQuestions.id, selected.id));
      const confirmedQuestion = await confirmEnterpriseQuestionIntent({
        userId: ownerId,
        questionId: selected.id,
        expectedRevision: selected.revision,
        expectedIntentRevision: selected.intentRevision,
      });
      expect(confirmedQuestion).toMatchObject({
        status: "selected",
        locked: true,
        selectionApprovalStatus: "approved",
        intentConfirmed: true,
      });
      const question = await getDashboardQuestion(ownerId, selected.id);
      expect(question).not.toBeNull();
      const { writeScope, ...questionFields } = question!;
      const value = {
        ...questionFields,
        conversationId: `rl-conversation-${runId}`,
        expectedRevision: 0,
        publish: false,
        draft: {
          concern: "适用场景",
          conclusion: "先确认业务边界",
          facts: "企业资料已核验",
          boundaries: "不做未经验证的承诺",
          pending: "",
          references: "",
          images: [],
          attachments: [],
        },
      };
      const first = await saveResponseLogicEntry({
        userId: ownerId,
        value,
        expectedQuestionScope: writeScope,
      });
      expect(first).toMatchObject({
        questionId: selected.id,
        revision: 1,
        version: 0,
        conversationId: value.conversationId,
      });
      expect(first.confirmed).toBeUndefined();
      const [stored] = await executor
        .select()
        .from(responseLogicEntries)
        .where(eq(responseLogicEntries.questionId, selected.id));
      expect(stored).toMatchObject({
        enterpriseProjectId: projectId,
        userId: ownerId,
        questionId: selected.id,
        revision: 1,
        status: "draft",
      });
      expect(await listResponseLogicEntries(ownerId)).toHaveLength(1);
      const second = await saveResponseLogicEntry({
        userId: ownerId,
        value: { ...value, expectedRevision: 1 },
        expectedQuestionScope: writeScope,
      });
      expect(second).toMatchObject({ id: first.id, revision: 2, version: 0 });
      await expect(
        saveResponseLogicEntry({
          userId: ownerId,
          value,
          expectedQuestionScope: writeScope,
        }),
      ).rejects.toMatchObject({
        responseLogicCode: "RESPONSE_LOGIC_REVISION_CONFLICT",
      });
      const published = await saveResponseLogicEntry({
        userId: ownerId,
        value: { ...value, expectedRevision: 2, publish: true },
        expectedQuestionScope: writeScope,
      });
      expect(published).toMatchObject({
        id: first.id,
        revision: 3,
        version: 1,
        confirmed: { version: 1, conclusion: value.draft.conclusion },
      });
      const [publishedRow] = await executor
        .select()
        .from(responseLogicEntries)
        .where(eq(responseLogicEntries.id, first.id));
      expect(publishedRow).toMatchObject({
        enterpriseProjectId: projectId,
        revision: 3,
        version: 1,
        status: "confirmed",
      });
      await expect(
        saveResponseLogicEntry({
          userId: ownerId,
          value: { ...value, expectedRevision: 3 },
          expectedQuestionScope: writeScope,
        }),
      ).rejects.toMatchObject({
        responseLogicCode: "RESPONSE_LOGIC_ALREADY_CONFIRMED",
      });
      expect(await listResponseLogicEntries(ownerId)).toHaveLength(1);
      console.info(
        "RESPONSE_LOGIC_MYSQL_COMPLETE",
        JSON.stringify({
          projectId,
          questionId: selected.id,
          firstRevision: first.revision,
          secondRevision: second.revision,
          publicationVersion: published.version,
          rowCount: 1,
        }),
      );
    });
    await runWithEnterpriseProjectScope(
      { ...scope, enterpriseProjectId: otherProjectId },
      async () => {
        expect(await listResponseLogicEntries(ownerId)).toEqual([]);
      },
    );
  });
});
