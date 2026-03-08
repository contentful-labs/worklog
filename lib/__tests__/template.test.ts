import { describe, it, expect } from "vitest";
import { fillTemplate } from "../sdk/template";

describe("fillTemplate", () => {
  it("replaces a single placeholder", () => {
    expect(fillTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("replaces multiple different placeholders", () => {
    const result = fillTemplate("{{greeting}} {{name}}!", {
      greeting: "Hi",
      name: "BK",
    });
    expect(result).toBe("Hi BK!");
  });

  it("replaces repeated occurrences of same placeholder", () => {
    expect(fillTemplate("{{x}} and {{x}}", { x: "yes" })).toBe("yes and yes");
  });

  it("leaves unknown placeholders as-is", () => {
    expect(fillTemplate("{{known}} {{unknown}}", { known: "A" })).toBe(
      "A {{unknown}}"
    );
  });

  it("returns template unchanged when no placeholders exist", () => {
    expect(fillTemplate("no placeholders here", { key: "val" })).toBe(
      "no placeholders here"
    );
  });
});
