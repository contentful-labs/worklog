# worklog

A weekly 5-minute habit that turns your Jira/GitHub/Confluence activity into a brag book with career coaching.

## Why

You should be judged on your performance, not your writing skills or your memory. But that's exactly what happens when review time comes and you're staring at a blank self-review trying to reconstruct six months of work.

worklog makes sure neither your memory nor your writing get in the way of showing the great work you actually did. It's a weekly ritual — every Friday you run it, it pulls your Jira tickets, GitHub PRs, and Confluence pages, asks you what else happened, and turns all of that into a brag book entry with coaching feedback.

5 minutes a week. That's the whole commitment. Schedule it, do it, move on. Your brag book builds itself week by week.

You *can* generate retroactively for past weeks — and it works fine for that. But the real value comes from the weekly habit, when the details are still fresh and you can add the context that matters.

## What it does

- Pulls your Jira tickets, GitHub PRs, and Confluence pages each week
- Generates a brag book entry with coaching feedback
- Generates prep docs for 1:1s, self-reviews, promotion cases, and resume bullets
- Everything stays local in a markdown vault on your machine

## Quick start

Requires [Bun](https://bun.sh) v1.x+.

```bash
# One-time registry setup for GitHub Packages
echo "@contentful-labs:registry=https://npm.pkg.github.com" >> ~/.npmrc

# Install
npm install -g @contentful-labs/worklog   # or: bun install -g @contentful-labs/worklog

# Setup and first run
worklog init          # guided setup -- creates config + vault docs
worklog               # generate your first brag book
```

That's your first entry done. From here, the workflow is: run `worklog` each Friday, add context when prompted, and you're done for the week.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/contentful-labs/worklog.git
cd worklog
bun install
bun link              # puts `worklog` and `wl` in your PATH
```
</details>

When performance review time comes around, run one command:

```bash
worklog prep self-review
```

It reads your brag book history and drafts a self-review. If there are weeks you skipped, it walks through them first — pulling your activity and generating the missing entries before writing the review.

![worklog run](assets/worklog-run.jpeg)

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

Guided first-run setup. Connects your APIs, creates your profile, and sets up career context and coaching preferences.

### `worklog configure [section]`

Update any part of your configuration:

```bash
worklog configure          # pick a section interactively
worklog configure ai       # change authentication method or model
worklog configure profile  # update your profile details
worklog configure career   # update career context
worklog configure vault    # change output directory
worklog configure atlassian
worklog configure github
worklog configure team-history
worklog configure coaching
```

## How it works

1. Fetches your week's activity from Jira, Confluence, and GitHub
2. Asks you what else happened — decisions, conversations, context the tools couldn't capture
3. Writes a structured markdown work log from all of that
4. Reads the work log + your context docs and generates a brag book with achievements and a coaching session
5. Updates your running docs: memory (small contributions), impact log (big wins), and focus tracking (week-over-week accountability)

All data stays local. Nothing leaves your machine except API calls to OpenAI to generate text, and API calls to Jira/GitHub/Confluence to fetch your own activity.

## Weekly workflow

1. Schedule 5 minutes Friday afternoon
2. Run `worklog`
3. When prompted, type what the tools missed — a conversation that shifted direction, a decision you drove, context that matters
4. Done. Your brag book builds itself week by week.

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.x+
- A markdown vault (any folder -- [Obsidian](https://obsidian.md) recommended but not required)

### Authentication

worklog supports two ways to authenticate with OpenAI:

**ChatGPT subscription (recommended)**

Use your existing ChatGPT Plus, Business, or Pro plan. No separate API billing.

```bash
npx codex@latest login    # opens browser — sign in with your ChatGPT account
worklog init               # select "ChatGPT subscription"
```

Tokens cache locally at `~/.codex/auth.json` and refresh automatically.

**API key**

For direct API billing through the OpenAI Platform.

```bash
export OPENAI_API_KEY="sk-..."
worklog init               # select "API key"
```

Get an API key at https://platform.openai.com/api-keys

### Environment variables

| Variable | Required for | How to get it |
|----------|-------------|---------------|
| `ATLASSIAN_API_TOKEN` | Jira/Confluence data | [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `GITHUB_TOKEN` | GitHub PR data | [GitHub tokens](https://github.com/settings/tokens) |
| `OPENAI_API_KEY` | AI (only for API key auth) | [OpenAI dashboard](https://platform.openai.com/api-keys) |

### First-time setup

```bash
worklog init
```

This walks you through vault location, API connections, authentication, profile, and career setup.

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
| `YYYY-WXX Brag Book.md` | Generated weekly | Achievement summaries + coaching session |
| `YYYY-WXX Work Log.md` | Generated weekly | Raw activity data from APIs |
| `my-profile.md` | Created at init | Your profile -- role, skills, growth areas |
| `work-context.md` | Created at init | Company context -- values, review cycle, org notes |
| `coach-persona.md` | Created at init | Coaching style preferences (editable) |
| `memory.md` | Auto-maintained | Small contributions waiting to accumulate |
| `impact-log.md` | Auto-maintained | Significant achievements timeline |
| `focus-tracking.md` | Auto-maintained | Week-over-week focus items |
| `My Focus.md` | User-maintained | Current priorities (optional) |

## Customization

- Edit `{vault}/coach-persona.md` to change coaching tone and style
- Modify prompt templates in `prompts/` to change brag book or prep doc output
- Add career framework docs via `worklog configure career`
- Change auth method or model via `worklog configure ai`

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
│   ├── ai.ts                  # AI query layer (OpenAI Agents SDK)
│   ├── obsidian-readers.ts    # Vault file readers (brag books, context docs)
│   └── openai-auth.ts         # OpenAI auth resolution (subscription + API key)
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

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Quick contribution checklist

- [ ] Fork the repo and create a feature branch
- [ ] Run `bun install` to set up dependencies
- [ ] Make your changes
- [ ] Ensure no personal data in prompt templates (use `{{placeholders}}`)
- [ ] Test manually with `bun run fetch-weekly-work-log.ts`
- [ ] Open a PR with a clear description of what and why

## License

[MIT](LICENSE)
