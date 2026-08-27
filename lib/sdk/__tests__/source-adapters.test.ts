import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { z } from "zod";
import { confluenceSource, githubSource, jiraSource } from "../source-adapters";
import { renderable } from "../ledger";
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

const server = setupServer();

/** The history of `confluencePage`: one edit, the user's, matching its `lastUpdated`. */
const defaultVersions = http.get(`${BASE_URL}/wiki/api/v2/pages/:id/versions`, () =>
  HttpResponse.json({ results: [{ number: 4, createdAt: "2026-03-05T16:00:00.000Z", authorId: ACCOUNT_ID }] }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
/** No pull request conversation, for the tests that are about something else. */
const defaultIssueComments = http.get("https://api.github.com/repos/:owner/:repo/issues/:number/comments", () =>
  HttpResponse.json([]),
);

/** No commits, for the tests that are about something else on the pull request. */
const defaultPrCommits = http.get("https://api.github.com/repos/:owner/:repo/pulls/:number/commits", () =>
  HttpResponse.json([]),
);

beforeEach(() => server.use(defaultVersions, defaultIssueComments, defaultPrCommits));
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
          author: { accountId: ACCOUNT_ID },
          body: { content: [{ content: [{ text: "Looks good." }] }] },
        },
        // A colleague's comment on the same ticket. It is not this user's work and must
        // not turn up in this user's week.
        {
          id: "c-them",
          created: "2026-03-04T12:00:00.000+0000",
          author: { accountId: "someone-else" },
          body: { content: [{ content: [{ text: "Thanks for picking this up." }] }] },
        },
      ],
    },
  },
};

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
        seenJql.push(z.object({ jql: z.string() }).parse(await request.json()).jql);
        return HttpResponse.json({ issues: [jiraIssue] });
      }),
    );

    const ctx = makeContext();
    const batch = await jiraSource(() => NOW).fetchWindow(window, ctx);

    expect(seenJql[0]).toBe(
      '(assignee = "user@example.com" OR reporter = "user@example.com") AND created <= "2026-03-08" AND updated >= "2026-03-02" ORDER BY updated DESC',
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
    expect(renderable(comment?.payload).text).toBe("Looks good.");
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
            {
              id: "c-late",
              created: "2026-03-16T08:15:00.000+0000",
              author: { accountId: ACCOUNT_ID },
              body: { content: [{ content: [{ text: "Still relevant." }] }] },
            },
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
    // No `updated` at all: something moved this issue into the search results and Jira
    // will not say when, so the only honest date is the one we found it on.
    const undateable = {
      key: "TEAM-9999",
      fields: {
        summary: "Search Revamp rollout",
        status: { name: "Done" },
        created: "2026-01-05T09:00:00.000+0000",
      },
    };
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [undateable] })));

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].kind).toBe("active");
    expect(batch.events[0].at).toBe(NOW_ISO);
    expect(renderable(batch.events[0].payload).spotted).toBe(true);
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
    expect(renderable(batch.events[0].payload).spotted).toBeUndefined();
  });

  it("rejects when the primary query fails", async () => {
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({}, { status: 500 })));
    await expect(jiraSource(() => NOW).fetchWindow(window, makeContext())).rejects.toThrow("Jira API error 500");
  });

  it("goes looking for issues it has never seen, not only the ones it knows", async () => {
    // Nothing known: the trigger is a ticket created after the week was first fetched,
    // which is in nobody's list of known ids and would otherwise stay invisible.
    const seenJql: string[] = [];
    const fresh = {
      ...jiraIssue,
      key: "TEAM-7777",
      fields: { ...jiraIssue.fields, created: "2026-03-09T09:00:00.000+0000", comment: { comments: [] } },
    };
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
        seenJql.push(z.object({ jql: z.string() }).parse(await request.json()).jql);
        return HttpResponse.json({ issues: [fresh] });
      }),
    );

    const batch = await jiraSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());

    expect(seenJql[0]).toBe(
      '(assignee = "user@example.com" OR reporter = "user@example.com") AND updated > "2026-03-08 00:00"',
    );
    expect(batch.snapshots.map((s) => s.id)).toEqual(["TEAM-7777"]);
    expect(findEvent(batch.events, "created")?.at).toBe("2026-03-09T09:00:00.000Z");
  });

  it("reports only changelog entries and comments newer than the watermark", async () => {
    const since = new Date("2026-03-06T00:00:00Z");
    const searchBody = z.object({ jql: z.string(), expand: z.string() });
    let seenBody: z.infer<typeof searchBody> | undefined;
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
        seenBody = searchBody.parse(await request.json());
        return HttpResponse.json({
          issues: [
            {
              ...jiraIssue,
              fields: {
                ...jiraIssue.fields,
                comment: {
                  comments: [
                    { id: "c-old", created: "2026-03-04T11:30:00.000+0000", author: { accountId: ACCOUNT_ID }, body: { content: [{ content: [{ text: "Old." }] }] } },
                    { id: "c-new", created: "2026-03-07T09:00:00.000+0000", author: { accountId: ACCOUNT_ID }, body: { content: [{ content: [{ text: "New." }] }] } },
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

    expect(seenBody?.jql).toBe(
      '(assignee = "user@example.com" OR reporter = "user@example.com" OR key in (TEAM-1234)) AND updated > "2026-03-06 00:00"',
    );
    expect(seenBody?.expand).toBe("changelog");

    expect(kinds(batch.events).sort()).toEqual(["comment", "description", "status"]);

    const status = findEvent(batch.events, "status");
    expect(status?.at).toBe("2026-03-07T10:00:00.000Z");
    expect(status?.id).toBe("h-new:status");
    expect(status?.payload).toEqual({ from: "In Progress", to: "Done" });

    expect(renderable(findEvent(batch.events, "description")?.payload).text).toBe("new text");
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
    expect(renderable(batch.snapshots[0].payload).url).toBe(`${BASE_URL}/browse/TEAM-4321`);
  });
});

// --- Confluence -------------------------------------------------------------------

const confluencePage = {
  id: "page-1",
  title: "Search Revamp design",
  status: "current",
  space: { name: "Engineering", key: "ENG" },
  _links: { webui: "/spaces/ENG/pages/page-1" },
  version: { number: 4, authorId: ACCOUNT_ID },
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

    expect(seenCql[0]).toBe(`contributor = "${ACCOUNT_ID}" AND type = page AND created <= "2026-03-08" AND lastModified >= "2026-03-02"`);
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

  it("records nothing about a page whose history will not say who edited it", async () => {
    // A page that moved and a history that will not answer. Dating the move at the clock
    // and calling it the user's own would be a guess about authorship, and the ledger is
    // append-only: a later read proving it was a colleague's could not take it back.
    const undateable = { ...confluencePage, history: { createdBy: { accountId: "someone-else" } } };
    server.use(
      confluenceHandler([undateable], []),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, () => HttpResponse.json({}, { status: 503 })),
    );

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.events).toEqual([]);
    expect(batch.snapshots).toEqual([]);
    // Marked unfinished, so the week is not written up and is asked about again.
    expect(batch.incomplete).toBe(true);
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

  it("goes looking for pages it has never seen, not only the ones it knows", async () => {
    const seenCql: string[] = [];
    server.use(
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
        const cql = new URL(request.url).searchParams.get("cql") || "";
        seenCql.push(cql);
        return HttpResponse.json({ results: cql.includes("type = comment") ? [] : [{ ...confluencePage, id: "page-new" }] });
      }),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-new/versions`, () =>
        HttpResponse.json({ results: [{ number: 1, createdAt: "2026-03-09T10:00:00.000Z", authorId: ACCOUNT_ID }] }),
      ),
    );

    const batch = await confluenceSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());

    expect(seenCql[0]).toBe(`(contributor = "${ACCOUNT_ID}" AND type = page) AND lastModified > "2026-03-08"`);
    expect(batch.snapshots.map((s) => s.id)).toEqual(["page-new"]);
    expect(batch.events[0]).toMatchObject({ kind: "version", itemId: "page-new", at: "2026-03-09T10:00:00.000Z" });
  });

  it("reports every version made since the watermark, each on its own date", async () => {
    // The trigger: two edits and a comment between two runs. Reporting only the page's
    // current version would put one edit in one week and lose the other entirely.
    const since = new Date("2026-03-06T00:00:00Z");
    const seenCql: string[] = [];
    server.use(
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
        const cql = new URL(request.url).searchParams.get("cql") || "";
        seenCql.push(cql);
        if (cql.includes("type = comment")) {
          return HttpResponse.json({
            results: [{
              id: "comment-9",
              history: { createdDate: "2026-03-09T12:00:00.000Z" },
              container: { id: "page-1", title: "Search Revamp design", _links: { webui: "/spaces/ENG/pages/page-1" } },
            }],
          });
        }
        return HttpResponse.json({ results: [confluencePage] });
      }),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, () =>
        HttpResponse.json({
          results: [
            { number: 5, createdAt: "2026-03-08T10:00:00.000Z", authorId: ACCOUNT_ID },
            { number: 4, createdAt: "2026-03-07T10:00:00.000Z", authorId: ACCOUNT_ID },
            { number: 3, createdAt: "2026-03-05T10:00:00.000Z", authorId: ACCOUNT_ID }, // older than the watermark
          ],
        }),
      ),
    );

    const batch = await confluenceSource(() => NOW).fetchSince(since, ["page-1"], makeContext());

    expect(seenCql[0]).toBe(`((contributor = "${ACCOUNT_ID}" AND type = page) OR id in (page-1)) AND lastModified > "2026-03-06"`);
    expect(seenCql[1]).toBe(`type = comment AND creator = "${ACCOUNT_ID}" AND created > "2026-03-06"`);

    const versions = batch.events.filter((e) => e.kind === "version");
    expect(versions.map((e) => e.at)).toEqual(["2026-03-08T10:00:00.000Z", "2026-03-07T10:00:00.000Z"]);
    expect(versions.map((e) => e.id)).toEqual(["page-1:v5", "page-1:v4"]);

    const comment = findEvent(batch.events, "comment");
    expect(comment).toMatchObject({ itemId: "page-1", at: "2026-03-09T12:00:00.000Z", id: "comment-9" });
  });
});

// --- GitHub ---------------------------------------------------------------------

const PR_URL = "https://github.com/example-org/repo/pull/42";
const REVIEWED_PR_URL = "https://github.com/example-org/repo/pull/7";

/**
 * As GitHub's *search* endpoint describes a merged pull request.
 *
 * Search answers with issues, and an issue has no top-level `merged_at`: merging is
 * described in the nested `pull_request` object, while `closed_at` is set for a merge
 * too. A fixture that invented a top-level `merged_at` let a merge read as a closure in
 * the real world while every test passed, so these mirror the documented shape.
 */
const authoredPR = {
  number: 42,
  title: "Search Revamp: index writer",
  state: "closed",
  created_at: "2026-03-03T09:00:00Z",
  updated_at: "2026-03-05T09:00:00Z",
  closed_at: "2026-03-05T09:00:00Z",
  pull_request: { url: "https://api.github.com/repos/example-org/repo/pulls/42", merged_at: "2026-03-05T09:00:00Z" },
  html_url: PR_URL,
  repository_url: "https://api.github.com/repos/example-org/repo",
  user: { login: USERNAME },
};

/** As the pull request endpoint describes the same thing, where `merged_at` is top level. */
const authoredPRDetail = {
  ...authoredPR,
  pull_request: undefined,
  merged_at: "2026-03-05T09:00:00Z",
};

const reviewedPR = {
  number: 7,
  title: "Search Revamp: query parser",
  state: "open",
  created_at: "2026-03-02T09:00:00Z",
  updated_at: "2026-03-04T09:00:00Z",
  pull_request: { url: "https://api.github.com/repos/example-org/repo/pulls/7" },
  html_url: REVIEWED_PR_URL,
  repository_url: "https://api.github.com/repos/example-org/repo",
  user: { login: "other-user" },
};

/** Answers the authored search with `authored`, and every other-people search with `reviewed`. */
function searchHandler(authored: unknown[], reviewed: unknown[]) {
  return http.get("https://api.github.com/search/issues", ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") || "";
    const items = q.includes(`author:${USERNAME}`) ? authored : reviewed;
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
        const items = q.includes(`author:${USERNAME}`) ? [authoredPR] : [];
        return HttpResponse.json({ total_count: items.length, items });
      }),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    expect(seenQueries[0]).toBe(`type:pr author:${USERNAME} org:example-org created:<=2026-03-08 updated:>=2026-03-02`);
    expect(seenQueries[1]).toBe(`type:pr reviewed-by:${USERNAME} org:example-org created:<=2026-03-08 updated:>=2026-03-02`);

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
    const abandoned = { ...authoredPR, pull_request: { url: authoredPR.pull_request.url }, closed_at: "2026-03-04T12:00:00Z" };
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

    expect(batch.warnings.some((w) => w.includes("A GitHub reviewed-by search failed"))).toBe(true);
    expect(batch.snapshots).toHaveLength(1);
  });

  it("rejects when the authored search fails", async () => {
    server.use(http.get("https://api.github.com/search/issues", () => HttpResponse.json({}, { status: 502 })));
    await expect(githubSource(() => NOW).fetchWindow(window, makeContext())).rejects.toThrow("GitHub API error 502");
  });

  it("goes looking for pull requests it has never seen, not only the ones it knows", async () => {
    const seenQueries: string[] = [];
    const freshPR = { ...authoredPR, number: 99, html_url: "https://github.com/example-org/repo/pull/99",
      created_at: "2026-03-09T09:00:00Z", pull_request: { url: "https://api.github.com/repos/example-org/repo/pulls/99" }, closed_at: null };
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        seenQueries.push(new URL(request.url).searchParams.get("q") || "");
        return HttpResponse.json({ total_count: 1, items: [freshPR] });
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/99/reviews", () => HttpResponse.json([])),
      http.get("https://api.github.com/repos/example-org/repo/pulls/99", () => HttpResponse.json(freshPR)),
    );

    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());

    expect(seenQueries[0]).toBe("type:pr author:example-user org:example-org updated:>=2026-03-08");
    expect(batch.snapshots.map((s) => s.id)).toEqual(["https://github.com/example-org/repo/pull/99"]);
    expect(findEvent(batch.events, "created")?.at).toBe("2026-03-09T09:00:00.000Z");
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
          { ...authoredPRDetail, merged_at: "2026-03-08T10:00:00Z", closed_at: "2026-03-08T10:00:00Z" },
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

    // Keyed by the watermark too: an ETag earned while scanning from 6 March says
    // nothing about a scan that starts earlier.
    const scope = `|since:${since.toISOString()}`;
    expect(ctx.store.get(`https://api.github.com/repos/example-org/repo/pulls/42/reviews?per_page=100&page=1${scope}`)).toBe('"reviews-v2"');
    expect(ctx.store.get(`https://api.github.com/repos/example-org/repo/pulls/42${scope}`)).toBe('"pr-v2"');
  });

  it("sends the stored ETag and does nothing at all with a 304", async () => {
    const sentHeaders: Array<string | null> = [];
    server.use(
      // Nothing new to discover; the point of this test is the two conditional GETs.
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", ({ request }) => {
        sentHeaders.push(request.headers.get("If-None-Match"));
        return new HttpResponse(null, { status: 304 });
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", ({ request }) => {
        sentHeaders.push(request.headers.get("If-None-Match"));
        return new HttpResponse(null, { status: 304 });
      }),
    );

    const since = new Date("2026-03-06T00:00:00Z");
    const scope = `|since:${since.toISOString()}`;
    const ctx = makeContext();
    const reviewsPage = `https://api.github.com/repos/example-org/repo/pulls/42/reviews?per_page=100&page=1${scope}`;
    ctx.store.set(reviewsPage, '"reviews-v1"');
    // How much that page held, which is what tells the walk it was the last one. An ETag
    // on its own says "unchanged" and nothing about whether more pages follow.
    ctx.store.set(`${reviewsPage}#rows`, "3");
    ctx.store.set(`https://api.github.com/repos/example-org/repo/pulls/42${scope}`, '"pr-v1"');

    const batch = await githubSource(() => NOW).fetchSince(since, [PR_URL], ctx);

    expect(sentHeaders).toEqual(['"reviews-v1"', '"pr-v1"']);
    expect(batch.events).toHaveLength(0);
    expect(batch.warnings).toHaveLength(0);
    expect(batch.snapshots).toHaveLength(0);
  });

  it("warns on an id it cannot read as a pull request url", async () => {
    server.use(http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })));
    const ctx = makeContext();
    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-06T00:00:00Z"), ["not-a-pr-url"], ctx);

    expect(batch.events).toHaveLength(0);
    expect(batch.warnings[0]).toContain("not a pull request url");
    expect(ctx.warnings).toEqual(batch.warnings);
  });
});

