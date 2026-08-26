import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, chmod, lstat, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  updateMemory, updateImpactLog, updateWorkContext, updateProfile,
  updateFocusTracking, migrateFocusTrackingFile, migrateVaultRecordsFile, isPlaceholder,
} from "../vault-updates";
import { appendToFirstTable, splitRow } from "../markdown-table";
import { generateProfileDoc, generateWorkContextDoc } from "../doc-generators";
import type { WorklogConfig } from "../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "vault-updates-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const TWO_ERA_MEMORY = `# Memory

## Team Now (2026 - present)

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-02-01 | Current item | Fix | |

## Team Before (2025) — HISTORICAL

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2025-05-01 | Old item | Fix | |
`;

describe("appendToFirstTable", () => {
  it("inserts after the last row of the first table, not at end of file", () => {
    const result = appendToFirstTable(TWO_ERA_MEMORY, ["| 2026-03-01 | New item | Fix | |"]);
    const lines = result.split("\n");
    const newIdx = lines.findIndex((line: string) => line.includes("New item"));
    expect(lines[newIdx - 1]).toContain("Current item");
    expect(lines[newIdx + 1]).toBe("");
    expect(lines.indexOf("## Team Before (2025) — HISTORICAL")).toBeGreaterThan(newIdx);
  });

  it("appends at the end when there is no table", () => {
    expect(appendToFirstTable("# Empty\n", ["| row |"])).toBe("# Empty\n| row |");
  });

  it("returns content unchanged for no rows", () => {
    expect(appendToFirstTable(TWO_ERA_MEMORY, [])).toBe(TWO_ERA_MEMORY);
  });
});

describe("updateMemory", () => {
  it("creates memory file with default template when missing", async () => {
    const path = join(tmpDir, "memory.md");
    await updateMemory(path, ["| 2026-03-05 | Shipped auth | project | CORE-42 |"], []);
    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Memory");
    expect(content).toContain("Shipped auth");
  });

  it("appends items to existing memory", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, "# Memory\n\n| Date | Item | Category | Notes |\n|------|------|----------|-------|\n| 2026-03-01 | Old item | misc | |");
    await updateMemory(path, ["| 2026-03-05 | New item | project | |"], []);
    const content = await readFile(path, "utf-8");
    expect(content).toContain("Old item");
    expect(content).toContain("New item");
  });

  it("adds new rows to the current era table, above historical sections", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, TWO_ERA_MEMORY);
    await updateMemory(path, ["| 2026-03-01 | New item | Fix | |"], []);
    const content = await readFile(path, "utf-8");
    expect(content.indexOf("New item")).toBeLessThan(content.indexOf("HISTORICAL"));
  });

  it("removes graduated items", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, "# Memory\n\n| Date | Item | Category | Notes |\n|------|------|----------|-------|\n| 2026-03-01 | Ship auth | project | |");
    await updateMemory(path, [], ["Ship auth (now part of brag book)"]);
    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("Ship auth");
  });

  it("skips non-table rows in itemsToAdd", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, "# Memory\n\nTable here");
    await updateMemory(path, ["not a table row"], []);
    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("not a table row");
  });
});

describe("updateImpactLog", () => {
  it("does nothing for null entry", async () => {
    const path = join(tmpDir, "impact.md");
    await writeFile(path, "original");
    await updateImpactLog(path, null);
    expect(await readFile(path, "utf-8")).toBe("original");
  });

  it("appends impact entry to timeline table", async () => {
    const path = join(tmpDir, "impact.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|

**Last significant impact:** 2026-02-01
**Current gap:** 4 weeks`);

    await updateImpactLog(path, {
      date: "2026-03-05",
      achievement: "Shipped auth",
      scope: "team",
      coreValue: "quality",
      evidence: "CORE-42",
    });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-03-05 | Shipped auth | team | quality | CORE-42 |");
    expect(content).toContain("**Last significant impact:** 2026-03-05");
    expect(content).toContain("None - recent entry added");
  });
});

describe("updateWorkContext", () => {
  it("does nothing for empty updates", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, "original");
    await updateWorkContext(path, []);
    expect(await readFile(path, "utf-8")).toBe("original");
  });

  it("inserts entries under Organizational Notes", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

*Last updated: 2026-02-01*

## Organizational Notes
Existing notes here.`);

    await updateWorkContext(path, [
      { category: "current_work", info: "Auth migration", source: "CORE-42" },
    ]);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("**current_work:** Auth migration _(CORE-42)_");
    expect(content).toMatch(/Last updated: \d{4}-\d{2}-\d{2}/);
  });
});

