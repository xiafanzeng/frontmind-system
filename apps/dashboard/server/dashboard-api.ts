import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { and, eq, inArray } from "drizzle-orm";
import ExcelJS from "exceljs";
import express from "express";
import JSZip from "jszip";
import { z } from "zod";

import {
  deliveryTickets,
  knowledgeBaseBuildNodes,
  userDashboardContents,
} from "../drizzle/schema";
import {
  dashboardContentAssetSchema,
  dashboardAdminImportModuleSchema,
  dashboardMonitoringCurrentTemplateSchema,
  dashboardMetricSchema,
  dashboardModuleImportPreviewSchema,
  dashboardModuleTemplateMetadataSchema,
  dashboardMonitoringAnswerSchema,
  dashboardOptimizationReportSchema,
  dashboardOptimizationReportTemplateSchema,
  dashboardQuestionsTemplateSchema,
  createDashboardModuleTemplateMetadata,
  createDefaultDashboardPayload,
  dashboardPayloadSchema,
  dashboardQuestionSchema,
  dashboardSectionSchema,
  dashboardTableSchema,
  dashboardCitationRecordSchema,
  type DashboardAdminImportModule,
  type DashboardModuleImportPreview,
  type DashboardPayload,
  type KnowledgeAsset,
  type KnowledgeDocument,
} from "../shared/dashboard";
import {
  replaceMonitoringBatchSchema,
  type ReplaceMonitoringBatchInput,
} from "../shared/monitoring";
import {
  responseLogicDraftSchema,
  saveResponseLogicSchema,
  type SaveResponseLogicInput,
} from "../shared/response-logic";
import type { FrontMindRequest } from "./_core/express-auth";
import { requireExpressAuth } from "./_core/express-auth";
import { safeErrorForLog } from "./_core/sensitive-data";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import {
  getCredentialForUpstreamResource,
  type AuthenticatedUser,
} from "./auth-service";
import {
  assertDashboardEnterpriseIdentity,
  assertWorkspaceAccess,
  createKnowledgeSnapshot,
  DashboardEnterpriseMismatchError,
  DashboardRevisionConflictError,
  getDashboardWorkspace,
  getKnowledgeAsset,
  getKnowledgeAssetById,
  getLatestKnowledgeSnapshot,
  getKnowledgeSnapshotById,
  getKnowledgeSnapshotForWorkspace,
  updateDashboardWorkspace,
  type DashboardWorkspaceWriteHook,
} from "./dashboard-service";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
  knowledgeArchiveFileIdFromUrl,
  type KnowledgeArchiveDescriptor,
} from "./knowledge-base-artifact";
import { assertKnowledgeBasePublishable } from "./knowledge-base-progress-service";
import { assertKnowledgeBaseWritable } from "./knowledge-base-reset-service";
import {
  assertServiceCapability,
  ServiceEntitlementError,
  updateWorkspaceQuestionsByAdminBatch,
} from "./service-entitlement";
import {
  getMonitoringFilterOptions,
  getMonitoringCurrentTemplateBatches,
  mergeQuestionOnlyCitationsIntoMonitoringBatch,
  monitoringBeijingDate,
  monitoringModelKey,
  replaceMonitoringBatch,
  replaceMonitoringCurrentTemplateBatches,
} from "./monitoring-service";
import {
  assertResponseLogicDraftPublishable,
  listResponseLogicEntries,
  ResponseLogicRevisionConflictError,
  saveResponseLogicEntriesBatch,
} from "./response-logic-service";
import { getUpstreamBaseUrl } from "./upstream-config";
import { getDb } from "./db";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import { assertKnowledgeMaintenanceTicketForUpload } from "./delivery-ticket-service";
import {
  assertDeliveryProjectContext,
  createKnowledgeMonitoringHandoff,
} from "./delivery-role-service";
import type { DeliveryRoleType } from "../shared/delivery-roles";
import {
  consumeDashboardImportPreflight,
  dashboardImportPreflightStoreForExecutor,
  DashboardImportPreflightError,
  issueDashboardImportPreflight,
} from "./dashboard-import-preflight-service";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  KnowledgeSnapshotArchiveError,
  knowledgeArchiveContentDisposition,
  persistKnowledgeSnapshotArchive,
  readKnowledgeSnapshotArchive,
  removeKnowledgeSnapshotArchive,
} from "./knowledge-snapshot-archive-store";
import { readKnowledgeBuildArtifact } from "./knowledge-build-artifact-store";
import { assertKnowledgeBasePackageMatchesBuild } from "./knowledge-base-package-validation";
import {
  assertKnowledgeBaseCustomerUploadVisualBindings,
  verifiedKnowledgeBaseCustomerUploadsForBuild,
} from "./knowledge-base-customer-upload";
import { knowledgeBasePublicationBindingHash } from "./knowledge-base-publication-binding";
import {
  basicRasterImageDimensions,
  decodedRasterImageDimensions,
  hasSupportedImageSignature,
  imageMimeByExtension,
  validateProgressReportScreenshot,
} from "./knowledge-archive-image-validation";
import {
  decodeKnowledgeArchiveHeader as decodeHeader,
  effectiveKnowledgeArchiveCharacterCount as effectiveCharacterCount,
  knowledgeArchiveFormalText as formalKnowledgeText,
  knowledgeArchiveTitleFromPath as titleFromPath,
  markedKnowledgeArchiveFormalContent as markedFormalContent,
  normalizeKnowledgeArchiveTextDocument as normalizeTextDocument,
  parseDashboardRevisionHeader as dashboardRevisionHeader,
  safeKnowledgeArchivePath as safeArchivePath,
  stripLeadingKnowledgeArchiveFrontmatter as stripLeadingMarkdownFrontmatter,
  validateKnowledgeArchiveEntryPath as validateArchiveEntryPath,
} from "./knowledge-archive-text-utils";

export { validateProgressReportScreenshot } from "./knowledge-archive-image-validation";

const router = express.Router();
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

function assertNotDeliveryAdministratorExecution(actor: AuthenticatedUser) {
  if (actor.role === "admin" && actor.adminAccessLevel === "delivery_admin") {
    throw new Error("交付管理员只负责流程调度，不能执行上传或发布操作");
  }
}

function deliveryProjectAssignmentId(req: express.Request) {
  return String(req.header("x-delivery-project-assignment-id") || "").trim();
}

async function assertRoleScopedWorkspaceExecution(input: {
  req: FrontMindRequest;
  targetUserId: number;
  expectedRoleType: DeliveryRoleType;
  allowCustomerSelf?: boolean;
  requirePrimaryCustomerAssignment?: boolean;
}) {
  const actor = input.req.frontmindUser!;
  if (actor.role === "delivery_member") {
    const projectAssignmentId = deliveryProjectAssignmentId(input.req);
    if (!projectAssignmentId) {
      throw new Error("缺少当前客户项目岗位标识");
    }
    return assertDeliveryProjectContext({
      actor,
      projectAssignmentId,
      customerUserId: input.targetUserId,
      expectedRoleType: input.expectedRoleType,
    });
  }
  assertNotDeliveryAdministratorExecution(actor);
  if (
    actor.role === "user" &&
    (!input.allowCustomerSelf || actor.id !== input.targetUserId)
  ) {
    throw new Error("当前账号不能执行该交付操作");
  }
  await assertWorkspaceAccess(actor, input.targetUserId);
  return null;
}

const DELIVERY_IMPORT_MODULE_ACCESS: Partial<
  Record<
    DashboardAdminImportModule,
    { roleType: DeliveryRoleType; operations: string[] }
  >
> = {
  keywords: {
    roleType: "monitoring_optimization_engineer",
    operations: ["question_catalog"],
  },
  questions: {
    roleType: "monitoring_optimization_engineer",
    operations: ["question_catalog"],
  },
  monitoring: {
    roleType: "monitoring_optimization_engineer",
    operations: [
      "initial_monitoring",
      "monitoring_import",
      "monitoring_retest",
    ],
  },
  metrics: {
    roleType: "monitoring_optimization_engineer",
    operations: ["stage_report"],
  },
  "optimization-report": {
    roleType: "monitoring_optimization_engineer",
    operations: ["stage_report"],
  },
  "response-logic": {
    roleType: "content_distribution_engineer",
    operations: ["response_logic"],
  },
  "content-assets": {
    roleType: "content_distribution_engineer",
    operations: ["content_asset_publish"],
  },
  sections: {
    roleType: "content_distribution_engineer",
    operations: ["content_asset_publish"],
  },
};

async function assertDeliveryModuleImport(input: {
  req: FrontMindRequest;
  targetUserId: number;
  importModule: DashboardAdminImportModule;
}) {
  const access = DELIVERY_IMPORT_MODULE_ACCESS[input.importModule];
  if (!access) {
    throw new Error("当前模块不属于交付成员工作台");
  }
  const role = await assertRoleScopedWorkspaceExecution({
    req: input.req,
    targetUserId: input.targetUserId,
    expectedRoleType: access.roleType,
    requirePrimaryCustomerAssignment: false,
  });
  const ticketId = String(
    input.req.header("x-delivery-ticket-id") || "",
  ).trim();
  if (!ticketId || !role) {
    throw new Error("缺少当前交付工单标识");
  }
  const db = await getDb();
  if (!db) throw new Error("数据库暂时不可用");
  const rows = await db
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.id, ticketId),
        eq(deliveryTickets.userId, input.targetUserId),
        eq(deliveryTickets.workflowDomain, role.roleType),
        eq(
          deliveryTickets.assignedProjectAssignmentId,
          role.projectAssignmentId,
        ),
        eq(deliveryTickets.assignedMemberId, input.req.frontmindUser!.id),
        inArray(deliveryTickets.operation, access.operations),
        inArray(deliveryTickets.status, [
          "submitted",
          "needs_information",
          "scheduled",
          "in_progress",
        ]),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new Error("当前工单无权发布该业务模块");
  }
}
const MAX_UNPACKED_BYTES = 220 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const CUSTOMER_UPLOAD_PACKAGE_MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const ENTERPRISE_PRODUCT_MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const ENTERPRISE_PRODUCT_MAX_IMAGE_BYTES = 160 * 1024 * 1024;

export type KnowledgeBaseValidationProfile =
  | "website-lead-v1"
  | "dashboard-enterprise-v1"
  | "historical";

export type KnowledgeArchiveValidationCategory =
  | "structure"
  | "media"
  | "content"
  | "unsafe";

export class KnowledgeArchiveValidationError extends Error {
  constructor(
    public readonly category: KnowledgeArchiveValidationCategory,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeArchiveValidationError";
  }
}

function knowledgeArchiveErrorCode(error: unknown) {
  if (!(error instanceof KnowledgeArchiveValidationError)) return undefined;
  return `KNOWLEDGE_ARCHIVE_${error.category.toUpperCase()}_INVALID`;
}

function classifyKnowledgeArchiveError(
  message: string,
): KnowledgeArchiveValidationCategory {
  if (
    /(?:不安全|路径|符号链接|压缩比|解压后|文件过多|文件过大|有效的 ZIP|CRC|corrupt|unsafe)/i.test(
      message,
    )
  ) {
    return "unsafe";
  }
  if (/(?:图片|图像|MIME|asset|image|packagedImages|哈希)/i.test(message)) {
    return "media";
  }
  if (
    /(?:正文|知识叶子|重复模板|customer-visible|evidence-bearing|原始快照|页面摘录)/i.test(
      message,
    )
  ) {
    return "content";
  }
  return "structure";
}

class MonitoringTargetBatchRequiredError extends Error {
  readonly code = "MONITORING_TARGET_BATCH_REQUIRED";
  readonly statusCode = 409;

  constructor() {
    super(
      "该文件只有问题级引用。请先预检并选择一个包含答案明细的目标监控批次。",
    );
  }
}

class MonitoringPreviewRequiredError extends Error {
  readonly code = "MONITORING_PREVIEW_REQUIRED";
  readonly statusCode = 409;

  constructor() {
    super("问题监控文件必须先完成预检，再使用预检返回的文件哈希发布。");
  }
}

class MonitoringFileChangedError extends Error {
  readonly code = "MONITORING_FILE_CHANGED";
  readonly statusCode = 409;

  constructor() {
    super("文件内容已发生变化，请重新预检后再发布。");
  }
}

class DashboardImportPreviewRequiredError extends Error {
  readonly code = "DASHBOARD_IMPORT_PREVIEW_REQUIRED";
  readonly statusCode = 409;

  constructor() {
    super("该模块文件必须先完成预检，再使用预检返回的文件哈希发布。");
  }
}

class DashboardImportFileChangedError extends Error {
  readonly code = "DASHBOARD_IMPORT_FILE_CHANGED";
  readonly statusCode = 409;

  constructor() {
    super("模块文件内容已发生变化，请重新预检后再发布。");
  }
}

class DashboardTemplateRevisionError extends Error {
  readonly code = "DASHBOARD_TEMPLATE_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor(message = "模板已过期，请下载当前内容模板后重新编辑。") {
    super(message);
  }
}
const requiredKnowledgeFiles = [
  "README.md",
  "00_knowledge_tree.md",
  "00_crawl_coverage_report.md",
  "00_web_intelligence_report.md",
  "00_source_index.md",
  "09_media_assets/asset_inventory.md",
  "10_reference_assets/reference_asset_inventory.md",
] as const;
const packageManifestPath = "00_package_manifest.json";
const completenessPath = "00_completeness.json";
const websiteLeadDisplayBranchByDirectory = new Map([
  ["01_company_overview", "company-identity"],
  ["02_team", "team"],
  ["03_products", "products-services"],
  ["04_technology", "core-capabilities"],
  ["05_manufacturing", "core-capabilities"],
  ["06_industries", "customers-industries"],
  ["07_service", "cooperation"],
  ["08_competitive_advantages", "why-frontmind"],
]);

const packageDocumentKindSchema = z.enum([
  "overview",
  "leaf",
  "evidence",
  "report",
  "index",
]);
const packageEvidenceStatusSchema = z.enum([
  "verified_first_party",
  "verified_authoritative",
  "supported_third_party",
  "inferred",
  "needs_verification",
  "not_applicable",
]);
const packageAssetOwnershipSchema = z.literal("first_party");
const packageContentStatusSchema = z.enum([
  "complete",
  "limited_evidence",
  "needs_verification",
]);
const packageImageSelectionStatusSchema = z.enum([
  "target_met",
  "source_limited",
  "budget_limited",
]);
const packageAssetTypeSchema = z.enum([
  "brand_identity",
  "product_ui",
  "product_diagram",
  "case_photo",
  "team_photo",
  "environment_photo",
  "certificate_badge",
  "document_figure",
  "customer_supplied",
  "other",
]);
const packageAssetDisplayRoleSchema = z.enum(["hero", "inline", "badge"]);
const requiredImageDiscoveryMethods = new Set([
  "img",
  "srcset",
  "lazy_load",
  "picture",
  "css_background",
  "open_graph",
  "gallery",
  "official_document",
]);
const packageSourceUrlSchema = z
  .string()
  .trim()
  .url()
  .max(4_000)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    );
  }, "source URL must be credential-free HTTP(S)");
const websiteV2ImageDiscoveryMethodSchema = z.enum([
  "img",
  "srcset_or_lazy",
  "picture",
  "css_background",
  "open_graph",
  "gallery",
  "official_document",
]);
const websiteV2PackageManifestSchema = z
  .object({
    schemaVersion: z.union([z.literal(2), z.literal(3)]),
    profile: z.literal("website-lead-v1"),
    documents: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            path: z.string().trim().min(1).max(600),
            kind: packageDocumentKindSchema,
            title: z.string().trim().min(1).max(512),
            branchId: z.string().trim().min(1).max(191).optional(),
            order: z.number().int().min(0).max(10_000).optional(),
            evidenceStatus: packageEvidenceStatusSchema.optional(),
            sourceIds: z
              .array(z.string().trim().min(1).max(191))
              .max(500)
              .optional(),
            assetIds: z
              .array(z.string().trim().min(1).max(191))
              .max(500)
              .optional(),
            customerVisible: z.boolean(),
            evidenceCharacters: z.number().int().nonnegative().optional(),
            dynamicMinimumCharacters: z.number().int().nonnegative().optional(),
            evidenceDocumentIds: z
              .array(z.string().trim().min(1).max(191))
              .max(500)
              .optional(),
            productFamilyIds: z
              .array(z.string().trim().min(1).max(191))
              .max(120)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1_500),
    assets: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            path: z.string().trim().min(1).max(600),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            mimeType: z.enum([
              "image/avif",
              "image/gif",
              "image/jpeg",
              "image/png",
              "image/webp",
            ]),
            bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
            width: z.number().int().positive().max(100_000),
            height: z.number().int().positive().max(100_000),
            caption: z.string().trim().min(1).max(2_000),
            alt: z.string().trim().max(1_000).optional(),
            branchId: z.string().trim().min(1).max(191),
            documentIds: z
              .array(z.string().trim().min(1).max(191))
              .min(1)
              .max(500),
            sourcePageUrl: packageSourceUrlSchema.optional(),
            sourceAssetUrl: packageSourceUrlSchema.optional(),
            sourceDocumentPath: z.string().trim().min(1).max(600).optional(),
            sourceKind: z
              .enum(["official_web", "official_document", "user_upload"])
              .optional(),
            ownership: packageAssetOwnershipSchema,
            assetType: packageAssetTypeSchema,
            displayRole: packageAssetDisplayRoleSchema,
          })
          .strict(),
      )
      .max(48),
    counts: z
      .object({
        totalFiles: z.number().int().nonnegative().max(2_000),
        customerVisibleCharacters: z.number().int().nonnegative().max(40_000),
        evidenceCharacters: z.number().int().nonnegative().max(300_000),
        packagedImages: z.number().int().nonnegative().max(48),
      })
      .strict(),
    branchEvidence: z
      .array(
        z
          .object({
            branchId: z.enum([
              "company-identity",
              "team",
              "products-services",
              "core-capabilities",
              "customers-industries",
              "cooperation",
              "why-frontmind",
            ]),
            overviewDocumentId: z.string().trim().min(1).max(191),
            contentStatus: packageContentStatusSchema,
            deduplicatedEvidenceCharacters: z.number().int().nonnegative(),
            dynamicOverviewMinimum: z.number().int().nonnegative().max(5_000),
            checkedSourceCount: z.number().int().positive(),
          })
          .strict(),
      )
      .length(7),
    imageSelection: z
      .object({
        status: packageImageSelectionStatusSchema,
        discoveredCandidateImages: z.number().int().nonnegative(),
        inspectedCandidateImages: z.number().int().nonnegative(),
        eligibleFirstPartyImages: z.number().int().nonnegative().max(48),
        rejectedCandidateImages: z.number().int().nonnegative(),
        scannedSourcePages: z.number().int().nonnegative(),
        discoveryMethods: z.array(websiteV2ImageDiscoveryMethodSchema).max(7),
        candidates: z
          .array(
            z
              .object({
                url: packageSourceUrlSchema.optional(),
                sourcePageUrl: packageSourceUrlSchema.optional(),
                sourceDocumentPath: z
                  .string()
                  .trim()
                  .min(1)
                  .max(600)
                  .optional(),
                sourceKind: z
                  .enum(["official_web", "official_document", "user_upload"])
                  .optional(),
                method: websiteV2ImageDiscoveryMethodSchema,
                status: z.enum(["eligible", "rejected", "uninspected"]),
                assetId: z.string().trim().min(1).max(191).optional(),
                rejectionReason: z.string().trim().min(8).max(500).optional(),
              })
              .strict(),
          )
          .max(1_000),
        productFamilies: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(191),
                name: z.string().trim().min(1).max(500),
                officialVisualFound: z.boolean(),
                checkedSources: z.number().int().nonnegative(),
                assetIds: z.array(z.string().trim().min(1).max(191)).max(48),
                gapReason: z.string().trim().min(8).max(2_000).optional(),
              })
              .strict(),
          )
          .max(120),
        shortfallReason: z.string().trim().min(8).max(2_000).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.branchEvidence.map((branch) => branch.branchId)).size !== 7
    ) {
      context.addIssue({
        code: "custom",
        path: ["branchEvidence"],
        message: "website v2 branchEvidence must cover seven unique branches",
      });
    }
    const candidates = value.imageSelection.candidates;
    const eligible = candidates.filter(
      (candidate) => candidate.status === "eligible",
    );
    const rejected = candidates.filter(
      (candidate) => candidate.status === "rejected",
    );
    const uninspected = candidates.filter(
      (candidate) => candidate.status === "uninspected",
    );
    if (
      new Set(
        candidates.map(
          (candidate) =>
            candidate.url || `document:${candidate.sourceDocumentPath || ""}`,
        ),
      ).size !== candidates.length ||
      value.imageSelection.discoveredCandidateImages !== candidates.length ||
      value.imageSelection.inspectedCandidateImages !==
        eligible.length + rejected.length ||
      value.imageSelection.eligibleFirstPartyImages !== eligible.length ||
      value.imageSelection.rejectedCandidateImages !== rejected.length ||
      value.imageSelection.discoveredCandidateImages !==
        value.imageSelection.inspectedCandidateImages + uninspected.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["imageSelection", "candidates"],
        message: "website v2 candidate ledger arithmetic is inconsistent",
      });
    }
    candidates.forEach((candidate, index) => {
      const valid =
        (candidate.status === "eligible" &&
          Boolean(candidate.assetId) &&
          candidate.rejectionReason === undefined) ||
        (candidate.status === "rejected" &&
          candidate.assetId === undefined &&
          Boolean(candidate.rejectionReason)) ||
        (candidate.status === "uninspected" &&
          candidate.assetId === undefined &&
          candidate.rejectionReason === undefined);
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["imageSelection", "candidates", index],
          message:
            "website v2 candidate fields must match its eligibility status",
        });
      }
    });
    const assetsById = new Map(value.assets.map((asset) => [asset.id, asset]));
    eligible.forEach((candidate, index) => {
      const asset = candidate.assetId
        ? assetsById.get(candidate.assetId)
        : undefined;
      if (
        !asset ||
        asset.sourceAssetUrl !== candidate.url ||
        asset.sourcePageUrl !== candidate.sourcePageUrl ||
        asset.sourceDocumentPath !== candidate.sourceDocumentPath
      ) {
        context.addIssue({
          code: "custom",
          path: ["imageSelection", "candidates", index],
          message:
            "website v2 eligible candidate must match its packaged asset URLs",
        });
      }
    });
    value.assets.forEach((asset, index) => {
      if (
        eligible.filter((candidate) => candidate.assetId === asset.id)
          .length !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["assets", index],
          message:
            "website v2 packaged asset must appear exactly once in eligible candidates",
        });
      }
    });
    const status = value.imageSelection.status;
    const invalidStatus =
      (status === "target_met" &&
        (uninspected.length > 0 ||
          value.imageSelection.shortfallReason !== undefined ||
          !value.assets.some(
            (asset) => asset.assetType === "brand_identity",
          ))) ||
      (status === "source_limited" &&
        (uninspected.length > 0 || !value.imageSelection.shortfallReason)) ||
      (status === "budget_limited" &&
        (uninspected.length === 0 || !value.imageSelection.shortfallReason));
    if (invalidStatus) {
      context.addIssue({
        code: "custom",
        path: ["imageSelection", "status"],
        message:
          "website v2 image-selection status does not match coverage-first rules",
      });
    }
  });

const internalPackageManifestSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
    ]),
    profile: z.enum(["website-lead-v1", "dashboard-enterprise-v1"]),
    // Required by builder v4 at bind time. Optional here preserves historical
    // schema-v3 archives created before the server-authoritative build epoch.
    buildRevision: z.number().int().nonnegative().optional(),
    websiteV2Normalized: z.literal(true).optional(),
    documents: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            path: z.string().trim().min(1).max(600),
            kind: packageDocumentKindSchema,
            title: z.string().trim().min(1).max(512),
            branchId: z.string().trim().min(1).max(191).optional(),
            branchTitle: z.string().trim().min(1).max(255).optional(),
            order: z.number().int().min(0).max(10_000).optional(),
            evidenceStatus: packageEvidenceStatusSchema.optional(),
            sourceIds: z
              .array(z.string().trim().min(1).max(191))
              .max(500)
              .default([]),
            evidenceDocumentIds: z
              .array(z.string().trim().min(1).max(191))
              .max(500)
              .optional(),
            assetIds: z
              .array(z.string().trim().min(1).max(191))
              .max(500)
              .default([]),
            customerVisible: z.boolean(),
            evidenceCharacters: z.number().int().nonnegative().optional(),
            requiredFormalCharacters: z.number().int().nonnegative().optional(),
            contentStatus: packageContentStatusSchema.optional(),
            productFamilyId: z.string().trim().min(1).max(191).optional(),
            productFamilyIds: z
              .array(z.string().trim().min(1).max(191))
              .max(120)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1_500),
    assets: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(191),
            path: z.string().trim().min(1).max(600),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            mimeType: z.enum([
              "image/avif",
              "image/gif",
              "image/jpeg",
              "image/png",
              "image/webp",
            ]),
            bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
            width: z.number().int().positive().max(100_000),
            height: z.number().int().positive().max(100_000),
            caption: z.string().trim().min(1).max(2_000),
            alt: z.string().trim().max(1_000).optional(),
            branchId: z.string().trim().min(1).max(191),
            documentIds: z
              .array(z.string().trim().min(1).max(191))
              .min(1)
              .max(500),
            sourcePageUrl: packageSourceUrlSchema.optional(),
            sourceAssetUrl: packageSourceUrlSchema.optional(),
            sourceDocumentPath: z.string().trim().min(1).max(600).optional(),
            sourceKind: z
              .enum([
                "official_web",
                "official_document",
                "official_logo_upload",
                "user_upload",
              ])
              .optional(),
            sourceUploadIndex: z.number().int().min(0).max(99).optional(),
            sourceUploadFileId: z
              .string()
              .trim()
              .min(1)
              .max(512)
              .refine(
                (value) => !/[\u0000-\u001f\u007f]/u.test(value),
                "source upload file ID must not contain control characters",
              )
              .optional(),
            sourceUploadSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .optional(),
            sourceUploadFilename: z
              .string()
              .trim()
              .min(1)
              .max(255)
              .refine(
                (value) =>
                  value !== "." &&
                  value !== ".." &&
                  !/[\\/\u0000-\u001f\u007f]/u.test(value),
                "source upload filename must be a safe basename",
              )
              .optional(),
            sourceUploadMimeType: z
              .enum([
                "image/avif",
                "image/bmp",
                "image/gif",
                "image/heic",
                "image/heif",
                "image/jpeg",
                "image/png",
                "image/svg+xml",
                "image/tiff",
                "image/vnd.microsoft.icon",
                "image/webp",
                "image/x-icon",
              ])
              .optional(),
            sourceUploadSizeBytes: z
              .number()
              .int()
              .positive()
              .max(MAX_IMAGE_BYTES)
              .optional(),
            ownership: packageAssetOwnershipSchema,
            assetType: packageAssetTypeSchema.optional(),
            displayRole: packageAssetDisplayRoleSchema.optional(),
          })
          .strict(),
      )
      .max(480),
    counts: z
      .object({
        totalFiles: z.number().int().nonnegative().max(2_000),
        customerVisibleCharacters: z.number().int().nonnegative().max(180_000),
        evidenceCharacters: z.number().int().nonnegative().max(3_000_000),
        packagedImages: z.number().int().nonnegative().max(480),
      })
      .strict(),
    branchEvidence: z
      .array(
        z
          .object({
            branchId: z.enum([
              "company-identity",
              "team",
              "products-services",
              "core-capabilities",
              "customers-industries",
              "cooperation",
              "why-frontmind",
            ]),
            overviewDocumentId: z.string().trim().min(1).max(191),
            contentStatus: packageContentStatusSchema,
            deduplicatedEvidenceCharacters: z.number().int().nonnegative(),
            dynamicOverviewMinimum: z.number().int().nonnegative().max(5_000),
            checkedSourceCount: z.number().int().positive(),
          })
          .strict(),
      )
      .length(7)
      .optional(),
    imageSelection: z
      .object({
        status: packageImageSelectionStatusSchema.optional(),
        discoveredCandidateImages: z.number().int().nonnegative().optional(),
        inspectedCandidateImages: z.number().int().nonnegative().optional(),
        eligibleFirstPartyImages: z
          .number()
          .int()
          .nonnegative()
          .max(10_000_000),
        rejectedCandidateImages: z.number().int().nonnegative().optional(),
        scannedSourcePages: z.number().int().nonnegative().optional(),
        discoveryMethods: z
          .array(z.string().trim().min(1).max(100))
          .max(100)
          .optional(),
        rejectionReasons: z
          .array(
            z
              .object({
                reason: z.string().trim().min(1).max(500),
                count: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .max(500)
          .optional(),
        stopReason: z.string().trim().min(1).max(2_000).optional(),
        productFamilyCoverage: z
          .array(
            z
              .object({
                familyId: z.string().trim().min(1).max(191),
                familyName: z.string().trim().min(1).max(500),
                officialImageAvailable: z.boolean(),
                assetIds: z.array(z.string().trim().min(1).max(191)).max(500),
                checkedSources: z.array(packageSourceUrlSchema).max(500),
                checkedSourceCount: z.number().int().positive().optional(),
                gapReason: z.string().trim().min(1).max(2_000).optional(),
              })
              .strict(),
          )
          .max(500)
          .optional(),
        candidates: z
          .array(
            z
              .object({
                url: packageSourceUrlSchema.optional(),
                sourcePageUrl: packageSourceUrlSchema.optional(),
                sourceDocumentPath: z
                  .string()
                  .trim()
                  .min(1)
                  .max(600)
                  .optional(),
                sourceKind: z
                  .enum([
                    "official_web",
                    "official_document",
                    "official_logo_upload",
                    "user_upload",
                  ])
                  .optional(),
                method: z.string().trim().min(1).max(100),
                status: z.enum(["eligible", "rejected", "uninspected"]),
                assetId: z.string().trim().min(1).max(191).optional(),
                rejectionReason: z.string().trim().min(1).max(500).optional(),
              })
              .strict(),
          )
          .max(1_800)
          .optional(),
        shortfallReason: z.string().trim().min(1).max(2_000).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.profile === "dashboard-enterprise-v1" &&
      value.schemaVersion === 4 &&
      value.buildRevision === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["buildRevision"],
        message: "Dashboard v4 requires buildRevision",
      });
    }
    if (
      value.profile === "dashboard-enterprise-v1" &&
      (value.schemaVersion === 3 || value.schemaVersion === 4) &&
      value.buildRevision !== undefined
    ) {
      const leaves = value.documents.filter(
        (document) => document.kind === "leaf",
      );
      const orders: number[] = [];
      leaves.forEach((leaf, index) => {
        for (const key of ["branchId", "branchTitle", "order"] as const) {
          if (leaf[key] === undefined) {
            context.addIssue({
              code: "custom",
              path: ["documents", value.documents.indexOf(leaf), key],
              message: `builder v4 leaf requires ${key}`,
            });
          }
        }
        if (typeof leaf.order === "number") orders.push(leaf.order);
      });
      const expectedOrders = Array.from(
        { length: leaves.length },
        (_, index) => index,
      );
      if (
        orders.length !== expectedOrders.length ||
        [...orders]
          .sort((left, right) => left - right)
          .some((order, index) => order !== expectedOrders[index])
      ) {
        context.addIssue({
          code: "custom",
          path: ["documents"],
          message:
            "builder v4 leaf order must be the complete zero-based sequence",
        });
      }
    }
    const documentById = new Map(
      value.documents.map((document) => [document.id, document]),
    );
    const assetById = new Map(value.assets.map((asset) => [asset.id, asset]));
    const documentIds = new Set(value.documents.map((document) => document.id));
    const documentPaths = new Set(
      value.documents.map((document) =>
        document.path.normalize("NFKC").toLowerCase(),
      ),
    );
    const assetIds = new Set(value.assets.map((asset) => asset.id));
    const assetPaths = new Set(
      value.assets.map((asset) => asset.path.normalize("NFKC").toLowerCase()),
    );
    if (value.schemaVersion !== 1) {
      if (
        value.profile === "website-lead-v1" &&
        value.websiteV2Normalized !== true
      ) {
        context.addIssue({
          code: "custom",
          path: ["profile"],
          message: "website v2 must use the Website-specific manifest contract",
        });
      }
      value.documents.forEach((document, index) => {
        if (!["overview", "leaf"].includes(document.kind)) return;
        for (const key of [
          "evidenceCharacters",
          "evidenceDocumentIds",
          "requiredFormalCharacters",
          "contentStatus",
        ] as const) {
          if (document[key] === undefined) {
            context.addIssue({
              code: "custom",
              path: ["documents", index, key],
              message: `schemaVersion 2 customer content requires ${key}`,
            });
          }
        }
      });
      const selection = value.imageSelection;
      const requiredImageSelectionKeys = [
        "status",
        "discoveredCandidateImages",
        "inspectedCandidateImages",
        "rejectedCandidateImages",
        "scannedSourcePages",
        "discoveryMethods",
        "rejectionReasons",
        "stopReason",
        "candidates",
      ] as const;
      for (const key of requiredImageSelectionKeys) {
        if (selection[key] === undefined) {
          context.addIssue({
            code: "custom",
            path: ["imageSelection", key],
            message: `schemaVersion 2 image selection requires ${key}`,
          });
        }
      }
      if (
        !(
          value.profile === "dashboard-enterprise-v1" &&
          (value.schemaVersion === 3 || value.schemaVersion === 4)
        ) &&
        selection.productFamilyCoverage === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["imageSelection", "productFamilyCoverage"],
          message:
            "schemaVersion 2 image selection requires productFamilyCoverage",
        });
      }
      if (value.profile === "dashboard-enterprise-v1") {
        if (
          (value.schemaVersion === 3 || value.schemaVersion === 4) &&
          selection.productFamilyCoverage !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["imageSelection", "productFamilyCoverage"],
            message:
              "dashboard enterprise v3 packages only one Logo and must omit productFamilyCoverage",
          });
        }
        if (value.websiteV2Normalized !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["websiteV2Normalized"],
            message: "dashboard enterprise v2 cannot use Website markers",
          });
        }
        if (value.branchEvidence !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["branchEvidence"],
            message: "dashboard enterprise v2 does not use branchEvidence",
          });
        }
        value.documents.forEach((document, index) => {
          if (
            document.productFamilyIds !== undefined ||
            document.path.length > 512
          ) {
            context.addIssue({
              code: "custom",
              path: ["documents", index],
              message:
                "dashboard enterprise v2 uses productFamilyId and 512-character document paths",
            });
          }
        });
        value.assets.forEach((asset, index) => {
          if (
            asset.path.length > 512 ||
            (asset.sourcePageUrl?.length || 0) > 4_000 ||
            (asset.sourceAssetUrl?.length || 0) > 4_000 ||
            asset.assetType === undefined ||
            asset.displayRole === undefined
          ) {
            context.addIssue({
              code: "custom",
              path: ["assets", index],
              message:
                "dashboard enterprise v2 requires image roles, 512-character paths and 4,000-character source URLs",
            });
          }
          if (value.schemaVersion !== 4) return;
          const customerUploadProvenanceFields = [
            asset.sourceUploadSha256,
            asset.sourceUploadFilename,
            asset.sourceUploadMimeType,
          ];
          const officialLogoUploadProvenanceFields = [
            asset.sourceUploadIndex,
            asset.sourceUploadFileId,
            ...customerUploadProvenanceFields,
            asset.sourceUploadSizeBytes,
          ];
          if (asset.sourceKind === "user_upload") {
            if (
              customerUploadProvenanceFields.some((field) => !field) ||
              asset.sourceUploadIndex !== undefined ||
              asset.sourceUploadFileId !== undefined ||
              asset.sourceUploadSizeBytes !== undefined ||
              asset.sourcePageUrl !== undefined ||
              asset.sourceAssetUrl !== undefined ||
              asset.sourceDocumentPath !== undefined ||
              asset.assetType !== "customer_supplied" ||
              asset.displayRole !== "inline"
            ) {
              context.addIssue({
                code: "custom",
                path: ["assets", index],
                message:
                  "Dashboard v4 customer upload requires exact upload provenance and customer_supplied/inline without discovered sources",
              });
            }
          } else if (asset.sourceKind === "official_logo_upload") {
            if (
              officialLogoUploadProvenanceFields.some(
                (field) => field === undefined,
              ) ||
              asset.sourceUploadIndex !== 0 ||
              asset.sourcePageUrl !== undefined ||
              asset.sourceAssetUrl !== undefined ||
              asset.sourceDocumentPath !== undefined ||
              asset.sourceUploadSha256 !== asset.sha256.toLowerCase() ||
              asset.sourceUploadSizeBytes !== asset.bytes ||
              asset.ownership !== "first_party" ||
              asset.assetType !== "brand_identity" ||
              asset.displayRole !== "badge"
            ) {
              context.addIssue({
                code: "custom",
                path: ["assets", index],
                message:
                  "Dashboard v4 official Logo upload requires all six upload provenance fields and first_party/brand_identity/badge without discovered sources",
              });
            }
          } else if (
            !["official_web", "official_document"].includes(
              asset.sourceKind || "",
            ) ||
            officialLogoUploadProvenanceFields.some(
              (field) => field !== undefined,
            ) ||
            asset.assetType !== "brand_identity" ||
            asset.displayRole !== "badge"
          ) {
            context.addIssue({
              code: "custom",
              path: ["assets", index],
              message:
                "Dashboard v4 non-upload asset must be the official brand_identity/badge Logo",
            });
          }
        });
        (selection.productFamilyCoverage || []).forEach((family, index) => {
          if (
            family.checkedSources.length === 0 ||
            family.checkedSourceCount !== undefined
          ) {
            context.addIssue({
              code: "custom",
              path: ["imageSelection", "productFamilyCoverage", index],
              message:
                "dashboard enterprise v2 product families require checkedSources URLs",
            });
          }
        });
      }
    }
    if (
      documentIds.size !== value.documents.length ||
      documentPaths.size !== value.documents.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["documents"],
        message: "package manifest document IDs and paths must be unique",
      });
    }
    if (
      assetIds.size !== value.assets.length ||
      assetPaths.size !== value.assets.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "package manifest asset IDs and paths must be unique",
      });
    }
    value.documents.forEach((document, index) => {
      if (document.assetIds.some((assetId) => !assetIds.has(assetId))) {
        context.addIssue({
          code: "custom",
          path: ["documents", index, "assetIds"],
          message: "document references an unknown packaged asset",
        });
      }
      if (
        document.assetIds.some(
          (assetId) =>
            !assetById.get(assetId)?.documentIds.includes(document.id),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["documents", index, "assetIds"],
          message: "document and asset links must be bidirectional",
        });
      }
    });
    value.assets.forEach((asset, index) => {
      if (
        asset.documentIds.some((documentId) => !documentIds.has(documentId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "documentIds"],
          message: "asset references an unknown packaged document",
        });
      }
      if (
        asset.documentIds.some((documentId) => {
          const document = documentById.get(documentId);
          return (
            !document?.customerVisible || !document.assetIds.includes(asset.id)
          );
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "documentIds"],
          message:
            "asset links must reference customer-visible documents bidirectionally",
        });
      }
      if (
        !asset.documentIds.some(
          (documentId) =>
            documentById.get(documentId)?.branchId === asset.branchId,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "branchId"],
          message: "asset branch must match at least one linked document",
        });
      }
    });
  });

const packageManifestSchema = z.preprocess((input) => {
  const isWebsiteV2 =
    typeof input === "object" &&
    input !== null &&
    "profile" in input &&
    input.profile === "website-lead-v1" &&
    "schemaVersion" in input &&
    (input.schemaVersion === 2 || input.schemaVersion === 3);
  if (!isWebsiteV2) return input;
  const value = websiteV2PackageManifestSchema.parse(input);
  const statusByDisplayBranch = new Map<
    string,
    "complete" | "limited_evidence" | "needs_verification"
  >(
    value.branchEvidence.map((branch) => [
      branch.branchId,
      branch.contentStatus,
    ]),
  );
  const rejectionCounts = new Map<string, number>();
  for (const candidate of value.imageSelection.candidates) {
    if (candidate.status !== "rejected") continue;
    const reason = candidate.rejectionReason || "未提供拒绝原因";
    rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + 1);
  }
  return {
    schemaVersion: value.schemaVersion,
    profile: value.profile,
    websiteV2Normalized: true,
    documents: value.documents.map((document) => {
      const displayBranch = document.branchId
        ? websiteLeadDisplayBranchByDirectory.get(document.branchId)
        : undefined;
      return {
        id: document.id,
        path: document.path,
        kind: document.kind,
        title: document.title,
        branchId: document.branchId,
        order: document.order,
        evidenceStatus: document.evidenceStatus,
        sourceIds: document.sourceIds || [],
        evidenceDocumentIds: document.evidenceDocumentIds,
        assetIds: document.assetIds || [],
        customerVisible: document.customerVisible,
        evidenceCharacters: document.evidenceCharacters,
        requiredFormalCharacters: document.dynamicMinimumCharacters,
        contentStatus: displayBranch
          ? statusByDisplayBranch.get(displayBranch)
          : undefined,
        productFamilyIds: document.productFamilyIds,
      };
    }),
    assets: value.assets,
    counts: value.counts,
    branchEvidence: value.branchEvidence,
    imageSelection: {
      status: value.imageSelection.status,
      discoveredCandidateImages: value.imageSelection.discoveredCandidateImages,
      inspectedCandidateImages: value.imageSelection.inspectedCandidateImages,
      eligibleFirstPartyImages: value.imageSelection.eligibleFirstPartyImages,
      rejectedCandidateImages: value.imageSelection.rejectedCandidateImages,
      scannedSourcePages: value.imageSelection.scannedSourcePages,
      discoveryMethods: value.imageSelection.discoveryMethods.flatMap(
        (method) =>
          method === "srcset_or_lazy" ? ["srcset", "lazy_load"] : [method],
      ),
      rejectionReasons: [...rejectionCounts].map(([reason, count]) => ({
        reason,
        count,
      })),
      stopReason:
        value.imageSelection.shortfallReason || "Website v2 图片候选台账已完成",
      productFamilyCoverage: value.imageSelection.productFamilies.map(
        (family) => ({
          familyId: family.id,
          familyName: family.name,
          officialImageAvailable: family.officialVisualFound,
          assetIds: family.assetIds,
          checkedSources: [],
          checkedSourceCount: family.checkedSources,
          gapReason: family.gapReason,
        }),
      ),
      candidates: value.imageSelection.candidates.map((candidate) => ({
        ...candidate,
        method: candidate.method,
      })),
      shortfallReason: value.imageSelection.shortfallReason,
    },
  };
}, internalPackageManifestSchema);

const completenessAcquisitionCountSchema = z
  .object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed > value.total) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "completed acquisition count cannot exceed total",
      });
    }
  });

const completenessAcquisitionSchema = z
  .object({
    counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
    acquisition: z
      .object({
        officialPages: completenessAcquisitionCountSchema.optional(),
        images: completenessAcquisitionCountSchema.optional(),
        documents: completenessAcquisitionCountSchema.optional(),
        webQueries: completenessAcquisitionCountSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();
const storageRoot = path.resolve(
  process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
    path.join(process.cwd(), ".frontmind-dashboard-assets"),
);

export function assertDashboardAssetStorageConfigured() {
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.FRONTMIND_DASHBOARD_ASSET_DIR?.trim()
  ) {
    throw new Error(
      "FRONTMIND_DASHBOARD_ASSET_DIR is required in production for durable dashboard assets",
    );
  }
}

export async function removeStoredKnowledgeAssets(keys: string[]) {
  await Promise.all(
    keys.map((key) =>
      unlink(path.join(storageRoot, key)).catch(() => undefined),
    ),
  );
}

/** Read one parser-owned temporary asset without exposing the storage root. */
export async function readStoredKnowledgeAssetBytes(key: string) {
  const normalized = String(key || "").trim();
  if (!normalized || normalized !== path.basename(normalized)) {
    throw new Error("知识库临时资源标识无效");
  }
  return readFile(path.join(storageRoot, normalized));
}

export async function removeUncommittedStoredKnowledgeAssets(input: {
  snapshotCommitted: boolean;
  storedAssetKeys: string[];
  removeAssets?: (keys: string[]) => Promise<void>;
}) {
  if (input.snapshotCommitted) return;
  await (input.removeAssets ?? removeStoredKnowledgeAssets)(
    input.storedAssetKeys,
  );
}

export async function runCommittedKnowledgeSnapshotSideEffects(
  effects: Array<{ name: string; run: () => Promise<unknown> }>,
  warn: (message: string, error: unknown) => void = (message, error) =>
    console.warn(message, error),
) {
  const warnings: string[] = [];
  for (const effect of effects) {
    try {
      await effect.run();
    } catch (error) {
      warnings.push(effect.name);
      warn(
        `[Dashboard] Knowledge snapshot committed; ${effect.name} will be retried independently`,
        error,
      );
    }
  }
  return warnings;
}

const textExtensions = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".csv",
  ".html",
  ".htm",
]);
const versionedArchiveAllowedExtensions = new Set([
  ".avif",
  ".csv",
  ".doc",
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".sha256",
  ".webp",
  ".xls",
  ".xlsx",
]);
const executableArchiveExtensions = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".dll",
  ".dylib",
  ".exe",
  ".js",
  ".mjs",
  ".py",
  ".sh",
  ".so",
]);

function packageRelativePath(value: string) {
  return validateArchiveEntryPath(value.normalize("NFKC"));
}

function customerDisplayMarkdown(markdown: string) {
  const retainedLines: string[] = [];
  const lines = stripLeadingMarkdownFrontmatter(markdown).split(/\r?\n/);
  let excludedSectionDepth: number | undefined;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const depth = heading[1]!.length;
      if (excludedSectionDepth !== undefined && depth <= excludedSectionDepth) {
        excludedSectionDepth = undefined;
      }
      if (
        /(?:原始|证据|引用|参考)?来源|素材清单|展示素材|机器清单|证据状态|状态头|sources?|references?|asset inventory/i.test(
          heading[2] || "",
        )
      ) {
        excludedSectionDepth = depth;
        continue;
      }
    }
    if (excludedSectionDepth !== undefined) continue;
    if (
      /^\s*>\s*.*(?:状态|status)\s*[:：].*(?:来源|source)\s*[:：]/i.test(
        line,
      ) ||
      /^\s*[-*]\s+(?:node_id|path|evidence_status|source_ids|status)\s*[:：]/i.test(
        line,
      )
    ) {
      continue;
    }
    retainedLines.push(line);
  }
  return retainedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function profileFormalKnowledgeText(
  content: string,
  profile: Exclude<KnowledgeBaseValidationProfile, "historical">,
) {
  return formalKnowledgeText(
    profile === "dashboard-enterprise-v1"
      ? markedFormalContent(content) || ""
      : content,
  );
}

function evidenceProportionalFormalRequirement(input: {
  kind: "overview" | "leaf";
  isProductBranch: boolean;
  evidenceCharacters: number;
}) {
  if (input.evidenceCharacters === 0) {
    return {
      required: input.kind === "overview" ? 60 : 40,
      status: "needs_verification" as const,
    };
  }
  if (input.kind === "overview") {
    const target = input.isProductBranch ? 5_000 : 2_500;
    const proportional = Math.floor(input.evidenceCharacters * 0.25);
    return {
      required: Math.max(120, Math.min(target, proportional)),
      status:
        proportional >= target
          ? ("complete" as const)
          : ("limited_evidence" as const),
    };
  }
  const proportional = Math.floor(input.evidenceCharacters * 0.2);
  return {
    required: Math.max(80, Math.min(500, proportional)),
    status:
      proportional >= 500
        ? ("complete" as const)
        : ("limited_evidence" as const),
  };
}

function websiteV2OverviewRequirement(
  evidenceCharacters: number,
  displayBranchId: string,
) {
  if (evidenceCharacters === 0) return 40;
  const target = displayBranchId === "products-services" ? 3_000 : 1_500;
  return Math.min(target, Math.max(120, Math.ceil(evidenceCharacters * 0.25)));
}

function websiteV2LeafRequirement(evidenceCharacters: number) {
  if (evidenceCharacters === 0) return 40;
  return Math.min(200, Math.max(60, Math.ceil(evidenceCharacters * 0.2)));
}

function duplicateFormalParagraphs(
  documents: Array<{ path: string; content: string }>,
  profile: Exclude<KnowledgeBaseValidationProfile, "historical">,
) {
  const pathsByFingerprint = new Map<string, string[]>();
  const duplicates: Array<{ first: string; second: string }> = [];
  const samples: Array<{ path: string; text: string }> = [];
  for (const document of documents) {
    const narrative = profileFormalKnowledgeText(document.content, profile);
    if (effectiveCharacterCount(narrative) >= 80) {
      samples.push({ path: document.path, text: narrative });
    }
    if (effectiveCharacterCount(narrative) < 120) continue;
    const fingerprints = new Set(
      [narrative, ...narrative.split(/\n\s*\n/)]
        .map((paragraph) =>
          paragraph.replace(/\d+/g, "#").replace(/\s+/g, "").trim(),
        )
        .filter((paragraph) => effectiveCharacterCount(paragraph) >= 120),
    );
    for (const fingerprint of fingerprints) {
      const paths = pathsByFingerprint.get(fingerprint) || [];
      paths.push(document.path);
      pathsByFingerprint.set(fingerprint, paths);
    }
  }
  for (const paths of pathsByFingerprint.values()) {
    if (paths.length >= 3) {
      duplicates.push({ first: paths[0]!, second: paths[2]! });
    }
  }
  for (let leftIndex = 0; leftIndex < samples.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < samples.length;
      rightIndex += 1
    ) {
      const left = samples[leftIndex]!;
      const right = samples[rightIndex]!;
      if (normalizedFormalSimilarity(left.text, right.text) >= 0.82) {
        duplicates.push({ first: left.path, second: right.path });
      }
    }
  }
  return duplicates;
}

function normalizedFormalSimilarity(left: string, right: string) {
  const shingles = (value: string) => {
    const normalized = value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\d+/g, "#")
      .replace(/\s+/g, "")
      .replace(
        /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/g,
        "",
      );
    const values = new Set<string>();
    for (let index = 0; index <= normalized.length - 5; index += 1) {
      values.add(normalized.slice(index, index + 5));
    }
    return values;
  };
  const leftShingles = shingles(left);
  const rightShingles = shingles(right);
  if (!leftShingles.size || !rightShingles.size) return 0;
  let intersection = 0;
  leftShingles.forEach((value) => {
    if (rightShingles.has(value)) intersection += 1;
  });
  return intersection / (leftShingles.size + rightShingles.size - intersection);
}

function packagedEvidenceCharacters(
  documents: Array<{
    content: string;
    customerVisible?: boolean;
  }>,
) {
  return documents
    .filter((document) => document.customerVisible === false)
    .reduce(
      (total, document) => total + packagedEvidenceDocumentCharacters(document),
      0,
    );
}

function packagedEvidenceDocumentCharacters(document: { content: string }) {
  return effectiveCharacterCount(packagedEvidenceDocumentText(document));
}

function packagedEvidenceDocumentText(document: { content: string }) {
  return stripLeadingMarkdownFrontmatter(document.content)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)>\]]+/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s+/gm, "");
}

function packagedEvidenceDocumentFingerprint(document: { content: string }) {
  const normalized = packagedEvidenceDocumentText(document)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(
      /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/g,
      "",
    );
  return normalized
    ? createHash("sha256").update(normalized).digest("hex")
    : undefined;
}

function reportedPackagedImageCount(markdown: string) {
  for (const pattern of [
    /(?:成功下载|已下载|已保存|保存并打包|downloaded|packaged|saved)[^\n|]{0,30}(?:图片|图像|images?|assets?)[^\d]{0,12}([\d,]+)/i,
    /(?:图片|图像|images?|assets?)[^\n|]{0,30}(?:成功下载|已下载|已保存|保存并打包|downloaded|packaged|saved)[^\d]{0,12}([\d,]+)/i,
    /第一方图片资源[^\d\n|]{0,20}([\d,]+)/i,
  ]) {
    const matched = markdown.match(pattern)?.[1];
    if (matched) return Number.parseInt(matched.replaceAll(",", ""), 10);
  }
  return undefined;
}

function parsePackageJson<T>(
  rawTextByRelativePath: Map<string, string>,
  relativePath: string,
  schema: z.ZodType<T>,
  label: string,
) {
  const raw = rawTextByRelativePath.get(relativePath);
  if (!raw) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      `知识库 ZIP 缺少 ${relativePath}`,
    );
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      `${label} 不是有效的机器清单：${
        error instanceof Error ? error.message : "格式错误"
      }`,
    );
  }
}

