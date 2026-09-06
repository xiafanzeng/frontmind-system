import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { repairStructuredJsonCandidate } from "../../shared/model-output-repair";
import {
  ManusV2ApiError,
  ManusV2Client,
  type ManusV2Attachment,
  type ManusV2MessageEvent,
} from "../manus-v2-client";
import { zhipuTaskPrompt } from "./website-agent-provider";
import {
  ZhipuManagedClient,
  ZhipuManagedError,
  zhipuResourceId,
  type ZhipuRecord,
} from "./zhipu-managed-client";
import {
  dashboardAgentRuntimeStore,
  type DashboardAgentRuntimeStore,
  type DashboardManagedCommand,
  type DashboardManagedFile,
  type DashboardManagedRuntime,
  type DashboardProviderIdentity,
  type DashboardRuntimeRecord,
} from "./dashboard-agent-runtime-store";

type NativeMethods =
  | "createTask"
  | "sendMessage"
  | "taskDetail"
  | "listAllMessages"
  | "findCreatedTask"
  | "stopTask"
  | "deleteTask"
  | "confirmAction"
  | "uploadFile"
  | "fileDetail"
  | "deleteFile"
  | "probeCredential";
export type DashboardAgentClient = Pick<ManusV2Client, NativeMethods> & {
  downloadArtifact?(fileId: string): Promise<{
    status: number;
    headers: Record<string, string>;
    data: Readable;
  }>;
};
export type DashboardAgentClientOptions = DashboardProviderIdentity & {
  apiKey: string;
  /** Stable business operation/turn intent; never derived from prompt/key. */
  intentId?: string;
  localTaskId?: string;
  operationId?: string;
  upstreamModel?: string | null;
  upstreamEffort?: "low" | "high" | "max" | null;
  model?: string;
  effort?: "low" | "high" | "max";
  baseUrl?: string;
  rateLimitScope?: string;
  /** Frozen server-owned purpose context, never supplied directly by the browser. */
  systemContext?: string;
  /** Server-owned workflow inputs mount in the same session, outside user-turn evidence. */
  systemAttachments?: readonly ManusV2Attachment[];
  /** Server-approved small operational status files may survive a native error; they never settle the task. */
  recoverableStatusArtifact?: (filename: string) => boolean;
  timeoutMs?: number;
  store?: DashboardAgentRuntimeStore;
  api?: ZhipuManagedClient;
};
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): ZhipuRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ZhipuRecord)
    : {};
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .filter((b) => object(b).type === "text")
          .map((b) => String(object(b).text ?? ""))
          .join("\n")
      : "";
const stamp = (value: unknown): number | null => {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const SYSTEM =
  "Execute the original FrontMind task and attached Skill without changing its instructions, business schema, stage order, or user confirmation points. Original input files are mounted read-only below /mnt/session/uploads/input under their original filenames. Copy any workflow ZIP byte-for-byte into /workspace/frontmind before extracting a writable copy. Do not treat workflow files as customer evidence. Preserve original prompt and file content. Stop at each requested user pause and wait for the next user message. Put only the requested final deliverables in /mnt/session/outputs. Never include input files, internal Skills, secrets, or temporary files in outputs. This instruction adapts transport paths and delivery only.";
const activeStreams = new Map<string, Promise<void>>();
function fail(
  operation: string,
  code: string,
  unknown = false,
  status: number | null = null,
): never {
  throw new ManusV2ApiError(operation, status, code, false, unknown);
}
function compat(error: unknown, operation: string): never {
  if (error instanceof ManusV2ApiError) throw error;
  if (error instanceof ZhipuManagedError)
    throw new ManusV2ApiError(
      operation,
      error.status,
      `ZHIPU_${error.code}`,
      !error.outcomeUnknown && error.status === 429,
      error.outcomeUnknown,
    );
  throw error;
}
function validId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(id))
    throw new Error("INVALID_PROVIDER_ID");
  return id;
}
function validFilename(filename: string) {
  if (
    !filename.trim() ||
    /[\\/\u0000]/u.test(filename) ||
    Buffer.byteLength(filename) > 512
  )
    throw new Error("INVALID_PROVIDER_FILENAME");
  return filename;
}
function sessionErrorIsRetrying(event: ZhipuRecord) {
  const error = object(event.error);
  return (
    object(error.retry_status).type === "retrying" ||
    error.retry_status === "retrying"
  );
}

/** An idle notification ends the transport turn; it does not erase the
 * preceding provider failure. A new execution or user command starts afresh. */
function terminalSessionError(raw: ZhipuRecord[]) {
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    const event = raw[index];
    if (
      [
        "user.message",
        "session.status_running",
        "session.status_rescheduled",
      ].includes(String(event.type))
    )
      return null;
    if (event.type === "session.error" && !sessionErrorIsRetrying(event))
      return event;
  }
  return null;
}

function sessionFailureStatus(event: ZhipuRecord) {
  const error = object(event.error);
  return {
    agent_status: "error",
    error_type: typeof error.type === "string" ? error.type : "PROVIDER_ERROR",
    error_content:
      typeof error.message === "string" ? error.message : "上游执行异常。",
  };
}

function normalizedSessionStatus(session: ZhipuRecord, raw: ZhipuRecord[]) {
  if (session.status === "running" || session.status === "rescheduling")
    return "running";
  if (session.status === "terminated") return "cancelled";
  if (terminalSessionError(raw)) return "error";
  const tail = [...raw]
    .reverse()
    .find((e) =>
      [
        "session.status_idle",
        "session.error",
        "session.status_terminated",
      ].includes(String(e.type)),
    );
  if (tail?.type === "session.error")
    return sessionErrorIsRetrying(tail) ? "running" : "error";
  if (tail?.type === "session.status_terminated") return "cancelled";
  const reason = object(tail?.stop_reason).type;
  return reason === "end_turn"
    ? "stopped"
    : reason === "requires_action"
      ? "waiting"
      : reason === "interrupted" || reason === "user_interrupt"
        ? "cancelled"
        : "idle";
}

function currentSessionStatus(
  session: ZhipuRecord,
  raw: ZhipuRecord[],
  runtime: DashboardManagedRuntime,
) {
  if (
    session.status === "running" ||
    session.status === "rescheduling" ||
    session.status === "terminated"
  )
    return normalizedSessionStatus(session, raw);
  const command = runtime.commands.at(-1);
  if (!command) return "idle";
  const start = raw.findIndex((event) => event.id === command.eventId);
  if (start < 0) return "running";
  const current = raw.slice(start + 1);
  if (
    !current.some((event) =>
      [
        "session.status_idle",
        "session.status_terminated",
        "session.error",
      ].includes(String(event.type)),
    )
  )
    return "running";
  return normalizedSessionStatus(session, current);
}

