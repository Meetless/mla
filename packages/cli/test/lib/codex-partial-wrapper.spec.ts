// The Codex hook wrapper is the ONE execution path that exists only for Codex, so it
// is where "refuse to run knowingly-discarded work" has to land.
//
// It is also the path Codex invokes on every lifecycle event, with a documented
// fail-OPEN contract ("any failure emits nothing and exits 0 so the Codex lifecycle
// proceeds"). Two consequences, both pinned below:
//
//   1. The warning fires on SESSION-START ONLY. Once per session, at the moment the
//      session that will produce nothing begins. On post-tool-use it would repeat on
//      every tool call, in the operator's editor.
//   2. The exit code stays 0 and capture still runs. Refusing the bootstrap outright
//      would delete the events too, which buys nothing (they are cheap, and they are
//      the evidence that the integration is half-installed) and risks the user's
//      Codex lifecycle. The review's boundary was "fail the Codex operation, don't
//      kill unrelated functionality"; the operation that is failed here is the silent
//      pretence that the session is being captured into knowledge.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CODEX_MANAGED_HOOKS } from "../../src/connectors/codex/hook-contract";
import { runInternalCodexHook } from "../../src/commands/internal-codex-hook";

const MLA = "/opt/homebrew/bin/mla";
const PRE_STOP_ERA = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];

function writeHooks(dir: string, events: string[]): string {
  const doc: any = { hooks: {} };
  for (const event of events) {
    const hook = CODEX_MANAGED_HOOKS.find((h) => h.event === event)!;
    doc.hooks[event] = [
      {
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        hooks: [{ type: "command", command: `"${MLA}" ${hook.subcommand.join(" ")}` }],
      },
    ];
  }
  const file = path.join(dir, "hooks.json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

describe("the Codex wrapper on a partial install", () => {
  let dir: string;
  let warnings: string[];
  let ran: string[];

  const deps = (hooksPath: string) => ({
    readStdin: async () => "{}",
    writeOut: () => {},
    hooksDir: dir,
    runScript: (scriptPath: string) => {
      ran.push(path.basename(scriptPath));
      return "";
    },
    codexHooksPath: hooksPath,
    warn: (line: string) => warnings.push(line),
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrap-"));
    // The wrapper only runs steps whose script exists on disk.
    for (const f of ["session-start.sh", "user-prompt-submit.sh", "post-tool-use.sh", "stop.sh"]) {
      fs.writeFileSync(path.join(dir, f), "#!/usr/bin/env bash\n");
    }
    warnings = [];
    ran = [];
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("warns on session-start, naming the missing hook and the repair", async () => {
    const hooks = writeHooks(dir, PRE_STOP_ERA);
    const rc = await runInternalCodexHook(["session-start"], deps(hooks));

    expect(rc).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Stop");
    expect(warnings[0]).toContain("mla codex install");
  });

  it("still captures, because deleting the events buys nothing and hides the evidence", async () => {
    const hooks = writeHooks(dir, PRE_STOP_ERA);
    await runInternalCodexHook(["session-start"], deps(hooks));

    expect(ran).toContain("session-start.sh");
  });

  it("does NOT repeat on every tool call", async () => {
    const hooks = writeHooks(dir, PRE_STOP_ERA);
    await runInternalCodexHook(["post-tool-use"], deps(hooks));
    await runInternalCodexHook(["user-prompt-submit"], deps(hooks));

    expect(warnings).toEqual([]);
  });

  it("says nothing when the install is complete", async () => {
    const hooks = writeHooks(dir, CODEX_MANAGED_HOOKS.map((h) => h.event));
    await runInternalCodexHook(["session-start"], deps(hooks));

    expect(warnings).toEqual([]);
    expect(ran).toContain("session-start.sh");
  });

  it("never writes to hooks.json", async () => {
    const hooks = writeHooks(dir, PRE_STOP_ERA);
    const before = fs.readFileSync(hooks, "utf8");

    await runInternalCodexHook(["session-start"], deps(hooks));

    expect(fs.readFileSync(hooks, "utf8")).toBe(before);
  });

  it("stays fail-open when the inspection itself throws", async () => {
    const rc = await runInternalCodexHook(["session-start"], {
      ...deps(path.join(dir, "hooks.json")),
      codexHooksPath: "\0not-a-path",
    });
    expect(rc).toBe(0);
    expect(ran).toContain("session-start.sh");
  });
});
