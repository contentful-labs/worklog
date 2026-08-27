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
import { join, isAbsolute, relative, resolve } from "node:path";

import type {
  Source, SourceBatch, SourceContext, SourceEvent, SourceSnapshot, SourceState, SourceWindow,
} from "./sources";
import { weekIdForDate } from "./week-utils";

/** The part of `node:path` this module needs, so a test can supply another platform's. */
export interface PathRules {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

const nodePaths: PathRules = { join, resolve, relative, isAbsolute };

/**
 * `<dir>/<name>.json`, but only when that really is inside `dir`.
 *
 * The last guard on a source name. `isSafeSourceName` rejects anything that could be a
 * path, and this checks the answer rather than trusting it, because the cost of being
 * wrong is a write somewhere else on the disk. Asked as a question about the two paths
 * rather than about the text of one: a separator is not always a slash, and a guard that
 * assumed it was would quietly refuse every legitimate write on Windows and let the run
 * carry on believing it had saved them.
 */
export function insidePath(paths: PathRules, dir: string, name: string): string | undefined {
  const target = paths.resolve(paths.join(dir, `${name}.json`));
  const step = paths.relative(paths.resolve(dir), target);
  if (step === "" || step.startsWith("..") || paths.isAbsolute(step)) return undefined;
  return target;
}

/** The ledger format on disk. Bumped only when an older layout can no longer be read. */
const LEDGER_VERSION = 3;

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
  /**
   * Weeks this source has not finished reading, oldest first.
   *
   * Kept on disk, not only for the run that found out. A GitHub page that failed last
   * night still leaves this week half-read this morning, and a run scoped to another
   * source has no way of knowing that unless it is written down.
   */
  incomplete: string[];
  /** ETags, cursors: opaque to everything but the source that wrote it. */
  state: Record<string, string>;
}

interface LedgerMeta {
  version: number;
  sources: Record<string, SourceMeta>;
  /**
   * Per week, the events that were in it the last time its work log was written.
   *
   * Not a list of weeks owed a write: a record of what each week has already been told
   * about. A delta answers with events from any week, including ones this run was not
   * asked about, and the week that receives them may not be written for days. Comparing
   * against a mark taken at the start of a run would call those events old by then, and
   * the model would never hear about them, so the comparison is against what was
   * actually written instead.
   */
  written: Record<string, string[]>;
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
  /**
   * Weeks whose events were thrown away because their file cannot be rewritten.
   *
   * The caller has to know: a fetch that was partly refused must not be allowed to leave
   * an ETag behind saying it succeeded, or the next fetch is answered 304 and the refused
   * events are never offered again.
   */
  refusedWeeks: string[];
}

/** An item as first seen, with the source that saw it. */
export interface LedgerSnapshot extends SourceSnapshot {
  source: string;
}

function emptyMeta(): LedgerMeta {
  return { version: LEDGER_VERSION, sources: {}, written: {} };
}

