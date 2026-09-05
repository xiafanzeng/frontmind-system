import { createHash } from "node:crypto";

import { SITEOPS_CONTENT_PLAN_V2_FILENAME } from "../../shared/siteops-content-plan";
import {
  classifyManusV2StructuredResultEnvelope,
  manusV2EventOperationToken,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "../manus-v2-client";
import { fetchPinnedPublicHttps } from "./remote-preview";

const WIRE_OUTPUT_TIMEOUT_MS = 15_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const SITEOPS_WIRE_OUTPUT_FILES = Object.freeze({
  design: "frontmind-site-design-wire-v2.json",
  designV3: "frontmind-site-design-wire-v3.json",
  contentPlanV2: SITEOPS_CONTENT_PLAN_V2_FILENAME,
  content: "frontmind-page-content-wire-v2.json",
  contentV3: "frontmind-page-content-wire-v3.json",
  contentDraftV1: "frontmind-site-content-draft-v1.json",
  contentPatchV1: "frontmind-site-content-patch-v1.json",
  sourceReceiptV1: "frontmind-site-source-receipt-v1.json",
});

const SITEOPS_WIRE_OUTPUT_MAX_BYTES = Object.freeze({
  design: 256 * 1024,
  content: 2 * 1024 * 1024,
  contentPlanV2: 16 * 1024 * 1024,
});

export type SiteOpsWireOutputPhase = "design" | "content";

type JsonObject = Record<string, unknown>;

type FetchPinnedPublicHttps = typeof fetchPinnedPublicHttps;

export class SiteOpsWireOutputResolutionError extends Error {
  constructor(
    readonly code:
      | "SITEOPS_WIRE_OUTPUT_INVALID"
      | "SITEOPS_WIRE_OUTPUT_CONFLICT"
      | "SITEOPS_WIRE_OUTPUT_FALLBACK_REQUIRED"
      | "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    readonly validationError?: unknown,
    readonly validationCandidate?: Pick<
      SiteOpsWireOutputResolution,
      "sha256" | "source"
    >,
  ) {
    super(code);
  }
}

export type SiteOpsWireOutputResolution = {
  value: JsonObject;
  sha256: string;
  byteCount: number;
  source: "structured" | "attachment" | "assistant_json";
  sources: Array<"structured" | "attachment" | "assistant_json">;
  normalizations: Array<
    "bom" | "json_fence" | "double_encoded" | "json_repair"
  >;
};

type JsonNormalization = SiteOpsWireOutputResolution["normalizations"][number];

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }
  if (!isRecord(value)) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`)
    .join(",")}}`;
}

function byteLengthWithin(value: string, maxBytes: number) {
  return Buffer.byteLength(value, "utf8") <= maxBytes;
}

function stripOneJsonEnvelope(
  input: string,
  normalizations: JsonNormalization[],
) {
  let text = input;
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
    normalizations.push("bom");
  }
  text = text.trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/iu.exec(text);
  if (fence) {
    normalizations.push("json_fence");
    return fence[1]!.trim();
  }
  // A fence is an envelope only when it contains the entire response. Never
  // search prose for a plausible object because that would blur the causal
  // boundary between provider instructions and provider data.
  if (text.includes("```")) return null;
  return text;
}

/**
 * Repair only a deliberately small, linear-time subset of common transport
 * damage. This is not JSON5 and never evaluates expressions. The caller still
 * performs JSON.parse, operation-token validation and the strict business
 * schema after repair.
 */
