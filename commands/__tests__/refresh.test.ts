import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { credentialsFor, refreshWeeks, weeksInRange, type WeekToWrite } from "../refresh";
import { allSources } from "../../lib/sdk/source-adapters";
import { getEnvTokens } from "../worklog";
import { parseSince, parseWeek, weekIdForDate } from "../../lib/sdk/week-utils";
import { openLedger } from "../../lib/sdk/ledger";
import type { Source, SourceBatch, SourceContext } from "../../lib/sdk/sources";
import type { WorklogConfig } from "../../lib/config";

let vault: string;
let cache: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "refresh-test-"));
  vault = join(base, "vault");
  cache = join(base, "cache", "ledger");
});

afterEach(async () => {
  await rm(join(vault, ".."), { recursive: true, force: true });
});

// SAFETY: refresh hands config to the sources and reads nothing from it itself; the fake
// sources in this file read only the Atlassian site address.
const config = { atlassian: { url: "https://example.atlassian.net", email: "user@example.com" } } as WorklogConfig;

const now = new Date("2026-09-07T10:00:00.000Z");

const ctxFor = (): SourceContext => ({
  config,
  headers: { atlassian: {}, github: {} },
  identity: { atlassianAccountId: "acc-1", githubUsername: "example-user" },
  onWarning: () => {},
  state: { get: () => undefined, set: () => {} },
  log: () => {},
});

/** A source that answers with the same thing every time, and counts how often it is asked. */
function stubSource(name: string, batch: SourceBatch, calls: string[] = []): Source {
  return {
    name,
    isAvailable: async () => ({ ok: true }),
    fetchWindow: async () => {
      calls.push(`${name}:window`);
      return batch;
    },
    fetchSince: async () => {
      calls.push(`${name}:since`);
      return batch;
    },
  };
}

const week = (weekId: string, start: string, end: string) => ({
  weekId,
  window: { start: new Date(`${start}T00:00:00.000Z`), end: new Date(`${end}T23:59:59.999Z`) },
});

const septemberWeek = week("2026-W36", "2026-08-31", "2026-09-06");

const oneComment: SourceBatch = {
  snapshots: [{
    id: "TEAM-1234",
    firstSeenAt: "2026-09-01T09:00:00.000Z",
    payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
  }],
  events: [{
    source: "jira", kind: "comment", itemId: "TEAM-1234",
    at: "2026-09-01T09:00:00.000Z", payload: { text: "Reviewed the rollout plan" }, id: "c-1",
  }],
  warnings: [],
};

async function runOnce(source: Source, weeks = [septemberWeek]) {
  const written: WeekToWrite[] = [];
  const ledger = await openLedger(cache);

  const run = await refreshWeeks({
    ledger,
    sources: [source],
    weeks,
    contextFor: ctxFor,
    now,
    writeWeek: async (weekToWrite) => {
      written.push(weekToWrite);
      await writeFile(join(vault, weekToWrite.weekInfo.filename), weekToWrite.workLog, "utf-8");
    },
  });

  return { ...run, written };
}

async function snapshotOfDisk(dir: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  if (!existsSync(dir)) return contents;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [nested, value] of await snapshotOfDisk(path)) contents.set(nested, value);
    } else {
      contents.set(path, await readFile(path, "utf-8"));
    }
  }
  return contents;
}

