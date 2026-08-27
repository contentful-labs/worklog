import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { FOCUS_TRACKING_TEMPLATE } from "../../lib/sdk/focus";
import { appendToFirstTable, renderRow } from "../../lib/sdk/markdown-table";
import { generateProfileDoc, generateWorkContextDoc, generateCoachPersonaDoc } from "../../lib/sdk/doc-generators";
import type { BragBookOutput } from "../../lib/sdk/brag-book-schema";
import type { WorklogConfig } from "../../lib/sdk/types";

/**
 * One week, end to end, over a temp vault.
 *
 * Everything outside the AI provider and the three HTTP APIs is real: the prompt is built,
 * the documents are written, and all five vault files go through the writers that ship.
 * The bugs this is here to catch are the ones where a row lands in the wrong section or a
 * status closes an item it should not, and none of those show up in a unit test.
 *
 * To extend it: add to FAKE_OUTPUT and assert the file it should reach. Keep the second
 * run in place, because "runs twice without drifting" is the property most of those bugs
 * broke.
 */

// The provider is the seam. The fake still parses through the caller's schema, because
// that parse is the real function's last act and skipping it would test a contract the
// pipeline does not actually have.
vi.mock("../../lib/sdk/ai", () => ({ aiQueryStructured: vi.fn() }));

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

const WEEK = "2026-W10";
const ATLASSIAN = "https://acme.atlassian.net";

