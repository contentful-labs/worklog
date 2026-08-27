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
  lapseStaleOpenFocusItems,
  isOpenFocusStatus,
  focusFormatVersion,
  needsFocusFormatUpgrade,
  upgradeFocusFormat,
  FOCUS_TRACKING_TEMPLATE,
  FOCUS_FORMAT_VERSION,
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
      .toBe("get team-1234 through review");
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

  it("treats ongoing as open: the coach wants to check it again", () => {
    const withOngoing = FILE.replace("| Review the RFC | pending | 1 |", "| Review the RFC | ongoing | 0 |");
    expect(selectOpenFocusItems(withOngoing).map((i) => i.id)).toEqual(["2026-W09.1", "2026-W10.1"]);
    expect(isOpenFocusStatus("ongoing")).toBe(true);
    expect(isOpenFocusStatus("completed")).toBe(false);
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

  it("keeps an item reported as ongoing open and resets its review clock", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.1", "2026-W09.2"],
      updates: [{ id: "2026-W09.2", status: "ongoing", notes: "PR up" }],
      newItems: [],
      weekLabel: "2026-W10",
    });
    expect(result.carried).toBe(1);
    expect(result.resolved).toBe(0);
    // answered, so not aged; clock back to 0 despite having been at 1
    expect(result.content).toContain("| Review RFC | ongoing | 0 | PR up |");
    // the unanswered one still ages
    expect(result.content).toContain("| Write docs | pending | 1 |");
    expect(selectOpenFocusItems(result.content).map((i) => i.id)).toEqual(["2026-W09.1", "2026-W09.2"]);
  });

  it("an ongoing item that is then ignored twice lapses like a pending one", () => {
    let content = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.2"], updates: [{ id: "2026-W09.2", status: "ongoing", notes: "" }],
      newItems: [], weekLabel: "2026-W10",
    }).content;
    content = applyFocusUpdates(content, { reviewedIds: ["2026-W09.2"], updates: [], newItems: [], weekLabel: "2026-W11" }).content;
    const last = applyFocusUpdates(content, { reviewedIds: ["2026-W09.2"], updates: [], newItems: [], weekLabel: "2026-W12" });
    expect(last.lapsed).toBe(1);
    expect(last.content).toContain("| Review RFC | lapsed | 2 |");
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

  it("restates a suggestion re-raised word for word, and resets its clock", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["  review   RFC "], weekLabel: "2026-W10",
    });
    expect(result.restated).toBe(1);
    expect(result.added).toBe(0);
    expect(result.nearDuplicates).toEqual([]);
    expect(result.content).toContain("| Review RFC | pending | 0 | restated 2026-W10 |");
  });

  it("leaves the row this week already created alone when the week is regenerated", () => {
    // Regenerating a week replays the same coaching. The row the first run inserted is
    // the same commitment, not a repeat of an older one.
    const first = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["Add regression coverage"], weekLabel: "2026-W10",
    });
    expect(first.added).toBe(1);
    expect(first.restated).toBe(0);

    const second = applyFocusUpdates(first.content, {
      reviewedIds: [], updates: [], newItems: ["Add regression coverage"], weekLabel: "2026-W10",
    });

    expect(second.restated).toBe(0);
    expect(second.added).toBe(0);
    expect(second.content).toBe(first.content);
    expect(second.content.match(/Add regression coverage/g)).toHaveLength(1);
  });

  it("does not recreate a same-week commitment that this run just completed", () => {
    // The status update closes the row, which takes it out of the open set. Recreating it
    // from the same newItems list left the week holding two contradictory copies.
    const first = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["Ship fix"], weekLabel: "2026-W10",
    });
    expect(first.added).toBe(1);

    const second = applyFocusUpdates(first.content, {
      reviewedIds: ["2026-W10.1"],
      updates: [{ id: "2026-W10.1", status: "completed", notes: "done" }],
      newItems: ["Ship fix"],
      weekLabel: "2026-W10",
    });

    expect(second.added).toBe(0);
    expect(second.restated).toBe(0);
    expect(second.content).not.toContain("2026-W10.2");
    expect(second.content.match(/Ship fix/g)).toHaveLength(1);
    expect(second.content).toContain("| 2026-W10.1 | 2026-W10 | Ship fix | completed | 0 | done |");
  });

  it("does not age the commitment the week being regenerated created", () => {
    // The item is open by the time a rerun reads the file, so the rerun injects it and
    // gets no answer. Counting that as an unanswered review lapsed the commitment after
    // three runs of one week.
    const created = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["Ship fix"], weekLabel: "2026-W10",
    });
    expect(created.content).toContain("| 2026-W10.1 | 2026-W10 | Ship fix | pending | 0 |");

    let content = created.content;
    for (let run = 0; run < 3; run++) {
      const rerun = applyFocusUpdates(content, {
        reviewedIds: ["2026-W10.1"], updates: [], newItems: ["Ship fix"], weekLabel: "2026-W10",
      });
      expect(rerun.lapsed).toBe(0);
      content = rerun.content;
    }

    expect(content).toContain("| 2026-W10.1 | 2026-W10 | Ship fix | pending | 0 |");
    expect(content).not.toContain("lapsed");
  });

  it("still lapses an unanswered commitment once later weeks review it", () => {
    // The accountability mechanism itself is unchanged: two later reviews still close it.
    const created = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["Ship fix"], weekLabel: "2026-W10",
    });

    const week11 = applyFocusUpdates(created.content, {
      reviewedIds: ["2026-W10.1"], updates: [], newItems: [], weekLabel: "2026-W11",
    });
    expect(week11.lapsed).toBe(0);
    expect(week11.content).toContain("| 2026-W10.1 | 2026-W10 | Ship fix | pending | 1 |");

    const week12 = applyFocusUpdates(week11.content, {
      reviewedIds: ["2026-W10.1"], updates: [], newItems: [], weekLabel: "2026-W12",
    });
    expect(week12.lapsed).toBe(1);
    expect(week12.content).toContain("| 2026-W10.1 | 2026-W10 | Ship fix | lapsed | 2 |");
    expect(week12.content).toContain("lapsed after 2 reviews without follow-through");
  });

  it("counts a restatement only when the row it matches is from an earlier week", () => {
    const first = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["Add regression coverage"], weekLabel: "2026-W10",
    });

    const later = applyFocusUpdates(first.content, {
      reviewedIds: [], updates: [], newItems: ["Add regression coverage"], weekLabel: "2026-W11",
    });

    expect(later.restated).toBe(1);
    expect(later.added).toBe(0);
    expect(later.content).toContain("restated 2026-W11");
    expect(later.content.match(/Add regression coverage/g)).toHaveLength(1);
  });

  it("keeps one row when the coach names the same commitment twice in one batch", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: [],
      updates: [],
      newItems: ["Add regression coverage", "add   REGRESSION coverage"],
      weekLabel: "2026-W10",
    });

    expect(result.added).toBe(1);
    expect(result.restated).toBe(0);
    expect(result.content.match(/regression coverage/gi)).toHaveLength(1);
  });

  it("does not append the same status note twice when a week is regenerated", () => {
    const update = { id: "2026-W09.2", status: "ongoing", notes: "Paired once so far" };

    const first = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.2"], updates: [update], newItems: [], weekLabel: "2026-W10",
    });
    const second = applyFocusUpdates(first.content, {
      reviewedIds: ["2026-W09.2"], updates: [update], newItems: [], weekLabel: "2026-W10",
    });

    expect(second.content).toContain("| Paired once so far |");
    expect(second.content).not.toContain("Paired once so far; Paired once so far");
    expect(second.content.match(/Paired once so far/g)).toHaveLength(1);
  });

  it("does not duplicate a note that contains a semicolon of its own", () => {
    // Splitting the cell on every semicolon destroyed this note's boundary, so it could
    // never match itself and grew on every rerun.
    const update = { id: "2026-W09.2", status: "ongoing", notes: "Discussed API; waiting on review" };

    const first = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.2"], updates: [update], newItems: [], weekLabel: "2026-W10",
    });
    const second = applyFocusUpdates(first.content, {
      reviewedIds: ["2026-W09.2"], updates: [update], newItems: [], weekLabel: "2026-W10",
    });

    expect(second.content).toContain("| Discussed API; waiting on review |");
    expect(second.content.match(/Discussed API/g)).toHaveLength(1);
  });

  it("appends after a semicolon note, and still recognises it afterwards", () => {
    const withSemicolon = { id: "2026-W09.2", status: "ongoing", notes: "Discussed API; waiting on review" };

    const first = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.2"], updates: [withSemicolon], newItems: [], weekLabel: "2026-W10",
    });
    const withSecond = applyFocusUpdates(first.content, {
      reviewedIds: ["2026-W09.2"],
      updates: [{ id: "2026-W09.2", status: "ongoing", notes: "Review landed" }],
      newItems: [], weekLabel: "2026-W11",
    });
    // The first note is now in the middle of the cell, and must still match itself.
    const replayed = applyFocusUpdates(withSecond.content, {
      reviewedIds: ["2026-W09.2"], updates: [withSemicolon], newItems: [], weekLabel: "2026-W12",
    });

    expect(withSecond.content).toContain("Discussed API; waiting on review; Review landed");
    expect(replayed.content.match(/Discussed API/g)).toHaveLength(1);
  });

  it("still adds a genuinely different note to a cell that already has one", () => {
    const first = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.2"],
      updates: [{ id: "2026-W09.2", status: "ongoing", notes: "Paired once" }],
      newItems: [], weekLabel: "2026-W10",
    });
    const second = applyFocusUpdates(first.content, {
      reviewedIds: ["2026-W09.2"],
      // A prefix of the existing note, so a substring check would wrongly swallow it.
      updates: [{ id: "2026-W09.2", status: "ongoing", notes: "Paired once more" }],
      newItems: [], weekLabel: "2026-W11",
    });

    expect(second.content).toContain("Paired once; Paired once more");
  });

  it("adds a reworded suggestion and reports what it reads like", () => {
    const result = applyFocusUpdates(base, {
      reviewedIds: [], updates: [], newItems: ["Review the RFC thoroughly"], weekLabel: "2026-W10",
    });
    expect(result.added).toBe(1);
    expect(result.restated).toBe(0);
    expect(result.nearDuplicates).toEqual([{ item: "Review the RFC thoroughly", candidateId: "2026-W09.2" }]);
    expect(result.content).toContain("| Review RFC | pending | 1 |");
    expect(result.content).toContain("| Review the RFC thoroughly | pending | 0 |");
  });

  it("does not fold a new task into an open one that shares a name", () => {
    const withCpp = `# Focus Tracking

| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2026-W09.1 | 2026-W09 | Document C++ build process | pending | 0 |  |
`;

    const result = applyFocusUpdates(withCpp, {
      reviewedIds: [], updates: [], newItems: ["Review C++ build process"], weekLabel: "2026-W10",
    });

    expect(result.added).toBe(1);
    expect(result.restated).toBe(0);
    expect(result.nearDuplicates).toEqual([{ item: "Review C++ build process", candidateId: "2026-W09.1" }]);
    expect(result.content).toContain("Document C++ build process");
    expect(result.content).toContain("Review C++ build process");
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
| 2026-W09 | Ship  the Search Revamp   release correctness loop via TEAM-1234 | pending | |
| 2026-W10 | Recent open item | pending | |
`;

  it("detects a pre-id file", () => {
    expect(needsFocusMigration(legacy)).toBe(true);
    expect(needsFocusMigration(FILE)).toBe(false);
  });

  it("assigns ids, collapses repeats, and closes the unreviewable backlog", () => {
    const { content, assigned, collapsed, lapsed } = migrateFocusTracking(legacy, "2026-W09");
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

  it("keeps two legacy rows that differ only in case", () => {
    const legacyCasing = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W09 | Set API_KEY in the deploy job | pending | |
| 2026-W09 | Set api_key in the deploy job | pending | |
`;

    const { content, assigned, collapsed } = migrateFocusTracking(legacyCasing, "2026-W09");

    // This runs unattended on every worklog run, and one of these is not the other.
    expect({ assigned, collapsed }).toEqual({ assigned: 2, collapsed: 0 });
    expect(content).toContain("Set API_KEY in the deploy job");
    expect(content).toContain("Set api_key in the deploy job");
  });

  it("keeps two legacy rows that read alike but are different tasks", () => {
    const legacyCpp = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W09 | Document C++ build process | pending | |
| 2026-W09 | Review C++ build process | pending | |
`;

    const { content, assigned, collapsed, nearDuplicates } = migrateFocusTracking(legacyCpp, "2026-W09");

    expect(collapsed).toBe(0);
    expect(assigned).toBe(2);
    expect(content).toContain("Document C++ build process");
    expect(content).toContain("Review C++ build process");
    expect(nearDuplicates).toEqual([{ item: "Review C++ build process", candidateId: "2026-W09.1" }]);
  });

  it("keeps an elaboration of a legacy row as its own commitment", () => {
    const legacyPair = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W09 | Ship the Search Revamp release via TEAM-1234 | pending | |
| 2026-W09 | Ship the Search Revamp release via TEAM-1234 and TEAM-1235 | pending | |
`;

    const { assigned, collapsed, nearDuplicates } = migrateFocusTracking(legacyPair, "2026-W09");

    expect({ assigned, collapsed }).toEqual({ assigned: 2, collapsed: 0 });
    expect(nearDuplicates).toHaveLength(1);
  });

  it("lapses stale ongoing rows too, not only pending ones", () => {
    const withOngoing = legacy.replace("| 2026-W01 | Ancient open item | pending | |", "| 2026-W01 | Ancient open item | ongoing | |");
    const { content, lapsed } = migrateFocusTracking(withOngoing, "2026-W09");
    expect(lapsed).toBe(1);
    expect(content).toContain("| 2026-W01.1 | 2026-W01 | Ancient open item | lapsed |");
  });

  it("is idempotent", () => {
    const once = migrateFocusTracking(legacy, "2026-W09").content;
    expect(needsFocusMigration(once)).toBe(false);
    expect(migrateFocusTracking(once, "2026-W09").content).toBe(once);
  });
});

