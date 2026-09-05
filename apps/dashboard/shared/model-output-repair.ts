export const MODEL_OUTPUT_REPAIR_ENV = {
  response_logic: "FRONTMIND_RESPONSE_LOGIC_OUTPUT_REPAIR",
  brand_question_portfolio: "FRONTMIND_BRAND_QUESTION_PORTFOLIO_OUTPUT_REPAIR",
  upload_import: "FRONTMIND_UPLOAD_IMPORT_OUTPUT_REPAIR",
} as const;

export type ModelOutputRepairAdapter = keyof typeof MODEL_OUTPUT_REPAIR_ENV;
export type ModelOutputRepairMode = "shadow" | "active";
type ModelOutputRepairEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ModelOutputRepairRuleCode =
  | "bom_removed"
  | "known_fence_removed"
  | "json_string_unwrapped"
  | "unique_balanced_value_extracted"
  | "unescaped_string_quote_escaped"
  | "trailing_comma_removed"
  | "raw_control_character_escaped"
  | "known_alias_normalized"
  | "lossless_numeric_string_normalized"
  | "known_status_alias_normalized";

export type ModelOutputRepairObservation = {
  adapter: ModelOutputRepairAdapter;
  mode: ModelOutputRepairMode;
  outcome: "candidate_accepted";
  ruleCodes: ModelOutputRepairRuleCode[];
};

export class ModelOutputRepairError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CANDIDATE"
      | "MULTIPLE_CANDIDATES"
      | "DUPLICATE_KEY"
      | "CONFLICTING_ALIAS"
      | "UNSAFE_POLICY",
    message: string,
  ) {
    super(message);
    this.name = "ModelOutputRepairError";
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]!))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(left[key]!, right[key]!),
    )
  );
}

export type StructuredJsonRepairPolicy = {
  maxCharacters?: number;
  fenceLanguages?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  numericKeys?: readonly string[];
  statusKeys?: readonly string[];
  statusAliases?: Readonly<Record<string, string>>;
  identityKeys?: readonly string[];
};

export type RepairedModelOutput<T> = {
  value: T;
  ruleCodes: ModelOutputRepairRuleCode[];
};

export type RepairedStructuredJson = RepairedModelOutput<JsonValue> & {
  normalizedText: string;
};

export const DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS = 1024 * 1024;
export const MAX_MODEL_OUTPUT_REPAIR_CHARACTERS = 2 * 1024 * 1024;
const MAX_REPAIRED_JSON_NESTING_DEPTH = 128;

function runtimeModelOutputRepairEnvironment(): ModelOutputRepairEnvironment {
  return (
    (globalThis as { process?: { env?: ModelOutputRepairEnvironment } }).process
      ?.env ?? {}
  );
}

function uniqueRules(rules: readonly ModelOutputRepairRuleCode[]) {
  return [...new Set(rules)];
}

export function configuredModelOutputRepairMode(
  adapter: ModelOutputRepairAdapter,
  environment: ModelOutputRepairEnvironment = runtimeModelOutputRepairEnvironment(),
): ModelOutputRepairMode {
  return environment[MODEL_OUTPUT_REPAIR_ENV[adapter]]?.trim().toLowerCase() ===
    "active"
    ? "active"
    : "shadow";
}

function reportRepairObservation(observation: ModelOutputRepairObservation) {
  // Deliberately log only stable rule codes. Raw model/customer content and
  // parser errors can contain sensitive data and never belong in this signal.
  console.info("[Model Output Repair]", JSON.stringify(observation));
}

/**
 * Preserve the established parser as the exact fast path. The recovery
 * candidate is evaluated only after that parser rejects the response. Shadow
 * mode reports that the candidate would have worked, then rethrows the exact
 * parser's original error so the current lifecycle remains unchanged.
 */
