import {
  parseExactJson,
  repairStructuredJsonCandidate,
} from "./model-output-repair";

const KNOWLEDGE_BASE_REFERENCE_APPENDIX_HEADER =
  /(?:^|\r?\n)[\t ]*(?:#{1,6}[\t ]*)?(?:\*\*|__)?(?:参考资料|参考来源|引用来源|references?|sources?)(?:\*\*|__)?[\t ]*(?:(?:[:：])[\t ]*[^\r\n]*)?[\t ]*(?=\r?$)/im;

const KNOWLEDGE_BASE_PROTOCOL_COMMENT =
  /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN|PRESENTATION)\b[\s\S]*?(?:-->|$)/gi;
const LEGACY_SOCRATIC_KNOWLEDGE_STATE_COMMENT =
  /<!--\s*SOCRATIC_KB_STATE\b[\s\S]*?(?:SOCRATIC_KB_STATE\s*-->|-->|$)/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKnowledgeBaseProtocolKind(value: unknown) {
  return (
    typeof value === "string" &&
    (value.startsWith("frontmind.knowledge-base.") ||
      value === "frontmind.workflow-state")
  );
}

interface KnowledgeBaseProtocolObjectMatch {
  start: number;
  end: number;
  value: Record<string, unknown>;
}

const MAX_KNOWLEDGE_BASE_PROTOCOL_OUTPUT_CHARACTERS = 2 * 1024 * 1024;
const MAX_KNOWLEDGE_BASE_PROTOCOL_OUTPUT_OBJECTS = 16;

function parseKnowledgeBaseProtocolObjectCandidate(raw: string) {
  let value: unknown;
  try {
    value = parseExactJson(raw);
  } catch {
    value = repairStructuredJsonCandidate(raw, {
      fenceLanguages: ["", "json"],
      identityKeys: ["operationId", "turnId"],
    }).value;
  }
  return isRecord(value) && isKnowledgeBaseProtocolKind(value.kind)
    ? value
    : null;
}

function findKnowledgeBaseProtocolObjectMatches(
  text: string,
): KnowledgeBaseProtocolObjectMatch[] {
  if (text.length > MAX_KNOWLEDGE_BASE_PROTOCOL_OUTPUT_CHARACTERS) return [];
  const matches: KnowledgeBaseProtocolObjectMatch[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") {
        depth += 1;
        continue;
      }
      if (character !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;

      try {
        const value = parseKnowledgeBaseProtocolObjectCandidate(
          text.slice(start, index + 1),
        );
        if (value) {
          matches.push({ start, end: index + 1, value });
          if (matches.length > MAX_KNOWLEDGE_BASE_PROTOCOL_OUTPUT_OBJECTS) {
            return [];
          }
        }
        // A successfully parsed object cannot contain a separate top-level
        // protocol object, so skip all of its nested braces.
        start = index;
      } catch {
        // Keep scanning later opening braces. This lets a valid protocol object
        // be recovered even when earlier prose contains an unmatched brace.
      }
      break;
    }
  }
  return matches;
}

/**
 * Extract protocol objects that the upstream model emitted as bare JSON.
 * The authoritative parsers still validate each object's exact schema.
 */
export function extractKnowledgeBaseProtocolObjects(
  text: string,
): Record<string, unknown>[] {
  return findKnowledgeBaseProtocolObjectMatches(String(text || "")).map(
    (match) => match.value,
  );
}

/**
 * Hide both documented HTML-comment envelopes and the bare-JSON variant seen
 * in real upstream task output.
 */
export function stripKnowledgeBaseProtocolPayloads(text: string): string {
  const withoutComments = String(text || "")
    .replace(KNOWLEDGE_BASE_PROTOCOL_COMMENT, "")
    .replace(LEGACY_SOCRATIC_KNOWLEDGE_STATE_COMMENT, "");
  const matches = findKnowledgeBaseProtocolObjectMatches(withoutComments);
  if (matches.length === 0) return withoutComments;

  let cursor = 0;
  let visible = "";
  for (const match of matches) {
    visible += withoutComments.slice(cursor, match.start);
    cursor = match.end;
  }
  return (visible + withoutComments.slice(cursor)).replace(
    /```(?:json)?[\t ]*\r?\n[\t ]*```/gi,
    "",
  );
}

/**
 * Keep only the customer-facing node body. Source appendices remain available
 * to the service through the raw model output and dedicated audit fields.
 */
export function stripKnowledgeBaseReferenceAppendix(text: string): string {
  const normalized = String(text || "");
  const match = KNOWLEDGE_BASE_REFERENCE_APPENDIX_HEADER.exec(normalized);
  return (match ? normalized.slice(0, match.index) : normalized).trim();
}
