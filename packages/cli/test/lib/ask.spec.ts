import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { bindWorkspaceMarker } from "./workspace-marker.helper";

// Behavioral lock for `mla ask` (proposal 20260529 T5 / D-D). `mla ask` is the
// CLI front-end over the SHARED @meetless/ask-core implementation: the same
// answer/search/canonical/compare routing the MCP uses, pointed at the
// workspace `mla` ingests into (cfg.workspaceId).
//
// Two layers are tested here:
//   1. parseArgs - the pure flag/query parser.
//   2. runAsk glue - workspace resolution, mode routing, render, and
//      error->exit-code mapping - driven through an INJECTED ask-core loader.
//
// Why injection instead of the real import? `mla` is built as CommonJS and
// ask-core is ESM-only, so production loads it via a true runtime import().
// jest's VM sandbox rejects native dynamic import unless launched with
// --experimental-vm-modules (which we will not force on the other 30 specs),
// so the REAL import path resolution is proven by a runtime smoke against the
// built binary, NOT by jest. These specs pin everything `mla` itself owns: the
// routing switch, the workspace echo, renderPlain, and the error messages.
// The ask-core routing/normalization is locked by ask-core's own `node --test`
// suite. cli.ts always calls runAsk(argv) (single-arg), so the seam is test-only.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-ask-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set so config.ts captures our tmp.
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

// A faithful-enough ask-core stub. makeAskModes returns four handlers that each
// echo their mode and the args they were called with, so the spec can assert
// that runAsk routes to the right handler and forwards the right callArgs
// (workspace_id, max/min). makeIntelAsk/makeMatchCanonical/statusFallback are
// recorded so we can assert runAsk wires defaultWorkspaceId + the deps through.
interface Recorder {
  intelDeps?: Record<string, unknown>;
  modeDeps?: Record<string, unknown>;
  lastHandlerArgs?: Record<string, unknown>;
  throwOn?: { mode: string; error: Error };
  // When set, the handler returns these citation rows instead of the default
  // one. Lets a spec drive renderPlain's per-citation kind/status formatting
  // with realistic ask-core rows (which always carry a docType).
  resultsOverride?: Record<string, unknown>[];
}

function makeStubCore(rec: Recorder) {
  const handler = (mode: string) => async (a: Record<string, unknown>) => {
    rec.lastHandlerArgs = a;
    if (rec.throwOn && rec.throwOn.mode === mode) throw rec.throwOn.error;
    return {
      mode,
      answer: mode === "search" || mode === "compare" ? null : "stub answer text",
      confidence: "high",
      results: rec.resultsOverride ?? [{ path: "notes/x.md", status: "SHIPPED" }],
      warnings: [`stub:${mode}`],
    };
  };
  return {
    makeIntelAsk: (deps: Record<string, unknown>) => {
      rec.intelDeps = deps;
      return { __intelAsk: true };
    },
    makeMatchCanonical: () => () => ({ matches: [], reason: "no INDEX.md match" }),
    statusFallback: () => ({ results: [], warnings: [] }),
    makeAskModes: (deps: Record<string, unknown>) => {
      rec.modeDeps = deps;
      return {
        runAnswer: handler("answer"),
        runSearch: handler("search"),
        runCanonical: handler("canonical"),
        runCompare: handler("compare"),
      };
    },
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

// Folder = workspace (T1.1): `mla ask` resolves its default workspaceId from the
// nearest `.meetless.json` marker (the `--workspace` override still short-
// circuits it). Bind ws_test at HOME and run from inside it.
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

describe("parseArgs (mla ask)", () => {
  it("requires a query", () => {
    expect(() => parseArgs([])).toThrow(/Usage: mla ask/);
  });

  it("rejects a blank query", () => {
    expect(() => parseArgs(["   "])).toThrow(/Usage: mla ask/);
  });

  it("defaults to answer mode and json output", () => {
    const a = parseArgs(["what is the privacy model"]);
    expect(a.query).toBe("what is the privacy model");
    expect(a.mode).toBe("answer");
    expect(a.json).toBe(true);
  });

  it("accepts each valid mode", () => {
    for (const m of ["answer", "search", "canonical", "compare"] as const) {
      expect(parseArgs(["q", "--mode", m]).mode).toBe(m);
    }
  });

  it("rejects an unknown mode", () => {
    expect(() => parseArgs(["q", "--mode", "bogus"])).toThrow(/Unknown mode 'bogus'/);
  });

  it("accepts --workspace and --workspace-id as aliases", () => {
    expect(parseArgs(["q", "--workspace", "ws_a"]).workspaceId).toBe("ws_a");
    expect(parseArgs(["q", "--workspace-id", "ws_b"]).workspaceId).toBe("ws_b");
  });

  it("parses --max and --min as numbers", () => {
    const a = parseArgs(["q", "--max", "12", "--min", "4"]);
    expect(a.maxResults).toBe(12);
    expect(a.minResults).toBe(4);
  });

  it("--plain flips json off; --json flips it on", () => {
    expect(parseArgs(["q", "--plain"]).json).toBe(false);
    expect(parseArgs(["q", "--plain", "--json"]).json).toBe(true);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["q", "--nope"])).toThrow(/Unknown flag for `mla ask`: --nope/);
  });

  it("rejects a second positional (unquoted query)", () => {
    expect(() => parseArgs(["hello", "world"])).toThrow(/Unexpected positional argument: world/);
  });
});

