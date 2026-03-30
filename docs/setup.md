# Setup

## Prerequisites

- [Bun](https://bun.sh) v1.x+
- A markdown vault (any folder with `.md` files -- [Obsidian](https://obsidian.md) works great but is not required)

## Authentication

worklog supports two AI providers. Select one during `worklog init`.

### Anthropic (Claude) — default

Uses the Claude Agent SDK, which requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

If you already have Claude Code working, worklog piggybacks off your existing authentication — no extra setup needed.

If you don't have Claude Code yet:

```bash
npm install -g @anthropic-ai/claude-code
claude                      # follow the prompts to authenticate
```

Claude Code supports multiple auth methods (Claude Max subscription, API key, etc.) — any of them will work with worklog.

```bash
claude /doctor              # verify everything is working
worklog init                # select "Anthropic (Claude)"
```

### OpenAI

#### ChatGPT subscription (recommended)

Use your existing ChatGPT Plus, Business, or Pro plan. No separate API billing.

```bash
npx codex@latest login    # opens browser — sign in with your ChatGPT account
worklog init               # select "OpenAI"
```

Tokens cache locally at `~/.codex/auth.json` and refresh automatically.

#### API key

For direct API billing through the OpenAI Platform.

```bash
export OPENAI_API_KEY="sk-..."
worklog init               # select "OpenAI"
```

Get an API key at https://platform.openai.com/api-keys

## Environment variables

| Variable | Required for | How to get it |
|----------|-------------|---------------|
| `ATLASSIAN_API_TOKEN` | Jira/Confluence data | [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `GITHUB_TOKEN` | GitHub PR data | [GitHub tokens](https://github.com/settings/tokens) |
| `OPENAI_API_KEY` | AI — OpenAI (only if not using ChatGPT subscription) | [OpenAI dashboard](https://platform.openai.com/api-keys) |

## First-time setup

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