describe("what belongs to the user and what does not", () => {
  it("leaves a colleague's comment out of the user's week", async () => {
    // The trigger: a coworker comments on a ticket assigned to the user. Recording it
    // makes somebody else's words evidence of the user's work.
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [jiraIssue] })));

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());
    const comments = batch.events.filter((e) => e.kind === "comment");

    expect(comments.map((e) => e.id)).toEqual(["c-1"]);
    expect(comments.some((e) => renderable(e.payload).text?.includes("Thanks for picking this up"))).toBe(false);
  });

  it("leaves it out of a delta too", async () => {
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [jiraIssue] })));

    const batch = await jiraSource(() => NOW).fetchSince(new Date("2026-03-01T00:00:00Z"), ["TEAM-1234"], makeContext());
    expect(batch.events.filter((e) => e.kind === "comment").map((e) => e.id)).toEqual(["c-1"]);
  });
});

describe("lifecycle events a week did not open in", () => {
  it("gives a Jira week the status change made in it, not the issue's latest state", async () => {
    // The trigger: created in one week, moved in the next, last touched in a third.
    // Searching on the issue's own `updated` and ignoring the changelog reports the
    // issue once, to the wrong week, with no idea what actually happened.
    const moved = {
      ...jiraIssue,
      fields: { ...jiraIssue.fields, created: "2026-03-03T09:00:00.000+0000", updated: "2026-03-20T17:00:00.000+0000", comment: { comments: [] } },
      changelog: {
        histories: [
          { id: "h-1", created: "2026-03-11T10:00:00.000+0000", items: [{ field: "status", fromString: "To Do", toString: "In Progress" }] },
        ],
      },
    };
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [moved] })));

    const secondWeek: SourceWindow = { start: new Date("2026-03-09T00:00:00Z"), end: new Date("2026-03-15T23:59:59Z") };
    const batch = await jiraSource(() => NOW).fetchWindow(secondWeek, makeContext());

    const status = findEvent(batch.events, "status");
    expect(status?.at).toBe("2026-03-11T10:00:00.000Z");
    expect(renderable(status?.payload).to).toBe("In Progress");
    // Nothing from the week it was opened in, and nothing from the week it last moved in.
    expect(kinds(batch.events)).toEqual(["status"]);
  });

  it("follows the pages of a long Jira changelog", async () => {
    const paged = {
      ...jiraIssue,
      fields: { ...jiraIssue.fields, comment: { comments: [] } },
      changelog: {
        total: 2,
        histories: [
          { id: "h-1", created: "2026-03-04T10:00:00.000+0000", items: [{ field: "status", fromString: "To Do", toString: "In Progress" }] },
        ],
      },
    };
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [paged] })),
      http.get(`${BASE_URL}/rest/api/3/issue/TEAM-1234/changelog`, ({ request }) => {
        // The real endpoint serves from the offset it is asked for. The embedded page in
        // the search result is at an offset Jira chose, so the walk starts again at zero.
        const startAt = Number(new URL(request.url).searchParams.get("startAt") ?? "0");
        const all = [
          { id: "h-1", created: "2026-03-04T10:00:00.000+0000", items: [{ field: "status", fromString: "To Do", toString: "In Progress" }] },
          { id: "h-2", created: "2026-03-05T10:00:00.000+0000", items: [{ field: "status", fromString: "In Progress", toString: "Done" }] },
        ];
        return HttpResponse.json({ values: all.slice(startAt), startAt, total: all.length, isLast: true });
      }),
    );

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.events.filter((e) => e.kind === "status").map((e) => e.id)).toEqual(["h-1:status", "h-2:status"]);
  });

  it("gives a GitHub week the merge that happened in it, even though the PR is older", async () => {
    // The trigger: opened in one week, merged in the next. Searching by creation date
    // means the merging week never finds the PR, and the opening week throws the merge
    // away for being out of range, so the merge is recorded nowhere at all.
    const seenQueries: string[] = [];
    const mergedLater = {
      ...authoredPR, created_at: "2026-03-03T09:00:00Z", closed_at: "2026-03-11T09:00:00Z",
      pull_request: { ...authoredPR.pull_request, merged_at: "2026-03-11T09:00:00Z" },
    };
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") || "";
        seenQueries.push(q);
        const items = q.includes(`author:${USERNAME}`) ? [mergedLater] : [];
        return HttpResponse.json({ total_count: items.length, items });
      }),
    );

    const secondWeek: SourceWindow = { start: new Date("2026-03-09T00:00:00Z"), end: new Date("2026-03-15T23:59:59Z") };
    const batch = await githubSource(() => NOW).fetchWindow(secondWeek, makeContext());

    expect(seenQueries[0]).toContain("created:<=2026-03-15 updated:>=2026-03-09");
    expect(kinds(batch.events)).toEqual(["merged"]);
    expect(findEvent(batch.events, "merged")?.at).toBe("2026-03-11T09:00:00.000Z");
  });
});

