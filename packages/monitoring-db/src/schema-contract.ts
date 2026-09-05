import { readFile } from "node:fs/promises";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { sha256, type ReleaseManifest } from "./release-manifest.js";

type SnapshotColumn = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  autoincrement: boolean;
  default?: unknown;
  onUpdate?: boolean;
};

type SnapshotIndex = {
  name: string;
  columns: string[];
  isUnique: boolean;
};

type SnapshotForeignKey = {
  name: string;
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
  onUpdate?: string;
};

type SnapshotPrimaryKey = { name: string; columns: string[] };

type SnapshotTable = {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, SnapshotForeignKey>;
  compositePrimaryKeys: Record<string, SnapshotPrimaryKey>;
  uniqueConstraints?: Record<string, SnapshotIndex>;
  checkConstraint?: Record<string, unknown>;
};

type SnapshotDocument = {
  version: string;
  dialect: string;
  tables: Record<string, SnapshotTable>;
  views: Record<string, unknown>;
};

export type CanonicalColumn = {
  table: string;
  name: string;
  ordinal: number;
  type: string;
  nullable: boolean;
  default: string | null;
  extra: string;
};

export type CanonicalIndex = {
  table: string;
  primary: boolean;
  unique: boolean;
  columns: string[];
};

export type CanonicalForeignKey = {
  table: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
};

export type CanonicalSchema = {
  tables: string[];
  columns: CanonicalColumn[];
  indexes: CanonicalIndex[];
  foreignKeys: CanonicalForeignKey[];
};

export type SchemaMismatch = {
  section: keyof CanonicalSchema;
  index: number;
  expected: unknown;
  actual: unknown;
};

export type SchemaInspection =
  | { status: "empty"; contractHash: string; mismatch: null }
  | { status: "exact"; contractHash: string; mismatch: null }
  | {
      status: "drifted";
      contractHash: string;
      mismatch: SchemaMismatch;
    };

type TableRow = RowDataPacket & { tableName: string };
type ColumnRow = RowDataPacket & {
  tableName: string;
  columnName: string;
  columnType: string;
  nullable: "YES" | "NO";
  columnDefault: string | number | null;
  extra: string;
  ordinal: number;
};
type IndexRow = RowDataPacket & {
  tableName: string;
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string | null;
  subPart: number | null;
};
type ForeignKeyRow = RowDataPacket & {
  tableName: string;
  constraintName: string;
  sequence: number;
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
  updateRule: string;
  deleteRule: string;
};

export async function loadExpectedSchema(
  manifest: ReleaseManifest,
  migrationIndex = manifest.migrations.length - 1,
): Promise<CanonicalSchema> {
  const latest = manifest.migrations[migrationIndex];
  if (!latest || migrationIndex < 0) {
    throw new Error(
      `Cannot build a schema contract at migration index ${migrationIndex}`,
    );
  }
  const snapshot = JSON.parse(
    await readFile(latest.snapshotPath, "utf8"),
  ) as SnapshotDocument;
  if (
    snapshot.version !== "5" ||
    snapshot.dialect !== "mysql" ||
    !snapshot.tables ||
    typeof snapshot.tables !== "object" ||
    Object.keys(snapshot.views ?? {}).length !== 0
  ) {
    throw new Error("Unsupported Drizzle MySQL snapshot contract");
  }
  return canonicalizeSnapshot(snapshot);
}

