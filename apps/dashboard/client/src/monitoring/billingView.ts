const MONEY_SCALE = 10_000n;

function parseAtomic(value: string | undefined): bigint {
  if (!value || !/^-?\d+$/u.test(value)) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function formatCnyTenThousandths(
  value: string | undefined,
  options: {
    minimumFractionDigits?: 2 | 4;
    maximumFractionDigits?: 2 | 4;
  } = {},
) {
  const minimumFractionDigits = options.minimumFractionDigits ?? 2;
  const maximumFractionDigits = options.maximumFractionDigits ?? 2;
  const atomic = parseAtomic(value);
  const negative = atomic < 0n;
  const absolute = negative ? -atomic : atomic;
  const yuan = absolute / MONEY_SCALE;
  const grouped = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const rawFraction = (absolute % MONEY_SCALE).toString().padStart(4, "0");
  const fraction = rawFraction
    .slice(0, maximumFractionDigits)
    .replace(
      new RegExp(`0{0,${maximumFractionDigits - minimumFractionDigits}}$`, "u"),
      "",
    )
    .padEnd(minimumFractionDigits, "0");
  return `${negative ? "-" : ""}¥${grouped}.${fraction}`;
}

export function sumMoneyTenThousandths(values: Array<string | undefined>) {
  return values.reduce((sum, value) => sum + parseAtomic(value), 0n).toString();
}

export function subtractMoneyTenThousandths(
  minuend: string,
  subtrahend: string,
) {
  return (parseAtomic(minuend) - parseAtomic(subtrahend)).toString();
}

export function hasEnoughMoneyTenThousandths(
  available: string,
  required: string,
) {
  return parseAtomic(available) >= parseAtomic(required);
}

export function absoluteMoneyTenThousandths(value: string) {
  const amount = parseAtomic(value);
  return (amount < 0n ? -amount : amount).toString();
}

export function yuanInputToTenThousandths(
  value: string,
  options: { allowNegative?: boolean } = {},
) {
  const normalized = value.trim();
  const pattern = options.allowNegative
    ? /^-?(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/u
    : /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/u;
  const match = normalized.match(pattern);
  if (!match) return undefined;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [yuan, fraction = ""] = unsigned.split(".");
  const atomic =
    BigInt(yuan || "0") * MONEY_SCALE +
    BigInt(fraction.padEnd(2, "0") || "0") * 100n;
  return `${negative && atomic !== 0n ? "-" : ""}${atomic}`;
}

export function isTopupAmount(value: string | undefined) {
  if (!value) return false;
  const atomic = parseAtomic(value);
  return atomic >= 100_000n && atomic <= 500_000_000n && atomic % 100n === 0n;
}
