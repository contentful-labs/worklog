/**
 * `worklog refresh` — go back over weeks already written and pick up what has happened
 * since.
 *
 * The whole command is the history rule made operational. It asks every source what has
 * changed since the last time it was read, files each change in the week it happened,
 * and then writes again only the weeks whose event set is not what it was. A week whose
 * events are unchanged is not regenerated, not re-prompted and not rewritten, which is
 * why running this twice in a row costs one round of cheap delta queries and nothing
 * else.
 *
 * When a week does need writing again, its existing brag book goes back to the model
 * along with only the material that is new, and the instruction is to add to the entry
 * rather than replace it. The vault writers are idempotent, so re-applying what was
 * already applied lands nothing.
 */

import { Command } from "commander";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";

import {
  buildHeaders, getAccountId, getGitHubUsername, type WeekInfo,
} from "../lib/sdk/data-fetch";
import {
  collectIntoLedger, newEvents, openLedger, weekWindow,
  type CollectionOutcome, type CollectionWeek, type Ledger,
} from "../lib/sdk/ledger";
import { generateEventMarkdown } from "../lib/sdk/markdown";
import { allSources } from "../lib/sdk/source-adapters";
import { sourceContext, type Source, type SourceContext, type SourceEvent } from "../lib/sdk/sources";
import { buildVaultPaths, getCurrentTeam, readTeamTimeline } from "../lib/sdk/vault";
import {
  formatDuration, getWeekEnd, getWeekNumber, getWeekStart, weekId, weekIdForDate,
} from "../lib/sdk/week-utils";
import { loadConfig } from "../lib/config";
import { createLogger } from "../lib/sdk/logger";
import { generateWeek, getEnvTokens } from "./worklog";

/** Where the team timeline lives, relative to the vault. Matches the weekly command. */
const TEAM_TIMELINE_FILE = "team-timeline.json";

export interface RefreshOptions {
  source?: string;
  since?: string;
  week?: string;
  verbose?: boolean;
}

/** One row of the table the user reads at the end. */
interface WeekRow {
  weekId: string;
  regenerated: boolean;
}

/**
 * The weeks to go over.
 *
 * Bounded by default at the current team's start date. Going further back is a decision
 * with a price on it, roughly one AI call per week regenerated, so it takes an explicit
 * `--since`.
 */
