import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMigrationManifest,
  parseMigrationManifest,
} from "./migration-manifest.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function copiedMigrations() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "frontmind-migration-manifest-"),
  );
  temporaryRoots.push(root);
  const folder = path.join(root, "drizzle");
  await fs.cp(path.resolve("drizzle"), folder, { recursive: true });
  return folder;
}

describe("migration manifest", () => {
  it("binds every current journal entry to its SQL hash", async () => {
    const journal = JSON.parse(
      await fs.readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
    );
    const manifest = await createMigrationManifest({
      migrationsFolder: path.resolve("drizzle"),
    });

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      dialect: "mysql",
      count: journal.entries.length,
      latestTag: journal.entries.at(-1)?.tag,
      schemaSnapshot: "meta/0068_snapshot.json",
      schemaTableCount: 85,
      schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(manifest.schemaContract.tables).toHaveLength(85);
    expect(
      manifest.schemaContract.tables.map((table) => table.name),
    ).not.toContain("__drizzle_migrations");
    expect(manifest.migrations).toHaveLength(journal.entries.length);
    expect(manifest.migrations[0]).toMatchObject({
      idx: 0,
      tag: "0000_fine_shotgun",
      classification: "contract",
    });
    expect(parseMigrationManifest(manifest)).toBe(manifest);
  });

  it("rejects a manifest whose journal hash no longer covers its entries", async () => {
    const manifest = await createMigrationManifest({
      migrationsFolder: path.resolve("drizzle"),
    });
    const tampered = structuredClone(manifest);
    tampered.migrations[0]!.sqlSha256 = "f".repeat(64);

    expect(() => parseMigrationManifest(tampered)).toThrow(
      "MIGRATION_MANIFEST_HASH_MISMATCH",
    );
  });

  it("rejects a manifest whose schema contract no longer matches its hash", async () => {
    const manifest = await createMigrationManifest({
      migrationsFolder: path.resolve("drizzle"),
    });
    const tampered = structuredClone(manifest);
    tampered.schemaContract.tables[0]!.engine = "myisam";

    expect(() => parseMigrationManifest(tampered)).toThrow(
      /DATABASE_SCHEMA_CONTRACT_INVALID|MIGRATION_MANIFEST_HASH_MISMATCH/u,
    );
  });

  it("blocks a new migration until policy explicitly classifies it", async () => {
    const folder = await copiedMigrations();
    const journalPath = path.join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    const probeIndex = journal.entries.length;
    const probePrefix = String(probeIndex).padStart(4, "0");
    const previousPrefix = String(probeIndex - 1).padStart(4, "0");
    const probeTag = `${probePrefix}_additive_release_probe`;
    journal.entries.push({
      idx: probeIndex,
      version: "7",
      when: Number(journal.entries.at(-1)?.when ?? 0) + 1,
      tag: probeTag,
      breakpoints: true,
    });
    await fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await fs.writeFile(
      path.join(folder, `${probeTag}.sql`),
      "CREATE TABLE `release_probe` (`id` int NOT NULL);\n",
    );
    await fs.copyFile(
      path.join(folder, "meta", `${previousPrefix}_snapshot.json`),
      path.join(folder, "meta", `${probePrefix}_snapshot.json`),
    );

    await expect(
      createMigrationManifest({ migrationsFolder: folder }),
    ).rejects.toThrow(`MIGRATION_CLASSIFICATION_REQUIRED:${probeTag}`);

    const policyPath = path.join(folder, "migration-policy.json");
    const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
    policy.migrations[probeTag] = "expand";
    await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await expect(
      createMigrationManifest({ migrationsFolder: folder }),
    ).resolves.toMatchObject({
      count: probeIndex + 1,
      latestTag: probeTag,
      migrations: expect.arrayContaining([
        expect.objectContaining({
          tag: probeTag,
          classification: "expand",
        }),
      ]),
    });
  });

  it("rejects policy drift to an unknown baseline or migration tag", async () => {
    const folder = await copiedMigrations();
    const policyPath = path.join(folder, "migration-policy.json");
    const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
    policy.historicalBaselineThrough = "9999_unknown";
    await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await expect(
      createMigrationManifest({ migrationsFolder: folder }),
    ).rejects.toThrow("MIGRATION_POLICY_BASELINE_UNKNOWN");

    policy.historicalBaselineThrough = "0048_api_usage_coverage_claims";
    policy.migrations["9999_unknown"] = "expand";
    await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    await expect(
      createMigrationManifest({ migrationsFolder: folder }),
    ).rejects.toThrow("MIGRATION_POLICY_ENTRY_UNKNOWN:9999_unknown");
  });
});
