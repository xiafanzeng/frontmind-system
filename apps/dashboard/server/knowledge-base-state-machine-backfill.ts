import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  upstreamResources,
  type KnowledgeBaseBuild,
} from "../drizzle/schema";
import { canonicalKnowledgeBaseMarkdown } from "./knowledge-base-package-validation";
import {
  createKnowledgeBaseOperationKey,
  createKnowledgeBaseUpstreamIdempotencyKey,
  hashKnowledgeBaseTurnRequest,
  hashKnowledgeBaseUpstreamIdempotencyKey,
  knowledgeBaseConversationStorageId,
} from "./knowledge-base-turn-service";
import { getDb } from "./db";

export type KnowledgeBaseBackfillSummary = {
  scanned: number;
  reservationsCreated: number;
  staleErrorsCleared: number;
  rebindRequired: number;
  alreadyMigrated: number;
  skipped: number;
  nextCursor: KnowledgeBaseBackfillCursor | null;
  hasMore: boolean;
  dispositions: Array<{
    buildId: string;
    generation: number;
    status: KnowledgeBaseBuild["status"];
    skillVersion: string;
    turnId: string | null;
    actions: string[];
  }>;
};

export type KnowledgeBaseBackfillCursor = {
  createdAt: Date;
  buildId: string;
};

export type KnowledgeBaseBackfillInventory = {
  total: number;
  buckets: Array<{
    status: KnowledgeBaseBuild["status"];
    skillVersion: string;
    hasLogo: boolean;
    hasPackage: boolean;
    count: number;
  }>;
  builds: Array<{
    buildId: string;
    generation: number;
    status: KnowledgeBaseBuild["status"];
    protocolErrorCode: string | null;
    skillVersion: string;
    skillContentHash: string | null;
    skillPinStatus:
      | "not_checked"
      | "missing_hash"
      | "resolvable"
      | "unresolvable";
    revision: number;
    packageRevision: number | null;
    hasActiveTurn: boolean;
    activeTurnValid: boolean;
    activeTurnNeedsSkill: boolean;
    hasUpstreamTask: boolean;
    hasLogo: boolean;
    hasPackage: boolean;
  }>;
};

const LEGACY_DUPLICATE_ERROR =
  /本轮内容已处理|无需重复更新|STALE_REVISION|STALE_OPERATION/iu;

export function knowledgeBaseReadyArtifactRecoveryFacts(input: {
  skillVersion: string;
  packageStorageKey: string | null;
  packageArchiveSha256: string | null;
  packageSizeBytes: number | null;
  logoStorageKey: string | null;
  logoSha256: string | null;
  logoBytes: number | null;
}) {
  const packageDurable = Boolean(
    input.packageStorageKey &&
      /^[a-f0-9]{64}$/u.test(String(input.packageArchiveSha256 || "")) &&
      Number(input.packageSizeBytes) > 0,
  );
  const logoDurable = Boolean(
    input.logoStorageKey &&
      /^[a-f0-9]{64}$/u.test(String(input.logoSha256 || "")) &&
      Number(input.logoBytes) > 0,
  );
  return {
    packageDurable,
    logoDurable,
    // Logo is an optional package enhancement. Missing Logo bytes must never
    // revoke an already accepted content-completion receipt.
    rebindRequired: !packageDurable,
  };
}

function readyArtifactRebindRequiredCondition() {
  const invalidPackageSha = sql<boolean>`${knowledgeBaseBuilds.packageArchiveSha256} not regexp '^[a-f0-9]{64}$'`;
  return or(
    isNull(knowledgeBaseBuilds.packageStorageKey),
    isNull(knowledgeBaseBuilds.packageArchiveSha256),
    invalidPackageSha,
    isNull(knowledgeBaseBuilds.packageSizeBytes),
    lte(knowledgeBaseBuilds.packageSizeBytes, 0),
  );
}

