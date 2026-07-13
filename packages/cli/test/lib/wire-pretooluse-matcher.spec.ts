import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureClaudeSettings, PRE_TOOL_USE_MATCHER } from "../../src/lib/wire";
import { removeMeetlessHooks } from "../../src/lib/unwire";

// Slice 2: the observe-only PreToolUse hook is registered through the SAME
// canonical managed-hook seam as every other Meetless hook (MANAGED_HOOK_SCRIPTS
// -> ensureClaudeSettings install, removeMeetlessHooks uninstall, checkHookDrift
// doctor). There is deliberately no second installation path.
//
// Two invariants this spec locks:
//   1. The hook is scoped to file-writing tools only (Write, Edit) via a narrow
//      exact-match matcher, NOT the catch-all the PostToolUse heartbeat uses.
//   2. Wiring this hook can never turn into a permission decision: the settings
//      entry is a plain `type: "command"` hook (no static allow/deny/ask baked
//      into settings), and the command is our observe script. The decision-free
//      guarantee of the script body itself is proven in
//      internal-pretool-observe.spec.ts.

function mkSettingsPath(): { dir: string; p: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-pretool-"));
  return { dir, p: path.join(dir, "settings.json") };
}

function readSettings(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function preToolUse(p: string): any[] {
  const s = readSettings(p);
  return Array.isArray(s.hooks?.PreToolUse) ? s.hooks.PreToolUse : [];
}

describe("ensureClaudeSettings: observe-only PreToolUse registration", () => {
  it("scopes the PreToolUse matcher to every WRITE-CAPABLE tool (exact match, not catch-all)", () => {
    // WIDENED 2026-07-11. This test used to pin "^(Write|Edit)$", and it was RIGHT to go
    // red when that changed — but the narrow contract it defended was the bug. A
    // forbidden-root rule says "never create or edit any file under <root>/": a claim
    // about a PATH. Gating it on two tool names quietly turned it into "...using Write or
    // Edit", and our own enforcement benchmark watched an agent step around it in one
    // move: Write -> DENIED, then `Bash: cat > notes/design.md` -> succeeded, because the
    // hook never fired.
    //
    // Still an EXACT alternation, NOT the catch-all: Read/Grep/Glob must never spawn the
    // subcommand. What a Bash call actually writes is decided by deriveWriteTargets, so a
    // read-only command (`ls`, `grep`) derives no targets and passes straight through.
    expect(PRE_TOOL_USE_MATCHER).toBe("^(Write|Edit|MultiEdit|NotebookEdit|Bash)$");
    expect(PRE_TOOL_USE_MATCHER).not.toBe(""); // never the catch-all
  });

  it("registers PreToolUse with the narrow matcher and observe script on a fresh file", () => {
    const { dir, p } = mkSettingsPath();
    try {
      const res = ensureClaudeSettings(false, p);
      expect(res.added).toContain("PreToolUse");
      const entries = preToolUse(p);
      expect(entries.length).toBe(1);
      expect(entries[0].matcher).toBe(PRE_TOOL_USE_MATCHER);
      expect(entries[0].hooks[0].command).toMatch(/pre-tool-use\.sh"$/);
      // No static decision is baked into settings: it is a plain command hook.
      expect(entries[0].hooks[0].type).toBe("command");
      expect(JSON.stringify(entries[0])).not.toMatch(/permissionDecision|"decision"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still registers PreToolUse when noPostToolUse is set (the opt-out only drops PostToolUse)", () => {
    const { dir, p } = mkSettingsPath();
    try {
      const res = ensureClaudeSettings(true, p);
      expect(res.added).not.toContain("PostToolUse");
      expect(res.added).toContain("PreToolUse");
      expect(preToolUse(p).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the operator's own unrelated PreToolUse hook untouched", () => {
    const { dir, p } = mkSettingsPath();
    try {
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/operator-own.sh" }] },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = preToolUse(p);
      const own = entries.find((e) => e.hooks?.[0]?.command === "/usr/local/bin/operator-own.sh");
      expect(own).toBeDefined();
      expect(own.matcher).toBe("Bash");
      const ours = entries.find((e) => /pre-tool-use\.sh"$/.test(e.hooks?.[0]?.command ?? ""));
      expect(ours).toBeDefined();
      expect(ours.matcher).toBe(PRE_TOOL_USE_MATCHER);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles in place on rewire (no duplicate PreToolUse entry)", () => {
    const { dir, p } = mkSettingsPath();
    try {
      ensureClaudeSettings(false, p);
      ensureClaudeSettings(false, p);
      const entries = preToolUse(p);
      expect(entries.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uninstall removes the PreToolUse entry via the same managed-hook list", () => {
    const { dir, p } = mkSettingsPath();
    try {
      ensureClaudeSettings(false, p);
      expect(preToolUse(p).length).toBe(1);

      const res = removeMeetlessHooks(p);
      expect(res.removed).toContain("PreToolUse");
      expect(preToolUse(p).length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drift guard: hook-contract.ts pins the write-capable PreToolUse matcher and registers the observe script", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/connectors/claude-code/hook-contract.ts"),
      "utf8",
    );
    expect(src).toMatch(/PRE_TOOL_USE_MATCHER\s*=\s*"\^\(Write\|Edit\|MultiEdit\|NotebookEdit\|Bash\)\$"/);
    expect(src).toMatch(/pre-tool-use\.sh/);
  });
});
