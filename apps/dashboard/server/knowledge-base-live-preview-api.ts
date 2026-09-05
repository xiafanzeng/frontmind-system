import axios from "axios";
import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  buildKnowledgeBasePrompt,
  buildKnowledgeBaseTurnPrompt,
  createFrontMindTask,
  getKnowledgeBaseSkillDescriptor,
  uploadKnowledgeBaseSkillArchive,
} from "./knowledge-base-api";
import {
  assertKnowledgeBaseInitialImageDelivery,
  assertKnowledgeBaseNodeImageDelivery,
  collectKnowledgeBaseOutputImageKeys,
  collectKnowledgeBaseOutputImageResourceAliases,
  extractFinalKnowledgeBaseAssistantText,
  latestKnowledgeBasePresentationOutput,
} from "./knowledge-base-progress-service";
import {
  applyKnowledgeBaseProgressEnvelope,
  assertKnowledgeBasePresentationMatchesState,
  createKnowledgeBaseProgressState,
  getKnowledgeBaseProgressSummary,
  parseKnowledgeBaseManifestEnvelope,
  parseKnowledgeBasePresentationEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  parseKnowledgeBaseReopenEnvelope,
  validateKnowledgeBaseManifestForTreePolicy,
  type KnowledgeBaseProgressState,
} from "./knowledge-base-progress";
import { getUpstreamBaseUrl } from "./upstream-config";
import { normalizeKnowledgeCollectionCopy } from "../shared/knowledge-base-copy";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import {
  extractKnowledgeBaseProtocolObjects,
  stripKnowledgeBaseProtocolPayloads,
  stripKnowledgeBaseReferenceAppendix,
} from "../shared/knowledge-base-output";
import { buildKnowledgeBaseInstructionDelivery } from "./knowledge-base-prompt-delivery";
import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";

const router = Router();
const SESSION_TTL_MS = 3 * 60 * 60 * 1_000;
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "done",
  "finished",
]);
const SUCCESSFUL_TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "done",
  "finished",
]);

export type KnowledgeBaseLivePreviewMode =
  | "full"
  | "protocol_probe"
  | "continuation";

export const KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES = [
  {
    id: "1.1",
    title: "企业定位",
    branchId: "identity",
    branchTitle: "企业身份",
  },
  {
    id: "2.1",
    title: "核心团队",
    branchId: "team",
    branchTitle: "团队与组织",
  },
  {
    id: "3.1",
    title: "产品体系",
    branchId: "products",
    branchTitle: "产品与服务",
  },
  {
    id: "4.1",
    title: "技术能力",
    branchId: "capabilities",
    branchTitle: "能力体系",
  },
  {
    id: "5.1",
    title: "行业场景",
    branchId: "industries",
    branchTitle: "行业与场景",
  },
  {
    id: "6.1",
    title: "客户案例",
    branchId: "cases",
    branchTitle: "案例与成果",
  },
  {
    id: "7.1",
    title: "差异化优势",
    branchId: "differentiation",
    branchTitle: "品牌差异化",
  },
  {
    id: "8.1",
    title: "合作与支持",
    branchId: "cooperation",
    branchTitle: "合作与支持",
  },
] as const;
export const KNOWLEDGE_BASE_PROTOCOL_PROBE_OPERATION_ID =
  "knowledge-base-protocol-probe";
export const KNOWLEDGE_BASE_PROTOCOL_PROBE_TURN_ID =
  "00000000-0000-4000-8000-000000000004";

type LivePreviewSession = {
  taskId: string;
  apiKey: string | null;
  mode: KnowledgeBaseLivePreviewMode;
  createdAt: number;
  lastLoggedSummary: string;
  progressState: KnowledgeBaseProgressState | null;
  confirmationCount: number;
  skillVersion: string;
  treePolicyVersion: 1 | 2;
  skillContentHash: string | null;
  skillAttachment: { file_id: string; filename: string } | null;
  attachmentCleanup: ReturnType<
    typeof createKnowledgeBaseLivePreviewAttachmentCleanup
  >;
  finalAnalysis: ReturnType<typeof analyzeKnowledgeBaseLiveTask> | null;
};

const livePreviewSessions = new Map<string, LivePreviewSession>();

/**
 * Live preview files are intentionally short-lived and have no database
 * ownership ledger. Keep every generated system file in one idempotent
 * cleanup scope so failed task creation and session expiry cannot leak them.
 */
export function createKnowledgeBaseLivePreviewAttachmentCleanup() {
  const removers = new Set<() => Promise<void>>();
  let cleaned = false;
  return {
    add(remove: () => Promise<void>) {
      if (cleaned) {
        throw new Error("LIVE_PREVIEW_ATTACHMENT_SCOPE_ALREADY_CLEANED");
      }
      removers.add(remove);
    },
    async removeAll() {
      if (cleaned) return;
      cleaned = true;
      const pending = [...removers];
      removers.clear();
      await Promise.allSettled(pending.map((remove) => remove()));
    },
    get pendingCount() {
      return removers.size;
    },
    get cleaned() {
      return cleaned;
    },
  };
}

function remoteAddress(req: Request) {
  return String(req.socket.remoteAddress || "").toLowerCase();
}

export function isLoopbackKnowledgePreviewRequest(req: Request) {
  const address = remoteAddress(req);
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function cleanupExpiredSessions() {
  const expiresBefore = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of livePreviewSessions) {
    if (session.createdAt >= expiresBefore) continue;
    livePreviewSessions.delete(sessionId);
    void session.attachmentCleanup.removeAll().catch(() => undefined);
  }
}

router.use((req, res, next) => {
  if (
    process.env.NODE_ENV !== "development" ||
    !isLoopbackKnowledgePreviewRequest(req)
  ) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "接口不存在" },
    });
    return;
  }
  cleanupExpiredSessions();
  next();
});

function normalizedTaskStatus(value: unknown) {
  return String(value || "running")
    .trim()
    .toLowerCase();
}

