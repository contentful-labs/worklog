import { describe, it, expect } from "vitest";
import {
  capOrganizationalNotes,
  collectWorkTerms,
  containsIdentifier,
  extractBragBookSummary,
  rankVaultNotes,
  summarizeArchivedFocusDocs,
  summarizePreviousBragBooks,
  DEFAULT_ORG_NOTE_CAP,
  DEFAULT_VAULT_NOTE_CAP,
  type VaultNote,
} from "../vault";

const BRAG_BOOK = `# Brag Book - Week 12, 2026

## Achievements

- Led the Search Revamp rollout, TEAM-1234

## Stats

| Metric | Count |
|--------|-------|
| Jira | 7 |

## Week in Review

Shipped the rollout behind a flag.

## Items to Add to [[memory]]

- Reviewed three PRs

## Mentor Notes

### What Went Well

You finally wrote the design doc.

### Focus for Next Week

1. Talk to the platform team.

## [[impact-log]] Update

| 2026-03-20 | Rollout | Team | Craft | TEAM-1234 |
`;

describe("extractBragBookSummary", () => {
  it("keeps the achievements and the week in review", () => {
    const summary = extractBragBookSummary(BRAG_BOOK);

    expect(summary).toContain("## Achievements");
    expect(summary).toContain("Led the Search Revamp rollout, TEAM-1234");
    expect(summary).toContain("## Week in Review");
    expect(summary).toContain("Shipped the rollout behind a flag.");
  });

  it("drops the coaching session, the stats and the vault updates", () => {
    const summary = extractBragBookSummary(BRAG_BOOK);

    expect(summary).not.toContain("Mentor Notes");
    expect(summary).not.toContain("Focus for Next Week");
    expect(summary).not.toContain("Talk to the platform team");
    expect(summary).not.toContain("## Stats");
    expect(summary).not.toContain("impact-log");
  });

  it("cuts a real-sized entry down by most of its bytes", () => {
    expect(extractBragBookSummary(BRAG_BOOK).length).toBeLessThan(BRAG_BOOK.length / 2);
  });

  it("returns nothing for a document with neither section", () => {
    expect(extractBragBookSummary("# Notes\n\n## Something Else\n\nbody\n")).toBe("");
  });

  it("ignores a heading that only starts with the section name", () => {
    const summary = extractBragBookSummary("## Achievements Backlog\n\nnot this\n");
    expect(summary).toBe("");
  });
});

describe("summarizePreviousBragBooks", () => {
  const joined = `### 2026-W11\n\n${BRAG_BOOK}\n\n---\n\n### 2026-W12\n\n${BRAG_BOOK}`;

  it("keeps the week label with each summary", () => {
    const summary = summarizePreviousBragBooks(joined);

    expect(summary).toContain("### 2026-W11");
    expect(summary).toContain("### 2026-W12");
    expect(summary).toContain("## Achievements");
    expect(summary).not.toContain("Mentor Notes");
  });

  it("passes through the reader's placeholder, which has no sections to summarize", () => {
    const none = "No brag book entries found.";
    expect(summarizePreviousBragBooks(none)).toBe(none);
  });

  it("returns nothing when the documents have sections but none of the ones it wants", () => {
    const renamed = "### 2026-W11\n\n## Wins\n\n- something\n";
    expect(summarizePreviousBragBooks(renamed)).toBe("");
  });
});

const ARCHIVED_FOCUS = `### Focus Doc archived 2026-03-01

## P0 - Own & Deliver

- [x] Ship the rollout
- Keep the migration moving
- ~~Rewrite the importer~~

## P1 - Influence & Shape

- DONE: Wrote the RFC
- Pair with the new joiner
- **Dropped** the second spike

## People to Talk To

- Someone on the platform team
`;

