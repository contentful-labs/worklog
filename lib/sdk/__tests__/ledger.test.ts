import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { tmpdir } from "node:os";

import {
  openLedger, ledgerRoot, eventsByItem, insidePath, isSafeSourceName, newEvents, renderable,
  collectIntoLedger, weekWindow,
} from "../ledger";
import type { Source, SourceBatch, SourceContext } from "../sources";

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), "ledger-test-")), "ledger");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const seenAt = new Date("2026-08-27T09:00:00.000Z");

function batch(overrides: Partial<SourceBatch> = {}): SourceBatch {
  return { snapshots: [], events: [], warnings: [], ...overrides };
}

const ticket = {
  id: "TEAM-1234",
  firstSeenAt: "2026-08-10T09:00:00.000Z",
  payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
};

describe("ledgerRoot", () => {
  it("honours XDG_CACHE_HOME", () => {
    expect(ledgerRoot({ XDG_CACHE_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/worklog/ledger");
  });

  it("falls back to ~/.cache when it is unset or blank", () => {
    expect(ledgerRoot({})).toMatch(/\/\.cache\/worklog\/ledger$/);
    expect(ledgerRoot({ XDG_CACHE_HOME: "  " })).toMatch(/\/\.cache\/worklog\/ledger$/);
  });

  it("is not inside the vault", () => {
    expect(ledgerRoot({ XDG_CACHE_HOME: "/tmp/xdg" })).not.toContain("Obsidian");
  });
});

describe("an empty ledger", () => {
  it("opens on a directory that does not exist", async () => {
    const ledger = await openLedger(root);
    expect(ledger.weeks()).toEqual([]);
    expect(ledger.watermarkFor("jira", "2026-W35")).toBeUndefined();
    expect(ledger.hasWindow("jira", "2026-W35")).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("writes nothing when nothing was recorded", async () => {
    const ledger = await openLedger(root);
    await ledger.save();
    expect(existsSync(root)).toBe(false);
  });
});

describe("filing events by their own timestamp", () => {
  it("puts a comment in the week it was written, not the week of its ticket", async () => {
    const ledger = await openLedger(root);

    ledger.record("jira", batch({
      snapshots: [ticket],
      events: [
        { source: "jira", kind: "created", itemId: "TEAM-1234", at: "2026-08-10T09:00:00.000Z", payload: {} },
        // Three weeks after the ticket was opened.
        { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: { text: "still flaky" }, id: "c-1" },
      ],
    }), seenAt);

    expect(ledger.eventsForWeek("2026-W33").map((event) => event.kind)).toEqual(["created"]);
    expect(ledger.eventsForWeek("2026-W36").map((event) => event.kind)).toEqual(["comment"]);
    expect(ledger.weeks()).toEqual(["2026-W33", "2026-W36"]);
  });

  it("reports which weeks changed, so only those are regenerated", async () => {
    const ledger = await openLedger(root);

    const result = ledger.record("jira", batch({
      events: [
        { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" },
        { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-09-01T11:00:00.000Z", payload: {}, id: "c-2" },
      ],
    }), seenAt);

    expect(result.addedEvents).toBe(2);
    expect([...result.perWeek.keys()]).toEqual(["2026-W36"]);
    expect(result.perWeek.get("2026-W36")).toBe(2);
  });
});

describe("recording the same thing twice", () => {
  it("adds nothing the second time", async () => {
    const ledger = await openLedger(root);
    const twice = batch({
      snapshots: [ticket],
      events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" }],
    });

    const first = ledger.record("jira", twice, seenAt);
    const second = ledger.record("jira", twice, seenAt);

    expect(first).toMatchObject({ addedEvents: 1, addedSnapshots: 1 });
    expect(second).toMatchObject({ addedEvents: 0, addedSnapshots: 0 });
    expect(second.perWeek.size).toBe(0);
  });

  it("matches on the system's own id even when the payload was reworded", async () => {
    const ledger = await openLedger(root);
    const at = "2026-08-31T11:00:00.000Z";

    ledger.record("jira", batch({ events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at, payload: { text: "one" }, id: "c-1" }] }), seenAt);
    const again = ledger.record("jira", batch({ events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at, payload: { text: "one, edited" }, id: "c-1" }] }), seenAt);

    expect(again.addedEvents).toBe(0);
    expect(ledger.eventsForWeek("2026-W36")).toHaveLength(1);
  });

  it("falls back to what identifies an occurrence when there is no id", async () => {
    const ledger = await openLedger(root);
    const event = { source: "jira", kind: "status", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: { from: "Open", to: "Done" } };

    ledger.record("jira", batch({ events: [event] }), seenAt);
    const again = ledger.record("jira", batch({ events: [event] }), seenAt);

    expect(again.addedEvents).toBe(0);
  });

  it("never rewrites a snapshot it already holds", async () => {
    const ledger = await openLedger(root);

    ledger.record("jira", batch({ snapshots: [ticket] }), seenAt);
    ledger.record("jira", batch({
      snapshots: [{ ...ticket, firstSeenAt: "2026-09-01T09:00:00.000Z", payload: { title: "Renamed later", url: ticket.payload.url } }],
    }), seenAt);

    const stored = ledger.snapshot("jira", "TEAM-1234");
    expect(stored?.firstSeenAt).toBe("2026-08-10T09:00:00.000Z");
    expect(renderable(stored?.payload).title).toBe("Search Revamp indexer");
  });
});

describe("what is written to disk", () => {
  it("keeps events per week, snapshots per source, and the watermarks together", async () => {
    const ledger = await openLedger(root);
    ledger.record("jira", batch({
      snapshots: [ticket],
      events: [{ source: "jira", kind: "created", itemId: "TEAM-1234", at: "2026-08-10T09:00:00.000Z", payload: {} }],
    }), seenAt);
    ledger.markWindow("jira", "2026-W33");
    ledger.setWatermark("jira", "2026-W33", seenAt);
    await ledger.save();

    expect(await readdir(join(root, "events"))).toEqual(["2026-W33.json"]);
    expect(await readdir(join(root, "snapshots"))).toEqual(["jira.json"]);

    const meta = JSON.parse(await readFile(join(root, "meta.json"), "utf-8"));
    expect(meta).toMatchObject({
      version: 2,
      sources: { jira: { windows: { "2026-W33": seenAt.toISOString() } } },
      written: {},
    });
    // Recorded but not yet written into the vault, which is what makes it pending.
    expect(ledger.pendingWeeks()).toEqual(["2026-W33"]);

    // Readable by a person, which is half the reason it is JSON on disk.
    expect(await readFile(join(root, "events", "2026-W33.json"), "utf-8")).toContain('\n  {\n    "source": "jira"');
  });

  it("reads back what it wrote", async () => {
    const first = await openLedger(root);
    first.record("jira", batch({
      snapshots: [ticket],
      events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" }],
    }), seenAt);
    first.setWatermark("jira", "2026-W36", seenAt);
    first.stateFor("github").set("etag:pr-1", "W/\"abc\"");
    await first.save();

    const second = await openLedger(root);
    expect(second.eventsForWeek("2026-W36")).toHaveLength(1);
    expect(second.snapshot("jira", "TEAM-1234")?.id).toBe("TEAM-1234");
    expect(second.knownItemIds("jira")).toEqual(["TEAM-1234"]);
    expect(second.watermarkFor("jira", "2026-W36")?.toISOString()).toBe(seenAt.toISOString());
    expect(second.stateFor("github").get("etag:pr-1")).toBe("W/\"abc\"");
  });

  it("leaves every file untouched when a second run finds nothing new", async () => {
    const events = batch({
      snapshots: [ticket],
      events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" }],
    });

    const first = await openLedger(root);
    first.record("jira", events, seenAt);
    first.setWatermark("jira", "2026-W36", seenAt);
    first.markWritten("2026-W36");
    await first.save();

    const before = await Promise.all(
      ["meta.json", "events/2026-W36.json", "snapshots/jira.json"].map((file) => readFile(join(root, file), "utf-8")),
    );

    const second = await openLedger(root);
    second.record("jira", events, seenAt);
    second.setWatermark("jira", "2026-W36", seenAt);
    await second.save();

    const after = await Promise.all(
      ["meta.json", "events/2026-W36.json", "snapshots/jira.json"].map((file) => readFile(join(root, file), "utf-8")),
    );
    expect(after).toEqual(before);
  });

  it("survives a file left empty by an interrupted write", async () => {
    const first = await openLedger(root);
    first.record("jira", batch({ events: [{ source: "jira", kind: "created", itemId: "TEAM-1234", at: "2026-08-10T09:00:00.000Z", payload: {} }] }), seenAt);
    await first.save();
    await writeFile(join(root, "events", "2026-W33.json"), "", "utf-8");

    const second = await openLedger(root);
    expect(second.eventsForWeek("2026-W33")).toEqual([]);
  });
});

describe("reading a week back", () => {
  it("groups a week's events by the item they happened to, in time order", async () => {
    const ledger = await openLedger(root);
    ledger.record("jira", batch({
      events: [
        { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T15:00:00.000Z", payload: {}, id: "c-2" },
        { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" },
        { source: "jira", kind: "status", itemId: "TEAM-1235", at: "2026-08-31T12:00:00.000Z", payload: {} },
      ],
    }), seenAt);

    const byItem = eventsByItem(ledger.eventsForWeek("2026-W36"));
    expect([...byItem.keys()]).toEqual(["TEAM-1234", "TEAM-1235"]);
    expect(byItem.get("TEAM-1234")?.map((event) => event.id)).toEqual(["c-1", "c-2"]);
  });
});

describe("collecting into the ledger", () => {
  const week = (weekId: string, start: string, end: string) => ({
    weekId,
    window: { start: new Date(`${start}T00:00:00.000Z`), end: new Date(`${end}T23:59:59.999Z`) },
  });

  function fakeSource(name: string, calls: string[], batches: Partial<Record<"window" | "since", SourceBatch>> = {}): Source {
    return {
      name,
      isAvailable: async () => ({ ok: true }),
      fetchWindow: async (window) => {
        calls.push(`${name}:window:${window.start.toISOString().split("T")[0]}`);
        return batches.window ?? { snapshots: [], events: [], warnings: [] };
      },
      fetchSince: async (since, itemIds) => {
        calls.push(`${name}:since:${since.toISOString()}:${itemIds.join(",")}`);
        return batches.since ?? { snapshots: [], events: [], warnings: [] };
      },
    };
  }

  const ctxFor = (): SourceContext => ({
    // SAFETY: these fake sources read nothing from config; a real one is handed a real
    // config by the command, and this test is about the ledger, not about them.
    config: {} as SourceContext["config"],
    headers: { atlassian: {}, github: {} },
    identity: { atlassianAccountId: "acc-1", githubUsername: "example-user" },
    onWarning: () => {},
    state: { get: () => undefined, set: () => {} },
    log: () => {},
  });

  const now = new Date("2026-09-07T10:00:00.000Z");

  it("windows a week it has never read, and only asks for deltas after that", async () => {
    const calls: string[] = [];
    const ledger = await openLedger(root);
    const weeks = [week("2026-W36", "2026-08-31", "2026-09-06")];

    await collectIntoLedger(ledger, [fakeSource("jira", calls)], weeks, ctxFor, now);
    expect(calls).toEqual(["jira:window:2026-08-31"]);

    // Second pass: the window is on record, so only the delta question is asked.
    calls.length = 0;
    await collectIntoLedger(ledger, [fakeSource("jira", calls)], weeks, ctxFor, new Date("2026-09-08T10:00:00.000Z"));
    expect(calls).toEqual([`jira:since:${now.toISOString()}:`]);
  });

  it("asks the delta about the items that week actually touched", async () => {
    const calls: string[] = [];
    const ledger = await openLedger(root);
    const weeks = [week("2026-W36", "2026-08-31", "2026-09-06")];

    const withItems = fakeSource("jira", calls, {
      window: {
        snapshots: [{ id: "TEAM-1234", firstSeenAt: now.toISOString(), payload: { title: "t", url: "u" } }],
        events: [{ source: "jira", kind: "created", itemId: "TEAM-1234", at: "2026-09-01T09:00:00.000Z", payload: {} }],
        warnings: [],
      },
    });
    await collectIntoLedger(ledger, [withItems], weeks, ctxFor, now);

    calls.length = 0;
    await collectIntoLedger(ledger, [fakeSource("jira", calls)], weeks, ctxFor, now);
    expect(calls).toEqual([`jira:since:${now.toISOString()}:TEAM-1234`]);
  });

  it("reports the weeks whose events changed and nothing else", async () => {
    const ledger = await openLedger(root);
    const weeks = [week("2026-W36", "2026-08-31", "2026-09-06")];

    const source = fakeSource("jira", [], {
      window: {
        snapshots: [],
        events: [
          { source: "jira", kind: "created", itemId: "TEAM-1234", at: "2026-09-01T09:00:00.000Z", payload: {} },
          // Dated three weeks earlier: it amends that week, not this one.
          { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-11T09:00:00.000Z", payload: {}, id: "c-1" },
        ],
        warnings: [],
      },
    });

    const outcome = await collectIntoLedger(ledger, [source], weeks, ctxFor, now);

    expect([...outcome.weeksChanged].sort()).toEqual(["2026-W33", "2026-W36"]);
    expect(outcome.perSource.get("jira")).toMatchObject({ addedEvents: 2 });
  });

  it("finds nothing on a second run over the same answers", async () => {
    const ledger = await openLedger(root);
    const weeks = [week("2026-W36", "2026-08-31", "2026-09-06")];
    const events = [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-09-01T09:00:00.000Z", payload: {}, id: "c-1" }];

    await collectIntoLedger(ledger, [fakeSource("jira", [], { window: { snapshots: [], events, warnings: [] } })], weeks, ctxFor, now);
    const second = await collectIntoLedger(
      ledger,
      [fakeSource("jira", [], { since: { snapshots: [], events, warnings: [] } })],
      weeks,
      ctxFor,
      now,
    );

    expect(second.weeksChanged.size).toBe(0);
    expect(second.perSource.get("jira")).toMatchObject({ addedEvents: 0 });
  });

  it("says why a source could not run, and asks it nothing", async () => {
    const calls: string[] = [];
    const ledger = await openLedger(root);
    const unavailable: Source = {
      ...fakeSource("slack", calls),
      isAvailable: async () => ({ ok: false, reason: "no Slack token configured" }),
    };

    const outcome = await collectIntoLedger(ledger, [unavailable], [week("2026-W36", "2026-08-31", "2026-09-06")], ctxFor, now);

    expect(outcome.perSource.get("slack")?.unavailable).toBe("no Slack token configured");
    expect(calls).toEqual([]);
  });

  it("carries a source's soft failures out to the caller", async () => {
    const ledger = await openLedger(root);
    const noisy = fakeSource("github", [], {
      window: { snapshots: [], events: [], warnings: ["Could not read reviews for example-org/repo#1"] },
    });

    const outcome = await collectIntoLedger(ledger, [noisy], [week("2026-W36", "2026-08-31", "2026-09-06")], ctxFor, now);

    expect(outcome.warnings).toEqual(["Could not read reviews for example-org/repo#1"]);
  });
});

describe("the window a source is asked about", () => {
  it("runs to the end of Sunday, not its first instant", () => {
    // getWeekEnd gives Sunday at midnight, which is the start of the last day. A source
    // comparing timestamps against that would drop everything that happened on Sunday.
    const week = weekWindow("2026-W36", new Date("2026-08-31T00:00:00.000Z"), new Date("2026-09-06T00:00:00.000Z"));

    expect(week.window.end.toISOString()).toBe("2026-09-06T23:59:59.999Z");
    const sundayEvening = new Date("2026-09-06T18:00:00.000Z");
    expect(sundayEvening >= week.window.start && sundayEvening <= week.window.end).toBe(true);
  });

  it("leaves the start of the week alone", () => {
    const week = weekWindow("2026-W36", new Date("2026-08-31T00:00:00.000Z"), new Date("2026-09-06T00:00:00.000Z"));
    expect(week.window.start.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });
});

describe("what a run added", () => {
  const comment = {
    source: "jira", kind: "comment", itemId: "TEAM-1234",
    at: "2026-09-01T09:00:00.000Z", payload: { text: "one" }, id: "c-1",
  };
  const status = {
    source: "jira", kind: "status", itemId: "TEAM-1234",
    at: "2026-09-03T09:00:00.000Z", payload: { from: "In Progress", to: "Done" },
  };

  it("is only what was not there before", () => {
    expect(newEvents([comment], [comment, status])).toEqual([status]);
  });

  it("is nothing when the same events came back", () => {
    expect(newEvents([comment, status], [comment, status])).toEqual([]);
  });

  it("matches on the system's own id, so a reworded comment is not new", () => {
    const reworded = { ...comment, payload: { text: "one, edited" } };
    expect(newEvents([comment], [reworded])).toEqual([]);
  });

  it("is everything when the week was empty", () => {
    expect(newEvents([], [comment, status])).toEqual([comment, status]);
  });
});

describe("a refresh that asks about one week", () => {
  const week = (weekId: string, start: string, end: string) => ({
    weekId,
    window: { start: new Date(`${start}T00:00:00.000Z`), end: new Date(`${end}T23:59:59.999Z`) },
  });

  const ctx = (): SourceContext => ({
    // SAFETY: this fake source reads nothing from config; a real one is handed a real
    // config by the command, and this test is about the ledger, not about it.
    config: {} as SourceContext["config"],
  });

  /** Remembers every `since` it was asked for, and answers with nothing. */
  function recorder(name: string, asked: string[]): Source {
    return {
      name,
      isAvailable: async () => ({ ok: true }),
      fetchWindow: async () => ({ snapshots: [], events: [], warnings: [] }),
      fetchSince: async (since) => {
        asked.push(since.toISOString());
        return { snapshots: [], events: [], warnings: [] };
      },
    };
  }

  it("does not claim to have read on behalf of the weeks it left alone", async () => {
    // The trigger: August's week is read up to 1 August. On 27 August a refresh of the
    // current week only. If that advanced one watermark for the whole source, the next
    // refresh of August would ask for changes after 27 August and never see the comment
    // somebody left on an August ticket on the 10th.
    const august = week("2026-W33", "2026-08-10", "2026-08-16");
    const current = week("2026-W35", "2026-08-24", "2026-08-30");
    const asked: string[] = [];

    const first = await openLedger(root);
    first.markWindow("jira", august.weekId);
    first.setWatermark("jira", august.weekId, new Date("2026-08-01T00:00:00.000Z"));
    first.markWindow("jira", current.weekId);
    first.setWatermark("jira", current.weekId, new Date("2026-08-24T00:00:00.000Z"));
    await first.save();

    const scoped = await openLedger(root);
    await collectIntoLedger(scoped, [recorder("jira", asked)], [current], ctx, new Date("2026-08-27T09:00:00.000Z"));
    await scoped.save();

    const later = await openLedger(root);
    expect(later.watermarkFor("jira", august.weekId)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");

    await collectIntoLedger(later, [recorder("jira", asked)], [august], ctx, new Date("2026-08-28T09:00:00.000Z"));
    expect(asked).toEqual(["2026-08-24T00:00:00.000Z", "2026-08-01T00:00:00.000Z"]);
  });

  it("asks from the earliest of the weeks it was given, so one query covers them all", async () => {
    const asked: string[] = [];
    const ledger = await openLedger(root);
    ledger.markWindow("jira", "2026-W33");
    ledger.setWatermark("jira", "2026-W33", new Date("2026-08-01T00:00:00.000Z"));
    ledger.markWindow("jira", "2026-W35");
    ledger.setWatermark("jira", "2026-W35", new Date("2026-08-24T00:00:00.000Z"));

    await collectIntoLedger(
      ledger,
      [recorder("jira", asked)],
      [week("2026-W33", "2026-08-10", "2026-08-16"), week("2026-W35", "2026-08-24", "2026-08-30")],
      ctx,
      new Date("2026-08-27T09:00:00.000Z"),
    );

    expect(asked).toEqual(["2026-08-01T00:00:00.000Z"]);
  });

  it("writes nothing at all when two runs an hour apart both find nothing", async () => {
    // The trigger for a watermark that moved to the clock: no AI call, no vault write,
    // and yet meta.json changed, every single run.
    const weeks = [week("2026-W36", "2026-08-31", "2026-09-06")];
    const event = { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-09-01T09:00:00.000Z", payload: {}, id: "c-1" };
    const answering = (): Source => ({
      name: "jira",
      isAvailable: async () => ({ ok: true }),
      fetchWindow: async () => ({ snapshots: [], events: [event], warnings: [] }),
      fetchSince: async () => ({ snapshots: [], events: [event], warnings: [] }),
    });

    const first = await openLedger(root);
    await collectIntoLedger(first, [answering()], weeks, ctx, new Date("2026-09-07T10:00:00.000Z"));
    first.markWritten("2026-W36");
    await first.save();

    const second = await openLedger(root);
    await collectIntoLedger(second, [answering()], weeks, ctx, new Date("2026-09-07T11:00:00.000Z"));
    await second.save();
    const afterSecond = await readFile(join(root, "meta.json"), "utf-8");

    const third = await openLedger(root);
    await collectIntoLedger(third, [answering()], weeks, ctx, new Date("2026-09-07T12:00:00.000Z"));
    await third.save();

    expect(await readFile(join(root, "meta.json"), "utf-8")).toBe(afterSecond);
  });
});

describe("a source with a name that is really a path", () => {
  const traversal = "../../victim";

  it("is not a name this ledger accepts", () => {
    expect(isSafeSourceName("jira")).toBe(true);
    expect(isSafeSourceName("slack-messages")).toBe(true);
    expect(isSafeSourceName(traversal)).toBe(false);
    expect(isSafeSourceName("Jira")).toBe(false);
  });

  it("records nothing, says so, and writes no file outside the ledger", async () => {
    const ledger = await openLedger(root);
    const result = ledger.record(traversal, {
      snapshots: [{ id: "x", firstSeenAt: "2026-08-10T09:00:00.000Z", payload: {} }],
      events: [{ source: traversal, kind: "created", itemId: "x", at: "2026-08-10T09:00:00.000Z", payload: {} }],
      warnings: [],
    }, seenAt);
    await ledger.save();

    expect(result).toMatchObject({ addedEvents: 0, addedSnapshots: 0 });
    expect(ledger.problems()[0]).toContain(traversal);
    expect(existsSync(root)).toBe(false);
  });
});

describe("a ledger file this version cannot read", () => {
  const good = { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" };

  async function seedWithCorruptRow(): Promise<string> {
    const ledger = await openLedger(root);
    ledger.record("jira", batch({ events: [good] }), seenAt);
    await ledger.save();

    const path = join(root, "events", "2026-W36.json");
    await writeFile(path, JSON.stringify([good, { source: "jira", kind: 7 }], null, 2), "utf-8");
    return path;
  }

  it("says which file and which row, and leaves the file exactly as it is", async () => {
    const path = await seedWithCorruptRow();
    const before = await readFile(path, "utf-8");

    const ledger = await openLedger(root);
    expect(ledger.problems()[0]).toContain("2026-W36.json");
    expect(ledger.problems()[0]).toContain("row 1");

    // The run carries on with what it could read, and files a new event into that week.
    ledger.record("jira", batch({
      events: [{ source: "jira", kind: "status", itemId: "TEAM-1234", at: "2026-09-02T09:00:00.000Z", payload: {} }],
    }), seenAt);
    await ledger.save();

    expect(await readFile(path, "utf-8")).toBe(before);
    // In memory the week is complete enough to write a work log from.
    expect(ledger.eventsForWeek("2026-W36").map((event) => event.kind)).toEqual(["comment", "status"]);
  });
});

describe("a clock that runs fast somewhere else", () => {
  const week = (weekId: string, start: string, end: string) => ({
    weekId,
    window: { start: new Date(`${start}T00:00:00.000Z`), end: new Date(`${end}T23:59:59.999Z`) },
  });

  const ctx = (): SourceContext => ({
    // SAFETY: this fake source reads nothing from config; a real one is handed a real
    // config by the command, and this test is about the ledger, not about it.
    config: {} as SourceContext["config"],
  });

  it("does not let a future-dated event carry the watermark past the moment we asked", async () => {
    // The trigger: a delta answers with an item stamped a week into the future. Trusting
    // it moves the reading position there, and everything committed in between is never
    // asked for again.
    const asked: string[] = [];
    const weeks = [week("2026-W36", "2026-08-31", "2026-09-06")];
    const firstRun = new Date("2026-09-07T10:00:00.000Z");
    const secondRun = new Date("2026-09-07T11:00:00.000Z");
    const fromTheFuture = {
      source: "jira", kind: "comment", itemId: "TEAM-1234",
      at: "2026-09-14T09:00:00.000Z", payload: {}, id: "c-skewed",
    };

    const source = (deltaEvents: typeof fromTheFuture[]): Source => ({
      name: "jira",
      isAvailable: async () => ({ ok: true }),
      fetchWindow: async () => ({ snapshots: [], events: [], warnings: [] }),
      fetchSince: async (since) => {
        asked.push(since.toISOString());
        return { snapshots: [], events: deltaEvents, warnings: [] };
      },
    });

    // Run one windows the week and reads it up to when it asked.
    const first = await openLedger(root);
    await collectIntoLedger(first, [source([])], weeks, ctx, firstRun);
    await first.save();

    // Run two's delta brings back the skewed event.
    const second = await openLedger(root);
    await collectIntoLedger(second, [source([fromTheFuture])], weeks, ctx, secondRun);
    await second.save();

    const third = await openLedger(root);
    expect(third.watermarkFor("jira", "2026-W36")?.toISOString()).toBe(secondRun.toISOString());

    await collectIntoLedger(third, [source([])], weeks, ctx, new Date("2026-09-07T12:00:00.000Z"));

    // The third run asks from when the second one ran, not from next week.
    expect(asked).toEqual([firstRun.toISOString(), secondRun.toISOString()]);
  });
});

describe("a cache written by the previous version", () => {
  it("keeps its collected weeks but not the watermark that was never about them", async () => {
    // The trigger: version 1 kept one reading position for a whole source, advanced by
    // whichever week was refreshed last. Copying it into every week would claim that a
    // week nobody checked had been checked.
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "meta.json"), JSON.stringify({
      version: 1,
      sources: { jira: { fetchedAt: "2026-08-27T09:00:00.000Z", windows: ["2026-W33", "2026-W35"], state: { "etag:x": "abc" } } },
    }), "utf-8");

    const ledger = await openLedger(root);

    // The expensive window fetches are not repeated.
    expect(ledger.hasWindow("jira", "2026-W33")).toBe(true);
    expect(ledger.hasWindow("jira", "2026-W35")).toBe(true);
    // But neither week claims to have been read to any particular point.
    expect(ledger.watermarkFor("jira", "2026-W33")).toBeUndefined();
    expect(ledger.watermarkFor("jira", "2026-W35")).toBeUndefined();
    // The source's own state survives; it was never week-specific.
    expect(ledger.stateFor("jira").get("etag:x")).toBe("abc");
    expect(ledger.notices()[0]).toContain("older version");
  });
});

describe("a ledger file that is not JSON at all", () => {
  it("is reported, bars its week from being written, and is left alone", async () => {
    const ledger = await openLedger(root);
    ledger.record("jira", batch({
      events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" }],
    }), seenAt);
    await ledger.save();

    const path = join(root, "events", "2026-W36.json");
    await writeFile(path, "{ this is not json", "utf-8");
    const before = await readFile(path, "utf-8");

    const reopened = await openLedger(root);

    expect(reopened.problems()[0]).toContain("not valid JSON");
    expect(reopened.unreadableWeeks()).toEqual(["2026-W36"]);

    reopened.record("jira", batch({
      events: [{ source: "jira", kind: "status", itemId: "TEAM-1234", at: "2026-09-02T09:00:00.000Z", payload: {} }],
    }), seenAt);
    await reopened.save();

    expect(await readFile(path, "utf-8")).toBe(before);
  });
});

describe("what a week's work log has already been told", () => {
  const comment = { source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" };
  const status = { source: "jira", kind: "status", itemId: "TEAM-1234", at: "2026-09-02T09:00:00.000Z", payload: {} };

  it("is everything when the week has never been written", async () => {
    const ledger = await openLedger(root);
    ledger.record("jira", batch({ events: [comment, status] }), seenAt);

    expect(ledger.unwrittenEvents("2026-W36")).toHaveLength(2);
    expect(ledger.pendingWeeks()).toEqual(["2026-W36"]);
  });

  it("is nothing straight after a write, and the new event after that", async () => {
    const ledger = await openLedger(root);
    ledger.record("jira", batch({ events: [comment] }), seenAt);
    ledger.markWritten("2026-W36");

    expect(ledger.unwrittenEvents("2026-W36")).toEqual([]);
    expect(ledger.pendingWeeks()).toEqual([]);

    ledger.record("jira", batch({ events: [status] }), seenAt);
    expect(ledger.unwrittenEvents("2026-W36").map((event) => event.kind)).toEqual(["status"]);
  });

  it("survives being reopened, so a week written days ago is not told twice", async () => {
    const first = await openLedger(root);
    first.record("jira", batch({ events: [comment] }), seenAt);
    first.markWritten("2026-W36");
    await first.save();

    const second = await openLedger(root);
    second.record("jira", batch({ events: [status] }), seenAt);
    expect(second.unwrittenEvents("2026-W36").map((event) => event.kind)).toEqual(["status"]);
  });
});

describe("the guard on where a file may be written", () => {
  it("accepts an ordinary name on either platform's path rules", () => {
    expect(insidePath(posix, "/home/me/.cache/worklog/ledger/events", "2026-W36"))
      .toBe("/home/me/.cache/worklog/ledger/events/2026-W36.json");
    // The trigger: `join` on Windows gives backslashes, so a guard that looked for
    // "dir/" refused every legitimate write — silently, while the run went on believing
    // it had saved them and the watermark moved.
    expect(insidePath(win32, "C:\\cache\\worklog\\ledger\\events", "2026-W36"))
      .toBe("C:\\cache\\worklog\\ledger\\events\\2026-W36.json");
  });

  it("refuses a name that climbs out, on either platform's path rules", () => {
    expect(insidePath(posix, "/home/me/.cache/worklog/ledger/snapshots", "../../victim")).toBeUndefined();
    expect(insidePath(win32, "C:\\cache\\worklog\\ledger\\snapshots", "..\\..\\victim")).toBeUndefined();
    expect(insidePath(win32, "C:\\cache\\worklog\\ledger\\snapshots", "../../victim")).toBeUndefined();
  });

  it("keeps an absolute-looking name underneath the directory rather than obeying it", () => {
    // `join` treats a leading separator on the second argument as relative, so this
    // stays inside. Containment holds; it is `isSafeSourceName` that refuses the name
    // for being a path at all.
    expect(insidePath(posix, "/home/me/ledger/snapshots", "/etc/passwd"))
      .toBe("/home/me/ledger/snapshots/etc/passwd.json");
    expect(isSafeSourceName("/etc/passwd")).toBe(false);
    expect(isSafeSourceName("../../victim")).toBe(false);
  });
});