export function knowledgeBaseActiveTurnRecoveryFacts(input: {
  activeTurnId: string | null;
  buildId: string;
  userId: number;
  generation: number;
  activeTurn?: {
    status: string;
    userId: number;
    buildId: string | null;
    buildGeneration: number | null;
    upstreamTaskId: string | null;
    attachmentFileIds: readonly string[];
    metadata: Record<string, unknown> | null;
  } | null;
}) {
  if (!input.activeTurnId) {
    return { valid: true, needsSkill: false };
  }
  const turn = input.activeTurn;
  const valid = Boolean(
    turn &&
      turn.userId === input.userId &&
      turn.buildId === input.buildId &&
      turn.buildGeneration === input.generation &&
      (turn.status === "queued" || turn.status === "running"),
  );
  if (!valid || !turn) {
    return { valid: false, needsSkill: !turn };
  }
  const metadata =
    turn.metadata && typeof turn.metadata === "object" ? turn.metadata : {};
  return {
    valid: true,
    needsSkill: Boolean(
      !turn.upstreamTaskId &&
        !metadata.preparedDispatch &&
        turn.attachmentFileIds.length === 0,
    ),
  };
}

function legacyClientRequestId(build: KnowledgeBaseBuild) {
  return `kb-legacy-${build.id}-g${build.generation}`;
}

function legacyRequestHash(build: KnowledgeBaseBuild) {
  return hashKnowledgeBaseTurnRequest({
    kind: "legacy_reconcile",
    buildId: build.id,
    generation: build.generation,
    revision: build.revision,
    leafId: build.currentLeafId,
    taskId: build.upstreamTaskId,
  });
}

export function legacyKnowledgeBaseOperationKey(build: KnowledgeBaseBuild) {
  return createKnowledgeBaseOperationKey({
    buildId: build.id,
    buildGeneration: build.generation,
    operationType: "legacy_reconcile",
    expectedRevision: build.revision,
    expectedLeafId: build.currentLeafId,
  });
}

/**
 * Secret-free production inventory used as a mandatory migration gate. It
 * deliberately exposes IDs and state only, never task IDs, credentials,
 * request bodies, attachments or approved Markdown.
 */