describe("running refresh twice", () => {
  beforeEach(async () => {
    await mkdir(vault, { recursive: true });
  });

  it("writes the week the first time, and nothing in the vault ever again", async () => {
    const calls: string[] = [];

    const first = await runOnce(stubSource("jira", oneComment, calls));
    expect(first.written.map((week) => week.weekId)).toEqual(["2026-W36"]);
    expect(first.rows).toEqual([{ weekId: "2026-W36", regenerated: true }]);

    const vaultAfterFirst = await snapshotOfDisk(vault);
    calls.length = 0;

    const second = await runOnce(stubSource("jira", oneComment, calls));

    // The source is asked the cheap question, and nothing is generated or written.
    expect(calls).toEqual(["jira:since"]);
    expect(second.written).toEqual([]);
    expect(second.rows).toEqual([{ weekId: "2026-W36", regenerated: false }]);
    expect(second.outcome.perSource.get("jira")).toMatchObject({ addedEvents: 0, addedSnapshots: 0 });
    expect(await snapshotOfDisk(vault)).toEqual(vaultAfterFirst);

    // The cache settles from the second run on, not the first. A first delta is where a
    // source learns its conditional state — the ETags that make the next fetch free — and
    // writing down something it did not know before is learning, not churn. What has to
    // be true is that a run which learns nothing writes nothing.
    const cacheAfterSecond = await snapshotOfDisk(cache);
    const third = await runOnce(stubSource("jira", oneComment, calls));

    expect(third.written).toEqual([]);
    expect(await snapshotOfDisk(vault)).toEqual(vaultAfterFirst);
    expect(await snapshotOfDisk(cache)).toEqual(cacheAfterSecond);
  });

  it("writes the week again when the second run does find something", async () => {
    const calls: string[] = [];
    await runOnce(stubSource("jira", oneComment, calls));

    const later: SourceBatch = {
      snapshots: [],
      events: [{
        source: "jira", kind: "status", itemId: "TEAM-1234",
        at: "2026-09-03T09:00:00.000Z", payload: { from: "In Progress", to: "Done" },
      }],
      warnings: [],
    };

    const second = await runOnce(stubSource("jira", later, calls));

    expect(second.rows).toEqual([{ weekId: "2026-W36", regenerated: true }]);
    // Only what this run found. The comment the first run filed is already in the entry
    // the model is being asked to add to, and repeating it invites a duplicate.
    expect(second.written[0].newMaterial).toContain("status on TEAM-1234");
    expect(second.written[0].newMaterial).not.toContain("comment on TEAM-1234");
    expect(second.written[0].workLog).toContain("In Progress to Done");
    // The comment from the first run is still there: the week was added to, not replaced.
    expect(second.written[0].workLog).toContain("Reviewed the rollout plan");
  });

  it("files an event into the week it belongs to without rewriting that week here", async () => {
    // The delta answers with something dated three weeks before the week asked about.
    const older: SourceBatch = {
      snapshots: [],
      events: [{
        source: "jira", kind: "comment", itemId: "TEAM-1234",
        at: "2026-08-11T09:00:00.000Z", payload: { text: "an older comment nobody had fetched" }, id: "c-old",
      }],
      warnings: [],
    };

    const run = await runOnce(stubSource("jira", older));

    // Filed where it belongs.
    const ledger = await openLedger(cache);
    expect(ledger.eventsForWeek("2026-W33")).toHaveLength(1);
    // But this run was not asked about that week, so it did not go and rewrite it.
    expect(run.written).toEqual([]);
    expect(run.rows).toEqual([{ weekId: "2026-W36", regenerated: false }]);
  });

  it("regenerates the older week once it is asked about", async () => {
    const older: SourceBatch = {
      snapshots: [{
        id: "TEAM-1234", firstSeenAt: "2026-08-11T09:00:00.000Z",
        payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
      }],
      events: [{
        source: "jira", kind: "comment", itemId: "TEAM-1234",
        at: "2026-08-11T09:00:00.000Z", payload: { text: "an older comment" }, id: "c-old",
      }],
      warnings: [],
    };

    const run = await runOnce(stubSource("jira", older), [week("2026-W33", "2026-08-10", "2026-08-16"), septemberWeek]);

    expect(run.rows.find((row) => row.weekId === "2026-W33")?.regenerated).toBe(true);
    expect(run.rows.find((row) => row.weekId === "2026-W36")?.regenerated).toBe(false);
    expect(run.written[0].workLog).toContain("an older comment");
  });
});

