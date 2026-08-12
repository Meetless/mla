// `mla _internal scrub-traces` -- drop the raw prompt bodies left in the LOCAL analytics
// trace by the pre-fix writer.
//
// Deliberately an explicit operator command and NOT part of any hook. A hot-path hook that
// silently rewrites history on every prompt is a worse failure than the exposure it fixes:
// it would rewrite under concurrent appends, and it would make the file's contents a
// function of how often the operator typed. Run once, read the report, rotate what it names.

import { existsSync } from "fs";
import { dirname, join } from "path";

import { resolveMeetlessHome } from "../lib/config";
import { scrubTraceFile, scrubSidecarDir } from "../lib/trace-scrub";

export function runInternalScrubTraces(argv: string[]): number {
  const explicit = argv.find((a) => !a.startsWith("-"));
  const logsDir = join(resolveMeetlessHome(), "logs");
  const path = explicit ?? join(logsDir, "ask-traces.jsonl");

  if (!existsSync(path)) {
    console.error(`no trace file at ${path}`);
    return 1;
  }

  const report = scrubTraceFile(path);

  console.log(`scrubbed ${report.scrubbed} of ${report.total} rows in ${path}`);
  if (report.unparseable > 0) {
    // Preserved, not dropped. Reported so an operator knows the file has rows this
    // command could not inspect, rather than reading a clean summary over a blind spot.
    console.log(`${report.unparseable} line(s) were not parseable and were left untouched`);
  }
  // The sidecar is the SECOND door on the same material and was the one still open: the
  // 2026-08-04 writer fix cleaned ask-traces.jsonl while `write_sidecar` kept printing the
  // identical prompt to logs/enrichments/<trace_id>.md, one file per turn, at mode 0644.
  // Scrubbing only the trace would have reported the leak closed while leaving the larger
  // half of it world-readable.
  const sidecars = scrubSidecarDir(explicit ? join(dirname(path), "enrichments") : join(logsDir, "enrichments"));
  if (sidecars.total > 0) {
    console.log(
      `sidecars: scrubbed ${sidecars.scrubbed} of ${sidecars.total}, tightened ${sidecars.tightened} to 0600`,
    );
  }

  const allKinds = [...new Set([...report.credentialKinds, ...sidecars.credentialKinds])].sort();
  if (allKinds.length > 0) {
    // Rule ids only. The point of the report is to tell an operator WHICH families to
    // rotate; printing the matched text would make the report a second copy of the secret.
    console.log(`credential shapes found (rotate these): ${allKinds.join(", ")}`);
  } else if (report.scrubbed > 0 || sidecars.scrubbed > 0) {
    console.log("no known credential shapes matched in the removed bodies");
  }
  return 0;
}
