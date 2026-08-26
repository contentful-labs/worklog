import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The AI call is the edge of this test: the point is what runWorklog does with a bad
// answer, not how the answer was produced.
vi.mock("../../lib/sdk/ai", () => ({ aiQueryStructured: vi.fn() }));

// Same for the network. runWorklog's own control flow is what is under test.
vi.mock("../../lib/sdk/data-fetch", () => ({
  buildHeaders: () => ({}),
  getAccountId: async () => "acct-1",
  getGitHubUsername: async () => "testuser",
  fetchDataForWeek: async () => ({ issues: [], pages: [], prs: [], reviews: [], teamSprintItems: [] }),
}));

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
const EXISTING_WORK_LOG = "# Work Log 2026-W09\n\nReal fetched activity from the original run.\n";
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

function writeConfig(configHome: string, vault: string) {
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
  // readTeamTimeline reads this file directly and throws if it is missing.
  writeFileSync(
    join(configHome, "worklog", "team-timeline.json"),
    JSON.stringify({
      entries: [{ team: "Search", domain: "Search", start: "2024-01-01", end: null, ticketPrefixes: ["TEAM"], notes: null }],
      transitionNotes: [],
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("runWorklog write ordering", () => {
  it("leaves the existing work log and brag book untouched when the model returns a bad document", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "worklog-order-"));
    const configHome = join(tmp, "config");
    const vault = join(tmp, "vault");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAtlassian = process.env.ATLASSIAN_API_TOKEN;
    const previousGitHub = process.env.GITHUB_TOKEN;

    seedVault(vault);
    writeConfig(configHome, vault);
    process.env.XDG_CONFIG_HOME = configHome;
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
      vi.mocked(aiQueryStructured).mockResolvedValue(BAD_OUTPUT);

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
    const previousAtlassian = process.env.ATLASSIAN_API_TOKEN;
    const previousGitHub = process.env.GITHUB_TOKEN;

    seedVault(vault);
    writeConfig(configHome, vault);
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

      expect(readFileSync(join(vault, `${WEEK} Brag Book.md`), "utf8")).toContain("Shipped the thing");
      // The regenerated work log replaced the seeded one, which is the whole point of --force
      // once the week is known to be good.
      expect(readFileSync(join(vault, `${WEEK} Work Log.md`), "utf8")).not.toBe(EXISTING_WORK_LOG);
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
