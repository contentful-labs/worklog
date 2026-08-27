import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Command } from "commander";
import * as p from "@clack/prompts";
import { requireConfig, STATS_PATH, TEAM_TIMELINE_PATH, type WorklogConfig } from "../lib/config";
import { aiQueryStructured, type AIUsage } from "../lib/sdk/ai";
import { estimateCostUsd, formatCostUsd, PRICING_AS_OF } from "../lib/sdk/pricing";
import { fillTemplate, buildConfigContext } from "../lib/sdk/template";
import {
  buildVaultPaths,
  readMemory,
  readProfile,
  readWorkContext,
  readImpactLog,
  readCoachPersona,
  readFocusTracking,
  readFocusDoc,
  readArchivedFocusDocs,
  readCareerContext,
  dropDatedRowsBefore,
  getBragBooks,
  readTeamTimeline,
  resolveTeamTimeline,
  getTeamForDate,
  formatTeamTimelineForPrompt,
  getCurrentTeam,
  discoverWeeklyNotes,
  capOrganizationalNotes,
  condenseMemoryNotes,
  DEFAULT_MEMORY_FULL_WEEKS,
  collectWorkTerms,
  rankVaultNotes,
  summarizeArchivedFocusDocs,
  summarizePreviousBragBooks,
  ticketPrefixesForWeek,
  type TeamTimeline,
  type VaultPaths,
} from "../lib/sdk/vault";
import {
  getWeekNumber,
  weekId,
  weekIdForDate,
  getWeekStart,
  getWeekEnd,
  formatDuration,
  parseSince,
  parseWeek,
} from "../lib/sdk/week-utils";
import {
  buildHeaders,
  getAccountId,
  getGitHubUsername,
  type WeekInfo,
} from "../lib/sdk/data-fetch";
import { describeEvents, generateEventMarkdown } from "../lib/sdk/markdown";
import { collectIntoLedger, openLedger, weekWindow } from "../lib/sdk/ledger";
import { sourceContext } from "../lib/sdk/sources";
import { allSources } from "../lib/sdk/source-adapters";
import {
  toBragBookResult,
  parseReviewCycle,
  ensureBragBookFrontmatter,
  validatePreserved,
} from "../lib/sdk/brag-book";
import { bragBookOutputSchema } from "../lib/sdk/brag-book-schema";
import {
  selectOpenFocusItems,
  summarizeFocusHistory,
  DEFAULT_INJECT_CAP,
  DEFAULT_LAPSE_AFTER,
  type FocusItem,
} from "../lib/sdk/focus";
import {
  updateMemory,
  updateImpactLog,
  updateWorkContext,
  updateProfile,
  updateFocusTracking,
  migrateFocusTrackingFile,
  migrateVaultRecordsFile,
  migrateWeeklyFrontmatter,
  isIsoDate,
  writeFileAtomic,
} from "../lib/sdk/vault-updates";
import { createLogger } from "../lib/sdk/logger";

// Prompt-size guards. Everything older than these windows is still in the vault,
// it just stops being re-sent to the model every week.
const MEMORY_WINDOW_WEEKS = 26;
/** How far back the one-line focus history summary reaches. */
const FOCUS_SUMMARY_WEEKS = 12;

function weeksBefore(date: Date, weeks: number): Date {
  return new Date(date.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
}

// --- Stats ---

/** What one week spent at the provider. */
interface WeekTokens {
  input: number;
  output: number;
  cached: number;
  /** Input tokens written to the cache. Zero where the provider does not report them. */
  cacheWrite: number;
}

interface TimingRecord {
  weekId: string;
  date: string;
  fetch: number;
  bragBook: number;
  contextUpdates: number;
  total: number;
  counts: { jira: number; confluence: number; prs: number; reviews: number };
  // Optional because stats.json predates cost tracking: older records have none of the
  // three, and the summary has to read those files without inventing zeros for them.
  tokens?: WeekTokens;
  estimatedCostUsd?: number | null;
  model?: string;
}

async function loadStats(): Promise<TimingRecord[]> {
  if (!existsSync(STATS_PATH)) return [];
  try {
    return JSON.parse(await Bun.file(STATS_PATH).text());
  } catch {
    return [];
  }
}

async function appendStats(records: TimingRecord[]): Promise<void> {
  const existing = await loadStats();
  existing.push(...records);
  await Bun.write(STATS_PATH, JSON.stringify(existing, null, 2) + "\n");
}

// --- Progress ---

interface ProgressState {
  startedAt: string;
  totalWeeks: number;
  completedWeeks: string[];
  weeksBack?: number;
}

function progressFilePath(): string {
  return `${requireConfig().vault}/.worklog-progress.json`;
}

async function loadProgress(): Promise<ProgressState | null> {
  const path = progressFilePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

async function saveProgress(state: ProgressState): Promise<void> {
  await Bun.write(progressFilePath(), JSON.stringify(state, null, 2));
}

async function clearProgress(): Promise<void> {
  const path = progressFilePath();
  if (existsSync(path)) await unlink(path);
}

// --- Report ---

interface WeekTiming {
  weekId: string;
  fetch: number;
  bragBook: number;
  contextUpdates: number;
  total: number;
  tokens: WeekTokens;
  estimatedCostUsd: number | null;
  model: string;
}

interface WeekResult {
  weekId: string;
  jira: number;
  confluence: number;
  prs: number;
  reviews: number;
  memoryAdded: number;
  memoryRemoved: number;
  impactLog: boolean;
  workContextUpdates: number;
  profileUpdated: boolean;
  focusItems: number;
  focusUpdates: number;
}

/**
 * Turn what the provider reported into the numbers a week is recorded with.
 *
 * A provider that reports its own cost wins: the Agent SDK knows the model mix a run
 * actually used and the rates in force, which a local table cannot. Everything else is
 * priced from lib/sdk/pricing.ts, and an unpriced model costs null rather than zero.
 */
function costOf(usage: AIUsage | null): Pick<WeekTiming, "tokens" | "estimatedCostUsd" | "model"> {
  if (!usage) {
    return { tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 }, estimatedCostUsd: null, model: "unknown" };
  }

  const tokens = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cached: usage.cachedInputTokens,
    cacheWrite: usage.cacheWriteTokens,
  };
  // Per step, because a tiered rate is decided per request rather than per week.
  const estimatedCostUsd = usage.reportedCostUsd ?? estimateCostUsd(usage.model, usage.steps);

  return { tokens, estimatedCostUsd, model: usage.model };
}

/** Compact token counts so the column stays narrow: 56_231 reads as 56.2k. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Add up costs where some may be unknown.
 *
 * One unpriced model makes the whole total unknown. Treating it as zero would report a
 * number that is definitely too low and looks authoritative.
 */