describe("the range refresh covers", () => {
  it("walks whole weeks from the start date to today", () => {
    const weeks = weeksInRange(new Date("2026-08-10T00:00:00.000Z"), new Date("2026-08-31T00:00:00.000Z"));
    expect(weeks.map((week) => week.weekId)).toEqual(["2026-W33", "2026-W34", "2026-W35", "2026-W36"]);
  });

  it("gives one week when the range is inside one", () => {
    const weeks = weeksInRange(new Date("2026-08-11T00:00:00.000Z"), new Date("2026-08-13T00:00:00.000Z"));
    expect(weeks.map((week) => week.weekId)).toEqual(["2026-W33"]);
  });
});

describe("a week whose events changed while nobody was looking at it", () => {
  const olderComment: SourceBatch = {
    snapshots: [{
      id: "TEAM-1234", firstSeenAt: "2026-08-11T09:00:00.000Z",
      payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
    }],
    events: [{
      source: "jira", kind: "comment", itemId: "TEAM-1234",
      at: "2026-08-11T09:00:00.000Z", payload: { text: "an older comment nobody had fetched" }, id: "c-old",
    }],
    warnings: [],
  };

  beforeEach(async () => {
    await mkdir(vault, { recursive: true });
  });

  it("is still owed a write on the next run, and says so in the meantime", async () => {
    // The trigger: refreshing September turns up an August comment. It is filed where it
    // belongs, but September's run does not write August. On the next run the event is
    // no longer new, so without a record of the debt August stays stale for ever.
    const first = await runOnce(stubSource("jira", olderComment));
    expect(first.written).toEqual([]);
    expect(first.waiting).toEqual(["2026-W33"]);

    const augustWeek = week("2026-W33", "2026-08-10", "2026-08-16");
    const second = await runOnce(stubSource("jira", { snapshots: [], events: [], warnings: [] }), [augustWeek]);

    expect(second.written.map((w) => w.weekId)).toEqual(["2026-W33"]);
    expect(second.written[0].workLog).toContain("an older comment nobody had fetched");
    expect(second.waiting).toEqual([]);
  });

  it("stops being owed a write once it has had one", async () => {
    const augustWeek = week("2026-W33", "2026-08-10", "2026-08-16");
    await runOnce(stubSource("jira", olderComment), [augustWeek]);

    const again = await runOnce(stubSource("jira", olderComment), [augustWeek]);
    expect(again.written).toEqual([]);
    expect(again.waiting).toEqual([]);
  });
});

describe("weeks at the turn of the year", () => {
  it("puts the last days of December in the next year's first week", () => {
    // The trigger: pairing an ISO week number with a calendar year gives 2025-W01 for
    // 29 December 2025, a week whose range starts in December 2024.
    const weeks = weeksInRange(new Date("2025-12-29T00:00:00.000Z"), new Date("2025-12-31T00:00:00.000Z"));

    expect(weeks.map((w) => w.weekId)).toEqual(["2026-W01"]);
    expect(weeks[0].window.start.toISOString()).toBe("2025-12-29T00:00:00.000Z");
    expect(weeks[0].window.end.toISOString()).toBe("2026-01-04T23:59:59.999Z");
  });

  it("walks across a year boundary without repeating or skipping a week", () => {
    const weeks = weeksInRange(new Date("2025-12-22T00:00:00.000Z"), new Date("2026-01-12T00:00:00.000Z"));
    expect(weeks.map((w) => w.weekId)).toEqual(["2025-W52", "2026-W01", "2026-W02", "2026-W03"]);
  });
});

