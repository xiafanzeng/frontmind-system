import type { SiteOpsObservationV1 } from "@shared/siteops-contract";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "@shared/siteops-branding";
import type { SiteOpsActInput } from "@shared/siteops";
import { useCallback, useEffect, useRef, useState } from "react";
import { uploadChatLocalAsset } from "@/lib/frontmind-api";
import { trpc } from "@/lib/trpc";
import SiteOpsConversationPanel, {
  siteOpsSelectVisualFailureMessage,
  type SiteOpsSelectVisualAck,
  type SiteOpsSelectVisualState,
} from "./SiteOpsConversationPanel";

const POLLING_STATES = new Set<SiteOpsObservationV1["interactionState"]>([
  "collecting_brief",
  "visual_searching",
  "building",
]);

const PENDING_DEPLOYMENT_STATES = new Set([
  "reserved",
  "deploying",
  "verifying",
]);

const PENDING_SOCIAL_PACKAGE_STATES = new Set([
  "queued",
  "building",
  "qa_running",
]);

const PENDING_REBUILD_REQUEST_STATES = new Set([
  "submitted",
  "scheduled",
  "in_progress",
]);

const REBUILD_REQUEST_TRANSITIONS: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  submitted: new Set([
    "needs_information",
    "scheduled",
    "in_progress",
    "completed",
    "rejected",
    "cancelled",
  ]),
  needs_information: new Set([
    "submitted",
    "scheduled",
    "in_progress",
    "completed",
    "rejected",
    "cancelled",
  ]),
  scheduled: new Set(["in_progress", "completed", "rejected", "cancelled"]),
  in_progress: new Set(["completed", "rejected", "cancelled"]),
  completed: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
};

const SITEOPS_PROGRESSIVE_POLL_INTERVALS = [
  { untilMs: 60_000, intervalMs: 5_000 },
  { untilMs: 5 * 60_000, intervalMs: 10_000 },
  { untilMs: 30 * 60_000, intervalMs: 20_000 },
  { untilMs: Number.POSITIVE_INFINITY, intervalMs: 30_000 },
] as const;

export const SITEOPS_SELECT_VISUAL_OBSERVE_SCHEDULE_MS = [
  1_000, 2_000, 5_000,
] as const;

type SiteOpsActionInput = Pick<
  SiteOpsActInput,
  "action" | "input" | "messageId" | "cardKind"
>;

type SelectVisualRequestScope = {
  projectId: string;
  conversationId: string;
  expectedRevision: number;
  action: SiteOpsActionInput;
};

export function isAcceptedSelectVisualAck(
  value: unknown,
  input: { clientRequestId: string; expectedRevision: number },
): value is SiteOpsSelectVisualAck {
  if (!value || typeof value !== "object") return false;
  const ack = value as Record<string, unknown>;
  return Boolean(
    ack.schemaVersion === 1 &&
      ack.accepted === true &&
      ack.clientRequestId === input.clientRequestId &&
      typeof ack.operationId === "string" &&
      ack.operationId.trim().length > 0 &&
      typeof ack.projectRevision === "number" &&
      Number.isInteger(ack.projectRevision) &&
      ack.projectRevision > input.expectedRevision &&
      typeof ack.latestSequence === "number" &&
      Number.isInteger(ack.latestSequence) &&
      ack.latestSequence >= 0 &&
      ack.interactionState === "building",
  );
}

const SELECT_VISUAL_COMMITTED_INTERACTION_STATES = new Set<
  SiteOpsObservationV1["interactionState"]
>([
  "building",
  "preview_ready",
  "approved",
  "live",
  "attention_required",
  "failed",
  "cancelled",
]);

export function matchesSelectVisualCommittedObservation(
  observation: SiteOpsObservationV1,
  ack: SiteOpsSelectVisualAck,
) {
  if (
    !SELECT_VISUAL_COMMITTED_INTERACTION_STATES.has(
      observation.interactionState,
    ) ||
    observation.project.revision < ack.projectRevision ||
    observation.latestSequence < ack.latestSequence
  ) {
    return false;
  }
  return observation.messages.some((message) => {
    const card = message.metadata?.siteOps;
    return Boolean(
      card?.kind === "build_progress" &&
        card.subjectId === ack.operationId &&
        card.revision >= ack.projectRevision,
    );
  });
}

