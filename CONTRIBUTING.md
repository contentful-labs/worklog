# Contributing to worklog

How to set up, make changes, and submit PRs.

## Getting started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<you>/worklog.git`
3. Install dependencies: `bun install`
4. Create a branch: `git checkout -b my-feature`

## Development setup

You need [Bun](https://bun.sh) v1.x+ installed. No build step required -- everything runs directly.

```bash
bun install
bun run fetch-weekly-work-log.ts --help
```

To test the full pipeline you'll need API tokens (Jira, GitHub, OpenAI), but many changes can be developed and tested without them.

## Project structure

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
│   ├── ai.ts                  # AI query layer (OpenAI Responses API)
│   ├── ai-tools.ts            # Research tools (Jira, Confluence, vault)
│   ├── vault-readers.ts       # Vault file readers (brag books, context docs)
│   ├── openai-auth.ts         # OpenAI auth resolution (subscription + API key)
│   ├── types.ts               # Shared types (JiraIssue, GitHubPR, etc.)
│   └── utils.ts               # Shared utilities (extractText, formatDate)
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

## Key concepts

**Template system**: Prompt files use `{{placeholder}}` syntax. At runtime, `lib/template.ts` fills these from config values (career level, company values, etc.) and runtime context (brag book content, date ranges). This keeps prompts shareable -- no personal data in the repo.

**Config-driven personalization**: All user-specific values live in `~/.config/worklog/config.json`, created by `worklog init`. The config schema is defined in `lib/config.ts`.

**Vault docs**: The AI reads context from markdown files in the user's vault (profile, work context, coach persona). These are seeded at init but owned by the user -- they can edit them freely.

## Making changes

### Code style

- TypeScript with strict types
- ESM imports
- Bun runtime (not Node)
- `@clack/prompts` for interactive CLI UI
- No build step -- runs directly via `bun`

### Prompt templates

Prompt files live in `prompts/`. They use `{{placeholder}}` syntax for personalization.

Never put personal data (names, company-specific values, career levels) directly in prompt files. Use `{{placeholders}}` that get filled from the user's config at runtime. See `lib/template.ts` for how this works.

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

## Submitting changes

1. Commit with clear messages: `type: description` (e.g., `feat: add linear integration`, `fix: handle empty brag books`)
2. Push your branch and open a pull request
3. Describe what your change does and why
4. Link any relevant issues

### PR guidelines

- Keep PRs focused -- one feature or fix per PR
- If your change affects prompt output, describe the before/after
- If adding a new data source or prep type, include example output in the PR description
- Don't include unrelated formatting or refactoring changes

## Reporting issues

Open an issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce (if applicable)
- Your environment (OS, Bun version)

## Code of conduct

Be respectful and constructive.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
