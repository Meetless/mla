// Test-home containment (setupFiles: runs once per test FILE, in the worker, BEFORE the file and
// therefore before any module that reads MEETLESS_HOME at import time, e.g. config.HOME).
//
// One job: no spec may write into the operator's REAL agent-host state. Until this landed every run
// of this suite dropped scan caches, verdicts, projection receipts and assemble audits for fake
// workspace ids (ws_test, ws_1, ws_from_marker, ...) straight into the developer's live Meetless
// state, and a spec that ever used a REAL workspace id would have poisoned the very cache the agent
// hot path reads. Two fixture rule bundles for `ws_1` sat in the operator's ~/.meetless/rules/ from
// 2026-07-13 until 2026-08-03 as the receipt for that; they were written 57 minutes before this file
// existed, and they were found by human eyes, because nothing here reports itself.
//
// MEETLESS_HOME is the lever, not $HOME. Not because $HOME does not work (an earlier version of this
// comment claimed os.homedir() ignores it on Darwin; that is FALSE, homedir() honors $HOME on both
// Darwin and Linux, verified on node 22 / Darwin 25, and scanner/cache.ts:30 and
// commands/scan-context.ts:321 already carry the correction). It is because $HOME is the wrong
// blast radius: resolveMeetlessHome() reads MEETLESS_HOME FIRST and it beats every fallback, so it
// moves exactly the Meetless state root and nothing else, while moving $HOME also moves whatever
// repairHomeEnv() and every spawned child process resolve off it. Contain the narrowest thing that
// contains the problem.
//
// Each test file gets its own throwaway home so parallel workers cannot stomp each other. A spec
// that sets its own MEETLESS_HOME still wins: this runs first. A spec that passes an explicit
// `home` also still wins (that argument beats the env var), so per-case isolation is untouched.
//
// This file is silent infrastructure: nothing imports it and every one of its failure modes is
// invisible to the rest of the suite. test/lib/test-home-containment.spec.ts is the guard on the
// guard. Delete `setupFiles` from jest.config.js and it goes red; 3 of its 4 rows fail, including
// the one that catches a future move of this redirect into a spec's own beforeEach, which would be
// too late for every module that freezes a home at import time.
//
// The temp root ends in `.meetless` on purpose: it mimics the real layout, so product code that
// reasons about the shape of its own paths (the wire hook-dedup heuristic, the Windows hook-command
// renderer) behaves under test exactly as it does on a real box.
const { mkdirSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const root = process.env.MLA_TEST_HOME_ROOT || tmpdir();
const sandbox = mkdtempSync(join(root, "home-"));
const home = join(sandbox, ".meetless");
mkdirSync(home, { recursive: true });
process.env.MEETLESS_HOME = home;

// Same containment, second agent host. MEETLESS_HOME alone does NOT cover the Codex connector:
// its registration file is $CODEX_HOME/hooks.json (default ~/.codex), which resolveCodexHome()
// derives from the real home directory, not from MEETLESS_HOME. That gap was not theoretical. The
// `mla uninstall` spec injected fakes for the Claude removers but not for the Codex one, so every
// non-dry-run case called the REAL removeCodexHooks() against the operator's REAL ~/.codex/hooks.json
// and silently stripped their Codex governance hooks. The suite stayed green the whole time: the
// wipe is invisible to assertions because nothing asserts on a file the spec never meant to touch.
//
// resolveCodexHome() reads process.env.CODEX_HOME at CALL time (not frozen at import), so setting it
// here contains every spec, including ones written later that forget to inject a path override. A
// spec that sets its own CODEX_HOME still wins, since this runs first.
const codexHome = join(sandbox, ".codex");
mkdirSync(codexHome, { recursive: true });
process.env.CODEX_HOME = codexHome;