function selectVisualInFlight(state: SiteOpsSelectVisualState | null) {
  return Boolean(
    state && ["submitting", "observing", "polling"].includes(state.phase),
  );
}

function hasTrustedFallbackReconciliation(
  observation: SiteOpsObservationV1 | null,
) {
  return Boolean(
    observation?.builds?.some(
      (build) =>
        build.buildDelivery?.renderMode === "trusted_fallback" &&
        build.recoverable === true,
    ),
  );
}

export function siteOpsPollIntervalMs(
  observation: SiteOpsObservationV1 | null,
  activeForMs: number,
) {
  if (!shouldPollSiteOpsObservation(observation)) return false as const;
  if (hasTrustedFallbackReconciliation(observation)) return 60_000;
  return SITEOPS_PROGRESSIVE_POLL_INTERVALS.find(
    ({ untilMs }) => activeForMs < untilMs,
  )!.intervalMs;
}

function observationProjectionTimestamp(observation: SiteOpsObservationV1) {
  return Math.max(
    Date.parse(observation.project.updatedAt) || 0,
    ...(observation.builds ?? []).map(
      (build) => Date.parse(build.updatedAt) || 0,
    ),
  );
}

const BUILD_PHASE_RANK: Record<string, number> = {
  source_waiting: 1,
  source_repairing: 2,
  provider_sync_delayed: 3,
  source_validating: 4,
  compiling: 5,
  persisting_preview: 6,
};

function latestBuildProgressRank(observation: SiteOpsObservationV1) {
  const build = observation.builds?.[0];
  if (!build) return 0;
  if (build.buildDelivery?.renderMode === "trusted_fallback") return 7;
  if (build.buildDelivery) return 8;
  return BUILD_PHASE_RANK[build.buildPhase ?? ""] ?? 0;
}

const DEPLOYMENT_STATUS_RANK: Record<string, number> = {
  reserved: 1,
  deploying: 2,
  verifying: 3,
  active: 4,
  failed: 4,
  attention_required: 4,
  superseded: 4,
};

const SOCIAL_PACKAGE_STATUS_RANK: Record<string, number> = {
  queued: 1,
  building: 2,
  qa_running: 3,
  ready: 4,
  failed: 4,
  attention_required: 4,
  cancelled: 4,
};

function itemProgressComparison(
  current: ReadonlyArray<{ id: string; status: string }>,
  incoming: ReadonlyArray<{ id: string; status: string }>,
  rank: Record<string, number>,
) {
  const currentById = new Map(current.map((item) => [item.id, item.status]));
  let advanced = false;
  for (const item of incoming) {
    const currentStatus = currentById.get(item.id);
    if (!currentStatus) {
      advanced = true;
      continue;
    }
    const currentRank = rank[currentStatus] ?? 0;
    const incomingRank = rank[item.status] ?? 0;
    if (incomingRank < currentRank) return -1;
    if (incomingRank > currentRank) advanced = true;
  }
  return advanced ? 1 : 0;
}

export function siteOpsClientRequestId() {
  return crypto.randomUUID();
}

export type SiteOpsRevisionAttempt = {
  signature: string;
  clientRequestId: string;
  expectedProjectRevision: number;
  contentSha256s: string[];
  localAssetIds: Map<number, string>;
  inFlightUploads: Map<
    number,
    Promise<Awaited<ReturnType<typeof uploadChatLocalAsset>>>
  >;
};

