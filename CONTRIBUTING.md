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

To test the full pipeline you'll need API tokens (Jira, GitHub) and an AI provider login, but most changes can be developed against the vitest suite (`bun run test`) without them. `bun run typecheck` and `bun run lint` are what CI runs.

## Project structure

```
.
├── fetch-weekly-work-log.ts   # CLI entry point (commander) -- wires up the commands below
├── package.json               # bin: worklog, wl; exports: lib/sdk/index.ts
├── commands/                  # CLI surface: prompts, spinners, process.exit
│   ├── worklog.ts             # worklog [generate] -- weekly brag book pipeline
│   ├── prep.ts                # worklog prep <type> -- prep doc generation
│   ├── init.ts                # worklog init -- guided setup, seeds vault docs
│   └── configure.ts           # worklog configure -- update a config section
├── lib/
│   ├── config.ts              # Config schema, load/save (~/.config/worklog/config.json), validators
│   ├── ai-tools.ts            # Research tools (Jira, Confluence, vault) for both AI providers
│   ├── openai-auth.ts         # OpenAI auth resolution (API key or Codex subscription)
│   ├── markdown-to-docx.ts    # --rt output for prep docs
│   ├── types.ts               # API response types (JiraIssue, ConfluencePage, GitHubPR)
│   ├── utils.ts               # extractText, formatDate
│   └── sdk/                   # Core logic, no CLI I/O. Re-exported from lib/sdk/index.ts
│       ├── ai.ts              # aiQuery / aiQueryStructured: Anthropic (Claude Agent SDK) or OpenAI (Vercel AI SDK)
│       ├── data-fetch.ts      # Jira/Confluence/GitHub fetchers, fetchDataForWeek
│       ├── markdown.ts        # Work log markdown from fetched data
│       ├── brag-book-schema.ts # Zod schema the weekly generation is constrained to
│       ├── brag-book.ts       # Schema output -> brag book + memory/focus/context updates
│       ├── vault.ts           # Vault paths and readers (profile, memory, brag books, team timeline)
│       ├── vault-updates.ts   # Write memory/impact-log/work-context/profile/focus-tracking
│       ├── text-similarity.ts # Normalized text and containment score used to spot repeats
│       ├── pricing.ts         # Per-model token rates, for costing a week
│       ├── prep.ts            # Prep types, defaults, prompt builder, output naming
│       ├── doc-generators.ts  # Seed docs written by init (profile, work context, coach persona)
│       ├── template.ts        # {{placeholder}} filling and config-derived context
│       ├── week-utils.ts      # ISO week math
│       └── logger.ts          # --verbose logger
└── prompts/
    ├── weekly-brag-prompt.md          # Brag book generation prompt
    ├── _writing-style.md              # Anti-AI-slop style guide injected into prep prompts
    ├── prep-1on1.md                   # 1:1 prep prompt
    ├── prep-self-review.md            # Self-review prompt (concise)
    ├── prep-self-review-extended.md   # Self-review prompt (full)
    ├── prep-promotion.md              # Promotion case prompt
    ├── prep-skip-level.md             # Skip-level prep prompt
    ├── prep-resume.md                 # Resume bullets prompt
    └── coach-persona.md               # Default coach persona
```

Tests live next to the code in `__tests__/` folders (`lib/__tests__`, `lib/sdk/__tests__`, `commands/__tests__`) and run with vitest + msw for HTTP mocking.

### The end-to-end harness

`commands/__tests__/worklog.e2e.test.ts` runs one week of `runWorklog` over a temp vault.
Everything except the AI provider and the three HTTP APIs is real: the prompt is built, both
documents are written, and all five maintained files go through the writers that ship. Most
of the bugs worth catching here -- a row appended under an archived heading, an item dropped,
a focus status closing something it should not -- do not show up in a unit test.

How it is wired, and why each piece has to be there:

- **Temp `XDG_CONFIG_HOME`** holds `config.json` and `team-timeline.json`. `CONFIG_DIR`,
  `STATS_PATH` and `TEAM_TIMELINE_PATH` are computed in `lib/config.ts` at module load, so
  the env var has to be set *before* the import, hence `vi.resetModules()` and a dynamic
  `await import("../worklog")`.
