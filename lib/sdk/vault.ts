import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import type { Root, RootContent } from "mdast";
import type { WorklogConfig } from "./types";
import { weekIdForDate } from "./week-utils";
import { canonicalText } from "./text-similarity";
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

// --- Prompt trimming ---
//
// The weekly prompt reached 254k characters, and most of it was material the coach reads past:
// two prior brag books in full including their own coaching sessions, two archived focus docs in
// full, and every organisational note ever recorded. These functions cut each input down to the
// part that changes the coach's answer. They are pure so the trimming can be tested without a
// vault, and they only ever remove: no input is rewritten or reordered.
//
// Structure comes from remark, not from scanning lines. A line scanner cannot tell a heading from
// a `## Stats` inside a fenced example, and it cannot see a setext heading or a closing-hash one
// at all. Each of those silently truncated a document in review.

/** A top-level section: its heading node and the source lines it owns, heading included. */
interface TopSection {
  /** Case-folded, whitespace-collapsed heading text. */
  heading: string;
  depth: number;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, exclusive. */
  endLine: number;
}

function parseMarkdown(markdown: string): Root {
  // Frontmatter is stripped by the plugin; without it the closing `---` of a tags block can be
  // read as a setext underline and invent a heading.
  return unified().use(remarkParse).use(remarkFrontmatter).parse(markdown);
}

/** Plain text of a node, so `## **Achievements**` reads the same as `## Achievements`. */
function nodeText(node: RootContent): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(nodeText).join("");
  return "";
}

function normalizeHeading(text: string): string {
  return text.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * The document's top-level sections at `maxDepth` or shallower. Only headings that are direct
 * children of the root count: one inside a fence is a code block, and one inside a blockquote
 * belongs to the quote, so neither can cut a document short.
 */
function topSections(tree: Root, lineCount: number, maxDepth: number): TopSection[] {
  const headings: Array<{ heading: string; depth: number; startLine: number }> = [];

  for (const node of tree.children) {
    if (node.type !== "heading" || node.depth > maxDepth || !node.position) continue;
    headings.push({
      heading: normalizeHeading(nodeText(node)),
      depth: node.depth,
      startLine: node.position.start.line - 1,
    });
  }

  return headings.map((heading, i) => ({
    ...heading,
    endLine: headings[i + 1]?.startLine ?? lineCount,
  }));
}

/** True for the headings that open an archived era, matching what the vault writers treat as live. */
function isArchivedHeading(heading: string): boolean {
  const words = heading.split(" ");
  return words.includes("archived") || words.includes("historical");
}

/** Trailing blank lines make the joins below look ragged. */
function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}

/** The brag book sections the coach reads for continuity. Its own coaching notes are not among them. */
const BRAG_BOOK_SUMMARY_SECTIONS = new Set(["achievements", "week in review"]);

/**
 * Reduce a brag book to what next week's coach needs from it: what was achieved, and how the week
 * went. The rest of the document is that week's coaching session, its memory bookkeeping and its
 * vault updates, all of which have already been applied to the vault files the prompt also
 * carries, so injecting them says the same thing twice.
 */
export function extractBragBookSummary(content: string): string {
  const lines = content.split("\n");
  const sections = topSections(parseMarkdown(content), lines.length, 2);

  const kept = sections
    .filter((section) => BRAG_BOOK_SUMMARY_SECTIONS.has(section.heading))
    .map((section) => trimTrailingBlanks(lines.slice(section.startLine, section.endLine)).join("\n"));

  return kept.join("\n\n");
}

/** How `getBragBooks` joins the documents it returns. */
const BRAG_BOOK_SEPARATOR = "\n\n---\n\n";

/**
 * Summarize the block of previous brag books the vault reader hands over, keeping the `### week`
 * label that says which week each one is. A book that has neither section left contributes
 * nothing rather than an empty heading.
 *
 * Input with no sections at all is passed through untouched: that is the reader's "no brag book
 * entries found" line, not a document this could have summarized.
 */
export function summarizePreviousBragBooks(content: string): string {
  const whole = parseMarkdown(content);
  if (!whole.children.some((node) => node.type === "heading" && node.depth >= 2)) return content;

  const parts: string[] = [];
  for (const book of content.split(BRAG_BOOK_SEPARATOR)) {
    const bookLines = book.split("\n");
    const labels = topSections(parseMarkdown(book), bookLines.length, 3).filter((s) => s.depth === 3);
    const labelAt = labels[0]?.startLine ?? -1;
    const label = labelAt === -1 ? "" : bookLines[labelAt];
    const summary = extractBragBookSummary(bookLines.slice(labelAt + 1).join("\n"));
    if (!summary.trim()) continue;
    parts.push(label ? `${label}\n\n${summary}` : summary);
  }

  return parts.join(BRAG_BOOK_SEPARATOR);
}

