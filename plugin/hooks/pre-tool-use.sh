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

# Resolve the absolute mla path the same way common.sh does (install-time path in
# cli-config.json, then PATH fallback). MLA in PATH is not relied upon.
CFG="${MEETLESS_HOME:-$HOME/.meetless}/cli-config.json"
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
# When the sibling is absent (a pkg binary, an older install), fall back to
# `mla _internal pretool-observe` so the slow path stays correct. It is run the same
# way as mla (its `#!/usr/bin/env node` shebang resolves node), under the same guard.
RESPONSE=""
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
  PRETOOL_ENTRY="$(dirname "$MLA_PATH")/pretool-entry.js"
  if [[ -x "$PRETOOL_ENTRY" ]]; then
    RESPONSE="$(printf '%s' "$INPUT" | run_guarded "$PRETOOL_ENTRY" 2>/dev/null || true)"
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
