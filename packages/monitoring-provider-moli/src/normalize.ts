import { parseProviderTimestamp } from "./timestamp.js";
import type {
  MoliBillingRecord,
  MoliClientType,
  MoliKeywordEvaluation,
  MoliMedia,
  MoliModel,
  MoliReference,
  MoliRegion,
  MoliResultItem,
  MoliSentiment,
  MoliSubTaskStatus,
  MoliTaskStatus,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

export function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function findArray(
  value: unknown,
  candidateKeys: readonly string[],
): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of candidateKeys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) {
      const nested = findArray(candidate, candidateKeys);
      if (nested.length) return nested;
    }
  }
  return [];
}

export function normalizeTaskStatus(value: unknown): MoliTaskStatus {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replaceAll("-", "_");
  if (
    normalized === "pending" ||
    normalized === "processing" ||
    normalized === "completed" ||
    normalized === "partial_completed" ||
    normalized === "failed" ||
    normalized === "stopped"
  ) {
    return normalized;
  }
  return "unknown";
}

function normalizeSubTaskStatus(value: unknown): MoliSubTaskStatus {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replaceAll("-", "_");
  if (
    normalized === "pending" ||
    normalized === "assigned" ||
    normalized === "processing" ||
    normalized === "completed" ||
    normalized === "stopped" ||
    normalized === "failed" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return "unknown";
}

export function normalizeModel(value: unknown): MoliModel | undefined {
  if (!isRecord(value)) return undefined;
  const platform = stringValue(
    value.platform,
    value.platformCode,
    value.code,
    value.modelCode,
  );
  const name = stringValue(
    value.name,
    value.modelName,
    value.displayName,
    platform,
  );
  if (!platform || !name) return undefined;
  const clientHint = stringValue(
    value.clientType,
    value.client,
    value.terminalType,
    value.type,
  )?.toLowerCase();
  const clientType: MoliClientType =
    clientHint === "mobile" || clientHint === "app" ? "mobile" : "web";
  return {
    platform,
    name,
    clientType,
    displayName: stringValue(value.displayName, value.label, value.modelName),
    enabledByProvider:
      typeof value.enabled === "boolean"
        ? value.enabled
        : typeof value.status === "boolean"
          ? value.status
          : undefined,
    raw: value,
  };
}

export function normalizeRegion(
  value: unknown,
  scope: "domestic" | "overseas",
): MoliRegion | undefined {
  if (!isRecord(value)) return undefined;
  const regionCode = Array.isArray(value.regionCode)
    ? value.regionCode[0]
    : value.regionCode;
  const code = stringValue(
    value.code,
    regionCode,
    value.cityCode,
    value.value,
    value.id,
  );
  const name = stringValue(
    value.province,
    value.name,
    value.regionName,
    value.cityName,
    value.label,
  );
  if (!code || !name) return undefined;
  return { code, name, scope, raw: value };
}

function normalizeReference(
  value: unknown,
  _index: number,
): MoliReference | undefined {
  if (typeof value === "string") {
    try {
      const parsed = new URL(value);
      if (!isSafeExternalHttpUrl(parsed)) return undefined;
      const url = parsed.toString();
      return {
        url,
        domain: normalizeReferenceDomain(parsed.hostname),
        position: undefined,
        raw: { url: value },
      };
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  const url = stringValue(
    value.url,
    value.link,
    value.sourceUrl,
    value.referenceUrl,
  );
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!isSafeExternalHttpUrl(parsed)) return undefined;
  const canonicalUrl = parsed.toString();
  return {
    url: canonicalUrl,
    // Provider `site` is a human-readable publisher name, not a hostname.
    // Deriving this value from the accepted URL also prevents untrusted
    // provider metadata from corrupting domain-level aggregation.
    domain: normalizeReferenceDomain(parsed.hostname),
    siteName: stringValue(value.siteName, value.site),
    title: stringValue(value.title, value.name),
    snippet: stringValue(
      value.snippet,
      value.summary,
      value.content,
      value.description,
    ),
    publishedAt: normalizePublishedAt(
      value.publishTime,
      value.publishedAt,
      value.publishDate,
    ),
    iconUrl: normalizeReferenceIconUrl(
      stringValue(value.iconUrl, value.icon, value.faviconUrl, value.favicon),
    ),
    // `index` is the provider's documented citation marker. Keep `position`
    // only as a compatibility fallback so auxiliary/legacy metadata cannot
    // override the number used by `[citation:N]` in answerContent.
    position: numberValue(value.index, value.position),
    raw: value,
  };
}

function normalizeSentiment(value: unknown): MoliSentiment | undefined {
  const candidate = isRecord(value)
    ? stringValue(value.sentiment, value.nature, value.type, value.label)
    : stringValue(value);
  const normalized = candidate?.toLowerCase();
  return normalized === "positive" ||
    normalized === "neutral" ||
    normalized === "negative"
    ? normalized
    : undefined;
}

function normalizePublishedAt(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const candidate = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(candidate);
    if (!match) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1) continue;

    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
      31,
      leapYear ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][month - 1];
    if (daysInMonth !== undefined && day <= daysInMonth) return candidate;
  }
  return undefined;
}

