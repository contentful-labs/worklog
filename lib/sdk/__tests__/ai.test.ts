import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, query: vi.fn() };
});

vi.mock("../../openai-auth", () => ({
  resolveOpenAIAuth: vi.fn(),
  refreshCodexToken: vi.fn(),
}));

import { streamText } from "ai";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveOpenAIAuth, refreshCodexToken } from "../../openai-auth";
import { aiQuery, aiQueryStructured, postProcess, toAnthropicJsonSchema, type AIUsage } from "../ai";
import type { WorklogConfig } from "../types";

const mockedStreamText = vi.mocked(streamText);
const mockedQuery = vi.mocked(query);
const mockedResolveAuth = vi.mocked(resolveOpenAIAuth);
const mockedRefreshToken = vi.mocked(refreshCodexToken);


const schema = z.object({
  headline: z.string().describe("One line."),
  items: z.array(z.string()),
});

function configFor(provider: "openai" | "anthropic"): WorklogConfig {
  // SAFETY: aiQueryStructured reads config.ai and hands the rest to the research tools,
  // which are never invoked here. Building the whole config would only add noise.
  return { ai: { provider }, atlassian: { url: "https://example.atlassian.net", email: "user@example.com" } } as WorklogConfig;
}

/** Minimal stand-in for the Agent SDK's async iterable of messages. */
function messageStream(messages: unknown[]) {
  const stream = (async function* () {
    for (const message of messages) yield message;
  })();
  // SAFETY: the code under test only reads `type`, `subtype`, `usage`, `num_turns` and
  // `structured_output`, all of which anthropicResult supplies.
  return stream as ReturnType<typeof query>;
}

function anthropicResult(
  overrides: {
    subtype?: string;
    structured_output?: unknown;
    result?: string;
    num_turns?: number;
    usage?: Record<string, number>;
    total_cost_usd?: number;
    modelUsage?: Record<string, { outputTokens?: number }>;
  } = {},
) {
  return {
    type: "result",
    subtype: "success",
    num_turns: 1,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 },
    total_cost_usd: 0,
    modelUsage: {},
    ...overrides,
  };
}

/**
 * What a provider result says about tokens, with every field optional.
 *
 * The SDK's own LanguageModelUsage has these as `number | undefined` inside a required
 * details object; a case that only cares about two of them should not have to spell out
 * the rest, and one case deliberately omits them all.
 */
interface FakeUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** What the SDK reports when nothing asked about tokens. */
const NO_USAGE: FakeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

/** One recorded step, as streamText exposes it on `result.steps`. */
function fakeStep(usage: FakeUsage) {
  return { usage: { inputTokenDetails: {}, ...usage } };
}

/** streamText is mocked, so a stand-in only needs the fields the query functions await. */
function fakeStreamResult(fields: Record<string, Promise<unknown>>) {
  // SAFETY: those fields are `text` or `output`, plus `totalUsage` and `steps` when the
  // caller passed onUsage. The other thirty-odd fields of the real result are never
  // touched, and implementing them faithfully would be a worse test than this assertion.
  return fields as unknown as ReturnType<typeof streamText>;
}

/** Whatever the provider handed back, before anything validated it. */
type ProviderOutput = Record<string, unknown>;

function streamTextResult(output: ProviderOutput, steps: FakeUsage[] = [NO_USAGE]) {
  return fakeStreamResult({ output: Promise.resolve(output), steps: Promise.resolve(steps.map(fakeStep)) });
}

/** The text-only counterpart, for the aiQuery path. */
function streamTextText(text: string, steps: FakeUsage[] = [NO_USAGE]) {
  return fakeStreamResult({ text: Promise.resolve(text), steps: Promise.resolve(steps.map(fakeStep)) });
}

/**
 * The step count at which a recorded call's stopWhen halts the tool loop.
 *
 * `stepCountIs(n)` fires when `steps.length === n`, so this is the first n at which the
 * loop would stop. Driving a real seven-step loop would need a fake LanguageModelV3; the
 * budget itself is what was wrong, and this reads it directly.
 */
