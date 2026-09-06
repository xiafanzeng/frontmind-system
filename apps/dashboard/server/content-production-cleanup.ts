import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  agentOperations,
  agentTasks,
  conversations,
  conversationTurns,
} from "../drizzle/schema";
import { getDecryptedCredentialForAccountById } from "./auth-service";
import { createCredentialAgentClient } from "./credential-agent-client";
import type { getDb } from "./db";
import { frozenGeneralAgentPurpose } from "./general-agent-purpose";
import type { DashboardManagedRuntime } from "./providers/dashboard-agent-runtime-store";

/** Run before the local deletion transaction; provider requests must not hold DB locks. */
export async function cleanupContentProductionConversation(input: {
  db: Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;
  userId: number;
  conversationId: string;
  projectAssignmentId: string | null;
}) {
  const [conversation] = await input.db
    .select({
      upstreamTaskId: conversations.upstreamTaskId,
      previousResponseId: conversations.previousResponseId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.userId, input.userId),
        input.projectAssignmentId
          ? eq(conversations.projectAssignmentId, input.projectAssignmentId)
          : isNull(conversations.projectAssignmentId),
      ),
    )
    .limit(1);
  // The existing deletion transaction remains authoritative for not-found and
  // project handovers. A handover never authorizes another account's Vault.
  if (!conversation) return;
  const turns = await input.db
    .select({ upstreamTaskId: conversationTurns.upstreamTaskId })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, input.conversationId),
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.operationType, "general_chat_v2"),
      ),
    );
  const taskIds = [
    ...new Set(
      [
        conversation.upstreamTaskId,
        conversation.previousResponseId,
        ...turns.map((turn) => turn.upstreamTaskId),
      ].filter((id): id is string => typeof id === "string" && !!id),
    ),
  ];
  if (!taskIds.length) return;
  const rows = await input.db
    .select({ task: agentTasks, operation: agentOperations })
    .from(agentTasks)
    .innerJoin(agentOperations, eq(agentTasks.operationId, agentOperations.id))
    .where(
      and(
        inArray(agentTasks.id, taskIds),
        eq(agentOperations.accountUserId, input.userId),
        eq(agentOperations.scope, "managed_user"),
        eq(agentOperations.provider, "zhipu"),
        eq(agentOperations.contractName, "dashboard.general-chat"),
        eq(agentOperations.contractRevision, 2),
      ),
    );
  for (const { task, operation } of rows) {
    const runtime = task.providerRuntime?.dashboardManaged as
      | DashboardManagedRuntime
      | undefined;
    const vault = runtime?.mutations?.["content-workflow-vault"];
    if (vault?.state !== "acknowledged" || !vault.resourceId) continue;
    if (
      frozenGeneralAgentPurpose(task, input.userId)?.purpose !==
      "content_production"
    )
      continue;
    if (
      runtime?.mutations["delete-content-workflow-vault"]?.state ===
        "acknowledged" &&
      (!runtime.sessionId ||
        runtime.mutations["delete-session"]?.state === "acknowledged")
    )
      continue;
    if (runtime?.revision !== 1 || !runtime.intentId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "内容任务的原始绑定不完整，会话已保留，无法删除其专用凭据。",
      });
    }
    const credential = await getDecryptedCredentialForAccountById(
      input.userId,
      operation.apiCredentialId,
    );
    if (
      !credential ||
      credential.id !== operation.apiCredentialId ||
      credential.version !== operation.credentialVersion ||
      credential.provider !== "zhipu"
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "内容任务原绑定的智谱凭据不可用，会话已保留；请恢复原凭据后重试删除。",
      });
    }
    const client = createCredentialAgentClient(credential, {
      accountUserId: input.userId,
      localTaskId: task.id,
      operationId: operation.id,
      intentId: runtime.intentId,
      model: runtime.model,
      effort: runtime.effort,
    });
    if (!client.deleteContentProductionResources) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "内容任务凭据清理暂不可用，会话已保留，请稍后重试删除。",
      });
    }
    try {
      await client.deleteContentProductionResources();
    } catch {
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "内容任务的云端资源尚未删除，会话已保留，请重试删除。",
      });
    }
  }
}