function sumCosts(costs: Array<number | null>): number | null {
  if (costs.length === 0) return null;

  let total = 0;
  for (const cost of costs) {
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

async function printReport(timings: WeekTiming[], results: WeekResult[]): Promise<void> {
  if (timings.length === 0) return;

  const totalTime = timings.reduce((s, t) => s + t.total, 0);
  const totalFetch = timings.reduce((s, t) => s + t.fetch, 0);
  const totalBrag = timings.reduce((s, t) => s + t.bragBook, 0);
  const totalCtx = timings.reduce((s, t) => s + t.contextUpdates, 0);
  const avg = totalTime / timings.length;
  const fastest = timings.reduce((a, b) => (a.total < b.total ? a : b));
  const slowest = timings.reduce((a, b) => (a.total > b.total ? a : b));
  const pctFetch = totalTime > 0 ? Math.round((totalFetch / totalTime) * 100) : 0;
  const pctBrag = totalTime > 0 ? Math.round((totalBrag / totalTime) * 100) : 0;
  const pctCtx = totalTime > 0 ? Math.round((totalCtx / totalTime) * 100) : 0;

  const pad = (s: string | number, w: number) => String(s).padStart(w);
  const rows = results.map((r, i) => {
    const t = timings[i];
    const tokens = `${formatTokens(t.tokens.input)}/${formatTokens(t.tokens.output)}`;
    return `${r.weekId.padEnd(10)} | ${pad(r.jira, 4)} | ${pad(r.confluence, 4)} | ${pad(r.prs, 3)} | ${pad(r.reviews, 7)} | ${pad(formatDuration(t.total), 7)} | ${pad(tokens, 13)} | ${pad(formatCostUsd(t.estimatedCostUsd), 7)}`;
  });

  const totalJira = results.reduce((s, r) => s + r.jira, 0);
  const totalConf = results.reduce((s, r) => s + r.confluence, 0);
  const totalPrs = results.reduce((s, r) => s + r.prs, 0);
  const totalRevs = results.reduce((s, r) => s + r.reviews, 0);

  const totalTokensIn = timings.reduce((s, t) => s + t.tokens.input, 0);
  const totalTokensOut = timings.reduce((s, t) => s + t.tokens.output, 0);
  const totalCost = sumCosts(timings.map((t) => t.estimatedCostUsd));

  const lines = [
    `Week       | Jira | Conf | PRs | Reviews | Time    | Tokens in/out |    Cost`,
    `───────────┼──────┼──────┼─────┼─────────┼─────────┼───────────────┼────────`,
    ...rows,
    `───────────┼──────┼──────┼─────┼─────────┼─────────┼───────────────┼────────`,
    `Total      | ${pad(totalJira, 4)} | ${pad(totalConf, 4)} | ${pad(totalPrs, 3)} | ${pad(totalRevs, 7)} | ${pad(formatDuration(totalTime), 7)} | ${pad(`${formatTokens(totalTokensIn)}/${formatTokens(totalTokensOut)}`, 13)} | ${pad(formatCostUsd(totalCost), 7)}`,
    ``,
    `Context updates: ${results.reduce((s, r) => s + r.memoryAdded + r.memoryRemoved, 0)} memory, ${results.filter((r) => r.impactLog).length} impact log, ${results.reduce((s, r) => s + r.workContextUpdates, 0)} work context, ${results.filter((r) => r.profileUpdated).length} profile, ${results.reduce((s, r) => s + r.focusItems + r.focusUpdates, 0)} focus`,
    ``,
    `Cost is estimated from published rates as of ${PRICING_AS_OF}; a dash means the model is not in the table.`,
    `OpenAI does not report cache writes, so those are billed as ordinary input and can read low.`,
    ``,
    `Avg per week: ${formatDuration(Math.round(avg))}`,
    `Fastest: ${fastest.weekId} (${formatDuration(fastest.total)})`,
    `Slowest: ${slowest.weekId} (${formatDuration(slowest.total)})`,
    ``,
    `Breakdown:`,
    `  Data fetching: ${formatDuration(totalFetch)} (${pctFetch}%)`,
    `  Brag book gen: ${formatDuration(totalBrag)} (${pctBrag}%)`,
    `  Context updates: ${formatDuration(totalCtx)} (${pctCtx}%)`,
  ];

  const stats = await loadStats();
  if (stats.length > 0) {
    const avgFetch = stats.reduce((s, r) => s + r.fetch, 0) / stats.length;
    const avgBrag = stats.reduce((s, r) => s + r.bragBook, 0) / stats.length;
    const avgCtx = stats.reduce((s, r) => s + r.contextUpdates, 0) / stats.length;
    lines.push(``, `Historical avg: fetch ${formatDuration(Math.round(avgFetch))}, brag ${formatDuration(Math.round(avgBrag))}, ctx ${formatDuration(Math.round(avgCtx))} (from ${stats.length} runs)`);

    // Runs from before cost tracking have no tokens field, so they are counted separately
    // rather than averaged in as zero.
    const costed = stats.filter((r) => r.tokens !== undefined);
    if (costed.length > 0) {
      const spent = sumCosts(costed.map((r) => r.estimatedCostUsd ?? null));
      const avgCost = spent === null ? null : spent / costed.length;
      lines.push(`Historical spend: ${formatCostUsd(spent)} over ${costed.length} costed week(s), avg ${formatCostUsd(avgCost)}`);
    }
  }

  p.note(lines.join("\n"), "Summary");
}

// --- Week selection ---

async function getWeeksToGenerate(
  vaultDir: string,
  weeksBack?: number,
  specificWeek?: string,
  force?: boolean,
  sinceDate?: string,
): Promise<WeekInfo[]> {
  if (specificWeek) {
    const [yearStr, weekStr] = specificWeek.split("-W");
    const year = parseInt(yearStr, 10);
    const weekNumber = parseInt(weekStr, 10);
    const wid = weekId(weekNumber, year);
    return [{ weekNumber, year, startDate: getWeekStart(weekNumber, year), endDate: getWeekEnd(weekNumber, year), filename: `${wid} Work Log.md` }];
  }

  const now = new Date();
  const currentWeek = getWeekNumber(now);
  const currentYear = now.getFullYear();

  const existingWeeks = new Set<string>();
  const files = await readdir(vaultDir);
  for (const file of files) {
    const match = file.match(/^(\d{4})-W(\d{2}) Brag Book\.md$/);
    if (match) existingWeeks.add(weekId(parseInt(match[2], 10), parseInt(match[1], 10)));
  }

  let startWeek: number;
  let startYear: number;

  if (sinceDate) {
    const d = new Date(sinceDate + "T00:00:00Z");
    startWeek = getWeekNumber(d);
    const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
    startYear = utc.getUTCFullYear();
  } else if (weeksBack !== undefined) {
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - weeksBack * 7);
    startWeek = getWeekNumber(startDate);
    const utc = new Date(Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()));
    const dayNum = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
    startYear = utc.getUTCFullYear();
  } else {
    startWeek = currentWeek - 8;
    startYear = currentYear;
    if (startWeek < 1) {
      startYear--;
      startWeek = getWeekNumber(new Date(Date.UTC(startYear, 11, 28))) + startWeek;
    }
    if (existingWeeks.size > 0) {
      const earliest = Array.from(existingWeeks).sort()[0];
      const match = earliest.match(/^(\d{4})-W(\d{2})$/);
      if (match) { startYear = parseInt(match[1], 10); startWeek = parseInt(match[2], 10); }
    }
  }

  const weeks: WeekInfo[] = [];
  let week = startWeek;
  let year = startYear;

  while (year < currentYear || (year === currentYear && week <= currentWeek)) {
    const wid = weekId(week, year);
    const isCurrentWeek = week === currentWeek && year === currentYear;
    if (!existingWeeks.has(wid) || isCurrentWeek || force) {
      weeks.push({ weekNumber: week, year, startDate: getWeekStart(week, year), endDate: getWeekEnd(week, year), filename: `${wid} Work Log.md` });
    }
    week++;
    const maxWeek = getWeekNumber(new Date(Date.UTC(year, 11, 28)));
    if (week > maxWeek) { week = 1; year++; }
  }

  return weeks;
}

