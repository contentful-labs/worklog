/**
 * Jira, Confluence and GitHub behind the frozen `Source` interface.
 *
 * Each adapter answers the same two questions — what was there when we first looked at a
 * week, and what has happened since — using the fetchers in `data-fetch`, with the same
 * queries the weekly fetch already sends. Nothing here decides which week anything
 * belongs to. Every event carries the timestamp the system gave it, so a comment written
 * in September on an August ticket is reported with September's date and the ledger files
 * it in September's week.
 *
 * Where a system tells us something changed but not when, the change is dated at the
 * moment it was spotted and flagged with `payload.spotted`, so the week can be honest
 * about the difference rather than quietly pretending it knows.
 *
 * A supplementary fetch that fails is a warning and the run continues; only the primary
 * query of a source is allowed to fail the whole call.
 */

import type { ConfluencePage, GitHubPR, JiraIssue } from "../types";
import { extractText } from "../utils";
import { fetchGitHubPRs, fetchJiraIssues, searchConfluence, type FetchHeaders } from "./data-fetch";
import {
  EVENT_KINDS,
  PAYLOAD_FROM,
  PAYLOAD_SPOTTED,
  PAYLOAD_TEXT,
  PAYLOAD_TO,
  emptyBatch,
  type Source,
  type SourceBatch,
  type SourceContext,
  type SourceState,
  type SourceWindow,
} from "./sources";
import type { WorklogConfig } from "./types";

/** Injected so a test can pin "now" and get the same events every run. */
export type Clock = () => Date;

/** The `expand` that gets a Jira issue's changelog back with it. */
const JIRA_CHANGELOG_EXPAND = "changelog";

/** Fields a delta fetch needs: what changed, and what was said. */
const JIRA_DELTA_FIELDS = ["summary", "status", "created", "updated", "description", "comment"];

const CONFLUENCE_PAGE_EXPAND = "space,history,history.lastUpdated,history.createdBy,version";

/** The comment CQL asks for `container`; `history` is what carries the comment's own date. */
const CONFLUENCE_COMMENT_EXPAND = "container,history";

// --- shapes the shared types don't name -------------------------------------------

/** A Jira comment, plus the id the shared type omits and the ledger uses to dedupe. */
type JiraComment = NonNullable<NonNullable<JiraIssue["fields"]["comment"]>["comments"]>[number] & { id?: string };

interface JiraChangelogItem {
  field?: string;
  fromString?: string | null;
  toString?: string | null;
}

/** Only present when the search was asked to expand it. */
type JiraIssueWithChangelog = JiraIssue & {
  changelog?: { histories?: Array<{ id?: string; created?: string; items?: JiraChangelogItem[] }> };
};

interface ConfluenceContainer {
  id: string;
  title: string;
  space?: { name: string; key: string };
  _links?: { webui?: string };
}

/** What the comment CQL returns once `history` is expanded. */
interface ConfluenceCommentDetail {
  id: string;
  history?: { createdDate?: string };
  container?: ConfluenceContainer;
}

/** A page with its version number, which is the system's own id for a version event. */
type ConfluencePageDetail = ConfluencePage & { version?: { number?: number } };

interface GitHubReview {
  id: number;
  state?: string;
  body?: string;
  submitted_at?: string;
  user?: { login?: string };
}

// --- time -------------------------------------------------------------------------

/** A parsed timestamp: the ISO form to report, and the epoch millis to compare. */
interface Instant {
  iso: string;
  ms: number;
}

/**
 * Parse a timestamp from any of the three systems, or nothing.
 *
 * Jira and Confluence write offsets as `+0000`, which not every engine's `Date.parse`
 * accepts; punctuating it to `+00:00` makes the string ISO-8601 everywhere. A value that
 * still will not parse is treated as no timestamp at all, which sends the caller down the
 * `spotted` path rather than filing an event under an invented date.
 */
