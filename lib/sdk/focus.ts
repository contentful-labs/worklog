/**
 * Focus tracking: the coach's weekly accountability loop.
 *
 * The feature answers one question each week — "last week I told you to do X, did you?".
 * That makes it a small live set of commitments, not a ledger: 1-2 items in per week,
 * every item resolved within a couple of reviews, and identity stable enough that
 * "close item X" is a reliable operation.
 *
 * Items are therefore keyed by a short id (`2026-W35.1`) rather than by their prose.
 * Matching on the prose is what previously left ~89% of items open forever: the model
 * has to echo a 150-character sentence byte-for-byte for a text match to land.
 */

import { isTableSeparator, splitRow, renderRow, appendToFirstTable } from "./markdown-table";
import { weekIdForDate } from "./week-utils";
import { SIMILARITY_THRESHOLD, canonicalText, textSimilarity } from "./text-similarity";

// Kept under the focus names so existing callers and the SDK barrel do not move.
export { normalizeText as normalizeFocusText, textSimilarity as focusSimilarity } from "./text-similarity";

export interface FocusItem {
  /** Stable short key, `<week>.<n>` — what the model quotes to close an item. */
  id: string;
  week: string;
  item: string;
  status: string;
  /** Times this item has been put in front of the coach without being resolved. */
  reviews: number;
  notes: string;
}

export const FOCUS_OPEN_STATUS = "pending";
export const FOCUS_ONGOING_STATUS = "ongoing";
export const FOCUS_LAPSED_STATUS = "lapsed";

/**
 * "ongoing" is progress, not closure: the coach saw movement and wants to check again
 * next week. Treating it as terminal closed every item the first time it was reviewed.
 */
export function isOpenFocusStatus(status: string): boolean {
  return status === FOCUS_OPEN_STATUS || status === FOCUS_ONGOING_STATUS;
}

/** An item unresolved after this many reviews is closed as lapsed. Two matches the weekly loop. */
export const DEFAULT_LAPSE_AFTER = 2;
/** Ceiling on open items injected into a prompt, so a backlog can never blow it up again. */
export const DEFAULT_INJECT_CAP = 10;

const COLUMNS = ["ID", "Week", "Focus Item", "Status", "Reviews", "Notes"];
/** Pre-id files had these four; anything after them is the user's. */
const LEGACY_COLUMN_COUNT = 4;
const HEADER = renderRow(COLUMNS);
const SEPARATOR = `|${COLUMNS.map(() => "------").join("|")}|`;
const ARCHIVED_WORD = /\b(?:ARCHIVED|HISTORICAL)\b/;

/**
 * A markdown heading (levels 2-6, up to three leading spaces as GFM allows) whose text
 * marks the section as archived. Everything below such a heading is history.
 */
function isArchivedHeading(line: string): boolean {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  let hashes = 0;
  while (line[i + hashes] === "#") hashes++;
  if (hashes < 2 || hashes > 6) return false;
  const after = line[i + hashes];
  if (after !== undefined && after !== " " && after !== "\t") return false;
  return ARCHIVED_WORD.test(line.slice(i + hashes));
}
const ID_PATTERN = /^\d{4}-W\d{2}\.\d+$/;
/**
 * Bumped when the meaning of stored rows changes and existing files need a one-time
 * fix-up. Format 1 (2.0.0) had ids but treated "ongoing" as closed; format 2 keeps
 * ongoing rows open, so files from format 1 need their stale ongoing rows lapsed once.
 */
export const FOCUS_FORMAT_VERSION = 2;
const FORMAT_MARKER_PREFIX = "<!-- worklog-focus-format:";
const FORMAT_MARKER = `${FORMAT_MARKER_PREFIX} ${FOCUS_FORMAT_VERSION} -->`;
const WEEK_PATTERN = /^\d{4}-W\d{2}$/;
/** Token overlap above this counts as the same suggestion reworded. */
const RESTATEMENT_SIMILARITY = SIMILARITY_THRESHOLD;

export const FOCUS_TRACKING_TEMPLATE = `# Focus Tracking
${FORMAT_MARKER}

Coaching commitments from the weekly review. Open items are re-checked each week and
close as \`lapsed\` after ${DEFAULT_LAPSE_AFTER} reviews without follow-through.

${HEADER}
${SEPARATOR}
`;

