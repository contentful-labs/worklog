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