describe("updateProfile", () => {
  it("does nothing for null update", async () => {
    const path = join(tmpDir, "profile.md");
    await writeFile(path, "original");
    await updateProfile(path, null);
    expect(await readFile(path, "utf-8")).toBe("original");
  });

  it("appends bullet point to Key Strengths", async () => {
    const path = join(tmpDir, "profile.md");
    await writeFile(path, `# My Profile

## Key Strengths
- Existing strength

## Other Section
More stuff`);

    await updateProfile(path, { achievement: "Led auth migration", bulletPoint: "Designed and shipped OAuth integration" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- Designed and shipped OAuth integration");
    expect(content).toContain("## Other Section");
  });
});

describe("updateFocusTracking", () => {
  it("creates the file with an id-keyed table and records new items", async () => {
    const path = join(tmpDir, "focus.md");
    const result = await updateFocusTracking(path, {
      focusItems: ["Ship auth PR"], focusUpdates: [], reviewedIds: [], weekLabel: "2026-W10",
    });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Focus Tracking");
    expect(content).toContain("| 2026-W10.1 | 2026-W10 | Ship auth PR | pending | 0 |  |");
    expect(result.added).toBe(1);
  });

  it("closes an item by id even when the coach rewords it", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `# Focus Tracking

| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2026-W09.1 | 2026-W09 | Get [TEAM-1234](https://example.com/TEAM-1234) through review | pending | 0 |  |
`);

    const result = await updateFocusTracking(path, {
      focusItems: [], reviewedIds: ["2026-W09.1"], weekLabel: "2026-W10",
      focusUpdates: [{ id: "2026-W09.1", status: "completed", notes: "merged" }],
    });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-W09.1 | 2026-W09 |");
    expect(content).toContain("| completed | 0 | merged |");
    expect(result.resolved).toBe(1);
    expect(result.lapsed).toBe(0);
  });

  it("lapses an item the coach ignored twice", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2026-W09.1 | 2026-W09 | Write docs | pending | 0 |  |
`);
    const opts = { focusItems: [], focusUpdates: [], reviewedIds: ["2026-W09.1"], weekLabel: "2026-W10" };

    const first = await updateFocusTracking(path, opts);
    expect(first.lapsed).toBe(0);
    expect(await readFile(path, "utf-8")).toContain("| pending | 1 |");

    const second = await updateFocusTracking(path, { ...opts, weekLabel: "2026-W11" });
    expect(second.lapsed).toBe(1);
    const content = await readFile(path, "utf-8");
    expect(content).toContain("| lapsed | 2 |");
    expect(content).toContain("lapsed after 2 reviews");
  });

  it("treats a suggestion re-raised word for word as a restatement, not a new row", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2026-W09.1 | 2026-W09 | Close the Search Revamp release correctness loop through TEAM-1234 | pending | 1 |  |
`);

    const result = await updateFocusTracking(path, {
      focusItems: ["close the search revamp release correctness loop through TEAM-1234"],
      focusUpdates: [], reviewedIds: [], weekLabel: "2026-W10",
    });

    const content = await readFile(path, "utf-8");
    expect(result.restated).toBe(1);
    expect(result.added).toBe(0);
    expect(content.match(/2026-W\d\d\.\d/g)).toHaveLength(1);
    expect(content).toContain("restated 2026-W10");
    expect(content).toContain("| pending | 0 |");
  });

  it("records a reworded suggestion as its own item", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2026-W09.1 | 2026-W09 | Close the Search Revamp release correctness loop through TEAM-1234 | pending | 1 |  |
`);

    const result = await updateFocusTracking(path, {
      focusItems: ["Close the Search Revamp release correctness through TEAM-1234 and TEAM-1235"],
      focusUpdates: [], reviewedIds: [], weekLabel: "2026-W10",
    });

    expect(result.added).toBe(1);
    expect(result.restated).toBe(0);
    expect(result.nearDuplicates).toHaveLength(1);
    expect(result.nearDuplicates[0].candidateId).toBe("2026-W09.1");
    expect((await readFile(path, "utf-8")).match(/2026-W\d\d\.\d/g)).toHaveLength(2);
  });
});

describe("migrateFocusTrackingFile", () => {
  it("upgrades a pre-id file once, keeping a backup", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `# Focus Tracking

| Week | Focus Item | Status | Notes |
|------|------------|--------|-------|
| 2026-W01 | Ancient still open | pending | |
| 2026-W09 | Recent still open | pending | |
| 2026-W09 | recent  STILL open | pending | |
| 2026-W10 | Newest still open | pending | |
`);

    const result = await migrateFocusTrackingFile(path, new Date("2026-03-11T12:00:00Z")); // 2026-W11
    expect(result).toMatchObject({ kind: "ids", backup: `${path}.pre-ids.bak`, assigned: 3, collapsed: 1, lapsed: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-W01.1 | 2026-W01 | Ancient still open | lapsed |");
    expect(content).toContain("| 2026-W09.1 | 2026-W09 | Recent still open | pending |");
    expect(await readFile(`${path}.pre-ids.bak`, "utf-8")).toContain("| Week | Focus Item |");

    // second run is a no-op
    expect(await migrateFocusTrackingFile(path)).toBeNull();
  });

  it("upgrades a 2.0.0 id-keyed file once, lapsing stale open rows, with its own backup", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `# Focus Tracking

| ID | Week | Focus Item | Status | Reviews | Notes |
|---|---|---|---|---|---|
| 2026-W08.1 | 2026-W08 | Stale ongoing | ongoing | 0 |  |
| 2026-W34.1 | 2026-W34 | Recent | pending | 0 |  |
| 2026-W35.1 | 2026-W35 | Current | ongoing | 0 |  |
`);
    const now = new Date("2026-08-26T12:00:00Z"); // 2026-W35
    expect(await migrateFocusTrackingFile(path, now)).toMatchObject({ kind: "format", backup: `${path}.pre-format2.bak`, lapsed: 1 });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("worklog-focus-format: 2");
    expect(content).toContain("| Stale ongoing | lapsed |");
    expect(content).toContain("| Current | ongoing | 0 |");
    expect(await readFile(`${path}.pre-format2.bak`, "utf-8")).not.toContain("worklog-focus-format");
    expect(await migrateFocusTrackingFile(path, now)).toBeNull();
  });
});

// --- Record identity: placeholders, duplicates, idempotency ---

const CLEAN_MEMORY = `# Memory

## Current Team (2026 - present)

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1234 |
`;

const CLEAN_WORK_CONTEXT = `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`;

const CLEAN_PROFILE = `# My Profile

## Key Strengths

_(Added automatically as significant achievements are recorded)_
- Untangles flaky test suites other people avoid

---

*Last updated: 2026-02-01*
`;

const CLEAN_IMPACT_LOG = `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|

**Last significant impact:** 2026-02-01
**Current gap:** 4 weeks
`;

describe("isPlaceholder", () => {
  it("rejects blanks, parenthesised asides, template hints and bare sentinels", () => {
    for (const text of [
      "",
      "   ",
      "(none)",
      "(leave blank if none)",
      "_(Added automatically as new information is discovered)_",
      "<!-- TODO: add your technical skills (e.g. TypeScript, React, Node.js) -->",
      "n/a",
      "None",
    ]) {
      expect(isPlaceholder(text), text).toBe(true);
    }
  });

  it("keeps real text, including text with a parenthesis in it", () => {
    for (const text of [
      "Shipped the Search Revamp indexer fallback",
      "(TEAM-1234) rollout finished without a rollback",
      "Nothing shipped this week, but the design doc landed",
    ]) {
      expect(isPlaceholder(text), text).toBe(false);
    }
  });
});

describe("updateMemory record identity", () => {
  it("drops a repeat of a row already in the current table", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    await updateMemory(path, [
      "| 2026-03-01 |   wrote the FALLBACK path for the Search Revamp indexer | project | TEAM-1234 |",
      "| 2026-03-08 | Reviewed the alert noise backlog with the on-call rota | support |  |",
    ], []);

    const content = await readFile(path, "utf-8");
    expect(content.match(/fallback path/gi)).toHaveLength(1);
    expect(content).toContain("alert noise backlog");
  });

  it("writes a row that reads like one already there but is not the same text", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    // Similarity would call this the same row. It is not, and only the writer's own
    // text can decide that: rejecting it loses whatever the second row says.
    await updateMemory(path, [
      "| 2026-03-08 | Wrote a second fallback path for the Search Revamp indexer | project | TEAM-1240 |",
    ], []);

    const content = await readFile(path, "utf-8");
    expect(content.match(/fallback path/g)).toHaveLength(2);
  });

  it("drops placeholder rows the model emits when it has nothing to add", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);
    await updateMemory(path, ["| 2026-03-08 | (none) | misc |  |"], []);
    expect(await readFile(path, "utf-8")).toBe(CLEAN_MEMORY);
  });

  it("graduates the row the coach quoted", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    await updateMemory(path, [], [
      "Wrote the fallback path for the Search Revamp indexer (now part of: shipped indexer resilience)",
    ]);

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("fallback path");
    expect(content).toContain("| Date | Item | Category | Notes |");
  });

  it("reports rather than deletes when the coach paraphrases the row", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    const result = await updateMemory(path, [], [
      "Fallback path work for the Search Revamp indexer (now part of: shipped indexer resilience)",
    ]);

    expect(result.removed).toBe(0);
    expect(result.unmatchedGraduations).toEqual([
      {
        requested: "Fallback path work for the Search Revamp indexer",
        candidate: "Wrote the fallback path for the Search Revamp indexer",
      },
    ]);
    expect(await readFile(path, "utf-8")).toBe(CLEAN_MEMORY);
  });

  it("does not delete a row that says the opposite of the removal", async () => {
    const path = join(tmpDir, "memory.md");
    const file = `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Enable service billing alerts for platform teams | project | TEAM-1234 |
`;
    await writeFile(path, file);

    const result = await updateMemory(path, [], [
      "Disable service billing alerts for platform teams (now part of: billing cleanup)",
    ]);

    expect(result.removed).toBe(0);
    expect(result.unmatchedGraduations[0].candidate).toBe("Enable service billing alerts for platform teams");
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("graduates one row per removal, not every row that reads alike", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the Search Revamp rollout plan with the platform team | project |  |
| 2026-03-02 | Reviewed the Search Revamp rollout plan with the platform team | project |  |
`);

    const result = await updateMemory(path, [], [
      "Reviewed the Search Revamp rollout plan with the platform team (now part of: ran the rollout)",
    ]);

    // The model names the item, not the day, so both dates of it graduate together.
    expect(result.removed).toBe(2);
    expect(await readFile(path, "utf-8")).not.toContain("rollout plan");
  });

  it("leaves an item the removal does not name", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the Search Revamp rollout plan with the platform team | project |  |
| 2026-03-02 | Reviewed the incident runbook | support |  |
`);

    const result = await updateMemory(path, [], ["Reviewed the incident runbook (now part of: on-call overhaul)"]);

    expect(result.removed).toBe(1);
    const content = await readFile(path, "utf-8");
    expect(content).toContain("rollout plan");
    expect(content).not.toContain("incident runbook");
  });

  it("compares against the current era only, leaving archived rows out of it", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, TWO_ERA_MEMORY);
    await updateMemory(path, ["| 2026-03-01 | Old item | Fix | |"], []);
    const content = await readFile(path, "utf-8");
    expect(content.match(/Old item/g)).toHaveLength(2);
  });
});

describe("updateWorkContext record identity", () => {
  it("drops placeholder info and collapses repeats inside one batch", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);

    await updateWorkContext(path, [
      { category: "process", info: "(none)", source: "unknown" },
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1200" },
      { category: "team", info: "Design review happens on Thursday afternoons", source: "TEAM-1300" },
      { category: "team", info: "design review   happens on THURSDAY afternoons", source: "TEAM-1301" },
    ]);

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("(none)");
    // The first is the note already in the file, word for word.
    expect(content.match(/ship on Tuesdays/g)).toHaveLength(1);
    expect(content.match(/[Dd]esign review\s+happens/g)).toHaveLength(1);
    // One bullet, but it cites both tickets that reported the same fact.
    expect(content).toContain("_(TEAM-1300, TEAM-1301)_");
  });

  it("writes a note that reads like one already there but says something else", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);

    await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays and require manager approval", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1200)_");
    expect(content).toContain("require manager approval");
  });

  it("keeps new notes inside the Organizational Notes section", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);
    await updateWorkContext(path, [{ category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" }]);

    const content = await readFile(path, "utf-8");
    const noteIdx = content.indexOf("Support rota");
    expect(noteIdx).toBeGreaterThan(content.indexOf("## Organizational Notes"));
    expect(noteIdx).toBeLessThan(content.indexOf("---"));
  });
});

describe("updateProfile record identity", () => {
  it("rejects the placeholder bullets that filled the file with (none)", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);
    await updateProfile(path, { achievement: "(none)", bulletPoint: "(none)" });
    await updateProfile(path, { achievement: "none", bulletPoint: "(leave blank if none)" });
    expect(await readFile(path, "utf-8")).toBe(CLEAN_PROFILE);
  });

  it("rejects a repeat of a strength already listed", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);
    expect(await updateProfile(path, {
      achievement: "Test suite cleanup",
      bulletPoint: "  untangles FLAKY test suites   other people avoid",
    })).toMatchObject({ status: "unchanged" });
    expect(await readFile(path, "utf-8")).toBe(CLEAN_PROFILE);
  });

  it("writes a strength that reads like one already listed but is not the same claim", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);
    expect(await updateProfile(path, {
      achievement: "Test suite cleanup",
      bulletPoint: "Untangles the flaky test suites that other people avoid, then teaches the fix",
    })).toMatchObject({ status: "written" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- Untangles flaky test suites other people avoid");
    expect(content).toContain("then teaches the fix");
  });

  it("adds a genuinely new strength inside the section", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);
    await updateProfile(path, {
      achievement: "Search Revamp rollout",
      bulletPoint: "Runs multi-team rollouts without a rollback",
    });

    const content = await readFile(path, "utf-8");
    const bulletIdx = content.indexOf("- Runs multi-team rollouts");
    expect(bulletIdx).toBeGreaterThan(content.indexOf("## Key Strengths"));
    expect(bulletIdx).toBeLessThan(content.indexOf("---"));
  });
});

describe("updateImpactLog record identity", () => {
  it("does not append the same achievement on the same date twice", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);
    const entry = {
      date: "2026-03-05",
      achievement: "Led the Search Revamp rollout across three teams",
      scope: "org",
      coreValue: "craft",
      evidence: "TEAM-1234",
    };

    await updateImpactLog(path, entry);
    await updateImpactLog(path, { ...entry, evidence: "TEAM-1234, TEAM-1235" });

    const content = await readFile(path, "utf-8");
    expect(content.match(/Search Revamp rollout/g)).toHaveLength(1);
    expect(content).toContain("**Last significant impact:** 2026-03-05");
  });
});

describe("applying the same week twice", () => {
  it("leaves all four record files byte-identical", async () => {
    const memoryPath = join(tmpDir, "memory.md");
    const workContextPath = join(tmpDir, "work-context.md");
    const profilePath = join(tmpDir, "my-profile.md");
    const impactLogPath = join(tmpDir, "impact-log.md");

    await writeFile(memoryPath, CLEAN_MEMORY);
    await writeFile(workContextPath, CLEAN_WORK_CONTEXT);
    await writeFile(profilePath, CLEAN_PROFILE);
    await writeFile(impactLogPath, CLEAN_IMPACT_LOG);

    const result = {
      itemsToAdd: [
        "| 2026-03-08 | Cut the search index rebuild from 40 to 12 minutes | project | TEAM-1234 |",
        "| 2026-03-08 | Documented the on-call escalation path | support |  |",
      ],
      itemsToRemove: ["Fallback path work for the Search Revamp indexer (now part of: shipped indexer resilience)"],
      impactLogEntry: {
        date: "2026-03-08",
        achievement: "Led the Search Revamp rollout across three teams",
        scope: "org",
        coreValue: "craft",
        evidence: "TEAM-1234",
      },
      workContextUpdates: [
        { category: "process", info: "Release readiness reviews moved to Wednesday", source: "TEAM-1300" },
      ],
      profileUpdate: {
        achievement: "Search Revamp rollout",
        bulletPoint: "Runs multi-team rollouts without a rollback",
      },
    };

    const apply = async () => {
      await updateMemory(memoryPath, result.itemsToAdd, result.itemsToRemove);
      await updateImpactLog(impactLogPath, result.impactLogEntry);
      await updateWorkContext(workContextPath, result.workContextUpdates);
      await updateProfile(profilePath, result.profileUpdate);
      return Promise.all([
        readFile(memoryPath, "utf-8"),
        readFile(impactLogPath, "utf-8"),
        readFile(workContextPath, "utf-8"),
        readFile(profilePath, "utf-8"),
      ]);
    };

    const first = await apply();
    const second = await apply();

    expect(second).toEqual(first);
    expect(first[0]).toContain("Cut the search index rebuild");
    expect(first[1]).toContain("Led the Search Revamp rollout");
    expect(first[2]).toContain("Release readiness reviews moved to Wednesday");
    expect(first[3]).toContain("Runs multi-team rollouts without a rollback");
  });
});

describe("migrateVaultRecordsFile", () => {
  it("returns null for a file that is not there", async () => {
    expect(await migrateVaultRecordsFile(join(tmpDir, "missing.md"), "memory")).toBeNull();
  });

  it("strips the (none) rows from Key Strengths and keeps the template hint", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, `# My Profile

## Key Strengths

_(Added automatically as significant achievements are recorded)_
- (none)
- (none)
- (leave blank)
- Untangles flaky test suites other people avoid
- Untangles flaky test suites other people avoid

---

*Last updated: 2026-02-01*
`);

    expect(await migrateVaultRecordsFile(path, "my-profile"))
      .toEqual({ placeholders: 3, duplicates: 1, backup: `${path}.pre-dedupe.bak` });

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("(none)");
    expect(content).toContain("_(Added automatically as significant achievements are recorded)_");
    expect(content.match(/Untangles flaky test suites/g)).toHaveLength(1);
    expect(await readFile(`${path}.pre-dedupe.bak`, "utf-8")).toContain("- (none)");
  });

  it("collapses the repeated organizational notes", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_
- **process:** Release trains ship on Tuesdays _(TEAM-1200)_
- **process:** Release trains ship on Tuesdays _(TEAM-1201)_
- **process:** (none) _(unknown)_
- **team:** Design review happens on Thursday afternoons _(TEAM-1300)_

---

*Last updated: 2026-02-01*
`);

    expect(await migrateVaultRecordsFile(path, "work-context"))
      .toEqual({ placeholders: 1, duplicates: 2, backup: `${path}.pre-dedupe.bak` });

    const content = await readFile(path, "utf-8");
    expect(content.match(/ship on Tuesdays/g)).toHaveLength(1);
    // Collapsing the repeats keeps the ticket that only the third one cited.
    expect(content).toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1200, TEAM-1201)_");
    expect(content).toContain("Design review happens on Thursday afternoons");
    expect(content).not.toContain("(none)");
  });

  it("collapses repeated memory rows in the current era only", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

## Current Team (2026 - present)

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1234 |
| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1234 |
| 2026-03-03 |  | project |  |

## Previous Team (2025) — HISTORICAL

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2025-05-01 | Old item | Fix | |
| 2025-05-02 | Old item | Fix | |
`);

    expect(await migrateVaultRecordsFile(path, "memory"))
      .toEqual({ placeholders: 1, duplicates: 1, backup: `${path}.pre-dedupe.bak` });

    const content = await readFile(path, "utf-8");
    expect(content.match(/fallback path/g)).toHaveLength(1);
    expect(content.match(/Old item/g)).toHaveLength(2);
  });

  it("collapses impact entries repeated on the same date", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-03-05 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-03-06 | Led the Search Revamp rollout | org | craft | TEAM-1235 |

**Last significant impact:** 2026-03-06
**Current gap:** None - recent entry added
`);

    expect(await migrateVaultRecordsFile(path, "impact-log"))
      .toEqual({ placeholders: 0, duplicates: 1, backup: `${path}.pre-dedupe.bak` });
    const content = await readFile(path, "utf-8");
    expect(content.match(/Search Revamp rollout/g)).toHaveLength(2);
  });

  it("rewrites nothing on a second run", async () => {
    const path = join(tmpDir, "my-profile.md");
    const backupPath = `${path}.pre-dedupe.bak`;
    await writeFile(path, `# My Profile

## Key Strengths

- (none)
- Untangles flaky test suites other people avoid
`);

    expect(await migrateVaultRecordsFile(path, "my-profile"))
      .toEqual({ placeholders: 1, duplicates: 0, backup: backupPath });
    const cleaned = await readFile(path, "utf-8");
    await writeFile(backupPath, "sentinel", "utf-8");

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(cleaned);
    expect(await readFile(backupPath, "utf-8")).toBe("sentinel");
  });
});

