import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  agentEvents,
  conversationTurns,
  knowledgeBaseBuilds,
  messages,
} from "../drizzle/schema";
import {
  generalExecutionActivity,
  type GeneralExecutionDto,
  type GeneralExecutionEntry,
  type BusinessExecutionPhase,
  businessExecutionLabels,
  orderExecutionTimeline,
} from "../shared/frontmind-general-execution";
import type { ManusV2MessageEvent } from "./manus-v2-client";
import { getDb } from "./db";
import { enterpriseOwnerPredicate } from "./enterprise-project-scope";
import { loadGeneralExecutions } from "./frontmind-general-execution";

/** Called by the existing, leased knowledge worker; it never starts another provider poller. */
export async function persistKnowledgeBaseExecution(input: {
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  events: readonly ManusV2MessageEvent[];
}) {
  const db = await getDb();
  if (!db) return;
  await db.transaction(async (tx) => {
    const [build] = await tx
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          enterpriseOwnerPredicate(knowledgeBaseBuilds, input.userId),
          eq(knowledgeBaseBuilds.id, input.buildId),
          eq(knowledgeBaseBuilds.generation, input.generation),
          eq(knowledgeBaseBuilds.activeTurnId, input.turnId),
        ),
      )
      .limit(1)
      .for("update");
    if (!build || build.executionMode === "reset_retired") return; // Reset or a newer turn invalidates all late work.
    const [turn] = await tx
      .select({
        id: conversationTurns.id,
        sequence: messages.sequence,
        messageId: messages.id,
      })
      .from(conversationTurns)
      .innerJoin(
        messages,
        and(
          eq(messages.turnId, conversationTurns.id),
          eq(messages.role, "user"),
        ),
      )
      .where(
        and(
          enterpriseOwnerPredicate(conversationTurns, input.userId),
          eq(conversationTurns.id, input.turnId),
          eq(conversationTurns.buildId, input.buildId),
          eq(conversationTurns.buildGeneration, input.generation),
        ),
      )
      .limit(1);
    if (!turn) return;
    for (const [index, event] of input.events.entries()) {
      const activity = generalExecutionActivity(event.executionActivity);
      if (!activity) continue;
      const timestamp = Number(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < 0) continue;
      const normalizedPayload = {
        kind: "provider_event",
        type: event.type,
        knowledgeGeneration: input.generation,
        providerOriginalRank: event.providerOriginalRank ?? index,
        executionTurn: {
          id: turn.id,
          userSequence: turn.sequence,
          userMessageId: turn.messageId,
        },
        executionActivity:
          activity.kind === "tool_result" && activity.callId
            ? { ...activity, callId: `kb:${input.turnId}:${activity.callId}` }
            : activity,
      };
      // Include the turn in the event key because each materialized revision owns a new session.
      const providerEventId = `kb:${input.turnId}:${event.id}`;
      await tx
        .insert(agentEvents)
        .values({
          id: randomUUID(),
          taskId: input.buildId,
          providerEventId,
          eventType: "knowledge_execution",
          providerTimestampMs: timestamp,
          normalizedPayload,
        })
        .onDuplicateKeyUpdate({
          set: { normalizedPayload, providerTimestampMs: timestamp },
        });
    }
  });
}

