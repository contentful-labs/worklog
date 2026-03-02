#!/usr/bin/env bun

import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { requireConfig, STATS_PATH } from "./lib/config";
import type { WorklogConfig } from "./lib/config";
import { aiQuery } from "./lib/ai";
import { fillTemplate, buildConfigContext } from "./lib/template";
import { runInit } from "./commands/init";
import { runConfigure } from "./commands/configure";

// --- Timing & Progress helpers ---

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

interface WeekTiming {
  weekId: string;
  fetch: number;
  bragBook: number;
  contextUpdates: number;
  total: number;
}

interface TimingRecord {
  weekId: string;
  date: string;
  fetch: number;
  bragBook: number;
  contextUpdates: number;
  total: number;
  counts: { jira: number; confluence: number; prs: number; reviews: number };
}

// STATS_PATH imported from config module

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
  if (existsSync(path)) {
    await unlink(path);
  }
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

  // Build per-week table
  const pad = (s: string | number, w: number) => String(s).padStart(w);
  const header = `Week       | Jira | Conf | PRs | Reviews | Time`;
  const sep =    `───────────┼──────┼──────┼─────┼─────────┼────────`;
  const rows = results.map((r, i) => {
    const t = timings[i];
    return `${r.weekId.padEnd(10)} | ${pad(r.jira, 4)} | ${pad(r.confluence, 4)} | ${pad(r.prs, 3)} | ${pad(r.reviews, 7)} | ${formatDuration(t.total)}`;
  });

  const totalJira = results.reduce((s, r) => s + r.jira, 0);
  const totalConf = results.reduce((s, r) => s + r.confluence, 0);
  const totalPrs = results.reduce((s, r) => s + r.prs, 0);
  const totalRevs = results.reduce((s, r) => s + r.reviews, 0);
  const totalRow = `Total      | ${pad(totalJira, 4)} | ${pad(totalConf, 4)} | ${pad(totalPrs, 3)} | ${pad(totalRevs, 7)} | ${formatDuration(totalTime)}`;

  const totalMemory = results.reduce((s, r) => s + r.memoryAdded + r.memoryRemoved, 0);
  const totalImpact = results.filter(r => r.impactLog).length;
  const totalWcUpdates = results.reduce((s, r) => s + r.workContextUpdates, 0);
  const totalProfile = results.filter(r => r.profileUpdated).length;
  const totalFocus = results.reduce((s, r) => s + r.focusItems + r.focusUpdates, 0);

  const lines = [
    header,
    sep,
    ...rows,
    sep,
    totalRow,
    ``,
    `Context updates: ${totalMemory} memory, ${totalImpact} impact log, ${totalWcUpdates} work context, ${totalProfile} profile, ${totalFocus} focus`,
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

  // Historical averages from persistent stats
  const stats = await loadStats();
  if (stats.length > 0) {
    const avgFetch = stats.reduce((s, r) => s + r.fetch, 0) / stats.length;
    const avgBrag = stats.reduce((s, r) => s + r.bragBook, 0) / stats.length;
    const avgCtx = stats.reduce((s, r) => s + r.contextUpdates, 0) / stats.length;
    lines.push(``);
    lines.push(`Historical avg: fetch ${formatDuration(Math.round(avgFetch))}, brag ${formatDuration(Math.round(avgBrag))}, ctx ${formatDuration(Math.round(avgCtx))} (from ${stats.length} runs)`);
  }

  p.note(lines.join("\n"), "Summary");
}
import {
  getVault,
  getMemoryPath,
  getProfilePath,
  getWorkContextPath,
  getImpactLogPath,
  getFocusTrackingPath,
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
  getWeekNumber as sharedGetWeekNumber,
  weekId as sharedWeekId,
  getTeamForDate,
  formatTeamTimelineForPrompt,
  getCurrentTeam,
} from "./lib/obsidian-readers";

// Resolve prompt template relative to this script, not hardcoded path
const PROMPT_TEMPLATE_PATH = new URL("./prompts/weekly-brag-prompt.md", import.meta.url).pathname;

const weekId = sharedWeekId;
const getWeekNumber = sharedGetWeekNumber;

// Get start of ISO week (Monday)
function getWeekStart(weekNumber: number, year: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
  const weekStart = new Date(firstMonday);
  weekStart.setUTCDate(firstMonday.getUTCDate() + (weekNumber - 1) * 7);
  return weekStart;
}

// Get end of ISO week (Sunday)
function getWeekEnd(weekNumber: number, year: number): Date {
  const start = getWeekStart(weekNumber, year);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return end;
}

interface WorklogArgs {
  weeksBack?: number;
  specificWeek?: string;
  sinceDate?: string;
  noPrompt: boolean;
  force: boolean;
  prompt?: string;
  contextFile?: string;
}

type WeekContextMap = Record<string, string>;

function parseWorklogArgs(): WorklogArgs {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    p.intro("worklog");
    p.note(
      `Usage: worklog [command] [options]\n\nSubcommands:\n  init              Guided first-run setup\n  configure [sect]  Update configuration (vault, ai, atlassian, github, profile, career, team-history, coaching)\n  config            Alias for configure\n\nOptions:\n  --weeks N         Generate missing weeks going back N weeks (default: gap-fill from earliest)\n  --week YYYY-WNN   Force-(re)generate a specific week (e.g. 2026-W06)\n  --since YYYY-MM-DD Generate weeks from this date to now (e.g. 2025-10-01)\n  --prompt "text"   Shared context applied to all weeks (e.g. "I was on-call this sprint")\n  --context-file P  JSON file mapping week IDs to per-week context (e.g. {"2025-W14": "on parental leave"})\n  --force           Regenerate weeks even if brag book already exists\n  --no-prompt       Skip per-week additional context prompts`,
      "Help"
    );
    process.exit(0);
  }

  let weeksBack: number | undefined;
  const weeksIdx = args.indexOf("--weeks");
  if (weeksIdx !== -1 && args[weeksIdx + 1]) {
    weeksBack = parseInt(args[weeksIdx + 1], 10);
    if (isNaN(weeksBack) || weeksBack < 1) {
      p.log.error("--weeks must be a positive number");
      process.exit(1);
    }
  }

  let specificWeek: string | undefined;
  const weekIdx = args.indexOf("--week");
  if (weekIdx !== -1 && args[weekIdx + 1]) {
    const val = args[weekIdx + 1];
    if (!/^\d{4}-W\d{1,2}$/.test(val)) {
      p.log.error("--week must be in YYYY-WNN format (e.g. 2026-W06)");
      process.exit(1);
    }
    const weekNum = parseInt(val.split("-W")[1], 10);
    if (weekNum < 1 || weekNum > 52) {
      p.log.error("--week number must be between 1 and 52");
      process.exit(1);
    }
    specificWeek = val;
  }

  let sinceDate: string | undefined;
  const sinceIdx = args.indexOf("--since");
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    const val = args[sinceIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(new Date(val).getTime())) {
      p.log.error("--since must be a valid YYYY-MM-DD date (e.g. 2025-10-01)");
      process.exit(1);
    }
    sinceDate = val;
  }

  const exclusiveFlags = [weeksBack !== undefined, specificWeek !== undefined, sinceDate !== undefined].filter(Boolean).length;
  if (exclusiveFlags > 1) {
    p.log.error("--weeks, --week, and --since are mutually exclusive");
    process.exit(1);
  }

  let prompt: string | undefined;
  const promptIdx = args.indexOf("--prompt");
  if (promptIdx !== -1 && args[promptIdx + 1]) {
    prompt = args[promptIdx + 1];
  }

  let contextFile: string | undefined;
  const ctxIdx = args.indexOf("--context-file");
  if (ctxIdx !== -1 && args[ctxIdx + 1]) {
    contextFile = args[ctxIdx + 1];
    if (!existsSync(contextFile)) {
      p.log.error(`Context file not found: ${contextFile}`);
      process.exit(1);
    }
  }

  const noPrompt = args.includes("--no-prompt");
  const force = args.includes("--force");

  return { weeksBack, specificWeek, sinceDate, noPrompt, force, prompt, contextFile };
}

