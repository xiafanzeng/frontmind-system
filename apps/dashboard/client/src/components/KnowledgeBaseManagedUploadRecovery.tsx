import { useKnowledgeBaseUploadBatch, useKnowledgeBaseUploadField } from "@/lib/knowledge-base-upload-manager";
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType,
  sha256UploadFile,
} from "@/lib/attachment-files";
import {
  cancelKnowledgeBaseTurnAttachments,
  createKnowledgeBaseTurnTask,
  resumeKnowledgeBaseTurnAttachments,
  uploadKnowledgeBaseLocalAsset,
  stageKnowledgeBaseTurnAttachment,
  type KnowledgeBaseAttachmentManifestItem,
  type KnowledgeBaseMissingCustomerAttachment,
  type KnowledgeBaseTurnAttachmentResumeResult,
} from "@/lib/frontmind-api";
import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";

type RecoveryPhase =
  | "reconciling"
  | "needs_browser"
  | "uploading"
  | "dispatching"
  | "attention";

function fileMatchesManifestMetadata(
  file: File,
  manifest: KnowledgeBaseAttachmentManifestItem,
) {
  return (
    normalizedKnowledgeBaseUploadFilename(file.name) === manifest.filename &&
    file.size === manifest.sizeBytes &&
    normalizedKnowledgeBaseUploadMimeType(file) === manifest.mimeType &&
    Math.max(0, Number(file.lastModified || 0)) === manifest.lastModified
  );
}

async function fileMatchesFrozenManifest(
  file: File,
  manifest: KnowledgeBaseAttachmentManifestItem,
) {
  if (!fileMatchesManifestMetadata(file, manifest)) return false;
  if (!manifest.sha256) return true;
  return (await sha256UploadFile(file)) === manifest.sha256;
}

