import type { WorklogConfig } from "./types";
import type { JiraIssue, ConfluencePage, ConfluenceComment, ConfluenceTag, GitHubPR } from "../types";
import { normalizeTicketPrefix } from "../config";

export const JIRA_ISSUE_FIELDS = ["summary", "status", "created", "updated", "resolutiondate", "description", "priority", "labels", "components", "timetracking", "comment"];

export interface FetchCredentials {
  atlassianApiToken: string;
  githubToken: string;
}

export interface FetchHeaders {
  atlassian: Record<string, string>;
  github: Record<string, string>;
}

export interface WeekInfo {
  weekNumber: number;
  year: number;
  startDate: Date;
  endDate: Date;
  filename: string;
}

export interface PRReview {
  pr_number: number;
  pr_title: string;
  pr_author: string;
  repo: string;
  state: string;
  submitted_at: string;
  comment_count: number;
  html_url: string;
  pr_html_url: string;
}

export interface FetchWeekOptions {
  /** Called when a supplementary fetch fails and the week continues without that data. */
  onWarning?: (message: string) => void;
}

export interface FetchedWeekData {
  issues: JiraIssue[];
  pages: ConfluencePage[];
  prs: GitHubPR[];
  reviews: PRReview[];
  teamSprintItems: JiraIssue[];
}

