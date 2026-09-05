import { readFile } from "node:fs/promises";
import path from "node:path";

import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  websitePaymentReceipts,
  websiteProjectOrders,
} from "../drizzle/schema";

const drizzleRoot = path.resolve(process.cwd(), "drizzle");
const knowledgeBaseMysqlAcceptance = path.resolve(
  process.cwd(),
  "scripts/knowledge-base-mysql-acceptance.test.ts",
);
const knowledgeBaseMysqlE2eAcceptance = path.resolve(
  process.cwd(),
  "scripts/knowledge-base-manus-v2-mysql-e2e-acceptance.test.ts",
);
const apiUsageMigrationVerifier = path.resolve(
  process.cwd(),
  "scripts/verify-api-usage-migration-schema.mjs",
);

async function migration(name: string) {
  return readFile(path.join(drizzleRoot, name), "utf8");
}

describe("service portal migration chain", () => {
  it("keeps a complete Drizzle snapshot chain for every registered migration", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    let previousId: string | undefined;
    const ids = new Set<string>();
    for (const entry of journal.entries) {
      const snapshot = JSON.parse(
        await readFile(
          path.join(
            drizzleRoot,
            "meta",
            `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
          ),
          "utf8",
        ),
      ) as {
        id: string;
        prevId: string;
        version: string;
        dialect: string;
      };

      expect(snapshot.version).toBe("5");
      expect(snapshot.dialect).toBe("mysql");
      expect(ids.has(snapshot.id)).toBe(false);
      if (previousId) {
        expect(snapshot.prevId).toBe(previousId);
      }
      ids.add(snapshot.id);
      previousId = snapshot.id;
    }
  });

  it("registers every service migration in executable order", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(
      journal.entries
        .filter((entry) => entry.idx >= 15)
        .map((entry) => entry.tag),
    ).toEqual([
      "0015_service_portal",
      "0016_backfill_website_basic",
      "0017_contract_commercial_evidence",
      "0018_backfill_contract_commercial_evidence",
      "0019_scheduled_replacement_linkage",
      "0020_busy_zemo",
      "0021_flawless_husk",
      "0022_manual_service_orders",
      "0023_wide_turbo",
      "0024_condemned_oracle",
      "0025_admin_control_plane",
      "0026_workspace_content_revisions",
      "0027_delivery_tickets",
      "0028_production_delivery_workflows",
      "0029_dashboard_import_preflights",
      "0030_response_logic_record_revisions",
      "0031_payment_receipt_ledger",
      "0032_project_order_registry",
      "0033_huge_toxin",
      "0034_known_scarlet_spider",
      "0035_nervous_sauron",
      "0036_account-market-edition",
      "0037_remove-knowledge-plan",
      "0038_fine_loners",
      "0039_delivery_roles_and_knowledge_reset",
      "0040_flaky_the_executioner",
      "0041_lovely_harry_osborn",
      "0042_heavy_xorn",
      "0043_clumsy_lilandra",
      "0044_delivery_history_credentials_and_website_style",
      "0045_knowledge_base_state_machine",
      "0046_api_usage_snapshot_claims",
      "0047_api_usage_task_ledger",
      "0048_api_usage_coverage_claims",
      "0049_external_wechat_contract_authorization",
      "0050_nullable_manual_order_commercial_evidence",
      "0051_delivery_ticket_retention",
      "0052_delivery_ticket_retention_guards",
      "0053_low_dorian_gray",
      "0054_file_content_retention",
      "0055_provisioning_market_edition",
      "0056_project_order_deletion_tombstones",
      "0057_productive_kang",
      "0058_jenova_brand_tracking",
      "0059_delivery_ticket_workflow_contracts",
      "0060_knowledge_base_tree_policy",
      "0061_knowledge_base_resilient_manus_v2",
      "0062_hard_glorian",
      "0063_lean_blue_marvel",
      "0064_siteops_v1",
      "0065_siteops_alidns_oauth",
      "0066_visual_candidate_pools",
      "0067_siteops_revision_inputs",
      "0068_siteops_knowledge_input_epoch",
    ]);
  });

  it("adds immutable Website project attribution as an expand-only table", async () => {
    const migrationSql = await migration("0063_lean_blue_marvel.sql");
    expect(migrationSql).toContain(
      "CREATE TABLE `website_project_attributions`",
    );
    expect(migrationSql).toContain("`project_id` varchar(80) NOT NULL");
    expect(migrationSql).toContain(
      "`business_owner_name` varchar(40) NOT NULL",
    );
    expect(migrationSql).not.toMatch(
      /(?:^|-->\s*statement-breakpoint\s*)(?:ALTER|UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/imu,
    );
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0063_snapshot.json"),
        "utf8",
      ),
    );
    expect(
      snapshot.tables.website_project_attributions.columns.business_owner_name,
    ).toMatchObject({ type: "varchar(40)", notNull: true });
  });

  it("adds durable visual candidate pools, pages and item references as one expand migration", async () => {
    const migrationSql = await migration("0066_visual_candidate_pools.sql");
    expect(migrationSql).toContain("CREATE TABLE `visual_candidate_pools`");
    expect(migrationSql).toContain(
      "CREATE TABLE `visual_candidate_pool_pages`",
    );
    expect(migrationSql).toContain(
      "CREATE TABLE `visual_candidate_pool_items`",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT `visual_candidate_pool_items_preview_fk`",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT `visual_candidate_pool_pages_capacity_ck`",
    );
    expect(migrationSql).not.toMatch(
      /^(?:DROP|DELETE|UPDATE|INSERT|REPLACE|TRUNCATE|RENAME)\b/imu,
    );
    const policy = JSON.parse(
      await readFile(path.join(drizzleRoot, "migration-policy.json"), "utf8"),
    ) as { migrations: Record<string, string> };
    expect(policy.migrations["0066_visual_candidate_pools"]).toBe("expand");
  });

  it("adds immutable revision input assets as an expand-only table", async () => {
    const migrationSql = await migration("0067_siteops_revision_inputs.sql");
    expect(migrationSql).toContain("CREATE TABLE `site_build_input_assets`");
    expect(migrationSql).toContain(
      "CONSTRAINT `site_build_input_assets_build_source_uq` UNIQUE(`build_id`,`source_asset_id`)",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT `site_build_input_assets_local_asset_id_local_assets_id_fk`",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE `site_builds` ADD `content_plan_local_asset_id` varchar(36)",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE `site_builds` ADD `content_plan_sha256` varchar(64)",
    );
    expect(migrationSql).not.toMatch(
      /(?:^|-->\s*statement-breakpoint\s*)(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/imu,
    );
    const policy = JSON.parse(
      await readFile(path.join(drizzleRoot, "migration-policy.json"), "utf8"),
    ) as { migrations: Record<string, string> };
    expect(policy.migrations["0067_siteops_revision_inputs"]).toBe("expand");
  });

  it("adds nullable SiteOps knowledge epochs without backfilling historical rows", async () => {
    const migrationSql = await migration(
      "0068_siteops_knowledge_input_epoch.sql",
    );
    for (const coordinate of [
      ["site_projects", "knowledge_input_epoch_id"],
      ["knowledge_base_builds", "site_ops_knowledge_input_epoch_id"],
      ["knowledge_base_snapshots", "siteOpsKnowledgeInputEpochId"],
      ["knowledge_import_receipts", "siteOpsKnowledgeInputEpochId"],
      ["local_assets", "site_ops_knowledge_input_epoch_id"],
      ["site_build_input_assets", "site_ops_knowledge_input_epoch_id"],
    ] as const) {
      expect(migrationSql).toContain(
        `ALTER TABLE \`${coordinate[0]}\` ADD \`${coordinate[1]}\` varchar(36)`,
      );
    }
    expect(migrationSql).not.toMatch(
      /(?:^|-->\s*statement-breakpoint\s*)(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/imu,
    );
    const policy = JSON.parse(
      await readFile(path.join(drizzleRoot, "migration-policy.json"), "utf8"),
    ) as { migrations: Record<string, string> };
    expect(policy.migrations["0068_siteops_knowledge_input_epoch"]).toBe(
      "expand",
    );
  });

  it("adds an optional unsigned overseas brand-tracking quota as an expand migration", async () => {
    const migrationSql = await migration("0057_productive_kang.sql");
    expect(migrationSql.trim()).toBe(
      "ALTER TABLE `users` ADD `brandTrackingMonthlyLimit` int unsigned;",
    );
    expect(migrationSql).not.toMatch(
      /\b(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/iu,
    );
  });

  it("adds Manus v2 resilience fields as a data-preserving expand migration", async () => {
    const migrationSql = await migration(
      "0061_knowledge_base_resilient_manus_v2.sql",
    );
    for (const column of [
      "providerProtocol",
      "canonicalTaskId",
      "canonicalCredentialId",
      "handoffProvenance",
      "skillArchiveSha256",
      "contentCompletedAt",
      "packageStatus",
    ]) {
      expect(migrationSql).toContain(
        `ALTER TABLE \`knowledge_base_builds\` ADD \`${column}\``,
      );
    }
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX `knowledge_base_builds_canonical_task_idx`",
    );
    expect(migrationSql).not.toMatch(
      /(?:^|-->\s*statement-breakpoint\s*)(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/imu,
    );
    expect(migrationSql).not.toMatch(/\bFOREIGN KEY\b/iu);
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0061_snapshot.json"),
        "utf8",
      ),
    );
    expect(
      snapshot.tables.knowledge_base_builds.indexes
        .knowledge_base_builds_canonical_task_idx,
    ).toMatchObject({ isUnique: true, columns: ["canonicalTaskId"] });
    expect(
      snapshot.tables.knowledge_base_builds.foreignKeys
        .kb_builds_canonical_credential_fk,
    ).toBeUndefined();
  });

  it("adds the v2 operation and materialized knowledge-base stores without contract SQL", async () => {
    const migrationSql = await migration("0062_hard_glorian.sql");
    for (const table of [
      "agent_operations",
      "agent_tasks",
      "agent_events",
      "local_assets",
      "provider_file_leases",
      "artifacts",
      "knowledge_base_executions",
      "knowledge_base_working_sets",
    ]) {
      expect(migrationSql).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(migrationSql).toContain(
      "ALTER TABLE `api_credentials` ADD `agent_profile` varchar(32)",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE `knowledge_base_build_nodes` ADD `content_version` int unsigned",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE `knowledge_base_builds` ADD `execution_mode` varchar(32)",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE `knowledge_base_builds` ADD `content_version` int unsigned",
    );
    expect(migrationSql).not.toMatch(
      /ALTER TABLE `(?:api_credentials|knowledge_base_build_nodes|knowledge_base_builds)` ADD `(?:agent_profile|execution_mode|content_version)` [^;]*\bNOT NULL\b/iu,
    );
    expect(migrationSql).toContain("`create_marker` varchar(128) NOT NULL");
    expect(migrationSql).toContain("`provider_file_id` varchar(512)");
    expect(migrationSql).toContain("`storage_key_hash` varchar(64) NOT NULL");
    expect(migrationSql).toContain(
      "CONSTRAINT `local_assets_scope_storage_uq` UNIQUE(`scope`,`storage_key_hash`)",
    );
    expect(migrationSql).not.toContain("UNIQUE(`scope`,`storage_key`)");
    expect(migrationSql).not.toMatch(
      /(?:^|-->\s*statement-breakpoint\s*)(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/imu,
    );
    expect(migrationSql).not.toMatch(/\bFOREIGN KEY\b/iu);

    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0062_snapshot.json"),
        "utf8",
      ),
    );
    expect(snapshot.tables.agent_tasks.columns.create_marker.type).toBe(
      "varchar(128)",
    );
    expect(
      snapshot.tables.provider_file_leases.columns.provider_file_id.type,
    ).toBe("varchar(512)");
    expect(snapshot.tables.api_credentials.columns.agent_profile).toMatchObject(
      { type: "varchar(32)", notNull: false },
    );
    expect(
      snapshot.tables.knowledge_base_build_nodes.columns.content_version,
    ).toMatchObject({ type: "int unsigned", notNull: false });
    expect(
      snapshot.tables.knowledge_base_builds.columns.execution_mode,
    ).toMatchObject({ type: "varchar(32)", notNull: false });
    expect(
      snapshot.tables.knowledge_base_builds.columns.content_version,
    ).toMatchObject({ type: "int unsigned", notNull: false });
    expect(snapshot.tables.local_assets.columns.storage_key.type).toBe(
      "varchar(1024)",
    );
    expect(snapshot.tables.local_assets.columns.storage_key_hash).toMatchObject(
      { type: "varchar(64)", notNull: true },
    );
    expect(
      snapshot.tables.local_assets.indexes.local_assets_scope_storage_uq,
    ).toMatchObject({
      isUnique: true,
      columns: ["scope", "storage_key_hash"],
    });
  });

  it("keeps every 0062 index within the InnoDB 3072-byte key limit", async () => {
    const migrationSql = await migration("0062_hard_glorian.sql");
    const tableColumns = new Map<string, Map<string, number>>();
    const indexes: Array<{ table: string; name: string; columns: string[] }> =
      [];
    for (const match of migrationSql.matchAll(
      /CREATE TABLE `([^`]+)` \(([\s\S]*?)\n\);/gu,
    )) {
      const [, tableName, body] = match;
      const columns = new Map<string, number>();
      for (const column of body!.matchAll(/^\s*`([^`]+)`\s+([^,\n]+)/gmu)) {
        const definition = column[2]!;
        const varchar = /\bvarchar\((\d+)\)/iu.exec(definition);
        const bytes = varchar
          ? Number(varchar[1]) * 4
          : /\bbigint\b/iu.test(definition)
            ? 8
            : /\b(?:int|timestamp|enum)\b/iu.test(definition)
              ? 4
              : 16;
        columns.set(column[1]!, bytes);
      }
      tableColumns.set(tableName!, columns);
      for (const index of body!.matchAll(
        /CONSTRAINT `([^`]+)` (?:PRIMARY KEY|UNIQUE)\(([^)]+)\)/gu,
      )) {
        indexes.push({
          table: tableName!,
          name: index[1]!,
          columns: [...index[2]!.matchAll(/`([^`]+)`/gu)].map(
            (column) => column[1]!,
          ),
        });
      }
    }
    for (const index of migrationSql.matchAll(
      /CREATE (?:UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \(([^)]+)\)/gu,
    )) {
      indexes.push({
        table: index[2]!,
        name: index[1]!,
        columns: [...index[3]!.matchAll(/`([^`]+)`/gu)].map(
          (column) => column[1]!,
        ),
      });
    }
    const oversized = indexes.flatMap((index) => {
      const columns = tableColumns.get(index.table);
      const estimatedBytes = index.columns.reduce(
        (sum, column) => sum + (columns?.get(column) ?? 3_073),
        0,
      );
      return estimatedBytes > 3_072 ? [{ ...index, estimatedBytes }] : [];
    });
    expect(oversized).toEqual([]);
  });

  it("adds an independent fixed-point Jenova tracking ledger without migrating Monitor data", async () => {
    const migrationSql = await migration("0058_jenova_brand_tracking.sql");
    for (const table of [
      "jenova_brand_tracking_credentials",
      "jenova_brand_tracking_assignments",
      "jenova_brand_tracking_policies",
      "jenova_brand_tracking_sessions",
      "jenova_brand_tracking_turns",
    ]) {
      expect(migrationSql).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(migrationSql).toContain(
      "`rolling30DayLimit` decimal(20,8) NOT NULL DEFAULT '10.00000000'",
    );
    expect(migrationSql).toContain("`usageCost` decimal(20,8)");
    expect(migrationSql).toContain(
      "`sessionFee` decimal(20,8) NOT NULL DEFAULT '0.00000000'",
    );
    expect(migrationSql).not.toMatch(
      /(?:^|-->\s*statement-breakpoint\s*)(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/imu,
    );
    expect(migrationSql).not.toMatch(
      /presales_monitor_runs|monitoring_(?:batches|samples)/iu,
    );
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      expect(
        (statement.match(/\bCREATE\s+(?:TABLE|INDEX)\b/giu) ?? []).length,
      ).toBeLessThanOrEqual(1);
    }
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0058_snapshot.json"),
        "utf8",
      ),
    );
    expect(
      snapshot.tables.jenova_brand_tracking_credentials.indexes
        .jenova_bt_credentials_fingerprint_uq,
    ).toMatchObject({ isUnique: true, columns: ["fingerprint"] });
    expect(
      snapshot.tables.jenova_brand_tracking_turns.columns.usageCost,
    ).toMatchObject({ type: "decimal(20,8)", notNull: false });
  });

  it("adds delivery workflow relationships and credential linkage without rewriting tickets", async () => {
    const migrationSql = await migration(
      "0059_delivery_ticket_workflow_contracts.sql",
    );
    for (const column of [
      "parentTicketId",
      "rootTicketId",
      "workflowStageKey",
      "isWorkflowContainer",
      "credentialTargetUserId",
      "credentialRequestKind",
    ]) {
      expect(migrationSql).toContain(
        `ALTER TABLE \`delivery_tickets\` ADD \`${column}\``,
      );
    }
    for (const relation of [
      "delivery_tickets_parent_stage_uq",
      "delivery_tickets_parent_ticket_fk",
      "delivery_tickets_root_ticket_fk",
      "delivery_tickets_credentialTargetUserId_users_id_fk",
    ]) {
      expect(migrationSql).toContain(relation);
    }
    expect(migrationSql).toContain("ON DELETE cascade");
    expect(migrationSql).not.toMatch(
      /(?:^|-->\s*statement-breakpoint\s*)(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/imu,
    );
  });

  it("adds domestic-by-default purchase edition fields as an expand migration", async () => {
    const migrationSql = await migration(
      "0055_provisioning_market_edition.sql",
    );
    for (const table of [
      "website_user_provisions",
      "website_manual_service_orders",
    ]) {
      expect(migrationSql).toContain(
        `ALTER TABLE \`${table}\` ADD \`marketEdition\` enum('domestic','overseas') NOT NULL DEFAULT 'domestic'`,
      );
    }
    expect(migrationSql).not.toMatch(
      /\b(?:UPDATE|INSERT|REPLACE|DELETE|DROP|TRUNCATE|RENAME)\b/iu,
    );
  });

  it("adds external contract authorization evidence without replacing legacy signing columns", async () => {
    const migrationSql = await migration(
      "0049_external_wechat_contract_authorization.sql",
    );
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const column of [
      "contractAuthorizationMode",
      "contractAuthorizationEventReference",
      "contractAuthorizedAt",
    ]) {
      expect(migrationSql).toContain(`\`${column}\``);
    }
  });

  it("stores no commercial amount or electronic contract id before evidence exists", async () => {
    const migrationSql = await migration(
      "0050_nullable_manual_order_commercial_evidence.sql",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE `website_manual_service_orders` MODIFY COLUMN `amountFen` int unsigned",
    );
    expect(migrationSql).toContain(
      "SET `amountFen` = NULL WHERE `amountFen` = 0",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE `website_user_provisions` MODIFY COLUMN `contractId` varchar(128)",
    );
    expect(migrationSql).not.toMatch(/ADD `(?:amountFen|contractId)`/u);
  });

  it("adds compact facts and a bounded scan for 30-day ticket retention", async () => {
    const migrationSql = await migration("0051_delivery_ticket_retention.sql");
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const statement of [
      "CREATE TABLE `delivery_workflow_milestones`",
      "ADD `archivedContentAssetPublishUsed`",
      "ADD `archivedWebsiteContentPublishUsed`",
      "delivery_tickets_status_resolved_id_idx",
    ]) {
      expect(migrationSql).toContain(statement);
    }
    expect(migrationSql).not.toMatch(/\bUPDATE\s+`delivery_tickets`\b/iu);
  });

  it("retains reset safety tombstones and unfinished cleanup jobs after ticket expiry", async () => {
    const migrationSql = await migration(
      "0052_delivery_ticket_retention_guards.sql",
    );
    for (const statement of [
      "CREATE TABLE `knowledge_base_conversation_retention_tombstones`",
      "MODIFY COLUMN `resetRequestId` varchar(36)",
      "ON DELETE set null",
    ]) {
      expect(migrationSql).toContain(statement);
    }
  });

  it("stores long knowledge cleanup paths without widening the indexed identity", async () => {
    const migrationSql = await migration("0053_low_dorian_gray.sql");
    expect(migrationSql).toContain(
      "ALTER TABLE `knowledge_base_reset_cleanup_jobs` ADD `localAssetKey` text",
    );
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
  });

  it("adds independent file-content and conversation-idle retention scans", async () => {
    const migrationSql = await migration("0054_file_content_retention.sql");
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const statement of [
      "ADD `uploadedAt` timestamp",
      "ADD `contentExpiresAt` timestamp",
      "ADD `contentDeletedAt` timestamp",
      "`conversations` (`updatedAt`,`id`)",
      "`upstream_resources` (`kind`,`contentExpiresAt`,`contentDeletedAt`,`id`)",
      "`upstream_resources` (`conversationId`,`kind`)",
    ]) {
      expect(migrationSql).toContain(statement);
    }
  });

  it("adds an immutable task usage ledger and coverage proof without destructive changes", async () => {
    const migrationSql = await migration("0047_api_usage_task_ledger.sql");
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const statement of [
      "CREATE TABLE `api_usage_credential_coverage`",
      "CREATE TABLE `api_usage_task_ledger`",
      "`isTerminal` boolean NOT NULL DEFAULT false",
      "`allTasksSettled` boolean NOT NULL DEFAULT false",
      "api_usage_task_ledger_scope_task_uq",
      "api_usage_task_ledger_pool_time_idx",
    ]) {
      expect(migrationSql).toContain(statement);
    }
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0047_snapshot.json"),
        "utf8",
      ),
    );
    expect(
      snapshot.tables.api_usage_task_ledger.columns.isTerminal,
    ).toMatchObject({ type: "boolean", notNull: true, default: false });
    expect(
      snapshot.tables.api_usage_credential_coverage.columns.allTasksSettled,
    ).toMatchObject({ type: "boolean", notNull: true, default: false });
  });

  it("adds token-bound coverage scan claims without rewriting ledger facts", async () => {
    const migrationSql = await migration("0048_api_usage_coverage_claims.sql");
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const statement of [
      "ADD `scanGeneration` int unsigned DEFAULT 0 NOT NULL",
      "ADD `scanToken` varchar(36)",
      "ADD `scanStartedAtMs` bigint unsigned",
      "CREATE INDEX `api_usage_credential_coverage_claim_idx`",
    ]) {
      expect(migrationSql).toContain(statement);
    }
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0048_snapshot.json"),
        "utf8",
      ),
    );
    expect(
      snapshot.tables.api_usage_credential_coverage.columns.scanGeneration,
    ).toMatchObject({ type: "int unsigned", notNull: true, default: 0 });
    expect(
      snapshot.tables.api_usage_credential_coverage.indexes
        .api_usage_credential_coverage_claim_idx,
    ).toMatchObject({
      isUnique: false,
      columns: ["scanToken", "scanStartedAtMs"],
    });
  });

  it("keeps the 0046-0048 ordered-ledger schema verifier exact", async () => {
    const verifier = await readFile(apiUsageMigrationVerifier, "utf8");

    for (const requiredGuard of [
      "MIGRATION_LEDGER_NOT_APPROVED_PREFIX",
      "MIGRATION_LEDGER_PREFIX_MISMATCH",
      "MIGRATION_LEDGER_INCOMPLETE",
      "API_USAGE_PENDING_COLUMN_PRESENT",
      "API_USAGE_PENDING_INDEX_PRESENT",
      "API_USAGE_PENDING_TABLE_PRESENT",
      "API_USAGE_COLUMN_SET_MISMATCH",
      "API_USAGE_FOREIGN_KEY_MISMATCH",
      "API_USAGE_0046_0048_SCHEMA_OK",
      "0046_api_usage_snapshot_claims",
      "0047_api_usage_task_ledger",
      "0048_api_usage_coverage_claims",
      "TABLE_NAME AS table_name",
      "COLUMN_DEFAULT AS column_default",
      "INDEX_NAME AS index_name",
      "CONSTRAINT_NAME AS constraint_name",
    ]) {
      expect(verifier).toContain(requiredGuard);
    }
  });

  it("adds monotonic API usage snapshot claims without rewriting usage data", async () => {
    const migrationSql = await migration("0046_api_usage_snapshot_claims.sql");
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const statement of [
      "ADD `syncGeneration` int unsigned DEFAULT 0 NOT NULL",
      "ADD `syncToken` varchar(36)",
      "ADD `syncStartedAt` timestamp",
      "CREATE INDEX `api_usage_snapshots_sync_claim_idx`",
    ]) {
      expect(migrationSql).toContain(statement);
    }
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0046_snapshot.json"),
        "utf8",
      ),
    );
    expect(
      snapshot.tables.api_usage_snapshots.columns.syncGeneration,
    ).toMatchObject({ type: "int unsigned", notNull: true, default: 0 });
    expect(snapshot.tables.api_usage_snapshots.columns.syncToken).toMatchObject(
      {
        type: "varchar(36)",
        notNull: false,
      },
    );
    expect(
      snapshot.tables.api_usage_snapshots.indexes
        .api_usage_snapshots_sync_claim_idx,
    ).toMatchObject({
      isUnique: false,
      columns: ["syncToken", "syncStartedAt"],
    });
  });

  it("adds the exactly-once knowledge-base state machine without destructive changes", async () => {
    const migrationSql = await migration(
      "0045_knowledge_base_state_machine.sql",
    );
    expect(migrationSql).not.toMatch(
      /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|RENAME\s+TABLE/iu,
    );
    for (const statement of [
      "ADD `operationKey` varchar(128)",
      "ADD `attachmentFileIds` json DEFAULT ('[]') NOT NULL",
      "ADD `metadata` json DEFAULT ('{}') NOT NULL",
      "ADD `generation` int unsigned DEFAULT 1 NOT NULL",
      "ADD `stateEpoch` int unsigned DEFAULT 0 NOT NULL",
      "ADD `activeTurnId` varchar(36)",
      "ADD `recoveryLeaseOwnerHash` varchar(64)",
      "ADD `recoveryLeaseExpiresAt` timestamp",
      "ADD `sourceTurnId` varchar(36)",
      "ADD `contentSha256` varchar(64)",
      "ADD CONSTRAINT `conversation_turns_operation_key_uq` UNIQUE(`operationKey`)",
      "ON DELETE set null ON UPDATE no action",
      "CREATE INDEX `conversation_turns_build_generation_idx`",
      "CREATE INDEX `conversation_turns_lease_idx`",
      "CREATE INDEX `knowledge_base_builds_active_turn_idx`",
      "CREATE INDEX `knowledge_base_builds_recovery_lease_idx`",
    ]) {
      expect(migrationSql).toContain(statement);
    }

    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0045_snapshot.json"),
        "utf8",
      ),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<
            string,
            { type: string; notNull: boolean; default?: unknown }
          >;
          indexes: Record<string, { isUnique: boolean; columns: string[] }>;
          foreignKeys: Record<
            string,
            { tableTo: string; columnsFrom: string[]; onDelete?: string }
          >;
        }
      >;
    };
    const turns = snapshot.tables.conversation_turns;
    const builds = snapshot.tables.knowledge_base_builds;
    const nodes = snapshot.tables.knowledge_base_build_nodes;
    expect(turns.columns.attachmentFileIds).toMatchObject({
      type: "json",
      notNull: true,
      default: "('[]')",
    });
    expect(turns.columns.metadata).toMatchObject({
      type: "json",
      notNull: true,
      default: "('{}')",
    });
    expect(builds.columns.generation).toMatchObject({
      type: "int unsigned",
      notNull: true,
      default: 1,
    });
    expect(builds.columns.stateEpoch).toMatchObject({
      type: "int unsigned",
      notNull: true,
      default: 0,
    });
    expect(builds.columns.recoveryLeaseOwnerHash).toMatchObject({
      type: "varchar(64)",
      notNull: false,
    });
    expect(builds.columns.recoveryLeaseExpiresAt).toMatchObject({
      type: "timestamp",
      notNull: false,
    });
    expect(
      builds.indexes.knowledge_base_builds_recovery_lease_idx,
    ).toMatchObject({
      isUnique: false,
      columns: ["status", "recoveryLeaseExpiresAt"],
    });
    expect(turns.indexes.conversation_turns_operation_key_uq).toMatchObject({
      isUnique: true,
      columns: ["operationKey"],
    });
    expect(
      turns.foreignKeys.conversation_turns_buildId_knowledge_base_builds_id_fk,
    ).toMatchObject({
      tableTo: "knowledge_base_builds",
      columnsFrom: ["buildId"],
      onDelete: "set null",
    });
    expect(nodes.columns.contentSha256).toMatchObject({
      type: "varchar(64)",
      notNull: false,
    });
  });

  it("keeps real-MySQL acceptance isolated from the production database", async () => {
    const [harness, e2eHarness] = await Promise.all([
      readFile(knowledgeBaseMysqlAcceptance, "utf8"),
      readFile(knowledgeBaseMysqlE2eAcceptance, "utf8"),
    ]);

    for (const source of [harness, e2eHarness]) {
      expect(source).toContain("frontmind_kb_acceptance");
      expect(source).toContain("DATABASE_MUST_BE_EMPTY");
      expect(source).toContain("TABLE_NAME AS tableName");
      expect(source).toContain("ENGINE AS engine");
      expect(source).not.toContain("process.env.DATABASE_URL");
      expect(source).not.toMatch(/DROP\s+(?:DATABASE|SCHEMA|TABLE)/iu);
    }
    expect(harness).toContain("reserveKnowledgeBaseStartBuild");
    expect(harness).toContain("reserveKnowledgeBaseTurn");
    expect(harness).toContain("claimKnowledgeBaseTurnForRecovery");
    expect(harness).toContain("FOR UPDATE");
    expect(harness).toContain("ER_DUP_ENTRY");
    expect(e2eHarness).toContain(
      "KB_MATERIALIZED_MYSQL_E2E_ACCEPTANCE_COMPLETE",
    );
    expect(e2eHarness).toContain("operation=materialize_initial_bundle");
    expect(e2eHarness).toContain("MATERIALIZED_LEAF_COUNT = 30");
    expect(e2eHarness).toContain('postKnowledgeBase("/confirm"');
    expect(e2eHarness).toContain("fakeProvider.rejectProviderCalls = true");
    expect(e2eHarness).toContain("runKnowledgeBasePackageSweep");
    expect(e2eHarness).toContain('entry.tag === "0062_hard_glorian"');
    expect(e2eHarness).not.toContain("/v1/tasks");
    expect(e2eHarness).toContain("taskSendBodies).toHaveLength(0)");
  });

  it("drops the delivery-role foreign keys by their executable migration names", async () => {
    const previousMigration = await migration(
      "0039_delivery_roles_and_knowledge_reset.sql",
    );
    const projectTeamMigration = await migration(
      "0040_flaky_the_executioner.sql",
    );

    for (const foreignKeyName of [
      "delivery_tickets_assigned_role_fk",
      "knowledge_base_reset_requests_role_fk",
    ]) {
      expect(previousMigration).toContain(`CONSTRAINT \`${foreignKeyName}\``);
      expect(projectTeamMigration).toContain(
        `DROP FOREIGN KEY \`${foreignKeyName}\``,
      );
    }
  });

  it("updates the reset-request member foreign key by its executable name", async () => {
    const originalResetMigration = await migration(
      "0039_delivery_roles_and_knowledge_reset.sql",
    );
    const projectIsolationMigration = await migration("0042_heavy_xorn.sql");

    expect(originalResetMigration).toContain(
      "CONSTRAINT `knowledge_base_reset_requests_member_fk`",
    );
    expect(projectIsolationMigration).toContain(
      "DROP FOREIGN KEY `knowledge_base_reset_requests_member_fk`",
    );
  });

  it("cascades project-owned conversations and resources with the customer project", async () => {
    const migrationSql = await migration("0042_heavy_xorn.sql");
    for (const foreignKeyName of [
      "conversations_project_assignment_fk",
      "upstream_resources_project_assignment_fk",
    ]) {
      expect(migrationSql).toMatch(
        new RegExp(
          `CONSTRAINT \`${foreignKeyName}\`[^;]*ON DELETE cascade ON UPDATE no action`,
        ),
      );
    }
    expect(
      migrationSql.match(/ON DELETE cascade ON UPDATE no action/g),
    ).toHaveLength(2);
  });

  it("keeps role slots nullable while preserving project ownership boundaries", async () => {
    const projectIsolationMigration = await migration("0042_heavy_xorn.sql");
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0042_snapshot.json"),
        "utf8",
      ),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, { notNull: boolean; type: string }>;
          foreignKeys: Record<
            string,
            {
              columnsFrom: string[];
              tableTo: string;
              onDelete?: string;
            }
          >;
        }
      >;
    };

    for (const statement of [
      "MODIFY COLUMN `engineerUserId` int;",
      "MODIFY COLUMN `assignedProjectAssignmentId` varchar(36);",
      "MODIFY COLUMN `assignedMemberId` int;",
      "ALTER TABLE `conversations` ADD `projectAssignmentId` varchar(36);",
      "ALTER TABLE `upstream_resources` ADD `projectAssignmentId` varchar(36);",
    ]) {
      expect(projectIsolationMigration).toContain(statement);
    }
    for (const foreignKeyName of [
      "delivery_project_assignments_engineerUserId_users_id_fk",
      "knowledge_base_reset_requests_assignedMemberId_users_id_fk",
      "kb_reset_project_assignment_fk",
    ]) {
      expect(projectIsolationMigration).toMatch(
        new RegExp(`CONSTRAINT \`${foreignKeyName}\`[^;]*ON DELETE set null`),
      );
    }

    expect(
      snapshot.tables.delivery_project_assignments.columns.engineerUserId,
    ).toMatchObject({ type: "int", notNull: false });
    expect(
      snapshot.tables.knowledge_base_reset_requests.columns
        .assignedProjectAssignmentId,
    ).toMatchObject({ type: "varchar(36)", notNull: false });
    expect(
      snapshot.tables.knowledge_base_reset_requests.columns.assignedMemberId,
    ).toMatchObject({ type: "int", notNull: false });
    expect(
      snapshot.tables.conversations.columns.projectAssignmentId,
    ).toMatchObject({ type: "varchar(36)", notNull: false });
    expect(
      snapshot.tables.upstream_resources.columns.projectAssignmentId,
    ).toMatchObject({ type: "varchar(36)", notNull: false });

    for (const [tableName, foreignKeyName] of [
      [
        "delivery_project_assignments",
        "delivery_project_assignments_engineerUserId_users_id_fk",
      ],
      [
        "knowledge_base_reset_requests",
        "knowledge_base_reset_requests_assignedMemberId_users_id_fk",
      ],
      ["knowledge_base_reset_requests", "kb_reset_project_assignment_fk"],
    ] as const) {
      expect(
        snapshot.tables[tableName].foreignKeys[foreignKeyName],
      ).toMatchObject({ onDelete: "set null" });
    }
    for (const [tableName, foreignKeyName] of [
      ["conversations", "conversations_project_assignment_fk"],
      ["upstream_resources", "upstream_resources_project_assignment_fk"],
    ] as const) {
      expect(
        snapshot.tables[tableName].foreignKeys[foreignKeyName],
      ).toMatchObject({ onDelete: "cascade" });
    }
  });

  it("merges delivery roles and removes protected ICP storage", async () => {
    const migrationSql = await migration("0043_clumsy_lilandra.sql");
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0043_snapshot.json"),
        "utf8",
      ),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, { type: string }>;
          foreignKeys: Record<string, unknown>;
          indexes: Record<string, unknown>;
        }
      >;
    };

    expect(migrationSql).toContain(
      "CONSTRAINT `_frontmind_three_roles_preflight_empty`",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT `_frontmind_icp_purge_preflight_empty`",
    );
    expect(migrationSql).toContain(
      "SET `workflowDomain` = 'ai_operations_engineer'",
    );
    expect(migrationSql).toContain(
      "DROP FOREIGN KEY `ticket_attachments_protected_material_fk`",
    );
    expect(migrationSql).toContain("DROP TABLE `icp_sensitive_materials`");

    expect(snapshot.tables).not.toHaveProperty("icp_sensitive_materials");
    expect(
      snapshot.tables.delivery_ticket_attachments.columns,
    ).not.toHaveProperty("protectedMaterialId");
    expect(
      snapshot.tables.delivery_ticket_attachments.columns,
    ).not.toHaveProperty("sensitivity");
    expect(snapshot.tables.users.columns.engineerRoleType.type).toBe(
      "enum('ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer')",
    );
    expect(
      snapshot.tables.delivery_project_assignments.columns.roleType.type,
    ).toBe(
      "enum('ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer')",
    );
  });

  it("keeps journal indexes and migration timestamps strictly increasing", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };

    for (const [position, entry] of journal.entries.entries()) {
      expect(entry.idx, entry.tag).toBe(position);
      if (position === 0) continue;
      const previous = journal.entries[position - 1];
      expect(entry.idx, `${previous.tag} -> ${entry.tag}`).toBeGreaterThan(
        previous.idx,
      );
      expect(entry.when, `${previous.tag} -> ${entry.tag}`).toBeGreaterThan(
        previous.when,
      );
    }
  });

  it("keeps every MySQL constraint and index identifier within 64 bytes", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };

    for (const entry of journal.entries) {
      const sql = await migration(`${entry.tag}.sql`);
      for (const match of sql.matchAll(
        /(?:CONSTRAINT|INDEX|TABLE|TRIGGER)\s+(?:IF NOT EXISTS\s+)?`([^`]+)`/g,
      )) {
        expect(
          Buffer.byteLength(match[1], "utf8"),
          `${entry.tag}: ${match[1]}`,
        ).toBeLessThanOrEqual(64);
      }
    }
  });

  it("keeps automatic timestamp precision aligned for MySQL 8.4", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };

    for (const entry of journal.entries) {
      const migrationSql = await migration(`${entry.tag}.sql`);
      for (const definition of migrationSql.matchAll(
        /`([^`]+)`\s+(?:timestamp|datetime)\((\d)\)[^\n]*/gi,
      )) {
        const [, columnName, precision] = definition;
        for (const automaticValue of definition[0].matchAll(
          /\b(?:CURRENT_TIMESTAMP|LOCALTIMESTAMP|LOCALTIME|NOW)\s*(?:\(\s*(\d*)\s*\))?/gi,
        )) {
          expect(
            automaticValue[1],
            `${entry.tag}.${columnName}: ${definition[0]}`,
          ).toBe(precision);
        }
      }
    }
  });

  it("keeps the fractional defaults and snapshots aligned with the schema", async () => {
    const dialect = new MySqlDialect();
    for (const column of [
      websitePaymentReceipts.createdAt,
      websiteProjectOrders.createdAt,
      websiteProjectOrders.updatedAt,
    ]) {
      expect(column.getSQLType()).toBe("timestamp(3)");
      expect(dialect.sqlToQuery(column.default!).sql).toBe(
        "CURRENT_TIMESTAMP(3)",
      );
    }
    expect(websiteProjectOrders.updatedAt.hasOnUpdateNow).toBe(true);

    for (const index of [31, 32, 33, 34]) {
      const snapshot = JSON.parse(
        await readFile(
          path.join(
            drizzleRoot,
            "meta",
            `${String(index).padStart(4, "0")}_snapshot.json`,
          ),
          "utf8",
        ),
      ) as {
        tables: Record<
          string,
          {
            columns: Record<
              string,
              { type: string; default?: string; onUpdate?: boolean }
            >;
          }
        >;
      };
      expect(
        snapshot.tables.website_payment_receipts.columns.createdAt,
      ).toMatchObject({
        type: "timestamp(3)",
        default: "CURRENT_TIMESTAMP(3)",
      });
      if (index >= 32) {
        expect(
          snapshot.tables.website_project_orders.columns.createdAt,
        ).toMatchObject({
          type: "timestamp(3)",
          default: "CURRENT_TIMESTAMP(3)",
        });
        expect(
          snapshot.tables.website_project_orders.columns.updatedAt,
        ).toMatchObject({
          type: "timestamp(3)",
          default: "CURRENT_TIMESTAMP(3)",
          onUpdate: true,
        });
      }
    }
  });

  it("creates period-bound delivery tickets with durable quota ordering", async () => {
    const servicePortal = await migration("0015_service_portal.sql");
    const tickets = await migration("0027_delivery_tickets.sql");
    expect(servicePortal).toMatch(
      /CREATE TABLE `service_quota_periods`[\s\S]*`revision` int unsigned NOT NULL DEFAULT 1/,
    );
    expect(tickets).toContain(
      "ALTER TABLE `service_quota_periods` ADD `contentAssetPublishLimit` int unsigned NOT NULL DEFAULT 0",
    );
    expect(tickets).toContain(
      "ALTER TABLE `service_quota_periods` ADD `websiteContentPublishLimit` int unsigned NOT NULL DEFAULT 0",
    );
    expect(tickets).toContain("CREATE TABLE `delivery_tickets`");
    expect(tickets).toContain(
      "CONSTRAINT `delivery_tickets_period_pool_ordinal_uq` UNIQUE(`quotaPeriodId`,`quotaPool`,`ordinal`)",
    );
    expect(tickets).toContain(
      "CREATE UNIQUE INDEX `delivery_redirect_previews_user_hash_uq` ON `delivery_redirect_previews` (`userId`,`fileHash`)",
    );
    expect(tickets).toContain(
      "CREATE INDEX `delivery_tickets_user_updated_id_idx` ON `delivery_tickets` (`userId`,`updatedAt`,`id`)",
    );
    expect(tickets).toContain(
      "CREATE INDEX `delivery_tickets_type_status_updated_id_idx` ON `delivery_tickets` (`type`,`status`,`updatedAt`,`id`)",
    );
    expect(tickets).toContain("'content_asset','website_operation'");
    expect(tickets).toContain(
      "'submitted','needs_information','scheduled','in_progress','completed','rejected','cancelled'",
    );
    for (const column of [
      "contractId",
      "quotaPeriodId",
      "materialUrls",
      "quotaState",
      "contentAssetPublishLimit",
      "websiteContentPublishLimit",
      "technicalDedupeKey",
      "operationResult",
      "purpose",
      "authorization",
      "copyrightNote",
      "revision",
    ]) {
      expect(tickets).toContain(`\`${column}\``);
    }
    for (const table of [
      "delivery_ticket_events",
      "delivery_ticket_attachments",
      "workspace_site_profiles",
      "workspace_site_checks",
      "delivery_redirect_previews",
    ]) {
      expect(tickets).toContain(`CREATE TABLE \`${table}\``);
    }
  });

  it("adds protected ICP materials, public delivery fields, and per-key usage snapshots", async () => {
    const productionWorkflows = await migration(
      "0028_production_delivery_workflows.sql",
    );
    for (const column of [
      "preferredMedia",
      "icpProvince",
      "publicSummary",
      "deliveryLinks",
      "protectedMaterialId",
      "sensitivity",
      "domainStatus",
      "domainVerifiedAt",
      "icpVerifiedAt",
    ]) {
      expect(productionWorkflows).toContain(`\`${column}\``);
    }
    for (const table of [
      "icp_sensitive_materials",
      "api_usage_policies",
      "api_usage_snapshots",
    ]) {
      expect(productionWorkflows).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(productionWorkflows).toContain(
      "`category` enum('business_license','subject_responsible_person_id','website_responsible_person_id'",
    );
    expect(productionWorkflows).toContain(
      "`scope` enum('website_frontend','managed_user')",
    );
    expect(productionWorkflows).toContain(
      "`limit` int unsigned NOT NULL DEFAULT 230000",
    );
    expect(productionWorkflows).toContain(
      "`warningRatioBasisPoints` int unsigned NOT NULL DEFAULT 8000",
    );

    const monthlyUsageAndBasicQuota = await migration("0033_huge_toxin.sql");
    expect(monthlyUsageAndBasicQuota).toContain(
      "ALTER TABLE `api_usage_snapshots` ADD `accountUsed`",
    );
    expect(monthlyUsageAndBasicQuota).toContain(
      "`period`.`contentAssetPublishLimit` = 1",
    );
    expect(monthlyUsageAndBasicQuota).toContain("'pending_confirmation'");
    expect(monthlyUsageAndBasicQuota).toContain("'suspended'");

    const usageOwner = await migration("0034_known_scarlet_spider.sql");
    expect(usageOwner).toContain("CREATE TABLE `user_usage_owners`");
    expect(usageOwner).toContain(
      "HAVING COUNT(DISTINCT `assignment`.`adminId`) = 1",
    );
    expect(usageOwner).toContain("`credential`.`status` = 'retired'");
  });

  it("adds a password-safe customer account stage after verified payment", async () => {
    const accountSetup = await migration("0023_wide_turbo.sql");
    expect(accountSetup).toContain(
      "'payment_required','account_setup_required','activation_required'",
    );
    for (const column of [
      "accountSetupIdempotencyKeyHash",
      "accountSetupRequestHash",
      "requestedPasswordHash",
      "accountSetupAt",
    ]) {
      expect(accountSetup).toContain(`\`${column}\``);
    }
    expect(accountSetup).not.toMatch(/password(?!Hash)/i);
  });

  it("creates the durable signing-first website order boundary", async () => {
    const manualOrders = await migration("0022_manual_service_orders.sql");
    expect(manualOrders).toContain(
      "CREATE TABLE `website_manual_service_orders`",
    );
    for (const column of [
      "externalContractId",
      "signingUrl",
      "signedPdfFileId",
      "signedPdfSha256",
      "paymentOrderId",
      "paymentTradeNo",
      "provisioningReference",
      "status",
    ]) {
      expect(manualOrders).toContain(`\`${column}\``);
    }
    expect(manualOrders).toContain(
      "'pending_admin','signature_required','payment_required','activation_required','active','rejected','failed'",
    );
  });

  it("adds every post-0015 service column before runtime can select it", async () => {
    const commercial = await migration("0017_contract_commercial_evidence.sql");
    for (const column of [
      "amountFen",
      "currency",
      "prepaidMonths",
      "orderReference",
      "externalContractReference",
      "signedAt",
      "signatoryId",
      "signingEvidence",
      "sourceQuestionId",
    ]) {
      expect(commercial).toContain(`ADD \`${column}\``);
    }
    expect(await migration("0019_scheduled_replacement_linkage.sql")).toContain(
      "ADD `replacesContractIds`",
    );
    expect(await migration("0020_busy_zemo.sql")).toContain(
      "ADD `enterpriseIdentityBoundAt`",
    );
    const versionedService = await migration("0021_flawless_husk.sql");
    expect(versionedService).toContain(
      "CREATE TABLE `service_progress_reports`",
    );
    expect(versionedService).toContain(
      "CREATE TABLE `user_password_setup_tokens`",
    );
    expect(versionedService).toContain(
      "ALTER TABLE `monitoring_batches` ADD `quotaPeriodId`",
    );
    expect(versionedService).toContain(
      "ALTER TABLE `workspace_questions` ADD `intentConfirmedRevision`",
    );
    expect(versionedService).not.toMatch(
      /UPDATE\s+`workspace_questions`[\s\S]*intentConfirmed/i,
    );
  });

  it("adds administrator-confirmed question selection and backfills history", async () => {
    const approval = await migration("0024_condemned_oracle.sql");
    for (const column of [
      "selectionApprovalStatus",
      "selectionRequestedAt",
      "selectionRequestedByUserId",
      "selectionApprovedAt",
      "selectionApprovedByUserId",
    ]) {
      expect(approval).toContain(`\`${column}\``);
    }
    expect(approval).toContain("WHERE `status` = 'selected'");
    expect(approval).toContain("`selectionApprovalStatus` = 'approved'");
    expect(approval).toContain("COALESCE(`selectedAt`, `createdAt`)");
    expect(approval).toContain("`locked` = true");
  });

  it("backfills commercial evidence only from completed website provisions", async () => {
    const backfill = await migration(
      "0018_backfill_contract_commercial_evidence.sql",
    );
    expect(backfill).toContain("contract.`source` = 'website'");
    expect(backfill).toContain("provision.`status` = 'completed'");
    expect(backfill).toContain("provision.`userId` IS NOT NULL");
    expect(backfill).toContain("contract.`signingEvidence`");
  });

  it("adds durable one-time dashboard import preflight nonces", async () => {
    const preflights = await migration("0029_dashboard_import_preflights.sql");
    expect(preflights).toContain("CREATE TABLE `dashboard_import_preflights`");
    for (const column of [
      "actorUserId",
      "workspaceUserId",
      "module",
      "dashboardRevision",
      "fileHash",
      "sectionId",
      "targetBatchKey",
      "expiresAt",
      "consumedAt",
    ]) {
      expect(preflights).toContain(`\`${column}\``);
    }
    expect(preflights).toContain(
      "dashboard_import_preflights_consumed_expires_idx",
    );
  });

  it("adds an optimistic revision to every response-logic record", async () => {
    const revisions = await migration(
      "0030_response_logic_record_revisions.sql",
    );
    expect(revisions).toContain(
      "ALTER TABLE `response_logic_entries` ADD `revision`",
    );
    expect(revisions).toContain("DEFAULT 1 NOT NULL");
  });

  it("creates an append-only hash-bound payment receipt ledger", async () => {
    const receipts = await migration("0031_payment_receipt_ledger.sql");
    expect(receipts).toContain("CREATE TABLE `website_payment_receipts`");
    for (const column of [
      "schemaVersion",
      "orderId",
      "tradeNo",
      "amountFen",
      "paidAt",
      "purchaseType",
      "scopeHash",
      "authorizationDigest",
      "reviewRequired",
    ]) {
      expect(receipts).toContain(`\`${column}\``);
    }
    expect(receipts).toContain(
      "CONSTRAINT `website_payment_receipts_orderId` PRIMARY KEY(`orderId`)",
    );
    expect(receipts).toContain(
      "CONSTRAINT `website_payment_receipts_tradeNo_unique` UNIQUE(`tradeNo`)",
    );
    expect(receipts).toContain(
      "`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)",
    );
    expect(receipts).toContain("`tradeNo` varchar(128) NOT NULL");
    expect(receipts).toContain(
      "`purchaseType` enum('monitoring','service') NOT NULL",
    );
    expect(receipts).toMatch(
      /website_payment_receipts_amount_ck` CHECK\([^)]*`amountFen` > 0 AND [^)]*`amountFen` <= 10000000\)/,
    );
    expect(receipts).toContain(
      "CREATE TRIGGER `website_payment_receipts_no_update`",
    );
    expect(receipts).toContain(
      "CREATE TRIGGER `website_payment_receipts_no_delete`",
    );
    expect(receipts).not.toMatch(/ON UPDATE CURRENT_TIMESTAMP/i);
    expect(receipts).not.toMatch(
      /`(?:token|session|userId|companyName|question|content)`/i,
    );
  });

  it("creates a durable project-order deletion registry", async () => {
    const orders = await migration("0032_project_order_registry.sql");
    expect(orders).toContain("CREATE TABLE `website_project_orders`");
    for (const column of [
      "orderId",
      "schemaVersion",
      "projectId",
      "purchaseType",
      "amountFen",
      "authorizationDigest",
      "state",
      "checkoutExpiresAt",
      "paidAt",
      "fulfilledAt",
      "lastEventAt",
      "revision",
    ]) {
      expect(orders).toContain(`\`${column}\``);
    }
    expect(orders).toContain(
      "`state` enum('pending','paid','fulfilling','fulfilled','review_required','terminal_failed','closed') NOT NULL",
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_authorizationDigest_unique` UNIQUE(`authorizationDigest`)",
    );
    expect(orders).toContain(
      "`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)",
    );
    expect(orders).toContain(
      "`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)",
    );
    expect(orders).toContain(
      "CREATE INDEX `website_project_orders_project_state_idx`",
    );
    expect(orders).not.toMatch(
      /`(?:authorizationToken|ownerSessionId|companyName)`/i,
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_paid_state_ck`",
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_fulfilled_state_ck`",
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_fulfilled_time_ck`",
    );
  });

  it("creates a compact permanent project-deletion barrier", async () => {
    const tombstones = await migration(
      "0056_project_order_deletion_tombstones.sql",
    );
    expect(tombstones).toContain(
      "CREATE TABLE `website_project_deletion_tombstones`",
    );
    for (const column of [
      "projectId",
      "schemaVersion",
      "status",
      "createdAt",
      "deletionRequestedAt",
      "completedAt",
    ]) {
      expect(tombstones).toContain(`\`${column}\``);
    }
    expect(tombstones).toContain("enum('active','deleting','deleted')");
    expect(tombstones).toContain(
      "ALTER TABLE `presales_upstream_resources` ADD `projectId`",
    );
    expect(tombstones).toContain(
      "ALTER TABLE `presales_monitor_runs` ADD `projectId`",
    );
    expect(tombstones).toContain("CREATE INDEX `presales_monitor_project_idx`");
    expect(tombstones).toContain(
      "CREATE INDEX `presales_upstream_resources_project_idx`",
    );
    expect(tombstones).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(tombstones).not.toMatch(/DROP\s+(?:TABLE|COLUMN|INDEX)/i);
    expect(tombstones).not.toMatch(
      /`(?:orderId|tradeNo|authorizationDigest|userId|companyName|question|content)`/i,
    );
  });

  it("adds delivery history, engineer origins and the website-style workflow incrementally", async () => {
    const delivery = await migration(
      "0044_delivery_history_credentials_and_website_style.sql",
    );
    expect(delivery).toContain(
      "delivery_tickets_member_status_resolved_id_idx",
    );
    for (const table of [
      "delivery_member_origins",
      "website_style_workflows",
      "website_style_sample_batches",
      "website_style_samples",
    ]) {
      expect(delivery).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(delivery).toContain("website_style_samples_attachment_fk");
    expect(delivery).not.toMatch(/(?:^|\n)\s*(?:DROP|TRUNCATE|DELETE)\s/im);
  });
});
