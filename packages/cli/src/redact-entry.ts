#!/usr/bin/env node
// The minimal redact-capture entrypoint (latency lever A, extended to UserPromptSubmit,
// notes/20260809-did-mla-help-session-0e61cbd5-the-doctrine-loses-to-its-own-quotations.md D1).
//
// user-prompt-submit.sh runs THIS file instead of `mla _internal redact-capture`. Both
// call the very same runInternalRedactCapture core, so the redacted body and the exit
// code are byte-identical; the only difference is the require graph. cli.js eagerly pulls
// all 30+ command modules plus Sentry/analytics top-level init; this entry's transitive
// closure is `commands/internal-redact-capture` -> `lib/redactor`, which is a leaf module
// with no imports of its own. When this file is absent (a pkg binary, an older install)
// the hook falls back to `mla _internal redact-capture`, so the slow path stays correct.
//
// WHY TWO ENTRY FILES AND NOT ONE DISPATCHER. Measured 2026-08-09, interleaved, median
// of 9 (`node <probe>`, cold page cache defeated by interleaving):
//
//     empty script (node's own floor)             25ms
//     redact-capture closure alone                26ms   <- free
//     assemble-context closure alone             144ms
//     BOTH closures in one process               141ms
//     dist/cli.js --version (does NOTHING)       334ms
//
// A single shared entry would drag assemble-context's ~120ms closure onto the redaction
// spawn for nothing: 141+141 per turn against 144+26 for two entries, i.e. ~112ms/turn
// worse. The redactor's closure is a leaf and must stay one.
//
// IT FAILS CLOSED, WHICH IS THE OPPOSITE OF pretool-entry.ts, AND THAT IS DELIBERATE.
// The PreToolUse entry exits 0 on an unexpected throw because a crashed permissive hook
// must never become a blocking decision. Here the caller is a REDACTOR: a non-zero exit
// with no body is exactly how the hook learns to persist `contentStatus:
// "redaction_failed"` and keep only safe metadata. Swallowing the failure into exit 0
// would hand the hook an empty-but-successful redaction, and an empty body that reads as
// success is how an unredacted secret reaches disk. Every failure path below returns 1
// and writes nothing.
import { runInternalRedactCapture } from "./commands/internal-redact-capture";
import { installStdioEpipeGuard } from "./lib/stdio-guard";

/**
 * Run the redact core with no argv (the payload arrives on stdin) and forward its exit
 * code unchanged. An unexpected throw before the promise settles becomes exit 1, never 0.
 */
export async function runRedactEntry(
  redact: (argv: string[]) => Promise<number> = runInternalRedactCapture,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    exit(await redact([]));
  } catch {
    exit(1);
  }
}

if (require.main === module) {
  // First, before anything can write. The hook owns this stdout pipe and may close it at
  // any moment; Node reports that as a stream `error` event, which the try/catch above is
  // structurally unable to see.
  installStdioEpipeGuard();
  void runRedactEntry();
}
