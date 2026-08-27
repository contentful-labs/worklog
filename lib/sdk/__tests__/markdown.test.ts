import { describe, it, expect } from "vitest";
import { generateMarkdown } from "../markdown";
import type { WorklogConfig } from "../types";
import type { JiraIssue, GitHubPR } from "../../types";
import type { WeekInfo } from "../data-fetch";
import type { SlackMessage } from "../sources/slack";

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

describe("generateMarkdown Slack section", () => {
  const base: SlackMessage = {
    permalink: "https://example.slack.com/archives/C1/p1",
    channel: "team-updates",
    at: "2026-03-03T09:14:00.000Z",
    text: "Picked the migration order.",
    isReply: false,
  };

  it("is absent, along with its summary row, when there are no messages", () => {
    const withArg = generateMarkdown([], [], [], [], [], weekInfo, "", config, ACCOUNT_ID, []);
    const without = generateMarkdown([], [], [], [], [], weekInfo, "", config, ACCOUNT_ID);

    expect(withArg).not.toContain("## Slack");
    expect(withArg).not.toContain("| Slack Messages |");
    expect(withArg).toBe(without);
  });

  it("groups messages by channel with permalink, time and text", () => {
    const md = generateMarkdown([], [], [], [], [], weekInfo, "", config, ACCOUNT_ID, [
      base,
      { ...base, permalink: "https://example.slack.com/archives/C2/p1", channel: "arch-review", at: "2026-03-04T15:00:00.000Z", text: "Second one." },
    ]);

    expect(md).toContain("| Slack Messages | 2 |");
    expect(md).toContain("## Slack (2)");
    expect(md).toContain("### #arch-review");
    expect(md).toContain("### #team-updates");
    expect(md).toContain("- **2026-03-03 09:14 UTC** — [View in Slack](https://example.slack.com/archives/C1/p1)");
    expect(md).toContain("  > Picked the migration order.");
  });

  it("groups a thread and its replies under one entry", () => {
    const md = generateMarkdown([], [], [], [], [], weekInfo, "", config, ACCOUNT_ID, [
      { ...base, permalink: "https://example.slack.com/archives/C1/p2", at: "2026-03-03T11:00:00.000Z", text: "Follow-up.", isReply: true, threadRoot: base.permalink },
      base,
    ]);

    expect(md).toContain("- **Thread** (2 messages)");
    expect(md).toContain("  - **2026-03-03 09:14 UTC** — [View in Slack](https://example.slack.com/archives/C1/p1)");
    expect(md).toContain("    > Follow-up.");
  });

  it("quotes every line of a multi-line message", () => {
    const md = generateMarkdown([], [], [], [], [], weekInfo, "", config, ACCOUNT_ID, [
      { ...base, text: "First line.\nSecond line." },
    ]);

    expect(md).toContain("  > First line.");
    expect(md).toContain("  > Second line.");
  });
});