/** Words a focus doc's author writes when an item is finished with, whatever the outcome. */
const CLOSED_MARKERS = new Set(["done", "dropped", "shipped", "abandoned", "cancelled", "canceled"]);

/** Leading emphasis and list punctuation, so `**DONE**` and `DONE:` read the same. */
function firstWordOf(body: string): string {
  let word = "";
  for (const char of body) {
    const lower = char.toLowerCase();
    if (lower >= "a" && lower <= "z") word += lower;
    else if (word.length > 0) break;
    else if (char !== "*" && char !== "_" && char !== "~" && char !== "[" && char !== " ") break;
  }
  return word;
}

/**
 * An item its author has closed off: a ticked box, a strikethrough, or a marker word.
 *
 * The literal `[x]` is checked as well as mdast's `checked`, because remark is used here without
 * the GFM plugin, so a task list arrives as plain text with the brackets still in it.
 */
function isClosedItem(text: string, checked: boolean | null | undefined): boolean {
  if (checked === true) return true;
  const body = text.trimStart();
  if (body.startsWith("[x]") || body.startsWith("[X]")) return true;
  if (body.startsWith("~~")) return true;
  return CLOSED_MARKERS.has(firstWordOf(body));
}

/** An open item and the archived documents it survived unchanged in. */
interface CarriedItem {
  text: string;
  labels: string[];
}

const CARRIED_ITEMS_HEADING = "## Open items carried across archived focus docs";

/**
 * Reduce archived focus docs to a record of what changed. Their headings and closed-off items are
 * kept as written. Their open items are collapsed into one deduplicated list of item text with the
 * archives it appeared in, which is what the prompt's stale-item rule needs: an item sitting
 * unchanged across several versions is either blocked or being avoided, and the coach can only see
 * that if the repetition survives the trim.
 *
 * Deduplication is by `canonicalText`, so a reworded bullet counts as the same item.
 */
export function summarizeArchivedFocusDocs(content: string): string {
  const lines = content.split("\n");
  const tree = parseMarkdown(content);

  const kept: string[] = [];
  const carried = new Map<string, CarriedItem>();
  let label = "";

  for (const node of tree.children) {
    if (!node.position) continue;

    if (node.type === "heading") {
      kept.push(...lines.slice(node.position.start.line - 1, node.position.end.line));
      const archived = archiveLabel(nodeText(node));
      if (archived !== null) label = archived;
      continue;
    }

    if (node.type !== "list") continue;

    for (const item of node.children) {
      if (!item.position) continue;
      const text = nodeText(item).trim();
      if (!text) continue;

      if (isClosedItem(text, item.checked)) {
        kept.push(...lines.slice(item.position.start.line - 1, item.position.end.line));
        continue;
      }

      const key = canonicalText(text);
      if (!key) continue;
      const existing = carried.get(key);
      if (existing) {
        if (!existing.labels.includes(label)) existing.labels.push(label);
      } else {
        carried.set(key, { text: firstLineOf(text), labels: [label] });
      }
    }
  }

  const openLines = [...carried.values()].map((item) => {
    const labels = [...item.labels].filter(Boolean).sort();
    const seen = labels.length === 0
      ? ""
      : labels.length === 1
        ? ` _(seen in ${labels[0]})_`
        : ` _(first seen ${labels[0]}, last seen ${labels[labels.length - 1]})_`;
    return `- ${item.text}${seen}`;
  });

  const out = trimTrailingBlanks(kept);
  if (openLines.length > 0) out.push("", CARRIED_ITEMS_HEADING, "", ...openLines);
  return out.join("\n");
}

/**
 * The label of an archive boundary, or null for any other heading.
 *
 * `readArchivedFocusDocs` above is the only producer of these, and it always writes
 * `### Focus Doc archived <label>`. Matching that exact prefix matters: a focus doc of its own
 * with `### Blocked` and `### In progress` subheadings otherwise re-labels every item under them,
 * and an item ends up "first seen Blocked, last seen In progress".
 *
 * `<label>` is the date from the filename, or the filename itself when it does not parse.
 */
