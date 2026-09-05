import { createHash } from "node:crypto";

export const DATABASE_SCHEMA_CONTRACT_VERSION = 1;
export const DATABASE_SCHEMA_STATUS = ["exact", "diverged"];

const SCHEMA_DEFAULT = "schema-default";
const TABLE_DEFAULT = "table-default";

const INFORMATION_SCHEMA_QUERIES = {
  schema: `
    SELECT DEFAULT_CHARACTER_SET_NAME AS schema_character_set,
           DEFAULT_COLLATION_NAME AS schema_collation
      FROM information_schema.SCHEMATA
     WHERE SCHEMA_NAME = DATABASE()`,
  tables: `
    SELECT t.TABLE_NAME AS table_name, t.ENGINE AS engine,
           c.CHARACTER_SET_NAME AS character_set,
           t.TABLE_COLLATION AS collation
      FROM information_schema.TABLES t
      LEFT JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY c
        ON c.COLLATION_NAME = t.TABLE_COLLATION
     WHERE t.TABLE_SCHEMA = DATABASE()
       AND t.TABLE_TYPE = 'BASE TABLE'
       AND t.TABLE_NAME <> '__drizzle_migrations'
     ORDER BY t.TABLE_NAME`,
  columns: `
    SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
           COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable,
           COLUMN_DEFAULT AS column_default,
           CHARACTER_SET_NAME AS character_set, COLLATION_NAME AS collation,
           GENERATION_EXPRESSION AS generation_expression,
           EXTRA AS extra, ORDINAL_POSITION AS ordinal_position
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME <> '__drizzle_migrations'
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  indexes: `
    SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
           NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS sequence_in_index,
           COLUMN_NAME AS column_name, EXPRESSION AS expression,
           SUB_PART AS sub_part, INDEX_TYPE AS index_type
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME <> '__drizzle_migrations'
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
  foreignKeys: `
    SELECT kcu.TABLE_NAME AS table_name,
           kcu.CONSTRAINT_NAME AS constraint_name,
           kcu.COLUMN_NAME AS column_name,
           kcu.REFERENCED_TABLE_NAME AS referenced_table_name,
           kcu.REFERENCED_COLUMN_NAME AS referenced_column_name,
           kcu.ORDINAL_POSITION AS ordinal_position,
           rc.UPDATE_RULE AS update_rule, rc.DELETE_RULE AS delete_rule
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
       AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.TABLE_SCHEMA = DATABASE()
       AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
       AND kcu.TABLE_NAME <> '__drizzle_migrations'
     ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
  checks: `
    SELECT tc.TABLE_NAME AS table_name,
           tc.CONSTRAINT_NAME AS constraint_name,
           cc.CHECK_CLAUSE AS check_clause,
           tc.ENFORCED AS enforced
      FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.CHECK_CONSTRAINTS cc
        ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
     WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
       AND tc.CONSTRAINT_TYPE = 'CHECK'
       AND tc.TABLE_NAME <> '__drizzle_migrations'
     ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`,
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function hasExactKeys(value, keys) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function stringValue(value, code) {
  if (typeof value !== "string" || !value) throw new Error(code);
  return value;
}

function normalizeName(value, code = "DATABASE_SCHEMA_METADATA_INVALID") {
  return stringValue(value, code);
}

function normalizeType(value) {
  const normalized = stringValue(value, "DATABASE_SCHEMA_COLUMN_TYPE_INVALID")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/^int\(11\)(?=\s|$)/u, "int")
    .replace(/^int\(10\) unsigned(?=\s|$)/u, "int unsigned")
    .replace(/^bigint\(20\)(?=\s|$)/u, "bigint")
    .replace(/^bigint\(20\) unsigned(?=\s|$)/u, "bigint unsigned")
    .replace(/^timestamp\(0\)$/u, "timestamp");
  if (["bool", "boolean", "tinyint(1)"].includes(normalized)) {
    return "boolean";
  }
  return normalized;
}

function normalizeAction(value) {
  return stringValue(value, "DATABASE_SCHEMA_FOREIGN_KEY_ACTION_INVALID")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

function normalizeIndexMethod(value) {
  const normalized = String(value ?? "btree")
    .trim()
    .toLowerCase();
  if (!["btree", "hash", "fulltext", "spatial", "rtree"].includes(normalized)) {
    throw new Error("DATABASE_SCHEMA_INDEX_METHOD_INVALID");
  }
  return normalized;
}

function normalizeColumns(value, code) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  return value.map((column) => normalizeName(column, code));
}

function sortedEntries(value, code) {
  const object = assertObject(value ?? {}, code);
  return Object.entries(object).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  );
}

function isCharacterType(type) {
  return /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)(?:\(|$)/u.test(
    type,
  );
}

function normalizeNumericLiteral(value) {
  const raw = String(value).trim().toLowerCase();
  const match = raw.match(
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/u,
  );
  if (!match) {
    throw new Error("DATABASE_SCHEMA_DEFAULT_INVALID");
  }
  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number.parseInt(match[5] ?? "0", 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new Error("DATABASE_SCHEMA_DEFAULT_INVALID");
  }
  let digits = `${integer}${fraction}`.replace(/^0+/u, "");
  if (!digits) return "0";
  let decimalPosition = integer.length + exponent;
  decimalPosition -= `${integer}${fraction}`.length - digits.length;
  let normalized;
  if (decimalPosition <= 0) {
    normalized = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    normalized = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  } else {
    normalized = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  normalized = normalized
    .replace(/^(\d+)\.0+$/u, "$1")
    .replace(/(\.\d*?[1-9])0+$/u, "$1");
  return `${sign}${normalized}`;
}

function sqlTokens(value) {
  const input = stringValue(value, "DATABASE_SCHEMA_EXPRESSION_INVALID").trim();
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "`") {
      let result = "";
      index += 1;
      while (index < input.length) {
        if (input[index] === "`" && input[index + 1] === "`") {
          result += "`";
          index += 2;
        } else if (input[index] === "`") {
          index += 1;
          break;
        } else {
          result += input[index];
          index += 1;
        }
      }
      if (!result) throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
      tokens.push({ kind: "identifier", value: result });
      continue;
    }
    if (character === "'") {
      let result = "";
      index += 1;
      let closed = false;
      while (index < input.length) {
        if (input[index] === "'" && input[index + 1] === "'") {
          result += "'";
          index += 2;
        } else if (input[index] === "\\" && index + 1 < input.length) {
          result += input[index + 1];
          index += 2;
        } else if (input[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else {
          result += input[index];
          index += 1;
        }
      }
      if (!closed) throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
      tokens.push({ kind: "string", value: result });
      continue;
    }
    const remaining = input.slice(index);
    const numberMatch = remaining.match(
      /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/iu,
    );
    if (numberMatch) {
      tokens.push({
        kind: "number",
        value: normalizeNumericLiteral(numberMatch[0]),
      });
      index += numberMatch[0].length;
      continue;
    }
    const wordMatch = remaining.match(/^[A-Za-z_$][A-Za-z0-9_$]*/u);
    if (wordMatch) {
      tokens.push({ kind: "word", value: wordMatch[0] });
      index += wordMatch[0].length;
      continue;
    }
    const operator = [
      "->>",
      "<=>",
      ">=",
      "<=",
      "<>",
      "!=",
      "||",
      "&&",
      "<<",
      ">>",
      "->",
      ":=",
    ].find((candidate) => remaining.startsWith(candidate));
    if (operator) {
      tokens.push({ kind: "operator", value: operator });
      index += operator.length;
      continue;
    }
    if ("(),.+-*/%=<>&|^~!".includes(character)) {
      tokens.push({
        kind: "operator",
        value: character,
      });
      index += 1;
      continue;
    }
    throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
  }

  const withoutIntroducers = tokens.filter(
    (token, tokenIndex) =>
      !(
        token.kind === "word" &&
        /^_[A-Za-z0-9]+$/u.test(token.value) &&
        tokens[tokenIndex + 1]?.kind === "string"
      ),
  );
  return withoutIntroducers;
}

