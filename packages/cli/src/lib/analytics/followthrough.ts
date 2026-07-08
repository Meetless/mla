// The evidence-followthrough join: the ONE implementation shared by `mla
// adoption`, the evidence section of `mla stats`, and the Stop-hook local
// correlator (INV-ADOPTION-SOURCE-1). It lives here, in a lib module, precisely
// so every consumer references the same code path rather than reimplementing the
// math; the §10.5 "adoption parity" test asserts that shared reference.
//
// The product has two evidence channels, Push (context injected by the hook) and
// Pull (the agent's own meetless__* MCP calls). The naive "did the agent call any
// tool on an inject turn" metric lies both ways, so A1 splits it and joins three
// LOCAL trace files by (session_id, turn_index):
//
//   ask-traces.jsonl        the inject side (P0): enrichment.context_items[]
//                           with injected==true carry the source_ids we pushed.
//   mcp-calls.jsonl         the pull side (P1): one record per meetless__* call
//                           with evidence_tool + the source_ids it touched.
//   report-citations.jsonl  the push-reference side (P3): the source_ids the
//                           agent's final report CITED that turn.
//
// Per high-value inject turn (a turn that actually injected >=1 source_id):
//   A1a pull_followthrough           the agent PULLED an overlapping source_id
//                                    via an EVIDENCE tool, same or immediate-child
//                                    turn. relationship_verdict is an ACTION
//                                    (evidence_tool=false) and never counts.
//   A1b push_reference_followthrough the report CITED an injected source_id
//                                    (Push adoption with no Pull).
//   A1c evidence_followthrough_any   A1a OR A1b -- the headline "are we useless"
//                                    number.
//
// INV-EVIDENCE-OBSERVATION (§7.1): these are OBSERVATIONS of the agent's
// behavior, not a verification that the evidence was correct or well-used. A
// non-zero overlap is a strong positive signal; silent use undercounts.

// --- trace record shapes (all fields best-effort; lines are tolerated) -----

export interface InjectTurn {
  session_id: string;
  turn_index: number;
  injected_source_ids: string[];
}

export interface McpCall {
  session_id: string;
  turn_index: number;
  evidence_tool: boolean;
  source_ids: string[];
  query: string;
  // The bare meetless tool name (the prefix is already stripped at write time in
  // post-tool-use.sh, e.g. "retrieve_knowledge"). Optional so existing literal
  // McpCall constructions stay valid; the per-turn recap reads it to report which
  // evidence tools the agent pulled.
  tool?: string;
}

export interface ReportCitation {
  session_id: string;
  turn_index: number;
  source_ids: string[];
}

export interface FollowthroughRow {
  session_id: string;
  turn_index: number;
  injected_source_ids: string[];
  a1a_pull: boolean;
  a1b_push_reference: boolean;
  a1c_any: boolean;
  pulled_overlap: string[];
  cited_overlap: string[];
}

export interface AdoptionAggregate {
  inject_turns: number;
  a1a_pull: number;
  a1b_push_reference: number;
  a1c_any: number;
  no_followthrough: number;
  a1a_rate: number;
  a1b_rate: number;
  a1c_rate: number;
  rows: FollowthroughRow[];
}

// --- the join ---------------------------------------------------------------

// Normalize a source_id for set-overlap: the inject side records the file id
// (e.g. NT:20260602-foo.md) while the agent typically cites the bare id
// (NT:20260602-foo). Strip a trailing .md and lowercase so both sides compare
// equal without ever collapsing two genuinely-different ids (they differ by far
// more than case or extension). Exported so the metric family and the correlator
// dedupe ids by the SAME rule the join uses.
export function normId(s: string): string {
  return s.trim().replace(/\.md$/i, "").toLowerCase();
}

// Original-form lookup so the row can report the injected id the agent matched,
// not its normalized form.
export function overlap(injected: string[], touched: string[]): string[] {
  const touchedSet = new Set(touched.map(normId));
  return injected.filter((id) => touchedSet.has(normId(id)));
}

