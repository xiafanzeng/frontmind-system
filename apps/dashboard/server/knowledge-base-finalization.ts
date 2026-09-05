import type { ConversationTurn, KnowledgeBaseBuild } from "../drizzle/schema";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchivePhysicalDescriptorHash,
  type KnowledgeArchiveDescriptor,
} from "./knowledge-base-artifact";
import type { KnowledgeBasePackageNode } from "./knowledge-base-package-validation";
import {
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
  parseKnowledgeBasePresentationEnvelope,
  parseKnowledgeBaseProgressEnvelope,
} from "./knowledge-base-progress";

export type KnowledgeBaseFinalTransitionTarget =
  | "confirmed"
  | "direct_prefilled";

export type KnowledgeBaseAuthoritativeFinalizationPlan = {
  operationId: string;
  turnId: string;
  taskId: string;
  generation: number;
  revision: number;
  nextRevision: number;
  leafId: string;
  from: "current" | "needs_verification";
  to: KnowledgeBaseFinalTransitionTarget;
  reason: string;
};

/**
 * A complete, parseable pair keeps its ordinary strict semantics, including
 * rejection when it conflicts with the user action. Server synthesis is only
 * a recovery for missing or malformed final protocol text.
 */
export function hasKnowledgeBaseCompleteFinalProtocol(input: {
  assistantText: string;
  plan: KnowledgeBaseAuthoritativeFinalizationPlan;
}) {
  try {
    const progress = parseKnowledgeBaseProgressEnvelope(input.assistantText);
    const presentation = parseKnowledgeBasePresentationEnvelope(
      input.assistantText,
    );
    return (
      progress.operationId === input.plan.operationId &&
      progress.turnId === input.plan.turnId &&
      presentation.operationId === input.plan.operationId &&
      presentation.turnId === input.plan.turnId
    );
  } catch {
    return false;
  }
}

export function deriveKnowledgeBaseAuthoritativeFinalizationPlan(input: {
  build: Pick<
    KnowledgeBaseBuild,
    | "skillVersion"
    | "status"
    | "generation"
    | "stateEpoch"
    | "revision"
    | "currentLeafId"
    | "totalNodeCount"
    | "lastTurnAttachmentCount"
    | "upstreamTaskId"
  >;
  activeTurn?: Pick<
    ConversationTurn,
    | "id"
    | "operationKey"
    | "operationType"
    | "buildGeneration"
    | "expectedRevision"
    | "expectedLeafId"
    | "upstreamTaskId"
    | "status"
  >;
  nodes: readonly KnowledgeBasePackageNode[];
  transitionTarget?: KnowledgeBaseFinalTransitionTarget;
}): KnowledgeBaseAuthoritativeFinalizationPlan | null {
  const { build, activeTurn } = input;
  const leafId = String(build.currentLeafId || "").trim();
  const operationId = String(activeTurn?.operationKey || "").trim();
  const taskId = String(
    activeTurn?.upstreamTaskId || build.upstreamTaskId || "",
  ).trim();
  const ordered = [...input.nodes].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const current = ordered.find((node) => node.leafId === leafId);
  const handled = ordered.filter(
    (node) => node.status === "confirmed" || node.status === "direct_prefilled",
  );
  const target = input.transitionTarget;
  if (
    build.skillVersion !== "4" ||
    build.status !== "confirming" ||
    !activeTurn ||
    (activeTurn.status !== "queued" && activeTurn.status !== "running") ||
    !operationId ||
    !taskId ||
    activeTurn.buildGeneration !== build.generation ||
    activeTurn.upstreamTaskId !== build.upstreamTaskId ||
    activeTurn.expectedRevision !== build.revision ||
    activeTurn.expectedLeafId !== leafId ||
    build.lastTurnAttachmentCount !== 0 ||
    !target ||
    (activeTurn.operationType !== "retry" &&
      activeTurn.operationType !==
        (target === "confirmed" ? "confirm" : "direct_prefill")) ||
    !current ||
    (current.status !== "current" && current.status !== "needs_verification") ||
    ordered.length !== build.totalNodeCount ||
    ordered.length < 1 ||
    current.ordinal !== ordered.length - 1 ||
    handled.length !== ordered.length - 1 ||
    ordered.some((node, index) => node.ordinal !== index)
  ) {
    return null;
  }
  return {
    operationId,
    turnId: activeTurn.id,
    taskId,
    generation: build.generation,
    revision: build.revision,
    nextRevision: build.revision + 1,
    leafId,
    from: current.status,
    to: target,
    reason: target === "confirmed" ? "用户明确确认" : "用户明确采用预填",
  };
}

