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
const LEDGER_VERSION = 2;

/**
 * What a source may be called.
 *
 * A source's name becomes a file name under the ledger, and sources are plugins. A name
 * like `../../something` would resolve a write outside the ledger entirely, so the set
 * of legal names is kept too small to express a path.
 */
const SAFE_SOURCE_NAME = /^[a-z0-9_-]+$/;

export function isSafeSourceName(name: string): boolean {
  return SAFE_SOURCE_NAME.test(name);
}

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
  /**
   * Weeks whose first whole-window fetch is done, each with how far it has been read.
   *
   * Per week, not per source. A refresh scoped to one week must not claim to have read
   * anything on behalf of a week it never asked about: a source-wide watermark did
   * exactly that, and every change to an older week made between the two runs was lost.
   */
  windows: Record<string, string>;
  /** ETags, cursors: opaque to everything but the source that wrote it. */
  state: Record<string, string>;
}

interface LedgerMeta {
  version: number;
  sources: Record<string, SourceMeta>;
  /**
   * Weeks whose events have changed and whose work log has not been written since.
   *
   * A delta answers with events from any week, including ones this run was not asked
   * about. They are filed where they belong and the week stays here until something
   * writes it: the next run would otherwise dedupe them away, and the week would be
   * stale in the vault for good.
   */
  pendingWeeks: string[];
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
  return { version: LEDGER_VERSION, sources: {}, pendingWeeks: [] };
}

function sourceMeta(meta: LedgerMeta, source: string): SourceMeta {
  const existing = meta.sources[source];
  if (existing) return existing;
  const created: SourceMeta = { windows: {}, state: {} };
  meta.sources[source] = created;
  return created;
}

