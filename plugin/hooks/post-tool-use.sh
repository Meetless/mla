#!/usr/bin/env bash
# post-tool-use.sh: Claude Code PostToolUse hook (Bash + meetless MCP).
#
# Two routes, selected by tool name:
#   Bash                       -> tool_used_bash event (command, exit code,
#                                 stdout/stderr tails, category HINT) spooled to
#                                 the queue; Worker re-categorizes (Smaller-D).
#   mcp__meetless__meetless__* -> tool_used_mcp record of the agent's OWN
#                                 evidence pull, written LOCALLY to
#                                 logs/mcp-calls.jsonl keyed by (session_id,
#                                 turn_index). This is the "pull" side of A1
#                                 evidence-followthrough: ask-traces.jsonl says
#                                 what we injected on a turn, mcp-calls.jsonl
#                                 says what the agent pulled on the same turn.
#                                 relationship_verdict is an ACTION, never an
#                                 evidence Pull (evidence_tool=false). See
#                                 notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md
#                                 §7.1 P1 / §7.4 A1.
# Any other tool is ignored.
#
# Source: notes/20260527-bare-bones-mvp-codebase-evaluation-and-plan.md §5.2.
source "$(dirname "$0")/common.sh"

# Per-folder activation gate (opt-in). Exit before any work unless a
# `.meetless.json` marker is found by walking up from $PWD. See
# meetless_activated in common.sh. Run `mla activate` in a repo to opt in.
meetless_activated || exit 0

INPUT="$(cat)"
# Wedge v6 Epoch 29: validate stdin parses as JSON BEFORE any jq substitution.
# See session-start.sh for the trap rationale.
if [[ -z "$INPUT" ]] || ! printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  exit 0
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // empty')"
TOOL="$(echo "$INPUT" | jq -r '.tool_name // empty')"
[[ -z "$SESSION_ID" ]] && exit 0
# Per-session OFF override (`mla deactivate`). Silences this one session even in
# an activated folder. See meetless_session_disabled in common.sh.
meetless_session_disabled "$SESSION_ID" && exit 0

# F3-B liveness heartbeat. Throttled detached flush (<=1 per ~60s/session) drains
# the events already queued this turn so a long, tool-heavy turn keeps control's
# lastSeenAt fresh and stays LIVE instead of aging into IDLE mid-work. Spools no
# new event; fail-soft. Runs for EVERY tool (including non-spooling Read/Grep) so
# the heartbeat covers the whole turn, not just file/bash tools.
heartbeat_flush "$SESSION_ID"