// --- Context prompt ---

type WeekContextMap = Record<string, string>;
let _weekContextMap: WeekContextMap | undefined;

function loadWeekContextMap(path: string): WeekContextMap {
  if (!_weekContextMap) {
    try { _weekContextMap = JSON.parse(require("fs").readFileSync(path, "utf-8")); }
    catch { _weekContextMap = {}; }
  }
  return _weekContextMap!;
}

async function promptForContext(weekNumber: number, year: number, contextFilePath?: string): Promise<string> {
  if (contextFilePath) {
    const map = loadWeekContextMap(contextFilePath);
    const wid = weekId(weekNumber, year);
    const ctx = map[wid] || "";
    if (ctx) p.log.info(`Context for ${wid}: ${ctx.slice(0, 80)}${ctx.length > 80 ? "..." : ""}`);
    return ctx;
  }
  const result = await p.text({ message: `Week ${weekNumber}, ${year} — additional context not in Jira/GitHub/Confluence?`, placeholder: "Press Enter to skip" });
  if (p.isCancel(result)) { p.cancel("Cancelled."); process.exit(0); }
  return (result || "").trim();
}

// --- Credential resolution ---

/** The tokens a run holds. Empty for a system this run was not asked to read. */
export interface EnvTokens {
  apiToken: string;
  githubToken: string;
}

/** Which systems a run is actually going to talk to. */
export interface CredentialsNeeded {
  atlassian: boolean;
  github: boolean;
}

/**
 * The tokens this run needs, and only those.
 *
 * A run that was told to read one source has no business demanding the credentials of
 * another: `worklog refresh --source github` used to stop because there was no Atlassian
 * token, which is a token it was never going to use.
 */
export function getEnvTokens(needed: CredentialsNeeded = { atlassian: true, github: true }): EnvTokens {
  const apiToken = process.env.ATLASSIAN_API_TOKEN;
  if (needed.atlassian && !apiToken) {
    p.log.error("ATLASSIAN_API_TOKEN not set. Run `worklog init` to set up credentials.\nOr generate manually at: https://id.atlassian.com/manage-profile/security/api-tokens");
    process.exit(1);
  }
  const githubToken = process.env.GITHUB_TOKEN;
  if (needed.github && !githubToken) {
    p.log.error("GITHUB_TOKEN not set. Run `worklog init` to set up credentials.\nOr generate manually at: https://github.com/settings/tokens");
    process.exit(1);
  }
  return { apiToken: apiToken ?? "", githubToken: githubToken ?? "" };
}

// --- Brag book prompt builder ---

const PROMPT_TEMPLATE_PATH = new URL("../prompts/weekly-brag-prompt.md", import.meta.url).pathname;
const WRITING_STYLE_PATH = new URL("../prompts/_writing-style.md", import.meta.url).pathname;

/**
 * Characters each part of the prompt contributes. Reported under `--verbose` so the next person
 * to look at prompt size can see where the bytes actually go instead of guessing.
 */
export interface PromptSectionSizes {
  /** The prompt file and the writing style guide, both fixed. */
  template: number;
  /** XML wrappers, the review-proximity block and the generation context. */
  framing: number;
  persona: number;
  profile: number;
  context: number;
  impact: number;
  memory: number;
  priorBrags: number;
  /** The engineer's current `My Focus.md`, carried whole. */
  focusDoc: number;
  /** Archived focus docs, already reduced to changes plus carried-open items. */
  focusArchives: number;
  /** The open commitments from `focus-tracking.md`, capped at ten. */
  focusOpenItems: number;
  /** The one-line status tally from `focus-tracking.md`. */
  focusHistorySummary: number;
  career: number;
  notes: number;
  worklog: number;
}

/**
 * Memory's rows interleave, so its parts cannot be chunks of the prompt the way the focus inputs
 * can. These are counted separately and must add up to `sections.memory`.
 */
export interface MemoryInputSizes {
  /** Rows inside the graduation window, carried whole. */
  liveRows: number;
  /** Rows older than that, carried without their Notes cell. */
  olderRows: number;
  /** Headings, table scaffolding and blank lines. */
  other: number;
}

export interface BuiltPrompt {
  prompt: string;
  sections: PromptSectionSizes;
  memoryInputs: MemoryInputSizes;
}

function formatSizes(label: string, sizes: Readonly<Record<string, number>>): string {
  const parts = Object.entries(sizes)
    .sort(([, a], [, b]) => b - a)
    .map(([name, chars]) => `${name} ${(chars / 1000).toFixed(1)}k`);
  return `${label}: ${parts.join(", ")}`;
}

export function formatPromptBreakdown(sections: PromptSectionSizes): string {
  return formatSizes("Prompt breakdown", { ...sections });
}

export function formatMemoryBreakdown(memoryInputs: MemoryInputSizes): string {
  return formatSizes("Memory breakdown", { ...memoryInputs });
}