describe("summarizeArchivedFocusDocs", () => {
  it("keeps the headings", () => {
    const summary = summarizeArchivedFocusDocs(ARCHIVED_FOCUS);

    expect(summary).toContain("### Focus Doc archived 2026-03-01");
    expect(summary).toContain("## P0 - Own & Deliver");
    expect(summary).toContain("## People to Talk To");
  });

  it("keeps items the author closed off, however they marked them", () => {
    const summary = summarizeArchivedFocusDocs(ARCHIVED_FOCUS);

    expect(summary).toContain("- [x] Ship the rollout");
    expect(summary).toContain("~~Rewrite the importer~~");
    expect(summary).toContain("DONE: Wrote the RFC");
    expect(summary).toContain("**Dropped** the second spike");
  });

  it("does not also carry a closed item as though it were still open", () => {
    const summary = summarizeArchivedFocusDocs(ARCHIVED_FOCUS);
    const carriedAt = summary.indexOf("## Open items carried across archived focus docs");

    expect(carriedAt).toBeGreaterThan(-1);
    // remark runs here without the GFM plugin, so a ticked box arrives as literal `[x]` text
    // rather than as `checked`. Reading it wrong files a finished item as a stale one.
    expect(summary.slice(carriedAt)).not.toContain("Ship the rollout");
    expect(summary.slice(carriedAt)).not.toContain("Rewrite the importer");
    expect(summary.slice(carriedAt)).not.toContain("Wrote the RFC");
  });

  it("carries open items into one compact list instead of repeating them", () => {
    const summary = summarizeArchivedFocusDocs(ARCHIVED_FOCUS);

    expect(summary).toContain("## Open items carried across archived focus docs");
    expect(summary).toContain("- Keep the migration moving _(seen in 2026-03-01)_");
    expect(summary).toContain("- Pair with the new joiner _(seen in 2026-03-01)_");
  });

  it("keeps an item that survived two archives once, naming both", () => {
    const twoArchives = [
      "### Focus Doc archived 2026-03-01",
      "",
      "## P0 - Own & Deliver",
      "",
      "- Ship migration",
      "",
      "---",
      "",
      "### Focus Doc archived 2026-02-01",
      "",
      "## P0 - Own & Deliver",
      "",
      "- Ship migration",
    ].join("\n");

    const summary = summarizeArchivedFocusDocs(twoArchives);
    const occurrences = summary.split("Ship migration").length - 1;

    expect(occurrences).toBe(1);
    expect(summary).toContain("- Ship migration _(first seen 2026-02-01, last seen 2026-03-01)_");
  });

  it("folds case and spacing when deciding two items are the same", () => {
    const restyled = [
      "### Focus Doc archived 2026-03-01",
      "- Ship  the   Migration",
      "",
      "---",
      "",
      "### Focus Doc archived 2026-02-01",
      "- ship the migration",
    ].join("\n");

    const summary = summarizeArchivedFocusDocs(restyled);

    expect(summary.split("igration").length - 1).toBe(1);
    expect(summary).toContain("first seen 2026-02-01, last seen 2026-03-01");
  });

  it("keeps genuinely different wording apart, since a rewrite may be a new commitment", () => {
    // canonicalText folds case and whitespace, not punctuation. Being wrong here costs one
    // extra carried line, which is the right way round for a de-duplication.
    const punctuated = [
      "### Focus Doc archived 2026-03-01",
      "- Ship the migration.",
      "",
      "---",
      "",
      "### Focus Doc archived 2026-02-01",
      "- Ship the migration",
    ].join("\n");

    expect(summarizeArchivedFocusDocs(punctuated).split("igration").length - 1).toBe(2);
  });

  it("does not mistake a word merely starting with a marker for a closed item", () => {
    const summary = summarizeArchivedFocusDocs("- Donation flow needs a spike\n");

    // Not closed, so it is carried rather than kept verbatim under a heading.
    expect(summary).toContain("## Open items carried across archived focus docs");
    expect(summary).toContain("- Donation flow needs a spike");
    expect(summary).not.toContain("- [x]");
  });
});

