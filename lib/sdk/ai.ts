import { streamText, stepCountIs, Output, type OnStepFinishEvent } from "ai";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { z } from "zod";
import { resolveOpenAIAuth, refreshCodexToken, type OpenAIAuthResolution } from "../openai-auth";
import { buildResearchTools, buildResearchMcpServer, RESEARCH_MCP_SERVER_NAME, RESEARCH_MCP_TOOL_IDS } from "../ai-tools";
import type { WorklogConfig } from "./types";
import type { Logger } from "./logger";

export interface AIQueryOptions {
  prompt: string;
  model?: string;
  config: WorklogConfig;
  log?: Logger;
}

export interface StructuredQueryOptions<T> extends AIQueryOptions {
  schema: z.ZodType<T>;
  /** Passed to providers that show the schema name to the model. */
  schemaName?: string;
}

const OPENAI_INSTRUCTIONS = "You are a helpful assistant. Follow the user's instructions precisely.";

/** How many tool-calling rounds a query may take before the model has to answer. */
const MAX_STEPS = 6;

/**
 * Structured output is produced in a step of its own, after the last tool round. Budgeting
 * only MAX_STEPS lets six research rounds spend the whole allowance, leaving no step to
 * emit the object, and the query then fails having produced nothing. The prompt asks the
 * model to research proactively, so six rounds is a normal week rather than a pathological
 * one. Text queries have no such extra step and keep the plain budget.
 */
const MAX_STRUCTURED_STEPS = MAX_STEPS + 1;

type JsonSchema = z.core.JSONSchema.BaseSchema;

/**
 * AI query function parameterized by config.
 *
 * Anthropic → Claude Agent SDK
 * OpenAI → Vercel AI SDK + Responses API
 *
 * Returns the final text output with preamble stripped and code block unwrapped.
 */
export async function aiQuery(options: AIQueryOptions): Promise<string> {
  const { config, prompt, model: modelOverride, log = () => {} } = options;
  const provider = config.ai.provider ?? "openai";
  const model = modelOverride ?? config.ai.model;

  log(`AI provider: ${provider}, model: ${model ?? "default"}, auth: ${provider === "anthropic" ? "claude-agent-sdk" : resolveOpenAIAuth().source}`);

  let raw: string;
  if (provider === "anthropic") {
    log("Querying Anthropic via Claude Agent SDK...");
    raw = await queryAnthropic(config, model, prompt);
  } else {
    log(`Querying OpenAI via Vercel AI SDK (model: ${model || "gpt-5"})...`);
    raw = await queryOpenAI(config, model, prompt, log);
  }

  log(`Raw AI response: ${raw.length} chars`);
  return postProcess(raw);
}

/**
 * Ask the model for an object that satisfies `schema`, with the same research tools
 * aiQuery offers. The provider constrains generation to the schema, so nothing has to
 * be recovered from the text afterwards.
 */
export async function aiQueryStructured<T>(options: StructuredQueryOptions<T>): Promise<T> {
  const { config, prompt, schema, schemaName = "result", model: modelOverride, log = () => {} } = options;
  const provider = config.ai.provider ?? "openai";
  const model = modelOverride ?? config.ai.model;

  log(`AI provider: ${provider}, model: ${model ?? "default"}, structured output: ${schemaName}`);

  const raw = provider === "anthropic"
    ? await queryAnthropicStructured(config, model, prompt, schema, log)
    : await queryOpenAIStructured(config, model, prompt, schema, schemaName, log);

  return schema.parse(raw);
}

function anthropicSetupError(detail: string): Error {
  return new Error(
    `Anthropic query failed.\n\n` +
    `Set up authentication with one of:\n` +
    `  1. export ANTHROPIC_API_KEY="sk-ant-..."\n` +
    `     Get one at https://console.anthropic.com/settings/keys\n` +
    `  2. Install Claude Code CLI (piggybacks off your existing auth)\n` +
    `     claude /doctor to verify\n\n` +
    `To switch to OpenAI instead:\n` +
    `  worklog configure ai\n\n` +
    `Details: ${detail}`
  );
}