/** A tenant-bound, durable transport. Existing business routers own stages,
 * confirmation points, public messages and semantic output validation. */
export class ZhipuDashboardAgentProvider implements DashboardAgentClient {
  readonly api: ZhipuManagedClient;
  private readonly store: DashboardAgentRuntimeStore;
  private readonly identity: DashboardProviderIdentity;
  constructor(private readonly options: DashboardAgentClientOptions) {
    if (
      options.provider !== "zhipu" ||
      !Number.isSafeInteger(options.accountUserId) ||
      options.accountUserId < 1 ||
      !options.credentialId ||
      !Number.isSafeInteger(options.credentialVersion) ||
      options.credentialVersion < 1
    )
      throw new Error("DASHBOARD_PROVIDER_IDENTITY_REQUIRED");
    this.api =
      options.api ??
      new ZhipuManagedClient({
        apiKey: options.apiKey,
        maxFileBytes: MAX_FILE_BYTES,
        requestTimeoutMs: options.timeoutMs,
      });
    this.store = options.store ?? dashboardAgentRuntimeStore;
    this.identity = {
      provider: "zhipu",
      accountUserId: options.accountUserId,
      credentialId: options.credentialId,
      credentialVersion: options.credentialVersion,
      credentialOwnerUserId: options.credentialOwnerUserId,
    };
  }
  private intent() {
    if (!this.options.intentId?.trim())
      fail("task.create", "DASHBOARD_PROVIDER_INTENT_REQUIRED");
    return this.options.intentId;
  }
  private reserve() {
    const model = this.options.upstreamModel ?? this.options.model ?? "glm-5.3";
    const effort = this.options.upstreamEffort ?? this.options.effort ?? "high";
    if (
      !["glm-5.3", "glm-5.3-flash"].includes(model) ||
      !["low", "high", "max"].includes(effort)
    )
      throw new Error("DASHBOARD_PROVIDER_MODEL_INVALID");
    return this.store.reserve({
      identity: this.identity,
      intentId: this.intent(),
      model,
      effort,
      localTaskId: this.options.localTaskId,
      operationId: this.options.operationId,
    });
  }
  private async session(taskId: string) {
    validId(taskId);
    const record = await this.store.findBySession(this.identity, taskId);
    if (
      !record ||
      (this.options.localTaskId &&
        record.localTaskId !== this.options.localTaskId) ||
      (this.options.operationId &&
        record.operationId !== this.options.operationId) ||
      record.runtime.deleted
    )
      fail("task.detail", "TASK_NOT_FOUND", false, 404);
    return record;
  }
  private change(
    record: DashboardRuntimeRecord,
    fn: (runtime: DashboardManagedRuntime) => DashboardManagedRuntime,
  ) {
    return this.store.mutate(this.identity, record.localTaskId, fn);
  }
  private async once(
    record: DashboardRuntimeRecord,
    key: string,
    operation: string,
    request: unknown,
    action: () => Promise<string>,
    onAck?: (
      runtime: DashboardManagedRuntime,
      id: string,
    ) => DashboardManagedRuntime,
  ) {
    let acknowledged: string | undefined;
    const requestHash = sha(JSON.stringify(request));
    await this.change(record, (runtime) => {
      const prior = runtime.mutations[key];
      if (prior) {
        if (prior.requestHash !== requestHash)
          fail(operation, "PROVIDER_MUTATION_CONFLICT");
        if (prior.state === "acknowledged" && prior.resourceId) {
          acknowledged = prior.resourceId;
          return runtime;
        }
        if (prior.state !== "rejected")
          fail(operation, "ZHIPU_MUTATION_OUTCOME_UNKNOWN", true);
        if (prior.status !== 429)
          fail(
            operation,
            prior.code ?? "ZHIPU_MUTATION_REJECTED",
            false,
            prior.status ?? null,
          );
      }
      return {
        ...runtime,
        mutations: {
          ...runtime.mutations,
          [key]: {
            requestHash,
            state: "sending",
            startedAt: prior?.startedAt ?? new Date().toISOString(),
          },
        },
      };
    });
    if (acknowledged) return acknowledged;
    try {
      const id = await action();
      await this.change(record, (runtime) => {
        const updated = {
          ...runtime,
          mutations: {
            ...runtime.mutations,
            [key]: {
              ...runtime.mutations[key]!,
              state: "acknowledged" as const,
              resourceId: id,
            },
          },
        };
        return onAck ? onAck(updated, id) : updated;
      });
      return id;
    } catch (error) {
      await this.change(record, (runtime) => {
        if (runtime.mutations[key]?.state === "acknowledged") return runtime;
        const known =
          (error instanceof ZhipuManagedError ||
            error instanceof ManusV2ApiError) &&
          !error.outcomeUnknown;
        return {
          ...runtime,
          mutations: {
            ...runtime.mutations,
            [key]: {
              ...runtime.mutations[key]!,
              state: known ? "rejected" : "outcome_unknown",
              ...(known
                ? { status: error.status, code: `ZHIPU_${error.code}` }
                : {}),
            },
          },
        };
      }).catch(() => undefined);
      compat(error, operation);
    }
  }
  async uploadFile(
    input: Parameters<ManusV2Client["uploadFile"]>[0],
  ): ReturnType<ManusV2Client["uploadFile"]> {
    const record = await this.reserve();
    validFilename(input.filename);
    const chunks: Buffer[] = [];
    let size = 0;
    if (input.bytes) {
      chunks.push(input.bytes);
      size = input.bytes.length;
    } else
      for await (const item of input.createReadStream!()) {
        const b = Buffer.isBuffer(item) ? item : Buffer.from(item);
        size += b.length;
        if (size > MAX_FILE_BYTES) throw new Error("FILE_TOO_LARGE");
        chunks.push(b);
      }
    if (
      !size ||
      size > MAX_FILE_BYTES ||
      (input.bytes === undefined && size !== input.byteLength)
    )
      throw new Error("FILE_BYTES_INVALID");
    const bytes = Buffer.concat(chunks);
    const fileHash = sha(bytes);
    const key = `file:${sha(JSON.stringify([this.intent(), input.filename, fileHash, input.contentType]))}`;
    let id: string;
    if (input.existingCandidate) {
      const owned = await this.store.findByFile(
        this.identity,
        input.existingCandidate.fileId,
      );
      const prior = owned?.runtime.files.find(
        (f) => f.id === input.existingCandidate!.fileId,
      );
      if (
        !prior ||
        prior.deleted ||
        prior.sha256 !== fileHash ||
        prior.filename !== input.filename ||
        prior.bytes !== size
      )
        fail("file.upload", "FILE_RESUME_IDENTITY_CONFLICT");
      id = prior.id;
    } else
      id = await this.once(
        record,
        key,
        "file.upload",
        {
          filename: input.filename,
          sha256: fileHash,
          bytes: size,
          contentType: input.contentType,
        },
        async () =>
          zhipuResourceId(
            await this.api.uploadFile({
              filename: input.filename,
              bytes,
              contentType: input.contentType,
            }),
          ),
        (runtime, fileId) => ({
          ...runtime,
          files: [
            ...runtime.files,
            {
              id: fileId,
              filename: input.filename,
              bytes: size,
              sha256: fileHash,
              contentType: input.contentType,
              role: "input",
            },
          ],
        }),
      );
    const detail = await this.fileDetail(id);
    // Zhipu has no provider PUT URL. This shape is for server-side complete-byte
    // callers only; the root managed-upload adapter owns browser ingress.
    const candidate = {
      fileId: id,
      filename: input.filename,
      uploadUrl: "",
      uploadExpiresAt: detail.expiresAt,
      requestId: null,
    };
    await input.observer?.onCandidateCreated?.(candidate);
    return { ...candidate, detail };
  }
  async fileDetail(
    fileId: string,
    options?: Parameters<ManusV2Client["fileDetail"]>[1],
  ): ReturnType<ManusV2Client["fileDetail"]> {
    if (options?.signal?.aborted) throw options.signal.reason;
    validId(fileId);
    const owner = await this.store.findByFile(this.identity, fileId);
    const local = owner?.runtime.files.find((f) => f.id === fileId);
    if (!local || local.deleted)
      fail("file.detail", "FILE_NOT_FOUND", false, 404);
    try {
      const data = await this.api.request("GET", `/v1/files/${fileId}`);
      if (
        zhipuResourceId(data) !== fileId ||
        data.filename !== local.filename ||
        data.size_bytes !== local.bytes
      )
        fail("file.detail", "FILE_IDENTITY_CONFLICT");
      // Zhipu publishes no expiry. This local revalidation lease is renewed
      // only after metadata verification; it is never a signed PUT capability.
      return {
        fileId,
        filename: local.filename,
        bytes: local.bytes,
        contentType: typeof data.mime_type === "string" ? data.mime_type : null,
        contentTypeParseStatus:
          typeof data.mime_type === "string" &&
          /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(data.mime_type)
            ? "valid"
            : data.mime_type == null
              ? "missing"
              : "invalid",
        status: "uploaded",
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        requestId: null,
      };
    } catch (error) {
      compat(error, "file.detail");
    }
  }
  async deleteFile(fileId: string): ReturnType<ManusV2Client["deleteFile"]> {
    validId(fileId);
    const record = await this.store.findByFile(this.identity, fileId);
    if (!record) fail("file.delete", "FILE_NOT_FOUND", false, 404);
    await this.once(
      record,
      `delete-file:${fileId}`,
      "file.delete",
      { fileId },
      async () => {
        await this.api.deleteFile(fileId);
        return fileId;
      },
      (runtime) => ({
        ...runtime,
        files: runtime.files.map((f) =>
          f.id === fileId ? { ...f, deleted: true } : f,
        ),
      }),
    );
    return { fileId, requestId: null };
  }
  private async attachments(
    input: readonly ManusV2Attachment[],
    record: DashboardRuntimeRecord,
  ) {
    const files: DashboardManagedFile[] = [];
    for (const attachment of input) {
      validFilename(attachment.filename);
      let id = attachment.file_id;
      if (!id) {
        // Original generated instructions include MIME parameters such as
        // `text/plain; charset=utf-8`; retain that full type and exact bytes.
        const match = /^data:([^,\r\n]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
          attachment.file_data ?? "",
        );
        if (
          !match ||
          match[1].toLowerCase() !== attachment.mime_type?.toLowerCase()
        )
          fail("task.create", "INLINE_FILE_INVALID", false, 400);
        const bytes = Buffer.from(match[2], "base64");
        if (!bytes.length || bytes.length > 20 * 1024 * 1024)
          fail("task.create", "INLINE_FILE_TOO_LARGE", false, 400);
        id = (
          await this.uploadFile({
            filename: attachment.filename,
            contentType: attachment.mime_type!,
            bytes,
          })
        ).fileId;
      }
      const owner = await this.store.findByFile(this.identity, id);
      const file = owner?.runtime.files.find((f) => f.id === id);
      if (
        !file ||
        file.deleted ||
        file.role !== "input" ||
        file.filename !== attachment.filename
      )
        fail("task.create", "ATTACHMENT_OWNERSHIP_INVALID");
      if (
        record.runtime.files.some(
          (old) =>
            old.serverOwned &&
            old.filename === file.filename &&
            old.id !== file.id,
        )
      )
        fail("task.sendMessage", "SYSTEM_INPUT_FILENAME_RESERVED", false, 400);
      files.push(file);
    }
    if (new Set(files.map((f) => f.filename)).size !== files.length)
      fail("task.create", "ATTACHMENT_FILENAME_CONFLICT", false, 400);
    await this.change(record, (runtime) => ({
      ...runtime,
      files: [
        ...runtime.files,
        ...files.filter((f) => !runtime.files.some((old) => old.id === f.id)),
      ],
    }));
    return files;
  }
  async createTask(
    input: Parameters<ManusV2Client["createTask"]>[0],
  ): ReturnType<ManusV2Client["createTask"]> {
    if (input.taskReferences?.length)
      fail("task.create", "ZHIPU_TASK_REFERENCES_UNSUPPORTED");
    const record = await this.reserve();
    if (record.runtime.intentId !== this.intent())
      fail("task.create", "PROVIDER_INITIAL_INTENT_CONFLICT");
    const files = await this.attachments(input.attachments ?? [], record);
    const systemFiles = await this.attachments(
      this.options.systemAttachments ?? [],
      record,
    );
    const mountedFiles = [...files, ...systemFiles];
    if (
      new Set(mountedFiles.map((file) => file.filename)).size !==
      mountedFiles.length
    )
      fail("task.create", "ATTACHMENT_FILENAME_CONFLICT", false, 400);
    if (systemFiles.length)
      await this.change(record, (runtime) => ({
        ...runtime,
        files: runtime.files.map((file) =>
          systemFiles.some((systemFile) => systemFile.id === file.id)
            ? { ...file, serverOwned: true }
            : file,
        ),
      }));
    const agentBody = {
      name: `FrontMind ${record.operationId}`,
      model: {
        id: record.runtime.model,
        effort: record.runtime.effort,
        speed: "standard",
      },
      system: this.options.systemContext
        ? `${SYSTEM}\n\n${this.options.systemContext}`
        : SYSTEM,
      tools: [{ type: "agent_toolset_20260601" }],
    };
    const agent = await this.once(
      record,
      "agent",
      "task.create",
      agentBody,
      async () =>
        zhipuResourceId(await this.api.create("/v1/agents", agentBody)),
      (runtime, id) => ({ ...runtime, agentId: id }),
    );
    const environmentBody = {
      name: `FrontMind ${record.operationId}`,
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: {
          pip: ["openpyxl", "xlrd", "python-docx", "lxml", "pypdf", "Pillow"],
        },
      },
    };
    const environment = await this.once(
      record,
      "environment",
      "task.create",
      environmentBody,
      async () =>
        zhipuResourceId(
          await this.api.create("/v1/environments", environmentBody),
        ),
      (runtime, id) => ({ ...runtime, environmentId: id }),
    );
    const body = {
      agent: { type: "agent", id: agent, version: 1 },
      environment_id: environment,
      title: input.title,
      metadata: {
        frontmind_operation: record.operationId,
        frontmind_intent: sha(this.intent()),
      },
      resources: mountedFiles.map((f) => ({
        type: "file",
        file_id: f.id,
        mount_path: `/input/${f.filename}`,
      })),
    };
    const sessionId = await this.once(
      record,
      "session",
      "task.create",
      body,
      async () => zhipuResourceId(await this.api.create("/v1/sessions", body)),
      (runtime, id) => ({ ...runtime, sessionId: id, title: input.title }),
    );
    const command = await this.sendCommand(
      await this.session(sessionId),
      input,
      files,
      true,
    );
    return {
      taskId: sessionId,
      taskUrl: null,
      taskTitle: input.title ?? null,
      requestId: command.eventId ?? null,
      raw: { id: sessionId, task_id: sessionId },
    };
  }
  private async readProvider<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      compat(error, operation);
    }
  }
  private async mount(
    record: DashboardRuntimeRecord,
    files: DashboardManagedFile[],
    commandKey: string,
  ) {
    const sessionId = record.runtime.sessionId!;
    const session = await this.api.request("GET", `/v1/sessions/${sessionId}`);
    if (session.status === "running" || session.status === "rescheduling")
      fail("task.sendMessage", "TASK_STILL_RUNNING");
    const resources = Array.isArray(session.resources)
      ? session.resources.map(object)
      : [];
    for (const file of files) {
      if (
        record.runtime.files.some(
          (old) =>
            old.serverOwned &&
            old.filename === file.filename &&
            old.id !== file.id,
        )
      )
        fail("task.sendMessage", "SYSTEM_INPUT_FILENAME_RESERVED", false, 400);
      const path = `/mnt/session/uploads/input/${file.filename}`;
      const occupied = resources.find((r) => r.mount_path === path);
      if (occupied?.file_id === file.id) continue;
      if (occupied) {
        const resourceId = zhipuResourceId(occupied);
        await this.once(
          record,
          `unmount:${commandKey}:${resourceId}`,
          "task.sendMessage",
          { sessionId, resourceId },
          async () => {
            await this.api.request(
              "DELETE",
              `/v1/sessions/${sessionId}/resources/${resourceId}`,
            );
            return resourceId;
          },
        );
      }
      const body = {
        type: "file",
        file_id: file.id,
        mount_path: `/input/${file.filename}`,
      };
      await this.once(
        record,
        `mount:${commandKey}:${file.id}`,
        "task.sendMessage",
        body,
        async () =>
          zhipuResourceId(
            await this.api.create(`/v1/sessions/${sessionId}/resources`, body),
          ),
      );
    }
  }
  private async connect(record: DashboardRuntimeRecord) {
    const sessionId = record.runtime.sessionId!;
    const streamKey = `${this.identity.accountUserId}:${record.localTaskId}:${sessionId}`;
    const existing = activeStreams.get(streamKey);
    if (existing) return existing;
    let ready!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((resolve, failed) => {
      ready = resolve;
      reject = failed;
    });
    activeStreams.set(streamKey, pending);
    void (async () => {
      let close: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stream = await this.api.subscribeEvents(sessionId);
        close = stream.close;
        timer = setTimeout(close, 60 * 60_000);
        timer.unref?.();
        ready();
        // Stream events are wake-up evidence only. Complete history is fetched
        // for business results; no new Dashboard execution-log UI is created.
        for await (const event of stream.events) {
          const id = zhipuResourceId(event);
          await this.change(record, (runtime) => ({
            ...runtime,
            observedEventIds: [
              ...new Set([...(runtime.observedEventIds ?? []), id]),
            ].slice(-200),
            ...(typeof event.processed_at === "string"
              ? { eventCursor: event.processed_at }
              : {}),
          }));
          if (
            event.type === "session.deleted" ||
            event.type === "session.status_terminated"
          )
            break;
        }
      } catch (error) {
        reject(error);
      } finally {
        if (timer) clearTimeout(timer);
        close?.();
        if (activeStreams.get(streamKey) === pending)
          activeStreams.delete(streamKey);
      }
    })();
    return pending;
  }
  private async sendCommand(
    record: DashboardRuntimeRecord,
    input: Pick<
      Parameters<ManusV2Client["createTask"]>[0],
      "prompt" | "structuredOutputSchema"
    >,
    files: DashboardManagedFile[],
    initial: boolean,
  ) {
    const intentId = this.intent();
    const key = initial ? "initial" : `turn:${sha(intentId)}`;
    const sessionId = record.runtime.sessionId!;
    const providerPrompt = zhipuTaskPrompt(input);
    const request = {
      sessionId,
      prompt: providerPrompt,
      attachments: files.map((f) => [f.id, f.sha256, f.filename]),
    };
    const matchesRequest = (command: DashboardManagedCommand) =>
      command.intentId === intentId &&
      command.providerPromptHash === sha(providerPrompt) &&
      JSON.stringify(
        command.attachments.map((f) => [f.fileId, f.sha256, f.filename]),
      ) === JSON.stringify(request.attachments);
    let command = record.runtime.commands.find((c) => c.key === key);
    if (command && !matchesRequest(command))
      fail("task.sendMessage", "PROVIDER_COMMAND_CONFLICT");
    if (command?.eventId) return command;
    const prior = record.runtime.mutations[`message:${key}`];
    if (
      command &&
      prior &&
      (prior.state === "sending" || prior.state === "outcome_unknown")
    ) {
      fail("task.sendMessage", "ZHIPU_MUTATION_OUTCOME_UNKNOWN", true);
    }
    if (!command) {
      const before = initial
        ? []
        : await this.api.listAll(`/v1/sessions/${sessionId}/events`, {
            order: "asc",
          });
      const previous = record.runtime.commands.at(-1);
      if (!initial && previous) {
        const start = before.findIndex(
          (event) => event.id === previous.eventId,
        );
        if (
          start < 0 ||
          !before
            .slice(start + 1)
            .some(
              (event) =>
                event.type === "session.status_idle" ||
                event.type === "session.error",
            )
        )
          fail("task.sendMessage", "TASK_STILL_RUNNING");
      }
      const existingFiles = initial
        ? []
        : await this.api.listAll("/v1/files", { scope_id: sessionId }, true);
      const fresh: DashboardManagedCommand = {
        key,
        intentId,
        prompt: input.prompt,
        providerPromptHash: sha(providerPrompt),
        attachments: files.map((f) => ({
          fileId: f.id,
          filename: f.filename,
          sha256: f.sha256,
        })),
        ...(input.structuredOutputSchema
          ? { schema: input.structuredOutputSchema }
          : {}),
        beforeEventIds: before.map(zhipuResourceId),
        beforeFileIds: existingFiles.map(zhipuResourceId),
        createdAt: new Date().toISOString(),
      };
      record = await this.change(record, (runtime) => {
        const raced = runtime.commands.find((c) => c.key === key);
        if (raced && !matchesRequest(raced))
          fail("task.sendMessage", "PROVIDER_COMMAND_CONFLICT");
        if (!raced && runtime.commands.at(-1)?.key !== previous?.key)
          fail("task.sendMessage", "PROVIDER_CONCURRENT_TURN_CONFLICT");
        return raced
          ? runtime
          : { ...runtime, commands: [...runtime.commands, fresh] };
      });
      command = record.runtime.commands.find((c) => c.key === key)!;
      if (command.eventId) return command;
    }
    if (!initial) await this.mount(record, files, key);
    await this.connect(record).catch((error) =>
      compat(error, initial ? "task.create" : "task.sendMessage"),
    );
    const id = await this.once(
      record,
      `message:${key}`,
      initial ? "task.create" : "task.sendMessage",
      request,
      async () => {
        const result = await this.api.sendMessage(sessionId, providerPrompt);
        return zhipuResourceId((result.data as unknown[])[0]);
      },
      (runtime, eventId) => ({
        ...runtime,
        commands: runtime.commands.map((c) =>
          c.key === key ? { ...c, eventId } : c,
        ),
      }),
    );
    return { ...command, eventId: id };
  }
  async sendMessage(
    input: Parameters<ManusV2Client["sendMessage"]>[0],
  ): ReturnType<ManusV2Client["sendMessage"]> {
    const record = await this.session(input.taskId);
    const files = await this.attachments(input.attachments ?? [], record);
    const command = await this.sendCommand(record, input, files, false);
    return {
      taskId: input.taskId,
      requestId: command.eventId ?? null,
      raw: { ok: true, task_id: input.taskId },
    };
  }
  async taskDetail(taskId: string): ReturnType<ManusV2Client["taskDetail"]> {
    const record = await this.session(taskId);
    try {
      const session = await this.api.request("GET", `/v1/sessions/${taskId}`);
      if (zhipuResourceId(session) !== taskId)
        fail("task.detail", "TASK_ID_CONFLICT");
      const events = await this.api.listAll(`/v1/sessions/${taskId}/events`, {
        order: "asc",
      });
      if (session.usage)
        await this.change(record, (runtime) => ({
          ...runtime,
          usage: object(session.usage),
        }));
      const status = currentSessionStatus(session, events, record.runtime);
      return {
        taskId,
        status,
        title: typeof session.title === "string" ? session.title : null,
        taskUrl: null,
        createdAt:
          stamp(session.created_at) === null
            ? null
            : stamp(session.created_at)! / 1000,
        updatedAt:
          stamp(session.updated_at) === null
            ? null
            : stamp(session.updated_at)! / 1000,
        requestId: null,
        raw: {
          id: taskId,
          task_id: taskId,
          status,
          title: session.title,
          provider: "zhipu",
        },
      };
    } catch (error) {
      compat(error, "task.detail");
    }
  }
  async findCreatedTask(
    _input: Parameters<ManusV2Client["findCreatedTask"]>[0],
  ): ReturnType<ManusV2Client["findCreatedTask"]> {
    const record = await this.store.findByIntent(this.identity, this.intent());
    const empty = {
      candidates: [],
      matches: [],
      unresolved: [],
      unresolvedEvidenceCount: 0,
      unique: null,
    };
    // A locally acknowledged task may be reused. Unknown sends require a
    // reset/new task; never reconstruct an old conversation from its history.
    if (
      !record?.runtime.sessionId ||
      !record.runtime.commands.find((command) => command.key === "initial")
        ?.eventId
    )
      return empty;
    const detail = await this.taskDetail(record.runtime.sessionId);
    const candidate = {
      id: record.runtime.sessionId,
      title: detail.title ?? "",
      taskUrl: null,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      creditUsage: null,
      status: detail.status,
    };
    return {
      ...empty,
      candidates: [candidate],
      matches: [candidate],
      unique: candidate,
    };
  }
  async listAllMessages(
    input: Parameters<ManusV2Client["listAllMessages"]>[0],
  ): Promise<ManusV2MessageEvent[]> {
    let record = await this.session(input.taskId);
    try {
      const order = input.order ?? "desc";
      const [session, fetched] = await Promise.all([
        this.api.request("GET", `/v1/sessions/${input.taskId}`),
        this.api.listAll(`/v1/sessions/${input.taskId}/events`, { order }),
      ]);
      const raw = order === "desc" ? [...fetched].reverse() : fetched;
      if (zhipuResourceId(session) !== input.taskId)
        fail("task.listMessages", "TASK_ID_CONFLICT");
      const events = normalizeDashboardZhipuEvents(raw, record.runtime);
      const files = await this.api.listAll(
        "/v1/files",
        { scope_id: input.taskId },
        true,
      );
      const projected = await this.projectOutputs(record, events, raw, files);
      if (session.usage)
        await this.change(record, (runtime) => ({
          ...runtime,
          usage: object(session.usage),
        }));
      const effectiveStatus = currentSessionStatus(
        session,
        raw,
        record.runtime,
      );
      const lastStatus = [...events]
        .reverse()
        .find((event) => event.type === "status_update");
      if (
        ["running", "cancelled", "error"].includes(effectiveStatus) &&
        object(lastStatus?.status_update).agent_status !== effectiveStatus
      ) {
        const command = record.runtime.commands.at(-1);
        if (command)
          projected.push({
            id: `zhipu_current_${sha(`${command.key}:${effectiveStatus}:${raw.at(-1)?.id ?? "pending"}`)}`,
            type: "status_update",
            timestamp:
              Math.max(
                stamp(command.createdAt) ?? 0,
                ...projected.map((event) => event.timestamp),
              ) + 1,
            providerOriginalRank: raw.length + 1,
            status_update: { agent_status: effectiveStatus },
            providerProjection: "zhipu_authoritative_session_state",
          });
      }
      const ordered = projected.sort(
        (a, b) =>
          a.timestamp - b.timestamp ||
          Number(a.providerOriginalRank) - Number(b.providerOriginalRank),
      );
      // Native listAllMessages always returns chronological events; order is
      // a pagination option, not the public return order.
      return ordered.map((e, rank) => ({ ...e, providerOriginalRank: rank }));
    } catch (error) {
      compat(error, "task.listMessages");
    }
  }
  private async projectOutputs(
    record: DashboardRuntimeRecord,
    events: ManusV2MessageEvent[],
    raw: ZhipuRecord[],
    files: ZhipuRecord[],
  ) {
    const result = [...events];
    const commands = record.runtime.commands.filter((c) => c.eventId);
    for (const command of commands) {
      const start = raw.findIndex((e) => e.id === command.eventId);
      if (start < 0) continue;
      const next = raw.findIndex(
        (e, index) => index > start && e.type === "user.message",
      );
      const scoped = raw.slice(start + 1, next < 0 ? undefined : next);
      const terminal = [...scoped]
        .reverse()
        .find((e) => e.type === "session.status_idle");
      if (!terminal) continue;
      const terminalIndex = scoped.indexOf(terminal);
      const failure = terminalSessionError(scoped.slice(0, terminalIndex + 1));
      const completed =
        object(terminal.stop_reason).type === "end_turn" && !failure;
      // A failed native run can still leave a complete structured deliverable.
      // Keep its error status; only the existing business parser can accept it.
      const failedStructuredDelivery = Boolean(command.schema && failure);
      const failedStatusDelivery = Boolean(
        this.options.recoverableStatusArtifact && failure,
      );
      if (!completed && !failedStructuredDelivery && !failedStatusDelivery)
        continue;
      if (
        scoped
          .slice(terminalIndex + 1)
          .some(
            (e) =>
              e.type === "session.status_running" ||
              e.type === "session.error" ||
              e.type === "user.interrupt",
          )
      )
        continue;
      const endedAt = stamp(terminal.processed_at);
      if (endedAt === null) continue;
      if (command.schema) {
        for (const final of [...scoped].reverse()) {
          if (final.type !== "agent.message") continue;
          let value: unknown;
          try {
            value = repairStructuredJsonCandidate(text(final.content)).value;
          } catch {
            // A closing sentence must not hide earlier usable JSON or files.
            continue;
          }
          result.push({
            id: `zhipu_structured_${sha(`${command.key}:${final.id}`)}`,
            type: "structured_output_result",
            timestamp: stamp(final.processed_at) ?? endedAt,
            providerOriginalRank: raw.indexOf(final) + 0.2,
            // Existing business parsers own the result contract. Transport
            // only removes a known JSON envelope; it adds no second validator.
            structured_output_result: { success: true, value },
            providerProjection: "zhipu_adapter_json",
          });
          break;
        }
      }
      const beganAt =
        stamp(raw[start].processed_at) ?? stamp(command.createdAt)!;
      const candidates = files.filter(
        (f) =>
          f.downloadable === true &&
          object(f.scope).id === record.runtime.sessionId &&
          !command.beforeFileIds.includes(String(f.id)) &&
          !record.runtime.files.some(
            (old) => old.id === f.id && old.role === "input",
          ) &&
          !record.runtime.files.some(
            (old) => old.role === "input" && old.filename === f.filename,
          ) &&
          typeof f.filename === "string" &&
          !/[\\/]/.test(f.filename) &&
          !/\.skill\.zip$/i.test(f.filename) &&
          (stamp(f.created_at) ?? -1) >= beganAt &&
          (stamp(f.created_at) ?? Infinity) <= endedAt,
      );
      if (!candidates.length) continue;
      const outputFiles: DashboardManagedFile[] = [];
      for (const file of candidates) {
        const id = zhipuResourceId(file);
        if (
          !Number.isSafeInteger(file.size_bytes) ||
          Number(file.size_bytes) < 1 ||
          Number(file.size_bytes) > MAX_FILE_BYTES
        )
          continue;
        validFilename(String(file.filename));
        const structuredFile = Boolean(
          command.schema &&
            /\.json$/iu.test(String(file.filename)) &&
            Number(file.size_bytes) <= 512 * 1024,
        );
        const recoverableStatusFile = Boolean(
          this.options.recoverableStatusArtifact?.(String(file.filename)) &&
            /\.json$/iu.test(String(file.filename)) &&
            Number(file.size_bytes) <= 256 * 1024,
        );
        if (!completed && !structuredFile && !recoverableStatusFile) continue;
        const prior = record.runtime.files.find((f) => f.id === id);
        if (prior?.commandKey && prior.commandKey !== command.key) continue;
        if (
          structuredFile &&
          prior &&
          (prior.filename !== file.filename ||
            prior.bytes !== Number(file.size_bytes))
        )
          fail("task.listMessages", "ARTIFACT_IDENTITY_CONFLICT");
        outputFiles.push(
          prior ?? {
            id,
            filename: String(file.filename),
            bytes: Number(file.size_bytes),
            sha256: "",
            contentType: String(file.mime_type ?? "application/octet-stream"),
            role: "output",
            commandKey: command.key,
          },
        );
        if (structuredFile) {
          // File bytes are authoritative output of this exact command/session.
          // Never reinterpret uploads, a different round or an oversized file.
          const downloaded = await this.api.downloadFile(id);
          if (
            downloaded.bytes.length !== Number(file.size_bytes) ||
            (prior?.sha256 && prior.sha256 !== sha(downloaded.bytes)) ||
            record.runtime.files.some(
              (input) =>
                input.role === "input" &&
                input.sha256 === sha(downloaded.bytes),
            )
          ) {
            fail("task.listMessages", "ARTIFACT_CONTENT_CONFLICT");
          }
          outputFiles[outputFiles.length - 1].sha256 = sha(downloaded.bytes);
          let value: unknown;
          try {
            value = repairStructuredJsonCandidate(
              downloaded.bytes.toString("utf8"),
            ).value;
          } catch {
            continue;
          }
          result.push({
            id: `zhipu_structured_file_${sha(`${command.key}:${id}:${sha(downloaded.bytes)}`)}`,
            type: "structured_output_result",
            timestamp: stamp(file.created_at) ?? endedAt,
            providerOriginalRank: raw.indexOf(terminal) + 0.1,
            structured_output_result: { success: true, value },
            providerProjection: "zhipu_adapter_json_file",
          });
        }
      }
      await this.change(record, (runtime) => ({
        ...runtime,
        files: [
          ...runtime.files.map(
            (file) =>
              outputFiles.find((output) => output.id === file.id) ?? file,
          ),
          ...outputFiles.filter(
            (f) => !runtime.files.some((old) => old.id === f.id),
          ),
        ],
      }));
      const attachmentFiles = completed
        ? outputFiles
        : outputFiles.filter((file) =>
            this.options.recoverableStatusArtifact?.(file.filename),
          );
      if (!attachmentFiles.length) continue;
      result.push({
        id: `zhipu_outputs_${sha(
          `${command.key}:${attachmentFiles
            .map((f) => f.id)
            .sort()
            .join(",")}`,
        )}`,
        type: "assistant_message",
        timestamp: endedAt,
        providerOriginalRank: raw.indexOf(terminal) + 0.3,
        assistant_message: {
          content: "",
          attachments: attachmentFiles.map((f) => ({
            file_id: f.id,
            filename: f.filename,
            content_type: f.contentType,
            url: `zhipu-file:${f.id}`,
          })),
        },
      });
    }
    return result;
  }
  async downloadArtifact(fileId: string) {
    validId(fileId);
    const record = await this.store.findByFile(this.identity, fileId, {
      localTaskId: this.options.localTaskId,
      operationId: this.options.operationId,
      role: "output",
    });
    const file = record?.runtime.files.find(
      (f) => f.id === fileId && f.role === "output" && !f.deleted,
    );
    if (
      !record ||
      !file?.commandKey ||
      (!this.options.localTaskId &&
        !this.options.operationId &&
        this.options.intentId &&
        record.runtime.intentId !== this.options.intentId)
    )
      fail("file.download", "ARTIFACT_OWNERSHIP_INVALID", false, 404);
    const data = await this.readProvider("file.download", () =>
      this.api.request("GET", `/v1/files/${fileId}`),
    );
    if (
      zhipuResourceId(data) !== fileId ||
      data.downloadable !== true ||
      object(data.scope).id !== record.runtime.sessionId ||
      data.filename !== file.filename ||
      data.size_bytes !== file.bytes
    )
      fail("file.download", "ARTIFACT_IDENTITY_CONFLICT");
    const downloaded = await this.readProvider("file.download", () =>
      this.api.downloadFile(fileId),
    );
    if (
      downloaded.bytes.length !== file.bytes ||
      record.runtime.files.some(
        (f) => f.role === "input" && f.sha256 === sha(downloaded.bytes),
      )
    )
      fail("file.download", "ARTIFACT_CONTENT_CONFLICT");
    const contentHash = sha(downloaded.bytes);
    if (file.sha256 && file.sha256 !== contentHash)
      fail("file.download", "ARTIFACT_CONTENT_CONFLICT");
    await this.change(record, (runtime) => ({
      ...runtime,
      files: runtime.files.map((f) =>
        f.id === fileId ? { ...f, sha256: contentHash } : f,
      ),
    }));
    return {
      status: 200,
      headers: { "content-type": downloaded.contentType },
      data: Readable.from(downloaded.bytes),
    };
  }
  async stopTask(taskId: string): ReturnType<ManusV2Client["stopTask"]> {
    const record = await this.session(taskId);
    const command = record.runtime.commands.at(-1);
    await this.once(
      record,
      `interrupt:${command?.key ?? "initial"}`,
      "task.stop",
      { taskId, command: command?.key },
      async () => {
        const result = await this.api.request(
          "POST",
          `/v1/sessions/${taskId}/events`,
          { events: [{ type: "user.interrupt" }] },
          (value) => {
            if (!Array.isArray(value.data) || value.data.length !== 1)
              throw new Error("INVALID_INTERRUPT_ACK");
            zhipuResourceId(value.data[0]);
          },
        );
        return zhipuResourceId((result.data as unknown[])[0]);
      },
    );
    return { taskId, requestId: null };
  }
  async deleteTask(taskId: string): ReturnType<ManusV2Client["deleteTask"]> {
    const record = await this.store.findBySession(
      this.identity,
      validId(taskId),
    );
    if (
      !record ||
      (this.options.localTaskId &&
        record.localTaskId !== this.options.localTaskId) ||
      (this.options.operationId &&
        record.operationId !== this.options.operationId)
    )
      fail("task.delete", "TASK_NOT_FOUND", false, 404);
    await this.once(
      record,
      "delete-session",
      "task.delete",
      { taskId },
      async () => {
        await this.api.request(
          "DELETE",
          `/v1/sessions/${taskId}`,
          undefined,
          (result) => {
            if (result.id !== taskId || result.deleted !== true)
              throw new Error("INVALID_DELETE_ACK");
          },
        );
        return taskId;
      },
      (runtime) => ({ ...runtime, deleted: true }),
    );
    return { taskId, requestId: null };
  }
  async confirmAction(
    input: Parameters<ManusV2Client["confirmAction"]>[0],
  ): ReturnType<ManusV2Client["confirmAction"]> {
    const record = await this.session(input.taskId);
    const value = input.confirmationInput ?? {};
    if (
      Object.keys(value).some((k) => !["result", "deny_message"].includes(k)) ||
      (value.result !== undefined &&
        !["allow", "deny"].includes(String(value.result)))
    )
      fail("task.confirmAction", "ACTION_INPUT_UNSUPPORTED");
    const body = {
      events: [
        {
          type: "user.tool_confirmation",
          tool_use_id: input.eventId,
          result: value.result ?? "allow",
          ...(value.deny_message
            ? { deny_message: String(value.deny_message) }
            : {}),
        },
      ],
    };
    const previous = record.runtime.mutations[`confirm:${input.eventId}`];
    if (previous?.state === "acknowledged") {
      if (previous.requestHash !== sha(JSON.stringify(body)))
        fail("task.confirmAction", "PROVIDER_MUTATION_CONFLICT");
      return { taskId: input.taskId, eventId: input.eventId, requestId: null };
    }
    const raw = await this.api.listAll(`/v1/sessions/${input.taskId}/events`, {
      order: "asc",
    });
    const event = raw.find((e) => e.id === input.eventId);
    if (
      !event ||
      !["agent.tool_use", "agent.mcp_tool_use"].includes(String(event.type))
    )
      fail("task.confirmAction", "ACTION_NOT_FOUND", false, 404);
    const latest = [...raw]
      .reverse()
      .find(
        (e) =>
          e.type === "session.status_idle" ||
          e.type === "session.status_running",
      );
    const reason = object(latest?.stop_reason);
    if (
      reason.type !== "requires_action" ||
      !Array.isArray(reason.event_ids) ||
      !reason.event_ids.includes(input.eventId)
    )
      fail("task.confirmAction", "ACTION_NOT_PENDING");
    await this.once(
      record,
      `confirm:${input.eventId}`,
      "task.confirmAction",
      body,
      async () => {
        const result = await this.api.request(
          "POST",
          `/v1/sessions/${input.taskId}/events`,
          body,
          (v) => {
            if (!Array.isArray(v.data) || v.data.length !== 1)
              throw new Error("INVALID_CONFIRM_ACK");
            zhipuResourceId(v.data[0]);
          },
        );
        return zhipuResourceId((result.data as unknown[])[0]);
      },
    );
    return { taskId: input.taskId, eventId: input.eventId, requestId: null };
  }
  async probeCredential(): ReturnType<ManusV2Client["probeCredential"]> {
    await this.readProvider("task.list", () =>
      this.api.request("GET", "/v1/agents?limit=1"),
    );
    return { ok: true, requestId: null };
  }
}

