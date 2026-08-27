import {
  MAX_NEW_FOCUS_ITEMS,
  bragBookMarkdownProblem,
  validFocusStatusSchema,
  validImpactLogEntrySchema,
  validMemoryGraduationSchema,
  validMemoryItemSchema,
  validNewFocusItemSchema,
  validProfileUpdateSchema,
  validWorkContextUpdateSchema,
  type BragBookOutput,
} from "./brag-book-schema";
import { renderRow } from "./markdown-table";
import type { z } from "zod";

export interface BragBookResult {
  bragBookContent: string;
  itemsToAdd: string[];
  itemsToRemove: string[];
  impactLogEntry: { date: string; achievement: string; scope: string; coreValue: string; evidence: string } | null;
  workContextUpdates: Array<{ category: string; info: string; source: string }>;
  profileUpdate: { achievement: string; bulletPoint: string } | null;
  focusItems: string[];
  /** Status rows keyed by focus item id. Prose is never used to identify an item. */
  focusUpdates: Array<{ id: string; status: string; notes: string }>;
}

export interface ReviewInfo {
  nextReview: string;
  date: string;
  weeksRemaining: number;
  urgency: "normal" | "attention" | "urgent";
}

/**
 * Undo the escaping `escapeCell` applies, so a graduation target survives the round trip.
 *
 * The model reads memory.md as rendered markdown, where a stored item reads `Perf \| work`.
 * Copying that faithfully is the behaviour the prompt asks for, but `updateMemory` matches
 * against the cell `splitRow` parsed, which is `Perf | work`, so the escaped copy would
 * match nothing and the item would never graduate.
 *
 * Same escape rule as `splitRow`, without the splitting: a target that contains a bare
 * pipe because the model did not escape it has to come through unchanged rather than be
 * torn into two cells.
 */
function unescapeCell(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && (value[i + 1] === "|" || value[i + 1] === "\\")) {
      out += value[i + 1];
      i++;
    } else {
      out += value[i];
    }
  }
  return out;
}

/** Keep only the elements that satisfy `schema`, dropping the rest. */
function keepValid<T>(rows: unknown[], schema: z.ZodType<T>): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    const result = schema.safeParse(row);
    if (result.success) kept.push(result.data);
  }
  return kept;
}

/**
 * Reject a brag book document that must not be written over the vault's copy.
 *
 * Everything else in this file drops the offending element and lets the week through,
 * because losing one memory row beats losing a 225k-token generation. The document is the
 * exception: it is the week's only record, `worklog --force` regenerates over an existing
 * file, and a blank string would silently replace a real entry with nothing.
 *
 * The check stays shallow on purpose. Live runs on both providers produced `## Achievements`
 * every time but the mandated `# Brag Book` H1 only sometimes, and the codebase already
 * assumes models drop mandated boilerplate: that is what ensureBragBookFrontmatter exists
 * for. Requiring the exact H1 would turn a cosmetic slip into a failed week.
 */
export function validateBragBookMarkdown(markdown: string): void {
  const problem = bragBookMarkdownProblem(markdown);
  if (problem !== null) {
    throw new Error(
      `Refusing to write the brag book: ${problem}. Nothing was written to the vault. ` +
      `Re-run the week; if it repeats, the prompt's output_format section and the model are out of step.`,
    );
  }
}

/**
 * What a week's entry records, split into the two parts a regeneration must keep.
 *
 * Achievement lines and coaching headings are checked against the same parts of the new
 * document, not against the document as a whole. A line that has been taken out of the
 * achievements and mentioned in passing in the coaching prose is gone from the list
 * someone will read next year, and a check for the text anywhere would call that fine.
 */
interface EntryRecord {
  achievements: string[];
  coachingHeadings: string[];
}

const COACHING_OPEN = "<!-- COACHING_SESSION -->";
const COACHING_CLOSE = "<!-- /COACHING_SESSION -->";

function readEntry(document: string): EntryRecord {
  const achievements: string[] = [];
  const coachingHeadings: string[] = [];

  let inAchievements = false;
  let inCoaching = false;

  for (const raw of document.split("\n")) {
    const line = raw.trim();

    if (line === COACHING_OPEN) {
      inCoaching = true;
      continue;
    }
    if (line === COACHING_CLOSE) {
      inCoaching = false;
      continue;
    }

    if (inCoaching) {
      if (line.startsWith("### ")) coachingHeadings.push(line);
      continue;
    }

    if (line.startsWith("## ")) {
      inAchievements = line.toLowerCase() === "## achievements";
      continue;
    }
    if (inAchievements && line.length > 0) achievements.push(line);
  }

  return { achievements, coachingHeadings };
}