/** The later of two ISO timestamps, treating an absent one as "nothing read yet". */
function laterOf(current: string | undefined, next: string): string {
  return current && current >= next ? current : next;
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

/**
 * A source's meta, in either layout it has ever had on disk.
 *
 * Version 1 kept one watermark for the whole source and a bare list of collected weeks.
 * Both are read here and turned into the per-week form, so an existing cache keeps its
 * expensive window fetches instead of paying for them again.
 */
const sourceMetaSchema = z.object({
  fetchedAt: z.string().optional(),
  windows: z.union([z.array(z.string()), z.record(z.string(), z.string())]).default({}),
  state: z.record(z.string(), z.string()).default({}),
}).transform(({ fetchedAt, windows, state }): SourceMeta => ({
  windows: Array.isArray(windows)
    ? Object.fromEntries(windows.map((week) => [week, fetchedAt ?? ""]))
    : windows,
  state,
}));

const metaSchema = z.object({
  version: z.number().default(LEDGER_VERSION),
  sources: z.record(z.string(), sourceMetaSchema).default({}),
  pendingWeeks: z.array(z.string()).default([]),
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

/**
 * Rows that parse, and the keys of the ones that did not.
 *
 * A row that no longer matches is not thrown away quietly. The run carries on with what
 * it can read, and the caller is told which file and which row so a person can look,
 * because the alternative is a cache that heals itself by deleting evidence.
 */
interface ParsedRows<T> {
  /** What parsed, in file order, each with the key it was found under. */
  kept: [string, T][];
  /** The keys of what did not, for the person who has to go and look. */
  bad: string[];
}

function parseRows<T>(rows: Iterable<readonly [string, unknown]>, schema: z.ZodType<T>): ParsedRows<T> {
  const kept: [string, T][] = [];
  const bad: string[] = [];
  for (const [key, row] of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) kept.push([key, parsed.data]);
    else bad.push(key);
  }
  return { kept, bad };
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
  /** How far this source has been read for this week, or undefined if it never has. */
  watermarkFor(source: string, weekId: string): Date | undefined;
  /** Whether this source has done its first whole-window fetch for a week. */
  hasWindow(source: string, weekId: string): boolean;
  /** This source's own persisted state. Writes are kept until `save`. */
  stateFor(source: string): SourceState;
  /** Weeks whose events changed and whose work log has not been written since. */
  pendingWeeks(): string[];
  /** Anything unreadable found on disk, in the words the user should see. */
  problems(): string[];

  /** File a batch. Returns what actually changed, which is nothing on a repeat. */
  record(source: string, batch: SourceBatch, seenAt: Date): RecordResult;
  markWindow(source: string, weekId: string): void;
  /** Move this week's watermark forward. An earlier time than the one held is ignored. */
  setWatermark(source: string, weekId: string, at: Date): void;
  /** This week's work log is now written; it no longer needs writing again. */
  markWritten(weekId: string): void;

  /** Persist whatever changed, and nothing that did not. */
  save(): Promise<void>;
}

/**
 * Open the ledger, reading only what is there.
 *
 * A missing directory is an empty ledger rather than an error: the first run of a new
 * install has nothing cached, which is not a problem to report. A file that cannot be
 * read fully is a different matter — it is reported, and then left exactly as it is
 * rather than being rewritten without whatever could not be parsed.
 */
export async function openLedger(root: string = ledgerRoot()): Promise<Ledger> {
  const eventsDir = join(root, "events");
  const snapshotsDir = join(root, "snapshots");

  const problems: string[] = [];
  // Files that hold something this version cannot read. They are never written back:
  // rewriting one would drop the unreadable rows for good.
  const frozen = new Set<string>();

  const metaPath = join(root, "meta.json");
  const rawMeta = await readParsed(metaPath, z.unknown(), undefined);
  const parsedMeta = rawMeta === undefined ? undefined : metaSchema.safeParse(rawMeta);
  if (parsedMeta && !parsedMeta.success) {
    problems.push(`${metaPath} could not be read, so this run starts as if nothing had been fetched. The file is left alone.`);
    frozen.add(metaPath);
  }
  const meta = parsedMeta?.success ? parsedMeta.data : emptyMeta();

  const weekFiles = existsSync(eventsDir) ? await readdir(eventsDir) : [];
  const events = new Map<string, SourceEvent[]>();
  for (const file of weekFiles) {
    if (!file.endsWith(".json")) continue;
    const path = join(eventsDir, file);
    const rows = await readParsed(path, z.array(z.unknown()), []);
    const { kept, bad } = parseRows(rows.map((row, index) => [String(index), row] as const), eventSchema);
    if (bad.length > 0) {
      problems.push(`${path}: row ${bad.join(", ")} could not be read. This run uses the rest of the file and does not write it back.`);
      frozen.add(path);
    }
    events.set(file.slice(0, -".json".length), kept.map(([, event]) => event));
  }

  const snapshotFiles = existsSync(snapshotsDir) ? await readdir(snapshotsDir) : [];
  const snapshots = new Map<string, Record<string, SourceSnapshot>>();
  for (const file of snapshotFiles) {
    if (!file.endsWith(".json")) continue;
    const path = join(snapshotsDir, file);
    const stored = await readParsed(path, z.record(z.string(), z.unknown()), {});
    const { kept, bad } = parseRows(Object.entries(stored), snapshotSchema);
    if (bad.length > 0) {
      problems.push(`${path}: ${bad.join(", ")} could not be read. This run uses the rest of the file and does not write it back.`);
      frozen.add(path);
    }
    snapshots.set(file.slice(0, -".json".length), Object.fromEntries(kept));
  }

  const dirtyWeeks = new Set<string>();
  const dirtySources = new Set<string>();
  let dirtyMeta = false;

  const pending = new Set(meta.pendingWeeks);

  const knownKeys = new Map<string, Set<string>>();
  const keysFor = (weekId: string): Set<string> => {
    const cached = knownKeys.get(weekId);
    if (cached) return cached;
    const keys = new Set((events.get(weekId) ?? []).map(eventKey));
    knownKeys.set(weekId, keys);
    return keys;
  };

  const savePending = () => {
    const next = [...pending].sort();
    if (next.length === meta.pendingWeeks.length && next.every((week, i) => meta.pendingWeeks[i] === week)) return;
    meta.pendingWeeks = next;
    dirtyMeta = true;
  };

  /**
   * A path inside the ledger, or nothing.
   *
   * The last guard on a source name. `isSafeSourceName` rejects anything that could be
   * a path, and this checks the answer rather than trusting it, because the cost of
   * being wrong is a write somewhere else on the disk.
   */
  const insideLedger = (dir: string, name: string): string | undefined => {
    const path = join(dir, `${name}.json`);
    return path.startsWith(`${dir}/`) ? path : undefined;
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

    watermarkFor(source, weekId) {
      const at = meta.sources[source]?.windows[weekId];
      return at ? new Date(at) : undefined;
    },

    hasWindow(source, weekId) {
      return meta.sources[source]?.windows[weekId] !== undefined;
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

    pendingWeeks() {
      return [...pending].sort();
    },

    problems() {
      return [...problems];
    },

    record(source, batch, seenAt) {
      const perWeek = new Map<string, number>();
      let addedEvents = 0;
      let addedSnapshots = 0;

      if (!isSafeSourceName(source)) {
        problems.push(`Ignored everything from a source calling itself "${source}": a source name may only contain a-z, 0-9, dash and underscore.`);
        return { addedEvents, addedSnapshots, perWeek };
      }

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
        pending.add(weekId);
        addedEvents++;
        perWeek.set(weekId, (perWeek.get(weekId) ?? 0) + 1);
      }
      if (addedEvents > 0) savePending();

      return { addedEvents, addedSnapshots, perWeek };
    },

    markWindow(source, weekId) {
      const entry = sourceMeta(meta, source);
      if (entry.windows[weekId] !== undefined) return;
      entry.windows[weekId] = "";
      dirtyMeta = true;
    },

    setWatermark(source, weekId, at) {
      const entry = sourceMeta(meta, source);
      const next = laterOf(entry.windows[weekId], at.toISOString());
      if (entry.windows[weekId] === next) return;
      entry.windows[weekId] = next;
      dirtyMeta = true;
    },

    markWritten(weekId) {
      if (!pending.delete(weekId)) return;
      savePending();
    },

    async save() {
      if (dirtyWeeks.size === 0 && dirtySources.size === 0 && !dirtyMeta) return;

      await mkdir(eventsDir, { recursive: true });
      await mkdir(snapshotsDir, { recursive: true });

      for (const weekId of dirtyWeeks) {
        const week = [...(events.get(weekId) ?? [])].sort(compareEvents);
        events.set(weekId, week);
        const path = insideLedger(eventsDir, weekId);
        if (!path || frozen.has(path)) continue;
        await writeJsonAtomic(path, week);
      }
      for (const source of dirtySources) {
        const path = insideLedger(snapshotsDir, source);
        if (!path || frozen.has(path)) continue;
        await writeJsonAtomic(path, snapshots.get(source) ?? {});
      }
      // Whatever changed, the meta changed with it: a fetch moves a watermark.
      if (!frozen.has(metaPath)) await writeJsonAtomic(metaPath, meta);

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
 * what has happened since, and whatever comes back is filed by its own timestamp: that
 * is how a change lands in the week it happened rather than the week we noticed. A week
 * already collected is never re-windowed, so a second run asks only the delta question.
 *
 * The delta is asked from the earliest point any requested week has been read to, and
 * only those weeks are then marked as read further. A refresh of one week must not
 * claim coverage on behalf of weeks it never asked about, or a change to an older
 * ticket made in between is skipped by the query that would have found it and skipped
 * again by the week that comes back to look.
 *
 * Watermarks move to the newest timestamp actually observed, never to the clock. A run
 * that sees nothing new has nothing to write, which is what makes a repeated refresh
 * free: no file changes, in the vault or in the cache.
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
    if (!isSafeSourceName(source.name)) {
      warnings.push(`Skipped a source calling itself "${source.name}": a source name may only contain a-z, 0-9, dash and underscore.`);
      continue;
    }

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
    /** The newest thing this source reported, whether or not the ledger already had it. */
    let newest: string | undefined;

    const file = (batch: SourceBatch) => {
      for (const event of batch.events) newest = laterOf(newest, event.at);
      for (const snapshot of batch.snapshots) newest = laterOf(newest, snapshot.firstSeenAt);

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

    const windowed: string[] = [];
    for (const week of weeks) {
      if (ledger.hasWindow(source.name, week.weekId)) continue;
      file(await source.fetchWindow(week.window, ctx));
      ledger.markWindow(source.name, week.weekId);
      // A whole window came back, so this week is read up to the moment it was asked.
      ledger.setWatermark(source.name, week.weekId, now);
      windowed.push(week.weekId);
    }

    const delta = weeks.filter((week) => !windowed.includes(week.weekId));
    if (delta.length > 0) {
      const since = deltaStart(ledger, source.name, delta);
      const itemIds = itemsInWeeks(ledger, source.name, delta);
      file(await source.fetchSince(since, itemIds, ctx));

      // The query covered everything from `since` onwards for all of these weeks, so
      // each of them is read at least that far, and further when something later than
      // `since` actually came back. Never to the clock: a run that sees nothing new has
      // nothing to write, which is what makes a repeated refresh free.
      const read = newest && newest > since.toISOString() ? new Date(newest) : since;
      for (const week of delta) ledger.setWatermark(source.name, week.weekId, read);
    }

    outcome.tookMs = Math.round(performance.now() - startedAt);
    perSource.set(source.name, outcome);
  }

  return { perSource, weeksChanged, perWeek, warnings };
}

/**
 * How far back a delta has to reach.
 *
 * The earliest point any of these weeks has been read to, and no later, because one
 * query has to cover all of them. A week with nothing recorded against it falls back to
 * where the week itself begins, which is the earliest thing that could belong to it.
 */
function deltaStart(ledger: Ledger, source: string, weeks: readonly CollectionWeek[]): Date {
  let earliest: Date | undefined;
  for (const week of weeks) {
    const mark = ledger.watermarkFor(source, week.weekId) ?? week.window.start;
    if (!earliest || mark < earliest) earliest = mark;
  }

  return earliest ?? new Date(0);
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
