import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";


export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "worklog"
);

const CONFIG_FILE = join(CONFIG_DIR, "config.json");


export interface WorklogConfig {
  version: 1;

  vault: string;

  atlassian: {
    url: string;
    email: string;
  };

  githubOrgs: string[];

  ai: {
    provider: "anthropic" | "openai";
    model?: string;
  };

  profile: {
    fullName: string;
    displayName: string;
    jobTitle: string;
    level: string;
    company: string;
    location: string;
    startDate: string;
    domain: string;
    team: string;
    teamDomain: string;
    ticketPrefixes: string[];
  };

  career: {
    framework: string;
    currentLevel: string;
    targetLevel: string;
    companyValues: string[];
    reviewCycleDates: Array<{
      type: string;
      date: string;
    }>;
    skills: string[];
    growthAreas: string[];
    careerDocPaths: string[];
  };

  coaching: {
    tone: "direct" | "balanced" | "gentle";
    focusAreas: string[];
  };
}


export const STATS_PATH = join(CONFIG_DIR, "worklog-stats.json");
export const TEAM_TIMELINE_PATH = join(CONFIG_DIR, "team-timeline.json");


let _config: WorklogConfig | undefined;

/**
 * Why there is no usable config, when there is not one.
 *
 * The two cases need different advice, and telling them apart is the whole point: a user
 * whose config.json has a stray comma was being sent to `worklog init`, which would have
 * overwritten the file they were one character away from fixing.
 */
export type ConfigLoad =
  | { status: "ok"; config: WorklogConfig }
  | { status: "missing" }
  | { status: "unreadable"; error: string };

export function readConfig(): ConfigLoad {
  if (_config) return { status: "ok", config: _config };
  if (!existsSync(CONFIG_FILE)) return { status: "missing" };

  try {
    _config = expandConfigPaths(JSON.parse(readFileSync(CONFIG_FILE, "utf-8")));
    return { status: "ok", config: _config };
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The config, or null when there is not a usable one.
 *
 * Deliberately flattens both failures: `worklog init` calls this to offer a prefill, and
 * a broken config is exactly when init is most needed, so it must not throw here.
 * Anything that needs to tell the user what went wrong calls readConfig.
 */
export function loadConfig(): WorklogConfig | null {
  const result = readConfig();
  return result.status === "ok" ? result.config : null;
}

/** Load config, or explain what is wrong with it and exit. */
export function requireConfig(): WorklogConfig {
  const result = readConfig();
  if (result.status === "ok") return result.config;

  if (result.status === "missing") {
    console.error("No worklog configuration found. Run `worklog init` to set up.");
  } else {
    // No suggestion to re-init: the settings are still in that file, and running init
    // over it is how they would be lost.
    console.error(
      `config.json at ${contractHome(CONFIG_FILE)} could not be parsed: ${result.error}\n` +
      `Fix the file to continue. Your settings are still in it.`,
    );
  }
  process.exit(1);
}

export function saveConfig(config: WorklogConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Stored home-relative, cached expanded: the file stays portable while callers
  // keep getting absolute paths.
  require("fs").writeFileSync(CONFIG_FILE, JSON.stringify(contractConfigPaths(config), null, 2) + "\n");
  _config = expandConfigPaths(config);
}


/**
 * Expand a leading `~` or `$HOME` to the current home directory.
 *
 * Paths in config.json are stored home-relative so the file survives being restored
 * onto a machine with a different username. Nothing else is touched: a relative path
 * stays relative, because resolving it here would silently depend on the caller's cwd.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax, not a template
  for (const prefix of ["$HOME/", "${HOME}/"]) {
    if (path.startsWith(prefix)) return join(homedir(), path.slice(prefix.length));
  }
  return path;
}

/** Inverse of expandHome: rewrite a path inside the home directory back to `~/...`. */
export function contractHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function mapConfigPaths(config: WorklogConfig, transform: (path: string) => string): WorklogConfig {
  return {
    ...config,
    vault: transform(config.vault),
    career: { ...config.career, careerDocPaths: config.career.careerDocPaths.map(transform) },
  };
}

/** Absolute paths for use at runtime. */
export function expandConfigPaths(config: WorklogConfig): WorklogConfig {
  return mapConfigPaths(config, expandHome);
}

/** Home-relative paths for storage on disk. */
export function contractConfigPaths(config: WorklogConfig): WorklogConfig {
  return mapConfigPaths(config, contractHome);
}

export type AtlassianUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Reduce an Atlassian site URL to the origin every API path is built from. Plain HTTP is refused
 * because the API token travels in a Basic auth header, and a path such as /wiki has to go or
 * requests end up at /wiki/rest/api/3/... and never find the account.
 */
export function canonicalizeAtlassianUrl(value: string): AtlassianUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "URL must use https (your API token is sent with every request)" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Remove the username and password from the URL" };
  }
  if (!parsed.hostname.endsWith(".atlassian.net")) {
    return { ok: false, error: "URL should end with .atlassian.net (e.g. https://company.atlassian.net)" };
  }
  return { ok: true, url: parsed.origin };
}

export function validateAtlassianUrl(url: string): string | null {
  const result = canonicalizeAtlassianUrl(url);
  return result.ok ? null : result.error;
}

export function validateEmail(email: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "Invalid email address";
  }
  return null;
}

export function validateISODate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
    return "Must be YYYY-MM-DD format";
  }
  return null;
}

export function parseCommaSeparated(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Jira project keys have no trailing dash, but people type prefixes as "TEAM-".
 * The sprint JQL is `project in (...)`, which rejects "TEAM-", so strip it.
 */
export function normalizeTicketPrefix(prefix: string): string {
  // Trailing dashes are trimmed by scanning, not by /-+$/, which backtracks
  // polynomially on long dash runs (CodeQL js/polynomial-redos).
  const trimmed = prefix.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "-") end--;
  return trimmed.slice(0, end).toUpperCase();
}

export function parseTicketPrefixes(input: string): string[] {
  return parseCommaSeparated(input).map(normalizeTicketPrefix).filter(Boolean);
}

export function parseReviewCycleDates(
  input: string
): Array<{ type: string; date: string }> {
  // Format: "Self-review: 2026-06-01, Manager review: 2026-07-01"
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) return null;
      const type = entry.slice(0, colonIdx).trim();
      const date = entry.slice(colonIdx + 1).trim();
      if (!type || validateISODate(date) !== null) return null;
      return { type, date };
    })
    .filter((e): e is { type: string; date: string } => e !== null);
}


export function getConfigPath(): string {
  return CONFIG_FILE;
}
