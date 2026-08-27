// The three places a partial Codex install has to be visible, and the one place it
// must never be repaired.
//
// `05cbc5fd2` made `mla doctor` fail a partial install. That closed the inspection
// hole and left the ownership question open: an operator only sees it if they run
// doctor, and nobody runs doctor. The tempting fix is to reconcile `hooks.json` from
// whatever MLA path happens to run first. That is refused here, on purpose:
//
//   * startup would mutate a config file another tool owns;
//   * a user could not tell installation from ordinary execution;
//   * the next Codex schema change would turn a runtime path into a migration engine;
//   * starting MLA would change the evidence you are debugging with.
//
// So: `mla codex install` reconciles, everything else only LOOKS. These tests pin
// that split, and pin that all three readers render the SAME sentence from one
// function, because three hand-written copies of "run mla codex install" drift.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CODEX_MANAGED_HOOKS } from "../../src/connectors/codex/hook-contract";
import {
  codexIntegrationDiagnostic,
  ensureCodexHooks,
} from "../../src/connectors/codex/wire";

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

describe("codexIntegrationDiagnostic", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-diag-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("says ABSENT when no Codex integration is configured", () => {
    const d = codexIntegrationDiagnostic({ hooksPathOverride: path.join(dir, "nope.json") });
    expect(d.state).toBe("absent");
    expect(d.missing).toEqual([]);
    expect(d.message).toBeNull();
  });

  it("says COMPLETE when every managed hook is registered", () => {
    const file = writeHooks(dir, CODEX_MANAGED_HOOKS.map((h) => h.event));
    const d = codexIntegrationDiagnostic({ hooksPathOverride: file });
    expect(d.state).toBe("complete");
    expect(d.missing).toEqual([]);
    expect(d.message).toBeNull();
  });

  it("says PARTIAL, names the missing hook, and names the consequence and the repair", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    const d = codexIntegrationDiagnostic({ hooksPathOverride: file });

    expect(d.state).toBe("partial");
    expect(d.missing).toEqual(["Stop"]);
    // The three things an operator needs and could not get from "hooks not installed":
    expect(d.message).toContain("Stop");
    expect(d.message).toMatch(/captured/i);
    expect(d.message).toMatch(/not be finalized|no turn|knowledge/i);
    expect(d.message).toContain("mla codex install");
  });

  it("NEVER writes to hooks.json, whatever it finds", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    const before = fs.readFileSync(file, "utf8");
    const beforeMtime = fs.statSync(file).mtimeMs;

    codexIntegrationDiagnostic({ hooksPathOverride: file });
    codexIntegrationDiagnostic({ hooksPathOverride: file });

    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(beforeMtime);
  });

  it("is silent and cheap when the file is malformed, because inspection must never throw", () => {
    const file = path.join(dir, "hooks.json");
    fs.writeFileSync(file, "{ this is not json");
    const d = codexIntegrationDiagnostic({ hooksPathOverride: file });
    expect(d.state).toBe("absent");
    expect(d.message).toBeNull();
  });
});

describe("mla codex install is the ONLY reconciler, and it is idempotent", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-recon-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("repairs a partial install and reports the repair", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    expect(codexIntegrationDiagnostic({ hooksPathOverride: file }).state).toBe("partial");

    const result = ensureCodexHooks({ hooksPathOverride: file, mlaPath: MLA });

    expect(result.added).toContain("Stop");
    expect(codexIntegrationDiagnostic({ hooksPathOverride: file }).state).toBe("complete");
  });

  it("a second run writes nothing, so an upgrade path can call it unconditionally", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    ensureCodexHooks({ hooksPathOverride: file, mlaPath: MLA });
    const afterFirst = fs.readFileSync(file, "utf8");

    const second = ensureCodexHooks({ hooksPathOverride: file, mlaPath: MLA });

    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(afterFirst);
  });

  it("leaves a third-party hook alone while repairing ours", () => {
    const file = writeHooks(dir, PRE_STOP_ERA);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.hooks.Stop = [{ hooks: [{ type: "command", command: "/usr/local/bin/someone-elses-tool" }] }];
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    ensureCodexHooks({ hooksPathOverride: file, mlaPath: MLA });

    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    const commands = after.hooks.Stop.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(commands).toContain("/usr/local/bin/someone-elses-tool");
    expect(commands.some((c: string) => c.includes("codex-hook stop"))).toBe(true);
  });
});
