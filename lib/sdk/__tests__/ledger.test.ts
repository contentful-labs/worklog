import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openLedger, ledgerRoot, eventsByItem, newEvents, renderable, collectIntoLedger, weekWindow,
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
      pendingWeeks: ["2026-W33"],
    });

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