describe("what the command accepts on the command line", () => {
  it("takes a real date and refuses one that never happened", () => {
    expect(parseSince("2026-01-31")).toBe("2026-01-31");
    // The trigger: 31 February matches the format, and `new Date` rolls it to 3 March.
    expect(() => parseSince("2026-02-31")).toThrow(/real date/);
    expect(() => parseSince("2026-13-01")).toThrow(/real date/);
    expect(() => parseSince("last tuesday")).toThrow(/real date/);
  });

  it("takes a week of that year and refuses one that is not", () => {
    expect(parseWeek("2026-W06")).toBe("2026-W06");
    expect(parseWeek("2026-W6")).toBe("2026-W06");
    // 2026 is a 53-week year; 2027 is not.
    expect(parseWeek("2026-W53")).toBe("2026-W53");
    expect(() => parseWeek("2027-W53")).toThrow(/not a week of 2027/);
    expect(() => parseWeek("2026-W99")).toThrow(/not a week of 2026/);
    expect(() => parseWeek("2026-W00")).toThrow(/not a week of 2026/);
    expect(() => parseWeek("nonsense")).toThrow(/YYYY-WNN/);
  });
});

describe("an event discovered days before its week is refreshed", () => {
  const augustWeek = week("2026-W33", "2026-08-10", "2026-08-16");
  const augustComment: SourceBatch = {
    snapshots: [{
      id: "TEAM-1234", firstSeenAt: "2026-08-11T09:00:00.000Z",
      payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
    }],
    events: [{
      source: "jira", kind: "comment", itemId: "TEAM-1234",
      at: "2026-08-11T09:00:00.000Z", payload: { text: "an older comment" }, id: "c-old",
    }],
    warnings: [],
  };

  beforeEach(async () => {
    await mkdir(vault, { recursive: true });
  });

  it("still reaches the model when that week is finally written", async () => {
    // The trigger: September's run discovers an August event and files it. August is
    // refreshed later; measured against the state at the start of that run, the event is
    // already there and counts as old, so the prompt is handed nothing new and told that
    // everything else is already accounted for. The event is then never written up.
    const september = await runOnce(stubSource("jira", augustComment));
    expect(september.written).toEqual([]);
    expect(september.waiting).toEqual(["2026-W33"]);

    const august = await runOnce(stubSource("jira", { snapshots: [], events: [], warnings: [] }), [augustWeek]);

    expect(august.written.map((w) => w.weekId)).toEqual(["2026-W33"]);
    expect(august.written[0].newMaterial).toContain("comment on TEAM-1234");
  });

  it("is not offered again once the week that received it has been written", async () => {
    await runOnce(stubSource("jira", augustComment));
    await runOnce(stubSource("jira", { snapshots: [], events: [], warnings: [] }), [augustWeek]);

    const again = await runOnce(stubSource("jira", augustComment), [augustWeek]);
    expect(again.written).toEqual([]);
  });
});

