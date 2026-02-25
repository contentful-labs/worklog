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

## Making changes

### Prompt templates

Prompt files live in `prompts/`. They use `{{placeholder}}` syntax for personalization.

**Important**: Never put personal data (names, company-specific values, career levels) directly in prompt files. Use `{{placeholders}}` that get filled from the user's config at runtime. See `lib/template.ts` for how this works.

### Code changes

- Write TypeScript with strict types
- Use ESM imports
- Keep functions focused -- the codebase is intentionally straightforward
- Use `@clack/prompts` for any interactive CLI output
- No build step -- code must run directly with `bun`

### Adding features

- **New prep type**: Add a prompt template + entries in the type maps in `commands/prep.ts`
- **New config field**: Update `WorklogConfig` in `lib/config.ts`, add to `buildConfigContext()` in `lib/template.ts`, add prompting in `commands/init.ts`
- **New data source**: Add fetch function in `fetch-weekly-work-log.ts`, wire into `fetchDataForWeek()` and `generateMarkdown()`

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
