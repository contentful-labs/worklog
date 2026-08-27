import { Command } from "commander";
import * as p from "@clack/prompts";
import { requireConfig, TEAM_TIMELINE_PATH } from "../lib/config";
import {
  buildVaultPaths,
  readMemory,
  readProfile,
  readWorkContext,
  readImpactLog,
  readFocusTracking,
  readFocusDoc,
  readCareerContext,
  getRecentBragBooks,
  getMissingBragBookWeeks,
  readTeamTimeline,
  resolveTeamTimeline,
  formatTeamTimelineForPrompt,
} from "../lib/sdk/vault";
import { getExpectedBragBookWeeks } from "../lib/sdk/week-utils";
import { aiQuery } from "../lib/sdk/ai";

import {
  PREP_TYPES,
  DEFAULT_WEEKS,
  OUTPUT_PREFIX,
  buildPrepPrompt,
  getPromptFile,
  ensureFrontmatter,
  buildOutputFilename,
  type PrepType,
} from "../lib/sdk/prep";

async function generateBragBookForWeek(weekIdStr: string): Promise<void> {
  const scriptPath = new URL("../fetch-weekly-work-log.ts", import.meta.url).pathname;
  p.log.info(`Generating brag book for ${weekIdStr}...`);
  const proc = Bun.spawn([process.execPath, scriptPath, "worklog", "--week", weekIdStr, "--no-prompt"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    p.log.warn(`Brag book generation for ${weekIdStr} exited with code ${exitCode}`);
  }
}

export async function runPrep(opts: {
  type: PrepType;
  weeks: number;
  sinceDate?: string;
  untilDate?: string;
  extended: boolean;
  richText: boolean;
}): Promise<void> {
  const { type, weeks, sinceDate, untilDate, extended, richText } = opts;
  const config = requireConfig();
  const paths = buildVaultPaths(config, TEAM_TIMELINE_PATH);

  p.intro(`prep — ${OUTPUT_PREFIX[type]}${extended ? " (extended)" : ""}`);
  p.log.info(`Reading ${weeks} weeks of brag books + context`);

  const expectedWeeks = getExpectedBragBookWeeks(weeks, sinceDate, untilDate);
  const missingWeeks = await getMissingBragBookWeeks(paths, expectedWeeks);

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

  s.start("Loading context...");
  const [bragBooks, profile, workContext, careerContext, focusDoc, impactLog, focusTracking, memory] =
    await Promise.all([
      getRecentBragBooks(paths, weeks, sinceDate, untilDate),
      readProfile(paths),
      readWorkContext(paths),
      readCareerContext(paths),
      readFocusDoc(paths),
      readImpactLog(paths),
      readFocusTracking(paths),
      readMemory(paths),
    ]);
  s.stop("Context loaded");

  if (bragBooks === "No brag book entries found.") {
    p.log.error("No brag books found in vault. Run worklog first.");
    process.exit(1);
  }

  const promptPath = new URL(`../prompts/${getPromptFile(type, extended)}`, import.meta.url).pathname;
  const writingStylePath = new URL("../prompts/_writing-style.md", import.meta.url).pathname;
  const [rawTemplate, writingStyle] = await Promise.all([
    Bun.file(promptPath).text(),
    Bun.file(writingStylePath).text(),
  ]);

  const prompt = buildPrepPrompt(
    config,
    { type, weeks, sinceDate, untilDate, extended },
    {
      bragBooks, profile, workContext, careerContext, focusDoc, impactLog, focusTracking, memory,
      teamTimeline: formatTeamTimelineForPrompt(resolveTeamTimeline(readTeamTimeline(paths, { onWarning: (message) => p.log.warn(message) }), config)),
      writingStyle,
    },
    rawTemplate,
  );

  s.start("Generating...");
  const result = ensureFrontmatter(await aiQuery({ prompt, config }));
  s.stop("Generated");

  const filename = buildOutputFilename(type);
  const outputPath = `${paths.vault}/${filename}`;

  await Bun.write(outputPath, result);
  p.log.success(`Written to: ${outputPath}`);

  if (richText) {
    const { markdownToDocx } = await import("../lib/markdown-to-docx");
    const docxBuffer = await markdownToDocx(result);
    const docxPath = `${paths.vault}/${filename.replace(/\.md$/, ".docx")}`;
    await Bun.write(docxPath, docxBuffer);
    p.log.success(`Rich text: ${docxPath}`);
  }

  p.outro("Done!");

  if (!extended) {
    console.log("---\n");
    console.log(result);
  }
}

export function makePrepCommand(): Command {
  const cmd = new Command("prep")
    .description("Generate a prep document from brag book history")
    .argument("<type>", `Prep type: ${PREP_TYPES.join(", ")}`)
    .option("--weeks <n>", "Number of weeks of brag books to include", (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) throw new Error("--weeks must be a positive number");
      return n;
    })
    .option("--since <YYYY-MM-DD>", "Include brag books from this date", (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime()))
        throw new Error("--since must be a valid YYYY-MM-DD date (e.g. 2025-10-01)");
      return v;
    })
    .option("--until <YYYY-MM-DD>", "Include brag books up to this date (default: today)", (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime()))
        throw new Error("--until must be a valid YYYY-MM-DD date (e.g. 2026-02-17)");
      return v;
    })
    .option("--extended", "Extended output format (self-review: full 6-section format)", false)
    .option("--rt", "Generate rich text (.docx) copy for Google Docs", false)
    .addHelpText(
      "after",
      `
Types:
  1on1          1:1 meeting prep (default: 4 weeks)
  skip-level    Skip-level meeting prep (default: 4 weeks)
  self-review   Self-review for perf cycle (default: 12 weeks)
  promotion     Promotion case assembly (default: 26 weeks)
  resume        Resume bullet points (default: 26 weeks)

Examples:
  worklog prep self-review
  worklog prep 1on1 --weeks 2
  worklog prep promotion --since 2025-01-01
  worklog prep self-review --extended`
    );

  cmd.action(async (type: string, opts) => {
    if (!PREP_TYPES.includes(type as PrepType)) {
      cmd.error(`Unknown type: ${type}. Must be one of: ${PREP_TYPES.join(", ")}`);
    }

    const { weeks: weeksOpt, since: sinceDate, until: untilDate, extended, rt: richText } = opts;

    if (weeksOpt !== undefined && sinceDate !== undefined) {
      cmd.error("--weeks and --since are mutually exclusive");
    }

    const endMs = untilDate ? new Date(untilDate).getTime() : Date.now();
    let weeks: number;
    if (sinceDate) {
      weeks = Math.ceil((endMs - new Date(sinceDate).getTime()) / (7 * 24 * 60 * 60 * 1000));
    } else {
      weeks = weeksOpt ?? DEFAULT_WEEKS[type as PrepType];
    }

    await runPrep({ type: type as PrepType, weeks, sinceDate, untilDate, extended, richText });
  });

  return cmd;
}
