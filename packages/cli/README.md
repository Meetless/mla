# @meetless/cli (`mla`)

`mla` is the Meetless agent CLI. It wires Meetless into your local Claude Code
setup (capture hooks, an MCP server, and the `/mla` skill) so coding-agent
sessions are governed and reviewable.

See `mla help` for the full command list.

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
