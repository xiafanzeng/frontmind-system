const INTERNAL_SCALE = 100_000_000n;
export const BRAND_TRACKING_CREDITS_PER_INTERNAL_UNIT = 1_000n;
const CREDIT_SCALE = INTERNAL_SCALE / BRAND_TRACKING_CREDITS_PER_INTERNAL_UNIT;

export const BRAND_TRACKING_CREDITS_INPUT_PATTERN =
  /^(?:0|[1-9]\d{0,14})(?:\.\d{1,5})?$/u;

function parseInternalAmount(value: string | null | undefined) {
  const match = value?.trim().match(/^(-?)(\d+)(?:\.(\d{1,8}))?$/u);
  if (!match) return null;
  const whole = match[2]!.replace(/^0+(?=\d)/u, "");
  if (whole.length > 12) return null;
  const fraction = (match[3] ?? "").padEnd(8, "0");
  const units = BigInt(whole) * INTERNAL_SCALE + BigInt(fraction || "0");
  return match[1] === "-" ? -units : units;
}

function parseCredits(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized || !BRAND_TRACKING_CREDITS_INPUT_PATTERN.test(normalized)) {
    return null;
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * CREDIT_SCALE + BigInt(fraction.padEnd(5, "0") || "0");
}

function decimalString(units: bigint, scale: bigint, fractionDigits: number) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / scale;
  const fraction = (absolute % scale)
    .toString()
    .padStart(fractionDigits, "0")
    .replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Convert the exact internal 8-decimal accounting amount to user-facing credits. */
export function brandTrackingAmountToCredits(value: string | null | undefined) {
  const units = parseInternalAmount(value);
  return units === null ? null : decimalString(units, CREDIT_SCALE, 5);
}

/** Convert user-entered credits back to the exact 8-decimal accounting amount. */
export function brandTrackingCreditsToAmount(value: string | null | undefined) {
  const creditUnits = parseCredits(value);
  if (creditUnits === null) return null;
  const whole = creditUnits / INTERNAL_SCALE;
  if (whole > 999_999_999_999n) return null;
  const fraction = (creditUnits % INTERNAL_SCALE).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
}

export function formatBrandTrackingCredits(
  value: string | null | undefined,
  options: { includeUnit?: boolean } = {},
) {
  const credits = brandTrackingAmountToCredits(value);
  if (credits === null) return "—";
  const [whole = "0", fraction = ""] = credits.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const unit = options.includeUnit === false ? "" : "积分";
  return `${grouped}${fraction ? `.${fraction}` : ""}${unit}`;
}

export function isPositiveBrandTrackingAmount(
  value: string | null | undefined,
) {
  const units = parseInternalAmount(value);
  return units !== null && units > 0n;
}
