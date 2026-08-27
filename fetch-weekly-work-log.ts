#!/usr/bin/env bun

import { Command } from "commander";
import { runInit } from "./commands/init";
import { runConfigure } from "./commands/configure";
import { makePrepCommand } from "./commands/prep";
import { makeWorklogCommand } from "./commands/worklog";
import { makeRefreshCommand } from "./commands/refresh";

const program = new Command("worklog")
  .description("A weekly 5-minute habit that turns your Jira/GitHub/Confluence activity into a brag book with career coaching.")
  .allowExcessArguments(false);

// Default action: run worklog (gap-fill)
const worklogCmd = makeWorklogCommand();
program.addCommand(worklogCmd, { isDefault: true });

// worklog refresh
program.addCommand(makeRefreshCommand());

// worklog prep <type>
program.addCommand(makePrepCommand());

// worklog init
program
  .command("init")
  .description("Guided first-run setup")
  .option("--dry-run", "Preview setup without writing any files", false)
  .action(async (opts) => {
    await runInit({ dryRun: opts.dryRun });
  });

// worklog configure [section]
const configureCmd = new Command("configure")
  .alias("config")
  .description("Update configuration settings")
  .argument("[section]", "Section to configure: vault, ai, atlassian, github, profile, career, team-history, coaching")
  .addHelpText("after", `
Sections:
  vault         Output directory
  ai            Authentication method and model
  atlassian     Jira/Confluence connection
  github        GitHub orgs to track
  profile       Your profile details
  career        Career context and framework
  team-history  Team timeline and transitions
  coaching      Coaching tone and focus areas`)
  .action(async (section?: string) => {
    await runConfigure(section);
  });

program.addCommand(configureCmd);

program.parseAsync(process.argv).catch((err) => {
  console.error(String(err));
  process.exit(1);
});
