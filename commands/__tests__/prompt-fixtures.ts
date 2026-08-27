/**
 * Fixtures sized like a real vault. The live prompt measured 254k characters, and these add up to
 * the same order so the trimming can be judged against something realistic. Not a test file: it is
 * imported by the prompt-size test and by anything else that needs a prompt to measure.
 */

import type { WorklogConfig } from "../../lib/sdk/types";
import type { WeekInfo } from "../../lib/sdk/data-fetch";
import type { TeamTimeline, VaultNote } from "../../lib/sdk/vault";

export const config: WorklogConfig = {
  version: 1,
  vault: "/tmp/test",
  atlassian: { url: "https://test.atlassian.net", email: "user@example.com" },
  githubOrgs: ["test-org"],
  ai: { provider: "openai" },
  profile: {
    fullName: "Test User", displayName: "Test", jobTitle: "Engineer",
    level: "IC5", company: "TestCo", location: "Remote", startDate: "2024-01-01",
    domain: "platform", team: "Core", teamDomain: "infra", ticketPrefixes: ["TEAM"],
  },
  career: {
    framework: "test", currentLevel: "IC5", targetLevel: "IC6", companyValues: ["Craft"],
    reviewCycleDates: [], skills: [], growthAreas: [], careerDocPaths: [],
  },
  coaching: { tone: "direct", focusAreas: [] },
};

export const weekInfo: WeekInfo = {
  weekNumber: 12, year: 2026,
  startDate: new Date("2026-03-16T00:00:00Z"),
  endDate: new Date("2026-03-22T00:00:00Z"),
  filename: "2026-W12 Work Log.md",
};

export const timeline: TeamTimeline = {
  entries: [{ team: "Core", domain: "infra", start: "2024-01-01", end: null, ticketPrefixes: ["TEAM"], notes: null }],
  transitionNotes: [],
};

export function lines(count: number, make: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => make(i)).join("\n");
}

/** One brag book of the shape the generator writes, most of it the coaching session. */
export function bragBook(week: string): string {
  return [
    `### ${week}`,
    "",
    `# Brag Book - Week ${week}`,
    "",
    "## Achievements",
    "",
    lines(6, (i) => `- Achievement ${i} on the Search Revamp, evidence [TEAM-${1200 + i}](link)`),
    "",
    "## Stats",
    "",
    "| Metric | Count |",
    "|--------|-------|",
    lines(6, (i) => `| Metric ${i} | ${i} |`),
    "",
    "## Week in Review",
    "",
    lines(14, (i) => `Review sentence ${i} about how the week actually went, what it cost and what it taught.`),
    "",
    "## Items to Add to [[memory]]",
    "",
    lines(45, (i) => `- Memory item ${i}, a small contribution not worth the brag book yet, with a note on why it is being kept`),
    "",
    "## Items to Remove from [[memory]] (Graduated)",
    "",
    lines(6, (i) => `- Graduated item ${i}`),
    "",
    "## Mentor Notes",
    "",
    "### What Went Well",
    "",
    lines(90, (i) => `Coaching sentence ${i}, written fresh for that week, already read and already acted on by the engineer it was written for.`),
    "",
    "### Areas for Attention",
    "",
    lines(90, (i) => `Attention sentence ${i}, since applied to the vault files that this prompt also carries in full.`),
    "",
    "### Focus for Next Week",
    "",
    lines(8, (i) => `${i + 1}. Suggestion ${i} from a week that has already been reviewed and closed out.`),
    "",
    "## [[focus-tracking]] Status",
    "",
    lines(8, (i) => `- 2026-W11.${i}: addressed`),
    "",
    "## [[work-context]] Updates",
    "",
    lines(8, (i) => `- **Process:** Update ${i} _(source)_`),
    "",
    "## [[my-profile]] Updates",
    "",
    lines(4, (i) => `- Strength ${i}`),
  ].join("\n");
}

export const previousBragBooks = `${bragBook("2026-W10")}\n\n---\n\n${bragBook("2026-W11")}`;