describe("an item touched again after the week it moved in", () => {
  it("is still found by that week's first fetch", async () => {
    // The trigger: status changed 4 March, issue touched again 20 March. A search
    // bounded above by the issue's current `updated` returns nothing for a 2–8 March
    // backfill, and the window is then marked fetched, so 4 March is lost for good.
    const seenJql: string[] = [];
    const touchedLater = {
      ...jiraIssue,
      fields: { ...jiraIssue.fields, updated: "2026-03-20T17:00:00.000+0000", comment: { comments: [] } },
      changelog: {
        histories: [
          { id: "h-1", created: "2026-03-04T10:00:00.000+0000", items: [{ field: "status", fromString: "To Do", toString: "In Progress" }] },
        ],
      },
    };
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, async ({ request }) => {
        seenJql.push(z.object({ jql: z.string() }).parse(await request.json()).jql);
        return HttpResponse.json({ issues: [touchedLater] });
      }),
    );

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());

    expect(seenJql[0]).toContain('created <= "2026-03-08" AND updated >= "2026-03-02"');
    expect(findEvent(batch.events, "status")?.at).toBe("2026-03-04T10:00:00.000Z");
  });

  it("says nothing about a week it merely existed through", async () => {
    // The wider search matches long-lived work every week. A week it did nothing in has
    // nothing to record, or every past week fills up with headings for old tickets.
    const quiet = {
      key: "TEAM-5",
      fields: {
        summary: "Search Revamp cleanup",
        status: { name: "In Review" },
        created: "2026-01-05T09:00:00.000+0000",
        updated: "2026-06-01T09:00:00.000+0000",
      },
    };
    server.use(http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [quiet] })));

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.events).toEqual([]);
    expect(batch.snapshots).toEqual([]);
  });
});

