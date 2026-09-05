import crypto from "node:crypto";
import {
  formatFenAsYuan,
  parseYuanToFen,
  assertPositiveFen,
} from "./amount.js";
import {
  ZPAY_QUERY_URL,
  ZPAY_SUBMIT_URL,
  type ZpayConfiguration,
} from "./config.js";
import type { OnlinePaymentMethod } from "./contracts.js";
import { PaymentError } from "./errors.js";

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_QUERY_TIMEOUT_MS = 8_000;
const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1000;
const EARLIEST_SUPPORTED_PAYMENT_MS = Date.parse("2020-01-01T00:00:00.000Z");
const CALLBACK_TOKEN_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type ZpayCheckoutInput = {
  providerOrderId: string;
  amountFen: number;
  method: OnlinePaymentMethod;
  subject: string;
  callbackToken: string;
};

export type ZpayCheckout = {
  provider: "zpay";
  providerOrderId: string;
  amountFen: number;
  method: OnlinePaymentMethod;
  action: typeof ZPAY_SUBMIT_URL;
  httpMethod: "POST";
  fields: ZpayCheckoutFields;
};

export type ZpayCheckoutFields = {
  pid: string;
  type: OnlinePaymentMethod;
  out_trade_no: string;
  notify_url: string;
  return_url: string;
  name: string;
  money: string;
  param: string;
  cid?: string;
  sign: string;
  sign_type: "MD5";
};

export type ZpayExpectedOrder = {
  providerOrderId: string;
  amountFen: number;
  method: OnlinePaymentMethod;
};

export type ZpayOrderStatus =
  | {
      status: "pending";
      providerOrderId: string;
      amountFen: number;
      method: OnlinePaymentMethod;
    }
  | {
      status: "paid";
      providerOrderId: string;
      providerTradeNo: string;
      amountFen: number;
      method: OnlinePaymentMethod;
      providerCreatedAt: Date;
      paidAt: Date;
      payloadDigest: string;
    };

export type VerifiedZpayCallback = {
  status: "pending" | "paid";
  providerOrderId: string;
  providerTradeNo?: string;
  amountFen: number;
  method: OnlinePaymentMethod;
  callbackToken: string;
  payloadDigest: string;
};