describe("record dedupe threshold", () => {
  it("keeps two notes about the same system that state different facts", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **architecture:** The ingest service is the intake and normalization layer for search-relevant events _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`);

    await updateWorkContext(path, [
      {
        category: "architecture",
        info: "TEAM-1234 proposes moving automatic-start matching out of the ingest service into the indexer",
        source: "TEAM-1234",
      },
      {
        category: "architecture",
        info: "The ingest service normalizes search-relevant events before they reach the indexer",
        source: "TEAM-1235",
      },
    ]);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("automatic-start matching");
    expect(content).toContain("before they reach the indexer");
    expect(content.match(/intake and normalization layer/g)).toHaveLength(1);
  });

  it("folds the source when the same note arrives again word for word", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release readiness reviews moved from Tuesday to Wednesday _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`);

    await updateWorkContext(path, [
      {
        category: "process",
        info: "Release readiness reviews moved from Tuesday to Wednesday",
        source: "TEAM-1300",
      },
    ]);

    const content = await readFile(path, "utf-8");
    expect(content.match(/Release readiness reviews/g)).toHaveLength(1);
    // The note is not repeated, but the source it arrived with is folded into the one row.
    expect(content).toContain("_(TEAM-1200, TEAM-1300)_");
  });

  it("names the row a graduation probably meant without acting on the guess", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    // 0.83 similarity: close enough to name the row, nowhere near enough to delete it.
    const result = await updateMemory(path, [], [
      "Fallback path work for the Search Revamp indexer (now part of: shipped indexer resilience)",
    ]);

    expect(result.unmatchedGraduations).toHaveLength(1);
    expect(await readFile(path, "utf-8")).toContain("fallback path");
  });
});

// --- Review findings: sections, merging, CRLF, sentinels, clock ---

const ARCHIVED_IMPACT_LOG = `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|

**Last significant impact:** 2026-02-01
**Current gap:** 4 weeks

## Previous Team (2025) — ARCHIVED

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2025-05-01 | Old achievement | team | craft | TEAM-0001 |

**Last significant impact:** 2025-05-01
**Current gap:** closed with the team
`;

const IMPACT_ENTRY = {
  date: "2026-03-05",
  achievement: "Led the Search Revamp rollout across three teams",
  scope: "org",
  coreValue: "craft",
  evidence: "TEAM-1234",
};

describe("live section bounds", () => {
  it("writes the row and both status lines into the live section only", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, ARCHIVED_IMPACT_LOG);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "written" });

    const content = await readFile(path, "utf-8");
    expect(content.indexOf("Search Revamp rollout")).toBeLessThan(content.indexOf("ARCHIVED"));
    expect(content).toContain("**Last significant impact:** 2026-03-05");
    expect(content).toContain("**Last significant impact:** 2025-05-01");
    expect(content).toContain("**Current gap:** closed with the team");
    expect(content).toContain("| 2025-05-01 | Old achievement | team | craft | TEAM-0001 |");
  });

  it("refuses to write when the Impact Timeline section is missing", async () => {
    const path = join(tmpDir, "impact-log.md");
    const withoutTimeline = `# Impact Log

## Something Else

| Date | Note |
|------|------|
| 2026-01-01 | Not the timeline |
`;
    await writeFile(path, withoutTimeline);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(withoutTimeline);
  });

  it("leaves archived organizational notes alone", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_

## Previous Team (2025) — HISTORICAL

- **process:** Release trains ship on Tuesdays _(TEAM-0001)_

*Last updated: 2025-05-01*
`);

    await updateWorkContext(path, [
      { category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" },
    ], new Date("2026-03-08T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- **process:** Release trains ship on Tuesdays _(TEAM-0001)_");
    // The only date line sits under the archived heading, so it is not the live stamp.
    expect(content).toContain("*Last updated: 2025-05-01*");
    expect(content.indexOf("Support rota")).toBeLessThan(content.indexOf("HISTORICAL"));
  });
});

describe("merging new evidence into a record already there", () => {
  it("folds added evidence into the existing impact row", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    await updateImpactLog(path, IMPACT_ENTRY);
    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-1234, TEAM-1235" });

    const content = await readFile(path, "utf-8");
    expect(content.match(/Search Revamp rollout/g)).toHaveLength(1);
    expect(content).toContain("| TEAM-1234, TEAM-1235 |");
  });

  it("folds added notes into the existing memory row", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    await updateMemory(path, [
      "| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | follow-up in TEAM-1240 |",
    ], []);

    const content = await readFile(path, "utf-8");
    expect(content.match(/fallback path/g)).toHaveLength(1);
    expect(content).toContain("TEAM-1234; follow-up in TEAM-1240");
  });

  it("escapes a pipe in the evidence instead of adding a column", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-1234 | TEAM-1235" });

    const content = await readFile(path, "utf-8");
    const row = content.split("\n").find((line) => line.includes("Search Revamp rollout")) ?? "";
    expect(splitRow(row)).toHaveLength(5);
    expect(splitRow(row)[4]).toBe("TEAM-1234 | TEAM-1235");
  });
});

describe("CRLF files", () => {
  it("keeps the file's line endings and still finds the table", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY.split("\n").join("\r\n"));

    await updateMemory(path, ["| 2026-03-08 | Documented the on-call escalation path | support |  |"], []);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-03-08 | Documented the on-call escalation path | support |  |\r\n");
    expect(content.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
    // Landed in the table, not appended past the end of the file.
    expect(content.indexOf("escalation path")).toBeLessThan(content.length - 10);
  });
});

describe("sentinel-only placeholders", () => {
  it("keeps a parenthesised value that is not a known sentinel", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);

    await updateProfile(path, { achievement: "Stepped up", bulletPoint: "(Acting tech lead)" });

    expect(await readFile(path, "utf-8")).toContain("- (Acting tech lead)");
    expect(isPlaceholder("(Acting tech lead)")).toBe(false);
    expect(isPlaceholder("(None configured)")).toBe(true);
  });
});

describe("negated notes", () => {
  it("keeps a correction that reverses a note already there", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`);

    await updateWorkContext(path, [
      { category: "process", info: "Release trains do not ship on Tuesdays any more", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1200)_");
    expect(content).toContain("do not ship on Tuesdays any more");
  });
});

describe("work-context stamp", () => {
  it("moves the date only when a note was actually added", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);
    const updates = [{ category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" }];

    await updateWorkContext(path, updates, new Date("2026-03-08T00:00:00Z"));
    const first = await readFile(path, "utf-8");
    expect(first).toContain("*Last updated: 2026-03-08*");

    // A week later, same result applied again: nothing new to say, nothing to restamp.
    await updateWorkContext(path, updates, new Date("2026-03-15T00:00:00Z"));
    expect(await readFile(path, "utf-8")).toBe(first);
  });
});

describe("migration keeps records the scoring normalizer would flatten", () => {
  const strengthsFile = (bullets: string[]) => `# My Profile

## Key Strengths

${bullets.join("\n")}

---

*Last updated: 2026-02-01*
`;

  it("keeps two strengths that differ only in a symbol", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, strengthsFile(["- Builds C++ toolchains", "- Builds C# toolchains"]));

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- Builds C++ toolchains");
    expect(content).toContain("- Builds C# toolchains");
  });

  it("keeps two strengths that differ only in an accent", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, strengthsFile(["- Runs the cafe rota", "- Runs the café rota"]));

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toContain("café");
  });

  it("keeps notes written in a non-Latin script", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, strengthsFile(["- 検索基盤の設計をリード", "- オンコール体制を整備"]));

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();

    const content = await readFile(path, "utf-8");
    expect(content).toContain("検索基盤の設計をリード");
    expect(content).toContain("オンコール体制を整備");
  });

  it("still collapses a repeat that differs only in case and spacing", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, strengthsFile(["- Builds C++ toolchains", "-  builds c++   TOOLCHAINS"]));

    const result = await migrateVaultRecordsFile(path, "my-profile");
    expect(result?.duplicates).toBe(1);
  });
});

