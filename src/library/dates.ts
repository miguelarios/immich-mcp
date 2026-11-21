import { InputError } from "../errors.js";

/**
 * Turns the dates a model writes ("2024", "2024-06", "2024-06-15", or a full
 * ISO timestamp) into the UTC instants Immich's `takenAt` filter compares.
 *
 * Bare dates are calendar periods in the configured zone: "2024-06" means
 * June 2024 as the user lived it, not as UTC saw it. `takenFrom` is the first
 * instant of its period and `takenTo` the first instant after its period, so
 * both ends are inclusive of the whole day, month or year named.
 */

const PERIOD = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** The zone's offset from UTC, in minutes, at a given instant. */
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The UTC instant at which the wall clock in `timeZone` reads the given local time. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes settle DST edges: the offset at the guess can differ from the
  // offset at the answer by the size of the transition.
  let result = guess - offsetMinutes(guess, timeZone) * 60_000;
  result = guess - offsetMinutes(result, timeZone) * 60_000;
  return new Date(result);
}

function parsePeriod(
  value: string,
): { start: [number, number, number]; next: [number, number, number] } | null {
  const match = PERIOD.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  if (match[2] === undefined) return { start: [year, 1, 1], next: [year + 1, 1, 1] };
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  if (match[3] === undefined) {
    return {
      start: [year, month, 1],
      next: month === 12 ? [year + 1, 1, 1] : [year, month + 1, 1],
    };
  }
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const following = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    start: [year, month, day],
    next: [following.getUTCFullYear(), following.getUTCMonth() + 1, following.getUTCDate()],
  };
}

function parseTimestamp(value: string, timeZone: string): Date | null {
  if (!TIMESTAMP.test(value)) return null;
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  if (hasZone) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // No offset: a wall-clock time in the configured zone.
  const [datePart, timePart] = value.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, s = "0"] = timePart.split(":");
  return zonedToUtc(y, mo, d, timeZone, Number(h), Number(mi), Math.floor(Number(s)));
}

export interface TakenRange {
  gte?: string;
  lt?: string;
  lte?: string;
}

/** Builds the `takenAt` filter, or `undefined` when neither bound is given. */
export function takenRange(
  takenFrom: string | undefined,
  takenTo: string | undefined,
  timeZone: string,
): TakenRange | undefined {
  const range: TakenRange = {};

  if (takenFrom) {
    const period = parsePeriod(takenFrom.trim());
    const instant = period
      ? zonedToUtc(...period.start, timeZone)
      : parseTimestamp(takenFrom.trim(), timeZone);
    if (!instant) throw badDate("takenFrom", takenFrom);
    range.gte = instant.toISOString();
  }

  if (takenTo) {
    const period = parsePeriod(takenTo.trim());
    if (period) {
      range.lt = zonedToUtc(...period.next, timeZone).toISOString();
    } else {
      const instant = parseTimestamp(takenTo.trim(), timeZone);
      if (!instant) throw badDate("takenTo", takenTo);
      range.lte = instant.toISOString();
    }
  }

  const start = range.gte ? Date.parse(range.gte) : undefined;
  const end = range.lt ? Date.parse(range.lt) : range.lte ? Date.parse(range.lte) : undefined;
  if (start !== undefined && end !== undefined && start >= end) {
    throw new InputError(`takenFrom (${takenFrom}) must be before takenTo (${takenTo}).`);
  }

  return range.gte || range.lt || range.lte ? range : undefined;
}

function badDate(field: string, value: string): InputError {
  return new InputError(
    `${field} "${value}" is not a date. Use YYYY, YYYY-MM, YYYY-MM-DD, or an ISO timestamp like 2024-06-15T18:00.`,
  );
}

/**
 * Immich's `localDateTime` is the wall-clock time at the place the photo was
 * taken, serialized as if it were UTC. Strip the misleading `Z` and the
 * milliseconds so nobody converts it a second time.
 */
export function wallClock(localDateTime: string): string {
  return localDateTime.replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "");
}
