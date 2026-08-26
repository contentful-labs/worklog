import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { BragBookResult } from "./brag-book";

import { appendToFirstTable } from "./markdown-table";
import { weekIdForDate } from "./week-utils";
import {
  FOCUS_TRACKING_TEMPLATE,
  applyFocusUpdates,
  migrateFocusTracking,
  needsFocusMigration,
  needsFocusFormatUpgrade,
  upgradeFocusFormat,
  type ApplyFocusResult,
} from "./focus";

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

  content = appendToFirstTable(content, itemsToAdd.filter((row) => row.includes("|")));

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
  options: {
    focusItems: string[];
    focusUpdates: BragBookResult["focusUpdates"];
    reviewedIds: string[];
    weekLabel: string;
    lapseAfter?: number;
  },
): Promise<ApplyFocusResult> {
  const content = existsSync(focusTrackingPath)
    ? await readFile(focusTrackingPath, "utf-8")
    : FOCUS_TRACKING_TEMPLATE;

  const result = applyFocusUpdates(content, {
    reviewedIds: options.reviewedIds,
    updates: options.focusUpdates,
    newItems: options.focusItems,
    weekLabel: options.weekLabel,
    lapseAfter: options.lapseAfter,
  });

  await writeFile(focusTrackingPath, result.content, "utf-8");
  return result;
}

/**
 * Bring a pre-id focus-tracking file up to the current shape, keeping a one-time backup
 * because the file is owned by the user, not by us.
 */
export interface FocusFileMigration {
  kind: "ids" | "format";
  backup: string;
  assigned: number;
  collapsed: number;
  lapsed: number;
}

export async function migrateFocusTrackingFile(
  focusTrackingPath: string,
  now: Date = new Date(),
): Promise<FocusFileMigration | null> {
  if (!existsSync(focusTrackingPath)) return null;
  const content = await readFile(focusTrackingPath, "utf-8");
  // Two weeks of grace, like the pure helpers default to; passed explicitly so tests can pin it.
  const keepSinceWeek = weekIdForDate(new Date(now.getTime() - 2 * 7 * 24 * 60 * 60 * 1000));

  if (needsFocusMigration(content)) {
    const backup = `${focusTrackingPath}.pre-ids.bak`;
    await writeFile(backup, content, "utf-8");
    const { content: migrated, assigned, collapsed, lapsed } = migrateFocusTracking(content, keepSinceWeek);
    await writeFile(focusTrackingPath, migrated, "utf-8");
    return { kind: "ids", backup, assigned, collapsed, lapsed };
  }

  if (needsFocusFormatUpgrade(content)) {
    const backup = `${focusTrackingPath}.pre-format2.bak`;
    await writeFile(backup, content, "utf-8");
    const { content: upgraded, lapsed } = upgradeFocusFormat(content, keepSinceWeek);
    await writeFile(focusTrackingPath, upgraded, "utf-8");
    return { kind: "format", backup, assigned: 0, collapsed: 0, lapsed };
  }

  return null;
}
