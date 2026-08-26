/**
 * The machine-readable half of a weekly brag book generation.
 *
 * The model returns this object under a schema constraint rather than as markdown
 * sections that used to be scraped back out with regexes. Field descriptions are the
 * contract the model reads, so they carry the instructions the prompt used to hold.
 */

import { z } from "zod";

/** Statuses the coach may return for an open focus item. `pending` is not one: it means unanswered. */
export const FOCUS_STATUSES = ["completed", "ongoing", "dropped"] as const;

/** New focus items per week. The coach commits to at most this many. */
export const MAX_NEW_FOCUS_ITEMS = 2;

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
  scope: z.string().describe("One of: Team, Department, Organization."),
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