async function siteOpsRevisionFileSha256(file: File) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export async function siteOpsRevisionAttempt(
  previous: SiteOpsRevisionAttempt | null,
  input: { text: string; files: File[]; expectedProjectRevision: number },
) {
  const contentSha256s = await Promise.all(
    input.files.map(siteOpsRevisionFileSha256),
  );
  const signature = JSON.stringify({
    text: input.text,
    files: input.files.map((file, index) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      contentSha256: contentSha256s[index],
    })),
  });
  if (previous?.signature === signature) return previous;
  return {
    signature,
    clientRequestId: siteOpsClientRequestId(),
    expectedProjectRevision: input.expectedProjectRevision,
    contentSha256s,
    localAssetIds: new Map<number, string>(),
    inFlightUploads: new Map(),
  } satisfies SiteOpsRevisionAttempt;
}

export function shouldPollSiteOpsObservation(
  observation: SiteOpsObservationV1 | null,
) {
  const fallbackReconciliationFinished = Boolean(
    observation?.builds?.some(
      (build) =>
        build.buildDelivery?.renderMode === "trusted_fallback" &&
        build.recoverable !== true,
    ),
  );
  return Boolean(
    observation &&
      ((POLLING_STATES.has(observation.interactionState) &&
        !(
          observation.interactionState === "building" &&
          fallbackReconciliationFinished
        )) ||
        observation.rebuildRequest.resetPending === true ||
        (observation.rebuildRequest.status !== null &&
          PENDING_REBUILD_REQUEST_STATES.has(
            observation.rebuildRequest.status,
          )) ||
        observation.visualGeneration.status === "generating" ||
        observation.deployments.some((item) =>
          PENDING_DEPLOYMENT_STATES.has(item.status),
        ) ||
        (observation.messages ?? []).some((item) => {
          const card = item.metadata?.siteOps;
          return Boolean(
            card?.kind === "domain_status" &&
              card.status === "active" &&
              card.revision === observation.project.revision &&
              card.payload?.action === "domain_sync",
          );
        }) ||
        (Boolean(observation.domainState?.domain) &&
          !["active", "attention_required"].includes(
            observation.domainState?.dnsStatus ?? "",
          )) ||
        observation.socialPackages.some((item) =>
          PENDING_SOCIAL_PACKAGE_STATES.has(item.status),
        )),
  );
}

export function newestSiteOpsObservation(
  current: SiteOpsObservationV1 | null,
  incoming: SiteOpsObservationV1,
) {
  if (!current) return incoming;
  if (incoming.project.revision > current.project.revision) return incoming;
  if (incoming.project.revision < current.project.revision) return current;
  if (incoming.latestSequence > current.latestSequence) return incoming;
  if (incoming.latestSequence < current.latestSequence) return current;

  // The visual provider commits the board, success message and project
  // revision before the worker owns the operation's terminal transition. A
  // poll may therefore observe the new board while the operation is still
  // running, followed by an idle/retryable projection with the exact same
  // project/message cursor. Accept that one-way terminal transition while
  // continuing to reject a late running response after terminal state won.
  const currentVisualGenerating =
    current.visualGeneration.status === "generating";
  const incomingVisualGenerating =
    incoming.visualGeneration.status === "generating";
  if (currentVisualGenerating && !incomingVisualGenerating) return incoming;
  // Rebuild-ticket processing is updated by the administrative worker and
  // does not need to append a customer message or bump the project revision.
  // At an equal cursor accept only forward ticket/reset transitions so a late
  // response cannot restore an earlier actionable state.
  const currentRebuild = current.rebuildRequest;
  const incomingRebuild = incoming.rebuildRequest;
  if (!currentRebuild.resetApplied && incomingRebuild.resetApplied) {
    return incoming;
  }
  if (currentRebuild.resetApplied && !incomingRebuild.resetApplied) {
    return current;
  }
  if (!currentRebuild.resetPending && incomingRebuild.resetPending) {
    return incoming;
  }
  if (
    currentRebuild.resetPending &&
    !incomingRebuild.resetPending &&
    !incomingRebuild.resetApplied
  ) {
    return current;
  }
  if (currentRebuild.status !== incomingRebuild.status) {
    if (currentRebuild.status === null && incomingRebuild.status !== null) {
      return incoming;
    }
    if (
      currentRebuild.status !== null &&
      incomingRebuild.status !== null &&
      REBUILD_REQUEST_TRANSITIONS[currentRebuild.status]?.has(
        incomingRebuild.status,
      )
    ) {
      return incoming;
    }
  }
  // Build, fallback, deployment and repair-ticket updates are intentionally
  // allowed to advance without appending another chat message or bumping the
  // project revision. Prefer their database update coordinate at an equal
  // project/message cursor, then use monotonic phase ranks for MySQL's
  // second-precision ties. This also prevents a late response from restoring
  // an older provider phase after the fallback or delivery is already visible.
  const currentProjectionTimestamp = observationProjectionTimestamp(current);
  const incomingProjectionTimestamp = observationProjectionTimestamp(incoming);
  if (incomingProjectionTimestamp > currentProjectionTimestamp) {
    return incoming;
  }
  if (incomingProjectionTimestamp < currentProjectionTimestamp) {
    return current;
  }
  const currentBuildRank = latestBuildProgressRank(current);
  const incomingBuildRank = latestBuildProgressRank(incoming);
  if (incomingBuildRank > currentBuildRank) return incoming;
  if (incomingBuildRank < currentBuildRank) return current;
  const deliveryProgress = itemProgressComparison(
    current.deployments ?? [],
    incoming.deployments ?? [],
    DEPLOYMENT_STATUS_RANK,
  );
  if (deliveryProgress > 0) return incoming;
  if (deliveryProgress < 0) return current;
  const socialProgress = itemProgressComparison(
    current.socialPackages ?? [],
    incoming.socialPackages ?? [],
    SOCIAL_PACKAGE_STATUS_RANK,
  );
  if (socialProgress > 0) return incoming;
  if (socialProgress < 0) return current;
  return current;
}

