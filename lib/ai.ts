import { loadConfig } from "./config";
import { resolveOpenAIAuth, refreshCodexToken, type OpenAIAuthResolution } from "./openai-auth";

export interface AIQueryOptions {
  prompt: string;
  model?: string;
}

/**
 * AI query function. Dispatches to the configured provider at runtime.
 *
 * Anthropic → Messages API (/v1/messages)
 * OpenAI subscription → Responses API (/v1/responses)
 * OpenAI API key → Chat Completions API (/v1/chat/completions)
 *
 * Returns the final text output with preamble stripped and code block unwrapped.
 */
export async function aiQuery(options: AIQueryOptions): Promise<string> {
  const config = loadConfig();
  const provider = config?.ai.provider ?? "openai";
  const model = options.model ?? config?.ai.model;

  let raw: string;
  if (provider === "anthropic") {
    raw = await queryAnthropic(model, options.prompt);
  } else {
    raw = await queryOpenAI(model, options.prompt);
  }

  return postProcess(raw);
}

// --- Anthropic path ---

async function queryAnthropic(modelOverride: string | undefined, prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      [
        "Anthropic API key not found.",
        "",
        '  export ANTHROPIC_API_KEY="sk-ant-..."',
        "  Get one at https://console.anthropic.com/settings/keys",
      ].join("\n")
    );
  }

  const model = modelOverride || "claude-sonnet-4-20250514";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  let text = "";
  for (const block of data.content ?? []) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
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

  if (auth.source === "codex-subscription") {
    return queryViaResponses(auth, model, prompt);
  }
  return queryViaChatCompletions(auth, model, prompt);
}

/** Responses API — works with ChatGPT subscription tokens */
async function queryViaResponses(
  auth: Extract<OpenAIAuthResolution, { source: "codex-subscription" }>,
  model: string,
  prompt: string
): Promise<string> {
  // Always refresh token first — cached access_token is often expired
  const freshToken = await refreshCodexToken() ?? auth.apiKey;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${freshToken}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  };
  if (auth.accountId) {
    headers["chatgpt-account-id"] = auth.accountId;
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions: "You are a helpful assistant. Follow the user's instructions precisely.",
      input: prompt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI Responses API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  // Extract text from output items
  let text = "";
  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const block of item.content ?? []) {
        if (block.type === "output_text") {
          text += block.text;
        }
      }
    }
  }
  return text;
}

/** Chat Completions API — works with standard API keys */
async function queryViaChatCompletions(
  auth: Extract<OpenAIAuthResolution, { source: "env" }>,
  model: string,
  prompt: string
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant. Follow the user's instructions precisely.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
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
