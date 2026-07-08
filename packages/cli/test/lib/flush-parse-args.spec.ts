import { parseArgs } from "../../src/commands/flush";

// Behavioral lock for `mla flush` argv parsing (Wedge v6 Epoch 48).
//
// The traps this epoch closes:
//
//   1. `--session` / `-s` with no following value silently bound
//      `out.session = undefined`. Downstream code then treated
//      undefined as falsy and drained EVERY active session in the
//      queue. The operator's intent ("drain just this one") flipped
//      to "drain everything" with zero diagnostic. On a busy machine
//      that is dozens to hundreds of sessions and minutes of
//      un-bounded fan-out. This is the most dangerous silent-drop
//      found on the CLI surface.
//
//   2. `--session` followed by another `--`-prefixed token (e.g.
//      `--session --quiet`) silently swallowed `--quiet` as the
//      "session id". The session lookup then 404'd opaquely.
//
//   3. `--all` was a dead flag. The ternary in runFlush collapsed to
//      `flags.all ? listActiveSessions() : listActiveSessions()`. The
//      flag and the default did the same thing, even though the docs
//      implied otherwise. The parser now still accepts --all (kept
//      as an explicit synonym) but makes it mutually exclusive with
//      --session so operators get a loud error rather than silent
//      "session wins" priority.
//
//   4. Unknown flags (typos like `--alll`, `--quet`) were silently
//      ignored.
//
//   5. Extra positionals (`mla flush sid1 sid2`) were silently
//      dropped (the !out.session guard kept sid1 and discarded sid2).

