import { describe, expect, it } from "vitest";

import {
  classifyMigrationJournal,
  readAppliedMigrationJournal,
  type AppliedMigration,
  type MigrationManifest,
} from "./migration-journal";

const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];

function manifest(
  classifications: Array<"expand" | "contract"> = [
    "contract",
    "expand",
    "expand",
  ],
): MigrationManifest {
  const migrations = classifications.map((classification, idx) => ({
    idx,
    tag: `${String(idx).padStart(4, "0")}_migration`,
    when: 1_000 + idx,
    sqlSha256: hashes[idx]!,
    classification,
  }));
  return {
    schemaVersion: 2,
    dialect: "mysql",
    journalVersion: "7",
    count: migrations.length,
    latestTag: migrations.at(-1)!.tag,
    migrations,
    journalHash: "d".repeat(64),
    schemaSnapshot: `meta/${String(migrations.length - 1).padStart(4, "0")}_snapshot.json`,
    schemaTableCount: 1,
    schemaContract: {
      contractVersion: 1,
      tables: [
        {
          name: "fixture",
          engine: "innodb",
          columns: [
            {
              name: "id",
              type: "int",
              nullable: false,
              autoIncrement: true,
            },
          ],
          primaryKey: ["id"],
          indexes: [],
          foreignKeys: [],
          checks: [],
        },
      ],
    },
    schemaHash: "e".repeat(64),
  };
}

function applied(count: number): AppliedMigration[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    hash: hashes[index]!,
    createdAt: 1_000 + index,
  }));
}

describe("migration journal classification", () => {
  it("distinguishes exact, strict-prefix pending and ahead ledgers", () => {
    expect(classifyMigrationJournal(manifest(), applied(3))).toMatchObject({
      status: "exact",
      pending: [],
      allPendingExpand: false,
    });
    expect(classifyMigrationJournal(manifest(), applied(1))).toMatchObject({
      status: "pending",
      allPendingExpand: true,
      pending: [{ idx: 1 }, { idx: 2 }],
    });
    expect(
      classifyMigrationJournal(manifest(["contract", "expand"]), applied(3)),
    ).toMatchObject({
      status: "ahead",
      pending: [],
      allPendingExpand: false,
    });
  });

  it("fails closed for a mismatched hash or timestamp", () => {
    const wrongHash = applied(2);
    wrongHash[1]!.hash = "e".repeat(64);
    expect(classifyMigrationJournal(manifest(), wrongHash)).toMatchObject({
      status: "diverged",
      mismatchIndex: 1,
      allPendingExpand: false,
    });

    const wrongTimestamp = applied(2);
    wrongTimestamp[0]!.createdAt += 1;
    expect(classifyMigrationJournal(manifest(), wrongTimestamp)).toMatchObject({
      status: "diverged",
      mismatchIndex: 0,
    });
  });

  it("does not authorize automatic migration when any pending entry is contract", () => {
    expect(
      classifyMigrationJournal(
        manifest(["contract", "expand", "contract"]),
        applied(1),
      ),
    ).toMatchObject({
      status: "pending",
      allPendingExpand: false,
    });
  });
});

describe("migration ledger loading", () => {
  it("accepts MySQL 8.4 uppercase INFORMATION_SCHEMA-style field labels", async () => {
    await expect(
      readAppliedMigrationJournal({
        execute: async () => [
          [
            {
              ID: 1,
              HASH: "A".repeat(64),
              CREATED_AT: "1000",
            },
          ],
        ],
      }),
    ).resolves.toEqual([
      {
        id: 1,
        hash: "a".repeat(64),
        createdAt: 1_000,
      },
    ]);
  });

  it("treats a genuinely absent Drizzle ledger as an empty database", async () => {
    const error = Object.assign(new Error("missing"), {
      code: "ER_NO_SUCH_TABLE",
      errno: 1146,
    });
    await expect(
      readAppliedMigrationJournal({
        execute: async () => {
          throw error;
        },
      }),
    ).resolves.toEqual([]);
  });

  it("rejects malformed ledger rows and propagates unrelated DB failures", async () => {
    await expect(
      readAppliedMigrationJournal({
        execute: async () => [[{ id: 1, hash: "bad", createdAt: 1_000 }]],
      }),
    ).rejects.toThrow("MIGRATION_LEDGER_ROW_INVALID:0");
    await expect(
      readAppliedMigrationJournal({
        execute: async () => {
          throw Object.assign(new Error("denied"), {
            code: "ER_TABLEACCESS_DENIED_ERROR",
          });
        },
      }),
    ).rejects.toThrow("denied");
  });
});
