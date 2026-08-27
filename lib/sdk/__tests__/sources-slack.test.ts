import { describe, it, expect } from "vitest";
import {
  createSlackSource,
  slackMessagesFrom,
  type ProcessRunner,
  type RunResult,
  type SlackMessage,
} from "../sources/slack";
import type { SourceContext } from "../sources";
import type { WorklogConfig } from "../types";

const config: WorklogConfig = {
  version: 1,
  vault: "/tmp/test",
  atlassian: { url: "https://test.atlassian.net", email: "user@example.com" },
  githubOrgs: ["test-org"],
  ai: { provider: "openai" },
  profile: {
    fullName: "Test User", displayName: "testuser", jobTitle: "Engineer",
    level: "IC5", company: "TestCo", location: "Remote", startDate: "2024-01-01",
    domain: "platform", team: "Core", teamDomain: "infra", ticketPrefixes: ["TEAM"],
  },
  career: { framework: "test", currentLevel: "IC5", targetLevel: "IC6", companyValues: [], reviewCycleDates: [], skills: [], growthAreas: [], careerDocPaths: [] },
  coaching: { tone: "direct", focusAreas: [] },
};

const ctx: SourceContext = { config };

const WINDOW = {
  start: new Date("2026-03-02T00:00:00Z"),
  end: new Date("2026-03-08T23:59:59Z"),
};

function message(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    permalink: "https://example.slack.com/archives/C1/p1",
    channel: "team-updates",
    at: "2026-03-03T09:14:00Z",
    text: "Picked the migration order.",
    isReply: false,
    ...overrides,
  };
}

/** Records the calls it was given and replays a queued result per call. */
function fakeRunner(results: RunResult[]): ProcessRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (args) => {
    calls.push([...args]);
    const next = results.shift();
    if (!next) throw new Error("fake runner ran out of queued results");
    return next;
  };
  return Object.assign(runner, { calls });
}

/** A well-formed reply from the model: the JSON object and nothing else. */
function json(messages: SlackMessage[]): RunResult {
  return { ok: true, stdout: JSON.stringify({ messages }) };
}

