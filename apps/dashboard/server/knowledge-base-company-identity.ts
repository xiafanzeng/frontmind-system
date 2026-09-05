const MAX_RESEARCH_WEBSITES = 20;
const MAX_WEBSITE_LENGTH = 2_048;

export class KnowledgeBaseCompanyIdentityNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBaseCompanyIdentityNormalizationError";
  }
}

export function canonicalizeKnowledgeBaseCompanyName(value: unknown) {
  const normalized =
    typeof value === "string"
      ? value.normalize("NFKC").trim().replace(/\s+/gu, " ")
      : "";
  if (!normalized || normalized.length > 255) {
    throw new KnowledgeBaseCompanyIdentityNormalizationError("企业名称无效");
  }
  return normalized;
}

function canonicalizeWebsiteLine(value: string) {
  const raw = value.normalize("NFKC").trim();
  if (
    !raw ||
    raw.length > MAX_WEBSITE_LENGTH ||
    /^\/\//u.test(raw) ||
    raw.includes("#")
  ) {
    throw new KnowledgeBaseCompanyIdentityNormalizationError("企业官网无效");
  }
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw)
    ? raw
    : `https://${raw}`;
  const authority = candidate
    .slice(candidate.indexOf("://") + 3)
    .split(/[/?#]/u, 1)[0];
  if (!authority || authority.includes("@")) {
    throw new KnowledgeBaseCompanyIdentityNormalizationError(
      "企业官网只允许不含账号和锚点的 HTTP/HTTPS 地址",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new KnowledgeBaseCompanyIdentityNormalizationError("企业官网无效");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new KnowledgeBaseCompanyIdentityNormalizationError(
      "企业官网只允许不含账号和锚点的 HTTP/HTTPS 地址",
    );
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }
  if (!parsed.pathname) parsed.pathname = "/";
  return parsed.toString();
}

export function canonicalizeKnowledgeBaseWebsiteLines(value: unknown): {
  primary: string | null;
  researchWebsites: string[];
} {
  if (value === null || value === undefined || value === "") {
    return { primary: null, researchWebsites: [] };
  }
  if (typeof value !== "string") {
    throw new KnowledgeBaseCompanyIdentityNormalizationError("企业官网无效");
  }
  const lines = value
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { primary: null, researchWebsites: [] };
  if (lines.length > MAX_RESEARCH_WEBSITES) {
    throw new KnowledgeBaseCompanyIdentityNormalizationError(
      `企业官网最多填写 ${MAX_RESEARCH_WEBSITES} 条`,
    );
  }
  const researchWebsites = lines
    .map(canonicalizeWebsiteLine)
    .filter((website, index, all) => all.indexOf(website) === index);
  return {
    primary: researchWebsites[0] ?? null,
    researchWebsites,
  };
}

export function canonicalizeKnowledgeBaseWebsite(value: unknown) {
  const normalized = canonicalizeKnowledgeBaseWebsiteLines(value);
  if (normalized.researchWebsites.length > 1) {
    throw new KnowledgeBaseCompanyIdentityNormalizationError(
      "冻结的企业主官网只能包含一条地址",
    );
  }
  return normalized.primary;
}
