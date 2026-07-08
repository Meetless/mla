import { parseArgs, parseReviewByIdArgs } from "../../src/commands/review";

// Behavioral lock for `mla review` argv parsing.
//
// History (Wedge v6 Epoch 46): parseArgs used to be a loose for-loop that
// silently dropped any --foo that was not --plain/--no-flush. Two traps:
//
//   1. `mla review --plian` (typo for --plain) was a silent no-op; output
//      stayed colored and the operator assumed --plain was broken.
//
//   2. `mla review by-session --plian SID` was worse: the parser captured
//      `--plian` as the session id and silently dropped the real one. The
//      request 404'd with nothing pointing at the typo.
//
// The redesign removed `mla review latest` and `mla review by-session <sid>`
// entirely. `mla review` now resolves the current session implicitly from
// CLAUDE_CODE_SESSION_ID and takes NO positional, NO session flag. A separate
// `mla review <id>` command emits a console deep link for a relationship-
// candidate or agent-review-case id.
//
// These tests pin both parsers as loud-on-anything-unknown so the silent-drop
// classes cannot return.

describe("parseArgs (mla review, no positionals)", () => {
  it("accepts no arguments", () => {
    const out = parseArgs([]);
    expect(out.plain).toBeUndefined();
    expect(out.noFlush).toBeUndefined();
  });

  it("accepts --plain", () => {
    expect(parseArgs(["--plain"]).plain).toBe(true);
  });

  it("accepts --no-flush", () => {
    expect(parseArgs(["--no-flush"]).noFlush).toBe(true);
  });

  it("accepts --plain and --no-flush in either order", () => {
    expect(parseArgs(["--plain", "--no-flush"]).plain).toBe(true);
    expect(parseArgs(["--plain", "--no-flush"]).noFlush).toBe(true);
    expect(parseArgs(["--no-flush", "--plain"]).plain).toBe(true);
    expect(parseArgs(["--no-flush", "--plain"]).noFlush).toBe(true);
  });

  it("tolerates repeated --plain (idempotent)", () => {
    expect(parseArgs(["--plain", "--plain"]).plain).toBe(true);
  });

  // Original Trap 1: --plian typo silently dropped.
  it("throws on an unknown long flag and names the offender", () => {
    expect(() => parseArgs(["--plian"])).toThrow(/Unknown flag: --plian/);
  });

  it("throws on --verbose (any unknown long flag, not just typos)", () => {
    expect(() => parseArgs(["--verbose"])).toThrow(/Unknown flag: --verbose/);
  });

  it("lists the supported flags in the error message", () => {
    expect(() => parseArgs(["--bad"])).toThrow(/--plain.*--no-flush/);
  });

  // The redesigned surface forbids positionals at this layer. `mla review <id>`
  // is routed by cli.ts to a different parser; if anything positional reaches
  // parseArgs it means the operator typed something the new design rejects
  // (e.g. `mla review --plain some-sid`). Naming the offender beats silently
  // dropping it.
  it("throws on a stray positional and points at `mla review <id>`", () => {
    expect(() => parseArgs(["some-id"])).toThrow(
      /Unexpected positional argument: some-id.*mla review <id>/s,
    );
  });

  it("throws on a stray positional even when valid flags precede it", () => {
    expect(() => parseArgs(["--plain", "some-id"])).toThrow(/Unexpected positional/);
  });
});

describe("parseReviewByIdArgs (mla review <id>)", () => {
  it("requires exactly one positional id", () => {
    expect(() => parseReviewByIdArgs([])).toThrow(/Usage: mla review <id>/);
  });

  it("accepts a single id", () => {
    expect(parseReviewByIdArgs(["abc"]).id).toBe("abc");
  });

  it("refuses a second positional and names it", () => {
    expect(() => parseReviewByIdArgs(["a", "b"])).toThrow(
      /Unexpected extra positional argument: b/,
    );
  });

  it("refuses any flag-shape token", () => {
    expect(() => parseReviewByIdArgs(["--plain", "abc"])).toThrow(/Unknown flag: --plain/);
    expect(() => parseReviewByIdArgs(["abc", "--plain"])).toThrow(/Unknown flag: --plain/);
    expect(() => parseReviewByIdArgs(["-v"])).toThrow(/Unknown flag: -v/);
  });
});

describe("drift guard", () => {
  // Cheap source-level guard: the supported-flag whitelist in parseArgs MUST
  // stay in sync with what the branches handle. If a future PR adds a flag to
  // the error message without wiring its branch (or vice versa), this catches
  // the omission by reading the source.
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");

  function source(): string {
    const p = path.resolve(__dirname, "../../src/commands/review.ts");
    return fs.readFileSync(p, "utf8");
  }

  it("supported-flag whitelist mentions --plain and --no-flush", () => {
    expect(source()).toMatch(/Supported flags: --plain, --no-flush/);
  });

  it("parseArgs handles --plain and --no-flush as explicit branches", () => {
    const src = source();
    expect(src).toMatch(/a === "--plain"/);
    expect(src).toMatch(/a === "--no-flush"/);
  });

  it("parseArgs and parseReviewByIdArgs are both exported", () => {
    const src = source();
    expect(src).toMatch(/export function parseArgs/);
    expect(src).toMatch(/export function parseReviewByIdArgs/);
  });
});
