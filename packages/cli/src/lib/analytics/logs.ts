// Local trace-log directory + reader (spec section 7.4). The hook spool writes the
// three followthrough trace files here: ask-traces.jsonl (the inject side),
// mcp-calls.jsonl (the pull side), and report-citations.jsonl (the push-reference
// side). `mla adoption`, the evidence section of `mla stats`, and the Stop-hook
// correlator all read them through this ONE module so the path and the
// lenient-parse semantics match exactly (INV-ADOPTION-SOURCE-1).
//
// The path resolves from the LIVE MEETLESS_HOME on every call, NOT the module-load
// cached config.HOME, because the user-prompt-submit hook sets MEETLESS_HOME at
// spawn time and the detached correlator process must read the same logs directory
// the hook wrote to. (events.jsonl, by contrast, is read through store.ts on the
// cached HOME; in the live CLI the two agree because the env is fixed at startup.)

import * as fs from "fs";
import * as path from "path";
import { resolveMeetlessHome } from "../config";

// The trace-log directory: $MEETLESS_HOME/logs (live env, matching the hook spool).
export function logsDir(): string {
  return path.join(resolveMeetlessHome(), "logs");
}

// Read one jsonl trace file under logsDir(). Lenient: a blank, partially-written,
// or corrupt line is skipped, never fatal, so a crash mid-append can never brick a
// reader. Returns [] when the file is absent.
export function readLogJsonl(file: string): Record<string, unknown>[] {
  const p = path.join(logsDir(), file);
  if (!fs.existsSync(p)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") out.push(o as Record<string, unknown>);
    } catch {
      // tolerate a partially-written or corrupt line
    }
  }
  return out;
}

// Default tail window for readLogJsonlTail. ask-traces lines average ~8.4KB (measured over
// the last 200 rows of the live spool, max 34KB), so 8MB is roughly the last 950 turns
// across every concurrent session on this machine. A Stop-time reader is looking for a line
// its OWN turn wrote at prompt time, so it would take ~950 intervening turns from other
// sessions, inside one turn, to fall out of the window.
const TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Read the TAIL of one jsonl trace file, for readers that only ever want a recent turn.
 *
 * ask-traces.jsonl is 35MB and grows; parsing all of it to find one line is the kind of cost
 * that gets a best-effort hook killed by its own timeout. This reads the last `maxBytes`
 * only, drops the leading (possibly partial) line, and otherwise behaves exactly like
 * readLogJsonl.
 *
 * Deliberately NOT used by computeTurnRecap: that reader also answers `mla turn N` for an
 * arbitrary N, where truncating the window would turn an old turn into a silent "no trace"
 * and it would read as a liveness gap rather than as a windowing artifact.
 */
export function readLogJsonlTail(file: string, maxBytes = TAIL_BYTES): Record<string, unknown>[] {
  const p = path.join(logsDir(), file);
  if (!fs.existsSync(p)) return [];
  const size = fs.statSync(p).size;
  if (size <= maxBytes) return readLogJsonl(file);

  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const text = buf.toString("utf8");
    const out: Record<string, unknown>[] = [];
    // Drop the first element: the window almost certainly starts mid-line, and a half-line
    // is not a parse failure to tolerate, it is a known artifact of the window.
    const lines = text.split("\n").slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === "object") out.push(o as Record<string, unknown>);
      } catch {
        // tolerate a partially-written or corrupt line
      }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
