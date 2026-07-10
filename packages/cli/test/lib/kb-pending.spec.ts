import {
  parseKbPendingArgs,
  buildPendingView,
  renderPendingHuman,
  renderPendingJson,
  runKbPendingWith,
  fetchAllPending,
  KbPendingDeps,
} from "../../src/commands/kb_pending";
import { RelationshipCandidate } from "../../src/lib/kb-candidate";
import { SessionScopeError } from "../../src/lib/session-scope";

// Behavioral lock for B5 (`mla kb review` list mode / deprecated `mla kb pending`
// alias, the agent-proxy review queue) from
// notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 (B5) and the scope
// overhaul in notes/20260607-mla-kb-pending-session-scope-and-bulk-discard-plan.md:
//
//   "list PENDING_REVIEW candidates (default current session / --all / --session /
//    --doc), structured for the agent. Reuse the remember-digest 'needs your
//    decision' rendering for the human-readable view."
//
// These are agent-facing: the JSON view is structured for an automated proxy and
// annotated with the mechanical-validity verdict (so the agent knows which
// candidates it may auto-reject); the human view is a digest plus the Console URL,
// never an in-terminal relationship graph.

function cand(over: Partial<RelationshipCandidate> = {}): RelationshipCandidate {
  return {
    id: "c" + "a".repeat(24),
    workspaceId: "ws_test",
    relationTypeId: "DEPENDS_ON",
    statusId: "PENDING_REVIEW",
    reviewModeId: "SEMANTIC_REVIEW",
    promotionStatusId: "NONE",
    postureId: "LIVE",
    sourceType: "NOTE",
    sourceArtifactId: "note:a.md",
    targetType: "NOTE",
    targetArtifactId: "note:b.md",
    confidence: 0.82,
    detectorFamily: "semantic.m3b",
    detectorVersion: "semantic.m3b@1",
    evidenceJson: { sourceQuote: "alpha", targetQuote: "beta", reasoning: "because" },
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...over,
  };
}

