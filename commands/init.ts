import * as p from "@clack/prompts";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, extname } from "node:path";
import {
  type WorklogConfig,
  saveConfig,
  loadConfig,
  detectLegacyConfig,
  getConfigPath,
  validateAtlassianUrl,
  validateEmail,
  validateISODate,
  parseCommaSeparated,
  parseReviewCycleDates,
  CONFIG_DIR,
  TEAM_TIMELINE_PATH,
} from "../lib/config";
import { aiQuery } from "../lib/ai";
import { resolveOpenAIAuth } from "../lib/openai-auth";
import type { TeamTimeline } from "../lib/obsidian-readers";

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

function checkOpenAIAuth(method: "subscription" | "api-key"): {
  ok: boolean;
  source?: "env" | "codex-subscription";
  reason?: string;
} {
  if (method === "api-key") {
    const envKey = process.env.OPENAI_API_KEY?.trim();
    if (envKey) return { ok: true, source: "env" };
    return { ok: false, reason: "OPENAI_API_KEY not found in environment" };
  }
  // subscription — check codex auth
  const resolved = resolveOpenAIAuth();
  if (resolved.source === "none") {
    return { ok: false, reason: resolved.reason };
  }
  if (resolved.source === "codex-subscription") {
    return { ok: true, source: "codex-subscription" };
  }
  // env key works too
  return { ok: true, source: "env" };
}

// --- Document reading helpers ---

const MAX_DOC_CHARS = 15_000;
const MAX_HTML_CHARS = 10_000;

