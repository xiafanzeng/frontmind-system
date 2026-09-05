import "dotenv/config";
import express from "express";
import { createServer } from "http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import manusProxy from "../manus-proxy";
import knowledgeBaseApi, {
  getKnowledgeBaseSkillDescriptor,
  recoverExpiredKnowledgeBaseTurns,
  recoverOpenKnowledgeBaseTasks,
} from "../knowledge-base-api";
import { cleanupOrphanedKnowledgeBuildArtifactCandidates } from "../knowledge-base-artifact-binding-service";
import responseLogicApi, {
  getResponseLogicSkillDescriptor,
} from "../response-logic-api";
import dashboardApi, {
  assertDashboardAssetStorageConfigured,
} from "../dashboard-api";
import brandQuestionPortfolioApi from "../brand-question-portfolio-api";
import { getBrandQuestionPortfolioSkillDescriptor } from "../brand-question-portfolio-runtime";
import preparedFileRouter from "../prepared-file-router";
import presalesProxy, {
  assertPresalesProxyConfigured,
} from "../presales-proxy";
import provisioningRouter, {
  assertProvisioningConfigured,
} from "../provisioning-router";
import { preparedFileService } from "../prepared-file-service";
import { resolveDownloadTokenSecret } from "../signed-download-token";
import { assertPresalesFileStorageWritable } from "../presales-file-store";
import {
  attachOptionalActiveCredential,
  requireExpressAuth,
} from "./express-auth";
import { resolveUpstreamCredential } from "./upstream-credential";
import {
  enforceDeliveryProjectContext,
  enforceFrontMindProxyAccess,
} from "./frontmind-proxy-policy";
import { processKnowledgeResetCleanupJobs } from "../knowledge-base-reset-service";
import { assertCredentialEncryptionConfigured } from "../auth-service";
import { getDb } from "../db";
import deliveryTicketAttachmentRouter from "../delivery-ticket-attachment-router";
import { startDeliveryTicketRetentionScheduler } from "../delivery-ticket-retention";
import { startConversationRetentionScheduler } from "../conversation-retention";
import {
  cleanupExpiredFileContent,
  prepareFileContentRetentionForServing,
  runFileContentRetentionCleanup,
  startFileContentRetentionScheduler,
} from "../file-content-retention";
import {
  assertFileRetentionPreflightReady,
  createFileRetentionPreflightEvidenceCache,
  inspectFileRetentionPreflight,
} from "../file-retention-preflight";
import { startApiUsageSnapshotScheduler } from "../api-usage-snapshot-service";
import {
  assertDedicatedMonitorCredentialConfigured,
  isDedicatedMonitorCredentialConfigured,
  monitorBaseUrl,
} from "../presales-monitor";
import {
  assertFrontMindPublicUrlConfigured,
  isFrontMindPublicUrlConfigured,
} from "../public-url";
import {
  assertDashboardImportPreflightConfigured,
  startDashboardImportPreflightCleanupScheduler,
} from "../dashboard-import-preflight-service";
import websiteContentTemplateApi from "../website-content-template-api";
import { assertAdminAccessLevelsBackfilled } from "../admin-control-plane-service";
import {
  assertUpstreamBaseUrlConfigured,
  isUpstreamBaseUrlConfigured,
} from "../upstream-config";
import { createPaymentReceiptLedgerService } from "../payment-receipt-ledger-service";
import { createProjectOrderRegistryService } from "../project-order-registry-service";
import knowledgeBaseLivePreviewApi from "../knowledge-base-live-preview-api";
import knowledgeBaseArtifactApi from "../knowledge-base-artifact-api";
import { auditKnowledgeBaseStateInvariants } from "../knowledge-base-invariant-audit";
import { runtimeErrorForLog } from "./runtime-error-log";
import {
  evaluateKnowledgeBaseReadiness,
  knowledgeBaseReadinessHttpStatus,
  knowledgeBaseRecoveryHealth,
  runLeasedKnowledgeBaseRecovery,
} from "./knowledge-base-readiness";
import { createKnowledgeBaseRecoverySweep } from "../knowledge-base-recovery-worker";
import {
  bundledMigrationManifestPath,
  evaluateMigrationJournal,
  loadMigrationManifest,
  type MigrationManifest,
} from "./migration-journal";
import { validateProductionRuntimeEnvironment } from "../../scripts/validate-production-runtime.mjs";
import { evaluateDatabaseSchema } from "../../scripts/schema-contract.mjs";

