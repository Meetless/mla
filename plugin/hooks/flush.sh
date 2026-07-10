#!/usr/bin/env bash
# flush.sh: background flusher. Called detached by hooks; also invokable by
# `mla flush`.
#
# Invariants:
#   - Idempotent (eventKey is required + unique per runId)
#   - Safe under concurrent hook writers via shared $SESSION_ID.lock
#   - Orphan *.draining.* snapshots from prior interrupted flushes are
#     recovered on every run (Correction 11) under the same lock, before
#     detaching the active queue file
#   - Server dedupes on (runId, eventKey); re-POSTing a recovered line is safe
#   - finalize-session takes ONLY sessionId (Correction 6); finalMessage is
#     persisted on the session_stopped event
#
# Source: notes/20260527-bare-bones-mvp-codebase-evaluation-and-plan.md §5.2.
source "$(dirname "$0")/common.sh"
shopt -s nullglob 2>/dev/null || true

SESSION_ID="${1:?session id required}"
QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.jsonl"
LOCK="$QUEUE_DIR/$SESSION_ID.lock"

# ---------------------------------------------------------------------------
# Honest per-session flush outcome (BUG-1 E / BUG-2 H). flush.sh ALWAYS exits 0
# (capture must never break a session), and `mla flush` used to key its
# "[flush] ok" line purely on that exit code -- so a 401/403/404 that silently
# re-spooled every event still printed "ok", making a wholly-down capture
# pipeline look healthy. We now emit ONE machine-readable marker line to stdout
# on EVERY exit path (via an EXIT trap, so no early return can skip it) and the
# TS runFlushScript parses it to report the truth. log() writes only to logfiles
# + TTY-stderr, so stdout is otherwise clean; the parser substring-matches this
# exact prefix (finalize-session at Pass 3 inherits stdout, so it must NOT assume
# last-line). The marker is inert on the nohup-detached hook path (stdout goes
# nowhere) and is consumed only by the interactive `mla flush` orchestrator. The
# EXIT trap fires exactly once at real exit and never inside `$(...)` command
# substitutions (verified), so there is exactly one marker per invocation.
FLUSH_STATUS="unknown"   # unknown -> a crash / unclassified early-exit
DELIVERED=0              # events PATCHed to control this drain (Pass 2)
RESPOOLED=0              # event / finalize lines kept for a later retry
LAST_AUTH_CODE=""        # last 401/403/404 from a capture write, if any
emit_flush_result() {
  printf 'MLA_FLUSH_RESULT status=%s delivered=%s respooled=%s authcode=%s\n' \
    "${FLUSH_STATUS:-unknown}" "${DELIVERED:-0}" "${RESPOOLED:-0}" "${LAST_AUTH_CODE:-}"
}
trap emit_flush_result EXIT

CONTROL_URL="$(jq -r '.controlUrl' "$CFG")"
# Bearer for control. cli-config is now nested-auth-only on disk (the top-level
# controlToken is a read-time projection the TS layer adds, never persisted), so
# read auth.accessToken first and fall back to a legacy top-level controlToken for
# a pre-cutover config. A logged-out config (auth.mode 'none') yields empty here;
# the POSTs below then 401 and the fail-soft path re-spools, as designed.
TOKEN="$(jq -r '.auth.accessToken // .controlToken // empty' "$CFG")"
# Part 3 (reactive refresh-on-401): the auth mode gates whether a 401 from a
# capture POST may trigger a token refresh. Only `user-token` sessions can
# refresh (shared-key/none have no refresh token); read it once here. Empty for a
# legacy config => the retry path never fires and behaviour is exactly as before.
AUTH_MODE="$(jq -r '.auth.mode // empty' "$CFG" 2>/dev/null || true)"

