import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openLedger, ledgerRoot, eventsByItem, payloadString } from "../ledger";
import type { SourceBatch } from "../sources";

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
    expect(ledgerRoot({ XDG_CACHE_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv)).toBe("/tmp/xdg/worklog/ledger");
  });

  it("falls back to ~/.cache when it is unset or blank", () => {
    expect(ledgerRoot({} as NodeJS.ProcessEnv)).toMatch(/\/\.cache\/worklog\/ledger$/);
    expect(ledgerRoot({ XDG_CACHE_HOME: "  " } as NodeJS.ProcessEnv)).toMatch(/\/\.cache\/worklog\/ledger$/);
  });

  it("is not inside the vault", () => {
    expect(ledgerRoot({ XDG_CACHE_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv)).not.toContain("Obsidian");
  });
});

describe("an empty ledger", () => {
  it("opens on a directory that does not exist", async () => {
    const ledger = await openLedger(root);
    expect(ledger.weeks()).toEqual([]);
    expect(ledger.watermark("jira")).toBeUndefined();
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
    expect(result.weeksChanged).toEqual(["2026-W36"]);
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
    expect(second).toMatchObject({ addedEvents: 0, addedSnapshots: 0, weeksChanged: [] });
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
    expect(payloadString(stored?.payload ?? {}, "title")).toBe("Search Revamp indexer");
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
    ledger.setWatermark("jira", seenAt);
    await ledger.save();

    expect(await readdir(join(root, "events"))).toEqual(["2026-W33.json"]);
    expect(await readdir(join(root, "snapshots"))).toEqual(["jira.json"]);

    const meta = JSON.parse(await readFile(join(root, "meta.json"), "utf-8"));
    expect(meta).toMatchObject({ version: 1, sources: { jira: { fetchedAt: seenAt.toISOString(), windows: ["2026-W33"] } } });

    // Readable by a person, which is half the reason it is JSON on disk.
    expect(await readFile(join(root, "events", "2026-W33.json"), "utf-8")).toContain('\n  {\n    "source": "jira"');
  });

  it("reads back what it wrote", async () => {
    const first = await openLedger(root);
    first.record("jira", batch({
      snapshots: [ticket],
      events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" }],
    }), seenAt);
    first.setWatermark("jira", seenAt);
    first.stateFor("github").set("etag:pr-1", "W/\"abc\"");
    await first.save();

    const second = await openLedger(root);
    expect(second.eventsForWeek("2026-W36")).toHaveLength(1);
    expect(second.snapshot("jira", "TEAM-1234")?.id).toBe("TEAM-1234");
    expect(second.knownItemIds("jira")).toEqual(["TEAM-1234"]);
    expect(second.watermark("jira")?.toISOString()).toBe(seenAt.toISOString());
    expect(second.stateFor("github").get("etag:pr-1")).toBe("W/\"abc\"");
  });

  it("leaves every file untouched when a second run finds nothing new", async () => {
    const events = batch({
      snapshots: [ticket],
      events: [{ source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z", payload: {}, id: "c-1" }],
    });

    const first = await openLedger(root);
    first.record("jira", events, seenAt);
    first.setWatermark("jira", seenAt);
    await first.save();

    const before = await Promise.all(
      ["meta.json", "events/2026-W36.json", "snapshots/jira.json"].map((file) => readFile(join(root, file), "utf-8")),
    );

    const second = await openLedger(root);
    second.record("jira", events, seenAt);
    second.setWatermark("jira", seenAt);
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
