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

import { appendToFirstTable, findTable, splitRow } from "./markdown-table";
import { weekIdForDate } from "./week-utils";
import { SIMILARITY_THRESHOLD, normalizeText, textSimilarity } from "./text-similarity";
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

/** Column index of the Item cell in a memory row: `| Date | Item | Category | Notes |`. */
const MEMORY_ITEM_COLUMN = 1;
/** How the prompt asks the model to mark a graduated memory item. */
const GRADUATION_MARKER = "(now part of";

const IMPACT_TIMELINE_HEADING = "## Impact Timeline";
const ORG_NOTES_HEADING = "## Organizational Notes";
const KEY_STRENGTHS_HEADING = "## Key Strengths";
const LAST_IMPACT_PREFIX = "**Last significant impact:**";
const CURRENT_GAP_PREFIX = "**Current gap:**";
const LAST_UPDATED_PREFIX = "*Last updated:";

/** Words the model uses when it means "nothing to record". */
const PLACEHOLDER_WORDS = new Set(["none", "n a", "na", "nil", "nothing", "tbd", "todo", "unknown"]);

/** Strip the emphasis and list markers around a value so its content can be judged. */
function stripDecoration(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === "_" || text[start] === "*" || text[start] === "`" || text[start] === " " || text[start] === "\t")) start++;
  while (end > start && (text[end - 1] === "_" || text[end - 1] === "*" || text[end - 1] === "`" || text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(start, end);
}

/**
 * True for text that carries no information: blank, a parenthesised aside such as
 * `(none)` or `(leave blank if none)`, a template hint left in place, or a bare
 * "nothing to add" word.
 *
 * Checked by scanning rather than matching a pattern, because the text is model
 * output and a regex over it is what CodeQL flags.
 */
export function isPlaceholder(text: string): boolean {
  const core = stripDecoration(text);
  if (core.length === 0) return true;
  if (core.startsWith("(") && core.endsWith(")")) return true;
  if (core.startsWith("<!--") && core.endsWith("-->")) return true;
  return PLACEHOLDER_WORDS.has(normalizeText(core));
}

/**
 * Gate for text entering a vault file: rejects placeholders, anything the file already
 * says, and anything already accepted in this same batch.
 *
 * Identity is the normalized text, with the same containment score focus tracking uses,
 * because the model rewords its own entries between runs and an exact-string check
 * would let every rewording through as new.
 */
function createRecordFilter(existing: readonly string[]): (text: string) => boolean {
  const seen = existing.map(normalizeText).filter((value) => value.length > 0);

  return (text: string): boolean => {
    if (isPlaceholder(text)) return false;
    const normalized = normalizeText(text);
    if (normalized.length === 0) return false;
    for (const prior of seen) {
      if (prior === normalized) return false;
      if (textSimilarity(prior, normalized) >= SIMILARITY_THRESHOLD) return false;
    }
    seen.push(normalized);
    return true;
  };
}

/** Row index whose text is the same record as `target`, or -1. */
function findRecordIndex(texts: readonly string[], target: string, excluded: ReadonlySet<number>): number {
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
    if (score >= SIMILARITY_THRESHOLD && score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** Cell of a table row, or "" when the row is shorter than expected. */
function cell(row: string, index: number): string {
  return splitRow(row)[index] ?? "";
}

/** Where a `## ` section ends: the next heading, the closing rule, or end of file. */
function sectionEnd(lines: readonly string[], headingIdx: number): number {
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") || lines[i].trim() === "---") return i;
  }
  return lines.length;
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

export async function updateMemory(memoryPath: string, itemsToAdd: string[], itemsToRemove: string[]): Promise<void> {
  let content = existsSync(memoryPath) ? await readFile(memoryPath, "utf-8") : MEMORY_TEMPLATE;

  const lines = content.split("\n");
  const table = findTable(lines);
  const rows = table ? lines.slice(table.rowStart, table.rowEnd) : [];
  const items = rows.map((row) => cell(row, MEMORY_ITEM_COLUMN));

  // Graduation. The model paraphrases the row it is closing, so matching by
  // `includes()` on its prose almost never landed: 17 hits in 27 weeks.
  const graduated = new Set<number>();
  for (const removal of itemsToRemove) {
    const marker = removal.indexOf(GRADUATION_MARKER);
    const target = (marker === -1 ? removal : removal.slice(0, marker)).trim();
    const idx = findRecordIndex(items, target, graduated);
    if (idx !== -1) graduated.add(idx);
  }

  if (table && graduated.size > 0) {
    const kept = rows.filter((_, i) => !graduated.has(i));
    lines.splice(table.rowStart, table.rowEnd - table.rowStart, ...kept);
    content = lines.join("\n");
  }

  const accept = createRecordFilter(items.filter((_, i) => !graduated.has(i)));
  const newRows = itemsToAdd.filter((row) => row.includes("|") && accept(cell(row, MEMORY_ITEM_COLUMN)));

  await writeFile(memoryPath, appendToFirstTable(content, newRows), "utf-8");
}

export async function updateImpactLog(impactLogPath: string, entry: BragBookResult["impactLogEntry"]): Promise<void> {
  if (!entry || isPlaceholder(entry.achievement)) return;

  const content = await readFile(impactLogPath, "utf-8");
  const lines = content.split("\n");

  const timelineIdx = lines.findIndex((line) => line.startsWith(IMPACT_TIMELINE_HEADING));
  const table = findTable(lines, timelineIdx === -1 ? 0 : timelineIdx);
  if (table) {
    // Same achievement on the same date is the same entry, whatever the wording.
    const keyOf = (row: string) => `${cell(row, 0)} ${cell(row, 1)}`;
    const existing = lines.slice(table.rowStart, table.rowEnd).map(keyOf);
    const accept = createRecordFilter(existing);
    if (accept(`${entry.date} ${entry.achievement}`)) {
      const row = `| ${entry.date} | ${entry.achievement} | ${entry.scope} | ${entry.coreValue} | ${entry.evidence} |`;
      lines.splice(table.rowEnd, 0, row);
    }
  }

  const updated = lines.map((line) => {
    if (line.startsWith(LAST_IMPACT_PREFIX)) return `${LAST_IMPACT_PREFIX} ${entry.date}`;
    if (line.startsWith(CURRENT_GAP_PREFIX)) return `${CURRENT_GAP_PREFIX} None - recent entry added`;
    return line;
  });

  await writeFile(impactLogPath, updated.join("\n"), "utf-8");
}

export async function updateWorkContext(workContextPath: string, updates: BragBookResult["workContextUpdates"]): Promise<void> {
  if (updates.length === 0) return;

  const content = await readFile(workContextPath, "utf-8");
  const lines = content.split("\n");

  const headingIdx = lines.findIndex((line) => line.startsWith(ORG_NOTES_HEADING));
  if (headingIdx !== -1) {
    const end = sectionEnd(lines, headingIdx);
    const existing = lines.slice(headingIdx + 1, end).filter(isBullet).map(orgNoteText);
    const accept = createRecordFilter(existing);

    const bullets = updates
      .filter((update) => accept(update.info))
      .map((update) => `- **${update.category}:** ${update.info} _(${update.source})_`);

    if (bullets.length > 0) {
      let insertAt = headingIdx + 1;
      if (lines[insertAt]?.trim() === "") insertAt++;
      lines.splice(insertAt, 0, ...bullets);
    }
  }

  const today = new Date().toISOString().split("T")[0];
  const updated = lines.map((line) =>
    line.startsWith(LAST_UPDATED_PREFIX) ? `*Last updated: ${today}*` : line,
  );

  await writeFile(workContextPath, updated.join("\n"), "utf-8");
}

export async function updateProfile(profilePath: string, update: BragBookResult["profileUpdate"]): Promise<void> {
  if (!update || isPlaceholder(update.bulletPoint)) return;

  const content = await readFile(profilePath, "utf-8");
  const lines = content.split("\n");

  const headingIdx = lines.findIndex((line) => line.startsWith(KEY_STRENGTHS_HEADING));
  if (headingIdx === -1) return;

  const end = sectionEnd(lines, headingIdx);
  const existing = lines.slice(headingIdx + 1, end).filter(isBullet).map((line) => line.slice(2));
  if (!createRecordFilter(existing)(update.bulletPoint)) return;

  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `- ${update.bulletPoint}`);

  await writeFile(profilePath, lines.join("\n"), "utf-8");
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

/**
 * Decide which of a file's existing records to keep.
 *
 * Duplicates are judged on exact normalized text here, not on the similarity score the
 * writers use. This runs once over a file the user owns and deletes lines: a wrong
 * merge is not something they can spot afterwards, so the migration only removes what
 * is provably the same record twice.
 */
function keepMask(keys: readonly string[]): { keep: boolean[]; placeholders: number; duplicates: number } {
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
      return cleanTable(lines, 0, (row) => cell(row, MEMORY_ITEM_COLUMN));
    case "impact-log": {
      const timelineIdx = lines.findIndex((line) => line.startsWith(IMPACT_TIMELINE_HEADING));
      return cleanTable(lines, timelineIdx === -1 ? 0 : timelineIdx, (row) => `${cell(row, 0)} ${cell(row, 1)}`);
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
