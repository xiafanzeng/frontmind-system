import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  ManusV2ApiError,
  ManusV2Client,
  type ManusV2MessageEvent,
  type ManusV2TaskSummary,
} from "../manus-v2-client";
import { getUpstreamBaseUrl } from "../upstream-config";
import {
  readPresalesV2Task,
  type PresalesV2TaskRecord,
  type ZhipuTaskRuntime,
} from "../presales-v2-store";
import {
  ZhipuManagedClient,
  ZhipuManagedError,
  zhipuResourceId,
  type ZhipuRecord,
} from "./zhipu-managed-client";
import { executionEventMessage } from "./execution-log-projector";

type UpdateTask = (
  id: string,
  mutate: (record: PresalesV2TaskRecord) => PresalesV2TaskRecord,
) => Promise<PresalesV2TaskRecord | null>;
type WebsiteClient = Pick<
  ManusV2Client,
  "uploadFile" | "createTask" | "findCreatedTask" | "listAllMessages"
>;
const activeStreams = new Map<string, Promise<void>>();
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const runtime = (record: PresalesV2TaskRecord): ZhipuTaskRuntime =>
  record.providerRuntime ?? { revision: 1, model: "glm-5.3", mutations: {} };
const RUNTIME_SYSTEM = `Execute the original FrontMind task and its supplied skill/workflow without changing their instructions, stage order, schemas or user confirmation points. Attached files are mounted read-only below /mnt/session/uploads/input with their original filenames. Copy workflow ZIPs byte-for-byte to /workspace/frontmind, safely extract a writable copy, and follow the supplied workflow entrypoint. Never treat the workflow ZIP itself as customer material. Use the installed tools to perform the task, including network/browser work when required; do not fabricate research or evidence. Stop at each user pause; do not choose or confirm on the user's behalf. Keep working files in /workspace/frontmind. Put only the requested final deliverables in /mnt/session/outputs. Do not include input files, internal skills, credentials, temporary files or intermediate work in outputs. For a structured JSON response, emit the exact requested JSON in the final public assistant message. This runtime instruction adapts paths and delivery only; preserve the original business task below.`;
export function zhipuTaskPrompt(
  input: Parameters<ManusV2Client["createTask"]>[0],
) {
  if (!input.structuredOutputSchema) return input.prompt;
  return `${input.prompt}\n\nRuntime delivery contract (the original skill and business input above remain unchanged): return exactly one JSON object in the final public assistant message. The frozen JSON Schema below defines the transport shape only; it does not replace or relax the original skill's business constraints or attached output schema. Satisfy both schemas: wherever the original skill is stricter, its stricter constraint still applies, even if the transport schema permits a value. Validate against the original skill's output schema and business rules as well as this transport schema before ending the turn. Do not invent evidence to satisfy either schema. Do not wrap JSON in Markdown or return the schema itself.\n${JSON.stringify(input.structuredOutputSchema)}`;
}

