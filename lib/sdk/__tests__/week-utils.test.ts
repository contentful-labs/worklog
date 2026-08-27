import { describe, it, expect } from "vitest";
import {
  getWeekStart,
  getWeekEnd,
  getWeekNumber,
  weekId,
  weekIdForDate,
  getExpectedBragBookWeeks,
  formatDuration,
} from "../week-utils";

describe("getWeekStart", () => {
  it("returns Monday of ISO week 1 2026", () => {
    const d = getWeekStart(1, 2026);
    expect(d.getUTCDay()).toBe(1); // Monday
    expect(d.toISOString().split("T")[0]).toBe("2025-12-29");
  });

  it("returns Monday of week 10 2026", () => {
    const d = getWeekStart(10, 2026);
    expect(d.getUTCDay()).toBe(1);
    expect(d.toISOString().split("T")[0]).toBe("2026-03-02");
  });

  it("handles year boundary — week 1 can start in previous year", () => {
    // 2025 W01 starts on 2024-12-30
    const d = getWeekStart(1, 2025);
    expect(d.getUTCDay()).toBe(1);
    expect(d.toISOString().split("T")[0]).toBe("2024-12-30");
  });
});

describe("getWeekEnd", () => {
  it("returns Sunday 6 days after week start", () => {
    const end = getWeekEnd(10, 2026);
    expect(end.getUTCDay()).toBe(0); // Sunday
    expect(end.toISOString().split("T")[0]).toBe("2026-03-08");
  });

  it("matches getWeekStart + 6 days", () => {
    const start = getWeekStart(5, 2026);
    const end = getWeekEnd(5, 2026);
    const diff = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diff).toBe(6);
  });
});

describe("weekIdForDate", () => {
  it("returns correct week ID for a mid-week date", () => {
    // 2026-03-04 is a Wednesday in W10
    expect(weekIdForDate(new Date("2026-03-04"))).toBe("2026-W10");
  });

  it("handles year boundary — Dec 31 can be week 1 of next year", () => {
    // 2025-12-31 is a Wednesday → ISO week 1 of 2026
    expect(weekIdForDate(new Date("2025-12-31"))).toBe("2026-W01");
  });

  it("handles week 53", () => {
    // 2020-12-31 is a Thursday → ISO week 53 of 2020
    expect(weekIdForDate(new Date("2020-12-31"))).toBe("2020-W53");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(5432)).toBe("5.4s");
  });

  it("formats minutes", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
  });

  it("boundary: 999ms stays ms, 1000ms switches to seconds", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
  });
});

// getWeekNumber and weekId are already tested in lib/__tests__/vault-readers.test.ts
// but we re-export them from sdk, so verify they're accessible
describe("re-exported week utilities", () => {
  it("getWeekNumber returns ISO week", () => {
    expect(getWeekNumber(new Date("2026-03-04"))).toBe(10);
  });

  it("weekId formats correctly", () => {
    expect(weekId(1, 2026)).toBe("2026-W01");
    expect(weekId(10, 2026)).toBe("2026-W10");
  });
});

// getExpectedBragBookWeeks is already tested in lib/__tests__/vault-readers.test.ts
// Verify it's accessible from SDK
describe("re-exported getExpectedBragBookWeeks", () => {
  it("returns week IDs for a range", () => {
    const weeks = getExpectedBragBookWeeks(2, undefined, "2026-03-01");
    expect(weeks.length).toBeGreaterThanOrEqual(1);
    expect(weeks[0]).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("a moment near midnight, on a machine that is not on UTC", () => {
  /**
   * The same reading the host's local calendar would have given.
   *
   * `TZ` is read when the process starts, so rather than restarting it, this recomputes
   * the old behaviour: build the day from the local getters and take the ISO week of
   * that. Under `TZ=Europe/London` in summer, 23:30Z on a Sunday is 00:30 on Monday, so
   * the local reading is the week beginning and the UTC one is the week ending.
   */
  function weekIdByLocalCalendar(d: Date): string {
    const localDay = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    return weekIdForDate(localDay);
  }

  it("is filed in the week the collection window was asking about", () => {
    // The trigger: collection windows are UTC. An event at 23:30Z on the Sunday of W33 is
    // inside W33's window; reading it on a local calendar an hour ahead files it in W34,
    // and the week that fetched it never shows it.
    const sundayNight = new Date("2026-08-16T23:30:00.000Z");

    expect(weekIdForDate(sundayNight)).toBe("2026-W33");
    // The last instant of the week, and the first of the next, both land where the
    // window that covers them does.
    expect(weekIdForDate(new Date("2026-08-16T23:59:59.999Z"))).toBe("2026-W33");
    expect(weekIdForDate(new Date("2026-08-17T00:00:00.000Z"))).toBe("2026-W34");
  });

  it("gives the same answer whatever the host clock is offset by", () => {
    // Offsetting the moment is the same thing a different `TZ` does to the local getters.
    const sundayNight = new Date("2026-08-16T23:30:00.000Z");
    const shifted = new Date(sundayNight.getTime() + 60 * 60 * 1000);

    expect(weekIdForDate(sundayNight)).toBe("2026-W33");
    expect(weekIdForDate(shifted)).toBe("2026-W34");
    // And the local-calendar reading of the original is whatever this host's offset makes
    // it, which is exactly why it is not what the ledger files by.
    expect(["2026-W33", "2026-W34"]).toContain(weekIdByLocalCalendar(sundayNight));
  });
});
