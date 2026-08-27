import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { confluenceSource, githubSource, jiraSource } from "../source-adapters";
import type { SourceContext, SourceEvent, SourceWindow } from "../sources";
import { buildHeaders, type FetchCredentials } from "../data-fetch";
import type { WorklogConfig } from "../types";

const BASE_URL = "https://example-org.atlassian.net";
const ACCOUNT_ID = "account-1";
const USERNAME = "example-user";

const mockConfig: WorklogConfig = {
  version: 1,
  vault: "/tmp/test-vault",
  atlassian: { url: BASE_URL, email: "user@example.com" },
  githubOrgs: ["example-org"],
  ai: { provider: "openai" },
  profile: {
    fullName: "Example User",
    displayName: "Example",
    jobTitle: "Engineer",
    level: "IC5",
    company: "ExampleCo",
    location: "Remote",
    startDate: "2024-01-01",
    domain: "platform",
    team: "Core",
    teamDomain: "infra",
    ticketPrefixes: ["TEAM"],
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

/** The week under test: Mon 2 Mar 2026 to Sun 8 Mar 2026. */
const window: SourceWindow = {
  start: new Date("2026-03-02T00:00:00Z"),
  end: new Date("2026-03-08T23:59:59Z"),
};

/** The pinned clock. Every `firstSeenAt` and every spotted event lands here. */
const NOW = new Date("2026-03-09T12:00:00Z");
const NOW_ISO = NOW.toISOString();

interface TestContext extends SourceContext {
  warnings: string[];
  logs: string[];
  store: Map<string, string>;
}

function makeContext(overrides: Partial<SourceContext> = {}): TestContext {
  const warnings: string[] = [];
  const logs: string[] = [];
  const store = new Map<string, string>();
  return {
    config: mockConfig,
    headers: buildHeaders(mockConfig, mockCreds),
    identity: { atlassianAccountId: ACCOUNT_ID, githubUsername: USERNAME },
    onWarning: (message) => warnings.push(message),
    state: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) },
    log: (message) => logs.push(message),
    warnings,
    logs,
    store,
    ...overrides,
  };
}

function kinds(events: SourceEvent[], itemId?: string): string[] {
  return events.filter((e) => !itemId || e.itemId === itemId).map((e) => e.kind);
}

function findEvent(events: SourceEvent[], kind: string, itemId?: string): SourceEvent | undefined {
  return events.find((e) => e.kind === kind && (!itemId || e.itemId === itemId));
}

/** Fails the test if the source made any HTTP call at all. */
const noRequestsAllowed = [
  http.all("*", ({ request }) => {
    throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
  }),
];

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// --- Jira -------------------------------------------------------------------------

const jiraIssue = {
  key: "TEAM-1234",
  fields: {
    summary: "Search Revamp indexing",
    status: { name: "In Progress" },
    created: "2026-03-03T09:00:00.000+0000",
    updated: "2026-03-06T17:00:00.000+0000",
    description: { content: [{ content: [{ text: "Rebuild the index." }] }] },
    comment: {
      comments: [
        {
          id: "c-1",
          created: "2026-03-04T11:30:00.000+0000",
          body: { content: [{ content: [{ text: "Looks good." }] }] },
        },
      ],
    },
  },
};

/** Read one field of a payload the way a reader has to: by narrowing it. */
function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined;
}

