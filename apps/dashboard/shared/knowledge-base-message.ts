const KNOWLEDGE_BASE_TURN_ID = /^[A-Za-z0-9._:-]{1,96}$/u;
const KNOWLEDGE_BASE_PRESENTATION_KEY = /^[a-f0-9]{64}$/u;

/**
 * Public message IDs are derived from identities allocated by the server. The
 * client rewrites its optimistic bubble to this ID once the reservation is
 * observed, so a later cloud snapshot cannot render a duplicate copy.
 */
export function knowledgeBaseUserMessagePublicId(turnId: string) {
  const normalized = String(turnId || "").trim();
  if (!KNOWLEDGE_BASE_TURN_ID.test(normalized)) {
    throw new TypeError("Invalid knowledge-base turn id");
  }
  return `msg-kb-user-${normalized}`;
}

/** The presentation key is already a SHA-256 digest, so the ID is collision-free. */
export function knowledgeBasePresentationMessagePublicId(
  presentationKey: string,
) {
  const normalized = String(presentationKey || "").trim().toLowerCase();
  if (!KNOWLEDGE_BASE_PRESENTATION_KEY.test(normalized)) {
    throw new TypeError("Invalid knowledge-base presentation key");
  }
  return `msg-kb-presentation-${normalized}`;
}

/**
 * Final content completion is an immutable server receipt just like an
 * accepted presentation.  Keep the public identity deterministic so browser
 * snapshots can only echo (never mint or replace) the persisted row.
 */
export function knowledgeBaseCompletionMessagePublicId(input: {
  buildId: string;
  generation: number;
  revision: number;
}) {
  const buildId = String(input.buildId || "").trim();
  if (!KNOWLEDGE_BASE_TURN_ID.test(buildId)) {
    throw new TypeError("Invalid knowledge-base build id");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new TypeError("Invalid knowledge-base generation");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new TypeError("Invalid knowledge-base revision");
  }
  return `msg-kb-completion-${buildId}-${input.generation}-${input.revision}`;
}

export const KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT =
  "知识库内容已完成。下载包正在准备中。";
