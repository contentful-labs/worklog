import { streamText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig } from "./config";
import { resolveOpenAIAuth, refreshCodexToken, type OpenAIAuthResolution } from "./openai-auth";
import { buildResearchTools } from "./ai-tools";

export interface AIQueryOptions {
  prompt: string;
  model?: string;
}

/**
 * AI query function. Dispatches to the configured provider at runtime.
 *
 * Anthropic → Claude Agent SDK (works with Max subscription or API key)
 * OpenAI → Vercel AI SDK + Responses API (works with API key or Codex subscription)
 *
 * Returns the final text output with preamble stripped and code block unwrapped.
 */
export async function aiQuery(options: AIQueryOptions): Promise<string> {
  const config = loadConfig();
  const provider = config?.ai.provider ?? "openai";
  const model = options.model ?? config?.ai.model;

  let raw: string;
  if (provider === "anthropic") {
    raw = await queryAnthropic(options.prompt);
  } else {
    raw = await queryOpenAI(model, options.prompt);
  }

  return postProcess(raw);
}

// --- Anthropic path (via Claude Agent SDK — works with Max subscription) ---

async function queryAnthropic(prompt: string): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let result = "";
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

  return result;
}

// --- OpenAI path ---

function resolveOpenAIAuthOrThrow(): Exclude<OpenAIAuthResolution, { source: "none" }> {
  const auth = resolveOpenAIAuth();
  if (auth.source === "none") {
    throw new Error(
      [
        "OpenAI credentials not found.",
        "",
        "Option 1 — ChatGPT subscription (recommended):",
        "  npx codex@latest login",
        "  Tokens cache at ~/.codex/auth.json",
        "",
        "Option 2 — API key:",
        '  export OPENAI_API_KEY="sk-..."',
        "  Get one at https://platform.openai.com/api-keys",
        "",
        auth.reason ? `Details: ${auth.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return auth;
}

async function queryOpenAI(modelOverride: string | undefined, prompt: string): Promise<string> {
  const auth = resolveOpenAIAuthOrThrow();
  const model = modelOverride || "gpt-5";

  let provider;
  if (auth.source === "codex-subscription") {
    const freshToken = (await refreshCodexToken()) ?? auth.apiKey;
    provider = createOpenAI({
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: freshToken,
      headers: auth.accountId
        ? { "ChatGPT-Account-Id": auth.accountId }
        : {},
    });
  } else {
    provider = createOpenAI({ apiKey: auth.apiKey });
  }

  const result = streamText({
    model: provider.responses(model),
    prompt,
    tools: buildResearchTools(loadConfig()?.vault),
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

// --- Post-processing ---

function postProcess(raw: string): string {
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
