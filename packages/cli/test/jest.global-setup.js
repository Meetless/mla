// One throwaway home ROOT per RUN; each test file mkdtemps its own home inside it
// (test/jest.setup-home.js explains why). Per-run, not fixed, because ~10 concurrent sessions share
// this tree: a peer running the suite at the same time gets a different root, so our teardown can
// never delete their homes. Assigning to process.env is the documented channel for handing a value
// to the workers (globals are not shared across processes; env is inherited).
//
// The same channel carries the second containment: a no-op `mla` at the HEAD of PATH.
//
// The hooks resolve MLA_PATH from cli-config.json and then fall back to `command -v mla`
// the moment that path fails an -x test (common.sh). Specs pin a harmless sentinel to
// dodge that fallback, and 39 of them pin "/bin/true", which DOES NOT EXIST on macOS
// (true is at /usr/bin/true). So on every Mac the guard fired, the fallback resolved the
// operator's REAL, globally installed mla, and a hook shelled out to it with
// MEETLESS_HOME pointed at a throwaway dir: it self-heals hook templates in, spawns
// detached auto-index / reconcile / flush children that outlive the test, and drains the
// very spool the spec is about to assert on. On Linux CI /bin/true is real, the fallback
// never fires, and none of it is visible. That is a suite that passes in CI and is
// non-hermetic on every machine it is actually developed on.
//
// Rather than chase 39 sentinels and wait for the 40th, own the fallback: put a no-op
// `mla` first on PATH, so the worst case of a dead sentinel is the no-op the spec asked
// for. Nothing in the suite resolves `mla` from PATH on purpose (checked), and a spec
// that pins a live mlaPath still wins, because the pinned path is tried first.
const { chmodSync, mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");

module.exports = async () => {
  const root = mkdtempSync(join(tmpdir(), "mla-jest-homes-"));
  process.env.MLA_TEST_HOME_ROOT = root;

  const shimDir = join(root, "shim-bin");
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, "mla");
  writeFileSync(shim, "#!/bin/sh\nexit 0\n");
  chmodSync(shim, 0o755);
  process.env.PATH = shimDir + delimiter + (process.env.PATH || "");
};
