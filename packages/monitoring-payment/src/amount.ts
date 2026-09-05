import { PaymentError } from "./errors.js";

const TEN_THOUSANDTHS_PER_FEN = 100n;

export function assertPositiveFen(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentError(
      "支付金额必须是正整数分",
      "PAYMENT_REQUEST_INVALID",
      400,
    );
  }
  return value;
}

export function fenToTenThousandths(value: number): bigint {
  return BigInt(assertPositiveFen(value)) * TEN_THOUSANDTHS_PER_FEN;
}

export function tenThousandthsToFen(value: bigint): number {
  if (value <= 0n || value % TEN_THOUSANDTHS_PER_FEN !== 0n) {
    throw new PaymentError(
      "充值金额必须能够精确换算为人民币分",
      "PAYMENT_REQUEST_INVALID",
      400,
    );
  }
  const fen = value / TEN_THOUSANDTHS_PER_FEN;
  if (fen > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PaymentError(
      "充值金额超出支付渠道支持范围",
      "PAYMENT_REQUEST_INVALID",
      400,
    );
  }
  return Number(fen);
}

export function formatFenAsYuan(value: number): string {
  const fen = assertPositiveFen(value);
  const yuan = Math.floor(fen / 100);
  const remainder = fen % 100;
  return `${yuan}.${String(remainder).padStart(2, "0")}`;
}

export function parseYuanToFen(value: unknown): number {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw new PaymentError(
      "支付渠道返回了无效金额",
      "PAYMENT_PROVIDER_RESPONSE_INVALID",
      502,
    );
  }
  const [yuan = "0", decimal = ""] = text.split(".");
  const fen = Number(yuan) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(fen) || fen <= 0) {
    throw new PaymentError(
      "支付渠道返回了无效金额",
      "PAYMENT_PROVIDER_RESPONSE_INVALID",
      502,
    );
  }
  return fen;
}