function repairJsonText(input: string) {
  let text = "";
  let inString = false;
  let escaped = false;
  const closers: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (inString) {
      if (escaped) {
        if ('"\\/bfnrt'.includes(character)) {
          text += `\\${character}`;
        } else if (
          character === "u" &&
          /^[a-f0-9]{4}$/iu.test(input.slice(index + 1, index + 5))
        ) {
          text += `\\u${input.slice(index + 1, index + 5)}`;
          index += 4;
        } else {
          // Preserve an unknown escape as literal text rather than assigning
          // it a new JSON meaning.
          text += `\\\\${character}`;
        }
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = false;
        text += character;
        continue;
      }
      const code = character.charCodeAt(0);
      if (code <= 0x1f) {
        text += `\\u${code.toString(16).padStart(4, "0")}`;
      } else {
        text += character;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      text += character;
      continue;
    }
    if (character === "{" || character === "[") {
      closers.push(character === "{" ? "}" : "]");
      text += character;
      continue;
    }
    if (character === "}" || character === "]") {
      if (closers.at(-1) !== character) return null;
      closers.pop();
      text += character;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code <= 0x1f && !/[\t\n\r ]/u.test(character)) continue;
    text += character;
  }
  if (escaped) text += "\\\\";
  if (inString) text += '"';
  text += closers.reverse().join("");

  // Remove trailing commas without touching string contents.
  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      withoutTrailingCommas += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      withoutTrailingCommas += character;
      continue;
    }
    if (character === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
      if (text[cursor] === "}" || text[cursor] === "]") continue;
    }
    withoutTrailingCommas += character;
  }

  // Quote only ASCII bare object keys in an object-member coordinate. Values,
  // comments, functions and arbitrary JSON5 syntax remain unsupported.
  let quotedKeys = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutTrailingCommas.length; index += 1) {
    const character = withoutTrailingCommas[index]!;
    if (inString) {
      quotedKeys += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      quotedKeys += character;
      continue;
    }
    quotedKeys += character;
    if (character !== "{" && character !== ",") continue;
    let cursor = index + 1;
    let whitespace = "";
    while (
      cursor < withoutTrailingCommas.length &&
      /\s/u.test(withoutTrailingCommas[cursor]!)
    ) {
      whitespace += withoutTrailingCommas[cursor]!;
      cursor += 1;
    }
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/u.exec(
      withoutTrailingCommas.slice(cursor),
    );
    if (!keyMatch) continue;
    quotedKeys += `${whitespace}${JSON.stringify(keyMatch[1])}${keyMatch[2]}`;
    index = cursor + keyMatch[0].length - 1;
  }
  return quotedKeys;
}

function parseJsonText(input: string, maxBytes: number) {
  const normalizations: JsonNormalization[] = [];
  if (!byteLengthWithin(input, maxBytes)) return null;
  let text = stripOneJsonEnvelope(input, normalizations);
  if (text === null || !byteLengthWithin(text, maxBytes)) return null;
  let repaired = false;
  const parseLayer = (layer: string) => {
    try {
      return { ok: true as const, value: JSON.parse(layer) as unknown };
    } catch {
      if (repaired) return { ok: false as const };
      const candidate = repairJsonText(layer);
      if (candidate === null || candidate === layer)
        return { ok: false as const };
      try {
        const value = JSON.parse(candidate) as unknown;
        repaired = true;
        normalizations.push("json_repair");
        return { ok: true as const, value };
      } catch {
        return { ok: false as const };
      }
    }
  };
  let parsed = parseLayer(text);
  if (!parsed.ok) return null;
  if (typeof parsed.value === "string") {
    normalizations.push("double_encoded");
    text = parsed.value;
    if (!byteLengthWithin(text, maxBytes)) return null;
    const decoded = parseLayer(text);
    if (!decoded.ok || typeof decoded.value === "string") return null;
    parsed = decoded;
  }
  return { value: parsed.value, normalizations };
}

function candidate(value: unknown, operationToken: string, maxBytes: number) {
  const decoded =
    typeof value === "string"
      ? parseJsonText(value, maxBytes)
      : { value, normalizations: [] as JsonNormalization[] };
  if (!decoded) return null;
  const parsed = decoded.value;
  if (!isRecord(parsed) || parsed.operationToken !== operationToken)
    return null;
  const canonical = canonicalJsonValue(parsed);
  if (Buffer.byteLength(canonical, "utf8") > maxBytes) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const semanticCandidate = { ...parsed };
  delete semanticCandidate.operationToken;
  return {
    value: parsed,
    // The operation token is a causal boundary, not model content. Excluding
    // it keeps the validation coordinate stable across repair attempts so an
    // otherwise identical invalid payload cannot consume the next budget.
    sha256: createHash("sha256")
      .update(canonicalJsonValue(semanticCandidate), "utf8")
      .digest("hex"),
    byteCount: Buffer.byteLength(canonical, "utf8"),
    normalizations: decoded.normalizations,
  };
}

function assertOneCandidate(
  values: ReadonlyArray<SiteOpsWireOutputResolution>,
  conflictCode:
    | "SITEOPS_WIRE_OUTPUT_CONFLICT"
    | "SITEOPS_WIRE_OUTPUT_FALLBACK_REQUIRED",
) {
  if (values.length === 0) return null;
  if (new Set(values.map((value) => value.sha256)).size !== 1) {
    throw new SiteOpsWireOutputResolutionError(conflictCode);
  }
  const sourceOrder = ["structured", "assistant_json", "attachment"] as const;
  const sources = sourceOrder.filter((source) =>
    values.some((value) => value.source === source),
  );
  const selected = values.find((value) => value.source === sources[0])!;
  const normalizations = [
    ...new Set(values.flatMap((value) => value.normalizations)),
  ];
  return { ...selected, sources, normalizations };
}

