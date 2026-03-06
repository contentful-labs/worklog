import { describe, it, expect } from "vitest";
import { fillTemplate, buildConfigContext } from "../template";
import type { WorklogConfig } from "../types";

// fillTemplate is already tested in lib/__tests__/template.test.ts
// Here we verify the SDK re-export works
describe("fillTemplate (SDK re-export)", () => {
  it("replaces placeholders", () => {
    expect(fillTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });
});

describe("buildConfigContext — explicit config param", () => {
  const config: WorklogConfig = {
    version: 1,
    vault: "/tmp/test-vault",
    atlassian: { url: "https://test.atlassian.net", email: "user@test.com" },
    githubOrgs: ["test-org"],
    ai: { provider: "openai" },
    profile: {
      fullName: "Test User",
      displayName: "Test",
      jobTitle: "Engineer",
      level: "IC5",
      company: "TestCo",
      location: "Remote",
      startDate: "2024-01-01",
      domain: "platform",
      team: "Core",
      teamDomain: "infra",
      ticketPrefixes: ["CORE"],
    },
    career: {
      framework: "test",
      currentLevel: "IC5",
      targetLevel: "IC6",
      companyValues: ["quality", "impact"],
      reviewCycleDates: [],
      skills: ["typescript"],
      growthAreas: ["leadership"],
      careerDocPaths: [],
    },
    coaching: {
      tone: "direct",
      focusAreas: ["impact"],
    },
  };

  it("extracts company values as comma-separated string", () => {
    const ctx = buildConfigContext(config);
    expect(ctx.company_values).toBe("quality, impact");
  });

  it("extracts current and target level", () => {
    const ctx = buildConfigContext(config);
    expect(ctx.current_level).toBe("IC5");
    expect(ctx.target_level).toBe("IC6");
  });
});
