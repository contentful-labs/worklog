import { describe, it, expect } from "vitest";
import { parseBragBookResult, getPendingFocusItems, parseReviewCycle } from "../brag-book";

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

  it("parses focus items from coaching session", () => {
    const raw = `Content

---

<!-- COACHING_SESSION -->

### Focus for Next Week

- Ship the auth PR
- Review team RFC
1. Prepare demo

<!-- /COACHING_SESSION -->`;

    const result = parseBragBookResult(raw);
    expect(result.focusItems).toEqual(["Ship the auth PR", "Review team RFC", "Prepare demo"]);
  });

  it("parses focus updates from focus update section", () => {
    const raw = `Content

---

<!-- FOCUS_UPDATE -->

## Focus Items Status

| Week | Item | Status | Notes |
|------|------|--------|-------|
| 2026-W09 | Review RFC | completed | Approved |
| 2026-W09 | Ship auth | ongoing | In review |

## New Focus Items

- Write migration docs

<!-- /FOCUS_UPDATE -->`;

    const result = parseBragBookResult(raw);
    expect(result.focusUpdates).toHaveLength(2);
    expect(result.focusUpdates[0]).toEqual({ week: "2026-W09", item: "Review RFC", status: "completed", notes: "Approved" });
    expect(result.focusItems).toContain("Write migration docs");
  });
});

describe("getPendingFocusItems", () => {
  it("extracts pending items from tracking table", () => {
    const content = `| Week | Item | Status |
|------|------|--------|
| 2026-W08 | Ship auth | completed |
| 2026-W09 | Write docs | pending |
| 2026-W09 | Review RFC | pending |`;

    const pending = getPendingFocusItems(content);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toEqual({ week: "2026-W09", item: "Write docs" });
  });

  it("returns empty array when no pending items", () => {
    const content = `| Week | Item | Status |
|------|------|--------|
| 2026-W08 | Ship auth | completed |`;

    expect(getPendingFocusItems(content)).toEqual([]);
  });

  it("returns empty array for empty content", () => {
    expect(getPendingFocusItems("No focus items tracked yet.")).toEqual([]);
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

  it("parses future review cycle", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 42); // 6 weeks — "attention" range
    const dateStr = futureDate.toISOString().split("T")[0];

    const ctx = `## Review Cycle

| Review Type | Date |
|-------------|------|
| Year-end | ${dateStr} |`;

    const result = parseReviewCycle(ctx);
    expect(result).not.toBeNull();
    expect(result!.nextReview).toBe("Year-end");
    expect(result!.date).toBe(dateStr);
    expect(result!.urgency).toBe("attention");
  });

  it("classifies urgent reviews", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 14);
    const dateStr = futureDate.toISOString().split("T")[0];

    const ctx = `## Review Cycle

| Review Type | Date |
|-------------|------|
| Perf review | ${dateStr} |`;

    const result = parseReviewCycle(ctx);
    expect(result!.urgency).toBe("urgent");
  });
});
