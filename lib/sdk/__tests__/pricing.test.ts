import { describe, it, expect } from "vitest";
import {
  MODEL_ALIASES_AS_OF,
  PRICING_AS_OF,
  estimateCostUsd,
  formatCostUsd,
  priceFor,
  pricedModels,
  resolveModelAlias,
  type StepTokens,
} from "../pricing";

const MILLION = 1_000_000;

function step(overrides: Partial<StepTokens>): StepTokens {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, ...overrides };
}

describe("priceFor", () => {
  it("prices the models this repo defaults to", () => {
    expect(pricedModels().sort()).toEqual(["claude-opus-5", "claude-sonnet-5", "gpt-5", "gpt-5.6-sol"]);
  });

  it("returns null for a model it has never heard of", () => {
    expect(priceFor("gpt-9-imaginary")).toBeNull();
  });

  it("carries the day the rates were read", () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prices a provider alias the same as the id it stands for", () => {
    // A config carrying `gpt-5.6` reaches the API fine and used to cost null.
    expect(resolveModelAlias("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(priceFor("gpt-5.6")).toEqual(priceFor("gpt-5.6-sol"));
  });

  it("leaves a name that is not an alias alone", () => {
    expect(resolveModelAlias("gpt-5")).toBe("gpt-5");
    expect(resolveModelAlias("mystery-model")).toBe("mystery-model");
    expect(priceFor("mystery-model")).toBeNull();
  });

  it("carries the day the aliases were checked", () => {
    expect(MODEL_ALIASES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("gives every priced model a cache-write rate at least its input rate", () => {
    for (const model of pricedModels()) {
      const price = priceFor(model);
      expect(price).not.toBeNull();
      expect(price!.cacheWritePerMillion).toBeGreaterThanOrEqual(price!.inputPerMillion);
      expect(price!.cachedInputPerMillion).toBeLessThan(price!.inputPerMillion);
    }
  });
});

describe("estimateCostUsd", () => {
  it("costs a million in and a million out at the published rate", () => {
    // gpt-5 is $1.25 per million in, $10 per million out.
    const cost = estimateCostUsd("gpt-5", [step({ inputTokens: MILLION, outputTokens: MILLION })]);
    expect(cost).toBeCloseTo(11.25, 10);
  });

  it("bills cached input at the cached rate, not twice", () => {
    // Half the input cached: 0.5M at $1.25 + 0.5M at $0.125, no output.
    const cost = estimateCostUsd("gpt-5", [step({ inputTokens: MILLION, cachedInputTokens: MILLION / 2 })]);
    expect(cost).toBeCloseTo(0.625 + 0.0625, 10);
  });

  it("is cheaper when more of the same input was cached", () => {
    const cold = estimateCostUsd("claude-opus-5", [step({ inputTokens: MILLION })]);
    const warm = estimateCostUsd("claude-opus-5", [step({ inputTokens: MILLION, cachedInputTokens: MILLION })]);

    expect(cold).toBeCloseTo(5, 10);
    expect(warm).toBeCloseTo(0.5, 10);
  });

  it("bills a cache write above the plain input rate", () => {
    // Kept under the long-context threshold so this isolates the cache-write rate.
    // 200K gpt-5.6-sol cache writes cost $1.00; as plain input they would cost $0.80.
    const asWrite = estimateCostUsd("gpt-5.6-sol", [step({ inputTokens: 200_000, cacheWriteTokens: 200_000 })]);
    const asInput = estimateCostUsd("gpt-5.6-sol", [step({ inputTokens: 200_000 })]);

    expect(asWrite).toBeCloseTo(1, 10);
    expect(asInput).toBeCloseTo(0.8, 10);
  });

  it("bills Anthropic cache writes at their own rate", () => {
    const cost = estimateCostUsd("claude-opus-5", [step({ inputTokens: MILLION, cacheWriteTokens: MILLION })]);
    expect(cost).toBeCloseTo(6.25, 10);
  });

  it("applies the long-context tier to a request that crosses the threshold", () => {
    // 300K in at 2x $4 = $2.40, 100K out at 1.5x $20 = $3.00.
    const cost = estimateCostUsd("gpt-5.6-sol", [step({ inputTokens: 300_000, outputTokens: 100_000 })]);
    expect(cost).toBeCloseTo(5.4, 10);
  });

  it("applies the long-context tier through an alias too", () => {
    const viaAlias = estimateCostUsd("gpt-5.6", [step({ inputTokens: 300_000, outputTokens: 100_000 })]);
    expect(viaAlias).toBeCloseTo(5.4, 10);
  });

  it("leaves a request just under the threshold on the base rate", () => {
    const under = estimateCostUsd("gpt-5.6-sol", [step({ inputTokens: 272_000, outputTokens: 100_000 })]);
    expect(under).toBeCloseTo((272_000 * 4 + 100_000 * 20) / MILLION, 10);
  });

  it("decides the tier per request, not from the week's total", () => {
    // Two 200K requests total 400K but neither crossed 272K, so neither is tiered.
    const split = estimateCostUsd("gpt-5.6-sol", [
      step({ inputTokens: 200_000 }),
      step({ inputTokens: 200_000 }),
    ]);
    const together = estimateCostUsd("gpt-5.6-sol", [step({ inputTokens: 400_000 })]);

    expect(split).toBeCloseTo(1.6, 10);
    expect(together).toBeCloseTo(400_000 * 4 * 2 / MILLION, 10);
    expect(together).toBeGreaterThan(split!);
  });

  it("does not tier a model that has no tier", () => {
    const cost = estimateCostUsd("gpt-5", [step({ inputTokens: 400_000, outputTokens: 100_000 })]);
    expect(cost).toBeCloseTo((400_000 * 1.25 + 100_000 * 10) / MILLION, 10);
  });

  it("returns null rather than a wrong number for an unknown model", () => {
    expect(estimateCostUsd("mystery-model", [step({ inputTokens: MILLION, outputTokens: MILLION })])).toBeNull();
  });

  it("costs nothing when nothing was spent", () => {
    expect(estimateCostUsd("gpt-5", [])).toBe(0);
    expect(estimateCostUsd("gpt-5", [step({})])).toBe(0);
  });

  it("ignores cached and written counts larger than the input they came from", () => {
    // A provider over-reporting either would otherwise make the uncached remainder
    // negative and undercharge.
    const cost = estimateCostUsd("gpt-5", [
      step({ inputTokens: MILLION, cachedInputTokens: MILLION * 5, cacheWriteTokens: MILLION * 5 }),
    ]);
    expect(cost).toBeCloseTo(0.125, 10);
  });
});

describe("formatCostUsd", () => {
  it("dashes an unknown cost rather than printing zero", () => {
    expect(formatCostUsd(null)).toBe("—");
  });

  it("keeps a real but tiny cost from reading as free", () => {
    expect(formatCostUsd(0.0004)).toBe("<$0.01");
  });

  it("prints zero as zero", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });

  it("rounds to cents", () => {
    expect(formatCostUsd(1.239)).toBe("$1.24");
  });
});