function validateProfilePackage(input: {
  profile: Exclude<KnowledgeBaseValidationProfile, "historical">;
  archiveContractVersion?: 1 | 2 | 3 | 4;
  archiveContractVersions?: readonly (1 | 2 | 3 | 4)[];
  packagePaths: string[];
  unpackedBytes: number;
  rawTextByRelativePath: Map<string, string>;
  documents: KnowledgeDocument[];
  assets: KnowledgeAsset[];
}) {
  const manifest = parsePackageJson(
    input.rawTextByRelativePath,
    packageManifestPath,
    packageManifestSchema,
    "00_package_manifest.json",
  );
  if (
    input.archiveContractVersion !== undefined &&
    manifest.schemaVersion !== input.archiveContractVersion
  ) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      "知识库归档合同版本与 package manifest 不一致",
    );
  }
  if (
    input.archiveContractVersions !== undefined &&
    !input.archiveContractVersions.includes(manifest.schemaVersion)
  ) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      "知识库归档合同版本不在当前任务允许的兼容范围内",
    );
  }
  if (manifest.profile !== input.profile) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      "知识库归档档位与服务端任务档位不一致",
    );
  }
  const completeness = parsePackageJson(
    input.rawTextByRelativePath,
    completenessPath,
    completenessAcquisitionSchema,
    "00_completeness.json",
  );
  const limits =
    input.profile === "website-lead-v1"
      ? {
          files: 150,
          images: 48,
          targetImages: 36,
          minCharacters: 8_000,
          maxCharacters: manifest.schemaVersion !== 1 ? 40_000 : 18_000,
          maxEvidenceCharacters: 300_000,
          maxOfficialPages: 120,
          maxDocuments: 22,
          maxWebQueries: 12,
        }
      : {
          files: 1_500,
          images: 480,
          targetImages: 360,
          minCharacters: 80_000,
          maxCharacters: 180_000,
          maxEvidenceCharacters: 3_000_000,
          maxOfficialPages: 1_200,
          maxDocuments: 220,
          maxWebQueries: 120,
        };
  const isSingleLogoDashboardV3 =
    input.profile === "dashboard-enterprise-v1" && manifest.schemaVersion === 3;
  const isCustomerUploadDashboardV4 =
    input.profile === "dashboard-enterprise-v1" && manifest.schemaVersion === 4;
  const isDashboardLogoContract =
    isSingleLogoDashboardV3 || isCustomerUploadDashboardV4;
  if (input.packagePaths.length > limits.files) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      `知识库 ZIP 超过 ${limits.files} 个产品文件上限`,
    );
  }
  if (
    input.profile === "dashboard-enterprise-v1" &&
    input.unpackedBytes > ENTERPRISE_PRODUCT_MAX_UNPACKED_BYTES
  ) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      "企业知识库解压后超过 200 MB 产品上限",
    );
  }
  if (manifest.counts.totalFiles !== input.packagePaths.length) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      "package manifest 文件总数与 ZIP 实际文件数不一致",
    );
  }

  const documentByRelativePath = new Map(
    input.documents.map((document) => [
      document.path.split("/").slice(1).join("/"),
      document,
    ]),
  );
  const assetByRelativePath = new Map(
    input.assets.map((asset) => [
      asset.path.split("/").slice(1).join("/"),
      asset,
    ]),
  );
  const allowedUnlistedText = new Set([
    packageManifestPath,
    completenessPath,
    "MANIFEST.sha256",
    "VALIDATION.md",
  ]);
  const manifestDocumentPaths = new Set(
    manifest.documents.map((document) => packageRelativePath(document.path)),
  );
  for (const relativePath of input.rawTextByRelativePath.keys()) {
    if (
      path.posix.extname(relativePath).toLowerCase() === ".md" &&
      !allowedUnlistedText.has(relativePath) &&
      !manifestDocumentPaths.has(relativePath)
    ) {
      throw new KnowledgeArchiveValidationError(
        "structure",
        `package manifest 未登记文本文件：${relativePath}`,
      );
    }
  }

  const enrichedDocuments = manifest.documents.map((metadata) => {
    const relativePath = packageRelativePath(metadata.path);
    const document = documentByRelativePath.get(relativePath);
    if (!document) {
      throw new KnowledgeArchiveValidationError(
        "structure",
        `package manifest 文档不存在：${relativePath}`,
      );
    }
    return {
      ...document,
      id: metadata.id,
      title: metadata.title,
      kind: metadata.kind,
      branchId: metadata.branchId,
      branchTitle: metadata.branchTitle,
      order: metadata.order,
      evidenceStatus: metadata.evidenceStatus,
      sourceIds: metadata.sourceIds,
      evidenceDocumentIds: metadata.evidenceDocumentIds,
      assetIds: metadata.assetIds,
      customerVisible: metadata.customerVisible,
      evidenceCharacters: metadata.evidenceCharacters,
      requiredFormalCharacters: metadata.requiredFormalCharacters,
      contentStatus: metadata.contentStatus,
      productFamilyId: metadata.productFamilyId,
      productFamilyIds: metadata.productFamilyIds,
    };
  });

  const manifestAssetPaths = new Set(
    manifest.assets.map((asset) => packageRelativePath(asset.path)),
  );
  if (
    manifest.assets.length !== input.assets.length ||
    manifestAssetPaths.size !== input.assets.length
  ) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "package manifest 图片数量与 ZIP 实际图片数量不一致",
    );
  }
  let imageBytes = 0;
  const enrichedAssets = manifest.assets.map((metadata) => {
    const relativePath = packageRelativePath(metadata.path);
    const asset = assetByRelativePath.get(relativePath);
    if (!asset) {
      throw new KnowledgeArchiveValidationError(
        "media",
        `package manifest 图片不存在：${relativePath}`,
      );
    }
    if (
      asset.mimeType !== metadata.mimeType ||
      asset.size !== metadata.bytes ||
      asset.sha256?.toLowerCase() !== metadata.sha256.toLowerCase()
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        `图片字节、类型或哈希与 package manifest 不一致：${relativePath}`,
      );
    }
    if (asset.width === undefined || asset.height === undefined) {
      throw new KnowledgeArchiveValidationError(
        "media",
        `无法复算图片尺寸：${relativePath}`,
      );
    }
    if (metadata.width !== asset.width || metadata.height !== asset.height) {
      throw new KnowledgeArchiveValidationError(
        "media",
        `图片尺寸与 package manifest 不一致：${relativePath}`,
      );
    }
    if (metadata.ownership !== "first_party") {
      throw new KnowledgeArchiveValidationError(
        "media",
        `打包图片必须是第一方素材：${relativePath}`,
      );
    }
    if (manifest.schemaVersion !== 1) {
      const isBadgeType = ["brand_identity", "certificate_badge"].includes(
        metadata.assetType || "",
      );
      if (
        !metadata.assetType ||
        !metadata.displayRole ||
        (metadata.displayRole === "badge" && !isBadgeType) ||
        (metadata.assetType === "certificate_badge" &&
          metadata.displayRole !== "badge")
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          `图片缺少有效的 assetType/displayRole：${relativePath}`,
        );
      }
      const meetsMinimum =
        isCustomerUploadDashboardV4 && metadata.sourceKind === "user_upload"
          ? asset.width > 0 && asset.height > 0
          : metadata.displayRole === "hero"
            ? asset.width >= 1_200 && asset.height >= 600
            : metadata.displayRole === "badge"
              ? asset.width >= 256 && asset.height >= 256
              : asset.width >= 800 && asset.height >= 450;
      if (!meetsMinimum) {
        throw new KnowledgeArchiveValidationError(
          "media",
          `图片未达到 ${metadata.displayRole} 质量门槛：${relativePath}`,
        );
      }
    }
    imageBytes += asset.size;
    return {
      ...asset,
      id: metadata.id,
      width: metadata.width,
      height: metadata.height,
      caption: metadata.caption,
      alt: metadata.alt,
      branchId: metadata.branchId,
      documentIds: metadata.documentIds,
      sourcePageUrl: metadata.sourcePageUrl,
      sourceAssetUrl: metadata.sourceAssetUrl,
      sourceDocumentPath: metadata.sourceDocumentPath,
      sourceKind: metadata.sourceKind,
      sourceUploadIndex: metadata.sourceUploadIndex,
      sourceUploadFileId: metadata.sourceUploadFileId,
      sourceUploadSha256: metadata.sourceUploadSha256,
      sourceUploadFilename: metadata.sourceUploadFilename,
      sourceUploadMimeType: metadata.sourceUploadMimeType,
      sourceUploadSizeBytes: metadata.sourceUploadSizeBytes,
      ownership: metadata.ownership,
      assetType: metadata.assetType,
      displayRole: metadata.displayRole,
    } satisfies KnowledgeAsset;
  });
  const officialLogoAssets = isDashboardLogoContract
    ? enrichedAssets.filter((asset) => asset.sourceKind !== "user_upload")
    : enrichedAssets;
  const customerUploadAssets = isCustomerUploadDashboardV4
    ? enrichedAssets.filter((asset) => asset.sourceKind === "user_upload")
    : [];
  if (
    isCustomerUploadDashboardV4 &&
    new Set(
      customerUploadAssets.map((asset) =>
        String(asset.sourceUploadSha256 || "").toLowerCase(),
      ),
    ).size !== customerUploadAssets.length
  ) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "Dashboard v4 客户上传图片必须按原始上传 SHA-256 去重",
    );
  }
  if (enrichedAssets.length > limits.images) {
    throw new KnowledgeArchiveValidationError(
      "media",
      `知识库 ZIP 超过 ${limits.images} 张图片上限`,
    );
  }
  if (isCustomerUploadDashboardV4 && enrichedAssets.length > 100) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "Dashboard v4 最多包含一张官方 Logo 和 99 张客户上传图片",
    );
  }
  if (
    new Set(enrichedAssets.map((asset) => asset.sha256?.toLowerCase())).size !==
    enrichedAssets.length
  ) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "知识库图片必须按 SHA-256 去重后再打包",
    );
  }
  if (
    input.profile === "dashboard-enterprise-v1" &&
    imageBytes >
      (isCustomerUploadDashboardV4
        ? CUSTOMER_UPLOAD_PACKAGE_MAX_IMAGE_BYTES
        : ENTERPRISE_PRODUCT_MAX_IMAGE_BYTES)
  ) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "企业知识库图片总量超过 160 MB",
    );
  }
  if (input.profile === "dashboard-enterprise-v1") {
    const packagedDocumentPaths = new Set(
      input.documents.map((document) => packageRelativePath(document.path)),
    );
    for (const asset of enrichedAssets) {
      if (
        asset.sourceKind !== "user_upload" &&
        asset.sourceKind !== "official_logo_upload" &&
        !asset.sourcePageUrl &&
        !asset.sourceDocumentPath
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          `图片缺少可追溯的官网页面或打包来源文档：${asset.path}`,
        );
      }
      if (
        asset.sourceDocumentPath &&
        !packagedDocumentPaths.has(
          packageRelativePath(asset.sourceDocumentPath),
        )
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          `图片来源文档未打包：${asset.sourceDocumentPath}`,
        );
      }
      if (
        ["product_ui", "product_diagram", "case_photo"].includes(
          asset.assetType || "",
        ) &&
        /(?:sprite|icon(?:s|font)?|favicon|logo[\s_-]*(?:wall|sheet|grid|collage)|装饰|背景图|图标集|标志墙|logo墙)/i.test(
          `${asset.path} ${asset.caption || ""} ${asset.alt || ""}`,
        )
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          `装饰图、图标集或 Logo 拼贴不得作为产品视觉：${asset.path}`,
        );
      }
    }
  }
  if (manifest.counts.packagedImages !== enrichedAssets.length) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "package manifest 图片计数与 ZIP 实际图片数不一致",
    );
  }
  if (
    completeness.acquisition.images?.completed !==
      (isDashboardLogoContract
        ? officialLogoAssets.length
        : enrichedAssets.length) ||
    (completeness.acquisition.images &&
      completeness.acquisition.images.completed >
        completeness.acquisition.images.total)
  ) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "00_completeness.json 的已保存图片数与实际打包图片数不一致",
    );
  }
  const crawlReportImageCount = reportedPackagedImageCount(
    input.rawTextByRelativePath.get("00_crawl_coverage_report.md") || "",
  );
  if (
    crawlReportImageCount !== undefined &&
    crawlReportImageCount !==
      (isDashboardLogoContract
        ? officialLogoAssets.length
        : enrichedAssets.length)
  ) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "官网采集报告的已保存图片数与实际打包图片数不一致",
    );
  }
  if (manifest.schemaVersion === 1) {
    if (
      enrichedAssets.length < limits.targetImages &&
      !manifest.imageSelection.shortfallReason
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        `图片少于 ${limits.targetImages} 张时必须说明第一方素材不足原因`,
      );
    }
    if (
      enrichedAssets.length >= limits.targetImages &&
      manifest.imageSelection.shortfallReason &&
      input.profile !== "website-lead-v1"
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        `达到 ${limits.targetImages} 张图片目标时不得填写素材不足原因`,
      );
    }
    if (
      manifest.imageSelection.eligibleFirstPartyImages >= limits.targetImages &&
      enrichedAssets.length < limits.targetImages
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        `已有至少 ${limits.targetImages} 张合格第一方素材时必须达到目标图片数`,
      );
    }
    if (
      manifest.imageSelection.eligibleFirstPartyImages < limits.targetImages &&
      enrichedAssets.length !== manifest.imageSelection.eligibleFirstPartyImages
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        "合格第一方素材不足目标数量时，必须打包全部合格图片",
      );
    }
  } else {
    const selection = manifest.imageSelection;
    const discovered = selection.discoveredCandidateImages!;
    const inspected = selection.inspectedCandidateImages!;
    const rejected = selection.rejectedCandidateImages!;
    const candidates = selection.candidates || [];
    const methods = new Set(selection.discoveryMethods || []);
    const rejectionTotal = (selection.rejectionReasons || []).reduce(
      (sum, reason) => sum + reason.count,
      0,
    );
    if (
      inspected > discovered ||
      inspected !== selection.eligibleFirstPartyImages + rejected ||
      rejectionTotal !== rejected
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        "图片发现、检查、合格和拒绝候选数不满足可审计算术关系",
      );
    }
    const eligibleCandidates = candidates.filter(
      (candidate) => candidate.status === "eligible",
    );
    const rejectedCandidates = candidates.filter(
      (candidate) => candidate.status === "rejected",
    );
    const uninspectedCandidates = candidates.filter(
      (candidate) => candidate.status === "uninspected",
    );
    const enrichedAssetsById = new Map(
      enrichedAssets.flatMap((asset) => (asset.id ? [[asset.id, asset]] : [])),
    );
    if (
      candidates.length !== discovered ||
      new Set(
        candidates.map(
          (candidate) =>
            candidate.url ||
            `${candidate.sourceDocumentPath || "unknown"}:${candidate.assetId || candidate.rejectionReason || candidate.status}`,
        ),
      ).size !== candidates.length ||
      candidates.some((candidate) => {
        const isOfficialLogoUploadCandidate =
          isCustomerUploadDashboardV4 &&
          candidate.sourceKind === "official_logo_upload";
        if (isOfficialLogoUploadCandidate) {
          return (
            candidate.method !== "customer_upload" ||
            candidate.url !== undefined ||
            candidate.sourcePageUrl !== undefined ||
            candidate.sourceDocumentPath !== undefined
          );
        }
        return (
          (!candidate.url && !candidate.sourceDocumentPath) ||
          (!candidate.sourcePageUrl && !candidate.sourceDocumentPath) ||
          (isDashboardLogoContract &&
            (candidate.sourceKind === "user_upload" ||
              candidate.method === "customer_upload"))
        );
      }) ||
      eligibleCandidates.length !== selection.eligibleFirstPartyImages ||
      rejectedCandidates.length !== rejected ||
      eligibleCandidates.length + rejectedCandidates.length !== inspected ||
      inspected + uninspectedCandidates.length !== discovered ||
      eligibleCandidates.some((candidate) => {
        const asset = candidate.assetId
          ? enrichedAssetsById.get(candidate.assetId)
          : undefined;
        return (
          !asset ||
          (isDashboardLogoContract && asset.sourceKind === "user_upload") ||
          ((asset?.sourceKind === "official_logo_upload" ||
            candidate.sourceKind === "official_logo_upload") &&
            (asset?.sourceKind !== "official_logo_upload" ||
              candidate.sourceKind !== "official_logo_upload" ||
              candidate.method !== "customer_upload")) ||
          candidate.rejectionReason !== undefined ||
          asset.sourceAssetUrl !== candidate.url ||
          asset.sourcePageUrl !== candidate.sourcePageUrl ||
          asset.sourceDocumentPath !== candidate.sourceDocumentPath
        );
      }) ||
      rejectedCandidates.some(
        (candidate) =>
          candidate.assetId !== undefined || !candidate.rejectionReason,
      ) ||
      uninspectedCandidates.some(
        (candidate) =>
          candidate.assetId !== undefined ||
          candidate.rejectionReason !== undefined,
      ) ||
      officialLogoAssets.some(
        (asset) =>
          !asset.id ||
          !eligibleCandidates.some(
            (candidate) => candidate.assetId === asset.id,
          ),
      )
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        "图片候选逐项台账与发现、检查、打包结果不一致",
      );
    }
    if (
      (isDashboardLogoContract && methods.size === 0) ||
      (!isDashboardLogoContract &&
        [...requiredImageDiscoveryMethods].some(
          (method) => !methods.has(method),
        ))
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        isDashboardLogoContract
          ? "Logo 发现台账必须记录实际使用的发现方式"
          : "图片发现台账未覆盖全部要求的第一方图片发现方式",
      );
    }
    if (
      completeness.acquisition.images?.total !== discovered ||
      (isDashboardLogoContract
        ? officialLogoAssets.length
        : enrichedAssets.length) > selection.eligibleFirstPartyImages
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        "图片发现台账与完整度统计或实际打包数量不一致",
      );
    }
    const completedOfficialPages =
      completeness.acquisition.officialPages?.completed;
    if (
      completedOfficialPages === undefined ||
      (isDashboardLogoContract
        ? selection.scannedSourcePages! > completedOfficialPages
        : selection.scannedSourcePages !== completedOfficialPages)
    ) {
      throw new KnowledgeArchiveValidationError(
        "media",
        isDashboardLogoContract
          ? "Logo 扫描页数不能超过成功解析的官网页面数"
          : "图片扫描页数必须覆盖所有成功解析的官网页面",
      );
    }
    if (selection.status === "target_met") {
      if (
        uninspectedCandidates.length > 0 ||
        selection.shortfallReason ||
        !officialLogoAssets.some(
          (asset) => asset.assetType === "brand_identity",
        )
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "target_met 必须完成候选检查、包含品牌视觉且不存在覆盖缺口",
        );
      }
    } else {
      if (
        (isDashboardLogoContract
          ? officialLogoAssets.length
          : enrichedAssets.length) !== selection.eligibleFirstPartyImages ||
        !selection.shortfallReason
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "图片目标未达成时必须打包全部合格图片并提供真实缺口原因",
        );
      }
      if (selection.status === "source_limited" && inspected !== discovered) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "source_limited 必须检查全部已发现候选图片",
        );
      }
      if (selection.status === "budget_limited" && inspected >= discovered) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "budget_limited 必须存在因预算未检查的已发现候选图片",
        );
      }
    }
    if (isDashboardLogoContract) {
      const firstLeaf = enrichedDocuments.find(
        (document) => document.kind === "leaf",
      );
      const logo = officialLogoAssets[0];
      if (
        selection.status !== "target_met" ||
        selection.eligibleFirstPartyImages !== 1 ||
        officialLogoAssets.length !== 1 ||
        !logo ||
        logo.assetType !== "brand_identity" ||
        logo.displayRole !== "badge" ||
        !firstLeaf?.id ||
        logo.documentIds.length !== 1 ||
        logo.documentIds[0] !== firstLeaf.id ||
        selection.productFamilyCoverage !== undefined
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "Dashboard 必须只自动打包一张企业官方 Logo，并且只关联首个知识叶子",
        );
      }
      if (isSingleLogoDashboardV3 && customerUploadAssets.length !== 0) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "Dashboard v3 不允许客户上传图片资产",
        );
      }
      if (
        isCustomerUploadDashboardV4 &&
        (customerUploadAssets.length > 99 ||
          customerUploadAssets.some(
            (asset) =>
              asset.sourceKind !== "user_upload" ||
              asset.assetType !== "customer_supplied" ||
              asset.displayRole !== "inline" ||
              !asset.sourceUploadSha256 ||
              !asset.sourceUploadFilename ||
              !asset.sourceUploadMimeType ||
              !asset.documentIds?.length,
          ))
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "Dashboard v4 客户上传图片缺少节点绑定或原始上传来源证明",
        );
      }
    }
    const productFamilyIdsForDocument = (
      document: (typeof enrichedDocuments)[number],
    ) => {
      if (
        input.profile === "website-lead-v1" &&
        document.branchId !== "03_products"
      ) {
        return [];
      }
      return document.productFamilyIds?.length
        ? document.productFamilyIds
        : document.productFamilyId
          ? [document.productFamilyId]
          : [];
    };
    const productLeafDocuments = enrichedDocuments.filter(
      (document) =>
        document.kind === "leaf" &&
        productFamilyIdsForDocument(document).length > 0,
    );
    const productBranchIds = new Set(
      productLeafDocuments.map((document) => document.branchId || ""),
    );
    const productLeafFamilyIds = new Set(
      productLeafDocuments.flatMap(productFamilyIdsForDocument),
    );
    if (
      productLeafFamilyIds.size === 0 ||
      productBranchIds.has("") ||
      enrichedDocuments.some(
        (document) =>
          document.productFamilyIds !== undefined &&
          new Set(document.productFamilyIds).size !==
            document.productFamilyIds.length,
      ) ||
      enrichedDocuments.some(
        (document) =>
          productFamilyIdsForDocument(document).length > 0 &&
          document.kind !== "leaf",
      ) ||
      enrichedDocuments.some(
        (document) =>
          document.kind === "leaf" &&
          productBranchIds.has(document.branchId || "") &&
          productFamilyIdsForDocument(document).length === 0,
      )
    ) {
      throw new KnowledgeArchiveValidationError(
        "structure",
        "v2 必须至少声明一个产品或服务族，且产品分支的每个叶子都必须声明 productFamilyId",
      );
    }
    if (!isDashboardLogoContract) {
      const coverageIds = new Set(
        (selection.productFamilyCoverage || []).map(
          (family) => family.familyId,
        ),
      );
      if (
        coverageIds.size !== (selection.productFamilyCoverage || []).length ||
        coverageIds.size !== productLeafFamilyIds.size ||
        [...coverageIds].some((familyId) => !productLeafFamilyIds.has(familyId))
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          "产品族图片覆盖清单必须与产品或服务叶子中的产品族完全一致",
        );
      }
      const enrichedAssetIds = new Set(
        enrichedAssets.map((asset) => asset.id).filter(Boolean),
      );
      for (const family of selection.productFamilyCoverage || []) {
        if (
          family.assetIds.some((assetId) => !enrichedAssetIds.has(assetId)) ||
          (family.officialImageAvailable &&
            family.assetIds.some((assetId) => {
              const asset = enrichedAssetsById.get(assetId);
              return !["product_ui", "product_diagram", "case_photo"].includes(
                asset?.assetType || "",
              );
            })) ||
          (family.officialImageAvailable && family.assetIds.length === 0) ||
          (!family.officialImageAvailable && !family.gapReason) ||
          (input.profile === "dashboard-enterprise-v1" &&
            family.checkedSources.length === 0)
        ) {
          throw new KnowledgeArchiveValidationError(
            "media",
            `产品族图片覆盖记录不完整：${family.familyName}`,
          );
        }
      }
    }
  }
  if (
    (isDashboardLogoContract
      ? officialLogoAssets.length
      : enrichedAssets.length) >
    Math.min(manifest.imageSelection.eligibleFirstPartyImages, limits.images)
  ) {
    throw new KnowledgeArchiveValidationError(
      "media",
      "实际打包图片数不能超过合格第一方素材数或档位上限",
    );
  }

  const customerDocuments = enrichedDocuments.filter(
    (document) => document.customerVisible,
  );
  const customerOverviewDocuments = customerDocuments.filter(
    (document) => document.kind === "overview",
  );
  const customerLeafDocuments = customerDocuments.filter(
    (document) => document.kind === "leaf",
  );
  if (
    customerDocuments.length === 0 ||
    customerOverviewDocuments.length === 0 ||
    customerLeafDocuments.length === 0
  ) {
    throw new KnowledgeArchiveValidationError(
      "content",
      "知识库必须同时包含正式分支综述和知识叶子",
    );
  }
  if (
    input.profile === "website-lead-v1" &&
    ((manifest.schemaVersion === 1 &&
      (customerDocuments.length < 40 || customerDocuments.length > 56)) ||
      (manifest.schemaVersion !== 1 &&
        (customerOverviewDocuments.length !== 7 ||
          customerLeafDocuments.length < 8 ||
          customerLeafDocuments.length > 56)))
  ) {
    throw new KnowledgeArchiveValidationError(
      "content",
      manifest.schemaVersion === 1
        ? "历史官网轻量知识库必须包含 40–56 个客户可见内容文档"
        : "官网轻量知识库 v2 必须包含 7 篇分支综述和 8–56 个知识叶子",
    );
  }
  if (input.profile === "website-lead-v1") {
    const manifestDocumentById = new Map(
      manifest.documents.map((document) => [document.id, document]),
    );
    const hiddenContentDocument = manifest.documents.find(
      (document) =>
        websiteLeadDisplayBranchByDirectory.has(
          document.path.split("/")[0] || "",
        ) && !document.customerVisible,
    );
    if (hiddenContentDocument) {
      throw new KnowledgeArchiveValidationError(
        "structure",
        `官网轻量 01–08 内容文档必须标为客户可见：${hiddenContentDocument.path}`,
      );
    }
    const overviewCounts = new Map<string, number>();
    for (const document of customerDocuments) {
      const manifestDocument = document.id
        ? manifestDocumentById.get(document.id)
        : undefined;
      const directory = manifestDocument?.path.split("/")[0] || "";
      const displayBranch = websiteLeadDisplayBranchByDirectory.get(directory);
      if (
        !displayBranch ||
        document.branchId !== directory ||
        !["overview", "leaf"].includes(document.kind) ||
        !document.evidenceStatus
      ) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `官网轻量知识文档的目录、分支、类型或证据状态无效：${manifestDocument?.path || document.path}`,
        );
      }
      const declaredStatus = document.content
        .slice(0, 1_600)
        .match(
          /(?:证据\s*)?(?:状态|status)\s*[:：]\s*(?:\*\*|__)?\s*`?\s*(verified_first_party|verified_authoritative|supported_third_party|inferred|needs_verification|not_applicable)\b/i,
        )?.[1]
        ?.toLowerCase();
      if (declaredStatus !== document.evidenceStatus) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `官网轻量知识文档的证据状态与正文不一致：${manifestDocument?.path || document.path}`,
        );
      }
      if (document.kind === "overview") {
        overviewCounts.set(
          displayBranch,
          (overviewCounts.get(displayBranch) || 0) + 1,
        );
      }
    }
    for (const displayBranch of new Set(
      websiteLeadDisplayBranchByDirectory.values(),
    )) {
      if (overviewCounts.get(displayBranch) !== 1) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `官网轻量知识分支 ${displayBranch} 必须有且只有一篇正式综述`,
        );
      }
    }
    const completenessCounts = completeness.counts;
    // v1 historically counted every customer-visible document as a "leaf".
    // Contract v2 corrects that legacy ambiguity: overviews are separate and
    // completeness counts describe true knowledge leaves only.
    const completenessDocuments =
      manifest.schemaVersion === 1 ? customerDocuments : customerLeafDocuments;
    const statusCountKeys = {
      verified_first_party: "verifiedFirstParty",
      verified_authoritative: "verifiedAuthoritative",
      supported_third_party: "supportedThirdParty",
      inferred: "inferred",
      needs_verification: "needsVerification",
      not_applicable: "notApplicable",
    } as const;
    if (
      !completenessCounts ||
      completenessCounts.totalLeaves !== completenessDocuments.length
    ) {
      throw new KnowledgeArchiveValidationError(
        "structure",
        "00_completeness.json 的知识内容总数与实际 01–08 文档数不一致",
      );
    }
    const actualStatusCounts = Object.fromEntries(
      Object.keys(statusCountKeys).map((status) => [status, 0]),
    ) as Record<keyof typeof statusCountKeys, number>;
    for (const document of completenessDocuments) {
      actualStatusCounts[
        document.evidenceStatus as keyof typeof statusCountKeys
      ] += 1;
    }
    for (const [status, countKey] of Object.entries(statusCountKeys) as Array<
      [
        keyof typeof statusCountKeys,
        (typeof statusCountKeys)[keyof typeof statusCountKeys],
      ]
    >) {
      if (completenessCounts[countKey] !== actualStatusCounts[status]) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `00_completeness.json 的 ${countKey} 与实际证据状态不一致`,
        );
      }
    }
    if (
      manifest.schemaVersion === 1 &&
      (actualStatusCounts.not_applicable >= completenessDocuments.length ||
        actualStatusCounts.verified_first_party +
          actualStatusCounts.verified_authoritative +
          actualStatusCounts.supported_third_party ===
          0)
    ) {
      throw new KnowledgeArchiveValidationError(
        "content",
        "官网轻量知识库必须至少包含一个有证据支持的适用内容文档",
      );
    }
  }
  if (input.profile === "dashboard-enterprise-v1") {
    for (const document of customerDocuments) {
      if (
        !["overview", "leaf"].includes(document.kind || "") ||
        !document.branchId ||
        !document.evidenceStatus
      ) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `企业深度知识文档缺少分支、类型或证据状态：${document.path}`,
        );
      }
      if (
        !["needs_verification", "not_applicable"].includes(
          document.evidenceStatus,
        ) &&
        (document.sourceIds?.length || 0) === 0
      ) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `有证据的企业深度知识文档必须关联来源：${document.path}`,
        );
      }
    }
    const leafDocuments = customerDocuments.filter(
      (document) => document.kind === "leaf",
    );
    if (leafDocuments.length < 8 || leafDocuments.length > 115) {
      throw new KnowledgeArchiveValidationError(
        "content",
        "企业深度知识库必须包含 8–115 个知识叶子",
      );
    }
    const leafBranches = new Set(
      leafDocuments.map((document) => document.branchId).filter(Boolean),
    );
    for (const branchId of leafBranches) {
      const overviewCount = customerDocuments.filter(
        (document) =>
          document.kind === "overview" && document.branchId === branchId,
      ).length;
      if (overviewCount !== 1) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `企业深度知识库分支 ${branchId} 必须有且只有一篇正式综述`,
        );
      }
    }
    const overviewBranches = new Set(
      customerDocuments
        .filter((document) => document.kind === "overview")
        .map((document) => document.branchId)
        .filter(Boolean),
    );
    for (const branchId of overviewBranches) {
      if (!leafBranches.has(branchId)) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `企业深度知识库分支 ${branchId} 有综述但没有知识叶子`,
        );
      }
    }
    const completenessCounts = completeness.counts;
    const statusCountKeys = {
      verified_first_party: "verifiedFirstParty",
      verified_authoritative: "verifiedAuthoritative",
      supported_third_party: "supportedThirdParty",
      inferred: "inferred",
      needs_verification: "needsVerification",
      not_applicable: "notApplicable",
    } as const;
    if (
      !completenessCounts ||
      completenessCounts.totalLeaves !== leafDocuments.length
    ) {
      throw new KnowledgeArchiveValidationError(
        "structure",
        "00_completeness.json 的叶子总数与企业深度知识叶子不一致",
      );
    }
    const actualStatusCounts = Object.fromEntries(
      Object.keys(statusCountKeys).map((status) => [status, 0]),
    ) as Record<keyof typeof statusCountKeys, number>;
    for (const document of leafDocuments) {
      actualStatusCounts[
        document.evidenceStatus as keyof typeof statusCountKeys
      ] += 1;
    }
    for (const [status, countKey] of Object.entries(statusCountKeys) as Array<
      [
        keyof typeof statusCountKeys,
        (typeof statusCountKeys)[keyof typeof statusCountKeys],
      ]
    >) {
      if (completenessCounts[countKey] !== actualStatusCounts[status]) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `00_completeness.json 的 ${countKey} 与企业深度知识叶子不一致`,
        );
      }
    }
  }
  const packageDocumentById = new Map(
    enrichedDocuments
      .filter((document) => document.id)
      .map((document) => [document.id!, document]),
  );
  const evidenceCharacterByDocumentId = new Map(
    enrichedDocuments
      .filter(
        (document) =>
          document.id &&
          document.kind === "evidence" &&
          document.customerVisible === false,
      )
      .map((document) => [
        document.id!,
        packagedEvidenceDocumentCharacters(document),
      ]),
  );
  if (input.profile === "website-lead-v1" && manifest.schemaVersion !== 1) {
    const branchEvidence = manifest.branchEvidence || [];
    const overviewById = new Map(
      customerOverviewDocuments
        .filter((document) => document.id)
        .map((document) => [document.id!, document]),
    );
    for (const branch of branchEvidence) {
      const overview = overviewById.get(branch.overviewDocumentId);
      const overviewDisplayBranch = overview?.branchId
        ? websiteLeadDisplayBranchByDirectory.get(overview.branchId)
        : undefined;
      if (!overview || overviewDisplayBranch !== branch.branchId) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `Website v2 branchEvidence 关联了无效综述：${branch.branchId}`,
        );
      }
      const linkedEvidenceIds = new Set(
        customerDocuments
          .filter(
            (document) =>
              Boolean(document.branchId) &&
              websiteLeadDisplayBranchByDirectory.get(document.branchId!) ===
                branch.branchId,
          )
          .flatMap((document) => document.evidenceDocumentIds || []),
      );
      const actualEvidenceCharacters = [...linkedEvidenceIds].reduce(
        (total, evidenceId) =>
          total + (evidenceCharacterByDocumentId.get(evidenceId) || 0),
        0,
      );
      const expectedMinimum = websiteV2OverviewRequirement(
        actualEvidenceCharacters,
        branch.branchId,
      );
      if (
        branch.deduplicatedEvidenceCharacters !== actualEvidenceCharacters ||
        branch.dynamicOverviewMinimum !== expectedMinimum ||
        overview.requiredFormalCharacters !== expectedMinimum ||
        overview.contentStatus !== branch.contentStatus ||
        (actualEvidenceCharacters === 0) !==
          (branch.contentStatus === "needs_verification")
      ) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `Website v2 branchEvidence 动态要求不正确：${branch.branchId}`,
        );
      }
    }
  }
  const evidencePathByFingerprint = new Map<string, string>();
  const evidenceDocuments = enrichedDocuments.filter(
    (document) => document.kind === "evidence",
  );
  const referencedEvidenceDocumentIds = new Set(
    customerDocuments.flatMap((document) => document.evidenceDocumentIds || []),
  );
  for (const evidenceDocument of evidenceDocuments) {
    const fingerprint = packagedEvidenceDocumentFingerprint(evidenceDocument);
    if (!fingerprint) continue;
    const duplicatePath = evidencePathByFingerprint.get(fingerprint);
    if (duplicatePath) {
      throw new KnowledgeArchiveValidationError(
        "content",
        `证据文档规范化后内容重复：${duplicatePath} / ${evidenceDocument.path}`,
      );
    }
    evidencePathByFingerprint.set(fingerprint, evidenceDocument.path);
  }
  if (manifest.schemaVersion !== 1) {
    const unreferencedEvidence = evidenceDocuments.find(
      (document) =>
        !document.id ||
        document.customerVisible !== false ||
        !referencedEvidenceDocumentIds.has(document.id),
    );
    if (unreferencedEvidence) {
      throw new KnowledgeArchiveValidationError(
        "structure",
        `v2 的每份 evidence 文档都必须被至少一篇正式文档引用：${unreferencedEvidence.path}`,
      );
    }
  }
  const productBranchIds = new Set(
    enrichedDocuments
      .filter(
        (document) =>
          document.kind === "leaf" &&
          (input.profile !== "website-lead-v1" ||
            document.branchId === "03_products") &&
          ((document.productFamilyIds?.length || 0) > 0 ||
            Boolean(document.productFamilyId)),
      )
      .map((document) => document.branchId || ""),
  );
  for (const document of customerDocuments) {
    if (input.profile === "dashboard-enterprise-v1") {
      const markedContent = markedFormalContent(document.content);
      if (markedContent === undefined) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `正式文档缺少唯一且有序的正文标记：${document.path}`,
        );
      }
      if (
        /^(?:#{1,6})\s+.*(?:(?:原始|证据|引用|参考)?来源|素材清单|展示素材|机器清单|证据状态|状态头|sources?|references?|asset inventory).*$/im.test(
          markedContent,
        ) ||
        /^\s*>\s*.*(?:状态|status)\s*[:：].*(?:来源|source)\s*[:：]/im.test(
          markedContent,
        )
      ) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `正式正文块不得包含来源、状态、素材或证据区：${document.path}`,
        );
      }
    }
    const formal = profileFormalKnowledgeText(document.content, input.profile);
    if (
      manifest.schemaVersion !== 1 &&
      (document.kind === "overview" || document.kind === "leaf")
    ) {
      const evidenceDocumentIds = document.evidenceDocumentIds || [];
      if (new Set(evidenceDocumentIds).size !== evidenceDocumentIds.length) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          `证据文档关联不得重复：${document.path}`,
        );
      }
      let actualEvidenceCharacters = 0;
      for (const evidenceDocumentId of evidenceDocumentIds) {
        const evidenceDocument = packageDocumentById.get(evidenceDocumentId);
        if (
          !evidenceDocument ||
          evidenceDocument.kind !== "evidence" ||
          evidenceDocument.customerVisible !== false
        ) {
          throw new KnowledgeArchiveValidationError(
            "structure",
            `正式文档关联了无效证据文档：${document.path} / ${evidenceDocumentId}`,
          );
        }
        if (
          !evidenceDocument.branchId ||
          evidenceDocument.branchId !== document.branchId
        ) {
          throw new KnowledgeArchiveValidationError(
            "structure",
            `正式文档只能关联显式属于同一分支的证据文档：${document.path} / ${evidenceDocumentId}`,
          );
        }
        if (
          !(document.sourceIds || []).some((sourceId) =>
            (evidenceDocument.sourceIds || []).includes(sourceId),
          )
        ) {
          throw new KnowledgeArchiveValidationError(
            "structure",
            `正式文档与证据文档没有共同来源：${document.path} / ${evidenceDocumentId}`,
          );
        }
        actualEvidenceCharacters +=
          evidenceCharacterByDocumentId.get(evidenceDocumentId) || 0;
      }
      if (document.evidenceCharacters !== actualEvidenceCharacters) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `证据字符数与服务端复算结果不一致：${document.path}`,
        );
      }
      const expected = evidenceProportionalFormalRequirement({
        kind: document.kind,
        isProductBranch: productBranchIds.has(document.branchId || ""),
        evidenceCharacters: actualEvidenceCharacters,
      });
      const requiredFormalCharacters =
        input.profile === "website-lead-v1"
          ? document.kind === "leaf"
            ? websiteV2LeafRequirement(actualEvidenceCharacters)
            : document.requiredFormalCharacters!
          : document.requiredFormalCharacters!;
      if (
        input.profile === "website-lead-v1" &&
        document.kind === "leaf" &&
        document.requiredFormalCharacters !== requiredFormalCharacters
      ) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `Website v2 叶子动态要求不正确：${document.path}`,
        );
      }
      if (
        input.profile === "dashboard-enterprise-v1" &&
        (!new Set([0, expected.required]).has(
          document.requiredFormalCharacters!,
        ) ||
          document.contentStatus !== expected.status)
      ) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `正文要求或内容状态不正确：${document.path}`,
        );
      }
      if (
        actualEvidenceCharacters === 0 &&
        !["needs_verification", "not_applicable"].includes(
          document.evidenceStatus || "",
        )
      ) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `无证据文档必须明确标记待核验或不适用：${document.path}`,
        );
      }
      if (effectiveCharacterCount(formal) < requiredFormalCharacters) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `正式正文未达到证据自适应要求 ${requiredFormalCharacters} 个有效字符：${document.path}`,
        );
      }
    } else {
      const evidenceBacked =
        document.kind === "leaf" &&
        document.evidenceStatus !== "needs_verification" &&
        document.evidenceStatus !== "not_applicable";
      if (evidenceBacked && effectiveCharacterCount(formal) < 120) {
        throw new KnowledgeArchiveValidationError(
          "content",
          `有证据知识叶子的正式正文少于 120 个有效字符：${document.path}`,
        );
      }
    }
  }
  const formalCharacters = customerDocuments.reduce(
    (total, document) =>
      total +
      effectiveCharacterCount(
        profileFormalKnowledgeText(document.content, input.profile),
      ),
    0,
  );
  if (
    (manifest.schemaVersion === 1 && formalCharacters < limits.minCharacters) ||
    formalCharacters > limits.maxCharacters
  ) {
    throw new KnowledgeArchiveValidationError(
      "content",
      manifest.schemaVersion === 1
        ? `正式正文必须在 ${limits.minCharacters}–${limits.maxCharacters} 个有效字符之间`
        : `正式正文不得超过 ${limits.maxCharacters} 个有效字符`,
    );
  }
  if (manifest.counts.customerVisibleCharacters !== formalCharacters) {
    throw new KnowledgeArchiveValidationError(
      "content",
      "package manifest 正式正文字数与服务端复算结果不一致",
    );
  }
  const evidenceCharacters = packagedEvidenceCharacters(enrichedDocuments);
  if (evidenceCharacters > limits.maxEvidenceCharacters) {
    throw new KnowledgeArchiveValidationError(
      "content",
      `证据文字超过 ${limits.maxEvidenceCharacters} 个有效字符上限`,
    );
  }
  if (manifest.counts.evidenceCharacters !== evidenceCharacters) {
    throw new KnowledgeArchiveValidationError(
      "content",
      "package manifest 证据文字数与服务端复算结果不一致",
    );
  }
  if (
    (completeness.acquisition.officialPages?.completed ?? 0) >
    limits.maxOfficialPages
  ) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      `成功采集官网页面超过 ${limits.maxOfficialPages} 页档位上限`,
    );
  }
  if (
    (completeness.acquisition.documents?.completed ?? 0) > limits.maxDocuments
  ) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      `解析文档超过 ${limits.maxDocuments} 份档位上限`,
    );
  }
  if (
    (completeness.acquisition.webQueries?.completed ?? 0) >
      limits.maxWebQueries ||
    (completeness.acquisition.webQueries?.total ?? 0) > limits.maxWebQueries
  ) {
    throw new KnowledgeArchiveValidationError(
      "structure",
      `公开查询超过 ${limits.maxWebQueries} 次档位上限`,
    );
  }
  const duplicates = duplicateFormalParagraphs(
    customerDocuments,
    input.profile,
  );
  if (duplicates.length > 0) {
    throw new KnowledgeArchiveValidationError(
      "content",
      `正式正文包含跨叶子重复模板：${duplicates[0]!.first} / ${duplicates[0]!.second}`,
    );
  }

  return {
    documents: enrichedDocuments
      .map((document) =>
        document.customerVisible
          ? {
              ...document,
              content: customerDisplayMarkdown(
                input.profile === "dashboard-enterprise-v1"
                  ? markedFormalContent(document.content) || ""
                  : document.content,
              ),
            }
          : document,
      )
      .sort((left, right) => (left.order ?? 10_000) - (right.order ?? 10_000)),
    assets: enrichedAssets,
    manifest,
  };
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function optionalCsvNumber(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function csvStringList(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // Pipe-separated cells are easier to author in a spreadsheet.
  }
  return normalized
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function dashboardFromCsv(text: string, displayName: string) {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV 至少需要表头和一行内容");
  const headers = rows[0]!.map((header) => header.toLowerCase());
  const records = rows
    .slice(1)
    .map((values) =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index] || ""]),
      ),
    );
  const payload = createDefaultDashboardPayload(displayName);
  const brand = records.find((record) => record.type === "brand");
  if (brand?.value || brand?.title)
    payload.brandName = brand.value || brand.title;
  const headline = records.find((record) => record.type === "headline");
  if (headline?.value || headline?.title) {
    payload.headline = headline.value || headline.title;
  }
  const summary = records.find((record) => record.type === "summary");
  if (summary?.value || summary?.description) {
    payload.summary = summary.value || summary.description;
  }
  payload.metrics = records
    .filter((record) => record.type === "metric")
    .map((record) => ({
      label: record.title || record.label || "指标",
      value: record.value || "-",
      unit: record.unit || undefined,
      note: record.note || undefined,
    }));
  const sectionIds = [
    ...new Set(
      records
        .filter((record) =>
          ["section", "item", "table", "table_row"].includes(record.type),
        )
        .map((record) => record.section || "overview"),
    ),
  ];
  payload.sections = sectionIds.map((sectionId) => {
    const sectionRecord = records.find(
      (record) =>
        record.type === "section" &&
        (record.section || "overview") === sectionId,
    );
    const tables = records
      .filter(
        (record) =>
          record.type === "table" &&
          (record.section || "overview") === sectionId,
      )
      .map((record, tableIndex) => {
        const tableId = (record.id || `table-${tableIndex + 1}`)
          .trim()
          .slice(0, 80);
        const columns = csvStringList(record.columns || record.value).slice(
          0,
          50,
        );
        const tableRows = records
          .filter(
            (candidate) =>
              candidate.type === "table_row" &&
              (candidate.section || "overview") === sectionId &&
              (candidate.table_id || candidate.id) === tableId,
          )
          .map((candidate) =>
            csvStringList(candidate.values || candidate.value).slice(
              0,
              columns.length,
            ),
          )
          .filter((row) => row.length > 0);
        return {
          id: tableId,
          title: (record.title || "数据表格").trim().slice(0, 160),
          description:
            (record.description || record.note || "").trim().slice(0, 1_000) ||
            undefined,
          columns,
          rows: tableRows,
        };
      })
      .filter((table) => table.columns.length > 0);
    return {
      id: sectionId.slice(0, 80),
      title: sectionRecord?.title || sectionId,
      subtitle: sectionRecord?.subtitle || undefined,
      body: sectionRecord?.description || sectionRecord?.value || undefined,
      items: records
        .filter(
          (record) =>
            record.type === "item" &&
            (record.section || "overview") === sectionId,
        )
        .map((record) => ({
          title: record.title || "内容",
          description: record.description || record.value || undefined,
          meta: record.meta || undefined,
          imageUrl: record.imageurl || record.image_url || undefined,
        })),
      tables,
    };
  });
  payload.questions = records
    .filter((record) => record.type === "question")
    .map((record, index) => ({
      id: (record.id || record.question_id || `question-${index + 1}`)
        .trim()
        .slice(0, 191),
      groupId: (record.group || record.group_id || "general")
        .trim()
        .slice(0, 128),
      groupTitle: (record.group_title || record.section || "问题")
        .trim()
        .slice(0, 255),
      groupSubtitle: (record.group_subtitle || record.subtitle || "")
        .trim()
        .slice(0, 300),
      tone: ["plum", "teal", "amber", "blue"].includes(record.tone)
        ? (record.tone as "plum" | "teal" | "amber" | "blue")
        : "plum",
      question: (record.title || record.question || "").trim().slice(0, 2_000),
      intent: (record.intent || record.description || "")
        .trim()
        .slice(0, 8_000),
      summary: (record.summary || record.value || "").trim().slice(0, 8_000),
    }))
    .filter((question) => question.question);
  payload.monitoringAnswers = records
    .filter((record) => record.type === "monitor_answer")
    .map((record, index) => ({
      id: (record.id || `monitor-answer-${index + 1}`).trim().slice(0, 191),
      questionId: (record.question_id || record.section || "")
        .trim()
        .slice(0, 191),
      platform: (record.platform || record.model || "").trim().slice(0, 128),
      collectedAt: (record.collected_at || record.date || "")
        .trim()
        .slice(0, 64),
      answerNo: Math.max(
        1,
        Math.trunc(optionalCsvNumber(record.answer_no) || 1),
      ),
      content: (record.answer || record.description || record.value || "")
        .trim()
        .slice(0, 200_000),
      citationCount: optionalCsvNumber(record.citation_count),
      monitorRank: optionalCsvNumber(record.monitor_rank),
      screenshotUrl: (record.screenshot_url || record.image_url || "")
        .trim()
        .slice(0, 2_048),
      citations:
        record.source_title || record.source_url
          ? [
              {
                title: (record.source_title || "").trim().slice(0, 1_000),
                url: (record.source_url || "").trim().slice(0, 2_048),
                media: (record.media || "").trim().slice(0, 255),
              },
            ]
          : [],
    }))
    .filter((record) => record.questionId && record.platform && record.content);
  payload.citations = records
    .filter((record) => record.type === "citation")
    .map((record, index) => ({
      id: (record.id || `citation-${index + 1}`).trim().slice(0, 191),
      questionId: (record.question_id || record.section || "")
        .trim()
        .slice(0, 191),
      model: (record.model || record.platform || "").trim().slice(0, 128),
      question: (record.question || record.value || "").trim().slice(0, 2_000),
      title: (record.title || record.source_title || "").trim().slice(0, 1_000),
      url: (record.url || record.source_url || "").trim().slice(0, 2_048),
      media: (record.media || "").trim().slice(0, 255),
      domain: (record.domain || "").trim().slice(0, 255),
      date: (record.date || record.collected_at || "").trim().slice(0, 64),
    }))
    .filter((record) => record.title || record.url);
  const assetRows = records.filter((record) => record.type === "content_asset");
  payload.contentAssets = assetRows.map((record, index) => {
    const assetId = (record.id || `asset-${index + 1}`).trim().slice(0, 80);
    const articles = records
      .filter(
        (candidate) =>
          candidate.type === "content_article" &&
          (candidate.asset_id || candidate.section) === assetId,
      )
      .map((candidate, articleIndex) => ({
        id: (candidate.id || `${assetId}-article-${articleIndex + 1}`)
          .trim()
          .slice(0, 191),
        title: (candidate.title || "内容").trim().slice(0, 500),
        intro: (candidate.description || "").trim().slice(0, 8_000),
        sections:
          candidate.value || candidate.summary
            ? [
                {
                  heading: (candidate.subtitle || "正文").trim().slice(0, 500),
                  body: (candidate.value || candidate.summary || "")
                    .trim()
                    .slice(0, 30_000),
                  media: candidate.image_url
                    ? [
                        {
                          url: candidate.image_url.trim().slice(0, 2_048),
                          alt: (candidate.title || "").trim().slice(0, 500),
                          caption: (candidate.note || "")
                            .trim()
                            .slice(0, 1_000),
                          source: (candidate.source_url || "")
                            .trim()
                            .slice(0, 2_048),
                        },
                      ]
                    : [],
                },
              ]
            : [],
      }));
    const imageCount = optionalCsvNumber(record.image_count || record.images);
    const impact = optionalCsvNumber(record.impact);
    return {
      id: assetId,
      group: (record.group || record.section || "内容资产")
        .trim()
        .slice(0, 255),
      name: (record.title || record.name || "内容资产").trim().slice(0, 255),
      description: (record.description || "").trim().slice(0, 2_000),
      wordRange: (record.word_range || record.words || "").trim().slice(0, 128),
      ...(imageCount === undefined
        ? {}
        : { imageCount: Math.max(0, Math.trunc(imageCount)) }),
      scene: (record.scene || "").trim().slice(0, 1_000),
      ...(impact === undefined
        ? {}
        : { impact: Math.max(0, Math.min(100, impact)) }),
      articles,
    };
  });
  return dashboardPayloadSchema.parse(payload);
}

const dashboardImportModuleSchema = z.union([
  z.literal("full"),
  dashboardAdminImportModuleSchema,
]);

export type DashboardImportModule = z.infer<typeof dashboardImportModuleSchema>;

function dashboardImportModule(value: string | undefined) {
  return dashboardImportModuleSchema.parse(value?.trim() || "full");
}

export function assertDashboardImportRevision(input: {
  expectedRevision: number | undefined;
  currentRevision: number;
}) {
  if (input.expectedRevision === undefined) {
    throw new Error("缺少看板版本号，请刷新管理页面后重新上传");
  }
  if (input.expectedRevision !== input.currentRevision) {
    throw new DashboardRevisionConflictError();
  }
}

export function assertDashboardImportModuleEnabled(
  module: DashboardImportModule,
): asserts module is DashboardAdminImportModule {
  if (module === "full") {
    throw new Error("整份看板导入已停用。请下载并上传对应模块的当前内容模板。");
  }
}

async function assertDashboardImportCapability(
  userId: number,
  module: DashboardAdminImportModule,
) {
  const capability =
    module === "monitoring"
      ? "monitoring"
      : module === "response-logic"
        ? "responseLogic"
        : module === "questions"
          ? "questionSelection"
          : module === "keywords"
            ? "globalKeywords"
            : module === "optimization-report"
              ? "progressReport"
              : "contentAssets";
  try {
    return await assertServiceCapability(userId, capability);
  } catch (error) {
    if (
      module !== "profile" ||
      !(error instanceof ServiceEntitlementError) ||
      error.code !== "CAPABILITY_UPGRADE_REQUIRED"
    ) {
      throw error;
    }
    // A knowledge-only customer still needs an administrator-confirmed
    // enterprise identity before a knowledge archive can be published.
    return assertServiceCapability(userId, "knowledgeBuild");
  }
}

export function assertDashboardImportPublishHash(input: {
  module: DashboardAdminImportModule;
  fileHash: string;
  expectedFileHash: string | undefined;
}) {
  const expectedFileHash = String(input.expectedFileHash || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedFileHash)) {
    if (input.module === "monitoring") {
      throw new MonitoringPreviewRequiredError();
    }
    throw new DashboardImportPreviewRequiredError();
  }
  if (expectedFileHash !== input.fileHash) {
    if (input.module === "monitoring") {
      throw new MonitoringFileChangedError();
    }
    throw new DashboardImportFileChangedError();
  }
}

function normalizedQuestionText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function assertOptimizationReportQuestionScope(
  report: NonNullable<DashboardPayload["optimizationReport"]>,
  questions: ReadonlyArray<{ id: string; question: string }>,
) {
  const allowedQuestions = new Map(
    questions.map((question) => [question.id, question]),
  );
  const assertQuestion = (
    questionId: string,
    questionText: string,
    label: string,
  ) => {
    if (!questionId) {
      throw new Error(`${label}缺少问题 ID`);
    }
    const allowed = allowedQuestions.get(questionId);
    if (!allowed) {
      throw new Error(`${label}不属于当前用户的问题`);
    }
    if (
      normalizedQuestionText(allowed.question) !==
      normalizedQuestionText(questionText)
    ) {
      throw new Error(`${label}题面与当前用户的问题不一致`);
    }
  };

  for (const baseline of report.questionBaselines ?? []) {
    assertQuestion(
      baseline.questionId || baseline.id,
      baseline.question,
      "优化前基准",
    );
  }
  for (const questionReport of report.questionReports ?? []) {
    assertQuestion(
      questionReport.id,
      questionReport.question,
      "逐问题进度报告",
    );
  }
}

export function mergeDashboardModule(input: {
  existing: DashboardPayload;
  incoming: DashboardPayload;
  module: Exclude<DashboardImportModule, "section-table" | "response-logic">;
}) {
  const { existing, incoming, module } = input;
  if (module === "full") return dashboardPayloadSchema.parse(incoming);
  if (module === "profile") {
    return dashboardPayloadSchema.parse({
      ...existing,
      brandName: incoming.brandName,
      headline: incoming.headline,
      summary: incoming.summary,
    });
  }
  if (module === "metrics") {
    return dashboardPayloadSchema.parse({
      ...existing,
      metrics: incoming.metrics,
    });
  }
  if (module === "sections") {
    return dashboardPayloadSchema.parse({
      ...existing,
      sections: incoming.sections,
    });
  }
  if (module === "keywords") {
    return dashboardPayloadSchema.parse({
      ...existing,
      keywordTables: incoming.keywordTables,
    });
  }
  if (module === "questions") {
    return dashboardPayloadSchema.parse({
      ...existing,
      questions: incoming.questions,
    });
  }
  if (module === "monitoring") {
    return dashboardPayloadSchema.parse({
      ...existing,
      monitoringAnswers: incoming.monitoringAnswers,
      citations: incoming.citations,
    });
  }
  if (module === "content-assets") {
    return dashboardPayloadSchema.parse({
      ...existing,
      contentAssets: incoming.contentAssets,
    });
  }
  return dashboardPayloadSchema.parse({
    ...existing,
    optimizationReport: incoming.optimizationReport,
  });
}

function dashboardPayloadFromModuleJson(input: {
  text: string;
  existing: DashboardPayload;
  module: Exclude<DashboardImportModule, "section-table" | "response-logic">;
  currentRevision?: number;
}) {
  const raw = JSON.parse(input.text);
  if (input.module === "full") return dashboardPayloadSchema.parse(raw);
  if (input.currentRevision === undefined) {
    throw new DashboardTemplateRevisionError(
      "无法核验当前内容模板修订号，请刷新管理页面后重试。",
    );
  }
  parseDashboardModuleTemplateMetadata({
    raw,
    expectedModule: input.module,
    currentRevision: input.currentRevision,
  });
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const incoming = { ...input.existing };
  if (input.module === "profile") {
    const profile = z
      .object({
        brandName: z.string().trim().min(1).max(160),
        headline: z.string().trim().min(1).max(300),
        summary: z.string().trim().max(4_000).default(""),
      })
      .parse(value.profile ?? raw);
    return dashboardPayloadSchema.parse({ ...incoming, ...profile });
  }
  if (input.module === "metrics") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      metrics: z
        .array(dashboardMetricSchema)
        .max(24)
        .parse(value.metrics ?? raw),
    });
  }
  if (input.module === "sections") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      sections: z
        .array(dashboardSectionSchema)
        .max(40)
        .parse(value.sections ?? raw),
    });
  }
  if (input.module === "keywords") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      keywordTables: z
        .array(dashboardTableSchema)
        .max(20)
        .parse(value.keywordTables ?? value.tables ?? raw),
    });
  }
  if (input.module === "questions") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      questions: z
        .array(dashboardQuestionSchema)
        .max(500)
        .parse(value.questions ?? raw),
    });
  }
  if (input.module === "monitoring") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      monitoringAnswers: z
        .array(dashboardMonitoringAnswerSchema)
        .max(100_000)
        .parse(value.monitoringAnswers ?? []),
      citations: z
        .array(dashboardCitationRecordSchema)
        .max(100_000)
        .parse(value.citations ?? []),
    });
  }
  if (input.module === "content-assets") {
    return dashboardPayloadSchema.parse({
      ...incoming,
      contentAssets: z
        .array(dashboardContentAssetSchema)
        .max(200)
        .parse(value.contentAssets ?? raw),
    });
  }
  const template = parseOptimizationReportTemplate({
    raw,
    currentRevision: input.currentRevision,
  });
  return dashboardPayloadSchema.parse({
    ...incoming,
    optimizationReport: template.optimizationReport,
  });
}

export function parseDashboardModuleTemplateMetadata(input: {
  raw: unknown;
  expectedModule: Exclude<DashboardImportModule, "full" | "section-table">;
  currentRevision: number;
}) {
  const parsed = dashboardModuleTemplateMetadataSchema.safeParse(input.raw);
  if (!parsed.success) {
    throw new DashboardTemplateRevisionError(
      "JSON 文件不是当前内容模板，请重新下载对应模块模板后编辑。",
    );
  }
  if (parsed.data.module !== input.expectedModule) {
    throw new DashboardTemplateRevisionError(
      `模板模块不匹配：当前上传入口为 ${input.expectedModule}`,
    );
  }
  if (parsed.data.templateRevision !== input.currentRevision) {
    throw new DashboardTemplateRevisionError();
  }
  return parsed.data;
}

export function parseOptimizationReportTemplate(input: {
  raw: unknown;
  currentRevision: number;
}) {
  parseDashboardModuleTemplateMetadata({
    raw: input.raw,
    expectedModule: "optimization-report",
    currentRevision: input.currentRevision,
  });
  const parsed = dashboardOptimizationReportTemplateSchema.safeParse(input.raw);
  if (!parsed.success) {
    throw new DashboardTemplateRevisionError(
      "优化报告文件不是当前内容模板，请重新下载模板后编辑。",
    );
  }
  if (parsed.data.templateRevision !== input.currentRevision) {
    throw new DashboardTemplateRevisionError();
  }
  return parsed.data;
}

function recordFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function recordDiffByKey<T>(
  before: readonly T[],
  after: readonly T[],
  recordKey: (item: T, index: number) => string,
) {
  const keyed = (items: readonly T[]) => {
    const occurrences = new Map<string, number>();
    return new Map(
      items.map((item, index) => {
        const baseKey = recordKey(item, index) || `row-${index + 1}`;
        const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
        occurrences.set(baseKey, occurrence);
        return [`${baseKey}#${occurrence}`, item] as const;
      }),
    );
  };
  const beforeById = keyed(before);
  const afterById = keyed(after);
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [id, item] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) {
      added += 1;
    } else if (recordFingerprint(previous) === recordFingerprint(item)) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }
  let removed = 0;
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removed += 1;
  }
  return { added, updated, removed, unchanged };
}

