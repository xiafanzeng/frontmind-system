import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";

interface CoordinatorSlot {
  registered: boolean;
  running: boolean;
  rerunRequested: boolean;
  generation: number;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  notFoundSince: number | null;
  pendingClientRequestId: string | null;
  pendingRequestStartedAt: number | null;
}

export interface KnowledgeBaseCoordinatorOptions {
  observe: (
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<KnowledgeBaseObservationDto>;
  apply: (
    conversationId: string,
    observation: KnowledgeBaseObservationDto,
  ) => void;
  onTransientError?: (conversationId: string, error: unknown) => void;
  onPermanentError?: (conversationId: string, error: unknown) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  notFoundGraceMs?: number;
  pendingRequestGraceMs?: number;
}

// Stay beyond the 5-minute /turn fetch timeout so a browser that loses the
// response still observes a reservation completed at the timeout boundary.
export const KNOWLEDGE_BASE_PENDING_REQUEST_GRACE_MS = 6 * 60 * 1000;
export const KNOWLEDGE_BASE_FINAL_PACKAGE_MISSING_NOTICE_CODE =
  "FINAL_PACKAGE_MISSING";
export const KNOWLEDGE_BASE_LATE_PACKAGE_POLL_GRACE_MS = 5 * 60 * 1000;

export function getKnowledgeBasePollDelay(elapsedMs: number) {
  if (elapsedMs < 5 * 60 * 1000) return 3_000;
  if (elapsedMs < 30 * 60 * 1000) return 10_000;
  return 30_000;
}

export function observationNeedsPolling(
  observation: KnowledgeBaseObservationDto,
  now = Date.now(),
): boolean {
  const state = observation.interaction?.interactionState;
  if (
    state === "ready_to_publish" &&
    (observation.packageState === "not_started" ||
      observation.packageState === "preparing" ||
      observation.packageState === "retrying")
  ) {
    // Semantic completion and local package generation are separate durable
    // phases. The package worker does not advance the content stateEpoch, so
    // keep a low-cost observation loop until its same-coordinate refinement
    // becomes ready or build-local attention. Otherwise an open tab would
    // never reveal the download button without a manual refresh.
    return true;
  }
  if (state !== "queued" && state !== "executing") {
    // Failed, published, ready-to-publish and stable awaiting-input states are
    // terminal from the coordinator's perspective. Focus/online may perform a
    // single explicit refresh, but no timer may keep them in a feedback loop.
    if (state !== "awaiting_input") return false;
  }
  if (
    observation.notice?.code ===
    KNOWLEDGE_BASE_FINAL_PACKAGE_MISSING_NOTICE_CODE
  ) {
    // A provider can publish the typed ZIP shortly after its terminal text.
    // Continue rereading the exact authoritative task so the server can bind
    // the late resource without a new billable turn. The visible retry button
    // remains available if the file never arrives.
    return (
      now - observation.notice.createdAt <
      KNOWLEDGE_BASE_LATE_PACKAGE_POLL_GRACE_MS
    );
  }
  if (state === "queued" || state === "executing") return true;
  if (state !== "awaiting_input") return false;

  const presentation = observation.approvedPresentation;
  const progress = observation.progress ?? observation.interaction?.progress;
  const activeTurnId = observation.activeTurn?.id ?? null;
  return !(
    presentation &&
    presentation.visibleMarkdown.trim() &&
    presentation.turnId &&
    (!activeTurnId || presentation.turnId === activeTurnId) &&
    progress &&
    presentation.revision === progress.build.revision &&
    presentation.leafId === progress.build.currentLeafId
  );
}

export interface KnowledgeBaseAcknowledgementOptions {
  /**
   * An ordinary reply creates a new active turn, so seeing that request id is
   * durable acknowledgement. A legacy attachment takeover reuses an active
   * request id that already existed before the upload attempt and must disable
   * this signal; only a later presentation/completion proves new progress.
   */
  allowActiveTurn?: boolean;
}

/** A durable server observation is the acknowledgement, independent of HTTP. */
export function knowledgeBaseObservationAcknowledgesClientRequest(
  observation: KnowledgeBaseObservationDto | null | undefined,
  clientRequestId: string | null | undefined,
  options: KnowledgeBaseAcknowledgementOptions = {},
) {
  const requestId = clientRequestId?.trim();
  if (!observation || !requestId) return false;
  return (
    (options.allowActiveTurn !== false &&
      observation.activeTurn?.clientRequestId === requestId) ||
    observation.approvedPresentation?.clientRequestId === requestId ||
    observation.completedTurn?.clientRequestId === requestId
  );
}

/**
 * One instance is owned by one ConversationProvider. Repeated wake calls are
 * coalesced and never create overlapping reconcile requests for a conversation.
 */
export class KnowledgeBasePollingCoordinator {
  private readonly slots = new Map<string, CoordinatorSlot>();
  private disposed = false;