interface WeekInfo {
  weekNumber: number;
  year: number;
  startDate: Date;
  endDate: Date;
  filename: string;
}

async function getWeeksToGenerate(weeksBack?: number, specificWeek?: string, force?: boolean, sinceDate?: string): Promise<WeekInfo[]> {
  if (specificWeek) {
    const [yearStr, weekStr] = specificWeek.split("-W");
    const year = parseInt(yearStr, 10);
    const weekNumber = parseInt(weekStr, 10);
    const wid = weekId(weekNumber, year);
    return [{
      weekNumber,
      year,
      startDate: getWeekStart(weekNumber, year),
      endDate: getWeekEnd(weekNumber, year),
      filename: `${wid} Work Log.md`,
    }];
  }

  const now = new Date();
  const currentWeek = getWeekNumber(now);
  const currentYear = now.getFullYear();

  // Scan vault root for existing YYYY-WXX Brag Book.md files
  const existingWeeks = new Set<string>();

  const files = await readdir(getVault());
  for (const file of files) {
    const match = file.match(/^(\d{4})-W(\d{2}) Brag Book\.md$/);
    if (match) {
      existingWeeks.add(weekId(parseInt(match[2], 10), parseInt(match[1], 10)));
    }
  }

  let startWeek: number;
  let startYear: number;

  if (sinceDate) {
    // --since YYYY-MM-DD: start from the ISO week containing that date
    const d = new Date(sinceDate + "T00:00:00Z");
    startWeek = getWeekNumber(d);
    const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
    startYear = utc.getUTCFullYear();
  } else if (weeksBack !== undefined) {
    // --weeks N: start N weeks ago from current week
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - weeksBack * 7);
    startWeek = getWeekNumber(startDate);
    // Use ISO week year for the start date
    const utc = new Date(Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()));
    const dayNum = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
    startYear = utc.getUTCFullYear();
  } else {
    // Default: find earliest existing week, or 8 weeks ago
    startWeek = currentWeek - 8;
    startYear = currentYear;
    if (startWeek < 1) {
      startYear--;
      startWeek = 52 + startWeek;
    }

    if (existingWeeks.size > 0) {
      const sorted = Array.from(existingWeeks).sort();
      const earliest = sorted[0];
      const match = earliest.match(/^(\d{4})-W(\d{2})$/);
      if (match) {
        startYear = parseInt(match[1], 10);
        startWeek = parseInt(match[2], 10);
      }
    }
  }

  // Generate list of missing weeks from start to current
  const weeks: WeekInfo[] = [];
  let week = startWeek;
  let year = startYear;

  while (year < currentYear || (year === currentYear && week <= currentWeek)) {
    const wid = weekId(week, year);
    const isCurrentWeek = week === currentWeek && year === currentYear;
    if (!existingWeeks.has(wid) || isCurrentWeek || force) {
      weeks.push({
        weekNumber: week,
        year,
        startDate: getWeekStart(week, year),
        endDate: getWeekEnd(week, year),
        filename: `${wid} Work Log.md`,
      });
    }

    week++;
    if (week > 52) {
      week = 1;
      year++;
    }
  }

  return weeks;
}

let _weekContextMap: WeekContextMap | undefined;

function loadWeekContextMap(path: string): WeekContextMap {
  if (!_weekContextMap) {
    try {
      _weekContextMap = JSON.parse(require("fs").readFileSync(path, "utf-8"));
    } catch {
      _weekContextMap = {};
    }
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
  const result = await p.text({
    message: `Week ${weekNumber}, ${year} — additional context not in Jira/GitHub/Confluence?`,
    placeholder: "Press Enter to skip",
  });
  if (p.isCancel(result)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return (result || "").trim();
}

async function getPreviousBragBooks(currentWeek: number, currentYear: number): Promise<string> {
  const currentFilename = `${weekId(currentWeek, currentYear)} Brag Book.md`;
  return getBragBooks(2, currentFilename);
}

function getEnvTokens(): { apiToken: string; githubToken: string } {
  const apiToken = process.env.ATLASSIAN_API_TOKEN;
  if (!apiToken) {
    p.log.error(
      "ATLASSIAN_API_TOKEN not set. Run `worklog init` to set up credentials.\nOr generate manually at: https://id.atlassian.com/manage-profile/security/api-tokens"
    );
    process.exit(1);
  }
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    p.log.error(
      "GITHUB_TOKEN not set. Run `worklog init` to set up credentials.\nOr generate manually at: https://github.com/settings/tokens"
    );
    process.exit(1);
  }
  return { apiToken, githubToken };
}

function buildHeaders(config: WorklogConfig) {
  const { apiToken, githubToken } = getEnvTokens();

  const AUTH = Buffer.from(`${config.atlassian.email}:${apiToken}`).toString("base64");

  return {
    atlassian: {
      Authorization: `Basic ${AUTH}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    github: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
}

let _headers: ReturnType<typeof buildHeaders> | undefined;

function getHeaders(config: WorklogConfig) {
  if (!_headers) _headers = buildHeaders(config);
  return _headers;
}

async function getAccountId(config: WorklogConfig): Promise<string> {
  const { atlassian: headers } = getHeaders(config);
  const res = await fetch(`${config.atlassian.url}/rest/api/3/myself`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get accountId: ${res.status}`);
  }
  const data = await res.json();
  return data.accountId;
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    created: string;
    updated: string;
    resolutiondate?: string;
    description?: { content?: Array<{ content?: Array<{ text?: string }> }> };
    priority?: { name: string };
    labels?: string[];
    components?: Array<{ name: string }>;
    timetracking?: { timeSpent?: string };
    comment?: { comments?: Array<{ body?: { content?: Array<{ content?: Array<{ text?: string }> }> }; author?: { displayName?: string }; created?: string }> };
  };
}

