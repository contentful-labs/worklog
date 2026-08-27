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

import { z } from "zod";

import type { ConfluencePage, GitHubPR, JiraIssue } from "../types";
import { extractText } from "../utils";
import { fetchGitHubPRs, searchConfluence, type FetchHeaders } from "./data-fetch";
import {
  EVENT_KINDS,
  PAYLOAD_FROM,
  PAYLOAD_SPOTTED,
  PAYLOAD_TEXT,
  PAYLOAD_TO,
  emptyBatch,
  markIncomplete,
  type Source,
  type SourceBatch,
  type SourceContext,
  type SourceEvent,
  type SourceState,
  type SourceWindow,
} from "./sources";
import type { WorklogConfig } from "./types";

/** Injected so a test can pin "now" and get the same events every run. */
export type Clock = () => Date;

/** The `expand` that gets a Jira issue's changelog back with it. */
const JIRA_CHANGELOG_EXPAND = "changelog";

/** What Jira is asked for per page when a history is read from its own endpoint. */
const JIRA_PAGE_SIZE = 100;

/** Fields either fetch needs: what the issue is, when it moved, and what was said. */
const JIRA_FIELDS = ["summary", "status", "created", "updated", "description", "comment"];

const CONFLUENCE_PAGE_EXPAND = "space,history,history.lastUpdated,history.createdBy,version";

/** The comment CQL asks for `container`; `history` is what carries the comment's own date. */
const CONFLUENCE_COMMENT_EXPAND = "container,history";

/**
 * A backstop on reading one pull request's conversation.
 *
 * Both of these endpoints are served oldest first, so stopping early hides the newest —
 * exactly the ones a week is about. The walk normally ends when a page comes back short;
 * this is only here so a pathological thread cannot spin, and reaching it is reported as
 * an incomplete read so the coverage it did not earn is not recorded.
 */
const GITHUB_PAGE_LIMIT = 200;

/** What GitHub is asked for per page, and therefore what "a full page" means below. */
const GITHUB_PAGE_SIZE = 100;

/**
 * A stop on walking a page's version history.
 *
 * The walk normally ends when it reaches a version older than the watermark. This is
 * only here so a page with a pathological history cannot spin for ever; reaching it is
 * reported rather than passed over, because the versions beyond it are then lost.
 */
const CONFLUENCE_VERSION_PAGES = 40;

// --- shapes the shared types don't name -------------------------------------------

/**
 * A Jira comment, plus what the shared type omits.
 *
 * `id` is what the ledger dedupes on, and `author` is how a comment of the user's own is
 * told apart from a colleague's on the same ticket.
 */
type JiraComment = NonNullable<NonNullable<JiraIssue["fields"]["comment"]>["comments"]>[number] & {
  id?: string;
  author?: { accountId?: string };
};

interface JiraChangelogItem {
  field?: string;
  fromString?: string | null;
  toString?: string | null;
}

interface JiraHistory {
  id?: string;
  created?: string;
  items?: JiraChangelogItem[];
}

/** Only present when the search was asked to expand it, and only its first page. */
type JiraIssueWithChangelog = JiraIssue & {
  changelog?: { total?: number; histories?: JiraHistory[] };
};

/** The comment count the search reports, which is often larger than the page it sends. */
type JiraIssueWithComments = JiraIssue & { fields: { comment?: { total?: number } } };

/** A page of an issue's comments, from the endpoint that serves the rest of them. */
const commentPageSchema = z.object({
  comments: z.array(z.object({
    id: z.string().optional(),
    created: z.string().optional(),
    author: z.object({ accountId: z.string().optional() }).optional(),
    // The shape `extractText` reads: Atlassian document format, as deep as we go into it.
    body: z.object({
      content: z.array(z.object({
        content: z.array(z.object({ text: z.string().optional() })).optional(),
      })).optional(),
    }).optional(),
  })).default([]),
  startAt: z.number().optional(),
  total: z.number().optional(),
});

/** A page of an issue's changelog, from the endpoint that serves the rest of it. */
const changelogPageSchema = z.object({
  values: z.array(z.object({
    id: z.string().optional(),
    created: z.string().optional(),
    items: z.array(z.object({
      field: z.string().optional(),
      fromString: z.string().nullish(),
      toString: z.string().nullish(),
    })).optional(),
  })).default([]),
  startAt: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
});

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

/**
 * A read of a page's version history.
 *
 * `complete` is the part that matters to the caller: a walk that gave up halfway looks
 * exactly like a page nobody else edited, and treating the two the same is how a user's
 * edit on the page that would not load gets dropped and never asked for again.
 */
interface VersionHistory {
  versions: ConfluenceVersion[];
  complete: boolean;
}

