import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeBaseUploadManager, type KnowledgeBaseUploadCommand } from "./knowledge-base-upload-manager";
import * as api from "./frontmind-api";

vi.mock("./frontmind-api", async importOriginal => ({
  ...await importOriginal<typeof import("./frontmind-api")>(),
  reserveKnowledgeBaseTurnWithAttachments: vi.fn(),
  uploadKnowledgeBaseLocalAsset: vi.fn(),
  stageKnowledgeBaseTurnAttachment: vi.fn(),
  createKnowledgeBaseTurnTask: vi.fn(),
  getKnowledgeBaseUploadStatus: vi.fn(),
  controlKnowledgeBaseUpload: vi.fn(),
  resumeKnowledgeBaseTurnAttachments: vi.fn(),
}));

const command = (id: string, leaf = "company") => {
  const file = new File([`事实 ${id}`], `${id}.txt`, { type: "text/plain" });
  return { kind: "revise", conversationId: "conversation", clientRequestId: id, expectedResetRevision: 0,
    expectedGeneration: 1, expectedRevision: 0, expectedLeafId: leaf,
    manifest: [{ itemId: `${id}:1`, ordinal: 1, total: 1, filename: file.name, sizeBytes: file.size, mimeType: file.type, lastModified: file.lastModified }],
    files: [{ file, itemId: `${id}:1`, ordinal: 1 }],
  } satisfies KnowledgeBaseUploadCommand;
};
const status = (id = "first", overrides = {}) => ({
  buildId: "build", conversationId: "conversation", turnId: `turn-${id}`, clientRequestId: id, resetRevision: 0,
  generation: 1, stateEpoch: 1, uploadStatusVersion: 1, uploadAttemptId: `attempt-${id}`,
  runPhase: "staging", controlState: "active", files: [], totalFiles: 1, totalBytes: 10, confirmedFiles: 1, confirmedBytes: 10,
  readyToDispatch: true, allowedActions: ["dispatch"], createAttemptState: "not_sent", dispatchState: "reserved", dispatchRecoveryAction: "safe_dispatch", ...overrides,
}) as api.KnowledgeBaseUploadStatus;

