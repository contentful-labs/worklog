import { describe, it, expect } from "vitest";
import { getDateRange } from "../../lib/sdk/prep";

describe("getDateRange", () => {
  it("returns range for basic weeks count", () => {
    const result = getDateRange(4, undefined, "2026-03-01");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} to 2026-03-01$/);
    // 4 weeks back from Mar 1 → ~Feb 1
    expect(result).toContain("2026-02-01");
  });

  it("respects sinceDate", () => {
    const result = getDateRange(52, "2026-01-15", "2026-03-01");
    expect(result).toBe("2026-01-15 to 2026-03-01");
  });

  it("respects untilDate", () => {
    const result = getDateRange(4, undefined, "2026-02-15");
    expect(result).toMatch(/to 2026-02-15$/);
  });

  it("uses today when no untilDate", () => {
    const today = new Date().toISOString().split("T")[0];
    const result = getDateRange(4);
    expect(result).toMatch(new RegExp(`to ${today}$`));
  });

  it("uses sinceDate and untilDate together", () => {
    const result = getDateRange(99, "2025-06-01", "2026-03-01");
    expect(result).toBe("2025-06-01 to 2026-03-01");
  });
});
