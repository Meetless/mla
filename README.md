# mla: the coordination layer for your coding agents

**Your coding agent owns code. `mla` owns coordination.**

Works with **Claude Code** and **OpenAI Codex**.

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

## Supported coding agents

`mla` governs both major coding-agent CLIs through one neutral decision core. The
loop above is identical for each; only the wiring differs.

| Agent | Grounding | Governed retrieval | Pre-execution enforcement | Install |
|---|---|---|---|---|
| Claude Code | `UserPromptSubmit` floor injection | MCP (`meetless-mcp`) | `PreToolUse` | `mla activate` |
| OpenAI Codex | `UserPromptSubmit` floor injection | MCP (`meetless-mcp`) | `PreToolUse` | `mla codex install` |

These are siblings, not alternatives. Install both and each agent is governed by
the same approved decisions, because the decision logic lives in the core rather
than in either connector.

### OpenAI Codex

Tested against Codex CLI `0.144.6`.

```bash
# 1. Register the MCP server so Codex can retrieve governed knowledge.
codex plugin add mla@meetless

# 2. Register the Codex hooks (writes $CODEX_HOME/hooks.json). Idempotent.
mla codex install

# 3. In Codex, grant hook trust once:
#      codex  ->  /hooks  ->  review the MLA commands  ->  grant trust

# 4. Bind the repo, then verify both halves are live.
mla activate
mla doctor
```

Codex support has two independent halves (hooks and MCP), so `mla doctor` reports
it as three checks: `codex.hooks.registered`, `codex.mcp.registered`, and
`codex.connector.complete`. A half-finished setup fails the doctor visibly
instead of looking healthy.

`mla codex uninstall` removes only the Meetless entries from
`$CODEX_HOME/hooks.json`, leaving your own hooks and your Claude Code wiring
intact.

#### What enforcement actually does today

Two statements we do not soften anywhere.

**Hooks fail open until you trust them.** While Codex hooks are untrusted, Codex
silently skips them: governance is inactive and tool execution proceeds normally.
`mla codex install` prints "registered, execution not verified" and claims
nothing stronger. Governance goes live when you run `/hooks` and grant trust.

**Enforcement is advisory by default.** `mla` ships a four-rung ceiling
(`observe`, `warn`, `ask`, `deny`) and clamps every rule to `warn`. That is a
deliberate owner ruling: ship warn first, ramp to blocking as adoption earns
trust. Raise the cap for a session with `MEETLESS_ACTION_INTERCEPT_MAX=deny`.
Today exactly one rule family hard-denies before execution (the notes-location
rule); every other family surfaces evidence and warns. Nothing reverts a write
after the fact. This is a governance control, not a security boundary.

Codex `0.144.6` does not support `permissionDecision: "ask"` on `PreToolUse` and
treats it as a hook failure, so the connector converts an `ask` result into a
deny that carries the explanatory reason. `warn` and `deny` behave normally, and
Claude Code still receives the native `ask`.

Denied and warned attempts are captured as enforcement incidents and surfaced by
`mla enforcement --all`.

## MCP server

`mla` ships an MCP server (`meetless-mcp`) so any MCP-capable agent (Claude Code,
Codex, and others) can read governed memory directly. It exposes the retrieval surface
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

## Platforms

`mla` is tested on **macOS** and **Linux**. Windows is **community-supported**: it
runs under [WSL](https://learn.microsoft.com/windows/wsl/), and that is the
recommended path. Inside your WSL distro, install and use it exactly as on Linux.

If a coding agent drives `mla` from the **Windows** side (Git Bash / PowerShell)
instead of from inside WSL, call it through WSL and single-quote the argument so
the path is not rewritten to `C:/Program Files/...` before it reaches WSL:

```sh
wsl -e bash -c '$HOME/.meetless/bin/mla <args>'
```

The single quotes and literal `$HOME` matter: they expand inside WSL, and the
leading slash never hits Git Bash's POSIX-to-Windows path conversion.

Windows issues and pull requests are welcome here; fixes are hand-ported into the
upstream tree, so a merged PR may lag a release.

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

## Built with Codex

The Codex connector in this repository was built with Codex, running GPT-5.6.
Stated precisely, because "built with" is easy to hand-wave:

**What Codex wrote.** The net-new connector surface: the `UserPromptSubmit`
wrapper (`mla _internal codex-hook`), the static Codex plugin package that ships
`mla mcp`, the `mla codex install` / `uninstall` commands that manage
`$CODEX_HOME/hooks.json`, the response adapter that maps Codex's unsupported
`ask` onto a supported deny, the `mla doctor` connector health checks, and the
reproducible fixture.

**What it reused rather than rebuilt.** The neutral core, which predates this
work and already governed Claude Code: the hook input parser, the deny decision
core, the envelope renderer, enforcement-incident capture, the `mla mcp`
retrieval server, and `.meetless.json` binding. GPT-5.6's useful contribution
here was largely negative space. The connector is registration plus one thin
wrapper because the model was steered to extend the existing core instead of
forking a Codex-specific decision path. One decision core, two surfaces.

**What the human owner decided.** Design ratification, the scope ceiling, the
hook-trust UX, and this repository's public visibility.

| Field | Value |
|---|---|
| Codex model | GPT-5.6 (exact string: `TODO(owner): capture from the build thread`) |
| Codex CLI | `0.144.6` |
| `/feedback` Session ID | `TODO(owner): capture from the build thread` |

Full submission notes, the honest enforcement claim, and the demo walkthrough are
in [`codex/README.md`](codex/README.md). The reproducible fixture is in
[`examples/codex-governed-change/`](examples/codex-governed-change/).

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
