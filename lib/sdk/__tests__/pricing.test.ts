import { describe, it, expect } from "vitest";
import { PRICING_AS_OF, estimateCostUsd, formatCostUsd, priceFor, pricedModels } from "../pricing";

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
});

describe("estimateCostUsd", () => {
  const million = 1_000_000;

  it("costs a million in and a million out at the published rate", () => {
    // gpt-5 is $1.25 per million in, $10 per million out.
    const cost = estimateCostUsd({
      model: "gpt-5",
      inputTokens: million,
      outputTokens: million,
      cachedInputTokens: 0,
    });

    expect(cost).toBeCloseTo(11.25, 10);
  });

  it("bills cached input at the cached rate, not twice", () => {
    // Half the input cached: 0.5M at $1.25 + 0.5M at $0.125, no output.
    const cost = estimateCostUsd({
      model: "gpt-5",
      inputTokens: million,
      outputTokens: 0,
      cachedInputTokens: million / 2,
    });

    expect(cost).toBeCloseTo(0.625 + 0.0625, 10);
  });

  it("is cheaper when more of the same input was cached", () => {
    const counts = { model: "claude-opus-5", inputTokens: million, outputTokens: 0 };
    const cold = estimateCostUsd({ ...counts, cachedInputTokens: 0 });
    const warm = estimateCostUsd({ ...counts, cachedInputTokens: million });

    expect(cold).toBeCloseTo(5, 10);
    expect(warm).toBeCloseTo(0.5, 10);
  });

  it("returns null rather than a wrong number for an unknown model", () => {
    expect(estimateCostUsd({ model: "mystery-model", inputTokens: million, outputTokens: million, cachedInputTokens: 0 })).toBeNull();
  });

  it("costs nothing when nothing was spent", () => {
    expect(estimateCostUsd({ model: "gpt-5", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })).toBe(0);
  });

  it("ignores a cached count larger than the input it came from", () => {
    // A provider reporting more cached tokens than input tokens would otherwise produce
    // a negative uncached count and undercharge.
    const cost = estimateCostUsd({
      model: "gpt-5",
      inputTokens: million,
      outputTokens: 0,
      cachedInputTokens: million * 5,
    });

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
