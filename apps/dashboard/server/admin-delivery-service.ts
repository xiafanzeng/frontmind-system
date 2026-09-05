import { and, desc, eq, isNull } from "drizzle-orm";

import {
  conversationTurns,
  knowledgeBaseBuilds,
  messages,
} from "../drizzle/schema";
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
    .orderBy(
      desc(knowledgeBaseBuilds.updatedAt),
      desc(knowledgeBaseBuilds.id),
    )
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
      .orderBy(
        desc(conversationTurns.updatedAt),
        desc(conversationTurns.id),
      )
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
      createdAt: epoch(build.createdAt),
      updatedAt: epoch(build.updatedAt),
      completedAt: epoch(build.completedAt),
      publishedAt: epoch(build.publishedAt),
    },
    turns: turnRows.map((turn) => {
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
    .orderBy(
      desc(conversationTurns.updatedAt),
      desc(conversationTurns.id),
    )
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
