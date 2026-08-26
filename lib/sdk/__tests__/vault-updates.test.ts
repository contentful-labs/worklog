import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  updateMemory, updateImpactLog, updateWorkContext, updateProfile,
  updateFocusTracking, migrateFocusTrackingFile, migrateVaultRecordsFile, isPlaceholder,
} from "../vault-updates";
import { appendToFirstTable } from "../markdown-table";

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

  it("treats a reworded suggestion as a restatement, not a new row", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `| ID | Week | Focus Item | Status | Reviews | Notes |
|------|------|------|------|------|------|
| 2026-W09.1 | 2026-W09 | Close the Search Revamp release correctness loop through TEAM-1234 | pending | 1 |  |
`);

    const result = await updateFocusTracking(path, {
      focusItems: ["Close the Search Revamp release correctness through TEAM-1234 and TEAM-1235"],
      focusUpdates: [], reviewedIds: [], weekLabel: "2026-W10",
    });

    const content = await readFile(path, "utf-8");
    expect(result.restated).toBe(1);
    expect(result.added).toBe(0);
    expect(content.match(/2026-W\d\d\.\d/g)).toHaveLength(1);
    expect(content).toContain("restated 2026-W10");
    expect(content).toContain("| pending | 0 |");
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
| 2026-W09 | Recent still open, reworded slightly | pending | |
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
      "<!-- TODO: add your technical skills -->",
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
  it("drops a reworded repeat of a row already in the current table", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    await updateMemory(path, [
      "| 2026-03-08 | Wrote a fallback path for the Search Revamp indexer | project | TEAM-1234 |",
      "| 2026-03-08 | Reviewed the alert noise backlog with the on-call rota | support |  |",
    ], []);

    const content = await readFile(path, "utf-8");
    expect(content.match(/fallback path/g)).toHaveLength(1);
    expect(content).toContain("alert noise backlog");
  });

  it("drops placeholder rows the model emits when it has nothing to add", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);
    await updateMemory(path, ["| 2026-03-08 | (none) | misc |  |"], []);
    expect(await readFile(path, "utf-8")).toBe(CLEAN_MEMORY);
  });

  it("graduates the row the coach paraphrased", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    await updateMemory(path, [], [
      "Fallback path work for the Search Revamp indexer (now part of: shipped indexer resilience)",
    ]);

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("fallback path");
    expect(content).toContain("| Date | Item | Category | Notes |");
  });

  it("graduates one row per removal, not every row that reads alike", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, `# Memory

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-01 | Reviewed the Search Revamp rollout plan with the platform team | project |  |
| 2026-03-02 | Reviewed the Search Revamp rollout plan with the platform team | project |  |
`);

    await updateMemory(path, [], ["Search Revamp rollout plan review with the platform team (now part of: ran the rollout)"]);

    const content = await readFile(path, "utf-8");
    expect(content.match(/rollout plan/g)).toHaveLength(1);
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
      { category: "process", info: "Release trains now ship on Tuesdays", source: "TEAM-1200" },
      { category: "team", info: "Design review happens on Thursday afternoons", source: "TEAM-1300" },
      { category: "team", info: "Design review happens Thursday afternoons", source: "TEAM-1301" },
    ]);

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("(none)");
    expect(content.match(/ship on Tuesdays/g)).toHaveLength(1);
    expect(content.match(/Design review happens/g)).toHaveLength(1);
    expect(content).toContain("_(TEAM-1300)_");
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

  it("rejects a reworded repeat of a strength already listed", async () => {
    const path = join(tmpDir, "my-profile.md");
    await writeFile(path, CLEAN_PROFILE);
    await updateProfile(path, {
      achievement: "Test suite cleanup",
      bulletPoint: "Untangles the flaky test suites that other people avoid",
    });
    expect(await readFile(path, "utf-8")).toBe(CLEAN_PROFILE);
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

    expect(await migrateVaultRecordsFile(path, "my-profile")).toEqual({ placeholders: 3, duplicates: 1 });

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

    expect(await migrateVaultRecordsFile(path, "work-context")).toEqual({ placeholders: 1, duplicates: 2 });

    const content = await readFile(path, "utf-8");
    expect(content.match(/ship on Tuesdays/g)).toHaveLength(1);
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
| 2026-03-02 | Wrote the fallback path for the Search Revamp indexer | project | TEAM-1234 |
| 2026-03-03 |  | project |  |

## Previous Team (2025) — HISTORICAL

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2025-05-01 | Old item | Fix | |
| 2025-05-02 | Old item | Fix | |
`);

    expect(await migrateVaultRecordsFile(path, "memory")).toEqual({ placeholders: 1, duplicates: 1 });

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

    expect(await migrateVaultRecordsFile(path, "impact-log")).toEqual({ placeholders: 0, duplicates: 1 });
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

    expect(await migrateVaultRecordsFile(path, "my-profile")).toEqual({ placeholders: 1, duplicates: 0 });
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

  it("still rejects the same fact written a different way", async () => {
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
        info: "Release readiness reviews now happen on Wednesday, moved from Tuesday",
        source: "TEAM-1300",
      },
    ]);

    const content = await readFile(path, "utf-8");
    expect(content.match(/Release readiness reviews/g)).toHaveLength(1);
    expect(content).not.toContain("TEAM-1300");
  });

  it("finds the row a graduation names even when the wording drifts below the prose threshold", async () => {
    const path = join(tmpDir, "memory.md");
    await writeFile(path, CLEAN_MEMORY);

    // 0.83 similarity: too low to reject an insert, high enough to identify a row the
    // model has explicitly asked to close.
    await updateMemory(path, [], ["Fallback path work for the Search Revamp indexer (now part of: shipped indexer resilience)"]);

    expect(await readFile(path, "utf-8")).not.toContain("fallback path");
  });
});
