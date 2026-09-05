import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createSchemaContractFromSnapshot,
  evaluateDatabaseSchema,
  normalizeDatabaseColumnDefault,
  parseSchemaContract,
  schemaContractHash,
  type DatabaseSchemaContract,
} from "./schema-contract.mjs";

async function currentContract() {
  const snapshot = JSON.parse(
    await fs.readFile(path.resolve("drizzle/meta/0048_snapshot.json"), "utf8"),
  );
  return createSchemaContractFromSnapshot(snapshot);
}

function generatedColumnSnapshot() {
  return {
    dialect: "mysql",
    version: "5",
    tables: {
      generated_probe: {
        name: "generated_probe",
        columns: {
          id: {
            name: "id",
            type: "int",
            primaryKey: false,
            notNull: true,
            autoincrement: true,
          },
          base: {
            name: "base",
            type: "int",
            primaryKey: false,
            notNull: true,
            autoincrement: false,
            default: 1,
          },
          doubled: {
            name: "doubled",
            type: "int",
            primaryKey: false,
            notNull: true,
            autoincrement: false,
            generated: { as: "`base` * 2", type: "virtual" },
          },
          label: {
            name: "label",
            type: "varchar(32)",
            primaryKey: false,
            notNull: true,
            autoincrement: false,
            default: "'ready'",
          },
        },
        indexes: {},
        foreignKeys: {},
        compositePrimaryKeys: {
          generated_probe_id: {
            name: "generated_probe_id",
            columns: ["id"],
          },
        },
        uniqueConstraints: {},
        checkConstraint: {
          generated_probe_positive_ck: {
            name: "generated_probe_positive_ck",
            value: "`generated_probe`.`base` > 0",
          },
        },
      },
    },
  };
}

function metadataRows(contract: DatabaseSchemaContract) {
  const schema = [
    {
      schemaCharacterSet: "utf8mb4",
      schemaCollation: "utf8mb4_0900_ai_ci",
    },
  ];
  const tables = contract.tables.map((table) => ({
    tableName: table.name,
    engine: table.engine === "innodb" ? "InnoDB" : table.engine,
    characterSet:
      table.characterSet === "schema-default" ? "utf8mb4" : table.characterSet,
    collation:
      table.collation === "schema-default"
        ? "utf8mb4_0900_ai_ci"
        : table.collation,
  }));
  const columns = contract.tables.flatMap((table) =>
    table.columns.map((column, index) => {
      const extras = [];
      if (column.autoIncrement) extras.push("auto_increment");
      if (column.default?.kind === "expression") {
        extras.push("DEFAULT_GENERATED");
      }
      if (column.onUpdate) extras.push(`on update ${column.onUpdate}`);
      if (column.generated) {
        extras.push(`${column.generated.storage.toUpperCase()} GENERATED`);
      }
      return {
        tableName: table.name,
        columnName: column.name,
        columnType: column.type === "boolean" ? "tinyint(1)" : column.type,
        isNullable: column.nullable ? "YES" : "NO",
        columnDefault: column.default?.value ?? null,
        characterSet:
          column.characterSet === "table-default"
            ? "utf8mb4"
            : column.characterSet,
        collation:
          column.collation === "table-default"
            ? "utf8mb4_0900_ai_ci"
            : column.collation,
        generationExpression: column.generated?.expression ?? "",
        extra: extras.join(" "),
        ordinalPosition: index + 1,
      };
    }),
  );
  const indexes = contract.tables.flatMap((table) => [
    ...table.primaryKey.map((columnName, index) => ({
      tableName: table.name,
      indexName: "PRIMARY",
      nonUnique: 0,
      sequenceInIndex: index + 1,
      columnName,
      expression: null,
      subPart: null,
      indexType: "BTREE",
    })),
    ...table.indexes.flatMap((schemaIndex) =>
      schemaIndex.columns.map((columnName, index) => ({
        tableName: table.name,
        indexName: schemaIndex.name,
        nonUnique: schemaIndex.unique ? 0 : 1,
        sequenceInIndex: index + 1,
        columnName,
        expression: null,
        subPart: null,
        indexType: schemaIndex.method.toUpperCase(),
      })),
    ),
  ]);
  const foreignKeys = contract.tables.flatMap((table) =>
    table.foreignKeys.flatMap((foreignKey) =>
      foreignKey.columns.map((columnName, index) => ({
        tableName: table.name,
        constraintName: foreignKey.name,
        columnName,
        referencedTableName: foreignKey.referencedTable,
        referencedColumnName: foreignKey.referencedColumns[index],
        ordinalPosition: index + 1,
        updateRule: foreignKey.onUpdate.toUpperCase(),
        deleteRule: foreignKey.onDelete.toUpperCase(),
      })),
    ),
  );
  const checks = contract.tables.flatMap((table) =>
    table.checks.map((check) => ({
      tableName: table.name,
      constraintName: check.name,
      checkClause: check.expression,
      enforced: check.enforced ? "YES" : "NO",
    })),
  );
  return { schema, tables, columns, indexes, foreignKeys, checks };
}

