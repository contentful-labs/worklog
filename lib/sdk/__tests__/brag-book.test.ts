import { describe, it, expect } from "vitest";
import { parseBragBookResult, parseReviewCycle, ensureBragBookFrontmatter } from "../brag-book";

describe("parseBragBookResult", () => {
  it("returns raw content when no markers present", () => {
    const result = parseBragBookResult("# Brag Book\nGreat week!");
    expect(result.bragBookContent).toBe("# Brag Book\nGreat week!");
    expect(result.itemsToAdd).toEqual([]);
    expect(result.itemsToRemove).toEqual([]);
    expect(result.impactLogEntry).toBeNull();
    expect(result.focusItems).toEqual([]);
  });

  it("parses memory items to add", () => {
    const raw = `# Brag Book
Content here

---

<!-- MEMORY_UPDATE -->

## Items to Add to Memory

| Category | Item | Source |
|----------|------|--------|
| project | Shipped auth | CORE-42 |

## Items to Remove from Memory

- Old item no longer relevant

<!-- /MEMORY_UPDATE -->`;

    const result = parseBragBookResult(raw);
    expect(result.itemsToAdd).toHaveLength(1);
    expect(result.itemsToAdd[0]).toContain("Shipped auth");
    expect(result.itemsToRemove).toEqual(["Old item no longer relevant"]);
  });

  it("strips machine-parseable sections from brag book content", () => {
    const raw = `# Brag Book
Content here

---

<!-- MEMORY_UPDATE -->
## Items to Add to Memory
None
<!-- /MEMORY_UPDATE -->`;

    const result = parseBragBookResult(raw);
    expect(result.bragBookContent).not.toContain("MEMORY_UPDATE");
    expect(result.bragBookContent).toContain("# Brag Book");
  });

  it("parses impact log entry", () => {
    const raw = `Content

---

<!-- CONTEXT_UPDATES -->

## Impact Log Update

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Shipped auth | team | quality | CORE-42 merged |

<!-- /CONTEXT_UPDATES -->`;

    const result = parseBragBookResult(raw);
    expect(result.impactLogEntry).toEqual({
      date: "2026-03-05",
      achievement: "Shipped auth",
      scope: "team",
      coreValue: "quality",
      evidence: "CORE-42 merged",
    });
  });

  it("parses work context updates", () => {
    const raw = `Content

---

<!-- CONTEXT_UPDATES -->

## Work Context Updates

| Category | Info | Source |
|----------|------|--------|
| current_work | Auth migration | CORE-42 |
| tech_stack | Added OAuth | PR #99 |

<!-- /CONTEXT_UPDATES -->`;

    const result = parseBragBookResult(raw);
    expect(result.workContextUpdates).toHaveLength(2);
    expect(result.workContextUpdates[0].category).toBe("current_work");
  });

  it("parses profile update", () => {
    const raw = `Content

---

<!-- CONTEXT_UPDATES -->

**Achievement to add:** Led auth migration
**Suggested bullet point:** Designed and shipped OAuth integration

<!-- /CONTEXT_UPDATES -->`;

    const result = parseBragBookResult(raw);
    expect(result.profileUpdate).toEqual({
      achievement: "Led auth migration",
      bulletPoint: "Designed and shipped OAuth integration",
    });
  });

  it("skips placeholder profile update", () => {
    const raw = `Content

---

<!-- CONTEXT_UPDATES -->

**Achievement to add:** (leave blank if none - bar is CV-worthy)
**Suggested bullet point:** (leave blank if none)

<!-- /CONTEXT_UPDATES -->`;

    const result = parseBragBookResult(raw);
    expect(result.profileUpdate).toBeNull();
  });

  it("ignores focus suggestions in the coaching prose", () => {
    // The coaching section states the same suggestions for the reader. Parsing it too is
    // what used to turn two suggestions into four rows a week.
    const raw = `Content

---

<!-- COACHING_SESSION -->

### Focus for Next Week

- Ship the auth PR
- Review team RFC

<!-- /COACHING_SESSION -->`;

    expect(parseBragBookResult(raw).focusItems).toEqual([]);
  });

  it("parses focus updates keyed by id, and new items only from FOCUS_UPDATE", () => {
    const raw = `Content

---

<!-- FOCUS_UPDATE -->

## Focus Items Status

| ID | New Status | Notes |
|----|------------|-------|
| 2026-W09.1 | completed | Approved |
| 2026-W09.2 | ongoing | In review |

## New Focus Items

- Write migration docs

<!-- /FOCUS_UPDATE -->`;

    const result = parseBragBookResult(raw);
    expect(result.focusUpdates).toEqual([
      { id: "2026-W09.1", status: "completed", notes: "Approved" },
      { id: "2026-W09.2", status: "ongoing", notes: "In review" },
    ]);
    expect(result.focusItems).toEqual(["Write migration docs"]);
  });

  it("drops status rows that are not keyed by a valid id", () => {
    const raw = `<!-- FOCUS_UPDATE -->

## Focus Items Status

| ID | New Status | Notes |
|----|------------|-------|
| Review the RFC | completed | pasted the item text instead of the id |
| 2026-W09.1 | completed | |

<!-- /FOCUS_UPDATE -->`;

    const result = parseBragBookResult(raw);
    expect(result.focusUpdates).toEqual([{ id: "2026-W09.1", status: "completed", notes: "" }]);
  });

  it("ignores the template placeholder lines in New Focus Items", () => {
    const raw = `<!-- FOCUS_UPDATE -->

## New Focus Items

- Real item
- (This list is the ONLY place new focus items are recorded.)

<!-- /FOCUS_UPDATE -->`;

    expect(parseBragBookResult(raw).focusItems).toEqual(["Real item"]);
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