# T1.4 transport (folder = workspace): the T0.2 AgentReviewWorkspaceGuard rejects
# any capture write whose actor cannot be resolved, and resolveActorIdentity reads
# the actor ONLY from the X-Meetless-Actor header (or a body actorUserId). The TS
# http client (src/lib/http.ts) stamps this header on every control request, but
# flush.sh is the capture transport and does NOT go through that client, so it must
# stamp the header itself. Without it EVERY POST/PATCH below 403s ("Actor identity
# required") and the fail-soft path re-spools forever (capture 100% down while
# looking healthy). Read the actor from cli-config the same way user-prompt-submit.sh
# does (jq -r '.actorUserId // empty'); only stamp the header when present (an absent
# actor 403s exactly as before and the fail-soft path handles it).
ACTOR_USER_ID="$(jq -r '.actorUserId // empty' "$CFG" 2>/dev/null || true)"
ACTOR_HEADER=()
if [[ -n "${ACTOR_USER_ID:-}" ]]; then
  ACTOR_HEADER=(-H "X-Meetless-Actor: $ACTOR_USER_ID")
fi

# T1.2 hard cutover (folder = workspace): the marker is the ONLY source of the
# workspaceId. common.sh now leaves WORKSPACE_ID empty here (flush.sh is
# nohup-detached with cwd=$HOME, so it MUST NOT call meetless_activated -- the
# walk-up would miss the repo marker). session-start.sh snapshotted the resolved
# marker id into this sidecar; source it so every POST below carries the marker
# id. Missing/empty sidecar => empty WORKSPACE_ID => the guard skips the POST.
WS_SIDECAR="$QUEUE_DIR/$SESSION_ID.workspaceId"
if [[ -s "$WS_SIDECAR" ]]; then
  WORKSPACE_ID="$(cat "$WS_SIDECAR")"
fi

if [[ -z "${WORKSPACE_ID:-}" ]]; then
  # No workspace resolved (no marker sidecar): nothing safe to POST. Leave queue
  # intact for a future flush (mla doctor will warn the user).
  FLUSH_STATUS="noworkspace"
  exit 0
fi

# Correction 5 + 11: writers AND drainer use the SAME lock file. Non-blocking
# acquire (already-running flush exits cleanly; next hook write wakes the next
# flush). Orphan recovery happens INSIDE the lock, BEFORE detach, so a crash
# mid-POST in a previous flush cannot strand events forever.
ml_trylock 9 "$LOCK" || { FLUSH_STATUS="locked"; log "skip: another flush already holds the session lock"; exit 0; }

# Correction 11: recover orphaned *.draining.* snapshots from prior interrupted
# flushes (laptop sleep, terminal close, SIGKILL, mid-POST crash). Concat back
# into the active queue file; the next loop below drains them. Server dedupes
# on (runId, eventKey), so re-POSTing already-delivered lines is safe.
ORPHAN_COUNT=0
for ORPHAN in "$QUEUE_DIR/$SESSION_ID.jsonl.draining."*; do
  [[ -f "$ORPHAN" ]] || continue
  cat "$ORPHAN" >> "$QUEUE_FILE"
  rm -f "$ORPHAN"
  ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
done
if [[ "$ORPHAN_COUNT" -gt 0 ]]; then
  log "recovered $ORPHAN_COUNT orphaned snapshot(s) from a prior interrupted flush"
fi

# Cross-session steer pull (Plan 1, conflict-resolution loop). Refresh this
# session's pending human steers into the local cache the UserPromptSubmit hook
# reads with zero network, and mark-injected any the hook already surfaced (PULLED
# -> INJECTED). Runs under the lock once per flush, even on an orphan-only/empty
# drain so an idle-but-flushing session still refreshes steers. Best-effort and
# time-bounded: a failure here NEVER affects the capture drain below. mla resolves
# its own config + auth; we only pass the session id. Gated on an executable mla
# (same as Pass 3).
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
  # Patch 2: explicit branch over a clever parameter expansion. Hook code should be
  # boring: wrap in `timeout`/`gtimeout` when one is on PATH, otherwise call mla
  # directly. Either way the call is best-effort (`|| true`) so it never breaks the
  # drain below.
  STEER_TIMEOUT="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
  if [[ -n "$STEER_TIMEOUT" ]]; then
    "$STEER_TIMEOUT" 6 "$MLA_PATH" _internal steer-sync --session "$SESSION_ID" >/dev/null 2>&1 || true
  else
    "$MLA_PATH" _internal steer-sync --session "$SESSION_ID" >/dev/null 2>&1 || true
  fi
