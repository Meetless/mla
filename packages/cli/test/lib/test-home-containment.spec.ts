// The guard on the guard.
//
// `test/jest.setup-home.js` is what stops this suite writing into the operator's REAL agent-host
// state. It is silent infrastructure: nothing imports it, nothing asserts on it, and every one of
// its failure modes is INVISIBLE to the rest of the suite. Remove `setupFiles` from jest.config.js,
// move it to `setupFilesAfterEnv`, or let one spec export a real MEETLESS_HOME, and all 470 suites
// stay green while dropping scan caches, rule bundles, verdicts and receipts into ~/.meetless.
//
// That is not hypothetical. Two fixture rule bundles for the fake workspace `ws_1` sat in the
// operator's live ~/.meetless/rules/ from 2026-07-13 09:18 until 2026-08-03, written by a suite run
// 57 minutes before the containment landed (bf890c822, 10:15 the same morning). Nothing failed.
// Nothing reported it. It was found by looking at the directory with human eyes, which is not a
// detection mechanism.
//
// So the invariant gets a test. Each assertion below corresponds to a specific way the containment
// can be removed while the suite keeps passing.

import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

import { HOME as FROZEN_MEETLESS_HOME } from "../../src/lib/config";

describe("the test suite may not write into the operator's real agent-host state", () => {
  it("MEETLESS_HOME is set to an absolute throwaway path", () => {
    const home = process.env.MEETLESS_HOME;
    expect(home).toBeTruthy();
    expect(isAbsolute(home!)).toBe(true);
  });

  it("MEETLESS_HOME is not the operator's real ~/.meetless", () => {
    // `homedir()` honors $HOME and the setup file deliberately does NOT touch $HOME, so this
    // resolves to the real home here exactly as it does in production.
    //
    // The `typeof` line is not decoration: with the containment removed MEETLESS_HOME is
    // UNDEFINED, and `expect(undefined).not.toBe("/Users/x/.meetless")` passes. A row that goes
    // green precisely when the thing it guards is gone is worse than no row at all.
    expect(typeof process.env.MEETLESS_HOME).toBe("string");
    expect(process.env.MEETLESS_HOME).not.toBe(join(homedir(), ".meetless"));
  });

  it("CODEX_HOME is not the operator's real ~/.codex", () => {
    // The second agent host. MEETLESS_HOME does not cover it: resolveCodexHome() reads CODEX_HOME,
    // and before 904429a8a the uninstall spec stripped the operator's real Codex governance hooks
    // on every non-dry-run case, silently, because nothing asserts on a file a spec never meant to
    // touch. Any third agent host added later needs a line here too.
    expect(process.env.CODEX_HOME).toBeTruthy();
    expect(process.env.CODEX_HOME).not.toBe(join(homedir(), ".codex"));
  });

  it("the containment ran BEFORE the modules that freeze a home at import time", () => {
    // The sharpest of the four, and the only one that tests the ORDERING rather than the values.
    //
    // `config.HOME` is `export const HOME = resolveMeetlessHome()`: evaluated once, at module load,
    // from the environment as it stood at that instant. `setupFiles` runs before the test file and
    // therefore before that import; `setupFilesAfterEnv` runs after the framework is installed but
    // is still ahead of the import, so the distinction that actually bites is any future move of
    // the redirect INTO a spec's own `beforeEach` or into a helper the spec imports. Then every
    // env-var assertion above still passes, and every module that captured a home at import time
    // has already captured the REAL one.
    //
    // Comparing the frozen constant against the env var is what catches that: it is the only
    // evidence that the redirect won the race against the import.
    expect(FROZEN_MEETLESS_HOME).toBe(process.env.MEETLESS_HOME);
  });
});
