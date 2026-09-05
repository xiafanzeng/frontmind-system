import path from "node:path";
import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";
import {
  assertExactPostflight,
  bootstrapEmptyRelease,
  createReleaseDbPlan,
  migratePendingRelease,
  RELEASE_DB_SCHEMA_VERSION,
} from "./release-db-core.js";
import {
  defaultMigrationsDirectory,
  journalHash,
  loadReleaseManifest,
} from "./release-manifest.js";

const RELEASE_ID_PATTERN = /^release-[a-f0-9]{40}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type ParsedCommand =
  | { name: "plan" }
  | { name: "postflight" }
  | {
      name: "bootstrap-empty";
      releaseId: string;
    }
  | {
      name: "migrate";
      releaseId: string;
      expectedAppliedCount: number;
      expectedAppliedJournalHash: string;
    };

export async function runReleaseDbCli(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let commandName = argv[0] ?? "unknown";
  try {
    const command = parseCommand(argv);
    commandName = command.name;
    const databaseUrl = environment.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const manifest = await loadReleaseManifest(
      environment.RELEASE_DB_MIGRATIONS_DIRECTORY ||
        defaultMigrationsDirectory(),
    );
    const connection = await mysql.createConnection({
      uri: databaseUrl,
      connectTimeout: 15_000,
      charset: "utf8mb4",
    });
    try {
      if (command.name === "plan") {
        writeJson(await createReleaseDbPlan(connection, manifest));
        return 0;
      }
      if (command.name === "postflight") {
        const plan = await createReleaseDbPlan(connection, manifest);
        assertExactPostflight(plan);
        writeJson(plan);
        return 0;
      }
      if (command.name === "bootstrap-empty") {
        writeJson(
          await bootstrapEmptyRelease({
            connection,
            manifest,
            releaseId: command.releaseId,
          }),
        );
        return 0;
      }
      writeJson(
        await migratePendingRelease({
          connection,
          manifest,
          releaseId: command.releaseId,
          expectedAppliedCount: command.expectedAppliedCount,
          expectedAppliedJournalHash: command.expectedAppliedJournalHash,
        }),
      );
      return 0;
    } finally {
      await connection.end();
    }
  } catch (error) {
    writeJson({
      schemaVersion: RELEASE_DB_SCHEMA_VERSION,
      command: commandName,
      status: "unknown",
      schema: { status: "not_checked" },
      appliedCount: null,
      appliedJournalHash: journalHash([]),
      expectedJournalHash: null,
      pendingMigrations: [],
      allPendingExpand: false,
      mismatchIndex: null,
      error: safeError(error),
    });
    return 2;
  }
}

function parseCommand(argv: string[]): ParsedCommand {
  const [name, ...argumentsList] = argv;
  if (
    !name ||
    !["plan", "migrate", "postflight", "bootstrap-empty"].includes(name)
  ) {
    throw new Error(
      "Usage: release-db <plan|migrate|postflight|bootstrap-empty> [options] --json",
    );
  }
  const options = new Map<string, string | true>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument?.startsWith("--"))
      throw new Error(`Unexpected argument ${argument ?? ""}`);
    if (options.has(argument)) throw new Error(`Duplicate option ${argument}`);
    if (argument === "--json") {
      options.set(argument, true);
      continue;
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${argument}`);
    options.set(argument, value);
    index += 1;
  }
  if (options.get("--json") !== true) throw new Error("--json is required");

  if (name === "plan") {
    assertOnlyOptions(options, ["--json"]);
    return { name: "plan" };
  }
  if (name === "postflight") {
    assertOnlyOptions(options, ["--json"]);
    return { name: "postflight" };
  }
  const releaseId = requiredString(options, "--release-id");
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(
      "--release-id must bind a 40-hex source SHA and 12-hex digest prefix",
    );
  }
  if (name === "bootstrap-empty") {
    assertOnlyOptions(options, ["--json", "--release-id"]);
    return { name, releaseId };
  }

  assertOnlyOptions(options, [
    "--json",
    "--release-id",
    "--expected-applied-count",
    "--expected-applied-journal-hash",
  ]);
  const countText = requiredString(options, "--expected-applied-count");
  if (!/^(?:0|[1-9][0-9]*)$/.test(countText)) {
    throw new Error("--expected-applied-count must be a non-negative integer");
  }
  const expectedAppliedCount = Number(countText);
  if (!Number.isSafeInteger(expectedAppliedCount)) {
    throw new Error("--expected-applied-count is too large");
  }
  const expectedAppliedJournalHash = requiredString(
    options,
    "--expected-applied-journal-hash",
  );
  if (!SHA256_PATTERN.test(expectedAppliedJournalHash)) {
    throw new Error(
      "--expected-applied-journal-hash must be lowercase SHA-256",
    );
  }
  return {
    name: "migrate",
    releaseId,
    expectedAppliedCount,
    expectedAppliedJournalHash,
  };
}

function assertOnlyOptions(
  options: Map<string, string | true>,
  allowed: string[],
): void {
  for (const option of options.keys()) {
    if (!allowed.includes(option))
      throw new Error(`Unsupported option ${option}`);
  }
}

function requiredString(
  options: Map<string, string | true>,
  name: string,
): string {
  const value = options.get(name);
  if (typeof value !== "string") throw new Error(`${name} is required`);
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:mysql|mariadb):\/\/[^\s]+/gi, "[database-url-redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  process.exitCode = await runReleaseDbCli(process.argv.slice(2));
}