function instant(raw: string | undefined | null): Instant | undefined {
  if (!raw) return undefined;
  let ms = Date.parse(raw);
  if (Number.isNaN(ms)) ms = Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(ms)) return undefined;
  return { iso: new Date(ms).toISOString(), ms };
}

function inWindow(at: Instant, window: SourceWindow): boolean {
  return at.ms >= window.start.getTime() && at.ms <= window.end.getTime();
}

function after(at: Instant, since: Date): boolean {
  return at.ms > since.getTime();
}

/** `YYYY-MM-DD`, the date form both JQL and CQL take. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD HH:mm`, the finest datetime JQL accepts.
 *
 * Jira rejects a full ISO string: no `T`, no seconds, no offset. The delta fetch filters
 * events by the exact `since` afterwards, so the minute of slack this loses costs nothing.
 */
function jqlDateTime(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

// --- shared plumbing ---------------------------------------------------------------

/**
 * The capabilities these three sources need, read off a context that promises none of
 * them.
 *
 * Slack needs no auth and no state, so the context makes all of that optional. These
 * three do need it, and say so from `isAvailable` when it is absent. Reading through
 * these keeps the fetch paths honest about it rather than asserting it away.
 */
const noHeaders: FetchHeaders = { atlassian: {}, github: {} };

function headersOf(ctx: SourceContext): FetchHeaders {
  return ctx.headers ?? noHeaders;
}

function accountIdOf(ctx: SourceContext): string {
  return ctx.identity?.atlassianAccountId?.trim() ?? "";
}

function githubUserOf(ctx: SourceContext): string {
  return ctx.identity?.githubUsername?.trim() ?? "";
}

function logOf(ctx: SourceContext): (message: string) => void {
  return ctx.log ?? (() => {});
}

/** A source with nowhere to keep an ETag simply pays for every request. */
const noState: SourceState = { get: () => undefined, set: () => {} };

function stateOf(ctx: SourceContext): SourceState {
  return ctx.state ?? noState;
}

/** Record a soft failure in both places: the batch the ledger reads, and the live run. */
function warn(batch: SourceBatch, ctx: SourceContext, message: string): void {
  batch.warnings.push(message);
  ctx.onWarning?.(message);
}

function missingAtlassian(ctx: SourceContext): string | undefined {
  const missing: string[] = [];
  if (!ctx.config.atlassian.url?.trim()) {
    missing.push("your Atlassian site address is not set — run `worklog configure atlassian`");
  }
  if (!accountIdOf(ctx)) {
    missing.push("we could not work out who you are in Atlassian — check your Atlassian email and API token");
  }
  return missing.length > 0 ? `${missing.join(", and ")}.` : undefined;
}

// --- Jira ---------------------------------------------------------------------------

/** The POST body Jira's search endpoint takes, page token included once there is one. */
interface JiraSearchBody {
  jql: string;
  fields: string[];
  maxResults: number;
  expand: string;
  nextPageToken?: string;
}

/**
 * The same POST `fetchJiraIssues` sends, with `expand` added.
 *
 * `fetchJiraIssues` builds a fixed body and has nowhere to put `expand`, and the delta
 * fetch is worthless without the changelog, so this mirrors its body shape and its token
 * pagination rather than changing a function three other callers depend on.
 */
async function fetchJiraIssuesExpanded(
  config: WorklogConfig,
  headers: FetchHeaders,
  jql: string,
  fields: string[],
  expand: string,
): Promise<JiraIssueWithChangelog[]> {
  let issues: JiraIssueWithChangelog[] = [];
  let nextPageToken: string | undefined;

  while (true) {
    const body: JiraSearchBody = { jql, fields, maxResults: 100, expand };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(`${config.atlassian.url}/rest/api/3/search/jql`, {
      method: "POST",
      headers: headers.atlassian,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    issues = issues.concat(data.issues || []);
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return issues;
}

/**
 * What each source writes into a payload.
 *
 * `title`, `url` and `text` are the keys every source agreed to speak, and the work log
 * renders items from those alone. The rest is what this particular system knows, kept
 * because a later reader of the ledger may want it even though nothing reads it today.
 */
interface JiraPayload {
  title: string;
  url: string;
  text: string;
  key: string;
  status: string;
}

interface ConfluencePayload {
  title: string;
  url: string;
  id: string;
  space: string;
}

interface GitHubPayload {
  title: string;
  url: string;
  repo: string;
  number: number;
}

function jiraSnapshotPayload(issue: JiraIssue, config: WorklogConfig): JiraPayload {
  return {
    title: issue.fields.summary,
    url: `${config.atlassian.url}/browse/${issue.key}`,
    text: extractText(issue.fields.description),
    key: issue.key,
    status: issue.fields.status?.name ?? "",
  };
}

/**
 * A changelog item's `fromString`/`toString`, as the domain value it stands for.
 *
 * Jira writes an absent side of a transition as null, and the type allows undefined, and
 * both mean the same thing here: the field had nothing on that side.
 */
function transitionValue(value: string | null | undefined): string {
  return value ?? "";
}

/**
 * Every source the tool knows how to read.
 *
 * One list, so the weekly run and `refresh` can never disagree about what a source is.
 * A source that cannot run says why and is skipped, so listing one here costs nothing
 * until it is configured.
 */
export function allSources(): Source[] {
  return [jiraSource(), confluenceSource(), githubSource()];
}

export function jiraSource(now: Clock = () => new Date()): Source {
  return {
    name: "jira",

    async isAvailable(ctx) {
      const reason = missingAtlassian(ctx);
      return reason ? { ok: false, reason: `Jira cannot be read: ${reason}` } : { ok: true };
    },

    async fetchWindow(window, ctx) {
      const batch = emptyBatch();
      const spottedAt = now().toISOString();
      const email = ctx.config.atlassian.email;
      const jql = `(assignee = "${email}" OR reporter = "${email}") AND updated >= "${isoDate(window.start)}" AND updated <= "${isoDate(window.end)}" ORDER BY updated DESC`;

      const issues = await fetchJiraIssues(ctx.config, headersOf(ctx), jql);
      logOf(ctx)(`jira: ${issues.length} issue(s) updated in the window`);

      for (const issue of issues) {
        batch.snapshots.push({
          id: issue.key,
          firstSeenAt: spottedAt,
          payload: jiraSnapshotPayload(issue, ctx.config),
        });

        const eventsBefore = batch.events.length;

        const created = instant(issue.fields.created);
        if (created && inWindow(created, window)) {
          batch.events.push({ source: "jira", kind: EVENT_KINDS.created, itemId: issue.key, at: created.iso, payload: {} });
        }

        // SAFETY: JiraComment is the shared comment type plus an optional `id`, which
        // the API sends and `JiraIssue` does not declare. Every field is read through a
        // guard below, so a response without one costs that comment and nothing else.
        for (const comment of (issue.fields.comment?.comments ?? []) as JiraComment[]) {
          const at = instant(comment.created);
          if (!at || !inWindow(at, window)) continue;
          batch.events.push({
            source: "jira",
            kind: EVENT_KINDS.comment,
            itemId: issue.key,
            at: at.iso,
            id: comment.id,
            payload: { [PAYLOAD_TEXT]: extractText(comment.body) },
          });
        }

        // Nothing datable happened inside the window, but the search says the issue moved,
        // so record that much: at `updated` when that lands in the window, otherwise at the
        // moment we spotted it, flagged so the week does not read it as a real timestamp.
        if (batch.events.length === eventsBefore) {
          const updated = instant(issue.fields.updated);
          const dated = updated && inWindow(updated, window);
          batch.events.push({
            source: "jira",
            kind: EVENT_KINDS.active,
            itemId: issue.key,
            at: dated ? updated.iso : spottedAt,
            payload: dated ? {} : { [PAYLOAD_SPOTTED]: true },
          });
        }
      }

      return batch;
    },

    async fetchSince(since, itemIds, ctx) {
      if (itemIds.length === 0) return emptyBatch();

      const batch = emptyBatch();
      const spottedAt = now().toISOString();
      const known = new Set(itemIds);
      const jql = `key in (${itemIds.join(", ")}) AND updated > "${jqlDateTime(since)}"`;

      const issues = await fetchJiraIssuesExpanded(ctx.config, headersOf(ctx), jql, JIRA_DELTA_FIELDS, JIRA_CHANGELOG_EXPAND);
      logOf(ctx)(`jira: ${issues.length} issue(s) changed since ${since.toISOString()}`);

      for (const issue of issues) {
        // The ledger drops a snapshot it already holds, but an id it has never seen has no
        // title or url anywhere, so a newly matched issue still gets its first-seen record.
        if (!known.has(issue.key)) {
          batch.snapshots.push({
            id: issue.key,
            firstSeenAt: spottedAt,
            payload: jiraSnapshotPayload(issue, ctx.config),
          });
        }

        for (const history of issue.changelog?.histories ?? []) {
          const at = instant(history.created);
          if (!at || !after(at, since)) continue;
          for (const item of history.items ?? []) {
            if (item.field === "status") {
              batch.events.push({
                source: "jira",
                kind: EVENT_KINDS.status,
                itemId: issue.key,
                at: at.iso,
                id: history.id ? `${history.id}:status` : undefined,
                payload: { [PAYLOAD_FROM]: transitionValue(item.fromString), [PAYLOAD_TO]: transitionValue(item.toString) },
              });
            } else if (item.field === "description") {
              batch.events.push({
                source: "jira",
                kind: EVENT_KINDS.description,
                itemId: issue.key,
                at: at.iso,
                id: history.id ? `${history.id}:description` : undefined,
                payload: { [PAYLOAD_TEXT]: transitionValue(item.toString) },
              });
            }
          }
        }

        // SAFETY: as above, the shared type's comments plus the id the API sends.
        for (const comment of (issue.fields.comment?.comments ?? []) as JiraComment[]) {
          const at = instant(comment.created);
          if (!at || !after(at, since)) continue;
          batch.events.push({
            source: "jira",
            kind: EVENT_KINDS.comment,
            itemId: issue.key,
            at: at.iso,
            id: comment.id,
            payload: { [PAYLOAD_TEXT]: extractText(comment.body) },
          });
        }
      }

      return batch;
    },
  };
}

// --- Confluence -----------------------------------------------------------------------

function confluencePayload(id: string, title: string, url: string, spaceName: string): ConfluencePayload {
  return { title, url, id, space: spaceName };
}

function confluenceUrl(config: WorklogConfig, links: { webui?: string } | undefined): string {
  return `${config.atlassian.url}/wiki${links?.webui ?? ""}`;
}

export function confluenceSource(now: Clock = () => new Date()): Source {
  return {
    name: "confluence",

    async isAvailable(ctx) {
      const reason = missingAtlassian(ctx);
      return reason ? { ok: false, reason: `Confluence cannot be read: ${reason}` } : { ok: true };
    },

    async fetchWindow(window, ctx) {
      const batch = emptyBatch();
      const spottedAt = now().toISOString();
      const accountId = accountIdOf(ctx);
      const startDate = isoDate(window.start);
      const endDate = isoDate(window.end);

      const contributorCql = `contributor = "${accountId}" AND type = page AND lastModified >= "${startDate}" AND lastModified <= "${endDate}"`;
      const pages = await searchConfluence<ConfluencePageDetail>(ctx.config, headersOf(ctx), contributorCql, CONFLUENCE_PAGE_EXPAND, "any");
      logOf(ctx)(`confluence: ${pages.length} page(s) touched in the window`);

      const seen = new Set<string>();
      for (const page of pages) {
        seen.add(page.id);
        batch.snapshots.push({
          id: page.id,
          firstSeenAt: spottedAt,
          payload: confluencePayload(page.id, page.title, confluenceUrl(ctx.config, page._links), page.space?.name ?? ""),
        });

        const eventsBefore = batch.events.length;

        const created = instant(page.history?.createdDate);
        if (page.history?.createdBy?.accountId === accountId && created && inWindow(created, window)) {
          batch.events.push({ source: "confluence", kind: EVENT_KINDS.created, itemId: page.id, at: created.iso, payload: {} });
        }

        const updated = instant(page.history?.lastUpdated?.when);
        if (updated && inWindow(updated, window)) {
          batch.events.push({
            source: "confluence",
            kind: EVENT_KINDS.version,
            itemId: page.id,
            at: updated.iso,
            id: page.version?.number ? `${page.id}:v${page.version.number}` : undefined,
            payload: {},
          });
        }

        // The search matched this page on `lastModified` but gave us no usable date for it,
        // so the edit is real and its time is not: date it now and say so.
        if (batch.events.length === eventsBefore) {
          batch.events.push({
            source: "confluence",
            kind: EVENT_KINDS.version,
            itemId: page.id,
            at: spottedAt,
            payload: { [PAYLOAD_SPOTTED]: true },
          });
        }
      }

      const commentCql = `type = comment AND creator = "${accountId}" AND created >= "${startDate}" AND created <= "${endDate}"`;
      // Comments are supplementary: a page's own history is still worth having without them.
      let comments: ConfluenceCommentDetail[] = [];
      try {
        comments = await searchConfluence<ConfluenceCommentDetail>(ctx.config, headersOf(ctx), commentCql, CONFLUENCE_COMMENT_EXPAND);
      } catch (err) {
        warn(batch, ctx, `Confluence comment search failed, comments will be missing from this window: ${String(err)}`);
      }

      for (const comment of comments) {
        const container = comment.container;
        if (!container?.id) continue;

        // An event needs an item to hang off. A page we only learned about through a comment
        // has no snapshot yet, so it gets one here.
        if (!seen.has(container.id)) {
          seen.add(container.id);
          batch.snapshots.push({
            id: container.id,
            firstSeenAt: spottedAt,
            payload: confluencePayload(container.id, container.title, confluenceUrl(ctx.config, container._links), container.space?.name ?? ""),
          });
        }

        const at = instant(comment.history?.createdDate);
        batch.events.push({
          source: "confluence",
          kind: EVENT_KINDS.comment,
          itemId: container.id,
          at: at ? at.iso : spottedAt,
          id: comment.id,
          payload: at ? {} : { [PAYLOAD_SPOTTED]: true },
        });
      }

      return batch;
    },

    async fetchSince(since, itemIds, ctx) {
      if (itemIds.length === 0) return emptyBatch();

      const batch = emptyBatch();
      const cql = `id in (${itemIds.join(", ")}) AND lastModified > "${isoDate(since)}"`;
      const pages = await searchConfluence<ConfluencePageDetail>(ctx.config, headersOf(ctx), cql, CONFLUENCE_PAGE_EXPAND, "any");
      logOf(ctx)(`confluence: ${pages.length} page(s) changed since ${since.toISOString()}`);

      for (const page of pages) {
        const updated = instant(page.history?.lastUpdated?.when);
        // CQL only filters to the day, so the exact watermark is applied here.
        if (!updated || !after(updated, since)) continue;
        batch.events.push({
          source: "confluence",
          kind: EVENT_KINDS.version,
          itemId: page.id,
          at: updated.iso,
          id: page.version?.number ? `${page.id}:v${page.version.number}` : undefined,
          payload: {},
        });
      }

      return batch;
    },
  };
}

// --- GitHub ---------------------------------------------------------------------------

function repoPathOf(pr: GitHubPR): string {
  return pr.repository_url.replace("https://api.github.com/repos/", "");
}

function githubPayload(pr: GitHubPR): GitHubPayload {
  return {
    title: pr.title,
    url: pr.html_url,
    repo: repoPathOf(pr),
    number: pr.number,
  };
}

/** `https://github.com/owner/repo/pull/7` back into the pieces the REST API needs. */
function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) return undefined;
  return { repo: match[1], number: Number(match[2]) };
}

/**
 * A GET that costs nothing when nothing changed.
 *
 * The ETag from the last run goes out as `If-None-Match`; GitHub answers 304 with no body
 * and no rate-limit charge, and the caller has nothing to do. A 200 stores the new ETag
 * for next time.
 *
 * `conditional` is off for a window fetch. A window is a first look at a week and has to
 * come back with the data, and the same PR can appear in two weeks: a stored ETag would
 * turn the second week's fetch into a 304 and silently lose its reviews.
 */
async function conditionalGet(
  url: string,
  ctx: SourceContext,
  conditional: boolean,
): Promise<{ status: number; body?: unknown }> {
  const etag = conditional ? stateOf(ctx).get(url) : undefined;
  const headers = new Headers(headersOf(ctx).github);
  // A stored ETag makes this request free when nothing has changed since last time.
  if (etag) headers.set("If-None-Match", etag);

  const res = await fetch(url, { headers });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) return { status: res.status };

  const fresh = res.headers.get("etag");
  if (fresh) stateOf(ctx).set(url, fresh);
  return { status: res.status, body: await res.json() };
}

export function githubSource(now: Clock = () => new Date()): Source {
  /** Reviews the user left on one PR, as events dated when each was submitted. */
  async function reviewEvents(
    repo: string,
    number: number,
    itemId: string,
    ctx: SourceContext,
    batch: SourceBatch,
    opts: { conditional: boolean; keep: (at: Instant) => boolean },
  ): Promise<void> {
    const url = `https://api.github.com/repos/${repo}/pulls/${number}/reviews`;
    try {
      const { status, body } = await conditionalGet(url, ctx, opts.conditional);
      if (status === 304) return;
      if (status !== 200) {
        warn(batch, ctx, `Could not read reviews for ${repo}#${number}, they will be missing: HTTP ${status}`);
        return;
      }
      // SAFETY: the reviews endpoint returns an array of reviews; every field this
      // reads is optional on GitHubReview and guarded, so a shape change drops reviews
      // rather than throwing.
      for (const review of (Array.isArray(body) ? body : []) as GitHubReview[]) {
        if (review.user?.login !== githubUserOf(ctx)) continue;
        const at = instant(review.submitted_at);
        if (!at || !opts.keep(at)) continue;
        batch.events.push({
          source: "github",
          kind: EVENT_KINDS.review,
          itemId,
          at: at.iso,
          id: String(review.id),
          payload: { state: review.state ?? "", [PAYLOAD_TEXT]: review.body ?? "" },
        });
      }
    } catch (err) {
      warn(batch, ctx, `Could not read reviews for ${repo}#${number}, they will be missing: ${String(err)}`);
    }
  }

  return {
    name: "github",

    async isAvailable(ctx) {
      const missing: string[] = [];
      if (!githubUserOf(ctx)) {
        missing.push("we could not work out your GitHub username — check your GitHub token");
      }
      if (ctx.config.githubOrgs.length === 0) {
        missing.push("no GitHub organisation is configured to search — run `worklog configure github`");
      }
      return missing.length > 0 ? { ok: false, reason: `GitHub cannot be read: ${missing.join(", and ")}.` } : { ok: true };
    },

    async fetchWindow(window, ctx) {
      const batch = emptyBatch();
      const spottedAt = now().toISOString();
      const username = githubUserOf(ctx);
      const orgFilter = ctx.config.githubOrgs.map((org) => `org:${org}`).join(" ");
      const startDate = isoDate(window.start);
      const endDate = isoDate(window.end);

      const authored = await fetchGitHubPRs(headersOf(ctx), `type:pr author:${username} ${orgFilter} created:${startDate}..${endDate}`, "created");
      logOf(ctx)(`github: ${authored.length} authored PR(s) in the window`);

      const authoredUrls = new Set(authored.map((pr) => pr.html_url));

      // Reviews are supplementary; a failed search must not lose the authored PRs with it.
      let reviewed: GitHubPR[] = [];
      try {
        reviewed = await fetchGitHubPRs(headersOf(ctx), `type:pr reviewed-by:${username} ${orgFilter} updated:${startDate}..${endDate}`, "updated");
      } catch (err) {
        warn(batch, ctx, `GitHub reviewed-PR search failed, reviews will be missing from this window: ${String(err)}`);
      }

      for (const pr of authored) {
        batch.snapshots.push({ id: pr.html_url, firstSeenAt: spottedAt, payload: githubPayload(pr) });

        const created = instant(pr.created_at);
        if (created && inWindow(created, window)) {
          batch.events.push({ source: "github", kind: EVENT_KINDS.created, itemId: pr.html_url, at: created.iso, payload: {} });
        }

        const merged = instant(pr.merged_at);
        if (merged && inWindow(merged, window)) {
          batch.events.push({ source: "github", kind: EVENT_KINDS.merged, itemId: pr.html_url, at: merged.iso, payload: {} });
        }

        const closed = instant(pr.closed_at);
        if (!merged && closed && inWindow(closed, window)) {
          batch.events.push({ source: "github", kind: EVENT_KINDS.closed, itemId: pr.html_url, at: closed.iso, payload: {} });
        }
      }

      for (const pr of reviewed) {
        // Own PRs came back from the authored search already, and you don't review yourself.
        if (authoredUrls.has(pr.html_url)) continue;
        batch.snapshots.push({ id: pr.html_url, firstSeenAt: spottedAt, payload: githubPayload(pr) });
        // No window filter: a review carries its own date, and the ledger files it by that,
        // which is the whole point of reporting when things happened instead of when we looked.
        await reviewEvents(repoPathOf(pr), pr.number, pr.html_url, ctx, batch, { conditional: false, keep: () => true });
      }

      return batch;
    },

    async fetchSince(since, itemIds, ctx) {
      if (itemIds.length === 0) return emptyBatch();

      const batch = emptyBatch();
      logOf(ctx)(`github: checking ${itemIds.length} PR(s) for changes since ${since.toISOString()}`);

      for (const itemId of itemIds) {
        const parsed = parsePrUrl(itemId);
        if (!parsed) {
          warn(batch, ctx, `Skipped ${itemId}: it is not a pull request url this source can read.`);
          continue;
        }
        const { repo, number } = parsed;

        await reviewEvents(repo, number, itemId, ctx, batch, { conditional: true, keep: (at) => after(at, since) });

        const prUrl = `https://api.github.com/repos/${repo}/pulls/${number}`;
        try {
          const { status, body } = await conditionalGet(prUrl, ctx, true);
          if (status === 304) continue;
          if (status !== 200) {
            warn(batch, ctx, `Could not read ${repo}#${number}, its merges and closures will be missing: HTTP ${status}`);
            continue;
          }
          const pr = body as GitHubPR;

          const merged = instant(pr.merged_at);
          if (merged && after(merged, since)) {
            batch.events.push({ source: "github", kind: EVENT_KINDS.merged, itemId, at: merged.iso, payload: {} });
          }

          const closed = instant(pr.closed_at);
          if (!merged && closed && after(closed, since)) {
            batch.events.push({ source: "github", kind: EVENT_KINDS.closed, itemId, at: closed.iso, payload: {} });
          }
        } catch (err) {
          warn(batch, ctx, `Could not read ${repo}#${number}, its merges and closures will be missing: ${String(err)}`);
        }
      }

      return batch;
    },
  };
}
