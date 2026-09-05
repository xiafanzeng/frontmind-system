function normalizedUpstreamFileId(value: string) {
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= 255 &&
    !/[\s/?#\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : "";
}

export function collectUpstreamOutputFileIds(
  value: unknown,
  ids = new Set<string>(),
  currentKey?: string,
  depth = 0,
) {
  if (value === null || value === undefined || depth > 50) return ids;
  if (typeof value === "string") {
    if ((currentKey === "file_id" || currentKey === "fileId") && value) {
      const fileId = normalizedUpstreamFileId(value);
      if (fileId) ids.add(fileId);
    }
    if (
      currentKey === "url" ||
      currentKey === "file_url" ||
      currentKey === "fileUrl" ||
      currentKey === "image_url" ||
      currentKey === "imageUrl"
    ) {
      const match = value.match(/\/v1\/files\/([^/?#]+)/);
      if (match?.[1]) {
        try {
          const fileId = normalizedUpstreamFileId(decodeURIComponent(match[1]));
          if (fileId) ids.add(fileId);
        } catch {
          // Ignore malformed upstream URLs; they cannot be downloaded safely.
        }
      }
    }
    return ids;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUpstreamOutputFileIds(item, ids, undefined, depth + 1);
    }
    return ids;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      collectUpstreamOutputFileIds(item, ids, key, depth + 1);
    }
  }
  return ids;
}
