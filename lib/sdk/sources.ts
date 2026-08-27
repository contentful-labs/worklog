/**
 * Where activity comes from.
 *
 * A source knows how to answer two questions about one system: what was there when we
 * first looked at a week, and what has happened since. It never decides which week
 * anything belongs to. It reports each thing with the timestamp that thing carries, and
 * the ledger files it by that timestamp.
 *
 * That division is the user's rule about history in code form. State is kept as it was
 * when first fetched; a change discovered later is recorded on the date it happened, in
 * the week it happened, and a past week is amended with events that always belonged to
 * it rather than rewritten because of something that came after. A source that reported
 * "the current state" instead of "what happened, and when" would make that impossible.
 *
 * This interface is frozen: other phases implement against it in parallel. It can gain
 * optional fields; nothing in it changes shape.
 */

import type { WorklogConfig } from "./types";
import type { Logger } from "./logger";
import type { FetchHeaders } from "./data-fetch";

/**
 * An item as it was the first time we saw it.
 *
 * Written once and never again. A later change to the same item is an event, not an
 * edit to this: the snapshot is what the week it arrived in is entitled to show.
 */
export interface SourceSnapshot {
  /** Stable across runs and unique within the source: a ticket key, a PR url, a page id. */
  id: string;
  /** When this item first entered the ledger, as an ISO timestamp. */
  firstSeenAt: string;
  /**
   * Whatever the source knows about the item.
   *
   * `unknown` because only the source that wrote it can read all of it: it goes through
   * JSON on the way to disk and comes back a stranger, so a reader narrows it, either
   * with the payload helpers in the ledger or with the source's own parser.
   */
  payload: unknown;
}

/**
 * Something that happened, with the time it happened.
 *
 * `at` decides which week the event belongs to, and it is the source's job to report
 * the real one: a comment's own created time, a changelog entry's timestamp. Where the
 * system offers no timestamp for a change, the source dates it at the moment it was
 * spotted and says so with `payload.spotted`, so the week can be honest about the
 * difference.
 */
export interface SourceEvent {
  source: string;
  /** What kind of thing happened: "comment", "status", "review", "merged". */
  kind: string;
  /** The item this happened to, matching a snapshot id. */
  itemId: string;
  /** ISO timestamp of the event itself, not of the fetch. */
  at: string;
  payload: unknown;
  /**
   * The system's own id for this event, when it has one.
   *
   * Two comments can share a second, so the ledger falls back to source, kind, item and
   * time when this is absent; a real id is better and makes a re-fetch exactly a no-op.
   */
  id?: string;
}

/** What one source found in one call. */
export interface SourceBatch {
  snapshots: SourceSnapshot[];
  events: SourceEvent[];
  /** Fetches that failed softly. The run continues, and the user is told. */
  warnings: string[];
}

/**
 * Whatever a source needs to remember between runs: ETags, cursors, page tokens.
 *
 * Opaque to everything but the source that wrote it, and persisted with the ledger, so
 * a conditional request can still be free on the next run.
 */
export interface SourceState {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/**
 * What every source is handed.
 *
 * Only the config is common to all of them. The rest are capabilities a particular
 * source may need and another may not: Slack wants none of them, Jira wants the shared
 * auth and the account id, GitHub wants somewhere to keep an ETag. A source that needs
 * one it has not been given says so from `isAvailable`, which is what that call is for.
 */
export interface SourceContext {
  config: WorklogConfig;
  log?: Logger;
  /** Shared HTTP auth, for the sources that use it. */
  headers?: FetchHeaders;
  /** Who the user is in each system, resolved once per run. */
  identity?: {
    atlassianAccountId: string;
    githubUsername: string;
  };
  /** Called when a supplementary fetch fails and the run continues without that data. */
  onWarning?: (message: string) => void;
  /** This source's own persisted state, kept with the ledger. */
  state?: SourceState;
}

/** Whether a source can run at all, and if not, why not in words a user can act on. */
export type SourceAvailability = { ok: true } | { ok: false; reason: string };

/** A window of time, closed at both ends. */
export interface SourceWindow {
  start: Date;
  end: Date;
}

export interface Source {
  /** Lowercase, stable, used as a directory and a column heading: "jira", "slack". */
  name: string;

  isAvailable(ctx: SourceContext): Promise<SourceAvailability>;

  /** First fetch for a window: returns first-seen snapshots + events. */
  fetchWindow(window: SourceWindow, ctx: SourceContext): Promise<SourceBatch>;

  /** Delta since a watermark: only events newer than `since`, filed by their own timestamp. */
  fetchSince(since: Date, itemIds: string[], ctx: SourceContext): Promise<SourceBatch>;
}

/** An empty batch, for the paths where a source has nothing to say. */
export function emptyBatch(): SourceBatch {
  return { snapshots: [], events: [], warnings: [] };
}

/** Fold several batches into one, in the order given. */
export function mergeBatches(batches: readonly SourceBatch[]): SourceBatch {
  return {
    snapshots: batches.flatMap((batch) => batch.snapshots),
    events: batches.flatMap((batch) => batch.events),
    warnings: batches.flatMap((batch) => batch.warnings),
  };
}

/**
 * The fields every source agrees to put in a payload.
 *
 * Not a schema and not enforced: a payload is whatever the source knows, and only that
 * source can read all of it. But the work log has to render items from every source
 * side by side, so these few keys are the common ground it renders from, and a source
 * that omits them renders as a bare id.
 *
 * Snapshots: `title` (what to call the item) and `url` (where to open it). An item whose
 * id is itself a link, as a Slack permalink is, needs neither.
 * Events: `text` (what was said or changed, already plain text), `from` and `to` (a
 * transition), and `spotted` (true when the source could not learn when the change
 * happened and dated it at the moment it was found).
 */
export const PAYLOAD_TITLE = "title";
export const PAYLOAD_URL = "url";
export const PAYLOAD_TEXT = "text";
export const PAYLOAD_FROM = "from";
export const PAYLOAD_TO = "to";
export const PAYLOAD_SPOTTED = "spotted";

/**
 * Event kinds the work log knows how to phrase.
 *
 * A source may emit others and they still reach the model as prose; these are the ones
 * with a sentence written for them.
 */
export const EVENT_KINDS = {
  /** The item came into existence in this week. */
  created: "created",
  /** It was worked on, with no finer detail available. */
  active: "active",
  comment: "comment",
  status: "status",
  description: "description",
  review: "review",
  merged: "merged",
  closed: "closed",
  version: "version",
} as const;
