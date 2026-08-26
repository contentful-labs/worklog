/**
 * Writers for the auto-maintained vault files.
 *
 * Every one of these files is written once a week from model output, so two things
 * are true of all of them: the model sometimes has nothing to say and says so with a
 * placeholder, and it re-raises the same point in different words week after week.
 * Left ungated that produced 201 `- (none)` rows in my-profile.md and 24 duplicate
 * bullets in work-context.md. The record gate below is the single place both are
 * stopped, which also makes applying the same week twice a no-op.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { BragBookResult } from "./brag-book";

import { appendToFirstTable, findTable, renderRow, splitRow } from "./markdown-table";
import { weekIdForDate } from "./week-utils";
import {
  PROSE_SIMILARITY_THRESHOLD,
  SIMILARITY_THRESHOLD,
  canonicalText,
  normalizeText,
  textSimilarity,
} from "./text-similarity";
import {
  FOCUS_TRACKING_TEMPLATE,
  applyFocusUpdates,
  migrateFocusTracking,
  needsFocusMigration,
  needsFocusFormatUpgrade,
  upgradeFocusFormat,
  type ApplyFocusResult,
} from "./focus";

const MEMORY_TEMPLATE = `# Memory - Small Contributions Awaiting Significance

Contributions here are waiting to accumulate into something brag-worthy.

| Date | Item | Category | Notes |
|------|------|----------|-------|
`;

/** Column indexes in a memory row: `| Date | Item | Category | Notes |`. */
const MEMORY_ITEM_COLUMN = 1;
const MEMORY_NOTES_COLUMN = 3;
/** Column indexes in an impact row: `| Date | Achievement | Scope | Core Value | Evidence |`. */
const IMPACT_SCOPE_COLUMN = 2;
const IMPACT_VALUE_COLUMN = 3;
const IMPACT_EVIDENCE_COLUMN = 4;
/** How the prompt asks the model to mark a graduated memory item. */
const GRADUATION_MARKER = "(now part of";

const IMPACT_TIMELINE_HEADING = "## Impact Timeline";
const ORG_NOTES_HEADING = "## Organizational Notes";
const KEY_STRENGTHS_HEADING = "## Key Strengths";
const LAST_IMPACT_PREFIX = "**Last significant impact:**";
const CURRENT_GAP_PREFIX = "**Current gap:**";
const LAST_UPDATED_PREFIX = "*Last updated:";

/** Bare words the model writes when it means "nothing to record". */
const PLACEHOLDER_WORDS = new Set(["none", "n a", "na", "nil", "nothing", "tbd", "todo", "unknown"]);

/**
 * Openings of the parenthesised asides the prompt and the seed templates use.
 * Only these count: a parenthesised value is not a placeholder by itself, or a real
 * strength such as "(Acting tech lead)" would be thrown away.
 */
const PLACEHOLDER_PREFIXES = ["leave blank", "added automatically", "none", "nothing", "n a", "tbd", "todo"];

const DECORATION_CHARS = new Set(["_", "*", "`", " ", "\t"]);

