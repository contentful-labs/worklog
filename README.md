# worklog

Weekly engineering reflection + career coaching from your actual work.

## Why

Performance reviews reward writing skill, not engineering skill. The engineer who documents well gets promoted; the one who ships well but can't articulate it gets overlooked. That's a signal problem, not a performance problem.

Most engineers scramble at review time, trying to remember six months of work from memory. Recency bias takes over -- last month's fire drill dominates while the architectural win from Q1 gets forgotten.

worklog fixes this by building the habit of weekly structured reflection. Every week, it pulls your actual work activity, generates a brag book entry with coaching feedback, and stores everything in a local markdown vault. When review time comes, you have months of evidence ready to go.

## What it does

- Pulls your Jira tickets, GitHub PRs, and Confluence pages weekly
- AI generates a structured brag book entry with mentor-style coaching feedback
- Builds an evidence base for 1:1s, self-reviews, and promotion cases
- Generates prep documents: self-reviews, promotion cases, 1:1 agendas, resume bullets
- Everything stays in a local markdown vault on your machine

## Quick start

```bash
git clone https://github.com/contentful-labs/worklog.git
cd worklog
bun install
worklog init          # guided setup -- creates config + vault docs
worklog               # generate your first brag book
```

## Commands

```
worklog                    Generate weekly brag book(s)
worklog prep 1on1          1:1 meeting prep
worklog prep self-review   Self-review draft
worklog prep promotion     Promotion case
worklog prep skip-level    Skip-level meeting prep
worklog prep resume        Resume bullet points
worklog init               First-time setup
worklog configure          Update settings
```

Short aliases: `wl` for `worklog`, `prep` for `worklog prep`.

### `worklog`

Generate brag books for missing weeks.

```bash
worklog                    # fill gaps from earliest existing brag book
worklog --weeks 4          # last 4 weeks
worklog --week 2026-W07    # specific week
worklog --force            # regenerate even if exists
worklog --since 2025-01-01 # from date to now
```

### `worklog prep <type>`

Generate prep documents from brag book history:

```bash
worklog prep 1on1          # 1:1 meeting prep (default: 4 weeks)
worklog prep self-review   # performance self-review (default: 12 weeks)
worklog prep skip-level    # skip-level meeting prep (default: 4 weeks)
worklog prep promotion     # promotion case (default: 26 weeks)
worklog prep resume        # resume bullet points (default: 26 weeks)
```

Options: `--weeks N`, `--since YYYY-MM-DD`, `--until YYYY-MM-DD`, `--extended`

### `worklog init`

Guided first-run setup. Walks you through connecting APIs, creating your profile, setting up career context, and choosing coaching preferences.

### `worklog configure [section]`

Update any part of your configuration:

```bash
worklog configure          # pick a section interactively
worklog configure ai       # switch between Anthropic and OpenAI
worklog configure profile  # update your profile details
worklog configure career   # update career context
worklog configure vault    # change output directory
worklog configure atlassian
worklog configure github
worklog configure team-history
worklog configure coaching
```

## How it works

1. **Fetch** -- worklog queries Jira, Confluence, and GitHub APIs for your week's activity
2. **Work Log** -- raw data is written as a structured markdown work log
3. **Brag Book** -- AI reads the work log + your context docs and generates a brag book with achievements, a coaching session, and updates to your living documents
4. **Context Updates** -- the AI updates your memory (small contributions), impact log (significant achievements), and focus tracking (week-over-week accountability)

