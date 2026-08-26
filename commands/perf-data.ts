import { Command } from "commander";
import { requireConfig } from "../lib/config";
import type { JiraIssue, ConfluencePage, GitHubPR } from "../lib/types";
import { extractText, formatDate } from "../lib/utils";
import {
  buildHeaders,
  getAccountId,
  getGitHubUsername,
  fetchJiraIssues,
  fetchGitHubPRs,
  searchConfluence,
  JIRA_ISSUE_FIELDS,
} from "../lib/sdk/data-fetch";

export async function runPerfData(opts: { since: string; output: string }): Promise<void> {
  const { since: startDate, output: outputPath } = opts;
  const config = requireConfig();

  const apiToken = process.env.ATLASSIAN_API_TOKEN;
  if (!apiToken) {
    console.error("Error: ATLASSIAN_API_TOKEN env var required");
    console.error("Generate at: https://id.atlassian.com/manage-profile/security/api-tokens");
    process.exit(1);
  }
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.error("Error: GITHUB_TOKEN env var required");
    process.exit(1);
  }

  const headers = buildHeaders(config, { atlassianApiToken: apiToken, githubToken });

  console.log("Getting account IDs...");
  const [accountId, githubUsername] = await Promise.all([
    getAccountId(config, headers),
    getGitHubUsername(headers),
  ]);
  console.log(`Atlassian Account ID: ${accountId}`);
  console.log(`GitHub Username: ${githubUsername}`);

  const email = config.atlassian.email;
  const jql = `(assignee = "${email}" OR reporter = "${email}") AND updated >= "${startDate}" ORDER BY updated DESC`;
  const cql = `(creator = "${accountId}" OR mention = "${accountId}") AND lastModified >= "${startDate}"`;
  const orgFilter = config.githubOrgs.map((o) => `org:${o}`).join(" ");
  const ghQuery = `type:pr author:${githubUsername} ${orgFilter} created:>=${startDate}`;

  console.log("Fetching Jira issues, Confluence pages, and GitHub PRs...");
  const [issues, pages, prs] = await Promise.all([
    fetchJiraIssues(config, headers, jql, JIRA_ISSUE_FIELDS, {
      onPage: (n) => console.log(`  Jira: ${n} issues so far`),
    }),
    searchConfluence<ConfluencePage>(config, headers, cql, "space,history,history.lastUpdated"),
    fetchGitHubPRs(headers, ghQuery, "created", (n, total) => console.log(`  GitHub: ${n}/${total} PRs`)),
  ]);

  const markdown = generateMarkdown(config, issues, pages, prs, startDate);
  await Bun.write(outputPath, markdown);

  console.log(`\nDone! Output written to ${outputPath}`);
  console.log(`  - ${issues.length} Jira tasks`);
  console.log(`  - ${pages.length} Confluence documents`);
  console.log(`  - ${prs.length} GitHub PRs`);
}

function generateMarkdown(
  config: ReturnType<typeof requireConfig>,
  issues: JiraIssue[],
  pages: ConfluencePage[],
  prs: GitHubPR[],
  startDate: string,
): string {
  const lines: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  lines.push("# Performance Review Data");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Period: ${startDate} to ${today}`);
  lines.push(`User: ${config.atlassian.email}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(`- **Jira Tasks:** ${issues.length}`);
  lines.push(`- **Confluence Docs:** ${pages.length}`);
  lines.push(`- **GitHub PRs:** ${prs.length}`);
  lines.push("");

  lines.push(`## Jira Tasks (${issues.length} total)`);
  lines.push("");
  for (const issue of issues) {
    const f = issue.fields;
    lines.push(`### [${issue.key}] ${f.summary}`);
    lines.push(`- **Status:** ${f.status.name}`);
    lines.push(`- **Created:** ${formatDate(f.created)} | **Updated:** ${formatDate(f.updated)}${f.resolutiondate ? ` | **Resolved:** ${formatDate(f.resolutiondate)}` : ""}`);
    if (f.timetracking?.timeSpent) lines.push(`- **Time Logged:** ${f.timetracking.timeSpent}`);
    if (f.priority?.name) lines.push(`- **Priority:** ${f.priority.name}`);
    if (f.labels?.length) lines.push(`- **Labels:** ${f.labels.join(", ")}`);
    if (f.components?.length) lines.push(`- **Components:** ${f.components.map((c) => c.name).join(", ")}`);
    const desc = extractText(f.description, 500);
    if (desc) lines.push(`- **Description:** ${desc}`);
    const commentCount = f.comment?.comments?.length || 0;
    if (commentCount > 0) lines.push(`- **Comments:** ${commentCount}`);
    lines.push(`- **Link:** ${config.atlassian.url}/browse/${issue.key}`);
    lines.push("");
  }

  lines.push(`## Confluence Documents (${pages.length} total)`);
  lines.push("");
  for (const page of pages) {
    lines.push(`### ${page.title}`);
    if (page.space) lines.push(`- **Space:** ${page.space.name} (${page.space.key})`);
    lines.push(`- **Created:** ${formatDate(page.history?.createdDate)}`);
    if (page.history?.lastUpdated?.when) lines.push(`- **Last Updated:** ${formatDate(page.history.lastUpdated.when)}`);
    if (page._links?.webui) lines.push(`- **Link:** ${config.atlassian.url}/wiki${page._links.webui}`);
    lines.push("");
  }

  lines.push(`## GitHub Pull Requests (${prs.length} total)`);
  lines.push("");
  for (const pr of prs) {
    const repoName = pr.repository_url.split("/").slice(-2).join("/");
    const state = pr.merged_at ? "Merged" : pr.state === "closed" ? "Closed" : "Open";
    lines.push(`### [${repoName}#${pr.number}] ${pr.title}`);
    lines.push(`- **Status:** ${state}`);
    lines.push(`- **Created:** ${formatDate(pr.created_at)}${pr.merged_at ? ` | **Merged:** ${formatDate(pr.merged_at)}` : pr.closed_at ? ` | **Closed:** ${formatDate(pr.closed_at)}` : ""}`);
    lines.push(`- **Link:** ${pr.html_url}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function makePerfDataCommand(): Command {
  return new Command("perf-data")
    .description("Fetch raw performance review data from Jira, Confluence, and GitHub")
    .option(
      "--since <YYYY-MM-DD>",
      "Start date for data collection",
      (v) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime()))
          throw new Error("--since must be a valid YYYY-MM-DD date");
        return v;
      },
      new Date().getFullYear() + "-01-01",
    )
    .option("--output <path>", "Output file path", "performance-review-data.md")
    .addHelpText("after", `
Examples:
  worklog perf-data
  worklog perf-data --since 2025-01-01
  worklog perf-data --since 2024-07-01 --output ~/Documents/perf-h2-2024.md`)
    .action(async (opts) => {
      await runPerfData({ since: opts.since, output: opts.output });
    });
}
