import { describe, it, expect } from "vitest";
import {
  validateAtlassianUrl,
  validateEmail,
  validateISODate,
  parseCommaSeparated,
  parseTicketPrefixes,
  normalizeTicketPrefix,
  parseReviewCycleDates,
} from "../config";

describe("normalizeTicketPrefix", () => {
  it("strips trailing dashes so the value is a valid JQL project key", () => {
    expect(normalizeTicketPrefix("TEAM-")).toBe("TEAM");
    expect(normalizeTicketPrefix("team--")).toBe("TEAM");
    expect(normalizeTicketPrefix(" ops ")).toBe("OPS");
  });

  it("parseTicketPrefixes normalizes every entry and drops empties", () => {
    expect(parseTicketPrefixes("TEAM-, core, -")).toEqual(["TEAM", "CORE"]);
  });
});

describe("validateAtlassianUrl", () => {
  it("accepts valid atlassian.net URL", () => {
    expect(validateAtlassianUrl("https://company.atlassian.net")).toBeNull();
  });

  it("accepts URL with path", () => {
    expect(validateAtlassianUrl("https://company.atlassian.net/wiki")).toBeNull();
  });

  it("rejects non-atlassian.net domain", () => {
    expect(validateAtlassianUrl("https://example.com")).toBe(
      "URL should end with .atlassian.net (e.g. https://company.atlassian.net)"
    );
  });

  it("rejects invalid URL", () => {
    expect(validateAtlassianUrl("not-a-url")).toBe("Invalid URL");
  });

  it("rejects empty string", () => {
    expect(validateAtlassianUrl("")).toBe("Invalid URL");
  });
});

describe("validateEmail", () => {
  it("accepts valid email", () => {
    expect(validateEmail("user@example.com")).toBeNull();
  });

  it("rejects missing @", () => {
    expect(validateEmail("userexample.com")).toBe("Invalid email address");
  });

  it("rejects empty string", () => {
    expect(validateEmail("")).toBe("Invalid email address");
  });

  it("rejects email with spaces", () => {
    expect(validateEmail("user @example.com")).toBe("Invalid email address");
  });
});

describe("validateISODate", () => {
  it("accepts valid date", () => {
    expect(validateISODate("2026-01-15")).toBeNull();
  });

  it("rejects wrong format", () => {
    expect(validateISODate("01-15-2026")).toBe("Must be YYYY-MM-DD format");
  });

  it("rejects invalid date values", () => {
    expect(validateISODate("2026-13-45")).toBe("Must be YYYY-MM-DD format");
  });

  it("rejects empty string", () => {
    expect(validateISODate("")).toBe("Must be YYYY-MM-DD format");
  });

  it("rejects partial date", () => {
    expect(validateISODate("2026-01")).toBe("Must be YYYY-MM-DD format");
  });
});

describe("parseCommaSeparated", () => {
  it("parses normal comma-separated values", () => {
    expect(parseCommaSeparated("a, b, c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace", () => {
    expect(parseCommaSeparated("  a ,  b  , c  ")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCommaSeparated("")).toEqual([]);
  });

  it("handles trailing comma", () => {
    expect(parseCommaSeparated("a, b,")).toEqual(["a", "b"]);
  });

  it("handles single value", () => {
    expect(parseCommaSeparated("single")).toEqual(["single"]);
  });
});

describe("parseReviewCycleDates", () => {
  it("parses valid entries", () => {
    const result = parseReviewCycleDates("Self-review: 2026-06-01, Manager review: 2026-07-01");
    expect(result).toEqual([
      { type: "Self-review", date: "2026-06-01" },
      { type: "Manager review", date: "2026-07-01" },
    ]);
  });

  it("skips entries missing colon", () => {
    const result = parseReviewCycleDates("Self-review 2026-06-01");
    expect(result).toEqual([]);
  });

  it("skips entries with bad dates", () => {
    const result = parseReviewCycleDates("Review: not-a-date");
    expect(result).toEqual([]);
  });

  it("handles mixed valid and invalid entries", () => {
    const result = parseReviewCycleDates("Good: 2026-06-01, bad entry, Also good: 2026-07-01");
    expect(result).toEqual([
      { type: "Good", date: "2026-06-01" },
      { type: "Also good", date: "2026-07-01" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseReviewCycleDates("")).toEqual([]);
  });
});
