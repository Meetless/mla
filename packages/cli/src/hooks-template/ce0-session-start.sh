#!/usr/bin/env bash
# ce0-session-start.sh: Claude Code SessionStart hook for the CE0
# evidence-consultation measurement harness (RECORD_ONLY; proposal §4.1, §6.4).
#
# Scope (registered by wire.ts MANAGED_HOOK_SCRIPTS on SessionStart, no matcher =
# every session start): gives the offline §6.4 telemetry projection an AUTOMATIC
# caller. The two denominator events that back precision/recall,
# memory_requirement_assessed (one per assessment) and evidence_obligation_finalized
# (one per FINALIZED obligation), are NOT emitted live by the turn hooks; they are
# projected from the CE0 store by the `mla evidence ce0-emit-telemetry` sweep. Before
# this hook that sweep only ran when a human typed it, so the denominator never
# flowed from passive dogfood. Here it runs once at the top of each session, projecting
# the prior session's accumulated rows.
#
# The sweep is IDEMPOTENT two ways (a deterministic event_id dedupes on the remote
# sink, and a local skip-set of already-logged event_ids avoids re-appending lines),
# so running it on every session start re-projects nothing already projected. Its
# LOCAL projection into ~/.meetless/events.jsonl is synchronous and happens BEFORE the
# best-effort network flush, so even if this hook is killed at its bounded timeout the
# denominator events are already landed locally and the regular flush forwards them.
#
# Unlike the other three ce0-*.sh hooks (pure local SQLite, no network) this one ends
# in a network flush, which is why MANAGED_HOOK_SCRIPTS gives it a timeout. It still
# ALWAYS emits the empty `{}` SessionStart body and exits 0: CE0 is measurement only,
# so this hook can never inject additionalContext, block, or change the session.
#
# Deliberately self-contained (does NOT source common.sh), like pre-tool-use.sh. No
# `set -e`: every step is best-effort and must leave a clean exit-0 pass-through.

# SessionStart delivers a small JSON payload on stdin; the sweep does not consume it
# (it reads the CE0 store, not the hook input), but we drain stdin so the producer is
# never left writing to a closed pipe.
cat >/dev/null 2>&1 || true

CFG="${MEETLESS_HOME:-$HOME/.meetless}/cli-config.json"
MLA_PATH="$(jq -r '.mlaPath // empty' "$CFG" 2>/dev/null || true)"
if [[ -z "${MLA_PATH:-}" || ! -x "$MLA_PATH" ]]; then
  MLA_PATH="$(command -v mla 2>/dev/null || true)"
fi

# Best-effort sweep. stdout (the sweep's `{emitted, skipped}` JSON summary) is
# discarded, stderr silenced, any failure swallowed so the hook never blocks a session.
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
  "$MLA_PATH" evidence ce0-emit-telemetry >/dev/null 2>&1 || true
fi

# The ONLY thing this hook ever writes to stdout: the empty no-decision body.
printf '{}'
exit 0
