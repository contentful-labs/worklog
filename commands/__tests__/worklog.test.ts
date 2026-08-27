import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The AI call is the edge of this test: the point is what runWorklog does with a bad
// answer, not how the answer was produced.
vi.mock("../../lib/sdk/ai", () => ({ aiQueryStructured: vi.fn() }));

// Same for the network. runWorklog's own control flow is what is under test.
vi.mock("../../lib/sdk/data-fetch", () => ({
  buildHeaders: () => ({ atlassian: {}, github: {} }),
  getAccountId: async () => "acct-1",
  getGitHubUsername: async () => "testuser",
  fetchDataForWeek: async () => ({ issues: [], pages: [], prs: [], reviews: [], teamSprintItems: [] }),
  // The sources read through these. An empty week is the right shape here: what is under
  // test is what runWorklog does with the model's answer.
  fetchJiraIssues: async () => [],
  searchConfluence: async () => [],
  fetchGitHubPRs: async () => [],
}));

// Only writeFileAtomic is stood in for, so the rest of the vault writers stay real.
vi.mock("../../lib/sdk/vault-updates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sdk/vault-updates")>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  confirm: vi.fn(),
  text: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), message: vi.fn() },
}));

const WEEK = "2026-W09";
// Frontmatter included because that is what a work log the writers produced looks
// like; without it the frontmatter migration would rewrite the fixture mid-test.
const EXISTING_WORK_LOG = "---\ntags:\n  - areas/work\n  - areas/work/work-log\n---\n\n# Work Log 2026-W09\n\nReal fetched activity from the original run.\n";
const EXISTING_BRAG_BOOK = "---\ntags:\n  - areas/work\n---\n\n# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Real work\n";

/** A structurally valid response whose document would fail validation. */
const BAD_OUTPUT = {
  bragBookMarkdown: "   \n  ",
  memoryItemsToAdd: [],
  memoryGraduations: [],
  impactLogEntry: null,
  workContextUpdates: [],
  profileUpdate: null,
  focusStatuses: [],
  newFocusItems: [],
};

function seedVault(vault: string) {
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, `${WEEK} Work Log.md`), EXISTING_WORK_LOG);
  writeFileSync(join(vault, `${WEEK} Brag Book.md`), EXISTING_BRAG_BOOK);
}

function writeConfig(configHome: string, vault: string, options: { withTimeline?: boolean } = {}) {
  mkdirSync(join(configHome, "worklog"), { recursive: true });
  writeFileSync(
    join(configHome, "worklog", "config.json"),
    JSON.stringify({
      version: 1,
      vault,
      atlassian: { url: "https://acme.atlassian.net", email: "user@example.com" },
      githubOrgs: ["acme"],
      ai: { provider: "openai" },
      profile: {
        fullName: "Test User", displayName: "Test", jobTitle: "Senior Engineer", level: "IC-5",
        company: "Acme", location: "Remote", startDate: "2024-01-01", domain: "Platform",
        team: "Search", teamDomain: "Search", ticketPrefixes: ["TEAM"],
      },
      career: {
        framework: "example", currentLevel: "IC-5", targetLevel: "IC-6",
        companyValues: ["Quality"], reviewCycleDates: [], skills: [], careerDocPaths: [],
      },
    }),
  );
  // Seeded so the run uses a real timeline; readTeamTimeline defaults without one.
  if (options.withTimeline === false) return;
  writeFileSync(
    join(configHome, "worklog", "team-timeline.json"),
    JSON.stringify({
      entries: [{ team: "Search", domain: "Search", start: "2024-01-01", end: null, ticketPrefixes: ["TEAM"], notes: null }],
      transitionNotes: [],
    }),
  );
}

// Jira's expanded search posts to the API directly rather than through the mocked
// module, so the network is closed off here too. An empty week is all this file needs:
// what is under test is what runWorklog does with the model's answer.
beforeEach(() => {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ issues: [] }), { status: 200, headers: { "content-type": "application/json" } }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  // The aiQueryStructured mock is shared across it.each rows, so its call count has to be
  // reset or the second row sees the first row's call.
  vi.clearAllMocks();
});