describe("lapseStaleOpenFocusItems", () => {
  it("lapses open rows older than the cutoff, leaves newer and closed rows alone", () => {
    const content = `| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W08.1 | 2026-W08 | Old ongoing | ongoing | 0 |  |
| 2026-W16.1 | 2026-W16 | Old pending | pending | 1 |  |
| 2026-W16.2 | 2026-W16 | Old done | completed | 0 | shipped |
| 2026-W34.1 | 2026-W34 | Recent ongoing | ongoing | 0 |  |
`;
    const { content: out, lapsed } = lapseStaleOpenFocusItems(content, "2026-W34");
    expect(lapsed).toBe(2);
    expect(out).toContain("| Old ongoing | lapsed | 0 | lapsed: still ongoing at 2026-W34 |");
    expect(out).toContain("| Old pending | lapsed | 1 | lapsed: still pending at 2026-W34 |");
    expect(out).toContain("| Old done | completed | 0 | shipped |");
    expect(out).toContain("| Recent ongoing | ongoing | 0 |  |");
  });

  it("is a no-op when nothing is stale", () => {
    const content = "| ID | Week | Focus Item | Status | Reviews | Notes |\n|---|---|---|---|---|---|\n| 2026-W34.1 | 2026-W34 | x | pending | 0 |  |";
    expect(lapseStaleOpenFocusItems(content, "2026-W30")).toEqual({ content, lapsed: 0 });
  });
});