export function canonicalizeSnapshot(
  snapshot: SnapshotDocument,
): CanonicalSchema {
  const tables = Object.keys(snapshot.tables).sort();
  const columns: CanonicalColumn[] = [];
  const indexes: CanonicalIndex[] = [];
  const foreignKeys: CanonicalForeignKey[] = [];

  for (const tableName of tables) {
    const table = snapshot.tables[tableName];
    if (!table || table.name !== tableName) {
      throw new Error(`Invalid snapshot table ${tableName}`);
    }
    const snapshotColumns = Object.values(table.columns);
    snapshotColumns.forEach((column, ordinalIndex) => {
      columns.push({
        table: tableName,
        name: column.name,
        ordinal: ordinalIndex + 1,
        type: normalizeExpectedType(column.type),
        nullable: !column.notNull,
        default: normalizeExpectedDefault(column.default, column.type),
        extra: normalizeExpectedExtra(column),
      });
    });

    for (const primaryKey of Object.values(table.compositePrimaryKeys ?? {})) {
      indexes.push({
        table: tableName,
        primary: true,
        unique: true,
        columns: [...primaryKey.columns],
      });
    }
    for (const index of [
      ...Object.values(table.indexes ?? {}),
      ...Object.values(table.uniqueConstraints ?? {}),
    ]) {
      indexes.push({
        table: tableName,
        primary: false,
        unique: index.isUnique,
        columns: [...index.columns],
      });
    }
    const coveringIndexColumns = indexes
      .filter((index) => index.table === tableName)
      .map((index) => index.columns);
    for (const foreignKey of Object.values(table.foreignKeys ?? {})) {
      const columns = [...foreignKey.columnsFrom];
      foreignKeys.push({
        table: tableName,
        columns,
        referencedTable: foreignKey.tableTo,
        referencedColumns: [...foreignKey.columnsTo],
        onDelete: normalizeRule(foreignKey.onDelete ?? "no action"),
        onUpdate: normalizeRule(foreignKey.onUpdate ?? "no action"),
      });
      // InnoDB automatically creates a non-unique index when no existing
      // index begins with all referencing columns. Drizzle snapshots describe
      // the foreign key but omit that implicit index, while information_schema
      // reports it. Model the MySQL rule on the expected side so release
      // postflight compares the same physical schema without depending on the
      // generated constraint/index name.
      if (
        !coveringIndexColumns.some((indexColumns) =>
          isLeftmostPrefix(columns, indexColumns),
        )
      ) {
        indexes.push({
          table: tableName,
          primary: false,
          unique: false,
          columns,
        });
        coveringIndexColumns.push(columns);
      }
    }
    if (Object.keys(table.checkConstraint ?? {}).length > 0) {
      throw new Error(
        "Schema contracts with check constraints are not yet supported",
      );
    }
  }

  indexes.sort(compareCanonical);
  foreignKeys.sort(compareCanonical);
  return { tables, columns, indexes, foreignKeys };
}

export async function inspectSchema(
  connection: Connection,
  expected: CanonicalSchema,
): Promise<SchemaInspection> {
  const [tableRows] = await connection.execute<TableRow[]>(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
  );
  const businessTables = tableRows
    .map((row) => row.tableName)
    .filter((name) => name !== "__drizzle_migrations")
    .sort();
  const contractHash = sha256(JSON.stringify(expected));
  if (businessTables.length === 0) {
    return { status: "empty", contractHash, mismatch: null };
  }

  const actual = await readActualSchema(connection, businessTables);
  const mismatch = firstMismatch(expected, actual);
  if (mismatch) return { status: "drifted", contractHash, mismatch };
  return { status: "exact", contractHash, mismatch: null };
}

export function firstMismatch(
  expected: CanonicalSchema,
  actual: CanonicalSchema,
): SchemaMismatch | null {
  for (const section of [
    "tables",
    "columns",
    "indexes",
    "foreignKeys",
  ] as const) {
    const expectedValues = expected[section];
    const actualValues = actual[section];
    const length = Math.max(expectedValues.length, actualValues.length);
    for (let index = 0; index < length; index += 1) {
      const expectedValue = expectedValues[index];
      const actualValue = actualValues[index];
      if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
        return {
          section,
          index,
          expected: expectedValue ?? null,
          actual: actualValue ?? null,
        };
      }
    }
  }
  return null;
}