describe("migration backups", () => {
  it("never overwrites the backup holding the original file", async () => {
    const path = join(tmpDir, "my-profile.md");
    const original = `# My Profile

## Key Strengths

- (none)
- Untangles flaky test suites other people avoid
`;
    await writeFile(path, original);

    const first = await migrateVaultRecordsFile(path, "my-profile");
    expect(first?.backup).toBe(`${path}.pre-dedupe.bak`);

    // A placeholder arrives some weeks later and triggers a second cleanup.
    const cleaned = await readFile(path, "utf-8");
    await writeFile(path, `${cleaned}- (leave blank)\n`);

    const second = await migrateVaultRecordsFile(path, "my-profile");
    expect(second?.backup).toBe(`${path}.pre-dedupe.2.bak`);
    expect(await readFile(`${path}.pre-dedupe.bak`, "utf-8")).toBe(original);
    expect(await readFile(path, "utf-8")).not.toContain("(leave blank)");
  });
});

describe("migration placeholder selectors", () => {
  it("removes an impact row whose achievement is a placeholder", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | (none) | | | |
| 2026-03-06 | Led the Search Revamp rollout | org | craft | TEAM-1234 |

**Last significant impact:** 2026-03-06
**Current gap:** None - recent entry added
`);

    const result = await migrateVaultRecordsFile(path, "impact-log");
    expect(result?.placeholders).toBe(1);

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("(none)");
    expect(content).toContain("Led the Search Revamp rollout");
  });
});

describe("migration carries evidence out of the rows it drops", () => {
  it("keeps the evidence of a collapsed impact row", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-03-05 | Led the Search Revamp rollout | org | craft | TEAM-1235 |

**Last significant impact:** 2026-03-05
**Current gap:** None - recent entry added
`);

    const result = await migrateVaultRecordsFile(path, "impact-log");
    expect(result?.duplicates).toBe(1);

    const content = await readFile(path, "utf-8");
    expect(content.match(/Search Revamp rollout/g)).toHaveLength(1);
    expect(content).toContain("TEAM-1234, TEAM-1235");
    expect(content).toContain("| org | craft |");
  });

  it("keeps the notes of a collapsed memory row", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path for the indexer | project | TEAM-1234 |
| 2026-03-01 | Wrote the fallback path for the indexer | project | follow-up in TEAM-1240 |
`);

    const result = await migrateVaultRecordsFile(path, "memory");
    expect(result?.duplicates).toBe(1);

    const content = await readFile(path, "utf-8");
    expect(content.match(/fallback path/g)).toHaveLength(1);
    expect(content).toContain("TEAM-1234; follow-up in TEAM-1240");
  });
});

describe("migration and symlinked vault files", () => {
  it("writes through the link and keeps the file's mode", async () => {
    const target = join(tmpDir, "real-profile.md");
    const link = join(tmpDir, "my-profile.md");
    await writeFile(target, `# My Profile

## Key Strengths

- (none)
- Untangles flaky test suites other people avoid
`);
    await chmod(target, 0o640);
    await symlink(target, link);

    const result = await migrateVaultRecordsFile(link, "my-profile");
    expect(result?.placeholders).toBe(1);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf-8")).not.toContain("(none)");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });
});

describe("repeats inside one batch", () => {
  it("folds a memory item the model listed twice into one row", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    await updateMemory(path, [
      "| 2026-03-08 | Cut the search index rebuild from 40 to 12 minutes | project | TEAM-1234 |",
      "| 2026-03-08 | Cut the search index rebuild from 40 to 12 minutes | project | follow-up in TEAM-1240 |",
    ], []);

    const content = await readFile(path, "utf-8");
    expect(content.match(/search index rebuild/g)).toHaveLength(1);
    expect(content).toContain("TEAM-1234; follow-up in TEAM-1240");
  });

  it("folds the sources of a note the model reported twice", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);

    await updateWorkContext(path, [
      { category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" },
      { category: "team", info: "support rota   rotates FORTNIGHTLY", source: "TEAM-1401" },
    ], new Date("2026-03-08T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content.match(/rota\s+rotates\s+fortnightly/gi)).toHaveLength(1);
    expect(content).toContain("_(TEAM-1400, TEAM-1401)_");
  });
});

describe("impact heading is matched exactly", () => {
  it("does not treat a longer heading as the impact timeline", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline Notes

| Date | Note |
|------|------|
| 2026-01-01 | Not the timeline |
`;
    await writeFile(path, file);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("does not reach past the section into the next table", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline

Nothing recorded yet.

## Metrics

| Metric | Value |
|--------|-------|
| Reviews | 4 |
`;
    await writeFile(path, file);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("still matches a heading written with extra spacing", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG.replace("## Impact Timeline", "##  Impact  Timeline"));

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "written" });
    expect(await readFile(path, "utf-8")).toContain("Led the Search Revamp rollout");
  });
});

describe("contracted negations", () => {
  it("keeps a correction written with an apostrophe", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`);

    await updateWorkContext(path, [
      { category: "process", info: "Release trains don't ship on Tuesdays any more", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1200)_");
    expect(content).toContain("don't ship on Tuesdays any more");
  });
});

describe("records that differ only in a version or a language", () => {
  it("writes the second strength instead of treating it as a repeat", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, `# My Profile

## Key Strengths

- Builds C++ toolchains other teams depend on

---

*Last updated: 2026-02-01*
`);

    await updateProfile(path, {
      achievement: "Toolchain work",
      bulletPoint: "Builds C# toolchains other teams depend on",
    });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("- Builds C++ toolchains other teams depend on");
    expect(content).toContain("- Builds C# toolchains other teams depend on");
  });

  it("writes a note about a different version of the same thing", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **platform:** Services run on Go 1.22 in production _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`);

    await updateWorkContext(path, [
      { category: "platform", info: "Services run on Go 1.23 in production", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("Go 1.22 in production");
    expect(content).toContain("Go 1.23 in production");
  });
});

describe("the two ways an impact entry is not written", () => {
  it("reports a placeholder achievement without a warning-worthy result", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    expect(await updateImpactLog(path, { ...IMPACT_ENTRY, achievement: "(none)" })).toMatchObject({ status: "placeholder" });
    expect(await updateImpactLog(path, null)).toMatchObject({ status: "placeholder" });
    expect(await readFile(path, "utf-8")).toBe(CLEAN_IMPACT_LOG);
  });
});

describe("migration section bounds", () => {
  it("leaves a file whose only table belongs to another section byte-identical", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline Notes

| Date | Note | Note | Note | Note |
|------|------|------|------|------|
| 2026-03-05 | (none) | | | |
| 2026-03-05 | (none) | | | |
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "impact-log")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("leaves an archived era's rows out of the memory cleanup", async () => {
    const path = join(tmpDir, "memory.md");
    const file = `# Memory

## Previous Team (2025) — ARCHIVED

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2025-05-01 | Old item | Fix | |
| 2025-05-02 | Old item | Fix | |
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "memory")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("does not clean a Key Strengths section that is only named like one", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Key Strengths Archive

- (none)
- (none)
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });
});

describe("an ambiguous graduation removes nothing", () => {
  const TWO_MIGRATIONS = `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Ship Search Revamp backend migration | project | TEAM-1234 |
| 2026-03-02 | Ship Search Revamp frontend migration | project | TEAM-1235 |
`;

  it("leaves both rows when the removal names neither of them clearly", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, TWO_MIGRATIONS);

    await updateMemory(path, [], ["Ship Search Revamp migration (now part of: shipped the migration)"]);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("backend migration");
    expect(content).toContain("frontend migration");
  });

  it("removes the row when the removal names one of them", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, TWO_MIGRATIONS);

    await updateMemory(path, [], ["Ship Search Revamp backend migration (now part of: shipped the migration)"]);

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("backend migration");
    expect(content).toContain("frontend migration");
  });

  it("removes every date of the item a graduation names", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the Search Revamp rollout plan with the platform team | project |  |
| 2026-03-02 | Reviewed the Search Revamp rollout plan with the platform team | project |  |
`);

    const result = await updateMemory(path, [], [
      "Reviewed the Search Revamp rollout plan with the platform team (now part of: ran the rollout)",
    ]);

    expect(result.removed).toBe(2);
    expect(await readFile(path, "utf-8")).not.toContain("rollout plan");
  });
});

describe("evidence is merged as whole values", () => {
  it("does not let one ticket swallow another with the same prefix", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-123" });
    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-1234" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| TEAM-123, TEAM-1234 |");
  });

  it("does not repeat a value that is already listed", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-1234, TEAM-1235" });
    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-1235; TEAM-1234" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| TEAM-1234, TEAM-1235 |");
  });
});

describe("writers require the exact section heading", () => {
  it("does not file strengths under a section merely named like Key Strengths", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Key Strengths Archive

- Something from a previous role
`;
    await writeFile(path, file);

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("does not file notes under a section merely named like Organizational Notes", async () => {
    const path = join(tmpDir, "work-context.md");
    const file = `# Work Context

## Organizational Notes Archive

- **process:** Something from a previous era _(TEAM-0001)_
`;
    await writeFile(path, file);

    expect(await updateWorkContext(path, [
      { category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" },
    ], new Date("2026-03-08T00:00:00Z"))).toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("reports a write and a no-op distinctly", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "written" });
    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "unchanged" });
  });
});

describe("the archive boundary", () => {
  const ARCHIVED_ONLY_MEMORY = `# Memory

## Previous Team (2025) — ARCHIVED

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2025-05-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-0001 |
`;

  it("refuses to add a row when the only table is archived", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, ARCHIVED_ONLY_MEMORY);

    expect(await updateMemory(path, ["| 2026-03-08 | Cut the index rebuild time | project |  |"], []))
      .toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(ARCHIVED_ONLY_MEMORY);
  });

  it("refuses to graduate a row out of an archived table", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, ARCHIVED_ONLY_MEMORY);

    expect(await updateMemory(path, [], ["Fallback path work for the Search Revamp indexer (now part of: shipped it)"]))
      .toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(ARCHIVED_ONLY_MEMORY);
  });

  it("adds to the live table when there is one above the archive", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, TWO_ERA_MEMORY);

    expect(await updateMemory(path, ["| 2026-03-08 | New item | Fix | |"], [])).toMatchObject({ status: "written" });
    const content = await readFile(path, "utf-8");
    expect(content.indexOf("New item")).toBeLessThan(content.indexOf("HISTORICAL"));
  });

  it("reports an unchanged file when the model repeats itself", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);
    const rows = ["| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1234 |"];

    expect(await updateMemory(path, rows, [])).toMatchObject({ status: "unchanged" });
    expect(await readFile(path, "utf-8")).toBe(CLEAN_MEMORY);
  });
});

