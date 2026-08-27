// `mla _internal codex-hook <event>`: the Codex connector's thin hook wrapper.
//
// Codex's PreToolUse is wired DIRECTLY at `mla _internal pretool-observe` (that
// command already reads the Claude-shaped snake_case payload Codex sends and
// emits the byte-identical deny envelope, so it needs no shim). The other
// lifecycle events enter through this wrapper, which marks the connector and
// delegates to the shared capture scripts. UserPromptSubmit keeps a session
// bootstrap fallback in case an already-running Codex host has not loaded the
// newly installed SessionStart entry yet.
//
// Fail-OPEN on everything. Capture is assistive: any failure emits nothing and
// exits 0 so the Codex lifecycle proceeds.

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

import { ensureCodexRuntimeHooks } from "../connectors/codex/runtime-hooks";
import { codexIntegrationDiagnostic } from "../connectors/codex/wire";

interface ScriptStep {
  script: string;
  relayOutput: boolean;
}

// Event name (as Codex passes it on argv) -> ordered shared-script plan. Only
// scripts whose output is valid and useful for that Codex event are relayed.
const EVENT_SCRIPTS: Record<string, ScriptStep[]> = {
  "session-start": [{ script: "session-start.sh", relayOutput: false }],
  "user-prompt-submit": [
    { script: "session-start.sh", relayOutput: false },
    { script: "user-prompt-submit.sh", relayOutput: true },
  ],
  "post-tool-use": [{ script: "post-tool-use.sh", relayOutput: true }],
  stop: [{ script: "stop.sh", relayOutput: false }],
};

export interface CodexHookDeps {
  readStdin?: () => Promise<string>;
  writeOut?: (s: string) => void;
  hooksDir?: string;
  resolveHooksDir?: () => string;
  runScript?: (scriptPath: string, input: string) => string;
  /** Test seam: which hooks.json to inspect for the partial-install warning. */
  codexHooksPath?: string;
  /** Where the partial-install warning goes. Defaults to stderr, which is where
   *  Codex surfaces hook output to the operator. */
  warn?: (line: string) => void;
}

function readStdinReal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// Run a shared hook script with `input` on stdin and return stdout. `bash
// <script>` explicitly (not exec-bit dependent). Env is inherited so the script
// resolves its co-located bash dependencies the same way it does under Claude;
// MEETLESS_CONNECTOR enables the few transcript-shape adaptations the shared
// scripts need for Codex.
function runScriptReal(scriptPath: string, input: string): string {
  const invokedCli = process.argv[1];
  const codexMlaPath =
    typeof invokedCli === "string" && invokedCli.length > 0
      ? path.resolve(invokedCli)
      : undefined;
  const res = spawnSync("bash", [scriptPath], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      MEETLESS_CONNECTOR: "codex",
      ...(codexMlaPath ? { MEETLESS_CODEX_MLA_PATH: codexMlaPath } : {}),
    },
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
  const runScript = deps.runScript ?? runScriptReal;

  try {
    const event = argv[0];
    const steps = event ? EVENT_SCRIPTS[event] : undefined;
    if (!steps) return 0; // unknown/absent event: nothing to translate
    const hooksDir =
      deps.hooksDir ??
      (deps.resolveHooksDir ?? ensureCodexRuntimeHooks)();

    // A PARTIAL install is announced ONCE, at the start of the session it will
    // silently fail to capture into knowledge. Codex fires SessionStart,
    // UserPromptSubmit and PostToolUse normally when `Stop` is missing, so events
    // accumulate, no finalize is ever requested, turn assembly never runs, and the
    // session produces zero claims while looking healthy from every angle an
    // operator can see.
    //
    // SESSION-START ONLY, because this is the per-event hot path: on post-tool-use
    // the same line would land in the operator's editor on every tool call.
    //
    // AND CAPTURE STILL RUNS. Refusing the bootstrap would delete the events too,
    // which buys nothing (they are cheap, and they are the evidence that the
    // integration is half-installed) and risks the Codex lifecycle this wrapper
    // documents itself as never breaking. What is refused is the silent pretence
    // that the session is being captured into knowledge.
    if (event === "session-start") {
      try {
        const diagnostic = codexIntegrationDiagnostic(
          deps.codexHooksPath ? { hooksPathOverride: deps.codexHooksPath } : {},
        );
        if (diagnostic.state === "partial" && diagnostic.message) {
          (deps.warn ?? ((l: string) => process.stderr.write(l + "\n")))(diagnostic.message);
        }
      } catch {
        /* fail open: a diagnostic must never be what breaks capture */
      }
    }

    const input = await readStdin();
    for (const step of steps) {
      try {
        const scriptPath = path.join(hooksDir, step.script);
        if (!fs.existsSync(scriptPath)) continue; // fail open per missing step
        const stdout = runScript(scriptPath, input);
        if (step.relayOutput && stdout) writeOut(stdout);
      } catch {
        continue; // one failed behavior must not suppress the next one
      }
    }
    return 0;
  } catch {
    return 0;
  }
}