- **Temp `XDG_CACHE_HOME`** is set even though nothing reads it yet. The moment anything
  caches under it, an unset value writes into the developer's own `~/.cache` during a run.
- **`vi.stubGlobal("Bun", ...)`** because vitest runs on node and the pipeline reads prompts
  and writes stats through `Bun.file` / `Bun.write`.
- **msw with `onUnhandledRequest: "error"`** for Jira, Confluence and GitHub, so a new fetch
  fails the test rather than reaching the network.
- **The AI provider is the only mocked module.** The fake still runs the caller's
  `schema.parse`, because that parse is the real function's last act; a fake that skipped it
  would be testing a contract the pipeline does not have.

- **The vault is seeded with the week's own documents**, not just the five maintained
  files. The run uses `--force`, so a regression that writes before validating would
  destroy them; a test whose target files do not exist yet can only prove that new ones
  were not created, which is a much weaker claim.

To extend it: add a field to `FAKE_OUTPUT` and assert the file it should reach. Keep the
second run, because "regenerating a week changes nothing" is the property most of those bugs
broke. Two known exceptions are pinned in the test itself: the work log carries a
`**Generated:**` timestamp, and `focus-tracking.md` is not yet idempotent.

## Key concepts

**Template system**: Prompt files use `{{placeholder}}` syntax. At runtime, `lib/sdk/template.ts` fills these from config values (career level, company values, etc.) and runtime context (brag book content, date ranges). This keeps prompts shareable -- no personal data in the repo.

**Config-driven personalization**: All user-specific values live in `~/.config/worklog/config.json`, created by `worklog init`. The config schema is defined in `lib/config.ts`. Team history lives beside it in `team-timeline.json`.

**Vault docs**: The AI reads context from markdown files in the user's vault (profile, work context, coach persona). These are seeded at init but owned by the user -- they can edit them freely.

**Research tools**: `lib/ai-tools.ts` defines six tools (Jira, Confluence, vault read/search) once, then adapts them to the Vercel AI SDK for OpenAI and to an in-process MCP server for the Claude Agent SDK. Both providers see the same tool names, which `prompts/weekly-brag-prompt.md` refers to directly.

## Making changes

### Code style

- TypeScript with strict types
- ESM imports
- Bun runtime (not Node)
- `@clack/prompts` for interactive CLI UI
- No build step -- runs directly via `bun`

### Prompt templates

Prompt files live in `prompts/`. They use `{{placeholder}}` syntax for personalization.

Never put personal data (names, company-specific values, career levels) directly in prompt files. Use `{{placeholders}}` that get filled from the user's config at runtime. See `lib/sdk/template.ts` for how this works.

### Adding a new prep type

1. Create a prompt template in `prompts/prep-<type>.md` using `{{placeholder}}` syntax
2. Add the type to `PREP_TYPES`, `DEFAULT_WEEKS`, `OUTPUT_PREFIX`, and `PROMPT_FILE` in `lib/sdk/prep.ts`
3. That's it -- the prep command auto-discovers types from those maps

### Adding new config-driven placeholders

1. Add the field to the `WorklogConfig` interface in `lib/config.ts`
2. Add it to `buildConfigContext()` in `lib/sdk/template.ts`
3. Use `{{your_placeholder}}` in prompt templates
4. Add prompting for the new field in `commands/init.ts`

### Adding a new data source

Fetching lives in `lib/sdk/data-fetch.ts`, organized by source (Jira, Confluence, GitHub). To add a new source:

1. Add a fetch function next to `fetchJiraIssues()` / `fetchGitHubPRs()` / `searchConfluence()`, with an msw-backed test in `lib/sdk/__tests__/data-fetch.test.ts`
2. Add the results to `fetchDataForWeek()` and the `FetchedWeekData` type
3. Add a markdown section in `lib/sdk/markdown.ts`
4. Update `prompts/weekly-brag-prompt.md` if the AI needs to understand the new data

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