function recordDiff<T extends { id?: string; questionId?: string }>(
  before: readonly T[],
  after: readonly T[],
) {
  return recordDiffByKey(before, after, (item) =>
    String(item.questionId || item.id || ""),
  );
}

function previewValue(value: unknown) {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function recordStats<T>(input: {
  label: string;
  before: readonly T[];
  after: readonly T[];
  key: (item: T, index: number) => string;
}) {
  const diff = recordDiffByKey(input.before, input.after, input.key);
  return {
    label: input.label,
    beforeCount: input.before.length,
    afterCount: input.after.length,
    ...diff,
  };
}

function recordStatsSummary(
  stats: DashboardModuleImportPreview["recordStats"][number],
) {
  return `${stats.label}：现有 ${stats.beforeCount} 条，导入后 ${stats.afterCount} 条；新增 ${stats.added}、更新 ${stats.updated}、删除 ${stats.removed}、不变 ${stats.unchanged}`;
}

export function buildDashboardModuleImportPreview(input: {
  module: Exclude<
    DashboardAdminImportModule,
    "monitoring" | "response-logic" | "optimization-report"
  >;
  current: DashboardPayload;
  incoming: DashboardPayload;
  sourceName: string;
  fileHash: string;
  templateRevision: number;
  sectionId?: string;
}): DashboardModuleImportPreview {
  const recordStatsList: DashboardModuleImportPreview["recordStats"] = [];
  const changedFields: DashboardModuleImportPreview["changedFields"] = [];

  if (input.module === "profile") {
    const fields = [
      ["brandName", "企业名称"],
      ["headline", "看板标题"],
      ["summary", "企业摘要"],
    ] as const;
    for (const [field, label] of fields) {
      if (
        recordFingerprint(input.current[field]) !==
        recordFingerprint(input.incoming[field])
      ) {
        changedFields.push({
          field,
          label,
          before: previewValue(input.current[field]),
          after: previewValue(input.incoming[field]),
        });
      }
    }
    recordStatsList.push({
      label: "企业资料字段",
      beforeCount: fields.length,
      afterCount: fields.length,
      added: 0,
      updated: changedFields.length,
      removed: 0,
      unchanged: fields.length - changedFields.length,
    });
  } else if (input.module === "metrics") {
    recordStatsList.push(
      recordStats({
        label: "看板指标",
        before: input.current.metrics,
        after: input.incoming.metrics,
        key: (metric, index) => metric.label || `metric-${index + 1}`,
      }),
    );
  } else if (input.module === "sections") {
    recordStatsList.push(
      recordStats({
        label: "内容板块",
        before: input.current.sections,
        after: input.incoming.sections,
        key: (section) => section.id,
      }),
    );
  } else if (input.module === "section-table") {
    if (!input.sectionId) {
      throw new Error("板块表格预检缺少板块 ID");
    }
    const currentSection = input.current.sections.find(
      (section) => section.id === input.sectionId,
    );
    const incomingSection = input.incoming.sections.find(
      (section) => section.id === input.sectionId,
    );
    if (!currentSection || !incomingSection) {
      throw new Error("没有找到要预检的内容板块");
    }
    recordStatsList.push(
      recordStats({
        label: `板块表格（${currentSection.title}）`,
        before: currentSection.tables ?? [],
        after: incomingSection.tables ?? [],
        key: (table) => table.id,
      }),
    );
  } else if (input.module === "keywords") {
    recordStatsList.push(
      recordStats({
        label: "词库表格",
        before: input.current.keywordTables,
        after: input.incoming.keywordTables,
        key: (table) => table.id,
      }),
    );
  } else if (input.module === "questions") {
    recordStatsList.push(
      recordStats({
        label: "问题目录",
        before: input.current.questions,
        after: input.incoming.questions,
        key: (question) => question.id,
      }),
    );
  } else {
    recordStatsList.push(
      recordStats({
        label: "内容资产",
        before: input.current.contentAssets,
        after: input.incoming.contentAssets,
        key: (asset) => asset.id,
      }),
    );
  }

  const summary =
    changedFields.length > 0
      ? [
          `将更新字段：${changedFields.map((field) => field.label).join("、")}`,
          ...recordStatsList.map(recordStatsSummary),
        ]
      : recordStatsList.map(recordStatsSummary);
  return dashboardModuleImportPreviewSchema.parse({
    mode: "dashboard-module",
    module: input.module,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    ...(input.sectionId ? { sectionId: input.sectionId } : {}),
    summary,
    recordStats: recordStatsList,
    changedFields,
  });
}

export function assertResponseLogicImportRecordVersions(input: {
  current: ReadonlyArray<{
    questionId: string;
    revision: number;
  }>;
  incoming: readonly VersionedResponseLogicImport[];
}) {
  const currentByQuestionId = new Map(
    input.current.map((record) => [record.questionId, record]),
  );
  for (const incoming of input.incoming) {
    const actualRevision =
      currentByQuestionId.get(incoming.questionId)?.revision ?? 0;
    if (incoming.expectedRevision !== actualRevision) {
      throw new DashboardTemplateRevisionError(
        `应答逻辑 ${incoming.questionId} 已更新到 R${actualRevision}，当前模板为 R${incoming.expectedRevision}；请重新下载当前内容模板。`,
      );
    }
  }
}

export function buildResponseLogicImportPreview(input: {
  current: ReadonlyArray<{
    questionId: string;
    question: string;
    draft: unknown;
    confirmed?: unknown;
    revision: number;
  }>;
  incoming: readonly VersionedResponseLogicImport[];
  sourceName: string;
  fileHash: string;
  templateRevision: number;
}): DashboardModuleImportPreview {
  assertResponseLogicImportRecordVersions(input);
  const comparableDraft = (value: unknown) => {
    const draft =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      concern: String(draft.concern ?? ""),
      conclusion: String(draft.conclusion ?? ""),
      facts: String(draft.facts ?? ""),
      pending: String(draft.pending ?? ""),
      boundaries: String(draft.boundaries ?? ""),
      references: String(draft.references ?? ""),
      images: Array.isArray(draft.images) ? draft.images : [],
      attachments: [],
    };
  };
  const comparableCurrent = input.current.map((record) => ({
    questionId: record.questionId,
    question: record.question,
    draft: comparableDraft(record.confirmed ?? record.draft),
    publish: Boolean(record.confirmed),
  }));
  const comparableIncoming = input.incoming.map((record) => ({
    questionId: record.questionId,
    question: record.question,
    draft: comparableDraft(record.draft),
    publish: record.publish,
  }));
  const stats = recordStats({
    label: "应答逻辑",
    before: comparableCurrent,
    after: comparableIncoming,
    key: (record) => record.questionId,
  });
  const publishCount = comparableIncoming.filter(
    (record) => record.publish,
  ).length;
  return dashboardModuleImportPreviewSchema.parse({
    mode: "dashboard-module",
    module: "response-logic",
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      recordStatsSummary(stats),
      `其中 ${publishCount} 条会发布为正式确认版本，其余保存为草稿。`,
    ],
    recordStats: [stats],
    changedFields: [],
  });
}

