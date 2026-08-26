import { tool as aiTool } from "ai";
import { z } from "zod";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorklogConfig } from "./config";

const execFileAsync = promisify(execFile);

function buildAtlassianAuth(
  config: WorklogConfig
): { baseUrl: string; headers: Record<string, string> } | null {
  const apiToken = process.env.ATLASSIAN_API_TOKEN?.trim();
  if (!apiToken) return null;

  const auth = Buffer.from(`${config.atlassian.email}:${apiToken}`).toString(
    "base64"
  );
  return {
    baseUrl: config.atlassian.url,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
}

/** Extract numeric page ID from a Confluence URL or pass through a bare ID. */
function extractConfluencePageId(input: string): string {
  // Full URL: .../pages/12345/... or .../pageId=12345
  const urlMatch = input.match(/(?:pages\/|pageId=)(\d+)/);
  if (urlMatch) return urlMatch[1];
  // Bare numeric ID
  if (/^\d+$/.test(input.trim())) return input.trim();
  return input;
}

/**
 * Provider-neutral tool definition. Both the Vercel AI SDK (OpenAI) and the
 * Claude Agent SDK (Anthropic) adapters are built from these, so the model
 * sees the same six tools regardless of provider.
 */
interface ResearchToolSpec<Shape extends z.ZodRawShape> {
  description: string;
  input: Shape;
  execute: (args: z.infer<z.ZodObject<Shape>>) => Promise<string>;
}

function defineTool<Shape extends z.ZodRawShape>(spec: ResearchToolSpec<Shape>): ResearchToolSpec<Shape> {
  return spec;
}

export const RESEARCH_TOOL_NAMES = [
  "fetchJiraTicket",
  "fetchConfluencePage",
  "searchConfluence",
  "searchJira",
  "readVaultNote",
  "searchVault",
] as const;

export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];

function buildResearchToolSpecs(config?: WorklogConfig | null) {
  const atlassian = config ? buildAtlassianAuth(config) : null;
  const vaultPath = config?.vault;

  return {
    fetchJiraTicket: defineTool({
      description: "Fetch details of a Jira ticket by its key (e.g. TEAM-1234)",
      input: { ticketKey: z.string().describe("Jira ticket key, e.g. TEAM-1234") },
      execute: async ({ ticketKey }) => {
        if (!atlassian)
          return "Error: Atlassian auth not configured (set ATLASSIAN_API_TOKEN)";
        const url = `${atlassian.baseUrl}/rest/api/3/issue/${encodeURIComponent(ticketKey)}?fields=summary,status,description,comment`;
        const res = await fetch(url, { headers: atlassian.headers });
        if (!res.ok)
          return `Error fetching ${ticketKey}: ${res.status} ${res.statusText}`;
        const data = await res.json();
        return JSON.stringify(data, null, 2);
      },
    }),

    fetchConfluencePage: defineTool({
      description: "Fetch a Confluence page by its page ID or URL",
      input: { pageIdOrUrl: z.string().describe("Confluence page ID or full URL") },
      execute: async ({ pageIdOrUrl }) => {
        if (!atlassian)
          return "Error: Atlassian auth not configured (set ATLASSIAN_API_TOKEN)";
        const pageId = extractConfluencePageId(pageIdOrUrl);
        const url = `${atlassian.baseUrl}/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,space,history`;
        const res = await fetch(url, { headers: atlassian.headers });
        if (!res.ok)
          return `Error fetching page ${pageId}: ${res.status} ${res.statusText}`;
        const data = await res.json();
        return JSON.stringify(data, null, 2);
      },
    }),

    searchConfluence: defineTool({
      description: "Search Confluence for pages matching a text query",
      input: { query: z.string().describe("Search query text") },
      execute: async ({ query }) => {
        if (!atlassian)
          return "Error: Atlassian auth not configured (set ATLASSIAN_API_TOKEN)";
        const cql = `text~"${query}"`;
        const url = `${atlassian.baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=10`;
        const res = await fetch(url, { headers: atlassian.headers });
        if (!res.ok)
          return `Error searching Confluence: ${res.status} ${res.statusText}`;
        const data = await res.json();
        return JSON.stringify(data, null, 2);
      },
    }),

    searchJira: defineTool({
      description: "Search Jira for tickets matching a text query",
      input: { query: z.string().describe("Search query text") },
      execute: async ({ query }) => {
        if (!atlassian)
          return "Error: Atlassian auth not configured (set ATLASSIAN_API_TOKEN)";
        const url = `${atlassian.baseUrl}/rest/api/3/search/jql`;
        const res = await fetch(url, {
          method: "POST",
          headers: atlassian.headers,
          body: JSON.stringify({
            jql: `text ~ "${query}"`,
            maxResults: 10,
            fields: ["summary", "status", "assignee"],
          }),
        });
        if (!res.ok)
          return `Error searching Jira: ${res.status} ${res.statusText}`;
        const data = await res.json();
        return JSON.stringify(data, null, 2);
      },
    }),

    readVaultNote: defineTool({
      description: "Read a note from the vault by name (without .md extension)",
      input: { noteName: z.string().describe("Note name without .md extension") },
      execute: async ({ noteName }) => {
        if (!vaultPath) return "Error: no vault path configured";
        const filePath = join(vaultPath, `${noteName}.md`);
        try {
          return await readFile(filePath, "utf-8");
        } catch {
          return `Error: could not read ${filePath}`;
        }
      },
    }),

    searchVault: defineTool({
      description: "Search the vault for markdown files containing a keyword",
      input: { keyword: z.string().describe("Keyword to search for") },
      execute: async ({ keyword }) => {
        if (!vaultPath) return "Error: no vault path configured";
        try {
          const { stdout } = await execFileAsync(
            "grep", ["-rl", keyword, vaultPath, "--include=*.md"],
          );
          const lines = stdout.trim().split("\n").filter(Boolean);
          return lines.slice(0, 10).join("\n") || "No matches found";
        } catch {
          return "No matches found";
        }
      },
    }),
  };
}