export function buildHeaders(config: WorklogConfig, creds: FetchCredentials): FetchHeaders {
  const auth = Buffer.from(`${config.atlassian.email}:${creds.atlassianApiToken}`).toString("base64");
  return {
    atlassian: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    github: {
      Authorization: `Bearer ${creds.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
}

export async function getAccountId(config: WorklogConfig, headers: FetchHeaders): Promise<string> {
  const res = await fetch(`${config.atlassian.url}/rest/api/3/myself`, { headers: headers.atlassian });
  if (!res.ok) {
    throw new Error(`Failed to get accountId: ${res.status}`);
  }
  const data = await res.json();
  return data.accountId;
}

export async function getGitHubUsername(headers: FetchHeaders): Promise<string> {
  const res = await fetch("https://api.github.com/user", { headers: headers.github });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.login;
}

export async function searchConfluence<T = Record<string, unknown>>(
  config: WorklogConfig,
  headers: FetchHeaders,
  cql: string,
  expand: string,
  status?: string,
): Promise<T[]> {
  const results: T[] = [];
  let start = 0;
  while (true) {
    let url = `${config.atlassian.url}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=${encodeURIComponent(expand)}&start=${start}&limit=50`;
    if (status) url += `&status=${status}`;
    const res = await fetch(url, { headers: headers.atlassian });
    if (!res.ok) throw new Error(`Confluence API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    results.push(...(data.results || []));
    if (!data._links?.next) break;
    start += 50;
  }
  return results;
}

/** Run a JQL query through Jira's token-paginated search, collecting every page (or up to `limit` issues). */
export async function fetchJiraIssues(
  config: WorklogConfig,
  headers: FetchHeaders,
  jql: string,
  fields: string[] = JIRA_ISSUE_FIELDS,
  opts: { pageSize?: number; limit?: number; onPage?: (count: number) => void } = {},
): Promise<JiraIssue[]> {
  const { pageSize = 100, limit, onPage } = opts;
  let issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  while (true) {
    const body: Record<string, unknown> = { jql, fields, maxResults: pageSize };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(`${config.atlassian.url}/rest/api/3/search/jql`, {
      method: "POST",
      headers: headers.atlassian,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    issues = issues.concat(data.issues || []);
    onPage?.(issues.length);
    if (!data.nextPageToken || (limit !== undefined && issues.length >= limit)) break;
    nextPageToken = data.nextPageToken;
  }

  return issues;
}

/** Run a GitHub issues search (PRs), collecting every page. */
export async function fetchGitHubPRs(
  headers: FetchHeaders,
  query: string,
  sort: "created" | "updated" = "created",
  onPage?: (count: number, total: number) => void,
): Promise<GitHubPR[]> {
  let prs: GitHubPR[] = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}&sort=${sort}&order=desc`;
    const res = await fetch(url, { headers: headers.github });
    if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    prs = prs.concat(data.items || []);
    onPage?.(prs.length, data.total_count);
    if (prs.length >= data.total_count) break;
    page++;
  }
  return prs;
}

export async function fetchDataForWeek(
  config: WorklogConfig,
  headers: FetchHeaders,
  accountId: string,
  githubUsername: string,
  weekInfo: WeekInfo,
  opts: FetchWeekOptions = {},
): Promise<FetchedWeekData> {
  const { onWarning } = opts;
  const startDate = weekInfo.startDate.toISOString().split("T")[0];
  const endDate = weekInfo.endDate.toISOString().split("T")[0];

  const email = config.atlassian.email;
  const orgFilter = config.githubOrgs.map(o => `org:${o}`).join(" ");

  // --- Jira issues ---
  const jql = `(assignee = "${email}" OR reporter = "${email}") AND updated >= "${startDate}" AND updated <= "${endDate}" ORDER BY updated DESC`;
  const issues = await fetchJiraIssues(config, headers, jql);

  // --- Confluence pages ---
  const contributorCql = `contributor = "${accountId}" AND type = page AND lastModified >= "${startDate}" AND lastModified <= "${endDate}"`;
  const contributedPages = await searchConfluence<ConfluencePage>(config, headers, contributorCql, "space,history,history.lastUpdated,history.createdBy", "any");

  const pageMap = new Map<string, ConfluencePage>();
  for (const page of contributedPages) {
    const tags: ConfluenceTag[] = [];
    if (page.history?.createdBy?.accountId === accountId) {
      tags.push("Created");
    } else {
      tags.push("Contributed");
    }
    if (page.status === "draft") {
      tags.push("Draft");
    }
    pageMap.set(page.id, { ...page, _tags: tags });
  }

  // Confluence comments → tag parent pages
  const commentCql = `type = comment AND creator = "${accountId}" AND created >= "${startDate}" AND created <= "${endDate}"`;
  const comments = await searchConfluence<ConfluenceComment>(config, headers, commentCql, "container");

  for (const comment of comments) {
    const container = comment.container;
    if (!container?.id) continue;
    const existing = pageMap.get(container.id);
    if (existing) {
      if (!existing._tags?.includes("Commented")) {
        existing._tags = [...(existing._tags || []), "Commented"];
      }
    } else {
      pageMap.set(container.id, {
        id: container.id,
        title: container.title,
        space: container.space,
        _links: container._links,
        _tags: ["Commented"],
      });
    }
  }

  const pages = Array.from(pageMap.values());

  // --- GitHub PRs ---
  const ghQuery = `type:pr author:${githubUsername} ${orgFilter} created:${startDate}..${endDate}`;
  const prs = await fetchGitHubPRs(headers, ghQuery, "created");

  // --- GitHub PR Reviews ---
  const reviews: PRReview[] = [];
  const authoredUrls = new Set(prs.map(p => p.html_url));
  const reviewQuery = `type:pr reviewed-by:${githubUsername} ${orgFilter} updated:${startDate}..${endDate}`;

  // Reviews are supplementary; a failed search shouldn't abort the week, but it must be reported.
  let reviewPRs: GitHubPR[] = [];
  try {
    reviewPRs = await fetchGitHubPRs(headers, reviewQuery, "updated");
  } catch (err) {
    onWarning?.(`GitHub reviewed-PR search failed, reviews will be missing from this week: ${String(err)}`);
  }

  for (const pr of reviewPRs) {
    if (authoredUrls.has(pr.html_url)) continue;
    const repoPath = pr.repository_url.replace("https://api.github.com/repos/", "");

    try {
      const reviewsRes = await fetch(`https://api.github.com/repos/${repoPath}/pulls/${pr.number}/reviews`, { headers: headers.github });
      if (!reviewsRes.ok) {
        onWarning?.(`Could not read reviews for ${repoPath}#${pr.number}, it will be missing from this week: HTTP ${reviewsRes.status}`);
        continue;
      }
      const prReviews = await reviewsRes.json();
      const userReviews = prReviews.filter((r: { user?: { login: string }; state: string; submitted_at: string; html_url: string }) => r.user?.login === githubUsername);
      if (userReviews.length === 0) continue;

      const latestReview = userReviews[userReviews.length - 1];

      const commentsRes = await fetch(`https://api.github.com/repos/${repoPath}/pulls/${pr.number}/comments`, { headers: headers.github });
      let commentCount = 0;
      if (commentsRes.ok) {
        const prComments = await commentsRes.json();
        commentCount = prComments.filter((c: { user?: { login: string } }) => c.user?.login === githubUsername).length;
      } else {
        onWarning?.(`Could not read review comments for ${repoPath}#${pr.number}, its comment count will read 0: HTTP ${commentsRes.status}`);
      }

      reviews.push({
        pr_number: pr.number,
        pr_title: pr.title,
        pr_author: pr.user?.login || "unknown",
        repo: repoPath,
        state: latestReview.state,
        submitted_at: latestReview.submitted_at,
        comment_count: commentCount,
        html_url: latestReview.html_url,
        pr_html_url: pr.html_url,
      });
    } catch (err) {
      onWarning?.(`Review fetch failed for ${repoPath}#${pr.number}, it will be missing from this week: ${String(err)}`);
    }
  }

  // --- Team sprint items ---
  let teamSprintItems: JiraIssue[] = [];
  const projectKeys = config.profile.ticketPrefixes.map(normalizeTicketPrefix).filter(Boolean);
  if (projectKeys.length > 0) {
    const sprintJql = buildTeamSprintJql(projectKeys, email);
    // Sprint context is supplementary; a failed query shouldn't abort the week, but it must be reported.
    try {
      teamSprintItems = await fetchJiraIssues(
        config, headers, sprintJql,
        ["summary", "status", "priority", "labels", "components"],
        { pageSize: 50, limit: 50 },
      );
    } catch (err) {
      onWarning?.(`Team sprint query failed, sprint context will be missing from this week: ${String(err)}`);
    }
  }

  return { issues, pages, prs, reviews, teamSprintItems };
}

/** Open-sprint items in the team's projects that aren't the engineer's own. */
export function buildTeamSprintJql(projectKeys: string[], email: string): string {
  return `project in (${projectKeys.join(", ")}) AND sprint in openSprints() AND NOT (assignee = "${email}" OR reporter = "${email}") ORDER BY rank ASC`;
}