describe("a week whose cached events cannot all be read", () => {
  beforeEach(async () => {
    await mkdir(vault, { recursive: true });
  });

  it("is not written into the vault, and its new events are refused rather than half-kept", async () => {
    // The trigger: one unreadable row plus one new event. Generating from what is left
    // turns a damaged cache file, which can be refetched, into a damaged week, which
    // cannot — and keeping the new event in memory alone would move the reading position
    // past an event that was never saved.
    await runOnce(stubSource("jira", oneComment));
    const weekFile = join(cache, "events", "2026-W36.json");
    const rows = JSON.parse(await readFile(weekFile, "utf-8"));
    await writeFile(weekFile, JSON.stringify([...rows, { source: "jira", kind: 7 }], null, 2), "utf-8");
    const cacheBefore = await readFile(weekFile, "utf-8");
    const vaultBefore = await snapshotOfDisk(vault);

    const later: SourceBatch = {
      snapshots: [],
      events: [{
        source: "jira", kind: "status", itemId: "TEAM-1234",
        at: "2026-09-03T09:00:00.000Z", payload: { from: "In Progress", to: "Done" },
      }],
      warnings: [],
    };
    const run = await runOnce(stubSource("jira", later));

    expect(run.written).toEqual([]);
    expect(run.rows).toEqual([{ weekId: "2026-W36", regenerated: false }]);
    // Neither the vault nor the damaged file was touched.
    expect(await snapshotOfDisk(vault)).toEqual(vaultBefore);
    expect(await readFile(weekFile, "utf-8")).toBe(cacheBefore);

    // And the week is recorded as not fully read, which is what stops the next run from
    // treating its reading position as coverage and skipping the event that was refused.
    const ledger = await openLedger(cache);
    expect(ledger.incompleteWeeks()).toEqual(["2026-W36"]);
  });

  it("asks for the refused events again once the file is repaired", async () => {
    // The trigger Codex named: corrupt, fetch, repair, fetch. The middle fetch must not
    // buy coverage, or the event it dropped is never asked for again.
    await runOnce(stubSource("jira", oneComment));
    const weekFile = join(cache, "events", "2026-W36.json");
    const healthy = await readFile(weekFile, "utf-8");
    await writeFile(weekFile, JSON.stringify([...JSON.parse(healthy), { source: "jira", kind: 7 }], null, 2), "utf-8");

    const later: SourceBatch = {
      snapshots: [],
      events: [{
        source: "jira", kind: "status", itemId: "TEAM-1234",
        at: "2026-09-03T09:00:00.000Z", payload: { from: "In Progress", to: "Done" }, id: "s-1",
      }],
      warnings: [],
    };
    await runOnce(stubSource("jira", later));

    // The user repairs the file by putting back what could be read.
    await writeFile(weekFile, healthy, "utf-8");
    const run = await runOnce(stubSource("jira", later));

    const ledger = await openLedger(cache);
    expect(ledger.eventsForWeek("2026-W36").map((event) => event.kind).sort()).toEqual(["comment", "status"]);
    expect(run.written.map((week) => week.weekId)).toEqual(["2026-W36"]);
  });
});