describe("mla kb review (list mode): arg parsing", () => {
  it("defaults to the default scope (current session if available, else workspace)", () => {
    expect(parseKbPendingArgs([])).toEqual({ scope: { kind: "default" }, json: false });
  });

  it("parses --json", () => {
    expect(parseKbPendingArgs(["--json"])).toEqual({ scope: { kind: "default" }, json: true });
  });

  it("parses --doc with a value", () => {
    expect(parseKbPendingArgs(["--doc", "note:a.md"])).toEqual({ scope: { kind: "doc", doc: "note:a.md" }, json: false });
  });

  it("rejects --doc with no value", () => {
    expect(() => parseKbPendingArgs(["--doc"])).toThrow(/--doc requires a value/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseKbPendingArgs(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("rejects a positional argument", () => {
    expect(() => parseKbPendingArgs(["c123"])).toThrow(/no positional/i);
  });
});

describe("parseKbPendingArgs scope", () => {
  it("no flag => default scope", () => {
    expect(parseKbPendingArgs([])).toEqual({ scope: { kind: "default" }, json: false });
  });
  it("--all => workspace scope", () => {
    expect(parseKbPendingArgs(["--all"])).toEqual({ scope: { kind: "workspace" }, json: false });
  });
  it("--session current => session scope", () => {
    expect(parseKbPendingArgs(["--session", "current"])).toEqual({ scope: { kind: "session", value: "current" }, json: false });
  });
  it("--doc => doc scope", () => {
    expect(parseKbPendingArgs(["--doc", "foo.md", "--json"])).toEqual({ scope: { kind: "doc", doc: "foo.md" }, json: true });
  });
  it("--session requires a value", () => {
    expect(() => parseKbPendingArgs(["--session"])).toThrow("--session requires a value");
  });
  it("scope flags are mutually exclusive", () => {
    expect(() => parseKbPendingArgs(["--all", "--doc", "y"])).toThrow(/at most one/i);
    expect(() => parseKbPendingArgs(["--session", "x", "--doc", "y"])).toThrow(/at most one/i);
  });
  it("a leading verdict flag yields a targeted 'id first' error", () => {
    expect(() => parseKbPendingArgs(["--reject"])).toThrow(/candidate id first/i);
    expect(() => parseKbPendingArgs(["--accept"])).toThrow(/candidate id first/i);
  });
});

describe("mla kb review (list mode): rendering", () => {
  const base = "https://console.example.test";

  function view(
    items: RelationshipCandidate[],
    over: { truncated?: boolean; scopeNote?: string | null } = {},
  ) {
    const truncated = over.truncated ?? false;
    return buildPendingView(items, {
      workspaceId: "ws_test",
      consoleBase: base,
      truncated,
      scope: { kind: "workspace", fetchedCount: items.length, displayedCount: items.length, truncated },
      scopeNote: over.scopeNote ?? null,
    });
  }

  it("JSON view annotates each candidate with its mechanical-validity verdict and a console URL", () => {
    const json = JSON.parse(
      renderPendingJson(
        view([
          cand(),
          cand({ id: "c" + "b".repeat(24), sourceArtifactId: "note:x.md", targetArtifactId: "note:x.md" }),
        ]),
      ),
    );
    expect(json.workspaceId).toBe("ws_test");
    expect(json.count).toBe(2);
    expect(json.candidates[0].autoRejectable).toBe(false);
    expect(json.candidates[1].autoRejectable).toBe(true);
    expect(json.candidates[1].autoRejectReasonCode).toBe("self_edge");
    expect(json.candidates[0].consoleUrl).toBe(
      `${base}/open?workspaceId=ws_test&to=%2Frelationships%2F${cand().id}`,
    );
  });

  it("human view reuses the 'needs your decision' digest and shows the console URL", () => {
    const text = renderPendingHuman(view([cand()]));
    expect(text).toMatch(/needs your decision/i);
    expect(text).toContain("DEPENDS_ON");
    expect(text).toContain("note:a.md");
    expect(text).toContain(
      `${base}/open?workspaceId=ws_test&to=%2Frelationships%2F${cand().id}`,
    );
  });

  it("human view reports an empty queue plainly", () => {
    expect(renderPendingHuman(view([]))).toMatch(/no relationship candidates/i);
  });

  it("human view flags a self-edge candidate as auto-rejectable", () => {
    const text = renderPendingHuman(view([cand({ sourceArtifactId: "note:x.md", targetArtifactId: "note:x.md" })]));
    expect(text).toMatch(/auto-rejectable|self_edge/i);
  });

  it("does not silently truncate: a capped queue is disclosed", () => {
    expect(renderPendingHuman(view([cand()], { truncated: true }))).toMatch(/more|narrow|--doc/i);
  });

  // A-0 (A4 surface 1): the CLI caller is UNKNOWN (a human and an agent run the
  // identical command), so the human-readable output must dual-address both in
  // ONE block, gated on pending count > 0.
  it("human view dual-addresses both the user and the agent in one block", () => {
    const text = renderPendingHuman(view([cand()]));
    expect(text).toMatch(/if you are the user/i);
    expect(text).toMatch(/if you are the agent/i);
    // The governed-change framing + propose-first UX default must be stated.
    expect(text).toMatch(/governed change made under the\s+user's authority/i);
    expect(text).toMatch(/propose it and let the user confirm/i);
  });

  it("human view omits the dual-audience block when the queue is empty", () => {
    const text = renderPendingHuman(view([]));
    expect(text).not.toMatch(/if you are the agent/i);
  });

  // A-0 (A4 surface 3): `--json` is reliably agent-consumed, so it carries a
  // structured action vocabulary rather than forcing the agent to parse prose.
  it("JSON view carries per-candidate agentActions that separate proposable from governed verbs", () => {
    const json = JSON.parse(renderPendingJson(view([cand()])));
    const actions = json.candidates[0].agentActions;
    expect(actions.allowed).toContain("propose_correction");
    expect(actions.allowed).not.toContain("accept");
    expect(actions.userConfirm).toContain("accept");
    expect(actions.userConfirm).toContain("apply_correction");
  });

  it("JSON view lets the agent auto-reject ONLY mechanically-invalid candidates", () => {
    const json = JSON.parse(
      renderPendingJson(
        view([
          cand(),
          cand({ id: "c" + "b".repeat(24), sourceArtifactId: "note:x.md", targetArtifactId: "note:x.md" }),
        ]),
      ),
    );
    expect(json.candidates[0].agentActions.allowed).not.toContain("auto_reject_mechanical_only");
    expect(json.candidates[1].agentActions.allowed).toContain("auto_reject_mechanical_only");
  });

  it("JSON view carries a top-level governance summary mirroring the hook compact form", () => {
    const json = JSON.parse(renderPendingJson(view([cand(), cand({ id: "c" + "b".repeat(24) })])));
    expect(json.governance.pendingCount).toBe(2);
    expect(json.governance.allowedAgentActions).toContain("triage");
    expect(json.governance.userConfirmActions).toContain("apply_correction");
  });
});

describe("renderPendingJson scope", () => {
  it("emits a structured session scope object", () => {
    const view = buildPendingView([], {
      workspaceId: "ws1", consoleBase: "https://c.test", truncated: false,
      scope: { kind: "session", sessionId: "S", source: "current-env", sessionDocCount: 1, fetchedCount: 2, displayedCount: 0, truncated: false },
      scopeNote: null,
    });
    expect(JSON.parse(renderPendingJson(view)).scope).toEqual({
      kind: "session", sessionId: "S", source: "current-env",
      sessionDocCount: 1, fetchedCount: 2, displayedCount: 0, truncated: false,
    });
  });

  it("a doc scope names the doc it was applied to", () => {
    const view = buildPendingView([], {
      workspaceId: "ws1", consoleBase: "https://c.test", truncated: false,
      scope: { kind: "doc", doc: "foo.md", fetchedCount: 1, displayedCount: 1, truncated: false },
      scopeNote: null,
    });
    expect(JSON.parse(renderPendingJson(view)).scope).toEqual({
      kind: "doc", doc: "foo.md", fetchedCount: 1, displayedCount: 1, truncated: false,
    });
  });
});

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await run();
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

// env: {} forces the "default" scope to fall back to the full workspace queue (no
// $CLAUDE_CODE_SESSION_ID), so these end-to-end tests are not coupled to whether
// the test runner itself happens to run inside a Claude Code session.
const CTX = { workspaceId: "ws_test", consoleBase: "https://console.example.test", env: {} };

describe("runKbPendingWith: end-to-end wiring", () => {
  it("fetches with a PENDING_REVIEW + LIVE query and renders the human digest", async () => {
    let seenQs = "";
    const deps: KbPendingDeps = {
      fetchPending: async (qs) => {
        seenQs = qs;
        return { items: [cand()], nextCursor: null };
      },
    };
    const res = await capture(() => runKbPendingWith([], CTX, deps));
    expect(res.code).toBe(0);
    expect(seenQs).toContain("statusId=PENDING_REVIEW");
    expect(res.stdout).toMatch(/needs your decision/i);
  });

  it("emits machine JSON under --json", async () => {
    const deps: KbPendingDeps = {
      fetchPending: async () => ({ items: [cand()], nextCursor: null }),
    };
    const res = await capture(() => runKbPendingWith(["--json"], CTX, deps));
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.count).toBe(1);
  });

  it("scopes the query when --doc is given", async () => {
    let seenQs = "";
    const deps: KbPendingDeps = {
      fetchPending: async (qs) => {
        seenQs = qs;
        return { items: [], nextCursor: null };
      },
    };
    const res = await capture(() => runKbPendingWith(["--doc", "note:a.md"], CTX, deps));
    expect(res.code).toBe(0);
    expect(seenQs).toContain("artifactId=note%3Aa.md");
    expect(res.stdout).toMatch(/no relationship candidates/i);
  });

  it("returns 2 on a bad flag", async () => {
    const deps: KbPendingDeps = { fetchPending: async () => ({ items: [], nextCursor: null }) };
    const res = await capture(() => runKbPendingWith(["--nope"], CTX, deps));
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/Unknown flag/);
  });

  // A-0c (A4 surface 2, Patch 8): the listing runner is the out-of-band writer of
  // the local pending-count cache the prompt-submit hook reads with ZERO network
  // call. The count it reports is the WORKSPACE-WIDE total, and ONLY when the query
  // is workspace-wide -- a --doc-scoped run is a partial count and must not clobber
  // the workspace-wide cache.
  it("reports the workspace-wide pending count to onWorkspaceCount for the hook cache", async () => {
    const counts: number[] = [];
    const deps: KbPendingDeps = {
      fetchPending: async () => ({
        items: [cand(), cand({ id: "c" + "b".repeat(24) }), cand({ id: "c" + "c".repeat(24) })],
        nextCursor: null,
      }),
    };
    const res = await capture(() =>
      runKbPendingWith(["--all"], { ...CTX, onWorkspaceCount: (n) => counts.push(n) }, deps),
    );
    expect(res.code).toBe(0);
    expect(counts).toEqual([3]);
  });

  it("reports a zero count so the hook can clear a stale nudge", async () => {
    const counts: number[] = [];
    const deps: KbPendingDeps = { fetchPending: async () => ({ items: [], nextCursor: null }) };
    await capture(() => runKbPendingWith(["--all"], { ...CTX, onWorkspaceCount: (n) => counts.push(n) }, deps));
    expect(counts).toEqual([0]);
  });

  it("does NOT report a doc-scoped count to onWorkspaceCount (partial count must not clobber the cache)", async () => {
    const counts: number[] = [];
    const deps: KbPendingDeps = { fetchPending: async () => ({ items: [cand()], nextCursor: null }) };
    await capture(() =>
      runKbPendingWith(["--doc", "note:a.md"], { ...CTX, onWorkspaceCount: (n) => counts.push(n) }, deps),
    );
    expect(counts).toEqual([]);
  });
});

describe("runKbPendingWith scope behavior", () => {
  const ctxBase = (over: any = {}) => ({ workspaceId: "ws1", consoleBase: "https://c.test", env: {}, ...over });

  it("default WITH a session filters to it and caches the FULL paginated workspace count", async () => {
    const inScope = cand({ id: "in1", sourceArtifactId: "note:s.md", targetArtifactId: "note:old.md" });
    const outScope = cand({ id: "out1", sourceArtifactId: "note:zzz.md", targetArtifactId: "note:old.md" });
    let cachedCount = -1;
    const logs: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((m) => { logs.push(String(m)); });

    const code = await runKbPendingWith(
      [],
      ctxBase({ env: { CLAUDE_CODE_SESSION_ID: "S" }, onWorkspaceCount: (n: number) => { cachedCount = n; } }),
      {
        fetchPending: async () => ({ items: [inScope, outScope], nextCursor: null }),
        loadSessionScope: () => ({ sessionId: "S", source: "current-env", keys: new Set(["s.md"]) }),
      },
    );

    spy.mockRestore();
    expect(code).toBe(0);
    expect(cachedCount).toBe(2);
    const out = logs.join("\n");
    expect(out).toContain("in1");
    expect(out).not.toContain("out1");
    expect(out).toMatch(/current session/);
  });

  it("paginates via nextCursor before filtering and caching", async () => {
    const p1 = cand({ id: "p1", sourceArtifactId: "note:s.md" });
    const p2 = cand({ id: "p2", sourceArtifactId: "note:s.md" });
    let calls = 0;
    let cachedCount = -1;
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await runKbPendingWith(
      ["--all"],
      ctxBase({ onWorkspaceCount: (n: number) => { cachedCount = n; } }),
      {
        fetchPending: async (qs) => {
          calls++;
          return new URLSearchParams(qs).has("cursorId")
            ? { items: [p2], nextCursor: null }
            : { items: [p1], nextCursor: { id: "p1", createdAt: "2026-06-07T00:00:00.000Z" } };
        },
      },
    );
    spy.mockRestore();
    expect(calls).toBe(2);
    expect(cachedCount).toBe(2);
  });

  it("default WITHOUT a session falls back to the full workspace queue (no session resolution)", async () => {
    let cachedCount = -1;
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    const code = await runKbPendingWith(
      [],
      ctxBase({ env: {}, onWorkspaceCount: (n: number) => { cachedCount = n; } }),
      {
        fetchPending: async () => ({ items: [cand({ id: "a" }), cand({ id: "b" })], nextCursor: null }),
        loadSessionScope: () => { throw new Error("must not resolve a session without one"); },
      },
    );
    spy.mockRestore();
    expect(code).toBe(0);
    expect(cachedCount).toBe(2);
  });

  it("--doc does NOT write the workspace cache (it is a subset)", async () => {
    let cached = false;
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await runKbPendingWith(
      ["--doc", "foo.md"],
      ctxBase({ onWorkspaceCount: () => { cached = true; } }),
      { fetchPending: async () => ({ items: [cand({ id: "x" })], nextCursor: null }) },
    );
    spy.mockRestore();
    expect(cached).toBe(false);
  });

  it("passes the runner env into session resolution", async () => {
    let seenEnv: any = null;
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await runKbPendingWith(
      ["--session", "current"],
      ctxBase({ env: { CLAUDE_CODE_SESSION_ID: "S" } }),
      {
        fetchPending: async () => ({ items: [], nextCursor: null }),
        loadSessionScope: (_v, opts) => { seenEnv = opts.env; return { sessionId: "S", source: "current-env", keys: new Set() }; },
      },
    );
    spy.mockRestore();
    expect(seenEnv).toEqual({ CLAUDE_CODE_SESSION_ID: "S" });
  });

  it("returns 2 with the error message when an explicit --session can't resolve", async () => {
    const errs: string[] = [];
    const spy = jest.spyOn(console, "error").mockImplementation((m) => { errs.push(String(m)); });
    const code = await runKbPendingWith(
      ["--session", "current"],
      ctxBase(),
      {
        fetchPending: async () => ({ items: [], nextCursor: null }),
        loadSessionScope: () => { throw new SessionScopeError("boom"); },
      },
    );
    spy.mockRestore();
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("boom");
  });

  it("does NOT write an exact workspace cache when pagination hits the cap (count would be a floor, not the truth)", async () => {
    let cacheCalls = 0;
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await runKbPendingWith(
      ["--all"],
      ctxBase({ onWorkspaceCount: () => { cacheCalls++; } }),
      {
        // Always returns a nextCursor, so fetchAllPending stops at MAX_PAGES with truncated=true.
        fetchPending: async () => ({ items: [cand({ id: "x" })], nextCursor: { id: "x", createdAt: "2026-06-07T00:00:00.000Z" } }),
      },
    );
    spy.mockRestore();
    expect(cacheCalls).toBe(0);
  });
});

// fetchAllPending is exported from kb_pending for this test (see import at top).
describe("fetchAllPending malformed cursor", () => {
  it("throws a loud error on a cursor missing id/createdAt", async () => {
    await expect(
      fetchAllPending(
        async () => ({ items: [], nextCursor: { id: "" } as unknown }),
        "ws1",
        null,
      ),
    ).rejects.toThrow(/Malformed.*cursor/i);
  });

  it("throws on a cursor with an unparseable date", async () => {
    await expect(
      fetchAllPending(
        async () => ({ items: [], nextCursor: { id: "c1", createdAt: "not-a-date" } as unknown }),
        "ws1",
        null,
      ),
    ).rejects.toThrow(/Malformed.*cursor/i);
  });
});