/**
 * The first thing the new document drops, or nothing if it drops nothing.
 *
 * Regenerating a week adds to its entry; it never removes. The prompt says so, but a
 * prompt is a request and this is the week's only record: a model that answers with a
 * structurally perfect document containing only the new material would otherwise
 * replace a month of achievements with one line, atomically and irreversibly.
 */
export function firstDroppedLine(existing: string, next: string): string | undefined {
  const before = readEntry(existing);
  const after = readEntry(next);

  const kept = new Set(after.achievements);
  const dropped = before.achievements.find((line) => !kept.has(line));
  if (dropped !== undefined) return dropped;

  const headings = new Set(after.coachingHeadings);
  return before.coachingHeadings.find((line) => !headings.has(line));
}

/**
 * Refuse to write a regenerated week that lost something.
 *
 * Named so the failure says what is missing. "The model returned a shorter document"
 * would leave the reader to work out which of forty lines went, from a file that no
 * longer contains it.
 */
export function validatePreserved(existing: string, next: string): void {
  const dropped = firstDroppedLine(existing, next);
  if (dropped === undefined) return;

  throw new Error(
    `Refusing to write the brag book: the regenerated week drops "${dropped}", which the existing entry records. ` +
    `Nothing was written to the vault. A refresh adds to a week, it never rewrites it; re-run the week, and if it ` +
    `repeats, the prompt's amend instructions and the model are out of step.`,
  );
}

/**
 * Turn the model's schema-constrained output into the shape the vault writers consume.
 *
 * The writers still speak in rendered markdown rows, so memory items are rendered here
 * with the same helper the writers use. Elements that fail their rules are dropped, so a
 * single malformed row costs one row rather than the week. The one hard failure is the
 * document itself, which throws before the caller writes anything.
 */
export function toBragBookResult(output: BragBookOutput): BragBookResult {
  validateBragBookMarkdown(output.bragBookMarkdown);

  const impact = validImpactLogEntrySchema.safeParse(output.impactLogEntry);
  const profile = validProfileUpdateSchema.safeParse(output.profileUpdate);

  return {
    bragBookContent: output.bragBookMarkdown.trim(),
    itemsToAdd: keepValid(output.memoryItemsToAdd, validMemoryItemSchema)
      .map((row) => renderRow([row.date, row.item, row.category, row.notes])),
    // Just the item: updateMemory matches on it and has no use for the achievement.
    // The whole string is the target now, so an item may contain any punctuation.
    itemsToRemove: keepValid(output.memoryGraduations, validMemoryGraduationSchema)
      .map((row) => unescapeCell(row.item)),
    impactLogEntry: impact.success ? impact.data : null,
    workContextUpdates: keepValid(output.workContextUpdates, validWorkContextUpdateSchema),
    profileUpdate: profile.success ? profile.data : null,
    focusItems: keepValid(output.newFocusItems, validNewFocusItemSchema).slice(0, MAX_NEW_FOCUS_ITEMS),
    // An id the model invented is inert: applyFocusUpdates looks ids up in a map and
    // ignores misses, which leaves the real item to age toward lapsing.
    focusUpdates: keepValid(output.focusStatuses, validFocusStatusSchema),
  };
}

const BRAG_BOOK_FRONTMATTER = "---\ntags:\n  - areas/work\n  - areas/work/brag-book\n---\n\n";

/** The prompt asks for frontmatter, but models drop it often enough that we add it ourselves. */
export function ensureBragBookFrontmatter(content: string): string {
  return content.startsWith("---") ? content : BRAG_BOOK_FRONTMATTER + content;
}

/** Parse review cycle info from work context markdown. */
export function parseReviewCycle(workContext: string, today: Date = new Date()): ReviewInfo | null {
  const reviewSectionMatch = workContext.match(/## Review Cycle\n([^#]|#(?!#))*/);

  if (!reviewSectionMatch) return null;

  const section = reviewSectionMatch[0];
  const rows = section.split("\n").filter(line => line.startsWith("|") && !line.includes("---") && !line.includes("Review Type"));

  let nearestReview: { type: string; date: Date } | null = null;

  for (const row of rows) {
    const parts = row.split("|").map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const reviewType = parts[0];
      const dateStr = parts[1];
      const reviewDate = new Date(dateStr);

      if (reviewDate > today) {
        if (!nearestReview || reviewDate < nearestReview.date) {
          nearestReview = { type: reviewType, date: reviewDate };
        }
      }
    }
  }

  if (!nearestReview) return null;

  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksRemaining = Math.ceil((nearestReview.date.getTime() - today.getTime()) / msPerWeek);

  let urgency: "normal" | "attention" | "urgent" = "normal";
  if (weeksRemaining < 4) urgency = "urgent";
  else if (weeksRemaining < 8) urgency = "attention";

  return {
    nextReview: nearestReview.type,
    date: nearestReview.date.toISOString().split("T")[0],
    weeksRemaining,
    urgency,
  };
}
