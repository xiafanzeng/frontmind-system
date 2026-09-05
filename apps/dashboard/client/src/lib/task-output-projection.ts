import {
  parseOutputMessages,
  sanitizeKnowledgeBaseOutputMessages,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import type { OutputMessage } from "@/lib/frontmind-api";
import { extractKnowledgeBaseProtocolObjects } from "@shared/knowledge-base-output";

export interface KnowledgeBasePresentationTarget {
  revision: number;
  leafId: string | null;
}

function outputMessageText(item: OutputMessage): string {
  const parts: string[] = [];
  const append = (value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(value);
    else if (
      value &&
      typeof value === "object" &&
      typeof (value as { value?: unknown }).value === "string"
    ) {
      parts.push((value as { value: string }).value);
    }
  };

  append(item.output_text);
  append(item.text);
  if (typeof item.content === "string") {
    append(item.content);
  } else if (Array.isArray(item.content)) {
    item.content.forEach((part) => append(part?.text));
  }
  return parts.join("\n");
}

function knowledgeBaseProtocolTarget(
  item: OutputMessage,
): KnowledgeBasePresentationTarget | null {
  const objects = extractKnowledgeBaseProtocolObjects(outputMessageText(item));
  const presentation = [...objects]
    .reverse()
    .find(
      (value) =>
        value.kind === "frontmind.knowledge-base.presentation" &&
        value.schemaVersion === 1 &&
        Number.isSafeInteger(value.revision) &&
        Number(value.revision) >= 0 &&
        (value.leafId === null ||
          (typeof value.leafId === "string" && value.leafId.trim())),
    );
  if (presentation) {
    return {
      revision: Number(presentation.revision),
      leafId:
        presentation.leafId === null
          ? null
          : String(presentation.leafId).trim(),
    };
  }

  const manifest = [...objects]
    .reverse()
    .find(
      (value) =>
        value.kind === "frontmind.knowledge-base.manifest" &&
        value.schemaVersion === 1 &&
        Array.isArray(value.leaves) &&
        value.leaves.length > 0,
    );
  const firstLeaf = Array.isArray(manifest?.leaves) ? manifest.leaves[0] : null;
  if (
    firstLeaf &&
    typeof firstLeaf === "object" &&
    typeof (firstLeaf as { id?: unknown }).id === "string" &&
    (firstLeaf as { id: string }).id.trim()
  ) {
    return {
      revision: 0,
      leafId: (firstLeaf as { id: string }).id.trim(),
    };
  }
  return null;
}

function isSafeKnowledgeBaseRunningMessage(item: OutputMessage): boolean {
  if (item.role !== "assistant" && item.type !== "message" && item.type) {
    return false;
  }
  const text = outputMessageText(item).trim();
  if (
    !text ||
    text.length > 1_000 ||
    /FRONTMIND_KB_|SOCRATIC_KB_STATE/i.test(text)
  ) {
    return false;
  }
  if (extractKnowledgeBaseProtocolObjects(text).length > 0) return false;
  return /正在|处理中|资料采集|资料收集|检索中|研究阶段/.test(text);
}

function stableOutputIdentity(item: OutputMessage): string | undefined {
  const resourceTypes = new Set([
    "output_image",
    "image",
    "output_file",
    "file",
  ]);
  if (resourceTypes.has(item.type || "")) {
    const directCandidates = [
      item.file_id,
      item.fileId,
      item.image_url,
      item.imageUrl,
      item.file_url,
      item.fileUrl,
      item.url,
    ];
    const contentCandidates = Array.isArray(item.content)
      ? item.content.flatMap((part) => [
          part.file_id,
          part.fileId,
          part.image_url,
          part.imageUrl,
          part.file_url,
          part.fileUrl,
          part.url,
        ])
      : [];
    const resourceIdentity = [...directCandidates, ...contentCandidates].find(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim()),
    );
    if (resourceIdentity) return `resource:${resourceIdentity.trim()}`;
  }
  if (typeof item.id === "string" && item.id.trim()) {
    return `id:${item.id}`;
  }
  if (typeof item.call_id === "string" && item.call_id.trim()) {
    return `call:${item.type || "output"}:${item.call_id}`;
  }
  return undefined;
}

function dedupeStableOutput(output: OutputMessage[]): OutputMessage[] {
  const latestIndexes = new Map<string, number>();
  output.forEach((item, index) => {
    const identity = stableOutputIdentity(item);
    if (identity) latestIndexes.set(identity, index);
  });
  return output.filter((item, index) => {
    const identity = stableOutputIdentity(item);
    return !identity || latestIndexes.get(identity) === index;
  });
}

