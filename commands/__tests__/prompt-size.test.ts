import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  capOrganizationalNotes,
  summarizeArchivedFocusDocs,
  summarizePreviousBragBooks,
  DEFAULT_VAULT_NOTE_CAP,
  type VaultNote,
} from "../../lib/sdk/vault";
import type { TeamTimeline } from "../../lib/sdk/vault";
import { selectOpenFocusItems, summarizeFocusHistory, DEFAULT_INJECT_CAP } from "../../lib/sdk/focus";
import { DEFAULT_IMPACT_WINDOW_WEEKS } from "../../lib/sdk/vault";
import type { WeekInfo } from "../../lib/sdk/data-fetch";
import {
  config, timeline, weekInfo, focusTrackingContent, previousBragBooks, workContextContent, focusDocContent,
  focusHistoryContent, memoryContent, profileContent, impactLogContent, coachPersona,
  careerContext, workLogContent, vaultNotes, vaultNotesBefore,
} from "./prompt-fixtures";

/** Nothing here reads the user's vault, and no AI call is made. */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What the weekly command derives from `focus-tracking.md` before calling the builder. */
const openFocusItems = selectOpenFocusItems(focusTrackingContent, DEFAULT_INJECT_CAP);
const focusHistorySummary = summarizeFocusHistory(focusTrackingContent, "2026-W01");

async function buildPrompt() {
  // vitest runs on node, and the builder reads the prompt templates through Bun.file.
  vi.stubGlobal("Bun", { file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }) });
  vi.resetModules();
  const { buildBragBookPrompt } = await import("../worklog");

  return buildBragBookPrompt(
    workLogContent, previousBragBooks, workContextContent, memoryContent, profileContent,
    impactLogContent, coachPersona, focusDocContent, focusHistoryContent, careerContext,
    vaultNotes, openFocusItems, focusHistorySummary, null, timeline, weekInfo, config,
  );
}

const noteBytes = (notes: readonly VaultNote[]) =>
  notes.reduce((sum, n) => sum + n.title.length + n.excerpt.length, 0);

/**
 * What the same fixtures produced before this change, worked out from the inputs the builder now
 * replaces. Each trimmed document appears exactly once in the prompt, so those differences are
 * exact. The notes are counted by their own bytes, which leaves out a few characters of identical
 * `### title` glue per note, so this is a slight underestimate of what was saved.
 */
function untrimmedLength(trimmed: number): number {
  return trimmed
    + (workContextContent.length - capOrganizationalNotes(workContextContent).length)
    + (previousBragBooks.length - summarizePreviousBragBooks(previousBragBooks).length)
    + (focusHistoryContent.length - summarizeArchivedFocusDocs(focusHistoryContent).length)
    + (noteBytes(vaultNotesBefore) - noteBytes(vaultNotes.slice(0, DEFAULT_VAULT_NOTE_CAP)));
}

/** How much of an input survives the trim, as a fraction. */
function survives(before: string, after: string): number {
  return after.length / before.length;
}

