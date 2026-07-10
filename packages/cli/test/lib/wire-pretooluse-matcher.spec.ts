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
  it("scopes the PreToolUse matcher to Write|Edit only (exact match, not catch-all)", () => {
    // "^(Write|Edit)$" matches ONLY the two pilot tools. An unanchored "Write|Edit"
    // would also match MultiEdit/NotebookEdit (substring); the empty catch-all
    // would fire on Bash/Read. The pilot is intentionally narrow.
    expect(PRE_TOOL_USE_MATCHER).toBe("^(Write|Edit)$");
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

  it("drift guard: hook-contract.ts pins the narrow PreToolUse matcher constant and registers the observe script", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/connectors/claude-code/hook-contract.ts"),
      "utf8",
    );
    expect(src).toMatch(/PRE_TOOL_USE_MATCHER\s*=\s*"\^\(Write\|Edit\)\$"/);
    expect(src).toMatch(/pre-tool-use\.sh/);
  });
});