interface LiveTable {
  lines: string[];
  headerIdx: number;
  rowStart: number;
  /** Exclusive. */
  rowEnd: number;
  hasIds: boolean;
}

/**
 * Locate the table in the live region of the file. Anything under an
 * ARCHIVED/HISTORICAL heading is kept for the record and never touched.
 */
function locateLiveTable(content: string): LiveTable | null {
  const lines = content.split("\n");
  // Nothing inside leading frontmatter is a heading, a table or a marker, whatever it looks like.
  const bodyStart = frontmatterEnd(lines) + 1;
  const archivedIdx = lines.findIndex((line, idx) => idx >= bodyStart && isArchivedHeading(line));
  const limit = archivedIdx === -1 ? lines.length : archivedIdx;

  const separatorIdx = lines.findIndex((line, idx) => idx >= bodyStart && idx < limit && isTableSeparator(line));
  if (separatorIdx <= 0) return null;

  let rowEnd = separatorIdx + 1;
  while (rowEnd < limit && lines[rowEnd].startsWith("|")) rowEnd++;

  const headerCells = splitRow(lines[separatorIdx - 1]).map((cell) => cell.toLowerCase());
  return {
    lines,
    headerIdx: separatorIdx - 1,
    rowStart: separatorIdx + 1,
    rowEnd,
    hasIds: headerCells[0] === "id",
  };
}

function rowToItem(cells: string[], hasIds: boolean): FocusItem | null {
  if (hasIds) {
    const [id, week, item, status, reviews, notes] = cells;
    if (!ID_PATTERN.test(id ?? "") || !item) return null;
    return {
      id,
      week: week || id.split(".")[0],
      item,
      status: (status || FOCUS_OPEN_STATUS).toLowerCase(),
      reviews: Number.parseInt(reviews ?? "", 10) || 0,
      notes: notes ?? "",
    };
  }
  const [week, item, status, notes] = cells;
  if (!WEEK_PATTERN.test(week ?? "") || !item) return null;
  return { id: "", week, item, status: (status || FOCUS_OPEN_STATUS).toLowerCase(), reviews: 0, notes: notes ?? "" };
}

/**
 * Which line each parsed item came from, so updates can be written back in place and
 * lines that are not focus rows (hand-edited, malformed) are left exactly as found.
 */
const rowSourceOf = new WeakMap<FocusItem, { line: number; extraCells: string[] }>();

/** Every focus item in the live region, in file order. */
export function parseFocusItems(content: string): FocusItem[] {
  const table = locateLiveTable(content);
  if (!table) return [];
  const items: FocusItem[] = [];
  for (let i = table.rowStart; i < table.rowEnd; i++) {
    const cells = splitRow(table.lines[i]);
    const item = rowToItem(cells, table.hasIds);
    if (!item) continue;
    // Cells past the ones we manage belong to the user; carry them through untouched.
    const managed = table.hasIds ? COLUMNS.length : LEGACY_COLUMN_COUNT;
    rowSourceOf.set(item, { line: i, extraCells: cells.slice(managed) });
    items.push(item);
  }
  return items;
}

/** Line numbers (0-based) in the live table that are not parseable focus rows. */
function unparseableRowLines(content: string): number[] {
  const table = locateLiveTable(content);
  if (!table) return [];
  const bad: number[] = [];
  for (let i = table.rowStart; i < table.rowEnd; i++) {
    if (!rowToItem(splitRow(table.lines[i]), table.hasIds)) bad.push(i);
  }
  return bad;
}

function renderItem(item: FocusItem, extraCells: string[] = []): string {
  return renderRow([item.id, item.week, item.item, item.status, String(item.reviews), item.notes, ...extraCells]);
}

/** Next free id for a week, given the items already present. */
function nextId(week: string, items: FocusItem[]): string {
  let max = 0;
  for (const item of items) {
    if (item.week !== week) continue;
    const suffix = Number.parseInt(item.id.split(".")[1] ?? "", 10);
    if (Number.isFinite(suffix) && suffix > max) max = suffix;
  }
  return `${week}.${max + 1}`;
}

