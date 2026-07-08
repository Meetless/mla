import { parseArgs } from "../../src/commands/internal-finalize";

// Behavioral lock for `mla _internal finalize-session` argv parsing
// (Wedge v6 Epoch 53).
//
// flush.sh always invokes this with exactly one positional:
//
//   "$MLA_PATH" _internal finalize-session "$SESSION_ID"
//
// The old guard was `argv.length < 1`, which silently accepted three
// shapes that should never reach the server:
//
//   1. `... finalize-session sid extra` silently dropped "extra".
//      A flush.sh refactor that appended a second positional would
//      target one sessionId but appear to accept two.
//
//   2. `... finalize-session --foo` bound sessionId="--foo" and the
//      server then 404'd opaquely. A template bug that emitted a
//      flag in the SESSION_ID slot (e.g. shell glob gone wrong)
//      would silently 404.
//
// Strict rules: zero flags, exactly one positional.

describe("parseArgs (mla _internal finalize-session)", () => {
  describe("happy paths", () => {
    it("accepts a single positional sessionId", () => {
      expect(parseArgs(["sess_abc"]).sessionId).toBe("sess_abc");
    });

    it("preserves an unusual sessionId verbatim", () => {
      expect(parseArgs(["session-with-dashes-0001"]).sessionId).toBe(
        "session-with-dashes-0001",
      );
    });
  });

  describe("missing-positional guard", () => {
    it("throws when no arguments are supplied", () => {
      expect(() => parseArgs([])).toThrow(
        /usage: mla _internal finalize-session <sessionId>/,
      );
    });
  });

  describe("flag-rejection guards (Trap 2)", () => {
    it("rejects --foo in the positional slot", () => {
      expect(() => parseArgs(["--foo"])).toThrow(/Unknown flag: --foo/);
    });

    it("rejects a short flag", () => {
      expect(() => parseArgs(["-x"])).toThrow(/Unknown flag: -x/);
    });

    it("error names the supported shape", () => {
      expect(() => parseArgs(["--bogus"])).toThrow(
        /no flags, only <sessionId>/,
      );
    });
  });

  describe("extra-positional guard (Trap 1)", () => {
    it("throws on a second positional", () => {
      expect(() => parseArgs(["sess_abc", "extra"])).toThrow(
        /exactly one sessionId/,
      );
    });

    it("throws on three positionals", () => {
      expect(() => parseArgs(["sess_abc", "x1", "x2"])).toThrow(
        /exactly one sessionId/,
      );
    });
  });

  describe("drift guard", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    function source(): string {
      const p = path.resolve(
        __dirname,
        "../../src/commands/internal-finalize.ts",
      );
      return fs.readFileSync(p, "utf8");
    }

    it("parseArgs is exported so future rules pin here", () => {
      expect(source()).toMatch(/export function parseArgs/);
    });

    // The old shape was `argv.length < 1`, which let `< 1` slip
    // through as "exactly 0" but also accepted 2, 3, N positionals.
    // Pin that the loose lower-bound check stays gone. Strip
    // comments before matching so the narrative comment quoting the
    // trap pattern doesn't false-trip.
    it("does NOT re-introduce the `argv.length < 1` loose-bound check", () => {
      const src = source()
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^.*?\/\/.*$/gm, "");
      expect(src).not.toMatch(/argv\.length\s*<\s*1/);
    });

    it("runInternalFinalize still calls parseArgs", () => {
      expect(source()).toMatch(/parseArgs\(argv\)/);
    });
  });
});
