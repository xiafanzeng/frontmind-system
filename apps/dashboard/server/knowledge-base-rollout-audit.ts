import { and, asc, eq, gt, gte, inArray, or, type SQL } from "drizzle-orm";

import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  type ConversationTurn,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
  type KnowledgeBaseSnapshot,
} from "../drizzle/schema";
import { isAuthenticatedAdvancedKnowledgePublication } from "./authenticated-knowledge-service";
import { getDb } from "./db";
import {
  assertKnowledgeBasePackageMatchesBuild,
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import {
  knowledgeBaseExpectedCustomerUploadsFromTurns,
  knowledgeBaseOfficialLogoProvenanceFromMetadata,
  knowledgeBaseOfficialLogoUploadFromTurn,
} from "./knowledge-base-customer-upload";
import {
  knowledgeBuildArtifactStorageKeyBelongsTo,
  readKnowledgeBuildArtifact,
} from "./knowledge-build-artifact-store";
import { readKnowledgeSnapshotArchive } from "./knowledge-snapshot-archive-store";

export const KNOWLEDGE_BASE_PRESENTATION_TIMEOUT_MS = 60 * 60 * 1_000;
export const KNOWLEDGE_BASE_LEASE_EXPIRY_GRACE_MS = 5 * 60 * 1_000;
export const KNOWLEDGE_BASE_READY_PUBLISH_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export type KnowledgeBaseRolloutAuditViolation = {
  code: string;
  buildId: string;
  generation: number;
  turnId?: string;
  leafId?: string;
};

export type KnowledgeBaseRolloutAuditDataset = {
  builds: readonly KnowledgeBaseBuild[];
  turns: readonly ConversationTurn[];
  nodes: readonly KnowledgeBaseBuildNode[];
  snapshots: readonly KnowledgeBaseSnapshot[];
};

type RolloutAuditDependencies = {
  readBuildArtifact: typeof readKnowledgeBuildArtifact;
  readSnapshotArchive: typeof readKnowledgeSnapshotArchive;
};

type RolloutAuditOptions = {
  now?: Date;
  since?: Date;
  presentationTimeoutMs?: number;
  leaseExpiryGraceMs?: number;
  readyPublishTimeoutMs?: number;
};

const SETTLED_TURN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const LIVE_TURN_STATUSES = new Set(["queued", "running"]);
const OPEN_BUILD_STATUSES = new Set(["researching", "confirming"]);
const STALE_OR_DUPLICATE_ERROR =
  /(?:STALE_(?:REVISION|OPERATION|TASK|GENERATION)|DUPLICATE|ALREADY_(?:APPLIED|PROCESSED)|本轮内容已处理|无需重复更新)/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function normalizedSha256(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function validSha256(value: unknown) {
  return SHA256_PATTERN.test(normalizedSha256(value));
}

function snapshotUsesV4OnlyUploadContract(input: {
  assets: readonly unknown[];
  expectedCustomerUploadCount: number;
  expectedOfficialLogoUploadCount: number;
}) {
  if (
    input.expectedCustomerUploadCount > 0 ||
    input.expectedOfficialLogoUploadCount > 0
  ) {
    return true;
  }
  return input.assets.some((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      return false;
    }
    const value = asset as Record<string, unknown>;
    if (
      value.sourceKind === "user_upload" ||
      value.sourceKind === "official_logo_upload"
    ) {
      return true;
    }
    return [
      "sourceUploadIndex",
      "sourceUploadFileId",
      "sourceUploadSha256",
      "sourceUploadFilename",
      "sourceUploadMimeType",
      "sourceUploadSizeBytes",
    ].some((key) => value[key] !== undefined);
  });
}

function completeLogoBinding(build: KnowledgeBaseBuild) {
  return Boolean(
    build.logoStorageKey &&
      validSha256(build.logoSha256) &&
      validPositiveInteger(build.logoBytes) &&
      build.logoFilename &&
      build.logoMimeType,
  );
}

function completePackageBinding(build: KnowledgeBaseBuild) {
  return Boolean(
    build.packageStorageKey &&
      validSha256(build.packageArchiveSha256) &&
      validPositiveInteger(build.packageSizeBytes) &&
      build.packageRevision === build.revision,
  );
}

function timestamp(value: Date | null | undefined) {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.getTime()
    : null;
}

function appendViolation(
  violations: KnowledgeBaseRolloutAuditViolation[],
  seen: Set<string>,
  violation: KnowledgeBaseRolloutAuditViolation,
) {
  const identity = [
    violation.code,
    violation.buildId,
    violation.generation,
    violation.turnId || "",
    violation.leafId || "",
  ].join("\u0000");
  if (seen.has(identity)) return;
  seen.add(identity);
  violations.push(violation);
}

function currentNodeForBuild(
  build: KnowledgeBaseBuild,
  nodes: readonly KnowledgeBaseBuildNode[],
) {
  if (!build.currentLeafId) return null;
  return nodes.find((node) => node.leafId === build.currentLeafId) || null;
}

function approvedPresentationExists(input: {
  build: KnowledgeBaseBuild;
  currentNode: KnowledgeBaseBuildNode | null;
  activeTurn: ConversationTurn | null;
}) {
  const { build, currentNode, activeTurn } = input;
  if (
    !currentNode ||
    !canonicalKnowledgeBaseMarkdown(currentNode.contentMarkdown || "")
  ) {
    return false;
  }
  if (
    build.activeTurnId &&
    (!activeTurn ||
      activeTurn.buildId !== build.id ||
      activeTurn.buildGeneration !== build.generation)
  ) {
    return false;
  }
  const handled = build.confirmedCount + build.directPrefilledCount;
  if (
    build.skillVersion === "4" &&
    build.revision === 0 &&
    handled === 0 &&
    (currentNode.ordinal !== 0 || !completeLogoBinding(build))
  ) {
    return false;
  }
  return true;
}

function storageKeyMatches(
  build: KnowledgeBaseBuild,
  kind: "logo" | "package",
) {
  try {
    const storageKey =
      kind === "logo" ? build.logoStorageKey : build.packageStorageKey;
    return Boolean(
      storageKey &&
        knowledgeBuildArtifactStorageKeyBelongsTo({
          storageKey,
          userId: build.userId,
          buildId: build.id,
          generation: build.generation,
          kind,
        }),
    );
  } catch {
    return false;
  }
}

/**
 * Pure, content-safe rollout checks. Violations contain stable identifiers and
 * codes only; customer Markdown, protocol output, URLs and credentials never
 * enter the result.
 */
export function findKnowledgeBaseRolloutViolations(
  dataset: KnowledgeBaseRolloutAuditDataset,
  options: RolloutAuditOptions = {},
) {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const sinceMs = timestamp(options.since);
  const presentationTimeoutMs =
    options.presentationTimeoutMs ?? KNOWLEDGE_BASE_PRESENTATION_TIMEOUT_MS;
  const leaseExpiryGraceMs =
    options.leaseExpiryGraceMs ?? KNOWLEDGE_BASE_LEASE_EXPIRY_GRACE_MS;
  const readyPublishTimeoutMs =
    options.readyPublishTimeoutMs ?? KNOWLEDGE_BASE_READY_PUBLISH_TIMEOUT_MS;
  const violations: KnowledgeBaseRolloutAuditViolation[] = [];
  const seen = new Set<string>();
  const turnsByBuild = new Map<string, ConversationTurn[]>();
  const nodesByBuild = new Map<string, KnowledgeBaseBuildNode[]>();
  const snapshotsById = new Map(
    dataset.snapshots.map((snapshot) => [snapshot.id, snapshot]),
  );

  for (const turn of dataset.turns) {
    if (!turn.buildId) continue;
    const turns = turnsByBuild.get(turn.buildId) || [];
    turns.push(turn);
    turnsByBuild.set(turn.buildId, turns);
  }
  for (const node of dataset.nodes) {
    const nodes = nodesByBuild.get(node.buildId) || [];
    nodes.push(node);
    nodesByBuild.set(node.buildId, nodes);
  }

  const turnsByOperation = new Map<string, ConversationTurn[]>();
  for (const turn of dataset.turns) {
    const operationKey = String(turn.operationKey || "").trim();
    if (!operationKey) continue;
    const turns = turnsByOperation.get(operationKey) || [];
    turns.push(turn);
    turnsByOperation.set(operationKey, turns);
  }
  for (const turns of turnsByOperation.values()) {
    const upstreamTaskIds = new Set(
      turns
        .map((turn) => String(turn.upstreamTaskId || "").trim())
        .filter(Boolean),
    );
    if (upstreamTaskIds.size <= 1) continue;
    for (const turn of turns) {
      if (!turn.buildId || turn.buildGeneration === null) continue;
      appendViolation(violations, seen, {
        code: "OPERATION_MULTIPLE_UPSTREAM_TASKS",
        buildId: turn.buildId,
        generation: turn.buildGeneration,
        turnId: turn.id,
      });
    }
  }

  for (const build of dataset.builds) {
    const turns = turnsByBuild.get(build.id) || [];
    const nodes = nodesByBuild.get(build.id) || [];
    const generationTurns = turns.filter(
      (turn) => turn.buildGeneration === build.generation,
    );
    for (const turn of generationTurns) {
      if (
        (sinceMs === null || (timestamp(turn.updatedAt) ?? 0) >= sinceMs) &&
        STALE_OR_DUPLICATE_ERROR.test(
          `${turn.errorCode || ""}\n${turn.errorMessage || ""}`,
        )
      ) {
        appendViolation(violations, seen, {
          code: "STALE_OR_DUPLICATE_PROTOCOL_ERROR",
          buildId: build.id,
          generation: build.generation,
          turnId: turn.id,
        });
      }
    }
    const liveTurns = generationTurns.filter((turn) =>
      LIVE_TURN_STATUSES.has(turn.status),
    );
    if (liveTurns.length > 1) {
      appendViolation(violations, seen, {
        code: "MULTIPLE_ACTIVE_TURNS",
        buildId: build.id,
        generation: build.generation,
      });
    }

    const activeTurn = build.activeTurnId
      ? turns.find((turn) => turn.id === build.activeTurnId) || null
      : null;
    if (
      build.activeTurnId &&
      (!activeTurn ||
        activeTurn.buildId !== build.id ||
        activeTurn.buildGeneration !== build.generation)
    ) {
      appendViolation(violations, seen, {
        code: "INVALID_ACTIVE_TURN",
        buildId: build.id,
        generation: build.generation,
        turnId: build.activeTurnId,
      });
    }
    if (
      activeTurn &&
      SETTLED_TURN_STATUSES.has(activeTurn.status) &&
      OPEN_BUILD_STATUSES.has(build.status)
    ) {
      appendViolation(violations, seen, {
        code: "SETTLED_TURN_NOT_CONVERGED",
        buildId: build.id,
        generation: build.generation,
        turnId: activeTurn.id,
      });
    }

    for (const turn of liveTurns) {
      const leaseExpiresAt = timestamp(turn.leaseExpiresAt);
      if (
        leaseExpiresAt !== null &&
        leaseExpiresAt <= nowMs - leaseExpiryGraceMs
      ) {
        appendViolation(violations, seen, {
          code: "EXPIRED_TURN_LEASE",
          buildId: build.id,
          generation: build.generation,
          turnId: turn.id,
        });
      }
    }

    const currentRows = nodes.filter(
      (node) =>
        node.status === "current" || node.status === "needs_verification",
    );
    if (
      (build.currentLeafId &&
        (currentRows.length !== 1 ||
          currentRows[0]!.leafId !== build.currentLeafId)) ||
      (!build.currentLeafId && currentRows.length !== 0)
    ) {
      appendViolation(violations, seen, {
        code: "CURRENT_LEAF_MISMATCH",
        buildId: build.id,
        generation: build.generation,
      });
    }
    const currentNode = currentNodeForBuild(build, nodes);
    const approvedPresentation = approvedPresentationExists({
      build,
      currentNode,
      activeTurn,
    });
    const awaitingInput = Boolean(
      build.status === "confirming" &&
        build.currentLeafId &&
        build.awaitingResponseSince === null,
    );
    if (awaitingInput && !approvedPresentation) {
      appendViolation(violations, seen, {
        code: "AWAITING_INPUT_WITHOUT_APPROVED_PRESENTATION",
        buildId: build.id,
        generation: build.generation,
        leafId: build.currentLeafId || undefined,
      });
    }

    if (OPEN_BUILD_STATUSES.has(build.status)) {
      const waitingSince =
        timestamp(build.awaitingResponseSince) ??
        timestamp(activeTurn?.startedAt) ??
        timestamp(activeTurn?.createdAt) ??
        timestamp(build.updatedAt) ??
        timestamp(build.createdAt);
      const waitingForNewPresentation = Boolean(
        build.awaitingResponseSince || !approvedPresentation,
      );
      if (
        waitingForNewPresentation &&
        waitingSince !== null &&
        waitingSince <= nowMs - presentationTimeoutMs
      ) {
        appendViolation(violations, seen, {
          code: "PRESENTATION_TIMEOUT",
          buildId: build.id,
          generation: build.generation,
          ...(activeTurn ? { turnId: activeTurn.id } : {}),
          ...(build.currentLeafId ? { leafId: build.currentLeafId } : {}),
        });
      }
    }

    if (
      build.status === "protocol_error" &&
      STALE_OR_DUPLICATE_ERROR.test(
        `${build.protocolErrorCode || ""}\n${build.protocolError || ""}`,
      )
    ) {
      appendViolation(violations, seen, {
        code: "STALE_OR_DUPLICATE_PROTOCOL_ERROR",
        buildId: build.id,
        generation: build.generation,
      });
    }

    for (const node of nodes) {
      const canonical = canonicalKnowledgeBaseMarkdown(
        node.contentMarkdown || "",
      );
      const expectsContent = [
        "current",
        "confirmed",
        "direct_prefilled",
        "needs_verification",
      ].includes(node.status);
      if (!canonical && expectsContent) {
        appendViolation(violations, seen, {
          code: "NODE_CONTENT_MISSING",
          buildId: build.id,
          generation: build.generation,
          leafId: node.leafId,
        });
        continue;
      }
      if (!canonical) {
        if (node.contentSha256) {
          appendViolation(violations, seen, {
            code: "NODE_HASH_MISMATCH",
            buildId: build.id,
            generation: build.generation,
            leafId: node.leafId,
          });
        }
        continue;
      }
      if (!validSha256(node.contentSha256)) {
        appendViolation(violations, seen, {
          code: "NODE_HASH_MISSING",
          buildId: build.id,
          generation: build.generation,
          leafId: node.leafId,
        });
      } else if (
        normalizedSha256(node.contentSha256) !==
        knowledgeBaseMarkdownSha256(canonical)
      ) {
        appendViolation(violations, seen, {
          code: "NODE_HASH_MISMATCH",
          buildId: build.id,
          generation: build.generation,
          leafId: node.leafId,
        });
      }
    }

    if (
      currentNode?.presentationKey &&
      build.currentPresentationKey &&
      currentNode.presentationKey !== build.currentPresentationKey
    ) {
      appendViolation(violations, seen, {
        code: "PRESENTATION_KEY_MISMATCH",
        buildId: build.id,
        generation: build.generation,
        leafId: currentNode.leafId,
      });
    }

    const logoFieldsPresent = Boolean(
      build.logoStorageKey ||
        build.logoSha256 ||
        build.logoBytes ||
        build.logoFilename ||
        build.logoMimeType,
    );
    const shouldHaveLogo =
      build.skillVersion === "4" && nodes.some((node) => node.contentMarkdown);
    if (
      (logoFieldsPresent || shouldHaveLogo) &&
      (!completeLogoBinding(build) || !storageKeyMatches(build, "logo"))
    ) {
      appendViolation(violations, seen, {
        code: "LOGO_BINDING_INVALID",
        buildId: build.id,
        generation: build.generation,
      });
    }

    const packageFieldsPresent = Boolean(
      build.packageStorageKey ||
        build.packageArchiveSha256 ||
        build.packageSizeBytes ||
        build.packageRevision !== null,
    );
    const shouldHavePackage =
      build.status === "ready_to_publish" || build.status === "published";
    if (
      (packageFieldsPresent || shouldHavePackage) &&
      (!completePackageBinding(build) || !storageKeyMatches(build, "package"))
    ) {
      appendViolation(violations, seen, {
        code: "PACKAGE_BINDING_INVALID",
        buildId: build.id,
        generation: build.generation,
      });
    }

    if (build.status === "ready_to_publish") {
      const readySince =
        timestamp(build.completedAt) ?? timestamp(build.updatedAt);
      if (readySince !== null && readySince <= nowMs - readyPublishTimeoutMs) {
        appendViolation(violations, seen, {
          code: "READY_PUBLICATION_TIMEOUT",
          buildId: build.id,
          generation: build.generation,
        });
      }
    }

    if (build.status === "published") {
      const snapshot = build.publishedSnapshotId
        ? snapshotsById.get(build.publishedSnapshotId) || null
        : null;
      const snapshotDocuments = Array.isArray(snapshot?.documents)
        ? snapshot.documents
        : null;
      const snapshotAssets = Array.isArray(snapshot?.assets)
        ? snapshot.assets
        : null;
      if (
        !snapshot ||
        !snapshotDocuments ||
        !snapshotAssets ||
        !isAuthenticatedAdvancedKnowledgePublication({
          snapshot,
          build,
          notBefore: new Date(0),
        }) ||
        snapshot.totalBytes !== build.packageSizeBytes ||
        snapshot.documentCount !== snapshotDocuments.length ||
        snapshot.imageCount !== snapshotAssets.length
      ) {
        appendViolation(violations, seen, {
          code: "PUBLICATION_BINDING_INVALID",
          buildId: build.id,
          generation: build.generation,
        });
      } else {
        try {
          const expectedCustomerUploads =
            knowledgeBaseExpectedCustomerUploadsFromTurns(generationTurns, {
              excludedSourceSha256: build.logoSha256,
            });
          const officialLogoUploads = generationTurns
            .map(knowledgeBaseOfficialLogoUploadFromTurn)
            .filter((value) => value !== null);
          const officialLogoProvenances = generationTurns
            .map((turn) =>
              knowledgeBaseOfficialLogoProvenanceFromMetadata(turn.metadata),
            )
            .filter((value) => value !== null);
          if (
            officialLogoUploads.length > 1 ||
            officialLogoProvenances.length > 1
          ) {
            throw new Error("官方主 Logo 来源账本不唯一");
          }
          const binding = {
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
            documents: snapshotDocuments as Parameters<
              typeof assertKnowledgeBasePackageMatchesBuild
            >[0]["documents"],
            assets: snapshotAssets as Parameters<
              typeof assertKnowledgeBasePackageMatchesBuild
            >[0]["assets"],
            expectedLogoSha256: String(build.logoSha256 || ""),
            legacyV3Compatibility: false,
          } satisfies Omit<
            Parameters<typeof assertKnowledgeBasePackageMatchesBuild>[0],
            | "packageSchemaVersion"
            | "expectedCustomerUploads"
            | "expectedOfficialLogoUpload"
            | "expectedOfficialLogoProvenance"
            | "legacyV4ReadCompatibility"
          >;
          if (build.skillVersion !== "4") {
            assertKnowledgeBasePackageMatchesBuild({
              ...binding,
              packageSchemaVersion: 3,
              expectedCustomerUploads: [],
            });
          } else {
            try {
              assertKnowledgeBasePackageMatchesBuild({
                ...binding,
                packageSchemaVersion: 4,
                expectedCustomerUploads,
                expectedOfficialLogoUpload: officialLogoUploads[0],
                expectedOfficialLogoProvenance: officialLogoProvenances[0],
                legacyV4ReadCompatibility: true,
              });
            } catch (error) {
              // Snapshots created before schemaVersion was persisted cannot
              // distinguish v4/schema3 from v4/schema4 by build metadata.
              // Never fall back when any customer-upload-only marker exists;
              // otherwise retry exactly the old schema3 constraints (raw IDs,
              // exact order/content and one byte-bound Logo, no v4 ledger).
              if (
                snapshotUsesV4OnlyUploadContract({
                  assets: snapshotAssets,
                  expectedCustomerUploadCount: expectedCustomerUploads.length,
                  expectedOfficialLogoUploadCount: officialLogoUploads.length,
                })
              ) {
                throw error;
              }
              assertKnowledgeBasePackageMatchesBuild({
                ...binding,
                packageSchemaVersion: 3,
                expectedCustomerUploads: [],
              });
            }
          }
        } catch {
          appendViolation(violations, seen, {
            code: "PUBLISHED_PACKAGE_NODE_HASH_MISMATCH",
            buildId: build.id,
            generation: build.generation,
          });
        }
      }
    }
  }

  return violations;
}

/** Verify exact bytes used by Logo, final ZIP, publish and customer download. */
export async function findKnowledgeBaseRolloutArtifactViolations(
  dataset: KnowledgeBaseRolloutAuditDataset,
  dependencies: RolloutAuditDependencies = {
    readBuildArtifact: readKnowledgeBuildArtifact,
    readSnapshotArchive: readKnowledgeSnapshotArchive,
  },
) {
  const violations: KnowledgeBaseRolloutAuditViolation[] = [];
  const seen = new Set<string>();
  const snapshotsById = new Map(
    dataset.snapshots.map((snapshot) => [snapshot.id, snapshot]),
  );

  for (const build of dataset.builds) {
    if (completeLogoBinding(build) && storageKeyMatches(build, "logo")) {
      try {
        await dependencies.readBuildArtifact({
          userId: build.userId,
          buildId: build.id,
          generation: build.generation,
          kind: "logo",
          expectedSha256: build.logoSha256!,
          expectedBytes: build.logoBytes!,
          storageKey: build.logoStorageKey!,
        });
      } catch {
        appendViolation(violations, seen, {
          code: "LOGO_INTEGRITY_MISMATCH",
          buildId: build.id,
          generation: build.generation,
        });
      }
    }

    if (
      (build.status === "ready_to_publish" || build.status === "published") &&
      completePackageBinding(build) &&
      storageKeyMatches(build, "package")
    ) {
      try {
        await dependencies.readBuildArtifact({
          userId: build.userId,
          buildId: build.id,
          generation: build.generation,
          kind: "package",
          expectedSha256: build.packageArchiveSha256!,
          expectedBytes: build.packageSizeBytes!,
          storageKey: build.packageStorageKey!,
        });
      } catch {
        appendViolation(violations, seen, {
          code: "PACKAGE_INTEGRITY_MISMATCH",
          buildId: build.id,
          generation: build.generation,
        });
      }
    }

    if (build.status !== "published" || !build.publishedSnapshotId) continue;
    const snapshot = snapshotsById.get(build.publishedSnapshotId);
    if (
      !snapshot ||
      !validSha256(snapshot.archiveHash) ||
      !validPositiveInteger(snapshot.totalBytes)
    ) {
      continue;
    }
    try {
      await dependencies.readSnapshotArchive({
        userId: build.userId,
        snapshotId: snapshot.id,
        expectedSha256: snapshot.archiveHash!,
        expectedBytes: snapshot.totalBytes,
      });
    } catch {
      appendViolation(violations, seen, {
        code: "PUBLISHED_DOWNLOAD_FAILED",
        buildId: build.id,
        generation: build.generation,
      });
    }
  }
  return violations;
}

async function loadRolloutAuditDataset(since: Date) {
  const db = await getDb();
  if (!db) throw new Error("KB_ROLLOUT_DATABASE_UNAVAILABLE");
  return db.transaction(async (tx) => {
    const builds: KnowledgeBaseBuild[] = [];
    const turns: ConversationTurn[] = [];
    const nodes: KnowledgeBaseBuildNode[] = [];
    const snapshots: KnowledgeBaseSnapshot[] = [];
    let afterBuildId: string | null = null;

    for (;;) {
      const rolloutWindow = or(
        gte(knowledgeBaseBuilds.updatedAt, since),
        // Never let --since hide an unresolved pre-window P0 which is still
        // capable of blocking or corrupting the current rollout.
        inArray(knowledgeBaseBuilds.status, [
          "researching",
          "confirming",
          "ready_to_publish",
          "protocol_error",
        ]),
      );
      const buildWhere: SQL | undefined = afterBuildId
        ? and(
            eq(knowledgeBaseBuilds.skillVersion, "4"),
            rolloutWindow,
            gt(knowledgeBaseBuilds.id, afterBuildId),
          )
        : and(eq(knowledgeBaseBuilds.skillVersion, "4"), rolloutWindow);
      const page: KnowledgeBaseBuild[] = await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(buildWhere)
        .orderBy(asc(knowledgeBaseBuilds.id))
        .limit(500);
      if (page.length === 0) break;
      builds.push(...page);
      const buildIds = page.map((build) => build.id);
      const [pageTurns, pageNodes, pageSnapshots] = await Promise.all([
        tx
          .select()
          .from(conversationTurns)
          .where(inArray(conversationTurns.buildId, buildIds)),
        tx
          .select()
          .from(knowledgeBaseBuildNodes)
          .where(inArray(knowledgeBaseBuildNodes.buildId, buildIds)),
        tx
          .select()
          .from(knowledgeBaseSnapshots)
          .where(inArray(knowledgeBaseSnapshots.sourceBuildId, buildIds)),
      ]);
      turns.push(...pageTurns);
      nodes.push(...pageNodes);
      snapshots.push(...pageSnapshots);
      afterBuildId = page.at(-1)!.id;
      if (page.length < 500) break;
    }

    // operationKey is globally unique in the migrated schema, but querying all
    // matching rows (not only selected builds) also catches a damaged/missing
    // unique index or a legacy duplicate that crosses the rollout time window.
    const operationKeys = Array.from(
      new Set(
        turns
          .map((turn) => String(turn.operationKey || "").trim())
          .filter(Boolean),
      ),
    );
    const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
    for (let offset = 0; offset < operationKeys.length; offset += 500) {
      const operationRows = await tx
        .select()
        .from(conversationTurns)
        .where(
          inArray(
            conversationTurns.operationKey,
            operationKeys.slice(offset, offset + 500),
          ),
        );
      for (const turn of operationRows) turnsById.set(turn.id, turn);
    }
    return { builds, turns: [...turnsById.values()], nodes, snapshots };
  });
}

export async function auditKnowledgeBaseRollout(input: {
  since: Date;
  now?: Date;
}) {
  const dataset = await loadRolloutAuditDataset(input.since);
  const stateViolations = findKnowledgeBaseRolloutViolations(dataset, {
    now: input.now,
    since: input.since,
  });
  const artifactViolations =
    await findKnowledgeBaseRolloutArtifactViolations(dataset);
  return {
    scanned: dataset.builds.length,
    operations: new Set(
      dataset.turns
        .filter(
          (turn) =>
            turn.buildId &&
            dataset.builds.some((build) => build.id === turn.buildId),
        )
        .map((turn) => String(turn.operationKey || "").trim())
        .filter(Boolean),
    ).size,
    violations: [...stateViolations, ...artifactViolations],
  };
}