describe("reading a long history to the end", () => {
  it("follows the pages of an issue's comments", async () => {
    // The trigger: a search embeds the first page only. Comment 61 is as likely to be
    // the one that mattered as comment 6.
    const many = {
      ...jiraIssue,
      fields: {
        ...jiraIssue.fields,
        comment: {
          total: 2,
          comments: [
            { id: "c-1", created: "2026-03-04T11:30:00.000+0000", author: { accountId: ACCOUNT_ID }, body: { content: [{ content: [{ text: "First." }] }] } },
          ],
        },
      },
    };
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [many] })),
      http.get(`${BASE_URL}/rest/api/3/issue/TEAM-1234/comment`, ({ request }) => {
        const startAt = Number(new URL(request.url).searchParams.get("startAt") ?? "0");
        const all = [
          { id: "c-1", created: "2026-03-04T11:30:00.000+0000", author: { accountId: ACCOUNT_ID }, body: { content: [{ content: [{ text: "First." }] }] } },
          { id: "c-2", created: "2026-03-05T11:30:00.000+0000", author: { accountId: ACCOUNT_ID }, body: { content: [{ content: [{ text: "Second." }] }] } },
        ];
        return HttpResponse.json({ comments: all.slice(startAt), startAt, total: all.length });
      }),
    );

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.events.filter((e) => e.kind === "comment").map((e) => e.id)).toEqual(["c-1", "c-2"]);
  });

  it("follows the pages of a pull request's reviews", async () => {
    // The trigger: GitHub sends thirty per page by default, so review 31 is dropped.
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i, user: { login: USERNAME }, state: "COMMENTED", body: "n",
      submitted_at: "2026-03-07T09:00:00Z",
    }));
    const seenPages: string[] = [];
    server.use(
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", ({ request }) => {
        const page = new URL(request.url).searchParams.get("page") || "";
        seenPages.push(page);
        if (page === "1") return HttpResponse.json(firstPage);
        return HttpResponse.json([
          { id: 2001, user: { login: USERNAME }, state: "APPROVED", body: "The last word.", submitted_at: "2026-03-08T09:00:00Z" },
        ]);
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () => HttpResponse.json(authoredPRDetail)),
    );

    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-06T00:00:00Z"), [PR_URL], makeContext());

    expect(seenPages).toEqual(["1", "2"]);
    expect(batch.events.filter((e) => e.kind === "review").map((e) => e.id)).toContain("2001");
  });

  it("walks a page's version history until it reaches one the watermark covers", async () => {
    // The trigger: a fixed page cap. Version 201 can still be newer than the watermark,
    // and the watermark then moves past it for good.
    const since = new Date("2026-03-06T00:00:00Z");
    const seenPaths: string[] = [];
    server.use(
      http.get(`${BASE_URL}/wiki/rest/api/content/search`, ({ request }) => {
        const cql = new URL(request.url).searchParams.get("cql") || "";
        return HttpResponse.json({ results: cql.includes("type = comment") ? [] : [confluencePage] });
      }),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor") || "start";
        seenPaths.push(cursor);
        if (cursor === "start") {
          return HttpResponse.json({
            results: [
              { number: 9, createdAt: "2026-03-09T10:00:00.000Z", authorId: ACCOUNT_ID },
              { number: 8, createdAt: "2026-03-08T10:00:00.000Z", authorId: ACCOUNT_ID },
            ],
            _links: { next: "/wiki/api/v2/pages/page-1/versions?cursor=older" },
          });
        }
        return HttpResponse.json({
          results: [
            { number: 7, createdAt: "2026-03-07T10:00:00.000Z", authorId: ACCOUNT_ID },
            { number: 6, createdAt: "2026-03-05T10:00:00.000Z", authorId: ACCOUNT_ID },
          ],
        });
      }),
    );

    const batch = await confluenceSource(() => NOW).fetchSince(since, ["page-1"], makeContext());

    // It went past the first page, and stopped on the one holding a version it already had.
    expect(seenPaths).toEqual(["start", "older"]);
    expect(batch.events.filter((e) => e.kind === "version").map((e) => e.id)).toEqual([
      "page-1:v9", "page-1:v8", "page-1:v7",
    ]);
  });
});