export default function ConnectedSiteOpsConversationPanel({
  onSubmitIcpFiling,
}: {
  onSubmitIcpFiling?: (input: {
    domain: string;
    icpNumber: string;
  }) => Promise<void> | void;
}) {
  const opened = useRef(false);
  const observationRef = useRef<SiteOpsObservationV1 | null>(null);
  const pendingActionAck = useRef<{
    clientRequestId: string;
    projectRevision: number;
    latestSequence: number;
  } | null>(null);
  const selectVisualRef = useRef<SiteOpsSelectVisualState | null>(null);
  const selectVisualScope = useRef<SelectVisualRequestScope | null>(null);
  const selectVisualObserveRun = useRef(0);
  const observeRequestGeneration = useRef(0);
  const acceptedObserveGeneration = useRef(0);
  const pollEpoch = useRef({ coordinate: "idle", startedAt: Date.now() });
  const revisionAttemptRef = useRef<SiteOpsRevisionAttempt | null>(null);
  const revisionSubmissionInFlightRef = useRef(false);
  const [observation, setObservation] = useState<SiteOpsObservationV1 | null>(
    null,
  );
  const [selectVisual, setSelectVisual] =
    useState<SiteOpsSelectVisualState | null>(null);
  const [submissionNotice, setSubmissionNotice] = useState<string | null>(null);
  const [pageActive, setPageActive] = useState(() =>
    Boolean(
      (typeof document === "undefined" || !document.hidden) &&
        (typeof navigator === "undefined" || navigator.onLine),
    ),
  );
  const updateSelectVisual = useCallback(
    (next: SiteOpsSelectVisualState | null) => {
      selectVisualRef.current = next;
      setSelectVisual(next);
    },
    [],
  );
  const acceptObservation = useCallback(
    (incoming: SiteOpsObservationV1) => {
      const accepted = newestSiteOpsObservation(
        observationRef.current,
        incoming,
      );
      observationRef.current = accepted;
      setObservation(accepted);
      const pending = pendingActionAck.current;
      if (
        pending &&
        (accepted.project.revision > pending.projectRevision ||
          (accepted.project.revision === pending.projectRevision &&
            accepted.latestSequence >= pending.latestSequence))
      ) {
        pendingActionAck.current = null;
        setSubmissionNotice(null);
      }
      const selection = selectVisualRef.current;
      const selectionScope = selectVisualScope.current;
      if (
        selection?.phase === "failed" &&
        selectionScope &&
        (accepted.project.id !== selectionScope.projectId ||
          accepted.project.revision !== selectionScope.expectedRevision)
      ) {
        selectVisualScope.current = null;
        updateSelectVisual(null);
        setSubmissionNotice(null);
      } else if (
        selection?.ack &&
        selection.phase !== "confirmed" &&
        matchesSelectVisualCommittedObservation(accepted, selection.ack)
      ) {
        selectVisualObserveRun.current += 1;
        updateSelectVisual({ ...selection, phase: "confirmed" });
        setSubmissionNotice(null);
      }
    },
    [updateSelectVisual],
  );
  const openMutation = trpc.workspace.siteOps.open.useMutation({
    onSuccess: acceptObservation,
  });
  const conversationId =
    observation?.project.conversationId ?? "siteops:pending";
  const pollCoordinate = observation
    ? [
        observation.project.revision,
        observation.latestSequence,
        observation.interactionState,
        observation.builds[0]?.updatedAt ?? "no-build",
        observation.rebuildRequest.status ?? "no-rebuild",
      ].join(":")
    : "idle";
  if (pollEpoch.current.coordinate !== pollCoordinate) {
    pollEpoch.current = { coordinate: pollCoordinate, startedAt: Date.now() };
  }
  const pollInterval =
    selectVisual?.phase === "polling"
      ? SITEOPS_PROGRESSIVE_POLL_INTERVALS[0].intervalMs
      : siteOpsPollIntervalMs(
          observation,
          Date.now() - pollEpoch.current.startedAt,
        );
  const observeQuery = trpc.workspace.siteOps.observe.useQuery(
    { conversationId },
    {
      enabled: Boolean(observation) && pageActive,
      retry: false,
      refetchOnMount: false,
      refetchOnWindowFocus: true,
      refetchInterval: pageActive ? pollInterval : false,
      refetchIntervalInBackground: false,
    },
  );
  const actMutation = trpc.workspace.siteOps.actFast.useMutation();
  const sendMessageMutation = trpc.workspace.siteOps.sendMessage.useMutation();
  const aliyunBeginMutation =
    trpc.workspace.siteOps.aliyunConnection.beginOAuth.useMutation();
  const aliyunDomainsQuery =
    trpc.workspace.siteOps.aliyunConnection.listDomains.useQuery(
      { conversationId },
      {
        enabled: observation?.aliyunConnection.status === "active",
        retry: false,
        refetchOnWindowFocus: true,
      },
    );
  const aliyunDisconnectMutation =
    trpc.workspace.siteOps.aliyunConnection.disconnect.useMutation();

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    openMutation.mutate(undefined);
  }, [openMutation]);

  useEffect(() => {
    const updatePageActivity = () => {
      setPageActive(!document.hidden && navigator.onLine);
    };
    document.addEventListener("visibilitychange", updatePageActivity);
    window.addEventListener("online", updatePageActivity);
    window.addEventListener("offline", updatePageActivity);
    return () => {
      document.removeEventListener("visibilitychange", updatePageActivity);
      window.removeEventListener("online", updatePageActivity);
      window.removeEventListener("offline", updatePageActivity);
    };
  }, []);

  useEffect(() => {
    if (!observeQuery.data) return;
    const generation = ++observeRequestGeneration.current;
    if (generation < acceptedObserveGeneration.current) return;
    acceptedObserveGeneration.current = generation;
    acceptObservation(observeQuery.data);
  }, [acceptObservation, observeQuery.data]);

  useEffect(
    () => () => {
      selectVisualObserveRun.current += 1;
    },
    [],
  );

  async function observeSelectedVisual(
    clientRequestId: string,
    ack: SiteOpsSelectVisualAck,
  ) {
    const run = ++selectVisualObserveRun.current;
    const startedAt = Date.now();
    for (const scheduledAtMs of SITEOPS_SELECT_VISUAL_OBSERVE_SCHEDULE_MS) {
      const remainingMs = Math.max(0, scheduledAtMs - (Date.now() - startedAt));
      await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
      if (run !== selectVisualObserveRun.current) return;

      const generation = ++observeRequestGeneration.current;
      try {
        const refreshed = await observeQuery.refetch({ cancelRefetch: false });
        if (run !== selectVisualObserveRun.current) return;
        if (!refreshed.data || generation < acceptedObserveGeneration.current) {
          continue;
        }
        acceptedObserveGeneration.current = generation;
        acceptObservation(refreshed.data);
      } catch {
        // A transient observation failure does not invalidate an already
        // accepted build request. Continue the bounded serial schedule.
      }

      const current = selectVisualRef.current;
      if (
        !current ||
        current.clientRequestId !== clientRequestId ||
        current.phase === "confirmed"
      ) {
        return;
      }
    }

    const current = selectVisualRef.current;
    if (
      run === selectVisualObserveRun.current &&
      current?.clientRequestId === clientRequestId &&
      current.ack === ack &&
      current.phase === "observing"
    ) {
      updateSelectVisual({ ...current, phase: "polling" });
      setSubmissionNotice("已提交，状态同步延迟");
    }
  }

  async function submitSelectVisual(
    scope: SelectVisualRequestScope,
    attempt: SiteOpsSelectVisualState,
  ) {
    selectVisualObserveRun.current += 1;
    const submitting: SiteOpsSelectVisualState = {
      ...attempt,
      phase: "submitting",
      ack: null,
    };
    updateSelectVisual(submitting);
    setSubmissionNotice(null);
    actMutation.reset();

    let rawAck: unknown;
    try {
      rawAck = await actMutation.mutateAsync({
        conversationId: scope.conversationId,
        clientRequestId: submitting.clientRequestId,
        expectedRevision: scope.expectedRevision,
        action: scope.action.action,
        input: scope.action.input,
        ...(scope.action.messageId
          ? { messageId: scope.action.messageId }
          : {}),
        ...(scope.action.cardKind ? { cardKind: scope.action.cardKind } : {}),
      });
    } catch {
      const current = selectVisualRef.current;
      if (current?.clientRequestId === submitting.clientRequestId) {
        updateSelectVisual({ ...submitting, phase: "failed", ack: null });
      }
      throw new Error(siteOpsSelectVisualFailureMessage(submitting.label));
    }

    if (
      !isAcceptedSelectVisualAck(rawAck, {
        clientRequestId: submitting.clientRequestId,
        expectedRevision: scope.expectedRevision,
      })
    ) {
      const current = selectVisualRef.current;
      if (current?.clientRequestId === submitting.clientRequestId) {
        updateSelectVisual({ ...submitting, phase: "failed", ack: null });
      }
      throw new Error(siteOpsSelectVisualFailureMessage(submitting.label));
    }

    if (
      selectVisualRef.current?.clientRequestId !== submitting.clientRequestId
    ) {
      return;
    }
    const acknowledged: SiteOpsSelectVisualState = {
      ...submitting,
      phase: "observing",
      ack: rawAck,
    };
    updateSelectVisual(acknowledged);
    setSubmissionNotice(null);

    const currentObservation = observationRef.current;
    if (
      currentObservation &&
      matchesSelectVisualCommittedObservation(currentObservation, rawAck)
    ) {
      updateSelectVisual({ ...acknowledged, phase: "confirmed" });
      return;
    }
    void observeSelectedVisual(submitting.clientRequestId, rawAck);
  }

  async function runSiteOpsAction(input: SiteOpsActionInput) {
    const currentObservation = observationRef.current;
    if (!currentObservation || selectVisualInFlight(selectVisualRef.current)) {
      return;
    }

    if (input.action === "select_visual") {
      const sampleId =
        typeof input.input.sampleId === "string"
          ? input.input.sampleId.trim()
          : "";
      const candidate = [
        ...currentObservation.visualCandidatePages.flatMap(
          (page) => page.candidates,
        ),
        ...currentObservation.visualCandidates,
      ].find((item) => item.id === sampleId);
      if (!sampleId || !candidate) {
        throw new Error("所选模板已不可用，请重新选择。");
      }
      const scope: SelectVisualRequestScope = {
        projectId: currentObservation.project.id,
        conversationId: currentObservation.project.conversationId,
        expectedRevision: currentObservation.project.revision,
        action: input,
      };
      const attempt: SiteOpsSelectVisualState = {
        sampleId,
        label: candidate.label,
        clientRequestId: siteOpsClientRequestId(),
        phase: "submitting",
        ack: null,
      };
      selectVisualScope.current = scope;
      await submitSelectVisual(scope, attempt);
      return;
    }

    const clientRequestId = siteOpsClientRequestId();
    actMutation.reset();
    const ack = await actMutation.mutateAsync({
      conversationId: currentObservation.project.conversationId,
      clientRequestId,
      expectedRevision: currentObservation.project.revision,
      action: input.action,
      input: input.input,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.cardKind ? { cardKind: input.cardKind } : {}),
    });
    pendingActionAck.current = {
      clientRequestId: ack.clientRequestId,
      projectRevision: ack.projectRevision,
      latestSequence: ack.latestSequence,
    };
    setSubmissionNotice("已提交，后台处理中。页面会自动更新，无需刷新。");
    const generation = ++observeRequestGeneration.current;
    void observeQuery.refetch({ cancelRefetch: true }).then((refreshed) => {
      if (!refreshed.data || generation < acceptedObserveGeneration.current) {
        return;
      }
      acceptedObserveGeneration.current = generation;
      acceptObservation(refreshed.data);
    });
  }

  async function retrySelectVisual() {
    const current = selectVisualRef.current;
    const scope = selectVisualScope.current;
    const currentObservation = observationRef.current;
    if (
      !current ||
      current.phase !== "failed" ||
      !scope ||
      !currentObservation ||
      currentObservation.project.id !== scope.projectId ||
      currentObservation.project.revision !== scope.expectedRevision ||
      scope.action.input.sampleId !== current.sampleId
    ) {
      return;
    }
    await submitSelectVisual(scope, current);
  }

  async function submitRevision(input: {
    text: string;
    files: File[];
    onProgress: (fileIndex: number, percent: number) => void;
  }) {
    const currentObservation = observationRef.current;
    if (
      !currentObservation ||
      sendMessageMutation.isPending ||
      revisionSubmissionInFlightRef.current
    ) {
      return;
    }
    // React mutation state updates on the next render. This ref is the
    // synchronous click boundary and closes that otherwise-visible gap.
    revisionSubmissionInFlightRef.current = true;
    try {
      revisionAttemptRef.current = await siteOpsRevisionAttempt(
        revisionAttemptRef.current,
        {
          text: input.text,
          files: input.files,
          expectedProjectRevision: currentObservation.project.revision,
        },
      );
      const attempt = revisionAttemptRef.current;
      const clientRequestId = attempt.clientRequestId;
      sendMessageMutation.reset();
      setSubmissionNotice(
        input.files.length > 0 ? "正在安全上传图片…" : "正在提交修改要求…",
      );

      const uploadAtIndex = (file: File, index: number) => {
        const settledId = attempt.localAssetIds.get(index);
        if (settledId) {
          input.onProgress(index, 100);
          return Promise.resolve({ fileId: settledId, filename: file.name });
        }
        const inFlight = attempt.inFlightUploads.get(index);
        if (inFlight) {
          return inFlight.then((receipt) => {
            input.onProgress(index, 100);
            return receipt;
          });
        }
        const contentSha256 = attempt.contentSha256s[index];
        if (!contentSha256) {
          throw new Error("图片完整性坐标缺失，请重新选择图片。");
        }
        let tracked: Promise<Awaited<ReturnType<typeof uploadChatLocalAsset>>>;
        tracked = uploadChatLocalAsset(
          file,
          (percent) => input.onProgress(index, percent),
          {
            siteOpsComposerCoordinate: {
              clientRequestId,
              contentSha256,
              ordinal: index + 1,
            },
          },
        )
          .then((receipt) => {
            if (!receipt.fileId.startsWith("asset_")) {
              throw new Error("图片没有完成安全留存，请重新上传。");
            }
            attempt.localAssetIds.set(index, receipt.fileId);
            return receipt;
          })
          .finally(() => {
            if (attempt.inFlightUploads.get(index) === tracked) {
              attempt.inFlightUploads.delete(index);
            }
          });
        attempt.inFlightUploads.set(index, tracked);
        return tracked;
      };

      const receipts = await Promise.all(input.files.map(uploadAtIndex));
      const localAssetIds = receipts.map((receipt) => receipt.fileId);
      if (localAssetIds.some((id) => !id.startsWith("asset_"))) {
        throw new Error("图片没有完成安全留存，请重新上传。");
      }
      await sendMessageMutation.mutateAsync({
        conversationId: currentObservation.project.conversationId,
        clientRequestId,
        text: input.text,
        localAssetIds,
        expectedProjectRevision: attempt.expectedProjectRevision,
      });
      revisionAttemptRef.current = null;
      setSubmissionNotice("修改版本已创建；当前预览会保留到新版本完成。");
      const generation = ++observeRequestGeneration.current;
      const refreshed = await observeQuery.refetch({ cancelRefetch: true });
      if (refreshed.data && generation >= acceptedObserveGeneration.current) {
        acceptedObserveGeneration.current = generation;
        acceptObservation(refreshed.data);
      }
    } catch (error) {
      setSubmissionNotice(null);
      throw error;
    } finally {
      revisionSubmissionInFlightRef.current = false;
    }
  }

  const requestError =
    openMutation.error?.message ||
    observeQuery.error?.message ||
    aliyunBeginMutation.error?.message ||
    aliyunDisconnectMutation.error?.message ||
    sendMessageMutation.error?.message ||
    null;

  return (
    <SiteOpsConversationPanel
      observation={observation}
      loading={openMutation.isPending}
      refreshing={observeQuery.isFetching}
      error={requestError}
      notice={submissionNotice}
      interactionPending={
        Boolean(pendingActionAck.current) || selectVisualInFlight(selectVisual)
      }
      selectVisual={selectVisual}
      onRefresh={async () => {
        if (observation) {
          const refreshed = await observeQuery.refetch();
          if (refreshed.data) acceptObservation(refreshed.data);
          return;
        }
        acceptObservation(await openMutation.mutateAsync(undefined));
      }}
      onAction={runSiteOpsAction}
      onRetrySelectVisual={retrySelectVisual}
      onSubmitRevision={submitRevision}
      onBeginAliyun={async () => {
        if (!observation) {
          throw new Error(`${SITEOPS_CUSTOMER_DISPLAY_NAME}尚未就绪。`);
        }
        return await aliyunBeginMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
      }}
      aliyunDomains={aliyunDomainsQuery.data?.domains ?? []}
      aliyunDomainsLoading={aliyunDomainsQuery.isLoading}
      aliyunDomainsError={aliyunDomainsQuery.error?.message ?? null}
      onRefreshAliyunDomains={async () => {
        await aliyunDomainsQuery.refetch();
      }}
      onDisconnectAliyun={async () => {
        if (!observation) return;
        await aliyunDisconnectMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
        const refreshed = await observeQuery.refetch();
        if (refreshed.data) acceptObservation(refreshed.data);
      }}
      onSubmitIcpFiling={
        onSubmitIcpFiling
          ? async (input) => {
              await onSubmitIcpFiling(input);
              const refreshed = await observeQuery.refetch();
              if (refreshed.data) acceptObservation(refreshed.data);
            }
          : undefined
      }
    />
  );
}
