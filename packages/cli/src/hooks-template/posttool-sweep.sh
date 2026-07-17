#!/usr/bin/env bash
# posttool-sweep.sh: the enforcement BACKSTOP (PostToolUse, catch-all).
#
# The PreToolUse gate blocks the writes it can SEE. This catches the ones it cannot.
# It never looks at the tool name or its arguments — it asks only whether a file
# appeared under a governed forbidden root, and if one did, removes it and tells the
# agent why. That makes it immune to shell obfuscation the pre-tool parser would miss
# (`python -c "open('notes/x','w')"`, base64, eval).
#
# Added 2026-07-11 after our own enforcement benchmark caught an agent stepping around
# a hard block in one move: Write -> DENIED, then `cat > notes/design.md` -> succeeded.
#
# Fail open, always. No `set -e`. If mla is missing, slow, or prints nothing, this emits
# the empty pass-through body and exits 0 — a broken sweep must never wedge a session.
source "$(dirname "$0")/common.sh"
meetless_activated || exit 0

INPUT="$(cat 2>/dev/null || true)"

# MEETLESS_HOME_DIR (not a raw "$HOME/.meetless"): common.sh, sourced above, has already
# run home.sh, which repairs a poisoned $HOME from the password database and resolves the
# state dir absolutely. A raw $HOME here would re-root this read into the operator's repo.
CFG="$MEETLESS_HOME_DIR/cli-config.json"
MLA_PATH="$(jq -r '.mlaPath // empty' "$CFG" 2>/dev/null || true)"
if [[ -z "${MLA_PATH:-}" || ! -x "$MLA_PATH" ]]; then
  MLA_PATH="$(command -v mla 2>/dev/null || true)"
fi
[[ -z "${MLA_PATH:-}" || ! -x "$MLA_PATH" ]] && { printf '{}'; exit 0; }

run_guarded() {
  if command -v timeout >/dev/null 2>&1; then timeout 5 "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout 5 "$@"
  else "$@"; fi
}

RESPONSE="$(printf '%s' "$INPUT" | run_guarded "$MLA_PATH" _internal posttool-sweep 2>/dev/null || true)"
if [[ -n "${RESPONSE//[[:space:]]/}" ]]; then
  printf '%s' "$RESPONSE"
else
  printf '{}'
fi
exit 0