export function normalizeDashboardZhipuEvents(
  raw: ZhipuRecord[],
  runtime: DashboardManagedRuntime,
): ManusV2MessageEvent[] {
  return raw.flatMap((event, rank): ManusV2MessageEvent[] => {
    const id = zhipuResourceId(event);
    const command = runtime.commands.find((c) => c.eventId === id);
    const timestamp =
      stamp(event.processed_at) ?? (command ? stamp(command.createdAt) : null);
    if (timestamp === null) return [];
    const base = { id, timestamp, providerOriginalRank: rank };
    if (event.type === "user.message") {
      if (!command)
        return [
          {
            ...base,
            type: "user_message",
            user_message: { content: text(event.content) },
          },
        ];
      if (sha(text(event.content)) !== command.providerPromptHash)
        fail("task.listMessages", "PROVIDER_COMMAND_CONTENT_CONFLICT");
      return [
        {
          ...base,
          type: "user_message",
          user_message: {
            content: command.prompt,
            attachments: command.attachments.map((f) => ({
              file_id: f.fileId,
              filename: f.filename,
            })),
          },
          providerProjection: "zhipu_command_and_mount_ack",
        },
      ];
    }
    if (event.type === "agent.message")
      return [
        {
          ...base,
          type: "assistant_message",
          assistant_message: { content: text(event.content) },
        },
      ];
    if (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use")
      return [{ ...base, type: "tool_use" }];
    if (
      event.type === "agent.tool_result" ||
      event.type === "agent.mcp_tool_result"
    )
      return [
        { ...base, type: "tool_result", is_error: event.is_error === true },
      ];
    if (event.type === "user.interrupt")
      return [{ ...base, type: "user_stop", user_stop: {} }];
    if (
      event.type === "session.status_running" ||
      event.type === "session.status_rescheduled"
    )
      return [
        {
          ...base,
          type: "status_update",
          status_update: { agent_status: "running" },
        },
      ];
    if (
      event.type === "session.status_terminated" ||
      event.type === "session.deleted"
    )
      return [
        {
          ...base,
          type: "status_update",
          status_update: { agent_status: "cancelled" },
        },
      ];
    if (event.type === "session.error") {
      if (sessionErrorIsRetrying(event)) return [];
      return [
        {
          ...base,
          type: "status_update",
          status_update: sessionFailureStatus(event),
        },
      ];
    }
    if (event.type === "session.status_idle") {
      const failure = terminalSessionError(raw.slice(0, rank));
      if (failure)
        return [
          {
            ...base,
            type: "status_update",
            status_update: sessionFailureStatus(failure),
          },
        ];
      const reason = object(event.stop_reason);
      if (reason.type === "requires_action")
        return [
          {
            ...base,
            type: "status_update",
            status_update: {
              agent_status: "waiting",
              status_detail: {
                waiting_for_event_id: Array.isArray(reason.event_ids)
                  ? reason.event_ids[0]
                  : id,
                waiting_for_event_type: "provider_action",
                waiting_description: "上游执行需要补充输入或工具确认。",
                confirm_input_schema: {
                  type: "object",
                  properties: {
                    result: { type: "string", enum: ["allow", "deny"] },
                    deny_message: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
        ];
      return [
        {
          ...base,
          type: "status_update",
          status_update: {
            agent_status:
              reason.type === "end_turn"
                ? "stopped"
                : reason.type === "interrupted" ||
                    reason.type === "user_interrupt"
                  ? "cancelled"
                  : "error",
          },
        },
      ];
    }
    return [];
  });
}

export function createDashboardAgentClient(
  options: DashboardAgentClientOptions,
): DashboardAgentClient {
  return new ZhipuDashboardAgentProvider(options);
}