// Same six research tools as the OpenAI path, served in-process. No filesystem/shell
// tools: vault access goes through readVaultNote/searchVault.
function anthropicOptions(model: string | undefined, researchServer: Awaited<ReturnType<typeof buildResearchMcpServer>>) {
  return {
    model,
    mcpServers: { [RESEARCH_MCP_SERVER_NAME]: researchServer },
    allowedTools: RESEARCH_MCP_TOOL_IDS,
    maxTurns: MAX_STEPS,
    cwd: process.cwd(),
  };
}

async function queryAnthropic(config: WorklogConfig, model: string | undefined, prompt: string): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const researchServer = await buildResearchMcpServer(config);

  let result = "";
  try {
    for await (const message of query({ prompt, options: anthropicOptions(model, researchServer) })) {
      if (message.type === "assistant" && message.message?.content) {
        const hasToolUse = message.message.content.some(
          (b: { type: string }) => b.type === "tool_use"
        );
        if (!hasToolUse) {
          for (const block of message.message.content) {
            if ("text" in block) {
              result += block.text;
            }
          }
        }
      }
    }
  } catch (err) {
    throw anthropicSetupError(err instanceof Error ? err.message : String(err));
  }

  return result;
}

/**
 * The Claude Code CLI compiles the schema with ajv and offers it to the model as a
 * StructuredOutput tool. Compilation happens inside a try/catch that falls back to plain
 * prose, so a dialect ajv does not know silently costs you the structured result. Zod's
 * default 2020-12 `$schema` is one of those, hence draft-7 with the marker removed.
 */
export function toAnthropicJsonSchema(schema: z.ZodType<unknown>): JsonSchema {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  delete jsonSchema.$schema;
  return jsonSchema;
}

async function queryAnthropicStructured(
  config: WorklogConfig,
  model: string | undefined,
  prompt: string,
  schema: z.ZodType<unknown>,
  log: Logger,
): Promise<unknown> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const researchServer = await buildResearchMcpServer(config);
  const jsonSchema = toAnthropicJsonSchema(schema);

  let outcome: { subtype: string; structured: unknown } | null = null;
  try {
    for await (const message of query({
      prompt,
      options: { ...anthropicOptions(model, researchServer), outputFormat: { type: "json_schema", schema: jsonSchema } },
    })) {
      if (message.type !== "result") continue;
      const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = message.usage;
      log(`Anthropic result: ${message.subtype}, ${message.num_turns} turns, ${input_tokens} in (+${cache_creation_input_tokens} cache write, +${cache_read_input_tokens} cache read) / ${output_tokens} out`);
      outcome = {
        subtype: message.subtype,
        structured: message.subtype === "success" ? message.structured_output : undefined,
      };
    }
  } catch (err) {
    throw anthropicSetupError(err instanceof Error ? err.message : String(err));
  }

  if (!outcome) throw new Error("Anthropic returned no result message.");
  if (outcome.subtype !== "success") throw new Error(`Anthropic ended with ${outcome.subtype} instead of a structured result.`);
  if (outcome.structured === undefined) throw new Error("Anthropic reported success but returned no structured output.");
  return outcome.structured;
}

function resolveOpenAIAuthOrThrow(): Exclude<OpenAIAuthResolution, { source: "none" }> {
  const auth = resolveOpenAIAuth();
  if (auth.source === "none") {
    const details = auth.reason ? `\nDetails: ${auth.reason}` : "";
    throw new Error(
      `OpenAI credentials not found.\n\n` +
      `Option 1 — ChatGPT subscription (recommended):\n` +
      `  npx codex@latest login\n\n` +
      `Option 2 — API key:\n` +
      `  export OPENAI_API_KEY="sk-..."\n` +
      `  Get one at https://platform.openai.com/api-keys${details}`
    );
  }
  return auth;
}

