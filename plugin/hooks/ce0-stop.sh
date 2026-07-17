#!/usr/bin/env bash
# ce0-stop.sh: Claude Code Stop hook for the CE0 evidence-consultation measurement
# harness (RECORD_ONLY; proposal §4.1).
#
# Scope (registered by wire.ts MANAGED_HOOK_SCRIPTS on Stop, no matcher): fires
# when the turn ends. It hands the raw Stop stdin to `mla _internal evidence-stop`,
# which on the FIRST Stop of a turn freezes the obligation's eligibility boundary
# at the high-water consultation token; a later Stop is an idempotent no-op. It then
# ALWAYS emits the empty `{}` pass-through body and exits 0, so the hook can never
# block or re-open a turn.
#
# Deliberately self-contained (does NOT source common.sh), like pre-tool-use.sh.
# No `set -e`: every step is best-effort and must leave a clean exit-0 pass-through.

INPUT="$(cat 2>/dev/null || true)"

# home.sh is the ONE exception to "self-contained": a poisoned $HOME (empty, a literal
# "~", relative) makes "$HOME/.meetless" a RELATIVE path, so this hook would read a
# cli-config.json out of the operator's REPO instead of their home. It repairs $HOME
# from the password database, exports it (so the `mla` we spawn inherits an honest
# one), and sets MEETLESS_HOME_DIR. Best-effort: a missing home.sh must never break
# the pass-through.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/home.sh" 2>/dev/null || true

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

# Best-effort record. stdout discarded, stderr silenced, failure swallowed.
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
  printf '%s' "$INPUT" | "$MLA_PATH" _internal evidence-stop >/dev/null 2>&1 || true
fi

printf '{}'
exit 0
