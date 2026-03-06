import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { BragBookResult } from "./brag-book";

export async function updateMemory(memoryPath: string, itemsToAdd: string[], itemsToRemove: string[]): Promise<void> {
  let content: string;

  if (existsSync(memoryPath)) {
    content = await readFile(memoryPath, "utf-8");
  } else {
    content = `# Memory - Small Contributions Awaiting Significance

Contributions here are waiting to accumulate into something brag-worthy.

| Date | Item | Category | Notes |
|------|------|----------|-------|
`;
  }

  // Remove graduated items
  for (const item of itemsToRemove) {
    const lines = content.split("\n");
    content = lines.filter(line => !line.includes(item.split("(now part of")[0].trim())).join("\n");
  }

  // Add new items (append to table)
  for (const row of itemsToAdd) {
    if (row.includes("|")) {
      content = content.trimEnd() + "\n" + row;
    }
  }

  await writeFile(memoryPath, content, "utf-8");
}

export async function updateImpactLog(impactLogPath: string, entry: BragBookResult["impactLogEntry"]): Promise<void> {
  if (!entry) return;

  let content = await readFile(impactLogPath, "utf-8");

  // Find the table in Impact Timeline section and append row
  const tableMatch = content.match(/## Impact Timeline[\s\S]*?\|[-\s|]+\|/);
  if (tableMatch) {
    const insertPoint = content.indexOf(tableMatch[0]) + tableMatch[0].length;
    const newRow = `\n| ${entry.date} | ${entry.achievement} | ${entry.scope} | ${entry.coreValue} | ${entry.evidence} |`;
    content = content.slice(0, insertPoint) + newRow + content.slice(insertPoint);
  }

  content = content.replace(/\*\*Last significant impact:\*\*.*/, `**Last significant impact:** ${entry.date}`);
  content = content.replace(/\*\*Current gap:\*\*.*/, `**Current gap:** None - recent entry added`);

  await writeFile(impactLogPath, content, "utf-8");
}

export async function updateWorkContext(workContextPath: string, updates: BragBookResult["workContextUpdates"]): Promise<void> {
  if (updates.length === 0) return;

  let content = await readFile(workContextPath, "utf-8");

  const orgNotesIdx = content.indexOf("## Organizational Notes");
  if (orgNotesIdx !== -1) {
    const insertPoint = content.indexOf("\n", orgNotesIdx + 25) + 1;
    const newEntries = updates.map(u => `- **${u.category}:** ${u.info} _(${u.source})_`).join("\n");
    content = content.slice(0, insertPoint) + "\n" + newEntries + "\n" + content.slice(insertPoint);
  }

  content = content.replace(/\*Last updated:.*\*/, `*Last updated: ${new Date().toISOString().split("T")[0]}*`);

  await writeFile(workContextPath, content, "utf-8");
}

export async function updateProfile(profilePath: string, update: BragBookResult["profileUpdate"]): Promise<void> {
  if (!update) return;

  let content = await readFile(profilePath, "utf-8");

  const strengthsIdx = content.indexOf("## Key Strengths");
  if (strengthsIdx !== -1) {
    const nextSectionIdx = content.indexOf("\n##", strengthsIdx + 1);
    const insertPoint = nextSectionIdx !== -1 ? nextSectionIdx : content.length;
    const newEntry = `- ${update.bulletPoint}\n`;
    content = content.slice(0, insertPoint) + newEntry + content.slice(insertPoint);
  }

  await writeFile(profilePath, content, "utf-8");
}

export async function updateFocusTracking(
  focusTrackingPath: string,
  focusItems: string[],
  focusUpdates: BragBookResult["focusUpdates"],
  weekLabel: string,
): Promise<void> {
  let content: string;

  if (existsSync(focusTrackingPath)) {
    content = await readFile(focusTrackingPath, "utf-8");
  } else {
    content = `# Focus Tracking

Tracks focus items from coaching sessions. Pending items are reviewed in subsequent weeks.

| Week | Focus Item | Status | Notes |
|------|------------|--------|-------|
`;
  }

  // Update status of existing items
  for (const update of focusUpdates) {
    const escapedItem = update.item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\|\\s*${update.week}\\s*\\|\\s*${escapedItem}\\s*\\|\\s*pending\\s*\\|`, "i");
    content = content.replace(regex, `| ${update.week} | ${update.item} | ${update.status} | ${update.notes} |`);
  }

  // Add new focus items
  for (const item of focusItems) {
    if (item && !content.includes(item)) {
      content = content.trimEnd() + `\n| ${weekLabel} | ${item} | pending | |`;
    }
  }

  await writeFile(focusTrackingPath, content, "utf-8");
}
