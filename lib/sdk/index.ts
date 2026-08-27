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
export type { AIQueryOptions, StructuredQueryOptions } from "./ai";
export { aiQuery, aiQueryStructured, postProcess, toAnthropicJsonSchema } from "./ai";

// Markdown generation
export { generateMarkdown } from "./markdown";

// Brag book result
export type { BragBookResult, ReviewInfo } from "./brag-book";
export { toBragBookResult, validateBragBookMarkdown, parseReviewCycle, ensureBragBookFrontmatter } from "./brag-book";

// Brag book output schema
export type { BragBookOutput, MemoryItem, MemoryGraduation, FocusStatus } from "./brag-book-schema";
export {
  FOCUS_STATUSES, IMPACT_SCOPES, MAX_NEW_FOCUS_ITEMS,
  bragBookOutputSchema, memoryItemSchema, memoryGraduationSchema,
  impactLogEntrySchema, workContextUpdateSchema, profileUpdateSchema, focusStatusSchema,
  isFocusItemId, bragBookMarkdownProblem,
} from "./brag-book-schema";

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
export {
  SIMILARITY_THRESHOLD, LOOKUP_MARGIN, canonicalText, exactText, normalizeText, textSimilarity,
} from "./text-similarity";

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
  updateFocusTracking, migrateFocusTrackingFile, migrateVaultRecordsFile, isPlaceholder, isIsoDate,
  writeFileAtomic,
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

// Sources
export type {
  Source, SourceAvailability, SourceBatch, SourceContext, SourceEvent, SourceSnapshot,
} from "./sources";
export type { ProcessRunner, RunResult, SlackMessage } from "./sources/slack";
export { SLACK_SOURCE_NAME, createSlackSource, slackMessagesFrom, slackSource } from "./sources/slack";

// Doc generators
export { generateProfileDoc, generateWorkContextDoc, generateCoachPersonaDoc } from "./doc-generators";
