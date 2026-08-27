/**
 * Writers for the auto-maintained vault files.
 *
 * Every one of these files is written once a week from model output, so two things are
 * true of all of them: the model sometimes has nothing to say and says so with a
 * placeholder, and applying the same week twice must change nothing. Left ungated that
 * produced 201 `- (none)` rows in my-profile.md and 45 duplicate records elsewhere.
 *
 * Two rules decide what happens to an incoming record.
 *
 * **What it is**: every cell except the mergeable one. A memory row is its date, item
 * and category; an impact row is its date, achievement, scope and value; an
 * organizational note is its category and its text. Change any of those and it is a
 * different record, not an update to an existing one. Exactly one cell per record is
 * evidence rather than identity, and only that one merges: memory Notes, impact
 * Evidence, a note's `_(source)_`.
 *
 * **Whether it is already here**: **canonical text equality** over that identity. Case
 * and spacing are folded, nothing else. A record that reads like another record but is
 * not the same string is written. That is deliberate and was arrived at the hard way: four review
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

import {
  escapeCell, findTable, renderRow, renderScannedRow, scanRow, splitRow,
  type TableBounds,
} from "./markdown-table";
import { weekIdForDate } from "./week-utils";
import {
  LOOKUP_MARGIN, SIMILARITY_THRESHOLD, canonicalText, exactText, normalizeText, textSimilarity,
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

/**
 * The header a table must have before this code will touch it.
 *
 * Locating a table by "the first separator line" was enough to find a user's own
 * `| Setting | Value |` table sitting above the real one and clean rows out of it.
 * A table this code does not recognise is a table it leaves alone.
 */
const MEMORY_HEADER = ["Date", "Item", "Category", "Notes"];
const IMPACT_HEADER = ["Date", "Achievement", "Scope", "Core Value", "Evidence"];

/**
 * `worklog init` seeds every vault file except this one, so the first real achievement
 * has to be able to create it. The header has to match IMPACT_HEADER exactly, since
 * that is what the writer looks for.
 */
const IMPACT_LOG_TEMPLATE = `# Impact Log

Achievements that carry weight in a review, with the evidence for them.

## Impact Timeline

| Date | Achievement | Scope | Core Value | Evidence |
|------|-------------|-------|------------|----------|

**Last significant impact:** none recorded
**Current gap:** no significant impact recorded
`;

/** Column indexes in a memory row: `| Date | Item | Category | Notes |`. */
const MEMORY_ITEM_COLUMN = 1;
const MEMORY_NOTES_COLUMN = 3;
/** Everything but the Notes is what makes a memory row that row. */
const MEMORY_IDENTITY_COLUMNS = [0, 1, 2];
/** Column indexes in an impact row: `| Date | Achievement | Scope | Core Value | Evidence |`. */
const IMPACT_EVIDENCE_COLUMN = 4;
/** Everything but the Evidence is what makes an impact row that row. */
const IMPACT_IDENTITY_COLUMNS = [0, 1, 2, 3];
const IMPACT_TIMELINE_HEADING = "## Impact Timeline";
const ORG_NOTES_HEADING = "## Organizational Notes";
const KEY_STRENGTHS_HEADING = "## Key Strengths";
const LAST_IMPACT_PREFIX = "**Last significant impact:**";
const CURRENT_GAP_PREFIX = "**Current gap:**";
const LAST_UPDATED_PREFIX = "*Last updated:";
/** What the gap line says when the latest impact is this week's. */
const GAP_CLOSED = "None - recent entry added";
/** What the two status lines say when the timeline holds nothing dated at all. */
const NO_IMPACT_RECORDED = "none recorded";
const NO_GAP_RECORDED = "no significant impact recorded";

/** Bare words the model writes when it means "nothing to record". */
const PLACEHOLDER_WORDS = new Set([
  "none", "n a", "na", "nil", "nothing", "tbd", "todo", "unknown",
  // Whole values a real vault turned out to hold.
  "none this week", "none yet",
]);

/**
 * The parenthesised asides the prompt and the seed templates use, matched as whole
 * phrases at a word boundary.
 *
 * Only instructions belong here, never a bare word: matching "none" as a prefix threw
 * away "(Nonetheless shipped the migration)" and "(None of the work landed)". A bare
 * sentinel is caught by PLACEHOLDER_WORDS instead, which compares the whole value.
 */
const PLACEHOLDER_PHRASES = ["leave blank", "added automatically", "none configured"];

/**
 * The hints `doc-generators.ts` writes into a seeded file, compared whole.
 *
 * A prefix test was wrong: the generators only ever put a TODO hint in the fixed-field
 * areas, never inside the four record areas this code maintains, so every comment it
 * matched there was one the user had written for themselves. Kept in sync by hand; a
 * hint that drifts out of this list is simply treated as content, which is the safe
 * direction.
 */
const TEMPLATE_HINTS = [
  "update your full name",
  "update your job title",
  "update your level (e.g. IC-5, Staff)",
  "update your company",
  "update your location",
  "update your role start date (YYYY-MM-DD)",
  "update your team name",
  "update your team domain",
  "describe what your team builds (1-2 sentences)",
  "add your technical skills (e.g. TypeScript, React, Node.js)",
  "add your growth areas (e.g. system design, cross-team influence)",
  "add your company core values",
  "add your review cycle dates (e.g. Q1 check-in: 2026-03-15, Mid-year: 2026-06-15)",
  "add your Jira project keys (e.g. TEAM)",
  "update career framework type",
  "update your current level",
  "update your target level",
].map((hint) => canonicalText(`<!-- TODO: ${hint} -->`));

/** True when `words` opens with `phrase` and the phrase ends on a word boundary. */
function opensWithPhrase(words: string, phrase: string): boolean {
  if (!words.startsWith(phrase)) return false;
  const next = words[phrase.length];
  return next === undefined || next === " ";
}

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
  // Only a hint the seed templates wrote. Any other comment is something the user put
  // there on purpose, and deleting a note to self is not this code's business.
  if (TEMPLATE_HINTS.includes(canonicalText(core))) return true;

  const parenthesised = core.startsWith("(") && core.endsWith(")");
  const inner = parenthesised ? core.slice(1, -1) : core;
  if (inner.trim().length === 0) return true;

  // Text the ASCII word scan cannot read is still text. "(技術リード)" is a strength,
  // not a sentinel, and treating an empty word set as empty content deleted it.
  const words = normalizeText(inner);
  if (words.length === 0) return false;
  if (PLACEHOLDER_WORDS.has(words)) return true;
  return parenthesised && PLACEHOLDER_PHRASES.some((phrase) => opensWithPhrase(words, phrase));
}

const NO_EXCLUSIONS: ReadonlySet<number> = new Set<number>();

/**
 * A record's identity: its cells, canonicalized, kept apart from one another.
 *
 * A tuple rather than a joined string, because joining loses the boundaries: with a
 * space between them, `| Foo | Bar Baz |` and `| Foo Bar | Baz |` read as one record
 * and the second was merged into the first.
 */
type Canonicalizer = (text: string) => string;

/**
 * How the two sides read a record's cells.
 *
 * An insert folds case: the model re-emits its own text with whatever capitalisation
 * it feels like that week, and writing the note twice over a capital letter is the
 * churn this phase exists to stop. A delete does not fold it. `Set API_KEY` and
 * `Set api_key` are different instructions, and one is not proof of the other.
 */
const INSERT_IDENTITY: Canonicalizer = canonicalText;
const DELETE_IDENTITY: Canonicalizer = exactText;

