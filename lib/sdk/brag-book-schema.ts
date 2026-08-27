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
 *   They drop the one bad row and keep the rest of the week, so every per-element rule
 *   lives here rather than in the wire schema. Both providers do accept `minLength`,
 *   `pattern` and `maxItems` (measured against OpenAI strict mode and the Claude Code ajv
 *   path), which is exactly why those rules must stay out of the wire schema: the model
 *   violating one cell would cost the entire generation.
 *
 *   The rules check only what the writers cannot recover from. Pipes are not among them:
 *   every writer either renders through `renderRow`, which escapes them, or writes a
 *   bullet where they are ordinary text. Rejecting them here would only lose real work.
 */

import { z } from "zod";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import type { RootContent } from "mdast";

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
    .describe("One line describing the small contribution. Plain prose, not a markdown table row."),
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
      "The memory item that has now been absorbed into an achievement. Must equal the Item cell of that memory row exactly as it appears in the table: copy it rather than paraphrasing or shortening it, because a target that is not identical matches no row.",
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

interface DocumentSection {
  /** Normalized heading text. */
  heading: string;
  /** Whether anything but headings and structure follows it, before the next heading of its rank. */
  hasContent: boolean;
}

/**
 * The document's headings and whether each one has a body.
 *
 * Parsed with remark rather than scanned, because the scan this replaced rejected legal
 * CommonMark that models do write: closing hashes (`## Achievements ##`), up to three
 * spaces of indentation, and setext underlining. Recognizing valid markdown by hand is
 * the same mistake this whole phase exists to undo.
 */
function documentSections(markdown: string): DocumentSection[] {
  // Frontmatter is stripped by the plugin; without it the closing `---` of the tags block
  // can be read as a setext underline and invent a heading.
  const tree = unified().use(remarkParse).use(remarkFrontmatter).parse(markdown);

  const sections: DocumentSection[] = [];
  for (const [index, node] of tree.children.entries()) {
    if (node.type !== "heading") continue;
    sections.push({
      heading: normalizeHeading(nodeText(node)),
      hasContent: sectionHasContent(tree.children, index, node.depth),
    });
  }
  return sections;
}

/**
 * Does the heading at `index` have a body?
 *
 * A deeper heading opens a subsection, and its body still counts as this section's
 * content, so the scan runs on to the next heading of the same rank or shallower.
 */
function sectionHasContent(nodes: RootContent[], index: number, depth: number): boolean {
  for (let i = index + 1; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === "heading") {
      if (node.depth <= depth) return false;
      continue;
    }
    if (hasVisibleText(node)) return true;
  }
  return false;
}

/**
 * Does this node put any of the week's words on the page?
 *
 * Text, inline code and code blocks count when they are not blank. An `html` node counts
 * only when it carries words of its own: `<div>Shipped auth</div>` is the week's work
 * written in markup, while the COACHING_SESSION marker, a `<!-- nothing to report -->`
 * comment and a lone `<br>` are scaffolding. That distinction holds at every depth, so a
 * list item or blockquote wrapping nothing but a comment is still an empty section.
 */
function hasVisibleText(node: RootContent): boolean {
  if (node.type === "html") return htmlHasText(node.value);
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    return node.value.trim() !== "";
  }
  if ("children" in node) return node.children.some(hasVisibleText);
  return false;
}

/**
 * Is there anything but comments and tags in this raw HTML?
 *
 * Scanned rather than matched with a regex, in line with `isFocusItemId` and
 * `isTableSeparator`: this reads model output, and the repo keeps those off regexes.
 * An unterminated comment or tag swallows the rest of the value, which is the safe
 * direction here, since the leftover `<` is markup rather than a word.
 */
function htmlHasText(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    // Checked before the plain `<` below, because a comment opens with one.
    if (value.startsWith("<!--", i)) {
      const end = value.indexOf("-->", i + 4);
      if (end === -1) return false;
      i = end + 3;
    } else if (value[i] === "<") {
      const end = value.indexOf(">", i + 1);
      if (end === -1) return false;
      i = end + 1;
    } else {
      if (value[i].trim() !== "") return true;
      i++;
    }
  }
  return false;
}

/**
 * Plain text of a node, so `## **Achievements**` reads the same as `## Achievements`.
 *
 * A few lines against mdast's own union rather than mdast-util-to-string, which reaches
 * this project only as a transitive dependency of remark.
 */
function nodeText(node: RootContent): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(nodeText).join("");
  return "";
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
 * deliberately shallow: blank, no headings, or an achievements section that the
 * output_format mandates and the model left empty. Requiring the literal `# Brag Book` H1
 * was tried and rejected, see the note on validateBragBookMarkdown in brag-book.ts.
 */
export function bragBookMarkdownProblem(markdown: string): string | null {
  if (markdown.trim() === "") return "the model returned an empty brag book document";

  const sections = documentSections(markdown);
  if (sections.length === 0) return "the brag book document has no markdown headings";

  // Exact match on the heading text, not a substring: "Achievement statistics" is a stats
  // section, and accepting it would let a document with no achievements through.
  const achievements = sections.find((s) => s.heading === "achievements" || s.heading === "achievement");
  if (!achievements) return "the brag book document has no achievements section";

  // A heading on its own is not a week. A week with nothing to report still writes the
  // "No significant achievements this week" line the output_format asks for, so this
  // rejects an empty document rather than a quiet week.
  if (!achievements.hasContent) return "the brag book document's achievements section is empty";

  return null;
}
