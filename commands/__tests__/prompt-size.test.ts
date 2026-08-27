import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  capOrganizationalNotes,
  summarizeArchivedFocusDocs,
  summarizePreviousBragBooks,
  DEFAULT_VAULT_NOTE_CAP,
  type VaultNote,
} from "../../lib/sdk/vault";
import {
  config, timeline, weekInfo, previousBragBooks, workContextContent, focusDocContent,
  focusHistoryContent, memoryContent, profileContent, impactLogContent, coachPersona,
  careerContext, workLogContent, vaultNotes, vaultNotesBefore,
} from "./prompt-fixtures";

/** Nothing here reads the user's vault, and no AI call is made. */

afterEach(() => {
  vi.unstubAllGlobals();
});

async function buildPrompt() {
  // vitest runs on node, and the builder reads the prompt templates through Bun.file.
  vi.stubGlobal("Bun", { file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }) });
  vi.resetModules();
  const { buildBragBookPrompt } = await import("../worklog");

  return buildBragBookPrompt(
    workLogContent, previousBragBooks, workContextContent, memoryContent, profileContent,
    impactLogContent, coachPersona, focusDocContent, focusHistoryContent, careerContext,
    vaultNotes, [], "", null, timeline, weekInfo, config,
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

describe("brag book prompt size", () => {
  it("more than halves a realistic prompt", async () => {
    const { prompt } = await buildPrompt();
    const before = untrimmedLength(prompt.length);

    // The live prompt measured 254k characters; these fixtures are sized to match.
    expect(before).toBeGreaterThan(250_000);
    expect(prompt.length).toBeLessThan(before / 2);
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

  it("drops the material that was being sent twice", async () => {
    const { prompt } = await buildPrompt();

    // Old coaching sessions: already acted on, and their outcomes are in the vault files.
    expect(prompt).not.toContain("Coaching sentence 0");
    expect(prompt).not.toContain("Suggestion 0 from a week");
    // Archived era notes, and organisational notes past the cap.
    expect(prompt).not.toContain("Archived note 0");
    expect(prompt).not.toContain("Organisational note 199");
    // Archived focus items that are still open in the current doc.
    expect(prompt).not.toContain("Still-open item 0");
    expect(prompt).toContain("Closed P0 item 0");
  });

  it("keeps the vault notes that mention this week's work and drops the rest", async () => {
    const { prompt } = await buildPrompt();

    expect(prompt).toContain("Sprint planning 0");
    expect(prompt).not.toContain("Unrelated note 24");
  });

  it("reports where the bytes went", async () => {
    const { prompt, sections } = await buildPrompt();

    expect(Object.keys(sections).sort()).toEqual([
      "career", "context", "focus", "impact", "memory", "notes",
      "persona", "priorBrags", "profile", "template", "worklog",
    ]);

    // The parts account for the prompt bar the XML wrappers between them.
    const total = Object.values(sections).reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThan(prompt.length * 0.9);
    expect(total).toBeLessThanOrEqual(prompt.length);
  });
});
