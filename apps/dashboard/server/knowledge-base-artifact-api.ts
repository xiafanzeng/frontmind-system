import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type Response } from "express";
import sharp from "sharp";

import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
} from "../drizzle/schema";
import type { FrontMindRequest } from "./_core/express-auth";
import {
  KnowledgeArchiveValidationError,
  readStoredKnowledgeAssetBytes,
  validateKnowledgeArchiveForDownload,
} from "./dashboard-api";
import { getDb } from "./db";
import {
  assertKnowledgeBasePackageMatchesBuild,
  KnowledgeBasePackageBindingError,
} from "./knowledge-base-package-validation";
import {
  assertKnowledgeBaseCustomerUploadVisualBindings,
  declaredKnowledgeBaseCustomerUploadImagesFromTurn,
  knowledgeBaseCustomerUploadInternalIdentity,
  persistedKnowledgeBaseCustomerUploadBytesForBuild,
  type KnowledgeBaseCustomerUploadImage,
  verifiedKnowledgeBaseCustomerUploadImagesFromTurn,
  verifiedKnowledgeBasePackageUploadEvidenceForBuild,
} from "./knowledge-base-customer-upload";
import {
  KnowledgeBuildArtifactError,
  knowledgeBuildArtifactStorageKeyBelongsTo,
  readKnowledgeBuildArtifact,
  type KnowledgeBuildArtifactKind,
} from "./knowledge-build-artifact-store";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  knowledgeBaseArchiveReadContractVersions,
  knowledgeBaseArchiveRequiresV4UploadEvidence,
} from "./knowledge-base-archive-contract";
import { knowledgeBaseTreePolicy } from "./knowledge-base-progress";
import {
  isDashboardOwnedKnowledgePackageBuild,
  readDashboardOwnedKnowledgePackage,
} from "./knowledge-base-local-package";
import {
  KnowledgeBaseMaterializedAssetError,
  readValidatedActiveKnowledgeBaseWorkingSet,
  resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle,
  resolveKnowledgeBaseWorkingSetResource,
} from "./knowledge-base-materialized-assets";
import {
  knowledgeBaseOfficialLogoInternalIdentity,
  knowledgeBasePublicBuildSelectorMatches,
  knowledgeBasePublicResourceHandleMatches,
  parseKnowledgeBasePublicResourceHandle,
} from "./knowledge-base-public-resource";

const router = Router();
const MAX_CUSTOMER_UPLOAD_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_CUSTOMER_UPLOAD_SVG_BYTES = 10 * 1024 * 1024;
// Match the upload-admission decoder: if a customer image is accepted for a
// turn, the same original must also remain previewable from history. Final ZIP
// assets may still be safely downscaled to the stricter packaged-image limit.
const MAX_CUSTOMER_UPLOAD_PIXELS = 100_000_000;
const MAX_CUSTOMER_PREVIEW_DIMENSION = 4096;
const MAX_CUSTOMER_PREVIEW_BYTES = 80 * 1024 * 1024;
const SAFE_CUSTOMER_RASTER_FORMATS = new Set([
  "png",
  "jpeg",
  "webp",
  "avif",
  "gif",
  "tiff",
  "heif",
]);

class CustomerUploadPreviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CustomerUploadPreviewError";
  }
}

type ArtifactBuild = Pick<
  typeof knowledgeBaseBuilds.$inferSelect,
  | "id"
  | "userId"
  | "generation"
  | "status"
  | "skillVersion"
  | "revision"
  | "logoStorageKey"
  | "logoSha256"
  | "logoBytes"
  | "logoFilename"
  | "logoMimeType"
  | "packageStorageKey"
  | "packageStatus"
  | "packageArchiveSha256"
  | "packageSizeBytes"
  | "packageFilename"
>;

export type KnowledgeBaseArtifactDescriptor = {
  kind: KnowledgeBuildArtifactKind;
  storageKey: string;
  sha256: string;
  bytes: number;
  filename: string;
  mimeType: string;
  disposition: "inline" | "attachment";
};

function safeDownloadFilename(value: string | null, fallback: string) {
  const basename = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/\u0000-\u001f\u007f]/gu, "_")
    .trim()
    .slice(0, 180);
  return basename || fallback;
}