/** Strip the emphasis around a value so its content can be judged. */
function stripDecoration(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && DECORATION_CHARS.has(text[start])) start++;
  while (end > start && DECORATION_CHARS.has(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * True for text that carries no information: blank, a known sentinel such as `(none)`
 * or `(leave blank if none)`, or a template hint left in place.
 *
 * Checked by scanning rather than matching a pattern, because the text is model
 * output and a regex over it is what CodeQL flags.
 */
export function isPlaceholder(text: string): boolean {
  const core = stripDecoration(text);
  if (core.length === 0) return true;
  if (core.startsWith("<!--") && core.endsWith("-->")) return true;

  const parenthesised = core.startsWith("(") && core.endsWith(")");
  const inner = parenthesised ? core.slice(1, -1) : core;
  const words = normalizeText(inner);
  // No words at all: "()" is a sentinel, but a note written in a non-Latin script is not.
  if (words.length === 0) return parenthesised;
  if (PLACEHOLDER_WORDS.has(words)) return true;
  return parenthesised && PLACEHOLDER_PREFIXES.some((prefix) => words.startsWith(prefix));
}

const NO_EXCLUSIONS: ReadonlySet<number> = new Set<number>();

/**
 * Index of the record that is the same as `target`, or -1.
 *
 * Identity is normalized equality first, then the containment score, because the model
 * rewords its own entries between runs and an exact-string check would let every
 * rewording through as new.
 */
function findRecordIndex(
  texts: readonly string[],
  target: string,
  excluded: ReadonlySet<number>,
  threshold: number,
): number {
  const normalizedTarget = normalizeText(target);
  if (normalizedTarget.length === 0) return -1;

  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < texts.length; i++) {
    if (excluded.has(i)) continue;
    const candidate = normalizeText(texts[i]);
    if (candidate.length === 0) continue;
    if (candidate === normalizedTarget) return i;
    const score = textSimilarity(candidate, normalizedTarget);
    if (score >= threshold && score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Fold a newer value into the stored one without losing either.
 *
 * A rerun of the same week often carries more evidence than the first run did
 * ("TEAM-1234" becoming "TEAM-1234, TEAM-1235"). Dropping the second because the
 * record is already there would throw that away. Folding is stable: once merged, the
 * stored value contains the incoming one and nothing changes again.
 */
function mergeCell(stored: string, incoming: string): string {
  const kept = stored.trim();
  const next = incoming.trim();
  if (next.length === 0 || isPlaceholder(next)) return stored;
  if (kept.length === 0) return next;

  const keptCanonical = canonicalText(kept);
  const nextCanonical = canonicalText(next);
  if (keptCanonical === nextCanonical) return stored;
  if (nextCanonical.includes(keptCanonical)) return next;
  if (keptCanonical.includes(nextCanonical)) return stored;
  return `${kept}, ${next}`;
}

/** Re-render `row` with the named columns folded in, or null when nothing changed. */
function mergeRowCells(row: string, incoming: readonly string[], columns: readonly number[]): string | null {
  const cells = splitRow(row);
  let changed = false;

  for (const column of columns) {
    while (cells.length <= column) cells.push("");
    const merged = mergeCell(cells[column], incoming[column] ?? "");
    if (merged === cells[column]) continue;
    cells[column] = merged;
    changed = true;
  }

  return changed ? renderRow(cells) : null;
}

/** Cell of a table row, or "" when the row is shorter than expected. */
function rowCell(row: string, index: number): string {
  return splitRow(row)[index] ?? "";
}

/** True for the heading that opens an archived or historical era. */
function isArchivedHeading(line: string): boolean {
  return line.startsWith("##") && (line.includes("ARCHIVED") || line.includes("HISTORICAL"));
}

/**
 * Where the live part of a vault file stops. Everything below an archived heading is
 * kept for the record: a row, a table or a status line down there belongs to a team era
 * that has ended, and rewriting it would rewrite history.
 */
function liveRegionEnd(lines: readonly string[]): number {
  const idx = lines.findIndex(isArchivedHeading);
  return idx === -1 ? lines.length : idx;
}

/** Where a `## ` section ends: the next heading, the closing rule, or end of file. */
function sectionEnd(lines: readonly string[], headingIdx: number): number {
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") || lines[i].trim() === "---") return i;
  }
  return lines.length;
}

/** Index of the live `## ` heading that starts with `heading`, or -1. */
function findHeading(lines: readonly string[], heading: string, limit: number): number {
  for (let i = 0; i < limit; i++) {
    if (lines[i].startsWith(heading)) return i;
  }
  return -1;
}

/** Rewrite the first live line starting with `prefix`. Returns whether anything changed. */
function replaceFirstLine(lines: string[], limit: number, prefix: string, replacement: string): boolean {
  for (let i = 0; i < limit; i++) {
    if (!lines[i].startsWith(prefix)) continue;
    if (lines[i] === replacement) return false;
    lines[i] = replacement;
    return true;
  }
  return false;
}

/** A file last edited on Windows keeps its CRLF endings, so generated lines must match. */
function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function toLines(content: string): string[] {
  return content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isBullet(line: string): boolean {
  return line.startsWith("- ");
}

/**
 * The part of an organizational note that identifies it.
 * Bullets read `- **Category:** info _(source)_`; the category and source repeat across
 * unrelated notes, so only the info decides whether the note is already there.
 */
function orgNoteText(bullet: string): string {
  let text = bullet.slice(2);
  if (text.startsWith("**")) {
    const labelEnd = text.indexOf("**", 2);
    if (labelEnd !== -1) text = text.slice(labelEnd + 2);
  }
  const trimmed = text.trim();
  if (trimmed.endsWith(")_")) {
    const sourceStart = trimmed.lastIndexOf("_(");
    if (sourceStart !== -1) return trimmed.slice(0, sourceStart).trim();
  }
  return trimmed;
}

/** Fold a source into the `_(...)_` suffix of an existing note, or null when unchanged. */
function mergeNoteSource(bullet: string, source: string): string | null {
  const trimmed = bullet.trimEnd();
  if (!trimmed.endsWith(")_")) return null;
  const start = trimmed.lastIndexOf("_(");
  if (start === -1) return null;

  const stored = trimmed.slice(start + 2, trimmed.length - 2);
  const merged = mergeCell(stored, source);
  return merged === stored ? null : `${trimmed.slice(0, start)}_(${merged})_`;
}

export async function updateMemory(memoryPath: string, itemsToAdd: string[], itemsToRemove: string[]): Promise<void> {
  const original = existsSync(memoryPath) ? await readFile(memoryPath, "utf-8") : MEMORY_TEMPLATE;
  const eol = detectEol(original);
  const lines = toLines(original);

  const table = findTable(lines);
  const rows = table ? lines.slice(table.rowStart, table.rowEnd) : [];
  const items = rows.map((row) => rowCell(row, MEMORY_ITEM_COLUMN));

  // Graduation. The model paraphrases the row it is closing, so matching by
  // `includes()` on its prose almost never landed: 17 hits in 27 weeks. This is a
  // lookup of a row the model named, so it uses the lower restatement threshold and
  // takes the single best match.
  const graduated = new Set<number>();
  for (const removal of itemsToRemove) {
    const marker = removal.indexOf(GRADUATION_MARKER);
    const target = (marker === -1 ? removal : removal.slice(0, marker)).trim();
    const idx = findRecordIndex(items, target, graduated, SIMILARITY_THRESHOLD);
    if (idx !== -1) graduated.add(idx);
  }

  const kept = rows.filter((_, i) => !graduated.has(i));
  const keptItems = kept.map((row) => rowCell(row, MEMORY_ITEM_COLUMN));
  const newRows: string[] = [];

  for (const row of itemsToAdd) {
    if (!row.includes("|")) continue;
    const incoming = splitRow(row);
    const item = incoming[MEMORY_ITEM_COLUMN] ?? "";
    if (isPlaceholder(item)) continue;

    const idx = findRecordIndex(keptItems, item, NO_EXCLUSIONS, PROSE_SIMILARITY_THRESHOLD);
    if (idx === -1) {
      newRows.push(row);
      keptItems.push(item);
      continue;
    }
    const merged = mergeRowCells(kept[idx], incoming, [MEMORY_NOTES_COLUMN]);
    if (merged) kept[idx] = merged;
  }

  if (table) lines.splice(table.rowStart, table.rowEnd - table.rowStart, ...kept);
  const next = appendToFirstTable(lines.join("\n"), newRows);

  await writeFile(memoryPath, next.split("\n").join(eol), "utf-8");
}

/**
 * Record one achievement in the impact timeline.
 *
 * Returns false when there is nothing to record or the live `## Impact Timeline`
 * section is missing, so a caller can warn instead of the row landing in whatever
 * table happened to come first in the file.
 */
export async function updateImpactLog(impactLogPath: string, entry: BragBookResult["impactLogEntry"]): Promise<boolean> {
  if (!entry || isPlaceholder(entry.achievement)) return false;

  const original = await readFile(impactLogPath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const liveEnd = liveRegionEnd(lines);

  const headingIdx = findHeading(lines, IMPACT_TIMELINE_HEADING, liveEnd);
  if (headingIdx === -1) return false;
  const table = findTable(lines, headingIdx);
  if (!table || table.rowStart > liveEnd) return false;

  // The status lines are rewritten first, and only the live copy of each: an archived
  // era carries its own, and those record what was true when that era ended.
  replaceFirstLine(lines, liveEnd, LAST_IMPACT_PREFIX, `${LAST_IMPACT_PREFIX} ${entry.date}`);
  replaceFirstLine(lines, liveEnd, CURRENT_GAP_PREFIX, `${CURRENT_GAP_PREFIX} None - recent entry added`);

  const rowEnd = Math.min(table.rowEnd, liveEnd);
  const rows = lines.slice(table.rowStart, rowEnd);
  const incoming = [entry.date, entry.achievement, entry.scope, entry.coreValue, entry.evidence];
  // Same achievement on the same date is the same entry, whatever the wording.
  const keys = rows.map((row) => `${rowCell(row, 0)} ${rowCell(row, 1)}`);
  const idx = findRecordIndex(keys, `${entry.date} ${entry.achievement}`, NO_EXCLUSIONS, PROSE_SIMILARITY_THRESHOLD);

  if (idx === -1) {
    lines.splice(rowEnd, 0, renderRow(incoming));
  } else {
    const merged = mergeRowCells(rows[idx], incoming, [IMPACT_SCOPE_COLUMN, IMPACT_VALUE_COLUMN, IMPACT_EVIDENCE_COLUMN]);
    if (merged) lines[table.rowStart + idx] = merged;
  }

  await writeFile(impactLogPath, lines.join(eol), "utf-8");
  return true;
}

export async function updateWorkContext(
  workContextPath: string,
  updates: BragBookResult["workContextUpdates"],
  now: Date = new Date(),
): Promise<void> {
  if (updates.length === 0) return;

  const original = await readFile(workContextPath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const liveEnd = liveRegionEnd(lines);

  const headingIdx = findHeading(lines, ORG_NOTES_HEADING, liveEnd);
  if (headingIdx === -1) return;

  const end = Math.min(sectionEnd(lines, headingIdx), liveEnd);
  const bulletLines: number[] = [];
  for (let i = headingIdx + 1; i < end; i++) if (isBullet(lines[i])) bulletLines.push(i);
  const notes = bulletLines.map((i) => orgNoteText(lines[i]));

  const bullets: string[] = [];
  let changed = false;

  for (const update of updates) {
    if (isPlaceholder(update.info)) continue;
    const idx = findRecordIndex(notes, update.info, NO_EXCLUSIONS, PROSE_SIMILARITY_THRESHOLD);

    if (idx === -1) {
      bullets.push(`- **${update.category}:** ${update.info} _(${update.source})_`);
      notes.push(update.info);
      continue;
    }
    // Beyond that range the match is a note queued in this same batch, which carries
    // its own source already.
    if (idx >= bulletLines.length) continue;
    const merged = mergeNoteSource(lines[bulletLines[idx]], update.source);
    if (merged) {
      lines[bulletLines[idx]] = merged;
      changed = true;
    }
  }

  if (bullets.length > 0) {
    let insertAt = headingIdx + 1;
    if (lines[insertAt]?.trim() === "") insertAt++;
    lines.splice(insertAt, 0, ...bullets);
    changed = true;
    // The stamp says when a note was last added, so it only moves when one was. Moving
    // it on every run made a rerun of the same week differ from the first run.
    const stamp = now.toISOString().split("T")[0];
    replaceFirstLine(lines, liveRegionEnd(lines), LAST_UPDATED_PREFIX, `*Last updated: ${stamp}*`);
  }

  if (!changed) return;
  await writeFile(workContextPath, lines.join(eol), "utf-8");
}

export async function updateProfile(profilePath: string, update: BragBookResult["profileUpdate"]): Promise<void> {
  if (!update || isPlaceholder(update.bulletPoint)) return;

  const original = await readFile(profilePath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const liveEnd = liveRegionEnd(lines);

  const headingIdx = findHeading(lines, KEY_STRENGTHS_HEADING, liveEnd);
  if (headingIdx === -1) return;

  const end = Math.min(sectionEnd(lines, headingIdx), liveEnd);
  const existing: string[] = [];
  for (let i = headingIdx + 1; i < end; i++) if (isBullet(lines[i])) existing.push(lines[i].slice(2));
  if (findRecordIndex(existing, update.bulletPoint, NO_EXCLUSIONS, PROSE_SIMILARITY_THRESHOLD) !== -1) return;

  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `- ${update.bulletPoint}`);

  await writeFile(profilePath, lines.join(eol), "utf-8");
}

export async function updateFocusTracking(
  focusTrackingPath: string,
  options: {
    focusItems: string[];
    focusUpdates: BragBookResult["focusUpdates"];
    reviewedIds: string[];
    weekLabel: string;
    lapseAfter?: number;
  },
): Promise<ApplyFocusResult> {
  const content = existsSync(focusTrackingPath)
    ? await readFile(focusTrackingPath, "utf-8")
    : FOCUS_TRACKING_TEMPLATE;

  const result = applyFocusUpdates(content, {
    reviewedIds: options.reviewedIds,
    updates: options.focusUpdates,
    newItems: options.focusItems,
    weekLabel: options.weekLabel,
    lapseAfter: options.lapseAfter,
  });

  await writeFile(focusTrackingPath, result.content, "utf-8");
  return result;
}

/**
 * Bring a pre-id focus-tracking file up to the current shape, keeping a one-time backup
 * because the file is owned by the user, not by us.
 */
export interface FocusFileMigration {
  kind: "ids" | "format";
  backup: string;
  assigned: number;
  collapsed: number;
  lapsed: number;
}

export async function migrateFocusTrackingFile(
  focusTrackingPath: string,
  now: Date = new Date(),
): Promise<FocusFileMigration | null> {
  if (!existsSync(focusTrackingPath)) return null;
  const content = await readFile(focusTrackingPath, "utf-8");
  // Two weeks of grace, like the pure helpers default to; passed explicitly so tests can pin it.
  const keepSinceWeek = weekIdForDate(new Date(now.getTime() - 2 * 7 * 24 * 60 * 60 * 1000));

  if (needsFocusMigration(content)) {
    const backup = `${focusTrackingPath}.pre-ids.bak`;
    await writeFile(backup, content, "utf-8");
    const { content: migrated, assigned, collapsed, lapsed } = migrateFocusTracking(content, keepSinceWeek);
    await writeFile(focusTrackingPath, migrated, "utf-8");
    return { kind: "ids", backup, assigned, collapsed, lapsed };
  }

  if (needsFocusFormatUpgrade(content)) {
    const backup = `${focusTrackingPath}.pre-format2.bak`;
    await writeFile(backup, content, "utf-8");
    const { content: upgraded, lapsed } = upgradeFocusFormat(content, keepSinceWeek);
    await writeFile(focusTrackingPath, upgraded, "utf-8");
    return { kind: "format", backup, assigned: 0, collapsed: 0, lapsed };
  }

  return null;
}

export type VaultRecordKind = "memory" | "impact-log" | "work-context" | "my-profile";

export interface VaultRecordsMigration {
  placeholders: number;
  duplicates: number;
}

interface CleanedRecords extends VaultRecordsMigration {
  content: string;
}

interface RecordMask extends VaultRecordsMigration {
  /** Whether each record survives, in file order. */
  keep: boolean[];
}

/**
 * Decide which of a file's existing records to keep.
 *
 * Duplicates are judged on exact normalized text here, not on the similarity score the
 * writers use. This runs once over a file the user owns and deletes lines: a wrong
 * merge is not something they can spot afterwards, so the migration only removes what
 * is provably the same record twice.
 */
function keepMask(keys: readonly string[]): RecordMask {
  const seen = new Set<string>();
  const keep: boolean[] = [];
  let placeholders = 0;
  let duplicates = 0;

  for (const key of keys) {
    if (isPlaceholder(key)) {
      placeholders++;
      keep.push(false);
      continue;
    }
    const normalized = normalizeText(key);
    if (seen.has(normalized)) {
      duplicates++;
      keep.push(false);
      continue;
    }
    seen.add(normalized);
    keep.push(true);
  }

  return { keep, placeholders, duplicates };
}

function cleanTable(lines: string[], fromLine: number, keyOf: (row: string) => string): CleanedRecords {
  const table = findTable(lines, fromLine);
  if (!table) return { content: lines.join("\n"), placeholders: 0, duplicates: 0 };

  const rows = lines.slice(table.rowStart, table.rowEnd);
  const { keep, placeholders, duplicates } = keepMask(rows.map(keyOf));
  const next = [...lines];
  next.splice(table.rowStart, rows.length, ...rows.filter((_, i) => keep[i]));
  return { content: next.join("\n"), placeholders, duplicates };
}

function cleanBullets(lines: string[], heading: string, textOf: (bullet: string) => string): CleanedRecords {
  const headingIdx = lines.findIndex((line) => line.startsWith(heading));
  if (headingIdx === -1) return { content: lines.join("\n"), placeholders: 0, duplicates: 0 };

  const end = sectionEnd(lines, headingIdx);
  const bulletIdx: number[] = [];
  for (let i = headingIdx + 1; i < end; i++) if (isBullet(lines[i])) bulletIdx.push(i);

  const { keep, placeholders, duplicates } = keepMask(bulletIdx.map((i) => textOf(lines[i])));
  const drop = new Set(bulletIdx.filter((_, n) => !keep[n]));
  return {
    content: lines.filter((_, i) => !drop.has(i)).join("\n"),
    placeholders,
    duplicates,
  };
}

function cleanVaultRecords(content: string, kind: VaultRecordKind): CleanedRecords {
  const lines = content.split("\n");
  switch (kind) {
    case "memory":
      // First table only: the tables below it are archived eras, kept as written.
      return cleanTable(lines, 0, (row) => rowCell(row, MEMORY_ITEM_COLUMN));
    case "impact-log": {
      const timelineIdx = lines.findIndex((line) => line.startsWith(IMPACT_TIMELINE_HEADING));
      return cleanTable(lines, timelineIdx === -1 ? 0 : timelineIdx, (row) => `${rowCell(row, 0)} ${rowCell(row, 1)}`);
    }
    case "work-context":
      return cleanBullets(lines, ORG_NOTES_HEADING, orgNoteText);
    case "my-profile":
      return cleanBullets(lines, KEY_STRENGTHS_HEADING, (bullet) => bullet.slice(2));
  }
}

/**
 * One-off cleanup of the damage the ungated writers did: placeholder rows and repeated
 * records. Keeps a backup, and returns null when there is nothing to change so a second
 * run neither rewrites the file nor overwrites the backup.
 */
export async function migrateVaultRecordsFile(
  path: string,
  kind: VaultRecordKind,
): Promise<VaultRecordsMigration | null> {
  if (!existsSync(path)) return null;

  const content = await readFile(path, "utf-8");
  const cleaned = cleanVaultRecords(content, kind);
  if (cleaned.placeholders === 0 && cleaned.duplicates === 0) return null;

  await writeFile(`${path}.pre-dedupe.bak`, content, "utf-8");
  await writeFile(path, cleaned.content, "utf-8");
  return { placeholders: cleaned.placeholders, duplicates: cleaned.duplicates };
}
