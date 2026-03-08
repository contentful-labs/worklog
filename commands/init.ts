import * as p from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type WorklogConfig,
  saveConfig,
  loadConfig,
  getConfigPath,
  validateAtlassianUrl,
  validateEmail,
  validateISODate,
  parseCommaSeparated,
  parseReviewCycleDates,
  CONFIG_DIR,
  TEAM_TIMELINE_PATH,
} from "../lib/config";
import { resolveOpenAIAuth } from "../lib/openai-auth";
import type { TeamTimeline } from "../lib/sdk/vault";
import { generateProfileDoc, generateWorkContextDoc, generateCoachPersonaDoc } from "../lib/sdk/doc-generators";

function cancelGuard(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

const DEFAULT_VAULT_PATH = "~/Documents/worklog";
const DEFAULT_ATLASSIAN_URL = "https://contentful.atlassian.net";
const DEFAULT_GITHUB_ORGS = ["contentful", "contentful-labs"];
const DEFAULT_PROFILE_COMPANY = "Contentful";
const DEFAULT_CAREER_COMPANY_VALUES = [
  "Relentless Customer Focus",
  "Be Bold",
  "Own It",
  "Win Together",
];

// --- Vault doc writer with existing-file handling ---

async function writeVaultDoc(path: string, content: string): Promise<void> {
  const filename = path.split("/").pop() ?? path;
  if (existsSync(path)) {
    const choice = await p.select({
      message: `${filename} already exists. What would you like to do?`,
      options: [
        { value: "skip", label: "Skip (keep existing)" },
        { value: "overwrite", label: "Overwrite (backup first)" },
      ],
    });
    cancelGuard(choice);
    if (choice === "skip") {
      p.log.info(`Kept existing ${filename}`);
      return;
    }
    // Backup before overwriting
    const backupPath = `${path}.bak`;
    const existing = await Bun.file(path).text();
    await Bun.write(backupPath, existing);
    p.log.info(`Backed up to ${backupPath}`);
  }
  await Bun.write(path, content);
}

// --- Connectivity checks ---

async function checkAtlassianConnection(
  url: string,
  email: string
): Promise<{ ok: boolean; accountId?: string; error?: string }> {
  const token = process.env.ATLASSIAN_API_TOKEN;
  if (!token) return { ok: false, error: "ATLASSIAN_API_TOKEN not set" };

  try {
    const auth = Buffer.from(`${email}:${token}`).toString("base64");
    const res = await fetch(`${url}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, accountId: data.accountId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function checkGitHubConnection(): Promise<{
  ok: boolean;
  username?: string;
  error?: string;
}> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: "GITHUB_TOKEN not set" };

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, username: data.login };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function checkAIAuth(provider: "anthropic" | "openai"): {
  ok: boolean;
  source?: string;
  reason?: string;
} {
  if (provider === "anthropic") {
    // Claude Agent SDK handles auth — Max subscription or API key both work
    return { ok: true, source: "claude-agent-sdk" };
  }
  // OpenAI — auto-detect subscription vs API key
  const resolved = resolveOpenAIAuth();
  if (resolved.source === "none") {
    return { ok: false, reason: resolved.reason };
  }
  return { ok: true, source: resolved.source };
}

// --- Token prompt helper ---

function getShellProfile(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("/zsh")) return join(homedir(), ".zshrc");
  return join(homedir(), ".bashrc");
}

async function persistTokenToShellProfile(
  envVar: string,
  value: string
): Promise<boolean> {
  const profilePath = getShellProfile();
  const profileName = profilePath.split("/").pop()!;

  const shouldPersist = await p.confirm({
    message: `Add export ${envVar}="..." to ~/${profileName}?`,
    initialValue: true,
  });
  cancelGuard(shouldPersist);

  if (!shouldPersist) return false;

  // Check for existing export line to avoid duplicates
  if (existsSync(profilePath)) {
    const contents = readFileSync(profilePath, "utf-8");
    const exportPattern = new RegExp(`^export ${envVar}=`, "m");
    if (exportPattern.test(contents)) {
      p.log.warn(
        `${envVar} already exported in ~/${profileName}. Update it manually if needed.`
      );
      return false;
    }
  }

  const line = `\nexport ${envVar}="${value}" # worklog\n`;
  appendFileSync(profilePath, line);
  p.log.success(`Added to ~/${profileName}. Restart your shell or run: source ~/${profileName}`);
  return true;
}

interface PromptForTokenOptions {
  envVar: string;
  label: string;
  generateUrl: string;
  validate: () => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };
}

async function promptForToken(opts: PromptForTokenOptions): Promise<boolean> {
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    p.log.info(
      `${opts.label} token not found.\nGenerate one at: ${opts.generateUrl}`
    );

    const token = await p.password({
      message: `Paste your ${opts.label} token:`,
    });
    cancelGuard(token);

    const tokenStr = (token as string ?? "").trim();
    if (!tokenStr) {
      p.log.warn("Empty token, skipping.");
      return false;
    }

    process.env[opts.envVar] = tokenStr;

    const result = await opts.validate();
    if (result.ok) {
      p.log.success(result.detail ?? `${opts.label} connected.`);
      await persistTokenToShellProfile(opts.envVar, tokenStr);
      return true;
    }

    p.log.warn(`Validation failed: ${result.detail ?? "unknown error"}`);
    // Clear the invalid token
    delete process.env[opts.envVar];

    if (attempt < MAX_RETRIES) {
      const retry = await p.confirm({
        message: "Try again?",
        initialValue: true,
      });
      cancelGuard(retry);
      if (!retry) return false;
    }
  }

  p.log.warn(`Skipping ${opts.label} setup. You can set ${opts.envVar} manually later.`);
  return false;
}

// --- Prompt helpers (reusable by configure) ---

export async function promptVault(
  initial?: string,
  fallback: string = DEFAULT_VAULT_PATH
): Promise<string> {
  const fallbackValue = initial?.trim() || fallback;
  const vault = await p.text({
    message: "Vault path (where to save brag books and docs):",
    placeholder: fallback,
    initialValue: initial,
    validate: (v) => {
      if (!((v ?? "").trim() || fallbackValue).trim()) return "Path is required";
    },
  });
  cancelGuard(vault);
  const selected = (vault as string).trim() || fallbackValue;
  return expandHome(selected);
}

export async function promptAI(
  initial?: WorklogConfig["ai"]
): Promise<WorklogConfig["ai"]> {
  const provider = await p.select({
    message: "AI provider for brag book generation:",
    options: [
      {
        value: "anthropic" as const,
        label: "Anthropic (Claude)",
        hint: "works with Claude Max subscription or API key",
      },
      {
        value: "openai" as const,
        label: "OpenAI",
        hint: "ChatGPT subscription or API key",
      },
    ],
    initialValue: initial?.provider ?? "anthropic",
  });
  cancelGuard(provider);

  const selected = provider as "anthropic" | "openai";
  const keyStatus = checkAIAuth(selected);

  if (selected === "anthropic") {
    p.log.info("Uses Claude Agent SDK — works with your Claude Max subscription or ANTHROPIC_API_KEY.");
  } else if (!keyStatus.ok) {
    // OpenAI — guide based on what's missing
    const resolved = resolveOpenAIAuth();
    if (resolved.source === "none") {
      p.log.warn(
        [
          "OpenAI credentials not found.",
          "",
          "Option 1 — ChatGPT subscription:",
          "  npx codex@latest login",
          "  Tokens cache at ~/.codex/auth.json",
          "",
          "Option 2 — API key:",
          '  export OPENAI_API_KEY="sk-..."',
          "  Get one at https://platform.openai.com/api-keys",
        ].join("\n")
      );
    }
  } else if (keyStatus.source === "codex-subscription") {
    p.log.success("ChatGPT subscription tokens found via ~/.codex/auth.json");
  } else {
    p.log.success("OPENAI_API_KEY found in environment");
  }

  const defaultModel = selected === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-5";
  const model = await p.text({
    message: "Model override (leave blank for default):",
    placeholder: defaultModel,
    initialValue: initial?.model ?? "",
  });
  cancelGuard(model);
  const modelStr = (model as string).trim() || undefined;

  return { provider: selected, model: modelStr };
}

export async function promptAtlassian(
  initial?: WorklogConfig["atlassian"],
  options?: { defaultUrl?: string; skipUrlPrompt?: boolean }
): Promise<WorklogConfig["atlassian"]> {
  const fallbackUrl = (
    initial?.url ||
    options?.defaultUrl ||
    DEFAULT_ATLASSIAN_URL
  )
    .trim()
    .replace(/\/$/, "");
  let urlStr = fallbackUrl;

  if (options?.skipUrlPrompt) {
    p.log.info(`Using Atlassian instance URL: ${urlStr}`);
  } else {
    const url = await p.text({
      message: "Atlassian instance URL:",
      placeholder: fallbackUrl,
      initialValue: initial?.url,
      validate: (v) =>
        validateAtlassianUrl(((v ?? "").trim() || fallbackUrl).trim()) ?? undefined,
    });
    cancelGuard(url);
    urlStr = ((url as string).trim() || fallbackUrl).replace(/\/$/, "");
  }

  const email = await p.text({
    message: "Your Atlassian email:",
    placeholder: "you@company.com",
    initialValue: initial?.email,
    validate: (v) => validateEmail((v ?? "").trim()) ?? undefined,
  });
  cancelGuard(email);

  const emailStr = (email as string).trim();

  // Verify connectivity
  const check = await checkAtlassianConnection(urlStr, emailStr);
  if (check.ok) {
    p.log.success(`Connected as ${check.accountId}`);
  } else if (check.error?.includes("not set")) {
    const set = await promptForToken({
      envVar: "ATLASSIAN_API_TOKEN",
      label: "Atlassian API",
      generateUrl:
        "https://id.atlassian.com/manage-profile/security/api-tokens",
      validate: async () => {
        const r = await checkAtlassianConnection(urlStr, emailStr);
        return { ok: r.ok, detail: r.ok ? `Connected as ${r.accountId}` : r.error };
      },
    });
    if (!set) {
      p.log.warn(
        "Atlassian token not configured. Set ATLASSIAN_API_TOKEN before running worklog."
      );
    }
  } else {
    p.log.warn(`Could not verify connection: ${check.error}`);
  }

  return { url: urlStr, email: emailStr };
}

export async function promptGitHub(
  initial?: string[],
  options?: { defaultOrgs?: string[]; skipOrgPrompt?: boolean }
): Promise<string[]> {
  const fallbackOrgs =
    initial?.length
      ? initial
      : options?.defaultOrgs?.length
        ? options.defaultOrgs
        : DEFAULT_GITHUB_ORGS;
  let selectedOrgs = fallbackOrgs;

  if (options?.skipOrgPrompt) {
    p.log.info(`Using GitHub orgs: ${selectedOrgs.join(", ")}`);
  } else {
    const fallbackText = fallbackOrgs.join(", ");
    const orgs = await p.text({
      message: "GitHub orgs to track (comma-separated):",
      placeholder: fallbackText || "myorg",
      initialValue: initial?.join(", "),
      validate: (v) => {
        const parsed = parseCommaSeparated(((v ?? "").trim() || fallbackText).trim());
        if (parsed.length === 0) return "At least one org required";
      },
    });
    cancelGuard(orgs);
    selectedOrgs = parseCommaSeparated(
      ((orgs as string).trim() || fallbackText).trim()
    );
  }

  // Verify connectivity
  const check = await checkGitHubConnection();
  if (check.ok) {
    p.log.success(`Connected as ${check.username}`);
  } else if (check.error?.includes("not set")) {
    const set = await promptForToken({
      envVar: "GITHUB_TOKEN",
      label: "GitHub",
      generateUrl: "https://github.com/settings/tokens",
      validate: async () => {
        const r = await checkGitHubConnection();
        return { ok: r.ok, detail: r.ok ? `Connected as ${r.username}` : r.error };
      },
    });
    if (!set) {
      p.log.warn(
        "GitHub token not configured. Set GITHUB_TOKEN before running worklog."
      );
    }
  } else {
    p.log.warn(`Could not verify GitHub connection: ${check.error}`);
  }

  return selectedOrgs;
}

export async function promptProfile(
  initial?: Partial<WorklogConfig["profile"]>
): Promise<WorklogConfig["profile"]> {
  const fullName = await p.text({
    message: "Full name:",
    initialValue: initial?.fullName,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(fullName);

  const displayName = await p.text({
    message: "Display name (as it appears in Jira/Confluence):",
    initialValue: initial?.displayName ?? (fullName as string),
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(displayName);
  p.log.info("Must match how your name appears in Jira/Confluence comments.");

  const jobTitle = await p.text({
    message: "Job title:",
    placeholder: "Senior Software Engineer",
    initialValue: initial?.jobTitle,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(jobTitle);

  const level = await p.text({
    message: "Level (e.g. IC-5, L5, Staff):",
    initialValue: initial?.level,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(level);

  const company = await p.text({
    message: "Company:",
    initialValue: initial?.company,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(company);

  const location = await p.text({
    message: "Location:",
    placeholder: "Berlin, Germany",
    initialValue: initial?.location,
  });
  cancelGuard(location);

  const startDate = await p.text({
    message: "Role start date (YYYY-MM-DD):",
    placeholder: "2024-01-01",
    initialValue: initial?.startDate,
    validate: (v) => validateISODate((v ?? "").trim()) ?? undefined,
  });
  cancelGuard(startDate);
  p.log.info("Coaching uses tenure to calibrate expectations.");

  const domain = await p.text({
    message: "What does your team build? (1-2 sentences):",
    initialValue: initial?.domain,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(domain);

  const team = await p.text({
    message: "Current team name:",
    initialValue: initial?.team,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(team);

  const teamDomain = await p.text({
    message: "Team domain (area of ownership):",
    initialValue: initial?.teamDomain,
  });
  cancelGuard(teamDomain);

  const ticketPrefixes = await p.text({
    message: "Jira ticket prefix(es) (comma-sep, e.g. TEAM-):",
    initialValue: initial?.ticketPrefixes?.join(", "),
  });
  cancelGuard(ticketPrefixes);
  p.log.info("Used to identify your team's tickets in Jira.");

  return {
    fullName: (fullName as string).trim(),
    displayName: (displayName as string).trim(),
    jobTitle: (jobTitle as string).trim(),
    level: (level as string).trim(),
    company: (company as string).trim(),
    location: (location as string).trim(),
    startDate: (startDate as string).trim(),
    domain: (domain as string).trim(),
    team: (team as string).trim(),
    teamDomain: (teamDomain as string).trim(),
    ticketPrefixes: parseCommaSeparated((ticketPrefixes as string) || ""),
  };
}

export async function promptCareer(
  initial?: Partial<WorklogConfig["career"]>
): Promise<WorklogConfig["career"]> {
  const framework = await p.select({
    message: "Career framework type:",
    options: [
      { value: "IC levels", label: "IC levels (IC3/IC4/IC5/IC6/IC7)" },
      {
        value: "Named levels",
        label: "Named levels (Junior/Mid/Senior/Staff/Principal)",
      },
      { value: "Custom", label: "Custom" },
    ],
    initialValue: initial?.framework ?? "IC levels",
  });
  cancelGuard(framework);

  const currentLevel = await p.text({
    message: "Current level:",
    initialValue: initial?.currentLevel,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(currentLevel);

  const targetLevel = await p.text({
    message: "Target level (coach nudges you toward this):",
    initialValue: initial?.targetLevel,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(targetLevel);

  const companyValues = await p.text({
    message: "Company core values (comma-sep, or Enter to skip):",
    placeholder:
      "e.g. Customer Focus, Be Bold, Own It, Win Together",
    initialValue: initial?.companyValues?.join(", "),
  });
  cancelGuard(companyValues);
  if ((companyValues as string).trim()) {
    p.log.info(
      "Achievements get tagged against these in brag books and self-reviews."
    );
  }

  const reviewDates = await p.text({
    message:
      'Review cycle dates (format: "Type: YYYY-MM-DD, Type: YYYY-MM-DD" or Enter to skip):',
    placeholder: "Self-review: 2026-06-01, Manager review: 2026-07-01",
    initialValue:
      initial?.reviewCycleDates
        ?.map((r) => `${r.type}: ${r.date}`)
        .join(", ") ?? "",
  });
  cancelGuard(reviewDates);
  if ((reviewDates as string).trim()) {
    p.log.info("Coaching intensifies as review dates approach.");
  }

  const skills = await p.text({
    message: "Tech skills (comma-sep):",
    placeholder: "TypeScript, React, Node.js, AWS",
    initialValue: initial?.skills?.join(", "),
  });
  cancelGuard(skills);

  const growthAreas = await p.text({
    message: "Growth areas (comma-sep):",
    placeholder: "System design, cross-team influence",
    initialValue: initial?.growthAreas?.join(", "),
  });
  cancelGuard(growthAreas);
  p.log.info("The coach focuses on these in weekly feedback.");

  const careerDocPaths = await p.text({
    message: "Career framework doc paths (comma-sep, or Enter to skip):",
    placeholder: "~/vault/Career Framework.md",
    initialValue: initial?.careerDocPaths?.join(", "),
  });
  cancelGuard(careerDocPaths);

  return {
    framework: framework as string,
    currentLevel: (currentLevel as string).trim(),
    targetLevel: (targetLevel as string).trim(),
    companyValues: parseCommaSeparated((companyValues as string) || ""),
    reviewCycleDates: parseReviewCycleDates((reviewDates as string) || ""),
    skills: parseCommaSeparated((skills as string) || ""),
    growthAreas: parseCommaSeparated((growthAreas as string) || ""),
    careerDocPaths: parseCommaSeparated((careerDocPaths as string) || "").map(
      expandHome
    ),
  };
}

export async function promptTeamHistory(
  existing?: TeamTimeline
): Promise<TeamTimeline> {
  const timeline: TeamTimeline = existing ?? {
    entries: [],
    transitionNotes: [],
  };

  const addHistory = await p.confirm({
    message: "Add team history entries? (previous teams, leaves, transitions)",
    initialValue: false,
  });
  cancelGuard(addHistory);

  if (!addHistory) return timeline;

  let addMore = true;
  while (addMore) {
    const teamName = await p.text({
      message: "Team name:",
      validate: (v) => (!v?.trim() ? "Required" : undefined),
    });
    cancelGuard(teamName);

    const domain = await p.text({
      message: "Domain (or Enter to skip):",
    });
    cancelGuard(domain);

    const start = await p.text({
      message: "Start date (YYYY-MM-DD):",
      validate: (v) => validateISODate((v ?? "").trim()) ?? undefined,
    });
    cancelGuard(start);

    const end = await p.text({
      message: "End date (YYYY-MM-DD, or Enter if current):",
      validate: (v) => {
        if (!(v ?? "").trim()) return undefined;
        return validateISODate((v ?? "").trim()) ?? undefined;
      },
    });
    cancelGuard(end);

    const prefixes = await p.text({
      message: "Ticket prefixes (comma-sep, or Enter to skip):",
    });
    cancelGuard(prefixes);

    const notes = await p.text({
      message: "Notes (or Enter to skip):",
    });
    cancelGuard(notes);

    timeline.entries.push({
      team: (teamName as string).trim(),
      domain: (domain as string).trim() || null,
      start: (start as string).trim(),
      end: (end as string).trim() || null,
      ticketPrefixes: parseCommaSeparated((prefixes as string) || ""),
      notes: (notes as string).trim() || null,
    });

    const more = await p.confirm({
      message: "Add another team entry?",
      initialValue: false,
    });
    cancelGuard(more);
    addMore = !!more;
  }

  const addNotes = await p.confirm({
    message: "Add transition notes? (context about team changes)",
    initialValue: false,
  });
  cancelGuard(addNotes);

  if (addNotes) {
    let moreNotes = true;
    while (moreNotes) {
      const note = await p.text({
        message: "Transition note:",
        validate: (v) => (!v?.trim() ? "Required" : undefined),
      });
      cancelGuard(note);
      timeline.transitionNotes.push((note as string).trim());

      const more = await p.confirm({
        message: "Add another note?",
        initialValue: false,
      });
      cancelGuard(more);
      moreNotes = !!more;
    }
  }

  return timeline;
}

export async function promptCoaching(
  initial?: Partial<WorklogConfig["coaching"]>
): Promise<WorklogConfig["coaching"]> {
  const tone = await p.select({
    message: "Coaching tone:",
    options: [
      {
        value: "direct" as const,
        label: "Direct",
        hint: "blunt, no sugar-coating, flags problems early",
      },
      {
        value: "balanced" as const,
        label: "Balanced (recommended)",
        hint: "direct but supportive",
      },
      {
        value: "gentle" as const,
        label: "Gentle",
        hint: "encouraging, softer delivery",
      },
    ],
    initialValue: initial?.tone ?? "balanced",
  });
  cancelGuard(tone);

  const focusAreas = await p.text({
    message: "Focus areas for coaching (comma-sep, or Enter to skip):",
    placeholder: "IC-6 promotion readiness, code review engagement",
    initialValue: initial?.focusAreas?.join(", "),
  });
  cancelGuard(focusAreas);

  return {
    tone: tone as "direct" | "balanced" | "gentle",
    focusAreas: parseCommaSeparated((focusAreas as string) || ""),
  };
}

// --- Main init flow ---

export async function runInit(options?: { dryRun?: boolean }): Promise<void> {
  const dryRun = options?.dryRun ?? false;

  p.intro(dryRun ? "worklog init --dry-run (no files will be written)" : "worklog — let's get you set up.");

  // Check for existing config
  const existing = loadConfig();
  let useExisting = false;
  if (existing && !dryRun) {
    const action = await p.select({
      message: "Existing configuration found.",
      options: [
        { value: "prefill", label: "Update existing config", hint: "walk through setup with current values prefilled" },
        { value: "fresh", label: "Start fresh", hint: "blank slate, ignores existing config" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    cancelGuard(action);
    if (action === "cancel") {
      p.cancel("Keeping existing configuration.");
      return;
    }
    const backupPath = getConfigPath() + ".backup";
    require("fs").copyFileSync(getConfigPath(), backupPath);
    p.log.info(`Backed up to ${backupPath}`);
    useExisting = action === "prefill";
  } else if (existing && dryRun) {
    p.log.info("Existing configuration found (dry-run: won't overwrite).");
    useExisting = true;
  }

  // --- Prompt 1: Vault path ---
  const vault = await promptVault(
    useExisting ? existing!.vault : undefined,
    DEFAULT_VAULT_PATH
  );

  // --- Prompt 2: Full name ---
  const nameRaw = await p.text({
    message: "Full name:",
    initialValue: useExisting ? existing!.profile.fullName : undefined,
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
  cancelGuard(nameRaw);
  const fullName = (nameRaw as string).trim();

  // --- Prompt 3: Atlassian email ---
  const emailRaw = await p.text({
    message: "Atlassian email:",
    placeholder: "you@contentful.com",
    initialValue: useExisting ? existing!.atlassian.email : undefined,
    validate: (v) => validateEmail((v ?? "").trim()) ?? undefined,
  });
  cancelGuard(emailRaw);
  const atlassianEmail = (emailRaw as string).trim();

  // --- Prompt 4: AI auth ---
  const ai = await promptAI(useExisting ? existing!.ai : undefined);

  // --- Prompt 5: API tokens ---
  if (!process.env.ATLASSIAN_API_TOKEN) {
    await promptForToken({
      envVar: "ATLASSIAN_API_TOKEN",
      label: "Atlassian API",
      generateUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
      validate: async () => {
        const r = await checkAtlassianConnection(DEFAULT_ATLASSIAN_URL, atlassianEmail);
        return { ok: r.ok, detail: r.ok ? `Connected as ${r.accountId}` : r.error };
      },
    });
  } else {
    const check = await checkAtlassianConnection(
      useExisting ? existing!.atlassian.url : DEFAULT_ATLASSIAN_URL,
      atlassianEmail
    );
    if (check.ok) p.log.success(`Atlassian connected as ${check.accountId}`);
    else p.log.warn(`Atlassian connection issue: ${check.error}`);
  }

  if (!process.env.GITHUB_TOKEN) {
    await promptForToken({
      envVar: "GITHUB_TOKEN",
      label: "GitHub",
      generateUrl: "https://github.com/settings/tokens",
      validate: async () => {
        const r = await checkGitHubConnection();
        return { ok: r.ok, detail: r.ok ? `Connected as ${r.username}` : r.error };
      },
    });
  } else {
    const check = await checkGitHubConnection();
    if (check.ok) p.log.success(`GitHub connected as ${check.username}`);
    else p.log.warn(`GitHub connection issue: ${check.error}`);
  }

  // --- Build config with Contentful defaults ---
  const defaultReviewCycle = [
    { type: "Q1 check-in", date: "" },
    { type: "Mid-year review", date: "" },
    { type: "Q3 check-in", date: "" },
    { type: "Annual review", date: "" },
  ];

  const config: WorklogConfig = {
    version: 1,
    vault,
    atlassian: {
      url: useExisting ? existing!.atlassian.url : DEFAULT_ATLASSIAN_URL,
      email: atlassianEmail,
    },
    githubOrgs: useExisting ? existing!.githubOrgs : [...DEFAULT_GITHUB_ORGS],
    ai,
    profile: {
      fullName,
      displayName: useExisting ? existing!.profile.displayName : fullName,
      jobTitle: useExisting ? existing!.profile.jobTitle : "",
      level: useExisting ? existing!.profile.level : "",
      company: DEFAULT_PROFILE_COMPANY,
      location: useExisting ? existing!.profile.location : "",
      startDate: useExisting ? existing!.profile.startDate : "",
      domain: useExisting ? existing!.profile.domain : "",
      team: useExisting ? existing!.profile.team : "",
      teamDomain: useExisting ? existing!.profile.teamDomain : "",
      ticketPrefixes: useExisting ? existing!.profile.ticketPrefixes : [],
    },
    career: {
      framework: useExisting ? existing!.career.framework : "ic",
      currentLevel: useExisting ? existing!.career.currentLevel : "",
      targetLevel: useExisting ? existing!.career.targetLevel : "",
      companyValues: useExisting
        ? existing!.career.companyValues
        : [...DEFAULT_CAREER_COMPANY_VALUES],
      reviewCycleDates: useExisting
        ? existing!.career.reviewCycleDates
        : defaultReviewCycle,
      skills: useExisting ? existing!.career.skills : [],
      growthAreas: useExisting ? existing!.career.growthAreas : [],
      careerDocPaths: useExisting ? existing!.career.careerDocPaths : [],
    },
    coaching: {
      tone: useExisting ? existing!.coaching.tone : "balanced",
      focusAreas: useExisting ? existing!.coaching.focusAreas : [],
    },
  };

  if (dryRun) {
    p.log.message("\n--- DRY RUN: No files written ---\n");
    p.log.info(`Would save config to ${getConfigPath()}`);
    p.log.message(JSON.stringify(config, null, 2));
    p.log.message("");
    p.log.info(`Would write profile to ${join(vault, "my-profile.md")}`);
    p.log.info(`Would write work context to ${join(vault, "work-context.md")}`);
    p.log.info(`Would write coach persona to ${join(vault, "coach-persona.md")}`);
    p.log.info(`Would save team timeline to ${TEAM_TIMELINE_PATH}`);
    p.outro("Dry run complete. Run `worklog init` (without --dry-run) to apply.");
    return;
  }

  // --- Save config + write vault docs ---
  saveConfig(config);

  if (!existsSync(vault)) {
    mkdirSync(vault, { recursive: true });
  }

  await writeVaultDoc(join(vault, "my-profile.md"), generateProfileDoc(config));
  await writeVaultDoc(join(vault, "work-context.md"), generateWorkContextDoc(config));
  await writeVaultDoc(join(vault, "coach-persona.md"), generateCoachPersonaDoc(config));

  // --- Empty team timeline ---
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const emptyTimeline: TeamTimeline = { entries: [], transitionNotes: [] };
  await Bun.write(
    TEAM_TIMELINE_PATH,
    JSON.stringify(emptyTimeline, null, 2) + "\n"
  );

  // --- Outro ---
  p.log.success(`Config saved to ${getConfigPath()}`);
  const vaultDisplay = vault.replace(homedir(), "~");
  p.log.message(`
  Files written to ${vaultDisplay}:
    my-profile.md      — edit to add your title, team, skills
    work-context.md    — edit to add your team and ticket prefixes
    coach-persona.md   — edit to adjust coaching tone

  Run \`worklog configure\` to change any setting later.
  Run \`worklog\` to generate your first brag book.`);

  p.outro("You're all set!");
}
