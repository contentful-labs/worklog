import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toBragBookResult, validateBragBookMarkdown, parseReviewCycle, ensureBragBookFrontmatter } from "../brag-book";
import { bragBookOutputSchema, isFocusItemId, type BragBookOutput } from "../brag-book-schema";

const MARKDOWN = "# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Shipped auth";

const emptyOutput: BragBookOutput = {
  bragBookMarkdown: MARKDOWN,
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
  it("accepts a week with nothing to report", () => {
    expect(bragBookOutputSchema.parse(emptyOutput)).toEqual(emptyOutput);
  });

  it("rejects a blank document, so a whitespace answer can never reach the vault", () => {
    expect(bragBookOutputSchema.safeParse({ ...emptyOutput, bragBookMarkdown: "   " }).success).toBe(false);
  });

  it("rejects a focus status outside the allowed set", () => {
    // `open` is what a model reaches for, and it is the one value that must not get
    // through: applyFocusUpdates would record it as an answered, non-open status.
    const bad = { ...emptyOutput, focusStatuses: [{ id: "2026-W09.1", status: "open", notes: "" }] };
    expect(bragBookOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an impact scope outside the allowed set", () => {
    const entry = { date: "2026-03-05", achievement: "Shipped auth", scope: "global", coreValue: "q", evidence: "e" };
    expect(bragBookOutputSchema.safeParse({ ...emptyOutput, impactLogEntry: entry }).success).toBe(false);
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

  it("does not constrain individual rows, so one bad cell cannot cost the whole week", () => {
    // The per-element rules live in the adapter for exactly this reason. If this starts
    // failing, someone moved a rule into the wire schema and made it all-or-nothing.
    const loose = { ...emptyOutput, memoryItemsToAdd: [{ date: "whenever", item: "|", category: "", notes: "" }] };
    expect(bragBookOutputSchema.safeParse(loose).success).toBe(true);
  });
});

describe("isFocusItemId", () => {
  it("accepts real ids", () => {
    expect(isFocusItemId("2026-W35.1")).toBe(true);
    expect(isFocusItemId("2026-W05.12")).toBe(true);
  });

  it("rejects item text and near misses", () => {
    for (const bad of ["Review the RFC", "2026-W35", "2026-W35.", "2026-Q35.1", "26-W35.1", "2026-W3X.1", ""]) {
      expect(isFocusItemId(bad)).toBe(false);
    }
  });
});

describe("validateBragBookMarkdown", () => {
  it("accepts a document with an achievements section", () => {
    expect(() => validateBragBookMarkdown(MARKDOWN)).not.toThrow();
  });

  it("accepts the singular heading models actually write", () => {
    expect(() => validateBragBookMarkdown("## Achievement\n\n- Shipped auth")).not.toThrow();
  });

  it("rejects a blank document", () => {
    expect(() => validateBragBookMarkdown("   \n  ")).toThrow(/empty brag book/);
  });

  it("rejects prose with no headings", () => {
    expect(() => validateBragBookMarkdown("Sorry, I could not complete this request.")).toThrow(/no markdown headings/);
  });

  it("rejects a document with headings but no achievements section", () => {
    expect(() => validateBragBookMarkdown("# Notes\n\n## Stats\n\n- 0")).toThrow(/no achievements section/);
  });

  it("accepts closing hashes, which CommonMark allows and models write", () => {
    expect(() => validateBragBookMarkdown("# Brag Book #\n\n## Achievements ##\n\n- Shipped auth")).not.toThrow();
  });

  it("accepts the three spaces of indentation CommonMark allows", () => {
    expect(() => validateBragBookMarkdown("# Brag Book\n\n   ## Achievements\n\n- Shipped auth")).not.toThrow();
  });

  it("accepts a setext heading", () => {
    expect(() => validateBragBookMarkdown("Achievements\n============\n\n- Shipped auth")).not.toThrow();
  });

  it("accepts a trailing colon", () => {
    expect(() => validateBragBookMarkdown("# Brag Book\n\n## Achievements:\n\n- Shipped auth")).not.toThrow();
  });

  it("accepts emphasis inside the heading", () => {
    expect(() => validateBragBookMarkdown("# Brag Book\n\n## **Achievements**\n\n- Shipped auth")).not.toThrow();
  });

  it("does not mistake the frontmatter fence for a heading", () => {
    const withFrontmatter = "---\ntags:\n  - areas/work\n---\n\nJust a sentence, no headings at all.";
    expect(() => validateBragBookMarkdown(withFrontmatter)).toThrow(/no markdown headings/);
  });

  it("rejects a heading that merely mentions achievements", () => {
    // A substring test would accept this and let a document with no achievements through.
    expect(() => validateBragBookMarkdown("# Brag Book\n\n## Achievement statistics\n\n- 0")).toThrow(
      /no achievements section/,
    );
  });

  it("says nothing was written, because that is the whole point of failing here", () => {
    expect(() => validateBragBookMarkdown("")).toThrow(/Nothing was written to the vault/);
  });
});

describe("toBragBookResult refuses to overwrite a real brag book", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brag-book-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("leaves an existing entry untouched when the model returns a blank document", async () => {
    const path = join(tmpDir, "2026-W09 Brag Book.md");
    const existing = "---\ntags:\n  - areas/work\n---\n\n# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Real work";
    await writeFile(path, existing, "utf-8");

    // The order runWorklog uses on a --force regeneration: adapt, then write.
    expect(() => {
      const parsed = toBragBookResult(output({ bragBookMarkdown: "\n \n" }));
      throw new Error(`should not reach the write, got ${parsed.bragBookContent.length} chars`);
    }).toThrow(/empty brag book/);

    expect(await readFile(path, "utf-8")).toBe(existing);
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

  it("escapes pipes in memory items rather than dropping them, since renderRow handles it", () => {
    const result = toBragBookResult(
      output({ memoryItemsToAdd: [{ date: "2026-03-05", item: "Renamed a | b", category: "docs", notes: "" }] }),
    );

    expect(result.itemsToAdd).toEqual(["| 2026-03-05 | Renamed a \\| b | docs |  |"]);
  });

  it("drops a memory item whose date would corrupt the memory window", () => {
    const result = toBragBookResult(
      output({
        memoryItemsToAdd: [
          { date: "last Tuesday", item: "Fixed a flake", category: "bugfix", notes: "" },
          { date: "2026-02-31", item: "Impossible date", category: "bugfix", notes: "" },
          { date: "2026-03-05", item: "Kept", category: "bugfix", notes: "" },
        ],
      }),
    );

    expect(result.itemsToAdd).toHaveLength(1);
    expect(result.itemsToAdd[0]).toContain("Kept");
  });

  it("keeps the graduation phrasing updateMemory splits on", () => {
    const result = toBragBookResult(
      output({ memoryGraduations: [{ item: "Three small perf PRs", nowPartOf: "Search latency initiative" }] }),
    );

    expect(result.itemsToRemove).toEqual(["Three small perf PRs (now part of: Search latency initiative)"]);
    expect(result.itemsToRemove[0].split("(now part of")[0].trim()).toBe("Three small perf PRs");
  });

  it("drops a graduation too short or too generic to match one memory row", () => {
    // updateMemory deletes every line containing the item text, so `|` or `a` would
    // wipe most of the file.
    const result = toBragBookResult(
      output({
        memoryGraduations: [
          { item: "|", nowPartOf: "Search latency initiative" },
          { item: "a", nowPartOf: "Search latency initiative" },
          { item: "  ", nowPartOf: "Search latency initiative" },
          { item: "Perf | work", nowPartOf: "Search latency initiative" },
          { item: "Three small perf PRs", nowPartOf: "Search latency initiative" },
        ],
      }),
    );

    expect(result.itemsToRemove).toEqual(["Three small perf PRs (now part of: Search latency initiative)"]);
  });

  it("drops a graduation with no achievement to attribute it to", () => {
    const result = toBragBookResult(output({ memoryGraduations: [{ item: "Three small perf PRs", nowPartOf: " " }] }));
    expect(result.itemsToRemove).toEqual([]);
  });

  it("passes a well-formed impact entry through unchanged", () => {
    const impactLogEntry = {
      date: "2026-03-05",
      achievement: "Shipped auth",
      scope: "Team" as const,
      coreValue: "quality",
      evidence: "TEAM-1234 merged",
    };

    expect(toBragBookResult(output({ impactLogEntry })).impactLogEntry).toEqual(impactLogEntry);
  });

  it("drops an impact entry whose cells would split the impact table", () => {
    const base = { date: "2026-03-05", scope: "Team" as const, coreValue: "quality", evidence: "TEAM-1234" };

    expect(toBragBookResult(output({ impactLogEntry: { ...base, achievement: "Shipped | auth" } })).impactLogEntry).toBeNull();
    expect(toBragBookResult(output({ impactLogEntry: { ...base, achievement: "Shipped\nauth" } })).impactLogEntry).toBeNull();
    expect(toBragBookResult(output({ impactLogEntry: { ...base, achievement: "  " } })).impactLogEntry).toBeNull();
    expect(toBragBookResult(output({ impactLogEntry: { ...base, date: "March 5th", achievement: "Shipped auth" } })).impactLogEntry).toBeNull();
  });

  it("keeps work context updates on one line and drops the rest", () => {
    const result = toBragBookResult(
      output({
        workContextUpdates: [
          { category: "process", info: "Sprints moved to two weeks", source: "team meeting" },
          { category: "process", info: "", source: "team meeting" },
          { category: "process", info: "Two\nlines", source: "" },
          { category: "pro|cess", info: "Pipes break the bullet", source: "" },
        ],
      }),
    );

    expect(result.workContextUpdates).toEqual([
      { category: "process", info: "Sprints moved to two weeks", source: "team meeting" },
    ]);
  });

  it("keeps a profile update only when both halves are there", () => {
    const achievement = "Led auth migration";
    const bulletPoint = "Designed and shipped OAuth integration";

    expect(toBragBookResult(output({ profileUpdate: { achievement, bulletPoint } })).profileUpdate).toEqual({
      achievement,
      bulletPoint,
    });
    expect(toBragBookResult(output({ profileUpdate: { achievement, bulletPoint: "" } })).profileUpdate).toBeNull();
    expect(toBragBookResult(output({ profileUpdate: { achievement, bulletPoint: "   " } })).profileUpdate).toBeNull();
    expect(toBragBookResult(output({ profileUpdate: { achievement: "", bulletPoint } })).profileUpdate).toBeNull();
  });

  it("caps new focus items at two and drops blank or multi-line ones", () => {
    const result = toBragBookResult(output({ newFocusItems: ["", "one", "two\nlines", "  ", "two", "three"] }));
    expect(result.focusItems).toEqual(["one", "two"]);
  });

  it("keeps focus statuses keyed by a real id and drops pasted item text", () => {
    const result = toBragBookResult(
      output({
        focusStatuses: [
          { id: "2026-W09.1", status: "completed", notes: "Approved" },
          { id: "Review the RFC", status: "completed", notes: "pasted the item text instead of the id" },
          { id: " 2026-W09.2 ", status: "ongoing", notes: "" },
        ],
      }),
    );

    expect(result.focusUpdates).toEqual([
      { id: "2026-W09.1", status: "completed", notes: "Approved" },
      { id: "2026-W09.2", status: "ongoing", notes: "" },
    ]);
  });

  it("uses the markdown field as the brag book content", () => {
    const result = toBragBookResult(output({ bragBookMarkdown: `\n${MARKDOWN}\n` }));
    expect(result.bragBookContent).toBe(MARKDOWN);
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
