import { describe, it, expect } from "vitest";
import * as sdk from "../index";

describe("SDK barrel exports", () => {
  it("exports week utilities", () => {
    expect(sdk.getWeekNumber).toBeTypeOf("function");
    expect(sdk.weekId).toBeTypeOf("function");
    expect(sdk.weekIdForDate).toBeTypeOf("function");
    expect(sdk.getWeekStart).toBeTypeOf("function");
    expect(sdk.getWeekEnd).toBeTypeOf("function");
    expect(sdk.getExpectedBragBookWeeks).toBeTypeOf("function");
    expect(sdk.formatDuration).toBeTypeOf("function");
  });

  it("exports template utilities", () => {
    expect(sdk.fillTemplate).toBeTypeOf("function");
    expect(sdk.buildConfigContext).toBeTypeOf("function");
  });

  it("exports vault readers", () => {
    expect(sdk.buildVaultPaths).toBeTypeOf("function");
    expect(sdk.readFileOrDefault).toBeTypeOf("function");
    expect(sdk.readMemory).toBeTypeOf("function");
    expect(sdk.readProfile).toBeTypeOf("function");
    expect(sdk.readWorkContext).toBeTypeOf("function");
    expect(sdk.readImpactLog).toBeTypeOf("function");
    expect(sdk.readCoachPersona).toBeTypeOf("function");
    expect(sdk.readFocusTracking).toBeTypeOf("function");
    expect(sdk.readFocusDoc).toBeTypeOf("function");
    expect(sdk.readArchivedFocusDocs).toBeTypeOf("function");
    expect(sdk.readCareerContext).toBeTypeOf("function");
    expect(sdk.getBragBooks).toBeTypeOf("function");
    expect(sdk.getRecentBragBooks).toBeTypeOf("function");
    expect(sdk.getMissingBragBookWeeks).toBeTypeOf("function");
    expect(sdk.discoverWeeklyNotes).toBeTypeOf("function");
    expect(sdk.readTeamTimeline).toBeTypeOf("function");
    expect(sdk.getTeamForDate).toBeTypeOf("function");
    expect(sdk.getCurrentTeam).toBeTypeOf("function");
    expect(sdk.formatTeamTimelineForPrompt).toBeTypeOf("function");
  });

  it("exports AI functions", () => {
    expect(sdk.aiQuery).toBeTypeOf("function");
    expect(sdk.postProcess).toBeTypeOf("function");
  });

  it("exports markdown generation", () => {
    expect(sdk.generateMarkdown).toBeTypeOf("function");
  });

  it("exports brag book parsing", () => {
    expect(sdk.parseBragBookResult).toBeTypeOf("function");
    expect(sdk.getPendingFocusItems).toBeTypeOf("function");
    expect(sdk.parseReviewCycle).toBeTypeOf("function");
  });

  it("exports prep doc utilities", () => {
    expect(sdk.PREP_TYPES).toBeDefined();
    expect(sdk.DEFAULT_WEEKS).toBeDefined();
    expect(sdk.OUTPUT_PREFIX).toBeDefined();
    expect(sdk.PROMPT_FILE).toBeDefined();
    expect(sdk.getDateRange).toBeTypeOf("function");
    expect(sdk.buildPrepPrompt).toBeTypeOf("function");
    expect(sdk.getPromptFile).toBeTypeOf("function");
    expect(sdk.ensureFrontmatter).toBeTypeOf("function");
    expect(sdk.buildOutputFilename).toBeTypeOf("function");
  });

  it("exports vault update functions", () => {
    expect(sdk.updateMemory).toBeTypeOf("function");
    expect(sdk.updateImpactLog).toBeTypeOf("function");
    expect(sdk.updateWorkContext).toBeTypeOf("function");
    expect(sdk.updateProfile).toBeTypeOf("function");
    expect(sdk.updateFocusTracking).toBeTypeOf("function");
  });

  it("exports data fetching functions", () => {
    expect(sdk.buildHeaders).toBeTypeOf("function");
    expect(sdk.getAccountId).toBeTypeOf("function");
    expect(sdk.getGitHubUsername).toBeTypeOf("function");
    expect(sdk.searchConfluence).toBeTypeOf("function");
    expect(sdk.fetchDataForWeek).toBeTypeOf("function");
  });

  it("exports doc generators", () => {
    expect(sdk.generateProfileDoc).toBeTypeOf("function");
    expect(sdk.generateWorkContextDoc).toBeTypeOf("function");
    expect(sdk.generateCoachPersonaDoc).toBeTypeOf("function");
  });
});
