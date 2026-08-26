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

/**
 * Case-folded text with runs of whitespace collapsed and nothing else touched.
 *
 * The lossless counterpart to `normalizeText`, for deciding that two stored records
 * are literally the same. `normalizeText` drops every symbol and non-ASCII letter, so
 * "Builds C++ toolchains" and "Builds C# toolchains" collapse onto the same string and
 * two notes written in a non-Latin script both collapse to "". Deleting on that basis
 * loses records that were never duplicates.
 */
export function canonicalText(text: string): string {
  return text.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Expand negated contractions so the negation survives punctuation stripping.
 *
 * Every one of don't, doesn't, isn't, can't, won't, didn't, aren't, wasn't, weren't,
 * shouldn't, couldn't, wouldn't, haven't, hasn't and hadn't ends in "n't", so one rule
 * covers them all. The result is not always English ("ca not"), which does not matter:
 * what matters is that the word "not" reaches the token set. Curly apostrophes are
 * folded first, since a note pasted from a word processor carries those.
 */
function expandNegatedContractions(text: string): string {
  return text.split("\u2019").join("'").split("n't").join(" not");
}

/** Strip markdown down to comparable words. */
export function normalizeText(text: string): string {
  // Bracket syntax is left to the alphanumeric filter below; only the URL has to go,
  // since otherwise every item carrying a Jira link would look alike.
  return expandNegatedContractions(stripLinkTargets(text).toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Function words carry no identity, so counting them drags the score of two short
 * rewordings of the same suggestion below the threshold.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was",
  "were", "has", "have", "had", "its", "our", "their", "them", "then", "than", "but",
  "all", "any", "can", "out", "off", "per", "via", "get", "through", "before", "after",
]);

/**
 * Negation is the whole point of a corrective note, so these are never stopwords and
 * never fall under the length filter. "Release trains ship on Tuesdays" and "Release
 * trains do not ship on Tuesdays" are opposite facts, not one fact reworded.
 */
const NEGATIONS = new Set(["not", "no", "never", "nor", "cannot", "without"]);

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((token) => NEGATIONS.has(token) || (token.length > 2 && !STOP_WORDS.has(token))),
  );
}

function isNegated(tokens: ReadonlySet<string>): boolean {
  for (const negation of NEGATIONS) if (tokens.has(negation)) return true;
  return false;
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

  // Keeping the negation as a token is not enough on its own: the affirmative token set
  // is a subset of the negated one, so containment would still score them identical.
  if (isNegated(left) !== isNegated(right)) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;

  const jaccard = shared / (left.size + right.size - shared);
  const smaller = Math.min(left.size, right.size);
  if (smaller < MIN_TOKENS_FOR_CONTAINMENT) return jaccard;
  return Math.max(jaccard, shared / smaller);
}
