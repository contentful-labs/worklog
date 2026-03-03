import * as p from "@clack/prompts";
import { aiQuery } from "../lib/ai";
import { fillTemplate, buildConfigContext } from "../lib/template";
import {
  getVault,
  readMemory,
  readProfile,
  readWorkContext,
  readImpactLog,
  readFocusTracking,
  readFocusDoc,
  readCareerContext,
  getRecentBragBooks,
  getExpectedBragBookWeeks,
  getMissingBragBookWeeks,
  formatTeamTimelineForPrompt,
} from "../lib/obsidian-readers";

const PREP_TYPES = ["1on1", "skip-level", "self-review", "promotion", "resume"] as const;
type PrepType = (typeof PREP_TYPES)[number];

const DEFAULT_WEEKS: Record<PrepType, number> = {
  "1on1": 4,
  "skip-level": 4,
  "self-review": 12,
  "promotion": 26,
  "resume": 26,
};

const OUTPUT_PREFIX: Record<PrepType, string> = {
  "1on1": "1on1 Prep",
  "skip-level": "Skip Level Prep",
  "self-review": "Self Review",
  "promotion": "Promotion Case",
  "resume": "Resume Bullets",
};

const PROMPT_FILE: Record<PrepType, string> = {
  "1on1": "prep-1on1.md",
  "skip-level": "prep-skip-level.md",
  "self-review": "prep-self-review.md",
  "promotion": "prep-promotion.md",
  "resume": "prep-resume.md",
};

function parseArgs(): { type: PrepType; weeks: number; sinceDate?: string; untilDate?: string; extended: boolean; richText: boolean } {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    p.intro("prep");
    p.note(
      `Usage: prep <type> [--weeks N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--extended]\n\nTypes:\n  1on1          1:1 meeting prep (default: 4 weeks)\n  skip-level    Skip-level meeting prep (default: 4 weeks)\n  self-review   Self-review for perf cycle (default: 12 weeks)\n  promotion     Promotion case assembly (default: 26 weeks)\n  resume        Resume bullet points (default: 26 weeks)\n\nOptions:\n  --weeks N          Number of weeks of brag books to include\n  --since YYYY-MM-DD Include brag books from this date (mutually exclusive with --weeks)\n  --until YYYY-MM-DD Include brag books up to this date (default: today)\n  --extended         Extended output (self-review: full 6-section format instead of concise)
  --rt               Generate rich text (.docx) copy for Google Docs`,
      "Help"
    );
    process.exit(0);
  }

  const type = args[0] as PrepType;
  if (!PREP_TYPES.includes(type)) {
    p.log.error(`Unknown type: ${type}. Must be one of: ${PREP_TYPES.join(", ")}`);
    process.exit(1);
  }

  const weeksIdx = args.indexOf("--weeks");
  const sinceIdx = args.indexOf("--since");
  const untilIdx = args.indexOf("--until");

  if (weeksIdx !== -1 && sinceIdx !== -1) {
    p.log.error("--weeks and --since are mutually exclusive");
    process.exit(1);
  }

  let sinceDate: string | undefined;
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    const val = args[sinceIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(new Date(val).getTime())) {
      p.log.error("--since must be a valid YYYY-MM-DD date (e.g. 2025-10-01)");
      process.exit(1);
    }
    sinceDate = val;
  }

  let untilDate: string | undefined;
  if (untilIdx !== -1 && args[untilIdx + 1]) {
    const val = args[untilIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(new Date(val).getTime())) {
      p.log.error("--until must be a valid YYYY-MM-DD date (e.g. 2026-02-17)");
      process.exit(1);
    }
    untilDate = val;
  }

  const endMs = untilDate ? new Date(untilDate).getTime() : Date.now();

  let weeks = DEFAULT_WEEKS[type];
  if (sinceDate) {
    const sinceMs = new Date(sinceDate).getTime();
    weeks = Math.ceil((endMs - sinceMs) / (7 * 24 * 60 * 60 * 1000));
  } else if (weeksIdx !== -1 && args[weeksIdx + 1]) {
    weeks = parseInt(args[weeksIdx + 1], 10);
    if (isNaN(weeks) || weeks < 1) {
      p.log.error("--weeks must be a positive number");
      process.exit(1);
    }
  }

  const extended = args.includes("--extended");
  const richText = args.includes("--rt");

  return { type, weeks, sinceDate, untilDate, extended, richText };
}

function getDateRange(weeks: number, sinceDate?: string, untilDate?: string): string {
  const end = untilDate ? new Date(untilDate) : new Date();
  const start = sinceDate ? new Date(sinceDate) : new Date(end);
  if (!sinceDate) start.setDate(start.getDate() - weeks * 7);
  return `${start.toISOString().split("T")[0]} to ${end.toISOString().split("T")[0]}`;
}

