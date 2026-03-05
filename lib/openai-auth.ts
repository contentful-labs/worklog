import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenAIAuthResolution =
  | { apiKey: string; source: "env" }
  | { apiKey: string; source: "codex-subscription"; accountId: string }
  | { apiKey?: undefined; source: "none"; reason: string };

interface CodexAuthFile {
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
    refresh_token?: unknown;
  };
}

interface CodexTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/**
 * Resolve OpenAI credentials. Resolution order:
 * 1. OPENAI_API_KEY env var → source: "env"
 * 2. ~/.codex/auth.json → tokens.access_token → source: "codex-subscription"
 * 3. None → source: "none" with instructions
 */
export function resolveOpenAIAuth(): OpenAIAuthResolution {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, source: "env" };
  }

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

  const { tokens } = parsed as CodexAuthFile;
  const accessToken =
    typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
  const accountId =
    typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";

  if (accessToken) {
    return { apiKey: accessToken, source: "codex-subscription", accountId };
  }

  return {
    source: "none",
    reason: `${CODEX_AUTH_PATH} has no tokens.access_token. Run: npx codex@latest login`,
  };
}

/**
 * Refresh the codex subscription access token using the refresh token.
 * Returns the new access token, or null on failure.
 */
export async function refreshCodexToken(): Promise<string | null> {
  if (!existsSync(CODEX_AUTH_PATH)) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8"));
  } catch {
    return null;
  }

  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  const refreshToken = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  if (!refreshToken) return null;

  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
  });

  if (!res.ok) return null;

  const data = await res.json() as CodexTokenResponse;
  if (!data.access_token || !data.refresh_token) return null;

  const updated = {
    ...parsed,
    tokens: {
      ...tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    },
  };
  writeFileSync(CODEX_AUTH_PATH, JSON.stringify(updated, null, 2) + "\n");

  return data.access_token;
}