describe("impact status lines", () => {
  const WITH_SUMMARY = `# Impact Log

## Summary

**Last significant impact:** 2026-01-01
**Current gap:** a long time

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-20 | Led the platform migration | org | craft | TEAM-1100 |

**Last significant impact:** 2026-03-20
**Current gap:** None - recent entry added
`;

  it("rewrites the timeline's own lines, not a summary section above it", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, WITH_SUMMARY);

    await updateImpactLog(path, { ...IMPACT_ENTRY, date: "2026-03-25" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("**Last significant impact:** 2026-01-01");
    expect(content).toContain("**Current gap:** a long time");
    expect(content).toContain("**Last significant impact:** 2026-03-25");
  });

  it("does not rewind the latest date when an older week is regenerated", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, WITH_SUMMARY);

    // A rerun of an earlier week. The file already knows about a later impact, and
    // regenerating history must not move the file's idea of "latest" backwards.
    expect(await updateImpactLog(path, { ...IMPACT_ENTRY, date: "2026-03-05" })).toMatchObject({ status: "written" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-03-05 | Led the Search Revamp rollout across three teams |");
    expect(content).toContain("**Last significant impact:** 2026-03-20");
    expect(content).not.toContain("**Last significant impact:** 2026-03-05");
  });

  it("reports an unchanged file when the entry is already recorded", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "written" });
    const written = await readFile(path, "utf-8");
    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "unchanged" });
    expect(await readFile(path, "utf-8")).toBe(written);
  });
});

describe("heading level", () => {
  it("does not write a strength into a subsection named like the section", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Career

### Key Strengths

- Something filed under a subsection
`;
    await writeFile(path, file);

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("does not clean a subsection named like the section", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Career

### Key Strengths

- (none)
- (none)
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("accepts the heading with the leading spaces GFM allows", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE.replace("## Key Strengths", "  ## Key Strengths"));

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "written" });
  });
});

describe("text the word scan cannot read", () => {
  it("keeps a parenthesised non-Latin strength on insert and through migration", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);

    expect(isPlaceholder("(技術リード)")).toBe(false);
    expect(await updateProfile(path, { achievement: "Lead", bulletPoint: "(技術リード)" })).toMatchObject({ status: "written" });

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toContain("- (技術リード)");
  });

  it("still treats an empty parenthesis as a placeholder", () => {
    expect(isPlaceholder("()")).toBe(true);
    expect(isPlaceholder("(   )")).toBe(true);
  });
});

describe("a source arriving at a note that has none", () => {
  const NO_SOURCE = `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays

---

*Last updated: 2026-02-01*
`;

  it("appends the suffix instead of dropping the source", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, NO_SOURCE);

    expect(await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"))).toMatchObject({ status: "written" });

    expect(await readFile(path, "utf-8"))
      .toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1300)_");
  });

  it("keeps a dropped duplicate's source during migration", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays
- **process:** Release trains ship on Tuesdays _(TEAM-1300)_

---

*Last updated: 2026-02-01*
`);

    expect((await migrateVaultRecordsFile(path, "work-context"))?.duplicates).toBe(1);
    expect(await readFile(path, "utf-8"))
      .toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1300)_");
  });
});

describe("CRLF through the migration", () => {
  it("keeps the file's line endings on every line it rewrites", async () => {
    const path = join(tmpDir, "work-context.md");
    const file = `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_
- **process:** Release trains ship on Tuesdays _(TEAM-1201)_
- **process:** (none) _(unknown)_

---

*Last updated: 2026-02-01*
`;
    await writeFile(path, file.split("\n").join("\r\n"));

    const result = await migrateVaultRecordsFile(path, "work-context");
    expect(result).toMatchObject({ placeholders: 1, duplicates: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("_(TEAM-1200, TEAM-1201)_");
    expect(content.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });
});

describe("indented headings still bound a write", () => {
  it("treats an indented archive heading as the archive", async () => {
    const path = join(tmpDir, "memory.md");
    const file = `# Memory

  ## Previous Team (2025) — ARCHIVED

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2025-05-01 | Old item | Fix | |
`;
    await writeFile(path, file);

    expect(await updateMemory(path, ["| 2026-03-08 | New item | project |  |"], []))
      .toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("lets an indented heading end the impact timeline section", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline

Nothing recorded yet.

  ## Metrics

| Metric | Value |
|--------|-------|
| Reviews | 4 |
`;
    await writeFile(path, file);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("does not let a subsection end the section it sits in", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

### Current era

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`);

    await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    // The bullet under the subsection is still part of this section, so the source
    // folds into it rather than a second copy being written above.
    const content = await readFile(path, "utf-8");
    expect(content.match(/ship on Tuesdays/g)).toHaveLength(1);
    expect(content).toContain("_(TEAM-1200, TEAM-1300)_");
  });
});

describe("sentinels are whole phrases", () => {
  it("keeps text that merely starts with a sentinel's letters", () => {
    for (const text of [
      "(Nonetheless shipped the migration)",
      "(Nothingham office visit write-up)",
      "(None of the work landed, but the design did)",
      "(Tbdale platform review)",
    ]) {
      expect(isPlaceholder(text), text).toBe(false);
    }
  });

  it("still rejects the sentinels themselves", () => {
    for (const text of ["(none)", "(n/a)", "(tbd)", "(leave blank if none)", "(None configured)"]) {
      expect(isPlaceholder(text), text).toBe(true);
    }
  });

  it("keeps such a strength through the migration", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Key Strengths

- (Nonetheless shipped the migration)
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });
});

describe("what a batch did", () => {
  it("counts a repeat and a new record separately", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    const result = await updateMemory(path, [
      "| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1234, TEAM-1240 |",
      "| 2026-03-08 | Cut the search index rebuild from 40 to 12 minutes | project | TEAM-1250 |",
      "| 2026-03-08 | (none) | project |  |",
    ], []);

    expect(result).toEqual({ status: "written", added: 1, removed: 0, merged: 1, skipped: 1, unmatchedGraduations: [] });
  });

  it("counts the rows a graduation took out", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    const result = await updateMemory(path, [], [
      "Wrote the fallback path for the Search Revamp indexer (now part of: shipped indexer resilience)",
    ]);

    expect(result).toMatchObject({ status: "written", added: 0, removed: 1 });
  });

  it("counts a mixed batch of notes", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);

    const result = await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1300" },
      { category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" },
      { category: "team", info: "(none)", source: "unknown" },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(result).toEqual({ status: "written", added: 1, removed: 0, merged: 1, skipped: 1 });
  });

  it("reports nothing added when every record was already there", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);

    expect(await updateProfile(path, {
      achievement: "Test suite cleanup",
      bulletPoint: "Untangles flaky test suites other people avoid",
    })).toEqual({ status: "unchanged", added: 0, removed: 0, merged: 0, skipped: 1 });
  });
});

describe("markdown escapes survive a merge", () => {
  const CELLS: Array<[string, string]> = [
    ["an escaped asterisk", "\\*literal\\*"],
    ["an escaped underscore", "\\_literal\\_"],
    ["an escaped bracket", "\\[literal\\]"],
    ["a Windows path", "C:\\\\Users\\\\example\\\\notes"],
    ["an escaped pipe", "before \\| after"],
  ];

  for (const [label, cell] of CELLS) {
    it(`leaves ${label} in another cell byte-identical`, async () => {
      const path = join(tmpDir, "memory.md");
      const row = `| 2026-03-01 | Wrote the fallback path | ${cell} | TEAM-1234 |`;
      await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
${row}
`);

      // Same record, more evidence: the Notes cell changes and nothing else may.
      const result = await updateMemory(path, [
        `| 2026-03-01 | Wrote the fallback path | ${cell} | TEAM-1240 |`,
      ], []);
      expect(result.merged).toBe(1);

      const written = (await readFile(path, "utf-8")).split("\n").find((line) => line.includes("fallback path")) ?? "";
      expect(written).toBe(row.replace("| TEAM-1234 |", "| TEAM-1234; TEAM-1240 |"));
    });
  }

  it("keeps them through a migration that collapses a duplicate", async () => {
    const path = join(tmpDir, "memory.md");
    const survivor = "| 2026-03-01 | Wrote the fallback path | \\*literal\\* | TEAM-1234 |";
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
${survivor}
| 2026-03-01 | Wrote the fallback path | \\*literal\\* | TEAM-1240 |
`);

    expect((await migrateVaultRecordsFile(path, "memory"))?.duplicates).toBe(1);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| \\*literal\\* | TEAM-1234; TEAM-1240 |");
    expect(content).not.toContain("\\\\*literal");
  });
});

describe("comments the user wrote", () => {
  it("keeps a note to self and drops only the generated hint", async () => {
    expect(isPlaceholder("<!-- Revisit promotion evidence after Q4 -->")).toBe(false);
    expect(isPlaceholder("<!-- TODO: add your technical skills (e.g. TypeScript, React, Node.js) -->")).toBe(true);
  });

  it("leaves a user comment alone through insert and migration", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Key Strengths

- <!-- Revisit promotion evidence after Q4 -->
- Untangles flaky test suites other people avoid
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });
});

describe("closing-hash headings", () => {
  it("matches all three section headings written with a closing run", async () => {
    const profile = join(tmpDir, "my-profile.md");
    await writeFile(profile, CLEAN_PROFILE.replace("## Key Strengths", "## Key Strengths ##"));
    expect(await updateProfile(profile, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "written" });

    const workContext = join(tmpDir, "work-context.md");
    await writeFile(workContext, CLEAN_WORK_CONTEXT.replace("## Organizational Notes", "## Organizational Notes ##"));
    expect(await updateWorkContext(workContext, [
      { category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" },
    ], new Date("2026-03-08T00:00:00Z"))).toMatchObject({ status: "written" });

    const impact = join(tmpDir, "impact-log.md");
    await writeFile(impact, CLEAN_IMPACT_LOG.replace("## Impact Timeline", "## Impact Timeline ###"));
    expect(await updateImpactLog(impact, IMPACT_ENTRY)).toMatchObject({ status: "written" });
  });

  it("does not mistake a hash inside the heading text for a closing run", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = CLEAN_PROFILE.replace("## Key Strengths", "## Key Strengths #1");
    await writeFile(path, file);

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "no-section" });
  });
});