export async function inspectKnowledgeBaseStateMachineBackfill(input?: {
  resolveSkillPin?: (selection: {
    version: "1" | "2" | "3" | "4";
    contentHash: string;
  }) => Promise<{ contentHash: string }>;
}): Promise<KnowledgeBaseBackfillInventory> {
  const db = await getDb();
  if (!db) throw new Error("Database is not configured");
  const rows = await db
    .select({
      id: knowledgeBaseBuilds.id,
      userId: knowledgeBaseBuilds.userId,
      generation: knowledgeBaseBuilds.generation,
      status: knowledgeBaseBuilds.status,
      protocolErrorCode: knowledgeBaseBuilds.protocolErrorCode,
      skillVersion: knowledgeBaseBuilds.skillVersion,
      skillContentHash: knowledgeBaseBuilds.skillContentHash,
      revision: knowledgeBaseBuilds.revision,
      packageRevision: knowledgeBaseBuilds.packageRevision,
      activeTurnId: knowledgeBaseBuilds.activeTurnId,
      upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
      logoStorageKey: knowledgeBaseBuilds.logoStorageKey,
      packageStorageKey: knowledgeBaseBuilds.packageStorageKey,
    })
    .from(knowledgeBaseBuilds)
    .orderBy(asc(knowledgeBaseBuilds.createdAt));
  const activeTurnIds = rows
    .map((row) => row.activeTurnId)
    .filter((turnId): turnId is string => Boolean(turnId));
  const activeTurns: Array<{
    id: string;
    status: string;
    userId: number;
    buildId: string | null;
    buildGeneration: number | null;
    upstreamTaskId: string | null;
    attachmentFileIds: string[];
    metadata: Record<string, unknown>;
  }> = [];
  for (let cursor = 0; cursor < activeTurnIds.length; cursor += 1_000) {
    activeTurns.push(
      ...(await db
        .select({
          id: conversationTurns.id,
          status: conversationTurns.status,
          userId: conversationTurns.userId,
          buildId: conversationTurns.buildId,
          buildGeneration: conversationTurns.buildGeneration,
          upstreamTaskId: conversationTurns.upstreamTaskId,
          attachmentFileIds: conversationTurns.attachmentFileIds,
          metadata: conversationTurns.metadata,
        })
        .from(conversationTurns)
        .where(
          inArray(
            conversationTurns.id,
            activeTurnIds.slice(cursor, cursor + 1_000),
          ),
        )),
    );
  }
  const activeTurnById = new Map(activeTurns.map((turn) => [turn.id, turn]));
  const pinCache = new Map<string, "resolvable" | "unresolvable">();
  const builds = [] as KnowledgeBaseBackfillInventory["builds"];
  for (const row of rows) {
    const activeTurn = row.activeTurnId
      ? activeTurnById.get(row.activeTurnId)
      : null;
    const activeTurnFacts = knowledgeBaseActiveTurnRecoveryFacts({
      activeTurnId: row.activeTurnId,
      buildId: row.id,
      userId: row.userId,
      generation: row.generation,
      activeTurn,
    });
    let skillPinStatus: KnowledgeBaseBackfillInventory["builds"][number]["skillPinStatus"] =
      input?.resolveSkillPin ? "missing_hash" : "not_checked";
    if (input?.resolveSkillPin && row.skillContentHash) {
      const version = ["1", "2", "3", "4"].includes(row.skillVersion)
        ? (row.skillVersion as "1" | "2" | "3" | "4")
        : "4";
      const cacheKey = `${version}:${row.skillContentHash}`;
      let resolved = pinCache.get(cacheKey);
      if (!resolved) {
        try {
          const descriptor = await input.resolveSkillPin({
            version,
            contentHash: row.skillContentHash,
          });
          resolved =
            descriptor.contentHash === row.skillContentHash
              ? "resolvable"
              : "unresolvable";
        } catch {
          resolved = "unresolvable";
        }
        pinCache.set(cacheKey, resolved);
      }
      skillPinStatus = resolved;
    }
    builds.push({
      buildId: row.id,
      generation: row.generation,
      status: row.status,
      protocolErrorCode: row.protocolErrorCode,
      skillVersion: row.skillVersion,
      skillContentHash: row.skillContentHash,
      skillPinStatus,
      revision: row.revision,
      packageRevision: row.packageRevision,
      hasActiveTurn: Boolean(row.activeTurnId),
      activeTurnValid: activeTurnFacts.valid,
      activeTurnNeedsSkill: activeTurnFacts.needsSkill,
      hasUpstreamTask: Boolean(row.upstreamTaskId),
      hasLogo: Boolean(row.logoStorageKey),
      hasPackage: Boolean(row.packageStorageKey),
    });
  }
  const bucketMap = new Map<
    string,
    KnowledgeBaseBackfillInventory["buckets"][number]
  >();
  for (const build of builds) {
    const key = [
      build.status,
      build.skillVersion,
      build.hasLogo ? "logo" : "no-logo",
      build.hasPackage ? "package" : "no-package",
    ].join(":");
    const bucket = bucketMap.get(key);
    if (bucket) {
      bucket.count += 1;
    } else {
      bucketMap.set(key, {
        status: build.status,
        skillVersion: build.skillVersion,
        hasLogo: build.hasLogo,
        hasPackage: build.hasPackage,
        count: 1,
      });
    }
  }
  return {
    total: builds.length,
    buckets: [...bucketMap.values()],
    builds,
  };
}

export function legacyKnowledgeBaseErrorCanBeCleared(input: {
  build: Pick<
    KnowledgeBaseBuild,
    "status" | "protocolError" | "currentLeafId" | "revision"
  >;
  currentNode?: {
    leafId: string;
    status: string;
    contentMarkdown: string | null;
  } | null;
}) {
  if (
    input.build.status !== "protocol_error" ||
    !LEGACY_DUPLICATE_ERROR.test(input.build.protocolError || "") ||
    !input.build.currentLeafId ||
    input.build.revision < 0
  ) {
    return false;
  }
  const node = input.currentNode;
  return Boolean(
    node &&
      node.leafId === input.build.currentLeafId &&
      (node.status === "current" || node.status === "needs_verification") &&
      canonicalKnowledgeBaseMarkdown(node.contentMarkdown || ""),
  );
}

async function ensureLegacyConversation(
  tx: any,
  build: KnowledgeBaseBuild,
  apiCredentialId: string,
  now: Date,
) {
  const id = knowledgeBaseConversationStorageId(
    build.userId,
    build.conversationId,
  );
  await tx
    .insert(conversations)
    .values({
      id,
      userId: build.userId,
      apiCredentialId,
      projectAssignmentId: null,
      title: `知识库 · ${build.companyName}`.slice(0, 255),
      status: "running",
      upstreamTaskId: build.upstreamTaskId,
      previousResponseId: build.upstreamTaskId,
      deletedMessageIds: [],
      version: 1,
      startedAt: build.createdAt,
      createdAt: build.createdAt,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({ set: { id } });
  const conversation = (
    await tx
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.id, id), eq(conversations.userId, build.userId)),
      )
      .limit(1)
      .for("update")
  )[0];
  if (
    !conversation ||
    conversation.projectAssignmentId !== null ||
    conversation.deletedAt
  ) {
    throw new Error("Legacy knowledge-base conversation is unavailable");
  }
  return conversation;
}

