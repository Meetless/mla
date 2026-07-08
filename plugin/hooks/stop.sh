#!/usr/bin/env bash
# stop.sh: Claude Code Stop hook. Writes session_stopped + finalize_requested
# events to the spool and spawns the flusher. Stop must return in <1s.
#
# Source: notes/20260527-bare-bones-mvp-codebase-evaluation-and-plan.md §5.2.
source "$(dirname "$0")/common.sh"

# Per-folder activation gate (opt-in). Exit before any work unless a
# `.meetless.json` marker is found by walking up from $PWD. See
# meetless_activated in common.sh. Run `mla activate` in a repo to opt in.
meetless_activated || exit 0

INPUT="$(cat)"
# Wedge v6 Epoch 29: validate stdin parses as JSON BEFORE any jq substitution.
# Stop is the critical path for review-packet creation; a single malformed
# Claude Code payload here silently kills the finalize_requested + flush
# pipeline and no review is ever generated. See session-start.sh.
if [[ -z "$INPUT" ]] || ! printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  exit 0
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // empty')"
[[ -z "$SESSION_ID" ]] && exit 0
# Per-session OFF override (`mla deactivate`). Silences this one session even in
# an activated folder. See meetless_session_disabled in common.sh.
meetless_session_disabled "$SESSION_ID" && exit 0

TRANSCRIPT="$(echo "$INPUT" | jq -r '.transcript_path // empty')"
TS="$(date -u +%FT%TZ)"

