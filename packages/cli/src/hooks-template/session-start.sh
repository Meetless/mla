#!/usr/bin/env bash
# session-start.sh: session lifecycle bootstrap.
# Claude calls it directly on SessionStart. Codex calls it internally on
# UserPromptSubmit; a marker makes that path once-per-session.
#
# Source: an internal design note §5.2.
source "$(dirname "$0")/common.sh"

# Per-folder activation gate (opt-in). In an ACTIVATED repo we fall through to
# capture. In an UNACTIVATED repo we no longer exit silently: hand off to the CLI
# (which reuses the SAME marker resolver as `mla mcp`) to surface a one-line
# SessionStart explanation when warranted (logged-in git repos only); its stdout
# becomes Claude Code's additionalContext. No capture happens without a marker.
# See meetless_activated in common.sh. Run `mla activate` in a repo to opt in.
if ! meetless_activated; then
  if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
    "$MLA_PATH" _internal session-nudge --cwd "$PWD" 2>/dev/null || true
  fi
  exit 0
fi

# Self-healing prune of dead hook entries in ~/.claude/settings.json.
# Background: hook entries can leak when temp worktrees (test fixtures, Claude
# Code worktrees, manual sandboxes) install themselves but skip cleanup on
# teardown. Without this, failed Stop / PostToolUse / etc. accumulate forever
# and Claude Code logs "Failed with non-blocking status code" on every event.
# Detection: walk every hook entry's `command` field; if it's a plain absolute
# path and does not exist on disk, drop that entry. Skips non-path commands
# (`pkill ...`, `~/.claude/...`, shell expressions). Whole block is best-effort
# and silenced so it can NEVER fail the hook.
{
  __ml_settings="$HOME/.claude/settings.json"
  if [[ -f "$__ml_settings" ]]; then
    __ml_dead="$(jq -r '.hooks // {} | to_entries[] | .value[]? | .hooks[]?.command // empty' "$__ml_settings" 2>/dev/null \
      | while IFS= read -r __cmd; do
          [[ "$__cmd" =~ ^/[^[:space:]]+$ ]] && [[ ! -e "$__cmd" ]] && printf '%s\n' "$__cmd"
        done)"
    if [[ -n "$__ml_dead" ]]; then
      __ml_dead_json="$(printf '%s\n' "$__ml_dead" | jq -R . | jq -s .)"
      __ml_tmp="$__ml_settings.tmp.$$"
      cp "$__ml_settings" "$__ml_settings.bak.meetless-prune-$(date +%Y%m%d-%H%M%S)" 2>/dev/null
      if jq --argjson dead "$__ml_dead_json" '.hooks |= with_entries(.value |= map(select(([.hooks[]?.command] | map(tostring) | any(. as $c | $dead | index($c))) | not)))' "$__ml_settings" > "$__ml_tmp" 2>/dev/null \
         && jq empty "$__ml_tmp" 2>/dev/null; then
        mv "$__ml_tmp" "$__ml_settings"
      else
        rm -f "$__ml_tmp" 2>/dev/null
      fi
    fi
  fi
} 2>/dev/null || true

INPUT="$(cat)"
# Wedge v6 Epoch 29: validate stdin parses as JSON BEFORE any jq substitution.
# Pre-fix the bare `SESSION_ID="$(echo "$INPUT" | jq -r ...)"` crashed under
# `set -euo pipefail` on empty stdin or malformed JSON: jq exits non-zero, the
# substitution propagates, the hook aborts BEFORE the empty-session-id guard
# below. Claude Code interprets that non-zero exit as a hook failure.
if [[ -z "$INPUT" ]] || ! printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  exit 0
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // empty')"
[[ -z "$SESSION_ID" ]] && exit 0

# Codex UserPromptSubmit also calls this script as a fallback for hosts that
# were already running when the connector was installed. Skip only that
# fallback after the real SessionStart has run; genuine resume/clear/compact
# events must continue through so their lifecycle semantics are preserved.
CODEX_STARTED_MARKER="$QUEUE_DIR/$SESSION_ID.codexStarted"
CODEX_HOOK_EVENT="$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
if [[ "${MEETLESS_CONNECTOR:-}" == "codex" && "$CODEX_HOOK_EVENT" != "SessionStart" && -e "$CODEX_STARTED_MARKER" ]]; then
  exit 0
fi

# Enforcement backstop (2026-07-11): snapshot the governed forbidden roots BEFORE the
# agent can touch anything, so the PostToolUse sweep can tell a file the AGENT created
# from one the repo already shipped, and never deletes a human's pre-existing file.
# Keyed by THIS session_id, which is why it must run after the parse above.
# Best-effort: never blocks session start.
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
  printf '%s' "$INPUT" | "$MLA_PATH" _internal enforcement-baseline >/dev/null 2>&1 || true
fi
# Per-session OFF override (`mla deactivate`). Silences this one session even in
# an activated folder. See meetless_session_disabled in common.sh.
meetless_session_disabled "$SESSION_ID" && exit 0

