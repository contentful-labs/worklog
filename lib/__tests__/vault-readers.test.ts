import { describe, it, expect } from "vitest";
import { getWeekNumber, weekId, getExpectedBragBookWeeks } from "../sdk/week-utils";

describe("getWeekNumber", () => {
  it("returns correct ISO week for a known date", () => {
    // 2026-01-05 is a Monday → ISO week 2
    expect(getWeekNumber(new Date("2026-01-05"))).toBe(2);
  });

  it("returns week 1 for Jan 1 2026 (Thursday)", () => {
    // 2026-01-01 is a Thursday → ISO week 1
    expect(getWeekNumber(new Date("2026-01-01"))).toBe(1);
  });

  it("handles year boundary — Dec 31 2025 (Wednesday) → week 1 of 2026", () => {
    // 2025-12-31 is a Wednesday. ISO week: the Thursday of that week is 2026-01-01, so it's W01 of 2026
    expect(getWeekNumber(new Date("2025-12-31"))).toBe(1);
  });

  it("handles Dec 29 2025 (Monday) → week 1 of 2026", () => {
    // 2025-12-29 is Monday. Thursday of that week is Jan 1 2026 → W01
    expect(getWeekNumber(new Date("2025-12-29"))).toBe(1);
  });

  it("returns week 53 when applicable", () => {
    // 2020-12-31 (Thursday) → ISO week 53 of 2020
    expect(getWeekNumber(new Date("2020-12-31"))).toBe(53);
  });

  it("handles mid-year date", () => {
    // 2026-03-04 (Wednesday) → week 10
    expect(getWeekNumber(new Date("2026-03-04"))).toBe(10);
  });
});

describe("weekId", () => {
  it("formats standard week", () => {
    expect(weekId(10, 2026)).toBe("2026-W10");
  });

  it("pads single-digit week", () => {
    expect(weekId(3, 2026)).toBe("2026-W03");
  });

  it("handles week 53", () => {
    expect(weekId(53, 2020)).toBe("2020-W53");
  });
});

describe("getExpectedBragBookWeeks", () => {
  const now = new Date("2026-03-11T12:00:00Z"); // Wednesday of 2026-W11

  it("returns correct number of weeks", () => {
    const result = getExpectedBragBookWeeks(4, undefined, "2026-03-01", now);
    expect(result).toEqual(["2026-W06", "2026-W07", "2026-W08", "2026-W09"]);
  });

  it("skips the current week when no untilDate is given", () => {
    const result = getExpectedBragBookWeeks(3, undefined, undefined, now);
    expect(result).toEqual(["2026-W09", "2026-W10"]);
  });

  it("respects sinceDate boundary", () => {
    const result = getExpectedBragBookWeeks(52, "2026-02-01", "2026-03-01", now);
    // Should only span ~4 weeks between Feb 1 and Mar 1
    for (const wid of result) {
      expect(wid >= "2026-W05").toBe(true); // Feb 1 is around W05
    }
  });

  it("respects untilDate boundary", () => {
    const result = getExpectedBragBookWeeks(4, undefined, "2026-02-15", now);
    for (const wid of result) {
      expect(wid <= "2026-W07").toBe(true); // Feb 15 is W07
    }
  });

  it("excludes current week when no untilDate", () => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentWeek = getWeekNumber(now);
    const currentWeekId = weekId(currentWeek, currentYear);
    const result = getExpectedBragBookWeeks(4);
    expect(result).not.toContain(currentWeekId);
  });

  it("deduplicates weeks", () => {
    const result = getExpectedBragBookWeeks(2, undefined, "2026-03-01");
    const unique = new Set(result);
    expect(result.length).toBe(unique.size);
  });

  it("returns sorted results", () => {
    const result = getExpectedBragBookWeeks(4, undefined, "2026-03-01");
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });
});