function uppercaseInformationSchemaRows(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase(),
        value,
      ]),
    ),
  );
}

function databaseFromRows(
  rows: ReturnType<typeof metadataRows>,
  transformRows: (
    rows: Record<string, unknown>[],
  ) => Record<string, unknown>[] = (values) => values,
) {
  return {
    query: async (query: string) => {
      if (query.includes("information_schema.SCHEMATA")) {
        return [transformRows(rows.schema), []];
      }
      if (query.includes("information_schema.TABLES")) {
        return [transformRows(rows.tables), []];
      }
      if (query.includes("information_schema.COLUMNS"))
        return [transformRows(rows.columns), []];
      if (query.includes("information_schema.STATISTICS")) {
        return [transformRows(rows.indexes), []];
      }
      if (query.includes("information_schema.KEY_COLUMN_USAGE")) {
        return [transformRows(rows.foreignKeys), []];
      }
      if (query.includes("information_schema.TABLE_CONSTRAINTS")) {
        return [transformRows(rows.checks), []];
      }
      throw new Error("unexpected information_schema query");
    },
  };
}

describe("database schema contract", () => {
  it("creates a stable complete contract from the latest Drizzle snapshot", async () => {
    const contract = await currentContract();

    expect(contract.contractVersion).toBe(1);
    expect(contract.tables).toHaveLength(57);
    expect(contract.tables.every((table) => table.engine === "innodb")).toBe(
      true,
    );
    expect(contract.tables.map((table) => table.name)).not.toContain(
      "__drizzle_migrations",
    );
    expect(schemaContractHash(parseSchemaContract(contract))).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(
      contract.tables.find((table) => table.name === "users"),
    ).toMatchObject({
      primaryKey: ["id"],
      checks: [
        expect.objectContaining({
          name: "users_engineer_role_consistency_ck",
          enforced: true,
        }),
      ],
    });
  });

  it("accepts the same information_schema shape and normalizes MySQL booleans", async () => {
    const contract = await currentContract();
    const result = await evaluateDatabaseSchema(
      databaseFromRows(metadataRows(contract)),
      contract,
    );

    expect(result).toMatchObject({
      status: "exact",
      expectedHash: schemaContractHash(contract),
      actualHash: schemaContractHash(contract),
      expectedTableCount: 57,
      actualTableCount: 57,
      differences: [],
    });
  });

  it("normalizes legal MySQL 8.4 spellings without hiding semantic drift", async () => {
    const contract = await currentContract();
    const rows = metadataRows(contract);
    rows.schema[0]!.schemaCollation = "utf8mb4_general_ci";
    for (const table of rows.tables) {
      table.collation = "utf8mb4_general_ci";
    }
    for (const column of rows.columns) {
      if (column.collation !== null) column.collation = "utf8mb4_general_ci";
    }

    const timestampDefault = rows.columns.find(
      (column) =>
        column.columnType === "timestamp" &&
        column.extra.includes("DEFAULT_GENERATED"),
    )!;
    timestampDefault.columnDefault = "now()";
    const jsonDefault = rows.columns.find(
      (column) => column.columnType === "json" && column.columnDefault === "[]",
    )!;
    jsonDefault.columnDefault = "(_utf8mb4'[]')";
    jsonDefault.extra = `${jsonDefault.extra} DEFAULT_GENERATED`.trim();

    const usersCheck = rows.checks.find(
      (check) => check.constraintName === "users_engineer_role_consistency_ck",
    )!;
    usersCheck.checkClause = `
      (((\`users\`.\`role\` = _utf8mb4'delivery_member') AND
        (\`users\`.\`engineerRoleType\` IS NOT NULL)) OR
       ((\`users\`.\`role\` <> _utf8mb4'delivery_member') AND
        (\`users\`.\`engineerRoleType\` IS NULL)))
    `;
    const regexpCheck = rows.checks.find((check) =>
      check.checkClause.includes(" regexp "),
    )!;
    const regexpMatch = regexpCheck.checkClause.match(
      /^\((`[^`]+`) regexp ('(?:''|[^'])*')\)$/u,
    );
    expect(regexpMatch).not.toBeNull();
    regexpCheck.checkClause = `REGEXP_LIKE(${regexpMatch![1]}, _utf8mb4${regexpMatch![2]})`;

    await expect(
      evaluateDatabaseSchema(databaseFromRows(rows), contract),
    ).resolves.toMatchObject({ status: "exact", differences: [] });

    expect(
      normalizeDatabaseColumnDefault(
        "CURRENT_TIMESTAMP",
        "timestamp(0)",
        "DEFAULT_GENERATED",
      ),
    ).toEqual({ kind: "expression", value: "current_timestamp()" });
    expect(
      normalizeDatabaseColumnDefault("now()", "timestamp", "DEFAULT_GENERATED"),
    ).toEqual({ kind: "expression", value: "current_timestamp()" });
    expect(
      normalizeDatabaseColumnDefault(
        "CURRENT_TIMESTAMP(3)",
        "timestamp(3)",
        "DEFAULT_GENERATED",
      ),
    ).toEqual({ kind: "expression", value: "current_timestamp(3)" });
  });

  it("normalizes MySQL 8.4 alias casing and JSON metadata values semantically", async () => {
    const contract = await currentContract();
    const rows = metadataRows(contract);
    const attachmentDefault = rows.columns.find(
      (column) =>
        column.tableName === "conversation_turns" &&
        column.columnName === "attachmentFileIds",
    )!;
    const metadataDefault = rows.columns.find(
      (column) =>
        column.tableName === "conversation_turns" &&
        column.columnName === "metadata",
    )!;
    (attachmentDefault as Record<string, unknown>).columnDefault = Buffer.from(
      "(JSON_ARRAY())",
      "utf8",
    );
    (metadataDefault as Record<string, unknown>).columnDefault = {};

    await expect(
      evaluateDatabaseSchema(
        databaseFromRows(rows, uppercaseInformationSchemaRows),
        contract,
      ),
    ).resolves.toMatchObject({ status: "exact", differences: [] });

    (attachmentDefault as Record<string, unknown>).columnDefault = Buffer.from(
      "('[1]')",
      "utf8",
    );
    const drift = await evaluateDatabaseSchema(
      databaseFromRows(rows, uppercaseInformationSchemaRows),
      contract,
    );
    expect(drift.status).toBe("diverged");
    expect(drift.differences).toEqual([
      expect.stringMatching(/\.default\.value$/u),
    ]);
  });

  it("normalizes MySQL 8.4 escaped character-set JSON defaults without hiding drift", async () => {
    const contract = await currentContract();
    const rows = metadataRows(contract);
    const attachmentDefault = rows.columns.find(
      (column) =>
        column.tableName === "conversation_turns" &&
        column.columnName === "attachmentFileIds",
    )!;
    const metadataDefault = rows.columns.find(
      (column) =>
        column.tableName === "conversation_turns" &&
        column.columnName === "metadata",
    )!;

    attachmentDefault.columnDefault = "_utf8mb4\\'[]\\'";
    attachmentDefault.extra = "DEFAULT_GENERATED";
    metadataDefault.columnDefault = "_utf8mb4\\'{}\\'";
    metadataDefault.extra = "DEFAULT_GENERATED";
    const usersCheck = rows.checks.find(
      (check) => check.constraintName === "users_engineer_role_consistency_ck",
    )!;
    usersCheck.checkClause = `
      (((\`role\` = _utf8mb4\\'delivery_member\\') AND
        (\`engineerRoleType\` IS NOT NULL)) OR
       ((\`role\` <> _utf8mb4\\'delivery_member\\') AND
        (\`engineerRoleType\` IS NULL)))
    `;

    await expect(
      evaluateDatabaseSchema(databaseFromRows(rows), contract),
    ).resolves.toMatchObject({ status: "exact", differences: [] });

    const exactCheck = usersCheck.checkClause;
    usersCheck.checkClause = exactCheck.replaceAll("delivery_member", "admin");
    const checkDrift = await evaluateDatabaseSchema(
      databaseFromRows(rows),
      contract,
    );
    expect(checkDrift.status).toBe("diverged");
    expect(checkDrift.differences).toEqual([
      expect.stringMatching(/\.checks\.\d+\.expression$/u),
    ]);
    usersCheck.checkClause = exactCheck;

    attachmentDefault.columnDefault = "_utf8mb4\\'[1]\\'";
    const drift = await evaluateDatabaseSchema(
      databaseFromRows(rows),
      contract,
    );
    expect(drift.status).toBe("diverged");
    expect(drift.differences).toEqual([
      expect.stringMatching(/\.default\.value$/u),
    ]);
  });

  it("compares defaults, on-update clauses, charsets, collations, and CHECK bodies", async () => {
    const contract = await currentContract();
    const cases: Array<{
      label: string;
      mutate: (rows: ReturnType<typeof metadataRows>) => void;
      difference: RegExp;
    }> = [
      {
        label: "default",
        mutate: (rows) => {
          rows.columns.find(
            (column) =>
              column.tableName === "users" && column.columnName === "role",
          )!.columnDefault = "admin";
        },
        difference: /\.default/u,
      },
      {
        label: "on update",
        mutate: (rows) => {
          const column = rows.columns.find(
            (candidate) =>
              candidate.tableName === "users" &&
              candidate.columnName === "updatedAt",
          )!;
          column.extra = column.extra.replace(
            /\s*on update current_timestamp\(\)/iu,
            "",
          );
        },
        difference: /\.onUpdate/u,
      },
      {
        label: "column charset and collation",
        mutate: (rows) => {
          const column = rows.columns.find(
            (candidate) =>
              candidate.tableName === "users" &&
              candidate.columnName === "email",
          )!;
          column.characterSet = "latin1";
          column.collation = "latin1_swedish_ci";
        },
        difference: /\.(?:characterSet|collation)/u,
      },
      {
        label: "table charset and collation",
        mutate: (rows) => {
          const table = rows.tables.find(
            (candidate) => candidate.tableName === "users",
          )!;
          table.characterSet = "latin1";
          table.collation = "latin1_swedish_ci";
        },
        difference: /\.(?:characterSet|collation)/u,
      },
      {
        label: "check expression",
        mutate: (rows) => {
          rows.checks.find(
            (check) =>
              check.constraintName === "users_engineer_role_consistency_ck",
          )!.checkClause = "`role` = 'delivery_member'";
        },
        difference: /\.expression/u,
      },
      {
        label: "check enforcement",
        mutate: (rows) => {
          rows.checks.find(
            (check) =>
              check.constraintName === "users_engineer_role_consistency_ck",
          )!.enforced = "NO";
        },
        difference: /\.enforced/u,
      },
    ];

    for (const testCase of cases) {
      const rows = metadataRows(contract);
      testCase.mutate(rows);
      const result = await evaluateDatabaseSchema(
        databaseFromRows(rows),
        contract,
      );
      expect(result.status, testCase.label).toBe("diverged");
      expect(result.differences.join("\n"), testCase.label).toMatch(
        testCase.difference,
      );
    }
  });

  it("round-trips generated columns and detects generation-expression drift", async () => {
    const contract = createSchemaContractFromSnapshot(
      generatedColumnSnapshot(),
    );
    const rows = metadataRows(contract);

    await expect(
      evaluateDatabaseSchema(databaseFromRows(rows), contract),
    ).resolves.toMatchObject({ status: "exact" });

    rows.columns.find(
      (column) => column.columnName === "doubled",
    )!.generationExpression = "`base` * 3";
    const drift = await evaluateDatabaseSchema(
      databaseFromRows(rows),
      contract,
    );
    expect(drift.status).toBe("diverged");
    expect(drift.differences.join("\n")).toMatch(/\.generated\.expression/u);
  });

  it("normalizes historical foreign-key names only when every semantic field matches", async () => {
    const contract = await currentContract();
    const exactRows = metadataRows(contract);
    const table = contract.tables.find(
      (candidate) => candidate.foreignKeys.length > 0,
    )!;
    const foreignKey = table.foreignKeys[0]!;
    const foreignKeyRows = exactRows.foreignKeys.filter(
      (row) =>
        row.tableName === table.name && row.constraintName === foreignKey.name,
    );
    expect(foreignKeyRows.length).toBeGreaterThan(0);
    for (const row of foreignKeyRows) {
      row.constraintName = "historical_short_fk";
    }

    await expect(
      evaluateDatabaseSchema(databaseFromRows(exactRows), contract),
    ).resolves.toMatchObject({ status: "exact", differences: [] });

    foreignKeyRows[0]!.deleteRule =
      foreignKeyRows[0]!.deleteRule === "CASCADE" ? "RESTRICT" : "CASCADE";
    const drift = await evaluateDatabaseSchema(
      databaseFromRows(exactRows),
      contract,
    );
    expect(drift.status).toBe("diverged");
    expect(drift.differences.join("\n")).toMatch(/\.foreignKeys\./u);
  });

  it("normalizes a historical index name only for one complete semantic match", async () => {
    const contract = await currentContract();
    const exactRows = metadataRows(contract);
    const table = contract.tables.find((candidate) =>
      candidate.indexes.some((index) => index.unique),
    )!;
    const index = table.indexes.find((candidate) => candidate.unique)!;
    const indexRows = exactRows.indexes.filter(
      (row) => row.tableName === table.name && row.indexName === index.name,
    );
    expect(indexRows.length).toBeGreaterThan(0);
    for (const row of indexRows) {
      row.indexName = "historical_short_uq";
    }

    await expect(
      evaluateDatabaseSchema(databaseFromRows(exactRows), contract),
    ).resolves.toMatchObject({ status: "exact", differences: [] });

    indexRows[0]!.nonUnique = 1;
    const drift = await evaluateDatabaseSchema(
      databaseFromRows(exactRows),
      contract,
    );
    expect(drift.status).toBe("diverged");
    expect(drift.differences.join("\n")).toMatch(/\.indexes\./u);
  });

  it("ignores only MySQL's generated foreign-key index and fails closed on drift", async () => {
    const contract = await currentContract();
    const exactRows = metadataRows(contract);
    const table = contract.tables.find(
      (candidate) => candidate.foreignKeys.length > 0,
    )!;
    const foreignKey = table.foreignKeys[0]!;
    exactRows.indexes.push(
      ...foreignKey.columns.map((columnName, index) => ({
        tableName: table.name,
        indexName: foreignKey.name,
        nonUnique: 1,
        sequenceInIndex: index + 1,
        columnName,
        expression: null,
        subPart: null,
        indexType: "BTREE",
      })),
    );
    await expect(
      evaluateDatabaseSchema(databaseFromRows(exactRows), contract),
    ).resolves.toMatchObject({ status: "exact" });

    for (const generatedName of [
      foreignKey.columns[0]!,
      `${foreignKey.columns[0]}_2`,
    ]) {
      const generatedNameRows = metadataRows(contract);
      generatedNameRows.indexes.push(
        ...foreignKey.columns.map((columnName, index) => ({
          tableName: table.name,
          indexName: generatedName,
          nonUnique: 1,
          sequenceInIndex: index + 1,
          columnName,
          expression: null,
          subPart: null,
          indexType: "BTREE",
        })),
      );
      await expect(
        evaluateDatabaseSchema(databaseFromRows(generatedNameRows), contract),
      ).resolves.toMatchObject({ status: "exact" });
    }

    const prefixNamedRows = metadataRows(contract);
    prefixNamedRows.indexes.push(
      ...foreignKey.columns.map((columnName, index) => ({
        tableName: table.name,
        indexName: `${foreignKey.columns[0]}_manual`,
        nonUnique: 1,
        sequenceInIndex: index + 1,
        columnName,
        expression: null,
        subPart: null,
        indexType: "BTREE",
      })),
    );
    await expect(
      evaluateDatabaseSchema(databaseFromRows(prefixNamedRows), contract),
    ).resolves.toMatchObject({ status: "diverged" });

    const contractWithDeclaredIndex = structuredClone(contract);
    const declaredTable = contractWithDeclaredIndex.tables.find(
      (candidate) => candidate.name === table.name,
    )!;
    declaredTable.indexes.push({
      name: foreignKey.name,
      columns: [...foreignKey.columns],
      unique: false,
      method: "btree",
    });
    declaredTable.indexes.sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
    await expect(
      evaluateDatabaseSchema(
        databaseFromRows(metadataRows(contractWithDeclaredIndex)),
        contractWithDeclaredIndex,
      ),
    ).resolves.toMatchObject({ status: "exact" });

    const driftRows = metadataRows(contract);
    driftRows.columns[0]!.columnType = "varchar(255)";
    driftRows.indexes.push({
      tableName: table.name,
      indexName: "undeclared_manual_index",
      nonUnique: 1,
      sequenceInIndex: 1,
      columnName: foreignKey.columns[0]!,
      expression: null,
      subPart: null,
      indexType: "BTREE",
    });
    const drift = await evaluateDatabaseSchema(
      databaseFromRows(driftRows),
      contract,
    );
    expect(drift.status).toBe("diverged");
    expect(drift.actualHash).not.toBe(drift.expectedHash);
    expect(drift.differences.length).toBeGreaterThan(0);
  });
});
