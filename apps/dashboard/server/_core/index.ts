import "dotenv/config";
import { monitoringModule } from "../monitoring-module";
import express from "express";
import { createServer } from "http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { configureServerTimeouts } from "./server-timeouts";
import manusProxy from "../manus-proxy";
import frontmindV2ChatRouter from "../frontmind-v2-chat-router";
import knowledgeBaseApi, {
  getKnowledgeBaseSkillDescriptor,
  recoverExpiredKnowledgeBaseTurns,
} from "../knowledge-base-api";
import { cleanupOrphanedKnowledgeBuildArtifactCandidates } from "../knowledge-base-artifact-binding-service";
import responseLogicApi, {
  getResponseLogicSkillDescriptor,
} from "../response-logic-api";
import dashboardApi, {
  assertDashboardAssetStorageConfigured,
} from "../dashboard-api";
import brandQuestionPortfolioApi from "../brand-question-portfolio-api";
import brandTrackingApi from "../brand-tracking-api";
import { startJenovaBrandTrackingRecoveryScheduler } from "../jenova-brand-tracking-service";
import { getBrandQuestionPortfolioSkillDescriptor } from "../brand-question-portfolio-runtime";
import preparedFileRouter from "../prepared-file-router";
import presalesV2Router, {
  startWebsiteAgentRecoveryScheduler,
} from "../presales-v2-router";
import { assertPresalesServiceConfigured } from "../presales-service-auth";
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
  rejectDeliveryMemberKnowledgeBaseProjectScope,
} from "./frontmind-proxy-policy";
import { processKnowledgeResetCleanupJobs } from "../knowledge-base-reset-service";
import { sweepOrphanedKnowledgeBaseUploadEvidence } from "../knowledge-base-upload-evidence-lifecycle";
import {
  assertCredentialEncryptionConfigured,
  reconcileManagedUploadAccountDeletionFencesOnStartup,
} from "../auth-service";
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
  getDedicatedMonitorCredentialReadiness,
  monitorBaseUrl,
} from "../presales-monitor";
import { assertFrontMindPublicUrlConfigured } from "../public-url";
import {
  assertDashboardImportPreflightConfigured,
  startDashboardImportPreflightCleanupScheduler,
} from "../dashboard-import-preflight-service";
import websiteContentTemplateApi from "../website-content-template-api";
import { assertAdminAccessLevelsBackfilled } from "../admin-control-plane-service";
import { assertUpstreamBaseUrlConfigured } from "../upstream-config";
import { createPaymentReceiptLedgerService } from "../payment-receipt-ledger-service";
import { createProjectOrderRegistryService } from "../project-order-registry-service";
import { startServiceContractLifecycleReconciliationScheduler } from "../service-entitlement";
import knowledgeBaseArtifactApi from "../knowledge-base-artifact-api";
import {
  auditKnowledgeBaseStateInvariants,
  getKnowledgeBaseInvariantAuditSnapshot,
} from "../knowledge-base-invariant-audit";
import { runtimeErrorForLog } from "./runtime-error-log";
import {
  ensureManagedUploadIntentWorker,
  getManagedUploadIntentWorkerReadiness,
} from "../managed-upload-intent";
import { knowledgeBaseNewBuildPolicyBinding } from "../knowledge-base-tree-policy-rollout";
import {
  evaluateKnowledgeBaseReadiness,
  knowledgeBaseReadinessHttpStatus,
  knowledgeBaseRecoveryHealth,
  runLeasedKnowledgeBaseRecovery,
} from "./knowledge-base-readiness";
import { createKnowledgeBaseRecoverySweep } from "../knowledge-base-recovery-worker";
import { runKnowledgeBasePackageSweep } from "../knowledge-base-local-package";
import { sweepKnowledgeBaseBuildSources } from "../knowledge-base-local-source-lifecycle";
import {
  bundledMigrationManifestPath,
  evaluateMigrationJournal,
  loadMigrationManifest,
  type MigrationManifest,
} from "./migration-journal";
import { evaluateDatabaseSchema } from "../../scripts/schema-contract.mjs";
import {
  applicationReleaseChannel,
  applyReleaseChannelHeaders,
  validateReleaseRuntimeEnvironment,
} from "./release-channel-adapter";
import { startSiteOpsWorkerScheduler } from "../siteops/worker";
import { siteOpsArtifactApi } from "../siteops/artifact-api";
import { registerSiteOpsRuntimeProviders } from "../siteops/runtime-providers";
import { getSiteOpsSocialWorkflowReadiness } from "../siteops/manus-provider";
import { getStaticTemplateCatalogReadiness } from "../siteops/static-template-catalog";
import { startBrandQuestionUniverseWorkerScheduler } from "../brand-question-universe-worker";
import {
  resolveFrontMindRuntimeRole,
  runtimeRoleReadinessRequirements,
  runtimeRoleRunsKnowledgeBaseWorker,
  runtimeRoleRunsSiteOps,
  runtimeRoleServesWeb,
} from "./runtime-role";

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
const runtimeRole = resolveFrontMindRuntimeRole();
const readinessRequirements = runtimeRoleReadinessRequirements(runtimeRole);

function assertProductionConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  assertCredentialEncryptionConfigured();
  assertPresalesServiceConfigured();
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
  const knowledgeBasePolicy = knowledgeBaseNewBuildPolicyBinding();
  const [knowledgeBase, brandQuestions, responseLogic, siteOpsSocial] =
    await Promise.all([
      getKnowledgeBaseSkillDescriptor({
        version: knowledgeBasePolicy.skillVersion,
        contentHash: knowledgeBasePolicy.skillContentHash,
      }),
      getBrandQuestionPortfolioSkillDescriptor(),
      getResponseLogicSkillDescriptor(),
      getSiteOpsSocialWorkflowReadiness(),
    ]);
  return [knowledgeBase, brandQuestions, responseLogic, siteOpsSocial];
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
  const knowledgeBaseTreePolicyWriter = knowledgeBaseNewBuildPolicyBinding();
  console.info("[KnowledgeBase] tree_policy_writer", {
    enabled: knowledgeBaseTreePolicyWriter.treePolicyVersion === 2,
    treePolicyVersion: knowledgeBaseTreePolicyWriter.treePolicyVersion,
    skillVersion: knowledgeBaseTreePolicyWriter.skillVersion,
    skillContentHash: knowledgeBaseTreePolicyWriter.skillContentHash,
  });
  if (process.env.NODE_ENV === "production") {
    validateReleaseRuntimeEnvironment(process.env, applicationBuildSha);
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
  configureServerTimeouts(server);
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
    applyReleaseChannelHeaders(res);
    if (process.env.NODE_ENV === "production") {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  });
  // Authenticate private service routes before the global JSON parser.
  app.use("/api/internal/presales/v2", presalesV2Router);
  app.use("/api/internal/provisioning", provisioningRouter);

  // JSON/form payloads keep a bounded parser.
  app.use("/api/monitoring", monitoringModule);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      channel: applicationReleaseChannel,
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
      const managedUploads = getManagedUploadIntentWorkerReadiness();
      const [, , , , knowledgeBase, , templateCatalog] = await Promise.all([
        preparedFileService.health(),
        getRuntimeSkillReadiness(),
        paymentReceiptLedgerReadiness.ready(),
        projectOrderRegistryReadiness.ready(),
        evaluateKnowledgeBaseReadiness({
          db,
          schemaVerified:
            migrationState.journal.status === "exact" &&
            migrationState.schema.status === "exact",
          recoveryRequired:
            process.env.NODE_ENV === "production" &&
            readinessRequirements.knowledgeBaseRecovery,
          assetRootRequired: process.env.NODE_ENV === "production",
          degradedBuildCount:
            getKnowledgeBaseInvariantAuditSnapshot().degradedBuildCount,
        }),
        getDedicatedMonitorCredentialReadiness(),
        getStaticTemplateCatalogReadiness(),
      ]);
      const ready =
        fileRetention?.ready === true &&
        (!readinessRequirements.managedUploads ||
          (managedUploads.started === true &&
            managedUploads.storageReady === true)) &&
        knowledgeBaseReadinessHttpStatus(knowledgeBase) === 200 &&
        templateCatalog.ready === true &&
        templateCatalog.requiredAdmissionReady === true &&
        migrationState.journal.status === "exact" &&
        migrationState.schema.status === "exact";
      const status = ready ? 200 : 503;
      const invariantSnapshot = getKnowledgeBaseInvariantAuditSnapshot();
      const response = {
        status: "ok",
        channel: applicationReleaseChannel,
        build: {
          sha: applicationBuildSha,
          imageDigest: applicationImageDigest,
        },
        migration: {
          status: migrationState.journal.status,
          schema: {
            status: migrationState.schema.status,
          },
        },
        schema: {
          status:
            migrationState.schema.status === "exact" &&
            knowledgeBase.dto.schema.status === "ok"
              ? "ok"
              : "unavailable",
        },
        templateCatalog: {
          status: templateCatalog.ready ? "ok" : "unavailable",
          version: templateCatalog.activeCatalogVersion,
          entryCount: templateCatalog.ready ? templateCatalog.entryCount : 0,
          admittedCount: templateCatalog.admittedCount,
          unavailableCount: templateCatalog.unavailableCount,
          requiredAdmissionReady: templateCatalog.requiredAdmissionReady,
        },
        // Build-local findings are observable, but never participate in the
        // readiness decision above. Do not expose their internal codes.
        degradedBuildCount: invariantSnapshot.degradedBuildCount,
        violationCount: invariantSnapshot.violationCount,
      };
      if (!ready) {
        console.error("[Health] readiness_unavailable", {
          code: "READINESS_UNAVAILABLE",
          migrationStatus: migrationState.journal.status,
          schemaStatus: migrationState.schema.status,
          fileRetentionReady: fileRetention?.ready ?? false,
          managedUploadsStarted: managedUploads.started,
          managedUploadsStorageReady: managedUploads.storageReady,
          templateCatalogReady: templateCatalog.ready,
          templateCatalogAdmittedCount: templateCatalog.admittedCount,
          templateCatalogRequiredAdmissionReady:
            templateCatalog.requiredAdmissionReady,
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
    "/api/frontmind/v2",
    requireExpressAuth,
    enforceFrontMindProxyAccess,
    attachOptionalActiveCredential,
    frontmindV2ChatRouter,
  );
  app.use(
    "/api/frontmind",
    requireExpressAuth,
    enforceFrontMindProxyAccess,
    resolveUpstreamCredential,
    manusProxy,
  );
  // One-click enterprise knowledge base workflow powered by the Socratic KB skill.
  app.use(
    "/api/knowledge-base/artifacts",
    requireExpressAuth,
    enforceDeliveryProjectContext,
    rejectDeliveryMemberKnowledgeBaseProjectScope,
    knowledgeBaseArtifactApi,
  );
  app.use(
    "/api/knowledge-base",
    requireExpressAuth,
    enforceDeliveryProjectContext,
    rejectDeliveryMemberKnowledgeBaseProjectScope,
    attachOptionalActiveCredential,
    knowledgeBaseApi,
  );
  // Per-question response logic workflow; the active credential version
  // freezes Base/Pro for each operation.
  app.use(
    "/api/response-logic",
    requireExpressAuth,
    attachOptionalActiveCredential,
    responseLogicApi,
  );
  // Evidence-backed brand question candidates. Capability, quota and the
  // credential-frozen Base/Pro profile are resolved before task creation.
  app.use(
    "/api/brand-question-portfolio",
    requireExpressAuth,
    attachOptionalActiveCredential,
    brandQuestionPortfolioApi,
  );
  // Jenova Brand Tracker conversations use an authenticated SSE transport.
  // Its credential is resolved from the dedicated server-side assignment pool.
  app.use("/api/brand-tracking", requireExpressAuth, brandTrackingApi);
  // Durable user dashboard content and final knowledge-base snapshot imports.
  app.use("/api/dashboard", dashboardApi);
  // Revision-bound, preview-first bulk completion for the five formal website
  // content ticket categories. Domain/ICP prerequisites are not in this API.
  app.use("/api/website-content-template", websiteContentTemplateApi);
  // Tenant-bound SiteOps build previews and immutable download artifacts.
  // Authentication precedes every wildcard path so cross-tenant misses stay
  // indistinguishable from absent artifacts.
  app.use("/api/site-ops", requireExpressAuth, siteOpsArtifactApi);
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

  if (runtimeRoleServesWeb(runtimeRole)) {
    await startApiUsageSnapshotScheduler();
    startDashboardImportPreflightCleanupScheduler();
    // Start only after configuration, durable storage and database startup
    // checks have completed. Importing a route module must never trigger
    // provider side effects or hide a preflight failure.
    await reconcileManagedUploadAccountDeletionFencesOnStartup();
    await ensureManagedUploadIntentWorker();
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`, {
      runtimeRole,
    });
    if (process.env.NODE_ENV === "production") {
      registerSiteOpsRuntimeProviders();
      if (runtimeRoleRunsSiteOps(runtimeRole)) {
        startSiteOpsWorkerScheduler();
      }
      if (runtimeRoleServesWeb(runtimeRole)) {
        startWebsiteAgentRecoveryScheduler();
        startDeliveryTicketRetentionScheduler();
        startConversationRetentionScheduler();
        startJenovaBrandTrackingRecoveryScheduler();
        startServiceContractLifecycleReconciliationScheduler();
        startBrandQuestionUniverseWorkerScheduler();
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
      }
      if (!runtimeRoleRunsKnowledgeBaseWorker(runtimeRole)) return;
      const recoverKnowledgeBaseState = createKnowledgeBaseRecoverySweep({
        recoverExpiredTurns: () => recoverExpiredKnowledgeBaseTurns(),
        cleanupArtifactCandidates: () =>
          cleanupOrphanedKnowledgeBuildArtifactCandidates(),
      });
      const runKnowledgeRecovery = async () => {
        const [recoveryResult, packageResult] = await Promise.allSettled([
          runLeasedKnowledgeBaseRecovery({
            tracker: knowledgeBaseRecoveryHealth,
            recover: recoverKnowledgeBaseState,
          }),
          runKnowledgeBasePackageSweep(),
        ]);
        if (packageResult.status === "fulfilled") {
          const packages = packageResult.value;
          if (packages.scanned || packages.ready || packages.failed) {
            console.info(
              "[KnowledgeBasePackage] scan_complete",
              JSON.stringify(packages),
            );
          }
        } else {
          // Package generation is build-local. Its failure must not hide a
          // successful provider recovery sweep or degrade global readiness.
          console.error(
            "[KnowledgeBasePackage] scan_failed",
            runtimeErrorForLog(packageResult.reason),
          );
        }
        if (recoveryResult.status === "fulfilled") {
          const recovery = recoveryResult.value;
          if (!recovery) return;
          const { claimedTurnIds: _claimedTurnIds, ...turnMetrics } =
            recovery.turns;
          console.info(
            "[KnowledgeBaseRecovery] scan_complete",
            JSON.stringify({
              turns: turnMetrics,
              artifacts: recovery.artifacts,
            }),
          );
        } else {
          console.error(
            "[KnowledgeBaseRecovery] scan_failed",
            runtimeErrorForLog(recoveryResult.reason),
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
        void auditKnowledgeBaseStateInvariants().catch((error) => {
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
        void Promise.all([
          processKnowledgeResetCleanupJobs(),
          sweepOrphanedKnowledgeBaseUploadEvidence(),
          sweepKnowledgeBaseBuildSources(),
        ])
          .then(([, evidence, buildSources]) => {
            if (
              !evidence.scanned &&
              !evidence.failed &&
              !buildSources.scanned &&
              !buildSources.failed
            ) {
              return;
            }
            console.info(
              "[KnowledgeBaseEvidence] orphan_sweep_complete",
              JSON.stringify({ evidence, buildSources }),
            );
          })
          .catch((error) => {
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

async function main() {
  await startServer();
}

main().catch((error) => {
  console.error("[Server] startup_failed", runtimeErrorForLog(error));
  process.exitCode = 1;
});
