import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clack from "@clack/prompts";
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

/** Existing week documents, so a forced run has real content it could overwrite. */
const SENTINEL_BRAG_BOOK = "---\ntags:\n  - areas/work\n---\n\n# Brag Book - Week 10, 2026\n\n## Achievements\n\n- The previous run's work\n";
const SENTINEL_WORK_LOG = "---\ntags:\n  - areas/work\n  - areas/work/work-log\n---\n\n# Work Log 2026-W10\n\nThe previous run's fetched activity.\n";

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
  profileUpdate: {
    achievement: "Led the search pagination work",
    bulletPoint: "Shipped cursor pagination across the search service",
  },
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

  // Seeded so a forced regeneration has something to destroy. Without these the negative
  // test could only prove that new files were not created, which is a weaker claim.
  writeFileSync(join(vault, `${WEEK} Brag Book.md`), SENTINEL_BRAG_BOOK);
  writeFileSync(join(vault, `${WEEK} Work Log.md`), SENTINEL_WORK_LOG);

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
interface FakeUsageOptions {
  model?: string;
  /** What the provider says the call cost. Only the Agent SDK reports one. */
  reportedCostUsd?: number;
}

async function loadPipeline(output: Partial<BragBookOutput>, usage: FakeUsageOptions = {}) {
  const { model = "gpt-5", reportedCostUsd } = usage;
  vi.resetModules();
  const { aiQueryStructured } = await import("../../lib/sdk/ai");
  vi.mocked(aiQueryStructured).mockImplementation(async (options) => {
    const step = { inputTokens: 56_000, outputTokens: 1_200, cachedInputTokens: 40_000, cacheWriteTokens: 0 };
    // undefined is how AIUsage says "the provider reported no cost", which is what the
    // nullish check in costOf reads, so it can be passed straight through.
    options.onUsage?.({ model, ...step, steps: [step], reportedCostUsd });
    return options.schema.parse(output);
  });
  return await import("../worklog");
}

