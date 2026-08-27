/**
 * The plugin contract every activity source implements.
 *
 * Placeholder owned by the event-ledger work: it exists so a source can be written and tested
 * before the ledger lands. Keep it to the contract; the ledger implementation belongs elsewhere.
 */

import type { Logger } from "./logger";
import type { WorklogConfig } from "./types";

/** An item as first seen. Immutable once recorded; later changes are events, not edits. */
export interface SourceSnapshot {
  /** Stable id for the item (Jira key, PR URL, Confluence page id, Slack permalink). */
  id: string;
  firstSeenAt: string;
  payload: unknown;
}

/** Something that happened at a known time, filed by that time and never by fetch time. */
export interface SourceEvent {
  source: string;
  kind: string;
  itemId: string;
  /** ISO timestamp. Decides which week the event belongs to. */
  at: string;
  payload: unknown;
}

export interface SourceBatch {
  snapshots: SourceSnapshot[];
  events: SourceEvent[];
  /** Partial failures. A source degrades and says so rather than throwing. */
  warnings: string[];
}

export interface SourceContext {
  config: WorklogConfig;
  log?: Logger;
}

export type SourceAvailability = { ok: true } | { ok: false; reason: string };

export interface Source {
  name: string;
  isAvailable(ctx: SourceContext): Promise<SourceAvailability>;
  /** First fetch for a window: returns first-seen snapshots + events. */
  fetchWindow(window: { start: Date; end: Date }, ctx: SourceContext): Promise<SourceBatch>;
  /** Delta since a watermark: only events newer than `since`, filed by their own timestamp. */
  fetchSince(since: Date, itemIds: string[], ctx: SourceContext): Promise<SourceBatch>;
}
