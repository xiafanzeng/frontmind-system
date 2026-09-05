import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  deliveryTicketEvents,
  deliveryTickets,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  responseLogicEntries,
  serviceContracts,
  serviceQuotaPeriods,
  userDashboardContents,
  workspaceQuestions,
} from "../drizzle/schema";
import { DELIVERY_TICKET_LIMITS } from "../shared/delivery-ticket";

const dependencies = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("../server/db", () => ({ getDb: dependencies.getDb }));

import {
  assertQuestionSelectionWithinQuota,
  confirmWorkspaceBrandKeywordSelection,
  createServiceQuotaWindows,
  getServiceContractTermEnd,
  getServicePortal,
  reconcileActivatedProgressiveLuxuryRenewal,
  upsertServiceContract,
} from "../server/service-entitlement";

const ACCEPTANCE_ENV =
  "FRONTMIND_SERVICE_ENTITLEMENT_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_SERVICE_ENTITLEMENT_MYSQL_ACCEPTANCE_REQUIRED";
const DATABASE_MARKER = "frontmind_service_entitlement_acceptance";
const QUESTION_ANCHOR_ORDINAL = 0;

type AcceptanceTarget = { url: string; databaseName: string };

export function parseServiceEntitlementMysqlAcceptanceTarget(
  rawValue: string | undefined,
): AcceptanceTarget {
  const value = rawValue?.trim();
  if (!value) throw new Error(`${ACCEPTANCE_ENV}_MISSING`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_INVALID`);
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error(`${ACCEPTANCE_ENV}_MUST_USE_MYSQL`);
  }
  if (
    [...parsed.searchParams.keys()].some((key) =>
      ["database", "schema", "db"].includes(key.toLowerCase()),
    )
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_OVERRIDE_FORBIDDEN`);
  }
  const encodedDatabaseName = parsed.pathname.replace(/^\/+/, "");
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(encodedDatabaseName);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_INVALID`);
  }
  if (
    !databaseName ||
    databaseName.includes("/") ||
    !/^[A-Za-z0-9_$-]+$/u.test(databaseName) ||
    !databaseName.toLowerCase().includes(DATABASE_MARKER)
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_NOT_DISPOSABLE`);
  }
  return { url: value, databaseName };
}

describe("service-entitlement MySQL acceptance URL guard", () => {
  it("accepts only its dedicated disposable MySQL database", () => {
    expect(
      parseServiceEntitlementMysqlAcceptanceTarget(
        "mysql://tester:secret@127.0.0.1:3306/frontmind_service_entitlement_acceptance_ci_01",
      ).databaseName,
    ).toBe("frontmind_service_entitlement_acceptance_ci_01");
    for (const unsafe of [
      undefined,
      "postgres://tester:secret@127.0.0.1/frontmind_service_entitlement_acceptance",
      "mysql://tester:secret@127.0.0.1/frontmind_production",
      "mysql://tester:secret@127.0.0.1/frontmind_service_entitlement_acceptance/other",
      "mysql://tester:secret@127.0.0.1/frontmind_service_entitlement_acceptance?database=frontmind_production",
    ]) {
      expect(() =>
        parseServiceEntitlementMysqlAcceptanceTarget(unsafe),
      ).toThrow();
    }
  });
});

const acceptanceUrl = process.env[ACCEPTANCE_ENV]?.trim();
if (process.env[REQUIRED_ENV] === "1" && !acceptanceUrl) {
  throw new Error(`${ACCEPTANCE_ENV}_REQUIRED_FOR_RELEASE_GATE`);
}
const mysqlDescribe = acceptanceUrl ? describe.sequential : describe.skip;

