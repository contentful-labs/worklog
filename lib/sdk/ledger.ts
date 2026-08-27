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
import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  Source, SourceBatch, SourceContext, SourceEvent, SourceSnapshot, SourceState, SourceWindow,
} from "./sources";
import { weekIdForDate } from "./week-utils";

/** The ledger format on disk. Bumped only when an older layout can no longer be read. */
const LEDGER_VERSION = 1;

/** The one environment variable the ledger's location depends on. */
export interface CacheEnv {
  XDG_CACHE_HOME?: string;
}

/**
 * Where the ledger lives.
 *
 * `XDG_CACHE_HOME` when the user has set it, `~/.cache` otherwise. Not the vault, which
 * syncs to iCloud and is indexed by Obsidian, and not a dotfile directory, which is for
 * things that cannot be fetched again.
 */
export function ledgerRoot(env: CacheEnv = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }): string {
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
  /**
   * Events added, by week. Its keys are the weeks whose event set is not what it was,
   * which are the weeks, and the only weeks, that need writing again.
   */
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

/**
 * The shapes on disk.
 *
 * These files are JSON so a person can read them, which means a person can also edit
 * them, and a half-written one survives a machine losing power mid-run. Everything is
 * therefore parsed on the way in rather than trusted: a row that no longer matches is
 * dropped and the rest of the ledger still opens, the same way a malformed row in a
 * week's output costs that row and not the week.
 */
const eventSchema = z.object({
  source: z.string().min(1),
  kind: z.string().min(1),
  itemId: z.string().min(1),
  at: z.string().min(1),
  payload: z.unknown(),
  id: z.string().optional(),
});

const snapshotSchema = z.object({
  id: z.string().min(1),
  firstSeenAt: z.string().min(1),
  payload: z.unknown(),
});

const sourceMetaSchema = z.object({
  fetchedAt: z.string().optional(),
  windows: z.array(z.string()).default([]),
  state: z.record(z.string(), z.string()).default({}),
});

const metaSchema = z.object({
  version: z.number().default(LEDGER_VERSION),
  sources: z.record(z.string(), sourceMetaSchema).default({}),
});

/**
 * Read a file through a schema, keeping the rows that still parse.
 *
 * A file that is missing, empty or not JSON at all reads as nothing there, which is the
 * same thing as far as the run is concerned: the ledger refetches what it cannot read.
 */
async function readParsed<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;

  const raw = await readFile(path, "utf-8");
  if (raw.trim().length === 0) return fallback;

  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Rows that parse, in file order. One bad row costs itself and nothing else. */
function keepParsable<T>(rows: readonly unknown[], schema: z.ZodType<T>): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
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

  const meta = await readParsed(join(root, "meta.json"), metaSchema, emptyMeta());

  const weekFiles = existsSync(eventsDir) ? await readdir(eventsDir) : [];
  const events = new Map<string, SourceEvent[]>();
  for (const file of weekFiles) {
    if (!file.endsWith(".json")) continue;
    const rows = await readParsed(join(eventsDir, file), z.array(z.unknown()), []);
    events.set(file.slice(0, -".json".length), keepParsable(rows, eventSchema));
  }

  const snapshotFiles = existsSync(snapshotsDir) ? await readdir(snapshotsDir) : [];
  const snapshots = new Map<string, Record<string, SourceSnapshot>>();
  for (const file of snapshotFiles) {
    if (!file.endsWith(".json")) continue;
    const source = file.slice(0, -".json".length);
    const stored = await readParsed(join(snapshotsDir, file), z.record(z.string(), z.unknown()), {});

    const kept: Record<string, SourceSnapshot> = {};
    for (const [id, row] of Object.entries(stored)) {
      const parsed = snapshotSchema.safeParse(row);
      if (parsed.success) kept[id] = parsed.data;
    }
    snapshots.set(source, kept);
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

      return { addedEvents, addedSnapshots, perWeek };
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
      // Whatever changed, the meta changed with it: a fetch moves the watermark.
      await writeJsonAtomic(join(root, "meta.json"), meta);

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

/**
 * The fields the work log renders, recovered from a payload.
 *
 * A payload is whatever its source knows and reaches this side as `unknown`, having
 * been through JSON. Rather than reach into it a field at a time, the few keys every
 * source agreed to speak are parsed once, here, and anything else in there is left for
 * that source's own reader. A payload that carries none of them parses to an empty
 * view, which renders as a bare item and is exactly right for one that had nothing to
 * add.
 */
const renderableSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  spotted: z.boolean().optional(),
});

export type RenderablePayload = z.infer<typeof renderableSchema>;

export function renderable(payload: unknown): RenderablePayload {
  const parsed = renderableSchema.safeParse(payload);
  return parsed.success ? parsed.data : {};
}

/**
 * The events in `after` that were not already in `before`.
 *
 * Identity is the same thing `record` dedupes on, so an event re-fetched unchanged is
 * not new. This is how a week that is being added to can hand the model only what it
 * has not already been told about.
 */
export function newEvents(before: readonly SourceEvent[], after: readonly SourceEvent[]): SourceEvent[] {
  const already = new Set(before.map(eventKey));
  return after.filter((event) => !already.has(eventKey(event)));
}

/** One week to collect, with the window a source is asked about. */
export interface CollectionWeek {
  weekId: string;
  window: SourceWindow;
}

/**
 * The window a source should be asked about for a week.
 *
 * `getWeekEnd` returns the Sunday at midnight, which is the start of the last day
 * rather than the end of it. The existing queries hide that by sending date-only
 * strings, but a source that compares timestamps against the window would silently drop
 * everything that happened on the Sunday. The end is pushed to the last instant of that
 * day here, once, so no source has to know.
 */
export function weekWindow(weekId: string, start: Date, end: Date): CollectionWeek {
  const inclusiveEnd = new Date(end);
  inclusiveEnd.setUTCHours(23, 59, 59, 999);
  return { weekId, window: { start, end: inclusiveEnd } };
}

/** What one source contributed, or why it contributed nothing. */
export interface SourceOutcome {
  addedEvents: number;
  addedSnapshots: number;
  /**
   * How long this source took, in milliseconds.
   *
   * Worth showing: the HTTP sources answer in seconds and one that asks a model answers
   * in minutes, and a user watching a long run deserves to know which of them they are
   * waiting for.
   */
  tookMs: number;
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
    const startedAt = performance.now();
    const availability = await source.isAvailable(ctx);
    if (!availability.ok) {
      perSource.set(source.name, {
        addedEvents: 0,
        addedSnapshots: 0,
        tookMs: Math.round(performance.now() - startedAt),
        unavailable: availability.reason,
      });
      continue;
    }

    const outcome: SourceOutcome = { addedEvents: 0, addedSnapshots: 0, tookMs: 0 };
    const file = (batch: SourceBatch) => {
      const result = ledger.record(source.name, batch, now);
      outcome.addedEvents += result.addedEvents;
      outcome.addedSnapshots += result.addedSnapshots;
      for (const [week, added] of result.perWeek) {
        weeksChanged.add(week);
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
    outcome.tookMs = Math.round(performance.now() - startedAt);
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
