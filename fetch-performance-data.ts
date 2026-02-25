#!/usr/bin/env bun

import { requireConfig } from "./lib/config";

const config = requireConfig();
const EMAIL = config.atlassian.email;
const BASE_URL = config.atlassian.url;
const START_DATE = "2025-03-01";

const API_TOKEN = process.env.ATLASSIAN_API_TOKEN;
if (!API_TOKEN) {
  console.error("Error: ATLASSIAN_API_TOKEN env var required");
  console.error("Generate at: https://id.atlassian.com/manage-profile/security/api-tokens");
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN env var required");
  process.exit(1);
}

const githubHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const AUTH = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");
const headers = {
  Authorization: `Basic ${AUTH}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function getAccountId(): Promise<string> {
  const res = await fetch(`${BASE_URL}/rest/api/3/myself`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get accountId: ${res.status}`);
  }
  const data = await res.json();
  return data.accountId;
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    created: string;
    updated: string;
    resolutiondate?: string;
    description?: { content?: Array<{ content?: Array<{ text?: string }> }> };
    priority?: { name: string };
    labels?: string[];
    components?: Array<{ name: string }>;
    timetracking?: { timeSpent?: string };
    comment?: { comments?: Array<{ body?: { content?: Array<{ content?: Array<{ text?: string }> }> }; author?: { displayName?: string }; created?: string }> };
  };
}

interface ConfluencePage {
  id: string;
  title: string;
  space?: { name: string; key: string };
  _links?: { webui?: string };
  history?: { createdDate?: string; lastUpdated?: { when?: string } };
}

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at?: string;
  closed_at?: string;
  html_url: string;
  repository_url: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
}