function safeLogoMimeType(value: string | null) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/avif",
    "image/gif",
  ].includes(normalized)
    ? normalized
    : "application/octet-stream";
}

/**
 * Resolve only metadata owned by this build generation. The deterministic
 * storage key check prevents a corrupted row from reading another build's
 * immutable artifact even when the authenticated user is the same.
 */
export function resolveKnowledgeBaseArtifactDescriptor(
  build: ArtifactBuild,
  kind: KnowledgeBuildArtifactKind,
): KnowledgeBaseArtifactDescriptor {
  if (kind === "logo") {
    if (
      !build.logoStorageKey ||
      !knowledgeBuildArtifactStorageKeyBelongsTo({
        storageKey: build.logoStorageKey,
        userId: build.userId,
        buildId: build.id,
        generation: build.generation,
        kind,
      }) ||
      !build.logoSha256 ||
      !build.logoBytes
    ) {
      throw new KnowledgeBuildArtifactError(
        "ARTIFACT_NOT_FOUND",
        "企业官方主 Logo 尚未完成持久化",
      );
    }
    return {
      kind,
      storageKey: build.logoStorageKey,
      sha256: build.logoSha256,
      bytes: build.logoBytes,
      filename: safeDownloadFilename(build.logoFilename, "official-logo"),
      mimeType: safeLogoMimeType(build.logoMimeType),
      disposition: "inline",
    };
  }

  // The additive rollout gives pre-0061 rows `not_started` before the data
  // backfill can classify their already-persisted package. Keep those durable
  // legacy packages downloadable during a rolling deploy. New finalization
  // clears the package columns before setting `preparing`, so this fallback
  // cannot expose a stale package from a newer revision.
  const packageStateAllowsDurableLegacyBytes =
    build.packageStatus === "ready" ||
    build.packageStatus === "not_started" ||
    build.packageStatus == null;
  if (
    (build.status !== "ready_to_publish" && build.status !== "published") ||
    !packageStateAllowsDurableLegacyBytes ||
    !build.packageStorageKey ||
    !knowledgeBuildArtifactStorageKeyBelongsTo({
      storageKey: build.packageStorageKey,
      userId: build.userId,
      buildId: build.id,
      generation: build.generation,
      kind,
    }) ||
    !build.packageArchiveSha256 ||
    !build.packageSizeBytes
  ) {
    throw new KnowledgeBuildArtifactError(
      "ARTIFACT_NOT_FOUND",
      "知识库最终 ZIP 尚未完成持久化和校验",
    );
  }
  return {
    kind,
    storageKey: build.packageStorageKey,
    sha256: build.packageArchiveSha256,
    bytes: build.packageSizeBytes,
    filename: safeDownloadFilename(
      build.packageFilename,
      "frontmind-knowledge-base.zip",
    ),
    mimeType: "application/zip",
    disposition: "attachment",
  };
}