fi

# After recovery: if nothing to drain, exit cleanly.
if [[ ! -s "$QUEUE_FILE" ]]; then
  FLUSH_STATUS="empty"
  log "nothing to flush (queue empty after orphan recovery)"
  rm -f "$QUEUE_FILE"
  ml_unlock 9 "$LOCK"
  exit 0
fi

# Atomic detach + truncate under lock so hook writers landing during drain
# go to the NEW empty file, not the snapshot being processed.
TMP="$QUEUE_FILE.draining.$$"
mv "$QUEUE_FILE" "$TMP"
: > "$QUEUE_FILE"

# Wedge v6 (dogfood incident 2026-06-22): collapse duplicate lines in the
# detached snapshot before draining, keyed by the per-event eventKey. The spool
# can accumulate the SAME line hundreds of thousands of times during a control
# outage: Pass 1/2 re-spool the failed line (spool_append), and a flush
# interrupted before the end-of-flush `rm -f "$TMP"` leaves a *.draining.$$
# orphan that the NEXT flush's orphan recovery cats straight back into the queue.
# Those two paths COMPOUND geometrically (~2x per interrupted cycle), so a single
# session_started can reach hundreds of thousands of copies (observed: a 367MB
# spool with 859,723 identical session_started lines). Pass 1 then fires one
# POST /internal/v1/agent-runs per copy -- a self-inflicted DDoS on control,
# every hit an idempotent no-op.
#
# The server already dedupes on (runId, eventKey), so collapsing to one line per
# eventKey here is loss-free and bounds EVERY pass to the count of DISTINCT
# events. It also caps the queue's worst case at ~2x distinct (one re-spool + one
# orphan re-cat) before the next detach collapses it again, so the geometric
# growth can never restart. Lines with no parseable eventKey are keyed by line
# number so malformed/unkeyed lines are NEVER collapsed away and still drain.
# DEDUP_TMP sits in $QUEUE_DIR for an atomic same-filesystem rename, but is named
# OUTSIDE the *.jsonl.draining.* orphan-recovery glob (see the Pass 1 mktemp
# note) so a crash mid-dedup can never re-inject it as a bogus queue line. If awk
# is missing or errors, we drain the snapshot unchanged -- server-side
# (runId, eventKey) dedup still guarantees correctness, just without the cap.
DEDUP_TMP="$QUEUE_DIR/$SESSION_ID.dedup.$$"
if awk '{
    if (match($0, /"eventKey":"[^"]*"/)) key = substr($0, RSTART, RLENGTH);
    else key = "__nokey__" NR;
    if (!seen[key]++) print
  }' "$TMP" > "$DEDUP_TMP" 2>/dev/null; then
  mv -f "$DEDUP_TMP" "$TMP"
else
  rm -f "$DEDUP_TMP"
fi

log "draining $(wc -l < "$TMP" 2>/dev/null | tr -d ' ' || echo '?') queued line(s) -> $CONTROL_URL"

# Release the lock once the snapshot is detached. Hook writers can append
# concurrently while we POST.
ml_unlock 9 "$LOCK"

HAS_FINALIZE=0
EVENTS_OK=1

