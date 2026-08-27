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
  buildHeaders, getAccountId, getGitHubUsername, type FetchHeaders, type WeekInfo,
} from "../lib/sdk/data-fetch";
import {
  collectIntoLedger, openLedger, weekWindow, type CollectionOutcome, type CollectionWeek, type Ledger,
} from "../lib/sdk/ledger";
import { generateEventMarkdown } from "../lib/sdk/markdown";
import { githubSource, confluenceSource, jiraSource } from "../lib/sdk/source-adapters";
import type { Source, SourceContext } from "../lib/sdk/sources";
import { buildVaultPaths, getCurrentTeam, readTeamTimeline } from "../lib/sdk/vault";
import { formatDuration, getWeekEnd, getWeekNumber, getWeekStart, weekId } from "../lib/sdk/week-utils";
import { loadConfig, type WorklogConfig } from "../lib/config";
import { createLogger } from "../lib/sdk/logger";
import { generateWeek, getEnvTokens } from "./worklog";

/** Every source the tool knows how to read. A source that cannot run says so and is skipped. */
function allSources(): Source[] {
  return [jiraSource(), confluenceSource(), githubSource()];
}

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
    const week = getWeekNumber(cursor);
    const year = cursor.getUTCFullYear();
    const id = weekId(week, year);
    if (!weeks.some((existing) => existing.weekId === id)) {
      weeks.push(weekWindow(id, getWeekStart(week, year), getWeekEnd(week, year)));
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
  config: WorklogConfig;
  writeWeek: (week: WeekToWrite) => Promise<void>;
}): Promise<RefreshRun> {
  const { ledger, sources, weeks, contextFor, now, config, writeWeek } = deps;

  const outcome = await collectIntoLedger(ledger, sources, weeks, contextFor, now);
  const rows: WeekRow[] = weeks.map((week) => ({ weekId: week.weekId, regenerated: false }));

  // A delta can turn up an event belonging to a week nobody asked about. It is filed,
  // because it belongs there, but this run does not go and rewrite that week.
  const asked = new Set(weeks.map((week) => week.weekId));
  const changed = [...outcome.weeksChanged].filter((week) => asked.has(week)).sort();

  for (const weekId of changed) {
    const weekInfo = weekInfoFor(weekId);
    const events = ledger.eventsForWeek(weekId);
    const workLog = generateEventMarkdown({
      weekInfo,
      events,
      snapshotFor: (source, itemId) => ledger.snapshot(source, itemId),
      additionalContext: "",
      config,
    });

    await writeWeek({ weekId, weekInfo, workLog, newMaterial: newMaterialFor(ledger, weekId) });

    const row = rows.find((candidate) => candidate.weekId === weekId);
    if (row) row.regenerated = true;
  }

  await ledger.save();
  return { rows, outcome };
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

  const weeks = opts.week
    ? [weekWindow(opts.week, weekInfoFor(opts.week).startDate, weekInfoFor(opts.week).endDate)]
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
  const { rows, outcome } = await refreshWeeks({
    ledger,
    sources,
    weeks,
    contextFor: (source) => sourceContext(source, { config, headers, atlassianAccountId, githubUsername, ledger, log }),
    now: startedAt,
    config,
    writeWeek: async ({ weekId: week, weekInfo, workLog, newMaterial }) => {
      if (!collected) {
        spinner.stop(`Collected from ${sources.length} source(s)`);
        collected = true;
      }
      await Bun.write(`${paths.vault}/${weekInfo.filename}`, workLog);

      const bragBookPath = `${paths.vault}/${week} Brag Book.md`;
      const existingBragBook = existsSync(bragBookPath) ? await Bun.file(bragBookPath).text() : "";

      spinner.start(`${week}: writing up what is new...`);
      await generateWeek({
        weekInfo,
        wid: week,
        workLog,
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

  for (const warning of outcome.warnings) p.log.warn(warning);
  for (const [name, result] of outcome.perSource) {
    if (result.unavailable) p.log.warn(`${name} was skipped: ${result.unavailable}`);
  }

  const regenerated = rows.filter((row) => row.regenerated).length;
  if (regenerated === 0) p.log.success("Nothing new. No week was rewritten and no AI call was made.");

  printTable(rows, outcome);
  p.outro(regenerated === 0 ? "Up to date" : `${regenerated} week(s) updated`);
}

/**
 * What is new in this week, as prose for the prompt.
 *
 * Only the events this run added: the rest of the work log is already accounted for in
 * the entry the model is being asked to add to.
 */
function newMaterialFor(ledger: Ledger, week: string): string {
  const lines: string[] = [];
  for (const event of ledger.eventsForWeek(week)) {
    lines.push(`- ${event.at.slice(0, 16).replace("T", " ")} ${event.source} ${event.kind} on ${event.itemId}`);
  }
  return lines.join("\n");
}

function sourceContext(
  source: Source,
  deps: {
    config: ReturnType<typeof requireConfig>;
    headers: FetchHeaders;
    atlassianAccountId: string;
    githubUsername: string;
    ledger: Ledger;
    log: (message: string) => void;
  },
): SourceContext {
  return {
    config: deps.config,
    headers: deps.headers,
    identity: { atlassianAccountId: deps.atlassianAccountId, githubUsername: deps.githubUsername },
    onWarning: (message) => p.log.warn(message),
    state: deps.ledger.stateFor(source.name),
    log: deps.log,
  };
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

export function makeRefreshCommand(): Command {
  return new Command("refresh")
    .description("Pick up what has changed since the last run and update only the weeks it belongs to")
    .option("--source <name>", "Only refresh one source (jira, confluence, github)")
    .option("--since <YYYY-MM-DD>", "Refresh weeks from this date. Defaults to the current team's start date.", (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) {
        throw new Error("--since must be a valid YYYY-MM-DD date");
      }
      return v;
    })
    .option("--week <YYYY-WNN>", "Refresh a single week", (v) => {
      if (!/^\d{4}-W\d{1,2}$/.test(v)) throw new Error("--week must be in YYYY-WNN format (e.g. 2026-W06)");
      return v;
    })
    .option("-v, --verbose", "Show detailed logs", false)
    .action(async (opts: RefreshOptions) => {
      await runRefresh(opts);
    });
}

/** Where the team timeline lives, relative to the vault. Matches the weekly command. */
const TEAM_TIMELINE_FILE = "team-timeline.json";