/** Research tools as a Vercel AI SDK tool set (OpenAI provider). */
export function buildResearchTools(config?: WorklogConfig | null) {
  const specs = buildResearchToolSpecs(config);
  const toVercel = <S extends z.ZodRawShape>(spec: ResearchToolSpec<S>) =>
    aiTool({ description: spec.description, inputSchema: z.object(spec.input), execute: spec.execute });

  return {
    fetchJiraTicket: toVercel(specs.fetchJiraTicket),
    fetchConfluencePage: toVercel(specs.fetchConfluencePage),
    searchConfluence: toVercel(specs.searchConfluence),
    searchJira: toVercel(specs.searchJira),
    readVaultNote: toVercel(specs.readVaultNote),
    searchVault: toVercel(specs.searchVault),
  };
}

export const RESEARCH_MCP_SERVER_NAME = "worklog";

/** Tool identifiers the Claude Agent SDK expects in `allowedTools` for the research MCP server. */
export const RESEARCH_MCP_TOOL_IDS = RESEARCH_TOOL_NAMES.map(
  (name) => `mcp__${RESEARCH_MCP_SERVER_NAME}__${name}`,
);

/** Research tools as an in-process MCP server (Anthropic provider). */
export async function buildResearchMcpServer(config?: WorklogConfig | null) {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const specs = buildResearchToolSpecs(config);
  const toMcp = <S extends z.ZodRawShape>(name: ResearchToolName, spec: ResearchToolSpec<S>) =>
    tool(name, spec.description, spec.input, async (args) => ({
      content: [{ type: "text" as const, text: await spec.execute(args as z.infer<z.ZodObject<S>>) }],
    }));

  return createSdkMcpServer({
    name: RESEARCH_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      toMcp("fetchJiraTicket", specs.fetchJiraTicket),
      toMcp("fetchConfluencePage", specs.fetchConfluencePage),
      toMcp("searchConfluence", specs.searchConfluence),
      toMcp("searchJira", specs.searchJira),
      toMcp("readVaultNote", specs.readVaultNote),
      toMcp("searchVault", specs.searchVault),
    ],
  });
}
