import type { RuntimeConfig } from "@frontmind/monitoring-config";
import { isAllowedOrigin } from "@frontmind/monitoring-config";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import type { AuthenticationService } from "./auth.js";

const DOCX_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const docxContentTypes = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
]);
const imageContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const idSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const publicAssetCapabilitySchema = z
  .string()
  .min(32)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/u);

export type PublisherUpload = {
  originalName: string;
  contentType: string;
  body: Uint8Array;
  size: number;
};

export type PublisherHttpService = {
  isCustomerFeatureEnabled(): Promise<boolean>;
  createDocxImport(input: {
    ownerId: string;
    upload: PublisherUpload;
  }): Promise<{
    importId: string;
    status: "queued";
  }>;
  createArticleAsset(input: {
    ownerId: string;
    articleId: string;
    upload: PublisherUpload;
    altText?: string;
  }): Promise<{
    assetId: string;
    contentType: "image/jpeg" | "image/png";
    width: number;
    height: number;
    publicPath: string;
  }>;
  getBatchCsv(input: {
    ownerId: string;
    batchId: string;
  }): Promise<{ filename: string; body: Uint8Array } | undefined>;
  getMediaLogo(input: { mediaResourceId: string; sha256: string }): Promise<
    | {
        body: Uint8Array;
        contentType: "image/jpeg" | "image/png";
        contentSha256: string;
      }
    | undefined
  >;
  getPublicAsset(input: { assetId: string; capability: string }): Promise<
    | {
        body: Uint8Array;
        contentType: "image/jpeg" | "image/png";
        contentSha256: string;
      }
    | undefined
  >;
  getPrivateArticleAsset?(input: {
    ownerId: string;
    articleId: string;
    assetId: string;
  }): Promise<
    | {
        body: Uint8Array;
        contentType: "image/jpeg" | "image/png";
        contentSha256: string;
      }
    | undefined
  >;
  receiveWebhookWakeup?(input: {
    rawBody: Uint8Array;
    signature: string;
  }): Promise<{ accepted: boolean }>;
};

export type PublisherHttpDependencies = {
  config: RuntimeConfig;
  auth: AuthenticationService;
  service?: PublisherHttpService;
};

const docxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: DOCX_MAX_BYTES, fields: 4 },
}).single("file");

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: IMAGE_MAX_BYTES, fields: 4 },
}).single("file");

