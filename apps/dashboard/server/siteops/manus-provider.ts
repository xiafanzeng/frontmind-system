import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";

import {
  knowledgeBaseSnapshots,
  siteBuildInputAssets,
  siteBuilds,
  siteOperations,
  siteProjects,
  socialPackages,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  type SiteOperation,
} from "../../drizzle/schema";
import {
  SITEOPS_MATERIALIZER_V2_0,
  SITEOPS_MATERIALIZER_V2_1,
  SITEOPS_MATERIALIZER_V2_2,
  SITEOPS_MATERIALIZER_V2_3,
  SITEOPS_MATERIALIZER_V2_4,
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_MATERIALIZER_V2_9,
  SITEOPS_WORKFLOW,
  siteBriefSchema,
  visualEvidenceV1Schema,
  visualSelectionBundleSchema,
  visualTaxonomySchema,
  siteOpsWorkflowForVersion,
  type VisualSelectionBundle,
  type VisualSelectionBundleV1,
  type VisualSelectionBundleV2,
  type VisualSelectionBundleV3,
  type VisualSelectionBundleV4,
  type VisualSelectionBundleV5,
  type VisualSelectionBundleV6,
  type VisualSelectionBundleV7,
  type VisualCandidateStyleTokensV1,
} from "../../shared/siteops";
import {
  SITEOPS_CONTENT_PLAN_V2_FILENAME,
  SiteContentPlanValidationError,
  siteContentPlanRoutes,
  siteContentPlanV2FromWire,
  siteContentPlanWireV2Schema,
  validateSiteContentPlanV2,
  type SiteContentPlanV2,
} from "../../shared/siteops-content-plan";
import { createHostOwnedSiteDesignResultV2 } from "../../shared/siteops-host-design";
import {
  managedAgentProfileModel,
  managedAgentProfileSchema,
} from "../../shared/manus-agent-profile";
import {
  canonicalJson,
  createVisualEvidenceV1,
} from "../../shared/siteops-workflow";
import {
  canonicalSiteOpsSha256,
  composeBuildContractV2,
  composeBuildPlanContractV3,
  composeBuildPlanContractV4,
  referenceBlueprintV3ForFamily,
  referenceBlueprintV4ForFamily,
  referenceBlueprintSchema,
  siteDesignResultV1Schema,
  siteDesignResultV2Schema,
  siteOpsRuntimeVisualEvidenceV1Schema,
  siteOpsRuntimeVisualEvidenceV2Schema,
  trustedVisualPreviewBlueprintV3,
  validateDesignAndContentBindings,
} from "../../shared/siteops-design";
import { getDecryptedCredentialForUser } from "../auth-service";
import { getDb } from "../db";
import { assertUpstreamPromptBudget } from "../upstream-prompt-budget";
import {
  classifyManusV2StructuredResultEnvelope,
  latestManusV2WaitingDetail,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  manusV2EventOperationToken,
  manusV2EventsContainOperationToken,
  orderManusV2EventsByProviderRank,
  type ManusV2Attachment,
  type ManusV2MessageEvent,
  type ManusV2StructuredOutputSchema,
} from "../manus-v2-client";
import { readKnowledgeSnapshotArchive } from "../knowledge-snapshot-archive-store";
import {
  generateSocialPackage,
  materializeAstroSite,
  materializeNativeTrustedFallbackSite,
  siteOpsGeneratedContentSchema,
  siteOpsGeneratedContentV2Schema,
  socialPackageInputSchema,
} from "./build-runtime";
import {
  SiteOpsMaterializationError,
  toSiteOpsMaterializationError,
  type SiteOpsMaterializationPhase,
  type SiteOpsMaterializationRetryClass,
  type SiteOpsMaterializationSafeDetails,
} from "./materialization-error";
import {
  persistSiteOpsArtifact,
  readSiteOpsArtifact,
  siteOpsArtifactIdForIdempotency,
} from "./artifact-store";
import {
  registerSiteOpsProviderHandler,
  type SiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";
import { readSelectedOfficialLogoFromKnowledgeArchive } from "./knowledge-brand-asset";
import {
  freezeSelectedKnowledgeMediaFromArchive,
  freezeSiteKnowledgeMedia,
  overlaySiteOpsKnowledgeMedia,
  type TrustedSiteKnowledgeMedia,
} from "./knowledge-content-media";
import {
  knowledgeCoverageInventoryAttachment,
  knowledgeCoverageInventoryFromSnapshot,
  type SupplementalKnowledgeDocument,
  type SupplementalKnowledgeMedia,
} from "./site-content-plan";
import {
  pageContentResultFromWire,
  pageContentResultV2FromWire,
  pageContentWireOutputSchema,
  pageContentWireV3OutputSchema,
  siteDesignResultFromWire,
  siteDesignResultV2FromWire,
  siteDesignWireOutputSchema,
  siteDesignWireV3OutputSchema,
  siteOpsBuildContractAttachment,
  siteOpsBuildPlanContractV3Attachment,
  siteOpsBuildPlanContractV4Attachment,
  siteOpsCustomerFeedbackAttachment,
  siteOpsSocialSourceAttachment,
  siteOpsSourceDossierAttachments,
  socialWireOutputSchema,
  assertSiteOpsStructuredOutputSchema,
} from "./manus-wire-contract";
import {
  resolveSiteOpsWireOutput,
  SITEOPS_WIRE_OUTPUT_FILES,
  SiteOpsWireOutputResolutionError,
  type SiteOpsWireOutputPhase,
} from "./manus-wire-output-resolver";
import {
  canonicalizeSiteContentDraft,
  canonicalPreviewToGeneratedContent,
} from "./site-content-draft";
import { applySiteContentPatchV1Resilient } from "./site-content-patch";
import { terminalTaskState } from "./task-terminal-state";
import {
  FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME,
  FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
  NATIVE_SOURCE_DEFAULT_LIMITS,
  NATIVE_SOURCE_PREFLIGHT_FILENAME,
  NATIVE_SOURCE_PREFLIGHT_SCRIPT,
  NATIVE_SOURCE_PREFLIGHT_SHA256,
  NATIVE_SOURCE_PREFLIGHT_VERSION,
  NATIVE_SOURCE_PREFLIGHT_V2_FILENAME,
  NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT,
  NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
  NATIVE_RUNTIME_CONTRACT_FILENAME,
  NATIVE_RUNTIME_CONTRACT_V1,
  NATIVE_RUNTIME_CONTRACT_V1_BYTES,
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_CONTRACT_VERSION,
  NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_VERSION,
  NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT,
  NATIVE_RUNTIME_ROUTE_MODULE,
  FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME,
  NativeRuntimeContractAuditError,
  NativeReactSourceError,
  TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT,
  TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT,
  TWENTY_FIRST_STATIC_TEMPLATE_V2_8_SYSTEM_PROMPT,
  auditNativeRuntimeContractV1,
  readNativeSourceAttachment,
  siteSourceReceiptV1Schema,
  validateNativeReactSourceArchive,
  type NativeRuntimeAudit,
} from "./native-react-source";
import {
  SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION,
  SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION,
  SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION,
  VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE,
  VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES,
  VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES,
  assertVisualSelectionBundleV6SourceArchiveSize,
  isSiteOpsNativeVisualWorkflowVersion,
  selectedNativeSourceArchive,
} from "./native-visual-source";
import {
  openStaticTemplateCatalogVersionSource,
  requireStaticTemplateCatalogVersion,
  staticTemplateAdmissionEvidenceSha256,
  STATIC_TEMPLATE_SOURCE_MAX_BYTES,
  type StaticTemplateCatalogEntry,
} from "./static-template-catalog";
import {
  NativeReactBuildError,
  materializeNativeReactSource,
  type MaterializedNativeReactSite,
} from "./native-react-build-runtime";
import {
  siteOpsTrustedFallbackPreviewFromResult,
  siteOpsTrustedFallbackPreviewSchema,
} from "./trusted-fallback";
import {
  buildArtifactBindingsSchema,
  buildDeliveryCheckpointSchema,
  formalBuildArtifactStagingSchema,
  NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS,
} from "./build-artifact-checkpoint";

export { terminalTaskState } from "./task-terminal-state";

const PROVIDER_MUTABLE_BUILD_STATUSES = [
  "preparing",
  "visual_searching",
  "awaiting_visual_selection",
  "design_compiling",
  "contract_ready",
  "building",
  "qa_running",
] as const;

const PROVIDER_MUTABLE_SOCIAL_PACKAGE_STATUSES = [
  "queued",
  "building",
] as const;

const operationInputSchema = z
  .object({
    credentialScope: z.literal("customer"),
    manusCredentialId: z.string().uuid(),
    manusCredentialVersion: z.number().int().positive(),
    agentProfile: managedAgentProfileSchema.default("frontmind-pro"),
    buildId: z.string().uuid().optional(),
    childBuildId: z.string().uuid().optional(),
    parentBuildId: z.string().uuid().optional(),
    feedback: z.string().trim().min(1).max(20_000).optional(),
    channel: z.enum(["wechat", "xiaohongshu"]).optional(),
    packageId: z.string().uuid().optional(),
    topic: z.string().trim().max(500).optional(),
    referenceBlueprint: referenceBlueprintSchema.optional(),
    revisionBaseline: z
      .object({
        schemaVersion: z.literal(1),
        parentBuildId: z.string().uuid(),
        sourceLocalAssetId: z.string().uuid(),
        sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        contentPlanLocalAssetId: z.string().uuid(),
        contentPlanSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .optional(),
    revisionInputAssets: z
      .array(
        z
          .object({
            schemaVersion: z.literal(1),
            localAssetId: z.string().uuid(),
            filename: z.string().trim().min(1).max(512),
            mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            sizeBytes: z
              .number()
              .int()
              .positive()
              .max(8 * 1024 * 1024),
            contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            publicPath: z
              .string()
              .regex(
                /^\/frontmind-user-media\/[a-f0-9]{64}\.(?:png|jpg|webp)$/u,
              ),
            siteOpsKnowledgeInputEpochId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .passthrough();

const designResultSchema = z.union([
  siteDesignResultV2Schema,
  siteDesignResultV1Schema,
]);

const designValidationReasonSchema = z.enum([
  "STRUCTURED_OUTPUT_UNAVAILABLE",
  "DESIGN_WIRE_SCHEMA_MISMATCH",
  "SLOT_ID_FORMAT",
  "ROUTE_SET_MISMATCH",
  "ROUTE_MISSING",
  "SLOT_ORDER_INVALID",
  "SLOT_DUPLICATE",
  "PALETTE_INDEX_INVALID",
  "TEXT_LIMIT",
  "OUTPUT_CONFLICT",
]);
export type DesignValidationReason = z.infer<
  typeof designValidationReasonSchema
>;

const repairReasonSchema = z.enum([
  ...designValidationReasonSchema.options,
  "EMPTY_TYPED_BLOCK_BODY",
  "INVALID_ENTITY_SLUG",
  "SOURCE_OR_ROUTE_MISMATCH",
  "CONTENT_BINDING_MISMATCH",
  "CONTENT_CONTRACT_MISMATCH",
]);
type RepairReason = z.infer<typeof repairReasonSchema>;

const providerStageSchema = z.enum([
  "content_plan_pending",
  "content_plan_repair_send_ready",
  "content_plan_repair_send_unknown",
  "content_plan_repair_pending",
  "native_source_send_ready",
  "native_source_send_unknown",
  "native_input_ready",
  "create_unknown",
  "native_source_pending",
  "native_repair_send_ready",
  "native_repair_send_unknown",
  "native_repair_pending",
  "design_pending",
  "content_send_ready",
  "content_send_unknown",
  "content_pending",
  "repair_send_ready",
  "repair_send_unknown",
  "repair_pending",
  "create_rejected",
]);

const providerBuildPhaseSchema = z.enum([
  "source_waiting",
  "source_repairing",
  "provider_sync_delayed",
  "source_validating",
  "compiling",
  "persisting_preview",
]);

const providerBuildCheckpointSchema = z.enum([
  "receipt_validated",
  "archive_downloaded",
  "archive_validated",
  "compile_started",
  "artifacts_staged",
  "artifacts_bound",
  "preview_ready",
]);

/**
 * Bump this coordinate whenever the deterministic archive validator changes
 * in a way that could make a previously rejected source archive acceptable.
 * It deliberately does not follow the application release SHA: ordinary
 * releases must not make a known-bad provider attachment hot-loop again.
 */
export const NATIVE_SOURCE_VALIDATOR_VERSION =
  "native-react-source-and-build-v5.2026-08-30" as const;

const nativeSourceAttachmentScopeSchema = z
  .object({
    taskId: z.string().min(1).max(255),
    repairAttempt: z
      .number()
      .int()
      .min(0)
      .max(NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS),
    operationToken: z.string().min(1).max(512),
  })
  .strict();

type NativeSourceAttachmentScope = z.infer<
  typeof nativeSourceAttachmentScopeSchema
>;

const nativeSourceRuntimeCoordinatesSchema = z
  .object({
    contractVersion: z.string().min(1).max(128),
    contractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    executionShellVersion: z.string().min(1).max(128),
    executionShellSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    preflightVersion: z.string().min(1).max(128),
    preflightSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type NativeSourceRuntimeCoordinates = z.infer<
  typeof nativeSourceRuntimeCoordinatesSchema
>;

const replayableSiteSourceReceiptV2Schema = z
  .object({
    operationToken: z.string().min(1).max(256),
    baseSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    fileCount: z.number().int().min(1).max(512),
    preflightVersion: z.string().min(1).max(128),
    preflightStatus: z.literal("passed"),
    preflightSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    runtimeContractVersion: z.string().min(1).max(128),
    runtimeContractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    executionShellSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    executionBaselineSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    contentPlanSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

const persistedSiteSourceReceiptSchema = z.union([
  siteSourceReceiptV1Schema,
  replayableSiteSourceReceiptV2Schema,
]);
type PersistedSiteSourceReceipt = z.infer<
  typeof persistedSiteSourceReceiptSchema
>;

const nativeRejectedCandidateV1Schema = z
  .object({
    taskId: z.string().min(1).max(255),
    repairAttempt: z
      .number()
      .int()
      .min(0)
      .max(NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS),
    operationToken: z.string().min(1).max(512),
    attachmentIdentity: z.string().min(1).max(768),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    // Historical versions remain parseable so a validator bump revalidates
    // the candidate once instead of invalidating the whole provider state.
    validatorVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u),
    errorCode: z.string().regex(/^NATIVE_(?:SOURCE|BUILD)_[A-Z0-9_]{1,112}$/u),
    verdictSignature: z.string().regex(/^[a-f0-9]{64}$/u),
    rejectedAt: z.string().datetime(),
  })
  .strict();

type NativeRejectedCandidateV1 = z.infer<
  typeof nativeRejectedCandidateV1Schema
>;

type NativeRejectedCandidateCoordinates = Pick<
  NativeRejectedCandidateV1,
  | "taskId"
  | "repairAttempt"
  | "operationToken"
  | "attachmentIdentity"
  | "archiveSha256"
  | "validatorVersion"
>;

function nativeRejectedCandidateVerdictSignature(
  input: Omit<NativeRejectedCandidateV1, "verdictSignature" | "rejectedAt">,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        taskId: input.taskId,
        repairAttempt: input.repairAttempt,
        operationToken: input.operationToken,
        attachmentIdentity: input.attachmentIdentity,
        archiveSha256: input.archiveSha256,
        validatorVersion: input.validatorVersion,
        errorCode: input.errorCode,
      }),
      "utf8",
    )
    .digest("hex");
}

export function createNativeRejectedCandidateV1(input: {
  taskId: string;
  repairAttempt: number;
  operationToken: string;
  attachmentIdentity: string;
  archiveSha256: string;
  errorCode: string;
  rejectedAt?: Date;
}): NativeRejectedCandidateV1 {
  const unsigned = {
    taskId: input.taskId,
    repairAttempt: input.repairAttempt,
    operationToken: input.operationToken,
    attachmentIdentity: input.attachmentIdentity,
    archiveSha256: input.archiveSha256,
    validatorVersion: NATIVE_SOURCE_VALIDATOR_VERSION,
    errorCode: input.errorCode,
  } as const;
  return nativeRejectedCandidateV1Schema.parse({
    ...unsigned,
    verdictSignature: nativeRejectedCandidateVerdictSignature(unsigned),
    rejectedAt: (input.rejectedAt ?? new Date()).toISOString(),
  });
}

export function nativeRejectedCandidateMatches(
  verdict: NativeRejectedCandidateV1 | undefined,
  coordinates: NativeRejectedCandidateCoordinates,
) {
  if (!verdict) return false;
  const parsed = nativeRejectedCandidateV1Schema.safeParse(verdict);
  if (!parsed.success) return false;
  const candidate = parsed.data;
  return (
    candidate.taskId === coordinates.taskId &&
    candidate.repairAttempt === coordinates.repairAttempt &&
    candidate.operationToken === coordinates.operationToken &&
    candidate.attachmentIdentity === coordinates.attachmentIdentity &&
    candidate.archiveSha256 === coordinates.archiveSha256 &&
    candidate.validatorVersion === coordinates.validatorVersion &&
    candidate.verdictSignature ===
      nativeRejectedCandidateVerdictSignature({
        taskId: candidate.taskId,
        repairAttempt: candidate.repairAttempt,
        operationToken: candidate.operationToken,
        attachmentIdentity: candidate.attachmentIdentity,
        archiveSha256: candidate.archiveSha256,
        validatorVersion: candidate.validatorVersion,
        errorCode: candidate.errorCode,
      })
  );
}

const providerReadFailureSchema = z
  .object({
    operation: z.string().regex(/^(?:task|file)\.[A-Za-z][A-Za-z0-9.]{0,62}$/u),
    status: z.number().int().min(100).max(599).nullable(),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
    retryable: z.boolean(),
    retryAfterMs: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 1_000)
      .nullable(),
    transportCause: z
      .enum([
        "dns_temporary",
        "dns_not_found",
        "connection_refused",
        "network_unreachable",
        "host_unreachable",
        "connection_reset",
        "timeout",
        "tls",
        "unknown",
      ])
      .nullable(),
    transportPhase: z
      .enum(["dns", "connect", "request", "tls", "timeout", "unknown"])
      .nullable(),
  })
  .strict();

const providerStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stage: providerStageSchema,
    taskId: z.string().min(1).max(255).optional(),
    design: designResultSchema.optional(),
    repairKind: z.enum(["design", "content"]).optional(),
    repairCategory: z
      .enum(["extraction", "design", "content", "materialization"])
      .optional(),
    repairAttempt: z.number().int().min(1).max(3).optional(),
    repairReason: repairReasonSchema.optional(),
    resultPendingSince: z.string().datetime().optional(),
    handledWaitingEventId: z.string().min(1).max(512).optional(),
    handledWaitingAt: z.string().datetime().optional(),
    providerDraftUnavailable: z.boolean().optional(),
    nativeRepairAttempt: z
      .number()
      .int()
      .min(0)
      .max(NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS)
      .optional(),
    nativeLastErrorSignature: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    nativeRejectedCandidateV1: nativeRejectedCandidateV1Schema.optional(),
  })
  .strict();

const providerAttemptsSchema = z
  .object({
    extraction: z.number().int().min(0).max(1),
    design: z.number().int().min(0).max(2),
    content: z.number().int().min(0).max(3),
    materialization: z.number().int().min(0).max(1),
  })
  .strict();

const nativeSourceRepairInputSchema = z
  .object({
    attempt: z.number().int().min(1).max(NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS),
    kind: z.enum(["compile", "hard_safety"]),
    diagnostics: z
      .array(
        z
          .object({
            code: z.string().min(1).max(128),
            file: z.string().min(1).max(500).nullable(),
            line: z.number().int().positive().nullable(),
            column: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

type NativeSourceRepairInput = z.infer<typeof nativeSourceRepairInputSchema>;

const providerValidationSchema = z
  .object({
    phase: z.enum(["design", "content"]),
    source: z.enum(["structured", "attachment", "assistant_json"]),
    candidateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    signature: z.string().regex(/^[a-f0-9]{64}$/u),
    reason: repairReasonSchema,
    repeatCount: z.number().int().min(0).max(3),
  })
  .strict();

const providerStateV2Schema = providerStateV1Schema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(2),
    attempts: providerAttemptsSchema,
    validation: providerValidationSchema.optional(),
    buildPhase: providerBuildPhaseSchema.optional(),
    buildCheckpoint: providerBuildCheckpointSchema.optional(),
    providerReadFailureCount: z.number().int().min(0).max(100_000).optional(),
    providerReadFailureSince: z.string().datetime().optional(),
    providerNextPollAt: z.string().datetime().optional(),
    providerTaskNotFoundCount: z.number().int().min(0).max(3).optional(),
    phaseOperationToken: z.string().min(1).max(512).optional(),
    phaseStartedAt: z.string().datetime().optional(),
    lastContractProgressAt: z.string().datetime().optional(),
    providerStoppedAt: z.string().datetime().optional(),
    providerStoppedOperationToken: z.string().min(1).max(512).optional(),
    resultPendingOperationToken: z.string().min(1).max(512).optional(),
    providerSyncStartedAt: z.string().datetime().optional(),
    providerLastReadFailure: providerReadFailureSchema.optional(),
    // V2 is written before a new task-side effect. A historical bound task
    // without this field remains a V1 receipt conversation and is never
    // silently upgraded in place.
    nativeSourceContractVersion: z.literal(2).optional(),
    nativeSourceRuntimeCoordinates:
      nativeSourceRuntimeCoordinatesSchema.optional(),
    contentPlanAttempt: z.number().int().min(0).max(1).optional(),
    contentPlanOperationToken: z.string().min(1).max(512).optional(),
    contentPlanInventorySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    contentPlanLocalAssetId: z.string().uuid().optional(),
    contentPlanSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    nativeRepairInput: nativeSourceRepairInputSchema.optional(),
    nativeSourceFileId: z.string().min(1).max(512).optional(),
    nativeSourceAttachmentEventId: z.string().min(1).max(512).optional(),
    nativeSourceAttachmentIdentity: z.string().min(1).max(768).optional(),
    nativeSourceAttachmentScope: nativeSourceAttachmentScopeSchema.optional(),
    nativeInputProviderFile: z
      .object({
        sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z
          .number()
          .int()
          .positive()
          // V7 catalog archives can be larger than the historical V6 source
          // ceiling. V6 bytes are still rejected by the explicit assertion in
          // providerSourceAttachment before this durable receipt is written.
          .max(STATIC_TEMPLATE_SOURCE_MAX_BYTES),
        filename: z.literal("frontmind-selected-21st-source-v1.zip"),
        fileId: z.string().min(1).max(512),
        expiresAt: z.number().int().positive(),
        status: z.literal("uploaded"),
      })
      .strict()
      .optional(),
    nativeSourceReadFailureCount: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional(),
    nativeSourceReadFailureSince: z.string().datetime().optional(),
    nativeSourceNextPollAt: z.string().datetime().optional(),
    nativeSourceStaging: z
      .object({
        assetId: z.string().uuid(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z
          .number()
          .int()
          .positive()
          .max(100 * 1024 * 1024),
        expiresAt: z.string().datetime(),
        taskId: z.string().min(1).max(255).optional(),
        repairAttempt: z
          .number()
          .int()
          .min(0)
          .max(NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS)
          .optional(),
        // Optional for operations staged before provider-offline resume was
        // introduced. New archive_validated checkpoints always freeze it.
        receipt: persistedSiteSourceReceiptSchema.optional(),
      })
      .strict()
      .optional(),
    artifactStaging: formalBuildArtifactStagingSchema.optional(),
    existingTaskOnly: z.boolean().optional(),
    fallbackPreviewFailureCount: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional(),
    fallbackPreviewNextPollAt: z.string().datetime().optional(),
    fallbackPreviewLastErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
      .optional(),
    fallbackPreview: siteOpsTrustedFallbackPreviewSchema.optional(),
  })
  .strict();

const providerStateSchema = z.union([
  providerStateV2Schema,
  providerStateV1Schema,
]);

type ProviderState = z.infer<typeof providerStateSchema>;
type ProviderStateV2 = z.infer<typeof providerStateV2Schema>;

type NativeSourceRuntimeValidationInput = {
  archive: Buffer;
  receipt: unknown;
  expectedOperationToken: string;
  expectedBaseSourceSha256: string;
  expectedExecutionBaselineSha256: string;
  expectedContentPlanSha256?: string;
};

export type NativeSourceRuntimeRegistryEntry = Readonly<{
  coordinates: NativeSourceRuntimeCoordinates;
  attachments: readonly ManusV2Attachment[];
  receiptSchema: z.ZodType<PersistedSiteSourceReceipt>;
  validate: (
    input: NativeSourceRuntimeValidationInput,
  ) => ReturnType<typeof validateNativeReactSourceArchive>;
  audit: (input: {
    files: ReadonlyMap<string, Buffer>;
    expectedRoutePaths: readonly string[];
    requireCanonicalSitePathname?: boolean;
  }) => NativeRuntimeAudit;
}>;

export type NativeSourceRuntimeRegistry = Readonly<{
  current: NativeSourceRuntimeRegistryEntry;
  resolve: (
    coordinates: NativeSourceRuntimeCoordinates,
  ) => NativeSourceRuntimeRegistryEntry | null;
}>;

function nativeSourceRuntimeRegistryKey(
  coordinates: NativeSourceRuntimeCoordinates,
) {
  return [
    coordinates.contractSha256,
    coordinates.executionShellSha256,
    coordinates.preflightSha256,
  ].join(":");
}

function nativeSourceRuntimeCoordinatesMatch(
  left: NativeSourceRuntimeCoordinates,
  right: NativeSourceRuntimeCoordinates,
) {
  return (
    left.contractVersion === right.contractVersion &&
    left.contractSha256 === right.contractSha256 &&
    left.executionShellVersion === right.executionShellVersion &&
    left.executionShellSha256 === right.executionShellSha256 &&
    left.preflightVersion === right.preflightVersion &&
    left.preflightSha256 === right.preflightSha256
  );
}

export function createNativeSourceRuntimeRegistry(input: {
  current: NativeSourceRuntimeRegistryEntry;
  entries?: readonly NativeSourceRuntimeRegistryEntry[];
}): NativeSourceRuntimeRegistry {
  const currentCoordinates = nativeSourceRuntimeCoordinatesSchema.parse(
    input.current.coordinates,
  );
  const entries = input.entries ?? [input.current];
  const byHashes = new Map<string, NativeSourceRuntimeRegistryEntry>();
  for (const entry of entries) {
    const coordinates = nativeSourceRuntimeCoordinatesSchema.parse(
      entry.coordinates,
    );
    const key = nativeSourceRuntimeRegistryKey(coordinates);
    const prior = byHashes.get(key);
    if (
      prior &&
      !nativeSourceRuntimeCoordinatesMatch(prior.coordinates, coordinates)
    ) {
      throw new Error("NATIVE_SOURCE_RUNTIME_REGISTRY_HASH_COLLISION");
    }
    byHashes.set(key, { ...entry, coordinates });
  }
  const current = byHashes.get(
    nativeSourceRuntimeRegistryKey(currentCoordinates),
  );
  if (
    !current ||
    !nativeSourceRuntimeCoordinatesMatch(
      current.coordinates,
      currentCoordinates,
    )
  ) {
    throw new Error("NATIVE_SOURCE_RUNTIME_REGISTRY_CURRENT_MISSING");
  }
  return Object.freeze({
    current,
    resolve(coordinates: NativeSourceRuntimeCoordinates) {
      const parsed = nativeSourceRuntimeCoordinatesSchema.parse(coordinates);
      const entry = byHashes.get(nativeSourceRuntimeRegistryKey(parsed));
      return entry &&
        nativeSourceRuntimeCoordinatesMatch(entry.coordinates, parsed)
        ? entry
        : null;
    },
  });
}

function nativeSourceReceiptV2SchemaForRuntime(
  coordinates: NativeSourceRuntimeCoordinates,
) {
  return replayableSiteSourceReceiptV2Schema.extend({
    preflightVersion: z.literal(coordinates.preflightVersion),
    preflightSha256: z.literal(coordinates.preflightSha256),
    runtimeContractVersion: z.literal(coordinates.contractVersion),
    runtimeContractSha256: z.literal(coordinates.contractSha256),
    executionShellSha256: z.literal(coordinates.executionShellSha256),
  });
}

const CURRENT_NATIVE_SOURCE_RUNTIME_COORDINATES =
  nativeSourceRuntimeCoordinatesSchema.parse({
    contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
    contractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
    executionShellVersion: NATIVE_RUNTIME_EXECUTION_SHELL_VERSION,
    executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
    preflightVersion: NATIVE_SOURCE_PREFLIGHT_V2_VERSION,
    preflightSha256: NATIVE_SOURCE_PREFLIGHT_V2_SHA256,
  });

const CURRENT_NATIVE_SOURCE_RUNTIME_ENTRY: NativeSourceRuntimeRegistryEntry =
  Object.freeze({
    coordinates: CURRENT_NATIVE_SOURCE_RUNTIME_COORDINATES,
    attachments: Object.freeze([
      {
        filename: NATIVE_RUNTIME_CONTRACT_FILENAME,
        mime_type: "application/json",
        file_data: `data:application/json;base64,${NATIVE_RUNTIME_CONTRACT_V1_BYTES.toString("base64")}`,
      },
      {
        filename: NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
        mime_type: "application/json",
        file_data: `data:application/json;base64,${NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES.toString("base64")}`,
      },
      {
        filename: NATIVE_SOURCE_PREFLIGHT_V2_FILENAME,
        mime_type: "text/javascript",
        file_data: `data:text/javascript;base64,${NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT.toString("base64")}`,
      },
    ] satisfies ManusV2Attachment[]),
    receiptSchema: nativeSourceReceiptV2SchemaForRuntime(
      CURRENT_NATIVE_SOURCE_RUNTIME_COORDINATES,
    ),
    validate: (input) =>
      validateNativeReactSourceArchive({
        ...input,
        requiredReceiptVersion: 2,
        runtimeContract: NATIVE_RUNTIME_CONTRACT_V1,
      }),
    audit: (input) =>
      auditNativeRuntimeContractV1({
        ...input,
        contract: NATIVE_RUNTIME_CONTRACT_V1,
      }),
  });

const DEFAULT_NATIVE_SOURCE_RUNTIME_REGISTRY =
  createNativeSourceRuntimeRegistry({
    current: CURRENT_NATIVE_SOURCE_RUNTIME_ENTRY,
  });

type ManusBuildLogStage =
  | "wire_intake"
  | "wire_repaired"
  | "wire_resolution"
  | "wire_validation"
  | "wire_normalized"
  | "content_canonicalized"
  | "native_source_intake"
  | "provider_read_deferred"
  | "provider_read_recovered"
  | "source_receipt_validated"
  | "source_archive_downloaded"
  | "source_archive_validated"
  | "native_compile_started"
  | "artifacts_staged"
  | "native_compile"
  | "native_repair_scheduled"
  | "palette_normalized"
  | "primary_render"
  | "fallback_render"
  | "repair_scheduled"
  | "qa_completed"
  | "preview_persisted"
  | "build_preview_ready";

function logManusBuildStage(input: {
  stage: ManusBuildLogStage;
  operationId: string;
  buildId: string;
  phase?: "design" | "content";
  source?: "structured" | "attachment" | "assistant_json";
  byteCount?: number;
  candidateSha256?: string;
  routeCount?: number;
  slotCount?: number;
  missingCount?: number;
  reason?: string;
  signature?: string;
  latencyMs?: number;
  renderMode?:
    | "primary"
    | "content_patch"
    | "trusted_fallback"
    | "twenty_first_native";
  qaStatus?: "passed" | "passed_with_warnings" | "partial";
  warningCount?: number;
}) {
  const release = process.env.FRONTMIND_BUILD_SHA?.trim() ?? "";
  console.info("[siteops-manus] build_stage", {
    event: "siteops_manus_build_stage",
    stage: input.stage,
    operationId: input.operationId,
    buildId: input.buildId,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.byteCount !== undefined ? { byteCount: input.byteCount } : {}),
    ...(input.candidateSha256
      ? { candidateSha256: input.candidateSha256 }
      : {}),
    ...(input.routeCount !== undefined ? { routeCount: input.routeCount } : {}),
    ...(input.slotCount !== undefined ? { slotCount: input.slotCount } : {}),
    ...(input.missingCount !== undefined
      ? { missingCount: input.missingCount }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.signature ? { signature: input.signature } : {}),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(input.renderMode ? { renderMode: input.renderMode } : {}),
    ...(input.qaStatus ? { qaStatus: input.qaStatus } : {}),
    ...(input.warningCount !== undefined
      ? { warningCount: input.warningCount }
      : {}),
    releaseSha: /^[a-f0-9]{40}$/u.test(release) ? release : null,
  });
}

const emptyProviderAttempts = () => ({
  extraction: 0,
  design: 0,
  content: 0,
  materialization: 0,
});

const NATIVE_SOURCE_STAGING_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS = 5 * 60 * 1_000;
export const NATIVE_FALLBACK_INITIAL_RECONCILIATION_MS = 60_000;

export function nativeFallbackReconciliationDelayMs(
  createdAt: string,
  now = Date.now(),
) {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) && now - parsed < 60_000
    ? NATIVE_FALLBACK_INITIAL_RECONCILIATION_MS
    : NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS;
}

function providerStateV2(state: ProviderState | null): ProviderStateV2 {
  if (state?.schemaVersion === 2) return state;
  const attempts = emptyProviderAttempts();
  if (state?.repairKind && state.repairAttempt) {
    attempts[state.repairKind] = Math.min(
      state.repairAttempt,
      state.repairKind === "design" ? 2 : 3,
    );
  }
  return providerStateV2Schema.parse({
    schemaVersion: 2,
    stage: state?.stage ?? "create_unknown",
    taskId: state?.taskId,
    design: state?.design,
    repairKind: state?.repairKind,
    repairCategory: state?.repairCategory,
    repairAttempt: state?.repairAttempt,
    repairReason: state?.repairReason,
    resultPendingSince: state?.resultPendingSince,
    handledWaitingEventId: state?.handledWaitingEventId,
    handledWaitingAt: state?.handledWaitingAt,
    providerDraftUnavailable: state?.providerDraftUnavailable,
    nativeRepairAttempt: state?.nativeRepairAttempt,
    nativeLastErrorSignature: state?.nativeLastErrorSignature,
    nativeRejectedCandidateV1: state?.nativeRejectedCandidateV1,
    attempts,
  });
}

function transitionProviderState(
  state: ProviderState | null,
  patch: Partial<
    Omit<ProviderStateV2, "schemaVersion" | "attempts" | "validation">
  > &
    Pick<ProviderStateV2, "stage">,
): ProviderStateV2 {
  const current = providerStateV2(state);
  return providerStateV2Schema.parse({
    ...current,
    ...patch,
    schemaVersion: 2,
    attempts: current.attempts,
    validation: current.validation,
  });
}

type ManusProviderDependencies = {
  getDb?: typeof getDb;
  getCredential?: typeof getDecryptedCredentialForUser;
  createClient?: (input: {
    apiKey: string;
    credentialId: string;
  }) => ManusV2Client;
  readSnapshotArchive?: typeof readKnowledgeSnapshotArchive;
  persistArtifact?: typeof persistSiteOpsArtifact;
  readArtifact?: typeof readSiteOpsArtifact;
  materializeSite?: typeof materializeAstroSite;
  materializeNativeTrustedFallbackSite?: typeof materializeNativeTrustedFallbackSite;
  materializeNativeSite?: typeof materializeNativeReactSource;
  generateSocial?: typeof generateSocialPackage;
  nativeSourceRuntimeRegistry?: NativeSourceRuntimeRegistry;
};

class SiteOpsManusFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: "failed" | "attention_required" = "attention_required",
    readonly result?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const SAFE_MATERIALIZATION_DETAIL_KEY =
  /^(?:durationMs|assetDecisionCount|publishedCount|omittedCount|omittedDuplicateCount|quarantineCount|exitCode|signal|performance|accessibility|bestPractices|seo|cls|axeViolationCount|axeViolationIds|failedAuditIds|localRetryCount|checkId)$/u;

function untypedMaterializationCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.match(/^SITEOPS_[A-Z0-9_]+/u)?.[0] ??
    "SITEOPS_HOST_MATERIALIZATION_FAILED"
  );
}

export function classifySiteOpsMaterializationFailure(
  error: unknown,
): SiteOpsMaterializationError {
  if (error instanceof SiteOpsMaterializationError) return error;
  const code = untypedMaterializationCode(error);
  let phase: SiteOpsMaterializationPhase = "source_generation";
  let retryClass: SiteOpsMaterializationRetryClass = "host_deterministic";
  if (/(?:ASSET|QUARANTIN)/u.test(code)) phase = "asset_projection";
  else if (/ASTRO_BUILD/u.test(code)) phase = "astro_build";
  else if (/LIGHTHOUSE/u.test(code)) phase = "lighthouse";
  else if (/AXE|BROWSER|PLAYWRIGHT/u.test(code)) phase = "browser_qa";
  else if (/QA_PACKAG|ARCHIVE|ARTIFACT_HASH/u.test(code)) {
    phase = "qa_packaging";
  } else if (/_QA_|QA_FAILED/u.test(code)) phase = "static_qa";
  if (/(?:GENERATED_|CONTENT_|SENSITIVE_OR_DEMO_TEXT)/u.test(code)) {
    retryClass = "content_repair";
  } else if (
    /(?:BROWSER_LAUNCH|CHROME|ECONNREFUSED|ETIMEDOUT|LIGHTHOUSE_NO_RESULT)/u.test(
      `${code}:${error instanceof Error ? error.message : ""}`,
    )
  ) {
    retryClass = "host_transient";
  }
  return toSiteOpsMaterializationError({
    error,
    phase,
    fallbackCode: code,
    retryClass,
  });
}

function safeMaterializationDetails(
  error: SiteOpsMaterializationError,
  base: SiteOpsMaterializationSafeDetails,
) {
  const details: SiteOpsMaterializationSafeDetails = { ...base };
  for (const [key, value] of Object.entries(error.safeDetails)) {
    if (!SAFE_MATERIALIZATION_DETAIL_KEY.test(key)) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      details[key] = typeof value === "string" ? value.slice(0, 512) : value;
    }
  }
  return details;
}

export async function materializeWithSingleHostRetry<T>(input: {
  run: () => Promise<T>;
  signal: AbortSignal;
}) {
  let localRetryCount = 0;
  while (true) {
    input.signal.throwIfAborted();
    try {
      return {
        value: await input.run(),
        localRetryCount,
      };
    } catch (error) {
      input.signal.throwIfAborted();
      const classified = classifySiteOpsMaterializationFailure(error);
      if (classified.retryClass !== "host_transient" || localRetryCount >= 1) {
        throw classified;
      }
      localRetryCount += 1;
    }
  }
}

function publicMaterializationFailure(
  error: SiteOpsMaterializationError,
  taskId: string,
  diagnostics: Record<string, unknown>,
): SiteOpsProviderResult {
  if (error.retryClass === "host_transient") {
    return {
      status: "failed",
      code: "BUILD_FALLBACK_RENDER_FAILED",
      message: "主渲染与可信基础模板均未能完成，请申请重置并全新开始。",
      providerTaskId: taskId,
      result: diagnostics,
    };
  }
  if (error.phase === "asset_projection") {
    return {
      status: "failed",
      code: "BUILD_INPUT_UNSAFE",
      message: "冻结输入包含无法安全发布的资产，请申请重置并全新开始。",
      providerTaskId: taskId,
      result: diagnostics,
    };
  }
  if (["astro_build", "react_static_build"].includes(String(error.phase))) {
    return {
      status: "failed",
      code: "BUILD_FALLBACK_RENDER_FAILED",
      message: "主渲染与可信基础模板均未能完成，请申请重置并全新开始。",
      providerTaskId: taskId,
      result: diagnostics,
    };
  }
  if (error.phase === "artifact_persistence") {
    const bindingFailure = /(?:HASH_MISMATCH|BINDING)/u.test(error.code);
    return {
      status: "failed",
      code: bindingFailure
        ? "BUILD_ARTIFACT_BINDING_FAILED"
        : "BUILD_ARTIFACT_PERSIST_FAILED",
      message: "预览产物保存或摘要校验失败，请申请重置并全新开始。",
      providerTaskId: taskId,
      result: diagnostics,
    };
  }
  return {
    status: "failed",
    code: "BUILD_INPUT_UNSAFE",
    message: "冻结输入未通过安全校验，请申请重置并全新开始。",
    providerTaskId: taskId,
    result: diagnostics,
  };
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const workflowPackagePromises = new Map<string, Promise<Buffer>>();

function workflowRoots(workflow: ReturnType<typeof siteOpsWorkflowForVersion>) {
  const configured = process.env.FRONTMIND_SITEOPS_WORKFLOW_PATH?.trim();
  const directory = workflow.frontMindVersion.startsWith("2.")
    ? `react-static-company-site-workflow-v${workflow.frontMindVersion}`
    : `astro-company-site-workflow-v${workflow.frontMindVersion}`;
  return [
    ...(configured &&
    workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion
      ? [path.resolve(configured)]
      : []),
    path.resolve(process.cwd(), "private-workflows", directory),
    path.resolve(process.cwd(), "dist/private-workflows", directory),
  ];
}

function reactStaticRendererCoordinates(
  workflow: ReturnType<typeof siteOpsWorkflowForVersion>,
) {
  if (
    workflow.frontMindVersion === SITEOPS_MATERIALIZER_V2_0.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_0.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_0.materializerVersion,
    } as const;
  }
  if (
    workflow.frontMindVersion === SITEOPS_MATERIALIZER_V2_1.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_1.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_1.materializerVersion,
    } as const;
  }
  if (
    workflow.frontMindVersion === SITEOPS_MATERIALIZER_V2_2.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_2.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_2.materializerVersion,
    } as const;
  }
  if (
    workflow.frontMindVersion === SITEOPS_MATERIALIZER_V2_3.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_3.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_3.materializerVersion,
    } as const;
  }
  if (
    workflow.frontMindVersion === SITEOPS_MATERIALIZER_V2_4.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_4.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_4.materializerVersion,
    } as const;
  }
  if (workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion) {
    return {
      componentLibraryVersion: SITEOPS_WORKFLOW.componentLibraryVersion,
      materializerVersion: SITEOPS_WORKFLOW.materializerVersion,
    } as const;
  }
  throw new SiteOpsManusFailure(
    "SITEOPS_REACT_WORKFLOW_VERSION_UNSUPPORTED",
    "FrontMind React 建站工作流版本不受支持。",
    "failed",
  );
}

export function usesBuildPlanContractV4(workflowVersion: string) {
  return (
    workflowVersion === SITEOPS_MATERIALIZER_V2_2.frontMindVersion ||
    workflowVersion === SITEOPS_MATERIALIZER_V2_3.frontMindVersion ||
    workflowVersion === SITEOPS_MATERIALIZER_V2_4.frontMindVersion ||
    workflowVersion === SITEOPS_WORKFLOW.frontMindVersion
  );
}

/** Workflow 2.4 removes provider-owned design coordinates. The host accepts a
 * deliberately lossy content draft and deterministically fills every frozen
 * route and slot from trusted input. Keep the explicit version boundary so
 * historical 2.3 tasks retain their immutable two-phase contract. */
export function usesHostOwnedContentDraft(workflowVersion: string) {
  return workflowVersion === SITEOPS_WORKFLOW.frontMindVersion;
}

/** Convert the fail-soft patch result into host-only materializer controls.
 * Warning details remain in internal diagnostics; delivery receives one
 * stable, public-safe coordinate whenever a frozen slot default was used. */
export function contentPatchMaterializationOverrides(input: {
  renderMode: "content_patch" | "trusted_fallback" | null;
  warningCount: number;
}) {
  if (input.renderMode === "content_patch") {
    return {
      renderModeOverride: "content_patch" as const,
      ...(input.warningCount > 0
        ? { contentPatchUsesTrustedDefaults: true as const }
        : {}),
    };
  }
  if (input.renderMode === "trusted_fallback") {
    return {
      forceTrustedFallback: {
        warningCode: "SITEOPS_CONTENT_PATCH_TRUSTED_FALLBACK",
      },
    };
  }
  return {};
}

export async function loadVerifiedSiteOpsWorkflowPackage(
  workflow: ReturnType<typeof siteOpsWorkflowForVersion> = SITEOPS_WORKFLOW,
) {
  const existing = workflowPackagePromises.get(workflow.frontMindVersion);
  if (existing) return existing;
  const loading = (async () => {
    let root: string | null = null;
    let manifestBytes: Buffer | null = null;
    for (const candidate of workflowRoots(workflow)) {
      try {
        manifestBytes = await readFile(path.join(candidate, "MANIFEST.json"));
        root = candidate;
        break;
      } catch {
        // Try the next trusted source/runtime location.
      }
    }
    if (!root || !manifestBytes) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_NOT_FOUND",
        `FrontMind ${workflow.frontMindVersion} 建站工作流未进入运行镜像。`,
      );
    }
    if (sha256(manifestBytes) !== workflow.runtimeManifestSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_MANIFEST_MISMATCH",
        `FrontMind ${workflow.frontMindVersion} 建站工作流 manifest 哈希不一致。`,
        "failed",
      );
    }
    const manifest = z
      .object({
        version: z.literal(workflow.frontMindVersion),
        entrypoint: z.literal("SKILL.md"),
        upstream: z.object({
          version: z.literal(workflow.upstreamVersion),
          archiveSha256: z.literal(workflow.upstreamSha256),
        }),
        host: z
          .object({
            starterSha256: z.literal(workflow.starterSha256),
            componentLibraryVersion: z.literal(
              workflow.componentLibraryVersion,
            ),
            materializerVersion: z.literal(workflow.materializerVersion),
            materializerSha256: z.literal(workflow.materializerSha256),
          })
          .strict(),
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(512),
              bytes: z
                .number()
                .int()
                .positive()
                .max(5 * 1024 * 1024),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            }),
          )
          .min(1)
          .max(100),
      })
      .passthrough()
      .parse(JSON.parse(manifestBytes.toString("utf8")));
    const zip = new JSZip();
    zip.file("MANIFEST.json", manifestBytes, { date: FIXED_ZIP_DATE });
    let total = manifestBytes.length;
    for (const entry of manifest.files) {
      if (
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path
          .split("/")
          .some((segment) => segment === ".." || segment === ".") ||
        entry.path.normalize("NFKC") !== entry.path
      ) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PATH_INVALID",
          `FrontMind ${workflow.frontMindVersion} 建站工作流包含不安全路径。`,
          "failed",
        );
      }
      const absolute = path.resolve(root, entry.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PATH_INVALID",
          `FrontMind ${workflow.frontMindVersion} 建站工作流路径越界。`,
          "failed",
        );
      }
      const fileStat = await lstat(absolute);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_INVALID",
          `FrontMind ${workflow.frontMindVersion} 建站工作流包含非普通文件。`,
          "failed",
        );
      }
      const bytes = await readFile(absolute);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_FILE_MISMATCH",
          `FrontMind ${workflow.frontMindVersion} 建站工作流文件校验失败：${entry.path}`,
          "failed",
        );
      }
      total += bytes.length;
      if (total > 18 * 1024 * 1024) {
        throw new SiteOpsManusFailure(
          "SITEOPS_WORKFLOW_PACKAGE_TOO_LARGE",
          `FrontMind ${workflow.frontMindVersion} 建站工作流超过附件上限。`,
          "failed",
        );
      }
      zip.file(entry.path, bytes, { date: FIXED_ZIP_DATE });
    }
    const skill = manifest.files.find((entry) => entry.path === "SKILL.md");
    const contract = manifest.files.find(
      (entry) => entry.path === "runtime-contract.json",
    );
    if (!skill || !contract) {
      throw new SiteOpsManusFailure(
        "SITEOPS_WORKFLOW_CONTRACT_MISSING",
        `FrontMind ${workflow.frontMindVersion} 建站工作流缺少 SKILL 或 runtime contract。`,
        "failed",
      );
    }
    return zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
    });
  })().catch((error) => {
    workflowPackagePromises.delete(workflow.frontMindVersion);
    throw error;
  });
  workflowPackagePromises.set(workflow.frontMindVersion, loading);
  return loading;
}

function workflowAttachment(
  bytes: Buffer,
  workflow: ReturnType<typeof siteOpsWorkflowForVersion>,
) {
  const product = workflow.frontMindVersion.startsWith("2.")
    ? "react-static-company-site-workflow"
    : "astro-company-site-workflow";
  return {
    filename: `frontmind-${product}-${workflow.frontMindVersion}.zip`,
    mime_type: "application/zip",
    file_data: `data:application/zip;base64,${bytes.toString("base64")}`,
  } as const;
}

async function storedArtifactBytes(
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>,
  maxBytes = 8 * 1024 * 1024,
) {
  if (artifact.stored.sizeBytes < 1 || artifact.stored.sizeBytes > maxBytes) {
    throw new SiteOpsManusFailure(
      "VISUAL_PREVIEW_ATTACHMENT_INVALID",
      "冻结的视觉预览超过建站任务附件上限。",
      "failed",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of artifact.stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > artifact.stored.sizeBytes || total > maxBytes) {
      throw new SiteOpsManusFailure(
        "VISUAL_PREVIEW_ATTACHMENT_INVALID",
        "冻结的视觉预览读取结果不一致。",
        "failed",
      );
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== artifact.stored.sizeBytes ||
    sha256(bytes) !== artifact.row.contentSha256
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_PREVIEW_ATTACHMENT_INVALID",
      "冻结的视觉预览哈希校验失败。",
      "failed",
    );
  }
  return bytes;
}

export async function visualPreviewAttachment(
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>,
  filename: string,
) {
  const mimeType = z
    .enum(["image/png", "image/jpeg", "image/webp"])
    .parse(artifact.row.mimeType);
  const bytes = await storedArtifactBytes(artifact);
  return {
    filename,
    mime_type: mimeType,
    file_data: `data:${mimeType};base64,${bytes.toString("base64")}`,
  } as const;
}

async function readFrozenSelectionBundle(input: {
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>;
  expectedCandidateId: string;
}) {
  try {
    if (input.artifact.stored.sizeBytes > 1_000_000) {
      throw new Error("selection bundle exceeds limit");
    }
    const bytes = await storedArtifactBytes(input.artifact);
    const bundle = visualSelectionBundleSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    const candidate = bundle.candidates.find(
      (item) => item.id === input.expectedCandidateId,
    );
    if (!candidate) throw new Error("selected candidate is absent");
    return { bundle, candidate };
  } catch (error) {
    if (error instanceof SiteOpsManusFailure) throw error;
    throw new SiteOpsManusFailure(
      "VISUAL_SELECTION_BUNDLE_INVALID",
      "冻结的视觉选择合同无法通过校验。",
      "failed",
    );
  }
}

function isVisualSelectionBundleV2(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV2 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 2;
}

function isVisualSelectionBundleV3(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV3 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 3;
}

function isVisualSelectionBundleV4(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV4 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 4;
}

function isVisualSelectionBundleV5(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV5 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 5;
}

function isVisualSelectionBundleV6(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV6 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 6;
}

function isVisualSelectionBundleV7(
  bundle: VisualSelectionBundle,
): bundle is VisualSelectionBundleV7 {
  return "schemaVersion" in bundle && bundle.schemaVersion === 7;
}

function visualSelectionQueryHash(bundle: VisualSelectionBundle) {
  if (isVisualSelectionBundleV7(bundle)) {
    return canonicalSiteOpsSha256({
      schemaVersion: 7,
      workflowVersion: bundle.workflowVersion,
      catalogVersion: bundle.catalogVersion,
      pageNumber: bundle.pageNumber,
      candidates: bundle.candidates.map((candidate) => ({
        id: candidate.id,
        catalogCandidateId: candidate.catalogCandidateId,
        sourceArchiveSha256: candidate.sourceArchiveSha256,
        previewSha256: candidate.previewSha256,
      })),
    });
  }
  return isVisualSelectionBundleV2(bundle) ||
    isVisualSelectionBundleV3(bundle) ||
    isVisualSelectionBundleV4(bundle) ||
    isVisualSelectionBundleV5(bundle) ||
    isVisualSelectionBundleV6(bundle)
    ? bundle.queryPlanHash
    : (bundle as VisualSelectionBundleV1).queryHash;
}

export function selectedVisualPreviewCoordinates(input: {
  bundle: VisualSelectionBundle;
  candidateId: string;
  samplePreviewLocalAssetId: string;
  evidencePreviewSha256: string;
}) {
  if (isVisualSelectionBundleV7(input.bundle)) {
    const candidate = input.bundle.candidates.find(
      (item) => item.id === input.candidateId,
    );
    if (!candidate || candidate.previewSha256 !== input.evidencePreviewSha256) {
      throw new SiteOpsManusFailure(
        "VISUAL_SELECTION_COORDINATES_MISMATCH",
        "冻结的视觉候选与选择合同坐标不一致。",
        "failed",
      );
    }
    return {
      referenceLocalAssetId: input.samplePreviewLocalAssetId,
      referenceSha256: candidate.previewSha256,
      realizationLocalAssetId: input.samplePreviewLocalAssetId,
      realizationSha256: candidate.previewSha256,
      hasIndependentRealization: false,
    } as const;
  }
  const candidate = input.bundle.candidates.find(
    (item) => item.id === input.candidateId,
  );
  if (
    !candidate ||
    candidate.previewLocalAssetId !== input.samplePreviewLocalAssetId ||
    candidate.previewSha256 !== input.evidencePreviewSha256
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_SELECTION_COORDINATES_MISMATCH",
      "冻结的视觉候选与选择合同坐标不一致。",
      "failed",
    );
  }
  if (isVisualSelectionBundleV4(input.bundle)) {
    const v4Candidate = input.bundle.candidates.find(
      (item) => item.id === input.candidateId,
    );
    if (
      !v4Candidate ||
      v4Candidate.referenceBlueprint.referencePreviewLocalAssetId !==
        candidate.previewLocalAssetId ||
      v4Candidate.referenceBlueprint.referencePreviewSha256 !==
        candidate.previewSha256 ||
      v4Candidate.referenceBlueprint.previewLocalAssetId !==
        v4Candidate.realizationPreviewLocalAssetId ||
      v4Candidate.referenceBlueprint.previewSha256 !==
        v4Candidate.realizationPreviewSha256
    ) {
      throw new SiteOpsManusFailure(
        "VISUAL_SELECTION_COORDINATES_MISMATCH",
        "冻结的视觉参考与可实现预览坐标不一致。",
        "failed",
      );
    }
    return {
      referenceLocalAssetId: candidate.previewLocalAssetId,
      referenceSha256: candidate.previewSha256,
      realizationLocalAssetId: v4Candidate.realizationPreviewLocalAssetId,
      realizationSha256: v4Candidate.realizationPreviewSha256,
      hasIndependentRealization: true,
    } as const;
  }
  return {
    referenceLocalAssetId: candidate.previewLocalAssetId,
    referenceSha256: candidate.previewSha256,
    realizationLocalAssetId: candidate.previewLocalAssetId,
    realizationSha256: candidate.previewSha256,
    hasIndependentRealization: false,
  } as const;
}

function assertProjectVisualArtifact(
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>,
  input: { userId: number; projectId: string },
) {
  if (
    artifact.row.scope !== "managed_user" ||
    artifact.row.accountUserId !== input.userId ||
    !artifact.row.storageKey.startsWith(`siteops:${input.projectId}:`)
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_PREVIEW_TENANT_MISMATCH",
      "冻结的视觉预览不属于当前建站项目。",
      "failed",
    );
  }
}

function verifiedVisualEvidence(candidate: {
  providerItemKey: string;
  previewSha256: string;
  visualEvidence: z.infer<typeof visualEvidenceV1Schema>;
}) {
  const evidence = visualEvidenceV1Schema.parse(candidate.visualEvidence);
  const recomposed = createVisualEvidenceV1({
    evidenceKind: evidence.evidenceKind,
    providerItemKey: evidence.providerItemKey,
    metadataSha256: evidence.metadataSha256,
    providerResponseSha256: evidence.providerResponseSha256,
    previewSha256: evidence.previewSha256,
    taxonomyDerivationVersion: evidence.taxonomyDerivationVersion,
  });
  if (
    recomposed.evidenceSha256 !== evidence.evidenceSha256 ||
    candidate.providerItemKey !== evidence.providerItemKey ||
    candidate.previewSha256 !== evidence.previewSha256
  ) {
    throw new SiteOpsManusFailure(
      "VISUAL_EVIDENCE_COORDINATES_MISMATCH",
      "冻结的视觉证据坐标不一致。",
      "failed",
    );
  }
  return evidence;
}

const SOCIAL_WORKFLOWS = {
  wechat: {
    directory: "siteops-wechat-package-v1.0.0",
    version: "1.0.0",
    manifestSha256:
      "5eb002ee34132105f8d13e3c4416fe4d08e07fadb1daa8ac660c066404689a6f",
  },
  xiaohongshu: {
    directory: "siteops-xiaohongshu-package-v1.0.0",
    version: "1.0.0",
    manifestSha256:
      "a359f8bfd6b46ab030fe7a36f8e7caf25fd873c286b533073c2db25661e93b0c",
  },
} as const;

const socialWorkflowPackages = new Map<
  keyof typeof SOCIAL_WORKFLOWS,
  Promise<Buffer>
>();

export async function loadVerifiedSiteOpsSocialWorkflowPackage(
  channel: keyof typeof SOCIAL_WORKFLOWS,
) {
  const existing = socialWorkflowPackages.get(channel);
  if (existing) return existing;
  const definition = SOCIAL_WORKFLOWS[channel];
  const loading = (async () => {
    const candidates = [
      path.resolve(
        process.cwd(),
        "dist/private-workflows",
        definition.directory,
      ),
      path.resolve(process.cwd(), "private-workflows", definition.directory),
    ];
    let root: string | null = null;
    let manifestBytes: Buffer | null = null;
    for (const candidate of candidates) {
      try {
        manifestBytes = await readFile(path.join(candidate, "MANIFEST.json"));
        root = candidate;
        break;
      } catch {
        // Try source after the immutable runtime location.
      }
    }
    if (!root || !manifestBytes) {
      throw new SiteOpsManusFailure(
        "SITEOPS_SOCIAL_WORKFLOW_NOT_FOUND",
        `${channel} 内容包工作流未进入运行镜像。`,
      );
    }
    if (sha256(manifestBytes) !== definition.manifestSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_SOCIAL_WORKFLOW_MANIFEST_MISMATCH",
        `${channel} 内容包工作流 manifest 哈希不一致。`,
        "failed",
      );
    }
    const manifest = z
      .object({
        channel: z.literal(channel),
        version: z.literal(definition.version),
        entrypoint: z.literal("SKILL.md"),
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(191),
              bytes: z.number().int().positive().max(1_000_000),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            }),
          )
          .min(2)
          .max(10),
      })
      .passthrough()
      .parse(JSON.parse(manifestBytes.toString("utf8")));
    const zip = new JSZip();
    zip.file("MANIFEST.json", manifestBytes, { date: FIXED_ZIP_DATE });
    for (const entry of manifest.files) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.path) ||
        entry.path.normalize("NFKC") !== entry.path
      ) {
        throw new SiteOpsManusFailure(
          "SITEOPS_SOCIAL_WORKFLOW_PATH_INVALID",
          `${channel} 内容包工作流包含不安全路径。`,
          "failed",
        );
      }
      const absolute = path.resolve(root, entry.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) {
        throw new SiteOpsManusFailure(
          "SITEOPS_SOCIAL_WORKFLOW_PATH_INVALID",
          `${channel} 内容包工作流路径越界。`,
          "failed",
        );
      }
      const fileStat = await lstat(absolute);
      const bytes = await readFile(absolute);
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        bytes.length !== entry.bytes ||
        sha256(bytes) !== entry.sha256
      ) {
        throw new SiteOpsManusFailure(
          "SITEOPS_SOCIAL_WORKFLOW_FILE_MISMATCH",
          `${channel} 内容包工作流文件校验失败。`,
          "failed",
        );
      }
      zip.file(entry.path, bytes, { date: FIXED_ZIP_DATE });
    }
    if (
      !manifest.files.some((entry) => entry.path === "SKILL.md") ||
      !manifest.files.some((entry) => entry.path === "runtime-contract.json")
    ) {
      throw new SiteOpsManusFailure(
        "SITEOPS_SOCIAL_WORKFLOW_CONTRACT_MISSING",
        `${channel} 内容包工作流缺少 SKILL 或 runtime contract。`,
        "failed",
      );
    }
    return zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
    });
  })().catch((error) => {
    socialWorkflowPackages.delete(channel);
    throw error;
  });
  socialWorkflowPackages.set(channel, loading);
  return loading;
}

export async function getSiteOpsSocialWorkflowReadiness() {
  const [websitePackage, entries] = await Promise.all([
    loadVerifiedSiteOpsWorkflowPackage(),
    Promise.all(
      (
        Object.keys(SOCIAL_WORKFLOWS) as Array<keyof typeof SOCIAL_WORKFLOWS>
      ).map(async (channel) => ({
        channel,
        version: SOCIAL_WORKFLOWS[channel].version,
        manifestSha256: SOCIAL_WORKFLOWS[channel].manifestSha256,
        packageBytes: (await loadVerifiedSiteOpsSocialWorkflowPackage(channel))
          .length,
      })),
    ),
  ]);
  return {
    ready: true as const,
    website: {
      version: SITEOPS_WORKFLOW.frontMindVersion,
      manifestSha256: SITEOPS_WORKFLOW.runtimeManifestSha256,
      packageBytes: websitePackage.length,
    },
    workflows: entries,
  };
}

function socialWorkflowAttachment(
  channel: keyof typeof SOCIAL_WORKFLOWS,
  bytes: Buffer,
) {
  return {
    filename: `${SOCIAL_WORKFLOWS[channel].directory}.zip`,
    mime_type: "application/zip",
    file_data: `data:application/zip;base64,${bytes.toString("base64")}`,
  } as const;
}

function operationMarker(token: string) {
  return `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: token })}`;
}

function promptWithMarker(prompt: string, token: string) {
  return assertUpstreamPromptBudget(
    `${prompt}\n\n# FrontMind operation contract\n${operationMarker(token)}`,
  );
}

function operationTitle(operation: SiteOperation) {
  return `FrontMind SiteOps ${operation.id}`;
}

function baseUrl() {
  return process.env.MANUS_API_BASE_URL?.trim() || "https://api.manus.ai";
}

function acceptedSocialStructuredValue(
  events: readonly ManusV2MessageEvent[],
  token: string,
) {
  for (const event of [...events].reverse()) {
    if (event.type !== "structured_output_result") continue;
    const classified = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (classified.kind !== "accepted") continue;
    let value = classified.value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).operationToken === token
    ) {
      return value;
    }
  }
  return null;
}

export function combinedTerminalTaskState(
  eventStatus: string | null | undefined,
  detailStatus: string | null | undefined,
) {
  const eventState = terminalTaskState(eventStatus);
  const detailState = terminalTaskState(detailStatus);
  const normalizedDetail = String(detailStatus ?? "")
    .trim()
    .toLowerCase();
  const detailIsKnownNonterminal = [
    "created",
    "queued",
    "starting",
    "running",
    "pending",
    "waiting",
  ].includes(normalizedDetail);
  // task.detail is the current task authority. An older phase may have left a
  // stopped status event in the shared one-task history; it must not complete
  // the next phase while detail already says that phase is running.
  if (detailIsKnownNonterminal) {
    return { failed: false, completed: false };
  }
  const detailIsTerminal = detailState.failed || detailState.completed;
  const failed = detailIsTerminal ? detailState.failed : eventState.failed;
  return {
    failed,
    completed:
      !failed &&
      (detailIsTerminal ? detailState.completed : eventState.completed),
  };
}

export function phaseTerminalTaskState(
  eventStatus: string | null | undefined,
  detailStatus: string | null | undefined,
) {
  const eventState = terminalTaskState(eventStatus);
  const detailState = terminalTaskState(detailStatus);
  const failed = eventState.failed || detailState.failed;
  return {
    failed,
    // Both authorities must describe completion for the current token window.
    // This prevents the previous stopped phase in a one-task conversation from
    // completing a newly sent phase before it actually stops.
    completed: !failed && eventState.completed && detailState.completed,
  };
}

// Manus can emit the final structured_output/attachment a few seconds after
// task.detail first reports `stopped`. Keep the task bound and reconcile the
// same GET-only coordinates for five minutes before treating output as absent.
export const MANUS_PROVIDER_STOPPED_GRACE_MS = 5 * 60_000;
export const SITE_CONTENT_PATCH_PROGRESS_DEADLINE_MS = 15 * 60_000;

export function siteContentPatchProgressDeadline(input: {
  state: ProviderState | null;
  operationToken: string;
  now?: number;
  operationStartedAt?: Date | string | null;
}) {
  const now = input.now ?? Date.now();
  const current = providerStateV2(input.state);
  const frozenPhaseStartedAt =
    current.phaseOperationToken === input.operationToken
      ? Date.parse(current.phaseStartedAt ?? "")
      : Number.NaN;
  const operationStartedAt =
    input.operationStartedAt instanceof Date
      ? input.operationStartedAt.getTime()
      : Date.parse(String(input.operationStartedAt ?? ""));
  const phaseStartedAt = Number.isFinite(frozenPhaseStartedAt)
    ? Number.isFinite(operationStartedAt)
      ? Math.min(frozenPhaseStartedAt, operationStartedAt)
      : frozenPhaseStartedAt
    : Number.isFinite(operationStartedAt)
      ? operationStartedAt
      : now;
  const lastProgressAt =
    current.phaseOperationToken === input.operationToken
      ? Date.parse(current.lastContractProgressAt ?? "")
      : Number.NaN;
  const progressAnchor = Number.isFinite(lastProgressAt)
    ? Math.max(phaseStartedAt, lastProgressAt)
    : phaseStartedAt;
  const state = providerStateV2Schema.parse({
    ...current,
    phaseOperationToken: input.operationToken,
    phaseStartedAt: new Date(phaseStartedAt).toISOString(),
    ...(current.phaseOperationToken === input.operationToken
      ? {}
      : {
          lastContractProgressAt: undefined,
          providerStoppedAt: undefined,
          providerStoppedOperationToken: undefined,
          resultPendingSince: undefined,
          resultPendingOperationToken: undefined,
        }),
  });
  return {
    expired: now - progressAnchor >= SITE_CONTENT_PATCH_PROGRESS_DEADLINE_MS,
    state,
  };
}

export function structuredResultGrace(
  state: ProviderState,
  completed: boolean,
  now = Date.now(),
  operationToken?: string,
) {
  let scopedState = providerStateV2(state);
  if (operationToken && scopedState.phaseOperationToken !== operationToken) {
    scopedState = providerStateV2Schema.parse({
      ...scopedState,
      phaseOperationToken: operationToken,
      phaseStartedAt: new Date(now).toISOString(),
      lastContractProgressAt: undefined,
      providerStoppedAt: undefined,
      providerStoppedOperationToken: undefined,
      resultPendingSince: undefined,
      resultPendingOperationToken: undefined,
    });
  }
  const stoppedAt =
    scopedState.providerStoppedAt &&
    (!operationToken ||
      scopedState.providerStoppedOperationToken === operationToken)
      ? scopedState.providerStoppedAt
      : undefined;
  const pendingSince =
    scopedState.resultPendingSince &&
    (!operationToken ||
      scopedState.resultPendingOperationToken === operationToken)
      ? scopedState.resultPendingSince
      : undefined;
  if (!completed && !stoppedAt) return { expired: false, state: scopedState };
  const parsed = Date.parse(pendingSince ?? stoppedAt ?? "");
  const since = Number.isFinite(parsed) ? parsed : now;
  return {
    expired: now - since >= MANUS_PROVIDER_STOPPED_GRACE_MS,
    state: {
      ...scopedState,
      ...(operationToken
        ? {
            providerStoppedAt: stoppedAt ?? new Date(since).toISOString(),
            providerStoppedOperationToken: operationToken,
            resultPendingOperationToken: operationToken,
          }
        : {}),
      resultPendingSince: new Date(since).toISOString(),
    } satisfies ProviderState,
  };
}

type ProviderSyncFallback = Date | string | number | null | undefined;

function parsedProviderSyncTimestamp(value: ProviderSyncFallback) {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function startProviderResultSyncWindow(
  state: ProviderState,
  now = Date.now(),
  fallbackSince?: ProviderSyncFallback,
) {
  const current = providerStateV2(state);
  const persisted = parsedProviderSyncTimestamp(current.providerSyncStartedAt);
  const fallback = parsedProviderSyncTimestamp(fallbackSince);
  const since = Number.isFinite(persisted)
    ? persisted
    : Number.isFinite(fallback)
      ? fallback
      : now;
  return providerStateV2Schema.parse({
    ...current,
    providerSyncStartedAt: new Date(since).toISOString(),
  });
}

const NATIVE_REPAIR_CLEARED_STATE_KEYS = [
  "nativeSourceFileId",
  "nativeSourceAttachmentEventId",
  "nativeSourceAttachmentIdentity",
  "nativeSourceAttachmentScope",
  "nativeSourceStaging",
  "buildCheckpoint",
  "nativeSourceReadFailureCount",
  "nativeSourceReadFailureSince",
  "nativeSourceNextPollAt",
  "providerReadFailureCount",
  "providerReadFailureSince",
  "providerNextPollAt",
  "providerTaskNotFoundCount",
  "providerLastReadFailure",
  "providerSyncStartedAt",
  "lastContractProgressAt",
  "resultPendingSince",
  "resultPendingOperationToken",
  "providerStoppedAt",
  "providerStoppedOperationToken",
] as const;

function clearedNativeRepairIntakeState(state: ProviderStateV2) {
  const cleared = { ...state };
  for (const key of NATIVE_REPAIR_CLEARED_STATE_KEYS) delete cleared[key];
  return providerStateV2Schema.parse(cleared);
}

function nativeRepairAttemptState(input: {
  state: ProviderState | null;
  taskId: string;
  repairAttempt: number;
  operationToken: string;
  errorSignature: string;
  stage: "native_repair_send_ready" | "native_repair_send_unknown";
  repair?: NativeSourceRepairInput;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const scoped = transitionProviderState(input.state, {
    stage: input.stage,
    taskId: input.taskId,
    nativeRepairAttempt: input.repairAttempt,
    nativeLastErrorSignature: input.errorSignature,
    nativeRepairInput: input.repair,
    // A rejected verdict belongs to the prior immutable candidate and is
    // intentionally retained by transitionProviderState. All mutable intake
    // coordinates are phase-scoped and must start empty for this attempt.
    nativeSourceFileId: undefined,
    nativeSourceAttachmentEventId: undefined,
    nativeSourceAttachmentIdentity: undefined,
    nativeSourceAttachmentScope: undefined,
    nativeSourceStaging: undefined,
    buildCheckpoint: undefined,
    nativeSourceReadFailureCount: undefined,
    nativeSourceReadFailureSince: undefined,
    nativeSourceNextPollAt: undefined,
    providerReadFailureCount: undefined,
    providerReadFailureSince: undefined,
    providerNextPollAt: undefined,
    providerTaskNotFoundCount: undefined,
    providerLastReadFailure: undefined,
    providerSyncStartedAt: undefined,
    phaseOperationToken: input.operationToken,
    phaseStartedAt: new Date(now).toISOString(),
    lastContractProgressAt: undefined,
    resultPendingSince: undefined,
    resultPendingOperationToken: undefined,
    providerStoppedAt: undefined,
    providerStoppedOperationToken: undefined,
    buildPhase: "source_repairing",
  });
  const cleared = clearedNativeRepairIntakeState(scoped);
  return input.stage === "native_repair_send_unknown"
    ? startProviderResultSyncWindow(cleared, now)
    : cleared;
}

export function startNativeRepairAttemptState(input: {
  state: ProviderState | null;
  taskId: string;
  repairAttempt: number;
  operationToken: string;
  errorSignature: string;
  now?: number;
}) {
  return nativeRepairAttemptState({
    ...input,
    stage: "native_repair_send_unknown",
  });
}

export function providerResultSyncWindow(
  state: ProviderState,
  now = Date.now(),
  fallbackSince?: ProviderSyncFallback,
) {
  const started = startProviderResultSyncWindow(state, now, fallbackSince);
  const since = Date.parse(started.providerSyncStartedAt!);
  return {
    expired: now - since >= MANUS_PROVIDER_READ_RECONCILIATION_MS,
    state: started,
  };
}

export function safePublicDocuments(
  snapshot: typeof knowledgeBaseSnapshots.$inferSelect,
) {
  return snapshot.documents
    .filter(
      (document) =>
        document.customerVisible !== false &&
        document.kind !== "evidence" &&
        // dashboard-core-v1 uses needs_verification for customer-confirmed
        // facts whose external evidence is incomplete. They remain usable as
        // customer-approved source material, with their ids preserved. Only
        // inferred content is excluded from the generation prompt.
        document.evidenceStatus !== "inferred",
    )
    .map((document) => ({
      id: String(document.id || document.path).slice(0, 191),
      path: document.path.slice(0, 512),
      title: document.title.slice(0, 255),
      content: document.content,
      kind: document.kind,
      customerVisible: true as const,
    }));
}

export function frozenAssetDecisions(
  snapshot: typeof knowledgeBaseSnapshots.$inferSelect,
  brief: z.infer<typeof siteBriefSchema>,
) {
  const validAssets = snapshot.assets.flatMap((asset) => {
    if (!asset.id || !asset.sha256 || !/^[a-f0-9]{64}$/iu.test(asset.sha256)) {
      return [];
    }
    const isOfficialLogo =
      asset.sourceKind === "official_logo_upload" ||
      (asset.ownership === "first_party" &&
        /logo/iu.test(`${asset.key} ${asset.path}`));
    return [
      {
        id: asset.id,
        sha256: asset.sha256.toLowerCase(),
        isOfficialLogo,
      },
    ];
  });
  const selectedLogo = brief.publicAssetIds
    .map((id) =>
      validAssets.find((asset) => asset.id === id && asset.isOfficialLogo),
    )
    .find((asset) => asset?.isOfficialLogo);

  return validAssets.map((asset) => ({
    id: asset.id,
    sha256: asset.sha256,
    decision:
      asset === selectedLogo
        ? ("publish" as const)
        : selectedLogo && asset.sha256 === selectedLogo.sha256
          ? ("omit" as const)
          : ("quarantine" as const),
  }));
}

export function briefWithoutBrandAssets(
  brief: z.infer<typeof siteBriefSchema>,
) {
  return { ...brief, publicAssetIds: [] };
}

/** Routes whose public copy is determined by absence in the frozen snapshot
 * are excluded from every provider contract and materialized by Dashboard. */
export function hostOwnedEmptyRouteIds(
  brief: Pick<z.infer<typeof siteBriefSchema>, "routes" | "contentInventory">,
) {
  const routes = new Set(brief.routes.map((route) => route.id));
  const inventory = new Set(
    brief.contentInventory.entries.map((entry) => entry.kind),
  );
  return routes.has("news") && !inventory.has("company_news")
    ? (["news"] as const)
    : ([] as const);
}

function accessibleRuntimePalette(values: readonly string[]) {
  return Array.from(
    new Set(
      [
        ...values.filter((value) => /^#[a-f0-9]{6}$/iu.test(value)),
        "#F5F2EA",
        "#10212B",
        "#A33A1B",
      ].map((value) => value.toUpperCase()),
    ),
  ).slice(0, 12);
}

function designOutputSchema(
  token: string,
  routeIds: string[],
  paletteSize: number,
  renderer: "legacy_astro" | "react_static",
): ManusV2StructuredOutputSchema {
  const input = {
    operationToken: token,
    routeIds,
    paletteSize,
  };
  return renderer === "react_static"
    ? siteDesignWireV3OutputSchema(input)
    : siteDesignWireOutputSchema(input);
}

function generatedContentOutputSchema(
  token: string,
  routeCompositions: Array<{
    routeId: string;
    slots: Array<{ slotId: string }>;
  }>,
  sourceDocumentIds: string[],
  workflowVersion: string,
  hostOwnedEmptyRouteIds: readonly string[] = [],
) {
  const emptyRoutes = new Set(hostOwnedEmptyRouteIds);
  const input = {
    operationToken: token,
    routeIds: routeCompositions
      .map((route) => route.routeId)
      .filter((routeId) => !emptyRoutes.has(routeId)),
    sourceDocumentIds,
  };
  return usesBuildPlanContractV4(workflowVersion)
    ? pageContentWireV3OutputSchema(input)
    : pageContentWireOutputSchema(input);
}

type SiteContentPatchSlotManifest = {
  routeId: string;
  slotId: string;
  kind: "richText" | "list";
  sourceIds: readonly string[];
};

function siteContentPatchOutputSchema(input: {
  operationToken: string;
  baseSourceSha256: string;
  slots: readonly SiteContentPatchSlotManifest[];
  sourceDocumentIds: readonly string[];
}) {
  const nullableString = {
    anyOf: [{ type: "string" }, { type: "null" }],
  } as const;
  const routeIds = [...new Set(input.slots.map((slot) => slot.routeId))];
  const slotIds = [...new Set(input.slots.map((slot) => slot.slotId))];
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      wireSchemaVersion: { type: "integer", enum: [1] },
      operationToken: { type: "string", enum: [input.operationToken] },
      baseSourceSha256: {
        type: "string",
        enum: [input.baseSourceSha256],
      },
      // Manus structured output is limited to five schema levels. Keep the
      // transport flat and project it into SiteContentPatchV1 pages locally.
      slots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: {
              type: "string",
              ...(routeIds.length > 0 ? { enum: routeIds } : {}),
            },
            slotId: {
              type: "string",
              ...(slotIds.length > 0 ? { enum: slotIds } : {}),
            },
            kind: { type: "string", enum: ["richText", "list"] },
            valueText: nullableString,
            valueList: { type: "array", items: { type: "string" } },
            sourceIds: {
              type: "array",
              items: {
                type: "string",
                ...(input.sourceDocumentIds.length > 0
                  ? { enum: [...input.sourceDocumentIds] }
                  : {}),
              },
            },
          },
          required: [
            "routeId",
            "slotId",
            "kind",
            "valueText",
            "valueList",
            "sourceIds",
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      "wireSchemaVersion",
      "operationToken",
      "baseSourceSha256",
      "slots",
    ],
    additionalProperties: false,
  });
}

function siteContentPatchFromWire(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.pages)) return value;
  if (record.wireSchemaVersion !== 1 || !Array.isArray(record.slots)) {
    return value;
  }
  const pages = new Map<string, unknown[]>();
  for (const rawSlot of record.slots.slice(0, 480)) {
    if (!rawSlot || typeof rawSlot !== "object" || Array.isArray(rawSlot)) {
      continue;
    }
    const slot = rawSlot as Record<string, unknown>;
    if (typeof slot.routeId !== "string") continue;
    const routeId = slot.routeId.trim();
    if (!routeId || routeId.length > 64) continue;
    const projected = {
      slotId: slot.slotId,
      kind: slot.kind,
      value: slot.kind === "list" ? slot.valueList : slot.valueText,
      sourceIds: slot.sourceIds,
    };
    const current = pages.get(routeId) ?? [];
    current.push(projected);
    pages.set(routeId, current);
  }
  return {
    schemaVersion: 1,
    operationToken: record.operationToken,
    baseSourceSha256: record.baseSourceSha256,
    pages: [...pages].map(([routeId, slots]) => ({ routeId, slots })),
  };
}

function siteContentPatchSlotManifestAttachment(input: {
  operationToken: string;
  baseSourceSha256: string;
  slots: readonly SiteContentPatchSlotManifest[];
}) {
  const bytes = Buffer.from(
    `${canonicalJson({
      schemaVersion: 1,
      operationToken: input.operationToken,
      baseSourceSha256: input.baseSourceSha256,
      slots: input.slots,
    })}\n`,
    "utf8",
  );
  return {
    filename: "frontmind-site-content-slot-manifest-v1.json",
    mime_type: "application/json",
    file_data: `data:application/json;base64,${bytes.toString("base64")}`,
  } as const;
}

function socialOutputSchema(
  token: string,
  channel: "wechat" | "xiaohongshu",
  sourceDocumentIds: string[],
) {
  return socialWireOutputSchema({
    operationToken: token,
    channel,
    sourceDocumentIds,
  });
}

async function findUniqueCreatedTask(
  client: ManusV2Client,
  operation: SiteOperation,
  token: string,
) {
  const result = await client.findCreatedTask({
    title: operationTitle(operation),
    operationToken: token,
    createdAfterSeconds:
      Math.floor(operation.createdAt.getTime() / 1_000) - 300,
  });
  if (result.matches.length > 1) {
    throw new SiteOpsManusFailure(
      "MANUS_CREATE_RECONCILIATION_AMBIGUOUS",
      "找到多个同一建站操作的 Manus 任务，已停止自动推进以避免使用错误结果。",
    );
  }
  return result.unique;
}

async function loadBuildContext(db: any, operation: SiteOperation) {
  if (!operation.buildId)
    throw new SiteOpsManusFailure(
      "BUILD_ID_MISSING",
      "建站操作缺少版本标识。",
      "failed",
    );
  const rows = await db
    .select({
      build: siteBuilds,
      project: siteProjects,
      snapshot: knowledgeBaseSnapshots,
      batch: websiteStyleSampleBatches,
      sample: websiteStyleSamples,
    })
    .from(siteBuilds)
    .innerJoin(siteProjects, eq(siteProjects.id, siteBuilds.projectId))
    .innerJoin(
      knowledgeBaseSnapshots,
      eq(knowledgeBaseSnapshots.id, siteBuilds.knowledgeSnapshotId),
    )
    .innerJoin(
      websiteStyleSamples,
      eq(websiteStyleSamples.id, siteBuilds.styleSampleId),
    )
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        eq(siteBuilds.id, operation.buildId),
        eq(siteBuilds.userId, operation.userId),
      ),
    )
    .limit(1);
  const context = rows[0];
  if (!context)
    throw new SiteOpsManusFailure(
      "BUILD_CONTEXT_NOT_FOUND",
      "官网版本或视觉方向不存在。",
      "failed",
    );
  if (context.snapshot.archiveHash !== context.build.knowledgeArchiveHash) {
    throw new SiteOpsManusFailure(
      "KNOWLEDGE_ARCHIVE_HASH_MISMATCH",
      "当前企业知识库与本次建站任务的冻结资料不一致，请重新开始官网任务。",
      "failed",
    );
  }
  return context;
}

async function assertFrozenCredential(
  input: z.infer<typeof operationInputSchema>,
  userId: number,
  getCredential: typeof getDecryptedCredentialForUser,
) {
  const credential = await getCredential(userId, input.manusCredentialId);
  if (
    !credential ||
    credential.userId !== userId ||
    credential.version !== input.manusCredentialVersion
  ) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_CUSTOMER_CREDENTIAL_VERSION_UNAVAILABLE",
      "当前账号绑定的 AI 建站 API Key 版本不可用。",
      "attention_required",
    );
  }
  return credential;
}

function stateFromOperation(operation: SiteOperation): ProviderState | null {
  const parsed = providerStateSchema.safeParse(operation.result);
  return parsed.success ? parsed.data : null;
}

function rawProviderStateRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function claimsNativeSourceCheckpoint(value: unknown) {
  const record = rawProviderStateRecord(value);
  // Trusted fallback compilation uses compile_started before it has a staged
  // fallback marker. Its retry counters identify that host-owned path; it is
  // not a claim that provider source bytes were already validated.
  const fallbackRetryState = Boolean(
    record &&
      (record.fallbackPreviewFailureCount !== undefined ||
        record.fallbackPreviewNextPollAt !== undefined ||
        record.fallbackPreviewLastErrorCode !== undefined),
  );
  return Boolean(
    record &&
      (record.nativeSourceStaging !== undefined ||
        (!fallbackRetryState &&
          ["archive_validated", "compile_started"].includes(
            String(record.buildCheckpoint ?? ""),
          ))),
  );
}

function nativeSourceCheckpointMatchesOperation(
  operation: SiteOperation,
  state: ProviderState,
) {
  if (!claimsNativeSourceCheckpoint(operation.result)) return true;
  if (state.schemaVersion !== 2) return false;
  const staging = state.nativeSourceStaging;
  if (
    !staging?.receipt ||
    !staging.taskId ||
    staging.repairAttempt === undefined ||
    !state.taskId ||
    state.nativeRepairAttempt === undefined ||
    !operation.providerTaskId
  ) {
    return false;
  }
  if (
    state.contentPlanSha256 !== undefined &&
    (!("contentPlanSha256" in staging.receipt) ||
      staging.receipt.contentPlanSha256 !== state.contentPlanSha256)
  ) {
    return false;
  }
  return (
    staging.taskId === state.taskId &&
    staging.taskId === operation.providerTaskId &&
    staging.repairAttempt === state.nativeRepairAttempt &&
    staging.receipt.operationToken ===
      `siteops-native-source:${operation.id}:${staging.repairAttempt}`
  );
}

export function existingTaskOnlyRecoveryState(input: {
  result: unknown;
  taskId: string;
}) {
  const parsed = providerStateSchema.safeParse(input.result);
  if (!parsed.success) {
    throw new Error("SITEOPS_RECONCILE_PROVIDER_STATE_INVALID");
  }
  const state = parsed.data;
  const boundFallback =
    state.schemaVersion === 2 && state.fallbackPreview?.status === "bound";
  if (
    (!boundFallback && state.stage !== "native_repair_pending") ||
    (boundFallback &&
      state.stage !== "native_repair_pending" &&
      state.stage !== "native_source_pending") ||
    (state.taskId && state.taskId !== input.taskId) ||
    (!boundFallback &&
      (!state.nativeRepairAttempt || state.nativeRepairAttempt < 1))
  ) {
    throw new Error("SITEOPS_RECONCILE_NATIVE_REPAIR_STATE_REQUIRED");
  }
  return transitionProviderState(state, {
    stage: state.stage,
    taskId: input.taskId,
    existingTaskOnly: true,
    buildPhase: boundFallback ? "provider_sync_delayed" : "source_repairing",
    providerReadFailureCount: undefined,
    providerReadFailureSince: undefined,
    providerNextPollAt: undefined,
    providerTaskNotFoundCount: undefined,
    providerLastReadFailure: undefined,
    providerSyncStartedAt: undefined,
  });
}

export function existingTaskOnlyBoundFallback(result: unknown) {
  const parsed = providerStateSchema.safeParse(result);
  const marker = siteOpsTrustedFallbackPreviewFromResult(result);
  return parsed.success &&
    parsed.data.schemaVersion === 2 &&
    marker?.status === "bound"
    ? marker
    : null;
}

async function persistOperationProgress(
  db: any,
  operation: SiteOperation,
  state: ProviderState,
  taskId?: string,
) {
  if (!operation.leaseOwner) {
    throw new SiteOpsManusFailure(
      "MANUS_OPERATION_LEASE_MISSING",
      "建站操作缺少有效租约，未调用外部服务。",
    );
  }
  const updated = await db
    .update(siteOperations)
    .set({
      result: state,
      ...(taskId ? { providerTaskId: taskId } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(siteOperations.id, operation.id),
        eq(siteOperations.status, "running"),
        eq(siteOperations.leaseOwner, operation.leaseOwner),
      ),
    );
  const affectedRows = Number(
    (Array.isArray(updated)
      ? (updated[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (updated as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
  );
  if (affectedRows !== 1) {
    throw new Error("SITEOPS_OPERATION_LEASE_LOST");
  }
}

async function bindCreatedBuildTask(input: {
  db: any;
  operation: SiteOperation;
  buildId: string;
  taskId: string;
  state: ProviderState;
  preservePreview?: boolean;
}) {
  if (!input.operation.leaseOwner) {
    throw new Error("SITEOPS_OPERATION_LEASE_LOST");
  }
  await input.db.transaction(async (tx: any) => {
    await persistOperationProgress(
      tx,
      input.operation,
      input.state,
      input.taskId,
    );
    const updated = await tx
      .update(siteBuilds)
      .set({
        upstreamManusTaskId: input.taskId,
        status: input.preservePreview ? "qa_running" : "design_compiling",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteBuilds.id, input.buildId),
          eq(siteBuilds.userId, input.operation.userId),
          inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
          or(
            isNull(siteBuilds.upstreamManusTaskId),
            eq(siteBuilds.upstreamManusTaskId, input.taskId),
          ),
        ),
      );
    const affectedRows = Number(
      (Array.isArray(updated)
        ? (updated[0] as { affectedRows?: unknown } | undefined)?.affectedRows
        : (updated as { affectedRows?: unknown } | undefined)?.affectedRows) ??
        0,
    );
    if (affectedRows !== 1) {
      throw new Error("SITEOPS_BUILD_TASK_BINDING_CONFLICT");
    }
  });
}

function currentPhaseEvents(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
) {
  const ordered = orderManusV2EventsByProviderRank(events, "oldest_first");
  let start = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) === operationToken) {
      start = index;
    }
  }
  if (start < 0) return [];
  let end = ordered.length;
  for (let index = start + 1; index < ordered.length; index += 1) {
    if (manusV2EventOperationToken(ordered[index]!) !== null) {
      end = index;
      break;
    }
  }
  return ordered.slice(start + 1, end);
}

export const MANUS_PROVIDER_READ_BACKOFF_MS = Object.freeze([
  10_000, 20_000, 40_000, 80_000, 160_000, 300_000,
] as const);
export const MANUS_PROVIDER_READ_RECONCILIATION_MS = 24 * 60 * 60 * 1_000;
type ManusTaskDetail = Awaited<ReturnType<ManusV2Client["taskDetail"]>>;

function safeManusReadFailure(error: ManusV2ApiError) {
  const operation = /^(?:task|file)\.[A-Za-z][A-Za-z0-9.]{0,62}$/u.test(
    error.operation,
  )
    ? error.operation
    : "task.read";
  const code = /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
    ? error.code
    : "INVALID_RESPONSE";
  return providerReadFailureSchema.parse({
    operation,
    status:
      error.status !== null && error.status >= 100 && error.status <= 599
        ? error.status
        : null,
    code,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    transportCause: error.transportCause,
    transportPhase: error.transportPhase,
  });
}

function safeProviderRequestId(value: string | null) {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u.test(value)
    ? value
    : null;
}

function logManusReadFailure(input: {
  error: ManusV2ApiError;
  operationId?: string;
  buildId?: string;
  taskBound: boolean;
  failureCount: number;
  nextPollMs: number;
}) {
  const coordinate = safeManusReadFailure(input.error);
  console.warn("[siteops-manus] provider_read_deferred", {
    event: "siteops_manus_provider_read_deferred",
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.buildId ? { buildId: input.buildId } : {}),
    operation: coordinate.operation,
    status: coordinate.status,
    providerCode: coordinate.code,
    retryable: coordinate.retryable,
    retryAfterMs: coordinate.retryAfterMs,
    transportCause: coordinate.transportCause,
    transportPhase: coordinate.transportPhase,
    providerRequestId: safeProviderRequestId(input.error.providerRequestId),
    taskBound: input.taskBound,
    failureCount: input.failureCount,
    nextPollMs: input.nextPollMs,
  });
}

function isTaskNotFoundReadFailure(error: ManusV2ApiError) {
  return (
    error.status === 404 ||
    /^(?:HTTP_404|NOT_FOUND|TASK_NOT_FOUND)$/u.test(error.code)
  );
}

function isTaskIdentityReadFailure(error: ManusV2ApiError) {
  return /^(?:TASK_ID_CONFLICT|TASK_IDENTITY_CONFLICT)$/u.test(error.code);
}

function isTransientManusReadFailure(error: ManusV2ApiError) {
  if (isTaskNotFoundReadFailure(error)) return true;
  if (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status !== null && error.status >= 500)
  ) {
    return true;
  }
  return (
    error.status === null ||
    error.retryable ||
    error.transportCause !== null ||
    /^(?:INVALID_PAGINATION|INVALID_RESPONSE|HTTP_5\d\d)$/u.test(error.code)
  );
}

export function manusProviderReadRetryDelayMs(input: {
  failureCount: number;
  retryAfterMs?: number | null;
}) {
  const index = Math.max(
    0,
    Math.min(
      MANUS_PROVIDER_READ_BACKOFF_MS.length - 1,
      Math.trunc(input.failureCount) - 1,
    ),
  );
  const scheduled = MANUS_PROVIDER_READ_BACKOFF_MS[index]!;
  const providerDelay = Math.max(0, Math.trunc(input.retryAfterMs ?? 0));
  return Math.min(300_000, Math.max(scheduled, providerDelay));
}

export function nativeSourceAttachmentRetryWindow(
  state: ProviderState,
  now = Date.now(),
) {
  const current = providerStateV2(state);
  const failureCount = (current.nativeSourceReadFailureCount ?? 0) + 1;
  const parsed = current.nativeSourceReadFailureSince
    ? Date.parse(current.nativeSourceReadFailureSince)
    : Number.NaN;
  const since = Number.isFinite(parsed) ? parsed : now;
  const nextPollMs = manusProviderReadRetryDelayMs({ failureCount });
  return {
    expired: now - since >= MANUS_PROVIDER_READ_RECONCILIATION_MS,
    nextPollMs,
    state: providerStateV2Schema.parse({
      ...current,
      buildPhase: "provider_sync_delayed",
      nativeSourceReadFailureCount: failureCount,
      nativeSourceReadFailureSince: new Date(since).toISOString(),
      nativeSourceNextPollAt: new Date(now + nextPollMs).toISOString(),
    }),
  };
}

function clearProviderReadFailureState(
  state: ProviderState | null,
  input: { completed: boolean; now: number; operationToken: string },
) {
  const parsed = providerStateV2(state);
  const current =
    parsed.phaseOperationToken === input.operationToken
      ? parsed
      : providerStateV2Schema.parse({
          ...parsed,
          phaseOperationToken: input.operationToken,
          phaseStartedAt: new Date(input.now).toISOString(),
          lastContractProgressAt: undefined,
          providerStoppedAt: undefined,
          providerStoppedOperationToken: undefined,
          resultPendingSince: undefined,
          resultPendingOperationToken: undefined,
        });
  return providerStateV2Schema.parse({
    ...current,
    providerReadFailureCount: undefined,
    providerReadFailureSince: undefined,
    providerNextPollAt: undefined,
    providerTaskNotFoundCount: undefined,
    providerLastReadFailure: undefined,
    buildPhase:
      current.buildPhase === "provider_sync_delayed"
        ? current.nativeRepairAttempt && current.nativeRepairAttempt > 0
          ? "source_repairing"
          : undefined
        : current.buildPhase,
    providerStoppedAt:
      current.providerStoppedAt ??
      (input.completed ? new Date(input.now).toISOString() : undefined),
    providerStoppedOperationToken: input.completed
      ? input.operationToken
      : current.providerStoppedOperationToken,
    providerSyncStartedAt: [
      "native_repair_send_unknown",
      "repair_send_unknown",
      "content_send_unknown",
    ].includes(current.stage)
      ? current.providerSyncStartedAt
      : undefined,
  });
}

function providerReadAttentionFailure(input: {
  code: string;
  message: string;
  state: ProviderStateV2;
}) {
  return new SiteOpsManusFailure(
    input.code,
    input.message,
    "attention_required",
    input.state,
  );
}

export type ManusPollEventsResult = {
  detail: ManusTaskDetail | null;
  events: ManusV2MessageEvent[];
  detailAvailable: boolean;
  messagesAvailable: boolean;
  state: { failed: boolean; completed: boolean };
  waiting: ReturnType<typeof latestManusV2WaitingDetail>;
  providerState: ProviderStateV2;
  deferred: boolean;
  nextPollMs: number;
};

/**
 * Reconcile a bound Manus task through two independent GETs. A read failure is
 * never evidence that the already-created task failed, and it must never send
 * a replacement POST. The returned provider state is durable in
 * site_operations.result, including its bounded retry schedule.
 */
export async function pollManusTaskEvents(input: {
  client: ManusV2Client;
  taskId: string;
  operationToken: string;
  providerState: ProviderState | null;
  now?: number;
  operationId?: string;
  buildId?: string;
}): Promise<ManusPollEventsResult> {
  const now = input.now ?? Date.now();
  const [detailRead, messagesRead] = await Promise.allSettled([
    input.client.taskDetail(input.taskId),
    input.client.listAllMessages({
      taskId: input.taskId,
      order: "desc",
      stopAfterOperationToken: input.operationToken,
    }),
  ]);
  const detail = detailRead.status === "fulfilled" ? detailRead.value : null;
  const events = messagesRead.status === "fulfilled" ? messagesRead.value : [];
  const failures = [detailRead, messagesRead].flatMap((read) =>
    read.status === "rejected" ? [read.reason] : [],
  );
  for (const error of failures) {
    if (!(error instanceof ManusV2ApiError)) throw error;
    if (isTaskIdentityReadFailure(error)) {
      throw providerReadAttentionFailure({
        code: "FRONTMIND_BUILD_TASK_IDENTITY_CONFLICT",
        message: "AI 建站任务身份与冻结坐标不一致，系统已停止采用该结果。",
        state: providerStateV2(input.providerState),
      });
    }
  }

  // A usable listMessages response remains authoritative even when detail is
  // explicitly rejected. Only classify read rejection after confirming the
  // result stream itself is unavailable; task identity conflicts above are
  // the sole fail-closed exception.
  if (messagesRead.status === "rejected") {
    for (const error of failures as ManusV2ApiError[]) {
      if (
        error.status === 401 ||
        error.status === 403 ||
        error.status === 400 ||
        error.status === 422 ||
        (!isTransientManusReadFailure(error) &&
          !isTaskNotFoundReadFailure(error))
      ) {
        throw providerReadAttentionFailure({
          code:
            error.status === 401 || error.status === 403
              ? "FRONTMIND_BUILD_CONFIGURATION_ERROR"
              : "FRONTMIND_BUILD_PROVIDER_READ_REJECTED",
          message:
            error.status === 401 || error.status === 403
              ? "AI 建站服务配置暂不可用，已保留原任务坐标。"
              : "AI 建站任务查询被上游明确拒绝，已保留原任务坐标等待处理。",
          state: providerStateV2(input.providerState),
        });
      }
    }
  }

  const phaseEvents = currentPhaseEvents(events, input.operationToken);
  const eventStatus = latestManusV2TaskState(phaseEvents);
  const terminalState =
    detail && messagesRead.status === "fulfilled"
      ? phaseTerminalTaskState(eventStatus, detail.status)
      : messagesRead.status === "fulfilled"
        ? combinedTerminalTaskState(eventStatus, undefined)
        : { failed: false, completed: false };
  if (failures.length === 0) {
    const recovered = Number(
      providerStateV2(input.providerState).providerReadFailureCount ?? 0,
    );
    if (recovered > 0) {
      console.info("[siteops-manus] provider_read_recovered", {
        event: "siteops_manus_provider_read_recovered",
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.buildId ? { buildId: input.buildId } : {}),
        taskBound: true,
        recoveredFailureCount: recovered,
      });
    }
    return {
      detail,
      events,
      detailAvailable: true,
      messagesAvailable: true,
      state: terminalState,
      waiting: latestManusV2WaitingDetail(phaseEvents),
      providerState: clearProviderReadFailureState(input.providerState, {
        completed: terminalState.completed,
        now,
        operationToken: input.operationToken,
      }),
      deferred: false,
      nextPollMs: 10_000,
    };
  }

  // listMessages is the authoritative result stream. If it succeeded, a
  // detail-only transport failure must not accumulate toward task-not-found
  // or the 24-hour attention boundary and, critically, must never discard an
  // already returned structured result/attachment. Persist the diagnostic and
  // keep a short retry cadence while clearing the prior consecutive outage.
  if (messagesRead.status === "fulfilled") {
    const primaryFailure = failures.find(
      (error): error is ManusV2ApiError => error instanceof ManusV2ApiError,
    )!;
    const recovered = clearProviderReadFailureState(input.providerState, {
      completed: terminalState.completed,
      now,
      operationToken: input.operationToken,
    });
    let partialState = providerStateV2Schema.parse({
      ...recovered,
      buildPhase: "provider_sync_delayed",
      providerLastReadFailure: safeManusReadFailure(primaryFailure),
    });
    for (const error of failures) {
      logManusReadFailure({
        error: error as ManusV2ApiError,
        operationId: input.operationId,
        buildId: input.buildId,
        taskBound: true,
        failureCount: 1,
        nextPollMs: 10_000,
      });
    }
    const explicitDetailRejection =
      detailRead.status === "rejected" &&
      detailRead.reason instanceof ManusV2ApiError &&
      (detailRead.reason.status === 401 ||
        detailRead.reason.status === 403 ||
        detailRead.reason.status === 400 ||
        detailRead.reason.status === 422 ||
        (!isTransientManusReadFailure(detailRead.reason) &&
          !isTaskNotFoundReadFailure(detailRead.reason)));
    const hasResultCandidate = phaseEvents.some(
      (event) =>
        event.type === "structured_output_result" ||
        event.type === "assistant_message",
    );
    if (explicitDetailRejection) {
      if (!hasResultCandidate) {
        throw providerReadAttentionFailure({
          code:
            detailRead.reason.status === 401 || detailRead.reason.status === 403
              ? "FRONTMIND_BUILD_CONFIGURATION_ERROR"
              : "FRONTMIND_BUILD_PROVIDER_READ_REJECTED",
          message:
            detailRead.reason.status === 401 || detailRead.reason.status === 403
              ? "AI 建站任务详情读取被拒绝且结果流尚无可采用结果，已保留原任务坐标。"
              : "AI 建站任务详情读取被明确拒绝且结果流尚无可采用结果，已保留原任务坐标。",
          state: partialState,
        });
      }
      const sync = providerResultSyncWindow(partialState, now);
      partialState = sync.state;
      if (sync.expired) {
        throw providerReadAttentionFailure({
          code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
          message:
            "AI 建站任务详情持续不可读，已保留结果流和原任务坐标等待处理。",
          state: partialState,
        });
      }
    }
    const resultGrace = structuredResultGrace(
      partialState,
      terminalState.completed,
      now,
      input.operationToken,
    );
    partialState = providerStateV2Schema.parse(resultGrace.state);
    if (resultGrace.expired && !hasResultCandidate) {
      throw providerReadAttentionFailure({
        code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
        message:
          "AI 建站任务已停止但结果流在五分钟宽限期内仍无可采用结果，已保留原任务坐标等待处理。",
        state: partialState,
      });
    }
    return {
      detail,
      events,
      detailAvailable: detailRead.status === "fulfilled",
      messagesAvailable: true,
      state: terminalState,
      waiting: latestManusV2WaitingDetail(phaseEvents),
      providerState: partialState,
      deferred: false,
      nextPollMs: 10_000,
    };
  }

  const current = structuredResultGrace(
    providerStateV2(input.providerState),
    false,
    now,
    input.operationToken,
  ).state as ProviderStateV2;
  const failureCount = (current.providerReadFailureCount ?? 0) + 1;
  const bothReadsNotFound =
    detailRead.status === "rejected" &&
    detailRead.reason instanceof ManusV2ApiError &&
    isTaskNotFoundReadFailure(detailRead.reason) &&
    messagesRead.reason instanceof ManusV2ApiError &&
    isTaskNotFoundReadFailure(messagesRead.reason);
  const taskNotFoundCount = Math.min(
    3,
    bothReadsNotFound ? (current.providerTaskNotFoundCount ?? 0) + 1 : 0,
  );
  const firstFailureAt = (() => {
    const parsed = current.providerReadFailureSince
      ? Date.parse(current.providerReadFailureSince)
      : Number.NaN;
    return Number.isFinite(parsed) ? parsed : now;
  })();
  const retryAfterMs = Math.max(
    0,
    ...failures.map((error) =>
      error instanceof ManusV2ApiError ? (error.retryAfterMs ?? 0) : 0,
    ),
  );
  const nextPollMs = manusProviderReadRetryDelayMs({
    failureCount,
    retryAfterMs,
  });
  const primaryFailure = failures.find(
    (error): error is ManusV2ApiError => error instanceof ManusV2ApiError,
  )!;
  const delayedState = providerStateV2Schema.parse({
    ...current,
    buildPhase: "provider_sync_delayed",
    providerReadFailureCount: failureCount,
    providerReadFailureSince: new Date(firstFailureAt).toISOString(),
    providerNextPollAt: new Date(now + nextPollMs).toISOString(),
    providerTaskNotFoundCount: taskNotFoundCount || undefined,
    providerLastReadFailure: safeManusReadFailure(primaryFailure),
    providerStoppedAt:
      current.providerStoppedAt ??
      (terminalState.completed ? new Date(now).toISOString() : undefined),
    providerStoppedOperationToken: terminalState.completed
      ? input.operationToken
      : current.providerStoppedOperationToken,
  });
  for (const error of failures) {
    logManusReadFailure({
      error: error as ManusV2ApiError,
      operationId: input.operationId,
      buildId: input.buildId,
      taskBound: true,
      failureCount,
      nextPollMs,
    });
  }
  if (taskNotFoundCount >= 3) {
    throw providerReadAttentionFailure({
      code: "FRONTMIND_BUILD_PROVIDER_TASK_NOT_FOUND",
      message:
        "AI 建站任务连续三次无法按冻结坐标读取，已保留任务编号等待处理。",
      state: delayedState,
    });
  }
  if (now - firstFailureAt >= MANUS_PROVIDER_READ_RECONCILIATION_MS) {
    throw providerReadAttentionFailure({
      code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
      message:
        "AI 建站结果已持续同步 24 小时，现已保留原任务坐标等待人工恢复。",
      state: delayedState,
    });
  }
  const resultGrace = structuredResultGrace(
    delayedState,
    terminalState.completed,
    now,
    input.operationToken,
  );
  const graceState = providerStateV2Schema.parse(resultGrace.state);
  if (resultGrace.expired) {
    throw providerReadAttentionFailure({
      code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
      message:
        "AI 建站任务已停止但结果流在五分钟宽限期内仍不可读，已保留原任务坐标等待处理。",
      state: graceState,
    });
  }
  return {
    detail,
    events,
    detailAvailable: detailRead.status === "fulfilled",
    messagesAvailable: false,
    state: terminalState,
    waiting: null,
    providerState: graceState,
    deferred: true,
    nextPollMs,
  };
}

async function pollEvents(
  client: ManusV2Client,
  taskId: string,
  operationToken: string,
  providerState: ProviderState | null,
  coordinates?: { operationId?: string; buildId?: string },
) {
  return await pollManusTaskEvents({
    client,
    taskId,
    operationToken,
    providerState,
    ...coordinates,
  });
}

function nativeSourceReceiptOutputSchema(input: {
  operationToken: string;
  baseSourceSha256: string;
  contractVersion: 1 | 2;
  runtime: NativeSourceRuntimeRegistryEntry | null;
  contentPlanSha256?: string;
}): ManusV2StructuredOutputSchema {
  if (input.contractVersion === 2 && !input.runtime) {
    throw new Error("NATIVE_SOURCE_RUNTIME_COORDINATES_MISSING");
  }
  const coordinates = input.runtime?.coordinates;
  const v2Properties =
    input.contractVersion === 2
      ? {
          runtimeContractVersion: {
            type: "string" as const,
            enum: [coordinates!.contractVersion],
          },
          runtimeContractSha256: {
            type: "string" as const,
            enum: [coordinates!.contractSha256],
          },
          executionShellSha256: {
            type: "string" as const,
            enum: [coordinates!.executionShellSha256],
          },
          executionBaselineSha256: {
            type: "string" as const,
            enum: [input.baseSourceSha256],
          },
        }
      : {};
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      operationToken: { type: "string", enum: [input.operationToken] },
      baseSourceSha256: {
        type: "string",
        enum: [input.baseSourceSha256],
      },
      archiveSha256: { type: "string" },
      fileCount: { type: "integer" },
      preflightVersion: {
        type: "string",
        enum: [
          input.contractVersion === 2
            ? coordinates!.preflightVersion
            : NATIVE_SOURCE_PREFLIGHT_VERSION,
        ],
      },
      preflightStatus: { type: "string", enum: ["passed"] },
      preflightSha256: {
        type: "string",
        enum: [
          input.contractVersion === 2
            ? coordinates!.preflightSha256
            : NATIVE_SOURCE_PREFLIGHT_SHA256,
        ],
      },
      ...(input.contentPlanSha256
        ? {
            contentPlanSha256: {
              type: "string" as const,
              enum: [input.contentPlanSha256],
            },
          }
        : {}),
      ...v2Properties,
    },
    required: [
      "operationToken",
      "baseSourceSha256",
      "archiveSha256",
      "fileCount",
      "preflightVersion",
      "preflightStatus",
      "preflightSha256",
      ...(input.contentPlanSha256 ? ["contentPlanSha256"] : []),
      ...(input.contractVersion === 2
        ? [
            "runtimeContractVersion",
            "runtimeContractSha256",
            "executionShellSha256",
            "executionBaselineSha256",
          ]
        : []),
    ],
    additionalProperties: false,
  });
}

function siteContentPlanOutputSchema(input: {
  operationToken: string;
  inventorySha256: string;
}): ManusV2StructuredOutputSchema {
  const nullableString = {
    anyOf: [{ type: "string" }, { type: "null" }],
  } as const;
  return assertSiteOpsStructuredOutputSchema({
    type: "object",
    properties: {
      wireSchemaVersion: { type: "integer", enum: [2] },
      operationToken: { type: "string", enum: [input.operationToken] },
      inventorySha256: { type: "string", enum: [input.inventorySha256] },
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string" },
            path: { type: "string" },
            title: { type: "string" },
            navigation: {
              type: "string",
              enum: ["primary", "footer", "contextual", "hidden"],
            },
            parentPath: nullableString,
            detailOfPath: nullableString,
            purpose: { type: "string" },
            userQuestions: { type: "array", items: { type: "string" } },
            h1: { type: "string" },
            summary: { type: "string" },
            ctaLabel: nullableString,
            ctaTargetPath: nullableString,
          },
          required: [
            "routeId",
            "path",
            "title",
            "navigation",
            "parentPath",
            "detailOfPath",
            "purpose",
            "userQuestions",
            "h1",
            "summary",
            "ctaLabel",
            "ctaTargetPath",
          ],
          additionalProperties: false,
        },
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            routeId: { type: "string" },
            sectionId: { type: "string" },
            blockKind: {
              type: "string",
              enum: [
                "hero",
                "prose",
                "feature_list",
                "steps",
                "metrics",
                "entity_grid",
                "faq",
                "quote",
                "media",
                "cta",
              ],
            },
            heading: { type: "string" },
            purpose: { type: "string" },
            body: { type: "string" },
            sourceDocumentIds: {
              type: "array",
              items: { type: "string" },
            },
            evidenceExcerpts: {
              type: "array",
              items: { type: "string" },
            },
            mediaIds: { type: "array", items: { type: "string" } },
            entityIds: { type: "array", items: { type: "string" } },
            faqIds: { type: "array", items: { type: "string" } },
          },
          required: [
            "routeId",
            "sectionId",
            "blockKind",
            "heading",
            "purpose",
            "body",
            "sourceDocumentIds",
            "evidenceExcerpts",
            "mediaIds",
            "entityIds",
            "faqIds",
          ],
          additionalProperties: false,
        },
      },
      navigation: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            targetPath: { type: "string" },
          },
          required: ["label", "targetPath"],
          additionalProperties: false,
        },
      },
      coverage: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sourceDocumentId: {
              type: "string",
            },
            status: { type: "string", enum: ["used", "omitted"] },
            routeIds: { type: "array", items: { type: "string" } },
            omissionReason: nullableString,
          },
          required: [
            "sourceDocumentId",
            "status",
            "routeIds",
            "omissionReason",
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      "wireSchemaVersion",
      "operationToken",
      "inventorySha256",
      "routes",
      "sections",
      "navigation",
      "coverage",
    ],
    additionalProperties: false,
  });
}

export function nativeSourceOutputAttachment(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
) {
  const candidates: Array<{
    filename: string;
    contentType: string;
    url: string;
    fileId: string | null;
    eventId: string;
    attachmentIdentity: string;
  }> = [];
  for (const event of currentPhaseEvents(events, operationToken)) {
    if (event.type !== "assistant_message") continue;
    const message = event.assistant_message;
    if (!message || typeof message !== "object" || Array.isArray(message))
      continue;
    const attachments = Array.isArray(
      (message as Record<string, unknown>).attachments,
    )
      ? ((message as Record<string, unknown>).attachments as unknown[])
      : [];
    for (const [attachmentIndex, attachment] of attachments.entries()) {
      if (
        !attachment ||
        typeof attachment !== "object" ||
        Array.isArray(attachment)
      )
        continue;
      const record = attachment as Record<string, unknown>;
      const filename =
        record.filename ?? record.file_name ?? record.fileName ?? "";
      const contentType =
        record.content_type ?? record.mime_type ?? record.mimeType ?? "";
      const mediaType =
        typeof contentType === "string"
          ? contentType.split(";", 1)[0]?.trim().toLowerCase()
          : "";
      const url = record.url ?? record.file_url ?? record.fileUrl ?? "";
      const rawFileId = record.file_id ?? record.fileId;
      const fileId =
        typeof rawFileId === "string" &&
        rawFileId.length >= 1 &&
        rawFileId.length <= 512
          ? rawFileId
          : null;
      if (
        filename === FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME &&
        [
          FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          "application/x-zip-compressed",
          "application/octet-stream",
        ].includes(mediaType ?? "") &&
        typeof url === "string" &&
        url.length > 0
      ) {
        candidates.push({
          filename: String(filename),
          contentType: String(contentType),
          url,
          fileId,
          eventId: event.id,
          attachmentIdentity: `${event.id}:attachment:${attachmentIndex}`,
        });
      }
    }
  }
  // Signed URLs and the undocumented file_id field may rotate or disappear
  // between reads. Collapse a candidate only when either its stable file id
  // agrees or its exact event+attachment-index identity agrees. The index is
  // required because one assistant message may contain two same-named ZIPs.
  const unique: Array<(typeof candidates)[number]> = [];
  for (const candidate of candidates) {
    const existingIndex = unique.findIndex(
      (existing) =>
        existing.attachmentIdentity === candidate.attachmentIdentity ||
        (existing.fileId !== null &&
          candidate.fileId !== null &&
          existing.fileId === candidate.fileId),
    );
    if (existingIndex < 0) {
      unique.push(candidate);
      continue;
    }
    const existing = unique[existingIndex]!;
    if (
      existing.fileId !== null &&
      candidate.fileId !== null &&
      existing.fileId !== candidate.fileId
    ) {
      unique.push(candidate);
      continue;
    }
    unique[existingIndex] = {
      ...candidate,
      fileId: candidate.fileId ?? existing.fileId,
    };
  }
  if (unique.length > 1) {
    throw new SiteOpsManusFailure(
      "SITEOPS_NATIVE_SOURCE_OUTPUT_CONFLICT",
      "AI 建站返回了多个不同的完整源码包，已停止采用以避免版本混淆。",
      "failed",
    );
  }
  return unique[0] ?? null;
}

export function nativeSourceAttachmentIdentityConflicts(input: {
  priorFileId?: string;
  priorAttachmentIdentity?: string;
  priorEventId?: string;
  priorScope?: NativeSourceAttachmentScope;
  currentScope: NativeSourceAttachmentScope;
  attachment: {
    fileId: string | null;
    eventId: string;
    attachmentIdentity: string;
  };
}) {
  const hasPriorIdentity = Boolean(
    input.priorFileId || input.priorAttachmentIdentity || input.priorEventId,
  );
  if (!hasPriorIdentity) return false;
  // Identity coordinates without their task/attempt/token fence cannot be
  // proven to belong to this phase. Keep historical states fail-closed rather
  // than guessing whether an attachment came from the current conversation.
  if (!input.priorScope) return true;
  const sameScope =
    input.priorScope.taskId === input.currentScope.taskId &&
    input.priorScope.repairAttempt === input.currentScope.repairAttempt &&
    input.priorScope.operationToken === input.currentScope.operationToken;
  if (!sameScope) {
    // The only legitimate scope transition inside one bound task is a forward
    // repair attempt with its own operation token. Reset/new-build task drift,
    // attempt rollback, or a token change inside one attempt remains closed.
    return !(
      input.priorScope.taskId === input.currentScope.taskId &&
      input.priorScope.repairAttempt + 1 === input.currentScope.repairAttempt &&
      input.priorScope.operationToken !== input.currentScope.operationToken
    );
  }
  if (input.priorFileId && input.attachment.fileId) {
    return input.priorFileId !== input.attachment.fileId;
  }
  if (input.priorAttachmentIdentity) {
    return (
      input.priorAttachmentIdentity !== input.attachment.attachmentIdentity
    );
  }
  return Boolean(
    input.priorEventId && input.priorEventId !== input.attachment.eventId,
  );
}

function nativeSourceAttachmentScopeMatches(
  left: NativeSourceAttachmentScope | undefined,
  right: NativeSourceAttachmentScope,
) {
  return Boolean(
    left &&
      left.taskId === right.taskId &&
      left.repairAttempt === right.repairAttempt &&
      left.operationToken === right.operationToken,
  );
}

type BufferedNativeSelection = Awaited<
  ReturnType<typeof selectedNativeSourceArchive>
>;

type StaticNativeSelection = {
  bundle: VisualSelectionBundleV7;
  candidate: VisualSelectionBundleV7["candidates"][number];
  archiveBytes: Buffer | null;
  archiveByteLength: number;
  archiveSha256: string;
  createArchiveReadStream: () => ReadStream;
  manifest: VisualSelectionBundleV7["candidates"][number];
  files: [];
};

type NativeSelection = BufferedNativeSelection | StaticNativeSelection;

function isStaticNativeSelection(
  selection: NativeSelection,
): selection is StaticNativeSelection {
  return selection.bundle.schemaVersion === 7;
}

function nativeSelectionByteLength(selection: NativeSelection) {
  return isStaticNativeSelection(selection)
    ? selection.archiveByteLength
    : selection.archiveBytes.length;
}

function nativeSelectionQueryHash(selection: NativeSelection) {
  return visualSelectionQueryHash(selection.bundle);
}

function nativeSelectionInlineBytes(selection: NativeSelection) {
  if (!selection.archiveBytes) {
    throw new Error("NATIVE_SOURCE_INLINE_BYTES_MISSING");
  }
  return selection.archiveBytes;
}

async function nativeSelectionBytesForMediaOverlay(selection: NativeSelection) {
  if (selection.archiveBytes) return Buffer.from(selection.archiveBytes);
  if (!isStaticNativeSelection(selection)) {
    throw new Error("NATIVE_SOURCE_OVERLAY_BYTES_MISSING");
  }
  const chunks: Buffer[] = [];
  const digest = createHash("sha256");
  let total = 0;
  const stream = selection.createArchiveReadStream();
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (
      total > selection.archiveByteLength ||
      total > NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes
    ) {
      stream.destroy();
      throw new SiteOpsManusFailure(
        "SITEOPS_KNOWLEDGE_MEDIA_SOURCE_LIMIT_EXCEEDED",
        "知识库媒体加入后超过网站源码上限。",
        "failed",
      );
    }
    digest.update(chunk);
    chunks.push(chunk);
  }
  if (
    total !== selection.archiveByteLength ||
    digest.digest("hex") !== selection.archiveSha256
  ) {
    throw new SiteOpsManusFailure(
      "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
      "固定模板源码与目录坐标不一致。",
      "failed",
    );
  }
  return Buffer.concat(chunks, total);
}

function knowledgeMediaManifestAttachment(
  media: readonly TrustedSiteKnowledgeMedia[],
) {
  if (media.length === 0) return [];
  const bytes = Buffer.from(
    `${canonicalJson({
      schemaVersion: 1,
      files: freezeSiteKnowledgeMedia(media).map((asset) => ({
        assetId: asset.assetId,
        publicUrl: asset.publicPath,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        width: asset.width,
        height: asset.height,
        alt: asset.alt,
      })),
    })}\n`,
    "utf8",
  );
  return [
    {
      filename: "frontmind-knowledge-media-manifest-v1.json",
      mime_type: "application/json",
      file_data: `data:application/json;base64,${bytes.toString("base64")}`,
    } satisfies ManusV2Attachment,
  ];
}

type SiteOpsRevisionMedia = z.infer<
  typeof operationInputSchema
>["revisionInputAssets"][number] & { bytes: Buffer };
type SiteOpsRevisionLineageMedia = SiteOpsRevisionMedia & {
  sourceDocumentIds: string[];
};

function siteOpsCustomerMediaPlanId(publicPath: string) {
  return `customer-media:${sha256(publicPath).slice(0, 32)}`;
}

export function siteOpsContentPlanMediaSelection<
  T extends { publicPath: string },
>(plan: SiteContentPlanV2, userMedia: readonly T[]) {
  const customerMediaById = new Map(
    userMedia.map((asset) => [
      siteOpsCustomerMediaPlanId(asset.publicPath),
      asset,
    ]),
  );
  const selectedCustomerMedia = new Map<string, T>();
  const knowledgeRoutePaths = new Map<string, Set<string>>();
  const unknownCustomerMediaIds = new Set<string>();
  for (const route of plan.routes) {
    for (const mediaId of new Set(
      route.sections.flatMap((section) => section.mediaIds),
    )) {
      if (mediaId.startsWith("customer-media:")) {
        const customerMedia = customerMediaById.get(mediaId);
        if (customerMedia) selectedCustomerMedia.set(mediaId, customerMedia);
        else unknownCustomerMediaIds.add(mediaId);
        continue;
      }
      const routePaths = knowledgeRoutePaths.get(mediaId) ?? new Set<string>();
      routePaths.add(route.path);
      knowledgeRoutePaths.set(mediaId, routePaths);
    }
  }
  return {
    selectedCustomerMedia: [...selectedCustomerMedia.values()],
    knowledgeRoutePaths,
    unknownCustomerMediaIds: [...unknownCustomerMediaIds],
  };
}

type SiteOpsRevisionLineageAsset = {
  row: typeof siteBuildInputAssets.$inferSelect;
  sourceDocumentId: string;
};

export function siteOpsRevisionLineageFromRows(input: {
  currentBuild: Pick<
    typeof siteBuilds.$inferSelect,
    | "id"
    | "parentBuildId"
    | "projectId"
    | "userId"
    | "knowledgeSnapshotId"
    | "knowledgeArchiveHash"
  >;
  projectId: string;
  userId: number;
  taskStartedAt: Date;
  knowledgeInputEpochId: string | null;
  builds: Array<
    Pick<
      typeof siteBuilds.$inferSelect,
      | "id"
      | "parentBuildId"
      | "projectId"
      | "userId"
      | "knowledgeSnapshotId"
      | "knowledgeArchiveHash"
      | "workflowVersion"
      | "sourceLocalAssetId"
      | "sourceHash"
      | "contentPlanLocalAssetId"
      | "contentPlanSha256"
      | "createdAt"
    >
  >;
  operations: Array<
    Pick<
      typeof siteOperations.$inferSelect,
      | "id"
      | "buildId"
      | "projectId"
      | "userId"
      | "kind"
      | "status"
      | "input"
      | "createdAt"
    >
  >;
  assets: Array<typeof siteBuildInputAssets.$inferSelect>;
  /** Provider generation inherits completed ancestors only. Production replay
   * runs after the current revision succeeded, so it includes that immutable
   * child as the newest lineage node as well. */
  includeCurrentBuild?: boolean;
}): {
  documents: SupplementalKnowledgeDocument[];
  assets: SiteOpsRevisionLineageAsset[];
} {
  const fail = () => {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      "连续修订的父版本来源链已不完整或不属于当前任务。",
      "failed",
    );
  };
  if (
    input.currentBuild.projectId !== input.projectId ||
    input.currentBuild.userId !== input.userId ||
    !input.currentBuild.parentBuildId
  ) {
    return fail();
  }
  const buildById = new Map(input.builds.map((row) => [row.id, row]));
  const newestFirst: typeof input.builds = [];
  const visited = new Set<string>();
  let cursor: string | null = input.includeCurrentBuild
    ? input.currentBuild.id
    : input.currentBuild.parentBuildId;
  if (!input.includeCurrentBuild) visited.add(input.currentBuild.id);
  while (cursor) {
    if (visited.has(cursor)) return fail();
    visited.add(cursor);
    const row = buildById.get(cursor);
    if (
      !row ||
      row.projectId !== input.projectId ||
      row.userId !== input.userId ||
      row.workflowVersion !== SITEOPS_MATERIALIZER_V2_9.frontMindVersion ||
      row.knowledgeSnapshotId !== input.currentBuild.knowledgeSnapshotId ||
      row.knowledgeArchiveHash !== input.currentBuild.knowledgeArchiveHash ||
      row.createdAt.getTime() < input.taskStartedAt.getTime()
    ) {
      return fail();
    }
    newestFirst.push(row);
    cursor = row.parentBuildId;
  }
  const oldestFirst = newestFirst.reverse();
  const revisionBuilds = oldestFirst.filter((row) => row.parentBuildId);
  const revisionBuildIds = new Set(revisionBuilds.map((row) => row.id));
  const operationsByBuild = new Map<
    string,
    Array<(typeof input.operations)[number]>
  >();
  for (const operation of input.operations) {
    if (
      operation.kind !== "build_revision" ||
      !operation.buildId ||
      !revisionBuildIds.has(operation.buildId)
    ) {
      continue;
    }
    const rows = operationsByBuild.get(operation.buildId) ?? [];
    rows.push(operation);
    operationsByBuild.set(operation.buildId, rows);
  }
  const sourceDocumentIdByBuild = new Map<string, string>();
  const expectedAssetsByBuild = new Map<
    string,
    z.infer<typeof operationInputSchema>["revisionInputAssets"]
  >();
  const documents: SupplementalKnowledgeDocument[] = [];
  for (const build of revisionBuilds) {
    const operations = operationsByBuild.get(build.id) ?? [];
    if (operations.length !== 1) return fail();
    const operation = operations[0]!;
    const parsed = operationInputSchema.safeParse(operation.input);
    const parent = build.parentBuildId
      ? buildById.get(build.parentBuildId)
      : undefined;
    if (
      !parent ||
      operation.projectId !== input.projectId ||
      operation.userId !== input.userId ||
      operation.kind !== "build_revision" ||
      operation.status !== "succeeded" ||
      operation.createdAt.getTime() < input.taskStartedAt.getTime() ||
      !parsed.success ||
      !parsed.data.feedback ||
      parsed.data.childBuildId !== build.id ||
      parsed.data.buildId !== build.parentBuildId ||
      parsed.data.revisionBaseline?.parentBuildId !== build.parentBuildId ||
      parsed.data.revisionBaseline.sourceLocalAssetId !==
        parent.sourceLocalAssetId ||
      parsed.data.revisionBaseline.sourceSha256 !== parent.sourceHash ||
      parsed.data.revisionBaseline.contentPlanLocalAssetId !==
        parent.contentPlanLocalAssetId ||
      parsed.data.revisionBaseline.contentPlanSha256 !==
        parent.contentPlanSha256
    ) {
      return fail();
    }
    const sourceDocumentId = `customer-revision:${operation.id}`;
    sourceDocumentIdByBuild.set(build.id, sourceDocumentId);
    expectedAssetsByBuild.set(build.id, parsed.data.revisionInputAssets);
    documents.push({
      id: sourceDocumentId,
      path: `customer-revision/${operation.id}.md`,
      title: "历史客户明确修订要求",
      content: parsed.data.feedback,
      kind: "customer_revision",
      customerVisible: true,
    });
  }

  const seenAssetOrdinals = new Set<string>();
  const actualAssetsByBuild = new Map<
    string,
    Array<typeof siteBuildInputAssets.$inferSelect>
  >();
  const assets: SiteOpsRevisionLineageAsset[] = [];
  for (const row of input.assets) {
    if (!revisionBuildIds.has(row.buildId)) continue;
    const ordinalKey = `${row.buildId}:${row.ordinal}`;
    const sourceDocumentId = sourceDocumentIdByBuild.get(row.buildId);
    if (
      !sourceDocumentId ||
      row.projectId !== input.projectId ||
      row.userId !== input.userId ||
      row.taskStartedAt.getTime() !== input.taskStartedAt.getTime() ||
      row.siteOpsKnowledgeInputEpochId !== input.knowledgeInputEpochId ||
      row.ordinal < 1 ||
      row.ordinal > 8 ||
      seenAssetOrdinals.has(ordinalKey)
    ) {
      return fail();
    }
    seenAssetOrdinals.add(ordinalKey);
    const buildAssets = actualAssetsByBuild.get(row.buildId) ?? [];
    buildAssets.push(row);
    actualAssetsByBuild.set(row.buildId, buildAssets);
    assets.push({ row, sourceDocumentId });
  }
  for (const build of revisionBuilds) {
    const expected = expectedAssetsByBuild.get(build.id) ?? [];
    const actual = (actualAssetsByBuild.get(build.id) ?? []).sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    if (actual.length !== expected.length) return fail();
    for (const [index, descriptor] of expected.entries()) {
      const row = actual[index];
      if (
        !row ||
        row.ordinal !== index + 1 ||
        row.localAssetId !== descriptor.localAssetId ||
        row.filename !== descriptor.filename ||
        row.mimeType !== descriptor.mimeType ||
        row.sizeBytes !== descriptor.sizeBytes ||
        row.contentSha256 !== descriptor.contentSha256 ||
        row.width !== descriptor.width ||
        row.height !== descriptor.height ||
        row.publicPath !== descriptor.publicPath ||
        row.siteOpsKnowledgeInputEpochId !==
          descriptor.siteOpsKnowledgeInputEpochId
      ) {
        return fail();
      }
    }
  }
  const buildOrder = new Map(
    revisionBuilds.map((row, index) => [row.id, index]),
  );
  assets.sort(
    (left, right) =>
      (buildOrder.get(left.row.buildId) ?? 0) -
        (buildOrder.get(right.row.buildId) ?? 0) ||
      left.row.ordinal - right.row.ordinal,
  );
  return { documents, assets };
}

function archiveWrapperRoot(zip: JSZip) {
  const paths = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name);
  if (paths.length === 0) return null;
  const first = paths[0]!.split("/");
  if (first.length < 2) return null;
  const root = first[0]!;
  return paths.every((pathname) => pathname.startsWith(`${root}/`))
    ? root
    : null;
}

export async function overlaySiteOpsRevisionMedia(
  parentSource: Buffer,
  media: readonly SiteOpsRevisionMedia[],
) {
  if (media.length === 0) return Buffer.from(parentSource);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(parentSource, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_REVISION_BASE_INVALID",
      "父版本源码无法作为连续修订基线。",
      "failed",
    );
  }
  const wrapper = archiveWrapperRoot(zip);
  for (const asset of [...media].sort((left, right) =>
    left.publicPath.localeCompare(right.publicPath, "en-US"),
  )) {
    if (
      asset.bytes.length !== asset.sizeBytes ||
      sha256(asset.bytes) !== asset.contentSha256
    ) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_MEDIA_INVALID",
        "修订图片未通过冻结哈希校验。",
        "failed",
      );
    }
    const sourcePath = `public${asset.publicPath}`;
    const archivePath = wrapper ? `${wrapper}/${sourcePath}` : sourcePath;
    zip.file(archivePath, asset.bytes, {
      binary: true,
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const overlaid = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (overlaid.length > NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_REVISION_MEDIA_TOO_LARGE",
      "修订图片加入后超过网站源码上限，请减少图片数量或压缩图片。",
      "failed",
    );
  }
  return overlaid;
}

async function loadInheritedSiteOpsRevisionLineage(input: {
  db: any;
  operation: SiteOperation;
  build: typeof siteBuilds.$inferSelect;
  taskStartedAt: Date;
  knowledgeInputEpochId: string | null;
  readArtifact: typeof readSiteOpsArtifact;
}): Promise<{
  documents: SupplementalKnowledgeDocument[];
  media: SiteOpsRevisionLineageMedia[];
}> {
  const builds = (await input.db
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.projectId, input.operation.projectId),
        eq(siteBuilds.userId, input.operation.userId),
        gte(siteBuilds.createdAt, input.taskStartedAt),
      ),
    )) as Array<typeof siteBuilds.$inferSelect>;
  const buildIds = builds.map((row) => row.id);
  if (buildIds.length === 0) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_REVISION_LINEAGE_INVALID",
      "连续修订的父版本来源链已不完整或不属于当前任务。",
      "failed",
    );
  }
  const [operations, assets] = await Promise.all([
    input.db
      .select()
      .from(siteOperations)
      .where(inArray(siteOperations.buildId, buildIds)),
    input.db
      .select()
      .from(siteBuildInputAssets)
      .where(inArray(siteBuildInputAssets.buildId, buildIds)),
  ]);
  const lineage = siteOpsRevisionLineageFromRows({
    currentBuild: input.build,
    projectId: input.operation.projectId,
    userId: input.operation.userId,
    taskStartedAt: input.taskStartedAt,
    knowledgeInputEpochId: input.knowledgeInputEpochId,
    builds,
    operations,
    assets,
  });
  const media: SiteOpsRevisionLineageMedia[] = [];
  for (const { row, sourceDocumentId } of lineage.assets) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(row.mimeType) ||
      !/^[a-f0-9]{64}$/u.test(row.contentSha256) ||
      !/^\/frontmind-user-media\/[a-f0-9]{64}\.(?:png|jpg|webp)$/u.test(
        row.publicPath,
      ) ||
      row.sizeBytes < 1 ||
      row.sizeBytes > 8 * 1024 * 1024 ||
      row.width < 1 ||
      row.height < 1
    ) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_LINEAGE_MEDIA_INVALID",
        "连续修订的历史图片坐标无法通过校验。",
        "failed",
      );
    }
    const artifact = await input.readArtifact({
      userId: input.operation.userId,
      localAssetId: row.localAssetId,
      expectedSha256: row.contentSha256,
      expectedMimeTypes: [row.mimeType],
    });
    if (!artifact) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_LINEAGE_MEDIA_UNAVAILABLE",
        "连续修订的历史图片稳定副本不可用。",
        "failed",
      );
    }
    const bytes = await storedArtifactBytes(
      artifact,
      NATIVE_SOURCE_DEFAULT_LIMITS.maxSingleFileBytes,
    );
    if (bytes.length !== row.sizeBytes || sha256(bytes) !== row.contentSha256) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_LINEAGE_MEDIA_INVALID",
        "连续修订的历史图片未通过冻结哈希校验。",
        "failed",
      );
    }
    media.push({
      schemaVersion: 1,
      localAssetId: row.localAssetId,
      filename: row.filename,
      mimeType: row.mimeType as "image/png" | "image/jpeg" | "image/webp",
      sizeBytes: row.sizeBytes,
      contentSha256: row.contentSha256,
      width: row.width,
      height: row.height,
      publicPath: row.publicPath,
      siteOpsKnowledgeInputEpochId: row.siteOpsKnowledgeInputEpochId,
      bytes,
      sourceDocumentIds: [sourceDocumentId],
    });
  }
  return { documents: lineage.documents, media };
}

function staticCatalogCoordinatesMatch(
  candidate: VisualSelectionBundleV7["candidates"][number],
  entry: StaticTemplateCatalogEntry,
) {
  const catalogAdmission = entry.executionAdmission;
  const candidateAdmission = candidate.executionAdmission;
  const admissionMatches =
    catalogAdmission.status === "admitted" &&
    candidateAdmission.status === "admitted" &&
    candidateAdmission.rawSourceSha256 ===
      catalogAdmission.binding.rawSourceSha256 &&
    candidateAdmission.normalizedSourceSha256 ===
      catalogAdmission.normalizedSourceSha256 &&
    candidateAdmission.sourceTreeSha256 === catalogAdmission.sourceTreeSha256 &&
    candidateAdmission.runtimeContractSha256 ===
      catalogAdmission.runtimeContractSha256 &&
    candidateAdmission.executionShellSha256 ===
      catalogAdmission.executionShellSha256 &&
    candidateAdmission.deliveryContractSha256 ===
      catalogAdmission.deliveryContractSha256 &&
    candidateAdmission.distSha256 === catalogAdmission.distSha256 &&
    candidateAdmission.qaSha256 === catalogAdmission.qaSha256 &&
    candidateAdmission.browserReceiptSha256 ===
      catalogAdmission.browserReceiptSha256 &&
    candidateAdmission.qaStatus === catalogAdmission.qaStatus &&
    candidateAdmission.admissionEvidenceSha256 ===
      catalogAdmission.admissionEvidenceSha256 &&
    candidateAdmission.admissionEvidenceSha256 ===
      staticTemplateAdmissionEvidenceSha256({
        catalogVersion: candidate.catalogVersion,
        candidateId: candidate.catalogCandidateId,
        rawSourceSha256: candidateAdmission.rawSourceSha256,
        normalizedSourceSha256: candidateAdmission.normalizedSourceSha256,
        sourceTreeSha256: candidateAdmission.sourceTreeSha256,
        runtimeContractSha256: candidateAdmission.runtimeContractSha256,
        executionShellSha256: candidateAdmission.executionShellSha256,
        deliveryContractSha256: candidateAdmission.deliveryContractSha256,
        distSha256: candidateAdmission.distSha256,
        qaSha256: candidateAdmission.qaSha256,
        browserReceiptSha256: candidateAdmission.browserReceiptSha256,
        qaStatus: candidateAdmission.qaStatus,
      });
  return (
    admissionMatches &&
    candidate.catalogCandidateId === entry.candidateId &&
    candidate.providerTemplateId === entry.providerTemplateId &&
    candidate.providerSlug === entry.providerSlug &&
    candidate.providerVersion === entry.providerVersion &&
    candidate.sourceOwner === entry.sourceOwner &&
    candidate.sourceRepo === entry.sourceRepo &&
    candidate.sourceCommitSha === entry.sourceCommitSha &&
    candidate.sourceSubdirectory === entry.sourceSubdirectory &&
    candidate.sourceLicense === entry.sourceLicense &&
    candidate.sourceAssetId === entry.sourceAssetId &&
    candidate.sourceArchiveSha256 === entry.sourceSha256 &&
    candidate.sourceArchiveBytes === entry.sourceBytes &&
    candidate.previewAssetId === entry.previewAssetId &&
    candidate.previewSha256 === entry.previewSha256 &&
    candidate.previewMimeType === entry.previewMimeType &&
    candidate.previewWidth === entry.previewWidth &&
    candidate.previewHeight === entry.previewHeight
  );
}

async function readExactStaticArchive(input: {
  stream: ReadStream;
  expectedBytes: number;
  expectedSha256: string;
}) {
  const chunks: Buffer[] = [];
  const digest = createHash("sha256");
  let total = 0;
  for await (const raw of input.stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (
      total > input.expectedBytes ||
      total > MANUS_INLINE_ATTACHMENT_MAX_BYTES
    ) {
      throw new SiteOpsManusFailure(
        "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
        "固定模板源码与目录坐标不一致。",
        "failed",
      );
    }
    digest.update(chunk);
    chunks.push(chunk);
  }
  if (
    total !== input.expectedBytes ||
    digest.digest("hex") !== input.expectedSha256
  ) {
    throw new SiteOpsManusFailure(
      "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
      "固定模板源码与目录坐标不一致。",
      "failed",
    );
  }
  return Buffer.concat(chunks, total);
}

export async function selectedStaticNativeSourceArchive(input: {
  bundle: VisualSelectionBundleV7;
  selectedCandidateId: string;
}): Promise<StaticNativeSelection> {
  const candidate = input.bundle.candidates.find(
    (item) => item.id === input.selectedCandidateId,
  );
  if (!candidate) {
    throw new SiteOpsManusFailure(
      "VISUAL_SELECTED_CANDIDATE_MISSING",
      "冻结的视觉选择缺少已选模板。",
      "failed",
    );
  }
  if (
    (input.bundle.workflowVersion !==
      SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION &&
      input.bundle.workflowVersion !==
        SITEOPS_MATERIALIZER_V2_9.frontMindVersion) ||
    candidate.catalogVersion !== input.bundle.catalogVersion
  ) {
    throw new SiteOpsManusFailure(
      "STATIC_TEMPLATE_CATALOG_VERSION_MISMATCH",
      "固定模板目录版本与选择坐标不一致。",
      "failed",
    );
  }
  const frozenCatalog = await requireStaticTemplateCatalogVersion(
    input.bundle.catalogVersion,
  );
  if (frozenCatalog.catalogVersion !== input.bundle.catalogVersion) {
    throw new SiteOpsManusFailure(
      "STATIC_TEMPLATE_CATALOG_VERSION_MISMATCH",
      "固定模板目录版本与选择坐标不一致。",
      "failed",
    );
  }
  const catalogEntry = frozenCatalog.entries.find(
    (entry) => entry.candidateId === candidate.catalogCandidateId,
  );
  if (
    !catalogEntry ||
    !("executionAdmission" in catalogEntry) ||
    !staticCatalogCoordinatesMatch(
      candidate,
      catalogEntry as StaticTemplateCatalogEntry,
    )
  ) {
    throw new SiteOpsManusFailure(
      "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
      "固定模板源码与目录坐标不一致。",
      "failed",
    );
  }
  const opened = await openStaticTemplateCatalogVersionSource(
    input.bundle.catalogVersion,
    candidate.catalogCandidateId,
  );
  if (!("executionAdmission" in opened.entry)) {
    opened.stream.destroy();
    throw new SiteOpsManusFailure(
      "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
      "固定模板源码与目录坐标不一致。",
      "failed",
    );
  }
  const currentOpenedEntry = opened.entry as StaticTemplateCatalogEntry;
  if (!staticCatalogCoordinatesMatch(candidate, currentOpenedEntry)) {
    opened.stream.destroy();
    throw new SiteOpsManusFailure(
      "STATIC_TEMPLATE_SOURCE_COORDINATES_MISMATCH",
      "固定模板源码与目录坐标不一致。",
      "failed",
    );
  }
  const transport = nativeSourceAttachmentTransport(opened.entry.sourceBytes);
  let archiveBytes: Buffer | null = null;
  if (transport === "inline") {
    archiveBytes = await readExactStaticArchive({
      stream: opened.stream,
      expectedBytes: opened.entry.sourceBytes,
      expectedSha256: opened.entry.sourceSha256,
    });
  } else {
    opened.stream.destroy();
  }
  return {
    bundle: input.bundle,
    candidate,
    archiveBytes,
    archiveByteLength: opened.entry.sourceBytes,
    archiveSha256: opened.entry.sourceSha256,
    createArchiveReadStream: () => createReadStream(opened.path),
    manifest: candidate,
    files: [],
  };
}

const nativeTemplateCoordinateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFormat: z.literal("provider_archive_v1"),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z.string().trim().min(1).max(191),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    sourceSubdirectory: z.string().trim().min(1).max(240).nullable(),
    framework: z.enum(["vite_react", "next_static"]),
    entrypoint: z.string().trim().min(1).max(500),
    providerArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const normalizedNativeTemplateCoordinateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFormat: z.literal("normalized_v1"),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z.string().trim().min(1).max(191),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    sourceDirectory: z.string().trim().min(1).max(240),
    framework: z.enum(["vite_react", "next_static"]),
    entrypoint: z.string().trim().min(1).max(500),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const staticNativeTemplateCoordinateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFormat: z.literal("static_catalog_archive_v1"),
    catalogVersion: z.string().trim().min(1).max(191),
    catalogCandidateId: z.string().trim().min(1).max(191),
    sourceAssetId: z.string().trim().min(1).max(191),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z.string().trim().min(1).max(191),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    sourceSubdirectory: z.string().trim().min(1).max(500).nullable(),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const FRONTMIND_SELECTED_TEMPLATE_COORDINATE_FILENAME =
  "frontmind-selected-template-coordinate-v1.json";

/**
 * Bind a selected Marketplace template to its exact entrypoint without
 * mutating the untouched Provider archive. This matters for registry repos
 * that contain several templates at one immutable commit.
 */
export function nativeTemplateCoordinateDirective(source: NativeSelection) {
  if (isStaticNativeSelection(source)) {
    const manifest = staticNativeTemplateCoordinateV1Schema.parse({
      schemaVersion: 1,
      sourceFormat: "static_catalog_archive_v1",
      catalogVersion: source.candidate.catalogVersion,
      catalogCandidateId: source.candidate.catalogCandidateId,
      sourceAssetId: source.candidate.sourceAssetId,
      providerTemplateId: source.candidate.providerTemplateId,
      providerSlug: source.candidate.providerSlug,
      providerVersion: source.candidate.providerVersion,
      sourceSubdirectory: source.candidate.sourceSubdirectory,
      sourceArchiveSha256: source.candidate.sourceArchiveSha256,
    });
    const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
    return {
      manifest,
      promptInstruction: `${FRONTMIND_SELECTED_TEMPLATE_COORDINATE_FILENAME} 是唯一模板坐标；严格使用其 catalogCandidateId、providerSlug、sourceSubdirectory、sourceAssetId、sourceArchiveSha256，从源码确定入口，禁止改选或重设计。`,
      attachment: {
        filename: FRONTMIND_SELECTED_TEMPLATE_COORDINATE_FILENAME,
        mime_type: "application/json",
        file_data: `data:application/json;base64,${bytes.toString("base64")}`,
      } as const,
    };
  }
  if (
    source.bundle.schemaVersion !== 6 ||
    !("sourceFormat" in source.candidate)
  ) {
    return null;
  }
  const manifest =
    source.candidate.sourceFormat === "provider_archive_v1" &&
    "sourceFormat" in source.manifest &&
    source.manifest.sourceFormat === "provider_archive_v1"
      ? nativeTemplateCoordinateV1Schema.parse({
          schemaVersion: 1,
          sourceFormat: "provider_archive_v1",
          providerTemplateId: source.manifest.providerTemplateId,
          providerSlug: source.manifest.providerSlug,
          providerVersion: source.manifest.providerVersion,
          sourceSubdirectory: source.manifest.sourceSubdirectory,
          framework: source.manifest.framework,
          entrypoint: source.manifest.entrypoint,
          providerArchiveSha256: source.manifest.providerArchiveSha256,
          sourceTreeSha256: source.manifest.sourceTreeSha256,
        })
      : source.candidate.sourceFormat === "normalized_v1" &&
          !("sourceFormat" in source.manifest)
        ? normalizedNativeTemplateCoordinateV1Schema.parse({
            schemaVersion: 1,
            sourceFormat: "normalized_v1",
            providerTemplateId: source.candidate.providerTemplateId,
            providerSlug: source.candidate.providerSlug,
            providerVersion: source.candidate.providerVersion,
            sourceDirectory: source.candidate.sourceDirectory,
            framework: source.candidate.framework,
            entrypoint: source.candidate.entrypoint,
            sourceArchiveSha256: source.candidate.sourceArchiveSha256,
            sourceTreeSha256: source.candidate.sourceTreeSha256,
          })
        : null;
  if (!manifest) return null;
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  return {
    manifest,
    promptInstruction:
      manifest.sourceFormat === "provider_archive_v1"
        ? `${FRONTMIND_SELECTED_TEMPLATE_COORDINATE_FILENAME} 是所选完整 Template 的唯一执行坐标。必须只使用其中指定的 providerSlug、sourceSubdirectory 和 entrypoint；即使源码 ZIP 同时包含同一仓库的其他模板，也必须全部忽略，不得自行选择相邻模板或仓库默认首页。`
        : `${FRONTMIND_SELECTED_TEMPLATE_COORDINATE_FILENAME} 是所选完整 Template 的唯一执行坐标。源码 ZIP 已由 FrontMind 从该精确模板完成标准化和 production build 验证；必须使用其中指定的 providerSlug、sourceDirectory 和 entrypoint，不得改选其他模板或重新设计。`,
    attachment: {
      filename: FRONTMIND_SELECTED_TEMPLATE_COORDINATE_FILENAME,
      mime_type: "application/json",
      file_data: `data:application/json;base64,${bytes.toString("base64")}`,
    } as const,
  };
}

const MANUS_INLINE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const NATIVE_SOURCE_PROVIDER_FILENAME =
  "frontmind-selected-21st-source-v1.zip" as const;
const NATIVE_SOURCE_PROVIDER_MINIMUM_USABLE_SECONDS = 15 * 60;

export function nativeSourceAttachmentTransport(byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new Error("NATIVE_SOURCE_ATTACHMENT_SIZE_INVALID");
  }
  return byteLength <= MANUS_INLINE_ATTACHMENT_MAX_BYTES
    ? ("inline" as const)
    : ("provider_file" as const);
}

function nativeSourceInlineAttachment(source: NativeSelection) {
  const archiveBytes = nativeSelectionInlineBytes(source);
  if (source.bundle.schemaVersion === 6) {
    assertVisualSelectionBundleV6SourceArchiveSize(archiveBytes);
  }
  if (
    nativeSourceAttachmentTransport(nativeSelectionByteLength(source)) !==
    "inline"
  ) {
    throw new Error("NATIVE_SOURCE_REQUIRES_PROVIDER_FILE_UPLOAD");
  }
  return {
    filename: NATIVE_SOURCE_PROVIDER_FILENAME,
    mime_type: "application/zip",
    file_data: `data:application/zip;base64,${archiveBytes.toString("base64")}`,
  } as const;
}

function nativeBrandAttachment(
  brandAsset: Awaited<
    ReturnType<typeof readSelectedOfficialLogoFromKnowledgeArchive>
  >,
) {
  if (!brandAsset) return [];
  const extension =
    brandAsset.mimeType === "image/jpeg"
      ? "jpg"
      : brandAsset.mimeType === "image/svg+xml"
        ? "svg"
        : brandAsset.mimeType.split("/")[1];
  return [
    {
      filename: `verified-company-logo.${extension}`,
      mime_type: brandAsset.mimeType,
      file_data: `data:${brandAsset.mimeType};base64,${brandAsset.bytes.toString(
        "base64",
      )}`,
    },
  ];
}

export function nativeSourceSystemPromptForWorkflow(workflowVersion: string) {
  if (workflowVersion === SITEOPS_MATERIALIZER_V2_9.frontMindVersion) {
    return `你是生产级企业官网的前端、内容与构建工程师。返回完整可构建源码 ZIP，不返回 diff、解释或思考过程。

执行合同：
1. Template ZIP 是唯一源码与视觉基线；保留组件、布局和响应式风格，只做内容与静态运行所需修改，不得重设计。
2. ${SITEOPS_CONTENT_PLAN_V2_FILENAME} 给出完整 route manifest 与内容坐标；按其 routes.path 生成页面。企业事实只取 dossier、冻结计划、客户反馈和已验证媒体，删除模板品牌、演示文案、占位资源及外部链接，不得编造。
3. 导航和有目标 CTA 使用计划内规范路径的真实 <a href>，可见链接文字必须包含计划 cta.label。计划图片使用可信 publicUrl 和非空 alt。
4. 不得加入认证、支付、数据库、后台、统计、webhook、外部脚本、远程请求、远程资源、动态执行或动态 import。
5. 输出 FrontMind Vite SPA；保留 execution shell，在 ${NATIVE_RUNTIME_ROUTE_MODULE} 用 eager static import 导出 ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT}。多页初始化与 popstate 调用 window.canonicalSitePathname()；仅函数不存在时回退 window.location.pathname。每个包含 JSX 的模块都必须显式绑定或 import React。
6. 运行 production build 和 ${NATIVE_SOURCE_PREFLIGHT_V2_FILENAME}，逐路由确认无 pageerror、console.error 和空白 root。只交付 ${FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME} 与 ${FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME}。`;
  }
  if (workflowVersion === SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION) {
    return TWENTY_FIRST_STATIC_TEMPLATE_V2_8_SYSTEM_PROMPT;
  }
  return workflowVersion === SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION
    ? TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT
    : TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT;
}

function siteContentPlanPrompt(input: {
  operationToken: string;
  inventorySha256: string;
  hasRevisionBaseline?: boolean;
  repairIssues?: readonly string[];
}) {
  const repair = input.repairIssues?.length
    ? `上一份计划未通过严格合同：${input.repairIssues.join(", ")}。这是唯一一次定向修复；返回完整替代计划，不得只返回补丁。`
    : "先完成信息架构计划，不得在本阶段改源码或生成网站 ZIP。";
  const revision = input.hasRevisionBaseline
    ? "这是连续修订。frontmind-parent-content-plan-v1.json 是父版本完整计划基线，coverage inventory 已累积此前 customer_revision 来源与冻结图片。只改变本轮客户明确要求涉及的页面、区块、路由或媒体；未涉及内容必须原样保留。若本轮明确删除或替代了历史来源，才可 omitted，并须给出具体原因。"
    : "";
  return promptWithMarker(
    `你是 FrontMind 官网信息架构师。完整企业事实只来自 frontmind-siteops-source-dossier-v1.json，完整覆盖清单只来自 frontmind-knowledge-coverage-inventory-v1.json。frontmind-site-content-plan-wire-v2-contract.json 是唯一输出字段合同，必须逐字段遵守。

除技术入口 / 必须存在外，页面数量、名称、层级、导航、页面合并拆分和详情页均由你根据知识资料决定；不得套用固定的关于、产品、案例、联系页面清单。最多 30 条规范小写 ASCII 尾斜杠路径，禁止 /api/、/dashboard/、/preview/、/internal/、/_frontmind/、/admin/。每个导航、父级、详情归属和 CTA 只能指向计划内路径。

每个公开相关文档必须恰好有一条 coverage：used 必须绑定实际 route/section 及原文逐字 evidenceExcerpt；不相关资料可 omitted，但必须给出具体理由。案例、新闻、价格、资质和客户评价只能在存在对应来源时规划。必须使用 inventory 中真实 entity、faq、media 坐标。${revision}

SiteContentPlanWireV2 必须是以下精确扁平形状，不得省略任何字段：
- 顶层仅允许 wireSchemaVersion、operationToken、inventorySha256、routes、sections、navigation、coverage。wireSchemaVersion 必须为 2，operationToken 必须精确为 ${input.operationToken}，inventorySha256 必须精确为 ${input.inventorySha256}。
- routes 每项仅允许 routeId、path、title、navigation、parentPath、detailOfPath、purpose、userQuestions、h1、summary、ctaLabel、ctaTargetPath；routes 内绝对不得嵌套 sections。无父级/详情归属/CTA 时相应字段显式为 null。
- sections 是独立顶层数组，每项仅允许 routeId、sectionId、blockKind、heading、purpose、body、sourceDocumentIds、evidenceExcerpts、mediaIds、entityIds、faqIds。sourceDocumentIds 与 evidenceExcerpts 按下标一一对应。
- 每个 section（包括 hero、CTA 和纯结构区块）的 sourceDocumentIds 与 evidenceExcerpts 都必须至少各有一项；若区块无法绑定逐字来源，就合并进有来源的区块或省略该区块，绝不能输出空来源数组。
- navigation 每项仅允许 label、targetPath。coverage 每项仅允许 sourceDocumentId、status、routeIds、omissionReason；used 时 routeIds 非空且 omissionReason=null，omitted 时 routeIds=[] 且 omissionReason 为具体字符串。

严禁自创替代 schema 或别名：不得使用 schemaVersion、pages、routeManifest、blocks、coverages、menu、navItems；routes 项不得使用 id、slug、children、navOrder 或嵌套 sections；sections 项不得使用 id、sourceBindings、sources 或 evidence；coverage 项不得使用 documentId、routes 或 reason。只有允许为空的集合才输出 []；section 的来源与摘录数组不得为空。可空坐标必须输出 null，不得改名或删字段。${repair}

只返回 SiteContentPlanWireV2 扁平 JSON，并把完全相同对象附加为 ${SITEOPS_CONTENT_PLAN_V2_FILENAME}；不得返回源码、ZIP、解释、外部资料或未知事实。`,
    input.operationToken,
  );
}

function siteContentPlanSchemaRepairIssues(error: unknown) {
  if (!(error instanceof z.ZodError)) return [];
  return [
    ...new Set(
      error.issues.slice(0, 16).map((issue) => {
        const path = issue.path
          .map((segment) => String(segment).replace(/[^A-Za-z0-9_-]/gu, ""))
          .filter(Boolean)
          .join(".");
        return `CONTENT_PLAN_SCHEMA_${issue.code.toUpperCase()}@${path || "root"}`;
      }),
    ),
  ];
}

const SITEOPS_CONTENT_PLAN_WIRE_V2_CONTRACT_FILENAME =
  "frontmind-site-content-plan-wire-v2-contract.json" as const;

function siteContentPlanWireContractAttachment(input: {
  operationToken: string;
  inventorySha256: string;
  sourceDocumentIds: readonly string[];
}) {
  const sourceDocumentIds = [...new Set(input.sourceDocumentIds)];
  const contract = {
    contractName: "SiteContentPlanWireV2",
    contractRevision: 2,
    outputFilename: SITEOPS_CONTENT_PLAN_V2_FILENAME,
    coordinates: {
      operationToken: input.operationToken,
      inventorySha256: input.inventorySha256,
      sourceDocumentIds,
    },
    shapeRules: {
      exactTopLevelFields: [
        "wireSchemaVersion",
        "operationToken",
        "inventorySha256",
        "routes",
        "sections",
        "navigation",
        "coverage",
      ],
      sectionsAreTopLevelAndFlat: true,
      everySectionHasAtLeastOneVerbatimSource: true,
      everySourceDocumentMustAppearExactlyOnceInCoverage: true,
      additionalPropertiesAllowed: false,
    },
    jsonSchema: siteContentPlanOutputSchema({
      operationToken: input.operationToken,
      inventorySha256: input.inventorySha256,
    }),
  };
  const bytes = Buffer.from(`${canonicalJson(contract)}\n`, "utf8");
  return {
    filename: SITEOPS_CONTENT_PLAN_WIRE_V2_CONTRACT_FILENAME,
    mime_type: "application/json",
    file_data: `data:application/json;base64,${bytes.toString("base64")}`,
  } as const;
}

function siteContentPlanAttachment(plan: SiteContentPlanV2) {
  const bytes = Buffer.from(`${canonicalJson(plan)}\n`, "utf8");
  return {
    filename: SITEOPS_CONTENT_PLAN_V2_FILENAME,
    mime_type: "application/json",
    file_data: `data:application/json;base64,${bytes.toString("base64")}`,
  } as const;
}

const NATIVE_RUNTIME_DIAGNOSTICS_FILENAME =
  "frontmind-native-runtime-diagnostics-v1.json" as const;

function nativeRuntimeDiagnosticsAttachment(repair: NativeSourceRepairInput) {
  const bytes = Buffer.from(
    `${canonicalJson({
      schemaVersion: 1,
      attempt: repair.attempt,
      kind: repair.kind,
      diagnostics: repair.diagnostics.slice(0, 32),
    })}\n`,
    "utf8",
  );
  return {
    filename: NATIVE_RUNTIME_DIAGNOSTICS_FILENAME,
    mime_type: "application/json",
    file_data: `data:application/json;base64,${bytes.toString("base64")}`,
  } as const;
}

export function nativeSourcePrompt(input: {
  operationToken: string;
  baseSourceSha256: string;
  contractVersion: 1 | 2;
  runtimeCoordinates: NativeSourceRuntimeCoordinates | null;
  workflowVersion: string;
  hasCustomerFeedback?: boolean;
  hasRevisionMedia?: boolean;
  hasRevisionBaseline?: boolean;
  hasKnowledgeMedia?: boolean;
  templateCoordinateInstruction?: string;
  repair?: NativeSourceRepairInput;
  contentPlanSha256?: string;
}) {
  if (input.contractVersion === 2 && !input.runtimeCoordinates) {
    throw new Error("NATIVE_SOURCE_RUNTIME_COORDINATES_MISSING");
  }
  const systemPrompt = input.repair
    ? input.workflowVersion === SITEOPS_MATERIALIZER_V2_9.frontMindVersion
      ? "继续同一 FrontMind AI 建站任务。本轮只修复上一份源码，不重新设计；原任务的视觉、冻结计划、内容和事实边界继续有效。一次修完诊断附件全部问题。全局导航和有目标 CTA 必须是真实规范 <a href>，可见链接文字须包含计划标签且允许保留不改变含义的模板装饰。多页初始化与 popstate 必须优先调用宿主 canonicalSitePathname，函数不存在时才回退 window.location.pathname。"
      : "继续同一 FrontMind AI 建站任务。本轮只修复上一份源码，不是重新设计；原任务中的视觉、内容和事实边界继续有效。"
    : nativeSourceSystemPromptForWorkflow(input.workflowVersion);
  const repair = input.repair
    ? `\n\n上一份源码未通过${input.repair.kind === "compile" ? "本地编译" : "运行合同或硬安全检查"}。只按 ${NATIVE_RUNTIME_DIAGNOSTICS_FILENAME} 一次性修复全部坐标；不得重新设计或复用失败输出。以本消息重新附加的源码与执行基线为准，重跑 preflight 和 production build，并逐条打开 route manifest 的全部路由确认无 pageerror、console.error 或空白 root；execution shell 未声明 automatic JSX runtime 时，每个包含 JSX 的模块都必须显式绑定或 import React。返回完整源码 ZIP。`
    : "";
  const deliveryContract =
    input.contractVersion === 2
      ? "Receipt 必须符合 Structured Output schema 且 preflightStatus=passed；archiveSha256 必须对应最终 ZIP；fileCount 必须填写最终 ZIP 的非目录文件条目数（不计目录项）。"
      : `交付前必须运行 ${NATIVE_SOURCE_PREFLIGHT_FILENAME} 并通过 package、文件类型、依赖、源码语法和 production build 自检。Receipt 必须严格包含当前 operationToken、baseSourceSha256=${input.baseSourceSha256}、最终 ZIP 的 archiveSha256、实际 fileCount、preflightVersion=${NATIVE_SOURCE_PREFLIGHT_VERSION}、preflightStatus=passed、preflightSha256=${NATIVE_SOURCE_PREFLIGHT_SHA256}。`;
  return promptWithMarker(
    `${systemPrompt}

frontmind-siteops-source-dossier-v1.json 是唯一企业事实来源；源码 ZIP 是唯一视觉与组件基线，baseSourceSha256=${input.baseSourceSha256}。不得采用附件之外的企业事实、媒体、依赖或外部资源。

${input.templateCoordinateInstruction ?? ""}

${input.hasCustomerFeedback ? "客户要求见 frontmind-customer-feedback-v1.json；仅在知识与原生样式边界内实现。" : ""}

${input.hasRevisionMedia ? "本轮图片见 frontmind-user-media-manifest-v1.json，且已由 FrontMind 写入源码 public/frontmind-user-media。必须在客户要求指定的页面中使用清单 publicUrl；不得改写、转码或引用外部副本。" : ""}

${input.hasRevisionBaseline ? "这是连续修订：frontmind-parent-content-plan-v1.json 是父版本完整内容计划基线。只修改客户明确要求的部分，未涉及的路由、事实、内容结构与媒体必须原样保留；交付仍须形成一份完整网站。" : ""}

${input.hasKnowledgeMedia ? "内容计划选中的知识库图片见 frontmind-knowledge-media-manifest-v1.json，且可信原始字节已由 FrontMind 写入源码 public/frontmind-knowledge-media。必须按计划页面使用清单 publicUrl 与非空 alt；不得改写、转码或引用外部副本。" : ""}

${input.contentPlanSha256 ? `${SITEOPS_CONTENT_PLAN_V2_FILENAME} 已由 Dashboard 冻结，sha256=${input.contentPlanSha256}；它是唯一信息架构与内容覆盖合同。必须先逐项读取，再适配源码，route manifest 必须与其 routes.path 完全一致。` : ""}

${deliveryContract}只返回 ${FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME} 与 ${FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME} 各一份后结束；不得解释、浏览或更新计划。${repair}`,
    input.operationToken,
  );
}

function nativeCompileSignature(error: NativeReactBuildError) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        code: error.code,
        diagnostics: error.diagnostics.slice(0, 8).map((item) => ({
          code: item.code,
          file: item.file,
          line: item.line,
          column: item.column,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

const NATIVE_SOURCE_OUTPUT_UNAVAILABLE_CODE =
  "SITEOPS_NATIVE_SOURCE_OUTPUT_UNAVAILABLE" as const;
// Deliberately independent of provider status/event ids: once this delivery
// failure has consumed a repair attempt, later polls cannot turn it into a
// second source-delivery retry under a different terminal shape.
const NATIVE_SOURCE_OUTPUT_UNAVAILABLE_SIGNATURE = createHash("sha256")
  .update(
    JSON.stringify({ code: NATIVE_SOURCE_OUTPUT_UNAVAILABLE_CODE }),
    "utf8",
  )
  .digest("hex");

const NON_RETRYABLE_PROVIDER_QUOTA_ERROR_TYPES = new Set([
  "credit_exhausted",
  "credits_exhausted",
  "insufficient_credits",
  "quota_exceeded",
  "quota_limit",
  "usage_exhausted",
]);

function nativeSourceTerminalErrorType(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
) {
  const ordered = orderManusV2EventsByProviderRank(
    currentPhaseEvents(events, operationToken),
    "oldest_first",
  );
  let latestStatusIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const statusUpdate =
      ordered[index]!.status_update &&
      typeof ordered[index]!.status_update === "object" &&
      !Array.isArray(ordered[index]!.status_update)
        ? (ordered[index]!.status_update as Record<string, unknown>)
        : null;
    if (typeof statusUpdate?.agent_status !== "string") continue;
    latestStatusIndex = index;
    break;
  }

  // Bound the terminal error to the most recent execution episode. A source
  // task may recover from an earlier provider error and continue running in
  // the same phase; an error before that recovery must not suppress the one
  // permitted missing-output repair for a later, unrelated terminal.
  let precedingNonErrorStatusIndex = -1;
  for (let index = latestStatusIndex - 1; index >= 0; index -= 1) {
    const statusUpdate =
      ordered[index]!.status_update &&
      typeof ordered[index]!.status_update === "object" &&
      !Array.isArray(ordered[index]!.status_update)
        ? (ordered[index]!.status_update as Record<string, unknown>)
        : null;
    const status =
      typeof statusUpdate?.agent_status === "string"
        ? statusUpdate.agent_status.trim().toLowerCase()
        : "";
    if (!status || status === "error" || status === "failed") continue;
    precedingNonErrorStatusIndex = index;
    break;
  }

  let event: ManusV2MessageEvent | undefined;
  for (
    let index = ordered.length - 1;
    index > precedingNonErrorStatusIndex;
    index -= 1
  ) {
    if (ordered[index]!.type !== "error_message") continue;
    event = ordered[index];
    break;
  }
  const envelope =
    event?.error_message &&
    typeof event.error_message === "object" &&
    !Array.isArray(event.error_message)
      ? (event.error_message as Record<string, unknown>)
      : null;
  const errorType =
    typeof envelope?.error_type === "string"
      ? envelope.error_type.trim().toLowerCase()
      : "";
  return errorType && errorType.length <= 128 ? errorType : null;
}

const NATIVE_SOURCE_OFFLINE_RESUME_CHECKPOINTS = new Set([
  "archive_validated",
  "compile_started",
  "artifacts_staged",
]);

async function readNativeSourceOfflineResume(input: {
  operation: SiteOperation;
  state: ProviderState | null;
  operationToken: string;
  baseSourceSha256: string;
  expectedContentPlanSha256?: string;
  stagingAssetId: string;
  taskId: string;
  buildTaskId: string | null;
  repairAttempt: number;
  receiptSchema: z.ZodType<PersistedSiteSourceReceipt>;
  readArtifact: typeof readSiteOpsArtifact;
  now?: number;
}) {
  const state = input.state?.schemaVersion === 2 ? input.state : null;
  const staging = state?.nativeSourceStaging;
  if (
    !state ||
    !staging?.receipt ||
    !state.buildCheckpoint ||
    !NATIVE_SOURCE_OFFLINE_RESUME_CHECKPOINTS.has(state.buildCheckpoint)
  ) {
    return null;
  }
  const now = input.now ?? Date.now();
  let receipt: PersistedSiteSourceReceipt;
  try {
    receipt = input.receiptSchema.parse(staging.receipt);
  } catch {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
      "已暂存源码回执未通过严格结构与任务坐标校验。",
      "attention_required",
      state,
    );
  }
  if (
    staging.assetId !== input.stagingAssetId ||
    staging.sha256 !== receipt.archiveSha256 ||
    staging.taskId !== input.taskId ||
    staging.repairAttempt !== input.repairAttempt ||
    state.taskId !== input.taskId ||
    input.operation.providerTaskId !== input.taskId ||
    input.buildTaskId !== input.taskId ||
    receipt.operationToken !== input.operationToken ||
    receipt.baseSourceSha256 !== input.baseSourceSha256 ||
    (input.expectedContentPlanSha256 !== undefined &&
      (!("contentPlanSha256" in receipt) ||
        receipt.contentPlanSha256 !== input.expectedContentPlanSha256))
  ) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
      "已暂存源码与冻结任务回执坐标不一致，系统已停止采用该结果。",
      "attention_required",
      state,
    );
  }
  const claimedExpiry = Date.parse(staging.expiresAt);
  if (!Number.isFinite(claimedExpiry) || claimedExpiry <= now) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_EXPIRED",
      "已校验源码的 24 小时恢复窗口已结束，任务坐标已保留等待处理。",
      "attention_required",
      state,
    );
  }
  let artifact: Awaited<ReturnType<typeof readSiteOpsArtifact>>;
  try {
    artifact = await input.readArtifact({
      userId: input.operation.userId,
      localAssetId: input.stagingAssetId,
      expectedSha256: receipt.archiveSha256,
      expectedMimeTypes: [FRONTMIND_SITE_SOURCE_ARCHIVE_MIME],
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /^SITEOPS_ARTIFACT_(?:HASH|MIME)_MISMATCH$/u.test(error.message)
    ) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
        "已暂存源码文件与冻结任务回执坐标不一致，系统已停止采用该结果。",
        "attention_required",
        state,
      );
    }
    throw error;
  }
  if (!artifact) return null;
  const rowExpiry =
    artifact.row.retainUntil instanceof Date
      ? artifact.row.retainUntil.getTime()
      : Number.NaN;
  if (!Number.isFinite(rowExpiry) || rowExpiry <= now) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_EXPIRED",
      "已校验源码的 24 小时恢复窗口已结束，任务坐标已保留等待处理。",
      "attention_required",
      state,
    );
  }
  if (
    artifact.row.id !== staging.assetId ||
    artifact.row.mimeType !== FRONTMIND_SITE_SOURCE_ARCHIVE_MIME ||
    artifact.row.contentSha256 !== staging.sha256 ||
    artifact.row.sizeBytes !== staging.bytes ||
    artifact.stored.sizeBytes !== staging.bytes
  ) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
      "已暂存源码文件与冻结任务回执坐标不一致，系统已停止采用该结果。",
      "attention_required",
      state,
    );
  }
  let archive: Buffer;
  try {
    archive = await storedArtifactBytes(
      artifact,
      NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes,
    );
  } catch (error) {
    if (!(error instanceof SiteOpsManusFailure)) throw error;
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
      "已暂存源码文件未通过完整性校验，系统已停止采用该结果。",
      "attention_required",
      state,
    );
  }
  if (archive.length !== staging.bytes || sha256(archive) !== staging.sha256) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
      "已暂存源码文件未通过哈希校验，系统已停止采用该结果。",
      "attention_required",
      state,
    );
  }
  return {
    archive,
    receipt,
    expiresAt: new Date(Math.min(claimedExpiry, rowExpiry)),
  };
}

export const NATIVE_TRUSTED_FALLBACK_READ_DELAY_MS = 15 * 60_000;

export type NativeTrustedFallbackReason =
  | "initial_baseline"
  | "repair_budget_exhausted"
  | "provider_stopped_without_result"
  | "provider_read_delayed";

/** The fallback is deliberately unavailable to revisions or builds that
 * already have a preview. A single transient read never crosses this gate. */
export function nativeTrustedFallbackReason(input: {
  firstBuild: boolean;
  hasPreview: boolean;
  repairBudgetExhausted?: boolean;
  initialBaseline?: boolean;
  stoppedGraceExpired?: boolean;
  providerReadFailureSince?: string;
  nativeSourceReadFailureSince?: string;
  now?: number;
}): NativeTrustedFallbackReason | null {
  if (!input.firstBuild || input.hasPreview) return null;
  if (input.initialBaseline) return "initial_baseline";
  if (input.repairBudgetExhausted) return "repair_budget_exhausted";
  if (input.stoppedGraceExpired) return "provider_stopped_without_result";
  const since = Math.min(
    ...[input.providerReadFailureSince, input.nativeSourceReadFailureSince]
      .map((value) => Date.parse(value ?? ""))
      .filter(Number.isFinite),
  );
  if (
    Number.isFinite(since) &&
    (input.now ?? Date.now()) - since >= NATIVE_TRUSTED_FALLBACK_READ_DELAY_MS
  ) {
    return "provider_read_delayed";
  }
  return null;
}

export function nativeTrustedFallbackReconcileUntil(input: {
  providerReadFailureSince?: string;
  nativeSourceReadFailureSince?: string;
  providerSyncStartedAt?: string;
  resultPendingSince?: string;
  providerStoppedAt?: string;
  fallbackTriggeredAt?: Date | string;
  operationStartedAt?: Date | string | null;
  operationCreatedAt: Date | string;
}) {
  const activeWindowTimestamps = [
    input.providerReadFailureSince,
    input.nativeSourceReadFailureSince,
    input.providerSyncStartedAt,
    input.resultPendingSince,
    input.providerStoppedAt,
  ]
    .map((value) => Date.parse(String(value ?? "")))
    .filter(Number.isFinite);
  const fallbackTriggeredAt =
    input.fallbackTriggeredAt instanceof Date
      ? input.fallbackTriggeredAt.getTime()
      : Date.parse(String(input.fallbackTriggeredAt ?? ""));
  const fallbackTimestamps = (
    Number.isFinite(fallbackTriggeredAt)
      ? [fallbackTriggeredAt]
      : [input.operationStartedAt, input.operationCreatedAt]
  )
    .map((value) =>
      typeof value === "number"
        ? value
        : value instanceof Date
          ? value.getTime()
          : Date.parse(String(value ?? "")),
    )
    .filter(Number.isFinite);
  const startedAt = Math.min(
    ...(activeWindowTimestamps.length > 0
      ? activeWindowTimestamps
      : fallbackTimestamps),
  );
  if (!Number.isFinite(startedAt)) {
    throw new Error("NATIVE_FALLBACK_RECONCILIATION_ANCHOR_MISSING");
  }
  return new Date(startedAt + MANUS_PROVIDER_READ_RECONCILIATION_MS);
}

function nativeTrustedFallbackAttentionReason(input: {
  state: ProviderState | null;
  operation: SiteOperation;
  now?: number;
}) {
  const state = providerStateV2(input.state);
  const now = input.now ?? Date.now();
  const reconcileUntil = nativeTrustedFallbackReconcileUntil({
    providerReadFailureSince: state.providerReadFailureSince,
    nativeSourceReadFailureSince: state.nativeSourceReadFailureSince,
    providerSyncStartedAt: state.providerSyncStartedAt,
    resultPendingSince: state.resultPendingSince,
    providerStoppedAt: state.providerStoppedAt,
    operationStartedAt: input.operation.startedAt,
    operationCreatedAt: input.operation.createdAt,
  }).getTime();
  if (now >= reconcileUntil) return null;
  const readSince = Math.min(
    ...[state.providerReadFailureSince, state.nativeSourceReadFailureSince]
      .map((value) => Date.parse(value ?? ""))
      .filter(Number.isFinite),
  );
  if (
    Number.isFinite(readSince) &&
    now - readSince >= NATIVE_TRUSTED_FALLBACK_READ_DELAY_MS
  ) {
    return "provider_read_delayed" as const;
  }
  const stoppedAt = Date.parse(
    state.resultPendingSince ?? state.providerStoppedAt ?? "",
  );
  if (
    Number.isFinite(stoppedAt) &&
    now - stoppedAt >= MANUS_PROVIDER_STOPPED_GRACE_MS
  ) {
    return "provider_stopped_without_result" as const;
  }
  return null;
}

const NATIVE_TRUSTED_FALLBACK_WARNING_CODES = {
  initial_baseline: "NATIVE_INITIAL_BASELINE_TRUSTED_FALLBACK",
  repair_budget_exhausted: "NATIVE_REPAIR_BUDGET_TRUSTED_FALLBACK",
  provider_stopped_without_result: "NATIVE_STOPPED_TRUSTED_FALLBACK",
  provider_read_delayed: "NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK",
} as const satisfies Record<NativeTrustedFallbackReason, string>;

export function shouldMaterializeNativeInitialBaseline(input: {
  bundleSchemaVersion: number;
  parentBuildId: string | null;
  hasPreview: boolean;
  hasFallback: boolean;
  nativeRepairAttempt: number;
}) {
  return (
    input.bundleSchemaVersion === 6 &&
    input.parentBuildId === null &&
    !input.hasPreview &&
    !input.hasFallback &&
    input.nativeRepairAttempt === 0
  );
}

export function nativeInitialBaselineShouldYield(state: ProviderState | null) {
  return Boolean(state?.schemaVersion === 2 && state.fallbackPreview);
}

function nativeFallbackReferenceBlueprint(input: {
  selection: NativeSelection;
  taxonomy: z.infer<typeof visualTaxonomySchema>;
  visualEvidence: z.infer<typeof visualEvidenceV1Schema>;
}) {
  // A-I is only a page position for native bundles and must never be treated
  // as a visual-family coordinate. Every fallback keeps one neutral host
  // structure. V6 may refine only bounded palette/type/density coordinates
  // which were independently frozen against both preview and source hashes.
  const heroFamily = "centered_dual_cta" as const;
  if (isStaticNativeSelection(input.selection)) {
    throw new Error("STATIC_TEMPLATE_TRUSTED_FALLBACK_UNSUPPORTED");
  }
  if (isVisualSelectionBundleV5(input.selection.bundle)) {
    const candidate = input.selection.bundle.candidates.find(
      (item) => item.id === input.selection.candidate.id,
    );
    if (!candidate) throw new Error("NATIVE_FALLBACK_VISUAL_MISSING");
    return referenceBlueprintV4ForFamily({
      candidateId: candidate.id,
      providerItemKey: candidate.providerItemKey,
      referencePreviewLocalAssetId: candidate.referencePreviewLocalAssetId,
      referencePreviewSha256: candidate.referencePreviewSha256,
      realizationPreviewLocalAssetId: candidate.previewLocalAssetId,
      realizationPreviewSha256: candidate.previewSha256,
      heroFamily,
      inspirationEvidenceId: input.visualEvidence.evidenceSha256,
      inspirationTaxonomy: input.taxonomy,
    });
  }
  const candidate = input.selection.bundle.candidates.find(
    (item) => item.id === input.selection.candidate.id,
  );
  if (!candidate) throw new Error("NATIVE_FALLBACK_VISUAL_MISSING");
  const previewBlueprint = nativeFallbackPreviewBlueprint(
    candidate.styleTokens,
  );
  return referenceBlueprintV3ForFamily({
    candidateId: candidate.id,
    providerItemKey: input.visualEvidence.providerItemKey,
    previewLocalAssetId: candidate.previewLocalAssetId,
    previewSha256: candidate.previewSha256,
    heroFamily,
    inspirationEvidenceIds: [input.visualEvidence.evidenceSha256],
    previewBlueprint,
  });
}

/** Project only the bounded style-token contract into a fixed neutral host
 * family. Raw CSS, template text, page labels and provider source never enter
 * this projection. Historical V6 candidates without tokens stay neutral. */
export function nativeFallbackPreviewBlueprint(
  styleTokens?: VisualCandidateStyleTokensV1,
) {
  const heroFamily = "centered_dual_cta" as const;
  if (!styleTokens) return trustedVisualPreviewBlueprintV3(heroFamily);
  const colorTaxonomy = visualTaxonomySchema.parse({
    role: "foundation",
    palette: [
      styleTokens.dominantHex,
      styleTokens.canvasTone === "dark" ? "dark-canvas" : "light-canvas",
      styleTokens.contrast === "high"
        ? "high-contrast"
        : styleTokens.contrast === "low"
          ? "muted-palette"
          : "single-accent",
    ],
    typography: [],
    layout: [],
    motion: [],
    accessibility: [],
  });
  const projected = trustedVisualPreviewBlueprintV3(heroFamily, [
    colorTaxonomy,
  ]);
  const typeSystem =
    styleTokens.typeSystem === "unknown"
      ? projected.typeSystem
      : styleTokens.typeSystem;
  return {
    ...projected,
    typeSystem,
    density: styleTokens.density,
    typographyStyle:
      typeSystem === "editorial_serif"
        ? ("editorial" as const)
        : typeSystem === "technical_sans"
          ? ("technical" as const)
          : typeSystem === "humanist_sans"
            ? ("restrained" as const)
            : ("display" as const),
  };
}

async function handleNativeReactSiteBuild(input: {
  db: any;
  operation: SiteOperation;
  signal: AbortSignal;
  assertExecutionActive: () => Promise<void>;
  client: ManusV2Client | null;
  getClient: () => Promise<ManusV2Client>;
  input: z.infer<typeof operationInputSchema>;
  state: ProviderState | null;
  context: Awaited<ReturnType<typeof loadBuildContext>>;
  brief: z.infer<typeof siteBriefSchema>;
  documents: ReturnType<typeof safePublicDocuments>;
  visualEvidence: z.infer<typeof visualEvidenceV1Schema>;
  taxonomy: z.infer<typeof visualTaxonomySchema>;
  brandAsset: Awaited<
    ReturnType<typeof readSelectedOfficialLogoFromKnowledgeArchive>
  >;
  knowledgeArchiveBytes: Buffer;
  nativeSelection: NativeSelection;
  materializeNative: typeof materializeNativeReactSource;
  materializeNativeFallback: typeof materializeNativeTrustedFallbackSite;
  nativeSourceRuntimeRegistry: NativeSourceRuntimeRegistry;
  assetDecisions: ReturnType<typeof frozenAssetDecisions>;
  persist: typeof persistSiteOpsArtifact;
  readArtifact: typeof readSiteOpsArtifact;
}): Promise<SiteOpsProviderResult> {
  let client = input.client;
  const attempt = input.state?.nativeRepairAttempt ?? 0;
  let currentState = input.state;
  const operationToken = `siteops-native-source:${input.operation.id}:${attempt}`;
  let revisionSource: {
    bytes: Buffer;
    sha256: string;
    media: SiteOpsRevisionLineageMedia[];
    attachments: ManusV2Attachment[];
  } | null = null;
  let inheritedRevisionDocuments: SupplementalKnowledgeDocument[] = [];
  let currentRevisionMediaPlanIds: string[] = [];
  const currentRevisionSourceDocumentId = input.input.feedback
    ? `customer-revision:${input.operation.id}`
    : null;
  const revisionBaseline = input.input.revisionBaseline;
  const revisionInputAssets = input.input.revisionInputAssets;
  if (input.context.build.parentBuildId) {
    if (
      input.context.build.workflowVersion !== "2.9.0" ||
      !revisionBaseline ||
      revisionBaseline.parentBuildId !== input.context.build.parentBuildId
    ) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_BASE_MISSING",
        "连续修订缺少已冻结的父版本源码坐标。",
        "failed",
      );
    }
    const parentRows = await input.db
      .select()
      .from(siteBuilds)
      .where(
        and(
          eq(siteBuilds.id, revisionBaseline.parentBuildId),
          eq(siteBuilds.projectId, input.operation.projectId),
          eq(siteBuilds.userId, input.operation.userId),
          gte(siteBuilds.createdAt, input.context.project.currentTaskStartedAt),
        ),
      )
      .limit(1);
    const parent = parentRows[0] as typeof siteBuilds.$inferSelect | undefined;
    if (
      !parent ||
      parent.sourceLocalAssetId !== revisionBaseline.sourceLocalAssetId ||
      parent.sourceHash !== revisionBaseline.sourceSha256 ||
      parent.contentPlanLocalAssetId !==
        revisionBaseline.contentPlanLocalAssetId ||
      parent.contentPlanSha256 !== revisionBaseline.contentPlanSha256
    ) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_BASE_COORDINATES_MISMATCH",
        "父版本源码或内容计划坐标与当前修订不一致。",
        "failed",
      );
    }
    const inputRows = await input.db
      .select()
      .from(siteBuildInputAssets)
      .where(
        and(
          eq(siteBuildInputAssets.buildId, input.context.build.id),
          eq(siteBuildInputAssets.projectId, input.operation.projectId),
          eq(siteBuildInputAssets.userId, input.operation.userId),
          eq(
            siteBuildInputAssets.taskStartedAt,
            input.context.project.currentTaskStartedAt,
          ),
          input.context.project.knowledgeInputEpochId
            ? eq(
                siteBuildInputAssets.siteOpsKnowledgeInputEpochId,
                input.context.project.knowledgeInputEpochId,
              )
            : isNull(siteBuildInputAssets.siteOpsKnowledgeInputEpochId),
        ),
      );
    if (inputRows.length !== revisionInputAssets.length) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_MEDIA_COORDINATES_MISMATCH",
        "修订图片与当前版本的冻结坐标不一致。",
        "failed",
      );
    }
    const rowByAsset = new Map<
      string,
      typeof siteBuildInputAssets.$inferSelect
    >();
    for (const row of inputRows as Array<
      typeof siteBuildInputAssets.$inferSelect
    >) {
      rowByAsset.set(row.localAssetId, row);
    }
    if (rowByAsset.size !== inputRows.length) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_MEDIA_COORDINATES_MISMATCH",
        "修订图片与当前版本的冻结坐标不一致。",
        "failed",
      );
    }
    const media: SiteOpsRevisionMedia[] = [];
    for (const [index, descriptor] of revisionInputAssets.entries()) {
      const row = rowByAsset.get(descriptor.localAssetId);
      if (
        !row ||
        row.ordinal !== index + 1 ||
        row.filename !== descriptor.filename ||
        row.mimeType !== descriptor.mimeType ||
        row.sizeBytes !== descriptor.sizeBytes ||
        row.contentSha256 !== descriptor.contentSha256 ||
        row.width !== descriptor.width ||
        row.height !== descriptor.height ||
        row.publicPath !== descriptor.publicPath ||
        row.siteOpsKnowledgeInputEpochId !==
          descriptor.siteOpsKnowledgeInputEpochId ||
        row.siteOpsKnowledgeInputEpochId !==
          input.context.project.knowledgeInputEpochId ||
        row.taskStartedAt.getTime() !==
          input.context.project.currentTaskStartedAt.getTime()
      ) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_REVISION_MEDIA_COORDINATES_MISMATCH",
          "修订图片与当前版本的冻结坐标不一致。",
          "failed",
        );
      }
      const artifact = await input.readArtifact({
        userId: input.operation.userId,
        localAssetId: descriptor.localAssetId,
        expectedSha256: descriptor.contentSha256,
        expectedMimeTypes: [descriptor.mimeType],
      });
      if (!artifact) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_REVISION_MEDIA_UNAVAILABLE",
          "修订图片的稳定副本不可用。",
          "failed",
        );
      }
      const bytes = await storedArtifactBytes(
        artifact,
        NATIVE_SOURCE_DEFAULT_LIMITS.maxSingleFileBytes,
      );
      media.push({ ...descriptor, bytes });
    }
    currentRevisionMediaPlanIds = media.map((asset) =>
      siteOpsCustomerMediaPlanId(asset.publicPath),
    );
    const parentArtifact = await input.readArtifact({
      userId: input.operation.userId,
      localAssetId: revisionBaseline.sourceLocalAssetId,
      expectedSha256: revisionBaseline.sourceSha256,
      expectedMimeTypes: [FRONTMIND_SITE_SOURCE_ARCHIVE_MIME],
    });
    if (!parentArtifact) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_BASE_UNAVAILABLE",
        "父版本源码稳定副本不可用。",
        "failed",
      );
    }
    const parentSource = await storedArtifactBytes(
      parentArtifact,
      NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes,
    );
    const parentPlanArtifact = await input.readArtifact({
      userId: input.operation.userId,
      localAssetId: revisionBaseline.contentPlanLocalAssetId,
      expectedSha256: revisionBaseline.contentPlanSha256,
      expectedMimeTypes: ["application/json"],
    });
    if (!parentPlanArtifact) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_PLAN_UNAVAILABLE",
        "父版本内容计划稳定副本不可用。",
        "failed",
      );
    }
    const parentPlanBytes = await storedArtifactBytes(
      parentPlanArtifact,
      4 * 1024 * 1024,
    );
    try {
      JSON.parse(parentPlanBytes.toString("utf8"));
    } catch {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_PLAN_INVALID",
        "父版本内容计划无法作为连续修订基线。",
        "failed",
      );
    }
    const inheritedLineage = await loadInheritedSiteOpsRevisionLineage({
      db: input.db,
      operation: input.operation,
      build: input.context.build,
      taskStartedAt: input.context.project.currentTaskStartedAt,
      knowledgeInputEpochId: input.context.project.knowledgeInputEpochId,
      readArtifact: input.readArtifact,
    });
    inheritedRevisionDocuments = inheritedLineage.documents;
    const cumulativeMedia = new Map<string, SiteOpsRevisionLineageMedia>();
    for (const asset of inheritedLineage.media) {
      const existing = cumulativeMedia.get(asset.publicPath);
      if (
        existing &&
        (existing.contentSha256 !== asset.contentSha256 ||
          existing.mimeType !== asset.mimeType ||
          existing.sizeBytes !== asset.sizeBytes)
      ) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_REVISION_LINEAGE_MEDIA_CONFLICT",
          "连续修订的图片路径与冻结内容发生冲突。",
          "failed",
        );
      }
      cumulativeMedia.set(asset.publicPath, {
        ...(existing ?? asset),
        sourceDocumentIds: [
          ...new Set([
            ...(existing?.sourceDocumentIds ?? []),
            ...asset.sourceDocumentIds,
          ]),
        ],
      });
    }
    for (const asset of media) {
      if (!currentRevisionSourceDocumentId) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_REVISION_FEEDBACK_MISSING",
          "本轮修订缺少可冻结的客户要求来源。",
          "failed",
        );
      }
      const existing = cumulativeMedia.get(asset.publicPath);
      if (
        existing &&
        (existing.contentSha256 !== asset.contentSha256 ||
          existing.mimeType !== asset.mimeType ||
          existing.sizeBytes !== asset.sizeBytes)
      ) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_REVISION_LINEAGE_MEDIA_CONFLICT",
          "连续修订的图片路径与冻结内容发生冲突。",
          "failed",
        );
      }
      cumulativeMedia.set(asset.publicPath, {
        ...(existing ?? asset),
        sourceDocumentIds: [
          ...new Set([
            ...(existing?.sourceDocumentIds ?? []),
            currentRevisionSourceDocumentId,
          ]),
        ],
      });
    }
    const allMedia = [...cumulativeMedia.values()].sort((left, right) =>
      left.publicPath.localeCompare(right.publicPath, "en-US"),
    );
    // Reinstall the complete lineage from its immutable SiteOps artifacts.
    // The parent ZIP is still the sole source baseline, while this closes a
    // missing/corrupt historical-media gap before Manus receives it.
    const bytes = await overlaySiteOpsRevisionMedia(parentSource, allMedia);
    const preparedSha256 = sha256(bytes);
    const manifestBytes = Buffer.from(
      `${canonicalJson({
        schemaVersion: 1,
        parentBuildId: revisionBaseline.parentBuildId,
        parentSourceSha256: revisionBaseline.sourceSha256,
        preparedBaseSourceSha256: preparedSha256,
        files: allMedia.map((asset) => ({
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          contentSha256: asset.contentSha256,
          width: asset.width,
          height: asset.height,
          sourcePath: `public${asset.publicPath}`,
          publicUrl: asset.publicPath,
        })),
      })}\n`,
      "utf8",
    );
    revisionSource = {
      bytes,
      sha256: preparedSha256,
      media: allMedia,
      attachments: [
        {
          filename: "frontmind-user-media-manifest-v1.json",
          mime_type: "application/json",
          file_data: `data:application/json;base64,${manifestBytes.toString("base64")}`,
        },
        {
          filename: "frontmind-parent-content-plan-v1.json",
          mime_type: "application/json",
          file_data: `data:application/json;base64,${parentPlanBytes.toString("base64")}`,
        },
        ...media.map(
          (asset) =>
            ({
              filename: `frontmind-user-media-${asset.contentSha256}${path.posix.extname(asset.publicPath)}`,
              mime_type: asset.mimeType,
              file_data: `data:${asset.mimeType};base64,${asset.bytes.toString("base64")}`,
            }) satisfies ManusV2Attachment,
        ),
      ],
    };
  } else if (revisionBaseline || revisionInputAssets.length > 0) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_REVISION_COORDINATES_UNEXPECTED",
      "首轮建站不能携带父版本修订坐标。",
      "failed",
    );
  }
  let baseSourceSha256 =
    revisionSource?.sha256 ?? input.nativeSelection.archiveSha256;
  let sourceOverride = revisionSource
    ? { bytes: revisionSource.bytes, sha256: revisionSource.sha256 }
    : null;
  let requiredRevisionMedia: SiteOpsRevisionLineageMedia[] = [];
  let knowledgeMedia: TrustedSiteKnowledgeMedia[] = [];
  const knowledgeMediaRoutePaths = new Map<string, Set<string>>();
  const runtimeVisual = siteOpsRuntimeVisualEvidenceV1Schema.parse({
    queryHash: nativeSelectionQueryHash(input.nativeSelection),
    selectedCandidateId: input.context.sample.id,
    providerItemKey: input.visualEvidence.providerItemKey,
    visualEvidenceSha256: input.visualEvidence.evidenceSha256,
    previewSha256: input.visualEvidence.previewSha256,
    supportEvidenceSha256s: [],
    taxonomy: input.taxonomy,
  });
  const templateCoordinate = revisionSource
    ? null
    : nativeTemplateCoordinateDirective(input.nativeSelection);
  const dynamicInformationArchitecture =
    input.context.build.workflowVersion ===
    SITEOPS_MATERIALIZER_V2_9.frontMindVersion;
  let taskId =
    input.state?.taskId ?? input.operation.providerTaskId ?? undefined;
  const nativeSourceContractVersion: 1 | 2 =
    dynamicInformationArchitecture ||
    (input.state?.schemaVersion === 2 &&
      input.state.nativeSourceContractVersion === 2)
      ? 2
      : taskId
        ? 1
        : 2;
  const frozenRuntimeCoordinates =
    input.state?.schemaVersion === 2
      ? input.state.nativeSourceRuntimeCoordinates
      : undefined;
  let nativeSourceRuntime: NativeSourceRuntimeRegistryEntry | null = null;
  if (nativeSourceContractVersion === 2) {
    if (frozenRuntimeCoordinates) {
      nativeSourceRuntime = input.nativeSourceRuntimeRegistry.resolve(
        frozenRuntimeCoordinates,
      );
      if (!nativeSourceRuntime) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_NATIVE_RUNTIME_REPLAY_UNAVAILABLE",
          "本次 AI 建站任务冻结的运行时合同已不可用；请申请重置后从当前企业知识库重新开始。",
          "failed",
          providerStateV2(currentState),
        );
      }
    } else if (taskId || input.state?.stage === "create_unknown") {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_NATIVE_RUNTIME_REPLAY_UNAVAILABLE",
        "本次 AI 建站任务缺少可重放的运行时坐标；请申请重置后从当前企业知识库重新开始。",
        "failed",
        providerStateV2(currentState),
      );
    } else {
      nativeSourceRuntime = input.nativeSourceRuntimeRegistry.current;
    }
  }
  const customerRevisionDocument =
    dynamicInformationArchitecture &&
    input.operation.kind === "build_revision" &&
    input.input.feedback
      ? {
          id: currentRevisionSourceDocumentId!,
          path: `customer-revision/${input.operation.id}.md`,
          title: "本轮客户明确修订要求",
          content: input.input.feedback,
          kind: "customer_revision",
          customerVisible: true as const,
        }
      : null;
  const revisionDocuments = [
    ...inheritedRevisionDocuments,
    ...(customerRevisionDocument ? [customerRevisionDocument] : []),
  ];
  const generationDocuments =
    revisionDocuments.length > 0
      ? [...input.documents, ...revisionDocuments]
      : input.documents;
  const supplementalRevisionMedia: SupplementalKnowledgeMedia[] =
    revisionSource?.media.map((asset) => ({
      id: siteOpsCustomerMediaPlanId(asset.publicPath),
      sha256: asset.contentSha256,
      path: asset.publicPath,
      mimeType: asset.mimeType,
      caption: asset.filename,
      alt: asset.filename,
      size: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      sourceDocumentIds: asset.sourceDocumentIds,
    })) ?? [];
  const inventory = dynamicInformationArchitecture
    ? knowledgeCoverageInventoryFromSnapshot(
        input.context.snapshot,
        revisionDocuments,
        supplementalRevisionMedia,
      )
    : null;
  const inventoryBinding = inventory
    ? knowledgeCoverageInventoryAttachment(inventory)
    : null;
  const dynamicPlanningBrief = dynamicInformationArchitecture
    ? siteBriefSchema.parse({
        ...input.brief,
        routes: [
          {
            id: "root",
            slug: "/",
            title: input.brief.companyName,
            sourceDocumentIds: generationDocuments.map(
              (document) => document.id,
            ),
          },
        ],
      })
    : input.brief;
  let frozenContentPlan: SiteContentPlanV2 | null = null;
  let frozenContentPlanCoordinates: {
    localAssetId: string;
    sha256: string;
  } | null = null;

  const loadFrozenContentPlan = async () => {
    if (!dynamicInformationArchitecture) return null;
    const state = currentState?.schemaVersion === 2 ? currentState : null;
    const buildRecord = input.context.build as typeof input.context.build & {
      contentPlanLocalAssetId?: string | null;
      contentPlanSha256?: string | null;
    };
    const stateLocalAssetId = state?.contentPlanLocalAssetId;
    const stateSha256 = state?.contentPlanSha256;
    const buildLocalAssetId = buildRecord.contentPlanLocalAssetId ?? undefined;
    const buildSha256 = buildRecord.contentPlanSha256 ?? undefined;
    if (
      Boolean(stateLocalAssetId) !== Boolean(stateSha256) ||
      Boolean(buildLocalAssetId) !== Boolean(buildSha256)
    ) {
      throw new SiteOpsManusFailure(
        "SITEOPS_CONTENT_PLAN_COORDINATES_INCOMPLETE",
        "动态信息架构计划的冻结坐标不完整。",
        "attention_required",
        providerStateV2(currentState),
      );
    }
    if (
      stateLocalAssetId &&
      stateSha256 &&
      buildLocalAssetId &&
      buildSha256 &&
      (stateLocalAssetId !== buildLocalAssetId || stateSha256 !== buildSha256)
    ) {
      throw new SiteOpsManusFailure(
        "SITEOPS_CONTENT_PLAN_IDENTITY_CONFLICT",
        "动态信息架构计划的任务状态与构建合同坐标不一致。",
        "attention_required",
        providerStateV2(currentState),
      );
    }
    if (
      state?.contentPlanInventorySha256 &&
      state.contentPlanInventorySha256 !== inventoryBinding!.inventorySha256
    ) {
      throw new SiteOpsManusFailure(
        "SITEOPS_CONTENT_PLAN_INVENTORY_CONFLICT",
        "动态信息架构计划绑定的知识清单已发生冲突。",
        "attention_required",
        providerStateV2(currentState),
      );
    }
    const localAssetId = stateLocalAssetId ?? buildLocalAssetId;
    const expectedSha256 = stateSha256 ?? buildSha256;
    if (!localAssetId && !expectedSha256) return null;
    if (!localAssetId || !expectedSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_CONTENT_PLAN_COORDINATES_INCOMPLETE",
        "动态信息架构计划的冻结坐标不完整。",
        "attention_required",
        providerStateV2(currentState),
      );
    }
    const artifact = await input.readArtifact({
      userId: input.operation.userId,
      localAssetId,
      expectedSha256,
      expectedMimeTypes: ["application/json"],
    });
    if (!artifact) {
      throw new SiteOpsManusFailure(
        "SITEOPS_CONTENT_PLAN_ARTIFACT_MISSING",
        "动态信息架构计划附件不可用。",
        "attention_required",
        providerStateV2(currentState),
      );
    }
    const bytes = await storedArtifactBytes(artifact, 16 * 1024 * 1024);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    const validated = validateSiteContentPlanV2({
      plan: parsed,
      inventory: inventory!,
      documents: generationDocuments,
      requiredDocumentIds: currentRevisionSourceDocumentId
        ? [currentRevisionSourceDocumentId]
        : [],
      requiredMediaIds: currentRevisionMediaPlanIds,
    });
    return {
      plan: validated,
      coordinates: {
        localAssetId,
        sha256: expectedSha256,
      },
    };
  };

  const loadedContentPlan = await loadFrozenContentPlan();
  frozenContentPlan = loadedContentPlan?.plan ?? null;
  frozenContentPlanCoordinates = loadedContentPlan?.coordinates ?? null;
  if (
    dynamicInformationArchitecture &&
    frozenContentPlan &&
    currentState?.schemaVersion === 2 &&
    [
      "create_unknown",
      "content_plan_pending",
      "content_plan_repair_send_ready",
      "content_plan_repair_send_unknown",
      "content_plan_repair_pending",
    ].includes(currentState.stage)
  ) {
    if (!taskId || !frozenContentPlanCoordinates) {
      throw new SiteOpsManusFailure(
        "SITEOPS_CONTENT_PLAN_SOURCE_HANDOFF_INCOMPLETE",
        "已冻结的信息架构计划缺少同一任务的源码适配坐标。",
        "attention_required",
        providerStateV2(currentState),
      );
    }
    currentState = transitionProviderState(currentState, {
      stage: "native_source_send_ready",
      taskId,
      contentPlanLocalAssetId: frozenContentPlanCoordinates.localAssetId,
      contentPlanSha256: frozenContentPlanCoordinates.sha256,
      contentPlanInventorySha256: inventoryBinding!.inventorySha256,
      buildPhase: "source_waiting",
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
  }

  if (dynamicInformationArchitecture && !frozenContentPlan) {
    const planAttempt =
      currentState?.schemaVersion === 2
        ? (currentState.contentPlanAttempt ?? 0)
        : 0;
    const planToken =
      currentState?.schemaVersion === 2 &&
      currentState.contentPlanOperationToken
        ? currentState.contentPlanOperationToken
        : `siteops-content-plan:${input.operation.id}:${planAttempt}`;
    const planSourceDocumentIds = generationDocuments.map(
      (document) => document.id,
    );
    const planAttachments = (attachmentOperationToken = planToken) => [
      ...siteOpsSourceDossierAttachments({
        operationToken: attachmentOperationToken,
        snapshot: {
          id: input.context.snapshot.id,
          archiveSha256: input.context.build.knowledgeArchiveHash,
          sourceBuildId: input.context.snapshot.sourceBuildId,
          sourceBuildRevision: input.context.snapshot.sourceBuildRevision,
        },
        // SiteBrief is identity/context only in 2.9; Manus owns every route
        // except the required technical root.
        brief: briefWithoutBrandAssets(dynamicPlanningBrief),
        visualEvidence: runtimeVisual,
        documents: generationDocuments,
      }),
      inventoryBinding!.attachment,
      siteContentPlanWireContractAttachment({
        operationToken: attachmentOperationToken,
        inventorySha256: inventoryBinding!.inventorySha256,
        sourceDocumentIds: planSourceDocumentIds,
      }),
      ...(revisionSource?.attachments ?? []),
      ...(input.input.feedback
        ? [siteOpsCustomerFeedbackAttachment(input.input.feedback)]
        : []),
    ];
    if (!taskId) {
      client = client ?? (await input.getClient());
      if (currentState?.stage === "create_unknown") {
        const found = await findUniqueCreatedTask(
          client,
          input.operation,
          planToken,
        );
        if (!found) {
          const sync = providerResultSyncWindow(
            providerStateV2(currentState),
            Date.now(),
            input.operation.updatedAt,
          );
          if (sync.expired) {
            throw new SiteOpsManusFailure(
              "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
              "AI 信息架构任务创建结果未能在限定时间内确认；创建坐标已保留。",
              "attention_required",
              sync.state,
            );
          }
          return pending(sync.state, undefined, "design_compiling", 60_000);
        }
        taskId = found.id;
      } else {
        const createRetryAt = Date.parse(
          currentState?.schemaVersion === 2
            ? (currentState.providerNextPollAt ?? "")
            : "",
        );
        if (Number.isFinite(createRetryAt) && createRetryAt > Date.now()) {
          return pending(
            providerStateV2(currentState),
            undefined,
            "design_compiling",
            Math.max(2_000, createRetryAt - Date.now()),
          );
        }
        const unknownState = startProviderResultSyncWindow(
          transitionProviderState(currentState, {
            stage: "create_unknown",
            nativeSourceContractVersion: 2,
            nativeSourceRuntimeCoordinates: nativeSourceRuntime!.coordinates,
            contentPlanAttempt: planAttempt,
            contentPlanOperationToken: planToken,
            contentPlanInventorySha256: inventoryBinding!.inventorySha256,
            providerNextPollAt: undefined,
            buildPhase: "source_waiting",
          }),
        );
        await persistOperationProgress(input.db, input.operation, unknownState);
        currentState = unknownState;
        try {
          await input.assertExecutionActive();
          const created = await client.createTask({
            title: operationTitle(input.operation),
            prompt: siteContentPlanPrompt({
              operationToken: planToken,
              inventorySha256: inventoryBinding!.inventorySha256,
              hasRevisionBaseline: Boolean(revisionSource),
            }),
            attachments: planAttachments(),
            locale: input.brief.primaryLanguage,
            agentProfile: managedAgentProfileModel(input.input.agentProfile),
            structuredOutputSchema: siteContentPlanOutputSchema({
              operationToken: planToken,
              inventorySha256: inventoryBinding!.inventorySha256,
            }),
          });
          taskId = created.taskId;
        } catch (error) {
          if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
            return pending(unknownState, undefined, "design_compiling", 60_000);
          }
          if (error instanceof ManusV2ApiError && error.retryable) {
            const retryAfterMs = Math.max(
              2_000,
              Math.min(300_000, error.retryAfterMs ?? 10_000),
            );
            const retryReadyState = transitionProviderState(unknownState, {
              stage: "native_input_ready",
              providerSyncStartedAt: undefined,
              providerNextPollAt: new Date(
                Date.now() + retryAfterMs,
              ).toISOString(),
            });
            try {
              await persistOperationProgress(
                input.db,
                input.operation,
                retryReadyState,
              );
              return pending(
                retryReadyState,
                undefined,
                "design_compiling",
                retryAfterMs,
              );
            } catch {
              return pending(
                unknownState,
                undefined,
                "design_compiling",
                60_000,
              );
            }
          }
          throw error;
        }
      }
      const pendingState = transitionProviderState(currentState, {
        stage:
          planAttempt > 0
            ? "content_plan_repair_pending"
            : "content_plan_pending",
        taskId,
        contentPlanAttempt: planAttempt,
        contentPlanOperationToken: planToken,
        contentPlanInventorySha256: inventoryBinding!.inventorySha256,
        providerSyncStartedAt: undefined,
        providerNextPollAt: undefined,
        buildPhase: "source_waiting",
      });
      await bindCreatedBuildTask({
        db: input.db,
        operation: input.operation,
        buildId: input.context.build.id,
        taskId,
        state: pendingState,
        preservePreview: false,
      });
      return pending(pendingState, taskId, "design_compiling", 10_000);
    }

    client = client ?? (await input.getClient());
    if (currentState?.stage === "content_plan_repair_send_ready") {
      const retryAt = Date.parse(
        currentState.schemaVersion === 2
          ? (currentState.providerNextPollAt ?? "")
          : "",
      );
      if (Number.isFinite(retryAt) && retryAt > Date.now()) {
        return pending(
          currentState,
          taskId,
          "design_compiling",
          Math.max(2_000, retryAt - Date.now()),
        );
      }
      const unknownState = startProviderResultSyncWindow(
        transitionProviderState(currentState, {
          stage: "content_plan_repair_send_unknown",
          providerNextPollAt: undefined,
        }),
      );
      await persistOperationProgress(
        input.db,
        input.operation,
        unknownState,
        taskId,
      );
      try {
        await input.assertExecutionActive();
        await client.sendMessage({
          taskId,
          prompt: siteContentPlanPrompt({
            operationToken: planToken,
            inventorySha256: inventoryBinding!.inventorySha256,
            hasRevisionBaseline: Boolean(revisionSource),
            repairIssues: ["CONTENT_PLAN_PROVIDER_SEND_RETRY"],
          }),
          attachments: planAttachments(planToken),
          structuredOutputSchema: siteContentPlanOutputSchema({
            operationToken: planToken,
            inventorySha256: inventoryBinding!.inventorySha256,
          }),
        });
      } catch (error) {
        if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
          return pending(unknownState, taskId, "design_compiling", 10_000);
        }
        if (error instanceof ManusV2ApiError && error.retryable) {
          const retryAfterMs = Math.max(
            2_000,
            Math.min(300_000, error.retryAfterMs ?? 10_000),
          );
          const retryState = transitionProviderState(unknownState, {
            stage: "content_plan_repair_send_ready",
            providerSyncStartedAt: undefined,
            providerNextPollAt: new Date(
              Date.now() + retryAfterMs,
            ).toISOString(),
          });
          await persistOperationProgress(
            input.db,
            input.operation,
            retryState,
            taskId,
          );
          return pending(retryState, taskId, "design_compiling", retryAfterMs);
        }
        throw error;
      }
      const repairPendingState = transitionProviderState(unknownState, {
        stage: "content_plan_repair_pending",
        providerSyncStartedAt: undefined,
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        repairPendingState,
        taskId,
      );
      return pending(repairPendingState, taskId, "design_compiling", 10_000);
    }
    const polledPlan = await pollEvents(
      client,
      taskId,
      planToken,
      currentState,
      { operationId: input.operation.id, buildId: input.context.build.id },
    );
    currentState = polledPlan.providerState;
    if (polledPlan.deferred) {
      return pending(
        polledPlan.providerState,
        taskId,
        "design_compiling",
        polledPlan.nextPollMs,
      );
    }
    if (
      currentState.stage === "content_plan_repair_send_unknown" &&
      !manusV2EventsContainOperationToken(polledPlan.events, planToken)
    ) {
      const sync = providerResultSyncWindow(
        currentState,
        Date.now(),
        input.operation.updatedAt,
      );
      if (sync.expired) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
          "AI 信息架构修订消息结果未能在限定时间内确认；原任务坐标已保留。",
          "attention_required",
          sync.state,
        );
      }
      return pending(sync.state, taskId, "design_compiling", 60_000);
    }
    const planResolution = await resolveBuildWireValue({
      operationId: input.operation.id,
      buildId: input.context.build.id,
      events: polledPlan.events,
      operationToken: planToken,
      phase: "design",
      expectedFilename: SITEOPS_CONTENT_PLAN_V2_FILENAME,
      taskCompleted: polledPlan.state.completed,
      acceptCurrentPhaseWhileRunning: true,
      signal: input.signal,
      validateCandidate: (value) => {
        const wire = siteContentPlanWireV2Schema.parse(value);
        if (
          wire.operationToken !== planToken ||
          wire.inventorySha256 !== inventoryBinding!.inventorySha256
        ) {
          throw new Error("SITEOPS_CONTENT_PLAN_COORDINATES_MISMATCH");
        }
      },
    });
    if (
      !planResolution.value &&
      !planResolution.invalid &&
      !polledPlan.state.failed
    ) {
      return pending(
        transitionProviderState(currentState, {
          stage:
            planAttempt > 0
              ? "content_plan_repair_pending"
              : "content_plan_pending",
        }),
        taskId,
        "design_compiling",
        10_000,
      );
    }
    try {
      if (!planResolution.value) {
        const schemaIssues = siteContentPlanSchemaRepairIssues(
          planResolution.validationError,
        );
        throw new SiteContentPlanValidationError(
          planResolution.invalid && schemaIssues.length > 0
            ? schemaIssues
            : [
                planResolution.invalid
                  ? "CONTENT_PLAN_STRUCTURED_OUTPUT_INVALID"
                  : "CONTENT_PLAN_PROVIDER_TASK_FAILED",
              ],
        );
      }
      frozenContentPlan = validateSiteContentPlanV2({
        plan: siteContentPlanV2FromWire(planResolution.value, {
          operationToken: planToken,
          inventorySha256: inventoryBinding!.inventorySha256,
        }),
        inventory: inventory!,
        documents: generationDocuments,
        requiredDocumentIds: currentRevisionSourceDocumentId
          ? [currentRevisionSourceDocumentId]
          : [],
        requiredMediaIds: currentRevisionMediaPlanIds,
      });
    } catch (error) {
      const issues =
        error instanceof SiteContentPlanValidationError
          ? error.issues
          : ["CONTENT_PLAN_SCHEMA_INVALID"];
      if (planAttempt >= 1) {
        throw new SiteOpsManusFailure(
          "SITEOPS_CONTENT_PLAN_REPAIR_EXHAUSTED",
          "AI 信息架构计划在一次定向修复后仍未通过来源与覆盖校验。",
          "failed",
          providerStateV2(currentState),
        );
      }
      const repairAttempt = 1;
      const repairToken = `siteops-content-plan:${input.operation.id}:${repairAttempt}`;
      const unknownState = transitionProviderState(currentState, {
        stage: "content_plan_repair_send_unknown",
        contentPlanAttempt: repairAttempt,
        contentPlanOperationToken: repairToken,
        contentPlanInventorySha256: inventoryBinding!.inventorySha256,
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        unknownState,
        taskId,
      );
      currentState = unknownState;
      try {
        await input.assertExecutionActive();
        await client.sendMessage({
          taskId,
          prompt: siteContentPlanPrompt({
            operationToken: repairToken,
            inventorySha256: inventoryBinding!.inventorySha256,
            hasRevisionBaseline: Boolean(revisionSource),
            repairIssues: issues,
          }),
          attachments: planAttachments(repairToken),
          structuredOutputSchema: siteContentPlanOutputSchema({
            operationToken: repairToken,
            inventorySha256: inventoryBinding!.inventorySha256,
          }),
        });
      } catch (sendError) {
        if (sendError instanceof ManusV2ApiError && sendError.outcomeUnknown) {
          return pending(unknownState, taskId, "design_compiling", 10_000);
        }
        if (sendError instanceof ManusV2ApiError && sendError.retryable) {
          const retryAfterMs = Math.max(
            2_000,
            Math.min(300_000, sendError.retryAfterMs ?? 10_000),
          );
          const retryState = transitionProviderState(unknownState, {
            stage: "content_plan_repair_send_ready",
            providerSyncStartedAt: undefined,
            providerNextPollAt: new Date(
              Date.now() + retryAfterMs,
            ).toISOString(),
          });
          await persistOperationProgress(
            input.db,
            input.operation,
            retryState,
            taskId,
          );
          return pending(retryState, taskId, "design_compiling", retryAfterMs);
        }
        throw sendError;
      }
      const repairState = transitionProviderState(unknownState, {
        stage: "content_plan_repair_pending",
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        repairState,
        taskId,
      );
      return pending(repairState, taskId, "design_compiling", 10_000);
    }
    const planBytes = Buffer.from(
      `${canonicalJson(frozenContentPlan)}\n`,
      "utf8",
    );
    await input.assertExecutionActive();
    const planArtifact = await input.persist({
      userId: input.operation.userId,
      projectId: input.operation.projectId,
      kind: "site-content-plan",
      filename: SITEOPS_CONTENT_PLAN_V2_FILENAME,
      mimeType: "application/json",
      buffer: planBytes,
      maxBytes: 16 * 1024 * 1024,
      idempotencyKey: `content-plan:${input.operation.id}`,
    });
    await input.assertExecutionActive();
    const bound = await input.db
      .update(siteBuilds)
      .set({
        contentPlanLocalAssetId: planArtifact.id,
        contentPlanSha256: planArtifact.contentSha256,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteBuilds.id, input.context.build.id),
          eq(siteBuilds.userId, input.operation.userId),
          eq(siteBuilds.upstreamManusTaskId, taskId),
          inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
        ),
      );
    const boundRows = Number(
      (Array.isArray(bound)
        ? (bound[0] as { affectedRows?: unknown } | undefined)?.affectedRows
        : (bound as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
    );
    if (boundRows !== 1) throw new Error("SITEOPS_OPERATION_LEASE_LOST");
    currentState = transitionProviderState(currentState, {
      stage: "native_source_send_ready",
      contentPlanLocalAssetId: planArtifact.id,
      contentPlanSha256: planArtifact.contentSha256,
      contentPlanInventorySha256: inventoryBinding!.inventorySha256,
      buildPhase: "source_waiting",
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
    return pending(currentState, taskId, "design_compiling", 1_000);
  }
  if (frozenContentPlan) {
    const mediaSelection = siteOpsContentPlanMediaSelection(
      frozenContentPlan,
      revisionSource?.media ?? [],
    );
    if (mediaSelection.unknownCustomerMediaIds.length > 0) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_REVISION_MEDIA_COORDINATES_MISMATCH",
        "内容计划引用的客户图片不属于当前连续修订来源链。",
        "failed",
        providerStateV2(currentState),
      );
    }
    requiredRevisionMedia = mediaSelection.selectedCustomerMedia;
    for (const [mediaId, routePaths] of mediaSelection.knowledgeRoutePaths) {
      knowledgeMediaRoutePaths.set(mediaId, routePaths);
    }
    const selectedMediaIds = [...knowledgeMediaRoutePaths.keys()];
    try {
      knowledgeMedia = await freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes: input.knowledgeArchiveBytes,
        assets: input.context.snapshot.assets,
        selectedMediaIds,
      });
      if (knowledgeMedia.length > 0) {
        const sourceBytes =
          sourceOverride?.bytes ??
          (await nativeSelectionBytesForMediaOverlay(input.nativeSelection));
        const bytes = await overlaySiteOpsKnowledgeMedia(
          sourceBytes,
          knowledgeMedia,
        );
        sourceOverride = { bytes, sha256: sha256(bytes) };
        baseSourceSha256 = sourceOverride.sha256;
      }
    } catch {
      throw new SiteOpsManusFailure(
        "SITEOPS_KNOWLEDGE_MEDIA_INVALID",
        "内容计划选中的知识库图片未通过来源、解码或源码边界校验。",
        "failed",
        providerStateV2(currentState),
      );
    }
  }
  const effectiveBrief = frozenContentPlan
    ? siteBriefSchema.parse({
        ...input.brief,
        routes: siteContentPlanRoutes(frozenContentPlan),
      })
    : input.brief;
  const expectedContentPlanSha256 = dynamicInformationArchitecture
    ? (frozenContentPlanCoordinates?.sha256 ??
      (currentState?.schemaVersion === 2
        ? currentState.contentPlanSha256
        : undefined))
    : undefined;
  if (dynamicInformationArchitecture && !expectedContentPlanSha256) {
    throw new SiteOpsManusFailure(
      "SITEOPS_CONTENT_PLAN_SOURCE_HANDOFF_INCOMPLETE",
      "动态信息架构源码适配缺少已冻结计划哈希。",
      "attention_required",
      providerStateV2(currentState),
    );
  }
  const providerSourceAttachment = async (
    sourceClient: ManusV2Client,
  ): Promise<ManusV2Attachment> => {
    const sourceByteLength =
      sourceOverride?.bytes.length ??
      nativeSelectionByteLength(input.nativeSelection);
    if (nativeSourceAttachmentTransport(sourceByteLength) === "inline") {
      if (sourceOverride) {
        return {
          filename: NATIVE_SOURCE_PROVIDER_FILENAME,
          mime_type: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
          file_data: `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,${sourceOverride.bytes.toString("base64")}`,
        };
      }
      return nativeSourceInlineAttachment(input.nativeSelection);
    }
    if (!sourceOverride && input.nativeSelection.bundle.schemaVersion === 6) {
      assertVisualSelectionBundleV6SourceArchiveSize(
        nativeSelectionInlineBytes(input.nativeSelection),
      );
    }
    const prior =
      currentState?.schemaVersion === 2
        ? currentState.nativeInputProviderFile
        : undefined;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (
      prior?.status === "uploaded" &&
      prior.sourceArchiveSha256 === baseSourceSha256 &&
      prior.bytes === sourceByteLength &&
      prior.expiresAt - nowSeconds >=
        NATIVE_SOURCE_PROVIDER_MINIMUM_USABLE_SECONDS
    ) {
      return {
        file_id: prior.fileId,
        filename: prior.filename,
      };
    }

    await input.assertExecutionActive();
    const uploaded = await sourceClient.uploadFile(
      sourceOverride
        ? {
            filename: NATIVE_SOURCE_PROVIDER_FILENAME,
            byteLength: sourceByteLength,
            createReadStream: () =>
              Readable.from(sourceOverride!.bytes) as unknown as ReadStream,
            contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
            minimumUsableSeconds: NATIVE_SOURCE_PROVIDER_MINIMUM_USABLE_SECONDS,
          }
        : isStaticNativeSelection(input.nativeSelection)
          ? {
              filename: NATIVE_SOURCE_PROVIDER_FILENAME,
              byteLength: sourceByteLength,
              createReadStream: input.nativeSelection.createArchiveReadStream,
              contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
              minimumUsableSeconds:
                NATIVE_SOURCE_PROVIDER_MINIMUM_USABLE_SECONDS,
            }
          : {
              filename: NATIVE_SOURCE_PROVIDER_FILENAME,
              bytes: input.nativeSelection.archiveBytes,
              contentType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
              minimumUsableSeconds:
                NATIVE_SOURCE_PROVIDER_MINIMUM_USABLE_SECONDS,
            },
    );
    currentState = transitionProviderState(currentState, {
      stage: currentState?.stage ?? "native_input_ready",
      nativeInputProviderFile: {
        sourceArchiveSha256: baseSourceSha256,
        bytes: sourceByteLength,
        filename: NATIVE_SOURCE_PROVIDER_FILENAME,
        fileId: uploaded.fileId,
        expiresAt: uploaded.detail.expiresAt,
        status: "uploaded",
      },
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
    return {
      file_id: uploaded.fileId,
      filename: NATIVE_SOURCE_PROVIDER_FILENAME,
    };
  };
  const sourceAttachments = async (
    token: string,
    sourceClient: ManusV2Client,
    repair?: NativeSourceRepairInput,
  ): Promise<ManusV2Attachment[]> => [
    ...siteOpsSourceDossierAttachments({
      operationToken: token,
      snapshot: {
        id: input.context.snapshot.id,
        archiveSha256: input.context.build.knowledgeArchiveHash,
        sourceBuildId: input.context.snapshot.sourceBuildId,
        sourceBuildRevision: input.context.snapshot.sourceBuildRevision,
      },
      brief: briefWithoutBrandAssets(dynamicPlanningBrief),
      visualEvidence: runtimeVisual,
      documents: generationDocuments,
    }),
    await providerSourceAttachment(sourceClient),
    ...(revisionSource?.attachments ?? []),
    ...knowledgeMediaManifestAttachment(knowledgeMedia),
    ...(nativeSourceContractVersion === 2
      ? [...nativeSourceRuntime!.attachments]
      : [
          {
            filename: NATIVE_SOURCE_PREFLIGHT_FILENAME,
            mime_type: "text/javascript",
            file_data: `data:text/javascript;base64,${NATIVE_SOURCE_PREFLIGHT_SCRIPT.toString("base64")}`,
          },
        ]),
    ...(templateCoordinate ? [templateCoordinate.attachment] : []),
    ...(frozenContentPlan
      ? [siteContentPlanAttachment(frozenContentPlan)]
      : []),
    ...nativeBrandAttachment(input.brandAsset),
    ...(input.input.feedback
      ? [siteOpsCustomerFeedbackAttachment(input.input.feedback)]
      : []),
    ...(repair ? [nativeRuntimeDiagnosticsAttachment(repair)] : []),
  ];
  let boundBuildTaskId = input.context.build.upstreamManusTaskId;
  const pendingExistingFallback = () => {
    const fallback =
      currentState?.schemaVersion === 2
        ? currentState.fallbackPreview
        : undefined;
    const reconcileUntil = fallback
      ? Date.parse(fallback.reconcileUntilAt)
      : Number.NaN;
    return fallback &&
      (!Number.isFinite(reconcileUntil) || Date.now() < reconcileUntil)
      ? pending(
          providerStateV2(currentState),
          taskId,
          "qa_running",
          NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS,
        )
      : null;
  };
  const fallbackReconciliationPollMs = () => {
    const fallback =
      currentState?.schemaVersion === 2
        ? currentState.fallbackPreview
        : undefined;
    if (!fallback) return undefined;
    return nativeFallbackReconciliationDelayMs(fallback.createdAt);
  };
  const throwIfExistingFallbackExpired = (): void => {
    const state = providerStateV2(currentState);
    const fallback = state.fallbackPreview;
    if (!fallback || Date.now() < Date.parse(fallback.reconcileUntilAt)) {
      return;
    }
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
      "AI 建站结果自动对账窗口已结束，基础预览与同一任务坐标已保留。",
      "attention_required",
      state,
    );
  };
  const materializeTrustedFallback = async (
    requestedReason: NativeTrustedFallbackReason,
  ): Promise<SiteOpsProviderResult | null> => {
    if (dynamicInformationArchitecture) return null;
    // 2.8 owns no host-rendered approximation of the selected full Template.
    // Keep the immutable visual reference and let the normal recoverable
    // retry/reset state surface instead of sending V7 through the V6
    // style-token fallback contract.
    if (isStaticNativeSelection(input.nativeSelection)) return null;
    const existing = pendingExistingFallback();
    if (existing) return existing;
    if (currentState?.schemaVersion === 2 && currentState.fallbackPreview) {
      // An expired or otherwise non-pending fallback keeps its original
      // coordinates. Never create a second preview or restart the 24h clock.
      return null;
    }
    const fallbackRetryAt = Date.parse(
      currentState?.schemaVersion === 2
        ? (currentState.fallbackPreviewNextPollAt ?? "")
        : "",
    );
    if (Number.isFinite(fallbackRetryAt) && Date.now() < fallbackRetryAt) {
      return pending(
        providerStateV2(currentState),
        taskId,
        "qa_running",
        Math.max(2_000, fallbackRetryAt - Date.now()),
      );
    }
    const fallbackTriggeredAt = new Date();
    const reconcileUntil = nativeTrustedFallbackReconcileUntil({
      providerReadFailureSince:
        currentState?.schemaVersion === 2
          ? currentState.providerReadFailureSince
          : undefined,
      nativeSourceReadFailureSince:
        currentState?.schemaVersion === 2
          ? currentState.nativeSourceReadFailureSince
          : undefined,
      providerSyncStartedAt:
        currentState?.schemaVersion === 2
          ? currentState.providerSyncStartedAt
          : undefined,
      resultPendingSince: currentState?.resultPendingSince,
      providerStoppedAt:
        currentState?.schemaVersion === 2
          ? currentState.providerStoppedAt
          : undefined,
      fallbackTriggeredAt,
      operationStartedAt: input.operation.startedAt,
      operationCreatedAt: input.operation.createdAt,
    });
    if (Date.now() >= reconcileUntil.getTime()) return null;
    const reason = nativeTrustedFallbackReason({
      firstBuild: input.context.build.parentBuildId === null,
      hasPreview: Boolean(
        input.context.build.contractLocalAssetId ||
          input.context.build.sourceLocalAssetId ||
          input.context.build.distLocalAssetId ||
          input.context.build.qaLocalAssetId ||
          input.context.build.provenanceLocalAssetId,
      ),
      initialBaseline: requestedReason === "initial_baseline",
      repairBudgetExhausted: requestedReason === "repair_budget_exhausted",
      stoppedGraceExpired:
        requestedReason === "provider_stopped_without_result",
      providerReadFailureSince:
        requestedReason === "provider_read_delayed" &&
        currentState?.schemaVersion === 2
          ? currentState.providerReadFailureSince
          : undefined,
      nativeSourceReadFailureSince:
        requestedReason === "provider_read_delayed" &&
        currentState?.schemaVersion === 2
          ? currentState.nativeSourceReadFailureSince
          : undefined,
    });
    if (!reason) return null;

    try {
      const selectedFallbackCandidate =
        input.nativeSelection.bundle.candidates.find(
          (candidate) => candidate.id === input.nativeSelection.candidate.id,
        );
      if (!selectedFallbackCandidate) {
        throw new Error("NATIVE_FALLBACK_VISUAL_MISSING");
      }
      const operationToken = `siteops-native-fallback:${input.operation.id}`;
      const referenceBlueprint = nativeFallbackReferenceBlueprint({
        selection: input.nativeSelection,
        taxonomy: input.taxonomy,
        visualEvidence: input.visualEvidence,
      });
      const fallbackVisual = siteOpsRuntimeVisualEvidenceV2Schema.parse({
        schemaVersion: 2,
        queryHash: nativeSelectionQueryHash(input.nativeSelection),
        selectedCandidateId: input.context.sample.id,
        providerItemKey: input.visualEvidence.providerItemKey,
        visualEvidenceSha256: input.visualEvidence.evidenceSha256,
        previewSha256: input.visualEvidence.previewSha256,
        supportEvidenceSha256s: [],
        taxonomy: input.taxonomy,
        referenceBlueprint,
      });
      const design = createHostOwnedSiteDesignResultV2({
        operationToken,
        brief: input.brief,
        referenceBlueprint,
        taxonomy: input.taxonomy,
      });
      const canonical = canonicalizeSiteContentDraft({
        draft: null,
        operationToken,
        brief: input.brief,
        seo: design.designSpec.seoPlan,
      });
      const generatedContent = siteOpsGeneratedContentV2Schema.parse(
        canonicalPreviewToGeneratedContent({
          canonical,
          designRouteCompositions: design.designSpec.routeCompositions,
          fallbackSourceDocumentIds: Object.fromEntries(
            input.brief.routes.map((route) => [
              route.id,
              route.sourceDocumentIds,
            ]),
          ),
        }),
      );
      const warningCode = NATIVE_TRUSTED_FALLBACK_WARNING_CODES[reason];
      const fallbackQaUpdated = await input.db
        .update(siteBuilds)
        .set({ status: "qa_running", updatedAt: new Date() })
        .where(
          and(
            eq(siteBuilds.id, input.context.build.id),
            eq(siteBuilds.userId, input.operation.userId),
            inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
            taskId
              ? eq(siteBuilds.upstreamManusTaskId, taskId)
              : isNull(siteBuilds.upstreamManusTaskId),
            isNull(siteBuilds.parentBuildId),
            isNull(siteBuilds.distLocalAssetId),
          ),
        );
      const fallbackQaAffectedRows = Number(
        (Array.isArray(fallbackQaUpdated)
          ? (fallbackQaUpdated[0] as { affectedRows?: unknown } | undefined)
              ?.affectedRows
          : (fallbackQaUpdated as { affectedRows?: unknown } | undefined)
              ?.affectedRows) ?? 0,
      );
      if (fallbackQaAffectedRows !== 1) {
        throw new Error("SITEOPS_OPERATION_LEASE_LOST");
      }
      currentState = transitionProviderState(currentState, {
        stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
        taskId,
        buildPhase: "compiling",
        buildCheckpoint: "compile_started",
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        currentState,
        taskId,
      );
      await input.assertExecutionActive();
      const materialized = await input.materializeNativeFallback({
        build: input.context.build,
        snapshot: { ...input.context.snapshot, documents: input.documents },
        brief: input.brief,
        visual: fallbackVisual,
        designSpec: design.designSpec,
        generatedContent,
        assetDecisions: input.assetDecisions,
        brandAsset: input.brandAsset,
        mode: "preview",
        abortSignal: input.signal,
        warningCode,
      });
      await input.assertExecutionActive();
      const artifacts = await persistBuildArtifacts(
        input.operation,
        materialized,
        input.persist,
        input.assertExecutionActive,
        "trusted-fallback",
      );
      const artifactBindings = {
        contract: {
          id: artifacts.contract.id,
          sha256: materialized.contractSha256,
          bytes: materialized.contractJson.length,
          mimeType: "application/json",
        },
        source: {
          id: artifacts.source.id,
          sha256: materialized.sourceSha256,
          bytes: materialized.sourceZip.length,
          mimeType: "application/zip",
        },
        dist: {
          id: artifacts.dist.id,
          sha256: materialized.distSha256,
          bytes: materialized.distZip.length,
          mimeType: "application/zip",
        },
        qa: {
          id: artifacts.qa.id,
          sha256: materialized.visualQaSha256,
          bytes: materialized.visualQaZip.length,
          mimeType: "application/zip",
        },
        provenance: {
          id: artifacts.provenance.id,
          sha256: materialized.provenanceSha256,
          bytes: materialized.provenanceJson.length,
          mimeType: "application/json",
        },
      };
      const createdAt = fallbackTriggeredAt;
      currentState = providerStateV2Schema.parse({
        ...providerStateV2(currentState),
        buildPhase: "provider_sync_delayed",
        buildCheckpoint: "artifacts_staged",
        fallbackPreviewFailureCount: undefined,
        fallbackPreviewNextPollAt: undefined,
        fallbackPreviewLastErrorCode: undefined,
        fallbackPreview: {
          status: "staged",
          trigger: reason,
          createdAt: createdAt.toISOString(),
          reconcileUntilAt: reconcileUntil.toISOString(),
          buildId: input.context.build.id,
          taskId: taskId ?? null,
          operationToken,
          selectedPreviewSha256: selectedFallbackCandidate.previewSha256,
          selectedSourceTreeSha256: selectedFallbackCandidate.sourceTreeSha256,
          artifactBindings,
          buildDelivery: materialized.buildDelivery,
        },
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        currentState,
        taskId,
      );
      logManusBuildStage({
        stage: "fallback_render",
        operationId: input.operation.id,
        buildId: input.context.build.id,
        reason,
        renderMode: "trusted_fallback",
        qaStatus: "partial",
        warningCount: materialized.buildDelivery.warningCodes.length,
      });
      return pending(currentState, taskId, "qa_running", 10_000);
    } catch (error) {
      if (
        input.signal.aborted ||
        (error instanceof Error &&
          error.message === "SITEOPS_OPERATION_LEASE_LOST")
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      const code =
        (error instanceof SiteOpsMaterializationError ? error.code : null) ??
        message.match(/^(?:SITEOPS|NATIVE)_[A-Z0-9_]+/u)?.[0] ??
        "SITEOPS_TRUSTED_FALLBACK_FAILED";
      const failureCount =
        (currentState?.schemaVersion === 2
          ? (currentState.fallbackPreviewFailureCount ?? 0)
          : 0) + 1;
      const nextPollMs = manusProviderReadRetryDelayMs({ failureCount });
      currentState = transitionProviderState(currentState, {
        stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
        taskId,
        buildPhase: "provider_sync_delayed",
        fallbackPreviewFailureCount: failureCount,
        fallbackPreviewNextPollAt: new Date(
          Date.now() + nextPollMs,
        ).toISOString(),
        fallbackPreviewLastErrorCode: code,
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        currentState,
        taskId,
      );
      console.error("[siteops-manus] trusted_fallback_deferred", {
        event: "siteops_manus_trusted_fallback_deferred",
        operationId: input.operation.id,
        buildId: input.context.build.id,
        taskId,
        code,
        failureCount,
        nextPollMs,
      });
      return pending(currentState, taskId, "qa_running", nextPollMs);
    }
  };
  if (
    dynamicInformationArchitecture &&
    frozenContentPlan &&
    (currentState?.stage === "native_source_send_ready" ||
      currentState?.stage === "native_source_send_unknown")
  ) {
    const contentPlanSha256 =
      currentState?.schemaVersion === 2
        ? currentState.contentPlanSha256
        : undefined;
    if (!taskId || !contentPlanSha256) {
      throw new SiteOpsManusFailure(
        "SITEOPS_CONTENT_PLAN_SOURCE_HANDOFF_INCOMPLETE",
        "信息架构计划缺少同一任务的源码适配坐标。",
        "attention_required",
        providerStateV2(currentState),
      );
    }
    client = client ?? (await input.getClient());
    if (currentState.stage === "native_source_send_unknown") {
      const reconciled = await pollEvents(
        client,
        taskId,
        operationToken,
        currentState,
        { operationId: input.operation.id, buildId: input.context.build.id },
      );
      if (reconciled.deferred) {
        return pending(
          reconciled.providerState,
          taskId,
          "design_compiling",
          reconciled.nextPollMs,
        );
      }
      if (
        !manusV2EventsContainOperationToken(reconciled.events, operationToken)
      ) {
        const sync = providerResultSyncWindow(
          reconciled.providerState,
          Date.now(),
          input.operation.updatedAt,
        );
        if (sync.expired) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
            "AI 源码适配消息结果未能在限定时间内确认；冻结计划与原任务坐标已保留。",
            "attention_required",
            sync.state,
          );
        }
        return pending(sync.state, taskId, "design_compiling", 60_000);
      }
      currentState = transitionProviderState(reconciled.providerState, {
        stage: "native_source_pending",
        buildPhase: "source_waiting",
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        currentState,
        taskId,
      );
      return pending(currentState, taskId, "building", 5_000);
    }
    const sendRetryAt = Date.parse(
      currentState.schemaVersion === 2
        ? (currentState.providerNextPollAt ?? "")
        : "",
    );
    if (Number.isFinite(sendRetryAt) && sendRetryAt > Date.now()) {
      return pending(
        currentState,
        taskId,
        "design_compiling",
        Math.max(2_000, sendRetryAt - Date.now()),
      );
    }
    const unknownState = startProviderResultSyncWindow(
      transitionProviderState(currentState, {
        stage: "native_source_send_unknown",
        phaseOperationToken: operationToken,
        phaseStartedAt: new Date().toISOString(),
        nativeRepairAttempt: attempt,
        providerNextPollAt: undefined,
        buildPhase: "source_waiting",
      }),
    );
    await persistOperationProgress(
      input.db,
      input.operation,
      unknownState,
      taskId,
    );
    currentState = unknownState;
    try {
      await input.assertExecutionActive();
      await client.sendMessage({
        taskId,
        prompt: nativeSourcePrompt({
          operationToken,
          baseSourceSha256,
          contractVersion: nativeSourceContractVersion,
          runtimeCoordinates: nativeSourceRuntime?.coordinates ?? null,
          workflowVersion: input.context.build.workflowVersion,
          hasCustomerFeedback: Boolean(input.input.feedback),
          hasRevisionMedia: Boolean(revisionSource?.media.length),
          hasRevisionBaseline: Boolean(revisionSource),
          hasKnowledgeMedia: knowledgeMedia.length > 0,
          templateCoordinateInstruction: templateCoordinate?.promptInstruction,
          contentPlanSha256: expectedContentPlanSha256,
        }),
        attachments: await sourceAttachments(operationToken, client),
        structuredOutputSchema: nativeSourceReceiptOutputSchema({
          operationToken,
          baseSourceSha256,
          contractVersion: nativeSourceContractVersion,
          runtime: nativeSourceRuntime,
          contentPlanSha256: expectedContentPlanSha256,
        }),
      });
    } catch (error) {
      if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
        return pending(unknownState, taskId, "design_compiling", 10_000);
      }
      if (error instanceof ManusV2ApiError && error.retryable) {
        const retryAfterMs = Math.max(
          2_000,
          Math.min(300_000, error.retryAfterMs ?? 10_000),
        );
        const retryState = transitionProviderState(unknownState, {
          stage: "native_source_send_ready",
          providerSyncStartedAt: undefined,
          providerNextPollAt: new Date(Date.now() + retryAfterMs).toISOString(),
        });
        await persistOperationProgress(
          input.db,
          input.operation,
          retryState,
          taskId,
        );
        return pending(retryState, taskId, "design_compiling", retryAfterMs);
      }
      throw error;
    }
    currentState = transitionProviderState(unknownState, {
      stage: "native_source_pending",
      providerSyncStartedAt: undefined,
      buildPhase: "source_waiting",
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
    return pending(currentState, taskId, "building", 5_000);
  }
  if (
    !dynamicInformationArchitecture &&
    shouldMaterializeNativeInitialBaseline({
      bundleSchemaVersion: input.nativeSelection.bundle.schemaVersion,
      parentBuildId: input.context.build.parentBuildId,
      hasPreview: Boolean(
        input.context.build.contractLocalAssetId ||
          input.context.build.sourceLocalAssetId ||
          input.context.build.distLocalAssetId ||
          input.context.build.qaLocalAssetId ||
          input.context.build.provenanceLocalAssetId,
      ),
      hasFallback: Boolean(
        currentState?.schemaVersion === 2 && currentState.fallbackPreview,
      ),
      nativeRepairAttempt: attempt,
    })
  ) {
    const baseline = await materializeTrustedFallback("initial_baseline");
    // A successfully staged baseline must be bound by the worker before any
    // provider side effect. A local baseline failure is diagnostic only: it
    // must never starve a safe GET or prevent the provider task from starting.
    if (baseline && nativeInitialBaselineShouldYield(currentState)) {
      return baseline;
    }
  }
  if (!taskId) {
    if (
      nativeSourceContractVersion === 2 &&
      !frozenRuntimeCoordinates &&
      input.state?.stage !== "create_unknown"
    ) {
      currentState = transitionProviderState(currentState, {
        stage: currentState?.stage ?? "native_input_ready",
        nativeSourceContractVersion: 2,
        nativeSourceRuntimeCoordinates: nativeSourceRuntime!.coordinates,
        nativeRepairAttempt: 0,
        buildPhase: "source_waiting",
      });
      await persistOperationProgress(input.db, input.operation, currentState);
    }
    client = client ?? (await input.getClient());
    if (input.state?.stage === "create_unknown") {
      const found = await findUniqueCreatedTask(
        client,
        input.operation,
        operationToken,
      );
      if (!found) {
        const sync = providerResultSyncWindow(
          providerStateV2(currentState),
          Date.now(),
          input.operation.updatedAt,
        );
        if (sync.expired) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
            "AI 建站任务创建结果未能在限定时间内确认；基础预览与创建坐标已保留。",
            "attention_required",
            sync.state,
          );
        }
        return pending(sync.state, undefined, "qa_running", 60_000);
      }
      taskId = found.id;
    } else {
      const createRetryAt = Date.parse(
        currentState?.schemaVersion === 2
          ? (currentState.providerNextPollAt ?? "")
          : "",
      );
      if (Number.isFinite(createRetryAt) && createRetryAt > Date.now()) {
        return pending(
          currentState!,
          undefined,
          "qa_running",
          Math.max(2_000, createRetryAt - Date.now()),
        );
      }
      const createAttachments = await sourceAttachments(operationToken, client);
      const createUnknownState = startProviderResultSyncWindow(
        transitionProviderState(currentState, {
          stage: "create_unknown",
          nativeSourceContractVersion: 2,
          nativeSourceRuntimeCoordinates: nativeSourceRuntime!.coordinates,
          nativeRepairAttempt: 0,
          buildPhase: "source_waiting",
        }),
      );
      await persistOperationProgress(
        input.db,
        input.operation,
        createUnknownState,
      );
      currentState = createUnknownState;
      try {
        await input.assertExecutionActive();
        const created = await client.createTask({
          title: operationTitle(input.operation),
          prompt: nativeSourcePrompt({
            operationToken,
            baseSourceSha256,
            contractVersion: nativeSourceContractVersion,
            runtimeCoordinates: nativeSourceRuntime?.coordinates ?? null,
            workflowVersion: input.context.build.workflowVersion,
            hasCustomerFeedback: Boolean(input.input.feedback),
            hasRevisionMedia: Boolean(revisionSource?.media.length),
            hasRevisionBaseline: Boolean(revisionSource),
            hasKnowledgeMedia: knowledgeMedia.length > 0,
            templateCoordinateInstruction:
              templateCoordinate?.promptInstruction,
            contentPlanSha256: expectedContentPlanSha256,
          }),
          attachments: createAttachments,
          locale: input.brief.primaryLanguage,
          agentProfile: managedAgentProfileModel(input.input.agentProfile),
          structuredOutputSchema: nativeSourceReceiptOutputSchema({
            operationToken,
            baseSourceSha256,
            contractVersion: nativeSourceContractVersion,
            runtime: nativeSourceRuntime,
            contentPlanSha256: expectedContentPlanSha256,
          }),
        });
        taskId = created.taskId;
      } catch (error) {
        if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
          return pending(createUnknownState, undefined, "qa_running", 60_000);
        }
        if (error instanceof ManusV2ApiError && error.retryable) {
          const retryAfterMs = Math.max(
            2_000,
            Math.min(300_000, error.retryAfterMs ?? 10_000),
          );
          const retryReadyState = transitionProviderState(createUnknownState, {
            stage: "native_input_ready",
            providerSyncStartedAt: undefined,
            providerNextPollAt: new Date(
              Date.now() + retryAfterMs,
            ).toISOString(),
          });
          try {
            await persistOperationProgress(
              input.db,
              input.operation,
              retryReadyState,
            );
            currentState = retryReadyState;
            return pending(
              retryReadyState,
              undefined,
              "qa_running",
              retryAfterMs,
            );
          } catch {
            // The durable create_unknown fence is safer than retrying when the
            // explicit-rejection retry journal itself could not be committed.
            return pending(createUnknownState, undefined, "qa_running", 60_000);
          }
        }
        throw error;
      }
    }
    const pendingState = transitionProviderState(currentState, {
      stage: "native_source_pending",
      taskId,
      nativeRepairAttempt: 0,
      phaseOperationToken: operationToken,
      phaseStartedAt: new Date().toISOString(),
      resultPendingSince: undefined,
      resultPendingOperationToken: undefined,
      providerStoppedAt: undefined,
      providerStoppedOperationToken: undefined,
      providerSyncStartedAt: undefined,
      buildPhase: "source_waiting",
    });
    await bindCreatedBuildTask({
      db: input.db,
      operation: input.operation,
      buildId: input.context.build.id,
      taskId,
      state: pendingState,
      preservePreview: Boolean(
        currentState?.schemaVersion === 2 && currentState.fallbackPreview,
      ),
    });
    return pending(
      pendingState,
      taskId,
      "qa_running",
      fallbackReconciliationPollMs(),
    );
  }

  if (boundBuildTaskId !== null && boundBuildTaskId !== taskId) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_RESULT_PENDING",
      "FrontMind AI 建站任务坐标仍在确认中，系统不会混用源码。",
      "failed",
    );
  }
  if (boundBuildTaskId === null) {
    const rebound = await input.db
      .update(siteBuilds)
      .set({
        upstreamManusTaskId: taskId,
        status:
          currentState?.schemaVersion === 2 && currentState.fallbackPreview
            ? "qa_running"
            : "design_compiling",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteBuilds.id, input.context.build.id),
          eq(siteBuilds.userId, input.operation.userId),
          inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
          isNull(siteBuilds.upstreamManusTaskId),
        ),
      );
    const affectedRows = Number(
      (Array.isArray(rebound)
        ? (rebound[0] as { affectedRows?: unknown } | undefined)?.affectedRows
        : (rebound as { affectedRows?: unknown } | undefined)?.affectedRows) ??
        0,
    );
    if (affectedRows !== 1) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_RESULT_PENDING",
        "FrontMind AI 建站任务坐标仍在确认中，系统不会混用源码。",
        "failed",
      );
    }
    boundBuildTaskId = taskId;
  }
  const scheduleNativeRepair = async (repairInput: {
    kind: "compile" | "hard_safety";
    signature: string;
    diagnostics: readonly {
      code: string;
      file: string | null;
      line: number | null;
      column: number | null;
    }[];
  }) => {
    if (
      nativeSourceContractVersion === 1 ||
      attempt >= NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS ||
      currentState?.nativeLastErrorSignature === repairInput.signature ||
      (currentState?.schemaVersion === 2 && currentState.existingTaskOnly)
    ) {
      return null;
    }
    const nextAttempt = attempt + 1;
    const nextToken = `siteops-native-source:${input.operation.id}:${nextAttempt}`;
    const repair = nativeSourceRepairInputSchema.parse({
      attempt: nextAttempt,
      kind: repairInput.kind,
      diagnostics: repairInput.diagnostics.slice(0, 32),
    });
    const readyState = nativeRepairAttemptState({
      state: currentState,
      taskId,
      repairAttempt: nextAttempt,
      operationToken: nextToken,
      errorSignature: repairInput.signature,
      stage: "native_repair_send_ready",
      repair,
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      readyState,
      taskId,
    );
    currentState = readyState;
    return sendPreparedNativeRepair(repair, readyState);
  };
  const sendPreparedNativeRepair = async (
    repair: NativeSourceRepairInput,
    readyState: ProviderStateV2,
  ) => {
    const nextToken = readyState.phaseOperationToken;
    if (!nextToken || readyState.nativeRepairAttempt !== repair.attempt) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_NATIVE_REPAIR_REPLAY_UNAVAILABLE",
        "AI 建站修复轮次缺少可重放坐标；请申请重置后从当前企业知识库重新开始。",
        "failed",
        readyState,
      );
    }
    const clearedReadyState = clearedNativeRepairIntakeState(readyState);
    currentState = clearedReadyState;
    await input.assertExecutionActive();
    client = client ?? (await input.getClient());
    const repairAttachments = await sourceAttachments(
      nextToken,
      client,
      repair,
    );
    await input.assertExecutionActive();
    const unknownState = startProviderResultSyncWindow(
      transitionProviderState(currentState, {
        stage: "native_repair_send_unknown",
        nativeRepairInput: repair,
        nativeRepairAttempt: repair.attempt,
        phaseOperationToken: nextToken,
        buildPhase: "source_repairing",
        providerSyncStartedAt: undefined,
      }),
    );
    await persistOperationProgress(
      input.db,
      input.operation,
      unknownState,
      taskId,
    );
    currentState = unknownState;
    try {
      await client.sendMessage({
        taskId,
        prompt: nativeSourcePrompt({
          operationToken: nextToken,
          baseSourceSha256,
          contractVersion: nativeSourceContractVersion,
          runtimeCoordinates: nativeSourceRuntime?.coordinates ?? null,
          workflowVersion: input.context.build.workflowVersion,
          hasCustomerFeedback: Boolean(input.input.feedback),
          hasRevisionMedia: Boolean(revisionSource?.media.length),
          hasRevisionBaseline: Boolean(revisionSource),
          hasKnowledgeMedia: knowledgeMedia.length > 0,
          templateCoordinateInstruction: templateCoordinate?.promptInstruction,
          contentPlanSha256: expectedContentPlanSha256,
          repair,
        }),
        attachments: repairAttachments,
        structuredOutputSchema: nativeSourceReceiptOutputSchema({
          operationToken: nextToken,
          baseSourceSha256,
          contractVersion: nativeSourceContractVersion,
          runtime: nativeSourceRuntime,
          contentPlanSha256: expectedContentPlanSha256,
        }),
      });
    } catch (sendError) {
      if (sendError instanceof ManusV2ApiError && sendError.outcomeUnknown) {
        return pending(unknownState, taskId, "qa_running");
      }
      if (sendError instanceof ManusV2ApiError && sendError.retryable) {
        const retryAfterMs = Math.max(
          2_000,
          Math.min(300_000, sendError.retryAfterMs ?? 10_000),
        );
        const retryReadyState = transitionProviderState(unknownState, {
          stage: "native_repair_send_ready",
          nativeRepairInput: repair,
          providerSyncStartedAt: undefined,
          providerNextPollAt: new Date(Date.now() + retryAfterMs).toISOString(),
        });
        try {
          await persistOperationProgress(
            input.db,
            input.operation,
            retryReadyState,
            taskId,
          );
          currentState = retryReadyState;
          return pending(retryReadyState, taskId, "qa_running", retryAfterMs);
        } catch {
          return pending(unknownState, taskId, "qa_running");
        }
      }
      throw sendError;
    }
    const repairState = transitionProviderState(unknownState, {
      stage: "native_repair_pending",
      nativeRepairInput: undefined,
      providerSyncStartedAt: undefined,
      buildPhase: "source_repairing",
    });
    delete repairState.nativeRepairInput;
    try {
      await persistOperationProgress(
        input.db,
        input.operation,
        repairState,
        taskId,
      );
    } catch {
      return pending(unknownState, taskId, "qa_running");
    }
    logManusBuildStage({
      stage: "native_repair_scheduled",
      operationId: input.operation.id,
      buildId: input.context.build.id,
      reason: repair.kind,
      signature: readyState.nativeLastErrorSignature,
    });
    return pending(repairState, taskId, "qa_running");
  };
  if (
    currentState?.schemaVersion === 2 &&
    currentState.stage === "native_repair_send_ready"
  ) {
    const retryAt = Date.parse(currentState.providerNextPollAt ?? "");
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      return pending(
        currentState,
        taskId,
        "qa_running",
        Math.max(2_000, retryAt - Date.now()),
      );
    }
    const replay = nativeSourceRepairInputSchema.safeParse(
      currentState.nativeRepairInput,
    );
    if (
      !replay.success ||
      replay.data.attempt !== attempt ||
      currentState.phaseOperationToken !== operationToken
    ) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_NATIVE_REPAIR_REPLAY_UNAVAILABLE",
        "AI 建站修复轮次缺少可重放输入；请申请重置后从当前企业知识库重新开始。",
        "failed",
        currentState,
      );
    }
    return sendPreparedNativeRepair(replay.data, currentState);
  }
  const sourceReceiptSchema =
    nativeSourceContractVersion === 2
      ? nativeSourceRuntime!.receiptSchema
      : siteSourceReceiptV1Schema;
  const contextualSourceReceiptSchema = expectedContentPlanSha256
    ? sourceReceiptSchema.refine(
        (receipt) =>
          "contentPlanSha256" in receipt &&
          receipt.contentPlanSha256 === expectedContentPlanSha256,
        "Source receipt must match the frozen content plan",
      )
    : sourceReceiptSchema;
  const stagingIdempotencyKey = `native-source:${operationToken}`;
  const stagingAssetId = siteOpsArtifactIdForIdempotency({
    userId: input.operation.userId,
    projectId: input.operation.projectId,
    kind: "site-source-staging",
    idempotencyKey: stagingIdempotencyKey,
  });
  let offlineResume: Awaited<ReturnType<typeof readNativeSourceOfflineResume>>;
  try {
    offlineResume = await readNativeSourceOfflineResume({
      operation: input.operation,
      state: currentState,
      operationToken,
      baseSourceSha256,
      expectedContentPlanSha256,
      stagingAssetId,
      taskId,
      buildTaskId: boundBuildTaskId,
      repairAttempt: attempt,
      receiptSchema: contextualSourceReceiptSchema,
      readArtifact: input.readArtifact,
    });
  } catch (error) {
    if (error instanceof SiteOpsManusFailure) throw error;
    return pending(providerStateV2(currentState), taskId, "qa_running", 10_000);
  }
  if (!offlineResume && input.state?.stage === "native_repair_send_unknown") {
    let reconciled: Awaited<ReturnType<typeof pollEvents>>;
    try {
      client = client ?? (await input.getClient());
      reconciled = await pollEvents(
        client,
        taskId,
        operationToken,
        input.state,
        {
          operationId: input.operation.id,
          buildId: input.context.build.id,
        },
      );
    } catch (error) {
      if (
        error instanceof SiteOpsManusFailure &&
        error.code === "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION"
      ) {
        currentState = error.result
          ? providerStateSchema.parse(error.result)
          : currentState;
        const trigger = nativeTrustedFallbackAttentionReason({
          state: currentState,
          operation: input.operation,
        });
        if (trigger) {
          const fallback = await materializeTrustedFallback(trigger);
          if (fallback) return fallback;
        }
      }
      throw error;
    }
    if (reconciled.deferred) {
      currentState = reconciled.providerState;
      const fallback = await materializeTrustedFallback(
        "provider_read_delayed",
      );
      if (fallback) return fallback;
      throwIfExistingFallbackExpired();
      return pending(
        reconciled.providerState,
        taskId,
        "qa_running",
        reconciled.nextPollMs,
      );
    }
    if (
      !manusV2EventsContainOperationToken(reconciled.events, operationToken)
    ) {
      currentState = reconciled.providerState;
      throwIfExistingFallbackExpired();
      const sync = providerResultSyncWindow(
        reconciled.providerState,
        Date.now(),
        input.operation.updatedAt,
      );
      const grace = structuredResultGrace(
        sync.state,
        reconciled.state.completed,
      );
      if (grace.expired || sync.expired) {
        currentState = providerStateSchema.parse(grace.state);
        const fallback = await materializeTrustedFallback(
          "provider_stopped_without_result",
        );
        if (fallback) return fallback;
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
          "AI 建站修复结果未能在限定时间内同步，已保留同一任务坐标等待处理。",
          "attention_required",
          grace.state,
        );
      }
      return pending(
        grace.state,
        taskId,
        "qa_running",
        fallbackReconciliationPollMs() ?? reconciled.nextPollMs,
      );
    }
    const pendingState = transitionProviderState(reconciled.providerState, {
      stage: "native_repair_pending",
      nativeRepairInput: undefined,
      buildPhase: "source_repairing",
      providerSyncStartedAt: undefined,
    });
    delete pendingState.nativeRepairInput;
    return pending(
      pendingState,
      taskId,
      "qa_running",
      fallbackReconciliationPollMs(),
    );
  }

  let polled: Awaited<ReturnType<typeof pollEvents>> | null = null;
  if (!offlineResume) {
    try {
      client = client ?? (await input.getClient());
      polled = await pollEvents(client, taskId, operationToken, currentState, {
        operationId: input.operation.id,
        buildId: input.context.build.id,
      });
    } catch (error) {
      if (
        error instanceof SiteOpsManusFailure &&
        error.code === "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION"
      ) {
        currentState = error.result
          ? providerStateSchema.parse(error.result)
          : currentState;
        const trigger = nativeTrustedFallbackAttentionReason({
          state: currentState,
          operation: input.operation,
        });
        if (trigger) {
          const fallback = await materializeTrustedFallback(trigger);
          if (fallback) return fallback;
        }
      }
      throw error;
    }
    currentState = polled.providerState;
  }
  if (polled?.deferred) {
    const fallback = await materializeTrustedFallback("provider_read_delayed");
    if (fallback) return fallback;
    throwIfExistingFallbackExpired();
    return pending(
      polled.providerState,
      taskId,
      attempt > 0 ? "qa_running" : "building",
      fallbackReconciliationPollMs() ?? polled.nextPollMs,
    );
  }
  const receiptResolution = offlineResume
    ? { invalid: false as const, value: offlineResume.receipt }
    : await resolveBuildWireValue({
        operationId: input.operation.id,
        buildId: input.context.build.id,
        events: polled!.events,
        operationToken,
        phase: "design",
        expectedFilename: FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME,
        taskCompleted: polled!.state.completed,
        acceptCurrentPhaseWhileRunning: true,
        signal: input.signal,
        validateCandidate: (value) => {
          contextualSourceReceiptSchema.parse(value);
        },
      });
  if (receiptResolution.invalid) {
    throw new SiteOpsManusFailure(
      "SITEOPS_NATIVE_SOURCE_RECEIPT_INVALID",
      "AI 建站源码回执未通过结构与任务绑定校验。",
      "failed",
    );
  }
  const attachment = offlineResume
    ? null
    : nativeSourceOutputAttachment(polled!.events, operationToken);
  const currentNativeAttachmentScope = nativeSourceAttachmentScopeSchema.parse({
    taskId,
    repairAttempt: attempt,
    operationToken,
  });
  const priorNativeFileId =
    input.state?.schemaVersion === 2
      ? input.state.nativeSourceFileId
      : undefined;
  const priorNativeAttachmentEventId =
    input.state?.schemaVersion === 2
      ? input.state.nativeSourceAttachmentEventId
      : undefined;
  const priorNativeAttachmentIdentity =
    input.state?.schemaVersion === 2
      ? input.state.nativeSourceAttachmentIdentity
      : undefined;
  // Historical V1 tasks froze these three phase coordinates separately.
  // Recompose their exact scope for same-phase reads without upgrading the
  // task contract or permitting a cross-attempt attachment drift.
  const historicalNativeAttachmentScope =
    input.state?.schemaVersion === 2 &&
    !input.state.nativeSourceContractVersion &&
    input.state.taskId &&
    input.state.nativeRepairAttempt !== undefined &&
    input.state.phaseOperationToken
      ? nativeSourceAttachmentScopeSchema.parse({
          taskId: input.state.taskId,
          repairAttempt: input.state.nativeRepairAttempt,
          operationToken: input.state.phaseOperationToken,
        })
      : undefined;
  const priorNativeAttachmentScope =
    input.state?.schemaVersion === 2
      ? (input.state.nativeSourceAttachmentScope ??
        historicalNativeAttachmentScope)
      : undefined;
  const sameNativeAttachmentScope = nativeSourceAttachmentScopeMatches(
    priorNativeAttachmentScope,
    currentNativeAttachmentScope,
  );
  if (
    attachment &&
    nativeSourceAttachmentIdentityConflicts({
      priorFileId: priorNativeFileId,
      priorAttachmentIdentity: priorNativeAttachmentIdentity,
      priorEventId: priorNativeAttachmentEventId,
      priorScope: priorNativeAttachmentScope,
      currentScope: currentNativeAttachmentScope,
      attachment,
    })
  ) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_SOURCE_ATTACHMENT_IDENTITY_CONFLICT",
      "AI 建站源码附件身份与已冻结任务坐标不一致，系统已停止采用该结果。",
      "attention_required",
      polled?.providerState ?? currentState ?? undefined,
    );
  }
  if (!receiptResolution.value || (!attachment && !offlineResume)) {
    // A complete, valid receipt+attachment wins even at the deadline so a
    // formal result can atomically replace the fallback. When the same-task
    // GET succeeds but still yields no adoptable result, the fixed window
    // must terminalize instead of silently returning pending forever.
    throwIfExistingFallbackExpired();
    if (!polled) {
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
        "已暂存源码缺少可恢复的冻结回执坐标。",
        "attention_required",
        currentState ?? undefined,
      );
    }
    const missingOutputState = (
      state: ProviderState,
      waiting?: { eventId: string; handledAt: string },
    ) =>
      transitionProviderState(state, {
        stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
        taskId,
        nativeRepairAttempt: attempt,
        buildPhase: attempt > 0 ? "source_repairing" : "source_waiting",
        ...(waiting
          ? {
              handledWaitingEventId: waiting.eventId,
              handledWaitingAt: waiting.handledAt,
            }
          : {}),
      });
    const repairMissingOutput = async (state: ProviderState) => {
      currentState = state;
      const scheduled = await scheduleNativeRepair({
        kind: "hard_safety",
        signature: NATIVE_SOURCE_OUTPUT_UNAVAILABLE_SIGNATURE,
        diagnostics: [
          {
            code: NATIVE_SOURCE_OUTPUT_UNAVAILABLE_CODE,
            file: null,
            line: null,
            column: null,
          },
        ],
      });
      if (scheduled) return scheduled;
      throw new SiteOpsManusFailure(
        NATIVE_SOURCE_OUTPUT_UNAVAILABLE_CODE,
        "AI 建站未返回完整源码包和回执。",
        "failed",
        state,
      );
    };
    const terminalErrorType = dynamicInformationArchitecture
      ? nativeSourceTerminalErrorType(polled.events, operationToken)
      : null;
    if (
      terminalErrorType &&
      NON_RETRYABLE_PROVIDER_QUOTA_ERROR_TYPES.has(terminalErrorType) &&
      (polled.state.failed || polled.state.completed || Boolean(polled.waiting))
    ) {
      // Provider detail and message reads are independent and may briefly
      // disagree (for example detail=error while the latest status event is
      // still waiting). A typed quota terminal always wins before any wait or
      // missing-output repair so it can never create another billable send.
      throw new SiteOpsManusFailure(
        "FRONTMIND_BUILD_CONFIGURATION_ERROR",
        "FrontMind AI 建站服务额度暂不可用，系统已保留当前任务坐标并停止重发。",
        "attention_required",
        missingOutputState(polled.providerState),
      );
    }
    if (dynamicInformationArchitecture && polled.waiting) {
      if (!messageAskUserWaiting(polled.waiting)) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
          "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
          "failed",
          polled.providerState,
        );
      }
      const resolution = handledWaitingResolution(
        polled.providerState,
        polled.waiting.eventId,
      );
      if (resolution === "pending") {
        return pending(
          polled.providerState,
          taskId,
          attempt > 0 ? "qa_running" : "building",
          fallbackReconciliationPollMs(),
        );
      }
      if (resolution === "expired") {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_WAITING_UNRESOLVED",
          "FrontMind AI 建站任务在安全继续后仍未恢复输出。",
          "failed",
          polled.providerState,
        );
      }
      return repairMissingOutput(
        missingOutputState(polled.providerState, {
          eventId: polled.waiting.eventId,
          handledAt: new Date().toISOString(),
        }),
      );
    }
    if (dynamicInformationArchitecture && polled.state.failed) {
      return repairMissingOutput(missingOutputState(polled.providerState));
    }
    if (polled.waiting || polled.state.failed) {
      throw new SiteOpsManusFailure(
        NATIVE_SOURCE_OUTPUT_UNAVAILABLE_CODE,
        "AI 建站未返回完整源码包和回执。",
        "failed",
      );
    }
    const pendingState = transitionProviderState(polled.providerState, {
      stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
      taskId,
      nativeRepairAttempt: attempt,
      buildPhase: attempt > 0 ? "source_repairing" : "source_waiting",
    });
    const grace = structuredResultGrace(
      pendingState,
      polled.state.completed,
      Date.now(),
      operationToken,
    );
    if (grace.expired) {
      currentState = providerStateSchema.parse(grace.state);
      if (dynamicInformationArchitecture) {
        return repairMissingOutput(missingOutputState(currentState));
      }
      const fallback = await materializeTrustedFallback(
        "provider_stopped_without_result",
      );
      if (fallback) return fallback;
      throw new SiteOpsManusFailure(
        input.state?.schemaVersion === 2 && input.state.existingTaskOnly
          ? "FRONTMIND_BUILD_SOURCE_ATTACHMENT_REQUIRES_ATTENTION"
          : "SITEOPS_NATIVE_SOURCE_OUTPUT_UNAVAILABLE",
        input.state?.schemaVersion === 2 && input.state.existingTaskOnly
          ? "历史 AI 建站任务未返回仍可读取的源码附件，已保留任务坐标等待处理。"
          : "AI 建站未返回完整源码包和回执。",
        input.state?.schemaVersion === 2 && input.state.existingTaskOnly
          ? "attention_required"
          : "failed",
        grace.state,
      );
    }
    return pending(
      grace.state,
      taskId,
      attempt > 0 ? "qa_running" : "building",
      fallbackReconciliationPollMs(),
    );
  }
  const receipt = contextualSourceReceiptSchema.parse(receiptResolution.value);
  if (
    expectedContentPlanSha256 !== undefined &&
    (!("contentPlanSha256" in receipt) ||
      receipt.contentPlanSha256 !== expectedContentPlanSha256)
  ) {
    throw new SiteOpsManusFailure(
      "SITEOPS_CONTENT_PLAN_SOURCE_RECEIPT_MISMATCH",
      "AI 源码回执未绑定当前冻结的信息架构计划。",
      "failed",
      providerStateV2(currentState),
    );
  }
  const rejectedCandidate =
    currentState?.schemaVersion === 2
      ? currentState.nativeRejectedCandidateV1
      : undefined;
  const rejectedAttachmentIdentity =
    attachment?.attachmentIdentity ??
    (currentState?.schemaVersion === 2
      ? currentState.nativeSourceAttachmentIdentity
      : undefined);
  if (
    rejectedAttachmentIdentity &&
    nativeRejectedCandidateMatches(rejectedCandidate, {
      taskId,
      repairAttempt: attempt,
      operationToken,
      attachmentIdentity: rejectedAttachmentIdentity,
      archiveSha256: receipt.archiveSha256,
      validatorVersion: NATIVE_SOURCE_VALIDATOR_VERSION,
    })
  ) {
    // The provider GET is intentionally still performed above so a new
    // attachment identity or receipt hash can supersede this verdict. The
    // exact rejected candidate, however, must never be downloaded, expanded,
    // compiled, charged, or sent back to Manus again.
    const fallback = await materializeTrustedFallback(
      "repair_budget_exhausted",
    );
    if (fallback) return fallback;
    throwIfExistingFallbackExpired();
    throw new SiteOpsManusFailure(
      rejectedCandidate!.errorCode,
      "AI 建站返回的同一源码包已通过确定性判定为不可安全采用。",
      "failed",
      providerStateV2(currentState),
    );
  }
  if (!offlineResume) {
    if (!polled || !attachment) {
      throw new Error("SITEOPS_NATIVE_SOURCE_PROVIDER_COORDINATES_MISSING");
    }
    currentState = transitionProviderState(polled.providerState, {
      stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
      taskId,
      nativeRepairAttempt: attempt,
      buildPhase: "source_validating",
      buildCheckpoint: "receipt_validated",
      nativeSourceFileId:
        attachment.fileId ??
        (sameNativeAttachmentScope ? priorNativeFileId : undefined),
      nativeSourceAttachmentEventId: attachment.eventId,
      nativeSourceAttachmentIdentity: attachment.attachmentIdentity,
      nativeSourceAttachmentScope: currentNativeAttachmentScope,
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
    logManusBuildStage({
      stage: "source_receipt_validated",
      operationId: input.operation.id,
      buildId: input.context.build.id,
    });
  }
  let validated: Awaited<ReturnType<typeof validateNativeReactSourceArchive>>;
  const claimedStaging =
    currentState?.schemaVersion === 2
      ? currentState.nativeSourceStaging
      : undefined;
  if (
    claimedStaging &&
    (claimedStaging.assetId !== stagingAssetId ||
      claimedStaging.sha256 !== receipt.archiveSha256)
  ) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
      "已暂存源码与当前任务回执坐标不一致，系统已停止采用该结果。",
      "attention_required",
      currentState ?? undefined,
    );
  }
  if (claimedStaging && Date.parse(claimedStaging.expiresAt) <= Date.now()) {
    throw new SiteOpsManusFailure(
      "FRONTMIND_BUILD_STAGED_SOURCE_EXPIRED",
      "已校验源码的 24 小时恢复窗口已结束，任务坐标已保留等待处理。",
      "attention_required",
      currentState ?? undefined,
    );
  }
  try {
    let archive: Buffer | null = offlineResume?.archive ?? null;
    let stagingExpiresAt: Date | null =
      offlineResume?.expiresAt ??
      (claimedStaging ? new Date(claimedStaging.expiresAt) : null);
    if (
      !archive &&
      (!stagingExpiresAt || stagingExpiresAt.getTime() > Date.now())
    ) {
      const stagedArtifact = await input.readArtifact({
        userId: input.operation.userId,
        localAssetId: stagingAssetId,
        expectedSha256: receipt.archiveSha256,
        expectedMimeTypes: [FRONTMIND_SITE_SOURCE_ARCHIVE_MIME],
      });
      if (stagedArtifact) {
        const rowExpiry = stagedArtifact.row.retainUntil;
        stagingExpiresAt =
          stagingExpiresAt ?? (rowExpiry instanceof Date ? rowExpiry : null);
        if (!stagingExpiresAt || stagingExpiresAt.getTime() <= Date.now()) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_STAGED_SOURCE_EXPIRED",
            "已校验源码的 24 小时恢复窗口已结束，任务坐标已保留等待处理。",
            "attention_required",
            currentState ?? undefined,
          );
        }
        if (stagingExpiresAt && stagingExpiresAt.getTime() > Date.now()) {
          archive = await storedArtifactBytes(
            stagedArtifact,
            NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes,
          );
          if (claimedStaging && archive.length !== claimedStaging.bytes) {
            throw new SiteOpsManusFailure(
              "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
              "已暂存源码大小与当前任务回执坐标不一致。",
              "attention_required",
              currentState ?? undefined,
            );
          }
        }
      }
    }
    if (!archive) {
      if (!attachment) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
          "已暂存源码缺少可恢复文件，系统已停止采用该结果。",
          "attention_required",
          currentState ?? undefined,
        );
      }
      archive = await readNativeSourceAttachment({
        attachment,
        signal: input.signal,
      });
      currentState = transitionProviderState(currentState, {
        stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
        taskId,
        lastContractProgressAt: new Date().toISOString(),
        buildPhase: "source_validating",
        buildCheckpoint: "archive_downloaded",
        nativeSourceReadFailureCount: undefined,
        nativeSourceReadFailureSince: undefined,
        nativeSourceNextPollAt: undefined,
      });
      await persistOperationProgress(
        input.db,
        input.operation,
        currentState,
        taskId,
      );
      logManusBuildStage({
        stage: "source_archive_downloaded",
        operationId: input.operation.id,
        buildId: input.context.build.id,
        byteCount: archive.length,
      });
    }
    validated =
      nativeSourceContractVersion === 2
        ? await nativeSourceRuntime!.validate({
            archive,
            receipt,
            expectedOperationToken: operationToken,
            expectedBaseSourceSha256: baseSourceSha256,
            expectedExecutionBaselineSha256: baseSourceSha256,
            expectedContentPlanSha256,
          })
        : await validateNativeReactSourceArchive({
            archive,
            receipt,
            expectedOperationToken: operationToken,
            expectedBaseSourceSha256: baseSourceSha256,
            requiredReceiptVersion: 1,
          });
    if (nativeSourceContractVersion === 2) {
      const routeAudit = nativeSourceRuntime!.audit({
        files: validated.files,
        expectedRoutePaths: effectiveBrief.routes.map((route) => route.slug),
        requireCanonicalSitePathname: dynamicInformationArchitecture,
      });
      if (!routeAudit.ok) {
        throw new NativeRuntimeContractAuditError(routeAudit);
      }
    }
    if (requiredRevisionMedia.length > 0) {
      const sourceText = [...validated.files.entries()]
        .filter(([pathname]) =>
          /\.(?:css|html|js|jsx|mjs|ts|tsx)$/iu.test(pathname),
        )
        .map(([, bytes]) => bytes.toString("utf8"))
        .join("\n");
      const issues: Array<NativeRuntimeAudit["issues"][number]> = [];
      for (const asset of requiredRevisionMedia) {
        const sourcePath = `public${asset.publicPath}`;
        const actual = validated.files.get(sourcePath);
        if (!actual || sha256(actual) !== asset.contentSha256) {
          issues.push({
            code: "REQUIRED_FILE_MISSING",
            path: sourcePath,
            detail: "The frozen user media file is missing or changed.",
          });
          continue;
        }
        if (!sourceText.includes(asset.publicPath)) {
          issues.push({
            code: "APP_SHELL_INVALID",
            path: sourcePath,
            detail:
              "The frozen user media public URL is not referenced by the site source.",
          });
        }
      }
      if (issues.length > 0) {
        throw new NativeRuntimeContractAuditError({ ok: false, issues });
      }
    }
    if (!stagingExpiresAt || stagingExpiresAt.getTime() <= Date.now()) {
      stagingExpiresAt = new Date(
        Date.now() + NATIVE_SOURCE_STAGING_RETENTION_MS,
      );
      const stagedArtifact = await input.persist({
        userId: input.operation.userId,
        projectId: input.operation.projectId,
        kind: "site-source-staging",
        filename: `operation-${input.operation.id}-validated-source.zip`,
        mimeType: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
        buffer: validated.sourceZip,
        maxBytes: NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes,
        idempotencyKey: stagingIdempotencyKey,
        retainUntil: stagingExpiresAt,
      });
      if (
        stagedArtifact.id !== stagingAssetId ||
        stagedArtifact.contentSha256 !== validated.archiveSha256 ||
        stagedArtifact.sizeBytes !== validated.sourceZip.length
      ) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
          "源码暂存写入未通过确定性哈希校验。",
          "attention_required",
          currentState ?? undefined,
        );
      }
    }
    currentState = transitionProviderState(currentState, {
      stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
      taskId,
      buildPhase: "compiling",
      buildCheckpoint: "archive_validated",
      nativeSourceStaging: {
        assetId: stagingAssetId,
        sha256: validated.archiveSha256,
        bytes: validated.sourceZip.length,
        expiresAt: stagingExpiresAt.toISOString(),
        taskId,
        repairAttempt: attempt,
        receipt,
      },
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
  } catch (error) {
    if (error instanceof NativeReactSourceError) {
      if (
        currentState?.schemaVersion === 2 &&
        error.code === "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE" &&
        error.retryable
      ) {
        const retry = nativeSourceAttachmentRetryWindow(currentState);
        if (!retry.expired) {
          currentState = retry.state;
          const fallback = await materializeTrustedFallback(
            "provider_read_delayed",
          );
          if (fallback) return fallback;
          return pending(retry.state, taskId, "qa_running", retry.nextPollMs);
        }
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_SOURCE_ATTACHMENT_REQUIRES_ATTENTION",
          "AI 建站任务的源码附件持续 24 小时无法下载；已保留同一任务和附件坐标，未创建或重发任务。",
          "attention_required",
          retry.state,
        );
      }
      if (
        currentState?.schemaVersion === 2 &&
        currentState.existingTaskOnly &&
        (error.code === "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE" ||
          error.code === "NATIVE_SOURCE_ATTACHMENT_INVALID")
      ) {
        throw new SiteOpsManusFailure(
          "FRONTMIND_BUILD_SOURCE_ATTACHMENT_REQUIRES_ATTENTION",
          "历史 AI 建站任务的源码下载地址已不可用；已保留同一任务和附件坐标，未创建或重发任务。",
          "attention_required",
          currentState,
        );
      }
      const runtimeDiagnostics =
        error instanceof NativeRuntimeContractAuditError
          ? error.audit.issues.slice(0, 32).map((issue) => ({
              code: issue.code,
              file: issue.path,
              line: null,
              column: null,
            }))
          : [{ code: error.code, file: null, line: null, column: null }];
      const signature = createHash("sha256")
        .update(
          JSON.stringify({ code: error.code, diagnostics: runtimeDiagnostics }),
          "utf8",
        )
        .digest("hex");
      const rejectionAttachmentIdentity =
        attachment?.attachmentIdentity ??
        (currentState?.schemaVersion === 2
          ? currentState.nativeSourceAttachmentIdentity
          : undefined);
      if (
        !error.retryable &&
        rejectionAttachmentIdentity &&
        error.code !== "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE" &&
        error.code !== "NATIVE_SOURCE_ATTACHMENT_INVALID"
      ) {
        const verdict = createNativeRejectedCandidateV1({
          taskId,
          repairAttempt: attempt,
          operationToken,
          attachmentIdentity: rejectionAttachmentIdentity,
          archiveSha256: receipt.archiveSha256,
          errorCode: error.code,
        });
        currentState = transitionProviderState(currentState, {
          stage:
            attempt > 0 ? "native_repair_pending" : "native_source_pending",
          taskId,
          nativeRepairAttempt: attempt,
          buildPhase: "source_validating",
          nativeRejectedCandidateV1: verdict,
        });
        await persistOperationProgress(
          input.db,
          input.operation,
          currentState,
          taskId,
        );
      }
      const scheduled = await scheduleNativeRepair({
        kind: "hard_safety",
        signature,
        diagnostics: runtimeDiagnostics,
      });
      if (scheduled) return scheduled;
      const fallback = await materializeTrustedFallback(
        "repair_budget_exhausted",
      );
      if (fallback) return fallback;
      throw new SiteOpsManusFailure(
        error.code,
        "AI 建站返回的源码包未通过硬安全校验。",
        "failed",
      );
    }
    throw error;
  }
  logManusBuildStage({
    stage: "source_archive_validated",
    operationId: input.operation.id,
    buildId: input.context.build.id,
    candidateSha256: validated.archiveSha256,
    byteCount: validated.sourceZip.length,
  });
  logManusBuildStage({
    stage: "native_source_intake",
    operationId: input.operation.id,
    buildId: input.context.build.id,
    candidateSha256: validated.archiveSha256,
    byteCount: validated.sourceZip.length,
  });
  let qaUpdated: unknown;
  try {
    qaUpdated = await input.db
      .update(siteBuilds)
      .set({ status: "qa_running", updatedAt: new Date() })
      .where(
        and(
          eq(siteBuilds.id, input.context.build.id),
          eq(siteBuilds.userId, input.operation.userId),
          inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
          eq(siteBuilds.upstreamManusTaskId, taskId),
        ),
      );
  } catch {
    return pending(providerStateV2(currentState), taskId, "qa_running", 10_000);
  }
  const qaAffectedRows = Number(
    (Array.isArray(qaUpdated)
      ? (qaUpdated[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (qaUpdated as { affectedRows?: unknown } | undefined)?.affectedRows) ??
      0,
  );
  if (qaAffectedRows !== 1) {
    throw new Error("SITEOPS_OPERATION_LEASE_LOST");
  }
  let materialized: MaterializedNativeReactSite;
  const materializationStartedAt = Date.now();
  try {
    currentState = transitionProviderState(currentState, {
      stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
      taskId,
      buildPhase: "compiling",
      buildCheckpoint: "compile_started",
    });
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
    logManusBuildStage({
      stage: "native_compile_started",
      operationId: input.operation.id,
      buildId: input.context.build.id,
    });
    await input.assertExecutionActive();
    materialized = await input.materializeNative({
      sourceZip: validated.sourceZip,
      validatedSource: validated,
      build: {
        id: input.context.build.id,
        projectId: input.context.build.projectId,
        knowledgeSnapshotId: input.context.build.knowledgeSnapshotId,
        workflowVersion: input.context.build.workflowVersion,
        selectionHash: input.context.build.selectionHash,
      },
      brief: effectiveBrief,
      mode: "preview",
      abortSignal: input.signal,
      contentPlan: frozenContentPlan ?? undefined,
      contentPlanSha256:
        frozenContentPlanCoordinates?.sha256 ??
        (currentState?.schemaVersion === 2
          ? currentState.contentPlanSha256
          : undefined),
      runtimeAudit:
        nativeSourceContractVersion === 2
          ? nativeSourceRuntime!.audit
          : undefined,
      requiredUserMedia: requiredRevisionMedia.map((asset) => ({
        publicPath: asset.publicPath,
        contentSha256: asset.contentSha256,
      })),
      requiredKnowledgeMedia: knowledgeMedia.map((asset) => ({
        assetId: asset.assetId,
        publicPath: asset.publicPath,
        contentSha256: asset.sha256,
        routePaths: [...(knowledgeMediaRoutePaths.get(asset.assetId) ?? [])],
      })),
    });
    await input.assertExecutionActive();
  } catch (error) {
    if (
      error instanceof NativeReactBuildError &&
      [
        "NATIVE_BUILD_COMPILE_FAILED",
        "NATIVE_BUILD_RENDER_FAILED",
        "NATIVE_BUILD_USER_MEDIA_INVALID",
        "NATIVE_BUILD_CONTENT_PLAN_INVALID",
      ].includes(error.code)
    ) {
      const signature = nativeCompileSignature(error);
      const diagnostics =
        error.diagnostics.length > 0
          ? error.diagnostics
          : [
              {
                code: error.code,
                file: null,
                line: null,
                column: null,
              },
            ];
      const rejectionAttachmentIdentity =
        attachment?.attachmentIdentity ??
        (currentState?.schemaVersion === 2
          ? currentState.nativeSourceAttachmentIdentity
          : undefined);
      if (rejectionAttachmentIdentity) {
        const verdict = createNativeRejectedCandidateV1({
          taskId,
          repairAttempt: attempt,
          operationToken,
          attachmentIdentity: rejectionAttachmentIdentity,
          archiveSha256: receipt.archiveSha256,
          errorCode: error.code,
        });
        currentState = transitionProviderState(currentState, {
          stage:
            attempt > 0 ? "native_repair_pending" : "native_source_pending",
          taskId,
          nativeRepairAttempt: attempt,
          buildPhase: "compiling",
          nativeRejectedCandidateV1: verdict,
        });
        await persistOperationProgress(
          input.db,
          input.operation,
          currentState,
          taskId,
        );
      }
      const scheduled = await scheduleNativeRepair({
        kind:
          error.code === "NATIVE_BUILD_COMPILE_FAILED"
            ? "compile"
            : "hard_safety",
        signature,
        diagnostics,
      });
      if (!scheduled) {
        const fallback = await materializeTrustedFallback(
          "repair_budget_exhausted",
        );
        if (fallback) return fallback;
        throw new SiteOpsManusFailure(
          "BUILD_PRIMARY_RENDER_FAILED",
          "原生 21st 源码连续未能编译，请申请重置后重新生成。",
          "failed",
        );
      }
      return scheduled;
    }
    if (
      error instanceof NativeReactBuildError &&
      String(error.code) === "NATIVE_BUILD_CONTENT_PLAN_INVALID"
    ) {
      const signature = nativeCompileSignature(error);
      const scheduled = await scheduleNativeRepair({
        kind: "hard_safety",
        signature,
        diagnostics: error.diagnostics,
      });
      if (scheduled) return scheduled;
      throw new SiteOpsManusFailure(
        error.code,
        "AI 建站源码在定向修复后仍未遵守冻结的信息架构计划。",
        "failed",
        providerStateV2(currentState),
      );
    }
    if (error instanceof NativeReactSourceError) {
      throw new SiteOpsManusFailure(
        error.code,
        "AI 建站返回的源码包未通过硬安全校验。",
        "failed",
      );
    }
    if (error instanceof NativeReactBuildError) {
      throw new SiteOpsManusFailure(
        error.code,
        "原生 21st 源码未能通过构建或硬安全检查。",
        "failed",
      );
    }
    if (
      error instanceof z.ZodError ||
      (error instanceof SiteOpsMaterializationError &&
        error.retryClass !== "host_transient")
    ) {
      throw error;
    }
    return pending(providerStateV2(currentState), taskId, "qa_running", 10_000);
  }
  logManusBuildStage({
    stage: "native_compile",
    operationId: input.operation.id,
    buildId: input.context.build.id,
    renderMode: materialized.buildDelivery.renderMode,
    qaStatus: materialized.buildDelivery.qaStatus,
    warningCount: materialized.buildDelivery.warningCodes.length,
    latencyMs: Date.now() - materializationStartedAt,
  });
  currentState = transitionProviderState(currentState, {
    stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
    taskId,
    buildPhase: "persisting_preview",
    buildCheckpoint: "compile_started",
  });
  try {
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(error.message)
    ) {
      throw error;
    }
    // archive_validated remains durable; this phase-only write may retry.
  }
  let artifacts: Awaited<ReturnType<typeof persistBuildArtifacts>>;
  try {
    artifacts = await persistBuildArtifacts(
      input.operation,
      materialized,
      input.persist,
      input.assertExecutionActive,
    );
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof SiteOpsMaterializationError ||
      (error instanceof Error &&
        /(?:IDEMPOTENCY_CONFLICT|BODY_MISMATCH|HASH_MISMATCH|COMMIT_LOST)/u.test(
          error.message,
        ))
    ) {
      throw error;
    }
    return pending(providerStateV2(currentState), taskId, "qa_running", 10_000);
  }
  const artifactBindings = buildArtifactBindingsSchema.parse({
    contract: {
      id: artifacts.contract.id,
      sha256: materialized.contractSha256,
      bytes: materialized.contractJson.length,
      mimeType: "application/json",
    },
    source: {
      id: artifacts.source.id,
      sha256: materialized.sourceSha256,
      bytes: materialized.sourceZip.length,
      mimeType: "application/zip",
    },
    dist: {
      id: artifacts.dist.id,
      sha256: materialized.distSha256,
      bytes: materialized.distZip.length,
      mimeType: "application/zip",
    },
    qa: {
      id: artifacts.qa.id,
      sha256: materialized.visualQaSha256,
      bytes: materialized.visualQaZip.length,
      mimeType: "application/zip",
    },
    provenance: {
      id: artifacts.provenance.id,
      sha256: materialized.provenanceSha256,
      bytes: materialized.provenanceJson.length,
      mimeType: "application/json",
    },
  });
  const buildDelivery = buildDeliveryCheckpointSchema.parse(
    materialized.buildDelivery,
  );
  const artifactStaging = formalBuildArtifactStagingSchema.parse({
    schemaVersion: 1,
    generation: "formal",
    projectId: input.operation.projectId,
    buildId: input.context.build.id,
    knowledgeSnapshotId: input.context.build.knowledgeSnapshotId,
    taskId,
    operationToken,
    nativeRepairAttempt: attempt,
    artifactBindings,
    specHash: materialized.contractSha256,
    distHash: materialized.distSha256,
    buildDelivery,
    qaSummary: artifacts.qaSummary,
    expiresAt: artifacts.unboundRetainUntil.toISOString(),
  });
  logManusBuildStage({
    stage: "preview_persisted",
    operationId: input.operation.id,
    buildId: input.context.build.id,
    renderMode: materialized.buildDelivery.renderMode,
    qaStatus: materialized.buildDelivery.qaStatus,
    warningCount: materialized.buildDelivery.warningCodes.length,
    latencyMs: Date.now() - materializationStartedAt,
  });
  logManusBuildStage({
    stage: "artifacts_staged",
    operationId: input.operation.id,
    buildId: input.context.build.id,
    candidateSha256: materialized.distSha256,
    byteCount: materialized.distZip.length,
  });
  currentState = transitionProviderState(currentState, {
    stage: attempt > 0 ? "native_repair_pending" : "native_source_pending",
    taskId,
    buildPhase: "persisting_preview",
    buildCheckpoint: "artifacts_staged",
    artifactStaging,
  });
  try {
    await persistOperationProgress(
      input.db,
      input.operation,
      currentState,
      taskId,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(error.message)
    ) {
      throw error;
    }
    // The returned complete marker is verified by finalize in its existing
    // all-five binding transaction even if this progress-only write failed.
  }
  return {
    status: "succeeded",
    providerTaskId: taskId,
    projectStatus: "preview_ready",
    buildStatus: "preview_ready",
    result: {
      buildId: input.context.build.id,
      buildCheckpoint: "artifacts_staged",
      buildCheckpoints: [
        "receipt_validated",
        "archive_downloaded",
        "archive_validated",
        "compile_started",
        "artifacts_staged",
      ],
      specHash: materialized.contractSha256,
      distHash: materialized.distSha256,
      buildDelivery,
      qaSummary: artifacts.qaSummary,
      artifactIds: {
        contract: artifacts.contract.id,
        source: artifacts.source.id,
        dist: artifacts.dist.id,
        qa: artifacts.qa.id,
        provenance: artifacts.provenance.id,
      },
      artifactBindings,
      artifactStaging,
    },
    message: completedSiteBuildMessage(),
  };
}

async function resolveBuildWireValue(input: {
  operationId: string;
  buildId: string;
  events: readonly ManusV2MessageEvent[];
  operationToken: string;
  phase: SiteOpsWireOutputPhase;
  expectedFilename: string;
  taskCompleted: boolean;
  acceptCurrentPhaseWhileRunning?: boolean;
  signal: AbortSignal;
  validateCandidate?: Parameters<
    typeof resolveSiteOpsWireOutput
  >[0]["validateCandidate"];
}) {
  const startedAt = Date.now();
  try {
    const resolved = await resolveSiteOpsWireOutput(input);
    if (resolved) {
      logManusBuildStage({
        stage: "wire_intake",
        operationId: input.operationId,
        buildId: input.buildId,
        phase: input.phase,
        source: resolved.source,
        byteCount: resolved.byteCount,
        candidateSha256: resolved.sha256,
        latencyMs: Date.now() - startedAt,
      });
      if (resolved.normalizations.length > 0) {
        logManusBuildStage({
          stage: "wire_repaired",
          operationId: input.operationId,
          buildId: input.buildId,
          phase: input.phase,
          source: resolved.source,
          byteCount: resolved.byteCount,
          candidateSha256: resolved.sha256,
          reason: resolved.normalizations.slice().sort().join(","),
          latencyMs: Date.now() - startedAt,
        });
      }
      logManusBuildStage({
        stage: "wire_resolution",
        operationId: input.operationId,
        buildId: input.buildId,
        phase: input.phase,
        source: resolved.source,
        byteCount: resolved.byteCount,
        candidateSha256: resolved.sha256,
        latencyMs: Date.now() - startedAt,
      });
    }
    return {
      value: resolved?.value ?? null,
      candidateSha256: resolved?.sha256 ?? null,
      candidateByteCount: resolved?.byteCount ?? null,
      source: resolved?.source ?? null,
      normalizations: resolved?.normalizations ?? [],
      invalid: false as const,
      invalidCode: null,
      validationError: null,
      invalidCandidateSha256: null,
      invalidCandidateSource: null,
    };
  } catch (error) {
    if (error instanceof SiteOpsWireOutputResolutionError) {
      if (error.code === "SITEOPS_WIRE_OUTPUT_UNAVAILABLE") {
        logManusBuildStage({
          stage: "wire_resolution",
          operationId: input.operationId,
          buildId: input.buildId,
          phase: input.phase,
          reason: error.code,
          latencyMs: Date.now() - startedAt,
        });
        return {
          value: null,
          candidateSha256: null,
          candidateByteCount: null,
          source: null,
          normalizations: [],
          invalid: false as const,
          invalidCode: error.code,
          validationError: error.validationError ?? null,
          invalidCandidateSha256: error.validationCandidate?.sha256 ?? null,
          invalidCandidateSource: error.validationCandidate?.source ?? null,
        };
      }
      logManusBuildStage({
        stage: "wire_resolution",
        operationId: input.operationId,
        buildId: input.buildId,
        phase: input.phase,
        reason: error.code,
        candidateSha256: error.validationCandidate?.sha256,
        source: error.validationCandidate?.source,
        latencyMs: Date.now() - startedAt,
      });
      return {
        value: null,
        candidateSha256: null,
        candidateByteCount: null,
        source: null,
        normalizations: [],
        invalid: true as const,
        invalidCode: error.code,
        validationError: error.validationError ?? null,
        invalidCandidateSha256: error.validationCandidate?.sha256 ?? null,
        invalidCandidateSource: error.validationCandidate?.source ?? null,
      };
    }
    throw error;
  }
}

export function messageAskUserWaiting(
  waiting: ReturnType<typeof latestManusV2WaitingDetail>,
) {
  return (
    waiting?.eventType.replace(/[^a-z]/giu, "").toLowerCase() ===
    "messageaskuser"
  );
}

export function handledWaitingResolution(
  state: ProviderState,
  waitingEventId: string,
  now = Date.now(),
) {
  if (state.handledWaitingEventId !== waitingEventId) return "new" as const;
  const handledAt = state.handledWaitingAt
    ? Date.parse(state.handledWaitingAt)
    : Number.NaN;
  return Number.isFinite(handledAt) && now - handledAt < 120_000
    ? ("pending" as const)
    : ("expired" as const);
}

function pending(
  state: ProviderState,
  taskId?: string,
  buildStatus?:
    | "design_compiling"
    | "contract_ready"
    | "building"
    | "qa_running",
  nextPollMs?: number,
): SiteOpsProviderResult {
  const persistedNextPollAt =
    state.schemaVersion === 2 && state.providerNextPollAt
      ? Date.parse(state.providerNextPollAt)
      : Number.NaN;
  const durableDelay = Number.isFinite(persistedNextPollAt)
    ? Math.max(2_000, Math.min(300_000, persistedNextPollAt - Date.now()))
    : 10_000;
  return {
    status: "pending",
    result: state,
    providerTaskId: taskId,
    nextPollMs: Math.max(2_000, Math.min(300_000, nextPollMs ?? durableDelay)),
    projectStatus: "building",
    buildStatus,
  };
}

export function completedSiteBuildMessage() {
  return "FrontMind 静态官网已完成构建和 QA，可以在私有预览中检查并批准。";
}

export function designValidationFailure(error: unknown): {
  reason: DesignValidationReason;
  signature: string;
} {
  const issues =
    error instanceof z.ZodError
      ? error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String).join("."),
        }))
      : [];
  const messageCode =
    error instanceof Error
      ? (error.message.match(/^SITEOPS_[A-Z0-9_]+/u)?.[0] ?? null)
      : null;
  let reason: DesignValidationReason = "DESIGN_WIRE_SCHEMA_MISMATCH";
  if (messageCode === "SITEOPS_DESIGN_ROUTE_SET_MISMATCH") {
    reason = "ROUTE_SET_MISMATCH";
  } else if (messageCode === "SITEOPS_DESIGN_SLOT_ORDER_INVALID") {
    reason = "SLOT_ORDER_INVALID";
  } else if (messageCode === "SITEOPS_DESIGN_SLOT_DUPLICATE") {
    reason = "SLOT_DUPLICATE";
  } else if (messageCode === "SITEOPS_DESIGN_PALETTE_INDEX_INVALID") {
    reason = "PALETTE_INDEX_INVALID";
  } else if (messageCode === "SITEOPS_HOST_EMPTY_ROUTE_SET_INVALID") {
    reason = "ROUTE_SET_MISMATCH";
  } else if (issues.some((issue) => issue.path.endsWith("slotId"))) {
    reason = "SLOT_ID_FORMAT";
  } else if (issues.some((issue) => issue.path.endsWith("PaletteIndex"))) {
    reason = "PALETTE_INDEX_INVALID";
  } else if (
    issues.some(
      (issue) => issue.path === "siteTitle" || issue.path === "description",
    )
  ) {
    reason = "TEXT_LIMIT";
  } else if (
    issues.some((issue) =>
      /(?:routeSlots|routeCompositions).*routeId/u.test(issue.path),
    )
  ) {
    reason = "ROUTE_SET_MISMATCH";
  }
  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        reason,
        messageCode,
        issues: issues
          .slice()
          .sort((left, right) =>
            `${left.path}:${left.code}`.localeCompare(
              `${right.path}:${right.code}`,
            ),
          ),
      }),
      "utf8",
    )
    .digest("hex");
  return { reason, signature };
}

export function designRepairPrompt(input: {
  repairAttempt: number;
  maxAttempts?: 1 | 2;
  outputFilename: string;
  wireVersion: 2 | 3;
  repairReason?: RepairReason;
  repeatedSignatureCount?: number;
  hostOwnedEmptyRouteIds?: readonly string[];
}) {
  const reasonInstruction: Partial<Record<RepairReason, string>> = {
    STRUCTURED_OUTPUT_UNAVAILABLE:
      "只返回一个完整 JSON 对象，并让回复正文与 JSON 附件完全一致。",
    DESIGN_WIRE_SCHEMA_MISMATCH:
      "逐字段遵守严格 wire 合同，不要增加字段、旧版字段或 Hero family。",
    ROUTE_SET_MISMATCH:
      "只使用冻结的 provider-owned routeId，每个 route 恰好形成一个连续分组。",
    ROUTE_MISSING:
      "每个 provider-owned route 至少返回一个 overview/statement 坐标。",
    SLOT_ORDER_INVALID:
      "routeSlots 必须按冻结 route 顺序分组，同一路由内保持预期展示顺序。",
    SLOT_ID_FORMAT:
      "slotId 只能使用小写 ASCII 字母开头以及数字、连字符、下划线。",
    SLOT_DUPLICATE: "同一路由内每个 slotId 必须唯一。",
    PALETTE_INDEX_INVALID: "调色板索引只能使用结构化合同枚举中允许的整数。",
    TEXT_LIMIT: "siteTitle 必须为 1–80 字符，description 必须为 1–200 字符。",
    OUTPUT_CONFLICT: "结构化结果、JSON 正文与附件必须是完全相同的单一对象。",
  };
  const hostOwned = input.hostOwnedEmptyRouteIds?.length
    ? `不要返回这些 Dashboard 自有空状态 route：${input.hostOwnedEmptyRouteIds.join(",")}；Dashboard 会注入可信空内容。`
    : "";
  const repeated = input.repeatedSignatureCount
    ? "本次输出与上一次无效结果具有相同结构签名，必须重新构造对象，不能原样重复。"
    : "";
  return `继续同一个 FrontMind AI 建站任务。上一次 SiteDesignWireV${input.wireVersion} 未通过 Dashboard 严格合同。第 ${input.repairAttempt}/${input.maxAttempts ?? 2} 次修复：${input.repairReason ? (reasonInstruction[input.repairReason] ?? "") : ""}${hostOwned}${repeated}重新读取已附加 workflow、source dossier 与冻结视觉参考，为每个 provider-owned route 返回 routeSlots；缺少内容时至少返回 overview/statement。不得返回或改变 Hero family。回复正文必须是单一 JSON 对象，并把完全相同的对象附加为 ${input.outputFilename}。不得输出源码、脚本或未知事实。`;
}

export function contentRepairPrompt(input: {
  repairAttempt: number;
  maxAttempts?: number;
  outputFilename?: string;
  wireVersion?: 2 | 3;
  repairReason?: RepairReason;
  hostOwnedEmptyRouteIds?: readonly string[];
}) {
  const wire = `PageContentWireV${input.wireVersion ?? 2}`;
  const reasonInstruction: Partial<Record<RepairReason, string>> = {
    STRUCTURED_OUTPUT_UNAVAILABLE:
      "结构化抽取未产生可用对象，请确保回复正文与附件是完全相同的单一 JSON 对象。",
    OUTPUT_CONFLICT: "结构化结果、JSON 正文与附件必须是完全相同的单一对象。",
    EMPTY_TYPED_BLOCK_BODY:
      "prose、quote、cta 必须有 paragraphs；feature_list、steps、metrics 应使用非空 items，entity_grid 与 faq_preview 应使用非空引用。",
    INVALID_ENTITY_SLUG:
      "实体 slug 请使用小写 ASCII 字母、数字、连字符或下划线。",
    SOURCE_OR_ROUTE_MISMATCH:
      "routeId、slotId 与 sourceDocumentIds 必须严格来自冻结合同。",
    CONTENT_BINDING_MISMATCH: "实体、FAQ 与区块引用必须全部存在并保持唯一。",
    CONTENT_CONTRACT_MISMATCH:
      "请逐字段核对 PageContentWire 合同并返回完整对象。",
  };
  const hostOwned = input.hostOwnedEmptyRouteIds?.length
    ? `不要返回 Dashboard 自有空状态 route：${input.hostOwnedEmptyRouteIds.join(",")}，也不要生成对应 block 或 company_news entity。`
    : "";
  return `继续同一个 FrontMind AI 建站任务。上一次 ${wire} 或受信网站 QA 未通过。第 ${input.repairAttempt}/${input.maxAttempts ?? 3} 次修复：${input.repairReason ? (reasonInstruction[input.repairReason] ?? "") : ""}${hostOwned}重新读取已附加 source dossier 与 build contract，按冻结 route/slot 顺序完整返回 ${wire}，只能引用允许的 sourceDocumentIds。数据驱动的 feature_list、steps、metrics、entity_grid、faq_preview 在 items 或引用完整时可以使用空 paragraphs；prose、quote、cta 必须有正文。实体 slug 优先使用 URL 安全的 ASCII。并把完全相同的 JSON 对象附加为 ${input.outputFilename ?? SITEOPS_WIRE_OUTPUT_FILES.content}，附件是结构化抽取失败时的正式恢复副本。不得浏览或补写外部新闻，不得输出源码、脚本或未知事实。`;
}

export function contentRepairReason(error: unknown): RepairReason {
  if (error instanceof z.ZodError) {
    const paths = error.issues.map((issue) => issue.path.join("."));
    if (
      paths.some(
        (path) => path.endsWith("paragraphs") || path.endsWith("items"),
      )
    ) {
      return "EMPTY_TYPED_BLOCK_BODY";
    }
    if (paths.some((path) => path.endsWith("slug"))) {
      return "INVALID_ENTITY_SLUG";
    }
    if (
      paths.some((path) =>
        /(?:entityIds|faqIds|relatedEntityIds|entities|faqs)/u.test(path),
      )
    ) {
      return "CONTENT_BINDING_MISMATCH";
    }
  }
  const message = error instanceof Error ? error.message : "";
  if (/(?:SOURCE|ROUTE)_.*MISMATCH/u.test(message)) {
    return "SOURCE_OR_ROUTE_MISMATCH";
  }
  if (/(?:BIND|REFERENCE|ENTITY|FAQ)/iu.test(message)) {
    return "CONTENT_BINDING_MISMATCH";
  }
  return "CONTENT_CONTRACT_MISMATCH";
}

function contentValidationSignature(error: unknown, reason: RepairReason) {
  const issues =
    error instanceof z.ZodError
      ? error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String).join("."),
        }))
      : [];
  const messageCode =
    error instanceof Error
      ? (error.message.match(/^SITEOPS_[A-Z0-9_]+/u)?.[0] ?? null)
      : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        reason,
        messageCode,
        issues: issues
          .slice()
          .sort((left, right) =>
            `${left.path}:${left.code}`.localeCompare(
              `${right.path}:${right.code}`,
            ),
          ),
      }),
      "utf8",
    )
    .digest("hex");
}

async function scheduleRepair(input: {
  db: any;
  operation: SiteOperation;
  build: typeof siteBuilds.$inferSelect;
  taskId: string;
  kind: "design" | "content";
  category?: "extraction" | "design" | "content" | "materialization";
  design?: z.infer<typeof designResultSchema>;
  repairReason?: RepairReason;
  candidateSha256?: string | null;
  source?: "structured" | "attachment" | "assistant_json" | null;
  validationSignature?: string | null;
  handledWaitingEventId?: string;
  handledWaitingAt?: string;
}) {
  const state = providerStateV2(stateFromOperation(input.operation));
  const category = input.category ?? input.kind;
  const budgets = {
    extraction: 1,
    design: 2,
    content: 3,
    materialization: 1,
  } as const;
  let validation = state.validation;
  if (
    input.candidateSha256 &&
    input.source &&
    input.validationSignature &&
    input.repairReason
  ) {
    const repeated =
      state.validation?.candidateSha256 === input.candidateSha256 &&
      state.validation.signature === input.validationSignature;
    validation = {
      phase: input.kind,
      source: input.source,
      candidateSha256: input.candidateSha256,
      signature: input.validationSignature,
      reason: input.repairReason,
      repeatCount: repeated ? state.validation!.repeatCount + 1 : 0,
    };
    if (repeated) {
      logManusBuildStage({
        stage: "wire_validation",
        operationId: input.operation.id,
        buildId: input.build.id,
        phase: input.kind,
        source: input.source,
        candidateSha256: input.candidateSha256,
        reason: input.repairReason,
        signature: input.validationSignature,
      });
      return {
        status: "failed",
        code: "FRONTMIND_BUILD_OUTPUT_INVALID",
        message:
          "同一 FrontMind AI 建站任务重复返回相同的无效结构，已停止重复修复。",
        providerTaskId: input.taskId,
        result: providerStateV2Schema.parse({ ...state, validation }),
      } satisfies SiteOpsProviderResult;
    }
  }
  if (input.repairReason) {
    logManusBuildStage({
      stage: "wire_validation",
      operationId: input.operation.id,
      buildId: input.build.id,
      phase: input.kind,
      source: input.source ?? undefined,
      candidateSha256: input.candidateSha256 ?? undefined,
      reason: input.repairReason,
      signature: input.validationSignature ?? undefined,
    });
  }
  const attempt = state.attempts[category] + 1;
  if (attempt > budgets[category])
    return {
      status: "failed",
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message: `同一 FrontMind AI 建站任务已完成当前阶段允许的 ${budgets[category]} 次自动修复，仍未通过结构或 QA 校验。`,
      providerTaskId: input.taskId,
      result: providerStateV2Schema.parse({ ...state, validation }),
    } satisfies SiteOpsProviderResult;
  const attempts = { ...state.attempts, [category]: attempt };
  const nextState = providerStateV2Schema.parse({
    ...state,
    schemaVersion: 2,
    stage: "repair_send_ready",
    taskId: input.taskId,
    design: input.design,
    repairKind: input.kind,
    repairCategory: category,
    repairAttempt: attempt,
    repairReason: input.repairReason,
    resultPendingSince: undefined,
    providerStoppedAt: undefined,
    attempts,
    validation,
    ...(input.handledWaitingEventId
      ? { handledWaitingEventId: input.handledWaitingEventId }
      : {}),
    ...(input.handledWaitingAt
      ? { handledWaitingAt: input.handledWaitingAt }
      : {}),
  });
  await input.db.transaction(async (tx: any) => {
    const updated = await tx
      .update(siteBuilds)
      .set({
        repairAttempts: input.build.repairAttempts + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteBuilds.id, input.build.id),
          eq(siteBuilds.userId, input.operation.userId),
          inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
          eq(siteBuilds.repairAttempts, input.build.repairAttempts),
        ),
      );
    const affectedRows = Number(
      (Array.isArray(updated)
        ? (updated[0] as { affectedRows?: unknown } | undefined)?.affectedRows
        : (updated as { affectedRows?: unknown } | undefined)?.affectedRows) ??
        0,
    );
    if (affectedRows !== 1) {
      throw new Error("SITEOPS_BUILD_REPAIR_CAS_CONFLICT");
    }
    await persistOperationProgress(
      tx,
      input.operation,
      nextState,
      input.taskId,
    );
  });
  logManusBuildStage({
    stage: "repair_scheduled",
    operationId: input.operation.id,
    buildId: input.build.id,
    phase: input.kind,
    source: input.source ?? undefined,
    candidateSha256: input.candidateSha256 ?? undefined,
    reason: input.repairReason ?? category,
    signature: input.validationSignature ?? undefined,
  });
  return pending(
    nextState,
    input.taskId,
    input.kind === "design" ? "design_compiling" : "qa_running",
  );
}

async function persistBuildArtifacts(
  operation: SiteOperation,
  materialized:
    | Awaited<ReturnType<typeof materializeAstroSite>>
    | MaterializedNativeReactSite,
  persist: typeof persistSiteOpsArtifact,
  assertExecutionActive: () => Promise<void>,
  generation?: "trusted-fallback",
) {
  await assertExecutionActive();
  const common = { userId: operation.userId, projectId: operation.projectId };
  const unboundRetainUntil = new Date(
    Date.now() + NATIVE_SOURCE_STAGING_RETENTION_MS,
  );
  const generationSuffix = generation ? `-${generation}` : "";
  const generationKey = generation ? `:${generation}` : "";
  const [contract, source, dist, qa, provenance] = await Promise.all([
    persist({
      ...common,
      kind: "site-contract",
      filename: `build-${operation.buildId}${generationSuffix}-contract.json`,
      mimeType: "application/json",
      buffer: materialized.contractJson,
      idempotencyKey: `build:${operation.id}${generationKey}:contract`,
      retainUntil: unboundRetainUntil,
    }),
    persist({
      ...common,
      kind: "site-source",
      filename: `build-${operation.buildId}${generationSuffix}-source.zip`,
      mimeType: "application/zip",
      buffer: materialized.sourceZip,
      idempotencyKey: `build:${operation.id}${generationKey}:source`,
      retainUntil: unboundRetainUntil,
    }),
    persist({
      ...common,
      kind: "site-dist",
      filename: `build-${operation.buildId}${generationSuffix}-dist.zip`,
      mimeType: "application/zip",
      buffer: materialized.distZip,
      idempotencyKey: `build:${operation.id}${generationKey}:dist`,
      retainUntil: unboundRetainUntil,
    }),
    persist({
      ...common,
      kind: "site-qa",
      filename: `build-${operation.buildId}${generationSuffix}-visual-qa.zip`,
      mimeType: "application/zip",
      buffer: materialized.visualQaZip,
      idempotencyKey: `build:${operation.id}${generationKey}:qa`,
      retainUntil: unboundRetainUntil,
    }),
    persist({
      ...common,
      kind: "site-provenance",
      filename: `build-${operation.buildId}${generationSuffix}-provenance.json`,
      mimeType: "application/json",
      buffer: materialized.provenanceJson,
      idempotencyKey: `build:${operation.id}${generationKey}:provenance`,
      retainUntil: unboundRetainUntil,
    }),
  ]);
  if (
    contract.contentSha256 !== materialized.contractSha256 ||
    source.contentSha256 !== materialized.sourceSha256 ||
    dist.contentSha256 !== materialized.distSha256 ||
    qa.contentSha256 !== materialized.visualQaSha256 ||
    provenance.contentSha256 !== materialized.provenanceSha256
  ) {
    throw new SiteOpsMaterializationError({
      phase: "artifact_persistence",
      code: "SITEOPS_BUILD_ARTIFACT_HASH_MISMATCH",
      retryClass: "host_deterministic",
    });
  }
  await assertExecutionActive();
  return {
    contract,
    source,
    dist,
    qa,
    provenance,
    unboundRetainUntil,
    qaSummary: JSON.parse(materialized.qaJson.toString("utf8")) as Record<
      string,
      unknown
    >,
  };
}

export function resultFailure(error: unknown): SiteOpsProviderResult {
  if (error instanceof SiteOpsManusFailure) {
    return {
      status: error.status,
      code: error.code,
      message: /manus/iu.test(error.message)
        ? "FrontMind AI 建站任务未能安全推进，请稍后重试或由运营人员处理。"
        : error.message,
      ...(error.result ? { result: error.result } : {}),
    };
  }
  if (error instanceof ManusV2ApiError) {
    const isRead =
      /^(?:task\.(?:detail|list|listMessages)|file\.(?:detail|download))$/u.test(
        error.operation,
      );
    if (error.outcomeUnknown) {
      return {
        status: "outcome_unknown",
        code: "FRONTMIND_BUILD_RESULT_PENDING",
        message: "FrontMind AI 建站操作结果仍在确认中，系统不会重复创建任务。",
      };
    }
    if (isRead && (error.status === 400 || error.status === 422)) {
      return {
        status: "attention_required",
        code: "FRONTMIND_BUILD_PROVIDER_READ_REJECTED",
        message: "AI 建站任务查询被上游明确拒绝，已保留原任务坐标等待处理。",
      };
    }
    if (error.status === 400 || error.status === 422) {
      return {
        status: "failed",
        code: "FRONTMIND_BUILD_REQUEST_INVALID",
        message:
          "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
        result: {
          schemaVersion: 1,
          stage:
            error.operation === "task.create"
              ? "create_rejected"
              : "request_rejected",
        },
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        status: "attention_required",
        code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
        message:
          "当前账号的 AI 建站 API Key 无法通过连接验证，请联系系统管理员检查该账号配置。",
      };
    }
    if (isRead && isTransientManusReadFailure(error)) {
      return {
        status: "outcome_unknown",
        code: "FRONTMIND_BUILD_PROVIDER_SYNC_DELAYED",
        message:
          "FrontMind AI 建站结果暂时未能同步，系统将继续读取同一任务且不会重复创建。",
      };
    }
    return {
      status: "failed",
      code: "FRONTMIND_BUILD_SERVICE_UNAVAILABLE",
      message: "FrontMind AI 建站服务暂时不可用，请稍后重试。",
    };
  }
  return {
    status: "failed",
    code: "FRONTMIND_BUILD_FAILED",
    message:
      "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
  };
}

function safeManusApiErrorCoordinates(error: unknown) {
  if (!(error instanceof ManusV2ApiError)) return undefined;
  const coordinate = safeManusReadFailure(error);
  return {
    providerOperation: coordinate.operation,
    providerStatus: coordinate.status,
    providerCode: coordinate.code,
    providerRetryable: coordinate.retryable,
    providerRetryAfterMs: coordinate.retryAfterMs,
    providerRequestId: safeProviderRequestId(error.providerRequestId),
    transportCause: coordinate.transportCause,
    transportPhase: coordinate.transportPhase,
    transportAttempt: error.transportAttempt,
    transportElapsedMs: error.transportElapsedMs,
  };
}

function safeProviderInternalCode(error: unknown) {
  if (error instanceof SiteOpsManusFailure) return error.code;
  if (error instanceof NativeReactSourceError) return error.code;
  if (error instanceof NativeReactBuildError) return error.code;
  if (error instanceof SiteOpsMaterializationError) return error.code;
  if (error instanceof SiteOpsWireOutputResolutionError) return error.code;
  if (error instanceof z.ZodError) return "ZOD_VALIDATION_FAILED";
  if (
    error instanceof Error &&
    /^(?:SITEOPS|FRONTMIND)_[A-Z0-9_:-]+$/u.test(error.message)
  ) {
    return error.message;
  }
  if (error instanceof TypeError) return "TYPE_ERROR";
  return "UNCLASSIFIED_PROVIDER_ERROR";
}

function safeProviderValidationDetails(error: unknown) {
  if (!(error instanceof z.ZodError)) return undefined;
  return error.issues.slice(0, 8).map((issue) => ({
    code: issue.code,
    path: issue.path.map((segment) =>
      typeof segment === "number" ? segment : String(segment),
    ),
    ...(issue.code === "unrecognized_keys"
      ? {
          keys: issue.keys
            .filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key))
            .slice(0, 8)
            .join(","),
        }
      : {}),
  }));
}

function safeProviderErrorName(error: unknown) {
  if (!(error instanceof Error)) return "NonError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
}

export function createManusSiteOpsProviderHandler(
  dependencies: ManusProviderDependencies = {},
): SiteOpsProviderHandler {
  const dbGetter = dependencies.getDb ?? getDb;
  const getCredential =
    dependencies.getCredential ?? getDecryptedCredentialForUser;
  const createClient =
    dependencies.createClient ??
    ((input) =>
      new ManusV2Client({
        baseUrl: baseUrl(),
        apiKey: input.apiKey,
        rateLimitScope: input.credentialId,
        timeoutMs: 30_000,
      }));
  const readArchive =
    dependencies.readSnapshotArchive ?? readKnowledgeSnapshotArchive;
  const persist = dependencies.persistArtifact ?? persistSiteOpsArtifact;
  const readArtifact = dependencies.readArtifact ?? readSiteOpsArtifact;
  const materialize = dependencies.materializeSite ?? materializeAstroSite;
  const materializeNativeFallback =
    dependencies.materializeNativeTrustedFallbackSite ??
    materializeNativeTrustedFallbackSite;
  const materializeNative =
    dependencies.materializeNativeSite ?? materializeNativeReactSource;
  const nativeSourceRuntimeRegistry =
    dependencies.nativeSourceRuntimeRegistry ??
    DEFAULT_NATIVE_SOURCE_RUNTIME_REGISTRY;
  const socialGenerate = dependencies.generateSocial ?? generateSocialPackage;

  return async ({ operation, signal, assertLeaseActive }) => {
    try {
      const assertExecutionActive = async () => {
        signal.throwIfAborted();
        await assertLeaseActive?.();
        signal.throwIfAborted();
      };
      await assertExecutionActive();
      const db = await dbGetter();
      if (!db)
        throw new SiteOpsManusFailure(
          "DATABASE_UNAVAILABLE",
          "AI 建站数据库暂时不可用。",
        );
      const input = operationInputSchema.parse(operation.input);
      let clientPromise: Promise<ManusV2Client> | null = null;
      const getClient = () => {
        clientPromise ??= assertFrozenCredential(
          input,
          operation.userId,
          getCredential,
        ).then((credential) =>
          createClient({
            apiKey: credential.apiKey,
            credentialId: credential.id,
          }),
        );
        return clientPromise;
      };
      const parsedState = providerStateSchema.safeParse(operation.result);
      if (
        claimsNativeSourceCheckpoint(operation.result) &&
        (!parsedState.success ||
          !nativeSourceCheckpointMatchesOperation(operation, parsedState.data))
      ) {
        return {
          status: "attention_required",
          code: "FRONTMIND_BUILD_STAGED_SOURCE_IDENTITY_CONFLICT",
          message: "已暂存源码恢复坐标未通过严格校验，已保留原状态等待处理。",
          providerTaskId: operation.providerTaskId ?? undefined,
          result: rawProviderStateRecord(operation.result) ?? undefined,
        };
      }
      const state = parsedState.success ? parsedState.data : null;

      if (operation.kind === "social_package") {
        const client = await getClient();
        const rows = await db
          .select({
            package: socialPackages,
            snapshot: knowledgeBaseSnapshots,
            project: siteProjects,
          })
          .from(socialPackages)
          .innerJoin(
            knowledgeBaseSnapshots,
            eq(knowledgeBaseSnapshots.id, socialPackages.knowledgeSnapshotId),
          )
          .innerJoin(
            siteProjects,
            eq(siteProjects.id, socialPackages.projectId),
          )
          .where(
            and(
              eq(socialPackages.operationId, operation.id),
              eq(socialPackages.userId, operation.userId),
            ),
          )
          .limit(1);
        const context = rows[0];
        if (!context)
          throw new SiteOpsManusFailure(
            "SOCIAL_CONTEXT_NOT_FOUND",
            "社媒内容包上下文不存在。",
            "failed",
          );
        const token = `siteops-social:${operation.id}`;
        let taskId = state?.taskId ?? operation.providerTaskId ?? undefined;
        if (!taskId) {
          if (state?.stage === "create_unknown") {
            const found = await findUniqueCreatedTask(client, operation, token);
            if (!found)
              return pending({ schemaVersion: 1, stage: "create_unknown" });
            taskId = found.id;
          } else {
            const documents = safePublicDocuments(context.snapshot);
            const socialWorkflow =
              await loadVerifiedSiteOpsSocialWorkflowPackage(
                context.package.channel,
              );
            const prompt = promptWithMarker(
              `你是 FrontMind 企业内容编辑。必须遵守已附加并通过 manifest 校验的 ${context.package.channel} 内容包 workflow，以及 frontmind-social-source-documents-v1.json 中的冻结知识来源。生成${context.package.channel === "wechat" ? "微信公众号文章及三张封面所需文案" : "小红书九页图文（封面加八节）"}；不得编造数字、客户、资质或案例，不得请求账号凭据、排期或执行发布。主题：${input.topic || "基于企业知识库选择最有价值的主题"}。仅返回要求的结构化结果。`,
              token,
            );
            await persistOperationProgress(db, operation, {
              schemaVersion: 1,
              stage: "create_unknown",
            });
            try {
              await assertExecutionActive();
              const created = await client.createTask({
                title: operationTitle(operation),
                prompt,
                attachments: [
                  socialWorkflowAttachment(
                    context.package.channel,
                    socialWorkflow,
                  ),
                  siteOpsSocialSourceAttachment({
                    operationToken: token,
                    documents,
                  }),
                ],
                locale: "zh-CN",
                agentProfile: managedAgentProfileModel(input.agentProfile),
                structuredOutputSchema: socialOutputSchema(
                  token,
                  context.package.channel,
                  documents.map((document) => document.id),
                ),
              });
              taskId = created.taskId;
            } catch (error) {
              if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
                return pending({ schemaVersion: 1, stage: "create_unknown" });
              }
              throw error;
            }
            try {
              await persistOperationProgress(
                db,
                operation,
                { schemaVersion: 1, stage: "content_pending", taskId },
                taskId,
              );
            } catch (error) {
              const code = error instanceof Error ? error.message : "";
              if (/^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(code)) {
                throw error;
              }
              return pending({ schemaVersion: 1, stage: "create_unknown" });
            }
            return pending(
              { schemaVersion: 1, stage: "content_pending", taskId },
              taskId,
            );
          }
        }
        await assertExecutionActive();
        const polled = await pollEvents(client, taskId, token, state, {
          operationId: operation.id,
        });
        await assertExecutionActive();
        if (polled.deferred) {
          return pending(
            polled.providerState,
            taskId,
            undefined,
            polled.nextPollMs,
          );
        }
        const value = acceptedSocialStructuredValue(polled.events, token);
        if (!value) {
          if (polled.waiting)
            throw new SiteOpsManusFailure(
              "FRONTMIND_SOCIAL_UNEXPECTED_WAITING_ACTION",
              "FrontMind AI 内容任务请求了当前流程不允许的交互，已安全停止。",
              "failed",
            );
          if (polled.state.failed)
            throw new SiteOpsManusFailure(
              "MANUS_SOCIAL_TASK_FAILED",
              "FrontMind AI 内容任务未生成可验证的结构化内容。",
              "failed",
            );
          const grace = structuredResultGrace(
            transitionProviderState(polled.providerState, {
              stage: "content_pending",
              taskId,
              resultPendingSince: state?.resultPendingSince,
            }),
            polled.state.completed,
          );
          if (grace.expired)
            throw new SiteOpsManusFailure(
              "FRONTMIND_SOCIAL_OUTPUT_MISSING",
              "FrontMind AI 内容任务已结束，但未返回可验证的结构化结果。",
              "failed",
            );
          return pending(grace.state, taskId);
        }
        const record = value as Record<string, unknown>;
        const generatedInput = socialPackageInputSchema.parse({
          channel: context.package.channel,
          companyName: record.companyName,
          title: record.title,
          deck: record.deck,
          sourceDocuments: record.sourceDocuments,
          sections: record.sections,
          hashtags: record.hashtags,
        });
        const verifiedIds = new Set(
          safePublicDocuments(context.snapshot).map((document) => document.id),
        );
        if (
          generatedInput.sourceDocuments.some(
            (document) => !verifiedIds.has(document.id),
          )
        ) {
          throw new SiteOpsManusFailure(
            "SOCIAL_SOURCE_NOT_VERIFIED",
            "社媒内容引用了知识库之外的来源。",
            "failed",
          );
        }
        await assertExecutionActive();
        const generated = await socialGenerate(generatedInput);
        await assertExecutionActive();
        const archive = await persist({
          userId: operation.userId,
          projectId: operation.projectId,
          kind: "social-archive",
          filename: `${context.package.channel}-${context.package.id}.zip`,
          mimeType: "application/zip",
          buffer: generated.archive,
        });
        const previews = await Promise.all(
          generated.previews.map((preview, index) =>
            persist({
              userId: operation.userId,
              projectId: operation.projectId,
              kind: "social-preview",
              filename: `${context.package.channel}-${context.package.id}-${String(index + 1).padStart(2, "0")}.png`,
              mimeType: preview.mimeType,
              buffer: preview.buffer,
            }),
          ),
        );
        await assertExecutionActive();
        if (archive.contentSha256 !== generated.archiveSha256)
          throw new SiteOpsManusFailure(
            "SOCIAL_ARCHIVE_HASH_MISMATCH",
            "社媒 ZIP 写入校验失败。",
            "failed",
          );
        const packageUpdated = await db
          .update(socialPackages)
          .set({
            manifest: generated.manifest,
            manifestHash: generated.manifestSha256,
            archiveLocalAssetId: archive.id,
            archiveHash: generated.archiveSha256,
            previewLocalAssetIds: previews.map((item) => item.id),
            qa: generated.qa,
            status: "ready",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(socialPackages.id, context.package.id),
              eq(socialPackages.userId, operation.userId),
              eq(socialPackages.operationId, operation.id),
              inArray(
                socialPackages.status,
                PROVIDER_MUTABLE_SOCIAL_PACKAGE_STATUSES,
              ),
            ),
          );
        const packageAffectedRows = Number(
          (Array.isArray(packageUpdated)
            ? (packageUpdated[0] as { affectedRows?: unknown } | undefined)
                ?.affectedRows
            : (packageUpdated as { affectedRows?: unknown } | undefined)
                ?.affectedRows) ?? 0,
        );
        if (packageAffectedRows !== 1) {
          throw new Error("SITEOPS_OPERATION_LEASE_LOST");
        }
        await assertExecutionActive();
        return {
          status: "succeeded",
          providerTaskId: taskId,
          socialPackageStatus: "ready",
          result: {
            packageId: context.package.id,
            archiveHash: generated.archiveSha256,
            previewCount: previews.length,
          },
          message: "社媒内容包已通过来源与结构校验，可以预览和下载。",
        };
      }

      if (!operation.kind.includes("build"))
        throw new SiteOpsManusFailure(
          "MANUS_OPERATION_KIND_UNSUPPORTED",
          "Manus SiteOps 适配器不支持该操作。",
          "failed",
        );
      const canAttemptOfflineNativeSourceResume =
        state?.schemaVersion === 2 &&
        Boolean(state.nativeSourceStaging?.receipt) &&
        Boolean(
          state.buildCheckpoint &&
            NATIVE_SOURCE_OFFLINE_RESUME_CHECKPOINTS.has(state.buildCheckpoint),
        );
      const context = await loadBuildContext(db, operation);
      const hostOwnedContentBuild = usesHostOwnedContentDraft(
        context.build.workflowVersion,
      );
      // Historical and Native workflows retain their existing eager Provider
      // readiness boundary. A new host-owned content build is deliberately
      // different: its trusted baseline must be staged and atomically bound by
      // the worker before credential lookup or any Provider request can run.
      if (!canAttemptOfflineNativeSourceResume && !hostOwnedContentBuild) {
        await getClient();
      }
      const archiveBytes = await readArchive({
        userId: operation.userId,
        snapshotId: context.snapshot.id,
        expectedSha256: context.snapshot.archiveHash!,
        expectedBytes: context.snapshot.totalBytes,
      });
      const brief = siteBriefSchema.parse(context.build.brief);
      const frozenRouteIds = brief.routes.map((route) => route.id);
      const hostEmptyCandidates = hostOwnedEmptyRouteIds(brief);
      const assetDecisions = frozenAssetDecisions(context.snapshot, brief);
      const brandAsset = await readSelectedOfficialLogoFromKnowledgeArchive({
        archiveBytes,
        assets: context.snapshot.assets,
        decisions: assetDecisions,
      });
      const metadata = context.sample.sourceMetadata;
      const metadataRecord =
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as unknown as Record<string, unknown>)
          : null;
      const staticTemplateMetadata = Boolean(
        metadataRecord?.schemaVersion === 7 &&
          metadataRecord.renderer === "frontmind_static_template_catalog_v1" &&
          (metadataRecord.workflowVersion ===
            SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION ||
            metadataRecord.workflowVersion ===
              SITEOPS_MATERIALIZER_V2_9.frontMindVersion),
      );
      if (
        !metadataRecord ||
        (!staticTemplateMetadata && !context.sample.previewLocalAssetId)
      )
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_INCOMPLETE",
          "冻结的视觉选择缺少可信元数据。",
          "failed",
        );
      const nativeTemplateMetadata =
        metadataRecord.schemaVersion === 6 &&
        metadataRecord.renderer === "twenty_first_native_template_v1";
      const nativeSourceMetadata =
        nativeTemplateMetadata || staticTemplateMetadata;
      const documents = safePublicDocuments(context.snapshot);
      const taxonomy = nativeSourceMetadata
        ? visualTaxonomySchema.parse({
            role: "foundation",
            palette: [],
            typography: [],
            layout: [],
            motion: [],
            accessibility: [],
          })
        : (() => {
            const parsed = visualTaxonomySchema.parse(metadataRecord.taxonomy);
            return {
              ...parsed,
              palette: accessibleRuntimePalette(parsed.palette),
            };
          })();
      const templateEvidenceSeed = nativeTemplateMetadata
        ? canonicalSiteOpsSha256({
            schemaVersion: 6,
            providerTemplateId: metadataRecord.providerTemplateId,
            providerSlug: metadataRecord.providerSlug,
            providerVersion: metadataRecord.providerVersion,
            framework: metadataRecord.framework,
            sourceTreeSha256: metadataRecord.sourceTreeSha256,
            sourceArchiveSha256: metadataRecord.sourceArchiveSha256,
            previewSha256: metadataRecord.previewSha256,
          })
        : staticTemplateMetadata
          ? canonicalSiteOpsSha256({
              schemaVersion: 7,
              workflowVersion: metadataRecord.workflowVersion,
              catalogVersion: metadataRecord.catalogVersion,
              catalogCandidateId: metadataRecord.catalogCandidateId,
              sourceAssetId: metadataRecord.sourceAssetId,
              sourceArchiveSha256: metadataRecord.sourceArchiveSha256,
              previewAssetId: metadataRecord.previewAssetId,
              previewSha256: metadataRecord.previewSha256,
            })
          : null;
      const visualEvidence = nativeSourceMetadata
        ? createVisualEvidenceV1({
            evidenceKind: "catalog_metadata_preview_v1",
            providerItemKey: `${
              staticTemplateMetadata ? "s:static-template" : "s:template"
            }:${templateEvidenceSeed}`,
            metadataSha256: templateEvidenceSeed!,
            providerResponseSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .parse(metadataRecord.sourceArchiveSha256),
            previewSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .parse(metadataRecord.previewSha256),
            taxonomyDerivationVersion: "catalog-metadata-preview-v1",
          })
        : visualEvidenceV1Schema.parse(metadataRecord.visualEvidence);
      const recomposedVisualEvidence = createVisualEvidenceV1({
        evidenceKind: visualEvidence.evidenceKind,
        providerItemKey: visualEvidence.providerItemKey,
        metadataSha256: visualEvidence.metadataSha256,
        providerResponseSha256: visualEvidence.providerResponseSha256,
        previewSha256: visualEvidence.previewSha256,
        taxonomyDerivationVersion: visualEvidence.taxonomyDerivationVersion,
      });
      const metadataProviderItemKey = nativeSourceMetadata
        ? visualEvidence.providerItemKey
        : z
            .string()
            .trim()
            .min(1)
            .max(512)
            .parse(metadataRecord.providerItemKey);
      if (
        recomposedVisualEvidence.evidenceSha256 !==
          visualEvidence.evidenceSha256 ||
        metadataProviderItemKey !== visualEvidence.providerItemKey ||
        (!nativeSourceMetadata &&
          context.sample.sourceMetadata?.visualEvidence?.previewSha256 !==
            visualEvidence.previewSha256)
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_EVIDENCE_COORDINATES_MISMATCH",
          "冻结的视觉证据与预览坐标不一致。",
          "failed",
        );
      }
      if (
        !context.batch.selectionBundleLocalAssetId ||
        !context.batch.selectionBundleHash
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_BUNDLE_MISSING",
          "冻结的视觉选择合同不存在。",
          "failed",
        );
      }
      const selectionArtifact = await readArtifact({
        userId: operation.userId,
        localAssetId: context.batch.selectionBundleLocalAssetId,
        expectedSha256: context.batch.selectionBundleHash,
        expectedMimeTypes: [
          "application/json",
          VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE,
        ],
      });
      if (!selectionArtifact) {
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_BUNDLE_MISSING",
          "冻结的视觉选择合同不存在。",
          "failed",
        );
      }
      if (selectionArtifact.row.mimeType === "application/json") {
        const selection = await readFrozenSelectionBundle({
          artifact: selectionArtifact,
          expectedCandidateId: context.sample.id,
        });
        if (isVisualSelectionBundleV7(selection.bundle)) {
          const selectedV7 = selection.bundle.candidates.find(
            (candidate) => candidate.id === context.sample.id,
          );
          const coordinatesMatch = Boolean(
            staticTemplateMetadata &&
              selectedV7 &&
              (context.build.workflowVersion ===
                SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION ||
                context.build.workflowVersion ===
                  SITEOPS_MATERIALIZER_V2_9.frontMindVersion) &&
              metadataRecord.catalogVersion ===
                selection.bundle.catalogVersion &&
              metadataRecord.catalogPosition === selectedV7.catalogPosition &&
              metadataRecord.catalogCandidateId ===
                selectedV7.catalogCandidateId &&
              metadataRecord.providerTemplateId ===
                selectedV7.providerTemplateId &&
              metadataRecord.providerSlug === selectedV7.providerSlug &&
              metadataRecord.providerVersion === selectedV7.providerVersion &&
              metadataRecord.sourceOwner === selectedV7.sourceOwner &&
              metadataRecord.sourceRepo === selectedV7.sourceRepo &&
              metadataRecord.sourceCommitSha === selectedV7.sourceCommitSha &&
              metadataRecord.sourceSubdirectory ===
                selectedV7.sourceSubdirectory &&
              metadataRecord.sourceLicense === selectedV7.sourceLicense &&
              metadataRecord.sourceAssetId === selectedV7.sourceAssetId &&
              metadataRecord.sourceArchiveSha256 ===
                selectedV7.sourceArchiveSha256 &&
              metadataRecord.sourceArchiveBytes ===
                selectedV7.sourceArchiveBytes &&
              metadataRecord.previewAssetId === selectedV7.previewAssetId &&
              metadataRecord.previewSha256 === selectedV7.previewSha256 &&
              metadataRecord.previewMimeType === selectedV7.previewMimeType &&
              metadataRecord.previewWidth === selectedV7.previewWidth &&
              metadataRecord.previewHeight === selectedV7.previewHeight &&
              visualEvidence.previewSha256 === selectedV7.previewSha256,
          );
          if (!coordinatesMatch) {
            throw new SiteOpsManusFailure(
              "VISUAL_SELECTION_COORDINATES_MISMATCH",
              "固定模板目录与所选视觉候选坐标不一致。",
              "failed",
            );
          }
          const nativeSelection = await selectedStaticNativeSourceArchive({
            bundle: selection.bundle,
            selectedCandidateId: context.sample.id,
          });
          return await handleNativeReactSiteBuild({
            db,
            operation,
            signal,
            assertExecutionActive,
            client: null,
            getClient,
            input,
            state,
            context,
            brief,
            documents,
            visualEvidence,
            taxonomy,
            brandAsset,
            knowledgeArchiveBytes: archiveBytes,
            nativeSelection,
            materializeNative,
            materializeNativeFallback,
            nativeSourceRuntimeRegistry,
            assetDecisions,
            persist,
            readArtifact,
          });
        }
      }
      if (
        selectionArtifact.row.mimeType === VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE
      ) {
        const artifactBytes = await storedArtifactBytes(
          selectionArtifact,
          VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES,
        );
        const nativeSelection = await selectedNativeSourceArchive({
          artifactBytes,
          selectedCandidateId: context.sample.id,
        });
        const selectedV6 = isVisualSelectionBundleV6(nativeSelection.bundle)
          ? nativeSelection.bundle.candidates.find(
              (candidate) => candidate.id === context.sample.id,
            )
          : null;
        const selectedV5 = isVisualSelectionBundleV5(nativeSelection.bundle)
          ? nativeSelection.bundle.candidates.find(
              (candidate) => candidate.id === context.sample.id,
            )
          : null;
        const coordinatesMatch = nativeTemplateMetadata
          ? Boolean(
              selectedV6 &&
                metadataRecord.sourceTreeSha256 ===
                  selectedV6.sourceTreeSha256 &&
                metadataRecord.sourceArchiveSha256 ===
                  selectedV6.sourceArchiveSha256 &&
                metadataRecord.providerTemplateId ===
                  selectedV6.providerTemplateId &&
                metadataRecord.providerSlug === selectedV6.providerSlug &&
                metadataRecord.providerVersion === selectedV6.providerVersion &&
                metadataRecord.framework === selectedV6.framework &&
                metadataRecord.previewSha256 === selectedV6.previewSha256,
            )
          : Boolean(
              selectedV5 &&
                context.build.workflowVersion ===
                  SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION &&
                metadataRecord.renderer === "twenty_first_native_react_v1" &&
                metadataRecord.schemaVersion === 5 &&
                metadataRecord.sourceTreeSha256 ===
                  selectedV5.sourceTreeSha256 &&
                metadataRecord.sourceArchiveSha256 ===
                  selectedV5.sourceArchiveSha256 &&
                metadataProviderItemKey === selectedV5.providerItemKey,
            );
        if (!coordinatesMatch) {
          throw new SiteOpsManusFailure(
            "VISUAL_SELECTION_COORDINATES_MISMATCH",
            "冻结的原生源码与所选视觉候选不一致。",
            "failed",
          );
        }
        return await handleNativeReactSiteBuild({
          db,
          operation,
          signal,
          assertExecutionActive,
          client: null,
          getClient,
          input,
          state,
          context,
          brief,
          documents,
          visualEvidence,
          taxonomy,
          brandAsset,
          knowledgeArchiveBytes: archiveBytes,
          nativeSelection,
          materializeNative,
          materializeNativeFallback,
          nativeSourceRuntimeRegistry,
          assetDecisions,
          persist,
          readArtifact,
        });
      }
      if (isSiteOpsNativeVisualWorkflowVersion(context.build.workflowVersion)) {
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_BUNDLE_INVALID",
          "当前原生源码候选缺少 V5 选择包。",
          "failed",
        );
      }
      const selection = await readFrozenSelectionBundle({
        artifact: selectionArtifact,
        expectedCandidateId: context.sample.id,
      });
      const previewCoordinates = selectedVisualPreviewCoordinates({
        bundle: selection.bundle,
        candidateId: context.sample.id,
        samplePreviewLocalAssetId: context.sample.previewLocalAssetId,
        evidencePreviewSha256: visualEvidence.previewSha256,
      });
      if (
        !("providerItemKey" in selection.candidate) ||
        !("visualEvidence" in selection.candidate) ||
        selection.candidate.providerItemKey !==
          visualEvidence.providerItemKey ||
        selection.candidate.visualEvidence.evidenceSha256 !==
          visualEvidence.evidenceSha256
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_SELECTION_COORDINATES_MISMATCH",
          "冻结的视觉候选与选择合同坐标不一致。",
          "failed",
        );
      }
      const selectionV2: VisualSelectionBundleV2 | null =
        isVisualSelectionBundleV2(selection.bundle) ? selection.bundle : null;
      const supportingCandidates = selectionV2?.supportingCandidates ?? [];
      const supportingEvidence = supportingCandidates.map((candidate) =>
        verifiedVisualEvidence(candidate),
      );
      const workflow = siteOpsWorkflowForVersion(context.build.workflowVersion);
      const reactStatic = workflow.frontMindVersion.startsWith("2.");
      const hostOwnedContentDraft = usesHostOwnedContentDraft(
        workflow.frontMindVersion,
      );
      const emptyRouteIds = usesBuildPlanContractV4(workflow.frontMindVersion)
        ? hostEmptyCandidates
        : [];
      const emptyRouteSet = new Set<string>(emptyRouteIds);
      const providerRouteIds = frozenRouteIds.filter(
        (routeId) => !emptyRouteSet.has(routeId),
      );
      // Manus receives only the routes it owns. The persisted SiteBrief stays
      // frozen and complete; Dashboard injects host-owned empty routes after
      // the provider output crosses the local strict contract.
      const promptBrief = {
        ...briefWithoutBrandAssets(brief),
        routes: brief.routes.filter((route) =>
          providerRouteIds.includes(route.id),
        ),
      };
      const designOutputFilename = reactStatic
        ? SITEOPS_WIRE_OUTPUT_FILES.designV3
        : SITEOPS_WIRE_OUTPUT_FILES.design;
      const contentOutputFilename = usesBuildPlanContractV4(
        workflow.frontMindVersion,
      )
        ? usesHostOwnedContentDraft(workflow.frontMindVersion)
          ? SITEOPS_WIRE_OUTPUT_FILES.contentPatchV1
          : SITEOPS_WIRE_OUTPUT_FILES.contentV3
        : SITEOPS_WIRE_OUTPUT_FILES.content;
      const referenceBlueprint = referenceBlueprintSchema.safeParse(
        input.referenceBlueprint,
      );
      const selectionV3 = isVisualSelectionBundleV3(selection.bundle)
        ? selection.bundle
        : null;
      const selectionV4 = isVisualSelectionBundleV4(selection.bundle)
        ? selection.bundle
        : null;
      const selectedV3Blueprint = selectionV3?.candidates.find(
        (candidate) => candidate.id === context.sample.id,
      )?.referenceBlueprint;
      const selectedV4Candidate = selectionV4?.candidates.find(
        (candidate) => candidate.id === context.sample.id,
      );
      const selectedV4Blueprint = selectedV4Candidate?.referenceBlueprint;
      const blueprintCoordinatesMatch = referenceBlueprint.success
        ? referenceBlueprint.data.schemaVersion === 4
          ? Boolean(
              selectedV4Candidate &&
                selectedV4Blueprint &&
                referenceBlueprint.data.referencePreviewLocalAssetId ===
                  context.sample.previewLocalAssetId &&
                referenceBlueprint.data.referencePreviewSha256 ===
                  visualEvidence.previewSha256 &&
                referenceBlueprint.data.previewLocalAssetId ===
                  selectedV4Candidate.realizationPreviewLocalAssetId &&
                referenceBlueprint.data.previewSha256 ===
                  selectedV4Candidate.realizationPreviewSha256 &&
                selectedV4Blueprint.blueprintHash ===
                  referenceBlueprint.data.blueprintHash,
            )
          : referenceBlueprint.data.previewSha256 ===
              visualEvidence.previewSha256 &&
            (!selectedV3Blueprint ||
              selectedV3Blueprint.blueprintHash ===
                referenceBlueprint.data.blueprintHash)
        : false;
      if (
        reactStatic &&
        (!referenceBlueprint.success ||
          referenceBlueprint.data.candidateId !== context.sample.id ||
          referenceBlueprint.data.providerItemKey !==
            visualEvidence.providerItemKey ||
          !blueprintCoordinatesMatch)
      ) {
        throw new SiteOpsManusFailure(
          "VISUAL_REFERENCE_BLUEPRINT_MISMATCH",
          "冻结的视觉构图合同与所选 Hero 不一致，请重新检索后选择。",
          "failed",
        );
      }
      const visualEvidenceInput = {
        queryHash: visualSelectionQueryHash(selection.bundle),
        selectedCandidateId: context.sample.id,
        providerItemKey: visualEvidence.providerItemKey,
        visualEvidenceSha256: visualEvidence.evidenceSha256,
        previewSha256: visualEvidence.previewSha256,
        supportEvidenceSha256s: supportingEvidence.map(
          (evidence) => evidence.evidenceSha256,
        ),
        taxonomy,
      };
      const visual = reactStatic
        ? siteOpsRuntimeVisualEvidenceV2Schema.parse({
            schemaVersion: 2,
            ...visualEvidenceInput,
            referenceBlueprint: referenceBlueprint.success
              ? referenceBlueprint.data
              : undefined,
          })
        : siteOpsRuntimeVisualEvidenceV1Schema.parse(visualEvidenceInput);
      const contentToken = `siteops-content:${operation.id}`;
      const designToken = hostOwnedContentDraft
        ? contentToken
        : `siteops-design:${operation.id}`;
      const hostOwnedDesign = hostOwnedContentDraft
        ? createHostOwnedSiteDesignResultV2({
            operationToken: contentToken,
            brief,
            referenceBlueprint:
              referenceBlueprint.success &&
              referenceBlueprint.data.schemaVersion === 4
                ? referenceBlueprint.data
                : (() => {
                    throw new SiteOpsManusFailure(
                      "VISUAL_REFERENCE_BLUEPRINT_MISMATCH",
                      "冻结的视觉构图合同无效，请重新选择视觉方向。",
                      "failed",
                    );
                  })(),
            taxonomy,
          })
        : null;
      // SiteContentPatchV1 is bound to the immutable, verified executable
      // starter source. The operation token separately fences the frozen
      // design/Brief instance; content values never become source files.
      const hostContentBaseSourceSha256 = hostOwnedContentDraft
        ? workflow.starterSha256
        : null;
      const hostContentBaseline = hostOwnedDesign
        ? canonicalPreviewToGeneratedContent({
            canonical: canonicalizeSiteContentDraft({
              draft: null,
              operationToken: contentToken,
              brief,
              seo: hostOwnedDesign.designSpec.seoPlan,
            }),
            designRouteCompositions:
              hostOwnedDesign.designSpec.routeCompositions.map((route) => ({
                routeId: route.routeId,
                slots: route.slots.map((slot) => ({
                  slotId: slot.slotId,
                  variant: slot.variant,
                })),
              })),
            fallbackSourceDocumentIds: Object.fromEntries(
              brief.routes.map((route) => [route.id, route.sourceDocumentIds]),
            ),
          })
        : null;
      const sourceIdsByRoute = Object.fromEntries(
        brief.routes.map((route) => [route.id, route.sourceDocumentIds]),
      );
      const hostContentPatchSlots: SiteContentPatchSlotManifest[] =
        hostContentBaseline
          ? hostContentBaseline.routes.flatMap((route) => {
              const sourceIds = sourceIdsByRoute[route.routeId] ?? [];
              if (sourceIds.length === 0) return [];
              return route.sections.map((section) => ({
                routeId: route.routeId,
                slotId: section.slotId,
                kind:
                  section.blockType === "feature_list"
                    ? ("list" as const)
                    : ("richText" as const),
                sourceIds,
              }));
            })
          : [];
      const existingHostBaseline =
        siteOpsTrustedFallbackPreviewFromResult(state);
      const buildPreviewBindings = [
        context.build.contractLocalAssetId,
        context.build.sourceLocalAssetId,
        context.build.distLocalAssetId,
        context.build.qaLocalAssetId,
        context.build.provenanceLocalAssetId,
      ];
      const buildHasAnyBoundPreview = buildPreviewBindings.some(Boolean);
      const buildHasCompleteBoundPreview = buildPreviewBindings.every(Boolean);
      const stageHostContentBaseline = async (input: {
        trigger: "initial_baseline" | "provider_no_contract_progress";
        taskId?: string;
      }) => {
        if (
          !hostOwnedContentDraft ||
          !hostOwnedDesign ||
          !hostContentBaseline ||
          !hostContentBaseSourceSha256 ||
          context.build.parentBuildId != null ||
          buildHasAnyBoundPreview ||
          existingHostBaseline
        ) {
          return null;
        }
        const qaUpdated = await db
          .update(siteBuilds)
          .set({ status: "qa_running", updatedAt: new Date() })
          .where(
            and(
              eq(siteBuilds.id, context.build.id),
              eq(siteBuilds.userId, operation.userId),
              inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
              isNull(siteBuilds.parentBuildId),
              isNull(siteBuilds.distLocalAssetId),
            ),
          );
        const qaAffectedRows = Number(
          (Array.isArray(qaUpdated)
            ? (qaUpdated[0] as { affectedRows?: unknown } | undefined)
                ?.affectedRows
            : (qaUpdated as { affectedRows?: unknown } | undefined)
                ?.affectedRows) ?? 0,
        );
        if (qaAffectedRows !== 1) {
          throw new Error("SITEOPS_OPERATION_LEASE_LOST");
        }
        const attempt = await materializeWithSingleHostRetry({
          signal,
          run: () =>
            materialize({
              build: context.build,
              snapshot: { ...context.snapshot, documents },
              brief,
              visual,
              designSpec: hostOwnedDesign.designSpec,
              generatedContent:
                siteOpsGeneratedContentV2Schema.parse(hostContentBaseline),
              assetDecisions,
              brandAsset,
              mode: "preview",
              abortSignal: signal,
              forceTrustedFallback: {
                warningCode: "SITEOPS_CONTENT_PATCH_TRUSTED_FALLBACK",
              },
            }),
        });
        const materialized = attempt.value;
        const artifacts = await persistBuildArtifacts(
          operation,
          materialized,
          persist,
          assertExecutionActive,
          "trusted-fallback",
        );
        const artifactBindings = buildArtifactBindingsSchema.parse({
          contract: {
            id: artifacts.contract.id,
            sha256: materialized.contractSha256,
            bytes: materialized.contractJson.length,
            mimeType: "application/json",
          },
          source: {
            id: artifacts.source.id,
            sha256: materialized.sourceSha256,
            bytes: materialized.sourceZip.length,
            mimeType: "application/zip",
          },
          dist: {
            id: artifacts.dist.id,
            sha256: materialized.distSha256,
            bytes: materialized.distZip.length,
            mimeType: "application/zip",
          },
          qa: {
            id: artifacts.qa.id,
            sha256: materialized.visualQaSha256,
            bytes: materialized.visualQaZip.length,
            mimeType: "application/zip",
          },
          provenance: {
            id: artifacts.provenance.id,
            sha256: materialized.provenanceSha256,
            bytes: materialized.provenanceJson.length,
            mimeType: "application/json",
          },
        });
        const createdAt = new Date();
        const phase = siteContentPatchProgressDeadline({
          state,
          operationToken: contentToken,
          operationStartedAt: operation.startedAt ?? operation.createdAt,
        }).state;
        const baselineState = providerStateV2Schema.parse({
          ...phase,
          stage: "content_pending",
          taskId: input.taskId,
          design: hostOwnedDesign,
          buildPhase: "provider_sync_delayed",
          buildCheckpoint: "artifacts_staged",
          fallbackPreview: {
            status: "staged",
            trigger: input.trigger,
            createdAt: createdAt.toISOString(),
            reconcileUntilAt: nativeTrustedFallbackReconcileUntil({
              fallbackTriggeredAt: createdAt,
              operationStartedAt: operation.startedAt,
              operationCreatedAt: operation.createdAt,
            }).toISOString(),
            buildId: context.build.id,
            taskId: input.taskId ?? null,
            operationToken: `siteops-content-baseline:${operation.id}`,
            selectedPreviewSha256:
              referenceBlueprint.success &&
              referenceBlueprint.data.schemaVersion === 4
                ? referenceBlueprint.data.previewSha256
                : visualEvidence.previewSha256,
            selectedSourceTreeSha256: hostContentBaseSourceSha256,
            artifactBindings,
            buildDelivery: materialized.buildDelivery,
          },
        });
        await persistOperationProgress(
          db,
          operation,
          baselineState,
          input.taskId,
        );
        logManusBuildStage({
          stage: "fallback_render",
          operationId: operation.id,
          buildId: context.build.id,
          phase: "content",
          reason: input.trigger,
          renderMode: "trusted_fallback",
          qaStatus: "partial",
          warningCount: materialized.buildDelivery.warningCodes.length,
        });
        return pending(baselineState, input.taskId, "qa_running", 10_000);
      };

      if (
        hostOwnedContentDraft &&
        context.build.parentBuildId == null &&
        !buildHasCompleteBoundPreview
      ) {
        if (buildHasAnyBoundPreview) {
          throw new SiteOpsManusFailure(
            "BUILD_ARTIFACT_BINDING_FAILED",
            "可信基础预览产物未能完整绑定，已保留本地产物等待处理。",
            "attention_required",
            providerStateV2(state),
          );
        }
        if (!existingHostBaseline) {
          const baseline = await stageHostContentBaseline({
            trigger: "initial_baseline",
            taskId: state?.taskId ?? operation.providerTaskId ?? undefined,
          });
          if (baseline) return baseline;
        }
        if (existingHostBaseline?.status === "staged") {
          // persistOperationProgress can survive a worker crash immediately
          // before fallback_bind. Yield the same staged coordinates so the
          // next worker transaction binds them; never cross the Provider
          // boundary while the executable baseline is still unbound.
          return pending(
            providerStateV2(state),
            state?.taskId ?? operation.providerTaskId ?? undefined,
            "qa_running",
            10_000,
          );
        }
        throw new SiteOpsManusFailure(
          "BUILD_ARTIFACT_BINDING_FAILED",
          "可信基础预览绑定状态不一致，已保留本地产物等待处理。",
          "attention_required",
          providerStateV2(state),
        );
      }
      const client = await getClient();
      const parseDesignCandidate = (value: unknown) => {
        const parsed =
          reactStatic && referenceBlueprint.success
            ? siteDesignResultV2FromWire(
                value,
                frozenRouteIds,
                referenceBlueprint.data,
                emptyRouteIds,
                taxonomy.palette.length,
              )
            : siteDesignResultFromWire(
                value,
                frozenRouteIds,
                emptyRouteIds,
                taxonomy.palette.length,
              );
        validateDesignAndContentBindings({
          routeIds: frozenRouteIds,
          paletteSize: taxonomy.palette.length,
          designSpec: parsed.designSpec,
        });
        return parsed;
      };
      const parseContentCandidate = (
        value: unknown,
        validatedDesign: z.infer<typeof designResultSchema>,
      ) => {
        const parsed = usesBuildPlanContractV4(workflow.frontMindVersion)
          ? pageContentResultV2FromWire(
              value,
              frozenRouteIds,
              documents.map((document) => document.id),
              emptyRouteIds,
            )
          : pageContentResultFromWire(
              value,
              frozenRouteIds,
              documents.map((document) => document.id),
            );
        validateDesignAndContentBindings({
          routeIds: frozenRouteIds,
          paletteSize: taxonomy.palette.length,
          designSpec: validatedDesign.designSpec,
          pageContent: parsed.pageContent,
        });
        return parsed;
      };
      const providerPendingBuildStatus = (
        providerState: ProviderState | null,
      ) =>
        hostOwnedContentDraft
          ? siteOpsTrustedFallbackPreviewFromResult(providerState)?.status ===
            "bound"
            ? ("qa_running" as const)
            : ("building" as const)
          : ("design_compiling" as const);
      let taskId = state?.taskId ?? operation.providerTaskId ?? undefined;

      if (!taskId) {
        if (state?.stage === "create_unknown") {
          const found = await findUniqueCreatedTask(
            client,
            operation,
            designToken,
          );
          if (!found)
            return pending(
              transitionProviderState(state, {
                stage: "create_unknown",
                ...(hostOwnedDesign ? { design: hostOwnedDesign } : {}),
              }),
              undefined,
              providerPendingBuildStatus(state),
            );
          taskId = found.id;
          const taskPendingState = transitionProviderState(state, {
            stage: hostOwnedContentDraft ? "content_pending" : "design_pending",
            taskId,
            ...(hostOwnedDesign ? { design: hostOwnedDesign } : {}),
          });
          try {
            await bindCreatedBuildTask({
              db,
              operation,
              buildId: context.build.id,
              taskId,
              state: taskPendingState,
              preservePreview:
                hostOwnedContentDraft &&
                existingHostBaseline?.status === "bound",
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            if (/^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(code)) {
              throw error;
            }
            if (code === "SITEOPS_BUILD_TASK_BINDING_CONFLICT") {
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_RESULT_PENDING",
                "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
              );
            }
            return pending(
              transitionProviderState(state, {
                stage: "create_unknown",
                ...(hostOwnedDesign ? { design: hostOwnedDesign } : {}),
              }),
              undefined,
              providerPendingBuildStatus(state),
            );
          }
          return pending(
            taskPendingState,
            taskId,
            providerPendingBuildStatus(taskPendingState),
          );
        } else {
          const workflowPackage =
            await loadVerifiedSiteOpsWorkflowPackage(workflow);
          const referencePreviewArtifact = await readArtifact({
            userId: operation.userId,
            localAssetId: previewCoordinates.referenceLocalAssetId,
            expectedSha256: previewCoordinates.referenceSha256,
            expectedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          });
          if (!referencePreviewArtifact) {
            throw new SiteOpsManusFailure(
              "VISUAL_PREVIEW_NOT_FOUND",
              "视觉参考资产不存在。",
              "failed",
            );
          }
          assertProjectVisualArtifact(referencePreviewArtifact, {
            userId: operation.userId,
            projectId: context.project.id,
          });
          const realizationPreviewArtifact =
            previewCoordinates.hasIndependentRealization
              ? await readArtifact({
                  userId: operation.userId,
                  localAssetId: previewCoordinates.realizationLocalAssetId,
                  expectedSha256: previewCoordinates.realizationSha256,
                  expectedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
                })
              : referencePreviewArtifact;
          if (!realizationPreviewArtifact) {
            throw new SiteOpsManusFailure(
              "VISUAL_REALIZATION_PREVIEW_NOT_FOUND",
              "视觉实现预览资产不存在。",
              "failed",
            );
          }
          assertProjectVisualArtifact(realizationPreviewArtifact, {
            userId: operation.userId,
            projectId: context.project.id,
          });
          const supportArtifacts = await Promise.all(
            supportingCandidates.map(async (candidate) => {
              const artifact = await readArtifact({
                userId: operation.userId,
                localAssetId: candidate.previewLocalAssetId,
                expectedSha256: candidate.previewSha256,
                expectedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
              });
              if (!artifact) {
                throw new SiteOpsManusFailure(
                  "VISUAL_PREVIEW_NOT_FOUND",
                  "冻结的辅助视觉预览不存在。",
                  "failed",
                );
              }
              assertProjectVisualArtifact(artifact, {
                userId: operation.userId,
                projectId: context.project.id,
              });
              return artifact;
            }),
          );
          const visualAttachments = [
            workflowAttachment(workflowPackage, workflow),
            ...siteOpsSourceDossierAttachments({
              operationToken: designToken,
              snapshot: {
                id: context.snapshot.id,
                archiveSha256: context.build.knowledgeArchiveHash,
                sourceBuildId: context.snapshot.sourceBuildId,
                sourceBuildRevision: context.snapshot.sourceBuildRevision,
              },
              brief: promptBrief,
              visualEvidence: visual,
              documents,
            }),
            ...(hostOwnedContentDraft && hostContentBaseSourceSha256
              ? [
                  siteContentPatchSlotManifestAttachment({
                    operationToken: contentToken,
                    baseSourceSha256: hostContentBaseSourceSha256,
                    slots: hostContentPatchSlots,
                  }),
                ]
              : []),
            await visualPreviewAttachment(
              realizationPreviewArtifact,
              "selected-visual.png",
            ),
            ...(previewCoordinates.hasIndependentRealization
              ? [
                  await visualPreviewAttachment(
                    referencePreviewArtifact,
                    "selected-reference.png",
                  ),
                ]
              : []),
            ...(await Promise.all(
              supportArtifacts.map((artifact, index) =>
                visualPreviewAttachment(
                  artifact,
                  `support-visual-${index + 1}.png`,
                ),
              ),
            )),
          ];
          const prompt = promptWithMarker(
            hostOwnedContentDraft
              ? `你是 FrontMind 官网内容编辑。严格遵守已附加且通过 manifest 校验的 React Static Company Site Workflow ${workflow.frontMindVersion}；frontmind-siteops-source-dossier-v1.json 是唯一事实来源，frontmind-site-content-slot-manifest-v1.json 是唯一可写槽位合同。Dashboard 已冻结源码、route、路径、slot、组件、CSS、响应式布局、调色板和空状态；你不得修改或输出任何执行代码。只返回 SiteContentPatchWireV1 扁平传输：wireSchemaVersion、operationToken、baseSourceSha256 与 slots；每个 slot 只含 routeId、slotId、kind、valueText、valueList、sourceIds，并严格使用 manifest 中的坐标。richText 使用 valueText 且 valueList 为空；list 使用 valueList 且 valueText 为 null。每个事实 slot 仅引用所附 source dossier 与 manifest 中真实存在的 sourceIds。${emptyRouteIds.length ? `不得返回宿主空状态 route：${emptyRouteIds.join(",")}；` : ""}不得输出 HTML、CSS、JavaScript、依赖、配置、文件路径、组件名、外部资源 URL、调色板、未知事实或解释性长文。把完全相同的扁平 JSON 对象附加为 ${contentOutputFilename} 后立即结束；资料不足时返回空 slots，Dashboard 会使用冻结企业资料中的可信默认值生成基础预览。`
              : reactStatic
                ? `你是 FrontMind 官网设计与信息架构师。严格遵守已附加且通过 manifest 校验的 React Static Company Site Workflow ${workflow.frontMindVersion}，并只使用 frontmind-siteops-source-dossier-v1.json 中冻结的 SiteBrief、视觉证据和知识来源。referenceBlueprint 是 Dashboard 已冻结的主视觉合同，不得替换 Hero family；selected-visual.png 是 FrontMind 可信宿主实际可生成的主视觉预览，selected-reference.png（若附加）是与该方案一对一绑定的真实视觉灵感参考；二者都不是客户网站素材。请返回 SiteDesignWireV3：只为 provider-owned route 输出按冻结顺序分组且唯一的 routeSlots；${emptyRouteIds.length ? `不得返回 Dashboard 自有空状态 route：${emptyRouteIds.join(",")}；` : ""}缺少模型区块时为该 route 返回 overview/statement。使用结构化合同允许的调色板索引；同时把完全相同的 JSON 对象附加为 ${designOutputFilename}，作为结构化抽取失败时的受控恢复副本。不得输出 Hero family、源码、HTML、CSS、依赖、脚本、第三方组件代码或未知事实。`
                : `你是 FrontMind 官网设计与信息架构师。严格遵守已附加且通过 manifest 校验的 Astro Company Site Workflow ${workflow.frontMindVersion}，并只使用冻结 SiteBrief、视觉证据和知识来源。请返回 SiteDesignWireV2，并把完全相同的 JSON 对象附加为 ${SITEOPS_WIRE_OUTPUT_FILES.design}。不得输出源码、脚本、21st 代码或未知事实。`,
            designToken,
          );
          const createUnknownState = transitionProviderState(state, {
            stage: "create_unknown",
            ...(hostOwnedDesign ? { design: hostOwnedDesign } : {}),
          });
          await persistOperationProgress(db, operation, createUnknownState);
          try {
            await assertExecutionActive();
            const created = await client.createTask({
              title: operationTitle(operation),
              prompt,
              attachments: visualAttachments,
              locale: brief.primaryLanguage,
              agentProfile: managedAgentProfileModel(input.agentProfile),
              structuredOutputSchema: hostOwnedContentDraft
                ? siteContentPatchOutputSchema({
                    operationToken: contentToken,
                    baseSourceSha256: hostContentBaseSourceSha256!,
                    slots: hostContentPatchSlots,
                    sourceDocumentIds: documents.map((document) => document.id),
                  })
                : designOutputSchema(
                    designToken,
                    providerRouteIds,
                    taxonomy.palette.length,
                    reactStatic ? "react_static" : "legacy_astro",
                  ),
            });
            taskId = created.taskId;
          } catch (error) {
            if (error instanceof ManusV2ApiError && error.outcomeUnknown)
              return pending(
                createUnknownState,
                undefined,
                providerPendingBuildStatus(createUnknownState),
              );
            if (!hostOwnedContentDraft || !(error instanceof ManusV2ApiError)) {
              throw error;
            }
            taskId = `frontmind-host-fallback:${operation.id}`;
            logManusBuildStage({
              stage: "wire_resolution",
              operationId: operation.id,
              buildId: context.build.id,
              phase: "content",
              reason: "provider_draft_unavailable",
            });
          }
          const taskPendingState = transitionProviderState(createUnknownState, {
            stage: hostOwnedContentDraft ? "content_pending" : "design_pending",
            taskId,
            ...(hostOwnedDesign ? { design: hostOwnedDesign } : {}),
            ...(taskId.startsWith("frontmind-host-fallback:")
              ? { providerDraftUnavailable: true }
              : {}),
          });
          try {
            await bindCreatedBuildTask({
              db,
              operation,
              buildId: context.build.id,
              taskId,
              state: taskPendingState,
              preservePreview:
                hostOwnedContentDraft &&
                existingHostBaseline?.status === "bound",
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            if (/^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(code)) {
              throw error;
            }
            if (code === "SITEOPS_BUILD_TASK_BINDING_CONFLICT") {
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_RESULT_PENDING",
                "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
              );
            }
            // create_unknown was durably reserved before task.create. A
            // transient post-ack DB failure therefore reconciles by the exact
            // operation token instead of creating a second private task.
            return pending(
              createUnknownState,
              undefined,
              providerPendingBuildStatus(createUnknownState),
            );
          }
          return pending(
            taskPendingState,
            taskId,
            providerPendingBuildStatus(taskPendingState),
          );
        }
      }

      if (context.build.upstreamManusTaskId !== taskId) {
        if (context.build.upstreamManusTaskId !== null) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_RESULT_PENDING",
            "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
          );
        }
        const updated = await db
          .update(siteBuilds)
          .set({ upstreamManusTaskId: taskId, updatedAt: new Date() })
          .where(
            and(
              eq(siteBuilds.id, context.build.id),
              eq(siteBuilds.userId, operation.userId),
              inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
              isNull(siteBuilds.upstreamManusTaskId),
            ),
          );
        const affectedRows = Number(
          (Array.isArray(updated)
            ? (updated[0] as { affectedRows?: unknown } | undefined)
                ?.affectedRows
            : (updated as { affectedRows?: unknown } | undefined)
                ?.affectedRows) ?? 0,
        );
        if (affectedRows !== 1) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_RESULT_PENDING",
            "FrontMind AI 建站任务坐标仍在确认中，系统不会重复创建任务。",
          );
        }
      }
      let repairedContent: unknown = null;
      let repairedContentCoordinate: {
        candidateSha256: string;
        source: "structured" | "attachment" | "assistant_json";
      } | null = null;
      if (
        state?.stage === "repair_send_ready" ||
        state?.stage === "repair_send_unknown" ||
        state?.stage === "repair_pending"
      ) {
        if (!state.repairKind || !state.repairAttempt) {
          throw new SiteOpsManusFailure(
            "MANUS_REPAIR_STATE_INVALID",
            "Manus 自动修复状态不完整。",
            "failed",
          );
        }
        if (state.repairKind === "content" && !state.design) {
          throw new SiteOpsManusFailure(
            "MANUS_DESIGN_STATE_MISSING",
            "同一 Manus 任务缺少已校验的设计合同。",
            "failed",
          );
        }
        const repairCategory =
          state.schemaVersion === 2
            ? (state.repairCategory ?? state.repairKind)
            : null;
        const repairToken = repairCategory
          ? `siteops-repair:${operation.id}:${state.repairKind}:${repairCategory}:${state.repairAttempt}`
          : `siteops-repair:${operation.id}:${state.repairKind}:${state.repairAttempt}`;
        const repairSchema =
          state.repairKind === "design"
            ? designOutputSchema(
                repairToken,
                providerRouteIds,
                taxonomy.palette.length,
                reactStatic ? "react_static" : "legacy_astro",
              )
            : generatedContentOutputSchema(
                repairToken,
                state.design?.designSpec.routeCompositions ?? [],
                documents.map((document) => document.id),
                workflow.frontMindVersion,
                emptyRouteIds,
              );
        if (state.stage === "repair_send_ready") {
          const repairPrompt = promptWithMarker(
            state.repairKind === "design"
              ? designRepairPrompt({
                  repairAttempt: state.repairAttempt,
                  maxAttempts: repairCategory === "extraction" ? 1 : 2,
                  outputFilename: designOutputFilename,
                  repairReason: state.repairReason,
                  repeatedSignatureCount:
                    state.schemaVersion === 2
                      ? state.validation?.repeatCount
                      : 0,
                  hostOwnedEmptyRouteIds: emptyRouteIds,
                  wireVersion: reactStatic ? 3 : 2,
                })
              : contentRepairPrompt({
                  repairAttempt: state.repairAttempt,
                  maxAttempts:
                    repairCategory === "materialization" ||
                    repairCategory === "extraction"
                      ? 1
                      : 3,
                  outputFilename: contentOutputFilename,
                  repairReason: state.repairReason,
                  hostOwnedEmptyRouteIds: emptyRouteIds,
                  wireVersion: usesBuildPlanContractV4(
                    workflow.frontMindVersion,
                  )
                    ? 3
                    : 2,
                }),
            repairToken,
          );
          const unknownState = startProviderResultSyncWindow(
            transitionProviderState(state, {
              stage: "repair_send_unknown",
            }),
          );
          await persistOperationProgress(db, operation, unknownState, taskId);
          try {
            await assertExecutionActive();
            await client.sendMessage({
              taskId,
              prompt: repairPrompt,
              structuredOutputSchema: repairSchema,
            });
          } catch (error) {
            if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
              return pending(
                unknownState,
                taskId,
                state.repairKind === "design"
                  ? "design_compiling"
                  : "qa_running",
              );
            }
            throw error;
          }
          const waitingState: ProviderState = {
            ...state,
            stage: "repair_pending",
          };
          await persistOperationProgress(db, operation, waitingState, taskId);
          return pending(
            waitingState,
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
          );
        }
        if (state.stage === "repair_send_unknown") {
          const reconciled = await pollEvents(
            client,
            taskId,
            repairToken,
            state,
            { operationId: operation.id, buildId: context.build.id },
          );
          if (reconciled.deferred) {
            return pending(
              reconciled.providerState,
              taskId,
              state.repairKind === "design" ? "design_compiling" : "qa_running",
              reconciled.nextPollMs,
            );
          }
          if (
            !manusV2EventsContainOperationToken(reconciled.events, repairToken)
          ) {
            const sync = providerResultSyncWindow(
              reconciled.providerState,
              Date.now(),
              operation.updatedAt,
            );
            const grace = structuredResultGrace(
              sync.state,
              reconciled.state.completed,
            );
            if (grace.expired || sync.expired) {
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
                "AI 建站修复消息未能在限定时间内同步，已保留同一任务坐标等待处理。",
                "attention_required",
                grace.state,
              );
            }
            return pending(
              grace.state,
              taskId,
              state.repairKind === "design" ? "design_compiling" : "qa_running",
              reconciled.nextPollMs,
            );
          }
          return pending(
            transitionProviderState(reconciled.providerState, {
              stage: "repair_pending",
              providerSyncStartedAt: undefined,
            }),
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
          );
        }
        const repaired = await pollEvents(client, taskId, repairToken, state, {
          operationId: operation.id,
          buildId: context.build.id,
        });
        if (repaired.deferred) {
          return pending(
            repaired.providerState,
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
            repaired.nextPollMs,
          );
        }
        const repairResolution = await resolveBuildWireValue({
          operationId: operation.id,
          buildId: context.build.id,
          events: repaired.events,
          operationToken: repairToken,
          phase: state.repairKind,
          expectedFilename:
            state.repairKind === "design"
              ? designOutputFilename
              : contentOutputFilename,
          taskCompleted: repaired.state.completed,
          signal,
          ...(!usesHostOwnedContentDraft(workflow.frontMindVersion) ||
          state.repairKind === "design"
            ? {
                validateCandidate: (value: Record<string, unknown>) => {
                  if (state.repairKind === "design") {
                    parseDesignCandidate(value);
                  } else {
                    parseContentCandidate(value, state.design!);
                  }
                },
              }
            : {}),
        });
        if (repairResolution.invalid) {
          const designFailure =
            state.repairKind === "design" && repairResolution.validationError
              ? designValidationFailure(repairResolution.validationError)
              : null;
          const contentReason =
            state.repairKind === "content" && repairResolution.validationError
              ? contentRepairReason(repairResolution.validationError)
              : null;
          const repairReason =
            designFailure?.reason ??
            contentReason ??
            (repairResolution.invalidCode === "SITEOPS_WIRE_OUTPUT_CONFLICT"
              ? "OUTPUT_CONFLICT"
              : "STRUCTURED_OUTPUT_UNAVAILABLE");
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: state.repairKind,
            category: repairResolution.validationError
              ? state.repairKind
              : "extraction",
            design: state.design,
            repairReason,
            candidateSha256: repairResolution.invalidCandidateSha256,
            source: repairResolution.invalidCandidateSource,
            validationSignature:
              designFailure?.signature ??
              (contentReason
                ? contentValidationSignature(
                    repairResolution.validationError,
                    contentReason,
                  )
                : null),
          });
        }
        const rawRepair = repairResolution.value;
        if (!rawRepair) {
          if (repaired.waiting) {
            if (!messageAskUserWaiting(repaired.waiting))
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
                "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
                "failed",
              );
            const resolution = handledWaitingResolution(
              repaired.providerState,
              repaired.waiting.eventId,
            );
            if (resolution === "pending")
              return pending(
                repaired.providerState,
                taskId,
                state.repairKind === "design"
                  ? "design_compiling"
                  : "qa_running",
              );
            if (resolution === "expired")
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_WAITING_UNRESOLVED",
                "FrontMind AI 建站任务在安全继续后仍未恢复输出。",
                "failed",
              );
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: state.repairKind,
              category: "extraction",
              design: state.design,
              repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
              handledWaitingEventId: repaired.waiting.eventId,
              handledWaitingAt: new Date().toISOString(),
            });
          }
          if (repaired.state.failed) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: state.repairKind,
              category: "extraction",
              design: state.design,
              repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
            });
          }
          const grace = structuredResultGrace(
            repaired.providerState,
            repaired.state.completed,
          );
          if (grace.expired) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: state.repairKind,
              category: "extraction",
              design: state.design,
              repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
            });
          }
          return pending(
            grace.state,
            taskId,
            state.repairKind === "design" ? "design_compiling" : "qa_running",
          );
        }
        if (state.repairKind === "design") {
          const repairedDesign = parseDesignCandidate(rawRepair);
          logManusBuildStage({
            stage: "wire_normalized",
            operationId: operation.id,
            buildId: context.build.id,
            phase: "design",
            routeCount: repairedDesign.designSpec.routeCompositions.length,
            slotCount: repairedDesign.designSpec.routeCompositions.reduce(
              (total, route) => total + route.slots.length,
              0,
            ),
            missingCount: repairedDesign.designSpec.routeCompositions.filter(
              (route) =>
                route.slots.length === 1 &&
                ["overview", "news-empty"].includes(
                  route.slots[0]?.slotId ?? "",
                ),
            ).length,
          });
          return pending(
            transitionProviderState(repaired.providerState, {
              stage: "content_send_ready",
              taskId,
              design: repairedDesign,
              repairKind: undefined,
              repairCategory: undefined,
              repairAttempt: undefined,
              repairReason: undefined,
              resultPendingSince: undefined,
              providerStoppedAt: undefined,
            }),
            taskId,
            "contract_ready",
          );
        }
        repairedContent = rawRepair;
        if (repairResolution.candidateSha256 && repairResolution.source) {
          repairedContentCoordinate = {
            candidateSha256: repairResolution.candidateSha256,
            source: repairResolution.source,
          };
        }
      }
      let design = state?.design ?? hostOwnedDesign ?? undefined;
      if (!design && repairedContent === null) {
        const polled = await pollEvents(client, taskId, designToken, state, {
          operationId: operation.id,
          buildId: context.build.id,
        });
        if (polled.deferred) {
          return pending(
            polled.providerState,
            taskId,
            "design_compiling",
            polled.nextPollMs,
          );
        }
        const designResolution = await resolveBuildWireValue({
          operationId: operation.id,
          buildId: context.build.id,
          events: polled.events,
          operationToken: designToken,
          phase: "design",
          expectedFilename: designOutputFilename,
          taskCompleted: polled.state.completed,
          signal,
          validateCandidate: (value) => {
            parseDesignCandidate(value);
          },
        });
        if (designResolution.invalid) {
          const failure = designResolution.validationError
            ? designValidationFailure(designResolution.validationError)
            : null;
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "design",
            category: failure ? "design" : "extraction",
            repairReason:
              failure?.reason ??
              (designResolution.invalidCode === "SITEOPS_WIRE_OUTPUT_CONFLICT"
                ? "OUTPUT_CONFLICT"
                : "STRUCTURED_OUTPUT_UNAVAILABLE"),
            candidateSha256: designResolution.invalidCandidateSha256,
            source: designResolution.invalidCandidateSource,
            validationSignature: failure?.signature,
          });
        }
        const raw = designResolution.value;
        if (!raw) {
          if (polled.waiting) {
            if (!messageAskUserWaiting(polled.waiting))
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
                "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
                "failed",
              );
            const resolution = handledWaitingResolution(
              state
                ? polled.providerState
                : transitionProviderState(null, {
                    stage: "design_pending",
                    taskId,
                  }),
              polled.waiting.eventId,
            );
            if (resolution === "pending")
              return pending(
                state
                  ? polled.providerState
                  : transitionProviderState(null, {
                      stage: "design_pending",
                      taskId,
                    }),
                taskId,
                "design_compiling",
              );
            if (resolution === "expired")
              throw new SiteOpsManusFailure(
                "FRONTMIND_BUILD_WAITING_UNRESOLVED",
                "FrontMind AI 建站任务在安全继续后仍未恢复输出。",
                "failed",
              );
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
              category: "extraction",
              repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
              handledWaitingEventId: polled.waiting.eventId,
              handledWaitingAt: new Date().toISOString(),
            });
          }
          if (polled.state.failed) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
              category: "extraction",
              repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
            });
          }
          const designPendingState = transitionProviderState(
            polled.providerState,
            {
              stage: "design_pending",
              taskId,
              resultPendingSince: state?.resultPendingSince,
            },
          );
          const grace = structuredResultGrace(
            designPendingState,
            polled.state.completed,
          );
          if (grace.expired) {
            return await scheduleRepair({
              db,
              operation,
              build: context.build,
              taskId,
              kind: "design",
              category: "extraction",
              repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
            });
          }
          return pending(grace.state, taskId, "design_compiling");
        }
        design = parseDesignCandidate(raw);
        logManusBuildStage({
          stage: "wire_normalized",
          operationId: operation.id,
          buildId: context.build.id,
          phase: "design",
          routeCount: design.designSpec.routeCompositions.length,
          slotCount: design.designSpec.routeCompositions.reduce(
            (total, route) => total + route.slots.length,
            0,
          ),
          missingCount: design.designSpec.routeCompositions.filter(
            (route) =>
              route.slots.length === 1 &&
              ["overview", "news-empty"].includes(route.slots[0]?.slotId ?? ""),
          ).length,
        });
        return pending(
          transitionProviderState(polled.providerState, {
            stage: "content_send_ready",
            taskId,
            design,
            resultPendingSince: undefined,
            providerStoppedAt: undefined,
          }),
          taskId,
          "contract_ready",
        );
      }

      if (state?.stage === "content_send_ready") {
        if (!design) {
          throw new SiteOpsManusFailure(
            "MANUS_DESIGN_STATE_MISSING",
            "同一 Manus 任务缺少已校验的设计合同。",
            "failed",
          );
        }
        const revisionInstruction = input.feedback
          ? "客户本次修改要求已作为 frontmind-customer-feedback-v1.json 附件提供，必须在事实与构建合同范围内落实。"
          : "这是首版官网内容。";
        const commonContract = {
          source: {
            knowledgeSnapshotId: context.snapshot.id,
            archiveSha256: context.build.knowledgeArchiveHash,
            sourceBuildId: context.snapshot.sourceBuildId,
            sourceBuildRevision: context.snapshot.sourceBuildRevision,
          },
          workflow: {
            upstreamSha256: workflow.upstreamSha256,
            version: workflow.frontMindVersion,
            manifestSha256: workflow.runtimeManifestSha256,
            starterVersion: workflow.starterVersion,
            starterSha256: workflow.starterSha256,
            componentLibraryVersion: workflow.componentLibraryVersion,
            materializerVersion: workflow.materializerVersion,
            materializerSha256: workflow.materializerSha256,
          },
          identity: {
            companyName: brief.companyName,
            primaryLanguage: brief.primaryLanguage,
            verifiedContacts: brief.contacts.map(
              (contact) => `${contact.kind}:${contact.value}`,
            ),
          },
          routes: brief.routes,
          assets: assetDecisions,
          seo: {
            ...design.designSpec.seoPlan,
            environment: "preview",
            canonicalPolicy: "forbidden",
          },
          target: { environment: "preview", canonicalOrigin: null },
          qaPolicyVersion: workflow.qaPolicyVersion,
        } as const;
        const canonicalContract =
          reactStatic && referenceBlueprint.success
            ? (() => {
                const rendererCoordinates =
                  reactStaticRendererCoordinates(workflow);
                const parsedVisual =
                  siteOpsRuntimeVisualEvidenceV2Schema.parse(visual);
                const {
                  schemaVersion: _visualSchemaVersion,
                  referenceBlueprint: _visualReferenceBlueprint,
                  ...visualEvidence
                } = parsedVisual;
                const buildPlanContractV4 = usesBuildPlanContractV4(
                  workflow.frontMindVersion,
                );
                return buildPlanContractV4
                  ? composeBuildPlanContractV4({
                      schemaVersion: 4,
                      contractKind: "build_plan",
                      ...commonContract,
                      renderer: {
                        kind: "react_static_v2",
                        reactVersion: "19.2.1",
                        componentLibraryVersion:
                          workflow.componentLibraryVersion as
                            | "2.2.0"
                            | "2.3.0"
                            | "2.4.0"
                            | "2.6.0",
                        materializerVersion: workflow.materializerVersion as
                          | "2.2.0"
                          | "2.3.0"
                          | "2.4.0"
                          | "2.6.0",
                      },
                      content: {
                        schemaVersion: 2,
                        inventoryHash: canonicalSiteOpsSha256(
                          brief.contentInventory,
                        ),
                        routePolicyVersion: "snapshot-conditional-v1",
                        sourcePolicy: "frozen_snapshot_only",
                        externalAcquisitionAllowed: false,
                        publicSourceLabels: "forbidden",
                      },
                      visual: visualEvidence,
                      referenceBlueprint: referenceBlueprint.data,
                      designSpecHash: canonicalSiteOpsSha256(design.designSpec),
                    })
                  : composeBuildPlanContractV3({
                      schemaVersion: 3,
                      contractKind: "build_plan",
                      ...commonContract,
                      renderer: {
                        kind: "react_static_v1",
                        reactVersion: "19.2.1",
                        componentLibraryVersion:
                          rendererCoordinates.componentLibraryVersion as
                            | "2.0.0"
                            | "2.1.0",
                        materializerVersion:
                          rendererCoordinates.materializerVersion as
                            | "2.0.0"
                            | "2.1.0",
                      },
                      visual: visualEvidence,
                      referenceBlueprint: referenceBlueprint.data,
                      designSpecHash: canonicalSiteOpsSha256(design.designSpec),
                    });
              })()
            : composeBuildContractV2({
                schemaVersion: 2,
                ...commonContract,
                visual: {
                  ...siteOpsRuntimeVisualEvidenceV1Schema.parse(visual),
                  designSpecHash: canonicalSiteOpsSha256(design.designSpec),
                  componentLibraryVersion: workflow.componentLibraryVersion,
                },
              });
        const contractAttachment =
          reactStatic && referenceBlueprint.success
            ? usesBuildPlanContractV4(workflow.frontMindVersion)
              ? siteOpsBuildPlanContractV4Attachment(canonicalContract)
              : siteOpsBuildPlanContractV3Attachment(canonicalContract)
            : siteOpsBuildContractAttachment(canonicalContract);
        const prompt = promptWithMarker(
          usesBuildPlanContractV4(workflow.frontMindVersion)
            ? `继续同一个 FrontMind AI 建站任务。frontmind-build-plan-contract-v4.json 是 Dashboard 根据已校验设计与冻结知识库存生成的预物化计划合同；冻结的 ReferenceBlueprint、Hero family、route 与 inventory 不可更改。请返回 PageContentWireV3：只返回 provider-owned route；${emptyRouteIds.length ? `不得返回 Dashboard 自有空状态 route：${emptyRouteIds.join(",")}，也不得输出对应 block 或 company_news entity；` : ""}Dashboard 会注入可信空状态。使用受支持的 typed blockType，实体、FAQ 与 officialLinks 只能来自 source dossier 且逐项绑定 sourceDocumentIds；不得输出内部来源标签。feature_list、steps、metrics 必须使用非空 items，entity_grid 与 faq_preview 必须使用非空引用；这些数据驱动区块可使用空 paragraphs，prose、quote、cta 则必须有正文。实体 slug 请优先使用小写 ASCII 字母、数字、连字符或下划线。不得浏览、抓取或编造行业/企业新闻。把完全相同的 JSON 对象附加为 ${contentOutputFilename}，附件是结构化抽取失败时的正式恢复副本。不得重复 SEO，不得生成源码、HTML、依赖、表单提交或外部脚本。${revisionInstruction}`
            : reactStatic
              ? `继续同一个 FrontMind AI 建站任务。frontmind-build-plan-contract-v3.json 是 Dashboard 根据已校验设计生成的预物化计划合同；冻结的 ReferenceBlueprint 与 Hero family 不可更改，source dossier 仍是唯一事实来源。请返回 PageContentWireV2，routeId 与 slotId 必须按合同完全一致，每段关键内容必须引用允许的 sourceDocumentIds；同时把完全相同的 JSON 对象附加为 ${SITEOPS_WIRE_OUTPUT_FILES.content}，作为结构化抽取失败时的受控恢复副本。不得重复 SEO，不得生成源码、HTML、依赖、表单提交、外部脚本或未知事实。${revisionInstruction}`
              : `继续同一个 FrontMind AI 建站任务。frontmind-build-contract-v2.json 是 Dashboard 根据已校验设计生成的唯一构建合同；source dossier 仍是唯一事实来源。请返回 PageContentWireV2，并严格匹配冻结 route、slot 与 sourceDocumentIds；同时把完全相同的 JSON 对象附加为 ${SITEOPS_WIRE_OUTPUT_FILES.content}，作为结构化抽取失败时的受控恢复副本。${revisionInstruction}`,
          contentToken,
        );
        const contentSendUnknownState = startProviderResultSyncWindow(
          transitionProviderState(state, {
            stage: "content_send_unknown",
            taskId,
            design,
            repairKind: undefined,
            repairCategory: undefined,
            repairAttempt: undefined,
            repairReason: undefined,
            resultPendingSince: undefined,
            providerStoppedAt: undefined,
          }),
        );
        await persistOperationProgress(
          db,
          operation,
          contentSendUnknownState,
          taskId,
        );
        try {
          await assertExecutionActive();
          await client.sendMessage({
            taskId,
            prompt,
            attachments: [
              contractAttachment,
              ...(input.feedback
                ? [siteOpsCustomerFeedbackAttachment(input.feedback)]
                : []),
            ],
            structuredOutputSchema: generatedContentOutputSchema(
              contentToken,
              design.designSpec.routeCompositions,
              documents.map((document) => document.id),
              workflow.frontMindVersion,
              emptyRouteIds,
            ),
          });
        } catch (error) {
          if (error instanceof ManusV2ApiError && error.outcomeUnknown)
            return pending(contentSendUnknownState, taskId, "building");
          throw error;
        }
        const contentPendingState = transitionProviderState(
          contentSendUnknownState,
          { stage: "content_pending", taskId, design },
        );
        await persistOperationProgress(
          db,
          operation,
          contentPendingState,
          taskId,
        );
        return pending(contentPendingState, taskId, "building");
      }

      if (state?.stage === "content_send_unknown") {
        const reconciled = await pollEvents(
          client,
          taskId,
          contentToken,
          state,
          { operationId: operation.id, buildId: context.build.id },
        );
        if (reconciled.deferred)
          return pending(
            transitionProviderState(reconciled.providerState, {
              stage: "content_send_unknown",
              taskId,
              design,
            }),
            taskId,
            "building",
            reconciled.nextPollMs,
          );
        if (
          !manusV2EventsContainOperationToken(reconciled.events, contentToken)
        ) {
          const sync = providerResultSyncWindow(
            reconciled.providerState,
            Date.now(),
            operation.updatedAt,
          );
          const grace = structuredResultGrace(
            sync.state,
            reconciled.state.completed,
          );
          if (grace.expired || sync.expired) {
            throw new SiteOpsManusFailure(
              "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
              "AI 建站内容消息未能在限定时间内同步，已保留同一任务坐标等待处理。",
              "attention_required",
              grace.state,
            );
          }
          return pending(
            transitionProviderState(grace.state, {
              stage: "content_send_unknown",
              taskId,
              design,
            }),
            taskId,
            "building",
            reconciled.nextPollMs,
          );
        }
        return pending(
          transitionProviderState(reconciled.providerState, {
            stage: "content_pending",
            taskId,
            design,
            providerSyncStartedAt: undefined,
          }),
          taskId,
          "building",
        );
      }

      const unavailableProviderDraft = () => ({
        events: [] as ManusV2MessageEvent[],
        state: { failed: true, completed: false },
        waiting: null,
        providerState: providerStateV2(state),
        deferred: false,
        nextPollMs: 10_000,
      });
      const polled =
        repairedContent === null
          ? state?.providerDraftUnavailable
            ? unavailableProviderDraft()
            : await (async () => {
                try {
                  return await pollEvents(client, taskId, contentToken, state, {
                    operationId: operation.id,
                    buildId: context.build.id,
                  });
                } catch (error) {
                  // In 2.4 Manus is an optional content-draft supplier, not
                  // the owner of a deliverable site. A read-side provider
                  // outage must therefore degrade to the frozen-brief
                  // canonical preview instead of discarding valid input.
                  if (
                    !hostOwnedContentDraft ||
                    !(error instanceof ManusV2ApiError)
                  ) {
                    throw error;
                  }
                  logManusBuildStage({
                    stage: "wire_resolution",
                    operationId: operation.id,
                    buildId: context.build.id,
                    phase: "content",
                    reason: "provider_draft_unavailable",
                  });
                  return unavailableProviderDraft();
                }
              })()
          : null;
      const contentProgress =
        polled && hostOwnedContentDraft
          ? siteContentPatchProgressDeadline({
              state: polled.providerState,
              operationToken: contentToken,
              operationStartedAt: operation.startedAt ?? operation.createdAt,
            })
          : null;
      const boundContentBaseline = siteOpsTrustedFallbackPreviewFromResult(
        contentProgress?.state ?? polled?.providerState ?? state,
      );
      const pendingBoundContentBaseline = (
        providerState: ProviderState,
        nextPollMs: number,
      ) => {
        if (
          boundContentBaseline?.status !== "bound" ||
          !boundContentBaseline.operationToken.startsWith(
            "siteops-content-baseline:",
          )
        ) {
          return null;
        }
        if (Date.now() >= Date.parse(boundContentBaseline.reconcileUntilAt)) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
            "正式内容补丁对账窗口已结束，可信基础预览与原任务坐标已保留。",
            "attention_required",
            providerStateV2(providerState),
          );
        }
        return pending(
          transitionProviderState(providerState, {
            stage: "content_pending",
            taskId,
            design,
            buildPhase: "provider_sync_delayed",
          }),
          taskId,
          "qa_running",
          nextPollMs,
        );
      };
      if (polled?.deferred) {
        const baselinePending = pendingBoundContentBaseline(
          contentProgress?.state ?? polled.providerState,
          contentProgress?.expired ? 300_000 : 60_000,
        );
        if (baselinePending) return baselinePending;
        return pending(
          contentProgress?.state ?? polled.providerState,
          taskId,
          providerPendingBuildStatus(polled.providerState),
          polled.nextPollMs,
        );
      }
      const contentResolution = polled
        ? await resolveBuildWireValue({
            operationId: operation.id,
            buildId: context.build.id,
            events: polled.events,
            operationToken: contentToken,
            phase: "content",
            expectedFilename: contentOutputFilename,
            taskCompleted: polled.state.completed,
            acceptCurrentPhaseWhileRunning: hostOwnedContentDraft,
            signal,
            ...(!usesHostOwnedContentDraft(workflow.frontMindVersion)
              ? {
                  validateCandidate: (value: Record<string, unknown>) => {
                    parseContentCandidate(value, design!);
                  },
                }
              : {}),
          })
        : null;
      const hostCanonicalContent = usesHostOwnedContentDraft(
        workflow.frontMindVersion,
      );
      if (contentResolution?.invalid && !hostCanonicalContent) {
        const repairReason = contentResolution.validationError
          ? contentRepairReason(contentResolution.validationError)
          : contentResolution.invalidCode === "SITEOPS_WIRE_OUTPUT_CONFLICT"
            ? "OUTPUT_CONFLICT"
            : "STRUCTURED_OUTPUT_UNAVAILABLE";
        return await scheduleRepair({
          db,
          operation,
          build: context.build,
          taskId,
          kind: "content",
          category: contentResolution.validationError
            ? "content"
            : "extraction",
          design,
          repairReason,
          candidateSha256: contentResolution.invalidCandidateSha256,
          source: contentResolution.invalidCandidateSource,
          validationSignature: contentResolution.validationError
            ? contentValidationSignature(
                contentResolution.validationError,
                repairReason,
              )
            : null,
        });
      }
      const rawContent = contentResolution?.invalid
        ? null
        : (repairedContent ?? contentResolution?.value ?? null);
      if (!rawContent && polled) {
        if (polled.waiting && !messageAskUserWaiting(polled.waiting)) {
          throw new SiteOpsManusFailure(
            "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
            "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
            "failed",
          );
        }
        const baselinePending = pendingBoundContentBaseline(
          contentProgress?.state ?? polled.providerState,
          contentProgress?.expired ? 300_000 : 60_000,
        );
        if (baselinePending) return baselinePending;
      }
      const canUseTrustedContentFallback =
        hostCanonicalContent &&
        (contentResolution?.invalid === true ||
          polled?.state.failed === true ||
          polled?.state.completed === true ||
          Boolean(polled?.waiting));
      if (!rawContent && !canUseTrustedContentFallback) {
        if (polled!.waiting) {
          if (!messageAskUserWaiting(polled!.waiting))
            throw new SiteOpsManusFailure(
              "FRONTMIND_BUILD_UNEXPECTED_WAITING_ACTION",
              "FrontMind AI 建站任务请求了当前流程不允许的外部操作。",
              "failed",
            );
          const resolution = handledWaitingResolution(
            state
              ? polled!.providerState
              : transitionProviderState(null, {
                  stage: "content_pending",
                  taskId,
                  design,
                }),
            polled!.waiting.eventId,
          );
          if (resolution === "pending")
            return pending(
              state
                ? polled!.providerState
                : transitionProviderState(null, {
                    stage: "content_pending",
                    taskId,
                    design,
                  }),
              taskId,
              "building",
            );
          if (resolution === "expired")
            throw new SiteOpsManusFailure(
              "FRONTMIND_BUILD_WAITING_UNRESOLVED",
              "FrontMind AI 建站任务在安全继续后仍未恢复输出。",
              "failed",
            );
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            category: "extraction",
            design,
            repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
            handledWaitingEventId: polled!.waiting.eventId,
            handledWaitingAt: new Date().toISOString(),
          });
        }
        if (polled!.state.failed) {
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            category: "extraction",
            design,
            repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
          });
        }
        const contentPendingState = transitionProviderState(
          polled!.providerState,
          {
            stage: "content_pending",
            taskId,
            design,
            resultPendingSince: state?.resultPendingSince,
          },
        );
        const grace = structuredResultGrace(
          contentPendingState,
          polled!.state.completed,
        );
        if (grace.expired) {
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            category: "extraction",
            design,
            repairReason: "STRUCTURED_OUTPUT_UNAVAILABLE",
          });
        }
        return pending(grace.state, taskId, "building");
      }
      let generatedContent: z.infer<typeof siteOpsGeneratedContentSchema>;
      let contentPatchRenderMode: "content_patch" | "trusted_fallback" | null =
        null;
      let contentPatchWarningCount = 0;
      try {
        let canonicalizedFromProvider = false;
        const currentContent = usesBuildPlanContractV4(
          workflow.frontMindVersion,
        );
        const contentResult = hostCanonicalContent
          ? null
          : parseContentCandidate(rawContent, design!);
        if (hostCanonicalContent) {
          if (!hostContentBaseline || !hostContentBaseSourceSha256) {
            throw new Error("SITE_CONTENT_PATCH_BASELINE_MISSING");
          }
          const appliedPatch = applySiteContentPatchV1Resilient({
            patch: siteContentPatchFromWire(rawContent),
            expectedOperationToken: contentToken,
            expectedBaseSourceSha256: hostContentBaseSourceSha256,
            baseline: hostContentBaseline,
            allowedSourceIdsByRoute: sourceIdsByRoute,
            allowedAssetIds: assetDecisions
              .filter((decision) => decision.decision === "publish")
              .map((decision) => decision.id),
          });
          contentPatchRenderMode = appliedPatch.renderMode;
          contentPatchWarningCount = appliedPatch.warnings.length;
          if (appliedPatch.renderMode === "trusted_fallback") {
            const baselinePending = pendingBoundContentBaseline(
              contentProgress?.state ?? polled?.providerState ?? state!,
              300_000,
            );
            if (baselinePending) return baselinePending;
          }
          canonicalizedFromProvider =
            appliedPatch.renderMode === "content_patch";
          generatedContent = siteOpsGeneratedContentV2Schema.parse(
            // The frozen baseline was already aligned one-to-one with the
            // host design before the patch was applied. Running the index-
            // based adapter again can reinterpret a valid list slot as prose
            // when its visual variant is not `cards`, silently discarding the
            // provider value. The resilient applier preserves the exact
            // frozen route/slot shape, so strict parsing is the only remaining
            // boundary required here.
            appliedPatch.canonical,
          );
        } else {
          generatedContent = currentContent
            ? siteOpsGeneratedContentV2Schema.parse({
                seo: design!.designSpec.seoPlan,
                ...contentResult!.pageContent,
              })
            : siteOpsGeneratedContentSchema.parse({
                seo: design!.designSpec.seoPlan,
                routes: contentResult!.pageContent.routes,
              });
        }
        logManusBuildStage({
          stage: hostCanonicalContent
            ? "content_canonicalized"
            : "wire_normalized",
          operationId: operation.id,
          buildId: context.build.id,
          phase: "content",
          routeCount: generatedContent.routes.length,
          slotCount: generatedContent.routes.reduce(
            (total, route) => total + route.sections.length,
            0,
          ),
          missingCount: generatedContent.routes.filter(
            (route) => "emptyState" in route,
          ).length,
          ...(hostCanonicalContent && !canonicalizedFromProvider
            ? {
                reason: "trusted_frozen_input_fallback",
                warningCount: contentPatchWarningCount,
              }
            : hostCanonicalContent
              ? { warningCount: contentPatchWarningCount }
              : {}),
        });
      } catch (error) {
        if (hostCanonicalContent) {
          throw new SiteOpsManusFailure(
            "BUILD_CANONICALIZATION_FAILED",
            "冻结知识资料无法形成安全预览，请申请重置后从当前企业知识库重新开始。",
            "failed",
          );
        }
        const repairReason = contentRepairReason(error);
        const coordinate =
          repairedContentCoordinate ??
          (contentResolution?.candidateSha256 && contentResolution.source
            ? {
                candidateSha256: contentResolution.candidateSha256,
                source: contentResolution.source,
              }
            : null);
        return await scheduleRepair({
          db,
          operation,
          build: context.build,
          taskId,
          kind: "content",
          category: "content",
          design,
          repairReason,
          candidateSha256: coordinate?.candidateSha256,
          source: coordinate?.source,
          validationSignature: contentValidationSignature(error, repairReason),
        });
      }
      const qaUpdated = await db
        .update(siteBuilds)
        .set({ status: "qa_running", updatedAt: new Date() })
        .where(
          and(
            eq(siteBuilds.id, context.build.id),
            eq(siteBuilds.userId, operation.userId),
            inArray(siteBuilds.status, PROVIDER_MUTABLE_BUILD_STATUSES),
          ),
        );
      const qaAffectedRows = Number(
        (Array.isArray(qaUpdated)
          ? (qaUpdated[0] as { affectedRows?: unknown } | undefined)
              ?.affectedRows
          : (qaUpdated as { affectedRows?: unknown } | undefined)
              ?.affectedRows) ?? 0,
      );
      if (qaAffectedRows !== 1) {
        throw new Error("SITEOPS_OPERATION_LEASE_LOST");
      }
      let materialized: Awaited<ReturnType<typeof materializeAstroSite>>;
      const materializationStartedAt = Date.now();
      let localRetryCount = 0;
      try {
        await assertExecutionActive();
        const attempt = await materializeWithSingleHostRetry({
          signal,
          run: () =>
            materialize({
              build: context.build,
              snapshot: { ...context.snapshot, documents },
              brief,
              visual,
              designSpec: design!.designSpec,
              generatedContent,
              assetDecisions,
              brandAsset,
              mode: "preview",
              abortSignal: signal,
              ...contentPatchMaterializationOverrides({
                renderMode: contentPatchRenderMode,
                warningCount: contentPatchWarningCount,
              }),
            }),
        });
        materialized = attempt.value;
        localRetryCount = attempt.localRetryCount;
        await assertExecutionActive();
        logManusBuildStage({
          stage: "palette_normalized",
          operationId: operation.id,
          buildId: context.build.id,
        });
        logManusBuildStage({
          stage:
            materialized.buildDelivery.renderMode === "trusted_fallback"
              ? "fallback_render"
              : "primary_render",
          operationId: operation.id,
          buildId: context.build.id,
          renderMode: materialized.buildDelivery.renderMode,
          qaStatus: materialized.buildDelivery.qaStatus,
          warningCount: materialized.buildDelivery.warningCodes.length,
        });
        logManusBuildStage({
          stage: "qa_completed",
          operationId: operation.id,
          buildId: context.build.id,
          renderMode: materialized.buildDelivery.renderMode,
          qaStatus: materialized.buildDelivery.qaStatus,
          warningCount: materialized.buildDelivery.warningCodes.length,
          latencyMs: Date.now() - materializationStartedAt,
        });
      } catch (error) {
        signal.throwIfAborted();
        const classified = classifySiteOpsMaterializationFailure(error);
        if (classified.retryClass === "content_repair") {
          if (hostCanonicalContent) {
            throw new SiteOpsManusFailure(
              "BUILD_CANONICALIZATION_FAILED",
              "冻结知识资料无法形成安全预览，请申请重置后从当前企业知识库重新开始。",
              "failed",
            );
          }
          const repairReason = contentRepairReason(error);
          const coordinate =
            repairedContentCoordinate ??
            (contentResolution?.candidateSha256 && contentResolution.source
              ? {
                  candidateSha256: contentResolution.candidateSha256,
                  source: contentResolution.source,
                }
              : null);
          return await scheduleRepair({
            db,
            operation,
            build: context.build,
            taskId,
            kind: "content",
            category: "materialization",
            design,
            repairReason,
            candidateSha256: coordinate?.candidateSha256,
            source: coordinate?.source,
            validationSignature: contentValidationSignature(
              error,
              repairReason,
            ),
          });
        }
        const safeDetails = safeMaterializationDetails(classified, {
          durationMs: Date.now() - materializationStartedAt,
          assetDecisionCount: assetDecisions.length,
          publishedCount: assetDecisions.filter(
            (decision) => decision.decision === "publish",
          ).length,
          omittedDuplicateCount: assetDecisions.filter(
            (decision) => decision.decision === "omit",
          ).length,
          quarantineCount: assetDecisions.filter(
            (decision) => decision.decision === "quarantine",
          ).length,
          localRetryCount:
            classified.retryClass === "host_transient" ? 1 : localRetryCount,
        });
        const diagnostics = {
          schemaVersion: 1,
          stage: "materialization_failed",
          taskId,
          materialization: {
            phase: classified.phase,
            internalCode: classified.code,
            retryClass: classified.retryClass,
            safeDetails,
          },
        } satisfies Record<string, unknown>;
        console.error("[siteops-manus] materialization_failed", {
          event: "siteops_materialization_failed",
          operationId: operation.id,
          projectId: operation.projectId,
          buildId: context.build.id,
          providerTaskId: taskId,
          workflowVersion: context.build.workflowVersion,
          phase: classified.phase,
          internalCode: classified.code,
          retryClass: classified.retryClass,
          ...safeDetails,
        });
        return publicMaterializationFailure(classified, taskId, diagnostics);
      }
      let artifacts: Awaited<ReturnType<typeof persistBuildArtifacts>>;
      try {
        artifacts = await persistBuildArtifacts(
          operation,
          materialized,
          persist,
          assertExecutionActive,
        );
        logManusBuildStage({
          stage: "preview_persisted",
          operationId: operation.id,
          buildId: context.build.id,
          renderMode: materialized.buildDelivery.renderMode,
          qaStatus: materialized.buildDelivery.qaStatus,
          warningCount: materialized.buildDelivery.warningCodes.length,
          latencyMs: Date.now() - materializationStartedAt,
        });
      } catch (error) {
        signal.throwIfAborted();
        const classified =
          error instanceof SiteOpsMaterializationError
            ? error
            : new SiteOpsMaterializationError({
                phase: "artifact_persistence",
                code: "SITEOPS_BUILD_ARTIFACT_PERSISTENCE_FAILED",
                retryClass: "host_deterministic",
                cause: error,
              });
        const safeDetails = safeMaterializationDetails(classified, {
          durationMs: Date.now() - materializationStartedAt,
          assetDecisionCount: assetDecisions.length,
          publishedCount: assetDecisions.filter(
            (decision) => decision.decision === "publish",
          ).length,
          omittedDuplicateCount: assetDecisions.filter(
            (decision) => decision.decision === "omit",
          ).length,
          quarantineCount: assetDecisions.filter(
            (decision) => decision.decision === "quarantine",
          ).length,
          localRetryCount,
        });
        const diagnostics = {
          schemaVersion: 1,
          stage: "materialization_failed",
          taskId,
          materialization: {
            phase: classified.phase,
            internalCode: classified.code,
            retryClass: classified.retryClass,
            safeDetails,
          },
        } satisfies Record<string, unknown>;
        console.error("[siteops-manus] materialization_failed", {
          event: "siteops_materialization_failed",
          operationId: operation.id,
          projectId: operation.projectId,
          buildId: context.build.id,
          providerTaskId: taskId,
          workflowVersion: context.build.workflowVersion,
          phase: classified.phase,
          internalCode: classified.code,
          retryClass: classified.retryClass,
          ...safeDetails,
        });
        return publicMaterializationFailure(classified, taskId, diagnostics);
      }
      logManusBuildStage({
        stage: "build_preview_ready",
        operationId: operation.id,
        buildId: context.build.id,
        candidateSha256: materialized.distSha256,
        byteCount: materialized.distZip.length,
        latencyMs: Date.now() - materializationStartedAt,
      });
      return {
        status: "succeeded",
        providerTaskId: taskId,
        projectStatus: "preview_ready",
        buildStatus: "preview_ready",
        result: {
          buildId: context.build.id,
          specHash: materialized.contract.specHash,
          distHash: materialized.distSha256,
          buildDelivery: materialized.buildDelivery,
          qaSummary: artifacts.qaSummary,
          artifactIds: {
            contract: artifacts.contract.id,
            source: artifacts.source.id,
            dist: artifacts.dist.id,
            qa: artifacts.qa.id,
            provenance: artifacts.provenance.id,
          },
          artifactBindings: {
            contract: {
              id: artifacts.contract.id,
              sha256: materialized.contractSha256,
              bytes: materialized.contractJson.length,
              mimeType: "application/json",
            },
            source: {
              id: artifacts.source.id,
              sha256: materialized.sourceSha256,
              bytes: materialized.sourceZip.length,
              mimeType: "application/zip",
            },
            dist: {
              id: artifacts.dist.id,
              sha256: materialized.distSha256,
              bytes: materialized.distZip.length,
              mimeType: "application/zip",
            },
            qa: {
              id: artifacts.qa.id,
              sha256: materialized.visualQaSha256,
              bytes: materialized.visualQaZip.length,
              mimeType: "application/zip",
            },
            provenance: {
              id: artifacts.provenance.id,
              sha256: materialized.provenanceSha256,
              bytes: materialized.provenanceJson.length,
              mimeType: "application/json",
            },
          },
        },
        message: completedSiteBuildMessage(),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof Error &&
        /^SITEOPS_OPERATION_LEASE_(?:LOST|EXPIRED)$/u.test(error.message)
      ) {
        throw error;
      }
      const failure = resultFailure(error);
      console.error("[siteops-manus] provider_failed", {
        event: "siteops_manus_provider_failed",
        operationId: operation.id,
        projectId: operation.projectId,
        kind: operation.kind,
        status: failure.status,
        code: "code" in failure ? failure.code : "FRONTMIND_BUILD_FAILED",
        internalCode: safeProviderInternalCode(error),
        errorName: safeProviderErrorName(error),
        validation: safeProviderValidationDetails(error),
        ...safeManusApiErrorCoordinates(error),
      });
      return failure;
    }
  };
}

let registered = false;

export function registerManusSiteOpsProvider(
  dependencies: ManusProviderDependencies = {},
) {
  if (registered) return () => undefined;
  const unregister = registerSiteOpsProviderHandler(
    "manus",
    createManusSiteOpsProviderHandler(dependencies),
  );
  registered = true;
  return () => {
    unregister();
    registered = false;
  };
}
