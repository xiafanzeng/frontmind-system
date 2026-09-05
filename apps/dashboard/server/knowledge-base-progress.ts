import { createHash } from "node:crypto";

import {
  parseExactJson,
  repairStructuredJsonCandidate,
  type ModelOutputRepairRuleCode,
} from "./model-output-repair";

export const KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES = 8;
export const KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES = 115;
export const KNOWLEDGE_BASE_DEEP_MANIFEST_MIN_LEAVES = 30;
export const KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY = 1;
export const KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP = 2;
export type KnowledgeBaseTreePolicyVersion =
  | typeof KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY
  | typeof KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP;

export const KNOWLEDGE_BASE_RESEARCH_DIMENSION_IDS = [
  "enterprise_identity",
  "team_and_organization",
  "products_and_services",
  "capabilities_and_delivery",
  "industries_scenarios_and_cases",
  "differentiation_and_evidence",
  "cooperation_delivery_and_support",
] as const;
export type KnowledgeBaseResearchDimensionId =
  (typeof KNOWLEDGE_BASE_RESEARCH_DIMENSION_IDS)[number];
export const KNOWLEDGE_BASE_PROGRESS_KIND = "frontmind.knowledge-base.progress";
export const KNOWLEDGE_BASE_MANIFEST_KIND = "frontmind.knowledge-base.manifest";
export const KNOWLEDGE_BASE_REOPEN_KIND = "frontmind.knowledge-base.reopen";
export const KNOWLEDGE_BASE_PRESENTATION_KIND =
  "frontmind.knowledge-base.presentation";
export const KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION = 1;
export const KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION = 2;
export type KnowledgeBaseProtocolSchemaVersion =
  | typeof KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION
  | typeof KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION;
export const KNOWLEDGE_BASE_PROGRESS_MARKER = "FRONTMIND_KB_PROGRESS";
export const KNOWLEDGE_BASE_MANIFEST_MARKER = "FRONTMIND_KB_MANIFEST";
export const KNOWLEDGE_BASE_REOPEN_MARKER = "FRONTMIND_KB_REOPEN";
export const KNOWLEDGE_BASE_PRESENTATION_MARKER = "FRONTMIND_KB_PRESENTATION";

export type KnowledgeBaseUpstreamTaskPhase =
  | "active"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface KnowledgeBaseUpstreamTaskStatus {
  normalized: string;
  phase: KnowledgeBaseUpstreamTaskPhase;
  /** The provider will not append ordinary streaming text in this state. */
  settled: boolean;
  terminal: boolean;
  failed: boolean;
}

/**
 * Keep provider status handling in one place. Providers have used all of the
 * aliases below in production; treating only `completed` as terminal leaves a
 * durable build locked forever after a perfectly ordinary `done` response.
 */
export function classifyKnowledgeBaseUpstreamTaskStatus(
  status: unknown,
): KnowledgeBaseUpstreamTaskStatus {
  const normalized = String(status || "running")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (
    new Set([
      "completed",
      "complete",
      "succeeded",
      "success",
      "done",
      "finished",
      // Manus v2 emits `stopped` after a normal finish; failures arrive as
      // the separate `error` status and error_message event.
      "stopped",
    ]).has(normalized)
  ) {
    return {
      normalized,
      phase: "succeeded",
      settled: true,
      terminal: true,
      failed: false,
    };
  }
  if (new Set(["failed", "error", "errored"]).has(normalized)) {
    return {
      normalized,
      phase: "failed",
      settled: true,
      terminal: true,
      failed: true,
    };
  }
  if (new Set(["cancelled", "canceled"]).has(normalized)) {
    return {
      normalized,
      phase: "cancelled",
      settled: true,
      terminal: true,
      failed: true,
    };
  }
  if (
    new Set([
      "awaiting_input",
      "awaiting_user",
      "awaiting_user_input",
      "waiting",
      "paused",
      "requires_action",
      "input_required",
    ]).has(normalized)
  ) {
    return {
      normalized,
      phase: "awaiting_input",
      settled: true,
      terminal: false,
      failed: false,
    };
  }
  if (
    new Set([
      "created",
      "queued",
      "pending",
      "running",
      "in_progress",
      "processing",
    ]).has(normalized)
  ) {
    return {
      normalized,
      phase: "active",
      settled: false,
      terminal: false,
      failed: false,
    };
  }
  return {
    normalized,
    phase: "unknown",
    settled: false,
    terminal: false,
    failed: false,
  };
}

export const knowledgeBaseLeafStatuses = [
  "pending",
  "current",
  "confirmed",
  "direct_prefilled",
  "needs_verification",
] as const;

export type KnowledgeBaseLeafStatus =
  (typeof knowledgeBaseLeafStatuses)[number];
export type KnowledgeBaseActiveLeafStatus = Extract<
  KnowledgeBaseLeafStatus,
  "current" | "needs_verification"
>;
export type KnowledgeBaseTransitionTarget = Extract<
  KnowledgeBaseLeafStatus,
  "confirmed" | "direct_prefilled" | "needs_verification"
>;

export interface KnowledgeBaseLeafManifestEntry {
  id: string;
  title: string;
  branchId?: string;
  branchTitle?: string;
}

export interface KnowledgeBaseLeafProgress
  extends KnowledgeBaseLeafManifestEntry {
  status: KnowledgeBaseLeafStatus;
}

export interface KnowledgeBaseProgressState {
  schemaVersion: typeof KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION;
  revision: number;
  currentLeafId: string | null;
  leaves: readonly KnowledgeBaseLeafProgress[];
}

export interface KnowledgeBaseProgressTransition {
  leafId: string;
  from: KnowledgeBaseActiveLeafStatus;
  to: KnowledgeBaseTransitionTarget;
  reason?: string;
}

export interface KnowledgeBaseProgressEnvelope {
  kind: typeof KNOWLEDGE_BASE_PROGRESS_KIND;
  schemaVersion: KnowledgeBaseProtocolSchemaVersion;
  operationId?: string;
  turnId?: string;
  revision: number;
  transition: KnowledgeBaseProgressTransition;
}

export interface KnowledgeBaseManifestEnvelope {
  kind: typeof KNOWLEDGE_BASE_MANIFEST_KIND;
  schemaVersion: KnowledgeBaseProtocolSchemaVersion;
  operationId?: string;
  turnId?: string;
  leaves: KnowledgeBaseLeafManifestEntry[];
  officialLogo?: KnowledgeBaseOfficialLogoProvenance;
  researchCoverage?: KnowledgeBaseInitialResearchCoverage;
}

export interface KnowledgeBaseInitialResearchCoverage {
  officialPages: {
    discovered: number;
    attempted: number;
    succeeded: number;
    failed: number;
  };
  publicQueries: number;
  officialDocuments: number;
  uploadsRead: number;
  sourceCount: number;
  productFamilies: Array<{
    id: string;
    name: string;
    leafIds: string[];
  }>;
  dimensions: Array<{
    id: KnowledgeBaseResearchDimensionId;
    status: "covered" | "gap";
    leafIds: string[];
  }>;
  stopReason: "coverage_complete" | "source_limited" | "budget_reached";
  limitationReason?: string;
}

