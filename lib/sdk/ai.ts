import { streamText, stepCountIs } from "ai";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { resolveOpenAIAuth, refreshCodexToken, type OpenAIAuthResolution } from "../openai-auth";
import { buildResearchTools } from "../ai-tools";
import type { WorklogConfig } from "./types";
import type { Logger } from "./logger";

export interface AIQueryOptions {
  prompt: string;
  model?: string;
  config: WorklogConfig;
  log?: Logger;
}

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
    raw = await queryAnthropic(prompt);
  } else {
    log(`Querying OpenAI via Vercel AI SDK (model: ${model || "gpt-5"})...`);
    raw = await queryOpenAI(config, model, prompt);
  }

  log(`Raw AI response: ${raw.length} chars`);
  return postProcess(raw);
}

async function queryAnthropic(prompt: string): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let result = "";
  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: ["Bash", "Read", "Glob", "Grep"],
        maxTurns: 6,
        cwd: process.cwd(),
      },
    })) {
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
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
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

  return result;
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

async function queryOpenAI(config: WorklogConfig, modelOverride: string | undefined, prompt: string): Promise<string> {
  const auth = resolveOpenAIAuthOrThrow();
  const model = modelOverride || "gpt-5";

  let openaiProvider: OpenAIProvider;
  if (auth.source === "codex-subscription") {
    const freshToken = (await refreshCodexToken()) ?? auth.apiKey;
    openaiProvider = createOpenAI({
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: freshToken,
      headers: auth.accountId
        ? { "ChatGPT-Account-Id": auth.accountId }
        : {},
    });
  } else {
    openaiProvider = createOpenAI({ apiKey: auth.apiKey });
  }

  const result = streamText({
    model: openaiProvider.responses(model),
    prompt,
    tools: buildResearchTools(config),
    stopWhen: stepCountIs(6),
    providerOptions: {
      openai: {
        instructions:
          "You are a helpful assistant. Follow the user's instructions precisely.",
        store: false,
      },
    },
  });

  return await result.text;
}

/** Strip AI preamble and code block wrapping from raw model output. */
export function postProcess(raw: string): string {
  let result = raw;

  // Strip preamble — model sometimes outputs thinking before the actual document
  const firstFrontmatter = result.indexOf("---");
  const firstCodeBlock = result.indexOf("```");
  const firstHeading = result.indexOf("# ");
  const candidates = [firstFrontmatter, firstCodeBlock, firstHeading].filter(
    (i) => i > 0
  );
  if (candidates.length > 0) {
    const startIdx = Math.min(...candidates);
    result = result.slice(startIdx);
  }

  // Strip code block wrapping
  result = result.replace(/^```(?:markdown)?\n([\s\S]*?)\n```\s*$/, "$1");

  return result;
}