describe("a table this code does not own", () => {
  const WITH_SETTINGS_TABLE = `# Memory

| Setting | Value |
|---------|-------|
| Retention | none |
| Retention | none |

## Current Team (2026 - present)

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1234 |
`;

  it("adds the row to the memory table, not the first table in the file", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, WITH_SETTINGS_TABLE);

    expect(await updateMemory(path, ["| 2026-03-08 | Cut the index rebuild time | project |  |"], []))
      .toMatchObject({ status: "written", added: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| Retention | none |\n| Retention | none |");
    expect(content.indexOf("Cut the index rebuild time")).toBeGreaterThan(content.indexOf("Current Team"));
  });

  it("leaves that table alone during the cleanup", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `${WITH_SETTINGS_TABLE}| 2026-03-01 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1240 |\n`);

    expect((await migrateVaultRecordsFile(path, "memory"))?.duplicates).toBe(1);

    const content = await readFile(path, "utf-8");
    // The settings table keeps both its rows and its "none" value.
    expect(content.match(/\| Retention \| none \|/g)).toHaveLength(2);
    expect(content.match(/fallback path/g)).toHaveLength(1);
    expect(content).toContain("TEAM-1234; TEAM-1240");
  });

  it("refuses to write when the memory table is not there at all", async () => {
    const path = join(tmpDir, "memory.md");
    const file = `# Memory

| Setting | Value |
|---------|-------|
| Retention | none |
`;
    await writeFile(path, file);

    expect(await updateMemory(path, ["| 2026-03-08 | New item | project |  |"], []))
      .toMatchObject({ status: "no-section" });
    expect(await migrateVaultRecordsFile(path, "memory")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("refuses when the impact table has a header this code does not know", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline

| When | What | Who |
|------|------|-----|
| 2026-03-01 | Something | someone |
`;
    await writeFile(path, file);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });
});

describe("merging into a cell that already carries escapes", () => {
  it("appends to an escaped Notes cell without escaping it again", async () => {
    const path = join(tmpDir, "memory.md");
    const row = "| 2026-03-01 | Wrote the fallback path | project | \\*literal\\* |";
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
${row}
`);

    const result = await updateMemory(path, [
      "| 2026-03-01 | Wrote the fallback path | project | TEAM-1240 |",
    ], []);
    expect(result.merged).toBe(1);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| \\*literal\\*; TEAM-1240 |");
    expect(content).not.toContain("\\\\*literal");
  });

  it("appends to an escaped Evidence cell without escaping it again", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Led the Search Revamp rollout across three teams | org | craft | \\*literal\\* |

**Last significant impact:** 2026-03-05
**Current gap:** None - recent entry added
`);

    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-1240" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| \\*literal\\*, TEAM-1240 |");
    expect(content).not.toContain("\\\\*literal");
  });

  it("reads a merged escaped cell back as the value it started as", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path | project | C:\\\\Users\\\\example |
`);

    await updateMemory(path, ["| 2026-03-01 | Wrote the fallback path | project | TEAM-1240 |"], []);

    const row = (await readFile(path, "utf-8")).split("\n").find((line) => line.includes("fallback path")) ?? "";
    expect(splitRow(row)[3]).toBe("C:\\Users\\example; TEAM-1240");
  });

  it("does not grow the escapes when the same week is applied twice", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path | project | \\*literal\\* |
`);

    const rows = ["| 2026-03-01 | Wrote the fallback path | project | TEAM-1240 |"];
    await updateMemory(path, rows, []);
    const first = await readFile(path, "utf-8");
    await updateMemory(path, rows, []);

    expect(await readFile(path, "utf-8")).toBe(first);
  });
});

describe("notes whose bold is not a category label", () => {
  const OPPOSITE_NOTES = `# Work Context

## Organizational Notes

- **Deploy manually** for legacy tenants _(DOC-1)_
- **Never deploy manually** for legacy tenants _(DOC-2)_

---

*Last updated: 2026-02-01*
`;

  it("keeps two notes that differ only inside the bold span", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, OPPOSITE_NOTES);

    expect(await migrateVaultRecordsFile(path, "work-context")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(OPPOSITE_NOTES);
  });

  it("does not fold a generated note into a bullet the user wrote", async () => {
    const path = join(tmpDir, "work-context.md");
    const file = `# Work Context

## Organizational Notes

- **Deploy manually** for legacy tenants _(DOC-1)_

---

*Last updated: 2026-02-01*
`;
    await writeFile(path, file);

    // Same words as the freeform bullet's tail, arriving in the generated shape.
    const result = await updateWorkContext(path, [
      { category: "process", info: "for legacy tenants", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(result).toMatchObject({ status: "written", added: 1 });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("- **Deploy manually** for legacy tenants _(DOC-1)_");
    expect(content).toContain("- **process:** for legacy tenants _(TEAM-1300)_");
  });

  it("still folds a source into a note it did write", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);

    await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(await readFile(path, "utf-8")).toContain("_(TEAM-1200, TEAM-1300)_");
  });

  it("collapses two freeform bullets that say exactly the same thing", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **Deploy manually** for legacy tenants _(DOC-1)_
- **Deploy manually** for legacy tenants _(DOC-1)_

---

*Last updated: 2026-02-01*
`);

    expect((await migrateVaultRecordsFile(path, "work-context"))?.duplicates).toBe(1);
    expect((await readFile(path, "utf-8")).match(/Deploy manually/g)).toHaveLength(1);
  });

  it("keeps two freeform bullets that differ only in their trailing aside", async () => {
    const path = join(tmpDir, "work-context.md");
    const file = `# Work Context

## Organizational Notes

- Deploy on Fridays _(except holidays)_
- Deploy on Fridays _(including holidays)_

---

*Last updated: 2026-02-01*
`;
    await writeFile(path, file);

    // The aside is part of what a freeform bullet says, not evidence for it.
    expect(await migrateVaultRecordsFile(path, "work-context")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });
});

describe("a TODO the user wrote themselves", () => {
  it("is content, and only the generated hint is not", () => {
    expect(isPlaceholder("<!-- TODO: verify Q4 promotion evidence -->")).toBe(false);
    expect(isPlaceholder("<!-- TODO: add your technical skills (e.g. TypeScript, React, Node.js) -->")).toBe(true);
    expect(isPlaceholder("<!-- TODO: update your team domain -->")).toBe(true);
  });

  it("survives insert and migration under Key Strengths", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Key Strengths

- <!-- TODO: verify Q4 promotion evidence -->
- Untangles flaky test suites other people avoid
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);

    expect(await updateProfile(path, { achievement: "Note", bulletPoint: "<!-- TODO: verify Q4 promotion evidence -->" }))
      .toMatchObject({ status: "unchanged" });
  });
});

describe("bullets that continue on the next line", () => {
  const CONTINUED = `# My Profile

## Key Strengths

- Leads release reviews
  for the search platform
- Leads release reviews
  for the billing platform

---

*Last updated: 2026-02-01*
`;

  it("keeps two bullets that begin alike and continue differently", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CONTINUED);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(CONTINUED);
  });

  it("collapses a two-line bullet that repeats in full", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, `# My Profile

## Key Strengths

- Leads release reviews
  for the search platform
- Leads release reviews
  for the search platform

---

*Last updated: 2026-02-01*
`);

    expect((await migrateVaultRecordsFile(path, "my-profile"))?.duplicates).toBe(1);

    const content = await readFile(path, "utf-8");
    expect(content.match(/Leads release reviews/g)).toHaveLength(1);
    // The whole item goes, not just its marker line.
    expect(content.match(/for the search platform/g)).toHaveLength(1);
  });

  it("reads a continued note as one record", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays
  unless the release captain is away _(TEAM-1200)_

---

*Last updated: 2026-02-01*
`);

    // The same note in full, so its source folds in rather than a second copy landing.
    const result = await updateWorkContext(path, [
      {
        category: "process",
        info: "Release trains ship on Tuesdays unless the release captain is away",
        source: "TEAM-1300",
      },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(result).toMatchObject({ status: "written", added: 0, merged: 1 });
    expect(await readFile(path, "utf-8")).toContain("_(TEAM-1200, TEAM-1300)_");
  });

  it("refuses the section when an indented line belongs to nothing", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

## Key Strengths

  a stray indented line

- Untangles flaky test suites other people avoid
`;
    await writeFile(path, file);

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "no-section" });
    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });
});

describe("YAML frontmatter is not structure", () => {
  it("ignores a heading and a table inside the frontmatter block", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `---
title: Memory
aliases:
  - "## Previous Team — ARCHIVED"
notes: |
  | Date | Item | Category | Notes |
  |------|------|----------|-------|
---

# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path | project | TEAM-1234 |
`);

    // Neither the archived-looking alias nor the table in the block may be read as
    // structure: the row belongs in the real table below them.
    expect(await updateMemory(path, ["| 2026-03-08 | Cut the index rebuild time | project |  |"], []))
      .toMatchObject({ status: "written", added: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).toContain('  - "## Previous Team — ARCHIVED"');
    expect(content.indexOf("Cut the index rebuild time")).toBeGreaterThan(content.indexOf("# Memory"));
  });

  it("does not treat a section heading inside frontmatter as the section", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, `---
aliases:
- "## Key Strengths"
---

# My Profile

## Key Strengths

- Untangles flaky test suites other people avoid
`);

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "written" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain('- "## Key Strengths"');
    expect(content.indexOf("Runs multi-team rollouts")).toBeGreaterThan(content.indexOf("# My Profile"));
  });
});

describe("the same small work done again", () => {
  const RECURRING = `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the incident runbook | support |  |
| 2026-03-08 | Reviewed the incident runbook | support |  |
`;

  it("keeps each date of a recurring item through the cleanup", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, RECURRING);

    expect(await migrateVaultRecordsFile(path, "memory")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(RECURRING);
  });

  it("writes this week's instance of an item recorded before", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, RECURRING);

    const result = await updateMemory(path, ["| 2026-03-15 | Reviewed the incident runbook | support |  |"], []);

    expect(result).toMatchObject({ status: "written", added: 1 });
    expect((await readFile(path, "utf-8")).match(/Reviewed the incident runbook/g)).toHaveLength(3);
  });

  it("still refuses the same instance twice", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, RECURRING);

    const result = await updateMemory(path, ["| 2026-03-08 | Reviewed the incident runbook | support |  |"], []);

    expect(result).toMatchObject({ status: "unchanged", added: 0 });
    expect(await readFile(path, "utf-8")).toBe(RECURRING);
  });

  it("graduates every date of it at once", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, RECURRING);

    const result = await updateMemory(path, [], ["Reviewed the incident runbook (now part of: on-call overhaul)"]);

    expect(result.removed).toBe(2);
    expect(await readFile(path, "utf-8")).not.toContain("incident runbook");
  });
});