describe("jiraSource", () => {
  it("is unavailable with an actionable reason when the site and identity are missing", async () => {
    const source = jiraSource(() => NOW);
    const ctx = makeContext({
      config: { ...mockConfig, atlassian: { url: "", email: "" } },
      identity: { atlassianAccountId: "", githubUsername: USERNAME },
    });
    const availability = await source.isAvailable(ctx);

    expect(availability.ok).toBe(false);
    if (availability.ok) return;
    expect(availability.reason).toContain("Atlassian site address is not set");
    expect(availability.reason).toContain("worklog configure atlassian");
    expect(availability.reason).toContain("who you are in Atlassian");
  });

  it("is available when the site and account id are both set", async () => {
    const availability = await jiraSource(() => NOW).isAvailable(makeContext());
    expect(availability).toEqual({ ok: true });
  });

  it("snapshots the issue and dates each event by the thing that happened", async () => {
    const seenJql: string[] = [];
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
        const body = (await request.json()) as { jql: string };
        seenJql.push(body.jql);
        return HttpResponse.json({ issues: [jiraIssue] });
      }),
    );

    const ctx = makeContext();
    const batch = await jiraSource(() => NOW).fetchWindow(window, ctx);

    expect(seenJql[0]).toBe(
      '(assignee = "user@example.com" OR reporter = "user@example.com") AND updated >= "2026-03-02" AND updated <= "2026-03-08" ORDER BY updated DESC',
    );

    expect(batch.snapshots).toHaveLength(1);
    expect(batch.snapshots[0]).toMatchObject({
      id: "TEAM-1234",
      firstSeenAt: NOW_ISO,
      payload: {
        title: "Search Revamp indexing",
        url: `${BASE_URL}/browse/TEAM-1234`,
        status: "In Progress",
        text: "Rebuild the index.",
      },
    });

    expect(kinds(batch.events).sort()).toEqual(["comment", "created"]);
    expect(findEvent(batch.events, "created")?.at).toBe("2026-03-03T09:00:00.000Z");

    const comment = findEvent(batch.events, "comment");
    expect(comment?.at).toBe("2026-03-04T11:30:00.000Z");
    expect(comment?.id).toBe("c-1");
    expect(field(comment?.payload, "text")).toBe("Looks good.");
    expect(batch.warnings).toHaveLength(0);
  });

  it("dates a comment written in a later week by the comment's own timestamp", async () => {
    // The issue itself belongs to this window; the comment was written eight days later.
    // It must come back with April's date so the ledger files it in April's week.
    const lateComment = {
      ...jiraIssue,
      fields: {
        ...jiraIssue.fields,
        comment: {
          comments: [
            { id: "c-late", created: "2026-03-16T08:15:00.000+0000", body: { content: [{ content: [{ text: "Still relevant." }] }] } },
          ],
        },
      },
    };
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [lateComment] })));

    // A later window, the one the comment actually falls in.
    const laterWindow: SourceWindow = { start: new Date("2026-03-16T00:00:00Z"), end: new Date("2026-03-22T23:59:59Z") };
    const batch = await jiraSource(() => NOW).fetchWindow(laterWindow, makeContext());

    const comment = findEvent(batch.events, "comment");
    expect(comment?.at).toBe("2026-03-16T08:15:00.000Z");
    // The issue's own created/updated dates are outside this window, so neither is reported.
    expect(kinds(batch.events)).toEqual(["comment"]);
  });

  it("marks an issue with no datable change as spotted at the clock", async () => {
    const undateable = {
      key: "TEAM-9999",
      fields: {
        summary: "Search Revamp rollout",
        status: { name: "Done" },
        created: "2026-01-05T09:00:00.000+0000",
        updated: "2026-01-05T09:00:00.000+0000",
      },
    };
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [undateable] })));

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].kind).toBe("active");
    expect(batch.events[0].at).toBe(NOW_ISO);
    expect(field(batch.events[0].payload, "spotted")).toBe(true);
  });

  it("dates an active event at updated when that falls in the window", async () => {
    const quiet = {
      key: "TEAM-5",
      fields: {
        summary: "Search Revamp cleanup",
        status: { name: "In Review" },
        created: "2026-01-05T09:00:00.000+0000",
        updated: "2026-03-05T14:00:00.000+0000",
      },
    };
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [quiet] })));

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.events[0].kind).toBe("active");
    expect(batch.events[0].at).toBe("2026-03-05T14:00:00.000Z");
    expect(field(batch.events[0].payload, "spotted")).toBeUndefined();
  });

  it("rejects when the primary query fails", async () => {
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({}, { status: 500 })));
    await expect(jiraSource(() => NOW).fetchWindow(window, makeContext())).rejects.toThrow("Jira API error 500");
  });

  it("makes no HTTP call when there is nothing to ask about", async () => {
    server.use(...noRequestsAllowed);
    const batch = await jiraSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());
    expect(batch).toEqual({ snapshots: [], events: [], warnings: [] });
  });

  it("reports only changelog entries and comments newer than the watermark", async () => {
    const since = new Date("2026-03-06T00:00:00Z");
    let seenBody: { jql?: string; expand?: string } = {};
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
        seenBody = (await request.json()) as { jql?: string; expand?: string };
        return HttpResponse.json({
          issues: [
            {
              ...jiraIssue,
              fields: {
                ...jiraIssue.fields,
                comment: {
                  comments: [
                    { id: "c-old", created: "2026-03-04T11:30:00.000+0000", body: { content: [{ content: [{ text: "Old." }] }] } },
                    { id: "c-new", created: "2026-03-07T09:00:00.000+0000", body: { content: [{ content: [{ text: "New." }] }] } },
                  ],
                },
              },
              changelog: {
                histories: [
                  {
                    id: "h-old",
                    created: "2026-03-05T10:00:00.000+0000",
                    items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
                  },
                  {
                    id: "h-new",
                    created: "2026-03-07T10:00:00.000+0000",
                    items: [
                      { field: "status", fromString: "In Progress", toString: "Done" },
                      { field: "description", fromString: "old text", toString: "new text" },
                    ],
                  },
                ],
              },
            },
          ],
        });
      }),
    );

    const batch = await jiraSource(() => NOW).fetchSince(since, ["TEAM-1234"], makeContext());

    expect(seenBody.jql).toBe('key in (TEAM-1234) AND updated > "2026-03-06 00:00"');
    expect(seenBody.expand).toBe("changelog");

    expect(kinds(batch.events).sort()).toEqual(["comment", "description", "status"]);

    const status = findEvent(batch.events, "status");
    expect(status?.at).toBe("2026-03-07T10:00:00.000Z");
    expect(status?.id).toBe("h-new:status");
    expect(status?.payload).toEqual({ from: "In Progress", to: "Done" });

    expect(field(findEvent(batch.events, "description")?.payload, "text")).toBe("new text");
    expect(findEvent(batch.events, "comment")?.id).toBe("c-new");

    // TEAM-1234 was already known, so no snapshot is re-sent.
    expect(batch.snapshots).toHaveLength(0);
  });

  it("snapshots an issue the delta fetch has never seen before", async () => {
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, () =>
        HttpResponse.json({ issues: [{ ...jiraIssue, key: "TEAM-4321", changelog: { histories: [] } }] }),
      ),
    );

    const batch = await jiraSource(() => NOW).fetchSince(new Date("2026-03-06T00:00:00Z"), ["TEAM-1234"], makeContext());

    expect(batch.snapshots).toHaveLength(1);
    expect(batch.snapshots[0].id).toBe("TEAM-4321");
    expect(field(batch.snapshots[0].payload, "url")).toBe(`${BASE_URL}/browse/TEAM-4321`);
  });
});