export const workContextContent = [
  "# Work Context",
  "",
  "## Company Core Values",
  "",
  lines(5, (i) => `- Value ${i}: a sentence about what it means in practice`),
  "",
  "## Review Cycle",
  "",
  "| Type | Date |",
  "|------|------|",
  "| Self-review | 2026-06-01 |",
  "",
  "## Organizational Notes",
  "",
  lines(200, (i) => `- **Category ${i % 7}:** Organisational note ${i}, a fact about how this company works that somebody recorded once _(2026-W${10 + (i % 40)})_`),
  "",
  "## ARCHIVED - Previous Team Era",
  "",
  lines(60, (i) => `- **Category ${i % 5}:** Archived note ${i} from a team era that has ended _(2023-W${10 + (i % 40)})_`),
].join("\n");

/**
 * `focus-tracking.md` at its real size: 410 coaching commitments. The prompt never carries this
 * table; `selectOpenFocusItems` takes ten open ones and `summarizeFocusHistory` reduces the rest
 * to a single line. The fixture exists so the breakdown proves that.
 */
const FOCUS_TRACKING_ROWS = 410;

export const focusTrackingContent = [
  "# Focus Tracking",
  "<!-- worklog-focus-format: 2 -->",
  "",
  "| ID | Week | Focus Item | Status | Reviews | Notes |",
  "|------|------|------|------|------|------|",
  lines(FOCUS_TRACKING_ROWS, (i) => {
    const week = `2026-W${String(2 + Math.floor(i / 8)).padStart(2, "0")}`;
    // The last handful stay open; everything older has been resolved or lapsed.
    const status = i >= FOCUS_TRACKING_ROWS - 14 ? "pending" : i % 3 === 0 ? "lapsed" : "resolved";
    return `| ${week}.${(i % 8) + 1} | ${week} | Focus commitment ${i}, written after that week's coaching session | ${status} | ${i % 3} | Notes on commitment ${i} |`;
  }),
].join("\n");

/**
 * `My Focus.md` at its real shape. The engineer's own document: priorities in prose, plus one
 * tracking table of 128 rows that is most of the file's bytes and none of its meaning.
 */
const FOCUS_DOC_TABLE_ROWS = 128;

export const focusDocContent = [
  "# My Focus",
  "",
  "## P0 - Own & Deliver",
  "",
  lines(6, (i) => `- Current P0 item ${i}, the thing that actually matters this quarter`),
  "",
  "## P1 - Influence & Shape",
  "",
  lines(8, (i) => `- Current P1 item ${i}`),
  "",
  "## Tracking",
  "",
  "Everything in flight, kept here because it has to live somewhere.",
  "",
  "| Item | Owner | Status | Updated | Notes |",
  "|---|---|---|---|---|",
  lines(
    FOCUS_DOC_TABLE_ROWS,
    (i) =>
      `| Tracked item ${i}, a piece of work someone is carrying | Owner ${i % 7} | ` +
      `${["not started", "in progress", "blocked", "done"][i % 4]} | 2026-0${(i % 9) + 1}-01 | ` +
      `Notes on tracked item ${i}: where it stands, who is waiting on it and what it needs next. |`,
  ),
  "",
  "## People to Talk To",
  "",
  lines(4, (i) => `- Person ${i}, about the thing they own`),
].join("\n");

/** A small table, under the cap, that has to survive the trim untouched. */
export const focusDocSmallTable = [
  "# My Focus",
  "",
  "## Tracking",
  "",
  "| Item | Status |",
  "|---|---|",
  lines(8, (i) => `| Small item ${i} | in progress |`),
].join("\n");

/**
 * Two archived focus docs of the shape a person actually keeps: a page each, with most of the
 * open items repeated word for word between versions. That repetition is the stale-item signal
 * the coach is asked to spot, so it has to survive the trim.
 */
const carriedItems = (prefix: string) =>
  lines(12, (i) => `- ${prefix} item ${i}, still open and unchanged since the version before`);

export const focusHistoryContent = [
  "### Focus Doc archived 2026-03-01",
  "",
  "## P0 - Own & Deliver",
  "",
  lines(4, (i) => `- [x] Closed P0 item ${i} from the previous version`),
  carriedItems("P0"),
  "",
  "## P1 - Influence & Shape",
  "",
  carriedItems("P1"),
  "- Only in the March version, added late and dropped without a word",
  "",
  "---",
  "",
  "### Focus Doc archived 2026-02-01",
  "",
  "## P0 - Own & Deliver",
  "",
  lines(4, (i) => `- ~~Dropped item ${i}~~`),
  carriedItems("P0"),
  "",
  "## P1 - Influence & Shape",
  "",
  carriedItems("P1"),
].join("\n");

