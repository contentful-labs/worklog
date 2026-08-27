import type { WorklogConfig } from "./types";
import type { JiraIssue, ConfluencePage, GitHubPR } from "../types";
import type { PRReview, WeekInfo } from "./data-fetch";
import type { SlackMessage } from "./sources/slack";
import { extractText, formatDate } from "../utils";

/**
 * A link destination cannot carry a space, a parenthesis or an angle bracket without breaking
 * out of `[text](dest)`. The permalink is model output, so percent-encode those rather than
 * trusting it. Linear scan, no regex over untrusted text.
 */
const LINK_DESTINATION_ESCAPES = new Map([
  [" ", "%20"],
  ["(", "%28"],
  [")", "%29"],
  ["<", "%3C"],
  [">", "%3E"],
  ['"', "%22"],
  ["'", "%27"],
]);

function escapeLinkDestination(url: string): string {
  let out = "";
  for (const char of url) {
    out += LINK_DESTINATION_ESCAPES.get(char) ?? (char.charCodeAt(0) < 0x20 ? "" : char);
  }
  return out;
}

/** `2026-03-02T09:14:00.000Z` reads as `2026-03-02 09:14 UTC`. */
function formatSlackTime(at: string): string {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

/** Message text is arbitrary and often multi-line, so every line gets its own quote marker. */
function quoteLines(text: string, indent: string): string[] {
  const trimmed = text.trim();
  return trimmed ? trimmed.split("\n").map((line) => `${indent}> ${line}`) : [];
}

/**
 * Group a channel's messages into threads. A message with no thread root and no replies stands
 * alone; everything sharing a thread root is rendered together, oldest first.
 */
function groupByThread(messages: SlackMessage[]): SlackMessage[][] {
  const threads = new Map<string, SlackMessage[]>();
  for (const message of messages) {
    const key = message.threadRoot ?? message.permalink;
    const existing = threads.get(key);
    if (existing) existing.push(message);
    else threads.set(key, [message]);
  }
  for (const thread of threads.values()) {
    thread.sort((a, b) => a.at.localeCompare(b.at));
  }
  return [...threads.values()].sort((a, b) => a[0].at.localeCompare(b[0].at));
}

function renderSlackSection(messages: SlackMessage[]): string[] {
  const lines: string[] = [];
  lines.push(`## Slack (${messages.length})`);
  lines.push("");
  lines.push("*Your own messages in public channels. Coaching context: decisions made, people unblocked, influence shown. Not achievement evidence on its own.*");
  lines.push("");

  const byChannel = new Map<string, SlackMessage[]>();
  for (const message of messages) {
    const existing = byChannel.get(message.channel);
    if (existing) existing.push(message);
    else byChannel.set(message.channel, [message]);
  }

  const channels = [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, channelMessages] of channels) {
    lines.push(`### #${channel}`);
    lines.push("");

    for (const thread of groupByThread(channelMessages)) {
      if (thread.length > 1 || thread[0].isReply) {
        lines.push(`- **Thread** (${thread.length} message${thread.length === 1 ? "" : "s"})`);
        for (const message of thread) {
          lines.push(`  - **${formatSlackTime(message.at)}** — [View in Slack](${escapeLinkDestination(message.permalink)})`);
          lines.push(...quoteLines(message.text, "    "));
        }
      } else {
        lines.push(`- **${formatSlackTime(thread[0].at)}** — [View in Slack](${escapeLinkDestination(thread[0].permalink)})`);
        lines.push(...quoteLines(thread[0].text, "  "));
      }
    }
    lines.push("");
  }

  return lines;
}

export function generateMarkdown(
  issues: JiraIssue[],
  pages: ConfluencePage[],
  prs: GitHubPR[],
  reviews: PRReview[],
  teamSprintItems: JiraIssue[],
  weekInfo: WeekInfo,
  additionalContext: string,
  config: WorklogConfig,
  accountId?: string,
  slackMessages: SlackMessage[] = [],
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
  // Only when there is something to count: the Slack source is optional, and a week fetched
  // without it must look exactly as it did before the source existed.
  if (slackMessages.length > 0) lines.push(`| Slack Messages | ${slackMessages.length} |`);
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
          accountId && c.author?.accountId
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

  // Slack section
  if (slackMessages.length > 0) {
    lines.push(...renderSlackSection(slackMessages));
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