type IdentityClaims = {
  operationIds: Set<string>;
  turnIds: Set<string>;
  taskIds: Set<string>;
  generations: Set<number>;
};

function collectIdentityClaims(
  value: unknown,
  claims: IdentityClaims = {
    operationIds: new Set(),
    turnIds: new Set(),
    taskIds: new Set(),
    generations: new Set(),
  },
  depth = 0,
) {
  if (value === null || value === undefined || depth > 50) return claims;
  if (Array.isArray(value)) {
    value.forEach((item) => collectIdentityClaims(item, claims, depth + 1));
    return claims;
  }
  if (typeof value !== "object") return claims;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/_/gu, "").toLowerCase();
    if (typeof raw === "string" && raw.trim()) {
      if (normalizedKey === "operationid") claims.operationIds.add(raw.trim());
      if (normalizedKey === "turnid") claims.turnIds.add(raw.trim());
      if (normalizedKey === "taskid") claims.taskIds.add(raw.trim());
    } else if (
      (normalizedKey === "generation" || normalizedKey === "buildgeneration") &&
      ((typeof raw === "number" && Number.isInteger(raw)) ||
        (typeof raw === "string" && /^\d+$/u.test(raw.trim())))
    ) {
      claims.generations.add(Number(raw));
    }
    if (raw && typeof raw === "object") {
      collectIdentityClaims(raw, claims, depth + 1);
    }
  }
  return claims;
}

function claimsDoNotConflict(
  claims: IdentityClaims,
  plan: KnowledgeBaseAuthoritativeFinalizationPlan,
) {
  return (
    (claims.operationIds.size === 0 ||
      (claims.operationIds.size === 1 &&
        claims.operationIds.has(plan.operationId))) &&
    (claims.turnIds.size === 0 ||
      (claims.turnIds.size === 1 && claims.turnIds.has(plan.turnId))) &&
    (claims.taskIds.size === 0 ||
      (claims.taskIds.size === 1 && claims.taskIds.has(plan.taskId))) &&
    (claims.generations.size === 0 ||
      (claims.generations.size === 1 &&
        claims.generations.has(plan.generation)))
  );
}

function assistantMessageContainsMalformedFinalProtocolHint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const role = String(item.role || "")
    .trim()
    .toLowerCase();
  const type = String(item.type || "")
    .trim()
    .toLowerCase();
  if (
    role !== "assistant" ||
    (type !== "message" && type !== "output_message") ||
    !Array.isArray(item.content)
  ) {
    return false;
  }
  return item.content.some((rawContent) => {
    if (
      !rawContent ||
      typeof rawContent !== "object" ||
      Array.isArray(rawContent)
    ) {
      return false;
    }
    const content = rawContent as Record<string, unknown>;
    const contentType = String(content.type || "")
      .trim()
      .toLowerCase();
    if (contentType !== "text" && contentType !== "output_text") return false;
    const rawText = content.text;
    const text =
      typeof rawText === "string"
        ? rawText
        : rawText && typeof rawText === "object" && !Array.isArray(rawText)
          ? String((rawText as Record<string, unknown>).value || "")
          : "";
    return /<!--\s*FRONTMIND_KB_PROGRESS\b/iu.test(text);
  });
}

