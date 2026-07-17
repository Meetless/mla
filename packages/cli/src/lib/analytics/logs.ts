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
