// Bug #2 regression (Windows prod incident, 2026-07-10;
// notes/20260710-windows-hook-wiring-and-portable-lock-fix.md). The hook mutex
// used to be raw `flock` on an fd. `flock(1)` is util-linux: ABSENT on Git Bash /
// MSYS (Windows) and on stock macOS (only present via `brew install flock`).
// Under `set -euo pipefail` a missing flock is `command not found` (127) and
// ABORTS the hook, so passive capture silently died on every Windows box.
//
// The fix is ml_lock/ml_trylock/ml_unlock in common.sh: flock where present,
// atomic mkdir(2) otherwise. This test drives the REAL helpers (sourced, not a
// re-implementation) with MEETLESS_HAVE_FLOCK forced to 0 -- the exact Windows /
// no-brew view -- and asserts the fallback still delivers the four properties the
// hook pipeline depends on: mutual exclusion, atomic appends (no torn/lost
// spool lines), correct trylock busy/free, and stale-holder reaping (no deadlock
// when a holder dies mid-section, which flock's kernel-release gave us for free).
//
// Runs on POSIX CI and needs NO flock installed: it forces the fallback path, so
// it pins Windows behavior deterministically regardless of the CI box.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");
const EXERCISE = join(__dirname, "..", "fixtures", "portable-lock-exercise.sh");

describe("portable hook mutex: mkdir(2) fallback works with flock absent (Bug #2)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-lock-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("holds mutual exclusion, atomic appends, trylock, and stale-reap without flock", () => {
    let stdout = "";
    let failed = false;
    try {
      stdout = execFileSync("bash", [EXERCISE], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", COMMON_SH },
      });
    } catch (e: any) {
      // Non-zero exit => at least one property failed. Surface the harness output.
      failed = true;
      stdout = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    expect(stdout).toContain("PASS mutual-exclusion");
    expect(stdout).toContain("PASS append-atomicity");
    expect(stdout).toContain("PASS trylock: refused a held lock");
    expect(stdout).toContain("PASS trylock: acquired a free lock");
    expect(stdout).toContain("PASS stale-reap");
    expect(stdout).toContain("ALL LOCK TESTS PASSED");
    expect(failed).toBe(false);
  });
});
