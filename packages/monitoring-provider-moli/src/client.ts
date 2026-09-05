import {
  MoliApiError,
  MoliConfigurationError,
  MoliError,
  MoliHttpError,
  MoliResponseError,
  MoliSubmissionUnknownError,
  MoliTransportError,
} from "./errors.js";
import { MOLI_API_PATHS } from "./endpoints.js";
import { assertConsumerTaskId, createConsumerTaskId } from "./ids.js";
import {
  findArray,
  isRecord,
  normalizeBillingRecord,
  normalizeModel,
  normalizeRegion,
  normalizeResultItem,
  normalizeTaskStatus,
  numberValue,
  stringValue,
} from "./normalize.js";
import { parseProviderTimestamp } from "./timestamp.js";
import type {
  BillingQuery,
  MoliBalance,
  MoliBillingRecordsPage,
  MoliBillingSummary,
  MoliClientOptions,
  MoliModel,
  MoliRegion,
  MoliTaskResult,
  MoliTaskStatusResponse,
  SubmitSingleAttemptInput,
  SubmitTaskResponse,
} from "./types.js";

const DEFAULT_ORIGIN = "https://business-api.molizhishu.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface RequestOptions {
  body?: unknown;
  query?: Readonly<Record<string, string | number | undefined>>;
  signal?: AbortSignal;
  submissionConsumerTaskId?: string;
}

interface ProviderResponse {
  /** Unwrapped business payload used by normalizers. */
  data: unknown;
  /** Complete parsed provider envelope retained for audit archiving. */
  raw: unknown;
}

function submissionSubTaskId(
  data: Readonly<Record<string, unknown>>,
  totalTask: number | undefined,
): string | undefined {
  const subTasks = findArray(data, ["subTaskList", "subTasks"]);
  if (subTasks.length !== 1 || (totalTask !== undefined && totalTask !== 1)) {
    return undefined;
  }
  const [subTask] = subTasks;
  return isRecord(subTask)
    ? stringValue(subTask.subTaskId, subTask.subtaskId, subTask.id)
    : undefined;
}

function normalizeTaskResultResponse(
  taskId: string,
  response: ProviderResponse,
): MoliTaskResult {
  const { data } = response;
  const container = isRecord(data) ? data : {};
  const rawItems = findArray(data, [
    "subTaskList",
    "results",
    "resultList",
    "subTasks",
    "list",
    "records",
    "items",
  ]);
  const fallbackItems = rawItems.length
    ? rawItems
    : isRecord(data)
      ? [data]
      : [];
  return {
    taskId: stringValue(container.taskId, container.id) ?? taskId,
    status: normalizeTaskStatus(container.status ?? container.taskStatus),
    items: fallbackItems
      .map(normalizeResultItem)
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    raw: response.raw,
  };
}

function assertSingleAttemptInput(input: SubmitSingleAttemptInput): void {
  if (!input.prompt.trim()) throw new TypeError("prompt must not be empty");
  if (!input.platform.trim()) throw new TypeError("platform must not be empty");
  if ((input.monitorKeywordAliases?.length ?? 0) > 50) {
    throw new TypeError("monitorKeywordAliases must contain at most 50 values");
  }
  if ((input.competitors?.length ?? 0) > 50) {
    throw new TypeError("competitors must contain at most 50 values");
  }
  if (input.competitors?.some((competitor) => !competitor.name.trim())) {
    throw new TypeError("competitor names must not be empty");
  }
  if (input.competitors?.length && !input.monitorKeyword?.trim()) {
    throw new TypeError(
      "monitorKeyword is required when competitors are provided",
    );
  }
}

