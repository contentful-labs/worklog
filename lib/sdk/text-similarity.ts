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

/** Symbols that belong to a name when they are attached to one: c++, c#, f#. */
const NAME_SYMBOLS = new Set(["+", "#"]);

function isWordChar(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
}

/**
 * Reduce text to words, keeping the punctuation that is part of a name.
 *
 * Stripping every symbol made "Builds C++ toolchains" and "Builds C# toolchains" the
 * same sentence, so the second one could never be written. A `+` or `#` attached to a
 * word stays, and a `.` stays only between two characters of one name (node.js, 1.22),
 * never as the full stop ending a sentence.
 *
 * A scan rather than a pattern: this is model output, and CodeQL flags regexes over it.
 */
function toWords(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (isWordChar(char)) {
      out += char;
      continue;
    }

    const previous = out[out.length - 1] ?? " ";
    if (NAME_SYMBOLS.has(char) && previous !== " ") {
      out += char;
      continue;
    }
    if (char === "." && previous !== " " && isWordChar(text[i + 1] ?? " ")) {
      out += char;
      continue;
    }
    out += " ";
  }
  return out.split(" ").filter((word) => word.length > 0).join(" ");
}

/** Strip markdown down to comparable words. */
export function normalizeText(text: string): string {
  // Bracket syntax is left to the word scan below; only the URL has to go, since
  // otherwise every item carrying a Jira link would look alike.
  return toWords(expandNegatedContractions(stripLinkTargets(text).toLowerCase()));
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

/**
 * A token carrying a digit or a name symbol is what tells two otherwise identical
 * records apart: a version, a ticket number, a language. Never dropped for being short.
 */
function isDistinguishing(token: string): boolean {
  for (const char of token) {
    if ((char >= "0" && char <= "9") || char === "+" || char === "#" || char === ".") return true;
  }
  return false;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter(
        (token) =>
          NEGATIONS.has(token) || isDistinguishing(token) || (token.length > 2 && !STOP_WORDS.has(token)),
      ),
  );
}

function distinguishingTokens(tokens: ReadonlySet<string>): Set<string> {
  const named = new Set<string>();
  for (const token of tokens) if (isDistinguishing(token)) named.add(token);
  return named;
}

function isSubsetOf(inner: ReadonlySet<string>, outer: ReadonlySet<string>): boolean {
  for (const token of inner) if (!outer.has(token)) return false;
  return true;
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

  // Versions, languages and ticket numbers are the whole difference between two records
  // that otherwise read alike, and the short ones survive no other filter. When each
  // text names one the other does not, they are different records: C++ against C#, Go
  // 1.22 against Go 1.23. One naming a superset of the other's (the same ticket plus a
  // second) is still the same record elaborated, which is what the score is for.
  const leftNames = distinguishingTokens(left);
  const rightNames = distinguishingTokens(right);
  if (!isSubsetOf(leftNames, rightNames) && !isSubsetOf(rightNames, leftNames)) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;

  const jaccard = shared / (left.size + right.size - shared);
  const smaller = Math.min(left.size, right.size);
  if (smaller < MIN_TOKENS_FOR_CONTAINMENT) return jaccard;
  return Math.max(jaccard, shared / smaller);
}
