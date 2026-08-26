/**
 * Writers for the auto-maintained vault files.
 *
 * Every one of these files is written once a week from model output, so two things are
 * true of all of them: the model sometimes has nothing to say and says so with a
 * placeholder, and applying the same week twice must change nothing. Left ungated that
 * produced 201 `- (none)` rows in my-profile.md and 45 duplicate records elsewhere.
 *
 * One rule decides what is already here: **canonical text equality**. Case and spacing
 * are folded, nothing else. A record that reads like another record but is not the same
 * string is written. That is deliberate and was arrived at the hard way: four review
 * rounds each found a new pair that a similarity score called identical and a reader
 * would not (a fact and its negation, a contraction, C++ against C#, one version
 * against another, a general statement against a specific one). A repeat costs a line;
 * a wrong rejection loses something the user will never know was said. Similarity is
 * kept for lookups, where the model names a record that already exists and the worst
 * case is not finding it.
 */

import { chmod, lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { BragBookResult } from "./brag-book";

import { findTable, renderRow, splitRow } from "./markdown-table";
import { weekIdForDate } from "./week-utils";
import { LOOKUP_MARGIN, SIMILARITY_THRESHOLD, canonicalText, normalizeText, textSimilarity } from "./text-similarity";
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
  if (inner.trim().length === 0) return true;

  // Text the ASCII word scan cannot read is still text. "(技術リード)" is a strength,
  // not a sentinel, and treating an empty word set as empty content deleted it.
  const words = normalizeText(inner);
  if (words.length === 0) return false;
  if (PLACEHOLDER_WORDS.has(words)) return true;
  return parenthesised && PLACEHOLDER_PREFIXES.some((prefix) => words.startsWith(prefix));
}

/**
 * Index of the record whose canonical text is the same as `target`, or -1.
 *
 * The insert-side test. Exact, after folding case and spacing, so nothing that is
 * merely similar can stop a new record being written.
 */
function findCanonicalIndex(texts: readonly string[], target: string): number {
  const canonical = canonicalText(target);
  if (canonical.length === 0) return -1;
  return texts.findIndex((text) => canonicalText(text) === canonical);
}

/**
 * Index of the record the model is naming, or -1.
 *
 * The lookup side, where prose is all there is to go on: the model paraphrases the row
 * it wants closed. A match has to be both good enough and clearly better than the next
 * candidate, or "Ship Search Revamp migration" would delete the backend row while the
 * frontend row scored exactly the same. Rows that are canonically identical are not
 * rivals: whichever is picked, the outcome is the same.
 */
function findRecordIndex(texts: readonly string[], target: string, excluded: ReadonlySet<number>): number {
  const scored: Array<{ index: number; score: number; canonical: string }> = [];
  for (const [i, text] of texts.entries()) {
    if (excluded.has(i)) continue;
    const score = textSimilarity(text, target);
    if (score <= 0) continue;
    scored.push({ index: i, score, canonical: canonicalText(text) });
  }

  let best: { index: number; score: number; canonical: string } | null = null;
  for (const candidate of scored) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best || best.score < SIMILARITY_THRESHOLD) return -1;

  let rival = 0;
  for (const candidate of scored) {
    if (candidate.canonical === best.canonical) continue;
    if (candidate.score > rival) rival = candidate.score;
  }
  return best.score - rival >= LOOKUP_MARGIN ? best.index : -1;
}

