/**
 * The event ledger: what we have seen, when we saw it, and when it happened.
 *
 * Everything here serves one rule. State is kept as it was when first fetched, changes
 * are recorded on the date they happened, and a past week can be amended with events
 * that always belonged to it but is never rewritten because of something later. So the
 * ledger stores two different kinds of thing and treats them differently:
 *
 * - **Snapshots** are written once per item and never again. They are what a week is
 *   entitled to show about an item: how it looked when it arrived.
 * - **Events** are append-only and each carries its own timestamp. A week is exactly
 *   the events whose timestamps fall inside it, which is why a comment written in
 *   September belongs to September's week even though it hangs off an August ticket.
 *
 * Nothing here rewrites either. Recording is idempotent: re-fetching a week finds the
 * same events, matches them, and writes nothing at all. That property is what lets
 * `refresh` decide which weeks actually changed, and it is why the files are only
 * written when their contents differ.
 *
 * It lives in the cache directory, not the vault: it is refetchable data, it is large,
 * and the vault is synced to iCloud and indexed by Obsidian.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  JsonObject, Source, SourceBatch, SourceContext, SourceEvent, SourceSnapshot, SourceState, SourceWindow,
} from "./sources";
import { weekIdForDate } from "./week-utils";

/** The ledger format on disk. Bumped only when an older layout can no longer be read. */
const LEDGER_VERSION = 1;

/**
 * Where the ledger lives.
 *
 * `XDG_CACHE_HOME` when the user has set it, `~/.cache` otherwise. Not the vault, which
 * syncs to iCloud and is indexed by Obsidian, and not a dotfile directory, which is for
 * things that cannot be fetched again.
 */
export function ledgerRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim();
  return join(base && base.length > 0 ? base : join(homedir(), ".cache"), "worklog", "ledger");
}

interface SourceMeta {
  /** How far this source has been read up to. Its deltas start here next time. */
  fetchedAt?: string;
  /** Weeks this source has done a first, whole-window fetch for. */
  windows: string[];
  /** ETags, cursors: opaque to everything but the source that wrote it. */
  state: Record<string, string>;
}

interface LedgerMeta {
  version: number;
  sources: Record<string, SourceMeta>;
}

/** What one call to `record` changed. */
export interface RecordResult {
  addedEvents: number;
  addedSnapshots: number;
  /** Weeks whose event set is not what it was. These, and only these, need regenerating. */
  weeksChanged: string[];
  /** Events added per week, for the summary the user reads. */
  perWeek: Map<string, number>;
}

/** An item as first seen, with the source that saw it. */
export interface LedgerSnapshot extends SourceSnapshot {
  source: string;
}

function emptyMeta(): LedgerMeta {
  return { version: LEDGER_VERSION, sources: {} };
}

function sourceMeta(meta: LedgerMeta, source: string): SourceMeta {
  const existing = meta.sources[source];
  if (existing) return existing;
  const created: SourceMeta = { windows: [], state: {} };
  meta.sources[source] = created;
  return created;
}

/**
 * What makes two events the same event.
 *
 * The system's own id when it gave us one, since that is the only thing that survives
 * a payload being reworded. Otherwise the four things that identify an occurrence, so
 * a re-fetch of the same week matches rather than duplicates.
 */
function eventKey(event: SourceEvent): string {
  return event.id ? `${event.source}|${event.id}` : `${event.source}|${event.kind}|${event.itemId}|${event.at}`;
}

/** Events in file order: by time, then by key, so a rewrite is byte-stable. */
function compareEvents(a: SourceEvent, b: SourceEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  const left = eventKey(a);
  const right = eventKey(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, "utf-8");
  return raw.trim().length === 0 ? fallback : (JSON.parse(raw) as T);
}

/** Write through a temp file so an interrupted run cannot leave half a ledger behind. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(temp, path);
}

export interface Ledger {
  /** Every event filed under this week, in time order. */
  eventsForWeek(weekId: string): SourceEvent[];
  /** Weeks the ledger holds any event for, oldest first. */
  weeks(): string[];
  /** The item as first seen, or undefined if this ledger has never seen it. */
  snapshot(source: string, id: string): LedgerSnapshot | undefined;
  /** Ids this source has snapshots for, which is the item set a delta fetch asks about. */
  knownItemIds(source: string): string[];
  /** How far this source has been read, or undefined if it never has. */
  watermark(source: string): Date | undefined;
  /** Whether this source has done its first whole-window fetch for a week. */
  hasWindow(source: string, weekId: string): boolean;
  /** This source's own persisted state. Writes are kept until `save`. */
  stateFor(source: string): SourceState;

  /** File a batch. Returns what actually changed, which is nothing on a repeat. */
  record(source: string, batch: SourceBatch, seenAt: Date): RecordResult;
  markWindow(source: string, weekId: string): void;
  setWatermark(source: string, at: Date): void;

  /** Persist whatever changed, and nothing that did not. */
  save(): Promise<void>;
}

