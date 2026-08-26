import type { WorklogConfig } from "./types";
import type { JiraIssue, ConfluencePage, GitHubPR } from "../types";
import type { PRReview, WeekInfo } from "./data-fetch";
import { extractText, formatDate } from "../utils";

export function generateMarkdown(
  issues: JiraIssue[],
  pages: ConfluencePage[],
  prs: GitHubPR[],
  reviews: PRReview[],
  teamSprintItems: JiraIssue[],
  weekInfo: WeekInfo,
  additionalContext: string,
  config: WorklogConfig,
  accountId: string,
): string {
  const lines: string[] = [];
  const startDate = weekInfo.startDate.toISOString().split("T")[0];
  const endDate = weekInfo.endDate.toISOString().split("T")[0];

  lines.push("---");
  lines.push("tags:");
  lines.push("  - areas/work");
  lines.push("  - areas/work/work-log");
  lines.push("---");
  lines.push("");
  lines.push(`# Work Log - Week ${weekInfo.weekNumber}, ${weekInfo.year}`);
  lines.push("");
  lines.push(`**Period:** ${startDate} to ${endDate}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Jira Tasks | ${issues.length} |`);
  lines.push(`| Confluence Created | ${pages.filter(p => p._tags?.includes("Created")).length} |`);
  lines.push(`| Confluence Contributed | ${pages.filter(p => p._tags?.includes("Contributed")).length} |`);
  lines.push(`| Confluence Commented | ${pages.filter(p => p._tags?.includes("Commented")).length} |`);
  lines.push(`| Confluence Drafts | ${pages.filter(p => p._tags?.includes("Draft")).length} |`);
  lines.push(`| GitHub PRs Authored | ${prs.length} |`);
  lines.push(`| GitHub PRs Reviewed | ${reviews.length} |`);
  lines.push("");

  // Jira section
  if (issues.length > 0) {
    lines.push(`## Jira Tasks (${issues.length})`);
    lines.push("");

    for (const issue of issues) {
      const f = issue.fields;
      lines.push(`### [${issue.key}] ${f.summary}`);
      lines.push(`**Status:** ${f.status.name} | **Updated:** ${formatDate(f.updated)}`);

      const desc = extractText(f.description);
      if (desc) {
        lines.push(`> ${desc}`);
      }

      if (f.comment?.comments?.length) {
        // Account id is the stable identifier; display names change and repeat.
        const myComments = f.comment.comments.filter((c) =>
          c.author?.accountId
            ? c.author.accountId === accountId
            : c.author?.displayName === config.profile.displayName,
        );
        if (myComments.length > 0) {
          lines.push(`**Your comments (${myComments.length}):**`);
          for (const c of myComments.slice(0, 3)) {
            const text = extractText(c.body);
            if (text) lines.push(`> ${text}`);
          }
        }
      }

      lines.push(`[View in Jira](${config.atlassian.url}/browse/${issue.key})`);
      lines.push("");
    }
  }

  // Confluence section
  if (pages.length > 0) {
    lines.push(`## Confluence Documents (${pages.length})`);
    lines.push("");

    for (const page of pages) {
      const tagStr = page._tags?.length ? ` [${page._tags.join(", ")}]` : "";
      lines.push(`### ${page.title}${tagStr}`);
      if (page.space) {
        lines.push(`**Space:** ${page.space.name}`);
      }
      lines.push(`**Last Updated:** ${formatDate(page.history?.lastUpdated?.when)}`);
      if (page._links?.webui) {
        lines.push(`[View in Confluence](${config.atlassian.url}/wiki${page._links.webui})`);
      }
      lines.push("");
    }
  }

  // GitHub PRs section
  if (prs.length > 0) {
    lines.push(`## GitHub Pull Requests (${prs.length})`);
    lines.push("");

    for (const pr of prs) {
      const repoName = pr.repository_url.split("/").slice(-2).join("/");
      const state = pr.merged_at ? "Merged" : pr.state === "closed" ? "Closed" : "Open";

      lines.push(`### [${repoName}#${pr.number}] ${pr.title}`);
      lines.push(`**Status:** ${state} | **Created:** ${formatDate(pr.created_at)}`);
      lines.push(`[View on GitHub](${pr.html_url})`);
      lines.push("");
    }
  }

  // GitHub Reviews section
  if (reviews.length > 0) {
    lines.push(`## GitHub Reviews (${reviews.length})`);
    lines.push("");

    for (const review of reviews) {
      lines.push(`### [${review.repo}#${review.pr_number}] ${review.pr_title}`);
      lines.push(`**Author:** ${review.pr_author} | **Verdict:** ${review.state} | **Comments:** ${review.comment_count}`);
      lines.push(`[View Review](${review.html_url})`);
      lines.push("");
    }
  }

  // Team sprint items
  if (teamSprintItems.length > 0) {
    lines.push(`## Team Sprint Items (${teamSprintItems.length})`);
    lines.push("");
    lines.push("*Items in the team's active sprint, not assigned to or reported by you. Use for focus/awareness context.*");
    lines.push("");

    for (const issue of teamSprintItems) {
      const f = issue.fields;
      const priority = f.priority?.name ? ` | **Priority:** ${f.priority.name}` : "";
      lines.push(`- **[${issue.key}]** ${f.summary} — ${f.status.name}${priority}`);
    }
    lines.push("");
  }

  // Additional context
  if (additionalContext) {
    lines.push("## Additional Context");
    lines.push("");
    lines.push(additionalContext);
    lines.push("");
  }

  return lines.join("\n");
}
