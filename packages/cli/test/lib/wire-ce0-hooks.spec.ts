import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureClaudeSettings,
  MANAGED_HOOK_SCRIPTS,
  CE0_POST_TOOL_USE_MATCHER,
  PRE_TOOL_USE_MATCHER,
} from "../../src/lib/wire";

// CE0 evidence-consultation measurement harness (proposal §4.1, the one remaining
// durable-layer piece: hook wiring). Three managed ce0-*.sh scripts ride the
// EXISTING UserPromptSubmit, PostToolUse and Stop events as SECOND managed entries
// alongside the load-bearing capture hooks. The wire engine keys managed entries by
// script basename, so the two-per-event registration composes cleanly with no engine
// change beyond the new MANAGED_HOOK_SCRIPTS rows.
//
// The scripts are RECORD_ONLY: each pipes raw hook stdin into an `mla _internal
// evidence-*` subcommand and ALWAYS emits the empty `{}` pass-through and exits 0. A
// CE0 hook can never inject, deny, or block a turn; it only records what it observed.

const TEMPLATE_DIR = path.resolve(__dirname, "../../src/hooks-template");

function mkSettingsPath(): { dir: string; p: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-ce0-hooks-"));
  return { dir, p: path.join(dir, "settings.json") };
}

function readSettings(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function entriesFor(p: string, event: string): any[] {
  const s = readSettings(p);
  return Array.isArray(s.hooks?.[event]) ? s.hooks[event] : [];
}

// The managed entry whose single command's basename is EXACTLY `script`. Basename
// equality keeps "post-tool-use.sh" and "ce0-post-tool-use.sh" disjoint. The
// command is forward-slash + double-quoted for the Windows shell fix, so strip
// the surrounding quotes before taking the basename
// (notes/20260710-windows-hook-wiring-and-portable-lock-fix.md).
function entryForScript(p: string, event: string, script: string): any {
  return entriesFor(p, event).find(
    (e) => path.basename((e.hooks?.[0]?.command ?? "").replace(/^"|"$/g, "")) === script,
  );
}

describe("CE0 evidence hooks: registered as second managed entries on shared events", () => {
  it("MANAGED_HOOK_SCRIPTS carries the three ce0-*.sh entries on their shared events", () => {
    const pairs = MANAGED_HOOK_SCRIPTS.map((h) => `${h.event}:${h.script}`);
    expect(pairs).toContain("UserPromptSubmit:ce0-user-prompt-submit.sh");
    expect(pairs).toContain("PostToolUse:ce0-post-tool-use.sh");
    expect(pairs).toContain("Stop:ce0-stop.sh");
  });

  it("scopes the CE0 PostToolUse matcher to the meetless MCP tools (not the catch-all)", () => {
    // The capture adapter filters precisely to the three governed pulls
    // (retrieve_knowledge/kb_doc_detail/query), so a meetless-prefix matcher is
    // both safe and avoids spawning mla on every unrelated tool call.
    const ce0 = MANAGED_HOOK_SCRIPTS.find((h) => h.script === "ce0-post-tool-use.sh");
    expect(ce0?.event).toBe("PostToolUse");
    expect(ce0?.matcher).toBe(CE0_POST_TOOL_USE_MATCHER);
    // Deliberately NOT the catch-all, which would spawn mla on every tool call.
    expect(CE0_POST_TOOL_USE_MATCHER).not.toBe("");
  });

  // The tool names Claude Code actually sends for this MCP server. The server
  // namespaces its own tools as `meetless__*`, so the wire name carries the segment
  // twice: `mcp__` + server (`meetless`) + `__` + tool (`meetless__retrieve_knowledge`).
  const GOVERNED_PULL_TOOL_NAMES = [
    "mcp__meetless__meetless__retrieve_knowledge",
    "mcp__meetless__meetless__kb_doc_detail",
    "mcp__meetless__meetless__query",
  ];

  /** Claude Code decides whether a hook runs by FULL-matching the matcher regex
   * against the tool name, not by searching within it. Measured 2026-08-04 by
   * registering three probe hooks on one real MCP call:
   *
   *     matcher                 fired
   *     ""            (control)   yes
   *     mcp__meetless__           NO
   *     mcp__meetless__.*         yes
   *     ^mcp__meetless__.*$       yes
   *
   * `^(?:M)$` is the model that reproduces all four observations. */
  const fullMatches = (matcher: string, toolName: string) => new RegExp(`^(?:${matcher})$`).test(toolName);

  it("the CE0 matcher actually fires on every governed pull's REAL tool name", () => {
    // The regression this exists to prevent, and it was live for the whole life of
    // the CE0 harness: the matcher shipped as the bare prefix `mcp__meetless__`, whose
    // own comment claimed it was "an UNANCHORED substring regex" that "matches the full
    // tool name". Claude Code full-matches, so it matched NOTHING, the hook never ran,
    // and `evidence_consultation_completed` recorded zero events across 18 production
    // workspaces for the entire window. The capture adapter underneath was correct and
    // fully unit-tested the whole time; nothing tested that the hook was ever REACHED.
    //
    // Asserting the literal string (the previous test) can never catch this: a literal
    // pin agrees with whatever is written, including a value that matches nothing.
    for (const toolName of GOVERNED_PULL_TOOL_NAMES) {
      expect(fullMatches(CE0_POST_TOOL_USE_MATCHER, toolName)).toBe(true);
    }
  });

  it("the CE0 matcher still does NOT fire on unrelated tools", () => {
    // The other half: scoping is the reason this matcher is not the catch-all, so a
    // fix that just widens it to `.*` would trade one defect for another.
    for (const toolName of ["Read", "Edit", "Bash", "mcp__other__query", "mcp__othermeetless__x"]) {
      expect(fullMatches(CE0_POST_TOOL_USE_MATCHER, toolName)).toBe(false);
    }
  });

  it("the PreToolUse matcher full-matches its tools too (the form that always worked)", () => {
    // PRE_TOOL_USE_MATCHER is anchored `^(Write|Edit|...)$`, which is why that hook has
    // always fired while the CE0 one never did. Pinned here so the two cannot drift apart
    // again, and so the next person sees the working form beside the broken one.
    for (const toolName of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
      expect(fullMatches(PRE_TOOL_USE_MATCHER, toolName)).toBe(true);
    }
    expect(fullMatches(PRE_TOOL_USE_MATCHER, "Read")).toBe(false);
  });

  it("registers each CE0 hook as a SECOND managed entry beside its load-bearing sibling on a fresh file", () => {
    const { dir, p } = mkSettingsPath();
    try {
      ensureClaudeSettings(false, p);

      // Each shared event now holds BOTH the load-bearing capture hook and the CE0 hook.
      expect(entryForScript(p, "UserPromptSubmit", "user-prompt-submit.sh")).toBeDefined();
      expect(entryForScript(p, "UserPromptSubmit", "ce0-user-prompt-submit.sh")).toBeDefined();

      expect(entryForScript(p, "Stop", "stop.sh")).toBeDefined();
      expect(entryForScript(p, "Stop", "ce0-stop.sh")).toBeDefined();

      expect(entryForScript(p, "PostToolUse", "post-tool-use.sh")).toBeDefined();
      const ptuCe0 = entryForScript(p, "PostToolUse", "ce0-post-tool-use.sh");
      expect(ptuCe0).toBeDefined();
      expect(ptuCe0.matcher).toBe(CE0_POST_TOOL_USE_MATCHER);

      // SessionStart now holds BOTH the load-bearing session-start.sh and the CE0
      // telemetry-projection hook, registered by basename as a second managed entry.
      expect(entryForScript(p, "SessionStart", "session-start.sh")).toBeDefined();
      expect(entryForScript(p, "SessionStart", "ce0-session-start.sh")).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops BOTH PostToolUse scripts under noPostToolUse but keeps the CE0 UserPromptSubmit + Stop hooks", () => {
    const { dir, p } = mkSettingsPath();
    try {
      ensureClaudeSettings(true, p);
      // --no-post-tool-use is an EVENT opt-out: neither post-tool-use.sh nor
      // ce0-post-tool-use.sh is registered.
      expect(entriesFor(p, "PostToolUse")).toHaveLength(0);
      // The other two CE0 hooks are unaffected by the PostToolUse opt-out.
      expect(entryForScript(p, "UserPromptSubmit", "ce0-user-prompt-submit.sh")).toBeDefined();
      expect(entryForScript(p, "Stop", "ce0-stop.sh")).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ships the three CE0 scripts, each piping stdin to its subcommand and always passing through", () => {
    const expectations: Array<[string, string]> = [
      ["ce0-user-prompt-submit.sh", "evidence-turn-open"],
      ["ce0-post-tool-use.sh", "evidence-capture"],
      ["ce0-stop.sh", "evidence-stop"],
    ];
    for (const [script, sub] of expectations) {
      const body = fs.readFileSync(path.join(TEMPLATE_DIR, script), "utf8");
      expect(body).toContain(`_internal ${sub}`);
      // RECORD_ONLY pass-through discipline: emit the empty body, exit 0, never block.
      expect(body).toContain("printf '{}'");
      expect(body).toContain("exit 0");
      expect(body).not.toContain("exit 2");
    }
  });

  it("ships ce0-session-start.sh: runs the idempotent telemetry sweep, fail-soft, always passes through", () => {
    // GAP-1 fix: the offline §6.4 denominator events (memory_requirement_assessed,
    // evidence_obligation_finalized) only ever projected when a human ran the sweep by
    // hand. This SessionStart hook gives the sweep an automatic caller. Unlike the other
    // three CE0 hooks it invokes the operator `mla evidence ce0-emit-telemetry` sweep
    // (idempotent: a deterministic event_id + a local skip-set dedupe a repeated run),
    // swallows its JSON summary, and emits the empty `{}` SessionStart body so it can
    // never inject context, block, or change the session.
    const body = fs.readFileSync(path.join(TEMPLATE_DIR, "ce0-session-start.sh"), "utf8");
    expect(body).toContain("evidence ce0-emit-telemetry");
    // Fail-soft pass-through discipline, like the three turn hooks: emit the empty
    // SessionStart body, exit 0, never a blocking exit 2.
    expect(body).toContain("printf '{}'");
    expect(body).toContain("exit 0");
    expect(body).not.toContain("exit 2");
  });
});
