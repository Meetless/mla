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
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
};
