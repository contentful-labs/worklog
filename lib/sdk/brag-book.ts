import { MAX_NEW_FOCUS_ITEMS, type BragBookOutput } from "./brag-book-schema";
import { renderRow } from "./markdown-table";

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
 * Turn the model's schema-constrained output into the shape the vault writers consume.
 *
 * The writers still speak in rendered markdown rows, so memory items are rendered here
 * with the same helper the writers use.
 */
export function toBragBookResult(output: BragBookOutput): BragBookResult {
  const impact = output.impactLogEntry;
  const profile = output.profileUpdate;

  return {
    bragBookContent: output.bragBookMarkdown.trim(),
    itemsToAdd: output.memoryItemsToAdd
      .filter((row) => row.item.trim() !== "")
      .map((row) => renderRow([row.date, row.item, row.category, row.notes])),
    // updateMemory splits this string on "(now part of" to recover the text it matches
    // against memory.md, so the separator has to stay exactly as written.
    itemsToRemove: output.memoryGraduations
      .filter((row) => row.item.trim() !== "")
      .map((row) => `${row.item.trim()} (now part of: ${row.nowPartOf.trim()})`),
    impactLogEntry: impact !== null && impact.achievement.trim() !== "" ? impact : null,
    workContextUpdates: output.workContextUpdates.filter((row) => row.info.trim() !== ""),
    profileUpdate: profile !== null && profile.achievement.trim() !== "" ? profile : null,
    focusItems: output.newFocusItems
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .slice(0, MAX_NEW_FOCUS_ITEMS),
    // An id the model invented is inert: applyFocusUpdates looks ids up in a map and
    // ignores misses, which leaves the real item to age toward lapsing.
    focusUpdates: output.focusStatuses
      .filter((row) => row.id.trim() !== "")
      .map((row) => ({ id: row.id.trim(), status: row.status, notes: row.notes.trim() })),
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