export async function buildBragBookPrompt(
  workLogContent: string,
  previousBragBooks: string,
  workContextContent: string,
  memoryContent: string,
  profileContent: string,
  impactLogContent: string,
  coachPersona: string,
  focusDocContent: string,
  focusHistoryContent: string,
  careerContext: string,
  vaultNotes: Array<{ title: string; excerpt: string }>,
  openFocusItems: FocusItem[],
  focusHistorySummary: string,
  reviewInfo: ReturnType<typeof parseReviewCycle>,
  timeline: TeamTimeline,
  weekInfo: WeekInfo | undefined,
  config: Parameters<typeof buildConfigContext>[0],
  amend?: { existingBragBook: string; newMaterial: string },
): Promise<BuiltPrompt> {
  const [rawPromptTemplate, writingStyle] = await Promise.all([
    Bun.file(PROMPT_TEMPLATE_PATH).text(),
    Bun.file(WRITING_STYLE_PATH).text(),
  ]);
  const teamForWeek = weekInfo ? getTeamForDate(timeline, weekInfo.startDate) : getCurrentTeam(timeline);
  const currentTeamLabel = teamForWeek?.team ?? "Unknown Team";
  const currentRole = `${config.profile.jobTitle} / ${config.profile.level} (${config.profile.company} - ${currentTeamLabel})`;

  const promptTemplate = fillTemplate(rawPromptTemplate, {
    ...buildConfigContext(config),
    current_team: currentTeamLabel,
    current_role: currentRole,
    writing_style: writingStyle,
  });

  // Trimming happens here rather than in the readers: the vault files are read whole by other
  // callers, and what the prompt carries is a decision about the prompt.
  const trimmedWorkContext = capOrganizationalNotes(workContextContent);
  const trimmedBragBooks = summarizePreviousBragBooks(previousBragBooks);
  const trimmedFocusHistory = summarizeArchivedFocusDocs(focusHistoryContent);
  // The week's own team prefixes, not today's. A historical week whose team used `OLD` scores
  // nothing against the current profile, and its one relevant note falls off the end of the cap.
  const rankedNotes = rankVaultNotes(
    vaultNotes,
    collectWorkTerms(workLogContent, ticketPrefixesForWeek(config, teamForWeek)),
  );

  const vaultNotesSection = rankedNotes.length > 0
    ? `\n---\n\n<vault_research_notes>\nThese are work-related notes from the engineer's vault that were created or updated this week.\nThey provide additional context about research, meetings, and work that may not appear in Jira/GitHub/Confluence.\n\n${rankedNotes.map((n) => `### ${n.title}\n${n.excerpt}`).join("\n\n")}\n</vault_research_notes>`
    : "";

  const reviewProximitySection = reviewInfo
    ? `\n---\n\n<review_proximity>\n  <next_review>${reviewInfo.nextReview}</next_review>\n  <date>${reviewInfo.date}</date>\n  <weeks_remaining>${reviewInfo.weeksRemaining}</weeks_remaining>\n  <urgency>${reviewInfo.urgency}</urgency>\n</review_proximity>`
    : "";

  // Split into its own chunks so the breakdown can say which part of `focus` costs what: the
  // commitments themselves, the one-line tally, and the wrapper around them.
  const hasOpenFocus = openFocusItems.length > 0;
  const openFocusOpening = hasOpenFocus
    ? "\n---\n\n<open_focus_items>\nCommitments from previous coaching sessions that are still open. Check each against this week's work\nand return a focusStatuses entry for EVERY id below.\n\n"
    : "";
  const openFocusList = hasOpenFocus
    ? openFocusItems.map((f) => `  - ${f.id} (week ${f.week}, reviewed ${f.reviews}x): ${f.item}`).join("\n")
    : "";
  const openFocusTally = hasOpenFocus && focusHistorySummary ? `\n\n${focusHistorySummary}\n` : "";
  const openFocusClosing = hasOpenFocus ? `${focusHistorySummary ? "" : "\n"}</open_focus_items>` : "";

  // Memory keeps every row so the coach can still graduate any of them, but a row older than the
  // graduation window loses its Notes cell.
  const memoryFullSince = weekInfo
    ? weeksBefore(weekInfo.startDate, DEFAULT_MEMORY_FULL_WEEKS).toISOString().split("T")[0]
    : "";
  const condensedMemory = condenseMemoryNotes(memoryContent, memoryFullSince);

  // Amending: the model is adding to an entry that already exists, so it needs the
  // entry itself and a marker for which part of the work log it has not yet seen.
  const amendSection = amend
    ? `
<existing_brag_book>
This week already has a brag book entry, below. Return the whole document again with the
new material worked into it. Every achievement bullet and every coaching heading below
must appear again word for word: the run refuses to write a document that drops one, and
the week keeps its old entry instead. Add to it, do not rewrite it, do not restate what
it already says, and do not change its account of what happened.
${amend.existingBragBook}
</existing_brag_book>

<new_material>
Only the following is new since that entry was written. Everything else in the work log
above is already accounted for.
${amend.newMaterial}
</new_material>
`
    : "";

  const generationContext = (() => {
    if (!weekInfo) return "";
    const teamEntry = getTeamForDate(timeline, weekInfo.startDate);
    const teamLabel = teamEntry ? `${teamEntry.team}${teamEntry.domain ? ` (${teamEntry.domain})` : ""}` : "Unknown";
    const isCurrentWeek = weekIdForDate(new Date()) === weekId(weekInfo.weekNumber, weekInfo.year);
    return `\n<generation_context>\nIMPORTANT: You are generating a brag book for **Week ${weekInfo.weekNumber}, ${weekInfo.year}** (${weekInfo.startDate.toISOString().split("T")[0]} to ${weekInfo.endDate.toISOString().split("T")[0]}).\n\nThis may be a historical regeneration. The work log data below is from that specific time period — it is NOT broken tooling. The tickets, PRs, and pages shown are the engineer's actual work from that week.\n\nTeam assignment at that time: ${teamLabel}${teamEntry?.notes ? `\nNote: ${teamEntry.notes}` : ""}\n\nFull team timeline:\n${formatTeamTimelineForPrompt(timeline)}\n\n${isCurrentWeek ? "This is the CURRENT week, so today's state is this week's state and live status is fair." : "This is a PAST week. Use state as of the end of it. Anything that happened after it belongs to the week it happened in, not to this one."}\n\nDo NOT reference the current date, current team assignment, or any context files that reflect a different time period. Generate the brag book AS IF you are writing it during that week.\n</generation_context>\n`;
  })();

  // The prompt is assembled as labelled chunks that partition it exactly, so the breakdown
  // accounts for every character rather than for the inputs alone. `framing` is the XML wrappers,
  // rules and generation context that hold the rest together.
  const chunks: Array<[keyof PromptSectionSizes, string]> = [
    ["template", promptTemplate],
    ["framing", "\n\n---\n\n<coach_persona>\n"],
    ["persona", coachPersona],
    ["framing", "\n</coach_persona>\n\n---\n\n<engineer_profile>\n"],
    ["profile", profileContent],
    ["framing", "\n</engineer_profile>\n\n---\n\n<work_context>\n"],
    ["context", trimmedWorkContext],
    ["framing", "\n</work_context>\n\n---\n\n<impact_log>\n"],
    ["impact", impactLogContent],
    ["framing", "\n</impact_log>\n\n---\n\n<current_memory>\n"],
    ["memory", condensedMemory.content],
    ["framing", "\n</current_memory>\n\n---\n\n<previous_brag_books>\n"],
    ["priorBrags", trimmedBragBooks],
    ["framing", "\n</previous_brag_books>\n\n---\n\n<focus_doc>\n"],
    ["focusDoc", focusDocContent],
    ["framing", "\n</focus_doc>\n\n---\n\n<focus_history>\n"],
    ["focusArchives", trimmedFocusHistory],
    ["framing", "\n</focus_history>\n\n---\n\n<career_context>\n"],
    ["career", careerContext],
    ["framing", `\n</career_context>\n${reviewProximitySection}\n${openFocusOpening}`],
    ["focusOpenItems", openFocusList],
    ["focusHistorySummary", openFocusTally],
    ["framing", `${openFocusClosing}\n`],
    ["notes", vaultNotesSection],
    ["framing", `\n---\n${generationContext}\n<this_weeks_work_log>\n`],
    ["worklog", workLogContent],
    ["framing", "\n</this_weeks_work_log>\n"],
    // Counted as prior brag books: it is one, and the size breakdown has to partition the
    // prompt exactly rather than account for the inputs alone.
    ["priorBrags", amendSection],
    ["framing", "\n---\n\nReturn the object described by the schema. The brag book markdown goes in bragBookMarkdown."],
  ];

  const prompt = chunks.map(([, text]) => text).join("");

  const sections: PromptSectionSizes = {
    template: 0, framing: 0, persona: 0, profile: 0, context: 0, impact: 0,
    memory: 0, priorBrags: 0, focusDoc: 0, focusArchives: 0, focusOpenItems: 0,
    focusHistorySummary: 0, career: 0, notes: 0, worklog: 0,
  };
  for (const [name, text] of chunks) sections[name] += text.length;

  const { liveRows, olderRows, other } = condensedMemory.counts;
  return { prompt, sections, memoryInputs: { liveRows, olderRows, other } };
}

