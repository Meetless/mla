# event-batch-filter.jq: Pass 2 batch transform for flush.sh.
#
# Reads RAW newline-separated JSONL ($SESSION_ID.jsonl.draining.$$) and emits a
# JSON array of event records shaped for control's IngestAgentRunEventsDto.
#
# Tolerance contract (Wedge v6 Epoch 25):
#   - ANY malformed line is silently skipped via `fromjson?`.
#   - Empty lines are skipped via `select(length > 0)`.
#   - One corrupt line CANNOT poison the whole batch.
#
# Pre-fix the filter used `jq -s` (slurp) which parses the entire file as a
# JSON-value stream. A single bad line (writer killed mid-printf, disk
# pressure, etc.) caused jq to exit non-zero; flush.sh's `|| echo "[]"`
# fallback then dropped EVERY valid event in the batch. The spool kept the
# raw lines only via Pass 2's re-spool on PATCH failure, but a successful
# PATCH-of-empty would silently advance.
#
# Invoked from flush.sh as:
#   jq -c -R -s -f <abs-path>/event-batch-filter.jq < "$TMP"
#
# `-R` reads each line as a string; `-s` slurps the whole file into one
# string; `split("\n")` re-splits to lines. `fromjson?` per-line tolerates
# garbage.
#
# Whitelist gate (notes/20260608-agent-decision-capture-design.md section 5):
# an event type NOT named here is silently dropped with NO error. So
# `agent_decision_captured` MUST appear in the select() below or every captured
# agent-human decision vanishes between the spool and control, looking healthy.
#
# Transport source model (spec section 6): a captured decision carries the
# stronger envelope `{ source: "agent_adapter", provider, adapter }` instead of
# the generic `source: "claude_hook"`, so future providers do not overload
# `source`. `provider`/`adapter` are TRANSPORT metadata lifted to top level from
# the payload (`provider` / `providerSource`); control validates them for
# AGREEMENT with the canonical payload before writing a row
# (INV-ENVELOPE-PAYLOAD-CONSISTENCY), so they must mirror the payload exactly.
[
  split("\n")[]
  | select(length > 0)
  | fromjson?
  | select(.event == "prompt_submitted"
        or .event == "tool_used_bash"
        or .event == "tool_used_file"
        or .event == "tool_used_mcp"
        or .event == "session_stopped"
        or .event == "agent_decision_captured"
        or .event == "injection_trace"
        or .event == "assistant_message")
  | if .event == "agent_decision_captured" then
      {
        eventKey: .eventKey,
        eventType: .event,
        occurredAt: .ts,
        source: "agent_adapter",
        provider: (.payload.provider),
        adapter: (.payload.providerSource),
        payload: (.payload // {})
      }
    else
      {
        eventKey: .eventKey,
        eventType: .event,
        occurredAt: .ts,
        source: "claude_hook",
        payload: (.payload // {})
      }
    end
]
