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
import { aiQueryStructured, postProcess, toAnthropicJsonSchema } from "../ai";
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

function anthropicResult(overrides: { subtype?: string; structured_output?: unknown; result?: string }) {
  return {
    type: "result",
    subtype: "success",
    num_turns: 1,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 },
    ...overrides,
  };
}

/** streamText is mocked, so only the fields aiQueryStructured awaits have to exist. */
function streamTextResult(output: unknown) {
  // SAFETY: queryOpenAIStructured awaits `result.output` and nothing else.
  return { output: Promise.resolve(output) } as unknown as ReturnType<typeof streamText>;
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
