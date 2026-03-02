import { loadConfig } from "./config";
import { resolveOpenAIAuth } from "./openai-auth";

export interface AIQueryOptions {
  prompt: string;
  model?: string;
}

/**
 * AI query function. Uses OpenAI Chat Completions API.
 *
 * Works with both API keys and ChatGPT subscription tokens.
 * Returns the final text output with preamble stripped and code block unwrapped.
 */
export async function aiQuery(options: AIQueryOptions): Promise<string> {
  const config = loadConfig();
  const model = options.model ?? config?.ai.model;

  const raw = await queryOpenAI(options, model);
  return postProcess(raw);
}

// --- OpenAI path ---

async function queryOpenAI(options: AIQueryOptions, modelOverride?: string): Promise<string> {
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

  const model = modelOverride || "gpt-5";

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
        { role: "user", content: options.prompt },
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
