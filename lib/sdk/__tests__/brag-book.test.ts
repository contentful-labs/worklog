import { describe, it, expect } from "vitest";
import { toBragBookResult, parseReviewCycle, ensureBragBookFrontmatter } from "../brag-book";
import { bragBookOutputSchema, type BragBookOutput } from "../brag-book-schema";

const emptyOutput: BragBookOutput = {
  bragBookMarkdown: "# Brag Book",
  memoryItemsToAdd: [],
  memoryGraduations: [],
  impactLogEntry: null,
  workContextUpdates: [],
  profileUpdate: null,
  focusStatuses: [],
  newFocusItems: [],
};

function output(overrides: Partial<BragBookOutput>): BragBookOutput {
  return { ...emptyOutput, ...overrides };
}

describe("bragBookOutputSchema", () => {
  it("accepts a fully empty week", () => {
    expect(bragBookOutputSchema.parse(emptyOutput)).toEqual(emptyOutput);
  });

  it("rejects a focus status outside the allowed set", () => {
    // `open` is what a model reaches for, and it is the one value that must not get
    // through: applyFocusUpdates treats any non-pending status as an answered item.
    const bad = { ...emptyOutput, focusStatuses: [{ id: "2026-W09.1", status: "open", notes: "" }] };
    expect(bragBookOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing field rather than filling in a default", () => {
    const { focusStatuses, ...withoutFocus } = emptyOutput;
    expect(focusStatuses).toEqual([]);
    expect(bragBookOutputSchema.safeParse(withoutFocus).success).toBe(false);
  });

  it("rejects a memory item that is missing its category", () => {
    const bad = { ...emptyOutput, memoryItemsToAdd: [{ date: "2026-03-05", item: "Fixed a flake", notes: "" }] };
    expect(bragBookOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe("toBragBookResult", () => {
  it("renders memory items as table rows in memory.md column order", () => {
    const result = toBragBookResult(
      output({
        memoryItemsToAdd: [
          { date: "2026-03-05", item: "Fixed a flaky test", category: "bugfix", notes: "Part of a reliability push" },
        ],
      }),
    );

    expect(result.itemsToAdd).toEqual(["| 2026-03-05 | Fixed a flaky test | bugfix | Part of a reliability push |"]);
  });

  it("escapes pipes in memory items so a row cannot split a table", () => {
    const result = toBragBookResult(
      output({ memoryItemsToAdd: [{ date: "2026-03-05", item: "Renamed a | b", category: "docs", notes: "" }] }),
    );

    expect(result.itemsToAdd).toEqual(["| 2026-03-05 | Renamed a \\| b | docs |  |"]);
  });

  it("keeps the graduation phrasing updateMemory splits on", () => {
    const result = toBragBookResult(
      output({ memoryGraduations: [{ item: "Three small perf PRs", nowPartOf: "Search latency initiative" }] }),
    );

    expect(result.itemsToRemove).toEqual(["Three small perf PRs (now part of: Search latency initiative)"]);
    expect(result.itemsToRemove[0].split("(now part of")[0].trim()).toBe("Three small perf PRs");
  });

  it("passes impact, work context and profile through unchanged", () => {
    const impactLogEntry = {
      date: "2026-03-05",
      achievement: "Shipped auth",
      scope: "Team",
      coreValue: "quality",
      evidence: "TEAM-1234 merged",
    };
    const profileUpdate = { achievement: "Led auth migration", bulletPoint: "Designed and shipped OAuth integration" };
    const workContextUpdates = [{ category: "process", info: "Sprints moved to two weeks", source: "team meeting" }];

    const result = toBragBookResult(output({ impactLogEntry, profileUpdate, workContextUpdates }));

    expect(result.impactLogEntry).toEqual(impactLogEntry);
    expect(result.profileUpdate).toEqual(profileUpdate);
    expect(result.workContextUpdates).toEqual(workContextUpdates);
  });

  it("drops entries the model filled with empty strings", () => {
    const result = toBragBookResult(
      output({
        memoryItemsToAdd: [{ date: "", item: "   ", category: "", notes: "" }],
        memoryGraduations: [{ item: "", nowPartOf: "Something" }],
        workContextUpdates: [{ category: "process", info: "", source: "" }],
        impactLogEntry: { date: "2026-03-05", achievement: "  ", scope: "", coreValue: "", evidence: "" },
        profileUpdate: { achievement: "", bulletPoint: "something" },
        newFocusItems: ["", "  "],
        focusStatuses: [{ id: " ", status: "completed", notes: "" }],
      }),
    );

    expect(result.itemsToAdd).toEqual([]);
    expect(result.itemsToRemove).toEqual([]);
    expect(result.workContextUpdates).toEqual([]);
    expect(result.impactLogEntry).toBeNull();
    expect(result.profileUpdate).toBeNull();
    expect(result.focusItems).toEqual([]);
    expect(result.focusUpdates).toEqual([]);
  });

  it("caps new focus items at two", () => {
    const result = toBragBookResult(output({ newFocusItems: ["one", "two", "three"] }));
    expect(result.focusItems).toEqual(["one", "two"]);
  });

  it("keeps focus statuses keyed by id", () => {
    const result = toBragBookResult(
      output({
        focusStatuses: [
          { id: "2026-W09.1", status: "completed", notes: "Approved" },
          { id: "2026-W09.2", status: "ongoing", notes: "" },
        ],
      }),
    );

    expect(result.focusUpdates).toEqual([
      { id: "2026-W09.1", status: "completed", notes: "Approved" },
      { id: "2026-W09.2", status: "ongoing", notes: "" },
    ]);
  });

  it("uses the markdown field as the brag book content", () => {
    const result = toBragBookResult(output({ bragBookMarkdown: "\n# Brag Book\nGreat week!\n" }));
    expect(result.bragBookContent).toBe("# Brag Book\nGreat week!");
  });
});

describe("ensureBragBookFrontmatter", () => {
  it("prepends frontmatter when missing", () => {
    expect(ensureBragBookFrontmatter("# Brag Book")).toBe("---\ntags:\n  - areas/work\n  - areas/work/brag-book\n---\n\n# Brag Book");
  });

  it("leaves existing frontmatter alone", () => {
    expect(ensureBragBookFrontmatter("---\ntags: []\n---\n# x")).toBe("---\ntags: []\n---\n# x");
  });
});

describe("parseReviewCycle", () => {
  it("returns null when no review cycle section", () => {
    expect(parseReviewCycle("# Work Context\nSome stuff")).toBeNull();
  });

  it("returns null when all reviews are in the past", () => {
    const ctx = `## Review Cycle

| Review Type | Date |
|-------------|------|
| Mid-year | 2020-06-15 |`;

    expect(parseReviewCycle(ctx)).toBeNull();
  });

  const today = new Date("2026-03-01T00:00:00Z");

  it("parses future review cycle", () => {
    const ctx = `## Review Cycle

| Review Type | Date |
|-------------|------|
| Year-end | 2026-04-12 |`;

    const result = parseReviewCycle(ctx, today);
    expect(result).not.toBeNull();
    expect(result!.nextReview).toBe("Year-end");
    expect(result!.date).toBe("2026-04-12");
    expect(result!.weeksRemaining).toBe(6);
    expect(result!.urgency).toBe("attention");
  });

  it("classifies urgent reviews", () => {
    const ctx = `## Review Cycle

| Review Type | Date |
|-------------|------|
| Perf review | 2026-03-15 |`;

    const result = parseReviewCycle(ctx, today);
    expect(result!.weeksRemaining).toBe(2);
    expect(result!.urgency).toBe("urgent");
  });

  it("picks the nearest future review and ignores past ones", () => {
    const ctx = `## Review Cycle

| Review Type | Date |
|-------------|------|
| Q4 Check-in | 2025-11-01 |
| Annual Review | 2026-06-01 |
| Q1 Check-in | 2026-05-01 |`;

    const result = parseReviewCycle(ctx, today);
    expect(result!.nextReview).toBe("Q1 Check-in");
    expect(result!.urgency).toBe("normal");
  });
});