// --- Per-week generation ---

export interface WeekGenerationInput {
  /** The week being written. */
  weekInfo: WeekInfo;
  /** `2026-W35`. */
  wid: string;
  /**
   * The work log markdown for this week, built but not yet written.
   *
   * Nothing lands until the week validates. Writing it before generation would mean a
   * failed run had already destroyed the previous work log.
   */
  workLog: string;
  /** Where the work log goes once the week validates. */
  workLogPath: string;
  config: WorklogConfig;
  paths: VaultPaths;
  timeline: TeamTimeline;
  log: (message: string) => void;
  /** Progress reporting; the caller owns the spinner so a multi-week run keeps one. */
  spinner: ReturnType<typeof p.spinner>;
  /**
   * Present when amending a week that already has a brag book: the existing document,
   * and only the material that is new since it was written. The generation adds to the
   * existing entry rather than replacing it.
   */
  amend?: { existingBragBook: string; newMaterial: string };
}

export interface WeekGenerationResult {
  bragBookPath: string;
  workLogPath: string;
  bragBookContent: string;
  memoryAdded: number;
  memoryRemoved: number;
  impactLogged: boolean;
  workContextUpdates: number;
  profileUpdated: boolean;
  focusItems: number;
  focusUpdates: number;
  bragBookMs: number;
  contextUpdatesMs: number;
  /** What the week's one AI call used, and what that is worth. */
  cost: Pick<WeekTiming, "tokens" | "estimatedCostUsd" | "model">;
}