# Process the snapshot in two passes:
#   Pass 1: session_started lines -> POST /internal/v1/agent-runs (one per line).
#   Pass 2: prompt_submitted | tool_used_bash | tool_used_file | session_stopped
#           | agent_decision_captured | injection_trace | assistant_message lines
#           -> batched PATCH
#           /internal/v1/agent-runs/by-session/:sid/events. The forward whitelist
#           (event-batch-filter.jq) and the re-spool whitelist below MUST list
#           the same types or a type forwards on success but vanishes on retry.
# finalize_requested is a control signal only; it never POSTs by itself, it
# triggers the `mla _internal finalize-session` hop at the end. The server
# dedupes on (runId, eventKey), so re-POSTing a batch on retry is safe.
#
# Each raw JSONL line is shaped `{ts, event, eventKey, sessionId, payload}`.
# Control's DTOs require Nest-flavored shapes (CreateAgentRunDto +
# IngestAgentRunEventsDto). The jq transforms below map fields:
#   ts            -> startedAt | occurredAt
#   event         -> eventType
#   sessionId     -> externalSessionId
#   payload       -> kept as-is + selected fields lifted to top level
# All POSTs include workspaceId, sourced from the per-session .workspaceId
# sidecar (the marker id snapshotted at session start). See T1.2 cutover above.
#
# curl keeps `-f` so HTTP 4xx/5xx are still failures (exit 22) that re-spool;
# a control-side validation error or 5xx is never silently swallowed. We ALSO add
# `-w '%{http_code}'` (which curl prints even when `-f` fails) so the specific
# auth/visibility codes 401 / 403 / 404 can fail SOFT: on failure the flusher
# fires a throttled local warning via warn_capture_auth (common.sh) instead of
# going silent, because "committed marker, token not yet a workspace member"
# (403) is a common transient onboarding state. Success/failure still branches on
# curl's exit code (CURL_RC), so the contract is unchanged for every other code;
# the status code only selects whether to warn. A transport error yields code 000
# (no warn) and re-spools. The flusher never blocks the session (always exits 0).

# control_capture_curl METHOD URL BODY: perform a capture write with the current
# $TOKEN, then (Part 3 §B reactive refresh-on-401) recover a single expired-access
# token. Sets globals HTTP_CODE (the %{http_code}) and CURL_RC (curl's exit code)
# for the caller to branch on, EXACTLY as the inline curl did before, so the
# success/fail/warn/re-spool contract downstream is unchanged. The only added
# behaviour: when the first attempt fails with HTTP 401 AND the session is
# `auth.mode == user-token`, fire one synchronous `mla _internal refresh`
# (refresh_user_token, common.sh). On rc 0 (token rotated) re-read the rotated
# access token and retry the SAME request EXACTLY ONCE. Any other refresh outcome
# (busy 75 / expired 77 / not-attempted 70 / wrong-mode 64) leaves the original
# failure in place for the caller's existing fail-soft path. One-shot, never a
# loop: a still-401 retry is returned as-is. set -e-safe via `|| CURL_RC=$?` and
# `|| refresh_rc=$?` (this whole script runs under common.sh's set -euo pipefail).
control_capture_curl() {
  # body_file, not an inline body string. A busy session's Pass 2 events[]
  # serializes to ~1-2 MB; passing that on the curl ARGV (`--data "$body"`)
  # overflowed execve (E2BIG) and aborted the whole flush under `set -e`
  # (dogfood incident 2026-06-11). `--data-binary @<file>` streams the bytes
  # verbatim off-argv, so body size is bounded only by control's 10mb body
  # limit, never by ARG_MAX. -binary (not plain --data) so curl does not strip
  # newlines/CRs from the file.
  local method="$1" url="$2" body_file="$3"
  HTTP_CODE=000
  CURL_RC=0
  HTTP_CODE="$(curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' \
    -X "$method" "$url" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "${ACTOR_HEADER[@]+"${ACTOR_HEADER[@]}"}" \
    --data-binary @"$body_file" 2>/dev/null)" || CURL_RC=$?
  if [[ "$CURL_RC" -ne 0 && "$HTTP_CODE" == "401" && "$AUTH_MODE" == "user-token" ]]; then
    local refresh_rc=0
    refresh_user_token || refresh_rc=$?
    if [[ "$refresh_rc" -eq 0 ]]; then
      TOKEN="$(jq -r '.auth.accessToken // .controlToken // empty' "$CFG" 2>/dev/null || true)"
      log "flush: control 401 on $method; refreshed access token, retrying once"
      HTTP_CODE=000
      CURL_RC=0
      HTTP_CODE="$(curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' \
        -X "$method" "$url" \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        "${ACTOR_HEADER[@]+"${ACTOR_HEADER[@]}"}" \
        --data-binary @"$body_file" 2>/dev/null)" || CURL_RC=$?
    else
      log "flush: control 401 on $method; refresh did not rotate a token (rc=$refresh_rc); failing soft"
    fi
  fi
}

