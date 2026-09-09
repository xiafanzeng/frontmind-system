import { useEffect, useRef, useState } from "react";
import { ImageIcon, Pencil, Loader2, Upload, X, Undo2 } from "lucide-react";
import { toast } from "sonner";
import {
  captureWorkspaceRestOperation,
  type WorkspaceRestOperation,
} from "@/lib/workspace-rest-scope";
import { useConversation } from "@/contexts/ConversationContext";
import { useWorkspaceDraftGuard } from "@/lib/workspace-navigation-guard";
import {
  assertChatAttachmentSizes,
  normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType,
} from "@/lib/attachment-files";
import {
  cancelKnowledgeBaseTurnAttachments,
  createKnowledgeBaseTurnTask,
  reserveKnowledgeBaseTurnWithAttachments,
  stageKnowledgeBaseTurnAttachment,
  uploadKnowledgeBaseLocalAsset,
  type KnowledgeBaseAttachmentManifestItem,
} from "@/lib/frontmind-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { KnowledgeBaseObservationDto } from "@shared/knowledge-base-progress";
import type { KnowledgeNodeDetailsDto } from "@shared/knowledge-node-workspace";

type Library = {
  coordinates: {
    conversationId: string;
    expectedGeneration: number;
    expectedRevision: number;
    expectedStateEpoch: number;
    expectedContentVersion: number;
    expectedLeafId: string;
  };
  images: Array<{
    assetId: string;
    url: string;
    caption: string;
    attached: boolean;
    removable: boolean;
    selectable: boolean;
  }>;
};
type PendingImage = { id: string; file: File; previewUrl: string };
type ImageAttempt = {
  requestId: string;
  selectRequestId: string;
  library: Library;
  resetRevision: number;
  files: PendingImage[];
  manifest: KnowledgeBaseAttachmentManifestItem[];
  removeAssetIds: string[];
  selection?: KnowledgeBaseObservationDto;
  reservation?: { turnId: string; sourceResetRevision: number };
  receipts: Map<
    number,
    Awaited<ReturnType<typeof uploadKnowledgeBaseLocalAsset>>
  >;
  staged: Set<number>;
  reserveSent?: boolean;
  dispatchSent?: boolean;
  failedTerminal?: boolean;
  definiteRejection?: boolean;
};
const imageMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
];
async function localRequest(
  rest: WorkspaceRestOperation,
  path: string,
  body?: unknown,
) {
  const response = await rest.fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  rest.assertActive();
  if (!response.ok)
    throw Object.assign(
      new Error(result.error?.message ?? "节点状态已变化，请刷新后重试"),
      {
        status: response.status,
        code: result.error?.code,
        knowledgeObservation: result.observation,
      },
    );
  return result;
}

export interface KnowledgeNodeLocalActionsProps {
  conversationId: string;
  leafId: string;
  resetRevision?: number;
  disabled?: boolean;
  editDisabled?: boolean;
  imagesDisabled?: boolean;
  editLabel?: string;
  onEditTargetSelected?: () => void;
  onImagesSaved?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}
