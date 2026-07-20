// `mla _internal codex-hook <event>`: the Codex connector's thin hook wrapper.
//
// Codex's PreToolUse is wired DIRECTLY at `mla _internal pretool-observe` (that
// command already reads the Claude-shaped snake_case payload Codex sends and
// emits the byte-identical deny envelope, so it needs no shim). UserPromptSubmit
// is the one event that DOES need a wrapper: the grounding assembly is a ~92 KB
// bash script at `~/.meetless/hooks/user-prompt-submit.sh`, and this command's
// only job is to hand Codex's stdin to that shared script and relay whatever it
// prints back to Codex as the hook's `additionalContext`. It does NOT
// re-implement grounding, and it is NOT a generic multi-event dispatcher: it
// carries exactly the events with a real translation need (today: one).
//
// Fail-OPEN on everything. A UserPromptSubmit hook must never block or error the
// prompt; grounding is assistive. Any failure (unknown event, unreadable stdin,
// a missing or throwing script) emits nothing and exits 0 so the turn proceeds.

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

import { HOOKS_DIR } from "../lib/config";

// Event name (as Codex passes it on argv) -> the shared hook script that owns it.
// A 1-entry allowlist, not a dispatcher: an event absent here is a silent no-op.
const EVENT_SCRIPT: Record<string, string> = {
  "user-prompt-submit": "user-prompt-submit.sh",
};

export interface CodexHookDeps {
  readStdin?: () => Promise<string>;
  writeOut?: (s: string) => void;
  hooksDir?: string;
  runScript?: (scriptPath: string, input: string) => string;
}

function readStdinReal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// Run the shared grounding script with `input` on its stdin and return its
// stdout. `bash <script>` explicitly (not exec-bit dependent). Env is inherited
// so the script resolves HOOKS_DIR and its bash dependencies the same way it
// does under Claude; MEETLESS_CONNECTOR marks the surface for telemetry without
// altering the Claude-shaped payload the script parses.
function runScriptReal(scriptPath: string, input: string): string {
  const res = spawnSync("bash", [scriptPath], {
    input,
    encoding: "utf8",
    env: { ...process.env, MEETLESS_CONNECTOR: "codex" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return typeof res.stdout === "string" ? res.stdout : "";
}

export async function runInternalCodexHook(
  argv: string[],
  deps: CodexHookDeps = {},
): Promise<number> {
  const readStdin = deps.readStdin ?? readStdinReal;
  const writeOut = deps.writeOut ?? ((s: string) => process.stdout.write(s));
  const hooksDir = deps.hooksDir ?? HOOKS_DIR;
  const runScript = deps.runScript ?? runScriptReal;

  try {
    const event = argv[0];
    const scriptName = event ? EVENT_SCRIPT[event] : undefined;
    if (!scriptName) return 0; // unknown/absent event: nothing to translate

    const input = await readStdin();
    const scriptPath = path.join(hooksDir, scriptName);
    if (!fs.existsSync(scriptPath)) return 0; // scripts not provisioned yet

    const stdout = runScript(scriptPath, input);
    if (stdout) writeOut(stdout);
    return 0;
  } catch {
    return 0;
  }
}