// --- Confluence -------------------------------------------------------------------

const confluencePage = {
  id: "page-1",
  title: "Search Revamp design",
  status: "current",
  space: { name: "Engineering", key: "ENG" },
  _links: { webui: "/spaces/ENG/pages/page-1" },
  version: { number: 4 },
  history: {
    createdBy: { accountId: ACCOUNT_ID },
    createdDate: "2026-03-03T09:00:00.000Z",
    lastUpdated: { when: "2026-03-05T16:00:00.000Z" },
  },
};

/** Answers the contributor CQL with `pages` and the comment CQL with `comments`. */
function confluenceHandler(pages: unknown[], comments: unknown[]) {
  return http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
    const cql = new URL(request.url).searchParams.get("cql") || "";
    return HttpResponse.json({ results: cql.includes("type = comment") ? comments : pages });
  });
}

describe("confluenceSource", () => {
  it("is unavailable when the account id is missing", async () => {
    const availability = await confluenceSource(() => NOW).isAvailable(
      makeContext({ identity: { atlassianAccountId: "", githubUsername: USERNAME } }),
    );
    expect(availability.ok).toBe(false);
    if (availability.ok) return;
    expect(availability.reason).toContain("who you are in Atlassian");
  });

  it("snapshots pages and dates created and version events from the page history", async () => {
    const seenCql: string[] = [];
    server.use(
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
        const cql = new URL(request.url).searchParams.get("cql") || "";
        seenCql.push(cql);
        return HttpResponse.json({ results: cql.includes("type = comment") ? [] : [confluencePage] });
      }),
    );

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());

    expect(seenCql[0]).toBe(`contributor = "${ACCOUNT_ID}" AND type = page AND lastModified >= "2026-03-02" AND lastModified <= "2026-03-08"`);
    expect(seenCql[1]).toBe(`type = comment AND creator = "${ACCOUNT_ID}" AND created >= "2026-03-02" AND created <= "2026-03-08"`);

    expect(batch.snapshots).toHaveLength(1);
    expect(batch.snapshots[0]).toMatchObject({
      id: "page-1",
      firstSeenAt: NOW_ISO,
      payload: {
        title: "Search Revamp design",
        url: `${BASE_URL}/wiki/spaces/ENG/pages/page-1`,
        space: "Engineering",
      },
    });

    expect(kinds(batch.events).sort()).toEqual(["created", "version"]);
    expect(findEvent(batch.events, "created")?.at).toBe("2026-03-03T09:00:00.000Z");
    expect(findEvent(batch.events, "version")?.at).toBe("2026-03-05T16:00:00.000Z");
    expect(findEvent(batch.events, "version")?.id).toBe("page-1:v4");
  });

  it("does not call a page created by someone else a creation", async () => {
    const theirPage = { ...confluencePage, history: { ...confluencePage.history, createdBy: { accountId: "someone-else" } } };
    server.use(confluenceHandler([theirPage], []));

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());
    expect(kinds(batch.events)).toEqual(["version"]);
  });

  it("marks a page with no usable edit time as spotted at the clock", async () => {
    const undateable = { ...confluencePage, history: { createdBy: { accountId: "someone-else" } } };
    server.use(confluenceHandler([undateable], []));

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].kind).toBe("version");
    expect(batch.events[0].at).toBe(NOW_ISO);
    expect(field(batch.events[0].payload, "spotted")).toBe(true);
  });

  it("records a comment against its container, snapshotting a page it only saw that way", async () => {
    const comment = {
      id: "comment-9",
      history: { createdDate: "2026-03-06T13:00:00.000Z" },
      container: {
        id: "page-2",
        title: "Search Revamp rollout",
        space: { name: "Engineering", key: "ENG" },
        _links: { webui: "/spaces/ENG/pages/page-2" },
      },
    };
    server.use(confluenceHandler([], [comment]));

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.snapshots.map((s) => s.id)).toEqual(["page-2"]);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ kind: "comment", itemId: "page-2", at: "2026-03-06T13:00:00.000Z", id: "comment-9" });
  });

  it("warns and keeps the page history when the comment search fails", async () => {
    server.use(
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
        const cql = new URL(request.url).searchParams.get("cql") || "";
        if (cql.includes("type = comment")) return HttpResponse.json({ message: "Server error" }, { status: 500 });
        return HttpResponse.json({ results: [confluencePage] });
      }),
    );

    const ctx = makeContext();
    const batch = await confluenceSource(() => NOW).fetchWindow(window, ctx);

    expect(batch.warnings.some((w) => w.includes("Confluence comment search failed"))).toBe(true);
    expect(ctx.warnings).toEqual(batch.warnings);
    expect(batch.snapshots).toHaveLength(1);
  });

  it("makes no HTTP call when there is nothing to ask about", async () => {
    server.use(...noRequestsAllowed);
    const batch = await confluenceSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());
    expect(batch).toEqual({ snapshots: [], events: [], warnings: [] });
  });

  it("reports only versions newer than the watermark", async () => {
    const since = new Date("2026-03-06T00:00:00Z");
    const seenCql: string[] = [];
    server.use(
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
        seenCql.push(new URL(request.url).searchParams.get("cql") || "");
        return HttpResponse.json({
          results: [
            confluencePage, // last updated 5 March: older than the watermark
            {
              ...confluencePage,
              id: "page-3",
              version: { number: 2 },
              history: { ...confluencePage.history, lastUpdated: { when: "2026-03-07T10:00:00.000Z" } },
            },
          ],
        });
      }),
    );

    const batch = await confluenceSource(() => NOW).fetchSince(since, ["page-1", "page-3"], makeContext());

    expect(seenCql[0]).toBe('id in (page-1, page-3) AND lastModified > "2026-03-06"');
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ kind: "version", itemId: "page-3", at: "2026-03-07T10:00:00.000Z", id: "page-3:v2" });
  });
});