function protocolDiagnostic(
  text: string,
  marker: string,
  kind: string,
  parser: (value: unknown) => unknown,
) {
  const count = extractKnowledgeBaseProtocolObjects(text).filter(
    (value) => value.kind === kind,
  ).length;
  if (count === 0 && !text.includes(marker)) return null;
  try {
    return { kind, count, valid: true as const, value: parser(text) };
  } catch (error) {
    return {
      kind,
      count,
      valid: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function analyzeKnowledgeBaseLiveTask(
  task: unknown,
  options: {
    mode?: KnowledgeBaseLivePreviewMode;
    progressState?: KnowledgeBaseProgressState | null;
    confirmationCount?: number;
  } = {},
) {
  const runMode = options.mode || "full";
  const taskRecord =
    task && typeof task === "object" && !Array.isArray(task)
      ? (task as Record<string, unknown>)
      : {};
  const status = normalizedTaskStatus(taskRecord.status);
  const output = Array.isArray(taskRecord.output) ? taskRecord.output : [];
  const presentationOutput = latestKnowledgeBasePresentationOutput(output);
  const imageCount =
    collectKnowledgeBaseOutputImageKeys(presentationOutput).size;
  const assistantText = extractFinalKnowledgeBaseAssistantText(output);
  const protocolObjects = extractKnowledgeBaseProtocolObjects(assistantText);
  const legacySocraticStateCount = (
    assistantText.match(/<!--\s*SOCRATIC_KB_STATE\b/gi) || []
  ).length;
  const protocolKinds = protocolObjects.map((value) =>
    String(value.kind || ""),
  );
  const visibleMarkdown = normalizeKnowledgeCollectionCopy(
    stripKnowledgeBaseReferenceAppendix(
      stripKnowledgeBaseProtocolPayloads(assistantText),
    ),
  ).trim();

  const manifestDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_MANIFEST",
    "frontmind.knowledge-base.manifest",
    (value) => {
      const manifest = parseKnowledgeBaseManifestEnvelope(value);
      if (runMode === "protocol_probe") return manifest;
      return validateKnowledgeBaseManifestForTreePolicy(
        manifest,
        manifest.schemaVersion === 2 && manifest.researchCoverage ? 2 : 1,
        manifest.schemaVersion === 2 && manifest.researchCoverage
          ? { expectedUploadsRead: 0 }
          : {},
      );
    },
  );
  const progressDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_PROGRESS",
    "frontmind.knowledge-base.progress",
    parseKnowledgeBaseProgressEnvelope,
  );
  const reopenDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_REOPEN",
    "frontmind.knowledge-base.reopen",
    parseKnowledgeBaseReopenEnvelope,
  );
  const presentationDiagnostic = protocolDiagnostic(
    assistantText,
    "FRONTMIND_KB_PRESENTATION",
    "frontmind.knowledge-base.presentation",
    parseKnowledgeBasePresentationEnvelope,
  );
  const rawDiagnostics = [
    manifestDiagnostic,
    progressDiagnostic,
    reopenDiagnostic,
    presentationDiagnostic,
  ].filter(Boolean);
  const manifestTurn = Boolean(manifestDiagnostic);
  const diagnostics = rawDiagnostics.map((diagnostic) => ({
    ...diagnostic!,
    authoritative:
      !manifestTurn || diagnostic!.kind === "frontmind.knowledge-base.manifest",
  }));

  const manifest =
    manifestDiagnostic?.valid &&
    manifestDiagnostic.value &&
    typeof manifestDiagnostic.value === "object"
      ? (manifestDiagnostic.value as {
          leaves: Array<{
            id: string;
            title: string;
            branchId?: string;
            branchTitle?: string;
          }>;
        })
      : null;
  const branchCounts = manifest
    ? Object.entries(
        manifest.leaves.reduce<Record<string, number>>((counts, leaf) => {
          const branch = leaf.branchTitle || leaf.branchId || "未分组";
          counts[branch] = (counts[branch] || 0) + 1;
          return counts;
        }, {}),
      ).map(([title, leafCount]) => ({ title, leafCount }))
    : [];

  const issues: string[] = [];
  const terminal = TERMINAL_TASK_STATUSES.has(status);
  const successfulTerminal = SUCCESSFUL_TERMINAL_TASK_STATUSES.has(status);
  if (terminal && !successfulTerminal) {
    issues.push(`任务以失败或取消状态结束：${status}`);
  }
  if (terminal && !assistantText) {
    issues.push("任务已结束，但没有找到带 assistant 角色的可解析文本输出");
  }
  if (terminal && runMode !== "continuation" && !manifestDiagnostic) {
    issues.push("任务已结束，但没有找到知识树 manifest");
  }
  if (terminal && runMode === "continuation" && !progressDiagnostic) {
    issues.push("确认任务已结束，但没有找到 FRONTMIND_KB_PROGRESS");
  }
  if (terminal && runMode === "continuation" && !presentationDiagnostic) {
    issues.push("确认任务已结束，但没有找到 FRONTMIND_KB_PRESENTATION");
  }
  if (legacySocraticStateCount > 0) {
    issues.push("返回了已禁用的旧 SOCRATIC_KB_STATE 状态对象");
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.authoritative && !diagnostic.valid) {
      issues.push(`${diagnostic.kind}：${diagnostic.error}`);
    }
  }
  if (
    visibleMarkdown.includes("FRONTMIND_KB_") ||
    visibleMarkdown.includes("SOCRATIC_KB_STATE") ||
    visibleMarkdown.includes("frontmind.knowledge-base.") ||
    visibleMarkdown.includes("frontmind.workflow-state")
  ) {
    issues.push("客户可见正文仍包含机器协议");
  }
  if (runMode === "protocol_probe" && manifest) {
    const actualLeaves = manifest.leaves.map((leaf) => ({
      id: leaf.id,
      title: leaf.title,
      branchId: leaf.branchId,
      branchTitle: leaf.branchTitle,
    }));
    if (
      JSON.stringify(actualLeaves) !==
      JSON.stringify(KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES)
    ) {
      issues.push("协议探针 manifest 与预期的 8 个叶子不完全一致");
    }
  }
  if (terminal && runMode === "full" && manifest && imageCount !== 1) {
    issues.push(`首轮必须只返回一张企业官方主 Logo，实际返回 ${imageCount} 张`);
  }
  if (terminal && runMode === "protocol_probe" && imageCount !== 0) {
    issues.push(`协议探针禁止返回图片，实际返回 ${imageCount} 张`);
  }
  if (terminal && runMode === "continuation" && imageCount !== 0) {
    issues.push(`后续确认轮次禁止返回图片，实际返回 ${imageCount} 张`);
  }
  const suppressStaleContinuation = runMode === "continuation" && !terminal;
  const structurallyAccepted =
    terminal && successfulTerminal && issues.length === 0;
  const suppressRejectedContinuation =
    runMode === "continuation" && terminal && !structurallyAccepted;
  const suppressCustomerOutput =
    suppressStaleContinuation || suppressRejectedContinuation;

  return {
    runMode,
    taskId: String(taskRecord.id || taskRecord.task_id || ""),
    status,
    terminal,
    successfulTerminal,
    // A continuation is not accepted until its transition has also been
    // applied to the authoritative server state in
    // reconcileTerminalLiveAnalysis. Structural validity alone is not enough.
    protocolAccepted: runMode === "continuation" ? false : structurallyAccepted,
    outputCount: output.length,
    imageCount: suppressCustomerOutput ? 0 : imageCount,
    assistantCharacterCount: assistantText.length,
    visibleCharacterCount: suppressCustomerOutput ? 0 : visibleMarkdown.length,
    visibleMarkdown: suppressCustomerOutput ? "" : visibleMarkdown,
    rawAssistantText: assistantText,
    rawOutput: suppressCustomerOutput ? [] : presentationOutput,
    confirmationCount: Math.max(0, options.confirmationCount || 0),
    knowledgeProgress: options.progressState
      ? {
          revision: options.progressState.revision,
          currentLeafId: options.progressState.currentLeafId,
          ...getKnowledgeBaseProgressSummary(options.progressState),
        }
      : null,
    protocolKinds: suppressStaleContinuation ? [] : protocolKinds,
    legacySocraticStateCount: suppressStaleContinuation
      ? 0
      : legacySocraticStateCount,
    protocolObjects: suppressStaleContinuation ? [] : protocolObjects,
    diagnostics: suppressStaleContinuation ? [] : diagnostics,
    manifest:
      !suppressStaleContinuation && manifest
        ? {
            leafCount: manifest.leaves.length,
            branchCount: branchCounts.length,
            branchCounts,
            firstLeaf: manifest.leaves[0] || null,
            lastLeaf: manifest.leaves[manifest.leaves.length - 1] || null,
            leaves: manifest.leaves,
          }
        : null,
    issues: suppressStaleContinuation ? [] : issues,
  };
}