describe("parseArgs (mla flush)", () => {
  describe("happy paths", () => {
    it("accepts no arguments (drain every active session)", () => {
      const out = parseArgs([]);
      expect(out.session).toBeUndefined();
      expect(out.all).toBeUndefined();
      expect(out.quiet).toBeUndefined();
    });

    it("accepts --all", () => {
      const out = parseArgs(["--all"]);
      expect(out.all).toBe(true);
    });

    it("accepts --session with a value", () => {
      const out = parseArgs(["--session", "sess_abc"]);
      expect(out.session).toBe("sess_abc");
    });

    it("accepts -s short form with a value", () => {
      const out = parseArgs(["-s", "sess_abc"]);
      expect(out.session).toBe("sess_abc");
    });

    it("accepts --quiet and -q", () => {
      expect(parseArgs(["--quiet"]).quiet).toBe(true);
      expect(parseArgs(["-q"]).quiet).toBe(true);
    });

    it("accepts a positional sessionId as a --session shortcut", () => {
      const out = parseArgs(["sess_positional"]);
      expect(out.session).toBe("sess_positional");
    });

    it("accepts --session combined with --quiet", () => {
      const out = parseArgs(["--session", "sess_abc", "--quiet"]);
      expect(out.session).toBe("sess_abc");
      expect(out.quiet).toBe(true);
    });

    it("accepts --all combined with --quiet", () => {
      const out = parseArgs(["--all", "--quiet"]);
      expect(out.all).toBe(true);
      expect(out.quiet).toBe(true);
    });

    it("accepts --gc", () => {
      expect(parseArgs(["--gc"]).gc).toBe(true);
    });

    it("accepts --gc combined with --quiet", () => {
      const out = parseArgs(["--gc", "--quiet"]);
      expect(out.gc).toBe(true);
      expect(out.quiet).toBe(true);
    });

    it("accepts --gc combined with --all (drain all then reap)", () => {
      const out = parseArgs(["--all", "--gc"]);
      expect(out.all).toBe(true);
      expect(out.gc).toBe(true);
    });

    it("accepts --reap-only", () => {
      expect(parseArgs(["--reap-only"]).reapOnly).toBe(true);
    });

    it("accepts --reap-only combined with --quiet", () => {
      const out = parseArgs(["--reap-only", "--quiet"]);
      expect(out.reapOnly).toBe(true);
      expect(out.quiet).toBe(true);
    });
  });

  describe("--reap-only mutual exclusion (reap without draining)", () => {
    it("throws when combined with --gc", () => {
      expect(() => parseArgs(["--reap-only", "--gc"])).toThrow(/mutually exclusive|cannot be combined/);
      expect(() => parseArgs(["--gc", "--reap-only"])).toThrow(/mutually exclusive|cannot be combined/);
    });

    it("throws when combined with --all", () => {
      expect(() => parseArgs(["--reap-only", "--all"])).toThrow(/mutually exclusive|cannot be combined/);
      expect(() => parseArgs(["--all", "--reap-only"])).toThrow(/mutually exclusive|cannot be combined/);
    });

    it("throws when combined with --session", () => {
      expect(() => parseArgs(["--reap-only", "--session", "sid"])).toThrow(/mutually exclusive|cannot be combined/);
      expect(() => parseArgs(["--session", "sid", "--reap-only"])).toThrow(/mutually exclusive|cannot be combined/);
    });

    it("throws when combined with a positional session id", () => {
      expect(() => parseArgs(["--reap-only", "sid"])).toThrow(/mutually exclusive|cannot be combined/);
    });
  });

  describe("--gc vs --session mutual exclusion", () => {
    it("throws when --session follows --gc", () => {
      expect(() => parseArgs(["--gc", "--session", "sid"])).toThrow(/mutually exclusive/);
    });

    it("throws when --gc follows --session", () => {
      expect(() => parseArgs(["--session", "sid", "--gc"])).toThrow(/mutually exclusive/);
    });

    it("throws when a positional sessionId follows --gc", () => {
      expect(() => parseArgs(["--gc", "sid"])).toThrow(/mutually exclusive/);
    });
  });

  describe("missing-value guards (Trap 1+2)", () => {
    // Trap 1: this used to silently turn into "drain everything."
    it("throws when --session has no following value", () => {
      expect(() => parseArgs(["--session"])).toThrow(/Missing value for --session/);
    });

    it("throws when -s has no following value", () => {
      expect(() => parseArgs(["-s"])).toThrow(/Missing value for -s/);
    });

    // Trap 2: --session --quiet used to bind session = "--quiet".
    it("throws when --session is followed by another --flag", () => {
      expect(() => parseArgs(["--session", "--quiet"])).toThrow(
        /Missing value for --session.*--quiet/,
      );
    });

    it("throws when --session is followed by a short flag", () => {
      expect(() => parseArgs(["--session", "-q"])).toThrow(
        /Missing value for --session.*-q/,
      );
    });

    it("throws when --session is the last argv token even if other flags precede", () => {
      expect(() => parseArgs(["--quiet", "--session"])).toThrow(
        /Missing value for --session/,
      );
    });
  });

  describe("--all vs --session mutual exclusion (Trap 3)", () => {
    it("throws when --all comes after --session", () => {
      expect(() => parseArgs(["--session", "sess_abc", "--all"])).toThrow(
        /mutually exclusive/,
      );
    });

    it("throws when --session comes after --all", () => {
      expect(() => parseArgs(["--all", "--session", "sess_abc"])).toThrow(
        /mutually exclusive/,
      );
    });

    it("throws when a positional sessionId follows --all", () => {
      expect(() => parseArgs(["--all", "sess_abc"])).toThrow(
        /already drains every session/,
      );
    });
  });

  describe("unknown flags (Trap 4)", () => {
    it("throws on --alll typo", () => {
      expect(() => parseArgs(["--alll"])).toThrow(/Unknown flag: --alll/);
    });

    it("throws on --quet typo", () => {
      expect(() => parseArgs(["--quet"])).toThrow(/Unknown flag: --quet/);
    });

    it("throws on an unknown short flag", () => {
      expect(() => parseArgs(["-z"])).toThrow(/Unknown flag: -z/);
    });

    it("lists supported flags in the unknown-flag error message", () => {
      expect(() => parseArgs(["--bogus"])).toThrow(/--all.*--session.*--quiet/);
    });
  });

  describe("extra positional guards (Trap 5)", () => {
    it("throws on two positional session ids", () => {
      expect(() => parseArgs(["sid1", "sid2"])).toThrow(
        /at most one session id/,
      );
    });

    it("throws on positional after --session", () => {
      expect(() => parseArgs(["--session", "sid1", "sid2"])).toThrow(
        /at most one session id/,
      );
    });
  });

  describe("drift guard", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    function source(): string {
      const p = path.resolve(__dirname, "../../src/commands/flush.ts");
      return fs.readFileSync(p, "utf8");
    }

    it("KNOWN_FLAGS includes every documented flag", () => {
      const src = source();
      for (const f of ["--all", "--session", "-s", "--quiet", "-q", "--gc"]) {
        expect(src.includes(`"${f}"`)).toBe(true);
      }
    });

    // The dead-branch trap (Trap 3) returns if a future refactor
    // re-introduces a `flags.all ? listActiveSessions() :
    // listActiveSessions()` ternary. Pin the single-call shape.
    // Strip line + block comments before the regex check so the
    // narrative comment that quotes the trap pattern in the source
    // doesn't trigger a false positive.
    it("runFlush resolves sessions via a single listActiveSessions() call", () => {
      const src = source()
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^.*?\/\/.*$/gm, "");
      const noTernary =
        !/flags\.all\s*\?\s*listActiveSessions\(\)\s*:\s*listActiveSessions\(\)/.test(
          src,
        );
      expect(noTernary).toBe(true);
    });

    it("parseArgs is exported so future flag rules can be pinned here", () => {
      const src = source();
      expect(src).toMatch(/export function parseArgs/);
    });
  });
});
