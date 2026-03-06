import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateMemory, updateImpactLog, updateWorkContext, updateProfile, updateFocusTracking } from "../vault-updates";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "vault-updates-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
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
  it("creates focus tracking file when missing", async () => {
    const path = join(tmpDir, "focus.md");
    await updateFocusTracking(path, ["Ship auth PR"], [], "2026-W10");
    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Focus Tracking");
    expect(content).toContain("| 2026-W10 | Ship auth PR | pending | |");
  });

  it("adds new focus items to existing file", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `# Focus Tracking

| Week | Focus Item | Status | Notes |
|------|------------|--------|-------|
| 2026-W09 | Old item | completed | Done |`);

    await updateFocusTracking(path, ["New focus item"], [], "2026-W10");

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-W10 | New focus item | pending | |");
    expect(content).toContain("Old item");
  });

  it("updates status of existing pending items", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `# Focus Tracking

| Week | Focus Item | Status | Notes |
|------|------------|--------|-------|
| 2026-W09 | Write docs | pending | |`);

    await updateFocusTracking(path, [], [
      { week: "2026-W09", item: "Write docs", status: "completed", notes: "Done" },
    ], "2026-W10");

    const content = await readFile(path, "utf-8");
    expect(content).toContain("| 2026-W09 | Write docs | completed | Done |");
    expect(content).not.toContain("pending");
  });

  it("skips duplicate focus items", async () => {
    const path = join(tmpDir, "focus.md");
    await writeFile(path, `| 2026-W10 | Ship auth PR | pending | |`);
    await updateFocusTracking(path, ["Ship auth PR"], [], "2026-W10");
    const content = await readFile(path, "utf-8");
    const matches = content.match(/Ship auth PR/g);
    expect(matches).toHaveLength(1);
  });
});
