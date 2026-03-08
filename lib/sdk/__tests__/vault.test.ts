import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildVaultPaths,
  readFileOrDefault,
  readMemory,
  readProfile,
  readWorkContext,
  readImpactLog,
  readCoachPersona,
  readFocusTracking,
  readFocusDoc,
  readArchivedFocusDocs,
  readCareerContext,
  getBragBooks,
  getMissingBragBookWeeks,
  discoverWeeklyNotes,
  readTeamTimeline,
  getTeamForDate,
  formatTeamTimelineForPrompt,
  type VaultPaths,
} from "../vault";
import type { WorklogConfig } from "../types";

let tmpDir: string;
let vaultDir: string;
let paths: VaultPaths;

const mockConfig: WorklogConfig = {
  version: 1,
  vault: "", // set in beforeEach
  atlassian: { url: "https://test.atlassian.net", email: "user@test.com" },
  githubOrgs: ["test-org"],
  ai: { provider: "openai" },
  profile: {
    fullName: "Test User",
    displayName: "Test",
    jobTitle: "Engineer",
    level: "IC5",
    company: "TestCo",
    location: "Remote",
    startDate: "2024-01-01",
    domain: "platform",
    team: "Core",
    teamDomain: "infra",
    ticketPrefixes: ["CORE"],
  },
  career: {
    framework: "test",
    currentLevel: "IC5",
    targetLevel: "IC6",
    companyValues: ["quality"],
    reviewCycleDates: [],
    skills: ["typescript"],
    growthAreas: ["leadership"],
    careerDocPaths: [],
  },
  coaching: { tone: "direct", focusAreas: ["impact"] },
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "worklog-test-"));
  vaultDir = join(tmpDir, "vault");
  await mkdir(vaultDir);
  mockConfig.vault = vaultDir;
  paths = buildVaultPaths(mockConfig, join(tmpDir, "team-timeline.json"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("buildVaultPaths", () => {
  it("computes all paths from config", () => {
    expect(paths.vault).toBe(vaultDir);
    expect(paths.memory).toBe(join(vaultDir, "memory.md"));
    expect(paths.profile).toBe(join(vaultDir, "my-profile.md"));
    expect(paths.workContext).toBe(join(vaultDir, "work-context.md"));
    expect(paths.focusDoc).toBe(join(vaultDir, "My Focus.md"));
  });

  it("includes career doc paths from config", () => {
    const cfg = { ...mockConfig, career: { ...mockConfig.career, careerDocPaths: ["/a.md", "/b.md"] } };
    const p = buildVaultPaths(cfg, "/tmp/timeline.json");
    expect(p.careerDocs).toEqual(["/a.md", "/b.md"]);
  });
});

describe("readFileOrDefault", () => {
  it("returns file content when file exists", async () => {
    await writeFile(join(vaultDir, "test.md"), "hello world");
    expect(await readFileOrDefault(join(vaultDir, "test.md"), "fallback")).toBe("hello world");
  });

  it("returns fallback when file is missing", async () => {
    expect(await readFileOrDefault(join(vaultDir, "nope.md"), "fallback")).toBe("fallback");
  });
});

describe("vault reader functions", () => {
  it("readMemory returns fallback when missing", async () => {
    expect(await readMemory(paths)).toBe("No memory items yet.");
  });

  it("readMemory returns content when present", async () => {
    await writeFile(paths.memory, "- shipped feature X");
    expect(await readMemory(paths)).toBe("- shipped feature X");
  });

  it("readProfile returns fallback when missing", async () => {
    expect(await readProfile(paths)).toBe("No profile available.");
  });

  it("readWorkContext returns fallback when missing", async () => {
    expect(await readWorkContext(paths)).toBe("No work context available.");
  });

  it("readImpactLog returns fallback when missing", async () => {
    expect(await readImpactLog(paths)).toBe("No impact log available.");
  });

  it("readCoachPersona returns fallback when missing", async () => {
    expect(await readCoachPersona(paths)).toBe("No coach persona defined.");
  });

  it("readFocusTracking returns fallback when missing", async () => {
    expect(await readFocusTracking(paths)).toBe("No focus items tracked yet.");
  });

  it("readFocusDoc returns fallback when missing", async () => {
    expect(await readFocusDoc(paths)).toBe("No focus doc available.");
  });
});

describe("readArchivedFocusDocs", () => {
  it("returns fallback when no archived docs", async () => {
    expect(await readArchivedFocusDocs(paths)).toBe("No previous focus docs.");
  });

  it("returns up to 2 most recent archived focus docs", async () => {
    await writeFile(join(vaultDir, "My Focus (2025-01-01).md"), "old focus");
    await writeFile(join(vaultDir, "My Focus (2025-06-01).md"), "mid focus");
    await writeFile(join(vaultDir, "My Focus (2026-01-01).md"), "new focus");

    const result = await readArchivedFocusDocs(paths);
    expect(result).toContain("2026-01-01");
    expect(result).toContain("2025-06-01");
    expect(result).not.toContain("2025-01-01"); // oldest excluded
  });
});

describe("readCareerContext", () => {
  it("returns fallback when no career doc paths", async () => {
    expect(await readCareerContext(paths)).toBe("No career context available.");
  });

  it("reads and concatenates career docs", async () => {
    const docPath = join(tmpDir, "career.md");
    await writeFile(docPath, "career doc content");
    const p = buildVaultPaths(
      { ...mockConfig, career: { ...mockConfig.career, careerDocPaths: [docPath] } },
      paths.teamTimeline,
    );
    expect(await readCareerContext(p)).toBe("career doc content");
  });
});

describe("getBragBooks", () => {
  beforeEach(async () => {
    await writeFile(join(vaultDir, "2026-W05 Brag Book.md"), "week 5 content");
    await writeFile(join(vaultDir, "2026-W06 Brag Book.md"), "week 6 content");
    await writeFile(join(vaultDir, "2026-W07 Brag Book.md"), "week 7 content");
    await writeFile(join(vaultDir, "2026-W08 Brag Book.md"), "week 8 content");
  });

  it("returns most recent N brag books", async () => {
    const result = await getBragBooks(paths, 2);
    expect(result).toContain("2026-W07");
    expect(result).toContain("2026-W08");
    expect(result).not.toContain("2026-W05");
  });

  it("returns all when count exceeds available", async () => {
    const result = await getBragBooks(paths, 10);
    expect(result).toContain("2026-W05");
    expect(result).toContain("2026-W08");
  });

  it("returns empty message when no brag books exist", async () => {
    const emptyVault = join(tmpDir, "empty");
    await mkdir(emptyVault);
    const emptyPaths = buildVaultPaths({ ...mockConfig, vault: emptyVault }, paths.teamTimeline);
    expect(await getBragBooks(emptyPaths, 5)).toBe("No brag book entries found.");
  });

  it("filters by beforeFilename and afterFilename", async () => {
    const result = await getBragBooks(paths, 10, "2026-W08 Brag Book.md", "2026-W06 Brag Book.md");
    expect(result).toContain("2026-W06");
    expect(result).toContain("2026-W07");
    expect(result).not.toContain("2026-W08"); // before is exclusive
    expect(result).not.toContain("2026-W05"); // before after
  });
});

describe("getMissingBragBookWeeks", () => {
  it("returns week IDs that don't have brag book files", async () => {
    await writeFile(join(vaultDir, "2026-W06 Brag Book.md"), "content");
    const missing = await getMissingBragBookWeeks(paths, ["2026-W05", "2026-W06", "2026-W07"]);
    expect(missing).toEqual(["2026-W05", "2026-W07"]);
  });

  it("returns all when vault is empty", async () => {
    const missing = await getMissingBragBookWeeks(paths, ["2026-W05", "2026-W06"]);
    expect(missing).toEqual(["2026-W05", "2026-W06"]);
  });
});

describe("readTeamTimeline", () => {
  it("reads and parses team timeline JSON", async () => {
    const timeline = {
      entries: [{ team: "Core", domain: "infra", start: "2025-01-01", end: null, ticketPrefixes: ["CORE"], notes: null }],
      transitionNotes: ["Joined Core team"],
    };
    await writeFile(paths.teamTimeline, JSON.stringify(timeline));
    const result = readTeamTimeline(paths);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].team).toBe("Core");
  });
});

