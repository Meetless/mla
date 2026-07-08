// `mla turn [N]` -- the operator-facing per-turn assist recap (Layer B of
// notes/20260609-mla-per-turn-assist-recap-plan.md). The cheap, always-available,
// zero-model-cost answer to "how did mla do?" for a single turn:
//
//   mla turn               recap the latest completed turn of the current session
//   mla turn 5             recap turn 5
//   mla turn --session X   target another session
//   mla turn 5 --json      machine output (the full TurnRecap)
//
// It reads the same three local spool files as `mla stats` and computes the recap
// via Layer A computeTurnRecap. `mla stats --turn [N]` is wired to this same
// handler (commands/stats.ts) so the feature is discoverable from the stats surface
// An framed it against. Unlike `mla _internal turn-recap` (fail-soft for the hook),
// this is a human read: a strict argv error exits 2, a missing session exits 1.

import { parseMcpCalls, parseReportCitations } from "../lib/analytics/followthrough";
import { readLogJsonl } from "../lib/analytics/logs";
import { TurnRecap, computeTurnRecap, parseAskTrace, renderBlock } from "../lib/analytics/turn-recap";

export interface TurnArgs {
  session: string | null;
  turn: number | null;
  json: boolean;
}

export function parseTurnArgs(argv: string[]): TurnArgs {
  const out: TurnArgs = { session: null, turn: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--session":
        out.session = argv[++i] ?? "";
        if (!out.session) throw new Error("--session requires a value");
        break;
      case "--json":
        out.json = true;
        break;
      default: {
        // A number-shaped token (including a leading '-' or a decimal) is a
        // turn-index candidate, so `mla turn -1` / `mla turn 1.5` report a clear
        // turn error rather than the misleading "unknown flag". A non-numeric
        // leading-dash token is a genuine unknown flag.
        const numeric = /^-?\d*\.?\d+$/.test(a);
        if (!numeric && a.startsWith("-")) throw new Error(`Unknown flag for \`mla turn\`: ${a}`);
        if (out.turn !== null) throw new Error("`mla turn` takes one turn index at most");
        if (!/^[0-9]+$/.test(a) || Number(a) < 1) {
          throw new Error(`turn index must be a positive integer: ${a}`);
        }
        out.turn = Number(a);
      }
    }
  }
  return out;
}

type ReadLog = (file: string) => Record<string, unknown>[];

// The latest turn that left ANY trace on disk for this session: the max turn_index
// across the three spool files (the inject side, the pull side, the cite side).
// Reading all three (not just ask-traces) means a turn that only produced a pull or
// a citation still counts as the latest, and a NOT_RUN turn whose minimal trace
// line landed is found too. Returns null when the session has no turns yet.
export function latestTurnIndex(sessionId: string, readLog: ReadLog): number | null {
  let max: number | null = null;
  const bump = (t: number) => {
    if (max === null || t > max) max = t;
  };
  for (const raw of readLog("ask-traces.jsonl")) {
    const t = parseAskTrace(raw);
    if (t && t.session_id === sessionId) bump(t.turn_index);
  }
  for (const c of parseMcpCalls(readLog("mcp-calls.jsonl"))) {
    if (c.session_id === sessionId) bump(c.turn_index);
  }
  for (const r of parseReportCitations(readLog("report-citations.jsonl"))) {
    if (r.session_id === sessionId) bump(r.turn_index);
  }
  return max;
}

export interface TurnCmdDeps {
  readLog?: ReadLog;
  // Test seam: compute the recap for a resolved (session, turn). Defaults to Layer A.
  compute?: (sessionId: string, turnIndex: number) => TurnRecap;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runTurn(argv: string[], deps: TurnCmdDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  let args: TurnArgs;
  try {
    args = parseTurnArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  const env = deps.env ?? process.env;
  const session = (args.session ?? env.CLAUDE_CODE_SESSION_ID ?? "").trim();
  if (!session) {
    err(
      "No session id provided and no $CLAUDE_CODE_SESSION_ID env. " +
        "Run `mla turn` inside a Claude Code session, or pass --session <sid>.",
    );
    return 1;
  }

  const readLog = deps.readLog ?? readLogJsonl;
  const turn = args.turn ?? latestTurnIndex(session, readLog);
  if (turn === null) {
    log(`No turns recorded for session ${session} yet.`);
    return 0;
  }

  const compute = deps.compute ?? ((s: string, t: number) => computeTurnRecap(s, t, { readLog }));
  const recap = compute(session, turn);

  if (args.json) {
    log(JSON.stringify(recap, null, 2));
  } else {
    log(renderBlock(recap));
  }
  return 0;
}
