import { and, desc, eq } from "drizzle-orm";

import {
  conversations,
  messages,
  type MessageMetadata,
} from "../drizzle/schema";
import {
  knowledgeBasePresentationMessagePublicId,
  knowledgeBaseUserMessagePublicId,
} from "../shared/knowledge-base-message";

export type KnowledgeBaseServerOwnedMessageMetadata = {
  schemaVersion: 1;
  serverOwned: true;
  kind: "pending_user" | "presentation";
  buildId: string;
  generation: number;
  turnId: string;
  operationKey: string;
  clientRequestId?: string;
  presentationKey?: string;
  revision: number;
  leafId: string | null;
};

function persistedMessageId(userId: number, publicMessageId: string) {
  const value = `u${userId}:${publicMessageId}`;
  if (value.length > 191) {
    throw new TypeError("Knowledge-base message id exceeds database capacity");
  }
  return value;
}

async function lockedConversation(
  tx: any,
  input: { userId: number; conversationId: string },
) {
  const conversation = (
    await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update")
  )[0];
  if (
    !conversation ||
    conversation.projectAssignmentId !== null ||
    conversation.deletedAt
  ) {
    throw new Error("Knowledge-base conversation is missing or unavailable");
  }
  return conversation;
}

async function insertImmutableServerMessage(input: {
  tx: any;
  userId: number;
  conversationId: string;
  turnId: string;
  publicMessageId: string;
  role: "user" | "assistant";
  content: string;
  metadata: KnowledgeBaseServerOwnedMessageMetadata;
  sentAt: Date;
}) {
  const id = persistedMessageId(input.userId, input.publicMessageId);
  const existing = (
    await input.tx
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1)
      .for("update")
  )[0] as typeof messages.$inferSelect | undefined;
  const metadata = {
    knowledgeBase: input.metadata,
  } satisfies MessageMetadata;

  if (existing) {
    const existingKnowledgeBase = (
      existing.metadata as MessageMetadata | null
    )?.knowledgeBase;
    if (
      existing.userId !== input.userId ||
      existing.conversationId !== input.conversationId ||
      existing.turnId !== input.turnId ||
      existing.role !== input.role ||
      existing.content !== input.content ||
      JSON.stringify(existingKnowledgeBase) !== JSON.stringify(input.metadata)
    ) {
      throw new Error("Knowledge-base server message identity was reused");
    }
    return { inserted: false, id };
  }

  const last = (
    await input.tx
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .orderBy(desc(messages.sequence))
      .limit(1)
  )[0];
  const sequence = (last?.sequence ?? -1) + 1;
  await input.tx.insert(messages).values({
    id,
    conversationId: input.conversationId,
    turnId: input.turnId,
    userId: input.userId,
    role: input.role,
    content: input.content,
    sequence,
    metadata,
    sentAt: input.sentAt,
    createdAt: input.sentAt,
    updatedAt: input.sentAt,
  });
  return { inserted: true, id };
}

export async function persistKnowledgeBaseUserMessageInTransaction(input: {
  tx: any;
  userId: number;
  conversationId: string;
  turnId: string;
  buildId: string;
  generation: number;
  operationKey: string;
  clientRequestId: string;
  revision: number;
  leafId: string | null;
  content: string;
  sentAt: Date;
}) {
  const conversation = await lockedConversation(input.tx, input);
  const publicMessageId = knowledgeBaseUserMessagePublicId(input.turnId);
  const result = await insertImmutableServerMessage({
    ...input,
    publicMessageId,
    role: "user",
    content: String(input.content || "").slice(0, 2_000_000),
    metadata: {
      schemaVersion: 1,
      serverOwned: true,
      kind: "pending_user",
      buildId: input.buildId,
      generation: input.generation,
      turnId: input.turnId,
      operationKey: input.operationKey,
      clientRequestId: input.clientRequestId,
      revision: input.revision,
      leafId: input.leafId,
    },
  });
  if (result.inserted) {
    await input.tx
      .update(conversations)
      .set({
        status: "running",
        deletedMessageIds: (conversation.deletedMessageIds || []).filter(
          (id: string) => id !== publicMessageId,
        ),
        version: conversation.version + 1,
        completedAt: null,
        updatedAt: input.sentAt,
      })
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.userId, input.userId),
          eq(conversations.version, conversation.version),
        ),
      );
  }
  return { ...result, publicMessageId };
}