async function stopsAtStep(call: Parameters<typeof streamText>[0]): Promise<number> {
  const conditions = call.stopWhen === undefined ? [] : [call.stopWhen].flat();
  if (conditions.length !== 1) throw new Error(`expected one stop condition, got ${conditions.length}`);
  const condition = conditions[0];

  for (let n = 1; n <= 20; n++) {
    // SAFETY: stepCountIs reads steps.length and never touches an element, so the
    // array only has to be the right length.
    const steps = Array.from({ length: n }) as Parameters<typeof condition>[0]["steps"];
    if (await condition({ steps })) return n;
  }
  throw new Error("stop condition never fired within 20 steps");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveAuth.mockReturnValue({ apiKey: "test-key", source: "env" });
  mockedRefreshToken.mockResolvedValue(null);
});

describe("toAnthropicJsonSchema", () => {
  it("emits draft-7 with no $schema marker, because ajv rejects newer dialects", () => {
    const jsonSchema = toAnthropicJsonSchema(schema);
    expect(jsonSchema.$schema).toBeUndefined();
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.required).toEqual(["headline", "items"]);
  });

  it("carries field descriptions through, since they are the model's instructions", () => {
    expect(toAnthropicJsonSchema(schema).properties).toMatchObject({ headline: { description: "One line." } });
  });
});

describe("aiQueryStructured on the OpenAI path", () => {
  it("asks for the schema alongside the research tools and returns the parsed object", async () => {
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: ["a"] }));

    const result = await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema, schemaName: "test_output" });

    expect(result).toEqual({ headline: "hi", items: ["a"] });
    const call = mockedStreamText.mock.calls[0][0];
    const responseFormat = await call.output!.responseFormat;
    expect(responseFormat).toMatchObject({ type: "json", name: "test_output" });
    expect(Object.keys(call.tools ?? {})).toContain("fetchJiraTicket");
  });

  it("rejects an object that does not satisfy the schema", async () => {
    mockedStreamText.mockReturnValue(streamTextResult({ headline: 42 }));

    await expect(aiQueryStructured({ prompt: "go", config: configFor("openai"), schema })).rejects.toThrow();
  });
});

