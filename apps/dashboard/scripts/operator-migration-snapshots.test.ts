import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoEmptyMigrationBlocks } from "./check-migration-append-only.mjs";

describe("operator workspace migration stages", () => {
  async function snapshot(idx: number) {
    return JSON.parse(
      await readFile(
        path.resolve(
          "drizzle/meta",
          `${String(idx).padStart(4, "0")}_snapshot.json`,
        ),
        "utf8",
      ),
    );
  }
  it("records each intermediate schema and a continuous snapshot chain", async () => {
    const [base, projects, wallet, ai, publisher] = await Promise.all(
      [60, 61, 62, 63, 64].map(snapshot),
    );
    expect([
      projects.prevId,
      wallet.prevId,
      ai.prevId,
      publisher.prevId,
    ]).toEqual([base.id, projects.id, wallet.id, ai.id]);
    expect(
      [projects, wallet, ai, publisher].map(
        (s) => Object.keys(s.tables).length,
      ),
    ).toEqual([92, 96, 101, 101]);
    expect(projects.tables).toHaveProperty("enterprise_project_questions");
    expect(projects.tables).not.toHaveProperty("unified_money_wallets");
    expect(wallet.tables).toHaveProperty("unified_money_wallets");
    expect(wallet.tables).toHaveProperty("monitoring_users");
    expect(wallet.tables).not.toHaveProperty("ai_charge_commands");
    expect(ai.tables).toHaveProperty("ai_charge_commands");
    expect(ai.tables.ai_billing_configuration.columns).toHaveProperty(
      "sync_token",
    );
    // Embedded publisher tables remain migration-owned, as in earlier fused
    // Dashboard snapshots. 0065 changes no Dashboard-owned table shape.
    expect(publisher.tables).toEqual(ai.tables);
  });
  it("registers the four ordered backfill migrations and keeps every execution block valid", async () => {
    const journal = JSON.parse(
      await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
    );
    const policy = JSON.parse(
      await readFile(path.resolve("drizzle/migration-policy.json"), "utf8"),
    );
    const entries = journal.entries.slice(61, 65);
    expect(entries.map((entry: { tag: string }) => entry.tag)).toEqual([
      "0062_enterprise_operator_projects",
      "0063_unified_account_wallet",
      "0064_ai_cost_accounting",
      "0065_publisher_enterprise_projects",
    ]);
    for (const entry of entries) {
      expect(policy.migrations[entry.tag]).toBe("contract");
      const sql = await readFile(
        path.resolve("drizzle", `${entry.tag}.sql`),
        "utf8",
      );
      expect(() => assertNoEmptyMigrationBlocks(entry.tag, sql)).not.toThrow();
    }
  });
});