describe("rows that are not focus items", () => {
  const HAND_EDITED = "| my own note | keep me | exactly | as | I | wrote it |";
  const content = `| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W09.1 | 2026-W09 | Write docs | ongoing | 0 |  |
${HAND_EDITED}
| 2026-W10.1 | 2026-W10 | Review RFC | pending | 0 |  |
`;

  it("survive an update, in their original position", () => {
    const result = applyFocusUpdates(content, {
      reviewedIds: ["2026-W09.1"], updates: [{ id: "2026-W09.1", status: "completed", notes: "" }],
      newItems: ["Brand new"], weekLabel: "2026-W11",
    });
    const lines = result.content.split("\n");
    expect(lines[3]).toBe(HAND_EDITED);
    expect(lines[2]).toContain("| Write docs | completed |");
    expect(result.content).toContain("| 2026-W11.1 | 2026-W11 | Brand new |");
  });

  it("survive lapsing", () => {
    const { content: out } = lapseStaleOpenFocusItems(content, "2026-W10");
    expect(out).toContain(HAND_EDITED);
    expect(out).toContain("| Write docs | lapsed |");
  });

  it("make the migration refuse rather than silently drop them", () => {
    const legacy = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W09 | Real item | pending | |
| not a week | something | pending | |
`;
    expect(() => migrateFocusTracking(legacy, "2026-W09")).toThrow(/line 4/);
  });

  it("make a legacy table of only such rows refuse too, instead of reporting success", () => {
    const legacy = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| not a week | handwritten | pending | |
`;
    expect(() => migrateFocusTracking(legacy, "2026-W09")).toThrow(/line 3/);
  });
});