/**
 * A memory table the size of the real one: 320 rows across the 26-week window the reader keeps,
 * with the Notes cell carrying most of the bytes. Dates run backwards from the fixture week.
 */
const MEMORY_ROWS = 320;

function memoryRowDate(i: number): string {
  // Six months back, spread evenly, so roughly half the rows fall outside the 12-week window.
  const day = new Date("2026-03-16T00:00:00Z");
  day.setUTCDate(day.getUTCDate() - Math.floor((i / MEMORY_ROWS) * 182));
  return day.toISOString().split("T")[0];
}

export const memoryContent = [
  "# Memory",
  "",
  "## Core Team",
  "",
  "| Date | Item | Category | Notes |",
  "|---|---|---|---|",
  lines(
    MEMORY_ROWS,
    (i) =>
      `| ${memoryRowDate(i)} | Memory item ${i}, a small contribution recorded for later | Category ${i % 5} | ` +
      `Notes on memory item ${i}: what happened that week, who was involved and why it was worth writing down at all. |`,
  ),
].join("\n");

export const profileContent = ["# Profile", "", "## Key Strengths", "", lines(60, (i) => `- Strength ${i}, observed over several weeks of work`)].join("\n");
/**
 * An impact log the length of a career: 180 entries spread over three years, so roughly a third
 * fall inside the 52-week window and the rest do not.
 */
const IMPACT_ROWS = 180;

function impactRowDate(i: number): string {
  const day = new Date("2026-03-16T00:00:00Z");
  day.setUTCDate(day.getUTCDate() - Math.floor((i / IMPACT_ROWS) * 1095));
  return day.toISOString().split("T")[0];
}

export const impactLogContent = [
  "# Impact Log",
  "",
  "Achievements that carry weight in a review, with the evidence for them.",
  "",
  "## Impact Timeline",
  "",
  "| Date | Achievement | Scope | Core Value | Evidence |",
  "|---|---|---|---|---|",
  lines(
    IMPACT_ROWS,
    (i) => `| ${impactRowDate(i)} | Impact ${i} on a piece of work that mattered | Team | Craft | TEAM-${1000 + i} |`,
  ),
  "",
  "**Last significant impact:** 2026-03-10 - Impact 0 on a piece of work that mattered",
  "**Current gap:** None - recent entry added",
].join("\n");
export const coachPersona = lines(80, (i) => `Persona line ${i}, describing how the coach should sound when it speaks.`);
export const careerContext = lines(190, (i) => `Career framework line ${i}, describing an expectation at one level of the ladder and how it is assessed.`);

export const workLogContent = [
  "# Work Log - Week 12, 2026",
  "",
  "## Jira Tasks (8)",
  "",
  lines(8, (i) => `### [TEAM-${1200 + i}] Ticket ${i}\n**Status:** Done | **Updated:** Mar ${16 + (i % 5)}, 2026\n> ${lines(4, (j) => `Description line ${j} of the work that was done on this ticket.`)}\n**Your comments (2):**\n> A comment left on the ticket.`),
  "",
  "## GitHub Pull Requests (5)",
  "",
  lines(5, (i) => `### [org/repo#${4300 + i}] PR ${i}\n[View on GitHub](https://github.com/org/repo/pull/${4300 + i})`),
].join("\n");

/** Twenty-five candidates, most about something else entirely. */
function note(i: number, excerptLines: number): VaultNote {
  const relevant = i % 5 === 0;
  return {
    title: relevant ? `Sprint planning ${i}` : `Unrelated note ${i}`,
    excerpt: relevant
      ? lines(excerptLines, (j) => `Line ${j} discussing TEAM-${1200 + (i % 8)} and pull request #${4300 + (i % 5)}, at some length.`)
      : lines(excerptLines, (j) => `Line ${j} of a note about something with no bearing at all on the week being written up.`),
  };
}

/** What the reader produced before: twenty-five candidates at thirty lines each. */
export const vaultNotesBefore: VaultNote[] = Array.from({ length: 25 }, (_, i) => note(i, 30));

/** What the reader produces now: the same candidates, cut to twenty lines. */
export const vaultNotes: VaultNote[] = Array.from({ length: 25 }, (_, i) => note(i, 20));