/** One entry in a page's version history. */
interface ConfluenceVersion {
  number?: number;
  createdAt?: string;
  message?: string;
  /**
   * Who made this edit.
   *
   * A page the user contributed to once keeps matching the contributor search for ever,
   * and every later edit by anybody comes back with it. Without this, a colleague's
   * Tuesday becomes an entry in the user's week.
   */
  authorId?: string;
}

/**
 * A pull request as the *search* endpoint describes it.
 *
 * Search answers with issues, and an issue says nothing about merging: whether and when
 * a pull request was merged lives in a nested `pull_request` object, while `closed_at`
 * sits at the top level and is set for merges too. Reading only the top level makes
 * every merged pull request look like a closed one.
 */
type SearchedPR = GitHubPR & {
  pull_request?: { merged_at?: string | null; url?: string };
};

/** When this pull request was merged, from wherever the endpoint in hand puts it. */
function mergedAtOf(pr: SearchedPR): string | undefined {
  return pr.pull_request?.merged_at ?? pr.merged_at ?? undefined;
}

/** One comment on a pull request's conversation. */
interface GitHubIssueComment {
  id: number;
  body?: string;
  created_at?: string;
  user?: { login?: string };
}

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

/**
 * A soft failure that cost us data.
 *
 * The difference from `warn` is what the ledger does next: an incomplete answer must not
 * be recorded as coverage, or the part that failed to load is never asked for again. Use
 * this whenever a page would not come back or a walk stopped short; use `warn` when the
 * answer is complete and merely disappointing.
 */
