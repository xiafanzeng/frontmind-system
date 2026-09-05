import type {
  KnowledgeBaseObservationDto as SharedKnowledgeBaseObservationDto,
  KnowledgeBaseInteractionDto,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";
import { deliveryProjectHeaders } from "@/lib/delivery-project";

export type KnowledgeBaseObservationDto = SharedKnowledgeBaseObservationDto & {
  /** Transitional compatibility for endpoints that still return progress beside observation. */
  progress?: KnowledgeBaseProgressDto | null;
  /** True only when a recovery endpoint durably accepted the same turn. */
  accepted?: boolean;
  /** True only when that endpoint resumed an existing reservation. */
  resumed?: boolean;
};

export interface KnowledgeBaseProgressEventDetail {
  progress: KnowledgeBaseProgressDto;
  generation: number;
  stateEpoch: number;
}

export type KnowledgeBaseProgressCoordinate = Pick<
  KnowledgeBaseProgressEventDetail,
  "generation" | "stateEpoch"
>;

export function isKnowledgeBaseProgressCoordinateOlder(
  candidate: KnowledgeBaseProgressCoordinate,
  current: KnowledgeBaseProgressCoordinate,
) {
  return (
    candidate.generation < current.generation ||
    (candidate.generation === current.generation &&
      candidate.stateEpoch < current.stateEpoch)
  );
}

/**
 * Progress events used to carry only the projection, so a delayed response
 * could overwrite a newer generation in the embedded panel. Keep accepting
 * that legacy shape while all current producers include monotonic coordinates.
 */
export function readKnowledgeBaseProgressEventDetail(
  value: unknown,
): KnowledgeBaseProgressEventDetail | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<KnowledgeBaseProgressEventDetail> &
    Partial<KnowledgeBaseProgressDto>;
  if (candidate.progress?.build) {
    const generation = Number(candidate.generation);
    const stateEpoch = Number(candidate.stateEpoch);
    return {
      progress: candidate.progress,
      generation: Number.isSafeInteger(generation) ? generation : -1,
      stateEpoch: Number.isSafeInteger(stateEpoch) ? stateEpoch : -1,
    };
  }
  if (candidate.build) {
    return {
      progress: candidate as KnowledgeBaseProgressDto,
      generation: -1,
      stateEpoch: -1,
    };
  }
  return null;
}

export function dispatchKnowledgeBaseProgressUpdated(
  observation: KnowledgeBaseObservationDto,
) {
  const progress = observation.progress ?? observation.interaction.progress;
  if (!progress) return;
  window.dispatchEvent(
    new CustomEvent<KnowledgeBaseProgressEventDetail>(
      "frontmind:knowledge-progress-updated",
      {
        detail: {
          progress,
          generation: observation.generation,
          stateEpoch: observation.stateEpoch,
        },
      },
    ),
  );
}

export const KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED_NOTICE_CODE =
  "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED";
export const KNOWLEDGE_BASE_RESET_REQUEST_EVENT =
  "frontmind:request-knowledge-reset";

export function requestKnowledgeBaseReset() {
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_BASE_RESET_REQUEST_EVENT));
}

export interface KnowledgeBaseLogoProvenanceRepairManifestItem {
  filename: string;
  sizeBytes: number;
  mimeType: string;
  lastModified: number;
  sha256: string;
}

export type KnowledgeBaseAttachmentRepairManifestItem =
  KnowledgeBaseLogoProvenanceRepairManifestItem;

