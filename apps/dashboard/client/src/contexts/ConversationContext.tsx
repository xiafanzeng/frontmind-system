import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  ConversationSyncQueue,
  getErrorMessage,
} from "@/lib/conversation-sync";
import { trpc } from "@/lib/trpc";
import {
  sanitizeBrandText,
  type TaskResponse,
  type OutputMessage,
} from "@/lib/frontmind-api";
import { normalizeKnowledgeCollectionCopy } from "@shared/knowledge-base-copy";
import {
  knowledgeBasePresentationMessagePublicId,
  knowledgeBaseUserMessagePublicId,
} from "@shared/knowledge-base-message";
import {
  stripKnowledgeBaseProtocolPayloads,
  stripKnowledgeBaseReferenceAppendix,
} from "@shared/knowledge-base-output";
import { uniquifyOrderedIds } from "@shared/ordered-id";
import {
  reconcileKnowledgeBaseObservation,
  type KnowledgeBaseObservationDto,
} from "@/lib/knowledge-progress";
import { KnowledgeBasePollingCoordinator } from "@/lib/knowledge-base-coordinator";
import {
  isAttachmentExpired,
  localAttachmentPayloadExpiresAt,
} from "@/lib/attachment-expiry";

// Types for local conversation management
export interface Attachment {
  id: string;
  type: "file" | "image";
  name: string;
  fileId?: string; // from FrontMind Files API
  base64?: string; // for image/small file preview (data URL)
  blobUrl?: string; // in-memory blob URL for large files (not persisted to localStorage)
  file?: File;
  /** Absolute millisecond epoch after which the attachment must be re-uploaded. */
  expiresAt?: number;
  /** Authoritative expiry flag returned by the file service. */
  expired?: boolean;
}

/**
 * Represents a single intermediate step (e.g., search, browse, code execution)
 */
export interface IntermediateStep {
  id: string;
  type: string; // "web_search_call" | "computer_call" | "code_interpreter_call" | "function_call" | "reasoning" | etc.
  label: string; // Human-readable label for display
  description?: string; // Optional description/summary text
  details?: string; // Additional details (e.g., search query, URL, code)
}

/**
 * A group of intermediate steps under a common phase/title
 */
export interface StepGroup {
  id: string;
  title: string; // Group title (e.g., "搜集华为最新动态与数据")
  steps: IntermediateStep[];
  description?: string; // Optional description text between steps
}

export interface LocalMessage {
  id: string;
  /** Server-owned conversation order. Browser timestamps are never authoritative. */
  serverSequence?: number;
  /** Stable provider output identity; the local id may be disambiguated per turn. */
  upstreamOutputId?: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  timestamp: number;
  outputFiles?: { fileUrl: string; fileName: string; mimeType: string }[];
  /** Inline base64 images embedded in assistant text (for display in MarkdownRenderer) */
  inlineImages?: { src: string; alt?: string }[];
  /** Per-response elapsed time in seconds (set when the response completes) */
  elapsedTime?: number;
  /** Timestamp when this response started being processed */
  responseStartedAt?: number;
  /** Intermediate steps (search, browse, code, reasoning) shown before this message */
  intermediateSteps?: IntermediateStep[];
  /** Grouped intermediate steps for display */
  stepGroups?: StepGroup[];
  /** Whether this is a steps-only placeholder (no text content yet) */
  isStepsPlaceholder?: boolean;
  /** The public model profile used for this message (e.g. "frontmind-lite") */
  modelName?: string;
  /** Server-approved knowledge-base projection metadata. Never inferred from raw output. */
  knowledgeBase?: {
    schemaVersion?: 1;
    kind: "pending_user" | "presentation";
    buildId?: string;
    operationKey?: string;
    clientRequestId?: string;
    turnId?: string;
    presentationKey?: string;
    generation?: number;
    revision?: number;
    leafId?: string | null;
    serverOwned?: boolean;
  };
}

export interface KnowledgeBaseClientNotice {
  errorKey: string;
  code?: string;
  message: string;
  severity: "info" | "warning" | "error";
  retryable: boolean;
  turnId?: string | null;
}

export interface KnowledgeBaseClientState {
  initialized: boolean;
  generation: number;
  stateEpoch: number;
  activeTurnId: string | null;
  activeClientRequestId: string | null;
  /** Provenance of the currently approved presentation; remains after the reservation is released. */
  presentationTurnId: string | null;
  interactionState: KnowledgeBaseObservationDto["interaction"]["interactionState"];
  canReply: boolean;
  presentationKey: string | null;
  revision: number | null;
  leafId: string | null;
  notice: KnowledgeBaseClientNotice | null;
}

export interface Conversation {
  id: string;
  title: string;
  messages: LocalMessage[];
  taskId?: string; // Upstream task ID
  previousResponseId?: string;
  status:
    | "idle"
    | "running"
    | "pending"
    | "awaiting_input"
    | "completed"
    | "error"
    | "failed";
  taskUrl?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number; // Task start timestamp
  completedAt?: number; // Task completion timestamp
  /**
   * Bug 3 fix: Track the total number of output items from the API after each
   * turn completes. Since the FrontMind API returns the SAME response ID for
   * multi-turn conversations and accumulates output items, this lets us
   * slice only new items on the next turn: output.slice(lastKnownOutputLength).
   */
  lastKnownOutputLength?: number;
  /** IDs of messages that were manually deleted by the user (to prevent re-appearing from polling) */
  deletedMessageIds?: string[];
  /**
   * Fingerprint of the API key that created this conversation.
   * Used to prevent cross-key task continuation.
   * Format: "sk-a...b1c2" (first 4 + last 4 chars of the key).
   */
  apiKeyFingerprint?: string;
  /** Authoritative KB UI state. It is refreshed from the server observation. */
  knowledgeBase?: KnowledgeBaseClientState;
}

export function repairConversationMessageIds(
  messages: readonly LocalMessage[],
): LocalMessage[] {
  const repairedMessages = uniquifyOrderedIds(messages);
  const repairedAttachments = uniquifyOrderedIds(
    repairedMessages.flatMap((message) => message.attachments ?? []),
  );
  let attachmentIndex = 0;

  return repairedMessages.map((message) => {
    if (!message.attachments?.length) return message;
    const nextAttachments = repairedAttachments.slice(
      attachmentIndex,
      attachmentIndex + message.attachments.length,
    );
    attachmentIndex += message.attachments.length;
    return { ...message, attachments: nextAttachments };
  });
}

export function isServerOwnedKnowledgeBaseMessage(message: LocalMessage) {
  return message.knowledgeBase?.serverOwned === true;
}

function hasServerOwnedKnowledgeBaseMessages(conversation: Conversation) {
  return conversation.messages.some(isServerOwnedKnowledgeBaseMessage);
}

interface ConversationState {
  conversations: Conversation[];
  activeConversationId: string | null;
}

function attachmentHasBrowserPayload(attachment: Attachment) {
  return Boolean(attachment.file || attachment.blobUrl || attachment.base64);
}

function expireConversationAttachmentPayloads(
  state: ConversationState,
  now = Date.now(),
): ConversationState {
  let stateChanged = false;
  const conversations = state.conversations.map((conversation) => {
    let conversationChanged = false;
    const messages = conversation.messages.map((message) => {
      if (!message.attachments?.length) return message;
      let messageChanged = false;
      const attachments = message.attachments.map((attachment) => {
        const payloadDeadline = attachmentHasBrowserPayload(attachment)
          ? localAttachmentPayloadExpiresAt(attachment, message.timestamp)
          : undefined;
        const expired =
          isAttachmentExpired(attachment, now) ||
          (payloadDeadline !== undefined && payloadDeadline <= now);
        if (!expired) return attachment;
        const {
          file: _file,
          blobUrl: _blobUrl,
          base64: _base64,
          ...metadata
        } = attachment;
        if (
          attachment.expired === true &&
          !attachmentHasBrowserPayload(attachment)
        ) {
          return attachment;
        }
        messageChanged = true;
        return { ...metadata, expired: true };
      });
      if (!messageChanged) return message;
      conversationChanged = true;
      return { ...message, attachments };
    });
    if (!conversationChanged) return conversation;
    stateChanged = true;
    return { ...conversation, messages };
  });
  return stateChanged ? { ...state, conversations } : state;
}

function collectAttachmentBlobUrls(state: ConversationState): Set<string> {
  const urls = new Set<string>();
  for (const conversation of state.conversations) {
    for (const message of conversation.messages) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.blobUrl?.startsWith("blob:")) {
          urls.add(attachment.blobUrl);
        }
      }
    }
  }
  return urls;
}

function revokeReleasedAttachmentBlobUrls(
  previous: ConversationState,
  incoming: ConversationState,
  retained: ConversationState,
) {
  if (typeof URL.revokeObjectURL !== "function") return;
  const candidates = new Set([
    ...collectAttachmentBlobUrls(previous),
    ...collectAttachmentBlobUrls(incoming),
  ]);
  const retainedUrls = collectAttachmentBlobUrls(retained);
  for (const url of candidates) {
    if (!retainedUrls.has(url)) URL.revokeObjectURL(url);
  }
}

function nextAttachmentPayloadExpiry(state: ConversationState, now: number) {
  let nextExpiry: number | undefined;
  for (const conversation of state.conversations) {
    for (const message of conversation.messages) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.expired) continue;
        const deadline =
          typeof attachment.expiresAt === "number" &&
          Number.isFinite(attachment.expiresAt)
            ? attachment.expiresAt
            : attachmentHasBrowserPayload(attachment)
              ? localAttachmentPayloadExpiresAt(attachment, message.timestamp)
              : undefined;
        if (deadline === undefined) continue;
        if (deadline <= now) return now;
        nextExpiry =
          nextExpiry === undefined ? deadline : Math.min(nextExpiry, deadline);
      }
    }
  }
  return nextExpiry;
}

type Action =
  | { type: "NEW_CONVERSATION"; payload: Conversation }
  | { type: "SET_ACTIVE"; payload: string }
  | {
      type: "ADD_MESSAGE";
      payload: { conversationId: string; message: LocalMessage };
    }
  | {
      type: "UPDATE_STATUS";
      payload: {
        conversationId: string;
        status: Conversation["status"];
        taskId?: string;
        taskUrl?: string;
        previousResponseId?: string;
        startedAt?: number;
        completedAt?: number;
        lastKnownOutputLength?: number;
      };
    }
  | {
      type: "UPDATE_ASSISTANT_MESSAGES";
      payload: { conversationId: string; messages: LocalMessage[] };
    }
  | {
      type: "MARK_KNOWLEDGE_BASE";
      payload: { conversationId: string };
    }
  | {
      type: "COMMIT_KB_OBSERVATION";
      payload: {
        conversationId: string;
        observation: KnowledgeBaseObservationDto;
      };
    }
  | {
      type: "ROLLBACK_KB_PENDING_TURN";
      payload: { conversationId: string; clientRequestId: string };
    }
  | {
      type: "SETTLE_KB_START_FAILURE";
      payload: { conversationId: string; clientRequestId: string };
    }
  | { type: "UPDATE_TITLE"; payload: { conversationId: string; title: string } }
  | { type: "DELETE_CONVERSATION"; payload: string }
  | { type: "DISCARD_CONVERSATION_LOCALLY"; payload: string }
  | {
      type: "DELETE_MESSAGE";
      payload: { conversationId: string; messageId: string };
    }
  | { type: "LOAD_STATE"; payload: ConversationState };