describe("work the user did on somebody else's pull request", () => {
  it("is discovered by the delta even when they never authored anything", async () => {
    // The trigger: the user reviews a PR they did not open, after its week was fetched.
    // It is neither authored nor in the known ids, so a search for authored PRs alone
    // never asks about it and the review is recorded nowhere.
    const seenQueries: string[] = [];
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") || "";
        seenQueries.push(q);
        const items = q.includes(`author:${USERNAME}`) ? [] : [reviewedPR];
        return HttpResponse.json({ total_count: items.length, items });
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7/reviews", () =>
        HttpResponse.json([
          { id: 701, user: { login: USERNAME }, state: "APPROVED", body: "Ship it.", submitted_at: "2026-03-09T15:00:00Z" },
        ]),
      ),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7", () => HttpResponse.json(reviewedPR)),
    );

    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());

    expect(seenQueries.some((q) => q.includes("reviewed-by:example-user"))).toBe(true);
    expect(seenQueries.some((q) => q.includes("commenter:example-user"))).toBe(true);
    expect(batch.snapshots.map((s) => s.id)).toEqual([REVIEWED_PR_URL]);
    expect(findEvent(batch.events, "review")?.id).toBe("701");
    // Somebody else opened it, so its creation is not this user's news.
    expect(batch.events.some((e) => e.kind === "created")).toBe(false);
  });
});

describe("an ETag earned while scanning a recent week", () => {
  it("is not replayed against a scan that reaches further back", async () => {
    // The trigger: the recent scan discards the older review and stores the ETag. The
    // older week's scan then gets a 304 and never sees it — permanently.
    const reviews = [
      { id: 601, user: { login: USERNAME }, state: "APPROVED", body: "Early review.", submitted_at: "2026-03-04T09:00:00Z" },
      { id: 602, user: { login: USERNAME }, state: "CHANGES_REQUESTED", body: "Later review.", submitted_at: "2026-03-07T09:00:00Z" },
    ];
    const sentEtags: Array<string | null> = [];
    server.use(
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", ({ request }) => {
        const sent = request.headers.get("If-None-Match");
        sentEtags.push(sent);
        if (sent === '"reviews-v2"') return new HttpResponse(null, { status: 304 });
        return HttpResponse.json(reviews, { headers: { ETag: '"reviews-v2"' } });
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () => HttpResponse.json(authoredPRDetail)),
    );

    const ctx = makeContext();
    const recent = await githubSource(() => NOW).fetchSince(new Date("2026-03-06T00:00:00Z"), [PR_URL], ctx);
    expect(recent.events.filter((e) => e.kind === "review").map((e) => e.id)).toEqual(["602"]);

    const older = await githubSource(() => NOW).fetchSince(new Date("2026-03-01T00:00:00Z"), [PR_URL], ctx);

    // The older scan asked without the recent scan's ETag, and got the early review.
    expect(sentEtags).toEqual([null, null]);
    expect(older.events.filter((e) => e.kind === "review").map((e) => e.id)).toEqual(["601", "602"]);
  });
});

describe("a merged pull request, as the search endpoint describes it", () => {
  it("is a merge and not a closure", async () => {
    // The trigger: search answers with issues, and an issue has no top-level `merged_at`.
    // Reading only the top level makes every merge look like a closure, and the window
    // watermark then moves past the merge for good.
    server.use(searchHandler([authoredPR], []));

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    expect(kinds(batch.events).sort()).toEqual(["created", "merged"]);
    expect(findEvent(batch.events, "merged")?.at).toBe("2026-03-05T09:00:00.000Z");
    expect(batch.events.some((e) => e.kind === "closed")).toBe(false);
  });

  it("is still a merge when the delta reads it from the pull request endpoint", async () => {
    server.use(
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", () => HttpResponse.json([])),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () =>
        HttpResponse.json({ ...authoredPRDetail, merged_at: "2026-03-09T10:00:00Z", closed_at: "2026-03-09T10:00:00Z" }),
      ),
    );

    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [PR_URL], makeContext());
    expect(kinds(batch.events)).toEqual(["merged"]);
  });
});

describe("a review left in a week the pull request outlived", () => {
  it("is still found when that week is backfilled afterwards", async () => {
    // The trigger: review submitted in W, the PR moves on in W+2, and W is backfilled
    // after that. Bounding the reviewed-by search by the PR's current `updated` excludes
    // it, and the window is marked fetched either way.
    const seenQueries: string[] = [];
    const movedOn = { ...reviewedPR, created_at: "2026-03-02T09:00:00Z", updated_at: "2026-03-19T09:00:00Z" };
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") || "";
        seenQueries.push(q);
        const items = q.includes(`author:${USERNAME}`) ? [] : [movedOn];
        return HttpResponse.json({ total_count: items.length, items });
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7/reviews", () =>
        HttpResponse.json([
          { id: 701, user: { login: USERNAME }, state: "APPROVED", body: "Ship it.", submitted_at: "2026-03-04T15:00:00Z" },
        ]),
      ),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    expect(seenQueries[1]).toContain("created:<=2026-03-08 updated:>=2026-03-02");
    expect(findEvent(batch.events, "review")?.at).toBe("2026-03-04T15:00:00.000Z");
  });
});