export type KnowledgeBaseLogoProvenanceRepairError = Error & {
  status?: number;
  code?: string;
  knowledgeObservation?: KnowledgeBaseObservationDto;
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
    { credentials: "include", headers: deliveryProjectHeaders() },
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
    { credentials: "include", headers: deliveryProjectHeaders() },
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
  const hasDisplaySequence = Object.prototype.hasOwnProperty.call(
    source,
    "displaySequence",
  );
  const displaySequence = source.displaySequence;
  if (
    hasDisplaySequence &&
    (typeof displaySequence !== "number" ||
      !Number.isSafeInteger(displaySequence) ||
      displaySequence < 0)
  ) {
    throw new Error("知识库状态接口返回了无效的 displaySequence");
  }
  const syncState = ["synced", "repairing", "attention_required"].includes(
    source.syncState,
  )
    ? source.syncState
    : undefined;
  const processingPhase = [
    "uploading",
    "restoring_files",
    "migrating_task",
    "waiting_provider",
    "accepting",
    "package_preparing",
  ].includes(source.processingPhase)
    ? source.processingPhase
    : source.processingPhase === null
      ? null
      : undefined;
  const contentState = ["building", "completed"].includes(source.contentState)
    ? source.contentState
    : undefined;
  const packageState = [
    "not_started",
    "preparing",
    "retrying",
    "ready",
    "attention_required",
  ].includes(source.packageState)
    ? source.packageState
    : undefined;
  const publicationState = ["draft", "published"].includes(
    source.publicationState,
  )
    ? source.publicationState
    : undefined;
  const contentCompletedAt =
    source.contentCompletedAt === null ||
    (typeof source.contentCompletedAt === "number" &&
      Number.isSafeInteger(source.contentCompletedAt) &&
      source.contentCompletedAt >= 0)
      ? source.contentCompletedAt
      : undefined;
  const contentAvailabilityCandidate =
    source.contentAvailability ?? progress?.contentAvailability;
  const contentAvailability = ["none", "partial", "complete"].includes(
    contentAvailabilityCandidate,
  )
    ? contentAvailabilityCandidate
    : undefined;
  const operationStateCandidate =
    source.operationState ?? progress?.operationState;
  const operationState = [
    "creating",
    "waiting_output",
    "normalizing",
    "completed",
    "reset_required",
  ].includes(operationStateCandidate)
    ? operationStateCandidate
    : undefined;
  const warningCodesCandidate = source.warningCodes ?? progress?.warningCodes;
  const warningCodes = Array.isArray(warningCodesCandidate)
    ? Array.from(
        new Set(
          warningCodesCandidate.filter(
            (value: unknown): value is string =>
              typeof value === "string" &&
              value.length > 0 &&
              value.length <= 128,
          ),
        ),
      )
    : undefined;
  const resetAllowedCandidate = source.resetAllowed ?? progress?.resetAllowed;
  const taskCreationStateCandidate =
    source.taskCreationState ?? progress?.taskCreationState;
  const taskCreationState = [
    "not_attempted",
    "submitting",
    "acknowledged",
    "rejected",
    "outcome_unknown",
  ].includes(taskCreationStateCandidate)
    ? taskCreationStateCandidate
    : undefined;
  const failureStageCandidate = source.failureStage ?? progress?.failureStage;
  const failureStage = [
    "local_upload",
    "provider_file_registration",
    "task_create",
    "result_processing",
  ].includes(failureStageCandidate)
    ? failureStageCandidate
    : failureStageCandidate === null
      ? null
      : undefined;
  const readSafeCount = (value: unknown) => {
    const candidate = Number(value);
    return Number.isSafeInteger(candidate) &&
      candidate >= 0 &&
      candidate <= 1_000
      ? candidate
      : undefined;
  };
  const retainedCustomerAttachmentCount = readSafeCount(
    source.retainedCustomerAttachmentCount ??
      progress?.retainedCustomerAttachmentCount,
  );
  const generatedSystemAttachmentCount = readSafeCount(
    source.generatedSystemAttachmentCount ??
      progress?.generatedSystemAttachmentCount,
  );
  const settledAtCandidate = source.settledAt ?? progress?.settledAt;
  const settledAt =
    settledAtCandidate === null ||
    (typeof settledAtCandidate === "number" &&
      Number.isSafeInteger(settledAtCandidate) &&
      settledAtCandidate >= 0)
      ? settledAtCandidate
      : undefined;
  return {
    stateEpoch: Number(source.stateEpoch ?? 0),
    generation: Number(source.generation ?? 0),
    ...(hasDisplaySequence ? { displaySequence } : {}),
    ...(syncState ? { syncState } : {}),
    ...(processingPhase !== undefined ? { processingPhase } : {}),
    ...(contentState ? { contentState } : {}),
    ...(packageState ? { packageState } : {}),
    ...(publicationState ? { publicationState } : {}),
    ...(contentCompletedAt !== undefined ? { contentCompletedAt } : {}),
    ...(contentAvailability ? { contentAvailability } : {}),
    ...(operationState ? { operationState } : {}),
    ...(typeof resetAllowedCandidate === "boolean"
      ? { resetAllowed: resetAllowedCandidate }
      : {}),
    ...(warningCodes ? { warningCodes } : {}),
    ...(taskCreationState ? { taskCreationState } : {}),
    ...(failureStage !== undefined ? { failureStage } : {}),
    ...(retainedCustomerAttachmentCount !== undefined
      ? { retainedCustomerAttachmentCount }
      : {}),
    ...(generatedSystemAttachmentCount !== undefined
      ? { generatedSystemAttachmentCount }
      : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
    authoritativeTaskId,
    activeTurn: source.activeTurn ?? null,
    completedTurn: source.completedTurn ?? null,
    interaction: { ...interaction, progress },
    approvedPresentation: source.approvedPresentation ?? null,
    package: source.package ?? null,
    notice: source.notice ?? null,
    conversationVersion: source.conversationVersion ?? null,
    progress,
    ...(payload?.accepted === true ? { accepted: true } : {}),
    ...(payload?.resumed === true ? { resumed: true } : {}),
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
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ conversationId: input.conversationId }),
    signal,
  });
  if (!response.ok) {
    const message = await readErrorMessage(response);
    if (response.status === 422) {
      const projectionResponse = await fetch(
        `/api/knowledge-base/progress/${encodeURIComponent(input.conversationId)}`,
        {
          credentials: "include",
          headers: deliveryProjectHeaders(),
          signal,
        },
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

export async function executeKnowledgeBaseRecovery(input: {
  conversationId: string;
  recoveryToken: string;
  clientRequestId: string;
}): Promise<KnowledgeBaseObservationDto> {
  const response = await fetch("/api/knowledge-base/recovery/execute", {
    method: "POST",
    credentials: "include",
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || "当前恢复状态已变化，请刷新后重试",
    ) as Error & {
      status?: number;
      knowledgeObservation?: KnowledgeBaseObservationDto;
    };
    error.status = response.status;
    if (payload?.observation?.interaction) {
      error.knowledgeObservation = normalizeObservation(payload);
    }
    throw error;
  }
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
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
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

export async function recoverKnowledgeBaseCanonicalFromSnapshot(input: {
  conversationId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedStateEpoch: number;
  expectedRevision: number;
  expectedLeafId: string;
  expectedPresentationKey: string;
}): Promise<KnowledgeBaseObservationDto> {
  const response = await fetch(
    "/api/knowledge-base/canonical/recover-from-snapshot",
    {
      method: "POST",
      credentials: "include",
      headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || "创建新任务恢复失败",
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return normalizeObservation(payload?.observation ?? payload);
}

export async function recoverKnowledgeBaseStart(input: {
  conversationId: string;
  expectedGeneration: number;
  expectedStateEpoch: number;
  clientRequestId: string;
  mode: "resume_start_from_retained_sources" | "reselect_start_sources";
  attachmentManifest?: KnowledgeBaseAttachmentRepairManifestItem[];
  attachments?: Array<{ file_id: string; filename: string }>;
}): Promise<KnowledgeBaseObservationDto> {
  const response = await fetch("/api/knowledge-base/start/recover", {
    method: "POST",
    credentials: "include",
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || "知识库启动恢复失败",
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return normalizeObservation(payload?.observation ?? payload);
}

export async function replaceKnowledgeBaseTurnAttachments(input: {
  conversationId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
  attachmentManifest: KnowledgeBaseAttachmentRepairManifestItem[];
  attachments: Array<{ file_id: string; filename: string }>;
}): Promise<KnowledgeBaseObservationDto> {
  const response = await fetch("/api/knowledge-base/turn/replace-attachments", {
    method: "POST",
    credentials: "include",
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
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
 * Repairs only the immutable provenance ledger for an already-bound Logo.
 * This endpoint never creates an upstream turn and never advances a leaf.
 */
export async function repairKnowledgeBaseLogoProvenance(input: {
  conversationId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
  attachmentManifest: [KnowledgeBaseLogoProvenanceRepairManifestItem];
  attachment: { file_id: string; filename: string };
}): Promise<KnowledgeBaseObservationDto> {
  const response = await fetch("/api/knowledge-base/logo-provenance/repair", {
    method: "POST",
    credentials: "include",
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        `请求失败 (${response.status})`,
    ) as KnowledgeBaseLogoProvenanceRepairError;
    error.status = response.status;
    error.code =
      String(payload?.error?.code || payload?.code || "").trim() || undefined;
    if (payload?.observation) {
      try {
        error.knowledgeObservation = normalizeObservation(payload);
      } catch {
        // Preserve the actionable HTTP error even if an optional projection is malformed.
      }
    }
    throw error;
  }
  return normalizeObservation(payload);
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
        "发布后的修改统一进入维护需求，本对话不再生成状态协议信封。",
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