function archiveLabel(headingText: string): string | null {
  const prefix = "focus doc archived ";
  const collapsed = headingText.trim().split(/\s+/).join(" ");
  if (!collapsed.toLowerCase().startsWith(prefix)) return null;
  return collapsed.slice(prefix.length).trim() || null;
}

/** A list item can span several lines; the carried list keeps one line per item. */
function firstLineOf(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline).trim();
}

/** How many organisational notes the prompt carries before the rest are older than useful. */
export const DEFAULT_ORG_NOTE_CAP = 40;

const ORG_NOTES_HEADING = "organizational notes";

/**
 * Trim work-context to its live region and cap the organisational notes. The vault writer inserts
 * new notes at the top of that section, so the first N are the most recent. Everything else in the
 * file, the core values and the review cycle, is carried whole: it is short and the coach uses all
 * of it.
 *
 * The file on disk is untouched. This only decides what the prompt carries.
 */
export function capOrganizationalNotes(content: string, cap: number = DEFAULT_ORG_NOTE_CAP): string {
  const lines = content.split("\n");
  const tree = parseMarkdown(content);
  const sections = topSections(tree, lines.length, 2);

  const archivedAt = sections.find((section) => isArchivedHeading(section.heading));
  const liveEnd = archivedAt?.startLine ?? lines.length;

  const notes = sections.find((section) => section.heading === ORG_NOTES_HEADING);
  const dropped: Array<{ start: number; end: number }> = [];
  let bullets = 0;

  if (notes) {
    for (const node of tree.children) {
      if (node.type !== "list" || !node.position) continue;
      const nodeStart = node.position.start.line - 1;
      if (nodeStart < notes.startLine || nodeStart >= Math.min(notes.endLine, liveEnd)) continue;

      for (const item of node.children) {
        if (!item.position) continue;
        bullets++;
        if (bullets > cap) {
          dropped.push({ start: item.position.start.line - 1, end: item.position.end.line });
        }
      }
    }
  }

  const omitted = new Set<number>();
  for (const range of dropped) {
    for (let i = range.start; i < range.end; i++) omitted.add(i);
  }

  const out = lines.slice(0, liveEnd).filter((_, i) => !omitted.has(i));
  const trimmed = trimTrailingBlanks(out);
  if (bullets <= cap) return trimmed.join("\n");
  return [...trimmed, "", `_${bullets - cap} older organisational note(s) omitted from this prompt._`].join("\n");
}

/** How many vault notes the prompt carries, and how much of each. */
export const DEFAULT_VAULT_NOTE_CAP = 10;
export const DEFAULT_VAULT_NOTE_LINES = 20;

export interface VaultNote {
  title: string;
  excerpt: string;
}

/** Letters and digits are the body of an identifier; anything else ends one. */
function isIdentifierChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (char >= "0" && char <= "9") || (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
}

/**
 * Does `haystack` contain `needle` as a whole identifier? Substring matching made `STEAM-123` a
 * hit for `TEAM-123`, and let a `TEAM-12` term score every `TEAM-123` note ahead of the real one.
 * Both strings are expected uppercase already.
 */
export function containsIdentifier(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    const before = from === 0 ? undefined : haystack[from - 1];
    const after = haystack[from + needle.length];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return true;
    from = haystack.indexOf(needle, from + 1);
  }
  return false;
}

/**
 * Identifiers from this week's work log: ticket keys built from the configured prefixes, and the
 * `#123` of a pull request. Scanned character by character rather than matched with a regex,
 * because this reads a generated document and a regex over file content is what CodeQL flags.
 *
 * A key only counts on identifier boundaries, so `STEAM-123` is not a `TEAM` ticket.
 */
export function collectWorkTerms(workLogContent: string, ticketPrefixes: string[]): string[] {
  const terms = new Set<string>();
  const prefixes = ticketPrefixes.map((p) => p.toUpperCase()).filter(Boolean);
  const upper = workLogContent.toUpperCase();

  for (const prefix of prefixes) {
    const needle = `${prefix}-`;
    let from = upper.indexOf(needle);
    while (from !== -1) {
      const before = from === 0 ? undefined : upper[from - 1];
      let end = from + needle.length;
      while (end < upper.length && upper[end] >= "0" && upper[end] <= "9") end++;
      const digits = end > from + needle.length;
      if (digits && !isIdentifierChar(before) && !isIdentifierChar(upper[end])) {
        terms.add(upper.slice(from, end));
      }
      from = upper.indexOf(needle, from + 1);
    }
  }

  for (let i = 0; i < workLogContent.length; i++) {
    if (workLogContent[i] !== "#") continue;
    let end = i + 1;
    while (end < workLogContent.length && workLogContent[end] >= "0" && workLogContent[end] <= "9") end++;
    if (end > i + 1 && !isIdentifierChar(workLogContent[end])) terms.add(workLogContent.slice(i, end));
  }

  return [...terms];
}

