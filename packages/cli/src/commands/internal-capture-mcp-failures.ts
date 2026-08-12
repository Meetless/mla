// `mla _internal capture-mcp-failures --session <sid> --turn <n> --transcript <path>`
//
// D3's writer. Recovers the governed pulls that were REFUSED and which no live hook
// can record, because Claude Code does not fire PostToolUse when a tool result carries
// `is_error: true`. See src/lib/analytics/mcp-failure-scan.ts for the measurement that
// established that, and for why the recommended "add an outcome field to the row" fix
// would have changed nothing on its own.
//
// Same shape as the two backstops stop.sh already runs (the AskUserQuestion decision
// scan and the enforcement-outcome correlator): the transcript is the ground truth,
// Stop already reads it, and what the live hook could not see is reconstructed there.
//
// Fail-soft like every other _internal subcommand: an argv error exits 2, anything
// else prints nothing and exits 0 so it can never disturb the hook that spawned it.

import * as fs from "fs";
import * as path from "path";
import { logsDir, readLogJsonlTail } from "../lib/analytics/logs";
import {
  scanTranscriptForFailedMcpPulls,
  sliceCurrentTurn,
  type FailedPullRow,
} from "../lib/analytics/mcp-failure-scan";

export interface CaptureMcpFailuresArgs {
  session: string | null;
  turn: number | null;
  transcript: string | null;
}

export function parseCaptureMcpFailuresArgs(argv: string[]): CaptureMcpFailuresArgs {
  const out: CaptureMcpFailuresArgs = { session: null, turn: null, transcript: null };
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
      case "--transcript":
        out.transcript = argv[++i] ?? "";
        if (!out.transcript) throw new Error("--transcript requires a value");
        break;
      default:
        throw new Error(`Unknown flag for \`mla _internal capture-mcp-failures\`: ${a}`);
    }
  }
  return out;
}

/** Parse a Claude Code transcript (JSONL). A torn final line is dropped, not thrown on. */
export function parseTranscript(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // The transcript is being appended to by another process while we read it, so a
      // clipped last line is ordinary rather than exceptional.
    }
  }
  return out;
}

export interface CaptureMcpFailuresDeps {
  readTranscript?: (p: string) => string;
  readLedger?: () => Record<string, unknown>[];
  appendLines?: (lines: string[]) => void;
  now?: () => string;
}

function defaultAppend(lines: string[]): void {
  if (!lines.length) return;
  const dir = logsDir();
  fs.mkdirSync(dir, { recursive: true });
  // One append of a few short lines, matching the unlocked single-append precedent in
  // internal-echo-scan.ts. Deliberately no lock: Stop already holds two, and a third
  // lock ordering is a deadlock waiting to be found by a user. The only other writer
  // of this file is post-tool-use.sh, which by construction never writes the rows this
  // one does -- it is not running for a call whose result was an error.
  fs.appendFileSync(path.join(dir, "mcp-calls.jsonl"), lines.map((l) => `${l}\n`).join(""));
}

export function runInternalCaptureMcpFailures(
  argv: string[],
  deps: CaptureMcpFailuresDeps = {},
): number {
  let args: CaptureMcpFailuresArgs;
  try {
    args = parseCaptureMcpFailuresArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  try {
    if (!args.session || args.turn === null || !args.transcript) return 0;

    const readTranscript = deps.readTranscript ?? ((p: string) => fs.readFileSync(p, "utf8"));
    let raw = "";
    try {
      raw = readTranscript(args.transcript);
    } catch {
      return 0;
    }

    const turnEntries = sliceCurrentTurn(parseTranscript(raw));
    if (!turnEntries.length) return 0;

    // Every tool_use_id the ledger already holds. Byte-bounded like every other reader
    // here; the scan is turn-bounded above, so this is a second line of defence rather
    // than the one that has to be complete.
    const readLedger = deps.readLedger ?? (() => readLogJsonlTail("mcp-calls.jsonl"));
    const known = new Set<string>();
    for (const row of readLedger()) {
      const id = row.tool_use_id;
      if (typeof id === "string" && id) known.add(id);
    }

    const rows: FailedPullRow[] = scanTranscriptForFailedMcpPulls(turnEntries, {
      sessionId: args.session,
      turnIndex: args.turn,
      known,
      ts: (deps.now ?? (() => new Date().toISOString()))(),
    });
    if (!rows.length) return 0;

    (deps.appendLines ?? defaultAppend)(rows.map((r) => JSON.stringify(r)));
    return 0;
  } catch {
    return 0;
  }
}
