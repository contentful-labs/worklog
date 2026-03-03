import { tool } from "ai";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRIPTS = {
  fetchJiraTicket: join(
    homedir(),
    ".dotfiles/.claude/skills/atlassian/scripts/fetch_jira_ticket.sh"
  ),
  fetchConfluencePage: join(
    homedir(),
    ".dotfiles/.claude/skills/atlassian/scripts/fetch_confluence_page.sh"
  ),
  searchConfluence: join(
    homedir(),
    ".dotfiles/.claude/skills/contentful-confluence-researcher/scripts/search_confluence.sh"
  ),
  searchJira: join(
    homedir(),
    ".dotfiles/.claude/skills/contentful-confluence-researcher/scripts/search_jira.sh"
  ),
} as const;

async function runScript(script: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["bash", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return `Error (exit ${exitCode}): ${stderr || stdout}`;
  }
  return stdout;
}

export function buildResearchTools(vaultPath?: string) {
  return {
    fetchJiraTicket: tool({
      description:
        "Fetch details of a Jira ticket by its key (e.g. TEAM-1234)",
      inputSchema: z.object({
        ticketKey: z.string().describe("Jira ticket key, e.g. TEAM-1234"),
      }),
      execute: async ({ ticketKey }) =>
        runScript(SCRIPTS.fetchJiraTicket, [ticketKey]),
    }),

    fetchConfluencePage: tool({
      description: "Fetch a Confluence page by its page ID or URL",
      inputSchema: z.object({
        pageIdOrUrl: z
          .string()
          .describe("Confluence page ID or full URL"),
      }),
      execute: async ({ pageIdOrUrl }) =>
        runScript(SCRIPTS.fetchConfluencePage, [pageIdOrUrl]),
    }),

    searchConfluence: tool({
      description: "Search Confluence for pages matching a text query",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
      }),
      execute: async ({ query }) =>
        runScript(SCRIPTS.searchConfluence, ["--text", query]),
    }),

    searchJira: tool({
      description: "Search Jira for tickets matching a text query",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
      }),
      execute: async ({ query }) =>
        runScript(SCRIPTS.searchJira, ["--text", query]),
    }),

    readVaultNote: tool({
      description:
        "Read a note from the Obsidian vault by name (without .md extension)",
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
        "Search the Obsidian vault for markdown files containing a keyword",
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