function sourceMeta(meta: LedgerMeta, source: string): SourceMeta {
  const existing = meta.sources[source];
  if (existing) return existing;
  const created: SourceMeta = { windows: {}, incomplete: [], state: {} };
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
 * The system's own id when it gave us one, since that is the only thing that survives a
 * payload being reworded — but scoped by what it is an id *of*. Nothing in the `Source`
 * contract promises an id is unique across kinds, and GitHub in particular numbers
 * reviews and issue comments separately: review 42 and comment 42 on the same pull
 * request are two different things, and keying on the id alone silently dropped the
 * second of them. When there is no id, the time stands in for one.
 */
function eventKey(event: SourceEvent): string {
  const what = event.id ?? event.at;
  return `${event.source}|${event.kind}|${event.itemId}|${what}`;
}

/** How version 2 keyed an event, kept only to recognise what an old cache wrote down. */
function legacyEventKey(event: SourceEvent): string {
  return event.id ? `${event.source}|${event.id}` : `${event.source}|${event.kind}|${event.itemId}|${event.at}`;
}

/**
 * Bring a version 2 record of what has been written up into the new key format.
 *
 * Rewriting keys is safe here because the events themselves are still on disk: each one
 * knows both its old key and its new one, so a week's record of "already written up"
 * survives the change. Skipping this would make every stored event look new and hand
 * the whole history back to the coach.
 */
function migrateWrittenKeys(written: Record<string, string[]>, events: Map<string, SourceEvent[]>): void {
  for (const [weekId, keys] of Object.entries(written)) {
    const before = new Set(keys);
    const after = new Set<string>();
    for (const event of events.get(weekId) ?? []) {
      if (before.has(legacyEventKey(event)) || before.has(eventKey(event))) after.add(eventKey(event));
    }
    written[weekId] = [...after].sort();
  }
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
 * The weeks are kept, so an old cache does not pay for its window fetches again, but the
 * watermark is not carried into them: it was advanced by whichever week happened to be
 * refreshed last, and copying it into a week nobody checked would assert exactly what
 * the per-week layout exists to stop asserting. A migrated week has no watermark at all,
 * which sends its next delta back to the week's own start, once.
 */
const sourceMetaSchema = z.object({
  fetchedAt: z.string().optional(),
  windows: z.union([z.array(z.string()), z.record(z.string(), z.string())]).default({}),
  incomplete: z.array(z.string()).default([]),
  state: z.record(z.string(), z.string()).default({}),
}).transform(({ windows, incomplete, state }): SourceMeta => ({
  windows: Array.isArray(windows)
    ? Object.fromEntries(windows.map((week) => [week, ""]))
    : windows,
  incomplete,
  state,
}));

/**
 * The fields an existing metadata file must actually carry.
 *
 * Defaults are for fields a past version did not write, not for a file that has lost its
 * contents. A zero-byte file, whitespace, or `{}` would satisfy a schema of nothing but
 * defaults and read as a fresh install — and a fresh install means every event already
 * on disk looks unwritten, so the whole history goes back to the coach. Only a file that
 * is not there at all means fresh.
 */
const metaSchema = z.object({
  version: z.number(),
  sources: z.record(z.string(), sourceMetaSchema),
  written: z.record(z.string(), z.array(z.string())).default({}),
});

/**
 * Read a file through a schema, keeping the rows that still parse.
 *
 * A file that is missing, empty or not JSON at all reads as nothing there, which is the
 * same thing as far as the run is concerned: the ledger refetches what it cannot read.
 */
type FileRead<T> = { ok: true; value: T } | { ok: false; why: string };

async function readParsed<T>(path: string, schema: z.ZodType<T>, fallback: T, emptyIsFresh = true): Promise<FileRead<T>> {
  // Nothing there is "no data", which is the normal state of a fresh install.
  if (!existsSync(path)) return { ok: true, value: fallback };

  const raw = await readFile(path, "utf-8");
  // An empty file is a run killed between opening a temp file and renaming it over the
  // real one. For a week's events that costs a refetch. For the metadata it would read
  // as a fresh install and hand the whole history back to the coach, so there it counts
  // as damage rather than absence.
  if (raw.trim().length === 0) {
    return emptyIsFresh ? { ok: true, value: fallback } : { ok: false, why: "it is empty" };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, why: "it is not valid JSON" };
  }

  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, why: "its contents are not the shape this version writes" };
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
  /**
   * This source's own persisted state.
   *
   * Writes are held in a buffer, not applied. An ETag is a claim to have already seen
   * something, and it is only true once the events that came with it are filed: a fetch
   * whose events were refused must not leave one behind, or the next fetch is answered
   * 304 and what was refused is never offered again.
   */
  stateFor(source: string): SourceState;
  /** The events that came with this source's buffered state are filed. Keep it. */
  commitState(source: string): void;
  /** They were not. Throw the buffered state away so the next fetch asks in full. */
  discardState(source: string): void;

  /** Weeks holding events their work log has not been told about, oldest first. */
  pendingWeeks(): string[];
  /** The events in this week that its last written work log did not include. */
  unwrittenEvents(weekId: string): SourceEvent[];
  /**
   * Weeks whose stored events could not all be read.
   *
   * Nothing may write a work log for one of these. What is in memory is a week with
   * pieces missing, and writing it into the vault would turn a damaged cache file, which
   * can be refetched, into a damaged week, which cannot.
   */
  unreadableWeeks(): string[];
  /**
   * Weeks some source has not finished reading, from any run, oldest first.
   *
   * Remembered on disk rather than only for the run that found out, so a later run
   * scoped to a different source still knows the week is short of something.
   */
  incompleteWeeks(): string[];
  /** This source has not finished reading this week. Kept until it does. */
  markIncomplete(source: string, weekId: string): void;
  /** This source has now read this week in full. */
  clearIncomplete(source: string, weekId: string): void;
  /** Anything unreadable found on disk, in the words the user should see. */
  problems(): string[];
  /**
   * Why this ledger cannot safely be used to write anything, or undefined when it can.
   *
   * Checked before generating any week. Unlike a single damaged week file, which costs
   * that week, this is a state in which no week can be trusted.
   */
  unusable(): string | undefined;
  /** Things worth saying once, like a cache that had to be brought forward a version. */
  notices(): string[];

  /** File a batch. Returns what actually changed, which is nothing on a repeat. */
  record(source: string, batch: SourceBatch, seenAt: Date): RecordResult;
  markWindow(source: string, weekId: string): void;
  /** Move this week's watermark forward. An earlier time than the one held is ignored. */
  setWatermark(source: string, weekId: string, at: Date): void;
  /** This week's work log now covers everything the ledger holds for it. */
  markWritten(weekId: string): void;

  /** Persist whatever changed, and nothing that did not. */
  save(): Promise<void>;
}