function normalizeKeywordEvaluations(value: unknown): MoliKeywordEvaluation[] {
  const normalized: MoliKeywordEvaluation[] = [];
  const indexByKeywordAndNature = new Map<string, number>();

  for (const entry of findArray(value, ["list", "records"])) {
    if (!isRecord(entry)) continue;
    const keyword = stringValue(entry.keyword);
    const nature = normalizeSentiment(entry.nature);
    if (!keyword || !nature) continue;

    const context = stringValue(entry.context);
    const dedupeKey = `${keyword.toLowerCase()}\u0000${nature}`;
    const existingIndex = indexByKeywordAndNature.get(dedupeKey);
    if (existingIndex !== undefined) {
      const existing = normalized[existingIndex];
      if (existing && !existing.context && context) {
        normalized[existingIndex] = { ...existing, context };
      }
      continue;
    }

    indexByKeywordAndNature.set(dedupeKey, normalized.length);
    normalized.push(
      context ? { keyword, nature, context } : { keyword, nature },
    );
  }

  return normalized;
}

function isSafeExternalHttpUrl(url: URL): boolean {
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password
  );
}

function normalizeReferenceDomain(hostname: string): string {
  const domain = hostname.toLowerCase().replace(/\.+$/u, "");
  return domain.startsWith("www.") && domain.length > 4
    ? domain.slice(4)
    : domain;
}

