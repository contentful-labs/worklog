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
export const FOCUS_LAPSED_STATUS = "lapsed";

/** An item unresolved after this many reviews is closed as lapsed. Two matches the weekly loop. */
export const DEFAULT_LAPSE_AFTER = 2;
/** Ceiling on open items injected into a prompt, so a backlog can never blow it up again. */
export const DEFAULT_INJECT_CAP = 10;

const COLUMNS = ["ID", "Week", "Focus Item", "Status", "Reviews", "Notes"];
const HEADER = renderRow(COLUMNS);
const SEPARATOR = `|${COLUMNS.map(() => "------").join("|")}|`;
const ARCHIVED_HEADING = /^##.*\b(ARCHIVED|HISTORICAL)\b/;
const ID_PATTERN = /^\d{4}-W\d{2}\.\d+$/;
const WEEK_PATTERN = /^\d{4}-W\d{2}$/;
/** Token overlap above this counts as the same suggestion reworded. */
const RESTATEMENT_SIMILARITY = 0.6;

export const FOCUS_TRACKING_TEMPLATE = `# Focus Tracking

Coaching commitments from the weekly review. Open items are re-checked each week and
close as \`lapsed\` after ${DEFAULT_LAPSE_AFTER} reviews without follow-through.

${HEADER}
${SEPARATOR}
`;

/**
 * Drop the target of every markdown link, keeping the label.
 *
 * A scan rather than a `\[([^\]]*)\]\([^)]*\)` regex: that pattern backtracks
 * polynomially on crafted input (CodeQL js/polynomial-redos), and this text comes
 * straight from model output.
 */
function stripLinkTargets(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "]" && text[i + 1] === "(") {
      const end = text.indexOf(")", i + 2);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    result += text[i];
    i++;
  }
  return result;
}

