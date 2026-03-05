import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { buildResearchTools } from "../ai-tools";
import type { WorklogConfig } from "../config";

const BASE_URL = "https://test.atlassian.net";

const mockConfig: WorklogConfig = {
  version: 1,
  vault: "/tmp/test-vault",
  atlassian: { url: BASE_URL, email: "user@test.com" },
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
    companyValues: ["quality"],
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

/** Call a tool's execute — loose typing needed because the AI SDK Tool generic is complex. */
// biome-ignore lint/suspicious/noExplicitAny: AI SDK Tool type is a complex generic union
async function exec(tool: { execute?: (...args: any[]) => any }, input: Record<string, string>): Promise<string> {
  return tool.execute!(input, { toolCallId: "test", messages: [] });
}

const handlers = [
  http.get(`${BASE_URL}/rest/api/3/issue/:ticketKey`, ({ params }) => {
    return HttpResponse.json({
      key: params.ticketKey,
      fields: {
        summary: "Test ticket",
        status: { name: "In Progress" },
        description: { content: [] },
        comment: { comments: [] },
      },
    });
  }),

  http.get(`${BASE_URL}/wiki/rest/api/content/search`, () => {
    return HttpResponse.json({
      results: [
        { id: "1", title: "Result 1" },
        { id: "2", title: "Result 2" },
      ],
    });
  }),

  http.get(`${BASE_URL}/wiki/rest/api/content/:pageId`, ({ params }) => {
    return HttpResponse.json({
      id: params.pageId,
      title: "Test Page",
      body: { storage: { value: "<p>Content</p>" } },
      space: { key: "TEST" },
      history: { createdDate: "2026-01-01" },
    });
  }),

  http.post(`${BASE_URL}/rest/api/3/search/jql`, () => {
    return HttpResponse.json({
      issues: [
        { key: "CORE-1", fields: { summary: "Issue 1", status: { name: "Done" } } },
      ],
    });
  }),
];

const server = setupServer(...handlers);

beforeAll(() => {
  process.env.ATLASSIAN_API_TOKEN = "test-token";
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  delete process.env.ATLASSIAN_API_TOKEN;
});

describe("buildResearchTools — Atlassian API", () => {
  it("fetchJiraTicket returns ticket data", async () => {
    const tools = buildResearchTools(mockConfig);
    const result = await exec(tools.fetchJiraTicket, { ticketKey: "CORE-123" });
    const parsed = JSON.parse(result);
    expect(parsed.key).toBe("CORE-123");
    expect(parsed.fields.summary).toBe("Test ticket");
  });

  it("searchJira returns search results", async () => {
    const tools = buildResearchTools(mockConfig);
    const result = await exec(tools.searchJira, { query: "test query" });
    const parsed = JSON.parse(result);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].key).toBe("CORE-1");
  });

  it("fetchConfluencePage returns page content", async () => {
    const tools = buildResearchTools(mockConfig);
    const result = await exec(tools.fetchConfluencePage, { pageIdOrUrl: "12345" });
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe("Test Page");
  });

  it("fetchConfluencePage extracts ID from URL", async () => {
    const tools = buildResearchTools(mockConfig);
    const result = await exec(tools.fetchConfluencePage, {
      pageIdOrUrl: "https://test.atlassian.net/wiki/spaces/TEST/pages/12345/Test-Page",
    });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBe("12345");
  });

  it("searchConfluence returns search results", async () => {
    const tools = buildResearchTools(mockConfig);
    const result = await exec(tools.searchConfluence, { query: "test" });
    const parsed = JSON.parse(result);
    expect(parsed.results).toHaveLength(2);
  });
});

describe("buildResearchTools — auth missing", () => {
  it("returns error string when ATLASSIAN_API_TOKEN is not set", async () => {
    const savedToken = process.env.ATLASSIAN_API_TOKEN;
    delete process.env.ATLASSIAN_API_TOKEN;

    const tools = buildResearchTools(mockConfig);
    const result = await exec(tools.fetchJiraTicket, { ticketKey: "CORE-1" });
    expect(result).toContain("Error: Atlassian auth not configured");

    process.env.ATLASSIAN_API_TOKEN = savedToken;
  });

  it("returns error when no config provided", async () => {
    const tools = buildResearchTools(null);
    const result = await exec(tools.fetchJiraTicket, { ticketKey: "CORE-1" });
    expect(result).toContain("Error: Atlassian auth not configured");
  });
});

describe("buildResearchTools — vault tools", () => {
  it("readVaultNote returns error when no vault path", async () => {
    const tools = buildResearchTools(null);
    const result = await exec(tools.readVaultNote, { noteName: "test" });
    expect(result).toBe("Error: no vault path configured");
  });

  it("searchVault returns error when no vault path", async () => {
    const tools = buildResearchTools(null);
    const result = await exec(tools.searchVault, { keyword: "test" });
    expect(result).toBe("Error: no vault path configured");
  });
});
