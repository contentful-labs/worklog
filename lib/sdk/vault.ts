import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import type { WorklogConfig } from "./types";
import { weekIdForDate } from "./week-utils";
import { contractHome } from "../config";

export interface VaultPaths {
  vault: string;
  memory: string;
  profile: string;
  workContext: string;
  impactLog: string;
  coachPersona: string;
  focusTracking: string;
  focusDoc: string;
  teamTimeline: string;
  careerDocs: string[];
}

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

export function buildVaultPaths(config: WorklogConfig, teamTimelinePath: string): VaultPaths {
  const vault = config.vault;
  return {
    vault,
    memory: `${vault}/memory.md`,
    profile: `${vault}/my-profile.md`,
    workContext: `${vault}/work-context.md`,
    impactLog: `${vault}/impact-log.md`,
    coachPersona: `${vault}/coach-persona.md`,
    focusTracking: `${vault}/focus-tracking.md`,
    focusDoc: `${vault}/My Focus.md`,
    teamTimeline: teamTimelinePath,
    careerDocs: config.career.careerDocPaths,
  };
}

export async function readFileOrDefault(path: string, fallback: string): Promise<string> {
  if (!existsSync(path)) return fallback;
  return await readFile(path, "utf-8");
}

export async function readMemory(paths: VaultPaths): Promise<string> {
  return readFileOrDefault(paths.memory, "No memory items yet.");
}

export async function readProfile(paths: VaultPaths): Promise<string> {
  return readFileOrDefault(paths.profile, "No profile available.");
}

export async function readWorkContext(paths: VaultPaths): Promise<string> {
  return readFileOrDefault(paths.workContext, "No work context available.");
}

export async function readImpactLog(paths: VaultPaths): Promise<string> {
  return readFileOrDefault(paths.impactLog, "No impact log available.");
}

/**
 * Drop table rows whose first cell is an ISO date before `minDate`. Headings, notes,
 * and table headers stay, so the model still sees the file's structure.
 * Used to keep memory.md's years of small items out of every weekly prompt.
 */
export function dropDatedRowsBefore(content: string, minDate: string): string {
  return content
    .split("\n")
    .filter((line) => {
      if (!line.startsWith("|")) return true;
      const first = line.split("|")[1]?.trim() ?? "";
      return !/^\d{4}-\d{2}-\d{2}$/.test(first) || first >= minDate;
    })
    .join("\n");
}

export async function readCoachPersona(paths: VaultPaths): Promise<string> {
  return readFileOrDefault(paths.coachPersona, "No coach persona defined.");
}

export async function readFocusTracking(paths: VaultPaths): Promise<string> {
  return readFileOrDefault(paths.focusTracking, "No focus items tracked yet.");
}

export async function readFocusDoc(paths: VaultPaths): Promise<string> {
  return readFileOrDefault(paths.focusDoc, "No focus doc available.");
}

export async function readArchivedFocusDocs(paths: VaultPaths): Promise<string> {
  const files = await readdir(paths.vault);
  const archived = files
    .filter(f => f.match(/^My Focus \(\d{4}-\d{2}-\d{2}\)\.md$/))
    .sort()
    .reverse()
    .slice(0, 2);

  if (archived.length === 0) return "No previous focus docs.";

  const contents: string[] = [];
  for (const file of archived) {
    const content = await readFile(`${paths.vault}/${file}`, "utf-8");
    const dateMatch = file.match(/\((\d{4}-\d{2}-\d{2})\)/);
    const label = dateMatch ? dateMatch[1] : file;
    contents.push(`### Focus Doc archived ${label}\n\n${content}`);
  }
  return contents.join("\n\n---\n\n");
}

