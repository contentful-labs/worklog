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
  dropDatedRowsBefore,
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
export { parseBragBookResult, parseReviewCycle, ensureBragBookFrontmatter } from "./brag-book";

// Focus tracking
export type {
  FocusItem, FocusStatusUpdate, ApplyFocusOptions, ApplyFocusResult, NearDuplicateFocusItem,
  FocusMigrationResult,
} from "./focus";
export {
  FOCUS_OPEN_STATUS, FOCUS_ONGOING_STATUS, FOCUS_LAPSED_STATUS, FOCUS_TRACKING_TEMPLATE,
  DEFAULT_LAPSE_AFTER, DEFAULT_INJECT_CAP, isOpenFocusStatus,
  normalizeFocusText, focusSimilarity, parseFocusItems, needsFocusMigration,
  migrateFocusTracking, lapseStaleOpenFocusItems, needsFocusFormatUpgrade, upgradeFocusFormat, focusFormatVersion, FOCUS_FORMAT_VERSION,
  selectOpenFocusItems, summarizeFocusHistory, applyFocusUpdates,
} from "./focus";

// Markdown tables
export type { TableBounds } from "./markdown-table";
export type { ScannedRow } from "./markdown-table";
export {
  isTableSeparator, splitRow, scanRow, escapeCell, renderRow, renderScannedRow,
  appendToFirstTable, findTable,
} from "./markdown-table";

// Text similarity
export { SIMILARITY_THRESHOLD, LOOKUP_MARGIN, canonicalText, normalizeText, textSimilarity } from "./text-similarity";

// Prep doc generation
export type { PrepType, PrepContext, PrepOptions } from "./prep";
export {
  PREP_TYPES, DEFAULT_WEEKS, OUTPUT_PREFIX, PROMPT_FILE,
  getDateRange, buildPrepPrompt, getPromptFile, ensureFrontmatter, buildOutputFilename,
} from "./prep";

// Vault updates
export type {
  FocusFileMigration, VaultWriteResult, VaultWriteStatus, MemoryWriteResult, UnmatchedGraduation,
  VaultRecordKind, VaultRecordsMigration,
} from "./vault-updates";
export {
  updateMemory, updateImpactLog, updateWorkContext, updateProfile,
  updateFocusTracking, migrateFocusTrackingFile, migrateVaultRecordsFile, isPlaceholder,
} from "./vault-updates";

// Data fetching
export type { FetchCredentials, FetchHeaders, WeekInfo, PRReview, FetchedWeekData, FetchWeekOptions } from "./data-fetch";
export {
  JIRA_ISSUE_FIELDS,
  buildHeaders,
  getAccountId,
  getGitHubUsername,
  searchConfluence,
  fetchJiraIssues,
  fetchGitHubPRs,
  buildTeamSprintJql,
  fetchDataForWeek,
} from "./data-fetch";

// Doc generators
export { generateProfileDoc, generateWorkContextDoc, generateCoachPersonaDoc } from "./doc-generators";