declare const __FRONTMIND_BUILD_SHA__: string | undefined;

const paymentReceiptLedgerReadiness = createPaymentReceiptLedgerService();
const projectOrderRegistryReadiness = createProjectOrderRegistryService();
const fileRetentionPreflightEvidence =
  createFileRetentionPreflightEvidenceCache();
const compiledBuildSha =
  typeof __FRONTMIND_BUILD_SHA__ === "string"
    ? __FRONTMIND_BUILD_SHA__.trim().toLowerCase()
    : "";
const applicationBuildSha =
  compiledBuildSha ||
  process.env.FRONTMIND_BUILD_SHA?.trim().toLowerCase() ||
  process.env.COMMIT_SHA?.trim().toLowerCase() ||
  process.env.RENDER_GIT_COMMIT?.trim().toLowerCase() ||
  null;
const applicationImageDigest =
  process.env.FRONTMIND_IMAGE_DIGEST?.trim().toLowerCase() || null;
const runtimeBuildRoot = path.dirname(fileURLToPath(import.meta.url));

function assertProductionConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  assertCredentialEncryptionConfigured();
  assertPresalesProxyConfigured();
  assertProvisioningConfigured();
  assertDedicatedMonitorCredentialConfigured();
  monitorBaseUrl();
  assertFrontMindPublicUrlConfigured();
  assertUpstreamBaseUrlConfigured();
  assertDashboardAssetStorageConfigured();
  assertDashboardImportPreflightConfigured();
  // Download URLs are stateless and may be redeemed on any replica. Refuse to
  // bind the production listener unless every instance can share a strong
  // signing secret.
  resolveDownloadTokenSecret();
}

async function getRuntimeSkillReadiness() {
  const [knowledgeBase, brandQuestions, responseLogic] = await Promise.all([
    getKnowledgeBaseSkillDescriptor(),
    getBrandQuestionPortfolioSkillDescriptor(),
    getResponseLogicSkillDescriptor(),
  ]);
  return [knowledgeBase, brandQuestions, responseLogic];
}

async function evaluateReleaseReadiness(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  manifest: MigrationManifest,
) {
  const journal = await evaluateMigrationJournal(db, manifest);
  const schema =
    journal.status === "exact"
      ? await evaluateDatabaseSchema(
          { query: (query) => db.execute(sql.raw(query)) },
          manifest.schemaContract,
        )
      : {
          status: "not_checked" as const,
          expectedHash: manifest.schemaHash,
          expectedTableCount: manifest.schemaTableCount,
        };
  return { journal, schema };
}