export function parseWithModelOutputRepair<T>(input: {
  adapter: ModelOutputRepairAdapter;
  raw: string;
  exactParse: (raw: string) => T;
  repairParse: (raw: string) => RepairedModelOutput<T>;
  mode?: ModelOutputRepairMode;
  report?: (observation: ModelOutputRepairObservation) => void;
  maxRepairCharacters?: number;
}): T {
  let exactError: unknown;
  try {
    return input.exactParse(input.raw);
  } catch (error) {
    exactError = error;
  }

  const maxRepairCharacters =
    input.maxRepairCharacters ?? DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS;
  if (
    !Number.isSafeInteger(maxRepairCharacters) ||
    maxRepairCharacters < 0 ||
    input.raw.length > maxRepairCharacters
  ) {
    throw exactError;
  }

  let repaired: RepairedModelOutput<T>;
  try {
    repaired = input.repairParse(input.raw);
  } catch {
    throw exactError;
  }
  if (repaired.ruleCodes.length === 0) throw exactError;

  const mode = input.mode ?? configuredModelOutputRepairMode(input.adapter);
  try {
    (input.report ?? reportRepairObservation)({
      adapter: input.adapter,
      mode,
      outcome: "candidate_accepted",
      ruleCodes: uniqueRules(repaired.ruleCodes),
    });
  } catch {
    // Observation is deliberately non-authoritative. Telemetry must never
    // replace the established parser error or block an otherwise valid repair.
  }
  if (mode !== "active") throw exactError;
  return repaired.value;
}

type JsonPunctuation = "{" | "}" | "[" | "]" | ":" | ",";

type JsonToken =
  | { type: "string"; value: string }
  | { type: "punctuation"; value: JsonPunctuation }
  | { type: "atom"; value: string };

function invalidCandidate(message: string): never {
  throw new ModelOutputRepairError("INVALID_CANDIDATE", message);
}

function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  for (let index = 0; index < text.length; ) {
    const character = text[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if ("{}[]:,".includes(character)) {
      tokens.push({
        type: "punctuation",
        value: character as JsonPunctuation,
      });
      index += 1;
      continue;
    }
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      for (; index < text.length; index += 1) {
        const current = text[index]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current !== '"') continue;
        index += 1;
        const rawString = text.slice(start, index);
        let value: unknown;
        try {
          value = JSON.parse(rawString);
        } catch {
          return invalidCandidate("JSON 字符串转义无效");
        }
        if (typeof value !== "string") {
          return invalidCandidate("JSON 字符串令牌无效");
        }
        tokens.push({ type: "string", value });
        break;
      }
      if (index > text.length || text[index - 1] !== '"') {
        return invalidCandidate("JSON 字符串未闭合");
      }
      continue;
    }
    const start = index;
    while (
      index < text.length &&
      !/\s/.test(text[index]!) &&
      !"{}[]:,".includes(text[index]!)
    ) {
      index += 1;
    }
    if (start === index) return invalidCandidate("JSON 令牌无效");
    tokens.push({ type: "atom", value: text.slice(start, index) });
  }
  return tokens;
}