describe("mla ask: workspace resolution + echo", () => {
  it("uses the configured workspace by default and echoes it in the result", async () => {
    const rec: Recorder = {};
    const r = await run(["what is the privacy model"], rec);
    expect(r.code).toBe(0);
    // defaultWorkspaceId wired into makeAskModes, and forwarded as workspace_id.
    expect(rec.modeDeps?.defaultWorkspaceId).toBe("ws_test");
    expect(rec.lastHandlerArgs?.workspace_id).toBe("ws_test");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.workspace).toBe("ws_test");
  });

  it("--workspace overrides the configured workspace for this call", async () => {
    const rec: Recorder = {};
    const r = await run(["q", "--workspace", "ws_override"], rec);
    expect(r.code).toBe(0);
    expect(rec.modeDeps?.defaultWorkspaceId).toBe("ws_override");
    expect(rec.lastHandlerArgs?.workspace_id).toBe("ws_override");
    expect(JSON.parse(r.stdout).workspace).toBe("ws_override");
  });

  it("wires intel base URL + token into makeIntelAsk", async () => {
    const rec: Recorder = {};
    await run(["q"], rec);
    expect(rec.intelDeps?.intelBaseUrl).toBe("http://127.0.0.1:8100");
    expect(rec.intelDeps?.apiKey).toBe("ik-test");
  });
});

describe("mla ask: mode routing", () => {
  it.each([
    ["answer", []],
    ["search", ["--mode", "search"]],
    ["canonical", ["--mode", "canonical"]],
    ["compare", ["--mode", "compare"]],
  ])("routes --mode %s to the matching handler", async (mode, extra) => {
    const r = await run(["q", ...(extra as string[])]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).mode).toBe(mode);
  });

  it("forwards --max and --min into the handler args", async () => {
    const rec: Recorder = {};
    await run(["q", "--max", "12", "--min", "4"], rec);
    expect(rec.lastHandlerArgs?.maxResults).toBe(12);
    expect(rec.lastHandlerArgs?.minResults).toBe(4);
  });
});

describe("mla ask: rendering", () => {
  it("emits pretty JSON by default", async () => {
    const r = await run(["q"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.answer).toBe("stub answer text");
    expect(parsed.results[0].path).toBe("notes/x.md");
  });

  it("--plain renders the answer, citations, and a workspace/mode/confidence footer", async () => {
    const r = await run(["q", "--plain"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("stub answer text");
    expect(r.stdout).toContain("Citations (1):");
    expect(r.stdout).toContain("notes/x.md [SHIPPED]");
    expect(r.stdout).toMatch(/workspace: ws_test, mode: answer, confidence: high/);
  });

  // §7.5 (proposal 20260711). `mla ask` reads the user's GOVERNED MEMORY; `mla docs
  // ask` reads the mla MANUAL. They are two corpora that are never merged, so a
  // question about mla itself lands in `mla ask` and finds nothing to stand on. An
  // answer with zero citations is exactly that shape, and it is the only moment we
  // can help without guessing: a fixed hint on a fixed condition, not a classifier.
  it("nudges toward `mla docs ask` when the workspace memory had nothing to cite", async () => {
    const r = await run(["what does mla doctor check?"], { resultsOverride: [] });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Asking about mla itself? Try: mla docs ask "..."');
    // stderr, so a script piping `mla ask` stdout still parses clean JSON.
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it("does not nudge when the answer is grounded", async () => {
    const r = await run(["what did we decide about pricing?"]);
    expect(r.code).toBe(0);
    // The hint is help when the ask missed. On a cited answer it would be noise on
    // every single successful run.
    expect(r.stderr).not.toContain("mla docs ask");
  });

  // BUG (found dogfooding 2026-06-04): the --plain citation footer rendered
  // r.status only. ask-core defaults a retrieval row's status to "UNKNOWN"
  // (notes carry a docType but no lifecycle status), so every grounded note
  // printed a useless `[UNKNOWN]` even though the inline `[NT:...]` citation
  // already knew the kind. The footer should surface the KIND (docType, always
  // known) and append a status only when it's a real lifecycle value.
  it("surfaces the doc kind and drops an UNKNOWN status (no more [UNKNOWN])", async () => {
    const rec: Recorder = {
      resultsOverride: [
        { path: "20260526-features.md", docType: "note", status: "UNKNOWN" },
        { path: "DD-42.md", docType: "decision-diff", status: "SHIPPED" },
      ],
    };
    const r = await run(["q", "--plain"], rec);
    expect(r.code).toBe(0);
    // Kind is known (docType), so the footer surfaces it for a status-less note...
    expect(r.stdout).toContain("20260526-features.md [note]");
    // ...and never the useless [UNKNOWN] it used to print.
    expect(r.stdout).not.toContain("[UNKNOWN]");
    // A real lifecycle status is appended after the kind.
    expect(r.stdout).toContain("DD-42.md [decision-diff, SHIPPED]");
  });
});

describe("mla ask: errors", () => {
  it("returns 2 on a bad mode (parse error, before core load)", async () => {
    const r = await run(["q", "--mode", "bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Unknown mode 'bogus'/);
  });

  it("explains an unreachable intel and points at mla doctor", async () => {
    const rec: Recorder = {
      throwOn: { mode: "answer", error: new Error("fetch failed (ECONNREFUSED 127.0.0.1:8100)") },
    };
    const r = await run(["q"], rec);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not reachable/);
    expect(r.stderr).toMatch(/mla doctor/);
  });

  it("surfaces a generic intel error verbatim", async () => {
    const rec: Recorder = {
      throwOn: { mode: "answer", error: new Error("intel /v1/ask 500: boom") },
    };
    const r = await run(["q"], rec);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/mla ask failed: intel \/v1\/ask 500: boom/);
  });

  it("returns 1 when ask-core fails to load", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
    try {
      const code = await runAsk(["q"], {
        loadCore: async () => {
          throw new Error("MODULE_NOT_FOUND: ask_modes.js");
        },
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(/failed to load @meetless\/ask-core/);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
