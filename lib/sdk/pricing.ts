/**
 * What a model charges, so a week can be costed after the fact.
 *
 * Every rate here was read off the provider's own pricing page on PRICING_AS_OF. Nothing
 * is inferred from a similar model: an id that is not in the table costs `null`, and the
 * summary prints a dash rather than a number that would be wrong.
 *
 * Two things make these estimates rather than invoices:
 *
 * - **OpenAI cache writes.** The installed adapter does not report how many input tokens
 *   were written to the cache, so those tokens arrive counted as ordinary input and are
 *   billed at the input rate. Where a provider charges a premium for a cache write, that
 *   undercounts: on gpt-5.6-sol the premium is 1.25x, so an estimate can be up to 25% low
 *   on the cache-write portion of a request. Returning `null` instead would leave every
 *   OpenAI week unpriced, which is worse than a slightly low number that says so.
 * - **Anthropic cache-write duration.** Anthropic prices a 5-minute and a 1-hour cache
 *   write differently. The rate below is the 5-minute one. This barely matters in
 *   practice, because the Agent SDK reports its own cost and that supersedes this table.
 *
 * Sources:
 *   OpenAI     https://developers.openai.com/api/docs/pricing
 *              https://developers.openai.com/api/docs/models/gpt-5.6-sol
 *   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
 */

/** The day the rates below were read. Prices move; a stale table is worse than no table. */
export const PRICING_AS_OF = "2026-08-27";

/**
 * The premium a provider charges once one request carries more than `thresholdInputTokens`
 * of input. It applies to the whole request, which is why cost is worked out per request
 * rather than from a week's totals.
 */
export interface LongContextTier {
  thresholdInputTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

export interface ModelPrice {
  /** USD per million input tokens, for input that was neither cached nor written to cache. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  /** USD per million input tokens served from cache. */
  cachedInputPerMillion: number;
  /** USD per million input tokens written to the cache. */
  cacheWritePerMillion: number;
  /** Absent when the model is a flat rate at any context length. */
  longContext?: LongContextTier;
}

const PRICES = new Map<string, ModelPrice>([
  // Promotional rate, published as available at least through 2026-11-21. Above 272K input
  // tokens in one request the price steps up: 2x input, 1.5x output.
  [
    "gpt-5.6-sol",
    {
      inputPerMillion: 4,
      outputPerMillion: 20,
      cachedInputPerMillion: 0.4,
      cacheWritePerMillion: 5,
      longContext: { thresholdInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    },
  ],
  // OpenAI bills a gpt-5 cache write as ordinary input, so the two rates match.
  ["gpt-5", { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125, cacheWritePerMillion: 1.25 }],
  // Standard rates, 5-minute cache writes. Anthropic's fast mode is priced separately and
  // this table does not cover it; nothing in this repo turns it on.
  ["claude-opus-5", { inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5, cacheWritePerMillion: 6.25 }],
  ["claude-sonnet-5", { inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2, cacheWritePerMillion: 2.5 }],
]);

/** The rate card for a model id, or null when the table has never heard of it. */
export function priceFor(model: string): ModelPrice | null {
  return PRICES.get(model) ?? null;
}

/** Model ids the table can price, for tests and for anyone adding a provider. */
export function pricedModels(): string[] {
  return [...PRICES.keys()];
}

/** What one request to the provider spent. Tiered rates apply per request, not per week. */
export interface StepTokens {
  /** Total input tokens, cached and cache-write ones included. */
  inputTokens: number;
  outputTokens: number;
  /** The part of inputTokens that was served from cache. */
  cachedInputTokens: number;
  /**
   * The part of inputTokens that was written to the cache. Zero when the provider does
   * not say, in which case those tokens stay in the uncached input above.
   */
  cacheWriteTokens: number;
}

function stepCost(price: ModelPrice, step: StepTokens): number {
  const input = Math.max(step.inputTokens, 0);
  const cached = Math.max(step.cachedInputTokens, 0);
  // A provider reporting more cached or written tokens than input would otherwise make
  // the uncached remainder negative and undercharge.
  const cachedWithinInput = Math.min(cached, input);
  const written = Math.min(Math.max(step.cacheWriteTokens, 0), input - cachedWithinInput);
  const uncached = input - cachedWithinInput - written;

  const tier = price.longContext;
  // The tier is decided by the request's whole input and lifts every input-side rate with
  // it. The published table gives multipliers for input and output; applying the input
  // multiplier to the cached and cache-write rates as well is this module's assumption,
  // and it errs high rather than low.
  const overThreshold = tier !== undefined && input > tier.thresholdInputTokens;
  const inputMultiplier = overThreshold ? tier.inputMultiplier : 1;
  const outputMultiplier = overThreshold ? tier.outputMultiplier : 1;

  const inputCost =
    uncached * price.inputPerMillion +
    cachedWithinInput * price.cachedInputPerMillion +
    written * price.cacheWritePerMillion;
  const outputCost = Math.max(step.outputTokens, 0) * price.outputPerMillion;

  return (inputCost * inputMultiplier + outputCost * outputMultiplier) / 1_000_000;
}

/**
 * Estimate what a week's requests cost, or null when the model is not in the table.
 *
 * Each step is priced on its own because a tiered rate is decided per request: a week
 * whose totals cross 272K tokens has not necessarily made a single request that did.
 */
export function estimateCostUsd(model: string, steps: StepTokens[]): number | null {
  const price = priceFor(model);
  if (!price) return null;

  let total = 0;
  for (const step of steps) total += stepCost(price, step);
  return total;
}

/** Render a cost for a report column. An unknown model gets a dash, not a zero. */
export function formatCostUsd(cost: number | null): string {
  if (cost === null) return "—";
  // Sub-cent weeks are real on a cheap model, and "$0.00" reads as free rather than small.
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}
