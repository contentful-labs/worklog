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
    // updateMemory splits this string on "(now part of" to recover the text it matches
    // against memory.md, so the separator has to stay exactly as written.
    itemsToRemove: keepValid(output.memoryGraduations, validMemoryGraduationSchema)
      .map((row) => `${row.item} (now part of: ${row.nowPartOf})`),
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
