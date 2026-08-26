import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  updateMemory, updateImpactLog, updateWorkContext, updateProfile,
  updateFocusTracking, migrateFocusTrackingFile,
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

    const result = await migrateFocusTrackingFile(path);
    expect(result).toEqual({ assigned: 3, collapsed: 1, lapsed: 1 });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-W01.1 | 2026-W01 | Ancient still open | lapsed |");
    expect(content).toContain("| 2026-W09.1 | 2026-W09 | Recent still open | pending |");
    expect(await readFile(`${path}.pre-ids.bak`, "utf-8")).toContain("| Week | Focus Item |");

    // second run is a no-op
    expect(await migrateFocusTrackingFile(path)).toBeNull();
  });
});