type AuthoritativeServiceQuestion = {
  id: string;
  category:
    | "industry"
    | "competitor_comparison"
    | "reputation"
    | "product_scenario";
  question: string;
  intent?: string | null;
  rationale?: string | null;
  revision: number;
};

const DASHBOARD_QUESTION_GROUPS = {
  industry: {
    groupId: "ranking",
    groupTitle: "行业词",
    tone: "amber" as const,
  },
  competitor_comparison: {
    groupId: "comparison",
    groupTitle: "竞品对比词",
    tone: "blue" as const,
  },
  reputation: {
    groupId: "reputation",
    groupTitle: "美誉舆情词",
    tone: "plum" as const,
  },
  product_scenario: {
    groupId: "scenario",
    groupTitle: "产品场景词",
    tone: "teal" as const,
  },
};

export function dashboardQuestionCatalogFromService(input: {
  questions: readonly AuthoritativeServiceQuestion[];
  managedQuestions?: readonly DashboardPayload["questions"][number][];
}) {
  const managedByIdentity = new Map<
    string,
    DashboardPayload["questions"][number]
  >();
  for (const managed of input.managedQuestions ?? []) {
    managedByIdentity.set(managed.id, managed);
  }
  return input.questions.map((question) => {
    const managed = managedByIdentity.get(question.id);
    const group = DASHBOARD_QUESTION_GROUPS[question.category];
    return dashboardQuestionSchema.parse({
      id: question.id,
      groupId: group.groupId,
      groupTitle: group.groupTitle,
      groupSubtitle: managed?.groupSubtitle ?? "",
      tone: group.tone,
      question: question.question,
      intent: question.intent ?? managed?.intent ?? "",
      summary: question.rationale ?? managed?.summary ?? "",
    });
  });
}

export function dashboardPayloadWithServiceQuestionCatalog(input: {
  payload: DashboardPayload;
  questions: readonly AuthoritativeServiceQuestion[];
}) {
  return dashboardPayloadSchema.parse({
    ...input.payload,
    questions: dashboardQuestionCatalogFromService({
      questions: input.questions,
      managedQuestions: input.payload.questions,
    }),
  });
}

export function parseAuthoritativeQuestionsTemplate(input: {
  raw: unknown;
  currentRevision: number;
  currentQuestions: readonly AuthoritativeServiceQuestion[];
}) {
  parseDashboardModuleTemplateMetadata({
    raw: input.raw,
    expectedModule: "questions",
    currentRevision: input.currentRevision,
  });
  const template = dashboardQuestionsTemplateSchema.parse(input.raw);
  if (input.currentQuestions.length === 0) {
    throw new Error("当前服务没有可通过模板维护的正式问题");
  }
  const currentById = new Map(
    input.currentQuestions.map((question) => [question.id, question]),
  );
  if (
    template.questions.length !== input.currentQuestions.length ||
    template.questions.some((question) => !currentById.has(question.id))
  ) {
    throw new Error(
      "正式问题模板必须完整保留当前问题目录；新增或删除问题请走问题选择流程。",
    );
  }
  for (const question of template.questions) {
    const current = currentById.get(question.id)!;
    if (question.revision !== current.revision) {
      throw new DashboardTemplateRevisionError(
        `正式问题 ${question.id} 已更新到 R${current.revision}，请重新下载当前内容模板。`,
      );
    }
    if (question.category !== current.category) {
      throw new Error(
        `正式问题 ${question.id} 的问题类型不能通过内容模板修改。`,
      );
    }
  }
  return template;
}

export function buildAuthoritativeQuestionsImportPreview(input: {
  sourceName: string;
  fileHash: string;
  templateRevision: number;
  current: readonly AuthoritativeServiceQuestion[];
  incoming: ReturnType<typeof parseAuthoritativeQuestionsTemplate>["questions"];
}) {
  const stats = recordStats({
    label: "正式问题目录",
    before: input.current.map((question) => ({
      id: question.id,
      revision: question.revision,
      category: question.category,
      question: question.question,
      intent: question.intent ?? null,
      rationale: question.rationale ?? null,
    })),
    after: input.incoming,
    key: (question) => question.id,
  });
  return dashboardModuleImportPreviewSchema.parse({
    mode: "dashboard-module",
    module: "questions",
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      recordStatsSummary(stats),
      "问题 ID、类型和逐题修订号由正式服务锁定；本次只更新题面、意图和推荐理由。",
    ],
    recordStats: [stats],
    changedFields: [],
  });
}

function monitoringTemplateComparableBatch(
  batch: ReturnType<
    typeof dashboardMonitoringCurrentTemplateSchema.parse
  >["batches"][number],
) {
  return {
    sourceName: batch.sourceName,
    collectedAt: batch.collectedAt,
    samples: batch.samples,
    citations: batch.citations,
  };
}

export function parseMonitoringCurrentTemplate(input: {
  raw: unknown;
  currentRevision: number;
  workspaceUserId: number;
  currentBatches: Awaited<
    ReturnType<typeof getMonitoringCurrentTemplateBatches>
  >;
}) {
  parseDashboardModuleTemplateMetadata({
    raw: input.raw,
    expectedModule: "monitoring",
    currentRevision: input.currentRevision,
  });
  const template = dashboardMonitoringCurrentTemplateSchema.parse(input.raw);
  if (template.workspaceUserId !== input.workspaceUserId) {
    throw new Error("问题监控模板绑定的企业与当前工作台不一致");
  }
  const currentByKey = new Map(
    input.currentBatches.map((batch) => [batch.batchKey, batch]),
  );
  if (
    template.batches.length !== input.currentBatches.length ||
    template.batches.some((batch) => !currentByKey.has(batch.batchKey))
  ) {
    throw new Error(
      "问题监控模板必须完整保留当前服务的监控批次；新增数据请上传原始监控表。",
    );
  }
  for (const batch of template.batches) {
    const current = currentByKey.get(batch.batchKey)!;
    if (batch.revision !== current.revision) {
      throw new DashboardTemplateRevisionError(
        `监控批次 ${batch.batchKey} 已更新到 R${current.revision}，请重新下载当前内容模板。`,
      );
    }
  }
  const changedBatchCount = template.batches.filter(
    (batch) =>
      JSON.stringify(monitoringTemplateComparableBatch(batch)) !==
      JSON.stringify(
        monitoringTemplateComparableBatch(currentByKey.get(batch.batchKey)!),
      ),
  ).length;
  if (changedBatchCount === 0) {
    throw new Error("问题监控当前内容模板与正式数据一致，无需发布");
  }
  return { template, changedBatchCount };
}

export function buildMonitoringCurrentTemplatePreview(input: {
  template: ReturnType<typeof dashboardMonitoringCurrentTemplateSchema.parse>;
  changedBatchCount: number;
  sourceName: string;
  fileHash: string;
  templateRevision: number;
}) {
  const samples = input.template.batches.flatMap((batch) => batch.samples);
  const citations = input.template.batches.flatMap((batch) => batch.citations);
  const questions = [
    ...new Set([...samples, ...citations].map((record) => record.questionId)),
  ];
  const models = [
    ...new Set([
      ...samples.map((sample) => sample.platform),
      ...citations.map((citation) => citation.model),
    ]),
  ];
  const dates = [
    ...new Set(
      input.template.batches
        .map((batch) => monitoringBeijingDate(batch.collectedAt))
        .filter(Boolean),
    ),
  ].sort();
  return {
    module: "monitoring" as const,
    mode: "answer-linked" as const,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      `当前正式监控批次 ${input.template.batches.length} 个，其中 ${input.changedBatchCount} 个包含待发布变化。`,
      `答案 ${samples.length} 条，引用 ${citations.length} 条。`,
    ],
    targetBatchRequired: false,
    availableBatches: [],
    questions,
    models,
    dates,
    sampleCount: samples.length,
    citationCount: citations.length,
    exactLinked: citations.filter((citation) =>
      Boolean(citation.sampleSourceRecordId),
    ).length,
    issues: [],
    currentTemplate: true,
    changedBatchCount: input.changedBatchCount,
  };
}

export function buildOptimizationReportImportPreview(input: {
  current: DashboardPayload["optimizationReport"];
  incoming: NonNullable<DashboardPayload["optimizationReport"]>;
  fileHash: string;
  sourceName: string;
  templateRevision: number;
}) {
  return {
    mode: "optimization-report" as const,
    module: "optimization-report" as const,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision,
    summary: [
      `逐问题报告：新增 ${
        recordDiff(
          input.current?.questionReports ?? [],
          input.incoming.questionReports ?? [],
        ).added
      }、更新 ${
        recordDiff(
          input.current?.questionReports ?? [],
          input.incoming.questionReports ?? [],
        ).updated
      }、删除 ${
        recordDiff(
          input.current?.questionReports ?? [],
          input.incoming.questionReports ?? [],
        ).removed
      }`,
      `优化后效果将向用户开放 ${
        (input.incoming.questionReports ?? []).filter(
          (report) => report.afterEffect?.released,
        ).length
      } 项。`,
    ],
    questionReports: recordDiff(
      input.current?.questionReports ?? [],
      input.incoming.questionReports ?? [],
    ),
    questionBaselines: recordDiff(
      input.current?.questionBaselines ?? [],
      input.incoming.questionBaselines ?? [],
    ),
    releasedAfterEffects: (input.incoming.questionReports ?? []).filter(
      (report) => report.afterEffect?.released,
    ).length,
    questions: (input.incoming.questionReports ?? []).map((report) => ({
      id: report.id,
      question: report.question,
      afterEffectReleased: Boolean(report.afterEffect?.released),
    })),
  };
}

function tabularCellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value).trim();
  const record = value as {
    text?: unknown;
    result?: unknown;
    hyperlink?: unknown;
    richText?: Array<{ text?: unknown }>;
  };
  if (record.richText) {
    return record.richText
      .map((part) => String(part.text || ""))
      .join("")
      .trim();
  }
  if (record.text !== undefined) return String(record.text).trim();
  if (record.result !== undefined) return tabularCellText(record.result);
  if (record.hyperlink !== undefined) return String(record.hyperlink).trim();
  return String(value).trim();
}

function trimTabularRow(row: string[]) {
  const copy = [...row];
  while (copy.length > 0 && !copy.at(-1)) copy.pop();
  return copy;
}

function normalizeTableRows(
  rows: string[][],
  title: string,
  tableIndex: number,
) {
  const usableRows = rows
    .map(trimTabularRow)
    .filter((row) => row.some(Boolean));
  if (usableRows.length === 0) return null;
  const width = Math.min(50, Math.max(...usableRows.map((row) => row.length)));
  const columns = Array.from({ length: width }, (_, index) => {
    const value = usableRows[0]?.[index]?.trim();
    return value || `列 ${index + 1}`;
  });
  const normalizedTitle = title.trim() || `数据表格 ${tableIndex + 1}`;
  const slug =
    normalizedTitle
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `table-${tableIndex + 1}`;
  return dashboardTableSchema.parse({
    id: `${slug}-${tableIndex + 1}`.slice(0, 80),
    title: normalizedTitle.slice(0, 160),
    columns,
    rows: usableRows
      .slice(1, 10_001)
      .map((row) =>
        Array.from({ length: width }, (_, index) =>
          String(row[index] || "").slice(0, 8_000),
        ),
      ),
  });
}

function csvTextFromRows(rows: string[][]) {
  const cell = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

async function workbookRows(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook.worksheets.map((worksheet) => {
    const rows: string[][] = [];
    // ExcelJS derives worksheet.columnCount by scanning rows. Cache it once
    // so large monitoring exports do not become an O(n²) import.
    const worksheetColumnCount = Math.min(50, worksheet.columnCount);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.from(
        { length: Math.min(50, Math.max(row.cellCount, worksheetColumnCount)) },
        (_, index) => tabularCellText(row.getCell(index + 1).value),
      );
      rows.push(trimTabularRow(values));
    });
    return { title: worksheet.name, rows };
  });
}

type TabularSource = Awaited<ReturnType<typeof workbookRows>>[number];

function normalizedTabularHeader(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function legacyMonitoringModelFromSheetName(value: string) {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (/deep[\s_-]*seek/.test(normalized)) return "deepseek";
  if (/(?:百度|文心|baidu)/.test(normalized)) return "baiduai";
  if (/(?:豆包|dou[\s_-]*bao)/.test(normalized)) return "doubao";
  if (/(?:通义|千问|qianwen|qwen)/.test(normalized)) return "qianwen";
  if (/(?:腾讯)?元宝|yuanbao/.test(normalized)) return "yuanbao";
  return normalized.slice(0, 128);
}

function sourceDomain(value: string) {
  try {
    const url = new URL(value);
    return url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .slice(0, 255);
  } catch {
    return "";
  }
}

/**
 * Accepts the citation-analysis workbook exported by the monitoring platform.
 * Aggregate media/content sheets are deliberately not expanded into fake raw
 * rows; the question-citation sheet is the authoritative record ledger.
 */
export function monitoringPayloadFromTabularSources(input: {
  sources: TabularSource[];
  existing: DashboardPayload;
}) {
  const answers: DashboardPayload["monitoringAnswers"] = [];
  const citations: DashboardPayload["citations"] = [];
  let structuredAnswerSheetsPresent = false;
  const questionById = new Map(
    input.existing.questions.map((question) => [question.id, question]),
  );
  const questionIdsByText = new Map<string, string[]>();
  for (const question of input.existing.questions) {
    const text = question.question
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    questionIdsByText.set(text, [
      ...(questionIdsByText.get(text) ?? []),
      question.id,
    ]);
  }
  const resolveQuestionId = (value: {
    id: string;
    text: string;
    source: string;
  }) => {
    const requestedId = value.id.trim();
    const requestedText = value.text
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    if (requestedId) {
      const question = questionById.get(requestedId);
      if (!question) {
        throw new Error(`${value.source}引用了未配置的问题 ID：${requestedId}`);
      }
      if (
        requestedText &&
        question.question.normalize("NFKC").replace(/\s+/g, " ").trim() !==
          requestedText
      ) {
        throw new Error(`${value.source}的问题 ID 与问题原文不一致`);
      }
      return requestedId;
    }
    if (!requestedText) {
      throw new Error(`${value.source}缺少问题 ID 和问题原文`);
    }
    const matches = questionIdsByText.get(requestedText) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `${value.source}的问题原文无法在问题目录中精确匹配`
          : `${value.source}的问题原文匹配多个问题，请填写问题 ID`,
      );
    }
    return matches[0]!;
  };
  const columnIndex = (headers: string[], ...names: string[]) => {
    const normalizedNames = names.map(normalizedTabularHeader);
    return headers.findIndex((header) => normalizedNames.includes(header));
  };
  const requireImportDate = (value: string, source: string) => {
    const normalized = value.trim();
    if (!normalized || !Number.isFinite(Date.parse(normalized))) {
      throw new Error(`${source}的日期无效`);
    }
    return normalized;
  };
  const requireImportUrl = (value: string, source: string) => {
    const normalized = value.trim();
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error();
      }
    } catch {
      throw new Error(`${source}的文章链接无效`);
    }
    return normalized;
  };

  // Parse answer sheets first so citation sheets can bind by an exact answer ID
  // regardless of workbook sheet order.
  for (const source of input.sources) {
    const rows = source.rows
      .map(trimTabularRow)
      .filter((row) => row.some(Boolean));
    const headerIndex = rows.findIndex((row) => {
      const headers = new Set(row.map(normalizedTabularHeader));
      return (
        (headers.has("答案id") ||
          headers.has("answerid") ||
          headers.has("样本id")) &&
        (headers.has("答案正文") ||
          headers.has("答案内容") ||
          headers.has("模型回答") ||
          headers.has("回答内容")) &&
        (headers.has("模型") || headers.has("ai模型") || headers.has("平台"))
      );
    });
    if (headerIndex < 0) {
      const firstHeader = rows[0]?.map(normalizedTabularHeader) ?? [];
      const secondHeader = rows[1]?.map(normalizedTabularHeader) ?? [];
      const isLegacyFiveAnswerSheet =
        firstHeader[0] === "品牌名称" &&
        firstHeader[2] === "问题" &&
        firstHeader[3] === "日期" &&
        /^答案1$/.test(firstHeader[4] || "") &&
        secondHeader[4] === "内容" &&
        secondHeader[5] === "截图链接";
      if (!isLegacyFiveAnswerSheet) continue;
      const model = legacyMonitoringModelFromSheetName(source.title);
      if (!model) {
        throw new Error(`${source.title}无法识别监控模型`);
      }
      rows.slice(2).forEach((row, rowIndex) => {
        const sourceRow = `${source.title} 第 ${rowIndex + 3} 行`;
        const rawQuestion = String(row[2] || "").trim();
        if (!rawQuestion) return;
        const questionId = resolveQuestionId({
          id: "",
          text: rawQuestion,
          source: sourceRow,
        });
        const date = requireImportDate(String(row[3] || ""), sourceRow);
        for (let answerOffset = 0; answerOffset < 5; answerOffset += 1) {
          const columnOffset = 4 + answerOffset * 4;
          const content = String(row[columnOffset] || "").trim();
          const screenshotUrl = String(row[columnOffset + 1] || "").trim();
          const rankText = String(
            row[columnOffset + 3] || row[columnOffset + 2] || "",
          ).trim();
          if (!content && !screenshotUrl && !rankText) continue;
          if (!content) {
            throw new Error(
              `${sourceRow}的答案 ${answerOffset + 1} 缺少答案正文`,
            );
          }
          const answerNo = answerOffset + 1;
          const digest = createHash("sha1")
            .update(
              [source.title, model, questionId, date, answerNo, content].join(
                "\u001f",
              ),
            )
            .digest("hex");
          const rankMatch = rankText.match(/\d+/);
          const monitorRank = rankMatch ? Number(rankMatch[0]) : undefined;
          answers.push({
            id: `legacy-answer-${digest}`,
            questionId,
            platform: model,
            collectedAt: date.slice(0, 64),
            answerNo,
            content: content.slice(0, 200_000),
            citationCount: 0,
            monitorRank:
              Number.isInteger(monitorRank) && Number(monitorRank) > 0
                ? Number(monitorRank)
                : undefined,
            screenshotUrl: screenshotUrl.slice(0, 2_048),
            citations: [],
          });
        }
      });
      continue;
    }
    structuredAnswerSheetsPresent = true;
    const headers = rows[headerIndex]!.map(normalizedTabularHeader);
    const answerIdIndex = columnIndex(
      headers,
      "答案ID",
      "answer_id",
      "answerId",
      "样本ID",
    );
    const questionIdIndex = columnIndex(
      headers,
      "问题ID",
      "question_id",
      "questionId",
    );
    const questionIndex = columnIndex(headers, "问题原文", "监控问题", "问题");
    const modelIndex = columnIndex(headers, "模型", "AI模型", "平台");
    const dateIndex = columnIndex(headers, "采集时间", "采集日期", "日期");
    const contentIndex = columnIndex(
      headers,
      "答案正文",
      "答案内容",
      "模型回答",
      "回答内容",
    );
    const answerNoIndex = columnIndex(
      headers,
      "答案序号",
      "答案编号",
      "answerNo",
    );
    const rankIndex = columnIndex(headers, "答案位次", "排名", "monitorRank");
    const screenshotIndex = columnIndex(
      headers,
      "截图URL",
      "截图链接",
      "screenshotUrl",
    );
    rows.slice(headerIndex + 1).forEach((row, rowIndex) => {
      const sourceRow = `${source.title} 第 ${headerIndex + rowIndex + 2} 行`;
      const answerId = String(row[answerIdIndex] || "").trim();
      const content = String(row[contentIndex] || "").trim();
      if (!answerId && !content) return;
      if (!answerId) {
        throw new Error(`${sourceRow}缺少答案 ID`);
      }
      if (answerId.length > 191) {
        throw new Error(`${sourceRow}的答案 ID 超过 191 个字符`);
      }
      if (!content) {
        throw new Error(`${sourceRow}缺少答案正文`);
      }
      const model = String(row[modelIndex] || "").trim();
      if (!model) {
        throw new Error(`${sourceRow}缺少模型`);
      }
      const rawQuestionId = String(row[questionIdIndex] || "").trim();
      const rawQuestion = String(row[questionIndex] || "").trim();
      if (!rawQuestionId) throw new Error(`${sourceRow}缺少问题 ID`);
      if (!rawQuestion) throw new Error(`${sourceRow}缺少问题原文`);
      const questionId = resolveQuestionId({
        id: rawQuestionId,
        text: rawQuestion,
        source: sourceRow,
      });
      const date = requireImportDate(String(row[dateIndex] || ""), sourceRow);
      const answerNo = Number(String(row[answerNoIndex] || "").trim());
      const monitorRank = Number(String(row[rankIndex] || "").trim());
      answers.push({
        id: answerId.slice(0, 191),
        questionId,
        platform: model.slice(0, 128),
        collectedAt: date.slice(0, 64),
        answerNo:
          Number.isInteger(answerNo) && answerNo > 0 ? answerNo : rowIndex + 1,
        content: content.slice(0, 200_000),
        citationCount: 0,
        monitorRank:
          Number.isInteger(monitorRank) && monitorRank > 0
            ? monitorRank
            : undefined,
        screenshotUrl: String(row[screenshotIndex] || "")
          .trim()
          .slice(0, 2_048),
        citations: [],
      });
    });
  }
  const answerById = new Map<
    string,
    DashboardPayload["monitoringAnswers"][number]
  >();
  for (const answer of answers) {
    if (answerById.has(answer.id)) {
      throw new Error(`答案明细存在重复的答案 ID：${answer.id}`);
    }
    answerById.set(answer.id, answer);
  }
  const citationIds = new Set<string>();
  for (const source of input.sources) {
    const rows = source.rows
      .map(trimTabularRow)
      .filter((row) => row.some(Boolean));
    const headerIndex = rows.findIndex((row) => {
      const headers = new Set(row.map(normalizedTabularHeader));
      const hasQuestion =
        headers.has("监控问题") ||
        headers.has("问题") ||
        headers.has("问题原文") ||
        headers.has("问题id");
      return (
        hasQuestion &&
        (headers.has("文章标题") || headers.has("引用内容")) &&
        (headers.has("文章链接") || headers.has("文章url"))
      );
    });
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex]!.map(normalizedTabularHeader);
    const citationIdIndex = columnIndex(
      headers,
      "引用ID",
      "citation_id",
      "citationId",
    );
    const answerIdIndex = columnIndex(
      headers,
      "答案ID",
      "answer_id",
      "answerId",
      "样本ID",
    );
    const questionIdIndex = columnIndex(
      headers,
      "问题ID",
      "question_id",
      "questionId",
    );
    const modelIndex = columnIndex(headers, "模型", "AI模型", "平台");
    const questionIndex = columnIndex(headers, "问题原文", "监控问题", "问题");
    const titleIndex = columnIndex(headers, "文章标题", "引用内容", "标题");
    const urlIndex = columnIndex(headers, "文章链接", "文章URL", "链接", "URL");
    const mediaIndex = columnIndex(headers, "媒体名称", "媒体信源", "媒体");
    const dateIndex = columnIndex(headers, "引用日期", "日期", "采集日期");
    const requiresExactLinkage =
      structuredAnswerSheetsPresent &&
      (citationIdIndex >= 0 || answerIdIndex >= 0);
    rows.slice(headerIndex + 1).forEach((row, rowIndex) => {
      const sourceRow = `${source.title} 第 ${headerIndex + rowIndex + 2} 行`;
      const answerId = String(row[answerIdIndex] || "").trim();
      const title = String(row[titleIndex] || "").trim();
      const url = String(row[urlIndex] || "").trim();
      if (!answerId && !title && !url) return;
      if (!title && !url) return;
      const providedCitationId = String(row[citationIdIndex] || "").trim();
      if (requiresExactLinkage && !providedCitationId) {
        throw new Error(`${sourceRow}缺少引用 ID`);
      }
      if (providedCitationId.length > 191) {
        throw new Error(`${sourceRow}的引用 ID 超过 191 个字符`);
      }
      if (requiresExactLinkage && !answerId) {
        throw new Error(`${sourceRow}缺少答案 ID`);
      }
      if (providedCitationId && citationIds.has(providedCitationId)) {
        throw new Error(`${sourceRow}存在重复的引用 ID：${providedCitationId}`);
      }
      const linkedAnswer = answerId ? answerById.get(answerId) : undefined;
      if (answerId && !linkedAnswer) {
        throw new Error(`${sourceRow}引用了不存在的答案 ID：${answerId}`);
      }
      const rawQuestionId = String(row[questionIdIndex] || "");
      const rawQuestion = String(row[questionIndex] || "");
      if (requiresExactLinkage && !rawQuestionId.trim()) {
        throw new Error(`${sourceRow}缺少问题 ID`);
      }
      const questionId =
        linkedAnswer && !rawQuestionId.trim() && !rawQuestion.trim()
          ? linkedAnswer.questionId
          : resolveQuestionId({
              id: rawQuestionId,
              text: rawQuestion,
              source: sourceRow,
            });
      if (linkedAnswer && linkedAnswer.questionId !== questionId) {
        throw new Error(`${sourceRow}的答案 ID 与问题不一致`);
      }
      const media = String(row[mediaIndex] || "").trim();
      const date = String(row[dateIndex] || "").trim();
      if (linkedAnswer) {
        if (!title) throw new Error(`${sourceRow}缺少文章标题`);
        const linkedUrl = requireImportUrl(url, sourceRow);
        if (!media) throw new Error(`${sourceRow}缺少媒体名称`);
        requireImportDate(date, sourceRow);
        const citationModel = String(row[modelIndex] || "").trim();
        if (
          citationModel &&
          monitoringModelKey(citationModel) !==
            monitoringModelKey(linkedAnswer.platform)
        ) {
          throw new Error(`${sourceRow}的模型与答案 ID 不一致`);
        }
        citationIds.add(providedCitationId);
        linkedAnswer.citations.push({
          id: providedCitationId,
          title: title.slice(0, 1_000),
          url: linkedUrl.slice(0, 2_048),
          media: media.slice(0, 255),
          publishedAt: date.slice(0, 64),
        });
        linkedAnswer.citationCount = linkedAnswer.citations.length;
        return;
      }
      const model = String(row[modelIndex] || "").trim();
      if (date) requireImportDate(date, sourceRow);
      const digest = createHash("sha1")
        .update(
          [
            source.title,
            rowIndex,
            model,
            questionId,
            title,
            url,
            media,
            date,
          ].join("\u001f"),
        )
        .digest("hex");
      const citationId = (providedCitationId || `citation-${digest}`).slice(
        0,
        191,
      );
      if (citationIds.has(citationId)) {
        throw new Error(`${sourceRow}存在重复的引用 ID：${citationId}`);
      }
      citationIds.add(citationId);
      citations.push({
        id: citationId,
        questionId,
        model: (model || "未标注模型").slice(0, 128),
        question: questionById.get(questionId)?.question || "",
        title: title.slice(0, 1_000),
        url: url.slice(0, 2_048),
        media: media.slice(0, 255),
        domain: sourceDomain(url),
        date: date.slice(0, 64),
      });
    });
  }
  if (answers.length === 0 && citations.length === 0) return null;
  return {
    ...input.existing,
    monitoringAnswers: answers,
    citations,
  } satisfies DashboardPayload;
}