/**
 * Prepare only durable reservations. The recovery worker performs the one
 * full upstream read afterwards; this function never increments a build
 * revision or changes any node body/status.
 */
export async function prepareKnowledgeBaseStateMachineBackfill(input: {
  apply: boolean;
  limit?: number;
  now?: Date;
  after?: KnowledgeBaseBackfillCursor;
}): Promise<KnowledgeBaseBackfillSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database is not configured");
  const limit = Math.min(10_000, Math.max(1, Math.trunc(input.limit ?? 2_000)));
  const now = input.now ?? new Date();
  // MySQL TIMESTAMP does not reliably accept the Unix epoch under strict
  // mode. One second before this maintenance transaction is both portable
  // and already expired for the recovery scanner.
  const expiredLeaseAt = new Date(now.getTime() - 1_000);
  const candidates = await db
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        inArray(knowledgeBaseBuilds.status, [
          "researching",
          "confirming",
          "protocol_error",
        ]),
        isNull(knowledgeBaseBuilds.activeTurnId),
        input.after
          ? or(
              gt(knowledgeBaseBuilds.createdAt, input.after.createdAt),
              and(
                eq(knowledgeBaseBuilds.createdAt, input.after.createdAt),
                gt(knowledgeBaseBuilds.id, input.after.buildId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(knowledgeBaseBuilds.createdAt), asc(knowledgeBaseBuilds.id))
    .limit(limit);
  const summary: KnowledgeBaseBackfillSummary = {
    scanned: candidates.length,
    reservationsCreated: 0,
    staleErrorsCleared: 0,
    rebindRequired: 0,
    alreadyMigrated: 0,
    skipped: 0,
    nextCursor: candidates.length
      ? {
          createdAt: candidates[candidates.length - 1]!.createdAt,
          buildId: candidates[candidates.length - 1]!.id,
        }
      : null,
    hasMore: candidates.length === limit,
    dispositions: [],
  };

  for (const candidate of candidates) {
    const disposition: KnowledgeBaseBackfillSummary["dispositions"][number] = {
      buildId: candidate.id,
      generation: candidate.generation,
      status: candidate.status,
      skillVersion: candidate.skillVersion,
      turnId: null,
      actions: [],
    };
    await db.transaction(async (tx) => {
      let build = (
        await tx
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, candidate.id))
          .limit(1)
          .for("update")
      )[0] as KnowledgeBaseBuild | undefined;
      if (!build || build.activeTurnId) {
        summary.skipped += 1;
        disposition.actions.push("skip_missing_or_active_turn");
        return;
      }

      if (build.status === "protocol_error") {
        const currentNode = build.currentLeafId
          ? (
              await tx
                .select()
                .from(knowledgeBaseBuildNodes)
                .where(
                  and(
                    eq(knowledgeBaseBuildNodes.buildId, build.id),
                    eq(knowledgeBaseBuildNodes.leafId, build.currentLeafId),
                  ),
                )
                .limit(1)
            )[0]
          : null;
        if (!legacyKnowledgeBaseErrorCanBeCleared({ build, currentNode })) {
          summary.skipped += 1;
          disposition.actions.push("retain_protocol_error");
          return;
        }
        summary.staleErrorsCleared += 1;
        disposition.actions.push("clear_proven_stale_error");
        if (input.apply) {
          await tx
            .update(knowledgeBaseBuilds)
            .set({
              status: "confirming",
              protocolError: null,
              protocolErrorCode: null,
              stateEpoch: build.stateEpoch + 1,
              awaitingResponseSince: null,
              updatedAt: now,
            })
            .where(eq(knowledgeBaseBuilds.id, build.id));
        }
        build = { ...build, status: "confirming", protocolError: null };
      }

      if (!build.upstreamTaskId) {
        summary.rebindRequired += 1;
        disposition.actions.push("require_task_rebind");
        if (input.apply) {
          await tx
            .update(knowledgeBaseBuilds)
            .set({
              status: "protocol_error",
              protocolErrorCode: "LEGACY_TASK_REBIND_REQUIRED",
              protocolError:
                "历史知识库任务缺少可恢复的上游任务，请联系管理员通过维护流程重建本轮",
              stateEpoch: build.stateEpoch + 1,
              awaitingResponseSince: null,
              updatedAt: now,
            })
            .where(eq(knowledgeBaseBuilds.id, build.id));
        }
        return;
      }
      const resource = (
        await tx
          .select({ apiCredentialId: upstreamResources.apiCredentialId })
          .from(upstreamResources)
          .where(
            and(
              eq(upstreamResources.userId, build.userId),
              eq(upstreamResources.kind, "task"),
              eq(upstreamResources.upstreamId, build.upstreamTaskId),
            ),
          )
          .limit(1)
      )[0];
      if (!resource?.apiCredentialId) {
        summary.rebindRequired += 1;
        disposition.actions.push("require_credential_rebind");
        if (input.apply) {
          await tx
            .update(knowledgeBaseBuilds)
            .set({
              status: "protocol_error",
              protocolErrorCode: "LEGACY_CREDENTIAL_REBIND_REQUIRED",
              protocolError:
                "历史知识库任务缺少可恢复的凭据绑定，请联系管理员通过维护流程重建本轮",
              stateEpoch: build.stateEpoch + 1,
              awaitingResponseSince: null,
              updatedAt: now,
            })
            .where(eq(knowledgeBaseBuilds.id, build.id));
        }
        return;
      }

      disposition.actions.push("prepare_legacy_reconcile_reservation");
      const existing = (
        await tx
          .select()
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.buildId, build.id),
              eq(conversationTurns.buildGeneration, build.generation),
              eq(conversationTurns.operationType, "legacy_reconcile"),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (existing?.status === "completed") {
        summary.alreadyMigrated += 1;
        disposition.actions.push("already_migrated");
        return;
      }
      summary.reservationsCreated += 1;
      if (!input.apply) return;
      const conversation = await ensureLegacyConversation(
        tx,
        build,
        resource.apiCredentialId,
        now,
      );
      const operationKey = legacyKnowledgeBaseOperationKey(build);
      const turnId = existing?.id || randomUUID();
      disposition.turnId = input.apply ? turnId : existing?.id || null;
      if (!existing) {
        const idempotencyKey =
          createKnowledgeBaseUpstreamIdempotencyKey(operationKey);
        await tx.insert(conversationTurns).values({
          id: turnId,
          conversationId: conversation.id,
          userId: build.userId,
          apiCredentialId: resource.apiCredentialId,
          clientRequestId: legacyClientRequestId(build),
          buildId: build.id,
          buildGeneration: build.generation,
          operationKey,
          operationType: "legacy_reconcile",
          expectedRevision: build.revision,
          expectedLeafId: build.currentLeafId,
          requestHash: legacyRequestHash(build),
          upstreamIdempotencyKeyHash:
            hashKnowledgeBaseUpstreamIdempotencyKey(idempotencyKey),
          attachmentFileIds: [],
          metadata: {
            attachmentsFrozen: true,
            expectedAttachmentCount: 0,
            recovery: {
              kind: "legacy_reconcile",
              migratedAt: now.toISOString(),
            },
          },
          leaseExpiresAt: expiredLeaseAt,
          status: "running",
          upstreamTaskId: build.upstreamTaskId,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        disposition.actions.push("create_reservation");
      } else {
        disposition.actions.push(
          existing.status === "failed" || existing.status === "cancelled"
            ? "retry_terminal_reservation"
            : "reuse_reservation",
        );
        // A detached queued/running legacy reservation is safe to reclaim
        // while the migration is running with application writers stopped.
        // Expire its lease explicitly so the recovery drain cannot report
        // success without actually observing this reservation.
        await tx
          .update(conversationTurns)
          .set({
            status: "running",
            leaseExpiresAt: expiredLeaseAt,
            errorCode: null,
            errorMessage: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(conversationTurns.id, existing.id));
      }
      await tx
        .update(knowledgeBaseBuilds)
        .set({
          activeTurnId: turnId,
          stateEpoch: build.stateEpoch + 1,
          awaitingResponseSince: build.awaitingResponseSince || now,
          updatedAt: now,
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, build.id),
            eq(knowledgeBaseBuilds.generation, build.generation),
            isNull(knowledgeBaseBuilds.activeTurnId),
          ),
        );
      await tx
        .update(conversations)
        .set({
          status: "running",
          upstreamTaskId: build.upstreamTaskId,
          previousResponseId: build.upstreamTaskId,
          version: conversation.version + 1,
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(conversations.id, conversation.id),
            eq(conversations.version, conversation.version),
          ),
        );
    });
    summary.dispositions.push(disposition);
  }
  return summary;
}

/**
 * Schedule local package reconstruction for legacy content-complete builds.
 * Package/Logo defects are deliberately post-acceptance concerns: this never
 * revokes content completion or moves a build into protocol_error.
 */
export async function finalizeKnowledgeBaseReadyPackageBackfill(input: {
  apply: boolean;
  confirmRebindRequired?: boolean;
  now?: Date;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not configured");
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      id: knowledgeBaseBuilds.id,
      generation: knowledgeBaseBuilds.generation,
      skillVersion: knowledgeBaseBuilds.skillVersion,
      logoStorageKey: knowledgeBaseBuilds.logoStorageKey,
      logoSha256: knowledgeBaseBuilds.logoSha256,
      logoBytes: knowledgeBaseBuilds.logoBytes,
      packageStorageKey: knowledgeBaseBuilds.packageStorageKey,
      packageArchiveSha256: knowledgeBaseBuilds.packageArchiveSha256,
      packageSizeBytes: knowledgeBaseBuilds.packageSizeBytes,
      stateEpoch: knowledgeBaseBuilds.stateEpoch,
    })
    .from(knowledgeBaseBuilds)
    .where(
      or(
        and(
          eq(knowledgeBaseBuilds.status, "ready_to_publish"),
          readyArtifactRebindRequiredCondition(),
          inArray(knowledgeBaseBuilds.packageStatus, [
            "not_started",
            "attention_required",
          ]),
        ),
        and(
          eq(knowledgeBaseBuilds.status, "protocol_error"),
          eq(knowledgeBaseBuilds.protocolErrorCode, "PACKAGE_REBIND_REQUIRED"),
          isNull(knowledgeBaseBuilds.currentLeafId),
          inArray(knowledgeBaseBuilds.packageStatus, [
            "not_started",
            "attention_required",
          ]),
        ),
      ),
    );
  const dispositions = rows.map((row) => ({
    buildId: row.id,
    generation: row.generation,
    skillVersion: row.skillVersion,
    hasLogo: knowledgeBaseReadyArtifactRecoveryFacts(row).logoDurable,
    hasPackage: knowledgeBaseReadyArtifactRecoveryFacts(row).packageDurable,
    action: "schedule_local_package_rebuild" as const,
  }));
  if (input.apply && rows.length > 0) {
    for (const row of rows) {
      await db
        .update(knowledgeBaseBuilds)
        .set({
          status: "ready_to_publish",
          stateEpoch: row.stateEpoch + 1,
          contentCompletedAt: sql<Date>`coalesce(${knowledgeBaseBuilds.contentCompletedAt}, ${knowledgeBaseBuilds.completedAt}, ${knowledgeBaseBuilds.updatedAt}, ${now})`,
          packageStatus: "preparing",
          packageNextRetryAt: now,
          packageLastErrorCode: null,
          protocolErrorCode: null,
          protocolError: null,
          awaitingResponseSince: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, row.id),
            eq(knowledgeBaseBuilds.stateEpoch, row.stateEpoch),
            or(
              and(
                eq(knowledgeBaseBuilds.status, "ready_to_publish"),
                readyArtifactRebindRequiredCondition(),
                inArray(knowledgeBaseBuilds.packageStatus, [
                  "not_started",
                  "attention_required",
                ]),
              ),
              and(
                eq(knowledgeBaseBuilds.status, "protocol_error"),
                eq(
                  knowledgeBaseBuilds.protocolErrorCode,
                  "PACKAGE_REBIND_REQUIRED",
                ),
                isNull(knowledgeBaseBuilds.currentLeafId),
                inArray(knowledgeBaseBuilds.packageStatus, [
                  "not_started",
                  "attention_required",
                ]),
              ),
            ),
          ),
        );
    }
  }
  return { rebindRequired: rows.length, dispositions };
}
