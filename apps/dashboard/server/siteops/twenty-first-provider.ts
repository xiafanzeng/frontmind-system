import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import { and, eq, inArray, max } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import {
  knowledgeBaseSnapshots,
  messages,
  siteOperations,
  siteProjects,
  visualCandidatePoolItems,
  visualCandidatePoolPages,
  visualCandidatePools,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  type KnowledgeBaseSnapshot,
  type SiteOperation,
  type SiteProject,
} from "../../drizzle/schema";
import {
  canonicalJson,
  canonicalSha256,
  buildTwentyFirstSearchOnlyFunnel,
  createVisualEvidenceV1,
  normalizeTwentyFirstSearchResults,
  visualSearchOperationInputSchema,
  VISUAL_EVIDENCE_KIND,
  VISUAL_TAXONOMY_DERIVATION_VERSION,
  type NormalizedTwentyFirstCandidate,
  type SafeVisualDirective,
  type TwentyFirstQueryAxis,
  type TwentyFirstQueryRole,
  type TwentyFirstSearchEnvelope,
  type VisualSearchOperationInput,
} from "../../shared/siteops-workflow";
import {
  siteBriefSchema,
  SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
  SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL,
  SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
  visualSelectionBundleV4Schema,
  visualSelectionBundleV5Schema,
  visualSelectionBundleV6Schema,
  visualSelectionBundleV7Schema,
  type SiteBrief,
  type SiteOpsNativeTemplateFailureCategory,
  type VisualSelectionBundleV4,
  type VisualSelectionBundleV5,
  type VisualSelectionBundleV6,
  type VisualSelectionBundleV7,
} from "../../shared/siteops";
import {
  FRONTMIND_VISUAL_FAMILIES_V3,
  FRONTMIND_VISUAL_FAMILY_LABELS_V3,
  assertVisualBlueprintDiversityV4,
  referenceBlueprintV4ForFamily,
  trustedVisualPreviewBlueprintV4,
  type ReferenceBlueprintV4,
} from "../../shared/siteops-design";
import { AuthServiceError } from "../auth-service";
import { getDb } from "../db";
import {
  TwentyFirstClient,
  TwentyFirstNativeTemplateError,
  TwentyFirstToolContractError,
  getTwentyFirstCredentialById,
  type TwentyFirstNativeTemplateSummary,
  type TwentyFirstReadOnlySession,
} from "../twenty-first-service";
import { persistSiteOpsArtifact, readSiteOpsArtifact } from "./artifact-store";
import {
  SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION,
  SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION,
  SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION,
  isSiteOpsNativeVisualWorkflowVersion,
  VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES,
  VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE,
  VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES,
  VISUAL_SELECTION_BUNDLE_V6_MIME_TYPE,
  VISUAL_SELECTION_BUNDLE_V7_MAX_BYTES,
  VISUAL_SELECTION_BUNDLE_V7_MIME_TYPE,
  assertTwentyFirstNativeSourcePayloadAvailable,
  createVisualSelectionBundleV5Artifact,
  createVisualSelectionBundleV6Artifact,
  createVisualSelectionBundleV7Artifact,
  classifyNativeTemplateRuntimeFailure,
  classifyNativeVisualFailure,
  prepareLegacyNativeTemplateCandidate,
  prepareNativeTemplateCandidate,
  prepareNativeVisualCandidate,
  readVisualSelectionBundleArtifact,
  type NativeTemplateRuntimeFailureCategory,
  type NativeVisualFailureCategory,
  type PreparedNativeTemplateCandidate,
  type PreparedNativeVisualCandidate,
} from "./native-visual-source";

const isStaticCatalogWorkflowVersion = (version: string) =>
  version === SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION ||
  version === SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION;
import {
  STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
  StaticTemplateCatalogError,
  readStaticTemplateCatalogVersionPreview,
  requireStaticTemplateCatalogVersion,
  type StaticTemplateCatalog,
} from "./static-template-catalog";
import { registerSiteOpsProviderHandler } from "./providers";
import { fetchSafeVisualPreview } from "./remote-preview";
import { renderTrustedVisualCandidatePreviews } from "./react-static-runtime";
import type {
  SiteOpsProviderHandler,
  SiteOpsProviderResult,
} from "./providers";

const OPERATION_MARKER_PREFIX = "siteops-21st-operation:";
const SENSITIVE_SEARCH_CONTEXT =
  /(?:21st_sk_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

type ExistingBoard = {
  batchId: string;
  batchIds?: string[];
  pageCount?: number;
  candidateCount: number;
  selectionBundleHash: string | null;
};

export type TwentyFirstProviderContext = {
  project: SiteProject;
  snapshot: KnowledgeBaseSnapshot;
  brief: SiteBrief;
  existingBoard: ExistingBoard | null;
  /** Complete published pages observed while the operation context is loaded. */
  publishedPageCount?: number;
  previousReferences?: {
    providerItemKeys: string[];
    previewSha256s: string[];
    perceptualHashes: string[];
    sourceTreeSha256s?: string[];
    nativePreviewSha256s?: string[];
    providerTemplateIds?: string[];
    providerTemplateSlugs?: string[];
  };
};

type PreviewArtifact = {
  id: string;
  contentSha256: string;
};

type MirroredReference = {
  sampleId: string;
  candidate: NormalizedTwentyFirstCandidate;
  taxonomy: ReturnType<typeof taxonomyFromDirectives>;
  previewLocalAssetId: string;
  previewSha256: string;
  perceptualHash: string;
  visualEvidence: ReturnType<typeof createVisualEvidenceV1>;
};

type FrontMindBoardCandidate = {
  sampleId: string;
  optionLabel: string;
  queryAxis: "foundation_split" | "foundation_editorial_modular";
  providerItemKey: string;
  title: string;
  description: string | null;
  taxonomy: ReturnType<typeof taxonomyFromDirectives>;
  author: string | null;
  sourceUrl: string | null;
  previewLocalAssetId: string;
  previewSha256: string;
  realizationPreviewLocalAssetId: string;
  realizationPreviewSha256: string;
  referencePerceptualHash: string;
  realizationPerceptualHash: string;
  visualEvidence: ReturnType<typeof createVisualEvidenceV1>;
  referenceBlueprint: ReferenceBlueprintV4;
  score: number;
  rationale: string;
};

type NativeBoardCandidate = {
  sampleId: string;
  optionLabel: string;
  queryAxis: "foundation_split" | "foundation_editorial_modular";
  providerItemId: string;
  providerItemKey: string;
  providerVersion: string | null;
  title: string;
  description: string | null;
  taxonomy: ReturnType<typeof taxonomyFromDirectives>;
  author: string | null;
  sourceUrl: string | null;
  referencePreviewLocalAssetId: string;
  referencePreviewSha256: string;
  referencePerceptualHash: string;
  previewLocalAssetId: string;
  previewSha256: string;
  visualEvidence: ReturnType<typeof createVisualEvidenceV1>;
  sourceTreeSha256: string;
  sourceArchiveSha256: string;
  sourceArchive: Buffer;
  entrypoint: string;
  demoEntrypoint: string;
  score: number;
  rationale: string;
};

type NativeTemplateBoardCandidate = {
  sampleId: string;
  optionLabel: string;
  providerTemplateId: string;
  providerSlug: string;
  providerVersion: string | null;
  providerItemKey: string;
  title: string;
  description: string | null;
  author: string | null;
  previewLocalAssetId: string;
  previewSha256: string;
  previewPerceptualHash: string;
  /** Historical V6 pages predate host-derived style tokens. */
  styleTokens?: PreparedNativeTemplateCandidate["styleTokens"];
  sourceFormat: PreparedNativeTemplateCandidate["sourceFormat"];
  framework: PreparedNativeTemplateCandidate["framework"];
  sourceTreeSha256: string;
  sourceArchiveSha256: string;
  sourceArchive: Buffer;
  sourceDirectory: string;
  entrypoint: string;
};

type StaticTemplateBoardCandidate = {
  sampleId: string;
  optionLabel: string;
  catalogVersion: string;
  catalogPosition: number;
  catalogCandidateId: string;
  providerTemplateId: string;
  providerSlug: string;
  providerVersion: string | null;
  providerItemKey: string;
  title: string;
  description: string | null;
  sourceOwner: string;
  sourceRepo: string;
  sourceCommitSha: string;
  sourceSubdirectory: string | null;
  sourceLicense: "MIT" | "Apache-2.0";
  sourceAssetId: string;
  sourceArchiveSha256: string;
  sourceArchiveBytes: number;
  previewAssetId: string;
  previewLocalAssetId: string;
  previewSha256: string;
  previewMimeType: "image/avif" | "image/jpeg" | "image/png" | "image/webp";
  previewWidth: number;
  previewHeight: number;
  executionAdmission: VisualSelectionBundleV7["candidates"][number]["executionAdmission"];
};

type BoardCandidate =
  | FrontMindBoardCandidate
  | NativeBoardCandidate
  | NativeTemplateBoardCandidate;

export type ResolvedVisualSearchPlan = {
  schemaVersion: 1 | 2;
  mode: "initial" | "supplemental";
  page: 1 | 2 | 3;
  admissionRevision: number;
};

type PreviewRejectionReason =
  | "url"
  | "dns"
  | "connect"
  | "redirect"
  | "http"
  | "mime"
  | "size"
  | "decode"
  | "duplicate"
  | "persist"
  | "hash"
  | "source"
  | "aborted";

export type VisualSearchDiagnostics = {
  diagnosticsVersion: 2;
  searchedByAxis: Record<TwentyFirstQueryAxis, number>;
  normalizedUnique: number;
  shortlistCount: number;
  withPreviewReference: number;
  mirrorAttempted: number;
  mirrorSucceeded: number;
  rejectedByReason: Partial<Record<PreviewRejectionReason, number>>;
  /** Safe aggregate graph diagnostics. Family names, queries and URLs are
   * deliberately absent so this object can be returned and logged. */
  eligibilityEdgeCount: number;
  exactEligibilityEdgeCount: number;
  safeFallbackEdgeCount: number;
  keyMatchingCardinality: number;
  compatibleMatchingCardinality: number;
  deficientFamilyCount: number;
  queryCalls: number;
  maximumQueryLimit: number;
  effectiveSearchLimit: number;
  generalHeroEligibleCount: number;
  exactEligibilityEdges: number;
  safeFallbackEdges: number;
  mirrorAttempts: number;
  previewFetchAttempts: number;
  sourceFetchAttempts: number;
  sourceFetchSucceeded: number;
  sourcePreparationAttempts: number;
  sourcePrepared: number;
  sourceRejectedByReason: Partial<Record<NativeVisualFailureCategory, number>>;
  nativeFailureCategory: NativeVisualFailureCategory | null;
  templateMode: boolean;
  catalogCandidates: number;
  templateDownloadAttempts: number;
  templateDownloadsSucceeded: number;
  dependencyResolutionAttempts: number;
  compileAttempts: number;
  compileSucceeded: number;
  renderAttempts: number;
  renderSucceeded: number;
  capacityCandidates: number;
  capacityRequired: number;
  targetRequired: number;
  minimumRequired: number;
  downloaded: number;
  normalized: number;
  compiled: number;
  rendered: number;
  sourceUnsafe: number;
  dependencyUnsupported: number;
  capacityPages: number;
  capacitySelected: number;
  capacityRejectedOversize: number;
  capacitySolverNodes: number;
  capacitySolverExhausted: boolean;
  publishedCount: number;
  templateRejectedByReason: Partial<
    Record<SiteOpsNativeTemplateFailureCategory, number>
  >;
  templateFailureCategory: SiteOpsNativeTemplateFailureCategory | null;
  terminalReason:
    | "complete"
    | "catalog_insufficient"
    | "matching_budget_exhausted"
    | "preview_failures"
    | "source_failures"
    | "deadline_exhausted"
    | null;
  diversity: SafeVisualDiversitySummary;
};

export type SafeVisualDiversitySummary = {
  summaryVersion: 1;
  requestedFamilies: 9;
  familyQueriesRun: number;
  eligibleReferences: number;
  mirroredReferences: number;
  assignedFamilies: number;
  distinctProviderItems: number;
  distinctReferenceHashes: number;
  distinctReferencePerceptualHashes: number;
  distinctRealizationHashes: number;
  distinctRealizationPerceptualHashes: number;
  distinctStyleSignatures: number;
  paletteVariants: number;
  backgroundVariants: number;
  typographyVariants: number;
  compositionVariants: number;
  minimumReferenceHammingDistance: number | null;
  minimumRealizationHammingDistance: number | null;
};

export type TwentyFirstBoardPersistenceInput = {
  operation: SiteOperation;
  searchPlan: ResolvedVisualSearchPlan;
  context: TwentyFirstProviderContext;
  selectionBundle:
    | VisualSelectionBundleV4
    | VisualSelectionBundleV5
    | VisualSelectionBundleV6;
  selectionBundleArtifact: PreviewArtifact;
  mirroredCandidates: BoardCandidate[];
  candidatePoolPage?: {
    poolId: string;
    pageNumber: 1 | 2 | 3;
  };
};

export type StaticTemplateCatalogPagePersistenceInput = {
  pageNumber: 1 | 2 | 3 | 4;
  selectionBundle: VisualSelectionBundleV7;
  selectionBundleArtifact: PreviewArtifact;
  candidates: StaticTemplateBoardCandidate[];
};

export type StaticTemplateCatalogBoardsPersistenceInput = {
  operation: SiteOperation;
  searchPlan: ResolvedVisualSearchPlan;
  context: TwentyFirstProviderContext;
  catalogVersion: string;
  pages: StaticTemplateCatalogPagePersistenceInput[];
};

export type StaticTemplateCatalogBoardsPersistenceResult = {
  batchIds: string[];
  candidateCount: number;
};

export type NativeTemplatePoolPagePersistence = {
  id: string;
  pageNumber: 1 | 2 | 3;
  selectionBundleArtifact: PreviewArtifact;
  selectionBundleSizeBytes: number;
  items: Array<{
    id: string;
    sampleId: string;
    position: number;
    previewLocalAssetId: string;
    previewSha256: string;
    sourceTreeSha256: string;
    providerTemplateId: string;
    providerSlug: string;
    providerVersion: string | null;
    providerItemKey: string;
  }>;
};

export type NativeTemplatePoolPersistenceInput = {
  poolId: string;
  generationKey: string;
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  credentialId: string;
  credentialVersion: number;
  seed: string;
  catalogFingerprint: string;
  queryPlanHash: string;
  manifestArtifact: PreviewArtifact;
  pages: NativeTemplatePoolPagePersistence[];
};

export type NativeTemplatePoolState = {
  poolId: string;
  pageCount: number;
  availablePages: number;
  reservedPages: number;
  page: null | {
    pageNumber: 1 | 2 | 3;
    selectionBundleLocalAssetId: string;
    selectionBundleHash: string;
    items: NativeTemplatePoolPagePersistence["items"];
  };
};

export type TwentyFirstProviderDependencies = {
  getDb?: () => Promise<any>;
  loadContext?: (
    db: any,
    operation: SiteOperation,
  ) => Promise<TwentyFirstProviderContext>;
  getCredential?: typeof getTwentyFirstCredentialById;
  client?: Pick<TwentyFirstClient, "withReadOnlySession"> &
    Partial<
      Pick<TwentyFirstClient, "listNativeTemplates" | "downloadNativeTemplate">
    >;
  fetchPreview?: typeof fetchSafeVisualPreview;
  renderCandidates?: typeof renderTrustedVisualCandidatePreviews;
  prepareNativeCandidate?: typeof prepareNativeVisualCandidate;
  prepareNativeTemplateCandidate?: typeof prepareNativeTemplateCandidate;
  resolveNativeTemplateShuffleKey?: () => Buffer;
  persistArtifact?: typeof persistSiteOpsArtifact;
  persistBoard?: (
    db: any,
    input: TwentyFirstBoardPersistenceInput,
  ) => Promise<ExistingBoard>;
  loadStaticTemplateCatalog?: (
    catalogVersion: string,
  ) => Promise<StaticTemplateCatalog>;
  readStaticTemplateCatalogPreview?: typeof readStaticTemplateCatalogVersionPreview;
  persistStaticTemplateCatalogBoards?: (
    db: any,
    input: StaticTemplateCatalogBoardsPersistenceInput,
  ) => Promise<StaticTemplateCatalogBoardsPersistenceResult>;
  loadNativeTemplatePoolState?: (input: {
    db: any;
    operation: SiteOperation;
    context: TwentyFirstProviderContext;
    credentialId: string;
    credentialVersion: number;
    workflowVersion: string;
    page: 1 | 2 | 3;
  }) => Promise<NativeTemplatePoolState | null>;
  persistNativeTemplatePool?: (
    db: any,
    input: NativeTemplatePoolPersistenceInput,
  ) => Promise<{ poolId: string; created: boolean }>;
  readArtifact?: typeof readSiteOpsArtifact;
};

class TwentyFirstProviderFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: "failed" | "attention_required" = "failed",
    public readonly diagnosticCause?: unknown,
  ) {
    super(message);
    this.name = "TwentyFirstProviderFailure";
  }
}

type VisualSearchStage =
  | "validate_operation"
  | "load_context"
  | "load_credential"
  | "mcp_retrieval"
  | "mirror_previews"
  | "retrieve_native_sources"
  | "render_native_previews"
  | "render_host_previews"
  | "persist_selection_bundle"
  | "persist_board";

type SafeVisualStructuredStage =
  | "visual_query_capability"
  | "visual_matching"
  | "visual_mirror"
  | "visual_page_published";

/**
 * Deliberately closed structured log contract. Callers can report only
 * internal coordinates, opaque variant identifiers, numeric aggregates and
 * the safe terminal classification. Provider queries, family names, URLs,
 * customer prose and credentials cannot enter this helper.
 */
function logSafeVisualStage(input: {
  event: SafeVisualStructuredStage;
  operationId: string;
  projectId: string;
  page: 1 | 2 | 3;
  latencyMs: number;
  variantId?: string;
  actualLimit?: number;
  queryCalls?: number;
  normalizedUnique?: number;
  eligibilityEdges?: number;
  keyMatchingCardinality?: number;
  compatibleMatchingCardinality?: number;
  mirrorAttempts?: number;
  mirrorSucceeded?: number;
  sourceAttempts?: number;
  sourceSucceeded?: number;
  nativeFailureCategory?: NativeVisualFailureCategory | null;
  rejectedPreviews?: number;
  candidateCount?: number;
  terminalReason?: VisualSearchDiagnostics["terminalReason"];
}) {
  console.info("[SiteOps21st] visual_stage", {
    event: input.event,
    operationId: input.operationId,
    projectId: input.projectId,
    page: input.page,
    latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
    ...(input.variantId ? { variantId: input.variantId } : {}),
    ...(input.actualLimit === undefined
      ? {}
      : { actualLimit: input.actualLimit }),
    ...(input.queryCalls === undefined ? {} : { queryCalls: input.queryCalls }),
    ...(input.normalizedUnique === undefined
      ? {}
      : { normalizedUnique: input.normalizedUnique }),
    ...(input.eligibilityEdges === undefined
      ? {}
      : { eligibilityEdges: input.eligibilityEdges }),
    ...(input.keyMatchingCardinality === undefined
      ? {}
      : { keyMatchingCardinality: input.keyMatchingCardinality }),
    ...(input.compatibleMatchingCardinality === undefined
      ? {}
      : {
          compatibleMatchingCardinality: input.compatibleMatchingCardinality,
        }),
    ...(input.mirrorAttempts === undefined
      ? {}
      : { mirrorAttempts: input.mirrorAttempts }),
    ...(input.mirrorSucceeded === undefined
      ? {}
      : { mirrorSucceeded: input.mirrorSucceeded }),
    ...(input.sourceAttempts === undefined
      ? {}
      : { sourceAttempts: input.sourceAttempts }),
    ...(input.sourceSucceeded === undefined
      ? {}
      : { sourceSucceeded: input.sourceSucceeded }),
    ...(input.nativeFailureCategory === undefined
      ? {}
      : { nativeFailureCategory: input.nativeFailureCategory }),
    ...(input.rejectedPreviews === undefined
      ? {}
      : { rejectedPreviews: input.rejectedPreviews }),
    ...(input.candidateCount === undefined
      ? {}
      : { candidateCount: input.candidateCount }),
    ...(input.terminalReason === undefined
      ? {}
      : { terminalReason: input.terminalReason }),
  });
}

function createVisualSearchDiagnostics(): VisualSearchDiagnostics {
  return {
    diagnosticsVersion: 2,
    searchedByAxis: {
      foundation_split: 0,
      foundation_editorial_modular: 0,
      section_proof_conversion: 0,
      motion_accessible: 0,
    },
    normalizedUnique: 0,
    shortlistCount: 0,
    withPreviewReference: 0,
    mirrorAttempted: 0,
    mirrorSucceeded: 0,
    rejectedByReason: {},
    eligibilityEdgeCount: 0,
    exactEligibilityEdgeCount: 0,
    safeFallbackEdgeCount: 0,
    keyMatchingCardinality: 0,
    compatibleMatchingCardinality: 0,
    deficientFamilyCount: FRONTMIND_VISUAL_FAMILIES_V3.length,
    queryCalls: 0,
    maximumQueryLimit: 0,
    effectiveSearchLimit: 0,
    generalHeroEligibleCount: 0,
    exactEligibilityEdges: 0,
    safeFallbackEdges: 0,
    mirrorAttempts: 0,
    previewFetchAttempts: 0,
    sourceFetchAttempts: 0,
    sourceFetchSucceeded: 0,
    sourcePreparationAttempts: 0,
    sourcePrepared: 0,
    sourceRejectedByReason: {},
    nativeFailureCategory: null,
    templateMode: false,
    catalogCandidates: 0,
    templateDownloadAttempts: 0,
    templateDownloadsSucceeded: 0,
    dependencyResolutionAttempts: 0,
    compileAttempts: 0,
    compileSucceeded: 0,
    renderAttempts: 0,
    renderSucceeded: 0,
    capacityCandidates: 0,
    capacityRequired: 0,
    targetRequired: 27,
    minimumRequired: 9,
    downloaded: 0,
    normalized: 0,
    compiled: 0,
    rendered: 0,
    sourceUnsafe: 0,
    dependencyUnsupported: 0,
    capacityPages: 0,
    capacitySelected: 0,
    capacityRejectedOversize: 0,
    capacitySolverNodes: 0,
    capacitySolverExhausted: false,
    publishedCount: 0,
    templateRejectedByReason: {},
    templateFailureCategory: null,
    terminalReason: null,
    diversity: {
      summaryVersion: 1,
      requestedFamilies: 9,
      familyQueriesRun: 0,
      eligibleReferences: 0,
      mirroredReferences: 0,
      assignedFamilies: 0,
      distinctProviderItems: 0,
      distinctReferenceHashes: 0,
      distinctReferencePerceptualHashes: 0,
      distinctRealizationHashes: 0,
      distinctRealizationPerceptualHashes: 0,
      distinctStyleSignatures: 0,
      paletteVariants: 0,
      backgroundVariants: 0,
      typographyVariants: 0,
      compositionVariants: 0,
      minimumReferenceHammingDistance: null,
      minimumRealizationHammingDistance: null,
    },
  };
}

function rejectDiagnostic(
  diagnostics: VisualSearchDiagnostics,
  reason: PreviewRejectionReason,
) {
  diagnostics.rejectedByReason[reason] =
    (diagnostics.rejectedByReason[reason] ?? 0) + 1;
}

const NATIVE_FAILURE_PRIORITY: readonly NativeVisualFailureCategory[] = [
  "provider_quota",
  "get_component_contract",
  "deadline_exhausted",
  "browser_unavailable",
  "dependency_unsupported",
  "source_unsafe",
  "source_incomplete",
  "compile_failed",
  "render_failed",
];

function rejectNativeSource(
  diagnostics: VisualSearchDiagnostics,
  category: NativeVisualFailureCategory,
) {
  diagnostics.sourceRejectedByReason[category] =
    (diagnostics.sourceRejectedByReason[category] ?? 0) + 1;
  diagnostics.nativeFailureCategory =
    NATIVE_FAILURE_PRIORITY.find(
      (candidate) => (diagnostics.sourceRejectedByReason[candidate] ?? 0) > 0,
    ) ?? category;
  // Preserve the V2 aggregate field for old readers while new code uses the
  // source-specific counters above.
  rejectDiagnostic(diagnostics, "source");
}

function abortLike(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? String(error.code) : "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT"
  );
}

function getComponentFailureCategory(
  error: unknown,
): NativeVisualFailureCategory {
  if (abortLike(error)) return "deadline_exhausted";
  const nativeCode =
    error && typeof error === "object" && "nativeCode" in error
      ? String(error.nativeCode)
      : "";
  const nativeCodeCategory: Partial<
    Record<string, NativeVisualFailureCategory>
  > = {
    NATIVE_SOURCE_QUOTA_UNAVAILABLE: "provider_quota",
    NATIVE_SOURCE_CONTRACT_UNAVAILABLE: "get_component_contract",
    NATIVE_SOURCE_CANDIDATES_UNAVAILABLE: "source_incomplete",
  };
  if (nativeCodeCategory[nativeCode]) {
    return nativeCodeCategory[nativeCode]!;
  }
  if (
    ["provider_quota", "get_component_contract", "source_incomplete"].includes(
      nativeCode,
    )
  ) {
    return nativeCode as NativeVisualFailureCategory;
  }
  if (error instanceof TwentyFirstToolContractError) {
    return "get_component_contract";
  }
  if (error instanceof AuthServiceError) {
    return "get_component_contract";
  }
  return classifyNativeVisualFailure(error);
}

const NATIVE_SOURCE_FAILURE_CONTRACT = {
  provider_quota: {
    code: "NATIVE_SOURCE_QUOTA_UNAVAILABLE",
    message:
      "21st 原生源码读取额度当前不可用，请更新 FrontMind 目录连接后重试。",
  },
  get_component_contract: {
    code: "NATIVE_SOURCE_CONTRACT_UNAVAILABLE",
    message: "21st 原生源码读取合同当前不兼容，请稍后重试。",
  },
  source_incomplete: {
    code: "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE",
    message: "本次未能凑齐 9 个可安全编译的完整 React 源码候选，请稍后重试。",
  },
  dependency_unsupported: {
    code: "NATIVE_SOURCE_DEPENDENCIES_UNAVAILABLE",
    message: "本次候选的原生源码依赖未能安全解析，请稍后重试。",
  },
  source_unsafe: {
    code: "NATIVE_SOURCE_UNSAFE",
    message: "本次候选源码未通过硬安全检查，已安全丢弃；可重新生成视觉候选。",
  },
  compile_failed: {
    code: "NATIVE_SOURCE_COMPILE_UNAVAILABLE",
    message: "本次候选的原生 React 源码未能完成编译，请稍后重试。",
  },
  browser_unavailable: {
    code: "NATIVE_SOURCE_BROWSER_UNAVAILABLE",
    message: "原生 React 预览浏览器当前不可用，请稍后重试。",
  },
  render_failed: {
    code: "NATIVE_SOURCE_RENDER_UNAVAILABLE",
    message: "本次候选的原生 React 预览未能安全渲染，请稍后重试。",
  },
  deadline_exhausted: {
    code: "VISUAL_SEARCH_DEADLINE_EXHAUSTED",
    message: "本次原生视觉候选处理已达到时间上限，请稍后重试。",
  },
} as const satisfies Record<
  NativeVisualFailureCategory,
  { code: string; message: string }
>;

export function nativeSourceProviderErrorCode(
  category: NativeVisualFailureCategory,
) {
  return NATIVE_SOURCE_FAILURE_CONTRACT[category].code;
}

function nativeSourceProviderFailure(category: NativeVisualFailureCategory) {
  const contract = NATIVE_SOURCE_FAILURE_CONTRACT[category];
  return new TwentyFirstProviderFailure(
    contract.code,
    contract.message,
    "attention_required",
  );
}

