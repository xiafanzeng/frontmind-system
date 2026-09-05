import path from "node:path";
import {
  isAllowedOrigin,
  redactSecrets,
  type RuntimeConfig,
} from "@frontmind/monitoring-config";
import {
  monitoringExportSections,
  RepositoryError,
  type MonitoringRepository,
  type PublishingRepository,
} from "@frontmind/monitoring-db";
import { monitoringScopeSchema } from "@frontmind/monitoring-contracts";
import { ObjectStoreReadLimitError } from "@frontmind/monitoring-object-store";
import {
  createPaymentRouter,
  type PaymentConfiguration,
} from "@frontmind/monitoring-payment";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import * as trpcExpress from "@trpc/server/adapters/express";
import { z } from "zod";
import type { AuthenticationService } from "./auth.js";
import { createContext } from "./context.js";
import { LoginRateLimiter } from "./rate-limit.js";
import { appRouter } from "./router.js";
import { hashNetworkIdentifier } from "./security.js";
import { createPaymentSettlementStore } from "./payment.js";
import {
  registerPublisherHttpRoutes,
  type PublisherHttpService,
} from "./publisher-http.js";
import { streamMonitoringWorkbook, streamRunWorkbook } from "./xlsx.js";

export type ServerDependencies = {
  repository: MonitoringRepository;
  publishingRepository?: PublishingRepository;
  auth: AuthenticationService;
  config: RuntimeConfig;
  paymentConfiguration: PaymentConfiguration;
  paymentFetchImpl?: typeof fetch;
  paymentNow?: () => Date;
  mediaSigner?: {
    signedGetUrl(key: string, expiresInSeconds?: number): string;
  };
  mediaReader?: {
    read(
      key: string,
      signal?: AbortSignal,
      maxBytes?: number,
    ): Promise<Uint8Array | undefined>;
  };
  publisherHttpService?: PublisherHttpService;
};

const safeArchivedImageTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_PROTECTED_MEDIA_BYTES = 15 * 1_024 * 1_024;
const MAX_CONCURRENT_MEDIA_READS = 6;

const callbackItemSchema = z
  .object({
    taskId: z
      .union([z.string(), z.number()])
      .transform(String)
      .pipe(z.string().min(1).max(128)),
    status: z.string().max(64).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const callbackSchema = z.union([
  callbackItemSchema,
  z
    .object({ data: callbackItemSchema })
    .passthrough()
    .transform((value) => value.data),
]);

const monitoringExportQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    questionId: z.string().uuid().optional(),
    platformId: z.string().uuid().optional(),
    subject: z.enum(["self", "competitor"]),
    competitor: z.string().trim().min(1).max(120).optional(),
    section: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.subject === "competitor" && !value.competitor) {
      ctx.addIssue({
        code: "custom",
        path: ["competitor"],
        message: "A competitor subject requires a competitor name",
      });
    }
    if (value.subject === "self" && value.competitor) {
      ctx.addIssue({
        code: "custom",
        path: ["competitor"],
        message: "A self subject cannot include a competitor name",
      });
    }
  });

function parseMonitoringExportQuery(value: unknown) {
  const parsed = monitoringExportQuerySchema.parse(value);
  const requested = (
    parsed.section
      ? Array.isArray(parsed.section)
        ? parsed.section
        : [parsed.section]
      : []
  )
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const sections =
    requested.length === 0
      ? [...monitoringExportSections]
      : z.array(z.enum(monitoringExportSections)).parse(requested);
  return { ...parsed, sections: [...new Set(sections)] };
}