/** The single stats record a one-week run appends. */
function readStats(configHome: string) {
  return JSON.parse(readFileSync(join(configHome, "worklog", "worklog-stats.json"), "utf8"));
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

      // The bullet has to land under Key Strengths, not merely be somewhere in the file.
      const keyStrengths = records.profile.slice(records.profile.indexOf("## Key Strengths"));
      expect(keyStrengths).toContain("Shipped cursor pagination across the search service");

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

      const stats = readStats(harness.configHome);

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

  it("prices a week whose model is a provider alias", async () => {
    const harness = setUp();

    try {
      // `gpt-5.6` is what a config may carry; the rate card is keyed by `gpt-5.6-sol`.
      const { runWorklog } = await loadPipeline(FAKE_OUTPUT, { model: "gpt-5.6" });
      await runWorklog({ ...RUN });

      const [record] = readStats(harness.configHome);
      expect(record.model).toBe("gpt-5.6");
      // 16k uncached at $4/M + 40k cached at $0.40/M + 1.2k out at $20/M, no tier at 56k.
      expect(record.estimatedCostUsd).toBeCloseTo(0.064 + 0.016 + 0.024, 10);
    } finally {
      harness.cleanup();
    }
  });

  it("records the provider's own cost in preference to the price table", async () => {
    const harness = setUp();

    try {
      const { runWorklog } = await loadPipeline(FAKE_OUTPUT, { model: "gpt-5", reportedCostUsd: 0.99 });
      await runWorklog({ ...RUN });

      const [record] = readStats(harness.configHome);
      // The table would have said $0.037 for these tokens on gpt-5.
      expect(record.estimatedCostUsd).toBe(0.99);
    } finally {
      harness.cleanup();
    }
  });

  it("treats a reported cost of zero as reported, not as missing", async () => {
    const harness = setUp();

    try {
      // A subscription run can genuinely cost nothing. Falsy-checking the reported cost
      // would fall through to the table and invent a charge for it.
      const { runWorklog } = await loadPipeline(FAKE_OUTPUT, { model: "gpt-5", reportedCostUsd: 0 });
      await runWorklog({ ...RUN });

      const [record] = readStats(harness.configHome);
      expect(record.estimatedCostUsd).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it("repeats the same week without drifting, bar the work log timestamp", async () => {
    const harness = setUp();

    try {
      const first = await loadPipeline(FAKE_OUTPUT);
      await first.runWorklog({ ...RUN });
      const afterOne = { records: readRecords(harness.vault), generated: readGenerated(harness.vault) };

      const second = await loadPipeline(FAKE_OUTPUT);
      await second.runWorklog({ ...RUN });
      const afterTwo = { records: readRecords(harness.vault), generated: readGenerated(harness.vault) };

      // Every maintained file, byte for byte.
      expect(afterTwo.records).toEqual(afterOne.records);
      expect(afterTwo.generated.bragBook).toBe(afterOne.generated.bragBook);

      // generateMarkdown stamps the work log with the moment it ran, so that line alone
      // differs and everything else still has to match.
      expect(afterTwo.generated.workLog).not.toBe(afterOne.generated.workLog);
      expect(withoutTimestamp(afterTwo.generated.workLog)).toBe(withoutTimestamp(afterOne.generated.workLog));

      // The two ways a rerun used to change focus-tracking.md, both closed upstream.
      expect(afterTwo.records.focusTracking).not.toContain("Paired once so far; Paired once so far");
      expect(afterTwo.records.focusTracking).not.toContain("restated");

      // Including the commitment this week created, which a rerun used to age for going
      // unanswered: the week that made it is not a review of it.
      expect(afterTwo.records.focusTracking).toBe(afterOne.records.focusTracking);
      expect(afterTwo.records.focusTracking).toContain(`| ${WEEK}.1 | ${WEEK} | Add regression coverage for cursor pagination | pending | 0 |`);
    } finally {
      harness.cleanup();
    }
  });

  it("leaves every vault document intact when the model leaves a required field out", async () => {
    const harness = setUp();

    try {
      const before = { records: readRecords(harness.vault), generated: readGenerated(harness.vault) };
      // Same object, minus a field the schema requires.
      const { focusStatuses, ...incomplete } = FAKE_OUTPUT;
      expect(focusStatuses).toHaveLength(2);

      const { runWorklog } = await loadPipeline(incomplete);
      await expect(runWorklog({ ...RUN })).rejects.toThrow();

      // The week already had both documents and --force would have replaced them, so this
      // is the overwrite case rather than merely "no new files appeared".
      expect(readGenerated(harness.vault)).toEqual(before.generated);
      expect(readRecords(harness.vault)).toEqual(before.records);

      // .worklog-progress.json is the one thing a failed run does leave behind: it is
      // written before the model is called, so the run can resume. It never names the
      // week that failed, which is what makes the week regenerable.
      const progress = JSON.parse(readFileSync(join(harness.vault, ".worklog-progress.json"), "utf8"));
      expect(progress.completedWeeks).not.toContain(WEEK);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps an older stats record that predates cost tracking, and prices an unknown model as unknown", async () => {
    const harness = setUp();

    try {
      const statsPath = join(harness.configHome, "worklog", "worklog-stats.json");
      // What stats.json looked like before tokens and cost existed.
      const legacy = {
        weekId: "2026-W01",
        date: "2026-01-05T00:00:00.000Z",
        fetch: 100,
        bragBook: 200,
        contextUpdates: 300,
        total: 600,
        counts: { jira: 1, confluence: 0, prs: 2, reviews: 0 },
      };
      writeFileSync(statsPath, JSON.stringify([legacy]));

      const { runWorklog } = await loadPipeline(FAKE_OUTPUT, { model: "some-model-nobody-priced" });
      await runWorklog({ ...RUN });

      const stats = JSON.parse(readFileSync(statsPath, "utf8"));
      expect(stats).toHaveLength(2);
      // The old record survives untouched, fields it never had still absent.
      expect(stats[0]).toEqual(legacy);
      expect(stats[1].model).toBe("some-model-nobody-priced");
      expect(stats[1].estimatedCostUsd).toBeNull();

      // An unpriced week reads as unknown in the summary rather than as free.
      const summary = vi.mocked(clack.note).mock.calls.map(([body]) => body).join("\n");
      expect(summary).toContain("—");
      expect(summary).not.toContain("$0.00");
    } finally {
      harness.cleanup();
    }
  });
});
