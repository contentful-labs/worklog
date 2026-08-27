import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { refreshWeeks, weeksInRange, type WeekToWrite } from "../refresh";
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
    config,
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

  it("writes the week the first time and nothing at all the second", async () => {
    const calls: string[] = [];

    const first = await runOnce(stubSource("jira", oneComment, calls));
    expect(first.written.map((week) => week.weekId)).toEqual(["2026-W36"]);
    expect(first.rows).toEqual([{ weekId: "2026-W36", regenerated: true }]);

    const vaultAfterFirst = await snapshotOfDisk(vault);
    const cacheAfterFirst = await snapshotOfDisk(cache);
    calls.length = 0;

    const second = await runOnce(stubSource("jira", oneComment, calls));

    // The source is asked the cheap question and nothing else happens.
    expect(calls).toEqual(["jira:since"]);
    expect(second.written).toEqual([]);
    expect(second.rows).toEqual([{ weekId: "2026-W36", regenerated: false }]);
    expect(second.outcome.perSource.get("jira")).toMatchObject({ addedEvents: 0, addedSnapshots: 0 });

    // Byte for byte, in the vault and in the cache.
    expect(await snapshotOfDisk(vault)).toEqual(vaultAfterFirst);
    expect(await snapshotOfDisk(cache)).toEqual(cacheAfterFirst);
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
    expect(second.written[0].newMaterial).toContain("TEAM-1234");
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