# Once-per-session marker recovery after a context wipe. Claude Code REUSES this
# session_id across a COMPACTION and a `/clear` (same id, fresh context window; see
# the gitBaseline note below, which already relies on the same re-fire). Rule delivery
# no longer needs recovery here: the floor + scoped rules ride the assemble-context head
# on EVERY UserPromptSubmit (targeted-rule-injection §Phase 2 retired the once-per-session
# first-run pack), so a compaction that wipes the window is automatically re-filled by the
# next turn. The governance nudge, however, is still once-per-session and content-hash gated,
# so after compaction its marker would match and it would evaporate for the rest of the
# session. Claude Code's own guidance is a SessionStart `compact` matcher that re-injects
# critical context; we do the minimal equivalent by dropping the governance inject-marker so
# the NEXT UserPromptSubmit (the compaction continuation is delivered as a user prompt, so it
# always fires) re-emits it. We do NOT drop the steer inject-marker: steer-sync reads it back
# to mark steers delivered on the backend, so deleting it here would corrupt that accounting
# (steer recovery needs its own deliberate handling). Only compact/clear wipe the window; a
# resume reloads the transcript WITH the original block intact, so it is left alone.
# Best-effort; never fails the hook.
SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)"
if [[ "$SOURCE" == "compact" || "$SOURCE" == "clear" ]]; then
  rm -f "$(governance_inject_file "$SESSION_ID")" 2>/dev/null || true
  # F2 (2026-08-06): the delivered-source ledger records what is already IN the
  # context window, and compact/clear is precisely the event that empties it. Drop it
  # here so previously-delivered evidence is eligible again, using the boundary this
  # hook already owns rather than inventing an epoch counter. A `resume` is left
  # alone on purpose: it reloads the transcript with the original blocks intact, so
  # the agent still has them and re-sending would be the waste this fix removes.
  rm -f "$(delivered_ledger_file "$SESSION_ID")" 2>/dev/null || true
fi

# Orphan sweep for per-session governance state. These files are keyed by session id,
# so the line above can only ever reap the CURRENT session's; ids from finished sessions
# never recur and their files sit there indefinitely. On the dogfood machine that left 87
# inject-*.json files spanning 2026-06-06 to 2026-07-05.
#
# Their maximum legitimate lifetime is ONE SESSION: the only reader is
# user-prompt-submit.sh for its own $SESSION_ID.
#
# `-mtime +7` does NOT mean "older than 7 days". Both BSD and GNU find divide the age into
# whole 24-hour periods, truncating, and `+7` matches strictly more than seven of them, so
# the REAL deletion boundary is EIGHT days: 7.9d survives, 8.0d is reaped. Measured, not
# assumed, and bracketed by governance-orphan-sweep.spec.ts. The extra day errs the safe
# way. Either figure is far beyond any single session and far below the two months these
# had accumulated, and `-mtime` needs no date arithmetic to stay portable.
#
# Here rather than in a sweeper because this path already runs once per session, already
# touches this directory, and already deletes from it. Deliberately NOT on session end:
# there is no reliable session-end event, which is exactly why these orphaned. Bounded,
# best-effort, and it can never fail the hook.
find "$(governance_dir)" -maxdepth 1 -type f \
  \( -name 'inject-*.json' -o -name 'unavail-*.json' -o -name 'route-*.json' \) \
  -mtime +7 -delete 2>/dev/null || true

# Same sweep, same reasoning, different directory: the assembler's per-turn audit
# (`assemble-audit.<sessionId>.json`) became per-session so the floor delta diffs against
# THIS session's previous floor instead of whichever of 10+ concurrent sessions wrote last
# (cache.ts, assembleAuditPath). Per-session means orphaned-by-construction the moment the
# session ends, exactly like the governance files above, so it gets the same bounded sweep
# rather than a new mechanism.
#
# `-maxdepth 2` because these sit one level deeper, under `workspaces/<workspaceId>/`, and
# a machine bound to several workspaces has one such directory each. The glob carries the
# dot before the session id so the LEGACY workspace-shaped `assemble-audit.json` can never
# match: it is not per-session, nothing reclaims it, and it is still read by callers that
# cannot name a session.
find "$MEETLESS_HOME_DIR/workspaces" -maxdepth 2 -type f \
  -name 'assemble-audit.*.json' \
  -mtime +7 -delete 2>/dev/null || true

TRANSCRIPT="$(echo "$INPUT" | jq -r '.transcript_path // empty')"
CWD="$PWD"
BRANCH="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
TS="$(date -u +%FT%TZ)"
EVENT_KEY="$(gen_event_key)"
ADAPTER="claude_code"
if [[ "${MEETLESS_CONNECTOR:-}" == "codex" ]]; then
  ADAPTER="codex"
fi

