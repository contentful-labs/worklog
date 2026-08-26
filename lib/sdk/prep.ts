import type { WorklogConfig } from "./types";
import { fillTemplate, buildConfigContext } from "./template";

export const PREP_TYPES = ["1on1", "skip-level", "self-review", "promotion", "resume"] as const;
export type PrepType = (typeof PREP_TYPES)[number];

export const DEFAULT_WEEKS: Record<PrepType, number> = {
  "1on1": 4,
  "skip-level": 4,
  "self-review": 12,
  "promotion": 26,
  "resume": 26,
};

export const OUTPUT_PREFIX: Record<PrepType, string> = {
  "1on1": "1on1 Prep",
  "skip-level": "Skip Level Prep",
  "self-review": "Self Review",
  "promotion": "Promotion Case",
  "resume": "Resume Bullets",
};

export const PROMPT_FILE: Record<PrepType, string> = {
  "1on1": "prep-1on1.md",
  "skip-level": "prep-skip-level.md",
  "self-review": "prep-self-review.md",
  "promotion": "prep-promotion.md",
  "resume": "prep-resume.md",
};

export function getDateRange(weeks: number, sinceDate?: string, untilDate?: string): string {
  const end = untilDate ? new Date(untilDate) : new Date();
  const start = sinceDate ? new Date(sinceDate) : new Date(end);
  if (!sinceDate) start.setDate(start.getDate() - weeks * 7);
  return `${start.toISOString().split("T")[0]} to ${end.toISOString().split("T")[0]}`;
}

export interface PrepContext {
  bragBooks: string;
  profile: string;
  workContext: string;
  careerContext: string;
  focusDoc: string;
  impactLog: string;
  focusTracking: string;
  memory: string;
  teamTimeline: string;
  writingStyle: string;
}

export interface PrepOptions {
  type: PrepType;
  weeks: number;
  sinceDate?: string;
  untilDate?: string;
  extended: boolean;
}

/** Build the full AI prompt for prep doc generation. */
export function buildPrepPrompt(
  config: WorklogConfig,
  options: PrepOptions,
  context: PrepContext,
  promptTemplate: string,
): string {
  const configContext = buildConfigContext(config);

  const dateRange = getDateRange(options.weeks, options.sinceDate, options.untilDate);

  return fillTemplate(promptTemplate, {
    ...configContext,
    date_range: dateRange,
    profile: context.profile,
    work_context: context.workContext,
    career_context: context.careerContext,
    focus_doc: context.focusDoc,
    brag_books: context.bragBooks,
    impact_log: context.impactLog,
    focus_tracking: context.focusTracking,
    memory: context.memory,
    team_timeline: context.teamTimeline,
    writing_style: context.writingStyle,
  });
}

/** Resolve prompt template filename for a prep type. */
export function getPromptFile(type: PrepType, extended: boolean): string {
  if (type === "self-review" && extended) return "prep-self-review-extended.md";
  return PROMPT_FILE[type];
}

/** Ensure result has frontmatter tags. */
export function ensureFrontmatter(result: string): string {
  if (result.startsWith("---")) return result;
  return `---\ntags:\n  - areas/work\n---\n\n${result}`;
}

/** Build output filename for a prep doc. */
export function buildOutputFilename(type: PrepType, date?: Date): string {
  const today = (date ?? new Date()).toISOString().split("T")[0];
  return `${OUTPUT_PREFIX[type]} ${today}.md`;
}
