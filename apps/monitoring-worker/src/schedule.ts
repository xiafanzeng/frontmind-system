import { createHash } from "node:crypto";
import type { ScheduleForCatchUp, ScheduleOccurrenceInput } from "./ports.js";

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function localParts(date: Date, timezone: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(date)
      .filter((entry) => entry.type !== "literal")
      .map((entry) => [entry.type, Number(entry.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function localToUtc(parts: LocalParts, timezone: string): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = localParts(new Date(candidate), timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const adjustment = target - observedAsUtc;
    if (!adjustment) break;
    candidate += adjustment;
  }
  return new Date(candidate);
}

function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError("Schedule localTime must be HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59)
    throw new TypeError("Schedule localTime is outside the valid range");
  return { hour, minute };
}

function addLocalDay(
  parts: Pick<LocalParts, "year" | "month" | "day">,
  count = 1,
): LocalParts {
  const next = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + count),
  );
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function isoWeekday(parts: LocalParts): number {
  const day = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  return day === 0 ? 7 : day;
}

export function createScheduleOccurrenceId(
  scheduleId: string,
  scheduledAt: Date,
): string {
  return `so${createHash("sha256").update(`${scheduleId}\0${scheduledAt.toISOString()}`).digest("hex")}`.slice(
    0,
    64,
  );
}

export interface EnumeratedOccurrences {
  occurrences: readonly ScheduleOccurrenceInput[];
  scannedThrough: Date;
  hasMore: boolean;
}

// The scheduler materializes work once per minute. Treat the immediately due
// occurrence as an ordinary scheduled run; older occurrences are outage
// recovery and remain explicitly labelled as catch-up work.
const ON_TIME_GRACE_MS = 90_000;

/** Enumerates missed wall-clock occurrences in chronological order. */
export function enumerateScheduleOccurrences(
  schedule: ScheduleForCatchUp,
  through: Date,
  limit = 500,
): EnumeratedOccurrences {
  if (!Number.isInteger(limit) || limit < 1)
    throw new TypeError("limit must be a positive integer");
  const { hour, minute } = parseLocalTime(schedule.localTime);
  if (
    schedule.type === "weekly" &&
    (!schedule.weekday || schedule.weekday < 1 || schedule.weekday > 7)
  ) {
    throw new TypeError("Weekly schedules require weekday 1-7");
  }
  // Formatting validates the IANA time zone before any writes occur.
  const startLocal = localParts(
    schedule.materializedThrough,
    schedule.timezone,
  );
  const endLocal = localParts(through, schedule.timezone);
  let cursor = { ...startLocal, hour: 0, minute: 0, second: 0 };
  const endDateNumber = Date.UTC(
    endLocal.year,
    endLocal.month - 1,
    endLocal.day,
  );
  const occurrences: ScheduleOccurrenceInput[] = [];
  let lastScanned = schedule.materializedThrough;
  let hasMore = false;

  while (Date.UTC(cursor.year, cursor.month - 1, cursor.day) <= endDateNumber) {
    const scheduledAt = localToUtc(
      { ...cursor, hour, minute, second: 0 },
      schedule.timezone,
    );
    const dueOnDay =
      schedule.type === "daily" || isoWeekday(cursor) === schedule.weekday;
    if (
      dueOnDay &&
      scheduledAt > schedule.materializedThrough &&
      scheduledAt <= through
    ) {
      if (occurrences.length >= limit) {
        hasMore = true;
        break;
      }
      occurrences.push({
        occurrenceId: createScheduleOccurrenceId(
          schedule.scheduleId,
          scheduledAt,
        ),
        scheduleId: schedule.scheduleId,
        monitorId: schedule.monitorId,
        scheduledAt,
        trigger:
          through.getTime() - scheduledAt.getTime() > ON_TIME_GRACE_MS
            ? "catch_up"
            : "scheduled",
      });
      lastScanned = scheduledAt;
    } else {
      const dayEnd = localToUtc(
        { ...cursor, hour: 23, minute: 59, second: 59 },
        schedule.timezone,
      );
      if (dayEnd <= through) lastScanned = dayEnd;
    }
    cursor = addLocalDay(cursor);
  }

  if (!hasMore) lastScanned = through;
  return { occurrences, scannedThrough: lastScanned, hasMore };
}
