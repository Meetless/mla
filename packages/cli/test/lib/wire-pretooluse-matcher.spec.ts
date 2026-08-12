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
    // WIDENED AGAIN 2026-08-08, for a different reason, and the reason matters because
    // the two widenings are not the same kind of change.
    //
    // 07-11 widened what could be BLOCKED, to close a bypass. 08-08 adds Grep and Glob
    // to widen what can be ADVISED, so F1's moment-of-need pointer can fire where the
    // agent actually reaches for a fact: the measured `Grep` for current_revision_id
    // never reached this hook at all.
    //
    // Read is deliberately excluded on a MEASUREMENT, not a preference. Every hooked call
    // spawns node (~200ms on this machine, benchmarked 2026-08-08 at 233ms for an empty
    // payload, so the toll is process startup and not our logic). Read is the most
    // frequent tool in a session and it is F1's weakest arm -- an agent reading the exact
    // note mla delivered is already using the evidence. Grep and Glob are searches, which
    // is the case F1 exists for, and they are rare by comparison.
    //
    // The enforcement surface did NOT move with it. `ENFORCEABLE_TOOLS` in
    // internal-pretool-observe.ts fences the ladder to the five write-capable tools, and
    // the case below proves an inspection call can only ever produce an advisory. That
    // separation is the invariant worth defending now; the literal is just its shadow.
    expect(PRE_TOOL_USE_MATCHER).toBe("^(Write|Edit|MultiEdit|NotebookEdit|Bash|Grep|Glob)$");
    expect(PRE_TOOL_USE_MATCHER).not.toBe(""); // never the catch-all
  });

  it("a tool reachable ONLY because of the F1 widening can never be denied or asked", async () => {
    // The load-bearing half of the widening. If a future rule change let the bundle
    // ladder decide about a Read, MLA would start blocking reads nobody asked it to
    // block, and it would have arrived through a matcher edit rather than a policy one.
    //
    // Driven through the real decision function with a bundle that DENIES everything, so
    // this fails if the fence is removed rather than if some unrelated rule is absent.
    const { runInternalPretoolObserve } = await import("../../src/commands/internal-pretool-observe");
    for (const tool of ["Grep", "Glob"]) {
      let stdout = "";
      await runInternalPretoolObserve([], {
        readStdin: async () =>
          JSON.stringify({
            session_id: "s1",
            tool_name: tool,
            tool_input: { file_path: "/repo/notes/x.md", pattern: "anything" },
            cwd: "/repo",
          }),
        writeOut: (s: string) => {
          stdout = s;
        },
        // Would deny every write-capable call; must be unreachable from here.
        resolveMaxEnforcement: () => "deny" as never,
        evidencePointer: null,
      });
      const body = JSON.parse(stdout);
      expect(body?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    }
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("drift guard: hook-contract.ts pins the write-capable PreToolUse matcher and registers the observe script", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/connectors/claude-code/hook-contract.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /PRE_TOOL_USE_MATCHER\s*=\s*"\^\(Write\|Edit\|MultiEdit\|NotebookEdit\|Bash\|Grep\|Glob\)\$"/,
    );
    expect(src).toMatch(/pre-tool-use\.sh/);
  });
});
