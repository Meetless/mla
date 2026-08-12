module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/test/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // Containment: every spec gets a throwaway MEETLESS_HOME so the suite stops writing scan caches,
  // verdicts and receipts into the operator's real ~/.meetless. See test/jest.setup-home.js for the
  // macOS homedir() trap that made this necessary.
  globalSetup: "<rootDir>/test/jest.global-setup.js",
  globalTeardown: "<rootDir>/test/jest.global-teardown.js",
  setupFiles: ["<rootDir>/test/jest.setup-home.js"],
  // 109 specs in this package shell out, and the hook specs run the real
  // user-prompt-submit.sh through bash. Exactly 2 of those set a timeout of their own, so the
  // rest were running on jest's bare 5000ms default: bash startup plus node startup plus the
  // work, with no headroom. On 2026-08-10 a full run failed 5 tests across 3 suites, every one
  // "Exceeded timeout of 5000 ms", and the next run of the same command on the same tree passed
  // all 7746. CI never saw it because mla-ci passes --maxWorkers=50% on a 2 vCPU runner (one
  // worker, effectively serial) while `pnpm test` on a dev box takes one worker per core.
  //
  // Both settings live here rather than in the CI flags on purpose: a suite whose determinism
  // depends on how the caller invoked it is two different suites, and only one of them gates the
  // release. mla-ci still passes --maxWorkers=50%, which now agrees with this file instead of
  // compensating for it. See test/jest-config-subprocess-budget.spec.ts.
  testTimeout: 30_000,
  maxWorkers: "50%",
  transform: {
    // tsconfig.spec.json turns on isolatedModules, which keeps ts-jest on
    // transpileModule instead of a whole-program LanguageService. See that file.
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
};