# Pass 1: session_started -> create AgentRun. There is normally exactly one
# such line per session; if multiple slip in (re-attached session), the
# server's upsert on (workspaceId, adapter, externalSessionId) keeps it
# idempotent so re-POST is safe.
while IFS= read -r LINE || [[ -n "$LINE" ]]; do
  [[ -z "$LINE" ]] && continue
  # Wedge v6 Epoch 26: tolerate malformed lines. Pre-fix the unguarded
  # `EVT="$(... | jq -r '.event')"` propagated jq's non-zero exit through
  # `set -euo pipefail`, crashing the whole flush. The .draining.$$ snapshot
  # would be stranded; the next flush's orphan recovery re-cats the same
  # bad line and crashes again -- infinite reflush loop on one corrupt
  # write. The `|| echo ""` inside the subshell pins the failure inside the
  # subshell so EVT becomes "" and the loop continues.
  EVT="$(printf '%s' "$LINE" | jq -r '.event' 2>/dev/null || echo "")"
  if [[ "$EVT" != "session_started" ]]; then
    continue
  fi
  BODY="$(printf '%s' "$LINE" | jq -c --arg ws "$WORKSPACE_ID" \
    '{workspaceId: $ws,
      externalSessionId: .sessionId,
      adapter: (.payload.adapter // "claude_code"),
      repoPath: (.payload.repoPath // ""),
      branch: (.payload.branch // null),
      startedAt: .ts}
     | with_entries(select(.value != null))' 2>/dev/null || echo "")"
  if [[ -z "$BODY" ]]; then
    continue
  fi
  # Stream the body from a file (printf is a shell builtin, no argv limit) so
  # the transport is uniform with Pass 2 and never grows onto curl's ARGV. Use
  # mktemp (system tmp), NOT a "$TMP.*" name: $TMP is "$QUEUE_FILE.draining.$$",
  # so any "$TMP.*" child matches the orphan-recovery glob ("*.jsonl.draining.*")
  # and would be cat'd back into the queue as a bogus event line.
  P1_BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/mla-p1body.XXXXXX")"
  printf '%s' "$BODY" > "$P1_BODY_FILE"
  control_capture_curl POST "$CONTROL_URL/internal/v1/agent-runs" "$P1_BODY_FILE"
  rm -f "$P1_BODY_FILE"
  if [[ "$CURL_RC" -eq 0 ]]; then
    log "Pass 1: created/updated agent run (POST /internal/v1/agent-runs)"
  else
    case "$HTTP_CODE" in
      401|403|404) warn_capture_auth "$SESSION_ID" "$HTTP_CODE" "POST /internal/v1/agent-runs"; LAST_AUTH_CODE="$HTTP_CODE" ;;
    esac
    log "Pass 1: POST /internal/v1/agent-runs FAILED (HTTP $HTTP_CODE; control unreachable or 4xx/5xx); re-spooled session_started for retry"
    spool_append "$SESSION_ID" "$LINE"
    RESPOOLED=$((RESPOOLED + 1))
    continue
  fi
done < "$TMP"

# Pass 2: collect every non-session_started event-bearing line into a single
# events[] array and PATCH once. eventKey on each line dedupes server-side, so
# retries are safe. Empty events array short-circuits the PATCH.
#
# Wedge v6 Epoch 25: the filter lives in `event-batch-filter.jq` next to this
# script so a corrupt-line tolerance contract can be unit-tested. Pre-fix
# `jq -s` failed the whole batch on ONE malformed line and `|| echo "[]"`
# silently dropped every valid event with it. The new filter uses
# `-R -s` + `fromjson?` to skip just the bad line.
#
# Wedge v6 Epoch 32: distinguish "filter ran and returned []" (genuinely
# empty batch, OK to short-circuit) from "filter file missing OR jq crashed"
# (we have no visibility into the snapshot and MUST NOT let Pass 3 burn the
# `agent_run_finalized:<runId>` outbox idempotency key on an empty event
# set). Pre-Epoch-32 the `|| echo "[]"` fallback collapsed both into
# EVENTS_OK=1 + finalize-session firing on a Run Ledger with no bash events
# and no agentClaimsRaw. Subsequent flushes (after re-installing the filter)
# would have nothing to re-deliver: dedupe wins, worker synthesizes a blank
# review packet, total silent loss. Now: filter failure -> EVENTS_OK=0 ->
# re-spool block below replays the events AND Pass 3 re-spools the finalize
# instead of firing it.
# Wedge v6 (dogfood incident 2026-06-11): build the batch entirely through
# files, never shell-variable-to-argv. A busy session's events[] is multi-MB;
# the pre-fix `--argjson events "$EVENTS_JSON"` put that array on jq's ARGV and
# overflowed execve (E2BIG), aborting the flush under `set -e` before any curl.
# The filter output goes straight to $EVENTS_FILE; the request body is assembled
# with `--slurpfile` (jq reads the file, nothing on argv); curl streams the body
# file. EVENTS_OK semantics (missing filter / jq crash -> defer + re-spool) are
# preserved exactly.
EVENT_FILTER="$(dirname "$0")/event-batch-filter.jq"
EVENTS_FILE=""
EVENT_COUNT=0
if [[ ! -f "$EVENT_FILTER" ]]; then
  EVENTS_OK=0
  log "Pass 2: event-batch-filter.jq MISSING; deferring events + finalize (run mla init to repair hooks)"
else
  # mktemp (system tmp), NOT "$TMP.*": see the Pass 1 note. The filter output
  # streams straight to the file; the array never touches a shell var or argv.
  EVENTS_FILE="$(mktemp "${TMPDIR:-/tmp}/mla-events.XXXXXX")"
  if ! jq -c -R -s -f "$EVENT_FILTER" < "$TMP" > "$EVENTS_FILE" 2>/dev/null; then
    EVENTS_OK=0
    log "Pass 2: jq event filter crashed; deferring events + finalize"
  else
    EVENT_COUNT="$(jq 'length' < "$EVENTS_FILE" 2>/dev/null || echo 0)"
  fi
fi

if [[ "${EVENT_COUNT:-0}" -gt 0 ]]; then
  # --slurpfile wraps the file's single JSON array value as $evs[0]. No argv
  # carries the payload, so this is overflow-proof regardless of batch size.
  PATCH_BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/mla-body.XXXXXX")"
  jq -c -n --arg ws "$WORKSPACE_ID" --slurpfile evs "$EVENTS_FILE" \
    '{workspaceId: $ws, events: $evs[0]}' > "$PATCH_BODY_FILE" 2>/dev/null
  control_capture_curl PATCH \
    "$CONTROL_URL/internal/v1/agent-runs/by-session/$SESSION_ID/events" "$PATCH_BODY_FILE"
  rm -f "$PATCH_BODY_FILE"
  if [[ "$CURL_RC" -eq 0 ]]; then
    log "Pass 2: PATCHed $EVENT_COUNT event(s) -> /by-session/$SESSION_ID/events"
    DELIVERED=$((DELIVERED + EVENT_COUNT))
  else
    # Non-2xx (control down, transient network, HTTP 4xx/5xx). Server dedupes on
    # eventKey, so the re-spool block below replays the lot. 401/403/404 also fire
    # a throttled local warning (fail soft); other codes just re-spool silently.
    case "$HTTP_CODE" in
      401|403|404) warn_capture_auth "$SESSION_ID" "$HTTP_CODE" "PATCH /internal/v1/agent-runs/by-session/$SESSION_ID/events"; LAST_AUTH_CODE="$HTTP_CODE" ;;
    esac
    EVENTS_OK=0
    log "Pass 2: PATCH events FAILED (HTTP $HTTP_CODE; control unreachable or 4xx/5xx); will re-spool $EVENT_COUNT event(s)"
  fi