export async function readCareerContext(paths: VaultPaths): Promise<string> {
  const parts: string[] = [];
  for (const docPath of paths.careerDocs) {
    if (existsSync(docPath)) {
      const content = await readFile(docPath, "utf-8");
      parts.push(content);
    }
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : "No career context available.";
}

const FIXED_FILES = new Set([
  "memory.md", "my-profile.md", "work-context.md", "impact-log.md",
  "coach-persona.md", "focus-tracking.md", "My Focus.md",
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
  config: WorklogConfig,
  paths: VaultPaths,
  startDate: Date,
  endDate: Date,
): Promise<Array<{ title: string; excerpt: string }>> {
  const prefixes = config.profile.ticketPrefixes.map(p => p.toLowerCase());
  const configTerms = [config.profile.company, config.profile.team, config.profile.teamDomain]
    .filter(Boolean)
    .map(t => t.toLowerCase());

  const files = await readdir(paths.vault);
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  const candidates: Array<{ title: string; excerpt: string; mtime: number }> = [];

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    if (FIXED_FILES.has(file)) continue;
    if (GENERATED_PATTERNS.some(p => p.test(file))) continue;

    const filePath = `${paths.vault}/${file}`;
    const info = await stat(filePath);
    if (!info.isFile()) continue;

    const mtime = info.mtimeMs;
    if (mtime < startMs || mtime > endMs) continue;

    const lower = file.toLowerCase();
    const isRelevant =
      prefixes.some(p => lower.includes(p)) ||
      configTerms.some(t => lower.includes(t)) ||
      WORK_KEYWORDS.some(kw => lower.includes(kw));

    if (!isRelevant) continue;

    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").slice(0, 30);
    const excerpt = lines.join("\n").trim();
    const title = file.replace(/\.md$/, "");

    candidates.push({ title, excerpt, mtime });
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, 25).map(({ title, excerpt }) => ({ title, excerpt }));
}

export interface ReadTeamTimelineOptions {
  /** Told when the file is simply absent, so a command can surface it. */
  onWarning?: (message: string) => void;
}

/**
 * The team timeline, or an empty one when the file has not been set up.
 *
 * An absent timeline is a fresh install, not a broken one: every other vault reader
 * defaults rather than throwing, and this one used to end the run with a bare ENOENT
 * before anything useful had happened. Malformed JSON still fails hard, because that is
 * a file someone wrote and got wrong, and silently ignoring it would attribute a whole
 * history to the wrong team.
 */
export function readTeamTimeline(paths: VaultPaths, options: ReadTeamTimelineOptions = {}): TeamTimeline {
  if (!existsSync(paths.teamTimeline)) {
    options.onWarning?.(
      `No team timeline at ${contractHome(paths.teamTimeline)}; every week will be attributed to the current team.`,
    );
    return { entries: [], transitionNotes: [] };
  }

  const raw = readFileSync(paths.teamTimeline, "utf-8");
  try {
    // SAFETY: the shape is not checked, and a wrong one surfaces as a missing team rather
    // than a crash: getTeamForDate finds nothing in a bad entries array and every caller
    // already handles an undefined team. Only the JSON itself has to be well formed here.
    return JSON.parse(raw) as TeamTimeline;
  } catch (err) {
    throw new Error(
      `Team timeline at ${contractHome(paths.teamTimeline)} is not valid JSON: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function getTeamForDate(timeline: TeamTimeline, date: Date): TeamTimelineEntry | undefined {
  const iso = date.toISOString().split("T")[0];
  return timeline.entries.find(e => {
    if (iso < e.start) return false;
    if (e.end && iso > e.end) return false;
    return true;
  });
}

export function getCurrentTeam(timeline: TeamTimeline): TeamTimelineEntry | undefined {
  return getTeamForDate(timeline, new Date());
}

export function formatTeamTimelineForPrompt(timeline: TeamTimeline): string {
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

export async function getBragBooks(paths: VaultPaths, count: number, beforeFilename?: string, afterFilename?: string): Promise<string> {
  const files = await readdir(paths.vault);
  const bragFiles = files
    .filter(f => f.match(/^\d{4}-W\d{2} Brag Book\.md$/))
    .sort()
    .reverse();

  let filtered = beforeFilename
    ? bragFiles.filter(f => f < beforeFilename)
    : bragFiles;

  if (afterFilename) {
    filtered = filtered.filter(f => f >= afterFilename);
  }

  const selected = filtered.slice(0, count);

  if (selected.length === 0) return "No brag book entries found.";

  const contents: string[] = [];
  for (const file of selected.reverse()) {
    const content = await readFile(`${paths.vault}/${file}`, "utf-8");
    const label = file.replace(" Brag Book.md", "");
    contents.push(`### ${label}\n\n${content}`);
  }
  return contents.join("\n\n---\n\n");
}

export async function getRecentBragBooks(paths: VaultPaths, weeks: number, sinceDate?: string, untilDate?: string): Promise<string> {
  let beforeFilename: string | undefined;
  if (untilDate) {
    const untilWeekId = weekIdForDate(new Date(untilDate));
    beforeFilename = `${untilWeekId} Brag Book.md\xff`;
  }

  let afterFilename: string | undefined;
  if (sinceDate) {
    const sinceWeekId = weekIdForDate(new Date(sinceDate));
    afterFilename = `${sinceWeekId} Brag Book.md`;
  }

  if (!beforeFilename && !afterFilename) return getBragBooks(paths, weeks);
  return getBragBooks(paths, weeks, beforeFilename, afterFilename);
}

export async function getMissingBragBookWeeks(paths: VaultPaths, weekIds: string[]): Promise<string[]> {
  const files = await readdir(paths.vault);
  const existing = new Set<string>();
  for (const f of files) {
    const match = f.match(/^(\d{4}-W\d{2}) Brag Book\.md$/);
    if (match) existing.add(match[1]);
  }
  return weekIds.filter(id => !existing.has(id));
}
