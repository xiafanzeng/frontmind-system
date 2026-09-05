import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const drizzleRoot = path.join(repositoryRoot, "drizzle");
const baselinePath = path.join(
  repositoryRoot,
  "config/migration-baseline-0048.json",
);
const policyPath = path.join(drizzleRoot, "migration-policy.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const migrationFile = (entry) => path.join(drizzleRoot, `${entry.tag}.sql`);
const snapshotFile = (entry) =>
  path.join(
    drizzleRoot,
    "meta",
    `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
  );

async function canonicalBaseline(entries) {
  const records = [];
  for (const entry of entries) {
    records.push({
      idx: entry.idx,
      version: entry.version,
      when: entry.when,
      tag: entry.tag,
      breakpoints: entry.breakpoints,
      sqlSha256: sha256(await readFile(migrationFile(entry))),
      snapshotSha256: sha256(await readFile(snapshotFile(entry))),
    });
  }
  return sha256(`${JSON.stringify(records)}\n`);
}

function assertJournalShape(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("MIGRATION_JOURNAL_EMPTY");
  }
  const tags = new Set();
  entries.forEach((entry, index) => {
    if (
      entry?.idx !== index ||
      entry.version !== "5" ||
      !Number.isSafeInteger(entry.when) ||
      !new RegExp(
        `^${String(index).padStart(4, "0")}[A-Za-z0-9_-]*$`,
        "u",
      ).test(entry.tag) ||
      entry.breakpoints !== true
    ) {
      throw new Error(`MIGRATION_JOURNAL_ENTRY_INVALID:${index}`);
    }
    if (tags.has(entry.tag))
      throw new Error(`MIGRATION_TAG_DUPLICATE:${entry.tag}`);
    tags.add(entry.tag);
    if (index > 0 && entry.when <= entries[index - 1].when) {
      throw new Error(`MIGRATION_WHEN_NOT_INCREASING:${entry.tag}`);
    }
  });
}

function parseSqlBlock(block, onInvalid) {
  const parsed = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < block.length; index += 1) {
    const character = block[index];
    const next = block[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        current += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        current += " ";
        index += 1;
      }
      continue;
    }
    if (quote) {
      current += character;
      if (character === "\\" && next) {
        current += next;
        index += 1;
      } else if (character === quote && next === quote) {
        current += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "#") {
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";") {
      if (current.trim()) parsed.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quote || blockComment) onInvalid();
  if (current.trim()) parsed.push(current.trim());
  return parsed;
}

export function assertExpandSql(tag, sql) {
  const reject = () => {
    throw new Error(`EXPAND_MIGRATION_HAS_CONTRACT_SQL:${tag}`);
  };
  const statements = [];
  for (const block of sql.split(/-->\s*statement-breakpoint/iu)) {
    const blockStatements = parseSqlBlock(block, reject);
    // Drizzle breakpoints are the execution boundary. Requiring exactly one
    // statement per non-empty block prevents an allowed CREATE/ADD prefix from
    // hiding a second contract statement after a semicolon.
    if (blockStatements.length > 1) reject();
    statements.push(...blockStatements);
  }
  const compatibleLiteralDefault =
    /\bDEFAULT\s+(?:NULL|TRUE|FALSE|[-+]?\d+(?:\.\d+)?|'(?:''|[^'])*'|"(?:""|[^"])*")(?=\s*(?:COMMENT\b|,|;|$))/iu;
  const identifier = "(?:`([^`]+)`|([A-Za-z0-9_$]+))";
  const nullableAdditions = new Map();
  statements.forEach((statement, statementIndex) => {
    const match = statement.match(
      new RegExp(
        `^ALTER\\s+TABLE\\s+${identifier}\\s+ADD\\s+(?:COLUMN\\s+)?${identifier}\\s+([\\s\\S]+)$`,
        "iu",
      ),
    );
    if (!match) return;
    const definition = match[5];
    if (
      /\b(?:NOT\s+NULL|UNIQUE|PRIMARY\s+KEY|REFERENCES|GENERATED\s+ALWAYS|AUTO_INCREMENT)\b/iu.test(
        definition,
      ) ||
      /\bCHECK\s*\(/iu.test(definition)
    ) {
      return;
    }
    nullableAdditions.set(
      `${String(match[1] || match[2]).toLowerCase()}\0${String(match[3] || match[4]).toLowerCase()}`,
      statementIndex,
    );
  });
  for (const [statementIndex, statement] of statements.entries()) {
    if (
      /^(?:INSERT|REPLACE|UPDATE|DELETE|LOAD\s+DATA|CALL|TRUNCATE|DROP|RENAME|GRANT|REVOKE)\b/iu.test(
        statement,
      )
    ) {
      reject();
    }
    if (/^CREATE\s+TABLE\b/iu.test(statement)) {
      if (
        !/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`|[A-Za-z0-9_$]+)\s*\(/iu.test(
          statement,
        )
      ) {
        reject();
      }
      if (/\)\s*(?:AS\s+)?SELECT\b/iu.test(statement)) reject();
      continue;
    }
    if (/^CREATE\s+UNIQUE\s+INDEX\b/iu.test(statement)) {
      const match = statement.match(
        new RegExp(
          `^CREATE\\s+UNIQUE\\s+INDEX\\s+${identifier}\\s+ON\\s+${identifier}\\s*\\(\\s*${identifier}\\s*\\)$`,
          "iu",
        ),
      );
      const table = match && String(match[3] || match[4]).toLowerCase();
      const column = match && String(match[5] || match[6]).toLowerCase();
      const addedAt =
        table && column ? nullableAdditions.get(`${table}\0${column}`) : null;
      // A single-column UNIQUE index is expand-safe only when this same
      // migration already introduced that column as nullable. Historical rows
      // are therefore all NULL (which MySQL permits repeatedly), while a new
      // writer can rely on the uniqueness fence as soon as it is enabled.
      if (!match || !Number.isInteger(addedAt) || addedAt >= statementIndex) {
        reject();
      }
      continue;
    }
    if (/^CREATE\s+INDEX\b/iu.test(statement)) {
      if (
        !/^CREATE\s+INDEX\s+(?:`[^`]+`|[A-Za-z0-9_$]+)\s+ON\s+/iu.test(
          statement,
        )
      ) {
        reject();
      }
      continue;
    }
    if (!/^ALTER\s+TABLE\b/iu.test(statement)) reject();
    if (
      /\b(?:MODIFY|CHANGE|DROP|RENAME|ALGORITHM|CONVERT)\b/iu.test(statement)
    ) {
      reject();
    }
    if (
      /\bADD\s+(?:CONSTRAINT|UNIQUE|FOREIGN\s+KEY|PRIMARY\s+KEY|CHECK)\b/iu.test(
        statement,
      )
    ) {
      reject();
    }
    if (/\bADD\s+(?:FULLTEXT|SPATIAL)\s+(?:INDEX|KEY)\b/iu.test(statement)) {
      reject();
    }
    const addCount = statement.match(/\bADD\s+(?:COLUMN\s+)?/giu)?.length || 0;
    if (addCount !== 1) reject();
    if (/\bADD\s+(?:(?:INDEX|KEY)\b)/iu.test(statement)) {
      continue;
    }
    if (
      !/\bADD\s+(?:COLUMN\s+)?(?:`[^`]+`|[A-Za-z0-9_$]+)\s+/iu.test(statement)
    ) {
      reject();
    }
    if (/\b(?:REFERENCES|GENERATED\s+ALWAYS|AS\s*\()\b/iu.test(statement)) {
      reject();
    }
    if (
      /\b(?:UNIQUE|PRIMARY\s+KEY|AUTO_INCREMENT|ON\s+UPDATE)\b/iu.test(
        statement,
      ) ||
      /\bCHECK\s*\(/iu.test(statement)
    ) {
      reject();
    }
    if (
      /\bDEFAULT\b/iu.test(statement) &&
      !compatibleLiteralDefault.test(statement)
    ) {
      reject();
    }
    if (
      /\bNOT\s+NULL\b/iu.test(statement) &&
      !compatibleLiteralDefault.test(statement)
    ) {
      reject();
    }
  }
}

export function assertNoEmptyMigrationBlocks(tag, sql) {
  const blocks = sql.split(/-->\s*statement-breakpoint/iu);
  for (const block of blocks) {
    const rejectInvalidSql = () => {
      throw new Error(`MIGRATION_STATEMENT_BLOCK_INVALID:${tag}`);
    };
    const statements = parseSqlBlock(block, rejectInvalidSql);
    if (statements.length === 0) {
      throw new Error(`MIGRATION_EMPTY_STATEMENT_BLOCK:${tag}`);
    }
    if (statements.length > 1) {
      throw new Error(`MIGRATION_MULTIPLE_STATEMENTS_BLOCK:${tag}`);
    }
  }
}

const journal = await readJson(path.join(drizzleRoot, "meta/_journal.json"));
assertJournalShape(journal.entries);

if (process.argv.includes("--print-baseline")) {
  const through = Number(process.env.FRONTMIND_BASELINE_IDX || "48");
  const entries = journal.entries.slice(0, through + 1);
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        throughIdx: through,
        throughTag: entries.at(-1)?.tag,
        entryCount: entries.length,
        canonicalSha256: await canonicalBaseline(entries),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const [baseline, policy] = await Promise.all([
  readJson(baselinePath),
  readJson(policyPath),
]);
if (
  baseline.schemaVersion !== 1 ||
  baseline.throughIdx !== 48 ||
  baseline.throughTag !== "0048_api_usage_coverage_claims" ||
  baseline.entryCount !== 49 ||
  !/^[a-f0-9]{64}$/u.test(baseline.canonicalSha256)
) {
  throw new Error("MIGRATION_BASELINE_CONFIG_INVALID");
}
const baselineEntries = journal.entries.slice(0, baseline.entryCount);
if (
  baselineEntries.length !== baseline.entryCount ||
  baselineEntries.at(-1)?.tag !== baseline.throughTag
) {
  throw new Error("MIGRATION_BASELINE_REMOVED_OR_REORDERED");
}
const actualBaselineSha = await canonicalBaseline(baselineEntries);
if (actualBaselineSha !== baseline.canonicalSha256) {
  throw new Error("MIGRATION_BASELINE_0000_0048_MUTATED");
}

if (
  policy?.schemaVersion !== 1 ||
  policy.historicalBaselineThrough !== baseline.throughTag ||
  !policy.migrations ||
  Array.isArray(policy.migrations) ||
  typeof policy.migrations !== "object"
) {
  throw new Error("MIGRATION_POLICY_INVALID");
}

const futureEntries = journal.entries.slice(baseline.entryCount);
const futureTags = new Set(futureEntries.map((entry) => entry.tag));
for (const configuredTag of Object.keys(policy.migrations)) {
  if (!futureTags.has(configuredTag)) {
    throw new Error(`MIGRATION_POLICY_ORPHAN:${configuredTag}`);
  }
}
for (const entry of futureEntries) {
  const classification = policy.migrations[entry.tag];
  if (classification !== "expand" && classification !== "contract") {
    throw new Error(`MIGRATION_CLASSIFICATION_REQUIRED:${entry.tag}`);
  }
  const sql = await readFile(migrationFile(entry), "utf8");
  await readFile(snapshotFile(entry));
  assertNoEmptyMigrationBlocks(entry.tag, sql);
  if (classification === "expand") assertExpandSql(entry.tag, sql);
}

console.log(
  `MIGRATION_APPEND_ONLY_OK baseline=${baseline.throughTag} future=${futureEntries.length}`,
);
