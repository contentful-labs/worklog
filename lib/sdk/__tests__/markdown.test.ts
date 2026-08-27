import { describe, it, expect } from "vitest";
import { generateMarkdown, generateEventMarkdown } from "../markdown";
import type { LedgerSnapshot } from "../ledger";
import type { SourceEvent } from "../sources";
import type { WorklogConfig } from "../types";
import type { JiraIssue, GitHubPR } from "../../types";
import type { WeekInfo } from "../data-fetch";

const config: WorklogConfig = {
  version: 1,
  vault: "/tmp/test",
  atlassian: { url: "https://test.atlassian.net", email: "user@test.com" },
  githubOrgs: ["test-org"],
  ai: { provider: "openai" },
  profile: {
    fullName: "Test User", displayName: "Test", jobTitle: "Engineer",
    level: "IC5", company: "TestCo", location: "Remote", startDate: "2024-01-01",
    domain: "platform", team: "Core", teamDomain: "infra", ticketPrefixes: ["CORE"],
  },
  career: { framework: "test", currentLevel: "IC5", targetLevel: "IC6", companyValues: [], reviewCycleDates: [], skills: [], growthAreas: [], careerDocPaths: [] },
  coaching: { tone: "direct", focusAreas: [] },
};

const weekInfo: WeekInfo = {
  weekNumber: 10, year: 2026,
  startDate: new Date("2026-03-02T00:00:00Z"),
  endDate: new Date("2026-03-08T00:00:00Z"),
  filename: "2026-W10 Work Log.md",
};

const ACCOUNT_ID = "acct-123";