/** The week has no fetched activity: this test is about the vault, not the fetchers. */
const server = setupServer(
  http.get(`${ATLASSIAN}/rest/api/3/myself`, () => HttpResponse.json({ accountId: "acct-1" })),
  http.get("https://api.github.com/user", () => HttpResponse.json({ login: "testuser" })),
  http.post(`${ATLASSIAN}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [] })),
  http.get(`${ATLASSIAN}/wiki/rest/api/content/search`, () => HttpResponse.json({ results: [] })),
  http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CONFIG: WorklogConfig = {
  version: 1,
  vault: "",  // filled in per run, once the temp dir exists
  atlassian: { url: ATLASSIAN, email: "user@example.com" },
  githubOrgs: ["acme"],
  ai: { provider: "openai" },
  profile: {
    fullName: "Test User", displayName: "Test", jobTitle: "Senior Engineer", level: "IC-5",
    company: "Acme", location: "Remote", startDate: "2024-01-01", domain: "Platform",
    team: "Search", teamDomain: "Search", ticketPrefixes: ["TEAM"],
  },
  career: {
    framework: "example", currentLevel: "IC-5", targetLevel: "IC-6",
    companyValues: ["Quality"], reviewCycleDates: [], skills: ["TypeScript"],
    growthAreas: ["System design"], careerDocPaths: [],
  },
  coaching: { tone: "direct", focusAreas: ["Visibility"] },
};

/** A memory row the fake graduates, so the wording has to match its Item cell exactly. */
const GRADUATED_ITEM = "Fixed a flaky pagination test";

const MEMORY = `# Memory - Small Contributions Awaiting Significance

Contributions here are waiting to accumulate into something brag-worthy.

| Date | Item | Category | Notes |
|------|------|----------|-------|
| 2026-03-02 | ${GRADUATED_ITEM} | bugfix |  |
| 2026-03-03 | Reviewed the search RFC | review |  |
| 2026-03-04 | Updated the onboarding runbook | docs |  |
`;

const IMPACT_LOG = `# Impact Log

Achievements that carry weight in a review, with the evidence for them.

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|

**Last significant impact:** none recorded
**Current gap:** no significant impact recorded
`;

/** Built from the module that owns the format, so a format change moves the fixture too. */
const FOCUS_TRACKING = appendToFirstTable(FOCUS_TRACKING_TEMPLATE, [
  renderRow(["2026-W09.1", "2026-W09", "Write the search revamp design doc", "pending", "0", ""]),
  renderRow(["2026-W09.2", "2026-W09", "Pair with a teammate on the indexer", "pending", "0", ""]),
]);

/** What the coach came back with: one of each kind of vault update. */
const FAKE_OUTPUT: BragBookOutput = {
  bragBookMarkdown: [
    "---",
    "tags:",
    "  - areas/work",
    "  - areas/work/brag-book",
    "---",
    "# Brag Book - Week 10, 2026",
    "",
    "## Achievements",
    "",
    "- **2026-03-05** Shipped cursor pagination for search results",
    "",
    "## Week in Review",
    "",
    "A focused week on search pagination.",
  ].join("\n"),
  memoryItemsToAdd: [
    { date: "2026-03-05", item: "Tidied the search fixtures", category: "chore", notes: "May join a testing theme" },
  ],
  memoryGraduations: [{ item: GRADUATED_ITEM, nowPartOf: "Search pagination work" }],
  impactLogEntry: {
    date: "2026-03-05",
    achievement: "Shipped cursor pagination for search results",
    scope: "Team",
    coreValue: "Quality",
    evidence: "TEAM-1234, PR #12",
  },
  workContextUpdates: [
    { category: "process", info: "Sprint planning moved to Tuesdays", source: "team meeting" },
  ],
  profileUpdate: null,
  focusStatuses: [
    { id: "2026-W09.1", status: "completed", notes: "Design doc published" },
    { id: "2026-W09.2", status: "ongoing", notes: "Paired once so far" },
  ],
  newFocusItems: ["Add regression coverage for cursor pagination"],
};

/** The five files the pipeline maintains. They exist before the first run and after it. */
function readRecords(vault: string): Record<string, string> {
  const files = {
    memory: "memory.md",
    impactLog: "impact-log.md",
    workContext: "work-context.md",
    profile: "my-profile.md",
    focusTracking: "focus-tracking.md",
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, file]) => [name, readFileSync(join(vault, file), "utf8")]),
  );
}

/** The two documents a run produces. Neither exists until a week has been generated. */
function readGenerated(vault: string) {
  return {
    bragBook: readFileSync(join(vault, `${WEEK} Brag Book.md`), "utf8"),
    workLog: readFileSync(join(vault, `${WEEK} Work Log.md`), "utf8"),
  };
}

/**
 * generateMarkdown stamps the work log with the moment it ran, so two runs of the same
 * week differ by that line and nothing else. Blanking it lets the rest be compared.
 */
function withoutTimestamp(workLog: string): string {
  return workLog
    .split("\n")
    .map((line) => (line.startsWith("**Generated:**") ? "**Generated:** <stamp>" : line))
    .join("\n");
}

interface Harness {
  vault: string;
  configHome: string;
  cacheHome: string;
  cleanup: () => void;
}

function setUp(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "worklog-e2e-"));
  const vault = join(tmp, "vault");
  const configHome = join(tmp, "config");
  const cacheHome = join(tmp, "cache");
  mkdirSync(vault, { recursive: true });
  mkdirSync(cacheHome, { recursive: true });
  mkdirSync(join(configHome, "worklog"), { recursive: true });

  const config = { ...CONFIG, vault };
  writeFileSync(join(configHome, "worklog", "config.json"), JSON.stringify(config));
  writeFileSync(
    join(configHome, "worklog", "team-timeline.json"),
    JSON.stringify({
      entries: [{ team: "Search", domain: "Search", start: "2024-01-01", end: null, ticketPrefixes: ["TEAM"], notes: null }],
      transitionNotes: [],
    }),
  );

  writeFileSync(join(vault, "memory.md"), MEMORY);
  writeFileSync(join(vault, "impact-log.md"), IMPACT_LOG);
  writeFileSync(join(vault, "focus-tracking.md"), FOCUS_TRACKING);
  writeFileSync(join(vault, "my-profile.md"), generateProfileDoc(config));
  writeFileSync(join(vault, "work-context.md"), generateWorkContextDoc(config));
  writeFileSync(join(vault, "coach-persona.md"), generateCoachPersonaDoc(config));

  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    cache: process.env.XDG_CACHE_HOME,
    atlassian: process.env.ATLASSIAN_API_TOKEN,
    github: process.env.GITHUB_TOKEN,
  };
  process.env.XDG_CONFIG_HOME = configHome;
  // Nothing on this branch reads it yet. Set anyway: the moment anything caches under it,
  // an unset value writes into the developer's own ~/.cache during a test run.
  process.env.XDG_CACHE_HOME = cacheHome;
  process.env.ATLASSIAN_API_TOKEN = "test-atlassian-token";
  process.env.GITHUB_TOKEN = "test-github-token";

  // vitest runs on node, and the pipeline reads prompts and writes stats through Bun.
  vi.stubGlobal("Bun", {
    write: async (path: string, content: string) => writeFileSync(path, content),
    file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }),
  });

  return {
    vault,
    configHome,
    cacheHome,
    cleanup: () => {
      for (const [key, value] of [
        ["XDG_CONFIG_HOME", previous.config],
        ["XDG_CACHE_HOME", previous.cache],
        ["ATLASSIAN_API_TOKEN", previous.atlassian],
        ["GITHUB_TOKEN", previous.github],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Import runWorklog under the temp config home, with the fake wired up. */
async function loadPipeline(output: Partial<BragBookOutput>) {
  vi.resetModules();
  const { aiQueryStructured } = await import("../../lib/sdk/ai");
  vi.mocked(aiQueryStructured).mockImplementation(async (options) => {
    options.onUsage?.({
      model: "gpt-5",
      inputTokens: 56_000,
      outputTokens: 1_200,
      cachedInputTokens: 40_000,
      steps: 2,
    });
    return options.schema.parse(output);
  });
  return await import("../worklog");
}

const RUN = { week: WEEK, noPrompt: true, force: true, verbose: false } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("one week end to end", () => {
  it("applies every kind of update to the right file", async () => {
    const harness = setUp();

    try {
      const { runWorklog } = await loadPipeline(FAKE_OUTPUT);
      await runWorklog({ ...RUN });

      const records = readRecords(harness.vault);
      const generated = readGenerated(harness.vault);

      expect(generated.bragBook).toContain("tags:\n  - areas/work\n  - areas/work/brag-book");
      expect(generated.bragBook).toContain("Shipped cursor pagination for search results");
      expect(generated.workLog).toContain("Work Log");

      expect(records.memory).toContain("Tidied the search fixtures");
      expect(records.memory).not.toContain(GRADUATED_ITEM);
      expect(records.memory).toContain("Reviewed the search RFC");

      expect(records.impactLog).toContain("Shipped cursor pagination for search results");
      expect(records.impactLog).toContain("2026-03-05");
      expect(records.impactLog).toContain("**Last significant impact:** 2026-03-05");

      expect(records.workContext).toContain("- **process:** Sprint planning moved to Tuesdays _(team meeting)_");

      // The completed id closes, the ongoing one stays open, and the new commitment gets
      // this week's id.
      expect(records.focusTracking).toContain("| 2026-W09.1 | 2026-W09 | Write the search revamp design doc | completed |");
      expect(records.focusTracking).toContain("| 2026-W09.2 | 2026-W09 | Pair with a teammate on the indexer | ongoing |");
      expect(records.focusTracking).toContain("| 2026-W10.1 | 2026-W10 | Add regression coverage for cursor pagination | pending |");
    } finally {
      harness.cleanup();
    }
  });

  it("records what the week cost, in the config dir and nowhere else", async () => {
    const harness = setUp();

    try {
      const { runWorklog } = await loadPipeline(FAKE_OUTPUT);
      await runWorklog({ ...RUN });

      const statsPath = join(harness.configHome, "worklog", "worklog-stats.json");
      const stats = JSON.parse(readFileSync(statsPath, "utf8"));

      expect(stats).toHaveLength(1);
      expect(stats[0]).toMatchObject({
        weekId: WEEK,
        model: "gpt-5",
        tokens: { input: 56_000, output: 1_200, cached: 40_000 },
      });
      // gpt-5: 16k uncached at $1.25/M + 40k cached at $0.125/M + 1.2k out at $10/M.
      expect(stats[0].estimatedCostUsd).toBeCloseTo(0.02 + 0.005 + 0.012, 10);
    } finally {
      harness.cleanup();
    }
  });

  it("repeats the same week without drifting, except where it is known to", async () => {
    const harness = setUp();

    try {
      const first = await loadPipeline(FAKE_OUTPUT);
      await first.runWorklog({ ...RUN });
      const afterOne = { records: readRecords(harness.vault), generated: readGenerated(harness.vault) };

      const second = await loadPipeline(FAKE_OUTPUT);
      await second.runWorklog({ ...RUN });
      const afterTwo = { records: readRecords(harness.vault), generated: readGenerated(harness.vault) };

      // Everything the writers dedupe: byte for byte.
      for (const file of ["memory", "impactLog", "workContext", "profile"] as const) {
        expect(afterTwo.records[file], `${file} drifted on the second run`).toBe(afterOne.records[file]);
      }
      expect(afterTwo.generated.bragBook).toBe(afterOne.generated.bragBook);
      expect(withoutTimestamp(afterTwo.generated.workLog)).toBe(withoutTimestamp(afterOne.generated.workLog));

      // KNOWN DEFECT, focus-tracking.md only. Regenerating a week is not a no-op there:
      //   - a status note is appended again, so notes grow on every re-run
      //     (appendNote in lib/sdk/focus.ts does not check whether the note is already there);
      //   - the new commitment from run one is close enough to itself that run two records
      //     it as restated.
      // Pinned rather than asserted away, so whoever fixes it sees this test go red.
      expect(afterTwo.records.focusTracking).not.toBe(afterOne.records.focusTracking);
      expect(afterTwo.records.focusTracking).toContain("Paired once so far; Paired once so far");
      expect(afterTwo.records.focusTracking).toContain("restated 2026-W10");
    } finally {
      harness.cleanup();
    }
  });

  it("writes nothing when the model leaves a required field out", async () => {
    const harness = setUp();

    try {
      const before = readRecords(harness.vault);
      // Same object, minus a field the schema requires.
      const { focusStatuses, ...incomplete } = FAKE_OUTPUT;
      expect(focusStatuses).toHaveLength(2);

      const { runWorklog } = await loadPipeline(incomplete);
      await expect(runWorklog({ ...RUN })).rejects.toThrow();

      expect(readRecords(harness.vault)).toEqual(before);
      expect(() => readGenerated(harness.vault)).toThrow();
    } finally {
      harness.cleanup();
    }
  });
});