/**
 * Prefer a resource already scoped by a valid current envelope. If the model
 * mangled only the text protocol, accept one unscoped physical ZIP from the
 * exact bound task, but never one that explicitly claims another operation.
 */
export function selectKnowledgeBaseAuthoritativeFinalDescriptor(input: {
  output: unknown;
  scopedOutput: unknown;
  plan: KnowledgeBaseAuthoritativeFinalizationPlan;
}) {
  const scoped = collectKnowledgeArchiveDescriptors(input.scopedOutput);
  if (scoped.length === 1) return scoped[0]!;
  if (scoped.length > 1) return null;

  const candidates = collectKnowledgeArchiveDescriptors(input.output);
  const outputItems = Array.isArray(input.output) ? input.output : null;
  if (!outputItems) return null;
  let latestProgressItemIndex = -1;
  for (let index = 0; index < outputItems.length; index += 1) {
    if (
      assistantMessageContainsMalformedFinalProtocolHint(outputItems[index])
    ) {
      latestProgressItemIndex = index;
    }
  }
  if (latestProgressItemIndex < 0) return null;
  const nonConflicting = candidates.filter((descriptor) => {
    const physicalHash = knowledgeArchivePhysicalDescriptorHash(descriptor);
    const carryingItemIndexes = outputItems.flatMap((item: unknown, index) =>
      collectKnowledgeArchiveDescriptors([item]).some(
        (candidate) =>
          knowledgeArchivePhysicalDescriptorHash(candidate) === physicalHash,
      )
        ? [index]
        : [],
    );
    return (
      carryingItemIndexes.includes(latestProgressItemIndex) &&
      carryingItemIndexes.every((index) =>
        claimsDoNotConflict(
          collectIdentityClaims(outputItems[index]),
          input.plan,
        ),
      ) &&
      assistantMessageContainsMalformedFinalProtocolHint(
        outputItems[latestProgressItemIndex],
      )
    );
  });
  return nonConflicting.length === 1 ? nonConflicting[0]! : null;
}

export function createKnowledgeBaseAuthoritativeFinalOutput(input: {
  descriptor: KnowledgeArchiveDescriptor;
  plan: KnowledgeBaseAuthoritativeFinalizationPlan;
}) {
  const { descriptor, plan } = input;
  const progress = formatKnowledgeBaseProgressEnvelope({
    kind: "frontmind.knowledge-base.progress",
    schemaVersion: 2,
    operationId: plan.operationId,
    turnId: plan.turnId,
    revision: plan.revision,
    transition: {
      leafId: plan.leafId,
      from: plan.from,
      to: plan.to,
      reason: plan.reason,
    },
  });
  const presentation = formatKnowledgeBasePresentationEnvelope({
    kind: "frontmind.knowledge-base.presentation",
    schemaVersion: 2,
    operationId: plan.operationId,
    turnId: plan.turnId,
    revision: plan.nextRevision,
    leafId: null,
    imageState: "not_applicable",
    assetIds: [],
    imageCount: 0,
  });
  return [
    {
      id: `frontmind-final-protocol-${plan.turnId}`,
      role: "assistant",
      type: "output_message",
      operationId: plan.operationId,
      turnId: plan.turnId,
      taskId: plan.taskId,
      generation: plan.generation,
      content: [
        {
          type: "output_text",
          text: { value: `${progress}\n${presentation}` },
        },
      ],
    },
    {
      id: descriptor.outputItemId,
      role: "assistant",
      type: "output_file",
      operationId: plan.operationId,
      turnId: plan.turnId,
      taskId: plan.taskId,
      generation: plan.generation,
      ...(descriptor.fileId ? { file_id: descriptor.fileId } : {}),
      ...(descriptor.url ? { file_url: descriptor.url } : {}),
      file_name: descriptor.filename,
      mime_type: descriptor.mimeType,
    },
  ];
}
