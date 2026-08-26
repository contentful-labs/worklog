import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  buildHeaders,
  getAccountId,
  getGitHubUsername,
  searchConfluence,
  fetchDataForWeek,
  buildTeamSprintJql,
  type FetchCredentials,
  type WeekInfo,
} from "../data-fetch";
import type { WorklogConfig } from "../types";

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
  coaching: { tone: "direct", focusAreas: ["impact"] },
};

const mockCreds: FetchCredentials = {
  atlassianApiToken: "test-atlassian-token",
  githubToken: "test-github-token",
};

const weekInfo: WeekInfo = {
  weekNumber: 10,
  year: 2026,
  startDate: new Date("2026-03-02T00:00:00Z"),
  endDate: new Date("2026-03-08T00:00:00Z"),
  filename: "2026-W10 Work Log.md",
};

const handlers = [
  // Atlassian myself
  http.get(`${BASE_URL}/rest/api/3/myself`, () => {
    return HttpResponse.json({ accountId: "abc123" });
  }),

  // GitHub user
  http.get("https://api.github.com/user", () => {
    return HttpResponse.json({ login: "testuser" });
  }),

  // Jira search
  http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    const jql = body.jql as string;
    // Team sprint query returns empty
    if (jql.includes("openSprints")) {
      return HttpResponse.json({ issues: [] });
    }
    return HttpResponse.json({
      issues: [
        { key: "CORE-1", fields: { summary: "Task 1", status: { name: "Done" }, created: "2026-03-02", updated: "2026-03-05" } },
      ],
    });
  }),

  // Confluence search — contributor pages
  http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
    const url = new URL(request.url);
    const cql = url.searchParams.get("cql") || "";
    if (cql.includes("contributor")) {
      return HttpResponse.json({
        results: [
          {
            id: "page1",
            title: "Design Doc",
            status: "current",
            space: { name: "Core", key: "CORE" },
            history: { createdBy: { accountId: "abc123" }, lastUpdated: { when: "2026-03-04" } },
          },
        ],
      });
    }
    // Comments query
    if (cql.includes("comment")) {
      return HttpResponse.json({ results: [] });
    }
    return HttpResponse.json({ results: [] });
  }),

  // GitHub PR search
  http.get("https://api.github.com/search/issues", ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    if (q.includes("author:")) {
      return HttpResponse.json({
        total_count: 1,
        items: [
          { number: 42, title: "Fix bug", state: "closed", created_at: "2026-03-03", updated_at: "2026-03-04", merged_at: "2026-03-04", html_url: "https://github.com/test-org/repo/pull/42", repository_url: "https://api.github.com/repos/test-org/repo", user: { login: "testuser" } },
        ],
      });
    }
    // review query
    return HttpResponse.json({ total_count: 0, items: [] });
  }),
];

/** Answers the authored-PR search with nothing and the reviewed-by search with one PR by someone else. */
const reviewedPRHandler = http.get("https://api.github.com/search/issues", ({ request }) => {
  const q = new URL(request.url).searchParams.get("q") || "";
  if (q.includes("reviewed-by:")) {
    return HttpResponse.json({
      total_count: 1,
      items: [
        { number: 7, title: "Their change", state: "open", created_at: "2026-03-03", updated_at: "2026-03-04", html_url: "https://github.com/test-org/repo/pull/7", repository_url: "https://api.github.com/repos/test-org/repo", user: { login: "otheruser" } },
      ],
    });
  }
  return HttpResponse.json({ total_count: 0, items: [] });
});

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("buildHeaders", () => {
  it("creates atlassian Basic auth header", () => {
    const h = buildHeaders(mockConfig, mockCreds);
    const expected = Buffer.from("user@test.com:test-atlassian-token").toString("base64");
    expect(h.atlassian.Authorization).toBe(`Basic ${expected}`);
  });

  it("creates github Bearer auth header", () => {
    const h = buildHeaders(mockConfig, mockCreds);
    expect(h.github.Authorization).toBe("Bearer test-github-token");
  });
});

describe("getAccountId", () => {
  it("returns account ID from Atlassian API", async () => {
    const h = buildHeaders(mockConfig, mockCreds);
    const id = await getAccountId(mockConfig, h);
    expect(id).toBe("abc123");
  });

  it("throws on API failure", async () => {
    server.use(
      http.get(`${BASE_URL}/rest/api/3/myself`, () => HttpResponse.json({}, { status: 401 })),
    );
    const h = buildHeaders(mockConfig, mockCreds);
    await expect(getAccountId(mockConfig, h)).rejects.toThrow("Failed to get accountId: 401");
  });
});

describe("getGitHubUsername", () => {
  it("returns username from GitHub API", async () => {
    const h = buildHeaders(mockConfig, mockCreds);
    const username = await getGitHubUsername(h);
    expect(username).toBe("testuser");
  });
});

describe("searchConfluence", () => {
  it("returns search results", async () => {
    const h = buildHeaders(mockConfig, mockCreds);
    const results = await searchConfluence(mockConfig, h, 'text~"test"', "space");
    expect(results).toHaveLength(0); // default handler returns empty for non-matching CQL
  });

  it("paginates through results", async () => {
    let callCount = 0;
    server.use(
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({
            results: [{ id: "1" }],
            _links: { next: "/next" },
          });
        }
        return HttpResponse.json({ results: [{ id: "2" }] });
      }),
    );
    const h = buildHeaders(mockConfig, mockCreds);
    const results = await searchConfluence(mockConfig, h, "cql", "expand");
    expect(results).toHaveLength(2);
    expect(callCount).toBe(2);
  });
});

