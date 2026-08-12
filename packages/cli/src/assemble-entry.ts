#!/usr/bin/env node
// The minimal assemble-context entrypoint (latency lever A, extended to UserPromptSubmit,
// notes/20260809-did-mla-help-session-0e61cbd5-the-doctrine-loses-to-its-own-quotations.md D1).
//
// user-prompt-submit.sh runs THIS file instead of `mla _internal assemble-context`. Both
// call the very same runAssembleContext core, so the assembled head, the stderr payload
// and the exit code are byte-identical; the only difference is the require graph. cli.js
// eagerly pulls all 30+ command modules plus Sentry/analytics top-level init; this entry's
// closure is the scanner + rules path this command actually uses. When this file is absent
// (a pkg binary, an older install) the hook falls back to `mla _internal assemble-context`.
//
// Measured 2026-08-09, interleaved, median of 9: this closure is 144ms against
// `dist/cli.js --version` at 334ms for a command that does NOTHING, so ~190ms of every
// pre-enrich spawn was command registry the hook never touches. `pre_enrich_ms` over the
// live ledger is median 928ms / p90 1,745ms, and the audited session's two timed-out turns
// burned 1,453ms and 1,679ms of a 6,000ms budget here BEFORE the request was made. This
// spends less before the call; it is NOT a budget raise, which is separately refused on
// measurement (the 6s-to-8s band is empty and the tail is contention). See redact-entry.ts
// for why the two entries are not merged into one dispatcher.
//
// THE EXIT CODE IS LOAD-BEARING AND MUST PASS THROUGH UNTOUCHED. rc==3 is the fail-closed
// delivery signal: the head still prints on stdout while the UNDELIVERED RuleVersions ride
// on stderr, and the hook turns that into DELIVERY_STATUS=DELIVERY_FAILED and a blocked
// prompt, so a turn is never reported INJECTED while a MUST went undelivered. Collapsing
// rc 3 to 0 here would silently disarm floor enforcement. rc==2 is a usage error. rc==0 is
// normal delivery, a visible degraded state, or a fail-soft error the bash fallback owns.
//
// An unexpected throw exits 0, matching the core's own fail-soft contract: exit 0 with no
// stdout is precisely the state in which user-prompt-submit.sh emits its own LAYER1 +
// floor head. Exiting non-zero there would convert a recoverable assembly fault into a
// blocked prompt, which is a strictly worse outcome than the floor the bash path already
// delivers on its own.
import { runAssembleContext } from "./commands/assemble-context";
import { installStdioEpipeGuard } from "./lib/stdio-guard";

/**
 * Run the assemble core with no argv (the payload arrives on stdin) and forward its exit
 * code unchanged, including the load-bearing rc==3.
 */
export async function runAssembleEntry(
  assemble: (argv: string[]) => Promise<number> = runAssembleContext,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    exit(await assemble([]));
  } catch {
    exit(0);
  }
}

if (require.main === module) {
  // First, before anything can write. The hook owns this stdout pipe and may close it at
  // any moment; Node reports that as a stream `error` event, which the try/catch above is
  // structurally unable to see.
  installStdioEpipeGuard();
  void runAssembleEntry();
}
