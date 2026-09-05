const SCALE = 10_000n;

/** Convert an exact CNY decimal to FrontMind's 1/10,000-CNY integer unit. */
export function cnyDecimalToMinor(value: string): bigint {
  const normalized = value.trim().replaceAll(",", "");
  if (normalized.length > 64) {
    throw new RangeError("CNY amount is too large");
  }
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(normalized);
  if (!match)
    throw new TypeError("CNY amount must be a non-negative decimal string");
  const integer = match[1];
  const fraction = match[2] ?? "";
  if (!integer || fraction.length > 4) {
    throw new TypeError("CNY amount supports at most four decimal places");
  }
  const minor = BigInt(integer) * SCALE + BigInt(fraction.padEnd(4, "0"));
  if (minor > 9_999_999_999_999_999n)
    throw new RangeError("CNY amount is too large");
  return minor;
}

export function minorToCnyDecimal(value: bigint): string {
  if (value < 0n) throw new TypeError("CNY amount must not be negative");
  const integer = value / SCALE;
  const fraction = (value % SCALE)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

export function sumMinor(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) {
    if (value < 0n) throw new TypeError("CNY amount must not be negative");
    total += value;
  }
  return total;
}
