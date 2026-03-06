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

// AI
export type { AIQueryOptions } from "./ai";
export { aiQuery, postProcess } from "./ai";

// Markdown generation
export { generateMarkdown } from "./markdown";

// Brag book parsing
export type { BragBookResult, ReviewInfo } from "./brag-book";
export { parseBragBookResult, getPendingFocusItems, parseReviewCycle } from "./brag-book";

// Prep doc generation
export type { PrepType, PrepContext, PrepOptions } from "./prep";
export {
  PREP_TYPES, DEFAULT_WEEKS, OUTPUT_PREFIX, PROMPT_FILE,
  getDateRange, buildPrepPrompt, getPromptFile, ensureFrontmatter, buildOutputFilename,
} from "./prep";

// Vault updates
export { updateMemory, updateImpactLog, updateWorkContext, updateProfile, updateFocusTracking } from "./vault-updates";

// Data fetching
export type { FetchCredentials, FetchHeaders, WeekInfo, PRReview, FetchedWeekData } from "./data-fetch";
export {
  buildHeaders,
  getAccountId,
  getGitHubUsername,
  searchConfluence,
  fetchDataForWeek,
} from "./data-fetch";

// Doc generators
export { generateProfileDoc, generateWorkContextDoc, generateCoachPersonaDoc } from "./doc-generators";