/** True when the file predates ids and needs migrating before use. */
export function needsFocusMigration(content: string): boolean {
  const table = locateLiveTable(content);
  return table !== null && !table.hasIds;
}

/**
 * Write items back to the lines they were parsed from. Lines in the table that are not
 * focus rows stay untouched, so a hand-edited row can never be lost by an update.
 */
function writeItemsInPlace(content: string, items: FocusItem[]): string {
  const table = locateLiveTable(content);
  if (!table) return content;
  const lines = [...table.lines];
  for (const item of items) {
    const source = rowSourceOf.get(item);
    if (source) lines[source.line] = renderItem(item, source.extraCells);
  }
  // A header wider than ours means the user added columns; leave their header alone.
  if (splitRow(lines[table.headerIdx]).length <= COLUMNS.length) {
    lines[table.headerIdx] = HEADER;
    lines[table.headerIdx + 1] = SEPARATOR;
  }
  return lines.join("\n");
}

/**
 * Replace the whole live table. Only for migrations, which may drop rows on purpose and
 * which refuse to run when any row would be dropped by accident.
 */
function rebuildTable(content: string, items: FocusItem[]): string {
  const table = locateLiveTable(content);
  if (!table) return content;
  const lines = [...table.lines];
  lines.splice(
    table.rowStart,
    table.rowEnd - table.rowStart,
    ...items.map((item) => renderItem(item, rowSourceOf.get(item)?.extraCells ?? [])),
  );
  const managed = table.hasIds ? COLUMNS.length : LEGACY_COLUMN_COUNT;
  const extraHeader = splitRow(lines[table.headerIdx]).slice(managed);
  lines[table.headerIdx] = renderRow([...COLUMNS, ...extraHeader]);
  lines[table.headerIdx + 1] = `|${[...COLUMNS, ...extraHeader].map(() => "------").join("|")}|`;
  return lines.join("\n");
}

/** Open items younger than this stay open through a migration; older ones are history. */
const MIGRATION_KEEP_WEEKS = 2;

function defaultKeepSinceWeek(now = new Date()): string {
  return weekIdForDate(new Date(now.getTime() - MIGRATION_KEEP_WEEKS * 7 * 24 * 60 * 60 * 1000));
}

/**
 * The lines above the live table and above any archived heading. Only these can carry
 * the format marker; anything below belongs to the table or to an archived era and is
 * never read as metadata nor rewritten.
 */
function preambleEnd(lines: string[]): number {
  const bodyStart = frontmatterEnd(lines) + 1;
  const archivedIdx = lines.findIndex((line, idx) => idx >= bodyStart && isArchivedHeading(line));
  const separatorIdx = lines.findIndex((line, idx) => idx >= bodyStart && isTableSeparator(line));
  const candidates = [archivedIdx, separatorIdx > 0 ? separatorIdx - 1 : separatorIdx].filter((i) => i !== -1);
  return candidates.length === 0 ? lines.length : Math.min(...candidates);
}

function markerLines(lines: string[]): number[] {
  const end = preambleEnd(lines);
  const found: number[] = [];
  for (let i = frontmatterEnd(lines) + 1; i < end; i++) if (lines[i].trim().startsWith(FORMAT_MARKER_PREFIX)) found.push(i);
  return found;
}

/** Version from the marker line in the live preamble, or null when the file has none. */
export function focusFormatVersion(content: string): number | null {
  const lines = content.split("\n");
  const markers = markerLines(lines);
  if (markers.length > 1) {
    throw new Error(`focus-tracking.md has ${markers.length} format markers; keep one`);
  }
  for (const idx of markers) {
    const line = lines[idx].trim();
    // The whole marker must be exactly `<!-- worklog-focus-format: <digits> -->`; anything
    // looser (odd spacing, a suffix, a decimal, a missing close) is corruption, not a version.
    const digits = line.slice(FORMAT_MARKER_PREFIX.length + 1, -4);
    const valid =
      digits.length > 0 &&
      [...digits].every((char) => char >= "0" && char <= "9") &&
      line === `${FORMAT_MARKER_PREFIX} ${digits} -->`;
    if (!valid) {
      throw new Error(`focus-tracking.md has an unreadable format marker: ${line}`);
    }
    return Number.parseInt(digits, 10);
  }
  return null;
}