function conversationReducer(
  state: ConversationState,
  action: Action,
): ConversationState {
  switch (action.type) {
    case "NEW_CONVERSATION": {
      return {
        ...state,
        conversations: [action.payload, ...state.conversations],
        activeConversationId: action.payload.id,
      };
    }
    case "SET_ACTIVE": {
      return { ...state, activeConversationId: action.payload };
    }
    case "ADD_MESSAGE": {
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.conversationId
            ? {
                ...c,
                messages: repairConversationMessageIds([
                  ...c.messages,
                  action.payload.message,
                ]),
                updatedAt: Date.now(),
              }
            : c,
        ),
      };
    }
    case "UPDATE_STATUS": {
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.conversationId
            ? {
                ...c,
                status: action.payload.status,
                taskId: action.payload.taskId ?? c.taskId,
                taskUrl: action.payload.taskUrl ?? c.taskUrl,
                previousResponseId:
                  action.payload.previousResponseId ?? c.previousResponseId,
                startedAt: action.payload.startedAt ?? c.startedAt,
                completedAt:
                  action.payload.completedAt !== undefined
                    ? action.payload.completedAt
                    : (action.payload.status === "running" ||
                          action.payload.status === "pending") &&
                        action.payload.startedAt !== undefined
                      ? undefined
                      : c.completedAt,
                lastKnownOutputLength:
                  action.payload.lastKnownOutputLength ??
                  c.lastKnownOutputLength,
                updatedAt: Date.now(),
              }
            : c,
        ),
      };
    }
    case "UPDATE_ASSISTANT_MESSAGES": {
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== action.payload.conversationId) return c;
          if (
            c.knowledgeBase?.initialized ||
            hasServerOwnedKnowledgeBaseMessages(c)
          ) {
            return c;
          }

          // Find the index of the last user message.
          // All assistant messages after it belong to the current turn and will be
          // REPLACED by the incoming (authoritative) set from parseOutputMessages.
          const messages = [...c.messages];
          let lastUserIdx = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              lastUserIdx = i;
              break;
            }
          }

          // Keep everything up to and including the last user message
          const kept = messages.slice(0, lastUserIdx + 1);

          // Only filter out messages that were manually deleted by the user
          const deletedIds = new Set(c.deletedMessageIds || []);

          const newMessages = action.payload.messages.filter((m) => {
            // Skip messages that were manually deleted
            if (m.id && deletedIds.has(m.id)) return false;
            // Steps placeholders always pass through (they get replaced each poll)
            if (m.isStepsPlaceholder) return true;
            return true;
          });

          // Provider output IDs can be reused across two user turns. Preserve
          // both turns and deterministically disambiguate the local/database ID.
          return {
            ...c,
            messages: repairConversationMessageIds([...kept, ...newMessages]),
            updatedAt: Date.now(),
          };
        }),
      };
    }
    case "MARK_KNOWLEDGE_BASE": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id !== action.payload.conversationId ||
          conversation.knowledgeBase
            ? conversation
            : {
                ...conversation,
                knowledgeBase: emptyKnowledgeBaseClientState(),
              },
        ),
      };
    }
    case "ROLLBACK_KB_PENDING_TURN": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          if (conversation.id !== action.payload.conversationId) {
            return conversation;
          }
          return {
            ...conversation,
            messages: conversation.messages.filter(
              (message) =>
                isServerOwnedKnowledgeBaseMessage(message) ||
                !(
                  message.knowledgeBase?.kind === "pending_user" &&
                  message.knowledgeBase.clientRequestId ===
                    action.payload.clientRequestId
                ),
            ),
            updatedAt: Date.now(),
          };
        }),
      };
    }
    case "SETTLE_KB_START_FAILURE": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          if (conversation.id !== action.payload.conversationId) {
            return conversation;
          }
          const requestWasAccepted = conversation.messages.some(
            (message) =>
              isServerOwnedKnowledgeBaseMessage(message) &&
              message.knowledgeBase?.kind === "pending_user" &&
              message.knowledgeBase.clientRequestId ===
                action.payload.clientRequestId,
          );
          if (requestWasAccepted) return conversation;
          const messages = conversation.messages.filter(
            (message) =>
              isServerOwnedKnowledgeBaseMessage(message) ||
              !(
                message.knowledgeBase?.kind === "pending_user" &&
                message.knowledgeBase.clientRequestId ===
                  action.payload.clientRequestId
              ),
          );
          if (messages.length === conversation.messages.length) {
            return conversation;
          }
          return {
            ...conversation,
            messages,
            status: "idle",
            taskId: undefined,
            taskUrl: undefined,
            previousResponseId: undefined,
            startedAt: undefined,
            completedAt: undefined,
            lastKnownOutputLength: undefined,
            updatedAt: Date.now(),
          };
        }),
      };
    }
    case "COMMIT_KB_OBSERVATION": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.payload.conversationId
            ? applyKnowledgeBaseObservation(
                conversation,
                action.payload.observation,
              )
            : conversation,
        ),
      };
    }
    case "UPDATE_TITLE": {
      // Safety net: always truncate title to 10 chars + ellipsis
      const rawTitle = action.payload.title || "新内容流程";
      const safeTitle =
        rawTitle.length > 10 ? rawTitle.slice(0, 10) + "..." : rawTitle;
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.payload.conversationId
            ? { ...c, title: safeTitle, updatedAt: Date.now() }
            : c,
        ),
      };
    }
    case "DELETE_MESSAGE": {
      return {
        ...state,
        conversations: state.conversations.map((c) => {
          if (c.id !== action.payload.conversationId) return c;
          const target = c.messages.find(
            (message) => message.id === action.payload.messageId,
          );
          if (target && isServerOwnedKnowledgeBaseMessage(target)) return c;
          return {
            ...c,
            messages: c.messages.filter(
              (m) => m.id !== action.payload.messageId,
            ),
            deletedMessageIds: [
              ...(c.deletedMessageIds || []),
              action.payload.messageId,
            ],
            updatedAt: Date.now(),
          };
        }),
      };
    }
    case "DELETE_CONVERSATION": {
      const target = state.conversations.find(
        (conversation) => conversation.id === action.payload,
      );
      if (
        target &&
        (target.knowledgeBase?.initialized ||
          hasServerOwnedKnowledgeBaseMessages(target))
      ) {
        return state;
      }
      const remaining = state.conversations.filter(
        (c) => c.id !== action.payload,
      );
      return {
        ...state,
        conversations: remaining,
        activeConversationId:
          state.activeConversationId === action.payload
            ? (remaining[0]?.id ?? null)
            : state.activeConversationId,
      };
    }
    case "DISCARD_CONVERSATION_LOCALLY": {
      const remaining = state.conversations.filter(
        (c) => c.id !== action.payload,
      );
      return {
        ...state,
        conversations: remaining,
        activeConversationId:
          state.activeConversationId === action.payload
            ? (remaining[0]?.id ?? null)
            : state.activeConversationId,
      };
    }
    case "LOAD_STATE": {
      return action.payload;
    }
    default:
      return state;
  }
}

function emptyKnowledgeBaseClientState(): KnowledgeBaseClientState {
  return {
    initialized: false,
    generation: 0,
    stateEpoch: 0,
    activeTurnId: null,
    activeClientRequestId: null,
    presentationTurnId: null,
    interactionState: "queued",
    canReply: false,
    presentationKey: null,
    revision: null,
    leafId: null,
    notice: null,
  };
}

function stableKnowledgeBaseMessageId(key: string) {
  return knowledgeBasePresentationMessagePublicId(key);
}

function observationActiveTurnId(observation: KnowledgeBaseObservationDto) {
  return observation.activeTurn?.id ?? null;
}

export function approvedKnowledgeBasePresentationMatches(
  observation: KnowledgeBaseObservationDto,
) {
  const presentation = observation.approvedPresentation;
  const progress = observation.progress ?? observation.interaction.progress;
  const activeTurnId = observationActiveTurnId(observation);
  return Boolean(
    presentation &&
      presentation.visibleMarkdown.trim() &&
      presentation.turnId &&
      (!activeTurnId || presentation.turnId === activeTurnId) &&
      progress &&
      presentation.revision === progress.build.revision &&
      presentation.leafId === progress.build.currentLeafId,
  );
}

function knowledgeObservationIsStale(
  current: KnowledgeBaseClientState | undefined,
  observation: KnowledgeBaseObservationDto,
) {
  if (!current) return false;
  if (!current.initialized) return false;
  if (observation.generation < current.generation) return true;
  if (observation.generation > current.generation) return false;
  if (observation.stateEpoch < current.stateEpoch) return true;
  if (observation.stateEpoch > current.stateEpoch) return false;

  const incomingTurnId = observationActiveTurnId(observation);
  if (
    current.activeTurnId &&
    incomingTurnId &&
    current.activeTurnId !== incomingTurnId
  ) {
    return true;
  }
  return (
    current.activeTurnId === incomingTurnId &&
    current.interactionState === observation.interaction.interactionState &&
    current.presentationKey ===
      (observation.approvedPresentation?.presentationKey ?? null) &&
    current.notice?.errorKey === (observation.notice?.key ?? undefined)
  );
}

function observationPrecedesPersistedKnowledgeBaseHistory(
  messages: readonly LocalMessage[],
  observation: KnowledgeBaseObservationDto,
) {
  const persisted = messages
    .filter(
      (message) =>
        isServerOwnedKnowledgeBaseMessage(message) &&
        message.knowledgeBase?.kind === "presentation",
    )
    .reduce(
      (latest, message) => {
        const candidate = {
          generation: message.knowledgeBase?.generation ?? -1,
          revision: message.knowledgeBase?.revision ?? -1,
        };
        return candidate.generation > latest.generation ||
          (candidate.generation === latest.generation &&
            candidate.revision > latest.revision)
          ? candidate
          : latest;
      },
      { generation: -1, revision: -1 },
    );
  if (observation.generation < persisted.generation) return true;
  const observedRevision =
    observation.approvedPresentation?.revision ??
    observation.interaction.progress?.build.revision ??
    -1;
  return (
    observation.generation === persisted.generation &&
    observedRevision < persisted.revision
  );
}

function knowledgeBasePresentationMessage(
  observation: KnowledgeBaseObservationDto,
): LocalMessage | null {
  const presentation = observation.approvedPresentation;
  if (!presentation || !approvedKnowledgeBasePresentationMatches(observation)) {
    return null;
  }
  const inlineImages = (presentation.resources ?? [])
    .map((resource) => ({
      src: resource.sameOriginUrl,
      alt: resource.filename,
      mimeType: resource.mimeType,
      kind: resource.kind,
    }))
    .filter(
      (resource) =>
        resource.src.startsWith("/") &&
        (resource.mimeType.startsWith("image/") ||
          /image|logo/i.test(resource.kind)),
    )
    .map(({ src, alt }) => ({ src, alt }));

  return {
    id: stableKnowledgeBaseMessageId(presentation.presentationKey),
    serverSequence: presentation.messageSequence,
    role: "assistant",
    content: sanitizeKnowledgeBaseCustomerMarkdown(
      presentation.visibleMarkdown,
    ),
    timestamp: Date.now(),
    inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
    knowledgeBase: {
      schemaVersion: 1,
      kind: "presentation",
      buildId: (observation.progress ?? observation.interaction.progress)?.build
        .id,
      operationKey: observation.activeTurn?.operationKey,
      turnId: presentation.turnId,
      presentationKey: presentation.presentationKey,
      generation: observation.generation,
      revision: presentation.revision,
      leafId: presentation.leafId,
      serverOwned: true,
    },
  };
}