export function createApiApp(dependencies: ServerDependencies): Express {
  const app = express();
  let activeMediaReads = 0;
  if (dependencies.config.TRUST_PROXY) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  const callbackLimiter = new LoginRateLimiter(120, 60_000);
  const imageSources = ["'self'", "data:", "blob:"];
  if (dependencies.mediaSigner && dependencies.config.OSS_MEDIA_BUCKET) {
    const endpoint = new URL(dependencies.config.OSS_ENDPOINT);
    imageSources.push(
      `${endpoint.protocol}//${dependencies.config.OSS_MEDIA_BUCKET}.${endpoint.host}`,
    );
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: imageSources,
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          formAction: ["'self'", "https://zpayz.cn"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts:
        dependencies.config.NODE_ENV === "production"
          ? { maxAge: 31_536_000, includeSubDomains: true }
          : false,
    }),
  );

  app.get("/healthz", (_request, response) =>
    response.status(200).json({ status: "ok" }),
  );
  app.get("/readyz", async (_request, response) => {
    try {
      await dependencies.repository.ping();
      response.status(200).json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "not_ready" });
    }
  });
  app.get("/build", (_request, response) =>
    response.status(200).json({
      sha: dependencies.config.BUILD_SHA,
      builtAt: dependencies.config.BUILD_TIME,
      environment: dependencies.config.NODE_ENV,
      dataSource: "server-backed",
      localDevelopment:
        dependencies.config.NODE_ENV === "development" &&
        isLoopbackUrl(dependencies.config.PUBLIC_ORIGIN) &&
        isLoopbackUrl(dependencies.config.DATABASE_URL),
      icpNumber: dependencies.config.PUBLIC_ICP_NUMBER ?? null,
      icpLink: dependencies.config.PUBLIC_ICP_LINK,
    }),
  );

  app.get("/local-runtime", async (_request, response) => {
    const localDevelopment =
      dependencies.config.NODE_ENV === "development" &&
      isLoopbackUrl(dependencies.config.PUBLIC_ORIGIN) &&
      isLoopbackUrl(dependencies.config.DATABASE_URL);
    if (!localDevelopment) {
      return response.status(404).json({ error: "Not found" });
    }
    try {
      const [monitoring, platforms, regions, publisherRuntime, publisherSyncs] =
        await Promise.all([
          dependencies.repository.getAdminOverview(),
          dependencies.repository.listPlatforms(true),
          dependencies.repository.listRegions(),
          dependencies.publishingRepository?.getPublisherRuntimeState() ??
            Promise.resolve(null),
          dependencies.publishingRepository?.listPublisherMediaSyncRuns(1) ??
            Promise.resolve([]),
        ]);
      const latestPublisherSync = publisherSyncs[0] ?? null;
      return response.status(200).json({
        dataSource: "server-backed",
        scope: "local",
        processes: {
          api: "ready",
          mysql: "ready",
          worker: monitoring.executionService.status,
          workerLastSeenAt:
            monitoring.executionService.lastHeartbeatAt?.toISOString() ?? null,
        },
        objectStore: {
          driver: dependencies.config.OBJECT_STORE_DRIVER,
          configured:
            dependencies.config.OBJECT_STORE_DRIVER === "local" &&
            Boolean(dependencies.config.LOCAL_OBJECT_STORE_DIR),
        },
        monitoring: {
          platformCount: platforms.length,
          domesticRegionCount: regions.filter(
            ({ scope }) => scope === "domestic",
          ).length,
          overseasRegionCount: regions.filter(
            ({ scope }) => scope === "overseas",
          ).length,
          providerAuthentication: monitoring.providerAuthentication.status,
        },
        publishing: {
          enabled:
            dependencies.config.PUBLISHER_FEATURE_ENABLED &&
            Boolean(publisherRuntime?.featureEnabled),
          mode: publisherRuntime?.mode ?? null,
          catalogRevision: publisherRuntime?.activeCatalogRevision ?? null,
          catalogKindComplete: publisherRuntime?.catalogKindComplete ?? false,
          catalogSyncedAt:
            publisherRuntime?.catalogSyncedAt?.toISOString() ?? null,
          latestSync: latestPublisherSync
            ? {
                id: latestPublisherSync.id,
                status: latestPublisherSync.status,
                pagesFetched: latestPublisherSync.pagesFetched,
                pagesExpected: latestPublisherSync.pagesExpected,
                recordsSeen: latestPublisherSync.recordsSeen,
                newsRecords: latestPublisherSync.newsRecords,
                selfMediaRecords: latestPublisherSync.selfMediaRecords,
                invalidRecords: latestPublisherSync.invalidRecords,
                duplicateRecords: latestPublisherSync.duplicateRecords,
                crossKindDuplicateRecords:
                  latestPublisherSync.crossKindDuplicateRecords,
                logoPending: latestPublisherSync.logoPending,
                logoArchived: latestPublisherSync.logoArchived,
                logoFailed: latestPublisherSync.logoFailed,
                logoProviderArchived:
                  latestPublisherSync.logoProviderArchived,
                logoIconArchived: latestPublisherSync.logoIconArchived,
                logoSiteFaviconArchived:
                  latestPublisherSync.logoSiteFaviconArchived,
                logoWebSearchVerifiedArchived:
                  latestPublisherSync.logoWebSearchVerifiedArchived,
                logoPendingReview: latestPublisherSync.logoPendingReview,
                logoGeneratedFallback:
                  latestPublisherSync.logoGeneratedFallback,
                logoMissing: latestPublisherSync.logoMissing,
                logoRealMissing: latestPublisherSync.logoRealMissing,
                logoRealCoverageBasisPoints:
                  latestPublisherSync.logoRealCoverageBasisPoints,
                isComplete: latestPublisherSync.isComplete,
              }
            : null,
        },
      });
    } catch {
      return response.status(503).json({
        dataSource: "server-backed",
        scope: "local",
        error: "Local runtime diagnostics are temporarily unavailable",
      });
    }
  });

  app.use(
    "/payments",
    createPaymentRouter({
      configuration: dependencies.paymentConfiguration,
      settlementStore: createPaymentSettlementStore(
        dependencies.repository,
        dependencies.publishingRepository,
      ),
      ...(dependencies.paymentFetchImpl
        ? { fetchImpl: dependencies.paymentFetchImpl }
        : {}),
      ...(dependencies.paymentNow ? { now: dependencies.paymentNow } : {}),
      logger: {
        warn: (event, details) => {
          if (dependencies.config.NODE_ENV !== "test") {
            console.warn(
              JSON.stringify({ level: "warn", event, code: details.code }),
            );
          }
        },
      },
    }),
  );

  app.post(
    "/webhooks/molizhishu",
    express.json({ limit: "16kb", type: "application/json" }),
    async (request, response, next) => {
      const rateKey = request.ip || "unknown";
      if (!callbackLimiter.canAttempt(rateKey))
        return response.status(429).json({ accepted: false });
      callbackLimiter.recordFailure(rateKey);
      try {
        const parsed = callbackSchema.safeParse(request.body);
        if (!parsed.success)
          return response.status(400).json({ accepted: false });
        const outcome = await dependencies.repository.enqueueProviderCallback(
          parsed.data.taskId,
          {
            status: parsed.data.status ?? null,
            timestamp: parsed.data.timestamp ?? null,
          },
        );
        return response
          .status(202)
          .json({ accepted: outcome.accepted, discarded: outcome.discarded });
      } catch (error) {
        return next(error);
      }
    },
  );

  registerPublisherHttpRoutes(app, {
    config: dependencies.config,
    auth: dependencies.auth,
    ...(dependencies.publisherHttpService
      ? { service: dependencies.publisherHttpService }
      : {}),
  });

  // The validated maximum monitor payload can exceed 256 KiB (50 long questions
  // plus competitor aliases), while one MiB still provides a strict abuse bound.
  app.use(express.json({ limit: "1mb" }));
  app.all("/auth/login", (_request, response) => {
    response.status(410).json({ error: "请使用看板统一登录" });
  });
  app.all("/auth/logout", (_request, response) => {
    response.status(410).json({ error: "请使用看板统一退出登录" });
  });

  app.get(
    "/downloads/monitoring/:monitorId.xlsx",
    async (request, response, next) => {
      try {
        const authenticated = await dependencies.auth.resolve(request);
        if (!authenticated)
          return response
            .status(401)
            .json({ error: "Authentication required" });
        const monitorId = z.string().uuid().parse(request.params.monitorId);
        const parsed = parseMonitoringExportQuery(request.query);
        const scope = monitoringScopeSchema.parse({
          monitorId,
          from: parsed.from,
          to: parsed.to,
          questionId: parsed.questionId,
          platformId: parsed.platformId,
          subject:
            parsed.subject === "self"
              ? { kind: "self" }
              : { kind: "competitor", name: parsed.competitor! },
        });
        await streamMonitoringWorkbook(
          dependencies.repository,
          authenticated.user.id,
          scope,
          parsed.sections,
          response,
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/downloads/runs/:runId.xlsx",
    async (request, response, next) => {
      try {
        const authenticated = await dependencies.auth.resolve(request);
        if (!authenticated)
          return response
            .status(401)
            .json({ error: "Authentication required" });
        const runId = z.string().uuid().parse(request.params.runId);
        if (authenticated.user.role === "admin") {
          const audit = {
            actorId: authenticated.user.id,
            actorRole: "admin" as const,
            ipHash: hashNetworkIdentifier(
              request.ip,
              dependencies.config.SESSION_SECRET,
            ),
          };
          const detail = await dependencies.repository.getRunForAdmin(runId, {
            ...audit,
          });
          await dependencies.repository.writeAudit(
            audit,
            "admin.run_exported",
            "run",
            runId,
            detail.run.ownerId,
            {},
          );
          await streamRunWorkbook(
            dependencies.repository,
            detail.run.ownerId,
            runId,
            response,
          );
        } else {
          await streamRunWorkbook(
            dependencies.repository,
            authenticated.user.id,
            runId,
            response,
          );
        }
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/media/:mediaId", async (request, response, next) => {
    try {
      const authenticated = await dependencies.auth.resolve(request);
      if (!authenticated)
        return response.status(401).json({ error: "Authentication required" });
      const mediaId = z.string().uuid().parse(request.params.mediaId);
      const variant = z
        .enum(["display", "thumbnail"])
        .default("display")
        .parse(request.query.variant);
      const disposition = z
        .enum(["inline", "attachment"])
        .default("inline")
        .parse(request.query.disposition);
      const row =
        authenticated.user.role === "admin"
          ? await dependencies.repository.getMediaForAdmin(mediaId, {
              actorId: authenticated.user.id,
              actorRole: "admin",
              ipHash: hashNetworkIdentifier(
                request.ip,
                dependencies.config.SESSION_SECRET,
              ),
            })
          : await dependencies.repository.getMediaForOwner(
              authenticated.user.id,
              mediaId,
            );
      if (row.media.archiveStatus === "pending") {
        return response
          .status(409)
          .json({ status: "pending", error: "Media is still being archived" });
      }
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      const objectKey =
        variant === "thumbnail"
          ? row.media.thumbnailObjectKey
          : row.media.objectKey;
      if (row.media.archiveStatus !== "archived" || !objectKey) {
        return response
          .status(404)
          .json({ error: "Archived media is unavailable" });
      }
      const declaredSize = Number(row.media.sizeBytes);
      if (
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 1 ||
        declaredSize > MAX_PROTECTED_MEDIA_BYTES
      ) {
        return response.status(413).json({
          error: "Archived media is outside the protected download limit",
        });
      }
      const contentType =
        variant === "thumbnail"
          ? "image/webp"
          : row.media.mimeType && safeArchivedImageTypes.has(row.media.mimeType)
            ? row.media.mimeType
            : "application/octet-stream";
      response.setHeader("Content-Type", contentType);
      response.setHeader(
        "Content-Disposition",
        disposition === "attachment"
          ? `attachment; filename="frontmind-media-${mediaId}"`
          : "inline",
      );
      if (request.method === "HEAD") {
        if (variant === "display") {
          response.setHeader("Content-Length", String(declaredSize));
        }
        return response.status(200).end();
      }
      if (disposition === "inline" && dependencies.mediaSigner) {
        return response.redirect(
          302,
          dependencies.mediaSigner.signedGetUrl(objectKey, 300),
        );
      }
      if (dependencies.mediaReader) {
        if (activeMediaReads >= MAX_CONCURRENT_MEDIA_READS) {
          response.setHeader("Retry-After", "1");
          return response
            .status(503)
            .json({ error: "Media access is temporarily busy" });
        }
        activeMediaReads += 1;
        const controller = new AbortController();
        const abortRead = () => controller.abort("media client disconnected");
        const abortClosedRead = () => {
          if (!response.writableEnded) abortRead();
        };
        request.once("aborted", abortRead);
        response.once("close", abortClosedRead);
        try {
          let body: Uint8Array | undefined;
          try {
            body = await dependencies.mediaReader.read(
              objectKey,
              controller.signal,
              MAX_PROTECTED_MEDIA_BYTES,
            );
          } catch (error) {
            if (error instanceof ObjectStoreReadLimitError) {
              return response.status(413).json({
                error: "Archived media is outside the protected download limit",
              });
            }
            throw error;
          }
          if (!body)
            return response
              .status(404)
              .json({ error: "Archived media is unavailable" });
          if (body.byteLength > MAX_PROTECTED_MEDIA_BYTES) {
            return response.status(413).json({
              error: "Archived media is outside the protected download limit",
            });
          }
          response.setHeader("Content-Length", String(body.byteLength));
          return response
            .status(200)
            .send(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
        } finally {
          request.off("aborted", abortRead);
          response.off("close", abortClosedRead);
          activeMediaReads -= 1;
        }
      }
      return response
        .status(503)
        .json({ error: "Media access service is unavailable" });
    } catch (error) {
      return next(error);
    }
  });

  app.use(
    "/trpc",
    requireSameOriginForWrites(dependencies.config),
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext: (options) => createContext(options, dependencies),
      onError: ({ error, path: procedurePath }) => {
        if (dependencies.config.NODE_ENV !== "test") {
          console.error(
            JSON.stringify(
              redactSecrets({
                level: "error",
                procedurePath,
                code: error.code,
                message: error.message,
              }),
            ),
          );
        }
      },
    }),
  );

  if (dependencies.config.WEB_DIST_DIR) {
    const webRoot = path.resolve(dependencies.config.WEB_DIST_DIR);
    app.use(
      express.static(webRoot, { immutable: true, maxAge: "1y", index: false }),
    );
    app.get("/{*path}", (request, response, next) => {
      if (
        request.path.startsWith("/") ||
        request.path === "/healthz" ||
        request.path === "/readyz"
      )
        return next();
      return response.sendFile(path.join(webRoot, "index.html"));
    });
  }

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (response.headersSent) return;
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: "Invalid request",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
        return;
      }
      if (error instanceof RepositoryError) {
        const status =
          error.code === "NOT_FOUND"
            ? 404
            : error.code === "FORBIDDEN"
              ? 403
              : error.code === "CONFLICT"
                ? 409
                : 400;
        response.status(status).json({ error: error.message });
        return;
      }
      console.error(
        JSON.stringify(
          redactSecrets({
            level: "error",
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  }
                : error,
          }),
        ),
      );
      response.status(500).json({ error: "Internal server error" });
    },
  );
  return app;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function requireSameOrigin(config: RuntimeConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!isAllowedOrigin(request.get("origin"), config.PUBLIC_ORIGIN)) {
      response.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  };
}

function requireSameOriginForWrites(config: RuntimeConfig) {
  const middleware = requireSameOrigin(config);
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.method === "GET" || request.method === "HEAD") return next();
    return middleware(request, response, next);
  };
}