describe("markdown structure, not lines", () => {
  it("does not treat a heading inside a fenced block as a real one", () => {
    const content = [
      "# Work Context",
      "",
      "## Organizational Notes",
      "",
      "- **Process:** A real note _(2026-W10)_",
      "",
      "```md",
      "## ARCHIVED - an example of what an era heading looks like",
      "```",
      "",
      "## Review Cycle",
      "",
      "| Type | Date |",
    ].join("\n");

    const trimmed = capOrganizationalNotes(content, 40);

    expect(trimmed).toContain("A real note");
    expect(trimmed).toContain("## Review Cycle");
    expect(trimmed).toContain("| Type | Date |");
  });

  it("does not let a fenced section heading truncate a brag book section", () => {
    const content = [
      "## Achievements",
      "",
      "- Shipped the thing",
      "",
      "```md",
      "## Stats",
      "```",
      "",
      "- And another thing",
      "",
      "## Mentor Notes",
      "",
      "coaching",
    ].join("\n");

    const summary = extractBragBookSummary(content);

    expect(summary).toContain("- Shipped the thing");
    expect(summary).toContain("- And another thing");
    expect(summary).not.toContain("coaching");
  });

  it("sees a setext heading", () => {
    const content = [
      "Work Context",
      "============",
      "",
      "Organizational Notes",
      "--------------------",
      "",
      "- Note one",
      "- Note two",
      "- Note three",
      "",
      "ARCHIVED - Old Era",
      "------------------",
      "",
      "- Old note",
    ].join("\n");

    const trimmed = capOrganizationalNotes(content, 2);

    // A setext heading spans two lines; the section has to start at the text, not the underline.
    expect(trimmed).toContain("Organizational Notes\n--------------------");
    expect(trimmed).toContain("- Note one");
    expect(trimmed).toContain("- Note two");
    expect(trimmed).not.toContain("- Note three");
    expect(trimmed).not.toContain("ARCHIVED - Old Era");
    expect(trimmed).not.toContain("- Old note");
  });

  it("sees a closing-hash heading", () => {
    const summary = extractBragBookSummary("## Achievements ##\n\n- Shipped it\n\n## Stats ##\n\n| a |\n");

    expect(summary).toContain("## Achievements ##");
    expect(summary).toContain("- Shipped it");
    expect(summary).not.toContain("| a |");
  });

  it("sees an indented heading", () => {
    const summary = extractBragBookSummary("   ## Achievements\n\n- Shipped it\n\n## Stats\n\n| a |\n");

    expect(summary).toContain("- Shipped it");
    expect(summary).not.toContain("| a |");
  });

  it("handles CRLF line endings", () => {
    const summary = extractBragBookSummary("## Achievements\r\n\r\n- Shipped it\r\n\r\n## Stats\r\n\r\n| a |\r\n");

    expect(summary).toContain("- Shipped it");
    expect(summary).not.toContain("| a |");
  });

  it("does not treat a blockquoted heading as a section boundary", () => {
    const summary = extractBragBookSummary("## Achievements\n\n- Shipped it\n\n> ## Stats\n\n- Still ours\n\n## Mentor Notes\n\ncoaching\n");

    expect(summary).toContain("- Shipped it");
    expect(summary).toContain("- Still ours");
    expect(summary).not.toContain("coaching");
  });
});

function workContext(noteCount: number, archived = false): string {
  const notes = Array.from(
    { length: noteCount },
    (_, i) => `- **Process:** Organisational note ${i} _(2026-W${10 + (i % 40)})_`,
  );
  return [
    "# Work Context",
    "",
    "## Company Core Values",
    "",
    "- Craft",
    "- Ownership",
    "",
    "## Review Cycle",
    "",
    "| Type | Date |",
    "|------|------|",
    "| Self-review | 2026-06-01 |",
    "",
    "## Organizational Notes",
    "",
    ...notes,
    ...(archived ? ["", "## ARCHIVED - Previous Team", "", "- **Process:** An old note _(2024-W01)_"] : []),
    "",
  ].join("\n");
}

describe("capOrganizationalNotes", () => {
  it("keeps the fixed sections whole", () => {
    const trimmed = capOrganizationalNotes(workContext(100));

    expect(trimmed).toContain("## Company Core Values");
    expect(trimmed).toContain("- Craft");
    expect(trimmed).toContain("## Review Cycle");
    expect(trimmed).toContain("| Self-review | 2026-06-01 |");
  });

  it("keeps the most recent notes, which the writer inserts at the top", () => {
    const trimmed = capOrganizationalNotes(workContext(100), 3);

    expect(trimmed).toContain("Organisational note 0");
    expect(trimmed).toContain("Organisational note 2");
    expect(trimmed).not.toContain("Organisational note 3");
  });

  it("says how many notes it left out", () => {
    expect(capOrganizationalNotes(workContext(100), 3)).toContain("97 older organisational note(s) omitted");
  });

  it("keeps every note when there are fewer than the cap, and says nothing", () => {
    const trimmed = capOrganizationalNotes(workContext(5), 40);

    expect(trimmed).toContain("Organisational note 4");
    expect(trimmed).not.toContain("omitted");
  });

  it("drops archived era subsections", () => {
    const trimmed = capOrganizationalNotes(workContext(5, true));

    expect(trimmed).not.toContain("ARCHIVED - Previous Team");
    expect(trimmed).not.toContain("An old note");
  });

  it("defaults to a cap of 40", () => {
    const trimmed = capOrganizationalNotes(workContext(100));

    expect(trimmed).toContain(`Organisational note ${DEFAULT_ORG_NOTE_CAP - 1}`);
    expect(trimmed).not.toContain(`Organisational note ${DEFAULT_ORG_NOTE_CAP}`);
  });
});

