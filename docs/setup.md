# Setup

## Prerequisites

- [Bun](https://bun.sh) v1.x+
- A markdown vault (any folder with `.md` files -- [Obsidian](https://obsidian.md) works great but is not required)

## Authentication

worklog supports two AI providers. Select one during `worklog init`.

### Anthropic (Claude) — default

Uses the Claude Agent SDK. Two ways to authenticate:

#### API key

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
worklog init                # select "Anthropic (Claude)"
```

Get an API key at https://console.anthropic.com/settings/keys

#### Claude Code CLI

If you already have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated, worklog piggybacks off your existing session — no extra setup needed.

```bash
claude /doctor              # verify Claude Code is working
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

## Slack (optional)

Slack has no API token here. worklog reaches it through Glean, and the only client that can talk
to Glean is the Claude Code CLI with its Glean MCP server connected. So the Slack source is on
when both of these are true, and silently off otherwise:

```bash
command -v claude                # the CLI is installed and on PATH
claude mcp get glean_default     # prints "Connected"
```

If Glean is not connected, run `claude mcp login glean_default`.

What to expect when it is on:

- Each week's work log gains a `## Slack` section listing your own public-channel messages,
  grouped by channel, with permalinks and timestamps. DMs and private channels are excluded.
- At most 60 messages per week.
- The fetch is an LLM query, so it is slow and its wording varies between runs. A measured week
  took just under three minutes; the source gives up after four. A failed or unparseable answer
  costs you the Slack section for that week and nothing else.
- Slack material reaches the coach as context (decisions made, people unblocked, influence
  shown), not as achievement evidence unless Jira, GitHub or Confluence corroborates it.

When the source is unavailable, worklog prints one `Slack source skipped: <reason>` line per run
and the output is exactly what it was before the source existed.

## Environment variables

| Variable | Required for | How to get it |
|----------|-------------|---------------|
| `ATLASSIAN_API_TOKEN` | Jira/Confluence data | [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `GITHUB_TOKEN` | GitHub PR data | [GitHub tokens](https://github.com/settings/tokens) |
| `ANTHROPIC_API_KEY` | AI — Anthropic (if not using Claude Code CLI) | [Anthropic console](https://console.anthropic.com/settings/keys) |
| `OPENAI_API_KEY` | AI — OpenAI (if not using ChatGPT subscription) | [OpenAI dashboard](https://platform.openai.com/api-keys) |

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