describe("a conversation on a pull request", () => {
  it("is recorded, not just the formal reviews", async () => {
    // The trigger: a PR found only because the user commented on it. Fetching reviews
    // and merge state alone produces a snapshot and no event, so the week never hears
    // about the conversation and is never even marked as needing a rewrite.
    server.use(
      http.get("https://api.github.com/search/issues", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") || "";
        const items = q.includes(`commenter:${USERNAME}`) ? [reviewedPR] : [];
        return HttpResponse.json({ total_count: items.length, items });
      }),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7/reviews", () => HttpResponse.json([])),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7", () => HttpResponse.json(reviewedPR)),
      http.get("https://api.github.com/repos/example-org/repo/issues/7/comments", () =>
        HttpResponse.json([
          { id: 9001, user: { login: USERNAME }, body: "Worth splitting the migration out.", created_at: "2026-03-09T11:00:00Z" },
          { id: 9002, user: { login: "other-user" }, body: "Good point.", created_at: "2026-03-09T12:00:00Z" },
          { id: 9003, user: { login: USERNAME }, body: "Too old to be news.", created_at: "2026-03-01T09:00:00Z" },
        ]),
      ),
    );

    const batch = await githubSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), [], makeContext());

    const comments = batch.events.filter((e) => e.kind === "comment");
    expect(comments.map((e) => e.id)).toEqual(["9001"]);
    expect(comments[0]).toMatchObject({ itemId: REVIEWED_PR_URL, at: "2026-03-09T11:00:00.000Z" });
    expect(renderable(comments[0].payload).text).toBe("Worth splitting the migration out.");
  });
});

describe("a Confluence page edited more than once in a week", () => {
  it("reports every edit on its first fetch, not just the state it ended in", async () => {
    // The trigger: versions 3, 4 and 5 all made during the week. The search only ever
    // reports version 5, and the window watermark then moves past the other two.
    server.use(
      confluenceHandler([{ ...confluencePage, version: { number: 5, authorId: ACCOUNT_ID } }], []),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, () =>
        HttpResponse.json({
          results: [
            { number: 5, createdAt: "2026-03-06T10:00:00.000Z", authorId: ACCOUNT_ID },
            { number: 4, createdAt: "2026-03-05T10:00:00.000Z", authorId: ACCOUNT_ID },
            { number: 3, createdAt: "2026-03-04T10:00:00.000Z", authorId: ACCOUNT_ID },
            { number: 2, createdAt: "2026-02-20T10:00:00.000Z", authorId: ACCOUNT_ID }, // before the week
          ],
        }),
      ),
    );

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());

    const versions = batch.events.filter((e) => e.kind === "version");
    expect(versions.map((e) => e.id)).toEqual(["page-1:v5", "page-1:v4", "page-1:v3"]);
    expect(versions.map((e) => e.at)).toEqual([
      "2026-03-06T10:00:00.000Z", "2026-03-05T10:00:00.000Z", "2026-03-04T10:00:00.000Z",
    ]);
  });

  it("leaves out the edits somebody else made", async () => {
    // The trigger: the user contributed once, so the page matches the contributor search
    // for ever, and every later edit by anybody comes back with it.
    server.use(
      confluenceHandler([confluencePage], []),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, () =>
        HttpResponse.json({
          results: [
            { number: 5, createdAt: "2026-03-06T10:00:00.000Z", authorId: "someone-else" },
            { number: 4, createdAt: "2026-03-05T10:00:00.000Z", authorId: ACCOUNT_ID },
          ],
        }),
      ),
    );

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.events.filter((e) => e.kind === "version").map((e) => e.id)).toEqual(["page-1:v4"]);
  });

  it("leaves them out of a delta too, and says nothing at all about a page only they touched", async () => {
    server.use(
      confluenceHandler([confluencePage], []),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, () =>
        HttpResponse.json({
          results: [
            { number: 6, createdAt: "2026-03-09T10:00:00.000Z", authorId: "someone-else" },
            { number: 5, createdAt: "2026-03-05T10:00:00.000Z", authorId: ACCOUNT_ID },
          ],
        }),
      ),
    );

    const batch = await confluenceSource(() => NOW).fetchSince(new Date("2026-03-08T00:00:00Z"), ["page-1"], makeContext());
    expect(batch.events.filter((e) => e.kind === "version")).toEqual([]);
  });

  it("says nothing about a week whose only edits were somebody else's", async () => {
    server.use(
      confluenceHandler([{ ...confluencePage, history: { ...confluencePage.history, createdBy: { accountId: "someone-else" } } }], []),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, () =>
        HttpResponse.json({ results: [{ number: 4, createdAt: "2026-03-05T16:00:00.000Z", authorId: "someone-else" }] }),
      ),
    );

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.events).toEqual([]);
    expect(batch.snapshots).toEqual([]);
  });
});

describe("what the user said on their own pull request", () => {
  it("is read on the first fetch of the week they said it in", async () => {
    // The trigger: PR opened Monday, the user answers review feedback on Tuesday, and
    // the week is first fetched on Sunday. Both searches return the PR; skipping the
    // conversation because the PR was already snapshotted lost Tuesday entirely, and
    // the window is then marked as read.
    const commentCalls: string[] = [];
    const monday = { ...authoredPR, created_at: "2026-03-02T09:00:00Z", closed_at: null, pull_request: { url: authoredPR.pull_request.url } };
    server.use(
      searchHandler([monday], [monday]),
      http.get("https://api.github.com/repos/example-org/repo/issues/42/comments", ({ request }) => {
        commentCalls.push(new URL(request.url).pathname);
        return HttpResponse.json([
          { id: 5001, user: { login: USERNAME }, body: "Split out, good catch.", created_at: "2026-03-03T14:00:00Z" },
          { id: 5002, user: { login: "other-user" }, body: "Looks better.", created_at: "2026-03-03T15:00:00Z" },
        ]);
      }),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    expect(commentCalls).toHaveLength(1);
    const comments = batch.events.filter((e) => e.kind === "comment");
    expect(comments.map((e) => e.id)).toEqual(["5001"]);
    expect(comments[0].at).toBe("2026-03-03T14:00:00.000Z");
    // One snapshot, not two: the PR is in both search results.
    expect(batch.snapshots).toHaveLength(1);
  });

  it("is asked for with GitHub's own since filter on a delta", async () => {
    const since = new Date("2026-03-08T00:00:00Z");
    const asked: string[] = [];
    server.use(
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", () => HttpResponse.json([])),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () => HttpResponse.json(authoredPRDetail)),
      http.get("https://api.github.com/repos/example-org/repo/issues/42/comments", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("since") || "");
        return HttpResponse.json([]);
      }),
    );

    await githubSource(() => NOW).fetchSince(since, [PR_URL], makeContext());

    // Without it a delta pages through years of an old thread to reach yesterday.
    expect(asked).toEqual([since.toISOString()]);
  });
});

