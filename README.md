# mla: the coordination layer for your coding agents

**Claude Code owns code. `mla` owns coordination.**

`mla` (short for **Meetless Agent**) is the command-line client for Meetless. It
keeps your AI coding agents grounded in the architecture you approved, captures
the decisions they make each session, flags when a new session contradicts a
settled one, and lets you approve what becomes project truth for every run that
follows.

## The problem

Coding agents are fast, but they forget. Every session starts cold. The agent
re-derives architecture you already settled, quietly makes decisions you never
see, and contradicts choices from last week because nothing carried them forward.
You spend your turns re-explaining context instead of shipping, and the agent
drifts a little further from the design each time.

The code has a system of record: git. The decisions behind the code do not. That
gap is where rework comes from.

## What `mla` does

`mla` is the system of record for the decisions. It sits between you and your
coding agents and runs a tight loop:

1. **Capture.** Every session's decisions are recorded as governed memory, with
   the evidence behind them, not buried in a transcript you will never reread.
2. **Ground.** Before an agent acts, it retrieves the approved architecture and
   prior decisions, so it builds on settled ground instead of guessing.
3. **Catch contradictions.** When a new session cuts against a decision you
   already made, `mla` surfaces the conflict instead of letting it ship silently.
4. **Approve.** You decide what becomes project truth. Approved decisions feed
   forward into every future run; the rest stays out of the agent's way.

The result: less context re-explaining, fewer reversals, and agents that stay on
the architecture you actually chose.

## MCP server

`mla` ships an MCP server (`meetless-mcp`) so any MCP-capable agent (Claude Code
and others) can read governed memory directly. It exposes the retrieval surface
your agent needs: pull raw evidence with citations, open the full text behind a
citation, and run a synthesized lookup when you want an answer rather than the
sources. Point your agent at it once and grounding happens on every turn.

## Quickstart

Install with the one-liner:

```bash
curl -fsSL https://meetless.ai/install.sh | sh
```

Prefer a package manager? Both pull the same signed release:

```bash
npm install -g @meetless/mla            # npm (needs Node 18+)
brew install --cask meetless/tap/mla    # Homebrew (macOS, Apple Silicon)
```

Then sign in and verify:

```bash
mla login      # browser OAuth; audits every action as you
mla doctor     # verify backends, auth mode, and the MCP wiring
```

## Packages

This repository is a single, self-contained pnpm workspace: the `mla` CLI plus the
support packages it builds on. It builds and its tests pass standalone, with no
other repository required.

| Dir | Package | What |
|---|---|---|
| `packages/cli` | `@meetless/mla` (bin `mla`) | the CLI |
| `packages/ask-core` | `@meetless/ask-core` | shared env-free ask impl (also used by the MCP) |
| `packages/trace-core` | `@meetless/trace-core` | observability spine |
| `packages/mcp` | `@meetless/mcp` (bin `meetless-mcp`) | MCP server |

## Develop

```bash
pnpm install
pnpm build      # builds trace-core then the CLI (topological)
pnpm test       # builds, then runs all four test suites
node packages/cli/dist/cli.js   # run the CLI
```

## Authentication

`mla` talks to two backends: `control` (the system of record) and `intel` (the AI
runtime). How it authenticates to `control` is recorded in
`~/.meetless/cli-config.json` under a single `auth` object with one of three modes:

| Mode | Set by | Identity | Use |
|---|---|---|---|
| `user-token` | `mla login` (browser OAuth) | a real Console user | default for a human operator; actions are audited as you |
| `shared-key` | `mla init --control-token <key>` | none (the workspace internal key) | CI and headless automation; no per-user identity |
| `none` | `mla logout`, or never logged in | none | terminal state; control and intel calls fail fast with "not logged in" |

- **`mla login`** opens the Console authorize page in your browser, completes a
  loopback PKCE (S256) flow, and writes a `user-token` (a short-lived access token
  plus a 90-day refresh token). Access tokens auto-refresh on a 401, so you do not
  re-auth until the refresh token expires. Use `--no-browser` to print the URL
  instead of opening it.
- **`mla whoami`** prints the identity behind the current config (user, mode, token
  runway) without ever revealing the token.
- **`mla logout`** revokes the session server-side and writes `{ mode: 'none' }`.
  It works even with an expired access token (it proves possession with the refresh
  token), so a removed or demoted user can always log out cleanly.
- **`mla doctor`** prints the active auth mode on one line.

### Environment overrides

Two non-credential aliases select WHICH backend, never WHO you are, and are honored
in every mode:

- `MEETLESS_BACKEND_URL` overrides the `control` URL.
- `MEETLESS_INTEL_URL` overrides the `intel` URL.

`MEETLESS_CONTROL_TOKEN` is a shared-key credential. It is honored under `none` and
`shared-key` (the CI path), but **once you have run `mla login` (mode `user-token`)
it is a hard error**: `readConfig()` throws before issuing any request rather than
silently downgrade your audited identity to the anonymous shared key. Run
`mla logout` (or `unset MEETLESS_CONTROL_TOKEN`) first.

## Telemetry & privacy

Local-first by default: crash reporting is off unless a Sentry DSN is configured,
and run traces (when a backend enables them) go only to your own control server,
never to Meetless. Disable both with `MEETLESS_TELEMETRY=off`. Full details in
[TELEMETRY.md](TELEMETRY.md).

## Community

Building with coding agents and want them to stop drifting? Come talk to us.

- **Discord:** https://discord.gg/bfYNHqwHMJ
- **Feedback & ideas:** https://github.com/meetless/feedback

## Where this is going

The wedge is coordination between you and your coding agents. The same governed
decisions extend to coordination across a team: when several people (and their
agents) work the same codebase, everyone builds on the same approved truth instead
of re-litigating it in the next session, the next PR, or the next meeting. Less
rework, fewer reversals, fewer meetings. That is the point of the name.