export function collectAssistantOutputIds(
  messages:
    | Array<{ id?: string; upstreamOutputId?: string; role?: string }>
    | undefined,
): string[] {
  if (!messages) return [];
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? [
          typeof message.upstreamOutputId === "string" &&
          message.upstreamOutputId.trim()
            ? message.upstreamOutputId
            : typeof message.id === "string"
              ? message.id
              : "",
        ].filter(Boolean)
      : [],
  );
}

/**
 * Select the current turn's output from APIs that may return either the full
 * cumulative task history or only the current turn.
 */
export function sliceNewOutput(
  output: OutputMessage[],
  baseline: number,
  historicalOutputIds: readonly string[] = [],
): OutputMessage[] {
  if (baseline <= 0) {
    return dedupeStableOutput(output);
  }

  const historicalIds = new Set(historicalOutputIds);
  if (historicalIds.size > 0) {
    const historicalMatches = output
      .map((item, index) => ({ id: item.id, index }))
      .filter(
        (
          match,
        ): match is {
          id: string;
          index: number;
        } => typeof match.id === "string" && historicalIds.has(match.id),
      );

    if (historicalMatches.length === 0) {
      return dedupeStableOutput(output);
    }

    if (output.length < baseline) {
      return dedupeStableOutput(
        output.filter(
          (item) => typeof item.id !== "string" || !historicalIds.has(item.id),
        ),
      );
    }

    const lastHistoricalIndex = Math.max(
      ...historicalMatches.map((match) => match.index),
    );
    return dedupeStableOutput(
      output.slice(Math.max(baseline, lastHistoricalIndex + 1)),
    );
  }

  if (baseline >= output.length) {
    return dedupeStableOutput(output);
  }
  return dedupeStableOutput(output.slice(baseline));
}

/**
 * Knowledge-base tasks may return either a cumulative output array or only the
 * current turn. Reconciliation is idempotent on the server, so falling back to
 * the complete response is safer than silently missing a node transition.
 */
export function outputForKnowledgeProgress(
  output: OutputMessage[],
  slicedOutput: OutputMessage[],
): OutputMessage[] {
  return slicedOutput.length > 0 ? slicedOutput : output;
}

/**
 * A provider can reuse an output ID or replace a same-length cumulative array.
 * Render only the protocol message matching the server-approved revision and
 * leaf. Knowledge-base images and the final package are projected only from
 * the server-owned observation ledger; raw provider resources are never a
 * display authority. This prevents a stale previous turn or crawled image from
 * flashing before the current envelope is complete.
 */
export function outputForKnowledgePresentation(
  output: OutputMessage[],
  slicedOutput: OutputMessage[],
  expected?: KnowledgeBasePresentationTarget,
): OutputMessage[] {
  if (!expected) {
    return dedupeStableOutput(
      slicedOutput.filter(isSafeKnowledgeBaseRunningMessage),
    );
  }

  const protocolMessages = output.flatMap((item, index) => {
    if (item.role !== "assistant" && item.type !== "message" && item.type) {
      return [];
    }
    const target = knowledgeBaseProtocolTarget(item);
    return target ? [{ index, target }] : [];
  });
  const authoritative = [...protocolMessages]
    .reverse()
    .find(
      ({ target }) =>
        target.revision === expected.revision &&
        target.leafId === expected.leafId,
    );
  if (!authoritative) return [];

  return [output[authoritative.index]!];
}

export function projectTaskOutputMessages({
  output,
  baselineOutputLength,
  historicalOutputIds,
  responseStartedAt,
  modelName,
  knowledgeBase,
  knowledgeBasePresentation,
}: {
  output: OutputMessage[] | undefined;
  baselineOutputLength: number;
  historicalOutputIds?: readonly string[];
  responseStartedAt?: number;
  modelName?: string;
  knowledgeBase: boolean;
  knowledgeBasePresentation?: KnowledgeBasePresentationTarget;
}): LocalMessage[] {
  if (!output?.length) return [];

  const slicedOutput = sliceNewOutput(
    output,
    baselineOutputLength,
    historicalOutputIds,
  );
  const presentationOutput = knowledgeBase
    ? outputForKnowledgePresentation(
        output,
        slicedOutput,
        knowledgeBasePresentation,
      )
    : slicedOutput;
  if (presentationOutput.length === 0) return [];

  const parsed = parseOutputMessages(
    presentationOutput,
    responseStartedAt,
    modelName,
  );
  return knowledgeBase ? sanitizeKnowledgeBaseOutputMessages(parsed) : parsed;
}