function currentOperationWindow(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
) {
  const ordered = orderManusV2EventsByProviderRank(events, "oldest_first");
  let start = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) === operationToken) {
      start = index;
    }
  }
  if (start < 0) return null;
  let end = ordered.length;
  for (let index = start + 1; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) !== null) {
      end = index;
      break;
    }
  }
  return ordered.slice(start + 1, end);
}

function assistantMessage(event: ManusV2MessageEvent) {
  if (
    event.type !== "assistant_message" ||
    !isRecord(event.assistant_message)
  ) {
    return null;
  }
  return event.assistant_message;
}

function assistantJsonBody(message: JsonObject) {
  if (isRecord(message.content)) return message.content;
  if (typeof message.content !== "string") return null;
  const text = message.content.trim();
  if (!text) return null;
  const withoutBom = text.startsWith("\uFEFF")
    ? text.slice(1).trimStart()
    : text;
  if (withoutBom.includes("```")) {
    return /^```json[ \t]*\r?\n[\s\S]*\r?\n```[ \t]*$/iu.test(withoutBom)
      ? message.content
      : null;
  }
  // Keep ordinary assistant prose out of the candidate set. Objects and one
  // stringified object are the only non-fenced forms the bounded decoder can
  // accept.
  return withoutBom.startsWith("{") || withoutBom.startsWith('"')
    ? message.content
    : null;
}

function optionalString(record: JsonObject, aliases: readonly string[]) {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

type JsonAttachment = {
  url: string;
  expectedSha256: string | null;
};

function jsonAttachments(
  message: JsonObject,
  phase: SiteOpsWireOutputPhase,
  expectedFilename: string,
): { attachments: JsonAttachment[]; invalid: boolean } {
  const raw = [
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    ...(Array.isArray(message.content) ? message.content : []),
  ];
  const attachments: JsonAttachment[] = [];
  let invalid = false;
  const expectedWireVersion = expectedFilename.match(
    /[-_]wire[-_]v([23])\.json$/u,
  )?.[1];
  const contentDraftV1 =
    phase === "content" &&
    expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.contentDraftV1;
  const contentPatchV1 =
    phase === "content" &&
    expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.contentPatchV1;
  const sourceReceiptV1 =
    phase === "design" &&
    expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.sourceReceiptV1;
  const contentPlanV2 =
    phase === "design" &&
    expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2;
  if (
    !expectedWireVersion &&
    !contentDraftV1 &&
    !contentPatchV1 &&
    !sourceReceiptV1 &&
    !contentPlanV2
  ) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const phaseStem = contentPlanV2
    ? "frontmind[-_]site[-_]content[-_]plan[-_]v2"
    : sourceReceiptV1
      ? "frontmind[-_]site[-_]source[-_]receipt[-_]v1"
      : contentPatchV1
        ? "frontmind[-_]site[-_]content[-_]patch[-_]v1"
        : contentDraftV1
          ? "frontmind[-_]site[-_]content[-_]draft[-_]v1"
          : phase === "design"
            ? `frontmind[-_]site[-_]design[-_]wire[-_]v${expectedWireVersion}`
            : `frontmind[-_]page[-_]content[-_]wire[-_]v${expectedWireVersion}`;
  const providerFilenamePattern = new RegExp(
    `^${phaseStem}(?:[-_]repair[-_][1-3])?\\.json$`,
    "u",
  );
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const url = optionalString(value, ["url", "file_url", "fileUrl"]);
    if (!url) continue;
    const filename = optionalString(value, [
      "filename",
      "file_name",
      "fileName",
    ]);
    const declaredMime = optionalString(value, [
      "content_type",
      "mime_type",
      "mimeType",
    ]);
    // A signed URL alone is not a durable output identity. A phase-owned
    // filename is mandatory; `file_id` remains optional. Manus may
    // deterministically normalize hyphens to underscores and append a repair
    // ordinal, so accept that narrow provider form without accepting an
    // arbitrary JSON attachment. The operation token and local wire schema
    // remain the business authority.
    if (!filename) continue;
    if (
      filename !== filename.normalize("NFKC") ||
      filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/u.test(filename)
    ) {
      invalid = true;
      continue;
    }
    if (
      filename !== expectedFilename &&
      !providerFilenamePattern.test(filename)
    )
      continue;
    const mime = declaredMime?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    if (mime !== null && mime !== "application/json") {
      invalid = true;
      continue;
    }
    const declaredHash = optionalString(value, [
      "sha256",
      "content_sha256",
      "contentSha256",
    ]);
    if (declaredHash !== null && !SHA256_PATTERN.test(declaredHash)) {
      invalid = true;
      continue;
    }
    attachments.push({ url, expectedSha256: declaredHash });
  }
  return { attachments, invalid };
}

