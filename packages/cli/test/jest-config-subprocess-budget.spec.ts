// The suite's determinism must live in jest.config.js, not in the flags CI happens to pass.
//
// MEASURED 2026-08-10, on this package, at c64dc2d6e. A full `pnpm test` run failed 5 tests
// across 3 suites, every one of them with the same message:
//
//     thrown: "Exceeded timeout of 5000 ms for a test."
//
// The very next run of the same command on the same tree passed all 7746. That is the
// signature of a budget with no margin, not of a broken assertion.
//
// WHY THE MARGIN IS GONE. 109 specs in this package shell out (spawnSync / execFileSync /
// execSync): the hook specs run the real `user-prompt-submit.sh` through bash. Exactly 2 of
// those 109 set a timeout of their own, so 107 subprocess specs are handed jest's bare 5000ms
// default. Spawning bash plus node inside 5s has no headroom the moment the box is busy.
//
// WHY CI NEVER SAW IT. `.github/workflows/mla-ci.yml` runs
// `pnpm --filter @meetless/mla run test --maxWorkers=50% --ci --forceExit` on a 2 vCPU runner,
// which is one worker: effectively serial, so the subprocesses never contend. `pnpm test` on a
// developer box takes jest's default of one worker per core (12 here, so ~11 workers), every one
// of them free to spawn bash at the same moment. The two environments were running materially
// different suites and only one of them was ever observed.
//
// So this is not "a flaky test". It is a config that delegates its own determinism to a caller,
// and one caller passes the flags while the other does not. This spec pins the protection to the
// file both callers read.
//
// It deliberately asserts on the CONFIG, never on the spec count: the count is quoted in failure
// messages only. Ten agent sessions share this checkout and specs land constantly, so an
// assertion over a directory walk would go red for reasons that have nothing to do with the bug.

import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jestConfig = require(path.resolve(__dirname, "..", "jest.config.js"));

// jest's built-in default. The number this file exists to stop relying on.
const JEST_DEFAULT_TIMEOUT_MS = 5000;

describe("jest.config.js carries the subprocess budget itself", () => {
  it("declares a testTimeout, so 107 subprocess specs are not on the bare default", () => {
    expect(jestConfig.testTimeout).toBeDefined();
    expect(typeof jestConfig.testTimeout).toBe("number");
  });

  it("gives a spec that spawns bash real headroom over the 5000ms default", () => {
    // 5 observed failures were all AT the default. Anything at or below it re-opens the bug.
    expect(jestConfig.testTimeout).toBeGreaterThan(JEST_DEFAULT_TIMEOUT_MS);
    // A subprocess spec pays for bash startup plus node startup plus the work itself. Four
    // times the default is the margin that made this suite reproducible on a loaded 12-core box.
    expect(jestConfig.testTimeout).toBeGreaterThanOrEqual(20_000);
  });

  it("caps worker fan-out, so a dev box does not run a different suite than CI", () => {
    // CI passes --maxWorkers=50% by flag. The config must say the same thing, or `pnpm test`
    // locally is a different experiment from the one that gates the release.
    expect(jestConfig.maxWorkers).toBeDefined();
  });
});
