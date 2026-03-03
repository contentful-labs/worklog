import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { requireConfig, TEAM_TIMELINE_PATH as CONFIG_TEAM_TIMELINE_PATH } from "./config";
import type { WorklogConfig } from "./config";

export interface TeamTimelineEntry {
  team: string;
  domain: string | null;
  start: string;
  end: string | null;
  ticketPrefixes: string[];
  notes: string | null;
}

export interface TeamTimeline {
  entries: TeamTimelineEntry[];
  transitionNotes: string[];
}

// --- Lazy config-derived paths ---

interface Paths {
  vault: string;
  MEMORY_PATH: string;
  PROFILE_PATH: string;
  WORK_CONTEXT_PATH: string;
  IMPACT_LOG_PATH: string;
  COACH_PERSONA_PATH: string;
  FOCUS_TRACKING_PATH: string;
  FOCUS_DOC_PATH: string;
  TEAM_TIMELINE_PATH: string;
  CAREER_NOTES: string[];
}

let _paths: Paths | undefined;

function buildPaths(config: WorklogConfig): Paths {
  const vault = config.vault;
  return {
    vault,
    MEMORY_PATH: `${vault}/memory.md`,
    PROFILE_PATH: `${vault}/my-profile.md`,
    WORK_CONTEXT_PATH: `${vault}/work-context.md`,
    IMPACT_LOG_PATH: `${vault}/impact-log.md`,
    COACH_PERSONA_PATH: `${vault}/coach-persona.md`,
    FOCUS_TRACKING_PATH: `${vault}/focus-tracking.md`,
    FOCUS_DOC_PATH: `${vault}/My Focus.md`,
    TEAM_TIMELINE_PATH: CONFIG_TEAM_TIMELINE_PATH,
    CAREER_NOTES: config.career.careerDocPaths,
  };
}

function paths(): Paths {
  if (!_paths) _paths = buildPaths(requireConfig());
  return _paths;
}

// Getter exports for backward compatibility
export const getVault = () => paths().vault;
export const getMemoryPath = () => paths().MEMORY_PATH;
export const getProfilePath = () => paths().PROFILE_PATH;
export const getWorkContextPath = () => paths().WORK_CONTEXT_PATH;
export const getImpactLogPath = () => paths().IMPACT_LOG_PATH;
export const getCoachPersonaPath = () => paths().COACH_PERSONA_PATH;
export const getFocusTrackingPath = () => paths().FOCUS_TRACKING_PATH;
export const getFocusDocPath = () => paths().FOCUS_DOC_PATH;
export const getTeamTimelinePath = () => paths().TEAM_TIMELINE_PATH;
export const getCareerNotes = () => paths().CAREER_NOTES;

export { CONFIG_TEAM_TIMELINE_PATH as TEAM_TIMELINE_PATH };

async function readFileOrDefault(path: string, fallback: string): Promise<string> {
  if (!existsSync(path)) return fallback;
  return await Bun.file(path).text();
}

export async function readMemory(): Promise<string> {
  return readFileOrDefault(getMemoryPath(), "No memory items yet.");
}

export async function readProfile(): Promise<string> {
  return readFileOrDefault(getProfilePath(), "No profile available.");
}

export async function readWorkContext(): Promise<string> {
  return readFileOrDefault(getWorkContextPath(), "No work context available.");
}

export async function readImpactLog(): Promise<string> {
  return readFileOrDefault(getImpactLogPath(), "No impact log available.");
}

export async function readCoachPersona(): Promise<string> {
  return readFileOrDefault(getCoachPersonaPath(), "No coach persona defined.");
}

export async function readFocusTracking(): Promise<string> {
  return readFileOrDefault(getFocusTrackingPath(), "No focus items tracked yet.");
}

export async function readFocusDoc(): Promise<string> {
  return readFileOrDefault(getFocusDocPath(), "No focus doc available.");
}

export async function readArchivedFocusDocs(): Promise<string> {
  const vault = getVault();
  const files = await readdir(vault);
  const archived = files
    .filter(f => f.match(/^My Focus \(\d{4}-\d{2}-\d{2}\)\.md$/))
    .sort()
    .reverse()
    .slice(0, 2);

  if (archived.length === 0) return "No previous focus docs.";

  const contents: string[] = [];
  for (const file of archived) {
    const content = await Bun.file(`${vault}/${file}`).text();
    const dateMatch = file.match(/\((\d{4}-\d{2}-\d{2})\)/);
    const label = dateMatch ? dateMatch[1] : file;
    contents.push(`### Focus Doc archived ${label}\n\n${content}`);
  }
  return contents.join("\n\n---\n\n");
}