function assertBillingQuery(query: BillingQuery): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(query.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(query.endDate)
  ) {
    throw new TypeError("Billing startDate and endDate must use yyyy-MM-dd");
  }
  if (query.startDate > query.endDate)
    throw new TypeError("Billing startDate must not be after endDate");
  const start = new Date(`${query.startDate}T00:00:00.000Z`);
  const end = new Date(`${query.endDate}T00:00:00.000Z`);
  if (
    Number.isNaN(start.valueOf()) ||
    Number.isNaN(end.valueOf()) ||
    start.toISOString().slice(0, 10) !== query.startDate ||
    end.toISOString().slice(0, 10) !== query.endDate
  ) {
    throw new TypeError("Billing date range contains an invalid calendar date");
  }
  if (end.valueOf() - start.valueOf() > 30 * 86_400_000) {
    throw new TypeError(
      "Billing date range must not exceed 31 inclusive calendar days",
    );
  }
  if (
    query.pageSize !== undefined &&
    (!Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 1_000)
  ) {
    throw new TypeError("Billing pageSize must be between 1 and 1000");
  }
  if (
    query.pageNum !== undefined &&
    (!Number.isInteger(query.pageNum) || query.pageNum < 1)
  ) {
    throw new TypeError("Billing pageNum must be a positive integer");
  }
}

function apiFailure(body: unknown): {
  failed: boolean;
  code?: string | number;
  message?: string;
} {
  if (!isRecord(body)) return { failed: false };
  const success = body.success;
  const code =
    typeof body.code === "string" || typeof body.code === "number"
      ? body.code
      : undefined;
  const message = stringValue(body.message, body.msg, body.error);
  const failedByCode =
    code !== undefined &&
    ![0, 200, "0", "200", "SUCCESS", "success"].includes(code);
  return { failed: success === false || failedByCode, code, message };
}

function unwrapData(body: unknown): unknown {
  return isRecord(body) && "data" in body ? body.data : body;
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new MoliResponseError(
      "Provider response exceeds configured size limit",
      {
        contentLength: advertised,
        maxBytes,
      },
    );
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new MoliResponseError(
      "Provider response exceeds configured size limit",
      {
        contentLength: buffer.byteLength,
        maxBytes,
      },
    );
  }
  const text = new TextDecoder().decode(buffer);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new MoliResponseError(
      "Provider returned malformed JSON",
      { status: response.status },
      { cause },
    );
  }
}