describe("a run that fails partway through", () => {
  const augustWeek = week("2026-W33", "2026-08-10", "2026-08-16");
  const bothWeeks: SourceBatch = {
    snapshots: [{
      id: "TEAM-1234", firstSeenAt: "2026-08-11T09:00:00.000Z",
      payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
    }],
    events: [
      { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-11T09:00:00.000Z", payload: { text: "August" }, id: "c-aug" },
      { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-09-01T09:00:00.000Z", payload: { text: "September" }, id: "c-sep" },
    ],
    warnings: [],
  };

  beforeEach(async () => {
    await mkdir(vault, { recursive: true });
  });

  it("keeps the marker of the week it did write", async () => {
    // The trigger: August is written, then September throws. Saving markers only at the
    // end loses August's, and the next run offers its events again as new — so the
    // entry says everything twice.
    const written: string[] = [];
    const ledger = await openLedger(cache);

    await expect(refreshWeeks({
      ledger,
      sources: [stubSource("jira", bothWeeks)],
      weeks: [augustWeek, septemberWeek],
      contextFor: ctxFor,
      now,
      writeWeek: async ({ weekId }) => {
        if (weekId === "2026-W36") throw new Error("the model refused September");
        written.push(weekId);
      },
    })).rejects.toThrow("the model refused September");

    expect(written).toEqual(["2026-W33"]);

    // Reopened from disk: August is settled, September is still owed a write.
    const reopened = await openLedger(cache);
    expect(reopened.unwrittenEvents("2026-W33")).toEqual([]);
    expect(reopened.pendingWeeks()).toEqual(["2026-W36"]);
  });
});

describe("a week a source did not finish reading", () => {
  const partialBatch: SourceBatch = {
    snapshots: [{
      id: "TEAM-1234", firstSeenAt: "2026-09-01T09:00:00.000Z",
      payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
    }],
    events: [{
      source: "jira", kind: "comment", itemId: "TEAM-1234",
      at: "2026-09-01T09:00:00.000Z", payload: { text: "half the story" }, id: "c-1",
    }],
    warnings: ["page two would not load"],
    incomplete: true,
  };

  function unfinishedSource(name: string, batch: SourceBatch, calls: string[] = []): Source {
    return {
      name,
      isAvailable: async () => ({ ok: true }),
      fetchWindow: async () => {
        calls.push(`${name}:window`);
        return batch;
      },
      fetchSince: async () => {
        calls.push(`${name}:since`);
        return batch;
      },
    };
  }

  beforeEach(async () => {
    await mkdir(vault, { recursive: true });
  });

  it("is not written up from the half of it that arrived", async () => {
    // The trigger: page one of a history comes back, page two fails. The events that did
    // arrive are worth keeping, but writing the week up from them puts a partial account
    // in the vault and marks it written — so the missing part is old news when it lands.
    const run = await runOnce(unfinishedSource("jira", partialBatch));

    expect(run.written).toEqual([]);
    expect(run.unfinished).toEqual(["2026-W36"]);
    expect(run.rows).toEqual([{ weekId: "2026-W36", regenerated: false }]);
    // Kept, so the next run matches rather than duplicates it.
    const ledger = await openLedger(cache);
    expect(ledger.eventsForWeek("2026-W36")).toHaveLength(1);
    expect(ledger.pendingWeeks()).toEqual(["2026-W36"]);
  });

  it("is written once the source finishes", async () => {
    await runOnce(unfinishedSource("jira", partialBatch));

    const whole: SourceBatch = { ...partialBatch, warnings: [], incomplete: undefined };
    const second = await runOnce(unfinishedSource("jira", whole));

    expect(second.unfinished).toEqual([]);
    expect(second.written.map((w) => w.weekId)).toEqual(["2026-W36"]);
  });

  it("holds back a delta's weeks too, since which one lost something is unknown", async () => {
    // First a clean window fetch so the week is collected, then an unfinished delta.
    const augustWeek = week("2026-W33", "2026-08-10", "2026-08-16");
    const clean: SourceBatch = { snapshots: [], events: [], warnings: [] };
    await runOnce(stubSource("jira", clean), [augustWeek, septemberWeek]);

    const run = await runOnce(unfinishedSource("jira", partialBatch), [augustWeek, septemberWeek]);

    expect(run.written).toEqual([]);
    expect(run.unfinished).toEqual(["2026-W36"]);
  });
});

describe("which credentials a refresh actually needs", () => {
  it("asks for Atlassian only when an Atlassian source is selected", () => {
    expect(credentialsFor(allSources())).toEqual({ atlassian: true, github: true });
    expect(credentialsFor(allSources().filter((s) => s.name === "github")))
      .toEqual({ atlassian: false, github: true });
    expect(credentialsFor(allSources().filter((s) => s.name === "jira")))
      .toEqual({ atlassian: true, github: false });
    expect(credentialsFor(allSources().filter((s) => s.name === "confluence")))
      .toEqual({ atlassian: true, github: false });
  });

  it("does not stop a GitHub-only run for a missing Atlassian token", () => {
    // The trigger: only GITHUB_TOKEN is set, and `refresh --source github` used to exit
    // for want of a token it was never going to use.
    const previous = process.env.ATLASSIAN_API_TOKEN;
    const previousGitHub = process.env.GITHUB_TOKEN;
    try {
      delete process.env.ATLASSIAN_API_TOKEN;
      process.env.GITHUB_TOKEN = "test-github-token";

      const tokens = getEnvTokens({ atlassian: false, github: true });
      expect(tokens.githubToken).toBe("test-github-token");
      expect(tokens.apiToken).toBe("");
    } finally {
      if (previous === undefined) delete process.env.ATLASSIAN_API_TOKEN;
      else process.env.ATLASSIAN_API_TOKEN = previous;
      if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGitHub;
    }
  });

  it("does not stop a Jira-only run for a missing GitHub token", () => {
    const previous = process.env.GITHUB_TOKEN;
    const previousAtlassian = process.env.ATLASSIAN_API_TOKEN;
    try {
      delete process.env.GITHUB_TOKEN;
      process.env.ATLASSIAN_API_TOKEN = "test-atlassian-token";

      const tokens = getEnvTokens({ atlassian: true, github: false });
      expect(tokens.apiToken).toBe("test-atlassian-token");
      expect(tokens.githubToken).toBe("");
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
      if (previousAtlassian === undefined) delete process.env.ATLASSIAN_API_TOKEN;
      else process.env.ATLASSIAN_API_TOKEN = previousAtlassian;
    }
  });
});

describe("a week another source left half-read", () => {
  const halfRead: SourceBatch = {
    snapshots: [],
    events: [{
      source: "github", kind: "review", itemId: "https://github.com/example-org/repo/pull/7",
      at: "2026-09-01T09:00:00.000Z", payload: {}, id: "r-1",
    }],
    warnings: ["page two would not load"],
    incomplete: true,
  };

  function source(name: string, batch: SourceBatch): Source {
    return {
      name,
      isAvailable: async () => ({ ok: true }),
      fetchWindow: async () => batch,
      fetchSince: async () => batch,
    };
  }

  beforeEach(async () => {
    await mkdir(vault, { recursive: true });
  });

  it("is still held back by a later run that only reads a different source", async () => {
    // The trigger: GitHub's page two fails for this week, then the user runs
    // `refresh --source jira --week W`. That run finds nothing incomplete of its own, so
    // without a memory of the first one it writes the week up from half of GitHub.
    const first = await runOnce(source("github", halfRead));
    expect(first.written).toEqual([]);
    expect(first.unfinished).toEqual(["2026-W36"]);

    const jiraOnly = await runOnce(source("jira", oneComment));

    expect(jiraOnly.written).toEqual([]);
    expect(jiraOnly.unfinished).toEqual(["2026-W36"]);
  });

  it("is written once the source that fell short catches up", async () => {
    await runOnce(source("github", halfRead));

    const whole: SourceBatch = { ...halfRead, warnings: [], incomplete: undefined };
    const second = await runOnce(source("github", whole));

    expect(second.unfinished).toEqual([]);
    expect(second.written.map((week) => week.weekId)).toEqual(["2026-W36"]);
  });
});

describe("walking a range of weeks", () => {
  it("includes the week the range ends in, whatever weekday it started on", () => {
    // The trigger: stepping seven days at a time keeps the weekday of the start. From a
    // Tuesday, the third step lands on the Tuesday after the range ends, so the last week
    // is never visited — and for the default range that is the current week.
    const tuesday = new Date("2026-08-11T00:00:00.000Z");
    const mondayAfterNext = new Date("2026-08-24T00:00:00.000Z");

    expect(weeksInRange(tuesday, mondayAfterNext).map((week) => week.weekId))
      .toEqual(["2026-W33", "2026-W34", "2026-W35"]);
  });

  it.each([
    ["Monday to Monday", "2026-08-10", "2026-08-24"],
    ["Tuesday to Monday", "2026-08-11", "2026-08-24"],
    ["Sunday to Monday", "2026-08-16", "2026-08-24"],
    ["Monday to Sunday", "2026-08-10", "2026-08-30"],
    ["Friday to Sunday", "2026-08-14", "2026-08-30"],
  ])("covers every week between the two ends: %s", (_name, from, to) => {
    const weeks = weeksInRange(new Date(`${from}T00:00:00.000Z`), new Date(`${to}T00:00:00.000Z`));

    // Both ends are included, and there are no gaps between them.
    expect(weeks[0].weekId).toBe(weekIdForDate(new Date(`${from}T00:00:00.000Z`)));
    expect(weeks[weeks.length - 1].weekId).toBe(weekIdForDate(new Date(`${to}T00:00:00.000Z`)));
    expect(new Set(weeks.map((week) => week.weekId)).size).toBe(weeks.length);
  });

  it("gives one week when both ends are inside it, on any weekday", () => {
    expect(weeksInRange(new Date("2026-08-13T00:00:00.000Z"), new Date("2026-08-14T00:00:00.000Z"))
      .map((week) => week.weekId)).toEqual(["2026-W33"]);
  });
});
