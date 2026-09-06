import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(path.resolve(root, relativePath), "utf8"));
}

describe("unified SiteOps AliDNS OAuth migration", () => {
  it("creates only the refresh-token grant without RAM or domain-commerce storage", async () => {
    const snapshot = await readJson("drizzle/meta/0058_snapshot.json");
    const tables = snapshot.tables as Record<
      string,
      {
        columns: Record<string, { type: string; notNull: boolean }>;
        foreignKeys: Record<
          string,
          { tableTo: string; columnsFrom: string[]; onDelete: string }
        >;
      }
    >;

    expect(tables).not.toHaveProperty("site_domain_operations");
    expect(tables.site_dns_records?.columns).not.toHaveProperty(
      "domain_operation_id",
    );

    const connection = tables.site_provider_connections!;
    expect(Object.keys(connection.columns)).toEqual([
      "id",
      "project_id",
      "user_id",
      "provider",
      "account_uid",
      "oauth_credential_id",
      "encryption_version",
      "encrypted_refresh_token",
      "encryption_iv",
      "encryption_auth_tag",
      "capabilities",
      "status",
      "verified_at",
      "last_error_code",
      "created_at",
      "updated_at",
    ]);
    expect(connection.columns.status?.type).toBe(
      "enum('active','invalid','revoked')",
    );
    expect(Object.values(connection.foreignKeys)).toContainEqual(
      expect.objectContaining({
        tableTo: "presales_api_credentials",
        columnsFrom: ["oauth_credential_id"],
        onDelete: "restrict",
      }),
    );

    const projects = tables.site_projects!.columns;
    expect(projects.current_task_started_at).toMatchObject({ notNull: true });
    expect(projects.minimum_knowledge_snapshot_version).toMatchObject({
      type: "int unsigned",
      notNull: false,
    });
  });

  it("starts from an empty SiteOps schema and preserves all existing data", async () => {
    const before = await readJson("drizzle/meta/0057_snapshot.json");
    const after = await readJson("drizzle/meta/0058_snapshot.json");
    const sql = await readFile(
      path.resolve(root, "drizzle/0058_dashboard_production_parity.sql"),
      "utf8",
    );

    // Unlike standalone Dashboard 0065, the unified schema never had the RAM
    // grant or domain-commerce tables. Replaying its cleanup would destroy
    // unrelated production data; introduce the final OAuth schema directly.
    for (const table of [
      "site_domain_operations",
      "site_provider_connections",
      "site_dns_records",
      "site_operations",
      "site_projects",
      "site_builds",
      "site_deployments",
    ]) {
      expect(before.tables).not.toHaveProperty(table);
      if (table !== "site_domain_operations") {
        expect(sql).toContain(`CREATE TABLE \`${table}\``);
        expect(after.tables).toHaveProperty(table);
      }
    }
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim());
    expect(
      statements.filter((statement) =>
        /^(?:DELETE|UPDATE|INSERT|REPLACE|DROP|TRUNCATE|RENAME)\b/iu.test(
          statement,
        ),
      ),
    ).toEqual([]);
    expect(sql).not.toMatch(
      /\b(?:DROP|RENAME)\s+(?:TABLE|COLUMN|INDEX)|\bCREATE\s+TRIGGER/iu,
    );
    expect(sql).not.toContain("CREATE TABLE `site_domain_operations`");
    expect(sql).not.toContain("`domain_operation_id`");
    expect(sql).not.toContain("`active_financial_key`");
    expect(sql).not.toContain("`role_arn`");
    expect(sql).not.toContain("`encrypted_external_id`");
    expect(sql).toContain("'domain_sync','dns_apply','dns_rollback'");
    expect(after.tables.site_operations.columns.kind.type).not.toMatch(
      /domain_quote|domain_status|domain_purchase|domain_register|operation_recovery/u,
    );
    expect(
      after.tables.site_projects.columns.current_task_started_at,
    ).toMatchObject({
      type: "timestamp",
      notNull: true,
      default: "(now())",
    });
    expect(
      after.tables.site_projects.columns.minimum_knowledge_snapshot_version,
    ).toMatchObject({
      type: "int unsigned",
      notNull: false,
    });
    expect(
      after.tables.site_projects.columns.minimum_knowledge_snapshot_version
        .default,
    ).toBeUndefined();
  });

  it("classifies the direct OAuth introduction as expand and registers no destructive replay", async () => {
    const policy = await readJson("drizzle/migration-policy.json");
    const journal = await readJson("drizzle/meta/_journal.json");
    expect(policy.migrations["0058_dashboard_production_parity"]).toBe(
      "expand",
    );
    expect(
      journal.entries
        .filter((entry: { idx: number }) => entry.idx >= 58)
        .map((entry: { tag: string }) => entry.tag),
    ).toEqual([
      "0058_dashboard_production_parity",
      "0059_website_zhipu_provider",
      "0060_dashboard_zhipu_provider",
    ]);
    expect(policy.migrations).not.toHaveProperty("0065_siteops_alidns_oauth");
  });
});
