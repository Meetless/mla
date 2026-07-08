import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseAsOf } from "../../src/lib/temporal";
import { bindWorkspaceMarker } from "./workspace-marker.helper";

// Phase 5.1 (B9): `mla ask --as-of <date>` is the PRIMARY temporal surface.
// `parseAsOf` normalizes an operator date into a UTC valid-time instant, and
// `runAsk` forwards it as the intel ask request body's `as_of` field so the
// answer is pinned point-in-time. Two layers, mirroring ask.spec.ts:
//   1. parseAsOf - the pure date normalizer (ISO + compact + reject malformed).
//   2. runAsk glue - `--as-of` reaches the handler callArgs as `as_of`, a
//      one-line point-in-time banner is printed, and the absence of `--as-of`
//      keeps the live path byte-identical (no `as_of`, no banner).
// The request-body wiring (as_of -> intelAsk payload) is locked in ask-core's
// own ask_modes.test.js; here we pin everything `mla` itself owns.
//
// Plan: notes/20260605-mla-full-temporal-awareness-implementation-plan.md, Task 5.1.

describe("parseAsOf", () => {
  it("parses ISO and YYYYMMDD as-of dates", () => {
    expect(parseAsOf("2026-04-10")).toBe("2026-04-10T00:00:00.000Z");
    expect(parseAsOf("20260410")).toBe("2026-04-10T00:00:00.000Z");
  });

  it("rejects a malformed as-of date", () => {
    expect(() => parseAsOf("not-a-date")).toThrow();
  });

  it("rejects a rolled-over calendar date", () => {
    // JS Date silently rolls 2026-02-30 to Mar 2; parseAsOf must refuse it so a
    // typo never answers as-of a different day.
    expect(() => parseAsOf("2026-02-30")).toThrow();
  });

  it("normalizes a full ISO datetime to a UTC instant", () => {
    expect(parseAsOf("2026-04-10T12:30:00Z")).toBe("2026-04-10T12:30:00.000Z");
  });
});

// --- runAsk forwarding (mla glue), mirroring ask.spec.ts's injected core -----

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-ask-asof-"));
process.env.MEETLESS_HOME = HOME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ask = require("../../src/commands/ask") as typeof import("../../src/commands/ask");
const { runAsk, parseArgs } = ask;

function writeCfg(workspaceId = "ws_test"): void {
  fs.writeFileSync(
    path.join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl: "http://127.0.0.1:8100",
      controlToken: "ik-test",
      workspaceId,
      mlaPath: "/bin/true",
    }),
  );
}

interface Recorder {
  lastHandlerArgs?: Record<string, unknown>;
}

function makeStubCore(rec: Recorder) {
  const handler = () => async (a: Record<string, unknown>) => {
    rec.lastHandlerArgs = a;
    return { mode: "answer", answer: "stub", confidence: "high", results: [], warnings: [] };
  };
  return {
    makeIntelAsk: () => ({ __intelAsk: true }),
    makeMatchCanonical: () => () => ({ matches: [], reason: "no INDEX.md match" }),
    statusFallback: () => ({ results: [], warnings: [] }),
    makeAskModes: () => ({
      runAnswer: handler(),
      runSearch: handler(),
      runCanonical: handler(),
      runCompare: handler(),
    }),
  };
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], rec: Recorder = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loadCore = async () => makeStubCore(rec) as any;
    const code = await runAsk(argv, { loadCore });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

let restoreCwd: () => void = () => {};

beforeAll(() => {
  restoreCwd = bindWorkspaceMarker(HOME, "ws_test");
});

beforeEach(() => {
  writeCfg();
});

afterAll(() => {
  restoreCwd();
  delete process.env.MEETLESS_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe("parseArgs (mla ask --as-of)", () => {
  it("parses --as-of into a normalized UTC instant", () => {
    expect(parseArgs(["q", "--as-of", "2026-04-10"]).asOf).toBe("2026-04-10T00:00:00.000Z");
    expect(parseArgs(["q", "--as-of", "20260410"]).asOf).toBe("2026-04-10T00:00:00.000Z");
  });

  it("rejects a malformed --as-of date", () => {
    expect(() => parseArgs(["q", "--as-of", "bogus"])).toThrow();
  });

  it("leaves asOf undefined when --as-of is absent", () => {
    expect(parseArgs(["q"]).asOf).toBeUndefined();
  });
});

describe("mla ask --as-of forwarding", () => {
  it("forwards a normalized as_of into the handler args and prints a point-in-time banner", async () => {
    const rec: Recorder = {};
    const r = await run(["q", "--as-of", "2026-04-10"], rec);
    expect(r.code).toBe(0);
    expect(rec.lastHandlerArgs?.as_of).toBe("2026-04-10T00:00:00.000Z");
    // A one-line banner tells the operator the answer is point-in-time. It goes
    // to stderr so `mla ask` stdout stays pure JSON for piping.
    expect(r.stderr).toMatch(/point-in-time/i);
    expect(r.stderr).toContain("2026-04-10T00:00:00.000Z");
  });

  it("does not set as_of or print a banner when --as-of is absent (byte-identical live path)", async () => {
    const rec: Recorder = {};
    const r = await run(["q"], rec);
    expect(r.code).toBe(0);
    expect(rec.lastHandlerArgs?.as_of).toBeUndefined();
    expect(r.stderr).not.toMatch(/point-in-time/i);
  });

  it("returns exit 2 on a malformed --as-of (parse error before core load)", async () => {
    const r = await run(["q", "--as-of", "nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/as-of|as_of|date/i);
  });
});
