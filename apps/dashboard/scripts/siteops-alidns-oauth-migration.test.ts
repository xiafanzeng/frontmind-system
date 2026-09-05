import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(path.resolve(root, relativePath), "utf8"));
}

describe("SiteOps AliDNS OAuth-only contract migration", () => {
  it("replaces RAM and domain commerce storage with one refresh-token grant", async () => {
    const snapshot = await readJson("drizzle/meta/0065_snapshot.json");
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

  it("clears legacy bindings before destructive schema contraction", async () => {
    const sql = await readFile(
      path.resolve(root, "drizzle/0065_siteops_alidns_oauth.sql"),
      "utf8",
    );

    const before = (left: string, right: string) => {
      const leftIndex = sql.indexOf(left);
      expect(leftIndex).toBeGreaterThanOrEqual(0);
      expect(leftIndex).toBeLessThan(sql.indexOf(right));
    };

    before(
      "DELETE FROM `site_dns_records`",
      "DROP TABLE `site_domain_operations`",
    );
    before(
      "DELETE FROM `site_domain_operations`",
      "DROP TABLE `site_domain_operations`",
    );
    before("DELETE FROM `site_operations`", "MODIFY COLUMN `kind`");
    before(
      "DELETE FROM `site_provider_connections`",
      "DROP TABLE `site_provider_connections`",
    );
    before(
      "ADD `current_task_started_at` timestamp NULL",
      "MODIFY COLUMN `current_task_started_at` timestamp NOT NULL",
    );
    expect(sql).toContain("SET `current_task_started_at` = `created_at`");
    expect(sql).toContain("'$.resetAppliedAt'");
    expect(sql).toContain("'$.minimumKnowledgeSnapshotVersion'");
    expect(sql).toContain("'frontmind.siteops-rebuild.v1'");
    expect(sql).toContain("'approved_reset_unpublish'");
    expect(sql).toContain(
      "`project`.`minimum_knowledge_snapshot_version` = GREATEST",
    );
    expect(sql).toContain("SET `deletedAt` = NOW()");
    expect(sql).toContain(
      "IN ('domain_quote','domain_status','operation_recovery')",
    );
    expect(sql).toContain("WHERE `slot` = 'siteops_aliyun_broker'");
    expect(sql).toContain("`provider` IN ('aliyun_domain','aliyun_alidns')");
    expect(sql).toContain(
      "`provider` = 'aliyun_esa' AND `kind` IN ('dns_apply','dns_rollback')",
    );
    expect(sql).toContain("'domain_sync','dns_apply','dns_rollback'");
    expect(sql).not.toContain("CREATE TABLE `site_domain_operations`");
    expect(sql).not.toContain("`role_arn` varchar");
    expect(sql).not.toContain("`encrypted_external_id` text");
  });

  it("classifies the destructive migration as contract", async () => {
    const policy = await readJson("drizzle/migration-policy.json");
    expect(policy.migrations["0065_siteops_alidns_oauth"]).toBe("contract");
  });
});
