import type {
  KnowledgeBaseObservationDto as SharedKnowledgeBaseObservationDto,
  KnowledgeBaseInteractionDto,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";

export type KnowledgeBaseObservationDto = SharedKnowledgeBaseObservationDto & {
  /** Transitional compatibility for endpoints that still return progress beside observation. */
  progress?: KnowledgeBaseProgressDto | null;
};

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();
    return (
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `请求失败 (${response.status})`
    );
  } catch {
    return `请求失败 (${response.status})`;
  }
}

export async function fetchKnowledgeBaseProgress(
  conversationId: string,
): Promise<KnowledgeBaseProgressDto | null> {
  if (!conversationId) return null;
  const response = await fetch(
    `/api/knowledge-base/progress/${encodeURIComponent(conversationId)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = await response.json();
  return (payload?.progress as KnowledgeBaseProgressDto | null) ?? null;
}

export async function fetchKnowledgeBaseInteraction(
  conversationId: string,
): Promise<KnowledgeBaseInteractionDto | null> {
  if (!conversationId) return null;
  const response = await fetch(
    `/api/knowledge-base/progress/${encodeURIComponent(conversationId)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = await response.json();
  return (payload?.interaction as KnowledgeBaseInteractionDto | null) ?? null;
}

export async function reconcileKnowledgeBaseProgress(input: {
  conversationId: string;
  taskId?: string;
}): Promise<KnowledgeBaseInteractionDto> {
  const observation = await reconcileKnowledgeBaseObservation(input);
  return observation.interaction;
}

function normalizeObservation(payload: any): KnowledgeBaseObservationDto {
  const source = payload?.observation ?? payload ?? {};
  const interaction = (source.interaction ?? payload?.interaction) as
    | KnowledgeBaseInteractionDto
    | undefined;
  if (!interaction) {
    throw new Error("知识库状态接口未返回 interaction");
  }
  const progress =
    (source.progress as KnowledgeBaseProgressDto | null | undefined) ??
    (payload?.progress as KnowledgeBaseProgressDto | null | undefined) ??
    interaction.progress ??
    null;
  const authoritativeTaskId = Object.prototype.hasOwnProperty.call(
    source,
    "authoritativeTaskId",
  )
    ? (source.authoritativeTaskId ?? null)
    : (source.taskId ?? payload?.task?.id ?? null);
  return {
    stateEpoch: Number(source.stateEpoch ?? 0),
    generation: Number(source.generation ?? 0),
    authoritativeTaskId,
    activeTurn: source.activeTurn ?? null,
    interaction: { ...interaction, progress },
    approvedPresentation: source.approvedPresentation ?? null,
    package: source.package ?? null,
    notice: source.notice ?? null,
    conversationVersion: source.conversationVersion ?? null,
    progress,
  };
}

export function knowledgeBaseObservationFromPayload(
  payload: unknown,
): KnowledgeBaseObservationDto {
  return normalizeObservation(payload);
}

export async function reconcileKnowledgeBaseObservation(
  input: { conversationId: string },
  signal?: AbortSignal,
): Promise<KnowledgeBaseObservationDto> {
  const response = await fetch("/api/knowledge-base/progress/reconcile", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: input.conversationId }),
    signal,
  });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    if (response.status === 422) {
      const projectionResponse = await fetch(
        `/api/knowledge-base/progress/${encodeURIComponent(input.conversationId)}`,
        { credentials: "include", signal },
      );
      if (projectionResponse.ok) {
        const projection = normalizeObservation(
          await projectionResponse.json(),
        );
        if (projection.interaction.interactionState === "failed") {
          return projection;
        }
      }
    }
    const error = new Error(message) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  return normalizeObservation(payload);
}

export async function retryKnowledgeBaseTurn(input: {
  conversationId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
}): Promise<KnowledgeBaseObservationDto> {
  const response = await fetch("/api/knowledge-base/retry", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const error = new Error(await readErrorMessage(response)) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return normalizeObservation(await response.json());
}

/**
 * The user-facing message remains untouched. This reminder is appended only to
 * the upstream task prompt so the model receives the authoritative revision
 * and current leaf on every turn.
 */
export async function getKnowledgeBaseTurnProtocolReminder(
  conversationId: string,
) {
  try {
    const progress = await fetchKnowledgeBaseProgress(conversationId);
    if (!progress || progress.summary.total === 0) {
      return [
        "[知识库状态协议]",
        "知识树尚未通过服务端校验。不得假设进度或提前生成 ZIP；请重新输出完整 FRONTMIND_KB_MANIFEST 信封。",
      ].join("\n");
    }
    const current = progress.branches
      .flatMap((branch) => branch.leaves)
      .find((leaf) => leaf.id === progress.build.currentLeafId);
    if (!current) {
      return [
        "[知识库状态协议]",
        `当前知识库已完成，服务端 revision=${progress.build.revision}。不得重开节点、复用旧 ZIP 或重建知识树。`,
        "发布后的修改统一进入维护工单，本对话不再生成状态协议信封。",
      ].join("\n");
    }
    return [
      "[知识库状态协议]",
      `服务端权威状态：revision=${progress.build.revision}；currentLeafId=${current.id}；from=${current.status}。`,
      "本轮只能处理这个叶子。只有用户明确确认才输出 to=confirmed；明确跳过/直接预填才输出 to=direct_prefilled；任何补充、修订、提问或上传都必须输出 to=needs_verification 并停留在当前叶子。",
      "回复末尾只能附一个 FRONTMIND_KB_PROGRESS 信封；不得批量推进或提前生成 ZIP。",
    ].join("\n");
  } catch {
    return [
      "[知识库状态协议]",
      "无法读取服务端权威 revision。本轮不得推进节点或生成 ZIP；请继续呈现当前节点，并说明等待状态同步。",
    ].join("\n");
  }
}
