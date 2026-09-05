const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function nextPublicationPollAt(submittedAt: Date, now: Date): Date {
  const age = Math.max(0, now.valueOf() - submittedAt.valueOf());
  if (age < 2 * HOUR) return new Date(now.valueOf() + 2 * MINUTE);
  if (age < 48 * HOUR) return new Date(now.valueOf() + 10 * MINUTE);
  if (age < 7 * DAY) return new Date(now.valueOf() + 6 * HOUR);
  return new Date(now.valueOf() + DAY);
}

export function safePublishedUrl(
  value: string | undefined,
): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}