function responseLogicPublishValue(
  value: unknown,
  draft: {
    concern: string;
    conclusion: string;
    facts: string;
    boundaries: string;
    references: string;
  },
) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  if (["true", "1", "yes", "是", "确认", "发布"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "否", "草稿"].includes(normalized)) {
    return false;
  }
  return [
    draft.concern,
    draft.conclusion,
    draft.facts,
    draft.boundaries,
    draft.references,
  ].every((item) => item.trim().length > 0);
}

function responseLogicImages(value: unknown) {
  if (Array.isArray(value)) return value;
  const normalized = String(value ?? "").trim();
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("应答逻辑图片字段必须是 JSON 数组");
  }
}

export type VersionedResponseLogicImport = SaveResponseLogicInput & {
  expectedRevision: number;
};

function responseLogicExpectedRevision(raw: Record<string, unknown>) {
  const value =
    raw.version ??
    raw.revision ??
    raw.recordRevision ??
    raw.record_revision ??
    raw["版本"] ??
    raw["记录版本"] ??
    raw["修订号"];
  const normalized =
    typeof value === "number" ? value : String(value ?? "").trim();
  const revision = normalized === "" ? Number.NaN : Number(normalized);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new DashboardTemplateRevisionError(
      "应答逻辑记录缺少有效的 version；请下载当前内容模板后编辑，不要沿用旧模板。",
    );
  }
  return revision;
}

function authoritativeResponseLogicInput(input: {
  raw: Record<string, unknown>;
  existing: DashboardPayload;
}): VersionedResponseLogicImport {
  const requestedQuestionId = String(
    input.raw.questionId ?? input.raw.question_id ?? input.raw["问题ID"] ?? "",
  ).trim();
  const requestedQuestion = String(
    input.raw.question ?? input.raw["问题"] ?? "",
  ).trim();
  const question =
    input.existing.questions.find(
      (candidate) => candidate.id === requestedQuestionId,
    ) ||
    input.existing.questions.find(
      (candidate) => candidate.question === requestedQuestion,
    );
  if (!question) {
    throw new Error(
      requestedQuestionId || requestedQuestion
        ? `应答逻辑未匹配到问题目录：${requestedQuestionId || requestedQuestion}`
        : "应答逻辑缺少问题 ID 或问题原文",
    );
  }
  const rawDraft =
    input.raw.draft &&
    typeof input.raw.draft === "object" &&
    !Array.isArray(input.raw.draft)
      ? (input.raw.draft as Record<string, unknown>)
      : input.raw;
  const draft = responseLogicDraftSchema.parse({
    concern: String(rawDraft.concern ?? rawDraft["用户真正关心"] ?? ""),
    conclusion: String(
      rawDraft.conclusion ??
        rawDraft["核心结论"] ??
        rawDraft["核心结论/执行口径"] ??
        "",
    ),
    facts: String(
      rawDraft.facts ??
        rawDraft["企业材料"] ??
        rawDraft["企业材料/官方依据"] ??
        "",
    ),
    pending: String(rawDraft.pending ?? rawDraft["企业待确认"] ?? ""),
    boundaries: String(rawDraft.boundaries ?? rawDraft["表达边界"] ?? ""),
    references: String(rawDraft.references ?? rawDraft["参考资料"] ?? ""),
    images: responseLogicImages(rawDraft.images ?? rawDraft["图片"]),
    // Manual imports cannot assert ownership of upstream file IDs.
    attachments: [],
  });
  return {
    ...saveResponseLogicSchema.parse({
      questionId: question.id,
      groupId: question.groupId,
      groupTitle: question.groupTitle,
      question: question.question,
      intent: question.intent,
      summary: question.summary,
      draft,
      publish: responseLogicPublishValue(
        input.raw.publish ?? input.raw["发布"],
        draft,
      ),
    }),
    expectedRevision: responseLogicExpectedRevision(input.raw),
  };
}

function isEmptyResponseLogicPlaceholder(record: VersionedResponseLogicImport) {
  return (
    record.expectedRevision === 0 &&
    !record.publish &&
    [
      record.draft.concern,
      record.draft.conclusion,
      record.draft.facts,
      record.draft.pending,
      record.draft.boundaries,
      record.draft.references,
    ].every((value) => value.trim().length === 0) &&
    record.draft.images.length === 0
  );
}

export function responseLogicImportsFromTabularSources(input: {
  sources: TabularSource[];
  existing: DashboardPayload;
}): VersionedResponseLogicImport[] {
  const records: VersionedResponseLogicImport[] = [];
  for (const source of input.sources) {
    const rows = source.rows
      .map(trimTabularRow)
      .filter((row) => row.some(Boolean));
    if (rows.length < 2) continue;
    const headers = rows[0]!.map((header) => header.trim());
    const normalizedHeaders = headers.map(normalizedTabularHeader);
    const hasQuestion = normalizedHeaders.some((header) =>
      ["questionid", "question_id", "问题id", "问题"].includes(header),
    );
    if (!hasQuestion) continue;
    for (const row of rows.slice(1)) {
      const raw = Object.fromEntries(
        headers.map((header, index) => [header, row[index] ?? ""]),
      );
      const record = authoritativeResponseLogicInput({
        raw,
        existing: input.existing,
      });
      if (!isEmptyResponseLogicPlaceholder(record)) records.push(record);
    }
  }
  const questionIds = records.map((record) => record.questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    throw new Error("应答逻辑文件中同一问题出现了多次");
  }
  if (records.length === 0) {
    throw new Error("文件中没有可导入的应答逻辑记录");
  }
  return records;
}

async function responseLogicImportsFromFile(input: {
  buffer: Buffer;
  sourceFileName: string;
  existing: DashboardPayload;
}) {
  const extension = path.extname(input.sourceFileName).toLowerCase();
  if (extension === ".json") {
    const raw = JSON.parse(input.buffer.toString("utf8"));
    const source =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const records = Array.isArray(raw)
      ? raw
      : (source.responseLogic ?? source.records);
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error("应答逻辑 JSON 必须包含 responseLogic 数组");
    }
    const parsed = records
      .map((record) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw new Error("应答逻辑 JSON 记录格式无效");
        }
        return authoritativeResponseLogicInput({
          raw: record as Record<string, unknown>,
          existing: input.existing,
        });
      })
      .filter((record) => !isEmptyResponseLogicPlaceholder(record));
    if (parsed.length === 0) {
      throw new Error("文件中没有需要导入的应答逻辑记录");
    }
    const questionIds = parsed.map((record) => record.questionId);
    if (new Set(questionIds).size !== questionIds.length) {
      throw new Error("应答逻辑文件中同一问题出现了多次");
    }
    return parsed;
  }
  const sources =
    extension === ".xlsx"
      ? await workbookRows(input.buffer)
      : [
          {
            title: path.basename(input.sourceFileName, extension),
            rows: parseCsvRows(
              input.buffer.toString("utf8").replace(/^\uFEFF/, ""),
            ),
          },
        ];
  return responseLogicImportsFromTabularSources({
    sources,
    existing: input.existing,
  });
}

async function tabularTablesFromFile(input: {
  buffer: Buffer;
  sourceFileName: string;
}) {
  const extension = path.extname(input.sourceFileName).toLowerCase();
  const sources =
    extension === ".xlsx"
      ? await workbookRows(input.buffer)
      : [
          {
            title:
              path.basename(
                input.sourceFileName,
                path.extname(input.sourceFileName),
              ) || "数据表格",
            rows: parseCsvRows(
              input.buffer.toString("utf8").replace(/^\uFEFF/, ""),
            ),
          },
        ];
  return sources
    .map((source, index) =>
      normalizeTableRows(source.rows, source.title, index),
    )
    .filter((table): table is NonNullable<typeof table> => Boolean(table));
}

async function dashboardPayloadFromFile(input: {
  buffer: Buffer;
  sourceFileName: string;
  existing: DashboardPayload;
  module: Exclude<DashboardImportModule, "section-table" | "response-logic">;
  currentRevision: number;
}) {
  const extension = path.extname(input.sourceFileName).toLowerCase();
  if (extension === ".json") {
    return dashboardPayloadFromModuleJson({
      text: input.buffer.toString("utf8"),
      existing: input.existing,
      module: input.module,
      currentRevision: input.currentRevision,
    });
  }
  const sources =
    extension === ".xlsx"
      ? await workbookRows(input.buffer)
      : [
          {
            title: path.basename(input.sourceFileName, extension),
            rows: parseCsvRows(
              input.buffer.toString("utf8").replace(/^\uFEFF/, ""),
            ),
          },
        ];
  if (input.module === "monitoring") {
    const monitoringPayload = monitoringPayloadFromTabularSources({
      sources,
      existing: input.existing,
    });
    if (monitoringPayload) return monitoringPayload;
  }
  const rows = sources[0]?.rows ?? [];
  const parsed = dashboardFromCsv(
    csvTextFromRows(rows),
    input.existing.brandName,
  );
  return mergeDashboardModule({
    existing: input.existing,
    incoming: parsed,
    module: input.module,
  });
}

function validIsoDate(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function stableMonitoringBatchKey(input: {
  sourceHash?: string;
  monitoringContent: unknown;
}) {
  const digest =
    input.sourceHash?.toLowerCase().match(/^[a-f0-9]{64}$/)?.[0] ??
    createHash("sha256")
      .update(JSON.stringify(input.monitoringContent))
      .digest("hex");
  return `dashboard-import:sha256:${digest}`;
}

function embeddedCitationSourceId(input: {
  answerId: string;
  index: number;
  title: string;
  url: string;
  media: string;
}) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.answerId,
        input.index,
        input.title,
        input.url,
        input.media,
      ]),
    )
    .digest("hex")
    .slice(0, 40);
  return `embedded-citation:${digest}`;
}

function assertUniqueSourceRecordIds(
  rows: ReadonlyArray<{ sourceRecordId: string }>,
  label: string,
) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.sourceRecordId)) {
      throw new Error(`${label}存在重复的记录 ID：${row.sourceRecordId}`);
    }
    seen.add(row.sourceRecordId);
  }
}

/**
 * Converts the dashboard import-only monitoring fields to the normalized
 * monitoring contract. Question text in imported citations is never trusted as
 * a new question: it may only resolve exactly to a question in this payload.
 */
export function buildDashboardMonitoringImport(input: {
  targetUserId: number;
  payload: DashboardPayload;
  sourceFileName: string;
  sourceHash?: string;
  now?: Date;
}): ReplaceMonitoringBatchInput | null {
  const { payload } = input;
  if (
    payload.monitoringAnswers.length === 0 &&
    payload.citations.length === 0
  ) {
    return null;
  }

  const questionById = new Map<string, (typeof payload.questions)[number]>();
  const questionIdsByText = new Map<string, string[]>();
  for (const question of payload.questions) {
    if (questionById.has(question.id)) {
      throw new Error(`问题目录存在重复 ID：${question.id}`);
    }
    questionById.set(question.id, question);
    const ids = questionIdsByText.get(question.question) ?? [];
    ids.push(question.id);
    questionIdsByText.set(question.question, ids);
  }

  const requireQuestionId = (questionId: string) => {
    if (!questionById.has(questionId)) {
      throw new Error(`监控记录引用了未配置的问题：${questionId || "（空）"}`);
    }
    return questionId;
  };
  const resolveCitationQuestionId = (
    citation: (typeof payload.citations)[number],
  ) => {
    if (citation.questionId) return requireQuestionId(citation.questionId);
    if (!citation.question) {
      throw new Error(
        `引用记录 ${citation.id} 缺少 questionId，且没有可用于精确匹配的问题文本`,
      );
    }
    const matches = questionIdsByText.get(citation.question) ?? [];
    if (matches.length === 0) {
      throw new Error(
        `引用记录 ${citation.id} 的问题文本无法在问题目录中精确匹配`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `引用记录 ${citation.id} 的问题文本匹配到多个问题，请明确填写 questionId`,
      );
    }
    return matches[0]!;
  };

  const validDates: string[] = [];
  const collectDate = (value: string | undefined) => {
    const normalized = validIsoDate(value);
    if (normalized) validDates.push(normalized);
    return normalized;
  };

  const samples: ReplaceMonitoringBatchInput["samples"] =
    payload.monitoringAnswers.map((answer) => ({
      sourceRecordId: answer.id,
      questionId: requireQuestionId(answer.questionId),
      platform: answer.platform,
      answerNo: answer.answerNo,
      content: answer.content,
      citationCount: answer.citationCount,
      monitorRank:
        answer.monitorRank === undefined
          ? undefined
          : Math.max(1, Math.trunc(answer.monitorRank)),
      screenshotUrl: answer.screenshotUrl,
      collectedAt: collectDate(answer.collectedAt),
    }));

  const citations: ReplaceMonitoringBatchInput["citations"] = [];
  for (const answer of payload.monitoringAnswers) {
    answer.citations.forEach((citation, index) => {
      citations.push({
        sourceRecordId:
          citation.id ||
          embeddedCitationSourceId({
            answerId: answer.id,
            index,
            title: citation.title,
            url: citation.url,
            media: citation.media,
          }),
        questionId: requireQuestionId(answer.questionId),
        sampleSourceRecordId: answer.id,
        model: answer.platform,
        title: citation.title,
        url: citation.url,
        media: citation.media,
        domain: "",
        publishedAt: citation.publishedAt,
        collectedAt: collectDate(answer.collectedAt),
      });
    });
  }
  for (const citation of payload.citations) {
    const normalizedDate = collectDate(citation.date);
    citations.push({
      sourceRecordId: citation.id,
      questionId: resolveCitationQuestionId(citation),
      model: citation.model || "未标注模型",
      title: citation.title,
      url: citation.url,
      media: citation.media,
      domain: citation.domain,
      publishedAt: normalizedDate,
      collectedAt: normalizedDate,
    });
  }

  assertUniqueSourceRecordIds(samples, "监控样本");
  assertUniqueSourceRecordIds(citations, "引用记录");

  const fallbackDate =
    input.now && Number.isFinite(input.now.getTime()) ? input.now : new Date();
  const collectedAt =
    validDates.length > 0
      ? validDates.reduce((latest, value) =>
          Date.parse(value) > Date.parse(latest) ? value : latest,
        )
      : fallbackDate.toISOString();
  const sourceName =
    input.sourceFileName.trim().slice(0, 512) || "dashboard.json";
  return replaceMonitoringBatchSchema.parse({
    userId: input.targetUserId,
    batchKey: stableMonitoringBatchKey({
      sourceHash: input.sourceHash,
      monitoringContent: { samples, citations },
    }),
    sourceName,
    collectedAt,
    samples,
    citations,
  });
}

export type MonitoringImportPreviewIssue = {
  severity: "warning" | "error";
  code: string;
  message: string;
};

export type MonitoringImportAvailableBatch = {
  batchKey: string;
  sourceName: string;
  collectedAt: number;
  revision: number;
  sampleCount: number;
  citationCount: number;
};

export type MonitoringImportPreview = {
  module: "monitoring";
  mode: "answer-linked" | "answer-only" | "question-only" | "mixed" | "invalid";
  sourceName: string;
  fileHash: string;
  templateRevision: number;
  summary: string[];
  targetBatchRequired: boolean;
  availableBatches: MonitoringImportAvailableBatch[];
  suggestedBatchKey?: string;
  questions: Array<{ id: string; label: string }>;
  models: Array<{ key: string; label: string }>;
  dates: string[];
  sampleCount: number;
  citationCount: number;
  exactLinked: number;
  issues: MonitoringImportPreviewIssue[];
};

export function monitoringImportFileHash(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Pure, side-effect-free projection used by the import preview endpoint. */
export function buildMonitoringImportPreview(input: {
  payload: DashboardPayload;
  batch: ReplaceMonitoringBatchInput;
  sourceName: string;
  fileHash: string;
  templateRevision?: number;
  availableBatches?: MonitoringImportAvailableBatch[];
}): MonitoringImportPreview {
  const { batch } = input;
  const exactLinked = batch.citations.filter(
    (citation) => citation.sampleSourceRecordId,
  ).length;
  const standaloneCitationCount = batch.citations.length - exactLinked;
  const targetBatchRequired =
    batch.samples.length === 0 && standaloneCitationCount > 0;
  const mode =
    batch.samples.length === 0
      ? "question-only"
      : exactLinked > 0 && standaloneCitationCount > 0
        ? "mixed"
        : exactLinked > 0
          ? "answer-linked"
          : "answer-only";
  const questionLabelById = new Map(
    input.payload.questions.map((question) => [question.id, question.question]),
  );
  const questionIds = [
    ...new Set([
      ...batch.samples.map((sample) => sample.questionId),
      ...batch.citations.map((citation) => citation.questionId),
    ]),
  ];
  const modelByKey = new Map<string, { key: string; label: string }>();
  for (const label of [
    ...batch.samples.map((sample) => sample.platform),
    ...batch.citations.map((citation) => citation.model),
  ]) {
    const key = monitoringModelKey(label);
    if (!modelByKey.has(key)) modelByKey.set(key, { key, label });
  }
  const dates = [
    ...new Set(
      [
        batch.collectedAt,
        ...batch.samples.map((sample) => sample.collectedAt),
        ...batch.citations.flatMap((citation) => [
          citation.collectedAt,
          citation.publishedAt,
        ]),
      ]
        .filter((value): value is string => Boolean(value))
        .map(monitoringBeijingDate)
        .filter(Boolean),
    ),
  ].sort((left, right) => right.localeCompare(left));
  const availableBatches = input.availableBatches ?? [];
  const issues: MonitoringImportPreviewIssue[] = [];
  if (targetBatchRequired) {
    issues.push({
      severity: "warning",
      code: "MONITORING_TARGET_BATCH_REQUIRED",
      message:
        "该文件只有问题级引用，没有答案明细。正式导入前请选择一个包含答案的目标批次；系统不会按标题或问题文本将引用模糊绑定到答案。",
    });
  }
  if (batch.samples.length > 0 && exactLinked === 0) {
    issues.push({
      severity: "warning",
      code: "MONITORING_SAMPLE_CITATIONS_MISSING",
      message:
        "已识别答案明细，但没有引用通过答案 ID 精确关联；逐答案信源将显示为空。",
    });
  }
  return {
    module: "monitoring",
    mode,
    sourceName: input.sourceName,
    fileHash: input.fileHash,
    templateRevision: input.templateRevision ?? 0,
    summary: [
      `答案记录 ${batch.samples.length} 条，引用记录 ${batch.citations.length} 条。`,
      exactLinked > 0
        ? `${exactLinked} 条引用已通过答案 ID 精确关联。`
        : "当前文件没有可验证的逐答案引用关联。",
    ],
    targetBatchRequired,
    availableBatches,
    suggestedBatchKey: targetBatchRequired
      ? availableBatches.find((batch) => batch.sampleCount > 0)?.batchKey
      : undefined,
    questions: questionIds.map((id) => ({
      id,
      label: questionLabelById.get(id) || id,
    })),
    models: [...modelByKey.values()],
    dates,
    sampleCount: batch.samples.length,
    citationCount: batch.citations.length,
    exactLinked,
    issues,
  };
}

export async function importDashboardPayload(input: {
  actor: AuthenticatedUser;
  targetUserId: number;
  payload: DashboardPayload;
  sourceFileName: string;
  bindEnterpriseIdentity?: boolean;
  expectedRevision?: number;
  progressReportPeriods?: Array<{
    contractId: string;
    quotaPeriodId: string;
  }>;
  beforeWrite?: DashboardWorkspaceWriteHook;
  afterWrite?: DashboardWorkspaceWriteHook;
  now?: Date;
  dependencies?: {
    updateWorkspace: typeof updateDashboardWorkspace;
    replaceMonitoring: typeof replaceMonitoringBatch;
  };
}) {
  const dependencies = input.dependencies ?? {
    updateWorkspace: updateDashboardWorkspace,
    replaceMonitoring: replaceMonitoringBatch,
  };
  const monitoringBatch = buildDashboardMonitoringImport({
    targetUserId: input.targetUserId,
    payload: input.payload,
    sourceFileName: input.sourceFileName,
    now: input.now,
  });
  const storedPayload: DashboardPayload = {
    ...input.payload,
    monitoringAnswers: [],
    citations: [],
  };
  const dashboard = await dependencies.updateWorkspace({
    userId: input.targetUserId,
    actorUserId: input.actor.id,
    payload: storedPayload,
    sourceName: input.sourceFileName,
    bindEnterpriseIdentity: input.bindEnterpriseIdentity,
    expectedRevision: input.expectedRevision,
    progressReportPeriods: input.progressReportPeriods,
    beforeWrite: input.beforeWrite,
    afterWrite: input.afterWrite,
  });
  if (monitoringBatch) {
    await dependencies.replaceMonitoring({
      actor: input.actor,
      value: monitoringBatch,
    });
  }
  return dashboard;
}

type AtomicDashboardImportModule = Exclude<
  DashboardAdminImportModule,
  "questions" | "monitoring" | "response-logic"
>;

export function dashboardImportTransactionHooks(input: {
  actor: AuthenticatedUser;
  targetUserId: number;
  module: AtomicDashboardImportModule;
  expectedRevision: number;
  fileHash: string;
  preflightToken: string | undefined;
  sourceFileName: string;
  sectionId?: string;
}) {
  const sectionTable = input.module === "section-table";
  return {
    beforeWrite: async (tx: any) => {
      await consumeDashboardImportPreflight({
        token: input.preflightToken,
        binding: {
          actorId: input.actor.id,
          workspaceUserId: input.targetUserId,
          module: input.module,
          revision: input.expectedRevision,
          fileHash: input.fileHash,
          ...(input.sectionId ? { sectionId: input.sectionId } : {}),
        },
        store: dashboardImportPreflightStoreForExecutor(tx),
      });
    },
    afterWrite: async (
      tx: any,
      writeContext: Parameters<DashboardWorkspaceWriteHook>[1],
    ) => {
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: sectionTable
            ? "workspace.dashboard.section_table_imported"
            : "workspace.dashboard.module_imported",
          targetType: "dashboard",
          targetId: input.targetUserId,
          workspaceUserId: input.targetUserId,
          metadata: {
            sourceName: input.sourceFileName,
            ...(sectionTable
              ? { sectionId: input.sectionId }
              : { module: input.module }),
            expectedRevision: input.expectedRevision,
            revision: writeContext.nextRevision,
          },
        },
        tx,
      );
    },
  };
}

