import { describe, it, expect } from "vitest";
import {
  getDateRange, getPromptFile, ensureFrontmatter, buildOutputFilename,
  PREP_TYPES, DEFAULT_WEEKS, OUTPUT_PREFIX,
} from "../prep";

describe("getDateRange", () => {
  it("returns range for basic weeks count", () => {
    const result = getDateRange(4, undefined, "2026-03-01");
    expect(result).toContain("2026-02-01");
    expect(result).toMatch(/to 2026-03-01$/);
  });

  it("respects sinceDate over weeks", () => {
    const result = getDateRange(52, "2026-01-15", "2026-03-01");
    expect(result).toBe("2026-01-15 to 2026-03-01");
  });

  it("uses today when no untilDate", () => {
    const today = new Date().toISOString().split("T")[0];
    const result = getDateRange(4);
    expect(result).toMatch(new RegExp(`to ${today}$`));
  });
});

describe("getPromptFile", () => {
  it("returns standard prompt file for non-extended", () => {
    expect(getPromptFile("1on1", false)).toBe("prep-1on1.md");
    expect(getPromptFile("self-review", false)).toBe("prep-self-review.md");
  });

  it("returns extended prompt for self-review", () => {
    expect(getPromptFile("self-review", true)).toBe("prep-self-review-extended.md");
  });

  it("ignores extended flag for non-self-review types", () => {
    expect(getPromptFile("1on1", true)).toBe("prep-1on1.md");
  });
});

describe("ensureFrontmatter", () => {
  it("adds frontmatter when missing", () => {
    const result = ensureFrontmatter("# My Doc\nContent");
    expect(result).toMatch(/^---\ntags:/);
    expect(result).toContain("# My Doc");
  });

  it("preserves existing frontmatter", () => {
    const input = "---\ntags:\n  - custom\n---\n\n# Doc";
    expect(ensureFrontmatter(input)).toBe(input);
  });
});

describe("buildOutputFilename", () => {
  it("includes prep type and date", () => {
    const date = new Date("2026-03-05T00:00:00Z");
    expect(buildOutputFilename("1on1", date)).toBe("1on1 Prep 2026-03-05.md");
    expect(buildOutputFilename("promotion", date)).toBe("Promotion Case 2026-03-05.md");
  });
});

describe("constants", () => {
  it("PREP_TYPES has all expected types", () => {
    expect(PREP_TYPES).toContain("1on1");
    expect(PREP_TYPES).toContain("self-review");
    expect(PREP_TYPES).toContain("promotion");
  });

  it("DEFAULT_WEEKS has values for all types", () => {
    for (const type of PREP_TYPES) {
      expect(DEFAULT_WEEKS[type]).toBeGreaterThan(0);
    }
  });

  it("OUTPUT_PREFIX has values for all types", () => {
    for (const type of PREP_TYPES) {
      expect(OUTPUT_PREFIX[type]).toBeTruthy();
    }
  });
});