export class MoliClient {
  readonly origin: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly userAgent: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoliClientOptions) {
    if (!options.token.trim())
      throw new MoliConfigurationError("MOLI_API_TOKEN must not be empty");
    this.token = options.token.trim();
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "frontmind-monitoring-worker/0.1";
  }

  async listModels(signal?: AbortSignal): Promise<readonly MoliModel[]> {
    const { data } = await this.request("GET", MOLI_API_PATHS.models, {
      signal,
    });
    return findArray(data, ["models", "list", "records", "items"])
      .map(normalizeModel)
      .filter((model): model is MoliModel => Boolean(model));
  }

  async listDomesticRegions(
    signal?: AbortSignal,
  ): Promise<readonly MoliRegion[]> {
    const { data } = await this.request("GET", MOLI_API_PATHS.domesticRegions, {
      signal,
    });
    return findArray(data, ["regions", "cities", "list", "records", "items"])
      .map((entry) => normalizeRegion(entry, "domestic"))
      .filter((region): region is MoliRegion => Boolean(region));
  }

  async listOverseasRegions(
    signal?: AbortSignal,
  ): Promise<readonly MoliRegion[]> {
    const { data } = await this.request("GET", MOLI_API_PATHS.overseasRegions, {
      signal,
    });
    return findArray(data, ["regions", "list", "records", "items"])
      .map((entry) => normalizeRegion(entry, "overseas"))
      .filter((region): region is MoliRegion => Boolean(region));
  }

  async submitSingleAttempt(
    input: SubmitSingleAttemptInput,
    signal?: AbortSignal,
  ): Promise<SubmitTaskResponse> {
    assertSingleAttemptInput(input);
    const consumerTaskId =
      input.consumerTaskId ?? createConsumerTaskId(input.attemptId);
    assertConsumerTaskId(consumerTaskId);
    const body = {
      ...(input.monitorKeyword?.trim()
        ? { monitorKeywords: input.monitorKeyword.trim() }
        : {}),
      monitorKeywordAliases: [
        ...new Set(
          input.monitorKeywordAliases
            ?.map((value) => value.trim())
            .filter(Boolean) ?? [],
        ),
      ],
      competitors:
        input.competitors?.map((competitor) => ({
          name: competitor.name.trim(),
          aliases: [
            ...new Set(
              competitor.aliases
                ?.map((value) => value.trim())
                .filter(Boolean) ?? [],
            ),
          ],
        })) ?? [],
      prompts: [input.prompt.trim()],
      platforms: [
        {
          platform: input.platform.trim(),
          mode: input.mode,
          screenshot: input.screenshot,
        },
      ],
      // Mobile clients do not support region selection. Use the verified
      // catalog dimension explicitly; provider codes are opaque and must never
      // be interpreted by naming convention.
      ...(input.regionCode?.trim() && input.clientType !== "mobile"
        ? { regionCode: [input.regionCode.trim()] }
        : {}),
      ...(input.callbackUrl?.trim()
        ? { callbackUrl: input.callbackUrl.trim() }
        : {}),
      consumerTaskId,
    };

    const response = await this.request("POST", MOLI_API_PATHS.submitTask, {
      body,
      signal,
      submissionConsumerTaskId: consumerTaskId,
    });
    const { data } = response;
    if (!isRecord(data)) {
      throw new MoliSubmissionUnknownError(
        "Task submission succeeded without recognizable task data; retry with the same consumerTaskId",
        consumerTaskId,
        { path: MOLI_API_PATHS.submitTask },
      );
    }
    const taskId = stringValue(data.taskId, data.id, data.monitorTaskId);
    if (!taskId) {
      throw new MoliSubmissionUnknownError(
        "Task submission response is missing taskId; retry with the same consumerTaskId",
        consumerTaskId,
        { path: MOLI_API_PATHS.submitTask },
      );
    }
    const created = parseProviderTimestamp(
      data.createdAt ?? data.createTime ?? data.timestamp,
    );
    const totalTaskCandidate = numberValue(
      data.totalTask,
      data.totalItems,
      data.total,
    );
    const totalTask =
      totalTaskCandidate !== undefined &&
      Number.isSafeInteger(totalTaskCandidate) &&
      totalTaskCandidate >= 0
        ? totalTaskCandidate
        : undefined;
    const subTaskId = submissionSubTaskId(data, totalTask);
    return {
      taskId,
      ...(subTaskId ? { subTaskId } : {}),
      ...(totalTask !== undefined ? { totalTask } : {}),
      consumerTaskId,
      createdAt: created?.date,
      rawCreatedAt: created?.raw,
      raw: response.raw,
    };
  }

  async getTaskStatus(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<MoliTaskStatusResponse> {
    const response = await this.request(
      "GET",
      MOLI_API_PATHS.taskStatus(taskId),
      { signal },
    );
    const { data } = response;
    if (!isRecord(data))
      throw new MoliResponseError("Status response does not contain task data");
    const updated = parseProviderTimestamp(
      data.updatedAt ?? data.updateTime ?? data.timestamp,
    );
    return {
      taskId: stringValue(data.taskId, data.id) ?? taskId,
      status: normalizeTaskStatus(data.status ?? data.taskStatus),
      total: numberValue(data.totalItems, data.total, data.totalCount),
      completed: numberValue(
        data.completedItems,
        data.completed,
        data.completedCount,
        data.successCount,
      ),
      failed: numberValue(data.failedItems, data.failed, data.failedCount),
      updatedAt: updated?.date,
      rawUpdatedAt: updated?.raw,
      raw: response.raw,
    };
  }

  async getTaskResult(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<MoliTaskResult> {
    const response = await this.request(
      "GET",
      MOLI_API_PATHS.taskResult(taskId),
      { signal },
    );
    return normalizeTaskResultResponse(taskId, response);
  }

  async getSubTaskResult(
    taskId: string,
    subTaskId: string,
    signal?: AbortSignal,
  ): Promise<MoliTaskResult> {
    const normalizedSubTaskId = subTaskId.trim();
    if (!normalizedSubTaskId)
      throw new TypeError("subTaskId must not be empty");
    const response = await this.request(
      "GET",
      MOLI_API_PATHS.subTaskResult(taskId, normalizedSubTaskId),
      { signal },
    );
    return normalizeTaskResultResponse(taskId, response);
  }

  async stopTask(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean; raw: unknown }> {
    const response = await this.request(
      "PUT",
      MOLI_API_PATHS.stopTask(taskId),
      {
        signal,
      },
    );
    const { data } = response;
    const accepted = !isRecord(data) || data.accepted !== false;
    return { accepted, raw: response.raw };
  }

  async getBalance(signal?: AbortSignal): Promise<MoliBalance> {
    const response = await this.request("GET", MOLI_API_PATHS.billingBalance, {
      signal,
    });
    const { data } = response;
    const record = isRecord(data) ? data : {};
    return {
      currentBalance: stringValue(record.currentBalance),
      available: stringValue(
        record.available,
        record.balance,
        record.availableBalance,
      ),
      frozen: stringValue(record.frozen, record.frozenBalance),
      currency: stringValue(record.currency, record.currencyCode),
      raw: response.raw,
    };
  }

  async getBillingSummary(
    query: BillingQuery,
    signal?: AbortSignal,
  ): Promise<MoliBillingSummary> {
    assertBillingQuery(query);
    const response = await this.request("POST", MOLI_API_PATHS.billingSummary, {
      body: query,
      signal,
    });
    const { data } = response;
    const record = isRecord(data) ? data : {};
    return {
      startDate: stringValue(record.startDate),
      endDate: stringValue(record.endDate),
      totalAmount: stringValue(
        record.totalConsume,
        record.totalAmount,
        record.amount,
        record.totalCost,
      ),
      taskCount: numberValue(record.taskCount, record.totalCount),
      raw: response.raw,
    };
  }

  async getBillingRecords(
    query: BillingQuery,
    signal?: AbortSignal,
  ): Promise<MoliBillingRecordsPage> {
    assertBillingQuery(query);
    const response = await this.request("POST", MOLI_API_PATHS.billingRecords, {
      body: query,
      signal,
    });
    const { data } = response;
    const record = isRecord(data) ? data : {};
    return {
      records: findArray(data, ["records", "list", "items"])
        .map(normalizeBillingRecord)
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
      page: numberValue(
        record.currentPage,
        record.page,
        record.pageNum,
        record.current,
      ),
      pageSize: numberValue(record.pageSize, record.size),
      total: numberValue(record.total, record.totalCount),
      raw: response.raw,
    };
  }

  private async request(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<ProviderResponse> {
    const url = new URL(`${this.origin}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("provider request timed out")),
      this.timeoutMs,
    );
    timeout.unref?.();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": this.userAgent,
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (cause) {
      clearTimeout(timeout);
      if (options.submissionConsumerTaskId) {
        throw new MoliSubmissionUnknownError(
          "Task submission outcome is unknown; retry with the same consumerTaskId",
          options.submissionConsumerTaskId,
          { path },
          { cause },
        );
      }
      throw new MoliTransportError(
        "Provider request failed",
        { path },
        { cause },
      );
    }

    try {
      const body = await readJsonResponse(response, this.maxResponseBytes);
      if (!response.ok) {
        const detail = apiFailure(body);
        if (options.submissionConsumerTaskId && response.status >= 500) {
          throw new MoliSubmissionUnknownError(
            "Task submission outcome is unknown after provider server error",
            options.submissionConsumerTaskId,
            {
              path,
              status: response.status,
              code: detail.code,
              message: detail.message,
            },
          );
        }
        throw new MoliHttpError(
          detail.message ?? `Provider HTTP ${response.status}`,
          response.status,
          {
            path,
            code: detail.code,
          },
        );
      }

      const failure = apiFailure(body);
      if (failure.failed) {
        throw new MoliApiError(
          failure.message ?? "Provider API rejected the request",
          failure.code,
          { path },
        );
      }
      return { data: unwrapData(body), raw: body };
    } catch (cause) {
      if (
        options.submissionConsumerTaskId &&
        cause instanceof MoliResponseError
      ) {
        throw new MoliSubmissionUnknownError(
          "Task submission outcome is unknown while reading the provider response",
          options.submissionConsumerTaskId,
          { path },
          { cause },
        );
      }
      if (cause instanceof MoliError) throw cause;
      if (options.submissionConsumerTaskId) {
        throw new MoliSubmissionUnknownError(
          "Task submission outcome is unknown while reading the provider response",
          options.submissionConsumerTaskId,
          { path },
          { cause },
        );
      }
      throw new MoliTransportError(
        "Provider response could not be read",
        { path },
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
