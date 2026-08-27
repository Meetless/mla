module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    // tsconfig.spec.json turns on isolatedModules, which keeps ts-jest on
    // transpileModule instead of a whole-program LanguageService. See that file.
    // This also overrides the ts-jest preset's own transform, which would
    // otherwise load tsconfig.json and lose the flag.
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
  collectCoverageFrom: ["src/**/*.ts"],
};