function normalizeExpressionTokens(tokens) {
  // Drop table/schema qualifiers while preserving the last identifier.
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      ["identifier", "word"].includes(token.kind) &&
      tokens[index + 1]?.value === "." &&
      ["identifier", "word"].includes(tokens[index + 2]?.kind)
    ) {
      continue;
    }
    if (
      token.value === "." &&
      ["identifier", "word"].includes(tokens[index - 1]?.kind) &&
      ["identifier", "word"].includes(tokens[index + 1]?.kind)
    ) {
      continue;
    }
    result.push(token);
  }
  return result;
}

function parseSqlExpression(value) {
  const tokens = normalizeExpressionTokens(sqlTokens(value));
  let cursor = 0;
  const current = () => tokens[cursor];
  const wordIs = (word) =>
    current()?.kind === "word" && current().value.toLowerCase() === word;
  const consume = () => tokens[cursor++];
  const expectValue = (expected) => {
    if (current()?.value !== expected) {
      throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
    }
    consume();
  };

  const parsePrefix = () => {
    const token = current();
    if (!token) throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
    if (token.value === "(") {
      consume();
      const expression = parseExpression(0);
      expectValue(")");
      return expression;
    }
    if (wordIs("not")) {
      consume();
      return { kind: "unary", operator: "not", value: parseExpression(7) };
    }
    if (["+", "-"].includes(token.value)) {
      consume();
      return {
        kind: "unary",
        operator: token.value,
        value: parseExpression(7),
      };
    }
    consume();
    if (token.kind === "string") {
      return { kind: "string", value: token.value };
    }
    if (token.kind === "number") {
      return { kind: "number", value: token.value };
    }
    if (!["identifier", "word"].includes(token.kind)) {
      throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
    }
    const lowered = token.value.toLowerCase();
    if (lowered === "null") return { kind: "null" };
    if (lowered === "true" || lowered === "false") {
      return { kind: "number", value: lowered === "true" ? "1" : "0" };
    }
    const name = ["now", "current_timestamp"].includes(lowered)
      ? "current_timestamp"
      : token.kind === "word"
        ? lowered
        : token.value;
    if (current()?.value !== "(") {
      return ["now", "current_timestamp"].includes(lowered)
        ? { kind: "call", name: "current_timestamp", arguments: [] }
        : { kind: "identifier", name };
    }
    consume();
    const argumentsList = [];
    if (current()?.value !== ")") {
      while (true) {
        argumentsList.push(parseExpression(0));
        if (current()?.value !== ",") break;
        consume();
      }
    }
    expectValue(")");
    if (name === "regexp_like" && argumentsList.length === 2) {
      return {
        kind: "binary",
        operator: "regexp",
        left: argumentsList[0],
        right: argumentsList[1],
      };
    }
    return { kind: "call", name, arguments: argumentsList };
  };

  const operatorAtCursor = () => {
    const token = current();
    if (!token) return null;
    const lowered = String(token.value).toLowerCase();
    if (lowered === "or" || lowered === "||") {
      return { operator: "or", precedence: 1, width: 1 };
    }
    if (lowered === "and" || lowered === "&&") {
      return { operator: "and", precedence: 2, width: 1 };
    }
    if (lowered === "not") {
      const next = String(tokens[cursor + 1]?.value ?? "").toLowerCase();
      if (["in", "like", "regexp", "between"].includes(next)) {
        return { operator: `not ${next}`, precedence: 3, width: 2 };
      }
      return null;
    }
    if (
      [
        "=",
        "!=",
        "<>",
        "<=>",
        ">",
        ">=",
        "<",
        "<=",
        "is",
        "in",
        "like",
        "regexp",
        "between",
      ].includes(lowered)
    ) {
      return {
        operator: lowered === "<>" ? "!=" : lowered,
        precedence: 3,
        width: 1,
      };
    }
    if (["+", "-"].includes(lowered)) {
      return { operator: lowered, precedence: 4, width: 1 };
    }
    if (["*", "/", "%"].includes(lowered)) {
      return { operator: lowered, precedence: 5, width: 1 };
    }
    return null;
  };

  const parseExpression = (minimumPrecedence = 0) => {
    let left = parsePrefix();
    while (true) {
      const operation = operatorAtCursor();
      if (!operation || operation.precedence < minimumPrecedence) break;
      cursor += operation.width;
      let operator = operation.operator;
      if (operator === "is" && wordIs("not")) {
        consume();
        operator = "is not";
      }
      if (operator.endsWith("in")) {
        expectValue("(");
        const values = [];
        if (current()?.value !== ")") {
          while (true) {
            values.push(parseExpression(0));
            if (current()?.value !== ",") break;
            consume();
          }
        }
        expectValue(")");
        left = { kind: "list", operator, left, values };
        continue;
      }
      if (operator.endsWith("between")) {
        const lower = parseExpression(operation.precedence + 1);
        if (!wordIs("and")) {
          throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
        }
        consume();
        const upper = parseExpression(operation.precedence + 1);
        left = { kind: "between", operator, left, lower, upper };
        continue;
      }
      const right = parseExpression(operation.precedence + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  };

  const result = parseExpression(0);
  if (cursor !== tokens.length) {
    throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
  }
  return result;
}

function quoteIdentifier(value) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function quoteString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function serializeSqlExpression(expression) {
  switch (expression.kind) {
    case "identifier":
      return quoteIdentifier(expression.name);
    case "string":
      return quoteString(expression.value);
    case "number":
      return expression.value;
    case "null":
      return "null";
    case "call":
      return `${expression.name}(${expression.arguments
        .map(serializeSqlExpression)
        .join(",")})`;
    case "unary":
      return `(${expression.operator} ${serializeSqlExpression(expression.value)})`;
    case "binary":
      return `(${serializeSqlExpression(expression.left)} ${expression.operator} ${serializeSqlExpression(expression.right)})`;
    case "list":
      return `(${serializeSqlExpression(expression.left)} ${expression.operator} (${expression.values
        .map(serializeSqlExpression)
        .join(",")}))`;
    case "between":
      return `(${serializeSqlExpression(expression.left)} ${expression.operator} ${serializeSqlExpression(expression.lower)} and ${serializeSqlExpression(expression.upper)})`;
    default:
      throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
  }
}

function fallbackSqlExpression(value) {
  let tokens = normalizeExpressionTokens(sqlTokens(value));
  while (
    tokens.length >= 3 &&
    tokens[0]?.value === "(" &&
    tokens.at(-1)?.value === ")"
  ) {
    let depth = 0;
    let wrapsAll = true;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].value === "(") depth += 1;
      if (tokens[index].value === ")") depth -= 1;
      if (depth < 0) throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
      if (depth === 0 && index < tokens.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (depth !== 0) throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
    if (!wrapsAll) break;
    tokens = tokens.slice(1, -1);
  }
  let depth = 0;
  const serialized = tokens.map((token) => {
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth -= 1;
    if (depth < 0) throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
    if (token.kind === "identifier") return quoteIdentifier(token.value);
    if (token.kind === "string") return quoteString(token.value);
    if (token.kind === "number") return token.value;
    const lowered = token.value.toLowerCase();
    if (lowered === "<>") return "!=";
    if (lowered === "&&") return "and";
    if (lowered === "||") return "or";
    if (lowered === "true") return "1";
    if (lowered === "false") return "0";
    if (lowered === "now") return "current_timestamp";
    return lowered;
  });
  if (depth !== 0 || serialized.length === 0) {
    throw new Error("DATABASE_SCHEMA_EXPRESSION_INVALID");
  }
  return serialized.join(" ");
}

function normalizeSqlExpression(value) {
  try {
    return serializeSqlExpression(parseSqlExpression(value));
  } catch {
    return fallbackSqlExpression(value);
  }
}

function unwrappedLiteral(value) {
  let tokens = sqlTokens(value);
  while (
    tokens.length >= 3 &&
    tokens[0]?.value === "(" &&
    tokens.at(-1)?.value === ")"
  ) {
    let depth = 0;
    let wrapsAll = true;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].value === "(") depth += 1;
      if (tokens[index].value === ")") depth -= 1;
      if (depth === 0 && index < tokens.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens.length === 1 && tokens[0].kind === "string"
    ? tokens[0].value
    : undefined;
}

function databaseLiteral(value) {
  try {
    return unwrappedLiteral(value);
  } catch {
    return undefined;
  }
}

function normalizeInformationSchemaExpression(value) {
  const raw = String(value).trim();
  // MySQL 8.4 can expose character-set introduced literals from
  // INFORMATION_SCHEMA with their delimiter quotes backslash-escaped, both as
  // a complete default (`_utf8mb4\'[]\'`) and inside CHECK/generated
  // expressions. Convert only complete introduced-literal pairs. The normal
  // tokenizer still validates the surrounding expression and the result is
  // still compared against the full schema contract.
  return raw.replace(
    /(?<![A-Za-z0-9_$])(_[A-Za-z0-9]+)\\'([\s\S]*?)\\'/gu,
    (_match, introducer, payload) => `${introducer}'${payload}'`,
  );
}

function defaultFromSnapshot(column) {
  if (!Object.hasOwn(column, "default")) return null;
  const value = column.default;
  if (typeof value === "boolean") {
    return { kind: "literal", value: value ? "1" : "0" };
  }
  if (typeof value === "number") {
    return { kind: "literal", value: normalizeNumericLiteral(value) };
  }
  if (typeof value !== "string" || !value) {
    throw new Error("DATABASE_SCHEMA_DEFAULT_INVALID");
  }
  const literal = unwrappedLiteral(value);
  if (literal !== undefined) return { kind: "literal", value: literal };
  return { kind: "expression", value: normalizeSqlExpression(value) };
}

function defaultFromDatabase(value, type, extra) {
  if (value === null || value === undefined) return null;
  let raw;
  if (Buffer.isBuffer(value)) {
    raw = value.toString("utf8");
  } else if (value instanceof Uint8Array) {
    raw = Buffer.from(value).toString("utf8");
  } else if (Array.isArray(value) || typeof value === "object") {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  } else {
    raw = String(value);
  }
  const defaultGenerated = /default_generated/iu.test(extra);
  if (defaultGenerated) {
    raw = normalizeInformationSchemaExpression(raw);
  }
  if (type === "json") {
    const literal = databaseLiteral(raw);
    const jsonCandidate = literal === undefined ? raw : literal;
    try {
      return {
        kind: "literal",
        value: JSON.stringify(JSON.parse(jsonCandidate)),
      };
    } catch {
      let expression = raw.trim();
      while (expression.startsWith("(") && expression.endsWith(")")) {
        expression = expression.slice(1, -1).trim();
      }
      const compactExpression = expression.replace(/\s+/gu, "").toLowerCase();
      if (compactExpression === "json_array()") {
        return { kind: "literal", value: "[]" };
      }
      if (compactExpression === "json_object()") {
        return { kind: "literal", value: "{}" };
      }
    }
  }
  const literal = databaseLiteral(raw);
  if (literal !== undefined) return { kind: "literal", value: literal };
  if (defaultGenerated) {
    return { kind: "expression", value: normalizeSqlExpression(raw) };
  }
  if (type === "boolean") {
    if (["1", "true"].includes(raw.trim().toLowerCase())) {
      return { kind: "literal", value: "1" };
    }
    if (["0", "false"].includes(raw.trim().toLowerCase())) {
      return { kind: "literal", value: "0" };
    }
  }
  if (
    /^(?:tinyint|smallint|mediumint|int|bigint|decimal|numeric|float|double)(?:\(|\s|$)/u.test(
      type,
    )
  ) {
    return { kind: "literal", value: normalizeNumericLiteral(raw) };
  }
  if (
    isCharacterType(type) ||
    /^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob)(?:\(|$)/u.test(
      type,
    )
  ) {
    return { kind: "literal", value: raw };
  }
  if (
    /^(?:timestamp|datetime)(?:\(|$)/u.test(type) &&
    /^(?:current_timestamp|now)(?:\(\d*\))?$/iu.test(raw.trim())
  ) {
    return { kind: "expression", value: normalizeSqlExpression(raw) };
  }
  return { kind: "literal", value: raw };
}

export function normalizeDatabaseColumnDefault(value, type, extra = "") {
  return defaultFromDatabase(value, normalizeType(type), String(extra ?? ""));
}

function currentTimestampForType(type) {
  const precision = type.match(/^(?:timestamp|datetime)\((\d+)\)$/u)?.[1];
  return precision
    ? normalizeSqlExpression(`current_timestamp(${precision})`)
    : normalizeSqlExpression("current_timestamp");
}

function onUpdateFromSnapshot(column, type) {
  if (!Object.hasOwn(column, "onUpdate") || column.onUpdate === false) {
    return null;
  }
  if (column.onUpdate === true) return currentTimestampForType(type);
  if (typeof column.onUpdate === "string" && column.onUpdate) {
    return normalizeSqlExpression(column.onUpdate);
  }
  throw new Error("DATABASE_SCHEMA_ON_UPDATE_INVALID");
}

function onUpdateFromDatabase(extra, type) {
  const match = String(extra ?? "").match(
    /on\s+update\s+(current_timestamp(?:\(\d+\))?|now\(\))/iu,
  );
  return match ? normalizeSqlExpression(match[1]) : null;
}

function generatedFromSnapshot(column) {
  if (!Object.hasOwn(column, "generated")) return null;
  const generated = assertObject(
    column.generated,
    "DATABASE_SCHEMA_GENERATED_INVALID",
  );
  if (
    !hasExactKeys(generated, ["as", "type"]) ||
    !["stored", "virtual"].includes(generated.type)
  ) {
    throw new Error("DATABASE_SCHEMA_GENERATED_INVALID");
  }
  return {
    expression: normalizeSqlExpression(generated.as),
    storage: generated.type,
  };
}

function generatedFromDatabase(expression, extra) {
  const raw = normalizeInformationSchemaExpression(expression ?? "");
  if (!raw) return null;
  const normalizedExtra = String(extra ?? "").toLowerCase();
  const storage = normalizedExtra.includes("virtual generated")
    ? "virtual"
    : normalizedExtra.includes("stored generated")
      ? "stored"
      : null;
  if (!storage) throw new Error("DATABASE_SCHEMA_METADATA_INVALID");
  return { expression: normalizeSqlExpression(raw), storage };
}

function expectedTable(tableKey, rawTable) {
  const table = assertObject(
    rawTable,
    `DATABASE_SCHEMA_TABLE_INVALID:${tableKey}`,
  );
  const name = normalizeName(
    table.name,
    `DATABASE_SCHEMA_TABLE_INVALID:${tableKey}`,
  );
  if (name !== tableKey || name === "__drizzle_migrations") {
    throw new Error(`DATABASE_SCHEMA_TABLE_INVALID:${tableKey}`);
  }
  const columns = sortedEntries(
    table.columns,
    `DATABASE_SCHEMA_COLUMNS_INVALID:${name}`,
  ).map(([columnKey, rawColumn]) => {
    const column = assertObject(
      rawColumn,
      `DATABASE_SCHEMA_COLUMN_INVALID:${name}.${columnKey}`,
    );
    const columnName = normalizeName(
      column.name,
      `DATABASE_SCHEMA_COLUMN_INVALID:${name}.${columnKey}`,
    );
    if (
      columnName !== columnKey ||
      typeof column.notNull !== "boolean" ||
      typeof column.autoincrement !== "boolean"
    ) {
      throw new Error(`DATABASE_SCHEMA_COLUMN_INVALID:${name}.${columnKey}`);
    }
    const type = normalizeType(column.type);
    const characterType = isCharacterType(type);
    return {
      name: columnName,
      type,
      nullable: !column.notNull,
      autoIncrement: column.autoincrement,
      default: defaultFromSnapshot(column),
      onUpdate: onUpdateFromSnapshot(column, type),
      generated: generatedFromSnapshot(column),
      characterSet: characterType ? TABLE_DEFAULT : null,
      collation: characterType ? TABLE_DEFAULT : null,
    };
  });
  if (columns.length === 0)
    throw new Error(`DATABASE_SCHEMA_COLUMNS_EMPTY:${name}`);

  const primaryKeys = sortedEntries(
    table.compositePrimaryKeys,
    `DATABASE_SCHEMA_PRIMARY_KEY_INVALID:${name}`,
  );
  if (primaryKeys.length !== 1) {
    throw new Error(`DATABASE_SCHEMA_PRIMARY_KEY_INVALID:${name}`);
  }
  const primaryKey = normalizeColumns(
    assertObject(
      primaryKeys[0][1],
      `DATABASE_SCHEMA_PRIMARY_KEY_INVALID:${name}`,
    ).columns,
    `DATABASE_SCHEMA_PRIMARY_KEY_INVALID:${name}`,
  );

  const indexes = [
    ...sortedEntries(table.indexes, `DATABASE_SCHEMA_INDEX_INVALID:${name}`),
    ...sortedEntries(
      table.uniqueConstraints,
      `DATABASE_SCHEMA_INDEX_INVALID:${name}`,
    ),
  ]
    .map(([indexKey, rawIndex]) => {
      const index = assertObject(
        rawIndex,
        `DATABASE_SCHEMA_INDEX_INVALID:${name}.${indexKey}`,
      );
      const indexName = normalizeName(
        index.name,
        `DATABASE_SCHEMA_INDEX_INVALID:${name}.${indexKey}`,
      );
      if (indexName !== indexKey) {
        throw new Error(`DATABASE_SCHEMA_INDEX_INVALID:${name}.${indexKey}`);
      }
      return {
        name: indexName,
        columns: normalizeColumns(
          index.columns,
          `DATABASE_SCHEMA_INDEX_INVALID:${name}.${indexKey}`,
        ),
        unique: Object.hasOwn(index, "isUnique")
          ? index.isUnique === true
          : true,
        method: normalizeIndexMethod(index.using),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (new Set(indexes.map((index) => index.name)).size !== indexes.length) {
    throw new Error(`DATABASE_SCHEMA_INDEX_DUPLICATE:${name}`);
  }

  const foreignKeys = sortedEntries(
    table.foreignKeys,
    `DATABASE_SCHEMA_FOREIGN_KEY_INVALID:${name}`,
  ).map(([foreignKeyKey, rawForeignKey]) => {
    const foreignKey = assertObject(
      rawForeignKey,
      `DATABASE_SCHEMA_FOREIGN_KEY_INVALID:${name}.${foreignKeyKey}`,
    );
    const foreignKeyName = normalizeName(
      foreignKey.name,
      `DATABASE_SCHEMA_FOREIGN_KEY_INVALID:${name}.${foreignKeyKey}`,
    );
    if (foreignKeyName !== foreignKeyKey || foreignKey.tableFrom !== name) {
      throw new Error(
        `DATABASE_SCHEMA_FOREIGN_KEY_INVALID:${name}.${foreignKeyKey}`,
      );
    }
    return {
      name: foreignKeyName,
      columns: normalizeColumns(
        foreignKey.columnsFrom,
        `DATABASE_SCHEMA_FOREIGN_KEY_INVALID:${name}.${foreignKeyKey}`,
      ),
      referencedTable: normalizeName(
        foreignKey.tableTo,
        `DATABASE_SCHEMA_FOREIGN_KEY_INVALID:${name}.${foreignKeyKey}`,
      ),
      referencedColumns: normalizeColumns(
        foreignKey.columnsTo,
        `DATABASE_SCHEMA_FOREIGN_KEY_INVALID:${name}.${foreignKeyKey}`,
      ),
      onUpdate: normalizeAction(foreignKey.onUpdate),
      onDelete: normalizeAction(foreignKey.onDelete),
    };
  });

  const checks = sortedEntries(
    table.checkConstraint,
    `DATABASE_SCHEMA_CHECK_INVALID:${name}`,
  ).map(([checkKey, rawCheck]) => {
    const check = assertObject(
      rawCheck,
      `DATABASE_SCHEMA_CHECK_INVALID:${name}.${checkKey}`,
    );
    const checkName = normalizeName(
      check.name,
      `DATABASE_SCHEMA_CHECK_INVALID:${name}.${checkKey}`,
    );
    if (checkName !== checkKey) {
      throw new Error(`DATABASE_SCHEMA_CHECK_INVALID:${name}.${checkKey}`);
    }
    return {
      name: checkName,
      expression: normalizeSqlExpression(check.value),
      enforced: true,
    };
  });

  return {
    name,
    engine: "innodb",
    characterSet: SCHEMA_DEFAULT,
    collation: SCHEMA_DEFAULT,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    checks,
  };
}

export function createSchemaContractFromSnapshot(snapshotValue) {
  const snapshot = assertObject(
    snapshotValue,
    "DATABASE_SCHEMA_SNAPSHOT_INVALID",
  );
  if (
    snapshot.dialect !== "mysql" ||
    !["5", 5].includes(snapshot.version) ||
    !snapshot.tables ||
    typeof snapshot.tables !== "object" ||
    Array.isArray(snapshot.tables)
  ) {
    throw new Error("DATABASE_SCHEMA_SNAPSHOT_INVALID");
  }
  const tables = sortedEntries(
    snapshot.tables,
    "DATABASE_SCHEMA_SNAPSHOT_INVALID",
  ).map(([tableName, table]) => expectedTable(tableName, table));
  if (tables.length === 0) throw new Error("DATABASE_SCHEMA_TABLES_EMPTY");
  return { contractVersion: DATABASE_SCHEMA_CONTRACT_VERSION, tables };
}

export function canonicalSchemaContractPayload(contract) {
  return `${JSON.stringify(contract)}\n`;
}

export function schemaContractHash(contract) {
  return sha256(canonicalSchemaContractPayload(contract));
}

function validDefault(value) {
  return (
    value === null ||
    (Boolean(value) &&
      typeof value === "object" &&
      hasExactKeys(value, ["kind", "value"]) &&
      ["literal", "expression"].includes(value.kind) &&
      typeof value.value === "string" &&
      (value.kind === "literal" ||
        normalizeSqlExpression(value.value) === value.value))
  );
}

function validGenerated(value) {
  return (
    value === null ||
    (Boolean(value) &&
      typeof value === "object" &&
      hasExactKeys(value, ["expression", "storage"]) &&
      normalizeSqlExpression(value.expression) === value.expression &&
      ["stored", "virtual"].includes(value.storage))
  );
}

export function parseSchemaContract(value) {
  const contract = assertObject(value, "DATABASE_SCHEMA_CONTRACT_INVALID");
  if (
    !hasExactKeys(contract, ["contractVersion", "tables"]) ||
    contract.contractVersion !== DATABASE_SCHEMA_CONTRACT_VERSION ||
    !Array.isArray(contract.tables) ||
    contract.tables.length === 0
  ) {
    throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
  }
  const tableNames = new Set();
  const columnsByTable = new Map();
  let previousTable = "";
  for (const table of contract.tables) {
    assertObject(table, "DATABASE_SCHEMA_CONTRACT_INVALID");
    const name = normalizeName(table.name, "DATABASE_SCHEMA_CONTRACT_INVALID");
    if (
      name === "__drizzle_migrations" ||
      !hasExactKeys(table, [
        "name",
        "engine",
        "characterSet",
        "collation",
        "columns",
        "primaryKey",
        "indexes",
        "foreignKeys",
        "checks",
      ]) ||
      tableNames.has(name) ||
      (previousTable && previousTable.localeCompare(name, "en") >= 0) ||
      table.engine !== "innodb" ||
      typeof table.characterSet !== "string" ||
      !table.characterSet ||
      typeof table.collation !== "string" ||
      !table.collation ||
      !Array.isArray(table.columns) ||
      table.columns.length === 0 ||
      !Array.isArray(table.primaryKey) ||
      table.primaryKey.length === 0 ||
      !Array.isArray(table.indexes) ||
      !Array.isArray(table.foreignKeys) ||
      !Array.isArray(table.checks)
    ) {
      throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
    }
    tableNames.add(name);
    previousTable = name;
    const columnNames = new Set();
    let previousColumn = "";
    for (const column of table.columns) {
      if (
        !column ||
        typeof column !== "object" ||
        !hasExactKeys(column, [
          "name",
          "type",
          "nullable",
          "autoIncrement",
          "default",
          "onUpdate",
          "generated",
          "characterSet",
          "collation",
        ]) ||
        typeof column.name !== "string" ||
        !column.name ||
        columnNames.has(column.name) ||
        (previousColumn &&
          previousColumn.localeCompare(column.name, "en") >= 0) ||
        normalizeType(column.type) !== column.type ||
        typeof column.nullable !== "boolean" ||
        typeof column.autoIncrement !== "boolean" ||
        !validDefault(column.default) ||
        !validGenerated(column.generated) ||
        !(
          column.onUpdate === null ||
          (typeof column.onUpdate === "string" &&
            normalizeSqlExpression(column.onUpdate) === column.onUpdate)
        ) ||
        (isCharacterType(column.type)
          ? typeof column.characterSet !== "string" ||
            !column.characterSet ||
            typeof column.collation !== "string" ||
            !column.collation
          : column.characterSet !== null || column.collation !== null)
      ) {
        throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
      }
      columnNames.add(column.name);
      previousColumn = column.name;
    }
    columnsByTable.set(name, columnNames);
    const primaryKey = normalizeColumns(
      table.primaryKey,
      "DATABASE_SCHEMA_CONTRACT_INVALID",
    );
    if (
      new Set(primaryKey).size !== primaryKey.length ||
      primaryKey.some((column) => !columnNames.has(column))
    ) {
      throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
    }
    const indexNames = new Set();
    let previousIndex = "";
    for (const index of table.indexes) {
      if (
        !index ||
        typeof index !== "object" ||
        !hasExactKeys(index, ["name", "columns", "unique", "method"]) ||
        !index.name ||
        indexNames.has(index.name) ||
        (previousIndex && previousIndex.localeCompare(index.name, "en") >= 0) ||
        typeof index.unique !== "boolean" ||
        normalizeIndexMethod(index.method) !== index.method
      ) {
        throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
      }
      const indexColumns = normalizeColumns(
        index.columns,
        "DATABASE_SCHEMA_CONTRACT_INVALID",
      );
      if (indexColumns.some((column) => !columnNames.has(column))) {
        throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
      }
      indexNames.add(index.name);
      previousIndex = index.name;
    }
    const foreignKeyNames = new Set();
    let previousForeignKey = "";
    for (const foreignKey of table.foreignKeys) {
      if (
        !foreignKey ||
        typeof foreignKey !== "object" ||
        !hasExactKeys(foreignKey, [
          "name",
          "columns",
          "referencedTable",
          "referencedColumns",
          "onUpdate",
          "onDelete",
        ]) ||
        !foreignKey.name ||
        foreignKeyNames.has(foreignKey.name) ||
        (previousForeignKey &&
          previousForeignKey.localeCompare(foreignKey.name, "en") >= 0) ||
        !foreignKey.referencedTable ||
        normalizeAction(foreignKey.onUpdate) !== foreignKey.onUpdate ||
        normalizeAction(foreignKey.onDelete) !== foreignKey.onDelete
      ) {
        throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
      }
      const foreignKeyColumns = normalizeColumns(
        foreignKey.columns,
        "DATABASE_SCHEMA_CONTRACT_INVALID",
      );
      const referencedColumns = normalizeColumns(
        foreignKey.referencedColumns,
        "DATABASE_SCHEMA_CONTRACT_INVALID",
      );
      if (
        foreignKeyColumns.length !== referencedColumns.length ||
        foreignKeyColumns.some((column) => !columnNames.has(column))
      ) {
        throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
      }
      foreignKeyNames.add(foreignKey.name);
      previousForeignKey = foreignKey.name;
    }
    const checkNames = new Set();
    let previousCheck = "";
    for (const check of table.checks) {
      if (
        !check ||
        typeof check !== "object" ||
        !hasExactKeys(check, ["name", "expression", "enforced"]) ||
        typeof check.name !== "string" ||
        !check.name ||
        checkNames.has(check.name) ||
        (previousCheck && previousCheck.localeCompare(check.name, "en") >= 0) ||
        normalizeSqlExpression(check.expression) !== check.expression ||
        typeof check.enforced !== "boolean"
      ) {
        throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
      }
      checkNames.add(check.name);
      previousCheck = check.name;
    }
  }
  for (const table of contract.tables) {
    for (const foreignKey of table.foreignKeys) {
      const referencedColumns = columnsByTable.get(foreignKey.referencedTable);
      if (
        !referencedColumns ||
        foreignKey.referencedColumns.some(
          (column) => !referencedColumns.has(column),
        )
      ) {
        throw new Error("DATABASE_SCHEMA_CONTRACT_INVALID");
      }
    }
  }
  return value;
}

function resultRows(result) {
  if (!Array.isArray(result)) return [];
  const candidate = Array.isArray(result[0]) ? result[0] : result;
  return candidate.filter(
    (row) => Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

function rowValue(row, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  const normalizedKeys = new Set(
    keys.map((key) => key.replaceAll("_", "").toLowerCase()),
  );
  for (const [key, value] of Object.entries(row)) {
    if (normalizedKeys.has(key.replaceAll("_", "").toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

function groupRows(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = normalizeName(rowValue(row, key, key.toUpperCase()));
    const list = grouped.get(value) ?? [];
    list.push(row);
    grouped.set(value, list);
  }
  return grouped;
}

function sequenceRows(rows, sequenceKeys) {
  return [...rows].sort(
    (left, right) =>
      Number(rowValue(left, ...sequenceKeys)) -
      Number(rowValue(right, ...sequenceKeys)),
  );
}

function actualIndexColumn(row) {
  const columnName = rowValue(row, "columnName", "COLUMN_NAME");
  const expression = rowValue(row, "expression", "EXPRESSION");
  const name = columnName
    ? String(columnName)
    : expression
      ? `(${normalizeSqlExpression(String(expression))})`
      : "";
  if (!name) throw new Error("DATABASE_SCHEMA_METADATA_INVALID");
  const subPart = rowValue(row, "subPart", "SUB_PART");
  return subPart === null || subPart === undefined
    ? name
    : `${name}(${Number(subPart)})`;
}

function isAutomaticForeignKeyIndex(index, foreignKeys, declaredIndexNames) {
  if (
    index.unique ||
    index.method !== "btree" ||
    declaredIndexNames.has(index.name)
  ) {
    return false;
  }
  return foreignKeys.some((foreignKey) => {
    if (JSON.stringify(index.columns) !== JSON.stringify(foreignKey.columns)) {
      return false;
    }
    const firstColumn = foreignKey.columns[0];
    const escapedFirstColumn = firstColumn.replace(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&",
    );
    return (
      index.name === foreignKey.name ||
      index.name === firstColumn ||
      new RegExp(`^${escapedFirstColumn}_[1-9]\\d*$`, "u").test(index.name)
    );
  });
}

function foreignKeySemanticIdentity(foreignKey) {
  return JSON.stringify([
    foreignKey.columns,
    foreignKey.referencedTable,
    foreignKey.referencedColumns,
    foreignKey.onUpdate,
    foreignKey.onDelete,
  ]);
}

function indexSemanticIdentity(index) {
  return JSON.stringify([index.columns, index.unique, index.method]);
}

function hasUniqueIndexSemanticMatch(index, actualIndexes, expectedIndexes) {
  const identity = indexSemanticIdentity(index);
  return (
    actualIndexes.filter(
      (candidate) => indexSemanticIdentity(candidate) === identity,
    ).length === 1 &&
    (expectedIndexes ?? []).filter(
      (candidate) => indexSemanticIdentity(candidate) === identity,
    ).length === 1
  );
}

function normalizeDatabaseIndexNames(indexes, expectedIndexes) {
  return indexes
    .map((index) => {
      if (!hasUniqueIndexSemanticMatch(index, indexes, expectedIndexes)) {
        return index;
      }
      const identity = indexSemanticIdentity(index);
      const expected = expectedIndexes.find(
        (candidate) => indexSemanticIdentity(candidate) === identity,
      );
      return { ...index, name: expected.name };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function normalizeDatabaseForeignKeyNames(foreignKeys, expectedForeignKeys) {
  const expectedBySemantics = new Map();
  for (const foreignKey of expectedForeignKeys ?? []) {
    const identity = foreignKeySemanticIdentity(foreignKey);
    const candidates = expectedBySemantics.get(identity) ?? [];
    candidates.push(foreignKey.name);
    expectedBySemantics.set(identity, candidates);
  }
  return foreignKeys
    .map((foreignKey) => {
      const expectedNames = expectedBySemantics.get(
        foreignKeySemanticIdentity(foreignKey),
      );
      // Constraint names are not relational semantics and several historical
      // migrations intentionally used shorter names than later snapshots.
      // Normalize only a unique full-semantic match; missing, duplicate or
      // action/column/reference drift remains visible in the contract.
      return expectedNames?.length === 1
        ? { ...foreignKey, name: expectedNames[0] }
        : foreignKey;
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export async function inspectDatabaseSchema(database, expectedContract) {
  if (!database || typeof database.query !== "function") {
    throw new Error("DATABASE_SCHEMA_ADAPTER_INVALID");
  }
  if (expectedContract !== undefined) parseSchemaContract(expectedContract);
  const [
    schemaResult,
    tableResult,
    columnResult,
    indexResult,
    foreignKeyResult,
    checkResult,
  ] = await Promise.all([
    database.query(INFORMATION_SCHEMA_QUERIES.schema),
    database.query(INFORMATION_SCHEMA_QUERIES.tables),
    database.query(INFORMATION_SCHEMA_QUERIES.columns),
    database.query(INFORMATION_SCHEMA_QUERIES.indexes),
    database.query(INFORMATION_SCHEMA_QUERIES.foreignKeys),
    database.query(INFORMATION_SCHEMA_QUERIES.checks),
  ]);
  const schemaRows = resultRows(schemaResult);
  if (schemaRows.length !== 1) {
    throw new Error("DATABASE_SCHEMA_METADATA_INVALID");
  }
  const schemaCharacterSet = normalizeName(
    rowValue(schemaRows[0], "schemaCharacterSet", "DEFAULT_CHARACTER_SET_NAME"),
  ).toLowerCase();
  const schemaCollation = normalizeName(
    rowValue(schemaRows[0], "schemaCollation", "DEFAULT_COLLATION_NAME"),
  ).toLowerCase();
  const expectedTables = new Map(
    (expectedContract?.tables ?? []).map((table) => [table.name, table]),
  );
  const tableRows = resultRows(tableResult);
  const columnRows = groupRows(resultRows(columnResult), "tableName");
  const indexRows = groupRows(resultRows(indexResult), "tableName");
  const foreignKeyRows = groupRows(resultRows(foreignKeyResult), "tableName");
  const checkRows = groupRows(resultRows(checkResult), "tableName");

  const tables = tableRows
    .map((tableRow) => {
      const name = normalizeName(rowValue(tableRow, "tableName", "TABLE_NAME"));
      const engine = String(rowValue(tableRow, "engine", "ENGINE") || "")
        .trim()
        .toLowerCase();
      const resolvedTableCharacterSet = normalizeName(
        rowValue(tableRow, "characterSet", "CHARACTER_SET_NAME"),
      ).toLowerCase();
      const resolvedTableCollation = normalizeName(
        rowValue(tableRow, "collation", "TABLE_COLLATION"),
      ).toLowerCase();
      const tableCharacterSet =
        resolvedTableCharacterSet === schemaCharacterSet
          ? SCHEMA_DEFAULT
          : resolvedTableCharacterSet;
      const tableCollation =
        resolvedTableCollation === schemaCollation
          ? SCHEMA_DEFAULT
          : resolvedTableCollation;
      const columns = sequenceRows(columnRows.get(name) ?? [], [
        "ordinalPosition",
        "ORDINAL_POSITION",
      ])
        .map((row) => {
          const type = normalizeType(
            rowValue(row, "columnType", "COLUMN_TYPE"),
          );
          const extra = String(rowValue(row, "extra", "EXTRA") || "");
          const characterSetValue = rowValue(
            row,
            "characterSet",
            "CHARACTER_SET_NAME",
          );
          const collationValue = rowValue(row, "collation", "COLLATION_NAME");
          const resolvedColumnCharacterSet =
            characterSetValue === null || characterSetValue === undefined
              ? null
              : String(characterSetValue).toLowerCase();
          const resolvedColumnCollation =
            collationValue === null || collationValue === undefined
              ? null
              : String(collationValue).toLowerCase();
          return {
            name: normalizeName(rowValue(row, "columnName", "COLUMN_NAME")),
            type,
            nullable:
              String(
                rowValue(row, "isNullable", "IS_NULLABLE"),
              ).toUpperCase() === "YES",
            autoIncrement: extra
              .toLowerCase()
              .split(/\s+/u)
              .includes("auto_increment"),
            default: defaultFromDatabase(
              rowValue(row, "columnDefault", "COLUMN_DEFAULT"),
              type,
              extra,
            ),
            onUpdate: onUpdateFromDatabase(extra, type),
            generated: generatedFromDatabase(
              rowValue(row, "generationExpression", "GENERATION_EXPRESSION"),
              extra,
            ),
            characterSet:
              resolvedColumnCharacterSet === null
                ? null
                : resolvedColumnCharacterSet === resolvedTableCharacterSet
                  ? TABLE_DEFAULT
                  : resolvedColumnCharacterSet,
            collation:
              resolvedColumnCollation === null
                ? null
                : resolvedColumnCollation === resolvedTableCollation
                  ? TABLE_DEFAULT
                  : resolvedColumnCollation,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
      if (columns.length === 0)
        throw new Error("DATABASE_SCHEMA_METADATA_INVALID");

      const rawIndexes = groupRows(indexRows.get(name) ?? [], "indexName");
      const primaryRows = rawIndexes.get("PRIMARY") ?? [];
      if (primaryRows.length === 0) {
        throw new Error("DATABASE_SCHEMA_METADATA_INVALID");
      }
      const primaryKey = sequenceRows(primaryRows, [
        "sequenceInIndex",
        "SEQ_IN_INDEX",
      ]).map(actualIndexColumn);

      const rawForeignKeys = [
        ...groupRows(foreignKeyRows.get(name) ?? [], "constraintName"),
      ]
        .map(([foreignKeyName, rows]) => {
          const ordered = sequenceRows(rows, [
            "ordinalPosition",
            "ORDINAL_POSITION",
          ]);
          const first = ordered[0];
          if (!first) throw new Error("DATABASE_SCHEMA_METADATA_INVALID");
          return {
            name: foreignKeyName,
            columns: ordered.map((row) =>
              normalizeName(rowValue(row, "columnName", "COLUMN_NAME")),
            ),
            referencedTable: normalizeName(
              rowValue(first, "referencedTableName", "REFERENCED_TABLE_NAME"),
            ),
            referencedColumns: ordered.map((row) =>
              normalizeName(
                rowValue(row, "referencedColumnName", "REFERENCED_COLUMN_NAME"),
              ),
            ),
            onUpdate: normalizeAction(
              rowValue(first, "updateRule", "UPDATE_RULE"),
            ),
            onDelete: normalizeAction(
              rowValue(first, "deleteRule", "DELETE_RULE"),
            ),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
      const foreignKeys = normalizeDatabaseForeignKeyNames(
        rawForeignKeys,
        expectedTables.get(name)?.foreignKeys,
      );

      const declaredIndexNames = new Set(
        (expectedTables.get(name)?.indexes ?? []).map((index) => index.name),
      );
      const expectedIndexes = expectedTables.get(name)?.indexes ?? [];
      const actualIndexes = [...rawIndexes]
        .filter(([indexName]) => indexName !== "PRIMARY")
        .map(([indexName, rows]) => {
          const first = rows[0];
          if (!first) throw new Error("DATABASE_SCHEMA_METADATA_INVALID");
          const methods = new Set(
            rows.map((row) =>
              normalizeIndexMethod(rowValue(row, "indexType", "INDEX_TYPE")),
            ),
          );
          if (methods.size !== 1) {
            throw new Error("DATABASE_SCHEMA_METADATA_INVALID");
          }
          return {
            name: indexName,
            columns: sequenceRows(rows, [
              "sequenceInIndex",
              "SEQ_IN_INDEX",
            ]).map(actualIndexColumn),
            unique: Number(rowValue(first, "nonUnique", "NON_UNIQUE")) === 0,
            method: [...methods][0],
          };
        });
      const indexes = normalizeDatabaseIndexNames(
        actualIndexes.filter(
          (index) =>
            hasUniqueIndexSemanticMatch(
              index,
              actualIndexes,
              expectedIndexes,
            ) ||
            !isAutomaticForeignKeyIndex(
              index,
              rawForeignKeys,
              declaredIndexNames,
            ),
        ),
        expectedIndexes,
      ).sort((left, right) => left.name.localeCompare(right.name, "en"));

      const checks = (checkRows.get(name) ?? [])
        .map((row) => ({
          name: normalizeName(
            rowValue(row, "constraintName", "CONSTRAINT_NAME"),
          ),
          expression: normalizeSqlExpression(
            normalizeInformationSchemaExpression(
              rowValue(row, "checkClause", "CHECK_CLAUSE"),
            ),
          ),
          enforced:
            String(rowValue(row, "enforced", "ENFORCED")).toUpperCase() ===
            "YES",
        }))
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
      return {
        name,
        engine,
        characterSet: tableCharacterSet,
        collation: tableCollation,
        columns,
        primaryKey,
        indexes,
        foreignKeys,
        checks,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  return { contractVersion: DATABASE_SCHEMA_CONTRACT_VERSION, tables };
}

function contractDifferences(expected, actual) {
  const differences = [];
  const visit = (left, right, location) => {
    if (differences.length >= 25) return;
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      !left ||
      !right ||
      typeof left !== "object" ||
      typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)
    ) {
      differences.push(location);
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      visit(left[key], right[key], `${location}.${key}`);
    }
  };
  visit(expected, actual, "schema");
  return differences;
}

export async function evaluateDatabaseSchema(database, expectedContract) {
  parseSchemaContract(expectedContract);
  const actualContract = await inspectDatabaseSchema(
    database,
    expectedContract,
  );
  const expectedHash = schemaContractHash(expectedContract);
  const actualHash = schemaContractHash(actualContract);
  const status = expectedHash === actualHash ? "exact" : "diverged";
  return {
    status,
    expectedHash,
    actualHash,
    expectedTableCount: expectedContract.tables.length,
    actualTableCount: actualContract.tables.length,
    differences:
      status === "exact"
        ? []
        : contractDifferences(expectedContract, actualContract),
  };
}
