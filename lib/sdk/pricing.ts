/**
 * What a model charges, so a week can be costed after the fact.
 *
 * Every rate here was read off the provider's own pricing page on PRICING_AS_OF. Nothing
 * is inferred from a similar model: an id that is not in the table costs `null`, and the
 * summary prints a dash rather than a number that would be wrong.
 *
 * Sources:
 *   OpenAI     https://developers.openai.com/api/docs/pricing
 *   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
 */

/** The day the rates below were read. Prices move; a stale table is worse than no table. */
export const PRICING_AS_OF = "2026-08-27";

export interface ModelPrice {
  /** USD per million input tokens, for input that was not served from cache. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  /** USD per million input tokens served from cache, where the provider prices those apart. */
  cachedInputPerMillion: number;
}

const PRICES = new Map<string, ModelPrice>([
  // Promotional rate, published as available at least through 2026-11-21, and quoted for
  // short context. The page does not say where short context ends, so a very long prompt
  // could be billed at the higher long-context rate and cost more than estimated here.
  ["gpt-5.6-sol", { inputPerMillion: 4, outputPerMillion: 20, cachedInputPerMillion: 0.4 }],
  ["gpt-5", { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125 }],
  // Standard rates. Anthropic's fast mode is priced separately and this table does not
  // cover it; nothing in this repo turns it on.
  ["claude-opus-5", { inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 }],
  ["claude-sonnet-5", { inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2 }],
]);

/** The rate card for a model id, or null when the table has never heard of it. */
export function priceFor(model: string): ModelPrice | null {
  return PRICES.get(model) ?? null;
}

/** Model ids the table can price, for tests and for anyone adding a provider. */
export function pricedModels(): string[] {
  return [...PRICES.keys()];
}

export interface TokenCounts {
  model: string;
  /** Total input tokens, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  /** The part of inputTokens that was served from cache, billed at the cached rate. */
  cachedInputTokens: number;
}

/**
 * Estimate what a call cost, or null when the model is not in the table.
 *
 * Cached input is billed at its own rate and is already counted inside `inputTokens`, so
 * it is subtracted out before the uncached part is priced.
 */
export function estimateCostUsd(counts: TokenCounts): number | null {
  const price = priceFor(counts.model);
  if (!price) return null;

  const input = Math.max(counts.inputTokens, 0);
  const cached = Math.min(Math.max(counts.cachedInputTokens, 0), input);
  const uncached = input - cached;

  return (
    (uncached * price.inputPerMillion +
      cached * price.cachedInputPerMillion +
      Math.max(counts.outputTokens, 0) * price.outputPerMillion) /
    1_000_000
  );
}

/** Render a cost for a report column. An unknown model gets a dash, not a zero. */
export function formatCostUsd(cost: number | null): string {
  if (cost === null) return "—";
  // Sub-cent weeks are real on a cheap model, and "$0.00" reads as free rather than small.
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}