# Best-effort current session name. A RESUMED session (`--resume` / `--continue`)
# starts with a transcript that already carries a title, so SessionStart is the
# earliest moment control can learn it (F3-A). Mirrors the local picker: human
# /title (`custom-title`) wins, else the auto-titler's name (`ai-title`). A brand
# -new session has neither, leaving the title empty; control's no-clobber guard
# keeps any prior name. See resolve_session_title in common.sh.
SESSION_TITLE="$(resolve_session_title "$TRANSCRIPT")"

LINE="$(jq -c -n \
  --arg ts "$TS" --arg event "session_started" --arg key "$EVENT_KEY" \
  --arg sessionId "$SESSION_ID" --arg transcript "$TRANSCRIPT" \
  --arg cwd "$CWD" --arg branch "$BRANCH" --arg title "$SESSION_TITLE" \
  --arg adapter "$ADAPTER" \
  '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {adapter: $adapter, transcriptPath: $transcript, repoPath: $cwd, branch: $branch, sessionTitle: $title}}')"

# Wedge v6 Epoch 35: repoPath sidecar. flush.sh is nohup-spawned by hooks,
# so its cwd is whatever nohup ran in (often $HOME) -- NOT the repo. Without
# this sidecar, `mla _internal finalize-session` falls back to process.cwd(),
# captureGitEvidence returns empty topLevel, the Epoch 33 guard refuses to
# POST, finalize_requested is re-spooled, and the next flush re-fails the
# same way. Permanent stuck-loss until the user manually runs `mla flush`
# from inside the repo. The sidecar captures the SessionStart $CWD (Claude
# Code fires the hook with cwd = the project root) so flush.sh can export
# MEETLESS_REPO_PATH for the CLI to consume. Written BEFORE spool_append so
# the detached flush sees it on first try.
printf '%s' "$CWD" > "$QUEUE_DIR/$SESSION_ID.repoPath"

# T1.2 hard cutover (folder = workspace): workspaceId sidecar. The marker is the
# ONLY source of the workspaceId, and the nohup-detached flusher cannot walk up
# to it (cwd=$HOME would always miss the repo marker). meetless_activated above
# resolved WORKSPACE_ID from this session's marker; snapshot it here so flush.sh
# wraps every POST under the marker id, never a stale cli-config value. Written
# BEFORE spool_append so the detached flush sees it on first try; flush.sh removes
# it after a successful finalize, alongside .repoPath and .gitBaseline.
printf '%s' "$WORKSPACE_ID" > "$QUEUE_DIR/$SESSION_ID.workspaceId"

# Wedge v6: git baseline sidecar. Records the working tree's dirty state at
# SESSION START so finalize can subtract ambient changes (files already
# modified/deleted/untracked before the agent ran) and attribute only what the
# SESSION touched. Without this, `mla review` blamed pre-existing dirty state
# (e.g. a stray `.claude/scheduled_tasks.lock` deletion) on the run. Same
# `-c core.quotePath=false` + `--porcelain=v1` form as captureGitEvidence so the
# exact-line subtraction matches. Best-effort: a non-repo $CWD writes an empty
# file, which subtracts nothing (back-compatible).
#
# 2026-06-01 dogfood finding F-GIT-1 (RCA 20260531 §9.F): capture the baseline
# ONCE per session. Claude Code re-fires SessionStart with the SAME session_id on
# a CONTINUE / COMPACTION / RESUME. The old unconditional write re-captured the
# baseline AFTER the prior turns' edits, freezing the agent's own work in as
# "ambient" -- subtractBaseline then dropped it and `mla review` showed
# "changed files: 0" on a session with real uncommitted edits. The guard below
# preserves the true-start snapshot across resumes. flush.sh removes the sidecar
# after a successful finalize, so the next genuine segment re-captures fresh
# (the absent file IS the "this is a new start" signal).
if [[ ! -e "$QUEUE_DIR/$SESSION_ID.gitBaseline" ]]; then
  git -C "$CWD" -c core.quotePath=false status --porcelain=v1 \
    > "$QUEUE_DIR/$SESSION_ID.gitBaseline" 2>/dev/null || \
    : > "$QUEUE_DIR/$SESSION_ID.gitBaseline"
fi

spool_append "$SESSION_ID" "$LINE"

# The immediately following Codex grounding step appends prompt_submitted and
# starts one flush. Mark the session started and return without launching a
# competing flush (which could PATCH the prompt before the AgentRun POST lands).
if [[ "${MEETLESS_CONNECTOR:-}" == "codex" ]]; then
  : > "$CODEX_STARTED_MARKER"
  exit 0
fi

spawn_flush "$SESSION_ID"

# Sweep for Claude Code sessions whose transcript was deleted on disk and archive
# the mirrored AgentRun. Claude Code has no "session deleted" event, so SessionStart
# is the throttling tick for this disk-reconciliation sweep. Detached + kill-switched
# (MEETLESS_SESSION_RECONCILE=0), so it can never delay or fail the hook.
spawn_reconcile

exit 0