export type KnowledgeBaseOfficialLogoProvenance =
  | {
      sourceKind: "official_web";
      sourcePageUrl: string;
      sourceAssetUrl: string;
    }
  | {
      sourceKind: "official_document";
      sourceDocumentPath: string;
    };

export interface KnowledgeBaseReopenEnvelope {
  kind: typeof KNOWLEDGE_BASE_REOPEN_KIND;
  schemaVersion: KnowledgeBaseProtocolSchemaVersion;
  operationId?: string;
  turnId?: string;
  revision: number;
  leafId: string;
  reason?: string;
}

export interface KnowledgeBasePresentationEnvelope {
  kind: typeof KNOWLEDGE_BASE_PRESENTATION_KIND;
  schemaVersion: KnowledgeBaseProtocolSchemaVersion;
  operationId?: string;
  turnId?: string;
  /** The authoritative revision after the progress transition is applied. */
  revision: number;
  /** The leaf rendered for the next customer action, or null at completion. */
  leafId: string | null;
  /** Whether this turn returned validated image attachments for the leaf. */
  imageState?: "attached" | "no_eligible_asset" | "not_applicable";
  /** Stable asset IDs corresponding to the returned image attachments. */
  assetIds?: string[];
  /** Actual number of image attachments returned in this turn. */
  imageCount?: number;
}

export interface KnowledgeBaseProgressSummary {
  total: number;
  pending: number;
  current: number;
  confirmed: number;
  directPrefilled: number;
  needsVerification: number;
  handled: number;
  overall: number;
  overallPercent: number;
}

export type KnowledgeBaseProgressErrorCode =
  | "INVALID_MANIFEST"
  | "MANIFEST_LEAF_COUNT_BELOW_MIN"
  | "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE"
  | "INVALID_STATE"
  | "INVALID_ENVELOPE"
  | "STALE_OPERATION"
  | "STALE_REVISION"
  | "NO_CURRENT_LEAF"
  | "WRONG_LEAF"
  | "FROM_STATUS_MISMATCH"
  | "INVALID_TRANSITION"
  | "PACKAGING_BLOCKED";

export class KnowledgeBaseProgressError extends Error {
  readonly code: KnowledgeBaseProgressErrorCode;

  constructor(code: KnowledgeBaseProgressErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeBaseProgressError";
    this.code = code;
  }
}

function fail(code: KnowledgeBaseProgressErrorCode, message: string): never {
  throw new KnowledgeBaseProgressError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
) {
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpectedKeys.length > 0) {
    fail(
      "INVALID_ENVELOPE",
      `${label} contains unsupported fields: ${unexpectedKeys.join(", ")}`,
    );
  }
}

function parseProtocolIdentity(value: Record<string, unknown>) {
  const schemaVersion = value.schemaVersion;
  if (
    schemaVersion !== KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION &&
    schemaVersion !== KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION
  ) {
    fail("INVALID_ENVELOPE", "Protocol envelope schema version is invalid");
  }
  const operationId =
    typeof value.operationId === "string" ? value.operationId.trim() : "";
  const turnId = typeof value.turnId === "string" ? value.turnId.trim() : "";
  if (schemaVersion === KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION) {
    if (!operationId || operationId.length > 128) {
      fail("INVALID_ENVELOPE", "v4 envelope operationId is required");
    }
    if (!turnId || turnId.length > 36) {
      fail("INVALID_ENVELOPE", "v4 envelope turnId is required");
    }
  } else if (value.operationId !== undefined || value.turnId !== undefined) {
    fail(
      "INVALID_ENVELOPE",
      "Legacy envelope cannot declare v4 operation identity",
    );
  }
  return {
    schemaVersion,
    ...(operationId ? { operationId } : {}),
    ...(turnId ? { turnId } : {}),
  } as const;
}

export function assertKnowledgeBaseProtocolOperation(
  envelope: {
    schemaVersion: KnowledgeBaseProtocolSchemaVersion;
    operationId?: string;
    turnId?: string;
  },
  expected: { operationId: string; turnId: string; requireV4: boolean },
) {
  if (!expected.requireV4) {
    if (envelope.schemaVersion !== KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION) {
      fail("INVALID_ENVELOPE", "Legacy build received a v4 protocol envelope");
    }
    return;
  }
  if (envelope.schemaVersion !== KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION) {
    fail("INVALID_ENVELOPE", "v4 build received a legacy protocol envelope");
  }
  if (
    envelope.operationId !== expected.operationId ||
    envelope.turnId !== expected.turnId
  ) {
    fail(
      "STALE_OPERATION",
      "Protocol envelope does not belong to the active knowledge-base turn",
    );
  }
}

function isLeafStatus(value: unknown): value is KnowledgeBaseLeafStatus {
  return knowledgeBaseLeafStatuses.includes(value as KnowledgeBaseLeafStatus);
}

function isHandledStatus(status: KnowledgeBaseLeafStatus) {
  return status === "confirmed" || status === "direct_prefilled";
}

function normalizeManifestEntry(
  entry: KnowledgeBaseLeafManifestEntry,
  index: number,
): KnowledgeBaseLeafManifestEntry {
  if (!isPlainObject(entry)) {
    fail("INVALID_MANIFEST", `Leaf ${index + 1} must be an object`);
  }

  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  const branchId =
    typeof entry.branchId === "string" ? entry.branchId.trim() : undefined;
  const branchTitle =
    typeof entry.branchTitle === "string"
      ? entry.branchTitle.trim()
      : undefined;

  if (!id) {
    fail("INVALID_MANIFEST", `Leaf ${index + 1} is missing a non-empty id`);
  }
  if (!title) {
    fail("INVALID_MANIFEST", `Leaf ${id} is missing a non-empty title`);
  }
  if (entry.branchId !== undefined && !branchId) {
    fail("INVALID_MANIFEST", `Leaf ${id} has an empty branchId`);
  }
  if (entry.branchTitle !== undefined && !branchTitle) {
    fail("INVALID_MANIFEST", `Leaf ${id} has an empty branchTitle`);
  }
  if (id.length > 191) {
    fail(
      "INVALID_MANIFEST",
      `Leaf id is longer than 191 characters: ${id.slice(0, 40)}`,
    );
  }
  if (title.length > 512) {
    fail(
      "INVALID_MANIFEST",
      `Leaf ${id} has a title longer than 512 characters`,
    );
  }
  if (branchId && branchId.length > 128) {
    fail(
      "INVALID_MANIFEST",
      `Leaf ${id} has a branchId longer than 128 characters`,
    );
  }
  if (branchTitle && branchTitle.length > 255) {
    fail(
      "INVALID_MANIFEST",
      `Leaf ${id} has a branchTitle longer than 255 characters`,
    );
  }

  return {
    id,
    title,
    ...(branchId ? { branchId } : {}),
    ...(branchTitle ? { branchTitle } : {}),
  };
}

/**
 * Validates and normalizes a manifest without imposing the production 8–115
 * size requirement. This keeps the state machine independently testable with
 * small manifests.
 */
