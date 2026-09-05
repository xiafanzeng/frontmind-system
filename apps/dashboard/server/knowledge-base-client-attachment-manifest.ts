import { KnowledgeBaseTurnReservationError } from "./knowledge-base-turn-service";
import {
  normalizeKnowledgeBaseAttachmentFilename,
  normalizeKnowledgeBaseAttachmentMimeType,
} from "../shared/knowledge-base-attachment";

const MAX_KNOWLEDGE_BASE_CLIENT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface KnowledgeBaseClientAttachmentManifestItem {
  filename: string;
  sizeBytes: number;
  mimeType: string;
  lastModified: number;
  /**
   * Legacy clients may declare a browser-computed digest. New reservations
   * omit it: Dashboard binds the authoritative digest after streaming the
   * upload into managed storage.
   */
  sha256?: string;
  /** Stable browser row identity used by start-before-upload recovery. */
  itemId?: string;
  /** One-based position and total are frozen only for starter batches. */
  ordinal?: number;
  total?: number;
}

export interface KnowledgeBaseAttachment {
  file_id?: string;
  fileId?: string;
  filename?: string;
  name?: string;
}

export function normalizeKnowledgeBaseUserAttachments(
  attachments: KnowledgeBaseAttachment[] | undefined,
) {
  return (attachments || [])
    .map((attachment) => {
      const fileId = attachment.file_id || attachment.fileId || "";
      const filename = normalizeKnowledgeBaseAttachmentFilename(
        attachment.filename || attachment.name || "company_material",
        "company_material",
      );
      return fileId ? { file_id: fileId, filename } : null;
    })
    .filter(Boolean) as Array<{ file_id: string; filename: string }>;
}

export function normalizeKnowledgeBaseClientAttachmentManifest(
  value: unknown,
): KnowledgeBaseClientAttachmentManifestItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 99) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Customer attachment manifest must contain between 1 and 99 files",
    );
  }
  return value.map((entry, index) => {
    const source =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const filename = normalizeKnowledgeBaseAttachmentFilename(
      String(source.filename || source.name || ""),
      "",
    );
    const sizeBytes = Number(source.sizeBytes ?? source.size);
    const lastModified = Number(source.lastModified ?? 0);
    const sha256 = String(source.sha256 || "")
      .trim()
      .toLowerCase();
    const mimeType = normalizeKnowledgeBaseAttachmentMimeType(
      filename,
      source.mimeType || source.type,
    );
    const itemId = String(source.itemId || "").trim();
    const ordinal = Number(source.ordinal);
    const total = Number(source.total);
    const hasStarterCoordinate =
      Boolean(itemId) ||
      source.ordinal !== undefined ||
      source.total !== undefined;
    if (
      !filename ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_KNOWLEDGE_BASE_CLIENT_ATTACHMENT_BYTES ||
      !Number.isSafeInteger(lastModified) ||
      lastModified < 0 ||
      !mimeType ||
      (sha256.length > 0 && !/^[a-f0-9]{64}$/u.test(sha256)) ||
      (hasStarterCoordinate &&
        (!itemId ||
          itemId.length > 191 ||
          !Number.isSafeInteger(ordinal) ||
          ordinal !== index + 1 ||
          !Number.isSafeInteger(total) ||
          total !== value.length))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        `Customer attachment manifest entry ${index + 1} is invalid`,
      );
    }
    return {
      filename,
      sizeBytes,
      mimeType,
      lastModified,
      ...(sha256 ? { sha256 } : {}),
      ...(hasStarterCoordinate ? { itemId, ordinal, total } : {}),
    };
  });
}

export function assertKnowledgeBaseAttachmentManifestPresent(input: {
  skillVersion: string;
  attachmentCount: number;
  attachmentManifest:
    | readonly KnowledgeBaseClientAttachmentManifestItem[]
    | undefined;
}) {
  if (
    (input.skillVersion === "4" || input.skillVersion === "5") &&
    input.attachmentCount > 0 &&
    input.attachmentManifest === undefined
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "当前版本的知识库附件必须包含完整预约清单，请重新上传",
    );
  }
}