export function canonicalizeZpayParameters(
  parameters: Readonly<Record<string, string>>,
): string {
  return Object.entries(parameters)
    .filter(
      ([key, value]) =>
        key !== "sign" && key !== "sign_type" && value.trim() !== "",
    )
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function signZpayParameters(
  parameters: Readonly<Record<string, string>>,
  merchantKey: string,
): string {
  return crypto
    .createHash("md5")
    .update(`${canonicalizeZpayParameters(parameters)}${merchantKey}`, "utf8")
    .digest("hex");
}

export function digestCallbackToken(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestZpayPayload(
  parameters: Readonly<Record<string, string>>,
): string {
  const canonical = Object.entries(parameters)
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
    .map(([key, value]) => [key, value] as const);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

export function isCallbackTokenDigest(value: string): boolean {
  return CALLBACK_TOKEN_DIGEST_PATTERN.test(value);
}

export function callbackTokenMatchesDigest(
  callbackToken: string,
  expectedDigest: string,
): boolean {
  return (
    isCallbackTokenDigest(expectedDigest) &&
    safeEqual(digestCallbackToken(callbackToken), expectedDigest)
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function assertProviderOrderId(value: string): string {
  if (!/^[1-9]\d{0,31}$/.test(value)) {
    throw new PaymentError(
      "支付订单号格式无效",
      "PAYMENT_REQUEST_INVALID",
      400,
    );
  }
  return value;
}

function assertCallbackToken(value: string): string {
  const token = value.trim();
  if (token.length < 16 || token.length > 4096) {
    throw new PaymentError("支付回调凭证无效", "PAYMENT_REQUEST_INVALID", 400);
  }
  return token;
}

function assertSubject(value: string): string {
  const subject = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!subject || subject.length > 128) {
    throw new PaymentError("支付订单标题无效", "PAYMENT_REQUEST_INVALID", 400);
  }
  return subject;
}

function normalizeProviderMethod(
  value: string | undefined,
): OnlinePaymentMethod | undefined {
  if (value === "alipay") return "alipay";
  if (value === "wxpay" || value === "wxpay2") return "wxpay";
  return undefined;
}

function callbackError(): PaymentError {
  return new PaymentError("支付通知验签失败", "PAYMENT_CALLBACK_INVALID", 400);
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseJsonValueLosslessly(body: string): unknown {
  const losslessIdentifiers = body.replace(
    /("(?:pid|out_trade_no|trade_no)"\s*:\s*)(\d+)(?=\s*[,}])/g,
    (_match, prefix: string, value: string) =>
      `${prefix}${JSON.stringify(value)}`,
  );
  return JSON.parse(losslessIdentifiers) as unknown;
}

function parseProviderRecord(body: string): Record<string, unknown> {
  try {
    const parsed = parseJsonValueLosslessly(body);
    const unwrapped =
      typeof parsed === "string" ? parseJsonValueLosslessly(parsed) : parsed;
    if (
      !unwrapped ||
      typeof unwrapped !== "object" ||
      Array.isArray(unwrapped)
    ) {
      throw new Error("not an object");
    }
    return unwrapped as Record<string, unknown>;
  } catch {
    throw new PaymentError(
      "支付渠道返回了无效结果",
      "PAYMENT_PROVIDER_RESPONSE_INVALID",
      502,
    );
  }
}

function normalizeProviderDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const chinaTime = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  const normalized = chinaTime
    ? `${chinaTime[1]}-${chinaTime[2]}-${chinaTime[3]}T${chinaTime[4]}:${chinaTime[5]}:${chinaTime[6]}+08:00`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const declaredLength = Number(lengthHeader);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_PROVIDER_RESPONSE_BYTES
    ) {
      throw new PaymentError(
        "支付渠道响应超过安全上限",
        "PAYMENT_PROVIDER_RESPONSE_INVALID",
        502,
      );
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new PaymentError(
          "支付渠道响应超过安全上限",
          "PAYMENT_PROVIDER_RESPONSE_INVALID",
          502,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

function assertProviderScope(
  result: Record<string, unknown>,
  expected: ZpayExpectedOrder,
  pid: string,
): OnlinePaymentMethod {
  let amountFen: number;
  try {
    amountFen = parseYuanToFen(textValue(result.money));
  } catch {
    throw new PaymentError(
      "支付渠道返回的订单范围不匹配",
      "PAYMENT_CALLBACK_SCOPE_MISMATCH",
      502,
    );
  }
  const method = normalizeProviderMethod(textValue(result.type));
  if (
    textValue(result.out_trade_no) !== expected.providerOrderId ||
    textValue(result.pid) !== pid ||
    amountFen !== expected.amountFen ||
    method !== expected.method
  ) {
    throw new PaymentError(
      "支付渠道返回的订单范围不匹配",
      "PAYMENT_CALLBACK_SCOPE_MISMATCH",
      502,
    );
  }
  return method;
}

export class ZpayClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly queryTimeoutMs: number;

  constructor(
    private readonly configuration: ZpayConfiguration,
    options: {
      fetchImpl?: typeof fetch;
      now?: () => Date;
      queryTimeoutMs?: number;
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  }

  createCheckout(input: ZpayCheckoutInput): ZpayCheckout {
    const providerOrderId = assertProviderOrderId(input.providerOrderId);
    const amountFen = assertPositiveFen(input.amountFen);
    const subject = assertSubject(input.subject);
    const callbackToken = assertCallbackToken(input.callbackToken);
    const unsignedFields: Omit<ZpayCheckoutFields, "sign" | "sign_type"> = {
      pid: this.configuration.pid,
      type: input.method,
      out_trade_no: providerOrderId,
      notify_url: this.configuration.notifyUrl,
      return_url: this.configuration.returnUrl,
      name: subject,
      money: formatFenAsYuan(amountFen),
      param: callbackToken,
      ...(this.configuration.cid ? { cid: this.configuration.cid } : {}),
    };
    const fields: ZpayCheckoutFields = {
      ...unsignedFields,
      sign: signZpayParameters(unsignedFields, this.configuration.key),
      sign_type: "MD5",
    };
    return {
      provider: "zpay",
      providerOrderId,
      amountFen,
      method: input.method,
      action: ZPAY_SUBMIT_URL,
      httpMethod: "POST",
      fields,
    };
  }

  verifyCallback(
    parameters: Readonly<Record<string, string>>,
  ): VerifiedZpayCallback {
    const sign = parameters.sign?.toLowerCase();
    if (
      parameters.sign_type?.toUpperCase() !== "MD5" ||
      !sign ||
      !/^[a-f0-9]{32}$/.test(sign)
    ) {
      throw callbackError();
    }
    const expectedSign = signZpayParameters(parameters, this.configuration.key);
    if (
      !safeEqual(sign, expectedSign) ||
      parameters.pid !== this.configuration.pid
    ) {
      throw callbackError();
    }

    const providerOrderId = parameters.out_trade_no;
    const callbackToken = parameters.param;
    const method = normalizeProviderMethod(parameters.type);
    if (!providerOrderId || !callbackToken || !method) throw callbackError();
    assertProviderOrderId(providerOrderId);
    const amountFen = parseYuanToFen(parameters.money);
    const paid = parameters.trade_status === "TRADE_SUCCESS";
    const providerTradeNo = parameters.trade_no?.trim();
    if (
      paid &&
      (!providerTradeNo ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(providerTradeNo))
    ) {
      throw callbackError();
    }
    return {
      status: paid ? "paid" : "pending",
      providerOrderId,
      ...(providerTradeNo ? { providerTradeNo } : {}),
      amountFen,
      method,
      callbackToken: assertCallbackToken(callbackToken),
      payloadDigest: digestZpayPayload(parameters),
    };
  }

  async queryOrder(expected: ZpayExpectedOrder): Promise<ZpayOrderStatus> {
    const providerOrderId = assertProviderOrderId(expected.providerOrderId);
    const amountFen = assertPositiveFen(expected.amountFen);
    const query = new URL(ZPAY_QUERY_URL);
    query.searchParams.set("act", "order");
    query.searchParams.set("pid", this.configuration.pid);
    query.searchParams.set("key", this.configuration.key);
    query.searchParams.set("out_trade_no", providerOrderId);

    let response: Response;
    try {
      response = await this.fetchImpl(query, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(this.queryTimeoutMs),
      });
    } catch {
      throw new PaymentError(
        "暂时无法查询支付结果",
        "PAYMENT_PROVIDER_UNAVAILABLE",
        502,
      );
    }
    if (!response.ok) {
      throw new PaymentError(
        "支付渠道查询失败",
        "PAYMENT_PROVIDER_UNAVAILABLE",
        502,
      );
    }
    const responseBody = await readBoundedResponseText(response);
    const result = parseProviderRecord(responseBody);
    const payloadDigest = crypto
      .createHash("sha256")
      .update(responseBody, "utf8")
      .digest("hex");
    if (String(result.code ?? "") !== "1") {
      const message = textValue(result.msg) ?? "";
      if (
        /(?:订单.*(?:不存在|未找到|未创建)|查询不到.*订单|order.*(?:not\s+found|missing))/i.test(
          message,
        )
      ) {
        return {
          status: "pending",
          providerOrderId,
          amountFen,
          method: expected.method,
        };
      }
      throw new PaymentError(
        "支付渠道拒绝了订单查询",
        "PAYMENT_PROVIDER_REJECTED",
        502,
      );
    }

    const method = assertProviderScope(
      result,
      { ...expected, providerOrderId, amountFen },
      this.configuration.pid,
    );
    if (String(result.status ?? "") !== "1") {
      return { status: "pending", providerOrderId, amountFen, method };
    }
    const providerTradeNo = textValue(result.trade_no);
    const providerCreatedAt = normalizeProviderDate(textValue(result.addtime));
    const paidAt = normalizeProviderDate(textValue(result.endtime));
    if (
      !providerTradeNo ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(providerTradeNo) ||
      !providerCreatedAt ||
      !paidAt ||
      providerCreatedAt.getTime() < EARLIEST_SUPPORTED_PAYMENT_MS ||
      paidAt.getTime() < providerCreatedAt.getTime() ||
      paidAt.getTime() > this.now().getTime() + MAX_PROVIDER_CLOCK_SKEW_MS
    ) {
      throw new PaymentError(
        "支付渠道返回的结算事实无效",
        "PAYMENT_PROVIDER_RESPONSE_INVALID",
        502,
      );
    }
    return {
      status: "paid",
      providerOrderId,
      providerTradeNo,
      amountFen,
      method,
      providerCreatedAt,
      paidAt,
      payloadDigest,
    };
  }
}
