import * as path from "path";

import {
  AdoptionAggregate,
  FollowthroughRow,
  InjectTurn,
  McpCall,
  ReportCitation,
  buildAdoption,
  computeFollowthrough,
  parseInjectTurns,
  parseMcpCalls,
  parseReportCitations,
} from "../lib/analytics/followthrough";
import { logsDir, readLogJsonl } from "../lib/analytics/logs";

// `mla adoption` -- A1 evidence-followthrough, the backbone adoption metric
// (notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 A1, §7.2, §7.4).
//
//   mla adoption [--last N] [--window W] [--json] [--all]
//
// The join math lives in src/lib/analytics/followthrough.ts -- the ONE shared
// implementation that `mla adoption`, the evidence section of `mla stats`, and
// the Stop-hook local correlator all reference (INV-ADOPTION-SOURCE-1). This
// command owns only the local file reading, scoping, and rendering; it
// re-exports the join symbols so existing importers keep working.
//
// Scoping mirrors `mla summary`: auto-scope to the current live session
// (CLAUDE_CODE_SESSION_ID), `--all` for the cross-session aggregate, `--last N`
// over inject turns. Paths resolve lazily from MEETLESS_HOME so tests stay
// hermetic.

// Re-export the shared join surface so prior importers (cli.ts, the parity
// spec) keep importing from `commands/adoption` unchanged.
export {
  AdoptionAggregate,
  FollowthroughRow,
  InjectTurn,
  McpCall,
  ReportCitation,
  buildAdoption,
  computeFollowthrough,
  parseInjectTurns,
  parseMcpCalls,
  parseReportCitations,
};

// The log directory + jsonl reader live in lib/analytics/logs.ts (logsDir,
// readLogJsonl), the ONE module `mla adoption`, `mla stats`, and the Stop-hook
// correlator share. This command owns only scoping and rendering.

// --- args + render ----------------------------------------------------------

export interface AdoptionArgs {
  last: number;
  json: boolean;
  all: boolean;
  window: number;
}

export function parseAdoptionArgs(argv: string[]): AdoptionArgs {
  const out: AdoptionArgs = { last: 50, json: false, all: false, window: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--all") out.all = true;
    else if (a === "--last") {
      const v = argv[++i];
      const parsed = Number(v);
      if (!v || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--last requires a positive integer (got: ${v ?? "(none)"})`);
      }
      out.last = parsed;
    } else if (a === "--window") {
      const v = argv[++i];
      const parsed = Number(v);
      if (v === undefined || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--window requires a non-negative integer (got: ${v ?? "(none)"})`);
      }
      out.window = parsed;
    } else throw new Error(`Unknown flag for \`mla adoption\`: ${a}`);
  }
  return out;
}

function renderAdoption(a: AdoptionAggregate): string {
  const pct = (r: number) => (r * 100).toFixed(0) + "%";
  const frac = (x: number) => `${x}/${a.inject_turns}`;
  return [
    `Evidence-followthrough (A1) over ${a.inject_turns} high-value inject turn(s):`,
    `  A1c any followthrough:    ${frac(a.a1c_any)} (${pct(a.a1c_rate)})`,
    `  A1a pull-followthrough:   ${frac(a.a1a_pull)} (${pct(a.a1a_rate)})`,
    `  A1b push-reference:       ${frac(a.a1b_push_reference)} (${pct(a.a1b_rate)})`,
    `  No followthrough:         ${frac(a.no_followthrough)} (${pct(
      a.inject_turns ? a.no_followthrough / a.inject_turns : 0,
    )})`,
  ].join("\n");
}

export function runAdoption(argv: string[]): number {
  let args: AdoptionArgs;
  try {
    args = parseAdoptionArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let injects = parseInjectTurns(readLogJsonl("ask-traces.jsonl"));
  const calls = parseMcpCalls(readLogJsonl("mcp-calls.jsonl"));
  const citations = parseReportCitations(readLogJsonl("report-citations.jsonl"));

  // Auto-scope to the current live session (same contract as `mla summary`).
  // Scope the inject denominator BEFORE --last so the window is "last N inject
  // turns of this session". The pull/report sides are matched per-session in the
  // join, so scoping only the inject side is sufficient.
  const session = (process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  const scoped = !args.all && session.length > 0;
  if (scoped) injects = injects.filter((t) => t.session_id === session);

  if (injects.length === 0) {
    const at = path.join(logsDir(), "ask-traces.jsonl");
    console.error(
      scoped
        ? `No high-value inject turns for the current session (${session}) in ${at}. Use --all for every session.`
        : `No high-value inject turns found in ${at}.`,
    );
    return 1;
  }

  // Stable per-session turn order, then keep the most recent N inject turns.
  injects.sort((a, b) =>
    a.session_id === b.session_id
      ? a.turn_index - b.turn_index
      : a.session_id < b.session_id
        ? -1
        : 1,
  );
  injects = injects.slice(-args.last);

  const rows = computeFollowthrough(injects, calls, citations, args.window);
  const agg = buildAdoption(rows);
  if (args.json) {
    console.log(JSON.stringify(agg, null, 2));
  } else {
    console.log(renderAdoption(agg));
  }
  return 0;
}