function partial(batch: SourceBatch, ctx: SourceContext, message: string): void {
  markIncomplete(batch, message);
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
  /**
   * Every changelog entry for an issue, following the pages when there are more.
   *
   * A search returns only the first page of an issue's changelog. An issue with a long
   * history would silently lose its oldest transitions, which are exactly the ones a
   * backfill of an old week is looking for.
   */
  async function allHistories(issue: JiraIssueWithChangelog, ctx: SourceContext, batch: SourceBatch): Promise<JiraHistory[]> {
    const embedded = issue.changelog?.histories ?? [];
    const total = issue.changelog?.total ?? embedded.length;
    if (total <= embedded.length) return embedded;

    // The embedded rows are a page, and a page has an offset. Jira does not promise it
    // is zero, and treating it as zero meant continuing from the wrong place: asking for
    // `startAt=50` after being handed rows 100-149 re-reads what we have and never
    // fetches rows 0-49. The whole history is read from the start instead, which costs
    // one extra page and cannot silently skip an interval.
    const histories: JiraHistory[] = [];
    try {
      while (histories.length < total) {
        const url = `${ctx.config.atlassian.url}/rest/api/3/issue/${issue.key}/changelog?startAt=${histories.length}&maxResults=${JIRA_PAGE_SIZE}`;
        const res = await fetch(url, { headers: headersOf(ctx).atlassian });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = changelogPageSchema.parse(await res.json());
        if (page.values.length === 0) break;
        histories.push(...page.values);
        if (page.isLast) break;
      }
    } catch (err) {
      partial(batch, ctx, `Could not read the rest of ${issue.key}'s history, some changes will be missing: ${String(err)}`);
      return histories.length > 0 ? histories : embedded;
    }

    if (histories.length < total) {
      partial(batch, ctx, `${issue.key} reports ${total} changes and only ${histories.length} could be read; the rest will be asked for again.`);
    }
    return histories;
  }

  /**
   * Every comment on an issue, following the pages when there are more.
   *
   * A search embeds only the first page. The comment that finished an argument is as
   * likely to be number 60 as number 6, and a week that never hears about it is a week
   * that says the work went quiet.
   */
  async function allComments(issue: JiraIssueWithComments, ctx: SourceContext, batch: SourceBatch): Promise<JiraComment[]> {
    // SAFETY: JiraComment is the shared comment type plus the optional `id` and `author`
    // the API sends and `JiraIssue` does not declare. Every field is read through a
    // guard, so a response without one costs that comment and nothing else.
    const embedded = (issue.fields.comment?.comments ?? []) as JiraComment[];
    const total = issue.fields.comment?.total ?? embedded.length;
    if (total <= embedded.length) return embedded;

    // From the start, for the same reason as the changelog above: the embedded rows are
    // a page at an offset Jira chose, and continuing from their length assumes it was
    // zero.
    const comments: JiraComment[] = [];
    try {
      while (comments.length < total) {
        const url = `${ctx.config.atlassian.url}/rest/api/3/issue/${issue.key}/comment?startAt=${comments.length}&maxResults=${JIRA_PAGE_SIZE}`;
        const res = await fetch(url, { headers: headersOf(ctx).atlassian });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = commentPageSchema.parse(await res.json());
        if (page.comments.length === 0) break;
        comments.push(...page.comments);
      }
    } catch (err) {
      partial(batch, ctx, `Could not read the rest of ${issue.key}'s comments, some will be missing: ${String(err)}`);
      return comments.length > 0 ? comments : embedded;
    }

    if (comments.length < total) {
      partial(batch, ctx, `${issue.key} reports ${total} comments and only ${comments.length} could be read; the rest will be asked for again.`);
    }
    return comments;
  }

  /** Status and description changes, each dated when the change was made. */
  function changelogEvents(key: string, histories: readonly JiraHistory[], keep: (at: Instant) => boolean): SourceEvent[] {
    const events: SourceEvent[] = [];
    for (const history of histories) {
      const at = instant(history.created);
      if (!at || !keep(at)) continue;
      for (const item of history.items ?? []) {
        if (item.field === "status") {
          events.push({
            source: "jira",
            kind: EVENT_KINDS.status,
            itemId: key,
            at: at.iso,
            id: history.id ? `${history.id}:status` : undefined,
            payload: { [PAYLOAD_FROM]: transitionValue(item.fromString), [PAYLOAD_TO]: transitionValue(item.toString) },
          });
        } else if (item.field === "description") {
          events.push({
            source: "jira",
            kind: EVENT_KINDS.description,
            itemId: key,
            at: at.iso,
            id: history.id ? `${history.id}:description` : undefined,
            payload: { [PAYLOAD_TEXT]: transitionValue(item.toString) },
          });
        }
      }
    }
    return events;
  }

  /**
   * Comments the user wrote, and only those.
   *
   * A ticket assigned to you collects other people's comments, and a work log that
   * counts them as your week's evidence is describing somebody else's work.
   */
  function commentEvents(key: string, comments: readonly JiraComment[], ctx: SourceContext, keep: (at: Instant) => boolean): SourceEvent[] {
    const events: SourceEvent[] = [];
    for (const comment of comments) {
      if (comment.author?.accountId !== accountIdOf(ctx)) continue;
      const at = instant(comment.created);
      if (!at || !keep(at)) continue;
      events.push({
        source: "jira",
        kind: EVENT_KINDS.comment,
        itemId: key,
        at: at.iso,
        id: comment.id,
        payload: { [PAYLOAD_TEXT]: extractText(comment.body) },
      });
    }
    return events;
  }

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

      // Everything whose life overlaps the window, not everything last touched inside it.
      // An issue moved on Monday and touched again three weeks later carries a current
      // `updated` outside this window, and a search bounded above by it would miss the
      // Monday entirely — permanently, because the window is then marked as fetched.
      const jql = `(assignee = "${email}" OR reporter = "${email}") AND created <= "${isoDate(window.end)}" AND updated >= "${isoDate(window.start)}" ORDER BY updated DESC`;

      // With the changelog, because an issue's own `updated` is one date and its history
      // is many. An issue created in one week and moved to Done in another has to report
      // both to the weeks they happened in, not one blurred entry to whichever week the
      // search happened to match.
      const issues = await fetchJiraIssuesExpanded(ctx.config, headersOf(ctx), jql, JIRA_FIELDS, JIRA_CHANGELOG_EXPAND);
      logOf(ctx)(`jira: ${issues.length} issue(s) alive during the window`);

      for (const issue of issues) {
        const eventsBefore = batch.events.length;

        const created = instant(issue.fields.created);
        if (created && inWindow(created, window)) {
          batch.events.push({ source: "jira", kind: EVENT_KINDS.created, itemId: issue.key, at: created.iso, payload: {} });
        }

        const histories = await allHistories(issue, ctx, batch);
        batch.events.push(...changelogEvents(issue.key, histories, (at) => inWindow(at, window)));
        batch.events.push(...commentEvents(issue.key, await allComments(issue, ctx, batch), ctx, (at) => inWindow(at, window)));

        // Nothing datable happened inside the window. Three cases, and only one of them
        // is news: the issue's own `updated` lands here, so something happened and Jira
        // will not say what; there is no usable date at all, so it happened and we can
        // only say when we saw it; or `updated` is elsewhere, and the issue was merely
        // alive while this week went by, which is not something to write down.
        if (batch.events.length === eventsBefore) {
          const updated = instant(issue.fields.updated);
          if (updated && !inWindow(updated, window)) continue;
          batch.events.push({
            source: "jira",
            kind: EVENT_KINDS.active,
            itemId: issue.key,
            at: updated ? updated.iso : spottedAt,
            payload: updated ? {} : { [PAYLOAD_SPOTTED]: true },
          });
        }

        // Only items this week has something to say about get a snapshot, so a week is
        // not filled with headings for tickets that merely existed while it happened.
        batch.snapshots.push({
          id: issue.key,
          firstSeenAt: spottedAt,
          payload: jiraSnapshotPayload(issue, ctx.config),
        });
      }

      return batch;
    },

    async fetchSince(since, itemIds, ctx) {
      const batch = emptyBatch();
      const spottedAt = now().toISOString();
      const known = new Set(itemIds);
      const email = ctx.config.atlassian.email;

      // Two questions in one query. The known ids catch changes to work already being
      // tracked; the assignee/reporter half is what finds an issue that did not exist
      // when the week was first fetched. Without it a ticket created after the first run
      // is invisible for ever, because it is in nobody's list of known ids.
      // A known limit: stock Jira has no way to search for issues a person commented on,
      // so a comment on a ticket somebody else owns and reports, that the ledger has
      // never seen, is not found. Assignee, reporter and already-tracked ids are the
      // whole reach. Adding it would need a project-wide scan of every updated issue,
      // which is a different order of cost, or a Jira with ScriptRunner installed.
      const mine = `assignee = "${email}" OR reporter = "${email}"`;
      const scope = itemIds.length > 0 ? `(${mine} OR key in (${itemIds.join(", ")}))` : `(${mine})`;
      const jql = `${scope} AND updated > "${jqlDateTime(since)}"`;

      const issues = await fetchJiraIssuesExpanded(ctx.config, headersOf(ctx), jql, JIRA_FIELDS, JIRA_CHANGELOG_EXPAND);
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

          const created = instant(issue.fields.created);
          if (created && after(created, since)) {
            batch.events.push({ source: "jira", kind: EVENT_KINDS.created, itemId: issue.key, at: created.iso, payload: {} });
          }
        }

        const histories = await allHistories(issue, ctx, batch);
        batch.events.push(...changelogEvents(issue.key, histories, (at) => after(at, since)));
        batch.events.push(...commentEvents(issue.key, await allComments(issue, ctx, batch), ctx, (at) => after(at, since)));
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

