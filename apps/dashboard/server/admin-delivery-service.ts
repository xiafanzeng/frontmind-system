import { and, desc, eq, isNull } from "drizzle-orm";

import {
  conversationTurns,
  knowledgeBaseBuilds,
  messages,
} from "../drizzle/schema";
import type { KnowledgeBaseFailureStage } from "../shared/knowledge-base-progress";
import { AuthServiceError } from "./auth-service";
import { getDb } from "./db";

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function epoch(value: Date | null | undefined) {
  return value?.getTime() ?? null;
}

const ADMIN_KNOWLEDGE_BASE_FAILURE_STAGES = new Set<KnowledgeBaseFailureStage>([
  "local_upload",
  "provider_file_registration",
  "task_create",
  "result_processing",
]);

export function managedKnowledgeTurnBusinessFields(turn: {
  upstreamTaskId?: string | null;
  metadata?: unknown;
  completedAt?: Date | null;
}) {
  const metadata =
    turn.metadata &&
    typeof turn.metadata === "object" &&
    !Array.isArray(turn.metadata)
      ? (turn.metadata as Record<string, unknown>)
      : {};
  const storedState = metadata.createAttemptState;
  const taskCreationState =
    storedState === "not_sent"
      ? ("not_attempted" as const)
      : storedState === "sending"
        ? ("submitting" as const)
        : storedState === "acknowledged" || turn.upstreamTaskId
          ? ("acknowledged" as const)
          : storedState === "rejected"
            ? ("rejected" as const)
            : storedState === "unknown"
              ? ("outcome_unknown" as const)
              : undefined;
  const failureStage =
    typeof metadata.failureStage === "string" &&
    ADMIN_KNOWLEDGE_BASE_FAILURE_STAGES.has(
      metadata.failureStage as KnowledgeBaseFailureStage,
    )
      ? (metadata.failureStage as KnowledgeBaseFailureStage)
      : null;
  const customerCount = Number(metadata.userAttachmentCount);
  const retainedCustomerAttachmentCount =
    Number.isSafeInteger(customerCount) && customerCount >= 0
      ? customerCount
      : 0;
  const expectedCount = Number(metadata.expectedAttachmentCount);
  const generatedSystemAttachmentCount =
    Number.isSafeInteger(expectedCount) &&
    expectedCount >= retainedCustomerAttachmentCount
      ? expectedCount - retainedCustomerAttachmentCount
      : 0;
  return {
    ...(taskCreationState ? { taskCreationState } : {}),
    failureStage,
    retainedCustomerAttachmentCount,
    generatedSystemAttachmentCount,
    settledAt: epoch(turn.completedAt),
  };
}

/**
 * Read-only delivery diagnostics for an already-authorized customer
 * workspace. The router performs assignment validation before calling this
 * function; no mutation or credential material is exposed here.
 */