export async function persistKnowledgeBasePresentationInTransaction(input: {
  tx: any;
  userId: number;
  conversationId: string;
  turnId: string;
  buildId: string;
  generation: number;
  operationKey: string;
  presentationKey: string;
  revision: number;
  leafId: string;
  content: string;
  authoritativeTaskId: string | null;
  sentAt: Date;
}) {
  const conversation = await lockedConversation(input.tx, input);
  const publicMessageId = knowledgeBasePresentationMessagePublicId(
    input.presentationKey,
  );
  const content = String(input.content || "").trim();
  if (!content) throw new Error("Approved knowledge-base presentation is empty");
  const result = await insertImmutableServerMessage({
    ...input,
    publicMessageId,
    role: "assistant",
    content,
    metadata: {
      schemaVersion: 1,
      serverOwned: true,
      kind: "presentation",
      buildId: input.buildId,
      generation: input.generation,
      turnId: input.turnId,
      operationKey: input.operationKey,
      presentationKey: input.presentationKey,
      revision: input.revision,
      leafId: input.leafId,
    },
  });
  if (result.inserted) {
    await input.tx
      .update(conversations)
      .set({
        status: "awaiting_input",
        upstreamTaskId: input.authoritativeTaskId,
        previousResponseId: input.authoritativeTaskId,
        deletedMessageIds: (conversation.deletedMessageIds || []).filter(
          (id: string) => id !== publicMessageId,
        ),
        version: conversation.version + 1,
        completedAt: null,
        updatedAt: input.sentAt,
      })
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.userId, input.userId),
          eq(conversations.version, conversation.version),
        ),
      );
  }
  return { ...result, publicMessageId };
}

export async function markKnowledgeBaseConversationCompletedInTransaction(
  input: {
    tx: any;
    userId: number;
    conversationId: string;
    authoritativeTaskId: string | null;
    completedAt: Date;
  },
) {
  const conversation = await lockedConversation(input.tx, input);
  await input.tx
    .update(conversations)
    .set({
      status: "completed",
      upstreamTaskId: input.authoritativeTaskId,
      previousResponseId: input.authoritativeTaskId,
      version: conversation.version + 1,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
    })
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.userId, input.userId),
        eq(conversations.version, conversation.version),
      ),
    );
}

export async function markKnowledgeBaseConversationFailedInTransaction(input: {
  tx: any;
  userId: number;
  conversationId: string;
  authoritativeTaskId: string | null;
  failedAt: Date;
}) {
  const conversation = await lockedConversation(input.tx, input);
  await input.tx
    .update(conversations)
    .set({
      status: "failed",
      upstreamTaskId: input.authoritativeTaskId,
      previousResponseId: input.authoritativeTaskId,
      version: conversation.version + 1,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    })
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.userId, input.userId),
        eq(conversations.version, conversation.version),
      ),
    );
}

export async function markKnowledgeBaseConversationAwaitingInputInTransaction(
  input: {
    tx: any;
    userId: number;
    conversationId: string;
    authoritativeTaskId: string | null;
    updatedAt: Date;
  },
) {
  const conversation = await lockedConversation(input.tx, input);
  await input.tx
    .update(conversations)
    .set({
      status: "awaiting_input",
      upstreamTaskId: input.authoritativeTaskId,
      previousResponseId: input.authoritativeTaskId,
      version: conversation.version + 1,
      completedAt: null,
      updatedAt: input.updatedAt,
    })
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.userId, input.userId),
        eq(conversations.version, conversation.version),
      ),
    );
}