export function validateKnowledgeBaseLeafManifest(
  manifest: readonly KnowledgeBaseLeafManifestEntry[],
): KnowledgeBaseLeafManifestEntry[] {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    fail("INVALID_MANIFEST", "A leaf manifest must contain at least one leaf");
  }

  const normalized = manifest.map(normalizeManifestEntry);
  const ids = new Set<string>();
  for (const leaf of normalized) {
    if (ids.has(leaf.id)) {
      fail("INVALID_MANIFEST", `Duplicate leaf id: ${leaf.id}`);
    }
    ids.add(leaf.id);
  }

  return normalized;
}

function validateProductionManifestStructure(
  manifest: readonly KnowledgeBaseLeafManifestEntry[],
) {
  const normalized = validateKnowledgeBaseLeafManifest(manifest);
  const missingBranch = normalized.find(
    (leaf) => !leaf.branchId || !leaf.branchTitle,
  );
  if (missingBranch) {
    fail(
      "INVALID_MANIFEST",
      `Production leaf ${missingBranch.id} must include branchId and branchTitle`,
    );
  }

  const branchTitleById = new Map<string, string>();
  for (const leaf of normalized) {
    const branchId = leaf.branchId!;
    const branchTitle = leaf.branchTitle!;
    const existingTitle = branchTitleById.get(branchId);
    if (existingTitle && existingTitle !== branchTitle) {
      fail(
        "INVALID_MANIFEST",
        `Production branch ${branchId} has inconsistent titles: ${existingTitle} / ${branchTitle}`,
      );
    }
    branchTitleById.set(branchId, branchTitle);
  }

  return normalized;
}

export function knowledgeBaseTreePolicy(version: unknown) {
  if (version === KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP) {
    return {
      version: KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
      minLeaves: KNOWLEDGE_BASE_DEEP_MANIFEST_MIN_LEAVES,
      maxLeaves: KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES,
      targetMinLeaves: 40,
      targetMaxLeaves: 55,
    } as const;
  }
  if (version === KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY) {
    return {
      version: KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY,
      minLeaves: KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES,
      maxLeaves: KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES,
      targetMinLeaves: KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES,
      targetMaxLeaves: KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES,
    } as const;
  }
  fail("INVALID_STATE", "Knowledge-base tree policy version is invalid");
}

/** Applies the leaf-count contract pinned to one durable build. */
export function validateKnowledgeBaseLeafManifestForTreePolicy(
  manifest: readonly KnowledgeBaseLeafManifestEntry[],
  treePolicyVersion: unknown,
): KnowledgeBaseLeafManifestEntry[] {
  const normalized = validateProductionManifestStructure(manifest);
  const policy = knowledgeBaseTreePolicy(treePolicyVersion);
  if (normalized.length < policy.minLeaves) {
    fail(
      policy.version === KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP
        ? "MANIFEST_LEAF_COUNT_BELOW_MIN"
        : "INVALID_MANIFEST",
      `A production leaf manifest for tree policy v${policy.version} must contain at least ${policy.minLeaves} leaves; received ${normalized.length}`,
    );
  }
  if (normalized.length > policy.maxLeaves) {
    fail(
      "INVALID_MANIFEST",
      `A production leaf manifest for tree policy v${policy.version} must contain at most ${policy.maxLeaves} leaves; received ${normalized.length}`,
    );
  }
  return normalized;
}

/** Legacy compatibility validator for archives and persisted v1 builds. */
export function validateProductionKnowledgeBaseLeafManifest(
  manifest: readonly KnowledgeBaseLeafManifestEntry[],
): KnowledgeBaseLeafManifestEntry[] {
  return validateKnowledgeBaseLeafManifestForTreePolicy(
    manifest,
    KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY,
  );
}

function researchCoverageFail(message: string): never {
  fail("MANIFEST_RESEARCH_COVERAGE_INCOMPLETE", message);
}

function assertResearchCoverageKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
) {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) {
    researchCoverageFail(
      `${label} contains unsupported fields: ${unexpected.join(", ")}`,
    );
  }
}

function researchInteger(value: unknown, label: string, maximum: number) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > maximum
  ) {
    researchCoverageFail(
      `${label} must be an integer between 0 and ${maximum}`,
    );
  }
  return Number(value);
}

function parseResearchLeafIds(
  value: unknown,
  leafIds: ReadonlySet<string>,
  label: string,
) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 115) {
    researchCoverageFail(`${label} must contain 1–115 leaf ids`);
  }
  const normalized = value.map((candidate) =>
    typeof candidate === "string" ? candidate.trim() : "",
  );
  if (
    normalized.some((leafId) => !leafId || !leafIds.has(leafId)) ||
    new Set(normalized).size !== normalized.length
  ) {
    researchCoverageFail(`${label} contains an unknown or duplicate leaf id`);
  }
  return normalized;
}

