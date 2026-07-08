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

CFG="${MEETLESS_HOME:-$HOME/.meetless}/cli-config.json"
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