function normalizeExternalHttpUrl(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return isSafeExternalHttpUrl(parsed) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeReferenceIconUrl(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return isSafeExternalHttpUrl(parsed) ? parsed.toString() : undefined;
  } catch {
    if (!isSafeRelativeIconPath(value)) return undefined;
    try {
      const base = new URL("https://provider.invalid/");
      const resolved = new URL(value, base);
      return resolved.origin === base.origin ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

function isSafeRelativeIconPath(value: string): boolean {
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    hasAsciiControlCharacter(value)
  ) {
    return false;
  }

  const path = value.split(/[?#]/u, 1)[0] ?? "";
  if (!path) return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (
    decodedPath.startsWith("//") ||
    decodedPath.includes("\\") ||
    hasAsciiControlCharacter(decodedPath)
  ) {
    return false;
  }

  return [path, decodedPath].every((candidate) =>
    candidate
      .split("/")
      .every((segment) => segment !== "." && segment !== ".."),
  );
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function mediaFrom(value: unknown, kind: MoliMedia["kind"]): MoliMedia[] {
  const list = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return list.flatMap((entry): MoliMedia[] => {
    if (typeof entry === "string" && entry.trim()) {
      const url = normalizeExternalHttpUrl(entry.trim());
      return url ? [{ kind, url, raw: { url: entry } }] : [];
    }
    if (!isRecord(entry)) return [];
    const url = normalizeExternalHttpUrl(
      stringValue(
        entry.url,
        entry.link,
        entry.src,
        entry.imageUrl,
        entry.videoUrl,
        entry.pageScreenshot,
      ),
    );
    if (!url) return [];
    return [
      { kind, url, title: stringValue(entry.title, entry.name), raw: entry },
    ];
  });
}

function previewImagesFrom(value: unknown): MoliMedia[] {
  const list = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return list.flatMap((entry): MoliMedia[] => {
    if (!isRecord(entry)) return [];
    const url = normalizeExternalHttpUrl(
      stringValue(entry.cover, entry.thumbnail, entry.imageUrl, entry.coverUrl),
    );
    if (!url) return [];
    return [
      {
        kind: "image",
        url,
        title: stringValue(entry.title, entry.name),
        raw: entry,
      },
    ];
  });
}

function sanitizedRaw(
  value: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  // Recommended questions are a provider result convenience and are intentionally
  // not part of this product's public or persisted normalized result contract.
  const { recommendedQuestions: _ignored, ...rest } = value;
  return rest;
}

export function normalizeResultItem(
  value: unknown,
): MoliResultItem | undefined {
  if (!isRecord(value)) return undefined;
  const normalizeReferences = (entries: unknown[]) =>
    mergeReferenceMetadata(
      entries
        .map(normalizeReference)
        .filter((entry): entry is MoliReference => Boolean(entry)),
    );
  const allReferences = normalizeReferences([
    ...findArray(value.referenceList, ["list", "records"]),
    ...findArray(value.references, ["list", "records"]),
  ]);
  const explicitCitationList = Array.isArray(value.citationList)
    ? value.citationList
    : undefined;
  const citedReferences = normalizeReferences(explicitCitationList ?? []);
  const hasExplicitCitationList = explicitCitationList !== undefined;
  // Search/reference lists are discovery evidence, never proof that an answer
  // cited the source. A missing citationList therefore stays distinguishable
  // from an explicitly returned (possibly empty) citationList.
  const references = hasExplicitCitationList ? citedReferences : [];

  const media = [
    ...mediaFrom(value.pageScreenshot, "screenshot"),
    ...mediaFrom(value.screenshot, "screenshot"),
    ...mediaFrom(value.mediaContent, "image"),
    ...mediaFrom(value.imageList, "image"),
    ...mediaFrom(value.videoList, "video"),
    ...mediaFrom(value.goods, "goods"),
    ...previewImagesFrom(value.videoList),
    ...previewImagesFrom(value.goods),
  ].filter(
    (entry, index, all) =>
      all.findIndex((other) => other.url === entry.url) === index,
  );

  const searchKeywords = findArray(value.searchKeywords, ["list"])
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  const parsedUpdatedAt = parseProviderTimestamp(
    value.updatedAt ??
      value.updateTime ??
      value.completedAt ??
      value.finishTime ??
      value.time,
  );
  const reasoningProcess = isRecord(value.reasoningProcess)
    ? stringValue(
        value.reasoningProcess.content,
        value.reasoningProcess.summary,
      )
    : stringValue(value.reasoningProcess, value.thinking, value.reasoning);
  const sentiment =
    normalizeSentiment(value.sentiment) ??
    normalizeSentiment(value.sentimentAnalysis);
  const keywordEvaluations = normalizeKeywordEvaluations(
    value.keywordEvaluations,
  );

  return {
    subTaskId: stringValue(value.subTaskId, value.subtaskId, value.id),
    platform: stringValue(value.platform, value.platformCode, value.model),
    status: normalizeSubTaskStatus(value.status ?? value.taskStatus),
    answerContent:
      stringValue(value.answerContent, value.answer, value.content) ?? "",
    reasoningProcess,
    searchKeywords,
    references,
    citationProvenance: hasExplicitCitationList ? "explicit" : "unavailable",
    allReferences,
    media,
    sentiment,
    mentionPosition: numberValue(value.mentionPosition),
    mentionContext: stringValue(value.mentionContext),
    competitorRankings: value.competitorRankings,
    allRankings: value.allRankings,
    categoryRanking: value.categoryRanking,
    keywordEvaluations,
    amount: stringValue(value.amount, value.cost),
    errorMessage: stringValue(
      value.errorMessage,
      value.error,
      value.failReason,
    ),
    updatedAt: parsedUpdatedAt?.date,
    rawUpdatedAt: parsedUpdatedAt?.raw,
    raw: sanitizedRaw(value),
  };
}

function mergeReferenceMetadata(
  entries: readonly MoliReference[],
): MoliReference[] {
  const merged = new Map<string, MoliReference>();
  for (const entry of entries) {
    const existing = merged.get(entry.url);
    if (!existing) {
      merged.set(entry.url, entry);
      continue;
    }
    merged.set(entry.url, {
      ...existing,
      title: existing.title ?? entry.title,
      domain: existing.domain ?? entry.domain,
      siteName: existing.siteName ?? entry.siteName,
      snippet: existing.snippet ?? entry.snippet,
      publishedAt: existing.publishedAt ?? entry.publishedAt,
      iconUrl: existing.iconUrl ?? entry.iconUrl,
      position: existing.position ?? entry.position,
      raw: existing.raw,
    });
  }
  return [...merged.values()];
}

export function normalizeBillingRecord(
  value: unknown,
): MoliBillingRecord | undefined {
  if (!isRecord(value)) return undefined;
  const occurred = parseProviderTimestamp(
    value.transactionTime ??
      value.occurredAt ??
      value.createdAt ??
      value.createTime ??
      value.time,
  );
  const taskCreated = parseProviderTimestamp(value.taskCreatedTime);
  const taskCompleted = parseProviderTimestamp(value.taskCompletedTime);
  return {
    id: stringValue(value.id),
    taskId: stringValue(value.taskId),
    subTaskId: stringValue(value.subTaskId),
    consumerTaskId: stringValue(value.consumerTaskId),
    amount: stringValue(value.amount, value.cost),
    status: stringValue(value.status),
    occurredAt: occurred?.date,
    rawOccurredAt: occurred?.raw,
    taskCreatedAt: taskCreated?.date,
    rawTaskCreatedAt: taskCreated?.raw,
    taskCompletedAt: taskCompleted?.date,
    rawTaskCompletedAt: taskCompleted?.raw,
    description: stringValue(value.description),
    aiModel: stringValue(value.aiModel),
    aiModelText: stringValue(value.aiModelText),
    question: stringValue(value.question),
    raw: value,
  };
}
