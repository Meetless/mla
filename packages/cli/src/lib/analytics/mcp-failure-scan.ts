// D3: recover the governed pulls that were REFUSED, which no live hook can see.
//
// THE HOLE. `post-tool-use.sh` writes one `mcp-calls.jsonl` row per meetless MCP
// call, and that is the pull side of A1 evidence-followthrough. But Claude Code does
// not fire PostToolUse at all when a tool result carries `is_error: true`, so the
// writer never runs for a refused pull. The consequence is not a row missing a field;
// it is no row. `classify_mcp_outcome` in common.sh already computes an honest
// success | error | unknown and its "error" arm is, on this harness, unreachable.
//
// MEASURED, not assumed (2026-08-09, current Claude Code): `mcp-calls.jsonl` held
// 1773 rows; a deliberately-invalid `retrieve_knowledge` was issued and refused; the
// file still held 1773 rows. From the other end, session be3cbc73's transcript
// carries two `retrieve_knowledge` results with `is_error: true` ("intel is
// unreachable") and the ledger carries ONE row for that session -- the turn-3 pull
// that succeeded. The strongest signal mla could collect, the agent reaching for
// governed memory and being told no, was the one thing the product could not see.
//
// THE RECOVERY. The transcript IS the ground truth and the Stop hook already reads
// it. stop.sh runs exactly this shape twice already -- the AskUserQuestion decision
// backstop and the enforcement-outcome correlator -- both for the same reason: what
// the live hook could not observe, Stop reconstructs from the transcript. This is
// that pattern a third time, not a new mechanism.
//
// SCOPE, deliberately narrow. It appends ONLY refusals. A pull that succeeded still
// gets its row from PostToolUse in real time, so the two writers never contend for
// the same call, and a legacy row (written before `tool_use_id` existed) is never a
// dedup target because a legacy row is by construction a success.

/** A meetless MCP call the transcript shows was refused, in `mcp-calls.jsonl` shape. */
export interface FailedPullRow {
  ts: string;
  event: "tool_used_mcp";
  session_id: string;
  turn_index: number;
  tool: string;
  evidence_tool: boolean;
  query: string;
  source_ids: string[];
  outcome: "error";
  tool_use_id: string;
}

export interface ScanOptions {
  sessionId: string;
  /**
   * The turn Stop is closing. Stop fires at the end of EVERY turn and this scan runs
   * on each one, so a refusal produced in turn N is discovered at Stop of turn N and
   * stamped N. If a Stop was skipped the refusal is stamped one turn late rather than
   * lost -- the same trade the AskUserQuestion backstop beside it already makes, and
   * the right side of it: a late row is a recoverable inaccuracy, a missing row is the
   * defect this exists to close.
   */
  turnIndex: number;
  /** `tool_use_id`s already in the ledger. Makes a repeated Stop a no-op. */
  known: Set<string>;
  ts: string;
}

const MCP_PREFIX = "mcp__meetless__meetless__";

// The same split post-tool-use.sh makes: the three read tools return cited evidence,
// everything else (relationship_verdict, decision_record, dismiss_conflict) is an
// ACTION. Kept identical on purpose -- a refusal must be counted on the same arm its
// success would have been, or the two writers describe different populations.
const EVIDENCE_TOOLS = new Set(["retrieve_knowledge", "kb_doc_detail", "query"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function contentBlocks(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = asRecord(entry.message);
  if (!message) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((b): b is Record<string, unknown> => b !== null);
}

/**
 * The tail of the transcript belonging to the turn Stop is closing: everything after
 * the last REAL user prompt.
 *
 * Bounding the scan is what makes the turn stamp honest. Without it, a Stop on turn 50
 * would re-read turn 1 and either re-emit its refusal or depend entirely on a dedup set
 * read from a byte-bounded tail of the ledger, where turn 1's row has long scrolled
 * out. With it, each Stop sees only what its own turn produced, and the dedup set is
 * belt-and-braces rather than the sole defence.
 *
 * "Real user prompt" excludes tool_result entries, which are also user-role. That is
 * the same distinction the intra-turn narration capture in post-tool-use.sh has to
 * make, and getting it wrong there pulled in the PRIOR turn's prose.
 */
export function sliceCurrentTurn(transcript: unknown[]): unknown[] {
  let start = 0;
  for (let i = 0; i < transcript.length; i++) {
    const entry = asRecord(transcript[i]);
    if (!entry || entry.type !== "user") continue;
    const blocks = contentBlocks(entry);
    // A user entry carrying ONLY tool_results is the harness handing back tool output,
    // not the operator speaking. A plain-string content is always a real prompt.
    const isToolResultOnly = blocks.length > 0 && blocks.every((b) => b.type === "tool_result");
    if (!isToolResultOnly) start = i;
  }
  return transcript.slice(start);
}

/**
 * Walk a parsed transcript and return one row per meetless MCP call whose result was
 * an error and which is not already in the ledger. Order follows the transcript, so
 * the two refusals of a single turn keep the order the agent issued them in.
 *
 * Total: every malformed entry is skipped rather than thrown on. A transcript is
 * written by another process while we read it, so a clipped final line is ordinary,
 * and losing the whole scan over one bad entry would reintroduce exactly the silence
 * this closes.
 */
export function scanTranscriptForFailedMcpPulls(
  transcript: unknown[],
  opts: ScanOptions,
): FailedPullRow[] {
  // Pass 1: every meetless MCP tool_use, by id. The result arrives in a LATER entry,
  // so the name and the query are only knowable from the call side.
  const calls = new Map<string, { tool: string; query: string }>();
  for (const raw of transcript) {
    const entry = asRecord(raw);
    if (!entry || entry.type !== "assistant") continue;
    for (const block of contentBlocks(entry)) {
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const id = typeof block.id === "string" ? block.id : "";
      if (!id || !name.startsWith(MCP_PREFIX)) continue;
      const input = asRecord(block.input);
      // Same field order as post-tool-use.sh's jq: query, then question, then citation.
      const query =
        (typeof input?.query === "string" && input.query) ||
        (typeof input?.question === "string" && input.question) ||
        (typeof input?.citation === "string" && input.citation) ||
        "";
      calls.set(id, { tool: name.slice(MCP_PREFIX.length), query });
    }
  }
  if (calls.size === 0) return [];

  // Pass 2: the errored results, matched back to their call.
  const out: FailedPullRow[] = [];
  const emitted = new Set<string>();
  for (const raw of transcript) {
    const entry = asRecord(raw);
    if (!entry || entry.type !== "user") continue;
    for (const block of contentBlocks(entry)) {
      if (block.type !== "tool_result" || block.is_error !== true) continue;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!id || opts.known.has(id) || emitted.has(id)) continue;
      const call = calls.get(id);
      if (!call) continue;
      emitted.add(id);
      out.push({
        ts: opts.ts,
        event: "tool_used_mcp",
        session_id: opts.sessionId,
        turn_index: opts.turnIndex,
        tool: call.tool,
        evidence_tool: EVIDENCE_TOOLS.has(call.tool),
        query: call.query,
        // EXPLICITLY empty, never omitted. A refused pull returned nothing, and that
        // is a fact about the refusal; an absent field would only be a fact about us.
        source_ids: [],
        outcome: "error",
        tool_use_id: id,
      });
    }
  }
  return out;
}