describe("knowledge upload command execution", () => {
  let manager: KnowledgeBaseUploadManager;
  beforeEach(() => {
    vi.resetAllMocks();
    manager = new KnowledgeBaseUploadManager();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    vi.mocked(api.reserveKnowledgeBaseTurnWithAttachments).mockImplementation(async (_input, context) => ({ reservation: {
      turnId: `turn-${context.clientRequestId}`, clientRequestId: context.clientRequestId, uploadAttemptId: `attempt-${context.clientRequestId}`,
      sourceResetRevision: 0, generation: 1, revision: 0, leafId: context.expectedLeafId,
      state: "awaiting_attachments", stagedAttachmentCount: 0, expectedAttachmentCount: 1, requiresUpload: true,
    } }));
    vi.mocked(api.uploadKnowledgeBaseLocalAsset).mockImplementation(async file => ({ fileId: `asset-${file.name}`, filename: file.name }));
    vi.mocked(api.stageKnowledgeBaseTurnAttachment).mockResolvedValue({ staged: true });
    vi.mocked(api.createKnowledgeBaseTurnTask).mockImplementation(async (_input, context) => ({ id: `task-${context.clientRequestId}`, status: "running" }));
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockImplementation(async coordinate => status(coordinate.clientRequestId));
  });
  afterEach(() => { manager.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each(["company", "products"])("gives consecutive supplements their own reservation and dispatch at node %s", async leaf => {
    const batch = manager.batch("conversation:0");
    const first = await batch.submit(command("first"));
    // The route can remount with the same project-owned manager.
    const second = await manager.batch("conversation:0").submit(command("second", leaf));
    expect(first.response.id).toBe("task-first");
    expect(second.reservation.turnId).toBe("turn-second");
    expect(second.response.id).toBe("task-second");
    expect(api.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(2);
    expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(2);
    expect(api.stageKnowledgeBaseTurnAttachment).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: "turn-second", clientRequestId: "second" }));
  });

  it("recovers a rejected dispatch promise only after durable state proves it was not sent", async () => {
    const batch = manager.batch("conversation:0");
    batch.bindCoordinate({ conversationId: "conversation", turnId: "turn-first", clientRequestId: "first", expectedResetRevision: 0 });
    const dispatch = vi.fn().mockRejectedValueOnce(new TypeError("network disconnected")).mockResolvedValue({ id: "task-first", status: "running" });
    await expect(batch.dispatch(dispatch)).rejects.toThrow();
    await batch.checkStatus();
    await expect(batch.dispatch(dispatch)).resolves.toMatchObject({ id: "task-first" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not resend an unknown model request even when every file is confirmed", async () => {
    const batch = manager.batch("conversation:0");
    batch.bindCoordinate({ conversationId: "conversation", turnId: "turn-first", clientRequestId: "first", expectedResetRevision: 0 });
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockResolvedValue(status("first", { createAttemptState: "unknown", dispatchRecoveryAction: "confirm_dispatch" }));
    const dispatch = vi.fn().mockRejectedValue(new TypeError("response lost"));
    await expect(batch.dispatch(dispatch)).rejects.toThrow();
    await batch.checkStatus();
    await expect(batch.dispatch(dispatch)).rejects.toThrow(/待确认/);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("binds an already completed round after its dispatch response was lost", async () => {
    const batch = manager.batch("conversation:0");
    batch.bindCoordinate({ conversationId: "conversation", turnId: "turn-first", clientRequestId: "first", expectedResetRevision: 0 });
    const dispatch = vi.fn().mockRejectedValueOnce(new TypeError("response lost"));
    await expect(batch.dispatch(dispatch)).rejects.toThrow();
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockResolvedValue(status("first", { runPhase: "published", dispatchState: "completed", dispatchRecoveryAction: "none", upstreamTaskId: "existing-task" }));
    await expect(batch.dispatch(dispatch)).resolves.toMatchObject({ id: "existing-task", status: "completed" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("recovers a lost reservation by the same request identity and ignores its late response", async () => {
    vi.useFakeTimers();
    const input = command("first");
    const reserved = await api.reserveKnowledgeBaseTurnWithAttachments([], { ...input, expectedLeafId: input.expectedLeafId, expectedGeneration: 1, expectedRevision: 0, attachmentManifest: input.manifest });
    vi.mocked(api.reserveKnowledgeBaseTurnWithAttachments).mockClear();
    let late!: (value: typeof reserved) => void;
    vi.mocked(api.reserveKnowledgeBaseTurnWithAttachments).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockResolvedValue(status("first", { reservation: reserved.reservation }));
    const result = manager.batch("conversation:0").submit(input);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toMatchObject({ response: { id: "task-first" } });
    expect(api.getKnowledgeBaseUploadStatus).toHaveBeenCalledWith({ conversationId: "conversation", clientRequestId: "first", expectedResetRevision: 0 }, expect.any(AbortSignal));
    late(reserved); await vi.advanceTimersByTimeAsync(0);
    expect(api.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledOnce();
    expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not emit an older reservation observation after a fresher status has arrived", async () => {
    vi.useFakeTimers();
    const input = command("first");
    const reserved = await api.reserveKnowledgeBaseTurnWithAttachments([], { ...input, expectedLeafId: input.expectedLeafId, expectedGeneration: 1, expectedRevision: 0, attachmentManifest: input.manifest });
    vi.mocked(api.reserveKnowledgeBaseTurnWithAttachments).mockImplementationOnce(() => new Promise(() => {}));
    const oldObservation = { generation: 1, stateEpoch: 1 } as api.KnowledgeBaseUploadStatus["knowledgeObservation"];
    const currentObservation = { generation: 1, stateEpoch: 2 } as api.KnowledgeBaseUploadStatus["knowledgeObservation"];
    const confirmed = input.manifest.map(item => ({ ...item, status: "confirmed", resourceId: "existing-asset" }));
    vi.mocked(api.getKnowledgeBaseUploadStatus)
      .mockResolvedValueOnce(status("first", { reservation: { ...reserved.reservation, stagedAttachmentCount: 1 }, files: confirmed, knowledgeObservation: oldObservation }))
      .mockResolvedValue(status("first", { uploadStatusVersion: 2, stateEpoch: 2, files: confirmed, knowledgeObservation: currentObservation }));
    const onObservation = vi.fn();
    const pending = manager.batch("conversation:0").submit({ ...input, onObservation });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(onObservation).toHaveBeenCalledWith(currentObservation);
    expect(onObservation).not.toHaveBeenCalledWith(oldObservation);
    expect(api.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
    expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledOnce();
  });

  it("continues after a stage was committed but its response hangs", async () => {
    vi.useFakeTimers();
    const input = command("first");
    let late!: (value: unknown) => void;
    vi.mocked(api.stageKnowledgeBaseTurnAttachment).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockResolvedValue(status("first", { files: input.manifest.map(item => ({ ...item, status: "confirmed", resourceId: "asset-first.txt" })) }));
    const pending = manager.batch("conversation:0").submit(input);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({ response: { id: "task-first" } });
    late({ staged: true }); await vi.advanceTimersByTimeAsync(0);
    expect(api.uploadKnowledgeBaseLocalAsset).toHaveBeenCalledOnce();
    expect(api.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledOnce();
    expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledOnce();
  });

  it("uses the resumed attempt for restored uploads and the latest checked attempt for dispatch", async () => {
    const input = { ...command("first"), turnId: "turn-first", uploadAttemptId: "attempt-old" };
    vi.mocked(api.getKnowledgeBaseUploadStatus)
      .mockResolvedValueOnce(status("first", { uploadAttemptId: "attempt-resumed", uploadStatusVersion: 2, confirmedFiles: 0 }))
      .mockResolvedValueOnce(status("first", { uploadAttemptId: "attempt-current", uploadStatusVersion: 3 }));
    await manager.batch("conversation:0").submit(input);
    expect(api.uploadKnowledgeBaseLocalAsset).toHaveBeenCalledWith(expect.any(File), expect.any(Function), expect.anything(), expect.objectContaining({ resumeScope: expect.objectContaining({ uploadAttemptId: "attempt-resumed" }) }));
    expect(api.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledWith(expect.objectContaining({ uploadAttemptId: "attempt-resumed" }));
    expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledWith([], expect.objectContaining({ attachmentReservation: expect.objectContaining({ uploadAttemptId: "attempt-current" }) }), expect.any(AbortSignal));
  });

  it("continues a retained-file stage after thirty seconds when its committed response is lost", async () => {
    vi.useFakeTimers();
    const input = command("first");
    const batch = manager.batch("conversation:0");
    batch.bindCoordinate({ conversationId: input.conversationId, clientRequestId: input.clientRequestId, expectedResetRevision: 0, turnId: "turn-first", uploadAttemptId: "attempt-first" });
    let late!: (value: api.KnowledgeBaseTurnAttachmentResumeResult) => void;
    vi.mocked(api.resumeKnowledgeBaseTurnAttachments).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    const confirmed = status("first", { files: input.manifest.map(item => ({ ...item, status: "confirmed", resourceId: "existing-asset" })) });
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockResolvedValue(confirmed);
    const pending = batch.stageRetained(new AbortController().signal).then(recovered => batch.submit({ ...input, kind: "reselect", turnId: "turn-first", uploadAttemptId: "attempt-first", files: [], manifest: recovered.attachmentManifest }));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({ response: { id: "task-first" } });
    expect(api.resumeKnowledgeBaseTurnAttachments).toHaveBeenCalledOnce();
    expect(vi.mocked(api.resumeKnowledgeBaseTurnAttachments).mock.calls[0][1]?.aborted).toBe(true);
    late(api.uploadStatusToAttachmentResume(confirmed));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
    expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the newer stopped snapshot when a stop response arrives with older active state", async () => {
    const batch = manager.batch("conversation:0");
    batch.bindCoordinate({ conversationId: "conversation", clientRequestId: "first", expectedResetRevision: 0, turnId: "turn-first" });
    let late!: (value: api.KnowledgeBaseUploadStatus) => void;
    vi.mocked(api.controlKnowledgeBaseUpload).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    const pending = batch.stop();
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockResolvedValue(status("first", { controlState: "stopped", uploadStatusVersion: 3 }));
    await batch.checkStatus();
    late(status("first", { controlState: "active", uploadStatusVersion: 2 }));
    await expect(pending).resolves.toMatchObject({ controlState: "stopped", uploadStatusVersion: 3 });
    expect(batch.read("stopState", "active")).toBe("stopped");
  });

  it("does not revive a newer stop when an earlier resume reply arrives late", async () => {
    const batch = manager.batch("conversation:0");
    batch.bindCoordinate({ conversationId: "conversation", clientRequestId: "first", expectedResetRevision: 0, turnId: "turn-first" });
    let late!: (value: api.KnowledgeBaseUploadStatus) => void;
    vi.mocked(api.controlKnowledgeBaseUpload)
      .mockImplementationOnce(() => new Promise(resolve => { late = resolve; }))
      .mockResolvedValueOnce(status("first", { controlState: "stopped", uploadStatusVersion: 3 }));
    const pending = batch.resume();
    await batch.stop();
    late(status("first", { controlState: "active", uploadStatusVersion: 2 }));
    await expect(pending).rejects.toThrow("当前批次尚不能继续上传");
    expect(batch.read("stopState", "active")).toBe("stopped");
    const dispatch = vi.fn();
    await expect(batch.dispatch(dispatch)).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a newer explicit resume active when an earlier stopped response arrives late", async () => {
    const batch = manager.batch("conversation:0");
    batch.bindCoordinate({ conversationId: "conversation", clientRequestId: "first", expectedResetRevision: 0, turnId: "turn-first" });
    let late!: (value: api.KnowledgeBaseUploadStatus) => void;
    vi.mocked(api.controlKnowledgeBaseUpload)
      .mockImplementationOnce(() => new Promise(resolve => { late = resolve; }))
      .mockResolvedValueOnce(status("first", { controlState: "active", uploadStatusVersion: 3, uploadAttemptId: "attempt-resumed" }));
    const pending = batch.stop();
    await batch.resume();
    late(status("first", { controlState: "stopped", uploadStatusVersion: 2 }));
    await expect(pending).resolves.toMatchObject({ controlState: "active", uploadStatusVersion: 3 });
    expect(batch.read("stopState", "stopped")).toBe("active");
    const dispatch = vi.fn().mockResolvedValue({ id: "task-first" });
    await expect(batch.dispatch(dispatch)).resolves.toEqual({ id: "task-first" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ uploadAttemptId: "attempt-resumed" }));
  });

  it("keeps a delayed prior-batch stop from replacing the new batch's control request or state", async () => {
    const batch = manager.batch("conversation:0");
    await batch.submit(command("first"));
    let late!: (value: api.KnowledgeBaseUploadStatus) => void;
    vi.mocked(api.controlKnowledgeBaseUpload)
      .mockImplementationOnce(() => new Promise(resolve => { late = resolve; }))
      .mockResolvedValueOnce(status("second", { controlState: "stopped", uploadStatusVersion: 2 }));
    const firstStop = batch.stop();
    await batch.submit(command("second"));
    await expect(batch.stop()).resolves.toMatchObject({ clientRequestId: "second", controlState: "stopped" });
    late(status("first", { controlState: "stopped", uploadStatusVersion: 2 }));
    await expect(firstStop).resolves.toBeUndefined();
    expect(batch.read("stopState", "unknown")).toBe("stopped");
    expect(batch.read("uploadStatus", null)).toMatchObject({ clientRequestId: "second" });
    expect(api.controlKnowledgeBaseUpload).toHaveBeenCalledTimes(2);
  });

  it("retires an old status request before the next logical batch can inherit its error or finalizer", async () => {
    const batch = manager.batch("conversation:0");
    await batch.submit(command("first"));
    let late!: (value: api.KnowledgeBaseUploadStatus) => void;
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    const oldStatus = batch.checkStatus().catch(error => error);
    const oldSignal = vi.mocked(api.getKnowledgeBaseUploadStatus).mock.calls.at(-1)![1];
    await batch.submit(command("second"));
    expect(oldSignal?.aborted).toBe(true);
    expect(await oldStatus).toMatchObject({ name: "AbortError" });
    let current!: (value: api.KnowledgeBaseUploadStatus) => void;
    vi.mocked(api.getKnowledgeBaseUploadStatus).mockImplementationOnce(() => new Promise(resolve => { current = resolve; }));
    const currentStatus = batch.checkStatus();
    late(status("first"));
    await Promise.resolve();
    expect(batch.read("checking", false)).toBe(true);
    expect(batch.read("checkMessage", "")).toBe("");
    current(status("second"));
    await expect(currentStatus).resolves.toMatchObject({ clientRequestId: "second" });
    expect(batch.read("checking", true)).toBe(false);
  });

  it("retires an outstanding reservation before a project or reset can receive its response", async () => {
    let late!: (value: any) => void;
    vi.mocked(api.reserveKnowledgeBaseTurnWithAttachments).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    const pending = manager.batch("conversation:0").submit(command("first"));
    manager.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    late({ reservation: { turnId: "old-turn" } }); await Promise.resolve();
    expect(api.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
    expect(api.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });
});