describe("getTeamForDate", () => {
  it("returns the team entry matching the date", async () => {
    const timeline = {
      entries: [
        { team: "Alpha", domain: null, start: "2024-01-01", end: "2024-12-31", ticketPrefixes: [], notes: null },
        { team: "Beta", domain: "infra", start: "2025-01-01", end: null, ticketPrefixes: ["BETA"], notes: null },
      ],
      transitionNotes: [],
    };
    await writeFile(paths.teamTimeline, JSON.stringify(timeline));
    const tl = readTeamTimeline(paths);

    expect(getTeamForDate(tl, new Date("2024-06-15"))?.team).toBe("Alpha");
    expect(getTeamForDate(tl, new Date("2025-06-15"))?.team).toBe("Beta");
    expect(getTeamForDate(tl, new Date("2023-01-01"))).toBeUndefined();
  });
});

describe("formatTeamTimelineForPrompt", () => {
  it("formats timeline entries as text", async () => {
    const timeline = {
      entries: [
        { team: "Core", domain: "infra", start: "2025-01-01", end: null, ticketPrefixes: ["CORE"], notes: null },
      ],
      transitionNotes: ["Joined Core"],
    };
    await writeFile(paths.teamTimeline, JSON.stringify(timeline));
    const tl = readTeamTimeline(paths);
    const result = formatTeamTimelineForPrompt(tl);
    expect(result).toContain("Core");
    expect(result).toContain("infra");
    expect(result).toContain("CORE");
    expect(result).toContain("Joined Core");
  });
});

describe("discoverWeeklyNotes", () => {
  it("finds work-relevant notes within date range", async () => {
    // Create a file with a work keyword in its name
    await writeFile(join(vaultDir, "sprint-planning.md"), "# Sprint\nNotes here");
    // Create a non-relevant file
    await writeFile(join(vaultDir, "recipe.md"), "# Cookies\nYum");

    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await discoverWeeklyNotes(mockConfig, paths, start, end);

    const titles = result.map(r => r.title);
    expect(titles).toContain("sprint-planning");
    expect(titles).not.toContain("recipe");
  });

  it("excludes fixed and generated files", async () => {
    await writeFile(join(vaultDir, "memory.md"), "memory");
    await writeFile(join(vaultDir, "2026-W10 Brag Book.md"), "brag");

    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await discoverWeeklyNotes(mockConfig, paths, start, end);
    const titles = result.map(r => r.title);
    expect(titles).not.toContain("memory");
    expect(titles).not.toContain("2026-W10 Brag Book");
  });
});
