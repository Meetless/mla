#!/usr/bin/env bash
# §6.2 Packaged MCP boot + wiring smoke (Phase 1, offline).
#
# WIRING (B4): `mla init` writes ~/.claude.json mcpServers.meetless.command pointing
#   at a REAL executable, never a /snapshot path, with args ["mcp"]. This guards the
#   pkg-snapshot regression where the binary baked "/snapshot/..." into the wired MCP
#   command and killed the MCP integration.
# BOOT (B3): spawning `mla mcp` over stdio completes the JSON-RPC initialize handshake
#   (loading the packaged mcp.js), lists a non-empty tool set, and exits 0 on EOF.
#
# `mla init` is run WITHOUT --control-token (auth mode "none", fully offline) from the
# isolated sandbox cwd, so the managed CLAUDE.md block and ~/.claude.json land in the
# throwaway home, never in a real tree. HOME and MEETLESS_HOME both live under the
# same temp root, so the hook-path temp-dir guard sees a symmetric temp settings
# target and allows the wire.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"
smoke_init mcp "${1:?usage: mcp.sh <mla-bin>}"

# --- wiring ---------------------------------------------------------------
INIT_ERR="$SMOKE_ROOT/init.err"
if ! "$SMOKE_BIN" init >"$SMOKE_ROOT/init.out" 2>"$INIT_ERR"; then
  cat "$INIT_ERR" >&2
  smoke_die "mla init failed"
fi

CLAUDE_JSON="$HOME/.claude.json"
[ -f "$CLAUDE_JSON" ] || smoke_die "mla init did not write $CLAUDE_JSON"

node -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const s = (j.mcpServers || {}).meetless;
  if (!s) { console.error("no mcpServers.meetless entry in claude.json"); process.exit(1); }
  if (typeof s.command !== "string" || s.command.length === 0) {
    console.error("mcpServers.meetless.command is not a non-empty string: " + JSON.stringify(s.command)); process.exit(1);
  }
  if (s.command.startsWith("/snapshot/")) {
    console.error("mcpServers.meetless.command is a /snapshot path (pkg-snapshot regression): " + s.command); process.exit(1);
  }
  try { fs.accessSync(s.command, fs.constants.X_OK); }
  catch { console.error("mcpServers.meetless.command is not executable: " + s.command); process.exit(1); }
  const args = s.args || [];
  if (!(Array.isArray(args) && args.length === 1 && args[0] === "mcp")) {
    console.error("mcpServers.meetless.args != [\"mcp\"]: " + JSON.stringify(args)); process.exit(1);
  }
' "$CLAUDE_JSON" || smoke_die "MCP wiring assertion failed (see above)"
smoke_ok "wiring OK: mcpServers.meetless.command is a real executable, args [mcp]"

# --- boot -----------------------------------------------------------------
# The probe inherits the isolated HOME/MEETLESS_HOME so `mla mcp` finds the
# cli-config.json that init just wrote. Supervisor off -> the worker runs directly.
MEETLESS_MCP_SUPERVISOR=0 node "$DIR/mcp-probe.mjs" "$SMOKE_BIN" \
  || smoke_die "MCP boot handshake failed"
smoke_ok "boot OK: initialize -> meetless-mcp, tools/list non-empty, clean EOF exit"
