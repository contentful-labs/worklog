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

export const memoryContent = ["# Memory", "", "## Core Team", "", "| Date | Item | Category | Notes |", "|---|---|---|---|",
  lines(280, (i) => `| 2026-03-0${i % 9} | Memory row ${i} about a small contribution | Category | Some notes |`)].join("\n");

export const profileContent = ["# Profile", "", "## Key Strengths", "", lines(60, (i) => `- Strength ${i}, observed over several weeks of work`)].join("\n");
export const impactLogContent = ["# Impact Log", "", "## Impact Timeline", "", "| Date | Achievement | Scope | Core Value | Evidence |", "|---|---|---|---|---|",
  lines(180, (i) => `| 2026-0${i % 9}-01 | Impact ${i} on a piece of work that mattered | Team | Craft | TEAM-${1000 + i} |`)].join("\n");
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