/** A page of a page's version history, from the v2 API that serves all of them. */
const versionPageSchema = z.object({
  results: z.array(z.object({
    number: z.number().optional(),
    createdAt: z.string().optional(),
    authorId: z.string().optional(),
    message: z.string().optional(),
  })).default([]),
  _links: z.object({ next: z.string().optional() }).optional(),
});

export function confluenceSource(now: Clock = () => new Date()): Source {
  /**
   * Every version of a page, newest first, following the pages of them.
   *
   * The search only ever hands back the current version. A page edited four times
   * between two runs would report one edit, on the day of the last one, and the three
   * weeks the other edits belong to would never hear about them.
   */
  async function versionsOf(pageId: string, coveredThrough: Date, ctx: SourceContext, batch: SourceBatch): Promise<VersionHistory> {
    const versions: ConfluenceVersion[] = [];
    let path: string | undefined = `/wiki/api/v2/pages/${pageId}/versions?limit=50&sort=-modified-date`;
    let page = 0;
    let complete = false;

    try {
      // Newest first, so the walk ends as soon as it reaches something the watermark
      // already covers. Stopping after a fixed number of pages instead would leave newer
      // versions unread while the watermark moved past them, and they would never be
      // asked for again.
      while (path) {
        if (page++ >= CONFLUENCE_VERSION_PAGES) {
          partial(batch, ctx, `Confluence page ${pageId} has more history than one run will walk; edits older than version ${versions[versions.length - 1]?.number ?? "?"} were not read.`);
          return { versions, complete: false };
        }
        const res = await fetch(`${ctx.config.atlassian.url}${path}`, { headers: headersOf(ctx).atlassian });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = versionPageSchema.parse(await res.json());
        versions.push(...parsed.results);

        const reachedTheKnown = parsed.results.some((version) => {
          const at = instant(version.createdAt);
          return at !== undefined && !after(at, coveredThrough);
        });
        if (reachedTheKnown || parsed.results.length === 0) {
          complete = true;
          break;
        }
        path = parsed._links?.next;
      }
      // Ran out of pages rather than out of interest: the whole history was read.
      if (!path) complete = true;
    } catch (err) {
      partial(batch, ctx, `Could not read the version history of Confluence page ${pageId}, some edits will be missing: ${String(err)}`);
      return { versions, complete: false };
    }
    return { versions, complete };
  }

  /** Comments the user wrote, as events against the page they hang off. */
  async function commentBatch(
    cql: string,
    ctx: SourceContext,
    batch: SourceBatch,
    known: Set<string>,
    spottedAt: string,
    keep: (at: Instant | undefined) => boolean,
  ): Promise<void> {
    // Comments are supplementary: a page's own history is still worth having without them.
    let comments: ConfluenceCommentDetail[] = [];
    try {
      comments = await searchConfluence<ConfluenceCommentDetail>(ctx.config, headersOf(ctx), cql, CONFLUENCE_COMMENT_EXPAND);
    } catch (err) {
      partial(batch, ctx, `Confluence comment search failed, comments will be missing: ${String(err)}`);
      return;
    }

    for (const comment of comments) {
      const container = comment.container;
      if (!container?.id) continue;

      const at = instant(comment.history?.createdDate);
      if (!keep(at)) continue;

      // An event needs an item to hang off. A page we only learned about through a comment
      // has no snapshot yet, so it gets one here.
      if (!known.has(container.id)) {
        known.add(container.id);
        batch.snapshots.push({
          id: container.id,
          firstSeenAt: spottedAt,
          payload: confluencePayload(container.id, container.title, confluenceUrl(ctx.config, container._links), container.space?.name ?? ""),
        });
      }

      batch.events.push({
        source: "confluence",
        kind: EVENT_KINDS.comment,
        itemId: container.id,
        at: at ? at.iso : spottedAt,
        id: comment.id,
        payload: at ? {} : { [PAYLOAD_SPOTTED]: true },
      });
    }
  }

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

      // `lastModified` is the page's current state, not the date of any one edit, so an
      // upper bound on it hides a page edited during this week and again later. The
      // window is applied to each event's own date below instead.
      const contributorCql = `contributor = "${accountId}" AND type = page AND created <= "${endDate}" AND lastModified >= "${startDate}"`;
      const pages = await searchConfluence<ConfluencePageDetail>(ctx.config, headersOf(ctx), contributorCql, CONFLUENCE_PAGE_EXPAND, "any");
      logOf(ctx)(`confluence: ${pages.length} page(s) alive during the window`);

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

        // Every edit made during the week, not the state the page happens to be in now.
        // A page edited three times in one week has three things to say about it, and the
        // search only ever reports the last of them.
        const history = await versionsOf(page.id, window.start, ctx, batch);
        for (const version of history.versions) {
          if (version.authorId !== accountId) continue;
          const at = instant(version.createdAt);
          if (!at || !inWindow(at, window)) continue;
          batch.events.push({
            source: "confluence",
            kind: EVENT_KINDS.version,
            itemId: page.id,
            at: at.iso,
            id: version.number ? `${page.id}:v${version.number}` : undefined,
            payload: version.message ? { [PAYLOAD_TEXT]: version.message } : {},
          });
        }

        // Nothing of this user's, so nothing to say about this page this week. That
        // holds whether the history answered in full — in which case the page was merely
        // alive while the week went by — or did not, in which case we do not know who
        // made the last edit and must not guess. Guessing wrote the page's `lastUpdated`
        // down as the user's own work, and a later complete read proving it was a
        // colleague's could not take it back: the ledger is append-only. The batch is
        // already marked incomplete, so the week is asked about again.
        if (batch.events.length === eventsBefore) {
          batch.snapshots.pop();
          seen.delete(page.id);
        }
      }

      const commentCql = `type = comment AND creator = "${accountId}" AND created >= "${startDate}" AND created <= "${endDate}"`;
      await commentBatch(commentCql, ctx, batch, seen, spottedAt, (at) => !at || inWindow(at, window));

      return batch;
    },

    async fetchSince(since, itemIds, ctx) {
      const batch = emptyBatch();
      const spottedAt = now().toISOString();
      const accountId = accountIdOf(ctx);
      const sinceDate = isoDate(since);

      // The contributor half finds pages that did not exist when the week was fetched;
      // the id half catches edits to pages already being tracked.
      const mine = `contributor = "${accountId}" AND type = page`;
      const scope = itemIds.length > 0 ? `((${mine}) OR id in (${itemIds.join(", ")}))` : `(${mine})`;
      const cql = `${scope} AND lastModified > "${sinceDate}"`;

      const pages = await searchConfluence<ConfluencePageDetail>(ctx.config, headersOf(ctx), cql, CONFLUENCE_PAGE_EXPAND, "any");
      logOf(ctx)(`confluence: ${pages.length} page(s) changed since ${since.toISOString()}`);

      const known = new Set(itemIds);
      for (const page of pages) {
        if (!known.has(page.id)) {
          known.add(page.id);
          batch.snapshots.push({
            id: page.id,
            firstSeenAt: spottedAt,
            payload: confluencePayload(page.id, page.title, confluenceUrl(ctx.config, page._links), page.space?.name ?? ""),
          });
        }

        // Every version made since the watermark, each dated when it was made, rather
        // than only the newest one dated when the page last moved.
        const { versions } = await versionsOf(page.id, since, ctx, batch);
        for (const version of versions) {
          // A page the user once contributed to keeps matching the contributor search,
          // so most of what comes back may be somebody else's editing.
          if (version.authorId !== accountId) continue;
          const at = instant(version.createdAt);
          // CQL only filters to the day, so the exact watermark is applied here.
          if (!at || !after(at, since)) continue;
          batch.events.push({
            source: "confluence",
            kind: EVENT_KINDS.version,
            itemId: page.id,
            at: at.iso,
            id: version.number ? `${page.id}:v${version.number}` : undefined,
            payload: version.message ? { [PAYLOAD_TEXT]: version.message } : {},
          });
        }

        // No fallback to the page's own `lastUpdated` here either. It says when the page
        // last moved and nothing about who moved it, and an event recorded under this
        // user's name cannot be withdrawn once the history says otherwise.
      }

      const commentCql = `type = comment AND creator = "${accountId}" AND created > "${sinceDate}"`;
      await commentBatch(commentCql, ctx, batch, known, spottedAt, (at) => Boolean(at && after(at, since)));

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
/**
 * Where an ETag is filed.
 *
 * Keyed by the watermark as well as the url. The response is filtered by `since`
 * afterwards, so an ETag stored while scanning a recent week stands for "you have seen
 * everything after last Tuesday" and nothing more. Replaying it against an older week's
 * scan answers 304 and hides every event in between, for good.
 */
function conditionalKey(url: string, conditional: Date | false): string {
  return conditional ? `${url}|since:${conditional.toISOString()}` : url;
}

async function conditionalGet(
  url: string,
  ctx: SourceContext,
  conditional: Date | false,
  ignoreStored = false,
): Promise<{ status: number; body?: unknown }> {
  const key = conditionalKey(url, conditional);
  const etag = conditional && !ignoreStored ? stateOf(ctx).get(key) : undefined;
  const headers = new Headers(headersOf(ctx).github);
  // A stored ETag makes this request free when nothing has changed since last time.
  if (etag) headers.set("If-None-Match", etag);

  const res = await fetch(url, { headers });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) return { status: res.status };

  const fresh = res.headers.get("etag");
  if (fresh && conditional) stateOf(ctx).set(key, fresh);
  return { status: res.status, body: await res.json() };
}