function identityOf(cells: readonly string[], canonical: Canonicalizer = INSERT_IDENTITY): string {
  const parts = cells.map(canonical);
  return parts.every((cell) => cell.length === 0) ? NO_IDENTITY : JSON.stringify(parts);
}

/** A record with nothing in any of its cells identifies nothing, and matches nothing. */
const NO_IDENTITY = "";

/**
 * Index of the record whose identity is the same as `target`, or -1.
 *
 * The insert-side test. Exact, after folding case and spacing, so nothing that is
 * merely similar can stop a new record being written.
 */
function findIdentityIndex(
  identities: readonly string[],
  target: string,
  excluded: ReadonlySet<number> = NO_EXCLUSIONS,
): number {
  if (target === NO_IDENTITY) return -1;
  return identities.findIndex((identity, i) => !excluded.has(i) && identity === target);
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
/**
 * How a particular cell lists what it holds.
 *
 * Evidence and sources are lists of short references, so a comma or a semicolon
 * between them separates two of them. A note is prose: a comma inside it is
 * punctuation, and only a semicolon has ever been used to join two notes.
 */
interface MergeStyle {
  separators: ReadonlySet<string>;
  joiner: string;
}

const REFERENCE_LIST: MergeStyle = { separators: new Set([",", ";"]), joiner: ", " };
const PROSE_NOTES: MergeStyle = { separators: new Set([";"]), joiner: "; " };

/**
 * Split a cell into the values it lists, ignoring separators inside markdown syntax.
 *
 * A link destination carries its own commas: splitting
 * `[dashboard](https://example.com/explore?q=a,b)` on every comma tore the URL in half
 * and put a space in the middle of it. Only a separator outside every bracket, paren
 * and code span divides one value from the next.
 */
function splitValues(text: string, style: MergeStyle): string[] {
  const values: string[] = [];
  let current = "";
  let brackets = 0;
  let parens = 0;
  let inCode = false;

  for (const char of text) {
    if (char === "`") inCode = !inCode;
    else if (!inCode) {
      if (char === "[") brackets++;
      else if (char === "]" && brackets > 0) brackets--;
      else if (char === "(") parens++;
      else if (char === ")" && parens > 0) parens--;
      else if (style.separators.has(char) && brackets === 0 && parens === 0) {
        values.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  values.push(current);

  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * The values in `incoming` that `stored` does not already list.
 *
 * A rerun of the same week often carries more evidence than the first run did
 * ("TEAM-1234" becoming "TEAM-1234, TEAM-1235"). Dropping the second because the record
 * is already there would throw that away. Comparison is by whole value: as substrings,
 * TEAM-123 disappeared into TEAM-1234, which is one ticket swallowing another.
 */
function mergeValues(
  stored: string,
  incoming: string,
  style: MergeStyle,
  canonical: Canonicalizer = INSERT_IDENTITY,
): string[] {
  const next = incoming.trim();
  if (next.length === 0 || isPlaceholder(next)) return [];

  const seen = new Set(splitValues(stored, style).map(canonical));
  const additions: string[] = [];
  for (const value of splitValues(next, style)) {
    const key = canonical(value);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(value);
  }
  return additions;
}

/** Fold a newer value into the stored one. Stable: merging twice adds nothing twice. */
function mergeCell(
  stored: string,
  incoming: string,
  style: MergeStyle,
  canonical?: Canonicalizer,
): string {
  const additions = mergeValues(stored, incoming, style, canonical);
  if (additions.length === 0) return stored;
  const kept = stored.trim();
  const added = additions.join(style.joiner);
  return kept.length === 0 ? added : `${kept}${style.joiner}${added}`;
}

/**
 * Fold the named columns of `incoming` into `row`, or null when nothing changed.
 *
 * The cell keeps its own source and gains only the new fragment. Escaping is not the
 * inverse of reading: a cell holding an escaped asterisk comes back from the scan with
 * its backslash, and running the merged text through escapeCell would escape that
 * backslash again, so the cell would gain one every week it was merged into. Only what
 * is genuinely new gets escaped, and only once.
 */
/**
 * The duplicate's own text for the values being carried across.
 *
 * Reading a cell resolves the pipe and backslash escapes and nothing else, so putting
 * the result back through `escapeCell` escapes what it left alone: an evidence cell
 * holding an escaped asterisk came out of a fold with a second backslash. The
 * fragments the duplicate wrote are appended exactly as it wrote them.
 */
function rawAdditions(
  rawCell: string,
  parsedCell: string,
  additions: readonly string[],
  style: MergeStyle,
): string {
  const raw = splitValues(rawCell, style);
  const parsed = splitValues(parsedCell, style);
  const wanted = new Set(additions);

  const picked: string[] = [];
  for (const [i, value] of parsed.entries()) {
    // Consumed, not just matched: a duplicate row that lists the same value twice
    // would otherwise append it twice, though the merge decided on it once.
    // Falls back to escaping if the two ever disagree on where a value ends.
    if (wanted.delete(value)) picked.push(raw[i] ?? escapeCell(value));
  }
  return picked.join(style.joiner);
}

function mergeRowCells(
  row: string,
  incoming: readonly string[],
  column: number,
  style: MergeStyle,
  canonical?: Canonicalizer,
  incomingRaw?: readonly string[],
): string | null {
  const scanned = scanRow(row);
  while (scanned.values.length <= column) {
    scanned.values.push("");
    scanned.raw.push("");
  }

  const value = incoming[column] ?? "";
  const additions = mergeValues(scanned.values[column], value, style, canonical);
  if (additions.length === 0) return null;

  const escaped = incomingRaw
    ? rawAdditions(incomingRaw[column] ?? "", value, additions, style)
    : escapeCell(additions.join(style.joiner));
  const source = scanned.raw[column].trimEnd();
  scanned.raw[column] = source.trim().length === 0 ? ` ${escaped} ` : `${source}${style.joiner}${escaped} `;
  scanned.values[column] = mergeCell(scanned.values[column], value, style, canonical);

  return renderScannedRow(scanned);
}

/** True when a line is the header row this code expects. */
function matchesHeader(line: string, header: readonly string[]): boolean {
  const cells = splitRow(line);
  return cells.length === header.length && cells.every((cell, i) => canonicalText(cell) === canonicalText(header[i]));
}

/**
 * Locate the table with the expected header between `from` and `limit`, or null.
 *
 * Tables in range are walked in order rather than only the first being considered, so
 * an unrelated table above the one this code maintains hides nothing.
 */
function findTableByHeader(
  lines: readonly string[],
  from: number,
  limit: number,
  header: readonly string[],
): TableBounds | null {
  let cursor = from;
  while (cursor < limit) {
    const table = findTable(lines, cursor);
    if (!table || table.rowStart - 1 >= limit) return null;
    const headerIdx = table.rowStart - 2;
    if (headerIdx >= 0 && matchesHeader(lines[headerIdx], header)) return table;
    cursor = Math.max(table.rowEnd, table.rowStart);
  }
  return null;
}

/** A row's identity: every cell that is not the one designated mergeable. */
function rowIdentity(row: string, columns: readonly number[], canonical?: Canonicalizer): string {
  return identityOf(columns.map((column) => rowCell(row, column)), canonical);
}

/**
 * What makes a memory row that row: its date, its item and its category.
 *
 * The date is part of it. Memory is where small work accumulates until it adds up to
 * something, and the same task done again next week is another instance of it, not a
 * repeat of the first: collapsing "Reviewed the incident runbook" on two dates into
 * one row loses exactly the evidence the file exists to gather. The category is part
 * of it because filing that work under a different heading is a different claim about
 * it, and the row that named the category would otherwise swallow the one that
 * renamed it.
 */
function memoryIdentity(row: string, canonical?: Canonicalizer): string {
  return rowIdentity(row, MEMORY_IDENTITY_COLUMNS, canonical);
}

/** What makes an impact row that row: everything it claims except the evidence for it. */
function impactIdentity(row: string, canonical?: Canonicalizer): string {
  return rowIdentity(row, IMPACT_IDENTITY_COLUMNS, canonical);
}

/** Cell of a table row, or "" when the row is shorter than expected. */
function rowCell(row: string, index: number): string {
  return splitRow(row)[index] ?? "";
}

interface Fence {
  marker: string;
  length: number;
  info: string;
}

/** Read a fence line: up to three leading spaces, then three or more backticks or tildes. */
function readFence(line: string): Fence | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;

  const marker = line[i];
  if (marker !== "`" && marker !== "~") return null;

  let length = 0;
  while (line[i + length] === marker) length++;
  if (length < 3) return null;

  const info = line.slice(i + length).trim();
  // A backtick fence's info string may not itself contain a backtick.
  if (marker === "`" && info.includes("`")) return null;
  return { marker, length, info };
}

/**
 * The file's lines with everything inside a fenced code block blanked out.
 *
 * A vault file can hold an example of the very shape this code maintains: a fenced
 * block showing "## Key Strengths" and a "- (none)" under it. Read as structure, the
 * writers aimed at the example and the cleanup deleted a line out of it. Blanking the
 * fenced lines keeps every index aligned with the real file, so locating structure and
 * editing it stay in step.
 */
function maskFenced(lines: readonly string[]): string[] {
  const masked = [...lines];
  let open: { start: number; fence: Fence } | null = null;

  for (const [i, line] of lines.entries()) {
    const fence = readFence(line);
    if (!open) {
      if (fence) open = { start: i, fence };
      continue;
    }
    // A closing fence matches the character, is at least as long, and carries no info.
    if (fence && fence.marker === open.fence.marker && fence.length >= open.fence.length && fence.info.length === 0) {
      for (let j = open.start; j <= i; j++) masked[j] = "";
      open = null;
    }
  }
  // An unclosed fence runs to the end of the file.
  if (open) for (let j = open.start; j < masked.length; j++) masked[j] = "";

  return masked;
}

/**
 * True for a GFM thematic break: up to three leading spaces, then three or more of the
 * same marker with nothing but spacing between them. A fourth leading space makes it a
 * code line instead.
 */
function isThematicBreak(line: string): boolean {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;

  const marker = line[i];
  if (marker !== "-" && marker !== "*" && marker !== "_") return false;

  let count = 0;
  for (const char of line.slice(i)) {
    if (char === marker) count++;
    else if (char !== " " && char !== "\t") return false;
  }
  return count >= 3;
}

/**
 * Index of the line closing a leading YAML frontmatter block, or -1 when there is none.
 * Delimiters sit at column 0; an indented `---` is content inside the block, not its end.
 *
 * The same four lines as `frontmatterEnd` in `focus.ts`, which is private to that
 * module. Duplicated rather than exported so focus tracking keeps its own copy of a
 * rule it already relies on.
 */
function frontmatterEnd(lines: readonly string[]): number {
  const isDelimiter = (line: string) => line === "---" || line === "---\r";
  if (!isDelimiter(lines[0] ?? "")) return -1;
  for (let i = 1; i < lines.length; i++) if (isDelimiter(lines[i])) return i;
  return -1;
}

/** First line of the document body. Everything above it is frontmatter, whatever it looks like. */
function bodyStart(lines: readonly string[]): number {
  return frontmatterEnd(lines) + 1;
}

interface Heading {
  level: number;
  /** Canonical heading text: case folded, whitespace collapsed. */
  text: string;
}

/**
 * Parse an ATX heading, or null when the line is not one.
 *
 * Every boundary in this file goes through here. Three of them used to test column
 * zero with `startsWith`, so the three leading spaces GFM allows were enough to hide
 * an archived heading from the archive check and stop a section ever ending.
 */
function parseHeading(line: string): Heading | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;

  let level = 0;
  while (line[i + level] === "#") level++;
  if (level === 0 || level > 6) return null;

  const rest = line.slice(i + level);
  // `##text` is not a heading; `##` alone is an empty one.
  if (rest.length > 0 && rest[0] !== " " && rest[0] !== "\t") return null;

  // ATX headings may close with their own run of hashes: `## Impact Timeline ##`.
  let end = rest.length;
  while (end > 0 && (rest[end - 1] === " " || rest[end - 1] === "\t")) end--;
  let hashes = end;
  while (hashes > 0 && rest[hashes - 1] === "#") hashes--;
  const closes = hashes < end && (hashes === 0 || rest[hashes - 1] === " " || rest[hashes - 1] === "\t");

  return { level, text: canonicalText(rest.slice(0, closes ? hashes : end)) };
}

/** The text of an H2 heading line, or null when the line is not one. */
function h2Text(line: string): string | null {
  const heading = parseHeading(line);
  return heading?.level === 2 ? heading.text : null;
}

/** True for the heading that opens an archived or historical era. */
function isArchivedHeading(line: string): boolean {
  const heading = parseHeading(line);
  if (!heading) return false;
  const words = heading.text.split(" ");
  return words.includes("archived") || words.includes("historical");
}

/**
 * Where the live part of a vault file stops. Everything below an archived heading is
 * kept for the record: a row, a table or a status line down there belongs to a team era
 * that has ended, and rewriting it would rewrite history.
 */
function liveRegionEnd(lines: readonly string[]): number {
  for (let i = bodyStart(lines); i < lines.length; i++) {
    if (isArchivedHeading(lines[i])) return i;
  }
  return lines.length;
}

/** True where a heading closes the section above it. A subsection does not. */
function endsSection(line: string): boolean {
  const heading = parseHeading(line);
  return heading !== null && heading.level <= 2;
}

/** Where a section ends: the next heading of its own level or higher, a rule, or the end. */
function sectionEnd(lines: readonly string[], headingIdx: number): number {
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (endsSection(lines[i]) || isThematicBreak(lines[i])) return i;
  }
  return lines.length;
}

/**
 * True when a heading is the one this code maintains.
 *
 * The text has to match, or match with a single parenthesized qualifier after it and
 * nothing else. People annotate their own headings: a real vault reads
 * `## Key Strengths (for coaching context)`, and refusing that left the file neither
 * written to nor cleaned. `## Key Strengths Archive` and `## Key Strengths: old` are
 * still somebody else's section.
 */
function headingMatches(text: string, target: string): boolean {
  if (text === target) return true;

  const opener = `${target} (`;
  if (!text.startsWith(opener) || !text.endsWith(")")) return false;

  const qualifier = text.slice(opener.length, -1);
  return qualifier.length > 0 && !qualifier.includes("(") && !qualifier.includes(")");
}

/**
 * Index of the live H2 that is `heading`, or -1.
 *
 * Used where landing in the wrong section writes or deletes someone else's data:
 * `## Impact Timeline Notes` is not the impact timeline.
 */
function findExactHeading(lines: readonly string[], heading: string, limit: number): number {
  const target = h2Text(heading) ?? canonicalText(heading);
  for (let i = bodyStart(lines); i < limit; i++) {
    const text = h2Text(lines[i]);
    if (text !== null && headingMatches(text, target)) return i;
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
    if (endsSection(lines[i])) return i;
  }
  return limit;
}

/**
 * Insert bullets at `at`, keeping a blank line between them and whatever follows.
 *
 * Without it the seeded hint line ends up directly under the last inserted bullet,
 * where the next run reads it as part of that bullet.
 */
function insertBullets(lines: string[], at: number, bullets: readonly string[]): void {
  const following = lines[at];
  const needsGap = following !== undefined && following.trim().length > 0 && !following.startsWith(BULLET_MARKER);
  lines.splice(at, 0, ...bullets, ...(needsGap ? [""] : []));
}

/**
 * Rewrite the first line starting with `prefix` between `from` and `to`.
 *
 * Both bounds matter: scanning from the top of the file rewrote a status line under a
 * summary section above the timeline and left the timeline's own line stale.
 */
function findLineWithPrefix(scan: readonly string[], from: number, to: number, prefix: string): number {
  for (let i = Math.max(from, 0); i < to; i++) {
    if (scan[i].startsWith(prefix)) return i;
  }
  return -1;
}

function replaceFirstLine(
  lines: string[],
  scan: readonly string[],
  from: number,
  to: number,
  prefix: string,
  replacement: string,
): boolean {
  const idx = findLineWithPrefix(scan, from, to, prefix);
  if (idx === -1 || lines[idx] === replacement) return false;
  lines[idx] = replacement;
  return true;
}

/** A file last edited on Windows keeps its CRLF endings, so generated lines must match. */
function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function toLines(content: string): string[] {
  return content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

const BULLET_MARKER = "- ";
/** A continuation of a `- ` bullet sits at or past the column its content starts in. */
const CONTINUATION_INDENT = 2;

interface BulletItem {
  /** Index of the marker line. */
  start: number;
  /** One past the item's last line. */
  end: number;
  /** The whole item: the marker line's content, then each continuation, space joined. */
  text: string;
}

/** True for a line that is structure rather than prose, and so ends the item above it. */
function endsBullet(line: string): boolean {
  if (line.trim().startsWith("|")) return true;
  return isThematicBreak(line) || parseHeading(line) !== null;
}

/**
 * The bullets between `from` and `to`, each with the lines that continue it.
 *
 * Reading only the marker line made two bullets that begin the same word for word into
 * one record, and the cleanup merged both continuations into whichever it kept. A
 * continuation may be indented to the content column or not indented at all, which GFM
 * calls a lazy continuation and is what a wrapped line in a hand-edited file usually
 * looks like. Either way it ends at a blank line, the next bullet, or any structure.
 *
 * An indented line this cannot attribute to the bullet above it returns null instead,
 * and the caller leaves the section alone: guessing here deletes what somebody wrote.
 */
function readBullets(lines: readonly string[], from: number, to: number): BulletItem[] | null {
  const items: BulletItem[] = [];
  let open: BulletItem | null = null;

  for (let i = from; i < to; i++) {
    const line = lines[i];

    if (line.startsWith(BULLET_MARKER)) {
      open = { start: i, end: i + 1, text: line.slice(BULLET_MARKER.length).trim() };
      items.push(open);
      continue;
    }
    // The seeded files put their own hint directly under the heading, and a hint read
    // as a lazy continuation changes the identity of the note above it, so the same
    // note would be written again every week.
    if (line.trim().length === 0 || endsBullet(line) || isPlaceholder(line)) {
      open = null;
      continue;
    }

    if (open && open.end === i) {
      open.end = i + 1;
      open.text = `${open.text} ${line.trim()}`;
      continue;
    }

    // Indented prose under no bullet is content this cannot place. Unindented prose is
    // just the section's own text.
    const indent = line.length - line.trimStart().length;
    if (indent >= CONTINUATION_INDENT) return null;
    open = null;
  }

  return items;
}

/**
 * Marks an identity that is a whole bullet rather than the info field of a generated
 * one. A NUL cannot come out of `canonicalText`, so the two kinds can never collide.
 */
const FREEFORM_NOTE = "\u0000";

interface OrgNote {
  /** The category label of a generated bullet, or "" for anything else. */
  category: string;
  /** The info of a generated bullet, or the whole bullet for anything else. */
  text: string;
  /** True when the bullet has the shape this code writes. */
  generated: boolean;
}

/** Drop the `_(source)_` suffix, which is evidence rather than identity. */
function stripNoteSource(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.endsWith(")_")) return trimmed;
  const start = trimmed.lastIndexOf("_(");
  return start === -1 ? trimmed : trimmed.slice(0, start).trim();
}

/**
 * Read an organizational note.
 *
 * The generated shape is `- **Category:** info _(source)_`, and only there is the
 * leading bold a label to be dropped. Dropping any leading bold span made
 * "**Deploy manually** for legacy tenants" and "**Never deploy manually** for legacy
 * tenants" the same note, and the cleanup deleted the second.
 */
function parseOrgNote(body: string): OrgNote {
  if (body.startsWith("**")) {
    const labelEnd = body.indexOf("**", 2);
    const label = body.slice(2, labelEnd).trimEnd();
    if (labelEnd !== -1 && label.endsWith(":")) {
      return {
        category: label.slice(0, -1).trim(),
        text: stripNoteSource(body.slice(labelEnd + 2)),
        generated: true,
      };
    }
  }
  // A freeform bullet's `_(...)_` is part of what it says, not evidence for it:
  // "Deploy on Fridays _(except holidays)_" is not the note that says "_(including
  // holidays)_", and stripping the suffix made them one.
  return { category: "", text: body.trim(), generated: false };
}

/**
 * What decides whether a note is already in the file.
 *
 * The category is part of it: the same fact filed under "policy" is a different note
 * from the one filed under "process", and identifying by the info alone let whichever
 * arrived first keep its label and swallow the other.
 */
function generatedNoteIdentity(category: string, info: string, canonical?: Canonicalizer): string {
  return identityOf([category, info], canonical);
}

function orgNoteIdentity(body: string, canonical?: Canonicalizer): string {
  const note = parseOrgNote(body);
  return note.generated
    ? generatedNoteIdentity(note.category, note.text, canonical)
    : identityOf([FREEFORM_NOTE, note.text], canonical);
}

/** What decides whether a note says anything at all. */
function orgNoteText(body: string): string {
  return parseOrgNote(body).text;
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
function mergeNoteSource(bullet: string, source: string, canonical?: Canonicalizer): string | null {
  const value = source.trim();
  if (value.length === 0 || isPlaceholder(value)) return null;

  const trimmed = bullet.trimEnd();
  const start = trimmed.endsWith(")_") ? trimmed.lastIndexOf("_(") : -1;
  if (start === -1) return `${trimmed} _(${value})_`;

  const stored = trimmed.slice(start + 2, trimmed.length - 2);
  const merged = mergeCell(stored, value, REFERENCE_LIST, canonical);
  return merged === stored ? null : `${trimmed.slice(0, start)}_(${merged})_`;
}

export type VaultWriteStatus = "written" | "unchanged" | "placeholder" | "no-section";

/**
 * What one batch did to a file.
 *
 * The status describes the file; the counts describe the records in the batch, which
 * is what a run summary needs. A batch of one repeat and one new record is a written
 * file with one added and one skipped, and reporting it as two updates was how the
 * weekly summary came to overstate every week's work.
 */
export interface VaultWriteResult {
  status: VaultWriteStatus;
  /** Records inserted. */
  added: number;
  /** Records taken out, which only graduation does. */
  removed: number;
  /** Records already present that gained something from this batch. */
  merged: number;
  /** Records proposed that changed nothing: placeholders, and repeats with nothing new. */
  skipped: number;
}

function writeResult(status: VaultWriteStatus, counts: Partial<Omit<VaultWriteResult, "status">> = {}): VaultWriteResult {
  return { status, added: 0, removed: 0, merged: 0, skipped: 0, ...counts };
}

/** A removal that named no row exactly, and the row it came closest to. */
export interface UnmatchedGraduation {
  requested: string;
  /** The nearest row by wording, or "" when nothing came close. */
  candidate: string;
}

export interface MemoryWriteResult extends VaultWriteResult {
  /**
   * Removals that were not carried out.
   *
   * Closing a memory item deletes a line, so it takes an exact match. The model
   * paraphrases, and a paraphrase is not evidence: "Disable service billing alerts"
   * scores 0.83 against a row that says "Enable service billing alerts", with nothing
   * else close enough to make it ambiguous. Deleting on that is a wrong delete the
   * user cannot see. The near miss is reported instead, for them to settle by hand.
   */
  unmatchedGraduations: UnmatchedGraduation[];
}

export async function updateMemory(
  memoryPath: string,
  itemsToAdd: string[],
  itemsToRemove: string[],
): Promise<MemoryWriteResult> {
  const original = existsSync(memoryPath) ? await readFile(memoryPath, "utf-8") : MEMORY_TEMPLATE;
  const eol = detectEol(original);
  const lines = toLines(original);
  // Structure is located in the masked copy and edits are applied to the real lines;
  // the two stay index-aligned.
  const scan = maskFenced(lines);
  const liveEnd = liveRegionEnd(scan);

  // The live era's memory table, or nothing. A memory.md whose only such table sits
  // under an archived heading has no live table: appending there would file this
  // week's work under a team the user left, and a graduation would delete a row from
  // that record.
  const table = findTableByHeader(scan, bodyStart(scan), liveEnd, MEMORY_HEADER);
  if (!table) {
    const skipped = itemsToAdd.length + itemsToRemove.length;
    const requested = itemsToRemove.map((removal) => ({ requested: removal, candidate: "" }));
    return { ...writeResult("no-section", { skipped }), unmatchedGraduations: requested };
  }

  const rowEnd = Math.min(table.rowEnd, liveEnd);
  const rows = lines.slice(table.rowStart, rowEnd);
  const items = rows.map((row) => rowCell(row, MEMORY_ITEM_COLUMN));

  // Graduation deletes a line, so it takes the row's own text. The scored lookup is
  // still run, but only to name the row the model probably meant, for the caller to
  // pass on to the user.
  const graduated = new Set<number>();
  const unmatchedGraduations: UnmatchedGraduation[] = [];
  for (const removal of itemsToRemove) {
    // The whole string is the item. It used to be cut at a "(now part of" suffix the
    // caller appended, which also cut any item that contained that phrase itself.
    const target = removal.trim();

    // The model names the item, not the day it happened, so every date of that item
    // graduates together: they were all folded into the same achievement. Case is not
    // folded here: this deletes rows, and "Set API_KEY" is not "Set api_key".
    const canonical = DELETE_IDENTITY(target);
    let found = false;
    for (const [i, item] of items.entries()) {
      if (DELETE_IDENTITY(item) !== canonical) continue;
      graduated.add(i);
      found = true;
    }
    if (found) continue;

    const nearest = findRecordIndex(items, target, graduated);
    unmatchedGraduations.push({ requested: target, candidate: nearest === -1 ? "" : items[nearest] });
  }

  const kept = rows.filter((_, i) => !graduated.has(i));
  const newRows: string[] = [];
  // Rows already in the file, then rows queued by this batch, so a repeat inside one
  // batch is folded into the row queued moments earlier rather than added twice.
  const pending = kept.map((row) => memoryIdentity(row));
  let merged = 0;
  let skipped = 0;

  for (const row of itemsToAdd) {
    if (!row.includes("|")) {
      skipped++;
      continue;
    }
    const incoming = splitRow(row);
    const item = incoming[MEMORY_ITEM_COLUMN] ?? "";
    if (isPlaceholder(item)) {
      skipped++;
      continue;
    }

    const identity = rowIdentity(row, MEMORY_IDENTITY_COLUMNS);
    const idx = findIdentityIndex(pending, identity);
    if (idx === -1) {
      newRows.push(row);
      pending.push(identity);
      continue;
    }

    const target = idx < kept.length ? kept : newRows;
    const offset = idx < kept.length ? idx : idx - kept.length;
    const folded = mergeRowCells(target[offset], incoming, MEMORY_NOTES_COLUMN, PROSE_NOTES);
    if (folded) {
      target[offset] = folded;
      merged++;
    } else {
      skipped++;
    }
  }

  const counts = { added: newRows.length, removed: graduated.size, merged, skipped };
  if (counts.added === 0 && counts.removed === 0 && counts.merged === 0) {
    return { ...writeResult("unchanged", counts), unmatchedGraduations };
  }

  lines.splice(table.rowStart, rows.length, ...kept, ...newRows);
  await writeFile(memoryPath, lines.join(eol), "utf-8");
  return { ...writeResult("written", counts), unmatchedGraduations };
}

/**
 * What became of an update.
 *
 * "placeholder" is the model having nothing worth recording and "unchanged" is
 * everything it said already being in the file; both are normal and quiet.
 * "no-section" is the file not having the live heading to write under, which is worth
 * telling the user about: the update existed and had nowhere to go.
 */
/** Today where the user is, as a plain date. */
function localIsoDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * How long ago an impact was, in whole weeks, as the gap line says it.
 *
 * Both sides are calendar days: subtracting UTC midnight from the current instant put
 * the answer a day out for anyone east of Greenwich, so a run at 00:30 on the seventh
 * day still called the gap closed.
 */
function gapText(latest: string, now: Date): string {
  const today = localIsoDate(now);
  if (!isIsoDate(latest) || !isIsoDate(today)) return GAP_CLOSED;

  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest}T00:00:00Z`)) / 86_400_000);
  const weeks = Math.floor(days / 7);
  if (weeks < 1) return GAP_CLOSED;
  return `${weeks} week${weeks === 1 ? "" : "s"}`;
}

/**
 * Rewrite one of the timeline's status lines, wherever the user keeps it.
 *
 * Inside the section first, because a copy above the heading belongs to whatever
 * section is up there. Failing that, anywhere below the heading in the live region:
 * a real vault keeps these lines under a heading of their own further down, and
 * bounding the search to the section left them saying something no longer true.
 */
function setStatusLine(
  lines: string[],
  scan: readonly string[],
  headingIdx: number,
  scope: number,
  liveEnd: number,
  prefix: string,
  replacement: string,
): boolean {
  if (findLineWithPrefix(scan, headingIdx, scope, prefix) !== -1) {
    return replaceFirstLine(lines, scan, headingIdx, scope, prefix, replacement);
  }
  return replaceFirstLine(lines, scan, headingIdx, liveEnd, prefix, replacement);
}

/**
 * Point the timeline's status lines at the rows that are still there.
 *
 * The cleanup can remove the row those lines were describing: a placeholder row dated
 * later than every real one left the file claiming an impact on a date it no longer
 * held. Nothing is rewritten when no dated row survives, since there is then nothing
 * truthful to say.
 */
function refreshImpactStatus(content: string, eol: string, now: Date): string {
  const lines = toLines(content);
  const scan = maskFenced(lines);
  const liveEnd = liveRegionEnd(scan);

  const headingIdx = findExactHeading(scan, IMPACT_TIMELINE_HEADING, liveEnd);
  if (headingIdx === -1) return content;

  const scope = sectionScope(scan, headingIdx, liveEnd);
  const table = findTableByHeader(scan, headingIdx, scope, IMPACT_HEADER);
  if (!table) return content;

  const latest = latestRowDate(lines.slice(table.rowStart, Math.min(table.rowEnd, scope)));
  const impact = latest.length === 0 ? NO_IMPACT_RECORDED : latest;
  const gap = latest.length === 0 ? NO_GAP_RECORDED : gapText(latest, now);

  // Both lines are rewritten on every cleanup, not only when the date moved: the gap
  // is measured from today, so it goes stale on its own even when the rows do not.
  setStatusLine(lines, scan, headingIdx, scope, liveEnd, LAST_IMPACT_PREFIX, `${LAST_IMPACT_PREFIX} ${impact}`);
  setStatusLine(lines, scan, headingIdx, scope, liveEnd, CURRENT_GAP_PREFIX, `${CURRENT_GAP_PREFIX} ${gap}`);
  return lines.join(eol);
}

/**
 * True for a `YYYY-MM-DD` cell that is a real day.
 *
 * The shape alone is not enough: the model can produce 2026-13-01, and a month that
 * does not exist sorted above every real row and became the latest impact. Parsing and
 * round-tripping is what separates a date from a string that looks like one.
 */
export function isIsoDate(value: string): boolean {
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
    if (value[i] < "0" || value[i] > "9") return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
  now: Date = new Date(),
): Promise<VaultWriteResult> {
  // A date that is not a day cannot be filed against one.
  const nothingToRecord = !entry || isPlaceholder(entry.achievement) || !isIsoDate(entry.date);

  // Nothing to record and no file yet: creating one to say it holds nothing would be
  // writing a file the user never asked for. The first real entry creates it.
  const exists = existsSync(impactLogPath);
  if (!exists && nothingToRecord) return writeResult("placeholder", { skipped: entry ? 1 : 0 });

  const original = exists ? await readFile(impactLogPath, "utf-8") : IMPACT_LOG_TEMPLATE;
  const eol = detectEol(original);
  const lines = toLines(original);
  const scan = maskFenced(lines);
  const liveEnd = liveRegionEnd(scan);

  const headingIdx = findExactHeading(scan, IMPACT_TIMELINE_HEADING, liveEnd);
  if (headingIdx === -1) return writeResult("no-section", { skipped: nothingToRecord ? 0 : 1 });

  // Everything this function touches lives between the heading and the next one. A
  // table further down the file belongs to another section, and an archived era's
  // status lines record what was true when that era ended.
  const scope = sectionScope(scan, headingIdx, liveEnd);
  const table = findTableByHeader(scan, headingIdx, scope, IMPACT_HEADER);
  if (!table) return writeResult("no-section", { skipped: nothingToRecord ? 0 : 1 });

  const counts = { added: 0, removed: 0, merged: 0, skipped: 0 };
  if (entry && !nothingToRecord) {
    const rowEnd = Math.min(table.rowEnd, scope);
    const rows = lines.slice(table.rowStart, rowEnd);
    const incoming = [entry.date, entry.achievement, entry.scope, entry.coreValue, entry.evidence];
    // The same claim on the same date is the same entry; a different scope or value is
    // a different claim, not more evidence for this one.
    const keys = rows.map((row) => impactIdentity(row));
    const idx = findIdentityIndex(keys, identityOf(IMPACT_IDENTITY_COLUMNS.map((column) => incoming[column])));

    if (idx === -1) {
      lines.splice(rowEnd, 0, renderRow(incoming));
      counts.added = 1;
    } else {
      const folded = mergeRowCells(rows[idx], incoming, IMPACT_EVIDENCE_COLUMN, REFERENCE_LIST);
      if (folded) {
        lines[table.rowStart + idx] = folded;
        counts.merged = 1;
      } else {
        counts.skipped = 1;
      }
    }
  } else {
    counts.skipped = entry ? 1 : 0;
  }

  // The status lines describe the file rather than this entry, and the gap is measured
  // from today, so it goes stale where the rows do not. Both are derived from the table
  // on every run, which is also why replaying an older week cannot rewind them.
  const next = refreshImpactStatus(lines.join(eol), eol, now);
  if (next === toLines(original).join(eol)) {
    return writeResult(nothingToRecord ? "placeholder" : "unchanged", counts);
  }

  await writeFile(impactLogPath, next, "utf-8");
  return writeResult("written", counts);
}

export async function updateWorkContext(
  workContextPath: string,
  updates: BragBookResult["workContextUpdates"],
  now: Date = new Date(),
): Promise<VaultWriteResult> {
  if (updates.length === 0) return writeResult("placeholder");
  // Seeded by `worklog init`. Gone means the user removed it, which is not this code's
  // business to undo.
  if (!existsSync(workContextPath)) return writeResult("no-section", { skipped: updates.length });

  const original = await readFile(workContextPath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const scan = maskFenced(lines);
  const liveEnd = liveRegionEnd(scan);

  // Exact, like the cleanup: a section merely named like this one belongs to someone
  // else, and notes filed under it are notes the user will not find again.
  const headingIdx = findExactHeading(scan, ORG_NOTES_HEADING, liveEnd);
  if (headingIdx === -1) return writeResult("no-section", { skipped: updates.length });

  const end = Math.min(sectionEnd(scan, headingIdx), liveEnd);
  const bullets = readBullets(scan, headingIdx + 1, end);
  if (!bullets) return writeResult("no-section", { skipped: updates.length });

  // Notes already in the file, then notes queued by this batch. Queued notes stay
  // structured so a later update naming the same fact folds its source into them
  // instead of being dropped.
  const queued: Array<{ category: string; info: string; source: string }> = [];
  const notes = bullets.map((bullet) => orgNoteIdentity(bullet.text));
  let changed = false;
  let merged = 0;
  let skipped = 0;

  for (const update of updates) {
    if (isPlaceholder(update.info)) {
      skipped++;
      continue;
    }
    const identity = generatedNoteIdentity(update.category, update.info);
    const idx = findIdentityIndex(notes, identity);

    if (idx === -1) {
      queued.push({ category: update.category, info: update.info, source: update.source });
      notes.push(identity);
      continue;
    }

    if (idx < bullets.length) {
      // The source sits at the end of the note, which is its last line.
      const target = bullets[idx].end - 1;
      const folded = mergeNoteSource(lines[target], update.source);
      if (folded) {
        lines[target] = folded;
        changed = true;
        merged++;
      } else {
        skipped++;
      }
      continue;
    }

    const note = queued[idx - bullets.length];
    const source = mergeCell(note.source, update.source, REFERENCE_LIST);
    if (source === note.source) skipped++;
    else merged++;
    note.source = source;
  }

  if (queued.length > 0) {
    let insertAt = headingIdx + 1;
    if (lines[insertAt]?.trim() === "") insertAt++;
    insertBullets(lines, insertAt, queued.map((note) => `- **${note.category}:** ${note.info} _(${note.source})_`));
    changed = true;
    // The stamp says when a note was last added, so it only moves when one was. Moving
    // it on every run made a rerun of the same week differ from the first run.
    const stamp = now.toISOString().split("T")[0];
    const shifted = maskFenced(lines);
    replaceFirstLine(lines, shifted, 0, liveRegionEnd(shifted), LAST_UPDATED_PREFIX, `*Last updated: ${stamp}*`);
  }

  const counts = { added: queued.length, removed: 0, merged, skipped };
  if (!changed) return writeResult("unchanged", counts);
  await writeFile(workContextPath, lines.join(eol), "utf-8");
  return writeResult("written", counts);
}

export async function updateProfile(
  profilePath: string,
  update: BragBookResult["profileUpdate"],
): Promise<VaultWriteResult> {
  if (!update || isPlaceholder(update.bulletPoint)) return writeResult("placeholder", { skipped: update ? 1 : 0 });
  // Seeded by `worklog init`, like work-context.md.
  if (!existsSync(profilePath)) return writeResult("no-section", { skipped: 1 });

  const original = await readFile(profilePath, "utf-8");
  const eol = detectEol(original);
  const lines = toLines(original);
  const scan = maskFenced(lines);
  const liveEnd = liveRegionEnd(scan);

  const headingIdx = findExactHeading(scan, KEY_STRENGTHS_HEADING, liveEnd);
  if (headingIdx === -1) return writeResult("no-section", { skipped: 1 });

  const end = Math.min(sectionEnd(scan, headingIdx), liveEnd);
  const bullets = readBullets(scan, headingIdx + 1, end);
  if (!bullets) return writeResult("no-section", { skipped: 1 });
  const strengths = bullets.map((bullet) => identityOf([bullet.text]));
  if (findIdentityIndex(strengths, identityOf([update.bulletPoint])) !== -1) {
    return writeResult("unchanged", { skipped: 1 });
  }

  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  insertBullets(lines, insertAt, [`- ${update.bulletPoint}`]);

  await writeFile(profilePath, lines.join(eol), "utf-8");
  return writeResult("written", { added: 1 });
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
  /** Entries recovered from a row that several of them had been written into. */
  unjoined: number;
  /**
   * Cell counts of rows that looked joined but could not be split safely.
   *
   * Reported rather than guessed at: a row of the wrong width is damage this code does
   * not recognise, and rewriting it on a hunch is how the damage got there.
   */
  unjoinSkipped: number[];
  /**
   * Where the file as it was before this run was kept, or "" when nothing was removed.
   *
   * A run that only refreshes a status line takes no backup: the gap ages every day,
   * and a backup a day would bury the one copy that matters.
   */
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

    // The identity is already canonical; a record that identifies nothing is never a
    // repeat of another one.
    const survivor = record.identity === NO_IDENTITY ? undefined : survivors.get(record.identity);
    if (survivor !== undefined) {
      duplicates++;
      keep.push(false);
      const folded = fold(lines[survivor], record.line);
      if (folded) lines[survivor] = folded;
      continue;
    }

    survivors.set(record.identity, i);
    keep.push(true);
  }

  return { keep, lines, placeholders, duplicates };
}

function unchanged(lines: readonly string[], eol: string): CleanedRecords {
  return { content: lines.join(eol), placeholders: 0, duplicates: 0 };
}

function cleanTable(
  lines: string[],
  scan: readonly string[],
  fromLine: number,
  limit: number,
  eol: string,
  header: readonly string[],
  recordOf: (row: string) => StoredRecord,
  fold: FoldRecord,
): CleanedRecords {
  // Both bounds and the header have to hold: a table further down the file, one inside
  // a fenced example, or one this code does not recognise, belongs to someone else and
  // deleting rows from it would be deleting their data.
  const table = findTableByHeader(scan, fromLine, limit, header);
  if (!table) return unchanged(lines, eol);

  const rowEnd = Math.min(table.rowEnd, limit);
  const rows = lines.slice(table.rowStart, rowEnd);
  const mask = keepMask(rows.map(recordOf), fold);
  const next = [...lines];
  next.splice(table.rowStart, rows.length, ...mask.lines.filter((_, i) => mask.keep[i]));
  return { content: next.join(eol), placeholders: mask.placeholders, duplicates: mask.duplicates };
}

function cleanBullets(
  lines: string[],
  scan: readonly string[],
  headingIdx: number,
  limit: number,
  eol: string,
  identityOf: (bullet: string) => string,
  contentOf: (bullet: string) => string,
  fold: FoldRecord,
): CleanedRecords {
  const end = Math.min(sectionEnd(scan, headingIdx), limit);
  const bullets = readBullets(scan, headingIdx + 1, end);
  if (!bullets) return unchanged(lines, eol);

  // A note is folded into, and identified by, its whole self; the `_(source)_` a fold
  // rewrites is on its last line.
  const mask = keepMask(
    bullets.map((bullet) => ({
      line: lines[bullet.end - 1],
      identity: identityOf(bullet.text),
      value: contentOf(bullet.text),
    })),
    fold,
  );

  const next = [...lines];
  const drop = new Set<number>();
  for (const [n, bullet] of bullets.entries()) {
    next[bullet.end - 1] = mask.lines[n];
    if (mask.keep[n]) continue;
    for (let i = bullet.start; i < bullet.end; i++) drop.add(i);
  }
  return {
    content: next.filter((_, i) => !drop.has(i)).join(eol),
    placeholders: mask.placeholders,
    duplicates: mask.duplicates,
  };
}

/** Fold the given columns of a duplicate row into the row that survives it. */
function foldRowCells(column: number, style: MergeStyle): FoldRecord {
  // The duplicate is about to be deleted, so its cell is read the way the cleanup
  // reads a record (a value differing only in case is another value) and written the
  // way the duplicate wrote it.
  return (survivor, duplicate) => {
    const row = scanRow(duplicate);
    return mergeRowCells(survivor, row.values, column, style, DELETE_IDENTITY, row.raw);
  };
}

/** Fold a duplicate note's source into the note that survives it. */
function foldNoteSource(survivor: string, duplicate: string): string | null {
  return mergeNoteSource(survivor, orgNoteSource(duplicate), DELETE_IDENTITY);
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
function cleanVaultRecords(content: string, kind: VaultRecordKind, now: Date): CleanedRecords {
  const eol = detectEol(content);
  const lines = toLines(content);
  const scan = maskFenced(lines);
  const liveEnd = liveRegionEnd(scan);

  switch (kind) {
    case "memory":
      // First table in the live region: the tables below it are archived eras, kept as
      // written.
      return cleanTable(
        lines,
        scan,
        bodyStart(scan),
        liveEnd,
        eol,
        MEMORY_HEADER,
        // Identity is the date and the item together; only the item decides whether
        // the row says anything.
        (row) => ({
          line: row,
          identity: memoryIdentity(row, DELETE_IDENTITY),
          value: rowCell(row, MEMORY_ITEM_COLUMN),
        }),
        foldRowCells(MEMORY_NOTES_COLUMN, PROSE_NOTES),
      );

    case "impact-log": {
      const headingIdx = findExactHeading(scan, IMPACT_TIMELINE_HEADING, liveEnd);
      if (headingIdx === -1) return unchanged(lines, eol);
      // Assigned below so the status lines can be refreshed once the rows are settled.
      // Identity is the date and the achievement together, but only the achievement
      // decides whether the row says anything: a date in front of "(none)" would
      // otherwise make the placeholder row look like real content.
      const cleaned = cleanTable(
        lines,
        scan,
        headingIdx,
        sectionScope(scan, headingIdx, liveEnd),
        eol,
        IMPACT_HEADER,
        (row) => ({ line: row, identity: impactIdentity(row, DELETE_IDENTITY), value: rowCell(row, 1) }),
        foldRowCells(IMPACT_EVIDENCE_COLUMN, REFERENCE_LIST),
      );
      // Always, not only when rows moved: the gap is measured from today, so it goes
      // stale on its own.
      return { ...cleaned, content: refreshImpactStatus(cleaned.content, eol, now) };
    }

    case "work-context": {
      const headingIdx = findExactHeading(scan, ORG_NOTES_HEADING, liveEnd);
      if (headingIdx === -1) return unchanged(lines, eol);
      return cleanBullets(
        lines,
        scan,
        headingIdx,
        liveEnd,
        eol,
        (body) => orgNoteIdentity(body, DELETE_IDENTITY),
        orgNoteText,
        foldNoteSource,
      );
    }

    case "my-profile": {
      const headingIdx = findExactHeading(scan, KEY_STRENGTHS_HEADING, liveEnd);
      if (headingIdx === -1) return unchanged(lines, eol);
      // A strength is only its text, so that text is both its identity and its content.
      return cleanBullets(
        lines,
        scan,
        headingIdx,
        liveEnd,
        eol,
        (text) => identityOf([text], DELETE_IDENTITY),
        (text) => text,
        foldNothing,
      );
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
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const link = await lstat(path).catch(() => null);
  const target = link?.isSymbolicLink() ? await realpath(path) : path;
  const existing = await stat(target).catch(() => null);

  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, content, "utf-8");
  if (existing) await chmod(temp, existing.mode & 0o777);
  await rename(temp, target);
}

/**
 * True for a date cell that can begin an entry inside a joined row.
 *
 * Looser than `isIsoDate` on purpose, and only here: a hand-written row in a real
 * vault is dated `2025-04`, and refusing the whole repair over a missing day left 38
 * entries fused together. The month still has to be a real one, so `2026-13` is
 * refused. The status lines keep using `isIsoDate`, since a gap cannot be measured
 * from a month.
 */
function isEntryDate(value: string): boolean {
  if (isIsoDate(value)) return true;
  if (value.length !== 7 || value[4] !== "-") return false;
  for (const i of [0, 1, 2, 3, 5, 6]) {
    if (value[i] < "0" || value[i] > "9") return false;
  }
  const parsed = new Date(`${value}-01T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 7) === value;
}

interface UnjoinedRows {
  content: string;
  unjoined: number;
  unjoinSkipped: number[];
}

/**
 * Split the impact rows that several entries were written into.
 *
 * The 1.x writer found its insert point with a regex whose separator pattern ran on
 * past the separator line: `[-\s|]+` matches a newline and a pipe, so the match ended
 * on the leading pipe of the first data row and every insert landed inside that row.
 * A file written by it holds one row carrying every entry, newest first, with the cells
 * themselves intact, and a bare `|` line for each insert after the first.
 *
 * A row is only split when its cells divide exactly into whole entries and every cell
 * that would start one is a date. The cell text is put back exactly as written, so an
 * escape inside a cell survives the repair.
 */
function unjoinImpactRows(content: string, width: number): UnjoinedRows {
  const eol = detectEol(content);
  const lines = toLines(content);
  const scan = maskFenced(lines);
  const liveEnd = liveRegionEnd(scan);

  const headingIdx = findExactHeading(scan, IMPACT_TIMELINE_HEADING, liveEnd);
  if (headingIdx === -1) return { content, unjoined: 0, unjoinSkipped: [] };

  const scope = sectionScope(scan, headingIdx, liveEnd);
  const table = findTableByHeader(scan, headingIdx, scope, IMPACT_HEADER);
  if (!table) return { content, unjoined: 0, unjoinSkipped: [] };

  const rowEnd = Math.min(table.rowEnd, scope);

  // The damage signs itself, and in one shape only: every 1.x insert went in directly
  // under the separator, so the file shows a run of the leading pipes it left behind
  // and then, immediately after them, the row that swallowed their entries. Nothing
  // else in the table is a candidate, whatever its cells look like: a run counted
  // table-wide would let one real loss license the splitting of an unrelated row.
  let afterRun = table.rowStart;
  while (afterRun < rowEnd && lines[afterRun].trim() === "|") afterRun++;
  const lostInserts = afterRun - table.rowStart;
  const joinedIdx = lostInserts > 0 && afterRun < rowEnd ? afterRun : -1;

  const repaired: string[] = [];
  const unjoinSkipped: number[] = [];
  let unjoined = 0;

  for (let i = table.rowStart; i < rowEnd; i++) {
    const row = scanRow(lines[i]);
    const cells = row.values.length;
    if (cells <= width) {
      repaired.push(lines[i]);
      continue;
    }

    const startsAnEntry = (k: number) => isEntryDate(row.values[k * width] ?? "");
    const entries = cells / width;
    const looksJoined =
      Number.isInteger(entries) && Array.from({ length: entries }, (_, k) => k).every(startsAnEntry);
    // The row the run points at, holding exactly the entries the run accounts for.
    if (i !== joinedIdx || !looksJoined || entries !== lostInserts + 1) {
      unjoinSkipped.push(cells);
      repaired.push(lines[i]);
      continue;
    }

    for (let k = 0; k < entries; k++) {
      repaired.push(`|${row.raw.slice(k * width, (k + 1) * width).join("|")}|`);
    }
    // The row that held them all counts as one of them, so the rest are the recovery.
    unjoined += entries - 1;
  }

  if (unjoined === 0) return { content, unjoined: 0, unjoinSkipped };

  const next = [...lines];
  next.splice(table.rowStart, rowEnd - table.rowStart, ...repaired);
  return { content: next.join(eol), unjoined, unjoinSkipped };
}

/**
 * One-off cleanup of the damage the ungated writers did: placeholder rows and repeated
 * records. Keeps a backup, and returns null when there is nothing to change so a second
 * run neither rewrites the file nor writes another backup.
 */
export async function migrateVaultRecordsFile(
  path: string,
  kind: VaultRecordKind,
  now: Date = new Date(),
): Promise<VaultRecordsMigration | null> {
  if (!existsSync(path)) return null;

  const content = await readFile(path, "utf-8");

  // Entries first, so the cleanup and the status lines see the rows that were always
  // meant to be there rather than the one row they were written into.
  const repaired = kind === "impact-log"
    ? unjoinImpactRows(content, IMPACT_HEADER.length)
    : { content, unjoined: 0, unjoinSkipped: [] };
  const cleaned = cleanVaultRecords(repaired.content, kind, now);

  const changedRecords = cleaned.placeholders > 0 || cleaned.duplicates > 0 || repaired.unjoined > 0;
  if (!changedRecords && cleaned.content === content) {
    // Nothing to write, but a row this could not read is still worth saying out loud,
    // every run, until somebody fixes it.
    if (repaired.unjoinSkipped.length === 0) return null;
    return { placeholders: 0, duplicates: 0, unjoined: 0, unjoinSkipped: repaired.unjoinSkipped, backup: "" };
  }

  const backup = changedRecords ? nextBackupPath(path) : "";
  if (changedRecords) await writeFile(backup, content, "utf-8");
  await writeFileAtomic(path, cleaned.content);
  return {
    placeholders: cleaned.placeholders,
    duplicates: cleaned.duplicates,
    unjoined: repaired.unjoined,
    unjoinSkipped: repaired.unjoinSkipped,
    backup,
  };
}
