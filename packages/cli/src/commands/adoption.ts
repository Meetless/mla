import * as path from "path";

import {
  AdoptionAggregate,
  FollowthroughRow,
  GovernedCatches,
  InjectTurn,
  McpCall,
  ReportCitation,
  buildAdoption,
  computeFollowthrough,
  countGovernedCatches,
  isGovernanceAction,
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
// The six interfaces go through `export type`. A plain `export { SomeInterface }`
// emits a runtime re-export of a binding that does not exist once a transpile-only
// compiler (ts-jest with isolatedModules, esbuild, swc) is in the chain, and the
// importer gets `undefined` with nothing raised anywhere.
export type {
  AdoptionAggregate,
  FollowthroughRow,
  GovernedCatches,
  InjectTurn,
  McpCall,
  ReportCitation,
};
export {
  buildAdoption,
  computeFollowthrough,
  countGovernedCatches,
  isGovernanceAction,
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
  const lines = [
    `Evidence-followthrough (A1) over ${a.inject_turns} high-value inject turn(s):`,
    `  A1c any followthrough:    ${frac(a.a1c_any)} (${pct(a.a1c_rate)})`,
    `  A1a pull-followthrough:   ${frac(a.a1a_pull)} (${pct(a.a1a_rate)})`,
    `  A1b push-reference:       ${frac(a.a1b_push_reference)} (${pct(a.a1b_rate)})`,
    `  No followthrough:         ${frac(a.no_followthrough)} (${pct(
      a.inject_turns ? a.no_followthrough / a.inject_turns : 0,
    )})`,
  ];
  // A2 governed catches: the act side (see followthrough.ts). A floor, not a rate,
  // so it renders as a raw count with its action-class breakdown, no denominator.
  // Session-scoped (this session, or every session under --all), independent of
  // the --last inject window that bounds the A1 block above.
  const gc = a.governed_catches;
  lines.push(`Governed catches (A2): ${gc.catches}`);
  if (gc.catches > 0) {
    const breakdown = Object.entries(gc.by_tool)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .map(([tool, n]) => `${tool} ${n}`)
      .join(", ");
    lines.push(`  by action: ${breakdown}`);
  }
  return lines.join("\n");
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

  // A2 governed catches follow the same SESSION scope as the view (scoped -> this
  // session, --all -> every session) but NOT the --last inject-turn window: a
  // catch is a floor count of adjudications, not a per-inject-turn score, so
  // slicing it by the inject denominator would silently drop a session's verdicts.
  // The command is globally inject-gated above, so we only ever report catches in a
  // run where governed memory was demonstrably in play.
  const catchCalls = scoped ? calls.filter((c) => c.session_id === session) : calls;

  const rows = computeFollowthrough(injects, calls, citations, args.window);
  const agg = buildAdoption(rows, catchCalls);
  if (args.json) {
    console.log(JSON.stringify(agg, null, 2));
  } else {
    console.log(renderAdoption(agg));
  }
  return 0;
}