function hasFormatMarker(content: string): boolean {
  return focusFormatVersion(content) === FOCUS_FORMAT_VERSION;
}

function assertNotNewerFormat(content: string): void {
  const version = focusFormatVersion(content);
  if (version !== null && version > FOCUS_FORMAT_VERSION) {
    throw new Error(
      `focus-tracking.md is format ${version}; this version of worklog understands up to ${FOCUS_FORMAT_VERSION}. Upgrade worklog.`,
    );
  }
}

/**
 * Index of the line closing a leading YAML frontmatter block, or -1 when there is none.
 * Delimiters sit at column 0; an indented `---` is content inside the block, not its end.
 */
function frontmatterEnd(lines: string[]): number {
  const isDelimiter = (line: string) => line === "---" || line === "---\r";
  if (!isDelimiter(lines[0] ?? "")) return -1;
  for (let i = 1; i < lines.length; i++) if (isDelimiter(lines[i])) return i;
  return -1;
}

/**
 * Put the format marker under the top heading; failing that, under the frontmatter;
 * failing that, at the top. Never above frontmatter, which would stop it being
 * frontmatter.
 */
function stampFormat(content: string): string {
  if (hasFormatMarker(content)) return content;
  const lines = content.split("\n");
  // Only preamble markers are ours to replace; a marker-looking line under an archived
  // heading is archived content and stays exactly as it is.
  for (const idx of markerLines(lines).reverse()) lines.splice(idx, 1);
  const end = preambleEnd(lines);
  const fmEnd = frontmatterEnd(lines);
  const headingIdx = lines.findIndex((line, i) => i > fmEnd && i < end && line.startsWith("# "));
  const insertAt = headingIdx !== -1 ? headingIdx + 1 : fmEnd + 1;
  lines.splice(insertAt, 0, FORMAT_MARKER);
  return lines.join("\n");
}



export interface FocusMigrationResult {
  content: string;
  assigned: number;
  collapsed: number;
  lapsed: number;
  /**
   * Rows kept side by side that read like each other.
   *
   * A score cannot tell "Document C++ build process" from "Review C++ build process",
   * and this pass deletes lines from a file the user owns, so it collapses only rows
   * that say the same thing and reports the rest for them to judge.
   */
  nearDuplicates: NearDuplicateFocusItem[];
}

/**
 * Bring a pre-id file up to the current shape: assign ids, collapse rewordings of the
 * same suggestion, and close a backlog that was never reviewable.
 *
 * Open items from `keepSinceWeek` on survive so the live loop keeps running; everything
 * older lapses, because an item nobody has resolved in weeks is not a live commitment,
 * it is history. The cutoff comes from the calendar, not from the file: a file whose
 * newest rows are all stale must still lapse them.
 */
export function migrateFocusTracking(content: string, keepSinceWeek: string = defaultKeepSinceWeek()): FocusMigrationResult {
  assertNotNewerFormat(content);
  const bad = unparseableRowLines(content);
  if (bad.length > 0) {
    throw new Error(
      `focus-tracking.md has ${bad.length} row(s) that are not focus items (first at line ${bad[0] + 1}); ` +
      "fix or move them below an ARCHIVED heading before migrating",
    );
  }

  const parsed = parseFocusItems(content);
  // An empty legacy table still needs its header rewritten, or it would migrate on every run.
  if (parsed.length === 0) {
    return { content: stampFormat(rebuildTable(content, [])), assigned: 0, collapsed: 0, lapsed: 0, nearDuplicates: [] };
  }

  const kept: FocusItem[] = [];
  const nearDuplicates: NearDuplicateFocusItem[] = [];
  let collapsed = 0;
  let lapsed = 0;

  // Pass 1: collapse duplicates while every row still carries its original status, so two
  // stale pending rows compare equal before either of them is lapsed.
  for (const item of parsed) {
    // Collapse into a row that says the same thing and would lose nothing the user
    // typed. Same words only: a row that merely reads alike is another commitment.
    const canonical = canonicalText(item.item);
    const duplicate = kept.find(
      (candidate) =>
        candidate.week === item.week &&
        canonicalText(candidate.item) === canonical &&
        carriesNothingBeyond(item, candidate),
    );
    if (duplicate) {
      collapsed++;
      continue;
    }

    const near = kept.find(
      (candidate) =>
        candidate.week === item.week && textSimilarity(candidate.item, item.item) >= RESTATEMENT_SIMILARITY,
    );
    if (near) nearDuplicates.push({ item: item.item, candidateId: near.id });
    // Mutate rather than copy: the row's source position and extra cells are keyed on identity.
    item.id = nextId(item.week, kept);
    kept.push(item);
  }

  // Pass 2: close the backlog that predates the grace window.
  for (const item of kept) {
    if (isOpenFocusStatus(item.status) && item.week < keepSinceWeek) {
      item.status = FOCUS_LAPSED_STATUS;
      item.notes = appendNote(item.notes, "lapsed at migration, never reviewed to a conclusion");
      lapsed++;
    }
  }

  return {
    content: stampFormat(rebuildTable(content, kept)),
    assigned: kept.length,
    collapsed,
    lapsed,
    nearDuplicates,
  };
}