export async function readKnowledgeArchive(
  buffer: Buffer,
  sourceFileName: string,
  snapshotId: string,
  options: {
    validationProfile?: KnowledgeBaseValidationProfile;
    archiveContractVersion?: 1 | 2 | 3 | 4;
    archiveContractVersions?: readonly (1 | 2 | 3 | 4)[];
  } = {},
) {
  const validationProfile = options.validationProfile ?? "historical";
  const extension = path.extname(sourceFileName).toLowerCase();
  if (extension !== ".zip") {
    if (validationProfile !== "historical") {
      throw new KnowledgeArchiveValidationError(
        "structure",
        "新版知识库必须交付 ZIP 归档",
      );
    }
    if (!textExtensions.has(extension)) {
      throw new Error("知识库文件仅支持 ZIP、Markdown、TXT、JSON 或 CSV");
    }
    return {
      documents: [
        {
          path: safeArchivePath(sourceFileName),
          title: titleFromPath(sourceFileName),
          content: normalizeTextDocument(
            sourceFileName,
            buffer.toString("utf8"),
          ),
        },
      ] as KnowledgeDocument[],
      assets: [] as KnowledgeAsset[],
      storedAssetKeys: [] as string[],
    };
  }

  if (
    buffer.length < 4 ||
    (buffer.subarray(0, 4).toString("binary") !== "PK\u0003\u0004" &&
      buffer.subarray(0, 4).toString("binary") !== "PK\u0005\u0006" &&
      buffer.subarray(0, 4).toString("binary") !== "PK\u0007\u0008")
  ) {
    const error = new Error("知识库文件不是有效的 ZIP 压缩包");
    if (validationProfile !== "historical") {
      throw new KnowledgeArchiveValidationError("unsafe", error.message);
    }
    throw error;
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch (error) {
    if (validationProfile !== "historical") {
      throw new KnowledgeArchiveValidationError(
        "unsafe",
        error instanceof Error ? error.message : "知识库 ZIP 无法安全解压",
      );
    }
    throw error;
  }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    const message = `知识库压缩包文件过多，最多支持 ${MAX_ARCHIVE_ENTRIES} 个文件`;
    if (validationProfile !== "historical") {
      throw new KnowledgeArchiveValidationError("unsafe", message);
    }
    throw new Error(message);
  }
  const documents: KnowledgeDocument[] = [];
  const assets: KnowledgeAsset[] = [];
  const storedAssetKeys: string[] = [];
  const rawTextByArchivePath = new Map<string, string>();
  let unpackedBytes = 0;
  let declaredUnpackedBytes = 0;
  await mkdir(storageRoot, { recursive: true });

  try {
    const normalizedPaths = new Set<string>();
    const packagePaths: string[] = [];
    for (const entry of entries) {
      const rawPath =
        (entry as typeof entry & { unsafeOriginalName?: string })
          .unsafeOriginalName || entry.name;
      if (
        rawPath.startsWith("__MACOSX/") ||
        rawPath === ".DS_Store" ||
        rawPath.endsWith("/.DS_Store")
      ) {
        continue;
      }
      const archivePath = validateArchiveEntryPath(rawPath);
      const normalizedKey = archivePath.normalize("NFKC").toLowerCase();
      if (normalizedPaths.has(normalizedKey)) {
        throw new Error(`知识库 ZIP 包含重复文件：${archivePath}`);
      }
      normalizedPaths.add(normalizedKey);
      packagePaths.push(archivePath);
      const fileExtension = path.extname(archivePath).toLowerCase();
      if (
        validationProfile !== "historical" &&
        [".bmp", ".heic", ".heif", ".ico", ".svg", ".tif", ".tiff"].includes(
          fileExtension,
        )
      ) {
        throw new KnowledgeArchiveValidationError(
          "media",
          `知识库图片必须转为 AVIF、WebP、PNG、JPEG 或 GIF：${archivePath}`,
        );
      }
      if (
        validationProfile !== "historical" &&
        !versionedArchiveAllowedExtensions.has(fileExtension)
      ) {
        throw new KnowledgeArchiveValidationError(
          executableArchiveExtensions.has(fileExtension)
            ? "unsafe"
            : "structure",
          `新版知识库 ZIP 包含不支持的文件类型：${archivePath}`,
        );
      }
      if (fileExtension === ".html" || fileExtension === ".htm") {
        throw new Error("知识库 ZIP 不允许包含 HTML 或交互式网页文件");
      }
      const unixPermissions =
        typeof entry.unixPermissions === "number"
          ? entry.unixPermissions
          : Number.parseInt(String(entry.unixPermissions || ""), 8);
      if (
        Number.isFinite(unixPermissions) &&
        (unixPermissions & 0o170000) === 0o120000
      ) {
        throw new Error("知识库 ZIP 不允许包含符号链接");
      }
      const declaredCompressed = Number(
        (
          entry as typeof entry & {
            _data?: { compressedSize?: number; uncompressedSize?: number };
          }
        )._data?.compressedSize || 0,
      );
      const declaredUncompressed = Number(
        (
          entry as typeof entry & {
            _data?: { compressedSize?: number; uncompressedSize?: number };
          }
        )._data?.uncompressedSize || 0,
      );
      const declaredLimit = imageMimeByExtension[fileExtension]
        ? MAX_IMAGE_BYTES
        : MAX_DOCUMENT_BYTES;
      if (declaredUncompressed > declaredLimit) {
        throw new Error(`知识库文件过大：${archivePath}`);
      }
      declaredUnpackedBytes += Math.max(0, declaredUncompressed);
      if (declaredUnpackedBytes > MAX_UNPACKED_BYTES) {
        throw new Error("知识库解压后内容过大，最多支持 220 MB");
      }
      if (
        declaredUncompressed > 1024 * 1024 &&
        declaredCompressed > 0 &&
        declaredUncompressed / declaredCompressed > MAX_COMPRESSION_RATIO
      ) {
        throw new Error(`知识库 ZIP 中的文件压缩比异常：${archivePath}`);
      }
      const mimeType = imageMimeByExtension[fileExtension];
      if (!textExtensions.has(fileExtension) && !mimeType) continue;
      const bytes = await entry.async("nodebuffer");
      unpackedBytes += bytes.length;
      if (unpackedBytes > MAX_UNPACKED_BYTES) {
        throw new Error("知识库解压后内容过大，最多支持 220 MB");
      }
      if (mimeType) {
        if (bytes.length > MAX_IMAGE_BYTES) {
          throw new Error(`知识库图片过大：${archivePath}`);
        }
        const dimensions =
          validationProfile === "historical"
            ? basicRasterImageDimensions(fileExtension, bytes)
            : await decodedRasterImageDimensions(fileExtension, bytes);
        const imageIsValid =
          validationProfile === "historical"
            ? hasSupportedImageSignature(fileExtension, bytes)
            : Boolean(dimensions);
        if (!imageIsValid) {
          throw new Error(`知识库图片格式与内容不匹配：${archivePath}`);
        }
        const key = `${randomUUID()}${fileExtension}`;
        await writeFile(path.join(storageRoot, key), bytes, { flag: "wx" });
        storedAssetKeys.push(key);
        assets.push({
          key,
          path: archivePath,
          mimeType,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ...dimensions,
        });
      } else {
        if (bytes.length > MAX_DOCUMENT_BYTES) {
          throw new Error(`知识库文档过大：${archivePath}`);
        }
        const rawText = bytes.toString("utf8").replace(/^\uFEFF/, "");
        rawTextByArchivePath.set(archivePath, rawText);
        documents.push({
          path: archivePath,
          title: titleFromPath(archivePath),
          content: normalizeTextDocument(archivePath, rawText),
        });
      }
    }

    const roots = new Set(
      packagePaths.map((entryPath) => entryPath.split("/")[0]),
    );
    if (
      roots.size !== 1 ||
      packagePaths.some((entryPath) => !entryPath.includes("/"))
    ) {
      throw new Error("知识库 ZIP 必须只包含一个企业知识库根目录");
    }
    const root = [...roots][0]!;
    const lowerPaths = new Set(
      packagePaths.map((entryPath) => entryPath.toLowerCase()),
    );
    const missingRequired = requiredKnowledgeFiles.filter(
      (requiredPath) =>
        !lowerPaths.has(`${root}/${requiredPath}`.toLowerCase()),
    );
    if (missingRequired.length > 0) {
      throw new Error(`知识库 ZIP 缺少标准文件：${missingRequired.join("、")}`);
    }
    if (validationProfile !== "historical") {
      for (const requiredPath of [packageManifestPath, completenessPath]) {
        if (!lowerPaths.has(`${root}/${requiredPath}`.toLowerCase())) {
          throw new KnowledgeArchiveValidationError(
            "structure",
            `知识库 ZIP 缺少 ${requiredPath}`,
          );
        }
      }
    }
    if (documents.length === 0) {
      throw new Error("压缩包中没有可展示的 Markdown、TXT、JSON 或 CSV 文档");
    }
    const rawTextByRelativePath = new Map(
      [...rawTextByArchivePath.entries()].map(([archivePath, rawText]) => [
        archivePath.slice(root.length + 1),
        rawText,
      ]),
    );
    const validated =
      validationProfile === "historical"
        ? { documents, assets }
        : validateProfilePackage({
            profile: validationProfile,
            archiveContractVersion: options.archiveContractVersion,
            archiveContractVersions: options.archiveContractVersions,
            packagePaths,
            unpackedBytes,
            rawTextByRelativePath,
            documents,
            assets,
          });
    const linkedDocuments = validated.documents.map((document) => {
      let content = document.content;
      validated.assets.forEach((asset, index) => {
        const url = asset.id
          ? `/api/dashboard/knowledge/assets/${snapshotId}/by-id/${encodeURIComponent(asset.id)}`
          : `/api/dashboard/knowledge/assets/${snapshotId}/${index}`;
        const relativePath = path.posix.relative(
          path.posix.dirname(document.path),
          asset.path,
        );
        const candidates = [
          asset.path,
          encodeURI(asset.path),
          relativePath,
          encodeURI(relativePath),
          path.basename(asset.path),
        ];
        for (const candidate of candidates) {
          content = content.replaceAll(`(${candidate})`, `(${url})`);
          content = content.replaceAll(`(./${candidate})`, `(${url})`);
        }
      });
      return { ...document, content };
    });
    const packageBuildRevision =
      "manifest" in validated ? validated.manifest.buildRevision : undefined;
    const packageSchemaVersion =
      "manifest" in validated ? validated.manifest.schemaVersion : undefined;
    return {
      documents: linkedDocuments,
      assets: validated.assets,
      storedAssetKeys,
      validationProfile,
      packageBuildRevision,
      packageSchemaVersion,
      packageManifestSha256: rawTextByRelativePath.has(packageManifestPath)
        ? createHash("sha256")
            .update(
              Buffer.from(
                rawTextByRelativePath.get(packageManifestPath)!,
                "utf8",
              ),
            )
            .digest("hex")
        : undefined,
    };
  } catch (error) {
    await Promise.all(
      storedAssetKeys.map((key) =>
        unlink(path.join(storageRoot, key)).catch(() => undefined),
      ),
    );
    if (
      validationProfile !== "historical" &&
      !(error instanceof KnowledgeArchiveValidationError)
    ) {
      const message =
        error instanceof Error ? error.message : "知识库归档校验失败";
      throw new KnowledgeArchiveValidationError(
        classifyKnowledgeArchiveError(message),
        message,
      );
    }
    throw error;
  }
}

function assertKnowledgeArchiveDownloadIntegrity(input: {
  buffer: Buffer;
  expectedSha256: string;
  expectedBytes: number;
}) {
  const actualSha256 = createHash("sha256").update(input.buffer).digest("hex");
  if (
    !Number.isInteger(input.expectedBytes) ||
    input.expectedBytes <= 0 ||
    input.buffer.length !== input.expectedBytes ||
    !/^[a-f0-9]{64}$/iu.test(input.expectedSha256) ||
    actualSha256 !== input.expectedSha256.toLowerCase()
  ) {
    throw new KnowledgeArchiveValidationError(
      "unsafe",
      "知识库 ZIP 下载字节数或 SHA-256 与持久化版本不一致",
    );
  }
}

/**
 * A ZIP magic-byte/hash check alone does not prove an archive is safe to hand
 * to a customer. Re-run the production archive reader for every final ZIP
 * download, remove its temporary decoded assets, then re-check immutable byte
 * identity after parsing. Callers may add the build/node binding assertion but
 * must never replace the shared path/CRC/size/profile validation here.
 */
export async function validateKnowledgeArchiveForDownload(input: {
  buffer: Buffer;
  sourceFileName: string;
  expectedSha256: string;
  expectedBytes: number;
  validationProfile?: KnowledgeBaseValidationProfile;
  archiveContractVersions?: readonly (1 | 2 | 3 | 4)[];
  validateParsed?: (
    parsed: Awaited<ReturnType<typeof readKnowledgeArchive>>,
  ) => void | Promise<void>;
}) {
  assertKnowledgeArchiveDownloadIntegrity(input);
  let parsed: Awaited<ReturnType<typeof readKnowledgeArchive>>;
  try {
    parsed = await readKnowledgeArchive(
      input.buffer,
      input.sourceFileName,
      randomUUID(),
      {
        validationProfile: input.validationProfile,
        archiveContractVersions: input.archiveContractVersions,
      },
    );
  } catch (error) {
    if (error instanceof KnowledgeArchiveValidationError) throw error;
    const message =
      error instanceof Error ? error.message : "知识库 ZIP 下载复核失败";
    throw new KnowledgeArchiveValidationError(
      classifyKnowledgeArchiveError(message),
      message,
    );
  }
  try {
    await input.validateParsed?.(parsed);
  } finally {
    await removeStoredKnowledgeAssets(parsed.storedAssetKeys);
  }
  // Parsing and the caller's semantic validation must not substitute for the
  // exact durable byte contract used in Content-Length/ETag/download records.
  assertKnowledgeArchiveDownloadIntegrity(input);
}

function normalizedEnterpriseEvidence(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export function assertKnowledgeArchiveEnterpriseIdentity(input: {
  enterpriseIdentityConfirmed: boolean;
  brandName: string;
  documents: KnowledgeDocument[];
}) {
  const brandName = normalizedEnterpriseEvidence(input.brandName);
  if (!brandName) {
    throw new Error("请先由管理员配置当前账号的企业名称");
  }
  const identityDocuments = input.documents.filter((document) => {
    const basename = path.posix.basename(document.path).toLowerCase();
    return (
      basename === "readme.md" ||
      basename === "00_knowledge_tree.md" ||
      basename === "00_source_index.md"
    );
  });
  const candidates =
    identityDocuments.length > 0 ? identityDocuments : input.documents;
  const matches = candidates.some((document) =>
    normalizedEnterpriseEvidence(
      `${document.title}\n${document.content}`,
    ).includes(brandName),
  );
  if (!matches) {
    throw new Error(
      `知识库包未声明当前账号绑定企业“${input.brandName}”，请核对目标用户后重新上传`,
    );
  }
}

function upstreamHeaders(apiKey: string) {
  return {
    API_KEY: apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

export function dashboardKnowledgePublishErrorForLog(
  error: unknown,
  secrets: Iterable<unknown> = [],
) {
  return safeErrorForLog(error, { secrets });
}

export async function downloadArchiveBytes(input: {
  descriptor: KnowledgeArchiveDescriptor;
  apiKey: string;
  baseUrl: string;
}) {
  let filename = input.descriptor.filename;
  let downloadUrl: string | undefined;
  let headers: Record<string, string> | undefined;
  const fileId =
    input.descriptor.fileId ||
    (input.descriptor.url
      ? knowledgeArchiveFileIdFromUrl(input.descriptor.url)
      : undefined);

  if (fileId) {
    const stored = await readStoredPresalesFile(fileId);
    if (stored) {
      if (stored.sizeBytes > MAX_ARCHIVE_BYTES) {
        throw new Error("知识库 ZIP 超过 250 MB");
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const hash = createHash("sha256");
      for await (const rawChunk of stored.createReadStream()) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk);
        totalBytes += chunk.length;
        if (totalBytes > MAX_ARCHIVE_BYTES) {
          throw new Error("知识库 ZIP 超过 250 MB");
        }
        chunks.push(chunk);
        hash.update(chunk);
      }
      if (totalBytes === 0 || totalBytes !== stored.sizeBytes) {
        throw new Error("知识库 ZIP 本地持久副本不完整");
      }
      if (stored.sha256 && hash.digest("hex") !== stored.sha256) {
        throw new Error("知识库 ZIP 本地持久副本校验失败");
      }
      const buffer = Buffer.concat(chunks, totalBytes);
      filename = stored.filename || filename;
      if (!filename.toLowerCase().endsWith(".zip")) {
        filename = `${path.basename(filename, path.extname(filename)) || "knowledge-base"}.zip`;
      }
      return { buffer, filename };
    }
    downloadUrl = `${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`;
    headers = upstreamHeaders(input.apiKey);
  } else if (input.descriptor.url) {
    downloadUrl = assertSafeExternalUrl(input.descriptor.url);
  }

  if (!downloadUrl) throw new Error("知识库文件没有可验证的下载地址");
  const controller = new AbortController();
  let response = await axios.get(downloadUrl, {
    ...(headers
      ? { maxRedirects: 0, proxy: false as const }
      : safeExternalRequestOptions),
    headers,
    responseType: "stream",
    timeout: 120_000,
    maxContentLength: MAX_ARCHIVE_BYTES,
    signal: controller.signal,
    validateStatus: () => true,
  });
  if (
    headers &&
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.location
  ) {
    const redirectUrl = assertSafeExternalUrl(
      new URL(String(response.headers.location), downloadUrl).toString(),
    );
    response = await axios.get(redirectUrl, {
      ...safeExternalRequestOptions,
      responseType: "stream",
      timeout: 120_000,
      maxContentLength: MAX_ARCHIVE_BYTES,
      signal: controller.signal,
      validateStatus: () => true,
    });
  }
  if (response.status !== 200) {
    response.data?.destroy?.();
    throw new Error(`下载知识库 ZIP 失败 (${response.status})`);
  }
  const disposition = String(response.headers["content-disposition"] || "");
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plainFilename = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const responseFilename = encodedFilename || plainFilename;
  if (responseFilename) {
    try {
      filename = path.basename(decodeURIComponent(responseFilename.trim()));
    } catch {
      filename = path.basename(responseFilename.trim());
    }
  }
  const declaredLength = Number(response.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    response.data?.destroy?.();
    throw new Error("知识库 ZIP 超过 250 MB");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let lastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt >= 120_000) {
      controller.abort();
    }
  }, 10_000);
  watchdog.unref();
  try {
    for await (const rawChunk of response.data as AsyncIterable<
      Buffer | Uint8Array | string
    >) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_ARCHIVE_BYTES) {
        controller.abort();
        throw new Error("知识库 ZIP 超过 250 MB");
      }
      chunks.push(chunk);
      lastProgressAt = Date.now();
    }
  } finally {
    clearInterval(watchdog);
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  if (buffer.length === 0) throw new Error("知识库 ZIP 内容为空");
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error("知识库 ZIP 超过 250 MB");
  }
  if (!filename.toLowerCase().endsWith(".zip")) {
    filename = `${path.basename(filename, path.extname(filename)) || "knowledge-base"}.zip`;
  }
  return { buffer, filename };
}

function bodyBuffer(req: express.Request) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.alloc(0);
}

router.use(requireExpressAuth);

router.get(
  "/monitoring-template/:userId",
  async (req: FrontMindRequest, res) => {
    const targetUserId = Number(req.params.userId);
    try {
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new Error("用户 ID 无效");
      }
      const actor = req.frontmindUser!;
      const [workspace, batches] = await Promise.all([
        getDashboardWorkspace(targetUserId),
        getMonitoringCurrentTemplateBatches({
          actor,
          userId: targetUserId,
        }),
      ]);
      const template = dashboardMonitoringCurrentTemplateSchema.parse({
        ...createDashboardModuleTemplateMetadata({
          module: "monitoring",
          revision: workspace.revision,
        }),
        workspaceUserId: targetUserId,
        batches,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="frontmind-monitoring-current-${targetUserId}-R${workspace.revision}.json"`,
      );
      res.send(Buffer.from(JSON.stringify(template, null, 2), "utf8"));
    } catch (error) {
      res
        .status(
          error instanceof ServiceEntitlementError
            ? error.statusCode
            : error instanceof DashboardRevisionConflictError
              ? 409
              : 400,
        )
        .json({
          error: {
            code: "MONITORING_TEMPLATE_DOWNLOAD_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "问题监控当前内容模板下载失败",
          },
        });
    }
  },
);

router.put(
  "/report-assets/:userId",
  express.raw({ type: "application/octet-stream", limit: "12mb" }),
  async (req: FrontMindRequest, res) => {
    const actor = req.frontmindUser!;
    const targetUserId = Number(req.params.userId);
    try {
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new Error("用户 ID 无效");
      }
      await assertRoleScopedWorkspaceExecution({
        req,
        targetUserId,
        expectedRoleType: "monitoring_optimization_engineer",
      });
      const bytes = bodyBuffer(req);
      if (bytes.length === 0) throw new Error("答案截图文件为空");
      const filename = decodeHeader(
        req.header("x-file-name"),
        "answer-screenshot",
      );
      const { extension, mimeType } = validateProgressReportScreenshot({
        filename,
        bytes,
      });
      const assetName = `${randomUUID()}${extension}`;
      const relativeKey = path.join(
        "progress-report-screenshots",
        String(targetUserId),
        assetName,
      );
      const absolutePath = path.join(storageRoot, relativeKey);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, bytes, { flag: "wx" });
      const url = `/api/dashboard/report-assets/${targetUserId}/${assetName}`;
      await writeWorkspaceAuditEvent({
        actor,
        action: "workspace.progress_report.screenshot_uploaded",
        targetType: "dashboard",
        targetId: targetUserId,
        workspaceUserId: targetUserId,
        metadata: {
          filename,
          mimeType,
          byteLength: bytes.length,
          assetName,
        },
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ id: assetName, url, filename, mimeType });
    } catch (error) {
      console.error("[Dashboard] Report screenshot upload failed", error);
      res.status(400).json({
        error: {
          code: "REPORT_SCREENSHOT_UPLOAD_FAILED",
          message: error instanceof Error ? error.message : "答案截图上传失败",
        },
      });
    }
  },
);

router.get(
  "/report-assets/:userId/:assetName",
  async (req: FrontMindRequest, res) => {
    const targetUserId = Number(req.params.userId);
    const assetName = String(req.params.assetName || "");
    try {
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new Error("资源不存在");
      }
      if (
        !/^[0-9a-f-]{36}\.(?:png|jpe?g|webp)$/i.test(assetName) ||
        assetName.includes("..")
      ) {
        throw new Error("资源不存在");
      }
      await assertWorkspaceAccess(req.frontmindUser!, targetUserId);
      const extension = path.extname(assetName).toLowerCase();
      const mimeType = imageMimeByExtension[extension];
      if (!mimeType) throw new Error("资源不存在");
      const bytes = await readFile(
        path.join(
          storageRoot,
          "progress-report-screenshots",
          String(targetUserId),
          assetName,
        ),
      );
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Disposition", "inline");
      res.send(bytes);
    } catch {
      res
        .status(404)
        .json({ error: { message: "资源不存在", code: "NOT_FOUND" } });
    }
  },
);

router.post("/knowledge/publish", async (req: FrontMindRequest, res) => {
  const actor = req.frontmindUser!;
  const body = (req.body || {}) as {
    conversationId?: string;
    userId?: number;
  };
  const targetUserId =
    body.userId === undefined ? actor.id : Number(body.userId);
  const conversationId = String(body.conversationId || "").trim();
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    res.status(400).json({
      error: { message: "用户 ID 无效", code: "BAD_REQUEST" },
    });
    return;
  }
  if (!conversationId) {
    res.status(400).json({
      error: { message: "缺少知识库对话标识", code: "BAD_REQUEST" },
    });
    return;
  }

  let storedAssetKeys: string[] = [];
  let snapshotCommitted = false;
  let storedArchive: { userId: number; snapshotId: string } | undefined;
  const publishLogSecrets: unknown[] = [req.frontmindCredential?.apiKey];
  try {
    await assertRoleScopedWorkspaceExecution({
      req,
      targetUserId,
      expectedRoleType: "ai_operations_engineer",
      allowCustomerSelf: true,
    });
    await assertServiceCapability(targetUserId, "knowledgeBuild");
    await assertKnowledgeBaseWritable(targetUserId);
    const build = await assertKnowledgeBasePublishable({
      userId: targetUserId,
      conversationId,
    });
    if (build.status === "published" && build.publishedSnapshotId) {
      const snapshot = await getKnowledgeSnapshotById({
        userId: targetUserId,
        snapshotId: build.publishedSnapshotId,
      });
      if (!snapshot) {
        throw new Error("已发布知识库记录不完整，请联系管理员");
      }
      res.json({ kind: "knowledge", snapshot, idempotent: true });
      return;
    }
    const taskId = String(build.packageTaskId || build.upstreamTaskId || "");
    const hasDurablePackage = Boolean(
      build.packageStorageKey &&
        build.packageArchiveSha256 &&
        build.packageSizeBytes,
    );
    let downloaded: { buffer: Buffer; filename: string };
    let sourceArtifactHash: string;

    if (hasDurablePackage) {
      // v4 publication consumes the exact bytes that reconciliation already
      // downloaded, parsed and bound to this build generation. It deliberately
      // does not read the upstream task or depend on a signed URL/API key.
      downloaded = {
        buffer: await readKnowledgeBuildArtifact({
          userId: targetUserId,
          buildId: build.id,
          generation: build.generation,
          kind: "package",
          expectedSha256: build.packageArchiveSha256!,
          expectedBytes: build.packageSizeBytes!,
          storageKey: build.packageStorageKey!,
        }),
        filename: String(
          build.packageFilename || "frontmind-knowledge-base.zip",
        ),
      };
      sourceArtifactHash = knowledgeBasePublicationBindingHash(build)!;
    } else {
      // Only pre-state-machine v1 imports retain the upstream compatibility
      // path. Builder v3/v4 publication must consume bytes that reconcile
      // already validated and persisted under the build generation.
      if (
        build.skillVersion === "3" ||
        build.skillVersion === "4" ||
        !taskId ||
        taskId !== build.upstreamTaskId ||
        build.packageRevision !== build.revision ||
        !build.packageOutputItemId ||
        !build.packageDescriptorHash
      ) {
        throw new Error("最终知识库文件尚未完成不可变持久化与版本绑定");
      }
      const credential = await getCredentialForUpstreamResource(
        targetUserId,
        "task",
        taskId,
      );
      if (!credential)
        throw new Error("知识库任务不属于当前用户或 API Key 已失效");
      publishLogSecrets.push(credential.apiKey);

      const baseUrl = getUpstreamBaseUrl(req);
      const taskResponse = await axios.get(
        `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
        {
          headers: upstreamHeaders(credential.apiKey),
          proxy: false,
          timeout: 120_000,
          maxContentLength: 50 * 1024 * 1024,
          validateStatus: () => true,
        },
      );
      if (taskResponse.status !== 200) {
        throw new Error(`读取知识库任务结果失败 (${taskResponse.status})`);
      }
      const task = taskResponse.data?.task || taskResponse.data || {};
      const returnedTaskId = String(task.id || task.task_id || "");
      if (returnedTaskId !== taskId) {
        throw new Error("读取到的知识库任务与当前完成版本不匹配");
      }
      if (task.status === "failed" || task.status === "error") {
        throw new Error("知识库任务执行失败，无法发布");
      }
      const output = Array.isArray(task.output) ? task.output : [];
      const matchingDescriptors = collectKnowledgeArchiveDescriptors(
        output,
      ).filter(
        (candidate) =>
          candidate.outputItemId === build.packageOutputItemId &&
          knowledgeArchiveDescriptorHash(candidate) ===
            build.packageDescriptorHash &&
          (!build.packageFileId || candidate.fileId === build.packageFileId),
      );
      if (matchingDescriptors.length !== 1) {
        throw new Error("任务结果中无法唯一确认当前版本的知识库 ZIP");
      }
      downloaded = await downloadArchiveBytes({
        descriptor: matchingDescriptors[0]!,
        apiKey: credential.apiKey,
        baseUrl,
      });
      sourceArtifactHash = build.packageDescriptorHash;
    }
    const archiveHash = createHash("sha256")
      .update(downloaded.buffer)
      .digest("hex");
    const snapshotId = randomUUID();
    const parsed = await readKnowledgeArchive(
      downloaded.buffer,
      downloaded.filename,
      snapshotId,
      {
        validationProfile:
          build.skillVersion === "1" ? "historical" : "dashboard-enterprise-v1",
        archiveContractVersions:
          build.skillVersion === "1"
            ? undefined
            : build.skillVersion === "4"
              ? [3, 4]
              : [2, 3],
      },
    );
    storedAssetKeys = parsed.storedAssetKeys;
    if (build.skillVersion === "3" || build.skillVersion === "4") {
      if (
        build.skillVersion === "4" &&
        parsed.packageBuildRevision !== build.revision
      ) {
        throw new Error(
          `最终 ZIP buildRevision 与发布版本不一致：期望 ${build.revision}，实际 ${String(parsed.packageBuildRevision ?? "缺失")}`,
        );
      }
      const db = await getDb();
      if (!db) throw new Error("数据库暂不可用，无法校验最终知识库节点");
      const nodes = await db
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id));
      const expectedCustomerUploads =
        build.skillVersion === "4"
          ? await verifiedKnowledgeBaseCustomerUploadsForBuild({
              userId: targetUserId,
              buildId: build.id,
              generation: build.generation,
            })
          : [];
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
        legacyV3Compatibility: build.skillVersion === "3",
      });
      if (parsed.packageSchemaVersion === 4) {
        await assertKnowledgeBaseCustomerUploadVisualBindings({
          assets: parsed.assets,
          expectedUploads: expectedCustomerUploads,
          readPackagedAssetBytes: readStoredKnowledgeAssetBytes,
        });
      }
    }
    const workspace = await getDashboardWorkspace(targetUserId);
    assertKnowledgeArchiveEnterpriseIdentity({
      enterpriseIdentityConfirmed: Boolean(workspace.enterpriseIdentityBoundAt),
      brandName: workspace.payload.brandName,
      documents: parsed.documents,
    });
    await persistKnowledgeSnapshotArchive({
      userId: targetUserId,
      snapshotId,
      buffer: downloaded.buffer,
      expectedSha256: archiveHash,
    });
    storedArchive = { userId: targetUserId, snapshotId };
    const snapshot = await createKnowledgeSnapshot({
      snapshotId,
      userId: targetUserId,
      actorUserId: actor.id,
      sourceFileName: downloaded.filename,
      sourceConversationId: conversationId,
      sourceBuildId: build.id,
      sourceBuildRevision: build.revision,
      sourceTaskId: taskId,
      sourceArtifactHash,
      archiveHash,
      documents: parsed.documents,
      assets: parsed.assets,
      totalBytes: downloaded.buffer.length,
    });
    snapshotCommitted = true;
    await createKnowledgeMonitoringHandoff({
      userId: targetUserId,
      actorUserId: actor.id,
      knowledgeSnapshotId: snapshot?.id ?? snapshotId,
    });
    res.json({ kind: "knowledge", snapshot });
  } catch (error) {
    await removeUncommittedStoredKnowledgeAssets({
      snapshotCommitted,
      storedAssetKeys,
    });
    if (!snapshotCommitted && storedArchive) {
      await removeKnowledgeSnapshotArchive(storedArchive).catch(
        () => undefined,
      );
    }
    const publishedBuild = await assertKnowledgeBasePublishable({
      userId: targetUserId,
      conversationId,
    }).catch(() => null);
    if (
      publishedBuild?.status === "published" &&
      publishedBuild.publishedSnapshotId
    ) {
      const snapshot = await getKnowledgeSnapshotById({
        userId: targetUserId,
        snapshotId: publishedBuild.publishedSnapshotId,
      }).catch(() => null);
      if (snapshot) {
        res.json({ kind: "knowledge", snapshot, idempotent: true });
        return;
      }
    }
    console.error(
      "[Dashboard] Knowledge publish failed",
      dashboardKnowledgePublishErrorForLog(error, publishLogSecrets),
    );
    res
      .status(error instanceof ServiceEntitlementError ? error.statusCode : 400)
      .json({
        error: {
          message: error instanceof Error ? error.message : "无法发布知识库",
          code:
            error instanceof ServiceEntitlementError
              ? error.code
              : knowledgeArchiveErrorCode(error) || "KNOWLEDGE_PUBLISH_FAILED",
        },
      });
  }
});

