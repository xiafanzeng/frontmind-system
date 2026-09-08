import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  knowledgeBaseBuilds,
  conversationTurns,
  conversations,
} from "../drizzle/schema";
import {
  continueKnowledgeBaseAfterRecharge,
  pauseKnowledgeBaseForBilling,
  assertKnowledgeBaseDispatchFunds,
} from "./knowledge-base-billing";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import mysql, { type Connection } from "mysql2/promise";
import { createDatabase } from "../../../packages/monitoring-db/src/client";
import { MonitoringRepository } from "../../../packages/monitoring-db/src/repositories";
import { PublishingRepository } from "../../../packages/monitoring-db/src/publisher-repository";
import { dashboardMonitoringUserId } from "../../../packages/monitoring-db/src/dashboard-account-links";
import {
  accountActivityOutputSchema,
  accountActivityPageOutputSchema,
} from "../../../packages/monitoring-contracts/src/billing";
import {
  authorizeManagedAiCommand,
  observeManagedAiUsage,
  rejectManagedAiCommand,
  AiBillingError,
  AiBillingPausedError,
  assertAiAccountFunds,
} from "./ai-billing-service";
import { closeDbForOneShotMaintenance } from "./db";
const url = process.env.FRONTMIND_FINANCE_TEST_MYSQL_URL;
(url ? describe : describe.skip)(
  "unified financial transactions on MySQL",
  () => {
    let connection: Connection;
    let domainDb: ReturnType<typeof createDatabase>;
    const owner = dashboardMonitoringUserId(1),
      other = dashboardMonitoringUserId(2),
      oldUrl = process.env.DATABASE_URL;
    const input = {
      identity: {
        accountUserId: 1,
        credentialId: "cred",
        credentialVersion: 1,
      },
      localTaskId: "task-1",
      operationId: "op-1",
      sessionId: "sess-1",
      commandKey: "initial",
      model: "glm-5.3",
      effort: "high",
    };
    async function query(statement: string, values: any[] = []) {
      return (await connection.execute(statement, values))[0] as any;
    }
    async function migrate(name: string) {
      for (const statement of (
        await readFile(resolve(import.meta.dirname, "../drizzle", name), "utf8")
      ).split("--> statement-breakpoint"))
        if (statement.trim()) await connection.query(statement);
    }
    async function wallet() {
      return (
        await query("SELECT * FROM unified_money_wallets WHERE user_id=?", [
          owner,
        ])
      )[0];
    }
    function observation(
      count = 1,
      usage: Record<string, number> = {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 1,
      },
      error = false,
    ) {
      const stamp = new Date().toISOString();
      return {
        ...input,
        commands: [{ key: "initial", eventId: "user-1", createdAt: stamp }],
        events: [
          { id: "user-1", type: "user.message", processed_at: stamp },
          ...Array.from({ length: count }, (_, i) => ({
            id: `model-${i}`,
            type: "span.model_request_end",
            processed_at: stamp,
            model_usage: usage,
            is_error: error,
          })),
          { id: "idle-1", type: "session.status_idle", processed_at: stamp },
        ],
        session: {
          id: input.sessionId,
          status: "idle",
          usage: Object.fromEntries(
            Object.entries(usage).map(([k, v]) => [k, v * count]),
          ),
        },
      };
    }
    beforeAll(async () => {
      if (!url || !new URL(url).pathname.includes("acceptance"))
        throw new Error("Dedicated acceptance database required");
      process.env.DATABASE_URL = url;
      connection = await mysql.createConnection(url);
      await query("SET FOREIGN_KEY_CHECKS=0");
      for (const row of await query("SHOW TABLES"))
        await connection.query(`DROP TABLE \`${Object.values(row)[0]}\``);
      await query("SET FOREIGN_KEY_CHECKS=1");
      const ddl = [
        "CREATE TABLE users(id int PRIMARY KEY,username varchar(64),role varchar(16),adminAccessLevel varchar(24),isActive boolean)",
        "INSERT INTO users VALUES(1,'one','user',NULL,true),(2,'two','user',NULL,true)",
        "CREATE TABLE enterprise_projects(id varchar(36) PRIMARY KEY,ownerUserId int NOT NULL,archivedAt timestamp NULL)",
        "INSERT INTO enterprise_projects VALUES('project-a',1,NULL),('project-b',1,NULL)",
        "CREATE TABLE monitoring_users(id varchar(36) PRIMARY KEY,username varchar(64),password_hash varchar(255),role varchar(16),status varchar(16),session_version int,password_changed_at datetime(3))",
        "CREATE TABLE monitoring_account_links(dashboardUserId int PRIMARY KEY,monitoringUserId varchar(36))",
        "CREATE TABLE quota_wallets(user_id varchar(36) PRIMARY KEY)",
        "CREATE TABLE money_wallets(user_id varchar(36) PRIMARY KEY,balance_ten_thousandths bigint,reserved_ten_thousandths bigint unsigned,spent_ten_thousandths bigint unsigned)",
        "CREATE TABLE media_publishing_wallets(user_id varchar(36) PRIMARY KEY,balance_ten_thousandths bigint,reserved_ten_thousandths bigint unsigned,frozen_ten_thousandths bigint unsigned,spent_ten_thousandths bigint unsigned)",
        "CREATE TABLE topup_orders(id varchar(36) PRIMARY KEY,provider_order_id varchar(128),state varchar(24),credited_at datetime)",
        "CREATE TABLE topup_receipts(id varchar(36) PRIMARY KEY,order_id varchar(36),provider varchar(16),provider_trade_no varchar(191),payload_digest varchar(64),received_at datetime)",
        "CREATE TABLE payment_receipt_claims(id varchar(36) PRIMARY KEY,provider varchar(16),provider_trade_no varchar(191),provider_order_id varchar(128),wallet_scope varchar(32),payload_digest varchar(64),status varchar(24),claimed_at datetime,completed_at datetime,UNIQUE(provider,provider_trade_no))",
      ];
      for (const statement of ddl) await query(statement);
      await query("INSERT INTO monitoring_users(id) VALUES(?),(?)", [
        owner,
        other,
      ]);
      await query("INSERT INTO monitoring_account_links VALUES(1,?),(2,?)", [
        owner,
        other,
      ]);
      await query("INSERT INTO money_wallets VALUES(?,20000,3000,6000)", [
        owner,
      ]);
      await query(
        "INSERT INTO media_publishing_wallets VALUES(?,10000,2000,1000,4000)",
        [owner],
      );
      const parity = await readFile(
        resolve(
          import.meta.dirname,
          "../drizzle/0058_dashboard_production_parity.sql",
        ),
        "utf8",
      );
      for (const table of ["agent_operations", "agent_tasks"])
        await connection.query(
          parity
            .split("--> statement-breakpoint")
            .find((s) => s.trim().startsWith(`CREATE TABLE \`${table}\``))!,
        );
      await query(
        "ALTER TABLE agent_operations ADD provider varchar(16) NOT NULL DEFAULT 'zhipu',ADD enterpriseProjectId varchar(36)",
      );
      await query("ALTER TABLE agent_tasks ADD provider_runtime json");
      for (const table of [
        "topup_receipts",
        "topup_orders",
        "payment_receipt_claims",
      ])
        await query(`DROP TABLE ${table}`);
      for (const [migration, tables] of [
        [
          "0003_money_billing.sql",
          ["topup_orders", "topup_receipts", "money_ledger"],
        ],
        [
          "0004_media_publishing.sql",
          [
            "media_publishing_topup_orders",
            "media_publishing_topup_receipts",
            "media_publishing_ledger",
            "payment_receipt_claims",
          ],
        ],
      ] as const) {
        const source = await readFile(
          resolve(
            import.meta.dirname,
            "../../../packages/monitoring-db/migrations",
            migration,
          ),
          "utf8",
        );
        for (const table of tables)
          await connection.query(
            source
              .split("--> statement-breakpoint")
              .find((s) => s.trim().startsWith(`CREATE TABLE \`${table}\``))!,
          );
      }
      domainDb = createDatabase(url);
      await migrate("0063_unified_account_wallet.sql");
      const opening = await wallet();
      expect(Number(opening.balance_ten_thousandths)).toBe(30000);
      expect(Number(opening.reserved_ten_thousandths)).toBe(5000);
      expect(Number(opening.frozen_ten_thousandths)).toBe(1000);
      expect(Number(opening.spent_ten_thousandths)).toBe(10000);
      await migrate("0064_ai_cost_accounting.sql");
      // KB fixture columns follow the production Drizzle types. Finance migration SQL above remains real.
      for (const table of [
        knowledgeBaseBuilds,
        conversationTurns,
        conversations,
      ]) {
        const config = getTableConfig(table);
        await connection.query(
          `CREATE TABLE \`${config.name}\` (${config.columns.map((column) => `\`${column.name}\` ${column.getSQLType()} ${column.primary ? "PRIMARY KEY" : "NULL"}`).join(",")})`,
        );
      }
    }, 30000);
    beforeEach(async () => {
      for (const table of [
        "knowledge_base_builds",
        "conversation_turns",
        "conversations",
        "ai_wallet_ledger",
        "ai_cost_events",
        "ai_charge_commands",
        "ai_usage_sync_targets",
        "agent_tasks",
        "agent_operations",
        "topup_receipts",
        "media_publishing_topup_receipts",
        "topup_orders",
        "media_publishing_topup_orders",
        "payment_receipt_claims",
        "money_ledger",
        "media_publishing_ledger",
      ])
        await query(`DELETE FROM ${table}`);
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=20000,reserved_ten_thousandths=0,frozen_ten_thousandths=0,spent_ten_thousandths=0,ai_cost_remainder_nanos=0",
      );
      await query("UPDATE ai_billing_configuration SET mode='active'");
      await query(
        "INSERT INTO agent_operations(id,scope,account_user_id,operation_type,idempotency_key_hash,request_hash,contract_name,contract_revision,schema_hash,api_credential_id,credential_version,public_profile,upstream_model) VALUES('op-1','managed_user',1,'test','a','a','test',1,'a','cred',1,'high','glm-5.3')",
      );
      await query(
        "INSERT INTO agent_tasks(id,operation_id,create_marker,title,provider_state) VALUES('task-1','op-1','a','test','running')",
      );
    });
    afterAll(async () => {
      await closeDbForOneShotMaintenance();
      if (domainDb) await domainDb.pool.end();
      if (connection) await connection.end();
      if (oldUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldUrl;
    });
    it("reserves once across concurrent replay and releases a definite rejection", async () => {
      await Promise.all([
        authorizeManagedAiCommand(input),
        authorizeManagedAiCommand(input),
      ]);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(10000);
      await rejectManagedAiCommand(input);
      await rejectManagedAiCommand(input);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(0);
      expect((await query("SELECT * FROM ai_wallet_ledger")).length).toBe(2);
    });
    it("serializes competing commands and respects media frozen funds", async () => {
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=15000,frozen_ten_thousandths=1000 WHERE user_id=?",
        [owner],
      );
      const results = await Promise.allSettled([
        authorizeManagedAiCommand(input),
        authorizeManagedAiCommand({ ...input, commandKey: "other" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(14000);
      await expect(
        authorizeManagedAiCommand({ ...input, commandKey: "third" }),
      ).rejects.toThrow("AI_BALANCE_INSUFFICIENT");
    });
    it("carries subunit costs and replays events without double charge", async () => {
      await authorizeManagedAiCommand(input);
      await observeManagedAiUsage(observation(3));
      await observeManagedAiUsage(observation(3));
      const row = await wallet();
      expect(Number(row.balance_ten_thousandths)).toBe(19999);
      expect(Number(row.ai_cost_remainder_nanos)).toBe(14000);
      expect(Number(row.reserved_ten_thousandths)).toBe(0);
      expect((await query("SELECT * FROM ai_cost_events")).length).toBe(3);
    });
    it("charges failed usage and reconciles late cost as debt", async () => {
      await authorizeManagedAiCommand(input);
      const usage = {
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      };
      await observeManagedAiUsage(observation(1, usage, true));
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(19920);
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=1 WHERE user_id=?",
        [owner],
      );
      await observeManagedAiUsage(observation(2, usage, true));
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(-79);
      await expect(
        authorizeManagedAiCommand({ ...input, commandKey: "new" }),
      ).rejects.toThrow("AI_BALANCE_INSUFFICIENT");
    });
    it("retains funds for unknown costs and requests interruption", async () => {
      await authorizeManagedAiCommand(input);
      const result = await observeManagedAiUsage(
        observation(1, {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 1,
        }),
      );
      expect(result.shouldInterrupt).toBe(true);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(10000);
      expect(
        (await query("SELECT cost_nanos FROM ai_cost_events"))[0].cost_nanos,
      ).toBeNull();
    });
    it("observes history without retrocharges and enforces account ownership", async () => {
      await observeManagedAiUsage(observation());
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(20000);
      expect(
        (await query("SELECT cost_state FROM ai_cost_events"))[0].cost_state,
      ).toBe("historical");
      await expect(
        authorizeManagedAiCommand({
          ...input,
          identity: { ...input.identity, accountUserId: 2 },
        }),
      ).rejects.toThrow("AI_BILLING_TASK_OWNERSHIP");
    });
    it("attributes website cost to the platform", async () => {
      await query(
        "UPDATE agent_operations SET scope='website_frontend',account_user_id=NULL,presales_project_id='website-project' WHERE id='op-1'",
      );
      await observeManagedAiUsage({ ...observation(), identity: undefined });
      expect(
        (await query("SELECT cost_state FROM ai_cost_events"))[0].cost_state,
      ).toBe("platform");
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(20000);
    });
    it("fails closed if persistent charging is not active", async () => {
      await query("UPDATE ai_billing_configuration SET mode='prepared'");
      await expect(authorizeManagedAiCommand(input)).rejects.toThrow(
        "AI_BILLING_NOT_ACTIVE",
      );
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(0);
    });
    it("shares online topups across domains and rejects a cross-domain transaction replay", async () => {
      const expires = new Date(Date.now() + 600000),
        now = new Date(),
        digest = "a".repeat(64);
      await query(
        "INSERT INTO topup_orders(id,provider_order_id,user_id,idempotency_key,payment_method,amount_ten_thousandths,callback_token_digest,checkout_expires_at) VALUES('topup-m','provider-m',?,'m-key','alipay',100000,?,?)",
        [owner, digest, expires],
      );
      await query(
        "INSERT INTO media_publishing_topup_orders(id,provider_order_id,owner_id,idempotency_key,payment_method,amount_ten_thousandths,callback_token_digest,checkout_expires_at) VALUES('topup-p','provider-p',?,'p-key','alipay',100000,?,?)",
        [owner, digest, expires],
      );
      const monitoring = new MonitoringRepository(domainDb.db),
        publishing = new PublishingRepository(domainDb.db);
      const receipt = {
        provider: "zpay" as const,
        providerTradeNo: "trade-one",
        amountTenThousandths: 100000n,
        paidAt: now,
        payloadDigest: digest,
        receivedAt: now,
      };
      await monitoring.recordTopupReceiptAndCredit({
        ...receipt,
        providerOrderId: "provider-m",
      });
      await expect(
        publishing.recordMediaPublishingTopupReceiptAndCredit({
          ...receipt,
          providerOrderId: "provider-p",
        }),
      ).rejects.toThrow();
      await monitoring.recordTopupReceiptAndCredit({
        ...receipt,
        providerOrderId: "provider-m",
      });
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(120000);
      await publishing.recordMediaPublishingTopupReceiptAndCredit({
        ...receipt,
        providerTradeNo: "trade-two",
        providerOrderId: "provider-p",
      });
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(220000);
      expect(
        (await monitoring.getBillingSummary(owner)).availableTenThousandths,
      ).toBe(
        (await publishing.getMediaPublishingBillingSummary(owner))
          .availableTenThousandths,
      );
    });

    it("replenishes a live task's reserve at 80 percent consumption", async () => {
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=30000 WHERE user_id=?",
        [owner],
      );
      await authorizeManagedAiCommand(input);
      const request = observation(1, {
        input_tokens: 100000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      });
      request.events.pop();
      request.session.status = "running";
      expect((await observeManagedAiUsage(request)).shouldInterrupt).toBe(
        false,
      );
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(12000);
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(22000);
    });
    it("shows three consumption categories while keeping recharge and holds in all cashflow", async () => {
      await authorizeManagedAiCommand(input);
      await observeManagedAiUsage(
        observation(1, {
          input_tokens: 1000,
          output_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      );
      await query(
        "INSERT INTO money_ledger(id,user_id,type,balance_delta_ten_thousandths,reserved_delta_ten_thousandths,balance_after_ten_thousandths,reserved_after_ten_thousandths,idempotency_key,reason) VALUES('00000000-0000-4000-8000-000000000010',?,'consume',-500,0,19420,0,'monitor-cost','monitor cost'),('00000000-0000-4000-8000-000000000011',?,'topup',1000,0,20420,0,'recharge','recharge')",
        [owner, owner],
      );
      await query(
        "INSERT INTO media_publishing_ledger(id,owner_id,type,balance_delta_ten_thousandths,reserved_delta_ten_thousandths,frozen_delta_ten_thousandths,balance_after_ten_thousandths,reserved_after_ten_thousandths,frozen_after_ten_thousandths,idempotency_key,reason) VALUES('00000000-0000-4000-8000-000000000012',?,'consume',-700,0,0,19720,0,0,'media-cost','media cost')",
        [owner],
      );
      const repository = new MonitoringRepository(domainDb.db);
      expect(
        (await repository.getBillingSummary(owner)).consumptionBySource,
      ).toEqual({
        monitoring: {
          totalTenThousandths: "500",
          last30DaysTenThousandths: "500",
        },
        media_publishing: {
          totalTenThousandths: "700",
          last30DaysTenThousandths: "700",
        },
        ai: { totalTenThousandths: "80", last30DaysTenThousandths: "80" },
      });
      const all = await repository.listAccountActivity(owner);
      all.forEach((row) => accountActivityOutputSchema.parse(row));
      expect(all.some((row) => row.type === "topup")).toBe(true);
      expect(all.some((row) => row.type === "reserve")).toBe(true);
      expect(
        await repository.listAccountActivity(owner, { source: "monitoring" }),
      ).toEqual([
        expect.objectContaining({
          source: "monitoring",
          type: "consume",
          balanceDeltaTenThousandths: "-500",
        }),
      ]);
      expect(await repository.listAccountActivity(other)).toEqual([]);
    });
    it("paginates the complete account history and filtered AI consumption beyond 100 entries", async () => {
      const values: unknown[] = [];
      const placeholders = Array.from({ length: 117 }, (_, index) => {
        values.push(
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          index === 116 ? other : owner,
          "test-command",
          index < 115 ? "consume" : "reserve",
          index < 115 ? -1 : 0,
          index < 115 ? 0 : 10,
          19999 - index,
          "智谱 AI 原价用量",
          `pagination:${index}`,
          "2026-09-08 00:00:00",
        );
        return "(?,?,?,?,?,?,?,?,?,?)";
      });
      await query(
        `INSERT INTO ai_wallet_ledger(id,user_id,command_id,type,balance_delta_ten_thousandths,reserved_delta_ten_thousandths,balance_after_ten_thousandths,reason,idempotency_key,created_at) VALUES ${placeholders.join(",")}`,
        values,
      );
      const repository = new MonitoringRepository(domainDb.db);
      const pages = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          repository.listAccountActivityPage(owner, {
            source: "ai",
            page: index + 1,
          }),
        ),
      );
      pages.forEach((page) => accountActivityPageOutputSchema.parse(page));
      expect(pages.map((page) => page.items.length)).toEqual([
        ...Array(11).fill(10),
        5,
      ]);
      expect(
        pages.every((page) => page.total === 115 && page.pageSize === 10),
      ).toBe(true);
      const items = pages.flatMap((page) => page.items);
      expect(new Set(items.map((item) => item.id)).size).toBe(115);
      expect(items[0]?.id).toBe("00000000-0000-4000-8000-000000000114");
      expect(items.at(-1)?.id).toBe("00000000-0000-4000-8000-000000000000");
      expect(
        items.every(
          (item) => item.type === "consume" && item.reason === "智能体用量结算",
        ),
      ).toBe(true);
      const all = await repository.listAccountActivityPage(owner);
      expect(all.total).toBe(116);
      expect(all.items[0]?.type).toBe("reserve");
      expect(
        await repository.listAccountActivityPage(owner, {
          source: "ai",
          page: 999,
        }),
      ).toMatchObject({ page: 12, total: 115 });
      expect(
        await repository.listAccountActivityPage(owner, {
          source: "monitoring",
          page: 5,
        }),
      ).toEqual({ page: 1, total: 0, pageSize: 10, items: [] });
      expect(
        await repository.listAccountActivityPage(other, { source: "ai" }),
      ).toMatchObject({ total: 0, items: [] });
      // Historical ledger entries are retained for reconciliation; only their customer presentation changes.
      expect(
        (await query("SELECT DISTINCT reason FROM ai_wallet_ledger"))[0].reason,
      ).toBe("智谱 AI 原价用量");
    });
    it("does not release a running session based on a stale idle event", async () => {
      await authorizeManagedAiCommand(input);
      const request = observation();
      request.session.status = "running";
      await observeManagedAiUsage(request);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(10000);
    });
    it("uses the remaining balance when the next reserve is below one yuan", async () => {
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=15000 WHERE user_id=?",
        [owner],
      );
      await authorizeManagedAiCommand(input);
      const request = observation(1, {
        input_tokens: 100000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      });
      request.events.pop();
      request.session.status = "running";
      expect((await observeManagedAiUsage(request)).shouldInterrupt).toBe(
        false,
      );
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(7000);
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(7000);
    });
    it("starts with twenty cents and interrupts only after consuming eighty percent of that reserve", async () => {
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=2000 WHERE user_id=?",
        [owner],
      );
      await authorizeManagedAiCommand(input);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(2000);
      const request = observation(1, {
        input_tokens: 10000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      });
      request.events.pop();
      request.session.status = "running";
      expect((await observeManagedAiUsage(request)).shouldInterrupt).toBe(
        false,
      );
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(1200);
      const next = observation(2, {
        input_tokens: 10000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      });
      next.events.pop();
      next.session.status = "running";
      expect((await observeManagedAiUsage(next)).shouldInterrupt).toBe(true);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(400);
    });
    it("recovers billing attribution after a lost ack only with one frozen request match", async () => {
      await authorizeManagedAiCommand(input);
      const request = observation(1, {
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      });
      (request.events[0] as any).content = [
        { type: "text", text: "frozen prompt" },
      ];
      (request as any).commands = [
        {
          key: "initial",
          createdAt: new Date().toISOString(),
          providerPromptHash: createHash("sha256")
            .update("frozen prompt")
            .digest("hex"),
          beforeEventIds: [],
        },
      ];
      await observeManagedAiUsage(request);
      expect(Number((await wallet()).balance_ten_thousandths)).toBe(19920);
      expect(Number((await wallet()).reserved_ten_thousandths)).toBe(0);
    });
    it("rejects an operation in another enterprise project even with the same owner and credential", async () => {
      await query(
        "UPDATE agent_operations SET enterpriseProjectId='project-a' WHERE id='op-1'",
      );
      await expect(
        authorizeManagedAiCommand({
          ...input,
          identity: { ...input.identity, enterpriseProjectId: "project-b" },
        }),
      ).rejects.toThrow("AI_BILLING_PROJECT_OWNERSHIP");
    });

    it("blocks new authorization after project deletion while still accounting for late incurred usage", async () => {
      await query(
        "UPDATE agent_operations SET enterpriseProjectId='project-a' WHERE id='op-1'",
      );
      const identity = { ...input.identity, enterpriseProjectId: "project-a" };
      const usage = {
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      };
      await authorizeManagedAiCommand({ ...input, identity });
      await observeManagedAiUsage({ ...observation(1, usage), identity });
      await query(
        "UPDATE enterprise_projects SET archivedAt=NOW() WHERE id='project-a'",
      );
      try {
        await expect(
          authorizeManagedAiCommand({ ...input, identity, commandKey: "new" }),
        ).rejects.toThrow("AI_BILLING_PROJECT_OWNERSHIP");
        await observeManagedAiUsage({ ...observation(2, usage), identity });
        expect(Number((await wallet()).balance_ten_thousandths)).toBe(19840);
        expect((await query("SELECT * FROM ai_charge_commands")).length).toBe(
          1,
        );
      } finally {
        await query(
          "UPDATE enterprise_projects SET archivedAt=NULL WHERE id='project-a'",
        );
      }
    });

    async function seedBillingKnowledge(stage: "before_send" | "after_send") {
      const turnId = "10000000-0000-4000-8000-000000000001",
        buildId = "20000000-0000-4000-8000-000000000001",
        leaseToken = "billing-worker-lease";
      const runtime = {
        revision: 1,
        model: "glm-5.3",
        effort: "high",
        intentId: turnId,
        sessionId: "sess-1",
        mutations: {},
        files: [],
        commands: [
          {
            key: "initial",
            intentId: turnId,
            prompt: "initial prompt",
            providerPromptHash: "hash",
            attachments: [],
            beforeEventIds: [],
            beforeFileIds: [],
            createdAt: new Date().toISOString(),
            ...(stage === "after_send" ? { eventId: "user-1" } : {}),
          },
        ],
      };
      await query(
        "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
        [JSON.stringify({ dashboardManaged: runtime })],
      );
      const metadata = {
        leaseOwnerHash: createHash("sha256").update(leaseToken).digest("hex"),
        createAttemptState:
          stage === "before_send" ? "sending" : "acknowledged",
        providerAttemptState:
          stage === "before_send" ? "sending" : "output_pending",
        materializedRecoveryContractVersion: 1,
      };
      await query(
        "INSERT INTO knowledge_base_builds(id,userId,activeTurnId,generation,stateEpoch,status,upstreamTaskId) VALUES(?,?,?,1,1,'researching',?)",
        [buildId, 1, turnId, stage === "after_send" ? "sess-1" : null],
      );
      await query(
        "INSERT INTO conversation_turns(id,userId,buildId,buildGeneration,conversationId,status,metadata,upstreamTaskId) VALUES(?,1,?,1,'billing-conversation','running',?,?)",
        [
          turnId,
          buildId,
          JSON.stringify(metadata),
          stage === "after_send" ? "sess-1" : null,
        ],
      );
      await query(
        "INSERT INTO conversations(id,userId,status,version) VALUES('billing-conversation',1,'running',1)",
      );
      const claim = {
        turn: { userId: 1, id: turnId, buildId },
        leaseToken,
      } as any;
      return {
        claim,
        runtime,
        input: {
          userId: 1,
          buildId,
          turnId,
          requestId: "30000000-0000-4000-8000-000000000001",
        },
      };
    }
    const credential = async () =>
      ({
        id: "cred",
        version: 1,
        userId: 1,
        apiKey: "synthetic-key",
        provider: "zhipu",
        upstreamModel: "glm-5.3",
        upstreamEffort: "high",
      }) as any;
    async function persistTestPause(
      kb: Awaited<ReturnType<typeof seedBillingKnowledge>>,
      reason: "balance" | "cost" = "balance",
    ) {
      const pause = {
        reason,
        stage: "after_send" as const,
        commandKey: "initial",
        sessionId: "sess-1",
        pausedAt: new Date().toISOString(),
      };
      await query(
        "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
        [JSON.stringify({ dashboardManaged: kb.runtime, billingPause: pause })],
      );
      await pauseKnowledgeBaseForBilling(
        kb.claim,
        new AiBillingPausedError(pause),
      );
      return pause;
    }
    it("prechecks zero balance without creating a command and resumes an unsent High build using its original session", async () => {
      const kb = await seedBillingKnowledge("before_send");
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=0 WHERE user_id=?",
        [owner],
      );
      await expect(assertAiAccountFunds(1)).rejects.toThrow(
        "AI_BALANCE_INSUFFICIENT",
      );
      await expect(authorizeManagedAiCommand(input)).rejects.toThrow(
        "AI_BALANCE_INSUFFICIENT",
      );
      expect(await query("SELECT * FROM ai_charge_commands")).toEqual([]);
      await pauseKnowledgeBaseForBilling(
        kb.claim,
        new AiBillingError("AI_BALANCE_INSUFFICIENT"),
      );
      const send = vi.fn();
      await expect(
        continueKnowledgeBaseAfterRecharge(kb.input, {
          resolveCredential: credential,
          createClient: send as any,
        }),
      ).rejects.toThrow("AI_BALANCE_INSUFFICIENT");
      expect(send).not.toHaveBeenCalled();
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=20000 WHERE user_id=?",
        [owner],
      );
      await continueKnowledgeBaseAfterRecharge(kb.input, {
        resolveCredential: credential,
        createClient: send as any,
      });
      const [turn] = await query(
        "SELECT status,metadata,upstreamTaskId FROM conversation_turns WHERE id=?",
        [kb.input.turnId],
      );
      expect(turn.status).toBe("queued");
      expect(turn.metadata.createAttemptState).toBe("not_sent");
      expect(turn.upstreamTaskId).toBeNull();
      expect(send).not.toHaveBeenCalled();
      const [task] = await query(
        "SELECT provider_runtime FROM agent_tasks WHERE id='task-1'",
      );
      expect(task.provider_runtime.dashboardManaged).toMatchObject({
        sessionId: "sess-1",
        effort: "high",
        intentId: kb.input.turnId,
      });
    });
    it("resumes a funded interrupted High session once and preserves its Working Set and turn", async () => {
      const kb = await seedBillingKnowledge("after_send");
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=2000 WHERE user_id=?",
        [owner],
      );
      await authorizeManagedAiCommand(input);
      const observationInput = observation(1, {
        input_tokens: 20000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      });
      observationInput.events.pop();
      observationInput.session.status = "running";
      const observed = await observeManagedAiUsage(observationInput);
      expect(observed.pause?.reason).toBe("balance");
      await pauseKnowledgeBaseForBilling(
        kb.claim,
        new AiBillingPausedError(observed.pause!),
      );
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=20000 WHERE user_id=?",
        [owner],
      );
      const send = vi.fn(async () => ({
        taskId: "sess-1",
        requestId: "resume-accepted",
        raw: {},
      }));
      const create = vi.fn(() => ({ sendMessage: send }) as any);
      await continueKnowledgeBaseAfterRecharge(kb.input, {
        resolveCredential: credential,
        createClient: create,
      });
      await continueKnowledgeBaseAfterRecharge(
        { ...kb.input, requestId: "30000000-0000-4000-8000-000000000002" },
        { resolveCredential: credential, createClient: create },
      );
      expect(send).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        model: "glm-5.3",
        effort: "high",
        localTaskId: "task-1",
        operationId: "op-1",
      });
      expect(send.mock.calls[0]?.[0]).toMatchObject({ taskId: "sess-1" });
      const [build] = await query(
        "SELECT status,activeTurnId,upstreamTaskId FROM knowledge_base_builds WHERE id=?",
        [kb.input.buildId],
      );
      expect(build).toMatchObject({
        status: "researching",
        activeTurnId: kb.input.turnId,
        upstreamTaskId: "sess-1",
      });
      expect(
        (
          await query("SELECT metadata FROM conversation_turns WHERE id=?", [
            kb.input.turnId,
          ])
        )[0].metadata.aiBillingPause,
      ).toBeUndefined();
    });
    it("does not send a new paid continuation when acknowledgement is unknown and no matching event exists", async () => {
      const kb = await seedBillingKnowledge("after_send");
      const pause = {
        reason: "balance",
        stage: "after_send",
        commandKey: "initial",
        sessionId: "sess-1",
        pausedAt: new Date().toISOString(),
      };
      await query(
        "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
        [JSON.stringify({ dashboardManaged: kb.runtime, billingPause: pause })],
      );
      await pauseKnowledgeBaseForBilling(
        kb.claim,
        new AiBillingPausedError(pause as any),
      );
      const intentId = `knowledge-billing-resume:${kb.input.turnId}:${kb.input.requestId}`;
      (kb.runtime.commands as any).push({
        ...kb.runtime.commands[0],
        key: "resume",
        intentId,
        eventId: undefined,
        beforeEventIds: ["user-1"],
      });
      (kb.runtime.mutations as any)["message:resume"] = {
        state: "outcome_unknown",
        requestHash: "hash",
        startedAt: new Date().toISOString(),
      };
      await query(
        "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
        [JSON.stringify({ dashboardManaged: kb.runtime, billingPause: pause })],
      );
      const send = vi.fn();
      await expect(
        continueKnowledgeBaseAfterRecharge(kb.input, {
          resolveCredential: credential,
          createClient: send as any,
          createApi: () => ({ listAll: async () => [] }),
        }),
      ).rejects.toThrow("AI_RESUME_PENDING");
      expect(send).not.toHaveBeenCalled();
      expect(
        (
          await query("SELECT status FROM conversation_turns WHERE id=?", [
            kb.input.turnId,
          ])
        )[0].status,
      ).toBe("failed");
    });
    it("repairs a uniquely matching authoritative lost acknowledgement without a second paid send", async () => {
      const kb = await seedBillingKnowledge("after_send");
      const pause = await persistTestPause(kb);
      const prompt = "frozen continuation";
      (kb.runtime.commands as any).push({
        ...kb.runtime.commands[0],
        key: "resume",
        intentId: `knowledge-billing-resume:${kb.input.turnId}:${kb.input.requestId}`,
        eventId: undefined,
        beforeEventIds: ["user-1"],
        providerPromptHash: createHash("sha256").update(prompt).digest("hex"),
      });
      (kb.runtime.mutations as any)["message:resume"] = {
        state: "outcome_unknown",
        requestHash: "hash",
        startedAt: new Date().toISOString(),
      };
      await query(
        "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
        [JSON.stringify({ dashboardManaged: kb.runtime, billingPause: pause })],
      );
      const send = vi.fn();
      const mutate = vi.fn(async (_identity: any, _id: any, change: any) => {
        const runtime = change(kb.runtime);
        await query(
          "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
          [JSON.stringify({ dashboardManaged: runtime, billingPause: pause })],
        );
        return { runtime };
      });
      await continueKnowledgeBaseAfterRecharge(kb.input, {
        resolveCredential: credential,
        createClient: send as any,
        createApi: () => ({
          listAll: async () => [
            {
              id: "recovered-user",
              type: "user.message",
              processed_at: new Date().toISOString(),
              content: [{ type: "text", text: prompt }],
            },
          ],
        }),
        store: { mutate } as any,
      });
      expect(send).not.toHaveBeenCalled();
      expect(mutate).toHaveBeenCalledOnce();
      const [task] = await query(
        "SELECT provider_runtime FROM agent_tasks WHERE id='task-1'",
      );
      expect(
        task.provider_runtime.dashboardManaged.mutations["message:resume"],
      ).toMatchObject({ state: "acknowledged", resourceId: "recovered-user" });
      expect(
        (
          await query("SELECT status FROM conversation_turns WHERE id=?", [
            kb.input.turnId,
          ])
        )[0].status,
      ).toBe("queued");
    });
    it("uses a new explicit request only for a definitely rejected continuation", async () => {
      const kb = await seedBillingKnowledge("after_send");
      const pause = await persistTestPause(kb);
      (kb.runtime.commands as any).push({
        ...kb.runtime.commands[0],
        key: "resume",
        intentId: `knowledge-billing-resume:${kb.input.turnId}:${kb.input.requestId}`,
        eventId: undefined,
      });
      (kb.runtime.mutations as any)["message:resume"] = {
        state: "rejected",
        status: 429,
        requestHash: "hash",
        startedAt: new Date().toISOString(),
      };
      await query(
        "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
        [JSON.stringify({ dashboardManaged: kb.runtime, billingPause: pause })],
      );
      await query(
        "UPDATE conversation_turns SET metadata=JSON_SET(metadata,'$.aiBillingPause.resumeRequestId',?) WHERE id=?",
        [kb.input.requestId, kb.input.turnId],
      );
      const send = vi.fn(async () => ({ taskId: "sess-1" }));
      const create = vi.fn(() => ({ sendMessage: send }) as any);
      await expect(
        continueKnowledgeBaseAfterRecharge(kb.input, {
          resolveCredential: credential,
          createClient: create,
        }),
      ).rejects.toThrow("AI_RESUME_REJECTED");
      await continueKnowledgeBaseAfterRecharge(
        { ...kb.input, requestId: "30000000-0000-4000-8000-000000000002" },
        { resolveCredential: credential, createClient: create },
      );
      expect(send).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]?.[0].intentId).toContain(
        "30000000-0000-4000-8000-000000000002",
      );
    });
    it("leases concurrent explicit resume clicks so only one command is sent", async () => {
      const kb = await seedBillingKnowledge("after_send");
      await persistTestPause(kb);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const sending = new Promise<void>((resolve) => {
        started = resolve;
      });
      const send = vi.fn(async () => {
        started();
        await pending;
        return { taskId: "sess-1" };
      });
      const dependencies = {
        resolveCredential: credential,
        createClient: (() => ({ sendMessage: send })) as any,
      };
      const first = continueKnowledgeBaseAfterRecharge(kb.input, dependencies);
      await sending;
      await expect(
        continueKnowledgeBaseAfterRecharge(
          { ...kb.input, requestId: "30000000-0000-4000-8000-000000000002" },
          dependencies,
        ),
      ).rejects.toThrow("AI_RESUME_PENDING");
      release();
      await first;
      expect(send).toHaveBeenCalledOnce();
    });
    it("retains a cost pause until authoritative costs reconcile and never resumes automatically", async () => {
      const kb = await seedBillingKnowledge("after_send");
      await persistTestPause(kb, "cost");
      const send = vi.fn(async () => ({ taskId: "sess-1" }));
      const dependencies = {
        resolveCredential: credential,
        createClient: (() => ({ sendMessage: send })) as any,
      };
      await expect(
        continueKnowledgeBaseAfterRecharge(kb.input, dependencies),
      ).rejects.toThrow("AI_COST_PENDING");
      expect(send).not.toHaveBeenCalled();
      expect(
        await query(
          "SELECT * FROM ai_usage_sync_targets WHERE local_task_id='task-1'",
        ),
      ).toHaveLength(1);
      await observeManagedAiUsage(observation());
      expect(
        (
          await query("SELECT status FROM conversation_turns WHERE id=?", [
            kb.input.turnId,
          ])
        )[0].status,
      ).toBe("failed");
      await continueKnowledgeBaseAfterRecharge(kb.input, dependencies);
      expect(send).toHaveBeenCalledOnce();
    });
    it("rejects another account, another enterprise project, and a stale pause worker lease", async () => {
      const kb = await seedBillingKnowledge("after_send");
      const pause = {
        reason: "balance" as const,
        stage: "after_send" as const,
        commandKey: "initial",
        sessionId: "sess-1",
        pausedAt: new Date().toISOString(),
      };
      await query(
        "UPDATE agent_tasks SET provider_runtime=? WHERE id='task-1'",
        [JSON.stringify({ dashboardManaged: kb.runtime, billingPause: pause })],
      );
      await expect(
        pauseKnowledgeBaseForBilling(
          { ...kb.claim, leaseToken: "stale" },
          new AiBillingPausedError(pause),
        ),
      ).rejects.toThrow("AI_RESUME_PENDING");
      await pauseKnowledgeBaseForBilling(
        kb.claim,
        new AiBillingPausedError(pause),
      );
      const send = vi.fn();
      const dependencies = {
        resolveCredential: credential,
        createClient: send as any,
      };
      await expect(
        continueKnowledgeBaseAfterRecharge(
          { ...kb.input, userId: 2 },
          dependencies,
        ),
      ).rejects.toThrow("AI_BILLING_TASK_OWNERSHIP");
      await expect(
        runWithEnterpriseProjectScope(
          {
            ownerUserId: 1,
            actorUserId: 1,
            enterpriseProjectId: "other-project",
            isLegacyDefault: false,
          },
          () => continueKnowledgeBaseAfterRecharge(kb.input, dependencies),
        ),
      ).rejects.toThrow("AI_BILLING_TASK_OWNERSHIP");
      expect(send).not.toHaveBeenCalled();
    });
    it("prechecks paid Low text edits but permits local image-only edits with zero available balance", async () => {
      const kb = await seedBillingKnowledge("before_send");
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=0 WHERE user_id=?",
        [owner],
      );
      await query(
        "UPDATE conversation_turns SET metadata=JSON_SET(metadata,'$.recovery',CAST(? AS JSON)) WHERE id=?",
        [
          JSON.stringify({
            kind: "turn",
            nodeEditMode: "low_v1",
            userMessage: "",
          }),
          kb.input.turnId,
        ],
      );
      await assertKnowledgeBaseDispatchFunds(1, kb.input.turnId);
      await query(
        "UPDATE conversation_turns SET metadata=JSON_SET(metadata,'$.recovery.userMessage','edit text') WHERE id=?",
        [kb.input.turnId],
      );
      await expect(
        assertKnowledgeBaseDispatchFunds(1, kb.input.turnId),
      ).rejects.toThrow("AI_BALANCE_INSUFFICIENT");
      expect(await query("SELECT * FROM ai_charge_commands")).toEqual([]);
    });
    it("clears a balance marker only after an accepted new command and marks a second exhaustion with its own key", async () => {
      await seedBillingKnowledge("after_send");
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=2000 WHERE user_id=?",
        [owner],
      );
      await authorizeManagedAiCommand(input);
      const usage = {
        input_tokens: 20000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
      };
      const running = observation(1, usage);
      running.events.pop();
      running.session.status = "running";
      expect((await observeManagedAiUsage(running)).pause?.commandKey).toBe(
        "initial",
      );
      await observeManagedAiUsage(observation(1, usage));
      await query(
        "UPDATE unified_money_wallets SET balance_ten_thousandths=2000 WHERE user_id=?",
        [owner],
      );
      await authorizeManagedAiCommand({ ...input, commandKey: "second" });
      const next: any = observation(1, usage);
      next.commands.push({
        key: "second",
        eventId: "user-2",
        createdAt: new Date().toISOString(),
      });
      next.events.push({
        id: "user-2",
        type: "user.message",
        processed_at: new Date().toISOString(),
      });
      next.session.status = "running";
      expect((await observeManagedAiUsage(next)).pause).toBeUndefined();
      next.events.push({
        id: "model-second",
        type: "span.model_request_end",
        processed_at: new Date().toISOString(),
        model_usage: usage,
      });
      next.session.usage = { ...usage, input_tokens: 40000 };
      expect((await observeManagedAiUsage(next)).pause).toMatchObject({
        reason: "balance",
        commandKey: "second",
        stage: "after_send",
      });
    });
  },
);
