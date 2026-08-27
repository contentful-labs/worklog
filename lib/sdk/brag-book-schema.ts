/**
 * The machine-readable half of a weekly brag book generation.
 *
 * The model returns this object under a schema constraint rather than as markdown
 * sections that used to be scraped back out with regexes. Field descriptions are the
 * contract the model reads, so they carry the instructions the prompt used to hold.
 *
 * Two layers of validation, split on what a violation costs:
 *
 * - The **wire schema** below is what the provider constrains generation to, and what
 *   `aiQueryStructured` parses the response with. A violation here throws away the whole
 *   week, after the expensive call has already been paid for, so it only carries rules
 *   that no salvage could survive: the field must exist, be the right type, and the
 *   document must not be blank. Enums are here too because a status or scope outside the
 *   set has no safe fallback, and both providers honour `enum`.
 * - The **element rules** further down are applied by `toBragBookResult` after parsing.
 *   They drop the one bad row and keep the rest of the week. They check what the writers
 *   cannot recover from, which is why pipes are not among them: every writer either
 *   renders through `renderRow`, which escapes them, or writes a bullet where they are
 *   ordinary text. Rejecting them here would only lose real work. Anything per-element lives
 *   here for that reason, not because the provider could not enforce it. Both providers
 *   do accept `minLength`, `pattern` and `maxItems` (measured against OpenAI strict mode
 *   and the Claude Code ajv path), which is exactly why they must not go in the wire
 *   schema: the model violating one cell would cost the entire generation.
 */

import { z } from "zod";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import type { PhrasingContent } from "mdast";

/** Statuses the coach may return for an open focus item. `pending` is not one: it means unanswered. */
export const FOCUS_STATUSES = ["completed", "ongoing", "dropped"] as const;

/** Reach of an impact log entry. */
export const IMPACT_SCOPES = ["Team", "Department", "Organization"] as const;

/** New focus items per week. The coach commits to at most this many. */
export const MAX_NEW_FOCUS_ITEMS = 2;

/** Shortest graduation text that can safely be matched against memory.md. See below. */
const MIN_GRADUATION_LENGTH = 3;

export const memoryItemSchema = z.object({
  date: z.string().describe("Date the work happened, as YYYY-MM-DD."),
  item: z
    .string()
    .describe("One line describing the small contribution. No markdown tables, no pipe characters."),
  category: z
    .string()
    .describe("Short lowercase category such as bugfix, review, docs, perf, support."),
  notes: z
    .string()
    .describe(
      "Why this might matter later, for example which larger theme it could graduate into. Empty string if there is nothing to say.",
    ),
});

export const memoryGraduationSchema = z.object({
  item: z
    .string()
    .describe(
      "The memory item that has now been absorbed into an achievement. Copy the wording from the current memory document as closely as you can, since it is matched against that document.",
    ),
  nowPartOf: z
    .string()
    .describe("The achievement in this week's brag book that absorbed the item."),
});

export const impactLogEntrySchema = z.object({
  date: z.string().describe("Date of the impact, as YYYY-MM-DD."),
  achievement: z.string().describe("What was achieved, in one line."),
  scope: z.enum(IMPACT_SCOPES).describe("How far the impact reached."),
  coreValue: z.string().describe("The company core value this demonstrates."),
  evidence: z.string().describe("Ticket keys, PR links or documents that back the claim."),
});

export const workContextUpdateSchema = z.object({
  category: z.string().describe("Short category for the fact, such as team, process, tooling."),
  info: z.string().describe("The fact learned about the company or org this week."),
  source: z.string().describe("Where it came from: a ticket key, a page title, a meeting."),
});

export const profileUpdateSchema = z.object({
  achievement: z.string().describe("A CV-worthy achievement to add to the engineer profile."),
  bulletPoint: z.string().describe("The profile bullet point to write, in the engineer's voice."),
});

export const focusStatusSchema = z.object({
  id: z
    .string()
    .describe("The open focus item id, copied exactly, for example 2026-W35.1. Never the item text."),
  status: z.enum(FOCUS_STATUSES).describe("Outcome of the item after reviewing this week's work."),
  notes: z
    .string()
    .describe("One short line of evidence for the status. Empty string if there is nothing to add."),
});

/**
 * The full result of one weekly generation: the brag book document plus every vault update.
 *
 * Arrays are always present and empty when there is nothing to report. Do not invent
 * placeholder rows such as "(none)" or "N/A" to fill a table, and do not repeat the
 * markdown document inside the update fields.
 */
export const bragBookOutputSchema = z.object({
  bragBookMarkdown: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The complete brag book document as markdown, starting with the YAML frontmatter block, following the output_format section of the prompt. It contains the achievements, stats, week in review and the COACHING_SESSION block, and nothing machine-readable.",
    ),
  memoryItemsToAdd: z
    .array(memoryItemSchema)
    .describe("Small contributions from this week that are below the brag book bar. Empty if none."),
  memoryGraduations: z
    .array(memoryGraduationSchema)
    .describe(
      "Memory items that this week's achievements absorbed, so they can be removed from memory. Empty if none.",
    ),
  impactLogEntry: impactLogEntrySchema
    .nullable()
    .describe("This week's one significant impact, or null if nothing met the bar."),
  workContextUpdates: z
    .array(workContextUpdateSchema)
    .describe("Facts about the company or org learned this week. Empty if nothing new."),
  profileUpdate: profileUpdateSchema
    .nullable()
    .describe("A profile addition, or null. The bar is CV-worthy, so null is the common answer."),
  focusStatuses: z
    .array(focusStatusSchema)
    .describe(
      "One entry for EVERY id listed in open_focus_items. An id you leave out stays open and closes itself as lapsed after two reviews, so silence is recorded as a miss.",
    ),
  newFocusItems: z
    .array(z.string())
    .describe(
      `New commitments for next week, at most ${MAX_NEW_FOCUS_ITEMS}. They must be the same suggestions given in "Focus for Next Week" in the markdown. Do not restate an item that is already open in open_focus_items; give that one a status instead.`,
    ),
});