/**
 * Open the ledger, reading only what is there.
 *
 * A missing directory is an empty ledger rather than an error: the first run of a new
 * install has nothing cached, which is not a problem to report.
 */
export async function openLedger(root: string = ledgerRoot()): Promise<Ledger> {
  const eventsDir = join(root, "events");
  const snapshotsDir = join(root, "snapshots");

  const meta = await readJson<LedgerMeta>(join(root, "meta.json"), emptyMeta());
  meta.sources ??= {};

  const weekFiles = existsSync(eventsDir) ? await readdir(eventsDir) : [];
  const events = new Map<string, SourceEvent[]>();
  for (const file of weekFiles) {
    if (!file.endsWith(".json")) continue;
    events.set(file.slice(0, -".json".length), await readJson<SourceEvent[]>(join(eventsDir, file), []));
  }

  const snapshotFiles = existsSync(snapshotsDir) ? await readdir(snapshotsDir) : [];
  const snapshots = new Map<string, Record<string, SourceSnapshot>>();
  for (const file of snapshotFiles) {
    if (!file.endsWith(".json")) continue;
    const source = file.slice(0, -".json".length);
    snapshots.set(source, await readJson<Record<string, SourceSnapshot>>(join(snapshotsDir, file), {}));
  }

  const dirtyWeeks = new Set<string>();
  const dirtySources = new Set<string>();
  let dirtyMeta = false;

  const knownKeys = new Map<string, Set<string>>();
  const keysFor = (weekId: string): Set<string> => {
    const cached = knownKeys.get(weekId);
    if (cached) return cached;
    const keys = new Set((events.get(weekId) ?? []).map(eventKey));
    knownKeys.set(weekId, keys);
    return keys;
  };

  return {
    eventsForWeek(weekId) {
      return [...(events.get(weekId) ?? [])];
    },

    weeks() {
      return [...events.keys()].filter((week) => (events.get(week)?.length ?? 0) > 0).sort();
    },

    snapshot(source, id) {
      const found = snapshots.get(source)?.[id];
      return found ? { ...found, source } : undefined;
    },

    knownItemIds(source) {
      return Object.keys(snapshots.get(source) ?? {});
    },

    watermark(source) {
      const at = meta.sources[source]?.fetchedAt;
      return at ? new Date(at) : undefined;
    },

    hasWindow(source, weekId) {
      return meta.sources[source]?.windows.includes(weekId) ?? false;
    },

    stateFor(source) {
      const store = sourceMeta(meta, source).state;
      return {
        get: (key) => store[key],
        set: (key, value) => {
          if (store[key] === value) return;
          store[key] = value;
          dirtyMeta = true;
        },
      };
    },

    record(source, batch, seenAt) {
      const perWeek = new Map<string, number>();
      let addedEvents = 0;
      let addedSnapshots = 0;

      const bySource = snapshots.get(source) ?? {};
      for (const snapshot of batch.snapshots) {
        // Written once. A later look at the same item is an event, never an edit here.
        if (bySource[snapshot.id]) continue;
        bySource[snapshot.id] = {
          id: snapshot.id,
          firstSeenAt: snapshot.firstSeenAt || seenAt.toISOString(),
          payload: snapshot.payload,
        };
        addedSnapshots++;
      }
      if (addedSnapshots > 0) {
        snapshots.set(source, bySource);
        dirtySources.add(source);
      }

      for (const event of batch.events) {
        const weekId = weekIdForDate(new Date(event.at));
        const keys = keysFor(weekId);
        const key = eventKey(event);
        if (keys.has(key)) continue;

        keys.add(key);
        const week = events.get(weekId) ?? [];
        week.push(event);
        events.set(weekId, week);
        dirtyWeeks.add(weekId);
        addedEvents++;
        perWeek.set(weekId, (perWeek.get(weekId) ?? 0) + 1);
      }

      return { addedEvents, addedSnapshots, weeksChanged: [...perWeek.keys()].sort(), perWeek };
    },

    markWindow(source, weekId) {
      const entry = sourceMeta(meta, source);
      if (entry.windows.includes(weekId)) return;
      entry.windows.push(weekId);
      entry.windows.sort();
      dirtyMeta = true;
    },

    setWatermark(source, at) {
      const entry = sourceMeta(meta, source);
      const next = at.toISOString();
      if (entry.fetchedAt === next) return;
      entry.fetchedAt = next;
      dirtyMeta = true;
    },

    async save() {
      if (dirtyWeeks.size === 0 && dirtySources.size === 0 && !dirtyMeta) return;

      await mkdir(eventsDir, { recursive: true });
      await mkdir(snapshotsDir, { recursive: true });

      for (const weekId of dirtyWeeks) {
        const week = [...(events.get(weekId) ?? [])].sort(compareEvents);
        events.set(weekId, week);
        await writeJsonAtomic(join(eventsDir, `${weekId}.json`), week);
      }
      for (const source of dirtySources) {
        await writeJsonAtomic(join(snapshotsDir, `${source}.json`), snapshots.get(source) ?? {});
      }
      if (dirtyMeta || dirtyWeeks.size > 0 || dirtySources.size > 0) {
        await writeJsonAtomic(join(root, "meta.json"), meta);
      }

      dirtyWeeks.clear();
      dirtySources.clear();
      dirtyMeta = false;
    },
  };
}