  constructor(private readonly options: KnowledgeBaseCoordinatorOptions) {}

  register(conversationId: string) {
    if (!conversationId || this.disposed) return;
    const existing = this.slots.get(conversationId);
    if (existing) {
      existing.registered = true;
      return;
    }
    this.slots.set(conversationId, {
      registered: true,
      running: false,
      rerunRequested: false,
      generation: 0,
      controller: null,
      timer: null,
      startedAt: (this.options.now ?? Date.now)(),
      notFoundSince: null,
      pendingClientRequestId: null,
      pendingRequestStartedAt: null,
    });
  }

  isRegistered(conversationId: string) {
    return this.slots.get(conversationId)?.registered === true;
  }

  wake(conversationId: string, pendingClientRequestId?: string | null) {
    if (!conversationId || this.disposed) return;
    this.register(conversationId);
    const slot = this.slots.get(conversationId)!;
    let pendingRequestChanged = false;
    if (pendingClientRequestId !== undefined) {
      const normalizedRequestId = pendingClientRequestId?.trim() || null;
      if (normalizedRequestId !== slot.pendingClientRequestId) {
        pendingRequestChanged = true;
        const now = (this.options.now ?? Date.now)();
        slot.pendingClientRequestId = normalizedRequestId;
        slot.pendingRequestStartedAt = normalizedRequestId ? now : null;
        if (normalizedRequestId) slot.startedAt = now;
      }
    }
    if (slot.timer) {
      (this.options.clearTimer ?? clearTimeout)(slot.timer);
      slot.timer = null;
    }
    if (slot.running) {
      // Progress events and query-cache updates can wake the same coordinator
      // while its authoritative reconcile is still running. Only a genuinely
      // new pending request warrants one follow-up observation.
      if (pendingRequestChanged) slot.rerunRequested = true;
      return;
    }
    void this.run(conversationId, slot);
  }

  clearPendingRequest(conversationId: string, clientRequestId?: string) {
    const slot = this.slots.get(conversationId);
    if (
      !slot ||
      (clientRequestId && slot.pendingClientRequestId !== clientRequestId)
    ) {
      return;
    }
    slot.pendingClientRequestId = null;
    slot.pendingRequestStartedAt = null;
  }

  wakeAll() {
    for (const [conversationId, slot] of this.slots) {
      if (slot.registered) this.wake(conversationId);
    }
  }

  unregister(conversationId: string) {
    const slot = this.slots.get(conversationId);
    if (!slot) return;
    slot.registered = false;
    slot.generation += 1;
    slot.controller?.abort();
    if (slot.timer) {
      (this.options.clearTimer ?? clearTimeout)(slot.timer);
    }
    this.slots.delete(conversationId);
  }

  reset() {
    for (const conversationId of [...this.slots.keys()]) {
      this.unregister(conversationId);
    }
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }

  private schedule(conversationId: string, slot: CoordinatorSlot) {
    if (this.disposed || !slot.registered || slot.timer) return;
    const now = (this.options.now ?? Date.now)();
    slot.timer = (this.options.setTimer ?? setTimeout)(
      () => {
        slot.timer = null;
        this.wake(conversationId);
      },
      getKnowledgeBasePollDelay(now - slot.startedAt),
    );
  }

  private pendingRequestNeedsPolling(
    slot: CoordinatorSlot,
    observation: KnowledgeBaseObservationDto,
  ) {
    const clientRequestId = slot.pendingClientRequestId;
    const startedAt = slot.pendingRequestStartedAt;
    if (!clientRequestId || startedAt === null) return false;

    const acknowledged = knowledgeBaseObservationAcknowledgesClientRequest(
      observation,
      clientRequestId,
    );
    if (acknowledged) {
      slot.pendingClientRequestId = null;
      slot.pendingRequestStartedAt = null;
      return false;
    }

    const now = (this.options.now ?? Date.now)();
    const graceMs =
      this.options.pendingRequestGraceMs ??
      KNOWLEDGE_BASE_PENDING_REQUEST_GRACE_MS;
    if (now - startedAt < graceMs) return true;
    return false;
  }

  private pendingRequestIsWithinGrace(slot: CoordinatorSlot, now: number) {
    if (!slot.pendingClientRequestId || slot.pendingRequestStartedAt === null) {
      return false;
    }
    return (
      now - slot.pendingRequestStartedAt <
      (this.options.pendingRequestGraceMs ??
        KNOWLEDGE_BASE_PENDING_REQUEST_GRACE_MS)
    );
  }

  private async run(conversationId: string, slot: CoordinatorSlot) {
    if (this.disposed || !slot.registered || slot.running) return;
    slot.running = true;
    slot.rerunRequested = false;
    const generation = slot.generation;
    const controller = new AbortController();
    slot.controller = controller;

    try {
      const observation = await this.options.observe(
        conversationId,
        controller.signal,
      );
      if (
        this.disposed ||
        !slot.registered ||
        slot.generation !== generation ||
        controller.signal.aborted
      ) {
        return;
      }
      slot.notFoundSince = null;
      this.options.apply(conversationId, observation);
      const pendingRequestNeedsPolling = this.pendingRequestNeedsPolling(
        slot,
        observation,
      );
      if (
        observationNeedsPolling(
          observation,
          (this.options.now ?? Date.now)(),
        ) ||
        pendingRequestNeedsPolling
      ) {
        this.schedule(conversationId, slot);
      }
    } catch (error) {
      if (!controller.signal.aborted && slot.generation === generation) {
        const status = Number((error as { status?: unknown })?.status || 0);
        const now = (this.options.now ?? Date.now)();
        if (status === 404 && slot.notFoundSince === null) {
          slot.notFoundSince = now;
        }
        const notFoundWithinGrace =
          status === 404 &&
          (now - (slot.notFoundSince ?? now) <
            (this.options.notFoundGraceMs ?? 15_000) ||
            this.pendingRequestIsWithinGrace(slot, now));
        const retryable =
          !status ||
          status === 408 ||
          status === 429 ||
          status >= 500 ||
          notFoundWithinGrace;
        if (retryable) {
          this.options.onTransientError?.(conversationId, error);
          this.schedule(conversationId, slot);
        } else {
          this.unregister(conversationId);
          this.options.onPermanentError?.(conversationId, error);
        }
      }
    } finally {
      if (slot.controller === controller) slot.controller = null;
      slot.running = false;
      if (
        !this.disposed &&
        slot.registered &&
        slot.generation === generation &&
        slot.rerunRequested
      ) {
        slot.rerunRequested = false;
        if (slot.timer) {
          (this.options.clearTimer ?? clearTimeout)(slot.timer);
          slot.timer = null;
        }
        void this.run(conversationId, slot);
      }
    }
  }
}
