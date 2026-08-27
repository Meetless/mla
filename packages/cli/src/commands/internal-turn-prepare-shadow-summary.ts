// `mla _internal turn-prepare-shadow-summary` (E1 shadow, read-only). Reads the accumulated
// e1-shadow.log and prints a descriptive summary of what the shadow has observed so far: how many
// turns were comparable, per-dimension exact-set agreement, canonical skips/failures, and the
// distinct only_L / only_C rule ids that attribute each divergence.
//
// It is NOT a gate and declares no threshold. The cutover criterion is a human judgement ("the
// meaningful decision-input varieties have been exercised and there is zero UNEXPLAINED divergence
// on the load-bearing tiers"), never an N-turns count, so this only surfaces the raw picture the
// reader needs to make that call. Reads one file, writes stdout, mutates nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveMeetlessHome } from "../lib/config";
import { summarizeShadowLog, formatShadowSummary } from "../lib/turn-prepare-shadow";

export function runInternalTurnPrepareShadowSummary(argv: string[] = []): number {
  // Default to the hook's log location; allow an explicit path as the first positional for ad-hoc
  // analysis of a copied/rotated log.
  const explicit = argv.find((a) => !a.startsWith("-"));
  const logPath = explicit ?? path.join(resolveMeetlessHome(), "logs", "e1-shadow.log");

  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    console.log(`e1_shadow summary over ${logPath}\ncomparable turns: 0\n(no log yet: the shadow has not run, or MEETLESS_E1_SHADOW was never set)`);
    return 0;
  }

  const summary = summarizeShadowLog(text.split("\n"));
  console.log(formatShadowSummary(summary, logPath));
  return 0;
}
