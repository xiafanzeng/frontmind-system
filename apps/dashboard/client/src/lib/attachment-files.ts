import JSZip from "jszip";
import {
  inspectImageFile,
  formatFileSize,
  formatImageInspectionSummary,
  type ImageInspection,
} from "@/lib/image-inspection";
import {
  normalizeKnowledgeBaseAttachmentFilename,
  normalizeKnowledgeBaseAttachmentMimeType,
} from "@shared/knowledge-base-attachment";

export const ZIP_REFERENCE_PROMPT =
  "附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。";

/**
 * The chat upload contract is shared by every agent entry point. Keep the
 * browser-side limit in one place so picker, drag-and-drop and the defensive
 * send path cannot disagree.
 */
export const MAX_CHAT_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_KNOWLEDGE_BASE_ATTACHMENT_BYTES = MAX_CHAT_ATTACHMENT_BYTES;

export function chatAttachmentSizeError(file: Pick<File, "name" | "size">) {
  if (file.size <= MAX_CHAT_ATTACHMENT_BYTES) return null;
  return `文件“${file.name || "未命名文件"}”不能超过 100 MB`;
}

export function assertChatAttachmentSizes(
  files: readonly Pick<File, "name" | "size">[],
) {
  for (const file of files) {
    const error = chatAttachmentSizeError(file);
    if (error) throw new Error(error);
  }
}

export interface ZippedImageInfo {
  name: string;
  width: number;
  height: number;
  pixels: number;
  size: number;
}

export interface PreparedUploadFile {
  file: File;
  generatedFromImages?: ZippedImageInfo[];
}

export interface PreparedUploadFiles {
  files: PreparedUploadFile[];
  didZipLargeImages: boolean;
  zippedImages: ZippedImageInfo[];
}

interface OversizedImage {
  file: File;
  inspection: ImageInspection;
}

const IMAGE_FILE_EXTENSION =
  /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

export function isImageUpload(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name);
}

export function normalizedKnowledgeBaseUploadFilename(value: string) {
  return normalizeKnowledgeBaseAttachmentFilename(value);
}

export function normalizedKnowledgeBaseUploadMimeType(file: File) {
  return normalizeKnowledgeBaseAttachmentMimeType(file.name, file.type);
}

async function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("无法读取附件字节"));
    });
    reader.addEventListener("error", () =>
      reject(reader.error || new Error("无法读取附件字节")),
    );
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Binds a resumable knowledge-base reservation to the exact browser bytes,
 * not merely to a filename/size/timestamp tuple that another file can mimic.
 */
export async function sha256UploadFile(file: File): Promise<string> {
  assertChatAttachmentSizes([file]);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前浏览器无法校验附件完整性，请升级后重试");
  const digest = await subtle.digest("SHA-256", await readFileBytes(file));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function prepareUploadFiles(
  files: File[],
): Promise<PreparedUploadFiles> {
  const preparedFiles: PreparedUploadFile[] = [];
  const oversizedImages: OversizedImage[] = [];

  for (const file of files) {
    if (isImageUpload(file)) {
      let inspection: ImageInspection | null = null;
      try {
        inspection = await inspectImageFile(file);
      } catch (err) {
        console.warn(
          `[AttachmentPrep] Failed to inspect image "${file.name}", uploading as file`,
          err,
        );
      }

      if (inspection?.isLarge) {
        oversizedImages.push({ file, inspection });
        continue;
      }
    }

    preparedFiles.push({ file });
  }

  if (oversizedImages.length > 0) {
    const zipFile = await createOriginalImagesZip(oversizedImages);
    const zippedImages = oversizedImages.map(({ file, inspection }) => ({
      name: file.name,
      width: inspection.width,
      height: inspection.height,
      pixels: inspection.pixels,
      size: file.size,
    }));

    preparedFiles.push({
      file: zipFile,
      generatedFromImages: zippedImages,
    });

    return {
      files: preparedFiles,
      didZipLargeImages: true,
      zippedImages,
    };
  }

  return {
    files: preparedFiles,
    didZipLargeImages: false,
    zippedImages: [],
  };
}

async function createOriginalImagesZip(
  images: OversizedImage[],
): Promise<File> {
  const zip = new JSZip();
  const folder = zip.folder("original-images");
  const stableLastModified = Math.max(
    0,
    ...images.map(({ file }) => Number(file.lastModified || 0)),
  );
  const zipEntryDate = new Date(
    Math.max(Date.UTC(1980, 0, 1), stableLastModified),
  );

  if (!folder) {
    throw new Error("创建图片 ZIP 目录失败");
  }

  const usedNames = new Set<string>();
  const readmeLines = [
    "FrontMind original image attachments",
    "",
    "These files are original, lossless user uploads. Please unzip and read them as visual references.",
    "",
    "Images:",
  ];

  images.forEach(({ file, inspection }, index) => {
    const entryName = uniqueZipEntryName(file.name, usedNames, index);
    folder.file(entryName, file, { binary: true, date: zipEntryDate });
    readmeLines.push(
      `- ${entryName}: ${formatImageInspectionSummary(inspection)}; original size ${formatFileSize(file.size)}`,
    );
  });

  zip.file("README.txt", readmeLines.join("\n"), { date: zipEntryDate });

  try {
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "STORE",
      mimeType: "application/zip",
    });
    return new File([blob], buildOriginalImagesZipName(images), {
      type: "application/zip",
      lastModified: stableLastModified,
    });
  } catch (err: any) {
    throw new Error(`图片 ZIP 打包失败：${err?.message || "未知错误"}`);
  }
}

function buildOriginalImagesZipName(images: OversizedImage[]): string {
  const identity = JSON.stringify(
    images.map(({ file }) => ({
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      lastModified: Number(file.lastModified || 0),
    })),
  );
  // FNV-1a is used only for a stable, non-security filename suffix. The full
  // ordered manifest remains the server-side idempotency identity.
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `frontmind-original-images-${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}.zip`;
}

function uniqueZipEntryName(
  fileName: string,
  usedNames: Set<string>,
  index: number,
): string {
  const sanitized = fileName.replace(/[\\/]/g, "_") || `image-${index + 1}`;
  if (!usedNames.has(sanitized)) {
    usedNames.add(sanitized);
    return sanitized;
  }

  const dotIndex = sanitized.lastIndexOf(".");
  const base = dotIndex > 0 ? sanitized.slice(0, dotIndex) : sanitized;
  const ext = dotIndex > 0 ? sanitized.slice(dotIndex) : "";
  let candidate = `${base}-${index + 1}${ext}`;
  let suffix = index + 1;

  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}${ext}`;
  }

  usedNames.add(candidate);
  return candidate;
}
