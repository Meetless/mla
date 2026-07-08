// Detached delivery bridge for hook-emitted enforcement incidents (STAR review
// queue, INV-ENFORCEMENT-DELIVERY-1). The PreToolUse deny hot path records the
// mla_enforcement_incident to the local events.jsonl and buffers it for the generic
// in-process forward, then the short-lived hook process exits BEFORE anything drains
// that buffer (recorder.ts: the buffer is the "only forward attempt ... there is no
// cross-run replay", and the deny path never reaches a flush before process.exit). So
// the incident was durable locally but never reached control's analytics ingest, and
// the console /value review queue never saw a real deny.
//
// This spawns a detached, unref'd child that re-reads the session's incidents from
// events.jsonl and POSTs them to control (mla _internal forward-enforcement). The child
// outlives the exiting hook (adopted by init/launchd), so the deny's own hot path stays
// zero-network: the fork costs a few ms, the slow cli.js load + network happen off the
// blocked turn. Idempotent: control dedupes by (workspace_id, event_id), so a re-run
// (or a later flush) never double-counts a rollup.
//
// Fully fire-and-forget: any failure to spawn is swallowed. A telemetry forward must
// never disturb the deny it rode on.

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export function spawnEnforcementForward(
  sessionId: string | null,
  entry: string | undefined = process.argv[1],
): void {
  try {
    if (!sessionId) return; // nothing to scope the forward to
    if (!entry) return; // no re-invokable entry; skip rather than guess
    // The deny hot path runs from pretool-entry.js; the forwardable CLI is its dist
    // sibling cli.js (never pretool-entry.js, which does not route _internal). Resolve
    // it explicitly and skip if it isn't there (e.g. under a test runner, or a partial
    // install) rather than spawn a script that cannot handle the subcommand.
    const cliJs = path.join(path.dirname(entry), "cli.js");
    if (!fs.existsSync(cliJs)) return;

    const child = spawn(
      process.execPath,
      [cliJs, "_internal", "forward-enforcement", "--session", sessionId],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {}); // swallow ENOENT etc; never throw from here
    child.unref();
  } catch {
    // never let the forward spawn break the deny it rode on
  }
}
