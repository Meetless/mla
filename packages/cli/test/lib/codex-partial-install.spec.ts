// A PARTIAL Codex install is the state that destroys knowledge capture silently,
// and it is the one state the connector could not name.
//
// ## The production shape this reproduces
//
// prod_control, 2026-08-10..08-16: 89 Codex runs, 0 finalized, 0 `agent_turns`, 0
// claims. Claude Code over the same window: 319 runs, 57 finalized, 144 turns. 82 of
// the 84 distinct Codex sessions emitted NO `session_stopped` at all while emitting
// 318 `tool_used_bash` and 16 `prompt_submitted`, and 0 of 55 sessions that called
// `POST /internal/v1/agent-runs/by-session/:sid/finalize` in seven days were Codex.
//
// The pipeline itself is fine: replaying the whole lifecycle through
// `mla _internal codex-hook {session-start,user-prompt-submit,post-tool-use,stop}`
// against local control on 2026-08-16 produced `adapter=codex status=completed
// endedAt set turns=1`. What those production installs are missing is the Stop
// REGISTRATION -- they predate `b2486c443` (2026-07-21), which is the commit that
// added Stop to `CODEX_MANAGED_HOOKS`.
//
// ## Why it stayed invisible
//
// `codexHooksInstalled` is `CODEX_MANAGED_HOOKS.every(...)`, so it answers false for
// "none installed" and false for "installed but missing Stop" alike. Doctor then
// renders that false as `ok: true, level: info, "Codex Meetless hooks not
// installed"` -- a green line telling an operator whose Codex hooks are demonstrably
// firing every day that they have none. The one condition where capture runs and
// knowledge creation does not was reported as the condition where nothing runs.
//
// Missing Stop is NOT interchangeable with missing PostToolUse, and these tests say
// so: turn assembly runs only inside the AGENT_RUN_FINALIZED handler
// (`agent-run.service.ts`: "turn assembly only runs inside the AGENT_RUN_FINALIZED
// handler"), which only fires on finalize, which only the Stop hook requests. No
// Stop means no turn, which means no claim, forever, with every other hook working.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  codexHookDoctorCheck,
  codexLifecycleCoverageCheck,
  doctorJson,
} from "../../src/commands/doctor";
import {
  CODEX_MANAGED_HOOKS,
} from "../../src/connectors/codex/hook-contract";
import {
  codexHooksInstalled,
  codexInstalledEvents,
} from "../../src/connectors/codex/wire";

const MLA = "/opt/homebrew/bin/mla";

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

describe("a Codex install missing only Stop", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-partial-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  const PRE_STOP_ERA = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];

  it("captures events and still creates no durable knowledge, which is why it must be named", () => {
    // The premise, stated so the severity ordering cannot be argued away later:
    // Stop is the only hook that requests finalize, and finalize is the only thing
    // that assembles a turn.
    expect(CODEX_MANAGED_HOOKS.map((h) => h.event)).toContain("Stop");
    expect(PRE_STOP_ERA).not.toContain("Stop");
  });

  it("reports which managed events are actually registered, not merely whether all are", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    expect(codexInstalledEvents({ hooksPathOverride: file })).toEqual(
      expect.arrayContaining(PRE_STOP_ERA),
    );
    expect(codexInstalledEvents({ hooksPathOverride: file })).not.toContain("Stop");
  });

  it("still answers false to the all-or-nothing question, and that is the trap", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    expect(codexHooksInstalled({ hooksPathOverride: file })).toBe(false);
    expect(codexHooksInstalled({ hooksPathOverride: writeHooks(dir, CODEX_MANAGED_HOOKS.map((h) => h.event)) })).toBe(true);
  });

  it("doctor FAILS a partial install instead of calling it uninstalled", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    const check = codexHookDoctorCheck(codexInstalledEvents({ hooksPathOverride: file }), file);
    const out = doctorJson([check]);

    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.hooks.registered", status: "fail" }),
    );
    // It has to name the missing event: "some hooks are missing" sends an operator
    // to reinstall without telling them what broke or what it cost.
    expect(out.checks[0]?.message).toContain("Stop");
    expect(out.checks[0]?.message).toMatch(/mla codex install/);
  });

  it("keeps a genuinely absent connector informational, because optional means optional", () => {
    const file = path.join(dir, "hooks.json");
    fs.writeFileSync(file, JSON.stringify({ hooks: {} }));
    const out = doctorJson([codexHookDoctorCheck(codexInstalledEvents({ hooksPathOverride: file }), file)]);
    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.hooks.registered", status: "info" }),
    );
    expect(out.status).toBe("green");
  });

  it("passes a complete install", () => {
    const file = writeHooks(dir, CODEX_MANAGED_HOOKS.map((h) => h.event));
    const out = doctorJson([codexHookDoctorCheck(codexInstalledEvents({ hooksPathOverride: file }), file)]);
    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.hooks.registered", status: "pass" }),
    );
  });

  it("the coverage line does not claim a full lifecycle it does not have", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    const out = doctorJson([codexLifecycleCoverageCheck(codexInstalledEvents({ hooksPathOverride: file }))]);
    expect(out.checks[0]?.message).not.toContain("full session capture lifecycle");
    expect(out.checks[0]?.message).toContain("Stop");
  });
});