function assertNoDuplicateJsonKeys(text: string) {
  const tokens = tokenizeJson(text);
  let cursor = 0;

  const punctuation = (value: JsonPunctuation) => {
    const token = tokens[cursor];
    return token?.type === "punctuation" && token.value === value;
  };

  const parseValue = (depth = 0): void => {
    if (depth > MAX_REPAIRED_JSON_NESTING_DEPTH) {
      return invalidCandidate("JSON 嵌套层级过深");
    }
    const token = tokens[cursor];
    if (!token) return invalidCandidate("JSON 值缺失");
    if (token.type === "string" || token.type === "atom") {
      cursor += 1;
      return;
    }
    if (token.value === "[") {
      cursor += 1;
      if (punctuation("]")) {
        cursor += 1;
        return;
      }
      while (cursor < tokens.length) {
        parseValue(depth + 1);
        if (punctuation("]")) {
          cursor += 1;
          return;
        }
        if (!punctuation(",")) return invalidCandidate("JSON 数组分隔无效");
        cursor += 1;
      }
      return invalidCandidate("JSON 数组未闭合");
    }
    if (token.value !== "{") return invalidCandidate("JSON 值无效");
    cursor += 1;
    if (punctuation("}")) {
      cursor += 1;
      return;
    }
    const keys = new Set<string>();
    while (cursor < tokens.length) {
      const key = tokens[cursor];
      if (key?.type !== "string") {
        return invalidCandidate("JSON 对象键必须是字符串");
      }
      if (keys.has(key.value)) {
        throw new ModelOutputRepairError(
          "DUPLICATE_KEY",
          `JSON 对象包含重复键：${key.value}`,
        );
      }
      keys.add(key.value);
      cursor += 1;
      if (!punctuation(":")) return invalidCandidate("JSON 对象缺少冒号");
      cursor += 1;
      parseValue(depth + 1);
      if (punctuation("}")) {
        cursor += 1;
        return;
      }
      if (!punctuation(",")) return invalidCandidate("JSON 对象分隔无效");
      cursor += 1;
    }
    return invalidCandidate("JSON 对象未闭合");
  };

  parseValue();
  if (cursor !== tokens.length) return invalidCandidate("JSON 包含额外值");
}

/** Parse valid JSON while rejecting duplicate object keys before they vanish. */
export function parseExactJson(raw: string): JsonValue {
  const value = JSON.parse(raw) as JsonValue;
  assertNoDuplicateJsonKeys(raw);
  return value;
}

type BalancedRange = { start: number; end: number };

function balancedJsonRanges(text: string): BalancedRange[] {
  const ranges: BalancedRange[] = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (character !== "{" && character !== "[") continue;
      start = index;
      stack.push(character);
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (stack.length >= MAX_REPAIRED_JSON_NESTING_DEPTH) {
        return invalidCandidate("JSON 嵌套层级过深");
      }
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    if (stack.pop() !== expected) {
      stack.length = 0;
      start = -1;
      inString = false;
      escaped = false;
      continue;
    }
    if (stack.length > 0) continue;
    ranges.push({ start, end: index + 1 });
    if (ranges.length >= 2) return ranges;
    start = -1;
  }
  return ranges;
}

function removeLeadingBom(raw: string, rules: ModelOutputRepairRuleCode[]) {
  if (!raw.startsWith("\uFEFF")) return raw;
  rules.push("bom_removed");
  return raw.slice(1);
}

function unwrapKnownFence(
  raw: string,
  allowedLanguages: ReadonlySet<string>,
  rules: ModelOutputRepairRuleCode[],
) {
  const trimmed = raw.trim();
  const match = /^```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n?```[\t ]*$/.exec(trimmed);
  if (!match) return raw;
  const language = match[1]!.trim().toLowerCase();
  if (!allowedLanguages.has(language)) return raw;
  rules.push("known_fence_removed");
  return match[2]!;
}

function normalizeEnvelope(
  raw: string,
  allowedLanguages: ReadonlySet<string>,
  rules: ModelOutputRepairRuleCode[],
) {
  return unwrapKnownFence(
    removeLeadingBom(raw, rules),
    allowedLanguages,
    rules,
  );
}

function unwrapOneJsonString(raw: string, rules: ModelOutputRepairRuleCode[]) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"')) return raw;
  let parsed: unknown;
  try {
    parsed = parseExactJson(trimmed);
  } catch {
    return raw;
  }
  if (typeof parsed !== "string") return raw;
  rules.push("json_string_unwrapped");
  return parsed;
}

function extractUniqueBalancedValue(
  raw: string,
  rules: ModelOutputRepairRuleCode[],
) {
  const trimmed = raw.trim();
  const ranges = balancedJsonRanges(trimmed);
  if (
    ranges.length === 1 &&
    ranges[0]!.start === 0 &&
    ranges[0]!.end === trimmed.length
  ) {
    return trimmed;
  }
  if (ranges.length > 1) {
    throw new ModelOutputRepairError(
      "MULTIPLE_CANDIDATES",
      "输出包含多个完整 JSON 候选",
    );
  }
  if (ranges.length !== 1) return invalidCandidate("没有唯一完整 JSON 候选");
  rules.push("unique_balanced_value_extracted");
  return trimmed.slice(ranges[0]!.start, ranges[0]!.end);
}

