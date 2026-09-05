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
  turnId,
  clientRequestId,
  expectedResetRevision,
  onObservation,
  onRecovered,
  onCancelled,
}: {
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  expectedResetRevision: number;
  onObservation: (observation: KnowledgeBaseObservationDto) => void;
  onRecovered?: () => void;
  onCancelled?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const callbacksRef = useRef({ onObservation, onRecovered, onCancelled });
  const [phase, setPhase] = useState<RecoveryPhase>("reconciling");
  const [resume, setResume] =
    useState<KnowledgeBaseTurnAttachmentResumeResult | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

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

  useEffect(() => {
    if (cancelled || runningRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    runningRef.current = true;

    const run = async () => {
      try {
        setError(null);
        setPhase("reconciling");
        const recovered = await resumeKnowledgeBaseTurnAttachments(
          coordinate,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResume(recovered);
        if (recovered.knowledgeObservation) {
          callbacksRef.current.onObservation(recovered.knowledgeObservation);
        }
        if (!recovered.readyToDispatch) {
          setPhase("needs_browser");
          return;
        }

        setPhase("dispatching");
        const dispatched = await createKnowledgeBaseTurnTask([], {
          conversationId,
          clientRequestId,
          expectedResetRevision,
          attachmentReservation: {
            turnId,
            attachmentManifest: recovered.attachmentManifest,
          },
        });
        if (controller.signal.aborted) return;
        if (dispatched.knowledgeObservation) {
          callbacksRef.current.onObservation(dispatched.knowledgeObservation);
        }
        callbacksRef.current.onRecovered?.();
        toast.success("缺失资料已补齐，正在继续原知识库轮次", {
          description: "系统沿用原 turn，只派发一次任务。",
        });
      } catch (caught) {
        if (controller.signal.aborted) return;
        const knowledgeObservation = (
          caught as {
            knowledgeObservation?: KnowledgeBaseObservationDto;
          } | null
        )?.knowledgeObservation;
        if (knowledgeObservation) {
          callbacksRef.current.onObservation(knowledgeObservation);
        }
        setPhase("attention");
        setError(
          caught instanceof Error ? caught.message : "附件恢复暂时不可用",
        );
      } finally {
        runningRef.current = false;
      }
    };
    void run();
    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      runningRef.current = false;
    };
  }, [cancelled, coordinate, refreshToken]);

  const selectFiles = useCallback(
    async (fileList: FileList | null) => {
      const selected = Array.from(fileList || []);
      if (!resume || selected.length === 0 || phase === "uploading") return;
      setPhase("uploading");
      setError(null);
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
            throw new Error(`所选文件与本轮冻结清单不一致：${file.name}`);
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
            "所选资料均已由 Dashboard 保留，请选择仍缺失的原文件",
          );
        }
        for (const { file, missing } of missingFiles) {
          const uploaded = await uploadKnowledgeBaseLocalAsset(
            file,
            undefined,
            undefined,
            {
              captureLocalCopy: true,
              captureFilename: missing.filename,
              batchId: clientRequestId,
              batchOrdinal: missing.ordinal,
              batchTotal: resume.attachmentManifest.length,
              itemId: missing.itemId,
              ...(missing.sha256 ? { contentSha256: missing.sha256 } : {}),
              resumeScope: {
                kind: "knowledge_base",
                operationType: "revise",
                conversationId,
                turnId,
                clientRequestId,
                expectedResetRevision,
              },
            },
          );
          if (uploaded.knowledgeObservation) {
            callbacksRef.current.onObservation(uploaded.knowledgeObservation);
          }
        }
        setRefreshToken((value) => value + 1);
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
      <p className="font-medium">本轮补充资料尚未完成，任务尚未派发</p>
      <p className="mt-1 text-xs leading-5 text-amber-900/80">
        {resume
          ? `Dashboard 已保留 ${retainedCount}/${totalCount}，仍缺 ${missingCount} 份资料。可选择缺失资料，也可重新选择全部原文件；已保留文件不会重复上传。`
          : phase === "attention"
            ? "Dashboard 暂时无法核对本轮附件；当前节点和已保存资料不受影响。"
            : "正在核对 Dashboard 已保存的资料，无需重传已完成文件。"}
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
        {phase === "needs_browser" && resume ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            继续补充缺失资料
          </Button>
        ) : (
          <span className="inline-flex items-center text-xs">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {phase === "dispatching"
              ? "正在继续原任务"
              : phase === "uploading"
                ? "正在保存缺失资料"
                : "正在恢复本轮"}
          </span>
        )}
        {phase === "attention" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            重新检查服务器副本
          </Button>
        )}
        <Button
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
        </Button>
      </div>
    </div>
  );
}
