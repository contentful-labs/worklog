import { loadConfig } from "./config";
import { resolveOpenAIAuth, type OpenAIAuthResolution } from "./openai-auth";

export interface AIQueryOptions {
  prompt: string;
  model?: string;
}

/**
 * AI query function.
 *
 * - ChatGPT subscription tokens → Responses API (/v1/responses)
 * - API keys → Chat Completions API (/v1/chat/completions)
 *
 * Returns the final text output with preamble stripped and code block unwrapped.
 */
export async function aiQuery(options: AIQueryOptions): Promise<string> {
  const config = loadConfig();
  const model = options.model ?? config?.ai.model;

  const raw = await queryOpenAI(options, model);
  return postProcess(raw);
}

// --- OpenAI path ---

function resolveAuthOrThrow(): Exclude<OpenAIAuthResolution, { source: "none" }> {
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

async function queryOpenAI(options: AIQueryOptions, modelOverride?: string): Promise<string> {
  const auth = resolveAuthOrThrow();
  const model = modelOverride || "gpt-5";

  if (auth.source === "codex-subscription") {
    return queryViaResponses(auth, model, options.prompt);
  }
  return queryViaChatCompletions(auth, model, options.prompt);
}

/** Responses API — works with ChatGPT subscription tokens */
async function queryViaResponses(
  auth: Extract<OpenAIAuthResolution, { source: "codex-subscription" }>,
  model: string,
  prompt: string
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.apiKey}`,
  };
  if (auth.accountId) {
    headers["ChatGPT-Account-Id"] = auth.accountId;
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