fi

# The events scratch file has served its purpose (body already built and sent).
# The re-spool path below reads from $TMP, never from EVENTS_FILE. Explicit `if`,
# not `[[ ]] && rm`, so a falsy guard does not trip `set -e`.
if [[ -n "$EVENTS_FILE" ]]; then
  rm -f "$EVENTS_FILE"
fi

# Wedge v6 Epoch 32: re-spool every event-bearing line on ANY Pass 2 failure
# (filter file missing, jq crashed, OR PATCH failed). One code path serves
# all three failure modes; pre-Epoch-32 only the PATCH-failure path replayed,
# so a missing filter stranded the batch and let finalize ship empty.
if [[ "$EVENTS_OK" == "0" ]]; then
  log "re-spooling event-bearing line(s) for the next flush"
  while IFS= read -r LINE || [[ -n "$LINE" ]]; do
    [[ -z "$LINE" ]] && continue
    # Wedge v6 Epoch 26: same tolerance as Pass 1. A malformed line in the
    # snapshot would crash this re-spool loop under `set -e` and strand the
    # batch in .draining.$$ permanently.
    EVT="$(printf '%s' "$LINE" | jq -r '.event' 2>/dev/null || echo "")"
    case "$EVT" in
      prompt_submitted|tool_used_bash|tool_used_file|session_stopped|agent_decision_captured|injection_trace|assistant_message)
        spool_append "$SESSION_ID" "$LINE"
        RESPOOLED=$((RESPOOLED + 1))
        ;;
    esac
  done < "$TMP"
