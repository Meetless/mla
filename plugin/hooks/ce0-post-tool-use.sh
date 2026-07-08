#!/usr/bin/env bash
# ce0-post-tool-use.sh: Claude Code PostToolUse hook for the CE0
# evidence-consultation measurement harness (RECORD_ONLY; proposal §4.1).
#
# Scope (registered by wire.ts MANAGED_HOOK_SCRIPTS on PostToolUse with matcher
# "mcp__meetless__"): fires after a meetless MCP tool call. It hands the raw
# PostToolUse stdin to `mla _internal evidence-capture`, which records the FACT of
# a governed-memory pull (retrieve_knowledge / kb_doc_detail / query) as a
# ConsultationAttempt under the live turn's identity; any other tool is a no-op in
# the subcommand. It then ALWAYS emits the empty `{}` pass-through body and exits 0.
#
# The matcher is the prefix `mcp__meetless__`, NOT the catch-all used by the
# load-bearing post-tool-use.sh: this hook only needs the governed pulls, so it
# does not spawn `mla` on every unrelated tool. The subcommand filters precisely to
# the three governed pulls as a backstop.
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
  printf '%s' "$INPUT" | "$MLA_PATH" _internal evidence-capture >/dev/null 2>&1 || true
fi

printf '{}'
exit 0