describe("collectWorkTerms", () => {
  const workLog = `## Jira Tasks (2)

### [TEAM-1234] Search Revamp
### [OTHER-77] Unrelated

## GitHub Pull Requests (1)

### [org/repo#4321] Add the flag
`;

  it("finds ticket keys for the configured prefixes", () => {
    const terms = collectWorkTerms(workLog, ["TEAM"]);

    expect(terms).toContain("TEAM-1234");
    expect(terms).not.toContain("OTHER-77");
  });

  it("finds pull request numbers", () => {
    expect(collectWorkTerms(workLog, ["TEAM"])).toContain("#4321");
  });

  it("is case insensitive about the prefix", () => {
    expect(collectWorkTerms("worked on team-99 today", ["team"])).toContain("TEAM-99");
  });

  it("ignores a prefix with no number after it", () => {
    expect(collectWorkTerms("TEAM- was renamed", ["TEAM"])).toEqual([]);
  });

  it("requires an identifier boundary before the prefix", () => {
    expect(collectWorkTerms("STEAM-123 is a different system", ["TEAM"])).toEqual([]);
    expect(collectWorkTerms("see TEAM-123 today", ["TEAM"])).toEqual(["TEAM-123"]);
    expect(collectWorkTerms("(TEAM-123)", ["TEAM"])).toEqual(["TEAM-123"]);
  });

  it("requires an identifier boundary after the number", () => {
    expect(collectWorkTerms("TEAM-123abc", ["TEAM"])).toEqual([]);
    expect(collectWorkTerms("#4321x", ["TEAM"])).toEqual([]);
  });

  it("returns nothing when there are no prefixes configured and no PR numbers", () => {
    expect(collectWorkTerms("plain prose", [])).toEqual([]);
  });
});

describe("rankVaultNotes", () => {
  const notes: VaultNote[] = [
    { title: "Grocery list", excerpt: "milk" },
    { title: "Sprint planning", excerpt: "discussed TEAM-1234 and #4321" },
    { title: "Retro", excerpt: "mentioned TEAM-1234" },
  ];

  it("puts the notes that name this week's work first", () => {
    const ranked = rankVaultNotes(notes, ["TEAM-1234", "#4321"], 3);

    expect(ranked.map((n) => n.title)).toEqual(["Sprint planning", "Retro", "Grocery list"]);
  });

  it("caps the list", () => {
    expect(rankVaultNotes(notes, ["TEAM-1234"], 1).map((n) => n.title)).toEqual(["Sprint planning"]);
  });

  it("keeps the incoming order when nothing matches", () => {
    const ranked = rankVaultNotes(notes, [], 3);

    expect(ranked.map((n) => n.title)).toEqual(["Grocery list", "Sprint planning", "Retro"]);
  });

  it("defaults to ten notes", () => {
    const many: VaultNote[] = Array.from({ length: 25 }, (_, i) => ({ title: `Note ${i}`, excerpt: "" }));

    expect(rankVaultNotes(many, [])).toHaveLength(DEFAULT_VAULT_NOTE_CAP);
  });

  it("matches a term regardless of case", () => {
    const ranked = rankVaultNotes([{ title: "a", excerpt: "team-1234" }], ["TEAM-1234"], 1);

    expect(ranked).toHaveLength(1);
  });

  it("does not let a shorter key match a longer identifier", () => {
    const decoys: VaultNote[] = Array.from({ length: 10 }, (_, i) => ({
      title: `Decoy ${i}`,
      excerpt: "mentions TEAM-123 only",
    }));
    const real: VaultNote = { title: "Real", excerpt: "about TEAM-12" };

    const ranked = rankVaultNotes([...decoys, real], ["TEAM-12"], 10);

    // The decoys score nothing, so the one real match sorts above all ten of them.
    expect(ranked[0].title).toBe("Real");
  });

  it("scores every candidate before capping, so an older relevant note survives the noise", () => {
    const noisy: VaultNote[] = Array.from({ length: 25 }, (_, i) => ({
      title: `Recent unrelated ${i}`,
      excerpt: "nothing to do with this week",
    }));
    const oldest: VaultNote = { title: "Oldest but relevant", excerpt: "closes TEAM-123" };

    const ranked = rankVaultNotes([...noisy, oldest], ["TEAM-123"], 10);

    expect(ranked[0].title).toBe("Oldest but relevant");
  });
});

describe("containsIdentifier", () => {
  it.each([
    ["TEAM-123", "TEAM-123", true],
    ["STEAM-123", "TEAM-123", false],
    ["TEAM-1234", "TEAM-123", false],
    ["SEE TEAM-123.", "TEAM-123", true],
    ["(TEAM-123)", "TEAM-123", true],
    ["TEAM-123X", "TEAM-123", false],
    ["", "TEAM-123", false],
    ["TEAM-123", "", false],
  ])("%s contains %s: %s", (haystack, needle, expected) => {
    expect(containsIdentifier(haystack, needle)).toBe(expected);
  });
});