fi

# Pass 3: detect finalize_requested. Always last because finalize triggers the
# review packet pipeline; everything else must be persisted server-side first.
# If Pass 2 failed (EVENTS_OK=0), DO NOT fire finalize now -- the worker would
# build a Run Ledger from a partially-persisted event set (e.g. missing
# session_stopped -> agentClaimsRaw=null), and the outbox idempotencyKey
# `agent_run_finalized:<runId>` is unique, so a later retry would silently
# dedupe instead of re-synthesizing. Re-spool finalize_requested so the next
# flush (after events land) fires it cleanly.
if grep -q '"event":"finalize_requested"' "$TMP" 2>/dev/null; then
  if [[ "$EVENTS_OK" == "0" ]]; then
    log "Pass 3: finalize_requested DEFERRED (events not yet persisted); re-spooled for next flush"
    FALLBACK_KEY="$(gen_event_key)"
    spool_append "$SESSION_ID" "$(jq -c -n --arg sessionId "$SESSION_ID" --arg key "$FALLBACK_KEY" \
      '{event:"finalize_requested", eventKey:$key, sessionId:$sessionId, payload:{}}')"
    RESPOOLED=$((RESPOOLED + 1))
  else
    HAS_FINALIZE=1
  fi
fi

if [[ "$HAS_FINALIZE" == "1" ]]; then
  # Correction 6: finalize takes ONLY sessionId. finalMessage is on the
  # persisted session_stopped event. Correction 7: absolute MLA_PATH.
  #
  # Wedge v6 Epoch 35: export MEETLESS_REPO_PATH from the session-start
  # sidecar BEFORE invoking finalize. flush.sh is `nohup`-spawned, so its
  # cwd is whatever nohup ran in (often $HOME). The CLI's Epoch 33 guard
  # refuses to POST when captureGitEvidence(cwd) returns empty topLevel,
  # so without this export every finalize attempt re-spools and the next
  # flush re-fails the same way -- permanent stuck-loss. The sidecar holds
  # the repo path Claude Code fired the SessionStart hook with (the real
  # project root). Missing sidecar is tolerated; CLI then falls back to
  # process.cwd() and likely refuses, which is the correct "loud" signal.
  REPO_SIDECAR="$QUEUE_DIR/$SESSION_ID.repoPath"
  if [[ -s "$REPO_SIDECAR" ]]; then
    export MEETLESS_REPO_PATH="$(cat "$REPO_SIDECAR")"
  fi
  if [[ -z "${MLA_PATH:-}" || ! -x "$MLA_PATH" ]]; then
    log "Pass 3: finalize SKIPPED (mla CLI not executable at MLA_PATH); re-spooled finalize_requested"
    FALLBACK_KEY="$(gen_event_key)"
    spool_append "$SESSION_ID" "$(jq -c -n --arg sessionId "$SESSION_ID" --arg key "$FALLBACK_KEY" \
        '{event:"finalize_requested", eventKey:$key, sessionId:$sessionId, payload:{}}')"
    RESPOOLED=$((RESPOOLED + 1))
  else
    log "Pass 3: finalizing session (mla _internal finalize-session) -> triggers review packet pipeline"
    if "$MLA_PATH" _internal finalize-session "$SESSION_ID"; then
      log "Pass 3: finalize OK; review packet pipeline triggered. Inspect: mla review (inside session $SESSION_ID)  |  raw turns: mla session show $SESSION_ID"
      # Do NOT reap the session-lifetime sidecars here. Claude Code has no
      # "session end" hook: stop.sh spools finalize_requested at the END OF
      # EVERY TURN, so this branch runs on every turn, not just the last one.
      # Control ingests on a rolling-snapshot model, so re-finalizing next turn
      # is a safe no-op. But .workspaceId is the ONLY workspace source for this
      # nohup-detached flush (cwd=$HOME, cannot walk to the marker). Deleting it
      # (and .repoPath/.gitBaseline) here stranded every post-finalize turn: the
      # next turn's flush resolved an empty workspace and exited before POSTing
      # (prod session 11436b5c: earlier turn kept, later turn missing).
      # Teardown of ALL per-session sidecars is the 24h idle reaper's job alone.
    else
      log "Pass 3: finalize FAILED; re-spooled finalize_requested for next flush"
      FALLBACK_KEY="$(gen_event_key)"
      spool_append "$SESSION_ID" "$(jq -c -n --arg sessionId "$SESSION_ID" --arg key "$FALLBACK_KEY" \
        '{event:"finalize_requested", eventKey:$key, sessionId:$sessionId, payload:{}}')"
      RESPOOLED=$((RESPOOLED + 1))
    fi
  fi