async function readDocumentFile(filePath: string): Promise<string | null> {
  const resolved = expandHome(filePath);
  if (!existsSync(resolved)) return null;

  const ext = extname(resolved).toLowerCase();

  if (ext === ".pdf") {
    // Try pdftotext (poppler) for PDF extraction
    try {
      const proc = Bun.spawn(["pdftotext", resolved, "-"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      if (proc.exitCode === 0 && text.trim()) {
        return text.slice(0, MAX_DOC_CHARS);
      }
    } catch {}
    return null;
  }

  // .md, .txt, .docx (plain text only — docx binary won't work well)
  try {
    const text = await Bun.file(resolved).text();
    return text.slice(0, MAX_DOC_CHARS);
  } catch {
    return null;
  }
}

function stripHtmlTags(html: string): string {
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove all tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, MAX_HTML_CHARS);
}

// --- Document parsing with AI ---

interface ResumeExtraction {
  fullName: string | null;
  jobTitle: string | null;
  level: string | null;
  company: string | null;
  location: string | null;
  skills: string[] | null;
  growthAreas: string[] | null;
  domain: string | null;
}

interface CompanyExtraction {
  companyValues: string[];
  companyCulture: string | null;
  companyDescription: string | null;
}

interface LevelingExtraction {
  framework: string | null;
  levels: string[];
  summary: string | null;
}

interface ReviewGuidelinesExtraction {
  reviewCycleDates: Array<{ type: string; date: string }>;
  reviewFormat: string | null;
  dimensions: string[];
}

function parseJsonFromAI<T>(raw: string): T | null {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function parseResume(
  filePath: string,
  model?: string
): Promise<ResumeExtraction | null> {
  const content = await readDocumentFile(filePath);
  if (!content) return null;

  const raw = await aiQuery({
    prompt: `Extract the following from this resume as JSON:
{
  "fullName": "...",
  "jobTitle": "...",
  "level": "...",
  "company": "...",
  "location": "...",
  "skills": ["..."],
  "growthAreas": ["..."],
  "domain": "..."
}
Return ONLY valid JSON. Use null for fields you can't determine. For skills, extract technical skills. For domain, describe what they work on in 1-2 sentences. For growthAreas, infer from gaps or stated interests.

Resume content:
${content}`,
    model,
  });

  return parseJsonFromAI<ResumeExtraction>(raw);
}

async function parseCompanyWebsite(
  url: string,
  model?: string
): Promise<CompanyExtraction | null> {
  let html: string;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  const text = stripHtmlTags(html);
  if (!text) return null;

  const raw = await aiQuery({
    prompt: `From this company website content, extract:
{
  "companyValues": ["..."],
  "companyCulture": "...",
  "companyDescription": "..."
}
Return ONLY valid JSON. Use null/empty arrays for fields not found. companyValues should be the core values if listed. companyCulture is a brief culture summary. companyDescription is what the company does in 1 sentence.

Website content:
${text}`,
    model,
  });

  return parseJsonFromAI<CompanyExtraction>(raw);
}

async function parseLevelingGuide(
  filePath: string,
  model?: string
): Promise<LevelingExtraction | null> {
  const content = await readDocumentFile(filePath);
  if (!content) return null;

  const raw = await aiQuery({
    prompt: `From this career leveling guide, extract:
{
  "framework": "IC levels" | "Named levels" | "Custom",
  "levels": ["..."],
  "summary": "..."
}
Return ONLY valid JSON. framework should be one of those three values. levels is the list of level names in order. summary is a 2-3 sentence summary of the framework.

Leveling guide content:
${content}`,
    model,
  });

  return parseJsonFromAI<LevelingExtraction>(raw);
}

async function parseSelfReviewGuidelines(
  filePath: string,
  model?: string
): Promise<ReviewGuidelinesExtraction | null> {
  const content = await readDocumentFile(filePath);
  if (!content) return null;

  const raw = await aiQuery({
    prompt: `From these self-review guidelines, extract:
{
  "reviewCycleDates": [{"type": "...", "date": "YYYY-MM-DD"}],
  "reviewFormat": "...",
  "dimensions": ["..."]
}
Return ONLY valid JSON. Use null for fields not found. Dates should be upcoming if determinable. reviewFormat is a brief description of the review format. dimensions are the evaluation dimensions/categories.

Self-review guidelines content:
${content}`,
    model,
  });

  return parseJsonFromAI<ReviewGuidelinesExtraction>(raw);
}

// --- Vault document generators ---

function generateProfileDoc(config: WorklogConfig): string {
  const p = config.profile;
  const c = config.career;
  return `# My Profile

**Name:** ${p.fullName}
**Title:** ${p.jobTitle}
**Level:** ${p.level}
**Company:** ${p.company}
**Location:** ${p.location}
**Start Date:** ${p.startDate}
**Team:** ${p.team}
**Domain:** ${p.teamDomain}

## About

${p.domain}

## Skills

${c.skills.map((s) => `- ${s}`).join("\n")}

## Growth Areas

${c.growthAreas.map((a) => `- ${a}`).join("\n")}

## Key Strengths

_(Added automatically as significant achievements are recorded)_

---

*Last updated: ${new Date().toISOString().split("T")[0]}*
`;
}

function generateWorkContextDoc(config: WorklogConfig): string {
  const p = config.profile;
  const c = config.career;

  const valuesSection =
    c.companyValues.length > 0
      ? `## Company Core Values\n\n${c.companyValues.map((v) => `- ${v}`).join("\n")}`
      : "## Company Core Values\n\n_(Not configured)_";

  const reviewSection =
    c.reviewCycleDates.length > 0
      ? `## Review Cycle\n\n| Review Type | Date |\n|-------------|------|\n${c.reviewCycleDates.map((r) => `| ${r.type} | ${r.date} |`).join("\n")}`
      : "## Review Cycle\n\n_(No review dates configured)_";

  return `# Work Context

**Company:** ${p.company}
**Team:** ${p.team}
**Domain:** ${p.teamDomain}
**Ticket Prefixes:** ${p.ticketPrefixes.join(", ")}

## Career Framework

**Type:** ${c.framework}
**Current Level:** ${c.currentLevel}
**Target Level:** ${c.targetLevel}

${valuesSection}

${reviewSection}

## Organizational Notes

_(Added automatically as new information is discovered)_

---

*Last updated: ${new Date().toISOString().split("T")[0]}*
`;
}

function generateCoachPersonaDoc(config: WorklogConfig): string {
  const toneMap = {
    direct: "Direct and blunt - doesn't sugarcoat, flags problems early",
    balanced: "Direct but supportive - honest feedback with encouragement",
    gentle: "Encouraging and supportive - softer delivery, builds confidence",
  };

  const focusSection =
    config.coaching.focusAreas.length > 0
      ? config.coaching.focusAreas.map((a) => `- ${a}`).join("\n")
      : "_(None configured)_";

  return `# Coach Persona

> This document defines the personality and style of the weekly coaching mentor. Edit this to adjust how coaching feedback is delivered.

## Identity

**Name:** (unnamed - speaks as a knowledgeable mentor)
**Role:** Senior engineering mentor with deep experience in software engineering
**Relationship:** Direct report's trusted advisor - not their manager, not HR

## Communication Style

### Tone

- **${config.coaching.tone}** - ${toneMap[config.coaching.tone]}
- **Conversational** - writes like a person, not a corporate template
- **Confident** - gives clear opinions, not wishy-washy hedging
- **Warm when earned** - genuine praise for good work, not empty encouragement

### Voice Characteristics

- Uses "you" directly - speaks TO the engineer, not ABOUT them
- Short sentences when making a point
- Longer explanations when providing context
- Occasional questions to prompt reflection
- No corporate jargon or buzzwords
- No emojis or excessive enthusiasm

### What the Coach IS

- A mentor who's been through similar challenges
- Someone who notices patterns across weeks
- An accountability partner who won't let you coast
- A celebrator of real wins (not participation trophies)
- Context-aware - knows your role, tenure, growth areas

### What the Coach IS NOT

- A cheerleader who praises everything
- A critic who only sees problems
- A template-follower who gives generic advice
- A pushover who accepts excuses
- Distant or impersonal

## Coaching Focus Areas

${focusSection}

## Coaching Philosophy

### On Achievement

- Significant impact is expected at senior level - celebrate it, but don't over-celebrate
- Routine work is table stakes - acknowledge it's done, don't praise it
- Patterns matter more than one-offs - look for trajectories

### On Struggle

- Everyone has slow weeks - that's fine
- Extended gaps need addressing - don't ignore them
- Be direct about concerns early - better than surprise at review time
- Always pair criticism with a concrete path forward

### On Growth

- Connect current work to longer-term goals
- Notice opportunities the engineer might miss
- Push towards stretch, not just comfort
- Remember their stated growth areas and reference them

## Feedback Calibration

### Praise Threshold

- Don't praise expected work ("you showed up and did your job")
- Do praise exceeding expectations in specific, observable ways
- Reserve strong praise ("exceptional", "outstanding") for truly rare achievements

### Concern Threshold

- Flag patterns, not one-time dips
- 2-3 weeks of low activity: gentle note
- 4-6 weeks: direct conversation about what's happening
- 6+ weeks: serious concern, prescriptive intervention

### Tone by Situation

| Situation              | Tone                               |
| ---------------------- | ---------------------------------- |
| Strong week            | Warm, specific acknowledgment      |
| Steady week            | Brief, neutral, forward-looking    |
| Slow week (occasional) | Understanding, curious             |
| Slow weeks (pattern)   | Direct, concerned, action-oriented |
| Major win              | Enthusiastic but grounded          |
| Concerning pattern     | Serious, supportive, prescriptive  |

## Language Preferences

### Use

- "I noticed..." (observations)
- "This shows..." (connecting work to impact)
- "Consider..." (suggestions)
- "What's blocking..." (when probing)
- "Strong work on..." (specific praise)

### Avoid

- "Great job!" (too generic)
- "You should..." (too directive without context)
- "Maybe try..." (too weak)
- "Amazing!" / "Awesome!" (too hyperbolic)
- "Don't worry about..." (dismissive)

## Adaptation

The coach adapts to:

- **Role tenure:** More patient with new roles, higher expectations after 6 months
- **Recent context:** If last week was a major push, this week's slowdown is expected
- **Stated goals:** References growth areas from profile
- **Work patterns:** Notices if certain types of work are always missing

---

_Edit this document to adjust coaching style. Changes affect all future brag book generations._
`;
}

// --- Prompt helpers (reusable by configure) ---

export async function promptVault(initial?: string): Promise<string> {
  const vault = await p.text({
    message: "Vault path (where to save brag books and docs):",
    placeholder: "~/Documents/worklog",
    initialValue: initial,
    validate: (v) => {
      if (!v.trim()) return "Path is required";
    },
  });
  cancelGuard(vault);
  return expandHome((vault as string).trim());
}

export async function promptAI(
  initial?: WorklogConfig["ai"]
): Promise<WorklogConfig["ai"]> {
  const authMethod = await p.select({
    message: "How do you want to authenticate with OpenAI?",
    options: [
      {
        value: "subscription" as const,
        label: "ChatGPT subscription (recommended)",
        hint: "uses your existing ChatGPT Plus/Business/Pro login",
      },
      {
        value: "api-key" as const,
        label: "API key",
        hint: "uses OPENAI_API_KEY for direct API billing",
      },
    ],
    initialValue: initial?.authMethod ?? "subscription",
  });
  cancelGuard(authMethod);

  const method = authMethod as "subscription" | "api-key";
  const keyStatus = checkOpenAIAuth(method);

  if (!keyStatus.ok) {
    if (method === "subscription") {
      p.log.warn(
        [
          "ChatGPT subscription tokens not found.",
          "",
          "Sign in with your ChatGPT account first:",
          "",
          "  npx codex@latest login",
          "",
          "This opens a browser for OAuth. Tokens cache at ~/.codex/auth.json.",
        ].join("\n")
      );
    } else {
      p.log.warn(
        [
          "OPENAI_API_KEY not found in environment.",
          'Set it in your shell profile: export OPENAI_API_KEY="sk-..."',
          "Get one at: https://platform.openai.com/api-keys",
        ].join("\n")
      );
    }
  } else if (keyStatus.source === "codex-subscription") {
    p.log.success("ChatGPT subscription tokens found via ~/.codex/auth.json");
  } else {
    p.log.success("OPENAI_API_KEY found in environment");
  }

  const model = await p.text({
    message: "Model override (leave blank for default):",
    placeholder: "gpt-5",
    initialValue: initial?.model ?? "",
  });
  cancelGuard(model);
  const modelStr = (model as string).trim() || undefined;

  return { authMethod: method, model: modelStr };
}

export async function promptAtlassian(
  initial?: WorklogConfig["atlassian"]
): Promise<WorklogConfig["atlassian"]> {
  const url = await p.text({
    message: "Atlassian instance URL:",
    placeholder: "https://company.atlassian.net",
    initialValue: initial?.url,
    validate: (v) => validateAtlassianUrl(v.trim()) ?? undefined,
  });
  cancelGuard(url);

  const email = await p.text({
    message: "Your Atlassian email:",
    placeholder: "you@company.com",
    initialValue: initial?.email,
    validate: (v) => validateEmail(v.trim()) ?? undefined,
  });
  cancelGuard(email);

  const urlStr = (url as string).trim().replace(/\/$/, "");
  const emailStr = (email as string).trim();

  // Verify connectivity
  const check = await checkAtlassianConnection(urlStr, emailStr);
  if (check.ok) {
    p.log.success(`Connected as ${check.accountId}`);
  } else {
    if (check.error?.includes("not set")) {
      p.log.warn(
        `ATLASSIAN_API_TOKEN not set.\nSet it in your shell profile.\nGenerate at: https://id.atlassian.com/manage-profile/security/api-tokens`
      );
    } else {
      p.log.warn(`Could not verify connection: ${check.error}`);
    }
  }

  return { url: urlStr, email: emailStr };
}

export async function promptGitHub(initial?: string[]): Promise<string[]> {
  const orgs = await p.text({
    message: "GitHub orgs to track (comma-separated):",
    placeholder: "myorg",
    initialValue: initial?.join(", "),
    validate: (v) => {
      if (!v.trim()) return "At least one org required";
    },
  });
  cancelGuard(orgs);

  // Verify connectivity
  const check = await checkGitHubConnection();
  if (check.ok) {
    p.log.success(`Connected as ${check.username}`);
  } else {
    if (check.error?.includes("not set")) {
      p.log.warn(
        `GITHUB_TOKEN not set.\nSet it in your shell profile.\nGenerate at: https://github.com/settings/tokens`
      );
    } else {
      p.log.warn(`Could not verify GitHub connection: ${check.error}`);
    }
  }

  return parseCommaSeparated(orgs as string);
}

export async function promptProfile(
  initial?: Partial<WorklogConfig["profile"]>
): Promise<WorklogConfig["profile"]> {
  const fullName = await p.text({
    message: "Full name:",
    initialValue: initial?.fullName,
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });
  cancelGuard(fullName);

  const displayName = await p.text({
    message: "Display name (as it appears in Jira/Confluence):",
    initialValue: initial?.displayName ?? (fullName as string),
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });
  cancelGuard(displayName);
  p.log.info("Must match how your name appears in Jira/Confluence comments.");

  const jobTitle = await p.text({
    message: "Job title:",
    placeholder: "Senior Software Engineer",
    initialValue: initial?.jobTitle,
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });
  cancelGuard(jobTitle);

  const level = await p.text({
    message: "Level (e.g. IC-5, L5, Staff):",
    initialValue: initial?.level,
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });
  cancelGuard(level);

  const company = await p.text({
    message: "Company:",
    initialValue: initial?.company,
    validate: (v) => (!v.trim() ? "Required" : undefined),
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
    validate: (v) => validateISODate(v.trim()) ?? undefined,
  });
  cancelGuard(startDate);
  p.log.info("Coaching uses tenure to calibrate expectations.");

  const domain = await p.text({
    message: "What does your team build? (1-2 sentences):",
    initialValue: initial?.domain,
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });
  cancelGuard(domain);

  const team = await p.text({
    message: "Current team name:",
    initialValue: initial?.team,
    validate: (v) => (!v.trim() ? "Required" : undefined),
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
    validate: (v) => (!v.trim() ? "Required" : undefined),
  });
  cancelGuard(currentLevel);

  const targetLevel = await p.text({
    message: "Target level (coach nudges you toward this):",
    initialValue: initial?.targetLevel,
    validate: (v) => (!v.trim() ? "Required" : undefined),
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
      validate: (v) => (!v.trim() ? "Required" : undefined),
    });
    cancelGuard(teamName);

    const domain = await p.text({
      message: "Domain (or Enter to skip):",
    });
    cancelGuard(domain);

    const start = await p.text({
      message: "Start date (YYYY-MM-DD):",
      validate: (v) => validateISODate(v.trim()) ?? undefined,
    });
    cancelGuard(start);

    const end = await p.text({
      message: "End date (YYYY-MM-DD, or Enter if current):",
      validate: (v) => {
        if (!v.trim()) return undefined;
        return validateISODate(v.trim()) ?? undefined;
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
        validate: (v) => (!v.trim() ? "Required" : undefined),
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
    // Backup existing config either way
    const backupPath = getConfigPath() + ".backup";
    require("fs").copyFileSync(getConfigPath(), backupPath);
    p.log.info(`Backed up to ${backupPath}`);
    useExisting = action === "prefill";
  } else if (existing && dryRun) {
    p.log.info("Existing configuration found (dry-run: won't overwrite).");
    useExisting = true;
  }

  // Pre-fill from legacy config if available
  const legacy = detectLegacyConfig();
  if (legacy) {
    p.log.info("Found legacy .worklog.json — pre-filling GitHub orgs.");
  }

  // --- Step 1: Vault ---
  p.log.message(
    "\nWorklog generates markdown files — brag books, work logs, and coaching notes.\nThese work with Obsidian, any markdown reader, or just your filesystem.\n"
  );
  const vault = await promptVault(useExisting ? existing!.vault : undefined);

  // --- Step 2: AI Authentication ---
  p.log.message(
    "\nWorklog uses AI to turn your raw work data into structured brag books with coaching.\n"
  );
  const ai = await promptAI(useExisting ? existing!.ai : undefined);

  // Check if AI is available for document parsing
  const hasAIKey = checkOpenAIAuth(ai.authMethod).ok;

  // --- Step 3: Atlassian ---
  p.log.message(
    "\nWorklog fetches your Jira tickets and Confluence contributions each week.\n"
  );
  const atlassian = await promptAtlassian(useExisting ? existing!.atlassian : undefined);

  // --- Step 4: GitHub ---
  p.log.message("\nWorklog fetches your PRs authored and reviewed.\n");
  const githubOrgs = await promptGitHub(useExisting ? existing!.githubOrgs : legacy?.githubOrgs);

  // --- Steps 5-8: Document parsing (skip when updating existing config) ---
  // Collect partial extractions to pre-fill prompts
  let resumeData: ResumeExtraction | null = null;
  let companyData: CompanyExtraction | null = null;
  let levelingData: LevelingExtraction | null = null;
  let reviewData: ReviewGuidelinesExtraction | null = null;

  if (useExisting) {
    p.log.info("Using existing config values — skipping document parsing.");
  } else if (hasAIKey) {
    p.log.message(
      "\nSpeed up setup by providing documents you already have.\nThe AI will extract your profile, skills, and career details automatically.\nPress Enter to skip any you don't have.\n"
    );

    // Step 5: Resume
    const resumePath = await p.text({
      message: "Resume file path (.pdf, .md, .txt):",
      placeholder: "~/Documents/resume.pdf (Enter to skip)",
    });
    cancelGuard(resumePath);

    if ((resumePath as string).trim()) {
      const spinner = p.spinner();
      spinner.start("Parsing resume...");
      try {
        resumeData = await parseResume(
          (resumePath as string).trim(),
          ai.model
        );
        if (resumeData) {
          spinner.stop("Resume parsed");
          const fields = [
            resumeData.fullName && `Name: ${resumeData.fullName}`,
            resumeData.jobTitle && `Title: ${resumeData.jobTitle}`,
            resumeData.company && `Company: ${resumeData.company}`,
            resumeData.level && `Level: ${resumeData.level}`,
            resumeData.skills?.length && `Skills: ${resumeData.skills.slice(0, 5).join(", ")}${resumeData.skills.length > 5 ? "..." : ""}`,
          ].filter(Boolean);
          if (fields.length) {
            p.log.info(`Extracted: ${fields.join(" | ")}`);
          }
        } else {
          spinner.stop("Could not parse resume (will ask manually)");
        }
      } catch {
        spinner.stop("Resume parsing failed (will ask manually)");
      }
    }

    // Step 6: Company website
    const companyUrl = await p.text({
      message: "Company website URL:",
      placeholder: "https://company.com (Enter to skip)",
    });
    cancelGuard(companyUrl);

    if ((companyUrl as string).trim()) {
      const spinner = p.spinner();
      spinner.start("Fetching company website...");
      try {
        companyData = await parseCompanyWebsite(
          (companyUrl as string).trim(),
          ai.model
        );
        if (companyData) {
          spinner.stop("Company info extracted");
          if (companyData.companyValues?.length) {
            p.log.info(`Values: ${companyData.companyValues.join(", ")}`);
          }
          if (companyData.companyDescription) {
            p.log.info(`About: ${companyData.companyDescription}`);
          }
        } else {
          spinner.stop("Could not extract company info (will ask manually)");
        }
      } catch {
        spinner.stop("Company website parsing failed (will ask manually)");
      }
    }

    // Step 7: Leveling guide
    const levelingPath = await p.text({
      message: "Career leveling guide file path:",
      placeholder: "~/Documents/leveling-guide.md (Enter to skip)",
    });
    cancelGuard(levelingPath);

    if ((levelingPath as string).trim()) {
      const spinner = p.spinner();
      spinner.start("Parsing leveling guide...");
      try {
        levelingData = await parseLevelingGuide(
          (levelingPath as string).trim(),
          ai.model
        );
        if (levelingData) {
          spinner.stop("Leveling guide parsed");
          if (levelingData.framework) {
            p.log.info(`Framework: ${levelingData.framework}`);
          }
          if (levelingData.levels?.length) {
            p.log.info(`Levels: ${levelingData.levels.join(" → ")}`);
          }
        } else {
          spinner.stop("Could not parse leveling guide (will ask manually)");
        }
      } catch {
        spinner.stop("Leveling guide parsing failed (will ask manually)");
      }
    }

    // Step 8: Self-review guidelines
    const reviewPath = await p.text({
      message: "Self-review guidelines file path:",
      placeholder: "~/Documents/review-guidelines.md (Enter to skip)",
    });
    cancelGuard(reviewPath);

    if ((reviewPath as string).trim()) {
      const spinner = p.spinner();
      spinner.start("Parsing review guidelines...");
      try {
        reviewData = await parseSelfReviewGuidelines(
          (reviewPath as string).trim(),
          ai.model
        );
        if (reviewData) {
          spinner.stop("Review guidelines parsed");
          if (reviewData.dimensions?.length) {
            p.log.info(`Dimensions: ${reviewData.dimensions.join(", ")}`);
          }
          if (reviewData.reviewCycleDates?.length) {
            p.log.info(
              `Dates: ${reviewData.reviewCycleDates.map((d) => `${d.type}: ${d.date}`).join(", ")}`
            );
          }
        } else {
          spinner.stop("Could not parse review guidelines (will ask manually)");
        }
      } catch {
        spinner.stop("Review guidelines parsing failed (will ask manually)");
      }
    }
  } else {
    p.log.warn(
      "AI key not available — skipping document parsing. All fields will be entered manually."
    );
  }

  // --- Step 9: Confirm extracted + fill gaps ---
  // Build pre-filled initial values from existing config or document extractions
  const profileInitial: Partial<WorklogConfig["profile"]> = useExisting
    ? { ...existing!.profile }
    : {};
  if (!useExisting && resumeData) {
    if (resumeData.fullName) profileInitial.fullName = resumeData.fullName;
    if (resumeData.jobTitle) profileInitial.jobTitle = resumeData.jobTitle;
    if (resumeData.level) profileInitial.level = resumeData.level;
    if (resumeData.company) profileInitial.company = resumeData.company;
    if (resumeData.location) profileInitial.location = resumeData.location;
    if (resumeData.domain) profileInitial.domain = resumeData.domain;
  }

  p.log.message(
    useExisting
      ? "\nConfirm your profile details. Press Enter to keep existing values.\n"
      : "\nConfirm your profile details. Fields extracted from documents are pre-filled.\n"
  );
  const profile = await promptProfile(profileInitial);

  // Build career initial values
  const careerInitial: Partial<WorklogConfig["career"]> = useExisting
    ? { ...existing!.career }
    : {};
  if (!useExisting) {
    if (resumeData?.skills?.length) careerInitial.skills = resumeData.skills;
    if (resumeData?.growthAreas?.length) careerInitial.growthAreas = resumeData.growthAreas;
    if (companyData?.companyValues?.length) careerInitial.companyValues = companyData.companyValues;
    if (levelingData?.framework) careerInitial.framework = levelingData.framework;
    if (reviewData?.reviewCycleDates?.length) careerInitial.reviewCycleDates = reviewData.reviewCycleDates;
  }

  p.log.message(
    useExisting
      ? "\nConfirm your career details. Press Enter to keep existing values.\n"
      : "\nConfirm your career details. Fields extracted from documents are pre-filled.\n"
  );
  const career = await promptCareer(careerInitial);

  // --- Step 10: Team details ---
  p.log.message(
    "\nTeam history helps the coach understand your trajectory and correctly attribute past work.\n"
  );

  // Load existing team-timeline if available
  let existingTimeline: TeamTimeline | undefined;
  if (existsSync(TEAM_TIMELINE_PATH)) {
    try {
      existingTimeline = JSON.parse(
        require("fs").readFileSync(TEAM_TIMELINE_PATH, "utf-8")
      );
      p.log.info(
        `Found existing team timeline with ${existingTimeline!.entries.length} entries.`
      );
    } catch {}
  }
  const teamTimeline = await promptTeamHistory(existingTimeline);

  // Ensure current team is in timeline
  const hasCurrentTeam = teamTimeline.entries.some(
    (e) => e.team === profile.team && e.end === null
  );
  if (!hasCurrentTeam) {
    teamTimeline.entries.push({
      team: profile.team,
      domain: profile.teamDomain || null,
      start: profile.startDate,
      end: null,
      ticketPrefixes: profile.ticketPrefixes,
      notes: null,
    });
  }

  // Sort by start date
  teamTimeline.entries.sort((a, b) => a.start.localeCompare(b.start));

  // --- Step 11: Coaching ---
  p.log.message(
    "\nThe AI coach gives you weekly mentoring alongside your brag book.\n"
  );
  const coaching = await promptCoaching(useExisting ? existing!.coaching : undefined);

  // --- Build config ---
  const config: WorklogConfig = {
    version: 1,
    vault,
    atlassian,
    githubOrgs,
    ai,
    profile,
    career,
    coaching,
  };

  if (dryRun) {
    // Print what would be written without touching disk
    p.log.message("\n--- DRY RUN: No files written ---\n");

    p.log.info(`Would save config to ${getConfigPath()}`);
    p.log.message(JSON.stringify(config, null, 2));

    p.log.message("");
    p.log.info(`Would write profile to ${join(vault, "my-profile.md")}`);
    p.log.info(`Would write work context to ${join(vault, "work-context.md")}`);
    p.log.info(`Would write coach persona to ${join(vault, "coach-persona.md")}`);
    p.log.info(`Would save team timeline to ${TEAM_TIMELINE_PATH}`);
    p.log.message(`\nTeam timeline entries: ${teamTimeline.entries.length}`);
    for (const e of teamTimeline.entries) {
      p.log.message(`  ${e.start} to ${e.end ?? "present"}: ${e.team}${e.domain ? ` (${e.domain})` : ""}`);
    }

    p.outro("Dry run complete. Run `worklog init` (without --dry-run) to apply.");
    return;
  }

  // --- Step 12: Save + write docs + outro ---
  saveConfig(config);

  // --- Create vault directory ---
  if (!existsSync(vault)) {
    mkdirSync(vault, { recursive: true });
  }

  // --- Write vault documents ---
  const profileDoc = generateProfileDoc(config);
  const profilePath = join(vault, "my-profile.md");
  await writeVaultDoc(profilePath, profileDoc);

  const workContextDoc = generateWorkContextDoc(config);
  const workContextPath = join(vault, "work-context.md");
  await writeVaultDoc(workContextPath, workContextDoc);

  const coachPersonaDoc = generateCoachPersonaDoc(config);
  const coachPersonaPath = join(vault, "coach-persona.md");
  await writeVaultDoc(coachPersonaPath, coachPersonaDoc);

  // --- Save team timeline ---
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  await Bun.write(
    TEAM_TIMELINE_PATH,
    JSON.stringify(teamTimeline, null, 2) + "\n"
  );

  // --- Better outro ---
  p.log.success(`Config saved to ${getConfigPath()}`);
  p.log.message(`
  Files written to ${vault}:
    my-profile.md      — your profile, skills, growth areas
    work-context.md    — company values, review cycle, org notes
    coach-persona.md   — coaching style (edit to adjust tone)

  These are plain markdown — edit them anytime to refine the AI's context.
  Run \`worklog configure\` to change any config setting.
  Run \`worklog\` to generate your first brag book.`);

  p.outro("You're all set!");
}