/**
 * Pick the vault notes most likely to be about this week. Modification time alone put whatever the
 * engineer touched last at the top, which is often unrelated; a note that names one of the week's
 * tickets or pull requests is about the week whenever it was saved. Ties keep the order they came
 * in, which is still most-recently-modified first.
 *
 * Every candidate is scored before anything is dropped: capping first threw away the one relevant
 * note in a week with more recent noise.
 */
export function rankVaultNotes(
  notes: readonly VaultNote[],
  terms: readonly string[],
  cap: number = DEFAULT_VAULT_NOTE_CAP,
): VaultNote[] {
  const needles = terms.map((t) => t.toUpperCase()).filter(Boolean);

  const scored = notes.map((note, index) => {
    const haystack = `${note.title}\n${note.excerpt}`.toUpperCase();
    let score = 0;
    for (const needle of needles) {
      if (containsIdentifier(haystack, needle)) score++;
    }
    return { note, index, score };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, cap).map((s) => s.note);
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

/**
 * The ticket prefixes in force for a given week. A historical week belongs to whichever team the
 * timeline says it did, and that team may have used prefixes the current profile no longer lists.
 * Falls back to the profile when the timeline entry has none.
 */
export function ticketPrefixesForWeek(
  /** Only the prefixes are read, so a caller can pass anything carrying them. */
  config: { profile: Pick<WorklogConfig["profile"], "ticketPrefixes"> },
  teamEntry: TeamTimelineEntry | undefined,
): string[] {
  const fromTimeline = teamEntry?.ticketPrefixes ?? [];
  return fromTimeline.length > 0 ? fromTimeline : config.profile.ticketPrefixes;
}

export async function discoverWeeklyNotes(
  config: WorklogConfig,
  paths: VaultPaths,
  startDate: Date,
  endDate: Date,
  /** Optional so existing callers keep working; pass the week's team prefixes for a past week. */
  ticketPrefixes: string[] = config.profile.ticketPrefixes,
): Promise<VaultNote[]> {
  const prefixes = ticketPrefixes.map(p => p.toLowerCase());
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
    const lines = content.split("\n").slice(0, DEFAULT_VAULT_NOTE_LINES);
    const excerpt = lines.join("\n").trim();
    const title = file.replace(/\.md$/, "");

    candidates.push({ title, excerpt, mtime });
  }

  // Most-recently-modified first, and every qualifying note is returned. The caller scores these
  // and keeps ten; cutting the list here first threw away the one relevant note in a week whose
  // other twenty-five were noise.
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.map(({ title, excerpt }) => ({ title, excerpt }));
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

/**
 * The timeline as a prompt should see it.
 *
 * A vault with no team-timeline.json now reads as an empty timeline rather than crashing,
 * and every consumer then answered "Unknown Team" for every week. That contradicts the
 * warning readTeamTimeline prints, and it puts a wrong answer in the prompt where the
 * profile has the right one. Standing in a single entry built from the profile fixes the
 * team label, the generation context and the formatted timeline at once, because all
 * three read entries rather than asking about the file.
 *
 * A timeline that has entries is returned untouched.
 */
export function resolveTeamTimeline(timeline: TeamTimeline, config: WorklogConfig): TeamTimeline {
  if (timeline.entries.length > 0) return timeline;

  return {
    // Open-ended from the day the engineer started, which covers every week that can have
    // a work log. Earlier than that there is genuinely no team to name.
    entries: [{
      team: config.profile.team,
      domain: config.profile.teamDomain || null,
      start: config.profile.startDate,
      end: null,
      ticketPrefixes: config.profile.ticketPrefixes,
      notes: null,
    }],
    transitionNotes: timeline.transitionNotes,
  };
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
    // A vault standing in a single entry from the profile has no transitions to report,
    // and a header over nothing is prompt noise.
    ...(notes.length > 0 ? ["", "IMPORTANT FACTS about team transitions:", ...notes] : []),
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