export function applyKnowledgeBaseObservation(
  conversation: Conversation,
  observation: KnowledgeBaseObservationDto,
): Conversation {
  if (
    knowledgeObservationIsStale(conversation.knowledgeBase, observation) ||
    observationPrecedesPersistedKnowledgeBaseHistory(
      conversation.messages,
      observation,
    )
  ) {
    return conversation;
  }

  const activeTurnId = observationActiveTurnId(observation);
  const activeClientRequestId = observation.activeTurn?.clientRequestId ?? null;
  const presentationClientRequestId =
    observation.approvedPresentation?.clientRequestId ?? null;
  const presentation = knowledgeBasePresentationMessage(observation);
  const presentationMatches = Boolean(presentation);
  const interactionState = observation.interaction.interactionState;
  const nextStatus: Conversation["status"] =
    interactionState === "awaiting_input"
      ? presentationMatches && observation.interaction.canReply
        ? "awaiting_input"
        : "running"
      : interactionState === "ready_to_publish" ||
          interactionState === "published"
        ? "completed"
        : interactionState === "failed"
          ? "error"
          : interactionState === "queued"
            ? "pending"
            : "running";

  let messages = conversation.messages;
  let presentationUserIndex = -1;
  if (activeTurnId && activeClientRequestId) {
    messages = messages.map((message) => {
      if (
        message.role !== "user" ||
        message.knowledgeBase?.kind !== "pending_user" ||
        message.knowledgeBase.clientRequestId !== activeClientRequestId
      ) {
        return message;
      }
      return {
        ...message,
        id: knowledgeBaseUserMessagePublicId(activeTurnId),
        serverSequence:
          observation.activeTurn?.messageSequence ?? message.serverSequence,
        knowledgeBase: {
          ...message.knowledgeBase,
          schemaVersion: 1,
          buildId: (observation.progress ?? observation.interaction.progress)
            ?.build.id,
          operationKey: observation.activeTurn?.operationKey,
          turnId: activeTurnId,
          generation: observation.generation,
          revision: observation.activeTurn?.expectedRevision ?? undefined,
          leafId: observation.activeTurn?.expectedLeafId ?? null,
          serverOwned: true,
        },
      };
    });
    if (presentation?.knowledgeBase?.turnId === activeTurnId) {
      presentationUserIndex = messages.findIndex(
        (message) =>
          message.role === "user" &&
          message.knowledgeBase?.clientRequestId === activeClientRequestId &&
          message.knowledgeBase?.turnId === activeTurnId,
      );
    }
  }
  if (presentation && !activeClientRequestId && presentationClientRequestId) {
    const pendingIndex = messages.findIndex(
      (message) =>
        message.role === "user" &&
        message.knowledgeBase?.kind === "pending_user" &&
        message.knowledgeBase.clientRequestId === presentationClientRequestId,
    );
    if (pendingIndex >= 0) {
      const pending = messages[pendingIndex]!;
      messages = messages.map((message, index) =>
        index === pendingIndex
          ? {
              ...pending,
              id: knowledgeBaseUserMessagePublicId(
                presentation.knowledgeBase!.turnId!,
              ),
              serverSequence:
                observation.approvedPresentation?.requestMessageSequence ??
                pending.serverSequence,
              knowledgeBase: {
                ...pending.knowledgeBase!,
                schemaVersion: 1,
                buildId: (
                  observation.progress ?? observation.interaction.progress
                )?.build.id,
                turnId: presentation.knowledgeBase!.turnId,
                generation: observation.generation,
                revision: observation.approvedPresentation?.revision,
                leafId: observation.approvedPresentation?.leafId,
                serverOwned: true,
              },
            }
          : message,
      );
      presentationUserIndex = pendingIndex;
    }
  }
  if (presentation) {
    if (presentationUserIndex < 0) {
      presentationUserIndex = messages.findIndex(
        (message) =>
          message.role === "user" &&
          message.knowledgeBase?.serverOwned === true &&
          message.knowledgeBase.turnId === presentation.knowledgeBase?.turnId,
      );
    }
    const existingPresentationIndex = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.knowledgeBase?.presentationKey ===
          presentation.knowledgeBase?.presentationKey,
    );
    if (existingPresentationIndex >= 0) {
      messages = messages.map((message, index) =>
        index === existingPresentationIndex ? presentation : message,
      );
    } else if (presentationUserIndex >= 0) {
      messages = [
        ...messages.slice(0, presentationUserIndex + 1),
        presentation,
        ...messages.slice(presentationUserIndex + 1),
      ];
    } else {
      // A released observation without a matching request identity may be an
      // older presentation observed after a network-unknown POST. Keep every
      // optimistic message unbound; never guess that the last pending message
      // produced it. A presentation not already in local history can still be
      // appended as authoritative server content without claiming any request.
      messages = [...messages, presentation];
    }
  }
  // Observation commits and later cloud hydration must produce the same
  // ordering in the same render. In particular, do not briefly append the
  // approved current node after a newer optimistic request and wait for a
  // subsequent history fetch to repair it.
  messages = mergeServerOwnedKnowledgeBaseMessages([], messages);

  const protectedMessageIds = new Set(
    messages
      .filter(isServerOwnedKnowledgeBaseMessage)
      .map((message) => message.id),
  );

  const rawNotice = observation.notice;
  const noticeKey = rawNotice?.key;
  const notice =
    rawNotice?.message && noticeKey
      ? {
          errorKey: noticeKey,
          code: rawNotice.code,
          message: sanitizeBrandText(rawNotice.message),
          severity: rawNotice.severity ?? ("error" as const),
          retryable: rawNotice.retryable === true,
          turnId: rawNotice.turnId,
        }
      : null;

  return {
    ...conversation,
    messages,
    status: nextStatus,
    taskId: observation.authoritativeTaskId ?? conversation.taskId,
    previousResponseId:
      observation.authoritativeTaskId ?? conversation.previousResponseId,
    deletedMessageIds: conversation.deletedMessageIds?.filter(
      (messageId) => !protectedMessageIds.has(messageId),
    ),
    completedAt:
      nextStatus === "completed" || nextStatus === "error"
        ? Date.now()
        : undefined,
    knowledgeBase: {
      initialized: true,
      generation: observation.generation,
      stateEpoch: observation.stateEpoch,
      activeTurnId,
      activeClientRequestId,
      presentationTurnId:
        observation.approvedPresentation?.turnId ??
        conversation.knowledgeBase?.presentationTurnId ??
        null,
      interactionState,
      canReply:
        interactionState === "awaiting_input" &&
        presentationMatches &&
        observation.interaction.canReply,
      presentationKey:
        observation.approvedPresentation?.presentationKey ?? null,
      revision:
        observation.approvedPresentation?.revision ??
        observation.interaction.progress?.build.revision ??
        null,
      leafId:
        observation.approvedPresentation?.leafId ??
        observation.interaction.progress?.build.currentLeafId ??
        null,
      notice,
    },
    updatedAt: Date.now(),
  };
}

export function currentKnowledgeBasePresentationReady(
  conversation: Conversation | null | undefined,
  revision: number | undefined,
  leafId: string | null | undefined,
) {
  const knowledgeBase = conversation?.knowledgeBase;
  if (
    !conversation ||
    conversation.status !== "awaiting_input" ||
    !knowledgeBase?.canReply ||
    knowledgeBase.revision !== revision ||
    knowledgeBase.leafId !== leafId ||
    !knowledgeBase.presentationKey ||
    !knowledgeBase.presentationTurnId
  ) {
    return false;
  }
  return conversation.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.trim() &&
      message.knowledgeBase?.kind === "presentation" &&
      message.knowledgeBase.turnId === knowledgeBase.presentationTurnId &&
      message.knowledgeBase.presentationKey === knowledgeBase.presentationKey &&
      message.knowledgeBase.revision === revision &&
      message.knowledgeBase.leafId === leafId,
  );
}

const EMPTY_STATE: ConversationState = {
  conversations: [],
  activeConversationId: null,
};

function getTrpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === "string" ? data.code : undefined;
}

/**
 * Convert an optimistic browser conversation into the JSON snapshot accepted by
 * the server. Browser-only File/blob/base64 values and the legacy API-key
 * fingerprint are deliberately excluded from cloud persistence.
 */
export function prepareConversationForCloud(
  conversation: Conversation,
): Conversation {
  const { apiKeyFingerprint: _legacyFingerprint, ...cloudConversation } =
    conversation;
  const repairedMessages = repairConversationMessageIds(conversation.messages);
  const protectedMessageIds = new Set(
    repairedMessages
      .filter(isServerOwnedKnowledgeBaseMessage)
      .map((message) => message.id),
  );

  return {
    ...cloudConversation,
    deletedMessageIds: conversation.deletedMessageIds?.filter(
      (messageId) => !protectedMessageIds.has(messageId),
    ),
    messages: repairedMessages.map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => {
        const {
          file: _file,
          blobUrl: _blobUrl,
          base64: _base64,
          ...metadata
        } = attachment;
        return metadata;
      }),
      inlineImages: message.inlineImages?.filter(
        (image) =>
          !image.src.startsWith("data:") && !image.src.startsWith("blob:"),
      ),
    })),
  };
}

function normalizeConversation(conversation: Conversation): Conversation {
  const toTimestamp = (value: unknown, fallback: number) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = new Date(value as string | Date).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const now = Date.now();
  const createdAt = toTimestamp(conversation.createdAt, now);
  const normalizedMessages = Array.isArray(conversation.messages)
    ? conversation.messages.map((message) => ({
        ...message,
        timestamp: toTimestamp(message.timestamp, createdAt),
      }))
    : [];

  return {
    ...conversation,
    // A crash can leave both the optimistic request and the canonical
    // server-owned turn in the first cloud snapshot. Collapse that pair before
    // it ever reaches the reducer; otherwise it survives until another save.
    messages: mergeServerOwnedKnowledgeBaseMessages([], normalizedMessages),
    createdAt,
    updatedAt: toTimestamp(conversation.updatedAt, createdAt),
    startedAt:
      conversation.startedAt === undefined
        ? undefined
        : toTimestamp(conversation.startedAt, createdAt),
    completedAt:
      conversation.completedAt === undefined
        ? undefined
        : toTimestamp(conversation.completedAt, createdAt),
  };
}