export default function KnowledgeBaseManagedUploadRecovery({
  conversationId,
  operationType = "revise",
  turnId,
  clientRequestId,
  expectedResetRevision,
  onObservation,
  onRecovered,
  onCancelled,
}: {
  conversationId: string;
  operationType?: "start" | "revise";
  turnId: string;
  clientRequestId: string;
  expectedResetRevision: number;
  onObservation: (observation: KnowledgeBaseObservationDto) => void;
  onRecovered?: () => void;
  onCancelled?: () => void;
}) {
  const batch = useKnowledgeBaseUploadBatch(`reselect:${conversationId}:${expectedResetRevision}:${turnId}`, `reselect:${conversationId}:`);
  const inputRef = useRef<HTMLInputElement>(null);
  const runningRef = batch.ref("running", false);
  const controllerRef = batch.ref<AbortController | null>("controller", null);
  const callbacksRef = batch.ref("callbacks", { onObservation, onRecovered, onCancelled });
  const [phase, setPhase] = useKnowledgeBaseUploadField<RecoveryPhase>(batch, "phase", "reconciling");
  const [resume, setResume] =
    useKnowledgeBaseUploadField<KnowledgeBaseTurnAttachmentResumeResult | null>(batch, "resume", null);
  const [refreshToken, setRefreshToken] = useKnowledgeBaseUploadField(batch, "refreshToken", 0);
  const [error, setError] = useKnowledgeBaseUploadField<string | null>(batch, "error", null);
  const [cancelling, setCancelling] = useKnowledgeBaseUploadField(batch, "cancelling", false);
  const [cancelled, setCancelled] = useKnowledgeBaseUploadField(batch, "cancelled", false);

  useEffect(() => {
    callbacksRef.current = { onObservation, onRecovered, onCancelled };
  }, [onCancelled, onObservation, onRecovered]);

  const coordinate = useMemo(
    () => ({
      conversationId,
      turnId,
      clientRequestId,
      expectedResetRevision,
    }),
    [clientRequestId, conversationId, expectedResetRevision, turnId],
  );

  const reconcile = useCallback(async (signal: AbortSignal) => {
    setPhase("reconciling");
    const recovered = await resumeKnowledgeBaseTurnAttachments(coordinate, signal);
    signal.throwIfAborted();
    setResume(recovered);
    if (recovered.knowledgeObservation) callbacksRef.current.onObservation(recovered.knowledgeObservation);
    if (!recovered.readyToDispatch) { setPhase("needs_browser"); return; }
    setPhase("dispatching");
    const dispatched = await createKnowledgeBaseTurnTask([], {
      conversationId, clientRequestId, expectedResetRevision,
      attachmentReservation: { turnId, attachmentManifest: recovered.attachmentManifest },
    }, signal);
    signal.throwIfAborted();
    if (dispatched.knowledgeObservation) callbacksRef.current.onObservation(dispatched.knowledgeObservation);
    callbacksRef.current.onRecovered?.();
    setCancelled(true);
    toast.success("资料已上传完成，正在启动知识库调研", {
      description: "调研和整理可能需要 30 分钟左右。",
    });
  }, [coordinate, batch]);

  useEffect(() => {
    if (cancelled || runningRef.current || batch.controller) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    batch.controller = controller;
    const operation = captureWorkspaceRestOperation(controller.signal, undefined, { detached: true });
    runningRef.current = true;
    setError(null);
    void reconcile(operation.signal).catch((caught) => {
      if (operation.signal.aborted) return;
      if (caught?.knowledgeObservation) callbacksRef.current.onObservation(caught.knowledgeObservation);
      setPhase("attention");
      setError(caught instanceof Error ? caught.message : "暂时无法核对资料，请检查并继续");
    }).finally(() => {
      runningRef.current = false;
      if (batch.controller === controller) batch.controller = null;
    });
  }, [cancelled, coordinate, refreshToken, reconcile]);

  const selectFiles = useCallback(
    async (fileList: FileList | null) => {
      const selected = Array.from(fileList || []);
      if (!resume || selected.length === 0 || batch.controller) return;
      setPhase("uploading");
      setError(null);
      const controller = new AbortController();
      controllerRef.current = controller;
      batch.controller = controller;
      batch.startHeartbeat(coordinate);
      const operation = captureWorkspaceRestOperation(controller.signal, undefined, { detached: true });
      try {
        const missingByItemId = new Map(
          resume.missingCustomerAttachments.map((item) => [item.itemId, item]),
        );
        // When two frozen entries have identical browser metadata and no
        // digest, a user selecting only the missing copy must not be matched
        // to an already-retained entry first. Explicit digests still decide
        // identity inside fileMatchesFrozenManifest when they are present.
        const unusedManifest = resume.attachmentManifest
          .map((manifest, index) => ({ manifest, index }))
          .sort((left, right) => {
            const leftMissing = left.manifest.itemId
              ? missingByItemId.has(left.manifest.itemId)
              : false;
            const rightMissing = right.manifest.itemId
              ? missingByItemId.has(right.manifest.itemId)
              : false;
            return Number(rightMissing) - Number(leftMissing);
          });
        const matched: Array<{
          file: File;
          manifest: KnowledgeBaseAttachmentManifestItem;
          index: number;
        }> = [];
        for (const file of selected) {
          let matchedIndex = -1;
          for (let index = 0; index < unusedManifest.length; index += 1) {
            if (
              await fileMatchesFrozenManifest(
                file,
                unusedManifest[index]!.manifest,
              )
            ) {
              matchedIndex = index;
              break;
            }
          }
          if (matchedIndex < 0) {
            throw new Error(`所选文件与本轮资料清单不一致：${file.name}`);
          }
          const target = unusedManifest.splice(matchedIndex, 1)[0]!;
          matched.push({ file, ...target });
        }

        const missingFiles = matched
          .map((item) => ({
            ...item,
            missing: item.manifest.itemId
              ? missingByItemId.get(item.manifest.itemId)
              : undefined,
          }))
          .filter(
            (
              item,
            ): item is typeof item & {
              missing: KnowledgeBaseMissingCustomerAttachment;
            } => Boolean(item.missing),
          )
          .sort((left, right) => left.missing.ordinal - right.missing.ordinal);

        if (missingFiles.length === 0) {
          throw new Error(
            "所选资料均已保存，请选择仍缺失的原文件",
          );
        }
        for (const { file, missing } of missingFiles) {
          const uploaded = await uploadKnowledgeBaseLocalAsset(
            file,
            undefined,
            undefined,
            {
              signal: operation.signal,
              captureLocalCopy: true,
              captureFilename: missing.filename,
              batchId: clientRequestId,
              batchOrdinal: missing.ordinal,
              batchTotal: resume.attachmentManifest.length,
              itemId: missing.itemId,
              ...(missing.sha256 ? { contentSha256: missing.sha256 } : {}),
              resumeScope: {
                kind: "knowledge_base",
                operationType,
                conversationId,
                turnId,
                clientRequestId,
                expectedResetRevision,
              },
            },
          );
          if (operationType === "start" && !uploaded.alreadyStaged) {
            await stageKnowledgeBaseTurnAttachment({ ...coordinate, attachmentManifest: resume.attachmentManifest,
              index: missing.ordinal - 1, signal: operation.signal,
              attachment: { file_id: uploaded.fileId, filename: uploaded.filename } });
          }
          if (uploaded.knowledgeObservation) {
            callbacksRef.current.onObservation(uploaded.knowledgeObservation);
          }
        }
        // Finish on the same background operation even if this page unmounted.
        await reconcile(operation.signal);
      } catch (caught) {
        const knowledgeObservation = (
          caught as {
            knowledgeObservation?: KnowledgeBaseObservationDto;
          } | null
        )?.knowledgeObservation;
        if (knowledgeObservation) {
          callbacksRef.current.onObservation(knowledgeObservation);
        }
        setPhase("needs_browser");
        setError(
          caught instanceof Error ? caught.message : "文件恢复暂时不可用",
        );
      } finally {
        batch.endHeartbeat();
        if (batch.controller === controller) batch.controller = null;
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [
      clientRequestId,
      conversationId,
      expectedResetRevision,
      phase,
      resume,
      turnId,
      reconcile,
      batch,
    ],
  );

  const cancelTurn = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    setError(null);
    controllerRef.current?.abort();
    try {
      const result = await cancelKnowledgeBaseTurnAttachments(coordinate);
      callbacksRef.current.onObservation(result.knowledgeObservation);
      callbacksRef.current.onCancelled?.();
      setCancelled(true);
      toast.success("已放弃本轮补充，可从当前节点继续");
    } catch (caught) {
      const knowledgeObservation = (
        caught as { knowledgeObservation?: KnowledgeBaseObservationDto } | null
      )?.knowledgeObservation;
      if (knowledgeObservation) {
        callbacksRef.current.onObservation(knowledgeObservation);
      }
      setError(caught instanceof Error ? caught.message : "放弃本轮补充失败");
      setPhase("attention");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, coordinate]);

  if (cancelled) return null;

  const retainedCount = resume?.retainedCustomerAttachmentCount ?? 0;
  const totalCount = resume?.attachmentManifest.length ?? 0;
  const missingCount = resume?.missingCustomerAttachments.length ?? 0;

  return (
    <div
      className="mb-3 rounded-xl border border-amber-300/70 bg-amber-50/80 p-3 text-sm text-amber-950"
      data-testid="knowledge-base-managed-upload-recovery"
    >
      <p className="font-medium">资料尚未上传完成，请重新选择缺失文件</p>
      <p className="mt-1 text-xs leading-5 text-amber-900/80">
        {resume
          ? `已保存 ${retainedCount}/${totalCount}，仍缺 ${missingCount} 份资料。可选择缺失资料，也可重新选择全部原文件；已保留文件不会重复上传。`
          : phase === "attention"
            ? "暂时无法核对本轮资料；当前节点和已保存资料不受影响。"
            : "正在核对已保存的资料，无需重传已完成文件。"}
      </p>
      {error && <p className="mt-1 text-xs text-amber-800">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="选择本轮缺失的知识库原文件"
        disabled={phase === "uploading" || phase === "dispatching"}
        onChange={(event) => void selectFiles(event.currentTarget.files)}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {(phase === "needs_browser" || phase === "attention") && resume ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            重新选择缺失文件
          </Button>
        ) : (
          <span className="inline-flex items-center text-xs">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {phase === "dispatching"
              ? "正在启动调研"
              : phase === "uploading"
                ? "正在保存缺失资料"
                : "正在核对资料"}
          </span>
        )}
        {phase === "attention" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            检查并继续
          </Button>
        )}
        {operationType === "revise" && <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={cancelling || phase === "dispatching"}
          onClick={() => void cancelTurn()}
        >
          {cancelling && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          放弃本轮补充，返回当前节点
        </Button>}
      </div>
    </div>
  );
}