describe("generateMarkdown", () => {
  it("generates frontmatter and heading", () => {
    const md = generateMarkdown([], [], [], [], [], weekInfo, "", config, ACCOUNT_ID);
    expect(md).toContain("tags:");
    expect(md).toContain("# Work Log - Week 10, 2026");
    expect(md).toContain("**Period:** 2026-03-02 to 2026-03-08");
  });

  it("includes summary table with counts", () => {
    const issues: JiraIssue[] = [
      { key: "CORE-1", fields: { summary: "Task", status: { name: "Done" }, created: "2026-03-02", updated: "2026-03-05" } },
    ];
    const md = generateMarkdown(issues, [], [], [], [], weekInfo, "", config, ACCOUNT_ID);
    expect(md).toContain("| Jira Tasks | 1 |");
    expect(md).toContain("| GitHub PRs Authored | 0 |");
  });

  it("renders Jira section with links", () => {
    const issues: JiraIssue[] = [
      { key: "CORE-42", fields: { summary: "Fix auth", status: { name: "In Progress" }, created: "2026-03-02", updated: "2026-03-05" } },
    ];
    const md = generateMarkdown(issues, [], [], [], [], weekInfo, "", config, ACCOUNT_ID);
    expect(md).toContain("## Jira Tasks (1)");
    expect(md).toContain("[CORE-42] Fix auth");
    expect(md).toContain("[View in Jira](https://test.atlassian.net/browse/CORE-42)");
  });

  it("renders GitHub PRs with state", () => {
    const prs: GitHubPR[] = [
      { number: 99, title: "Add feature", state: "closed", created_at: "2026-03-03", updated_at: "2026-03-04", merged_at: "2026-03-04", html_url: "https://github.com/org/repo/pull/99", repository_url: "https://api.github.com/repos/org/repo" },
    ];
    const md = generateMarkdown([], [], prs, [], [], weekInfo, "", config, ACCOUNT_ID);
    expect(md).toContain("## GitHub Pull Requests (1)");
    expect(md).toContain("**Status:** Merged");
    expect(md).toContain("[org/repo#99]");
  });

  it("includes additional context when provided", () => {
    const md = generateMarkdown([], [], [], [], [], weekInfo, "Was on-call this week", config, ACCOUNT_ID);
    expect(md).toContain("## Additional Context");
    expect(md).toContain("Was on-call this week");
  });

  it("picks your Jira comments by account id, not display name", () => {
    const issues: JiraIssue[] = [
      {
        key: "CORE-7",
        fields: {
          summary: "Rollout", status: { name: "Done" }, created: "2026-03-02", updated: "2026-03-05",
          comment: {
            comments: [
              { author: { accountId: ACCOUNT_ID, displayName: "Someone Else" }, body: { content: [{ content: [{ text: "mine" }] }] } },
              { author: { accountId: "other-acct", displayName: "Test" }, body: { content: [{ content: [{ text: "theirs" }] }] } },
            ],
          },
        },
      },
    ];
    const md = generateMarkdown(issues, [], [], [], [], weekInfo, "", config, ACCOUNT_ID);
    expect(md).toContain("**Your comments (1):**");
    expect(md).toContain("mine");
    expect(md).not.toContain("theirs");
  });

  it("falls back to display name when a comment has no account id", () => {
    const issues: JiraIssue[] = [
      {
        key: "CORE-8",
        fields: {
          summary: "Rollout", status: { name: "Done" }, created: "2026-03-02", updated: "2026-03-05",
          comment: {
            comments: [
              { author: { displayName: "Test" }, body: { content: [{ content: [{ text: "legacy mine" }] }] } },
              { author: { displayName: "Other" }, body: { content: [{ content: [{ text: "legacy theirs" }] }] } },
            ],
          },
        },
      },
    ];
    const md = generateMarkdown(issues, [], [], [], [], weekInfo, "", config, ACCOUNT_ID);
    expect(md).toContain("**Your comments (1):**");
    expect(md).toContain("legacy mine");
    expect(md).not.toContain("legacy theirs");
  });

  it("matches on display name when the caller passes no account id", () => {
    const issues: JiraIssue[] = [
      {
        key: "CORE-9",
        fields: {
          summary: "Rollout", status: { name: "Done" }, created: "2026-03-02", updated: "2026-03-05",
          comment: {
            comments: [
              { author: { accountId: ACCOUNT_ID, displayName: "Test" }, body: { content: [{ content: [{ text: "mine" }] }] } },
              { author: { accountId: "other-acct", displayName: "Other" }, body: { content: [{ content: [{ text: "theirs" }] }] } },
            ],
          },
        },
      },
    ];
    const md = generateMarkdown(issues, [], [], [], [], weekInfo, "", config);
    expect(md).toContain("**Your comments (1):**");
    expect(md).toContain("mine");
    expect(md).not.toContain("theirs");
  });

  it("omits empty sections", () => {
    const md = generateMarkdown([], [], [], [], [], weekInfo, "", config, ACCOUNT_ID);
    expect(md).not.toContain("## Jira Tasks");
    expect(md).not.toContain("## Confluence Documents");
    expect(md).not.toContain("## GitHub Pull Requests");
    expect(md).not.toContain("## Additional Context");
  });
});

const makeMarkdownConfig = (): WorklogConfig => config;