function knowledgeBaseMessageIdentity(message: LocalMessage) {
  const metadata = message.knowledgeBase;
  if (!metadata) return `id:${message.id}`;
  if (metadata.presentationKey) {
    return `presentation:${metadata.presentationKey}`;
  }
  if (metadata.kind === "pending_user" && metadata.clientRequestId) {
    return `request:${metadata.clientRequestId}:${metadata.kind}`;
  }
  if (metadata.turnId) return `turn:${metadata.turnId}:${metadata.kind}`;
  if (metadata.clientRequestId) {
    return `request:${metadata.clientRequestId}:${metadata.kind}`;
  }
  return `id:${message.id}`;
}

function knowledgeBaseMessageVersion(message: LocalMessage) {
  return [
    message.knowledgeBase?.generation ?? -1,
    message.knowledgeBase?.revision ?? -1,
    message.timestamp,
  ] as const;
}

function knowledgeBaseMessageIsAtLeastAsNew(
  candidate: LocalMessage,
  current: LocalMessage,
) {
  if (
    candidate.serverSequence !== undefined ||
    current.serverSequence !== undefined
  ) {
    if (candidate.serverSequence === undefined) return false;
    if (current.serverSequence === undefined) return true;
  }
  const left = knowledgeBaseMessageVersion(candidate);
  const right = knowledgeBaseMessageVersion(current);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function retainKnowledgeBaseUserAttachments(
  preferred: LocalMessage,
  fallback: LocalMessage,
) {
  if (
    preferred.role !== "user" ||
    preferred.knowledgeBase?.kind !== "pending_user" ||
    fallback.knowledgeBase?.kind !== "pending_user" ||
    !fallback.attachments?.length
  ) {
    return preferred;
  }
  if (!preferred.attachments?.length) {
    return preferred;
  }

  const usedFallbackIndexes = new Set<number>();
  const attachments = preferred.attachments.map((authoritativeAttachment) => {
    // Browser bytes are capabilities, not display metadata. Reattach them
    // only when the authoritative message names the exact same opaque
    // upstream file ID. ID/name/index similarity is never sufficient.
    if (
      !authoritativeAttachment.fileId ||
      !authoritativeAttachment.fileId.trim()
    ) {
      return authoritativeAttachment;
    }
    const fallbackIndex = fallback.attachments!.findIndex(
      (candidate, candidateIndex) =>
        !usedFallbackIndexes.has(candidateIndex) &&
        candidate.fileId === authoritativeAttachment.fileId,
    );

    if (fallbackIndex < 0) return authoritativeAttachment;
    usedFallbackIndexes.add(fallbackIndex);
    const browserAttachment = fallback.attachments![fallbackIndex]!;
    return {
      ...authoritativeAttachment,
      ...(authoritativeAttachment.file === undefined &&
      browserAttachment.file !== undefined
        ? { file: browserAttachment.file }
        : {}),
      ...(authoritativeAttachment.blobUrl === undefined &&
      browserAttachment.blobUrl !== undefined
        ? { blobUrl: browserAttachment.blobUrl }
        : {}),
      ...(authoritativeAttachment.base64 === undefined &&
      browserAttachment.base64 !== undefined
        ? { base64: browserAttachment.base64 }
        : {}),
    };
  });
  return { ...preferred, attachments };
}

function compareHydratedMessageOrder(left: LocalMessage, right: LocalMessage) {
  const leftIsServerOwned = isServerOwnedKnowledgeBaseMessage(left);
  const rightIsServerOwned = isServerOwnedKnowledgeBaseMessage(right);
  const leftIsOptimisticKnowledgeBase =
    Boolean(left.knowledgeBase) && !leftIsServerOwned;
  const rightIsOptimisticKnowledgeBase =
    Boolean(right.knowledgeBase) && !rightIsServerOwned;

  if (
    left.serverSequence !== undefined &&
    right.serverSequence !== undefined &&
    left.serverSequence !== right.serverSequence
  ) {
    return left.serverSequence - right.serverSequence;
  }

  // A server projection is read after its immutable database message has been
  // assigned a sequence. If a newer browser-only request is already visible,
  // Date.now() would otherwise make the older approved presentation appear
  // below that request until the next cloud hydration reorders the history.
  // An accepted request is promoted to server-owned before this comparison;
  // therefore a remaining optimistic KB message is necessarily after the
  // durable history represented by the projection.
  if (
    leftIsServerOwned &&
    left.serverSequence !== undefined &&
    rightIsOptimisticKnowledgeBase
  ) {
    return -1;
  }
  if (
    rightIsServerOwned &&
    right.serverSequence !== undefined &&
    leftIsOptimisticKnowledgeBase
  ) {
    return 1;
  }
  if (leftIsServerOwned && rightIsServerOwned) {
    const leftGeneration = left.knowledgeBase?.generation ?? -1;
    const rightGeneration = right.knowledgeBase?.generation ?? -1;
    if (leftGeneration !== rightGeneration) {
      return leftGeneration - rightGeneration;
    }
    const leftRevision = left.knowledgeBase?.revision ?? -1;
    const rightRevision = right.knowledgeBase?.revision ?? -1;
    if (leftRevision !== rightRevision) return leftRevision - rightRevision;
    if (left.knowledgeBase?.kind !== right.knowledgeBase?.kind) {
      const sameTurn =
        Boolean(left.knowledgeBase?.turnId) &&
        left.knowledgeBase?.turnId === right.knowledgeBase?.turnId;

      // The start request and its first presentation share a revision and a
      // turn, so the request comes first. Once a presentation is visible, the
      // next confirmation also carries that presentation's revision but owns
      // a new turn; in that case the presentation must stay before the request
      // that advances it. Sorting every pending message first temporarily put
      // 1.2 below the confirmation for 1.2, allowing 1.3 to render above 1.2
      // until a later hydration happened to rebuild the history.
      if (sameTurn) {
        return left.knowledgeBase?.kind === "pending_user" ? -1 : 1;
      }
      return left.knowledgeBase?.kind === "presentation" ? -1 : 1;
    }
  }
  return left.timestamp - right.timestamp;
}

/** Preserve immutable KB history when a cloud list response was read earlier. */
export function mergeServerOwnedKnowledgeBaseMessages(
  localMessages: readonly LocalMessage[],
  remoteMessages: readonly LocalMessage[],
) {
  const merged: LocalMessage[] = [];
  const identityToIndex = new Map<string, number>();
  const idToIndex = new Map<string, number>();
  for (const remoteMessage of remoteMessages) {
    const identity = knowledgeBaseMessageIdentity(remoteMessage);
    const existingIndex =
      identityToIndex.get(identity) ?? idToIndex.get(remoteMessage.id);
    if (existingIndex === undefined) {
      identityToIndex.set(identity, merged.length);
      idToIndex.set(remoteMessage.id, merged.length);
      merged.push(remoteMessage);
      continue;
    }
    const existing = merged[existingIndex]!;
    if (
      (isServerOwnedKnowledgeBaseMessage(remoteMessage) &&
        !isServerOwnedKnowledgeBaseMessage(existing)) ||
      (isServerOwnedKnowledgeBaseMessage(remoteMessage) &&
        knowledgeBaseMessageIsAtLeastAsNew(remoteMessage, existing))
    ) {
      merged[existingIndex] = retainKnowledgeBaseUserAttachments(
        remoteMessage,
        existing,
      );
      identityToIndex.set(identity, existingIndex);
      idToIndex.set(remoteMessage.id, existingIndex);
    } else {
      merged[existingIndex] = retainKnowledgeBaseUserAttachments(
        existing,
        remoteMessage,
      );
    }
  }
  for (const localMessage of localMessages) {
    const identity = knowledgeBaseMessageIdentity(localMessage);
    const existingIndex =
      identityToIndex.get(identity) ?? idToIndex.get(localMessage.id);
    if (!isServerOwnedKnowledgeBaseMessage(localMessage)) {
      // An observation/list response can win the race with the browser's
      // optimistic promotion. Copy only the upload chips onto the exact
      // accepted request identity; never append or authorize the local row.
      if (
        existingIndex !== undefined &&
        isServerOwnedKnowledgeBaseMessage(merged[existingIndex]!)
      ) {
        merged[existingIndex] = retainKnowledgeBaseUserAttachments(
          merged[existingIndex]!,
          localMessage,
        );
      }
      continue;
    }
    if (existingIndex === undefined) {
      identityToIndex.set(identity, merged.length);
      idToIndex.set(localMessage.id, merged.length);
      merged.push(localMessage);
      continue;
    }
    const existing = merged[existingIndex]!;
    if (
      !isServerOwnedKnowledgeBaseMessage(existing) ||
      knowledgeBaseMessageIsAtLeastAsNew(localMessage, existing)
    ) {
      merged[existingIndex] = retainKnowledgeBaseUserAttachments(
        localMessage,
        existing,
      );
      identityToIndex.set(identity, existingIndex);
      idToIndex.set(localMessage.id, existingIndex);
    } else {
      merged[existingIndex] = retainKnowledgeBaseUserAttachments(
        existing,
        localMessage,
      );
    }
  }
  return repairConversationMessageIds(
    merged
      .map((message, order) => ({ message, order }))
      .sort(
        (left, right) =>
          compareHydratedMessageOrder(left.message, right.message) ||
          left.order - right.order,
      )
      .map(({ message }) => message),
  );
}

export function mergeKnowledgeBaseHydration(
  local: Conversation | undefined,
  remote: Conversation,
): Conversation {
  if (!local) return remote;
  const protectedRemoteMessages = mergeServerOwnedKnowledgeBaseMessages(
    local.messages,
    remote.messages,
  );
  const protectedRemoteMessageIds = new Set(
    protectedRemoteMessages
      .filter(isServerOwnedKnowledgeBaseMessage)
      .map((message) => message.id),
  );
  const remoteWithProtectedHistory = {
    ...remote,
    messages: protectedRemoteMessages,
    deletedMessageIds: remote.deletedMessageIds?.filter(
      (messageId) => !protectedRemoteMessageIds.has(messageId),
    ),
  };
  if (!local.knowledgeBase?.initialized) return remoteWithProtectedHistory;
  const localState = local.knowledgeBase;
  const remoteState = remote.knowledgeBase;
  const remoteIsNewer = Boolean(
    remoteState?.initialized &&
      (remoteState.generation > localState.generation ||
        (remoteState.generation === localState.generation &&
          remoteState.stateEpoch > localState.stateEpoch)),
  );
  if (remoteIsNewer) return remoteWithProtectedHistory;

  // A list request may have started before an observation commit. Preserve the
  // locally accepted server projection until the coordinator supplies a newer
  // epoch; a stale cloud snapshot must not blank or rewind the current node.
  const protectedLocalMessages = mergeServerOwnedKnowledgeBaseMessages(
    remote.messages,
    local.messages,
  );
  const protectedLocalMessageIds = new Set(
    protectedLocalMessages
      .filter(isServerOwnedKnowledgeBaseMessage)
      .map((message) => message.id),
  );
  return {
    ...remote,
    messages: protectedLocalMessages,
    status: local.status,
    taskId: local.taskId,
    previousResponseId: local.previousResponseId,
    taskUrl: local.taskUrl,
    startedAt: local.startedAt,
    completedAt: local.completedAt,
    knowledgeBase: localState,
    deletedMessageIds: local.deletedMessageIds?.filter(
      (messageId) => !protectedLocalMessageIds.has(messageId),
    ),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

interface ConversationMutation<TInput, TOutput> {
  mutateAsync: (input: TInput) => Promise<TOutput>;
}

interface ConversationTrpcHooks {
  list: {
    useQuery: (
      input: { projectAssignmentId?: string },
      options: {
        enabled: boolean;
        retry: boolean;
        refetchOnWindowFocus: boolean;
      },
    ) => {
      refetch: () => Promise<{
        data?: Conversation[];
        error?: unknown;
      }>;
    };
  };
  syncSnapshot: {
    useMutation: () => ConversationMutation<
      { conversation: Conversation; projectAssignmentId?: string },
      Conversation
    >;
  };
  delete: {
    useMutation: () => ConversationMutation<
      { id: string; projectAssignmentId?: string },
      { success: true }
    >;
  };
}

interface ConversationContextType {
  state: ConversationState;
  activeConversation: Conversation | null;
  loading: boolean;
  hydrated: boolean;
  syncError: string | null;
  createConversation: (options?: {
    title?: string;
    reuseEmpty?: boolean;
  }) => string;
  setActive: (id: string) => void;
  addMessage: (conversationId: string, message: LocalMessage) => void;
  updateStatus: (
    conversationId: string,
    status: Conversation["status"],
    extra?: {
      taskId?: string;
      taskUrl?: string;
      previousResponseId?: string;
      startedAt?: number;
      completedAt?: number;
      lastKnownOutputLength?: number;
    },
  ) => void;
  updateAssistantMessages: (
    conversationId: string,
    messages: LocalMessage[],
  ) => void;
  registerKnowledgeBaseConversation: (conversationId: string) => void;
  wakeKnowledgeBaseConversation: (conversationId: string) => void;
  isKnowledgeBaseConversation: (conversationId: string) => boolean;
  commitKnowledgeBaseObservation: (
    conversationId: string,
    observation: KnowledgeBaseObservationDto,
  ) => void;
  rollbackPendingKnowledgeBaseTurn: (
    conversationId: string,
    clientRequestId: string,
  ) => void;
  settleKnowledgeBaseStartFailure: (
    conversationId: string,
    clientRequestId: string,
  ) => void;
  updateTitle: (conversationId: string, title: string) => void;
  deleteConversation: (id: string) => void;
  discardConversationLocally: (id: string) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  refreshConversations: () => Promise<void>;
  clearSyncError: () => void;
}

const ConversationContext = createContext<ConversationContextType | null>(null);

export function ConversationProvider({
  children,
  projectAssignmentId,
}: {
  children: React.ReactNode;
  projectAssignmentId?: string;
}) {
  const auth = useAuth();
  const authenticatedUser = auth.user as { id: number } | null;
  const userId = authenticatedUser?.id ?? null;
  const conversationApi = (
    trpc as unknown as { conversation: ConversationTrpcHooks }
  ).conversation;
  const listQuery = conversationApi.list.useQuery(
    projectAssignmentId ? { projectAssignmentId } : {},
    {
      enabled: false,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const syncSnapshotMutation = conversationApi.syncSnapshot.useMutation();
  const deleteMutation = conversationApi.delete.useMutation();

  const [state, dispatch] = useReducer(conversationReducer, EMPTY_STATE);
  const stateRef = useRef(state);
  const [hydrated, setHydrated] = useState(false);
  const [hydrationLoading, setHydrationLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const accountIdRef = useRef<number | null>(null);
  const hydrationGenerationRef = useRef(0);
  const canSyncRef = useRef(false);
  const listRefetchRef = useRef(listQuery.refetch);
  const syncSnapshotRef = useRef(syncSnapshotMutation.mutateAsync);
  const deleteRemoteRef = useRef(deleteMutation.mutateAsync);
  const projectAssignmentIdRef = useRef(projectAssignmentId);
  const knowledgeBaseConversationIdsRef = useRef(new Set<string>());
  const knowledgeBaseCoordinatorRef =
    useRef<KnowledgeBasePollingCoordinator | null>(null);
  const applyKnowledgeBaseObservationRef = useRef<
    (conversationId: string, observation: KnowledgeBaseObservationDto) => void
  >(() => undefined);

  listRefetchRef.current = listQuery.refetch;
  syncSnapshotRef.current = syncSnapshotMutation.mutateAsync;
  deleteRemoteRef.current = deleteMutation.mutateAsync;
  projectAssignmentIdRef.current = projectAssignmentId;

  const syncQueueRef = useRef<ConversationSyncQueue<Conversation> | null>(null);
  if (!syncQueueRef.current) {
    syncQueueRef.current = new ConversationSyncQueue<Conversation>({
      syncSnapshot: (conversation) =>
        syncSnapshotRef.current({
          conversation,
          ...(projectAssignmentIdRef.current
            ? { projectAssignmentId: projectAssignmentIdRef.current }
            : {}),
        }),
      deleteConversation: (id) =>
        deleteRemoteRef.current({
          id,
          ...(projectAssignmentIdRef.current
            ? { projectAssignmentId: projectAssignmentIdRef.current }
            : {}),
        }),
      onError: (error) => setSyncError(getErrorMessage(error)),
      onSuccess: () => setSyncError(null),
      shouldRetry: (error) => {
        const code = getTrpcErrorCode(error);
        return ![
          "BAD_REQUEST",
          "CONFLICT",
          "FORBIDDEN",
          "NOT_FOUND",
          "PRECONDITION_FAILED",
          "UNAUTHORIZED",
        ].includes(code ?? "");
      },
      onPermanentError: (error, operation) => {
        if (
          getTrpcErrorCode(error) === "NOT_FOUND" &&
          operation.kind === "snapshot"
        ) {
          const nextState = conversationReducer(stateRef.current, {
            type: "DELETE_CONVERSATION",
            payload: operation.conversation.id,
          });
          stateRef.current = nextState;
          dispatch({ type: "LOAD_STATE", payload: nextState });
          setSyncError(null);
        }
      },
      debounceMs: 50,
    });
  }

  const replaceState = useCallback((nextState: ConversationState) => {
    const previousState = stateRef.current;
    const retainedState = expireConversationAttachmentPayloads(nextState);
    stateRef.current = retainedState;
    dispatch({ type: "LOAD_STATE", payload: retainedState });
    revokeReleasedAttachmentBlobUrls(previousState, nextState, retainedState);
  }, []);

  const commit = useCallback(
    (action: Action, conversationIdsToSync: string[] = []) => {
      const nextState = conversationReducer(stateRef.current, action);
      replaceState(nextState);

      if (!canSyncRef.current) return;
      for (const conversationId of conversationIdsToSync) {
        const conversation = nextState.conversations.find(
          (candidate) => candidate.id === conversationId,
        );
        if (conversation) {
          syncQueueRef.current!.enqueueSnapshot(
            prepareConversationForCloud(conversation),
          );
        }
      }
    },
    [replaceState],
  );

  const commitKnowledgeBaseObservation = useCallback(
    (conversationId: string, observation: KnowledgeBaseObservationDto) => {
      const before = stateRef.current.conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      const nextState = conversationReducer(stateRef.current, {
        type: "COMMIT_KB_OBSERVATION",
        payload: { conversationId, observation },
      });
      const after = nextState.conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      if (!after || after === before) return;
      replaceState(nextState);
      if (canSyncRef.current) {
        syncQueueRef.current!.enqueueSnapshot(
          prepareConversationForCloud(after),
        );
      }
      const progress = observation.progress ?? observation.interaction.progress;
      if (progress) {
        window.dispatchEvent(
          new CustomEvent("frontmind:knowledge-progress-updated", {
            detail: progress,
          }),
        );
      }
    },
    [replaceState],
  );
  applyKnowledgeBaseObservationRef.current = commitKnowledgeBaseObservation;

  const registerKnowledgeBaseConversation = useCallback(
    (conversationId: string) => {
      if (!conversationId) return;
      knowledgeBaseConversationIdsRef.current.add(conversationId);
      const conversation = stateRef.current.conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      if (conversation && !conversation.knowledgeBase) {
        const nextState = conversationReducer(stateRef.current, {
          type: "MARK_KNOWLEDGE_BASE",
          payload: { conversationId },
        });
        replaceState(nextState);
      }
      knowledgeBaseCoordinatorRef.current?.register(conversationId);
    },
    [replaceState],
  );

  const wakeKnowledgeBaseConversation = useCallback(
    (conversationId: string) => {
      registerKnowledgeBaseConversation(conversationId);
      const conversation = stateRef.current.conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      const pendingClientRequestId = [...(conversation?.messages ?? [])]
        .reverse()
        .find(
          (message) =>
            message.knowledgeBase?.kind === "pending_user" &&
            message.knowledgeBase.serverOwned !== true &&
            Boolean(message.knowledgeBase.clientRequestId),
        )?.knowledgeBase?.clientRequestId;
      knowledgeBaseCoordinatorRef.current?.wake(
        conversationId,
        pendingClientRequestId ?? null,
      );
    },
    [registerKnowledgeBaseConversation],
  );

  const isKnowledgeBaseConversation = useCallback(
    (conversationId: string) =>
      knowledgeBaseConversationIdsRef.current.has(conversationId) ||
      Boolean(
        stateRef.current.conversations.find(
          (conversation) => conversation.id === conversationId,
        )?.knowledgeBase,
      ),
    [],
  );

  const rollbackPendingKnowledgeBaseTurn = useCallback(
    (conversationId: string, clientRequestId: string) => {
      knowledgeBaseCoordinatorRef.current?.clearPendingRequest(
        conversationId,
        clientRequestId,
      );
      commit(
        {
          type: "ROLLBACK_KB_PENDING_TURN",
          payload: { conversationId, clientRequestId },
        },
        [conversationId],
      );
    },
    [commit],
  );

  const settleKnowledgeBaseStartFailure = useCallback(
    (conversationId: string, clientRequestId: string) => {
      const conversation = stateRef.current.conversations.find(
        (candidate) => candidate.id === conversationId,
      );
      const requestWasAccepted = conversation?.messages.some(
        (message) =>
          isServerOwnedKnowledgeBaseMessage(message) &&
          message.knowledgeBase?.kind === "pending_user" &&
          message.knowledgeBase.clientRequestId === clientRequestId,
      );
      const hasOptimisticRequest = conversation?.messages.some(
        (message) =>
          message.knowledgeBase?.kind === "pending_user" &&
          message.knowledgeBase.serverOwned !== true &&
          message.knowledgeBase.clientRequestId === clientRequestId,
      );
      if (requestWasAccepted || !hasOptimisticRequest) return;
      knowledgeBaseCoordinatorRef.current?.unregister(conversationId);
      commit(
        {
          type: "SETTLE_KB_START_FAILURE",
          payload: { conversationId, clientRequestId },
        },
        [conversationId],
      );
    },
    [commit],
  );

  useEffect(() => {
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe: (conversationId, signal) =>
        reconcileKnowledgeBaseObservation({ conversationId }, signal),
      apply: (conversationId, observation) =>
        applyKnowledgeBaseObservationRef.current(conversationId, observation),
      onTransientError: (conversationId, error) => {
        console.warn("[KnowledgeBaseCoordinator] reconcile deferred", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onPermanentError: (conversationId, error) => {
        console.warn("[KnowledgeBaseCoordinator] reconcile stopped", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        const status = Number((error as { status?: unknown })?.status || 0);
        if (status !== 404) return;
        const conversation = stateRef.current.conversations.find(
          (candidate) => candidate.id === conversationId,
        );
        const pendingStart = [...(conversation?.messages || [])]
          .reverse()
          .find(
            (message) =>
              message.role === "user" &&
              message.content === "开始构建企业知识库" &&
              message.knowledgeBase?.kind === "pending_user" &&
              message.knowledgeBase.serverOwned !== true &&
              Boolean(message.knowledgeBase.clientRequestId),
          );
        if (pendingStart?.knowledgeBase?.clientRequestId) {
          settleKnowledgeBaseStartFailure(
            conversationId,
            pendingStart.knowledgeBase.clientRequestId,
          );
        }
      },
    });
    knowledgeBaseCoordinatorRef.current = coordinator;
    for (const conversationId of knowledgeBaseConversationIdsRef.current) {
      coordinator.register(conversationId);
      coordinator.wake(conversationId);
    }

    const wakeAll = () => coordinator.wakeAll();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") wakeAll();
    };
    window.addEventListener("focus", wakeAll);
    window.addEventListener("online", wakeAll);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", wakeAll);
      window.removeEventListener("online", wakeAll);
      document.removeEventListener("visibilitychange", handleVisibility);
      coordinator.dispose();
      if (knowledgeBaseCoordinatorRef.current === coordinator) {
        knowledgeBaseCoordinatorRef.current = null;
      }
    };
  }, [projectAssignmentId, settleKnowledgeBaseStartFailure, userId]);

  const hydrateForUser = useCallback(
    async (expectedUserId: number, initial: boolean) => {
      const generation = ++hydrationGenerationRef.current;
      if (initial) {
        setHydrated(false);
        setHydrationLoading(true);
      }

      try {
        const result = await listRefetchRef.current();
        if (result.error) throw result.error;
        if (
          accountIdRef.current !== expectedUserId ||
          hydrationGenerationRef.current !== generation
        ) {
          return;
        }

        const remoteConversations = (result.data ?? [])
          .map(normalizeConversation)
          .map((remote) =>
            mergeKnowledgeBaseHydration(
              stateRef.current.conversations.find(
                (local) => local.id === remote.id,
              ),
              remote,
            ),
          );
        // The workspace is already visible while its first conversation query
        // is in flight. Preserve brand-new local conversations created during
        // that short window, then persist them once hydration succeeds.
        const remoteIds = new Set(
          remoteConversations.map((conversation) => conversation.id),
        );
        const optimisticConversations = initial
          ? stateRef.current.conversations.filter(
              (conversation) => !remoteIds.has(conversation.id),
            )
          : [];
        const conversations = [
          ...optimisticConversations,
          ...remoteConversations,
        ];
        const previousActiveId = stateRef.current.activeConversationId;
        const activeConversationId = conversations.some(
          (conversation) => conversation.id === previousActiveId,
        )
          ? previousActiveId
          : (conversations[0]?.id ?? null);
        replaceState({ conversations, activeConversationId });
        setSyncError(null);
        setHydrated(true);
        canSyncRef.current = true;
        for (const conversation of optimisticConversations) {
          syncQueueRef.current!.enqueueSnapshot(
            prepareConversationForCloud(conversation),
            true,
          );
        }
      } catch (error: unknown) {
        if (
          accountIdRef.current === expectedUserId &&
          hydrationGenerationRef.current === generation
        ) {
          setSyncError(getErrorMessage(error));
          if (initial) setHydrated(false);
        }
      } finally {
        if (
          accountIdRef.current === expectedUserId &&
          hydrationGenerationRef.current === generation
        ) {
          setHydrationLoading(false);
        }
      }
    },
    [replaceState],
  );

  useEffect(() => {
    if (auth.loading) return;

    hydrationGenerationRef.current += 1;
    syncQueueRef.current!.reset();
    canSyncRef.current = false;
    accountIdRef.current = userId;
    knowledgeBaseCoordinatorRef.current?.reset();
    knowledgeBaseConversationIdsRef.current.clear();
    replaceState(EMPTY_STATE);
    setSyncError(null);

    if (userId === null) {
      setHydrated(false);
      setHydrationLoading(false);
      return;
    }

    setHydrationLoading(true);
    void hydrateForUser(userId, true);
  }, [auth.loading, hydrateForUser, projectAssignmentId, replaceState, userId]);

  useEffect(() => {
    canSyncRef.current = hydrated && userId !== null;
  }, [hydrated, userId]);

  useEffect(() => {
    let timer: number | undefined;
    let disposed = false;

    const expireAndReschedule = () => {
      if (disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);

      const now = Date.now();
      const previousState = stateRef.current;
      const expiredState = expireConversationAttachmentPayloads(
        previousState,
        now,
      );
      if (expiredState !== previousState) {
        replaceState(expiredState);
      }

      const nextExpiry = nextAttachmentPayloadExpiry(stateRef.current, now);
      if (nextExpiry === undefined) {
        timer = undefined;
        return;
      }
      // A 30-day deadline is longer than the maximum reliable signed 32-bit
      // browser timer. Keep the same callback alive across intermediate wakes;
      // relying on a React render here would lose the final five-day segment
      // when no attachment has expired and the state reference is unchanged.
      const delay = Math.min(Math.max(0, nextExpiry - now), 2_147_000_000);
      timer = window.setTimeout(expireAndReschedule, delay);
    };

    const handleFocus = () => expireAndReschedule();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") expireAndReschedule();
    };

    expireAndReschedule();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [replaceState, state]);

  const createConversation = useCallback(
    (options?: { title?: string; reuseEmpty?: boolean }) => {
      const title = options?.title?.trim() || "新内容流程";
      if (options?.reuseEmpty) {
        const reusable = stateRef.current.conversations.find(
          (conversation) =>
            conversation.title === title &&
            conversation.status === "idle" &&
            conversation.messages.length === 0 &&
            !conversation.taskId &&
            !conversation.previousResponseId &&
            !conversation.knowledgeBase?.initialized,
        );
        if (reusable) return reusable.id;
      }

      const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const conversation: Conversation = {
        id,
        title,
        messages: [],
        status: "idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const nextState = conversationReducer(stateRef.current, {
        type: "NEW_CONVERSATION",
        payload: conversation,
      });
      replaceState(nextState);
      if (canSyncRef.current) {
        syncQueueRef.current!.enqueueSnapshot(
          prepareConversationForCloud(conversation),
          true,
        );
      }
      return id;
    },
    [replaceState],
  );

  const setActive = useCallback(
    (id: string) => {
      commit({ type: "SET_ACTIVE", payload: id });
    },
    [commit],
  );

  const addMessage = useCallback(
    (conversationId: string, message: LocalMessage) => {
      commit({ type: "ADD_MESSAGE", payload: { conversationId, message } }, [
        conversationId,
      ]);
    },
    [commit],
  );

  const updateStatus = useCallback(
    (
      conversationId: string,
      status: Conversation["status"],
      extra?: {
        taskId?: string;
        taskUrl?: string;
        previousResponseId?: string;
        startedAt?: number;
        completedAt?: number;
        lastKnownOutputLength?: number;
      },
    ) => {
      commit(
        {
          type: "UPDATE_STATUS",
          payload: { conversationId, status, ...extra },
        },
        [conversationId],
      );
    },
    [commit],
  );

  const updateAssistantMessages = useCallback(
    (conversationId: string, messages: LocalMessage[]) => {
      commit(
        {
          type: "UPDATE_ASSISTANT_MESSAGES",
          payload: { conversationId, messages },
        },
        [conversationId],
      );
    },
    [commit],
  );

  const updateTitle = useCallback(
    (conversationId: string, title: string) => {
      commit({ type: "UPDATE_TITLE", payload: { conversationId, title } }, [
        conversationId,
      ]);
    },
    [commit],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      const conversation = stateRef.current.conversations.find(
        (candidate) => candidate.id === id,
      );
      if (
        conversation &&
        (conversation.knowledgeBase?.initialized ||
          hasServerOwnedKnowledgeBaseMessages(conversation))
      ) {
        return;
      }
      knowledgeBaseConversationIdsRef.current.delete(id);
      knowledgeBaseCoordinatorRef.current?.unregister(id);
      commit({ type: "DELETE_CONVERSATION", payload: id });
      if (canSyncRef.current) syncQueueRef.current!.enqueueDelete(id);
    },
    [commit],
  );

  const discardConversationLocally = useCallback(
    (id: string) => {
      knowledgeBaseConversationIdsRef.current.delete(id);
      knowledgeBaseCoordinatorRef.current?.unregister(id);
      const nextState = conversationReducer(stateRef.current, {
        type: "DISCARD_CONVERSATION_LOCALLY",
        payload: id,
      });
      replaceState(nextState);
    },
    [replaceState],
  );

  const deleteMessage = useCallback(
    (conversationId: string, messageId: string) => {
      commit(
        { type: "DELETE_MESSAGE", payload: { conversationId, messageId } },
        [conversationId],
      );
    },
    [commit],
  );

  const refreshConversations = useCallback(async () => {
    const expectedUserId = accountIdRef.current;
    if (expectedUserId === null) return;
    if (!hydrated) {
      await hydrateForUser(expectedUserId, true);
      return;
    }
    if (!canSyncRef.current) return;
    const flushed = await syncQueueRef.current!.flushAll();
    if (!flushed) return;
    await hydrateForUser(expectedUserId, false);
  }, [hydrateForUser, hydrated]);

  const clearSyncError = useCallback(() => setSyncError(null), []);

  const activeConversation =
    state.conversations.find((c) => c.id === state.activeConversationId) ??
    null;

  useEffect(() => {
    const handleFocus = () => void refreshConversations();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshConversations();
      } else {
        void syncQueueRef.current!.flushAll();
      }
    };
    const handlePageHide = () => {
      void syncQueueRef.current!.flushAll();
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshConversations]);

  useEffect(
    () => () => {
      syncQueueRef.current?.reset();
      if (typeof URL.revokeObjectURL === "function") {
        for (const url of collectAttachmentBlobUrls(stateRef.current)) {
          URL.revokeObjectURL(url);
        }
      }
    },
    [],
  );

  return (
    <ConversationContext.Provider
      value={{
        state,
        activeConversation,
        loading: auth.loading || hydrationLoading,
        hydrated,
        syncError,
        createConversation,
        setActive,
        addMessage,
        updateStatus,
        updateAssistantMessages,
        registerKnowledgeBaseConversation,
        wakeKnowledgeBaseConversation,
        isKnowledgeBaseConversation,
        commitKnowledgeBaseObservation,
        rollbackPendingKnowledgeBaseTurn,
        settleKnowledgeBaseStartFailure,
        updateTitle,
        deleteConversation,
        discardConversationLocally,
        deleteMessage,
        refreshConversations,
        clearSyncError,
      }}
    >
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversation() {
  const ctx = useContext(ConversationContext);
  if (!ctx)
    throw new Error("useConversation must be used within ConversationProvider");
  return ctx;
}

/**
 * Get a human-readable label for an intermediate step type
 */
function getStepLabel(type: string, msg: OutputMessage): string {
  switch (type) {
    case "web_search_call": {
      // Try to extract the search query
      const query =
        msg.action?.query ||
        (msg as any).query ||
        (Array.isArray(msg.queries) && msg.queries[0]) ||
        "";
      return query ? `搜索 ${query}` : "网络搜索";
    }
    case "file_search_call":
      return "文件搜索";
    case "computer_call": {
      // Try to extract the URL or action
      const action = msg.action;
      if (action?.type === "navigate" || action?.type === "goto") {
        return `查看 ${action.url || "网页"}`;
      }
      if (action?.type === "click") return "点击操作";
      if (action?.type === "type" || action?.type === "input")
        return "输入操作";
      if (action?.type === "scroll") return "滚动页面";
      if (action?.type === "screenshot") return "截图";
      return "浏览器操作";
    }
    case "code_interpreter_call":
      return "执行代码";
    case "function_call": {
      const name = msg.name || "";
      if (name.includes("search")) return `搜索 ${name}`;
      if (name.includes("browse") || name.includes("navigate"))
        return `浏览 ${name}`;
      if (name.includes("write") || name.includes("create"))
        return `撰写 ${name}`;
      if (name.includes("read")) return `读取 ${name}`;
      return name ? `调用 ${name}` : "工具调用";
    }
    case "reasoning": {
      // Try to get summary text
      const summaryText = msg.summary?.[0]?.text || "";
      return summaryText ? summaryText.slice(0, 60) : "思考中...";
    }
    case "mcp_call": {
      const name = msg.name || "";
      return name ? `MCP 调用 ${name}` : "MCP 工具调用";
    }
    case "mcp_list_tools": {
      return "获取工具列表";
    }
    case "mcp_approval_request": {
      return "等待工具审批";
    }
    default: {
      // Try to extract a meaningful label from the type name
      const label = type.replace(/_/g, " ").replace(/call$/, "").trim();
      return label || type;
    }
  }
}

/**
 * Get description text for an intermediate step
 */
function getStepDescription(
  type: string,
  msg: OutputMessage,
): string | undefined {
  switch (type) {
    case "web_search_call": {
      const query =
        msg.action?.query ||
        (msg as any).query ||
        (Array.isArray(msg.queries) && msg.queries[0]) ||
        "";
      return query ? undefined : undefined;
    }
    case "reasoning": {
      const summaryText =
        msg.summary
          ?.map((s: any) => s.text)
          .filter(Boolean)
          .join("\n") || "";
      return summaryText || undefined;
    }
    case "computer_call": {
      const action = msg.action;
      if (action?.type === "navigate" || action?.type === "goto") {
        return action.url || undefined;
      }
      return undefined;
    }
    case "code_interpreter_call": {
      // Try to get the code
      const code = (msg as any).input || (msg as any).code || "";
      return code ? code.slice(0, 200) : undefined;
    }
    case "function_call": {
      // Try to show function arguments
      const args = msg.arguments;
      if (args) {
        try {
          const parsed = JSON.parse(args);
          // Show a brief summary of the arguments
          const keys = Object.keys(parsed);
          if (keys.length > 0) {
            return keys
              .map((k) => `${k}: ${String(parsed[k]).slice(0, 50)}`)
              .join(", ")
              .slice(0, 150);
          }
        } catch {
          return args.slice(0, 100);
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Determine the step icon type category
 */
export function getStepIconType(
  type: string,
): "search" | "browse" | "code" | "write" | "reasoning" | "tool" {
  switch (type) {
    case "web_search_call":
    case "file_search_call":
      return "search";
    case "computer_call":
      return "browse";
    case "code_interpreter_call":
      return "code";
    case "reasoning":
      return "reasoning";
    case "function_call":
    case "mcp_call":
    case "mcp_list_tools":
    case "mcp_approval_request":
      return "tool";
    default:
      // Try to infer from type name
      if (type.includes("search")) return "search";
      if (
        type.includes("browse") ||
        type.includes("computer") ||
        type.includes("navigate")
      )
        return "browse";
      if (type.includes("code") || type.includes("interpreter")) return "code";
      if (type.includes("reason") || type.includes("think")) return "reasoning";
      if (type.includes("write") || type.includes("create")) return "write";
      return "tool";
  }
}

/**
 * Try to infer a group title from a sequence of intermediate steps
 */
function inferGroupTitle(steps: IntermediateStep[]): string {
  if (steps.length === 0) return "处理中";

  const types = steps.map((s) => getStepIconType(s.type));
  const hasSearch = types.includes("search");
  const hasBrowse = types.includes("browse");
  const hasCode = types.includes("code");
  const hasWrite = types.includes("write");
  const hasReasoning = types.includes("reasoning");

  if (hasSearch && hasBrowse) return "搜集信息与数据";
  if (hasSearch) return "搜索相关信息";
  if (hasBrowse) return "浏览网页内容";
  if (hasCode) return "执行代码";
  if (hasWrite) return "整理分析并生成内容";
  if (hasReasoning) return "分析思考";
  return "处理任务";
}

/**
 * Build step groups from a flat list of intermediate steps.
 * Groups steps by their icon type category.
 */
function buildStepGroups(
  steps: IntermediateStep[],
  descriptions: string[],
): StepGroup[] {
  const stepGroups: StepGroup[] = [];
  if (steps.length === 0) return stepGroups;

  // Group steps by their icon type category
  let currentGroup: IntermediateStep[] = [];
  let lastCategory = "";

  for (const step of steps) {
    const category = getStepIconType(step.type);
    if (lastCategory && category !== lastCategory && currentGroup.length > 0) {
      // Start a new group
      stepGroups.push({
        id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: inferGroupTitle(currentGroup),
        steps: currentGroup,
        description:
          descriptions.length > 0 ? descriptions.join("\n") : undefined,
      });
      currentGroup = [];
      descriptions = [];
    }
    currentGroup.push(step);
    lastCategory = category;
  }

  // Push the last group
  if (currentGroup.length > 0) {
    stepGroups.push({
      id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: inferGroupTitle(currentGroup),
      steps: currentGroup,
      description:
        descriptions.length > 0 ? descriptions.join("\n") : undefined,
    });
  }

  return stepGroups;
}

/**
 * Check if an output item is an intermediate step (non-message type)
 */
function isIntermediateStepType(type: string): boolean {
  // FrontMind/OpenAI-compatible providers use several names for a typed
  // assistant message. Keep this list aligned with the server-side knowledge
  // protocol parser so a validated response cannot disappear in the browser.
  if (["message", "output_message", "output_text", "text"].includes(type)) {
    return false;
  }

  // Known intermediate step types
  const knownStepTypes = [
    "reasoning",
    "web_search_call",
    "file_search_call",
    "computer_call",
    "code_interpreter_call",
    "function_call",
    "function_call_output",
    "mcp_call",
    "mcp_list_tools",
    "mcp_approval_request",
  ];

  if (knownStepTypes.includes(type)) return true;

  // Heuristic: if the type contains "call", "search", "reason", "tool", it's likely a step
  if (
    type.includes("call") ||
    type.includes("search") ||
    type.includes("reason") ||
    type.includes("tool")
  ) {
    return true;
  }

  // Default: treat unknown non-message types as intermediate steps
  return true;
}

/**
 * Normalize file URLs from the API to route through our proxy.
 * The API may return:
 * - Absolute API URLs that point to /v1/files/xxx
 * - Relative paths like /v1/files/xxx
 * - Direct S3 URLs like https://vida-private.s3.us-east-1.amazonaws.com/...
 * - Other external URLs
 *
 * For API file URLs: route through /api/frontmind/v1/files/xxx for auth + S3 resolution.
 * For S3/external URLs: route through /api/frontmind/proxy-download?url=... to avoid CORS.
 * For data/blob URLs: pass through directly.
 */
function normalizeFileUrl(url: string): string {
  if (!url) return url;

  // Already a proxy URL
  if (url.startsWith("/api/frontmind/")) return url;

  // Data URLs and blob URLs - pass through directly
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  // Absolute API URL with /v1/files/xxx -> /api/frontmind/v1/files/xxx
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/v1/files/")) {
      return `/api/frontmind${parsed.pathname}`;
    }
    // External URL (S3, CDN, etc.) - proxy through our server to avoid CORS
    return `/api/frontmind/proxy-download?url=${encodeURIComponent(url)}`;
  } catch {
    // Not a valid absolute URL, try relative path matching
  }

  // Relative API path: /v1/files/xxx -> /api/frontmind/v1/files/xxx
  if (url.startsWith("/v1/files/")) {
    return `/api/frontmind${url}`;
  }

  // Unknown format - pass through
  return url;
}

function outputResourceDescriptor(value: Record<string, unknown>) {
  const fileId = String(value.fileId || value.file_id || "").trim();
  const rawUrl = String(
    value.fileUrl ||
      value.file_url ||
      value.imageUrl ||
      value.image_url ||
      value.url ||
      "",
  ).trim();
  const fileUrl =
    rawUrl ||
    (fileId ? `/api/frontmind/v1/files/${encodeURIComponent(fileId)}` : "");
  const fileName = String(
    value.fileName || value.file_name || value.filename || value.name || "file",
  );
  const mimeType = String(
    value.mimeType || value.mime_type || value.content_type || "",
  );
  return {
    fileUrl: fileUrl ? normalizeFileUrl(fileUrl) : "",
    fileName,
    mimeType,
  };
}

function isImageOutputResource(input: {
  type: string;
  fileName: string;
  mimeType: string;
}) {
  return (
    input.type === "output_image" ||
    input.type === "image" ||
    input.mimeType.toLowerCase().startsWith("image/") ||
    /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(input.fileName)
  );
}

/**
 * Parse FrontMind API output messages into local messages
 * Handles both OpenAI Responses API format and native FrontMind API format.
 * Now also extracts intermediate steps from non-message output items.
 *
 * INTERMEDIATE STEPS FIX: Enhanced to properly handle:
 * 1. Non-message output types (reasoning, web_search_call, computer_call, etc.)
 * 2. Steps-only polls (when no assistant message has arrived yet)
 * 3. Proper grouping and display of step sequences
 */
export function parseOutputMessages(
  output: OutputMessage[],
  responseStartedAt?: number,
  modelName?: string,
): LocalMessage[] {
  try {
    return _parseOutputMessagesInner(output, responseStartedAt, modelName);
  } catch (e) {
    console.error("[parseOutputMessages] Unexpected error:", e);
    // Return a safe fallback message so the UI doesn't crash
    return [
      {
        id: `msg-err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        responseStartedAt,
        modelName,
      },
    ];
  }
}

export function sanitizeKnowledgeBaseOutputMessages(
  messages: LocalMessage[],
): LocalMessage[] {
  return messages
    .map(
      ({
        intermediateSteps: _intermediateSteps,
        stepGroups: _stepGroups,
        isStepsPlaceholder: _isStepsPlaceholder,
        ...message
      }) => ({
        ...message,
        content: sanitizeKnowledgeBaseCustomerMarkdown(message.content),
        inlineImages: message.inlineImages?.filter((image) =>
          isManagedKnowledgeBaseImageSource(image.src),
        ),
      }),
    )
    .filter(
      (message) =>
        Boolean(message.content.trim()) ||
        Boolean(message.outputFiles?.length) ||
        Boolean(message.inlineImages?.length),
    );
}

const EXTERNAL_IMAGE_ASSET_URL =
  /https?:\/\/[^\s<>"')\]]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^\s<>"')\]]*)?/gi;

function isManagedKnowledgeBaseImageSource(src: string): boolean {
  const normalized = String(src || "").trim();
  return (
    /^data:image\/[a-z0-9.+-]+;base64,/i.test(normalized) ||
    normalized.startsWith("/api/frontmind/") ||
    normalized.startsWith("/api/dashboard/knowledge/assets/") ||
    normalized.startsWith("/api/knowledge-base/")
  );
}

/**
 * Knowledge-base drafts must not hotlink origin/CDN images. Such URLs can be
 * protected by Referer rules, expire, or be revoked after the crawl. The
 * customer-facing archive only renders validated bytes stored in the ZIP and
 * served by our authenticated asset route.
 */
export function sanitizeKnowledgeBaseCustomerMarkdown(text: string): string {
  if (!text) return "";

  return normalizeKnowledgeCollectionCopy(
    stripKnowledgeBaseReferenceAppendix(
      stripKnowledgeBaseProtocolPayloads(text),
    ),
  )
    .replace(
      /!\[([^\]\n]*)]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/gi,
      (_match, alt: string) => (alt.trim() ? `配图：${alt.trim()}` : ""),
    )
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi, "")
    .replace(
      /\[([^\]\n]+)]\(\s*<?(https?:\/\/[^)\s>]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^)\s>]*)?)>?(?:\s+["'][^"']*["'])?\s*\)/gi,
      "$1",
    )
    .replace(EXTERNAL_IMAGE_ASSET_URL, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function _parseOutputMessagesInner(
  output: OutputMessage[],
  responseStartedAt?: number,
  modelName?: string,
): LocalMessage[] {
  if (!output || !Array.isArray(output)) return [];

  const messages: LocalMessage[] = [];

  // Collect intermediate steps that appear before each assistant message
  let pendingSteps: IntermediateStep[] = [];
  // Also collect reasoning/description text between steps
  let pendingDescriptions: string[] = [];

  for (const msg of output) {
    const msgType = msg.type || "message";

    if (
      msgType === "output_image" ||
      msgType === "image" ||
      msgType === "output_file" ||
      msgType === "file"
    ) {
      const descriptor = outputResourceDescriptor(
        msg as Record<string, unknown>,
      );
      if (descriptor.fileUrl) {
        const image = isImageOutputResource({
          type: msgType,
          fileName: descriptor.fileName,
          mimeType: descriptor.mimeType,
        });
        messages.push({
          id:
            msg.id ||
            `msg-file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ...(msg.id ? { upstreamOutputId: msg.id } : {}),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          ...(image
            ? {
                inlineImages: [
                  {
                    src: descriptor.fileUrl,
                    alt: descriptor.fileName || "Generated image",
                  },
                ],
              }
            : {
                outputFiles: [
                  {
                    fileUrl: descriptor.fileUrl,
                    fileName: descriptor.fileName,
                    mimeType: descriptor.mimeType || "application/octet-stream",
                  },
                ],
              }),
          responseStartedAt,
          modelName,
        });
      }
      continue;
    }

    // Check if this is an intermediate step (non-message type)
    if (isIntermediateStepType(msgType)) {
      const step: IntermediateStep = {
        id:
          msg.id ||
          `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: msgType,
        label: getStepLabel(msgType, msg),
        description: getStepDescription(msgType, msg),
      };

      // For reasoning type, also extract the text as description
      if (msgType === "reasoning" && msg.summary) {
        const summaryTexts = msg.summary.map((s) => s.text).filter(Boolean);
        if (summaryTexts.length > 0) {
          pendingDescriptions.push(summaryTexts.join(" "));
        }
      }

      pendingSteps.push(step);
      continue;
    }

    // This is a regular message
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const files: { fileUrl: string; fileName: string; mimeType: string }[] =
        [];
      const inlineImages: { src: string; alt?: string }[] = [];
      const contentSteps: IntermediateStep[] = [];

      // Handle case where content is a plain string (some API versions)
      const rawContent = msg.content as unknown;
      if (typeof rawContent === "string") {
        if ((rawContent as string).trim()) {
          textParts.push(rawContent as string);
        }
      } else if (!rawContent || !Array.isArray(rawContent)) {
        // Try to extract text from the message object itself (fallback)
        const fallbackValue =
          (msg as any).output_text ||
          (msg as any).text ||
          (msg as any).message ||
          (msg as any).output;
        const fallbackText =
          typeof fallbackValue === "string"
            ? fallbackValue
            : fallbackValue && typeof fallbackValue.value === "string"
              ? fallbackValue.value
              : undefined;
        if (typeof fallbackText === "string" && fallbackText.trim()) {
          textParts.push(fallbackText);
        }
        // NOTE: Do NOT `continue` here. Even if there's no text content,
        // there may be pending intermediate steps that should be attached
        // to this message. The message will still be created below if
        // there are steps, files, or images.
      } else {
        // msg.content is an array
        for (const content of rawContent as any[]) {
          if (!content) continue;

          // Handle plain string content items
          if (typeof content === "string") {
            textParts.push(content);
            continue;
          }

          // Normalize field names: API may return snake_case or camelCase
          const c: any = content;
          const contentType = c.type || "";
          const { fileUrl, fileName, mimeType } = outputResourceDescriptor(c);
          const rawTextValue = c.text ?? c.output_text ?? c.value ?? null;
          const textValue =
            typeof rawTextValue === "string"
              ? rawTextValue
              : rawTextValue && typeof rawTextValue.value === "string"
                ? rawTextValue.value
                : null;

          if (
            (contentType === "output_file" || contentType === "file") &&
            fileUrl
          ) {
            if (
              isImageOutputResource({
                type: contentType,
                fileName,
                mimeType,
              })
            ) {
              inlineImages.push({
                src: fileUrl,
                alt: fileName || "Generated image",
              });
            } else {
              files.push({
                fileUrl,
                fileName,
                mimeType: mimeType || "application/octet-stream",
              });
            }
          } else if (
            (contentType === "output_image" || contentType === "image") &&
            fileUrl
          ) {
            inlineImages.push({
              src: fileUrl,
              alt: fileName || "Generated image",
            });
          } else if (
            contentType === "output_text" ||
            contentType === "text" ||
            contentType === "" ||
            contentType === "refusal"
          ) {
            if (textValue != null && String(textValue).trim()) {
              const textContent = String(textValue);
              const extractedImages = extractInlineImages(textContent);
              if (extractedImages.length > 0) {
                inlineImages.push(...extractedImages);
              }
              textParts.push(textContent);
            }
          } else {
            // Non-standard content type within a message - treat as intermediate step
            // But first check if it has text we should capture
            if (textValue != null && String(textValue).trim()) {
              textParts.push(String(textValue));
            } else {
              contentSteps.push({
                id: `cstep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: contentType,
                label: contentType.replace(/_/g, " "),
                description: textValue ? String(textValue) : undefined,
              });
            }
          }
        }
      }

      // Merge content-level steps with pending output-level steps
      const allSteps = [...pendingSteps, ...contentSteps];

      // Build step groups from the collected steps
      const stepGroups = buildStepGroups(allSteps, [...pendingDescriptions]);

      if (
        textParts.length > 0 ||
        files.length > 0 ||
        inlineImages.length > 0 ||
        allSteps.length > 0
      ) {
        messages.push({
          id:
            msg.id ||
            `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ...(msg.id ? { upstreamOutputId: msg.id } : {}),
          role: "assistant",
          content:
            textParts.length > 0
              ? sanitizeBrandText(textParts.join("\n\n"))
              : "",
          timestamp: Date.now(),
          outputFiles:
            files.length > 0
              ? files.map((f) => ({
                  ...f,
                  fileName: sanitizeBrandText(f.fileName),
                }))
              : undefined,
          inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
          responseStartedAt,
          intermediateSteps:
            allSteps.length > 0
              ? allSteps.map((s) => ({
                  ...s,
                  label: sanitizeBrandText(s.label),
                  description: s.description
                    ? sanitizeBrandText(s.description)
                    : undefined,
                }))
              : undefined,
          stepGroups:
            stepGroups.length > 0
              ? stepGroups.map((g) => ({
                  ...g,
                  title: sanitizeBrandText(g.title),
                  description: g.description
                    ? sanitizeBrandText(g.description)
                    : undefined,
                  steps: g.steps.map((s) => ({
                    ...s,
                    label: sanitizeBrandText(s.label),
                    description: s.description
                      ? sanitizeBrandText(s.description)
                      : undefined,
                  })),
                }))
              : undefined,
          modelName,
        });
      }

      // Reset pending steps after attaching to a message
      pendingSteps = [];
      pendingDescriptions = [];
    }
  }

  // If there are remaining pending steps with no following message,
  // create a placeholder message to display them.
  // This is critical for showing intermediate steps DURING task execution
  // before the final assistant message arrives.
  if (pendingSteps.length > 0) {
    const stepGroups = buildStepGroups(pendingSteps, [...pendingDescriptions]);

    messages.push({
      id: `msg-steps-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      responseStartedAt,
      intermediateSteps: pendingSteps.map((s) => ({
        ...s,
        label: sanitizeBrandText(s.label),
        description: s.description
          ? sanitizeBrandText(s.description)
          : undefined,
      })),
      stepGroups: stepGroups.map((g) => ({
        ...g,
        title: sanitizeBrandText(g.title),
        description: g.description
          ? sanitizeBrandText(g.description)
          : undefined,
        steps: g.steps.map((s) => ({
          ...s,
          label: sanitizeBrandText(s.label),
          description: s.description
            ? sanitizeBrandText(s.description)
            : undefined,
        })),
      })),
      isStepsPlaceholder: true,
      modelName,
    });
  }

  return messages;
}

/**
 * Extract inline base64 images from markdown text content.
 * FrontMind API sometimes returns images as base64 embedded in text.
 */
function extractInlineImages(text: string): { src: string; alt?: string }[] {
  if (!text || typeof text !== "string") return [];

  const images: { src: string; alt?: string }[] = [];

  try {
    // Skip extraction for very large strings (>500KB) to avoid regex performance issues
    if (text.length > 500_000) {
      console.warn(
        "[extractInlineImages] Skipping extraction for very large text:",
        text.length,
      );
      return images;
    }

    // Match markdown image syntax: ![alt](data:image/...;base64,...)
    const imageRegex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[^)]+)\)/g;
    let match;
    while ((match = imageRegex.exec(text)) !== null) {
      images.push({ src: match[2], alt: match[1] || "Image" });
    }

    // Also match raw data URIs that might be image URLs in output
    // (some API versions return them differently)
    const dataUriRegex = /(data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,})/g;
    while ((match = dataUriRegex.exec(text)) !== null) {
      // Avoid duplicates from the first regex
      if (!images.some((img) => img.src === match![1])) {
        images.push({ src: match[1], alt: "Image" });
      }
    }
  } catch (e) {
    console.error("[extractInlineImages] Error:", e);
  }

  return images;
}
