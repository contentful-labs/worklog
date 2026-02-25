import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenAIAuthResolution =
  | { apiKey: string; source: "env" | "codex-subscription" }
  | { apiKey?: undefined; source: "none"; reason: string };

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");

/**
 * Resolve OpenAI credentials. Resolution order:
 * 1. OPENAI_API_KEY env var → source: "env"
 * 2. ~/.codex/auth.json → tokens.access_token → source: "codex-subscription"
 * 3. None → source: "none" with instructions
 */
export function resolveOpenAIAuth(): OpenAIAuthResolution {
  // 1. Environment variable
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, source: "env" };
  }

  // 2. Codex subscription token
  if (!existsSync(CODEX_AUTH_PATH)) {
    return {
      source: "none",
      reason: `No OPENAI_API_KEY in env and ${CODEX_AUTH_PATH} not found. Run: npx codex@latest login`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8"));
  } catch {
    return { source: "none", reason: `${CODEX_AUTH_PATH} is not valid JSON` };
  }

  if (!parsed || typeof parsed !== "object") {
    return { source: "none", reason: `${CODEX_AUTH_PATH} has unexpected format` };
  }

  const tokens = (parsed as { tokens?: { access_token?: unknown } }).tokens;
  const accessToken =
    typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";

  if (accessToken) {
    return { apiKey: accessToken, source: "codex-subscription" };
  }

  return {
    source: "none",
    reason: `${CODEX_AUTH_PATH} has no tokens.access_token. Run: npx codex@latest login`,
  };
}
