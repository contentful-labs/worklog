export interface BragBookResult {
  bragBookContent: string;
  itemsToAdd: string[];
  itemsToRemove: string[];
  impactLogEntry: { date: string; achievement: string; scope: string; coreValue: string; evidence: string } | null;
  workContextUpdates: Array<{ category: string; info: string; source: string }>;
  profileUpdate: { achievement: string; bulletPoint: string } | null;
  focusItems: string[];
  /** Status rows keyed by focus item id. Prose is never used to identify an item. */
  focusUpdates: Array<{ id: string; status: string; notes: string }>;
}

export interface ReviewInfo {
  nextReview: string;
  date: string;
  weeksRemaining: number;
  urgency: "normal" | "attention" | "urgent";
}

/** Extract data rows from a markdown table section (skips header and separator rows). */
function extractTableRows(section: string, headingPattern: RegExp): string[] {
  const match = section.match(headingPattern);
  if (!match) return [];
  const afterHeading = section.slice(match.index! + match[0].length);
  const untilNextSection = afterHeading.split(/(?=^##)/m)[0];
  const allRows = untilNextSection
    .trim()
    .split("\n")
    .filter(row => row.startsWith("|"));

  // Skip header row and separator (first two rows of a markdown table)
  const separatorIdx = allRows.findIndex(row => /^\|[\s-|]+$/.test(row));
  if (separatorIdx === -1) return [];
  return allRows.slice(separatorIdx + 1);
}

/** Parse raw AI output into structured brag book result. */
export function parseBragBookResult(raw: string): BragBookResult {
  const memoryMarkerStart = "<!-- MEMORY_UPDATE -->";
  const memoryMarkerEnd = "<!-- /MEMORY_UPDATE -->";
  const contextMarkerStart = "<!-- CONTEXT_UPDATES -->";
  const contextMarkerEnd = "<!-- /CONTEXT_UPDATES -->";
  // COACHING_SESSION is deliberately left in the brag book for the reader and is not parsed.
  const focusMarkerStart = "<!-- FOCUS_UPDATE -->";
  const focusMarkerEnd = "<!-- /FOCUS_UPDATE -->";

  let bragBookContent = raw;
  let itemsToAdd: string[] = [];
  let itemsToRemove: string[] = [];
  let impactLogEntry: BragBookResult["impactLogEntry"] = null;
  const workContextUpdates: BragBookResult["workContextUpdates"] = [];
  let profileUpdate: BragBookResult["profileUpdate"] = null;
  let focusItems: string[] = [];
  const focusUpdates: BragBookResult["focusUpdates"] = [];

  const memoryStartIdx = raw.indexOf(memoryMarkerStart);
  const memoryEndIdx = raw.indexOf(memoryMarkerEnd);

  if (memoryStartIdx !== -1 && memoryEndIdx !== -1) {
    // Strip machine-parseable sections, keep COACHING_SESSION for human reading
    bragBookContent = raw
      .replace(new RegExp(`\\n---\\s*\\n${memoryMarkerStart}[\\s\\S]*?${memoryMarkerEnd}`, "g"), "")
      .replace(new RegExp(`\\n---\\s*\\n${focusMarkerStart}[\\s\\S]*?${focusMarkerEnd}`, "g"), "")
      .replace(new RegExp(`\\n---\\s*\\n${contextMarkerStart}[\\s\\S]*?${contextMarkerEnd}`, "g"), "")
      .replace(/(\n---\s*)+$/, "")
      .trim();

    const memorySection = raw.substring(memoryStartIdx + memoryMarkerStart.length, memoryEndIdx);

    const addRows = extractTableRows(memorySection, /## Items to Add to (?:Memory|\[\[memory\]\])/);
    itemsToAdd = addRows.map(row => row.trim());

    const removeMatch = memorySection.match(/## Items to Remove from (?:Memory|\[\[memory\]\])[\s\S]*?\n([\s\S]*?)$/);
    if (removeMatch) {
      const listItems = removeMatch[1].trim().split("\n").filter(line => line.startsWith("-"));
      itemsToRemove = listItems.map(item => item.replace(/^-\s*/, "").trim());
    }
  }

  // Parse CONTEXT_UPDATES section
  const contextStartIdx = raw.indexOf(contextMarkerStart);
  const contextEndIdx = raw.indexOf(contextMarkerEnd);

  if (contextStartIdx !== -1 && contextEndIdx !== -1) {
    const contextSection = raw.substring(contextStartIdx + contextMarkerStart.length, contextEndIdx);

    const impactRows = extractTableRows(contextSection, /## (?:\[\[impact-log\]\]|Impact Log) Update/);
    for (const row of impactRows) {
      const parts = row.split("|").map(p => p.trim()).filter(Boolean);
      if (parts.length >= 5 && parts[0] && parts[1]) {
        impactLogEntry = {
          date: parts[0],
          achievement: parts[1],
          scope: parts[2] || "",
          coreValue: parts[3] || "",
          evidence: parts[4] || "",
        };
        break;
      }
    }

    const wcRows = extractTableRows(contextSection, /## (?:\[\[work-context\]\]|Work Context) Updates/);
    for (const row of wcRows) {
      const parts = row.split("|").map(p => p.trim()).filter(Boolean);
      if (parts.length >= 3 && parts[0] && parts[1]) {
        workContextUpdates.push({
          category: parts[0],
          info: parts[1],
          source: parts[2] || "",
        });
      }
    }

    const achievementMatch = contextSection.match(/\*\*Achievement to add:\*\*\s*(.+)/);
    const bulletMatch = contextSection.match(/\*\*Suggested bullet point:\*\*\s*(.+)/);
    if (achievementMatch && bulletMatch && achievementMatch[1].trim() && bulletMatch[1].trim()) {
      const achievement = achievementMatch[1].trim();
      const bulletPoint = bulletMatch[1].trim();
      if (achievement && achievement !== "(leave blank if none - bar is CV-worthy)" && bulletPoint && bulletPoint !== "(leave blank if none)") {
        profileUpdate = { achievement, bulletPoint };
      }
    }
  }

  // FOCUS_UPDATE is the only machine-read source of focus items. The coaching section
  // states the same suggestions in prose for the reader; parsing both is what used to
  // turn two suggestions into four rows a week.
  const focusStartIdx = raw.indexOf(focusMarkerStart);
  const focusEndIdx = raw.indexOf(focusMarkerEnd);

  if (focusStartIdx !== -1 && focusEndIdx !== -1) {
    const focusSection = raw.substring(focusStartIdx + focusMarkerStart.length, focusEndIdx);

    const statusRows = extractTableRows(focusSection, /## (?:\[\[focus-tracking\]\]|Focus Items) Status/);
    for (const row of statusRows) {
      const parts = row.split("|").map(p => p.trim()).filter(Boolean);
      const [id, status, notes] = parts;
      if (FOCUS_ID_PATTERN.test(id ?? "") && status) {
        focusUpdates.push({ id, status, notes: notes || "" });
      }
    }

    const newFocusMatch = focusSection.match(/## New Focus Items[\s\S]*?$/);
    if (newFocusMatch) {
      const newFocusLines = newFocusMatch[0].split("\n").filter(line => line.startsWith("-"));
      focusItems = newFocusLines
        .map(line => line.replace(/^-\s*/, "").trim())
        .filter(item => item && !item.startsWith("(") && !FOCUS_ID_PATTERN.test(item));
    }
  }

  return { bragBookContent, itemsToAdd, itemsToRemove, impactLogEntry, workContextUpdates, profileUpdate, focusItems, focusUpdates };
}

const BRAG_BOOK_FRONTMATTER = "---\ntags:\n  - areas/work\n  - areas/work/brag-book\n---\n\n";

/** The prompt asks for frontmatter, but models drop it often enough that we add it ourselves. */
export function ensureBragBookFrontmatter(content: string): string {
  return content.startsWith("---") ? content : BRAG_BOOK_FRONTMATTER + content;
}

/** Focus item ids look like `2026-W35.1`. See lib/sdk/focus.ts. */
const FOCUS_ID_PATTERN = /^\d{4}-W\d{2}\.\d+$/;

/** Parse review cycle info from work context markdown. */
export function parseReviewCycle(workContext: string, today: Date = new Date()): ReviewInfo | null {
  const reviewSectionMatch = workContext.match(/## Review Cycle\n([^#]|#(?!#))*/);

  if (!reviewSectionMatch) return null;

  const section = reviewSectionMatch[0];
  const rows = section.split("\n").filter(line => line.startsWith("|") && !line.includes("---") && !line.includes("Review Type"));

  let nearestReview: { type: string; date: Date } | null = null;

  for (const row of rows) {
    const parts = row.split("|").map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const reviewType = parts[0];
      const dateStr = parts[1];
      const reviewDate = new Date(dateStr);

      if (reviewDate > today) {
        if (!nearestReview || reviewDate < nearestReview.date) {
          nearestReview = { type: reviewType, date: reviewDate };
        }
      }
    }
  }

  if (!nearestReview) return null;

  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksRemaining = Math.ceil((nearestReview.date.getTime() - today.getTime()) / msPerWeek);

  let urgency: "normal" | "attention" | "urgent" = "normal";
  if (weeksRemaining < 4) urgency = "urgent";
  else if (weeksRemaining < 8) urgency = "attention";

  return {
    nextReview: nearestReview.type,
    date: nearestReview.date.toISOString().split("T")[0],
    weeksRemaining,
    urgency,
  };
}
