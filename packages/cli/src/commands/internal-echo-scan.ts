// `mla _internal echo-scan --session <sid> --turn <n>` -- the F1b writer.
//
// Reads the turn's own closing output on stdin, compares it against the snippets mla
// INJECTED on that turn (from its ask-traces line), and appends the ids that were quoted
// verbatim to logs/evidence-echoes.jsonl. The per-turn recap joins that spool as
// `echoed_source_ids`, reported beside pulled/cited/opened and never merged into them.
//
// Why the scan lives here and not in the recap: the recap runs at the NEXT prompt, where the
// finished turn's text is long gone. The text exists exactly once, at Stop, in the hook that
// already extracted it for report-citations. So Stop pipes it in, this writes the ANSWER,
// and no turn output is ever stored: the spool holds source ids, nothing else. That ordering
// is the whole privacy story for this feature.
//
// Fail-soft like every other _internal subcommand: an argv error exits 2, anything else
// prints nothing and exits 0 so it can never disturb the hook that spawned it.

import * as fs from "fs";
import * as path from "path";
import { logsDir, readLogJsonlTail } from "../lib/analytics/logs";
import { EchoScanItem, scanEchoes } from "../lib/analytics/evidence-echo";

export interface EchoScanArgs {
  session: string | null;
  turn: number | null;
}

export function parseEchoScanArgs(argv: string[]): EchoScanArgs {
  const out: EchoScanArgs = { session: null, turn: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--session":
        out.session = argv[++i] ?? "";
        if (!out.session) throw new Error("--session requires a value");
        break;
      case "--turn": {
        const v = argv[++i];
        if (!v || !/^[0-9]+$/.test(v) || Number(v) < 1) {
          throw new Error(`--turn requires a positive integer: ${v ?? "(missing)"}`);
        }
        out.turn = Number(v);
        break;
      }
      default:
        throw new Error(`Unknown flag for \`mla _internal echo-scan\`: ${a}`);
    }
  }
  return out;
}

/**
 * The snippets mla injected on one turn, from its ask-traces line.
 *
 * Only items with `injected: true` AND a non-empty source_id, which is the same offered set
 * the recap computes: an item mla decided not to inject cannot have been echoed, and a
 * session-local self-echo item carries a null source_id (it is the agent's OWN earlier text,
 * so "the agent quoted it" would be trivially true and would mean nothing).
 */
export function injectedSnippets(lines: Record<string, unknown>[], sessionId: string, turnIndex: number): EchoScanItem[] {
  let items: EchoScanItem[] = [];
  for (const line of lines) {
    if (line.session_id !== sessionId || line.turn_index !== turnIndex) continue;
    const enrichment = (line.enrichment ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(enrichment.context_items) ? enrichment.context_items : [];
    const found: EchoScanItem[] = [];
    for (const r of raw) {
      const item = (r ?? {}) as Record<string, unknown>;
      if (item.injected !== true) continue;
      const sid = typeof item.source_id === "string" ? item.source_id : "";
      const text = typeof item.text === "string" ? item.text : "";
      if (!sid || !text) continue;
      found.push({ source_id: sid, text });
    }
    // Last line for the turn wins, matching computeTurnRecap's re-emit rule.
    items = found;
  }
  return items;
}

export interface EchoScanDeps {
  readStdin?: () => string;
  readTraces?: () => Record<string, unknown>[];
  appendLine?: (line: string) => void;
  now?: () => string;
}

function defaultAppend(line: string): void {
  const dir = logsDir();
  fs.mkdirSync(dir, { recursive: true });
  // Single append of one line under 4KB: atomic enough on every filesystem we run on, and
  // the reader tolerates a torn line anyway. No lock, deliberately: the Stop hook already
  // holds two, and a third lock ordering is a deadlock waiting to be discovered by a user.
  fs.appendFileSync(path.join(dir, "evidence-echoes.jsonl"), `${line}\n`);
}

export function runInternalEchoScan(argv: string[], deps: EchoScanDeps = {}): number {
  let args: EchoScanArgs;
  try {
    args = parseEchoScanArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  try {
    if (!args.session || args.turn === null) return 0;

    const readTraces = deps.readTraces ?? (() => readLogJsonlTail("ask-traces.jsonl"));
    const items = injectedSnippets(readTraces(), args.session, args.turn);
    // Nothing was offered on this turn, so there is nothing an echo could refer to. Write no
    // row: a turn with no offer is already a NO_OFFER in the recap, and an empty echo row
    // there would suggest a scan whose subject existed.
    if (!items.length) return 0;

    const readStdin = deps.readStdin ?? (() => fs.readFileSync(0, "utf8"));
    let output = "";
    try {
      output = readStdin();
    } catch {
      output = "";
    }

    const ids = scanEchoes(items, output);
    const line = JSON.stringify({
      ts: (deps.now ?? (() => new Date().toISOString()))(),
      event: "evidence_echo",
      session_id: args.session,
      turn_index: args.turn,
      // Written even when empty, on purpose: "the scan ran and found no quotation" is a real
      // observation, and without the row it is byte-identical to "the scan never ran", which
      // is the exact confusion that let a stale zero read as all-clear for eight days.
      source_ids: ids,
    });
    (deps.appendLine ?? defaultAppend)(line);
    return 0;
  } catch {
    return 0;
  }
}
