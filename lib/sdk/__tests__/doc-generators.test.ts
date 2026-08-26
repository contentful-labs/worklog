import { describe, it, expect } from "vitest";
import type { WorklogConfig } from "../types";
import { generateProfileDoc, generateWorkContextDoc, generateCoachPersonaDoc } from "../doc-generators";

const fixedDate = new Date("2026-03-06T00:00:00Z");

function makeConfig(overrides?: Partial<WorklogConfig>): WorklogConfig {
  return {
    version: 1,
    vault: "/tmp/test-vault",
    atlassian: { url: "https://example.atlassian.net", email: "test@example.com" },
    githubOrgs: ["test-org"],
    ai: { provider: "anthropic" },
    profile: {
      fullName: "Jane Doe",
      displayName: "Jane Doe",
      jobTitle: "Senior Software Engineer",
      level: "IC-5",
      company: "Acme Corp",
      location: "Berlin, Germany",
      startDate: "2024-01-15",
      domain: "Builds the content delivery pipeline",
      team: "Platform",
      teamDomain: "Content Delivery",
      ticketPrefixes: ["PLAT-", "CDN-"],
    },
    career: {
      framework: "IC levels",
      currentLevel: "IC-5",
      targetLevel: "IC-6",
      companyValues: ["Customer Focus", "Own It"],
      reviewCycleDates: [
        { type: "Mid-year", date: "2026-06-15" },
        { type: "Annual", date: "2026-12-15" },
      ],
      skills: ["TypeScript", "React", "AWS"],
      growthAreas: ["System design", "Cross-team influence"],
      careerDocPaths: [],
    },
    coaching: {
      tone: "balanced",
      focusAreas: ["IC-6 promotion readiness"],
    },
    ...overrides,
  };
}

describe("generateProfileDoc", () => {
  it("includes profile fields", () => {
    const doc = generateProfileDoc(makeConfig(), fixedDate);
    expect(doc).toContain("**Name:** Jane Doe");
    expect(doc).toContain("**Title:** Senior Software Engineer");
    expect(doc).toContain("**Level:** IC-5");
    expect(doc).toContain("**Company:** Acme Corp");
    expect(doc).toContain("**Team:** Platform");
    expect(doc).toContain("*Last updated: 2026-03-06*");
  });

  it("lists skills and growth areas", () => {
    const doc = generateProfileDoc(makeConfig(), fixedDate);
    expect(doc).toContain("- TypeScript");
    expect(doc).toContain("- React");
    expect(doc).toContain("- System design");
  });

  it("adds TODO placeholders for missing fields", () => {
    const config = makeConfig({
      profile: {
        ...makeConfig().profile,
        jobTitle: "",
        level: "",
      },
      career: {
        ...makeConfig().career,
        skills: [],
        growthAreas: [],
      },
    });
    const doc = generateProfileDoc(config, fixedDate);
    expect(doc).toContain("<!-- TODO: update your job title -->");
    expect(doc).toContain("<!-- TODO: add your technical skills");
    expect(doc).toContain("<!-- TODO: add your growth areas");
  });

  it("includes About section with domain", () => {
    const doc = generateProfileDoc(makeConfig(), fixedDate);
    expect(doc).toContain("## About");
    expect(doc).toContain("Builds the content delivery pipeline");
  });
});

describe("generateWorkContextDoc", () => {
  it("includes company and team info", () => {
    const doc = generateWorkContextDoc(makeConfig(), fixedDate);
    expect(doc).toContain("**Company:** Acme Corp");
    expect(doc).toContain("**Team:** Platform");
    expect(doc).toContain("**Domain:** Content Delivery");
    expect(doc).toContain("**Ticket Prefixes:** PLAT-, CDN-");
  });

  it("includes career framework", () => {
    const doc = generateWorkContextDoc(makeConfig(), fixedDate);
    expect(doc).toContain("**Type:** IC levels");
    expect(doc).toContain("**Current Level:** IC-5");
    expect(doc).toContain("**Target Level:** IC-6");
  });

  it("includes company values", () => {
    const doc = generateWorkContextDoc(makeConfig(), fixedDate);
    expect(doc).toContain("- Customer Focus");
    expect(doc).toContain("- Own It");
  });

  it("includes review cycle table when dates exist", () => {
    const doc = generateWorkContextDoc(makeConfig(), fixedDate);
    expect(doc).toContain("| Mid-year | 2026-06-15 |");
    expect(doc).toContain("| Annual | 2026-12-15 |");
  });

  it("adds TODO when no review dates", () => {
    const config = makeConfig({
      career: { ...makeConfig().career, reviewCycleDates: [] },
    });
    const doc = generateWorkContextDoc(config, fixedDate);
    expect(doc).toContain("<!-- TODO: add your review cycle dates");
  });

  it("adds TODO when no ticket prefixes", () => {
    const config = makeConfig({
      profile: { ...makeConfig().profile, ticketPrefixes: [] },
    });
    const doc = generateWorkContextDoc(config, fixedDate);
    expect(doc).toContain("<!-- TODO: add your Jira project keys");
  });
});

describe("generateCoachPersonaDoc", () => {
  it("includes coaching tone", () => {
    const doc = generateCoachPersonaDoc(makeConfig());
    expect(doc).toContain("**balanced** - Direct but supportive");
  });

  it("includes focus areas", () => {
    const doc = generateCoachPersonaDoc(makeConfig());
    expect(doc).toContain("- IC-6 promotion readiness");
  });

  it("handles empty focus areas", () => {
    const config = makeConfig({
      coaching: { tone: "direct", focusAreas: [] },
    });
    const doc = generateCoachPersonaDoc(config);
    expect(doc).toContain("_(None configured)_");
    expect(doc).toContain("**direct** - Direct and blunt");
  });

  it("handles gentle tone", () => {
    const config = makeConfig({
      coaching: { tone: "gentle", focusAreas: [] },
    });
    const doc = generateCoachPersonaDoc(config);
    expect(doc).toContain("**gentle** - Encouraging and supportive");
  });

  it("includes all standard sections", () => {
    const doc = generateCoachPersonaDoc(makeConfig());
    expect(doc).toContain("## Identity");
    expect(doc).toContain("## Communication Style");
    expect(doc).toContain("## Coaching Focus Areas");
    expect(doc).toContain("## Coaching Philosophy");
    expect(doc).toContain("## Feedback Calibration");
    expect(doc).toContain("## Language Preferences");
    expect(doc).toContain("## Adaptation");
  });
});