describe("format versioning", () => {
  const format1 = `# Focus Tracking

| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W08.1 | 2026-W08 | Stale ongoing | ongoing | 0 |  |
| 2026-W16.1 | 2026-W16 | Stale pending | pending | 1 |  |
| 2026-W34.1 | 2026-W34 | Recent ongoing | ongoing | 0 |  |
| 2026-W35.1 | 2026-W35 | Current pending | pending | 0 |  |
`;

  it("the template and a fresh migration carry the current marker", () => {
    expect(FOCUS_TRACKING_TEMPLATE).toContain(`<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->`);
    expect(needsFocusFormatUpgrade(FOCUS_TRACKING_TEMPLATE)).toBe(false);
    const migrated = migrateFocusTracking("| Week | Focus Item | Status | Notes |\n|---|---|---|---|\n| 2026-W09 | x | pending | |", "2026-W01").content;
    expect(needsFocusFormatUpgrade(migrated)).toBe(false);
    expect(focusFormatVersion(migrated)).toBe(FOCUS_FORMAT_VERSION);
  });

  it("detects a 2.0.0 file and lapses only the stale open rows once", () => {
    expect(needsFocusFormatUpgrade(format1)).toBe(true);
    const { content, lapsed } = upgradeFocusFormat(format1, "2026-W34");
    expect(lapsed).toBe(2);
    expect(content).toContain("| Stale ongoing | lapsed |");
    expect(content).toContain("| Stale pending | lapsed |");
    expect(content).toContain("| Recent ongoing | ongoing | 0 |");
    expect(content).toContain("| Current pending | pending | 0 |");
    expect(content.split("\n")[1]).toBe(`<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->`);
    expect(needsFocusFormatUpgrade(content)).toBe(false);
    expect(upgradeFocusFormat(content, "2026-W34")).toEqual({ content, lapsed: 0 });
  });

  it("uses the calendar as cutoff, so a file whose newest rows are all stale still cleans up", () => {
    const staleOnly = `| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W01.1 | 2026-W01 | Old one | ongoing | 0 |  |
| 2026-W02.1 | 2026-W02 | Old two | ongoing | 0 |  |
`;
    const { lapsed } = upgradeFocusFormat(staleOnly, "2026-W33");
    expect(lapsed).toBe(2);
  });

  it("refuses to touch a file written by a newer worklog", () => {
    const future = `# Focus Tracking\n<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION + 1} -->\n\n${format1.split("\n").slice(2).join("\n")}`;
    expect(focusFormatVersion(future)).toBe(FOCUS_FORMAT_VERSION + 1);
    expect(() => needsFocusFormatUpgrade(future)).toThrow(/Upgrade worklog/);
    expect(() => upgradeFocusFormat(future, "2026-W34")).toThrow(/Upgrade worklog/);
    expect(() => migrateFocusTracking(future, "2026-W34")).toThrow(/Upgrade worklog/);
  });
});

