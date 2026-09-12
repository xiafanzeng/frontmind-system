import { activateWorkspaceUploadScope, captureWorkspaceRestOperation, forkWorkspaceRestOperation, type WorkspaceRestOperation } from "./workspace-rest-scope";
import { getKnowledgeBaseUploadStatus, controlKnowledgeBaseUpload, reserveKnowledgeBaseStart, reserveKnowledgeBaseTurnWithAttachments, uploadKnowledgeBaseLocalAsset, stageKnowledgeBaseTurnAttachment, createKnowledgeBaseTurnTask, resumeKnowledgeBaseTurnAttachments, uploadStatusToAttachmentResume, type KnowledgeBaseAttachmentManifestItem, type KnowledgeBaseAttachmentTurnReservation, type TaskResponse, type Message, type FileUploadStageEvent, type KnowledgeBaseUploadStatus, type KnowledgeBaseTurnAttachmentCoordinate } from "./frontmind-api";
import type { KnowledgeBaseObservationDto } from "./knowledge-progress";
import { waitForKnowledgeBaseReply } from "./knowledge-base-reply";
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from "react";

type UploadReceipt = Awaited<ReturnType<typeof uploadKnowledgeBaseLocalAsset>>;
export type KnowledgeBaseUploadCommand = {
  kind: "start" | "revise" | "reselect";
  conversationId: string; clientRequestId: string; expectedResetRevision: number;
  turnId?: string; uploadAttemptId?: string;
  companyName?: string; companyWebsite?: string; operatorNotes?: string;
  expectedGeneration?: number; expectedRevision?: number; expectedLeafId?: string; expectedPresentationKey?: string;
  input?: Message[];
  manifest: KnowledgeBaseAttachmentManifestItem[];
  files: Array<{ file: File; itemId: string; ordinal: number }>;
  onReservation?: (result: { reservation: KnowledgeBaseAttachmentTurnReservation; knowledgeObservation?: KnowledgeBaseObservationDto }) => void;
  onObservation?: (observation: KnowledgeBaseObservationDto) => void;
  onPhase?: (phase: "reserved" | "uploading" | "staging" | "dispatching") => void;
  onFile?: (itemId: string, file: File, event: Omit<FileUploadStageEvent, "receipt" | "stage"> & { stage: FileUploadStageEvent["stage"] | "failed"; receipt?: UploadReceipt; error?: string; retryable?: boolean }) => void;
};
export function formatKnowledgeBaseUploadBytes(bytes: number) {
  if (bytes < 1_000) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
export type KnowledgeBaseUploadResult = { reservation: KnowledgeBaseAttachmentTurnReservation; knowledgeObservation?: KnowledgeBaseObservationDto; receipts: Map<string, UploadReceipt>; response: TaskResponse };

/** One batch belongs to one project/conversation/reset revision, never a page. */
export class KnowledgeBaseUploadBatch {
  private values = new Map<string, unknown>();
  private listeners = new Set<() => void>();
  private readonly refs = new Map<string, { current: unknown }>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeat?: (status: "active" | "cancelled") => void;
  controller: AbortController | null = null;
  disposed = false;
  private readonly scope: WorkspaceRestOperation;
  private coordinate?: KnowledgeBaseTurnAttachmentCoordinate;
  private statusRequest?: Promise<KnowledgeBaseUploadStatus>;
  private statusController?: AbortController;
  private dispatchRequest?: Promise<unknown>;
  private submission?: Promise<KnowledgeBaseUploadResult>;
  private reservedResult?: { reservation: KnowledgeBaseAttachmentTurnReservation; knowledgeObservation?: KnowledgeBaseObservationDto };
  private receipts = new Map<string, UploadReceipt>();
  private staged = new Set<string>();
  private controlRequest?: Promise<KnowledgeBaseUploadStatus | undefined>;
  private lastCheckProgressAt = 0;
  private stopRequested = false;
  private readonly lifetime = new AbortController();
  private logicalKey?: string;
  private completed?: KnowledgeBaseUploadResult;
  private dispatchNeedsCheck = false;
  private dispatchEpoch = 0;
  constructor(readonly key: string) {
    // This happens when the batch is created, before reservation can yield.
    this.scope = captureWorkspaceRestOperation(this.lifetime.signal, undefined, { detached: true });
  }
  get reservationSignal() { return this.scope.signal; }
  operation(signal: AbortSignal) { return forkWorkspaceRestOperation(this.scope, signal); }
  beginAttempt() {
    if (this.disposed || this.controller) throw new Error("本批资料已有上传正在执行");
    this.scope.assertActive();
    const controller = new AbortController();
    this.controller = controller;
    this.write("lastProgressAt", Date.now());
    return { controller, operation: this.operation(controller.signal) };
  }
  finishAttempt(controller: AbortController) {
    if (this.controller !== controller) return;
    this.endHeartbeat();
    this.controller = null;
  }
  /** Data-only command shared by initial, supplement and file-reselection entry points. */
  submit(incoming: KnowledgeBaseUploadCommand): Promise<KnowledgeBaseUploadResult> {
    const logicalKey = JSON.stringify([incoming.conversationId, incoming.expectedResetRevision, incoming.clientRequestId]);
    if (this.logicalKey !== logicalKey) {
      if (this.submission || (this.logicalKey && !this.completed)) return Promise.reject(new Error("请先完成或明确放弃当前资料批次"));
      this.endHeartbeat();
      this.invalidateStatusRequest();
      this.logicalKey = logicalKey;
      this.completed = undefined; this.reservedResult = undefined; this.coordinate = undefined;
      this.receipts.clear(); this.staged.clear(); this.dispatchRequest = undefined; this.dispatchNeedsCheck = false; this.controlRequest = undefined;
      this.stopRequested = false; this.lastCheckProgressAt = 0;
      this.dispatchEpoch++;
      this.write("uploadStatus", null); this.write("fileStates", new Map()); this.write("stopState", "active");
    }
    if (this.submission) return this.submission;
    if (this.completed) return Promise.resolve(this.completed);
    const command = Object.freeze({ ...incoming, manifest: incoming.manifest.map(item => Object.freeze({ ...item })), files: incoming.files.map(item => Object.freeze({ ...item })) });
    this.write("manifest", command.manifest);
    const run = async () => {
      const operation = this.controller ? this.operation(this.controller.signal) : this.scope;
      const base = { conversationId: command.conversationId, clientRequestId: command.clientRequestId, expectedResetRevision: command.expectedResetRevision };
      const restored = !this.reservedResult && Boolean(command.turnId);
      if (!this.reservedResult) {
        if (command.turnId) {
          this.reservedResult = { reservation: { turnId: command.turnId, uploadAttemptId: command.uploadAttemptId, sourceResetRevision: command.expectedResetRevision, clientRequestId: command.clientRequestId, generation: command.expectedGeneration ?? 0, revision: command.expectedRevision ?? 0, leafId: command.expectedLeafId ?? null, state: "awaiting_attachments", stagedAttachmentCount: 0, expectedAttachmentCount: command.manifest.length, requiresUpload: true } };
          this.bindCoordinate({ ...base, turnId: command.turnId, uploadAttemptId: command.uploadAttemptId });
        } else {
          this.reservedResult = await this.reserve(base, () => waitForKnowledgeBaseReply({ signal: this.reservationSignal,
            request: signal => command.kind === "start"
              ? reserveKnowledgeBaseStart({ ...base, companyName: command.companyName ?? "", companyWebsite: command.companyWebsite, operatorNotes: command.operatorNotes, attachmentManifest: command.manifest }, signal)
              : reserveKnowledgeBaseTurnWithAttachments(command.input ?? [], { ...base, expectedGeneration: command.expectedGeneration!, expectedRevision: command.expectedRevision!, expectedLeafId: command.expectedLeafId!, expectedPresentationKey: command.expectedPresentationKey, attachmentManifest: command.manifest }, signal),
            reconcile: signal => this.findReservation(command, signal),
          }));
        }
      }
      operation.assertActive();
      if (this.stopRequested) throw new DOMException("上传已停止", "AbortError");
      const reserved = this.reservedResult;
      this.startHeartbeat({ ...base, turnId: reserved.reservation.turnId, uploadAttemptId: this.coordinate?.uploadAttemptId ?? reserved.reservation.uploadAttemptId });
      if (restored || reserved.reservation.state !== "awaiting_attachments" || reserved.reservation.stagedAttachmentCount > 0) await this.checkStatus();
      // A status check or explicit resume can replace the upload attempt.
      // Capture its current value only when each request is actually sent.
      const coordinate = () => ({ ...base, turnId: reserved.reservation.turnId, uploadAttemptId: this.coordinate?.uploadAttemptId });
      reserved.reservation = { ...reserved.reservation, uploadAttemptId: coordinate().uploadAttemptId };
      const currentStatus = this.read<KnowledgeBaseUploadStatus | null>("uploadStatus", null);
      if (currentStatus) reserved.knowledgeObservation = currentStatus.knowledgeObservation;
      command.onReservation?.(reserved);
      if (reserved.knowledgeObservation) { this.write("observation", reserved.knowledgeObservation); command.onObservation?.(reserved.knowledgeObservation); }
      const emitFile: NonNullable<KnowledgeBaseUploadCommand["onFile"]> = (itemId, file, event) => {
        if (operation.signal.aborted) return;
        this.write<Map<string, unknown>>("fileStates", old => new Map(old ?? []).set(itemId, { ...(old?.get(itemId) as object ?? {}), ...event, totalBytes: file.size }));
        this.write("progress", this.progress());
        command.onFile?.(itemId, file, event);
      };
      // Manifest consistency is a pure data check; validate it up front so the
      // pipeline below never has to throw mid-prefetch.
      const manifestByItem = new Map(command.files.map(item => {
        const manifest = command.manifest.find(candidate => candidate.itemId === item.itemId);
        if (!manifest || manifest.ordinal !== item.ordinal || manifest.sizeBytes !== item.file.size) throw new Error("资料与本轮清单不一致，请重新选择原文件");
        return [item.itemId, manifest] as const;
      }));
      // One-ahead prefetch: file N+1's byte transfer overlaps file N's staging
      // confirmation. Staging itself stays strictly in manifest order, and the
      // slot promise never rejects, so an abandoned prefetch cannot surface as
      // an unhandled rejection.
      type UploadSlot = { item: (typeof command.files)[number]; settled: Promise<void>; receipt?: UploadReceipt; error?: unknown };
      let nextUploadIndex = 0;
      let uploadSlot: UploadSlot | null = null;
      // Closure writes defeat control-flow narrowing; read through a typed accessor.
      const activeUploadSlot = (): UploadSlot | null => uploadSlot;
      const uploadOne = (item: (typeof command.files)[number]) => {
        command.onPhase?.("uploading");
        let transferAttempt = 1;
        const manifest = manifestByItem.get(item.itemId)!;
        return uploadKnowledgeBaseLocalAsset(item.file, percent => {
          if (operation.signal.aborted || this.staged.has(item.itemId)) return;
          const loadedBytes = item.file.size * percent / 100;
          this.noteTransfer(item.itemId, loadedBytes, transferAttempt);
          emitFile(item.itemId, item.file, { stage: "uploading_to_dashboard", loadedBytes, totalBytes: item.file.size });
        }, { maxRetries: 2, initialDelay: 1_000, maxDelay: 3_000 }, {
          signal: operation.signal, captureLocalCopy: true, captureFilename: manifest.filename, batchId: command.clientRequestId, batchOrdinal: item.ordinal, batchTotal: command.manifest.length, itemId: item.itemId,
          ...(manifest.sha256 ? { contentSha256: manifest.sha256 } : {}),
          resumeScope: { kind: "knowledge_base", operationType: command.kind === "start" ? "start" : "revise", ...coordinate() },
          onStage: event => {
            if (operation.signal.aborted || this.staged.has(item.itemId)) return;
            transferAttempt = event.attempt ?? transferAttempt;
            if (event.loadedBytes !== undefined) this.noteTransfer(item.itemId, event.loadedBytes, event.attempt ?? 1);
            emitFile(item.itemId, item.file, { ...event, stage: event.stage === "uploaded" ? "server_processing" : event.stage, receipt: undefined });
          },
        });
      };
      const startNextUpload = () => {
        // One live prefetch at a time: a slot awaiting its consumer stays
        // put even when an already-receipted file triggers another start.
        if (uploadSlot) return;
        while (nextUploadIndex < command.files.length) {
          const item = command.files[nextUploadIndex++];
          if (this.receipts.get(item.itemId) || this.staged.has(item.itemId)) continue;
          const slot: UploadSlot = { item, settled: Promise.resolve() };
          slot.settled = uploadOne(item).then(receipt => {
            operation.assertActive();
            slot.receipt = { ...receipt, filename: manifestByItem.get(item.itemId)!.filename };
            this.receipts.set(item.itemId, slot.receipt);
          }).catch(error => {
            emitFile(item.itemId, item.file, { stage: "failed", error: error instanceof Error ? error.message : "资料上传失败", retryable: (error as {retryable?: boolean}).retryable });
            slot.error = error;
          });
          uploadSlot = slot;
          return;
        }
        uploadSlot = null;
      };
      startNextUpload();
      for (const item of command.files) {
        operation.assertActive();
        let receipt = this.receipts.get(item.itemId);
        if (this.staged.has(item.itemId) && !receipt) continue;
        if (!receipt) {
          const slot = activeUploadSlot();
          if (slot?.item === item) {
            uploadSlot = null;
            await slot.settled;
            operation.assertActive();
            if (slot.error) throw slot.error;
            receipt = slot.receipt;
          } else {
            // No live prefetch for this file (e.g. retry after a resume).
            command.onPhase?.("uploading");
            try {
              receipt = await uploadOne(item);
              operation.assertActive();
              receipt = { ...receipt, filename: manifestByItem.get(item.itemId)!.filename };
              this.receipts.set(item.itemId, receipt);
            } catch (error) {
              emitFile(item.itemId, item.file, { stage: "failed", error: error instanceof Error ? error.message : "资料上传失败", retryable: (error as {retryable?: boolean}).retryable });
              throw error;
            }
          }
          if (!receipt) throw new Error("资料上传失败");
        }
        if (!this.staged.has(item.itemId) && !receipt.alreadyStaged) {
          command.onPhase?.("staging");
          startNextUpload();
          const savedReceipt = receipt;
          await waitForKnowledgeBaseReply({ signal: operation.signal,
            request: signal => stageKnowledgeBaseTurnAttachment({ ...coordinate(), attachmentManifest: command.manifest, index: item.ordinal - 1, attachment: { file_id: savedReceipt.fileId, filename: savedReceipt.filename }, signal }),
            reconcile: async () => {
              const status = await this.checkStatus("auto");
              return status.files.some(file => file.itemId === item.itemId && file.status === "confirmed") ? { staged: true } : undefined;
            },
          });
        } else {
          startNextUpload();
        }
        operation.assertActive();
        this.staged.add(item.itemId);
        this.write("lastBusinessProgressAt", Date.now());
        emitFile(item.itemId, item.file, { stage: "uploaded", loadedBytes: item.file.size, totalBytes: item.file.size, receipt });
        if (receipt.knowledgeObservation) command.onObservation?.(receipt.knowledgeObservation);
      }
      if (this.staged.size < command.manifest.length) throw Object.assign(new Error("仍有资料未确认，请继续选择缺失的原文件"), { code: "KB_ATTACHMENTS_INCOMPLETE" });
      if (this.read<KnowledgeBaseUploadStatus | null>("uploadStatus", null)) await this.checkStatus();
      command.onPhase?.("dispatching");
      const attachments = command.files.flatMap(item => { const receipt = this.receipts.get(item.itemId); return receipt?.fileId ? [{ type: "input_file" as const, file_id: receipt.fileId, filename: receipt.filename, mime_type: item.file.type || "application/octet-stream" }] : []; });
      const input: Message[] = command.input?.length ? command.input.map((message, index) => index === command.input!.length - 1 ? { ...message, content: [...(typeof message.content === "string" ? [{ type: "input_text" as const, text: message.content }] : message.content), ...attachments] } : message) : [];
      const response = await this.dispatch(() => waitForKnowledgeBaseReply({ signal: operation.signal,
        request: signal => createKnowledgeBaseTurnTask(input, { ...base, attachmentReservation: { turnId: coordinate().turnId, uploadAttemptId: coordinate().uploadAttemptId, ...(command.kind === "revise" ? { sourceResetRevision: command.expectedResetRevision } : {}), attachmentManifest: command.manifest } }, signal),
        reconcile: async () => this.dispatchedResponse(await this.checkStatus("auto")),
      }));
      if (response.knowledgeObservation) { this.write("observation", response.knowledgeObservation); command.onObservation?.(response.knowledgeObservation); }
      const result = { ...reserved, receipts: new Map(this.receipts), response };
      // Keep the final receipt for idempotent callers, without retaining browser Files.
      this.completed = { ...result, receipts: new Map() };
      this.receipts.clear(); this.reservedResult = undefined; this.dispatchRequest = undefined;
      this.write("fileItems", []); this.endHeartbeat();
      return result;
    };
    this.submission = run().finally(() => { this.submission = undefined; });
    return this.submission;
  }
  private async findReservation(command: KnowledgeBaseUploadCommand, signal: AbortSignal) {
    const operation = this.operation(signal);
    const status = await getKnowledgeBaseUploadStatus({ conversationId: command.conversationId, clientRequestId: command.clientRequestId, expectedResetRevision: command.expectedResetRevision }, operation.signal);
    operation.assertActive();
    if (!status.reservation) return undefined;
    if (!this.coordinate) this.bindCoordinate({ conversationId: command.conversationId, clientRequestId: command.clientRequestId, expectedResetRevision: command.expectedResetRevision, turnId: status.turnId, uploadAttemptId: status.uploadAttemptId ?? undefined });
    const accepted = this.acceptStatus(status);
    return { reservation: { ...(accepted.reservation ?? status.reservation), uploadAttemptId: accepted.uploadAttemptId ?? undefined }, knowledgeObservation: accepted.knowledgeObservation };
  }
  async reserve<T extends { reservation: { turnId: string; uploadAttemptId?: string } }>(
    coordinate: Omit<KnowledgeBaseTurnAttachmentCoordinate, "turnId">,
    reserve: () => Promise<T>,
  ): Promise<T> {
    const result = await reserve();
    this.scope.assertActive();
    this.coordinate = { ...coordinate, turnId: result.reservation.turnId, uploadAttemptId: result.reservation.uploadAttemptId };
    this.write("coordinate", this.coordinate);
    // Stopping before the reserve response still fences the returned turn.
    if (this.stopRequested) {
      await this.persistStop();
      throw new DOMException("上传已停止", "AbortError");
    }
    this.startHeartbeat(this.coordinate);
    return result;
  }
  bindCoordinate(coordinate: KnowledgeBaseTurnAttachmentCoordinate) {
    this.coordinate = { ...coordinate };
    this.write("coordinate", this.coordinate);
  }
  async checkStatus(source: "auto" | "user" = "user"): Promise<KnowledgeBaseUploadStatus> {
    if (this.statusRequest) return this.statusRequest;
    if (!this.coordinate) throw new Error("正在等待本批资料预约确认");
    const coordinate = { ...this.coordinate };
    const dispatchEpoch = this.dispatchEpoch;
    this.write("checking", true);
    const controller = new AbortController();
    this.statusController = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException("状态检查超时，请检查并继续", "TimeoutError")), 10_000);
    const operation = this.operation(controller.signal);
    const request = waitForKnowledgeBaseReply({ signal: operation.signal, timeoutMs: 10_000, request: signal => getKnowledgeBaseUploadStatus(coordinate, signal) }).then(status => {
      if (dispatchEpoch !== this.dispatchEpoch) throw new Error("状态读取早于当前派发，请重新核对本轮状态");
      status = this.acceptStatus(status);
      this.dispatchNeedsCheck = false;
      // Background (heartbeat/reconcile) checks refresh state silently: a
      // still-healthy batch must not flash connection warnings at the user.
      if (source === "user") this.write("checkMessage", status.controlState === "stopped" ? "上传已停止，已确认的资料已保留。" : status.error?.message || (status.dispatchRecoveryAction === "confirm_dispatch" ? "启动结果待确认，请继续核对本轮状态。" : status.dispatchRecoveryAction === "observe" ? "任务已受理，正在同步当前阶段。" : status.readyToDispatch ? "资料已保存，可以继续确认并启动。" : "状态已更新，等待未完成的文件。"));
      return status;
    }).catch(error => {
      if (source === "user" && this.statusRequest === request && dispatchEpoch === this.dispatchEpoch) this.write("checkMessage", error instanceof Error ? error.message : "服务端状态读取未完成，请重新读取状态");
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
      if (this.statusRequest !== request) return;
      this.write("checking", false); this.statusRequest = undefined; this.statusController = undefined;
    });
    this.statusRequest = request;
    return request;
  }
  private invalidateStatusRequest() {
    const controller = this.statusController;
    this.statusRequest = undefined; this.statusController = undefined;
    controller?.abort(new DOMException("已切换至新的资料批次", "AbortError"));
    this.write("checking", false); this.write("checkMessage", "");
  }
  private acceptStatus(status: KnowledgeBaseUploadStatus) {
    const current = this.read<KnowledgeBaseUploadStatus | null>("uploadStatus", null);
    if (!this.coordinate || status.conversationId !== this.coordinate.conversationId || status.turnId !== this.coordinate.turnId || status.clientRequestId !== this.coordinate.clientRequestId || status.resetRevision !== this.coordinate.expectedResetRevision) throw new Error("返回的资料状态与当前批次不一致");
    const projectId = this.scope.headers()["x-enterprise-project-id"];
    if (projectId && status.enterpriseProjectId && projectId !== status.enterpriseProjectId) throw new Error("返回的资料不属于当前企业项目");
    if (this.reservedResult?.reservation.generation && status.generation !== this.reservedResult.reservation.generation) throw new Error("资料所属知识库版本已变化");
    if (current && (status.buildId !== current.buildId || status.generation !== current.generation || status.uploadStatusVersion < current.uploadStatusVersion || status.stateEpoch < current.stateEpoch)) return current;
    if (!current || current.uploadStatusVersion !== status.uploadStatusVersion) this.write("lastBusinessProgressAt", Date.now());
    this.write("uploadStatus", status);
    for (const file of status.files) if (file.status === "confirmed") this.staged.add(file.itemId);
    this.coordinate.uploadAttemptId = status.uploadAttemptId ?? undefined;
    this.write("coordinate", { ...this.coordinate });
    return status;
  }
  async stageRetained(signal: AbortSignal) {
    if (!this.coordinate) throw new Error("缺少本批资料预约");
    const coordinate = { ...this.coordinate };
    return waitForKnowledgeBaseReply({ signal: this.operation(signal).signal,
      request: requestSignal => resumeKnowledgeBaseTurnAttachments(coordinate, requestSignal),
      reconcile: async () => {
        const status = await this.checkStatus("auto");
        return status.files.some(file => file.status === "retained") && status.controlState === "active"
          ? undefined : uploadStatusToAttachmentResume(status);
      },
    });
  }
  async resume() {
    if (!this.coordinate) return;
    const status = this.acceptStatus(await controlKnowledgeBaseUpload({ ...this.coordinate, action: "resume" }, this.operation(AbortSignal.timeout(10_000)).signal));
    if (status.controlState !== "active") throw new Error("当前批次尚不能继续上传");
    this.stopRequested = false;
    this.write("stopState", "active");
    return status;
  }
  async dispatch<T>(dispatch: (coordinate?: KnowledgeBaseTurnAttachmentCoordinate) => Promise<T>): Promise<T> {
    this.scope.assertActive();
    if (this.stopRequested) throw new DOMException("上传已停止", "AbortError");
    if (this.dispatchRequest) return this.dispatchRequest as Promise<T>;
    if (this.dispatchNeedsCheck) await this.checkStatus();
    const status = this.read<KnowledgeBaseUploadStatus | null>("uploadStatus", null);
    if (status) {
      const response = this.dispatchedResponse(status);
      if (response) return response as T;
      if (status.dispatchRecoveryAction === "confirm_dispatch") throw Object.assign(new Error("启动结果待确认，请核对当前轮次"), { code: "KB_DISPATCH_PENDING" });
      if (status.dispatchRecoveryAction === "none" || status.controlState === "stopped") throw new Error(status.error?.message || "当前批次尚不能启动，请核对资料状态");
    }
    this.write("runPhase", "dispatching");
    this.dispatchEpoch++;
    const request = dispatch(this.coordinate).then(result => { this.scope.assertActive(); return result; }).catch(error => {
      this.dispatchNeedsCheck = true;
      this.write("uploadStatus", null);
      throw error;
    }).finally(() => { if (this.dispatchRequest === request) this.dispatchRequest = undefined; });
    this.dispatchRequest = request;
    return request;
  }
  private dispatchedResponse(status: KnowledgeBaseUploadStatus): TaskResponse | undefined {
    if (status.dispatchRecoveryAction !== "observe" && !(status.runPhase === "published" && status.dispatchState === "completed")) return undefined;
    return { id: status.knowledgeObservation?.authoritativeTaskId || status.upstreamTaskId || "", status: status.runPhase === "published" ? "completed" : "running", knowledgeObservation: status.knowledgeObservation };
  }
  progress() {
    const manifest = this.read<KnowledgeBaseAttachmentManifestItem[]>("manifest", []);
    const status = this.read<KnowledgeBaseUploadStatus | null>("uploadStatus", null);
    const states = this.read<Map<string, {loadedBytes?: number}>>("fileStates", () => new Map());
    let uploadedBytes = 0, confirmedFiles = 0;
    for (const item of manifest) {
      const confirmed = this.staged.has(item.itemId!) || status?.files.some(file => file.itemId === item.itemId && file.status === "confirmed");
      if (confirmed) confirmedFiles++;
      uploadedBytes += confirmed ? item.sizeBytes : Math.min(item.sizeBytes, Math.max(0, states.get(item.itemId!)?.loadedBytes ?? 0));
    }
    const totalBytes = manifest.reduce((sum,item) => sum + item.sizeBytes, 0);
    return { totalBytes, uploadedBytes: Math.round(uploadedBytes), confirmedFiles, totalFiles: manifest.length, percent: totalBytes ? Math.round(uploadedBytes / totalBytes * 100) : 0 };
  }
  noteTransfer(itemId: string, loadedBytes: number, attempt = 1) {
    const progress = this.ref("attemptProgress", new Map<string, { attempt: number; bytes: number }>());
    const previous = progress.current.get(itemId);
    const bytes = Math.max(0, loadedBytes);
    if (!previous || previous.attempt !== attempt || bytes > previous.bytes) this.write("lastProgressAt", Date.now());
    progress.current.set(itemId, { attempt, bytes });
  }
  private async persistStop() {
    if (!this.coordinate) return;
    if (this.controlRequest) return this.controlRequest;
    this.write("stopState", "stopping");
    const coordinate = { ...this.coordinate };
    const isCurrent = () => this.coordinate?.conversationId === coordinate.conversationId && this.coordinate?.turnId === coordinate.turnId && this.coordinate?.clientRequestId === coordinate.clientRequestId && this.coordinate?.expectedResetRevision === coordinate.expectedResetRevision;
    const request = controlKnowledgeBaseUpload({ ...coordinate, action: "stop" }, this.operation(AbortSignal.timeout(10_000)).signal).then(status => {
      status = this.acceptStatus(status);
      // A newer explicit resume may already have won while stop's reply was delayed.
      if (!this.stopRequested && status.controlState === "active") return status;
      this.write("stopState", status.controlState === "stopped" ? "stopped" : "dispatching");
      this.write("batchError", status.controlState === "stopped" ? "上传已停止。已完成的文件会保留，继续时只处理未完成资料。" : "资料已进入启动阶段，正在确认任务状态。");
      return status;
    }).catch(() => {
      if (!isCurrent()) return undefined;
      this.write("stopState", "unknown");
      this.write("batchError", "停止结果待确认，已暂停本地上传。请检查当前状态。");
      return undefined;
    }).finally(() => { if (this.controlRequest === request) this.controlRequest = undefined; });
    this.controlRequest = request;
    return request;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  read<T>(key: string, initial: T | (() => T)): T {
    if (!this.values.has(key)) this.values.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    return this.values.get(key) as T;
  }
  write<T>(key: string, value: SetStateAction<T>) {
    if (this.disposed) return;
    const previous = this.values.get(key) as T;
    const next = typeof value === "function" ? (value as (old: T) => T)(previous) : value;
    if (Object.is(previous, next)) return;
    this.values.set(key, next);
    for (const listener of this.listeners) listener();
  }
  ref<T>(key: string, initial: T): { current: T } {
    if (!this.refs.has(key)) this.refs.set(key, { current: initial });
    return this.refs.get(key)! as { current: T };
  }
  startHeartbeat(coordinate: KnowledgeBaseTurnAttachmentCoordinate) {
    this.endHeartbeat();
    this.bindCoordinate(coordinate);
    const operation = this.scope;
    this.heartbeat = () => {
      if (this.disposed || operation.signal.aborted || this.stopRequested) return;
      const states = this.read<Map<string, { loadedBytes?: number }>>("fileStates", () => new Map());
      const uploadedBytes = this.read<KnowledgeBaseAttachmentManifestItem[]>("manifest", []).length ? this.progress().uploadedBytes : Math.round([...states.values()].reduce((sum, file) => sum + (file.loadedBytes ?? 0), 0));
      void operation.fetch("/api/knowledge-base/turn/upload-heartbeat", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...this.coordinate, status: "active", uploadedBytes }),
      }).then((response) => {
        if ([404, 409, 410].includes(response.status)) this.endHeartbeat();
      }).catch(() => undefined);
      const progressAt = Math.max(this.read<number>("lastProgressAt", () => Date.now()), this.read<number>("lastBusinessProgressAt", 0));
      // Server-side staging can legitimately run past half a minute without
      // byte progress; only a genuinely quiet batch triggers the silent check.
      if (Date.now() - progressAt >= 90_000 && this.lastCheckProgressAt !== progressAt) {
        this.lastCheckProgressAt = progressAt;
        void this.checkStatus("auto").catch(() => undefined);
      }

    };
    this.heartbeat("active");
    this.heartbeatTimer = setInterval(() => this.heartbeat?.("active"), 15_000);
  }
  endHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeat = undefined;
  }
  stop(reason = "用户已停止上传") {
    this.stopRequested = true;
    this.write("stopState", "stopping");
    this.endHeartbeat();
    this.controller?.abort(Object.assign(new DOMException(reason, "AbortError"), { frontmindAbortSource: "USER_STOP" }));
    return this.persistStop();
  }

  dispose() {
    this.stopRequested = true;
    this.endHeartbeat();
    this.controller?.abort(new DOMException("账号、项目或知识库版本已变化", "AbortError"));
    this.lifetime.abort(new DOMException("账号、项目或知识库版本已变化", "AbortError"));
    this.receipts.clear(); this.reservedResult = undefined; this.completed = undefined; this.dispatchRequest = undefined;
    this.disposed = true;
    this.values.clear();
    this.refs.clear();
    this.listeners.clear();
  }
}