function parseInitialResearchCoverage(
  input: unknown,
  leafIds: ReadonlySet<string>,
): KnowledgeBaseInitialResearchCoverage {
  if (!isPlainObject(input)) {
    researchCoverageFail("Manifest researchCoverage must be an object");
  }
  assertResearchCoverageKeys(
    input,
    [
      "officialPages",
      "publicQueries",
      "officialDocuments",
      "uploadsRead",
      "sourceCount",
      "productFamilies",
      "dimensions",
      "stopReason",
      "limitationReason",
    ],
    "Manifest researchCoverage",
  );
  if (!isPlainObject(input.officialPages)) {
    researchCoverageFail("researchCoverage.officialPages must be an object");
  }
  assertResearchCoverageKeys(
    input.officialPages,
    ["discovered", "attempted", "succeeded", "failed"],
    "researchCoverage.officialPages",
  );
  const officialPages = {
    discovered: researchInteger(
      input.officialPages.discovered,
      "researchCoverage.officialPages.discovered",
      10_000,
    ),
    attempted: researchInteger(
      input.officialPages.attempted,
      "researchCoverage.officialPages.attempted",
      200,
    ),
    succeeded: researchInteger(
      input.officialPages.succeeded,
      "researchCoverage.officialPages.succeeded",
      120,
    ),
    failed: researchInteger(
      input.officialPages.failed,
      "researchCoverage.officialPages.failed",
      200,
    ),
  };
  if (
    officialPages.attempted > officialPages.discovered ||
    officialPages.succeeded + officialPages.failed !== officialPages.attempted
  ) {
    researchCoverageFail(
      "researchCoverage official-page arithmetic is inconsistent",
    );
  }
  const publicQueries = researchInteger(
    input.publicQueries,
    "researchCoverage.publicQueries",
    30,
  );
  const officialDocuments = researchInteger(
    input.officialDocuments,
    "researchCoverage.officialDocuments",
    30,
  );
  const uploadsRead = researchInteger(
    input.uploadsRead,
    "researchCoverage.uploadsRead",
    100,
  );
  const sourceCount = researchInteger(
    input.sourceCount,
    "researchCoverage.sourceCount",
    2_000,
  );
  if (publicQueries < 6) {
    researchCoverageFail("researchCoverage.publicQueries must be at least 6");
  }
  if (sourceCount < 1) {
    researchCoverageFail("researchCoverage.sourceCount must be at least 1");
  }

  if (
    !Array.isArray(input.productFamilies) ||
    input.productFamilies.length === 0 ||
    input.productFamilies.length > 115
  ) {
    researchCoverageFail(
      "researchCoverage.productFamilies must contain 1–115 families",
    );
  }
  const productFamilies = input.productFamilies.map((candidate, index) => {
    if (!isPlainObject(candidate)) {
      researchCoverageFail(
        `researchCoverage.productFamilies[${index}] must be an object`,
      );
    }
    assertResearchCoverageKeys(
      candidate,
      ["id", "name", "leafIds"],
      `researchCoverage.productFamilies[${index}]`,
    );
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!id || id.length > 191 || !name || name.length > 255) {
      researchCoverageFail(
        `researchCoverage.productFamilies[${index}] has an invalid id or name`,
      );
    }
    return {
      id,
      name,
      leafIds: parseResearchLeafIds(
        candidate.leafIds,
        leafIds,
        `researchCoverage.productFamilies[${index}].leafIds`,
      ),
    };
  });
  if (
    new Set(productFamilies.map((family) => family.id)).size !==
    productFamilies.length
  ) {
    researchCoverageFail(
      "researchCoverage.productFamilies contains duplicate ids",
    );
  }

  if (
    !Array.isArray(input.dimensions) ||
    input.dimensions.length !== KNOWLEDGE_BASE_RESEARCH_DIMENSION_IDS.length
  ) {
    researchCoverageFail(
      "researchCoverage.dimensions must contain the seven business dimensions",
    );
  }
  const dimensions = input.dimensions.map((candidate, index) => {
    if (!isPlainObject(candidate)) {
      researchCoverageFail(
        `researchCoverage.dimensions[${index}] must be an object`,
      );
    }
    assertResearchCoverageKeys(
      candidate,
      ["id", "status", "leafIds"],
      `researchCoverage.dimensions[${index}]`,
    );
    const id = candidate.id as KnowledgeBaseResearchDimensionId;
    if (!KNOWLEDGE_BASE_RESEARCH_DIMENSION_IDS.includes(id)) {
      researchCoverageFail(
        `researchCoverage.dimensions[${index}].id is invalid`,
      );
    }
    if (candidate.status !== "covered" && candidate.status !== "gap") {
      researchCoverageFail(
        `researchCoverage.dimensions[${index}].status is invalid`,
      );
    }
    return {
      id,
      status: candidate.status as "covered" | "gap",
      leafIds: parseResearchLeafIds(
        candidate.leafIds,
        leafIds,
        `researchCoverage.dimensions[${index}].leafIds`,
      ),
    };
  });
  if (
    new Set(dimensions.map((dimension) => dimension.id)).size !==
    KNOWLEDGE_BASE_RESEARCH_DIMENSION_IDS.length
  ) {
    researchCoverageFail(
      "researchCoverage.dimensions must cover each business dimension exactly once",
    );
  }

  const stopReason = input.stopReason;
  if (
    stopReason !== "coverage_complete" &&
    stopReason !== "source_limited" &&
    stopReason !== "budget_reached"
  ) {
    researchCoverageFail("researchCoverage.stopReason is invalid");
  }
  const limitationReason =
    typeof input.limitationReason === "string"
      ? input.limitationReason.trim()
      : undefined;
  if (input.limitationReason !== undefined && !limitationReason) {
    researchCoverageFail("researchCoverage.limitationReason cannot be empty");
  }
  if (limitationReason && limitationReason.length > 2_000) {
    researchCoverageFail("researchCoverage.limitationReason is too long");
  }
  if (stopReason === "coverage_complete") {
    if (officialPages.succeeded < 12 || limitationReason) {
      researchCoverageFail(
        "coverage_complete requires at least 12 successful official pages and no limitationReason",
      );
    }
  } else if (stopReason === "source_limited") {
    if (
      officialPages.attempted !== officialPages.discovered ||
      !limitationReason ||
      limitationReason.length < 8
    ) {
      researchCoverageFail(
        "source_limited requires an exhausted official-page queue and a specific limitationReason",
      );
    }
  } else if (
    officialPages.succeeded < 12 ||
    !limitationReason ||
    limitationReason.length < 8 ||
    !(
      officialPages.succeeded === 120 ||
      officialPages.attempted === 200 ||
      publicQueries === 30 ||
      officialDocuments === 30
    )
  ) {
    researchCoverageFail(
      "budget_reached requires sufficient official coverage, a reached budget cap and a specific limitationReason",
    );
  }

  return {
    officialPages,
    publicQueries,
    officialDocuments,
    uploadsRead,
    sourceCount,
    productFamilies,
    dimensions,
    stopReason,
    ...(limitationReason ? { limitationReason } : {}),
  };
}

function referencedResearchCoverageLeafIds(input: unknown) {
  if (!isPlainObject(input)) return [];
  const containers = [input.productFamilies, input.dimensions];
  return containers.flatMap((container) =>
    Array.isArray(container)
      ? container.flatMap((candidate) =>
          isPlainObject(candidate) && Array.isArray(candidate.leafIds)
            ? candidate.leafIds.filter(
                (leafId): leafId is string => typeof leafId === "string",
              )
            : [],
        )
      : [],
  );
}

/**
 * Revalidates the durable first-turn research ledger before progress display or
 * authenticated publication. When node IDs are available every relationship
 * is checked against them; the pure publication predicate can still enforce
 * the complete ledger shape and gates without trusting a truthy JSON object.
 */
export function validateStoredKnowledgeBaseResearchCoverage(
  input: unknown,
  options: {
    knownLeafIds?: readonly string[];
    totalLeafCount?: number;
    expectedUploadsRead?: number;
  } = {},
) {
  const referencedLeafIds = referencedResearchCoverageLeafIds(input);
  const leafIds = new Set(options.knownLeafIds ?? referencedLeafIds);
  if (leafIds.size === 0) {
    researchCoverageFail("Stored researchCoverage has no referenced leaves");
  }
  if (
    options.totalLeafCount !== undefined &&
    (!Number.isSafeInteger(options.totalLeafCount) ||
      options.totalLeafCount < 1 ||
      leafIds.size > options.totalLeafCount)
  ) {
    researchCoverageFail(
      "Stored researchCoverage leaf references are inconsistent",
    );
  }
  const coverage = parseInitialResearchCoverage(input, leafIds);
  if (
    options.expectedUploadsRead !== undefined &&
    coverage.uploadsRead !== options.expectedUploadsRead
  ) {
    researchCoverageFail(
      `researchCoverage.uploadsRead must equal the ${options.expectedUploadsRead} customer uploads admitted for the initial turn`,
    );
  }
  return coverage;
}

export function validateKnowledgeBaseManifestForTreePolicy(
  manifest: KnowledgeBaseManifestEnvelope,
  treePolicyVersion: unknown,
  options: { expectedUploadsRead?: number } = {},
): KnowledgeBaseManifestEnvelope {
  const normalizedManifest = parseManifestEnvelopeObject(manifest);
  const policy = knowledgeBaseTreePolicy(treePolicyVersion);
  const leaves = validateKnowledgeBaseLeafManifestForTreePolicy(
    normalizedManifest.leaves,
    policy.version,
  );
  if (policy.version === KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP) {
    if (!normalizedManifest.researchCoverage) {
      researchCoverageFail("Tree policy v2 requires researchCoverage");
    }
    if (
      options.expectedUploadsRead !== undefined &&
      normalizedManifest.researchCoverage.uploadsRead !==
        options.expectedUploadsRead
    ) {
      researchCoverageFail(
        `researchCoverage.uploadsRead must equal the ${options.expectedUploadsRead} customer uploads admitted for the initial turn`,
      );
    }
  }
  return { ...normalizedManifest, leaves };
}