describe("a read that did not finish", () => {
  it("says it did not finish rather than inventing an edit of the user's", async () => {
    // The trigger: the user edited this page months ago, a colleague edits it this week,
    // and page two of the history returns 503. Falling back to the page's `lastUpdated`
    // records the colleague's edit as the user's work, and the append-only ledger cannot
    // take it back once a complete read proves otherwise.
    // Created by somebody else, so the only thing this week could record is an edit.
    const theirPage = { ...confluencePage, history: { ...confluencePage.history, createdBy: { accountId: "someone-else" } } };
    server.use(
      confluenceHandler([theirPage], []),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (cursor) return HttpResponse.json({}, { status: 503 });
        return HttpResponse.json({
          results: [{ number: 9, createdAt: "2026-03-06T10:00:00.000Z", authorId: "someone-else" }],
          _links: { next: "/wiki/api/v2/pages/page-1/versions?cursor=older" },
        });
      }),
    );

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.incomplete).toBe(true);
    expect(batch.warnings.some((w) => w.includes("version history of Confluence page page-1"))).toBe(true);
    // Nothing is recorded about a page whose authorship this run could not establish.
    // Being incomplete is what brings the week back, not a guess left behind in the file.
    expect(batch.snapshots).toEqual([]);
    expect(batch.events).toEqual([]);
  });

  it("still drops a page whose history was read in full and held nothing of the user's", async () => {
    const theirPage = { ...confluencePage, history: { ...confluencePage.history, createdBy: { accountId: "someone-else" } } };
    server.use(
      confluenceHandler([theirPage], []),
      http.get(`${BASE_URL}/wiki/api/v2/pages/page-1/versions`, () =>
        HttpResponse.json({ results: [{ number: 9, createdAt: "2026-03-06T10:00:00.000Z", authorId: "someone-else" }] }),
      ),
    );

    const batch = await confluenceSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.incomplete).toBeUndefined();
    expect(batch.snapshots).toEqual([]);
    expect(batch.events).toEqual([]);
  });

  it("says so when a pull request's reviews will not load", async () => {
    server.use(
      searchHandler([], [reviewedPR]),
      http.get("https://api.github.com/repos/example-org/repo/pulls/7/reviews", () =>
        HttpResponse.json({ message: "Server error" }, { status: 500 }),
      ),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.incomplete).toBe(true);
  });
});

describe("a page that failed after an earlier page succeeded", () => {
  const since = new Date("2026-03-06T00:00:00Z");
  const scope = `|since:${since.toISOString()}`;
  const fullPage = Array.from({ length: 100 }, (_, i) => ({
    id: 3000 + i, user: { login: USERNAME }, state: "COMMENTED", body: "n",
    submitted_at: "2026-03-07T09:00:00Z",
  }));
  const onPageTwo = {
    id: 4001, user: { login: USERNAME }, state: "APPROVED", body: "The last word.",
    submitted_at: "2026-03-08T09:00:00Z",
  };

  it("is asked for again even though page one now answers 304", async () => {
    // The trigger: 101 reviews since the watermark. Page one succeeds and stores its
    // ETag, page two returns 500, and the batch is marked incomplete so the watermark
    // holds. On the retry page one answers 304 — and the walk used to stop there, so
    // page two was never requested again.
    const asked: string[] = [];
    let pageTwoWorks = false;
    server.use(
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () => HttpResponse.json(authoredPRDetail)),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", ({ request }) => {
        const url = new URL(request.url);
        const page = url.searchParams.get("page") || "";
        asked.push(page);
        if (page === "1") {
          if (request.headers.get("If-None-Match") === '"reviews-p1"') return new HttpResponse(null, { status: 304 });
          return HttpResponse.json(fullPage, { headers: { ETag: '"reviews-p1"' } });
        }
        if (!pageTwoWorks) return HttpResponse.json({ message: "Server error" }, { status: 500 });
        return HttpResponse.json([onPageTwo]);
      }),
    );

    const ctx = makeContext();
    const first = await githubSource(() => NOW).fetchSince(since, [PR_URL], ctx);

    expect(first.incomplete).toBe(true);
    expect(asked).toEqual(["1", "2"]);
    expect(ctx.store.get(`https://api.github.com/repos/example-org/repo/pulls/42/reviews?per_page=100&page=1${scope}`)).toBe('"reviews-p1"');

    asked.length = 0;
    pageTwoWorks = true;
    const second = await githubSource(() => NOW).fetchSince(since, [PR_URL], ctx);

    // Page one is free, and the walk carries on to the page that never arrived.
    expect(asked).toEqual(["1", "2"]);
    expect(second.events.filter((e) => e.kind === "review").map((e) => e.id)).toContain("4001");
    expect(second.incomplete).toBeUndefined();
  });

  it("stops on a 304 only when that page is known to have been the last", async () => {
    const asked: string[] = [];
    server.use(
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () => HttpResponse.json(authoredPRDetail)),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("page") || "");
        if (request.headers.get("If-None-Match") === '"reviews-short"') return new HttpResponse(null, { status: 304 });
        return HttpResponse.json([onPageTwo], { headers: { ETag: '"reviews-short"' } });
      }),
    );

    const ctx = makeContext();
    await githubSource(() => NOW).fetchSince(since, [PR_URL], ctx);
    asked.length = 0;
    await githubSource(() => NOW).fetchSince(since, [PR_URL], ctx);

    // One short page last time means one request this time, not a walk to the cap.
    expect(asked).toEqual(["1"]);
  });
});

describe("a Jira history whose embedded page starts partway through", () => {
  it("is read from the beginning rather than continued from the wrong place", async () => {
    // The trigger: Jira reports startAt 100 of 150 and embeds 50 histories. Continuing
    // at `startAt=50` re-reads what we already have, reaches 150 rows, and never fetches
    // histories 0-49 — and the batch then looks complete, so the watermark moves past
    // them for good.
    const asked: number[] = [];
    const all = Array.from({ length: 150 }, (_, i) => ({
      id: `h-${i}`,
      created: "2026-03-04T10:00:00.000+0000",
      items: [{ field: "status", fromString: "To Do", toString: `Step ${i}` }],
    }));
    const embedded = {
      ...jiraIssue,
      fields: { ...jiraIssue.fields, comment: { comments: [] } },
      changelog: { startAt: 100, total: 150, histories: all.slice(100) },
    };
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [embedded] })),
      http.get(`${BASE_URL}/rest/api/3/issue/TEAM-1234/changelog`, ({ request }) => {
        const startAt = Number(new URL(request.url).searchParams.get("startAt") ?? "0");
        asked.push(startAt);
        const values = all.slice(startAt, startAt + 100);
        return HttpResponse.json({ values, startAt, total: all.length, isLast: startAt + values.length >= all.length });
      }),
    );

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());

    expect(asked).toEqual([0, 100]);
    const statuses = batch.events.filter((e) => e.kind === "status");
    expect(statuses).toHaveLength(150);
    // The first fifty, which the old continuation skipped entirely.
    expect(statuses.map((e) => e.id)).toContain("h-0:status");
    expect(batch.incomplete).toBeUndefined();
  });

  it("says it did not finish when the walk ends short of the reported total", async () => {
    const embedded = {
      ...jiraIssue,
      fields: { ...jiraIssue.fields, comment: { comments: [] } },
      changelog: { startAt: 0, total: 150, histories: [{ id: "h-0", created: "2026-03-04T10:00:00.000+0000", items: [] }] },
    };
    server.use(
      http.post(`${BASE_URL}/rest/api/3/search/jql`, () => HttpResponse.json({ issues: [embedded] })),
      http.get(`${BASE_URL}/rest/api/3/issue/TEAM-1234/changelog`, () =>
        HttpResponse.json({ values: [{ id: "h-0", created: "2026-03-04T10:00:00.000+0000", items: [] }], startAt: 0, total: 150, isLast: true }),
      ),
    );

    const batch = await jiraSource(() => NOW).fetchWindow(window, makeContext());

    expect(batch.incomplete).toBe(true);
    expect(batch.warnings.some((w) => w.includes("reports 150 changes and only 1 could be read"))).toBe(true);
  });
});

