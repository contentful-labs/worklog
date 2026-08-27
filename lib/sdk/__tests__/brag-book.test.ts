import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  toBragBookResult, validateBragBookMarkdown, parseReviewCycle, ensureBragBookFrontmatter,
  firstDroppedLine, validatePreserved,
} from "../brag-book";
import { updateMemory } from "../vault-updates";
import { escapeCell, renderRow } from "../markdown-table";
import {
  bragBookMarkdownProblem, bragBookOutputSchema, isFocusItemId, type BragBookOutput,
} from "../brag-book-schema";

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

  it("rejects an achievements section with nothing under it", () => {
    // A bare heading passed every check and replaced the week's only record with itself.
    expect(() => validateBragBookMarkdown("## Achievements")).toThrow(/achievements section is empty/);
    expect(() => validateBragBookMarkdown("# Brag Book - Week 09, 2026\n\n## Achievements\n\n## Stats\n\n- 0")).toThrow(
      /achievements section is empty/,
    );
  });

  it.each([
    ["a bare comment", "<!-- nothing to report -->\n\n---"],
    ["a comment inside a list item", "- <!-- nothing to report -->"],
    ["a comment inside a blockquote", "> <!-- nothing to report -->"],
    ["a comment nested two deep", "> - <!-- nothing to report -->"],
  ])("does not count %s as content", (_name, body) => {
    // html is scaffolding at every depth, not just at the top of the section.
    expect(() => validateBragBookMarkdown(`## Achievements\n\n${body}\n\n## Stats\n\n- 0`)).toThrow(
      /achievements section is empty/,
    );
  });

  it.each([
    ["a list item", "- Shipped auth"],
    ["a blockquote", "> Shipped auth, see TEAM-1234"],
    ["a list item beside a comment", "- <!-- note -->\n- Shipped auth"],
  ])("counts %s as content", (_name, body) => {
    expect(() => validateBragBookMarkdown(`## Achievements\n\n${body}`)).not.toThrow();
  });

  it("accepts the line the prompt asks for when the week was quiet", () => {
    // A week with nothing to report is not an empty document, and must still be written.
    const quiet = "## Achievements\n\nNo significant achievements this week - routine work captured in [[memory]].";
    expect(() => validateBragBookMarkdown(quiet)).not.toThrow();
  });

  it("counts content that sits under a subsection", () => {
    expect(() => validateBragBookMarkdown("## Achievements\n\n### Auth\n\n- Shipped auth")).not.toThrow();
  });

  it("counts a table as content, which is how one provider writes the section", () => {
    expect(() => validateBragBookMarkdown("## Achievements\n\n| What | Evidence |\n|---|---|\n| Auth | TEAM-1234 |")).not.toThrow();
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

  const EXISTING = "---\ntags:\n  - areas/work\n---\n\n# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Real work";

  it.each([
    ["a blank document", "\n \n", /empty brag book/],
    ["a bare heading", "# Brag Book - Week 09, 2026\n\n## Achievements", /achievements section is empty/],
    [
      "a section holding only a comment",
      "# Brag Book - Week 09, 2026\n\n## Achievements\n\n- <!-- nothing -->",
      /achievements section is empty/,
    ],
  ])("leaves an existing entry untouched when the model returns %s", async (_name, markdown, problem) => {
    const path = join(tmpDir, "2026-W09 Brag Book.md");
    await writeFile(path, EXISTING, "utf-8");

    // The order runWorklog uses on a --force regeneration: adapt, then write.
    expect(() => {
      const parsed = toBragBookResult(output({ bragBookMarkdown: markdown }));
      throw new Error(`should not reach the write, got ${parsed.bragBookContent.length} chars`);
    }).toThrow(problem);

    expect(await readFile(path, "utf-8")).toBe(EXISTING);
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

  it("passes the item alone, since updateMemory matches on it and drops the achievement", () => {
    const result = toBragBookResult(
      output({ memoryGraduations: [{ item: "Three small perf PRs", nowPartOf: "Search latency initiative" }] }),
    );

    expect(result.itemsToRemove).toEqual(["Three small perf PRs"]);
  });

  it("keeps an item that contains the phrase the graduation marker used to be", () => {
    // The suffix this used to append put "(now part of" into every target, and the writer
    // cut each target there, so an item already containing the phrase lost its tail.
    const result = toBragBookResult(
      output({
        memoryGraduations: [
          { item: "Documented fallback (now part of SDK) behavior", nowPartOf: "SDK docs push" },
        ],
      }),
    );

    expect(result.itemsToRemove).toEqual(["Documented fallback (now part of SDK) behavior"]);
  });

  it("decodes a graduation target the model copied out of the rendered table", () => {
    // memory.md shows the model `Perf \\| work`; updateMemory matches the parsed cell.
    const result = toBragBookResult(
      output({ memoryGraduations: [{ item: "Perf \\| work", nowPartOf: "Latency push" }] }),
    );

    expect(result.itemsToRemove).toEqual(["Perf | work"]);
  });

  it("undoes exactly what escapeCell does, for any cell text", () => {
    // Pins the decode to the encoder it inverts. If escapeCell grows a rule, this fails.
    for (const original of ["Perf | work", "back\\slash", "both \\ and |", "plain text", "|", "\\"]) {
      const roundTripped = toBragBookResult(
        output({ memoryGraduations: [{ item: `x ${escapeCell(original)} x`, nowPartOf: "A" }] }),
      ).itemsToRemove[0];

      expect(roundTripped).toBe(`x ${original} x`);
    }
  });

  it("drops a graduation too short to name an item, but keeps one containing a pipe", () => {
    const result = toBragBookResult(
      output({
        memoryGraduations: [
          { item: "|", nowPartOf: "Search latency initiative" },
          { item: "a", nowPartOf: "Search latency initiative" },
          { item: "  ", nowPartOf: "Search latency initiative" },
          // A pipe is ordinary text to updateMemory, which matches rows on their parsed
          // cells. Dropping this would lose a real graduation.
          { item: "Perf | work", nowPartOf: "Search latency initiative" },
          { item: "Three small perf PRs", nowPartOf: "Search latency initiative" },
        ],
      }),
    );

    expect(result.itemsToRemove).toEqual(["Perf | work", "Three small perf PRs"]);
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

  it("drops an impact entry the writer could not record, and keeps one it can", () => {
    const base = { date: "2026-03-05", scope: "Team" as const, coreValue: "quality", evidence: "TEAM-1234" };

    expect(toBragBookResult(output({ impactLogEntry: { ...base, achievement: "Shipped\nauth" } })).impactLogEntry).toBeNull();
    expect(toBragBookResult(output({ impactLogEntry: { ...base, achievement: "  " } })).impactLogEntry).toBeNull();
    expect(toBragBookResult(output({ impactLogEntry: { ...base, date: "March 5th", achievement: "Shipped auth" } })).impactLogEntry).toBeNull();
    // updateImpactLog renders through renderRow, which escapes the pipe.
    expect(toBragBookResult(output({ impactLogEntry: { ...base, achievement: "Shipped a | b" } })).impactLogEntry).toEqual({
      ...base,
      achievement: "Shipped a | b",
    });
  });

  it("keeps work context updates on one line and drops the rest", () => {
    const result = toBragBookResult(
      output({
        workContextUpdates: [
          { category: "process", info: "Sprints moved to two weeks", source: "team meeting" },
          { category: "process", info: "", source: "team meeting" },
          // A newline would break the bullet updateWorkContext writes; a pipe would not.
          { category: "process", info: "Two\nlines", source: "" },
          { category: "tooling", info: "Uses a | b", source: "" },
        ],
      }),
    );

    expect(result.workContextUpdates).toEqual([
      { category: "process", info: "Sprints moved to two weeks", source: "team meeting" },
      { category: "tooling", info: "Uses a | b", source: "" },
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

describe("graduations reaching memory.md", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brag-book-grad-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const MEMORY = `# Memory

## Team Now (2026 - present)

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-05 | Fixed a flaky pagination test | bugfix |  |
| 2026-03-06 | Reviewed the search RFC | review |  |
`;

  it("removes nothing when the graduation text matches no row exactly", async () => {
    // "202" clears the adapter's minimum length, so nothing on this side stops it. What
    // stops it is updateMemory needing an exact row match: a substring rule would see
    // "202" inside both dates and delete the whole table.
    const path = join(tmpDir, "memory.md");
    await writeFile(path, MEMORY, "utf-8");

    const { itemsToRemove } = toBragBookResult(
      output({ memoryGraduations: [{ item: "202", nowPartOf: "Search reliability push" }] }),
    );
    expect(itemsToRemove).toEqual(["202"]);

    const result = await updateMemory(path, [], itemsToRemove);

    expect(result.removed).toBe(0);
    expect(result.unmatchedGraduations.map((u) => u.requested)).toEqual(["202"]);
    expect(await readFile(path, "utf-8")).toBe(MEMORY);
  });

  it("graduates a row whose stored cell is escaped, when the model echoes the escape", async () => {
    const path = join(tmpDir, "memory.md");
    const stored = `# Memory

## Team Now (2026 - present)

| Date | Item | Category | Notes |
|------|------|----------|-------|
${renderRow(["2026-03-05", "Perf | work on a | b", "perf", ""])}
| 2026-03-06 | Reviewed the search RFC | review |  |
`;
    await writeFile(path, stored, "utf-8");
    // The row really is stored escaped, which is what the model sees and copies.
    expect(stored).toContain("Perf \\| work on a \\| b");

    const { itemsToRemove } = toBragBookResult(
      output({ memoryGraduations: [{ item: "Perf \\| work on a \\| b", nowPartOf: "Latency push" }] }),
    );
    const result = await updateMemory(path, [], itemsToRemove);

    expect(result.removed).toBe(1);
    expect(result.unmatchedGraduations).toEqual([]);
    const after = await readFile(path, "utf-8");
    expect(after).not.toContain("Perf");
    expect(after).toContain("Reviewed the search RFC");
  });

  it("reports the full requested text when nothing matches, not a truncated head", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, MEMORY, "utf-8");

    const { itemsToRemove } = toBragBookResult(
      output({ memoryGraduations: [{ item: "Shipped the thing (now part of X) twice", nowPartOf: "A" }] }),
    );
    const result = await updateMemory(path, [], itemsToRemove);

    expect(result.removed).toBe(0);
    expect(result.unmatchedGraduations.map((u) => u.requested)).toEqual([
      "Shipped the thing (now part of X) twice",
    ]);
  });

  it("graduates an item whose own text contains the phrase the marker used to be", async () => {
    const path = join(tmpDir, "memory.md");
    const stored = `# Memory

## Team Now (2026 - present)

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-05 | Documented fallback (now part of SDK) behavior | docs |  |
| 2026-03-06 | Reviewed the search RFC | review |  |
`;
    await writeFile(path, stored, "utf-8");

    const { itemsToRemove } = toBragBookResult(
      output({
        memoryGraduations: [
          { item: "Documented fallback (now part of SDK) behavior", nowPartOf: "SDK docs push" },
        ],
      }),
    );
    // The adapter sends the whole item, and the writer no longer cuts it short.
    expect(itemsToRemove).toEqual(["Documented fallback (now part of SDK) behavior"]);

    const result = await updateMemory(path, [], itemsToRemove);

    expect(result.removed).toBe(1);
    expect(result.unmatchedGraduations).toEqual([]);
    const after = await readFile(path, "utf-8");
    expect(after).not.toContain("Documented fallback");
    expect(after).toContain("Reviewed the search RFC");
  });

  it("removes the one row a graduation names exactly", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, MEMORY, "utf-8");

    const { itemsToRemove } = toBragBookResult(
      output({
        memoryGraduations: [{ item: "Fixed a flaky pagination test", nowPartOf: "Search reliability push" }],
      }),
    );
    const result = await updateMemory(path, [], itemsToRemove);

    expect(result.removed).toBe(1);
    expect(result.unmatchedGraduations).toEqual([]);
    const after = await readFile(path, "utf-8");
    expect(after).not.toContain("Fixed a flaky pagination test");
    expect(after).toContain("Reviewed the search RFC");
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

describe("regenerating a week that already has an entry", () => {
  const existing = [
    "---",
    "tags:",
    "  - areas/work",
    "---",
    "",
    "# Brag Book - Week 36, 2026",
    "",
    "## Achievements",
    "",
    "- Cut search indexing from 40 minutes to 6.",
    "- Took the on-call rota through a bad week without a page going unanswered.",
    "",
    "<!-- COACHING_SESSION -->",
    "### What went well",
    "",
    "You said no to the extra scope.",
    "<!-- /COACHING_SESSION -->",
  ].join("\n");

  it("accepts a document that keeps everything and adds to it", () => {
    const next = existing.replace(
      "- Took the on-call rota through a bad week without a page going unanswered.",
      "- Took the on-call rota through a bad week without a page going unanswered.\n- Shipped the query parser rewrite.",
    );

    expect(firstDroppedLine(existing, next)).toBeUndefined();
    expect(() => validatePreserved(existing, next)).not.toThrow();
  });

  it("refuses a document that drops an achievement, and names the one it dropped", () => {
    // The trigger: the entry records A, the refresh finds B, and the model answers with
    // a structurally perfect document containing only B. Writing it would delete A.
    const onlyNew = [
      "---",
      "tags:",
      "  - areas/work",
      "---",
      "",
      "# Brag Book - Week 36, 2026",
      "",
      "## Achievements",
      "",
      "- Shipped the query parser rewrite.",
      "",
      "<!-- COACHING_SESSION -->",
      "### What went well",
      "",
      "You said no to the extra scope.",
      "<!-- /COACHING_SESSION -->",
    ].join("\n");

    expect(firstDroppedLine(existing, onlyNew)).toBe("- Cut search indexing from 40 minutes to 6.");
    expect(() => validatePreserved(existing, onlyNew)).toThrow(/Refusing to write the brag book/);
    expect(() => validatePreserved(existing, onlyNew)).toThrow(/Cut search indexing from 40 minutes to 6/);
  });

  it("refuses a document that drops a coaching heading", () => {
    const withoutHeading = existing.replace("### What went well", "### Something else entirely");
    expect(firstDroppedLine(existing, withoutHeading)).toBe("### What went well");
  });

  it("ignores lines outside the achievements and coaching sections", () => {
    // Only what someone wrote down about the week is protected. The framing around it is
    // the model's to rewrite, or a cosmetic change would fail an otherwise good week.
    const rewordedIntro = existing.replace("# Brag Book - Week 36, 2026", "# Week 36, 2026");
    expect(firstDroppedLine(existing, rewordedIntro)).toBeUndefined();
  });

  it("says nothing is dropped when there was nothing there to drop", () => {
    expect(firstDroppedLine("", "# Brag Book\n\n## Achievements\n\n- Something new.")).toBeUndefined();
  });
});

describe("moving an achievement instead of keeping it", () => {
  const existing = [
    "# Brag Book - Week 36, 2026",
    "",
    "## Achievements",
    "",
    "- Cut search indexing from 40 minutes to 6.",
    "",
    "<!-- COACHING_SESSION -->",
    "### What went well",
    "",
    "You said no to the extra scope.",
    "<!-- /COACHING_SESSION -->",
  ].join("\n");

  it("does not count a mention in the coaching prose as keeping the achievement", () => {
    // The trigger: the line is taken out of the achievements and repeated in the
    // coaching text. A check for the words anywhere in the document sees them and calls
    // it preserved; the list someone reads next year has lost the entry.
    const moved = [
      "# Brag Book - Week 36, 2026",
      "",
      "## Achievements",
      "",
      "- Shipped the query parser rewrite.",
      "",
      "<!-- COACHING_SESSION -->",
      "### What went well",
      "",
      "Earlier you noted: - Cut search indexing from 40 minutes to 6.",
      "<!-- /COACHING_SESSION -->",
    ].join("\n");

    expect(firstDroppedLine(existing, moved)).toBe("- Cut search indexing from 40 minutes to 6.");
  });

  it("does not count an achievement bullet as keeping a coaching heading", () => {
    const moved = existing
      .replace("### What went well", "Nothing in particular.")
      .replace("- Cut search indexing from 40 minutes to 6.", "- Cut search indexing from 40 minutes to 6.\n- ### What went well");

    expect(firstDroppedLine(existing, moved)).toBe("### What went well");
  });

  it("is happy when both sections keep what they had", () => {
    const added = existing.replace(
      "- Cut search indexing from 40 minutes to 6.",
      "- Cut search indexing from 40 minutes to 6.\n- Shipped the query parser rewrite.",
    );
    expect(firstDroppedLine(existing, added)).toBeUndefined();
  });
});

describe("an achievements heading the validator accepts", () => {
  /** The body is the same in every case; only the heading changes. */
  function entry(heading: string): string {
    return [
      "# Brag Book - Week 36, 2026",
      "",
      heading,
      "",
      "- Cut search indexing from 40 minutes to 6.",
      "",
      "<!-- COACHING_SESSION -->",
      "### What went well",
      "",
      "You said no to the extra scope.",
      "<!-- /COACHING_SESSION -->",
    ].join("\n");
  }

  /** The same document with the achievement gone, which is what must be refused. */
  function stripped(heading: string): string {
    return entry(heading).replace("- Cut search indexing from 40 minutes to 6.", "- Only the new thing.");
  }

  it.each([
    ["plain", "## Achievements"],
    ["bolded", "## **Achievements**"],
    ["with a colon", "## Achievements:"],
    ["with closing hashes", "## Achievements ##"],
    ["indented three spaces", "   ## Achievements"],
    ["singular", "## Achievement"],
    ["at another depth", "# Achievements"],
    ["underlined instead of hashed", "Achievements\n------------"],
  ])("is read by the gate as well: %s", (_name, heading) => {
    // The trigger: the validator accepts every one of these as an achievements section,
    // and the gate recognised only the literal `## Achievements`. A book written any
    // other way passed validation with its achievements invisible to the gate, so every
    // one of them could be dropped without a word.
    expect(bragBookMarkdownProblem(entry(heading))).toBeNull();
    expect(firstDroppedLine(entry(heading), stripped(heading)))
      .toBe("- Cut search indexing from 40 minutes to 6.");
    expect(firstDroppedLine(entry(heading), entry(heading))).toBeUndefined();
  });

  it("still notices a dropped achievement when the two documents write the heading differently", () => {
    // A model that reformats the heading has not removed anything by doing so, and one
    // that reformats it while dropping a line has.
    expect(firstDroppedLine(entry("## Achievements"), entry("## **Achievements**"))).toBeUndefined();
    expect(firstDroppedLine(entry("## Achievements"), stripped("## Achievements:")))
      .toBe("- Cut search indexing from 40 minutes to 6.");
  });

  it("reads a coaching heading however it is written", () => {
    const existing = entry("## Achievements");
    const reworded = existing.replace("### What went well", "### **What went well**:");
    // Bolding and a colon are the same heading; a different heading is a dropped one.
    expect(firstDroppedLine(existing, reworded)).toBeUndefined();
    expect(firstDroppedLine(existing, existing.replace("### What went well", "### Something else")))
      .toBe("### What went well");
  });
});

describe("layouts the validator accepts that the gate used to look past", () => {
  it("protects achievements written inside the coaching block", () => {
    // The trigger: the validator does not care where the achievements section sits, so a
    // document that opens the coaching block before it passes — and a gate that stopped
    // reading headings once it saw the marker never found the section at all, leaving
    // every achievement in it free to be dropped.
    const existing = [
      "# Brag Book - Week 36, 2026",
      "",
      "<!-- COACHING_SESSION -->",
      "",
      "## Achievements",
      "",
      "- Cut search indexing from 40 minutes to 6.",
      "",
      "<!-- /COACHING_SESSION -->",
    ].join("\n");
    const stripped = existing.replace("- Cut search indexing from 40 minutes to 6.", "- Only the new thing.");

    expect(bragBookMarkdownProblem(existing)).toBeNull();
    expect(firstDroppedLine(existing, stripped)).toBe("- Cut search indexing from 40 minutes to 6.");
    expect(firstDroppedLine(existing, existing)).toBeUndefined();
  });

  it("protects a coaching heading written at a depth other than three", () => {
    const existing = [
      "# Brag Book - Week 36, 2026",
      "",
      "## Achievements",
      "",
      "- Cut search indexing from 40 minutes to 6.",
      "",
      "<!-- COACHING_SESSION -->",
      "#### What went well",
      "",
      "You said no to the extra scope.",
      "<!-- /COACHING_SESSION -->",
    ].join("\n");

    expect(bragBookMarkdownProblem(existing)).toBeNull();
    expect(firstDroppedLine(existing, existing.replace("#### What went well", "#### Something else")))
      .toBe("#### What went well");
  });

  it("protects what a document says before its first heading", () => {
    // Nothing puts a line there on purpose, but the run accepts a document that opens
    // with one, and a line someone wrote about the week is a line someone wrote about it.
    const existing = [
      "A quiet week, mostly spent on the indexer.",
      "",
      "## Achievements",
      "",
      "- Cut search indexing from 40 minutes to 6.",
    ].join("\n");
    const withoutIt = existing.replace("A quiet week, mostly spent on the indexer.\n\n", "");

    expect(bragBookMarkdownProblem(existing)).toBeNull();
    expect(firstDroppedLine(existing, withoutIt)).toBe("A quiet week, mostly spent on the indexer.");
    expect(firstDroppedLine(existing, existing)).toBeUndefined();
  });
});