const NATIVE_TEMPLATE_FAILURE_CONTRACT = {
  catalog_unavailable: {
    code: "NATIVE_TEMPLATE_CATALOG_UNAVAILABLE",
    message: "21st 完整 Template 目录暂不可用，请稍后重试。",
  },
  entitlement_required: {
    code: "NATIVE_TEMPLATE_ENTITLEMENT_REQUIRED",
    message:
      "当前 21st 账号缺少完整 Template 下载权限，请由 FrontMind 管理员更新。",
  },
  download_failed: {
    code: "NATIVE_TEMPLATE_DOWNLOAD_UNAVAILABLE",
    message: "21st 完整 Template 下载暂不可用，请稍后重试。",
  },
  dependency_unsupported: {
    code: "NATIVE_TEMPLATE_DEPENDENCIES_UNAVAILABLE",
    message: "本次完整 Template 使用了当前环境不支持的依赖，请稍后重试。",
  },
  source_unsafe: {
    code: "NATIVE_TEMPLATE_SOURCE_UNSAFE",
    message: "完整 Template 源码未通过硬安全检查，已安全丢弃。",
  },
  compile_failed: {
    code: "NATIVE_TEMPLATE_COMPILE_UNAVAILABLE",
    message: "本次完整 Template 未能完成本地编译，请稍后重试。",
  },
  browser_unavailable: {
    code: "NATIVE_TEMPLATE_BROWSER_UNAVAILABLE",
    message: "完整 Template 预览浏览器当前不可用，请稍后重试。",
  },
  render_failed: {
    code: "NATIVE_TEMPLATE_RENDER_UNAVAILABLE",
    message: "完整 Template 预览暂未能安全生成，请稍后重试。",
  },
  deadline_exhausted: {
    code: "VISUAL_SEARCH_DEADLINE_EXHAUSTED",
    message: "本次完整 Template 候选处理已达到时间上限，请稍后重试。",
  },
  insufficient_live_templates: {
    code: "NATIVE_TEMPLATE_BUILD_POOL_INSUFFICIENT",
    message:
      "本次实时目录的兼容候选少于 9 个，重复重试不会改变结果；请申请重置后使用固定 Template 目录。",
  },
} as const satisfies Record<
  SiteOpsNativeTemplateFailureCategory,
  { code: string; message: string }
>;

export function nativeTemplateProviderErrorCode(
  category: SiteOpsNativeTemplateFailureCategory,
) {
  return NATIVE_TEMPLATE_FAILURE_CONTRACT[category].code;
}

function nativeTemplateProviderFailure(
  category: SiteOpsNativeTemplateFailureCategory,
) {
  const contract = NATIVE_TEMPLATE_FAILURE_CONTRACT[category];
  return new TwentyFirstProviderFailure(
    contract.code,
    contract.message,
    "attention_required",
  );
}

function rejectNativeTemplate(
  diagnostics: VisualSearchDiagnostics,
  category: SiteOpsNativeTemplateFailureCategory,
) {
  diagnostics.templateRejectedByReason[category] =
    (diagnostics.templateRejectedByReason[category] ?? 0) + 1;
  diagnostics.templateFailureCategory = category;
}

function publicTemplateRuntimeCategory(
  category: NativeTemplateRuntimeFailureCategory,
): SiteOpsNativeTemplateFailureCategory {
  switch (category) {
    case "download_failed":
      return "download_failed";
    case "dependency_unsupported":
      return "dependency_unsupported";
    case "source_unsafe":
      return "source_unsafe";
    case "compile_failed":
      return "compile_failed";
    case "browser_unavailable":
      return "browser_unavailable";
    case "render_failed":
      return "render_failed";
    case "deadline_exhausted":
      return "deadline_exhausted";
  }
}

function cleanText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function documentId(document: KnowledgeBaseSnapshot["documents"][number]) {
  return cleanText(document.id ?? document.path, "knowledge-document", 191);
}

/**
 * Uses only snapshot metadata and verified document titles when the stored
 * brief is not yet complete. It deliberately leaves facts/contacts empty.
 */
export function resolveSiteBrief(
  project: SiteProject,
  snapshot: KnowledgeBaseSnapshot,
): SiteBrief {
  const parsed = siteBriefSchema.safeParse(project.brief);
  if (parsed.success) return parsed.data;
  const visibleDocuments = snapshot.documents.filter(
    (document) =>
      document.customerVisible !== false && document.kind !== "evidence",
  );
  const lead =
    visibleDocuments.find((document) => document.kind === "overview") ??
    visibleDocuments[0];
  const sourceName = snapshot.sourceFileName.replace(/\.(?:zip|json)$/iu, "");
  const companyName = cleanText(lead?.title, sourceName || "企业官网", 255);
  const offeringTitles = Array.from(
    new Set(
      visibleDocuments
        .slice(0, 12)
        .map((document) => cleanText(document.title, "", 500))
        .filter(Boolean),
    ),
  );
  const routeSourceIds = visibleDocuments.slice(0, 30).map(documentId);
  return siteBriefSchema.parse({
    companyName,
    primaryLanguage: project.primaryLanguage || "zh-CN",
    contacts: [],
    offerings: offeringTitles,
    audience: [],
    conversionGoal: "了解企业信息并联系咨询",
    routes: [
      {
        id: "home",
        slug: "/",
        title: "首页",
        sourceDocumentIds: routeSourceIds,
      },
    ],
    verifiedFacts: [],
    publicAssetIds: [],
    unknowns: ["目标受众和具体转化目标仍需客户确认"],
  });
}

function operationMarker(operationId: string) {
  return `${OPERATION_MARKER_PREFIX}${operationId}`;
}

function visualSearchSuperseded() {
  return new TwentyFirstProviderFailure(
    "VISUAL_SEARCH_SUPERSEDED",
    "本次视觉候选生成已被更新的流程替代。",
    "failed",
  );
}

export function resolveVisualSearchPlan(
  input: VisualSearchOperationInput,
  context: TwentyFirstProviderContext,
): ResolvedVisualSearchPlan {
  if ("schemaVersion" in input) {
    if (
      context.project.revision !== input.admissionRevision ||
      (context.publishedPageCount !== undefined &&
        context.publishedPageCount !== input.page - 1)
    ) {
      throw visualSearchSuperseded();
    }
    return {
      schemaVersion: 2,
      mode: input.mode,
      page: input.page,
      admissionRevision: input.admissionRevision,
    };
  }

  // Immutable V1 tasks did not freeze page coordinates. Default contexts can
  // recover them from already published complete pages; injected legacy test
  // contexts fall back to the durable reference count.
  const publishedPages =
    context.publishedPageCount ??
    Math.floor(
      (context.previousReferences?.providerItemKeys.length ?? 0) /
        SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
    );
  if (publishedPages >= SITEOPS_VISUAL_CANDIDATE_MAX_PAGES) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_PAGE_LIMIT_REACHED",
      "本轮已生成全部 27 个视觉候选，请直接选择视觉方向。",
      "attention_required",
    );
  }
  const page = (publishedPages + 1) as 1 | 2 | 3;
  return {
    schemaVersion: 1,
    mode: page === 1 ? "initial" : "supplemental",
    page,
    // V1 did not persist an admission revision. Freeze the revision observed
    // for this invocation so a historical lease cannot overwrite a project
    // that advances while provider work is in flight.
    admissionRevision: context.project.revision,
  };
}

async function loadDefaultContext(
  db: any,
  operation: SiteOperation,
): Promise<TwentyFirstProviderContext> {
  if (operation.kind !== "visual_search" || operation.provider !== "21st") {
    throw new TwentyFirstProviderFailure(
      "INVALID_OPERATION",
      "该操作不是有效的 FrontMind 视觉检索任务。",
    );
  }
  const input = visualSearchOperationInputSchema.parse(operation.input);
  const staticCatalogMode = isStaticCatalogWorkflowVersion(
    input.workflowVersion,
  );
  const projectRows = await db
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, operation.projectId),
        eq(siteProjects.userId, operation.userId),
      ),
    )
    .limit(1);
  const project = projectRows[0];
  if (!project) {
    throw new TwentyFirstProviderFailure(
      "PROJECT_NOT_FOUND",
      "AI 建站项目不存在。",
    );
  }
  if (project.currentKnowledgeSnapshotId !== input.knowledgeSnapshotId) {
    throw new TwentyFirstProviderFailure(
      "STALE_KNOWLEDGE_SNAPSHOT",
      "知识库版本已变化，请重新开始视觉检索。",
    );
  }
  const existingRows = await db
    .select()
    .from(websiteStyleSampleBatches)
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, project.id),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(
          websiteStyleSampleBatches.engineerNote,
          operationMarker(operation.id),
        ),
      ),
    )
    .limit(staticCatalogMode ? STATIC_TEMPLATE_CATALOG_PAGE_COUNT : 1);
  let existingBoard: ExistingBoard | null = null;
  if (existingRows[0]) {
    const existingBatchIds = existingRows.map((row: { id: string }) => row.id);
    const sampleRows = await db
      .select({ id: websiteStyleSamples.id })
      .from(websiteStyleSamples)
      .where(inArray(websiteStyleSamples.batchId, existingBatchIds));
    existingBoard = {
      batchId: existingRows[0].id,
      batchIds: existingBatchIds,
      pageCount: existingRows.length,
      candidateCount: sampleRows.length,
      selectionBundleHash: existingRows[0].selectionBundleHash,
    };
  }
  const priorSampleRows = await db
    .select({
      batchId: websiteStyleSamples.batchId,
      sourceMetadata: websiteStyleSamples.sourceMetadata,
    })
    .from(websiteStyleSamples)
    .innerJoin(
      websiteStyleSampleBatches,
      eq(websiteStyleSampleBatches.id, websiteStyleSamples.batchId),
    )
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, project.id),
        eq(websiteStyleSampleBatches.userId, operation.userId),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        eq(websiteStyleSampleBatches.status, "published"),
      ),
    );
  const priorMetadata: Array<Record<string, unknown>> = priorSampleRows.map(
    (row: { sourceMetadata: unknown }) =>
      (row.sourceMetadata ?? {}) as Record<string, unknown>,
  );
  const priorEvidence: Array<Record<string, unknown>> = priorMetadata.map(
    (metadata) => (metadata.visualEvidence ?? {}) as Record<string, unknown>,
  );
  const snapshotRows = await db
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.knowledgeSnapshotId),
        eq(knowledgeBaseSnapshots.userId, operation.userId),
      ),
    )
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot || !/^[a-f0-9]{64}$/u.test(snapshot.archiveHash ?? "")) {
    throw new TwentyFirstProviderFailure(
      "KNOWLEDGE_SNAPSHOT_INVALID",
      "当前企业知识库校验未完成，请先完成知识库后重试。",
    );
  }
  const publishedSamplesByBatch = new Map<string, number>();
  for (const row of priorSampleRows as Array<{ batchId: string }>) {
    publishedSamplesByBatch.set(
      row.batchId,
      (publishedSamplesByBatch.get(row.batchId) ?? 0) + 1,
    );
  }
  return {
    project,
    snapshot,
    brief: resolveSiteBrief(project, snapshot),
    existingBoard,
    publishedPageCount: [...publishedSamplesByBatch.values()].filter(
      (sampleCount) =>
        sampleCount ===
        (staticCatalogMode
          ? STATIC_TEMPLATE_CATALOG_PAGE_SIZE
          : SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE),
    ).length,
    previousReferences: {
      providerItemKeys: priorMetadata.flatMap((metadata) =>
        typeof metadata.providerItemKey === "string"
          ? [metadata.providerItemKey]
          : [],
      ),
      previewSha256s: priorEvidence.flatMap((evidence) =>
        typeof evidence.previewSha256 === "string"
          ? [evidence.previewSha256]
          : [],
      ),
      perceptualHashes: priorMetadata.flatMap((metadata) =>
        typeof metadata.previewPerceptualHash === "string"
          ? [metadata.previewPerceptualHash]
          : typeof metadata.referencePerceptualHash === "string"
            ? [metadata.referencePerceptualHash]
            : [],
      ),
      sourceTreeSha256s: priorMetadata.flatMap((metadata) =>
        typeof metadata.sourceTreeSha256 === "string"
          ? [metadata.sourceTreeSha256]
          : [],
      ),
      nativePreviewSha256s: priorMetadata.flatMap((metadata) =>
        (metadata.renderer === "twenty_first_native_react_v1" ||
          metadata.renderer === "twenty_first_native_template_v1") &&
        typeof metadata.previewSha256 === "string"
          ? [metadata.previewSha256]
          : [],
      ),
      providerTemplateIds: priorMetadata.flatMap((metadata) =>
        typeof metadata.providerTemplateId === "string"
          ? [metadata.providerTemplateId]
          : [],
      ),
      providerTemplateSlugs: priorMetadata.flatMap((metadata) =>
        typeof metadata.providerSlug === "string"
          ? [metadata.providerSlug]
          : [],
      ),
    },
  };
}

function taxonomyFromDirectives(
  role: TwentyFirstQueryRole,
  directives: readonly SafeVisualDirective[],
  preview?: {
    width: number;
    height: number;
    visualSignals?: {
      dominantHex: string;
      brightness: number;
      contrast: number;
    };
  },
) {
  const values = (prefixes: readonly string[]) =>
    directives
      .filter((directive) =>
        prefixes.some((prefix) => directive.startsWith(`${prefix}:`)),
      )
      .map((directive) => directive.slice(directive.indexOf(":") + 1));
  const layout = values(["structure", "surface", "imagery", "tone"]);
  if (
    preview &&
    preview.width / preview.height >= 1.4 &&
    !layout.includes("wide-crop")
  ) {
    layout.push("wide-crop");
  }
  const palette = values(["color"]);
  if (preview?.visualSignals) {
    palette.unshift(preview.visualSignals.dominantHex);
    if (
      preview.visualSignals.brightness <= 96 &&
      !palette.includes("dark-canvas")
    ) {
      palette.push("dark-canvas");
    } else if (
      preview.visualSignals.brightness >= 180 &&
      !palette.includes("light-canvas")
    ) {
      palette.push("light-canvas");
    }
    if (
      preview.visualSignals.contrast >= 60 &&
      !palette.includes("high-contrast")
    ) {
      palette.push("high-contrast");
    }
  }
  return {
    role,
    palette,
    typography: values(["typography"]),
    layout,
    motion: values(["motion"]),
    accessibility: values(["responsive"]).concat(
      directives.includes("motion:reduced-motion-required")
        ? ["reduced-motion-required"]
        : [],
    ),
  };
}

type FrontMindVisualFamily = (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number];

type FamilySearchRound = "primary" | "supplemental";

type FamilySearchQuery = {
  family: FrontMindVisualFamily;
  round: FamilySearchRound;
  page: 1 | 2 | 3;
  role: "foundation";
  axis: "foundation_split" | "foundation_editorial_modular";
  limit: number;
  query: string;
};

type FamilyReferenceEvidence = "exact" | "safe_fallback";

type FamilyReferenceEdge = {
  candidate: NormalizedTwentyFirstCandidate;
  /** `exact` is proved by family-positive provider metadata.
   * `safe_fallback` passed the general Hero gate without contradicting the
   * target family. Query provenance never creates or upgrades an edge. */
  evidence: FamilyReferenceEvidence;
};

type FamilyReferencePools = Map<FrontMindVisualFamily, FamilyReferenceEdge[]>;

const MAX_FAMILY_SEARCH_CALLS = 18;
const MAX_MIRROR_ATTEMPTS = 36;
const MAX_NATIVE_SOURCE_ATTEMPTS = 18;
const MIRROR_CONCURRENCY = 3;

const FAMILY_SEARCH_TERMS: Record<
  FrontMindVisualFamily,
  readonly [string, string]
> = {
  floating_orbit: [
    "floating orbital geometric hero section organic circles",
    "playful abstract orbit landing page hero particles",
  ],
  split_media: [
    "split layout hero section product media two column",
    "split screen landing page hero image product visual",
  ],
  editorial: [
    "editorial hero section magazine typography asymmetric",
    "editorial landing page hero serif oversized headline",
  ],
  bento: [
    "bento hero section modular card grid landing page",
    "bento landing page hero dashboard modular cards",
  ],
  feature_grid: [
    "feature grid hero section product capabilities landing page",
    "feature cards grid landing page hero technical",
  ],
  centered_dual_cta: [
    "centered hero section dual CTA minimal landing page",
    "centered statement landing page hero two buttons",
  ],
  immersive_visual: [
    "immersive hero section cinematic visual 3d landing page",
    "spatial full screen landing page hero interactive visual",
  ],
  product_stage: [
    "product showcase hero section UI mockup stage landing page",
    "SaaS landing page hero product screenshot interface",
  ],
  full_bleed_statement: [
    "full bleed hero section bold statement oversized typography",
    "full screen landing page hero big headline minimal",
  ],
};

/**
 * Fixed family-specific variants prevent later pages from replaying the same
 * recommendation window. These are structural synonyms rather than generic
 * "fresh" suffixes. Provider output and customer prose cannot select a query.
 */
const FAMILY_PAGE_QUERY_VARIANTS: Record<
  FrontMindVisualFamily,
  Record<1 | 2 | 3, readonly [string, string]>
> = {
  floating_orbit: {
    1: ["", ""],
    2: ["kinetic radial constellation", "layered circular motion geometry"],
    3: ["generative particle field", "concentric spatial illustration"],
  },
  split_media: {
    1: ["", ""],
    2: ["asymmetric two panel masthead", "side by side image copy layout"],
    3: ["offset media text diptych", "dual column visual narrative"],
  },
  editorial: {
    1: ["", ""],
    2: ["publication cover typography", "art directed serif masthead"],
    3: ["newspaper inspired hierarchy", "asymmetric type image composition"],
  },
  bento: {
    1: ["", ""],
    2: ["masonry product story tiles", "modular card mosaic masthead"],
    3: ["nested information tile canvas", "irregular rounded panel collage"],
  },
  feature_grid: {
    1: ["", ""],
    2: ["capability card matrix", "technical benefit tile system"],
    3: ["icon feature matrix masthead", "structured product benefit cards"],
  },
  centered_dual_cta: {
    1: ["", ""],
    2: ["symmetrical conversion masthead", "centered two action statement"],
    3: ["minimal paired action header", "balanced headline button pair"],
  },
  immersive_visual: {
    1: ["", ""],
    2: ["cinematic spatial scene", "full viewport depth experience"],
    3: ["parallax environment masthead", "three dimensional visual canvas"],
  },
  product_stage: {
    1: ["", ""],
    2: ["software interface pedestal", "device mockup spotlight composition"],
    3: ["application preview theater", "layered product screen showcase"],
  },
  full_bleed_statement: {
    1: ["", ""],
    2: [
      "edge to edge typographic declaration",
      "oversized minimal type canvas",
    ],
    3: ["dramatic headline only masthead", "full viewport bold type statement"],
  },
};

type FamilyEligibilityRule = {
  /** Query provenance is never a positive signal. These expressions run only
   * against provider-owned, sanitized title/description/page coordinates. */
  positiveMetadata: readonly RegExp[];
  negativeMetadata: readonly RegExp[];
  positiveDirectives: readonly SafeVisualDirective[];
  negativeDirectives: readonly SafeVisualDirective[];
};

/**
 * A real 21st Hero may only represent one FrontMind family when its own safe
 * catalog metadata describes that composition. The search query that happened
 * to return an item is deliberately absent from this contract: a generic
 * "Hero section" returned for a Bento query is still generic, not Bento.
 *
 * Directives are supporting/contradicting evidence derived from the same safe
 * metadata. Explicit family metadata is always required so broad directives
 * such as `structure:modular-grid` cannot collapse Bento and Feature Grid into
 * the same visual reference pool.
 */
const FAMILY_ELIGIBILITY_RULES: Record<
  FrontMindVisualFamily,
  FamilyEligibilityRule
> = {
  floating_orbit: {
    positiveMetadata: [
      /\b(?:floating|orbital?|orbiting|particle|radial)\b/iu,
      /\borganic[- ](?:circle|shape|blob)s?\b/iu,
    ],
    negativeMetadata: [
      /\b(?:split[- ](?:screen|layout)|two[- ]column|editorial|magazine|bento|masonry|feature[- ]grid|product[- ](?:stage|showcase)|full[- ]bleed)\b/iu,
    ],
    positiveDirectives: [
      "imagery:illustration-led",
      "motion:hover-depth",
      "motion:scroll-triggered",
    ],
    negativeDirectives: [
      "structure:split-layout",
      "structure:editorial-rhythm",
      "structure:modular-grid",
      "imagery:product-ui-led",
    ],
  },
  split_media: {
    positiveMetadata: [
      /\b(?:split[- ](?:screen|layout|media|image|hero)|two[- ]column|side[- ]by[- ]side)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:bento|masonry|editorial|magazine|feature[- ]grid|full[- ]bleed|centered[- ]statement)\b/iu,
    ],
    positiveDirectives: ["structure:split-layout", "imagery:masked-media"],
    negativeDirectives: [
      "structure:modular-grid",
      "structure:editorial-rhythm",
    ],
  },
  editorial: {
    positiveMetadata: [
      /\b(?:editorial|magazine|newspaper|publication|serif[- ]led)\b/iu,
      /\b(?:asymmetric|typographic)\s+(?:editorial|headline|layout)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:bento|masonry|feature[- ]grid|product[- ](?:stage|showcase)|ui[- ]mockup|full[- ]bleed)\b/iu,
    ],
    positiveDirectives: [
      "structure:editorial-rhythm",
      "typography:serif-editorial",
      "structure:asymmetric-grid",
    ],
    negativeDirectives: ["structure:split-layout", "imagery:product-ui-led"],
  },
  bento: {
    positiveMetadata: [
      /\b(?:bento|masonry|modular[- ]card[- ]grid|modular\s+(?:cards?|tiles?))\b/iu,
    ],
    negativeMetadata: [
      /\b(?:editorial|magazine|feature[- ]grid|capabilit(?:y|ies)[- ]grid|split[- ]layout|product[- ](?:stage|showcase))\b/iu,
    ],
    positiveDirectives: [
      "structure:modular-grid",
      "surface:rounded-containers",
    ],
    negativeDirectives: [
      "structure:split-layout",
      "structure:editorial-rhythm",
      "imagery:product-ui-led",
    ],
  },
  feature_grid: {
    positiveMetadata: [
      /\b(?:feature|capabilit(?:y|ies))[- ](?:card[- ])?grid\b/iu,
      /\b(?:feature|capabilit(?:y|ies))\s+cards?\b/iu,
    ],
    negativeMetadata: [
      /\b(?:bento|masonry|pricing|dashboard|sidebar|editorial|magazine|product[- ](?:stage|showcase))\b/iu,
    ],
    positiveDirectives: ["structure:modular-grid", "surface:border-defined"],
    negativeDirectives: [
      "structure:split-layout",
      "structure:editorial-rhythm",
      "imagery:product-ui-led",
    ],
  },
  centered_dual_cta: {
    positiveMetadata: [
      /\b(?:dual|two)[- ](?:cta|call[- ]to[- ]action|buttons?)s?\b/iu,
      /\bcentered\b[^.]{0,80}\b(?:cta|call[- ]to[- ]action|buttons?)s?\b/iu,
    ],
    negativeMetadata: [
      /\b(?:split[- ]layout|bento|masonry|feature[- ]grid|immersive|cinematic|product[- ](?:stage|showcase)|full[- ]bleed)\b/iu,
    ],
    positiveDirectives: [
      "structure:hero-led-hierarchy",
      "typography:display-led-hierarchy",
    ],
    negativeDirectives: [
      "structure:split-layout",
      "structure:modular-grid",
      "imagery:product-ui-led",
    ],
  },
  immersive_visual: {
    positiveMetadata: [
      /\b(?:immersive|cinematic|spatial|three[- ]dimensional|3d|parallax)\b/iu,
      /\bfull[- ]screen\b[^.]{0,80}\b(?:visual|scene|image|video|experience)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:full[- ]bleed[- ]statement|oversized[- ]headline|minimal[- ]statement|product[- ](?:stage|showcase)|ui[- ]mockup|bento|feature[- ]grid)\b/iu,
    ],
    positiveDirectives: [
      "imagery:wide-crop",
      "motion:scroll-triggered",
      "motion:controlled-reveal",
    ],
    negativeDirectives: ["structure:modular-grid", "imagery:product-ui-led"],
  },
  product_stage: {
    positiveMetadata: [
      /\b(?:product[- ]stage|product[- ]showcase|ui[- ]mockup|product[- ]screenshot|interface[- ]preview|app(?:lication)?[- ]preview|device[- ]mockup|software[- ]demo)\b/iu,
      /\b(?:hero\s+with\s+mockup|mockup[- ]display|dashboard[- ]preview(?:[- ]mockup)?)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:pricing|sidebar|admin|settings?|bento|masonry|editorial|magazine|full[- ]bleed|immersive)\b/iu,
    ],
    positiveDirectives: ["imagery:product-ui-led", "surface:soft-shadow-depth"],
    negativeDirectives: [
      "structure:editorial-rhythm",
      "typography:serif-editorial",
    ],
  },
  full_bleed_statement: {
    positiveMetadata: [
      /\bfull[- ]bleed\b[^.]{0,80}\b(?:statement|headline|typography|type)\b/iu,
      /\bfull[- ]screen\b[^.]{0,80}\b(?:statement|big[- ]headline|oversized[- ]headline|typography)\b/iu,
      /\b(?:oversized|big)[- ]headline\b[^.]{0,80}\b(?:statement|minimal|full[- ]screen)\b/iu,
      /\b(?:bold|large|minimal(?:ist)?)\b[^.]{0,80}\b(?:headline|typography|text)\b/iu,
      /\b(?:headline|typography|text)\b[^.]{0,80}\b(?:bold|large|minimal(?:ist)?|dramatic)\b/iu,
    ],
    negativeMetadata: [
      /\b(?:immersive|cinematic|spatial|3d|parallax|product[- ](?:stage|showcase)|ui[- ]mockup|bento|feature[- ]grid|split[- ]layout|collage|overlapping[- ]images?)\b/iu,
    ],
    positiveDirectives: [
      "typography:display-led-hierarchy",
      "tone:bold-graphic",
    ],
    negativeDirectives: [
      "structure:modular-grid",
      "structure:split-layout",
      "imagery:product-ui-led",
    ],
  },
};