function sendArtifactError(res: Response, error: unknown) {
  if (error instanceof KnowledgeBaseMaterializedAssetError) {
    res
      .status(error.code === "WORKING_SET_RESOURCE_NOT_FOUND" ? 404 : 409)
      .json({
        error: {
          code: error.code,
          message:
            error.code === "WORKING_SET_RESOURCE_NOT_FOUND"
              ? "该知识库资源不属于当前内容版本"
              : "当前知识库资源完整性复核未通过",
        },
      });
    return;
  }
  if (error instanceof KnowledgeBuildArtifactError) {
    const status = error.code === "ARTIFACT_NOT_FOUND" ? 404 : 409;
    res.status(status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (
    error instanceof KnowledgeArchiveValidationError ||
    error instanceof KnowledgeBasePackageBindingError
  ) {
    res.status(409).json({
      error: {
        code: "ARTIFACT_INTEGRITY_MISMATCH",
        message: "知识库最终 ZIP 安全或结构复核未通过",
      },
    });
    return;
  }
  // Archive errors may contain customer filenames or decoded manifest text.
  // Keep runtime logs on the same allowlisted, content-free contract as the
  // reconcile worker; the authenticated response below remains actionable.
  console.error(
    "[KnowledgeBaseArtifact] durable_read_failed",
    JSON.stringify({ errorCode: "ARTIFACT_READ_FAILED" }),
  );
  res.status(500).json({
    error: {
      code: "ARTIFACT_READ_FAILED",
      message: "知识库资源读取失败，请稍后重试",
    },
  });
}

async function serveWorkingSetResource(
  req: FrontMindRequest,
  res: Response,
  kind: "asset" | "evidence",
) {
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }
  const buildId = String(req.params.buildId || "").trim();
  const db = await getDb();
  if (!db) {
    res.status(503).json({
      error: { code: "DATABASE_UNAVAILABLE", message: "数据库暂不可用" },
    });
    return;
  }
  const build = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, buildId),
          eq(knowledgeBaseBuilds.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  if (!build || build.userId !== userId) {
    res.status(404).json({
      error: { code: "BUILD_NOT_FOUND", message: "知识库构建记录不存在" },
    });
    return;
  }
  try {
    const active = await readValidatedActiveKnowledgeBaseWorkingSet({
      db,
      build,
    });
    const resource = resolveKnowledgeBaseWorkingSetResource({
      buildId,
      workingSet: active.validated,
      kind,
      expectedSha256: String(req.params.sha256 || ""),
      ...(kind === "asset"
        ? { assetId: String(req.params.assetId || "") }
        : {
            leafId: String(req.params.leafId || ""),
            pathSha256: String(req.params.pathSha256 || ""),
          }),
    });
    const digest = createHash("sha256").update(resource.bytes).digest("hex");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", resource.mimeType);
    res.setHeader("Content-Length", String(resource.bytes.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("ETag", `\"sha256-${digest}\"`);
    res.setHeader(
      "Content-Disposition",
      `${resource.disposition}; filename*=UTF-8''${encodeURIComponent(resource.filename)}`,
    );
    res.end(resource.bytes);
  } catch (error) {
    sendArtifactError(res, error);
  }
}

async function serveBuildArtifact(
  req: FrontMindRequest,
  res: Response,
  kind: KnowledgeBuildArtifactKind,
) {
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }
  const buildId = String(req.params.buildId || "").trim();
  const db = await getDb();
  if (!db) {
    res.status(503).json({
      error: { code: "DATABASE_UNAVAILABLE", message: "数据库暂不可用" },
    });
    return;
  }

  const build = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, buildId),
          eq(knowledgeBaseBuilds.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  if (!build || build.userId !== userId) {
    res.status(404).json({
      error: { code: "BUILD_NOT_FOUND", message: "知识库构建记录不存在" },
    });
    return;
  }

  try {
    const descriptor = resolveKnowledgeBaseArtifactDescriptor(build, kind);
    const buffer = await readKnowledgeBuildArtifact({
      userId,
      buildId: build.id,
      generation: build.generation,
      kind,
      expectedSha256: descriptor.sha256,
      expectedBytes: descriptor.bytes,
      storageKey: descriptor.storageKey,
    });
    if (kind === "package") {
      const nodes = await db
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id));
      if (isDashboardOwnedKnowledgePackageBuild(build)) {
        await readDashboardOwnedKnowledgePackage({
          buffer,
          expected: {
            buildId: build.id,
            generation: build.generation,
            revision: build.revision,
            companyName: build.companyName,
          },
          nodes,
        });
      } else {
        await validateKnowledgeArchiveForDownload({
          buffer,
          sourceFileName: descriptor.filename,
          expectedSha256: descriptor.sha256,
          expectedBytes: descriptor.bytes,
          validationProfile:
            build.skillVersion === "1"
              ? "historical"
              : "dashboard-enterprise-v1",
          archiveContractVersions: knowledgeBaseArchiveReadContractVersions(
            build.skillVersion,
          ),
          dashboardEnterpriseMinLeaves: knowledgeBaseTreePolicy(
            build.treePolicyVersion,
          ).minLeaves,
          requireDashboardAdaptiveFormalGate: build.treePolicyVersion === 2,
          ...(build.skillVersion === "3" || build.skillVersion === "4"
            ? {
                validateParsed: async (parsed) => {
                  if (
                    build.skillVersion === "4" &&
                    parsed.packageBuildRevision !== build.revision
                  ) {
                    throw new KnowledgeBuildArtifactError(
                      "ARTIFACT_INTEGRITY_MISMATCH",
                      "知识库最终 ZIP buildRevision 与已绑定版本不一致",
                    );
                  }
                  const {
                    expectedCustomerUploads,
                    expectedOfficialLogoUpload,
                    expectedOfficialLogoProvenance,
                  } = knowledgeBaseArchiveRequiresV4UploadEvidence(
                    build.skillVersion,
                    parsed.packageSchemaVersion,
                  )
                    ? await verifiedKnowledgeBasePackageUploadEvidenceForBuild({
                        userId,
                        buildId: build.id,
                        generation: build.generation,
                        officialLogoSha256: build.logoSha256,
                        packageArchiveSha256: build.packageArchiveSha256,
                      })
                    : {
                        expectedCustomerUploads: [],
                        expectedOfficialLogoUpload: undefined,
                        expectedOfficialLogoProvenance: undefined,
                      };
                  assertKnowledgeBasePackageMatchesBuild({
                    nodes: nodes.map((node) => ({
                      leafId: node.leafId,
                      title: node.title,
                      branchId: node.branchId,
                      branchTitle: node.branchTitle,
                      ordinal: node.ordinal,
                      status: node.status,
                      contentMarkdown: node.contentMarkdown,
                      contentSha256: node.contentSha256,
                    })),
                    documents: parsed.documents,
                    assets: parsed.assets,
                    expectedLogoSha256: String(build.logoSha256 || ""),
                    packageSchemaVersion: parsed.packageSchemaVersion,
                    expectedCustomerUploads,
                    expectedOfficialLogoUpload,
                    expectedOfficialLogoProvenance,
                    legacyV3Compatibility: build.skillVersion === "3",
                    legacyV4ReadCompatibility: build.skillVersion === "4",
                  });
                  if (parsed.packageSchemaVersion === 4) {
                    await assertKnowledgeBaseCustomerUploadVisualBindings({
                      assets: parsed.assets,
                      expectedUploads: expectedCustomerUploads,
                      readPackagedAssetBytes: readStoredKnowledgeAssetBytes,
                    });
                  }
                },
              }
            : {}),
        });
      }
    }
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", descriptor.mimeType);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("ETag", `\"sha256-${descriptor.sha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `${descriptor.disposition}; filename*=UTF-8''${encodeURIComponent(
        descriptor.filename,
      )}`,
    );
    res.end(buffer);
  } catch (error) {
    sendArtifactError(res, error);
  }
}

function sendCustomerUploadPreviewError(res: Response, error: unknown) {
  if (error instanceof CustomerUploadPreviewError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error(
    "[KnowledgeBaseArtifact] customer_upload_preview_failed",
    JSON.stringify({ errorCode: "CUSTOMER_UPLOAD_PREVIEW_FAILED" }),
  );
  res.status(500).json({
    error: {
      code: "CUSTOMER_UPLOAD_PREVIEW_FAILED",
      message: "补充图片读取失败，请稍后重试",
    },
  });
}

function safePreviewFilename(value: string) {
  const filename = safeDownloadFilename(value, "customer-upload");
  const basename = filename.replace(/\.[^.]+$/u, "").slice(0, 170);
  return `${basename || "customer-upload"}.png`;
}

function isPotentialSvg(
  bytes: Buffer,
  declaredMimeType: string,
  filename: string,
) {
  if (
    declaredMimeType.toLowerCase() === "image/svg+xml" ||
    /\.svg$/iu.test(filename)
  ) {
    return true;
  }
  const prefix = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (
    prefix.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ||
    prefix.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))
  ) {
    return true;
  }
  return /^\s*</u.test(prefix.toString("utf8").replace(/^\uFEFF/u, ""));
}

function assertSafeSvgSource(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_CUSTOMER_UPLOAD_SVG_BYTES) {
    throw new CustomerUploadPreviewError(
      413,
      "CUSTOMER_UPLOAD_TOO_LARGE",
      "该 SVG 超过安全预览大小限制",
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/u, "");
  } catch {
    throw new CustomerUploadPreviewError(
      415,
      "CUSTOMER_UPLOAD_IMAGE_INVALID",
      "该 SVG 不是有效的 UTF-8 图片",
    );
  }
  const withoutXmlDeclaration = source.replace(
    /^\s*<\?xml(?:\s+[^?]*)?\?>/iu,
    "",
  );
  if (
    !/^\s*<svg\b/iu.test(withoutXmlDeclaration) ||
    /\u0000/u.test(source) ||
    /<!\s*(?:doctype|entity)\b/iu.test(source) ||
    /<\s*(?:script|foreignObject|iframe|object|embed|image|feImage|audio|video|canvas|style|link|meta)\b/iu.test(
      source,
    ) ||
    /\bon[a-z][\w:.-]*\s*=/iu.test(source) ||
    /\b(?:src|xml:base)\s*=/iu.test(source) ||
    /(?:@import|url\s*\()/iu.test(source) ||
    /<\?/u.test(withoutXmlDeclaration) ||
    /\bencoding\s*=\s*["'](?!utf-?8["'])/iu.test(source)
  ) {
    throw new CustomerUploadPreviewError(
      415,
      "CUSTOMER_UPLOAD_IMAGE_UNSAFE",
      "该 SVG 含有不允许的活动内容或外部资源",
    );
  }

  const hrefAssignments = source.match(/\b(?:xlink:)?href\s*=/giu)?.length || 0;
  const hrefValues = [
    ...source.matchAll(/\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/giu),
  ];
  if (
    hrefValues.length !== hrefAssignments ||
    hrefValues.some(
      (match) => !/^#[A-Za-z_][\w:.-]*$/u.test(match[1] || match[2] || ""),
    )
  ) {
    throw new CustomerUploadPreviewError(
      415,
      "CUSTOMER_UPLOAD_IMAGE_UNSAFE",
      "该 SVG 含有不允许的外部引用",
    );
  }
}

async function renderSafeCustomerUploadPreview(input: {
  bytes: Buffer;
  declaredMimeType: string;
  filename: string;
}) {
  const svg = isPotentialSvg(
    input.bytes,
    input.declaredMimeType,
    input.filename,
  );
  if (svg) assertSafeSvgSource(input.bytes);

  try {
    const decoder = sharp(input.bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_CUSTOMER_UPLOAD_PIXELS,
      sequentialRead: true,
      ...(svg ? { density: 144 } : {}),
    });
    const metadata = await decoder.metadata();
    const height = metadata.pageHeight || metadata.height;
    if (
      !metadata.width ||
      !height ||
      metadata.width * height > MAX_CUSTOMER_UPLOAD_PIXELS ||
      (svg
        ? metadata.format !== "svg"
        : !SAFE_CUSTOMER_RASTER_FORMATS.has(String(metadata.format || "")))
    ) {
      throw new Error("CUSTOMER_UPLOAD_DECODE_MISMATCH");
    }
    const rendered = await decoder
      .rotate()
      .resize({
        width: MAX_CUSTOMER_PREVIEW_DIMENSION,
        height: MAX_CUSTOMER_PREVIEW_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    if (
      !rendered.info.width ||
      !rendered.info.height ||
      rendered.info.width * rendered.info.height > MAX_CUSTOMER_UPLOAD_PIXELS ||
      !rendered.data.length ||
      rendered.data.length > MAX_CUSTOMER_PREVIEW_BYTES
    ) {
      throw new Error("CUSTOMER_UPLOAD_PREVIEW_INVALID");
    }
    return rendered.data;
  } catch (error) {
    if (error instanceof CustomerUploadPreviewError) throw error;
    throw new CustomerUploadPreviewError(
      415,
      "CUSTOMER_UPLOAD_IMAGE_INVALID",
      "该补充图片无法安全解码",
    );
  }
}

async function readCustomerUploadBytes(
  stored: NonNullable<Awaited<ReturnType<typeof readStoredPresalesFile>>>,
) {
  if (
    !Number.isSafeInteger(stored.sizeBytes) ||
    stored.sizeBytes < 1 ||
    stored.sizeBytes > MAX_CUSTOMER_UPLOAD_SOURCE_BYTES
  ) {
    throw new CustomerUploadPreviewError(
      413,
      "CUSTOMER_UPLOAD_TOO_LARGE",
      "该补充图片超过安全预览大小限制",
    );
  }
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += bytes.length;
    if (bytesRead > MAX_CUSTOMER_UPLOAD_SOURCE_BYTES) {
      throw new CustomerUploadPreviewError(
        413,
        "CUSTOMER_UPLOAD_TOO_LARGE",
        "该补充图片超过安全预览大小限制",
      );
    }
    chunks.push(bytes);
  }
  if (bytesRead !== stored.sizeBytes) {
    throw new CustomerUploadPreviewError(
      409,
      "CUSTOMER_UPLOAD_INTEGRITY_MISMATCH",
      "补充图片完整性校验未通过",
    );
  }
  return Buffer.concat(chunks, bytesRead);
}

function usesPersistedCustomerUploadEvidence(build: ArtifactBuild) {
  return (
    build.skillVersion === "4" &&
    (build.status === "ready_to_publish" || build.status === "published") &&
    /^[a-f0-9]{64}$/u.test(String(build.packageArchiveSha256 || ""))
  );
}

async function renderCustomerUploadImageForBuild(input: {
  userId: number;
  build: ArtifactBuild;
  image: KnowledgeBaseCustomerUploadImage;
}) {
  const sourceBytes = usesPersistedCustomerUploadEvidence(input.build)
    ? await persistedKnowledgeBaseCustomerUploadBytesForBuild({
        userId: input.userId,
        buildId: input.build.id,
        generation: input.build.generation,
        packageArchiveSha256: input.build.packageArchiveSha256!,
        sourceSha256: input.image.sourceSha256,
      })
    : await (async () => {
        const stored = await readStoredPresalesFile(input.image.fileId);
        if (
          !stored ||
          stored.filename !== input.image.filename ||
          stored.sizeBytes !== input.image.sizeBytes ||
          stored.sha256?.toLowerCase() !== input.image.sourceSha256
        ) {
          throw new CustomerUploadPreviewError(
            409,
            "CUSTOMER_UPLOAD_INTEGRITY_MISMATCH",
            "补充图片完整性校验未通过",
          );
        }
        return readCustomerUploadBytes(stored);
      })();
  if (
    createHash("sha256").update(sourceBytes).digest("hex") !==
    input.image.sourceSha256
  ) {
    throw new CustomerUploadPreviewError(
      409,
      "CUSTOMER_UPLOAD_INTEGRITY_MISMATCH",
      "补充图片完整性校验未通过",
    );
  }
  return renderSafeCustomerUploadPreview({
    bytes: sourceBytes,
    declaredMimeType: input.image.mimeType,
    filename: input.image.filename,
  });
}

function opaqueImageFilename(mimeType: string, prefix: string) {
  const extension =
    {
      "image/avif": "avif",
      "image/gif": "gif",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/svg+xml": "svg",
      "image/webp": "webp",
    }[mimeType.toLowerCase()] || "img";
  return `${prefix}.${extension}`;
}

function sendOpaquePublicResource(input: {
  res: Response;
  bytes: Buffer;
  mimeType: string;
  filename: string;
}) {
  input.res.setHeader("Cache-Control", "private, no-store, max-age=0");
  input.res.setHeader("Pragma", "no-cache");
  input.res.setHeader("Content-Type", input.mimeType);
  input.res.setHeader("Content-Length", String(input.bytes.length));
  input.res.setHeader("X-Content-Type-Options", "nosniff");
  input.res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  input.res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  // No source digest, asset id, path, turn id, or upload filename is reflected
  // in headers on the new endpoint. The HMAC URL is already cache-unique.
  input.res.setHeader(
    "Content-Disposition",
    `inline; filename="${input.filename}"`,
  );
  input.res.end(input.bytes);
}

async function serveCustomerUploadPreview(
  req: FrontMindRequest,
  res: Response,
) {
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }
  const buildId = String(req.params.buildId || "").trim();
  const turnId = String(req.params.turnId || "").trim();
  const sourceSha256 = String(req.params.sourceSha || "")
    .trim()
    .toLowerCase();
  const rawIndex = String(req.params.index || "").trim();
  if (
    !buildId ||
    !turnId ||
    !/^(?:0|[1-9]\d?)$/u.test(rawIndex) ||
    !/^[a-f0-9]{64}$/u.test(sourceSha256)
  ) {
    res.status(404).json({
      error: { code: "CUSTOMER_UPLOAD_NOT_FOUND", message: "补充图片不存在" },
    });
    return;
  }
  const index = Number(rawIndex);
  const db = await getDb();
  if (!db) {
    res.status(503).json({
      error: { code: "DATABASE_UNAVAILABLE", message: "数据库暂不可用" },
    });
    return;
  }

  const build = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, buildId),
          eq(knowledgeBaseBuilds.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  if (!build || build.userId !== userId) {
    res.status(404).json({
      error: { code: "CUSTOMER_UPLOAD_NOT_FOUND", message: "补充图片不存在" },
    });
    return;
  }

  const turn = (
    await db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.id, turnId),
          eq(conversationTurns.userId, userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          eq(conversationTurns.status, "completed"),
        ),
      )
      .limit(1)
  )[0];
  if (
    !turn ||
    turn.status !== "completed" ||
    turn.userId !== userId ||
    turn.buildId !== build.id ||
    turn.buildGeneration !== build.generation
  ) {
    res.status(404).json({
      error: { code: "CUSTOMER_UPLOAD_NOT_FOUND", message: "补充图片不存在" },
    });
    return;
  }

  try {
    const usePersistedEvidence = usesPersistedCustomerUploadEvidence(build);
    const image = (
      usePersistedEvidence
        ? declaredKnowledgeBaseCustomerUploadImagesFromTurn(turn)
        : await verifiedKnowledgeBaseCustomerUploadImagesFromTurn(turn)
    ).find(
      (candidate) =>
        candidate.turnId === turnId &&
        candidate.index === index &&
        candidate.sourceSha256 === sourceSha256,
    );
    if (!image) {
      throw new CustomerUploadPreviewError(
        404,
        "CUSTOMER_UPLOAD_NOT_FOUND",
        "补充图片不存在",
      );
    }
    const preview = await renderCustomerUploadImageForBuild({
      userId,
      build,
      image,
    });
    const previewSha256 = createHash("sha256").update(preview).digest("hex");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(preview.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("ETag", `\"sha256-${previewSha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(
        safePreviewFilename(image.filename),
      )}`,
    );
    res.end(preview);
  } catch (error) {
    sendCustomerUploadPreviewError(res, error);
  }
}

async function serveOpaqueKnowledgeBaseResource(
  req: FrontMindRequest,
  res: Response,
) {
  const userId = req.frontmindUser?.id;
  if (!userId) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "请先登录" },
    });
    return;
  }
  const parsedHandle = parseKnowledgeBasePublicResourceHandle(
    req.params.handle,
  );
  if (!parsedHandle) {
    res.status(404).json({
      error: { code: "RESOURCE_NOT_FOUND", message: "知识库资源不存在" },
    });
    return;
  }
  const db = await getDb();
  if (!db) {
    res.status(503).json({
      error: { code: "DATABASE_UNAVAILABLE", message: "数据库暂不可用" },
    });
    return;
  }

  // The build id is never encoded into the public URL. Resolve the first HMAC
  // half only inside the authenticated user's build set, then re-authorize the
  // second half against the current generation and immutable resource proof.
  const builds = await db
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.userId, userId));
  const build = builds.find(
    (candidate: typeof knowledgeBaseBuilds.$inferSelect) =>
      knowledgeBasePublicBuildSelectorMatches({
        suppliedSelector: parsedHandle.buildSelector,
        buildId: candidate.id,
      }),
  );
  if (!build || build.userId !== userId) {
    res.status(404).json({
      error: { code: "RESOURCE_NOT_FOUND", message: "知识库资源不存在" },
    });
    return;
  }

  try {
    if (
      build.logoSha256 &&
      knowledgeBasePublicResourceHandleMatches({
        suppliedHandle: parsedHandle.handle,
        buildId: build.id,
        kind: "logo",
        internalIdentity: knowledgeBaseOfficialLogoInternalIdentity({
          generation: build.generation,
          sha256: build.logoSha256,
        }),
      })
    ) {
      const descriptor = resolveKnowledgeBaseArtifactDescriptor(build, "logo");
      const bytes = await readKnowledgeBuildArtifact({
        userId,
        buildId: build.id,
        generation: build.generation,
        kind: "logo",
        expectedSha256: descriptor.sha256,
        expectedBytes: descriptor.bytes,
        storageKey: descriptor.storageKey,
      });
      sendOpaquePublicResource({
        res,
        bytes,
        mimeType: descriptor.mimeType,
        filename: opaqueImageFilename(descriptor.mimeType, "enterprise-logo"),
      });
      return;
    }

    let materializedIntegrityError: unknown = null;
    try {
      const active = await readValidatedActiveKnowledgeBaseWorkingSet({
        db,
        build,
      });
      const resource = resolveKnowledgeBaseWorkingSetResourceByOpaqueHandle({
        suppliedHandle: parsedHandle.handle,
        buildId: build.id,
        workingSet: active.validated,
      });
      if (resource) {
        sendOpaquePublicResource({
          res,
          bytes: resource.bytes,
          mimeType: resource.mimeType,
          filename: opaqueImageFilename(
            resource.mimeType,
            "knowledge-base-image",
          ),
        });
        return;
      }
    } catch (error) {
      if (
        error instanceof KnowledgeBaseMaterializedAssetError &&
        error.code === "WORKING_SET_RESOURCE_INTEGRITY_MISMATCH"
      ) {
        materializedIntegrityError = error;
      }
    }

    const turns = await db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          eq(conversationTurns.status, "completed"),
        ),
      );
    for (const turn of turns) {
      let declared: KnowledgeBaseCustomerUploadImage[];
      try {
        declared = declaredKnowledgeBaseCustomerUploadImagesFromTurn(turn);
      } catch {
        // An unrelated legacy turn with an incomplete ledger cannot authorize
        // a resource and must not block an otherwise valid current resource.
        continue;
      }
      const claimed = declared.find((candidate) =>
        knowledgeBasePublicResourceHandleMatches({
          suppliedHandle: parsedHandle.handle,
          buildId: build.id,
          kind: "customer_upload",
          internalIdentity:
            knowledgeBaseCustomerUploadInternalIdentity(candidate),
        }),
      );
      if (!claimed) continue;
      const image = usesPersistedCustomerUploadEvidence(build)
        ? claimed
        : (await verifiedKnowledgeBaseCustomerUploadImagesFromTurn(turn)).find(
            (candidate) =>
              candidate.turnId === claimed.turnId &&
              candidate.index === claimed.index &&
              candidate.sourceSha256 === claimed.sourceSha256,
          );
      if (!image) {
        throw new CustomerUploadPreviewError(
          409,
          "CUSTOMER_UPLOAD_INTEGRITY_MISMATCH",
          "补充图片完整性校验未通过",
        );
      }
      const preview = await renderCustomerUploadImageForBuild({
        userId,
        build,
        image,
      });
      sendOpaquePublicResource({
        res,
        bytes: preview,
        mimeType: "image/png",
        filename: "knowledge-base-image.png",
      });
      return;
    }

    if (materializedIntegrityError) throw materializedIntegrityError;
    res.status(404).json({
      error: { code: "RESOURCE_NOT_FOUND", message: "知识库资源不存在" },
    });
  } catch (error) {
    if (error instanceof CustomerUploadPreviewError) {
      sendCustomerUploadPreviewError(res, error);
      return;
    }
    sendArtifactError(res, error);
  }
}

router.get("/resources/:handle", (req: FrontMindRequest, res) => {
  void serveOpaqueKnowledgeBaseResource(req, res);
});

router.get(
  "/:buildId/customer-uploads/:turnId/:index/:sourceSha",
  (req: FrontMindRequest, res) => {
    void serveCustomerUploadPreview(req, res);
  },
);

router.get(
  "/:buildId/working-set/assets/:assetId/:sha256",
  (req: FrontMindRequest, res) => {
    void serveWorkingSetResource(req, res, "asset");
  },
);

router.get(
  "/:buildId/working-set/evidence/:leafId/:pathSha256/:sha256",
  (req: FrontMindRequest, res) => {
    void serveWorkingSetResource(req, res, "evidence");
  },
);

router.get("/:buildId/logo", (req: FrontMindRequest, res) => {
  void serveBuildArtifact(req, res, "logo");
});

router.get("/:buildId/package", (req: FrontMindRequest, res) => {
  void serveBuildArtifact(req, res, "package");
});

export default router;