export async function generateWeek(input: WeekGenerationInput): Promise<WeekGenerationResult> {
  const { weekInfo, wid, workLog: markdown, workLogPath, config, paths, timeline, log, spinner: s, amend } = input;
  const provider = config.ai.provider ?? "openai";

  // Load vault context
  log("Loading vault context files...");
  const [fullMemoryContent, profileContent, workContextContent, impactLogContent, coachPersona, rawFocusTrackingContent, focusDocContent, focusHistoryContent, careerContext, previousBragBooks] = await Promise.all([
    readMemory(paths),
    readProfile(paths),
    readWorkContext(paths),
    readImpactLog(paths),
    readCoachPersona(paths),
    readFocusTracking(paths),
    readFocusDoc(paths),
    readArchivedFocusDocs(paths),
    readCareerContext(paths),
    getBragBooks(paths, 2, `${wid} Brag Book.md`),
  ]);
  const memoryCutoff = weeksBefore(weekInfo.startDate, MEMORY_WINDOW_WEEKS).toISOString().split("T")[0];
  const memoryContent = dropDatedRowsBefore(fullMemoryContent, memoryCutoff);
  log(`Vault files loaded — memory: ${memoryContent.length} chars (of ${fullMemoryContent.length}, rows since ${memoryCutoff}), profile: ${profileContent.length} chars`);

  const vaultNotes = await discoverWeeklyNotes(config, paths, weekInfo.startDate, weekInfo.endDate);
  log(`Discovered ${vaultNotes.length} weekly vault notes`);

  const openFocusItems = selectOpenFocusItems(rawFocusTrackingContent, DEFAULT_INJECT_CAP);
  const focusHistorySummary = summarizeFocusHistory(
    rawFocusTrackingContent,
    weekIdForDate(weeksBefore(weekInfo.startDate, FOCUS_SUMMARY_WEEKS)),
  );
  const reviewInfo = parseReviewCycle(workContextContent);
  log(`Open focus items injected: ${openFocusItems.length}${focusHistorySummary ? ` | ${focusHistorySummary}` : ""}`);
  if (reviewInfo) log(`Review cycle: ${reviewInfo.urgency} — ${reviewInfo.nextReview} in ${reviewInfo.weeksRemaining} weeks`);

  // Generate brag book
  const bragStart = performance.now();
  s.start("Generating brag book...");

  const { prompt: fullPrompt, sections: promptSections, memoryInputs } = await buildBragBookPrompt(
    markdown, previousBragBooks, workContextContent, memoryContent, profileContent,
    impactLogContent, coachPersona, focusDocContent, focusHistoryContent,
    careerContext, vaultNotes, openFocusItems, focusHistorySummary, reviewInfo, timeline, weekInfo, config,
    amend
  );
  log(`AI query — provider: ${provider}, model: ${config.ai.model ?? "default"}, prompt: ${fullPrompt.length} chars`);
  log(formatPromptBreakdown(promptSections));
  log(formatMemoryBreakdown(memoryInputs));

  let usage: AIUsage | null = null;
  const output = await aiQueryStructured({
    prompt: fullPrompt,
    config,
    schema: bragBookOutputSchema,
    schemaName: "brag_book_update",
    log,
    onUsage: (reported) => {
      usage = reported;
    },
  });
  log(`AI response: ${output.bragBookMarkdown.length} chars of markdown plus the vault updates`);

  const cost = costOf(usage);
  log(
    `Tokens: ${cost.tokens.input} in (${cost.tokens.cached} cached, ${cost.tokens.cacheWrite} cache write) / ` +
    `${cost.tokens.output} out, est. ${formatCostUsd(cost.estimatedCostUsd)} on ${cost.model}`,
  );

  const parsed = toBragBookResult(output);
  const { itemsToAdd, itemsToRemove, impactLogEntry, workContextUpdates, profileUpdate, focusItems, focusUpdates } = parsed;
  const bragBookContent = ensureBragBookFrontmatter(parsed.bragBookContent);
  // Amending a week may add to it and may not take anything out of it. Checked here,
  // before any write, so a week that would have lost an achievement keeps the one it had.
  if (amend) validatePreserved(amend.existingBragBook, bragBookContent);
  const bragMs = Math.round(performance.now() - bragStart);
  s.stop(`Brag book generated in ${formatDuration(bragMs)}`);

  // The week is validated now, so both documents land. Each write is atomic, and the
  // brag book goes first: it is the record that cannot be rebuilt without another
  // generation, so a failure there must leave the previous week intact, while a failure
  // on the work log leaves a brag book that is already correct.
  const bragBookPath = `${paths.vault}/${wid} Brag Book.md`;
  await writeFileAtomic(bragBookPath, bragBookContent);
  log(`Brag book written: ${bragBookPath} (${bragBookContent.length} chars)`);
  await writeFileAtomic(workLogPath, markdown);
  log(`Work log written: ${workLogPath} (${markdown.length} chars)`);

  // Context updates
  const ctxStart = performance.now();
  s.start("Updating context...");
  log(`Context updates — memory: +${itemsToAdd.length}/-${itemsToRemove.length}, impact: ${impactLogEntry ? "yes" : "no"}, workContext: ${workContextUpdates.length}, profile: ${profileUpdate ? "yes" : "no"}, focus: ${focusItems.length}/${focusUpdates.length}`);

  const memoryResult = await updateMemory(paths.memory, itemsToAdd, itemsToRemove);
  if (memoryResult.status === "no-section") p.log.warn("memory.md has no live table above its archived sections; items not written");
  for (const missed of memoryResult.unmatchedGraduations) {
    const closest = missed.candidate ? `; closest memory row is "${missed.candidate}"` : "";
    p.log.warn(`could not graduate "${missed.requested}"${closest}`);
  }
  const impactResult = await updateImpactLog(paths.impactLog, impactLogEntry);
  if (impactResult.status === "no-section") p.log.warn("impact-log.md has no `## Impact Timeline` section; entry not written");
  if (impactLogEntry && !isIsoDate(impactLogEntry.date)) p.log.warn(`impact entry is dated "${impactLogEntry.date}", which is not a date; entry not written`);
  const workContextResult = await updateWorkContext(paths.workContext, workContextUpdates);
  if (workContextResult.status === "no-section") p.log.warn("work-context.md has no `## Organizational Notes` section; notes not written");
  const profileResult = await updateProfile(paths.profile, profileUpdate);
  if (profileResult.status === "no-section") p.log.warn("my-profile.md has no `## Key Strengths` section; strength not written");
  const skipped = memoryResult.skipped + impactResult.skipped + workContextResult.skipped + profileResult.skipped;
  const merged = memoryResult.merged + impactResult.merged + workContextResult.merged + profileResult.merged;
  if (merged > 0 || skipped > 0) log(`Vault records: ${merged} merged into existing records, ${skipped} already present or empty`);
  if (focusItems.length > 0 || focusUpdates.length > 0 || openFocusItems.length > 0) {
    const focusResult = await updateFocusTracking(paths.focusTracking, {
      focusItems,
      focusUpdates,
      reviewedIds: openFocusItems.map((f) => f.id),
      weekLabel: wid,
      lapseAfter: DEFAULT_LAPSE_AFTER,
    });
    log(`Focus: ${focusResult.resolved} resolved, ${focusResult.lapsed} lapsed, ${focusResult.added} added, ${focusResult.restated} restated`);
    for (const near of focusResult.nearDuplicates) p.log.warn(`added "${near.item}"; looks close to open item ${near.candidateId}`);
  }

  const ctxMs = Math.round(performance.now() - ctxStart);
  s.stop(`Context updated in ${formatDuration(ctxMs)}`);

  return {
    cost,
    bragBookPath,
    workLogPath,
    bragBookContent,
    memoryAdded: memoryResult.added + memoryResult.merged,
    memoryRemoved: memoryResult.removed,
    impactLogged: impactResult.added + impactResult.merged > 0,
    workContextUpdates: workContextResult.added + workContextResult.merged,
    profileUpdated: profileResult.status === "written",
    focusItems: focusItems.length,
    focusUpdates: focusUpdates.length,
    bragBookMs: bragMs,
    contextUpdatesMs: ctxMs,
  };
}

// --- Main worklog runner ---

