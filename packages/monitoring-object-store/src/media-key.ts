const SAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

function segment(value: string): string {
  const result = value.trim().replace(SAFE_SEGMENT, "_").slice(0, 128);
  if (!result || result === "." || result === "..")
    throw new TypeError("Invalid object key segment");
  return result;
}

export function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    default:
      throw new TypeError(`Unsupported archived media type: ${contentType}`);
  }
}

export function createArchivedMediaKey(input: {
  tenantId: string;
  projectId: string;
  runId: string;
  attemptId: string;
  sha256: string;
  contentType: string;
}): string {
  if (!/^[a-f0-9]{64}$/i.test(input.sha256))
    throw new TypeError("sha256 must be a 64-character hex digest");
  return [
    "media",
    segment(input.tenantId),
    segment(input.projectId),
    segment(input.runId),
    segment(input.attemptId),
    `${input.sha256.toLowerCase()}.${extensionForContentType(input.contentType)}`,
  ].join("/");
}

export interface ArchivedMediaKeys {
  /** Byte-for-byte upstream body, with its MIME kept in OSS metadata. */
  original: string;
  /** Metadata-stripped WebP used by the authenticated media endpoint. */
  display: string;
  /** Small metadata-stripped WebP used by lists and matrices. */
  thumbnail: string;
}

export function createArchivedMediaKeys(input: {
  tenantId: string;
  projectId: string;
  runId: string;
  attemptId: string;
  sha256: string;
}): ArchivedMediaKeys {
  if (!/^[a-f0-9]{64}$/i.test(input.sha256))
    throw new TypeError("sha256 must be a 64-character hex digest");
  const base = [
    "media",
    segment(input.tenantId),
    segment(input.projectId),
    segment(input.runId),
    segment(input.attemptId),
    input.sha256.toLowerCase(),
  ].join("/");
  return {
    original: `${base}.original`,
    display: `${base}.webp`,
    thumbnail: `${base}.thumb.webp`,
  };
}

export function originalObjectKeyForDisplay(displayObjectKey: string): string {
  if (
    !displayObjectKey.endsWith(".webp") ||
    displayObjectKey.endsWith(".thumb.webp")
  ) {
    throw new TypeError("Display object key must end in .webp");
  }
  return `${displayObjectKey.slice(0, -".webp".length)}.original`;
}

export function createRawResultObjectKey(input: {
  tenantId: string;
  projectId: string;
  runId: string;
  attemptId: string;
  sha256: string;
}): string {
  if (!/^[a-f0-9]{64}$/i.test(input.sha256))
    throw new TypeError("sha256 must be a 64-character hex digest");
  return [
    "raw-results",
    segment(input.tenantId),
    segment(input.projectId),
    segment(input.runId),
    segment(input.attemptId),
    `${input.sha256.toLowerCase()}.json.gz`,
  ].join("/");
}
