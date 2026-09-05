import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import sharp from "sharp";
import { z } from "zod";
import AxeBuilder from "@axe-core/playwright";
import { launch as launchChrome } from "chrome-launcher";
import lighthouse from "lighthouse";
import { chromium } from "playwright";

import type {
  KnowledgeBaseSnapshot,
  KnowledgeDocumentRecord,
  SiteBuild,
} from "../../drizzle/schema";
import {
  SITEOPS_MATERIALIZER_V1_2,
  SITEOPS_MATERIALIZER_V1_3,
  SITEOPS_MATERIALIZER_V1_4,
  SITEOPS_MATERIALIZER_V1_5,
  SITEOPS_MATERIALIZER_V1_6,
  SITEOPS_MATERIALIZER_V2_0,
  SITEOPS_MATERIALIZER_V2_1,
  SITEOPS_MATERIALIZER_V2_2,
  SITEOPS_MATERIALIZER_V2_3,
  SITEOPS_MATERIALIZER_V2_4_LEGACY,
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_WORKFLOW,
  siteBriefSchema,
  type SiteBrief,
} from "../../shared/siteops";
import { canonicalJson } from "../../shared/siteops-workflow";
import { SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE } from "../../shared/siteops-contract";
import {
  assertVisualPaletteContrastV3,
  canonicalSiteOpsSha256,
  composeBuildContractV3,
  composeBuildPlanContractV3,
  composeBuildContractV4,
  composeBuildPlanContractV4,
  composeBuildContractV2,
  pageContentSpecV2Schema,
  siteDesignSpecV1Schema,
  siteDesignSpecV2Schema,
  siteOpsRuntimeVisualEvidenceV1Schema,
  siteOpsRuntimeVisualEvidenceV2Schema,
  validateDesignAndContentBindings,
  type BuildContractV2,
  type BuildContractV3,
  type BuildPlanContractV3,
  type BuildContractV4,
  type BuildPlanContractV4,
  type SiteDesignSpecV1,
  type SiteDesignSpecV2,
  type SiteOpsRuntimeVisualEvidenceV1,
  type SiteOpsRuntimeVisualEvidenceV2,
} from "../../shared/siteops-design";
import {
  freezeSiteBrandAsset,
  validateTrustedSiteBrandAsset,
  type FrozenSiteBrandAsset,
  type TrustedSiteBrandAsset,
} from "./knowledge-brand-asset";
import {
  materializationStage,
  SiteOpsMaterializationError,
  toSiteOpsMaterializationError,
  type SiteOpsMaterializationSafeDetails,
} from "./materialization-error";
import {
  REACT_STATIC_COMPONENT_LIBRARY_VERSION,
  REACT_STATIC_MATERIALIZER_VERSION,
  REACT_STATIC_REACT_VERSION,
  REACT_STATIC_RENDERER,
  REACT_STATIC_RENDERER_V1,
  TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE,
  TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2,
  TRUSTED_REACT_RENDERER_SOURCE,
  TRUSTED_REACT_VISUAL_CONTRACT_V4_CSS,
} from "./react-static-runtime";

export {
  SiteOpsMaterializationError,
  type SiteOpsMaterializationPhase,
  type SiteOpsMaterializationRetryClass,
  type SiteOpsMaterializationSafeDetails,
} from "./materialization-error";

type SiteOpsMaterializerCoordinates =
  | typeof SITEOPS_MATERIALIZER_V1_2
  | typeof SITEOPS_MATERIALIZER_V1_3
  | typeof SITEOPS_MATERIALIZER_V1_4
  | typeof SITEOPS_MATERIALIZER_V1_5
  | typeof SITEOPS_MATERIALIZER_V1_6
  | typeof SITEOPS_MATERIALIZER_V2_0
  | typeof SITEOPS_MATERIALIZER_V2_1
  | typeof SITEOPS_MATERIALIZER_V2_2
  | typeof SITEOPS_MATERIALIZER_V2_3
  | typeof SITEOPS_MATERIALIZER_V2_4_LEGACY
  | typeof SITEOPS_WORKFLOW;

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_DIST_BYTES = 30 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_BUILD_LOG_BYTES = 256 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 60_000;
const ASTRO_VERSION = "7.2.4";
const TYPESCRIPT_VERSION = "6.0.3";
const LEGACY_ASTRO_RENDERER = "astro_static_v1" as const;
type SiteRenderer =
  | typeof LEGACY_ASTRO_RENDERER
  | typeof REACT_STATIC_RENDERER_V1
  | typeof REACT_STATIC_RENDERER;

function isReactStaticRenderer(renderer: SiteRenderer) {
  return (
    renderer === REACT_STATIC_RENDERER_V1 || renderer === REACT_STATIC_RENDERER
  );
}

function reactStaticCoordinatesForWorkflow(
  workflow: SiteOpsMaterializerCoordinates,
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
    workflow.frontMindVersion ===
    SITEOPS_MATERIALIZER_V2_4_LEGACY.frontMindVersion
  ) {
    return {
      componentLibraryVersion:
        SITEOPS_MATERIALIZER_V2_4_LEGACY.componentLibraryVersion,
      materializerVersion: SITEOPS_MATERIALIZER_V2_4_LEGACY.materializerVersion,
    } as const;
  }
  if (workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion) {
    return {
      componentLibraryVersion: REACT_STATIC_COMPONENT_LIBRARY_VERSION,
      materializerVersion: REACT_STATIC_MATERIALIZER_VERSION,
    } as const;
  }
  throw new Error("SITEOPS_REACT_WORKFLOW_VERSION_UNSUPPORTED");
}
const SENSITIVE_TEXT =
  /(?:21st_sk_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*[A-Za-z0-9._~+/-]{12,})/iu;
const FORBIDDEN_DEMO_TEXT =
  /(?:https:\/\/example\.invalid|frontmind demo company)/iu;

const generatedSectionSchema = z
  .object({
    slotId: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    heading: z.string().trim().min(1).max(160),
    paragraphs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(8),
    sourceDocumentIds: z
      .array(z.string().trim().min(1).max(191))
      .min(1)
      .max(30),
  })
  .strict();

const generatedRouteSchema = z
  .object({
    routeId: z.string().trim().min(1).max(64),
    eyebrow: z.string().trim().min(1).max(100).optional(),
    heading: z.string().trim().min(1).max(180),
    summary: z.string().trim().min(1).max(600),
    sections: z.array(generatedSectionSchema).min(1).max(16),
  })
  .strict();

export const siteOpsGeneratedContentV1Schema = z
  .object({
    seo: z
      .object({
        siteTitle: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(200),
        organizationType: z
          .enum(["Organization", "Corporation", "ProfessionalService"])
          .default("Organization"),
      })
      .strict(),
    routes: z.array(generatedRouteSchema).min(1).max(30),
  })
  .strict();

export const siteOpsGeneratedContentV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    seo: siteOpsGeneratedContentV1Schema.shape.seo,
    routes: pageContentSpecV2Schema.shape.routes,
    entities: pageContentSpecV2Schema.shape.entities,
    faqs: pageContentSpecV2Schema.shape.faqs,
    officialLinks: pageContentSpecV2Schema.shape.officialLinks,
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = pageContentSpecV2Schema.safeParse({
      schemaVersion: 2,
      routes: value.routes,
      entities: value.entities,
      faqs: value.faqs,
      officialLinks: value.officialLinks,
    });
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Generated content does not satisfy PageContentSpecV2",
      });
    }
  });

export const siteOpsGeneratedContentSchema = z.union([
  siteOpsGeneratedContentV2Schema,
  siteOpsGeneratedContentV1Schema,
]);

export const siteOpsRuntimeVisualSchema = z.union([
  siteOpsRuntimeVisualEvidenceV2Schema,
  siteOpsRuntimeVisualEvidenceV1Schema,
]);

export const siteOpsAssetDecisionSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    decision: z.enum(["publish", "omit", "quarantine"]),
  })
  .strict();