function escapeRawStringControlCharacters(
  raw: string,
  rules: ModelOutputRepairRuleCode[],
) {
  let result = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const character of raw) {
    if (!inString) {
      if (character === '"') inString = true;
      result += character;
      continue;
    }
    if (escaped) {
      escaped = false;
      result += character;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      result += character;
      continue;
    }
    if (character === '"') {
      inString = false;
      result += character;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code > 0x1f) {
      result += character;
      continue;
    }
    changed = true;
    if (character === "\b") result += "\\b";
    else if (character === "\t") result += "\\t";
    else if (character === "\n") result += "\\n";
    else if (character === "\f") result += "\\f";
    else if (character === "\r") result += "\\r";
    else result += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  if (inString || escaped) return invalidCandidate("JSON 字符串未闭合");
  if (changed) rules.push("raw_control_character_escaped");
  return result;
}

type JsonContainerContext =
  | { type: "object"; expectsKey: boolean }
  | { type: "array" };

function nextNonWhitespaceIndex(raw: string, start: number) {
  let index = start;
  while (index < raw.length && /\s/u.test(raw[index]!)) index += 1;
  return index;
}

function isJsonValueStart(character: string | undefined) {
  return Boolean(character && '[{"-0123456789tfn'.includes(character));
}

/**
 * Repair the model defect seen in production where a quoted name is inserted
 * into an otherwise valid JSON string without escaping its quote characters.
 *
 * A quote is escaped only when it cannot close the current JSON key/value at
 * that exact grammar position. We do not add missing quotes or brackets and a
 * repaired candidate must still pass the duplicate-key parser plus the
 * caller's strict schema/scope checks.
 */
function escapeUnescapedStringQuotes(
  raw: string,
  rules: ModelOutputRepairRuleCode[],
) {
  let result = "";
  const containers: JsonContainerContext[] = [];
  let inString = false;
  let escaped = false;
  let stringRole: "key" | "value" = "value";
  let changed = false;

  const quoteCanClose = (quoteIndex: number) => {
    const nextIndex = nextNonWhitespaceIndex(raw, quoteIndex + 1);
    const next = raw[nextIndex];
    if (stringRole === "key") return next === ":";

    const container = containers.at(-1);
    if (!container) return nextIndex === raw.length;
    if (container.type === "object") {
      if (next === "}") return true;
      if (next !== ",") return false;
      const afterComma = raw[nextNonWhitespaceIndex(raw, nextIndex + 1)];
      return afterComma === '"' || afterComma === "}";
    }
    if (next === "]") return true;
    if (next !== ",") return false;
    const afterComma = raw[nextNonWhitespaceIndex(raw, nextIndex + 1)];
    return afterComma === "]" || isJsonValueStart(afterComma);
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        result += character;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        result += character;
        continue;
      }
      if (character !== '"') {
        result += character;
        continue;
      }
      if (quoteCanClose(index)) {
        inString = false;
        result += character;
      } else {
        changed = true;
        result += '\\"';
      }
      continue;
    }

    if (character === '"') {
      const container = containers.at(-1);
      stringRole =
        container?.type === "object" && container.expectsKey ? "key" : "value";
      inString = true;
      result += character;
      continue;
    }
    if (character === "{") {
      containers.push({ type: "object", expectsKey: true });
    } else if (character === "[") {
      containers.push({ type: "array" });
    } else if (character === "}" || character === "]") {
      containers.pop();
    } else if (character === ":") {
      const container = containers.at(-1);
      if (container?.type === "object") container.expectsKey = false;
    } else if (character === ",") {
      const container = containers.at(-1);
      if (container?.type === "object") container.expectsKey = true;
    }
    result += character;
  }

  if (inString || escaped) return invalidCandidate("JSON 字符串未闭合");
  if (changed) rules.push("unescaped_string_quote_escaped");
  return result;
}