/**
 * How many rows a page held last time it was read.
 *
 * A 304 says "unchanged" and sends no body, so without this the walk cannot tell a full
 * page from the last one and has to guess. It used to guess "stop", which meant a page
 * that failed after an earlier page succeeded was never requested again: the retry got
 * a 304 on page one and went home.
 */
function rememberPageSize(url: string, conditional: Date | false, ctx: SourceContext, rows: number): void {
  if (conditional) stateOf(ctx).set(`${conditionalKey(url, conditional)}#rows`, String(rows));
}

function lastPageSize(url: string, conditional: Date | false, ctx: SourceContext): number | undefined {
  const stored = conditional ? stateOf(ctx).get(`${conditionalKey(url, conditional)}#rows`) : undefined;
  return stored === undefined ? undefined : Number(stored);
}

/**
 * Whether this page's stored ETag may be used.
 *
 * Only when we also know how many rows that page held. A 304 with no remembered size
 * tells the walk nothing: it cannot say whether this was the last page, so it would have
 * to keep asking to the cap. One unconditional request instead costs one call and
 * teaches it the answer for next time.
 */
function mayUseStoredEtag(url: string, conditional: Date | false, ctx: SourceContext): boolean {
  return lastPageSize(url, conditional, ctx) !== undefined;
}

