import { describe, it, expect } from "vitest";
import { SIMILARITY_THRESHOLD, canonicalText, normalizeText, textSimilarity } from "../text-similarity";
import { normalizeFocusText, focusSimilarity } from "../focus";

describe("normalizeText", () => {
  it("drops link targets, markdown and punctuation", () => {
    expect(normalizeText("Get **[TEAM-1234](https://example.com/TEAM-1234)** through [[review]]"))
      .toBe("get team-1234 through review");
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

describe("thresholds", () => {
  const relatedButDistinct = [
    "The ingest service is the intake and normalization layer for search-relevant events",
    "The ingest service normalizes search-relevant events before they reach the indexer",
  ];

  it("clears the lookup threshold for two notes that say different things", () => {
    // The score cannot tell these apart, which is the whole reason nothing on the
    // insert path consults it: rejecting the second would lose what it says.
    const score = textSimilarity(relatedButDistinct[0], relatedButDistinct[1]);
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores a fact and its negation as unrelated", () => {
    // "not" used to be a stopword, so these tokenized identically and the correction
    // was rejected as a duplicate of the note it corrects.
    expect(textSimilarity("Release trains ship on Tuesdays", "Release trains do not ship on Tuesdays")).toBe(0);
    expect(textSimilarity("The rota covers weekends", "The rota never covers weekends")).toBe(0);
  });

  it("still matches two negated statements of the same fact", () => {
    const score = textSimilarity(
      "Release trains do not ship on Tuesdays any more",
      "Release trains no longer ship on Tuesdays",
    );
    expect(score).toBeGreaterThan(0);
  });

  it("scores a genuine rewording above the prose threshold", () => {
    const score = textSimilarity(
      "Release readiness reviews moved from Tuesday to Wednesday",
      "Release readiness reviews now happen on Wednesday, moved from Tuesday",
    );
    expect(score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });
});

describe("contractions", () => {
  const affirmative = "Release trains ship on Tuesdays";

  it("reads a contracted negation as a negation", () => {
    for (const negated of [
      "Release trains don't ship on Tuesdays",
      "Release trains don’t ship on Tuesdays",
      "Release trains aren't shipping on Tuesdays",
      "Release trains won't ship on Tuesdays",
      "Release trains can't ship on Tuesdays",
    ]) {
      expect(textSimilarity(affirmative, negated), negated).toBe(0);
    }
  });

  it("expands every negated contraction the model writes", () => {
    for (const [contracted, expected] of [
      ["don't", "do not"],
      ["doesn't", "does not"],
      ["isn't", "is not"],
      ["can't", "ca not"],
      ["won't", "wo not"],
      ["didn't", "did not"],
      ["aren't", "are not"],
      ["wasn't", "was not"],
      ["weren't", "were not"],
      ["shouldn't", "should not"],
      ["couldn't", "could not"],
      ["wouldn't", "would not"],
      ["haven't", "have not"],
      ["hasn't", "has not"],
      ["hadn't", "had not"],
    ]) {
      expect(normalizeText(contracted), contracted).toBe(expected);
    }
  });
});

describe("versions, languages and ticket numbers", () => {
  const distinct: Array<[string, string]> = [
    ["Builds C++ toolchains", "Builds C# toolchains"],
    ["Runs Go 1.22 services", "Runs Go 1.23 services"],
    ["Runs node.js 20 in CI", "Runs node.js 22 in CI"],
    ["Ships the TEAM-1234 rollout to every space", "Ships the TEAM-1235 rollout to every space"],
  ];

  it("scores a pair that differs only in a version or a name as unrelated", () => {
    for (const [a, b] of distinct) {
      expect(textSimilarity(a, b), a).toBe(0);
      expect(textSimilarity(b, a), b).toBe(0);
    }
  });

  it("keeps those names as tokens instead of stripping them to nothing", () => {
    expect(normalizeText("Builds C++ toolchains, Go 1.22 and node.js."))
      .toBe("builds c++ toolchains go 1.22 and node.js");
    expect(normalizeText("Ships C#, F# and 1.2.3")).toBe("ships c# f# and 1.2.3");
  });

  it("still reads a longer version of the same record as the same record", () => {
    // One naming a superset of the other's tickets is an elaboration, not a new record.
    const score = textSimilarity(
      "Close the Search Revamp correctness loop through TEAM-1234",
      "Close the Search Revamp correctness loop through TEAM-1234 and TEAM-1235",
    );
    expect(score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it("still reads a plain rewording as the same record", () => {
    expect(textSimilarity("Release trains ship on Tuesdays", "Release trains now ship Tuesdays"))
      .toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });
});

describe("canonical equality, the insert-side test", () => {
  it("folds only case and spacing", () => {
    expect(canonicalText("  Release   trains SHIP on Tuesdays ")).toBe("release trains ship on tuesdays");
    expect(canonicalText("Builds C++ toolchains")).not.toBe(canonicalText("Builds C# toolchains"));
    expect(canonicalText("Release trains ship on Tuesdays"))
      .not.toBe(canonicalText("Release trains ship on Tuesdays and require manager approval"));
  });
});

describe("a name on one side only", () => {
  it("scores a general statement and a specific one as unrelated", () => {
    expect(textSimilarity("Services run on Go in production", "Services run on Go 1.22 in production")).toBe(0);
    expect(textSimilarity("Ship the rollout", "Ship the TEAM-1234 rollout")).toBe(0);
  });

  it("keeps a ticket key atomic so two keys never share a token", () => {
    expect(normalizeText("TEAM-1234 and CORE-1234")).toBe("team-1234 and core-1234");
    expect(textSimilarity("Ship the TEAM-1234 rollout to every space", "Ship the CORE-1234 rollout to every space")).toBe(0);
  });
});
