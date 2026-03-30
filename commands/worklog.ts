import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Command } from "commander";
import * as p from "@clack/prompts";
import { requireConfig, STATS_PATH, TEAM_TIMELINE_PATH } from "../lib/config";
import { aiQuery } from "../lib/sdk/ai";
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
  getBragBooks,
  readTeamTimeline,
  getTeamForDate,
  formatTeamTimelineForPrompt,
  getCurrentTeam,
  discoverWeeklyNotes,
  type TeamTimeline,
} from "../lib/sdk/vault";
import {
  getWeekNumber,
  weekId,
  getWeekStart,
  getWeekEnd,
  formatDuration,
} from "../lib/sdk/week-utils";
import {
  buildHeaders,
  getAccountId,
  getGitHubUsername,
  fetchDataForWeek,
  type WeekInfo,
} from "../lib/sdk/data-fetch";
import { generateMarkdown } from "../lib/sdk/markdown";
import {
  parseBragBookResult,
  getPendingFocusItems,
  parseReviewCycle,
} from "../lib/sdk/brag-book";
import {
  updateMemory,
  updateImpactLog,
  updateWorkContext,
  updateProfile,
  updateFocusTracking,
} from "../lib/sdk/vault-updates";
import { createLogger } from "../lib/sdk/logger";

// --- Stats ---

interface TimingRecord {
  weekId: string;
  date: string;
  fetch: number;
  bragBook: number;
  contextUpdates: number;
  total: number;
  counts: { jira: number; confluence: number; prs: number; reviews: number };
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
    return `${r.weekId.padEnd(10)} | ${pad(r.jira, 4)} | ${pad(r.confluence, 4)} | ${pad(r.prs, 3)} | ${pad(r.reviews, 7)} | ${formatDuration(t.total)}`;
  });

  const totalJira = results.reduce((s, r) => s + r.jira, 0);
  const totalConf = results.reduce((s, r) => s + r.confluence, 0);
  const totalPrs = results.reduce((s, r) => s + r.prs, 0);
  const totalRevs = results.reduce((s, r) => s + r.reviews, 0);

  const lines = [
    `Week       | Jira | Conf | PRs | Reviews | Time`,
    `───────────┼──────┼──────┼─────┼─────────┼────────`,
    ...rows,
    `───────────┼──────┼──────┼─────┼─────────┼────────`,
    `Total      | ${pad(totalJira, 4)} | ${pad(totalConf, 4)} | ${pad(totalPrs, 3)} | ${pad(totalRevs, 7)} | ${formatDuration(totalTime)}`,
    ``,
    `Context updates: ${results.reduce((s, r) => s + r.memoryAdded + r.memoryRemoved, 0)} memory, ${results.filter((r) => r.impactLog).length} impact log, ${results.reduce((s, r) => s + r.workContextUpdates, 0)} work context, ${results.filter((r) => r.profileUpdated).length} profile, ${results.reduce((s, r) => s + r.focusItems + r.focusUpdates, 0)} focus`,
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

function getEnvTokens(): { apiToken: string; githubToken: string } {
  const apiToken = process.env.ATLASSIAN_API_TOKEN;
  if (!apiToken) {
    p.log.error("ATLASSIAN_API_TOKEN not set. Run `worklog init` to set up credentials.\nOr generate manually at: https://id.atlassian.com/manage-profile/security/api-tokens");
    process.exit(1);
  }
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    p.log.error("GITHUB_TOKEN not set. Run `worklog init` to set up credentials.\nOr generate manually at: https://github.com/settings/tokens");
    process.exit(1);
  }
  return { apiToken, githubToken };
}

// --- Brag book prompt builder ---

const PROMPT_TEMPLATE_PATH = new URL("../prompts/weekly-brag-prompt.md", import.meta.url).pathname;

