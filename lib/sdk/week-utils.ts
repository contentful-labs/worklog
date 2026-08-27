/**
 * ISO week date utilities — pure functions, no I/O.
 */

export function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export function weekId(week: number, year: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function weekIdForDate(d: Date): string {
  const wn = getWeekNumber(d);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const isoYear = utc.getUTCFullYear();
  return weekId(wn, isoYear);
}

export function getWeekStart(weekNumber: number, year: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
  const weekStart = new Date(firstMonday);
  weekStart.setUTCDate(firstMonday.getUTCDate() + (weekNumber - 1) * 7);
  return weekStart;
}

export function getWeekEnd(weekNumber: number, year: number): Date {
  const start = getWeekStart(weekNumber, year);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return end;
}

export function getExpectedBragBookWeeks(
  weeks: number,
  sinceDate?: string,
  untilDate?: string,
  now: Date = new Date(),
): string[] {
  const end = untilDate ? new Date(untilDate) : new Date(now);
  const result: string[] = [];

  const currentWeekId = weekIdForDate(now);
  const sinceWeekId = sinceDate ? weekIdForDate(new Date(sinceDate)) : undefined;

  for (let i = 0; i < weeks; i++) {
    const d = new Date(end);
    d.setDate(d.getDate() - i * 7);
    const wid = weekIdForDate(d);

    if (sinceWeekId && wid < sinceWeekId) break;
    if (!untilDate && wid === currentWeekId) continue;

    result.push(wid);
  }

  return [...new Set(result)].sort();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * `--since`, if it is a day that exists.
 *
 * The format check is not enough on its own: `2026-02-31` matches it, and `new Date`
 * rolls it forward to March 3 without complaint. Round-tripping the parsed date back to
 * a string is what catches a day that was never on the calendar.
 */
export function parseSince(value: string): string {
  const failure = new Error("--since must be a real date in YYYY-MM-DD form, for example 2026-01-31");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw failure;
  return value;
}

/**
 * `--week`, if that week exists in that year.
 *
 * Most ISO years have 52 weeks and some have 53, so the bound is the year's own last
 * week rather than a fixed number: asking for 2026-W53 should fail, and 2026-W99 should
 * not quietly become a range in 2027.
 */
export function parseWeek(value: string): string {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(value);
  if (!match) throw new Error("--week must be in YYYY-WNN form, for example 2026-W06");

  const year = Number.parseInt(match[1], 10);
  const week = Number.parseInt(match[2], 10);
  const last = weeksInYear(year);
  if (week < 1 || week > last) {
    throw new Error(`--week must be between ${year}-W01 and ${weekId(last, year)}; ${value} is not a week of ${year}`);
  }
  return weekId(week, year);
}

/** 52, or 53 in a long year. December 28 is always in the last ISO week of its year. */
function weeksInYear(year: number): number {
  return getWeekNumber(new Date(Date.UTC(year, 11, 28)));
}