async function readBoundedJsonResponse(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const mime = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mime !== "application/json") {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const declaredHeader = response.headers.get("content-length");
  const declared =
    declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (
    Number.isFinite(declared) &&
    (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes)
  ) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        throw new SiteOpsWireOutputResolutionError(
          "SITEOPS_WIRE_OUTPUT_INVALID",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (bytes < 1) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const buffer = Buffer.concat(
    chunks.map((part) => Buffer.from(part)),
    bytes,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  return {
    value: text,
    rawSha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

async function downloadAttachment(input: {
  attachment: JsonAttachment;
  maxBytes: number;
  signal?: AbortSignal;
  fetchPinned: FetchPinnedPublicHttps;
}) {
  const timeout = AbortSignal.timeout(WIRE_OUTPUT_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  let response: Response;
  try {
    ({ response } = await input.fetchPinned({
      url: input.attachment.url,
      signal,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "FrontMind-SiteOps-Wire/1.0",
      },
      maxRedirects: 3,
    }));
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const code = error instanceof Error ? error.message : "";
    if (
      /^(?:PREVIEW_URL_|PREVIEW_REDIRECT_|PREVIEW_CONNECTED_ADDRESS_UNSAFE)/u.test(
        code,
      )
    ) {
      throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
    }
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    );
  }
  if ([408, 425, 429].includes(response.status) || response.status >= 500) {
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    );
  }
  const downloaded = await readBoundedJsonResponse(response, input.maxBytes);
  if (
    input.attachment.expectedSha256 !== null &&
    downloaded.rawSha256 !== input.attachment.expectedSha256
  ) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  return downloaded.value;
}

/**
 * Resolve one task phase without weakening the internal Zod contract.
 * Every valid source in the exact operation-token window participates in one
 * canonical decision. Identical candidates merge; distinct valid candidates
 * fail closed. A malformed or unavailable source cannot hide a valid sibling.
 */
export async function resolveSiteOpsWireOutput(input: {
  events: readonly ManusV2MessageEvent[];
  operationToken: string;
  phase: SiteOpsWireOutputPhase;
  expectedFilename: string;
  taskCompleted: boolean;
  /** Explicit safe-data paths only: a token-bound Native receipt, content
   * plan or content patch may enter local validation before Manus stops. */
  acceptCurrentPhaseWhileRunning?: boolean;
  signal?: AbortSignal;
  fetchPinned?: FetchPinnedPublicHttps;
  validateCandidate?: (
    value: JsonObject,
    source: SiteOpsWireOutputResolution["source"],
  ) => void;
}): Promise<SiteOpsWireOutputResolution | null> {
  const allowedFilenames: readonly string[] =
    input.phase === "design"
      ? [
          SITEOPS_WIRE_OUTPUT_FILES.design,
          SITEOPS_WIRE_OUTPUT_FILES.designV3,
          SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2,
          SITEOPS_WIRE_OUTPUT_FILES.sourceReceiptV1,
        ]
      : [
          SITEOPS_WIRE_OUTPUT_FILES.content,
          SITEOPS_WIRE_OUTPUT_FILES.contentV3,
          SITEOPS_WIRE_OUTPUT_FILES.contentDraftV1,
          SITEOPS_WIRE_OUTPUT_FILES.contentPatchV1,
        ];
  const maxBytes =
    input.expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2
      ? SITEOPS_WIRE_OUTPUT_MAX_BYTES.contentPlanV2
      : SITEOPS_WIRE_OUTPUT_MAX_BYTES[input.phase];
  if (!allowedFilenames.includes(input.expectedFilename)) {
    throw new SiteOpsWireOutputResolutionError("SITEOPS_WIRE_OUTPUT_INVALID");
  }
  const expectedFilename = input.expectedFilename;
  // Executable design/content output remains gated on phase completion. The
  // Non-executable exceptions are locally revalidated against immutable
  // coordinates before use: a Native receipt still needs its matching ZIP,
  // a content plan passes strict provenance/graph QA, and a content patch can
  // only alter predeclared data slots.
  const safeCurrentPhaseResult =
    input.acceptCurrentPhaseWhileRunning === true &&
    ((input.phase === "design" &&
      (expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.sourceReceiptV1 ||
        expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2)) ||
      (input.phase === "content" &&
        expectedFilename === SITEOPS_WIRE_OUTPUT_FILES.contentPatchV1));
  if (!input.taskCompleted && !safeCurrentPhaseResult) return null;
  const window = currentOperationWindow(input.events, input.operationToken);
  if (!window) return null;
  const acceptedCandidates: SiteOpsWireOutputResolution[] = [];
  const fallbackCandidates: SiteOpsWireOutputResolution[] = [];
  let sawInvalid = false;
  let sawUnavailable = false;
  let validationError: unknown;
  let validationCandidate:
    | Pick<SiteOpsWireOutputResolution, "sha256" | "source">
    | undefined;
  let validationFailurePriority = -1;
  const rememberValidationFailure = (
    error: unknown,
    source: SiteOpsWireOutputResolution["source"],
    acceptedStructured: boolean,
    sha256?: string,
  ) => {
    // A rejected Structured Output may carry the provider's empty recovery
    // placeholder. Prefer diagnostics from the exact assistant JSON (then a
    // phase-owned attachment), while an explicitly accepted Structured Output
    // remains authoritative when its business validation fails.
    const priority = acceptedStructured
      ? 3
      : source === "assistant_json"
        ? 2
        : source === "attachment"
          ? 1
          : 0;
    if (priority <= validationFailurePriority) return;
    validationFailurePriority = priority;
    validationError = error;
    validationCandidate = sha256 ? { sha256, source } : undefined;
  };
  const addCandidate = (
    value: unknown,
    source: SiteOpsWireOutputResolution["source"],
    acceptedStructured = false,
  ) => {
    let parsed: ReturnType<typeof candidate> = null;
    try {
      parsed = candidate(value, input.operationToken, maxBytes);
    } catch (error) {
      sawInvalid = true;
      rememberValidationFailure(error, source, acceptedStructured);
      return;
    }
    if (!parsed) {
      sawInvalid = true;
      return;
    }
    try {
      input.validateCandidate?.(parsed.value, source);
    } catch (error) {
      sawInvalid = true;
      rememberValidationFailure(
        error,
        source,
        acceptedStructured,
        parsed.sha256,
      );
      return;
    }
    const resolution = { ...parsed, source, sources: [source] };
    (acceptedStructured ? acceptedCandidates : fallbackCandidates).push(
      resolution,
    );
  };
  for (const event of window) {
    if (event.type !== "structured_output_result") continue;
    const envelope = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (envelope.kind === "accepted") {
      addCandidate(envelope.value, "structured", true);
      continue;
    }
    const raw = isRecord(event.structured_output_result)
      ? event.structured_output_result
      : null;
    if (raw && Object.prototype.hasOwnProperty.call(raw, "value")) {
      addCandidate(raw.value, "structured");
    }
  }
  // A locally valid, explicitly accepted structured value is authoritative.
  // Do not fetch signed fallback attachments merely to compare a provider's
  // recovery copies with its accepted result.
  const accepted = assertOneCandidate(
    acceptedCandidates,
    "SITEOPS_WIRE_OUTPUT_CONFLICT",
  );
  if (accepted) return accepted;
  for (const event of window) {
    const message = assistantMessage(event);
    if (!message) continue;
    const body = assistantJsonBody(message);
    if (body) {
      addCandidate(body, "assistant_json");
    }
    const attachmentSet = jsonAttachments(
      message,
      input.phase,
      expectedFilename,
    );
    sawInvalid ||= attachmentSet.invalid;
    for (const attachment of attachmentSet.attachments) {
      try {
        const value = await downloadAttachment({
          attachment,
          maxBytes,
          signal: input.signal,
          fetchPinned: input.fetchPinned ?? fetchPinnedPublicHttps,
        });
        addCandidate(value, "attachment");
      } catch (error) {
        if (
          error instanceof SiteOpsWireOutputResolutionError &&
          error.code === "SITEOPS_WIRE_OUTPUT_UNAVAILABLE"
        ) {
          sawUnavailable = true;
        } else if (error instanceof SiteOpsWireOutputResolutionError) {
          sawInvalid = true;
        } else {
          throw error;
        }
      }
    }
  }
  const resolved = assertOneCandidate(
    fallbackCandidates,
    "SITEOPS_WIRE_OUTPUT_FALLBACK_REQUIRED",
  );
  if (resolved) return resolved;
  if (sawInvalid) {
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_INVALID",
      validationError,
      validationCandidate,
    );
  }
  if (sawUnavailable) {
    throw new SiteOpsWireOutputResolutionError(
      "SITEOPS_WIRE_OUTPUT_UNAVAILABLE",
    );
  }
  return null;
}