describe("runWorklog write ordering", () => {
  it.each([
    ["a blank document", "   \n  "],
    // A heading with nothing under it passed every earlier check and replaced the week.
    ["a bare heading", "# Brag Book - Week 09, 2026\n\n## Achievements"],
  ])("leaves the existing work log and brag book untouched when the model returns %s", async (_name, badMarkdown) => {
    const tmp = mkdtempSync(join(tmpdir(), "worklog-order-"));
    const configHome = join(tmp, "config");
    const vault = join(tmp, "vault");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    const previousAtlassian = process.env.ATLASSIAN_API_TOKEN;
    const previousGitHub = process.env.GITHUB_TOKEN;

    seedVault(vault);
    writeConfig(configHome, vault);
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_CACHE_HOME = join(tmp, "cache");
    process.env.ATLASSIAN_API_TOKEN = "test-atlassian-token";
    process.env.GITHUB_TOKEN = "test-github-token";

    // vitest runs on node. The stub writes for real, so a regression in ordering shows up
    // as a changed file rather than as a silently skipped write.
    vi.stubGlobal("Bun", {
      write: async (path: string, content: string) => writeFileSync(path, content),
      file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }),
    });

    try {
      // CONFIG_DIR is read at module load, so import everything under the temp config home.
      vi.resetModules();
      const { aiQueryStructured } = await import("../../lib/sdk/ai");
      vi.mocked(aiQueryStructured).mockResolvedValue({ ...BAD_OUTPUT, bragBookMarkdown: badMarkdown });

      const { runWorklog } = await import("../worklog");

      await expect(
        runWorklog({ week: WEEK, noPrompt: true, force: true, verbose: false }),
      ).rejects.toThrow(/Refusing to write the brag book/);

      expect(vi.mocked(aiQueryStructured)).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(vault, `${WEEK} Work Log.md`), "utf8")).toBe(EXISTING_WORK_LOG);
      expect(readFileSync(join(vault, `${WEEK} Brag Book.md`), "utf8")).toBe(EXISTING_BRAG_BOOK);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      if (previousAtlassian === undefined) delete process.env.ATLASSIAN_API_TOKEN;
      else process.env.ATLASSIAN_API_TOKEN = previousAtlassian;
      if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHub;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves both originals intact when the brag book write fails", async () => {
    let realWrite: ((path: string, content: string) => Promise<void>) | undefined;
    let restoreWrite = () => {};
    const tmp = mkdtempSync(join(tmpdir(), "worklog-order-fail-"));
    const configHome = join(tmp, "config");
    const vault = join(tmp, "vault");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    const previousAtlassian = process.env.ATLASSIAN_API_TOKEN;
    const previousGitHub = process.env.GITHUB_TOKEN;

    seedVault(vault);
    writeConfig(configHome, vault);
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_CACHE_HOME = join(tmp, "cache");
    process.env.ATLASSIAN_API_TOKEN = "test-atlassian-token";
    process.env.GITHUB_TOKEN = "test-github-token";

    vi.stubGlobal("Bun", {
      write: async (path: string, content: string) => writeFileSync(path, content),
      file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }),
    });

    try {
      vi.resetModules();
      const { aiQueryStructured } = await import("../../lib/sdk/ai");
      vi.mocked(aiQueryStructured).mockResolvedValue({
        ...BAD_OUTPUT,
        bragBookMarkdown: "# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Shipped the thing",
      });

      // The brag book is written first, so failing it must leave the work log alone too.
      // vi.clearAllMocks keeps implementations, so the real one is put back below.
      const { writeFileAtomic: mocked } = await import("../../lib/sdk/vault-updates");
      realWrite = vi.mocked(mocked).getMockImplementation();
      restoreWrite = () => {
        if (realWrite) vi.mocked(mocked).mockImplementation(realWrite);
      };
      vi.mocked(mocked).mockImplementation(async (path: string, content: string) => {
        if (path.endsWith("Brag Book.md")) throw new Error("simulated disk failure");
        // Every other write is real, so a work log written before the failure would show.
        if (realWrite) await realWrite(path, content);
      });

      const { runWorklog } = await import("../worklog");
      await expect(
        runWorklog({ week: WEEK, noPrompt: true, force: true, verbose: false }),
      ).rejects.toThrow(/simulated disk failure/);

      expect(readFileSync(join(vault, `${WEEK} Work Log.md`), "utf8")).toBe(EXISTING_WORK_LOG);
      expect(readFileSync(join(vault, `${WEEK} Brag Book.md`), "utf8")).toBe(EXISTING_BRAG_BOOK);
    } finally {
      restoreWrite();
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      if (previousAtlassian === undefined) delete process.env.ATLASSIAN_API_TOKEN;
      else process.env.ATLASSIAN_API_TOKEN = previousAtlassian;
      if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHub;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes both documents when the model returns a usable one", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "worklog-order-ok-"));
    const configHome = join(tmp, "config");
    const vault = join(tmp, "vault");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    const previousAtlassian = process.env.ATLASSIAN_API_TOKEN;
    const previousGitHub = process.env.GITHUB_TOKEN;

    seedVault(vault);
    writeConfig(configHome, vault);
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_CACHE_HOME = join(tmp, "cache");
    process.env.ATLASSIAN_API_TOKEN = "test-atlassian-token";
    process.env.GITHUB_TOKEN = "test-github-token";

    vi.stubGlobal("Bun", {
      write: async (path: string, content: string) => writeFileSync(path, content),
      file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }),
    });

    try {
      vi.resetModules();
      const { aiQueryStructured } = await import("../../lib/sdk/ai");
      vi.mocked(aiQueryStructured).mockResolvedValue({
        ...BAD_OUTPUT,
        bragBookMarkdown: "# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Shipped the thing",
      });

      const { runWorklog } = await import("../worklog");
      await runWorklog({ week: WEEK, noPrompt: true, force: true, verbose: false });

      expect(readFileSync(join(vault, `${WEEK} Brag Book.md`), "utf8")).toContain("Shipped the thing");
      // The regenerated work log replaced the seeded one, which is the whole point of --force
      // once the week is known to be good.
      expect(readFileSync(join(vault, `${WEEK} Work Log.md`), "utf8")).not.toBe(EXISTING_WORK_LOG);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      if (previousAtlassian === undefined) delete process.env.ATLASSIAN_API_TOKEN;
      else process.env.ATLASSIAN_API_TOKEN = previousAtlassian;
      if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHub;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("team attribution without a timeline file", () => {
  it("names the profile's team in the prompt rather than Unknown", async () => {
    // readTeamTimeline warns that every week will be attributed to the current team.
    // This is what makes that true: the prompt used to say "Unknown Team" instead.
    const tmp = mkdtempSync(join(tmpdir(), "worklog-noteam-"));
    const configHome = join(tmp, "config");
    const vault = join(tmp, "vault");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAtlassian = process.env.ATLASSIAN_API_TOKEN;
    const previousGitHub = process.env.GITHUB_TOKEN;

    seedVault(vault);
    writeConfig(configHome, vault, { withTimeline: false });
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.ATLASSIAN_API_TOKEN = "test-atlassian-token";
    process.env.GITHUB_TOKEN = "test-github-token";

    vi.stubGlobal("Bun", {
      write: async (path: string, content: string) => writeFileSync(path, content),
      file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }),
    });

    try {
      vi.resetModules();
      const { aiQueryStructured } = await import("../../lib/sdk/ai");
      vi.mocked(aiQueryStructured).mockResolvedValue({
        ...BAD_OUTPUT,
        bragBookMarkdown: "# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Shipped the thing",
      });

      const { runWorklog } = await import("../worklog");
      await runWorklog({ week: WEEK, noPrompt: true, force: true, verbose: false });

      const [call] = vi.mocked(aiQueryStructured).mock.calls;
      const prompt = call[0].prompt;

      expect(prompt).toContain("Search");
      expect(prompt).not.toContain("Unknown");
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousAtlassian === undefined) delete process.env.ATLASSIAN_API_TOKEN;
      else process.env.ATLASSIAN_API_TOKEN = previousAtlassian;
      if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHub;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("amending a week that already has an entry", () => {
  it("writes nothing when a valid document drops an achievement the week already has", async () => {
    // The trigger: the entry records A, the refresh finds B, and the model answers with
    // a document that passes every structural check and contains only B. Writing it
    // would delete A from the only place it exists.
    const tmp = mkdtempSync(join(tmpdir(), "worklog-amend-"));
    const configHome = join(tmp, "config");
    const vault = join(tmp, "vault");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousCacheHome = process.env.XDG_CACHE_HOME;

    seedVault(vault);
    writeConfig(configHome, vault);
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_CACHE_HOME = join(tmp, "cache");

    vi.stubGlobal("Bun", {
      write: async (path: string, content: string) => writeFileSync(path, content),
      file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }),
    });

    try {
      vi.resetModules();
      const { aiQueryStructured } = await import("../../lib/sdk/ai");
      vi.mocked(aiQueryStructured).mockResolvedValue({
        ...BAD_OUTPUT,
        bragBookMarkdown: "# Brag Book - Week 09, 2026\n\n## Achievements\n\n- Only the new thing",
      });

      const { generateWeek } = await import("../worklog");
      const { buildVaultPaths, readTeamTimeline } = await import("../../lib/sdk/vault");
      const { loadConfig, TEAM_TIMELINE_PATH } = await import("../../lib/config");
      const { getWeekStart, getWeekEnd } = await import("../../lib/sdk/week-utils");

      const config = loadConfig();
      if (!config) throw new Error("test config did not load");
      const paths = buildVaultPaths(config, TEAM_TIMELINE_PATH);
      const workLogPath = join(vault, `${WEEK} Work Log.md`);

      await expect(generateWeek({
        weekInfo: {
          weekNumber: 9,
          year: 2026,
          startDate: getWeekStart(9, 2026),
          endDate: getWeekEnd(9, 2026),
          filename: `${WEEK} Work Log.md`,
        },
        wid: WEEK,
        workLog: "# Work Log\n\nSomething new happened.\n",
        workLogPath,
        config,
        paths,
        timeline: readTeamTimeline(paths),
        log: () => {},
        spinner: { start: vi.fn(), stop: vi.fn(), message: vi.fn() } as never,
        amend: { existingBragBook: EXISTING_BRAG_BOOK, newMaterial: "- a comment" },
      })).rejects.toThrow(/Refusing to write the brag book/);

      // Both documents are exactly as they were.
      expect(readFileSync(join(vault, `${WEEK} Brag Book.md`), "utf8")).toBe(EXISTING_BRAG_BOOK);
      expect(readFileSync(workLogPath, "utf8")).toBe(EXISTING_WORK_LOG);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
