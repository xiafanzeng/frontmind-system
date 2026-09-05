import { createHash } from "node:crypto";

import { z } from "zod";

import type { MessageMetadata } from "../drizzle/schema";
import {
  KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT,
  knowledgeBaseCompletionMessagePublicId,
  knowledgeBasePresentationMessagePublicId,
  knowledgeBaseUserMessagePublicId,
} from "../shared/knowledge-base-message";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";

export const knowledgeBaseMessageSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  kind: z.enum(["pending_user", "presentation", "completion"]),
  buildId: z.string().min(1).max(128).optional(),
  operationKey: z.string().min(1).max(128).optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
  turnId: z.string().min(1).max(128).optional(),
  presentationKey: z.string().min(1).max(191).optional(),
  contentSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  generation: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative().optional(),
  leafId: z.string().max(191).nullable().optional(),
  serverOwned: z.boolean().optional(),
});

export type KnowledgeBaseMessageMetadata = z.infer<
  typeof knowledgeBaseMessageSchema
>;

export type ServerOwnedMessageIdentity = {
  id: string;
  conversationId: string;
  turnId: string | null;
  userId: number;
  role: string;
  content: string;
};

export type ServerOwnedTurnIdentity = {
  id: string;
  conversationId: string;
  userId: number;
  clientRequestId: string;
  buildId: string | null;
  buildGeneration: number | null;
  operationKey: string | null;
  expectedRevision: number | null;
  expectedLeafId: string | null;
  status: string;
};

export type ServerOwnedBuildIdentity = {
  id: string;
  userId: number;
  conversationId: string;
};

export function parsedKnowledgeBaseMessageMetadata(
  metadata: MessageMetadata | null | undefined,
) {
  const parsed = knowledgeBaseMessageSchema.safeParse(metadata?.knowledgeBase);
  return parsed.success ? parsed.data : undefined;
}

export function knowledgeBasePresentationKey(input: {
  buildId: string;
  generation: number;
  revision: number;
  leafId: string;
  content: string;
}) {
  return createHash("sha256")
    .update(
      [
        input.buildId,
        input.generation,
        input.revision,
        input.leafId,
        knowledgeBaseMarkdownSha256(input.content),
      ].join(":"),
    )
    .digest("hex");
}

function persistedAccountMessageId(userId: number, publicMessageId: string) {
  return `u${userId}:${publicMessageId}`;
}

/**
 * `serverOwned` is only a marker. Authority comes from the complete immutable
 * message id + turn + build tuple. This verifier intentionally needs the
 * historical source turn, but it never depends on the build's current
 * `activeTurnId` projection.
 */
export function matchesAuthoritativeKnowledgeBaseMessageTuple(input: {
  message: ServerOwnedMessageIdentity;
  knowledgeBase: KnowledgeBaseMessageMetadata;
  turn: ServerOwnedTurnIdentity | undefined;
  build: ServerOwnedBuildIdentity | undefined;
  publicConversationId: string;
}) {
  const { message, knowledgeBase, turn, build } = input;
  const expectedPersistedConversationId = `u${message.userId}:${input.publicConversationId}`;
  if (expectedPersistedConversationId.length > 191) return false;
  if (
    knowledgeBase.serverOwned !== true ||
    knowledgeBase.schemaVersion !== 1 ||
    !turn ||
    !build ||
    message.userId !== turn.userId ||
    message.conversationId !== expectedPersistedConversationId ||
    message.conversationId !== turn.conversationId ||
    message.turnId !== turn.id ||
    build.userId !== message.userId ||
    build.conversationId !== input.publicConversationId ||
    knowledgeBase.turnId !== turn.id ||
    knowledgeBase.buildId !== turn.buildId ||
    knowledgeBase.buildId !== build.id ||
    knowledgeBase.generation !== turn.buildGeneration ||
    knowledgeBase.operationKey !== turn.operationKey ||
    knowledgeBase.revision === undefined ||
    knowledgeBase.leafId === undefined
  ) {
    return false;
  }

  if (knowledgeBase.kind === "pending_user") {
    try {
      if (
        message.role !== "user" ||
        message.id !==
          persistedAccountMessageId(
            message.userId,
            knowledgeBaseUserMessagePublicId(turn.id),
          ) ||
        knowledgeBase.clientRequestId !== turn.clientRequestId ||
        knowledgeBase.presentationKey !== undefined ||
        knowledgeBase.contentSha256 !== undefined ||
        knowledgeBase.revision !== turn.expectedRevision ||
        (knowledgeBase.leafId ?? null) !== (turn.expectedLeafId ?? null)
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  if (knowledgeBase.kind === "completion") {
    try {
      return (
        message.role === "assistant" &&
        turn.status === "completed" &&
        message.content === KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT &&
        knowledgeBase.clientRequestId === undefined &&
        knowledgeBase.presentationKey === undefined &&
        knowledgeBase.contentSha256 === undefined &&
        knowledgeBase.leafId === null &&
        (knowledgeBase.revision === turn.expectedRevision ||
          knowledgeBase.revision === (turn.expectedRevision ?? -2) + 1) &&
        message.id ===
          persistedAccountMessageId(
            message.userId,
            knowledgeBaseCompletionMessagePublicId({
              buildId: build.id,
              generation: knowledgeBase.generation,
              revision: knowledgeBase.revision,
            }),
          )
      );
    } catch {
      return false;
    }
  }

  if (
    message.role !== "assistant" ||
    turn.status !== "completed" ||
    knowledgeBase.clientRequestId !== undefined ||
    !knowledgeBase.presentationKey ||
    !knowledgeBase.leafId ||
    (knowledgeBase.revision !== turn.expectedRevision &&
      knowledgeBase.revision !== (turn.expectedRevision ?? -2) + 1)
  ) {
    return false;
  }
  try {
    const contentSha256 = knowledgeBaseMarkdownSha256(message.content);
    return (
      message.id ===
        persistedAccountMessageId(
          message.userId,
          knowledgeBasePresentationMessagePublicId(
            knowledgeBase.presentationKey,
          ),
        ) &&
      knowledgeBase.presentationKey ===
        knowledgeBasePresentationKey({
          buildId: build.id,
          generation: knowledgeBase.generation,
          revision: knowledgeBase.revision,
          leafId: knowledgeBase.leafId,
          content: message.content,
        }) &&
      (knowledgeBase.contentSha256 === undefined ||
        knowledgeBase.contentSha256 === contentSha256)
    );
  } catch {
    return false;
  }
}