function asRecord(value: unknown): ZhipuRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ZhipuRecord)
    : {};
}
function messageText(content: unknown) {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(
            (block) => block?.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("\n")
      : "";
}
export function normalizeZhipuEvents(
  raw: ZhipuRecord[],
): ManusV2MessageEvent[] {
  return raw.flatMap((event, rank): ManusV2MessageEvent[] => {
    const timestamp = Date.parse(
      String(event.processed_at ?? event.created_at ?? ""),
    );
    if (!Number.isFinite(timestamp)) {
      if (event.processed_at == null && String(event.type).startsWith("user."))
        return [];
      throw new ManusV2ApiError(
        "task.listMessages",
        502,
        "INVALID_EVENT_TIMESTAMP",
        false,
        false,
      );
    }
    const base = {
      id: zhipuResourceId(event),
      timestamp,
      providerOriginalRank: rank,
    };
    if (event.type === "user.message")
      return [
        {
          ...base,
          type: "user_message",
          user_message: { content: messageText(event.content) },
        },
      ];
    if (event.type === "agent.message")
      return [
        {
          ...base,
          type: "assistant_message",
          assistant_message: { content: messageText(event.content) },
        },
      ];
    if (event.type === "agent.tool_use" || event.type === "agent.tool_result")
      return [{ ...base, type: event.type, is_error: event.is_error === true }];
    if (event.type === "session.status_running")
      return [
        {
          ...base,
          type: "status_update",
          status_update: { agent_status: "running" },
        },
      ];
    if (event.type === "session.status_idle") {
      const reason = asRecord(event.stop_reason);
      const stopped = reason.type === "end_turn";
      return [
        {
          ...base,
          type: "status_update",
          status_update: {
            agent_status: stopped
              ? "stopped"
              : reason.type === "requires_action"
                ? "waiting"
                : "error",
            ...(reason.type === "requires_action"
              ? {
                  status_detail: {
                    waiting_for_event_id: Array.isArray(reason.event_ids)
                      ? reason.event_ids[0]
                      : event.id,
                    waiting_for_event_type: "provider_action",
                    waiting_description: "上游执行需要补充输入或工具确认。",
                  },
                }
              : {}),
          },
        },
      ];
    }
    if (
      event.type === "session.error" &&
      asRecord(event.error).retry_status !== "retrying"
    )
      return [
        {
          ...base,
          type: "status_update",
          status_update: { agent_status: "error" },
        },
      ];
    return []; // Never persist or project reasoning or raw tool output.
  });
}
function compat(error: unknown, operation: string): never {
  if (error instanceof ManusV2ApiError) throw error;
  if (error instanceof ZhipuManagedError)
    throw new ManusV2ApiError(
      operation,
      error.status,
      `ZHIPU_${error.code}`,
      !error.outcomeUnknown &&
        (error.status === null ||
          error.status === 429 ||
          (error.status ?? 0) >= 500),
      error.outcomeUnknown,
    );
  throw error;
}

export class ZhipuWebsiteAgentProvider implements WebsiteClient {
  readonly api: ZhipuManagedClient;
  constructor(
    private readonly record: PresalesV2TaskRecord,
    private readonly update: UpdateTask,
    apiKey: string,
    api?: ZhipuManagedClient,
  ) {
    this.api = api ?? new ZhipuManagedClient({ apiKey });
  }
  private async current() {
    const value = await readPresalesV2Task(this.record.localTaskId);
    if (!value) throw new Error("TASK_RESERVATION_MISSING");
    return value;
  }
  /** Every side effect has a durable CAS before dispatch. No timeout/crash path
   * clears this fence or silently issues the same mutation a second time. */
  private async once(
    key: string,
    request: unknown,
    action: () => Promise<string>,
    onAck?: (state: ZhipuTaskRuntime, id: string) => ZhipuTaskRuntime,
  ): Promise<string> {
    const requestHash = digest(JSON.stringify(request));
    let owns = false;
    let existing: string | undefined;
    await this.update(this.record.localTaskId, (current) => {
      const state = runtime(current);
      const prior = state.mutations[key];
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new Error("PROVIDER_MUTATION_CONFLICT");
        if (prior.state === "acknowledged" && prior.resourceId) {
          existing = prior.resourceId;
          return current;
        }
        if (prior.state !== "rejected")
          throw new ManusV2ApiError(
            key.startsWith("file") ? "file.create" : "task.create",
            null,
            "ZHIPU_MUTATION_OUTCOME_UNKNOWN",
            false,
            true,
          );
        if (!prior.retryable || (prior.attempts ?? 1) >= 2)
          throw new ManusV2ApiError(
            key.startsWith("file") ? "file.create" : "task.create",
            prior.rejectionStatus ?? 400,
            prior.rejectionCode ?? "ZHIPU_MUTATION_REJECTED",
            false,
            false,
          );
      }
      owns = true;
      return {
        ...current,
        providerRuntime: {
          ...state,
          mutations: {
            ...state.mutations,
            [key]: {
              state: "sending",
              requestHash,
              startedAt: prior?.startedAt ?? new Date().toISOString(),
              lastAttemptAt: new Date().toISOString(),
              attempts: (prior?.attempts ?? (prior ? 1 : 0)) + 1,
            },
          },
        },
      };
    });
    if (existing) return existing;
    if (!owns) throw new Error("PROVIDER_MUTATION_NOT_CLAIMED");
    try {
      const id = await action();
      await this.update(this.record.localTaskId, (current) => {
        const state = runtime(current);
        const next = {
          ...state,
          mutations: {
            ...state.mutations,
            [key]: {
              ...state.mutations[key]!,
              state: "acknowledged" as const,
              resourceId: id,
            },
          },
        };
        return { ...current, providerRuntime: onAck ? onAck(next, id) : next };
      });
      return id;
    } catch (error) {
      await this.update(this.record.localTaskId, (current) => {
        const state = runtime(current);
        if (state.mutations[key]?.state === "acknowledged") return current;
        return {
          ...current,
          providerRuntime: {
            ...state,
            mutations: {
              ...state.mutations,
              [key]: {
                ...state.mutations[key]!,
                state:
                  error instanceof ZhipuManagedError && !error.outcomeUnknown
                    ? "rejected"
                    : "outcome_unknown",
                ...(error instanceof ZhipuManagedError && !error.outcomeUnknown
                  ? {
                      rejectionStatus: error.status,
                      rejectionCode: `ZHIPU_${error.code}`,
                      retryable: error.status === 429,
                    }
                  : {}),
              },
            },
          },
        };
      }).catch(() => undefined);
      compat(error, key.startsWith("file") ? "file.create" : "task.create");
    }
  }
  async uploadFile(
    input: Parameters<ManusV2Client["uploadFile"]>[0],
  ): ReturnType<ManusV2Client["uploadFile"]> {
    if (!input.bytes) throw new Error("ZHIPU_FROZEN_BYTES_REQUIRED");
    const bytes = input.bytes;
    const sha256 = digest(bytes);
    const key = `file:${digest(`${input.filename}\0${sha256}`)}`;
    const id = await this.once(
      key,
      { filename: input.filename, sha256, bytes: bytes.length },
      async () =>
        zhipuResourceId(
          await this.api.uploadFile({
            filename: input.filename,
            bytes,
            contentType: input.contentType,
          }),
        ),
      (state, id) => ({
        ...state,
        files: [
          ...(state.files ?? []),
          {
            id,
            filename: input.filename,
            sha256,
            bytes: bytes.length,
            role: "input",
          },
        ],
      }),
    );
    // Managed files have no presigned PUT and no provider expiry. The lease's
    // conservative local retention deadline never extends actual content use.
    const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const candidate = {
      fileId: id,
      filename: input.filename,
      uploadUrl: "",
      uploadExpiresAt: expires,
      requestId: null,
    };
    await input.observer?.onCandidateCreated?.(candidate);
    return {
      ...candidate,
      detail: {
        fileId: id,
        filename: input.filename,
        status: "uploaded",
        bytes: bytes.length,
        expiresAt: expires,
        contentType: input.contentType,
        contentTypeParseStatus: "valid",
        requestId: null,
      },
    };
  }
  private async connect(sessionId: string) {
    if (activeStreams.has(sessionId)) return;
    // Register before the first await so concurrent polls cannot open duplicate
    // consumers. History is always authoritative and can rebuild this view.
    let connected!: () => void;
    let rejected!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      connected = resolve;
      rejected = reject;
    });
    const consumer = (async () => {
      let close: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stream = await this.api.subscribeEvents(sessionId);
        close = stream.close;
        timer = setTimeout(close, 60 * 60_000);
        timer.unref?.();
        connected();
        for await (const raw of stream.events) {
          const normalized = normalizeZhipuEvents([raw]);
          const event = normalized[0];
          if (event) {
            const message = executionEventMessage(event);
            const id = `safeevt_${digest(`${this.record.localTaskId}\0${event.id}`)}`;
            await this.update(this.record.localTaskId, (current) => ({
              ...current,
              safeEvents: [
                ...current.safeEvents.filter((old) => old.id !== id),
                {
                  id,
                  type: event.type,
                  timestamp: event.timestamp,
                  ...(message ? { message } : {}),
                },
              ].slice(-200),
              providerRuntime: {
                ...runtime(current),
                eventCursor: String(raw.processed_at),
                observedEventIds: [
                  ...new Set([
                    ...(runtime(current).observedEventIds ?? []),
                    event.id,
                  ]),
                ].slice(-200),
              },
            }));
          }
          if (
            raw.type === "session.status_idle" ||
            raw.type === "session.deleted"
          )
            break;
        }
      } catch (error) {
        rejected(error);
      } finally {
        if (timer) clearTimeout(timer);
        close?.();
        activeStreams.delete(sessionId);
      }
    })();
    activeStreams.set(sessionId, consumer);
    await ready;
  }
  async createTask(
    input: Parameters<ManusV2Client["createTask"]>[0],
  ): ReturnType<ManusV2Client["createTask"]> {
    const providerPrompt = zhipuTaskPrompt(input);
    const frozenRuntime = runtime(await this.current());
    const agentBody = {
      name: `FrontMind Website ${this.record.operationId}`,
      model: frozenRuntime.effort
        ? {
            id: frozenRuntime.model,
            effort: frozenRuntime.effort,
            speed: "standard",
          }
        : frozenRuntime.model,
      system: RUNTIME_SYSTEM,
      tools: [{ type: "agent_toolset_20260601" }],
    };
    const agent = await this.once(
      "agent",
      agentBody,
      async () =>
        zhipuResourceId(await this.api.create("/v1/agents", agentBody)),
      (state, id) => ({ ...state, agentId: id }),
    );
    const environmentBody = {
      name: `FrontMind Website ${this.record.operationId}`,
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: {
          pip: ["openpyxl", "xlrd", "python-docx", "lxml", "pypdf", "Pillow"],
        },
      },
    };
    const environment = await this.once(
      "environment",
      environmentBody,
      async () =>
        zhipuResourceId(
          await this.api.create("/v1/environments", environmentBody),
        ),
      (state, id) => ({ ...state, environmentId: id }),
    );
    const resources = (input.attachments ?? []).map((attachment) => {
      if (!attachment.file_id || /[\\/\u0000]/u.test(attachment.filename))
        throw new Error("INVALID_MOUNT_FILENAME");
      return {
        type: "file",
        file_id: attachment.file_id,
        mount_path: `/input/${attachment.filename}`,
      };
    });
    const sessionBody = {
      agent: { type: "agent", id: agent, version: 1 },
      environment_id: environment,
      title: input.title,
      metadata: { frontmind_operation: this.record.operationId },
      resources,
    };
    const sessionId = await this.once(
      "session",
      sessionBody,
      async () =>
        zhipuResourceId(await this.api.create("/v1/sessions", sessionBody)),
      (state, id) => ({ ...state, sessionId: id }),
    );
    await this.connect(sessionId);
    const eventId = await this.once(
      "message:initial",
      { sessionId, prompt: providerPrompt },
      async () => {
        const result = await this.api.sendMessage(sessionId, providerPrompt);
        return zhipuResourceId((result.data as unknown[])[0]);
      },
      (state, id) => ({ ...state, commandEventIds: [id] }),
    );
    return {
      taskId: sessionId,
      taskUrl: null,
      taskTitle: input.title ?? null,
      requestId: eventId,
      raw: {},
    };
  }
  async findCreatedTask(
    input: Parameters<ManusV2Client["findCreatedTask"]>[0],
  ): ReturnType<ManusV2Client["findCreatedTask"]> {
    try {
      const current = await this.current();
      const state = runtime(current);
      const candidates: ManusV2TaskSummary[] = [];
      const matches: ManusV2TaskSummary[] = [];
      // We only reconcile the saved session. An unknown session-create result
      // cannot safely be inferred from title alone and requires operator review.
      if (state.sessionId) {
        const session = await this.api.request(
          "GET",
          `/v1/sessions/${state.sessionId}`,
        );
        const candidate = {
          id: state.sessionId,
          title: String(session.title ?? ""),
          taskUrl: null,
          createdAt: Date.parse(String(session.created_at)) / 1000,
          updatedAt: null,
          creditUsage: null,
          status: String(session.status ?? ""),
        };
        candidates.push(candidate);
        const events = await this.api.listAll(
          `/v1/sessions/${state.sessionId}/events`,
          { order: "asc" },
        );
        const command = state.mutations["message:initial"];
        const userEvents = events.filter(
          (event) => event.type === "user.message",
        );
        // One isolated session has exactly one unresolved command. Both the
        // marker and request hash must agree; duplicate user events are conflict.
        const acknowledged = userEvents.filter(
          (event) =>
            input.operationToken &&
            messageText(event.content).includes(
              `"operationToken":"${input.operationToken}"`,
            ) &&
            command?.requestHash ===
              digest(
                JSON.stringify({
                  sessionId: state.sessionId,
                  prompt: messageText(event.content),
                }),
              ),
        );
        if (acknowledged.length === 1 && userEvents.length === 1)
          matches.push(candidate);
      }
      return {
        candidates,
        matches,
        unresolved: candidates.filter((item) => !matches.includes(item)),
        unresolvedEvidenceCount: candidates.length - matches.length,
        unique: matches.length === 1 ? matches[0]! : null,
      };
    } catch (error) {
      compat(error, "task.listMessages");
    }
  }
  async listAllMessages(
    input: Parameters<ManusV2Client["listAllMessages"]>[0],
  ): Promise<ManusV2MessageEvent[]> {
    try {
      const current = await this.current();
      if (runtime(current).sessionId !== input.taskId)
        throw new Error("TASK_SESSION_CONFLICT");
      const session = await this.api.request(
        "GET",
        `/v1/sessions/${input.taskId}`,
      );
      if (session.status === "running" || session.status === "rescheduling")
        await this.connect(input.taskId).catch(() => undefined);
      // Full bounded historical pagination includes equal-time boundaries and
      // does not rely on SSE providing replay after process/browser restarts.
      const raw = await this.api.listAll(
        `/v1/sessions/${input.taskId}/events`,
        { order: "asc" },
      );
      const events = normalizeZhipuEvents(raw);
      await this.update(this.record.localTaskId, (record) => ({
        ...record,
        providerRuntime: {
          ...runtime(record),
          ...(session.usage && typeof session.usage === "object"
            ? { usage: asRecord(session.usage) }
            : {}),
          ...(raw.length
            ? { eventCursor: String(raw[raw.length - 1]!.processed_at) }
            : {}),
        },
      }));
      const lastStatus = [...events]
        .reverse()
        .find((event) => event.type === "status_update");
      if (asRecord(lastStatus?.status_update).agent_status === "stopped") {
        const inputNames = new Set(
          (runtime(current).files ?? [])
            .filter((file) => file.role === "input")
            .map((file) => file.filename),
        );
        const files = await this.api.listAll(
          "/v1/files",
          { scope_id: input.taskId },
          true,
        );
        const outputs = files.filter(
          (file) =>
            file.downloadable === true &&
            asRecord(file.scope).id === input.taskId &&
            typeof file.filename === "string" &&
            !inputNames.has(file.filename) &&
            !/\.skill\.zip$/iu.test(file.filename) &&
            !/[\\/]/u.test(file.filename),
        );
        if (outputs.length)
          events.push({
            id: `outputs_${digest(
              outputs
                .map((file) => file.id)
                .sort()
                .join("\0"),
            )}`,
            type: "assistant_message",
            timestamp: lastStatus!.timestamp,
            providerOriginalRank: events.length,
            assistant_message: {
              content: "",
              attachments: outputs.map((file) => ({
                filename: file.filename,
                content_type: file.mime_type,
                url: `zhipu-file:${zhipuResourceId(file)}`,
              })),
            },
          });
      }
      return events;
    } catch (error) {
      compat(error, "task.listMessages");
    }
  }
  async downloadArtifact(fileId: string) {
    const current = await this.current();
    const sessionId = runtime(current).sessionId;
    if (!sessionId) throw new Error("TASK_SESSION_MISSING");
    const files = await this.api.listAll(
      "/v1/files",
      { scope_id: sessionId },
      true,
    );
    const file = files.find(
      (value) =>
        value.id === fileId &&
        value.downloadable === true &&
        asRecord(value.scope).id === sessionId,
    );
    if (
      !file ||
      (runtime(current).files ?? []).some(
        (input) =>
          input.role === "input" &&
          (input.id === fileId || input.filename === file.filename),
      )
    )
      throw new Error("ARTIFACT_OWNERSHIP_INVALID");
    const result = await this.api.downloadFile(fileId);
    if (result.bytes.length !== file.size_bytes)
      throw new Error("ARTIFACT_BYTES_CONFLICT");
    const sha256 = digest(result.bytes);
    if (
      (runtime(current).files ?? []).some(
        (input) => input.role === "input" && input.sha256 === sha256,
      )
    )
      throw new Error("ARTIFACT_IS_INPUT_CONTENT");
    return {
      status: 200,
      headers: { "content-type": result.contentType },
      data: Readable.from(result.bytes),
    };
  }
}
export function createWebsiteAgentClient(
  apiKey: string,
  record: PresalesV2TaskRecord,
  update: UpdateTask,
): WebsiteClient {
  if (record.provider === "zhipu")
    return new ZhipuWebsiteAgentProvider(record, update, apiKey);
  if (record.provider && record.provider !== "manus")
    throw new Error("UNKNOWN_WEBSITE_PROVIDER");
  return new ManusV2Client({
    apiKey,
    baseUrl: getUpstreamBaseUrl(),
    rateLimitScope: "website-managed-provider",
  });
}
