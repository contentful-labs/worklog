import { loadConfig } from "./config";
import { resolveOpenAIAuth } from "./openai-auth";

export interface AIQueryOptions {
  prompt: string;
  tools?: string[];
  maxTurns?: number;
  model?: string;
}

/**
 * AI query function. Uses OpenAI Agents SDK.
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

  const { Agent, run, setDefaultOpenAIKey } = await import("@openai/agents");
  setDefaultOpenAIKey(auth.apiKey);

  const tools: any[] = [];
  if (options.tools?.includes("Bash")) {
    const { shellTool } = await import("@openai/agents");
    tools.push(shellTool);
  }

  const model = modelOverride || "gpt-5";

  const agent = new Agent({
    name: "worklog",
    instructions: "You are a helpful assistant. Follow the user's instructions precisely.",
    model,
    tools,
  });

  const result = await run(agent, options.prompt, {
    maxTurns: options.maxTurns ?? 1,
  });

  // Extract all text output from the result
  let text = "";
  for (const item of result.output) {
    if (item.type === "message") {
      for (const block of item.content) {
        if (block.type === "output_text") {
          text += block.text;
        }
      }
    }
  }

  return text;
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
