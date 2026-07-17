#!/usr/bin/env bash
# pre-tool-use.sh: Claude Code PreToolUse hook (R1 notes-location enforcement, A1).
#
# Scope (registered by wire.ts MANAGED_HOOK_SCRIPTS with matcher "^(Write|Edit)$"):
# fires only before a Write or Edit tool call. It hands the raw PreToolUse stdin to
# `mla _internal pretool-observe`, which runs the version-backed enforce seam and
# prints the hook response: either the empty `{}` pass-through, or a real deny body
# when a human-attested LIVE rule version is VIOLATED and the deny is admitted.
#
# This wrapper FORWARDS that response verbatim. The decision is computed by the
# subcommand (against a human-attested version), never by this script and never
# reflected from input. The subcommand always exits 0 and prints exactly one JSON
# body, so a non-empty stdout is a real, computed decision and is safe to relay.
#
# Fail open, always. No `set -e`: every step is best-effort. If `mla` is missing,
# crashes, hangs past the timeout, or prints nothing, this wrapper emits the empty
# `{}` pass-through and exits 0. A non-zero exit (especially 2) would BLOCK the tool,
# so this script NEVER exits non-zero: the decision rides the body, never the code.

INPUT="$(cat 2>/dev/null || true)"

# home.sh is the ONE exception to "self-contained": a poisoned $HOME (empty, a literal
# "~", relative) makes "$HOME/.meetless" a RELATIVE path, so this hook would read a
# cli-config.json out of the operator's REPO instead of their home. It repairs $HOME
# from the password database, exports it (so the `mla` we spawn inherits an honest
# one), and sets MEETLESS_HOME_DIR. Best-effort: a missing home.sh must never break
# the pass-through.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/home.sh" 2>/dev/null || true

# Resolve the absolute mla path the same way common.sh does (install-time path in
# cli-config.json, then PATH fallback). MLA in PATH is not relied upon.
# "Absolute or nothing." MEETLESS_HOME_DIR comes from home.sh (repaired $HOME, or an
# absolute MEETLESS_HOME override). If home.sh is missing (a corrupt install), fall back
# ONLY to paths we can vouch for: a raw "$HOME/.meetless" under a poisoned $HOME is a
# RELATIVE path, which would read a cli-config.json out of whatever repo the session was
# started in and then execute the .mlaPath it names. An empty CFG simply misses, and the
# `command -v mla` fallback below takes over.
CFG_DIR="${MEETLESS_HOME_DIR:-}"
if [ -z "$CFG_DIR" ]; then
  case "${MEETLESS_HOME:-}" in
    /*) CFG_DIR="$MEETLESS_HOME" ;;
    *) case "${HOME:-}" in /*) CFG_DIR="$HOME/.meetless" ;; esac ;;
  esac
fi
CFG="${CFG_DIR:-/nonexistent}/cli-config.json"
MLA_PATH="$(jq -r '.mlaPath // empty' "$CFG" 2>/dev/null || true)"
if [[ -z "${MLA_PATH:-}" || ! -x "$MLA_PATH" ]]; then
  MLA_PATH="$(command -v mla 2>/dev/null || true)"
fi

# Run a command under a wall-clock guard so a slow or stuck evaluation degrades to
# pass-through rather than hanging the tool. GNU `timeout` (or `gtimeout` from
# coreutils on macOS) is used when present; otherwise the command runs unguarded.
run_guarded() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 5 "$@"
  else
    "$@"
  fi
}

# Prefer the minimal sibling entrypoint (`pretool-entry.js`, emitted next to the
# resolved mla binary) when present: it pays only the deny-decision require graph
# (~12ms cold) instead of cli.js's full command registry (~150ms), the latency
# lever from notes/20260615-...-consolidated-proposal.md. Both transports call the
# identical runInternalPretoolObserve core, so the decision body is byte-identical.
#
# Three transports, in order, because the exec bit is NOT ours to rely on:
#
#   1. the sibling is executable        -> run it directly (a dev build, a git install;
#                                          its `#!/usr/bin/env node` shebang finds node).
#   2. the sibling exists, not +x       -> run it as `node <entry>`. THIS IS THE NPM CASE.
#                                          `pnpm pack` normalizes every packed file to 0644
#                                          and force-sets 0755 only on `bin` entries, so the
#                                          `chmod +x dist/pretool-entry.js` in our build
#                                          script is real on disk and then discarded into the
#                                          tarball. Up to 0.2.17 an `-x`-only guard meant
#                                          EVERY npm install silently took the slow path on
#                                          EVERY tool call: correct, just ~12x the latency,
#                                          and invisible because the fallback works.
#   3. no sibling at all                -> `mla _internal pretool-observe` (a pkg single-file
#                                          binary, an older install). Run the same way as mla,
#                                          under the same guard, so the slow path stays correct.
RESPONSE=""
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
  PRETOOL_ENTRY="$(dirname "$MLA_PATH")/pretool-entry.js"
  if [[ -x "$PRETOOL_ENTRY" ]]; then
    RESPONSE="$(printf '%s' "$INPUT" | run_guarded "$PRETOOL_ENTRY" 2>/dev/null || true)"
  elif [[ -f "$PRETOOL_ENTRY" ]] && command -v node >/dev/null 2>&1; then
    RESPONSE="$(printf '%s' "$INPUT" | run_guarded node "$PRETOOL_ENTRY" 2>/dev/null || true)"
  else
    RESPONSE="$(printf '%s' "$INPUT" | run_guarded "$MLA_PATH" _internal pretool-observe 2>/dev/null || true)"
  fi
fi

# Forward the computed decision body if there is one; otherwise fall open to the
# empty no-decision body. Stripping whitespace guards against a stray newline-only
# stdout being mistaken for a real response.
if [[ -n "${RESPONSE//[[:space:]]/}" ]]; then
  printf '%s' "$RESPONSE"
else
  printf '{}'
fi
exit 0
