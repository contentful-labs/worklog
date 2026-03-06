// Types
export type {
  JiraIssue,
  ConfluenceTag,
  ConfluencePage,
  ConfluenceComment,
  GitHubPR,
  WorklogConfig,
} from "./types";

// Week utilities
export {
  getWeekNumber,
  weekId,
  weekIdForDate,
  getWeekStart,
  getWeekEnd,
  getExpectedBragBookWeeks,
  formatDuration,
} from "./week-utils";

// Template
export { fillTemplate, buildConfigContext } from "./template";

// Vault
export type { VaultPaths, TeamTimelineEntry, TeamTimeline } from "./vault";
export {
  buildVaultPaths,
  readFileOrDefault,
  readMemory,
  readProfile,
  readWorkContext,
  readImpactLog,
  readCoachPersona,
  readFocusTracking,
  readFocusDoc,
  readArchivedFocusDocs,
  readCareerContext,
  getBragBooks,
  getRecentBragBooks,
  getMissingBragBookWeeks,
  discoverWeeklyNotes,
  readTeamTimeline,
  getTeamForDate,
  getCurrentTeam,
  formatTeamTimelineForPrompt,
} from "./vault";
