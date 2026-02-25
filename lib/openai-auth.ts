import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenAIApiKeyResolution =
  | { apiKey: string; source: "env" | "codex"; reason?: string }
  | { apiKey?: string; source: "none"; reason?: string };

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");

export function resolveOpenAIApiKey(): OpenAIApiKeyResolution {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, source: "env" };
  }

  if (!existsSync(CODEX_AUTH_PATH)) {
    return { source: "none", reason: `${CODEX_AUTH_PATH} not found` };
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

  const maybeKey = (parsed as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY;
  if (typeof maybeKey !== "string") {
    return { source: "none", reason: `${CODEX_AUTH_PATH} has no OPENAI_API_KEY` };
  }

  const codexKey = maybeKey.trim();
  if (!codexKey) {
    return { source: "none", reason: `${CODEX_AUTH_PATH} has empty OPENAI_API_KEY` };
  }

  return { apiKey: codexKey, source: "codex" };
}