async function readActualSchema(
  connection: Connection,
  tables: string[],
): Promise<CanonicalSchema> {
  const [columnRows, indexRows, foreignKeyRows] = await Promise.all([
    connection.execute<ColumnRow[]>(
      `SELECT TABLE_NAME AS tableName,
              COLUMN_NAME AS columnName,
              COLUMN_TYPE AS columnType,
              IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS columnDefault,
              EXTRA AS extra,
              ORDINAL_POSITION AS ordinal
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME <> '__drizzle_migrations'
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    ),
    connection.execute<IndexRow[]>(
      `SELECT TABLE_NAME AS tableName,
              INDEX_NAME AS indexName,
              NON_UNIQUE AS nonUnique,
              SEQ_IN_INDEX AS sequence,
              COLUMN_NAME AS columnName,
              SUB_PART AS subPart
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME <> '__drizzle_migrations'
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    ),
    connection.execute<ForeignKeyRow[]>(
      `SELECT k.TABLE_NAME AS tableName,
              k.CONSTRAINT_NAME AS constraintName,
              k.ORDINAL_POSITION AS sequence,
              k.COLUMN_NAME AS columnName,
              k.REFERENCED_TABLE_NAME AS referencedTable,
              k.REFERENCED_COLUMN_NAME AS referencedColumn,
              r.UPDATE_RULE AS updateRule,
              r.DELETE_RULE AS deleteRule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.TABLE_NAME = k.TABLE_NAME
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE()
          AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    ),
  ]);

  const columns = columnRows[0].map((row) => ({
    table: row.tableName,
    name: row.columnName,
    ordinal: Number(row.ordinal),
    type: normalizeExpectedType(row.columnType),
    nullable: row.nullable === "YES",
    default: normalizeActualDefault(row.columnDefault),
    extra: normalizeActualExtra(row.extra),
  }));

  const indexGroups = new Map<string, IndexRow[]>();
  for (const row of indexRows[0]) {
    const key = `${row.tableName}\0${row.indexName}`;
    const group = indexGroups.get(key) ?? [];
    group.push(row);
    indexGroups.set(key, group);
  }
  const indexes = [...indexGroups.values()].map((rows) => {
    const first = rows[0];
    if (!first || rows.some((row) => !row.columnName || row.subPart !== null)) {
      throw new Error(
        "Functional or prefix indexes are not supported by this schema contract",
      );
    }
    return {
      table: first.tableName,
      primary: first.indexName === "PRIMARY",
      unique: Number(first.nonUnique) === 0,
      columns: rows
        .sort((left, right) => Number(left.sequence) - Number(right.sequence))
        .map((row) => row.columnName as string),
    } satisfies CanonicalIndex;
  });
  indexes.sort(compareCanonical);

  const foreignKeyGroups = new Map<string, ForeignKeyRow[]>();
  for (const row of foreignKeyRows[0]) {
    const key = `${row.tableName}\0${row.constraintName}`;
    const group = foreignKeyGroups.get(key) ?? [];
    group.push(row);
    foreignKeyGroups.set(key, group);
  }
  const foreignKeys = [...foreignKeyGroups.values()].map((rows) => {
    const ordered = rows.sort(
      (left, right) => Number(left.sequence) - Number(right.sequence),
    );
    const first = ordered[0];
    if (!first) throw new Error("Invalid empty foreign-key group");
    return {
      table: first.tableName,
      columns: ordered.map((row) => row.columnName),
      referencedTable: first.referencedTable,
      referencedColumns: ordered.map((row) => row.referencedColumn),
      onDelete: normalizeRule(first.deleteRule),
      onUpdate: normalizeRule(first.updateRule),
    } satisfies CanonicalForeignKey;
  });
  foreignKeys.sort(compareCanonical);

  return { tables, columns, indexes, foreignKeys };
}

function normalizeExpectedType(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "boolean" ? "tinyint(1)" : normalized;
}

function normalizeExpectedDefault(
  value: unknown,
  columnType: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") {
    throw new Error(`Unsupported snapshot default ${String(value)}`);
  }
  if (value === "(now())" || /^current_timestamp(?:\(\d+\))?$/i.test(value)) {
    const precision = /\((\d+)\)/.exec(columnType)?.[1];
    return `current_timestamp${precision ? `(${precision})` : ""}`;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function normalizeActualDefault(value: string | number | null): string | null {
  if (value === null) return null;
  const text = String(value);
  if (/^(?:current_timestamp|now)(?:\(\d+\))?$/i.test(text)) {
    return text.toLowerCase().replace(/^now/, "current_timestamp");
  }
  return text;
}

function normalizeExpectedExtra(column: SnapshotColumn): string {
  const values: string[] = [];
  if (column.autoincrement) values.push("auto_increment");
  if (column.onUpdate) {
    const precision = /\((\d+)\)/.exec(column.type)?.[1];
    values.push(
      `on update current_timestamp${precision ? `(${precision})` : ""}`,
    );
  }
  return values.join(" ");
}

function normalizeActualExtra(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bdefault_generated\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRule(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, " ");
}

function isLeftmostPrefix(required: string[], indexed: string[]): boolean {
  return required.every((column, index) => indexed[index] === column);
}

function compareCanonical(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