describe("buildTeamSprintJql", () => {
  it("builds a project-in clause from bare project keys", () => {
    const jql = buildTeamSprintJql(["CORE", "OPS"], "user@test.com");
    expect(jql).toContain('project in (CORE, OPS)');
    expect(jql).toContain('NOT (assignee = "user@test.com" OR reporter = "user@test.com")');
  });
});

describe("fetchDataForWeek", () => {
  it("sends the sprint query with dash-stripped project keys", async () => {
    const seenJql: string[] = [];
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
        const body = await request.json() as { jql: string };
        seenJql.push(body.jql);
        return HttpResponse.json({ issues: [] });
      }),
    );
    const config = { ...mockConfig, profile: { ...mockConfig.profile, ticketPrefixes: ["CORE-"] } };
    await fetchDataForWeek(config, buildHeaders(mockConfig, mockCreds), "abc123", "testuser", weekInfo);
    const sprintJql = seenJql.find((j) => j.includes("openSprints"));
    expect(sprintJql).toContain("project in (CORE)");
  });

  it("fetches all data sources for a week", async () => {
    const h = buildHeaders(mockConfig, mockCreds);
    const data = await fetchDataForWeek(mockConfig, h, "abc123", "testuser", weekInfo);

    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].key).toBe("CORE-1");
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0].title).toBe("Design Doc");
    expect(data.pages[0]._tags).toContain("Created");
    expect(data.prs).toHaveLength(1);
    expect(data.prs[0].number).toBe(42);
    expect(data.reviews).toHaveLength(0);
    expect(data.teamSprintItems).toHaveLength(0);
  });

  it("handles empty results gracefully", async () => {
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [] })),
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, () => HttpResponse.json({ results: [] })),
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
    );
    const h = buildHeaders(mockConfig, mockCreds);
    const data = await fetchDataForWeek(mockConfig, h, "abc123", "testuser", weekInfo);

    expect(data.issues).toHaveLength(0);
    expect(data.pages).toHaveLength(0);
    expect(data.prs).toHaveLength(0);
    expect(data.reviews).toHaveLength(0);
  });

  it("warns and still completes the week when the team sprint query fails", async () => {
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
        const body = await request.json() as { jql: string };
        if (body.jql.includes("openSprints")) {
          return HttpResponse.json({ errorMessages: ["Field 'sprint' does not exist"] }, { status: 400 });
        }
        return HttpResponse.json({
          issues: [
            { key: "CORE-1", fields: { summary: "Task 1", status: { name: "Done" }, created: "2026-03-02", updated: "2026-03-05" } },
          ],
        });
      }),
    );

    const warnings: string[] = [];
    const h = buildHeaders(mockConfig, mockCreds);
    const data = await fetchDataForWeek(mockConfig, h, "abc123", "testuser", weekInfo, {
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Team sprint query failed");
    expect(warnings[0]).toContain("400");
    expect(data.issues).toHaveLength(1);
    expect(data.teamSprintItems).toHaveLength(0);
  });

  it("warns when the reviewed-PR search fails", async () => {
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") || "";
        if (q.includes("reviewed-by:")) {
          return HttpResponse.json({ message: "Server error" }, { status: 500 });
        }
        return HttpResponse.json({ total_count: 0, items: [] });
      }),
    );

    const warnings: string[] = [];
    const h = buildHeaders(mockConfig, mockCreds);
    const data = await fetchDataForWeek(mockConfig, h, "abc123", "testuser", weekInfo, {
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings.some((w) => w.includes("GitHub reviewed-PR search failed"))).toBe(true);
    expect(data.reviews).toHaveLength(0);
  });

  it("warns when a PR's reviews cannot be read", async () => {
    server.use(
      reviewedPRHandler,
      http.get("https://api.github.com/repos/test-org/repo/pulls/7/reviews", () =>
        HttpResponse.json({ message: "Forbidden" }, { status: 403 }),
      ),
    );

    const warnings: string[] = [];
    const h = buildHeaders(mockConfig, mockCreds);
    const data = await fetchDataForWeek(mockConfig, h, "abc123", "testuser", weekInfo, {
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings.some((w) => w.includes("Could not read reviews for test-org/repo#7") && w.includes("403"))).toBe(true);
    expect(data.reviews).toHaveLength(0);
  });

  it("warns when a PR's review comments cannot be read but still records the review", async () => {
    server.use(
      reviewedPRHandler,
      http.get("https://api.github.com/repos/test-org/repo/pulls/7/reviews", () =>
        HttpResponse.json([
          { user: { login: "testuser" }, state: "APPROVED", submitted_at: "2026-03-04", html_url: "https://github.com/test-org/repo/pull/7#r1" },
        ]),
      ),
      http.get("https://api.github.com/repos/test-org/repo/pulls/7/comments", () =>
        HttpResponse.json({ message: "Server error" }, { status: 500 }),
      ),
    );

    const warnings: string[] = [];
    const h = buildHeaders(mockConfig, mockCreds);
    const data = await fetchDataForWeek(mockConfig, h, "abc123", "testuser", weekInfo, {
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings.some((w) => w.includes("Could not read review comments for test-org/repo#7") && w.includes("500"))).toBe(true);
    expect(data.reviews).toHaveLength(1);
    expect(data.reviews[0].comment_count).toBe(0);
  });

  it("warns when a PR's review fetch throws", async () => {
    server.use(
      reviewedPRHandler,
      http.get("https://api.github.com/repos/test-org/repo/pulls/7/reviews", () => HttpResponse.error()),
    );

    const warnings: string[] = [];
    const h = buildHeaders(mockConfig, mockCreds);
    const data = await fetchDataForWeek(mockConfig, h, "abc123", "testuser", weekInfo, {
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings.some((w) => w.includes("Review fetch failed for test-org/repo#7"))).toBe(true);
    expect(data.reviews).toHaveLength(0);
  });
});
