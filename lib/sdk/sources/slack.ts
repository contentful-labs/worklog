/**
 * Slack as an activity source, mediated by an LLM.
 *
 * There is no Slack or Glean API token in this tool's setup. The only route to Slack is Glean,
 * and the only client that can reach Glean is the Claude Code CLI with its Glean MCP server
 * connected. So a fetch here spawns `claude`, asks one focused question, and parses the answer.
 * That makes the source slow, non-deterministic in wording, and optional: when `claude` is
 * missing or Glean is disconnected the source reports itself unavailable and the run continues
 * without it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { WorklogConfig } from "../types";
import type {
  Source,
  SourceAvailability,
  SourceBatch,
  SourceContext,
  SourceEvent,
  SourceSnapshot,
} from "../sources";

export const SLACK_SOURCE_NAME = "slack";

/**
 * A measured week of Glean search plus synthesis took 157s, so 120s cut real answers off.
 * Raise this only against a measurement, never a guess.
 */
const FETCH_TIMEOUT_MS = 240_000;
const AVAILABILITY_TIMEOUT_MS = 30_000;

/** A week of one person's public Slack is well under this; the cap bounds prompt size and cost. */
const MAX_MESSAGES = 60;

const GLEAN_MCP_SERVER = "glean_default";
const GLEAN_TOOLS = [
  "mcp__glean_default__search",
  "mcp__glean_default__chat",
  "mcp__glean_default__read_document",
].join(",");

/** Longest stderr excerpt carried into a warning. Enough to diagnose, short enough to read. */
const REASON_MAX_CHARS = 200;

// --- Process runner (injected in tests; no test spawns a process) ---

export type RunResult =
  | { ok: true; stdout: string }
  | { ok: false; kind: "missing" | "timeout" | "failed"; message: string };

