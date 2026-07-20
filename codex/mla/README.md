# Meetless (mla) plugin for Codex

This plugin wires the Meetless **governed-memory MCP server** (`mla mcp`) into
Codex. Once installed, Codex can retrieve your workspace's accepted decisions,
superseding rulings, and cited evidence mid-session, so it stops coding against
stale assumptions.

The plugin ships **only the MCP server**. Governance hooks (grounding injection
and the pre-tool deny gate) are installed separately by the CLI, because Codex
0.144.6 registers hooks from a top-level `$CODEX_HOME/hooks.json`, not from a
plugin. See "Full governance" below.

The MCP entry uses Codex's `writes` approval policy. MLA's query and evidence
tools advertise the MCP read-only annotation, so they can run without an
unnecessary prompt; verdict and conflict-dismissal tools advertise destructive
write annotations and still require approval.

## Prerequisite

Install the `mla` CLI and make sure it is on your `PATH` (the plugin launches
`mla mcp`):

```sh
curl -fsSL https://meetless.ai/install.sh | sh
mla --version
```

## Install the MCP server (this plugin)

```sh
codex plugin marketplace add Meetless/mla
codex plugin add mla@meetless
```

Or from a local checkout of this repo:

```sh
codex plugin marketplace add ./            # reads .agents/plugins/marketplace.json
codex plugin add mla@meetless
```

That registers a `meetless` MCP server (`mla mcp`) with Codex. It is inert until
you bind a repository (below).

## Bind a repository

```sh
cd your-repo
mla activate            # writes .meetless.json
```

In an unbound repo the server simply returns nothing; it never contacts the
backend.

## Full governance (hooks)

To also get grounding injection (UserPromptSubmit) and the pre-execution deny
gate (PreToolUse), install the Codex connector's hooks:

```sh
mla codex install       # writes $CODEX_HOME/hooks.json, prints the trust step
```

Then start Codex, run `/hooks`, review the MLA commands, and grant trust. Until
you grant trust, Codex fails open: hooks are skipped, governance is inactive,
and tools proceed normally.

Remove just the hooks with `mla codex uninstall` (this leaves the shared
`~/.meetless/hooks` scripts and the Claude connector untouched). Remove the whole
local footprint with `mla uninstall`.
