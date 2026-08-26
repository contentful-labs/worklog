import { describe, it, expect } from "vitest";
import { SIMILARITY_THRESHOLD, normalizeText, textSimilarity } from "../text-similarity";
import { normalizeFocusText, focusSimilarity } from "../focus";

describe("normalizeText", () => {
  it("drops link targets, markdown and punctuation", () => {
    expect(normalizeText("Get **[TEAM-1234](https://example.com/TEAM-1234)** through [[review]]"))
      .toBe("get team 1234 through review");
  });

  it("is idempotent, so already-normalized text can be compared again", () => {
    const once = normalizeText("Ship the Search Revamp rollout plan (TEAM-1234)");
    expect(normalizeText(once)).toBe(once);
  });

  it("returns an empty string for text with no words", () => {
    expect(normalizeText("  --- ")).toBe("");
  });
});

describe("textSimilarity", () => {
  it("scores a reworded elaboration as the same record", () => {
    const a = "Close the Search Revamp release correctness loop through TEAM-1234";
    const b = "Close the Search Revamp release correctness work through TEAM-1234 and TEAM-1235";
    expect(textSimilarity(a, b)).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it("keeps two unrelated records apart", () => {
    const a = "Write the migration guide for the search index rebuild";
    const b = "Pair with the on-call engineer on alert noise";
    expect(textSimilarity(a, b)).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("does not let a short item be contained by a long one", () => {
    // Two significant words would hit containment 1.0 if containment were trusted here.
    expect(textSimilarity("Search Revamp", "Search Revamp rollout plan review with the platform team"))
      .toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("scores empty text as no match at all", () => {
    expect(textSimilarity("", "anything at all here")).toBe(0);
  });
});

describe("focus re-exports", () => {
  it("keeps the focus-named helpers pointing at the shared implementation", () => {
    expect(normalizeFocusText).toBe(normalizeText);
    expect(focusSimilarity).toBe(textSimilarity);
  });
});