export type BragBookOutput = z.infer<typeof bragBookOutputSchema>;
export type MemoryItem = z.infer<typeof memoryItemSchema>;
export type MemoryGraduation = z.infer<typeof memoryGraduationSchema>;
export type FocusStatus = z.infer<typeof focusStatusSchema>;

// --- Element rules, applied after the wire parse ---

/**
 * Focus item ids look like `2026-W35.1`. Written as a scan rather than a regex to match
 * `isTableSeparator` in markdown-table.ts, which the repo rewrote for the same reason.
 */
export function isFocusItemId(value: string): boolean {
  if (value.length < 9 || value[4] !== "-" || value[5] !== "W") return false;
  const isDigits = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (value[i] < "0" || value[i] > "9") return false;
    return true;
  };
  if (!isDigits(0, 4) || !isDigits(6, 8)) return false;
  if (value[8] !== ".") return false;
  return value.length > 9 && isDigits(9, value.length);
}

/** Text that has to stay on one line: every vault writer puts these in a table cell or a bullet. */
const singleLineText = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\n") && !value.includes("\r"), "must be a single line");

/** Same, but allowed to be empty. Notes and evidence often have nothing to say. */
const optionalSingleLineText = z
  .string()
  .trim()
  .refine((value) => !value.includes("\n") && !value.includes("\r"), "must be a single line");

export const validMemoryItemSchema = z.object({
  // The Date column drives dropDatedRowsBefore's 26-week window, so a malformed date
  // would quietly distort every future prompt. Drop the row instead.
  date: z.iso.date(),
  item: singleLineText,
  category: optionalSingleLineText,
  notes: optionalSingleLineText,
});

export const validMemoryGraduationSchema = z.object({
  // updateMemory needs an exact row match to remove anything, so a stray character can no
  // longer wipe the file. The minimum length stays as a floor on what counts as an item.
  item: singleLineText.min(MIN_GRADUATION_LENGTH),
  nowPartOf: singleLineText,
});

export const validImpactLogEntrySchema = z.object({
  date: z.iso.date(),
  achievement: singleLineText,
  scope: z.enum(IMPACT_SCOPES),
  coreValue: optionalSingleLineText,
  evidence: optionalSingleLineText,
});

export const validWorkContextUpdateSchema = z.object({
  category: singleLineText,
  info: singleLineText,
  source: optionalSingleLineText,
});

export const validProfileUpdateSchema = z.object({
  achievement: singleLineText,
  bulletPoint: singleLineText,
});

export const validFocusStatusSchema = z.object({
  id: z.string().trim().refine(isFocusItemId, "must be a focus item id such as 2026-W35.1"),
  status: z.enum(FOCUS_STATUSES),
  notes: optionalSingleLineText,
});

export const validNewFocusItemSchema = singleLineText;

/**
 * Heading text from a markdown document, normalized for comparison.
 *
 * Parsed with remark rather than scanned, because the scan this replaced rejected legal
 * CommonMark that models do write: closing hashes (`## Achievements ##`), up to three
 * spaces of indentation, and setext underlining. Recognizing valid markdown by hand is
 * the same mistake this whole phase exists to undo.
 */
function documentHeadings(markdown: string): string[] {
  // Frontmatter is stripped by the plugin; without it the closing `---` of the tags block
  // can be read as a setext underline and invent a heading.
  const tree = unified().use(remarkParse).use(remarkFrontmatter).parse(markdown);

  const headings: string[] = [];
  for (const node of tree.children) {
    if (node.type !== "heading") continue;
    headings.push(normalizeHeading(collectText(node.children)));
  }
  return headings;
}

/**
 * Plain text of a heading, so `## **Achievements**` reads the same as `## Achievements`.
 *
 * Four lines against mdast's own union rather than mdast-util-to-string, which reaches
 * this project only as a transitive dependency of remark.
 */
function collectText(nodes: PhrasingContent[]): string {
  let text = "";
  for (const node of nodes) {
    if ("value" in node) text += node.value;
    else if ("children" in node) text += collectText(node.children);
  }
  return text;
}

/** Models end a heading with a colon often enough that it should not fail a week. */
function normalizeHeading(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ":") end--;
  return text.slice(0, end).trim().toLowerCase();
}

/**
 * A brag book document good enough to overwrite whatever is already in the vault.
 *
 * This one hard-fails rather than dropping, because the file it replaces is the week's
 * only record and `worklog --force` regenerates over an existing entry. The check is
 * deliberately shallow: blank, and missing the achievements section the output_format
 * mandates. Requiring the literal `# Brag Book` H1 was tried and rejected, see the note
 * on validateBragBookMarkdown in brag-book.ts.
 */
export function bragBookMarkdownProblem(markdown: string): string | null {
  if (markdown.trim() === "") return "the model returned an empty brag book document";

  const headings = documentHeadings(markdown);
  if (headings.length === 0) return "the brag book document has no markdown headings";

  // Exact match on the heading text, not a substring: "Achievement statistics" is a stats
  // section, and accepting it would let a document with no achievements through.
  const hasAchievements = headings.some((text) => text === "achievements" || text === "achievement");
  if (!hasAchievements) return "the brag book document has no achievements section";

  return null;
}