describe("bullets continued without indentation", () => {
  const LAZY = `# My Profile

## Key Strengths

- Leads release reviews
across search
- Leads release reviews
across billing

---

*Last updated: 2026-02-01*
`;

  it("keeps two bullets whose difference is on the unindented next line", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, LAZY);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(LAZY);
  });

  it("treats the lazy continuation as part of the record", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, LAZY);

    // The whole item, written as one line: already there.
    expect(await updateProfile(path, { achievement: "Reviews", bulletPoint: "Leads release reviews across search" }))
      .toMatchObject({ status: "unchanged" });
    // The marker line alone is a different record.
    expect(await updateProfile(path, { achievement: "Reviews", bulletPoint: "Leads release reviews" }))
      .toMatchObject({ status: "written" });
  });

  it("does not absorb a paragraph separated by a blank line", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_

Everything below here is prose, not part of the note above.

---

*Last updated: 2026-02-01*
`);

    // Were the paragraph absorbed, the note's identity would include it and this
    // would be written as a new bullet instead of folding its source in.
    const result = await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(result).toMatchObject({ status: "written", added: 0, merged: 1 });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("_(TEAM-1200, TEAM-1300)_");
    expect(content).toContain("Everything below here is prose");
  });

  it("stops a bullet at a table row or a heading", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_
| Date | Note |
|------|------|

### Previous era

- **process:** Release trains ship on Tuesdays _(TEAM-1201)_

---

*Last updated: 2026-02-01*
`);

    // Both notes are the same record, so the cleanup collapses them; that only works
    // if neither swallowed the table or the subsection heading.
    expect((await migrateVaultRecordsFile(path, "work-context"))?.duplicates).toBe(1);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| Date | Note |");
    expect(content).toContain("### Previous era");
    expect(content).toContain("_(TEAM-1200, TEAM-1201)_");
  });
});

describe("fenced code is not structure", () => {
  const FENCED_PROFILE = `# My Profile

## Notes on this file

\`\`\`md
## Key Strengths

- (none)
\`\`\`

## Key Strengths

- Untangles flaky test suites other people avoid

---

*Last updated: 2026-02-01*
`;

  it("writes to the real section, not the one in the example", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, FENCED_PROFILE);

    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "written" });

    const content = await readFile(path, "utf-8");
    const fenceStart = content.indexOf("```md");
    const fenceEnd = content.indexOf("```", fenceStart + 5);
    const written = content.indexOf("- Runs multi-team rollouts");
    expect(written).toBeGreaterThan(fenceEnd);
  });

  it("leaves a fenced placeholder bullet alone", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, FENCED_PROFILE);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(FENCED_PROFILE);
  });

  it("ignores an example table inside a fence", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

\`\`\`
| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-01-01 | An example row | example |  |
\`\`\`

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path | project | TEAM-1234 |
`);

    expect(await updateMemory(path, ["| 2026-03-08 | Cut the index rebuild time | project |  |"], []))
      .toMatchObject({ status: "written", added: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-01-01 | An example row | example |  |");
    expect(content.indexOf("Cut the index rebuild time")).toBeGreaterThan(content.indexOf("An example row"));
  });

  it("ignores an archived-looking heading inside a fence", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

\`\`\`md
## Previous Team — ARCHIVED
\`\`\`

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Wrote the fallback path | project | TEAM-1234 |
`);

    // The fenced heading would otherwise end the live region above the real table.
    expect(await updateMemory(path, ["| 2026-03-08 | Cut the index rebuild time | project |  |"], []))
      .toMatchObject({ status: "written", added: 1 });
  });

  it("treats an unclosed fence as running to the end of the file", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

\`\`\`md
## Key Strengths

- (none)
- (none)
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "no-section" });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("recognises a tilde fence", async () => {
    const path = join(tmpDir, "my-profile.md");
    const file = `# My Profile

~~~md
## Key Strengths

- (none)
~~~

## Key Strengths

- Untangles flaky test suites other people avoid
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });
});

describe("thematic breaks", () => {
  const breakBefore = (rule: string) => `# My Profile

## Key Strengths

- Untangles flaky test suites other people avoid

${rule}

- A bullet below the break
`;

  for (const rule of ["* * *", "_ _ _", "- - -", "***", "___"]) {
    it(`ends the section at ${rule}`, async () => {
      const path = join(tmpDir, "my-profile.md");
      await writeFile(path, breakBefore(rule));

      expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
        .toMatchObject({ status: "written" });

      const content = await readFile(path, "utf-8");
      expect(content.indexOf("Runs multi-team rollouts")).toBeLessThan(content.indexOf(rule));
      expect(content).toContain("- A bullet below the break");
    });
  }

  it("does not read an indented rule as a break", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, `# My Profile

## Key Strengths

- Untangles flaky test suites other people avoid
    ---
`);

    // Four spaces makes it a code line, so it is a continuation of the bullet above.
    expect(await updateProfile(path, {
      achievement: "Cleanup",
      bulletPoint: "Untangles flaky test suites other people avoid",
    })).toMatchObject({ status: "written" });
  });
});

describe("identity is every cell but the mergeable one", () => {
  const CATEGORISED = `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the incident runbook | support | TEAM-100 |
`;

  it("writes a row that files the same work under another category", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CATEGORISED);

    const result = await updateMemory(path, [
      "| 2026-03-01 | Reviewed the incident runbook | reliability | TEAM-200 |",
    ], []);

    expect(result).toMatchObject({ status: "written", added: 1, merged: 0 });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("| support | TEAM-100 |");
    expect(content).toContain("| reliability | TEAM-200 |");
  });

  it("keeps both categories through the cleanup", async () => {
    const path = join(tmpDir, "memory.md");
    const file = `${CATEGORISED}| 2026-03-01 | Reviewed the incident runbook | reliability | TEAM-200 |\n`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "memory")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("still merges the Notes when every other cell agrees", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CATEGORISED);

    const result = await updateMemory(path, [
      "| 2026-03-01 | Reviewed the incident runbook | support | TEAM-200 |",
    ], []);

    expect(result).toMatchObject({ status: "written", added: 0, merged: 1 });
    expect(await readFile(path, "utf-8")).toContain("| support | TEAM-100; TEAM-200 |");
  });

  it("writes an impact entry that claims a different scope", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    await updateImpactLog(path, IMPACT_ENTRY);
    const result = await updateImpactLog(path, { ...IMPACT_ENTRY, scope: "team" });

    expect(result).toMatchObject({ status: "written", added: 1, merged: 0 });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("| org | craft | TEAM-1234 |");
    expect(content).toContain("| team | craft | TEAM-1234 |");
    // The old behaviour merged the scopes into one row reading "org, team".
    expect(content).not.toContain("org, team");
  });

  it("writes an impact entry that claims a different core value", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, CLEAN_IMPACT_LOG);

    await updateImpactLog(path, IMPACT_ENTRY);
    const result = await updateImpactLog(path, { ...IMPACT_ENTRY, coreValue: "candour" });

    expect(result).toMatchObject({ status: "written", added: 1 });
    expect(await readFile(path, "utf-8")).not.toContain("craft, candour");
  });

  it("keeps two impact rows that differ only in scope through the cleanup", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-03-05 | Led the Search Revamp rollout | team | craft | TEAM-1235 |

**Last significant impact:** 2026-03-05
**Current gap:** None - recent entry added
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "impact-log")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("writes a note filed under a different category", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);

    const result = await updateWorkContext(path, [
      { category: "policy", info: "Release trains ship on Tuesdays", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(result).toMatchObject({ status: "written", added: 1, merged: 0 });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1200)_");
    expect(content).toContain("- **policy:** Release trains ship on Tuesdays _(TEAM-1300)_");
  });

  it("keeps both categories of a note through the cleanup", async () => {
    const path = join(tmpDir, "work-context.md");
    const file = `# Work Context

## Organizational Notes

- **process:** Release trains ship on Tuesdays _(TEAM-1200)_
- **policy:** Release trains ship on Tuesdays _(TEAM-1300)_

---

*Last updated: 2026-02-01*
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "work-context")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("still merges the source when the category agrees", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, CLEAN_WORK_CONTEXT);

    const result = await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1300" },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(result).toMatchObject({ status: "written", added: 0, merged: 1 });
    expect(await readFile(path, "utf-8")).toContain("_(TEAM-1200, TEAM-1300)_");
  });
});

function makeSeedConfig(): WorklogConfig {
  return {
    version: 1,
    vault: "/tmp/test-vault",
    atlassian: { url: "https://example.atlassian.net", email: "user@example.com" },
    githubOrgs: ["example-org"],
    ai: { provider: "anthropic" },
    profile: {
      fullName: "Sam Rivers",
      displayName: "Sam Rivers",
      jobTitle: "Senior Software Engineer",
      level: "IC-5",
      company: "Example Corp",
      location: "Berlin, Germany",
      startDate: "2024-01-15",
      domain: "Builds the search platform",
      team: "Search",
      teamDomain: "Search Platform",
      ticketPrefixes: ["TEAM-"],
    },
    career: {
      framework: "IC levels",
      currentLevel: "IC-5",
      targetLevel: "IC-6",
      skills: ["TypeScript"],
      growthAreas: ["system design"],
      companyValues: ["craft"],
      reviewCycleDates: [{ type: "Mid-year", date: "2026-06-15" }],
      careerDocPaths: [],
    },
    coaching: { tone: "balanced", focusAreas: ["scope"] },
  };
}

describe("identity keeps its cell boundaries", () => {
  it("does not merge two memory rows that shift a word across a column", async () => {
    const path = join(tmpDir, "memory.md");
    const file = `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Foo | Bar Baz | TEAM-100 |
| 2026-03-01 | Foo Bar | Baz | TEAM-200 |
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "memory")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);

    const result = await updateMemory(path, ["| 2026-03-01 | Foo Bar | Baz | TEAM-300 |"], []);
    expect(result).toMatchObject({ added: 0, merged: 1 });
    expect(await readFile(path, "utf-8")).toContain("| 2026-03-01 | Foo Bar | Baz | TEAM-200; TEAM-300 |");
  });

  it("does not merge two impact rows that shift a word across a column", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Led the rollout | org wide | craft | TEAM-100 |
| 2026-03-05 | Led the rollout org | wide | craft | TEAM-200 |

**Last significant impact:** 2026-03-05
**Current gap:** None - recent entry added
`;
    await writeFile(path, file);

    expect(await migrateVaultRecordsFile(path, "impact-log")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("does not merge two notes that shift a word across the label", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, `# Work Context

## Organizational Notes

- **release process:** ships on Tuesdays _(TEAM-100)_

---

*Last updated: 2026-02-01*
`);

    // Same words, different split between the label and the note.
    const result = await updateWorkContext(path, [
      { category: "release", info: "process ships on Tuesdays", source: "TEAM-200" },
    ], new Date("2026-03-08T00:00:00Z"));

    expect(result).toMatchObject({ added: 1, merged: 0 });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("- **release process:** ships on Tuesdays _(TEAM-100)_");
    expect(content).toContain("- **release:** process ships on Tuesdays _(TEAM-200)_");
  });
});

describe("the files the generators seed", () => {
  const config = makeSeedConfig();

  it("takes the same work-context update twice without writing it twice", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, generateWorkContextDoc(config, new Date("2026-03-01T00:00:00Z")));

    const updates = [{ category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1200" }];
    const now = new Date("2026-03-08T00:00:00Z");

    const first = await updateWorkContext(path, updates, now);
    expect(first).toMatchObject({ status: "written", added: 1 });
    const afterFirst = await readFile(path, "utf-8");

    const second = await updateWorkContext(path, updates, now);
    expect(second).toMatchObject({ status: "unchanged", added: 0 });
    expect(await readFile(path, "utf-8")).toBe(afterFirst);

    expect(afterFirst).toContain("- **process:** Release trains ship on Tuesdays _(TEAM-1200)_");
    expect(afterFirst).toContain("_(Added automatically as new information is discovered)_");
  });

  it("takes the same profile update twice without writing it twice", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, generateProfileDoc(config, new Date("2026-03-01T00:00:00Z")));

    const update = { achievement: "Search Revamp rollout", bulletPoint: "Runs multi-team rollouts without a rollback" };

    const first = await updateProfile(path, update);
    expect(first).toMatchObject({ status: "written", added: 1 });
    const afterFirst = await readFile(path, "utf-8");

    const second = await updateProfile(path, update);
    expect(second).toMatchObject({ status: "unchanged", added: 0 });
    expect(await readFile(path, "utf-8")).toBe(afterFirst);

    expect(afterFirst).toContain("- Runs multi-team rollouts without a rollback");
    expect(afterFirst).toContain("_(Added automatically as significant achievements are recorded)_");
  });

  it("keeps the hint out of the note's identity across a second update", async () => {
    const path = join(tmpDir, "work-context.md");
    await writeFile(path, generateWorkContextDoc(config, new Date("2026-03-01T00:00:00Z")));
    const now = new Date("2026-03-08T00:00:00Z");

    await updateWorkContext(path, [
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1200" },
    ], now);
    // A different note next week, then the first one again: still one of each.
    await updateWorkContext(path, [
      { category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" },
      { category: "process", info: "Release trains ship on Tuesdays", source: "TEAM-1200" },
    ], now);

    const content = await readFile(path, "utf-8");
    expect(content.match(/ship on Tuesdays/g)).toHaveLength(1);
    expect(content.match(/rota rotates fortnightly/g)).toHaveLength(1);
  });

  it("cleans a seeded file without touching its hint", async () => {
    const path = join(tmpDir, "my-profile.md");
    const seeded = generateProfileDoc(config, new Date("2026-03-01T00:00:00Z"));
    await writeFile(path, seeded);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(seeded);
  });
});

describe("a heading the user has annotated", () => {
  it("writes to and cleans a Key Strengths section with a qualifier", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, `# My Profile

## Key Strengths (for coaching context)

- (none)
- (none)
- Untangles flaky test suites other people avoid

---

*Last updated: 2026-02-01*
`);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toMatchObject({ placeholders: 2, duplicates: 0 });
    expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }))
      .toMatchObject({ status: "written" });

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("(none)");
    expect(content).toContain("- Runs multi-team rollouts");
  });

  it("accepts a qualifier on the other two managed headings", async () => {
    const workContext = join(tmpDir, "work-context.md");
    await writeFile(workContext, CLEAN_WORK_CONTEXT.replace("## Organizational Notes", "## Organizational Notes (team era)"));
    expect(await updateWorkContext(workContext, [
      { category: "team", info: "Support rota rotates fortnightly", source: "TEAM-1400" },
    ], new Date("2026-03-08T00:00:00Z"))).toMatchObject({ status: "written" });

    const impact = join(tmpDir, "impact-log.md");
    await writeFile(impact, CLEAN_IMPACT_LOG.replace("## Impact Timeline", "## Impact Timeline (2026)"));
    expect(await updateImpactLog(impact, IMPACT_ENTRY)).toMatchObject({ status: "written" });
  });

  it("still refuses a heading that is a different section", async () => {
    for (const heading of ["## Key Strengths Archive", "## Key Strengths: old", "## Key Strengths (a) (b)"]) {
      const path = join(tmpDir, `profile-${heading.length}.md`);
      await writeFile(path, `# My Profile

${heading}

- Something else
`);
      expect(await updateProfile(path, { achievement: "Rollout", bulletPoint: "Runs multi-team rollouts" }), heading)
        .toMatchObject({ status: "no-section" });
    }
  });
});

describe("impact status lines after a cleanup", () => {
  it("points at the newest surviving row when the latest one was a placeholder", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-01 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-03-08 | (none) | | | |

**Last significant impact:** 2026-03-08
**Current gap:** None - recent entry added
`);

    expect(await migrateVaultRecordsFile(path, "impact-log", new Date("2026-03-29T00:00:00Z")))
      .toMatchObject({ placeholders: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("(none)");
    expect(content).toContain("**Last significant impact:** 2026-03-01");
    expect(content).toContain("**Current gap:** 4 weeks");
  });

  it("says so plainly when no dated row survives", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-08 | (none) | | | |

**Last significant impact:** 2026-03-08
**Current gap:** None - recent entry added
`);

    await migrateVaultRecordsFile(path, "impact-log", new Date("2026-03-29T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("(none)");
    // The date it used to name belonged to the row that was just deleted.
    expect(content).not.toContain("2026-03-08");
    expect(content).toContain("**Last significant impact:** none recorded");
    expect(content).toContain("**Current gap:** no significant impact recorded");
  });
});

describe("replaying a week already recorded", () => {
  it("leaves both status lines exactly as they were", async () => {
    const path = join(tmpDir, "impact-log.md");
    const file = `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Led the Search Revamp rollout across three teams | org | craft | TEAM-1234 |

**Last significant impact:** 2026-03-05
**Current gap:** 25 weeks
`;
    await writeFile(path, file);

    // A --force regeneration of a week the file already holds.
    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "unchanged", added: 0 });
    expect(await readFile(path, "utf-8")).toBe(file);
  });

  it("closes the gap when the entry is genuinely new", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-02-01 | An earlier impact | team | craft | TEAM-1000 |

**Last significant impact:** 2026-02-01
**Current gap:** 25 weeks
`);

    expect(await updateImpactLog(path, IMPACT_ENTRY)).toMatchObject({ status: "written", added: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("**Last significant impact:** 2026-03-05");
    expect(content).toContain("**Current gap:** None - recent entry added");
  });
});

