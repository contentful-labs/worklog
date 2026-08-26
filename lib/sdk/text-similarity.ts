/**
 * Comparing two pieces of model-written prose for "same thing said differently".
 *
 * Every vault writer needs this: the model rewords its own suggestions week to week,
 * so identity has to survive rewording. Tuned on focus tracking first, now shared by
 * the record writers in `vault-updates.ts`.
 */

/**
 * Drop the target of every markdown link, keeping the label.
 *
 * A scan rather than a `\[([^\]]*)\]\([^)]*\)` regex: that pattern backtracks
 * polynomially on crafted input (CodeQL js/polynomial-redos), and this text comes
 * straight from model output.
 */
function stripLinkTargets(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "]" && text[i + 1] === "(") {
      const end = text.indexOf(")", i + 2);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    result += text[i];
    i++;
  }
  return result;
}

/** Strip markdown down to comparable words. */
export function normalizeText(text: string): string {
  // Bracket syntax is left to the alphanumeric filter below; only the URL has to go,
  // since otherwise every item carrying a Jira link would look alike.
  return stripLinkTargets(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Function words carry no identity, so counting them drags the score of two short
 * rewordings of the same suggestion below the threshold.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was",
  "were", "has", "have", "had", "its", "our", "their", "them", "then", "than", "but", "not",
  "all", "any", "can", "out", "off", "per", "via", "get", "through", "before", "after",
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

/** Below this many significant words, containment is too easy to hit by accident. */
const MIN_TOKENS_FOR_CONTAINMENT = 4;

/**
 * Score at or above which one text is taken to be a restatement of another.
 *
 * Tuned on real focus items, where the costly outcome is a miss: an unmatched item
 * stays open forever, and a false match only merges two commitments the coach can
 * still see. Use it for lookups, not for rejecting new records.
 */
export const SIMILARITY_THRESHOLD = 0.6;

/**
 * Score at or above which two prose records are the same fact written twice.
 *
 * Higher than the lookup threshold because rejecting an insert throws information
 * away silently. Measured over 163 real organizational notes, scoring each against
 * all the others: 37 of them would be rejected at 0.60, 30 at 0.70, 22 from 0.75
 * through 0.85, and 11 at 0.90. Reading the pairs, everything scoring 0.85 or above
 * was a genuine rewording of the same fact, while the 0.60 to 0.75 band was mostly
 * distinct notes that share vocabulary because they describe the same system.
 * Do not lower this back to 0.6.
 */
export const PROSE_SIMILARITY_THRESHOLD = 0.85;

/**
 * How much two suggestions are the same thing said differently.
 *
 * Jaccard alone is too strict here: one item is usually an elaboration of the other,
 * so the extra ticket numbers and trailing clauses in the longer one drag real
 * duplicates down to ~0.3. Containment (shared / smaller set) separates them cleanly,
 * but it reaches 1.0 whenever the shorter item is tiny, so it is only trusted once
 * both items carry enough substance.
 */
export function textSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;

  const jaccard = shared / (left.size + right.size - shared);
  const smaller = Math.min(left.size, right.size);
  if (smaller < MIN_TOKENS_FOR_CONTAINMENT) return jaccard;
  return Math.max(jaccard, shared / smaller);
}
