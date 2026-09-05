export interface ParsedProviderTimestamp {
  raw: string | number;
  date: Date;
  unit: "seconds" | "milliseconds" | "iso";
}

/** Preserves the source value while accepting both timestamp units used by the API docs. */
export function parseProviderTimestamp(
  value: unknown,
): ParsedProviderTimestamp | undefined {
  if (value === null || value === undefined || value === "") return undefined;

  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))
  ) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const unit =
      Math.abs(numeric) >= 1_000_000_000_000 ? "milliseconds" : "seconds";
    const date = new Date(unit === "milliseconds" ? numeric : numeric * 1_000);
    if (Number.isNaN(date.valueOf())) return undefined;
    return { raw: value, date, unit };
  }

  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return undefined;
  return { raw: value, date, unit: "iso" };
}