function resolveLivePreviewApiKey(value: unknown) {
  const supplied = typeof value === "string" ? value.trim() : "";
  return supplied || process.env.FRONTMIND_LIVE_TEST_API_KEY?.trim() || "";
}

function detectedRasterImageMime(bytes: Buffer) {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const signature = bytes.subarray(0, 12).toString("ascii");
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
    /^(?:avif|avis)$/i.test(bytes.subarray(8, 12).toString("ascii"))
  ) {
    return "image/avif";
  }
  return "";
}

async function sendLivePreviewImage(
  res: Response,
  data: unknown,
  maxBytes: number,
) {
  const bytes = Buffer.from(data as ArrayBuffer);
  const contentType = detectedRasterImageMime(bytes);
  if (!bytes.length || bytes.length > maxBytes) {
    res.status(413).end();
    return false;
  }
  if (!contentType) {
    res.status(415).end();
    return false;
  }
  try {
    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
      animated: false,
    });
    const metadata = await decoder.metadata();
    const decodedMime =
      metadata.format === "png"
        ? "image/png"
        : metadata.format === "jpeg"
          ? "image/jpeg"
          : metadata.format === "gif"
            ? "image/gif"
            : metadata.format === "webp"
              ? "image/webp"
              : metadata.format === "heif"
                ? "image/avif"
                : "";
    if (
      !decodedMime ||
      decodedMime !== contentType ||
      !metadata.width ||
      !metadata.height
    ) {
      res.status(415).end();
      return false;
    }
    // metadata() alone may accept a truncated header. Force a complete pixel
    // decode before returning the original, signed bytes to the browser.
    await decoder.clone().raw().toBuffer();
  } catch {
    res.status(415).end();
    return false;
  }
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.send(bytes);
  return true;
}