describe("usage reporting", () => {
  const firstStep: FakeUsage = {
    inputTokens: 1200,
    outputTokens: 340,
    inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 1000, cacheWriteTokens: 0 },
  };

  it("reports each request separately, and the totals across them", async () => {
    const secondStep: FakeUsage = {
      inputTokens: 800,
      outputTokens: 60,
      inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: [] }, [firstStep, secondStep]));
    const seen: AIUsage[] = [];

    await aiQueryStructured({
      prompt: "go",
      config: configFor("openai"),
      schema,
      model: "gpt-5",
      onUsage: (u) => seen.push(u),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      model: "gpt-5",
      inputTokens: 2000,
      outputTokens: 400,
      cachedInputTokens: 1000,
      cacheWriteTokens: 0,
    });
    // Per request, because the long-context rate is decided per request.
    expect(seen[0].steps).toEqual([
      { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 1000, cacheWriteTokens: 0 },
      { inputTokens: 800, outputTokens: 60, cachedInputTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("carries an OpenAI cache-write count through when the adapter reports one", async () => {
    const withWrite: FakeUsage = {
      inputTokens: 1000,
      outputTokens: 10,
      inputTokenDetails: { noCacheTokens: 400, cacheReadTokens: 200, cacheWriteTokens: 400 },
    };
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: [] }, [withWrite]));
    const seen: AIUsage[] = [];

    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema, onUsage: (u) => seen.push(u) });

    expect(seen[0].cacheWriteTokens).toBe(400);
  });

  it("counts an unreported cache write as ordinary input rather than dropping the week", async () => {
    // What the installed adapter actually does: cacheWriteTokens is undefined, and those
    // tokens stay inside inputTokens. pricing.ts documents the undercount that causes.
    const noWriteField: FakeUsage = {
      inputTokens: 1000,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 200 },
    };
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: [] }, [noWriteField]));
    const seen: AIUsage[] = [];

    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema, onUsage: (u) => seen.push(u) });

    expect(seen[0]).toMatchObject({ inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 0 });
  });

  it("reports the resolved default when no model was asked for", async () => {
    mockedResolveAuth.mockReturnValue({ apiKey: "tok", source: "codex-subscription", accountId: "acct" });
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: [] }, [firstStep]));
    const seen: AIUsage[] = [];

    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema, onUsage: (u) => seen.push(u) });

    expect(seen[0].model).toBe("gpt-5.6-sol");
  });

  it("reports usage on the text path too", async () => {
    mockedStreamText.mockReturnValue(streamTextText("# Done", [firstStep, firstStep]));
    const seen: AIUsage[] = [];

    await aiQuery({ prompt: "go", config: configFor("openai"), onUsage: (u) => seen.push(u) });

    expect(seen[0]).toMatchObject({ inputTokens: 2400, outputTokens: 680 });
    expect(seen[0].steps).toHaveLength(2);
  });

  it("does not ask the provider for usage when nobody wants it", async () => {
    // The point is that a provider result without usage fields still works for callers
    // that never passed onUsage.
    mockedStreamText.mockReturnValue(fakeStreamResult({ output: Promise.resolve({ headline: "hi", items: [] }) }));

    await expect(aiQueryStructured({ prompt: "go", config: configFor("openai"), schema })).resolves.toEqual({
      headline: "hi",
      items: [],
    });
  });

  it("treats missing token counts as zero rather than failing the week", async () => {
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: [] }, [{}]));
    const seen: AIUsage[] = [];

    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema, onUsage: (u) => seen.push(u) });

    expect(seen[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("OpenAI step budget", () => {
  it("leaves a step for the object after six tool rounds", async () => {
    // The object arrives in a step of its own. Six research rounds are what the prompt
    // asks for, so stopping at six would end the query having produced nothing.
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: [] }));

    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema });

    expect(await stopsAtStep(mockedStreamText.mock.calls[0][0])).toBe(7);
  });

  it("gives a text query the plain budget, because it has no extra step", async () => {
    mockedStreamText.mockReturnValue(streamTextText("# Done"));

    await aiQuery({ prompt: "go", config: configFor("openai") });

    expect(await stopsAtStep(mockedStreamText.mock.calls[0][0])).toBe(6);
  });
});

describe("OpenAI default model", () => {
  beforeEach(() => {
    mockedStreamText.mockReturnValue(streamTextResult({ headline: "hi", items: [] }));
  });

  it("uses a Codex-served model on a ChatGPT subscription", async () => {
    mockedResolveAuth.mockReturnValue({ apiKey: "tok", source: "codex-subscription", accountId: "acct" });

    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema });

    expect(mockedStreamText.mock.calls[0][0].model).toMatchObject({ modelId: "gpt-5.6-sol" });
  });

  it("uses gpt-5 on an API key", async () => {
    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema });

    expect(mockedStreamText.mock.calls[0][0].model).toMatchObject({ modelId: "gpt-5" });
  });

  it("lets an explicit model win over both defaults", async () => {
    mockedResolveAuth.mockReturnValue({ apiKey: "tok", source: "codex-subscription", accountId: "acct" });

    await aiQueryStructured({ prompt: "go", config: configFor("openai"), schema, model: "gpt-5-mini" });

    expect(mockedStreamText.mock.calls[0][0].model).toMatchObject({ modelId: "gpt-5-mini" });
  });
});

