// src/lib/prompt.ts
//
// The synchronous Y/n confirmation the higher-blast-radius verbs gate on (minting a TEAM rule,
// attest, revoke). Shared because two commands now mint (`mla rules add` and `mla enrich accept`),
// and a second copy of "read one line from fd 0" is a second copy of the non-interactive footgun.
//
// Both are injectable at every call site, so no test ever touches a real tty.
import * as fs from "fs";

/** True only when a human is on both ends: a piped or CI invocation is NOT interactive. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Read one line of confirmation from stdin. Anything but y/yes is a no (fail-closed). */
export function confirm(prompt: string): boolean {
  process.stderr.write(`${prompt} [y/N] `);
  const buf = Buffer.alloc(256);
  try {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    const answer = buf.toString("utf8", 0, n).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  }
}