export function registerPublisherHttpRoutes(
  app: Express,
  dependencies: PublisherHttpDependencies,
): void {
  app.post(
    "/publisher/docx-imports",
    publisherEnabled(dependencies),
    sameOrigin(dependencies.config),
    requireCustomer(dependencies.auth),
    uploadMiddleware(docxUpload),
    async (request, response, next) => {
      try {
        const file = requireFile(request, response);
        if (!file) return;
        if (
          !file.originalname.toLowerCase().endsWith(".docx") ||
          !docxContentTypes.has(file.mimetype)
        ) {
          response.status(400).json({ error: "Only .docx files are accepted" });
          return;
        }
        const ownerId = String(response.locals.publisherUserId);
        const result = await dependencies.service!.createDocxImport({
          ownerId,
          upload: toUpload(file),
        });
        response.status(202).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/publisher/articles/:articleId/assets",
    publisherEnabled(dependencies),
    sameOrigin(dependencies.config),
    requireCustomer(dependencies.auth),
    articleAssetBodyMiddleware(),
    async (request, response, next) => {
      try {
        const articleId = idSchema.parse(request.params.articleId);
        if (request.is("application/json")) {
          if (!dependencies.service!.getPrivateArticleAsset) {
            response.status(404).end();
            return;
          }
          const assetId = z
            .object({ assetId: idSchema })
            .parse(request.body).assetId;
          const result = await dependencies.service!.getPrivateArticleAsset({
            ownerId: String(response.locals.publisherUserId),
            articleId,
            assetId,
          });
          if (!result) {
            response.status(404).end();
            return;
          }
          sendPrivatePublisherImage(response, result);
          return;
        }
        const file = requireFile(request, response);
        if (!file) return;
        if (!imageContentTypes.has(file.mimetype)) {
          response.status(400).json({ error: "Unsupported image type" });
          return;
        }
        const altText = z
          .string()
          .trim()
          .max(500)
          .optional()
          .parse(request.body?.altText || undefined);
        const result = await dependencies.service!.createArticleAsset({
          ownerId: String(response.locals.publisherUserId),
          articleId,
          upload: toUpload(file),
          ...(altText ? { altText } : {}),
        });
        response.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/publisher/media-logos/:mediaResourceId/:sha256",
    publisherEnabled(dependencies),
    requireCustomer(dependencies.auth),
    async (request, response, next) => {
      try {
        const mediaResourceId = idSchema.parse(request.params.mediaResourceId);
        const sha256 = sha256Schema.parse(request.params.sha256);
        const result = await dependencies.service!.getMediaLogo({
          mediaResourceId,
          sha256,
        });
        if (!result) {
          response.status(404).end();
          return;
        }
        response.setHeader("Content-Type", result.contentType);
        response.setHeader("Content-Length", String(result.body.byteLength));
        response.setHeader("Content-Disposition", "inline");
        response.setHeader(
          "Cache-Control",
          "private, max-age=31536000, immutable",
        );
        response.setHeader("ETag", `"sha256-${result.contentSha256}"`);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.status(200).send(Buffer.from(result.body));
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/publisher/batches/:batchId.csv",
    publisherEnabled(dependencies),
    requireCustomer(dependencies.auth),
    async (request, response, next) => {
      try {
        const batchId = idSchema.parse(request.params.batchId);
        const result = await dependencies.service!.getBatchCsv({
          ownerId: String(response.locals.publisherUserId),
          batchId,
        });
        if (!result) {
          response.status(404).json({ error: "Publication batch not found" });
          return;
        }
        response.setHeader("Content-Type", "text/csv; charset=utf-8");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeCsvFilename(result.filename)}"`,
        );
        response.setHeader("Cache-Control", "private, no-store");
        response.status(200).send(Buffer.from(result.body));
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/publisher/public-assets/:assetId/:capability",
    async (request, response, next) => {
      if (
        !dependencies.config.PUBLISHER_PUBLIC_ASSETS_ENABLED ||
        !dependencies.service
      ) {
        response.status(404).end();
        return;
      }
      try {
        const assetId = idSchema.parse(request.params.assetId);
        const capability = publicAssetCapabilitySchema.parse(
          request.params.capability,
        );
        const result = await dependencies.service.getPublicAsset({
          assetId,
          capability,
        });
        if (!result) {
          response.status(404).end();
          return;
        }
        response.setHeader("Content-Type", result.contentType);
        response.setHeader("Content-Length", String(result.body.byteLength));
        response.setHeader("Content-Disposition", "inline");
        response.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
        response.setHeader("ETag", `"sha256-${result.contentSha256}"`);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        response.status(200).send(Buffer.from(result.body));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/webhooks/kol",
    (request, response, next) => {
      if (
        !dependencies.config.KOL_WEBHOOK_ENABLED ||
        !dependencies.config.KOL_WEBHOOK_SECRET ||
        !dependencies.service?.receiveWebhookWakeup
      ) {
        response.status(404).end();
        return;
      }
      next();
    },
    // Keep the exact bytes for signature verification. The callback remains a
    // wake-up signal; the service must fetch authoritative order state by GET.
    express.raw({
      type: "application/json",
      limit: dependencies.config.KOL_WEBHOOK_MAX_BYTES,
    }),
    async (request, response, next) => {
      try {
        const signature = request.get("x-kol-signature")?.trim() ?? "";
        if (!signature || !Buffer.isBuffer(request.body)) {
          response.status(400).json({ accepted: false });
          return;
        }
        if (signature.length < 16 || signature.length > 512) {
          response.status(401).json({ accepted: false });
          return;
        }
        const result = await dependencies.service!.receiveWebhookWakeup!({
          rawBody: Uint8Array.from(request.body),
          signature,
        });
        response.status(202).json({ accepted: result.accepted });
      } catch (error) {
        next(error);
      }
    },
  );
}

function publisherEnabled(dependencies: PublisherHttpDependencies) {
  return async (_request: Request, response: Response, next: NextFunction) => {
    if (
      !dependencies.config.PUBLISHER_FEATURE_ENABLED ||
      !dependencies.service
    ) {
      response.status(404).end();
      return;
    }
    try {
      if (!(await dependencies.service.isCustomerFeatureEnabled())) {
        response.status(404).end();
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function sameOrigin(config: RuntimeConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!isAllowedOrigin(request.get("origin"), config.PUBLIC_ORIGIN)) {
      response.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  };
}

function requireCustomer(auth: AuthenticationService) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const authenticated = await auth.resolve(request);
      if (!authenticated) {
        response.status(401).json({ error: "Authentication required" });
        return;
      }
      response.locals.publisherUserId = authenticated.user.id;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function uploadMiddleware(middleware: RequestHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    middleware(request, response, (error: unknown) => {
      if (error instanceof MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        response
          .status(status)
          .json({ error: "Invalid upload", code: error.code });
        return;
      }
      if (error) return next(error);
      next();
    });
  };
}

function articleAssetBodyMiddleware(): RequestHandler {
  const json = express.json({ type: "application/json", limit: "2kb" });
  const upload = uploadMiddleware(imageUpload);
  return (request, response, next) => {
    if (request.is("application/json")) return json(request, response, next);
    return upload(request, response, next);
  };
}

function sendPrivatePublisherImage(
  response: Response,
  result: {
    body: Uint8Array;
    contentType: "image/jpeg" | "image/png";
    contentSha256: string;
  },
) {
  response.setHeader("Content-Type", result.contentType);
  response.setHeader("Content-Length", String(result.body.byteLength));
  response.setHeader("Content-Disposition", "inline");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("ETag", `"sha256-${result.contentSha256}"`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.status(200).send(Buffer.from(result.body));
}

function requireFile(
  request: Request,
  response: Response,
): Express.Multer.File | undefined {
  if (!request.file || request.file.size < 1) {
    response.status(400).json({ error: "A non-empty file is required" });
    return undefined;
  }
  return request.file;
}

function toUpload(file: Express.Multer.File): PublisherUpload {
  return {
    originalName: file.originalname,
    contentType: file.mimetype,
    body: Uint8Array.from(file.buffer),
    size: file.size,
  };
}

function safeCsvFilename(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 96);
  return safe.toLowerCase().endsWith(".csv") ? safe : `${safe || "batch"}.csv`;
}
