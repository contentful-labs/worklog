import * as p from "@clack/prompts";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  requireConfig,
  saveConfig,
  getConfigPath,
  TEAM_TIMELINE_PATH,
} from "../lib/config";
import type { WorklogConfig } from "../lib/config";
import type { TeamTimeline } from "../lib/obsidian-readers";
import {
  promptVault,
  promptAI,
  promptAtlassian,
  promptGitHub,
  promptProfile,
  promptCareer,
  promptTeamHistory,
  promptCoaching,
} from "./init";

function cancelGuard(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}

const SECTIONS = [
  "vault",
  "ai",
  "atlassian",
  "github",
  "profile",
  "career",
  "team-history",
  "coaching",
] as const;

type Section = (typeof SECTIONS)[number];

async function pickSection(): Promise<Section> {
  const choice = await p.select({
    message: "Which section to configure?",
    options: SECTIONS.map((s) => ({ value: s, label: s })),
  });
  cancelGuard(choice);
  return choice as Section;
}

async function offerDocRegeneration(
  config: WorklogConfig,
  docName: string,
  generator: (config: WorklogConfig) => string
): Promise<void> {
  const docPath = join(config.vault, docName);
  if (!existsSync(docPath)) return;

  const regen = await p.confirm({
    message: `Regenerate ${docName}? (your edits will be overwritten)`,
    initialValue: false,
  });
  cancelGuard(regen);

  if (regen) {
    await Bun.write(docPath, generator(config));
    p.log.success(`Regenerated ${docPath}`);
  }
}

export async function runConfigure(section?: string): Promise<void> {
  p.intro("worklog configure");

  const config = requireConfig();
  const targetSection: Section = section
    ? (section as Section)
    : await pickSection();

  if (!SECTIONS.includes(targetSection as Section)) {
    p.log.error(
      `Unknown section: ${targetSection}. Valid: ${SECTIONS.join(", ")}`
    );
    process.exit(1);
  }

  switch (targetSection) {
    case "vault": {
      config.vault = await promptVault(config.vault);
      break;
    }
    case "ai": {
      config.ai = await promptAI(config.ai);
      break;
    }
    case "atlassian": {
      config.atlassian = await promptAtlassian(config.atlassian);
      break;
    }
    case "github": {
      config.githubOrgs = await promptGitHub(config.githubOrgs);
      break;
    }
    case "profile": {
      config.profile = await promptProfile(config.profile);
      break;
    }
    case "career": {
      config.career = await promptCareer(config.career);
      break;
    }
    case "team-history": {
      let timeline: TeamTimeline = { entries: [], transitionNotes: [] };
      if (existsSync(TEAM_TIMELINE_PATH)) {
        try {
          timeline = JSON.parse(
            require("fs").readFileSync(TEAM_TIMELINE_PATH, "utf-8")
          );
        } catch {}
      }
      const updated = await promptTeamHistory(timeline);
      await Bun.write(
        TEAM_TIMELINE_PATH,
        JSON.stringify(updated, null, 2) + "\n"
      );
      p.log.success(`Team timeline saved to ${TEAM_TIMELINE_PATH}`);
      break;
    }
    case "coaching": {
      config.coaching = await promptCoaching(config.coaching);
      break;
    }
  }

  saveConfig(config);
  p.log.success(`Config saved to ${getConfigPath()}`);
  p.outro("Done");
}