function familyReferenceEvidence(
  family: FrontMindVisualFamily,
  candidate: NormalizedTwentyFirstCandidate,
): FamilyReferenceEvidence | null {
  if (
    !candidate.heroEligibility.eligible ||
    candidate.catalogRole !== "hero" ||
    !candidate.previewUrl
  ) {
    return null;
  }
  const metadata = [candidate.title, candidate.description, candidate.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC");
  const rule = FAMILY_ELIGIBILITY_RULES[family];
  if (rule.negativeMetadata.some((pattern) => pattern.test(metadata))) {
    return null;
  }
  const directives = new Set(candidate.normalizedDirectives);
  if (rule.negativeDirectives.some((directive) => directives.has(directive))) {
    return null;
  }
  const hasPositiveMetadata = rule.positiveMetadata.some((pattern) =>
    pattern.test(metadata),
  );
  if (hasPositiveMetadata) {
    // Exact family edges are proved only by the provider item's own metadata.
    // Query provenance is deliberately absent from this decision.
    return "exact";
  }
  // A catalog item that has independently passed the generic Hero classifier,
  // has a real preview and contradicts none of this family's safety rules may
  // fill a sparse family only as a lower-priority safe fallback.
  return "safe_fallback";
}

function familyQueryAxis(
  family: FrontMindVisualFamily,
): FamilySearchQuery["axis"] {
  return family === "split_media" || family === "product_stage"
    ? "foundation_split"
    : "foundation_editorial_modular";
}

function safeFamilySearchContext(brief: SiteBrief) {
  const genericFragment =
    /^(?:企业与品牌概览|品牌概览|公司介绍|关于我们|产品与服务|首页|知识库|home|about(?: us)?|products?(?: and services)?|company overview)$/iu;
  return Array.from(
    new Set(
      [brief.companyName, ...brief.offerings.slice(0, 2)]
        .map((value) =>
          value
            .normalize("NFKC")
            .replace(/[\u0000-\u001f\u007f]/gu, " ")
            .replace(/[^\p{L}\p{N}\s+&._/-]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 64),
        )
        .filter(
          (value) =>
            value &&
            !genericFragment.test(value) &&
            !SENSITIVE_SEARCH_CONTEXT.test(value),
        ),
    ),
  )
    .slice(0, 3)
    .join(" ")
    .slice(0, 160);
}

function composeFamilySearchQuery(input: {
  family: FrontMindVisualFamily;
  round: FamilySearchRound;
  page: 1 | 2 | 3;
  brief: SiteBrief;
}): FamilySearchQuery {
  const terms = FAMILY_SEARCH_TERMS[input.family];
  const termIndex = input.round === "primary" ? 0 : 1;
  const pageVariant =
    FAMILY_PAGE_QUERY_VARIANTS[input.family][input.page][termIndex];
  const context = safeFamilySearchContext(input.brief);
  return {
    family: input.family,
    round: input.round,
    page: input.page,
    role: "foundation",
    axis: familyQueryAxis(input.family),
    // The live client clamps this request to the advertised provider maximum.
    // Asking for eighteen immediately avoids replaying only the recommendation
    // head on supplemental pages; the number of calls remains independently
    // bounded below.
    limit: 18,
    query: `${terms[termIndex]}${pageVariant ? ` ${pageVariant}` : ""}${context ? ` for ${context}` : ""}`,
  };
}

function emptyFamilyReferencePools(): FamilyReferencePools {
  return new Map(
    FRONTMIND_VISUAL_FAMILIES_V3.map((family) => [family, []] as const),
  );
}

function compareFamilyEdges(
  left: FamilyReferenceEdge,
  right: FamilyReferenceEdge,
) {
  return (
    (left.evidence === right.evidence
      ? 0
      : left.evidence === "exact"
        ? -1
        : 1) ||
    left.candidate.queryRank - right.candidate.queryRank ||
    left.candidate.searchRank - right.candidate.searchRank ||
    right.candidate.score - left.candidate.score ||
    left.candidate.providerItemKey.localeCompare(
      right.candidate.providerItemKey,
    )
  );
}

function addCandidateToFamilyGraph(input: {
  pools: FamilyReferencePools;
  candidate: NormalizedTwentyFirstCandidate;
  excludedProviderKeys?: ReadonlySet<string>;
}) {
  if (input.excludedProviderKeys?.has(input.candidate.providerItemKey)) return;
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    const evidence = familyReferenceEvidence(family, input.candidate);
    if (!evidence) continue;
    const pool = input.pools.get(family)!;
    const existingIndex = pool.findIndex(
      (edge) =>
        edge.candidate.providerItemKey === input.candidate.providerItemKey,
    );
    if (existingIndex < 0) {
      pool.push({ candidate: input.candidate, evidence });
    } else if (
      evidence === "exact" &&
      pool[existingIndex]!.evidence === "safe_fallback"
    ) {
      pool[existingIndex] = { candidate: input.candidate, evidence };
    }
    pool.sort(compareFamilyEdges);
  }
}

async function searchFamilyRound(input: {
  session: TwentyFirstReadOnlySession;
  brief: SiteBrief;
  families: readonly FrontMindVisualFamily[];
  round: FamilySearchRound;
  page: 1 | 2 | 3;
  pools: FamilyReferencePools;
  queries: FamilySearchQuery[];
  searchedCandidates: Map<
    string,
    ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
  >;
  signal: AbortSignal;
  diagnostics: VisualSearchDiagnostics;
  excludedProviderKeys?: ReadonlySet<string>;
  generalHeroEligibleKeys: Set<string>;
  effectiveSearchLimit: number;
  nativeSourceMode?: boolean;
}) {
  const preferredNativeSearchType = (
    input.session as TwentyFirstReadOnlySession & {
      preferredSearchType?: "template" | "component";
    }
  ).preferredSearchType;
  const search = input.session.search as unknown as (request: {
    query: string;
    type: "template" | "component";
    limit: number;
    tag?: "hero";
    sort?: "recommended";
  }) => Promise<unknown>;
  for (const family of input.families) {
    if (input.queries.length >= MAX_FAMILY_SEARCH_CALLS) break;
    if (input.signal.aborted) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_SEARCH_TIMEOUT",
        "视觉检索已超时；可申请重置，批准后可从当前企业知识库重新开始。",
      );
    }
    const composedQuery = composeFamilySearchQuery({
      family,
      round: input.round,
      page: input.page,
      brief: input.brief,
    });
    const query: FamilySearchQuery = {
      ...composedQuery,
      query: input.nativeSourceMode
        ? `${composedQuery.query} complete responsive landing page homepage source`
        : composedQuery.query,
      limit: Math.max(
        1,
        Math.min(composedQuery.limit, Math.trunc(input.effectiveSearchLimit)),
      ),
    };
    const envelope: TwentyFirstSearchEnvelope = {
      role: query.role,
      axis: query.axis,
      limit: query.limit,
      payload: await search({
        query: query.query,
        type: input.nativeSourceMode
          ? (preferredNativeSearchType ?? "component")
          : "component",
        limit: query.limit,
        ...(input.nativeSourceMode ? {} : { tag: "hero" as const }),
        sort: "recommended",
      }),
    };
    input.queries.push(query);
    input.diagnostics.diversity.familyQueriesRun += 1;
    const normalized = normalizeTwentyFirstSearchResults([envelope]);
    input.diagnostics.searchedByAxis[query.axis] += normalized.length;
    for (const candidate of normalized) {
      input.searchedCandidates.set(candidate.providerItemKey, candidate);
    }
    const funnel = buildTwentyFirstSearchOnlyFunnel({
      searchEnvelopes: [envelope],
      retrievalLimit: query.limit,
    });
    for (const candidate of funnel.retrievalShortlist) {
      input.generalHeroEligibleKeys.add(candidate.providerItemKey);
      addCandidateToFamilyGraph({
        pools: input.pools,
        candidate,
        excludedProviderKeys: input.excludedProviderKeys,
      });
    }
  }
}

function maximumKeyAssignment(
  pools: FamilyReferencePools,
  unavailableProviderKeys: ReadonlySet<string> = new Set(),
) {
  const assignment = new Map<FrontMindVisualFamily, FamilyReferenceEdge>();
  const ownerByProviderKey = new Map<string, FrontMindVisualFamily>();
  const visit = (
    family: FrontMindVisualFamily,
    visited: Set<string>,
  ): boolean => {
    for (const edge of pools.get(family) ?? []) {
      const key = edge.candidate.providerItemKey;
      if (unavailableProviderKeys.has(key) || visited.has(key)) continue;
      visited.add(key);
      const owner = ownerByProviderKey.get(key);
      if (!owner || visit(owner, visited)) {
        ownerByProviderKey.set(key, family);
        assignment.set(family, edge);
        return true;
      }
    }
    return false;
  };
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    visit(family, new Set());
  }
  return assignment;
}

function hallDeficiencyFamilyClosure(input: {
  pools: FamilyReferencePools;
  assignment: ReadonlyMap<FrontMindVisualFamily, FamilyReferenceEdge>;
  unavailableProviderKeys?: ReadonlySet<string>;
}) {
  const unavailable = input.unavailableProviderKeys ?? new Set<string>();
  const ownerByProviderKey = new Map(
    [...input.assignment].map(
      ([family, edge]) => [edge.candidate.providerItemKey, family] as const,
    ),
  );
  const pending = FRONTMIND_VISUAL_FAMILIES_V3.filter(
    (family) => !input.assignment.has(family),
  );
  const closure = new Set<FrontMindVisualFamily>(pending);
  while (pending.length > 0) {
    const family = pending.shift()!;
    for (const edge of input.pools.get(family) ?? []) {
      const key = edge.candidate.providerItemKey;
      if (unavailable.has(key)) continue;
      const owner = ownerByProviderKey.get(key);
      if (owner && !closure.has(owner)) {
        closure.add(owner);
        pending.push(owner);
      }
    }
  }
  return closure;
}

function nextMirrorCandidates(input: {
  pools: FamilyReferencePools;
  keyAssignment: ReadonlyMap<FrontMindVisualFamily, FamilyReferenceEdge>;
  compatibleAssignment: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  attemptedProviderKeys: ReadonlySet<string>;
  unavailableProviderKeys: ReadonlySet<string>;
  limit: number;
}) {
  const selected = new Map<string, NormalizedTwentyFirstCandidate>();
  const add = (edge: FamilyReferenceEdge) => {
    const key = edge.candidate.providerItemKey;
    if (
      selected.size >= input.limit ||
      input.attemptedProviderKeys.has(key) ||
      input.unavailableProviderKeys.has(key)
    ) {
      return;
    }
    selected.set(key, edge.candidate);
  };
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    const edge = input.keyAssignment.get(family);
    if (edge) add(edge);
    if (selected.size >= input.limit) return [...selected.values()];
  }
  if (selected.size > 0) return [...selected.values()];

  // A full provider-key assignment can still be incompatible after preview
  // SHA/pHash checks. Rank unmirrored alternatives by how many currently
  // deficient families they can safely serve, then prefer exact metadata.
  const deficient = new Set(
    FRONTMIND_VISUAL_FAMILIES_V3.filter(
      (family) => !input.compatibleAssignment.has(family),
    ),
  );
  const edgeByKey = new Map<string, FamilyReferenceEdge>();
  const supportByKey = new Map<string, number>();
  const exactByKey = new Map<string, number>();
  for (const family of FRONTMIND_VISUAL_FAMILIES_V3) {
    for (const edge of input.pools.get(family) ?? []) {
      const key = edge.candidate.providerItemKey;
      if (
        input.attemptedProviderKeys.has(key) ||
        input.unavailableProviderKeys.has(key)
      ) {
        continue;
      }
      const existing = edgeByKey.get(key);
      if (!existing || compareFamilyEdges(edge, existing) < 0) {
        edgeByKey.set(key, edge);
      }
      if (deficient.has(family)) {
        supportByKey.set(key, (supportByKey.get(key) ?? 0) + 1);
      }
      if (edge.evidence === "exact") {
        exactByKey.set(key, (exactByKey.get(key) ?? 0) + 1);
      }
    }
  }
  const ranked = [...edgeByKey.values()].sort(
    (left, right) =>
      (supportByKey.get(right.candidate.providerItemKey) ?? 0) -
        (supportByKey.get(left.candidate.providerItemKey) ?? 0) ||
      (exactByKey.get(right.candidate.providerItemKey) ?? 0) -
        (exactByKey.get(left.candidate.providerItemKey) ?? 0) ||
      compareFamilyEdges(left, right),
  );
  for (const edge of ranked) {
    add(edge);
    if (selected.size >= input.limit) break;
  }
  return [...selected.values()];
}

function nextHallRescueFamily(input: {
  pools: FamilyReferencePools;
  assignment: ReadonlyMap<FrontMindVisualFamily, FamilyReferenceEdge>;
  queried: ReadonlySet<FrontMindVisualFamily>;
}) {
  const closure = hallDeficiencyFamilyClosure({
    pools: input.pools,
    assignment: input.assignment,
  });
  const index = (family: FrontMindVisualFamily) =>
    FRONTMIND_VISUAL_FAMILIES_V3.indexOf(family);
  const choose = (families: readonly FrontMindVisualFamily[]) =>
    [...families]
      .filter((family) => !input.queried.has(family))
      .sort(
        (left, right) =>
          Number(input.assignment.has(left)) -
            Number(input.assignment.has(right)) ||
          (input.pools.get(left)?.length ?? 0) -
            (input.pools.get(right)?.length ?? 0) ||
          index(left) - index(right),
      )[0];
  // Query the alternating deficiency closure first. If all of it has already
  // been explored, use the remaining family allowlist; this makes the bound
  // complete even when a rescue query introduces a new cross-family edge.
  return choose([...closure]) ?? choose(FRONTMIND_VISUAL_FAMILIES_V3);
}

function compatibleKeyEdges(input: {
  pools: FamilyReferencePools;
  assignment: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
}) {
  const edges = new Map<FrontMindVisualFamily, FamilyReferenceEdge>();
  for (const [family, reference] of input.assignment) {
    const edge = (input.pools.get(family) ?? []).find(
      (candidateEdge) =>
        candidateEdge.candidate.providerItemKey ===
        reference.candidate.providerItemKey,
    );
    if (edge) edges.set(family, edge);
  }
  return edges;
}

function refreshRetrievalDiagnostics(input: {
  pools: FamilyReferencePools;
  searchedCandidates: Map<
    string,
    ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
  >;
  mirrored: readonly MirroredReference[];
  assigned: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  diagnostics: VisualSearchDiagnostics;
  queries?: readonly FamilySearchQuery[];
  keyMatchingCardinality?: number;
  generalHeroEligibleKeys?: ReadonlySet<string>;
  effectiveSearchLimit?: number;
}) {
  const eligibleKeys = new Set(
    [...input.pools.values()].flatMap((pool) =>
      pool.map((edge) => edge.candidate.providerItemKey),
    ),
  );
  const edges = [...input.pools.values()].flat();
  input.diagnostics.normalizedUnique = input.searchedCandidates.size;
  input.diagnostics.withPreviewReference = [
    ...input.searchedCandidates.values(),
  ].filter((candidate) => candidate.previewUrl).length;
  input.diagnostics.shortlistCount = eligibleKeys.size;
  input.diagnostics.eligibilityEdgeCount = edges.length;
  input.diagnostics.exactEligibilityEdgeCount = edges.filter(
    (edge) => edge.evidence === "exact",
  ).length;
  input.diagnostics.safeFallbackEdgeCount = edges.filter(
    (edge) => edge.evidence === "safe_fallback",
  ).length;
  input.diagnostics.keyMatchingCardinality =
    input.keyMatchingCardinality ?? maximumKeyAssignment(input.pools).size;
  input.diagnostics.compatibleMatchingCardinality = input.assigned.size;
  input.diagnostics.deficientFamilyCount = Math.max(
    0,
    FRONTMIND_VISUAL_FAMILIES_V3.length - input.assigned.size,
  );
  input.diagnostics.queryCalls =
    input.queries?.length ?? input.diagnostics.diversity.familyQueriesRun;
  input.diagnostics.maximumQueryLimit = Math.max(
    0,
    ...(input.queries ?? []).map((query) => query.limit),
  );
  input.diagnostics.effectiveSearchLimit = Math.max(
    0,
    Math.trunc(
      input.effectiveSearchLimit ?? input.diagnostics.maximumQueryLimit,
    ),
  );
  input.diagnostics.generalHeroEligibleCount =
    input.generalHeroEligibleKeys?.size ?? eligibleKeys.size;
  input.diagnostics.exactEligibilityEdges =
    input.diagnostics.exactEligibilityEdgeCount;
  input.diagnostics.safeFallbackEdges = input.diagnostics.safeFallbackEdgeCount;
  input.diagnostics.mirrorAttempts = input.diagnostics.mirrorAttempted;
  input.diagnostics.diversity.eligibleReferences = eligibleKeys.size;
  input.diagnostics.diversity.mirroredReferences = input.mirrored.length;
  input.diagnostics.diversity.assignedFamilies = input.assigned.size;
  input.diagnostics.diversity.distinctProviderItems = new Set(
    [...input.assigned.values()].map(
      (reference) => reference.candidate.providerItemKey,
    ),
  ).size;
  input.diagnostics.diversity.distinctReferenceHashes = new Set(
    [...input.assigned.values()].map((reference) => reference.previewSha256),
  ).size;
  const perceptualHashes = [...input.assigned.values()].map(
    (reference) => reference.perceptualHash,
  );
  input.diagnostics.diversity.distinctReferencePerceptualHashes = new Set(
    perceptualHashes,
  ).size;
  input.diagnostics.diversity.minimumReferenceHammingDistance =
    minimumPerceptualDistance(perceptualHashes);
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/avif":
      return "avif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      throw new TwentyFirstProviderFailure(
        "PREVIEW_MIME_INVALID",
        "视觉参考图片格式不受支持。",
      );
  }
}

function previewRejectionReason(error: unknown): PreviewRejectionReason {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const message = error instanceof Error ? error.message : "";
  const value = `${code}:${message}`;
  if (abortLike(error)) return "aborted";
  if (/HASH/u.test(value)) return "hash";
  if (/MIME/u.test(value)) return "mime";
  if (/(?:SIZE|LARGE|PIXEL)/u.test(value)) return "size";
  if (/(?:IMAGE|DECODE|SHARP)/iu.test(value)) return "decode";
  if (/REDIRECT/u.test(value)) return "redirect";
  if (/(?:ENOTFOUND|EAI_AGAIN|DNS)/u.test(value)) return "dns";
  if (/(?:ECONN|ENET|EHOST|TLS|SOCKET|CONNECTED_ADDRESS)/u.test(value)) {
    return "connect";
  }
  if (/(?:HTTP|FETCH|BODY)/u.test(value)) return "http";
  if (/(?:URL|PRIVATE_ADDRESS|UNSAFE)/u.test(value)) return "url";
  return "http";
}

async function mirrorCandidates(input: {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  candidates: NormalizedTwentyFirstCandidate[];
  signal: AbortSignal;
  fetchPreview: typeof fetchSafeVisualPreview;
  persistArtifact: typeof persistSiteOpsArtifact;
  diagnostics: VisualSearchDiagnostics;
  priorPreviewHashes?: ReadonlySet<string>;
  priorPerceptualHashes?: ReadonlySet<string>;
}) {
  const mirrored: MirroredReference[] = [];
  const rejectedProviderKeys = new Set<string>();
  const priorPreviewHashes = input.priorPreviewHashes ?? new Set<string>();
  const priorPerceptualHashes =
    input.priorPerceptualHashes ?? new Set<string>();
  for (
    let offset = 0;
    offset < input.candidates.length;
    offset += MIRROR_CONCURRENCY
  ) {
    if (input.signal.aborted) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_SEARCH_TIMEOUT",
        "视觉预览镜像已超时；可申请重置，批准后可从当前企业知识库重新开始。",
      );
    }
    const batch = input.candidates.slice(offset, offset + MIRROR_CONCURRENCY);
    const downloaded = await Promise.all(
      batch.map(async (candidate) => {
        input.diagnostics.mirrorAttempted += 1;
        input.diagnostics.previewFetchAttempts += 1;
        try {
          const preview = await input.fetchPreview({
            url: candidate.previewUrl!,
            signal: input.signal,
          });
          const perceptualHash = await perceptualHash64(preview.buffer);
          return { candidate, preview, perceptualHash } as const;
        } catch (error) {
          if (input.signal.aborted) {
            throw new TwentyFirstProviderFailure(
              "VISUAL_SEARCH_TIMEOUT",
              "视觉预览镜像已超时；可申请重置，批准后可从当前企业知识库重新开始。",
            );
          }
          rejectDiagnostic(input.diagnostics, previewRejectionReason(error));
          rejectedProviderKeys.add(candidate.providerItemKey);
          return null;
        }
      }),
    );
    for (const downloadedItem of downloaded) {
      if (!downloadedItem) continue;
      const { candidate, preview, perceptualHash } = downloadedItem;
      if (
        priorPreviewHashes.has(preview.sha256) ||
        [...priorPerceptualHashes].some(
          (hash) => perceptualHashDistance(hash, perceptualHash) < 6,
        )
      ) {
        rejectDiagnostic(input.diagnostics, "duplicate");
        rejectedProviderKeys.add(candidate.providerItemKey);
        continue;
      }
      let asset: Awaited<ReturnType<typeof input.persistArtifact>>;
      try {
        asset = await input.persistArtifact({
          userId: input.operation.userId,
          projectId: input.context.project.id,
          kind: "21st-visual-preview",
          filename: `21st-${candidate.candidateId.slice(0, 120)}.${extensionForMimeType(preview.mimeType)}`,
          mimeType: preview.mimeType,
          buffer: preview.buffer,
          maxBytes: 5 * 1024 * 1024,
        });
      } catch {
        rejectDiagnostic(input.diagnostics, "persist");
        rejectedProviderKeys.add(candidate.providerItemKey);
        continue;
      }
      if (asset.contentSha256 !== preview.sha256) {
        rejectDiagnostic(input.diagnostics, "hash");
        rejectedProviderKeys.add(candidate.providerItemKey);
        continue;
      }
      mirrored.push({
        sampleId: randomUUID(),
        candidate,
        taxonomy: taxonomyFromDirectives(
          candidate.queryRole,
          candidate.normalizedDirectives,
          {
            width: preview.width,
            height: preview.height,
            visualSignals: preview.visualSignals,
          },
        ),
        previewLocalAssetId: asset.id,
        previewSha256: preview.sha256,
        perceptualHash,
        visualEvidence: createVisualEvidenceV1({
          evidenceKind: VISUAL_EVIDENCE_KIND,
          providerItemKey: candidate.providerItemKey,
          metadataSha256: candidate.metadataSha256,
          providerResponseSha256: candidate.providerResponseSha256,
          previewSha256: preview.sha256,
          taxonomyDerivationVersion: VISUAL_TAXONOMY_DERIVATION_VERSION,
        }),
      });
      input.diagnostics.mirrorSucceeded += 1;
    }
  }
  return { mirrored, rejectedProviderKeys };
}

function sha256Buffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function deterministicSiteOpsUuid(value: string) {
  const bytes = createHash("sha256")
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function staticTemplateSampleId(input: {
  operationId: string;
  pageNumber: number;
  candidateId: string;
}) {
  return deterministicSiteOpsUuid(
    `frontmind.siteops.static-template-sample.v1\0${input.operationId}\0${input.pageNumber}\0${input.candidateId}`,
  );
}

function staticTemplateBatchId(input: {
  operationId: string;
  pageNumber: number;
}) {
  return deterministicSiteOpsUuid(
    `frontmind.siteops.static-template-batch.v1\0${input.operationId}\0${input.pageNumber}`,
  );
}

async function perceptualHash64(buffer: Buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .grayscale()
    .resize(9, 8, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || info.channels !== 1) {
    throw new Error("PREVIEW_IMAGE_DECODE_FAILED");
  }
  let hash = 0n;
  let bit = 63n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const left = data[row * 9 + column]!;
      const right = data[row * 9 + column + 1]!;
      if (left > right) hash |= 1n << bit;
      bit -= 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

function perceptualHashDistance(left: string, right: string) {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits > 0n) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance;
}

function minimumPerceptualDistance(hashes: readonly string[]) {
  if (hashes.length < 2) return null;
  let minimum = 64;
  for (let left = 0; left < hashes.length; left += 1) {
    for (let right = left + 1; right < hashes.length; right += 1) {
      minimum = Math.min(
        minimum,
        perceptualHashDistance(hashes[left]!, hashes[right]!),
      );
    }
  }
  return minimum;
}

function assignDistinctMirroredReferences(input: {
  pools: FamilyReferencePools;
  mirrored: readonly MirroredReference[];
}) {
  const mirroredByKey = new Map(
    input.mirrored.map(
      (item) => [item.candidate.providerItemKey, item] as const,
    ),
  );
  const choices = new Map(
    FRONTMIND_VISUAL_FAMILIES_V3.map(
      (family) =>
        [
          family,
          (input.pools.get(family) ?? [])
            .flatMap((edge) => {
              const mirrored = mirroredByKey.get(
                edge.candidate.providerItemKey,
              );
              return mirrored ? [{ edge, mirrored }] : [];
            })
            .sort((left, right) => compareFamilyEdges(left.edge, right.edge)),
        ] as const,
    ),
  );
  const familyOrder = [...FRONTMIND_VISUAL_FAMILIES_V3].sort(
    (left, right) =>
      choices.get(left)!.length - choices.get(right)!.length ||
      FRONTMIND_VISUAL_FAMILIES_V3.indexOf(left) -
        FRONTMIND_VISUAL_FAMILIES_V3.indexOf(right),
  );
  let best = new Map<FrontMindVisualFamily, MirroredReference>();
  let explored = 0;
  const solverBudget = 250_000;
  const deadStates = new Set<string>();
  const visit = (
    index: number,
    assigned: Map<FrontMindVisualFamily, MirroredReference>,
    providerKeys: Set<string>,
    previewHashes: Set<string>,
    perceptualHashes: string[],
  ): boolean => {
    explored += 1;
    if (explored > solverBudget) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_MATCHING_BUDGET_EXHAUSTED",
        "视觉参考组合计算暂时超出安全上限，请稍后重试。",
        "attention_required",
      );
    }
    if (assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) {
      // The family-owned V4 baselines are asserted once when the final board
      // is rendered. Reference feasibility depends only on the processed
      // family index and selected provider keys/SHA/pHashes, which lets this
      // search memoize equivalent permutations safely.
      best = new Map(assigned);
      return true;
    }
    if (assigned.size > best.size) best = new Map(assigned);
    if (index >= familyOrder.length) return false;
    if (assigned.size + familyOrder.length - index <= best.size) return false;
    const stateKey = `${index}:${[...providerKeys].sort().join(",")}`;
    if (deadStates.has(stateKey)) return false;
    const family = familyOrder[index]!;
    for (const choice of choices.get(family) ?? []) {
      const reference = choice.mirrored;
      const key = reference.candidate.providerItemKey;
      if (
        providerKeys.has(key) ||
        previewHashes.has(reference.previewSha256) ||
        perceptualHashes.some(
          (hash) => perceptualHashDistance(hash, reference.perceptualHash) < 6,
        )
      ) {
        continue;
      }
      assigned.set(family, reference);
      providerKeys.add(key);
      previewHashes.add(reference.previewSha256);
      perceptualHashes.push(reference.perceptualHash);
      if (
        visit(
          index + 1,
          assigned,
          providerKeys,
          previewHashes,
          perceptualHashes,
        )
      ) {
        return true;
      }
      perceptualHashes.pop();
      previewHashes.delete(reference.previewSha256);
      providerKeys.delete(key);
      assigned.delete(family);
    }
    const completed = visit(
      index + 1,
      assigned,
      providerKeys,
      previewHashes,
      perceptualHashes,
    );
    if (!completed) deadStates.add(stateKey);
    return completed;
  };
  visit(0, new Map(), new Set(), new Set(), []);
  return new Map(
    FRONTMIND_VISUAL_FAMILIES_V3.flatMap((family) => {
      const reference = best.get(family);
      return reference ? [[family, reference] as const] : [];
    }),
  );
}

function legacyHeroVariantForFamily(
  family: (typeof FRONTMIND_VISUAL_FAMILIES_V3)[number],
) {
  if (family === "split_media") return "split_media" as const;
  if (
    family === "editorial" ||
    family === "bento" ||
    family === "feature_grid"
  ) {
    return "editorial_modular" as const;
  }
  if (family === "immersive_visual" || family === "full_bleed_statement") {
    return "immersive_visual" as const;
  }
  return "centered_statement" as const;
}

