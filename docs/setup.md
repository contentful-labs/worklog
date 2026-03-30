# Setup

## Prerequisites

- [Bun](https://bun.sh) v1.x+
- A markdown vault (any folder with `.md` files -- [Obsidian](https://obsidian.md) works great but is not required)

## Authentication

worklog supports two AI providers. Select one during `worklog init`.

### Anthropic (Claude) — default

Uses the Claude Agent SDK. Two auth methods:

#### Claude Code CLI (recommended for Claude Max subscribers)

If you have Claude Code installed and authenticated, it works automatically.

```bash
claude /doctor              # verify Claude Code is working
worklog init                # select "Anthropic (Claude)"
```

#### API key

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
worklog init                # select "Anthropic (Claude)"
```

Get an API key at https://console.anthropic.com/settings/keys

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
| `ANTHROPIC_API_KEY` | AI — Anthropic (only if not using Claude Code CLI) | [Anthropic console](https://console.anthropic.com/settings/keys) |
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