export async function runWorklog(opts: {
  weeks?: number;
  week?: string;
  since?: string;
  noPrompt: boolean;
  force: boolean;
  verbose: boolean;
  prompt?: string;
  contextFile?: string;
}): Promise<void> {
  const { weeks: weeksBack, week: specificWeek, since: sinceDate, noPrompt, force, verbose, prompt: sharedPrompt, contextFile } = opts;
  const log = createLogger(verbose);

  p.intro("worklog");

  const config = requireConfig();
  const paths = buildVaultPaths(config, TEAM_TIMELINE_PATH);
  // Stands in a profile-derived entry when there is no timeline file, so the prompt names
  // the engineer's team rather than "Unknown Team".
  const timeline = resolveTeamTimeline(readTeamTimeline(paths, { onWarning: (message) => p.log.warn(message) }), config);

  // Focus items are keyed by id now; upgrade a pre-id file before anything reads it.
  const migration = await migrateFocusTrackingFile(paths.focusTracking);
  if (migration?.kind === "ids") {
    p.log.info(
      `Upgraded focus-tracking.md to id-keyed format: ${migration.assigned} items kept, ` +
      `${migration.collapsed} duplicates collapsed, ${migration.lapsed} stale items closed. Backup: ${migration.backup}`,
    );
  } else if (migration?.kind === "format") {
    p.log.info(`Cleaned focus-tracking.md: ${migration.lapsed} stale open item(s) closed. Backup: ${migration.backup}`);
  }

  // The other four vault files were written for months without a placeholder or
  // duplicate check; clean up what that left behind before anything reads them.
  for (const [kind, recordPath] of [
    ["memory", paths.memory],
    ["impact-log", paths.impactLog],
    ["work-context", paths.workContext],
    ["my-profile", paths.profile],
  ] as const) {
    const cleanup = await migrateVaultRecordsFile(recordPath, kind);
    if (cleanup && cleanup.unjoined > 0) {
      p.log.info(`Repaired impact log: ${cleanup.unjoined} entries unjoined, backup ${cleanup.backup}`);
    }
    for (const cells of cleanup?.unjoinSkipped ?? []) {
      p.log.warn(`impact-log.md has a row of ${cells} cells that could not be split safely; left as it is`);
    }
    if (cleanup?.backup) {
      p.log.info(
        `Cleaned ${kind}.md: ${cleanup.placeholders} placeholder rows removed, ` +
        `${cleanup.duplicates} duplicates collapsed. Backup: ${cleanup.backup}`,
      );
    }
  }

  // Weeks generated before the writers emitted frontmatter have none, so the vault
  // cannot find them by tag. Give them the block their writers emit today.
  const frontmatter = await migrateWeeklyFrontmatter(paths.vault);
  if (frontmatter.updated.length > 0) {
    p.log.info(`Added frontmatter to ${frontmatter.updated.length} weekly document(s)`);
  }

  const weeksToGenerate = await getWeeksToGenerate(paths.vault, weeksBack, specificWeek, force, sinceDate);

  if (weeksToGenerate.length === 0) {
    p.log.info("No missing weeks to generate.");
    await clearProgress();
    p.outro("Nothing to do");
    return;
  }

  const previousProgress = await loadProgress();
  if (previousProgress) {
    const completed = previousProgress.completedWeeks.length;
    const total = previousProgress.totalWeeks;
    p.log.warn(`Resuming interrupted run (started ${previousProgress.startedAt}, ${completed}/${total} completed)`);
  }

  const totalWeeks = weeksToGenerate.length;
  p.log.info(`Found ${totalWeeks} week(s) to generate:\n${weeksToGenerate.map((w) => `Week ${w.weekNumber}, ${w.year}`).join("\n")}`);

  const progress: ProgressState = {
    startedAt: new Date().toISOString(),
    totalWeeks,
    completedWeeks: previousProgress?.completedWeeks || [],
    weeksBack,
  };
  await saveProgress(progress);

  let skipPrompts = noPrompt;
  if (contextFile) {
    skipPrompts = false;
  } else if (!noPrompt && weeksToGenerate.length > 1) {
    const shouldPrompt = await p.confirm({ message: "Prompt for additional context each week?" });
    if (p.isCancel(shouldPrompt)) { p.cancel("Cancelled."); process.exit(0); }
    skipPrompts = !shouldPrompt;
  }

  const s = p.spinner();
  const { apiToken, githubToken } = getEnvTokens();
  const headers = buildHeaders(config, { atlassianApiToken: apiToken, githubToken });

  const ledger = await openLedger();
  // Nothing may be generated from a ledger that cannot say what has already been written
  // up; it would offer every week again and be unable to record that it had.
  const blocked = ledger.unusable();
  if (blocked) {
    p.log.error(blocked);
    process.exit(1);
  }
  const sources = allSources();
  // One clock for the whole run: watermarks move to when it started, not when each
  // fetch happened to finish.
  const runStartedAt = new Date();

  s.start("Getting account IDs...");
  log("Authenticating with Atlassian and GitHub...");
  const [accountId, githubUsername] = await Promise.all([
    getAccountId(config, headers),
    getGitHubUsername(headers),
  ]);
  s.stop("Account IDs ready");
  log(`Atlassian accountId: ${accountId}, GitHub username: ${githubUsername}`);

  const timings: WeekTiming[] = [];
  const results: WeekResult[] = [];
  let lastBragBookPath = "";
  let lastBragBookContent = "";

  for (let i = 0; i < weeksToGenerate.length; i++) {
    const weekInfo = weeksToGenerate[i];
    const wid = weekId(weekInfo.weekNumber, weekInfo.year);
    const weekStart = performance.now();

    if (i > 0) p.log.message("");
    p.log.step(`[${i + 1}/${totalWeeks}] ${wid} (${weekInfo.startDate.toISOString().split("T")[0]} to ${weekInfo.endDate.toISOString().split("T")[0]})`);

    const perWeekContext = skipPrompts ? "" : await promptForContext(weekInfo.weekNumber, weekInfo.year, contextFile);
    const additionalContext = [sharedPrompt, perWeekContext].filter(Boolean).join("\n\n");

    // Fetch into the ledger, then write the week from it. The same path `refresh` takes,
    // so a week generated today and the same week amended next month are built the same
    // way from the same events.
    const fetchStart = performance.now();
    s.start("Fetching data...");
    const collected = await collectIntoLedger(
      ledger,
      sources,
      [weekWindow(wid, weekInfo.startDate, weekInfo.endDate)],
      (source) => sourceContext(source, {
        config,
        headers,
        identity: { atlassianAccountId: accountId, githubUsername },
        stateFor: (name) => ledger.stateFor(name),
        onWarning: (message) => p.log.warn(message),
        log,
      }),
      runStartedAt,
    );
    await ledger.save();
    const fetchMs = Math.round(performance.now() - fetchStart);

    for (const warning of collected.warnings) p.log.warn(warning);
    for (const [name, outcome] of collected.perSource) {
      if (outcome.unavailable) p.log.warn(`${name} was skipped: ${outcome.unavailable}`);
    }

    // A week whose cached events cannot all be read is a week with pieces missing.
    // Writing it would turn a damaged cache file, which can be refetched, into a damaged
    // week, which cannot.
    if (ledger.unreadableWeeks().includes(wid)) {
      s.stop(`${wid} skipped`);
      for (const problem of ledger.problems()) p.log.warn(problem);
      p.log.warn(`${wid} was not written: its cached events could not all be read. Fix or delete the file named above and run again.`);
      continue;
    }

    // Same reasoning, different cause: a source that did not finish leaves a partial
    // account of the week, and writing it up would make the missing part old news by the
    // time it arrives.
    if (collected.incompleteWeeks.has(wid)) {
      s.stop(`${wid} skipped`);
      p.log.warn(`${wid} was not written: a source did not finish reading it. What did arrive is kept, and the next run asks again.`);
      continue;
    }

    const weekEvents = ledger.eventsForWeek(wid);
    s.stop(`Fetched in ${formatDuration(fetchMs)} (${weekEvents.length} events this week)`);
    log(`Events in ${wid}: ${weekEvents.length}, added this run: ${[...collected.perSource.values()].reduce((sum, outcome) => sum + outcome.addedEvents, 0)}`);

    const markdown = generateEventMarkdown({
      weekInfo,
      events: weekEvents,
      snapshotFor: (source, itemId) => ledger.snapshot(source, itemId),
      additionalContext,
    });
    const workLogPath = `${paths.vault}/${weekInfo.filename}`;
    // Held in memory until the whole week validates. Writing it here would mean a --force
    // run destroyed the previous work log before the model had said anything usable.
    log(`Work log built: ${workLogPath} (${markdown.length} chars, not yet written)`);

    // A week that already has an entry is added to, never replaced — whatever brought us
    // here. `--force` means "generate this week again even though it was fetched", and
    // has never meant "throw away what the week already says about itself".
    const bragBookPath = `${paths.vault}/${wid} Brag Book.md`;
    const existingBragBook = existsSync(bragBookPath) ? await Bun.file(bragBookPath).text() : "";
    const amend = existingBragBook
      ? { existingBragBook, newMaterial: describeEvents(ledger.unwrittenEvents(wid)) }
      : undefined;
    if (amend) log(`${wid} already has a brag book; adding to it (${amend.newMaterial.split("\n").filter(Boolean).length} new event(s))`);

    const week = await generateWeek({ weekInfo, wid, workLog: markdown, workLogPath, config, paths, timeline, log, spinner: s, amend });
    // Immediately, and before anything else at all. The week is on disk, so it is no
    // longer owed a write; every statement between that write and this one is time in
    // which a crash would leave the week written and unmarked, and the next run would
    // send its events to the model a second time.
    ledger.markWritten(wid);
    await ledger.save();
    lastBragBookPath = week.bragBookPath;
    lastBragBookContent = week.bragBookContent;

    const weekTotal = Math.round(performance.now() - weekStart);
    p.log.success(`${wid} done in ${formatDuration(weekTotal)}`);

    timings.push({ weekId: wid, fetch: fetchMs, bragBook: week.bragBookMs, contextUpdates: week.contextUpdatesMs, total: weekTotal, ...week.cost });
    // Items touched this week, per source: the same shape the report always had, now
    // counted from the week's own events rather than from a fetch response.
    const itemsPerSource = (source: string) =>
      new Set(weekEvents.filter((event) => event.source === source).map((event) => event.itemId)).size;
    const reviewsThisWeek = weekEvents.filter((event) => event.source === "github" && event.kind === "review").length;

    results.push({ weekId: wid, jira: itemsPerSource("jira"), confluence: itemsPerSource("confluence"), prs: itemsPerSource("github"), reviews: reviewsThisWeek, memoryAdded: week.memoryAdded, memoryRemoved: week.memoryRemoved, impactLog: week.impactLogged, workContextUpdates: week.workContextUpdates, profileUpdated: week.profileUpdated, focusItems: week.focusItems, focusUpdates: week.focusUpdates });

    progress.completedWeeks.push(wid);
    await saveProgress(progress);
  }

  await appendStats(timings.map((t, i) => ({ weekId: t.weekId, date: new Date().toISOString(), fetch: t.fetch, bragBook: t.bragBook, contextUpdates: t.contextUpdates, total: t.total, counts: { jira: results[i].jira, confluence: results[i].confluence, prs: results[i].prs, reviews: results[i].reviews }, tokens: t.tokens, estimatedCostUsd: t.estimatedCostUsd, model: t.model })));
  await clearProgress();
  await printReport(timings, results);

  if (lastBragBookPath) {
    p.log.info(`Brag book: ${lastBragBookPath}`);
    const coachStart = lastBragBookContent.indexOf("<!-- COACHING_SESSION -->");
    const coachEnd = lastBragBookContent.indexOf("<!-- /COACHING_SESSION -->");
    if (coachStart !== -1 && coachEnd !== -1) {
      p.note(lastBragBookContent.substring(coachStart + "<!-- COACHING_SESSION -->".length, coachEnd).trim(), "Coaching Notes");
    }
  }

  p.outro("Done!");
}