router.put(
  "/import/:userId",
  express.raw({ type: "application/octet-stream", limit: "250mb" }),
  async (req: FrontMindRequest, res) => {
    const actor = req.frontmindUser!;
    const targetUserId =
      req.params.userId === "me" ? actor.id : Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      res
        .status(400)
        .json({ error: { message: "用户 ID 无效", code: "BAD_REQUEST" } });
      return;
    }
    try {
      assertNotDeliveryAdministratorExecution(actor);
      if (actor.role !== "delivery_member") {
        await assertWorkspaceAccess(actor, targetUserId);
      }
      const buffer = bodyBuffer(req);
      if (buffer.length === 0) throw new Error("上传文件为空");
      const sourceFileName = decodeHeader(
        req.header("x-file-name"),
        "dashboard.json",
      );
      const fileHash = monitoringImportFileHash(buffer);
      const importPreview =
        String(req.header("x-import-preview") || "").toLowerCase() === "true";
      const sourceConversationId =
        req.header("x-conversation-id")?.trim() || undefined;
      const expectedRevision = dashboardRevisionHeader(
        req.header("x-dashboard-revision"),
      );
      const extension = path.extname(sourceFileName).toLowerCase();
      const mode = req.header("x-import-mode") || "auto";
      if (
        mode === "dashboard" ||
        (mode === "auto" && [".csv", ".json", ".xlsx"].includes(extension))
      ) {
        const importModule = dashboardImportModule(
          req.header("x-dashboard-module"),
        );
        if (actor.role === "delivery_member") {
          if (importModule === "full") {
            throw new Error("交付成员不能执行整合看板导入");
          }
          await assertDeliveryModuleImport({
            req,
            targetUserId,
            importModule,
          });
        } else if (actor.role !== "admin") {
          throw new Error("用户账号不能直接发布看板数据");
        }
        const existing = await getDashboardWorkspace(targetUserId);
        assertDashboardImportRevision({
          expectedRevision,
          currentRevision: existing.revision,
        });
        assertDashboardImportModuleEnabled(importModule);
        const sectionIdHeader =
          importModule === "section-table"
            ? String(req.header("x-dashboard-section-id") || "").trim()
            : undefined;
        const targetBatchKeyHeader =
          importModule === "monitoring"
            ? String(
                req.header("x-monitoring-target-batch-key") || "",
              ).trim() || undefined
            : undefined;
        if (!importPreview) {
          assertDashboardImportPublishHash({
            module: importModule,
            fileHash,
            expectedFileHash:
              importModule === "monitoring"
                ? req.header("x-monitoring-file-hash") ||
                  req.header("x-import-file-hash")
                : req.header("x-import-file-hash"),
          });
        }
        const servicePortal = await assertDashboardImportCapability(
          targetUserId,
          importModule,
        );
        if (![".csv", ".json", ".xlsx"].includes(extension)) {
          throw new Error("看板板块仅支持 CSV、XLSX 或 JSON");
        }
        if (
          [
            "profile",
            "metrics",
            "sections",
            "keywords",
            "questions",
            "response-logic",
            "content-assets",
          ].includes(importModule) &&
          extension !== ".json"
        ) {
          throw new Error("该模块只接受下载后保留修订号的 JSON 当前内容模板");
        }
        if (importModule === "optimization-report" && extension !== ".json") {
          throw new Error("进度报告仅支持带修订号的 JSON 当前内容模板");
        }
        if (!existing.enterpriseIdentityBoundAt && importModule !== "profile") {
          throw new Error(
            "请先由管理员确认并发布当前账号的企业名称，再上传其他内容板块",
          );
        }
        if (importModule === "response-logic") {
          if (extension === ".json") {
            parseDashboardModuleTemplateMetadata({
              raw: JSON.parse(buffer.toString("utf8")),
              expectedModule: "response-logic",
              currentRevision: existing.revision,
            });
          }
          const values = await responseLogicImportsFromFile({
            buffer,
            sourceFileName,
            existing: dashboardPayloadWithServiceQuestionCatalog({
              payload: existing.payload,
              questions: servicePortal.purchasedQuestions,
            }),
          });
          for (const value of values) {
            if (value.publish) {
              assertResponseLogicDraftPublishable(value.draft);
            }
          }
          if (importPreview) {
            const currentRecords = await listResponseLogicEntries(targetUserId);
            const preview = buildResponseLogicImportPreview({
              current: currentRecords,
              incoming: values,
              sourceName: sourceFileName,
              fileHash,
              templateRevision: existing.revision,
            });
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "response-logic",
                revision: existing.revision,
                fileHash,
              },
            });
            res.json({
              kind: "dashboard-module-preview",
              preview: {
                ...preview,
                ...credential,
              },
            });
            return;
          }
          const records = await saveResponseLogicEntriesBatch({
            userId: targetUserId,
            entries: values.map(({ expectedRevision, ...value }) => ({
              expectedRevision,
              value,
            })),
            beforeWrite: async (tx) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "response-logic",
                  revision: expectedRevision!,
                  fileHash,
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (tx, savedRecords = []) => {
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.response_logic.imported",
                  targetType: "response_logic",
                  targetId: targetUserId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    recordCount: savedRecords.length,
                    publishedCount: values.filter((value) => value.publish)
                      .length,
                    revisions: savedRecords.map((record) => ({
                      questionId: record.questionId,
                      revision: record.revision,
                    })),
                  },
                },
                tx,
              );
            },
          });
          res.json({
            kind: "response-logic",
            module: importModule,
            records,
          });
          return;
        }
        if (importModule === "questions") {
          if (extension !== ".json") {
            throw new Error(
              "正式问题目录只支持带逐题修订号的 JSON 当前内容模板",
            );
          }
          const template = parseAuthoritativeQuestionsTemplate({
            raw: JSON.parse(buffer.toString("utf8")),
            currentRevision: existing.revision,
            currentQuestions: servicePortal.purchasedQuestions,
          });
          const preview = buildAuthoritativeQuestionsImportPreview({
            sourceName: sourceFileName,
            fileHash,
            templateRevision: existing.revision,
            current: servicePortal.purchasedQuestions,
            incoming: template.questions,
          });
          if (importPreview) {
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "questions",
                revision: existing.revision,
                fileHash,
              },
            });
            res.json({
              kind: "dashboard-module-preview",
              preview: {
                ...preview,
                ...credential,
              },
            });
            return;
          }
          const questions = await updateWorkspaceQuestionsByAdminBatch({
            userId: targetUserId,
            actorUserId: actor.id,
            entries: template.questions.map((question) => ({
              questionId: question.id,
              expectedRevision: question.revision,
              category: question.category,
              question: question.question,
              intent: question.intent,
              rationale: question.rationale,
            })),
            beforeWrite: async (tx) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "questions",
                  revision: expectedRevision!,
                  fileHash,
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (tx, updatedQuestions = []) => {
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.questions.template_imported",
                  targetType: "workspace_question",
                  targetId: targetUserId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    recordCount: template.questions.length,
                    updatedCount: updatedQuestions.length,
                    questionIds: updatedQuestions.map(
                      (question) => question.id,
                    ),
                  },
                },
                tx,
              );
            },
          });
          res.json({
            kind: "questions",
            module: importModule,
            questions,
          });
          return;
        }
        if (importModule === "monitoring" && extension === ".json") {
          const currentBatches = await getMonitoringCurrentTemplateBatches({
            actor,
            userId: targetUserId,
          });
          const { template, changedBatchCount } =
            parseMonitoringCurrentTemplate({
              raw: JSON.parse(buffer.toString("utf8")),
              currentRevision: existing.revision,
              workspaceUserId: targetUserId,
              currentBatches,
            });
          const preview = buildMonitoringCurrentTemplatePreview({
            template,
            changedBatchCount,
            sourceName: sourceFileName,
            fileHash,
            templateRevision: existing.revision,
          });
          if (importPreview) {
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "monitoring",
                revision: existing.revision,
                fileHash,
              },
            });
            res.json({
              kind: "monitoring-preview",
              preview: {
                ...preview,
                ...credential,
              },
            });
            return;
          }
          const batches = await replaceMonitoringCurrentTemplateBatches({
            actor,
            userId: targetUserId,
            batches: template.batches,
            beforeWrite: async (tx) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "monitoring",
                  revision: expectedRevision!,
                  fileHash,
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (tx, updatedBatches = []) => {
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.monitoring.template_imported",
                  targetType: "monitoring_batch",
                  targetId: targetUserId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    fileHash,
                    changedBatchCount: updatedBatches.length,
                    batches: updatedBatches,
                  },
                },
                tx,
              );
            },
          });
          res.json({
            kind: "monitoring",
            module: importModule,
            batches,
          });
          return;
        }
        if (importModule === "section-table") {
          if (extension === ".json") {
            throw new Error("板块表格请上传 CSV 或 XLSX");
          }
          const sectionId = sectionIdHeader || "";
          const targetSection = existing.payload.sections.find(
            (section) => section.id === sectionId,
          );
          if (!targetSection) throw new Error("没有找到要更新的内容板块");
          const tables = await tabularTablesFromFile({
            buffer,
            sourceFileName,
          });
          if (tables.length === 0) throw new Error("上传文件中没有可展示表格");
          const payload = dashboardPayloadSchema.parse({
            ...existing.payload,
            sections: existing.payload.sections.map((section) =>
              section.id === sectionId ? { ...section, tables } : section,
            ),
          });
          if (importPreview) {
            const credential = await issueDashboardImportPreflight({
              binding: {
                actorId: actor.id,
                workspaceUserId: targetUserId,
                module: "section-table",
                revision: existing.revision,
                fileHash,
                sectionId,
              },
            });
            res.json({
              kind: "dashboard-module-preview",
              preview: {
                ...buildDashboardModuleImportPreview({
                  module: "section-table",
                  current: existing.payload,
                  incoming: payload,
                  sourceName: sourceFileName,
                  fileHash,
                  templateRevision: existing.revision,
                  sectionId,
                }),
                ...credential,
              },
            });
            return;
          }
          const dashboard = await updateDashboardWorkspace({
            userId: targetUserId,
            actorUserId: actor.id,
            payload,
            sourceName: sourceFileName,
            expectedRevision,
            ...dashboardImportTransactionHooks({
              actor,
              targetUserId,
              module: "section-table",
              expectedRevision: expectedRevision!,
              fileHash,
              preflightToken: req.header("x-import-preflight-token"),
              sourceFileName,
              sectionId,
            }),
          });
          res.json({ kind: "dashboard", module: importModule, dashboard });
          return;
        }
        let payload: DashboardPayload;
        try {
          payload =
            importModule === "keywords" && extension !== ".json"
              ? dashboardPayloadSchema.parse({
                  ...existing.payload,
                  keywordTables: await tabularTablesFromFile({
                    buffer,
                    sourceFileName,
                  }),
                })
              : await dashboardPayloadFromFile({
                  buffer,
                  sourceFileName,
                  existing:
                    importModule === "monitoring"
                      ? dashboardPayloadWithServiceQuestionCatalog({
                          payload: existing.payload,
                          // Monitoring rows belong to the formally purchased
                          // question catalog. The dashboard content copy can be
                          // empty or stale and must never decide whether a real
                          // monitoring export is accepted.
                          questions: servicePortal.purchasedQuestions,
                        })
                      : existing.payload,
                  module: importModule,
                  currentRevision: existing.revision,
                });
        } catch (error) {
          if (importModule !== "monitoring" || !importPreview) throw error;
          const available = await getMonitoringFilterOptions(
            targetUserId,
            servicePortal.quotaPeriods.map((period) => period.periodId),
          );
          res.json({
            kind: "monitoring-preview",
            preview: {
              module: "monitoring",
              mode: "invalid",
              sourceName: sourceFileName,
              fileHash,
              templateRevision: existing.revision,
              summary: ["文件未通过格式校验，不能发布。"],
              targetBatchRequired: false,
              availableBatches: available.batches,
              questions: [],
              models: [],
              dates: [],
              sampleCount: 0,
              citationCount: 0,
              exactLinked: 0,
              issues: [
                {
                  severity: "error",
                  code: "MONITORING_IMPORT_INVALID",
                  message:
                    error instanceof Error
                      ? error.message
                      : "无法识别监控导入文件",
                },
              ],
            } satisfies MonitoringImportPreview,
          });
          return;
        }
        if (importModule === "monitoring") {
          const monitoringBatch = buildDashboardMonitoringImport({
            targetUserId,
            payload,
            sourceFileName,
            sourceHash: fileHash,
          });
          if (!monitoringBatch) {
            if (importPreview) {
              const available = await getMonitoringFilterOptions(
                targetUserId,
                servicePortal.quotaPeriods.map((period) => period.periodId),
              );
              res.json({
                kind: "monitoring-preview",
                preview: {
                  module: "monitoring",
                  mode: "invalid",
                  sourceName: sourceFileName,
                  fileHash,
                  templateRevision: existing.revision,
                  summary: ["文件中没有可发布的监控答案或引用记录。"],
                  targetBatchRequired: false,
                  availableBatches: available.batches,
                  questions: [],
                  models: [],
                  dates: [],
                  sampleCount: 0,
                  citationCount: 0,
                  exactLinked: 0,
                  issues: [
                    {
                      severity: "error",
                      code: "MONITORING_IMPORT_EMPTY",
                      message: "文件中没有可发布的监控答案或引用记录",
                    },
                  ],
                } satisfies MonitoringImportPreview,
              });
              return;
            }
            throw new Error("文件中没有可发布的监控答案或引用记录");
          }
          const available = await getMonitoringFilterOptions(
            targetUserId,
            servicePortal.quotaPeriods.map((period) => period.periodId),
          );
          const preview = buildMonitoringImportPreview({
            payload,
            batch: monitoringBatch,
            sourceName: sourceFileName,
            fileHash,
            templateRevision: existing.revision,
            availableBatches: available.batches,
          });
          if (importPreview) {
            let boundTargetBatchKey = targetBatchKeyHeader;
            if (boundTargetBatchKey) {
              const allowedTarget = available.batches.some(
                (batch) =>
                  batch.batchKey === boundTargetBatchKey &&
                  batch.sampleCount > 0,
              );
              if (!allowedTarget) {
                throw new MonitoringTargetBatchRequiredError();
              }
            }
            if (preview.targetBatchRequired && !boundTargetBatchKey) {
              boundTargetBatchKey = preview.suggestedBatchKey;
            }
            const credential =
              !preview.targetBatchRequired || boundTargetBatchKey
                ? await issueDashboardImportPreflight({
                    binding: {
                      actorId: actor.id,
                      workspaceUserId: targetUserId,
                      module: "monitoring",
                      revision: existing.revision,
                      fileHash,
                      ...(boundTargetBatchKey
                        ? { targetBatchKey: boundTargetBatchKey }
                        : {}),
                    },
                  })
                : undefined;
            res.json({
              kind: "monitoring-preview",
              preview: {
                ...preview,
                ...(boundTargetBatchKey
                  ? { preflightTargetBatchKey: boundTargetBatchKey }
                  : {}),
                ...(credential ?? {}),
              },
            });
            return;
          }
          const targetBatchKey = targetBatchKeyHeader || "";
          if (preview.targetBatchRequired && !targetBatchKey) {
            throw new MonitoringTargetBatchRequiredError();
          }
          const transactionHooks = {
            beforeWrite: async (tx: any) => {
              const dashboardRows = await tx
                .select({ revision: userDashboardContents.revision })
                .from(userDashboardContents)
                .where(eq(userDashboardContents.userId, targetUserId))
                .limit(1)
                .for("update");
              assertDashboardImportRevision({
                expectedRevision,
                currentRevision: dashboardRows[0]?.revision ?? 0,
              });
              await consumeDashboardImportPreflight({
                token: req.header("x-import-preflight-token"),
                binding: {
                  actorId: actor.id,
                  workspaceUserId: targetUserId,
                  module: "monitoring",
                  revision: expectedRevision!,
                  fileHash,
                  ...(preview.targetBatchRequired ? { targetBatchKey } : {}),
                },
                store: dashboardImportPreflightStoreForExecutor(tx),
              });
            },
            afterWrite: async (
              tx: any,
              batch?: {
                batchId: string;
                batchKey: string;
                sampleCount: number;
                citationCount: number;
                idempotent: boolean;
              },
            ) => {
              if (!batch) throw new Error("监控批次发布结果缺失");
              await writeWorkspaceAuditEvent(
                {
                  actor,
                  action: "workspace.monitoring.imported",
                  targetType: "monitoring_batch",
                  targetId: batch.batchId,
                  workspaceUserId: targetUserId,
                  metadata: {
                    sourceName: sourceFileName,
                    batchKey: batch.batchKey,
                    sampleCount: batch.sampleCount,
                    citationCount: batch.citationCount,
                    idempotent: batch.idempotent,
                    fileHash,
                    targetBatchKey: preview.targetBatchRequired
                      ? targetBatchKey
                      : undefined,
                  },
                },
                tx,
              );
            },
          };
          const batch = preview.targetBatchRequired
            ? await mergeQuestionOnlyCitationsIntoMonitoringBatch({
                actor,
                targetUserId,
                targetBatchKey,
                value: monitoringBatch,
                ...transactionHooks,
              })
            : await replaceMonitoringBatch({
                actor,
                value: monitoringBatch,
                ...transactionHooks,
              });
          res.json({ kind: "monitoring", module: importModule, batch });
          return;
        }
        if (
          payload.optimizationReport &&
          (importModule === "optimization-report" ||
            (payload.optimizationReport.questionBaselines?.length ?? 0) > 0 ||
            (payload.optimizationReport.questionReports?.length ?? 0) > 0)
        ) {
          assertOptimizationReportQuestionScope(payload.optimizationReport, [
            ...servicePortal.purchasedQuestions,
            ...servicePortal.historicalQuestions,
          ]);
        }
        if (importModule === "optimization-report" && importPreview) {
          if (!payload.optimizationReport) {
            throw new Error("优化报告模板中没有可预检的报告内容");
          }
          const credential = await issueDashboardImportPreflight({
            binding: {
              actorId: actor.id,
              workspaceUserId: targetUserId,
              module: "optimization-report",
              revision: existing.revision,
              fileHash,
            },
          });
          res.json({
            kind: "optimization-report-preview",
            preview: {
              ...buildOptimizationReportImportPreview({
                current: existing.payload.optimizationReport,
                incoming: payload.optimizationReport,
                fileHash,
                sourceName: sourceFileName,
                templateRevision: existing.revision,
              }),
              ...credential,
            },
          });
          return;
        }
        assertDashboardEnterpriseIdentity(existing, payload);
        if (importPreview && importModule !== "optimization-report") {
          const credential = await issueDashboardImportPreflight({
            binding: {
              actorId: actor.id,
              workspaceUserId: targetUserId,
              module: importModule,
              revision: existing.revision,
              fileHash,
            },
          });
          res.json({
            kind: "dashboard-module-preview",
            preview: {
              ...buildDashboardModuleImportPreview({
                module: importModule,
                current: existing.payload,
                incoming: payload,
                sourceName: sourceFileName,
                fileHash,
                templateRevision: existing.revision,
              }),
              ...credential,
            },
          });
          return;
        }
        const dashboard = await importDashboardPayload({
          actor,
          targetUserId,
          payload,
          sourceFileName,
          bindEnterpriseIdentity: importModule === "profile",
          expectedRevision,
          progressReportPeriods:
            importModule === "optimization-report"
              ? servicePortal.quotaPeriods.map((period) => ({
                  contractId: period.contractId,
                  quotaPeriodId: period.periodId,
                }))
              : undefined,
          ...dashboardImportTransactionHooks({
            actor,
            targetUserId,
            module: importModule,
            expectedRevision: expectedRevision!,
            fileHash,
            preflightToken: req.header("x-import-preflight-token"),
            sourceFileName,
          }),
        });
        res.json({ kind: "dashboard", module: importModule, dashboard });
        return;
      }

      if (actor.role === "user") {
        throw new Error(
          "用户知识库只能通过“更新知识库”发布已绑定任务的最终版本",
        );
      }
      await assertRoleScopedWorkspaceExecution({
        req,
        targetUserId,
        expectedRoleType: "ai_operations_engineer",
      });
      await assertKnowledgeBaseWritable(targetUserId);
      await assertServiceCapability(targetUserId, "knowledgeDisplay");
      const maintenanceTicketId =
        req.header("x-maintenance-ticket-id")?.trim() || undefined;
      const existingSnapshot = await getLatestKnowledgeSnapshot(targetUserId);
      if (existingSnapshot && !maintenanceTicketId) {
        throw new KnowledgeArchiveValidationError(
          "structure",
          "已发布知识库只能通过开放的维护工单替换",
        );
      }
      if (maintenanceTicketId) {
        await assertKnowledgeMaintenanceTicketForUpload({
          userId: targetUserId,
          ticketId: maintenanceTicketId,
        });
      }

      let sourceBuildId: string | undefined;

      const snapshotId = randomUUID();
      const parsed = await readKnowledgeArchive(
        buffer,
        sourceFileName,
        snapshotId,
        maintenanceTicketId
          ? {
              validationProfile: "dashboard-enterprise-v1",
              archiveContractVersions: [2, 3],
            }
          : { validationProfile: "historical" },
      );
      let snapshotCommitted = false;
      let storedArchive = false;
      try {
        const workspace = await getDashboardWorkspace(targetUserId);
        assertKnowledgeArchiveEnterpriseIdentity({
          enterpriseIdentityConfirmed: Boolean(
            workspace.enterpriseIdentityBoundAt,
          ),
          brandName: workspace.payload.brandName,
          documents: parsed.documents,
        });
        const archiveHash =
          extension === ".zip"
            ? createHash("sha256").update(buffer).digest("hex")
            : undefined;
        if (archiveHash) {
          await persistKnowledgeSnapshotArchive({
            userId: targetUserId,
            snapshotId,
            buffer,
            expectedSha256: archiveHash,
          });
          storedArchive = true;
        }
        const snapshot = await createKnowledgeSnapshot({
          snapshotId,
          userId: targetUserId,
          actorUserId: actor.id,
          sourceFileName,
          sourceConversationId,
          sourceBuildId,
          maintenanceTicketId,
          archiveHash,
          documents: parsed.documents,
          assets: parsed.assets,
          totalBytes: buffer.length,
        });
        snapshotCommitted = true;
        await runCommittedKnowledgeSnapshotSideEffects([
          {
            name: "monitoring handoff",
            run: () =>
              createKnowledgeMonitoringHandoff({
                userId: targetUserId,
                actorUserId: actor.id,
                knowledgeSnapshotId: snapshot?.id ?? snapshotId,
              }),
          },
          {
            name: "publication audit",
            run: () =>
              writeWorkspaceAuditEvent({
                actor,
                action: "workspace.knowledge.published",
                targetType: "knowledge_snapshot",
                targetId: snapshot?.id ?? snapshotId,
                workspaceUserId: targetUserId,
                metadata: {
                  sourceName: sourceFileName,
                  sourceConversationId,
                  sourceBuildId,
                  maintenanceTicketId,
                  documentCount:
                    snapshot?.documentCount ?? parsed.documents.length,
                  imageCount: snapshot?.imageCount ?? parsed.assets.length,
                  totalBytes: snapshot?.totalBytes ?? buffer.length,
                },
              }),
          },
        ]);
        res.json({ kind: "knowledge", snapshot });
      } catch (error) {
        await removeUncommittedStoredKnowledgeAssets({
          snapshotCommitted,
          storedAssetKeys: parsed.storedAssetKeys,
        });
        if (!snapshotCommitted && storedArchive) {
          await removeKnowledgeSnapshotArchive({
            userId: targetUserId,
            snapshotId,
          }).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      console.error("[Dashboard] Import failed", error);
      const enterpriseMismatch =
        error instanceof DashboardEnterpriseMismatchError;
      const revisionConflict = error instanceof DashboardRevisionConflictError;
      const monitoringTargetRequired =
        error instanceof MonitoringTargetBatchRequiredError;
      const monitoringPreviewConflict =
        error instanceof MonitoringPreviewRequiredError ||
        error instanceof MonitoringFileChangedError;
      const dashboardImportPreviewConflict =
        error instanceof DashboardImportPreviewRequiredError ||
        error instanceof DashboardImportFileChangedError ||
        error instanceof DashboardTemplateRevisionError;
      const dashboardImportPreflightConflict =
        error instanceof DashboardImportPreflightError;
      const responseLogicRevisionConflict =
        error instanceof ResponseLogicRevisionConflictError;
      res
        .status(
          error instanceof ServiceEntitlementError
            ? error.statusCode
            : monitoringTargetRequired
              ? error.statusCode
              : monitoringPreviewConflict
                ? error.statusCode
                : dashboardImportPreviewConflict
                  ? error.statusCode
                  : dashboardImportPreflightConflict
                    ? error.statusCode
                    : responseLogicRevisionConflict
                      ? error.statusCode
                      : enterpriseMismatch || revisionConflict
                        ? 409
                        : 400,
        )
        .json({
          error: {
            message: error instanceof Error ? error.message : "无法导入文件",
            code:
              error instanceof ServiceEntitlementError
                ? error.code
                : enterpriseMismatch
                  ? "ENTERPRISE_IDENTITY_CONFLICT"
                  : revisionConflict
                    ? "DASHBOARD_REVISION_CONFLICT"
                    : monitoringTargetRequired
                      ? error.code
                      : monitoringPreviewConflict
                        ? error.code
                        : dashboardImportPreviewConflict
                          ? error.code
                          : dashboardImportPreflightConflict
                            ? error.code
                            : responseLogicRevisionConflict
                              ? error.code
                              : knowledgeArchiveErrorCode(error) ||
                                "IMPORT_FAILED",
          },
        });
    }
  },
);

router.get(
  "/knowledge/snapshots/:snapshotId/archive",
  async (req: FrontMindRequest, res) => {
    try {
      const snapshotId = z.string().uuid().parse(req.params.snapshotId);
      const snapshot = await getKnowledgeSnapshotForWorkspace({
        actor: req.frontmindUser!,
        snapshotId,
      });
      if (
        !snapshot ||
        !snapshot.sourceFileName.toLowerCase().endsWith(".zip") ||
        !snapshot.archiveHash ||
        !/^[a-f0-9]{64}$/i.test(snapshot.archiveHash)
      ) {
        throw new KnowledgeSnapshotArchiveError(
          "ARCHIVE_NOT_FOUND",
          "该知识库版本尚无可下载的 ZIP 归档",
        );
      }
      const bytes = await readKnowledgeSnapshotArchive({
        userId: snapshot.userId,
        snapshotId,
        expectedSha256: snapshot.archiveHash,
        expectedBytes: snapshot.totalBytes,
      });
      await validateKnowledgeArchiveForDownload({
        buffer: bytes,
        sourceFileName: snapshot.sourceFileName,
        expectedSha256: snapshot.archiveHash,
        expectedBytes: snapshot.totalBytes,
        // Historical is the compatibility superset for snapshots created
        // before profile/version metadata was persisted. It still executes
        // the shared CRC, path traversal, symlink, entry-count, expansion and
        // required-root structure checks before any bytes leave the server.
        validationProfile: "historical",
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader(
        "Content-Disposition",
        knowledgeArchiveContentDisposition(snapshot.sourceFileName),
      );
      res.send(bytes);
    } catch (error) {
      const archiveError =
        error instanceof KnowledgeSnapshotArchiveError ? error : null;
      const validationError =
        error instanceof KnowledgeArchiveValidationError ? error : null;
      res
        .status(
          validationError ||
            (archiveError && archiveError.code !== "ARCHIVE_NOT_FOUND")
            ? 409
            : 404,
        )
        .json({
          error: {
            message:
              validationError?.message ||
              archiveError?.message ||
              "知识库 ZIP 不存在",
            code:
              knowledgeArchiveErrorCode(validationError) ||
              archiveError?.code ||
              "NOT_FOUND",
          },
        });
    }
  },
);

router.get(
  "/knowledge/assets/:snapshotId/by-id/:assetId",
  async (req: FrontMindRequest, res) => {
    try {
      const assetId = z
        .string()
        .trim()
        .min(1)
        .max(191)
        .parse(req.params.assetId);
      const result = await getKnowledgeAssetById({
        snapshotId: req.params.snapshotId,
        assetId,
      });
      if (!result) throw new Error("资源不存在");
      await assertWorkspaceAccess(req.frontmindUser!, result.snapshot.userId);
      const bytes = await readFile(path.join(storageRoot, result.asset.key));
      res.setHeader("Content-Type", result.asset.mimeType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Disposition", "inline");
      res.send(bytes);
    } catch {
      res
        .status(404)
        .json({ error: { message: "资源不存在", code: "NOT_FOUND" } });
    }
  },
);

router.get(
  "/knowledge/assets/:snapshotId/:assetIndex",
  async (req: FrontMindRequest, res) => {
    try {
      const assetIndex = Number(req.params.assetIndex);
      if (!Number.isInteger(assetIndex) || assetIndex < 0)
        throw new Error("资源不存在");
      const result = await getKnowledgeAsset({
        snapshotId: req.params.snapshotId,
        assetIndex,
      });
      if (!result) throw new Error("资源不存在");
      await assertWorkspaceAccess(req.frontmindUser!, result.snapshot.userId);
      const bytes = await readFile(path.join(storageRoot, result.asset.key));
      res.setHeader("Content-Type", result.asset.mimeType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Disposition", "inline");
      res.send(bytes);
    } catch {
      res
        .status(404)
        .json({ error: { message: "资源不存在", code: "NOT_FOUND" } });
    }
  },
);

export default router;