type ConfluenceTag = "Created" | "Contributed" | "Commented" | "Draft";

interface ConfluencePage {
  id: string;
  title: string;
  status?: string;
  space?: { name: string; key: string };
  _links?: { webui?: string };
  history?: { createdDate?: string; lastUpdated?: { when?: string }; createdBy?: { accountId?: string } };
  _tags?: ConfluenceTag[];
}

interface ConfluenceComment {
  container?: {
    id: string;
    title: string;
    space?: { name: string; key: string };
    _links?: { webui?: string };
  };
}

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at?: string;
  closed_at?: string;
  html_url: string;
  repository_url: string;
}

async function getGitHubUsername(config: WorklogConfig): Promise<string> {
  const { github: githubHeaders } = getHeaders(config);
  const res = await fetch("https://api.github.com/user", { headers: githubHeaders });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.login;
}

function extractText(adfContent: JiraIssue["fields"]["description"]): string {
  if (!adfContent?.content) return "";

  const texts: string[] = [];
  for (const block of adfContent.content) {
    if (block.content) {
      for (const inline of block.content) {
        if (inline.text) texts.push(inline.text);
      }
    }
  }
  return texts.join(" ").slice(0, 300) + (texts.join(" ").length > 300 ? "..." : "");
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function generateMarkdown(
  issues: JiraIssue[],
  pages: ConfluencePage[],
  prs: GitHubPR[],
  reviews: PRReview[],
  teamSprintItems: JiraIssue[],
  weekInfo: WeekInfo,
  additionalContext: string,
  config: WorklogConfig
): string {
  const lines: string[] = [];
  const startDate = weekInfo.startDate.toISOString().split("T")[0];
  const endDate = weekInfo.endDate.toISOString().split("T")[0];

  lines.push("---");
  lines.push("tags:");
  lines.push("  - areas/work");
  lines.push("  - areas/work/work-log");
  lines.push("---");
  lines.push("");
  lines.push(`# Work Log - Week ${weekInfo.weekNumber}, ${weekInfo.year}`);
  lines.push("");
  lines.push(`**Period:** ${startDate} to ${endDate}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Jira Tasks | ${issues.length} |`);
  lines.push(`| Confluence Created | ${pages.filter(p => p._tags?.includes("Created")).length} |`);
  lines.push(`| Confluence Contributed | ${pages.filter(p => p._tags?.includes("Contributed")).length} |`);
  lines.push(`| Confluence Commented | ${pages.filter(p => p._tags?.includes("Commented")).length} |`);
  lines.push(`| Confluence Drafts | ${pages.filter(p => p._tags?.includes("Draft")).length} |`);
  lines.push(`| GitHub PRs Authored | ${prs.length} |`);
  lines.push(`| GitHub PRs Reviewed | ${reviews.length} |`);
  lines.push("");

  // Jira section
  if (issues.length > 0) {
    lines.push(`## Jira Tasks (${issues.length})`);
    lines.push("");

    for (const issue of issues) {
      const f = issue.fields;
      lines.push(`### [${issue.key}] ${f.summary}`);
      lines.push(`**Status:** ${f.status.name} | **Updated:** ${formatDate(f.updated)}`);

      const desc = extractText(f.description);
      if (desc) {
        lines.push(`> ${desc}`);
      }

      // Render user's own comments
      if (f.comment?.comments?.length) {
        const myComments = f.comment.comments.filter(
          (c) => c.author?.displayName === config.profile.displayName
        );
        if (myComments.length > 0) {
          lines.push(`**Your comments (${myComments.length}):**`);
          for (const c of myComments.slice(0, 3)) {
            const text = extractText(c.body);
            if (text) lines.push(`> ${text}`);
          }
        }
      }

      lines.push(`[View in Jira](${config.atlassian.url}/browse/${issue.key})`);
      lines.push("");
    }
  }

  // Confluence section
  if (pages.length > 0) {
    lines.push(`## Confluence Documents (${pages.length})`);
    lines.push("");

    for (const page of pages) {
      const tagStr = page._tags?.length ? ` [${page._tags.join(", ")}]` : "";
      lines.push(`### ${page.title}${tagStr}`);
      if (page.space) {
        lines.push(`**Space:** ${page.space.name}`);
      }
      lines.push(`**Last Updated:** ${formatDate(page.history?.lastUpdated?.when)}`);
      if (page._links?.webui) {
        lines.push(`[View in Confluence](${config.atlassian.url}/wiki${page._links.webui})`);
      }
      lines.push("");
    }
  }

  // GitHub PRs section
  if (prs.length > 0) {
    lines.push(`## GitHub Pull Requests (${prs.length})`);
    lines.push("");

    for (const pr of prs) {
      const repoName = pr.repository_url.split("/").slice(-2).join("/");
      const state = pr.merged_at ? "Merged" : pr.state === "closed" ? "Closed" : "Open";

      lines.push(`### [${repoName}#${pr.number}] ${pr.title}`);
      lines.push(`**Status:** ${state} | **Created:** ${formatDate(pr.created_at)}`);
      lines.push(`[View on GitHub](${pr.html_url})`);
      lines.push("");
    }
  }

  // GitHub Reviews section
  if (reviews.length > 0) {
    lines.push(`## GitHub Reviews (${reviews.length})`);
    lines.push("");

    for (const review of reviews) {
      lines.push(`### [${review.repo}#${review.pr_number}] ${review.pr_title}`);
      lines.push(`**Author:** ${review.pr_author} | **Verdict:** ${review.state} | **Comments:** ${review.comment_count}`);
      lines.push(`[View Review](${review.html_url})`);
      lines.push("");
    }
  }

  // Team sprint/backlog section (for focus context)
  if (teamSprintItems.length > 0) {
    lines.push(`## Team Sprint Items (${teamSprintItems.length})`);
    lines.push("");
    lines.push("*Items in the team's active sprint, not assigned to or reported by you. Use for focus/awareness context.*");
    lines.push("");

    for (const issue of teamSprintItems) {
      const f = issue.fields;
      const priority = f.priority?.name ? ` | **Priority:** ${f.priority.name}` : "";
      lines.push(`- **[${issue.key}]** ${f.summary} — ${f.status.name}${priority}`);
    }
    lines.push("");
  }

  // Additional context section
  if (additionalContext) {
    lines.push("## Additional Context");
    lines.push("");
    lines.push(additionalContext);
    lines.push("");
  }

  return lines.join("\n");
}

interface BragBookResult {
  bragBookContent: string;
  itemsToAdd: string[];
  itemsToRemove: string[];
  impactLogEntry: { date: string; achievement: string; scope: string; coreValue: string; evidence: string } | null;
  workContextUpdates: Array<{ category: string; info: string; source: string }>;
  profileUpdate: { achievement: string; bulletPoint: string } | null;
  focusItems: string[];
  focusUpdates: Array<{ week: string; item: string; status: string; notes: string }>;
}


function getPendingFocusItems(focusContent: string): Array<{ week: string; item: string }> {
  const lines = focusContent.split("\n");
  const pending: Array<{ week: string; item: string }> = [];

  for (const line of lines) {
    if (line.startsWith("|") && line.includes("pending")) {
      const parts = line.split("|").map(p => p.trim()).filter(Boolean);
      if (parts.length >= 3) {
        pending.push({ week: parts[0], item: parts[1] });
      }
    }
  }
  return pending;
}

interface ReviewInfo {
  nextReview: string;
  date: string;
  weeksRemaining: number;
  urgency: "normal" | "attention" | "urgent";
}

function parseReviewCycle(workContext: string): ReviewInfo | null {
  const reviewSectionMatch = workContext.match(/## Review Cycle[\s\S]*?(?=##|$)/);
  if (!reviewSectionMatch) return null;

  const section = reviewSectionMatch[0];
  const rows = section.split("\n").filter(line => line.startsWith("|") && !line.includes("---") && !line.includes("Review Type"));

  const today = new Date();
  let nearestReview: { type: string; date: Date } | null = null;

  for (const row of rows) {
    const parts = row.split("|").map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const reviewType = parts[0];
      const dateStr = parts[1];
      const reviewDate = new Date(dateStr);

      if (reviewDate > today) {
        if (!nearestReview || reviewDate < nearestReview.date) {
          nearestReview = { type: reviewType, date: reviewDate };
        }
      }
    }
  }

  if (!nearestReview) return null;

  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksRemaining = Math.ceil((nearestReview.date.getTime() - today.getTime()) / msPerWeek);

  let urgency: "normal" | "attention" | "urgent" = "normal";
  if (weeksRemaining < 4) urgency = "urgent";
  else if (weeksRemaining < 8) urgency = "attention";

  return {
    nextReview: nearestReview.type,
    date: nearestReview.date.toISOString().split("T")[0],
    weeksRemaining,
    urgency,
  };
}

async function generateBragBookEntry(
  workLogContent: string,
  previousBragBooks: string,
  weekInfo?: WeekInfo
): Promise<BragBookResult> {
  const config = requireConfig();
  const rawPromptTemplate = await Bun.file(PROMPT_TEMPLATE_PATH).text();
  // Resolve {{current_team}} — use week-specific team if generating for a specific week, else current
  const teamForWeek = weekInfo ? getTeamForDate(weekInfo.startDate) : getCurrentTeam();
  const currentTeamLabel = teamForWeek?.team ?? "Unknown Team";
  const currentRole = `${config.profile.jobTitle} / ${config.profile.level} (${config.profile.company} - ${currentTeamLabel})`;
  const promptTemplate = fillTemplate(rawPromptTemplate, {
    ...buildConfigContext(),
    current_team: currentTeamLabel,
    current_role: currentRole,
  });
  const memoryContent = await readMemory();
  const profileContent = await readProfile();
  const workContextContent = await readWorkContext();
  const impactLogContent = await readImpactLog();
  const coachPersona = await readCoachPersona();
  const focusTrackingContent = await readFocusTracking();
  const focusDocContent = await readFocusDoc();
  const focusHistoryContent = await readArchivedFocusDocs();
  const careerContext = await readCareerContext();

  const pendingFocusItems = getPendingFocusItems(focusTrackingContent);
  const reviewInfo = parseReviewCycle(workContextContent);

  let reviewProximitySection = "";
  if (reviewInfo) {
    reviewProximitySection = `
---

<review_proximity>
  <next_review>${reviewInfo.nextReview}</next_review>
  <date>${reviewInfo.date}</date>
  <weeks_remaining>${reviewInfo.weeksRemaining}</weeks_remaining>
  <urgency>${reviewInfo.urgency}</urgency>
</review_proximity>`;
  }

  let pendingFocusSection = "";
  if (pendingFocusItems.length > 0) {
    const items = pendingFocusItems.map(f => `  - Week ${f.week}: ${f.item}`).join("\n");
    pendingFocusSection = `
---

<pending_focus_items>
Review these items from previous weeks. Check if this week's work addresses them.
Mark as completed/ongoing/dropped in your FOCUS_UPDATE section.

${items}
</pending_focus_items>`;
  }

  const fullPrompt = `${promptTemplate}

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
---
${(() => {
  const teamEntry = weekInfo ? getTeamForDate(weekInfo.startDate) : undefined;
  const teamLabel = teamEntry
    ? `${teamEntry.team}${teamEntry.domain ? ` (${teamEntry.domain})` : ""}`
    : "Unknown";
  return weekInfo ? `
<generation_context>
IMPORTANT: You are generating a brag book for **Week ${weekInfo.weekNumber}, ${weekInfo.year}** (${weekInfo.startDate.toISOString().split("T")[0]} to ${weekInfo.endDate.toISOString().split("T")[0]}).

This may be a historical regeneration. The work log data below is from that specific time period — it is NOT broken tooling. The tickets, PRs, and pages shown are the engineer's actual work from that week.

Team assignment at that time: ${teamLabel}${teamEntry?.notes ? `\nNote: ${teamEntry.notes}` : ""}

Full team timeline:
${formatTeamTimelineForPrompt()}

Do NOT reference the current date, current team assignment, or any context files that reflect a different time period. Generate the brag book AS IF you are writing it during that week.
</generation_context>
` : "";
})()}
<this_weeks_work_log>
${workLogContent}
</this_weeks_work_log>

---

Write the brag book entry as markdown. Output ONLY the markdown content, no explanations.`;

  let result = await aiQuery({
    prompt: fullPrompt,
  });

  // Parse out the memory update section
  const memoryMarkerStart = "<!-- MEMORY_UPDATE -->";
  const memoryMarkerEnd = "<!-- /MEMORY_UPDATE -->";
  const contextMarkerStart = "<!-- CONTEXT_UPDATES -->";
  const contextMarkerEnd = "<!-- /CONTEXT_UPDATES -->";
  const coachingMarkerStart = "<!-- COACHING_SESSION -->";
  const coachingMarkerEnd = "<!-- /COACHING_SESSION -->";
  const focusMarkerStart = "<!-- FOCUS_UPDATE -->";
  const focusMarkerEnd = "<!-- /FOCUS_UPDATE -->";

  let bragBookContent = result;
  let itemsToAdd: string[] = [];
  let itemsToRemove: string[] = [];
  let impactLogEntry: BragBookResult["impactLogEntry"] = null;
  let workContextUpdates: BragBookResult["workContextUpdates"] = [];
  let profileUpdate: BragBookResult["profileUpdate"] = null;
  let focusItems: string[] = [];
  let focusUpdates: BragBookResult["focusUpdates"] = [];

  const memoryStartIdx = result.indexOf(memoryMarkerStart);
  const memoryEndIdx = result.indexOf(memoryMarkerEnd);

  if (memoryStartIdx !== -1 && memoryEndIdx !== -1) {
    // Strip machine-parseable sections, keep COACHING_SESSION for human reading
    bragBookContent = result
      // Remove MEMORY_UPDATE section
      .replace(new RegExp(`\\n---\\s*\\n${memoryMarkerStart}[\\s\\S]*?${memoryMarkerEnd}`, "g"), "")
      // Remove FOCUS_UPDATE section
      .replace(new RegExp(`\\n---\\s*\\n${focusMarkerStart}[\\s\\S]*?${focusMarkerEnd}`, "g"), "")
      // Remove CONTEXT_UPDATES section
      .replace(new RegExp(`\\n---\\s*\\n${contextMarkerStart}[\\s\\S]*?${contextMarkerEnd}`, "g"), "")
      // Clean up any trailing separators
      .replace(/(\n---\s*)+$/, "")
      .trim();

    // Extract memory update section
    const memorySection = result.substring(memoryStartIdx + memoryMarkerStart.length, memoryEndIdx);

    // Parse items to add (look for table rows after "Items to Add to Memory/[[memory]]")
    const addMatch = memorySection.match(/## Items to Add to (?:Memory|\[\[memory\]\])[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=##|$)/);
    if (addMatch) {
      const tableRows = addMatch[1].trim().split("\n").filter(row => row.startsWith("|"));
      itemsToAdd = tableRows.map(row => row.trim());
    }

    // Parse items to remove (look for list items after "Items to Remove from Memory/[[memory]]")
    const removeMatch = memorySection.match(/## Items to Remove from (?:Memory|\[\[memory\]\])[\s\S]*?\n([\s\S]*?)$/);
    if (removeMatch) {
      const listItems = removeMatch[1].trim().split("\n").filter(line => line.startsWith("-"));
      itemsToRemove = listItems.map(item => item.replace(/^-\s*/, "").trim());
    }
  }

  // Parse CONTEXT_UPDATES section
  const contextStartIdx = result.indexOf(contextMarkerStart);
  const contextEndIdx = result.indexOf(contextMarkerEnd);

  if (contextStartIdx !== -1 && contextEndIdx !== -1) {
    const contextSection = result.substring(contextStartIdx + contextMarkerStart.length, contextEndIdx);

    // Parse Impact Log Update table
    const impactMatch = contextSection.match(/## (?:\[\[impact-log\]\]|Impact Log) Update[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=##|$)/);
    if (impactMatch) {
      const rows = impactMatch[1].trim().split("\n").filter(row => row.startsWith("|") && !row.includes("---"));
      for (const row of rows) {
        const parts = row.split("|").map(p => p.trim()).filter(Boolean);
        if (parts.length >= 5 && parts[0] && parts[1]) {
          impactLogEntry = {
            date: parts[0],
            achievement: parts[1],
            scope: parts[2] || "",
            coreValue: parts[3] || "",
            evidence: parts[4] || "",
          };
          break; // Only take first entry
        }
      }
    }

    // Parse Work Context Updates table
    const workContextMatch = contextSection.match(/## (?:\[\[work-context\]\]|Work Context) Updates[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=##|$)/);
    if (workContextMatch) {
      const rows = workContextMatch[1].trim().split("\n").filter(row => row.startsWith("|") && !row.includes("---"));
      for (const row of rows) {
        const parts = row.split("|").map(p => p.trim()).filter(Boolean);
        if (parts.length >= 3 && parts[0] && parts[1]) {
          workContextUpdates.push({
            category: parts[0],
            info: parts[1],
            source: parts[2] || "",
          });
        }
      }
    }

    // Parse Profile Updates
    const achievementMatch = contextSection.match(/\*\*Achievement to add:\*\*\s*(.+)/);
    const bulletMatch = contextSection.match(/\*\*Suggested bullet point:\*\*\s*(.+)/);
    if (achievementMatch && bulletMatch && achievementMatch[1].trim() && bulletMatch[1].trim()) {
      const achievement = achievementMatch[1].trim();
      const bulletPoint = bulletMatch[1].trim();
      if (achievement && achievement !== "(leave blank if none - bar is CV-worthy)" && bulletPoint && bulletPoint !== "(leave blank if none)") {
        profileUpdate = { achievement, bulletPoint };
      }
    }
  }

  // Parse COACHING_SESSION for focus items
  const coachingStartIdx = result.indexOf(coachingMarkerStart);
  const coachingEndIdx = result.indexOf(coachingMarkerEnd);

  if (coachingStartIdx !== -1 && coachingEndIdx !== -1) {
    const coachingSection = result.substring(coachingStartIdx + coachingMarkerStart.length, coachingEndIdx);

    // Extract "Focus for Next Week" items
    const focusMatch = coachingSection.match(/### Focus for Next Week[\s\S]*?(?=###|$)/);
    if (focusMatch) {
      const focusLines = focusMatch[0].split("\n").filter(line => line.match(/^[\-\d]/));
      focusItems = focusLines.map(line => line.replace(/^[\-\d\.\)]\s*/, "").trim()).filter(Boolean);
    }
  }

  // Parse FOCUS_UPDATE section (for status updates on previous items)
  const focusStartIdx = result.indexOf(focusMarkerStart);
  const focusEndIdx = result.indexOf(focusMarkerEnd);

  if (focusStartIdx !== -1 && focusEndIdx !== -1) {
    const focusSection = result.substring(focusStartIdx + focusMarkerStart.length, focusEndIdx);

    // Parse Focus Items Status table
    const statusMatch = focusSection.match(/## (?:\[\[focus-tracking\]\]|Focus Items) Status[\s\S]*?\|[-\s|]+\|([\s\S]*?)(?=##|$)/);
    if (statusMatch) {
      const rows = statusMatch[1].trim().split("\n").filter(row => row.startsWith("|") && !row.includes("---"));
      for (const row of rows) {
        const parts = row.split("|").map(p => p.trim()).filter(Boolean);
        if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
          focusUpdates.push({
            week: parts[0],
            item: parts[1],
            status: parts[2],
            notes: parts[3] || "",
          });
        }
      }
    }

    // Parse New Focus Items
    const newFocusMatch = focusSection.match(/## New Focus Items[\s\S]*?$/);
    if (newFocusMatch) {
      const newFocusLines = newFocusMatch[0].split("\n").filter(line => line.startsWith("-"));
      const newItems = newFocusLines.map(line => line.replace(/^-\s*/, "").trim()).filter(Boolean);
      focusItems = [...focusItems, ...newItems];
    }
  }

  return { bragBookContent, itemsToAdd, itemsToRemove, impactLogEntry, workContextUpdates, profileUpdate, focusItems, focusUpdates };
}

async function updateImpactLog(entry: BragBookResult["impactLogEntry"]): Promise<void> {
  if (!entry) return;

  let content = await Bun.file(getImpactLogPath()).text();

  // Find the table in Impact Timeline section and append row
  const tableMatch = content.match(/## Impact Timeline[\s\S]*?\|[-\s|]+\|/);
  if (tableMatch) {
    const insertPoint = content.indexOf(tableMatch[0]) + tableMatch[0].length;
    const newRow = `\n| ${entry.date} | ${entry.achievement} | ${entry.scope} | ${entry.coreValue} | ${entry.evidence} |`;
    content = content.slice(0, insertPoint) + newRow + content.slice(insertPoint);
  }

  // Update gap analysis
  content = content.replace(/\*\*Last significant impact:\*\*.*/, `**Last significant impact:** ${entry.date}`);
  content = content.replace(/\*\*Current gap:\*\*.*/, `**Current gap:** None - recent entry added`);

  await Bun.write(getImpactLogPath(), content);
}

async function updateWorkContext(updates: BragBookResult["workContextUpdates"]): Promise<void> {
  if (updates.length === 0) return;

  let content = await Bun.file(getWorkContextPath()).text();

  // Find Organizational Notes section and add entries
  const orgNotesIdx = content.indexOf("## Organizational Notes");
  if (orgNotesIdx !== -1) {
    const insertPoint = content.indexOf("\n", orgNotesIdx + 25) + 1;
    const newEntries = updates.map(u => `- **${u.category}:** ${u.info} _(${u.source})_`).join("\n");
    content = content.slice(0, insertPoint) + "\n" + newEntries + "\n" + content.slice(insertPoint);
  }

  // Update timestamp
  content = content.replace(/\*Last updated:.*\*/, `*Last updated: ${new Date().toISOString().split("T")[0]}*`);

  await Bun.write(getWorkContextPath(), content);
}

async function updateProfile(update: BragBookResult["profileUpdate"]): Promise<void> {
  if (!update) return;

  let content = await Bun.file(getProfilePath()).text();

  // Find Key Strengths section and add achievement
  const strengthsIdx = content.indexOf("## Key Strengths");
  if (strengthsIdx !== -1) {
    const nextSectionIdx = content.indexOf("\n##", strengthsIdx + 1);
    const insertPoint = nextSectionIdx !== -1 ? nextSectionIdx : content.length;
    const newEntry = `- ${update.bulletPoint}\n`;
    content = content.slice(0, insertPoint) + newEntry + content.slice(insertPoint);
  }

  await Bun.write(getProfilePath(), content);
}

async function updateFocusTracking(
  focusItems: string[],
  focusUpdates: BragBookResult["focusUpdates"],
  weekInfo: WeekInfo
): Promise<void> {
  let content: string;
  const weekLabel = `${weekInfo.year}-W${String(weekInfo.weekNumber).padStart(2, "0")}`;

  if (existsSync(getFocusTrackingPath())) {
    content = await Bun.file(getFocusTrackingPath()).text();
  } else {
    content = `# Focus Tracking

Tracks focus items from coaching sessions. Pending items are reviewed in subsequent weeks.

| Week | Focus Item | Status | Notes |
|------|------------|--------|-------|
`;
  }

  // Update status of existing items
  for (const update of focusUpdates) {
    const escapedItem = update.item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\|\\s*${update.week}\\s*\\|\\s*${escapedItem}\\s*\\|\\s*pending\\s*\\|`, "i");
    content = content.replace(regex, `| ${update.week} | ${update.item} | ${update.status} | ${update.notes} |`);
  }

  // Add new focus items
  for (const item of focusItems) {
    if (item && !content.includes(item)) {
      content = content.trimEnd() + `\n| ${weekLabel} | ${item} | pending | |`;
    }
  }

  await Bun.write(getFocusTrackingPath(), content);
}

async function updateMemory(itemsToAdd: string[], itemsToRemove: string[]): Promise<void> {
  let memoryContent: string;

  if (existsSync(getMemoryPath())) {
    memoryContent = await Bun.file(getMemoryPath()).text();
  } else {
    memoryContent = `# Memory - Small Contributions Awaiting Significance

Contributions here are waiting to accumulate into something brag-worthy.

| Date | Item | Category | Notes |
|------|------|----------|-------|
`;
  }

  // Remove graduated items
  for (const item of itemsToRemove) {
    // Try to find and remove lines containing the item description
    const lines = memoryContent.split("\n");
    memoryContent = lines.filter(line => !line.includes(item.split("(now part of")[0].trim())).join("\n");
  }

  // Add new items (append to table)
  if (itemsToAdd.length > 0) {
    // Find the table and append rows
    const tableEndRegex = /(\|.*\|)\s*$/;
    for (const row of itemsToAdd) {
      if (row.includes("|")) {
        memoryContent = memoryContent.trimEnd() + "\n" + row;
      }
    }
  }

  await Bun.write(getMemoryPath(), memoryContent);
}

interface PRReview {
  pr_number: number;
  pr_title: string;
  pr_author: string;
  repo: string;
  state: string;
  submitted_at: string;
  comment_count: number;
  html_url: string;
  pr_html_url: string;
}

async function searchConfluence(config: WorklogConfig, cql: string, expand: string, status?: string): Promise<Record<string, any>[]> {
  const { atlassian: headers } = getHeaders(config);
  const results: Record<string, any>[] = [];
  let start = 0;
  while (true) {
    let url = `${config.atlassian.url}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=${encodeURIComponent(expand)}&start=${start}&limit=50`;
    if (status) url += `&status=${status}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Confluence API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    results.push(...(data.results || []));
    if (!data._links?.next) break;
    start += 50;
  }
  return results;
}

async function fetchDataForWeek(
  accountId: string,
  githubUsername: string,
  weekInfo: WeekInfo,
  config: WorklogConfig
): Promise<{ issues: JiraIssue[]; pages: ConfluencePage[]; prs: GitHubPR[]; reviews: PRReview[]; teamSprintItems: JiraIssue[] }> {
  const startDate = weekInfo.startDate.toISOString().split("T")[0];
  const endDate = weekInfo.endDate.toISOString().split("T")[0];

  const email = config.atlassian.email;
  const { atlassian: headers, github: githubHeaders } = getHeaders(config);

  const jql = `(assignee = "${email}" OR reporter = "${email}") AND updated >= "${startDate}" AND updated <= "${endDate}" ORDER BY updated DESC`;
  const orgFilter = config.githubOrgs.map(o => `org:${o}`).join(" ");
  const ghQuery = `type:pr author:${githubUsername} ${orgFilter} created:${startDate}..${endDate}`;
  const reviewQuery = `type:pr reviewed-by:${githubUsername} ${orgFilter} updated:${startDate}..${endDate}`;

  // Fetch Jira issues for this week
  let issues: JiraIssue[] = [];
  let nextPageToken: string | undefined = undefined;
  const fields = ["summary", "status", "created", "updated", "resolutiondate", "description", "priority", "labels", "components", "timetracking", "comment"];

  while (true) {
    const body: Record<string, unknown> = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(`${config.atlassian.url}/rest/api/3/search/jql`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    issues = issues.concat(data.issues || []);
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  // Fetch Confluence pages — Query 1: contributor pages (includes drafts)
  const contributorCql = `contributor = "${accountId}" AND type = page AND lastModified >= "${startDate}" AND lastModified <= "${endDate}"`;
  const contributedPages = await searchConfluence(config, contributorCql, "space,history,history.lastUpdated,history.createdBy", "any") as ConfluencePage[];

  const pageMap = new Map<string, ConfluencePage>();
  for (const page of contributedPages) {
    const tags: ConfluenceTag[] = [];
    if (page.history?.createdBy?.accountId === accountId) {
      tags.push("Created");
    } else {
      tags.push("Contributed");
    }
    if (page.status === "draft") {
      tags.push("Draft");
    }
    pageMap.set(page.id, { ...page, _tags: tags });
  }

  // Fetch Confluence pages — Query 2: pages user commented on
  const commentCql = `type = comment AND creator = "${accountId}" AND created >= "${startDate}" AND created <= "${endDate}"`;
  const comments = await searchConfluence(config, commentCql, "container") as ConfluenceComment[];

  for (const comment of comments) {
    const container = comment.container;
    if (!container?.id) continue;
    const existing = pageMap.get(container.id);
    if (existing) {
      if (!existing._tags?.includes("Commented")) {
        existing._tags = [...(existing._tags || []), "Commented"];
      }
    } else {
      pageMap.set(container.id, {
        id: container.id,
        title: container.title,
        space: container.space,
        _links: container._links,
        _tags: ["Commented"],
      });
    }
  }

  const pages = Array.from(pageMap.values());

  // Fetch GitHub PRs for this week
  let prs: GitHubPR[] = [];
  let ghPage = 1;
  while (true) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(ghQuery)}&per_page=100&page=${ghPage}&sort=created&order=desc`;
    const res = await fetch(url, { headers: githubHeaders });
    if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    prs = prs.concat(data.items || []);
    if (prs.length >= data.total_count) break;
    ghPage++;
  }

  // Fetch GitHub PR Reviews
  const reviews: PRReview[] = [];
  const authoredUrls = new Set(prs.map(p => p.html_url));

  let reviewPRs: GitHubPR[] = [];
  let rPage = 1;
  while (true) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(reviewQuery)}&per_page=100&page=${rPage}&sort=updated&order=desc`;
    const res = await fetch(url, { headers: githubHeaders });
    if (!res.ok) break; // non-fatal — reviews are supplementary
    const data = await res.json();
    reviewPRs = reviewPRs.concat(data.items || []);
    if (reviewPRs.length >= data.total_count) break;
    rPage++;
  }

  for (const pr of reviewPRs) {
    if (authoredUrls.has(pr.html_url)) continue; // skip own PRs
    const repoPath = pr.repository_url.replace("https://api.github.com/repos/", "");

    try {
      const reviewsRes = await fetch(`https://api.github.com/repos/${repoPath}/pulls/${pr.number}/reviews`, { headers: githubHeaders });
      if (!reviewsRes.ok) continue;
      const prReviews = await reviewsRes.json();
      const userReviews = prReviews.filter((r: any) => r.user?.login === githubUsername);
      if (userReviews.length === 0) continue;

      const latestReview = userReviews[userReviews.length - 1];

      const commentsRes = await fetch(`https://api.github.com/repos/${repoPath}/pulls/${pr.number}/comments`, { headers: githubHeaders });
      let commentCount = 0;
      if (commentsRes.ok) {
        const prComments = await commentsRes.json();
        commentCount = prComments.filter((c: any) => c.user?.login === githubUsername).length;
      }

      reviews.push({
        pr_number: pr.number,
        pr_title: pr.title,
        pr_author: (pr as any).user?.login || "unknown",
        repo: repoPath,
        state: latestReview.state,
        submitted_at: latestReview.submitted_at,
        comment_count: commentCount,
        html_url: latestReview.html_url,
        pr_html_url: pr.html_url,
      });
    } catch {
      // skip failed review fetches
    }
  }

  // Fetch team sprint/backlog items (for focus context — not limited to user)
  let teamSprintItems: JiraIssue[] = [];
  if (config.profile.ticketPrefixes.length > 0) {
    const projects = config.profile.ticketPrefixes.join(", ");
    const sprintJql = `project in (${projects}) AND sprint in openSprints() AND NOT (assignee = "${email}" OR reporter = "${email}") ORDER BY rank ASC`;

    try {
      let sprintPageToken: string | undefined = undefined;
      while (true) {
        const body: Record<string, unknown> = { jql: sprintJql, fields: ["summary", "status", "priority", "labels", "components"], maxResults: 50 };
        if (sprintPageToken) body.nextPageToken = sprintPageToken;

        const res = await fetch(`${config.atlassian.url}/rest/api/3/search/jql`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) break; // non-fatal — supplementary data
        const data = await res.json();
        teamSprintItems = teamSprintItems.concat(data.issues || []);
        if (!data.nextPageToken || teamSprintItems.length >= 50) break;
        sprintPageToken = data.nextPageToken;
      }
    } catch {
      // non-fatal — team sprint data is supplementary
    }
  }

  return { issues, pages, prs, reviews, teamSprintItems };
}

async function main() {
  try {
    const subcommand = process.argv[2];
    if (subcommand === "init") {
      const dryRun = process.argv.includes("--dry-run");
      await runInit({ dryRun });
      return;
    }
    if (subcommand === "configure" || subcommand === "config") {
      const section = process.argv[3];
      await runConfigure(section);
      return;
    }
    if (subcommand === "prep") {
      process.argv.splice(2, 1);
      const { runPrep } = await import("./commands/prep");
      await runPrep();
      return;
    }

    const { weeksBack, specificWeek, sinceDate, noPrompt, force, prompt: sharedPrompt, contextFile } = parseWorklogArgs();

    p.intro("worklog");

    const weeksToGenerate = await getWeeksToGenerate(weeksBack, specificWeek, force, sinceDate);

    if (weeksToGenerate.length === 0) {
      p.log.info("No missing weeks to generate.");
      await clearProgress();
      p.outro("Nothing to do");
      return;
    }

    // Check for interrupted previous run
    const previousProgress = await loadProgress();
    if (previousProgress) {
      const completed = previousProgress.completedWeeks.length;
      const total = previousProgress.totalWeeks;
      p.log.warn(`Resuming interrupted run (started ${previousProgress.startedAt}, ${completed}/${total} completed)`);
    }

    const totalWeeks = weeksToGenerate.length;
    const weekList = weeksToGenerate.map(w => `Week ${w.weekNumber}, ${w.year}`).join("\n");
    p.log.info(`Found ${totalWeeks} week(s) to generate:\n${weekList}`);

    // Initialize progress state
    const progress: ProgressState = {
      startedAt: new Date().toISOString(),
      totalWeeks,
      completedWeeks: previousProgress?.completedWeeks || [],
      weeksBack,
    };
    await saveProgress(progress);

    // If not --no-prompt and multiple weeks, ask upfront about prompting
    // When --context-file is provided, always use it (skip interactive prompt)
    let skipPrompts = noPrompt;
    if (contextFile) {
      skipPrompts = false; // context comes from file, not skipped
    } else if (!noPrompt && weeksToGenerate.length > 1) {
      const shouldPrompt = await p.confirm({
        message: "Prompt for additional context each week?",
      });
      if (p.isCancel(shouldPrompt)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      skipPrompts = !shouldPrompt;
    }

    const s = p.spinner();

    const config = requireConfig();

    s.start("Getting account IDs...");
    const [accountId, githubUsername] = await Promise.all([
      getAccountId(config),
      getGitHubUsername(config),
    ]);
    s.stop("Account IDs ready");

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

      // Prompt for additional context (skip if --no-prompt or user declined upfront)
      const perWeekContext = skipPrompts ? "" : await promptForContext(weekInfo.weekNumber, weekInfo.year, contextFile);
      const additionalContext = [sharedPrompt, perWeekContext].filter(Boolean).join("\n\n");

      // --- Fetch data ---
      const fetchStart = performance.now();
      s.start("Fetching data...");
      const { issues, pages, prs, reviews, teamSprintItems } = await fetchDataForWeek(accountId, githubUsername, weekInfo, config);
      const fetchMs = Math.round(performance.now() - fetchStart);
      s.stop(`Fetched in ${formatDuration(fetchMs)} (${issues.length} jira, ${pages.length} confluence, ${prs.length} PRs, ${reviews.length} reviews)`);

      const markdown = generateMarkdown(issues, pages, prs, reviews, teamSprintItems, weekInfo, additionalContext, config);

      // Save work log at vault root
      const workLogPath = `${getVault()}/${weekInfo.filename}`;
      await Bun.write(workLogPath, markdown);

      // Get previous brag books for context
      const previousBragBooks = await getPreviousBragBooks(weekInfo.weekNumber, weekInfo.year);

      // --- Generate brag book ---
      const bragStart = performance.now();
      s.start("Generating brag book...");
      const {
        bragBookContent,
        itemsToAdd,
        itemsToRemove,
        impactLogEntry,
        workContextUpdates,
        profileUpdate,
        focusItems,
        focusUpdates,
      } = await generateBragBookEntry(markdown, previousBragBooks, weekInfo);
      const bragMs = Math.round(performance.now() - bragStart);
      s.stop(`Brag book generated in ${formatDuration(bragMs)}`);

      const bragBookPath = `${getVault()}/${wid} Brag Book.md`;
      await Bun.write(bragBookPath, bragBookContent);
      lastBragBookPath = bragBookPath;
      lastBragBookContent = bragBookContent;

      // --- Context updates ---
      const ctxStart = performance.now();
      s.start("Updating context...");

      if (itemsToAdd.length > 0 || itemsToRemove.length > 0) {
        await updateMemory(itemsToAdd, itemsToRemove);
      }
      if (impactLogEntry) {
        await updateImpactLog(impactLogEntry);
      }
      if (workContextUpdates.length > 0) {
        await updateWorkContext(workContextUpdates);
      }
      if (profileUpdate) {
        await updateProfile(profileUpdate);
      }
      if (focusItems.length > 0 || focusUpdates.length > 0) {
        await updateFocusTracking(focusItems, focusUpdates, weekInfo);
      }

      const ctxMs = Math.round(performance.now() - ctxStart);
      s.stop(`Context updated in ${formatDuration(ctxMs)}`);

      const weekTotal = Math.round(performance.now() - weekStart);
      p.log.success(`${wid} done in ${formatDuration(weekTotal)}`);

      timings.push({ weekId: wid, fetch: fetchMs, bragBook: bragMs, contextUpdates: ctxMs, total: weekTotal });
      results.push({
        weekId: wid,
        jira: issues.length,
        confluence: pages.length,
        prs: prs.length,
        reviews: reviews.length,
        memoryAdded: itemsToAdd.length,
        memoryRemoved: itemsToRemove.length,
        impactLog: !!impactLogEntry,
        workContextUpdates: workContextUpdates.length,
        profileUpdated: !!profileUpdate,
        focusItems: focusItems.length,
        focusUpdates: focusUpdates.length,
      });

      // Update progress file
      progress.completedWeeks.push(wid);
      await saveProgress(progress);
    }

    // Persist timing stats
    const statsRecords: TimingRecord[] = timings.map((t, i) => ({
      weekId: t.weekId,
      date: new Date().toISOString(),
      fetch: t.fetch,
      bragBook: t.bragBook,
      contextUpdates: t.contextUpdates,
      total: t.total,
      counts: {
        jira: results[i].jira,
        confluence: results[i].confluence,
        prs: results[i].prs,
        reviews: results[i].reviews,
      },
    }));
    await appendStats(statsRecords);

    // Clean finish
    await clearProgress();
    await printReport(timings, results);

    // Show brag book path and coaching notes
    if (lastBragBookPath) {
      p.log.info(`Brag book: ${lastBragBookPath}`);

      const coachStart = lastBragBookContent.indexOf("<!-- COACHING_SESSION -->");
      const coachEnd = lastBragBookContent.indexOf("<!-- /COACHING_SESSION -->");
      if (coachStart !== -1 && coachEnd !== -1) {
        const coachingSection = lastBragBookContent
          .substring(coachStart + "<!-- COACHING_SESSION -->".length, coachEnd)
          .trim();
        p.note(coachingSection, "Coaching Notes");
      }
    }

    p.outro("Done!");
  } catch (err) {
    p.log.error(String(err));
    process.exit(1);
  }
}

main();