async function createFrontMindBoardCandidates(input: {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  inspirationByFamily: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  signal: AbortSignal;
  renderCandidates: typeof renderTrustedVisualCandidatePreviews;
  persistArtifact: typeof persistSiteOpsArtifact;
  diagnostics: VisualSearchDiagnostics;
}) {
  if (
    input.inspirationByFamily.size !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    FRONTMIND_VISUAL_FAMILIES_V3.some(
      (family) => !input.inspirationByFamily.has(family),
    )
  ) {
    throw new TwentyFirstProviderFailure(
      "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
      "FrontMind 未能为 9 个视觉方向逐一绑定真实 Hero 参考。",
      "attention_required",
    );
  }
  const previewBlueprints = FRONTMIND_VISUAL_FAMILIES_V3.map((heroFamily) => {
    const reference = input.inspirationByFamily.get(heroFamily)!;
    return trustedVisualPreviewBlueprintV4(heroFamily, reference.taxonomy);
  });
  const semanticDiversity = assertVisualBlueprintDiversityV4(previewBlueprints);
  input.diagnostics.diversity.distinctStyleSignatures =
    semanticDiversity.uniqueStyleSignatures;
  input.diagnostics.diversity.paletteVariants =
    semanticDiversity.uniquePalettes;
  input.diagnostics.diversity.backgroundVariants =
    semanticDiversity.uniqueBackgrounds;
  input.diagnostics.diversity.typographyVariants =
    semanticDiversity.uniqueTypeSystems;
  input.diagnostics.diversity.compositionVariants =
    semanticDiversity.uniqueCompositions;
  const previewBlueprintByFamily = new Map(
    previewBlueprints.map(
      (blueprint) => [blueprint.heroFamily, blueprint] as const,
    ),
  );
  const rendered = await input.renderCandidates({
    brief: input.context.brief,
    blueprints: previewBlueprints,
    signal: input.signal,
  });
  const renderedByFamily = new Map(
    rendered.map((item) => [item.heroFamily, item.buffer] as const),
  );
  if (
    rendered.length !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    renderedByFamily.size !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    FRONTMIND_VISUAL_FAMILIES_V3.some((family) => !renderedByFamily.has(family))
  ) {
    throw new TwentyFirstProviderFailure(
      "FRONTMIND_VISUAL_RENDER_INCOMPLETE",
      "9 个视觉候选未能完整生成，请稍后重试。",
      "attention_required",
    );
  }
  const candidates: FrontMindBoardCandidate[] = [];
  const seenRealizationHashes = new Set<string>();
  const realizationPerceptualHashes: string[] = [];
  for (let index = 0; index < FRONTMIND_VISUAL_FAMILIES_V3.length; index += 1) {
    const heroFamily = FRONTMIND_VISUAL_FAMILIES_V3[index]!;
    const inspiration = input.inspirationByFamily.get(heroFamily)!;
    const buffer = renderedByFamily.get(heroFamily)!;
    const previewBlueprint = previewBlueprintByFamily.get(heroFamily)!;
    const realizationPreviewSha256 = sha256Buffer(buffer);
    const realizationPerceptualHash = await perceptualHash64(buffer);
    if (seenRealizationHashes.has(realizationPreviewSha256)) {
      throw new TwentyFirstProviderFailure(
        "FRONTMIND_VISUAL_RENDER_DUPLICATE",
        "视觉候选未形成九种不同构图，请稍后重试。",
        "attention_required",
      );
    }
    if (
      realizationPerceptualHashes.some(
        (hash) => perceptualHashDistance(hash, realizationPerceptualHash) < 4,
      )
    ) {
      throw new TwentyFirstProviderFailure(
        "FRONTMIND_VISUAL_RENDER_PERCEPTUALLY_DUPLICATE",
        "视觉候选在感知上过于相似，请稍后重试。",
        "attention_required",
      );
    }
    seenRealizationHashes.add(realizationPreviewSha256);
    realizationPerceptualHashes.push(realizationPerceptualHash);
    const sampleId = randomUUID();
    const asset = await input.persistArtifact({
      userId: input.operation.userId,
      projectId: input.context.project.id,
      kind: "frontmind-visual-preview",
      filename: `frontmind-${heroFamily}.png`,
      mimeType: "image/png",
      buffer,
      maxBytes: 5 * 1024 * 1024,
    });
    if (asset.contentSha256 !== realizationPreviewSha256) {
      throw new TwentyFirstProviderFailure(
        "FRONTMIND_VISUAL_RENDER_HASH_MISMATCH",
        "视觉候选写入校验失败。",
        "attention_required",
      );
    }
    const referenceBlueprint = referenceBlueprintV4ForFamily({
      candidateId: sampleId,
      providerItemKey: inspiration.candidate.providerItemKey,
      referencePreviewLocalAssetId: inspiration.previewLocalAssetId,
      referencePreviewSha256: inspiration.previewSha256,
      realizationPreviewLocalAssetId: asset.id,
      realizationPreviewSha256,
      heroFamily,
      inspirationEvidenceId: inspiration.visualEvidence.evidenceSha256,
      inspirationTaxonomy: inspiration.taxonomy,
      previewBlueprint,
    });
    candidates.push({
      sampleId,
      optionLabel: String.fromCharCode(65 + index),
      queryAxis: familyQueryAxis(heroFamily),
      providerItemKey: inspiration.candidate.providerItemKey,
      title: FRONTMIND_VISUAL_FAMILY_LABELS_V3[heroFamily],
      description:
        inspiration.candidate.description ?? inspiration.candidate.title,
      taxonomy: inspiration.taxonomy,
      author: inspiration.candidate.author,
      sourceUrl: inspiration.candidate.sourceUrl,
      previewLocalAssetId: inspiration.previewLocalAssetId,
      previewSha256: inspiration.previewSha256,
      realizationPreviewLocalAssetId: asset.id,
      realizationPreviewSha256,
      referencePerceptualHash: inspiration.perceptualHash,
      realizationPerceptualHash,
      visualEvidence: inspiration.visualEvidence,
      referenceBlueprint,
      score: inspiration.candidate.score,
      rationale: `独立绑定 21st 真实 Hero 参考，并由 FrontMind 可信组件实现为${FRONTMIND_VISUAL_FAMILY_LABELS_V3[heroFamily]}。`,
    });
  }
  input.diagnostics.diversity.distinctRealizationHashes =
    seenRealizationHashes.size;
  input.diagnostics.diversity.distinctRealizationPerceptualHashes = new Set(
    realizationPerceptualHashes,
  ).size;
  input.diagnostics.diversity.minimumRealizationHammingDistance =
    minimumPerceptualDistance(realizationPerceptualHashes);
  return candidates;
}

async function createNativeBoardCandidates(input: {
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  inspirationByFamily: ReadonlyMap<FrontMindVisualFamily, MirroredReference>;
  preparedByProviderKey: ReadonlyMap<string, PreparedNativeVisualCandidate>;
  persistArtifact: typeof persistSiteOpsArtifact;
}) {
  if (
    input.inspirationByFamily.size !== FRONTMIND_VISUAL_FAMILIES_V3.length ||
    FRONTMIND_VISUAL_FAMILIES_V3.some(
      (family) => !input.inspirationByFamily.has(family),
    )
  ) {
    throw new TwentyFirstProviderFailure(
      "NATIVE_SOURCE_CANDIDATE_PAGE_INCOMPLETE",
      "9 个原生源码视觉候选未能完整生成，请稍后重试。",
      "attention_required",
    );
  }
  const candidates: NativeBoardCandidate[] = [];
  const seenSourceTrees = new Set<string>();
  const seenPreviewHashes = new Set<string>();
  for (let index = 0; index < FRONTMIND_VISUAL_FAMILIES_V3.length; index += 1) {
    const family = FRONTMIND_VISUAL_FAMILIES_V3[index]!;
    const reference = input.inspirationByFamily.get(family)!;
    const prepared = input.preparedByProviderKey.get(
      reference.candidate.providerItemKey,
    );
    if (
      !prepared ||
      seenSourceTrees.has(prepared.sourceTreeSha256) ||
      seenPreviewHashes.has(prepared.previewSha256)
    ) {
      throw new TwentyFirstProviderFailure(
        "NATIVE_SOURCE_CANDIDATE_PAGE_INCOMPLETE",
        "9 个原生源码视觉候选未能完整生成，请稍后重试。",
        "attention_required",
      );
    }
    seenSourceTrees.add(prepared.sourceTreeSha256);
    seenPreviewHashes.add(prepared.previewSha256);
    const previewAsset = await input.persistArtifact({
      userId: input.operation.userId,
      projectId: input.context.project.id,
      kind: "21st-native-react-preview",
      filename: `21st-native-${reference.candidate.candidateId.slice(0, 120)}.png`,
      mimeType: "image/png",
      buffer: prepared.preview,
      maxBytes: 5 * 1024 * 1024,
    });
    if (previewAsset.contentSha256 !== prepared.previewSha256) {
      throw new TwentyFirstProviderFailure(
        "NATIVE_PREVIEW_HASH_MISMATCH",
        "原生源码视觉候选写入校验失败。",
        "attention_required",
      );
    }
    candidates.push({
      sampleId: reference.sampleId,
      optionLabel: String.fromCharCode(65 + index),
      queryAxis: familyQueryAxis(family),
      providerItemId: String(reference.candidate.providerItemId),
      providerItemKey: reference.candidate.providerItemKey,
      providerVersion: prepared.providerVersion,
      title: reference.candidate.title,
      description: reference.candidate.description,
      taxonomy: reference.taxonomy,
      author: reference.candidate.author,
      sourceUrl: reference.candidate.sourceUrl,
      referencePreviewLocalAssetId: reference.previewLocalAssetId,
      referencePreviewSha256: reference.previewSha256,
      referencePerceptualHash: reference.perceptualHash,
      previewLocalAssetId: previewAsset.id,
      previewSha256: prepared.previewSha256,
      visualEvidence: reference.visualEvidence,
      sourceTreeSha256: prepared.sourceTreeSha256,
      sourceArchiveSha256: prepared.sourceArchiveSha256,
      sourceArchive: prepared.sourceArchive,
      entrypoint: prepared.entrypoint,
      demoEntrypoint: prepared.demoEntrypoint,
      score: reference.candidate.score,
      rationale:
        "该候选直接运行 21st 原生 React 源码；选择后以同一源码作为官网制作基线。",
    });
  }
  return candidates;
}

async function persistDefaultBoard(
  db: any,
  input: TwentyFirstBoardPersistenceInput,
) {
  if (
    input.mirroredCandidates.length !== SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE ||
    input.selectionBundle.candidates.length !==
      SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE
  ) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_PAGE_INCOMPLETE",
      "本组视觉候选未完整生成，请稍后重试。",
      "attention_required",
    );
  }
  return db.transaction(async (tx: any): Promise<ExistingBoard> => {
    // Keep the same lock order as customer actions: project, published visual
    // batches, then the active operation. This avoids a project↔operation
    // deadlock when a click races the final board commit.
    const lockedRows = await tx
      .select()
      .from(siteProjects)
      .where(
        and(
          eq(siteProjects.id, input.context.project.id),
          eq(siteProjects.userId, input.operation.userId),
        ),
      )
      .limit(1)
      .for("update");
    const project = lockedRows[0];
    if (
      !project ||
      project.currentKnowledgeSnapshotId !== input.context.snapshot.id ||
      project.revision !== input.searchPlan.admissionRevision
    ) {
      throw visualSearchSuperseded();
    }
    const currentPublishedRows = await tx
      .select({ id: websiteStyleSampleBatches.id })
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.siteProjectId, project.id),
          eq(websiteStyleSampleBatches.userId, input.operation.userId),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.status, "published"),
        ),
      )
      .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES)
      .for("update");
    let lockedPoolPage: typeof visualCandidatePoolPages.$inferSelect | null =
      null;
    if (input.candidatePoolPage) {
      const poolRows = await tx
        .select()
        .from(visualCandidatePools)
        .where(
          and(
            eq(visualCandidatePools.id, input.candidatePoolPage.poolId),
            eq(visualCandidatePools.projectId, project.id),
            eq(visualCandidatePools.userId, input.operation.userId),
            eq(
              visualCandidatePools.knowledgeSnapshotId,
              input.context.snapshot.id,
            ),
            eq(visualCandidatePools.status, "active"),
          ),
        )
        .limit(1)
        .for("update");
      const pageRows = await tx
        .select()
        .from(visualCandidatePoolPages)
        .where(
          and(
            eq(visualCandidatePoolPages.poolId, input.candidatePoolPage.poolId),
            eq(
              visualCandidatePoolPages.pageNumber,
              input.candidatePoolPage.pageNumber,
            ),
          ),
        )
        .limit(1)
        .for("update");
      lockedPoolPage = pageRows[0] ?? null;
      if (
        !poolRows[0] ||
        !lockedPoolPage ||
        lockedPoolPage.selectionBundleLocalAssetId !==
          input.selectionBundleArtifact.id ||
        lockedPoolPage.selectionBundleHash !==
          input.selectionBundleArtifact.contentSha256 ||
        lockedPoolPage.candidateCount !== SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE ||
        !["reserved", "published"].includes(lockedPoolPage.status)
      ) {
        throw visualSearchSuperseded();
      }
    }
    const marker = operationMarker(input.operation.id);
    const existingRows = await tx
      .select()
      .from(websiteStyleSampleBatches)
      .where(
        and(
          eq(websiteStyleSampleBatches.siteProjectId, project.id),
          eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
          eq(websiteStyleSampleBatches.engineerNote, marker),
        ),
      )
      .limit(1)
      .for("update");
    const operationRows = await tx
      .select()
      .from(siteOperations)
      .where(eq(siteOperations.id, input.operation.id))
      .limit(1)
      .for("update");
    const leasedOperation = operationRows[0];
    if (
      !leasedOperation ||
      leasedOperation.status !== "running" ||
      !input.operation.leaseOwner ||
      leasedOperation.leaseOwner !== input.operation.leaseOwner ||
      !leasedOperation.leaseExpiresAt ||
      leasedOperation.leaseExpiresAt.getTime() <= Date.now()
    ) {
      throw visualSearchSuperseded();
    }
    const frozenOperationInput = visualSearchOperationInputSchema.safeParse(
      leasedOperation.input,
    );
    if (
      !frozenOperationInput.success ||
      frozenOperationInput.data.knowledgeSnapshotId !==
        input.context.snapshot.id ||
      canonicalSha256(frozenOperationInput.data) !==
        canonicalSha256(input.operation.input) ||
      leasedOperation.projectId !== input.context.project.id ||
      leasedOperation.userId !== input.operation.userId ||
      leasedOperation.kind !== "visual_search" ||
      leasedOperation.provider !== "21st"
    ) {
      throw visualSearchSuperseded();
    }
    if (existingRows[0]) {
      const sampleRows = await tx
        .select({ id: websiteStyleSamples.id })
        .from(websiteStyleSamples)
        .where(eq(websiteStyleSamples.batchId, existingRows[0].id));
      if (lockedPoolPage?.status === "reserved") {
        await tx
          .update(visualCandidatePoolPages)
          .set({
            status: "published",
            batchId: existingRows[0].id,
            publishedOperationId: input.operation.id,
            publishedAt: existingRows[0].publishedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(visualCandidatePoolPages.id, lockedPoolPage.id),
              eq(visualCandidatePoolPages.status, "reserved"),
            ),
          );
      } else if (
        lockedPoolPage &&
        lockedPoolPage.batchId !== existingRows[0].id
      ) {
        throw visualSearchSuperseded();
      }
      return {
        batchId: existingRows[0].id,
        candidateCount: sampleRows.length,
        selectionBundleHash: existingRows[0].selectionBundleHash,
      };
    }
    const ordinalRows = await tx
      .select({ ordinal: max(websiteStyleSampleBatches.ordinal) })
      .from(websiteStyleSampleBatches)
      .where(eq(websiteStyleSampleBatches.userId, input.operation.userId));
    if (currentPublishedRows.length !== input.searchPlan.page - 1) {
      throw visualSearchSuperseded();
    }
    if (currentPublishedRows.length >= SITEOPS_VISUAL_CANDIDATE_MAX_PAGES) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_CANDIDATE_PAGE_LIMIT_REACHED",
        "本轮已生成全部 27 个视觉候选，请直接选择视觉方向。",
        "attention_required",
      );
    }
    const batchId = randomUUID();
    const now = new Date();
    await tx.insert(websiteStyleSampleBatches).values({
      id: batchId,
      userId: input.operation.userId,
      ticketId: null,
      sourceKind: "siteops_21st",
      siteProjectId: project.id,
      selectionBundleLocalAssetId: input.selectionBundleArtifact.id,
      selectionBundleHash: input.selectionBundleArtifact.contentSha256,
      ordinal: Number(ordinalRows[0]?.ordinal ?? 0) + 1,
      status: "published",
      engineerNote: marker,
      publishedByUserId: null,
      publishedAt: now,
    });
    await tx.insert(websiteStyleSamples).values(
      input.mirroredCandidates.map((item, index) => ({
        id: item.sampleId,
        batchId,
        attachmentId: null,
        previewLocalAssetId: item.previewLocalAssetId,
        sourceMetadata:
          "providerTemplateId" in item
            ? {
                schemaVersion: 6,
                renderer: "twenty_first_native_template_v1" as const,
                workflowVersion: frozenOperationInput.data.workflowVersion,
                providerTemplateId: item.providerTemplateId,
                providerSlug: item.providerSlug,
                providerVersion: item.providerVersion,
                providerItemKey: item.providerItemKey,
                framework: item.framework,
                sourceTreeSha256: item.sourceTreeSha256,
                sourceArchiveSha256: item.sourceArchiveSha256,
                sourceDirectory: item.sourceDirectory,
                entrypoint: item.entrypoint,
                previewSha256: item.previewSha256,
                previewPerceptualHash: item.previewPerceptualHash,
                styleTokens: item.styleTokens ?? null,
                title: item.title,
                description: item.description,
                author: item.author,
                rationale:
                  "该候选由对应完整 21st Template 源码本地构建；选择后使用同一份源码作为官网基线。",
              }
            : "sourceTreeSha256" in item
              ? {
                  schemaVersion: 5,
                  renderer: "twenty_first_native_react_v1" as const,
                  providerItemId: item.providerItemId,
                  providerVersion: item.providerVersion,
                  sourceTreeSha256: item.sourceTreeSha256,
                  sourceArchiveSha256: item.sourceArchiveSha256,
                  entrypoint: item.entrypoint,
                  demoEntrypoint: item.demoEntrypoint,
                  referencePreviewLocalAssetId:
                    item.referencePreviewLocalAssetId,
                  referencePreviewSha256: item.referencePreviewSha256,
                  referencePerceptualHash: item.referencePerceptualHash,
                  previewSha256: item.previewSha256,
                  providerItemKey: item.providerItemKey,
                  queryAxis: item.queryAxis,
                  title: item.title,
                  description: item.description,
                  author: item.author,
                  sourceUrl: item.sourceUrl,
                  catalogRole: "hero",
                  visualEvidence: item.visualEvidence,
                  taxonomy: { ...item.taxonomy },
                  score: item.score,
                  rationale: item.rationale,
                }
              : {
                  heroFamily: item.referenceBlueprint.heroFamily,
                  heroEligibility: {
                    eligible: true,
                    confidence: "explicit",
                    variant: legacyHeroVariantForFamily(
                      item.referenceBlueprint.heroFamily,
                    ),
                    reasons: ["frontmind-trusted-react-family"],
                  },
                  referenceBlueprint: item.referenceBlueprint,
                  realizationPreviewLocalAssetId:
                    item.realizationPreviewLocalAssetId,
                  realizationPreviewSha256: item.realizationPreviewSha256,
                  referencePerceptualHash: item.referencePerceptualHash,
                  realizationPerceptualHash: item.realizationPerceptualHash,
                  providerItemKey: item.providerItemKey,
                  queryAxis: item.queryAxis,
                  title: item.title,
                  description: item.description,
                  author: item.author,
                  sourceUrl: item.sourceUrl,
                  catalogRole: "hero",
                  visualEvidence: item.visualEvidence,
                  taxonomy: { ...item.taxonomy },
                  score: item.score,
                  rationale: item.rationale,
                },
        label: item.optionLabel,
        note: item.title,
        sortOrder: index + 1,
      })),
    );
    const sequenceRows = await tx
      .select({ sequence: max(messages.sequence) })
      .from(messages)
      .where(eq(messages.conversationId, project.conversationId));
    await tx.insert(messages).values({
      id: randomUUID(),
      conversationId: project.conversationId,
      turnId: input.operation.conversationTurnId,
      userId: input.operation.userId,
      role: "assistant",
      content:
        input.searchPlan.page === 1
          ? "已准备 9 个不同风格的视觉候选，请选择一个方向。"
          : `第 ${input.searchPlan.page} 组 9 个全新视觉候选已准备完成，请选择一个方向。`,
      sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
      metadata: {
        siteOps: {
          kind: "visual_board",
          subjectId: batchId,
          revision: project.revision + 1,
          status: "active",
          payload: {
            batchId,
            mode: input.searchPlan.mode,
            page: input.searchPlan.page,
            candidateCount: input.mirroredCandidates.length,
            targets: [18, 9],
            degradedReasons: input.selectionBundle.degradedReasons,
          },
        },
      },
    });
    const projectUpdated = await tx
      .update(siteProjects)
      .set({
        brief: input.context.brief,
        status: "awaiting_visual_selection",
        revision: project.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteProjects.id, project.id),
          eq(siteProjects.revision, project.revision),
        ),
      );
    const affectedRows = Number(
      (Array.isArray(projectUpdated)
        ? (projectUpdated[0] as { affectedRows?: unknown } | undefined)
            ?.affectedRows
        : (projectUpdated as { affectedRows?: unknown } | undefined)
            ?.affectedRows) ?? 0,
    );
    if (affectedRows !== 1) throw visualSearchSuperseded();
    if (lockedPoolPage) {
      const poolPageUpdated = await tx
        .update(visualCandidatePoolPages)
        .set({
          status: "published",
          batchId,
          publishedOperationId: input.operation.id,
          publishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(visualCandidatePoolPages.id, lockedPoolPage.id),
            eq(visualCandidatePoolPages.status, "reserved"),
          ),
        );
      const poolPageAffectedRows = Number(
        (Array.isArray(poolPageUpdated)
          ? (poolPageUpdated[0] as { affectedRows?: unknown } | undefined)
              ?.affectedRows
          : (poolPageUpdated as { affectedRows?: unknown } | undefined)
              ?.affectedRows) ?? 0,
      );
      if (poolPageAffectedRows !== 1) throw visualSearchSuperseded();
    }
    return {
      batchId,
      candidateCount: input.mirroredCandidates.length,
      selectionBundleHash: input.selectionBundleArtifact.contentSha256,
    };
  });
}

export async function persistDefaultStaticTemplateCatalogBoards(
  db: any,
  input: StaticTemplateCatalogBoardsPersistenceInput,
) {
  if (
    input.pages.length !== STATIC_TEMPLATE_CATALOG_PAGE_COUNT ||
    input.pages.some(
      (page) =>
        page.candidates.length !== STATIC_TEMPLATE_CATALOG_PAGE_SIZE ||
        page.selectionBundle.candidates.length !==
          STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
    )
  ) {
    throw new TwentyFirstProviderFailure(
      "STATIC_TEMPLATE_CATALOG_INCOMPLETE",
      "FrontMind 固定 Template 目录不完整，请稍后重试。",
      "attention_required",
    );
  }
  const admittedCount = input.pages
    .flatMap((page) => page.candidates)
    .filter(
      (candidate) => candidate.executionAdmission.status === "admitted",
    ).length;
  return db.transaction(
    async (tx: any): Promise<StaticTemplateCatalogBoardsPersistenceResult> => {
      const projectRows = await tx
        .select()
        .from(siteProjects)
        .where(
          and(
            eq(siteProjects.id, input.context.project.id),
            eq(siteProjects.userId, input.operation.userId),
          ),
        )
        .limit(1)
        .for("update");
      const project = projectRows[0];
      if (
        !project ||
        project.currentKnowledgeSnapshotId !== input.context.snapshot.id ||
        project.revision !== input.searchPlan.admissionRevision
      ) {
        throw visualSearchSuperseded();
      }
      const marker = operationMarker(input.operation.id);
      const existing = await tx
        .select()
        .from(websiteStyleSampleBatches)
        .where(
          and(
            eq(websiteStyleSampleBatches.siteProjectId, project.id),
            eq(websiteStyleSampleBatches.userId, input.operation.userId),
            eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
            eq(websiteStyleSampleBatches.engineerNote, marker),
          ),
        )
        .for("update");
      if (existing.length > 0) {
        if (existing.length !== STATIC_TEMPLATE_CATALOG_PAGE_COUNT) {
          throw visualSearchSuperseded();
        }
        const existingIds = existing.map((row: { id: string }) => row.id);
        const samples = await tx
          .select({ id: websiteStyleSamples.id })
          .from(websiteStyleSamples)
          .where(inArray(websiteStyleSamples.batchId, existingIds));
        if (samples.length !== STATIC_TEMPLATE_CATALOG_ENTRY_COUNT) {
          throw visualSearchSuperseded();
        }
        return {
          batchIds: existingIds,
          candidateCount: samples.length,
        };
      }
      const operationRows = await tx
        .select()
        .from(siteOperations)
        .where(eq(siteOperations.id, input.operation.id))
        .limit(1)
        .for("update");
      const leasedOperation = operationRows[0];
      const frozenInput = visualSearchOperationInputSchema.safeParse(
        leasedOperation?.input,
      );
      if (
        !leasedOperation ||
        leasedOperation.status !== "running" ||
        !input.operation.leaseOwner ||
        leasedOperation.leaseOwner !== input.operation.leaseOwner ||
        !leasedOperation.leaseExpiresAt ||
        leasedOperation.leaseExpiresAt.getTime() <= Date.now() ||
        !frozenInput.success ||
        !("schemaVersion" in frozenInput.data) ||
        (frozenInput.data.schemaVersion !== 3 &&
          frozenInput.data.schemaVersion !== 4) ||
        !isStaticCatalogWorkflowVersion(frozenInput.data.workflowVersion) ||
        frozenInput.data.catalogVersion !== input.catalogVersion ||
        frozenInput.data.knowledgeSnapshotId !== input.context.snapshot.id ||
        canonicalSha256(frozenInput.data) !==
          canonicalSha256(input.operation.input)
      ) {
        throw visualSearchSuperseded();
      }
      const currentRows = await tx
        .select({ id: websiteStyleSampleBatches.id })
        .from(websiteStyleSampleBatches)
        .where(
          and(
            eq(websiteStyleSampleBatches.siteProjectId, project.id),
            eq(websiteStyleSampleBatches.userId, input.operation.userId),
            eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
            eq(websiteStyleSampleBatches.status, "published"),
          ),
        )
        .for("update");
      if (currentRows.length !== 0) throw visualSearchSuperseded();

      const ordinalRows = await tx
        .select({ ordinal: max(websiteStyleSampleBatches.ordinal) })
        .from(websiteStyleSampleBatches)
        .where(eq(websiteStyleSampleBatches.userId, input.operation.userId));
      const firstOrdinal = Number(ordinalRows[0]?.ordinal ?? 0) + 1;
      const now = new Date();
      const batchIds: string[] = [];
      for (const page of [...input.pages].sort(
        (left, right) => left.pageNumber - right.pageNumber,
      )) {
        const batchId = staticTemplateBatchId({
          operationId: input.operation.id,
          pageNumber: page.pageNumber,
        });
        batchIds.push(batchId);
        await tx.insert(websiteStyleSampleBatches).values({
          id: batchId,
          userId: input.operation.userId,
          ticketId: null,
          sourceKind: "siteops_21st",
          siteProjectId: project.id,
          selectionBundleLocalAssetId: page.selectionBundleArtifact.id,
          selectionBundleHash: page.selectionBundleArtifact.contentSha256,
          ordinal: firstOrdinal + page.pageNumber - 1,
          status: "published",
          engineerNote: marker,
          publishedByUserId: null,
          publishedAt: now,
        });
        await tx.insert(websiteStyleSamples).values(
          page.candidates.map((candidate, position) => ({
            id: candidate.sampleId,
            batchId,
            attachmentId: null,
            previewLocalAssetId: candidate.previewLocalAssetId,
            sourceMetadata: {
              schemaVersion: 7,
              renderer: "frontmind_static_template_catalog_v1" as const,
              workflowVersion: frozenInput.data.workflowVersion,
              catalogVersion: candidate.catalogVersion,
              catalogPosition: candidate.catalogPosition,
              catalogCandidateId: candidate.catalogCandidateId,
              providerTemplateId: candidate.providerTemplateId,
              providerSlug: candidate.providerSlug,
              providerVersion: candidate.providerVersion,
              providerItemKey: candidate.providerItemKey,
              sourceOwner: candidate.sourceOwner,
              sourceRepo: candidate.sourceRepo,
              sourceCommitSha: candidate.sourceCommitSha,
              sourceSubdirectory: candidate.sourceSubdirectory,
              sourceLicense: candidate.sourceLicense,
              sourceAssetId: candidate.sourceAssetId,
              sourceArchiveSha256: candidate.sourceArchiveSha256,
              sourceArchiveBytes: candidate.sourceArchiveBytes,
              previewAssetId: candidate.previewAssetId,
              previewLocalAssetId: candidate.previewLocalAssetId,
              previewSha256: candidate.previewSha256,
              previewMimeType: candidate.previewMimeType,
              previewWidth: candidate.previewWidth,
              previewHeight: candidate.previewHeight,
              executionAdmission: candidate.executionAdmission,
              title: candidate.title,
              description: candidate.description,
              rationale:
                candidate.executionAdmission.status === "admitted"
                  ? "该候选已绑定 FrontMind 标准化执行源码、production build、QA 与浏览器验收回执；选择后只读取同一不可变执行归档。"
                  : candidate.executionAdmission.reason,
            },
            label: candidate.optionLabel,
            note: candidate.title,
            sortOrder: position + 1,
          })),
        );
      }
      const sequenceRows = await tx
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, project.conversationId));
      await tx.insert(messages).values({
        id: randomUUID(),
        conversationId: project.conversationId,
        turnId: input.operation.conversationTurnId,
        userId: input.operation.userId,
        role: "assistant",
        content: `固定目录中的 32 个 Template 预览已准备完成；${admittedCount} 个已通过执行准入，可直接选择。`,
        sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
        metadata: {
          siteOps: {
            kind: "visual_board",
            subjectId: batchIds[0],
            revision: project.revision + 1,
            status: "active",
            payload: {
              batchIds,
              mode: "initial",
              page: 1,
              workflowVersion: frozenInput.data.workflowVersion,
              catalogVersion: input.catalogVersion,
              candidateCount: STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
              pageSize: STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
              pageCount: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
              degradedReasons: [],
            },
          },
        },
      });
      const updated = await tx
        .update(siteProjects)
        .set({
          brief: input.context.brief,
          status: "awaiting_visual_selection",
          revision: project.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(siteProjects.id, project.id),
            eq(siteProjects.revision, project.revision),
          ),
        );
      const affectedRows = Number(
        (Array.isArray(updated)
          ? (updated[0] as { affectedRows?: unknown } | undefined)?.affectedRows
          : (updated as { affectedRows?: unknown } | undefined)
              ?.affectedRows) ?? 0,
      );
      if (affectedRows !== 1) throw visualSearchSuperseded();
      return {
        batchIds,
        candidateCount: STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
      };
    },
  );
}