/** A duplicate row can go only if its outcome, notes and user cells are empty or already on the kept row. */
function carriesNothingBeyond(item: FocusItem, kept: FocusItem): boolean {
  if (item.status !== kept.status) return false;
  const notesSafe = item.notes.trim() === "" || item.notes.trim() === kept.notes.trim();
  const extra = rowSourceOf.get(item)?.extraCells ?? [];
  const keptExtra = rowSourceOf.get(kept)?.extraCells ?? [];
  const extraSafe = extra.every((cell, i) => cell.trim() === "" || cell.trim() === (keptExtra[i] ?? "").trim());
  return notesSafe && extraSafe;
}

/** True for an id-keyed file written by an older format. Throws on a newer one. */
export function needsFocusFormatUpgrade(content: string): boolean {
  assertNotNewerFormat(content);
  const table = locateLiveTable(content);
  return Boolean(table?.hasIds) && !hasFormatMarker(content);
}

/**
 * One-time fix-up for files migrated by 2.0.0: their stale "ongoing" rows were treated as
 * closed then and would all count as open now, crowding out current commitments.
 */
export function upgradeFocusFormat(content: string, keepSinceWeek: string = defaultKeepSinceWeek()): { content: string; lapsed: number } {
  assertNotNewerFormat(content);
  const { content: lapsedContent, lapsed } = lapseStaleOpenFocusItems(content, keepSinceWeek);
  return { content: stampFormat(lapsedContent), lapsed };
}

function appendNote(notes: string, addition: string): string {
  const trimmed = notes.trim();
  return trimmed ? `${trimmed}; ${addition}` : addition;
}

/**
 * Open items to put in front of the coach, oldest first so the longest-outstanding
 * commitments are the ones that get answered.
 */
export function selectOpenFocusItems(content: string, cap: number = DEFAULT_INJECT_CAP): FocusItem[] {
  return parseFocusItems(content)
    .filter((item) => isOpenFocusStatus(item.status))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, cap);
}

/**
 * One line of history so the coach can still spot a pattern ("you keep dropping these")
 * without every past row riding along in the prompt.
 */
export function summarizeFocusHistory(content: string, sinceWeek: string): string {
  const items = parseFocusItems(content).filter((item) => item.week >= sinceWeek);
  if (items.length === 0) return "";
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([status, n]) => `${n} ${status}`);
  return `Since ${sinceWeek}: ${items.length} focus items — ${parts.join(", ")}.`;
}

/**
 * Lapse open items older than `keepSinceWeek`. Used by the migration, and directly on
 * files that migrated before "ongoing" counted as open and so kept stale ongoing rows.
 */
export function lapseStaleOpenFocusItems(content: string, keepSinceWeek: string): { content: string; lapsed: number } {
  const items = parseFocusItems(content);
  let lapsed = 0;
  for (const item of items) {
    if (!isOpenFocusStatus(item.status) || item.week >= keepSinceWeek) continue;
    const previous = item.status;
    item.status = FOCUS_LAPSED_STATUS;
    item.notes = appendNote(item.notes, `lapsed: still ${previous} at ${keepSinceWeek}`);
    lapsed++;
  }
  return { content: lapsed ? writeItemsInPlace(content, items) : content, lapsed };
}