/** Split a cell into the values it lists. Evidence and sources are comma or semicolon separated. */
function splitValues(text: string): string[] {
  return text
    .split(",")
    .flatMap((part) => part.split(";"))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Fold a newer value into the stored one without losing either.
 *
 * A rerun of the same week often carries more evidence than the first run did
 * ("TEAM-1234" becoming "TEAM-1234, TEAM-1235"). Dropping the second because the record
 * is already there would throw that away. The two are merged as sets of whole values:
 * comparing them as substrings made TEAM-123 disappear into TEAM-1234, which is one
 * ticket swallowing another. Folding is stable, so a second identical run changes
 * nothing.
 */
function mergeCell(stored: string, incoming: string): string {
  const kept = stored.trim();
  const next = incoming.trim();
  if (next.length === 0 || isPlaceholder(next)) return stored;
  if (kept.length === 0) return next;

  const values = splitValues(kept);
  const seen = new Set(values.map(canonicalText));
  let added = false;

  for (const value of splitValues(next)) {
    const canonical = canonicalText(value);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    values.push(value);
    added = true;
  }

  return added ? values.join(", ") : stored;
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

/**
 * The text of an H2 heading line, or null when the line is not one.
 *
 * The level is part of the match: `### Key Strengths` is a subsection of something
 * else, and writing a strength into it, or deleting one from it, is writing into a
 * section this code does not own. GFM allows up to three leading spaces.
 */
function h2Text(line: string): string | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (line[i] !== "#" || line[i + 1] !== "#" || line[i + 2] !== " ") return null;
  return canonicalText(line.slice(i + 3));
}

/**
 * Index of the live H2 whose text is exactly `heading`, or -1.
 *
 * Used where landing in the wrong section writes or deletes someone else's data:
 * `## Impact Timeline Notes` is not the impact timeline.
 */
function findExactHeading(lines: readonly string[], heading: string, limit: number): number {
  const target = h2Text(heading) ?? canonicalText(heading);
  for (let i = 0; i < limit; i++) {
    if (h2Text(lines[i]) === target) return i;
  }
  return -1;
}

/**
 * Where a section's content stops, for edits that must stay inside it.
 *
 * Unlike `sectionEnd` this runs past a `---` rule, because the impact log keeps its
 * status lines below one and they are part of the section.
 */
function sectionScope(lines: readonly string[], headingIdx: number, limit: number): number {
  for (let i = headingIdx + 1; i < limit; i++) {
    if (lines[i].startsWith("## ")) return i;
  }
  return limit;
}

/**
 * Rewrite the first line starting with `prefix` between `from` and `to`.
 *
 * Both bounds matter: scanning from the top of the file rewrote a status line under a
 * summary section above the timeline and left the timeline's own line stale.
 */
function replaceFirstLine(
  lines: string[],
  from: number,
  to: number,
  prefix: string,
  replacement: string,
): boolean {
  for (let i = Math.max(from, 0); i < to; i++) {
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

/** The `_(source)_` suffix of an organizational note, or "" when it has none. */
function orgNoteSource(bullet: string): string {
  const trimmed = bullet.trimEnd();
  if (!trimmed.endsWith(")_")) return "";
  const start = trimmed.lastIndexOf("_(");
  return start === -1 ? "" : trimmed.slice(start + 2, trimmed.length - 2);
}

/**
 * Fold a source into the `_(...)_` suffix of an existing note, or null when unchanged.
 *
 * A note written without a suffix gains one rather than losing the source: the whole
 * point of merging into the note already there is that nothing arrives and vanishes.
 */
function mergeNoteSource(bullet: string, source: string): string | null {
  const value = source.trim();
  if (value.length === 0 || isPlaceholder(value)) return null;

  const trimmed = bullet.trimEnd();
  const start = trimmed.endsWith(")_") ? trimmed.lastIndexOf("_(") : -1;
  if (start === -1) return `${trimmed} _(${value})_`;

  const stored = trimmed.slice(start + 2, trimmed.length - 2);
  const merged = mergeCell(stored, value);
  return merged === stored ? null : `${trimmed.slice(0, start)}_(${merged})_`;
}

export async function updateMemory(
  memoryPath: string,
  itemsToAdd: string[],
  itemsToRemove: string[],
): Promise<VaultWriteResult> {
  const original = existsSync(memoryPath) ? await readFile(memoryPath, "utf-8") : MEMORY_TEMPLATE;
  const eol = detectEol(original);
  const lines = toLines(original);
  const liveEnd = liveRegionEnd(lines);

  // The live era's table, or nothing. A memory.md whose only table sits under an
  // archived heading has no live table: appending there would file this week's work
  // under a team the user left, and a graduation would delete a row from that record.
  const table = findTable(lines);
  if (!table || table.rowStart - 1 >= liveEnd) return "no-section";

  const rowEnd = Math.min(table.rowEnd, liveEnd);
  const rows = lines.slice(table.rowStart, rowEnd);
  const items = rows.map((row) => rowCell(row, MEMORY_ITEM_COLUMN));

  // Graduation. The model paraphrases the row it is closing, so matching by
  // `includes()` on its prose almost never landed: 17 hits in 27 weeks. This is a
  // lookup of a row the model named, so it scores, and it takes the match only when
  // that match is clearly the best one.
  const graduated = new Set<number>();
  for (const removal of itemsToRemove) {
    const marker = removal.indexOf(GRADUATION_MARKER);
    const target = (marker === -1 ? removal : removal.slice(0, marker)).trim();
    const idx = findRecordIndex(items, target, graduated);
    if (idx !== -1) graduated.add(idx);
  }

  const kept = rows.filter((_, i) => !graduated.has(i));
  const newRows: string[] = [];
  // Rows already in the file, then rows queued by this batch, so a repeat inside one
  // batch is folded into the row queued moments earlier rather than added twice.
  const pending = kept.map((row) => rowCell(row, MEMORY_ITEM_COLUMN));
  let merges = 0;

  for (const row of itemsToAdd) {
    if (!row.includes("|")) continue;
    const incoming = splitRow(row);
    const item = incoming[MEMORY_ITEM_COLUMN] ?? "";
    if (isPlaceholder(item)) continue;

    const idx = findCanonicalIndex(pending, item);
    if (idx === -1) {
      newRows.push(row);
      pending.push(item);
      continue;
    }

    const target = idx < kept.length ? kept : newRows;
    const offset = idx < kept.length ? idx : idx - kept.length;
    const merged = mergeRowCells(target[offset], incoming, [MEMORY_NOTES_COLUMN]);
    if (merged) {
      target[offset] = merged;
      merges++;
    }
  }

  if (graduated.size === 0 && newRows.length === 0 && merges === 0) return "unchanged";

  lines.splice(table.rowStart, rows.length, ...kept, ...newRows);
  await writeFile(memoryPath, lines.join(eol), "utf-8");
  return "written";
}

/**
 * What became of an update.
 *
 * "placeholder" is the model having nothing worth recording and "unchanged" is
 * everything it said already being in the file; both are normal and quiet.
 * "no-section" is the file not having the live heading to write under, which is worth
 * telling the user about: the update existed and had nowhere to go.
 */
export type VaultWriteResult = "written" | "unchanged" | "placeholder" | "no-section";

/** True for a `YYYY-MM-DD` cell, the only thing worth comparing as a date. */
function isIsoDate(value: string): boolean {
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
    if (value[i] < "0" || value[i] > "9") return false;
  }
  return true;
}

/** The most recent date in a set of dated rows, or "" when none of them carry one. */
function latestRowDate(rows: readonly string[]): string {
  let latest = "";
  for (const row of rows) {
    const date = rowCell(row, 0);
    // ISO dates sort as text, which is the only reason this is a string compare.
    if (isIsoDate(date) && date > latest) latest = date;
  }
  return latest;
}

/** Record one achievement in the impact timeline. */
export async function updateImpactLog(
  impactLogPath: string,
  entry: BragBookResult["impactLogEntry"],
): Promise<VaultWriteResult> {
  if (!entry || isPlaceholder(entry.achievement)) return "placeholder";

  const original = await readFile(impactLogPath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const liveEnd = liveRegionEnd(lines);

  const headingIdx = findExactHeading(lines, IMPACT_TIMELINE_HEADING, liveEnd);
  if (headingIdx === -1) return "no-section";

  // Everything this function touches lives between the heading and the next one. A
  // table further down the file belongs to another section, and an archived era's
  // status lines record what was true when that era ended.
  const scope = sectionScope(lines, headingIdx, liveEnd);
  const table = findTable(lines, headingIdx);
  if (!table || table.rowStart - 1 >= scope) return "no-section";

  const rowEnd = Math.min(table.rowEnd, scope);
  const rows = lines.slice(table.rowStart, rowEnd);
  const incoming = [entry.date, entry.achievement, entry.scope, entry.coreValue, entry.evidence];
  // Same achievement on the same date is the same entry, whatever the wording.
  const keys = rows.map((row) => `${rowCell(row, 0)} ${rowCell(row, 1)}`);
  const idx = findCanonicalIndex(keys, `${entry.date} ${entry.achievement}`);

  let changed = false;
  if (idx === -1) {
    lines.splice(rowEnd, 0, renderRow(incoming));
    rows.push(renderRow(incoming));
    changed = true;
  } else {
    const merged = mergeRowCells(rows[idx], incoming, [IMPACT_SCOPE_COLUMN, IMPACT_VALUE_COLUMN, IMPACT_EVIDENCE_COLUMN]);
    if (merged) {
      lines[table.rowStart + idx] = merged;
      rows[idx] = merged;
      changed = true;
    }
  }

  // The status lines describe the file, not this entry. Regenerating an older week
  // must not rewind them: the latest impact is whatever the table now says is latest,
  // and the gap only closes when the entry just written is that latest one.
  const latest = latestRowDate(rows);
  if (latest.length > 0) {
    // Recomputed: inserting the row moved every line below it, including these.
    const metadataEnd = sectionScope(lines, headingIdx, liveRegionEnd(lines));
    changed = replaceFirstLine(lines, headingIdx, metadataEnd, LAST_IMPACT_PREFIX, `${LAST_IMPACT_PREFIX} ${latest}`) || changed;
    if (latest === entry.date) {
      changed = replaceFirstLine(lines, headingIdx, metadataEnd, CURRENT_GAP_PREFIX, `${CURRENT_GAP_PREFIX} None - recent entry added`) || changed;
    }
  }

  if (!changed) return "unchanged";
  await writeFile(impactLogPath, lines.join(eol), "utf-8");
  return "written";
}

export async function updateWorkContext(
  workContextPath: string,
  updates: BragBookResult["workContextUpdates"],
  now: Date = new Date(),
): Promise<VaultWriteResult> {
  if (updates.length === 0) return "placeholder";

  const original = await readFile(workContextPath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const liveEnd = liveRegionEnd(lines);

  // Exact, like the cleanup: a section merely named like this one belongs to someone
  // else, and notes filed under it are notes the user will not find again.
  const headingIdx = findExactHeading(lines, ORG_NOTES_HEADING, liveEnd);
  if (headingIdx === -1) return "no-section";

  const end = Math.min(sectionEnd(lines, headingIdx), liveEnd);
  const bulletLines: number[] = [];
  for (let i = headingIdx + 1; i < end; i++) if (isBullet(lines[i])) bulletLines.push(i);

  // Notes already in the file, then notes queued by this batch. Queued notes stay
  // structured so a later update naming the same fact folds its source into them
  // instead of being dropped.
  const queued: Array<{ category: string; info: string; source: string }> = [];
  const notes = bulletLines.map((i) => orgNoteText(lines[i]));
  let changed = false;

  for (const update of updates) {
    if (isPlaceholder(update.info)) continue;
    const idx = findCanonicalIndex(notes, update.info);

    if (idx === -1) {
      queued.push({ category: update.category, info: update.info, source: update.source });
      notes.push(update.info);
      continue;
    }

    if (idx < bulletLines.length) {
      const merged = mergeNoteSource(lines[bulletLines[idx]], update.source);
      if (merged) {
        lines[bulletLines[idx]] = merged;
        changed = true;
      }
      continue;
    }

    const note = queued[idx - bulletLines.length];
    note.source = mergeCell(note.source, update.source);
  }

  if (queued.length > 0) {
    let insertAt = headingIdx + 1;
    if (lines[insertAt]?.trim() === "") insertAt++;
    lines.splice(insertAt, 0, ...queued.map((note) => `- **${note.category}:** ${note.info} _(${note.source})_`));
    changed = true;
    // The stamp says when a note was last added, so it only moves when one was. Moving
    // it on every run made a rerun of the same week differ from the first run.
    const stamp = now.toISOString().split("T")[0];
    replaceFirstLine(lines, 0, liveRegionEnd(lines), LAST_UPDATED_PREFIX, `*Last updated: ${stamp}*`);
  }

  if (!changed) return "unchanged";
  await writeFile(workContextPath, lines.join(eol), "utf-8");
  return "written";
}

export async function updateProfile(
  profilePath: string,
  update: BragBookResult["profileUpdate"],
): Promise<VaultWriteResult> {
  if (!update || isPlaceholder(update.bulletPoint)) return "placeholder";

  const original = await readFile(profilePath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const liveEnd = liveRegionEnd(lines);

  const headingIdx = findExactHeading(lines, KEY_STRENGTHS_HEADING, liveEnd);
  if (headingIdx === -1) return "no-section";

  const end = Math.min(sectionEnd(lines, headingIdx), liveEnd);
  const existing: string[] = [];
  for (let i = headingIdx + 1; i < end; i++) if (isBullet(lines[i])) existing.push(lines[i].slice(2));
  if (findCanonicalIndex(existing, update.bulletPoint) !== -1) return "unchanged";

  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `- ${update.bulletPoint}`);

  await writeFile(profilePath, lines.join(eol), "utf-8");
  return "written";
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
  /** Where the file as it was before this run was kept. */
  backup: string;
}

interface CleanedRecords {
  content: string;
  placeholders: number;
  duplicates: number;
}

interface RecordMask {
  /** Whether each record survives, in file order. */
  keep: boolean[];
  /** The surviving lines, with dropped duplicates folded in. */
  lines: string[];
  placeholders: number;
  duplicates: number;
}

/** One stored record: the line, the text that decides identity, and what makes it empty. */
interface StoredRecord {
  line: string;
  identity: string;
  value: string;
}

/** Fold a duplicate into the record that survives it, or null when there is nothing to add. */
type FoldRecord = (survivor: string, duplicate: string) => string | null;

/**
 * Decide which of a file's existing records to keep, and carry the dropped ones'
 * evidence into the records that survive them.
 *
 * Three deliberate narrowings, because this deletes lines from a file the user owns and
 * a wrong deletion is not something they can spot afterwards. Duplicates are judged on
 * `canonicalText`, which only folds case and whitespace: the scoring normalizer strips
 * symbols and non-ASCII letters, so it maps "Builds C++ toolchains" and "Builds C#
 * toolchains" onto one string and every non-Latin note onto "". A record with no
 * canonical form at all is never called a repeat. And a duplicate's sources, evidence
 * and notes are merged into the survivor first, so collapsing two rows never costs the
 * ticket that only one of them cited.
 */
function keepMask(records: readonly StoredRecord[], fold: FoldRecord): RecordMask {
  const survivors = new Map<string, number>();
  const lines = records.map((record) => record.line);
  const keep: boolean[] = [];
  let placeholders = 0;
  let duplicates = 0;

  for (const [i, record] of records.entries()) {
    if (isPlaceholder(record.value)) {
      placeholders++;
      keep.push(false);
      continue;
    }

    const canonical = canonicalText(record.identity);
    const survivor = canonical.length > 0 ? survivors.get(canonical) : undefined;
    if (survivor !== undefined) {
      duplicates++;
      keep.push(false);
      const folded = fold(lines[survivor], record.line);
      if (folded) lines[survivor] = folded;
      continue;
    }

    survivors.set(canonical, i);
    keep.push(true);
  }

  return { keep, lines, placeholders, duplicates };
}

function unchanged(lines: readonly string[], eol: string): CleanedRecords {
  return { content: lines.join(eol), placeholders: 0, duplicates: 0 };
}

function cleanTable(
  lines: string[],
  fromLine: number,
  limit: number,
  eol: string,
  recordOf: (row: string) => StoredRecord,
  fold: FoldRecord,
): CleanedRecords {
  const table = findTable(lines, fromLine);
  // The separator has to be inside the section: a table further down the file belongs
  // to another section, and deleting rows from it would be deleting someone else's data.
  if (!table || table.rowStart - 1 >= limit) return unchanged(lines, eol);

  const rowEnd = Math.min(table.rowEnd, limit);
  const rows = lines.slice(table.rowStart, rowEnd);
  const mask = keepMask(rows.map(recordOf), fold);
  const next = [...lines];
  next.splice(table.rowStart, rows.length, ...mask.lines.filter((_, i) => mask.keep[i]));
  return { content: next.join(eol), placeholders: mask.placeholders, duplicates: mask.duplicates };
}

function cleanBullets(
  lines: string[],
  headingIdx: number,
  limit: number,
  eol: string,
  textOf: (bullet: string) => string,
  fold: FoldRecord,
): CleanedRecords {
  const end = Math.min(sectionEnd(lines, headingIdx), limit);
  const bulletIdx: number[] = [];
  for (let i = headingIdx + 1; i < end; i++) if (isBullet(lines[i])) bulletIdx.push(i);

  const mask = keepMask(
    bulletIdx.map((i) => {
      const text = textOf(lines[i]);
      return { line: lines[i], identity: text, value: text };
    }),
    fold,
  );

  const next = [...lines];
  for (const [n, i] of bulletIdx.entries()) next[i] = mask.lines[n];
  const drop = new Set(bulletIdx.filter((_, n) => !mask.keep[n]));
  return {
    content: next.filter((_, i) => !drop.has(i)).join(eol),
    placeholders: mask.placeholders,
    duplicates: mask.duplicates,
  };
}

/** Fold the given columns of a duplicate row into the row that survives it. */
function foldRowCells(columns: readonly number[]): FoldRecord {
  return (survivor, duplicate) => mergeRowCells(survivor, splitRow(duplicate), columns);
}

/** Fold a duplicate note's source into the note that survives it. */
function foldNoteSource(survivor: string, duplicate: string): string | null {
  return mergeNoteSource(survivor, orgNoteSource(duplicate));
}

/** Nothing to carry over: a strength is only its text. */
function foldNothing(): null {
  return null;
}

/**
 * Clean one file's records.
 *
 * Every path here matches its heading exactly and stays inside that section, the same
 * way the writers do. This one deletes lines, so being strict is the safe failure: a
 * file whose headings do not match is left alone rather than half cleaned, and
 * "## Impact Timeline Notes" is never mistaken for the timeline.
 */
function cleanVaultRecords(content: string, kind: VaultRecordKind): CleanedRecords {
  const eol = detectEol(content);
  const lines = toLines(content);
  const liveEnd = liveRegionEnd(lines);

  switch (kind) {
    case "memory":
      // First table in the live region: the tables below it are archived eras, kept as
      // written.
      return cleanTable(
        lines,
        0,
        liveEnd,
        eol,
        (row) => {
          const item = rowCell(row, MEMORY_ITEM_COLUMN);
          return { line: row, identity: item, value: item };
        },
        foldRowCells([MEMORY_NOTES_COLUMN]),
      );

    case "impact-log": {
      const headingIdx = findExactHeading(lines, IMPACT_TIMELINE_HEADING, liveEnd);
      if (headingIdx === -1) return unchanged(lines, eol);
      // Identity is the date and the achievement together, but only the achievement
      // decides whether the row says anything: a date in front of "(none)" would
      // otherwise make the placeholder row look like real content.
      return cleanTable(
        lines,
        headingIdx,
        sectionScope(lines, headingIdx, liveEnd),
        eol,
        (row) => ({
          line: row,
          identity: `${rowCell(row, 0)} ${rowCell(row, 1)}`,
          value: rowCell(row, 1),
        }),
        foldRowCells([IMPACT_SCOPE_COLUMN, IMPACT_VALUE_COLUMN, IMPACT_EVIDENCE_COLUMN]),
      );
    }

    case "work-context": {
      const headingIdx = findExactHeading(lines, ORG_NOTES_HEADING, liveEnd);
      if (headingIdx === -1) return unchanged(lines, eol);
      return cleanBullets(lines, headingIdx, liveEnd, eol, orgNoteText, foldNoteSource);
    }

    case "my-profile": {
      const headingIdx = findExactHeading(lines, KEY_STRENGTHS_HEADING, liveEnd);
      if (headingIdx === -1) return unchanged(lines, eol);
      return cleanBullets(lines, headingIdx, liveEnd, eol, (bullet) => bullet.slice(2), foldNothing);
    }
  }
}

/**
 * Where to keep the file as it was. The first backup holds the original, so it is never
 * overwritten: a later run cleaning up a newly arrived placeholder would otherwise
 * replace the only copy of what the file looked like before any of this ran.
 */
function nextBackupPath(path: string): string {
  const first = `${path}.pre-dedupe.bak`;
  if (!existsSync(first)) return first;

  for (let n = 2; n < 100; n++) {
    const candidate = `${path}.pre-dedupe.${n}.bak`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${path}.pre-dedupe.${Date.now()}.bak`;
}

/**
 * Write through a temp file so an interrupted run cannot leave the vault file torn.
 *
 * A vault file is often a symlink into somewhere else, and renaming over the link would
 * replace it with a regular file, quietly detaching it from whatever it pointed at. The
 * link is resolved first and the target's mode carried over, so the file the user set up
 * is still the file they have afterwards.
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const link = await lstat(path).catch(() => null);
  const target = link?.isSymbolicLink() ? await realpath(path) : path;
  const existing = await stat(target).catch(() => null);

  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, content, "utf-8");
  if (existing) await chmod(temp, existing.mode & 0o777);
  await rename(temp, target);
}

/**
 * One-off cleanup of the damage the ungated writers did: placeholder rows and repeated
 * records. Keeps a backup, and returns null when there is nothing to change so a second
 * run neither rewrites the file nor writes another backup.
 */
export async function migrateVaultRecordsFile(
  path: string,
  kind: VaultRecordKind,
): Promise<VaultRecordsMigration | null> {
  if (!existsSync(path)) return null;

  const content = await readFile(path, "utf-8");
  const cleaned = cleanVaultRecords(content, kind);
  if (cleaned.placeholders === 0 && cleaned.duplicates === 0) return null;

  const backup = nextBackupPath(path);
  await writeFile(backup, content, "utf-8");
  await writeFileAtomic(path, cleaned.content);
  return { placeholders: cleaned.placeholders, duplicates: cleaned.duplicates, backup };
}