All data stays local. Nothing leaves your machine except API calls to your configured AI provider to generate text, and API calls to Jira/GitHub/Confluence to fetch your own activity.

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.x+
- A markdown vault (any folder -- [Obsidian](https://obsidian.md) recommended but not required)

### Environment variables

| Variable | Required for | How to get it |
|----------|-------------|---------------|
| `ATLASSIAN_API_TOKEN` | Jira/Confluence data | [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `GITHUB_TOKEN` | GitHub PR data | [GitHub tokens](https://github.com/settings/tokens) |
| `ANTHROPIC_API_KEY` | AI (if using Anthropic) | [Anthropic console](https://console.anthropic.com/keys) |
| `OPENAI_API_KEY` | AI (if using OpenAI) | [OpenAI dashboard](https://platform.openai.com/api-keys) |

OpenAI auth note: worklog checks `OPENAI_API_KEY` first, then falls back to `~/.codex/auth.json`. ChatGPT subscription and API billing are separate.

### First-time setup

```bash
worklog init
```

This walks you through vault location, API connections, AI provider, your profile, career level, team history, and coaching preferences.

After init, three markdown files appear in your vault:

- `my-profile.md` -- your background, skills, growth areas
- `work-context.md` -- company values, review cycle, org context
- `coach-persona.md` -- how coaching feedback is delivered

These are plain markdown -- edit them anytime to refine the AI's context.

## Configuration

Config is stored at `~/.config/worklog/config.json` (XDG standard).

Adjacent files:
- `~/.config/worklog/team-timeline.json` -- team history
- `~/.config/worklog/worklog-stats.json` -- run timing statistics

## Vault structure

After setup, your vault contains:

| File | Type | Description |
|------|------|-------------|
| `YYYY-WXX Brag Book.md` | Generated weekly | Achievement summaries + AI coaching session |
| `YYYY-WXX Work Log.md` | Generated weekly | Raw activity data from APIs |
| `my-profile.md` | Created at init | Your profile -- role, skills, growth areas |
| `work-context.md` | Created at init | Company context -- values, review cycle, org notes |
| `coach-persona.md` | Created at init | Coaching style preferences (editable) |
| `memory.md` | Auto-maintained | Small contributions waiting to accumulate |
| `impact-log.md` | Auto-maintained | Significant achievements timeline |
| `focus-tracking.md` | Auto-maintained | Week-over-week focus items |
| `My Focus.md` | User-maintained | Current priorities (optional) |

## Customization

- **Coach persona**: Edit `{vault}/coach-persona.md` to change coaching tone, focus, or style
- **Prompt templates**: In `prompts/` directory -- modify to change brag book or prep doc output format
- **Career docs**: Add paths to career framework docs via `worklog configure career`
- **AI provider**: Switch between Anthropic and OpenAI via `worklog configure ai`

---

## Developer guide

### Project structure

```
.
├── fetch-weekly-work-log.ts   # Main entry point (worklog CLI)
├── generate-prep-doc.ts       # Thin wrapper → commands/prep.ts
├── package.json
├── commands/
│   ├── init.ts                # worklog init -- guided setup
│   ├── configure.ts           # worklog configure -- update settings
│   └── prep.ts                # worklog prep -- prep doc generation
├── lib/
│   ├── config.ts              # Config schema, load/save, validation
│   ├── template.ts            # Prompt template filling ({{placeholders}})
│   ├── ai.ts                  # AI provider abstraction (Anthropic/OpenAI)
│   ├── obsidian-readers.ts    # Vault file readers (brag books, context docs)
│   └── openai-auth.ts         # OpenAI API key resolution
└── prompts/
    ├── weekly-brag-prompt.md          # Brag book generation prompt
    ├── prep-1on1.md                   # 1:1 prep prompt
    ├── prep-self-review.md            # Self-review prompt (concise)
    ├── prep-self-review-extended.md   # Self-review prompt (full)
    ├── prep-promotion.md              # Promotion case prompt
    ├── prep-skip-level.md             # Skip-level prep prompt
    ├── prep-resume.md                 # Resume bullets prompt
    └── coach-persona.md               # Default coach persona
```

### Key concepts

**Template system**: Prompt files use `{{placeholder}}` syntax. At runtime, `lib/template.ts` fills these from config values (career level, company values, etc.) and runtime context (brag book content, date ranges). This keeps prompts shareable -- no personal data in the repo.

**Config-driven personalization**: All user-specific values live in `~/.config/worklog/config.json`, created by `worklog init`. The config schema is defined in `lib/config.ts`.

**Vault docs**: The AI reads context from markdown files in the user's vault (profile, work context, coach persona). These are seeded at init but owned by the user -- they can edit them freely.

### Running locally

```bash
bun install
bun run fetch-weekly-work-log.ts          # or: worklog (if alias is set)
bun run fetch-weekly-work-log.ts prep self-review --weeks 4
```

### Adding a new prep type

1. Create a prompt template in `prompts/prep-<type>.md` using `{{placeholder}}` syntax
2. Add the type to `PREP_TYPES`, `DEFAULT_WEEKS`, `OUTPUT_PREFIX`, and `PROMPT_FILE` in `commands/prep.ts`
3. That's it -- the prep command auto-discovers types from those maps

### Adding new config-driven placeholders

1. Add the field to the `WorklogConfig` interface in `lib/config.ts`
2. Add it to `buildConfigContext()` in `lib/template.ts`
3. Use `{{your_placeholder}}` in prompt templates
4. Add prompting for the new field in `commands/init.ts`

### Adding a new data source

The fetch pipeline in `fetch-weekly-work-log.ts` is organized by source (Jira, Confluence, GitHub). To add a new source:

1. Add a fetch function following the pattern of `fetchJiraIssues()`, `fetchConfluencePages()`, etc.
2. Add the results to `fetchDataForWeek()`
3. Add a markdown section in `generateMarkdown()`
4. Update the prompt template if the AI needs to understand the new data

### Code style

- TypeScript with strict types
- ESM imports
- Bun runtime (not Node)
- `@clack/prompts` for interactive CLI UI
- No build step -- runs directly via `bun`

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Quick contribution checklist

- [ ] Fork the repo and create a feature branch
- [ ] Run `bun install` to set up dependencies
- [ ] Make your changes
- [ ] Ensure no personal data in prompt templates (use `{{placeholders}}`)
- [ ] Test manually with `bun run fetch-weekly-work-log.ts`
- [ ] Open a PR with a clear description of what and why

## License

[MIT](LICENSE)