describe("aiQueryStructured on the Anthropic path", () => {
  it("passes a json_schema output format and returns the structured result", async () => {
    mockedQuery.mockReturnValue(
      messageStream([anthropicResult({ structured_output: { headline: "hi", items: [] } })]),
    );

    const result = await aiQueryStructured({ prompt: "go", config: configFor("anthropic"), schema });

    expect(result).toEqual({ headline: "hi", items: [] });
    const options = mockedQuery.mock.calls[0][0].options!;
    expect(options.outputFormat?.type).toBe("json_schema");
    expect(options.outputFormat?.schema.$schema).toBeUndefined();
    expect(options.allowedTools).toContain("mcp__worklog__fetchJiraTicket");
  });

  it("fails loudly when the run ends without a structured result", async () => {
    mockedQuery.mockReturnValue(messageStream([anthropicResult({ subtype: "error_max_structured_output_retries" })]));

    await expect(aiQueryStructured({ prompt: "go", config: configFor("anthropic"), schema })).rejects.toThrow(
      "error_max_structured_output_retries",
    );
  });

  it("fails loudly when a successful run carries no structured output", async () => {
    mockedQuery.mockReturnValue(messageStream([anthropicResult({ result: "some prose instead" })]));

    await expect(aiQueryStructured({ prompt: "go", config: configFor("anthropic"), schema })).rejects.toThrow(
      "no structured output",
    );
  });

  it("reports usage from the run's own totals, cache included", async () => {
    mockedQuery.mockReturnValue(
      messageStream([
        anthropicResult({
          structured_output: { headline: "hi", items: [] },
          num_turns: 4,
          usage: { input_tokens: 5, cache_creation_input_tokens: 2000, cache_read_input_tokens: 18000, output_tokens: 900 },
          total_cost_usd: 0.42,
          modelUsage: { "claude-opus-5": {}, "claude-haiku-4-5": {} },
        }),
      ]),
    );
    const seen: AIUsage[] = [];

    await aiQueryStructured({ prompt: "go", config: configFor("anthropic"), schema, onUsage: (u) => seen.push(u) });

    // Fresh, cache-write and cache-read tokens are all input the run paid for, and the
    // cache-write share is kept apart because it is billed at its own rate.
    const expected = {
      inputTokens: 20005,
      outputTokens: 900,
      cachedInputTokens: 18000,
      cacheWriteTokens: 2000,
    };
    expect(seen).toEqual([
      {
        model: "claude-opus-5",
        ...expected,
        // The SDK reports run totals rather than per-turn usage, so the run is one entry.
        steps: [expected],
        reportedCostUsd: 0.42,
      },
    ]);
  });

  it("prefers the SDK's own cost over the local price table", async () => {
    mockedQuery.mockReturnValue(
      messageStream([
        anthropicResult({
          structured_output: { headline: "hi", items: [] },
          usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
          total_cost_usd: 1.23,
          modelUsage: { "claude-opus-5": {} },
        }),
      ]),
    );
    const seen: AIUsage[] = [];

    await aiQueryStructured({ prompt: "go", config: configFor("anthropic"), schema, onUsage: (u) => seen.push(u) });

    expect(seen[0].reportedCostUsd).toBe(1.23);
  });

  it("rejects a structured result that does not satisfy the schema", async () => {
    mockedQuery.mockReturnValue(messageStream([anthropicResult({ structured_output: { headline: "hi" } })]));

    await expect(aiQueryStructured({ prompt: "go", config: configFor("anthropic"), schema })).rejects.toThrow();
  });
});

describe("postProcess", () => {
  it("returns plain text as-is", () => {
    expect(postProcess("Hello world")).toBe("Hello world");
  });

  it("strips preamble before frontmatter", () => {
    const input = "Here is the document:\n---\ntitle: My Doc\n---\nContent";
    expect(postProcess(input)).toBe("---\ntitle: My Doc\n---\nContent");
  });

  it("strips preamble before heading", () => {
    const input = "Sure, here you go:\n# Weekly Summary\nDid stuff";
    expect(postProcess(input)).toBe("# Weekly Summary\nDid stuff");
  });

  it("strips preamble before code block", () => {
    const input = "Here is the markdown:\n```markdown\n# Doc\nContent\n```";
    expect(postProcess(input)).toBe("# Doc\nContent");
  });

  it("unwraps code block wrapping when no preamble markers inside", () => {
    const input = "```markdown\nSome content here\n```";
    expect(postProcess(input)).toBe("Some content here");
  });

  it("keeps frontmatter that is already at the start", () => {
    const input = "---\ntags:\n  - areas/work\n---\n# Brag Book\nBody";
    expect(postProcess(input)).toBe(input);
  });

  it("picks earliest preamble marker", () => {
    const input = "Preamble text\n# Heading\nBody\n---\nFooter";
    expect(postProcess(input)).toBe("# Heading\nBody\n---\nFooter");
  });
});