/**
 * Open the ledger, reading only what is there.
 *
 * A missing directory is an empty ledger rather than an error: the first run of a new
 * install has nothing cached, which is not a problem to report. A file that cannot be
 * read fully is a different matter — it is reported, its week is barred from being
 * written into the vault, and the file itself is left exactly as it is rather than
 * rewritten without whatever could not be parsed.
 */
export async function openLedger(root: string = ledgerRoot()): Promise<Ledger> {
  const eventsDir = join(root, "events");
  const snapshotsDir = join(root, "snapshots");

  const problems: string[] = [];
  const notices: string[] = [];
  // Files holding something this version cannot read. They are never written back:
  // rewriting one would drop the unreadable rows for good.
  const frozen = new Set<string>();
  const unreadable = new Set<string>();

  const metaPath = join(root, "meta.json");
  const rawMeta = await readParsed(metaPath, z.unknown(), undefined, false);
  const parsedMeta = rawMeta.ok && rawMeta.value !== undefined ? metaSchema.safeParse(rawMeta.value) : undefined;
  /**
   * Why nothing may be written while the metadata is unreadable.
   *
   * The metadata is the record of what has already been written up. Without it every
   * event the ledger holds looks new, so every week would be regenerated and added to,
   * and the marker saying so could not be stored either — so the next run would do it
   * again. Losing the reading positions is recoverable; a week's entry growing a copy of
   * itself on every run is not.
   */
  let unusable: string | undefined;
  if (!rawMeta.ok || (parsedMeta && !parsedMeta.success)) {
    const why = rawMeta.ok ? "its contents are not the shape this version writes" : rawMeta.why;
    problems.push(`${metaPath} could not be read because ${why}. The file is left alone.`);
    unusable =
      `${metaPath} could not be read because ${why}, and it is the record of which weeks have already been written up. ` +
      `Running without it would offer every week's activity to the coach again, and could not record that it had. ` +
      `Either repair that file, or delete ${root} entirely and let the next run fetch again.`;
    frozen.add(metaPath);
  }
  const meta = parsedMeta?.success ? parsedMeta.data : emptyMeta();
  const storedVersion = parsedMeta?.success ? parsedMeta.data.version : LEDGER_VERSION;
  if (storedVersion < LEDGER_VERSION) {
    meta.version = LEDGER_VERSION;
    notices.push(
      `The activity cache was written by an older version, so it is being brought forward: each week it already holds will be checked ` +
      `once from the week's own start, and the keys it uses to tell one event from another are rewritten to tell apart two things that ` +
      `share a number. Anything already recorded is matched rather than duplicated, and no week already written up is offered again.`,
    );
  }

  const weekFiles = existsSync(eventsDir) ? await readdir(eventsDir) : [];
  const events = new Map<string, SourceEvent[]>();
  for (const file of weekFiles) {
    if (!file.endsWith(".json")) continue;
    const path = join(eventsDir, file);
    const weekId = file.slice(0, -".json".length);

    const read = await readParsed(path, z.array(z.unknown()), []);
    if (!read.ok) {
      problems.push(`${path} could not be read because ${read.why}. ${weekId} will not be written until that is fixed, and the file is left alone.`);
      frozen.add(path);
      unreadable.add(weekId);
      continue;
    }

    const { kept, bad } = parseRows(read.value.map((row, index) => [String(index), row] as const), eventSchema);
    if (bad.length > 0) {
      problems.push(`${path}: row ${bad.join(", ")} could not be read. ${weekId} will not be written until that is fixed, and the file is left alone.`);
      frozen.add(path);
      unreadable.add(weekId);
    }
    events.set(weekId, kept.map(([, event]) => event));
  }

  const snapshotFiles = existsSync(snapshotsDir) ? await readdir(snapshotsDir) : [];
  const snapshots = new Map<string, Record<string, SourceSnapshot>>();
  for (const file of snapshotFiles) {
    if (!file.endsWith(".json")) continue;
    const path = join(snapshotsDir, file);

    const read = await readParsed(path, z.record(z.string(), z.unknown()), {});
    if (!read.ok) {
      problems.push(`${path} could not be read because ${read.why}. Items it describes will be refetched, and the file is left alone.`);
      frozen.add(path);
      continue;
    }

    const { kept, bad } = parseRows(Object.entries(read.value), snapshotSchema);
    if (bad.length > 0) {
      problems.push(`${path}: ${bad.join(", ")} could not be read. Those items will be refetched, and the file is left alone.`);
      frozen.add(path);
    }
    snapshots.set(file.slice(0, -".json".length), Object.fromEntries(kept));
  }

  // Now that the events are in hand, each one can say both what it used to be called and
  // what it is called now, so the record of what has been written up survives the change.
  if (storedVersion < LEDGER_VERSION) migrateWrittenKeys(meta.written, events);

  /** Per source, state written during a fetch whose events are not yet safely filed. */
  const pendingState = new Map<string, Map<string, string>>();

  const dirtyWeeks = new Set<string>();
  const dirtySources = new Set<string>();
  let dirtyMeta = storedVersion < LEDGER_VERSION;

  const knownKeys = new Map<string, Set<string>>();
  const keysFor = (weekId: string): Set<string> => {
    const cached = knownKeys.get(weekId);
    if (cached) return cached;
    const keys = new Set((events.get(weekId) ?? []).map(eventKey));
    knownKeys.set(weekId, keys);
    return keys;
  };

  const writtenKeys = (weekId: string): Set<string> => new Set(meta.written[weekId] ?? []);

  const unwritten = (weekId: string): SourceEvent[] => {
    const already = writtenKeys(weekId);
    return (events.get(weekId) ?? []).filter((event) => !already.has(eventKey(event)));
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
      const buffered = pendingState.get(source) ?? new Map<string, string>();
      pendingState.set(source, buffered);
      return {
        get: (key) => buffered.get(key) ?? store[key],
        set: (key, value) => {
          if ((buffered.get(key) ?? store[key]) === value) return;
          buffered.set(key, value);
        },
      };
    },

    pendingWeeks() {
      return [...events.keys()].filter((week) => unwritten(week).length > 0).sort();
    },

    unwrittenEvents(weekId) {
      return unwritten(weekId);
    },

    unreadableWeeks() {
      return [...unreadable].sort();
    },

    incompleteWeeks() {
      const weeks = new Set<string>();
      for (const entry of Object.values(meta.sources)) {
        for (const week of entry.incomplete) weeks.add(week);
      }
      return [...weeks].sort();
    },

    markIncomplete(source, weekId) {
      const entry = sourceMeta(meta, source);
      if (entry.incomplete.includes(weekId)) return;
      entry.incomplete.push(weekId);
      entry.incomplete.sort();
      dirtyMeta = true;
    },

    clearIncomplete(source, weekId) {
      const entry = sourceMeta(meta, source);
      const next = entry.incomplete.filter((week) => week !== weekId);
      if (next.length === entry.incomplete.length) return;
      entry.incomplete = next;
      dirtyMeta = true;
    },

    problems() {
      return [...problems];
    },

    unusable() {
      return unusable;
    },

    notices() {
      return [...notices];
    },

    record(source, batch, seenAt) {
      const perWeek = new Map<string, number>();
      let addedEvents = 0;
      let addedSnapshots = 0;

      if (!isSafeSourceName(source)) {
        problems.push(`Ignored everything from a source calling itself "${source}": a source name may only contain a-z, 0-9, dash and underscore.`);
        return { addedEvents, addedSnapshots, perWeek, refusedWeeks: [] };
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

      const refused = new Set<string>();
      for (const event of batch.events) {
        const weekId = weekIdForDate(new Date(event.at));
        // The week's file cannot be rewritten, so an event filed into it would live only
        // in memory — and the watermark would move on as if it had been saved, so the
        // next run would never fetch it again. Dropping it now keeps it fetchable.
        if (unreadable.has(weekId)) {
          refused.add(weekId);
          continue;
        }
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

      for (const weekId of refused) {
        problems.push(`Events for ${weekId} were fetched and thrown away, because ${join(eventsDir, `${weekId}.json`)} cannot be read and so cannot be added to. They will be fetched again once it is repaired or deleted.`);
      }

      return { addedEvents, addedSnapshots, perWeek, refusedWeeks: [...refused].sort() };
    },

    commitState(source) {
      const buffered = pendingState.get(source);
      if (!buffered || buffered.size === 0) return;
      const store = sourceMeta(meta, source).state;
      for (const [key, value] of buffered) {
        if (store[key] === value) continue;
        store[key] = value;
        dirtyMeta = true;
      }
      buffered.clear();
    },

    discardState(source) {
      pendingState.get(source)?.clear();
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
      const next = [...keysFor(weekId)].sort();
      const before = meta.written[weekId];
      if (before && before.length === next.length && next.every((key, i) => before[i] === key)) return;
      meta.written[weekId] = next;
      dirtyMeta = true;
    },

    async save() {
      if (dirtyWeeks.size === 0 && dirtySources.size === 0 && !dirtyMeta) return;

      await mkdir(eventsDir, { recursive: true });
      await mkdir(snapshotsDir, { recursive: true });

      for (const weekId of dirtyWeeks) {
        const week = [...(events.get(weekId) ?? [])].sort(compareEvents);
        events.set(weekId, week);
        const path = insidePath(nodePaths, eventsDir, weekId);
        if (!path || frozen.has(path)) continue;
        await writeJsonAtomic(path, week);
      }
      for (const source of dirtySources) {
        const path = insidePath(nodePaths, snapshotsDir, source);
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
  /**
   * Weeks a source did not finish reading.
   *
   * What did come back is filed, because it belongs where it belongs, but these weeks
   * hold a partial account of themselves and must not be written up from it. They stay
   * owed a write, and the next run asks again.
   */
  incompleteWeeks: Set<string>;
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
  const incompleteWeeks = new Set<string>();
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

    /**
     * File one fetch's answer, and decide what its state was worth.
     *
     * A source writes ETags and cursors while it fetches, and every one of them is a
     * claim to have already seen something. That claim only becomes true when the events
     * that came with it are safely stored: if any were refused, keeping the ETag would
     * have the next fetch answered 304 and the refused events never offered again. So
     * the state is kept when everything was filed and thrown away when it was not.
     */
    const file = (batch: SourceBatch): boolean => {
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

      if (result.refusedWeeks.length > 0) {
        ledger.discardState(source.name);
        return false;
      }
      ledger.commitState(source.name);
      return true;
    };

    // A week whose stored events cannot be rewritten is one whose newly fetched events
    // were just dropped. Recording coverage over it would mean never fetching them again.
    const damaged = new Set(ledger.unreadableWeeks());

    const windowed: string[] = [];
    for (const week of weeks) {
      if (ledger.hasWindow(source.name, week.weekId)) continue;
      const batch = await source.fetchWindow(week.window, ctx);
      file(batch);

      // Whatever came back is kept either way; what an incomplete answer must not buy is
      // the right to stop asking. A window left unmarked costs one repeated first fetch
      // next time, and marking it would cost the part that did not load, for ever.
      if (batch.incomplete || damaged.has(week.weekId)) {
        warnings.push(batch.incomplete
          ? `${source.name} did not finish reading ${week.weekId}, so it will be asked again from the start next time.`
          : `${week.weekId} was fetched but could not be stored, so it will be asked again from the start next time.`);
        incompleteWeeks.add(week.weekId);
        ledger.markIncomplete(source.name, week.weekId);
        continue;
      }

      ledger.markWindow(source.name, week.weekId);
      // A whole window came back, so this week is read up to the moment it was asked.
      ledger.setWatermark(source.name, week.weekId, now);
      ledger.clearIncomplete(source.name, week.weekId);
      windowed.push(week.weekId);
    }

    const delta = weeks.filter((week) => !windowed.includes(week.weekId) && ledger.hasWindow(source.name, week.weekId));
    if (delta.length > 0) {
      const since = deltaStart(ledger, source.name, delta);
      const itemIds = itemsInWeeks(ledger, source.name, delta);
      const batch = await source.fetchSince(since, itemIds, ctx);
      file(batch);

      // The query covered everything from `since` onwards for all of these weeks, so
      // each of them is read at least that far, and further when something later than
      // `since` actually came back. Never past the moment the query was asked, though:
      // one item with a clock-skewed future date would otherwise carry the watermark
      // into next week and take everything committed in between with it. And never to
      // the clock, so a run that sees nothing new has nothing to write. And not at all
      // when the source says it did not finish: coverage it did not have is not coverage.
      if (batch.incomplete) {
        warnings.push(`${source.name} did not finish answering, so the weeks it was asked about keep their reading position and will be asked again.`);
        // Which of them the missing part belonged to is exactly what we do not know, so
        // all of them are held back rather than one guessed at.
        for (const week of delta) {
          incompleteWeeks.add(week.weekId);
          ledger.markIncomplete(source.name, week.weekId);
        }
      } else {
        const read = clamp(since, newest, now);
        for (const week of delta) {
          if (damaged.has(week.weekId)) {
            incompleteWeeks.add(week.weekId);
            ledger.markIncomplete(source.name, week.weekId);
            continue;
          }
          ledger.setWatermark(source.name, week.weekId, read);
          ledger.clearIncomplete(source.name, week.weekId);
        }
      }
    }

    outcome.tookMs = Math.round(performance.now() - startedAt);
    perSource.set(source.name, outcome);
  }

  for (const week of ledger.incompleteWeeks()) incompleteWeeks.add(week);

  return { perSource, weeksChanged, perWeek, incompleteWeeks, warnings };
}

/** No earlier than the range the query covered, and no later than when it was asked. */
function clamp(since: Date, newest: string | undefined, asked: Date): Date {
  if (!newest || newest <= since.toISOString()) return since;
  const seen = new Date(newest);
  return seen > asked ? asked : seen;
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
