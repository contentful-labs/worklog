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