export type ProcessRunner = (
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<RunResult>;

const execFileAsync = promisify(execFile);

/**
 * What `execFile` puts on the error it rejects with: `code` is a spawn errno such as ENOENT,
 * `killed` is set when the timeout fired. Parsed rather than asserted, because a rejection can
 * carry anything.
 */
const execFailureSchema = z
  .object({
    // A spawn failure puts an errno string here; a non-zero exit puts the exit code.
    code: z.union([z.string(), z.number()]).optional(),
    killed: z.boolean().optional(),
    stderr: z.string().optional(),
  })
  .catch({});

function firstLine(value: string): string {
  const newline = value.indexOf("\n");
  const line = (newline === -1 ? value : value.slice(0, newline)).trim();
  return line.length > REASON_MAX_CHARS ? `${line.slice(0, REASON_MAX_CHARS)}...` : line;
}

/** Spawns `claude` directly, never through a shell, with stdin closed. */
export const runClaudeCli: ProcessRunner = async (args, { timeoutMs }) => {
  // Claude Code refuses to start when it thinks it is nested inside another session, so the
  // markers that say so are dropped from the child's environment.
  const env = { ...process.env };
  for (const marker of ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"]) {
    delete env[marker];
  }

  try {
    const pending = execFileAsync("claude", [...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return { ok: true, stdout };
  } catch (err) {
    const failure = execFailureSchema.parse(err);
    if (failure.code === "ENOENT") {
      return { ok: false, kind: "missing", message: "`claude` was not found on PATH" };
    }
    if (failure.killed) {
      return {
        ok: false,
        kind: "timeout",
        message: `\`claude\` did not answer within ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    return { ok: false, kind: "failed", message: firstLine(failure.stderr?.trim() || String(err)) };
  }
};

// --- Schema ---

/** Control characters would break the markdown heading a channel name is rendered into. */
function singleLine(value: string): string {
  let out = "";
  for (const char of value) {
    out += char.charCodeAt(0) < 0x20 ? " " : char;
  }
  return out.trim();
}

const isoTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "not a timestamp")
  // Normalized to UTC so week membership and rendering do not depend on how the model wrote it.
  .transform((value) => new Date(value).toISOString());

const slackMessageSchema = z.object({
  permalink: z.url(),
  channel: z.string().min(1).transform(singleLine),
  at: isoTimestamp,
  text: z.string(),
  threadRoot: z.url().optional(),
  isReply: z.boolean(),
});

const slackResponseSchema = z.object({ messages: z.array(slackMessageSchema) });

export type SlackMessage = z.infer<typeof slackMessageSchema>;

/**
 * Recover typed messages from `unknown` payloads (a batch's snapshots, or rows read back out of
 * the ledger), dropping anything that no longer matches the schema.
 */
export function slackMessagesFrom(payloads: readonly unknown[]): SlackMessage[] {
  const messages: SlackMessage[] = [];
  for (const payload of payloads) {
    const parsed = slackMessageSchema.safeParse(payload);
    if (parsed.success) messages.push(parsed.data);
  }
  return messages;
}

// --- Prompt ---

function windowInstruction(start: Date, end: Date): string {
  return `Find messages sent between ${start.toISOString()} and ${end.toISOString()} (inclusive, UTC).`;
}

function sinceInstruction(since: Date): string {
  return `Find messages sent at or after ${since.toISOString()} (UTC), most recent first.`;
}

function buildPrompt(instruction: string, config: WorklogConfig, retry: boolean): string {
  const { fullName, displayName } = config.profile;
  const lines = [
    `Use only the ${GLEAN_MCP_SERVER} MCP tools. Glean is the permission-aware index over Slack.`,
    "Do not use bash, file or browser tools.",
    "",
    `Find Slack messages written by ${fullName} (Slack display name "${displayName}").`,
    instruction,
    "Include messages in public channels and replies that person wrote in public channel threads.",
    "Exclude direct messages, group DMs and private channels. Exclude messages written by anyone else.",
    `Return at most ${MAX_MESSAGES} messages. Keep each message's own timestamp exactly as Slack recorded it.`,
    "",
    "Reply with a single JSON object and nothing else: no prose, no markdown code fence.",
    "Shape:",
    '{"messages":[{"permalink":"https://...","channel":"channel-name","at":"2026-03-02T09:14:00Z","text":"...","threadRoot":"https://...","isReply":false}]}',
    '"at" is an ISO 8601 timestamp. "channel" has no leading "#". "threadRoot" is the permalink of the thread\'s first message and is left out when the message is not in a thread. "isReply" is true when the message replies inside a thread.',
    'If nothing matches, reply with {"messages":[]}.',
  ];
  if (retry) {
    lines.push(
      "",
      "Your previous reply could not be parsed as that JSON object. Reply with the JSON object only: no explanation, no code fence, no text before or after it.",
    );
  }
  return lines.join("\n");
}

function claudeArgs(prompt: string): string[] {
  return [
    "--print",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    GLEAN_TOOLS,
    "--output-format",
    "text",
    prompt,
  ];
}

// --- Parsing ---

/**
 * Pull the JSON object out of a model reply that may still carry a fence or a stray sentence.
 * Scanning for the outer braces stays linear; a regex over model output is what CodeQL flags.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? null : text.slice(start, end + 1);
}

function parseMessages(stdout: string): SlackMessage[] | null {
  const json = extractJsonObject(stdout);
  if (json === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = slackResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data.messages : null;
}

// --- Batch assembly ---

/** A degraded fetch: no material for the week, and a line saying why. */
function emptyBatch(warning: string): SourceBatch {
  return { snapshots: [], events: [], warnings: [warning] };
}

function toBatch(messages: SlackMessage[], warnings: string[]): SourceBatch {
  const snapshots: SourceSnapshot[] = [];
  const events: SourceEvent[] = [];

  for (const message of messages) {
    snapshots.push({ id: message.permalink, firstSeenAt: message.at, payload: message });
    events.push({
      source: SLACK_SOURCE_NAME,
      kind: message.isReply ? "reply" : "message",
      itemId: message.permalink,
      at: message.at,
      payload: message,
    });
  }

  return { snapshots, events, warnings };
}

interface Selection {
  kept: SlackMessage[];
  outOfRange: number;
}

/**
 * The model can repeat a message, answer outside the range it was given, or overrun the cap.
 * Trim on our side rather than trusting the reply, so a week only ever holds its own events.
 */
function select(
  messages: SlackMessage[],
  inRange: (message: SlackMessage) => boolean,
  known: ReadonlySet<string>,
): Selection {
  const byPermalink = new Map<string, SlackMessage>();
  let outOfRange = 0;

  for (const message of messages) {
    if (!inRange(message)) {
      outOfRange++;
      continue;
    }
    if (known.has(message.permalink)) continue;
    if (!byPermalink.has(message.permalink)) byPermalink.set(message.permalink, message);
  }

  return { kept: [...byPermalink.values()].slice(0, MAX_MESSAGES), outOfRange };
}

// --- Source ---

export function createSlackSource(runner: ProcessRunner = runClaudeCli): Source {
  async function ask(
    instruction: string,
    ctx: SourceContext,
    inRange: (message: SlackMessage) => boolean,
    known: ReadonlySet<string> = new Set(),
  ): Promise<SourceBatch> {
    for (const retry of [false, true]) {
      const prompt = buildPrompt(instruction, ctx.config, retry);
      ctx.log?.(`slack: asking Glean via claude (retry=${retry})`);

      const result = await runner(claudeArgs(prompt), { timeoutMs: FETCH_TIMEOUT_MS });
      if (!result.ok) {
        return emptyBatch(`Slack fetch failed, this week has no Slack material: ${result.message}`);
      }

      const messages = parseMessages(result.stdout);
      if (messages === null) continue;

      const { kept, outOfRange } = select(messages, inRange, known);
      const warnings =
        outOfRange > 0
          ? [`Slack returned ${outOfRange} message(s) outside the requested range; they were ignored.`]
          : [];
      ctx.log?.(`slack: ${kept.length} message(s) kept, ${outOfRange} outside the range`);
      return toBatch(kept, warnings);
    }

    return emptyBatch(
      "Slack fetch returned no usable JSON after a retry, this week has no Slack material.",
    );
  }

  return {
    name: SLACK_SOURCE_NAME,

    async isAvailable(_ctx: SourceContext): Promise<SourceAvailability> {
      const result = await runner(["mcp", "get", GLEAN_MCP_SERVER], {
        timeoutMs: AVAILABILITY_TIMEOUT_MS,
      });

      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.kind === "missing"
              ? "the Claude Code CLI (`claude`) is not on PATH"
              : `could not query the ${GLEAN_MCP_SERVER} MCP server: ${result.message}`,
        };
      }

      if (!result.stdout.includes("Connected")) {
        return {
          ok: false,
          reason: `the ${GLEAN_MCP_SERVER} MCP server is not connected (run \`claude mcp login ${GLEAN_MCP_SERVER}\`)`,
        };
      }

      return { ok: true };
    },

    fetchWindow(window, ctx) {
      const start = window.start.getTime();
      const end = window.end.getTime();
      return ask(windowInstruction(window.start, window.end), ctx, (message) => {
        const at = Date.parse(message.at);
        return at >= start && at <= end;
      });
    },

    fetchSince(since, itemIds, ctx) {
      // A Slack message never changes, so a permalink already in the ledger has nothing new
      // to add. Dropping known ids here keeps the delta to genuinely new messages.
      const from = since.getTime();
      return ask(
        sinceInstruction(since),
        ctx,
        (message) => Date.parse(message.at) >= from,
        new Set(itemIds),
      );
    },
  };
}

export const slackSource: Source = createSlackSource();