# ---- Intra-turn narration capture (LIVE, per assistant entry) ------------
# The agent's visible prose between tool calls is the "line of thought" the
# session timeline needs INTERLEAVED with the commands. The Stop hook also
# captures narration, but only as ONE blob stamped at Stop-time -- so it lumps
# at the end of the turn (never interleaved) and reads the transcript only as it
# exists at Stop, AFTER a mid-turn auto-compaction has already destroyed the
# earlier prose. This hook fires LIVE after every tool, so it records each
# assistant text entry at its OWN transcript timestamp (correct interleave) and
# BEFORE a later compaction can drop it (compaction-robust). Dogfood-audit
# 2026-06-12: session f16d5e9a rendered as a wall of commands with no prose.
#
# Each entry is keyed by its transcript uuid (assistant_message:<uuid>) so a
# re-fired hook and the Stop backstop are idempotent against control's
# (runId, eventKey) dedup. A per-session ts cursor stops us re-spooling prose we
# already captured on the previous tool. The turn's CLOSING message
# (stop_reason end_turn) is EXCLUDED -- that is the Stop hook's finalMessage, not
# narration, and excluding it also stops a later turn from re-capturing the prior
# turn's closer. Only `text` content is taken (thinking blocks stay private).
# Runs for EVERY tool (incl. non-spooling Read/Grep) so prose on a read-only turn
# is not lost. Best-effort and fail-soft: a missing/unreadable transcript or any
# jq error skips capture and never disturbs the tool spool below. Narration is the
# default now (no kill switch): the timeline is wrong without it.
NARR_TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
if [[ -n "$NARR_TRANSCRIPT" && -f "$NARR_TRANSCRIPT" ]]; then
  mkdir -p "$QUEUE_DIR"
  NARR_CURSOR_FILE="$QUEUE_DIR/$SESSION_ID.narration-cursor"
  (
    ml_lock 8 "$NARR_CURSOR_FILE.lock"
    NARR_CURSOR="$(cat "$NARR_CURSOR_FILE" 2>/dev/null || echo '')"
    # tail caps the per-fire read; the cursor guarantees completeness because
    # each narration entry is followed immediately by the tool_use that fires
    # this hook, so a new entry is always within the recent window.
    NARR_LINES="$(tail -n 1200 "$NARR_TRANSCRIPT" 2>/dev/null | jq -c -R --slurp \
      --arg sid "$SESSION_ID" --arg cursor "$NARR_CURSOR" '
        split("\n")
        | map(select(length > 0) | fromjson?)
        | map(select(type == "object"))
        | [ .[]
            | select(.type == "assistant")
            | select((.message.stop_reason // "") != "end_turn")
            | { uuid: (.uuid // ""),
                ts: (.timestamp // ""),
                text: ( (.message.content // [])
                        | if type == "array"
                          then map(select((.type? // "") == "text") | (.text? // "")) | join("\n")
                          else "" end ) }
            | select(.uuid != "" and .ts != "")
            | select((.text | gsub("\\s"; "") | length) > 0)
            | select(.ts > $cursor) ]
        | .[]
        | { ts: .ts,
            event: "assistant_message",
            eventKey: ("assistant_message:" + .uuid),
            sessionId: $sid,
            payload: { narration: .text, entryUuid: .uuid } }
      ' 2>/dev/null || true)"
    if [[ -n "$NARR_LINES" ]]; then
      while IFS= read -r NARR_LINE; do
        [[ -z "$NARR_LINE" ]] && continue
        spool_append "$SESSION_ID" "$NARR_LINE"
      done <<< "$NARR_LINES"
      NARR_NEW_CURSOR="$(printf '%s\n' "$NARR_LINES" | jq -rs 'map(.ts) | max // empty' 2>/dev/null || true)"
      [[ -n "$NARR_NEW_CURSOR" ]] && printf '%s' "$NARR_NEW_CURSOR" > "$NARR_CURSOR_FILE"
    fi
    ml_unlock 8 "$NARR_CURSOR_FILE.lock"
  ) || true
fi

# ---- meetless MCP-call capture (P1) -------------------------------------
# Record the agent's own evidence pulls before the Bash path. These land in a
# LOCAL file (not the Control spool) since A1 joins them against the local
# enrichment trace; keeping them out of the queue also leaves the Bash spool
# contract untouched.
if [[ "$TOOL" == mcp__meetless__meetless__* ]]; then
  MCP_TOOL="${TOOL##*meetless__}"
  # Evidence-bearing pulls vs actions. relationship_verdict mutates governance
  # state; it is NOT a Pull for A1a. The three read tools return cited evidence.
  case "$MCP_TOOL" in
    retrieve_knowledge|kb_doc_detail|query) EVIDENCE_TOOL=true ;;
    *) EVIDENCE_TOOL=false ;;
  esac
  QUERY="$(echo "$INPUT" | jq -r '.tool_input.query // .tool_input.question // .tool_input.citation // ""')"
  # Scan both the call args and its result for citation tokens (the source_ids
  # the agent actually touched). tojson keeps object/array/string shapes flat
  # and preserves the literal [XX:id] tokens; extract_source_ids (common.sh) is
  # the one shared grammar across the pull and push-reference sides.
  SCAN="$(echo "$INPUT" | jq -r '{i: .tool_input, r: (.tool_response // .tool_result)} | tojson')"
  SOURCE_IDS_JSON="$(extract_source_ids "$SCAN")"
  # Attribute to the CURRENT turn (read, never advance: next_turn_index is owned
  # by UserPromptSubmit). mkdir guards a tool call arriving before any prompt.
  mkdir -p "$QUEUE_DIR" "$LOG_DIR"
  TURN="$(current_turn_index "$SESSION_ID")"
  TS="$(date -u +%FT%TZ)"
  LINE="$(jq -c -n \
    --arg ts "$TS" --arg event "tool_used_mcp" \
    --arg sessionId "$SESSION_ID" --argjson turn "$TURN" \
    --arg tool "$MCP_TOOL" --argjson evidence "$EVIDENCE_TOOL" \
    --arg query "$QUERY" --argjson sids "$SOURCE_IDS_JSON" \
    '{ts: $ts, event: $event, session_id: $sessionId, turn_index: $turn, tool: $tool, evidence_tool: $evidence, query: $query, source_ids: $sids}')"
  (
    ml_lock 9 "$LOG_DIR/mcp-calls.lock"
    printf '%s\n' "$LINE" >> "$LOG_DIR/mcp-calls.jsonl"
    ml_unlock 9 "$LOG_DIR/mcp-calls.lock"
  )

  # ---- Forward tool_used_mcp to control (governed-story §3.1 / §3.3) --------
  # The local mcp-calls.jsonl above stays (A1 evidence-followthrough joins it
  # locally). This ADDS a forwarded AgentRunEvent so the session-detail "what did
  # mla do" lane shows the agent's governed-memory calls. It rides the EXISTING
  # AgentRunEvent table + ingest/read path (same claude_hook envelope as
  # tool_used_bash / tool_used_file); idempotency reuses the existing
  # @@unique([runId, eventKey]), so a re-fired hook or a re-flush is a no-op,
  # never a duplicate row. No new model, no new dedup mechanism.
  #
  # eventKey is DETERMINISTIC from the agent's tool-use identity
  # (mcp:<sessionId>:<toolUseId>), so two flushes of the SAME logical invocation
  # collapse to one row; only a payload with no tool_use_id falls back to a random
  # mcp:<gen_event_key>. turnId is the composite cross-hook join key (null on a 0
  # counter, never borrowing another turn's id); turnIndex is display/diagnostic.
  # operation is the already-prefix-stripped tool name (MCP_TOOL) so the UI never
  # parses the raw name; toolName keeps the raw value for provenance.
  #
  # outcome is HONEST and three-valued (success | error | unknown), NEVER inferred
  # from "PostToolUse fired" (§3.3). Failure IS observable: the meetless MCP server
  # stamps isError:true on every failure path and Claude Code surfaces the
  # structured CallToolResult in tool_response. So isError==true -> error; a
  # recognized success shape (an object carrying a content array, no isError) ->
  # success; anything we cannot positively classify (missing / null / bare-string
  # response) -> unknown.
  MCP_TUID="$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null || true)"
  if [[ -n "$MCP_TUID" ]]; then
    MCP_EVENT_KEY="mcp:${SESSION_ID}:${MCP_TUID}"
  else
    MCP_EVENT_KEY="mcp:$(gen_event_key)"
  fi
  MCP_OUTCOME="$(printf '%s' "$INPUT" | jq -r '
    (.tool_response // .tool_result) as $r
    | if ($r | type) == "object" and ($r.isError == true) then "error"
      elif ($r | type) == "object" and ($r | has("content")) then "success"
      else "unknown" end' 2>/dev/null || printf 'unknown')"
  [[ "$MCP_OUTCOME" =~ ^(success|error|unknown)$ ]] || MCP_OUTCOME="unknown"
  MCP_TURN_N="${TURN:-0}"; [[ "$MCP_TURN_N" =~ ^[0-9]+$ ]] || MCP_TURN_N=0
  if [[ "$MCP_TURN_N" -gt 0 ]]; then MCP_TURN_ID="${SESSION_ID}:${MCP_TURN_N}"; else MCP_TURN_ID=""; fi
  # Redact the query at spool time through the ONE parity-locked redactor (§4.4).
  # Fail-closed for telemetry: if redaction is unavailable or fails, forward
  # query:null (NEVER the raw query); the action record (operation / outcome /
  # sourceIds) still ships, only the freeform text is withheld.
  MCP_QUERY_RED="null"
  if [[ -n "$QUERY" && -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
    _mcp_rc_to="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
    _mcp_q="$(jq -c -n --arg q "$QUERY" '{query: $q}' \
      | ${_mcp_rc_to:+"$_mcp_rc_to" 5} "$MLA_PATH" _internal redact-capture 2>/dev/null \
      | jq -c '.query' 2>/dev/null || true)"
    [[ -n "$_mcp_q" ]] && MCP_QUERY_RED="$_mcp_q"
  fi
  MCP_FWD_LINE="$(jq -c -n \
    --arg ts "$TS" --arg event "tool_used_mcp" --arg key "$MCP_EVENT_KEY" \
    --arg sessionId "$SESSION_ID" --arg turn_id "$MCP_TURN_ID" --argjson turn "$MCP_TURN_N" \
    --arg toolName "$TOOL" --arg operation "$MCP_TOOL" --arg outcome "$MCP_OUTCOME" \
    --argjson query "$MCP_QUERY_RED" --argjson sids "$SOURCE_IDS_JSON" \
    '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {
        turnId: (if $turn_id == "" then null else $turn_id end),
        turnIndex: $turn,
        toolName: $toolName,
        operation: $operation,
        outcome: $outcome,
        query: $query,
        sourceIds: $sids
      }}' 2>/dev/null || true)"
  [[ -n "$MCP_FWD_LINE" ]] && spool_append "$SESSION_ID" "$MCP_FWD_LINE"

  # ---- InjectionTrace parity for the MCP surface (P0.2, design §7.6) --------
  # MCP grounding is an INJECTION surface: an evidence-bearing pull returns cited
  # relationships INTO this turn's context. The stateless MCP server has no session
  # identity, but THIS hook does (SESSION_ID + the read-only TURN), so it is the
  # one place that can emit an InjectionTrace-compatible record for the MCP path,
  # reconciled to the run by riding its own session's event stream (the SAME spool
  # + flush pipeline as the HOOK producer in user-prompt-submit.sh). Without it the
  # session-detail "Injected" lane reads empty for an MCP-grounded run even though
  # relationships were injected -- which is the exact dishonesty §7.6 makes P0.
  #
  # Lean §7.6 superset: contextItems are the citation tokens the grounding actually
  # returned (no kind/status/confidence agentic enrichment), sourceSurface=MCP tells
  # the console it is reading the lean shape. Emit ONLY on a REAL injection: an
  # evidence tool that returned >=1 cited source (a pull with no citation injected
  # nothing; relationship_verdict is an ACTION, EVIDENCE_TOOL=false, never an
  # injection). deliveryStatus is stamped INJECTED HERE, by the surface, at the
  # delivery moment (INV-INJECTIONTRACE-DELIVERY). The injectId IS the eventKey
  # (minted once, replayed byte-identical on a re-flush so control's 6-tuple
  # idempotency no-ops the retry); traceId reuses it since the MCP pull has no
  # separate enrich trace id. Best-effort and fail-soft: a jq failure omits the
  # record and never disturbs the local pull capture above.
  if [[ "$EVIDENCE_TOOL" == "true" ]]; then
    IT_ITEMS="$(printf '%s' "$SOURCE_IDS_JSON" | jq -c \
      '[ (. // []) | unique | .[] | select(. != "") | {source_id: ., injected: true} ]' \
      2>/dev/null || printf '[]')"
    IT_COUNT="$(printf '%s' "$IT_ITEMS" | jq 'length' 2>/dev/null || printf 0)"
    if [[ "${IT_COUNT:-0}" -gt 0 ]]; then
      IT_KEY="$(gen_event_key)"
      IT_LINE="$(jq -c -n \
        --arg ts "$TS" --arg key "$IT_KEY" --arg session_id "$SESSION_ID" \
        --argjson turn "${TURN:-0}" --argjson items "$IT_ITEMS" \
        '{
          ts: $ts, event: "injection_trace", eventKey: $key, sessionId: $session_id,
          payload: {
            sourceSurface: "MCP", turnIndex: $turn, injectId: $key, traceId: $key,
            deliveryStatus: "INJECTED", schemaVersion: 1, status: null, confidence: null,
            contextItems: $items, markdown: null, capturedAt: $ts
          }
        }' 2>/dev/null || true)"
      [[ -n "$IT_LINE" ]] && spool_append "$SESSION_ID" "$IT_LINE"
    fi
  fi
  exit 0
fi

# ---- AskUserQuestion agent-decision capture (provider-neutral) -----------
# Claude's AskUserQuestion bundles N questions in one tool call; each ANSWERED
# question becomes one first-class, auditable agent-human decision. Hand the raw
# hook payload (tool_input.questions + tool_response.answers + tool_use_id) to the
# `mla _internal capture-decisions` Claude normalizer, which emits one
# `agent_decision_captured` spool event per answered question (providerEventId =
# "<tool_use_id>#<questionIndex>"). The command is an IO-light PURE transform and
# touches NO spool itself; ALL spool locking stays HERE so the single-writer
# invariant lives in one place. Passing --spool lets the command dedup against
# eventKeys already queued this session (the Stop transcript-scan backstop writes
# the same keys), so a re-fired PostToolUse never double-spools the same decision.
# Capture is assistive: every failure is swallowed and never breaks the session.
# See notes/20260608-agent-decision-capture-design.md section 5.
if [[ "$TOOL" == "AskUserQuestion" ]]; then
  if [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]]; then
    DECISION_LINES="$(printf '%s' "$INPUT" | "$MLA_PATH" _internal capture-decisions \
      --source post_tool_use --session "$SESSION_ID" \
      --spool "$QUEUE_DIR/$SESSION_ID.jsonl" 2>/dev/null || true)"
    while IFS= read -r DECISION_LINE; do
      [[ -z "$DECISION_LINE" ]] && continue
      spool_append "$SESSION_ID" "$DECISION_LINE"
    done <<< "$DECISION_LINES"
  fi
  exit 0
fi

# ---- Governed trace: tool_used_file on file-modifying tools ---------------
# Dogfood-audit 2026-06-10 issue 3: tool capture was bash-only, so a code-only
# session (all Write/Edit, no Bash) left ZERO governed tool trace in control.
# Spool ONE metadata-only event per file-modifying call: {tool, filePath}. No
# file content, no diff, no tool I/O (the v0 privacy boundary stays intact; a
# path is milder evidence than the stdout/stderr tails the Bash spool ships).
#
# This is the PRIMARY governed artifact for a file-modifying turn, so it spools
# FIRST -- ahead of the assistive A2 produced-doc and DUR blocks below. Both of
# those can early-exit under `set -euo pipefail` (DUR exits 0 in every path; A2
# walks marker trees and can abort), and anything placed after such a block
# never executes. Capturing the governed fact before any best-effort enrichment
# is what keeps the trace immune to a downstream abort (the prose-outside-marker
# regression that the dogfood-audit follow-up locked).
if [[ "$TOOL" == "Edit" || "$TOOL" == "Write" || "$TOOL" == "MultiEdit" || "$TOOL" == "NotebookEdit" ]]; then
  FILE_TRACE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
  if [[ -n "$FILE_TRACE_PATH" ]]; then
    TS="$(date -u +%FT%TZ)"
    EVENT_KEY="$(gen_event_key)"
    # storyCategory (§5.3): markdown (prose doc the body shows) vs other (code edit
    # the console hides). We still spool EVERY file-modifying call -- this only tags
    # how it renders, never whether it is captured.
    FILE_STORY="$(story_category_for_path "$FILE_TRACE_PATH")"
    LINE="$(jq -c -n \
      --arg ts "$TS" --arg event "tool_used_file" --arg key "$EVENT_KEY" \
      --arg sessionId "$SESSION_ID" --arg tool "$TOOL" --arg fp "$FILE_TRACE_PATH" \
      --arg story "$FILE_STORY" \
      '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {tool: $tool, filePath: $fp, storyCategory: $story}}')"
    spool_append "$SESSION_ID" "$LINE"
  fi
fi

# ---- Read-side knowledge trace: tool_used_file with access:"read" ---------
# Session Files rail Phase 2 (notes/20260616-session-files-rail-design.md). The
# rail's "read by the agent" lane needs to know which PROSE files the agent
# opened; Read/Grep/Glob otherwise emit nothing. Spool ONE metadata-only
# tool_used_file per markdown Read, tagged access:"read" so the console routes it
# to the read lane (not produced) and the timeline labels it "Read a file" rather
# than "Edited a file". Gate STRICTLY to prose_path_allowed (the same allowlist
# the input/produced lanes use) so a code Read spools nothing and the stream is
# not flooded with every source-file open. Metadata only ({tool, filePath,
# access}), never file content. exit 0 keeps this read trace self-contained: the
# assistive A2 / DUR / Bash blocks below only handle modifying tools and Bash.
if [[ "$TOOL" == "Read" ]]; then
  READ_TRACE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
  if [[ -n "$READ_TRACE_PATH" ]] && prose_path_allowed "$READ_TRACE_PATH"; then
    TS="$(date -u +%FT%TZ)"
    EVENT_KEY="$(gen_event_key)"
    # This branch is already gated on prose_path_allowed, so a captured read is
    # always markdown; compute via the shared classifier anyway so the field has
    # one definition (§5.3).
    READ_STORY="$(story_category_for_path "$READ_TRACE_PATH")"
    LINE="$(jq -c -n \
      --arg ts "$TS" --arg event "tool_used_file" --arg key "$EVENT_KEY" \
      --arg sessionId "$SESSION_ID" --arg tool "$TOOL" --arg fp "$READ_TRACE_PATH" \
      --arg story "$READ_STORY" \
      '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {tool: $tool, filePath: $fp, access: "read", storyCategory: $story}}')"
    spool_append "$SESSION_ID" "$LINE"
  fi
  exit 0
fi

# ---- Route 4: A2 produced/updated-doc capture (Zone 1, Phase 0) ----------
# Mark prose docs the agent wrote/edited this turn into the Active Review store.
# Pure local append: no detector, no KB write, no network. The envelope carries
# the real ownerUserId/workspaceId (never placeholders) so Phases 3-5 never
# migrate. Silence by default. Spec tests 1,2,7,24,40,41.
#
# ASSISTIVE + best-effort, so the whole block runs in a subshell guarded by
# `|| true`. NOTHING inside can abort the parent hook under `set -euo pipefail`:
# not meetless_repo_root returning 1 for a file outside every marker, not a
# content_hash shasum failure on an unreadable file (non-zero under pipefail),
# not a failed record_active_memory write, not any future addition. The primary
# tool_used_file trace already spooled ABOVE, so a hard abort here costs at most
# this turn's prose enrichment, never the governed trace and never a non-zero
# PostToolUse exit. Vars set here intentionally do not leak; no later block reads
# A2_*.
(
  case "$TOOL" in
    Write|Edit|MultiEdit|NotebookEdit)
      A2_FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
      if [[ -n "$A2_FILE" ]] && prose_path_allowed "$A2_FILE"; then
        A2_ROOT="$(meetless_repo_root "$(dirname "$A2_FILE")")"
        if [[ -n "$A2_ROOT" && -f "$A2_FILE" ]]; then
          # T1.2 cutover: the produced doc belongs to the workspace of the folder
          # it LIVES in (nearest-wins for the edited file), not the cli-config one
          # and not necessarily the session's marker. A2_ROOT is that marker's dir.
          A2_WS="$(jq -r '.workspaceId // empty' "$A2_ROOT/.meetless.json" 2>/dev/null)"
          A2_OWNER="$(jq -r '.actorUserId // empty' "$CFG" 2>/dev/null)"
          if [[ -n "$A2_WS" && -n "$A2_OWNER" ]]; then
            A2_TURN="$(current_turn_index "$SESSION_ID")"
            A2_RRH="$(repo_root_hash "$A2_ROOT")"
            A2_CPATH="$(canonical_path "$A2_ROOT" "$A2_FILE")"
            A2_CHASH="$(content_hash "$A2_FILE")"
            record_active_memory "produced_doc" "$SESSION_ID" "$A2_TURN" "$A2_WS" "$A2_OWNER" "$A2_RRH" "$A2_CPATH" "$A2_CHASH" "$A2_ROOT"
          fi
        fi
      fi
      ;;
  esac
) || true

# ---- DUR: just-in-time coordination flag on a governed-surface edit (§5.4 DURING)
# When the agent edits/writes a file, raise an ADVISORY flag iff a high-confidence
# coordination trigger from THIS turn names the surface being touched ("this
# surface is governed by X") at the moment of the edit, not a judgment of the edit
# itself. Reuses the BEFORE-turn imperative's rung-2 contract: turn-keyed state +
# the closed CoordinationTrigger enum + the P5 high-confidence floor. It NEVER
# blocks (P6 "never its hands"): it emits hookSpecificOutput.additionalContext,
# never `decision: "block"`. Dormant by default in prod (detectors are the producer
# of coordination_triggers and are mostly unwired, so no state file is written and
# this no-ops). See notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §5.4
# / §6 #9 / §7.2 row "DUR".
if [[ "$TOOL" == "Edit" || "$TOOL" == "Write" || "$TOOL" == "MultiEdit" || "$TOOL" == "NotebookEdit" ]]; then
  # Kill switch (default on; set MEETLESS_COORDINATION_DURING=0 to silence).
  [[ "${MEETLESS_COORDINATION_DURING:-1}" == "0" ]] && exit 0

  FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
  [[ -z "$FILE_PATH" ]] && exit 0

  STATE_FILE="$(coordination_state_file "$SESSION_ID")"
  [[ -f "$STATE_FILE" ]] || exit 0

  # Turn-match: stale state from a prior turn must NOT fire. current_turn_index
  # peeks the turn UserPromptSubmit set; PostToolUse never advances it, so a
  # mid-turn edit shares the enriched turn's index and an older file fails here.
  STATE_TURN="$(jq -r '.turn_index // empty' "$STATE_FILE" 2>/dev/null || true)"
  CUR_TURN="$(current_turn_index "$SESSION_ID" 2>/dev/null || printf 0)"
  [[ -n "$STATE_TURN" && "$STATE_TURN" == "$CUR_TURN" ]] || exit 0

  # P5 high-confidence floor (the same boundary the BEFORE-turn imperative holds;
  # a trigger on a low/medium-confidence turn stays passive).
  STATE_CONF="$(jq -r '.confidence // empty' "$STATE_FILE" 2>/dev/null || true)"
  [[ "$STATE_CONF" == "high" ]] || exit 0

  # Match the edited surface against this turn's triggers, hard-filtered to the
  # closed enum (a malformed or injected type can never fire). The trigger surface
  # is repo-relative; suffix-match it against the absolute edited path.
  STATE_TRIGGERS="$(jq -c '.triggers // []' "$STATE_FILE" 2>/dev/null || printf '[]')"
  MATCHED="$(printf '%s' "$STATE_TRIGGERS" | jq -c \
    --arg fp "$FILE_PATH" --argjson enum "$COORDINATION_TRIGGER_ENUM" '
      map(select(.type as $t | $enum | index($t)))
      | map(select(.surface as $s
          | ($s != null and $s != "")
            and (($fp == $s) or ($fp | endswith("/" + $s)))))
    ' 2>/dev/null || printf '[]')"
  MATCH_COUNT="$(printf '%s' "$MATCHED" | jq 'length' 2>/dev/null || printf 0)"
  [[ "${MATCH_COUNT:-0}" -gt 0 ]] || exit 0

  # No spam: flag a given surface at most once per session.
  mkdir -p "$(coordination_dir)" 2>/dev/null || true
  FLAGGED_FILE="$(coordination_flagged_file "$SESSION_ID")"
  if [[ -f "$FLAGGED_FILE" ]] && grep -qxF "$FILE_PATH" "$FLAGGED_FILE" 2>/dev/null; then
    exit 0
  fi
  (
    ml_lock 9 "$FLAGGED_FILE.lock"
    printf '%s\n' "$FILE_PATH" >> "$FLAGGED_FILE"
    ml_unlock 9 "$FLAGGED_FILE.lock"
  )

  STATE_TRACE="$(jq -r '.trace_id // ""' "$STATE_FILE" 2>/dev/null || true)"
  COORD_LINES="$(printf '%s' "$MATCHED" | jq -r '.[] |
    "  - " + .type + (if (.ref // "") != "" then " -> " + .ref else "" end)' 2>/dev/null || true)"
  CTX="<meetless-context kind=\"coordination\" surface=\"$FILE_PATH\" trace=\"$STATE_TRACE\">
You just edited a governed surface (just-in-time coordination flag): $FILE_PATH
Coordination applies before you rely on this change:
$COORD_LINES
This is a Meetless governance directive (computed server-side, not retrieved text). It is a reminder, not a block: Meetless never stops your tools. Pull the cited decision with meetless__kb_doc_detail and confirm the accountable owner signed off before you rely on this change.
</meetless-context>"
  jq -n --arg ctx "$CTX" \
    '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
  exit 0
fi

[[ "$TOOL" != "Bash" ]] && exit 0

CMD="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
EXIT_CODE="$(echo "$INPUT" | jq -r '.tool_result.exit_code // .tool_response.exit_code // empty')"
# Smaller-C: normalize empty/non-numeric to 0 BEFORE --argjson (jq dies on non-numeric).
if ! [[ "${EXIT_CODE:-}" =~ ^[0-9]+$ ]]; then EXIT_CODE=0; fi
# Truncate inside jq (codepoint-aware) so multibyte UTF-8 in tool output (e.g.
# Vietnamese console.log strings, emoji, accented test names) is never split
# mid-sequence. `tail -c 2000` cuts on bytes, which on a 3-byte vi character
# produces invalid UTF-8 that downstream jq --arg + Prisma JSON storage may
# silently corrupt or reject.
STDOUT_TAIL="$(echo "$INPUT" | jq -r '(.tool_result.stdout // .tool_response.stdout // "")[-2000:]')"
STDERR_TAIL="$(echo "$INPUT" | jq -r '(.tool_result.stderr // .tool_response.stderr // "")[-2000:]')"
TS="$(date -u +%FT%TZ)"
EVENT_KEY="$(gen_event_key)"

# Smaller-D: HINT only. The WORKER re-categorizes authoritatively from CMD.
# Emit exactly ONE token. A matching rule prints its token, sets f, and exits; the
# END block prints "unknown_bash" only when nothing matched. The old
# `{print "unknown_bash"}` default rule ran per input RECORD, so a multi-line
# command (heredoc, && chains) printed "unknown_bash" once per non-matching line
# -- polluting the hint with "unknown_bash\nunknown_bash\n..." (and leaking those
# stray lines ahead of a late match). One command => one hint.
CATEGORY_HINT="$(printf '%s' "$CMD" | awk '
  /pytest|jest|vitest|mocha|go test|cargo test|pnpm test|npm test|yarn test/ {print "test"; f=1; exit}
  /tsc|mypy|pyright/                                                        {print "typecheck"; f=1; exit}
  /eslint|ruff|flake8|prettier --check/                                     {print "lint"; f=1; exit}
  /build|webpack|vite build|tsc -b|next build/                              {print "build"; f=1; exit}
  /prisma migrate|alembic|knex migrate/                                     {print "migration"; f=1; exit}
  /npm i|pnpm i|pnpm add|yarn add|pip install|poetry add/                   {print "package_install"; f=1; exit}
  /^git /                                                                    {print "git"; f=1; exit}
  END {if (!f) print "unknown_bash"}
')"

# storyCategory (governed-story §5.3): the render-time bucket. categoryHint above
# is the worker's authoritative test/build/git taxonomy; storyCategory is the
# orthogonal "does the session-detail body show this" bucket. For bash it is
# mla_cli (the agent ran the mla CLI) or other (generic bash the console hides).
STORY_CATEGORY="$(story_category_for_command "$CMD")"

LINE="$(jq -c -n \
  --arg ts "$TS" --arg event "tool_used_bash" --arg key "$EVENT_KEY" \
  --arg sessionId "$SESSION_ID" --arg cmd "$CMD" --arg hint "$CATEGORY_HINT" \
  --arg story "$STORY_CATEGORY" \
  --arg out "$STDOUT_TAIL" --arg err "$STDERR_TAIL" --argjson exit "$EXIT_CODE" \
  '{ts: $ts, event: $event, eventKey: $key, sessionId: $sessionId, payload: {categoryHint: $hint, storyCategory: $story, command: $cmd, exitCode: $exit, stdoutTail: $out, stderrTail: $err}}')"

spool_append "$SESSION_ID" "$LINE"

exit 0