/** Group a week's events by the item they happened to, in time order. */
export function eventsByItem(events: readonly SourceEvent[]): Map<string, SourceEvent[]> {
  const byItem = new Map<string, SourceEvent[]>();
  for (const event of [...events].sort(compareEvents)) {
    const forItem = byItem.get(event.itemId) ?? [];
    forItem.push(event);
    byItem.set(event.itemId, forItem);
  }
  return byItem;
}

/** Read a string field out of a payload, or "" when it is not one. */
export function payloadString(payload: JsonObject, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/** Read a number field out of a payload, or undefined when it is not one. */
export function payloadNumber(payload: JsonObject, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

/** Read a nested object out of a payload, or undefined. */
export function payloadObject(payload: JsonObject, key: string): JsonObject | undefined {
  const value = payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** One week to collect, with the window a source is asked about. */
export interface CollectionWeek {
  weekId: string;
  window: SourceWindow;
}

/** What one source contributed, or why it contributed nothing. */
export interface SourceOutcome {
  addedEvents: number;
  addedSnapshots: number;
  /** Present when the source could not run at all. */
  unavailable?: string;
}

export interface CollectionOutcome {
  perSource: Map<string, SourceOutcome>;
  /** Weeks whose event set is not what it was, and so need writing again. */
  weeksChanged: Set<string>;
  /** Events added, by week and then by source: the table the user reads. */
  perWeek: Map<string, Map<string, number>>;
  warnings: string[];
}

/**
 * Fill the ledger from every source, for the weeks asked about.
 *
 * Two different questions get asked. A week the source has never been read for gets
 * `fetchWindow`, which is the expensive first look. After that the source is only asked
 * what has happened since the watermark, and whatever comes back is filed by its own
 * timestamp: that is how a change lands in the week it happened rather than the week we
 * noticed. A week already collected is never re-windowed, so the second run of a
 * refresh asks only the delta question.
 *
 * The watermark moves to `now` only after a source has answered, and it is the time the
 * run started rather than the time it finished, so an event created while we were
 * fetching is picked up next time instead of being skipped.
 */
export async function collectIntoLedger(
  ledger: Ledger,
  sources: readonly Source[],
  weeks: readonly CollectionWeek[],
  contextFor: (source: Source) => SourceContext,
  now: Date,
): Promise<CollectionOutcome> {
  const perSource = new Map<string, SourceOutcome>();
  const weeksChanged = new Set<string>();
  const perWeek = new Map<string, Map<string, number>>();
  const warnings: string[] = [];

  for (const source of sources) {
    const ctx = contextFor(source);
    const availability = await source.isAvailable(ctx);
    if (!availability.ok) {
      perSource.set(source.name, { addedEvents: 0, addedSnapshots: 0, unavailable: availability.reason });
      continue;
    }

    const outcome: SourceOutcome = { addedEvents: 0, addedSnapshots: 0 };
    const file = (batch: SourceBatch) => {
      const result = ledger.record(source.name, batch, now);
      outcome.addedEvents += result.addedEvents;
      outcome.addedSnapshots += result.addedSnapshots;
      for (const week of result.weeksChanged) weeksChanged.add(week);
      for (const [week, added] of result.perWeek) {
        const bySource = perWeek.get(week) ?? new Map<string, number>();
        bySource.set(source.name, (bySource.get(source.name) ?? 0) + added);
        perWeek.set(week, bySource);
      }
      warnings.push(...batch.warnings);
    };

    for (const week of weeks) {
      if (ledger.hasWindow(source.name, week.weekId)) continue;
      file(await source.fetchWindow(week.window, ctx));
      ledger.markWindow(source.name, week.weekId);
    }

    const since = ledger.watermark(source.name);
    if (since) {
      const itemIds = itemsInWeeks(ledger, source.name, weeks);
      file(await source.fetchSince(since, itemIds, ctx));
    }

    ledger.setWatermark(source.name, now);
    perSource.set(source.name, outcome);
  }

  return { perSource, weeksChanged, perWeek, warnings };
}

/**
 * The items worth asking a source about again.
 *
 * Everything it touched in the weeks being collected, rather than everything it has
 * ever seen: a delta query names its items, and a list that grows forever would
 * eventually be too long to send and mostly about work nobody is looking at.
 */
function itemsInWeeks(ledger: Ledger, source: string, weeks: readonly CollectionWeek[]): string[] {
  const ids = new Set<string>();
  for (const week of weeks) {
    for (const event of ledger.eventsForWeek(week.weekId)) {
      if (event.source === source) ids.add(event.itemId);
    }
  }
  return [...ids].sort();
}
