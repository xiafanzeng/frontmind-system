const knowledgeBaseImageMimeByExtension: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/vnd.microsoft.icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

const canonicalKnowledgeBaseImageMimeType: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/ico": "image/vnd.microsoft.icon",
  "image/x-icon": "image/vnd.microsoft.icon",
};

const supportedKnowledgeBaseImageMimeTypes = new Set(
  Object.values(knowledgeBaseImageMimeByExtension),
);

export function normalizeKnowledgeBaseAttachmentFilename(
  value: unknown,
  fallback = "company_material",
) {
  const cleaned = String(value || "")
    .replace(/[\\/\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\uD800-\uDFFF]/gu, "_")
    .trim();
  const safe = Array.from(cleaned).slice(0, 160).join("");
  return safe && !/^\.+$/u.test(safe) ? safe : fallback;
}

export function normalizeKnowledgeBaseAttachmentMimeType(
  filename: string,
  value: unknown,
) {
  const declared = String(value || "application/octet-stream")
    .trim()
    .toLowerCase()
    .slice(0, 255);
  const extensionStart = filename.lastIndexOf(".");
  const extension =
    extensionStart >= 0 ? filename.slice(extensionStart).toLowerCase() : "";
  const extensionMimeType = knowledgeBaseImageMimeByExtension[extension];
  const canonicalDeclared =
    canonicalKnowledgeBaseImageMimeType[declared] || declared;
  if (supportedKnowledgeBaseImageMimeTypes.has(canonicalDeclared)) {
    return canonicalDeclared;
  }
  if (declared.startsWith("image/")) {
    return extensionMimeType || "application/octet-stream";
  }
  return extensionMimeType || declared;
}
