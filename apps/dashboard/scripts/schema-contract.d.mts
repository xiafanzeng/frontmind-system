export type DatabaseSchemaColumn = {
  name: string;
  type: string;
  nullable: boolean;
  autoIncrement: boolean;
  default: null | {
    kind: "literal" | "expression";
    value: string;
  };
  onUpdate: string | null;
  generated: null | {
    expression: string;
    storage: "stored" | "virtual";
  };
  characterSet: string | null;
  collation: string | null;
};

export type DatabaseSchemaIndex = {
  name: string;
  columns: string[];
  unique: boolean;
  method: "btree" | "hash" | "fulltext" | "spatial" | "rtree";
};

export type DatabaseSchemaCheck = {
  name: string;
  expression: string;
  enforced: boolean;
};

export type DatabaseSchemaForeignKey = {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
};

export type DatabaseSchemaTable = {
  name: string;
  engine: "innodb";
  characterSet: string;
  collation: string;
  columns: DatabaseSchemaColumn[];
  primaryKey: string[];
  indexes: DatabaseSchemaIndex[];
  foreignKeys: DatabaseSchemaForeignKey[];
  checks: DatabaseSchemaCheck[];
};

export type DatabaseSchemaContract = {
  contractVersion: 1;
  tables: DatabaseSchemaTable[];
};

export type DatabaseSchemaEvaluation = {
  status: "exact" | "diverged";
  expectedHash: string;
  actualHash: string;
  expectedTableCount: number;
  actualTableCount: number;
  differences: string[];
};

export function createSchemaContractFromSnapshot(
  snapshotValue: unknown,
): DatabaseSchemaContract;
export function canonicalSchemaContractPayload(
  contract: DatabaseSchemaContract,
): string;
export function schemaContractHash(contract: DatabaseSchemaContract): string;
export function parseSchemaContract(value: unknown): DatabaseSchemaContract;
export function inspectDatabaseSchema(
  database: {
    query(query: string): Promise<unknown>;
  },
  expectedContract?: DatabaseSchemaContract,
): Promise<DatabaseSchemaContract>;
export function evaluateDatabaseSchema(
  database: { query(query: string): Promise<unknown> },
  expectedContract: DatabaseSchemaContract,
): Promise<DatabaseSchemaEvaluation>;