// --- GitHub ---------------------------------------------------------------------

const PR_URL = "https://github.com/example-org/repo/pull/42";
const REVIEWED_PR_URL = "https://github.com/example-org/repo/pull/7";

const authoredPR = {
  number: 42,
  title: "Search Revamp: index writer",
  state: "closed",
  created_at: "2026-03-03T09:00:00Z",
  updated_at: "2026-03-05T09:00:00Z",
  merged_at: "2026-03-05T09:00:00Z",
  closed_at: "2026-03-05T09:00:00Z",
  html_url: PR_URL,
  repository_url: "https://api.github.com/repos/example-org/repo",
  user: { login: USERNAME },
};

const reviewedPR = {
  number: 7,
  title: "Search Revamp: query parser",
  state: "open",
  created_at: "2026-03-02T09:00:00Z",
  updated_at: "2026-03-04T09:00:00Z",
  html_url: REVIEWED_PR_URL,
  repository_url: "https://api.github.com/repos/example-org/repo",
  user: { login: "other-user" },
};

/** Answers the authored search with `authored` and the reviewed-by search with `reviewed`. */
function searchHandler(authored: unknown[], reviewed: unknown[]) {
  return http.get("https://api.github.com/search/issues", ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") || "";
    const items = q.includes("reviewed-by:") ? reviewed : authored;
    return HttpResponse.json({ total_count: items.length, items });
  });
}

