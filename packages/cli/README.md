# Meetless CLI (`mla`)

Governed change-control and knowledge for your AI coding agents.

`mla` is the Meetless agent CLI. It wires [Meetless](https://meetless.ai) into
your local Claude Code setup (capture hooks, an MCP server, and the `/mla` skill)
so coding-agent sessions are governed and reviewable, and decisions, rules, and
project knowledge stay propagated instead of getting lost in chat threads and
tickets.

## Install

Pick one. All three install the same `mla` binary.

**curl (recommended, no Node required):**

```sh
curl -fsSL https://meetless.ai/install.sh | sh
```

**Homebrew (macOS / Linux):**

```sh
brew install --cask meetless/tap/mla
```

If Homebrew refuses with `Refusing to load cask ... from untrusted tap`, trust the
tap once and re-run. Homebrew is [phasing in mandatory trust](https://docs.brew.sh/Tap-Trust)
for every third-party tap; today most installs only warn, but strict setups (and CI)
already require this:

```sh
brew trust meetless/tap
```

**npm (Node 18.18+):**

```sh
npm install -g @meetless/mla
```

The package name is `@meetless/mla`; it installs a single command, `mla`.

## Quickstart

```sh
mla --version      # confirm the install
mla login          # browser sign-in (opens your Meetless workspace)
mla init           # wire mla into Claude Code (hooks, MCP server, /mla skill)
mla activate       # opt this repository in
mla doctor         # verify everything is wired
```

The `curl` installer already runs `mla init` for you, so on that path it is a
harmless idempotent re-run; the `npm` and Homebrew paths install only the binary,
so `mla init` is what wires Claude Code and takes `mla doctor` green.

To wire `mla` into Claude Code as an MCP server, register `mla mcp`. In an
activated repository it serves your governed knowledge; elsewhere it connects in
a status-only mode and tells you the next step.

See `mla help` for the full command list.

## Platforms

`mla` is tested on **macOS** and **Linux**. Windows is **community-supported**:
it runs under [WSL](https://learn.microsoft.com/windows/wsl/), and that is the
recommended path. Install and use it from inside your WSL distro exactly as on
Linux.

If a coding agent drives `mla` from the **Windows** side (Git Bash / PowerShell)
rather than from inside WSL, invoke it through WSL and single-quote the argument
so the path is not rewritten to `C:/Program Files/...` before it reaches WSL:

```sh
wsl -e bash -c '$HOME/.meetless/bin/mla <args>'
```

The single quotes and literal `$HOME` matter: they expand inside WSL, and the
leading slash never reaches Git Bash's POSIX-to-Windows path conversion.

Windows issues and contributions are welcome at
[github.com/Meetless/mla](https://github.com/Meetless/mla); fixes there are hand-
ported back into the upstream tree, so a merged PR may lag a release. You can also
file from anywhere with `mla bug report`.

## Updating

`mla` checks for new releases and tells you how to upgrade with the same method
you installed with. To upgrade manually:

- curl: rerun the install script above
- Homebrew: `brew upgrade --cask mla`
- npm: `npm install -g @meetless/mla@latest`

Set `MLA_NO_UPDATE_NOTIFIER=1` to silence update checks.

## Uninstall

```bash
mla uninstall            # interactive: shows exactly what it will remove, asks once
mla uninstall --dry-run  # preview only, changes nothing
mla uninstall --yes      # non-interactive (CI)
```

Removes the entire local footprint: `~/.meetless` (config, credentials, queue,
hooks, logs), the Meetless hook entries in `~/.claude/settings.json`, the
`meetless` MCP server in `~/.claude.json`, and the `/mla` skill. It then prints
the one command to remove the `mla` binary. It is local only: your server-side
workspace data and any `.meetless.json` markers in other repos are left untouched
(it tells you how to remove those by hand).

## Links

- Website: https://meetless.ai
- Report a bug: run `mla bug report` (files it straight to the team), or email hi@meetless.ai

Licensed under Apache-2.0.