export interface FocusStatusUpdate {
  id: string;
  status: string;
  notes: string;
}

export interface ApplyFocusOptions {
  /** Ids that were injected into this week's prompt. */
  reviewedIds: string[];
  updates: FocusStatusUpdate[];
  newItems: string[];
  weekLabel: string;
  lapseAfter?: number;
}

/** A new item that reads like one already open, recorded for the user to judge. */
export interface NearDuplicateFocusItem {
  item: string;
  /** Id of the open item it reads like. */
  candidateId: string;
}

export interface ApplyFocusResult {
  content: string;
  /** Closed with a terminal status this week. */
  resolved: number;
  /** Reported as ongoing: still open, review clock reset. */
  carried: number;
  lapsed: number;
  added: number;
  restated: number;
  /**
   * Items that were added even though an open item scores as similar.
   *
   * Reported rather than merged: a score cannot tell "Document C++ build process" from
   * "Review C++ build process", and folding the second into the first loses a task the
   * coach asked for. The user decides.
   */
  nearDuplicates: NearDuplicateFocusItem[];
}

/**
 * Apply one week's outcome: record the statuses the coach returned, age the items it
 * ignored, and record the new commitments.
 */
export function applyFocusUpdates(content: string, options: ApplyFocusOptions): ApplyFocusResult {
  const { reviewedIds, updates, newItems, weekLabel, lapseAfter = DEFAULT_LAPSE_AFTER } = options;
  const items = parseFocusItems(content);
  const byId = new Map(items.map((item) => [item.id, item]));

  let resolved = 0;
  let carried = 0;
  let lapsed = 0;
  let restated = 0;

  const answeredIds = new Set<string>();
  for (const update of updates) {
    const target = byId.get(update.id);
    // A second row for the same id is a model slip, not a second opinion.
    if (!target || !isOpenFocusStatus(target.status) || answeredIds.has(update.id)) continue;
    const status = update.status.trim().toLowerCase();
    if (!status || status === FOCUS_OPEN_STATUS) continue;
    target.status = status;
    if (update.notes.trim()) target.notes = appendNote(target.notes, update.notes.trim());
    answeredIds.add(target.id);
    if (status === FOCUS_ONGOING_STATUS) {
      target.reviews = 0;
      carried++;
    } else {
      resolved++;
    }
  }

  // Anything shown to the coach and left unanswered ages toward lapsing. That is the
  // accountability signal: being ignored twice is itself the outcome.
  for (const id of reviewedIds) {
    const target = byId.get(id);
    if (!target || !isOpenFocusStatus(target.status) || answeredIds.has(id)) continue;
    target.reviews++;
    if (target.reviews >= lapseAfter) {
      target.status = FOCUS_LAPSED_STATUS;
      target.notes = appendNote(target.notes, `lapsed after ${target.reviews} reviews without follow-through`);
      lapsed++;
    }
  }

  const created: FocusItem[] = [];
  const nearDuplicates: NearDuplicateFocusItem[] = [];
  for (const text of newItems) {
    const trimmed = text.trim();
    if (!trimmed) continue;

    const open = [...items, ...created].filter((item) => isOpenFocusStatus(item.status));
    const canonical = canonicalText(trimmed);
    const existing = open.find((item) => canonicalText(item.item) === canonical);
    if (existing) {
      // Re-raised word for word: keep one row, reset its clock, and record the repeat.
      existing.reviews = 0;
      existing.notes = appendNote(existing.notes, `restated ${weekLabel}`);
      restated++;
      continue;
    }

    // Anything short of the same text is a new commitment. The score still has
    // something useful to say about it, so say it rather than act on it.
    const near = open.find((item) => textSimilarity(item.item, trimmed) >= RESTATEMENT_SIMILARITY);
    if (near) nearDuplicates.push({ item: trimmed, candidateId: near.id });

    created.push({
      id: nextId(weekLabel, [...items, ...created]),
      week: weekLabel,
      item: trimmed,
      status: FOCUS_OPEN_STATUS,
      reviews: 0,
      notes: "",
    });
  }

  let next = writeItemsInPlace(content, items);
  next = appendToFirstTable(next, created.map((item) => renderItem(item)));
  return { content: next, resolved, carried, lapsed, added: created.length, restated, nearDuplicates };
}