async function generateBragBookForWeek(weekIdStr: string): Promise<void> {
  const scriptPath = new URL("../fetch-weekly-work-log.ts", import.meta.url).pathname;
  p.log.info(`Generating brag book for ${weekIdStr}...`);
  const proc = Bun.spawn([process.execPath, scriptPath, "--week", weekIdStr, "--no-prompt"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    p.log.warn(`Brag book generation for ${weekIdStr} exited with code ${exitCode}`);
  }
}

export async function runPrep(): Promise<void> {
  const { type, weeks, sinceDate, untilDate, extended, richText } = parseArgs();

  p.intro(`prep — ${OUTPUT_PREFIX[type]}${extended ? " (extended)" : ""}`);
  p.log.info(`Reading ${weeks} weeks of brag books + context`);

  // Check for missing brag books in the requested range
  const expectedWeeks = getExpectedBragBookWeeks(weeks, sinceDate, untilDate);
  const missingWeeks = await getMissingBragBookWeeks(expectedWeeks);

  const skippedWeeks: string[] = [];

  if (missingWeeks.length > 0) {
    p.log.warn(`Missing ${missingWeeks.length} brag book(s) in the requested range`);

    for (const weekIdStr of missingWeeks) {
      const action = await p.select({
        message: `Week ${weekIdStr} has no brag book`,
        options: [
          { value: "generate", label: "Generate it now" },
          { value: "skip", label: "Skip this week" },
          { value: "cancel", label: "Cancel prep" },
        ],
      });

      if (p.isCancel(action) || action === "cancel") {
        p.cancel("Prep cancelled.");
        process.exit(0);
      }

      if (action === "generate") {
        await generateBragBookForWeek(weekIdStr);
      } else {
        skippedWeeks.push(weekIdStr);
      }
    }

    if (skippedWeeks.length > 0) {
      p.log.info(`Skipped: ${skippedWeeks.join(", ")}`);
    }
  }

  const s = p.spinner();

  // Read all context in parallel
  s.start("Loading context...");
  const [
    bragBooks,
    profile,
    workContext,
    careerContext,
    focusDoc,
    impactLog,
    focusTracking,
    memory,
  ] = await Promise.all([
    getRecentBragBooks(weeks, untilDate, sinceDate),
    readProfile(),
    readWorkContext(),
    readCareerContext(),
    readFocusDoc(),
    readImpactLog(),
    readFocusTracking(),
    readMemory(),
  ]);
  s.stop("Context loaded");

  if (bragBooks === "No brag book entries found.") {
    p.log.error("No brag books found in vault. Run worklog first.");
    process.exit(1);
  }

  // Read prompt template
  const promptFile = (type === "self-review" && extended) ? "prep-self-review-extended.md" : PROMPT_FILE[type];
  const promptPath = new URL(`../prompts/${promptFile}`, import.meta.url).pathname;
  const rawTemplate = await Bun.file(promptPath).text();

  const dateRange = getDateRange(weeks, sinceDate, untilDate);
  const teamTimeline = formatTeamTimelineForPrompt();
  const writingStylePath = new URL("../prompts/_writing-style.md", import.meta.url).pathname;
  const writingStyle = await Bun.file(writingStylePath).text();

  // Fill template — config-driven placeholders + runtime context
  const prompt = fillTemplate(rawTemplate, {
    ...buildConfigContext(),
    date_range: dateRange,
    profile,
    work_context: workContext,
    career_context: careerContext,
    focus_doc: focusDoc,
    brag_books: bragBooks,
    impact_log: impactLog,
    focus_tracking: focusTracking,
    memory,
    team_timeline: teamTimeline,
    writing_style: writingStyle,
  });

  // Generate via AI
  s.start("Generating...");
  let result = await aiQuery({ prompt });
  s.stop("Generated");

  // Ensure frontmatter tag
  if (!result.startsWith("---")) {
    result = `---\ntags:\n  - areas/work\n---\n\n${result}`;
  }

  // Write to vault
  const today = new Date().toISOString().split("T")[0];
  const filename = `${OUTPUT_PREFIX[type]} ${today}.md`;
  const outputPath = `${getVault()}/${filename}`;

  await Bun.write(outputPath, result);
  p.log.success(`Written to: ${outputPath}`);

  if (richText) {
    const { markdownToDocx } = await import("../lib/markdown-to-docx");
    const docxBuffer = await markdownToDocx(result);
    const docxFilename = `${OUTPUT_PREFIX[type]} ${today}.docx`;
    const docxPath = `${getVault()}/${docxFilename}`;
    await Bun.write(docxPath, docxBuffer);
    p.log.success(`Rich text: ${docxPath}`);
  }

  p.outro("Done!");

  if (!extended) {
    console.log("---\n");
    console.log(result);
  }
}
