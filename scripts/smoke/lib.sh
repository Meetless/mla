#!/usr/bin/env bash
# Shared helpers for the mla packaged smoke scenarios (release-testing proposal
# 20260711, Phase 1 §6.1/§6.2/§6.2a and the Phase 2 npm smoke).
#
# Each scenario `source`s this file and calls `smoke_init <name> <mla-bin>` to get
# a single, auto-cleaned sandbox: an isolated OS HOME, an isolated MEETLESS_HOME,
# an isolated TMPDIR, and a NON-git workdir it cds into. Everything lives under one
# `mktemp -d` root removed by an EXIT trap, even when an assertion fails, so a red
# run leaves no state that would falsely green the next (proposal §146).
#
# WHY the cwd isolation is load-bearing: `mla init` writes ./CLAUDE.md in the
# current directory and ~/.claude.json under the OS home. Running a scenario from
# the real repo cwd (or the real home) silently overwrites project instructions
# and the developer's Claude config. NEVER run these from the real tree; smoke_init
# guarantees a throwaway cwd + home for you.
#
# `node` is required only for JSON assertions (parsing cli-config / claude.json and
# the MCP handshake). The release build and CI both set Node up before invoking the
# smoke, and a local run has it on PATH, so this is a safe dependency.
set -euo pipefail

SMOKE_NAME="smoke"
SMOKE_BIN=""
SMOKE_ROOT=""

smoke_ok()  { printf 'smoke[%s]: %s\n' "$SMOKE_NAME" "$*"; }
smoke_die() { printf 'smoke[%s]: FAIL: %s\n' "$SMOKE_NAME" "$*" >&2; exit 1; }

# smoke_init <name> <mla-bin>
#   name    scenario label used in log lines
#   mla-bin path to the mla binary under test (must be executable)
smoke_init() {
  SMOKE_NAME="${1:?smoke_init: scenario name required}"
  SMOKE_BIN="${2:?smoke_init: path to the mla binary required}"

  command -v node >/dev/null 2>&1 || smoke_die "node not on PATH (needed for JSON assertions)"
  [ -x "$SMOKE_BIN" ] || smoke_die "mla binary is not executable: $SMOKE_BIN"
  # Absolute-ize before we cd, so a relative binary path does not strand.
  case "$SMOKE_BIN" in
    /*) : ;;
    *)  SMOKE_BIN="$(cd "$(dirname "$SMOKE_BIN")" && pwd)/$(basename "$SMOKE_BIN")" ;;
  esac

  SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mla-smoke-${SMOKE_NAME}.XXXXXX")"
  # shellcheck disable=SC2064  # expand SMOKE_ROOT now, on purpose.
  trap "rm -rf '$SMOKE_ROOT'" EXIT

  export HOME="$SMOKE_ROOT/home"
  export MEETLESS_HOME="$SMOKE_ROOT/meetless"
  export TMPDIR="$SMOKE_ROOT/tmp"
  export TMP="$TMPDIR"
  export TEMP="$TMPDIR"
  mkdir -p "$HOME" "$MEETLESS_HOME" "$TMPDIR" "$SMOKE_ROOT/work"

  # Hermetic + quiet: no telemetry, no self-update probe, CI semantics.
  export MEETLESS_TELEMETRY=off
  export MLA_NO_UPDATE_NOTIFIER=1
  export CI=1

  cd "$SMOKE_ROOT/work"
  smoke_ok "sandbox at $SMOKE_ROOT (bin: $SMOKE_BIN)"
}

# smoke_assert_json <file>: fail unless <file> is present and parses as JSON.
smoke_assert_json() {
  [ -f "$1" ] || smoke_die "expected JSON file missing: $1"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" \
    || smoke_die "not valid JSON: $1"
}

# smoke_assert_json_contains <file> <needle>: JSON-valid AND raw text contains needle.
smoke_assert_json_contains() {
  smoke_assert_json "$1"
  grep -q "$2" "$1" || smoke_die "JSON at $1 is missing '$2'"
}