export async function getManagedKnowledgeActivity(userId: number) {
  const db = await requireDb();
  const builds = await db
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.userId, userId))
    .orderBy(desc(knowledgeBaseBuilds.updatedAt), desc(knowledgeBaseBuilds.id))
    .limit(1);
  const build = builds[0];
  if (!build) {
    return { build: null, turns: [], messages: [] };
  }

  const [turnRows, messageRows] = await Promise.all([
    db
      .select({
        id: conversationTurns.id,
        status: conversationTurns.status,
        model: conversationTurns.model,
        upstreamTaskId: conversationTurns.upstreamTaskId,
        errorCode: conversationTurns.errorCode,
        errorMessage: conversationTurns.errorMessage,
        metadata: conversationTurns.metadata,
        startedAt: conversationTurns.startedAt,
        completedAt: conversationTurns.completedAt,
        createdAt: conversationTurns.createdAt,
        updatedAt: conversationTurns.updatedAt,
      })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, userId),
          eq(conversationTurns.conversationId, build.conversationId),
        ),
      )
      .orderBy(desc(conversationTurns.updatedAt), desc(conversationTurns.id))
      .limit(50),
    db
      .select({
        id: messages.id,
        turnId: messages.turnId,
        role: messages.role,
        content: messages.content,
        sequence: messages.sequence,
        metadata: messages.metadata,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, userId),
          eq(messages.conversationId, build.conversationId),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(100),
  ]);

  const activeTurn = build.activeTurnId
    ? turnRows.find((turn) => turn.id === build.activeTurnId) || null
    : null;
  const terminalPreCreateTurn =
    activeTurn ||
    turnRows.find((turn) => {
      const fields = managedKnowledgeTurnBusinessFields(turn);
      return (
        turn.status === "failed" &&
        fields.taskCreationState === "not_attempted" &&
        (fields.failureStage === "local_upload" ||
          fields.failureStage === "provider_file_registration")
      );
    }) ||
    null;
  const lifecycleFields = terminalPreCreateTurn
    ? managedKnowledgeTurnBusinessFields(terminalPreCreateTurn)
    : null;
  const materializedV5 =
    build.executionMode === "materialized_bundle_v1" &&
    build.skillVersion === "5";
  const resetRequired = Boolean(
    materializedV5 &&
      !build.activeTurnId &&
      (build.status === "protocol_error" || build.status === "failed"),
  );
  const operationState = resetRequired
    ? ("reset_required" as const)
    : activeTurn
      ? activeTurn.upstreamTaskId ||
        lifecycleFields?.taskCreationState === "acknowledged"
        ? ("waiting_output" as const)
        : ("creating" as const)
      : build.status === "ready_to_publish" || build.status === "published"
        ? ("completed" as const)
        : undefined;

  return {
    build: {
      id: build.id,
      conversationId: build.conversationId,
      companyName: build.companyName,
      companyWebsite: build.companyWebsite,
      status: build.status,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      totalNodeCount: build.totalNodeCount,
      confirmedCount: build.confirmedCount,
      directPrefilledCount: build.directPrefilledCount,
      needsVerificationCount: build.needsVerificationCount,
      lastOutputLength: build.lastOutputLength,
      lastTurnAttachmentCount: build.lastTurnAttachmentCount,
      packageRevision: build.packageRevision,
      protocolError: build.protocolError,
      ...(operationState ? { operationState } : {}),
      ...(materializedV5 ? { resetAllowed: resetRequired } : {}),
      ...(lifecycleFields ?? {}),
      createdAt: epoch(build.createdAt),
      updatedAt: epoch(build.updatedAt),
      completedAt: epoch(build.completedAt),
      publishedAt: epoch(build.publishedAt),
    },
    turns: turnRows.map((turn) => {
      const { metadata: _metadata, ...publicTurn } = turn;
      void _metadata;
      const startedAt = epoch(turn.startedAt);
      const completedAt = epoch(turn.completedAt);
      return {
        ...publicTurn,
        ...managedKnowledgeTurnBusinessFields(turn),
        startedAt,
        completedAt,
        createdAt: epoch(turn.createdAt),
        updatedAt: epoch(turn.updatedAt),
        durationMs:
          startedAt && completedAt
            ? Math.max(0, completedAt - startedAt)
            : null,
      };
    }),
    messages: messageRows.reverse().map((message) => ({
      ...message,
      // Prevent an anomalous upstream response from making the control plane
      // unusable while retaining enough text for delivery diagnosis.
      content:
        message.content.length > 50_000
          ? `${message.content.slice(0, 50_000)}\n\n…（内容已截断）`
          : message.content,
      sentAt: epoch(message.sentAt),
    })),
  };
}

export async function getManagedTaskActivity(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select({
      id: conversationTurns.id,
      conversationId: conversationTurns.conversationId,
      status: conversationTurns.status,
      model: conversationTurns.model,
      upstreamTaskId: conversationTurns.upstreamTaskId,
      errorCode: conversationTurns.errorCode,
      errorMessage: conversationTurns.errorMessage,
      startedAt: conversationTurns.startedAt,
      completedAt: conversationTurns.completedAt,
      createdAt: conversationTurns.createdAt,
      updatedAt: conversationTurns.updatedAt,
    })
    .from(conversationTurns)
    .where(eq(conversationTurns.userId, userId))
    .orderBy(desc(conversationTurns.updatedAt), desc(conversationTurns.id))
    .limit(100);
  const counts = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  return {
    counts: rows.reduce((result, row) => {
      result[row.status] += 1;
      return result;
    }, counts),
    turns: rows.map((turn) => {
      const startedAt = epoch(turn.startedAt);
      const completedAt = epoch(turn.completedAt);
      return {
        ...turn,
        startedAt,
        completedAt,
        createdAt: epoch(turn.createdAt),
        updatedAt: epoch(turn.updatedAt),
        durationMs:
          startedAt && completedAt
            ? Math.max(0, completedAt - startedAt)
            : null,
      };
    }),
  };
}
