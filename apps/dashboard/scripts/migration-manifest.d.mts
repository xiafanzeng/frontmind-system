export type MigrationClassification = "expand" | "contract";

import type { DatabaseSchemaContract } from "./schema-contract.mjs";

export type GeneratedMigrationManifest = {
  schemaVersion: 2;
  dialect: "mysql";
  journalVersion: string;
  count: number;
  latestTag: string;
  migrations: Array<{
    idx: number;
    tag: string;
    when: number;
    sqlSha256: string;
    classification: MigrationClassification;
  }>;
  journalHash: string;
  schemaSnapshot: string;
  schemaTableCount: number;
  schemaContract: DatabaseSchemaContract;
  schemaHash: string;
};

export function createMigrationManifest(options?: {
  migrationsFolder?: string;
}): Promise<GeneratedMigrationManifest>;

export function parseMigrationManifest(
  value: unknown,
): GeneratedMigrationManifest;

export function readMigrationManifest(
  manifestPath: string,
): Promise<GeneratedMigrationManifest>;

export function migrationJournalHash(value: unknown): string;
