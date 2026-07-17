#!/usr/bin/env bash
# ce0-user-prompt-submit.sh: Claude Code UserPromptSubmit hook for the CE0
# evidence-consultation measurement harness (RECORD_ONLY; proposal §4.1).
#
# Scope (registered by wire.ts MANAGED_HOOK_SCRIPTS on UserPromptSubmit, no
# matcher = every prompt): fires once at the top of each turn. It hands the raw
# UserPromptSubmit stdin to `mla _internal evidence-turn-open`, which classifies
# the turn's memory requirement, persists the assessment, and (only for a REQUIRED
# turn) opens the turn's TurnRuleObligation. It then ALWAYS emits the empty `{}`
# pass-through body and exits 0, so wiring this hook can never inject context or
# change a turn. CE0 is measurement only; injection is a CE2 concern.
#
# Deliberately self-contained (does NOT source common.sh), exactly like
# pre-tool-use.sh: the activation gate is the subcommand's own workspace
# resolution, not a shell-side .meetless.json walk. No `set -e`: every step is
# best-effort, and a missing `mla` or a failed lookup must still leave a clean
# exit-0 pass-through, never a non-zero (blocking) exit.

INPUT="$(cat 2>/dev/null || true)"

# home.sh is the ONE exception to "self-contained": a poisoned $HOME (empty, a literal
# "~", relative) makes "$HOME/.meetless" a RELATIVE path, so this hook would read a
# cli-config.json out of the operator's REPO instead of their home. It repairs $HOME
# from the password database, exports it (so the `mla` we spawn inherits an honest
# one), and sets MEETLESS_HOME_DIR. Best-effort: a missing home.sh must never break
# the pass-through.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/home.sh" 2>/dev/null || true

# Resolve the absolute mla path the same way pre-tool-use.sh does (install-time
# path in cli-config.json, then PATH fallback).
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

# Best-effort record. stdout is discarded (the hook decision is the hardcoded `{}`
# below); stderr is silenced; any failure is swallowed so the hook never blocks a
# turn. The subcommand persists its assessment + obligation out-of-band.
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
  printf '%s' "$INPUT" | "$MLA_PATH" _internal evidence-turn-open >/dev/null 2>&1 || true
fi

# The ONLY thing this hook ever writes to stdout: the empty no-decision body.
printf '{}'
exit 0