describe("user-added columns", () => {
  const widened = `| ID | Week | Focus Item | Status | Reviews | Notes | Owner |
|---|---|---|---|---|---|---|
| 2026-W09.1 | 2026-W09 | Write docs | pending | 0 |  | Owner A |
| 2026-W09.2 | 2026-W09 | Review RFC | pending | 0 |  | Owner B |
`;

  it("survive an update on touched and untouched rows, header included", () => {
    const result = applyFocusUpdates(widened, {
      reviewedIds: ["2026-W09.1"], updates: [{ id: "2026-W09.1", status: "completed", notes: "done" }],
      newItems: [], weekLabel: "2026-W10",
    });
    const lines = result.content.split("\n");
    expect(lines[0]).toBe("| ID | Week | Focus Item | Status | Reviews | Notes | Owner |");
    expect(lines[2]).toBe("| 2026-W09.1 | 2026-W09 | Write docs | completed | 0 | done | Owner A |");
    expect(lines[3]).toBe("| 2026-W09.2 | 2026-W09 | Review RFC | pending | 0 |  | Owner B |");
  });

  it("are never lost when a duplicate row is collapsed", () => {
    const legacy = `| Week | Focus Item | Status | Notes | Owner |
|---|---|---|---|---|
| 2026-W09 | Ship the Search Revamp release via TEAM-1234 | pending | first note | Owner A |
| 2026-W09 | Ship the Search Revamp release through TEAM-1234 | pending | second note | Owner B |
| 2026-W09 | Ship the Search Revamp release  through TEAM-1234 | pending |  |  |
`;
    const { content, collapsed, assigned } = migrateFocusTracking(legacy, "2026-W09");
    // the empty third row collapses; the second carries its own note and owner, so it stays
    expect(collapsed).toBe(1);
    expect(assigned).toBe(2);
    expect(content).toContain("| first note | Owner A |");
    expect(content).toContain("| second note | Owner B |");
  });

  it("still collapse a safe duplicate that sits after a different-outcome one", () => {
    const legacy = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W09 | Ship the auth PR | completed | |
| 2026-W09 | Ship the auth PR | pending | |
| 2026-W09 | Ship  the auth PR | pending | |
`;
    const { assigned, collapsed } = migrateFocusTracking(legacy, "2026-W09");
    expect(collapsed).toBe(1);
    expect(assigned).toBe(2);
  });

  it("collapse two stale duplicates and lapse the survivor", () => {
    const legacy = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W01 | Ship the auth PR | pending | |
| 2026-W01 | Ship  the auth PR | pending | |
`;
    const { assigned, collapsed, lapsed } = migrateFocusTracking(legacy, "2026-W09");
    expect({ assigned, collapsed, lapsed }).toEqual({ assigned: 1, collapsed: 1, lapsed: 1 });
  });

  it("keep both rows when duplicates disagree on outcome", () => {
    const legacy = `| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W09 | Ship the auth PR | pending | |
| 2026-W09 | Ship  the auth PR | completed | |
`;
    const { content, collapsed } = migrateFocusTracking(legacy, "2026-W09");
    expect(collapsed).toBe(0);
    expect(content).toContain("| Ship the auth PR | pending |");
    expect(content).toContain("| Ship  the auth PR | completed |");
  });

  it("survive the legacy migration, header included", () => {
    const legacyWidened = `| Week | Focus Item | Status | Notes | Owner |
|---|---|---|---|---|
| 2026-W09 | Ship docs | pending | note | Owner A |
`;
    const { content } = migrateFocusTracking(legacyWidened, "2026-W09");
    const lines = content.split("\n");
    const header = lines.findIndex((line) => line.startsWith("| ID"));
    expect(lines[header]).toBe("| ID | Week | Focus Item | Status | Reviews | Notes | Owner |");
    expect(lines[header + 2]).toBe("| 2026-W09.1 | 2026-W09 | Ship docs | pending | 0 | note | Owner A |");
  });
});