export const siteOpsFrozenRuntimeInputSchema = z
  .object({
    schemaVersion: z.literal(2),
    build: z
      .object({
        id: z.string().uuid(),
        projectId: z.string().uuid(),
        userId: z.number().int().positive(),
        knowledgeSnapshotId: z.string().max(36),
        knowledgeArchiveHash: z.string().regex(/^[a-f0-9]{64}$/u),
        workflowUpstreamVersion: z.string().min(1).max(32),
        workflowUpstreamHash: z.string().regex(/^[a-f0-9]{64}$/u),
        workflowVersion: z.string().min(1).max(32),
        workflowPackageHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        starterVersion: z.string().min(1).max(32),
        selectionHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
      })
      .strict(),
    host: z
      .object({
        starterSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        componentLibraryVersion: z.string().min(1).max(32),
        materializerVersion: z.string().min(1).max(32),
        materializerSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        renderer: z
          .enum([
            LEGACY_ASTRO_RENDERER,
            REACT_STATIC_RENDERER_V1,
            REACT_STATIC_RENDERER,
          ])
          .default(LEGACY_ASTRO_RENDERER),
      })
      .strict(),
    snapshot: z
      .object({
        id: z.string().max(36),
        userId: z.number().int().positive(),
        archiveHash: z.string().regex(/^[a-f0-9]{64}$/u),
        sourceBuildId: z.string().max(36).nullable(),
        sourceBuildRevision: z.number().int().nullable(),
        sourceDocumentIds: z
          .array(z.string().trim().min(1).max(191))
          .min(1)
          .max(1_000),
      })
      .strict(),
    brief: siteBriefSchema,
    visual: z.union([
      siteOpsRuntimeVisualEvidenceV2Schema,
      siteOpsRuntimeVisualEvidenceV1Schema,
    ]),
    designSpec: z.union([siteDesignSpecV2Schema, siteDesignSpecV1Schema]),
    generatedContent: siteOpsGeneratedContentSchema,
    /** Present only when a validated SiteContentPatchV1 was applied to the
     * immutable 2.4 baseline. Optional fields preserve every older source
     * archive as an exact read-only input. */
    renderMode: z.literal("content_patch").optional(),
    contentPatchUsesTrustedDefaults: z.boolean().optional(),
    assetDecisions: z.array(siteOpsAssetDecisionSchema).max(500),
    brandAsset: z
      .object({
        schemaVersion: z.literal(1),
        assetId: z.string().trim().min(1).max(191),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        mimeType: z.enum([
          "image/jpeg",
          "image/png",
          "image/svg+xml",
          "image/webp",
        ]),
        publicPath: z.string().trim().min(1).max(191),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(8 * 1024 * 1024),
        width: z.number().int().positive().max(8_192),
        height: z.number().int().positive().max(8_192),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type SiteOpsGeneratedContent = z.infer<
  typeof siteOpsGeneratedContentSchema
>;
export type SiteOpsGeneratedContentV2 = z.infer<
  typeof siteOpsGeneratedContentV2Schema
>;

function isSiteOpsGeneratedContentV2(
  value: SiteOpsGeneratedContent,
): value is SiteOpsGeneratedContentV2 {
  return (
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion === 2
  );
}
export type SiteOpsRuntimeVisual =
  | SiteOpsRuntimeVisualEvidenceV1
  | SiteOpsRuntimeVisualEvidenceV2;
export type SiteOpsDesignSpec = SiteDesignSpecV1 | SiteDesignSpecV2;

type TrustedBuildCoordinates = Pick<
  SiteBuild,
  | "id"
  | "projectId"
  | "userId"
  | "knowledgeSnapshotId"
  | "knowledgeArchiveHash"
  | "workflowUpstreamVersion"
  | "workflowUpstreamHash"
  | "workflowVersion"
  | "workflowPackageHash"
  | "starterVersion"
  | "selectionHash"
>;

type TrustedSnapshot = Pick<
  KnowledgeBaseSnapshot,
  | "id"
  | "userId"
  | "archiveHash"
  | "sourceBuildId"
  | "sourceBuildRevision"
  | "documents"
>;

export type MaterializeAstroSiteInput = {
  build: TrustedBuildCoordinates;
  snapshot: TrustedSnapshot;
  brief: SiteBrief | unknown;
  visual: SiteOpsRuntimeVisual | unknown;
  designSpec: SiteOpsDesignSpec | unknown;
  generatedContent: SiteOpsGeneratedContent | unknown;
  mode: "preview" | "production";
  canonicalOrigin?: string | null;
  target?: "global_excluding_cn" | "mainland_cn";
  assetDecisions?: z.infer<typeof siteOpsAssetDecisionSchema>[];
  brandAsset?: TrustedSiteBrandAsset | null;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Internal-only escape hatch for a first build whose provider result
   * cannot safely alter the host baseline. The supplied code is a diagnostic
   * coordinate, never provider content. */
  forceTrustedFallback?: {
    warningCode: string;
  };
  /** A validated SiteContentPatchV1 changed content slots on the immutable
   * host baseline. Rendering remains the same trusted local build path; this
   * marker only makes the public delivery provenance explicit. */
  renderModeOverride?: "content_patch";
  /** At least one invalid patch child retained its frozen Brief value. This
   * marker is public-safe; individual slot/provider diagnostics stay private. */
  contentPatchUsesTrustedDefaults?: boolean;
};

export type SiteOpsQaReport = {
  schemaVersion: 1;
  policyVersion: string;
  passed: true;
  mode: "preview" | "production";
  routes: string[];
  checks: Array<{ id: string; passed: true; detail: string }>;
  browser: {
    available: boolean;
    lighthouse: {
      performance: number | null;
      accessibility: number | null;
      bestPractices: number | null;
      seo: number | null;
      cls: number | null;
    };
    axeViolationCount: number;
    axeViolationIds: string[];
    screenshotFiles: string[];
  };
  buildDelivery: SiteOpsBuildDelivery;
  warnings: SiteOpsQaWarning[];
  fileCount: number;
  totalBytes: number;
};

export type SiteOpsQaWarning = {
  phase: "react_static_build" | "browser_qa" | "lighthouse";
  code: string;
  checkId: string;
};

export type SiteOpsBuildDelivery = {
  renderMode: "primary" | "content_patch" | "trusted_fallback";
  qaStatus: "passed" | "passed_with_warnings" | "partial";
  warningCodes: string[];
};

export type MaterializedAstroSite = {
  contract: BuildContractV2 | BuildContractV3 | BuildContractV4;
  contractJson: Buffer;
  contractSha256: string;
  sourceZip: Buffer;
  sourceSha256: string;
  distZip: Buffer;
  distSha256: string;
  qaJson: Buffer;
  qaSha256: string;
  visualQaZip: Buffer;
  visualQaSha256: string;
  provenanceJson: Buffer;
  provenanceSha256: string;
  buildLog: Buffer;
  files: ReadonlyMap<string, Buffer>;
  buildDelivery: SiteOpsBuildDelivery;
};

type SourceFile = { path: string; bytes: Buffer };

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBuffer(value: unknown) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value: string) {
  return escapeHtml(value);
}

function plainMetadataText(value: string) {
  return value
    .replace(/[\[\]<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function assertNoSensitiveText(label: string, value: string) {
  if (SENSITIVE_TEXT.test(value) || FORBIDDEN_DEMO_TEXT.test(value)) {
    throw new Error(`SITEOPS_SENSITIVE_OR_DEMO_TEXT_REJECTED:${label}`);
  }
}

function assertNotAborted(
  signal?: AbortSignal,
  phase:
    | "input_validation"
    | "astro_build"
    | "react_static_build"
    | "browser_qa" = "input_validation",
) {
  if (signal?.aborted) {
    throw new SiteOpsMaterializationError({
      phase,
      code: "SITEOPS_MATERIALIZATION_ABORTED",
      retryClass: "host_transient",
    });
  }
}

function normalizeRouteSlug(value: string) {
  const trimmed = value.trim();
  const withLeadingSlash =
    trimmed === "/" ? "/" : `/${trimmed.replace(/^\/+|\/+$/gu, "")}`;
  if (
    withLeadingSlash.includes("\\") ||
    withLeadingSlash.includes("%") ||
    withLeadingSlash.includes("?") ||
    withLeadingSlash.includes("#") ||
    withLeadingSlash.includes("\0") ||
    withLeadingSlash.normalize("NFKC") !== withLeadingSlash ||
    withLeadingSlash.length > 191
  ) {
    throw new Error("SITEOPS_ROUTE_SLUG_INVALID");
  }
  const segments = withLeadingSlash.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/u.test(segment),
    )
  ) {
    throw new Error("SITEOPS_ROUTE_SLUG_INVALID");
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

function validateCanonicalOrigin(
  mode: "preview" | "production",
  raw?: string | null,
) {
  if (mode === "preview") {
    if (raw) throw new Error("SITEOPS_PREVIEW_CANONICAL_FORBIDDEN");
    return null;
  }
  if (!raw) throw new Error("SITEOPS_PRODUCTION_CANONICAL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SITEOPS_CANONICAL_ORIGIN_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname === "localhost"
  ) {
    throw new Error("SITEOPS_CANONICAL_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function validateInput(
  input: MaterializeAstroSiteInput,
  brandAsset: TrustedSiteBrandAsset | null,
  workflow: SiteOpsMaterializerCoordinates,
  renderer: SiteRenderer,
) {
  const coordinates = z
    .object({
      buildId: z.string().uuid(),
      projectId: z.string().uuid(),
      userId: z.number().int().positive(),
      snapshotId: z.string().uuid(),
    })
    .strict()
    .parse({
      buildId: input.build.id,
      projectId: input.build.projectId,
      userId: input.build.userId,
      snapshotId: input.snapshot.id,
    });
  const brief = siteBriefSchema.parse(input.brief);
  const visual = isReactStaticRenderer(renderer)
    ? siteOpsRuntimeVisualEvidenceV2Schema.parse(input.visual)
    : siteOpsRuntimeVisualEvidenceV1Schema.parse(input.visual);
  const designSpec = isReactStaticRenderer(renderer)
    ? siteDesignSpecV2Schema.parse(input.designSpec)
    : siteDesignSpecV1Schema.parse(input.designSpec);
  if (isReactStaticRenderer(renderer)) {
    const visualV2 = siteOpsRuntimeVisualEvidenceV2Schema.parse(visual);
    const designV2 = siteDesignSpecV2Schema.parse(designSpec);
    if (
      canonicalJson(visualV2.referenceBlueprint) !==
      canonicalJson(designV2.referenceBlueprint)
    ) {
      throw new Error("SITEOPS_REFERENCE_BLUEPRINT_MISMATCH");
    }
  }
  const generatedContent: SiteOpsGeneratedContent =
    renderer === REACT_STATIC_RENDERER
      ? (() => {
          const current = siteOpsGeneratedContentV2Schema.safeParse(
            input.generatedContent,
          );
          if (current.success) return current.data;
          // Frozen pre-2.2 fixtures and source bundles did not carry the typed
          // graph. Keep a narrow deterministic compatibility projection only
          // when the brief itself has no 2.2 inventory/news coordinates.
          if (
            brief.routes.some((route) => route.id === "news") ||
            brief.contentInventory.entries.length > 0
          ) {
            throw current.error;
          }
          const legacy = siteOpsGeneratedContentV1Schema.parse(
            input.generatedContent,
          );
          return legacy;
        })()
      : siteOpsGeneratedContentV1Schema.parse(input.generatedContent);
  const canonicalOrigin = validateCanonicalOrigin(
    input.mode,
    input.canonicalOrigin,
  );
  if (
    !/^[a-f0-9]{64}$/u.test(input.build.knowledgeArchiveHash) ||
    input.snapshot.archiveHash !== input.build.knowledgeArchiveHash ||
    input.snapshot.id !== input.build.knowledgeSnapshotId ||
    input.snapshot.userId !== coordinates.userId
  ) {
    throw new Error("SITEOPS_SNAPSHOT_COORDINATES_MISMATCH");
  }
  if (
    input.build.workflowUpstreamVersion !== workflow.upstreamVersion ||
    input.build.workflowUpstreamHash !== workflow.upstreamSha256 ||
    input.build.workflowVersion !== workflow.frontMindVersion ||
    (input.build.workflowPackageHash !== null &&
      input.build.workflowPackageHash !== workflow.runtimeManifestSha256) ||
    input.build.starterVersion !== workflow.starterVersion
  ) {
    throw new Error("SITEOPS_WORKFLOW_COORDINATES_MISMATCH");
  }
  const sourceDocuments = new Map<string, KnowledgeDocumentRecord>();
  let sourceCharacters = 0;
  for (const document of input.snapshot.documents) {
    if (!document.id || sourceDocuments.has(document.id)) {
      throw new Error("SITEOPS_SOURCE_DOCUMENT_ID_INVALID");
    }
    sourceCharacters += document.content.length;
    if (sourceCharacters > 5_000_000 || input.snapshot.documents.length > 500) {
      throw new Error("SITEOPS_SOURCE_DOCUMENTS_TOO_LARGE");
    }
    sourceDocuments.set(document.id, document);
  }
  const routes = brief.routes.map((route) => ({
    ...route,
    slug: normalizeRouteSlug(route.slug),
  }));
  const routeIds = new Set(routes.map((route) => route.id));
  const slugs = new Set(routes.map((route) => route.slug));
  if (
    routeIds.size !== routes.length ||
    slugs.size !== routes.length ||
    !slugs.has("/") ||
    routes.some((route) =>
      route.sourceDocumentIds.some((id) => !sourceDocuments.has(id)),
    )
  ) {
    throw new Error("SITEOPS_ROUTE_CONTRACT_INVALID");
  }
  const generatedByRoute = new Map(
    generatedContent.routes.map((route) => [route.routeId, route]),
  );
  if (
    generatedByRoute.size !== routes.length ||
    generatedContent.routes.length !== routes.length ||
    generatedContent.routes.some((route) => !routeIds.has(route.routeId))
  ) {
    throw new Error("SITEOPS_GENERATED_ROUTE_SET_MISMATCH");
  }
  validateDesignAndContentBindings({
    routeIds: routes.map((route) => route.id),
    paletteSize: visual.taxonomy.palette.length,
    designSpec,
    pageContent: isSiteOpsGeneratedContentV2(generatedContent)
      ? {
          schemaVersion: 2,
          routes: generatedContent.routes,
          entities: generatedContent.entities,
          faqs: generatedContent.faqs,
          officialLinks: generatedContent.officialLinks,
        }
      : { schemaVersion: 1, routes: generatedContent.routes },
  });
  if (
    canonicalJson(generatedContent.seo) !== canonicalJson(designSpec.seoPlan)
  ) {
    throw new Error("SITEOPS_SEO_PLAN_MISMATCH");
  }
  for (const route of routes) {
    const generated = generatedByRoute.get(route.id)!;
    const allowedSources = new Set(route.sourceDocumentIds);
    for (const section of generated.sections) {
      if (section.sourceDocumentIds.some((id) => !allowedSources.has(id))) {
        throw new Error("SITEOPS_GENERATED_SOURCE_MAPPING_INVALID");
      }
    }
  }
  if (isSiteOpsGeneratedContentV2(generatedContent)) {
    const typedGeneratedByRoute = new Map(
      generatedContent.routes.map((route) => [route.routeId, route]),
    );
    const inventoryByKind = new Map(
      brief.contentInventory.entries.map((entry) => [entry.kind, entry]),
    );
    const newsRoute = typedGeneratedByRoute.get("news");
    const newsInventory = inventoryByKind.get("company_news");
    if (
      brief.routes.some((route) => route.id === "news") &&
      (!newsRoute ||
        (newsInventory
          ? newsRoute.emptyState === "company_news_unavailable"
          : newsRoute.emptyState !== "company_news_unavailable"))
    ) {
      throw new Error("SITEOPS_COMPANY_NEWS_EMPTY_STATE_MISMATCH");
    }
    const inventoryKindForEntity = {
      product: "product",
      service: "service",
      application: "application",
      case_study: "case_study",
      blog: "blog",
      company_news: "company_news",
    } as const;
    for (const entity of generatedContent.entities) {
      const inventory = inventoryByKind.get(
        inventoryKindForEntity[entity.entityType],
      );
      const allowed = new Set(inventory?.sourceDocumentIds ?? []);
      if (
        !inventory ||
        entity.sourceDocumentIds.some((documentId) => !allowed.has(documentId))
      ) {
        throw new Error("SITEOPS_CONTENT_ENTITY_INVENTORY_MISMATCH");
      }
    }
    const faqSources = new Set(
      inventoryByKind.get("faq")?.sourceDocumentIds ?? [],
    );
    if (
      generatedContent.faqs.some((faq) =>
        faq.sourceDocumentIds.some((documentId) => !faqSources.has(documentId)),
      ) ||
      generatedContent.officialLinks.some((link) =>
        link.sourceDocumentIds.some(
          (documentId) => !sourceDocuments.has(documentId),
        ),
      )
    ) {
      throw new Error("SITEOPS_CONTENT_RECORD_SOURCE_MAPPING_INVALID");
    }
  }
  const allText = canonicalJson({ brief, designSpec, generatedContent });
  if (Buffer.byteLength(allText, "utf8") > 2_000_000) {
    throw new Error("SITEOPS_GENERATED_CONTENT_TOO_LARGE");
  }
  assertNoSensitiveText("generated-content", allText);
  const assetDecisions = z
    .array(siteOpsAssetDecisionSchema)
    .max(500)
    .parse(input.assetDecisions ?? []);
  if (
    new Set(assetDecisions.map((item) => item.id)).size !==
    assetDecisions.length
  ) {
    throw new Error("SITEOPS_ASSET_DECISION_DUPLICATE");
  }
  const decisionsByHash = new Map<
    string,
    Set<(typeof assetDecisions)[number]["decision"]>
  >();
  for (const decision of assetDecisions) {
    const decisions = decisionsByHash.get(decision.sha256) ?? new Set();
    decisions.add(decision.decision);
    decisionsByHash.set(decision.sha256, decisions);
  }
  if (
    [...decisionsByHash.values()].some(
      (decisions) => decisions.has("publish") && decisions.has("quarantine"),
    )
  ) {
    throw new SiteOpsMaterializationError({
      phase: "asset_projection",
      code: "SITEOPS_ASSET_DECISION_HASH_CONFLICT",
      retryClass: "host_deterministic",
      safeDetails: {
        assetDecisionCount: assetDecisions.length,
        publishedCount: assetDecisions.filter(
          (item) => item.decision === "publish",
        ).length,
        omittedDuplicateCount: assetDecisions.filter(
          (item) => item.decision === "omit",
        ).length,
        quarantineCount: assetDecisions.filter(
          (item) => item.decision === "quarantine",
        ).length,
      },
    });
  }
  const publishedAssets = assetDecisions.filter(
    (item) => item.decision === "publish",
  );
  if (
    publishedAssets.length > 1 ||
    (publishedAssets.length === 0 && brandAsset !== null) ||
    (publishedAssets.length === 1 &&
      (!brandAsset ||
        brandAsset.assetId !== publishedAssets[0]!.id ||
        brandAsset.sha256 !== publishedAssets[0]!.sha256))
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_DECISION_MISMATCH");
  }
  return {
    brief: { ...brief, routes },
    visual,
    designSpec,
    generatedContent,
    generatedByRoute,
    sourceDocuments,
    canonicalOrigin,
    assetDecisions,
    brandAsset,
  };
}

function routeOutputPath(slug: string) {
  return slug === "/" ? "index.html" : `${slug.slice(1)}index.html`;
}

function routeSourcePath(slug: string) {
  return slug === "/"
    ? "src/pages/index.astro"
    : `src/pages/${slug.slice(1)}index.astro`;
}

function routeCanonical(origin: string, slug: string) {
  return `${origin}${slug}`;
}

const contentEntityRoutePrefix = {
  product: "products",
  service: "services",
  application: "applications",
  case_study: "cases",
  blog: "blog",
  company_news: "news",
} as const;

function contentEntityRouteSlug(input: {
  entityType: keyof typeof contentEntityRoutePrefix;
  slug: string;
}) {
  return `/${contentEntityRoutePrefix[input.entityType]}/${input.slug}/`;
}

function safeContactHref(kind: "email" | "phone" | "address", value: string) {
  if (kind === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    return `mailto:${value}`;
  }
  if (kind === "phone" && /^[+()0-9\s-]{5,40}$/u.test(value)) {
    return `tel:${value.replace(/[^+0-9]/gu, "")}`;
  }
  return null;
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrastRatio(left: string, right: string) {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

function accessibleTextColor(
  background: string,
  preferred: readonly string[],
  minimum = 4.5,
) {
  const candidates = [...new Set([...preferred, "#000000", "#FFFFFF"])].filter(
    (candidate) => /^#[a-f0-9]{6}$/iu.test(candidate),
  );
  return (
    candidates.find(
      (candidate) => contrastRatio(candidate, background) >= minimum,
    ) ?? "#000000"
  );
}

function semanticColorTokens(input: {
  canvas: string;
  ink: string;
  accent: string;
  muted: string;
}) {
  const accentText = accessibleTextColor(input.accent, [
    input.canvas,
    input.ink,
  ]);
  const inverseText = accessibleTextColor(input.ink, [input.canvas, "#FFFFFF"]);
  const focus = [input.accent, input.ink, "#000000", "#FFFFFF"].find(
    (candidate) => contrastRatio(candidate, input.canvas) >= 3,
  )!;
  return {
    ...input,
    subtleText: accessibleTextColor(input.canvas, [input.ink]),
    accentText,
    inverseSurface: input.ink,
    inverseText,
    border: accessibleTextColor(input.canvas, [input.ink], 3),
    focus,
  };
}

function siteDesignMaterializationProjectionFor(
  input: unknown,
  workflow: SiteOpsMaterializerCoordinates,
  renderer: SiteRenderer,
) {
  const reactCoordinates = isReactStaticRenderer(renderer)
    ? reactStaticCoordinatesForWorkflow(workflow)
    : null;
  const design = isReactStaticRenderer(renderer)
    ? siteDesignSpecV2Schema.parse(input)
    : siteDesignSpecV1Schema.parse(input);
  const heroFamily =
    design.schemaVersion === 2
      ? design.referenceBlueprint.heroFamily
      : design.heroVariant;
  const referenceBlueprint =
    design.schemaVersion === 2 ? design.referenceBlueprint : null;
  const hasFrozenVisualTokens =
    referenceBlueprint?.schemaVersion === 3 ||
    referenceBlueprint?.schemaVersion === 4;
  const blueprintClasses =
    design.schemaVersion === 2
      ? [
          ...(design.referenceBlueprint.schemaVersion === 4
            ? ["preview-contract--v4"]
            : []),
          `align--${design.referenceBlueprint.alignment}`,
          `emphasis--${design.referenceBlueprint.contentEmphasis}`,
          `media-region--${design.referenceBlueprint.mediaRegion}`,
          `media-ratio--${design.referenceBlueprint.mediaRatio}`,
          `media-strategy--${design.referenceBlueprint.mediaStrategy}`,
          `container--${design.referenceBlueprint.containerStyle}`,
          `composition--${design.referenceBlueprint.composition}`,
          `background--${design.referenceBlueprint.backgroundStyle}`,
          `gradient--${design.referenceBlueprint.gradientStyle}`,
          `border--${design.referenceBlueprint.borderStyle}`,
          `radius--${design.referenceBlueprint.radiusStyle}`,
          `decoration--${design.referenceBlueprint.decorationStyle}`,
          `nav-style--${design.referenceBlueprint.navStyle}`,
          `cta-style--${design.referenceBlueprint.ctaStyle}`,
          `card-style--${design.referenceBlueprint.cardStyle}`,
          `typography--${design.referenceBlueprint.typographyStyle}`,
          `responsive--${design.referenceBlueprint.responsiveBehavior}`,
          `motion--${design.referenceBlueprint.motionLevel}`,
          ...(design.referenceBlueprint.schemaVersion === 3 ||
          design.referenceBlueprint.schemaVersion === 4
            ? [
                `type-system--${design.referenceBlueprint.typeSystem}`,
                `density--${design.referenceBlueprint.density}`,
              ]
            : []),
        ]
      : [];
  return {
    bodyClass: [
      `layout--${design.layoutArchetype}`,
      `surface--${design.surfaceStyle}`,
      ...(hasFrozenVisualTokens ? [] : [`type--${design.typeScale}`]),
      `image--${design.imageTreatment}`,
      ...(hasFrozenVisualTokens ? [] : [`motion--${design.motionLevel}`]),
      ...blueprintClasses,
    ].join(" "),
    heroClass: `hero hero--${heroFamily}`,
    heroFamily,
    componentManifest: {
      schemaVersion: isReactStaticRenderer(renderer) ? 2 : 1,
      componentLibraryVersion: isReactStaticRenderer(renderer)
        ? reactCoordinates!.componentLibraryVersion
        : workflow.componentLibraryVersion,
      materializerVersion: isReactStaticRenderer(renderer)
        ? reactCoordinates!.materializerVersion
        : workflow.materializerVersion,
      layoutArchetype: design.layoutArchetype,
      ...(design.schemaVersion === 1
        ? { heroVariant: design.heroVariant }
        : { referenceBlueprint: design.referenceBlueprint }),
      renderer,
      heroFamily,
      routes: design.routeCompositions,
    },
  };
}

function trustedVisualContractV4(design: SiteDesignSpecV2) {
  const blueprint = design.referenceBlueprint;
  if (blueprint.schemaVersion !== 4) return null;
  return {
    schemaVersion: 4 as const,
    blueprintHash: blueprint.blueprintHash,
    styleSignature: blueprint.styleSignature,
    heroFamily: blueprint.heroFamily,
    palette: blueprint.palette,
    typeSystem: blueprint.typeSystem,
    alignment: blueprint.alignment,
    contentEmphasis: blueprint.contentEmphasis,
    mediaRegion: blueprint.mediaRegion,
    mediaRatio: blueprint.mediaRatio,
    mediaStrategy: blueprint.mediaStrategy,
    composition: blueprint.composition,
    backgroundStyle: blueprint.backgroundStyle,
    gradientStyle: blueprint.gradientStyle,
    borderStyle: blueprint.borderStyle,
    radiusStyle: blueprint.radiusStyle,
    decorationStyle: blueprint.decorationStyle,
    navStyle: blueprint.navStyle,
    ctaStyle: blueprint.ctaStyle,
    cardStyle: blueprint.cardStyle,
    containerStyle: blueprint.containerStyle,
    typographyStyle: blueprint.typographyStyle,
    density: blueprint.density,
    responsiveBehavior: blueprint.responsiveBehavior,
    motionLevel: blueprint.motionLevel,
    componentManifest: blueprint.componentManifest,
  };
}

export function siteDesignMaterializationProjection(input: unknown) {
  return siteDesignMaterializationProjectionFor(
    input,
    SITEOPS_WORKFLOW,
    REACT_STATIC_RENDERER,
  );
}

export function siteOpsVisualCssTokens(
  visual: SiteOpsRuntimeVisual,
  design: SiteOpsDesignSpec,
) {
  if (
    design.schemaVersion === 2 &&
    (design.referenceBlueprint.schemaVersion === 3 ||
      design.referenceBlueprint.schemaVersion === 4)
  ) {
    const blueprint = design.referenceBlueprint;
    assertVisualPaletteContrastV3(blueprint.palette);
    const radius = {
      none: "0px",
      soft: "8px",
      rounded: "22px",
      pill: "999px",
    }[blueprint.radiusStyle];
    const font = {
      display_sans:
        "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      editorial_serif: "Georgia, 'Times New Roman', serif",
      technical_sans:
        "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace",
      humanist_sans: "'Trebuchet MS', ui-sans-serif, system-ui, sans-serif",
    }[blueprint.typeSystem];
    const heroSize =
      blueprint.typographyStyle === "restrained" ||
      blueprint.typographyStyle === "technical"
        ? "clamp(2.4rem,6vw,5.2rem)"
        : blueprint.typographyStyle === "display"
          ? "clamp(3rem,9vw,7.4rem)"
          : "clamp(2.7rem,8vw,6.8rem)";
    const gap =
      blueprint.density === "compact"
        ? "12px"
        : blueprint.density === "spacious"
          ? "32px"
          : "20px";
    const sectionPadding =
      blueprint.density === "compact"
        ? "24px"
        : blueprint.density === "spacious"
          ? "56px"
          : "40px";
    return {
      ...semanticColorTokens(blueprint.palette),
      typeSystem: blueprint.typeSystem,
      density: blueprint.density,
      radiusStyle: blueprint.radiusStyle,
      motionLevel: blueprint.motionLevel,
      typographyStyle: blueprint.typographyStyle,
      radius,
      font,
      heroSize,
      gap,
      sectionPadding,
    };
  }

  const colors = visual.taxonomy.palette.filter((value) =>
    /^#[a-f0-9]{6}$/iu.test(value),
  );
  const canvasCandidate =
    colors[design.colorRoles.backgroundPaletteIndex] ?? "#F5F2EA";
  const inkCandidate = colors[design.colorRoles.textPaletteIndex] ?? "#10212B";
  const accessiblePair = [
    { canvas: canvasCandidate, ink: inkCandidate },
    { canvas: "#F5F2EA", ink: "#10212B" },
    { canvas: "#FFFFFF", ink: "#000000" },
  ].find(({ canvas, ink }) => contrastRatio(ink, canvas) >= 7);
  if (!accessiblePair) {
    throw new Error("SITEOPS_ACCESSIBLE_COLOR_PAIR_UNAVAILABLE");
  }
  const { canvas, ink } = accessiblePair;
  const accentCandidate =
    colors[design.colorRoles.accentPaletteIndex] ?? "#A33A1B";
  const accent = [accentCandidate, ...colors, ink].find(
    (candidate) => contrastRatio(candidate, canvas) >= 4.5,
  );
  if (!accent) {
    throw new Error("SITEOPS_ACCESSIBLE_SEMANTIC_COLOR_UNAVAILABLE");
  }
  const muted = [colors[3], ...colors, canvas]
    .filter((candidate): candidate is string => Boolean(candidate))
    .find(
      (candidate) =>
        contrastRatio(ink, candidate) >= 4.5 &&
        contrastRatio(accent, candidate) >= 4.5,
    );
  if (!muted) {
    throw new Error("SITEOPS_ACCESSIBLE_SEMANTIC_COLOR_UNAVAILABLE");
  }
  const radius =
    design.surfaceStyle === "soft_depth" || design.surfaceStyle === "layered"
      ? "22px"
      : design.surfaceStyle === "bordered"
        ? "8px"
        : "2px";
  const font =
    design.typeScale === "editorial"
      ? "Georgia, 'Times New Roman', serif"
      : "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const heroSize =
    design.typeScale === "restrained"
      ? "clamp(2.4rem,6vw,5.2rem)"
      : design.typeScale === "display"
        ? "clamp(3rem,9vw,7.4rem)"
        : "clamp(2.7rem,8vw,6.8rem)";
  const gap =
    design.density === "compact"
      ? "12px"
      : design.density === "spacious"
        ? "32px"
        : "20px";
  const sectionPadding =
    design.density === "compact"
      ? "24px"
      : design.density === "spacious"
        ? "56px"
        : "40px";
  return {
    ...semanticColorTokens({ canvas, ink, accent, muted }),
    typeSystem: null,
    density: design.density,
    radiusStyle: null,
    motionLevel: design.motionLevel,
    typographyStyle: null,
    radius,
    font,
    heroSize,
    gap,
    sectionPadding,
  };
}

function cssForVisualLegacy(
  visual: SiteOpsRuntimeVisual,
  design: SiteOpsDesignSpec,
) {
  const {
    canvas,
    ink,
    accent,
    muted,
    radius,
    font,
    heroSize,
    gap,
    sectionPadding,
    motionLevel,
  } = siteOpsVisualCssTokens(visual, design);
  const baseCss = `:root{color-scheme:light;--ink:${ink};--accent:${accent};--canvas:${canvas};--muted:${muted};--radius:${radius};--gap:${gap};--section-pad:${sectionPadding};font-family:${font}}*{box-sizing:border-box}html{background:var(--canvas);color:var(--ink);scroll-behavior:${motionLevel === "none" ? "auto" : "smooth"}}body{margin:0;min-width:320px;line-height:1.65}a{color:inherit;text-underline-offset:.2em}a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.shell{width:min(1120px,calc(100% - 40px));margin-inline:auto}.site-header{border-bottom:1px solid color-mix(in srgb,var(--ink) 22%,transparent);background:color-mix(in srgb,var(--canvas) 94%,white);position:sticky;top:0;z-index:30;backdrop-filter:blur(18px)}.nav{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-weight:800;letter-spacing:-.025em}.brand-logo{display:block;width:auto;height:40px;max-width:180px;object-fit:contain}.nav-links{display:flex;gap:20px;flex-wrap:wrap;justify-content:flex-end}.nav-links a{text-decoration:none;font-size:.94rem}.hero{position:relative;overflow:hidden;padding:clamp(72px,10vw,144px) 0 64px}.hero--centered_statement .shell{text-align:center}.hero--centered_statement .lede,.hero--centered_statement h1{margin-inline:auto}.hero--split_media .shell,.hero--proof_grid .shell{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(220px,.65fr);gap:var(--gap);align-items:end}.hero--split_media .lede,.hero--proof_grid .lede{border-left:3px solid var(--accent);padding-left:24px}.hero--editorial_lede h1{max-width:18ch}.eyebrow{color:var(--accent);font:700 .78rem/1.2 ui-sans-serif,system-ui;letter-spacing:.14em;text-transform:uppercase}.hero h1{max-width:900px;margin:.35em 0 .32em;font-size:${heroSize};line-height:.95;letter-spacing:-.06em;text-wrap:balance}.lede{max-width:720px;font-size:clamp(1.1rem,2vw,1.36rem)}.facts{display:grid;grid-template-columns:repeat(12,1fr);gap:var(--gap);padding:28px 0 100px}.layout--editorial .facts{display:block;max-width:820px}.layout--modular .section{grid-column:span 4}.layout--split .section{grid-column:span 6}.layout--asymmetric .section:nth-child(3n+1){grid-column:span 7}.layout--asymmetric .section:nth-child(3n+2){grid-column:span 5}.section{grid-column:span 6;padding:24px 20px var(--section-pad)}.surface--bordered .section{border:1px solid color-mix(in srgb,var(--ink) 30%,transparent);border-top:3px solid var(--ink);border-radius:var(--radius)}.surface--soft_depth .section{background:var(--muted);border-radius:var(--radius);box-shadow:0 18px 48px color-mix(in srgb,var(--ink) 10%,transparent)}.surface--layered .section{background:var(--muted);border-radius:var(--radius)}.surface--flat .section{border-top:3px solid var(--ink)}.section--statement{grid-column:span 12}.section--cta{background:var(--ink)!important;color:var(--canvas);border-radius:var(--radius)}.section--timeline{border-left:4px solid var(--accent)}.section--faq h2::before{content:'Q ';color:var(--accent)}.section--proof{border-top-color:var(--accent)}.section h2{font-size:clamp(1.5rem,3vw,2.5rem);line-height:1.1;margin:0 0 18px}.section p{max-width:64ch}.source-note{color:var(--ink);font:600 .72rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.section--cta .source-note,.section--cta .section-index{color:var(--canvas)}.motion--subtle .section{transition:transform .18s ease,box-shadow .18s ease}.motion--subtle .section:hover{transform:translateY(-2px)}.image--masked .brand-logo{border-radius:50%}.image--contained .brand-logo{object-fit:contain}.image--wide .brand-logo{max-width:240px}.contact{background:var(--ink);color:var(--canvas);padding:56px 0}.contact h2{font-size:clamp(2rem,5vw,4rem);margin:.25em 0}.contact-list{list-style:none;padding:0;display:grid;gap:10px}.site-footer{border-top:1px solid color-mix(in srgb,var(--ink) 22%,transparent);padding:28px 0 48px;font-size:.85rem}.footer-row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}@media(max-width:720px){.nav{align-items:flex-start;padding:18px 0}.nav-links{gap:10px 14px}.brand-logo{height:34px;max-width:132px}.facts,.hero--split_media .shell,.hero--proof_grid .shell{display:block}.section{padding-block:28px;margin-bottom:var(--gap)}.hero h1{letter-spacing:-.045em}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.motion--subtle .section{transition:none}.motion--subtle .section:hover{transform:none}}`;
  const componentCss = `.hero-copy{position:relative;z-index:2}.hero-orbit-layout,.hero-split,.hero-proof{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.82fr);align-items:center;gap:clamp(28px,6vw,88px)}.hero-art{min-width:0}.orbit-art{display:block;width:100%;height:auto;max-height:620px;color:var(--ink)}.orbit-art__halo{fill:color-mix(in srgb,var(--accent) 11%,transparent);stroke:none}.orbit-art__ring{fill:none;stroke:currentColor;stroke-width:1.5;stroke-dasharray:7 12;opacity:.28}.orbit-art__ring--inner{stroke:var(--accent);stroke-dasharray:2 10}.orbit-art__dna,.orbit-art__molecule,.orbit-art__cell,.orbit-art__timeline{fill:none;stroke:currentColor;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.orbit-art__dna circle,.orbit-art__molecule circle,.orbit-art__cell circle,.orbit-art__timeline circle{fill:var(--canvas);stroke:var(--accent)}.orbit-art__cell{stroke:var(--accent)}.orbit-art__timeline{stroke-width:4}.hero-feature-grid{list-style:none;margin:48px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid color-mix(in srgb,var(--ink) 28%,transparent)}.hero-feature-grid li{display:grid;gap:12px;padding:24px;border-right:1px solid color-mix(in srgb,var(--ink) 28%,transparent)}.hero-feature-grid li:last-child{border:0}.hero-feature-grid span,.section-index{color:var(--accent);font:700 .72rem/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}.hero-bento{display:grid;grid-template-columns:1.45fr .55fr .55fr;grid-template-rows:auto auto;gap:var(--gap)}.hero-bento__copy{grid-row:span 2;padding:clamp(28px,5vw,64px);border:1px solid color-mix(in srgb,var(--ink) 24%,transparent);border-radius:var(--radius)}.hero-bento__signal,.hero-bento__summary,.hero-bento__mark{padding:28px;border-radius:var(--radius);background:var(--muted)}.hero-bento__signal{display:flex;flex-direction:column;justify-content:space-between;gap:64px}.hero-bento__signal span{color:var(--accent)}.hero-bento__mark{display:grid;place-items:center;background:var(--accent);color:var(--canvas);font-size:clamp(3rem,7vw,7rem)}.hero-split__media{aspect-ratio:4/5;position:relative;display:grid;place-items:end start;padding:32px;overflow:hidden;border-radius:var(--radius);background:linear-gradient(145deg,var(--ink),color-mix(in srgb,var(--ink) 72%,var(--accent)));color:var(--canvas)}.hero-split__disc{position:absolute;border-radius:50%;border:1px solid color-mix(in srgb,var(--canvas) 60%,transparent)}.hero-split__disc--one{width:80%;aspect-ratio:1;right:-24%;top:-12%}.hero-split__disc--two{width:45%;aspect-ratio:1;left:10%;bottom:10%;background:color-mix(in srgb,var(--accent) 64%,transparent)}.hero-split__media strong{position:relative;font-size:clamp(1.5rem,3vw,3rem);line-height:1.05}.hero-editorial{border-bottom:1px solid color-mix(in srgb,var(--ink) 28%,transparent)}.hero-editorial{display:grid;grid-template-columns:1fr minmax(0,1120px) 1fr}.hero-editorial>.shell{grid-column:2}.hero-editorial__folio{font:600 .7rem/1 ui-monospace,monospace;letter-spacing:.16em;border-bottom:1px solid currentColor;padding-bottom:16px}.hero-editorial__note{max-width:28ch;margin:48px 0 0 auto;border-left:3px solid var(--accent);padding-left:20px}.hero-centered{text-align:center}.hero-centered .hero-copy>*{margin-inline:auto}.hero-actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:32px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:1px solid currentColor;border-radius:999px;text-decoration:none;font-weight:750}.button--primary{background:var(--ink);color:var(--canvas)}.button--secondary{background:transparent}.button--inverse{background:var(--canvas);color:var(--ink);align-self:center}.hero--immersive_visual{min-height:min(820px,86vh);display:grid;align-items:end;background:var(--ink);color:var(--canvas)}.hero-immersive__field{position:absolute;inset:0;background:radial-gradient(circle at 18% 20%,color-mix(in srgb,var(--accent) 64%,transparent),transparent 28%),radial-gradient(circle at 82% 45%,color-mix(in srgb,var(--canvas) 20%,transparent),transparent 26%)}.hero-immersive__field i{position:absolute;border:1px solid color-mix(in srgb,var(--canvas) 44%,transparent);border-radius:50%;aspect-ratio:1}.hero-immersive__field i:nth-child(1){width:44%;right:4%;top:8%}.hero-immersive__field i:nth-child(2){width:24%;right:27%;top:28%}.hero-immersive__field i:nth-child(3){width:12%;left:12%;top:14%;background:var(--accent)}.hero-immersive__copy{position:relative;padding-bottom:clamp(72px,10vw,136px)}.hero--immersive_visual .eyebrow{color:var(--canvas)}.product-stage{margin-top:56px;border:1px solid color-mix(in srgb,var(--ink) 32%,transparent);border-radius:calc(var(--radius) + 8px);background:color-mix(in srgb,var(--canvas) 82%,white);box-shadow:0 36px 100px color-mix(in srgb,var(--ink) 18%,transparent);overflow:hidden}.product-stage__bar{display:flex;gap:7px;padding:15px 18px;border-bottom:1px solid color-mix(in srgb,var(--ink) 20%,transparent)}.product-stage__bar span{width:10px;height:10px;border-radius:50%;background:var(--accent)}.product-stage__body{min-height:320px;display:grid;grid-template-columns:180px 1fr}.product-stage__body aside{background:color-mix(in srgb,var(--ink) 92%,var(--accent))}.product-stage__body>div{display:grid;gap:18px;align-content:center;padding:clamp(30px,6vw,80px)}.product-stage__body strong{font-size:clamp(1.8rem,4vw,4rem)}.product-stage__body span{height:12px;background:var(--muted);border-radius:99px}.product-stage__body span:last-child{width:62%}.hero-proof__grid{display:grid;grid-template-columns:auto 1fr;margin:0;border-top:1px solid currentColor}.hero-proof__grid dt,.hero-proof__grid dd{margin:0;padding:20px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 24%,transparent)}.hero-proof__grid dt{padding-right:24px;color:var(--accent);font-family:ui-monospace,monospace}.hero--full_bleed_statement{padding-inline:20px;background:var(--accent);color:var(--canvas)}.hero-statement__rail{position:absolute;inset:0 auto 0 16px;writing-mode:vertical-rl;text-transform:uppercase;letter-spacing:.2em;font-size:.65rem;padding-top:28px}.hero-statement h1{max-width:15ch;font-size:clamp(3.4rem,11vw,9.5rem)}.hero--full_bleed_statement .eyebrow{color:var(--canvas)}.section-index{display:inline-block;margin-bottom:16px}.section blockquote{margin:0;font-size:clamp(1.35rem,2.7vw,2.4rem);line-height:1.25}.section--statement blockquote{max-width:34ch}.section--split{display:grid;grid-template-columns:minmax(180px,.7fr) minmax(0,1.3fr);gap:var(--gap);align-content:start}.section--split .source-note{grid-column:2}.mini-card-grid{display:grid;gap:10px}.mini-card{padding:18px;border:1px solid color-mix(in srgb,var(--ink) 22%,transparent);border-radius:max(4px,calc(var(--radius) / 2))}.mini-card span{color:var(--accent);font:700 .7rem/1 ui-monospace,monospace}.mini-card p{margin:.7em 0 0}.timeline-list{list-style:none;padding:0;margin:28px 0}.timeline-list li{position:relative;display:grid;grid-template-columns:48px 1fr;gap:16px;padding:0 0 28px}.timeline-list li:not(:last-child)::after{content:'';position:absolute;left:15px;top:28px;bottom:0;border-left:1px solid var(--accent)}.timeline-list span{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--accent);color:var(--canvas);font:700 .65rem/1 ui-monospace,monospace}.timeline-list p{margin:3px 0}.section--faq dl,.section--faq dd{margin:0}.section--faq dt{display:flex;gap:18px;font-size:clamp(1.4rem,3vw,2.5rem);font-weight:750;line-height:1.15}.section--faq dt span{color:var(--accent)}.section--faq dd{padding:20px 0 0 52px}.section--proof figure,.section--proof blockquote{margin:0}.section--proof figcaption{margin-bottom:24px}.section--cta{grid-column:span 12;display:grid;grid-template-columns:1fr auto;gap:32px;align-items:center}.section--cta .source-note{grid-column:1/-1}@media(max-width:800px){.hero-orbit-layout,.hero-split,.hero-proof,.hero-bento{grid-template-columns:1fr}.hero-bento__copy{grid-row:auto}.hero-bento__signal{gap:24px}.hero-feature-grid{grid-template-columns:1fr}.hero-feature-grid li{border-right:0;border-bottom:1px solid color-mix(in srgb,var(--ink) 24%,transparent)}.hero-feature-grid li:last-child{border-bottom:0}.hero-art{max-width:620px;margin-inline:auto}.product-stage__body{grid-template-columns:70px 1fr}.section--split,.section--cta{display:block}.section--split .source-note{grid-column:auto}.button--inverse{margin-top:20px}}@media(prefers-reduced-motion:no-preference){.motion--floating_subtle .orbit-art__ring--outer{animation:orbit-spin 32s linear infinite;transform-origin:center}.motion--floating_subtle .orbit-art__cell{animation:orbit-float 6s ease-in-out infinite;transform-origin:center}@keyframes orbit-spin{to{transform:rotate(360deg)}}@keyframes orbit-float{50%{transform:translateY(-12px)}}}@media(prefers-reduced-motion:reduce){.orbit-art *{animation:none!important}}`;
  const orbitCss = `.hero-orbit-stage{position:relative;min-height:clamp(620px,76vw,820px);display:grid;place-items:center}.hero-orbit__copy{position:relative;z-index:4;width:min(720px,72%);text-align:center;padding:56px 36px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--canvas) 96%,white) 0 48%,color-mix(in srgb,var(--canvas) 84%,transparent) 68%,transparent 72%)}.hero-orbit__copy .hero-copy>*{margin-inline:auto}.orbit-motif{position:absolute;z-index:2;width:clamp(150px,22vw,260px);aspect-ratio:1;color:var(--ink);filter:drop-shadow(0 22px 36px color-mix(in srgb,var(--ink) 13%,transparent))}.orbit-motif svg{display:block;width:100%;height:100%;overflow:visible}.orbit-motif__halo{fill:color-mix(in srgb,var(--canvas) 82%,white);stroke:color-mix(in srgb,var(--ink) 22%,transparent);stroke-width:1.5}.orbit-motif__drawing{fill:none;stroke:currentColor;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.orbit-motif__drawing circle{fill:var(--canvas);stroke:var(--accent)}.orbit-motif--dna{left:-2%;top:2%;transform:rotate(-12deg)}.orbit-motif--molecule{right:-1%;top:3%;transform:rotate(9deg)}.orbit-motif--cell{right:4%;bottom:0;transform:rotate(-5deg)}.orbit-motif--cell .orbit-motif__drawing{stroke:var(--accent)}.orbit-motif--timeline{left:1%;bottom:-1%;transform:rotate(6deg)}.orbit-motif--timeline .orbit-motif__drawing{stroke-width:4}@media(max-width:800px){.hero-orbit-stage{min-height:auto;padding:360px 0 330px}.hero-orbit__copy{width:100%;padding:40px 18px}.orbit-motif{width:min(42vw,190px)}.orbit-motif--dna{left:0;top:18px}.orbit-motif--molecule{right:0;top:88px}.orbit-motif--cell{right:2%;bottom:22px}.orbit-motif--timeline{left:0;bottom:86px}}@media(max-width:460px){.hero-orbit-stage{padding:270px 0 250px}.orbit-motif{width:145px}.hero-orbit__copy{background:color-mix(in srgb,var(--canvas) 94%,white);border-radius:var(--radius)}}@media(prefers-reduced-motion:no-preference){.motion--floating_subtle .orbit-motif--dna{animation:motif-dna 7s ease-in-out infinite}.motion--floating_subtle .orbit-motif--molecule{animation:motif-molecule 8s ease-in-out infinite}.motion--floating_subtle .orbit-motif--cell{animation:motif-cell 9s ease-in-out infinite}.motion--floating_subtle .orbit-motif--timeline{animation:motif-timeline 7.5s ease-in-out infinite}@keyframes motif-dna{50%{transform:translate(10px,-14px) rotate(-8deg)}}@keyframes motif-molecule{50%{transform:translate(-12px,10px) rotate(14deg)}}@keyframes motif-cell{50%{transform:translate(-8px,-13px) rotate(-1deg)}}@keyframes motif-timeline{50%{transform:translate(12px,8px) rotate(2deg)}}}@media(prefers-reduced-motion:reduce){.orbit-motif{animation:none!important}}`;
  const blueprintCss = `.contact .eyebrow{color:var(--canvas)}.container--wide .shell{width:min(1360px,calc(100% - 40px))}.container--edge_to_edge .hero>.shell{width:100%;max-width:none}.container--contained .hero--floating_orbit .hero-orbit-stage{width:min(1120px,calc(100% - 40px))}.media-strategy--procedural_brand_svg .orbit-motif{display:block}`;
  const visualContractCss =
    design.schemaVersion === 2 && design.referenceBlueprint.schemaVersion === 4
      ? TRUSTED_REACT_VISUAL_CONTRACT_V4_CSS
      : "";
  return `${baseCss}${componentCss}${orbitCss}${blueprintCss}${visualContractCss}`;
}

function cssForVisual(visual: SiteOpsRuntimeVisual, design: SiteOpsDesignSpec) {
  const {
    canvas,
    ink,
    accent,
    muted,
    accentText,
    inverseSurface,
    inverseText,
    border,
    focus,
    radius,
    font,
    heroSize,
    gap,
    sectionPadding,
    motionLevel,
  } = siteOpsVisualCssTokens(visual, design);
  const baseCss = `:root{color-scheme:light;--ink:${ink};--accent:${accent};--accent-text:${accentText};--canvas:${canvas};--muted:${muted};--inverse-surface:${inverseSurface};--inverse-text:${inverseText};--border:${border};--focus:${focus};--radius:${radius};--gap:${gap};--section-pad:${sectionPadding};font-family:${font}}*{box-sizing:border-box}html{background:var(--canvas);color:var(--ink);scroll-behavior:${motionLevel === "none" ? "auto" : "smooth"}}body{margin:0;min-width:320px;line-height:1.65}a{color:inherit;text-underline-offset:.2em}a:focus-visible{outline:3px solid var(--focus);outline-offset:4px}.shell{width:min(1120px,calc(100% - 40px));margin-inline:auto}.site-header{border-bottom:1px solid var(--border);background:var(--canvas);position:sticky;top:0;z-index:30}.nav{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;font-weight:800;letter-spacing:-.025em}.brand-logo{display:block;width:auto;height:40px;max-width:180px;object-fit:contain}.nav-links{display:flex;gap:20px;flex-wrap:wrap;justify-content:flex-end}.nav-links a{text-decoration:none;font-size:.94rem}.hero{position:relative;overflow:hidden;padding:clamp(72px,10vw,144px) 0 64px}.hero--centered_statement .shell{text-align:center}.hero--centered_statement .lede,.hero--centered_statement h1{margin-inline:auto}.hero--split_media .shell,.hero--proof_grid .shell{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(220px,.65fr);gap:var(--gap);align-items:end}.hero--split_media .lede,.hero--proof_grid .lede{border-left:3px solid var(--accent);padding-left:24px}.hero--editorial_lede h1{max-width:18ch}.eyebrow{color:var(--accent);font:700 .78rem/1.2 ui-sans-serif,system-ui;letter-spacing:.14em;text-transform:uppercase}.hero h1{max-width:900px;margin:.35em 0 .32em;font-size:${heroSize};line-height:.95;letter-spacing:-.06em;text-wrap:balance}.lede{max-width:720px;font-size:clamp(1.1rem,2vw,1.36rem)}.facts{display:grid;grid-template-columns:repeat(12,1fr);gap:var(--gap);padding:28px 0 100px}.layout--editorial .facts{display:block;max-width:820px}.layout--modular .section{grid-column:span 4}.layout--split .section{grid-column:span 6}.layout--asymmetric .section:nth-child(3n+1){grid-column:span 7}.layout--asymmetric .section:nth-child(3n+2){grid-column:span 5}.section{grid-column:span 6;padding:24px 20px var(--section-pad)}.surface--bordered .section{border:1px solid var(--border);border-top:3px solid var(--ink);border-radius:var(--radius)}.surface--soft_depth .section{background:var(--muted);border-radius:var(--radius);box-shadow:0 18px 48px color-mix(in srgb,var(--ink) 10%,transparent)}.surface--layered .section{background:var(--muted);border-radius:var(--radius)}.surface--flat .section{border-top:3px solid var(--ink)}.section--statement{grid-column:span 12}.section--cta{background:var(--inverse-surface)!important;color:var(--inverse-text);border-radius:var(--radius)}.section--timeline{border-left:4px solid var(--accent)}.section--faq h2::before{content:'Q ';color:var(--accent)}.section--proof{border-top-color:var(--accent)}.section h2{font-size:clamp(1.5rem,3vw,2.5rem);line-height:1.1;margin:0 0 18px}.section p{max-width:64ch}.source-note{color:var(--ink);font:600 .72rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.section--cta .source-note,.section--cta .section-index{color:var(--inverse-text)}.motion--subtle .section{transition:transform .18s ease,box-shadow .18s ease}.motion--subtle .section:hover{transform:translateY(-2px)}.image--masked .brand-logo{border-radius:50%}.image--contained .brand-logo{object-fit:contain}.image--wide .brand-logo{max-width:240px}.contact{background:var(--inverse-surface);color:var(--inverse-text);padding:56px 0}.contact h2{font-size:clamp(2rem,5vw,4rem);margin:.25em 0}.contact-list{list-style:none;padding:0;display:grid;gap:10px}.site-footer{border-top:1px solid var(--border);padding:28px 0 48px;font-size:.85rem}.footer-row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}@media(max-width:720px){.nav{align-items:flex-start;padding:18px 0}.nav-links{gap:10px 14px}.brand-logo{height:34px;max-width:132px}.facts,.hero--split_media .shell,.hero--proof_grid .shell{display:block}.section{padding-block:28px;margin-bottom:var(--gap)}.hero h1{letter-spacing:-.045em}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.motion--subtle .section{transition:none}.motion--subtle .section:hover{transform:none}}`;
  const componentCss = `.hero-copy{position:relative;z-index:2}.hero-orbit-layout,.hero-split,.hero-proof{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.82fr);align-items:center;gap:clamp(28px,6vw,88px)}.hero-art{min-width:0}.orbit-art{display:block;width:100%;height:auto;max-height:620px;color:var(--ink)}.orbit-art__halo{fill:color-mix(in srgb,var(--accent) 11%,transparent);stroke:none}.orbit-art__ring{fill:none;stroke:currentColor;stroke-width:1.5;stroke-dasharray:7 12;opacity:.28}.orbit-art__ring--inner{stroke:var(--accent);stroke-dasharray:2 10}.orbit-art__dna,.orbit-art__molecule,.orbit-art__cell,.orbit-art__timeline{fill:none;stroke:currentColor;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.orbit-art__dna circle,.orbit-art__molecule circle,.orbit-art__cell circle,.orbit-art__timeline circle{fill:var(--canvas);stroke:var(--accent)}.orbit-art__cell{stroke:var(--accent)}.orbit-art__timeline{stroke-width:4}.hero-feature-grid{list-style:none;margin:48px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid var(--border)}.hero-feature-grid li{display:grid;gap:12px;padding:24px;border-right:1px solid var(--border)}.hero-feature-grid li:last-child{border:0}.hero-feature-grid span,.section-index{color:var(--accent);font:700 .72rem/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}.hero-bento{display:grid;grid-template-columns:1.45fr .55fr .55fr;grid-template-rows:auto auto;gap:var(--gap)}.hero-bento__copy{grid-row:span 2;padding:clamp(28px,5vw,64px);border:1px solid var(--border);border-radius:var(--radius)}.hero-bento__signal,.hero-bento__summary,.hero-bento__mark{padding:28px;border-radius:var(--radius);background:var(--muted)}.hero-bento__signal{display:flex;flex-direction:column;justify-content:space-between;gap:64px}.hero-bento__signal span{color:var(--accent)}.hero-bento__mark{display:grid;place-items:center;background:var(--accent);color:var(--accent-text);font-size:clamp(3rem,7vw,7rem)}.hero-split__media{aspect-ratio:4/5;position:relative;display:grid;place-items:end start;padding:32px;overflow:hidden;border-radius:var(--radius);background:var(--inverse-surface);color:var(--inverse-text)}.hero-split__disc{position:absolute;border-radius:50%;border:1px solid var(--inverse-text)}.hero-split__disc--one{width:80%;aspect-ratio:1;right:-24%;top:-12%}.hero-split__disc--two{width:45%;aspect-ratio:1;left:10%;bottom:10%;background:var(--accent)}.hero-split__media strong{position:relative;font-size:clamp(1.5rem,3vw,3rem);line-height:1.05}.hero-editorial{border-bottom:1px solid var(--border)}.hero-editorial{display:grid;grid-template-columns:1fr minmax(0,1120px) 1fr}.hero-editorial>.shell{grid-column:2}.hero-editorial__folio{font:600 .7rem/1 ui-monospace,monospace;letter-spacing:.16em;border-bottom:1px solid currentColor;padding-bottom:16px}.hero-editorial__note{max-width:28ch;margin:48px 0 0 auto;border-left:3px solid var(--accent);padding-left:20px}.hero-centered{text-align:center}.hero-centered .hero-copy>*{margin-inline:auto}.hero-actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:32px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:1px solid currentColor;border-radius:999px;text-decoration:none;font-weight:750}.button--primary{background:var(--inverse-surface);color:var(--inverse-text)}.button--secondary{background:transparent}.button--inverse{background:var(--canvas);color:var(--ink);align-self:center}.hero--immersive_visual{min-height:min(820px,86vh);display:grid;align-items:end;background:var(--inverse-surface);color:var(--inverse-text)}.hero-immersive__field{position:absolute;inset:0;background:var(--inverse-surface)}.hero-immersive__field i{position:absolute;border:1px solid var(--inverse-text);border-radius:50%;aspect-ratio:1}.hero-immersive__field i:nth-child(1){width:44%;right:4%;top:8%}.hero-immersive__field i:nth-child(2){width:24%;right:27%;top:28%}.hero-immersive__field i:nth-child(3){width:12%;left:12%;top:14%;background:var(--accent)}.hero-immersive__copy{position:relative;padding-bottom:clamp(72px,10vw,136px)}.hero--immersive_visual .eyebrow{color:var(--inverse-text)}.product-stage{margin-top:56px;border:1px solid var(--border);border-radius:calc(var(--radius) + 8px);background:var(--canvas);box-shadow:0 36px 100px color-mix(in srgb,var(--ink) 18%,transparent);overflow:hidden}.product-stage__bar{display:flex;gap:7px;padding:15px 18px;border-bottom:1px solid var(--border)}.product-stage__bar span{width:10px;height:10px;border-radius:50%;background:var(--accent)}.product-stage__body{min-height:320px;display:grid;grid-template-columns:180px 1fr}.product-stage__body aside{background:var(--inverse-surface)}.product-stage__body>div{display:grid;gap:18px;align-content:center;padding:clamp(30px,6vw,80px)}.product-stage__body strong{font-size:clamp(1.8rem,4vw,4rem)}.product-stage__body span{height:12px;background:var(--muted);border-radius:99px}.product-stage__body span:last-child{width:62%}.hero-proof__grid{display:grid;grid-template-columns:auto 1fr;margin:0;border-top:1px solid currentColor}.hero-proof__grid dt,.hero-proof__grid dd{margin:0;padding:20px 0;border-bottom:1px solid var(--border)}.hero-proof__grid dt{padding-right:24px;color:var(--accent);font-family:ui-monospace,monospace}.hero--full_bleed_statement{padding-inline:20px;background:var(--accent);color:var(--accent-text)}.hero-statement__rail{position:absolute;inset:0 auto 0 16px;writing-mode:vertical-rl;text-transform:uppercase;letter-spacing:.2em;font-size:.65rem;padding-top:28px}.hero-statement h1{max-width:15ch;font-size:clamp(3.4rem,11vw,9.5rem)}.hero--full_bleed_statement .eyebrow{color:var(--accent-text)}.section-index{display:inline-block;margin-bottom:16px}.section blockquote{margin:0;font-size:clamp(1.35rem,2.7vw,2.4rem);line-height:1.25}.section--statement blockquote{max-width:34ch}.section--split{display:grid;grid-template-columns:minmax(180px,.7fr) minmax(0,1.3fr);gap:var(--gap);align-content:start}.section--split .source-note{grid-column:2}.mini-card-grid{display:grid;gap:10px}.mini-card{padding:18px;border:1px solid var(--border);border-radius:max(4px,calc(var(--radius) / 2))}.mini-card span{color:var(--accent);font:700 .7rem/1 ui-monospace,monospace}.mini-card p{margin:.7em 0 0}.timeline-list{list-style:none;padding:0;margin:28px 0}.timeline-list li{position:relative;display:grid;grid-template-columns:48px 1fr;gap:16px;padding:0 0 28px}.timeline-list li:not(:last-child)::after{content:'';position:absolute;left:15px;top:28px;bottom:0;border-left:1px solid var(--accent)}.timeline-list span{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--accent);color:var(--accent-text);font:700 .65rem/1 ui-monospace,monospace}.timeline-list p{margin:3px 0}.section--faq dl,.section--faq dd{margin:0}.section--faq dt{display:flex;gap:18px;font-size:clamp(1.4rem,3vw,2.5rem);font-weight:750;line-height:1.15}.section--faq dt span{color:var(--accent)}.section--faq dd{padding:20px 0 0 52px}.section--proof figure,.section--proof blockquote{margin:0}.section--proof figcaption{margin-bottom:24px}.section--cta{grid-column:span 12;display:grid;grid-template-columns:1fr auto;gap:32px;align-items:center}.section--cta .source-note{grid-column:1/-1}@media(max-width:800px){.hero-orbit-layout,.hero-split,.hero-proof,.hero-bento{grid-template-columns:1fr}.hero-bento__copy{grid-row:auto}.hero-bento__signal{gap:24px}.hero-feature-grid{grid-template-columns:1fr}.hero-feature-grid li{border-right:0;border-bottom:1px solid var(--border)}.hero-feature-grid li:last-child{border-bottom:0}.hero-art{max-width:620px;margin-inline:auto}.product-stage__body{grid-template-columns:70px 1fr}.section--split,.section--cta{display:block}.section--split .source-note{grid-column:auto}.button--inverse{margin-top:20px}}@media(prefers-reduced-motion:no-preference){.motion--floating_subtle .orbit-art__ring--outer{animation:orbit-spin 32s linear infinite;transform-origin:center}.motion--floating_subtle .orbit-art__cell{animation:orbit-float 6s ease-in-out infinite;transform-origin:center}@keyframes orbit-spin{to{transform:rotate(360deg)}}@keyframes orbit-float{50%{transform:translateY(-12px)}}}@media(prefers-reduced-motion:reduce){.orbit-art *{animation:none!important}}`;
  const orbitCss = `.hero-orbit-stage{position:relative;min-height:clamp(620px,76vw,820px);display:grid;place-items:center}.hero-orbit__copy{position:relative;z-index:4;width:min(720px,72%);text-align:center;padding:56px 36px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--canvas) 96%,white) 0 48%,color-mix(in srgb,var(--canvas) 84%,transparent) 68%,transparent 72%)}.hero-orbit__copy .hero-copy>*{margin-inline:auto}.orbit-motif{position:absolute;z-index:2;width:clamp(150px,22vw,260px);aspect-ratio:1;color:var(--ink);filter:drop-shadow(0 22px 36px color-mix(in srgb,var(--ink) 13%,transparent))}.orbit-motif svg{display:block;width:100%;height:100%;overflow:visible}.orbit-motif__halo{fill:color-mix(in srgb,var(--canvas) 82%,white);stroke:color-mix(in srgb,var(--ink) 22%,transparent);stroke-width:1.5}.orbit-motif__drawing{fill:none;stroke:currentColor;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.orbit-motif__drawing circle{fill:var(--canvas);stroke:var(--accent)}.orbit-motif--dna{left:-2%;top:2%;transform:rotate(-12deg)}.orbit-motif--molecule{right:-1%;top:3%;transform:rotate(9deg)}.orbit-motif--cell{right:4%;bottom:0;transform:rotate(-5deg)}.orbit-motif--cell .orbit-motif__drawing{stroke:var(--accent)}.orbit-motif--timeline{left:1%;bottom:-1%;transform:rotate(6deg)}.orbit-motif--timeline .orbit-motif__drawing{stroke-width:4}@media(max-width:800px){.hero-orbit-stage{min-height:auto;padding:360px 0 330px}.hero-orbit__copy{width:100%;padding:40px 18px}.orbit-motif{width:min(42vw,190px)}.orbit-motif--dna{left:0;top:18px}.orbit-motif--molecule{right:0;top:88px}.orbit-motif--cell{right:2%;bottom:22px}.orbit-motif--timeline{left:0;bottom:86px}}@media(max-width:460px){.hero-orbit-stage{padding:270px 0 250px}.orbit-motif{width:145px}.hero-orbit__copy{background:color-mix(in srgb,var(--canvas) 94%,white);border-radius:var(--radius)}}@media(prefers-reduced-motion:no-preference){.motion--floating_subtle .orbit-motif--dna{animation:motif-dna 7s ease-in-out infinite}.motion--floating_subtle .orbit-motif--molecule{animation:motif-molecule 8s ease-in-out infinite}.motion--floating_subtle .orbit-motif--cell{animation:motif-cell 9s ease-in-out infinite}.motion--floating_subtle .orbit-motif--timeline{animation:motif-timeline 7.5s ease-in-out infinite}@keyframes motif-dna{50%{transform:translate(10px,-14px) rotate(-8deg)}}@keyframes motif-molecule{50%{transform:translate(-12px,10px) rotate(14deg)}}@keyframes motif-cell{50%{transform:translate(-8px,-13px) rotate(-1deg)}}@keyframes motif-timeline{50%{transform:translate(12px,8px) rotate(2deg)}}}@media(prefers-reduced-motion:reduce){.orbit-motif{animation:none!important}}`;
  const blueprintCss = `.contact .eyebrow{color:var(--canvas)}.container--wide .shell{width:min(1360px,calc(100% - 40px))}.container--edge_to_edge .hero>.shell{width:100%;max-width:none}.container--contained .hero--floating_orbit .hero-orbit-stage{width:min(1120px,calc(100% - 40px))}.media-strategy--procedural_brand_svg .orbit-motif{display:block}`;
  const visualContractCss =
    design.schemaVersion === 2 && design.referenceBlueprint.schemaVersion === 4
      ? TRUSTED_REACT_VISUAL_CONTRACT_V4_CSS
      : "";
  return `${baseCss}${componentCss}${orbitCss}${blueprintCss}${visualContractCss}`;
}

function cssForMaterializer(
  visual: SiteOpsRuntimeVisual,
  design: SiteOpsDesignSpec,
  workflow: SiteOpsMaterializerCoordinates,
) {
  // 2.4 originally shipped with this visual CSS. Keep it on the same source
  // selector as the current host-owned workflow so production replay remains
  // byte-compatible; Native 2.5 is intentionally not admitted here.
  return workflow.frontMindVersion ===
    SITEOPS_MATERIALIZER_V2_4_LEGACY.frontMindVersion ||
    workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion
    ? cssForVisual(visual, design)
    : cssForVisualLegacy(visual, design);
}

function renderLayoutSource(input: { mode: "preview" | "production" }) {
  return `---
import siteData from "../data/site.json";
interface Props {
  title: string;
  description: string;
  canonical: string | null;
  jsonLd: Record<string, unknown> | null;
}
const { title, description, canonical, jsonLd } = Astro.props;
const {
  navigation,
  companyName,
  language,
  socialImage,
  brandLogo,
  brandLogoWidth,
  brandLogoHeight,
  bodyClass,
} = siteData;
// JSON-LD is raw script text, so JSON escaping alone is insufficient: a
// customer/provider value containing </script> would otherwise close the
// element in the HTML parser. Emit JSON-safe unicode escapes for every less-
// than sign and the two JavaScript line separators before using set:html.
const jsonLdText = jsonLd
  ? JSON.stringify(jsonLd)
      .replaceAll("<", String.fromCharCode(92) + "u003c")
      .replaceAll(String.fromCharCode(0x2028), String.fromCharCode(92) + "u2028")
      .replaceAll(String.fromCharCode(0x2029), String.fromCharCode(92) + "u2029")
  : null;
---
<!doctype html>
<html lang={language}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content={description} />
    <meta name="robots" content=${JSON.stringify(input.mode === "preview" ? "noindex,nofollow" : "index,follow")} />
    <meta property="og:type" content="website" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    {canonical && <link rel="canonical" href={canonical} />}
    {canonical && <meta property="og:url" content={canonical} />}
    {socialImage && <meta property="og:image" content={socialImage} />}
    {socialImage && <meta name="twitter:card" content="summary_large_image" />}
    {socialImage && <meta name="twitter:image" content={socialImage} />}
    {jsonLdText && <script type="application/ld+json" set:html={jsonLdText} />}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/styles.css" />
    <title>{title}</title>
  </head>
  <body class={bodyClass}>
    <header class="site-header">
      <nav class="shell nav" aria-label="主导航">
        <a class="brand" href="/">
          {brandLogo && <img class="brand-logo" src={brandLogo} width={brandLogoWidth} height={brandLogoHeight} alt={companyName + " Logo"} />}
          <span>{companyName}</span>
        </a>
        <div class="nav-links">{navigation.map((item) => <a href={item.href}>{item.title}</a>)}</div>
      </nav>
    </header>
    <main><slot /></main>
    <footer class="site-footer"><div class="shell footer-row"><strong>{companyName}</strong></div></footer>
  </body>
</html>
`;
}

function renderPageSource(input: { sourcePath: string; dataPath: string }) {
  const sourceDir = path.posix.dirname(input.sourcePath);
  let layoutImport = path.posix.relative(
    sourceDir,
    "src/layouts/SiteLayout.astro",
  );
  if (!layoutImport.startsWith(".")) layoutImport = `./${layoutImport}`;
  let pageImport = path.posix.relative(sourceDir, input.dataPath);
  if (!pageImport.startsWith(".")) pageImport = `./${pageImport}`;
  let contentImport = path.posix.relative(
    sourceDir,
    "src/components/SitePage.astro",
  );
  if (!contentImport.startsWith(".")) contentImport = `./${contentImport}`;
  return `---
import SiteLayout from ${JSON.stringify(layoutImport)};
import SitePage from ${JSON.stringify(contentImport)};
import pageData from ${JSON.stringify(pageImport)};
const { title, description, canonical, jsonLd } = pageData;
---
<SiteLayout {title} {description} {canonical} {jsonLd}>
  <SitePage data={pageData} />
</SiteLayout>
`;
}

function renderSitePageComponent() {
  return `---
interface PageData {
  heroClass: string;
  hero: { eyebrow: string; heading: string; summary: string };
  sections: Array<{
    slotId: string;
    variant: string;
    heading: string;
    paragraphs: string[];
    sourceDocumentIds: string[];
  }>;
  contacts: Array<{ href: string | null; label: string }>;
}
const { data } = Astro.props as { data: PageData };
---
<section class={data.heroClass}><div class="shell">
  <p class="eyebrow">{data.hero.eyebrow}</p>
  <h1>{data.hero.heading}</h1>
  <p class="lede">{data.hero.summary}</p>
</div></section>
<div class="shell facts">
  {data.sections.map((section) => (
    <section class={"section section--" + section.variant} data-slot={section.slotId}>
      <h2>{section.heading}</h2>
      {section.paragraphs.map((paragraph) => <p>{paragraph}</p>)}
    </section>
  ))}
</div>
{data.contacts.length > 0 && (
  <section class="contact"><div class="shell"><h2>联系我们</h2><ul class="contact-list">
    {data.contacts.map((contact) => <li>{contact.href ? <a href={contact.href}>{contact.label}</a> : contact.label}</li>)}
  </ul></div></section>
)}
`;
}

function addTextFile(
  files: SourceFile[],
  filePath: string,
  content: string | Buffer,
) {
  const normalized = filePath.normalize("NFKC");
  if (
    normalized !== filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("SITEOPS_SOURCE_PATH_INVALID");
  }
  files.push({
    path: filePath,
    bytes: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
  });
}

function buildTrustedAstroSource(input: {
  contract: BuildContractV2;
  frozenRuntimeInput: z.infer<typeof siteOpsFrozenRuntimeInputSchema>;
  brief: SiteBrief;
  visual: SiteOpsRuntimeVisual;
  designSpec: SiteDesignSpecV1;
  content: SiteOpsGeneratedContent;
  canonicalOrigin: string | null;
  mode: "preview" | "production";
  brandAsset: TrustedSiteBrandAsset | null;
  workflow: SiteOpsMaterializerCoordinates;
}) {
  const files: SourceFile[] = [];
  const routePairs = input.brief.routes.map((route, index) => ({
    route,
    index,
    generated: input.content.routes.find((item) => item.routeId === route.id)!,
  }));
  addTextFile(
    files,
    "package.json",
    `${JSON.stringify(
      {
        name: `frontmind-site-${input.contract.source.knowledgeSnapshotId}`,
        private: true,
        version: "1.0.0",
        type: "module",
        engines: { node: ">=22.19.0" },
        scripts: { build: "astro build" },
        dependencies: { astro: ASTRO_VERSION, typescript: TYPESCRIPT_VERSION },
      },
      null,
      2,
    )}\n`,
  );
  addTextFile(
    files,
    "frontmind-runtime-lock.json",
    jsonBuffer({
      schemaVersion: 1,
      packageManager: "host-owned",
      installAtCustomerBuildTime: false,
      node: ">=22.19.0",
      dependencies: { astro: ASTRO_VERSION, typescript: TYPESCRIPT_VERSION },
      workflowManifestSha256: input.workflow.runtimeManifestSha256,
    }),
  );
  addTextFile(
    files,
    "astro.config.mjs",
    `export default Object.freeze({ output: "static", trailingSlash: "always", build: { assets: "_assets" } });\n`,
  );
  addTextFile(
    files,
    "tsconfig.json",
    `${JSON.stringify({ compilerOptions: { strict: true }, exclude: ["dist"] }, null, 2)}\n`,
  );
  addTextFile(files, "build-contract.json", jsonBuffer(input.contract));
  addTextFile(
    files,
    "frontmind-runtime-input.json",
    jsonBuffer(input.frozenRuntimeInput),
  );
  const projection = siteDesignMaterializationProjectionFor(
    input.designSpec,
    input.workflow,
    LEGACY_ASTRO_RENDERER,
  );
  const frozenBrandAsset = freezeSiteBrandAsset(input.brandAsset);
  addTextFile(
    files,
    "src/data/site.json",
    jsonBuffer({
      navigation: input.brief.routes.map((route) => ({
        href: route.slug,
        title: route.title,
      })),
      companyName: input.brief.companyName,
      language: input.brief.primaryLanguage,
      socialImage: input.canonicalOrigin
        ? `${input.canonicalOrigin}/social-card.svg`
        : null,
      brandLogo: frozenBrandAsset
        ? `/${frozenBrandAsset.publicPath.slice("public/".length)}`
        : null,
      brandLogoWidth: frozenBrandAsset?.width ?? null,
      brandLogoHeight: frozenBrandAsset?.height ?? null,
      bodyClass: projection.bodyClass,
    }),
  );
  addTextFile(
    files,
    "src/layouts/SiteLayout.astro",
    renderLayoutSource({
      mode: input.mode,
    }),
  );
  addTextFile(
    files,
    "src/components/SitePage.astro",
    renderSitePageComponent(),
  );
  const contacts = input.brief.contacts.map((contact) => ({
    href: safeContactHref(contact.kind, contact.value),
    label: contact.value,
  }));
  for (const { route, generated, index } of routePairs) {
    const sourcePath = routeSourcePath(route.slug);
    const dataPath = `src/data/route-${String(index + 1).padStart(3, "0")}.json`;
    const canonical = input.canonicalOrigin
      ? routeCanonical(input.canonicalOrigin, route.slug)
      : null;
    const composition = input.designSpec.routeCompositions.find(
      (item) => item.routeId === route.id,
    )!;
    const variantBySlot = new Map(
      composition.slots.map((slot) => [slot.slotId, slot.variant]),
    );
    addTextFile(
      files,
      dataPath,
      jsonBuffer({
        title: `${generated.heading} | ${input.brief.companyName}`,
        description: generated.summary,
        canonical,
        jsonLd: canonical
          ? {
              "@context": "https://schema.org",
              "@type": input.content.seo.organizationType,
              name: input.brief.companyName,
              url: canonical,
              description: input.content.seo.description,
            }
          : null,
        heroClass: projection.heroClass,
        hero: {
          eyebrow: generated.eyebrow ?? input.brief.companyName,
          heading: generated.heading,
          summary: generated.summary,
        },
        sections: generated.sections.map((section) => ({
          slotId: section.slotId,
          variant: variantBySlot.get(section.slotId),
          heading: section.heading,
          paragraphs: section.paragraphs,
          sourceDocumentIds: section.sourceDocumentIds,
        })),
        contacts,
      }),
    );
    addTextFile(
      files,
      sourcePath,
      renderPageSource({
        sourcePath,
        dataPath,
      }),
    );
  }
  addTextFile(
    files,
    "frontmind-component-manifest.json",
    jsonBuffer(
      siteDesignMaterializationProjectionFor(
        input.designSpec,
        input.workflow,
        LEGACY_ASTRO_RENDERER,
      ).componentManifest,
    ),
  );
  addTextFile(
    files,
    "src/data/not-found.json",
    jsonBuffer({
      title: `页面未找到 | ${input.brief.companyName}`,
      description: "请求的页面不存在。",
      canonical: null,
      jsonLd: null,
    }),
  );
  addTextFile(
    files,
    "src/pages/404.astro",
    `---\nimport SiteLayout from "../layouts/SiteLayout.astro";\nimport pageData from "../data/not-found.json";\nconst { title, description, canonical, jsonLd } = pageData;\n---\n<SiteLayout {title} {description} {canonical} {jsonLd}><section class="hero"><div class="shell"><p class="eyebrow">404</p><h1>页面未找到</h1><p class="lede"><a href="/">返回首页</a></p></div></section></SiteLayout>\n`,
  );
  addTextFile(
    files,
    "public/styles.css",
    `${cssForMaterializer(input.visual, input.designSpec, input.workflow)}\n`,
  );
  if (input.brandAsset) {
    addTextFile(files, input.brandAsset.publicPath, input.brandAsset.bytes);
  }
  const brandColors = input.visual.taxonomy.palette.filter((value) =>
    /^#[a-f0-9]{6}$/iu.test(value),
  );
  const brandInk = brandColors[0] ?? "#10212B";
  const brandAccent = brandColors[1] ?? "#A33A1B";
  const brandCanvas = "#F5F2EA";
  const companyGlyph = escapeXml(
    Array.from(input.brief.companyName.trim()).slice(0, 1).join("") || "•",
  );
  const socialCompany = escapeXml(
    Array.from(input.brief.companyName).slice(0, 36).join(""),
  );
  const socialDescription = escapeXml(
    Array.from(input.content.seo.description).slice(0, 86).join(""),
  );
  addTextFile(
    files,
    "public/favicon.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(input.brief.companyName)}"><rect width="64" height="64" rx="14" fill="${brandInk}"/><circle cx="48" cy="16" r="8" fill="${brandAccent}"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="${brandCanvas}">${companyGlyph}</text></svg>\n`,
  );
  addTextFile(
    files,
    "public/social-card.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="${socialCompany}"><rect width="1200" height="630" fill="${brandCanvas}"/><rect x="0" y="0" width="28" height="630" fill="${brandAccent}"/><circle cx="1060" cy="108" r="150" fill="${brandInk}" opacity=".08"/><text x="92" y="230" font-family="Arial,sans-serif" font-size="72" font-weight="700" fill="${brandInk}">${socialCompany}</text><text x="94" y="325" font-family="Arial,sans-serif" font-size="32" fill="${brandAccent}">${socialDescription}</text></svg>\n`,
  );
  addTextFile(
    files,
    "public/robots.txt",
    input.mode === "preview"
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nAllow: /\nSitemap: ${input.canonicalOrigin}/sitemap.xml\n`,
  );
  if (input.mode === "production") {
    const urls = input.brief.routes.map(
      (route) =>
        `<url><loc>${escapeXml(routeCanonical(input.canonicalOrigin!, route.slug))}</loc></url>`,
    );
    addTextFile(
      files,
      "public/sitemap.xml",
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`,
    );
    addTextFile(
      files,
      "public/llms.txt",
      `# ${input.brief.companyName}\n\n${input.content.seo.description}\n\n${input.brief.routes.map((route) => `- [${route.title}](${routeCanonical(input.canonicalOrigin!, route.slug)})`).join("\n")}\n`,
    );
  }
  if (files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("SITEOPS_SOURCE_ENTRY_LIMIT_EXCEEDED");
  }
  const totalBytes = files.reduce(
    (total, file) => total + file.bytes.length,
    0,
  );
  if (totalBytes > MAX_SOURCE_BYTES) {
    throw new Error("SITEOPS_SOURCE_SIZE_LIMIT_EXCEEDED");
  }
  const paths = files.map((file) => file.path);
  if (
    new Set(paths.map((value) => value.toLocaleLowerCase("en-US"))).size !==
    paths.length
  ) {
    throw new Error("SITEOPS_SOURCE_PATH_COLLISION");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function buildTrustedReactSource(input: {
  contract: BuildPlanContractV3 | BuildPlanContractV4;
  frozenRuntimeInput: z.infer<typeof siteOpsFrozenRuntimeInputSchema>;
  brief: SiteBrief;
  visual: SiteOpsRuntimeVisual;
  designSpec: SiteDesignSpecV2;
  content: SiteOpsGeneratedContent;
  renderer: typeof REACT_STATIC_RENDERER_V1 | typeof REACT_STATIC_RENDERER;
  canonicalOrigin: string | null;
  mode: "preview" | "production";
  brandAsset: TrustedSiteBrandAsset | null;
  workflow: SiteOpsMaterializerCoordinates;
}) {
  const reactCoordinates = reactStaticCoordinatesForWorkflow(input.workflow);
  const files: SourceFile[] = [];
  const projection = siteDesignMaterializationProjectionFor(
    input.designSpec,
    input.workflow,
    input.renderer,
  );
  const visualContract = trustedVisualContractV4(input.designSpec);
  const frozenBrandAsset = freezeSiteBrandAsset(input.brandAsset);
  const contacts = input.brief.contacts.map((contact) => ({
    href: safeContactHref(contact.kind, contact.value),
    label: contact.value,
  }));
  const routeManifest: Array<{
    routeId: string;
    dataPath: string;
    outputPath: string;
  }> = [];
  const projectName = `frontmind-site-${input.contract.source.knowledgeSnapshotId}`;

  addTextFile(
    files,
    "package.json",
    `${JSON.stringify(
      {
        name: projectName,
        private: true,
        version: "1.0.0",
        type: "module",
        engines: { node: ">=22.19.0" },
        scripts: { build: "node ./src/render.mjs" },
        dependencies: {
          react: REACT_STATIC_REACT_VERSION,
          "react-dom": REACT_STATIC_REACT_VERSION,
        },
      },
      null,
      2,
    )}\n`,
  );
  addTextFile(
    files,
    "package-lock.json",
    `${JSON.stringify(
      {
        name: projectName,
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: projectName,
            version: "1.0.0",
            dependencies: {
              react: REACT_STATIC_REACT_VERSION,
              "react-dom": REACT_STATIC_REACT_VERSION,
            },
            engines: { node: ">=22.19.0" },
          },
          "node_modules/react": {
            version: REACT_STATIC_REACT_VERSION,
            resolved: "https://registry.npmjs.org/react/-/react-19.2.1.tgz",
            integrity:
              "sha512-DGrYcCWK7tvYMnWh79yrPHt+vdx9tY+1gPZa7nJQtO/p8bLTDaHp4dzwEhQB7pZ4Xe3ok4XKuEPrVuc+wlpkmw==",
            engines: { node: ">=0.10.0" },
          },
          "node_modules/react-dom": {
            version: REACT_STATIC_REACT_VERSION,
            resolved:
              "https://registry.npmjs.org/react-dom/-/react-dom-19.2.1.tgz",
            integrity:
              "sha512-ibrK8llX2a4eOskq1mXKu/TGZj9qzomO+sNfO98M6d9zIPOEhlBkMkBUBLd1vgS0gQsLDBzA+8jJBVXDnfHmJg==",
            dependencies: { scheduler: "^0.27.0" },
            peerDependencies: { react: "^19.2.1" },
          },
          "node_modules/scheduler": {
            version: "0.27.0",
            resolved:
              "https://registry.npmjs.org/scheduler/-/scheduler-0.27.0.tgz",
            integrity:
              "sha512-eNv+WrVbKu1f3vbYJT/xtiF5syA5HPIMtf9IgY/nKg0sWqzAUEvqY/xm7OcZc/qafLx/iO9FgOmeSAp4v5ti/Q==",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  addTextFile(
    files,
    "frontmind-runtime-lock.json",
    jsonBuffer({
      schemaVersion: 2,
      renderer: input.renderer,
      componentLibraryVersion: reactCoordinates.componentLibraryVersion,
      packageManager: "host-owned",
      installAtCustomerBuildTime: false,
      node: ">=22.19.0",
      dependencies: {
        react: REACT_STATIC_REACT_VERSION,
        "react-dom": REACT_STATIC_REACT_VERSION,
      },
      workflowManifestSha256: input.workflow.runtimeManifestSha256,
    }),
  );
  addTextFile(
    files,
    `frontmind-build-plan-contract-v${input.contract.schemaVersion}.json`,
    jsonBuffer(input.contract),
  );
  addTextFile(
    files,
    "frontmind-runtime-input.json",
    jsonBuffer(input.frozenRuntimeInput),
  );
  addTextFile(
    files,
    "frontmind-component-manifest.json",
    jsonBuffer({
      ...projection.componentManifest,
    }),
  );
  addTextFile(
    files,
    "src/component-library.mjs",
    input.workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion ||
      input.workflow.frontMindVersion ===
        SITEOPS_MATERIALIZER_V2_4_LEGACY.frontMindVersion ||
      input.workflow.frontMindVersion ===
        SITEOPS_MATERIALIZER_V2_3.frontMindVersion
      ? TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE
      : TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2,
  );
  addTextFile(files, "src/render.mjs", TRUSTED_REACT_RENDERER_SOURCE);
  addTextFile(
    files,
    "src/data/site.json",
    jsonBuffer({
      navigation: input.brief.routes.map((route) => ({
        href: route.slug,
        title: route.title,
      })),
      companyName: input.brief.companyName,
      language: input.brief.primaryLanguage,
      robots: input.mode === "preview" ? "noindex,nofollow" : "index,follow",
      socialImage: input.canonicalOrigin
        ? `${input.canonicalOrigin}/social-card.svg`
        : null,
      brandLogo: frozenBrandAsset
        ? `/${frozenBrandAsset.publicPath.slice("public/".length)}`
        : null,
      brandLogoWidth: frozenBrandAsset?.width ?? null,
      brandLogoHeight: frozenBrandAsset?.height ?? null,
      bodyClass: projection.bodyClass,
    }),
  );

  const typedContent = isSiteOpsGeneratedContentV2(input.content)
    ? input.content
    : null;
  const entitiesById = new Map(
    (typedContent?.entities ?? []).map((entity) => [entity.entityId, entity]),
  );
  const faqsById = new Map(
    (typedContent?.faqs ?? []).map((faq) => [faq.faqId, faq]),
  );
  const publicPages: Array<{
    slug: string;
    title: string;
    summary: string;
    lastModified: string | null;
  }> = [];
  const projectEntity = (entityId: string) => {
    const entity = entitiesById.get(entityId);
    if (!entity) throw new Error("SITEOPS_CONTENT_ENTITY_REFERENCE_MISSING");
    return {
      entityId: entity.entityId,
      href: contentEntityRouteSlug(entity),
      title: entity.title,
      summary: entity.summary,
      tags: entity.tags,
    };
  };
  const projectFaq = (faqId: string) => {
    const faq = faqsById.get(faqId);
    if (!faq) throw new Error("SITEOPS_CONTENT_FAQ_REFERENCE_MISSING");
    return {
      faqId: faq.faqId,
      question: faq.question,
      answers: faq.answers,
    };
  };

  for (const [index, route] of input.brief.routes.entries()) {
    const typedGenerated = typedContent?.routes.find(
      (item) => item.routeId === route.id,
    );
    const generated =
      typedGenerated ??
      input.content.routes.find((item) => item.routeId === route.id)!;
    const composition = input.designSpec.routeCompositions.find(
      (item) => item.routeId === route.id,
    )!;
    const variantBySlot = new Map(
      composition.slots.map((slot) => [slot.slotId, slot.variant]),
    );
    const dataPath = `data/route-${String(index + 1).padStart(3, "0")}.json`;
    const canonical = input.canonicalOrigin
      ? routeCanonical(input.canonicalOrigin, route.slug)
      : null;
    const routeFaqs = typedGenerated
      ? [
          ...new Set(
            typedGenerated.sections.flatMap((section) => section.faqIds),
          ),
        ].map(projectFaq)
      : [];
    const sameAs = (typedContent?.officialLinks ?? [])
      .filter((link) => link.kind === "same_as")
      .map((link) => link.url);
    const emptyState = typedGenerated?.emptyState;
    const publicSummary =
      emptyState === "company_news_unavailable"
        ? "暂无企业动态。"
        : generated.summary;
    const jsonLd =
      !canonical || emptyState
        ? null
        : route.id === "home"
          ? {
              "@context": "https://schema.org",
              "@type": input.content.seo.organizationType,
              name: input.brief.companyName,
              url: canonical,
              description: input.content.seo.description,
              ...(sameAs.length > 0 ? { sameAs } : {}),
            }
          : route.id === "faq" && routeFaqs.length > 0
            ? {
                "@context": "https://schema.org",
                "@type": "FAQPage",
                mainEntity: routeFaqs.map((faq) => ({
                  "@type": "Question",
                  name: faq.question,
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: faq.answers.join("\n"),
                  },
                })),
              }
            : {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: generated.heading,
                description: generated.summary,
                url: canonical,
              };
    addTextFile(
      files,
      `src/${dataPath}`,
      jsonBuffer({
        title: `${generated.heading} | ${input.brief.companyName}`,
        description: publicSummary,
        canonical,
        jsonLd,
        heroFamily: input.designSpec.referenceBlueprint.heroFamily,
        ...(visualContract ? { visualContract } : {}),
        hero: {
          eyebrow: generated.eyebrow ?? input.brief.companyName,
          heading: generated.heading,
          summary: publicSummary,
        },
        ...(emptyState ? { emptyState } : {}),
        sections: typedGenerated
          ? typedGenerated.sections.map((section) => ({
              slotId: section.slotId,
              variant: variantBySlot.get(section.slotId),
              blockType: section.blockType,
              heading: section.heading,
              paragraphs: section.paragraphs,
              items: section.items,
              entities: section.entityIds.map(projectEntity),
              faqs: section.faqIds.map(projectFaq),
            }))
          : generated.sections.map((section) => ({
              slotId: section.slotId,
              variant: variantBySlot.get(section.slotId),
              heading: section.heading,
              paragraphs: section.paragraphs,
            })),
        contacts,
      }),
    );
    routeManifest.push({
      routeId: route.id,
      dataPath,
      outputPath: routeOutputPath(route.slug),
    });
    if (!emptyState) {
      publicPages.push({
        slug: route.slug,
        title: generated.heading,
        summary: generated.summary,
        lastModified: null,
      });
    }
  }

  for (const [index, entity] of (typedContent?.entities ?? []).entries()) {
    const slug = contentEntityRouteSlug(entity);
    const canonical = input.canonicalOrigin
      ? routeCanonical(input.canonicalOrigin, slug)
      : null;
    const dataPath = `data/entity-${String(index + 1).padStart(3, "0")}.json`;
    const schemaType = {
      product: "Product",
      service: "Service",
      application: "WebPage",
      case_study: "Article",
      blog: "Article",
      company_news: "NewsArticle",
    }[entity.entityType];
    const related = entity.relatedEntityIds.map(projectEntity);
    addTextFile(
      files,
      `src/${dataPath}`,
      jsonBuffer({
        title: `${entity.title} | ${input.brief.companyName}`,
        description: entity.summary,
        canonical,
        jsonLd: canonical
          ? {
              "@context": "https://schema.org",
              "@type": schemaType,
              name: entity.title,
              headline: entity.title,
              description: entity.summary,
              url: canonical,
              ...(entity.publishedAt
                ? { datePublished: entity.publishedAt }
                : {}),
              ...(entity.modifiedAt ? { dateModified: entity.modifiedAt } : {}),
              ...(entity.author
                ? { author: { "@type": "Person", name: entity.author } }
                : {}),
            }
          : null,
        heroFamily: input.designSpec.referenceBlueprint.heroFamily,
        ...(visualContract ? { visualContract } : {}),
        hero: {
          eyebrow: input.brief.companyName,
          heading: entity.title,
          summary: entity.summary,
        },
        sections: [
          {
            slotId: "body",
            variant: "split",
            blockType: "prose",
            heading: entity.title,
            paragraphs: entity.body,
            items: [],
            entities: [],
            faqs: [],
          },
          ...(related.length > 0
            ? [
                {
                  slotId: "related",
                  variant: "cards",
                  blockType: "entity_grid",
                  heading: "相关内容",
                  paragraphs: ["继续浏览相关内容。"],
                  items: [],
                  entities: related,
                  faqs: [],
                },
              ]
            : []),
        ],
        contacts,
      }),
    );
    routeManifest.push({
      routeId: `entity:${entity.entityId}`,
      dataPath,
      outputPath: routeOutputPath(slug),
    });
    publicPages.push({
      slug,
      title: entity.title,
      summary: entity.summary,
      lastModified: entity.modifiedAt ?? entity.publishedAt,
    });
  }
  addTextFile(
    files,
    "src/data/not-found.json",
    jsonBuffer({
      title: `页面未找到 | ${input.brief.companyName}`,
      description: "请求的页面不存在。",
    }),
  );
  addTextFile(
    files,
    "src/route-manifest.json",
    jsonBuffer({
      schemaVersion: input.renderer === REACT_STATIC_RENDERER ? 2 : 1,
      renderer: input.renderer,
      routes: routeManifest,
      notFound: { dataPath: "data/not-found.json", outputPath: "404.html" },
    }),
  );
  addTextFile(
    files,
    "public/styles.css",
    `${cssForMaterializer(input.visual, input.designSpec, input.workflow)}\n`,
  );
  if (input.brandAsset) {
    addTextFile(files, input.brandAsset.publicPath, input.brandAsset.bytes);
  }

  const brandColors = input.visual.taxonomy.palette.filter((value) =>
    /^#[a-f0-9]{6}$/iu.test(value),
  );
  const brandInk = brandColors[0] ?? "#10212B";
  const brandAccent = brandColors[1] ?? "#A33A1B";
  const brandCanvas = "#F5F2EA";
  const companyGlyph = escapeXml(
    Array.from(input.brief.companyName.trim()).slice(0, 1).join("") || "•",
  );
  const socialCompany = escapeXml(
    Array.from(input.brief.companyName).slice(0, 36).join(""),
  );
  const socialDescription = escapeXml(
    Array.from(input.content.seo.description).slice(0, 86).join(""),
  );
  addTextFile(
    files,
    "public/favicon.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(input.brief.companyName)}"><rect width="64" height="64" rx="14" fill="${brandInk}"/><circle cx="48" cy="16" r="8" fill="${brandAccent}"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="${brandCanvas}">${companyGlyph}</text></svg>\n`,
  );
  addTextFile(
    files,
    "public/social-card.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="${socialCompany}"><rect width="1200" height="630" fill="${brandCanvas}"/><rect x="0" y="0" width="28" height="630" fill="${brandAccent}"/><circle cx="1060" cy="108" r="150" fill="${brandInk}" opacity=".08"/><text x="92" y="250" font-family="Arial,sans-serif" font-size="72" font-weight="700" fill="${brandInk}">${socialCompany}</text><text x="94" y="355" font-family="Arial,sans-serif" font-size="32" fill="${brandAccent}">${socialDescription}</text></svg>\n`,
  );
  addTextFile(
    files,
    "public/robots.txt",
    input.mode === "preview"
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nAllow: /\nSitemap: ${input.canonicalOrigin}/sitemap.xml\n`,
  );
  if (input.mode === "production") {
    const urls = publicPages.map((page) => {
      const lastModified = page.lastModified
        ? `<lastmod>${escapeXml(page.lastModified)}</lastmod>`
        : "";
      return `<url><loc>${escapeXml(routeCanonical(input.canonicalOrigin!, page.slug))}</loc>${lastModified}</url>`;
    });
    addTextFile(
      files,
      "public/sitemap.xml",
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`,
    );
    addTextFile(
      files,
      "public/llms.txt",
      `# ${plainMetadataText(input.brief.companyName)}\n\n${plainMetadataText(input.content.seo.description)}\n\n${publicPages.map((page) => `- [${plainMetadataText(page.title)}](${routeCanonical(input.canonicalOrigin!, page.slug)}): ${plainMetadataText(page.summary)}`).join("\n")}\n`,
    );
  }

  if (files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("SITEOPS_SOURCE_ENTRY_LIMIT_EXCEEDED");
  }
  const totalBytes = files.reduce(
    (total, file) => total + file.bytes.length,
    0,
  );
  if (totalBytes > MAX_SOURCE_BYTES) {
    throw new Error("SITEOPS_SOURCE_SIZE_LIMIT_EXCEEDED");
  }
  const paths = files.map((file) => file.path);
  if (
    new Set(paths.map((value) => value.toLocaleLowerCase("en-US"))).size !==
    paths.length
  ) {
    throw new Error("SITEOPS_SOURCE_PATH_COLLISION");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function safeJsonLdText(value: Record<string, unknown>) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function buildTrustedFallbackSource(input: {
  frozenRuntimeInput: z.infer<typeof siteOpsFrozenRuntimeInputSchema>;
  contract: BuildPlanContractV3 | BuildPlanContractV4;
  brandAsset: TrustedSiteBrandAsset | null;
  primaryFailureCode: string;
}) {
  const files: SourceFile[] = [
    {
      path: "frontmind-runtime-input.json",
      bytes: jsonBuffer(input.frozenRuntimeInput),
    },
    {
      path: `frontmind-build-plan-contract-v${input.contract.schemaVersion}.json`,
      bytes: jsonBuffer(input.contract),
    },
    {
      path: "frontmind-trusted-fallback.json",
      bytes: jsonBuffer({
        schemaVersion: 1,
        renderer: "trusted_static_fallback_v1",
        primaryFailureCode: input.primaryFailureCode,
      }),
    },
  ];
  if (input.brandAsset) {
    files.push({
      path: input.brandAsset.publicPath,
      bytes: input.brandAsset.bytes,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Last-resort host renderer for already validated frozen input. It accepts no
 * provider HTML, CSS, JavaScript, paths or URLs: every route and byte is
 * projected by the host into a fixed, high-contrast, no-JavaScript document.
 */
function buildTrustedFallbackDist(input: {
  brief: SiteBrief;
  content: SiteOpsGeneratedContent;
  designSpec: SiteDesignSpecV2;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  brandAsset: TrustedSiteBrandAsset | null;
}) {
  const files: SourceFile[] = [];
  const generatedByRoute = new Map(
    input.content.routes.map((route) => [route.routeId, route]),
  );
  const typedContent = isSiteOpsGeneratedContentV2(input.content)
    ? input.content
    : null;
  const blueprint = input.designSpec.referenceBlueprint;
  const heroFamily = blueprint.heroFamily;
  const palette =
    "palette" in blueprint
      ? blueprint.palette
      : {
          canvas: "#ffffff",
          ink: "#111827",
          accent: "#0057b8",
          muted: "#e5e7eb",
        };
  const typeSystem =
    "typeSystem" in blueprint
      ? blueprint.typeSystem
      : blueprint.typographyStyle === "editorial"
        ? "editorial_serif"
        : blueprint.typographyStyle === "technical"
          ? "technical_sans"
          : "display_sans";
  const fontFamily =
    typeSystem === "editorial_serif"
      ? 'ui-serif,Georgia,Cambria,"Times New Roman",serif'
      : typeSystem === "technical_sans"
        ? 'ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",monospace'
        : typeSystem === "humanist_sans"
          ? 'Optima,Candara,"Segoe UI",ui-sans-serif,system-ui,sans-serif'
          : 'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const spacing =
    blueprint.density === "compact"
      ? { hero: "3.5rem", content: "2rem", card: "1.1rem" }
      : blueprint.density === "spacious"
        ? { hero: "6rem", content: "4.5rem", card: "2rem" }
        : { hero: "5rem", content: "3rem", card: "1.5rem" };
  const brandPath = input.brandAsset
    ? input.brandAsset.publicPath.slice("public/".length)
    : null;
  const navigation = input.brief.routes
    .map(
      (route) =>
        `<a href="${escapeHtml(route.slug)}">${escapeHtml(route.title)}</a>`,
    )
    .join("");
  const brand = brandPath
    ? `<img class="brand-logo" src="/${escapeHtml(brandPath)}" width="${input.brandAsset!.width}" height="${input.brandAsset!.height}" alt="${escapeHtml(input.brief.companyName)}">`
    : "";
  const robots =
    input.mode === "preview"
      ? '<meta name="robots" content="noindex,nofollow">'
      : '<meta name="robots" content="index,follow">';
  const style = `:root{color-scheme:light;--canvas:${palette.canvas};--ink:${palette.ink};--accent:${palette.accent};--muted:${palette.muted};font-family:${fontFamily};background:var(--canvas);color:var(--ink)}*{box-sizing:border-box}body{margin:0;min-width:320px;line-height:1.65;background:var(--canvas);color:var(--ink)}a{color:var(--accent);text-underline-offset:.18em}a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.shell{width:min(70rem,calc(100% - 2rem));margin-inline:auto}.site-header{border-bottom:2px solid var(--ink);background:var(--canvas)}.nav{min-height:4.5rem;display:flex;align-items:center;justify-content:space-between;gap:1.5rem}.brand{display:flex;align-items:center;gap:.75rem;color:var(--ink);font-weight:800;text-decoration:none}.brand-logo{display:block;width:auto;height:2.5rem;max-width:11rem;object-fit:contain}.nav-links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.75rem 1.25rem}.hero{padding:${spacing.hero} 0 ${spacing.content};background:var(--ink);color:var(--canvas)}.eyebrow{font-size:.8rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{max-width:20ch;margin:.3em 0;font-size:clamp(2.5rem,7vw,5.5rem);line-height:1}.lede{max-width:65ch;font-size:1.15rem}.content{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;padding-block:${spacing.content} 5rem}.section{border:2px solid var(--ink);padding:${spacing.card};background:var(--canvas)}.section h2{margin-top:0;line-height:1.15}.contact{padding:${spacing.content} 0;background:var(--ink);color:var(--canvas)}.contact a{color:var(--canvas)}.site-footer{padding:2rem 0;border-top:2px solid var(--ink)}.empty{grid-column:1/-1}.empty p{font-size:1.1rem}@media(max-width:44rem){.nav{align-items:flex-start;padding-block:1rem}.nav-links{gap:.5rem}.content{grid-template-columns:1fr}.hero{padding-top:3.5rem}}`;
  addTextFile(files, "styles.css", `${style}\n`);

  const sharedHead = (inputValue: {
    title: string;
    description: string;
    canonical: string | null;
    jsonLd: Record<string, unknown> | null;
  }) =>
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${robots}<title>${escapeHtml(inputValue.title)}</title><meta name="description" content="${escapeHtml(inputValue.description)}"><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/favicon.svg">${inputValue.canonical ? `<link rel="canonical" href="${escapeHtml(inputValue.canonical)}"><meta property="og:image" content="${escapeHtml(input.canonicalOrigin!)}/social-card.svg">` : ""}${inputValue.jsonLd ? `<script type="application/ld+json">${safeJsonLdText(inputValue.jsonLd)}</script>` : ""}`;
  const sharedHeader = `<header class="site-header"><div class="shell nav"><a class="brand" href="/">${brand}<span>${escapeHtml(input.brief.companyName)}</span></a><nav class="nav-links" aria-label="主导航">${navigation}</nav></div></header>`;
  const sharedFooter = `<footer class="site-footer"><div class="shell"><strong>${escapeHtml(input.brief.companyName)}</strong></div></footer>`;
  const contacts = input.brief.contacts
    .map((contact) => {
      const href = safeContactHref(contact.kind, contact.value);
      return `<li>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(contact.value)}</a>` : escapeHtml(contact.value)}</li>`;
    })
    .join("");

  for (const route of input.brief.routes) {
    const generated = generatedByRoute.get(route.id);
    if (!generated) throw new Error("SITEOPS_FALLBACK_ROUTE_CONTENT_MISSING");
    const typedRoute = typedContent?.routes.find(
      (candidate) => candidate.routeId === route.id,
    );
    const emptyState = typedRoute?.emptyState;
    const summary =
      emptyState === "company_news_unavailable"
        ? "当前知识库暂无可公开的企业动态。"
        : generated.summary;
    const sections = generated.sections
      .map(
        (section) =>
          `<section class="section"><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}</section>`,
      )
      .join("");
    const canonical = input.canonicalOrigin
      ? routeCanonical(input.canonicalOrigin, route.slug)
      : null;
    const jsonLd =
      canonical && !emptyState
        ? {
            "@context": "https://schema.org",
            "@type": route.id === "home" ? "Organization" : "WebPage",
            name: generated.heading,
            description: summary,
            url: canonical,
          }
        : null;
    const content = emptyState
      ? `<section class="section empty" data-content-state="empty"><h2>${escapeHtml(generated.heading)}</h2><p>${escapeHtml(summary)}</p></section>`
      : sections;
    const html = `<!doctype html><html lang="${escapeHtml(input.brief.primaryLanguage)}"><head>${sharedHead({ title: `${generated.heading} | ${input.brief.companyName}`, description: summary, canonical, jsonLd })}</head><body>${sharedHeader}<main><section class="hero" data-hero-family="${escapeHtml(heroFamily)}"><div class="shell"><p class="eyebrow">${escapeHtml(input.brief.companyName)}</p><h1>${escapeHtml(generated.heading)}</h1><p class="lede">${escapeHtml(summary)}</p></div></section><div class="shell content">${content}</div>${contacts ? `<section class="contact"><div class="shell"><h2>联系我们</h2><ul>${contacts}</ul></div></section>` : ""}</main>${sharedFooter}</body></html>`;
    addTextFile(files, routeOutputPath(route.slug), `${html}\n`);
  }

  const notFound = `<!doctype html><html lang="${escapeHtml(input.brief.primaryLanguage)}"><head>${sharedHead({ title: `页面未找到 | ${input.brief.companyName}`, description: "请求的页面不存在。", canonical: null, jsonLd: null })}</head><body>${sharedHeader}<main><section class="hero"><div class="shell"><p class="eyebrow">404</p><h1>页面未找到</h1><p><a href="/">返回首页</a></p></div></section></main>${sharedFooter}</body></html>`;
  addTextFile(files, "404.html", `${notFound}\n`);
  if (input.brandAsset && brandPath) {
    addTextFile(files, brandPath, input.brandAsset.bytes);
  }
  const glyph = escapeXml(
    Array.from(input.brief.companyName.trim()).slice(0, 1).join("") || "•",
  );
  addTextFile(
    files,
    "favicon.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(input.brief.companyName)}"><rect width="64" height="64" rx="12" fill="#111"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#fff">${glyph}</text></svg>\n`,
  );
  addTextFile(
    files,
    "social-card.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(input.brief.companyName)}"><rect width="1200" height="630" fill="#fff"/><rect width="28" height="630" fill="#111"/><text x="80" y="310" font-family="Arial,sans-serif" font-size="70" font-weight="700" fill="#111">${escapeXml(Array.from(input.brief.companyName).slice(0, 32).join(""))}</text></svg>\n`,
  );
  addTextFile(
    files,
    "robots.txt",
    input.mode === "preview"
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nAllow: /\nSitemap: ${input.canonicalOrigin}/sitemap.xml\n`,
  );
  if (input.mode === "production") {
    addTextFile(
      files,
      "sitemap.xml",
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${input.brief.routes.map((route) => `<url><loc>${escapeXml(routeCanonical(input.canonicalOrigin!, route.slug))}</loc></url>`).join("")}</urlset>\n`,
    );
    addTextFile(
      files,
      "llms.txt",
      `# ${plainMetadataText(input.brief.companyName)}\n\n${plainMetadataText(input.content.seo.description)}\n\n${input.brief.routes.map((route) => `- [${plainMetadataText(route.title)}](${routeCanonical(input.canonicalOrigin!, route.slug)})`).join("\n")}\n`,
    );
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertTrustedSourceAssetIsolation(input: {
  files: readonly SourceFile[];
  assetDecisions: readonly z.infer<typeof siteOpsAssetDecisionSchema>[];
  brandAsset: TrustedSiteBrandAsset | null;
}) {
  const fileHashes = new Map(
    input.files.map((file) => [file.path, sha256(file.bytes)]),
  );
  const published = input.assetDecisions.filter(
    (decision) => decision.decision === "publish",
  );
  if (
    published.length !== (input.brandAsset ? 1 : 0) ||
    (input.brandAsset &&
      (published[0]?.id !== input.brandAsset.assetId ||
        published[0]?.sha256 !== input.brandAsset.sha256 ||
        fileHashes.get(input.brandAsset.publicPath) !==
          input.brandAsset.sha256))
  ) {
    throw new Error("SITEOPS_SOURCE_BRAND_ASSET_MISMATCH");
  }
  const quarantinedHashes = new Set(
    input.assetDecisions
      .filter((decision) => decision.decision === "quarantine")
      .map((decision) => decision.sha256),
  );
  if ([...fileHashes.values()].some((hash) => quarantinedHashes.has(hash))) {
    throw new Error("SITEOPS_SOURCE_QUARANTINED_ASSET_PRESENT");
  }
}

async function deterministicZip(
  files: readonly SourceFile[],
  maxBytes: number,
) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.bytes, {
      binary: true,
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (buffer.length < 1 || buffer.length > maxBytes) {
    throw new Error("SITEOPS_ARCHIVE_SIZE_INVALID");
  }
  return buffer;
}

function trustedSourceTreeHash(files: readonly SourceFile[]) {
  return canonicalSiteOpsSha256(
    files
      .filter((file) => file.path !== "build-contract.json")
      .map((file) => ({
        path: file.path,
        bytes: file.bytes.length,
        sha256: sha256(file.bytes),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

async function writeSourceRoot(root: string, files: readonly SourceFile[]) {
  for (const file of files) {
    const target = path.join(root, ...file.path.split("/"));
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("SITEOPS_SOURCE_PATH_ESCAPE");
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { mode: 0o600, flag: "wx" });
  }
}

async function runAstroBuild(
  root: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
) {
  assertNotAborted(abortSignal, "astro_build");
  const require = createRequire(import.meta.url);
  const astroPackage = require.resolve("astro/package.json");
  const astroPackageRoot = path.dirname(astroPackage);
  const packageMetadata = JSON.parse(await readFile(astroPackage, "utf8")) as {
    version?: unknown;
  };
  if (packageMetadata.version !== ASTRO_VERSION) {
    throw new Error("SITEOPS_ASTRO_RUNTIME_VERSION_MISMATCH");
  }
  // Bare Astro entrypoints used by Vite resolve from the generated project
  // root. Expose only the already installed, version-checked host package;
  // never run a package manager and never include this trusted runtime link in
  // the customer source archive.
  const runtimeModules = path.join(root, "node_modules");
  await mkdir(runtimeModules, { recursive: false, mode: 0o700 });
  await symlink(astroPackageRoot, path.join(runtimeModules, "astro"), "dir");
  const cli = path.join(astroPackageRoot, "bin", "astro.mjs");
  const boundedTimeout = Math.min(Math.max(timeoutMs, 5_000), 120_000);
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=512", cli, "build", "--root", root],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: "production",
          ASTRO_TELEMETRY_DISABLED: "1",
          NO_COLOR: "1",
          LANG: "C.UTF-8",
          TZ: "UTC",
          PATH: path.dirname(process.execPath),
        },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (raw: Buffer) => {
      if (overflow) return;
      bytes += raw.length;
      if (bytes > MAX_BUILD_LOG_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(raw);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const abort = () => child.kill("SIGKILL");
    abortSignal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => abortSignal?.removeEventListener("abort", abort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, boundedTimeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(
        toSiteOpsMaterializationError({
          error,
          phase: "astro_build",
          fallbackCode: "SITEOPS_ASTRO_RUNTIME_UNAVAILABLE",
          retryClass: "host_transient",
        }),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      cleanup();
      if (abortSignal?.aborted) {
        return reject(
          new SiteOpsMaterializationError({
            phase: "astro_build",
            code: "SITEOPS_MATERIALIZATION_ABORTED",
            retryClass: "host_transient",
          }),
        );
      }
      if (timedOut) {
        return reject(
          new SiteOpsMaterializationError({
            phase: "astro_build",
            code: "SITEOPS_ASTRO_BUILD_TIMEOUT",
            retryClass: "host_transient",
            safeDetails: { timeoutMs: boundedTimeout },
          }),
        );
      }
      const log = Buffer.concat(chunks, Math.min(bytes, MAX_BUILD_LOG_BYTES));
      if (overflow)
        return reject(new Error("SITEOPS_BUILD_LOG_LIMIT_EXCEEDED"));
      if (code !== 0) {
        return reject(
          new SiteOpsMaterializationError({
            phase: "astro_build",
            code: "SITEOPS_ASTRO_BUILD_FAILED",
            retryClass: "host_deterministic",
            safeDetails: {
              exitCode: code,
              signal: signal ?? null,
            },
          }),
        );
      }
      resolve(log);
    });
  });
}

async function runReactStaticBuild(
  root: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
) {
  assertNotAborted(abortSignal, "react_static_build");
  const require = createRequire(import.meta.url);
  const reactPackage = require.resolve("react/package.json");
  const reactDomPackage = require.resolve("react-dom/package.json");
  const [reactMetadata, reactDomMetadata] = (
    await Promise.all([
      readFile(reactPackage, "utf8"),
      readFile(reactDomPackage, "utf8"),
    ])
  ).map((raw) => JSON.parse(raw) as { version?: unknown });
  if (
    reactMetadata.version !== REACT_STATIC_REACT_VERSION ||
    reactDomMetadata.version !== REACT_STATIC_REACT_VERSION
  ) {
    throw new SiteOpsMaterializationError({
      phase: "react_static_build",
      code: "SITEOPS_REACT_STATIC_RUNTIME_VERSION_MISMATCH",
      retryClass: "host_deterministic",
    });
  }

  const runtimeModules = path.join(root, "node_modules");
  await mkdir(runtimeModules, { recursive: false, mode: 0o700 });
  await Promise.all([
    symlink(
      path.dirname(reactPackage),
      path.join(runtimeModules, "react"),
      "dir",
    ),
    symlink(
      path.dirname(reactDomPackage),
      path.join(runtimeModules, "react-dom"),
      "dir",
    ),
  ]);

  const renderer = path.join(root, "src", "render.mjs");
  const boundedTimeout = Math.min(Math.max(timeoutMs, 5_000), 120_000);
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=512", renderer],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: "production",
          NO_COLOR: "1",
          LANG: "C.UTF-8",
          TZ: "UTC",
          PATH: path.dirname(process.execPath),
        },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (raw: Buffer) => {
      if (overflow) return;
      bytes += raw.length;
      if (bytes > MAX_BUILD_LOG_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(raw);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const abort = () => child.kill("SIGKILL");
    abortSignal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => abortSignal?.removeEventListener("abort", abort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, boundedTimeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(
        toSiteOpsMaterializationError({
          error,
          phase: "react_static_build",
          fallbackCode: "SITEOPS_REACT_STATIC_RUNTIME_UNAVAILABLE",
          retryClass: "host_transient",
        }),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      cleanup();
      if (abortSignal?.aborted) {
        return reject(
          new SiteOpsMaterializationError({
            phase: "react_static_build",
            code: "SITEOPS_MATERIALIZATION_ABORTED",
            retryClass: "host_transient",
          }),
        );
      }
      if (timedOut) {
        return reject(
          new SiteOpsMaterializationError({
            phase: "react_static_build",
            code: "SITEOPS_REACT_STATIC_BUILD_TIMEOUT",
            retryClass: "host_transient",
            safeDetails: { timeoutMs: boundedTimeout },
          }),
        );
      }
      const log = Buffer.concat(chunks, Math.min(bytes, MAX_BUILD_LOG_BYTES));
      if (overflow) {
        return reject(
          new SiteOpsMaterializationError({
            phase: "react_static_build",
            code: "SITEOPS_BUILD_LOG_LIMIT_EXCEEDED",
            retryClass: "host_deterministic",
          }),
        );
      }
      if (code !== 0) {
        return reject(
          new SiteOpsMaterializationError({
            phase: "react_static_build",
            code: "SITEOPS_REACT_STATIC_BUILD_FAILED",
            retryClass: "host_deterministic",
            safeDetails: { exitCode: code, signal: signal ?? null },
          }),
        );
      }
      resolve(log);
    });
  });
}

async function collectDirectory(root: string) {
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink())
        throw new Error("SITEOPS_DIST_SYMLINK_REJECTED");
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile())
        throw new Error("SITEOPS_DIST_FILE_TYPE_REJECTED");
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        relative.startsWith("../") ||
        relative.includes("\\") ||
        relative
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      ) {
        throw new Error("SITEOPS_DIST_PATH_INVALID");
      }
      const bytes = await readFile(absolute);
      totalBytes += bytes.length;
      if (
        files.length >= MAX_ARCHIVE_ENTRIES ||
        totalBytes > MAX_DIST_BYTES ||
        bytes.length > 10 * 1024 * 1024
      ) {
        throw new Error("SITEOPS_DIST_LIMIT_EXCEEDED");
      }
      files.push({ path: relative, bytes });
    }
  };
  await visit(root);
  if (files.length < 1) throw new Error("SITEOPS_DIST_EMPTY");
  return files;
}

function servedMimeType(filename: string) {
  const extension = path.posix.extname(filename).toLowerCase();
  return (
    (
      {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp",
        ".xml": "application/xml; charset=utf-8",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

function safeQaCheckId(value: string, fallback: string) {
  return /^[a-z0-9][a-z0-9:_-]{0,95}$/u.test(value) ? value : fallback;
}

function browserQaWarning(input: {
  phase: SiteOpsQaWarning["phase"];
  code: string;
  checkId: string;
}): SiteOpsQaWarning {
  return {
    phase: input.phase,
    code: /^(?:SITEOPS|NATIVE)_[A-Z0-9_]+$/u.test(input.code)
      ? input.code
      : "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
    checkId: safeQaCheckId(input.checkId, "browser-qa"),
  };
}

async function runBrowserQaLegacy(input: {
  files: readonly SourceFile[];
  routes: SiteBrief["routes"];
  mode: "preview" | "production";
  workRoot: string;
  abortSignal?: AbortSignal;
}) {
  assertNotAborted(input.abortSignal, "browser_qa");
  const files = new Map(input.files.map((file) => [file.path, file.bytes]));
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      ) {
        response.writeHead(400).end();
        return;
      }
      const clean = decoded.replace(/^\/+|\/+$/gu, "");
      const candidates = clean
        ? path.posix.extname(clean)
          ? [clean]
          : [`${clean}/index.html`, clean]
        : ["index.html"];
      const filename = candidates.find((candidate) => files.has(candidate));
      const bytes = filename ? files.get(filename) : files.get("404.html");
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      const headers: Record<string, string | number> = {
        "Cache-Control": "no-store",
        "Content-Type": servedMimeType(filename ?? "404.html"),
        "Content-Length": bytes.length,
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      };
      if (input.mode === "preview") {
        headers["X-Robots-Tag"] = "noindex, nofollow, noarchive";
      }
      response.writeHead(filename ? 200 : 404, headers);
      response.end(bytes);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("SITEOPS_VISUAL_QA_SERVER_FAILED");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const closeServer = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const screenshotFiles: SourceFile[] = [];
  let axeViolationCount = 0;
  const axeViolationIds = new Set<string>();
  const browser = await chromium
    .launch({
      headless: true,
      chromiumSandbox: false,
      args: ["--disable-background-networking", "--disable-sync"],
      env: {
        HOME: input.workRoot,
        LANG: "C.UTF-8",
        TZ: "UTC",
        PATH: path.dirname(process.execPath),
      },
    })
    .catch(async (error) => {
      await closeServer();
      throw toSiteOpsMaterializationError({
        error,
        phase: "browser_qa",
        fallbackCode: "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
        retryClass: "host_transient",
      });
    });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const inspectedRoutes = input.routes.slice(0, 3);
    for (const route of inspectedRoutes) {
      assertNotAborted(input.abortSignal, "browser_qa");
      const routeUrl = `${origin}${route.slug}`;
      const response = await page.goto(routeUrl, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      if (!response?.ok()) throw new Error("SITEOPS_VISUAL_QA_ROUTE_FAILED");
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = axe.violations.filter((violation) =>
        ["critical", "serious"].includes(violation.impact ?? ""),
      );
      axeViolationCount += blocking.length;
      for (const violation of blocking) axeViolationIds.add(violation.id);
      for (const viewport of [
        { label: "390", width: 390, height: 844 },
        { label: "768", width: 768, height: 1024 },
        { label: "1440", width: 1440, height: 1000 },
      ] as const) {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        const png = await page.screenshot({ fullPage: true, type: "png" });
        const routeName = route.slug === "/" ? "home" : route.id;
        screenshotFiles.push({
          path: `screenshots/${routeName}-${viewport.label}.png`,
          bytes: Buffer.from(png),
        });
      }
    }
  } catch (error) {
    await closeServer();
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }

  const chromeRoot = path.join(input.workRoot, "chrome");
  assertNotAborted(input.abortSignal, "browser_qa");
  await mkdir(chromeRoot, { recursive: true, mode: 0o700 });
  const chromeProfile = path.join(chromeRoot, "profile");
  await mkdir(chromeProfile, { recursive: false, mode: 0o700 });
  const launched = await launchChrome({
    chromePath: chromium.executablePath(),
    chromeFlags: [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-sandbox",
    ],
    userDataDir: chromeProfile,
    handleSIGINT: false,
    logLevel: "silent",
    envVars: {
      HOME: chromeRoot,
      LANG: "C.UTF-8",
      TZ: "UTC",
      PATH: path.dirname(process.execPath),
    },
  }).catch(async (error) => {
    await closeServer();
    throw toSiteOpsMaterializationError({
      error,
      phase: "lighthouse",
      fallbackCode: "SITEOPS_LIGHTHOUSE_RUNTIME_UNAVAILABLE",
      retryClass: "host_transient",
    });
  });
  const abortChrome = () => {
    try {
      launched.kill();
    } catch {
      // Chrome may have already stopped.
    }
  };
  input.abortSignal?.addEventListener("abort", abortChrome, { once: true });
  try {
    assertNotAborted(input.abortSignal, "browser_qa");
    const result = await lighthouse(
      `${origin}/`,
      {
        port: launched.port,
        output: "json",
        logLevel: "silent",
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        skipAudits: input.mode === "preview" ? ["is-crawlable"] : undefined,
      },
      undefined,
    );
    if (!result?.lhr) {
      throw new SiteOpsMaterializationError({
        phase: "lighthouse",
        code: "SITEOPS_LIGHTHOUSE_NO_RESULT",
        retryClass: "host_transient",
      });
    }
    const score = (category: string) =>
      Math.round((result.lhr.categories[category]?.score ?? 0) * 100);
    const lighthouseScores = {
      performance: score("performance"),
      accessibility: score("accessibility"),
      bestPractices: score("best-practices"),
      seo: score("seo"),
      cls: Number(
        result.lhr.audits["cumulative-layout-shift"]?.numericValue ?? 1,
      ),
    };
    const lighthouseFailed =
      lighthouseScores.performance < 85 ||
      lighthouseScores.accessibility < 95 ||
      lighthouseScores.bestPractices < 90 ||
      lighthouseScores.seo < 95 ||
      lighthouseScores.cls >= 0.1;
    const failedAuditIds = Object.entries(result.lhr.audits)
      .filter(([, audit]) => audit.score !== null && audit.score < 1)
      .map(([id]) => id)
      .slice(0, 30);
    if (lighthouseFailed || axeViolationCount > 0) {
      const safeDetails: SiteOpsMaterializationSafeDetails = {
        ...lighthouseScores,
        axeViolationCount,
        axeViolationIds: [...axeViolationIds].sort().join(","),
        failedAuditIds: failedAuditIds.join(","),
      };
      throw new SiteOpsMaterializationError({
        phase: lighthouseFailed ? "lighthouse" : "browser_qa",
        code: lighthouseFailed
          ? "SITEOPS_LIGHTHOUSE_THRESHOLD_FAILED"
          : "SITEOPS_AXE_BLOCKING_VIOLATIONS",
        retryClass: "host_deterministic",
        safeDetails,
      });
    }
    return {
      summary: {
        lighthouse: lighthouseScores,
        axeViolationCount,
        screenshotFiles: screenshotFiles.map((file) => file.path),
      },
      screenshotFiles,
    };
  } finally {
    input.abortSignal?.removeEventListener("abort", abortChrome);
    try {
      launched.kill();
    } catch {
      // The process may already have exited after Lighthouse completion.
    }
    await closeServer();
  }
}

async function runBrowserQaStrict(input: {
  files: readonly SourceFile[];
  routes: SiteBrief["routes"];
  mode: "preview" | "production";
  workRoot: string;
  abortSignal?: AbortSignal;
}) {
  assertNotAborted(input.abortSignal, "browser_qa");
  const files = new Map(input.files.map((file) => [file.path, file.bytes]));
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded
          .split("/")
          .some((segment) => segment === "." || segment === "..")
      ) {
        response.writeHead(400).end();
        return;
      }
      const clean = decoded.replace(/^\/+|\/+$/gu, "");
      const candidates = clean
        ? path.posix.extname(clean)
          ? [clean]
          : [`${clean}/index.html`, clean]
        : ["index.html"];
      const filename = candidates.find((candidate) => files.has(candidate));
      const bytes = filename ? files.get(filename) : files.get("404.html");
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      const headers: Record<string, string | number> = {
        "Cache-Control": "no-store",
        "Content-Type": servedMimeType(filename ?? "404.html"),
        "Content-Length": bytes.length,
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      };
      if (input.mode === "preview") {
        headers["X-Robots-Tag"] = "noindex, nofollow, noarchive";
      }
      response.writeHead(filename ? 200 : 404, headers);
      response.end(bytes);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("SITEOPS_VISUAL_QA_SERVER_FAILED");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const closeServer = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const screenshotFiles: SourceFile[] = [];
  let axeViolationCount = 0;
  const axeViolationIds = new Set<string>();
  const browser = await chromium
    .launch({
      headless: true,
      chromiumSandbox: false,
      args: ["--disable-background-networking", "--disable-sync"],
      env: {
        HOME: input.workRoot,
        LANG: "C.UTF-8",
        TZ: "UTC",
        PATH: path.dirname(process.execPath),
      },
    })
    .catch(async (error) => {
      await closeServer();
      throw toSiteOpsMaterializationError({
        error,
        phase: "browser_qa",
        fallbackCode: "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
        retryClass: "host_transient",
      });
    });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const inspectedRoutes = input.routes.slice(0, 3);
    for (const route of inspectedRoutes) {
      assertNotAborted(input.abortSignal, "browser_qa");
      const routeUrl = `${origin}${route.slug}`;
      const response = await page.goto(routeUrl, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      if (!response?.ok()) throw new Error("SITEOPS_VISUAL_QA_ROUTE_FAILED");
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = axe.violations.filter((violation) =>
        ["critical", "serious"].includes(violation.impact ?? ""),
      );
      axeViolationCount += blocking.length;
      for (const violation of blocking) axeViolationIds.add(violation.id);
      for (const viewport of [
        { label: "390", width: 390, height: 844 },
        { label: "768", width: 768, height: 1024 },
        { label: "1440", width: 1440, height: 1000 },
      ] as const) {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        const png = await page.screenshot({ fullPage: true, type: "png" });
        const routeName = route.slug === "/" ? "home" : route.id;
        screenshotFiles.push({
          path: `screenshots/${routeName}-${viewport.label}.png`,
          bytes: Buffer.from(png),
        });
      }
    }
  } catch (error) {
    await closeServer();
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }

  const chromeRoot = path.join(input.workRoot, "chrome");
  assertNotAborted(input.abortSignal, "browser_qa");
  await mkdir(chromeRoot, { recursive: true, mode: 0o700 });
  const chromeProfile = path.join(chromeRoot, "profile");
  await mkdir(chromeProfile, { recursive: false, mode: 0o700 });
  const launched = await launchChrome({
    chromePath: chromium.executablePath(),
    chromeFlags: [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-sandbox",
    ],
    userDataDir: chromeProfile,
    handleSIGINT: false,
    logLevel: "silent",
    envVars: {
      HOME: chromeRoot,
      LANG: "C.UTF-8",
      TZ: "UTC",
      PATH: path.dirname(process.execPath),
    },
  }).catch(async (error) => {
    await closeServer();
    throw toSiteOpsMaterializationError({
      error,
      phase: "lighthouse",
      fallbackCode: "SITEOPS_LIGHTHOUSE_RUNTIME_UNAVAILABLE",
      retryClass: "host_transient",
    });
  });
  const abortChrome = () => {
    try {
      launched.kill();
    } catch {
      // Chrome may have already stopped.
    }
  };
  input.abortSignal?.addEventListener("abort", abortChrome, { once: true });
  try {
    assertNotAborted(input.abortSignal, "browser_qa");
    const result = await lighthouse(
      `${origin}/`,
      {
        port: launched.port,
        output: "json",
        logLevel: "silent",
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        skipAudits: input.mode === "preview" ? ["is-crawlable"] : undefined,
      },
      undefined,
    );
    if (!result?.lhr) {
      throw new SiteOpsMaterializationError({
        phase: "lighthouse",
        code: "SITEOPS_LIGHTHOUSE_NO_RESULT",
        retryClass: "host_transient",
      });
    }
    const score = (category: string) =>
      Math.round((result.lhr.categories[category]?.score ?? 0) * 100);
    const lighthouseScores = {
      performance: score("performance"),
      accessibility: score("accessibility"),
      bestPractices: score("best-practices"),
      seo: score("seo"),
      cls: Number(
        result.lhr.audits["cumulative-layout-shift"]?.numericValue ?? 1,
      ),
    };
    const lighthouseFailed =
      lighthouseScores.performance < 85 ||
      lighthouseScores.accessibility < 95 ||
      lighthouseScores.bestPractices < 90 ||
      lighthouseScores.seo < 95 ||
      lighthouseScores.cls >= 0.1;
    const failedAuditIds = Object.entries(result.lhr.audits)
      .filter(([, audit]) => audit.score !== null && audit.score < 1)
      .map(([id]) => id)
      .slice(0, 30);
    const warnings: SiteOpsQaWarning[] = [];
    if (lighthouseFailed) {
      warnings.push(
        browserQaWarning({
          phase: "lighthouse",
          code: "SITEOPS_LIGHTHOUSE_THRESHOLD_FAILED",
          checkId: "lighthouse:threshold",
        }),
      );
      for (const auditId of failedAuditIds) {
        warnings.push(
          browserQaWarning({
            phase: "lighthouse",
            code: "SITEOPS_LIGHTHOUSE_THRESHOLD_FAILED",
            checkId: `lighthouse:${auditId}`,
          }),
        );
      }
    }
    for (const violationId of [...axeViolationIds].sort()) {
      warnings.push(
        browserQaWarning({
          phase: "browser_qa",
          code: "SITEOPS_AXE_BLOCKING_VIOLATIONS",
          checkId: `axe:${violationId}`,
        }),
      );
    }
    return {
      summary: {
        available: true,
        lighthouse: lighthouseScores,
        axeViolationCount,
        axeViolationIds: [...axeViolationIds].sort(),
        screenshotFiles: screenshotFiles.map((file) => file.path),
      },
      screenshotFiles,
      warnings,
    };
  } finally {
    input.abortSignal?.removeEventListener("abort", abortChrome);
    try {
      launched.kill();
    } catch {
      // The process may already have exited after Lighthouse completion.
    }
    await closeServer();
  }
}

async function runBrowserQa(input: Parameters<typeof runBrowserQaStrict>[0]) {
  try {
    return await runBrowserQaStrict(input);
  } catch (error) {
    const normalized = toSiteOpsMaterializationError({
      error,
      phase: "browser_qa",
      fallbackCode: "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
      retryClass: "host_transient",
    });
    if (
      input.abortSignal?.aborted ||
      normalized.code === "SITEOPS_MATERIALIZATION_ABORTED"
    ) {
      throw normalized;
    }
    const phase =
      normalized.phase === "lighthouse" ? "lighthouse" : "browser_qa";
    return {
      summary: {
        available: false,
        lighthouse: {
          performance: null,
          accessibility: null,
          bestPractices: null,
          seo: null,
          cls: null,
        },
        axeViolationCount: 0,
        axeViolationIds: [],
        screenshotFiles: [],
      },
      screenshotFiles: [] as SourceFile[],
      warnings: [
        browserQaWarning({
          phase,
          code: normalized.code,
          checkId:
            phase === "lighthouse"
              ? "lighthouse:runtime"
              : "browser-qa:runtime",
        }),
      ],
    };
  }
}

function htmlText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasExecutableScriptTag(html: string) {
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== "<") continue;
    let quote: '"' | "'" | null = null;
    let end = index + 1;
    for (; end < html.length; end += 1) {
      const character = html[end]!;
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ">") break;
    }
    if (end >= html.length) return true;
    const tag = html.slice(index, end + 1);
    index = end;
    if (!/^<script\b/iu.test(tag)) continue;
    if (/\bsrc\s*=/iu.test(tag)) return true;
    if (!/\btype\s*=\s*["']application\/ld\+json["']/iu.test(tag)) {
      return true;
    }
  }
  return false;
}

function qaDist(input: {
  files: readonly SourceFile[];
  brief: SiteBrief;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  assetDecisions: readonly z.infer<typeof siteOpsAssetDecisionSchema>[];
  brandAsset: FrozenSiteBrandAsset | null;
  qaPolicyVersion: string;
  sourceDocumentIds: readonly string[];
  expectedHeroFamily?: string;
}) {
  const files = new Map(input.files.map((file) => [file.path, file.bytes]));
  const routeOutputs = input.brief.routes.map((route) =>
    routeOutputPath(route.slug),
  );
  const checks: SiteOpsQaReport["checks"] = [];
  const requireCheck = (id: string, condition: boolean, detail: string) => {
    if (!condition) {
      throw new SiteOpsMaterializationError({
        phase: "static_qa",
        code: "SITEOPS_STATIC_QA_FAILED",
        retryClass: "host_deterministic",
        safeDetails: {
          checkId: safeQaCheckId(id.split(":", 1)[0] ?? "", "static-qa"),
        },
      });
    }
    checks.push({ id, passed: true, detail });
  };
  requireCheck(
    "route-manifest",
    routeOutputs.every((output) => files.has(output)) && files.has("404.html"),
    `${routeOutputs.length} routes and 404 are present`,
  );
  if (input.expectedHeroFamily) {
    requireCheck(
      "frozen-hero-family",
      routeOutputs.every((output) =>
        files
          .get(output)!
          .toString("utf8")
          .includes(`data-hero-family="${input.expectedHeroFamily}"`),
      ),
      "every route renders the exact Hero family frozen in the visual blueprint",
    );
  }
  const htmlFiles = [...files.entries()].filter(([name]) =>
    name.endsWith(".html"),
  );
  if (["siteops-qa-v4", "siteops-qa-v5"].includes(input.qaPolicyVersion)) {
    const privateSourceTokens = input.sourceDocumentIds.filter(
      (documentId) => documentId.length >= 8,
    );
    const discoveryAndHtml = [...files.entries()].filter(([name]) =>
      /\.(?:html|xml|txt)$/iu.test(name),
    );
    requireCheck(
      "no-public-source-identifiers",
      discoveryAndHtml.every(([, bytes]) => {
        const text = bytes.toString("utf8");
        return privateSourceTokens.every(
          (documentId) => !text.includes(documentId),
        );
      }),
      "frozen source identifiers are absent from public HTML and discovery text",
    );
  }
  requireCheck(
    "static-html",
    htmlFiles.length >= routeOutputs.length + 1,
    "trusted host renderer emitted complete static HTML",
  );
  requireCheck(
    "brand-assets",
    files.has("favicon.svg") && files.has("social-card.svg"),
    "customer-derived favicon and social card are present",
  );
  const published = input.assetDecisions.filter(
    (decision) => decision.decision === "publish",
  );
  const expectedBrandPath = input.brandAsset
    ? input.brandAsset.publicPath.slice("public/".length)
    : null;
  requireCheck(
    "published-brand-asset",
    published.length === (input.brandAsset ? 1 : 0) &&
      (input.brandAsset
        ? published[0]?.id === input.brandAsset.assetId &&
          published[0]?.sha256 === input.brandAsset.sha256 &&
          Boolean(expectedBrandPath) &&
          files.has(expectedBrandPath!) &&
          sha256(files.get(expectedBrandPath!)!) === input.brandAsset.sha256
        : ![...files.keys()].some((name) =>
            /^brand-logo(?:\.|$)/iu.test(name),
          )),
    "every publish decision maps to the exact frozen official logo bytes",
  );
  const quarantinedHashes = new Set(
    input.assetDecisions
      .filter((decision) => decision.decision === "quarantine")
      .map((decision) => decision.sha256),
  );
  requireCheck(
    "quarantined-assets-absent",
    [...files.values()].every(
      (bytes) =>
        !quarantinedHashes.has(sha256(bytes)) &&
        ![...quarantinedHashes].some((hash) =>
          bytes.toString("utf8").includes(hash),
        ),
    ),
    "no quarantined asset bytes or hashes are emitted into the website",
  );
  for (const [name, bytes] of htmlFiles) {
    const html = bytes.toString("utf8");
    requireCheck(
      `no-js-shell:${name}`,
      htmlText(html).length >= 24 &&
        !/<div\s+id=["']root["'][^>]*>\s*<\/div>/iu.test(html),
      "meaningful text remains with JavaScript disabled",
    );
    requireCheck(
      `no-executable-script:${name}`,
      !hasExecutableScriptTag(html),
      "no executable or external script is present",
    );
    requireCheck(
      `no-sensitive-text:${name}`,
      !SENSITIVE_TEXT.test(html) && !FORBIDDEN_DEMO_TEXT.test(html),
      "no credential-shaped or demo text is present",
    );
    if (["siteops-qa-v4", "siteops-qa-v5"].includes(input.qaPolicyVersion)) {
      requireCheck(
        `no-public-source-labels:${name}`,
        !/(?:sourceDocumentIds|source_document_ids|内部来源|来源文档\s*(?:ID|编号))/iu.test(
          html,
        ),
        "internal source identifiers and labels are absent from public HTML",
      );
    }
    if (expectedBrandPath) {
      requireCheck(
        `brand-logo-rendered:${name}`,
        html.includes(`class="brand-logo"`) &&
          html.includes(`src="/${expectedBrandPath}"`),
        "the frozen official logo is rendered in the shared header",
      );
    }
    const hrefs = [...html.matchAll(/\bhref=["']([^"']+)["']/giu)].map(
      (match) => match[1]!,
    );
    for (const href of hrefs) {
      if (/^(?:https:|mailto:|tel:|#)/u.test(href)) continue;
      const pathname = new URL(href, "https://preview.invalid").pathname;
      const expected = pathname.endsWith("/")
        ? `${pathname.slice(1)}index.html` || "index.html"
        : pathname.slice(1);
      requireCheck(
        `internal-link:${name}:${href}`,
        files.has(expected),
        "internal link resolves to a generated file",
      );
    }
  }
  const robots = files.get("robots.txt")?.toString("utf8") ?? "";
  if (input.mode === "preview") {
    requireCheck(
      "preview-noindex",
      htmlFiles.every(([, bytes]) =>
        /<meta\s+name=["']robots["']\s+content=["']noindex,nofollow["']/iu.test(
          bytes.toString("utf8"),
        ),
      ),
      "every preview page is noindex,nofollow",
    );
    requireCheck(
      "preview-no-canonical",
      htmlFiles.every(
        ([, bytes]) => !/rel=["']canonical["']/iu.test(bytes.toString("utf8")),
      ),
      "preview contains no canonical link",
    );
    requireCheck(
      "preview-discovery-disabled",
      /Disallow:\s*\//u.test(robots) &&
        !files.has("sitemap.xml") &&
        !files.has("llms.txt"),
      "robots disallows crawling and discovery files are absent",
    );
  } else {
    requireCheck(
      "production-canonical",
      routeOutputs.every((output) =>
        files
          .get(output)!
          .toString("utf8")
          .includes(
            `rel="canonical" href="${routeCanonical(input.canonicalOrigin!, output === "index.html" ? "/" : `/${output.replace(/index\.html$/u, "")}`)}"`,
          ),
      ),
      "each public route has the exact HTTPS canonical",
    );
    requireCheck(
      "production-discovery",
      files.has("sitemap.xml") &&
        files.has("llms.txt") &&
        /Sitemap:\s*https:\/\//u.test(robots),
      "sitemap, robots and llms.txt are present",
    );
    requireCheck(
      "production-jsonld",
      routeOutputs.every((output) =>
        (() => {
          const html = files.get(output)!.toString("utf8");
          return (
            /type="application\/ld\+json"/u.test(html) ||
            (output === "news/index.html" &&
              html.includes('data-content-state="empty"'))
          );
        })(),
      ),
      "eligible public routes contain JSON-LD and empty news remains untyped",
    );
    requireCheck(
      "production-social-image",
      routeOutputs.every((output) =>
        files
          .get(output)!
          .toString("utf8")
          .includes(
            `property="og:image" content="${input.canonicalOrigin}/social-card.svg"`,
          ),
      ),
      "each public route references the exact canonical social card",
    );
  }
  requireCheck(
    "single-language",
    htmlFiles.every(([, bytes]) => !/hreflang=/iu.test(bytes.toString("utf8"))),
    "no false hreflang is emitted for the single-language site",
  );
  requireCheck(
    "no-javascript-assets",
    ![...files.keys()].some(
      (name) => name.endsWith(".js") || name.endsWith(".mjs"),
    ),
    "dist contains no JavaScript asset",
  );
  return {
    schemaVersion: 1,
    policyVersion: input.qaPolicyVersion,
    passed: true,
    mode: input.mode,
    routes: input.brief.routes.map((route) => route.slug),
    checks,
    fileCount: input.files.length,
    totalBytes: input.files.reduce(
      (total, file) => total + file.bytes.length,
      0,
    ),
  } satisfies Omit<SiteOpsQaReport, "browser" | "buildDelivery" | "warnings">;
}

async function materializeSiteWithWorkflow(
  input: MaterializeAstroSiteInput,
  workflow: SiteOpsMaterializerCoordinates,
  renderer: SiteRenderer,
): Promise<MaterializedAstroSite> {
  assertNotAborted(input.abortSignal);
  if (
    (input.contentPatchUsesTrustedDefaults &&
      input.renderModeOverride !== "content_patch") ||
    (input.forceTrustedFallback && input.renderModeOverride)
  ) {
    throw new Error("SITEOPS_CONTENT_PATCH_DELIVERY_INTENT_INVALID");
  }
  const reactCoordinates = isReactStaticRenderer(renderer)
    ? reactStaticCoordinatesForWorkflow(workflow)
    : null;
  const brandAsset = await materializationStage({
    phase: "input_validation",
    fallbackCode: "SITEOPS_BRAND_ASSET_INVALID",
    retryClass: "host_deterministic",
    run: async () =>
      input.brandAsset
        ? await validateTrustedSiteBrandAsset(input.brandAsset)
        : null,
  });
  const validated = await materializationStage({
    phase: "input_validation",
    fallbackCode: "SITEOPS_MATERIALIZATION_INPUT_INVALID",
    retryClass: "host_deterministic",
    run: () => validateInput(input, brandAsset, workflow, renderer),
  });
  const reactDesign = isReactStaticRenderer(renderer)
    ? siteDesignSpecV2Schema.parse(validated.designSpec)
    : null;
  const reactVisual = isReactStaticRenderer(renderer)
    ? siteOpsRuntimeVisualEvidenceV2Schema.parse(validated.visual)
    : null;
  const legacyDesign =
    renderer === LEGACY_ASTRO_RENDERER
      ? siteDesignSpecV1Schema.parse(validated.designSpec)
      : null;
  const legacyVisual =
    renderer === LEGACY_ASTRO_RENDERER
      ? siteOpsRuntimeVisualEvidenceV1Schema.parse(validated.visual)
      : null;
  const contractSeed = await materializationStage({
    phase: "source_generation",
    fallbackCode: "SITEOPS_BUILD_CONTRACT_GENERATION_FAILED",
    retryClass: "host_deterministic",
    run: () => {
      const source = {
        knowledgeSnapshotId: input.snapshot.id,
        archiveSha256: input.build.knowledgeArchiveHash,
        sourceBuildId: input.snapshot.sourceBuildId,
        sourceBuildRevision: input.snapshot.sourceBuildRevision,
      };
      const identity = {
        companyName: validated.brief.companyName,
        primaryLanguage: validated.brief.primaryLanguage,
        verifiedContacts: validated.brief.contacts.map(
          (contact) => `${contact.kind}:${contact.value}`,
        ),
      };
      const seo = {
        ...validated.designSpec.seoPlan,
        environment: input.mode,
        canonicalPolicy:
          input.mode === "preview"
            ? ("forbidden" as const)
            : ("exact_https_origin" as const),
      };
      const target = {
        environment:
          input.mode === "preview"
            ? ("preview" as const)
            : (input.target ?? "global_excluding_cn"),
        canonicalOrigin: validated.canonicalOrigin,
      };
      if (isReactStaticRenderer(renderer)) {
        if (!reactDesign || !reactVisual) {
          throw new Error("SITEOPS_REACT_V2_CONTRACT_INPUT_MISSING");
        }
        const {
          schemaVersion: _schemaVersion,
          referenceBlueprint: _referenceBlueprint,
          ...contractVisual
        } = reactVisual;
        const commonReactContract = {
          contractKind: "build_plan" as const,
          source,
          workflow: {
            upstreamSha256: workflow.upstreamSha256,
            version: workflow.frontMindVersion,
            manifestSha256: workflow.runtimeManifestSha256,
            starterVersion: workflow.starterVersion,
            starterSha256: workflow.starterSha256,
            componentLibraryVersion: reactCoordinates!.componentLibraryVersion,
            materializerVersion: reactCoordinates!.materializerVersion,
            materializerSha256: workflow.materializerSha256,
          },
          renderer: {
            kind: renderer,
            reactVersion: REACT_STATIC_REACT_VERSION,
            componentLibraryVersion: reactCoordinates!.componentLibraryVersion,
            materializerVersion: reactCoordinates!.materializerVersion,
          },
          identity,
          visual: contractVisual,
          referenceBlueprint: reactDesign.referenceBlueprint,
          designSpecHash: canonicalSiteOpsSha256(reactDesign),
          routes: validated.brief.routes,
          assets: validated.assetDecisions,
          seo,
          target,
          qaPolicyVersion: workflow.qaPolicyVersion,
        };
        return renderer === REACT_STATIC_RENDERER
          ? composeBuildPlanContractV4({
              ...commonReactContract,
              schemaVersion: 4,
              renderer: {
                kind: REACT_STATIC_RENDERER,
                reactVersion: REACT_STATIC_REACT_VERSION,
                componentLibraryVersion: reactCoordinates!
                  .componentLibraryVersion as
                  | "2.2.0"
                  | "2.3.0"
                  | "2.4.0"
                  | "2.6.0",
                materializerVersion: reactCoordinates!.materializerVersion as
                  | "2.2.0"
                  | "2.3.0"
                  | "2.4.0"
                  | "2.6.0",
              },
              content: {
                schemaVersion: 2,
                inventoryHash: canonicalSiteOpsSha256(
                  validated.brief.contentInventory,
                ),
                routePolicyVersion: "snapshot-conditional-v1",
                sourcePolicy: "frozen_snapshot_only",
                externalAcquisitionAllowed: false,
                publicSourceLabels: "forbidden",
              },
            })
          : composeBuildPlanContractV3({
              ...commonReactContract,
              schemaVersion: 3,
              renderer: {
                kind: REACT_STATIC_RENDERER_V1,
                reactVersion: REACT_STATIC_REACT_VERSION,
                componentLibraryVersion: reactCoordinates!
                  .componentLibraryVersion as "2.0.0" | "2.1.0",
                materializerVersion: reactCoordinates!.materializerVersion as
                  | "2.0.0"
                  | "2.1.0",
              },
            });
      }
      if (!legacyDesign || !legacyVisual) {
        throw new Error("SITEOPS_ASTRO_V1_CONTRACT_INPUT_MISSING");
      }
      return composeBuildContractV2({
        schemaVersion: 2,
        source,
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
        identity,
        visual: {
          ...legacyVisual,
          designSpecHash: canonicalSiteOpsSha256(legacyDesign),
          componentLibraryVersion: workflow.componentLibraryVersion,
        },
        routes: validated.brief.routes,
        assets: validated.assetDecisions,
        seo,
        target,
        qaPolicyVersion: workflow.qaPolicyVersion,
      });
    },
  });
  const frozenRuntimeInput = await materializationStage({
    phase: "source_generation",
    fallbackCode: "SITEOPS_FROZEN_RUNTIME_INPUT_INVALID",
    retryClass: "host_deterministic",
    run: () =>
      siteOpsFrozenRuntimeInputSchema.parse({
        schemaVersion: 2,
        build: {
          id: input.build.id,
          projectId: input.build.projectId,
          userId: input.build.userId,
          knowledgeSnapshotId: input.build.knowledgeSnapshotId,
          knowledgeArchiveHash: input.build.knowledgeArchiveHash,
          workflowUpstreamVersion: input.build.workflowUpstreamVersion,
          workflowUpstreamHash: input.build.workflowUpstreamHash,
          workflowVersion: input.build.workflowVersion,
          workflowPackageHash: input.build.workflowPackageHash,
          starterVersion: input.build.starterVersion,
          selectionHash: input.build.selectionHash,
        },
        host: {
          starterSha256: workflow.starterSha256,
          componentLibraryVersion: isReactStaticRenderer(renderer)
            ? reactCoordinates!.componentLibraryVersion
            : workflow.componentLibraryVersion,
          materializerVersion: isReactStaticRenderer(renderer)
            ? reactCoordinates!.materializerVersion
            : workflow.materializerVersion,
          materializerSha256: workflow.materializerSha256,
          renderer,
        },
        snapshot: {
          id: input.snapshot.id,
          userId: input.snapshot.userId,
          archiveHash: input.snapshot.archiveHash,
          sourceBuildId: input.snapshot.sourceBuildId,
          sourceBuildRevision: input.snapshot.sourceBuildRevision,
          sourceDocumentIds: [...validated.sourceDocuments.keys()].sort(),
        },
        brief: validated.brief,
        visual: validated.visual,
        designSpec: validated.designSpec,
        generatedContent: validated.generatedContent,
        ...(input.renderModeOverride === "content_patch"
          ? {
              renderMode: "content_patch" as const,
              ...(input.contentPatchUsesTrustedDefaults
                ? { contentPatchUsesTrustedDefaults: true }
                : {}),
            }
          : {}),
        assetDecisions: validated.assetDecisions,
        brandAsset: freezeSiteBrandAsset(validated.brandAsset),
      }),
  });
  let renderMode: SiteOpsBuildDelivery["renderMode"] =
    input.forceTrustedFallback
      ? "trusted_fallback"
      : (input.renderModeOverride ?? "primary");
  const renderWarnings: SiteOpsQaWarning[] = [];
  if (input.forceTrustedFallback) {
    renderWarnings.push(
      browserQaWarning({
        phase: "react_static_build",
        code: input.forceTrustedFallback.warningCode,
        checkId: "native-provider:trusted-fallback",
      }),
    );
  }
  if (
    input.renderModeOverride === "content_patch" &&
    input.contentPatchUsesTrustedDefaults
  ) {
    renderWarnings.push(
      browserQaWarning({
        phase: "react_static_build",
        code: SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE,
        checkId: "content-patch:trusted-defaults",
      }),
    );
  }
  let sourceFiles: SourceFile[];
  if (input.forceTrustedFallback) {
    if (
      !isReactStaticRenderer(renderer) ||
      (contractSeed.schemaVersion !== 3 && contractSeed.schemaVersion !== 4)
    ) {
      throw new Error("SITEOPS_TRUSTED_FALLBACK_WORKFLOW_INVALID");
    }
    sourceFiles = buildTrustedFallbackSource({
      frozenRuntimeInput,
      contract: contractSeed,
      brandAsset: validated.brandAsset,
      primaryFailureCode: input.forceTrustedFallback.warningCode,
    });
  } else
    try {
      sourceFiles = await materializationStage({
        phase: "source_generation",
        fallbackCode: "SITEOPS_SOURCE_GENERATION_FAILED",
        retryClass: "host_deterministic",
        run: () => {
          const common = {
            frozenRuntimeInput,
            brief: validated.brief,
            content: validated.generatedContent,
            canonicalOrigin: validated.canonicalOrigin,
            mode: input.mode,
            brandAsset: validated.brandAsset,
            workflow,
          };
          if (isReactStaticRenderer(renderer)) {
            if (
              (contractSeed.schemaVersion !== 3 &&
                contractSeed.schemaVersion !== 4) ||
              !reactDesign ||
              !reactVisual
            ) {
              throw new Error("SITEOPS_REACT_V2_SOURCE_INPUT_MISSING");
            }
            return buildTrustedReactSource({
              ...common,
              contract: contractSeed,
              visual: reactVisual,
              designSpec: reactDesign,
              renderer,
            });
          }
          if (
            contractSeed.schemaVersion !== 2 ||
            !legacyDesign ||
            !legacyVisual
          ) {
            throw new Error("SITEOPS_ASTRO_V1_SOURCE_INPUT_MISSING");
          }
          return buildTrustedAstroSource({
            ...common,
            contract: contractSeed,
            visual: legacyVisual,
            designSpec: legacyDesign,
          });
        },
      });
    } catch (error) {
      const normalized = toSiteOpsMaterializationError({
        error,
        phase: "source_generation",
        fallbackCode: "SITEOPS_SOURCE_GENERATION_FAILED",
        retryClass: "host_deterministic",
      });
      if (
        workflow.frontMindVersion !== SITEOPS_WORKFLOW.frontMindVersion ||
        !isReactStaticRenderer(renderer) ||
        input.abortSignal?.aborted ||
        normalized.code === "SITEOPS_MATERIALIZATION_ABORTED" ||
        !reactDesign ||
        contractSeed.schemaVersion !== 4
      ) {
        throw normalized;
      }
      renderMode = "trusted_fallback";
      renderWarnings.push(
        browserQaWarning({
          phase: "react_static_build",
          code: normalized.code,
          checkId: "primary-source:fallback",
        }),
      );
      sourceFiles = buildTrustedFallbackSource({
        frozenRuntimeInput,
        contract: contractSeed,
        brandAsset: validated.brandAsset,
        primaryFailureCode: normalized.code,
      });
    }
  await materializationStage({
    phase: "asset_projection",
    fallbackCode: "SITEOPS_SOURCE_ASSET_ISOLATION_FAILED",
    retryClass: "host_deterministic",
    safeDetails: {
      assetDecisionCount: validated.assetDecisions.length,
      publishedCount: validated.assetDecisions.filter(
        (item) => item.decision === "publish",
      ).length,
      omittedDuplicateCount: validated.assetDecisions.filter(
        (item) => item.decision === "omit",
      ).length,
      quarantineCount: validated.assetDecisions.filter(
        (item) => item.decision === "quarantine",
      ).length,
    },
    run: () =>
      assertTrustedSourceAssetIsolation({
        files: sourceFiles,
        assetDecisions: validated.assetDecisions,
        brandAsset: validated.brandAsset,
      }),
  });
  const nonce = randomBytes(8).toString("hex");
  const buildRoot = await mkdtemp(
    path.join(tmpdir(), `frontmind-siteops-${input.build.id}-${nonce}-`),
  );
  try {
    const buildPhase = isReactStaticRenderer(renderer)
      ? ("react_static_build" as const)
      : ("astro_build" as const);
    let buildLog: Buffer;
    let distFiles: SourceFile[];
    if (renderMode === "trusted_fallback") {
      distFiles = await materializationStage({
        phase: "react_static_build",
        fallbackCode: "SITEOPS_TRUSTED_FALLBACK_RENDER_FAILED",
        retryClass: "host_deterministic",
        run: () =>
          buildTrustedFallbackDist({
            brief: validated.brief,
            content: validated.generatedContent,
            designSpec: reactDesign!,
            mode: input.mode,
            canonicalOrigin: validated.canonicalOrigin,
            brandAsset: validated.brandAsset,
          }),
      });
      buildLog = jsonBuffer({
        schemaVersion: 1,
        renderMode,
        warningCode: renderWarnings[0]!.code,
      });
    } else
      try {
        await materializationStage({
          phase: "source_generation",
          fallbackCode: "SITEOPS_SOURCE_WRITE_FAILED",
          retryClass: "host_deterministic",
          run: () => writeSourceRoot(buildRoot, sourceFiles),
        });
        buildLog = await materializationStage({
          phase: buildPhase,
          fallbackCode: isReactStaticRenderer(renderer)
            ? "SITEOPS_REACT_STATIC_BUILD_FAILED"
            : "SITEOPS_ASTRO_BUILD_FAILED",
          retryClass: "host_deterministic",
          run: () =>
            isReactStaticRenderer(renderer)
              ? runReactStaticBuild(
                  buildRoot,
                  input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
                  input.abortSignal,
                )
              : runAstroBuild(
                  buildRoot,
                  input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
                  input.abortSignal,
                ),
        });
        const distRoot = path.join(buildRoot, "dist");
        distFiles = await materializationStage({
          phase: buildPhase,
          fallbackCode: isReactStaticRenderer(renderer)
            ? "SITEOPS_REACT_STATIC_DIST_COLLECTION_FAILED"
            : "SITEOPS_ASTRO_DIST_COLLECTION_FAILED",
          retryClass: "host_deterministic",
          run: () => collectDirectory(distRoot),
        });
      } catch (error) {
        const normalized = toSiteOpsMaterializationError({
          error,
          phase: buildPhase,
          fallbackCode: "SITEOPS_REACT_STATIC_BUILD_FAILED",
          retryClass: "host_deterministic",
        });
        if (
          workflow.frontMindVersion !== SITEOPS_WORKFLOW.frontMindVersion ||
          !isReactStaticRenderer(renderer) ||
          input.abortSignal?.aborted ||
          normalized.code === "SITEOPS_MATERIALIZATION_ABORTED" ||
          !reactDesign
        ) {
          throw normalized;
        }
        renderMode = "trusted_fallback";
        renderWarnings.push(
          browserQaWarning({
            phase: "react_static_build",
            code: normalized.code,
            checkId: "primary-render:fallback",
          }),
        );
        sourceFiles = [
          ...sourceFiles,
          {
            path: "frontmind-trusted-fallback.json",
            bytes: jsonBuffer({
              schemaVersion: 1,
              renderer: "trusted_static_fallback_v1",
              primaryFailureCode: normalized.code,
            }),
          },
        ].sort((left, right) => left.path.localeCompare(right.path));
        await materializationStage({
          phase: "asset_projection",
          fallbackCode: "SITEOPS_FALLBACK_ASSET_ISOLATION_FAILED",
          retryClass: "host_deterministic",
          run: () =>
            assertTrustedSourceAssetIsolation({
              files: sourceFiles,
              assetDecisions: validated.assetDecisions,
              brandAsset: validated.brandAsset,
            }),
        });
        distFiles = await materializationStage({
          phase: "react_static_build",
          fallbackCode: "SITEOPS_TRUSTED_FALLBACK_RENDER_FAILED",
          retryClass: "host_deterministic",
          run: () =>
            buildTrustedFallbackDist({
              brief: validated.brief,
              content: validated.generatedContent,
              designSpec: reactDesign,
              mode: input.mode,
              canonicalOrigin: validated.canonicalOrigin,
              brandAsset: validated.brandAsset,
            }),
        });
        buildLog = jsonBuffer({
          schemaVersion: 1,
          renderMode,
          warningCode: normalized.code,
        });
      }
    const staticQa = await materializationStage({
      phase: "static_qa",
      fallbackCode: "SITEOPS_STATIC_QA_FAILED",
      retryClass: "host_deterministic",
      run: () =>
        qaDist({
          files: distFiles,
          brief: validated.brief,
          mode: input.mode,
          canonicalOrigin: validated.canonicalOrigin,
          assetDecisions: validated.assetDecisions,
          brandAsset: freezeSiteBrandAsset(validated.brandAsset),
          qaPolicyVersion: workflow.qaPolicyVersion,
          sourceDocumentIds: [...validated.sourceDocuments.keys()],
          expectedHeroFamily:
            isReactStaticRenderer(renderer) &&
            validated.designSpec.schemaVersion === 2
              ? validated.designSpec.referenceBlueprint.heroFamily
              : undefined,
        }),
    });
    const currentDeliveryWorkflow =
      workflow.frontMindVersion === SITEOPS_WORKFLOW.frontMindVersion ||
      Boolean(input.forceTrustedFallback);
    const browserQa = currentDeliveryWorkflow
      ? await materializationStage({
          phase: "browser_qa",
          fallbackCode: "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
          retryClass: "host_transient",
          run: () =>
            runBrowserQa({
              files: distFiles,
              routes: validated.brief.routes,
              mode: input.mode,
              workRoot: buildRoot,
              abortSignal: input.abortSignal,
            }),
        })
      : await materializationStage({
          phase: "browser_qa",
          fallbackCode: "SITEOPS_BROWSER_QA_RUNTIME_UNAVAILABLE",
          retryClass: "host_transient",
          run: () =>
            runBrowserQaLegacy({
              files: distFiles,
              routes: validated.brief.routes,
              mode: input.mode,
              workRoot: buildRoot,
              abortSignal: input.abortSignal,
            }),
        });
    const warnings = currentDeliveryWorkflow
      ? [
          ...renderWarnings,
          ...(browserQa as Awaited<ReturnType<typeof runBrowserQa>>).warnings,
        ]
      : [];
    const warningCodes = [...new Set(warnings.map((warning) => warning.code))];
    const buildDelivery: SiteOpsBuildDelivery = currentDeliveryWorkflow
      ? {
          renderMode,
          qaStatus:
            renderMode === "trusted_fallback" ||
            !(browserQa as Awaited<ReturnType<typeof runBrowserQa>>).summary
              .available
              ? "partial"
              : warnings.length > 0
                ? "passed_with_warnings"
                : "passed",
          warningCodes,
        }
      : {
          renderMode: "primary",
          qaStatus: "passed",
          warningCodes: [],
        };
    const qa = currentDeliveryWorkflow
      ? ({
          ...staticQa,
          browser: (browserQa as Awaited<ReturnType<typeof runBrowserQa>>)
            .summary,
          buildDelivery,
          warnings,
        } satisfies SiteOpsQaReport)
      : {
          ...staticQa,
          browser: browserQa.summary,
        };
    const { distZip, qaJson, visualQaZip } = await materializationStage({
      phase: "qa_packaging",
      fallbackCode: "SITEOPS_QA_PACKAGING_FAILED",
      retryClass: "host_deterministic",
      run: async () => {
        const packagedDist = await deterministicZip(distFiles, MAX_DIST_BYTES);
        const packagedQa = jsonBuffer(qa);
        const packagedVisualQa = await deterministicZip(
          [
            { path: "visual-qa/report.json", bytes: packagedQa },
            ...browserQa.screenshotFiles,
          ],
          MAX_DIST_BYTES,
        );
        return {
          distZip: packagedDist,
          qaJson: packagedQa,
          visualQaZip: packagedVisualQa,
        };
      },
    });
    const { contract, contractJson, sourceZip } = await materializationStage({
      phase: "source_generation",
      fallbackCode: "SITEOPS_SOURCE_FINALIZATION_FAILED",
      retryClass: "host_deterministic",
      run: async () => {
        if (isReactStaticRenderer(renderer)) {
          if (
            contractSeed.schemaVersion !== 3 &&
            contractSeed.schemaVersion !== 4
          ) {
            throw new Error("SITEOPS_REACT_BUILD_PLAN_INVALID");
          }
          const finalized =
            contractSeed.schemaVersion === 4
              ? (() => {
                  const {
                    contractKind: _contractKind,
                    specHash: _planHash,
                    ...plan
                  } = contractSeed;
                  return composeBuildContractV4({
                    ...plan,
                    contractKind: "build_contract",
                    contentSpecHash: canonicalSiteOpsSha256(
                      validated.generatedContent,
                    ),
                    sourceHash: trustedSourceTreeHash(sourceFiles),
                    distHash: sha256(distZip),
                  });
                })()
              : (() => {
                  const {
                    contractKind: _contractKind,
                    specHash: _planHash,
                    ...plan
                  } = contractSeed;
                  return composeBuildContractV3({
                    ...plan,
                    contractKind: "build_contract",
                    sourceHash: trustedSourceTreeHash(sourceFiles),
                    distHash: sha256(distZip),
                  });
                })();
          const finalizedJson = jsonBuffer(finalized);
          const finalizedFiles = [
            ...sourceFiles.filter(
              (file) => file.path !== "build-contract.json",
            ),
            { path: "build-contract.json", bytes: finalizedJson },
          ].sort((left, right) => left.path.localeCompare(right.path));
          return {
            contract: finalized,
            contractJson: finalizedJson,
            sourceZip: await deterministicZip(finalizedFiles, MAX_SOURCE_BYTES),
          };
        }
        if (contractSeed.schemaVersion !== 2) {
          throw new Error("SITEOPS_ASTRO_BUILD_CONTRACT_INVALID");
        }
        const legacyContractJson = jsonBuffer(contractSeed);
        return {
          contract: contractSeed,
          contractJson: legacyContractJson,
          sourceZip: await deterministicZip(sourceFiles, MAX_SOURCE_BYTES),
        };
      },
    });
    const provenance = {
      schemaVersion: 1,
      buildId: input.build.id,
      projectId: input.build.projectId,
      knowledgeSnapshotId: input.snapshot.id,
      knowledgeArchiveSha256: input.build.knowledgeArchiveHash,
      workflow: {
        upstreamSha256: workflow.upstreamSha256,
        runtimeManifestSha256: workflow.runtimeManifestSha256,
        version: workflow.frontMindVersion,
        starterVersion: workflow.starterVersion,
        starterSha256: workflow.starterSha256,
        componentLibraryVersion: isReactStaticRenderer(renderer)
          ? reactCoordinates!.componentLibraryVersion
          : workflow.componentLibraryVersion,
        materializerVersion: isReactStaticRenderer(renderer)
          ? reactCoordinates!.materializerVersion
          : workflow.materializerVersion,
        materializerSha256: workflow.materializerSha256,
        renderer,
        reactVersion: isReactStaticRenderer(renderer)
          ? REACT_STATIC_REACT_VERSION
          : null,
      },
      visual: {
        queryHash: validated.visual.queryHash,
        selectedCandidateId: validated.visual.selectedCandidateId,
        providerItemKey: validated.visual.providerItemKey,
        visualEvidenceSha256: validated.visual.visualEvidenceSha256,
        previewSha256: validated.visual.previewSha256,
        supportEvidenceSha256s: validated.visual.supportEvidenceSha256s,
        designSpecHash: canonicalSiteOpsSha256(validated.designSpec),
      },
      ...(currentDeliveryWorkflow ? { buildDelivery } : {}),
      brandAsset: freezeSiteBrandAsset(validated.brandAsset),
      contractSha256: sha256(contractJson),
      sourceSha256: sha256(sourceZip),
      distSha256: sha256(distZip),
      providerCodeReused: false,
      providerPromptPersisted: false,
      packageOrConfigAcceptedFromProvider: false,
      runtimeInstallPerformed: false,
    };
    const provenanceJson = jsonBuffer(provenance);
    return {
      contract,
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip,
      sourceSha256: sha256(sourceZip),
      distZip,
      distSha256: sha256(distZip),
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip,
      visualQaSha256: sha256(visualQaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      buildLog,
      files: new Map(distFiles.map((file) => [file.path, file.bytes])),
      buildDelivery,
    };
  } finally {
    await rm(buildRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export function materializeAstroSite(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_WORKFLOW,
    REACT_STATIC_RENDERER,
  );
}

/** Builds a native-2.5 emergency preview without reading or executing the
 * provider's source archive. This preview is deliberately absent from the
 * production registry and cannot be deployed before a formal result arrives. */
export function materializeNativeTrustedFallbackSite(
  input: Omit<MaterializeAstroSiteInput, "forceTrustedFallback"> & {
    warningCode: string;
  },
) {
  const { warningCode, ...materializeInput } = input;
  const nativeBuild = materializeInput.build;
  if (
    nativeBuild.workflowUpstreamVersion !==
      SITEOPS_MATERIALIZER_V2_5.upstreamVersion ||
    nativeBuild.workflowUpstreamHash !==
      SITEOPS_MATERIALIZER_V2_5.upstreamSha256 ||
    nativeBuild.workflowVersion !==
      SITEOPS_MATERIALIZER_V2_5.frontMindVersion ||
    (nativeBuild.workflowPackageHash !== null &&
      nativeBuild.workflowPackageHash !==
        SITEOPS_MATERIALIZER_V2_5.runtimeManifestSha256) ||
    nativeBuild.starterVersion !== SITEOPS_MATERIALIZER_V2_5.starterVersion
  ) {
    throw new Error("SITEOPS_NATIVE_FALLBACK_WORKFLOW_COORDINATES_MISMATCH");
  }

  // The persisted build and provider task remain native 2.5. The emergency
  // source bundle truthfully records the audited host 2.4 renderer that made
  // it, rather than inventing a hybrid workflow which no immutable contract
  // recognizes. The worker binds the original native coordinates separately
  // in fallbackPreview and keeps this preview non-approvable/non-deployable.
  const hostBuild: TrustedBuildCoordinates = {
    ...nativeBuild,
    workflowUpstreamVersion: SITEOPS_WORKFLOW.upstreamVersion,
    workflowUpstreamHash: SITEOPS_WORKFLOW.upstreamSha256,
    workflowVersion: SITEOPS_WORKFLOW.frontMindVersion,
    workflowPackageHash: SITEOPS_WORKFLOW.runtimeManifestSha256,
    starterVersion: SITEOPS_WORKFLOW.starterVersion,
  };
  return materializeSiteWithWorkflow(
    {
      ...materializeInput,
      build: hostBuild,
      forceTrustedFallback: { warningCode },
    },
    SITEOPS_WORKFLOW,
    REACT_STATIC_RENDERER,
  );
}

function materializeAstroSiteV1_2(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V1_2,
    LEGACY_ASTRO_RENDERER,
  );
}

function materializeAstroSiteV1_3(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V1_3,
    LEGACY_ASTRO_RENDERER,
  );
}

function materializeAstroSiteV1_4(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V1_4,
    LEGACY_ASTRO_RENDERER,
  );
}

function materializeAstroSiteV1_5(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V1_5,
    LEGACY_ASTRO_RENDERER,
  );
}

function materializeAstroSiteV1_6(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V1_6,
    LEGACY_ASTRO_RENDERER,
  );
}

function materializeReactStaticSiteV2_0(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V2_0,
    REACT_STATIC_RENDERER_V1,
  );
}

function materializeReactStaticSiteV2_1(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V2_1,
    REACT_STATIC_RENDERER_V1,
  );
}

function materializeReactStaticSiteV2_2(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V2_2,
    REACT_STATIC_RENDERER,
  );
}

function materializeReactStaticSiteV2_3(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V2_3,
    REACT_STATIC_RENDERER,
  );
}

function materializeReactStaticSiteV2_4(input: MaterializeAstroSiteInput) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_WORKFLOW,
    REACT_STATIC_RENDERER,
  );
}

/** Reader-only compatibility materializer for source archives frozen before
 * SiteContentPatchV1 added delivery provenance to the 2.4 runtime. New builds
 * never select these coordinates through `siteOpsWorkflowForVersion`. */
function materializeReactStaticSiteV2_4Legacy(
  input: MaterializeAstroSiteInput,
) {
  return materializeSiteWithWorkflow(
    input,
    SITEOPS_MATERIALIZER_V2_4_LEGACY,
    REACT_STATIC_RENDERER,
  );
}

const productionMaterializerRegistry = [
  {
    workflow: SITEOPS_MATERIALIZER_V1_2,
    renderer: LEGACY_ASTRO_RENDERER,
    materialize: materializeAstroSiteV1_2,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V1_3,
    renderer: LEGACY_ASTRO_RENDERER,
    materialize: materializeAstroSiteV1_3,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V1_4,
    renderer: LEGACY_ASTRO_RENDERER,
    materialize: materializeAstroSiteV1_4,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V1_5,
    renderer: LEGACY_ASTRO_RENDERER,
    materialize: materializeAstroSiteV1_5,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V1_6,
    renderer: LEGACY_ASTRO_RENDERER,
    materialize: materializeAstroSiteV1_6,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V2_0,
    renderer: REACT_STATIC_RENDERER_V1,
    materialize: materializeReactStaticSiteV2_0,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V2_1,
    renderer: REACT_STATIC_RENDERER_V1,
    materialize: materializeReactStaticSiteV2_1,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V2_2,
    renderer: REACT_STATIC_RENDERER,
    materialize: materializeReactStaticSiteV2_2,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V2_3,
    renderer: REACT_STATIC_RENDERER,
    materialize: materializeReactStaticSiteV2_3,
  },
  {
    workflow: SITEOPS_MATERIALIZER_V2_4_LEGACY,
    renderer: REACT_STATIC_RENDERER,
    materialize: materializeReactStaticSiteV2_4Legacy,
  },
  {
    workflow: SITEOPS_WORKFLOW,
    renderer: REACT_STATIC_RENDERER,
    materialize: materializeReactStaticSiteV2_4,
  },
] as const;

/**
 * Rebuilds the exact approved content for a production hostname from the
 * host-generated preview source bundle. Callers cannot supply page content,
 * paths, dependencies or source code at publication time.
 */
export async function materializeProductionSiteFromSource(input: {
  sourceZip: Buffer;
  expectedSourceSha256: string;
  canonicalOrigin: string;
  target: "global_excluding_cn" | "mainland_cn";
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}) {
  assertNotAborted(input.abortSignal);
  if (
    input.sourceZip.length < 1 ||
    input.sourceZip.length > MAX_SOURCE_BYTES ||
    !/^[a-f0-9]{64}$/u.test(input.expectedSourceSha256) ||
    sha256(input.sourceZip) !== input.expectedSourceSha256
  ) {
    throw new Error("SITEOPS_PRODUCTION_SOURCE_HASH_MISMATCH");
  }
  const canonicalOrigin = validateCanonicalOrigin(
    "production",
    input.canonicalOrigin,
  )!;
  const archive = await JSZip.loadAsync(input.sourceZip, { checkCRC32: true });
  const entries = Object.values(archive.files);
  if (entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("SITEOPS_PRODUCTION_SOURCE_STRUCTURE_INVALID");
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = entry.name.normalize("NFKC");
    const mode = Number(entry.unixPermissions ?? 0);
    if (
      normalized !== entry.name ||
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0") ||
      entry.name.split("/").some((part) => part === "." || part === "..") ||
      (mode && (mode & 0o170000) === 0o120000)
    ) {
      throw new Error("SITEOPS_PRODUCTION_SOURCE_STRUCTURE_INVALID");
    }
    const collisionKey = normalized.toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) {
      throw new Error("SITEOPS_PRODUCTION_SOURCE_PATH_COLLISION");
    }
    seen.add(collisionKey);
  }
  const runtimeEntry = archive.file("frontmind-runtime-input.json");
  if (!runtimeEntry) {
    throw new Error("SITEOPS_FROZEN_RUNTIME_INPUT_MISSING");
  }
  const runtimeBytes = await runtimeEntry.async("nodebuffer");
  if (runtimeBytes.length < 1 || runtimeBytes.length > 4 * 1024 * 1024) {
    throw new Error("SITEOPS_FROZEN_RUNTIME_INPUT_SIZE_INVALID");
  }
  let rawRuntime: unknown;
  try {
    rawRuntime = JSON.parse(runtimeBytes.toString("utf8"));
  } catch {
    throw new Error("SITEOPS_FROZEN_RUNTIME_INPUT_INVALID");
  }
  const frozen = siteOpsFrozenRuntimeInputSchema.parse(rawRuntime);
  if (
    frozen.contentPatchUsesTrustedDefaults &&
    frozen.renderMode !== "content_patch"
  ) {
    throw new Error("SITEOPS_FROZEN_CONTENT_PATCH_INTENT_INVALID");
  }
  if (
    frozen.build.knowledgeSnapshotId !== frozen.snapshot.id ||
    frozen.build.knowledgeArchiveHash !== frozen.snapshot.archiveHash ||
    frozen.build.userId !== frozen.snapshot.userId
  ) {
    throw new Error("SITEOPS_FROZEN_RUNTIME_COORDINATES_MISMATCH");
  }
  const registeredMaterializer = productionMaterializerRegistry.find(
    ({ workflow, renderer }) =>
      frozen.host.renderer === renderer &&
      frozen.build.workflowUpstreamVersion === workflow.upstreamVersion &&
      frozen.build.workflowUpstreamHash === workflow.upstreamSha256 &&
      frozen.build.workflowVersion === workflow.frontMindVersion &&
      frozen.build.workflowPackageHash === workflow.runtimeManifestSha256 &&
      frozen.build.starterVersion === workflow.starterVersion &&
      frozen.host.starterSha256 === workflow.starterSha256 &&
      frozen.host.componentLibraryVersion ===
        (isReactStaticRenderer(renderer)
          ? reactStaticCoordinatesForWorkflow(workflow).componentLibraryVersion
          : workflow.componentLibraryVersion) &&
      frozen.host.materializerVersion ===
        (isReactStaticRenderer(renderer)
          ? reactStaticCoordinatesForWorkflow(workflow).materializerVersion
          : workflow.materializerVersion) &&
      frozen.host.materializerSha256 === workflow.materializerSha256,
  );
  if (!registeredMaterializer) {
    throw new Error("SITEOPS_FROZEN_HOST_COORDINATES_MISMATCH");
  }
  let brandAsset: TrustedSiteBrandAsset | null = null;
  if (frozen.brandAsset) {
    const brandEntry = archive.file(frozen.brandAsset.publicPath);
    if (!brandEntry) throw new Error("SITEOPS_FROZEN_BRAND_ASSET_MISSING");
    const brandBytes = await brandEntry.async("nodebuffer");
    brandAsset = await validateTrustedSiteBrandAsset({
      ...frozen.brandAsset,
      bytes: brandBytes,
    });
  } else if (
    entries.some(
      (entry) =>
        !entry.dir && /^public\/brand-logo(?:\.[^/]+)?$/iu.test(entry.name),
    )
  ) {
    throw new Error("SITEOPS_FROZEN_BRAND_ASSET_UNDECLARED");
  }
  const materialized = await registeredMaterializer.materialize({
    build: frozen.build,
    snapshot: {
      id: frozen.snapshot.id,
      userId: frozen.snapshot.userId,
      archiveHash: frozen.snapshot.archiveHash,
      sourceBuildId: frozen.snapshot.sourceBuildId,
      sourceBuildRevision: frozen.snapshot.sourceBuildRevision,
      documents: frozen.snapshot.sourceDocumentIds.map((id) => ({
        id,
        path: id,
        title: "",
        content: "",
        customerVisible: true,
      })),
    },
    brief: frozen.brief,
    visual: frozen.visual,
    designSpec: frozen.designSpec,
    generatedContent: frozen.generatedContent,
    assetDecisions: frozen.assetDecisions,
    brandAsset,
    mode: "production",
    target: input.target,
    canonicalOrigin,
    timeoutMs: input.timeoutMs,
    abortSignal: input.abortSignal,
    ...(frozen.renderMode === "content_patch"
      ? {
          renderModeOverride: "content_patch" as const,
          ...(frozen.contentPatchUsesTrustedDefaults
            ? { contentPatchUsesTrustedDefaults: true }
            : {}),
        }
      : {}),
  });
  return {
    contractJson: materialized.contractJson,
    contractSha256: materialized.contractSha256,
    sourceZip: materialized.sourceZip,
    sourceSha256: materialized.sourceSha256,
    distZip: materialized.distZip,
    distSha256: materialized.distSha256,
    qaZip: materialized.visualQaZip,
    qaSha256: materialized.visualQaSha256,
    qaReport: JSON.parse(
      materialized.qaJson.toString("utf8"),
    ) as SiteOpsQaReport,
    buildDelivery: materialized.buildDelivery,
    provenanceJson: materialized.provenanceJson,
    provenanceSha256: materialized.provenanceSha256,
  };
}

const socialSourceSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    title: z.string().trim().min(1).max(255),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

const socialSectionSchema = z
  .object({
    heading: z.string().trim().min(1).max(100),
    paragraphs: z.array(z.string().trim().min(1).max(1_000)).min(1).max(5),
    sourceDocumentIds: z
      .array(z.string().trim().min(1).max(191))
      .min(1)
      .max(20),
  })
  .strict();

export const socialPackageInputSchema = z
  .object({
    channel: z.enum(["wechat", "xiaohongshu"]),
    companyName: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(80),
    deck: z.string().trim().min(1).max(240),
    sourceDocuments: z.array(socialSourceSchema).min(1).max(100),
    sections: z.array(socialSectionSchema).min(1).max(20),
    hashtags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  })
  .strict();

export type SocialPackageInput = z.infer<typeof socialPackageInputSchema>;
export type SocialPackageManifest = {
  schemaVersion: 1;
  channel: "wechat" | "xiaohongshu";
  brand: string;
  files: Array<{
    path: string;
    mimeType: string;
    bytes: number;
    sha256: string;
  }>;
};
export type GeneratedSocialPackage = {
  archive: Buffer;
  archiveSha256: string;
  manifest: SocialPackageManifest;
  manifestJson: Buffer;
  manifestSha256: string;
  qa: Record<string, unknown>;
  qaJson: Buffer;
  previews: Array<{
    filename: string;
    mimeType: "image/png";
    buffer: Buffer;
    sha256: string;
  }>;
};

const SOCIAL_PALETTES = [
  ["#10212B", "#F4EDE1", "#EF6C45", "#C7D8D9"],
  ["#171520", "#F5F0E8", "#6B65E8", "#E9BA5B"],
  ["#15332F", "#F3F0E5", "#D8523A", "#9FC5B7"],
] as const;

function brandPalette(companyName: string) {
  const index =
    Number.parseInt(sha256(companyName).slice(0, 2), 16) %
    SOCIAL_PALETTES.length;
  return SOCIAL_PALETTES[index]!;
}

function wrapVisualText(value: string, maxUnits: number, maxLines: number) {
  const characters = [...value.replace(/\s+/gu, " ").trim()];
  const lines: string[] = [];
  let current = "";
  let units = 0;
  const weight = (character: string) =>
    /^[\x00-\xff]$/u.test(character) ? 0.55 : 1;
  for (const character of characters) {
    const next = weight(character);
    if (units + next > maxUnits && current) {
      lines.push(current.trim());
      current = "";
      units = 0;
      if (lines.length >= maxLines) break;
    }
    current += character;
    units += next;
  }
  if (current.trim() && lines.length < maxLines) lines.push(current.trim());
  if (lines.join("").length < characters.join("").length && lines.length > 0) {
    lines[lines.length - 1] =
      `${lines[lines.length - 1]!.replace(/[，。；、,.!?！？\s]+$/u, "")}…`;
  }
  return lines;
}

function svgText(
  lines: string[],
  x: number,
  y: number,
  options: { size: number; fill: string; lineHeight: number; weight?: number },
) {
  return `<text x="${x}" y="${y}" font-family="Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="${options.size}" font-weight="${options.weight ?? 700}" fill="${options.fill}">${lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : options.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("")}</text>`;
}

async function pngFromSvg(svg: string, width: number, height: number) {
  const buffer = await sharp(Buffer.from(svg, "utf8"), {
    limitInputPixels: width * height,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  if (buffer.length < 1 || buffer.length > 8 * 1024 * 1024) {
    throw new Error("SITEOPS_SOCIAL_IMAGE_SIZE_INVALID");
  }
  return buffer;
}

async function wechatCover(input: SocialPackageInput, variant: number) {
  const [ink, canvas, accent, muted] = brandPalette(input.companyName);
  const title = wrapVisualText(input.title, 10.5, 4);
  const company = wrapVisualText(input.companyName, 18, 2);
  const illustration =
    variant === 0
      ? `<circle cx="1000" cy="300" r="178" fill="none" stroke="${accent}" stroke-width="34"/><circle cx="1000" cy="300" r="92" fill="${muted}"/><path d="M790 300h420M1000 90v420" stroke="${ink}" stroke-width="7" stroke-dasharray="14 18"/>`
      : variant === 1
        ? `<path d="M750 190h190v100H750zM970 250h190v100H970zM1190 310h150v100h-150z" fill="none" stroke="${ink}" stroke-width="8"/><path d="M940 240l30 30M1160 300l30 30" stroke="${accent}" stroke-width="18"/><circle cx="790" cy="240" r="18" fill="${accent}"/><circle cx="1235" cy="360" r="18" fill="${muted}"/>`
        : `<circle cx="1045" cy="300" r="74" fill="${accent}"/><circle cx="790" cy="170" r="48" fill="${muted}"/><circle cx="1270" cy="160" r="48" fill="${muted}"/><circle cx="790" cy="445" r="48" fill="${muted}"/><circle cx="1270" cy="445" r="48" fill="${muted}"/><path d="M834 192l144 75M1112 265l114-78M837 421l142-86M1110 336l116 82" stroke="${ink}" stroke-width="8"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1410" height="600" viewBox="0 0 1410 600"><rect width="1410" height="600" fill="${canvas}"/><rect x="600" width="810" height="600" fill="${variant === 1 ? muted : canvas}"/><rect x="46" y="44" width="64" height="8" fill="${accent}"/>${svgText(company, 46, 88, { size: 23, fill: ink, lineHeight: 30, weight: 700 })}${svgText(title, 46, 190, { size: 58, fill: ink, lineHeight: 69, weight: 800 })}<text x="46" y="548" font-family="Arial, 'PingFang SC', sans-serif" font-size="18" fill="${ink}">FrontMind · 企业知识内容</text>${illustration}<path d="M600 0v600" stroke="${ink}" stroke-width="2" opacity=".2"/></svg>`;
  return pngFromSvg(svg, 1410, 600);
}

async function xiaohongshuPage(input: SocialPackageInput, index: number) {
  const [ink, canvas, accent, muted] = brandPalette(input.companyName);
  const cover = index === 0;
  const section = input.sections[Math.max(0, index - 1)]!;
  const heading = cover ? input.title : section.heading;
  const headingLines = wrapVisualText(heading, cover ? 11 : 13, cover ? 4 : 3);
  const body = cover ? input.deck : section.paragraphs.join(" ");
  const bodyLines = wrapVisualText(body, 24, cover ? 5 : 11);
  const motif = index % 3;
  const visual =
    motif === 0
      ? `<circle cx="850" cy="360" r="230" fill="${muted}"/><circle cx="850" cy="360" r="112" fill="${accent}"/><path d="M580 360h540M850 90v540" stroke="${ink}" stroke-width="9" stroke-dasharray="20 22"/>`
      : motif === 1
        ? `<path d="M610 210h330v180H610zM760 430h250v150H760z" fill="none" stroke="${ink}" stroke-width="10"/><rect x="660" y="260" width="330" height="180" fill="${muted}"/><circle cx="1015" cy="220" r="55" fill="${accent}"/>`
        : `<path d="M620 260c110-150 330-150 440 0s-20 330-220 330-330-180-220-330z" fill="${muted}"/><path d="M670 520l340-240" stroke="${accent}" stroke-width="38"/><circle cx="690" cy="500" r="52" fill="${ink}"/><circle cx="990" cy="300" r="52" fill="${ink}"/>`;
  // Evidence coordinates remain in sources.json and the internal QA mapping.
  // Customer-facing social previews carry only the customer's brand.
  const citations = input.companyName;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440"><rect width="1080" height="1440" fill="${canvas}"/><rect x="0" y="0" width="1080" height="26" fill="${accent}"/><text x="70" y="104" font-family="Arial, 'PingFang SC', sans-serif" font-size="26" font-weight="700" fill="${ink}">${escapeXml(input.companyName)}</text><text x="930" y="104" text-anchor="end" font-family="Arial, sans-serif" font-size="24" fill="${ink}">${String(index + 1).padStart(2, "0")} / 09</text>${cover ? visual : ""}${svgText(headingLines, 70, cover ? 760 : 230, { size: cover ? 82 : 68, fill: ink, lineHeight: cover ? 96 : 82, weight: 800 })}${svgText(bodyLines, 70, cover ? 1140 : 540, { size: 31, fill: ink, lineHeight: 49, weight: 500 })}${!cover ? `<g transform="translate(0 720) scale(.65)">${visual}</g>` : ""}<line x1="70" x2="1010" y1="1325" y2="1325" stroke="${ink}" opacity=".25"/><text x="70" y="1372" font-family="Arial, 'PingFang SC', sans-serif" font-size="20" fill="${ink}" opacity=".75">${escapeXml(citations)}</text></svg>`;
  return pngFromSvg(svg, 1080, 1440);
}

function mimeTypeForSocialPath(filePath: string) {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function validateSocialInput(raw: SocialPackageInput | unknown) {
  const input = socialPackageInputSchema.parse(raw);
  if (input.channel === "xiaohongshu" && input.sections.length !== 8) {
    throw new Error("SITEOPS_XIAOHONGSHU_EIGHT_SECTIONS_REQUIRED");
  }
  const sourceIds = new Set(input.sourceDocuments.map((source) => source.id));
  if (
    sourceIds.size !== input.sourceDocuments.length ||
    input.sections.some((section) =>
      section.sourceDocumentIds.some((id) => !sourceIds.has(id)),
    )
  ) {
    throw new Error("SITEOPS_SOCIAL_SOURCE_MAPPING_INVALID");
  }
  assertNoSensitiveText("social-package", canonicalJson(input));
  return input;
}

export async function generateSocialPackage(
  raw: SocialPackageInput | unknown,
): Promise<GeneratedSocialPackage> {
  const input = validateSocialInput(raw);
  const payloadFiles: SourceFile[] = [];
  const previews: GeneratedSocialPackage["previews"] = [];
  const sources = {
    schemaVersion: 1,
    documents: input.sourceDocuments,
    claimMappings: input.sections.map((section, index) => ({
      section: index + 1,
      heading: section.heading,
      sourceDocumentIds: section.sourceDocumentIds,
    })),
  };
  if (input.channel === "wechat") {
    const article = `# ${input.title}\n\n${input.deck}\n\n${input.sections
      .map(
        (section) =>
          `## ${section.heading}\n\n${section.paragraphs.join("\n\n")}`,
      )
      .join("\n\n")}\n\n---\n${input.companyName}\n`;
    addTextFile(payloadFiles, "article.md", article);
    addTextFile(payloadFiles, "title.txt", `${input.title}\n`);
    addTextFile(payloadFiles, "sources.json", jsonBuffer(sources));
    for (let index = 0; index < 3; index += 1) {
      const buffer = await wechatCover(input, index);
      const filename = `covers/${String(index + 1).padStart(2, "0")}.png`;
      addTextFile(payloadFiles, filename, buffer);
      previews.push({
        filename,
        mimeType: "image/png",
        buffer,
        sha256: sha256(buffer),
      });
    }
  } else {
    for (let index = 0; index < 9; index += 1) {
      const buffer = await xiaohongshuPage(input, index);
      const suffix =
        index === 0 ? "cover" : `section-${String(index).padStart(2, "0")}`;
      const filename = `images/${String(index + 1).padStart(2, "0")}-${suffix}.png`;
      addTextFile(payloadFiles, filename, buffer);
      previews.push({
        filename,
        mimeType: "image/png",
        buffer,
        sha256: sha256(buffer),
      });
    }
    const postCopy = `${input.title}\n\n${input.deck}\n\n${input.sections.map((section) => `• ${section.heading}`).join("\n")}\n\n${input.hashtags.map((tag) => `#${tag.replace(/^#/u, "")}`).join(" ")}\n\n${input.companyName}\n`;
    addTextFile(payloadFiles, "post-copy.md", postCopy);
    addTextFile(payloadFiles, "sources.json", jsonBuffer(sources));
  }
  const expectedPayloadCount = input.channel === "wechat" ? 6 : 11;
  if (payloadFiles.length !== expectedPayloadCount) {
    throw new Error("SITEOPS_SOCIAL_PAYLOAD_STRUCTURE_INVALID");
  }
  const qa = {
    schemaVersion: 1,
    passed: true,
    channel: input.channel,
    brand: input.companyName,
    sourceMappingsComplete: true,
    automatedPublishing: false,
    credentialsIncluded: false,
    imageCount: previews.length,
    imageDimensions:
      input.channel === "wechat"
        ? { width: 1410, height: 600 }
        : { width: 1080, height: 1440 },
  };
  const qaJson = jsonBuffer(qa);
  addTextFile(payloadFiles, "qa-report.json", qaJson);
  const manifest: SocialPackageManifest = {
    schemaVersion: 1,
    channel: input.channel,
    brand: input.companyName,
    files: payloadFiles
      .map((file) => ({
        path: file.path,
        mimeType: mimeTypeForSocialPath(file.path),
        bytes: file.bytes.length,
        sha256: sha256(file.bytes),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const manifestJson = jsonBuffer(manifest);
  const archiveFiles = [...payloadFiles];
  addTextFile(archiveFiles, "manifest.json", manifestJson);
  archiveFiles.sort((left, right) => left.path.localeCompare(right.path));
  const archive = await deterministicZip(archiveFiles, MAX_DIST_BYTES);
  return {
    archive,
    archiveSha256: sha256(archive),
    manifest,
    manifestJson,
    manifestSha256: sha256(manifestJson),
    qa,
    qaJson,
    previews,
  };
}
