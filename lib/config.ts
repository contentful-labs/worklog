import { existsSync, mkdirSync } from "node:fs";
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

export function loadConfig(): WorklogConfig | null {
  if (_config) return _config;

  if (existsSync(CONFIG_FILE)) {
    try {
      _config = expandConfigPaths(JSON.parse(require("fs").readFileSync(CONFIG_FILE, "utf-8")));
      return _config!;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Load config or exit with an error message directing the user to run init.
 */
export function requireConfig(): WorklogConfig {
  const config = loadConfig();
  if (!config) {
    console.error("No worklog configuration found. Run `worklog init` to set up.");
    process.exit(1);
  }
  return config;
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

export function validateAtlassianUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(".atlassian.net")) {
      return "URL should end with .atlassian.net (e.g. https://company.atlassian.net)";
    }
    return null;
  } catch {
    return "Invalid URL";
  }
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