describe("slack source availability", () => {
  it("is available when the Glean MCP server reports Connected", async () => {
    const runner = fakeRunner([{ ok: true, stdout: "glean_default\n  Status: ✓ Connected\n" }]);
    const source = createSlackSource(runner);

    await expect(source.isAvailable(ctx)).resolves.toEqual({ ok: true });
    expect(runner.calls[0]).toEqual(["mcp", "get", "glean_default"]);
  });

  it("is unavailable when the MCP server is not connected", async () => {
    const source = createSlackSource(fakeRunner([{ ok: true, stdout: "glean_default\n  Status: ✗ Failed\n" }]));
    const result = await source.isAvailable(ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not connected");
  });

  it("is unavailable when claude is not on PATH", async () => {
    const source = createSlackSource(fakeRunner([{ ok: false, kind: "missing", message: "`claude` was not found on PATH" }]));
    const result = await source.isAvailable(ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("PATH");
  });

  it("is unavailable, not throwing, when the availability check fails", async () => {
    const source = createSlackSource(fakeRunner([{ ok: false, kind: "failed", message: "No MCP server found" }]));
    const result = await source.isAvailable(ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("No MCP server found");
  });
});

describe("slack source fetchWindow", () => {
  it("parses messages into snapshots and events", async () => {
    const runner = fakeRunner([
      json([message(), message({ permalink: "https://example.slack.com/archives/C1/p2", at: "2026-03-04T10:00:00Z", isReply: true, threadRoot: "https://example.slack.com/archives/C1/p1" })]),
    ]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(batch.warnings).toEqual([]);
    expect(batch.snapshots.map((s) => s.id)).toEqual([
      "https://example.slack.com/archives/C1/p1",
      "https://example.slack.com/archives/C1/p2",
    ]);
    expect(batch.events.map((e) => e.kind)).toEqual(["message", "reply"]);
    expect(batch.events[0]).toMatchObject({
      source: "slack",
      itemId: "https://example.slack.com/archives/C1/p1",
      at: "2026-03-03T09:14:00.000Z",
    });
  });

  it("spawns claude with only the Glean tools allowed and asks for JSON", async () => {
    const runner = fakeRunner([json([])]);
    await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    const args = runner.calls[0];
    expect(args).toContain("--print");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "mcp__glean_default__search,mcp__glean_default__chat,mcp__glean_default__read_document",
    );
    expect(args[args.indexOf("--output-format") + 1]).toBe("text");

    const prompt = args[args.length - 1];
    expect(prompt).toContain(config.profile.fullName);
    expect(prompt).toContain(config.profile.displayName);
    expect(prompt).toContain("at most 60 messages");
    expect(prompt).toContain("Exclude direct messages");
    expect(prompt).toContain(WINDOW.start.toISOString());
  });

  it("reads JSON out of a fenced reply with surrounding prose", async () => {
    const runner = fakeRunner([
      { ok: true, stdout: "Here is what I found:\n```json\n" + JSON.stringify({ messages: [message()] }) + "\n```\nHope that helps." },
    ]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(batch.events).toHaveLength(1);
    expect(batch.warnings).toEqual([]);
  });

  it("retries once with a stricter instruction when the reply is not JSON", async () => {
    const runner = fakeRunner([
      { ok: true, stdout: "I could not find anything useful, sorry." },
      json([message()]),
    ]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0][runner.calls[0].length - 1]).not.toContain("could not be parsed");
    expect(runner.calls[1][runner.calls[1].length - 1]).toContain("could not be parsed");
    expect(batch.events).toHaveLength(1);
    expect(batch.warnings).toEqual([]);
  });

  it("returns an empty batch with a warning after the retry also fails", async () => {
    const runner = fakeRunner([
      { ok: true, stdout: "no json here" },
      { ok: true, stdout: "still no json" },
    ]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(runner.calls).toHaveLength(2);
    expect(batch.snapshots).toEqual([]);
    expect(batch.events).toEqual([]);
    expect(batch.warnings).toHaveLength(1);
    expect(batch.warnings[0]).toContain("no usable JSON");
  });

  it("retries when the JSON parses but does not match the schema", async () => {
    const runner = fakeRunner([
      { ok: true, stdout: JSON.stringify({ messages: [{ permalink: "not-a-url", channel: "team-updates", at: "2026-03-03T09:14:00Z", text: "x", isReply: false }] }) },
      json([message()]),
    ]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(runner.calls).toHaveLength(2);
    expect(batch.events).toHaveLength(1);
  });

  it("returns an empty batch with a warning when claude times out", async () => {
    const runner = fakeRunner([{ ok: false, kind: "timeout", message: "`claude` did not answer within 120s" }]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(runner.calls).toHaveLength(1);
    expect(batch.events).toEqual([]);
    expect(batch.warnings[0]).toContain("did not answer within 120s");
  });

  it("returns an empty batch with a warning when claude exits non-zero", async () => {
    const runner = fakeRunner([{ ok: false, kind: "failed", message: "Invalid API key" }]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(runner.calls).toHaveLength(1);
    expect(batch.events).toEqual([]);
    expect(batch.warnings[0]).toContain("Invalid API key");
  });

  it("drops messages outside the window and says how many", async () => {
    const runner = fakeRunner([
      json([message(), message({ permalink: "https://example.slack.com/archives/C1/p9", at: "2026-02-20T09:00:00Z" })]),
    ]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(batch.events).toHaveLength(1);
    expect(batch.warnings[0]).toContain("1 message(s) outside the requested range");
  });

  it("deduplicates repeated permalinks and caps the week at 60 messages", async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      message({ permalink: `https://example.slack.com/archives/C1/p${i}` }),
    );
    const runner = fakeRunner([json([...many, message()])]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(batch.events).toHaveLength(60);
    expect(new Set(batch.events.map((e) => e.itemId)).size).toBe(60);
  });

  it("normalizes timestamps to UTC so week membership does not depend on wording", async () => {
    const runner = fakeRunner([json([message({ at: "2026-03-03T10:14:00+01:00" })])]);
    const batch = await createSlackSource(runner).fetchWindow(WINDOW, ctx);

    expect(batch.events[0].at).toBe("2026-03-03T09:14:00.000Z");
  });
});

describe("slack source fetchSince", () => {
  it("bounds the query by the watermark and drops older messages", async () => {
    const runner = fakeRunner([
      json([message({ at: "2026-03-05T09:00:00Z" }), message({ permalink: "https://example.slack.com/archives/C1/p8", at: "2026-03-01T09:00:00Z" })]),
    ]);
    const since = new Date("2026-03-04T00:00:00Z");
    const batch = await createSlackSource(runner).fetchSince(since, [], ctx);

    expect(runner.calls[0][runner.calls[0].length - 1]).toContain(since.toISOString());
    expect(batch.events).toHaveLength(1);
    expect(batch.warnings[0]).toContain("1 message(s) outside the requested range");
  });

  it("skips permalinks already in the ledger without calling them out of range", async () => {
    const known = "https://example.slack.com/archives/C1/p1";
    const runner = fakeRunner([
      json([message(), message({ permalink: "https://example.slack.com/archives/C1/p2" })]),
    ]);
    const batch = await createSlackSource(runner).fetchSince(new Date("2026-03-01T00:00:00Z"), [known], ctx);

    expect(batch.events.map((e) => e.itemId)).toEqual(["https://example.slack.com/archives/C1/p2"]);
    expect(batch.warnings).toEqual([]);
  });
});

describe("slackMessagesFrom", () => {
  it("keeps recognised payloads and drops the rest", () => {
    expect(slackMessagesFrom([message(), { nope: true }, null])).toHaveLength(1);
  });
});
