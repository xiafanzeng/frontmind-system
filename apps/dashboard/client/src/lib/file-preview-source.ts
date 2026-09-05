import type { Attachment } from "@/contexts/ConversationContext";

export type FilePreviewSource =
  | { kind: "local"; file: File; expiresAt?: number }
  | { kind: "owned_file"; fileId: string; expiresAt?: number }
  | { kind: "external"; url: string };

export function managedLocalAssetContentUrl(fileId: string) {
  return fileId.startsWith("asset_")
    ? `/api/frontmind/v2/assets/${encodeURIComponent(fileId)}/content`
    : null;
}

/** Resolve one attachment to exactly one preview source. */
export function filePreviewSource(
  attachment: Attachment,
): FilePreviewSource | null {
  if (attachment.file) {
    return {
      kind: "local",
      file: attachment.file,
      expiresAt: attachment.expiresAt,
    };
  }
  if (attachment.blobUrl || attachment.base64) {
    return { kind: "external", url: attachment.blobUrl || attachment.base64! };
  }
  const fileId = attachment.fileId;
  if (!fileId || !fileId.trim()) return null;
  // fileId is opaque. Reserved characters, slashes, spaces and even a
  // URL-looking prefix never change it into a URL; only an explicit URL field
  // may create an external source.
  return { kind: "owned_file", fileId, expiresAt: attachment.expiresAt };
}