export function githubSource(now: Clock = () => new Date()): Source {
  /** Reviews the user left on one PR, as events dated when each was submitted. */
  async function reviewEvents(
    repo: string,
    number: number,
    itemId: string,
    ctx: SourceContext,
    batch: SourceBatch,
    opts: { conditional: Date | false; keep: (at: Instant) => boolean },
  ): Promise<void> {
    try {
      // Paged. GitHub sends thirty by default, and a long review conversation is exactly
      // the kind of week worth writing about.
      for (let page = 1; page <= GITHUB_PAGE_LIMIT; page++) {
        const url = `https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
        const { status, body } = await conditionalGet(url, ctx, opts.conditional, !mayUseStoredEtag(url, opts.conditional, ctx));
        if (status === 304) {
          // This page has not changed, so its reviews are already in the ledger — but the
          // pages after it may never have been read at all, which is what happened when
          // page two failed and page one's ETag outlived it.
          if ((lastPageSize(url, opts.conditional, ctx) ?? 0) < GITHUB_PAGE_SIZE) return;
          continue;
        }
        if (status !== 200) {
          partial(batch, ctx, `Could not read reviews for ${repo}#${number}, they will be missing: HTTP ${status}`);
          return;
        }
        // SAFETY: the reviews endpoint returns an array of reviews; every field this
        // reads is optional on GitHubReview and guarded, so a shape change drops reviews
        // rather than throwing.
        const reviews = (Array.isArray(body) ? body : []) as GitHubReview[];
        rememberPageSize(url, opts.conditional, ctx, reviews.length);

        for (const review of reviews) {
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

        if (reviews.length < GITHUB_PAGE_SIZE) return;
      }
      partial(batch, ctx, `${repo}#${number} has more reviews than one run will read; the newest of them are missing, because GitHub serves this list oldest first.`);
    } catch (err) {
      partial(batch, ctx, `Could not read reviews for ${repo}#${number}, they will be missing: ${String(err)}`);
    }
  }

  /**
   * Comments the user left on one pull request's conversation.
   *
   * Not the same endpoint as reviews, and not the same kind of work: most of what gets
   * said on a pull request is said here, and a week that only counts formal approvals
   * reads as though the user spent it in silence.
   */
  async function commentEvents(
    repo: string,
    number: number,
    itemId: string,
    ctx: SourceContext,
    batch: SourceBatch,
    opts: { conditional: Date | false; keep: (at: Instant) => boolean },
  ): Promise<void> {
    try {
      // `since` is GitHub's own filter on this endpoint. Without it a delta pages through
      // years of an old thread to reach the comment made yesterday, and gives up before
      // it gets there.
      const from = opts.conditional ? `&since=${opts.conditional.toISOString()}` : "";
      for (let page = 1; page <= GITHUB_PAGE_LIMIT; page++) {
        const url = `https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=${GITHUB_PAGE_SIZE}&page=${page}${from}`;
        const { status, body } = await conditionalGet(url, ctx, opts.conditional, !mayUseStoredEtag(url, opts.conditional, ctx));
        if (status === 304) {
          // This page has not changed, so its comments are already in the ledger — but the
          // pages after it may never have been read at all, which is what happened when
          // page two failed and page one's ETag outlived it.
          if ((lastPageSize(url, opts.conditional, ctx) ?? 0) < GITHUB_PAGE_SIZE) return;
          continue;
        }
        if (status !== 200) {
          partial(batch, ctx, `Could not read comments on ${repo}#${number}, they will be missing: HTTP ${status}`);
          return;
        }
        // SAFETY: the issue-comments endpoint returns an array of comments; every field
        // read below is optional and guarded, so a shape change drops comments rather
        // than throwing.
        const comments = (Array.isArray(body) ? body : []) as GitHubIssueComment[];
        rememberPageSize(url, opts.conditional, ctx, comments.length);

        for (const comment of comments) {
          if (comment.user?.login !== githubUserOf(ctx)) continue;
          const at = instant(comment.created_at);
          if (!at || !opts.keep(at)) continue;
          batch.events.push({
            source: "github",
            kind: EVENT_KINDS.comment,
            itemId,
            at: at.iso,
            id: String(comment.id),
            payload: { [PAYLOAD_TEXT]: comment.body ?? "" },
          });
        }

        if (comments.length < GITHUB_PAGE_SIZE) return;
      }
      partial(batch, ctx, `${repo}#${number} has more comments than one run will read; the newest of them are missing, because GitHub serves this list oldest first.`);
    } catch (err) {
      partial(batch, ctx, `Could not read comments on ${repo}#${number}, they will be missing: ${String(err)}`);
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

      // Everything alive during the week: opened on or before it ended, touched on or
      // after it began. A PR opened in one week and merged in the next is only ever
      // created once, and its last activity may be months later, so neither bound on its
      // own finds it. Each event is then filed by its own date, so the week keeps what
      // belongs to it and nothing else.
      const authored = await fetchGitHubPRs(headersOf(ctx), `type:pr author:${username} ${orgFilter} created:<=${endDate} updated:>=${startDate}`, "updated");
      logOf(ctx)(`github: ${authored.length} authored PR(s) active in the window`);

      const authoredUrls = new Set(authored.map((pr) => pr.html_url));

      // The same overlap bounds, for the same reason. A review left during this week on
      // a pull request that moved on two weeks later would otherwise be excluded by the
      // pull request's current `updated`, and the window is marked fetched either way.
      // Other people's work is supplementary: a failed search must not lose the authored
      // pull requests with it.
      const others = new Map<string, GitHubPR>();
      for (const role of ["reviewed-by", "commenter"]) {
        try {
          const found = await fetchGitHubPRs(headersOf(ctx), `type:pr ${role}:${username} ${orgFilter} created:<=${endDate} updated:>=${startDate}`, "updated");
          for (const pr of found) others.set(pr.html_url, pr);
        } catch (err) {
          partial(batch, ctx, `A GitHub ${role} search failed, so some of what you did on other people's pull requests will be missing from this window: ${String(err)}`);
        }
      }

      for (const pr of authored) {
        batch.snapshots.push({ id: pr.html_url, firstSeenAt: spottedAt, payload: githubPayload(pr) });

        const created = instant(pr.created_at);
        if (created && inWindow(created, window)) {
          batch.events.push({ source: "github", kind: EVENT_KINDS.created, itemId: pr.html_url, at: created.iso, payload: {} });
        }

        const merged = instant(mergedAtOf(pr));
        if (merged && inWindow(merged, window)) {
          batch.events.push({ source: "github", kind: EVENT_KINDS.merged, itemId: pr.html_url, at: merged.iso, payload: {} });
        }

        const closed = instant(pr.closed_at);
        if (!merged && closed && inWindow(closed, window)) {
          batch.events.push({ source: "github", kind: EVENT_KINDS.closed, itemId: pr.html_url, at: closed.iso, payload: {} });
        }

        // Answering review feedback on your own pull request is most of what happens on
        // one, and it happens under the same conversation as everyone else's comments.
        // Skipping this because the PR was already snapshotted lost every reply the user
        // made to their own reviewers.
        await commentEvents(repoPathOf(pr), pr.number, pr.html_url, ctx, batch, { conditional: false, keep: () => true });
      }

      for (const pr of others.values()) {
        // Own PRs came back from the authored search already, and you don't review
        // yourself — but their conversation was already read above, so only the snapshot
        // and the review fetch are skipped here.
        if (authoredUrls.has(pr.html_url)) continue;
        batch.snapshots.push({ id: pr.html_url, firstSeenAt: spottedAt, payload: githubPayload(pr) });
        // No window filter on either: a review and a comment each carry their own date,
        // and the ledger files them by that, which is the whole point of reporting when
        // things happened instead of when we looked.
        await reviewEvents(repoPathOf(pr), pr.number, pr.html_url, ctx, batch, { conditional: false, keep: () => true });
        await commentEvents(repoPathOf(pr), pr.number, pr.html_url, ctx, batch, { conditional: false, keep: () => true });
      }

      return batch;
    },

    async fetchSince(since, itemIds, ctx) {
      const batch = emptyBatch();
      const spottedAt = now().toISOString();
      const username = githubUserOf(ctx);
      const orgFilter = ctx.config.githubOrgs.map((org) => `org:${org}`).join(" ");

      // Anything the user has touched since the watermark, whether or not the ledger has
      // heard of it. A PR opened after a week was first fetched is in nobody's list of
      // known ids, so without this it stays invisible for ever — and reviewing somebody
      // else's PR is work that leaves no trace at all in a search for what you authored.
      const known = new Set(itemIds);
      const touched: Array<{ role: string; query: string; missing: string }> = [
        { role: "author", query: `type:pr author:${username}`, missing: "anything you opened since the last run" },
        { role: "reviewed-by", query: `type:pr reviewed-by:${username}`, missing: "reviews you left on pull requests we had not seen" },
        { role: "commenter", query: `type:pr commenter:${username}`, missing: "pull requests you commented on but did not author" },
      ];

      for (const { query, missing } of touched) {
        let discovered: GitHubPR[] = [];
        try {
          discovered = await fetchGitHubPRs(headersOf(ctx), `${query} ${orgFilter} updated:>=${isoDate(since)}`, "updated");
        } catch (err) {
          partial(batch, ctx, `A GitHub search failed, so ${missing} will be missing: ${String(err)}`);
          continue;
        }

        for (const pr of discovered) {
          if (known.has(pr.html_url)) continue;
          known.add(pr.html_url);
          batch.snapshots.push({ id: pr.html_url, firstSeenAt: spottedAt, payload: githubPayload(pr) });

          // Only work of the user's own gets a "created" event. Opening somebody else's
          // pull request is their week's news, not this one's.
          const created = instant(pr.created_at);
          if (pr.user?.login === username && created && after(created, since)) {
            batch.events.push({ source: "github", kind: EVENT_KINDS.created, itemId: pr.html_url, at: created.iso, payload: {} });
          }
        }
      }

      logOf(ctx)(`github: checking ${known.size} PR(s) for changes since ${since.toISOString()}`);

      for (const itemId of known) {
        const parsed = parsePrUrl(itemId);
        if (!parsed) {
          warn(batch, ctx, `Skipped ${itemId}: it is not a pull request url this source can read.`);
          continue;
        }
        const { repo, number } = parsed;

        await reviewEvents(repo, number, itemId, ctx, batch, { conditional: since, keep: (at) => after(at, since) });
        await commentEvents(repo, number, itemId, ctx, batch, { conditional: since, keep: (at) => after(at, since) });

        const prUrl = `https://api.github.com/repos/${repo}/pulls/${number}`;
        try {
          const { status, body } = await conditionalGet(prUrl, ctx, since);
          if (status === 304) continue;
          if (status !== 200) {
            partial(batch, ctx, `Could not read ${repo}#${number}, its merges and closures will be missing: HTTP ${status}`);
            continue;
          }
          // SAFETY: the pull request endpoint returns one pull request. Both fields read
          // below are optional on GitHubPR and go through `instant`, so a shape change
          // costs this PR's merge and closure rather than throwing.
          const pr = body as GitHubPR;

          const merged = instant(mergedAtOf(pr));
          if (merged && after(merged, since)) {
            batch.events.push({ source: "github", kind: EVENT_KINDS.merged, itemId, at: merged.iso, payload: {} });
          }

          const closed = instant(pr.closed_at);
          if (!merged && closed && after(closed, since)) {
            batch.events.push({ source: "github", kind: EVENT_KINDS.closed, itemId, at: closed.iso, payload: {} });
          }
        } catch (err) {
          partial(batch, ctx, `Could not read ${repo}#${number}, its merges and closures will be missing: ${String(err)}`);
        }
      }

      return batch;
    },
  };
}