function removeTrailingCommas(raw: string, rules: ModelOutputRepairRuleCode[]) {
  let result = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character !== ",") {
      result += character;
      continue;
    }
    let lookahead = index + 1;
    while (lookahead < raw.length && /\s/.test(raw[lookahead]!)) {
      lookahead += 1;
    }
    if (raw[lookahead] === "}" || raw[lookahead] === "]") {
      changed = true;
      continue;
    }
    result += character;
  }
  if (changed) rules.push("trailing_comma_removed");
  return result;
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafePolicy(policy: StructuredJsonRepairPolicy) {
  if (
    policy.maxCharacters !== undefined &&
    (!Number.isSafeInteger(policy.maxCharacters) ||
      policy.maxCharacters < 1 ||
      policy.maxCharacters > MAX_MODEL_OUTPUT_REPAIR_CHARACTERS)
  ) {
    throw new ModelOutputRepairError(
      "UNSAFE_POLICY",
      "结构化输出修复字符上限无效",
    );
  }
  const identityKeys = new Set(policy.identityKeys ?? []);
  const aliases = policy.aliases ?? {};
  for (const key of policy.numericKeys ?? []) {
    if (identityKeys.has(key)) {
      throw new ModelOutputRepairError(
        "UNSAFE_POLICY",
        `身份字段不能执行数字转换：${key}`,
      );
    }
  }
  for (const key of policy.statusKeys ?? []) {
    if (identityKeys.has(key)) {
      throw new ModelOutputRepairError(
        "UNSAFE_POLICY",
        `身份字段不能执行状态转换：${key}`,
      );
    }
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (identityKeys.has(alias) !== identityKeys.has(canonical)) {
      throw new ModelOutputRepairError(
        "UNSAFE_POLICY",
        `身份字段 alias 必须保持身份语义：${alias}`,
      );
    }
  }
}

function normalizeKnownAliases(
  value: JsonValue,
  aliases: Readonly<Record<string, string>>,
  rules: ModelOutputRepairRuleCode[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeKnownAliases(item, aliases, rules);
    return;
  }
  if (!isJsonObject(value)) return;
  for (const key of Object.keys(value)) {
    const canonical = aliases[key];
    if (!canonical || canonical === key) continue;
    if (
      Object.prototype.hasOwnProperty.call(value, canonical) &&
      !jsonValuesEqual(value[canonical]!, value[key]!)
    ) {
      throw new ModelOutputRepairError(
        "CONFLICTING_ALIAS",
        `字段 ${key} 与 ${canonical} 冲突`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(value, canonical)) {
      Object.defineProperty(value, canonical, {
        configurable: true,
        enumerable: true,
        value: value[key],
        writable: true,
      });
    }
    delete value[key];
    rules.push("known_alias_normalized");
  }
  for (const item of Object.values(value)) {
    normalizeKnownAliases(item, aliases, rules);
  }
}

function losslessNumber(value: string) {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || String(parsed) !== value) return undefined;
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))
    return undefined;
  return parsed;
}

function normalizeKnownValues(
  value: JsonValue,
  policy: StructuredJsonRepairPolicy,
  rules: ModelOutputRepairRuleCode[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeKnownValues(item, policy, rules);
    return;
  }
  if (!isJsonObject(value)) return;
  const numericKeys = new Set(policy.numericKeys ?? []);
  const statusKeys = new Set(policy.statusKeys ?? []);
  const statusAliases = policy.statusAliases ?? {};
  for (const key of Object.keys(value)) {
    const current = value[key];
    if (numericKeys.has(key) && typeof current === "string") {
      const parsed = losslessNumber(current);
      if (parsed !== undefined) {
        value[key] = parsed;
        rules.push("lossless_numeric_string_normalized");
      }
    } else if (statusKeys.has(key) && typeof current === "string") {
      const normalized = current
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
      const canonical = statusAliases[normalized];
      if (canonical !== undefined && canonical !== current) {
        value[key] = canonical;
        rules.push("known_status_alias_normalized");
      }
    }
    normalizeKnownValues(value[key]!, policy, rules);
  }
}