function parseManifestEnvelopeObject(
  input: unknown,
): KnowledgeBaseManifestEnvelope {
  if (!isPlainObject(input)) {
    fail("INVALID_MANIFEST", "Manifest envelope must be an object");
  }
  const unexpectedKeys = Object.keys(input).filter(
    (key) =>
      ![
        "kind",
        "schemaVersion",
        "operationId",
        "turnId",
        "leaves",
        "officialLogo",
        "researchCoverage",
      ].includes(key),
  );
  if (unexpectedKeys.length > 0) {
    fail(
      "INVALID_MANIFEST",
      `Manifest envelope contains unsupported fields: ${unexpectedKeys.join(", ")}`,
    );
  }
  if (input.kind !== KNOWLEDGE_BASE_MANIFEST_KIND) {
    fail("INVALID_MANIFEST", "Manifest envelope kind is invalid");
  }
  let identity: ReturnType<typeof parseProtocolIdentity>;
  try {
    identity = parseProtocolIdentity(input);
  } catch (error) {
    if (error instanceof KnowledgeBaseProgressError) {
      fail("INVALID_MANIFEST", error.message);
    }
    throw error;
  }
  if (!Array.isArray(input.leaves)) {
    fail("INVALID_MANIFEST", "Manifest envelope leaves must be an array");
  }
  let officialLogo: KnowledgeBaseOfficialLogoProvenance | undefined;
  if (input.officialLogo !== undefined) {
    if (
      identity.schemaVersion !== KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION ||
      !isPlainObject(input.officialLogo)
    ) {
      fail("INVALID_MANIFEST", "Manifest officialLogo is invalid");
    }
    const value = input.officialLogo as Record<string, unknown>;
    const sourceKind = value.sourceKind;
    const validHttpUrl = (candidate: unknown) => {
      try {
        const parsed = new URL(String(candidate || ""));
        return (
          (parsed.protocol === "https:" || parsed.protocol === "http:") &&
          !parsed.username &&
          !parsed.password
        );
      } catch {
        return false;
      }
    };
    if (sourceKind === "official_web") {
      assertOnlyKeys(
        value,
        ["sourceKind", "sourcePageUrl", "sourceAssetUrl"],
        "Manifest officialLogo",
      );
      if (
        !validHttpUrl(value.sourcePageUrl) ||
        !validHttpUrl(value.sourceAssetUrl)
      ) {
        fail(
          "INVALID_MANIFEST",
          "Manifest official-web Logo requires exact page and asset URLs",
        );
      }
      officialLogo = {
        sourceKind,
        sourcePageUrl: String(value.sourcePageUrl),
        sourceAssetUrl: String(value.sourceAssetUrl),
      };
    } else if (sourceKind === "official_document") {
      assertOnlyKeys(
        value,
        ["sourceKind", "sourceDocumentPath"],
        "Manifest officialLogo",
      );
      const sourceDocumentPath = String(value.sourceDocumentPath || "").trim();
      if (
        !sourceDocumentPath ||
        sourceDocumentPath.length > 1_024 ||
        /[\0\r\n]/u.test(sourceDocumentPath)
      ) {
        fail(
          "INVALID_MANIFEST",
          "Manifest official-document Logo requires one exact document path",
        );
      }
      officialLogo = { sourceKind, sourceDocumentPath };
    } else {
      fail("INVALID_MANIFEST", "Manifest officialLogo sourceKind is invalid");
    }
  }
  const leaves = validateProductionManifestStructure(
    input.leaves as KnowledgeBaseLeafManifestEntry[],
  );
  const researchCoverage =
    input.researchCoverage === undefined
      ? undefined
      : parseInitialResearchCoverage(
          input.researchCoverage,
          new Set(leaves.map((leaf) => leaf.id)),
        );
  return {
    kind: KNOWLEDGE_BASE_MANIFEST_KIND,
    ...identity,
    leaves,
    ...(officialLogo ? { officialLogo } : {}),
    ...(researchCoverage ? { researchCoverage } : {}),
  };
}

