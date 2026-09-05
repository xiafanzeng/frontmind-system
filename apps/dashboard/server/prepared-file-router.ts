import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import { getEffectiveDecryptedCredentialForAccount } from "./auth-service";
import {
  PreparedFileError,
  preparedFilePublicStatus,
  preparedFileService,
  type PreparedFileManifest,
} from "./prepared-file-service";
import { assertDeliveryProjectContext } from "./delivery-role-service";
import {
  OwnedFileContentError,
  ownedFileContentResolver,
} from "./owned-file-content-resolver";
import {
  bindDownloadUrlToProject,
  createSignedDownloadToken,
  resolveDownloadProjectContext,
  SignedDownloadTokenError,
  verifySignedDownloadToken,
} from "./signed-download-token";

const router = Router();
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  next();
});

function requestProjectAssignmentId(req: Request) {
  return req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null;
}

function downloadProjectAssignmentId(req: Request) {
  return resolveDownloadProjectContext({
    middleware: req.frontmindDeliveryProjectContext?.projectAssignmentId,
    query: req.query.projectAssignmentId,
    header: req.headers["x-delivery-project-assignment-id"],
  });
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(
  rangeHeader: string | undefined,
  size: number,
): ByteRange | null | "invalid" {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size < 1) return "invalid";

  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function sanitizeFilename(filename: string) {
  const source = ["ma", "nus"].join("");
  const replaced = String(filename || "document.pdf").replace(
    new RegExp(source, "gi"),
    "FrontMind",
  );
  return replaced.replace(/[\\/\0"]/g, "_").trim() || "document.pdf";
}

function contentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
) {
  const safe = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safe);
  return `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}

function sendPreparedError(res: Response, error: unknown) {
  if (error instanceof SignedDownloadTokenError) {
    const secretUnavailable =
      error.code === "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE";
    res.status(secretUnavailable ? 503 : 410).json({
      error: {
        message: secretUnavailable
          ? "下载服务签名配置不可用，请联系管理员"
          : "下载链接已失效",
        code: secretUnavailable
          ? "DOWNLOAD_TOKEN_SERVICE_UNAVAILABLE"
          : "DOWNLOAD_LINK_EXPIRED",
      },
    });
    return;
  }
  if (error instanceof OwnedFileContentError) {
    res.status(error.statusCode).json({
      error: {
        message: error.message,
        code: error.code,
        retryable: error.retryable,
        recoveryAction: error.recoveryAction,
        expiresAt: error.expiresAt,
      },
    });
    return;
  }
  if (error instanceof PreparedFileError) {
    const status =
      error.options.statusCode ??
      (error.code === "ASSET_NOT_FOUND"
        ? 404
        : error.code === "SOURCE_EXPIRED" || error.code === "ASSET_EXPIRED"
          ? 410
          : error.code === "INSUFFICIENT_STORAGE"
            ? 507
            : error.code === "SOURCE_FORBIDDEN"
              ? 403
              : 400);
    res.status(status).json({
      error: {
        message: error.message,
        code: error.code,
        retryable: error.retryable,
        recoveryAction: error.recoveryAction,
        expiresAt: error.expiresAt,
      },
    });
    return;
  }
  console.error("[PreparedFiles] Request failed", error);
  res.status(500).json({
    error: {
      message: "文件准备服务暂时不可用",
      code: "PREPARED_FILE_SERVICE_ERROR",
    },
  });
}

export function extractPreparedSource(fileUrl: string) {
  const parsed = new URL(fileUrl, "http://frontmind.local");
  const fileMatch = parsed.pathname.match(
    /(?:\/api\/frontmind)?\/v1\/files\/([^/]+)/,
  );
  if (fileMatch?.[1]) {
    try {
      return {
        kind: "file" as const,
        fileId: decodeURIComponent(fileMatch[1]),
      };
    } catch {
      throw new PreparedFileError("INVALID_FILE_SOURCE", "文件地址编码无效");
    }
  }
  if (parsed.pathname.endsWith("/api/frontmind/proxy-download")) {
    const externalUrl = parsed.searchParams.get("url");
    if (externalUrl) {
      return { kind: "external" as const, url: externalUrl };
    }
  }
  if (/^https?:\/\//i.test(fileUrl)) {
    return { kind: "external" as const, url: fileUrl };
  }
  throw new PreparedFileError("INVALID_FILE_SOURCE", "无法识别 PDF 文件来源");
}

export function resolvePreparedSourceInput(body: unknown) {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  // fileId is opaque. Preserve the exact identifier and use trim only for the
  // empty-value check.
  const fileId = String(value.fileId ?? "");
  const fileUrl = String(value.fileUrl || "").trim();
  const hasFileId = Boolean(fileId.trim());
  if (hasFileId && fileUrl) {
    throw new PreparedFileError(
      "AMBIGUOUS_FILE_SOURCE",
      "fileId 与 fileUrl 只能提供一个",
    );
  }
  if (hasFileId) {
    if (fileId.length > 255 || /[\0\r\n]/.test(fileId)) {
      throw new PreparedFileError("INVALID_FILE_SOURCE", "文件 ID 无效");
    }
    return { kind: "file" as const, fileId };
  }
  if (fileUrl) return extractPreparedSource(fileUrl);
  throw new PreparedFileError("MISSING_FILE_SOURCE", "缺少 fileId 或 fileUrl");
}

export function boundedPreparedDownloadExpiry(
  now: number,
  sourceExpiresAt?: number,
) {
  return Math.min(
    now + DOWNLOAD_TOKEN_TTL_MS,
    sourceExpiresAt ?? Number.POSITIVE_INFINITY,
  );
}

router.post("/prepare", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    const filename = sanitizeFilename(
      String(req.body?.fileName || "document.pdf"),
    );
    const source = resolvePreparedSourceInput(req.body);
    if (source.kind === "file") {
      const authorization = await ownedFileContentResolver.authorize({
        ownerUserId,
        fileId: source.fileId,
        projectAssignmentId: requestProjectAssignmentId(req),
      });
      res.json(
        await preparedFileService.registerFile({
          ownerUserId,
          credentialId: authorization.credentialId,
          sourceKind: authorization.sourceKind,
          sourceAuthorityId: authorization.sourceAuthorityId,
          projectAssignmentId: requestProjectAssignmentId(req),
          fileId: source.fileId,
          filename,
          expiresAt: authorization.expiresAt,
        }),
      );
      return;
    }

    const credential =
      await getEffectiveDecryptedCredentialForAccount(ownerUserId);
    res.json(
      await preparedFileService.registerExternal({
        ownerUserId,
        credentialId: credential?.id || "external",
        projectAssignmentId: requestProjectAssignmentId(req),
        url: source.url,
        filename,
      }),
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.get("/:assetId/status", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    res.json(
      await preparedFileService.getStatus(
        req.params.assetId,
        ownerUserId,
        requestProjectAssignmentId(req),
      ),
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.post("/:assetId/retry", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    res.json(
      await preparedFileService.retry(
        req.params.assetId,
        ownerUserId,
        requestProjectAssignmentId(req),
      ),
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.post("/:assetId/download-token", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId,
      requestProjectAssignmentId(req),
    );
    if (manifest.status !== "ready") {
      res.status(409).json({
        error: {
          message: "文件仍在准备中",
          code: "FILE_NOT_READY",
          status: manifest.status,
          phase: manifest.phase,
        },
      });
      return;
    }
    const expiresAt = boundedPreparedDownloadExpiry(
      Date.now(),
      manifest.expiresAt,
    );
    if (expiresAt <= Date.now()) {
      throw new PreparedFileError(
        "SOURCE_EXPIRED",
        "文件已超过 30 天，请重新上传",
        {
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: manifest.expiresAt,
          statusCode: 410,
        },
      );
    }
    const sourceAuthorityId =
      manifest.sourceAuthorityId ?? manifest.credentialId;
    if (!sourceAuthorityId) {
      throw new PreparedFileError(
        "SOURCE_FORBIDDEN",
        "文件缺少可信的所有权来源",
        { statusCode: 403, recoveryAction: "contact_admin" },
      );
    }
    const token = createSignedDownloadToken({
      kind: "prepared_file",
      assetId: manifest.id,
      userId: ownerUserId,
      credentialId: sourceAuthorityId,
      projectAssignmentId: requestProjectAssignmentId(req),
      exp: expiresAt,
    });
    res.json({
      downloadUrl: bindDownloadUrlToProject(
        `/api/frontmind/assets/download/${token}`,
        manifest.projectAssignmentId,
      ),
      expiresAt,
    });
  } catch (error) {
    sendPreparedError(res, error);
  }
});

async function streamPreparedFile(
  req: Request,
  res: Response,
  manifest: PreparedFileManifest,
  disposition: "inline" | "attachment",
) {
  const filePath = preparedFileService.contentPath(manifest.id);
  const stat = await fs.stat(filePath);
  const range = parseByteRange(
    typeof req.headers.range === "string" ? req.headers.range : undefined,
    stat.size,
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Accept-Ranges", "bytes");
  // A fresh max-age response can bypass server authorization after the source
  // hard deadline. Prepared bytes therefore must never enter browser caches.
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader(
    "Content-Disposition",
    contentDisposition(disposition, manifest.filename),
  );
  const etag = manifest.etag ? `"${manifest.etag}"` : undefined;
  const ifNoneMatch =
    typeof req.headers["if-none-match"] === "string"
      ? req.headers["if-none-match"]
      : undefined;
  if (etag) res.setHeader("ETag", etag);
  if (
    etag &&
    !req.headers.range &&
    ifNoneMatch
      ?.split(",")
      .map((value) => value.trim())
      .includes(etag)
  ) {
    res.status(304).end();
    return;
  }

  if (range === "invalid") {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const contentLength = end - start + 1;
  res.setHeader("Content-Length", String(contentLength));
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  } else {
    res.status(200);
  }

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  preparedFileService.beginUse(manifest.id);
  const stream = createReadStream(filePath, { start, end });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    preparedFileService.endUse(manifest.id);
  };
  stream.on("error", (error) => {
    release();
    if (!res.headersSent) sendPreparedError(res, error);
    else res.destroy(error);
  });
  stream.on("close", release);
  res.on("close", () => {
    if (!res.writableEnded) stream.destroy();
    release();
  });
  stream.pipe(res);
}

router.get("/download/:token", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(410).json({
        error: {
          message: "下载链接已失效",
          code: "DOWNLOAD_LINK_EXPIRED",
        },
      });
      return;
    }
    const token = verifySignedDownloadToken(req.params.token, "prepared_file");
    if (token.userId !== ownerUserId) {
      res.status(403).json({
        error: {
          message: "下载链接不属于当前账号",
          code: "DOWNLOAD_FORBIDDEN",
        },
      });
      return;
    }
    if (token.projectAssignmentId !== downloadProjectAssignmentId(req)) {
      res.status(403).json({
        error: {
          message: "下载链接不属于当前客户项目",
          code: "DELIVERY_PROJECT_CONTEXT_FORBIDDEN",
        },
      });
      return;
    }
    if (req.frontmindUser?.role === "delivery_member") {
      if (!token.projectAssignmentId) {
        res.status(403).json({
          error: {
            message: "下载链接缺少客户项目上下文",
            code: "DELIVERY_PROJECT_CONTEXT_FORBIDDEN",
          },
        });
        return;
      }
      await assertDeliveryProjectContext({
        actor: req.frontmindUser,
        projectAssignmentId: token.projectAssignmentId,
      });
    }
    const manifest = await preparedFileService.getReadyManifest(
      token.assetId,
      ownerUserId,
      token.projectAssignmentId,
    );
    if (
      (manifest.sourceAuthorityId ?? manifest.credentialId) !==
      token.credentialId
    ) {
      throw new SignedDownloadTokenError(
        "DOWNLOAD_TOKEN_INVALID",
        "下载链接对应的文件凭据已变化",
      );
    }
    if (manifest.status !== "ready") {
      res.status(409).json({
        error: { message: "文件尚未准备完成", code: "FILE_NOT_READY" },
      });
      return;
    }
    await streamPreparedFile(req, res, manifest, "attachment");
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.get("/:assetId/content", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId,
      requestProjectAssignmentId(req),
    );
    if (manifest.status !== "ready") {
      res.status(202).json(preparedFilePublicStatus(manifest));
      return;
    }
    await streamPreparedFile(
      req,
      res,
      manifest,
      req.query.download === "1" ? "attachment" : "inline",
    );
  } catch (error) {
    sendPreparedError(res, error);
  }
});

router.head("/:assetId/content", async (req, res) => {
  try {
    const ownerUserId = req.frontmindUser?.id;
    if (!ownerUserId) {
      res.status(401).end();
      return;
    }
    const manifest = await preparedFileService.getReadyManifest(
      req.params.assetId,
      ownerUserId,
      requestProjectAssignmentId(req),
    );
    if (manifest.status !== "ready") {
      res.status(202).end();
      return;
    }
    await streamPreparedFile(req, res, manifest, "inline");
  } catch (error) {
    sendPreparedError(res, error);
  }
});

export default router;