describe("format marker robustness", () => {
  it("reads an indented marker and still refuses a newer version", () => {
    const indented = `# Focus Tracking\n  <!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION + 1} -->\n| ID | Week | Focus Item | Status | Reviews | Notes |\n|---|---|---|---|---|---|\n| 2026-W01.1 | 2026-W01 | x | ongoing | 0 |  |\n`;
    expect(focusFormatVersion(indented)).toBe(FOCUS_FORMAT_VERSION + 1);
    expect(() => needsFocusFormatUpgrade(indented)).toThrow(/Upgrade worklog/);
  });

  it.each([
    "<!-- worklog-focus-format: two -->",
    "<!-- worklog-focus-format: 2oops -->",
    "<!-- worklog-focus-format: 2.1 -->",
    "<!-- worklog-focus-format: 2",
    "<!-- worklog-focus-format: -->",
    "<!-- worklog-focus-format:2 -->",
    "<!-- worklog-focus-format:  2 -->",
    "<!-- worklog-focus-format: 2  -->",
  ])("throws on a malformed marker (%s) instead of guessing a version", (marker) => {
    expect(() => focusFormatVersion(`# Focus Tracking\n${marker}\n`)).toThrow(/unreadable format marker/);
  });

  it("ignores a marker under an archived heading and leaves it untouched", () => {
    const file = `# Focus Tracking

| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2020-W01.1 | 2020-W01 | Stale ongoing | ongoing | 0 |  |

## Old era — ARCHIVED
<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->
| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
`;
    expect(focusFormatVersion(file)).toBeNull();
    expect(needsFocusFormatUpgrade(file)).toBe(true);
    const { content, lapsed } = upgradeFocusFormat(file, "2026-W33");
    expect(lapsed).toBe(1);
    expect(content.split("\n")[1]).toBe(`<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->`);
    expect(content).toContain(`## Old era — ARCHIVED\n<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->`);
  });

  it.each([1, 2, 3])("respects an archived heading indented by %s space(s)", (n) => {
    const file = `# Focus Tracking

| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W34.1 | 2026-W34 | Live item | pending | 0 |  |

${" ".repeat(n)}## Old era — ARCHIVED
| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2020-W01.1 | 2020-W01 | Historical item | ongoing | 0 | keep |
`;
    expect(selectOpenFocusItems(file).map((i) => i.id)).toEqual(["2026-W34.1"]);
    const { content, lapsed } = upgradeFocusFormat(file, "2026-W33");
    expect(lapsed).toBe(0);
    expect(content).toContain("| Historical item | ongoing | 0 | keep |");
  });

  it("keeps the last cell of a row written without a trailing pipe", () => {
    const file = `| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W01.1 | 2026-W01 | Old | ongoing | 0 | do not lose this note
`;
    const { content } = upgradeFocusFormat(file, "2026-W33");
    expect(content).toContain("| Old | lapsed | 0 | do not lose this note; lapsed: still ongoing at 2026-W33 |");
  });

  it("migrates an empty legacy table once, not on every run", () => {
    const empty = "# Focus Tracking\n\n| Week | Focus Item | Status | Notes |\n|---|---|---|---|\n";
    const once = migrateFocusTracking(empty, "2026-W09").content;
    expect(needsFocusMigration(once)).toBe(false);
    expect(needsFocusFormatUpgrade(once)).toBe(false);
    expect(once).toContain("| ID | Week | Focus Item | Status | Reviews | Notes |");
  });

  it("keeps a cell that ends in a literal backslash intact", () => {
    const file = "| ID | Week | Focus Item | Status | Reviews | Notes |\n|---|---|---|---|---|---|\n|2026-W01.1|2026-W01|Old|ongoing|0|C:\\\\|\n";
    const items = parseFocusItems(file);
    expect(items[0].notes).toBe("C:\\");
    const { content } = upgradeFocusFormat(file, "2026-W33");
    const row = content.split("\n").find((line) => line.includes("2026-W01.1"));
    expect(row).toBe("| 2026-W01.1 | 2026-W01 | Old | lapsed | 0 | C:\\\\; lapsed: still ongoing at 2026-W33 |");
  });

  it.each([
    ["id-keyed", "| ID | Week | Focus Item | Status | Reviews | Notes |\n|---|---|---|---|---|---|\n| 2026-W01.1 | 2026-W01 | x | ongoing | 0 |  |\n"],
    ["empty legacy", "| Week | Focus Item | Status | Notes |\n|---|---|---|---|\n"],
  ])("keeps frontmatter first when there is no heading (%s table)", (_label, table) => {
    const file = `---\ntags:\n  - work\n---\n${table}`;
    const migrated = _label === "id-keyed" ? upgradeFocusFormat(file, "2026-W33").content : migrateFocusTracking(file, "2026-W33").content;
    const lines = migrated.split("\n");
    expect(lines.slice(0, 4)).toEqual(["---", "tags:", "  - work", "---"]);
    expect(lines[4]).toBe(`<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->`);
  });

  it("does not mistake an indented --- inside a YAML block scalar for the frontmatter close", () => {
    const file = "---\ndescription: |\n  ---\n  keep this text\ntags: [work]\n---\n| Week | Focus Item | Status | Notes |\n|---|---|---|---|\n";
    const lines = migrateFocusTracking(file, "2026-W33").content.split("\n");
    expect(lines.slice(0, 6)).toEqual(["---", "description: |", "  ---", "  keep this text", "tags: [work]", "---"]);
    expect(lines[6]).toBe(`<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->`);
  });

  it("ignores heading-, table- and marker-looking lines inside frontmatter", () => {
    const file = `---
description: |
  ## ARCHIVED
  <!-- worklog-focus-format: 9 -->
  |---|
---
| Week | Focus Item | Status | Notes |
|---|---|---|---|
| 2026-W34 | Existing commitment | pending | keep |
`;
    expect(focusFormatVersion(file)).toBeNull();
    expect(parseFocusItems(file).map((i) => i.item)).toEqual(["Existing commitment"]);
    const { content, assigned } = migrateFocusTracking(file, "2026-W33");
    expect(assigned).toBe(1);
    expect(content).toContain("| 2026-W34.1 | 2026-W34 | Existing commitment | pending | 0 | keep |");
    expect(content.split("\n").slice(0, 6).join("\n")).toBe(file.split("\n").slice(0, 6).join("\n"));
  });

  it("puts the marker under the heading when frontmatter and a heading both exist", () => {
    const file = "---\ntags: []\n---\n# Focus Tracking\n\n| Week | Focus Item | Status | Notes |\n|---|---|---|---|\n";
    const lines = migrateFocusTracking(file, "2026-W33").content.split("\n");
    expect(lines[3]).toBe("# Focus Tracking");
    expect(lines[4]).toBe(`<!-- worklog-focus-format: ${FOCUS_FORMAT_VERSION} -->`);
  });

  it("refuses a file with two live markers", () => {
    const file = `# Focus Tracking\n<!-- worklog-focus-format: 2 -->\n<!-- worklog-focus-format: 2 -->\n`;
    expect(() => focusFormatVersion(file)).toThrow(/2 format markers/);
  });

  it("migrateFocusTracking defaults its cutoff from the calendar when none is given", () => {
    const legacy = "| Week | Focus Item | Status | Notes |\n|---|---|---|---|\n| 2020-W01 | Ancient | pending | |\n";
    expect(migrateFocusTracking(legacy).lapsed).toBe(1);
  });
});

describe("duplicate status rows", () => {
  it("apply once", () => {
    const base = `| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W09.1 | 2026-W09 | Write docs | pending | 0 |  |
`;
    const result = applyFocusUpdates(base, {
      reviewedIds: ["2026-W09.1"],
      updates: [
        { id: "2026-W09.1", status: "ongoing", notes: "PR up" },
        { id: "2026-W09.1", status: "ongoing", notes: "PR up" },
        { id: "2026-W09.1", status: "completed", notes: "no wait" },
      ],
      newItems: [], weekLabel: "2026-W10",
    });
    expect(result.carried).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.content).toContain("| Write docs | ongoing | 0 | PR up |");
  });
});