# Transcript-flush settle (Bug B / Q6 race). Claude Code can fire Stop a beat
# BEFORE the turn's CLOSING assistant message is flushed to the transcript file.
# The reads below then grab a MID-TURN text block as finalMessage and the
# narration slice inherits the same wrong boundary.
#
# a6b36c66's first cut polled the transcript byte-SIZE until it stopped growing.
# That has a residual hole the dogfood audit of session 5d428e3e hit head-on:
# byte-size stability cannot tell "the turn finished" from "the single closing
# append has not landed yet". If the writer goes quiet for one poll interval
# before flushing the closing message as one append, the byte-size settle breaks
# early and the extraction still lands on the stale mid-turn block (live: stored
# "Control owns it (graph service). Let me read the actual def." instead of the
# real closing answer "Pulled the canonical model and the actual code path...").
#
# Modern Claude Code transcripts stamp every assistant entry with a stop_reason:
# mid-turn blocks that precede a tool call carry "tool_use"; the turn's CLOSING
# message carries "end_turn". So gate the settle on that SEMANTIC boundary, not
# on bytes: wait until an end_turn assistant entry with non-whitespace text
# exists ("ready"), poll while modern entries exist but none is closed yet
# ("wait"), and only fall back to byte-size stability for LEGACY transcripts that
# carry no stop_reason at all ("legacy"). Bounded under the <1s Stop budget; the
# common already-flushed case breaks on the first check with zero sleeps.
# Fail-soft: a never-closing file just hits the attempt cap and the extraction
# below falls back to the last text block. Tunable via env for tests.
_settle_verdict_jq='
  split("\n")
  | map(select(length > 0) | fromjson?)
  | [ .[] | select(.type == "assistant") ] as $a
  | ([ $a[] | select(.message | has("stop_reason")) ] | length) as $modern
  | ([ $a[]
        | select(.message.stop_reason == "end_turn")
        | select((.message.content // [])
                 | any(.type == "text" and ((.text // "") | gsub("\\s"; "") | length > 0))) ]
     | length) as $closed
  | if $modern > 0 then (if $closed > 0 then "ready" else "wait" end) else "legacy" end
'
if [[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
  _settle_poll="${MEETLESS_FINALMSG_POLL_SEC:-0.06}"
  _settle_max="${MEETLESS_FINALMSG_MAX_ATTEMPTS:-10}"
  _settle_prev="-1"
  _settle_i=0
  while [ "$_settle_i" -lt "$_settle_max" ]; do
    _settle_verdict="$(tail -n 400 "$TRANSCRIPT" 2>/dev/null \
      | jq -rR --slurp "$_settle_verdict_jq" 2>/dev/null || echo legacy)"
    if [[ "$_settle_verdict" == "ready" ]]; then
      break
    elif [[ "$_settle_verdict" == "legacy" ]]; then
      # No stop_reason anywhere: fall back to a6b36c66's byte-size stability.
      _settle_size="$(wc -c < "$TRANSCRIPT" 2>/dev/null | tr -d ' ' || true)"
      [[ -z "$_settle_size" ]] && _settle_size=0
      if [[ "$_settle_size" == "$_settle_prev" ]]; then break; fi
      _settle_prev="$_settle_size"
    fi
    # "wait" (modern, end_turn not flushed yet) or "legacy still growing": poll.
    sleep "$_settle_poll" 2>/dev/null || true
    _settle_i=$((_settle_i + 1))
  done
fi

# Best-effort closing assistant message (Q6: option A; transcript-flush settled above).
#
# Modern Claude Code transcripts have shape `{type: "assistant", message: {content: [{type: "text", text: "..."}, {type: "tool_use", ...}], stop_reason: "..."}}`.
# The legacy `.content // .message` fallback caught the whole envelope object
# and `tostring`'d the JSON dump into finalMessage (model, id, content blocks),
# which poisoned `agentClaimsRaw` and the intel synthesizer's view of what the
# agent claimed it did.
#
# Pick the turn's CLOSING message, not merely "the last assistant text block".
# The two diverge whenever a non-end_turn assistant entry trails the closing one
# (a stale mid-turn tool_use block during the pre-flush gap, or a trailing
# continuation artifact): "last text block" grabs the wrong one. So prefer the
# last assistant entry whose stop_reason is "end_turn" (the semantic turn
# boundary), and only fall back to the last text block for LEGACY transcripts
# with no stop_reason at all. Join its text blocks.
FINAL_MSG=""
if [[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
  FINAL_MSG="$(tail -n 400 "$TRANSCRIPT" 2>/dev/null \
    | jq -rR --slurp '
        split("\n")
        | map(select(length > 0) | fromjson?)
        | [ .[] | select(.type == "assistant")
                 | select((.message.content // []) | any(.type == "text")) ]
        | ((map(select(.message.stop_reason == "end_turn")) | last) // last) as $pick
        | if $pick == null then ""
          else ($pick.message.content // [])
               | map(select(.type == "text") | .text // "")
               | join("\n")
          end
      ' 2>/dev/null || true)"
fi

# Best-effort intra-turn narration (full-prose replay; note 20260610 §4 P3 step
# 11, capture-scope option B). FINAL_MSG above is the agent's LAST assistant
# message (the closing summary). NARRATION is everything the agent SAID earlier
# in THIS turn, between tool calls, which the timeline replay was otherwise
# missing. Turn-bounding is the subtle part: tool_result entries are user-role
# too, so we cannot slice at "the last user entry" or we would cut mid-turn.
# Instead we find the last REAL user prompt (string content, or an array with no
# tool_result block) and take the assistant text entries AFTER it, dropping the
# LAST one (that is FINAL_MSG, so it is never double-counted). Empty (no
# narration, or only a closing summary) means no event is spooled. Narration is
# the default now (no kill switch); the post-tool-use hook captures it LIVE and
# this Stop pass is the compaction-safe backstop.
NARRATION=""
if [[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
  NARRATION="$(tail -n 400 "$TRANSCRIPT" 2>/dev/null \
    | jq -rR --slurp '
        split("\n")
        | map(select(length > 0) | fromjson?)
        | . as $rows
        | (reduce range(0; ($rows | length)) as $i (-1;
             if ($rows[$i].type == "user")
                and (
                  (($rows[$i].message.content | type) == "string")
                  or (
                    (($rows[$i].message.content // []) | type) == "array"
                    and (($rows[$i].message.content // []) | any(.type == "tool_result") | not)
                  )
                )
             then $i else . end
           )) as $start
        | (if $start < 0 then [] else $rows[($start + 1):] end)
        | [ .[] | select(.type == "assistant")
                 | select((.message.content // []) | any(.type == "text")) ] as $texts
        | ($texts | length) as $n
        # Drop the SAME entry FINAL_MSG selected as the closing message: the last
        # end_turn block, else the last text block (legacy). Dropping by INDEX,
        # not by value, so two identical-content blocks do not both vanish; for a
        # legacy transcript this is exactly the old `.[0:-1]` slice.
        | (([ range(0; $n) | select($texts[.].message.stop_reason == "end_turn") ] | last) // ($n - 1)) as $ci
        | [ range(0; $n) | select(. != $ci) | $texts[.] ]
        | map((.message.content // [])
              | map(select(.type == "text") | .text // "")
              | join("\n"))
        | map(select((gsub("\\s"; "") | length) > 0))
        | join("\n\n")
      ' 2>/dev/null || true)"
fi

# Best-effort current session name. Mirrors the local picker: human /title
# (`custom-title`) wins, else the auto-titler's name (`ai-title`). Carrying it on
# session_stopped lets control track renames last-write-wins. See
# resolve_session_title in common.sh for the precedence + fail-soft contract.
SESSION_TITLE="$(resolve_session_title "$TRANSCRIPT")"

# ---- report-citation capture (P3) ---------------------------------------
# Parse the [XX:id] evidence tokens the agent's FINAL report cited and record
# them LOCALLY, keyed by (session_id, turn_index). This is the push-reference
# side of A1b: "did the agent's final report cite a source_id we injected, even
# with no Pull?". It is a local sibling of mcp-calls.jsonl (the pull side, P1)
# and ask-traces.jsonl (the inject side), so the A1 evidence-followthrough join
# stays a purely local reader. The turn counter is READ, never advanced
# (UserPromptSubmit owns it); Stop fires at the end of turn N's response while
# the counter still holds N. An empty array is recorded too: "this turn's report
# cited nothing" is a real A1b denominator signal. extract_source_ids (common.sh)
# is the single shared grammar with the pull side.
# notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §7.1 P3 / §7.4 A1.
mkdir -p "$QUEUE_DIR" "$LOG_DIR"
REPORT_TURN="$(current_turn_index "$SESSION_ID")"
REPORT_SIDS="$(extract_source_ids "$FINAL_MSG")"
REPORT_LINE="$(jq -c -n \
  --arg ts "$TS" --arg event "report_citations" \
  --arg sessionId "$SESSION_ID" --argjson turn "$REPORT_TURN" \
  --argjson sids "$REPORT_SIDS" \
  '{ts: $ts, event: $event, session_id: $sessionId, turn_index: $turn, source_ids: $sids}')"
(
  flock 9
  printf '%s\n' "$REPORT_LINE" >> "$LOG_DIR/report-citations.jsonl"
) 9>"$LOG_DIR/report-citations.lock"

# End-of-run review card: surface up to 5 deterministic stale signals to the user.
# P0A-minimal: written to a LOCAL jsonl only (review_card is not in the flush
# allowlist), later surfaced by `mla status` / `mla context list`. Cheap jq read of
# the scan cache; never recomputes the scan. Always exits 0 so it cannot abort Stop.
build_stop_review_card() {
  local cache="$HOME/.meetless/workspaces/$WORKSPACE_ID/scan-cache.json"
  [[ -r "$cache" ]] || return 0
  jq -c -n \
    --slurpfile c "$cache" \
    --arg sid "$SESSION_ID" \
    --arg ts "$TS" \
    '{
       ts: $ts, event: "review_card", session_id: $sid,
       items: ($c[0].staleSignals // [])[0:5] | map({id: .id, detail: .detail, source: .source}),
       total: (($c[0].staleSignals // []) | length)
     }' 2>/dev/null || true
}

REVIEW_CARD_LINE="$(build_stop_review_card)"
if [[ -n "$REVIEW_CARD_LINE" ]]; then
  printf '%s\n' "$REVIEW_CARD_LINE" >> "$HOME/.meetless/workspaces/$WORKSPACE_ID/review-cards.jsonl" 2>/dev/null || true
fi

STOPPED_KEY="$(gen_event_key)"
LINE_STOPPED="$(jq -c -n \
  --arg ts "$TS" --arg event "session_stopped" --arg key "$STOPPED_KEY" \
  --arg sessionId "$SESSION_ID" --arg final "$FINAL_MSG" --arg title "$SESSION_TITLE" \
  '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {finalMessage: $final, sessionTitle: $title}}')"

FINALIZE_KEY="$(gen_event_key)"
LINE_FINALIZE="$(jq -c -n \
  --arg ts "$TS" --arg event "finalize_requested" --arg key "$FINALIZE_KEY" \
  --arg sessionId "$SESSION_ID" \
  '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {}}')"

# Spool the intra-turn narration FIRST (before session_stopped) so it sorts ahead
# of "Session ended" in control's occurredAt-asc, id-asc timeline: same TS, lower
# row id. Only when there is actually narration to show (empty stays unspooled).
if [[ -n "$NARRATION" ]]; then
  NARRATION_KEY="$(gen_event_key)"
  LINE_NARRATION="$(jq -c -n \
    --arg ts "$TS" --arg event "assistant_message" --arg key "$NARRATION_KEY" \
    --arg sessionId "$SESSION_ID" --arg narration "$NARRATION" \
    '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {narration: $narration}}')"
  spool_append "$SESSION_ID" "$LINE_NARRATION"
fi

spool_append "$SESSION_ID" "$LINE_STOPPED"
spool_append "$SESSION_ID" "$LINE_FINALIZE"

# ---- AskUserQuestion agent-decision backstop (stop transcript scan) ------
# The PostToolUse primary path (post-tool-use.sh) captures each answered
# AskUserQuestion in real time, but a hook that never fired (crash, race, a
# session that predates the matcher) would lose the decision. The Stop hook is
# the guaranteed backstop: scan THIS session's transcript for AskUserQuestion
# tool_use / tool_result pairs and spool any decision the primary path missed.
# A fast `grep -q` gate skips the scan cost entirely on the common no-question
# session. Both paths derive the SAME providerEventId, and --spool dedups against
# what the primary already queued, so a doubly-captured decision is spooled once.
# Spooled BEFORE spawn_flush so the decisions ride this same flush cycle.
# Fail-soft: a missing mla binary, an unreadable transcript, or a command error
# is swallowed and never delays or fails Stop (<1s budget).
# See notes/20260608-agent-decision-capture-design.md section 5.
if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" && -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]] \
  && grep -q "AskUserQuestion" "$TRANSCRIPT" 2>/dev/null; then
  DECISION_LINES="$("$MLA_PATH" _internal capture-decisions \
    --source stop_transcript_scan --transcript "$TRANSCRIPT" \
    --session "$SESSION_ID" --spool "$QUEUE_DIR/$SESSION_ID.jsonl" 2>/dev/null || true)"
  while IFS= read -r DECISION_LINE; do
    [[ -z "$DECISION_LINE" ]] && continue
    spool_append "$SESSION_ID" "$DECISION_LINE"
  done <<< "$DECISION_LINES"
fi

spawn_flush "$SESSION_ID"

# Hands-off stale-session GC: sweep dead-session litter idle > 24h. Detached and
# reap-only (no re-drain), so it never blocks Stop and never re-flushes the live
# sessions. This session's own spool is handled by spawn_flush above.
spawn_reap

# Zone 2 auto-index: index THIS session's produced prose docs into the owner's
# Personal KB as SHADOW (never grounds anyone; INV-GROUNDING-APPROVED). Detached,
# fail-soft, and kill-switchable (MEETLESS_AUTO_INDEX=0), so it never blocks Stop.
# Runs after the reap so it rides the same end-of-Stop tail without delaying GC.
spawn_auto_index "$SESSION_ID"

# T4.2 evidence-outcome correlator (INV-CORRELATOR-1): close every eligible PENDING
# inject window (3 turns or 15 minutes) across ALL sessions and append one
# mla_evidence_outcome per closed inject to the local jsonl, then forward if
# telemetry is on. Detached, fail-soft, and kill-switchable (MEETLESS_EVIDENCE_ANALYTICS=0),
# so it never blocks Stop. Rides the same end-of-Stop tail as the auto-index above.
# No session argument: it sweeps cross-session because a window can close minutes
# after the originating session ended, and a Stop is the natural recompute tick.
spawn_evidence_correlate

# STAR "R" enforcement-outcome correlator: reconstruct what the agent did AFTER each
# deny in THIS session (redirected to an allowed path, stopped, or retried-blocked) from
# the session transcript, and append one mla_enforcement_outcome per closed deny, then
# forward if telemetry is on. Detached, fail-soft, and kill-switchable
# (MEETLESS_ENFORCEMENT_OUTCOME=0), so it never blocks Stop. Session-scoped (a deny's
# follow-through is same-session), so it takes the session id AND the transcript path.
spawn_enforcement_correlate "$SESSION_ID" "$TRANSCRIPT"

# Layer D per-turn recap -> Langfuse: post THIS just-finished turn's assist recap
# to intel so it attaches the mla_ran / mla_assist scores + the full recap metadata
# to the turn's Langfuse trace (keyed on the per-turn $TRACE_ID intel adopts as the
# langfuse_trace_id). REPORT_TURN computed above is the just-finished turn N (the
# counter still holds N at Stop; UserPromptSubmit owns advancing it). Detached,
# fail-soft, and kill-switchable via MEETLESS_TURN_RECAP_LANGFUSE=off (its OWN flag,
# independent of the C-lite injection's MEETLESS_TURN_RECAP), so it never blocks
# Stop. Rides the same end-of-Stop tail as the kickoffs above.
# See notes/20260609-mla-per-turn-assist-recap-plan.md §4.4.
spawn_turn_recap_emit "$SESSION_ID" "$REPORT_TURN"

# Stop returns in <1s. Worker runs review async.
exit 0