function safeProviderFailure(
  error: unknown,
  stage: VisualSearchStage,
  diagnostics: VisualSearchDiagnostics,
  signal: AbortSignal,
): SiteOpsProviderResult {
  diagnostics.queryCalls = Math.max(
    diagnostics.queryCalls,
    diagnostics.diversity.familyQueriesRun,
  );
  diagnostics.mirrorAttempts = diagnostics.mirrorAttempted;
  diagnostics.exactEligibilityEdges = diagnostics.exactEligibilityEdgeCount;
  diagnostics.safeFallbackEdges = diagnostics.safeFallbackEdgeCount;
  if (signal.aborted || abortLike(error)) {
    if (diagnostics.templateMode) {
      diagnostics.templateFailureCategory = "deadline_exhausted";
      return {
        status: "attention_required",
        code: "VISUAL_SEARCH_DEADLINE_EXHAUSTED",
        message:
          "本次完整 Template 候选处理已达到时间上限；当前知识库和建站资料已保留，可直接重试。",
        result: diagnostics,
      };
    }
    return {
      status: "failed",
      code: "VISUAL_SEARCH_TIMEOUT",
      message:
        "视觉检索已超时；当前知识库和建站资料已保留，可直接重新生成视觉候选。",
      result: diagnostics,
    };
  }
  if (error instanceof TwentyFirstProviderFailure) {
    if (error.code === "VISUAL_MATCHING_BUDGET_EXHAUSTED") {
      diagnostics.terminalReason = "matching_budget_exhausted";
    }
    diagnostics.mirrorAttempts = diagnostics.mirrorAttempted;
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      result: diagnostics,
    };
  }
  if (error instanceof StaticTemplateCatalogError) {
    return {
      status: "attention_required",
      code: error.code,
      message: "冻结的建站模板目录版本无法读取或完整性校验失败。",
      result: diagnostics,
    };
  }
  if (error instanceof z.ZodError) {
    if (stage !== "validate_operation" && stage !== "load_context") {
      return {
        status: "attention_required",
        code: "VISUAL_BOARD_PERSISTENCE_FAILED",
        message: "视觉方向未能安全保存，请稍后重试。",
        result: diagnostics,
      };
    }
    return {
      status: "failed",
      code: "VISUAL_OPERATION_CONTRACT_MISMATCH",
      message: "视觉检索任务合同不一致，请联系 FrontMind 管理员处理。",
      result: diagnostics,
    };
  }
  if (error instanceof TwentyFirstToolContractError) {
    return {
      status: "attention_required",
      code: "MCP_CONTRACT_INCOMPATIBLE",
      message: "FrontMind 视觉目录暂不兼容，请稍后重试。",
      result: diagnostics,
    };
  }
  if (error instanceof AuthServiceError) {
    return {
      status: "attention_required",
      code:
        error.code === "INVALID_CREDENTIAL"
          ? "MCP_AUTH_OR_CAPABILITY_FAILED"
          : "MCP_UNAVAILABLE",
      message:
        error.code === "INVALID_CREDENTIAL"
          ? "FrontMind 视觉目录连接无效，或缺少必要的只读能力。"
          : "FrontMind 视觉目录暂时不可用，请稍后重试。",
      result: diagnostics,
    };
  }
  if (stage === "mcp_retrieval") {
    return {
      status: "attention_required",
      code: "MCP_UNAVAILABLE",
      message: "FrontMind 视觉目录暂时不可用，请稍后重试。",
      result: diagnostics,
    };
  }
  if (stage === "render_host_previews") {
    return {
      status: "attention_required",
      code: "FRONTMIND_VISUAL_RENDER_FAILED",
      message: "9 个视觉候选暂未能完整生成，请稍后重试。",
      result: diagnostics,
    };
  }
  return {
    status: "attention_required",
    code: "VISUAL_BOARD_PERSISTENCE_FAILED",
    message: "视觉方向未能安全保存，请稍后重试。",
    result: diagnostics,
  };
}

