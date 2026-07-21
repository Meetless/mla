import { runUninstall, UninstallDeps } from "../../src/commands/uninstall";

function baseDeps(over: Partial<UninstallDeps> = {}): { deps: UninstallDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: UninstallDeps = {
    home: "/fake/.meetless",
    settingsPath: "/fake/.claude/settings.json",
    claudeJsonPath: "/fake/.claude.json",
    // Both Codex deps must be injected together. Leaving EITHER one unset drops runUninstall back
    // onto the real removeCodexHooks() and the real ~/.codex/hooks.json, so a green non-dry-run
    // case silently strips the developer's own Codex governance hooks. jest.setup-home.js now also
    // sandboxes $CODEX_HOME as a backstop; this keeps the spec honest about what it exercises.
    codexHooksPath: "/fake/.codex/hooks.json",
    removeCodexHooks: () => ({ changed: true, filePath: "/fake/.codex/hooks.json" }),
    skillDir: "/fake/.claude/skills/mla",
    queueDir: "/fake/.meetless/queue",
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
    isTTY: true,
    env: {} as NodeJS.ProcessEnv,
    countQueued: () => 0,
    countEvents: () => 0,
    homeExists: () => true,
    skillExists: () => true,
    resolveBinary: () => ({ binPath: "/opt/homebrew/bin/mla", realPath: "/repo/packages/cli/dist/cli.js" }),
    removeHooks: () => ({ removed: ["SessionStart"], changed: true, backupPath: "/b", settingsPath: "/fake/.claude/settings.json" }),
    removeMcp: () => ({ removedFrom: ["(top level)"], changed: true, backupPath: "/b2", claudeJsonPath: "/fake/.claude.json" }),
    removeDir: () => ({ removed: true }),
    confirm: async () => true,
    choose: async () => "delete",
    flush: async () => 0,
    ...over,
  };
  return { deps, out, err };
}

describe("mla uninstall", () => {
  it("--dry-run prints the plan and mutates nothing", async () => {
    const removeHooks = jest.fn();
    const removeDir = jest.fn(() => ({ removed: true }));
    const { deps, out } = baseDeps({ removeHooks: removeHooks as any, removeDir: removeDir as any });
    const code = await runUninstall(["--dry-run"], deps);
    expect(code).toBe(0);
    expect(removeHooks).not.toHaveBeenCalled();
    expect(removeDir).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("/fake/.meetless");
    expect(text).toContain("/fake/.claude.json");
    expect(text.toLowerCase()).toContain("dry run");
  });

  it("--dry-run discloses the un-flushed event count so the preview hides no risk", async () => {
    // A skeptic runs --dry-run first to learn what they would lose. The preview
    // must name the un-flushed captured events the real run would put at risk,
    // by their honest magnitude (event count), not just the file count.
    const { deps, out } = baseDeps({ countQueued: () => 4, countEvents: () => 42 });
    const code = await runUninstall(["--dry-run"], deps);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("42");
    expect(text.toLowerCase()).toContain("captured event");
    expect(text.toLowerCase()).toContain("flush");
  });

  it("--dry-run stays silent about loss when the queue holds no un-flushed events", async () => {
    // Session files can linger fully drained (0 un-flushed events). The preview
    // must not warn about data loss when there is no un-flushed data to lose.
    const { deps, out } = baseDeps({ countQueued: () => 5, countEvents: () => 0 });
    const code = await runUninstall(["--dry-run"], deps);
    expect(code).toBe(0);
    expect(out.join("\n").toLowerCase()).not.toContain("not yet flushed");
  });

  it("--dry-run previews how to remove the binary so the footprint is complete", async () => {
    // The binary is never auto-removed, so a dry-run that omits it would hide
    // part of the real footprint. A skeptic running --dry-run first must see the
    // whole picture, including the one manual step left behind.
    const { deps, out } = baseDeps();
    const code = await runUninstall(["--dry-run"], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("rm /opt/homebrew/bin/mla");
  });

  it("interactive confirm=yes runs every step in order and prints the binary hint", async () => {
    const calls: string[] = [];
    const { deps, out } = baseDeps({
      removeHooks: (() => { calls.push("hooks"); return { removed: [], changed: true, backupPath: null, settingsPath: "" }; }) as any,
      removeMcp: (() => { calls.push("mcp"); return { removedFrom: [], changed: true, backupPath: null, claudeJsonPath: "" }; }) as any,
      removeDir: ((d: string) => { calls.push(`rmdir:${d}`); return { removed: true }; }) as any,
    });
    const code = await runUninstall([], deps);
    expect(code).toBe(0);
    // wiring stripped before HOME is deleted
    expect(calls.indexOf("hooks")).toBeLessThan(calls.indexOf("rmdir:/fake/.meetless"));
    expect(calls.indexOf("mcp")).toBeLessThan(calls.indexOf("rmdir:/fake/.meetless"));
    expect(out.join("\n")).toContain("rm /opt/homebrew/bin/mla");
  });

  it("aborts cleanly when the operator declines the final confirm", async () => {
    const removeDir = jest.fn(() => ({ removed: true }));
    const { deps, out } = baseDeps({ confirm: async () => false, removeDir: removeDir as any });
    const code = await runUninstall([], deps);
    expect(code).toBe(0);
    expect(removeDir).not.toHaveBeenCalled();
    expect(out.join("\n").toLowerCase()).toContain("cancel");
  });

  it("refuses non-interactively without --yes", async () => {
    const removeDir = jest.fn(() => ({ removed: true }));
    const { deps, err } = baseDeps({ isTTY: false, removeDir: removeDir as any });
    const code = await runUninstall([], deps);
    expect(code).toBe(2);
    expect(removeDir).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("--yes");
  });

  it("--yes proceeds non-interactively and never prompts", async () => {
    const confirm = jest.fn(async () => true);
    const { deps } = baseDeps({ isTTY: false, confirm: confirm as any });
    const code = await runUninstall(["--yes"], deps);
    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("warns on un-flushed events and the flush choice invokes deps.flush", async () => {
    const flush = jest.fn(async () => 0);
    const choose = jest.fn(async () => "flush" as const);
    const { deps, out } = baseDeps({ countQueued: () => 7, countEvents: () => 99, flush: flush as any, choose: choose as any });
    const code = await runUninstall([], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("99");
    expect(flush).toHaveBeenCalled();
  });

  it("the unflushed cancel choice aborts without deleting", async () => {
    const removeDir = jest.fn(() => ({ removed: true }));
    const { deps } = baseDeps({ countQueued: () => 3, countEvents: () => 12, choose: async () => "cancel", removeDir: removeDir as any });
    const code = await runUninstall([], deps);
    expect(code).toBe(0);
    expect(removeDir).not.toHaveBeenCalled();
  });

  it("does not warn or prompt when the queue holds files but no un-flushed events", async () => {
    // queued files with zero un-flushed events means nothing is at risk; the
    // run must skip the flush/delete/cancel prompt entirely.
    const choose = jest.fn(async () => "cancel" as const);
    const { deps } = baseDeps({ countQueued: () => 5, countEvents: () => 0, choose: choose as any });
    const code = await runUninstall([], deps);
    expect(code).toBe(0);
    expect(choose).not.toHaveBeenCalled();
  });

  it("rejects an unknown flag", async () => {
    const { deps, err } = baseDeps();
    const code = await runUninstall(["--wat"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--wat");
  });
});
