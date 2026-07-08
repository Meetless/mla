import {
  parseTurnRecapArgs,
  runInternalTurnRecap,
  type TurnRecapCmdDeps,
} from "../../src/commands/internal-turn-recap";
import type { TurnRecap } from "../../src/lib/analytics/turn-recap";

// `mla _internal turn-recap` (Layer B): reads one (session, turn) recap and prints
// footer / block / block-context / json, or emits to Langfuse (Layer D). Fail-soft
// so it can never disturb the hook that spawns it.

function recap(over: Partial<TurnRecap> = {}): TurnRecap {
  return {
    session_id: "s1",
    turn_index: 7,
    trace_id: "a".repeat(32),
    ran: true,
    injected_floor: true,
    injected_evidence: true,
    not_run_reason: null,
    enrich_latency_ms: 412,
    evidence_offered: true,
    offered_source_ids: ["NT:a.md"],
    zero_results: false,
    coverage_gap_type: null,
    evidence_tools_pulled: ["retrieve_knowledge"],
    pull_count: 2,
    referenced_source_ids: ["NT:a.md"],
    cited_source_ids: [],
    verdict: "USED",
    ...over,
  };
}

function run(argv: string[], deps: TurnRecapCmdDeps = {}) {
  const out: string[] = [];
  const merged: TurnRecapCmdDeps = { log: (l) => out.push(l), ...deps };
  return runInternalTurnRecap(argv, merged).then((code) => ({ code, out: out.join("\n") }));
}

describe("parseTurnRecapArgs", () => {
  it("defaults to footer, no json, no emit", () => {
    expect(parseTurnRecapArgs([])).toEqual({
      session: null,
      turn: null,
      style: "footer",
      json: false,
      emitLangfuse: false,
    });
  });

  it("parses session, turn, style, json, emit-langfuse", () => {
    expect(
      parseTurnRecapArgs(["--session", "sX", "--turn", "9", "--style", "block-context", "--json", "--emit-langfuse"]),
    ).toEqual({ session: "sX", turn: 9, style: "block-context", json: true, emitLangfuse: true });
  });

  it.each(["0", "-1", "x", "1.5", ""])("rejects a bad --turn %s", (v) => {
    expect(() => parseTurnRecapArgs(["--turn", v])).toThrow(/positive integer/);
  });

  it("rejects an unknown --style", () => {
    expect(() => parseTurnRecapArgs(["--style", "nope"])).toThrow(/--style must be/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseTurnRecapArgs(["--bogus"])).toThrow(/Unknown flag/);
  });
});

describe("runInternalTurnRecap: render styles", () => {
  it("default style prints the footer line", async () => {
    const r = await run(["--session", "s1", "--turn", "7"], { compute: () => recap() });
    expect(r.code).toBe(0);
    expect(r.out).toBe("🔎 mla · turn 7 · evidence injected (1 src, 412ms) · pulled retrieve_knowledge ×2 · cited 0 · USED");
  });

  it("--style block-context wraps the footer for injection", async () => {
    const r = await run(["--session", "s1", "--turn", "7", "--style", "block-context"], { compute: () => recap() });
    expect(r.out).toContain('<meetless-context kind="turn-recap" for-turn="7">');
    expect(r.out).toContain("</meetless-context>");
  });

  it("--style block expands the full recap", async () => {
    const r = await run(["--session", "s1", "--turn", "7", "--style", "block"], { compute: () => recap() });
    expect(r.out).toMatch(/turn 7 recap/);
    expect(r.out).toMatch(/verdict:\s+USED/);
  });

  it("--json emits the full TurnRecap object", async () => {
    const r = await run(["--session", "s1", "--turn", "7", "--json"], { compute: () => recap() });
    const obj = JSON.parse(r.out);
    expect(obj.verdict).toBe("USED");
    expect(obj.trace_id).toBe("a".repeat(32));
  });
});

describe("runInternalTurnRecap: fail-soft + graceful empties", () => {
  it("a strict argv error exits 2", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(["--bogus"]);
    expect(r.code).toBe(2);
    errSpy.mockRestore();
  });

  it("missing session and turn -> exit 0, no output", async () => {
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const r = await run([], { compute: () => recap() });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    if (prev !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prev;
  });

  it("block-context for a truly-absent turn injects nothing", async () => {
    const r = await run(["--session", "s1", "--turn", "99", "--style", "block-context"], {
      compute: () => recap({ ran: false, injected_floor: false, not_run_reason: null, verdict: "NOT_RUN", trace_id: null }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("block-context still surfaces a KNOWN not-run reason (suppressed)", async () => {
    const r = await run(["--session", "s1", "--turn", "10", "--style", "block-context"], {
      compute: () => recap({ ran: true, injected_floor: false, not_run_reason: "suppressed", verdict: "NOT_RUN", trace_id: "b".repeat(32) }),
    });
    expect(r.out).toContain("NOT_RUN");
    expect(r.out).toContain('kind="turn-recap"');
  });

  it("footer style ALWAYS renders even a truly-absent turn (explicit read)", async () => {
    const r = await run(["--session", "s1", "--turn", "11", "--style", "footer"], {
      compute: () => recap({ turn_index: 11, ran: false, injected_floor: false, not_run_reason: "not_activated", verdict: "NOT_RUN", trace_id: null }),
    });
    expect(r.out).toBe("🔎 mla · turn 11 · not activated for this repo · NOT_RUN");
  });

  it("a compute that throws never escapes (exit 0)", async () => {
    const r = await run(["--session", "s1", "--turn", "7"], {
      compute: () => {
        throw new Error("boom");
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});

describe("runInternalTurnRecap: --emit-langfuse (Layer D seam)", () => {
  it("posts the recap when a trace_id is present and an emitter is wired", async () => {
    const posted: TurnRecap[] = [];
    const r = await run(["--session", "s1", "--turn", "7", "--emit-langfuse"], {
      compute: () => recap(),
      readCfg: () => ({}) as never,
      postTurnRecap: async (_cfg, rec) => {
        posted.push(rec);
      },
    });
    expect(r.code).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0].verdict).toBe("USED");
  });

  it("is a no-op when the turn has no trace_id (nothing to score)", async () => {
    const posted: TurnRecap[] = [];
    await run(["--session", "s1", "--turn", "7", "--emit-langfuse"], {
      compute: () => recap({ trace_id: null }),
      readCfg: () => ({}) as never,
      postTurnRecap: async (_cfg, rec) => {
        posted.push(rec);
      },
    });
    expect(posted).toHaveLength(0);
  });

  it("a posting failure never escapes (exit 0)", async () => {
    const r = await run(["--session", "s1", "--turn", "7", "--emit-langfuse"], {
      compute: () => recap(),
      readCfg: () => ({}) as never,
      postTurnRecap: async () => {
        throw new Error("intel down");
      },
    });
    expect(r.code).toBe(0);
  });
});