async function buildBragBookPrompt(
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
  pendingFocusItems: Array<{ week: string; item: string }>,
  reviewInfo: ReturnType<typeof parseReviewCycle>,
  timeline: TeamTimeline,
  weekInfo: WeekInfo | undefined,
  provider: string,
  config: Parameters<typeof buildConfigContext>[0],
): Promise<string> {
  const rawPromptTemplate = await Bun.file(PROMPT_TEMPLATE_PATH).text();
  const teamForWeek = weekInfo ? getTeamForDate(timeline, weekInfo.startDate) : getCurrentTeam(timeline);
  const currentTeamLabel = teamForWeek?.team ?? "Unknown Team";
  const currentRole = `${config.profile.jobTitle} / ${config.profile.level} (${config.profile.company} - ${currentTeamLabel})`;

  let promptTemplate = fillTemplate(rawPromptTemplate, {
    ...buildConfigContext(config),
    current_team: currentTeamLabel,
    current_role: currentRole,
  });

  if (provider === "openai") {
    promptTemplate = promptTemplate.replace(
      /<available_research_tools>[\s\S]*?<\/available_research_tools>/,
      `<available_research_tools>
You have tool-calling access to research the engineer's work. Use these tools proactively to write richer, more insightful brag book entries and coaching notes.

Available tools:
- fetchJiraTicket({ ticketKey }) — Fetch full details of a Jira ticket (e.g. "TEAM-1234")
- fetchConfluencePage({ pageIdOrUrl }) — Fetch a Confluence page by ID or URL
- searchConfluence({ query }) — Search Confluence for pages matching a query
- searchJira({ query }) — Search Jira for tickets matching a query
- readVaultNote({ noteName }) — Read a vault note by name (without .md extension)
- searchVault({ keyword }) — Search the vault for markdown files containing a keyword

IMPORTANT — proactive research expectations:
1. When vault_research_notes excerpts are provided, use readVaultNote to read the FULL notes for any that relate to this week's key work themes, coaching, or focus areas. Excerpts are truncated — the full notes contain context you need.
2. Use searchVault with keywords related to this week's major themes (project names, technologies, team names) to find notes the engineer wrote that weren't auto-discovered.
3. Use fetchJiraTicket for the most significant tickets this week — especially P0/P1 focus items and anything mentioned in coaching.
4. When Confluence pages appear in the work log, use fetchConfluencePage to understand what the engineer contributed.
5. Your coaching and brag book quality directly depends on how well you understand the engineer's actual work — surface-level summaries from ticket titles are not enough.

CRITICAL — ticket status freshness:
6. ALWAYS use fetchJiraTicket to get the latest status before writing about ANY ticket in the brag book or coaching notes. The work log snapshot may be stale — tickets change status after the data was fetched.
7. Check ticket comments — they often contain important context: decisions made, blockers raised, scope changes, reviewer feedback, or follow-up actions that the ticket title/description alone won't capture.
8. If a ticket's current status contradicts what the work log shows (e.g., work log says "In Progress" but ticket is now "Done" or "Won't Do"), use the CURRENT status and adjust your narrative accordingly.
9. Do NOT describe a ticket as "in progress" or "blocked" if it has since been resolved. Do NOT claim completion if the ticket was reopened or reverted.
</available_research_tools>`
    );
  }

  const vaultNotesSection = vaultNotes.length > 0
    ? `\n---\n\n<vault_research_notes>\nThese are work-related notes from the engineer's vault that were created or updated this week.\nThey provide additional context about research, meetings, and work that may not appear in Jira/GitHub/Confluence.\n\n${vaultNotes.map((n) => `### ${n.title}\n${n.excerpt}`).join("\n\n")}\n</vault_research_notes>`
    : "";

  const reviewProximitySection = reviewInfo
    ? `\n---\n\n<review_proximity>\n  <next_review>${reviewInfo.nextReview}</next_review>\n  <date>${reviewInfo.date}</date>\n  <weeks_remaining>${reviewInfo.weeksRemaining}</weeks_remaining>\n  <urgency>${reviewInfo.urgency}</urgency>\n</review_proximity>`
    : "";

  const pendingFocusSection = pendingFocusItems.length > 0
    ? `\n---\n\n<pending_focus_items>\nReview these items from previous weeks. Check if this week's work addresses them.\nMark as completed/ongoing/dropped in your FOCUS_UPDATE section.\n\n${pendingFocusItems.map((f) => `  - Week ${f.week}: ${f.item}`).join("\n")}\n</pending_focus_items>`
    : "";

  const generationContext = (() => {
    if (!weekInfo) return "";
    const teamEntry = getTeamForDate(timeline, weekInfo.startDate);
    const teamLabel = teamEntry ? `${teamEntry.team}${teamEntry.domain ? ` (${teamEntry.domain})` : ""}` : "Unknown";
    return `\n<generation_context>\nIMPORTANT: You are generating a brag book for **Week ${weekInfo.weekNumber}, ${weekInfo.year}** (${weekInfo.startDate.toISOString().split("T")[0]} to ${weekInfo.endDate.toISOString().split("T")[0]}).\n\nThis may be a historical regeneration. The work log data below is from that specific time period — it is NOT broken tooling. The tickets, PRs, and pages shown are the engineer's actual work from that week.\n\nTeam assignment at that time: ${teamLabel}${teamEntry?.notes ? `\nNote: ${teamEntry.notes}` : ""}\n\nFull team timeline:\n${formatTeamTimelineForPrompt(timeline)}\n\nDo NOT reference the current date, current team assignment, or any context files that reflect a different time period. Generate the brag book AS IF you are writing it during that week.\n</generation_context>\n`;
  })();

  return `${promptTemplate}

---

<coach_persona>
${coachPersona}
</coach_persona>

---

<engineer_profile>
${profileContent}
</engineer_profile>

---

<work_context>
${workContextContent}
</work_context>

---

<impact_log>
${impactLogContent}
</impact_log>

---

<current_memory>
${memoryContent}
</current_memory>

---

<previous_brag_books>
${previousBragBooks}
</previous_brag_books>

---

<focus_doc>
${focusDocContent}
</focus_doc>

---

<focus_history>
${focusHistoryContent}
</focus_history>

---

<career_context>
${careerContext}
</career_context>
${reviewProximitySection}
${pendingFocusSection}
${vaultNotesSection}
---
${generationContext}
<this_weeks_work_log>
${workLogContent}
</this_weeks_work_log>

---

Write the brag book entry as markdown. Output ONLY the markdown content, no explanations.`;
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
  const timeline = readTeamTimeline(paths);

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

  s.start("Getting account IDs...");
  log("Authenticating with Atlassian and GitHub...");
  const [accountId, githubUsername] = await Promise.all([
    getAccountId(config, headers),
    getGitHubUsername(headers),
  ]);
  s.stop("Account IDs ready");
  log(`Atlassian accountId: ${accountId}, GitHub username: ${githubUsername}`);

  const provider = config.ai.provider ?? "openai";
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

    // Fetch
    const fetchStart = performance.now();
    s.start("Fetching data...");
    const { issues, pages, prs, reviews, teamSprintItems } = await fetchDataForWeek(config, headers, accountId, githubUsername, weekInfo);
    const fetchMs = Math.round(performance.now() - fetchStart);
    s.stop(`Fetched in ${formatDuration(fetchMs)} (${issues.length} jira, ${pages.length} confluence, ${prs.length} PRs, ${reviews.length} reviews)`);
    log(`Jira: ${issues.length}, Confluence: ${pages.length}, PRs: ${prs.length}, Reviews: ${reviews.length}`);

    const markdown = generateMarkdown(issues, pages, prs, reviews, teamSprintItems, weekInfo, additionalContext, config);
    const workLogPath = `${paths.vault}/${weekInfo.filename}`;
    await Bun.write(workLogPath, markdown);
    log(`Work log written: ${workLogPath} (${markdown.length} chars)`);

    // Load vault context
    log("Loading vault context files...");
    const [memoryContent, profileContent, workContextContent, impactLogContent, coachPersona, focusTrackingContent, focusDocContent, focusHistoryContent, careerContext, previousBragBooks] = await Promise.all([
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
    log(`Vault files loaded — memory: ${memoryContent.length} chars, profile: ${profileContent.length} chars`);

    const vaultNotes = await discoverWeeklyNotes(config, paths, weekInfo.startDate, weekInfo.endDate);
    log(`Discovered ${vaultNotes.length} weekly vault notes`);

    const pendingFocusItems = getPendingFocusItems(focusTrackingContent);
    const reviewInfo = parseReviewCycle(workContextContent);
    log(`Pending focus items: ${pendingFocusItems.length}`);
    if (reviewInfo) log(`Review cycle: ${reviewInfo.urgency} — ${reviewInfo.nextReview} in ${reviewInfo.weeksRemaining} weeks`);

    // Generate brag book
    const bragStart = performance.now();
    s.start("Generating brag book...");

    const fullPrompt = await buildBragBookPrompt(
      markdown, previousBragBooks, workContextContent, memoryContent, profileContent,
      impactLogContent, coachPersona, focusDocContent, focusHistoryContent,
      careerContext, vaultNotes, pendingFocusItems, reviewInfo, timeline, weekInfo, provider, config
    );
    log(`AI query — provider: ${provider}, model: ${config.ai.model ?? "default"}, prompt: ${fullPrompt.length} chars`);

    const rawResult = await aiQuery({ prompt: fullPrompt, config, log });
    log(`AI response: ${rawResult.length} chars`);

    const { bragBookContent, itemsToAdd, itemsToRemove, impactLogEntry, workContextUpdates, profileUpdate, focusItems, focusUpdates } = parseBragBookResult(rawResult);
    const bragMs = Math.round(performance.now() - bragStart);
    s.stop(`Brag book generated in ${formatDuration(bragMs)}`);

    const bragBookPath = `${paths.vault}/${wid} Brag Book.md`;
    await Bun.write(bragBookPath, bragBookContent);
    log(`Brag book written: ${bragBookPath} (${bragBookContent.length} chars)`);
    lastBragBookPath = bragBookPath;
    lastBragBookContent = bragBookContent;

    // Context updates
    const ctxStart = performance.now();
    s.start("Updating context...");
    log(`Context updates — memory: +${itemsToAdd.length}/-${itemsToRemove.length}, impact: ${impactLogEntry ? "yes" : "no"}, workContext: ${workContextUpdates.length}, profile: ${profileUpdate ? "yes" : "no"}, focus: ${focusItems.length}/${focusUpdates.length}`);

    if (itemsToAdd.length > 0 || itemsToRemove.length > 0) await updateMemory(paths.memory, itemsToAdd, itemsToRemove);
    if (impactLogEntry) await updateImpactLog(paths.impactLog, impactLogEntry);
    if (workContextUpdates.length > 0) await updateWorkContext(paths.workContext, workContextUpdates);
    if (profileUpdate) await updateProfile(paths.profile, profileUpdate);
    if (focusItems.length > 0 || focusUpdates.length > 0) {
      const weekLabel = `${weekInfo.year}-W${String(weekInfo.weekNumber).padStart(2, "0")}`;
      await updateFocusTracking(paths.focusTracking, focusItems, focusUpdates, weekLabel);
    }

    const ctxMs = Math.round(performance.now() - ctxStart);
    s.stop(`Context updated in ${formatDuration(ctxMs)}`);

    const weekTotal = Math.round(performance.now() - weekStart);
    p.log.success(`${wid} done in ${formatDuration(weekTotal)}`);

    timings.push({ weekId: wid, fetch: fetchMs, bragBook: bragMs, contextUpdates: ctxMs, total: weekTotal });
    results.push({ weekId: wid, jira: issues.length, confluence: pages.length, prs: prs.length, reviews: reviews.length, memoryAdded: itemsToAdd.length, memoryRemoved: itemsToRemove.length, impactLog: !!impactLogEntry, workContextUpdates: workContextUpdates.length, profileUpdated: !!profileUpdate, focusItems: focusItems.length, focusUpdates: focusUpdates.length });

    progress.completedWeeks.push(wid);
    await saveProgress(progress);
  }

  await appendStats(timings.map((t, i) => ({ weekId: t.weekId, date: new Date().toISOString(), fetch: t.fetch, bragBook: t.bragBook, contextUpdates: t.contextUpdates, total: t.total, counts: { jira: results[i].jira, confluence: results[i].confluence, prs: results[i].prs, reviews: results[i].reviews } })));
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
  const cmd = new Command()
    .description("Generate weekly brag book(s)")
    .option("--weeks <n>", "Number of weeks to generate going back from now", (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) throw new Error("--weeks must be a positive number");
      return n;
    })
    .option("--week <YYYY-WNN>", "Generate a specific week (e.g. 2026-W06)", (v) => {
      if (!/^\d{4}-W\d{1,2}$/.test(v)) throw new Error("--week must be in YYYY-WNN format (e.g. 2026-W06)");
      const weekNum = parseInt(v.split("-W")[1], 10);
      if (weekNum < 1 || weekNum > 53) throw new Error("--week number must be between 1 and 53");
      return v;
    })
    .option("--since <YYYY-MM-DD>", "Generate weeks from this date to now", (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) throw new Error("--since must be a valid YYYY-MM-DD date");
      return v;
    })
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
