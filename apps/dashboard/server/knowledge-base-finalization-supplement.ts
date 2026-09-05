import { createHash } from "node:crypto";

import { z } from "zod";

import {
  parseExactJson,
  repairStructuredJsonCandidate,
} from "./model-output-repair";

const supplementRecordSchema = z
  .object({
    kind: z.enum(["overview", "evidence", "report", "index"]),
    id: z.string().trim().min(1).max(191),
    title: z.string().trim().min(1).max(512),
    branchId: z.string().trim().min(1).max(191),
    order: z.number().int().nonnegative().max(10_000).optional(),
    sourceIds: z.array(z.string().trim().min(1).max(191)).max(500).default([]),
    assetIds: z.array(z.string().trim().min(1).max(191)).max(500).default([]),
    bodyMarkdown: z.string().trim().min(1).max(10_000_000),
  })
  .strict();

export const MAX_FINALIZATION_SUPPLEMENT_CHARACTERS = 16 * 1024 * 1024;
const MAX_FINALIZATION_SUPPLEMENT_JSON_DEPTH = 64;

export type FinalizationSupplementRecord = z.infer<
  typeof supplementRecordSchema
>;

function scanJsonValue(text: string, start: number, depth = 0): number {
  if (depth > MAX_FINALIZATION_SUPPLEMENT_JSON_DEPTH) {
    throw new Error("FINALIZATION_SUPPLEMENT_JSON_DEPTH_LIMIT");
  }
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  if (text[index] === '"') {
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') return index + 1;
      index += 1;
    }
    throw new Error("FINALIZATION_SUPPLEMENT_JSON_UNCLOSED_STRING");
  }
  if (text[index] === "[") {
    index += 1;
    while (true) {
      while (/\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] === "]") return index + 1;
      index = scanJsonValue(text, index, depth + 1);
      while (/\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",")
        throw new Error("FINALIZATION_SUPPLEMENT_JSON_INVALID");
      index += 1;
    }
  }
  if (text[index] === "{") {
    const keys = new Set<string>();
    index += 1;
    while (true) {
      while (/\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] === "}") return index + 1;
      if (text[index] !== '"')
        throw new Error("FINALIZATION_SUPPLEMENT_JSON_INVALID");
      const keyStart = index;
      index = scanJsonValue(text, index);
      const key = parseExactJson(text.slice(keyStart, index)) as string;
      if (keys.has(key))
        throw new Error(`FINALIZATION_SUPPLEMENT_DUPLICATE_KEY:${key}`);
      keys.add(key);
      while (/\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] !== ":")
        throw new Error("FINALIZATION_SUPPLEMENT_JSON_INVALID");
      index = scanJsonValue(text, index + 1, depth + 1);
      while (/\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",")
        throw new Error("FINALIZATION_SUPPLEMENT_JSON_INVALID");
      index += 1;
    }
  }
  while (index < text.length && !/[\s,}\]]/u.test(text[index]!)) index += 1;
  return index;
}

function assertOneBoundedJsonValue(line: string) {
  const end = scanJsonValue(line, 0);
  if (line.slice(end).trim()) {
    throw new Error("FINALIZATION_SUPPLEMENT_JSON_TRAILING_DATA");
  }
}

function parseStrictJsonLine(line: string) {
  try {
    assertOneBoundedJsonValue(line);
    return parseExactJson(line) as unknown;
  } catch (exactError) {
    try {
      const repaired = repairStructuredJsonCandidate(line, {
        fenceLanguages: ["", "json"],
        // These values are checked again against the package projection. No
        // syntax repair may normalize, alias or coerce their identity.
        identityKeys: ["kind", "id", "branchId", "sourceIds", "assetIds"],
      });
      assertOneBoundedJsonValue(repaired.normalizedText);
      return repaired.value;
    } catch {
      throw exactError;
    }
  }
}

function stableRecord(record: FinalizationSupplementRecord) {
  return {
    ...record,
    sourceIds: [...new Set(record.sourceIds)].sort(),
    assetIds: [...new Set(record.assetIds)].sort(),
  };
}

export function parseFinalizationSupplementNdjson(text: string) {
  if (text.length > MAX_FINALIZATION_SUPPLEMENT_CHARACTERS) {
    throw new Error("FINALIZATION_SUPPLEMENT_SIZE_LIMIT");
  }
  const lines = text
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 1 || lines.length > 1_000) {
    throw new Error("FINALIZATION_SUPPLEMENT_RECORD_COUNT_INVALID");
  }
  const records = lines.map((line, index) => {
    try {
      return stableRecord(
        supplementRecordSchema.parse(parseStrictJsonLine(line)),
      );
    } catch (error) {
      throw new Error(
        `FINALIZATION_SUPPLEMENT_RECORD_INVALID:${index + 1}:${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
  });
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error("FINALIZATION_SUPPLEMENT_ID_DUPLICATED");
  }
  const ordered = [...records].sort(
    (left, right) =>
      (left.order ?? 10_000) - (right.order ?? 10_000) ||
      left.id.localeCompare(right.id),
  );
  return {
    records: ordered,
    semanticFingerprint: createHash("sha256")
      .update(JSON.stringify(ordered), "utf8")
      .digest("hex"),
  };
}

export function finalizationSupplementCoverage(
  records: readonly FinalizationSupplementRecord[],
) {
  const present = new Set(records.map((record) => record.kind));
  const required = ["overview", "evidence", "report", "index"] as const;
  return {
    complete: required.every((kind) => present.has(kind)),
    missingKinds: required.filter((kind) => !present.has(kind)),
  };
}
