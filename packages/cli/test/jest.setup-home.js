// Test-home containment (setupFiles: runs once per test FILE, in the worker, BEFORE the file and
// therefore before any module that reads MEETLESS_HOME at import time, e.g. config.HOME).
//
// One job: no spec may write into the operator's REAL agent-host state. Until now every macOS run of
// this suite dropped scan caches, verdicts, projection receipts and assemble audits for fake
// workspace ids (ws_test, ws_1, ws_from_marker, ...) straight into the developer's live Meetless
// state. The trap: os.homedir() on Darwin reads getpwuid and IGNORES $HOME (Linux/libuv honors
// it), so the usual "redirect HOME in the spec" containment is a no-op here. It looks perfectly
// hermetic on Linux CI while corrupting a Mac, and a spec that ever used a REAL workspace id would
// have poisoned the very cache the agent hot path reads.
//
// So we redirect MEETLESS_HOME, which every state path now honors (scanner/cache.ts + config.HOME),
// and give each test file its own throwaway home so parallel workers cannot stomp each other. A
// spec that sets its own MEETLESS_HOME still wins: this runs first. A spec that passes an explicit
// `home` also still wins (that argument beats the env var), so per-case isolation is untouched.
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
// derives from the real passwd home, not from MEETLESS_HOME. That gap was not theoretical. The
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