function parseProtocolEnvelopeText<T>(
  input: string,
  options: {
    marker: string;
    kind: string;
    code: "INVALID_MANIFEST" | "INVALID_ENVELOPE";
    label: string;
    parseObject: (value: unknown) => T;
  },
): T {
  const maxProtocolTextCharacters = 2 * 1024 * 1024;
  const maxProtocolCandidateCharacters = 1024 * 1024;
  const maxProtocolCandidates = 16;
  if (input.length > maxProtocolTextCharacters) {
    fail(options.code, `${options.label} envelope exceeds the parser limit`);
  }
  const markerPattern = new RegExp(
    `<!--\\s*${options.marker}\\s*([\\s\\S]*?)-->`,
    "gi",
  );
  const markerMatches = [...input.matchAll(markerPattern)];
  const markerOpenings = [
    ...input.matchAll(new RegExp(`<!--\\s*${options.marker}\\b`, "gi")),
  ];

  // Do not recover JSON from an unfinished HTML comment. During streaming the
  // JSON object can become syntactically complete several chunks before the
  // provider appends `-->`; accepting it here advances the state without the
  // companion presentation/resources that belong to the same turn.
  if (markerOpenings.length !== markerMatches.length) {
    fail(options.code, `${options.label} envelope is not closed`);
  }

  const outsideDocumentedMarkers = input.replace(markerPattern, "\n");
  const kindPattern = /"kind"\s*:\s*"([^"\r\n]{1,128})"/gu;
  const occurrences = [...outsideDocumentedMarkers.matchAll(kindPattern)]
    .map((match) => ({
      kind: match[1]!,
      start: outsideDocumentedMarkers.lastIndexOf("{", match.index),
    }))
    .filter(
      (match) =>
        match.start >= 0 &&
        (match.kind.startsWith("frontmind.knowledge-base.") ||
          match.kind === "frontmind.workflow-state"),
    );
  const bareCandidates = occurrences.flatMap((occurrence, index) => {
    if (occurrence.kind !== options.kind) return [];
    const nextStart = occurrences
      .slice(index + 1)
      .map((candidate) => candidate.start)
      .find((candidateStart) => candidateStart > occurrence.start);
    return [
      outsideDocumentedMarkers.slice(
        occurrence.start,
        nextStart ?? outsideDocumentedMarkers.length,
      ),
    ];
  });
  const candidateByText = new Map<
    string,
    { raw: string; documentedMarker: boolean }
  >();
  for (const match of markerMatches) {
    const raw = match[1]!.trim();
    if (raw) candidateByText.set(raw, { raw, documentedMarker: true });
  }
  for (const candidate of bareCandidates) {
    const raw = candidate.trim();
    if (!raw || candidateByText.has(raw)) continue;
    candidateByText.set(raw, { raw, documentedMarker: false });
  }
  const rawCandidates = [...candidateByText.values()];
  if (
    rawCandidates.length === 0 ||
    rawCandidates.length > maxProtocolCandidates
  ) {
    fail(
      options.code,
      `Model output must contain exactly one ${options.marker} envelope`,
    );
  }

  const validCandidates = new Map<
    string,
    { value: T; ruleCodes: ModelOutputRepairRuleCode[] }
  >();
  let invalidBareCandidateCount = 0;
  for (const candidate of rawCandidates) {
    const rawCandidate = candidate.raw;
    if (rawCandidate.length > maxProtocolCandidateCharacters) {
      if (candidate.documentedMarker) {
        fail(
          options.code,
          `${options.label} envelope exceeds the parser limit`,
        );
      }
      invalidBareCandidateCount += 1;
      continue;
    }
    let value: unknown;
    let ruleCodes: ModelOutputRepairRuleCode[] = [];
    try {
      value = parseExactJson(rawCandidate);
    } catch {
      try {
        const repaired = repairStructuredJsonCandidate(rawCandidate, {
          fenceLanguages: ["", "json"],
          identityKeys: ["operationId", "turnId"],
        });
        value = repaired.value;
        ruleCodes = repaired.ruleCodes;
      } catch {
        if (candidate.documentedMarker) {
          fail(options.code, `${options.label} envelope contains invalid JSON`);
        }
        invalidBareCandidateCount += 1;
        continue;
      }
    }
    let parsed: T;
    try {
      parsed = options.parseObject(value);
    } catch (error) {
      if (candidate.documentedMarker) {
        if (error instanceof KnowledgeBaseProgressError) throw error;
        fail(options.code, `${options.label} envelope contains invalid JSON`);
      }
      invalidBareCandidateCount += 1;
      continue;
    }
    const canonical = JSON.stringify(parsed);
    const existing = validCandidates.get(canonical);
    validCandidates.set(canonical, {
      value: existing?.value ?? parsed,
      ruleCodes: Array.from(
        new Set([...(existing?.ruleCodes ?? []), ...ruleCodes]),
      ),
    });
  }

  if (validCandidates.size === 0) {
    fail(options.code, `${options.label} envelope contains invalid JSON`);
  }
  if (validCandidates.size !== 1) {
    fail(
      options.code,
      `Model output must contain exactly one ${options.marker} envelope`,
    );
  }
  const accepted = [...validCandidates.entries()][0]!;
  const repairKinds = Array.from(
    new Set(
      [...validCandidates.values()].flatMap((candidate) => candidate.ruleCodes),
    ),
  );
  if (
    repairKinds.length > 0 ||
    rawCandidates.length > 1 ||
    invalidBareCandidateCount > 0
  ) {
    console.info(
      "[KnowledgeBaseProtocolParser]",
      JSON.stringify({
        parserVersion: 3,
        label: options.label,
        candidateCount: rawCandidates.length,
        invalidCandidateCount: invalidBareCandidateCount,
        documentedMarkerCandidateCount: rawCandidates.filter(
          (candidate) => candidate.documentedMarker,
        ).length,
        repairKinds,
        canonicalSha256: createHash("sha256")
          .update(accepted[0], "utf8")
          .digest("hex"),
      }),
    );
  }
  return accepted[1].value;
}

/** Parses the one production manifest emitted after the research phase. */
export function parseKnowledgeBaseManifestEnvelope(
  input: unknown,
): KnowledgeBaseManifestEnvelope {
  if (typeof input !== "string") {
    return parseManifestEnvelopeObject(input);
  }
  return parseProtocolEnvelopeText(input, {
    marker: KNOWLEDGE_BASE_MANIFEST_MARKER,
    kind: KNOWLEDGE_BASE_MANIFEST_KIND,
    code: "INVALID_MANIFEST",
    label: "Manifest",
    parseObject: parseManifestEnvelopeObject,
  });
}

export function formatKnowledgeBaseManifestEnvelope(
  envelope: KnowledgeBaseManifestEnvelope,
): string {
  const parsed = parseManifestEnvelopeObject(envelope);
  return `<!-- ${KNOWLEDGE_BASE_MANIFEST_MARKER}\n${JSON.stringify(parsed)}\n-->`;
}

function parseReopenEnvelopeObject(
  input: unknown,
): KnowledgeBaseReopenEnvelope {
  if (!isPlainObject(input)) {
    fail("INVALID_ENVELOPE", "Reopen envelope must be an object");
  }
  assertOnlyKeys(
    input,
    [
      "kind",
      "schemaVersion",
      "operationId",
      "turnId",
      "revision",
      "leafId",
      "reason",
    ],
    "Reopen envelope",
  );
  if (input.kind !== KNOWLEDGE_BASE_REOPEN_KIND) {
    fail("INVALID_ENVELOPE", "Reopen envelope kind is invalid");
  }
  const identity = parseProtocolIdentity(input);
  if (identity.schemaVersion === KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION) {
    fail(
      "INVALID_ENVELOPE",
      "Protocol v4 does not support reopening completed knowledge-base builds",
    );
  }
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) {
    fail(
      "INVALID_ENVELOPE",
      "Reopen envelope revision must be a non-negative integer",
    );
  }
  const leafId = typeof input.leafId === "string" ? input.leafId.trim() : "";
  if (!leafId) {
    fail("INVALID_ENVELOPE", "Reopen envelope leafId is required");
  }
  if (input.reason !== undefined && typeof input.reason !== "string") {
    fail("INVALID_ENVELOPE", "Reopen envelope reason must be a string");
  }
  return {
    kind: KNOWLEDGE_BASE_REOPEN_KIND,
    ...identity,
    revision: Number(input.revision),
    leafId,
    ...(typeof input.reason === "string"
      ? { reason: input.reason.trim() }
      : {}),
  };
}

export function parseKnowledgeBaseReopenEnvelope(
  input: unknown,
): KnowledgeBaseReopenEnvelope {
  if (typeof input !== "string") return parseReopenEnvelopeObject(input);
  return parseProtocolEnvelopeText(input, {
    marker: KNOWLEDGE_BASE_REOPEN_MARKER,
    kind: KNOWLEDGE_BASE_REOPEN_KIND,
    code: "INVALID_ENVELOPE",
    label: "Reopen",
    parseObject: parseReopenEnvelopeObject,
  });
}

export function formatKnowledgeBaseReopenEnvelope(
  envelope: KnowledgeBaseReopenEnvelope,
) {
  const parsed = parseReopenEnvelopeObject(envelope);
  return `<!-- ${KNOWLEDGE_BASE_REOPEN_MARKER}\n${JSON.stringify(parsed)}\n-->`;
}

