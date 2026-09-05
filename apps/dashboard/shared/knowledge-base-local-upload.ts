export const KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS = {
  conversationId: "X-FrontMind-KB-Conversation-Id",
  turnId: "X-FrontMind-KB-Turn-Id",
  clientRequestId: "X-FrontMind-KB-Client-Request-Id",
  itemId: "X-FrontMind-KB-Item-Id",
  expectedResetRevision: "X-FrontMind-KB-Reset-Revision",
  contentSha256: "X-FrontMind-Content-SHA256",
  ordinal: "X-FrontMind-KB-Ordinal",
  attempt: "X-FrontMind-Upload-Attempt",
} as const;

export type KnowledgeBaseLocalUploadCoordinate = {
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  itemId: string;
  expectedResetRevision: number;
  /** Legacy browser digest. New uploads rely on Dashboard's streamed digest. */
  contentSha256?: string;
  ordinal: number;
};

/**
 * These headers are private operation coordinates, not file capabilities.
 * The authenticated server still derives ownership and storage identities.
 */
export function knowledgeBaseLocalUploadHeaders(
  coordinate: KnowledgeBaseLocalUploadCoordinate,
  attempt: number,
): Record<string, string> {
  return {
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.conversationId]:
      coordinate.conversationId,
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.turnId]: coordinate.turnId,
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.clientRequestId]:
      coordinate.clientRequestId,
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.itemId]: coordinate.itemId,
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.expectedResetRevision]: String(
      coordinate.expectedResetRevision,
    ),
    ...(coordinate.contentSha256
      ? {
          [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.contentSha256]:
            coordinate.contentSha256,
        }
      : {}),
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.ordinal]: String(coordinate.ordinal),
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.attempt]: String(attempt),
  };
}
