import { describe, it, expect } from "vitest";
import {
  parseFocusItems,
  selectOpenFocusItems,
  summarizeFocusHistory,
  applyFocusUpdates,
  migrateFocusTracking,
  needsFocusMigration,
  focusSimilarity,
  normalizeFocusText,
  DEFAULT_INJECT_CAP,
} from "../focus";

const FILE = `# Focus Tracking

| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2026-W09.1 | 2026-W09 | Write docs | pending | 0 |  |
| 2026-W09.2 | 2026-W09 | Ship auth PR | completed | 0 | merged |
| 2026-W10.1 | 2026-W10 | Review the RFC | pending | 1 |  |

## Old era — ARCHIVED

| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2025-W10.1 | 2025-W10 | Ancient item | pending | 0 |  |
`;

describe("normalizeFocusText / focusSimilarity", () => {
  it("strips markdown so links and emphasis do not affect comparison", () => {
    expect(normalizeFocusText("Get **[TEAM-1234](https://x/y)** through [[review]]"))
      .toBe("get team 1234 through review");
  });

  it("scores real rewordings of the same suggestion as the same item", () => {
    const a = "Close the [[My Focus]] Tier 1 / P0 Search Revamp release correctness loop. Get TEAM-1234 through review.";
    const b = "Close [[My Focus]] Tier 1 / P0 Search Revamp release correctness through TEAM-1234 review.";
    expect(focusSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it("scores genuinely different suggestions as different", () => {
    const a = "Close the Search Revamp release correctness loop via TEAM-1234";
    const b = "Write up rate limit numbers for the payments group before Thursday";
    expect(focusSimilarity(a, b)).toBeLessThan(0.6);
  });

  it("catches an elaboration of the same suggestion, which plain Jaccard misses", () => {
    // Shaped after a real pair the old metric missed: one item elaborates the other,
    // so the extra ticket keys and trailing clause sink plain Jaccard to ~0.35.
    const a = "Close the [[My Focus]] Tier 1 / P0 **Search Revamp** release and correctness loop. Get [TEAM-1234](https://x/TEAM-1234) through review, then record the deployment dates for TEAM-1235 under TEAM-1236.";
    const b = "Close [[My Focus]] Tier 1 / P0 **Search Revamp** dashboard and release follow-through through TEAM-1234, TEAM-1235, and TEAM-1236.";
    expect(focusSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it("does not merge two short items that only share filler words", () => {
    expect(focusSimilarity("First new thing", "Second new thing")).toBeLessThan(0.6);
  });
});

describe("parseFocusItems", () => {
  it("reads the live table and ignores archived eras", () => {
    const items = parseFocusItems(FILE);
    expect(items.map((i) => i.id)).toEqual(["2026-W09.1", "2026-W09.2", "2026-W10.1"]);
    expect(items[2]).toMatchObject({ week: "2026-W10", status: "pending", reviews: 1 });
  });

  it("returns nothing for a file with no table", () => {
    expect(parseFocusItems("No focus items tracked yet.")).toEqual([]);
  });
});

describe("selectOpenFocusItems", () => {
  it("returns only open items, oldest first", () => {
    expect(selectOpenFocusItems(FILE).map((i) => i.id)).toEqual(["2026-W09.1", "2026-W10.1"]);
  });

  it("caps how many are injected so a backlog cannot blow up the prompt", () => {
    const rows = Array.from({ length: 30 }, (_, n) => `| 2026-W${String(n + 10)}.1 | 2026-W${String(n + 10)} | Item ${n} | pending | 0 |  |`);
    const big = `| ID | Week | Focus Item | Status | Reviews | Notes |\n|---|---|---|---|---|---|\n${rows.join("\n")}`;
    expect(selectOpenFocusItems(big).length).toBe(DEFAULT_INJECT_CAP);
    expect(selectOpenFocusItems(big, 3).length).toBe(3);
  });
});

describe("summarizeFocusHistory", () => {
  it("summarizes outcomes since a week instead of listing rows", () => {
    const summary = summarizeFocusHistory(FILE, "2026-W01");
    expect(summary).toContain("3 focus items");
    expect(summary).toContain("2 pending");
    expect(summary).toContain("1 completed");
  });

  it("is empty when nothing falls in the window", () => {
    expect(summarizeFocusHistory(FILE, "2027-W01")).toBe("");
  });
});

describe("applyFocusUpdates", () => {
  const base = `| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W09.1 | 2026-W09 | Write docs | pending | 0 |  |
| 2026-W09.2 | 2026-W09 | Review RFC | pending | 1 |  |
`;

  it("resolves by id and ignores prose entirely", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.1", "2026-W09.2"],
      updates: [{ id: "2026-W09.1", status: "Completed", notes: "shipped" }],
      newItems: [],
      weekLabel: "2026-W10",
    });
    expect(result.resolved).toBe(1);
    expect(result.content).toContain("| 2026-W09.1 | 2026-W09 | Write docs | completed | 0 | shipped |");
  });

  it("ages an unanswered item and lapses it on the second miss", () => {
    const once = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.1"], updates: [], newItems: [], weekLabel: "2026-W10",
    });
    expect(once.lapsed).toBe(0);
    expect(once.content).toContain("| Write docs | pending | 1 |");

    const twice = applyFocusUpdates(once.content, {
      reviewedIds: ["2026-W09.1"], updates: [], newItems: [], weekLabel: "2026-W11",
    });
    expect(twice.lapsed).toBe(1);
    expect(twice.content).toContain("| Write docs | lapsed | 2 |");
  });

  it("does not age an item that was never put in front of the coach", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.1"], updates: [], newItems: [], weekLabel: "2026-W10",
    });
    expect(result.content).toContain("| Review RFC | pending | 1 |");
  });

  it("adds new items with sequential ids for the week", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["First new thing", "Second new thing"], weekLabel: "2026-W10",
    });
    expect(result.added).toBe(2);
    expect(result.content).toContain("| 2026-W10.1 | 2026-W10 | First new thing | pending | 0 |");
    expect(result.content).toContain("| 2026-W10.2 | 2026-W10 | Second new thing | pending | 0 |");
  });

  it("keeps new rows above an archived section", () => {
    const result = applyFocusUpdates(FILE, {
      reviewedIds: [], updates: [], newItems: ["Brand new"], weekLabel: "2026-W11",
    });
    expect(result.content.indexOf("Brand new")).toBeLessThan(result.content.indexOf("ARCHIVED"));
  });

  it("restates a reworded suggestion instead of duplicating it, and resets its clock", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["Review the RFC thoroughly"], weekLabel: "2026-W10",
    });
    expect(result.restated).toBe(1);
    expect(result.added).toBe(0);
    expect(result.content).toContain("| Review RFC | pending | 0 | restated 2026-W10 |");
  });

  it("ignores a status row for an id that does not exist", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: [], updates: [{ id: "2026-W99.9", status: "completed", notes: "" }],
      newItems: [], weekLabel: "2026-W10",
    });
    expect(result.resolved).toBe(0);
  });

  it.each([
    ["a pipe", "Compare a | b output"],
    ["a backslash", "Escape the \\d regex in the parser"],
    ["both", "Handle a \\| literal in table cells"],
  ])("preserves %s in item text through a round trip", (_label, text) => {
    const result = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: [text], weekLabel: "2026-W10",
    });
    const parsed = parseFocusItems(result.content).find((i) => i.id === "2026-W10.1");
    expect(parsed?.item).toBe(text);
  });
});