async function startServer() {
  let migrationManifest: MigrationManifest | null = null;
  if (process.env.NODE_ENV === "production") {
    const runtimeIdentity = validateProductionRuntimeEnvironment(process.env);
    if (runtimeIdentity.buildSourceSha !== applicationBuildSha) {
      throw new Error("FRONTMIND_RUNTIME_BUILD_SOURCE_SHA_MISMATCH");
    }
    migrationManifest = await loadMigrationManifest(
      process.env.FRONTMIND_MIGRATION_MANIFEST_PATH ||
        bundledMigrationManifestPath(runtimeBuildRoot),
    );
  }
  assertProductionConfiguration();
  if (process.env.NODE_ENV === "production") {
    await assertAdminAccessLevelsBackfilled();
    await getRuntimeSkillReadiness();
  }
  if (process.env.NODE_ENV === "production") {
    await Promise.all([
      preparedFileService.health(),
      assertPresalesFileStorageWritable(),
    ]);
    const fileRetentionStartup = await prepareFileContentRetentionForServing();
    console.info(
      "[File content retention] Startup lifecycle backfill complete",
      JSON.stringify(fileRetentionStartup),
    );
    // The release migrator must have applied 0054 before the candidate starts.
    // Run the read-only inventory only after the immutable lifecycle ledger is
    // complete, and before the listener or either cleanup scheduler exists.
    const fileRetentionPreflight = await inspectFileRetentionPreflight();
    const fileRetentionEvidence = fileRetentionPreflightEvidence.store(
      fileRetentionPreflight,
    );
    console.info(
      "[File content retention] Startup preflight complete",
      JSON.stringify(fileRetentionEvidence),
    );
    assertFileRetentionPreflightReady(fileRetentionPreflight);
  } else {
    await preparedFileService.initialize();
  }
  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  // 1Panel/OpenResty is the single trusted reverse proxy in production.
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      "object-src 'none'; worker-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    if (process.env.NODE_ENV === "production") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  });
  // Authenticate private service routes before the global JSON parser.
  app.use("/api/internal/presales", presalesProxy);
  app.use("/api/internal/provisioning", provisioningRouter);

  // JSON/form payloads keep a bounded parser.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  if (process.env.NODE_ENV === "development") {
    app.use("/api/dev/knowledge-base-live", knowledgeBaseLivePreviewApi);
  }

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      build: {
        sha: applicationBuildSha,
        imageDigest: applicationImageDigest,
      },
    });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      assertUpstreamBaseUrlConfigured();
      monitorBaseUrl();
      const db = await getDb();
      if (!db) throw new Error("Database is not configured");
      if (!migrationManifest) {
        throw new Error("Migration manifest is not loaded");
      }
      await db.execute(sql`select 1`);
      const migrationState = await evaluateReleaseReadiness(
        db,
        migrationManifest,
      );
      const fileRetention = fileRetentionPreflightEvidence.read();
      const [
        preparedFiles,
        skills,
        paymentReceipts,
        projectOrders,
        knowledgeBase,
      ] = await Promise.all([
        preparedFileService.health(),
        getRuntimeSkillReadiness(),
        paymentReceiptLedgerReadiness.ready(),
        projectOrderRegistryReadiness.ready(),
        evaluateKnowledgeBaseReadiness({
          db,
          schemaVerified:
            migrationState.journal.status === "exact" &&
            migrationState.schema.status === "exact",
          recoveryRequired: process.env.NODE_ENV === "production",
          assetRootRequired: process.env.NODE_ENV === "production",
        }),
      ]);
      const ready =
        fileRetention?.ready === true &&
        knowledgeBaseReadinessHttpStatus(knowledgeBase) === 200 &&
        migrationState.journal.status === "exact" &&
        migrationState.schema.status === "exact";
      const status = ready ? 200 : 503;
      const response = {
        status: "ok",
        build: {
          sha: applicationBuildSha,
          imageDigest: applicationImageDigest,
        },
        migration: {
          status: migrationState.journal.status,
          journalHash: migrationState.journal.journalHash,
          expectedCount: migrationState.journal.expected.count,
          appliedCount: migrationState.journal.applied.count,
          latestExpectedTag: migrationState.journal.expected.latestTag,
          latestAppliedTag: migrationState.journal.applied.latestTag,
          pendingCount: migrationState.journal.pending.length,
          allPendingExpand: migrationState.journal.allPendingExpand,
          schema: migrationState.schema,
        },
        configuration: {
          monitorCredentialConfigured: isDedicatedMonitorCredentialConfigured(),
          monitorApiBaseUrlConfigured: true,
          publicUrlConfigured: isFrontMindPublicUrlConfigured(),
          upstreamBaseUrlConfigured: isUpstreamBaseUrlConfigured(),
        },
        preparedFiles: {
          status: "ok",
          availableBytes: preparedFiles.availableBytes,
          reserveBytes: preparedFiles.reserveBytes,
          queueLength: preparedFiles.queueLength,
          activeWorkers: preparedFiles.activeWorkers,
        },
        fileRetention,
        internalLedgers: {
          paymentReceipts,
          projectOrders,
        },
        skills: skills.map(({ name, version, contentHash }) => ({
          name,
          version,
          contentHash,
        })),
        knowledgeBase: knowledgeBase.dto,
      };
      if (!ready) {
        console.error("[Health] readiness_unavailable", {
          code: "READINESS_UNAVAILABLE",
          migrationStatus: migrationState.journal.status,
          schemaStatus: migrationState.schema.status,
          fileRetentionReady: fileRetention?.ready ?? false,
        });
        res.status(status).json({
          ...response,
          status: "unavailable",
        });
        return;
      }
      res.status(status).json(response);
    } catch {
      console.error("[Health] readiness_check_failed", {
        code: "READINESS_CHECK_FAILED",
      });
      res.status(503).json({ status: "unavailable" });
    }
  });

  // FrontMind API proxy - avoids CORS issues while keeping upstream details server-side.
  app.use(
    "/api/delivery-ticket-attachments",
    requireExpressAuth,
    enforceDeliveryProjectContext,
    deliveryTicketAttachmentRouter,
  );
  app.use(
    "/api/frontmind/assets",
    requireExpressAuth,
    enforceDeliveryProjectContext,
    preparedFileRouter,
  );
  app.use(
    "/api/frontmind",
    requireExpressAuth,
    enforceFrontMindProxyAccess,
    resolveUpstreamCredential,
    manusProxy,
  );
  app.use("/api/manus", (_req, res) => {
    res
      .status(404)
      .json({ error: { message: "接口不存在", code: "NOT_FOUND" } });
  });
  // One-click enterprise knowledge base workflow powered by the Socratic KB skill.
  app.use(
    "/api/knowledge-base/artifacts",
    requireExpressAuth,
    knowledgeBaseArtifactApi,
  );
  app.use(
    "/api/knowledge-base",
    requireExpressAuth,
    attachOptionalActiveCredential,
    knowledgeBaseApi,
  );
  // Per-question response logic workflow powered by a private Skill and Pro.
  app.use(
    "/api/response-logic",
    requireExpressAuth,
    attachOptionalActiveCredential,
    responseLogicApi,
  );
  // Evidence-backed brand question candidates. Capability and quota are
  // resolved server-side before any Pro task is created.
  app.use(
    "/api/brand-question-portfolio",
    requireExpressAuth,
    attachOptionalActiveCredential,
    brandQuestionPortfolioApi,
  );
  // Durable user dashboard content and final knowledge-base snapshot imports.
  app.use("/api/dashboard", dashboardApi);
  // Revision-bound, preview-first bulk completion for the five formal website
  // content ticket categories. Domain/ICP prerequisites are not in this API.
  app.use("/api/website-content-template", websiteContentTemplateApi);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );
  app.use("/api", (_req, res) => {
    res
      .status(404)
      .json({ error: { message: "接口不存在", code: "NOT_FOUND" } });
  });
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Return a controlled response for malformed percent-encoded request paths.
  app.use((err: any, req: any, res: any, next: any) => {
    if (err instanceof URIError) {
      // Silently ignore URI decode errors from malformed paths
      res.status(400).end();
      return;
    }
    console.error(
      "[HTTP] Unhandled request error",
      runtimeErrorForLog(err, {
        additionalSecrets: [req.frontmindCredential?.apiKey],
      }),
    );
    if (res.headersSent) {
      next(err);
      return;
    }
    const candidateStatus = Number(err?.status ?? err?.statusCode);
    const status =
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 400 &&
      candidateStatus < 600
        ? candidateStatus
        : 500;
    res.status(status).json({
      error: {
        message: status === 413 ? "请求内容过大" : "服务器暂时无法完成请求",
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL_SERVER_ERROR",
      },
    });
  });

  const port = Number.parseInt(process.env.PORT || "3001", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  await startApiUsageSnapshotScheduler();
  startDashboardImportPreflightCleanupScheduler();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
    if (process.env.NODE_ENV === "production") {
      startDeliveryTicketRetentionScheduler();
      startConversationRetentionScheduler();
      startFileContentRetentionScheduler({
        // Let the conversation transaction finish its initial pass before the
        // file worker reconciles newly orphaned resources.
        initialDelayMs: 2 * 60_000,
        run: () =>
          runFileContentRetentionCleanup({
            cleanup: async () => {
              const result = await cleanupExpiredFileContent({
                removePreparedAssets: (resource) =>
                  preparedFileService.deleteByOwnedFileSource({
                    ownerUserId: resource.userId,
                    fileId: resource.upstreamId,
                    projectAssignmentId: resource.projectAssignmentId,
                  }),
                removePreparedAssetsByFileId: (fileId) =>
                  preparedFileService.deleteByFileSource(fileId),
              });
              return result;
            },
          }),
      });
      const recoverKnowledgeBaseState = createKnowledgeBaseRecoverySweep({
        recoverExpiredTurns: () => recoverExpiredKnowledgeBaseTurns(),
        recoverOpenBuilds: (options) => recoverOpenKnowledgeBaseTasks(options),
        cleanupArtifactCandidates: () =>
          cleanupOrphanedKnowledgeBuildArtifactCandidates(),
      });
      const runKnowledgeRecovery = async () => {
        try {
          const recovery = await runLeasedKnowledgeBaseRecovery({
            tracker: knowledgeBaseRecoveryHealth,
            recover: recoverKnowledgeBaseState,
          });
          if (!recovery) return;
          const { claimedTurnIds: _claimedTurnIds, ...turnMetrics } =
            recovery.turns;
          console.info(
            "[KnowledgeBaseRecovery] scan_complete",
            JSON.stringify({
              turns: turnMetrics,
              builds: recovery.builds,
              artifacts: recovery.artifacts,
            }),
          );
        } catch (error) {
          console.error(
            "[KnowledgeBaseRecovery] scan_failed",
            runtimeErrorForLog(error),
          );
        }
      };
      void runKnowledgeRecovery();
      const knowledgeRecoveryTimer = setInterval(
        () => void runKnowledgeRecovery(),
        30_000,
      );
      knowledgeRecoveryTimer.unref();
      const runKnowledgeInvariantAudit = () => {
        void auditKnowledgeBaseStateInvariants({
          blockWritesOnP0: true,
        }).catch((error) => {
          console.error(
            "[KnowledgeBaseInvariant] audit_failed",
            runtimeErrorForLog(error),
          );
        });
      };
      const knowledgeInvariantWarmup = setTimeout(
        runKnowledgeInvariantAudit,
        60_000,
      );
      knowledgeInvariantWarmup.unref();
      const knowledgeInvariantTimer = setInterval(
        runKnowledgeInvariantAudit,
        5 * 60_000,
      );
      knowledgeInvariantTimer.unref();
      const runResetCleanup = () => {
        void processKnowledgeResetCleanupJobs().catch((error) => {
          console.error(
            "[KnowledgeBaseReset] cleanup_retry_failed",
            runtimeErrorForLog(error),
          );
        });
      };
      runResetCleanup();
      const resetCleanupTimer = setInterval(runResetCleanup, 15 * 60 * 1000);
      resetCleanupTimer.unref();
    }
  });
}

startServer().catch((error) => {
  console.error("[Server] startup_failed", runtimeErrorForLog(error));
  process.exitCode = 1;
});