describe("githubSource", () => {
  it("is unavailable when no organisation is configured", async () => {
    const availability = await githubSource(() => NOW).isAvailable(makeContext({ config: { ...mockConfig, githubOrgs: [] } }));
    expect(availability.ok).toBe(false);
    if (availability.ok) return;
    expect(availability.reason).toContain("no GitHub organisation is configured");
    expect(availability.reason).toContain("worklog configure github");
  });

  it("is unavailable when the username is unknown", async () => {
    const availability = await githubSource(() => NOW).isAvailable(
      makeContext({ identity: { atlassianAccountId: ACCOUNT_ID, githubUsername: "" } }),
    );
    expect(availability.ok).toBe(false);
    if (availability.ok) return;
    expect(availability.reason).toContain("GitHub username");
  });

  it("snapshots PRs and dates created and merged events from the PR's own times", async () => {
    const seenQueries: string[] = [];
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") || "";
        seenQueries.push(q);
        const items = q.includes("reviewed-by:") ? [] : [authoredPR];
        return HttpResponse.json({ total_count: items.length, items });
      }),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    expect(seenQueries[0]).toBe(`type:pr author:${USERNAME} org:example-org created:2026-03-02..2026-03-08`);
    expect(seenQueries[1]).toBe(`type:pr reviewed-by:${USERNAME} org:example-org updated:2026-03-02..2026-03-08`);

    expect(batch.snapshots[0]).toMatchObject({
      id: PR_URL,
      firstSeenAt: NOW_ISO,
      payload: { title: "Search Revamp: index writer", url: PR_URL, repo: "example-org/repo", number: 42 },
    });

    expect(kinds(batch.events).sort()).toEqual(["created", "merged"]);
    expect(findEvent(batch.events, "created")?.at).toBe("2026-03-03T09:00:00.000Z");
    expect(findEvent(batch.events, "merged")?.at).toBe("2026-03-05T09:00:00.000Z");
  });

  it("reports a closed PR that was never merged", async () => {
    const abandoned = { ...authoredPR, merged_at: undefined, closed_at: "2026-03-04T12:00:00Z" };
    server.use(searchHandler([abandoned], []));

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    expect(kinds(batch.events).sort()).toEqual(["closed", "created"]);
    expect(findEvent(batch.events, "closed")?.at).toBe("2026-03-04T12:00:00.000Z");
  });

  it("dates a review left in a later week by the review's own timestamp", async () => {
    // The PR was found by this window's reviewed-by search, but the review itself came in
    // eleven days later. It must be reported with its own date, not the window's.
    server.use(
      searchHandler([], [reviewedPR]),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7/reviews", () =>
        HttpResponse.json([
          { id: 501, user: { login: USERNAME }, state: "APPROVED", body: "Ship it.", submitted_at: "2026-03-19T15:00:00Z" },
          { id: 502, user: { login: "other-user" }, state: "COMMENTED", body: "Thanks.", submitted_at: "2026-03-19T16:00:00Z" },
        ]),
      ),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    const reviews = batch.events.filter((e) => e.kind === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ itemId: REVIEWED_PR_URL, at: "2026-03-19T15:00:00.000Z", id: "501" });
    expect(reviews[0].payload).toEqual({ state: "APPROVED", text: "Ship it." });
  });

  it("warns instead of throwing when the reviews endpoint fails", async () => {
    server.use(
      searchHandler([], [reviewedPR]),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7/reviews", () =>
        HttpResponse.json({ message: "Server error" }, { status: 500 }),
      ),
    );

    const ctx = makeContext();
    const batch = await githubSource(() => NOW).fetchWindow(window, ctx);

    expect(batch.warnings.some((w) => w.includes("Could not read reviews for example-org/repo#7") && w.includes("500"))).toBe(true);
    expect(ctx.warnings).toEqual(batch.warnings);
    expect(batch.events.filter((e) => e.kind === "review")).toHaveLength(0);
    expect(batch.snapshots).toHaveLength(1);
  });

  it("warns when the reviewed-by search fails and still returns authored PRs", async () => {
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") || "";
        if (q.includes("reviewed-by:")) return HttpResponse.json({ message: "Server error" }, { status: 500 });
        return HttpResponse.json({ total_count: 1, items: [authoredPR] });
      }),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.warnings.some((w) => w.includes("GitHub reviewed-PR search failed"))).toBe(true);
    expect(batch.snapshots).toHaveLength(1);
  });

  it("rejects when the authored search fails", async () => {
    server.use(http.get("https://api.github.com/search/issues", () => HttpResponse.json({}, { status: 502 })));
    await expect(githubSource(() => NOW).fetchWindow(window, makeContext())).rejects.toThrow("GitHub API error 502");
  });

  it("makes no HTTP call when there is nothing to ask about", async () => {
    server.use(...noRequestsAllowed);
    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());
    expect(batch).toEqual({ snapshots: [], events: [], warnings: [] });
  });

  it("reports reviews, merges and closures newer than the watermark, and stores their ETags", async () => {
    const since = new Date("2026-03-06T00:00:00Z");
    server.use(
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", () =>
        HttpResponse.json(
          [
            { id: 601, user: { login: USERNAME }, state: "APPROVED", body: "Old review.", submitted_at: "2026-03-04T09:00:00Z" },
            { id: 602, user: { login: USERNAME }, state: "CHANGES_REQUESTED", body: "New review.", submitted_at: "2026-03-07T09:00:00Z" },
          ],
          { headers: { ETag: '"reviews-v2"' } },
        ),
      ),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () =>
        HttpResponse.json(
          { ...authoredPR, merged_at: "2026-03-08T10:00:00Z", closed_at: "2026-03-08T10:00:00Z" },
          { headers: { ETag: '"pr-v2"' } },
        ),
      ),
    );

    const ctx = makeContext();
    const batch = await githubSource(() => NOW).fetchSince(since, [PR_URL], ctx);

    expect(kinds(batch.events).sort()).toEqual(["merged", "review"]);
    expect(findEvent(batch.events, "review")?.id).toBe("602");
    expect(findEvent(batch.events, "review")?.at).toBe("2026-03-07T09:00:00.000Z");
    expect(findEvent(batch.events, "merged")?.at).toBe("2026-03-08T10:00:00.000Z");

    expect(ctx.store.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews")).toBe('"reviews-v2"');
    expect(ctx.store.get("https://api.github.com/repos/example-org/repo/pulls/42")).toBe('"pr-v2"');
  });

  it("sends the stored ETag and does nothing at all with a 304", async () => {
    const sentHeaders: Array<string | null> = [];
    server.use(
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", ({ request }) => {
        sentHeaders.push(request.headers.get("If-None-Match"));
        return new HttpResponse(null, { status: 304 });
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", ({ request }) => {
        sentHeaders.push(request.headers.get("If-None-Match"));
        return new HttpResponse(null, { status: 304 });
      }),
    );

    const ctx = makeContext();
    ctx.store.set("https://api.github.com/repos/example-org/repo/pulls/42/reviews", '"reviews-v1"');
    ctx.store.set("https://api.github.com/repos/example-org/repo/pulls/42", '"pr-v1"');

    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-06T00:00:00Z"), [PR_URL], ctx);

    expect(sentHeaders).toEqual(['"reviews-v1"', '"pr-v1"']);
    expect(batch.events).toHaveLength(0);
    expect(batch.warnings).toHaveLength(0);
    expect(batch.snapshots).toHaveLength(0);
  });

  it("warns on an id it cannot read as a pull request url", async () => {
    server.use(...noRequestsAllowed);
    const ctx = makeContext();
    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-06T00:00:00Z"), ["not-a-pr-url"], ctx);

    expect(batch.events).toHaveLength(0);
    expect(batch.warnings[0]).toContain("not a pull request url");
    expect(ctx.warnings).toEqual(batch.warnings);
  });
});