export function weeksInRange(from: Date, to: Date): CollectionWeek[] {
  const weeks: CollectionWeek[] = [];
  const cursor = new Date(from);

  while (cursor <= to) {
    // Through the ISO helper, not by pairing a week number with a calendar year. The
    // last days of December belong to the first week of the next ISO year, and pairing
    // them by hand gives 2025-W01: a week whose range starts in 2024.
    const id = weekIdForDate(cursor);
    if (!weeks.some((existing) => existing.weekId === id)) {
      const info = weekInfoFor(id);
      weeks.push(weekWindow(id, info.startDate, info.endDate));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return weeks;
}

/** `2026-W35` back into the week the rest of the tool passes around. */
function weekInfoFor(id: string): WeekInfo {
  const [yearText, weekText] = id.split("-W");
  const year = Number.parseInt(yearText, 10);
  const week = Number.parseInt(weekText, 10);
  const startDate = getWeekStart(week, year);
  const endDate = getWeekEnd(week, year);
  return { weekNumber: week, year, startDate, endDate, filename: `${id} Work Log.md` };
}

function requireConfig() {
  const config = loadConfig();
  if (!config) {
    p.log.error("No config found. Run `worklog init` first.");
    process.exit(1);
  }
  return config;
}

/** What a week needs written, handed to whatever does the writing. */
export interface WeekToWrite {
  weekId: string;
  weekInfo: WeekInfo;
  workLog: string;
  /** Only the events this run filed into the week, as prose for the prompt. */
  newMaterial: string;
}

export interface RefreshRun {
  rows: WeekRow[];
  outcome: CollectionOutcome;
  /** Weeks that still need writing but fall outside the range this run covered. */
  waiting: string[];
}

/**
 * The whole of what refresh decides, with the writing left to the caller.
 *
 * Collect, then write again only the weeks whose event set is not what it was. A run
 * that finds nothing calls `writeWeek` zero times, which is the property the command
 * rests on: no AI call, no file written, nothing to undo.
 */
export async function refreshWeeks(deps: {
  ledger: Ledger;
  sources: readonly Source[];
  weeks: readonly CollectionWeek[];
  contextFor: (source: Source) => SourceContext;
  now: Date;
  writeWeek: (week: WeekToWrite) => Promise<void>;
}): Promise<RefreshRun> {
  const { ledger, sources, weeks, contextFor, now, writeWeek } = deps;

  // What each week held before this run, so the model can be told what is new rather
  // than handed the whole week again.
  const before = new Map(weeks.map((week) => [week.weekId, ledger.eventsForWeek(week.weekId)]));

  const outcome = await collectIntoLedger(ledger, sources, weeks, contextFor, now);

  // Everything owed a write, not only what this run happened to find. A delta answers
  // with events from any week, and a week whose events changed while nobody was looking
  // at it stays owed until it is written: the next run would dedupe those events away
  // and the vault would keep a stale week for good.
  const owed = ledger.pendingWeeks();
  const inRange = owed.filter((week) => before.has(week));
  const waiting = owed.filter((week) => !before.has(week));
  const rewritten = new Set(inRange);
  const rows: WeekRow[] = weeks.map((week) => ({
    weekId: week.weekId,
    regenerated: rewritten.has(week.weekId),
  }));

  for (const weekId of inRange) {
    const weekInfo = weekInfoFor(weekId);
    const events = ledger.eventsForWeek(weekId);
    const workLog = generateEventMarkdown({
      weekInfo,
      events,
      snapshotFor: (source, itemId) => ledger.snapshot(source, itemId),
      additionalContext: "",
    });

    const added = newEvents(before.get(weekId) ?? [], events);
    await writeWeek({ weekId, weekInfo, workLog, newMaterial: describeForPrompt(added) });
    // Only now. A week that was not written — because the run stopped, or because the
    // generation refused — is still owed one on the next run.
    ledger.markWritten(weekId);
  }

  await ledger.save();
  return { rows, outcome, waiting };
}

export async function runRefresh(opts: RefreshOptions): Promise<void> {
  const log = createLogger(opts.verbose ?? false);
  p.intro("worklog refresh");

  const config = requireConfig();
  const paths = buildVaultPaths(config, TEAM_TIMELINE_FILE);
  const timeline = readTeamTimeline(paths);

  // The run's own clock. Watermarks move to this rather than to whenever each fetch
  // happened to finish, so nothing created mid-run falls between two runs.
  const startedAt = new Date();

  const from = rangeStart(opts, timeline ? getCurrentTeam(timeline)?.start : undefined);
  if (!from) {
    p.log.error("No start date. Pass --since YYYY-MM-DD, or set a team start date in team-timeline.json.");
    process.exit(1);
  }

  const single = opts.week ? weekInfoFor(opts.week) : undefined;
  const weeks = single && opts.week
    ? [weekWindow(opts.week, single.startDate, single.endDate)]
    : weeksInRange(from, startedAt);
  log(`Refreshing ${weeks.length} week(s) from ${weeks[0]?.weekId} to ${weeks[weeks.length - 1]?.weekId}`);

  const sources = allSources().filter((source) => !opts.source || source.name === opts.source);
  if (sources.length === 0) {
    p.log.error(`Unknown source "${opts.source}". Known sources: ${allSources().map((s) => s.name).join(", ")}.`);
    process.exit(1);
  }

  const { apiToken, githubToken } = getEnvTokens();
  const headers = buildHeaders(config, { atlassianApiToken: apiToken, githubToken });
  const [atlassianAccountId, githubUsername] = await Promise.all([
    getAccountId(config, headers).catch(() => ""),
    getGitHubUsername(headers).catch(() => ""),
  ]);

  const ledger = await openLedger();
  const spinner = p.spinner();
  spinner.start("Asking each source what has changed...");

  let collected = false;
  const { rows, outcome, waiting } = await refreshWeeks({
    ledger,
    sources,
    weeks,
    contextFor: (source) => sourceContext(source, {
      config,
      headers,
      identity: { atlassianAccountId, githubUsername },
      stateFor: (name) => ledger.stateFor(name),
      onWarning: (message) => p.log.warn(message),
      log,
    }),
    now: startedAt,
    writeWeek: async ({ weekId: week, weekInfo, workLog, newMaterial }) => {
      if (!collected) {
        spinner.stop(`Collected from ${sources.length} source(s)`);
        collected = true;
      }
      const bragBookPath = `${paths.vault}/${week} Brag Book.md`;
      const existingBragBook = existsSync(bragBookPath) ? await Bun.file(bragBookPath).text() : "";

      spinner.start(`${week}: writing up what is new...`);
      // Neither document is written until the week validates, and then the brag book
      // goes first. A refresh that fails mid-generation leaves the week exactly as it
      // was rather than with a new work log and last month's entry.
      await generateWeek({
        weekInfo,
        wid: week,
        workLog,
        workLogPath: `${paths.vault}/${weekInfo.filename}`,
        config,
        paths,
        timeline,
        log,
        spinner,
        // A week with no entry yet is written from scratch; one that has an entry is
        // added to, never replaced.
        amend: existingBragBook ? { existingBragBook, newMaterial } : undefined,
      });
      spinner.stop(`${week}: updated`);
    },
  });

  if (!collected) spinner.stop(`Collected from ${sources.length} source(s)`);

  for (const problem of ledger.problems()) p.log.warn(problem);
  for (const warning of outcome.warnings) p.log.warn(warning);
  if (waiting.length > 0) {
    p.log.warn(
      `${waiting.length} week(s) outside this range have new activity and still need writing: ${waiting.join(", ")}. ` +
      `Run \`worklog refresh --since\` far enough back to include them.`,
    );
  }
  for (const [name, result] of outcome.perSource) {
    if (result.unavailable) p.log.warn(`${name} was skipped: ${result.unavailable}`);
  }

  const regenerated = rows.filter((row) => row.regenerated).length;
  if (regenerated === 0) p.log.success("Nothing new. No week was rewritten and no AI call was made.");

  printTable(rows, outcome);
  p.outro(regenerated === 0 ? "Up to date" : `${regenerated} week(s) updated`);
}

/**
 * Events as prose for the prompt.
 *
 * Given only what a run added, this is the material the model has not already been told
 * about: the rest of the week is accounted for in the entry it is being asked to add to.
 */
function describeForPrompt(events: readonly SourceEvent[]): string {
  return events
    .map((event) => `- ${event.at.slice(0, 16).replace("T", " ")} ${event.source} ${event.kind} on ${event.itemId}`)
    .join("\n");
}

/** Where to start: the flag, else the current team's start date. */
function rangeStart(opts: RefreshOptions, teamStart: string | undefined): Date | undefined {
  if (opts.since) return new Date(`${opts.since}T00:00:00.000Z`);
  if (opts.week) return weekInfoFor(opts.week).startDate;
  return teamStart ? new Date(`${teamStart}T00:00:00.000Z`) : undefined;
}

/**
 * Week by week, what each source added and whether that meant writing the week again.
 *
 * Weeks nothing happened in are worth showing: a run that changed nothing should look
 * like a run that changed nothing, rather than like a run that did not happen.
 */
function printTable(rows: readonly WeekRow[], outcome: CollectionOutcome): void {
  const sources = [...outcome.perSource.keys()].sort();
  const header = ["Week", ...sources, "Regenerated"];
  const body = rows.map((row) => [
    row.weekId,
    ...sources.map((source) => String(outcome.perWeek.get(row.weekId)?.get(source) ?? 0)),
    row.regenerated ? "yes" : "no",
  ]);

  const widths = header.map((cell, i) => Math.max(cell.length, ...body.map((line) => line[i].length)));
  const format = (cells: readonly string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");

  p.log.message([format(header), format(widths.map((width) => "-".repeat(width))), ...body.map(format)].join("\n"));

  // What each source cost. One of them talks to a model and takes minutes; that should
  // not be a mystery to someone watching the run.
  const timings = sources.map((source) => {
    const result = outcome.perSource.get(source);
    return `${source} ${formatDuration(result?.tookMs ?? 0)}${result?.unavailable ? " (skipped)" : ""}`;
  });
  p.log.message(`Time per source: ${timings.join(", ")}`);
}

/**
 * `--since`, if it is a day that exists.
 *
 * The format check is not enough on its own: `2026-02-31` matches it, and `new Date`
 * rolls it forward to March 3 without complaint. Round-tripping the parsed date back to
 * a string is what catches a day that was never on the calendar.
 */
export function parseSince(value: string): string {
  const failure = new Error("--since must be a real date in YYYY-MM-DD form, for example 2026-01-31");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw failure;
  return value;
}

/**
 * `--week`, if that week exists in that year.
 *
 * Most ISO years have 52 weeks and some have 53, so the bound is the year's own last
 * week rather than a fixed number: asking for 2026-W53 should fail, and 2026-W99 should
 * not quietly become a range in 2027.
 */
export function parseWeek(value: string): string {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(value);
  if (!match) throw new Error("--week must be in YYYY-WNN form, for example 2026-W06");

  const year = Number.parseInt(match[1], 10);
  const week = Number.parseInt(match[2], 10);
  const last = weeksInYear(year);
  if (week < 1 || week > last) {
    throw new Error(`--week must be between ${year}-W01 and ${weekId(last, year)}; ${value} is not a week of ${year}`);
  }
  return weekId(week, year);
}

/** 52, or 53 in a long year. December 28 is always in the last ISO week of its year. */
function weeksInYear(year: number): number {
  return getWeekNumber(new Date(Date.UTC(year, 11, 28)));
}

export function makeRefreshCommand(): Command {
  return new Command("refresh")
    .description("Pick up what has changed since the last run and update only the weeks it belongs to")
    .option("--source <name>", "Only refresh one source (jira, confluence, github)")
    .option("--since <YYYY-MM-DD>", "Refresh weeks from this date. Defaults to the current team's start date.", parseSince)
    .option("--week <YYYY-WNN>", "Refresh a single week", parseWeek)
    .option("-v, --verbose", "Show detailed logs", false)
    .action(async (opts: RefreshOptions) => {
      await runRefresh(opts);
    });
}