mysqlDescribe("service-entitlement real MySQL 8.4 acceptance", () => {
  let pool: Pool;
  let executor: ReturnType<typeof drizzle>;
  const runId = randomUUID().replaceAll("-", "");

  async function insertUser(label: string) {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users (openId, username, displayName)
       VALUES (?, ?, ?)`,
      [
        `service-mysql-${label}-${runId}`.slice(0, 64),
        `service_mysql_${label}_${runId}`.slice(0, 64),
        `Service MySQL ${label}`,
      ],
    );
    return result.insertId;
  }

  async function createProgressiveLuxuryContract(input: {
    userId: number;
    startsAt: Date;
    sourceReference: string;
    expectedRevision?: number;
    status?: "active" | "scheduled";
    sourceContractIds?: string[];
    now?: Date;
  }) {
    await upsertServiceContract({
      userId: input.userId,
      planCode: "luxury",
      expectedRevision: input.expectedRevision ?? 0,
      startsAt: input.startsAt,
      status: input.status ?? "active",
      source: "admin",
      sourceReference: input.sourceReference,
      prepaidMonths: 3,
      signedAt: input.now ?? input.startsAt,
      signatoryId: "mysql-acceptance-legal-entity",
      sourceContractIds: input.sourceContractIds,
      now: input.now ?? input.startsAt,
    });
    const rows = await executor
      .select()
      .from(serviceContracts)
      .where(eq(serviceContracts.userId, input.userId))
      .orderBy(asc(serviceContracts.revision));
    const contract = rows.find(
      (row) => row.sourceReference === input.sourceReference,
    );
    expect(contract).toBeDefined();
    return contract!;
  }

  beforeAll(async () => {
    const target = parseServiceEntitlementMysqlAcceptanceTarget(acceptanceUrl);
    pool = mysql.createPool({
      uri: target.url,
      connectionLimit: 12,
      multipleStatements: false,
      timezone: "Z",
    });
    const [databaseRows] = await pool.query<RowDataPacket[]>(
      "SELECT DATABASE() AS databaseName",
    );
    expect(String(databaseRows[0]?.databaseName || "")).toBe(
      target.databaseName,
    );
    const [preMigrationRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS tableCount
       FROM information_schema.tables
       WHERE table_schema = DATABASE()`,
    );
    if (Number(preMigrationRows[0]?.tableCount || 0) !== 0) {
      throw new Error(`${ACCEPTANCE_ENV}_DATABASE_MUST_BE_EMPTY`);
    }

    executor = drizzle(pool);
    dependencies.getDb.mockResolvedValue(executor);
    await migrate(executor, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
    const journal = JSON.parse(
      await readFile(
        path.resolve(process.cwd(), "drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: unknown[] };
    const [ledgerRows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
    );
    expect(Number(ledgerRows[0]?.migrationCount || 0)).toBe(
      journal.entries.length,
    );
    const [engineRows] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (
           'service_contracts', 'service_quota_periods',
           'workspace_questions', 'delivery_tickets',
           'delivery_ticket_events'
         )`,
    );
    expect(engineRows).toHaveLength(5);
    expect(engineRows.every((row) => row.engine === "InnoDB")).toBe(true);
  }, 300_000);

  afterAll(async () => {
    dependencies.getDb.mockReset();
    if (pool) await pool.end();
  }, 60_000);

  it("persists legacy v1 and actual progressive v2 contracts with exact readback", async () => {
    const legacyUserId = await insertUser("legacy");
    const legacyContractId = randomUUID();
    const legacyStart = new Date("2026-01-31T05:30:00.000Z");
    const legacyWindows = createServiceQuotaWindows("luxury", legacyStart, {
      planVersion: 1,
    });
    expect(legacyWindows).toHaveLength(3);
    await executor.insert(serviceContracts).values({
      id: legacyContractId,
      userId: legacyUserId,
      planCode: "luxury",
      planVersion: 1,
      status: "active",
      startsAt: legacyStart,
      endsAt: getServiceContractTermEnd("luxury", legacyStart, {
        planVersion: 1,
      }),
      source: "admin",
      prepaidMonths: 3,
      sourceReference: `legacy-${runId}`,
      revision: 1,
    });
    await executor.insert(serviceQuotaPeriods).values(
      legacyWindows.map((window) => ({
        id: randomUUID(),
        contractId: legacyContractId,
        userId: legacyUserId,
        ordinal: window.ordinal,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        ...window.limits,
        contentAssetPublishLimit:
          DELIVERY_TICKET_LIMITS.luxury.content_asset_publish,
        websiteContentPublishLimit:
          DELIVERY_TICKET_LIMITS.luxury.website_content_publish,
      })),
    );

    const legacyPortal = await getServicePortal(legacyUserId, {
      now: new Date("2026-02-15T00:00:00.000Z"),
    });
    expect(legacyPortal.service).toMatchObject({
      contractId: legacyContractId,
      planCode: "luxury",
      planVersion: 1,
      status: "active",
    });
    expect(legacyPortal.quotaPeriods).toHaveLength(1);
    expect(legacyPortal.quotas).toMatchObject({
      limits: { totalQuestionLimit: 32 },
      entitlementLimits: { totalQuestionLimit: 32 },
      unlockStage: { current: 1, total: 1 },
      nextUnlockAt: null,
    });

    const v2Start = getServiceContractTermEnd("luxury", legacyStart, {
      planVersion: 1,
    });
    const v2Contract = await createProgressiveLuxuryContract({
      userId: legacyUserId,
      startsAt: v2Start,
      sourceReference: `progressive-${runId}`,
      expectedRevision: 1,
      status: "scheduled",
      sourceContractIds: [legacyContractId],
      now: legacyStart,
    });
    expect(v2Contract).toMatchObject({
      planCode: "luxury",
      planVersion: 2,
      status: "scheduled",
      prepaidMonths: 3,
      replacesContractIds: [legacyContractId],
      revision: 2,
    });
    expect(v2Contract.endsAt.toISOString()).toBe("2027-04-30T05:30:00.000Z");
    const persistedPeriods = await executor
      .select()
      .from(serviceQuotaPeriods)
      .where(eq(serviceQuotaPeriods.contractId, v2Contract.id))
      .orderBy(asc(serviceQuotaPeriods.ordinal));
    expect(persistedPeriods.map((period) => period.ordinal)).toEqual(
      Array.from({ length: 13 }, (_, ordinal) => ordinal),
    );
    const [anchor, ...operationalPeriods] = persistedPeriods;
    expect(anchor).toMatchObject({
      ordinal: QUESTION_ANCHOR_ORDINAL,
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      totalQuestionLimit: 8,
      contentAssetPublishLimit: 0,
      websiteContentPublishLimit: 0,
    });
    expect(anchor!.startsAt.getTime()).toBe(v2Contract.startsAt.getTime());
    expect(anchor!.endsAt.getTime()).toBe(v2Contract.endsAt.getTime());
    expect(operationalPeriods).toHaveLength(12);
    expect(
      operationalPeriods.map((period) => period.totalQuestionLimit),
    ).toEqual([8, 8, 8, 16, 16, 16, 24, 24, 24, 32, 32, 32]);
    expect(
      operationalPeriods.every(
        (period) =>
          period.contentAssetPublishLimit ===
            DELIVERY_TICKET_LIMITS.luxury.content_asset_publish &&
          period.websiteContentPublishLimit ===
            DELIVERY_TICKET_LIMITS.luxury.website_content_publish,
      ),
    ).toBe(true);
    expect(operationalPeriods[0]!.startsAt.getTime()).toBe(
      v2Contract.startsAt.getTime(),
    );
    expect(operationalPeriods.at(-1)!.endsAt.getTime()).toBe(
      v2Contract.endsAt.getTime(),
    );
    for (let index = 0; index < operationalPeriods.length - 1; index += 1) {
      expect(operationalPeriods[index]!.endsAt.getTime()).toBe(
        operationalPeriods[index + 1]!.startsAt.getTime(),
      );
    }

    const v2Portal = await getServicePortal(legacyUserId, { now: v2Start });
    expect(v2Portal.service).toMatchObject({
      contractId: v2Contract.id,
      planCode: "luxury",
      planVersion: 2,
      status: "active",
    });
    expect(v2Portal.purchases).toHaveLength(2);
    expect(v2Portal.quotaPeriods).toHaveLength(1);
    expect(v2Portal.quotas).toMatchObject({
      limits: { totalQuestionLimit: 8 },
      entitlementLimits: { totalQuestionLimit: 32 },
      unlockStage: { current: 1, total: 4 },
    });
  }, 60_000);

  it("keeps a frozen previous reader readable and fail-closed on v2 rows", async () => {
    const userId = await insertUser("previous-reader");
    const startsAt = new Date("2026-01-31T05:30:00.000Z");
    const contract = await createProgressiveLuxuryContract({
      userId,
      startsAt,
      sourceReference: `previous-reader-${runId}`,
    });
    const periods = await executor
      .select()
      .from(serviceQuotaPeriods)
      .where(eq(serviceQuotaPeriods.contractId, contract.id))
      .orderBy(asc(serviceQuotaPeriods.ordinal));
    const anchor = periods.find(
      (period) => period.ordinal === QUESTION_ANCHOR_ORDINAL,
    );
    expect(anchor).toBeDefined();
    const q2Now = new Date("2026-05-15T00:00:00.000Z");
    await executor.insert(workspaceQuestions).values(
      Array.from({ length: 9 }, (_, index) => ({
        id: randomUUID(),
        userId,
        contractId: contract.id,
        quotaPeriodId: anchor!.id,
        candidateKey: `previous-reader:${runId}:${index}`,
        category:
          index === 0 ? ("industry" as const) : ("product_scenario" as const),
        question: `Previous reader acceptance question ${index + 1}`,
        source: "admin" as const,
        status: "selected" as const,
        selectionApprovalStatus: "approved" as const,
        locked: true,
        sourceTaskId: `previous-reader-${runId}`,
        ordinal: index,
        selectedAt: q2Now,
      })),
    );

    // Frozen SQL projection from the previous Dashboard reader: every active
    // period is loaded and the first `(startsAt, ordinal)` row supplies limits.
    const [previousActivePeriods] = await pool.execute<RowDataPacket[]>(
      `SELECT id, ordinal, industryLimit, competitorComparisonLimit,
              reputationLimit, productScenarioLimit, totalQuestionLimit,
              startsAt, endsAt
       FROM service_quota_periods
       WHERE contractId = ? AND startsAt <= ? AND endsAt > ?
       ORDER BY startsAt ASC, ordinal ASC`,
      [contract.id, q2Now, q2Now],
    );
    expect(previousActivePeriods.map((row) => Number(row.ordinal))).toEqual([
      0, 4,
    ]);
    const previousReaderPeriodIds = previousActivePeriods.map((row) =>
      String(row.id),
    );
    const placeholders = previousReaderPeriodIds.map(() => "?").join(", ");
    const [previousVisibleQuestions] = await pool.execute<RowDataPacket[]>(
      `SELECT id, quotaPeriodId
       FROM workspace_questions
       WHERE userId = ? AND status = 'selected'
         AND quotaPeriodId IN (${placeholders})
       ORDER BY ordinal ASC`,
      [userId, ...previousReaderPeriodIds],
    );
    expect(previousVisibleQuestions).toHaveLength(9);
    expect(
      previousVisibleQuestions.every(
        (row) => String(row.quotaPeriodId) === anchor!.id,
      ),
    ).toBe(true);
    const previousStoredLimit = Number(
      previousActivePeriods[0]?.totalQuestionLimit,
    );
    expect(previousStoredLimit).toBe(8);
    expect(previousVisibleQuestions.length < previousStoredLimit).toBe(false);
    expect(() =>
      assertQuestionSelectionWithinQuota({
        limits: {
          industryLimit: Number(previousActivePeriods[0]?.industryLimit ?? 1),
          competitorComparisonLimit: Number(
            previousActivePeriods[0]?.competitorComparisonLimit ?? 1,
          ),
          reputationLimit: Number(
            previousActivePeriods[0]?.reputationLimit ?? 1,
          ),
          productScenarioLimit: Number(
            previousActivePeriods[0]?.productScenarioLimit ?? 5,
          ),
          totalQuestionLimit: previousStoredLimit,
        },
        usage: {
          industry: 1,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 8,
          total: previousVisibleQuestions.length,
        },
        category: "competitor_comparison",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "QUESTION_TOTAL_QUOTA_EXCEEDED" }),
    );

    const currentPortal = await getServicePortal(userId, { now: q2Now });
    expect(currentPortal.service.planVersion).toBe(2);
    expect(currentPortal.purchasedQuestions).toHaveLength(9);
    expect(currentPortal.quotaPeriods).toHaveLength(1);
    expect(currentPortal.quotas).toMatchObject({
      limits: { totalQuestionLimit: 16 },
      usage: { total: 9 },
      unlockStage: { current: 2, total: 4 },
    });
  }, 60_000);

  it("reconciles one due renewal exactly once across concurrent workers", async () => {
    const userId = await insertUser("renewal");
    const sourceStartsAt = new Date("2026-01-31T05:30:00.000Z");
    const source = await createProgressiveLuxuryContract({
      userId,
      startsAt: sourceStartsAt,
      sourceReference: `renewal-source-${runId}`,
    });
    const target = await createProgressiveLuxuryContract({
      userId,
      startsAt: source.endsAt,
      sourceReference: `renewal-target-${runId}`,
      expectedRevision: 1,
      status: "scheduled",
      sourceContractIds: [source.id],
      now: sourceStartsAt,
    });
    expect(target).toMatchObject({
      planVersion: 2,
      status: "scheduled",
      replacesContractIds: [source.id],
      revision: 2,
    });
    const sourcePeriods = await executor
      .select()
      .from(serviceQuotaPeriods)
      .where(eq(serviceQuotaPeriods.contractId, source.id))
      .orderBy(asc(serviceQuotaPeriods.ordinal));
    const sourceAnchor = sourcePeriods.find(
      (period) => period.ordinal === QUESTION_ANCHOR_ORDINAL,
    );
    const sourceOperationalPeriod = sourcePeriods.find(
      (period) => period.ordinal === 1,
    );
    expect(sourceAnchor).toBeDefined();
    expect(sourceOperationalPeriod).toBeDefined();

    const pendingQuestionId = randomUUID();
    await executor.insert(workspaceQuestions).values({
      id: pendingQuestionId,
      userId,
      contractId: source.id,
      quotaPeriodId: sourceAnchor!.id,
      candidateKey: `renewal-pending-${runId}`,
      category: "industry",
      question: "Pending source-year question",
      source: "user",
      status: "candidate",
      selectionApprovalStatus: "pending",
      selectionRequestedAt: source.endsAt,
      locked: false,
      sourceTaskId: `renewal-${runId}`,
    });
    const ticketId = randomUUID();
    await executor.insert(deliveryTickets).values({
      id: ticketId,
      userId,
      contractId: source.id,
      quotaPeriodId: sourceOperationalPeriod!.id,
      type: "knowledge_base",
      ordinal: 1,
      clientRequestId: randomUUID(),
      operation: "question_catalog",
      title: "Source-year question workflow",
      status: "submitted",
      quotaState: "reserved",
      technicalDedupeKey: `renewal:${runId}`,
    });

    let readyCount = 0;
    let releaseWorkers!: () => void;
    const bothWorkersReady = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    const runWorker = () =>
      executor.transaction(async (tx) => {
        readyCount += 1;
        if (readyCount === 2) releaseWorkers();
        await bothWorkersReady;
        return reconcileActivatedProgressiveLuxuryRenewal({
          executor: tx,
          userId,
          targetContractId: target.id,
          now: source.endsAt,
        });
      });
    const results = await Promise.all([runWorker(), runWorker()]);
    for (const key of [
      "reconciledContractCount",
      "supersededSourceContractCount",
      "archivedPendingQuestionCount",
      "cancelledQuestionWorkflowTicketCount",
    ] as const) {
      expect(results.reduce((sum, value) => sum + value[key], 0)).toBe(1);
    }

    const [persistedSource, persistedTarget] = await Promise.all([
      executor
        .select()
        .from(serviceContracts)
        .where(eq(serviceContracts.id, source.id))
        .then((rows) => rows[0]),
      executor
        .select()
        .from(serviceContracts)
        .where(eq(serviceContracts.id, target.id))
        .then((rows) => rows[0]),
    ]);
    expect(persistedSource?.status).toBe("superseded");
    expect(persistedTarget?.status).toBe("active");
    const [persistedQuestion] = await executor
      .select()
      .from(workspaceQuestions)
      .where(eq(workspaceQuestions.id, pendingQuestionId));
    expect(persistedQuestion).toMatchObject({
      status: "archived",
      selectionApprovalStatus: "not_requested",
      locked: false,
      revision: 2,
    });
    expect(persistedQuestion?.archivedAt?.getTime()).toBe(
      source.endsAt.getTime(),
    );
    const [persistedTicket] = await executor
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, ticketId));
    expect(persistedTicket).toMatchObject({
      status: "cancelled",
      revision: 2,
      technicalDedupeKey: null,
    });
    expect(persistedTicket?.resolvedAt?.getTime()).toBe(
      source.endsAt.getTime(),
    );
    const events = await executor
      .select()
      .from(deliveryTicketEvents)
      .where(eq(deliveryTicketEvents.ticketId, ticketId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId,
      actorUserId: null,
      actorRole: "system",
      kind: "status_change",
      visibility: "customer",
      fromStatus: "submitted",
      toStatus: "cancelled",
    });

    await expect(
      executor.transaction((tx) =>
        reconcileActivatedProgressiveLuxuryRenewal({
          executor: tx,
          userId,
          targetContractId: target.id,
          now: new Date(source.endsAt.getTime() + 60_000),
        }),
      ),
    ).resolves.toEqual({
      scannedContractCount: 1,
      reconciledContractCount: 0,
      supersededSourceContractCount: 0,
      archivedPendingQuestionCount: 0,
      cancelledQuestionWorkflowTicketCount: 0,
    });
    const repeatedEvents = await executor
      .select()
      .from(deliveryTicketEvents)
      .where(eq(deliveryTicketEvents.ticketId, ticketId));
    expect(repeatedEvents).toHaveLength(1);
  }, 60_000);

  it("retires archived brand-keyword generations and creates one clean replacement", async () => {
    const userId = await insertUser("brand-keyword-reselect");
    const selectedAt = new Date("2026-08-19T15:36:00.000Z");
    const contract = await createProgressiveLuxuryContract({
      userId,
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      sourceReference: `brand-keyword-reselect-${runId}`,
      now: selectedAt,
    });
    const dashboardRevision = 1;
    const tableId = "问题列表-1";
    const rowIndex = 0;
    const question = "国内第三方软件测评机构推荐";
    const category = "industry" as const;
    const canonicalCandidateKey = `brand-keyword:${tableId}:${rowIndex}`;
    const canonicalSourceTaskId = `dashboard:${dashboardRevision}`;

    await executor.insert(userDashboardContents).values({
      userId,
      revision: dashboardRevision,
      updatedByUserId: userId,
      payload: {
        brandName: "一航网络",
        headline: "一航网络品牌看板",
        keywordTables: [
          {
            id: tableId,
            title: "品牌全域词库",
            columns: ["序号", "问题", "主分类", "问题细分"],
            rows: [["1", question, "行业排名词", "机构推荐"]],
          },
        ],
      },
    });

    const knowledgeBuildId = randomUUID();
    const knowledgeSnapshotId = randomUUID();
    const knowledgeRevision = 8;
    const knowledgeTaskId = `kb-package-task-${runId}`;
    const knowledgeDescriptorHash = "d".repeat(64);
    const knowledgeArchiveHash = "a".repeat(64);
    const knowledgeBuildCreatedAt = new Date("2026-08-01T01:00:00.000Z");
    const knowledgePublishedAt = new Date("2026-08-02T00:00:00.000Z");
    await executor.insert(knowledgeBaseSnapshots).values({
      id: knowledgeSnapshotId,
      userId,
      version: 1,
      sourceFileName: "authenticated-knowledge-acceptance.zip",
      sourceBuildId: knowledgeBuildId,
      sourceBuildRevision: knowledgeRevision,
      sourceTaskId: knowledgeTaskId,
      sourceArtifactHash: knowledgeDescriptorHash,
      archiveHash: knowledgeArchiveHash,
      documents: [],
      assets: [],
      status: "active",
      createdByUserId: userId,
      createdAt: knowledgePublishedAt,
    });
    await executor.insert(knowledgeBaseBuilds).values({
      id: knowledgeBuildId,
      userId,
      conversationId: `kb-conversation-${runId}`,
      companyName: "一航网络",
      upstreamTaskId: knowledgeTaskId,
      status: "published",
      revision: knowledgeRevision,
      currentLeafId: null,
      totalNodeCount: knowledgeRevision,
      confirmedCount: knowledgeRevision,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      packageRevision: knowledgeRevision,
      packageTaskId: knowledgeTaskId,
      packageDescriptorHash: knowledgeDescriptorHash,
      publishedSnapshotId: knowledgeSnapshotId,
      treePolicyVersion: 1,
      createdAt: knowledgeBuildCreatedAt,
      completedAt: knowledgePublishedAt,
      publishedAt: knowledgePublishedAt,
    });

    const authenticatedPortal = await getServicePortal(userId, {
      now: selectedAt,
    });
    expect(authenticatedPortal.knowledge).toMatchObject({
      version: 1,
      authenticatedVersion: 1,
      authenticatedForCurrentService: true,
      status: "display_ready",
    });

    const select = (now: Date) =>
      confirmWorkspaceBrandKeywordSelection({
        userId,
        actorUserId: userId,
        dashboardRevision,
        tableId,
        rowIndex,
        expectedQuestion: question,
        expectedCategory: category,
        now,
      });
    const archive = async (questionId: string, revision: number, now: Date) => {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE workspace_questions
         SET status = 'archived', locked = 0, archivedAt = ?,
             revision = revision + 1, updatedAt = ?
         WHERE id = ? AND revision = ?`,
        [now, now, questionId, revision],
      );
      expect(result.affectedRows).toBe(1);
    };

    const first = await select(selectedAt);
    expect(first).toMatchObject({
      category,
      question,
      status: "selected",
      selectionApprovalStatus: "approved",
      locked: true,
      revision: 1,
    });
    const [firstPersisted] = await executor
      .select()
      .from(workspaceQuestions)
      .where(eq(workspaceQuestions.id, first.id));
    expect(firstPersisted).toMatchObject({
      candidateKey: canonicalCandidateKey,
      sourceTaskId: canonicalSourceTaskId,
      sourceQuestionId: null,
    });

    const oldConversationId = `response-logic-conversation-${runId}`;
    const oldTaskId = `response-logic-task-${runId}`;
    await executor.insert(responseLogicEntries).values({
      id: randomUUID(),
      userId,
      questionId: first.id,
      groupId: "industry",
      groupTitle: "行业排名词",
      question,
      intent: "旧问题意图",
      summary: "旧应答逻辑摘要",
      conversationId: oldConversationId,
      lastTaskId: oldTaskId,
      draft: {
        concern: "旧问题关切",
        conclusion: "旧问题结论",
        facts: "旧问题事实",
        pending: "",
        boundaries: "旧问题边界",
        references: "",
        images: [],
        attachments: [],
      },
      status: "draft",
      revision: 3,
    });

    const firstArchivedAt = new Date("2026-08-19T15:37:00.000Z");
    await archive(first.id, first.revision, firstArchivedAt);
    const concurrentAt = new Date("2026-08-19T15:38:00.000Z");
    const [concurrentLeft, concurrentRight] = await Promise.all([
      select(concurrentAt),
      select(concurrentAt),
    ]);
    expect(concurrentLeft.id).toBe(concurrentRight.id);
    const second = concurrentLeft;
    expect(second.id).not.toBe(first.id);

    const [firstAfterReselect, secondPersisted] = await Promise.all([
      executor
        .select()
        .from(workspaceQuestions)
        .where(eq(workspaceQuestions.id, first.id))
        .then((rows) => rows[0]),
      executor
        .select()
        .from(workspaceQuestions)
        .where(eq(workspaceQuestions.id, second.id))
        .then((rows) => rows[0]),
    ]);
    expect(firstAfterReselect).toMatchObject({
      status: "archived",
      locked: false,
      candidateKey: `${canonicalCandidateKey}:archived:${first.id}`,
      revision: first.revision + 2,
      archivedAt: firstArchivedAt,
    });
    expect(secondPersisted).toMatchObject({
      candidateKey: canonicalCandidateKey,
      sourceTaskId: canonicalSourceTaskId,
      sourceQuestionId: null,
      intent: null,
      rationale: null,
      evidence: [],
      risks: [],
      knowledgeSnapshotId: null,
      status: "selected",
      selectionApprovalStatus: "approved",
      locked: true,
      revision: 1,
    });

    const oldResponseLogic = await executor
      .select()
      .from(responseLogicEntries)
      .where(eq(responseLogicEntries.userId, userId));
    expect(oldResponseLogic).toHaveLength(1);
    expect(oldResponseLogic[0]).toMatchObject({
      questionId: first.id,
      conversationId: oldConversationId,
      lastTaskId: oldTaskId,
      revision: 3,
    });
    expect(oldResponseLogic[0]?.questionId).not.toBe(second.id);

    const secondArchivedAt = new Date("2026-08-19T15:39:00.000Z");
    await archive(second.id, second.revision, secondArchivedAt);
    const third = await select(new Date("2026-08-19T15:40:00.000Z"));
    expect(third.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);
    await expect(
      select(new Date("2026-08-19T15:41:00.000Z")),
    ).resolves.toMatchObject({ id: third.id, revision: third.revision });

    const allGenerations = await executor
      .select()
      .from(workspaceQuestions)
      .where(eq(workspaceQuestions.userId, userId));
    expect(allGenerations).toHaveLength(3);
    const generationsById = new Map(
      allGenerations.map((row) => [row.id, row] as const),
    );
    expect(generationsById.get(first.id)).toMatchObject({
      candidateKey: `${canonicalCandidateKey}:archived:${first.id}`,
      status: "archived",
    });
    expect(generationsById.get(second.id)).toMatchObject({
      candidateKey: `${canonicalCandidateKey}:archived:${second.id}`,
      status: "archived",
    });
    expect(generationsById.get(third.id)).toMatchObject({
      candidateKey: canonicalCandidateKey,
      status: "selected",
    });

    const responseLogicAfterBothReselections = await executor
      .select()
      .from(responseLogicEntries)
      .where(eq(responseLogicEntries.userId, userId));
    expect(responseLogicAfterBothReselections).toHaveLength(1);
    expect(responseLogicAfterBothReselections[0]).toMatchObject({
      questionId: first.id,
      conversationId: oldConversationId,
      lastTaskId: oldTaskId,
      revision: 3,
    });

    const portal = await getServicePortal(userId, {
      now: new Date("2026-08-19T15:41:00.000Z"),
    });
    expect(portal.quotas?.usage).toMatchObject({
      industry: 1,
      total: 1,
    });
    expect(portal.purchasedQuestions).toHaveLength(1);
    expect(portal.purchasedQuestions[0]?.id).toBe(third.id);
  }, 60_000);
});