export async function readCareerContext(): Promise<string> {
  const careerNotes = getCareerNotes();
  const parts: string[] = [];
  for (const path of careerNotes) {
    if (existsSync(path)) {
      const content = await Bun.file(path).text();
      parts.push(content);
    }
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : "No career context available.";
}

// --- Vault note discovery ---

const FIXED_FILES = new Set([
  "memory.md",
  "my-profile.md",
  "work-context.md",
  "impact-log.md",
  "coach-persona.md",
  "focus-tracking.md",
  "My Focus.md",
]);

const GENERATED_PATTERNS = [/^\d{4}-W\d{2} (Brag Book|Work Log)\.md$/, /^My Focus \(\d{4}-\d{2}-\d{2}\)\.md$/];

const WORK_KEYWORDS = [
  "workflow", "action", "agent", "hiring", "support", "spike", "rfc",
  "retro", "standup", "sprint", "epic", "design", "review", "oncall",
  "incident", "migration", "release", "deploy", "architecture", "proposal",
  "strategy", "roadmap", "okr", "kpi", "meeting", "sync", "planning",
  "onboarding", "offboarding", "handover", "runbook", "postmortem",
];

export async function discoverWeeklyNotes(
  startDate: Date,
  endDate: Date,
): Promise<Array<{ title: string; excerpt: string }>> {
  const config = requireConfig();
  const vault = config.vault;

  // Build work-relevance matchers from config
  const prefixes = config.profile.ticketPrefixes.map(p => p.toLowerCase());
  const configTerms = [
    config.profile.company,
    config.profile.team,
    config.profile.teamDomain,
  ]
    .filter(Boolean)
    .map(t => t.toLowerCase());

  const files = await readdir(vault);
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  const candidates: Array<{ title: string; excerpt: string; mtime: number }> = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    if (FIXED_FILES.has(file)) continue;
    if (GENERATED_PATTERNS.some(p => p.test(file))) continue;

    const filePath = `${vault}/${file}`;
    const info = await stat(filePath);
    if (!info.isFile()) continue;

    const mtime = info.mtimeMs;
    if (mtime < startMs || mtime > endMs) continue;

    // Check work-relevance
    const lower = file.toLowerCase();
    const isRelevant =
      prefixes.some(p => lower.includes(p)) ||
      configTerms.some(t => lower.includes(t)) ||
      WORK_KEYWORDS.some(kw => lower.includes(kw));

    if (!isRelevant) continue;

    // Read first ~30 lines as excerpt
    const content = await Bun.file(filePath).text();
    const lines = content.split("\n").slice(0, 30);
    const excerpt = lines.join("\n").trim();
    const title = file.replace(/\.md$/, "");

    candidates.push({ title, excerpt, mtime });
  }

  // Sort by mtime descending (most recently modified first), cap at 25
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, 25).map(({ title, excerpt }) => ({ title, excerpt }));
}

let _teamTimeline: TeamTimeline | undefined;

export function readTeamTimeline(): TeamTimeline {
  if (!_teamTimeline) {
    _teamTimeline = JSON.parse(require("fs").readFileSync(getTeamTimelinePath(), "utf-8"));
  }
  return _teamTimeline!;
}

export function getTeamForDate(date: Date): TeamTimelineEntry | undefined {
  const timeline = readTeamTimeline();
  const iso = date.toISOString().split("T")[0];
  return timeline.entries.find(e => {
    if (iso < e.start) return false;
    if (e.end && iso > e.end) return false;
    return true;
  });
}

export function getCurrentTeam(): TeamTimelineEntry | undefined {
  return getTeamForDate(new Date());
}

export function formatTeamTimelineForPrompt(): string {
  const timeline = readTeamTimeline();
  const lines = timeline.entries.map(e => {
    const end = e.end ?? "present";
    const domain = e.domain ? ` — ${e.domain}` : "";
    const prefixes = e.ticketPrefixes.length > 0 ? ` (${e.ticketPrefixes.join(", ")} tickets)` : "";
    return `- ${e.start} to ${end}: ${e.team}${domain}${prefixes}`;
  });

  const notes = timeline.transitionNotes.map((n, i) => `${i + 1}. ${n}`);

  return [
    "CRITICAL CONTEXT FOR INTERPRETING WORK HISTORY:",
    ...lines,
    "",
    "IMPORTANT FACTS about team transitions:",
    ...notes,
  ].join("\n");
}

export async function getBragBooks(count: number, beforeFilename?: string): Promise<string> {
  const vault = getVault();
  const files = await readdir(vault);
  const bragFiles = files
    .filter(f => f.match(/^\d{4}-W\d{2} Brag Book\.md$/))
    .sort()
    .reverse();

  const filtered = beforeFilename
    ? bragFiles.filter(f => f < beforeFilename)
    : bragFiles;

  const selected = filtered.slice(0, count);

  if (selected.length === 0) return "No brag book entries found.";

  const contents: string[] = [];
  for (const file of selected.reverse()) {
    const content = await Bun.file(`${vault}/${file}`).text();
    const label = file.replace(" Brag Book.md", "");
    contents.push(`### ${label}\n\n${content}`);
  }
  return contents.join("\n\n---\n\n");
}

export async function getRecentBragBooks(weeks: number, untilDate?: string): Promise<string> {
  if (!untilDate) return getBragBooks(weeks);

  // Convert untilDate to a week ID to use as upper bound
  const until = new Date(untilDate);
  const untilWn = getWeekNumber(until);
  const utc = new Date(Date.UTC(until.getFullYear(), until.getMonth(), until.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const isoYear = utc.getUTCFullYear();
  const untilWeekId = weekId(untilWn, isoYear);
  // beforeFilename is exclusive, so use the next week's filename to include untilWeekId
  const nextWeekFilename = `${untilWeekId} Brag Book.md\xff`;
  return getBragBooks(weeks, nextWeekFilename);
}

// ISO week number for a date
export function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export function weekId(week: number, year: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// Returns list of YYYY-WXX week IDs covering the last N weeks from today
export function getExpectedBragBookWeeks(weeks: number): string[] {
  const now = new Date();
  const result: string[] = [];

  for (let i = 0; i < weeks; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const wn = getWeekNumber(d);
    // Use ISO week year (may differ from calendar year at year boundaries)
    const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
    const isoYear = utc.getUTCFullYear();
    result.push(weekId(wn, isoYear));
  }

  return result.reverse();
}

// Returns which of the requested week IDs don't have a brag book file
export async function getMissingBragBookWeeks(weekIds: string[]): Promise<string[]> {
  const vault = getVault();
  const files = await readdir(vault);
  const existing = new Set<string>();
  for (const f of files) {
    const match = f.match(/^(\d{4}-W\d{2}) Brag Book\.md$/);
    if (match) existing.add(match[1]);
  }
  return weekIds.filter(id => !existing.has(id));
}