function safePersistenceErrorDetails(error: unknown, stage: VisualSearchStage) {
  if (
    stage !== "mirror_previews" &&
    stage !== "persist_selection_bundle" &&
    stage !== "persist_board"
  ) {
    return {};
  }
  if (
    (error instanceof TwentyFirstProviderFailure && !error.diagnosticCause) ||
    error instanceof StaticTemplateCatalogError
  ) {
    return {};
  }
  const candidate =
    error instanceof TwentyFirstProviderFailure && error.diagnosticCause
      ? error.diagnosticCause
      : error;
  if (!candidate || typeof candidate !== "object") return {};
  const record = candidate as Record<string, unknown>;
  const driverCode =
    typeof record.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(record.code)
      ? record.code
      : null;
  const sqlState =
    typeof record.sqlState === "string" &&
    /^[0-9A-Z]{5}$/u.test(record.sqlState)
      ? record.sqlState
      : null;
  const explicitConstraint =
    typeof record.constraint === "string" &&
    /^[A-Za-z0-9_]{1,128}$/u.test(record.constraint)
      ? record.constraint
      : null;
  const safeMessage = typeof record.message === "string" ? record.message : "";
  const extractedConstraint =
    explicitConstraint ??
    /\bconstraint\s+['`"]([A-Za-z0-9_]{1,128})['`"](?:\s|$)/iu.exec(
      safeMessage,
    )?.[1] ??
    null;
  return {
    ...(driverCode ? { driverCode } : {}),
    ...(sqlState ? { sqlState } : {}),
    ...(extractedConstraint ? { constraint: extractedConstraint } : {}),
    ...(stage === "persist_board"
      ? { transactionOutcome: "rolled_back_or_not_started" as const }
      : {}),
  };
}

async function assertCommitLeaseActive(
  assertLeaseActive: (() => Promise<void>) | undefined,
) {
  if (!assertLeaseActive) return;
  try {
    await assertLeaseActive();
  } catch {
    throw visualSearchSuperseded();
  }
}

async function mapWithBoundedConcurrency<T, R>(input: {
  values: readonly T[];
  concurrency: number;
  map: (value: T, index: number) => Promise<R>;
}) {
  const results = new Array<R>(input.values.length);
  let cursor = 0;
  let failed = false;
  let firstFailure: unknown;
  const worker = async () => {
    while (!failed && cursor < input.values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await input.map(input.values[index]!, index);
      } catch (error) {
        if (!failed) firstFailure = error;
        failed = true;
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          input.values.length,
          Math.max(1, Math.trunc(input.concurrency)),
        ),
      },
      worker,
    ),
  );
  if (failed) throw firstFailure;
  return results;
}

const NATIVE_TEMPLATE_CATALOG_DISCOVERY_LIMIT = 60;
const NATIVE_TEMPLATE_PREPARATION_LIMIT = 32;
const NATIVE_TEMPLATE_BATCH_CONCURRENCY = 3;
const NATIVE_TEMPLATE_CATALOG_TIMEOUT_MS = 45_000;
const NATIVE_TEMPLATE_DOWNLOAD_TIMEOUT_MS = 30_000;
const NATIVE_TEMPLATE_PREPARE_TIMEOUT_MS = 120_000;
const NATIVE_TEMPLATE_PAGE_ARCHIVE_BUDGET_BYTES =
  VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES - 1024 * 1024;
const NATIVE_TEMPLATE_CAPACITY_SOLVER_NODE_BUDGET = 250_000;
const NATIVE_TEMPLATE_SHUFFLE_SALT = Buffer.from(
  "frontmind-siteops-native-template-shuffle-salt-v1",
  "utf8",
);
const NATIVE_TEMPLATE_SHUFFLE_INFO = Buffer.from(
  "frontmind-siteops-native-template-shuffle-key-v1",
  "utf8",
);

export function deriveNativeTemplateShuffleKey(encodedMasterKey: string) {
  const trimmed = encodedMasterKey.trim();
  const masterKey = trimmed.startsWith("base64:")
    ? Buffer.from(trimmed.slice(7), "base64")
    : trimmed.startsWith("hex:")
      ? Buffer.from(trimmed.slice(4), "hex")
      : /^[a-f\d]{64}$/iu.test(trimmed)
        ? Buffer.from(trimmed, "hex")
        : Buffer.from(trimmed, "base64");
  if (masterKey.length !== 32) {
    throw new AuthServiceError(
      "INVALID_MASTER_KEY",
      "完整 Template 随机排序服务配置不可用",
    );
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      NATIVE_TEMPLATE_SHUFFLE_SALT,
      NATIVE_TEMPLATE_SHUFFLE_INFO,
      32,
    ),
  );
}

function resolveNativeTemplateShuffleKey() {
  const configured = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new AuthServiceError(
      "INVALID_MASTER_KEY",
      "完整 Template 随机排序服务配置不可用",
    );
  }
  return deriveNativeTemplateShuffleKey(configured);
}

function nativeTemplateProviderKey(
  template: Pick<TwentyFirstNativeTemplateSummary, "templateId" | "slug">,
) {
  return `t:${String(template.templateId)}:${template.slug}`;
}

function deterministicallyShuffleTemplates(input: {
  templates: readonly TwentyFirstNativeTemplateSummary[];
  hmacKey: Buffer;
  seed: string;
}) {
  const domain = `frontmind:siteops:21st-template-v6:${input.seed}`;
  return input.templates
    .map((template, providerIndex) => ({
      template,
      providerIndex,
      rank: createHmac("sha256", input.hmacKey)
        .update(domain)
        .update("\0")
        .update(String(template.templateId))
        .update("\0")
        .update(template.slug)
        .update("\0")
        .update(template.version ?? "")
        .digest("hex"),
    }))
    .sort(
      (left, right) =>
        left.rank.localeCompare(right.rank) ||
        left.providerIndex - right.providerIndex,
    )
    .map(({ template }) => template);
}

export type NativeTemplateCapacityCandidate = {
  key: string;
  archiveBytes: number;
  priorityIndex: number;
};

export type NativeTemplateCapacityPlan = {
  feasible: boolean;
  bins: NativeTemplateCapacityCandidate[][];
  current: NativeTemplateCapacityCandidate[];
  required: number;
  usable: number;
  rejectedOversize: number;
  solverNodes: number;
  solverExhausted: boolean;
};

function partitionNativeTemplateCapacity(input: {
  candidates: readonly NativeTemplateCapacityCandidate[];
  pageCount: number;
  pageSize: number;
  maxPageBytes: number;
  nodeBudget: number;
}) {
  const ordered = [...input.candidates].sort(
    (left, right) =>
      right.archiveBytes - left.archiveBytes ||
      left.priorityIndex - right.priorityIndex ||
      left.key.localeCompare(right.key),
  );
  if (
    ordered.length !== input.pageCount * input.pageSize ||
    ordered.some((candidate) => candidate.archiveBytes > input.maxPageBytes) ||
    ordered.reduce((total, candidate) => total + candidate.archiveBytes, 0) >
      input.pageCount * input.maxPageBytes
  ) {
    return { bins: null, solverNodes: 0, solverExhausted: false } as const;
  }

  const greedyBins = Array.from({ length: input.pageCount }, () => ({
    bytes: 0,
    candidates: [] as NativeTemplateCapacityCandidate[],
  }));
  let greedyFeasible = true;
  for (const candidate of ordered) {
    const target = greedyBins
      .map((bin, index) => ({ bin, index }))
      .filter(
        ({ bin }) =>
          bin.candidates.length < input.pageSize &&
          bin.bytes + candidate.archiveBytes <= input.maxPageBytes,
      )
      .sort(
        (left, right) =>
          left.bin.bytes - right.bin.bytes ||
          left.bin.candidates.length - right.bin.candidates.length ||
          left.index - right.index,
      )[0];
    if (!target) {
      greedyFeasible = false;
      break;
    }
    target.bin.candidates.push(candidate);
    target.bin.bytes += candidate.archiveBytes;
  }
  if (
    greedyFeasible &&
    greedyBins.every((bin) => bin.candidates.length === input.pageSize)
  ) {
    return {
      bins: greedyBins.map((bin) =>
        bin.candidates.sort(
          (left, right) =>
            left.priorityIndex - right.priorityIndex ||
            left.key.localeCompare(right.key),
        ),
      ),
      solverNodes: 0,
      solverExhausted: false,
    } as const;
  }

  const bins = Array.from({ length: input.pageCount }, () => ({
    bytes: 0,
    candidates: [] as NativeTemplateCapacityCandidate[],
  }));
  const memo = new Set<string>();
  let solverNodes = 0;
  let solverExhausted = false;
  const visit = (candidateIndex: number): boolean => {
    solverNodes += 1;
    if (solverNodes > input.nodeBudget) {
      solverExhausted = true;
      return false;
    }
    if (candidateIndex === ordered.length) {
      return bins.every((bin) => bin.candidates.length === input.pageSize);
    }
    const remainingBytes = ordered
      .slice(candidateIndex)
      .reduce((total, candidate) => total + candidate.archiveBytes, 0);
    const remainingCapacity = bins.reduce(
      (total, bin) => total + input.maxPageBytes - bin.bytes,
      0,
    );
    if (remainingBytes > remainingCapacity) return false;
    const state = `${candidateIndex}|${bins
      .map((bin) => `${bin.candidates.length}:${bin.bytes}`)
      .sort()
      .join("|")}`;
    if (memo.has(state)) return false;
    memo.add(state);

    const candidate = ordered[candidateIndex]!;
    const binOrder = bins
      .map((bin, index) => ({ bin, index }))
      .sort(
        (left, right) =>
          left.bin.bytes - right.bin.bytes ||
          left.bin.candidates.length - right.bin.candidates.length ||
          left.index - right.index,
      );
    const symmetricStates = new Set<string>();
    for (const { bin } of binOrder) {
      const symmetricState = `${bin.candidates.length}:${bin.bytes}`;
      if (symmetricStates.has(symmetricState)) continue;
      symmetricStates.add(symmetricState);
      if (
        bin.candidates.length >= input.pageSize ||
        bin.bytes + candidate.archiveBytes > input.maxPageBytes
      ) {
        continue;
      }
      bin.candidates.push(candidate);
      bin.bytes += candidate.archiveBytes;
      if (visit(candidateIndex + 1)) return true;
      bin.bytes -= candidate.archiveBytes;
      bin.candidates.pop();
      if (solverExhausted) return false;
    }
    return false;
  };
  if (!visit(0)) {
    return { bins: null, solverNodes, solverExhausted } as const;
  }
  return {
    bins: bins.map((bin) =>
      bin.candidates.sort(
        (left, right) =>
          left.priorityIndex - right.priorityIndex ||
          left.key.localeCompare(right.key),
      ),
    ),
    solverNodes,
    solverExhausted,
  } as const;
}

/**
 * Selects the current V6 page only from a partition that leaves every later
 * page with nine archives below the immutable selection-bundle byte limit.
 * Candidate order is already HMAC-randomized; capacity affects it only when
 * that preferred prefix cannot be partitioned.
 */
export function planNativeTemplateCapacityPages(input: {
  candidates: readonly NativeTemplateCapacityCandidate[];
  pageCount: number;
  pageSize?: number;
  maxPageBytes?: number;
  currentBinIndex?: number;
  nodeBudget?: number;
}): NativeTemplateCapacityPlan {
  const pageSize = input.pageSize ?? SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE;
  const maxPageBytes =
    input.maxPageBytes ?? NATIVE_TEMPLATE_PAGE_ARCHIVE_BUDGET_BYTES;
  const required = input.pageCount * pageSize;
  const unique = new Map<string, NativeTemplateCapacityCandidate>();
  let rejectedOversize = 0;
  for (const candidate of input.candidates) {
    if (unique.has(candidate.key)) continue;
    const archiveBytes = Math.max(0, Math.trunc(candidate.archiveBytes));
    if (archiveBytes > maxPageBytes) {
      rejectedOversize += 1;
      continue;
    }
    unique.set(candidate.key, { ...candidate, archiveBytes });
  }
  const usable = [...unique.values()].sort(
    (left, right) =>
      left.priorityIndex - right.priorityIndex ||
      left.key.localeCompare(right.key),
  );
  const failed = (inputValues: {
    solverNodes: number;
    solverExhausted: boolean;
  }): NativeTemplateCapacityPlan => ({
    feasible: false,
    bins: [],
    current: [],
    required,
    usable: usable.length,
    rejectedOversize,
    ...inputValues,
  });
  if (usable.length < required || input.pageCount < 1 || pageSize < 1) {
    return failed({ solverNodes: 0, solverExhausted: false });
  }

  const nodeBudget =
    input.nodeBudget ?? NATIVE_TEMPLATE_CAPACITY_SOLVER_NODE_BUDGET;
  let solverNodes = 0;
  let solverExhausted = false;
  const preferred = usable.slice(0, required);
  let partition = partitionNativeTemplateCapacity({
    candidates: preferred,
    pageCount: input.pageCount,
    pageSize,
    maxPageBytes,
    nodeBudget,
  });
  solverNodes += partition.solverNodes;
  solverExhausted ||= partition.solverExhausted;

  if (!partition.bins) {
    const capacityFirst = [...usable]
      .sort(
        (left, right) =>
          left.archiveBytes - right.archiveBytes ||
          left.priorityIndex - right.priorityIndex ||
          left.key.localeCompare(right.key),
      )
      .slice(0, required);
    if (
      capacityFirst.some(
        (candidate, index) => candidate.key !== preferred[index]?.key,
      )
    ) {
      partition = partitionNativeTemplateCapacity({
        candidates: capacityFirst,
        pageCount: input.pageCount,
        pageSize,
        maxPageBytes,
        nodeBudget: Math.max(1, nodeBudget - solverNodes),
      });
      solverNodes += partition.solverNodes;
      solverExhausted ||= partition.solverExhausted;
    }
  }
  if (!partition.bins) return failed({ solverNodes, solverExhausted });

  const currentBinIndex =
    Math.abs(Math.trunc(input.currentBinIndex ?? 0)) % partition.bins.length;
  return {
    feasible: true,
    bins: partition.bins,
    current: partition.bins[currentBinIndex]!,
    required,
    usable: usable.length,
    rejectedOversize,
    solverNodes,
    solverExhausted,
  };
}

function nativeTemplatePoolGenerationKey(input: {
  context: TwentyFirstProviderContext;
  credentialId: string;
  credentialVersion: number;
}) {
  return canonicalSha256({
    schemaVersion: 1,
    projectId: input.context.project.id,
    taskStartedAt: input.context.project.currentTaskStartedAt.toISOString(),
    knowledgeSnapshotId: input.context.snapshot.id,
    credentialId: input.credentialId,
    credentialVersion: input.credentialVersion,
    renderer: "twenty_first_native_template_v1",
  });
}

function nativeTemplatePoolSeed(input: {
  shuffleKey: Buffer;
  generationKey: string;
}) {
  return createHmac("sha256", input.shuffleKey)
    .update("frontmind:siteops:21st-template-v6:pool-seed")
    .update("\0")
    .update(input.generationKey)
    .digest("hex");
}

async function persistDefaultNativeTemplatePool(
  db: any,
  input: NativeTemplatePoolPersistenceInput,
) {
  return db.transaction(
    async (tx: any): Promise<{ poolId: string; created: boolean }> => {
      const projectRows = await tx
        .select()
        .from(siteProjects)
        .where(
          and(
            eq(siteProjects.id, input.context.project.id),
            eq(siteProjects.userId, input.operation.userId),
          ),
        )
        .limit(1)
        .for("update");
      const project = projectRows[0];
      if (
        !project ||
        project.currentKnowledgeSnapshotId !== input.context.snapshot.id ||
        project.currentTaskStartedAt.getTime() !==
          input.context.project.currentTaskStartedAt.getTime() ||
        project.revision !== input.context.project.revision
      ) {
        throw visualSearchSuperseded();
      }

      const existingRows = await tx
        .select({ id: visualCandidatePools.id })
        .from(visualCandidatePools)
        .where(eq(visualCandidatePools.generationKey, input.generationKey))
        .limit(1)
        .for("update");
      if (existingRows[0]) {
        return { poolId: existingRows[0].id, created: false };
      }

      const activeRows = await tx
        .select({
          id: visualCandidatePools.id,
          generationKey: visualCandidatePools.generationKey,
        })
        .from(visualCandidatePools)
        .where(
          and(
            eq(visualCandidatePools.projectId, project.id),
            eq(visualCandidatePools.userId, input.operation.userId),
            eq(
              visualCandidatePools.taskStartedAt,
              input.context.project.currentTaskStartedAt,
            ),
            eq(visualCandidatePools.status, "active"),
          ),
        )
        .limit(1)
        .for("update");
      if (activeRows[0]) throw visualSearchSuperseded();

      const operationRows = await tx
        .select()
        .from(siteOperations)
        .where(eq(siteOperations.id, input.operation.id))
        .limit(1)
        .for("update");
      const leasedOperation = operationRows[0];
      if (
        !leasedOperation ||
        leasedOperation.status !== "running" ||
        !input.operation.leaseOwner ||
        leasedOperation.leaseOwner !== input.operation.leaseOwner ||
        !leasedOperation.leaseExpiresAt ||
        leasedOperation.leaseExpiresAt.getTime() <= Date.now() ||
        leasedOperation.projectId !== project.id ||
        leasedOperation.userId !== input.operation.userId ||
        leasedOperation.kind !== "visual_search" ||
        leasedOperation.provider !== "21st"
      ) {
        throw visualSearchSuperseded();
      }

      await tx.insert(visualCandidatePools).values({
        id: input.poolId,
        projectId: project.id,
        userId: input.operation.userId,
        knowledgeSnapshotId: input.context.snapshot.id,
        credentialId: input.credentialId,
        credentialVersion: input.credentialVersion,
        initialOperationId: input.operation.id,
        generationKey: input.generationKey,
        taskStartedAt: input.context.project.currentTaskStartedAt,
        projectRevision: input.context.project.revision,
        seed: input.seed,
        catalogFingerprint: input.catalogFingerprint,
        queryPlanHash: input.queryPlanHash,
        manifestLocalAssetId: input.manifestArtifact.id,
        manifestHash: input.manifestArtifact.contentSha256,
        pageCount: input.pages.length,
        candidateCount: input.pages.length * SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
        status: "active",
      });
      await tx.insert(visualCandidatePoolPages).values(
        input.pages.map((page) => ({
          id: page.id,
          poolId: input.poolId,
          pageNumber: page.pageNumber,
          status: "reserved",
          selectionBundleLocalAssetId: page.selectionBundleArtifact.id,
          selectionBundleHash: page.selectionBundleArtifact.contentSha256,
          candidateCount: SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
          bundleSizeBytes: page.selectionBundleSizeBytes,
          batchId: null,
          publishedOperationId: null,
          publishedAt: null,
        })),
      );
      await tx.insert(visualCandidatePoolItems).values(
        input.pages.flatMap((page) =>
          page.items.map((item) => ({
            ...item,
            poolPageId: page.id,
          })),
        ),
      );
      return { poolId: input.poolId, created: true };
    },
  );
}

async function loadDefaultNativeTemplatePoolState(input: {
  db: any;
  operation: SiteOperation;
  context: TwentyFirstProviderContext;
  credentialId: string;
  credentialVersion: number;
  workflowVersion: string;
  page: 1 | 2 | 3;
}): Promise<NativeTemplatePoolState | null> {
  const poolRows = await input.db
    .select()
    .from(visualCandidatePools)
    .where(
      and(
        eq(visualCandidatePools.projectId, input.context.project.id),
        eq(visualCandidatePools.userId, input.operation.userId),
        eq(visualCandidatePools.knowledgeSnapshotId, input.context.snapshot.id),
        eq(visualCandidatePools.credentialId, input.credentialId),
        eq(visualCandidatePools.credentialVersion, input.credentialVersion),
        eq(
          visualCandidatePools.taskStartedAt,
          input.context.project.currentTaskStartedAt,
        ),
        eq(visualCandidatePools.status, "active"),
      ),
    )
    .limit(1);
  const pool = poolRows[0];
  if (!pool) return null;
  const initialOperationRows = await input.db
    .select({ input: siteOperations.input })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.id, pool.initialOperationId),
        eq(siteOperations.projectId, input.context.project.id),
        eq(siteOperations.userId, input.operation.userId),
        eq(siteOperations.kind, "visual_search"),
        eq(siteOperations.provider, "21st"),
      ),
    )
    .limit(1);
  const initialOperationInput = visualSearchOperationInputSchema.safeParse(
    initialOperationRows[0]?.input,
  );
  if (
    !initialOperationInput.success ||
    initialOperationInput.data.workflowVersion !== input.workflowVersion
  ) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_POOL_WORKFLOW_MISMATCH",
      "冻结候选池与当前建站工作流不一致，请重置后重新检索。",
      "attention_required",
    );
  }
  const pages = await input.db
    .select()
    .from(visualCandidatePoolPages)
    .where(eq(visualCandidatePoolPages.poolId, pool.id));
  const inPoolPublished = pages.filter(
    (row: { status: string }) => row.status === "published",
  ).length;
  const legacyPublished = Math.max(
    0,
    (input.context.publishedPageCount ?? 0) - inPoolPublished,
  );
  const availablePages = Math.min(
    SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
    legacyPublished + pages.length,
  );
  const reservedPages = pages.filter(
    (row: { status: string }) => row.status === "reserved",
  ).length;
  const page = pages.find(
    (row: { pageNumber: number; status: string }) =>
      row.pageNumber === input.page && row.status === "reserved",
  );
  const items = page
    ? await input.db
        .select()
        .from(visualCandidatePoolItems)
        .where(eq(visualCandidatePoolItems.poolPageId, page.id))
        .orderBy(visualCandidatePoolItems.position)
    : [];
  return {
    poolId: pool.id,
    pageCount: pages.length,
    availablePages,
    reservedPages,
    page: page
      ? {
          pageNumber: page.pageNumber as 1 | 2 | 3,
          selectionBundleLocalAssetId: page.selectionBundleLocalAssetId,
          selectionBundleHash: page.selectionBundleHash,
          items: items.map(
            (item: typeof visualCandidatePoolItems.$inferSelect) => ({
              id: item.id,
              sampleId: item.sampleId,
              position: item.position,
              previewLocalAssetId: item.previewLocalAssetId,
              previewSha256: item.previewSha256,
              sourceTreeSha256: item.sourceTreeSha256,
              providerTemplateId: item.providerTemplateId,
              providerSlug: item.providerSlug,
              providerVersion: item.providerVersion,
              providerItemKey: item.providerItemKey,
            }),
          ),
        }
      : null,
  };
}

async function storedSiteOpsArtifactBytes(input: {
  artifact: NonNullable<Awaited<ReturnType<typeof readSiteOpsArtifact>>>;
  expectedSha256: string;
}) {
  const maxBytes = VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES;
  if (
    input.artifact.stored.sizeBytes < 1 ||
    input.artifact.stored.sizeBytes > maxBytes
  ) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_POOL_ARTIFACT_INVALID",
      "冻结的视觉候选页大小无效。",
      "attention_required",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input.artifact.stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > input.artifact.stored.sizeBytes || total > maxBytes) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_CANDIDATE_POOL_ARTIFACT_INVALID",
        "冻结的视觉候选页读取结果不一致。",
        "attention_required",
      );
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== input.artifact.stored.sizeBytes ||
    sha256Buffer(bytes) !== input.expectedSha256
  ) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_POOL_ARTIFACT_INVALID",
      "冻结的视觉候选页未通过哈希校验。",
      "attention_required",
    );
  }
  return bytes;
}

async function restoreNativeTemplatePoolPage(input: {
  operation: SiteOperation;
  page: NonNullable<NativeTemplatePoolState["page"]>;
  readArtifact: typeof readSiteOpsArtifact;
}) {
  const artifact = await input.readArtifact({
    userId: input.operation.userId,
    localAssetId: input.page.selectionBundleLocalAssetId,
    expectedSha256: input.page.selectionBundleHash,
    expectedMimeTypes: [VISUAL_SELECTION_BUNDLE_V6_MIME_TYPE],
  });
  if (!artifact) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_POOL_ARTIFACT_MISSING",
      "冻结的视觉候选页暂时无法读取。",
      "attention_required",
    );
  }
  const bytes = await storedSiteOpsArtifactBytes({
    artifact,
    expectedSha256: input.page.selectionBundleHash,
  });
  const restored = await readVisualSelectionBundleArtifact(bytes);
  if (restored.bundle.schemaVersion !== 6) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_POOL_ARTIFACT_INVALID",
      "冻结的视觉候选页版本无效。",
      "attention_required",
    );
  }
  if (
    restored.bundle.candidates.some(
      (candidate) =>
        candidate.sourceFormat !== "normalized_v1" &&
        candidate.sourceFormat !== "provider_archive_v1",
    )
  ) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_POOL_ARTIFACT_INVALID",
      "冻结的完整 Template 源码格式无效。",
      "attention_required",
    );
  }
  const orderedItems = [...input.page.items].sort(
    (left, right) => left.position - right.position,
  );
  const itemManifestValid =
    orderedItems.length === SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE &&
    restored.bundle.candidates.length === SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE &&
    restored.bundle.candidates.every((candidate, position) => {
      const item = orderedItems[position];
      return (
        item?.position === position &&
        item.sampleId === candidate.sampleId &&
        item.previewLocalAssetId === candidate.previewLocalAssetId &&
        item.previewSha256 === candidate.previewSha256 &&
        item.sourceTreeSha256 === candidate.sourceTreeSha256 &&
        item.providerTemplateId === candidate.providerTemplateId &&
        item.providerSlug === candidate.providerSlug &&
        item.providerVersion === candidate.providerVersion &&
        item.providerItemKey ===
          nativeTemplateProviderKey({
            templateId: candidate.providerTemplateId,
            slug: candidate.providerSlug,
          }) &&
        restored.archives.has(candidate.sampleId)
      );
    });
  if (!itemManifestValid) {
    throw new TwentyFirstProviderFailure(
      "VISUAL_CANDIDATE_POOL_ITEM_MISMATCH",
      "冻结的视觉候选页引用校验失败。",
      "attention_required",
    );
  }
  const candidates: NativeTemplateBoardCandidate[] =
    restored.bundle.candidates.map((candidate) => ({
      sampleId: candidate.sampleId,
      optionLabel: candidate.label,
      providerTemplateId: candidate.providerTemplateId,
      providerSlug: candidate.providerSlug,
      providerVersion: candidate.providerVersion,
      providerItemKey: nativeTemplateProviderKey({
        templateId: candidate.providerTemplateId,
        slug: candidate.providerSlug,
      }),
      title: candidate.title,
      description: candidate.description,
      author: candidate.author,
      previewLocalAssetId: candidate.previewLocalAssetId,
      previewSha256: candidate.previewSha256,
      previewPerceptualHash:
        candidate.previewPerceptualHash ?? candidate.previewSha256.slice(0, 16),
      styleTokens: candidate.styleTokens,
      sourceFormat: candidate.sourceFormat,
      framework: candidate.framework,
      sourceTreeSha256: candidate.sourceTreeSha256,
      sourceArchiveSha256: candidate.sourceArchiveSha256,
      sourceArchive: restored.archives.get(candidate.sampleId)!,
      sourceDirectory: candidate.sourceDirectory,
      entrypoint: candidate.entrypoint,
    }));
  return {
    selectionBundle: restored.bundle,
    selectionBundleArtifact: {
      id: artifact.row.id,
      contentSha256: artifact.row.contentSha256,
    },
    candidates,
  };
}

function logSafeNativeTemplateStage(input: {
  event:
    | "template_catalog"
    | "template_download"
    | "template_prepare"
    | "template_page_published";
  operationId: string;
  projectId: string;
  page: 1 | 2 | 3;
  diagnostics: VisualSearchDiagnostics;
  latencyMs: number;
}) {
  console.info("[SiteOps21st] native_template_stage", {
    event: input.event,
    operationId: input.operationId,
    projectId: input.projectId,
    page: input.page,
    catalogCandidates: input.diagnostics.catalogCandidates,
    templateDownloadAttempts: input.diagnostics.templateDownloadAttempts,
    templateDownloadsSucceeded: input.diagnostics.templateDownloadsSucceeded,
    dependencyResolutionAttempts:
      input.diagnostics.dependencyResolutionAttempts,
    sourcePreparationAttempts: input.diagnostics.sourcePreparationAttempts,
    sourcePrepared: input.diagnostics.sourcePrepared,
    previewFetchAttempts: input.diagnostics.previewFetchAttempts,
    compileAttempts: input.diagnostics.compileAttempts,
    compileSucceeded: input.diagnostics.compileSucceeded,
    renderAttempts: input.diagnostics.renderAttempts,
    renderSucceeded: input.diagnostics.renderSucceeded,
    capacityCandidates: input.diagnostics.capacityCandidates,
    capacityRequired: input.diagnostics.capacityRequired,
    targetRequired: input.diagnostics.targetRequired,
    minimumRequired: input.diagnostics.minimumRequired,
    downloaded: input.diagnostics.downloaded,
    normalized: input.diagnostics.normalized,
    compiled: input.diagnostics.compiled,
    rendered: input.diagnostics.rendered,
    sourceUnsafe: input.diagnostics.sourceUnsafe,
    dependencyUnsupported: input.diagnostics.dependencyUnsupported,
    capacityPages: input.diagnostics.capacityPages,
    capacitySelected: input.diagnostics.capacitySelected,
    capacityRejectedOversize: input.diagnostics.capacityRejectedOversize,
    capacitySolverNodes: input.diagnostics.capacitySolverNodes,
    capacitySolverExhausted: input.diagnostics.capacitySolverExhausted,
    publishedCount: input.diagnostics.publishedCount,
    failureCategory: input.diagnostics.templateFailureCategory,
    failureCounts: input.diagnostics.templateRejectedByReason,
    latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
  });
}

function templateCatalogFailure(error: unknown) {
  if (error instanceof TwentyFirstNativeTemplateError) {
    if (error.category === "plan_ineligible") return "entitlement_required";
    if (error.category === "download_unavailable") return "download_failed";
  }
  return "catalog_unavailable";
}

function templateDownloadFailure(error: unknown) {
  if (
    error instanceof TwentyFirstNativeTemplateError &&
    error.category === "plan_ineligible"
  ) {
    return "entitlement_required" as const;
  }
  return "download_failed" as const;
}

async function runNativeTemplateVisualSearch(input: {
  operation: SiteOperation;
  signal: AbortSignal;
  assertLeaseActive?: () => Promise<void>;
  client: Pick<
    TwentyFirstClient,
    "listNativeTemplates" | "downloadNativeTemplate"
  >;
  apiKey: string;
  credentialId: string;
  credentialVersion: number;
  context: TwentyFirstProviderContext;
  searchPlan: ResolvedVisualSearchPlan;
  diagnostics: VisualSearchDiagnostics;
  prepareCandidate: typeof prepareNativeTemplateCandidate;
  shuffleKey: Buffer;
  fetchPreview: typeof fetchSafeVisualPreview;
  persistArtifact: typeof persistSiteOpsArtifact;
  persistBoard: (
    db: any,
    input: TwentyFirstBoardPersistenceInput,
  ) => Promise<ExistingBoard>;
  persistCandidatePool?: (
    db: any,
    input: NativeTemplatePoolPersistenceInput,
  ) => Promise<{ poolId: string; created: boolean }>;
  db: any;
}) {
  const startedAt = Date.now();
  input.diagnostics.templateMode = true;
  const generationKey = nativeTemplatePoolGenerationKey({
    context: input.context,
    credentialId: input.credentialId,
    credentialVersion: input.credentialVersion,
  });
  const poolSeed = nativeTemplatePoolSeed({
    shuffleKey: input.shuffleKey,
    generationKey,
  });
  const priorProviderKeys = new Set(
    input.context.previousReferences?.providerItemKeys ?? [],
  );
  const priorTemplateIds = new Set(
    input.context.previousReferences?.providerTemplateIds ?? [],
  );
  const priorTemplateSlugs = new Set(
    input.context.previousReferences?.providerTemplateSlugs ?? [],
  );
  const priorSourceTrees = new Set(
    input.context.previousReferences?.sourceTreeSha256s ?? [],
  );
  const priorPreviewHashes = new Set(
    input.context.previousReferences?.nativePreviewSha256s ?? [],
  );

  let catalog: TwentyFirstNativeTemplateSummary[];
  try {
    const catalogSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(NATIVE_TEMPLATE_CATALOG_TIMEOUT_MS),
    ]);
    catalog = await input.client.listNativeTemplates(input.apiKey, {
      limit: NATIVE_TEMPLATE_CATALOG_DISCOVERY_LIMIT,
      signal: catalogSignal,
      excludeTemplateIds: [...priorTemplateIds],
      excludeSlugs: [...priorTemplateSlugs],
    });
  } catch (error) {
    const category = input.signal.aborted
      ? "deadline_exhausted"
      : templateCatalogFailure(error);
    rejectNativeTemplate(input.diagnostics, category);
    throw nativeTemplateProviderFailure(category);
  }

  const uniqueCatalog = new Map<string, TwentyFirstNativeTemplateSummary>();
  const catalogTemplateIds = new Set<string>();
  const catalogSlugs = new Set<string>();
  for (const template of catalog) {
    // listNativeTemplates has already projected only verified, hosted,
    // immutable Marketplace source coordinates with an allowed OSS license.
    // Customer knowledge never participates in this catalog or its ordering.
    const key = nativeTemplateProviderKey(template);
    const templateId = String(template.templateId);
    if (
      priorProviderKeys.has(key) ||
      priorTemplateIds.has(templateId) ||
      priorTemplateSlugs.has(template.slug) ||
      uniqueCatalog.has(key) ||
      catalogTemplateIds.has(templateId) ||
      catalogSlugs.has(template.slug)
    ) {
      continue;
    }
    catalogTemplateIds.add(templateId);
    catalogSlugs.add(template.slug);
    uniqueCatalog.set(key, template);
  }
  const catalogWindow = [...uniqueCatalog.values()].slice(
    0,
    NATIVE_TEMPLATE_PREPARATION_LIMIT,
  );
  input.diagnostics.catalogCandidates = catalogWindow.length;
  input.diagnostics.downloaded = input.diagnostics.templateDownloadsSucceeded;
  input.diagnostics.normalized = input.diagnostics.sourcePrepared;
  input.diagnostics.compiled = input.diagnostics.sourcePrepared;
  input.diagnostics.rendered = input.diagnostics.sourcePrepared;
  logSafeNativeTemplateStage({
    event: "template_catalog",
    operationId: input.operation.id,
    projectId: input.operation.projectId,
    page: input.searchPlan.page,
    diagnostics: input.diagnostics,
    latencyMs: Date.now() - startedAt,
  });
  if (catalogWindow.length < SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE) {
    rejectNativeTemplate(input.diagnostics, "insufficient_live_templates");
    throw nativeTemplateProviderFailure("insufficient_live_templates");
  }

  const ordered = deterministicallyShuffleTemplates({
    templates: catalogWindow,
    hmacKey: input.shuffleKey,
    seed: poolSeed,
  });
  const orderedPriority = new Map(
    ordered.map((summary, priorityIndex) => [
      nativeTemplateProviderKey(summary),
      priorityIndex,
    ]),
  );
  const available: Array<{
    summary: TwentyFirstNativeTemplateSummary;
    prepared: PreparedNativeTemplateCandidate;
    perceptualHash: string;
  }> = [];
  const availableProviderKeys = new Set<string>();
  const availableSourceTrees = new Set(priorSourceTrees);
  const availablePreviewHashes = new Set(priorPreviewHashes);

  for (
    let offset = 0;
    offset < ordered.length;
    offset += NATIVE_TEMPLATE_BATCH_CONCURRENCY
  ) {
    if (input.signal.aborted) {
      rejectNativeTemplate(input.diagnostics, "deadline_exhausted");
      throw nativeTemplateProviderFailure("deadline_exhausted");
    }
    await assertCommitLeaseActive(input.assertLeaseActive);
    const batch = ordered.slice(
      offset,
      offset + NATIVE_TEMPLATE_BATCH_CONCURRENCY,
    );
    const results = await Promise.all(
      batch.map(async (summary) => {
        let archive: Awaited<
          ReturnType<TwentyFirstClient["downloadNativeTemplate"]>
        > | null = null;
        let finalDownloadError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          input.diagnostics.templateDownloadAttempts += 1;
          try {
            archive = await input.client.downloadNativeTemplate(input.apiKey, {
              templateId: summary.templateId,
              slug: summary.slug,
              version: summary.version,
              sourceOwner: summary.sourceOwner,
              sourceRepo: summary.sourceRepo,
              sourceCommitSha: summary.sourceCommitSha,
              sourceSubdirectory: summary.sourceSubdirectory,
              sourceLicense: summary.sourceLicense,
              signal: AbortSignal.any([
                input.signal,
                AbortSignal.timeout(NATIVE_TEMPLATE_DOWNLOAD_TIMEOUT_MS),
              ]),
            });
            input.diagnostics.templateDownloadsSucceeded += 1;
            break;
          } catch (error) {
            finalDownloadError = error;
            const mayRetry =
              attempt === 0 &&
              !input.signal.aborted &&
              error instanceof TwentyFirstNativeTemplateError &&
              error.category === "download_unavailable" &&
              error.retryable;
            if (!mayRetry) break;
          }
        }
        if (!archive) {
          const category = input.signal.aborted
            ? "deadline_exhausted"
            : templateDownloadFailure(finalDownloadError);
          rejectNativeTemplate(input.diagnostics, category);
          return null;
        }

        input.diagnostics.sourcePreparationAttempts += 1;
        input.diagnostics.previewFetchAttempts += 1;
        try {
          const prepared = await input.prepareCandidate({
            templateId: archive.templateId,
            slug: archive.slug,
            version: archive.version,
            archive: archive.archive,
            expectedArchiveSha256: archive.sha256,
            sourceSubdirectory: summary.sourceSubdirectory,
            previewUrl: summary.previewUrl,
            signal: AbortSignal.any([
              input.signal,
              AbortSignal.timeout(NATIVE_TEMPLATE_PREPARE_TIMEOUT_MS),
            ]),
            fetchRemoteAsset: input.fetchPreview,
          });
          input.diagnostics.sourcePrepared += 1;
          const perceptualHash = await perceptualHash64(prepared.preview);
          return { summary, prepared, perceptualHash };
        } catch (error) {
          const runtimeCategory = input.signal.aborted
            ? "deadline_exhausted"
            : classifyNativeTemplateRuntimeFailure(error);
          if (runtimeCategory === "source_unsafe") {
            input.diagnostics.sourceUnsafe += 1;
          }
          if (runtimeCategory === "dependency_unsupported") {
            input.diagnostics.dependencyUnsupported += 1;
          }
          rejectNativeTemplate(
            input.diagnostics,
            publicTemplateRuntimeCategory(runtimeCategory),
          );
          return null;
        }
      }),
    );
    for (const result of results) {
      if (!result) continue;
      const providerKey = nativeTemplateProviderKey(result.summary);
      if (
        availableProviderKeys.has(providerKey) ||
        availableSourceTrees.has(result.prepared.sourceTreeSha256) ||
        availablePreviewHashes.has(result.prepared.previewSha256)
      ) {
        continue;
      }
      availableProviderKeys.add(providerKey);
      availableSourceTrees.add(result.prepared.sourceTreeSha256);
      availablePreviewHashes.add(result.prepared.previewSha256);
      available.push(result);
    }
  }

  input.diagnostics.downloaded = input.diagnostics.templateDownloadsSucceeded;
  input.diagnostics.normalized = input.diagnostics.sourcePrepared;
  input.diagnostics.compiled = input.diagnostics.sourcePrepared;
  input.diagnostics.rendered = input.diagnostics.sourcePrepared;
  logSafeNativeTemplateStage({
    event: "template_download",
    operationId: input.operation.id,
    projectId: input.operation.projectId,
    page: input.searchPlan.page,
    diagnostics: input.diagnostics,
    latencyMs: Date.now() - startedAt,
  });
  logSafeNativeTemplateStage({
    event: "template_prepare",
    operationId: input.operation.id,
    projectId: input.operation.projectId,
    page: input.searchPlan.page,
    diagnostics: input.diagnostics,
    latencyMs: Date.now() - startedAt,
  });
  const pagesRemaining =
    SITEOPS_VISUAL_CANDIDATE_MAX_PAGES - input.searchPlan.page + 1;
  const binDigest = createHmac("sha256", input.shuffleKey)
    .update("frontmind:siteops:21st-template-v6:capacity-bin")
    .update("\0")
    .update(poolSeed)
    .digest();
  const capacityCandidates = available.map(({ summary, prepared }) => {
    const key = nativeTemplateProviderKey(summary);
    return {
      key,
      archiveBytes: prepared.sourceArchive.length,
      priorityIndex: orderedPriority.get(key) ?? Number.MAX_SAFE_INTEGER,
    };
  });
  let capacityPlan: NativeTemplateCapacityPlan | null = null;
  let capacitySolverNodes = 0;
  let capacitySolverExhausted = false;
  for (let pageCount = pagesRemaining; pageCount >= 1; pageCount -= 1) {
    const candidatePlan = planNativeTemplateCapacityPages({
      candidates: capacityCandidates,
      pageCount,
      currentBinIndex: binDigest.readUInt32BE(0) % pageCount,
    });
    capacitySolverNodes += candidatePlan.solverNodes;
    capacitySolverExhausted ||= candidatePlan.solverExhausted;
    if (candidatePlan.feasible) {
      capacityPlan = candidatePlan;
      break;
    }
  }
  input.diagnostics.capacityCandidates = capacityCandidates.filter(
    (candidate) =>
      candidate.archiveBytes <= NATIVE_TEMPLATE_PAGE_ARCHIVE_BUDGET_BYTES,
  ).length;
  input.diagnostics.capacityRequired =
    pagesRemaining * SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE;
  input.diagnostics.targetRequired = SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL;
  input.diagnostics.minimumRequired = SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE;
  input.diagnostics.capacityPages = capacityPlan?.bins.length ?? 0;
  input.diagnostics.capacitySelected = capacityPlan?.current.length ?? 0;
  input.diagnostics.capacityRejectedOversize =
    capacityPlan?.rejectedOversize ?? 0;
  input.diagnostics.capacitySolverNodes = capacitySolverNodes;
  input.diagnostics.capacitySolverExhausted = capacitySolverExhausted;
  if (!capacityPlan) {
    rejectNativeTemplate(input.diagnostics, "insufficient_live_templates");
    throw nativeTemplateProviderFailure("insufficient_live_templates");
  }
  const availableByKey = new Map(
    available.map((candidate) => [
      nativeTemplateProviderKey(candidate.summary),
      candidate,
    ]),
  );
  const poolQueryPlanHash = canonicalSha256({
    schemaVersion: 6,
    generationKey,
    seed: poolSeed,
    firstPage: input.searchPlan.page,
    pageCount: capacityPlan.bins.length,
    templates: ordered.map((template) => ({
      templateId: String(template.templateId),
      slug: template.slug,
      version: template.version,
    })),
  });
  const currentBinIndex = binDigest.readUInt32BE(0) % capacityPlan.bins.length;
  const orderedBins = [
    ...capacityPlan.bins.slice(currentBinIndex),
    ...capacityPlan.bins.slice(0, currentBinIndex),
  ];
  const frozenPages: Array<{
    id: string;
    pageNumber: 1 | 2 | 3;
    candidates: NativeTemplateBoardCandidate[];
    selectionBundle: VisualSelectionBundleV6;
    selectionBundleArtifact: PreviewArtifact;
    selectionBundleSizeBytes: number;
  }> = [];

  for (let pageOffset = 0; pageOffset < orderedBins.length; pageOffset += 1) {
    const pageNumber = (input.searchPlan.page + pageOffset) as 1 | 2 | 3;
    const accepted = orderedBins[pageOffset]!.map((candidate) =>
      availableByKey.get(candidate.key),
    );
    if (
      accepted.length !== SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE ||
      accepted.some((candidate) => !candidate)
    ) {
      rejectNativeTemplate(input.diagnostics, "insufficient_live_templates");
      throw nativeTemplateProviderFailure("insufficient_live_templates");
    }

    await assertCommitLeaseActive(input.assertLeaseActive);
    const nativeCandidates: NativeTemplateBoardCandidate[] = [];
    for (let index = 0; index < accepted.length; index += 1) {
      const { summary, prepared, perceptualHash } = accepted[index]!;
      const sampleId = randomUUID();
      const optionLabel = String.fromCharCode(65 + index);
      const previewAsset = await input.persistArtifact({
        userId: input.operation.userId,
        projectId: input.context.project.id,
        kind: "21st-native-template-preview",
        filename: `21st-template-p${pageNumber}-${optionLabel.toLowerCase()}.png`,
        mimeType: "image/png",
        buffer: prepared.preview,
        maxBytes: 5 * 1024 * 1024,
      });
      if (previewAsset.contentSha256 !== prepared.previewSha256) {
        throw new TwentyFirstProviderFailure(
          "NATIVE_TEMPLATE_PREVIEW_HASH_MISMATCH",
          "完整 Template 预览写入校验失败。",
          "attention_required",
        );
      }
      nativeCandidates.push({
        sampleId,
        optionLabel,
        providerTemplateId: String(summary.templateId),
        providerSlug: summary.slug,
        providerVersion: prepared.providerVersion,
        providerItemKey: prepared.providerItemKey,
        title: cleanText(summary.name, `Template ${optionLabel}`, 300),
        description: null,
        author: null,
        previewLocalAssetId: previewAsset.id,
        previewSha256: prepared.previewSha256,
        previewPerceptualHash: perceptualHash,
        styleTokens: prepared.styleTokens,
        sourceFormat: prepared.sourceFormat,
        framework: prepared.framework,
        sourceTreeSha256: prepared.sourceTreeSha256,
        sourceArchiveSha256: prepared.sourceArchiveSha256,
        sourceArchive: prepared.sourceArchive,
        sourceDirectory: prepared.sourceDirectory,
        entrypoint: prepared.entrypoint,
      });
    }

    const selectionBundle = visualSelectionBundleV6Schema.parse({
      schemaVersion: 6,
      renderer: "twenty_first_native_template_v1",
      queryPlanHash: canonicalSha256({
        poolQueryPlanHash,
        page: pageNumber,
        candidates: nativeCandidates.map(
          (candidate) => candidate.providerItemKey,
        ),
      }),
      displayTarget: 9,
      candidates: nativeCandidates.map((candidate) => ({
        id: candidate.sampleId,
        sampleId: candidate.sampleId,
        label: candidate.optionLabel,
        title: candidate.title,
        description: candidate.description,
        author: candidate.author,
        previewLocalAssetId: candidate.previewLocalAssetId,
        previewSha256: candidate.previewSha256,
        previewPerceptualHash: candidate.previewPerceptualHash,
        styleTokens: candidate.styleTokens,
        providerTemplateId: candidate.providerTemplateId,
        providerSlug: candidate.providerSlug,
        providerVersion: candidate.providerVersion,
        sourceFormat: candidate.sourceFormat,
        framework: candidate.framework,
        sourceTreeSha256: candidate.sourceTreeSha256,
        sourceArchiveSha256: candidate.sourceArchiveSha256,
        sourceArchivePath: `candidates/${candidate.optionLabel}/source.zip`,
        sourceDirectory: candidate.sourceDirectory,
        entrypoint: candidate.entrypoint,
      })),
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    });
    const selectionBuffer = await createVisualSelectionBundleV6Artifact({
      bundle: selectionBundle,
      sourceArchives: new Map(
        nativeCandidates.map((candidate) => [
          candidate.sampleId,
          candidate.sourceArchive,
        ]),
      ),
    });
    const expectedSelectionHash = sha256Buffer(selectionBuffer);
    await assertCommitLeaseActive(input.assertLeaseActive);
    const selectionBundleArtifact = await input.persistArtifact({
      userId: input.operation.userId,
      projectId: input.context.project.id,
      kind: "21st-selection-bundle",
      filename: `visual-selection-${input.operation.id}-p${pageNumber}.zip`,
      mimeType: VISUAL_SELECTION_BUNDLE_V6_MIME_TYPE,
      buffer: selectionBuffer,
      maxBytes: VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES,
    });
    if (selectionBundleArtifact.contentSha256 !== expectedSelectionHash) {
      throw new TwentyFirstProviderFailure(
        "SELECTION_BUNDLE_HASH_MISMATCH",
        "视觉选择包写入校验失败。",
        "attention_required",
      );
    }
    frozenPages.push({
      id: randomUUID(),
      pageNumber,
      candidates: nativeCandidates,
      selectionBundle,
      selectionBundleArtifact,
      selectionBundleSizeBytes: selectionBuffer.length,
    });
  }

  const poolId = randomUUID();
  let persistedPoolId: string | null = null;
  if (input.persistCandidatePool) {
    const catalogFingerprint = canonicalSha256(
      catalogWindow.map((template) => ({
        templateId: String(template.templateId),
        slug: template.slug,
        version: template.version,
      })),
    );
    const poolManifest = {
      schemaVersion: 1,
      poolId,
      generationKey,
      projectId: input.context.project.id,
      taskStartedAt: input.context.project.currentTaskStartedAt.toISOString(),
      knowledgeSnapshotId: input.context.snapshot.id,
      credentialId: input.credentialId,
      credentialVersion: input.credentialVersion,
      seed: poolSeed,
      catalogFingerprint,
      queryPlanHash: poolQueryPlanHash,
      pages: frozenPages.map((page) => ({
        page: page.pageNumber,
        selectionBundleLocalAssetId: page.selectionBundleArtifact.id,
        selectionBundleHash: page.selectionBundleArtifact.contentSha256,
        selectionBundleSizeBytes: page.selectionBundleSizeBytes,
        candidates: page.selectionBundle.candidates.map((candidate) => ({
          sampleId: candidate.sampleId,
          providerTemplateId: candidate.providerTemplateId,
          providerSlug: candidate.providerSlug,
          sourceTreeSha256: candidate.sourceTreeSha256,
          previewSha256: candidate.previewSha256,
        })),
      })),
    } as const;
    const manifestBuffer = Buffer.from(canonicalJson(poolManifest), "utf8");
    const manifestArtifact = await input.persistArtifact({
      userId: input.operation.userId,
      projectId: input.context.project.id,
      kind: "21st-candidate-pool-manifest",
      filename: `visual-candidate-pool-${poolId}.json`,
      mimeType: "application/json",
      buffer: manifestBuffer,
      maxBytes: 512_000,
    });
    if (manifestArtifact.contentSha256 !== canonicalSha256(poolManifest)) {
      throw new TwentyFirstProviderFailure(
        "VISUAL_CANDIDATE_POOL_MANIFEST_HASH_MISMATCH",
        "视觉候选池清单写入校验失败。",
        "attention_required",
      );
    }
    const persisted = await input.persistCandidatePool(input.db, {
      poolId,
      generationKey,
      operation: input.operation,
      context: input.context,
      credentialId: input.credentialId,
      credentialVersion: input.credentialVersion,
      seed: poolSeed,
      catalogFingerprint,
      queryPlanHash: poolQueryPlanHash,
      manifestArtifact,
      pages: frozenPages.map((page) => ({
        id: page.id,
        pageNumber: page.pageNumber,
        selectionBundleArtifact: page.selectionBundleArtifact,
        selectionBundleSizeBytes: page.selectionBundleSizeBytes,
        items: page.candidates.map((candidate, position) => ({
          id: randomUUID(),
          sampleId: candidate.sampleId,
          position,
          previewLocalAssetId: candidate.previewLocalAssetId,
          previewSha256: candidate.previewSha256,
          sourceTreeSha256: candidate.sourceTreeSha256,
          providerTemplateId: candidate.providerTemplateId,
          providerSlug: candidate.providerSlug,
          providerVersion: candidate.providerVersion,
          providerItemKey: candidate.providerItemKey,
        })),
      })),
    });
    if (!persisted.created) throw visualSearchSuperseded();
    persistedPoolId = persisted.poolId;
  }

  const currentPage = frozenPages[0]!;
  await assertCommitLeaseActive(input.assertLeaseActive);
  const board = await input.persistBoard(input.db, {
    operation: input.operation,
    searchPlan: input.searchPlan,
    context: input.context,
    selectionBundle: currentPage.selectionBundle,
    selectionBundleArtifact: currentPage.selectionBundleArtifact,
    mirroredCandidates: currentPage.candidates,
    ...(persistedPoolId
      ? {
          candidatePoolPage: {
            poolId: persistedPoolId,
            pageNumber: currentPage.pageNumber,
          },
        }
      : {}),
  });
  input.diagnostics.normalizedUnique = input.diagnostics.catalogCandidates;
  input.diagnostics.shortlistCount = input.diagnostics.catalogCandidates;
  input.diagnostics.mirrorAttempted = input.diagnostics.previewFetchAttempts;
  input.diagnostics.mirrorAttempts = input.diagnostics.previewFetchAttempts;
  input.diagnostics.mirrorSucceeded = input.diagnostics.sourcePrepared;
  input.diagnostics.sourceFetchAttempts =
    input.diagnostics.templateDownloadAttempts;
  input.diagnostics.sourceFetchSucceeded =
    input.diagnostics.templateDownloadsSucceeded;
  input.diagnostics.publishedCount = currentPage.candidates.length;
  input.diagnostics.templateFailureCategory = null;
  input.diagnostics.terminalReason = "complete";
  logSafeNativeTemplateStage({
    event: "template_page_published",
    operationId: input.operation.id,
    projectId: input.operation.projectId,
    page: input.searchPlan.page,
    diagnostics: input.diagnostics,
    latencyMs: Date.now() - startedAt,
  });
  return {
    status: "succeeded" as const,
    projectStatus: "awaiting_visual_selection" as const,
    result: {
      batchId: board.batchId,
      mode: input.searchPlan.mode,
      page: input.searchPlan.page,
      candidateCount: board.candidateCount,
      selectionBundleHash: board.selectionBundleHash ?? undefined,
      availablePages: Math.min(
        SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
        input.searchPlan.page - 1 + frozenPages.length,
      ),
      reservedPages: Math.max(0, frozenPages.length - 1),
      actual: {
        searched: input.diagnostics.catalogCandidates,
        shortlisted: input.diagnostics.catalogCandidates,
        mirrored: input.diagnostics.sourcePrepared,
        presented: currentPage.candidates.length,
      },
      diagnostics: input.diagnostics,
      degradedReasons: currentPage.selectionBundle.degradedReasons,
    },
    message: "9 个完整 Template 视觉候选已准备完成，请选择一个方向。",
  };
}

function staticTemplateExecutionAdmissionEvidence(
  entry: StaticTemplateCatalog["entries"][number],
): VisualSelectionBundleV7["candidates"][number]["executionAdmission"] {
  const admission = entry.executionAdmission;
  return admission.status === "admitted"
    ? {
        status: "admitted",
        rawSourceSha256: admission.binding.rawSourceSha256,
        normalizedSourceSha256: admission.normalizedSourceSha256,
        sourceTreeSha256: admission.sourceTreeSha256,
        runtimeContractSha256: admission.runtimeContractSha256,
        executionShellSha256: admission.executionShellSha256,
        deliveryContractSha256: admission.deliveryContractSha256,
        distSha256: admission.distSha256,
        qaSha256: admission.qaSha256,
        browserReceiptSha256: admission.browserReceiptSha256,
        qaStatus: admission.qaStatus,
        admissionEvidenceSha256: admission.admissionEvidenceSha256,
      }
    : {
        status: "unavailable",
        rawSourceSha256: admission.binding.rawSourceSha256,
        code: admission.code,
        reason: admission.reason,
      };
}

async function runStaticTemplateCatalogVisualSearch(input: {
  operation: SiteOperation;
  assertLeaseActive?: () => Promise<void>;
  context: TwentyFirstProviderContext;
  searchPlan: ResolvedVisualSearchPlan;
  catalog: StaticTemplateCatalog;
  persistArtifact: typeof persistSiteOpsArtifact;
  readCatalogPreview: typeof readStaticTemplateCatalogVersionPreview;
  updateStage?: (stage: VisualSearchStage) => void;
  persistBoards: (
    db: any,
    input: StaticTemplateCatalogBoardsPersistenceInput,
  ) => Promise<StaticTemplateCatalogBoardsPersistenceResult>;
  db: any;
}) {
  const frozenInput = visualSearchOperationInputSchema.parse(
    input.operation.input,
  );
  if (
    !("schemaVersion" in frozenInput) ||
    (frozenInput.schemaVersion !== 3 && frozenInput.schemaVersion !== 4) ||
    !isStaticCatalogWorkflowVersion(frozenInput.workflowVersion)
  ) {
    throw new TwentyFirstProviderFailure(
      "STATIC_TEMPLATE_CATALOG_OPERATION_INVALID",
      "固定 Template 目录任务坐标无效，请重置后重试。",
      "attention_required",
    );
  }
  const workflowVersion = frozenInput.workflowVersion;
  if (
    input.catalog.entries.length !== STATIC_TEMPLATE_CATALOG_ENTRY_COUNT ||
    input.catalog.pageSize !== STATIC_TEMPLATE_CATALOG_PAGE_SIZE ||
    input.catalog.pageCount !== STATIC_TEMPLATE_CATALOG_PAGE_COUNT
  ) {
    throw new TwentyFirstProviderFailure(
      "STATIC_TEMPLATE_CATALOG_INCOMPLETE",
      "FrontMind 固定 Template 目录不完整，请稍后重试。",
      "attention_required",
    );
  }
  const sortedEntries = [...input.catalog.entries].sort(
    (left, right) => left.order - right.order,
  );
  if (
    sortedEntries.some(
      (entry, index) =>
        entry.order !== index + 1 ||
        entry.page !==
          Math.floor(index / STATIC_TEMPLATE_CATALOG_PAGE_SIZE) + 1 ||
        entry.pageIndex !== index % STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
    )
  ) {
    throw new TwentyFirstProviderFailure(
      "STATIC_TEMPLATE_CATALOG_COORDINATES_INVALID",
      "FrontMind 固定 Template 目录坐标无效，请稍后重试。",
      "attention_required",
    );
  }

  input.updateStage?.("mirror_previews");
  const stagedRetainUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const mirroredPreviews = await mapWithBoundedConcurrency({
    values: sortedEntries,
    concurrency: 4,
    map: async (entry) => {
      let loaded: Awaited<
        ReturnType<typeof readStaticTemplateCatalogVersionPreview>
      >;
      try {
        loaded = await input.readCatalogPreview(
          input.catalog.catalogVersion,
          entry.candidateId,
        );
      } catch (error) {
        if (error instanceof StaticTemplateCatalogError) {
          throw new TwentyFirstProviderFailure(
            error.code,
            "冻结的建站模板预览资产无法读取或完整性校验失败。",
            "attention_required",
            error,
          );
        }
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_CATALOG_PREVIEW_READ_FAILED",
          "冻结的建站模板预览资产无法读取。",
          "attention_required",
          error,
        );
      }
      if (canonicalSha256(loaded.entry) !== canonicalSha256(entry)) {
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_CATALOG_CANDIDATE_COORDINATE_MISMATCH",
          "冻结的建站模板候选坐标不一致。",
          "attention_required",
        );
      }
      if (
        loaded.bytes.length !== entry.previewBytes ||
        sha256Buffer(loaded.bytes) !== entry.previewSha256
      ) {
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_CATALOG_PREVIEW_HASH_MISMATCH",
          "冻结的建站模板预览完整性校验失败。",
          "attention_required",
        );
      }
      let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
      try {
        metadata = await sharp(loaded.bytes, {
          failOn: "error",
          limitInputPixels: 40_000_000,
        }).metadata();
      } catch (error) {
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_CATALOG_PREVIEW_DECODE_FAILED",
          "冻结的建站模板预览无法解码。",
          "attention_required",
          error,
        );
      }
      const detectedMimeType =
        metadata.format === "png"
          ? "image/png"
          : metadata.format === "jpeg"
            ? "image/jpeg"
            : metadata.format === "webp"
              ? "image/webp"
              : metadata.format === "heif"
                ? "image/avif"
                : null;
      if (detectedMimeType !== entry.previewMimeType) {
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_CATALOG_PREVIEW_MIME_MISMATCH",
          "冻结的建站模板预览格式不一致。",
          "attention_required",
        );
      }
      if (
        metadata.width !== entry.previewWidth ||
        metadata.height !== entry.previewHeight
      ) {
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_CATALOG_PREVIEW_DIMENSIONS_MISMATCH",
          "冻结的建站模板预览尺寸不一致。",
          "attention_required",
        );
      }
      const extension =
        entry.previewMimeType === "image/jpeg"
          ? "jpg"
          : entry.previewMimeType.slice("image/".length);
      await assertCommitLeaseActive(input.assertLeaseActive);
      let artifact: Awaited<ReturnType<typeof persistSiteOpsArtifact>>;
      try {
        artifact = await input.persistArtifact({
          userId: input.operation.userId,
          projectId: input.context.project.id,
          kind: "static-template-preview",
          filename: `${entry.candidateId}.${extension}`,
          mimeType: entry.previewMimeType,
          buffer: loaded.bytes,
          maxBytes: entry.previewBytes,
          idempotencyKey: `v1:${input.catalog.catalogVersion}:${entry.candidateId}:${entry.previewSha256}`,
          retainUntil: stagedRetainUntil,
        });
      } catch (error) {
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_PREVIEW_PERSISTENCE_FAILED",
          "建站模板预览暂时无法安全保存。",
          "attention_required",
          error,
        );
      }
      if (artifact.contentSha256 !== entry.previewSha256) {
        throw new TwentyFirstProviderFailure(
          "STATIC_TEMPLATE_PREVIEW_PERSISTENCE_HASH_MISMATCH",
          "建站模板预览写入校验失败。",
          "attention_required",
        );
      }
      return [entry.candidateId, artifact] as const;
    },
  });
  const previewsByCandidateId = new Map(mirroredPreviews);
  if (previewsByCandidateId.size !== STATIC_TEMPLATE_CATALOG_ENTRY_COUNT) {
    throw new TwentyFirstProviderFailure(
      "STATIC_TEMPLATE_CATALOG_PREVIEW_SET_INCOMPLETE",
      "冻结的建站模板预览集合不完整。",
      "attention_required",
    );
  }

  input.updateStage?.("persist_selection_bundle");
  const pages: StaticTemplateCatalogPagePersistenceInput[] = [];
  for (
    let pageNumber = 1;
    pageNumber <= STATIC_TEMPLATE_CATALOG_PAGE_COUNT;
    pageNumber += 1
  ) {
    const entries = sortedEntries.slice(
      (pageNumber - 1) * STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
      pageNumber * STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
    );
    const candidates = entries.map(
      (entry, index): StaticTemplateBoardCandidate => ({
        sampleId: staticTemplateSampleId({
          operationId: input.operation.id,
          pageNumber,
          candidateId: entry.candidateId,
        }),
        optionLabel: String.fromCharCode(65 + index),
        catalogVersion: input.catalog.catalogVersion,
        catalogPosition: entry.order,
        catalogCandidateId: entry.candidateId,
        providerTemplateId: entry.providerTemplateId,
        providerSlug: entry.providerSlug,
        providerVersion: entry.providerVersion,
        providerItemKey: `template:${entry.providerTemplateId}:${entry.providerSlug}`,
        title: cleanText(entry.providerName, `Template ${entry.order}`, 300),
        description: entry.providerDescription
          ? cleanText(entry.providerDescription, "", 1_000) || null
          : null,
        sourceOwner: entry.sourceOwner,
        sourceRepo: entry.sourceRepo,
        sourceCommitSha: entry.sourceCommitSha,
        sourceSubdirectory: entry.sourceSubdirectory,
        sourceLicense: entry.sourceLicense,
        sourceAssetId: entry.sourceAssetId,
        sourceArchiveSha256: entry.sourceSha256,
        sourceArchiveBytes: entry.sourceBytes,
        previewAssetId: entry.previewAssetId,
        previewLocalAssetId: previewsByCandidateId.get(entry.candidateId)!.id,
        previewSha256: entry.previewSha256,
        previewMimeType: entry.previewMimeType,
        previewWidth: entry.previewWidth,
        previewHeight: entry.previewHeight,
        executionAdmission: staticTemplateExecutionAdmissionEvidence(entry),
      }),
    );
    const selectionBundle = visualSelectionBundleV7Schema.parse({
      schemaVersion: 7,
      renderer: "frontmind_static_template_catalog_v1",
      workflowVersion,
      catalogVersion: input.catalog.catalogVersion,
      pageNumber,
      pageSize: STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
      pageCount: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
      displayTarget: STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
      candidates: candidates.map((candidate) => ({
        id: candidate.sampleId,
        sampleId: candidate.sampleId,
        label: candidate.optionLabel,
        title: candidate.title,
        description: candidate.description,
        catalogVersion: candidate.catalogVersion,
        catalogPosition: candidate.catalogPosition,
        catalogCandidateId: candidate.catalogCandidateId,
        providerTemplateId: candidate.providerTemplateId,
        providerSlug: candidate.providerSlug,
        providerVersion: candidate.providerVersion,
        sourceOwner: candidate.sourceOwner,
        sourceRepo: candidate.sourceRepo,
        sourceCommitSha: candidate.sourceCommitSha,
        sourceSubdirectory: candidate.sourceSubdirectory,
        sourceLicense: candidate.sourceLicense,
        sourceAssetId: candidate.sourceAssetId,
        sourceArchiveSha256: candidate.sourceArchiveSha256,
        sourceArchiveBytes: candidate.sourceArchiveBytes,
        previewAssetId: candidate.previewAssetId,
        previewSha256: candidate.previewSha256,
        previewMimeType: candidate.previewMimeType,
        previewWidth: candidate.previewWidth,
        previewHeight: candidate.previewHeight,
        executionAdmission: candidate.executionAdmission,
      })),
      selectedCandidateId: null,
      delegated: false,
      degradedReasons: [],
    });
    const bytes = createVisualSelectionBundleV7Artifact(selectionBundle);
    await assertCommitLeaseActive(input.assertLeaseActive);
    let artifact: Awaited<ReturnType<typeof persistSiteOpsArtifact>>;
    try {
      artifact = await input.persistArtifact({
        userId: input.operation.userId,
        projectId: input.context.project.id,
        kind: "static-template-selection-bundle",
        filename: `static-template-selection-${input.operation.id}-p${pageNumber}.json`,
        mimeType: VISUAL_SELECTION_BUNDLE_V7_MIME_TYPE,
        buffer: bytes,
        maxBytes: VISUAL_SELECTION_BUNDLE_V7_MAX_BYTES,
        idempotencyKey: `v1:${input.operation.id}:page:${pageNumber}`,
        retainUntil: stagedRetainUntil,
      });
    } catch (error) {
      throw new TwentyFirstProviderFailure(
        "STATIC_TEMPLATE_SELECTION_PERSISTENCE_FAILED",
        "建站模板选择清单暂时无法安全保存。",
        "attention_required",
        error,
      );
    }
    if (artifact.contentSha256 !== sha256Buffer(bytes)) {
      throw new TwentyFirstProviderFailure(
        "STATIC_TEMPLATE_SELECTION_HASH_MISMATCH",
        "FrontMind 固定 Template 目录写入校验失败。",
        "attention_required",
      );
    }
    pages.push({
      pageNumber: pageNumber as 1 | 2 | 3 | 4,
      selectionBundle,
      selectionBundleArtifact: artifact,
      candidates,
    });
  }
  await assertCommitLeaseActive(input.assertLeaseActive);
  input.updateStage?.("persist_board");
  const board = await input.persistBoards(input.db, {
    operation: input.operation,
    searchPlan: input.searchPlan,
    context: input.context,
    catalogVersion: input.catalog.catalogVersion,
    pages,
  });
  const admittedCount = sortedEntries.filter(
    (entry) => entry.executionAdmission.status === "admitted",
  ).length;
  return {
    status: "succeeded" as const,
    projectStatus: "awaiting_visual_selection" as const,
    result: {
      batchIds: board.batchIds,
      candidateCount: board.candidateCount,
      workflowVersion,
      catalogVersion: input.catalog.catalogVersion,
      pageSize: STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
      pageCount: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
      availablePages: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
      reservedPages: 0,
      canGenerateMore: false,
      admittedCount,
      unavailableCount: STATIC_TEMPLATE_CATALOG_ENTRY_COUNT - admittedCount,
    },
    message: `32 个固定 Template 预览已准备完成；${admittedCount} 个已通过执行准入，可直接选择。`,
  };
}

export function createTwentyFirstSiteOpsProviderHandler(
  dependencies: TwentyFirstProviderDependencies = {},
): SiteOpsProviderHandler {
  const dbGetter = dependencies.getDb ?? getDb;
  const loadContext = dependencies.loadContext ?? loadDefaultContext;
  const getCredential =
    dependencies.getCredential ?? getTwentyFirstCredentialById;
  const client = dependencies.client ?? new TwentyFirstClient();
  const fetchPreview = dependencies.fetchPreview ?? fetchSafeVisualPreview;
  const renderCandidates =
    dependencies.renderCandidates ?? renderTrustedVisualCandidatePreviews;
  const prepareNativeCandidate =
    dependencies.prepareNativeCandidate ?? prepareNativeVisualCandidate;
  const prepareTemplateCandidate =
    dependencies.prepareNativeTemplateCandidate ??
    prepareNativeTemplateCandidate;
  const prepareLegacyTemplateCandidate =
    dependencies.prepareNativeTemplateCandidate ??
    prepareLegacyNativeTemplateCandidate;
  const templateShuffleKey =
    dependencies.resolveNativeTemplateShuffleKey ??
    resolveNativeTemplateShuffleKey;
  const persistArtifact =
    dependencies.persistArtifact ?? persistSiteOpsArtifact;
  const persistBoard = dependencies.persistBoard ?? persistDefaultBoard;
  const loadStaticTemplateCatalog =
    dependencies.loadStaticTemplateCatalog ??
    requireStaticTemplateCatalogVersion;
  const readStaticTemplateCatalogPreview =
    dependencies.readStaticTemplateCatalogPreview ??
    readStaticTemplateCatalogVersionPreview;
  const persistStaticTemplateCatalogBoards =
    dependencies.persistStaticTemplateCatalogBoards ??
    persistDefaultStaticTemplateCatalogBoards;
  const readArtifact = dependencies.readArtifact ?? readSiteOpsArtifact;

  return async ({ operation, signal, assertLeaseActive }) => {
    const providerStartedAt = Date.now();
    let stage: VisualSearchStage = "validate_operation";
    const diagnostics = createVisualSearchDiagnostics();
    try {
      const parsedInput = visualSearchOperationInputSchema.parse(
        operation.input,
      );
      const staticCatalogMode = isStaticCatalogWorkflowVersion(
        parsedInput.workflowVersion,
      );
      const nativeSourceMode = isSiteOpsNativeVisualWorkflowVersion(
        parsedInput.workflowVersion,
      );
      stage = "load_context";
      const db = await dbGetter();
      if (!db) {
        throw new TwentyFirstProviderFailure(
          "DATABASE_UNAVAILABLE",
          "AI 建站服务暂时不可用。",
          "attention_required",
        );
      }
      const context = await loadContext(db, operation);
      const supportsDefaultCandidatePool =
        typeof db.select === "function" && typeof db.transaction === "function";
      const loadCandidatePoolState =
        dependencies.loadNativeTemplatePoolState ??
        (supportsDefaultCandidatePool
          ? loadDefaultNativeTemplatePoolState
          : undefined);
      const persistCandidatePool =
        dependencies.persistNativeTemplatePool ??
        (supportsDefaultCandidatePool
          ? persistDefaultNativeTemplatePool
          : undefined);
      if (context.existingBoard) {
        if (
          context.existingBoard.candidateCount !==
            (staticCatalogMode
              ? STATIC_TEMPLATE_CATALOG_ENTRY_COUNT
              : SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE) ||
          (staticCatalogMode &&
            context.existingBoard.pageCount !==
              STATIC_TEMPLATE_CATALOG_PAGE_COUNT)
        ) {
          throw new TwentyFirstProviderFailure(
            "VISUAL_CANDIDATE_PAGE_INCOMPLETE",
            "已保存的视觉候选不完整，请稍后重试。",
            "attention_required",
          );
        }
        const restoredPoolState =
          nativeSourceMode &&
          !staticCatalogMode &&
          "credentialId" in parsedInput &&
          loadCandidatePoolState
            ? await loadCandidatePoolState({
                db,
                operation,
                context,
                credentialId: parsedInput.credentialId,
                credentialVersion: parsedInput.credentialVersion,
                workflowVersion: parsedInput.workflowVersion,
                page: "page" in parsedInput ? parsedInput.page : 1,
              })
            : null;
        return {
          status: "succeeded",
          projectStatus: "awaiting_visual_selection",
          result: {
            batchId: context.existingBoard.batchId,
            ...(staticCatalogMode && context.existingBoard.batchIds
              ? { batchIds: context.existingBoard.batchIds }
              : {}),
            candidateCount: context.existingBoard.candidateCount,
            selectionBundleHash:
              context.existingBoard.selectionBundleHash ?? undefined,
            ...(staticCatalogMode &&
            "schemaVersion" in parsedInput &&
            (parsedInput.schemaVersion === 3 || parsedInput.schemaVersion === 4)
              ? {
                  workflowVersion: parsedInput.workflowVersion,
                  catalogVersion: parsedInput.catalogVersion,
                  pageSize: STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
                  pageCount: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
                  availablePages: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
                  reservedPages: 0,
                  canGenerateMore: false,
                }
              : {}),
            ...(restoredPoolState
              ? {
                  availablePages: restoredPoolState.availablePages,
                  reservedPages: restoredPoolState.reservedPages,
                }
              : {}),
          },
          message: "视觉方向已恢复，可继续选择。",
        };
      }
      const searchPlan = resolveVisualSearchPlan(parsedInput, context);
      if (
        nativeSourceMode &&
        !staticCatalogMode &&
        "credentialId" in parsedInput &&
        loadCandidatePoolState
      ) {
        const poolState = await loadCandidatePoolState({
          db,
          operation,
          context,
          credentialId: parsedInput.credentialId,
          credentialVersion: parsedInput.credentialVersion,
          workflowVersion: parsedInput.workflowVersion,
          page: searchPlan.page,
        });
        if (poolState) {
          diagnostics.templateMode = true;
          if (!poolState.page) {
            return {
              status: "attention_required",
              code: "VISUAL_CANDIDATE_POOL_EXHAUSTED",
              message: `本轮已冻结 ${poolState.availablePages} 组完整候选，没有更多可发布页面。`,
              result: {
                availablePages: poolState.availablePages,
                reservedPages: poolState.reservedPages,
              },
            };
          }
          stage = "persist_board";
          const restored = await restoreNativeTemplatePoolPage({
            operation,
            page: poolState.page,
            readArtifact,
          });
          await assertCommitLeaseActive(assertLeaseActive);
          const board = await persistBoard(db, {
            operation,
            searchPlan,
            context,
            selectionBundle: restored.selectionBundle,
            selectionBundleArtifact: restored.selectionBundleArtifact,
            mirroredCandidates: restored.candidates,
            candidatePoolPage: {
              poolId: poolState.poolId,
              pageNumber: poolState.page.pageNumber,
            },
          });
          diagnostics.capacityPages = poolState.availablePages;
          diagnostics.capacitySelected = SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE;
          diagnostics.publishedCount = SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE;
          diagnostics.terminalReason = "complete";
          return {
            status: "succeeded",
            projectStatus: "awaiting_visual_selection",
            result: {
              batchId: board.batchId,
              mode: searchPlan.mode,
              page: searchPlan.page,
              candidateCount: board.candidateCount,
              selectionBundleHash: board.selectionBundleHash ?? undefined,
              availablePages: poolState.availablePages,
              reservedPages: Math.max(0, poolState.reservedPages - 1),
              diagnostics,
            },
            message: `第 ${searchPlan.page} 组 9 个冻结视觉候选已准备完成，请选择一个方向。`,
          };
        }
      }
      if (staticCatalogMode) {
        if (
          !("schemaVersion" in parsedInput) ||
          (parsedInput.schemaVersion !== 3 && parsedInput.schemaVersion !== 4)
        ) {
          throw new TwentyFirstProviderFailure(
            "STATIC_TEMPLATE_CATALOG_OPERATION_INVALID",
            "固定 Template 目录任务坐标无效，请重置后重试。",
            "attention_required",
          );
        }
        stage = "retrieve_native_sources";
        const catalog = await loadStaticTemplateCatalog(
          parsedInput.catalogVersion,
        );
        if (
          catalog.catalogVersion !== parsedInput.catalogVersion ||
          catalog.schemaVersion !== "frontmind-static-template-catalog-v2"
        ) {
          throw new TwentyFirstProviderFailure(
            "STATIC_TEMPLATE_CATALOG_VERSION_MISMATCH",
            "固定 Template 目录版本已更新，请重置后重试。",
            "attention_required",
          );
        }
        return await runStaticTemplateCatalogVisualSearch({
          operation,
          assertLeaseActive,
          context,
          searchPlan,
          catalog,
          persistArtifact,
          readCatalogPreview: readStaticTemplateCatalogPreview,
          updateStage: (nextStage) => {
            stage = nextStage;
          },
          persistBoards: persistStaticTemplateCatalogBoards,
          db,
        });
      }
      stage = "load_credential";
      if (!("credentialId" in parsedInput)) {
        throw new TwentyFirstProviderFailure(
          "VISUAL_OPERATION_CONTRACT_MISMATCH",
          "视觉检索任务合同不一致，请重置后重试。",
          "attention_required",
        );
      }
      const credential = await getCredential(parsedInput.credentialId);
      if (!credential || credential.version !== parsedInput.credentialVersion) {
        throw new TwentyFirstProviderFailure(
          "PINNED_CREDENTIAL_UNAVAILABLE",
          "该视觉检索固定的 FrontMind 目录连接版本不可用。",
          "attention_required",
        );
      }
      if (nativeSourceMode) {
        if (!client.listNativeTemplates || !client.downloadNativeTemplate) {
          diagnostics.templateMode = true;
          rejectNativeTemplate(diagnostics, "catalog_unavailable");
          throw nativeTemplateProviderFailure("catalog_unavailable");
        }
        stage = "retrieve_native_sources";
        return await runNativeTemplateVisualSearch({
          operation,
          signal,
          assertLeaseActive,
          client: {
            listNativeTemplates: client.listNativeTemplates.bind(client),
            downloadNativeTemplate: client.downloadNativeTemplate.bind(client),
          },
          apiKey: credential.apiKey,
          credentialId: credential.id,
          credentialVersion: credential.version,
          context,
          searchPlan,
          diagnostics,
          prepareCandidate:
            parsedInput.workflowVersion ===
            SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION
              ? prepareTemplateCandidate
              : prepareLegacyTemplateCandidate,
          shuffleKey: templateShuffleKey(),
          fetchPreview,
          persistArtifact,
          persistBoard,
          persistCandidatePool,
          db,
        });
      }
      stage = "mcp_retrieval";
      const retrieval = await client.withReadOnlySession(
        credential.apiKey,
        async (session) => {
          if (nativeSourceMode && !session.getComponent) {
            throw new TwentyFirstProviderFailure(
              "MCP_GET_COMPONENT_REQUIRED",
              "当前 21st 连接缺少原生源码读取能力。",
              "attention_required",
            );
          }
          const pools = emptyFamilyReferencePools();
          const queries: FamilySearchQuery[] = [];
          const searchedCandidates = new Map<
            string,
            ReturnType<typeof normalizeTwentyFirstSearchResults>[number]
          >();
          const generalHeroEligibleKeys = new Set<string>();
          const mirrored: MirroredReference[] = [];
          const preparedNativeByProviderKey = new Map<
            string,
            PreparedNativeVisualCandidate
          >();
          const pendingNativeSources: Array<{
            reference: MirroredReference;
            payload: unknown;
          }> = [];
          let nativeFatalCategory: NativeVisualFailureCategory | null = null;
          const attemptedProviderKeys = new Set<string>();
          const unavailableProviderKeys = new Set<string>();
          const excludedProviderKeys = new Set(
            context.previousReferences?.providerItemKeys ?? [],
          );
          const priorPreviewHashes = new Set(
            context.previousReferences?.previewSha256s ?? [],
          );
          const priorPerceptualHashes = new Set(
            context.previousReferences?.perceptualHashes ?? [],
          );
          const priorSourceTreeSha256s = new Set(
            context.previousReferences?.sourceTreeSha256s ?? [],
          );
          const priorNativePreviewSha256s = new Set(
            context.previousReferences?.nativePreviewSha256s ?? [],
          );
          const rescueQueriedFamilies = new Set<FrontMindVisualFamily>();
          const effectiveSearchLimit = Math.max(
            1,
            Math.min(18, Math.trunc(session.effectiveSearchLimit ?? 18)),
          );
          let queryLatencyMs = 0;
          const runSearchRound = async (input: {
            families: readonly FrontMindVisualFamily[];
            round: FamilySearchRound;
          }) => {
            const startedAt = Date.now();
            try {
              await searchFamilyRound({
                session,
                brief: context.brief,
                families: input.families,
                round: input.round,
                page: searchPlan.page,
                pools,
                queries,
                searchedCandidates,
                signal,
                diagnostics,
                excludedProviderKeys,
                generalHeroEligibleKeys,
                effectiveSearchLimit,
                nativeSourceMode,
              });
            } finally {
              queryLatencyMs += Date.now() - startedAt;
            }
          };
          const mirrorSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(nativeSourceMode ? 180_000 : 45_000),
          ]);
          const mirrorCandidateSet = async (
            candidates: NormalizedTwentyFirstCandidate[],
          ) => {
            for (const candidate of candidates) {
              attemptedProviderKeys.add(candidate.providerItemKey);
            }
            if (candidates.length < 1) return;
            await assertCommitLeaseActive(assertLeaseActive);
            stage = "mirror_previews";
            const result = await mirrorCandidates({
              operation,
              context,
              candidates,
              signal: mirrorSignal,
              fetchPreview,
              persistArtifact,
              diagnostics,
              priorPreviewHashes,
              priorPerceptualHashes,
            });
            result.rejectedProviderKeys.forEach((key) =>
              unavailableProviderKeys.add(key),
            );
            if (!nativeSourceMode) {
              mirrored.push(...result.mirrored);
              return;
            }
            stage = "retrieve_native_sources";
            // Fetch all metered Provider source payloads while the MCP session
            // is open, but never compile inside that session. Local Vite and
            // Chromium work begins only after withReadOnlySession returns.
            const fetched = await mapWithBoundedConcurrency({
              values: result.mirrored,
              concurrency: MIRROR_CONCURRENCY,
              map: async (reference) => {
                if (nativeFatalCategory) return null;
                diagnostics.sourceFetchAttempts += 1;
                try {
                  const detail = await session.getComponent!(
                    reference.candidate.providerItemId,
                  );
                  assertTwentyFirstNativeSourcePayloadAvailable(detail);
                  diagnostics.sourceFetchSucceeded += 1;
                  return { reference, payload: detail } as const;
                } catch (error) {
                  const category = getComponentFailureCategory(error);
                  rejectNativeSource(diagnostics, category);
                  unavailableProviderKeys.add(
                    reference.candidate.providerItemKey,
                  );
                  if (
                    category === "provider_quota" ||
                    category === "get_component_contract" ||
                    category === "deadline_exhausted"
                  ) {
                    nativeFatalCategory = category;
                  }
                  return null;
                }
              },
            });
            for (const item of fetched) {
              if (item) pendingNativeSources.push(item);
            }
          };

          stage = "mcp_retrieval";
          await runSearchRound({
            families: FRONTMIND_VISUAL_FAMILIES_V3,
            round: "primary",
          });
          const matchingStartedAt = Date.now();
          let keyAssignment = maximumKeyAssignment(
            pools,
            unavailableProviderKeys,
          );
          const searchRescueFamily = async (family: FrontMindVisualFamily) => {
            rescueQueriedFamilies.add(family);
            stage = "mcp_retrieval";
            await runSearchRound({
              families: [family],
              round: "supplemental",
            });
            keyAssignment = maximumKeyAssignment(
              pools,
              unavailableProviderKeys,
            );
          };
          const rescueUntilCompleteKeyMatching = async () => {
            while (
              keyAssignment.size < FRONTMIND_VISUAL_FAMILIES_V3.length &&
              queries.length < MAX_FAMILY_SEARCH_CALLS
            ) {
              const family = nextHallRescueFamily({
                pools,
                assignment: keyAssignment,
                queried: rescueQueriedFamilies,
              });
              if (!family) break;
              await searchRescueFamily(family);
            }
          };
          await rescueUntilCompleteKeyMatching();

          const mirrorStartedAt = Date.now();
          let assigned = new Map<FrontMindVisualFamily, MirroredReference>();
          while (
            keyAssignment.size === FRONTMIND_VISUAL_FAMILIES_V3.length &&
            diagnostics.mirrorAttempted < MAX_MIRROR_ATTEMPTS &&
            !nativeFatalCategory &&
            (!nativeSourceMode ||
              diagnostics.sourceFetchAttempts < MAX_NATIVE_SOURCE_ATTEMPTS)
          ) {
            assigned = assignDistinctMirroredReferences({ pools, mirrored });
            if (assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) break;
            const remaining = Math.min(
              MIRROR_CONCURRENCY,
              MAX_MIRROR_ATTEMPTS - diagnostics.mirrorAttempted,
              ...(nativeSourceMode
                ? [MAX_NATIVE_SOURCE_ATTEMPTS - diagnostics.sourceFetchAttempts]
                : []),
            );
            const next = nextMirrorCandidates({
              pools,
              keyAssignment,
              compatibleAssignment: assigned,
              attemptedProviderKeys,
              unavailableProviderKeys,
              limit: remaining,
            });
            if (next.length < 1) {
              if (queries.length >= MAX_FAMILY_SEARCH_CALLS) break;
              const compatibleAssignment = compatibleKeyEdges({
                pools,
                assignment: assigned,
              });
              const rescueFamily = nextHallRescueFamily({
                pools,
                assignment: compatibleAssignment,
                queried: rescueQueriedFamilies,
              });
              if (!rescueFamily) break;
              await searchRescueFamily(rescueFamily);
              continue;
            }
            await mirrorCandidateSet(next);
            keyAssignment = maximumKeyAssignment(
              pools,
              unavailableProviderKeys,
            );
            if (keyAssignment.size < FRONTMIND_VISUAL_FAMILIES_V3.length) {
              await rescueUntilCompleteKeyMatching();
            }
          }
          assigned = assignDistinctMirroredReferences({ pools, mirrored });
          if (nativeSourceMode) {
            return {
              queries,
              pools,
              mirrored,
              assigned,
              preparedNativeByProviderKey,
              pendingNativeSources,
              searchedCandidates,
              generalHeroEligibleKeys,
              effectiveSearchLimit,
              priorSourceTreeSha256s,
              priorNativePreviewSha256s,
              queryLatencyMs,
              matchingStartedAt,
              mirrorStartedAt,
              nativeFatalCategory,
            };
          }
          const previewFailureCount = Object.values(
            diagnostics.rejectedByReason,
          ).reduce((sum, count) => sum + (count ?? 0), 0);
          if (assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) {
            diagnostics.terminalReason = "complete";
          } else if (diagnostics.mirrorAttempted >= MAX_MIRROR_ATTEMPTS) {
            // This is an I/O admission budget, not a matching solver budget.
            // Do not mislabel duplicate/failed previews as graph exhaustion.
            diagnostics.terminalReason = "preview_failures";
          } else if (previewFailureCount > 0) {
            diagnostics.terminalReason = "preview_failures";
          } else if (keyAssignment.size < FRONTMIND_VISUAL_FAMILIES_V3.length) {
            diagnostics.terminalReason = "catalog_insufficient";
          } else {
            diagnostics.terminalReason = "catalog_insufficient";
          }
          refreshRetrievalDiagnostics({
            pools,
            searchedCandidates,
            mirrored,
            assigned,
            diagnostics,
            queries,
            keyMatchingCardinality: keyAssignment.size,
            generalHeroEligibleKeys,
            effectiveSearchLimit,
          });
          logSafeVisualStage({
            event: "visual_query_capability",
            operationId: operation.id,
            projectId: operation.projectId,
            page: searchPlan.page,
            // The identifier selects the fixed, allowlisted page variant. It
            // carries no family name or query material.
            variantId: `visual-query-v2-page-${searchPlan.page}`,
            actualLimit: effectiveSearchLimit,
            queryCalls: diagnostics.queryCalls,
            normalizedUnique: diagnostics.normalizedUnique,
            latencyMs: queryLatencyMs,
          });
          const rejectedPreviews = Object.values(
            diagnostics.rejectedByReason,
          ).reduce((sum, count) => sum + (count ?? 0), 0);
          logSafeVisualStage({
            event: "visual_matching",
            operationId: operation.id,
            projectId: operation.projectId,
            page: searchPlan.page,
            queryCalls: diagnostics.queryCalls,
            normalizedUnique: diagnostics.normalizedUnique,
            eligibilityEdges: diagnostics.eligibilityEdgeCount,
            keyMatchingCardinality: diagnostics.keyMatchingCardinality,
            compatibleMatchingCardinality:
              diagnostics.compatibleMatchingCardinality,
            terminalReason: diagnostics.terminalReason,
            latencyMs: Date.now() - matchingStartedAt,
          });
          logSafeVisualStage({
            event: "visual_mirror",
            operationId: operation.id,
            projectId: operation.projectId,
            page: searchPlan.page,
            mirrorAttempts: diagnostics.mirrorAttempts,
            mirrorSucceeded: diagnostics.mirrorSucceeded,
            rejectedPreviews,
            compatibleMatchingCardinality:
              diagnostics.compatibleMatchingCardinality,
            terminalReason: diagnostics.terminalReason,
            latencyMs: Date.now() - mirrorStartedAt,
          });
          return {
            queries,
            pools,
            mirrored,
            assigned,
            preparedNativeByProviderKey,
            pendingNativeSources,
            searchedCandidates,
            generalHeroEligibleKeys,
            effectiveSearchLimit,
            priorSourceTreeSha256s,
            priorNativePreviewSha256s,
            queryLatencyMs,
            matchingStartedAt,
            mirrorStartedAt,
            nativeFatalCategory,
          };
        },
        { signal },
      );
      if (nativeSourceMode) {
        if (retrieval.nativeFatalCategory) {
          throw nativeSourceProviderFailure(retrieval.nativeFatalCategory);
        }
        stage = "render_native_previews";
        const preparationSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(300_000),
        ]);
        const prepared = await mapWithBoundedConcurrency({
          values: retrieval.pendingNativeSources,
          concurrency: MIRROR_CONCURRENCY,
          map: async (item) => {
            if (preparationSignal.aborted) return null;
            diagnostics.sourcePreparationAttempts += 1;
            try {
              const native = await prepareNativeCandidate({
                candidate: item.reference.candidate,
                payload: item.payload,
                signal: preparationSignal,
                fetchRemoteAsset: fetchPreview,
              });
              diagnostics.sourcePrepared += 1;
              return { ...item, native } as const;
            } catch (error) {
              const category = classifyNativeVisualFailure(error);
              rejectNativeSource(diagnostics, category);
              return { ...item, category } as const;
            }
          },
        });
        if (preparationSignal.aborted) {
          rejectNativeSource(diagnostics, "deadline_exhausted");
          throw nativeSourceProviderFailure("deadline_exhausted");
        }
        const acceptedSourceTrees = new Set(retrieval.priorSourceTreeSha256s);
        const acceptedNativePreviews = new Set(
          retrieval.priorNativePreviewSha256s,
        );
        for (const item of prepared) {
          if (!item || !("native" in item)) {
            if (item) {
              retrieval.mirrored.splice(
                0,
                retrieval.mirrored.length,
                ...retrieval.mirrored.filter(
                  (reference) =>
                    reference.candidate.providerItemKey !==
                    item.reference.candidate.providerItemKey,
                ),
              );
            }
            continue;
          }
          if (
            acceptedSourceTrees.has(item.native.sourceTreeSha256) ||
            acceptedNativePreviews.has(item.native.previewSha256)
          ) {
            rejectNativeSource(diagnostics, "source_incomplete");
            continue;
          }
          acceptedSourceTrees.add(item.native.sourceTreeSha256);
          acceptedNativePreviews.add(item.native.previewSha256);
          retrieval.mirrored.push(item.reference);
          retrieval.preparedNativeByProviderKey.set(
            item.reference.candidate.providerItemKey,
            item.native,
          );
        }
        retrieval.assigned = assignDistinctMirroredReferences({
          pools: retrieval.pools,
          mirrored: retrieval.mirrored,
        });
        const previewFailureCount = Object.entries(
          diagnostics.rejectedByReason,
        ).reduce(
          (sum, [reason, count]) =>
            sum + (reason === "source" ? 0 : (count ?? 0)),
          0,
        );
        const sourceFailureCount = Object.values(
          diagnostics.sourceRejectedByReason,
        ).reduce((sum, count) => sum + (count ?? 0), 0);
        if (retrieval.assigned.size === FRONTMIND_VISUAL_FAMILIES_V3.length) {
          diagnostics.terminalReason = "complete";
        } else if (sourceFailureCount > 0) {
          diagnostics.terminalReason = "source_failures";
        } else if (previewFailureCount > 0) {
          diagnostics.terminalReason = "preview_failures";
        } else {
          diagnostics.terminalReason = "catalog_insufficient";
        }
        refreshRetrievalDiagnostics({
          pools: retrieval.pools,
          searchedCandidates: retrieval.searchedCandidates,
          mirrored: retrieval.mirrored,
          assigned: retrieval.assigned,
          diagnostics,
          queries: retrieval.queries,
          generalHeroEligibleKeys: retrieval.generalHeroEligibleKeys,
          effectiveSearchLimit: retrieval.effectiveSearchLimit,
        });
        logSafeVisualStage({
          event: "visual_query_capability",
          operationId: operation.id,
          projectId: operation.projectId,
          page: searchPlan.page,
          variantId: `visual-query-v2-page-${searchPlan.page}`,
          actualLimit: retrieval.effectiveSearchLimit,
          queryCalls: diagnostics.queryCalls,
          normalizedUnique: diagnostics.normalizedUnique,
          latencyMs: retrieval.queryLatencyMs,
        });
        logSafeVisualStage({
          event: "visual_matching",
          operationId: operation.id,
          projectId: operation.projectId,
          page: searchPlan.page,
          queryCalls: diagnostics.queryCalls,
          normalizedUnique: diagnostics.normalizedUnique,
          eligibilityEdges: diagnostics.eligibilityEdgeCount,
          keyMatchingCardinality: diagnostics.keyMatchingCardinality,
          compatibleMatchingCardinality:
            diagnostics.compatibleMatchingCardinality,
          terminalReason: diagnostics.terminalReason,
          latencyMs: Date.now() - retrieval.matchingStartedAt,
        });
        logSafeVisualStage({
          event: "visual_mirror",
          operationId: operation.id,
          projectId: operation.projectId,
          page: searchPlan.page,
          mirrorAttempts: diagnostics.mirrorAttempts,
          mirrorSucceeded: diagnostics.mirrorSucceeded,
          sourceAttempts: diagnostics.sourceFetchAttempts,
          sourceSucceeded: diagnostics.sourcePrepared,
          nativeFailureCategory: diagnostics.nativeFailureCategory,
          compatibleMatchingCardinality:
            diagnostics.compatibleMatchingCardinality,
          terminalReason: diagnostics.terminalReason,
          latencyMs: Date.now() - retrieval.mirrorStartedAt,
        });
      }
      if (retrieval.assigned.size !== FRONTMIND_VISUAL_FAMILIES_V3.length) {
        if (diagnostics.terminalReason === "matching_budget_exhausted") {
          throw new TwentyFirstProviderFailure(
            "VISUAL_MATCHING_BUDGET_EXHAUSTED",
            "视觉参考组合计算达到本次安全上限，请稍后重试。",
            "attention_required",
          );
        }
        if (diagnostics.terminalReason === "preview_failures") {
          throw new TwentyFirstProviderFailure(
            "VISUAL_PREVIEW_REFERENCES_UNAVAILABLE",
            "部分真实 Hero 参考暂时无法安全读取，请稍后重试。",
            "attention_required",
          );
        }
        if (
          diagnostics.terminalReason === "source_failures" &&
          diagnostics.nativeFailureCategory
        ) {
          throw nativeSourceProviderFailure(diagnostics.nativeFailureCategory);
        }
        throw new TwentyFirstProviderFailure(
          "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
          `FrontMind 当前仅找到 ${retrieval.assigned.size}/9 个可安全区分的真实 Hero 参考，请稍后重试。`,
          "attention_required",
        );
      }
      const degradedReasons: string[] = [];
      await assertCommitLeaseActive(assertLeaseActive);
      const rejectedPreviews = Object.entries(
        diagnostics.rejectedByReason,
      ).reduce(
        (sum, [reason, count]) =>
          sum + (reason === "source" ? 0 : (count ?? 0)),
        0,
      );
      if (rejectedPreviews > 0) {
        degradedReasons.push(`PREVIEW_RESULTS_REJECTED:${rejectedPreviews}`);
      }
      const rejectedSources = Object.values(
        diagnostics.sourceRejectedByReason,
      ).reduce((sum, count) => sum + (count ?? 0), 0);
      if (rejectedSources > 0) {
        degradedReasons.push(
          `NATIVE_SOURCE_RESULTS_REJECTED:${rejectedSources}`,
        );
      }
      let mirroredCandidates: BoardCandidate[];
      let selectionBundle: VisualSelectionBundleV4 | VisualSelectionBundleV5;
      let selectionBuffer: Buffer;
      let selectionFilename: string;
      let selectionMimeType: string;
      let selectionMaxBytes: number;
      let expectedSelectionHash: string;
      if (nativeSourceMode) {
        stage = "render_native_previews";
        const nativeCandidates = await createNativeBoardCandidates({
          operation,
          context,
          inspirationByFamily: retrieval.assigned,
          preparedByProviderKey: retrieval.preparedNativeByProviderKey,
          persistArtifact,
        });
        mirroredCandidates = nativeCandidates;
        selectionBundle = visualSelectionBundleV5Schema.parse({
          schemaVersion: 5,
          renderer: "twenty_first_native_react_v1",
          queryPlanHash: canonicalSha256(retrieval.queries),
          searchTarget: retrieval.queries.reduce(
            (sum, query) => sum + query.limit,
            0,
          ),
          displayTarget: 9,
          candidates: nativeCandidates.map((item) => ({
            id: item.sampleId,
            label: item.optionLabel,
            queryAxis: item.queryAxis,
            providerItemId: item.providerItemId,
            providerItemKey: item.providerItemKey,
            providerVersion: item.providerVersion,
            title: item.title,
            description: item.description,
            author: item.author,
            sourceUrl: item.sourceUrl,
            visualEvidence: item.visualEvidence,
            referencePreviewLocalAssetId: item.referencePreviewLocalAssetId,
            referencePreviewSha256: item.referencePreviewSha256,
            referencePerceptualHash: item.referencePerceptualHash,
            previewLocalAssetId: item.previewLocalAssetId,
            previewSha256: item.previewSha256,
            taxonomy: item.taxonomy,
            score: item.score,
            rationale: item.rationale,
            sourceTreeSha256: item.sourceTreeSha256,
            sourceArchiveSha256: item.sourceArchiveSha256,
            sourceArchivePath: `candidates/${item.optionLabel}/source.zip`,
            entrypoint: item.entrypoint,
            demoEntrypoint: item.demoEntrypoint,
            sourceDirectory: "source",
          })),
          selectedCandidateId: null,
          delegated: false,
          degradedReasons: Array.from(new Set(degradedReasons)),
        });
        selectionBuffer = await createVisualSelectionBundleV5Artifact({
          bundle: selectionBundle,
          sourceArchives: new Map(
            nativeCandidates.map((candidate) => [
              candidate.sampleId,
              candidate.sourceArchive,
            ]),
          ),
        });
        selectionFilename = `visual-selection-${operation.id}.zip`;
        selectionMimeType = VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE;
        selectionMaxBytes = VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES;
        expectedSelectionHash = sha256Buffer(selectionBuffer);
      } else {
        stage = "render_host_previews";
        const frontMindCandidates = await createFrontMindBoardCandidates({
          operation,
          context,
          inspirationByFamily: retrieval.assigned,
          signal,
          renderCandidates,
          persistArtifact,
          diagnostics,
        });
        mirroredCandidates = frontMindCandidates;
        selectionBundle = visualSelectionBundleV4Schema.parse({
          schemaVersion: 4,
          queryPlanHash: canonicalSha256(retrieval.queries),
          searchTarget: retrieval.queries.reduce(
            (sum, query) => sum + query.limit,
            0,
          ),
          referenceTarget: 9,
          displayTarget: 9,
          candidates: frontMindCandidates.map((item) => ({
            id: item.sampleId,
            label: item.optionLabel,
            queryAxis: item.queryAxis,
            providerItemKey: item.providerItemKey,
            title: item.title,
            description: item.description,
            author: item.author,
            sourceUrl: item.sourceUrl,
            visualEvidence: item.visualEvidence,
            previewLocalAssetId: item.previewLocalAssetId,
            previewSha256: item.previewSha256,
            realizationPreviewLocalAssetId: item.realizationPreviewLocalAssetId,
            realizationPreviewSha256: item.realizationPreviewSha256,
            referencePerceptualHash: item.referencePerceptualHash,
            realizationPerceptualHash: item.realizationPerceptualHash,
            taxonomy: item.taxonomy,
            score: item.score,
            rationale: item.rationale,
            referenceBlueprint: item.referenceBlueprint,
          })),
          selectedCandidateId: null,
          delegated: false,
          degradedReasons: Array.from(new Set(degradedReasons)),
        });
        selectionBuffer = Buffer.from(canonicalJson(selectionBundle), "utf8");
        selectionFilename = `visual-selection-${operation.id}.json`;
        selectionMimeType = "application/json";
        selectionMaxBytes = 1_000_000;
        expectedSelectionHash = canonicalSha256(selectionBundle);
      }
      await assertCommitLeaseActive(assertLeaseActive);
      stage = "persist_selection_bundle";
      const selectionBundleArtifact = await persistArtifact({
        userId: operation.userId,
        projectId: context.project.id,
        kind: "21st-selection-bundle",
        filename: selectionFilename,
        mimeType: selectionMimeType,
        buffer: selectionBuffer,
        maxBytes: selectionMaxBytes,
      });
      if (selectionBundleArtifact.contentSha256 !== expectedSelectionHash) {
        throw new TwentyFirstProviderFailure(
          "SELECTION_BUNDLE_HASH_MISMATCH",
          "视觉选择包写入校验失败。",
          "attention_required",
        );
      }
      await assertCommitLeaseActive(assertLeaseActive);
      stage = "persist_board";
      const board = await persistBoard(db, {
        operation,
        searchPlan,
        context,
        selectionBundle,
        selectionBundleArtifact,
        mirroredCandidates,
      });
      logSafeVisualStage({
        event: "visual_page_published",
        operationId: operation.id,
        projectId: operation.projectId,
        page: searchPlan.page,
        queryCalls: diagnostics.queryCalls,
        mirrorAttempts: diagnostics.mirrorAttempts,
        mirrorSucceeded: diagnostics.mirrorSucceeded,
        candidateCount: board.candidateCount,
        terminalReason: "complete",
        latencyMs: Date.now() - providerStartedAt,
      });
      return {
        status: "succeeded",
        projectStatus: "awaiting_visual_selection",
        result: {
          batchId: board.batchId,
          mode: searchPlan.mode,
          page: searchPlan.page,
          candidateCount: board.candidateCount,
          selectionBundleHash: board.selectionBundleHash ?? undefined,
          actual: {
            searched: diagnostics.normalizedUnique,
            shortlisted: diagnostics.shortlistCount,
            mirrored: diagnostics.mirrorSucceeded,
            presented: mirroredCandidates.length,
          },
          diagnostics,
          diversity: diagnostics.diversity,
          degradedReasons: selectionBundle.degradedReasons,
        },
        message: "9 个不同风格的视觉候选已准备完成，请选择一个方向。",
      };
    } catch (error) {
      const failure = safeProviderFailure(error, stage, diagnostics, signal);
      console.error("[SiteOps21st] visual_search_failed", {
        operationId: operation.id,
        projectId: operation.projectId,
        stage,
        operationStatus: failure.status,
        errorCode: "code" in failure ? failure.code : "PROVIDER_ERROR",
        ...safePersistenceErrorDetails(error, stage),
      });
      return failure;
    }
  };
}

/** Explicit registration keeps importing this module side-effect free. */
export function registerTwentyFirstSiteOpsProvider(
  dependencies: TwentyFirstProviderDependencies = {},
) {
  return registerSiteOpsProviderHandler(
    "21st",
    createTwentyFirstSiteOpsProviderHandler(dependencies),
  );
}