export function collectKnowledgeBasePreviewFileIds(output: unknown) {
  const ids = new Set<string>();
  for (const key of collectKnowledgeBaseOutputImageResourceAliases(output)) {
    const match = key.match(/\/v1\/files\/([^/?#]+)/);
    if (match?.[1]) {
      try {
        ids.add(decodeURIComponent(match[1]));
      } catch {
        // Malformed URLs cannot identify a downloadable file.
      }
    } else if (!/^https?:\/\//i.test(key) && !/[\s/?#]/u.test(key)) {
      ids.add(key);
    }
  }
  return ids;
}

export function selectKnowledgeBasePreviewDownloadUrl(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "";
  }
  const value = metadata as Record<string, unknown>;
  for (const key of ["download_url", "file_url"] as const) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  // upload_url is intentionally excluded: it is a write capability and is
  // never a valid fallback for preview reads.
  return "";
}

export function buildKnowledgeBaseProtocolProbePrompt() {
  const sourceRows = KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES.map(
    (leaf) => `${leaf.id}|${leaf.title}|${leaf.branchId}|${leaf.branchTitle}`,
  ).join("\n");
  return [
    "FRONTMIND_KB_PROTOCOL_PROBE_V2",
    "严格执行随任务附带的 socratic-kb-builder v4 Skill 中的协议自检模式。",
    "这是本机开发环境的机器协议契约探针，不是企业知识库构建任务。",
    "禁止联网、搜索、浏览、调用工具、读取企业资料、生成文件或开展研究。",
    "把下面 8 行测试数据按原顺序转换为完整 leaves；每行字段依次为 id、title、branchId、branchTitle：",
    sourceRows,
    "",
    "回复只能包含一行可见文字“协议探针响应”，随后紧接且只接一个完整的 FRONTMIND_KB_MANIFEST 注释信封。",
    `信封内必须是严格 JSON：kind 为 frontmind.knowledge-base.manifest，schemaVersion 为 2，operationId 为 ${KNOWLEDGE_BASE_PROTOCOL_PROBE_OPERATION_ID}，turnId 为 ${KNOWLEDGE_BASE_PROTOCOL_PROBE_TURN_ID}，leaves 与以上 8 行逐字段完全一致。`,
    "禁止输出裸 JSON、代码围栏、FRONTMIND_KB_PROGRESS、FRONTMIND_KB_PRESENTATION、SOCRATIC_KB_STATE、workflow-state、knowledge-base.message 或任何解释。",
  ].join("\n");
}

function progressOverrideFromState(state: KnowledgeBaseProgressState) {
  return {
    build: {
      revision: state.revision,
      currentLeafId: state.currentLeafId,
    },
    branches: [
      {
        leaves: state.leaves.map((leaf) => ({
          id: leaf.id,
          title: leaf.title,
          branchTitle: leaf.branchTitle || leaf.branchId || "未分组",
          status: leaf.status,
        })),
      },
    ],
  };
}

function progressStateFromInitialText(text: string) {
  return createKnowledgeBaseProgressState(
    parseKnowledgeBaseManifestEnvelope(text).leaves,
  );
}

export function rehydratedConfirmationProgressState(input: {
  initialText: string;
  revision: unknown;
  currentLeafId: unknown;
  confirmationCount: number;
}) {
  const initialState = progressStateFromInitialText(input.initialText);
  const revision = Number(input.revision);
  const currentLeafId =
    typeof input.currentLeafId === "string"
      ? input.currentLeafId.trim()
      : input.currentLeafId === null
        ? null
        : initialState.currentLeafId;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision !== input.confirmationCount
  ) {
    throw new Error("恢复确认状态的 revision 与已通过次数不一致");
  }
  const currentIndex = currentLeafId
    ? initialState.leaves.findIndex((leaf) => leaf.id === currentLeafId)
    : initialState.leaves.length;
  if (currentIndex < 0 || currentIndex !== input.confirmationCount) {
    throw new Error("恢复确认状态的当前节点与已通过次数不一致");
  }
  return {
    ...initialState,
    revision,
    currentLeafId,
    leaves: initialState.leaves.map((leaf, index) => ({
      ...leaf,
      status:
        index < currentIndex
          ? ("confirmed" as const)
          : index === currentIndex
            ? ("current" as const)
            : ("pending" as const),
    })),
  };
}

/**
 * The real v4 final turn is built from database-approved node Markdown and
 * byte-bound Logo/customer assets. Live preview deliberately has neither
 * authority, so its last confirmation must stop locally instead of asking the
 * model to reconstruct a package from conversational memory.
 */
export function knowledgeBaseLivePreviewNeedsAuthoritativeFinalization(
  state: KnowledgeBaseProgressState,
) {
  if (!state.currentLeafId) return false;
  const currentIndex = state.leaves.findIndex(
    (leaf) => leaf.id === state.currentLeafId,
  );
  if (currentIndex < 0) return false;
  return !state.leaves
    .slice(currentIndex + 1)
    .some((leaf) => leaf.status === "pending");
}

export function selectInitialKnowledgeBaseLiveTask(task: unknown) {
  const taskRecord =
    task && typeof task === "object" && !Array.isArray(task)
      ? (task as Record<string, unknown>)
      : {};
  const output = Array.isArray(taskRecord.output) ? taskRecord.output : [];
  const manifestIndex = output.findIndex((item) => {
    const text = extractFinalKnowledgeBaseAssistantText([item]);
    if (!text) return false;
    try {
      parseKnowledgeBaseManifestEnvelope(text);
      return true;
    } catch {
      return false;
    }
  });
  if (manifestIndex < 0) return task;

  let end = manifestIndex + 1;
  while (end < output.length) {
    if (extractFinalKnowledgeBaseAssistantText([output[end]])) break;
    end += 1;
  }
  return {
    ...taskRecord,
    status: "completed",
    output: output.slice(manifestIndex, end),
  };
}

function reconcileTerminalLiveAnalysis(
  session: LivePreviewSession,
  task: unknown,
) {
  let analysis = analyzeKnowledgeBaseLiveTask(task, {
    mode: session.mode,
    progressState: session.progressState,
    confirmationCount: session.confirmationCount,
  });
  if (!analysis.terminal) return analysis;
  if (!analysis.successfulTerminal) return analysis;

  let validationError = "";
  try {
    if (session.mode === "full") {
      assertKnowledgeBaseInitialImageDelivery(
        task && typeof task === "object"
          ? (task as { output?: unknown }).output
          : undefined,
      );
      session.progressState = progressStateFromInitialText(
        analysis.rawAssistantText,
      );
    } else if (session.mode === "continuation") {
      if (!session.progressState) {
        throw new Error("确认任务缺少可恢复的知识树状态");
      }
      const envelope = parseKnowledgeBaseProgressEnvelope(
        analysis.rawAssistantText,
      );
      const nextState = applyKnowledgeBaseProgressEnvelope(
        session.progressState,
        envelope,
      );
      const presentation = assertKnowledgeBasePresentationMatchesState(
        nextState,
        analysis.rawAssistantText,
      );
      assertKnowledgeBaseNodeImageDelivery({
        presentation,
        output:
          task && typeof task === "object"
            ? (task as { output?: unknown }).output
            : undefined,
      });
      session.progressState = nextState;
      session.confirmationCount += 1;
    }
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }

  analysis = analyzeKnowledgeBaseLiveTask(task, {
    mode: session.mode,
    progressState: session.progressState,
    confirmationCount: session.confirmationCount,
  });
  if (
    validationError &&
    !analysis.issues.some(
      (issue) =>
        issue === validationError || issue.endsWith(`：${validationError}`),
    )
  ) {
    analysis.issues.push(validationError);
  }
  analysis.protocolAccepted =
    !validationError &&
    analysis.successfulTerminal &&
    analysis.issues.length === 0;
  if (!analysis.protocolAccepted) {
    // Keep rawAssistantText and diagnostics for debugging, but never let a
    // rejected provider response replace the last accepted customer node.
    analysis.visibleMarkdown = "";
    analysis.visibleCharacterCount = 0;
    analysis.rawOutput = [];
    analysis.imageCount = 0;
  }
  return analysis;
}

router.get("/configuration", (_req, res) => {
  res.json({
    serverCredentialConfigured: Boolean(
      process.env.FRONTMIND_LIVE_TEST_API_KEY?.trim(),
    ),
    upstreamBaseUrl: getUpstreamBaseUrl(),
  });
});

router.post("/start", async (req, res) => {
  const mode: KnowledgeBaseLivePreviewMode =
    req.body?.mode === "protocol_probe" ? "protocol_probe" : "full";
  const companyName =
    typeof req.body?.companyName === "string"
      ? req.body.companyName.normalize("NFKC").trim()
      : "";
  const companyWebsite =
    typeof req.body?.companyWebsite === "string"
      ? req.body.companyWebsite.trim()
      : "";
  const apiKey = resolveLivePreviewApiKey(req.body?.apiKey);

  if (!companyName || companyName.length > 255) {
    res.status(400).json({
      error: { code: "INVALID_COMPANY_NAME", message: "请输入有效企业名称" },
    });
    return;
  }
  if (!apiKey) {
    res.status(503).json({
      error: {
        code: "LIVE_API_KEY_REQUIRED",
        message:
          "本地服务未配置 FRONTMIND_LIVE_TEST_API_KEY；可在页面中提交一次性 API Key",
      },
    });
    return;
  }

  const baseUrl = getUpstreamBaseUrl();
  const attachmentCleanup = createKnowledgeBaseLivePreviewAttachmentCleanup();
  let skill:
    | Awaited<ReturnType<typeof uploadKnowledgeBaseSkillArchive>>
    | undefined;
  try {
    const descriptor = await getKnowledgeBaseSkillDescriptor();
    const sessionId = randomUUID();
    const initialOperationId = `live-preview:${sessionId}:start`;
    const fullInstructions =
      mode === "protocol_probe"
        ? null
        : await buildKnowledgeBasePrompt({
            conversationId: `live-preview-${Date.now()}`,
            companyName,
            companyWebsite,
            operatorNotes:
              "本地真实 API 与渲染回归。严格输出完整客户正文及规定的机器信封。",
            attachments: [],
            prefillKnowledgeSnapshot: null,
            treePolicyVersion: 2,
            protocolOperation: {
              skillVersion: descriptor.version,
              operationId: initialOperationId,
              turnId: sessionId,
            },
          });
    const instructionDelivery = fullInstructions
      ? buildKnowledgeBaseInstructionDelivery({
          instructions: fullInstructions,
          skillVersion: descriptor.version,
          treePolicyVersion: 2,
          operationId: initialOperationId,
          turnId: sessionId,
        })
      : null;
    const prompt = instructionDelivery
      ? instructionDelivery.prompt
      : buildKnowledgeBaseProtocolProbePrompt();
    skill = await uploadKnowledgeBaseSkillArchive({
      baseUrl,
      apiKey,
      skillVersion: descriptor.version,
      skillContentHash: descriptor.contentHash,
    });
    attachmentCleanup.add(skill.removeOrphan);
    const instructionsUpload = instructionDelivery
      ? await uploadUpstreamTaskAttachment({
          baseUrl,
          apiKey,
          filename: instructionDelivery.filename,
          bytes: instructionDelivery.bytes,
          mimeType: instructionDelivery.mimeType,
          idempotencyKey: `${initialOperationId}:instructions`,
        })
      : null;
    if (instructionsUpload) {
      attachmentCleanup.add(instructionsUpload.removeOrphan);
    }
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt,
      attachments: [
        skill.attachment,
        ...(instructionsUpload ? [instructionsUpload.attachment] : []),
      ],
      idempotencyKey: initialOperationId,
    });
    if (!created.ok) {
      await attachmentCleanup.removeAll();
      res.status(created.status).json({
        error: {
          code: "UPSTREAM_TASK_CREATE_FAILED",
          message: created.detail,
        },
      });
      return;
    }

    let analysis = analyzeKnowledgeBaseLiveTask(created.task, { mode });
    const terminal = analysis.terminal;
    if (terminal && mode === "protocol_probe") {
      await attachmentCleanup.removeAll();
    }
    let progressState: KnowledgeBaseProgressState | null = null;
    if (terminal && mode === "full" && analysis.issues.length === 0) {
      assertKnowledgeBaseInitialImageDelivery(created.task.output);
      progressState = createKnowledgeBaseProgressState(
        parseKnowledgeBaseManifestEnvelope(analysis.rawAssistantText).leaves,
      );
      analysis = analyzeKnowledgeBaseLiveTask(created.task, {
        mode,
        progressState,
      });
    }
    livePreviewSessions.set(sessionId, {
      taskId: created.task.id,
      apiKey: mode === "protocol_probe" && terminal ? null : apiKey,
      mode,
      createdAt: Date.now(),
      lastLoggedSummary: `${analysis.status}:${analysis.outputCount}:${analysis.visibleCharacterCount}`,
      progressState,
      confirmationCount: 0,
      skillVersion: descriptor.version,
      treePolicyVersion: mode === "protocol_probe" ? 1 : 2,
      skillContentHash: descriptor.contentHash,
      skillAttachment: skill.attachment,
      attachmentCleanup,
      finalAnalysis: terminal ? analysis : null,
    });
    console.info("[KnowledgeBaseLivePreview] task started", {
      sessionId,
      taskId: created.task.id,
      mode,
      status: analysis.status,
      outputCount: analysis.outputCount,
      visibleCharacterCount: analysis.visibleCharacterCount,
    });
    res.status(201).json({
      sessionId,
      analysis,
    });
  } catch (error) {
    await attachmentCleanup.removeAll().catch(() => undefined);
    res.status(502).json({
      error: {
        code: "LIVE_PREVIEW_START_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

router.post("/recover", async (req, res) => {
  const taskId =
    typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
  const apiKey = resolveLivePreviewApiKey(req.body?.apiKey);
  if (!taskId || !apiKey) {
    res.status(400).json({
      error: {
        code: "LIVE_PREVIEW_RECOVERY_INPUT_REQUIRED",
        message: "恢复真实任务需要任务 ID 和一次性 API Key",
      },
    });
    return;
  }

  try {
    const response = await axios.get(
      `${getUpstreamBaseUrl()}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          API_KEY: apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      res.status(response.status).json({
        error: {
          code: "UPSTREAM_TASK_READ_FAILED",
          message: `恢复真实任务失败（${response.status}）`,
        },
      });
      return;
    }

    const initialTask = selectInitialKnowledgeBaseLiveTask(response.data);
    let analysis = analyzeKnowledgeBaseLiveTask(initialTask, {
      mode: "full",
    });
    if (!analysis.terminal) {
      res.status(409).json({
        error: {
          code: "LIVE_PREVIEW_TASK_NOT_TERMINAL",
          message: "该任务仍在运行，暂不能恢复为确认状态",
        },
      });
      return;
    }
    if (analysis.issues.length > 0) {
      res.status(422).json({
        error: {
          code: "LIVE_PREVIEW_RECOVERY_VALIDATION_FAILED",
          message: analysis.issues.join("；"),
        },
      });
      return;
    }

    assertKnowledgeBaseInitialImageDelivery(
      initialTask && typeof initialTask === "object"
        ? (initialTask as { output?: unknown }).output
        : undefined,
    );
    const progressState = progressStateFromInitialText(
      analysis.rawAssistantText,
    );
    const recoveredManifest = parseKnowledgeBaseManifestEnvelope(
      analysis.rawAssistantText,
    );
    const recoveredSkill = await getKnowledgeBaseSkillDescriptor({
      version: recoveredManifest.schemaVersion === 2 ? "4" : "3",
    });
    analysis = analyzeKnowledgeBaseLiveTask(initialTask, {
      mode: "full",
      progressState,
      confirmationCount: 0,
    });
    const sessionId = randomUUID();
    livePreviewSessions.set(sessionId, {
      taskId,
      apiKey,
      mode: "full",
      createdAt: Date.now(),
      lastLoggedSummary: `${analysis.status}:${analysis.outputCount}:${analysis.visibleCharacterCount}`,
      progressState,
      confirmationCount: 0,
      skillVersion: recoveredSkill.version,
      treePolicyVersion:
        recoveredManifest.schemaVersion === 2 &&
        recoveredManifest.researchCoverage
          ? 2
          : 1,
      skillContentHash: recoveredSkill.contentHash,
      skillAttachment: null,
      attachmentCleanup: createKnowledgeBaseLivePreviewAttachmentCleanup(),
      finalAnalysis: analysis,
    });
    console.info("[KnowledgeBaseLivePreview] task recovered", {
      sessionId,
      taskId,
      imageCount: analysis.imageCount,
      leafCount: analysis.manifest?.leafCount || 0,
      currentLeafId: progressState.currentLeafId,
    });
    res.status(201).json({ sessionId, analysis });
  } catch (error) {
    res.status(502).json({
      error: {
        code: "LIVE_PREVIEW_RECOVERY_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

router.post("/confirm", async (req, res) => {
  const requestedSessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  let session = requestedSessionId
    ? livePreviewSessions.get(requestedSessionId)
    : undefined;
  let sessionId = requestedSessionId;
  const rehydrating = !session;
  let upstreamContinuationAccepted = false;

  try {
    if (!session) {
      const sourceTaskId =
        typeof req.body?.sourceTaskId === "string"
          ? req.body.sourceTaskId.trim()
          : "";
      const sourceRawAssistantText =
        typeof req.body?.sourceRawAssistantText === "string"
          ? req.body.sourceRawAssistantText
          : "";
      if (!sourceTaskId || !sourceRawAssistantText) {
        res.status(404).json({
          error: {
            code: "LIVE_PREVIEW_SESSION_NOT_FOUND",
            message: "本地会话已重启，请保留首轮结果后重新提交确认",
          },
        });
        return;
      }
      sessionId = randomUUID();
      const confirmationCount = Math.max(
        0,
        Math.trunc(Number(req.body?.confirmationCount) || 0),
      );
      session = {
        taskId: sourceTaskId,
        apiKey: null,
        mode: "continuation",
        createdAt: Date.now(),
        lastLoggedSummary: "",
        progressState: rehydratedConfirmationProgressState({
          initialText: sourceRawAssistantText,
          revision: req.body?.sourceRevision ?? confirmationCount,
          currentLeafId:
            req.body?.sourceCurrentLeafId ??
            (confirmationCount === 0 ? undefined : null),
          confirmationCount,
        }),
        confirmationCount,
        skillVersion:
          parseKnowledgeBaseManifestEnvelope(sourceRawAssistantText)
            .schemaVersion === 2
            ? "4"
            : "3",
        treePolicyVersion: parseKnowledgeBaseManifestEnvelope(
          sourceRawAssistantText,
        ).researchCoverage
          ? 2
          : 1,
        skillContentHash: null,
        skillAttachment: null,
        attachmentCleanup: createKnowledgeBaseLivePreviewAttachmentCleanup(),
        finalAnalysis: null,
      };
    }

    if (!session.progressState || !session.progressState.currentLeafId) {
      res.status(409).json({
        error: {
          code: "LIVE_PREVIEW_NO_CURRENT_LEAF",
          message: "当前知识树没有可确认节点",
        },
      });
      return;
    }
    if (!rehydrating && !session.finalAnalysis) {
      res.status(409).json({
        error: {
          code: "LIVE_PREVIEW_TURN_RUNNING",
          message: "上一轮确认仍在运行",
        },
      });
      return;
    }
    if (
      knowledgeBaseLivePreviewNeedsAuthoritativeFinalization(
        session.progressState,
      )
    ) {
      res.status(409).json({
        error: {
          code: "LIVE_PREVIEW_FINALIZATION_REQUIRES_AUTHORITATIVE_STATE",
          message:
            "本地预览不持有服务端已确认正文、官方 Logo 与客户素材原始字节，不能安全生成最终知识库 ZIP；请在 Dashboard 正式知识库流程中确认最后节点",
        },
      });
      return;
    }

    const apiKey = resolveLivePreviewApiKey(req.body?.apiKey) || session.apiKey;
    if (!apiKey) {
      res.status(503).json({
        error: {
          code: "LIVE_API_KEY_REQUIRED",
          message: "首次继续确认时需要在页面提交一次性 API Key",
        },
      });
      return;
    }

    // A recovered task can still carry an older Skill and rejected assistant
    // turns in its upstream context. Reattach the current deterministic Skill
    // as a system attachment on every continued local session. It is not part
    // of the user's attachment list, so a plain confirmation remains confirm.
    if (!session.skillAttachment) {
      const descriptor = await getKnowledgeBaseSkillDescriptor({
        version: session.skillVersion,
        contentHash: session.skillContentHash,
      });
      session.skillContentHash = descriptor.contentHash;
      const currentSkill = await uploadKnowledgeBaseSkillArchive({
        baseUrl: getUpstreamBaseUrl(),
        apiKey,
        skillVersion: descriptor.version,
        skillContentHash: descriptor.contentHash,
      });
      session.skillAttachment = currentSkill.attachment;
      session.attachmentCleanup.add(currentSkill.removeOrphan);
    }

    const turnId = randomUUID();
    const operationId = `live-preview:${sessionId}:confirm:${session.confirmationCount + 1}`;
    const fullInstructions = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: `live-preview-${sessionId}`,
      userMessage: "确认",
      attachments: [],
      skillVersion: session.skillVersion,
      skillContentHash: session.skillContentHash,
      progressOverride: progressOverrideFromState(session.progressState),
      protocolOperation:
        session.skillVersion === "4" ? { operationId, turnId } : undefined,
    });
    const instructionDelivery = buildKnowledgeBaseInstructionDelivery({
      instructions: fullInstructions,
      skillVersion: session.skillVersion,
      treePolicyVersion: session.treePolicyVersion,
      operationId,
      turnId,
    });
    const instructionsUpload = await uploadUpstreamTaskAttachment({
      baseUrl: getUpstreamBaseUrl(),
      apiKey,
      filename: instructionDelivery.filename,
      bytes: instructionDelivery.bytes,
      mimeType: instructionDelivery.mimeType,
      idempotencyKey: `${operationId}:instructions`,
    });
    const skillAttachment = session.skillAttachment;
    if (!skillAttachment) {
      await instructionsUpload.removeOrphan().catch(() => undefined);
      throw new Error("LIVE_PREVIEW_SKILL_ATTACHMENT_MISSING");
    }
    const created = await createFrontMindTask({
      baseUrl: getUpstreamBaseUrl(),
      apiKey,
      prompt: instructionDelivery.prompt,
      attachments: [skillAttachment, instructionsUpload.attachment],
      taskId: session.taskId,
      idempotencyKey: operationId,
    });
    if (!created.ok) {
      await instructionsUpload.removeOrphan().catch(() => undefined);
      if (rehydrating) {
        await session.attachmentCleanup.removeAll().catch(() => undefined);
      }
      res.status(created.status).json({
        error: {
          code: "LIVE_PREVIEW_CONFIRM_FAILED",
          message: created.detail,
        },
      });
      return;
    }

    // Once the provider has accepted the task, retain this exact instruction
    // file until the preview session expires so an asynchronous agent can
    // continue reading it. The session cleanup remains idempotent.
    session.attachmentCleanup.add(instructionsUpload.removeOrphan);
    upstreamContinuationAccepted = true;
    session.taskId = created.task.id;
    session.apiKey = apiKey;
    session.mode = "continuation";
    session.createdAt = Date.now();
    session.finalAnalysis = null;
    // Store immediately after provider acceptance. If local response analysis
    // ever throws, the accepted task's system files still have an expiry owner.
    livePreviewSessions.set(sessionId, session);
    let analysis = analyzeKnowledgeBaseLiveTask(created.task, {
      mode: "continuation",
      progressState: session.progressState,
      confirmationCount: session.confirmationCount,
    });
    if (analysis.terminal) {
      analysis = reconcileTerminalLiveAnalysis(session, created.task);
      session.finalAnalysis = analysis;
    }
    session.lastLoggedSummary = `${analysis.status}:${analysis.outputCount}:${analysis.visibleCharacterCount}`;
    livePreviewSessions.set(sessionId, session);
    console.info("[KnowledgeBaseLivePreview] confirmation started", {
      sessionId,
      taskId: session.taskId,
      confirmationNumber: session.confirmationCount + 1,
      revision: session.progressState.revision,
      currentLeafId: session.progressState.currentLeafId,
      status: analysis.status,
    });
    res.status(201).json({ sessionId, analysis });
  } catch (error) {
    if (rehydrating && !upstreamContinuationAccepted && session) {
      await session.attachmentCleanup.removeAll().catch(() => undefined);
    }
    res.status(422).json({
      error: {
        code: "LIVE_PREVIEW_CONFIRM_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

router.get("/:sessionId/external-image", async (req, res) => {
  const session = livePreviewSessions.get(req.params.sessionId);
  const imageUrl = typeof req.query.url === "string" ? req.query.url : "";
  if (!session?.finalAnalysis || !imageUrl) {
    res.status(404).end();
    return;
  }
  const allowedImages = collectKnowledgeBaseOutputImageResourceAliases(
    session.finalAnalysis.rawOutput,
  );
  if (!allowedImages.has(imageUrl)) {
    res.status(403).end();
    return;
  }

  const maxBytes = 32 * 1024 * 1024;
  try {
    const imageResponse = await axios.get(assertSafeExternalUrl(imageUrl), {
      ...safeExternalRequestOptions,
      responseType: "arraybuffer",
      timeout: 120_000,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: () => true,
    });
    if (imageResponse.status < 200 || imageResponse.status >= 300) {
      res.status(404).end();
      return;
    }
    await sendLivePreviewImage(res, imageResponse.data, maxBytes);
  } catch {
    res.status(502).end();
  }
});

router.get("/:sessionId/files/:fileId", async (req, res) => {
  const session = livePreviewSessions.get(req.params.sessionId);
  const fileId = String(req.params.fileId || "").trim();
  if (!session?.apiKey || !session.finalAnalysis || !fileId) {
    res.status(404).end();
    return;
  }
  const allowedFileIds = collectKnowledgeBasePreviewFileIds(
    session.finalAnalysis.rawOutput,
  );
  if (!allowedFileIds.has(fileId)) {
    res.status(403).end();
    return;
  }

  const headers = {
    API_KEY: session.apiKey,
    Authorization: `Bearer ${session.apiKey}`,
  };
  const maxBytes = 32 * 1024 * 1024;
  try {
    let imageResponse = await axios.get(
      `${getUpstreamBaseUrl()}/v1/files/${encodeURIComponent(fileId)}/content`,
      {
        headers,
        responseType: "arraybuffer",
        timeout: 120_000,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        validateStatus: () => true,
      },
    );
    const contentType = String(imageResponse.headers["content-type"] || "");
    if (
      imageResponse.status < 200 ||
      imageResponse.status >= 300 ||
      contentType.includes("application/json")
    ) {
      const metadata = await axios.get(
        `${getUpstreamBaseUrl()}/v1/files/${encodeURIComponent(fileId)}`,
        {
          headers,
          timeout: 120_000,
          validateStatus: () => true,
        },
      );
      const downloadUrl = selectKnowledgeBasePreviewDownloadUrl(metadata.data);
      if (metadata.status < 200 || metadata.status >= 300 || !downloadUrl) {
        res.status(404).end();
        return;
      }
      imageResponse = await axios.get(assertSafeExternalUrl(downloadUrl), {
        ...safeExternalRequestOptions,
        responseType: "arraybuffer",
        timeout: 120_000,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        validateStatus: () => true,
      });
    }
    if (imageResponse.status < 200 || imageResponse.status >= 300) {
      res.status(415).end();
      return;
    }
    await sendLivePreviewImage(res, imageResponse.data, maxBytes);
  } catch {
    res.status(502).end();
  }
});

router.get("/:sessionId", async (req, res) => {
  const session = livePreviewSessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({
      error: {
        code: "LIVE_PREVIEW_SESSION_NOT_FOUND",
        message: "本地验收会话不存在或已经过期",
      },
    });
    return;
  }
  if (session.finalAnalysis) {
    res.json({
      sessionId: req.params.sessionId,
      analysis: session.finalAnalysis,
    });
    return;
  }
  if (!session.apiKey) {
    res.status(410).json({
      error: {
        code: "LIVE_PREVIEW_CREDENTIAL_RELEASED",
        message: "本地验收会话已经结束",
      },
    });
    return;
  }

  try {
    const response = await axios.get(
      `${getUpstreamBaseUrl()}/v1/tasks/${encodeURIComponent(session.taskId)}`,
      {
        headers: {
          API_KEY: session.apiKey,
          Authorization: `Bearer ${session.apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      res.status(response.status).json({
        error: {
          code: "UPSTREAM_TASK_READ_FAILED",
          message: `读取真实任务失败（${response.status}）`,
        },
      });
      return;
    }

    let analysis = analyzeKnowledgeBaseLiveTask(response.data, {
      mode: session.mode,
      progressState: session.progressState,
      confirmationCount: session.confirmationCount,
    });
    if (analysis.terminal) {
      analysis = reconcileTerminalLiveAnalysis(session, response.data);
    }
    const summary = `${analysis.status}:${analysis.outputCount}:${analysis.visibleCharacterCount}`;
    if (summary !== session.lastLoggedSummary) {
      session.lastLoggedSummary = summary;
      console.info("[KnowledgeBaseLivePreview] task updated", {
        sessionId: req.params.sessionId,
        taskId: session.taskId,
        mode: session.mode,
        status: analysis.status,
        outputCount: analysis.outputCount,
        visibleCharacterCount: analysis.visibleCharacterCount,
        issueCount: analysis.issues.length,
      });
    }
    if (analysis.terminal) {
      session.finalAnalysis = analysis;
      if (session.mode === "protocol_probe") {
        session.apiKey = null;
      }
      if (session.mode === "protocol_probe") {
        void session.attachmentCleanup.removeAll().catch(() => undefined);
      }
    }
    res.json({ sessionId: req.params.sessionId, analysis });
  } catch (error) {
    res.status(502).json({
      error: {
        code: "LIVE_PREVIEW_POLL_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

export default router;