function parsePresentationEnvelopeObject(
  input: unknown,
): KnowledgeBasePresentationEnvelope {
  if (!isPlainObject(input)) {
    fail("INVALID_ENVELOPE", "Presentation envelope must be an object");
  }
  assertOnlyKeys(
    input,
    [
      "kind",
      "schemaVersion",
      "operationId",
      "turnId",
      "revision",
      "leafId",
      "imageState",
      "assetIds",
      "imageCount",
    ],
    "Presentation envelope",
  );
  if (input.kind !== KNOWLEDGE_BASE_PRESENTATION_KIND) {
    fail("INVALID_ENVELOPE", "Presentation envelope kind is invalid");
  }
  const identity = parseProtocolIdentity(input);
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) {
    fail(
      "INVALID_ENVELOPE",
      "Presentation envelope revision must be a non-negative integer",
    );
  }
  if (input.leafId !== null && typeof input.leafId !== "string") {
    fail(
      "INVALID_ENVELOPE",
      "Presentation envelope leafId must be a string or null",
    );
  }
  const leafId =
    typeof input.leafId === "string" ? input.leafId.trim() : input.leafId;
  if (typeof input.leafId === "string" && !leafId) {
    fail("INVALID_ENVELOPE", "Presentation envelope leafId cannot be empty");
  }
  const imageState =
    input.imageState === undefined
      ? undefined
      : String(input.imageState).trim();
  if (
    imageState !== undefined &&
    !["attached", "no_eligible_asset", "not_applicable"].includes(imageState)
  ) {
    fail("INVALID_ENVELOPE", "Presentation envelope imageState is invalid");
  }
  if (
    input.assetIds !== undefined &&
    (!Array.isArray(input.assetIds) ||
      input.assetIds.some(
        (assetId) => typeof assetId !== "string" || !assetId.trim(),
      ))
  ) {
    fail("INVALID_ENVELOPE", "Presentation envelope assetIds are invalid");
  }
  const assetIds =
    input.assetIds === undefined
      ? undefined
      : Array.from(
          new Set(
            (input.assetIds as string[]).map((assetId) => assetId.trim()),
          ),
        );
  if (
    input.imageCount !== undefined &&
    (!Number.isSafeInteger(input.imageCount) ||
      Number(input.imageCount) < 0 ||
      Number(input.imageCount) > 3)
  ) {
    fail(
      "INVALID_ENVELOPE",
      "Presentation envelope imageCount must be an integer from 0 to 3",
    );
  }
  return {
    kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
    ...identity,
    revision: Number(input.revision),
    leafId: leafId as string | null,
    ...(imageState
      ? {
          imageState: imageState as NonNullable<
            KnowledgeBasePresentationEnvelope["imageState"]
          >,
        }
      : {}),
    ...(assetIds ? { assetIds } : {}),
    ...(input.imageCount !== undefined
      ? { imageCount: Number(input.imageCount) }
      : {}),
  };
}

export function parseKnowledgeBasePresentationEnvelope(
  input: unknown,
): KnowledgeBasePresentationEnvelope {
  if (typeof input !== "string") {
    return parsePresentationEnvelopeObject(input);
  }
  return parseProtocolEnvelopeText(input, {
    marker: KNOWLEDGE_BASE_PRESENTATION_MARKER,
    kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
    code: "INVALID_ENVELOPE",
    label: "Presentation",
    parseObject: parsePresentationEnvelopeObject,
  });
}

export function formatKnowledgeBasePresentationEnvelope(
  envelope: KnowledgeBasePresentationEnvelope,
) {
  const parsed = parsePresentationEnvelopeObject(envelope);
  return `<!-- ${KNOWLEDGE_BASE_PRESENTATION_MARKER}\n${JSON.stringify(parsed)}\n-->`;
}

export function assertKnowledgeBasePresentationMatchesState(
  state: KnowledgeBaseProgressState,
  input: unknown,
): KnowledgeBasePresentationEnvelope {
  assertValidKnowledgeBaseProgressState(state);
  const envelope = parseKnowledgeBasePresentationEnvelope(input);
  if (envelope.revision !== state.revision) {
    fail(
      "STALE_REVISION",
      `Expected presentation revision ${state.revision}, received ${envelope.revision}`,
    );
  }
  if (envelope.leafId !== state.currentLeafId) {
    fail(
      "WRONG_LEAF",
      state.currentLeafId
        ? `Customer reply must present current leaf ${state.currentLeafId}`
        : "Completed knowledge base must present leafId null",
    );
  }
  return envelope;
}

export function createKnowledgeBaseProgressState(
  manifest: readonly KnowledgeBaseLeafManifestEntry[],
): KnowledgeBaseProgressState {
  const normalized = validateKnowledgeBaseLeafManifest(manifest);
  return {
    schemaVersion: KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION,
    revision: 0,
    currentLeafId: normalized[0].id,
    leaves: normalized.map((leaf, index) => ({
      ...leaf,
      status: index === 0 ? "current" : "pending",
    })),
  };
}

export function assertValidKnowledgeBaseProgressState(
  state: KnowledgeBaseProgressState,
): void {
  if (!isPlainObject(state)) {
    fail("INVALID_STATE", "Progress state must be an object");
  }
  if (state.schemaVersion !== KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION) {
    fail("INVALID_STATE", "Unsupported progress state schema version");
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    fail(
      "INVALID_STATE",
      "Progress state revision must be a non-negative integer",
    );
  }
  if (!Array.isArray(state.leaves) || state.leaves.length === 0) {
    fail("INVALID_STATE", "Progress state must contain at least one leaf");
  }

  const ids = new Set<string>();
  let activeIndex = -1;

  state.leaves.forEach((leaf, index) => {
    if (
      !isPlainObject(leaf) ||
      typeof leaf.id !== "string" ||
      !leaf.id.trim()
    ) {
      fail("INVALID_STATE", `Progress leaf ${index + 1} has an invalid id`);
    }
    if (ids.has(leaf.id)) {
      fail(
        "INVALID_STATE",
        `Progress state contains duplicate leaf id ${leaf.id}`,
      );
    }
    ids.add(leaf.id);
    if (!isLeafStatus(leaf.status)) {
      fail("INVALID_STATE", `Progress leaf ${leaf.id} has an invalid status`);
    }

    const isActive =
      leaf.status === "current" || leaf.status === "needs_verification";
    if (isActive) {
      if (activeIndex !== -1) {
        fail(
          "INVALID_STATE",
          "Progress state contains more than one active leaf",
        );
      }
      activeIndex = index;
      return;
    }

    if (leaf.status === "pending") return;
  });

  if (activeIndex === -1) {
    const allHandled = state.leaves.every((leaf) =>
      isHandledStatus(leaf.status),
    );
    if (!allHandled || state.currentLeafId !== null) {
      fail(
        "INVALID_STATE",
        "A non-complete progress state must identify exactly one active leaf",
      );
    }
    return;
  }

  const activeLeaf = state.leaves[activeIndex];
  if (state.currentLeafId !== activeLeaf.id) {
    fail(
      "INVALID_STATE",
      "currentLeafId must point to the active current or needs_verification leaf",
    );
  }
  if (
    state.leaves
      .slice(0, activeIndex)
      .some((leaf) => !isHandledStatus(leaf.status))
  ) {
    fail(
      "INVALID_STATE",
      "Leaves before the active leaf must already be handled",
    );
  }
}