type OpenAIAuthSource = Exclude<OpenAIAuthResolution, { source: "none" }>["source"];

/**
 * Default model per auth source. They differ because the Codex backend refuses `gpt-5`
 * for a ChatGPT account ("The 'gpt-5' model is not supported when using Codex with a
 * ChatGPT account", HTTP 400), while a plain API key has no Codex-served model. An
 * explicit config.ai.model always wins over both.
 */
const DEFAULT_OPENAI_MODEL = {
  "codex-subscription": "gpt-5.6-sol",
  env: "gpt-5",
} satisfies Record<OpenAIAuthSource, string>;

interface ConfiguredOpenAI {
  provider: OpenAIProvider;
  defaultModel: string;
}

async function createConfiguredOpenAI(): Promise<ConfiguredOpenAI> {
  const auth = resolveOpenAIAuthOrThrow();
  const defaultModel = DEFAULT_OPENAI_MODEL[auth.source];

  if (auth.source === "codex-subscription") {
    const freshToken = (await refreshCodexToken()) ?? auth.apiKey;
    return {
      defaultModel,
      provider: createOpenAI({
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: freshToken,
        headers: auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {},
      }),
    };
  }
  return { defaultModel, provider: createOpenAI({ apiKey: auth.apiKey }) };
}

type ResearchTools = ReturnType<typeof buildResearchTools>;

function logOpenAIStep(log: Logger) {
  return (step: OnStepFinishEvent<ResearchTools>) => {
    for (const call of step.toolCalls) {
      log(`tool call: ${call.toolName}(${JSON.stringify(call.input).slice(0, 160)})`);
    }
    const { inputTokens = "?", outputTokens = "?", totalTokens = "?" } = step.usage;
    log(`step done: ${step.finishReason}, ${totalTokens} tokens (${inputTokens} in / ${outputTokens} out)`);
  };
}

async function queryOpenAI(config: WorklogConfig, modelOverride: string | undefined, prompt: string, log: Logger): Promise<string> {
  const { provider, defaultModel } = await createConfiguredOpenAI();

  const result = streamText({
    model: provider.responses(modelOverride || defaultModel),
    prompt,
    tools: buildResearchTools(config),
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: logOpenAIStep(log),
    providerOptions: { openai: { instructions: OPENAI_INSTRUCTIONS, store: false } },
  });

  return await result.text;
}

async function queryOpenAIStructured(
  config: WorklogConfig,
  modelOverride: string | undefined,
  prompt: string,
  schema: z.ZodType<unknown>,
  schemaName: string,
  log: Logger,
): Promise<unknown> {
  const { provider, defaultModel } = await createConfiguredOpenAI();

  const result = streamText({
    model: provider.responses(modelOverride || defaultModel),
    prompt,
    tools: buildResearchTools(config),
    stopWhen: stepCountIs(MAX_STRUCTURED_STEPS),
    output: Output.object({ schema, name: schemaName }),
    onStepFinish: logOpenAIStep(log),
    providerOptions: { openai: { instructions: OPENAI_INSTRUCTIONS, store: false } },
  });

  return await result.output;
}

/** Strip AI preamble and code block wrapping from raw model output. */
export function postProcess(raw: string): string {
  let result = raw;

  // Strip preamble — model sometimes outputs thinking before the actual document
  const firstFrontmatter = result.indexOf("---");
  const firstCodeBlock = result.indexOf("```");
  const firstHeading = result.indexOf("# ");
  // Index 0 counts: frontmatter at the very start must win over a later heading,
  // otherwise the frontmatter gets sliced off.
  const candidates = [firstFrontmatter, firstCodeBlock, firstHeading].filter(
    (i) => i >= 0
  );
  if (candidates.length > 0) {
    const startIdx = Math.min(...candidates);
    result = result.slice(startIdx);
  }

  // Strip code block wrapping
  result = result.replace(/^```(?:markdown)?\n([\s\S]*?)\n```\s*$/, "$1");

  return result;
}