export default function KnowledgeNodeLocalActions(
  props: KnowledgeNodeLocalActionsProps,
) {
  return (
    <KnowledgeNodeLocalActionsInner
      key={`${props.conversationId}:${props.leafId}:${props.resetRevision ?? "legacy"}`}
      {...props}
    />
  );
}
function KnowledgeNodeLocalActionsInner({
  conversationId,
  leafId,
  resetRevision,
  disabled = false,
  editDisabled = false,
  imagesDisabled = false,
  editLabel = "AI 修改",
  onEditTargetSelected,
  onImagesSaved,
  onBusyChange,
  onDirtyChange,
}: KnowledgeNodeLocalActionsProps) {
  const {
    commitKnowledgeBaseObservation,
    refreshConversations,
    wakeKnowledgeBaseConversation,
  } = useConversation();
  const lifetime = useRef(new AbortController());
  const busyRef = useRef(false);
  const callbacks = useRef({ onBusyChange, onDirtyChange, onImagesSaved });
  callbacks.current = { onBusyChange, onDirtyChange, onImagesSaved };
  const fileInput = useRef<HTMLInputElement>(null);
  const imageButton = useRef<HTMLButtonElement>(null);
  const previewUrls = useRef(new Set<string>());
  const attempt = useRef<ImageAttempt | null>(null);
  const imageScope = useRef<WorkspaceRestOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryResetRevision, setLibraryResetRevision] = useState<
    number | null
  >(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [attemptStarted, setAttemptStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const imageDirty = pendingImages.length > 0 || removed.size > 0;
  useEffect(() => {
    if (lifetime.current.signal.aborted)
      lifetime.current = new AbortController();
    const mountedLifetime = lifetime.current;
    return () => {
      mountedLifetime.abort();
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
      callbacks.current.onBusyChange?.(false);
      callbacks.current.onDirtyChange?.(false);
    };
  }, []);
  useEffect(() => {
    callbacks.current.onDirtyChange?.(imageDirty);
  }, [imageDirty]);
  const beginOperation = (resume = false, imageOperation = false) => {
    if (busyRef.current || (disabled && !resume)) return null;
    const signal = imageOperation
      ? (imageScope.current?.signal ?? lifetime.current.signal)
      : lifetime.current.signal;
    if (signal.aborted) return null;
    const rest = captureWorkspaceRestOperation(signal);
    if (rest.signal.aborted) return null;
    busyRef.current = true;
    setBusy(true);
    callbacks.current.onBusyChange?.(true);
    return rest;
  };
  const finishOperation = (rest: WorkspaceRestOperation) => {
    if (rest.signal.aborted) return;
    busyRef.current = false;
    setBusy(false);
    callbacks.current.onBusyChange?.(false);
  };
  const readLibrary = async (rest: WorkspaceRestOperation) =>
    localRequest(
      rest,
      `/api/knowledge-base/node/images?${new URLSearchParams({ conversationId, leafId })}`,
    ) as Promise<Library>;
  const commit = async (
    rest: WorkspaceRestOperation,
    observation?: KnowledgeBaseObservationDto,
  ) => {
    rest.assertActive();
    if (observation)
      commitKnowledgeBaseObservation(conversationId, observation);
    await refreshConversations();
    rest.assertActive();
    window.dispatchEvent(
      new CustomEvent("frontmind:knowledge-progress-updated"),
    );
  };
  const selectNode = async (
    rest: WorkspaceRestOperation,
    data: Library,
    clientRequestId: string,
  ) => {
    const result = await localRequest(rest, "/api/knowledge-base/node/select", {
      ...data.coordinates,
      leafId,
      clientRequestId,
    });
    rest.assertActive();
    if (
      !result.observation ||
      result.observation.generation !== data.coordinates.expectedGeneration
    )
      throw new Error("节点版本已变化，请重新读取后再修改");
    return result.observation as KnowledgeBaseObservationDto;
  };
  const edit = async () => {
    if (editDisabled) return;
    const rest = beginOperation();
    if (!rest) return;
    try {
      await commit(
        rest,
        await selectNode(rest, await readLibrary(rest), crypto.randomUUID()),
      );
      onEditTargetSelected?.();
      toast.success("已选择该节点，请填写本次修改要求");
    } catch (error) {
      if (!rest.signal.aborted)
        toast.error(error instanceof Error ? error.message : "无法选择节点");
    } finally {
      finishOperation(rest);
    }
  };
  const clearDraft = () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    setPendingImages([]);
    setRemoved(new Set());
    attempt.current = null;
    imageScope.current = null;
    setAttemptStarted(false);
    setError(null);
    setProgress(null);
    setLibrary(null);
  };
  const openLibrary = async () => {
    if (imagesDisabled) return;
    const rest = beginOperation();
    if (!rest) return;
    try {
      const data = await readLibrary(rest);
      let currentResetRevision = resetRevision;
      if (currentResetRevision === undefined) {
        const details = (await localRequest(
          rest,
          `/api/knowledge-base/node/content?${new URLSearchParams({
            conversationId,
            leafId,
            expectedGeneration: String(data.coordinates.expectedGeneration),
            expectedContentVersion: String(
              data.coordinates.expectedContentVersion,
            ),
          })}`,
        )) as KnowledgeNodeDetailsDto;
        currentResetRevision = details.coordinates.resetRevision;
      }
      if (
        !Number.isSafeInteger(currentResetRevision) ||
        currentResetRevision! < 0
      )
        throw new Error("知识库状态已变化，请刷新后重试");
      setLibraryResetRevision(currentResetRevision!);
      imageScope.current = rest;
      setLibrary({
        ...data,
        images: data.images.filter((image) => image.attached),
      });
      setError(null);
    } catch (error) {
      if (!rest.signal.aborted)
        toast.error(error instanceof Error ? error.message : "图片加载失败");
    } finally {
      finishOperation(rest);
    }
  };
  const addFiles = (files: File[]) => {
    if (busy || attemptStarted || disabled || imagesDisabled || !files.length)
      return;
    try {
      assertChatAttachmentSizes(files);
      if (
        files.some(
          (file) =>
            !imageMimeTypes.includes(
              normalizedKnowledgeBaseUploadMimeType(file),
            ),
        )
      )
        throw new Error("请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片");
      const additions = files.map((file) => {
        const previewUrl = URL.createObjectURL(file);
        previewUrls.current.add(previewUrl);
        return { id: crypto.randomUUID(), file, previewUrl };
      });
      setPendingImages((current) => [...current, ...additions]);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "图片无法读取");
    }
  };
  const ensureReservation = async (
    rest: WorkspaceRestOperation,
    current: ImageAttempt,
  ) => {
    if (current.reservation) return current.reservation;
    const observation = current.selection!;
    current.reserveSent = true;
    const result = await reserveKnowledgeBaseTurnWithAttachments(
      [],
      {
        conversationId,
        clientRequestId: current.requestId,
        expectedResetRevision: current.resetRevision,
        expectedGeneration: observation.generation,
        expectedRevision: observation.interaction.progress!.build.revision,
        expectedLeafId: leafId,
        expectedPresentationKey:
          observation.approvedPresentation?.presentationKey,
        attachmentManifest: current.manifest,
        removeAssetIds: current.removeAssetIds,
      },
      rest.signal,
    );
    rest.assertActive();
    current.reservation = result.reservation;
    if (result.knowledgeObservation)
      commitKnowledgeBaseObservation(
        conversationId,
        result.knowledgeObservation,
      );
    return current.reservation;
  };
  const saveImages = async (): Promise<boolean> => {
    if (
      !library ||
      libraryResetRevision === null ||
      (!attempt.current && (imagesDisabled || disabled))
    )
      return false;
    if (!imageDirty) {
      clearDraft();
      return true;
    }
    const rest = beginOperation(Boolean(attempt.current), true);
    if (!rest) return false;
    try {
      setError(null);
      if (!attempt.current) {
        const requestId = crypto.randomUUID();
        attempt.current = {
          requestId,
          selectRequestId: crypto.randomUUID(),
          library,
          resetRevision: libraryResetRevision,
          files: [...pendingImages],
          removeAssetIds: [...removed],
          receipts: new Map(),
          staged: new Set(),
          manifest: pendingImages.map(({ file }, index) => ({
            filename: normalizedKnowledgeBaseUploadFilename(file.name),
            mimeType: normalizedKnowledgeBaseUploadMimeType(file),
            sizeBytes: file.size,
            lastModified: Math.max(0, Number(file.lastModified || 0)),
            itemId: `${requestId}:${index + 1}`,
            ordinal: index + 1,
            total: pendingImages.length,
          })),
        };
        setAttemptStarted(true);
      }
      const current = attempt.current;
      if (!current.selection) {
        setProgress("正在确认节点…");
        current.selection = await selectNode(
          rest,
          current.library,
          current.selectRequestId,
        );
        rest.assertActive();
        commitKnowledgeBaseObservation(conversationId, current.selection);
      }
      let result: {
        knowledgeObservation?: KnowledgeBaseObservationDto;
        observation?: KnowledgeBaseObservationDto;
        status?: string;
      };
      if (current.files.length) {
        const reservation = await ensureReservation(rest, current);
        for (let index = 0; index < current.files.length; index++) {
          if (current.staged.has(index)) continue;
          const item = current.manifest[index]!;
          let receipt = current.receipts.get(index);
          if (!receipt) {
            receipt = await uploadKnowledgeBaseLocalAsset(
              current.files[index]!.file,
              (percent) => {
                if (!rest.signal.aborted)
                  setProgress(
                    `正在上传图片 ${index + 1}/${current.files.length} · ${percent}%`,
                  );
              },
              { maxRetries: 2, initialDelay: 1000, maxDelay: 3000 },
              {
                signal: rest.signal,
                captureFilename: item.filename,
                itemId: item.itemId,
                batchId: current.requestId,
                batchOrdinal: index + 1,
                batchTotal: current.files.length,
                resumeScope: {
                  kind: "knowledge_base",
                  operationType: "revise",
                  conversationId,
                  turnId: reservation.turnId,
                  clientRequestId: current.requestId,
                  expectedResetRevision: reservation.sourceResetRevision,
                },
              },
            );
            rest.assertActive();
            current.receipts.set(index, receipt);
          }
          if (!receipt.alreadyStaged)
            await stageKnowledgeBaseTurnAttachment({
              conversationId,
              turnId: reservation.turnId,
              clientRequestId: current.requestId,
              expectedResetRevision: reservation.sourceResetRevision,
              attachmentManifest: current.manifest,
              index,
              attachment: {
                file_id: receipt.fileId,
                filename: receipt.filename,
              },
              signal: rest.signal,
            });
          rest.assertActive();
          current.staged.add(index);
        }
        setProgress("正在保存图片…");
        current.dispatchSent = true;
        result = await createKnowledgeBaseTurnTask(
          [],
          {
            conversationId,
            clientRequestId: current.requestId,
            expectedResetRevision: reservation.sourceResetRevision,
            attachmentReservation: {
              turnId: reservation.turnId,
              attachmentManifest: current.manifest,
            },
          },
          rest.signal,
        );
      } else {
        setProgress("正在保存图片…");
        current.dispatchSent = true;
        result = await localRequest(rest, "/api/knowledge-base/turn", {
          conversationId,
          clientRequestId: current.requestId,
          userMessage: "",
          attachments: [],
          removeAssetIds: current.removeAssetIds,
          selectedAssetIds: [],
          expectedGeneration: current.selection.generation,
          expectedRevision:
            current.selection.interaction.progress!.build.revision,
          expectedLeafId: leafId,
          expectedPresentationKey:
            current.selection.approvedPresentation?.presentationKey,
        });
      }
      rest.assertActive();
      if (result.status === "error" || result.status === "failed") {
        current.failedTerminal = true;
        throw new Error(
          "图片修改未保存，原有图片保持不变。请放弃本次修改后重新选择。",
        );
      }
      await commit(rest, result.knowledgeObservation ?? result.observation);
      wakeKnowledgeBaseConversation(conversationId);
      callbacks.current.onImagesSaved?.();
      clearDraft();
      toast.success("图片修改已提交，保存完成后会自动更新");
      return true;
    } catch (error) {
      if (!rest.signal.aborted) {
        const failure = error as {
          status?: number;
          code?: string;
          knowledgeObservation?: KnowledgeBaseObservationDto;
        };
        if (
          attempt.current &&
          [400, 401, 403, 404, 409, 410, 422].includes(failure.status ?? 0) &&
          !/IDEMPOTENCY_PENDING|OUTCOME_UNKNOWN/.test(failure.code ?? "")
        ) {
          attempt.current.definiteRejection = true;
          attempt.current.dispatchSent = false;
        }
        if (failure.knowledgeObservation)
          commitKnowledgeBaseObservation(
            conversationId,
            failure.knowledgeObservation,
          );
        const message =
          error instanceof Error ? error.message : "图片保存失败，请重试";
        setError(message);
        setProgress(null);
        toast.error(message);
      }
      return false;
    } finally {
      finishOperation(rest);
    }
  };
  const discard = async (): Promise<boolean> => {
    const current = attempt.current;
    if (busyRef.current || (current?.dispatchSent && !current.failedTerminal))
      return false;
    if (
      !current?.reserveSent ||
      current.failedTerminal ||
      (current.definiteRejection && !current.reservation)
    ) {
      clearDraft();
      return true;
    }
    const rest = beginOperation(true, true);
    if (!rest) return false;
    try {
      const reservation = await ensureReservation(rest, current);
      const result = await cancelKnowledgeBaseTurnAttachments(
        {
          conversationId,
          turnId: reservation.turnId,
          clientRequestId: current.requestId,
          expectedResetRevision: reservation.sourceResetRevision,
        },
        rest.signal,
      );
      await commit(rest, result.knowledgeObservation);
      clearDraft();
      return true;
    } catch (error) {
      if (!rest.signal.aborted) {
        const observation = (
          error as { knowledgeObservation?: KnowledgeBaseObservationDto }
        ).knowledgeObservation;
        if (
          observation &&
          Object.prototype.hasOwnProperty.call(observation, "activeTurn") &&
          (!observation.activeTurn ||
            observation.activeTurn.id !== current.reservation?.turnId ||
            ["failed", "cancelled", "completed"].includes(
              observation.activeTurn.status,
            ))
        ) {
          await commit(rest, observation);
          clearDraft();
          return true;
        }
        setError(
          error instanceof Error
            ? error.message
            : "暂时无法放弃本次修改，请重试",
        );
      }
      return false;
    } finally {
      finishOperation(rest);
    }
  };
  useWorkspaceDraftGuard({
    dirty: imageDirty,
    label: "知识节点图片",
    save: saveImages,
    discard,
  });
  const controlsDisabled = busy || disabled || imagesDisabled || attemptStarted;
  const attached = library?.images ?? [];
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void edit()}
          disabled={disabled || editDisabled || busy}
        >
          <Pencil className="mr-1 h-3.5 w-3.5" />
          {editLabel}
        </Button>
        <Button
          ref={imageButton}
          size="sm"
          variant="outline"
          onClick={() => void openLibrary()}
          disabled={disabled || imagesDisabled || busy}
        >
          <ImageIcon className="mr-1 h-3.5 w-3.5" />
          图片管理
        </Button>
      </div>
      <Dialog
        open={Boolean(library)}
        onOpenChange={(open) => {
          if (!open && !busy && !imageDirty) clearDraft();
        }}
      >
        <DialogContent
          className="max-w-2xl"
          onCloseAutoFocus={(event) => {
            if (imageButton.current && !imageButton.current.disabled) {
              event.preventDefault();
              imageButton.current.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>当前节点的图片</DialogTitle>
            <DialogDescription>
              上传或移除当前节点的图片，点击“保存图片”后生效。
            </DialogDescription>
          </DialogHeader>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={imageMimeTypes.join(",")}
            className="sr-only"
            aria-label="上传当前节点图片"
            disabled={controlsDisabled}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              已附 {attached.length} 张
              {pendingImages.length ? ` · 新增 ${pendingImages.length} 张` : ""}
            </p>
            <Button
              variant="outline"
              onClick={() => fileInput.current?.click()}
              disabled={controlsDisabled}
            >
              <Upload className="h-4 w-4" />
              上传图片
            </Button>
          </div>
          <div className="grid max-h-[48vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
            {attached.map((item) => (
              <figure
                key={item.assetId}
                className={`min-w-0 rounded-xl border p-2 ${removed.has(item.assetId) ? "border-dashed border-slate-300 bg-slate-50" : "border-slate-200"}`}
              >
                <img
                  src={item.url}
                  alt={item.caption}
                  className={`h-28 w-full rounded-lg object-contain ${removed.has(item.assetId) ? "opacity-40" : ""}`}
                />
                <figcaption className="mt-2 break-words text-xs text-muted-foreground">
                  {item.caption}
                </figcaption>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 w-full"
                  disabled={controlsDisabled || !item.removable}
                  title={
                    !item.removable
                      ? "此图片由知识库统一维护，暂不可单独移除"
                      : undefined
                  }
                  aria-label={`${removed.has(item.assetId) ? "撤销移除" : "移除"} ${item.caption}`}
                  onClick={() =>
                    setRemoved((old) => {
                      const next = new Set(old);
                      next.has(item.assetId)
                        ? next.delete(item.assetId)
                        : next.add(item.assetId);
                      return next;
                    })
                  }
                >
                  {removed.has(item.assetId) ? (
                    <Undo2 className="h-3.5 w-3.5" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                  {removed.has(item.assetId) ? "撤销移除" : "移除图片"}
                </Button>
              </figure>
            ))}
            {pendingImages.map((item) => (
              <figure
                key={item.id}
                className="min-w-0 rounded-xl border border-violet-300 bg-violet-50/50 p-2"
              >
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  className="h-28 w-full rounded-lg object-contain"
                />
                <figcaption className="mt-2 break-words text-xs text-muted-foreground">
                  {item.file.name} · 待保存
                </figcaption>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 w-full"
                  disabled={controlsDisabled}
                  aria-label={`移除 ${item.file.name}`}
                  onClick={() => {
                    URL.revokeObjectURL(item.previewUrl);
                    previewUrls.current.delete(item.previewUrl);
                    setPendingImages((old) =>
                      old.filter((image) => image.id !== item.id),
                    );
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                  移除图片
                </Button>
              </figure>
            ))}
          </div>
          {!attached.length && !pendingImages.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              当前节点尚未添加图片，点击“上传图片”添加。
            </p>
          )}
          {progress && (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              {progress}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
              {!attempt.current?.failedTerminal && imageDirty
                ? " 所选图片和修改已保留，可重试同一次保存。"
                : ""}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void discard()}
              disabled={
                busy ||
                Boolean(
                  attempt.current?.dispatchSent &&
                    !attempt.current.failedTerminal,
                )
              }
            >
              {imageDirty ? "放弃修改" : "关闭"}
            </Button>
            <Button
              onClick={() => void saveImages()}
              disabled={
                busy ||
                !imageDirty ||
                Boolean(attempt.current?.failedTerminal) ||
                (!attemptStarted && (disabled || imagesDisabled))
              }
            >
              {busy ? "正在保存…" : attemptStarted ? "重试保存" : "保存图片"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