describe("values that carry their own punctuation", () => {
  const evidenceRow = (evidence: string) => `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-03-05 | Led the Search Revamp rollout across three teams | org | craft | ${evidence} |

**Last significant impact:** 2026-03-05
**Current gap:** None - recent entry added
`;

  it("keeps a comma inside an incoming link destination", async () => {
    const path = join(tmpDir, "impact-log.md");
    const link = "[dashboard](https://example.com/explore?q=a,b)";
    await writeFile(path, evidenceRow("TEAM-1234"));

    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: link });

    const content = await readFile(path, "utf-8");
    expect(content).toContain(`TEAM-1234, ${link}`);
    expect(content).not.toContain("?q=a, b");
  });

  it("keeps a semicolon inside an incoming link destination", async () => {
    const path = join(tmpDir, "impact-log.md");
    const link = "[trace](https://example.com/t?ids=1;2)";
    await writeFile(path, evidenceRow("TEAM-1234"));

    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: link });

    const content = await readFile(path, "utf-8");
    expect(content).toContain(`TEAM-1234, ${link}`);
    expect(content).not.toContain("ids=1; 2");
  });

  it("keeps a stored link whole when something is appended after it", async () => {
    const path = join(tmpDir, "impact-log.md");
    const link = "[dashboard](https://example.com/explore?q=a,b)";
    await writeFile(path, evidenceRow(link));

    await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: "TEAM-1240" });

    const content = await readFile(path, "utf-8");
    expect(content).toContain(`${link}, TEAM-1240`);
  });

  it("does not re-add a link that is already listed", async () => {
    const path = join(tmpDir, "impact-log.md");
    const link = "[dashboard](https://example.com/explore?q=a,b)";
    await writeFile(path, evidenceRow(link));

    expect(await updateImpactLog(path, { ...IMPACT_ENTRY, evidence: link }))
      .toMatchObject({ status: "unchanged" });
  });

  it("keeps a prose note whole, commas and all", async () => {
    const path = join(tmpDir, "memory.md");
    const note = "Paired with the on-call engineer, then wrote it up; see the runbook";
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the incident runbook | support | ${note} |
`);

    await updateMemory(path, ["| 2026-03-01 | Reviewed the incident runbook | support | follow-up in TEAM-1240 |"], []);

    const content = await readFile(path, "utf-8");
    expect(content).toContain(`${note}; follow-up in TEAM-1240`);
  });

  it("does not re-add a note it already holds", async () => {
    const path = join(tmpDir, "memory.md");
    const note = "Paired with the on-call engineer, then wrote it up";
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the incident runbook | support | ${note} |
`);

    expect(await updateMemory(path, [`| 2026-03-01 | Reviewed the incident runbook | support | ${note} |`], []))
      .toMatchObject({ status: "unchanged" });
  });
});

describe("sentinels a real file turned out to hold", () => {
  it("treats none this week and none yet as placeholders", () => {
    for (const text of ["(none this week)", "none this week", "(none yet)", "None Yet"]) {
      expect(isPlaceholder(text), text).toBe(true);
    }
    expect(isPlaceholder("None this week, but the design landed")).toBe(false);
  });

  it("removes them from Key Strengths", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, `# My Profile

## Key Strengths

- (none this week)
- (none yet)
- Untangles flaky test suites other people avoid
`);

    expect(await migrateVaultRecordsFile(path, "my-profile")).toMatchObject({ placeholders: 2 });
    expect(await readFile(path, "utf-8")).not.toContain("none");
  });
});

describe("the gap line goes stale on its own", () => {
  it("is recomputed from the clock whenever the cleanup runs", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-08-03 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-08-10 | (none) | | | |

**Last significant impact:** 2026-08-03
**Current gap:** None - recent entry added
`);

    await migrateVaultRecordsFile(path, "impact-log", new Date("2026-08-26T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("**Last significant impact:** 2026-08-03");
    expect(content).toContain("**Current gap:** 3 weeks");
  });

  it("finds the status lines when they sit below a heading of their own", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-08-03 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-08-10 | (none) | | | |

## Status

**Last significant impact:** 2026-08-10
**Current gap:** None - recent entry added
`);

    await migrateVaultRecordsFile(path, "impact-log", new Date("2026-08-26T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("**Last significant impact:** 2026-08-03");
    expect(content).toContain("**Current gap:** 3 weeks");
  });

  it("does not touch a status line above the timeline", async () => {
    const path = join(tmpDir, "impact-log.md");
    await writeFile(path, `# Impact Log

## Summary

**Last significant impact:** 2026-01-01
**Current gap:** a long time

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|
| 2026-08-03 | Led the Search Revamp rollout | org | craft | TEAM-1234 |
| 2026-08-10 | (none) | | | |

**Last significant impact:** 2026-08-10
**Current gap:** None - recent entry added
`);

    await migrateVaultRecordsFile(path, "impact-log", new Date("2026-08-26T00:00:00Z"));

    const content = await readFile(path, "utf-8");
    expect(content).toContain("**Last significant impact:** 2026-01-01");
    expect(content).toContain("**Current gap:** a long time");
    expect(content).toContain("**Current gap:** 3 weeks");
  });
});