describe("commits pushed to a pull request that is already open", () => {
  const commits = [
    {
      sha: "aaa111",
      commit: { message: "Split the migration out\n\nLonger body.", author: { name: "Example User", email: "user@example.com", date: "2026-03-04T09:00:00Z" } },
      author: { login: USERNAME },
    },
    {
      sha: "bbb222",
      commit: { message: "Tidy the fixtures", author: { name: "Example User", email: "user@example.com", date: "2026-03-05T09:00:00Z" } },
      author: { login: USERNAME },
    },
    {
      sha: "ccc333",
      commit: { message: "Not mine", author: { name: "Other", email: "other@example.com", date: "2026-03-05T10:00:00Z" } },
      author: { login: "other-user" },
    },
  ];

  it("are the week's news, even though the pull request was opened before it", async () => {
    // The trigger: a PR opened last week and worked on all of this one. Opening it is the
    // only event a PR produces on its own, so without commits this week's log had nothing
    // about the branch at all.
    const opened = {
      ...authoredPR, created_at: "2026-02-24T09:00:00Z", closed_at: null,
      pull_request: { url: authoredPR.pull_request.url },
    };
    server.use(
      searchHandler([opened], []),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/commits", () => HttpResponse.json(commits)),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());

    const mine = batch.events.filter((event) => event.kind === "commit");
    expect(mine.map((event) => event.id)).toEqual(["aaa111", "bbb222"]);
    expect(mine[0].at).toBe("2026-03-04T09:00:00.000Z");
    expect(renderable(mine[0].payload).text).toBe("Split the migration out");
    // Somebody else's commit on the same branch is not this user's week.
    expect(mine.some((event) => event.id === "ccc333")).toBe(false);
  });

  it("are picked up by a delta on a pull request the ledger already knows", async () => {
    const since = new Date("2026-03-04T12:00:00Z");
    server.use(
      http.get("https://api.github.com/search/issues", () => HttpResponse.json({ total_count: 0, items: [] })),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/reviews", () => HttpResponse.json([])),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42", () => HttpResponse.json(authoredPRDetail)),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/commits", () => HttpResponse.json(commits)),
    );

    const batch = await githubSource(() => NOW).fetchSince(since, [PR_URL], makeContext());

    // Only the one pushed after the watermark.
    expect(batch.events.filter((event) => event.kind === "commit").map((event) => event.id)).toEqual(["bbb222"]);
  });

  /** Every commit GitHub could not match to an account, one per way git can name a person. */
  const unlinked = [
    {
      sha: "ddd444",
      commit: {
        message: "From a machine with no linked account",
        author: { name: "Example User", email: "User@Example.com", date: "2026-03-04T09:00:00Z" },
        // Somebody else put it on the branch, which is what a rebase or an amend by a
        // reviewer looks like. The work is still this user's, so only the author line
        // identifies them here.
        committer: { name: "Other", email: "other@example.com", date: "2026-03-04T10:00:00Z" },
      },
    },
    {
      sha: "eee555",
      commit: {
        message: "Rebased onto main from another machine",
        // The author line is somebody else's, or an address this user no longer uses.
        author: { name: "Old Address", email: "old@elsewhere.example", date: "2026-03-05T09:00:00Z" },
        committer: { name: "Example User", email: "user@example.com", date: "2026-03-05T11:00:00Z" },
      },
    },
    {
      sha: "fff666",
      commit: {
        message: "Not this user at all",
        author: { name: "Other", email: "other@example.com", date: "2026-03-05T12:00:00Z" },
        committer: { name: "Other", email: "other@example.com", date: "2026-03-05T12:00:00Z" },
      },
    },
  ];

  it("counts a commit whose author GitHub could not match, by the author email git recorded", async () => {
    server.use(
      searchHandler([{ ...authoredPR, closed_at: null, pull_request: { url: authoredPR.pull_request.url } }], []),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/commits", () => HttpResponse.json([unlinked[0]])),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.events.filter((event) => event.kind === "commit").map((event) => event.id)).toEqual(["ddd444"]);
  });

  it("counts one where only the committer is this user, and still leaves other people's alone", async () => {
    // The trigger: GitHub records the author and the committer separately, and a rebase,
    // an amend from another machine, or a commit made through the web UI leaves the user
    // as committer while the author line says something else. With no linked account
    // either, checking only the author email missed it — and the window was then marked
    // read, so it was never asked for again.
    server.use(
      searchHandler([{ ...authoredPR, closed_at: null, pull_request: { url: authoredPR.pull_request.url } }], []),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/commits", () => HttpResponse.json(unlinked)),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());
    const commits = batch.events.filter((event) => event.kind === "commit");

    expect(commits.map((event) => event.id)).toEqual(["ddd444", "eee555"]);
    // Dated when the work was written, not when it was rewritten onto main.
    expect(commits[1].at).toBe("2026-03-05T09:00:00.000Z");
  });

  it("says it did not finish when the commits will not load", async () => {
    server.use(
      searchHandler([{ ...authoredPR, closed_at: null, pull_request: { url: authoredPR.pull_request.url } }], []),
      http.get("https://api.github.com/repos/example-org/repo/pulls/42/commits", () =>
        HttpResponse.json({ message: "Server error" }, { status: 500 }),
      ),
    );

    const batch = await githubSource(() => NOW).fetchWindow(window, makeContext());
    expect(batch.incomplete).toBe(true);
  });
});