/**
 * Produce one deterministic JSON candidate. This function repairs transport
 * syntax only; callers must still run their existing strict/domain validator.
 */
export function repairStructuredJsonCandidate(
  raw: string,
  policy: StructuredJsonRepairPolicy = {},
): RepairedStructuredJson {
  if (
    raw.length >
    (policy.maxCharacters ?? DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS)
  ) {
    return invalidCandidate("结构化输出超过安全修复上限");
  }
  assertSafePolicy(policy);
  const rules: ModelOutputRepairRuleCode[] = [];
  const fenceLanguages = new Set(
    (policy.fenceLanguages ?? ["", "json"]).map((value) =>
      value.trim().toLowerCase(),
    ),
  );
  let candidate = normalizeEnvelope(raw, fenceLanguages, rules);
  candidate = unwrapOneJsonString(candidate, rules);
  candidate = normalizeEnvelope(candidate, fenceLanguages, rules);
  candidate = extractUniqueBalancedValue(candidate, rules);
  candidate = escapeUnescapedStringQuotes(candidate, rules);
  candidate = escapeRawStringControlCharacters(candidate, rules);
  candidate = removeTrailingCommas(candidate, rules);
  const value = parseExactJson(candidate);
  if (value === null || typeof value !== "object") {
    return invalidCandidate("结构化输出必须是 JSON 对象或数组");
  }
  normalizeKnownAliases(value, policy.aliases ?? {}, rules);
  normalizeKnownValues(value, policy, rules);
  return {
    value,
    normalizedText: JSON.stringify(value),
    ruleCodes: uniqueRules(rules),
  };
}

/** Repair only a known whole-message text fence/BOM, never its content. */
export function repairKnownTextEnvelope(
  raw: string,
  fenceLanguages: readonly string[],
): RepairedModelOutput<string> {
  if (raw.length > DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS) {
    return invalidCandidate("文本输出超过安全修复上限");
  }
  const rules: ModelOutputRepairRuleCode[] = [];
  const languages = new Set(
    fenceLanguages.map((value) => value.trim().toLowerCase()),
  );
  const value = normalizeEnvelope(raw, languages, rules).trim();
  if (rules.length === 0) return invalidCandidate("没有可证明的文本封装修复");
  return { value, ruleCodes: uniqueRules(rules) };
}

const UPLOAD_IMPORT_REPAIR_POLICY: StructuredJsonRepairPolicy = {
  fenceLanguages: ["", "json"],
  numericKeys: ["schemaVersion", "revision", "expectedRevision"],
  identityKeys: [
    "id",
    "taskId",
    "task_id",
    "fileId",
    "file_id",
    "outputItemId",
    "output_item_id",
    "tenantId",
    "tenant_id",
    "turnId",
    "turn_id",
  ],
};

/**
 * Boundary used by uploaded JSON modules. In shadow mode its observable
 * behavior is still the historical native JSON parser.
 */
export function parseUploadedJsonWithRepair(
  raw: string,
  options: {
    mode?: ModelOutputRepairMode;
    report?: (observation: ModelOutputRepairObservation) => void;
  } = {},
): JsonValue {
  return parseWithModelOutputRepair({
    adapter: "upload_import",
    raw,
    // Preserve the historical upload fast path. Duplicate-key rejection is a
    // repair-candidate rule; already valid uploads still use native JSON.parse.
    exactParse: (candidate) => JSON.parse(candidate) as JsonValue,
    repairParse: (candidate) =>
      repairStructuredJsonCandidate(candidate, UPLOAD_IMPORT_REPAIR_POLICY),
    mode: options.mode,
    report: options.report,
  });
}