function parseEnvelopeObject(input: unknown): KnowledgeBaseProgressEnvelope {
  if (!isPlainObject(input)) {
    fail("INVALID_ENVELOPE", "Progress envelope must be an object");
  }
  assertOnlyKeys(
    input,
    [
      "kind",
      "schemaVersion",
      "operationId",
      "turnId",
      "revision",
      "transition",
    ],
    "Progress envelope",
  );
  if (input.kind !== KNOWLEDGE_BASE_PROGRESS_KIND) {
    fail("INVALID_ENVELOPE", "Progress envelope kind is invalid");
  }
  const identity = parseProtocolIdentity(input);
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) {
    fail(
      "INVALID_ENVELOPE",
      "Progress envelope revision must be a non-negative integer",
    );
  }

  const transition = input.transition;
  if (!isPlainObject(transition)) {
    fail(
      "INVALID_ENVELOPE",
      "Progress envelope must contain exactly one transition object",
    );
  }
  assertOnlyKeys(
    transition,
    ["leafId", "from", "to", "reason"],
    "Progress transition",
  );

  const leafId =
    typeof transition.leafId === "string" ? transition.leafId.trim() : "";
  if (!leafId) {
    fail("INVALID_ENVELOPE", "Progress transition leafId is required");
  }
  if (
    transition.from !== "current" &&
    transition.from !== "needs_verification"
  ) {
    fail(
      "INVALID_TRANSITION",
      "Progress transition can only start from current or needs_verification",
    );
  }
  if (
    transition.to !== "confirmed" &&
    transition.to !== "direct_prefilled" &&
    transition.to !== "needs_verification"
  ) {
    fail(
      "INVALID_TRANSITION",
      "Progress transition cannot jump, roll back, or return to pending/current",
    );
  }
  if (
    transition.reason !== undefined &&
    typeof transition.reason !== "string"
  ) {
    fail("INVALID_ENVELOPE", "Progress transition reason must be a string");
  }

  return {
    kind: KNOWLEDGE_BASE_PROGRESS_KIND,
    ...identity,
    revision: Number(input.revision),
    transition: {
      leafId,
      from: transition.from,
      to: transition.to,
      ...(transition.reason !== undefined
        ? { reason: transition.reason.trim() }
        : {}),
    },
  };
}

/**
 * Parses either a raw JSON envelope/object or exactly one hidden envelope from
 * model text:
 *
 * <!-- FRONTMIND_KB_PROGRESS
 * {"kind":"frontmind.knowledge-base.progress", ...}
 * -->
 */
export function parseKnowledgeBaseProgressEnvelope(
  input: unknown,
): KnowledgeBaseProgressEnvelope {
  if (typeof input !== "string") {
    return parseEnvelopeObject(input);
  }
  return parseProtocolEnvelopeText(input, {
    marker: KNOWLEDGE_BASE_PROGRESS_MARKER,
    kind: KNOWLEDGE_BASE_PROGRESS_KIND,
    code: "INVALID_ENVELOPE",
    label: "Progress",
    parseObject: parseEnvelopeObject,
  });
}

export function formatKnowledgeBaseProgressEnvelope(
  envelope: KnowledgeBaseProgressEnvelope,
): string {
  const parsed = parseEnvelopeObject(envelope);
  return `<!-- ${KNOWLEDGE_BASE_PROGRESS_MARKER}\n${JSON.stringify(parsed)}\n-->`;
}

export function validateKnowledgeBaseProgressEnvelope(
  state: KnowledgeBaseProgressState,
  input: unknown,
): KnowledgeBaseProgressEnvelope {
  assertValidKnowledgeBaseProgressState(state);
  const envelope = parseKnowledgeBaseProgressEnvelope(input);

  if (envelope.revision !== state.revision) {
    fail(
      "STALE_REVISION",
      `Expected revision ${state.revision}, received ${envelope.revision}`,
    );
  }
  if (!state.currentLeafId) {
    fail("NO_CURRENT_LEAF", "All leaves are already handled");
  }
  if (envelope.transition.leafId !== state.currentLeafId) {
    fail(
      "WRONG_LEAF",
      `Only current leaf ${state.currentLeafId} may be updated`,
    );
  }

  const currentLeaf = state.leaves.find(
    (leaf) => leaf.id === state.currentLeafId,
  );
  if (!currentLeaf) {
    fail("INVALID_STATE", "The current leaf does not exist in progress state");
  }
  if (envelope.transition.from !== currentLeaf.status) {
    fail(
      "FROM_STATUS_MISMATCH",
      `Current leaf ${currentLeaf.id} is ${currentLeaf.status}, not ${envelope.transition.from}`,
    );
  }

  return envelope;
}

export function applyKnowledgeBaseProgressEnvelope(
  state: KnowledgeBaseProgressState,
  input: unknown,
): KnowledgeBaseProgressState {
  const envelope = validateKnowledgeBaseProgressEnvelope(state, input);
  const currentIndex = state.leaves.findIndex(
    (leaf) => leaf.id === state.currentLeafId,
  );
  const targetStatus = envelope.transition.to;
  const completesCurrent = isHandledStatus(targetStatus);
  const nextIndex = completesCurrent
    ? state.leaves.findIndex(
        (leaf, index) => index > currentIndex && leaf.status === "pending",
      )
    : -1;

  const leaves = state.leaves.map((leaf, index): KnowledgeBaseLeafProgress => {
    if (index === currentIndex) {
      return { ...leaf, status: targetStatus };
    }
    if (index === nextIndex) {
      return { ...leaf, status: "current" };
    }
    return { ...leaf };
  });

  const nextState: KnowledgeBaseProgressState = {
    schemaVersion: KNOWLEDGE_BASE_PROGRESS_SCHEMA_VERSION,
    revision: state.revision + 1,
    currentLeafId: completesCurrent
      ? nextIndex === -1
        ? null
        : leaves[nextIndex].id
      : state.currentLeafId,
    leaves,
  };
  assertValidKnowledgeBaseProgressState(nextState);
  return nextState;
}

export function getKnowledgeBaseProgressSummary(
  state: KnowledgeBaseProgressState,
): KnowledgeBaseProgressSummary {
  assertValidKnowledgeBaseProgressState(state);

  const counts = {
    pending: 0,
    current: 0,
    confirmed: 0,
    directPrefilled: 0,
    needsVerification: 0,
  };
  for (const leaf of state.leaves) {
    switch (leaf.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "current":
        counts.current += 1;
        break;
      case "confirmed":
        counts.confirmed += 1;
        break;
      case "direct_prefilled":
        counts.directPrefilled += 1;
        break;
      case "needs_verification":
        counts.needsVerification += 1;
        break;
    }
  }

  const total = state.leaves.length;
  const handled = counts.confirmed + counts.directPrefilled;
  const overall = handled / total;
  return {
    total,
    ...counts,
    handled,
    overall,
    overallPercent: Math.round(overall * 100),
  };
}

/**
 * A checkmark is intentionally reserved for explicit confirmation. A directly
 * prefilled leaf is handled for overall progress but retains its own status.
 */
export function shouldShowKnowledgeBaseCheckmark(
  status: KnowledgeBaseLeafStatus,
): boolean {
  return status === "confirmed";
}

export function canPackageKnowledgeBase(
  state: KnowledgeBaseProgressState,
): boolean {
  const summary = getKnowledgeBaseProgressSummary(state);
  return summary.handled === summary.total && state.currentLeafId === null;
}

export function assertKnowledgeBaseReadyForPackage(
  state: KnowledgeBaseProgressState,
): void {
  if (!canPackageKnowledgeBase(state)) {
    const summary = getKnowledgeBaseProgressSummary(state);
    fail(
      "PACKAGING_BLOCKED",
      `Knowledge base packaging is blocked until every leaf is handled (${summary.handled}/${summary.total})`,
    );
  }
}