describe("generateEventMarkdown", () => {
  const weekInfo = (weekNumber: number, start: string, end: string): WeekInfo => ({
    weekNumber,
    year: 2026,
    startDate: new Date(`${start}T00:00:00.000Z`),
    endDate: new Date(`${end}T23:59:59.999Z`),
    filename: `2026-W${weekNumber} Work Log.md`,
  });

  const ticket: LedgerSnapshot = {
    source: "jira",
    id: "TEAM-1234",
    firstSeenAt: "2026-08-10T09:00:00.000Z",
    payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" },
  };

  const snapshotFor = (source: string, id: string) => (source === "jira" && id === "TEAM-1234" ? ticket : undefined);
  const now = new Date("2026-09-07T10:00:00.000Z");

  const opened: SourceEvent = {
    source: "jira", kind: "created", itemId: "TEAM-1234", at: "2026-08-10T09:00:00.000Z", payload: {},
  };
  const laterComment: SourceEvent = {
    source: "jira", kind: "comment", itemId: "TEAM-1234", at: "2026-08-31T11:00:00.000Z",
    payload: { text: "Still flaky under load" }, id: "c-1",
  };

  it("shows a week only what happened in it", () => {
    const august = generateEventMarkdown({
      weekInfo: weekInfo(33, "2026-08-10", "2026-08-16"),
      events: [opened],
      snapshotFor,
      additionalContext: "",
      config: makeMarkdownConfig(),
      now,
    });

    expect(august).toContain("### TEAM-1234 - Search Revamp indexer");
    expect(august).toContain("created");
    // The comment belongs to its own week and must not reach back into this one.
    expect(august).not.toContain("Still flaky under load");
  });

  it("shows the later week the comment, still against the item it hangs off", () => {
    const september = generateEventMarkdown({
      weekInfo: weekInfo(36, "2026-08-31", "2026-09-06"),
      events: [laterComment],
      snapshotFor,
      additionalContext: "",
      config: makeMarkdownConfig(),
      now,
    });

    expect(september).toContain("### TEAM-1234 - Search Revamp indexer");
    expect(september).toContain("Still flaky under load");
    expect(september).toContain("**2026-08-31 11:00** comment");
    // Nothing about the week the ticket was opened in.
    expect(september).not.toContain("created");
  });

  it("titles an item from the snapshot taken when it was first seen", () => {
    const renamed = generateEventMarkdown({
      weekInfo: weekInfo(36, "2026-08-31", "2026-09-06"),
      events: [laterComment],
      snapshotFor: () => ({ ...ticket, payload: { title: "Search Revamp indexer", url: "https://example.atlassian.net/browse/TEAM-1234" } }),
      additionalContext: "",
      config: makeMarkdownConfig(),
      now,
    });

    expect(renamed).toContain("Search Revamp indexer");
    expect(renamed).toContain("**First seen:** 2026-08-10");
  });

  it("says which changes carry no timestamp of their own", () => {
    const markdown = generateEventMarkdown({
      weekInfo: weekInfo(36, "2026-08-31", "2026-09-06"),
      events: [{
        source: "jira", kind: "description", itemId: "TEAM-1234", at: "2026-09-02T08:00:00.000Z",
        payload: { spotted: true },
      }],
      snapshotFor,
      additionalContext: "",
      config: makeMarkdownConfig(),
      now,
    });

    expect(markdown).toContain("*(spotted, not dated by the source)*");
    expect(markdown).toContain("## Dating");
  });

  it("counts items and events per source", () => {
    const markdown = generateEventMarkdown({
      weekInfo: weekInfo(36, "2026-08-31", "2026-09-06"),
      events: [
        laterComment,
        { source: "jira", kind: "status", itemId: "TEAM-1235", at: "2026-09-01T09:00:00.000Z", payload: { from: "Open", to: "Done" } },
        { source: "github", kind: "merged", itemId: "https://example.com/pr/1", at: "2026-09-02T09:00:00.000Z", payload: {} },
      ],
      snapshotFor,
      additionalContext: "",
      config: makeMarkdownConfig(),
      now,
    });

    expect(markdown).toContain("| github | 1 | 1 |");
    expect(markdown).toContain("| jira | 2 | 2 |");
    expect(markdown).toContain("Open to Done");
  });

  it("renders a week with nothing in it without pretending otherwise", () => {
    const markdown = generateEventMarkdown({
      weekInfo: weekInfo(36, "2026-08-31", "2026-09-06"),
      events: [],
      snapshotFor,
      additionalContext: "",
      config: makeMarkdownConfig(),
      now,
    });

    expect(markdown).toContain("| (nothing recorded) | 0 | 0 |");
  });

  it("keeps the week's own context at the end", () => {
    const markdown = generateEventMarkdown({
      weekInfo: weekInfo(36, "2026-08-31", "2026-09-06"),
      events: [laterComment],
      snapshotFor,
      additionalContext: "Was on call this week.",
      config: makeMarkdownConfig(),
      now,
    });

    expect(markdown).toContain("## Additional Context");
    expect(markdown).toContain("Was on call this week.");
  });
});
