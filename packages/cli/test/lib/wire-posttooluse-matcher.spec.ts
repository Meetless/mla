import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureClaudeSettings, POST_TOOL_USE_MATCHER } from "../../src/lib/wire";

// The PostToolUse hook does two jobs: (1) spool the captured tools
// (Bash/Write/Edit/AskUserQuestion/mcp__meetless__) and (2) fire a throttled
// liveness heartbeat at the TOP of EVERY invocation (F3-B). Claude Code only
// runs the hook when the tool name matches its registered matcher, so a
// named-list matcher STARVES the heartbeat during read/explore/subagent-heavy
// turns (Read, Grep, Glob, Task, WebFetch never match): lastSeenAt freezes and
// deriveLiveness ages an actively-working session into IDLE. The matcher is
// therefore the catch-all ("") so the hook fires on every tool; the hook script
// self-filters what to spool, so the v0 privacy boundary (a Read/Grep turn
// spools nothing) is unchanged. (An empty-string matcher is Claude Code's
// catch-all, equivalent to "*".)
//
// Because An's machine already has a "Bash"-only entry from a prior install,
// `mla rewire` MUST reconcile a stale narrow matcher in place (not duplicate the
// entry, not clobber the operator's own hooks).

function mkSettingsPath(): { dir: string; p: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-settings-"));
  return { dir, p: path.join(dir, "settings.json") };
}

function readSettings(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function postToolUse(p: string): any[] {
  const s = readSettings(p);
  return Array.isArray(s.hooks?.PostToolUse) ? s.hooks.PostToolUse : [];
}

// The managed command is written forward-slash + double-quoted
// ("…/hooks/post-tool-use.sh") so it survives the shell on Windows (Git Bash
// eats an unquoted backslash path). Strip the surrounding quotes before taking
// the basename (notes/20260710-windows-hook-wiring-and-portable-lock-fix.md).
function cmdBasename(command: string | undefined): string {
  return path.basename((command ?? "").replace(/^"|"$/g, ""));
}

// PostToolUse now holds TWO managed entries: the load-bearing post-tool-use.sh and
// the CE0 ce0-post-tool-use.sh. These tests pin the load-bearing entry, so scope by
// the exact command basename (basename equality keeps the two scripts disjoint).
function postToolUseForBasename(p: string, basename: string): any[] {
  return postToolUse(p).filter((e) => cmdBasename(e.hooks?.[0]?.command) === basename);
}

describe("ensureClaudeSettings: PostToolUse matcher is the catch-all so the heartbeat fires on every tool", () => {
  it("is the empty-string catch-all matcher (fires the F3-B heartbeat on Read/Grep/Task too, not just the spooled tools)", () => {
    // A named-list matcher gates the hook on the SPOOL set, which starves the
    // mid-turn liveness heartbeat during read/explore/subagent-heavy turns and
    // ages an actively-working session into IDLE. The matcher must be the
    // catch-all so the hook fires on EVERY tool; post-tool-use.sh still spools
    // only the captured tools (Bash/Write/Edit/AskUserQuestion/mcp__meetless__),
    // so the privacy boundary is unchanged.
    expect(POST_TOOL_USE_MATCHER).toBe("");
  });

  it("registers PostToolUse with the broad matcher on a fresh settings file", () => {
    const { dir, p } = mkSettingsPath();
    try {
      const res = ensureClaudeSettings(false, p);
      expect(res.added).toContain("PostToolUse");
      const entries = postToolUseForBasename(p, "post-tool-use.sh");
      expect(entries.length).toBe(1);
      expect(entries[0].matcher).toBe(POST_TOOL_USE_MATCHER);
      expect(entries[0].hooks[0].command).toMatch(/post-tool-use\.sh"$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles a stale narrow 'Bash' matcher in place on rewire (no duplicate entry)", () => {
    const { dir, p } = mkSettingsPath();
    try {
      // First, a fresh install to learn the exact managed command path.
      ensureClaudeSettings(false, p);
      const cmd = postToolUse(p)[0].hooks[0].command;

      // Simulate a pre-P1 install: our command registered under the OLD "Bash"
      // matcher only.
      fs.writeFileSync(
        p,
        JSON.stringify(
          { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }] } },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = postToolUseForBasename(p, "post-tool-use.sh");
      expect(entries.length).toBe(1); // reconciled in place, not duplicated
      expect(entries[0].matcher).toBe(POST_TOOL_USE_MATCHER);
      expect(entries[0].hooks[0].command).toBe(cmd);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the operator's own unrelated PostToolUse hook untouched", () => {
    const { dir, p } = mkSettingsPath();
    try {
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                { matcher: "Write", hooks: [{ type: "command", command: "/usr/local/bin/operator-own.sh" }] },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = postToolUse(p);
      // operator entry survives byte-for-byte; ours is appended.
      const own = entries.find((e) => e.hooks?.[0]?.command === "/usr/local/bin/operator-own.sh");
      expect(own).toBeDefined();
      expect(own.matcher).toBe("Write");
      const ours = entries.find((e) => cmdBasename(e.hooks?.[0]?.command) === "post-tool-use.sh");
      expect(ours).toBeDefined();
      expect(ours.matcher).toBe(POST_TOOL_USE_MATCHER);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT rewrite the matcher of an operator-merged multi-hook entry", () => {
    const { dir, p } = mkSettingsPath();
    try {
      ensureClaudeSettings(false, p);
      const cmd = postToolUseForBasename(p, "post-tool-use.sh")[0].hooks[0].command;

      // Operator merged our command into a multi-hook entry under "Bash".
      // Reconciliation must be conservative: only touch an entry that is
      // EXCLUSIVELY our single managed command. Here it must be left alone and
      // not duplicated.
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                {
                  matcher: "Bash",
                  hooks: [
                    { type: "command", command: cmd },
                    { type: "command", command: "/usr/local/bin/operator-extra.sh" },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = postToolUse(p);
      // The operator's multi-hook entry is left untouched: still matcher "Bash",
      // still two hooks, and post-tool-use.sh is NOT duplicated into its own entry.
      const merged = entries.filter((e) =>
        (e.hooks ?? []).some((h: any) => h?.command === cmd),
      );
      expect(merged.length).toBe(1); // our command present in exactly one entry (no duplicate)
      expect(merged[0].matcher).toBe("Bash"); // multi-hook entry untouched
      expect(merged[0].hooks.length).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not register PostToolUse when noPostToolUse is set", () => {
    const { dir, p } = mkSettingsPath();
    try {
      const res = ensureClaudeSettings(true, p);
      expect(res.added).not.toContain("PostToolUse");
      expect(postToolUse(p).length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drift guard: hook-contract.ts pins the catch-all PostToolUse matcher constant", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/connectors/claude-code/hook-contract.ts"),
      "utf8",
    );
    expect(src).toMatch(/POST_TOOL_USE_MATCHER\s*=\s*""/);
  });
});