describe("migrateFocusTracking", () => {
  const legacy = `# Focus Tracking

| Week | Focus Item | Status | Notes |
|------|------------|--------|-------|
| 2026-W01 | Ancient open item | pending | |
| 2026-W01 | Ancient closed item | completed | done |
| 2026-W09 | Ship the Search Revamp release correctness loop via TEAM-1234 | pending | |
| 2026-W09 | Ship the Search Revamp release correctness loop through TEAM-1234 | pending | |
| 2026-W10 | Recent open item | pending | |
`;

  it("detects a pre-id file", () => {
    expect(needsFocusMigration(legacy)).toBe(true);
    expect(needsFocusMigration(FILE)).toBe(false);
  });

  it("assigns ids, collapses rewordings, and closes the unreviewable backlog", () => {
    const { content, assigned, collapsed, lapsed } = migrateFocusTracking(legacy);
    expect(collapsed).toBe(1);
    expect(assigned).toBe(4);
    expect(lapsed).toBe(1);

    // recent weeks stay open so the live loop keeps running
    expect(content).toContain("| 2026-W09.1 | 2026-W09 | Ship the Search Revamp release correctness loop via TEAM-1234 | pending |");
    expect(content).toContain("| 2026-W10.1 | 2026-W10 | Recent open item | pending |");
    // older open items become history, resolved statuses are left alone
    expect(content).toContain("| 2026-W01.1 | 2026-W01 | Ancient open item | lapsed |");
    expect(content).toContain("| 2026-W01.2 | 2026-W01 | Ancient closed item | completed |");
  });

  it("is idempotent", () => {
    const once = migrateFocusTracking(legacy).content;
    expect(needsFocusMigration(once)).toBe(false);
    expect(migrateFocusTracking(once).content).toBe(once);
  });
});
