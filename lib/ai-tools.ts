import { tool } from "ai";
import { z } from "zod";
import { join } from "node:path";
import type { WorklogConfig } from "./config";

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

export function buildResearchTools(config?: WorklogConfig | null) {
  const atlassian = config ? buildAtlassianAuth(config) : null;
  const vaultPath = config?.vault;

  return {
    fetchJiraTicket: tool({
      description:
        "Fetch details of a Jira ticket by its key (e.g. TEAM-1234)",
      inputSchema: z.object({
        ticketKey: z.string().describe("Jira ticket key, e.g. TEAM-1234"),
      }),
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

    fetchConfluencePage: tool({
      description: "Fetch a Confluence page by its page ID or URL",
      inputSchema: z.object({
        pageIdOrUrl: z
          .string()
          .describe("Confluence page ID or full URL"),
      }),
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

    searchConfluence: tool({
      description: "Search Confluence for pages matching a text query",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
      }),
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

    searchJira: tool({
      description: "Search Jira for tickets matching a text query",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
      }),
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

    readVaultNote: tool({
      description:
        "Read a note from the vault by name (without .md extension)",
      inputSchema: z.object({
        noteName: z.string().describe("Note name without .md extension"),
      }),
      execute: async ({ noteName }) => {
        if (!vaultPath) return "Error: no vault path configured";
        const filePath = join(vaultPath, `${noteName}.md`);
        try {
          return await Bun.file(filePath).text();
        } catch {
          return `Error: could not read ${filePath}`;
        }
      },
    }),

    searchVault: tool({
      description:
        "Search the vault for markdown files containing a keyword",
      inputSchema: z.object({
        keyword: z.string().describe("Keyword to search for"),
      }),
      execute: async ({ keyword }) => {
        if (!vaultPath) return "Error: no vault path configured";
        const proc = Bun.spawn(
          ["grep", "-rl", keyword, vaultPath, "--include=*.md"],
          { stdout: "pipe", stderr: "pipe" }
        );
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        const lines = stdout.trim().split("\n").filter(Boolean);
        return lines.slice(0, 10).join("\n") || "No matches found";
      },
    }),
  };
}