export class KnowledgeBaseUploadManager {
  private batches = new Map<string, KnowledgeBaseUploadBatch>();
  batch(key: string) {
    let batch = this.batches.get(key);
    if (!batch) { batch = new KnowledgeBaseUploadBatch(key); this.batches.set(key, batch); }
    return batch;
  }
  retireOtherRevisions(prefix: string, currentKey: string) {
    for (const [key, batch] of this.batches) {
      if (key.startsWith(prefix) && key !== currentKey) { batch.dispose(); this.batches.delete(key); }
    }
  }
  dispose() { for (const batch of this.batches.values()) batch.dispose(); this.batches.clear(); }
}

const UploadContext = createContext<KnowledgeBaseUploadManager | null>(null);

export function KnowledgeBaseUploadProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string }) {
  const [manager] = useState(() => new KnowledgeBaseUploadManager());
  const lifetime = useRef(0);
  useLayoutEffect(() => scopeKey ? activateWorkspaceUploadScope(scopeKey) : undefined, [scopeKey]);
  useLayoutEffect(() => {
    const generation = ++lifetime.current;
    return () => { queueMicrotask(() => { if (lifetime.current === generation) manager.dispose(); }); };
  }, [manager]);
  return <UploadContext.Provider value={manager}>{children}</UploadContext.Provider>;
}

