#!/usr/bin/env node
// The minimal PreToolUse entrypoint (latency lever A,
// notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md).
//
// The managed pre-tool-use.sh hook runs THIS file (`node dist/pretool-entry.js`)
// directly instead of `mla _internal pretool-observe`. Both call the very same
// runInternalPretoolObserve core, so the deny decision is byte-identical; the only
// difference is the require graph. cli.js eagerly pulls all 30+ command modules
// (~150ms cold). This entry's transitive closure is only the ce0 store + the
// rules/scanner deny path (~12ms cold), a ~10x cold-start cut on the Write/Edit hot
// path. When this file is absent (a pkg binary, an older install), the hook falls
// back to `mla _internal pretool-observe`, so the slow path stays correct.
//
// It is a thin IO shell: read the decision via stdin (the core does it), forward the
// core's exit code, and fail OPEN (exit 0) on any unexpected rejection so an
// entrypoint fault can never escalate into a blocking hook decision.
import { runInternalPretoolObserve } from "./commands/internal-pretool-observe";

/**
 * Run the observe core with no argv (the PreToolUse payload arrives on stdin, not in
 * args) and forward its exit code. The core already fails open internally to exit 0;
 * the catch here is the belt-and-suspenders guard for an unexpected throw before the
 * promise settles, preserving the "never block a tool" invariant at the process edge.
 */
export async function runPretoolEntry(
  observe: (argv: string[]) => Promise<number> = runInternalPretoolObserve,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    exit(await observe([]));
  } catch {
    exit(0);
  }
}

if (require.main === module) {
  void runPretoolEntry();
}