async function fetchJiraIssues(): Promise<JiraIssue[]> {
  const jql = `(assignee = "${EMAIL}" OR reporter = "${EMAIL}") AND updated >= "${START_DATE}" ORDER BY updated DESC`;
  const fields = ["summary", "status", "created", "updated", "resolutiondate", "description", "priority", "labels", "components", "timetracking", "comment"];

  let allIssues: JiraIssue[] = [];
  let nextPageToken: string | undefined = undefined;

  console.log("Fetching Jira issues...");

  while (true) {
    const body: Record<string, unknown> = {
      jql,
      fields,
      maxResults: 100,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const res = await fetch(`${BASE_URL}/rest/api/3/search/jql`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    allIssues = allIssues.concat(data.issues || []);

    console.log(`  Fetched ${allIssues.length} issues so far...`);

    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return allIssues;
}

async function fetchConfluencePages(accountId: string): Promise<ConfluencePage[]> {
  const cql = `(creator = "${accountId}" OR mention = "${accountId}") AND lastModified >= "${START_DATE}"`;

  let allPages: ConfluencePage[] = [];
  let start = 0;
  const limit = 50;

  console.log("Fetching Confluence pages...");

  while (true) {
    const url = `${BASE_URL}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=space,history,history.lastUpdated&start=${start}&limit=${limit}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Confluence API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    allPages = allPages.concat(data.results || []);

    console.log(`  Fetched ${allPages.length}/${data.totalSize || allPages.length} pages`);

    if (!data._links?.next) break;
    start += limit;
  }

  return allPages;
}

async function getGitHubUsername(): Promise<string> {
  const res = await fetch("https://api.github.com/user", { headers: githubHeaders });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.login;
}

async function fetchGitHubPRs(username: string): Promise<GitHubPR[]> {
  const orgFilter = config.githubOrgs.map(o => `org:${o}`).join(" ");
  const query = `type:pr author:${username} ${orgFilter} created:>=${START_DATE}`;
  let allPRs: GitHubPR[] = [];
  let page = 1;

  console.log("Fetching GitHub PRs...");

  while (true) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}&sort=created&order=desc`;
    const res = await fetch(url, { headers: githubHeaders });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    allPRs = allPRs.concat(data.items || []);

    console.log(`  Fetched ${allPRs.length}/${data.total_count} PRs`);

    if (allPRs.length >= data.total_count) break;
    page++;
  }

  return allPRs;
}

function extractText(adfContent: JiraIssue["fields"]["description"]): string {
  if (!adfContent?.content) return "";

  const texts: string[] = [];
  for (const block of adfContent.content) {
    if (block.content) {
      for (const inline of block.content) {
        if (inline.text) texts.push(inline.text);
      }
    }
  }
  return texts.join(" ").slice(0, 500) + (texts.join(" ").length > 500 ? "..." : "");
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function generateMarkdown(issues: JiraIssue[], pages: ConfluencePage[], prs: GitHubPR[]): string {
  const lines: string[] = [];

  lines.push("# Performance Review Data");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Period: March 2025 - January 2026`);
  lines.push(`User: ${EMAIL}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push(`- **Jira Tasks:** ${issues.length}`);
  lines.push(`- **Confluence Docs:** ${pages.length}`);
  lines.push(`- **GitHub PRs:** ${prs.length}`);
  lines.push("");

  // Jira section
  lines.push(`## Jira Tasks (${issues.length} total)`);
  lines.push("");

  for (const issue of issues) {
    const f = issue.fields;
    lines.push(`### [${issue.key}] ${f.summary}`);
    lines.push(`- **Status:** ${f.status.name}`);
    lines.push(`- **Created:** ${formatDate(f.created)} | **Updated:** ${formatDate(f.updated)}${f.resolutiondate ? ` | **Resolved:** ${formatDate(f.resolutiondate)}` : ""}`);

    if (f.timetracking?.timeSpent) {
      lines.push(`- **Time Logged:** ${f.timetracking.timeSpent}`);
    }
    if (f.priority?.name) {
      lines.push(`- **Priority:** ${f.priority.name}`);
    }
    if (f.labels?.length) {
      lines.push(`- **Labels:** ${f.labels.join(", ")}`);
    }
    if (f.components?.length) {
      lines.push(`- **Components:** ${f.components.map(c => c.name).join(", ")}`);
    }

    const desc = extractText(f.description);
    if (desc) {
      lines.push(`- **Description:** ${desc}`);
    }

    const commentCount = f.comment?.comments?.length || 0;
    if (commentCount > 0) {
      lines.push(`- **Comments:** ${commentCount}`);
    }

    lines.push(`- **Link:** ${BASE_URL}/browse/${issue.key}`);
    lines.push("");
  }

  // Confluence section
  lines.push(`## Confluence Documents (${pages.length} total)`);
  lines.push("");

  for (const page of pages) {
    lines.push(`### ${page.title}`);
    if (page.space) {
      lines.push(`- **Space:** ${page.space.name} (${page.space.key})`);
    }
    lines.push(`- **Created:** ${formatDate(page.history?.createdDate)}`);
    if (page.history?.lastUpdated?.when) {
      lines.push(`- **Last Updated:** ${formatDate(page.history.lastUpdated.when)}`);
    }
    if (page._links?.webui) {
      lines.push(`- **Link:** ${BASE_URL}/wiki${page._links.webui}`);
    }
    lines.push("");
  }

  // GitHub PRs section
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

async function main() {
  try {
    console.log("Getting account IDs...");
    const [accountId, githubUsername] = await Promise.all([
      getAccountId(),
      getGitHubUsername(),
    ]);
    console.log(`Atlassian Account ID: ${accountId}`);
    console.log(`GitHub Username: ${githubUsername}`);

    const [issues, pages, prs] = await Promise.all([
      fetchJiraIssues(),
      fetchConfluencePages(accountId),
      fetchGitHubPRs(githubUsername),
    ]);

    const markdown = generateMarkdown(issues, pages, prs);
    const outputPath = "performance-review-data.md";

    await Bun.write(outputPath, markdown);
    console.log(`\nDone! Output written to ${outputPath}`);
    console.log(`  - ${issues.length} Jira tasks`);
    console.log(`  - ${pages.length} Confluence documents`);
    console.log(`  - ${prs.length} GitHub PRs`);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