export function useKnowledgeBaseUploadBatch(key: string, revisionPrefix = key) {
  const shared = useContext(UploadContext);
  // Isolated consumers/previews still get a real manager, without a global
  // cache that could leak files into a different login.
  const [local] = useState(() => new KnowledgeBaseUploadManager());
  const manager = shared ?? local;
  const localLifetime = useRef(0);
  useLayoutEffect(() => {
    const generation = ++localLifetime.current;
    return () => { queueMicrotask(() => { if (!shared && localLifetime.current === generation) local.dispose(); }); };
  }, [shared, local]);
  const batch = manager.batch(key);
  useLayoutEffect(() => { manager.retireOtherRevisions(revisionPrefix, key); }, [manager, revisionPrefix, key]);
  return batch;
}

export function useKnowledgeBaseUploadField<T>(batch: KnowledgeBaseUploadBatch, key: string, initial: T | (() => T)) {
  const read = useCallback(() => batch.read(key, initial), [batch, key]);
  const value = useSyncExternalStore(batch.subscribe, read, read);
  const update = useCallback((next: SetStateAction<T>) => batch.write(key, next), [batch, key]);
  return [value, update] as const;
}

/** Invoke after the server commits an approved reset, before installing its new workspace. */
export function useRetireKnowledgeUploads() {
  const manager = useContext(UploadContext);
  return useCallback(() => manager?.dispose(), [manager]);
}
