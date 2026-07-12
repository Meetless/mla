import { parseDoctorArgs, runDoctor } from "../../src/commands/doctor";

// Behavioral lock for `mla doctor` argument contract (Wedge v6 Epoch 49; extended
// for Task 8's --fix flag).
//
// The trap this epoch closes:
//
//   doctor.ts previously declared `interface DoctorFlags { gc?: boolean }`
//   and a `parseArgs` function that recognized `--gc`, `--gc=yes`, and
//   `--gc=no`. The `runDoctor` entry point called `parseArgs(argv)` and
//   IMMEDIATELY threw the result away (no assignment, no closure
//   capture, no downstream read). The flag was a scaffold that was
//   never wired to any GC behavior.
//
//   Operators who typed `mla doctor --gc` reasonably expected orphan
//   `.jsonl.draining.*` cleanup. They got nothing AND no signal that
//   the flag was a no-op. This was textbook documentation drift on
//   the diagnostic surface.
//
// Resolution: orphan recovery is already automatic inside flush.sh on
// every flush, so there is no concrete GC operation that the doctor
// needs to perform separately. The dead flag was removed entirely and
// `mla doctor` refused any argv. Task 8 now adds a single real flag,
// `--fix`, which reconciles legacy home-dir wiring against an installed
// plugin (design §6.7, §8); any other argument (including the removed
// --gc) is still rejected loudly.

describe("parseDoctorArgs (mla doctor)", () => {
  it("accepts no args", () => {
    expect(parseDoctorArgs([])).toEqual({ fix: false, json: false });
  });

  it("accepts --fix", () => {
    expect(parseDoctorArgs(["--fix"])).toEqual({ fix: true, json: false });
  });

  // Phase 3 (release-testing proposal §212): the integration harness asserts
  // named checks off `doctor --json`, so the flag must parse into a plain
  // read-only toggle (no positional, no value).
  it("accepts --json", () => {
    expect(parseDoctorArgs(["--json"])).toEqual({ fix: false, json: true });
  });

  it("accepts --fix and --json together", () => {
    expect(parseDoctorArgs(["--fix", "--json"])).toEqual({
      fix: true,
      json: true,
    });
  });

  it("still rejects the removed --gc flag with the no-op note", () => {
    expect(() => parseDoctorArgs(["--gc"])).toThrow(/only the optional --fix and --json flags/);
    expect(() => parseDoctorArgs(["--gc"])).toThrow(/--gc flag was a no-op/);
  });

  it("rejects unknown flags and echoes the offender", () => {
    expect(() => parseDoctorArgs(["--verbose"])).toThrow(/only the optional --fix and --json flags/);
    expect(() => parseDoctorArgs(["--verbose"])).toThrow(/got: --verbose/);
  });

  it("rejects positional args", () => {
    expect(() => parseDoctorArgs(["something"])).toThrow(/got: something/);
  });
});

describe("doctor drift guards", () => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");

  function readSource(rel: string): string {
    const p = path.resolve(__dirname, rel);
    return fs.readFileSync(p, "utf8");
  }

  // If a future PR re-adds a parseArgs function on doctor.ts whose
  // result is discarded, this drift guard catches it. The contract is:
  // doctor takes at most --fix; the argv handler is parseDoctorArgs ONLY.
  it("doctor.ts does NOT re-introduce a parseArgs function", () => {
    const src = readSource("../../src/commands/doctor.ts");
    expect(src).not.toMatch(/function\s+parseArgs\s*\(/);
  });

  it("doctor.ts exports parseDoctorArgs for the spec to lock against", () => {
    const src = readSource("../../src/commands/doctor.ts");
    expect(src).toMatch(/export function parseDoctorArgs/);
  });

  // The CLI dispatcher USAGE string is the operator-visible doc. If
  // it still mentions --gc, an operator will type the flag expecting
  // the (still nonexistent) GC behavior.
  it("cli.ts USAGE no longer mentions --gc on `mla doctor`", () => {
    const src = readSource("../../src/cli.ts");
    // The "mla doctor" line in USAGE must not be followed by --gc.
    expect(src).not.toMatch(/mla doctor\s*\[--gc\]/);
    expect(src).not.toMatch(/mla doctor\s*--gc/);
  });

  it("runDoctor still calls parseDoctorArgs (wiring is not silently removed)", () => {
    const src = readSource("../../src/commands/doctor.ts");
    expect(src).toMatch(/parseDoctorArgs\(argv\)/);
  });
});

// F2 (mla first-run E2E harness): `mla doctor --<typo>` used to surface as
// "MLA hit an internal error -> mla bug report". parseDoctorArgs throws a plain
// Error on a bad flag; that throw escaped runDoctor to cli.ts's top-level catch,
// where classifyOutcome buckets an unnamed throw as system_error, which
// isReportableFault treats as a genuine fault on our side and fires the bug-report
// nudge. runDoctor now catches the parse throw and returns exit 2 (the CLI's
// usage-error convention, shared with "Unknown command" and every sub-dispatcher)
// WITHOUT re-throwing, so the run classifies as user_error and the nudge is
// structurally impossible on a typo. These lock the surfacing, not just the parse.
describe("runDoctor usage errors (bad flag -> exit 2, no internal-error nudge)", () => {
  function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("returns exit 2 and echoes the reason for an unknown flag, without throwing", async () => {
    const { lines, restore } = captureStderr();
    try {
      const code = await runDoctor(["--frobnicate"]);
      expect(code).toBe(2);
      const out = lines.join("\n");
      expect(out).toMatch(/only the optional --fix and --json flags/);
      expect(out).toMatch(/got: --frobnicate/);
      // The nudge is for genuine faults on our side; a typo must never trigger it.
      expect(out).not.toMatch(/mla bug report/);
    } finally {
      restore();
    }
  });

  it("returns exit 2 for the removed --gc flag with the no-op note (no nudge)", async () => {
    const { lines, restore } = captureStderr();
    try {
      const code = await runDoctor(["--gc"]);
      expect(code).toBe(2);
      const out = lines.join("\n");
      expect(out).toMatch(/--gc flag was a no-op/);
      expect(out).not.toMatch(/mla bug report/);
    } finally {
      restore();
    }
  });
});
