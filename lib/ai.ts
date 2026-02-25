import { requireConfig } from "./config";
import { resolveOpenAIApiKey } from "./openai-auth";

export interface AIQueryOptions {
  prompt: string;
  tools?: string[];
  maxTurns?: number;
  provider?: "anthropic" | "openai";
  model?: string;
}

/**
 * Unified AI query function. Dispatches to the configured provider
 * (Anthropic or OpenAI) at runtime via dynamic import.
 *
 * Returns the final text output with preamble stripped and code block unwrapped.
 */
export async function aiQuery(options: AIQueryOptions): Promise<string> {
  let provider: "anthropic" | "openai";
  let model: string | undefined;

  if (options.provider) {
    provider = options.provider;
    model = options.model;
  } else {
    const config = requireConfig();
    provider = config.ai.provider;
    model = config.ai.model;
  }

  let raw: string;
  if (provider === "anthropic") {
    raw = await queryAnthropic(options);
  } else {
    raw = await queryOpenAI(options, model);
  }

  return postProcess(raw);
}

// --- Anthropic path ---

async function queryAnthropic(options: AIQueryOptions): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let result = "";
  for await (const message of query({
    prompt: options.prompt,
    options: {
      allowedTools: options.tools ?? [],
      maxTurns: options.maxTurns ?? 1,
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

async function queryOpenAI(options: AIQueryOptions, modelOverride?: string): Promise<string> {
  const auth = resolveOpenAIApiKey();
  if (auth.source === "none") {
    throw new Error(
      [
        "OpenAI credentials missing for @openai/agents.",
        "Checked: OPENAI_API_KEY and ~/.codex/auth.json (top-level OPENAI_API_KEY).",
        "A ChatGPT subscription alone is not direct API auth for the OpenAI Agents SDK.",
        "Fix: set OPENAI_API_KEY, or ensure ~/.codex/auth.json contains OPENAI_API_KEY.",
        auth.reason ? `Details: ${auth.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const { Agent, run, setDefaultOpenAIKey } = await import("@openai/agents");
  if (auth.source === "codex") {
    setDefaultOpenAIKey(auth.apiKey);
  }

  const tools: any[] = [];
  if (options.tools?.includes("Bash")) {
    // Use the built-in shell tool from @openai/agents
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