fi

# Classify the drain for the honest `mla flush` line (BUG-1 E / BUG-2 H). Auth
# rejections win: a 401/403/404 on any pass means capture is DOWN (logged out,
# not a workspace member, or a route the edge does not allow) and that is the
# single most important thing to surface -- everything got re-spooled. Any other
# re-spool (control 5xx, a missing filter, a deferred finalize) is a transient
# "deferred, will retry next flush". Otherwise the queue drained clean.
if [[ -n "$LAST_AUTH_CODE" ]]; then
  FLUSH_STATUS="blocked"
elif [[ "$EVENTS_OK" == "0" || "$RESPOOLED" -gt 0 ]]; then
  FLUSH_STATUS="deferred"
else
  FLUSH_STATUS="ok"
fi
log "flush complete"
rm -f "$TMP"

# RC1 (self-clean): a cleanly-drained session leaves QUEUE_FILE as the 0-byte
# file we truncated at detach time. Pre-fix it was removed ONLY at the top of a
# SUBSEQUENT flush (the "nothing to flush" branch above); the empty spool
# lingered until the next flush and queueDepth() counted it as an "active
# session" in the meantime (the phantom "N active sessions" mla doctor reported).
# Remove it here, under the SAME lock spool_append uses, but ONLY when it is
# still empty: Pass 1/2/3 re-spool on failure and a concurrent next-turn
# spool_append may have appended, both of which make it non-empty and MUST be
# preserved. spool_append recreates it with `>>` next turn, so removal is safe
# for a live session too. Non-blocking acquire: if a writer or another flush
# holds the lock we skip and the next flush's top-of-flush empty check is the
# backstop.
#
# We deliberately reap NOTHING else here. finalize fires at the end of EVERY turn
# (Claude Code has no session-end hook), so every per-session sidecar
# (.workspaceId, .repoPath, .gitBaseline, .turn, .lock, .hb*, .narration-cursor*)
# is session-lifetime state a later turn still needs. Deleting any of them on a
# "successful finalize" stranded every subsequent turn (prod session 11436b5c).
# Teardown of the sidecars is the 24h age-gated idle reaper's job alone; it is
# the only component with a real "session is truly dead" signal.
if ml_trylock 9 "$LOCK"; then
  [[ -s "$QUEUE_FILE" ]] || rm -f "$QUEUE_FILE"
  ml_unlock 9 "$LOCK"
fi

exit 0