/** Owned, current-generation evidence only; old conversations are never reconstructed. */
export async function loadKnowledgeBaseExecution(input: {
  userId: number;
  buildId: string;
  generation: number;
  phase?: string | null;
  executor?: any;
}): Promise<GeneralExecutionDto | undefined> {
  const db = input.executor ?? (await getDb());
  if (!db) return undefined;
  const [build] = await db
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        enterpriseOwnerPredicate(knowledgeBaseBuilds, input.userId),
        eq(knowledgeBaseBuilds.id, input.buildId),
        eq(knowledgeBaseBuilds.generation, input.generation),
      ),
    )
    .limit(1);
  if (!build || build.executionMode === "reset_retired") return undefined;
  const turns = await db
    .select({
      id: conversationTurns.id,
      sequence: messages.sequence,
      messageId: messages.id,
      status: conversationTurns.status,
      createdAt: conversationTurns.createdAt,
      startedAt: conversationTurns.startedAt,
      completedAt: conversationTurns.completedAt,
      upstreamTaskId: conversationTurns.upstreamTaskId,
      metadata: conversationTurns.metadata,
    })
    .from(conversationTurns)
    .innerJoin(
      messages,
      and(eq(messages.turnId, conversationTurns.id), eq(messages.role, "user")),
    )
    .where(
      and(
        enterpriseOwnerPredicate(conversationTurns, input.userId),
        eq(conversationTurns.buildId, build.id),
        eq(conversationTurns.buildGeneration, input.generation),
      ),
    )
    .orderBy(asc(messages.sequence));
  const execution = (await loadGeneralExecutions(db, [build.id])).get(
    build.id,
  )!;
  const ownedTurns = new Set(turns.map((turn: { id: string }) => turn.id));
  const timeline = execution.timeline.filter((entry) =>
    ownedTurns.has(entry.turnId),
  );
  for (const turn of turns) {
    const base = {
      turnId: turn.id,
      userMessageId: turn.messageId,
      userSequence: turn.sequence,
    };
    const upload = turn.metadata?.browserUpload as
      | { status?: string; lastHeartbeatAt?: number; lastProgressAt?: number }
      | undefined;
    const awaiting = turn.metadata?.awaitingClientAttachments === true;
    // The reserved user turn is a real preparation event. Its identity and time
    // remain stable across refreshes and merge into the same model run.
    timeline.push({
      ...base,
      runId: build.id,
      id: `kb:${turn.id}:reserved`,
      timestamp: turn.createdAt.getTime(),
      rank: -100,
      kind: "status",
      phase: "uploading",
      label: businessExecutionLabels.uploading,
      status:
        upload?.status === "cancelled"
          ? "cancelled"
          : awaiting
            ? "waiting"
            : "ended",
    });
    if (awaiting && upload?.lastHeartbeatAt) {
      const age = Date.now() - upload.lastHeartbeatAt;
      const stalled =
        Date.now() - (upload.lastProgressAt ?? upload.lastHeartbeatAt) > 30_000;
      if (age > 60_000 || stalled)
        timeline.push({
          ...base,
          runId: build.id,
          id: `kb:${turn.id}:connection`,
          timestamp: upload.lastHeartbeatAt,
          rank: -99,
          kind: "status",
          status: "waiting",
          publicSummary:
            age > 60_000
              ? "浏览器连接已中断，已收到的资料已保留。"
              : "当前连接没有进展，可检查网络后继续。",
        });
    }
    if (
      ["completed", "failed", "cancelled"].includes(turn.status) &&
      turn.completedAt
    ) {
      timeline.push({
        ...base,
        id: `kb:${turn.id}:finished`,
        timestamp: turn.completedAt.getTime(),
        rank: Number.MAX_SAFE_INTEGER,
        kind: "status",
        runId: build.id,
        ...(turn.status === "completed" ? { phase: "published" as const, label: businessExecutionLabels.published } : {}),
        status:
          turn.status === "completed"
            ? "ended"
            : turn.status === "cancelled"
              ? "cancelled"
              : "error",
      });
    }
  }
  const ordered = orderExecutionTimeline(timeline);
  for (const [index, item] of ordered.entries()) {
    if (item.kind !== "status" || !item.phase || item.status !== "running")
      continue;
    const next = ordered
      .slice(index + 1)
      .find((entry) =>
        entry.turnId === item.turnId &&
        entry.kind === "status" &&
        (entry.phase || entry.id === `kb:${item.turnId}:finished`),
      );
    if (next) {
      // Provider activity happens inside the business stage. A busy/thinking
      // event or tool result cannot prove that research or normalization ended.
      item.status = next.kind === "status" &&
        (next.status === "error" || next.status === "cancelled")
        ? next.status : "ended";
      // MySQL historical timestamps have second precision; never show negative duration.
      item.finishedAt = Math.max(item.timestamp, next.timestamp);
    }
  }
  return {
    ...execution,
    runId: build.id,
    phase: input.phase ?? undefined,
    coverage:
      execution.coverage === "complete"
        ? "complete"
        : timeline.length
          ? "partial"
          : "unavailable",
    timeline: ordered,
  };
}

/** First occurrence of a real local stage, under the worker's existing lease. */
export async function persistKnowledgeBaseStage(input: {
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  phase: BusinessExecutionPhase;
  rank: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db.transaction(async (tx) => {
    const [build] = await tx
      .select({
        id: knowledgeBaseBuilds.id,
        mode: knowledgeBaseBuilds.executionMode,
      })
      .from(knowledgeBaseBuilds)
      .where(
        and(
          enterpriseOwnerPredicate(knowledgeBaseBuilds, input.userId),
          eq(knowledgeBaseBuilds.id, input.buildId),
          eq(knowledgeBaseBuilds.generation, input.generation),
          eq(knowledgeBaseBuilds.activeTurnId, input.turnId),
        ),
      )
      .limit(1)
      .for("update");
    if (!build || build.mode === "reset_retired") return;
    const [turn] = await tx
      .select({
        id: conversationTurns.id,
        sequence: messages.sequence,
        messageId: messages.id,
      })
      .from(conversationTurns)
      .innerJoin(
        messages,
        and(
          eq(messages.turnId, conversationTurns.id),
          eq(messages.role, "user"),
        ),
      )
      .where(
        and(
          enterpriseOwnerPredicate(conversationTurns, input.userId),
          eq(conversationTurns.id, input.turnId),
          eq(conversationTurns.buildId, input.buildId),
          eq(conversationTurns.buildGeneration, input.generation),
        ),
      )
      .limit(1);
    if (!turn) return;
    const providerEventId = `kb:${input.turnId}:stage:${input.phase}`;
    await tx
      .insert(agentEvents)
      .values({
        id: randomUUID(),
        taskId: input.buildId,
        providerEventId,
        eventType: "knowledge_execution",
        providerTimestampMs: Date.now(),
        normalizedPayload: {
          kind: "business_event",
          knowledgeGeneration: input.generation,
          businessPhase: input.phase,
          providerOriginalRank: input.rank,
          executionTurn: {
            id: turn.id,
            userSequence: turn.sequence,
            userMessageId: turn.messageId,
          },
          executionActivity: { kind: "status", status: "running" },
        },
      })
      .onDuplicateKeyUpdate({ set: { providerEventId } }); // Keep the first timestamp.
  });
}
