import { pluginStatusCheck, reconcileChecks } from "../../src/commands/doctor";
import type { ReconcilePlan, ReconcileIO } from "../../src/connectors/claude-code/plugin-migrate";

describe("pluginStatusCheck (mla doctor plugin reporting, design §8)", () => {
  it("echoes an opaque version string verbatim (here the value happens to be 'unknown')", () => {
    // `version` is whatever the install source assigned; doctor never interprets it,
    // it only reports it back. "unknown" is just one such opaque string, not a sentinel.
    const c = pluginStatusCheck({ status: "owned", scope: "user", version: "unknown" });
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/unknown/);
  });

  it("reports a marketplace plugin's semver (version-string-agnostic, no hardcoded 'unknown')", () => {
    const c = pluginStatusCheck({ status: "owned", scope: "user", version: "0.4.2" });
    expect(c.detail).toMatch(/0\.4\.2/);
    expect(c.detail).not.toMatch(/unknown/);
  });

  it("flags a project-scope-only plugin as non-global (no global wiring)", () => {
    const c = pluginStatusCheck({ status: "non-global", scope: "project", version: "unknown" });
    expect(c.level).toBe("info");
    expect(c.detail).toMatch(/project/i);
    expect(c.detail).toMatch(/global/i);
  });

  it("is informational when the plugin is absent", () => {
    const c = pluginStatusCheck({ status: "absent" });
    expect(c.level).toBe("info");
    expect(c.detail).toMatch(/not installed/i);
  });

  it("is informational and quiet when detection is unknown", () => {
    const c = pluginStatusCheck({ status: "unknown", reason: "claude not found" });
    expect(c.level).toBe("info");
  });
});

// A spy ReconcileIO so no case touches the real home dir; matches the shape exactly.
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
const detailOf = (checks: { detail?: string }[]) => checks.map((c) => c.detail ?? "");

describe("reconcileChecks (doctor reconcile rendering, Blocker 3)", () => {
  const NONGLOBAL: ReconcilePlan = {
    action: "noop",
    restartRequired: false,
    reason: "project-scoped; leaving legacy as-is",
    warn: "mla is installed only at project/local scope. Reinstall it at user scope before removing legacy wiring.",
  };

  it("surfaces plan.warn WITHOUT --fix even though the action is noop", () => {
    const io = spyIO();
    const checks = reconcileChecks(NONGLOBAL, false, io);
    // The whole bug: a non-global install is always a noop, so plain `mla doctor`
    // must STILL print the reinstall advisory. It appears with no --fix and no action.
    expect(detailOf(checks)).toContain(NONGLOBAL.warn);
    // A noop never renders a "would <action>" line, and no IO runs without --fix.
    expect(detailOf(checks).some((d) => /would /.test(d))).toBe(false);
    expect(io.removed + io.restored).toBe(0);
  });

  it("surfaces plan.warn WITH --fix too (still independent of fix)", () => {
    const io = spyIO();
    const checks = reconcileChecks(NONGLOBAL, true, io);
    expect(detailOf(checks)).toContain(NONGLOBAL.warn);
    expect(io.removed + io.restored).toBe(0); // noop applies nothing
  });

  it("no --fix + actionable plan renders a 'would <action>' line and NO IO", () => {
    const plan: ReconcilePlan = {
      action: "remove-legacy",
      restartRequired: true,
      reason: "plugin owns wiring",
    };
    const io = spyIO();
    const checks = reconcileChecks(plan, false, io);
    expect(detailOf(checks).some((d) => /would remove-legacy/.test(d))).toBe(true);
    expect(io.removed).toBe(0);
    // No warn on this plan, so no advisory line is appended.
    expect(detailOf(checks).some((d) => /reinstall/i.test(d))).toBe(false);
  });

  it("--fix applies the plan through the injected IO and reports the result", () => {
    const plan: ReconcilePlan = {
      action: "remove-legacy",
      restartRequired: true,
      reason: "plugin owns wiring",
    };
    const io = spyIO();
    const checks = reconcileChecks(plan, true, io);
    expect(io.removed).toBe(1);
    expect(detailOf(checks).some((d) => /remove-legacy/.test(d) && /RESTART/.test(d))).toBe(true);
  });

  it("an actionable plan that ALSO warns (unknown+restore) shows both lines without --fix", () => {
    const plan: ReconcilePlan = {
      action: "restore-legacy",
      restartRequired: true,
      reason: "could not confirm ownership; restoring capture",
      warn: "could not confirm the mla plugin is installed; left legacy capture in place",
    };
    const io = spyIO();
    const checks = reconcileChecks(plan, false, io);
    expect(detailOf(checks).some((d) => /would restore-legacy/.test(d))).toBe(true);
    expect(detailOf(checks)).toContain(plan.warn);
  });
});
