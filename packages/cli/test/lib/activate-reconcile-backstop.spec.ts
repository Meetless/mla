import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { reconcileWiringBackstop } from "../../src/commands/activate";
import type { LegacyWiringPaths, ReconcileIO } from "../../src/connectors/claude-code/plugin-migrate";

// Build a full LegacyWiringPaths in a throwaway temp dir. settings/claude hold the
// two JSON docs the planner reads; skills/agents are never touched by these cases
// (the executor is a spy) but must be real strings.
function tmpPaths(settings: unknown, claude: unknown): LegacyWiringPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bs-"));
  const settingsPath = path.join(dir, "settings.json");
  const claudeJsonPath = path.join(dir, ".claude.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  fs.writeFileSync(claudeJsonPath, JSON.stringify(claude));
  return {
    settingsPath,
    claudeJsonPath,
    skillsDir: path.join(dir, "skills"),
    agentsDir: path.join(dir, "agents"),
  };
}

// A spy ReconcileIO so no case ever runs the real runWire / removers against the
// operator's actual home dir. Matches the current ReconcileIO shape exactly:
// removeLegacy(): { changed } and restoreLegacy(): void.
function spyIO(): ReconcileIO & { removed: number; restored: number } {
  const io = {
    removed: 0,
    restored: 0,
    removeLegacy() {
      io.removed++;
      return { changed: true };
    },
    restoreLegacy() {
      io.restored++;
    },
  };
  return io;
}

// These cases pick (ownership, inspection) inputs whose plan is unambiguous WITHOUT
// hand-building a real managed-hooks settings block: the exhaustive planner grid is
// already covered in Task 7, so the backstop test only has to prove it (a) routes the
// plan through the INJECTED executor and (b) is fail-safe. The backstop runs in
// `mode: "activate"`, so `restore-legacy` is UNREACHABLE: the ONLY mutation it can plan
// is remove-legacy under `owned` (any legacy surface). `absent` (with or without a
// legacy remnant) is always noop here, which is the connector-neutral guarantee under
// test. An mcp-only or empty doc is enough to exercise both arms (globalMcpPresent reads
// a top-level mcpServers key; an empty doc yields an all-false inspection).
describe("reconcileWiringBackstop (activate is the backstop, design §6.7)", () => {
  it("is a no-op (executor untouched) when owned and no legacy remains", () => {
    const paths = tmpPaths({ hooks: {} }, {}); // all-false inspection -> anySurface=false
    const io = spyIO();
    const r = reconcileWiringBackstop({
      paths,
      reconcileIO: io,
      detect: () => ({ status: "owned", scope: "user", version: "unknown" }),
    });
    expect(r.action).toBe("noop");
    expect(r.changed).toBe(false);
    expect(r.failed).toBe(false);
    expect(io.removed + io.restored).toBe(0);
  });

  it("removes via the injected executor when owned and a legacy remnant is present", () => {
    // mcp-only doc -> globalMcpPresent=true, everything else false = a partial legacy
    // remnant. owned + anySurface plans remove-legacy, so the executor's removeLegacy
    // (all four surfaces) fires.
    const paths = tmpPaths({ hooks: {} }, { mcpServers: { meetless: { command: "x", args: ["mcp"] } } });
    const io = spyIO();
    const r = reconcileWiringBackstop({
      paths,
      reconcileIO: io,
      detect: () => ({ status: "owned", scope: "user", version: "unknown" }),
    });
    expect(r.action).toBe("remove-legacy");
    expect(r.changed).toBe(true);
    expect(io.removed).toBe(1);
    expect(io.restored).toBe(0);
  });

  it("NEVER installs Claude wiring on a fresh machine (connector-neutral activate)", () => {
    // Review minimum patch #1: no plugin, no legacy wiring. Under the OLD design activate
    // would silently restore legacy capture; that is now forbidden. `mla activate` binds
    // the repo and writes .meetless.json but installs NO Claude connector; the executor
    // is never touched. Capture begins only after the plugin install or `mla rewire`.
    const paths = tmpPaths({ hooks: {} }, {}); // absent + all-false surface
    const io = spyIO();
    const r = reconcileWiringBackstop({
      paths,
      reconcileIO: io,
      detect: () => ({ status: "absent" }),
    });
    expect(r.action).toBe("noop");
    expect(r.changed).toBe(false);
    expect(r.failed).toBe(false);
    expect(io.restored).toBe(0);
    expect(io.removed).toBe(0);
  });

  it("does NOT restore even a degraded existing legacy install (activate never repairs)", () => {
    // absent + an mcp-only remnant (globalMcpPresent=true, hooks incomplete). Repair mode
    // WOULD restore this existing degraded install; activate mode must not. This proves
    // the backstop threads mode:"activate" into the planner, not just the empty case.
    const paths = tmpPaths({ hooks: {} }, { mcpServers: { meetless: { command: "x", args: ["mcp"] } } });
    const io = spyIO();
    const r = reconcileWiringBackstop({
      paths,
      reconcileIO: io,
      detect: () => ({ status: "absent" }),
    });
    expect(r.action).toBe("noop");
    expect(io.restored).toBe(0);
    expect(io.removed).toBe(0);
  });

  it("passes the non-global advisory through as `warn` on a noop plan (Blocker 3)", () => {
    // A project-scoped plugin always reconciles to noop, but the caller must still be
    // able to warn the user. The backstop forwards plan.warn even though nothing
    // changed and nothing failed; the executor is never touched.
    const paths = tmpPaths({ hooks: {} }, {});
    const io = spyIO();
    const r = reconcileWiringBackstop({
      paths,
      reconcileIO: io,
      detect: () => ({ status: "non-global", scope: "project", version: "unknown" }),
    });
    expect(r.action).toBe("noop");
    expect(r.changed).toBe(false);
    expect(r.failed).toBe(false);
    expect(r.warn).toMatch(/user scope/i);
    expect(io.removed + io.restored).toBe(0);
  });

  it("never throws when detection throws, and surfaces failed:true (fail-safe, WARN not swallow)", () => {
    const paths = tmpPaths({ hooks: {} }, {});
    const io = spyIO();
    let r: ReturnType<typeof reconcileWiringBackstop>;
    expect(() => {
      r = reconcileWiringBackstop({
        paths,
        reconcileIO: io,
        detect: () => {
          throw new Error("boom");
        },
      });
    }).not.toThrow();
    expect(r!.failed).toBe(true);
    expect(r!.action).toBe("noop");
    expect(r!.changed).toBe(false);
    expect(io.removed + io.restored).toBe(0);
  });
});