/** Strip markdown down to comparable words. */
export function normalizeFocusText(text: string): string {
  // Bracket syntax is left to the alphanumeric filter below; only the URL has to go,
  // since otherwise every item carrying a Jira link would look alike.
  return stripLinkTargets(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Function words carry no identity, so counting them drags the score of two short
 * rewordings of the same suggestion below the threshold.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was",
  "were", "has", "have", "had", "its", "our", "their", "them", "then", "than", "but", "not",
  "all", "any", "can", "out", "off", "per", "via", "get", "through", "before", "after",
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeFocusText(text)
      .split(" ")
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

/** Below this many significant words, containment is too easy to hit by accident. */
const MIN_TOKENS_FOR_CONTAINMENT = 4;

/**
 * How much two suggestions are the same thing said differently.
 *
 * Jaccard alone is too strict here: one item is usually an elaboration of the other,
 * so the extra ticket numbers and trailing clauses in the longer one drag real
 * duplicates down to ~0.3. Containment (shared / smaller set) separates them cleanly,
 * but it reaches 1.0 whenever the shorter item is tiny, so it is only trusted once
 * both items carry enough substance.
 */
export function focusSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;

  const jaccard = shared / (left.size + right.size - shared);
  const smaller = Math.min(left.size, right.size);
  if (smaller < MIN_TOKENS_FOR_CONTAINMENT) return jaccard;
  return Math.max(jaccard, shared / smaller);
}

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
  const archivedIdx = lines.findIndex((line) => ARCHIVED_HEADING.test(line));
  const limit = archivedIdx === -1 ? lines.length : archivedIdx;

  const separatorIdx = lines.findIndex((line, idx) => idx < limit && isTableSeparator(line));
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

/** Every focus item in the live region, in file order. */
export function parseFocusItems(content: string): FocusItem[] {
  const table = locateLiveTable(content);
  if (!table) return [];
  const items: FocusItem[] = [];
  for (let i = table.rowStart; i < table.rowEnd; i++) {
    const item = rowToItem(splitRow(table.lines[i]), table.hasIds);
    if (item) items.push(item);
  }
  return items;
}

function renderItem(item: FocusItem): string {
  return renderRow([item.id, item.week, item.item, item.status, String(item.reviews), item.notes]);
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

function writeItems(content: string, items: FocusItem[]): string {
  const table = locateLiveTable(content);
  if (!table) return content;
  const lines = [...table.lines];
  lines.splice(table.rowStart, table.rowEnd - table.rowStart, ...items.map(renderItem));
  lines[table.headerIdx] = HEADER;
  lines[table.headerIdx + 1] = SEPARATOR;
  return lines.join("\n");
}

export interface FocusMigrationResult {
  content: string;
  assigned: number;
  collapsed: number;
  lapsed: number;
}

/**
 * Bring a pre-id file up to the current shape: assign ids, collapse rewordings of the
 * same suggestion, and close a backlog that was never reviewable.
 *
 * Open items from the two most recent weeks survive so the live loop keeps running;
 * everything older lapses, because an item nobody has resolved in weeks is not a
 * live commitment, it is history.
 */
export function migrateFocusTracking(content: string): FocusMigrationResult {
  const parsed = parseFocusItems(content);
  if (parsed.length === 0) return { content, assigned: 0, collapsed: 0, lapsed: 0 };

  const recentWeeks = [...new Set(parsed.map((item) => item.week))].sort().slice(-2);
  const kept: FocusItem[] = [];
  let collapsed = 0;
  let lapsed = 0;

  for (const item of parsed) {
    const duplicate = kept.find(
      (candidate) => candidate.week === item.week && focusSimilarity(candidate.item, item.item) >= RESTATEMENT_SIMILARITY,
    );
    if (duplicate) {
      collapsed++;
      continue;
    }
    const next: FocusItem = { ...item, id: nextId(item.week, kept) };
    if (next.status === FOCUS_OPEN_STATUS && !recentWeeks.includes(next.week)) {
      next.status = FOCUS_LAPSED_STATUS;
      next.notes = appendNote(next.notes, "lapsed at migration, never reviewed to a conclusion");
      lapsed++;
    }
    kept.push(next);
  }

  return { content: writeItems(content, kept), assigned: kept.length, collapsed, lapsed };
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
    .filter((item) => item.status === FOCUS_OPEN_STATUS)
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

export interface ApplyFocusResult {
  content: string;
  resolved: number;
  lapsed: number;
  added: number;
  restated: number;
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
  let lapsed = 0;
  let restated = 0;

  const resolvedIds = new Set<string>();
  for (const update of updates) {
    const target = byId.get(update.id);
    if (!target || target.status !== FOCUS_OPEN_STATUS) continue;
    const status = update.status.trim().toLowerCase();
    if (!status || status === FOCUS_OPEN_STATUS) continue;
    target.status = status;
    if (update.notes.trim()) target.notes = appendNote(target.notes, update.notes.trim());
    resolvedIds.add(target.id);
    resolved++;
  }

  // Anything shown to the coach and left unanswered ages toward lapsing. That is the
  // accountability signal: being ignored twice is itself the outcome.
  for (const id of reviewedIds) {
    const target = byId.get(id);
    if (!target || target.status !== FOCUS_OPEN_STATUS || resolvedIds.has(id)) continue;
    target.reviews++;
    if (target.reviews >= lapseAfter) {
      target.status = FOCUS_LAPSED_STATUS;
      target.notes = appendNote(target.notes, `lapsed after ${target.reviews} reviews without follow-through`);
      lapsed++;
    }
  }

  const created: FocusItem[] = [];
  for (const text of newItems) {
    const trimmed = text.trim();
    if (!trimmed) continue;

    const open = [...items, ...created].filter((item) => item.status === FOCUS_OPEN_STATUS);
    const existing = open.find((item) => focusSimilarity(item.item, trimmed) >= RESTATEMENT_SIMILARITY);
    if (existing) {
      // Re-raised rather than new: keep one row, reset its clock, and record the repeat.
      existing.reviews = 0;
      existing.notes = appendNote(existing.notes, `restated ${weekLabel}`);
      restated++;
      continue;
    }

    created.push({
      id: nextId(weekLabel, [...items, ...created]),
      week: weekLabel,
      item: trimmed,
      status: FOCUS_OPEN_STATUS,
      reviews: 0,
      notes: "",
    });
  }

  let next = writeItems(content, items);
  next = appendToFirstTable(next, created.map(renderItem));
  return { content: next, resolved, lapsed, added: created.length, restated };
}