describe("brag book prompt size", () => {
  it("halves a realistic prompt", async () => {
    const { prompt } = await buildPrompt();
    const before = untrimmedLength(prompt.length);

    // The live prompt measured 254k characters; these fixtures are sized to match.
    expect(before).toBeGreaterThan(240_000);

    // Measured at 50% on these fixtures. The threshold has headroom because the ratio also
    // depends on the inputs this phase does not touch: memory, career docs, the impact log and
    // the prompt template are 80k of floor between them, and their real sizes are an estimate.
    // The per-section assertions below are the ones that pin this change's own behaviour.
    expect(prompt.length).toBeLessThan(before * 0.55);
  });

  it("cuts each input it is responsible for", async () => {
    expect(survives(workContextContent, capOrganizationalNotes(workContextContent))).toBeLessThan(0.25);
    expect(survives(previousBragBooks, summarizePreviousBragBooks(previousBragBooks))).toBeLessThan(0.15);
    expect(noteBytes(vaultNotes.slice(0, DEFAULT_VAULT_NOTE_CAP)) / noteBytes(vaultNotesBefore)).toBeLessThan(0.3);
  });

  it("keeps the material the coach actually reasons over", async () => {
    const { prompt } = await buildPrompt();

    // Last week's achievements, so continuity survives.
    expect(prompt).toContain("Achievement 0 on the Search Revamp");
    expect(prompt).toContain("Review sentence 0");
    // The current focus doc, in full.
    expect(prompt).toContain("Current P0 item 0");
    expect(prompt).toContain("Current P1 item 7");
    // The live organisational notes.
    expect(prompt).toContain("Organisational note 0");
    // This week's work log.
    expect(prompt).toContain("[TEAM-1200] Ticket 0");
    expect(prompt).toContain("org/repo#4300");
    // The fixed work-context sections.
    expect(prompt).toContain("Value 0:");
    expect(prompt).toContain("| Self-review | 2026-06-01 |");
  });

  it("keeps the stale-item signal the coaching rules depend on", async () => {
    const { prompt } = await buildPrompt();

    // An item open in both archives appears once, with the versions it survived, so the coach
    // can still see that a P0 has been sitting unchanged.
    expect(prompt).toContain("P0 item 0, still open and unchanged since the version before");
    expect(prompt).toContain("first seen 2026-02-01, last seen 2026-03-01");
    // An item that only ever appeared in one archive says so.
    expect(prompt).toContain("Only in the March version");
    expect(prompt).toContain("seen in 2026-03-01");
  });

  it("drops the material that was being sent twice", async () => {
    const { prompt } = await buildPrompt();

    // Old coaching sessions: already acted on, and their outcomes are in the vault files.
    expect(prompt).not.toContain("Coaching sentence 0");
    expect(prompt).not.toContain("Suggestion 0 from a week");
    // Archived era notes, and organisational notes past the cap.
    expect(prompt).not.toContain("Archived note 0");
    expect(prompt).not.toContain("Organisational note 199");
    // Closed items are kept as their author wrote them.
    expect(prompt).toContain("Closed P0 item 0");
  });

  it("ranks a historical week's notes by the prefixes that week's team used", async () => {
    // The team timeline says this week belonged to a team using OLD; the current profile only
    // knows TEAM. Scoring against the profile finds nothing, and the one relevant note is as
    // likely to be cut by the ten-note cap as any of the noise around it.
    const oldTeam: TeamTimeline = {
      entries: [{ team: "Old Team", domain: null, start: "2024-01-01", end: null, ticketPrefixes: ["OLD"], notes: null }],
      transitionNotes: [],
    };
    const oldWorkLog = "# Work Log\n\n## Jira Tasks (1)\n\n### [OLD-42] A ticket from the old team\n";
    const notes: VaultNote[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ title: `Noise ${i}`, excerpt: "unrelated" })),
      { title: "The one that matters", excerpt: "notes on OLD-42" },
    ];

    vi.stubGlobal("Bun", { file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }) });
    vi.resetModules();
    const { buildBragBookPrompt } = await import("../worklog");

    const { prompt } = await buildBragBookPrompt(
      oldWorkLog, previousBragBooks, workContextContent, memoryContent, profileContent,
      impactLogContent, coachPersona, focusDocContent, focusHistoryContent, careerContext,
      notes, [], "", null, oldTeam, weekInfo, config,
    );

    expect(prompt).toContain("The one that matters");
  });

  it("keeps the vault notes that mention this week's work and drops the rest", async () => {
    const { prompt } = await buildPrompt();

    expect(prompt).toContain("Sprint planning 0");
    expect(prompt).not.toContain("Unrelated note 24");
  });

  it("accounts for every character of the prompt", async () => {
    const { prompt, sections } = await buildPrompt();

    expect(Object.keys(sections).sort()).toEqual([
      "career", "context", "focusArchives", "focusDoc", "focusHistorySummary", "focusOpenItems",
      "framing", "impact", "memory", "notes", "persona", "priorBrags", "profile", "template",
      "worklog",
    ]);

    const total = Object.values(sections).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(prompt.length);
  });

  it("accounts for every character of the memory section", async () => {
    const { sections, memoryInputs } = await buildPrompt();
    const total = memoryInputs.liveRows + memoryInputs.olderRows + memoryInputs.other;

    expect(total).toBe(sections.memory);
    expect(memoryInputs.liveRows).toBeGreaterThan(0);
    expect(memoryInputs.olderRows).toBeGreaterThan(0);
  });

  it("carries the focus doc whole, minus a table that is a spreadsheet", async () => {
    const { prompt, sections, omissions } = await buildPrompt();

    expect(omissions.focusDocTablesOmitted).toBe(1);
    expect(prompt).toContain("_(table of 128 rows omitted from the coaching prompt)_");
    // The priorities and the prose around the table are what the coach reads.
    expect(prompt).toContain("Current P0 item 0");
    expect(prompt).toContain("## Tracking");
    expect(prompt).toContain("Everything in flight, kept here because it has to live somewhere.");
    expect(prompt).toContain("Person 0, about the thing they own");
    expect(prompt).not.toContain("Tracked item 0,");
    expect(sections.focusDoc).toBeLessThan(focusDocContent.length / 4);
  });

  it("carries a year of impact rows and counts the rest", async () => {
    const { prompt, sections, omissions } = await buildPrompt();

    // Measured from the week being generated, not from today: regenerating an old week must see
    // what that week could have seen, so the cutoff moves with `weekInfo`.
    const cutoff = new Date(weekInfo.startDate.getTime() - DEFAULT_IMPACT_WINDOW_WEEKS * 7 * 86_400_000)
      .toISOString()
      .split("T")[0];
    const olderThanWindow = impactLogContent
      .split("\n")
      .filter((line) => line.startsWith("| 2") && line.slice(2, 12) < cutoff).length;

    expect(olderThanWindow).toBeGreaterThan(0);
    expect(omissions.impactRowsDropped).toBe(olderThanWindow);
    expect(prompt).toContain(`_(${omissions.impactRowsDropped} older entries not shown)_`);
    // The gap analysis is what the coach does with this file.
    expect(prompt).toContain("**Last significant impact:**");
    expect(prompt).toContain("**Current gap:**");
    expect(prompt).toContain("## Impact Timeline");
    expect(sections.impact).toBeLessThan(impactLogContent.length);
  });

  it("shows a historical week only what that week could have seen", async () => {
    // The fixture's impact rows run to 2026-03-16. A 2024 week must see none of them, and its
    // gap lines must be recomputed from what was on the record then, not from the file's own
    // lines, which describe today.
    const weekIn2024: WeekInfo = {
      weekNumber: 10,
      year: 2024,
      startDate: new Date("2024-03-04T00:00:00Z"),
      endDate: new Date("2024-03-10T00:00:00Z"),
      filename: "2024-W10 Work Log.md",
    };

    vi.stubGlobal("Bun", { file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }) });
    vi.resetModules();
    const { buildBragBookPrompt } = await import("../worklog");

    const { prompt } = await buildBragBookPrompt(
      workLogContent, previousBragBooks, workContextContent, memoryContent, profileContent,
      impactLogContent, coachPersona, focusDocContent, focusHistoryContent, careerContext,
      vaultNotes, [], "", null, timeline, weekIn2024, config,
    );

    // Only the impact section: memory rows are dated too, and they answer a different question.
    const impactSection = prompt.slice(
      prompt.indexOf("<impact_log>"),
      prompt.indexOf("</impact_log>"),
    );
    const impactDates = impactSection
      .split("\n")
      .filter((line) => line.startsWith("| 2"))
      .map((line) => line.slice(2, 12));

    expect(impactDates.length).toBeGreaterThan(0);
    // Nothing dated after that week's end reached the prompt.
    expect(impactDates.every((date) => date <= "2024-03-10")).toBe(true);

    // The status lines describe that week, not today.
    const lastImpact = impactSection.split("\n").find((line) => line.startsWith("**Last significant impact:**")) ?? "";
    expect(lastImpact).not.toContain("2026");
    expect(lastImpact.slice(-10) <= "2024-03-10").toBe(true);
  });

  it("measures the current week's gap from the week, not from whenever the suite runs", async () => {
    const { prompt } = await buildPrompt();
    const gap = prompt.split("\n").find((line) => line.startsWith("**Current gap:**")) ?? "";

    // The fixture's latest impact is inside the fixture week, so the gap is closed. Measuring
    // from the real clock instead would grow it by however long ago this fixture was written.
    expect(gap).toBe("**Current gap:** None - recent entry added");
  });

  it("never carries the focus-tracking table, only what the coach acts on", async () => {
    const { prompt, sections } = await buildPrompt();

    // 410 rows in the file; ten commitments and one tally line reach the prompt.
    expect(focusTrackingContent.length).toBeGreaterThan(50_000);
    expect(sections.focusOpenItems).toBeLessThan(2_000);
    expect(sections.focusHistorySummary).toBeLessThan(200);
    expect(prompt).not.toContain("Notes on commitment 0");
    expect(prompt).not.toContain("Focus commitment 0,");
  });
});
