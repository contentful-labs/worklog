import type { JiraIssue } from "./types";

export function extractText(adfContent: JiraIssue["fields"]["description"], maxLength = 300): string {
  if (!adfContent?.content) return "";

  const texts: string[] = [];
  for (const block of adfContent.content) {
    if (block.content) {
      for (const inline of block.content) {
        if (inline.text) texts.push(inline.text);
      }
    }
  }
  const joined = texts.join(" ");
  return joined.length > maxLength ? joined.slice(0, maxLength) + "..." : joined;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
