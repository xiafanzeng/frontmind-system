import { KolProviderError, KolSubmissionUnknownError } from "./errors.js";
import {
  normalizeOrder,
  normalizePagination,
  normalizeResource,
} from "./normalize.js";
import {
  kolAuthenticationResponseSchema,
  kolCreateOrderResponseSchema,
  kolErrorEnvelopeSchema,
  kolOrderPageSchema,
  kolResourcePageSchema,
} from "./schemas.js";
import { KolTokenCache } from "./token.js";
import type {
  KolClientOptions,
  KolCreateOrderInput,
  KolCreateOrderResult,
  KolOrderPage,
  KolOrderQuery,
  KolProviderPort,
  KolResourcePage,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class KolClient implements KolProviderPort {
  readonly mode;
  private readonly origin: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxGetAttempts: number;
  private readonly getRetryBaseMs: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly tokenCache: KolTokenCache;
  private readonly authenticationMode: "access_token" | "login";

  constructor(private readonly options: KolClientOptions) {
    this.mode = options.mode;
    this.origin = validateOrigin(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.maxGetAttempts = positiveInteger(
      options.maxGetAttempts,
      3,
      "maxGetAttempts",
    );
    this.getRetryBaseMs = positiveInteger(
      options.getRetryBaseMs,
      300,
      "getRetryBaseMs",
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.userAgent =
      options.userAgent?.trim() || "frontmind-publisher-worker/0.1";
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.authenticationMode = options.accessToken?.trim()
      ? "access_token"
      : "login";
    this.tokenCache = new KolTokenCache((signal) => this.authenticate(signal), {
      refreshSkewMs: options.tokenRefreshSkewMs ?? 60_000,
      now: options.now ?? (() => new Date()),
    });
  }

  async listResources(
    page = 1,
    signal?: AbortSignal,
  ): Promise<KolResourcePage> {
    assertPositiveInteger(page, "page");
    const body = await this.authorizedGet(
      "list_resources",
      (token) => {
        const url = this.url("/api/news_resource_2/data");
        url.searchParams.set("token", token);
        url.searchParams.set("page", String(page));
        return { url, headers: this.commonHeaders() };
      },
      signal,
    );
    const parsed = kolResourcePageSchema.safeParse(body);
    if (!parsed.success || parsed.data.status !== 200) {
      throw invalidResponse(
        "list_resources",
        parsed.success ? parsed.data : parsed.error,
      );
    }
    return {
      resources: parsed.data.data.map((resource) =>
        normalizeResource(resource, this.origin),
      ),
      pagination: normalizePagination(parsed.data.pagination),
    };
  }

  async listOrders(
    query: KolOrderQuery = {},
    signal?: AbortSignal,
  ): Promise<KolOrderPage> {
    const body = await this.authorizedGet(
      "list_orders",
      (token) => {
        const url = this.url("/api/news_order");
        if (query.page !== undefined) {
          assertPositiveInteger(query.page, "page");
          url.searchParams.set("page", String(query.page));
        }
        if (query.id !== undefined) {
          assertPositiveInteger(query.id, "id");
          url.searchParams.set("id", String(query.id));
        }
        if (query.orderId !== undefined) {
          const orderId = normalizeOrderId(query.orderId);
          url.searchParams.set("order_id", orderId);
        }
        return {
          url,
          headers: {
            ...this.commonHeaders(),
            authorization: `Bearer ${token}`,
          },
        };
      },
      signal,
    );
    const parsed = kolOrderPageSchema.safeParse(body);
    if (!parsed.success || parsed.data.status !== 200) {
      throw invalidResponse(
        "list_orders",
        parsed.success ? parsed.data : parsed.error,
      );
    }
    const rows =
      parsed.data.data === null
        ? []
        : Array.isArray(parsed.data.data)
          ? parsed.data.data
          : [parsed.data.data];
    return {
      orders: rows.map(normalizeOrder),
      pagination: parsed.data.pagination
        ? normalizePagination(parsed.data.pagination)
        : undefined,
    };
  }

  async getOrderByOrderId(orderId: string, signal?: AbortSignal) {
    const normalized = normalizeOrderId(orderId);
    const page = await this.listOrders({ orderId: normalized }, signal);
    return page.orders.find((order) => order.orderId === normalized);
  }

  async createOrder(
    input: KolCreateOrderInput,
    signal?: AbortSignal,
  ): Promise<KolCreateOrderResult> {
    this.assertPublishingAllowed(input.resourceId);
    const encoding = this.options.createOrderEncoding ?? "unknown";
    if (encoding === "unknown") {
      throw new KolProviderError(
        "invalid_configuration",
        "KOL create-order encoding has not been verified",
        { operation: "create_order" },
      );
    }
    assertPositiveInteger(input.resourceId, "resourceId");
    const title = input.title.trim();
    const html = input.html.trim();
    if (!title || title.length > 1_000) throw new TypeError("title is invalid");
    if (!html || html.length > 2_000_000)
      throw new TypeError("html is invalid");

    // Resolve authentication before entering the non-idempotent send window.
    const token = await this.tokenCache.getToken({ signal });
    const payload = {
      token,
      title,
      content: html,
      resource_id: String(input.resourceId),
    };
    const request: RequestInit =
      encoding === "json"
        ? {
            method: "POST",
            headers: {
              ...this.commonHeaders(),
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          }
        : {
            method: "POST",
            headers: {
              ...this.commonHeaders(),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(payload),
          };

    let response: Response;
    let body: unknown;
    try {
      response = await this.fetchOnce(
        this.url("/api/news_order"),
        request,
        signal,
      );
      body = await readJson(response, this.maxResponseBytes);
    } catch (cause) {
      throw new KolSubmissionUnknownError(undefined, {}, { cause });
    }

    const envelope = kolErrorEnvelopeSchema.safeParse(body);
    const businessStatus = envelope.success ? envelope.data.status : undefined;
    const authenticationRejected = isAuthenticationRejected(
      response.status,
      businessStatus,
    );
    if (
      authenticationRejected ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500 ||
      businessStatus === 408 ||
      businessStatus === 429 ||
      (businessStatus !== undefined && businessStatus >= 500)
    ) {
      if (authenticationRejected) this.tokenCache.block();
      throw new KolSubmissionUnknownError(undefined, {
        httpStatus: authenticationRejected
          ? authenticationStatus(response.status, businessStatus)
          : response.status,
      });
    }
    if (!response.ok || (envelope.success && envelope.data.success === false)) {
      throw new KolProviderError(
        "order_rejected",
        safeProviderMessage(body, "KOL rejected the publication order"),
        { operation: "create_order", httpStatus: response.status },
      );
    }
    const parsed = kolCreateOrderResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.status !== 200 ||
      parsed.data.response_data.length !== 1 ||
      parsed.data.response_data[0]?.resource_id !== input.resourceId
    ) {
      throw new KolSubmissionUnknownError(
        "KOL returned an ambiguous create-order response; automatic retry is forbidden",
        { httpStatus: response.status },
      );
    }
    const item = parsed.data.response_data[0];
    return {
      orderId: item.order_id,
      resourceId: item.resource_id,
      resourceName: item.resource_name,
      paidAt: item.paid_at ?? undefined,
      message: parsed.data.message,
      raw: Object.freeze({ ...(body as Record<string, unknown>) }),
    };
  }

  private async authenticate(signal?: AbortSignal): Promise<string> {
    const accessToken = this.options.accessToken?.trim();
    if (accessToken) return accessToken;
    const credentials = {
      apiKey: this.options.apiKey?.trim(),
      mobile: this.options.mobile?.trim(),
      password: this.options.password?.trim(),
      identity: this.options.identity?.trim(),
      captcha: this.options.captcha?.trim(),
      captchaToken: this.options.captchaToken?.trim(),
    };
    if (
      !credentials.apiKey ||
      !credentials.mobile ||
      !credentials.password ||
      !credentials.identity ||
      !credentials.captcha ||
      !credentials.captchaToken
    ) {
      throw new KolProviderError(
        "invalid_configuration",
        "KOL six-field server credentials are incomplete",
        { operation: "authenticate" },
      );
    }
    const body = new URLSearchParams({
      mobile: credentials.mobile,
      password: credentials.password,
      api_key: credentials.apiKey,
      identity: credentials.identity,
      captcha: credentials.captcha,
      captcha_token: credentials.captchaToken,
    });
    let response: Response;
    let parsedBody: unknown;
    try {
      response = await this.fetchOnce(
        this.url("/api/auth/authenticate"),
        {
          method: "POST",
          headers: {
            ...this.commonHeaders(),
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        },
        signal,
      );
      parsedBody = await readJson(response, this.maxResponseBytes);
    } catch (cause) {
      throw new KolProviderError(
        "authentication_failed",
        "KOL authentication request failed before publication submission",
        { operation: "authenticate" },
        { cause },
      );
    }
    const parsed = kolAuthenticationResponseSchema.safeParse(parsedBody);
    if (!response.ok || !parsed.success || parsed.data.status !== 200) {
      throw new KolProviderError(
        "authentication_failed",
        "KOL authentication was rejected",
        { operation: "authenticate", httpStatus: response.status },
      );
    }
    return parsed.data.data.token;
  }

  private async authorizedGet(
    operation: string,
    createRequest: (token: string) => {
      url: URL;
      headers: Record<string, string>;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      let token: string;
      try {
        token = await this.tokenCache.getToken({
          forceRefresh: authAttempt === 1,
          signal,
        });
      } catch (error) {
        // A create-order 401 deliberately blocks further POSTs. A later safe
        // GET is the only automatic operation allowed to probe refreshed
        // credentials and clear that block.
        if (
          authAttempt === 0 &&
          this.authenticationMode === "login" &&
          error instanceof KolProviderError &&
          error.code === "authentication_blocked"
        ) {
          continue;
        }
        throw error;
      }
      const request = createRequest(token);
      const { response, body } = await this.safeGet(
        request.url,
        { method: "GET", headers: request.headers },
        operation,
        signal,
      );
      const envelope = kolErrorEnvelopeSchema.safeParse(body);
      const status = envelope.success ? envelope.data.status : undefined;
      const authenticationRejected = isAuthenticationRejected(
        response.status,
        status,
      );
      if (
        authenticationRejected &&
        authAttempt === 0 &&
        this.authenticationMode === "login"
      ) {
        this.tokenCache.invalidate();
        continue;
      }
      if (authenticationRejected) {
        this.tokenCache.block();
        throw new KolProviderError(
          "authentication_blocked",
          this.authenticationMode === "access_token"
            ? "KOL Worker access token was rejected; automatic login fallback is forbidden"
            : "KOL authentication failed after a safe GET token refresh",
          {
            operation,
            httpStatus: authenticationStatus(response.status, status),
          },
        );
      }
      if (response.status === 429 || status === 429) {
        throw new KolProviderError("rate_limited", "KOL rate limit reached", {
          operation,
          httpStatus: response.status,
          retryable: true,
        });
      }
      if (
        !response.ok ||
        response.status === 408 ||
        response.status >= 500 ||
        status === 408 ||
        (status !== undefined && status >= 500)
      ) {
        throw new KolProviderError(
          "upstream_unavailable",
          "KOL GET request failed",
          { operation, httpStatus: response.status, retryable: true },
        );
      }
      return body;
    }
    throw new KolProviderError(
      "authentication_blocked",
      "KOL authentication is blocked",
      { operation },
    );
  }

  private async safeGet(
    url: URL,
    init: RequestInit,
    operation: string,
    signal?: AbortSignal,
  ): Promise<{ response: Response; body: unknown }> {
    for (let attempt = 1; attempt <= this.maxGetAttempts; attempt += 1) {
      try {
        const response = await this.fetchOnce(url, init, signal);
        const body = await readJson(response, this.maxResponseBytes);
        const envelope = kolErrorEnvelopeSchema.safeParse(body);
        const businessStatus = envelope.success
          ? envelope.data.status
          : undefined;
        if (
          (retryableStatus(response.status) ||
            (businessStatus !== undefined &&
              retryableStatus(businessStatus))) &&
          attempt < this.maxGetAttempts
        ) {
          await this.sleep(retryDelay(response, attempt, this.getRetryBaseMs));
          continue;
        }
        return { response, body };
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (attempt < this.maxGetAttempts) {
          await this.sleep(backoff(attempt, this.getRetryBaseMs));
          continue;
        }
        if (cause instanceof KolProviderError) throw cause;
        throw new KolProviderError(
          "upstream_unavailable",
          "KOL GET request attempts were exhausted",
          { operation, retryable: true },
          { cause },
        );
      }
    }
    throw new KolProviderError(
      "upstream_unavailable",
      "KOL GET request attempts were exhausted",
      { operation, retryable: true },
    );
  }

  private async fetchOnce(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // Redirects are forbidden: 307/308 can replay a non-idempotent POST and
    // can also forward provider credentials to a different origin.
    return this.fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: combined,
    });
  }

  private assertPublishingAllowed(resourceId: number): void {
    if (!this.options.realEnabled || !this.options.publishEnabled) {
      throw new KolProviderError(
        "publishing_disabled",
        "KOL real publication is disabled by worker safety switches",
        { operation: "create_order" },
      );
    }
    if (this.mode === "test" && resourceId !== this.options.testResourceId) {
      throw new KolProviderError(
        "test_resource_required",
        "KOL TEST mode permits only the configured resource",
        { operation: "create_order" },
      );
    }
  }

  private commonHeaders(): Record<string, string> {
    return { accept: "application/json", "user-agent": this.userAgent };
  }

  private url(path: string): URL {
    return new URL(path, this.origin);
  }
}

function validateOrigin(value: string): URL {
  const parsed = new URL(value.endsWith("/") ? value : `${value}/`);
  if (parsed.protocol !== "https:")
    throw new TypeError("KOL baseUrl must use HTTPS");
  if (parsed.username || parsed.password)
    throw new TypeError("KOL baseUrl must not contain credentials");
  return parsed;
}

async function readJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new KolProviderError(
      "invalid_response",
      "KOL response exceeds configured size limit",
      { operation: "read_response", httpStatus: response.status },
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel("response size limit exceeded");
          throw new KolProviderError(
            "invalid_response",
            "KOL response exceeds configured size limit",
            { operation: "read_response", httpStatus: response.status },
          );
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new KolProviderError(
      "invalid_response",
      "KOL response is not valid JSON",
      { operation: "read_response", httpStatus: response.status },
      { cause },
    );
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  key: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1)
    throw new TypeError(`${key} must be a positive integer`);
  return normalized;
}

function assertPositiveInteger(value: number, key: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${key} must be a positive integer`);
}

function normalizeOrderId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128)
    throw new TypeError("orderId is invalid");
  return normalized;
}

function invalidResponse(operation: string, cause: unknown): KolProviderError {
  return new KolProviderError(
    "invalid_response",
    "KOL returned a response that does not match the verified schema",
    { operation, retryable: operation !== "create_order" },
    { cause },
  );
}

function safeProviderMessage(body: unknown, fallback: string): string {
  const envelope = kolErrorEnvelopeSchema.safeParse(body);
  return envelope.success && envelope.data.message
    ? envelope.data.message.replace(/[\r\n]+/gu, " ").slice(0, 1_000)
    : fallback;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAuthenticationRejected(
  httpStatus: number,
  businessStatus: number | undefined,
): boolean {
  return (
    httpStatus === 401 ||
    httpStatus === 403 ||
    businessStatus === 401 ||
    businessStatus === 403
  );
}

function authenticationStatus(
  httpStatus: number,
  businessStatus: number | undefined,
): 401 | 403 {
  return httpStatus === 403 || businessStatus === 403 ? 403 : 401;
}

function retryDelay(
  response: Response,
  attempt: number,
  baseMs: number,
): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1_000, 10_000)
    : backoff(attempt, baseMs);
}

function backoff(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), 10_000);
}