// computeFollowthrough scores each inject turn against the pulls and report
// citations in its window [N, N+window]. Default window=1 covers the turn and
// its immediate child (the A1a contract's "same turn_id OR its immediate child
// turn"); the same window applies to A1b since a multi-turn task's final report
// can land on N+1. The Stop-hook correlator passes the wider 3-turn window.
//
// A1a deliberately fires on source_id OVERLAP only, not the looser "query in the
// same evidence domain" alternative the prose also allows: domain matching
// cannot be made deterministic without a classifier and would reintroduce the
// exact false-positive (acceptance case 2) the split is designed to remove. The
// pull records keep the query string, so a future domain refinement has the raw
// material if we ever want it.
export function computeFollowthrough(
  injects: InjectTurn[],
  calls: McpCall[],
  citations: ReportCitation[],
  window = 1,
): FollowthroughRow[] {
  return injects.map((t) => {
    const inWindow = (turn: number) => turn >= t.turn_index && turn <= t.turn_index + window;

    // A1a: evidence-bearing pulls in the same session and window. The verdict
    // tool (evidence_tool=false) is filtered out here -- an action is not a Pull.
    const pulledIds: string[] = [];
    for (const c of calls) {
      if (c.session_id !== t.session_id || !c.evidence_tool || !inWindow(c.turn_index)) continue;
      pulledIds.push(...c.source_ids);
    }
    const pulled_overlap = overlap(t.injected_source_ids, pulledIds);

    // A1b: the report's cited source_ids in the same session and window.
    const citedIds: string[] = [];
    for (const r of citations) {
      if (r.session_id !== t.session_id || !inWindow(r.turn_index)) continue;
      citedIds.push(...r.source_ids);
    }
    const cited_overlap = overlap(t.injected_source_ids, citedIds);

    const a1a_pull = pulled_overlap.length > 0;
    const a1b_push_reference = cited_overlap.length > 0;
    return {
      session_id: t.session_id,
      turn_index: t.turn_index,
      injected_source_ids: t.injected_source_ids,
      a1a_pull,
      a1b_push_reference,
      a1c_any: a1a_pull || a1b_push_reference,
      pulled_overlap,
      cited_overlap,
    };
  });
}

export function buildAdoption(rows: FollowthroughRow[]): AdoptionAggregate {
  const n = rows.length;
  const a1a = rows.filter((r) => r.a1a_pull).length;
  const a1b = rows.filter((r) => r.a1b_push_reference).length;
  const a1c = rows.filter((r) => r.a1c_any).length;
  const rate = (x: number) => (n ? x / n : 0);
  return {
    inject_turns: n,
    a1a_pull: a1a,
    a1b_push_reference: a1b,
    a1c_any: a1c,
    no_followthrough: n - a1c,
    a1a_rate: rate(a1a),
    a1b_rate: rate(a1b),
    a1c_rate: rate(a1c),
    rows,
  };
}

// --- record parsers (best-effort; tolerate a partial line) ------------------

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// An inject turn is a trace line that actually PUSHED at least one source_id:
// enrichment.context_items[] with injected===true and a non-empty source_id.
// turn_index must be numeric to join (a null turn cannot be aligned).
export function parseInjectTurns(traceLines: Record<string, unknown>[]): InjectTurn[] {
  const byKey = new Map<string, InjectTurn>();
  for (const t of traceLines) {
    const session_id = asStr(t.session_id);
    const turn_index = asNum(t.turn_index);
    if (!session_id || turn_index === null) continue;
    const enrichment = (t.enrichment as Record<string, unknown> | null) ?? null;
    const items = enrichment && Array.isArray(enrichment.context_items) ? enrichment.context_items : [];
    const ids: string[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      if (item.injected !== true) continue;
      const sid = asStr(item.source_id);
      if (sid) ids.push(sid);
    }
    if (ids.length === 0) continue;
    const key = `${session_id} ${turn_index}`;
    const existing = byKey.get(key);
    if (existing) {
      // Merge the rare duplicate (S,N) inject line.
      existing.injected_source_ids = Array.from(new Set([...existing.injected_source_ids, ...ids]));
    } else {
      byKey.set(key, { session_id, turn_index, injected_source_ids: Array.from(new Set(ids)) });
    }
  }
  return Array.from(byKey.values());
}

export function parseMcpCalls(lines: Record<string, unknown>[]): McpCall[] {
  const out: McpCall[] = [];
  for (const c of lines) {
    const session_id = asStr(c.session_id);
    const turn_index = asNum(c.turn_index);
    if (!session_id || turn_index === null) continue;
    out.push({
      session_id,
      turn_index,
      evidence_tool: c.evidence_tool === true,
      source_ids: asStrArray(c.source_ids),
      query: asStr(c.query),
      tool: asStr(c.tool),
    });
  }
  return out;
}

export function parseReportCitations(lines: Record<string, unknown>[]): ReportCitation[] {
  const out: ReportCitation[] = [];
  for (const r of lines) {
    const session_id = asStr(r.session_id);
    const turn_index = asNum(r.turn_index);
    if (!session_id || turn_index === null) continue;
    out.push({ session_id, turn_index, source_ids: asStrArray(r.source_ids) });
  }
  return out;
}