// --- Commander command definition ---

export function makeWorklogCommand(): Command {
  const cmd = new Command("generate")
    .description("Generate weekly brag book(s)")
    .option("--weeks <n>", "Number of weeks to generate going back from now", (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) throw new Error("--weeks must be a positive number");
      return n;
    })
    // The same two checks `worklog refresh` makes. Generating the wrong week is the
    // same mistake whichever command was asked for it.
    .option("--week <YYYY-WNN>", "Generate a specific week (e.g. 2026-W06)", parseWeek)
    .option("--since <YYYY-MM-DD>", "Generate weeks from this date to now", parseSince)
    .option("--prompt <text>", "Shared context applied to all weeks")
    .option("--context-file <path>", "JSON file mapping week IDs to per-week context", (v) => {
      if (!existsSync(v)) throw new Error(`Context file not found: ${v}`);
      return v;
    })
    .option("--force", "Regenerate weeks even if brag book already exists", false)
    .option("--no-prompt", "Skip per-week additional context prompts")
    .option("-v, --verbose", "Show detailed logs", false)
    .addHelpText("after", `
Examples:
  worklog                    Fill gaps from earliest existing brag book
  worklog --weeks 4          Last 4 weeks
  worklog --week 2026-W07    Specific week
  worklog --force            Regenerate even if exists
  worklog --since 2025-01-01 From date to now`);

  cmd.action(async (opts) => {
    const { weeks, week, since, force, verbose, contextFile } = opts;

    if ([weeks, week, since].filter((v) => v !== undefined).length > 1) {
      cmd.error("--weeks, --week, and --since are mutually exclusive");
    }

    // commander parses --no-prompt as opts.prompt === false (boolean negation of --prompt)
    const noPrompt = opts.prompt === false;
    const sharedPrompt = typeof opts.prompt === "string" ? opts.prompt : undefined;

    await runWorklog({ weeks, week, since, noPrompt, force, verbose, prompt: sharedPrompt, contextFile });
  });

  return cmd;
}
