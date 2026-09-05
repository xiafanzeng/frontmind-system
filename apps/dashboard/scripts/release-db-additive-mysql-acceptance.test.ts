import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";

import { createMigrationManifest } from "./migration-manifest.mjs";
import { runReleaseDb } from "./release-db";

const URL_ENV = "FRONTMIND_RELEASE_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_RELEASE_MYSQL_ACCEPTANCE_REQUIRED";
const CLIENT_MODE_ENV = "FRONTMIND_RELEASE_MYSQL_CLIENT_MODE";
const MYSQL_CLIENT_IMAGE =
  "public.ecr.aws/docker/library/mysql:8.4.10@sha256:8dbcf531a03aade657e181b9cf2f1d1803ce621a1d55610cb44cb531ab7d7db6";
const acceptanceUrl = process.env[URL_ENV]?.trim();

if (process.env[REQUIRED_ENV] === "1" && !acceptanceUrl) {
  throw new Error(`${URL_ENV}_REQUIRED_FOR_RELEASE_GATE`);
}

const mysqlDescribe = acceptanceUrl ? describe.sequential : describe.skip;
const repositoryMigrations = path.resolve("drizzle");
const probeTable = "frontmind_release_acceptance_probe";

type MysqlTarget = {
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
};

function parseDisposableTarget(rawUrl: string): MysqlTarget {
  const parsed = new URL(rawUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (
    parsed.protocol !== "mysql:" ||
    !parsed.hostname ||
    !parsed.username ||
    !/^[A-Za-z0-9_$-]*acceptance[A-Za-z0-9_$-]*$/iu.test(database)
  ) {
    throw new Error(`${URL_ENV}_MUST_TARGET_DISPOSABLE_ACCEPTANCE_DB`);
  }
  return {
    host: parsed.hostname,
    port: parsed.port || "3306",
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

function databaseUrl(rawUrl: string, database: string) {
  if (!/^[A-Za-z0-9_$-]+$/u.test(database)) {
    throw new Error("RELEASE_ACCEPTANCE_DATABASE_NAME_INVALID");
  }
  const parsed = new URL(rawUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function mysqlClientCommand(
  target: MysqlTarget,
  command: "mysql" | "mysqldump",
  database: string,
) {
  const clientArguments = [
    `--host=${target.host}`,
    `--port=${target.port}`,
    `--user=${target.username}`,
    "--protocol=tcp",
  ];
  if (command === "mysqldump") {
    clientArguments.push(
      "--single-transaction",
      "--quick",
      "--hex-blob",
      "--routines",
      "--triggers",
      "--events",
      "--no-tablespaces",
    );
    if (process.env[CLIENT_MODE_ENV] === "docker") {
      clientArguments.push("--set-gtid-purged=OFF");
    }
  }
  clientArguments.push(database);

  if (process.env[CLIENT_MODE_ENV] === "docker") {
    return {
      executable: "docker",
      arguments: [
        "run",
        "--rm",
        ...(command === "mysql" ? ["--interactive"] : []),
        "--network",
        "host",
        "-e",
        "MYSQL_PWD",
        MYSQL_CLIENT_IMAGE,
        command,
        ...clientArguments,
      ],
    };
  }
  return { executable: command, arguments: clientArguments };
}

function runMysqlClient(
  target: MysqlTarget,
  command: "mysql" | "mysqldump",
  database: string,
  input?: Buffer,
) {
  const invocation = mysqlClientCommand(target, command, database);
  const result = spawnSync(invocation.executable, invocation.arguments, {
    env: { ...process.env, MYSQL_PWD: target.password },
    input,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `RELEASE_ACCEPTANCE_${command.toUpperCase()}_FAILED:${String(
        result.stderr || "",
      ).trim()}`,
    );
  }
  return Buffer.from(result.stdout || "");
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeManifest(migrationsFolder: string, manifestPath: string) {
  const manifest = await createMigrationManifest({ migrationsFolder });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function appendExpandMigration(migrationsFolder: string) {
  const journalPath = path.join(migrationsFolder, "meta/_journal.json");
  const policyPath = path.join(migrationsFolder, "migration-policy.json");
  const [journal, policy] = await Promise.all([
    readFile(journalPath, "utf8").then(JSON.parse),
    readFile(policyPath, "utf8").then(JSON.parse),
  ]);
  const previousEntry = journal.entries.at(-1);
  if (
    !Number.isSafeInteger(previousEntry?.idx) ||
    !Number.isSafeInteger(previousEntry?.when) ||
    previousEntry.idx < 0
  ) {
    throw new Error("RELEASE_ACCEPTANCE_BASELINE_CHANGED");
  }
  const previousSnapshot = JSON.parse(
    await readFile(
      path.join(
        migrationsFolder,
        `meta/${String(previousEntry.idx).padStart(4, "0")}_snapshot.json`,
      ),
      "utf8",
    ),
  );
  const probeIndex = previousEntry.idx + 1;
  const probeTag = `${String(probeIndex).padStart(4, "0")}_release_acceptance_expand`;
  const when = Number(previousEntry.when) + 1;
  journal.entries.push({
    idx: probeIndex,
    version: journal.version,
    when,
    tag: probeTag,
    breakpoints: true,
  });
  policy.migrations[probeTag] = "expand";

  const nextSnapshot = structuredClone(previousSnapshot);
  nextSnapshot.prevId = previousSnapshot.id;
  nextSnapshot.id = randomUUID();
  nextSnapshot.tables[probeTable] = {
    name: probeTable,
    columns: {
      id: {
        name: "id",
        type: "bigint unsigned",
        primaryKey: false,
        notNull: true,
        autoincrement: true,
      },
      releaseMarker: {
        name: "releaseMarker",
        type: "varchar(64)",
        primaryKey: false,
        notNull: false,
        autoincrement: false,
      },
    },
    indexes: {},
    foreignKeys: {},
    compositePrimaryKeys: {
      [`${probeTable}_id`]: {
        name: `${probeTable}_id`,
        columns: ["id"],
      },
    },
    uniqueConstraints: {},
    checkConstraint: {},
  };

  await Promise.all([
    writeFile(
      path.join(migrationsFolder, `${probeTag}.sql`),
      `CREATE TABLE \`${probeTable}\` (\n` +
        "  `id` bigint unsigned AUTO_INCREMENT NOT NULL,\n" +
        "  `releaseMarker` varchar(64),\n" +
        `  CONSTRAINT \`${probeTable}_id\` PRIMARY KEY(\`id\`)\n` +
        ") ENGINE=InnoDB;\n",
    ),
    writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`),
    writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`),
    writeFile(
      path.join(
        migrationsFolder,
        `meta/${String(probeIndex).padStart(4, "0")}_snapshot.json`,
      ),
      `${JSON.stringify(nextSnapshot, null, 2)}\n`,
    ),
  ]);
  return { probeIndex, probeTag };
}

function configureReleaseDb(input: {
  databaseUrl: string;
  migrationsFolder: string;
  manifestPath: string;
}) {
  process.env.FRONTMIND_RELEASE_DB_URL = input.databaseUrl;
  process.env.FRONTMIND_MIGRATIONS_DIR = input.migrationsFolder;
  process.env.FRONTMIND_MIGRATION_MANIFEST_PATH = input.manifestPath;
}

describe("temporary additive release fixture", () => {
  it("keeps stdin attached when Docker restores a backup", () => {
    const previousClientMode = process.env[CLIENT_MODE_ENV];
    process.env[CLIENT_MODE_ENV] = "docker";
    try {
      const target: MysqlTarget = {
        host: "127.0.0.1",
        port: "3306",
        username: "acceptance",
        password: "unused",
        database: "frontmind_acceptance",
      };
      expect(
        mysqlClientCommand(target, "mysql", target.database).arguments,
      ).toContain("--interactive");
      expect(
        mysqlClientCommand(target, "mysql", target.database).arguments,
      ).toContain(MYSQL_CLIENT_IMAGE);
      expect(
        mysqlClientCommand(target, "mysqldump", target.database).arguments,
      ).not.toContain("--interactive");
    } finally {
      if (previousClientMode === undefined) delete process.env[CLIENT_MODE_ENV];
      else process.env[CLIENT_MODE_ENV] = previousClientMode;
    }
  });

  it("appends one classified expand migration and a matching schema contract", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-release-fixture-"),
    );
    try {
      const candidateRoot = path.join(temporaryRoot, "candidate");
      await cp(repositoryMigrations, candidateRoot, { recursive: true });
      const currentManifest = await createMigrationManifest({
        migrationsFolder: repositoryMigrations,
      });
      const fixture = await appendExpandMigration(candidateRoot);
      const candidateManifest = await createMigrationManifest({
        migrationsFolder: candidateRoot,
      });

      expect(candidateManifest.count).toBe(currentManifest.count + 1);
      expect(candidateManifest.latestTag).toBe(fixture.probeTag);
      expect(candidateManifest.migrations.at(-1)).toMatchObject({
        idx: fixture.probeIndex,
        tag: fixture.probeTag,
        classification: "expand",
      });
      expect(
        candidateManifest.schemaContract.tables.find(
          (table) => table.name === probeTable,
        ),
      ).toMatchObject({
        primaryKey: ["id"],
        columns: expect.arrayContaining([
          expect.objectContaining({
            name: "id",
            type: "bigint unsigned",
            autoIncrement: true,
          }),
          expect.objectContaining({
            name: "releaseMarker",
            type: "varchar(64)",
            nullable: true,
          }),
        ]),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

mysqlDescribe("additive release path on real MySQL 8.4.10", () => {
  it("backs up and verifies the strict prefix, migrates once, and restores after candidate failure", async () => {
    const target = parseDisposableTarget(acceptanceUrl!);
    const restoreDatabase = `${target.database.slice(0, 42)}_restore_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 8)}`;
    const sourceUrl = databaseUrl(acceptanceUrl!, target.database);
    const restoreUrl = databaseUrl(acceptanceUrl!, restoreDatabase);
    const adminUrl = databaseUrl(acceptanceUrl!, "mysql");
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-release-mysql-"),
    );
    const currentRoot = path.join(temporaryRoot, "current");
    const candidateRoot = path.join(temporaryRoot, "candidate");
    const currentManifestPath = path.join(
      temporaryRoot,
      "current-manifest.json",
    );
    const candidateManifestPath = path.join(
      temporaryRoot,
      "candidate-manifest.json",
    );
    const backupPath = path.join(temporaryRoot, "baseline.sql");
    const checksumPath = `${backupPath}.sha256`;
    const savedEnvironment = {
      FRONTMIND_RELEASE_DB_URL: process.env.FRONTMIND_RELEASE_DB_URL,
      FRONTMIND_MIGRATIONS_DIR: process.env.FRONTMIND_MIGRATIONS_DIR,
      FRONTMIND_MIGRATION_MANIFEST_PATH:
        process.env.FRONTMIND_MIGRATION_MANIFEST_PATH,
    };
    const admin = await mysql.createConnection(adminUrl);

    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${restoreDatabase}\``);
      const source = await mysql.createPool({
        uri: sourceUrl,
        connectionLimit: 4,
      });
      try {
        const [tables] = await source.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE()",
        );
        if (Number(tables[0]?.tableCount || 0) !== 0) {
          throw new Error(`${URL_ENV}_DATABASE_MUST_BE_EMPTY`);
        }
        await migrate(drizzle(source), {
          migrationsFolder: repositoryMigrations,
        });
      } finally {
        await source.end();
      }

      await cp(repositoryMigrations, currentRoot, { recursive: true });
      const currentManifest = await writeManifest(
        currentRoot,
        currentManifestPath,
      );
      configureReleaseDb({
        databaseUrl: sourceUrl,
        migrationsFolder: currentRoot,
        manifestPath: currentManifestPath,
      });
      await expect(
        runReleaseDb(["postflight", "--json"]),
      ).resolves.toMatchObject({
        status: "exact",
        schema: { status: "exact" },
      });
      await expect(runReleaseDb(["plan", "--json"])).resolves.toMatchObject({
        status: "exact",
        schema: { status: "exact" },
      });

      const backup = runMysqlClient(target, "mysqldump", target.database);
      const backupHash = sha256(backup);
      expect(backup.length).toBeGreaterThan(1_024);
      expect(backupHash).toMatch(/^[a-f0-9]{64}$/u);
      await Promise.all([
        writeFile(backupPath, backup),
        writeFile(
          checksumPath,
          `${backupHash}  ${path.basename(backupPath)}\n`,
        ),
      ]);

      await admin.query(
        `CREATE DATABASE \`${restoreDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      runMysqlClient(target, "mysql", restoreDatabase, backup);
      configureReleaseDb({
        databaseUrl: restoreUrl,
        migrationsFolder: currentRoot,
        manifestPath: currentManifestPath,
      });
      await expect(
        runReleaseDb(["postflight", "--json"]),
      ).resolves.toMatchObject({
        status: "exact",
        applied: { count: currentManifest.count },
        schema: { status: "exact" },
      });
      await admin.query(`DROP DATABASE \`${restoreDatabase}\``);

      await cp(currentRoot, candidateRoot, { recursive: true });
      const fixture = await appendExpandMigration(candidateRoot);
      const candidateManifest = await writeManifest(
        candidateRoot,
        candidateManifestPath,
      );
      expect(candidateManifest.count).toBe(currentManifest.count + 1);
      expect(candidateManifest.latestTag).toBe(fixture.probeTag);

      configureReleaseDb({
        databaseUrl: sourceUrl,
        migrationsFolder: candidateRoot,
        manifestPath: candidateManifestPath,
      });
      const plan = await runReleaseDb(["plan", "--json"]);
      expect(plan).toMatchObject({
        status: "pending",
        applied: { count: currentManifest.count },
        expected: { count: candidateManifest.count },
        allPendingExpand: true,
        pending: [
          {
            idx: fixture.probeIndex,
            tag: fixture.probeTag,
            classification: "expand",
          },
        ],
      });

      await expect(
        runReleaseDb([
          "migrate",
          "--release-id",
          "mysql-acceptance-stale-fact",
          "--expected-applied-count",
          String(plan.applied.count + 1),
          "--expected-applied-journal-hash",
          plan.applied.journalHash,
          "--json",
        ]),
      ).rejects.toThrow("MIGRATION_APPLIED_FACT_CHANGED");
      await expect(runReleaseDb(["plan", "--json"])).resolves.toMatchObject({
        status: "pending",
        applied: plan.applied,
      });
      const beforeMigration = await mysql.createConnection(sourceUrl);
      const [preconditionProbeRows] = await beforeMigration.query<
        RowDataPacket[]
      >(
        "SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [probeTable],
      );
      await beforeMigration.end();
      expect(Number(preconditionProbeRows[0]?.tableCount || 0)).toBe(0);

      const firstMigration = await runReleaseDb([
        "migrate",
        "--release-id",
        "mysql-acceptance-first",
        "--expected-applied-count",
        String(plan.applied.count),
        "--expected-applied-journal-hash",
        plan.applied.journalHash,
        "--json",
      ]);
      expect(firstMigration).toMatchObject({
        status: "exact",
        migrated: true,
        schema: { status: "exact" },
      });
      const firstPostflight = await runReleaseDb(["postflight", "--json"]);
      expect(firstPostflight).toMatchObject({
        status: "exact",
        applied: { count: candidateManifest.count },
        schema: { status: "exact" },
      });

      const secondMigration = await runReleaseDb([
        "migrate",
        "--release-id",
        "mysql-acceptance-second",
        "--expected-applied-count",
        String(firstPostflight.applied.count),
        "--expected-applied-journal-hash",
        firstPostflight.applied.journalHash,
        "--json",
      ]);
      expect(secondMigration).toMatchObject({
        status: "exact",
        migrated: false,
      });
      const migratedDatabase = await mysql.createConnection(sourceUrl);
      const [migratedLedger] = await migratedDatabase.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
      );
      const [probeRows] = await migratedDatabase.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [probeTable],
      );
      await migratedDatabase.end();
      expect(Number(migratedLedger[0]?.migrationCount || 0)).toBe(
        candidateManifest.count,
      );
      expect(Number(probeRows[0]?.tableCount || 0)).toBe(1);

      const storedBackup = await readFile(backupPath);
      expect(sha256(storedBackup)).toBe(backupHash);
      expect(await readFile(checksumPath, "utf8")).toBe(
        `${backupHash}  ${path.basename(backupPath)}\n`,
      );
      await admin.query(`DROP DATABASE \`${target.database}\``);
      await admin.query(
        `CREATE DATABASE \`${target.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      runMysqlClient(target, "mysql", target.database, storedBackup);

      configureReleaseDb({
        databaseUrl: sourceUrl,
        migrationsFolder: currentRoot,
        manifestPath: currentManifestPath,
      });
      await expect(
        runReleaseDb(["postflight", "--json"]),
      ).resolves.toMatchObject({
        status: "exact",
        applied: { count: currentManifest.count },
        schema: { status: "exact" },
      });
      const restoredDatabase = await mysql.createConnection(sourceUrl);
      const [restoredLedger] = await restoredDatabase.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
      );
      const [restoredProbeRows] = await restoredDatabase.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        [probeTable],
      );
      await restoredDatabase.end();
      expect(Number(restoredLedger[0]?.migrationCount || 0)).toBe(
        currentManifest.count,
      );
      expect(Number(restoredProbeRows[0]?.tableCount || 0)).toBe(0);
    } finally {
      for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await admin.query(`DROP DATABASE IF EXISTS \`${restoreDatabase}\``);
      await admin.query(`DROP DATABASE IF EXISTS \`${target.database}\``);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 600_000);
});
