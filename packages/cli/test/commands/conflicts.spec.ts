// Behavioral spec for `mla conflicts`. Two layers:
//   1. Pure render (describeSide / renderConflict): exact rendered copy across the
//      two D1 conflict shapes (session-vs-approved, session-vs-session), the
//      current-session flag, and a missing statement. Guards the AI-smell dashes.
//   2. runConflicts orchestration with injected deps: mode resolution (default
//      session, --global, --session), empty states, --json mirror, the mutual
//      -exclusion and missing-session errors, and HTTP error mapping.

import {
  describeSide,
  describeResolveResult,
  parseConflictsArgs,
  renderConflict,
  runConflicts,
  type ConflictSideView,
  type WorkspaceConflictView,
  type ConflictsResponse,
  type ConflictsDeps,
  type D1ConflictOutcome,
  type ResolveConflictResult,
} from "../../src/commands/conflicts";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import { SessionScopeError } from "../../src/lib/session-scope";
import type { HttpError } from "../../src/lib/http";

// HttpError is an interface (fetch-level failures reject with no status, HTTP
// non-2xx set it), so build a plain Error that satisfies it.
function httpError(message: string, status?: number): HttpError {
  const e = new Error(message) as HttpError;
  if (status !== undefined) e.status = status;
  e.body = "";
  return e;
}

const CFG: WorkspaceCliConfig = {
  controlUrl: "http://127.0.0.1:3006",
  controlToken: "t",
  mlaPath: "/tmp/mla",
  consoleUrl: "https://console.test",
  workspaceId: "ws_test",
  auth: { mode: "none" },
};

function sessionSide(over: Partial<ConflictSideView>): ConflictSideView {
  return {
    role: "SUBJECT",
    refType: "SESSION",
    refId: "run-aaaaaaaa",
    sessionId: "sess-1111",
    isCurrentSession: false,
    statement: null,
    artifactId: null,
    ...over,
  };
}

function approvedSide(over: Partial<ConflictSideView>): ConflictSideView {
  return {
    role: "COUNTERPARTY",
    refType: "APPROVED_KNOWLEDGE",
    refId: "art-bbbbbbbb",
    sessionId: null,
    isCurrentSession: false,
    statement: null,
    artifactId: "DD:approved-xyz",
    ...over,
  };
}

// No em dash, no double-hyphen-as-punctuation in anything we render.
function assertNoSmellDashes(text: string): void {
  expect(text).not.toMatch(/—/);
  expect(text).not.toMatch(/ -- /);
}

describe("describeSide", () => {
  it("SESSION current: names the session and flags it as this session", () => {
    expect(
      describeSide(sessionSide({ sessionId: "sess-cur", isCurrentSession: true })),
    ).toBe("session sess-cur (this session)");
  });

  it("SESSION not current: names the session without the flag", () => {
    expect(
      describeSide(sessionSide({ sessionId: "sess-other", isCurrentSession: false })),
    ).toBe("session sess-other");
  });

  it("SESSION with an unresolved session falls back to the short run id", () => {
    expect(
      describeSide(sessionSide({ sessionId: null, refId: "run-1234567890" })),
    ).toBe("session run ...34567890");
  });

  it("APPROVED_KNOWLEDGE names the approved artifact", () => {
    expect(describeSide(approvedSide({ artifactId: "DD:approved-xyz" }))).toBe(
      "approved knowledge DD:approved-xyz",
    );
  });

  it("APPROVED_KNOWLEDGE falls back to the ref id when no artifact id", () => {
    expect(
      describeSide(approvedSide({ artifactId: null, refId: "art-fallback" })),
    ).toBe("approved knowledge art-fallback");
  });
});

describe("renderConflict", () => {
  const approvedConflict: WorkspaceConflictView = {
    caseId: "c00-approved-1234abcd",
    kindId: "contradiction",
    status: "NEW_SIGNAL",
    openedAt: "2026-07-04T19:50:00.000Z",
    reason: "This session's capture contradicts approved knowledge (DD:approved-xyz).",
    sides: [
      sessionSide({
        role: "SUBJECT",
        sessionId: "sess-cur",
        isCurrentSession: true,
        statement: "We ship in Q2.",
      }),
      approvedSide({ role: "COUNTERPARTY", statement: "We slip to Q3." }),
    ],
  };

  it("renders a session-vs-approved conflict as exact, aligned copy", () => {
    const out = renderConflict(approvedConflict, 1);
    expect(out).toBe(
      [
        "1. [...1234abcd] contradiction  (2026-07-04 19:50:00Z)  status NEW_SIGNAL",
        "   why:  This session's capture contradicts approved knowledge (DD:approved-xyz).",
        "   subject:       session sess-cur (this session)",
        '                  "We ship in Q2."',
        "   counterparty:  approved knowledge DD:approved-xyz",
        '                  "We slip to Q3."',
        "   id:   c00-approved-1234abcd",
      ].join("\n"),
    );
    assertNoSmellDashes(out);
  });

  it("renders a session-vs-session conflict with both SESSION sides", () => {
    const conflict: WorkspaceConflictView = {
      caseId: "c00-svs-90abcdef",
      kindId: "contradiction",
      status: "NEW_SIGNAL",
      openedAt: "2026-07-04T20:00:00.000Z",
      reason: "This session's capture contradicts another live session.",
      sides: [
        sessionSide({ role: "SUBJECT", sessionId: "sess-A", isCurrentSession: true }),
        sessionSide({
          role: "COUNTERPARTY",
          refId: "run-cccccccc",
          sessionId: "sess-B",
        }),
      ],
    };
    const out = renderConflict(conflict, 2);
    expect(out).toBe(
      [
        "2. [...90abcdef] contradiction  (2026-07-04 20:00:00Z)  status NEW_SIGNAL",
        "   why:  This session's capture contradicts another live session.",
        "   subject:       session sess-A (this session)",
        "   counterparty:  session sess-B",
        "   id:   c00-svs-90abcdef",
      ].join("\n"),
    );
    assertNoSmellDashes(out);
  });

  it("omits the statement line for a side with no captured statement", () => {
    const conflict: WorkspaceConflictView = {
      ...approvedConflict,
      sides: [
        sessionSide({ role: "SUBJECT", sessionId: "sess-cur", isCurrentSession: true }),
        approvedSide({ role: "COUNTERPARTY", statement: null }),
      ],
    };
    const out = renderConflict(conflict, 1);
    expect(out).not.toContain('"');
    expect(out.split("\n")).toEqual([
      "1. [...1234abcd] contradiction  (2026-07-04 19:50:00Z)  status NEW_SIGNAL",
      "   why:  This session's capture contradicts approved knowledge (DD:approved-xyz).",
      "   subject:       session sess-cur (this session)",
      "   counterparty:  approved knowledge DD:approved-xyz",
      "   id:   c00-approved-1234abcd",
    ]);
  });
});

// --- runConflicts orchestration ---

interface Harness {
  out: string[];
  err: string[];
  resolveCalls: Array<{ value: string; workspaceId: string }>;
  fetchCalls: Array<{ sessionId?: string; adapter?: string }>;
  // The write plane: every (caseId, outcome, rationale, workspaceId) the command
  // forwarded to the resolve endpoint. workspaceId proves the body is scoped from
  // cfg, not the argv.
  resolveConflictCalls: Array<{
    caseId: string;
    outcome: D1ConflictOutcome;
    rationale: string;
    workspaceId: string;
  }>;
}

function harness(
  response: ConflictsResponse,
  over: Partial<ConflictsDeps> = {},
): { deps: ConflictsDeps; h: Harness } {
  const h: Harness = {
    out: [],
    err: [],
    resolveCalls: [],
    fetchCalls: [],
    resolveConflictCalls: [],
  };
  const deps: ConflictsDeps = {
    loadConfig: () => CFG,
    resolveSession: (value, workspaceId) => {
      h.resolveCalls.push({ value, workspaceId });
      return { sessionId: "sess-current" };
    },
    fetchConflicts: async (_cfg, params) => {
      h.fetchCalls.push(params);
      return response;
    },
    // Default write seam: record the call and echo the verdict back as the server
    // would (resolution unused by the CLI copy; linkedCaseId defaults null, the
    // REJECT_BOTH-escalated case is set per-test via `over`).
    resolveConflict: async (cfg, caseId, outcome, rationale) => {
      h.resolveConflictCalls.push({
        caseId,
        outcome,
        rationale,
        workspaceId: cfg.workspaceId,
      });
      return { caseId, outcome, resolution: "", linkedCaseId: null };
    },
    out: (l) => h.out.push(l),
    err: (l) => h.err.push(l),
    ...over,
  };
  return { deps, h };
}

// The resolve/dismiss verbs never fetch or list, so their tests do not care about
// the read response. A tiny empty-workspace payload keeps the harness signature
// satisfied without implying a fetch happened.
const NO_READ: ConflictsResponse = {
  workspaceId: "ws_test",
  sessionId: null,
  global: true,
  conflicts: [],
};

const oneApprovedConflict: WorkspaceConflictView = {
  caseId: "c00-1234abcd",
  kindId: "contradiction",
  status: "NEW_SIGNAL",
  openedAt: "2026-07-04T19:50:00.000Z",
  reason: "This session contradicts approved knowledge.",
  sides: [
    sessionSide({ role: "SUBJECT", sessionId: "sess-current", isCurrentSession: true }),
    approvedSide({ role: "COUNTERPARTY" }),
  ],
};

describe("runConflicts", () => {
  it("default mode resolves the current session and scopes the fetch to it", async () => {
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: "sess-current",
      global: false,
      conflicts: [oneApprovedConflict],
    });

    const code = await runConflicts([], deps);

    expect(code).toBe(0);
    expect(h.resolveCalls).toEqual([{ value: "current", workspaceId: "ws_test" }]);
    expect(h.fetchCalls).toEqual([{ sessionId: "sess-current", adapter: undefined }]);
    expect(h.out[0]).toBe(
      "1 open conflict(s) involving this session (sess-current):",
    );
    // The closing hint now teaches the terminal resolve verbs AND deep-links the
    // console for full evidence.
    const joined = h.out.join("\n");
    expect(joined).toContain("mla conflicts resolve <id>");
    expect(joined).toContain("dismiss <id> --rationale <text>");
    expect(joined).toContain(
      "Full evidence + resolve in the console: https://console.test/conflicts",
    );
    assertNoSmellDashes(joined);
  });

  it("--global skips session resolution and fetches workspace-wide", async () => {
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: null,
      global: true,
      conflicts: [oneApprovedConflict],
    });

    const code = await runConflicts(["--global"], deps);

    expect(code).toBe(0);
    expect(h.resolveCalls).toEqual([]);
    expect(h.fetchCalls).toEqual([{ sessionId: undefined, adapter: undefined }]);
    expect(h.out[0]).toBe("1 open cross-session conflict(s) in this workspace:");
  });

  it("--session <sid> resolves that explicit session value", async () => {
    // The default harness resolveSession records the value it was handed; the
    // command must forward the literal sid, not "current".
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: "sess-x",
      global: false,
      conflicts: [],
    });
    const code = await runConflicts(["--session", "sess-x"], deps);
    expect(code).toBe(0);
    expect(h.resolveCalls).toEqual([{ value: "sess-x", workspaceId: "ws_test" }]);
  });

  it("--adapter narrows the fetch", async () => {
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: "sess-current",
      global: false,
      conflicts: [],
    });
    await runConflicts(["--adapter", "cursor"], deps);
    expect(h.fetchCalls).toEqual([{ sessionId: "sess-current", adapter: "cursor" }]);
  });

  it("--json prints the raw response and skips the human header", async () => {
    const response: ConflictsResponse = {
      workspaceId: "ws_test",
      sessionId: "sess-current",
      global: false,
      conflicts: [oneApprovedConflict],
    };
    const { deps, h } = harness(response);
    const code = await runConflicts(["--json"], deps);
    expect(code).toBe(0);
    expect(h.out).toEqual([JSON.stringify(response, null, 2)]);
    expect(h.out.join("\n")).not.toContain("open conflict(s)");
  });

  it("empty session mode points at --global and the queue", async () => {
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: "sess-current",
      global: false,
      conflicts: [],
    });
    const code = await runConflicts([], deps);
    expect(code).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toBe(
      "No open conflicts involving this session (sess-current). " +
        "See the whole workspace with `mla conflicts --global`, or open " +
        "https://console.test/conflicts.",
    );
  });

  it("empty global mode reports a clean workspace", async () => {
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: null,
      global: true,
      conflicts: [],
    });
    const code = await runConflicts(["--global"], deps);
    expect(code).toBe(0);
    expect(h.out).toEqual([
      "No open cross-session conflicts in this workspace. Queue: https://console.test/conflicts",
    ]);
  });

  it("rejects --global and --session together", async () => {
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: null,
      global: true,
      conflicts: [],
    });
    const code = await runConflicts(["--global", "--session", "s1"], deps);
    expect(code).toBe(2);
    expect(h.err).toEqual(["Pass either --global or --session, not both."]);
    expect(h.fetchCalls).toEqual([]);
  });

  it("rejects an unknown flag", async () => {
    const { deps, h } = harness({
      workspaceId: "ws_test",
      sessionId: null,
      global: false,
      conflicts: [],
    });
    const code = await runConflicts(["--nope"], deps);
    expect(code).toBe(2);
    expect(h.err).toEqual(["Unknown flag: --nope"]);
  });

  it("a missing current session errors with a --global hint, not a silent widen", async () => {
    const { deps, h } = harness(
      { workspaceId: "ws_test", sessionId: null, global: false, conflicts: [] },
      {
        resolveSession: () => {
          throw new SessionScopeError("--session current needs $CLAUDE_CODE_SESSION_ID, which is not set.");
        },
      },
    );
    const code = await runConflicts([], deps);
    expect(code).toBe(2);
    expect(h.fetchCalls).toEqual([]);
    expect(h.err.join("\n")).toContain("$CLAUDE_CODE_SESSION_ID");
    expect(h.err.join("\n")).toContain("mla conflicts --global");
  });

  it("maps a 403 to a login hint", async () => {
    const { deps, h } = harness(
      { workspaceId: "ws_test", sessionId: null, global: true, conflicts: [] },
      {
        fetchConflicts: async () => {
          throw httpError("forbidden", 403);
        },
      },
    );
    const code = await runConflicts(["--global"], deps);
    expect(code).toBe(1);
    expect(h.err).toEqual(["Not authorized. Run `mla login` to read conflicts as yourself."]);
  });

  it("maps a network failure (no status) to an unreachable message", async () => {
    const { deps, h } = harness(
      { workspaceId: "ws_test", sessionId: null, global: true, conflicts: [] },
      {
        fetchConflicts: async () => {
          throw httpError("boom");
        },
      },
    );
    const code = await runConflicts(["--global"], deps);
    expect(code).toBe(1);
    expect(h.err).toEqual(["Could not reach the backend to read conflicts."]);
  });
});

// --- resolve/dismiss: pure copy ---

describe("describeResolveResult", () => {
  function result(over: Partial<ResolveConflictResult>): ResolveConflictResult {
    return { caseId: "c00-abcd1234", outcome: "DISMISS", resolution: "", linkedCaseId: null, ...over };
  }

  it("UPHOLD_SUBJECT: names the subject as the winner and the counterparty as superseded", () => {
    const line = describeResolveResult(result({ outcome: "UPHOLD_SUBJECT" }));
    expect(line).toBe(
      "Resolved c00-abcd1234: upheld the subject (the newer capture wins; the counterparty is superseded).",
    );
    assertNoSmellDashes(line);
  });

  it("UPHOLD_COUNTERPARTY: names prior approved knowledge as the winner and the subject as dropped", () => {
    const line = describeResolveResult(result({ outcome: "UPHOLD_COUNTERPARTY" }));
    expect(line).toBe(
      "Resolved c00-abcd1234: upheld the counterparty (prior approved knowledge stands; the subject capture is dropped).",
    );
    assertNoSmellDashes(line);
  });

  it("DISMISS: closes as a false positive", () => {
    const line = describeResolveResult(result({ outcome: "DISMISS" }));
    expect(line).toBe("Dismissed c00-abcd1234: not a real conflict, closed as a false positive.");
    assertNoSmellDashes(line);
  });

  it("REJECT_BOTH with an escalation names the linked decision case", () => {
    const line = describeResolveResult(
      result({ outcome: "REJECT_BOTH", linkedCaseId: "c00-linked999" }),
    );
    expect(line).toBe(
      "Resolved c00-abcd1234: rejected both sides, escalated to decision case c00-linked999.",
    );
    assertNoSmellDashes(line);
  });

  it("REJECT_BOTH without a linked case omits the escalation clause", () => {
    const line = describeResolveResult(result({ outcome: "REJECT_BOTH", linkedCaseId: null }));
    expect(line).toBe("Resolved c00-abcd1234: rejected both sides.");
    assertNoSmellDashes(line);
  });
});

// --- resolve/dismiss: pure parse ---

describe("parseConflictsArgs write verbs", () => {
  it("resolve normalizes the kebab --outcome flag to the enum", () => {
    const p = parseConflictsArgs([
      "resolve",
      "c00-abcd1234",
      "--outcome",
      "uphold-subject",
      "--rationale",
      "newer wins",
    ]);
    expect(p.verb).toBe("resolve");
    expect(p.caseId).toBe("c00-abcd1234");
    expect(p.outcome).toBe("UPHOLD_SUBJECT");
    expect(p.rationale).toBe("newer wins");
  });

  it("resolve accepts the raw enum form of --outcome, case-insensitively", () => {
    const p = parseConflictsArgs([
      "resolve",
      "c00-abcd1234",
      "--outcome",
      "UPHOLD_COUNTERPARTY",
      "--rationale",
      "approved stands",
    ]);
    expect(p.outcome).toBe("UPHOLD_COUNTERPARTY");
  });

  it("resolve reads the case id positionally regardless of flag order", () => {
    const p = parseConflictsArgs([
      "resolve",
      "--outcome",
      "reject-both",
      "--rationale",
      "neither",
      "c00-late-id",
    ]);
    expect(p.caseId).toBe("c00-late-id");
    expect(p.outcome).toBe("REJECT_BOTH");
  });

  it("dismiss fixes the outcome to DISMISS without an --outcome flag", () => {
    const p = parseConflictsArgs(["dismiss", "c00-abcd1234", "--rationale", "false alarm"]);
    expect(p.verb).toBe("dismiss");
    expect(p.outcome).toBe("DISMISS");
    expect(p.rationale).toBe("false alarm");
  });

  it("accepts --note as an alias for --rationale", () => {
    const p = parseConflictsArgs(["dismiss", "c00-abcd1234", "--note", "not a conflict"]);
    expect(p.rationale).toBe("not a conflict");
  });

  it("rejects an unknown --outcome value loudly", () => {
    expect(() =>
      parseConflictsArgs(["resolve", "c00-abcd1234", "--outcome", "keep-newer", "--rationale", "x"]),
    ).toThrow(/Unknown outcome/);
  });

  it("rejects --outcome on dismiss (the shorthand already fixes the verdict)", () => {
    expect(() =>
      parseConflictsArgs(["dismiss", "c00-abcd1234", "--outcome", "reject-both", "--rationale", "x"]),
    ).toThrow(/already implies --outcome dismiss/);
  });

  it("requires --outcome on resolve", () => {
    expect(() =>
      parseConflictsArgs(["resolve", "c00-abcd1234", "--rationale", "x"]),
    ).toThrow(/requires --outcome/);
  });

  it("requires a non-empty rationale on a write verb", () => {
    expect(() =>
      parseConflictsArgs(["resolve", "c00-abcd1234", "--outcome", "dismiss", "--rationale", "   "]),
    ).toThrow(/rationale is required/);
  });

  it("requires a case id on a write verb", () => {
    expect(() =>
      parseConflictsArgs(["resolve", "--outcome", "dismiss", "--rationale", "x"]),
    ).toThrow(/Usage: mla conflicts resolve/);
  });
});

// --- resolve/dismiss: orchestration ---

describe("runConflicts resolve/dismiss verbs", () => {
  it("resolve forwards the workspace-scoped verdict and prints the outcome-aware confirmation", async () => {
    const { deps, h } = harness(NO_READ);
    const code = await runConflicts(
      ["resolve", "c00-abcd1234", "--outcome", "uphold-subject", "--rationale", "newer wins"],
      deps,
    );

    expect(code).toBe(0);
    // The body is scoped from cfg (workspaceId), the outcome normalized, the
    // rationale forwarded verbatim.
    expect(h.resolveConflictCalls).toEqual([
      {
        caseId: "c00-abcd1234",
        outcome: "UPHOLD_SUBJECT",
        rationale: "newer wins",
        workspaceId: "ws_test",
      },
    ]);
    // A write verb never touches the read/list plane.
    expect(h.fetchCalls).toEqual([]);
    expect(h.resolveCalls).toEqual([]);
    expect(h.out).toEqual([
      "Resolved c00-abcd1234: upheld the subject (the newer capture wins; the counterparty is superseded).",
    ]);
    assertNoSmellDashes(h.out.join("\n"));
  });

  it("dismiss forwards DISMISS and prints the false-positive confirmation", async () => {
    const { deps, h } = harness(NO_READ);
    const code = await runConflicts(
      ["dismiss", "c00-abcd1234", "--rationale", "not a real conflict"],
      deps,
    );

    expect(code).toBe(0);
    expect(h.resolveConflictCalls).toEqual([
      {
        caseId: "c00-abcd1234",
        outcome: "DISMISS",
        rationale: "not a real conflict",
        workspaceId: "ws_test",
      },
    ]);
    expect(h.out).toEqual([
      "Dismissed c00-abcd1234: not a real conflict, closed as a false positive.",
    ]);
  });

  it("REJECT_BOTH surfaces the escalated decision case in the confirmation", async () => {
    const { deps, h } = harness(NO_READ, {
      resolveConflict: async (_cfg, caseId, outcome) => ({
        caseId,
        outcome,
        resolution: "",
        linkedCaseId: "c00-linked999",
      }),
    });
    const code = await runConflicts(
      ["resolve", "c00-abcd1234", "--outcome", "reject-both", "--rationale", "neither holds"],
      deps,
    );
    expect(code).toBe(0);
    expect(h.out).toEqual([
      "Resolved c00-abcd1234: rejected both sides, escalated to decision case c00-linked999.",
    ]);
  });

  it("a parse error on a write verb returns code 2 and never calls the endpoint", async () => {
    const { deps, h } = harness(NO_READ);
    // Missing --rationale: the client rejects before any network call.
    const code = await runConflicts(
      ["resolve", "c00-abcd1234", "--outcome", "dismiss"],
      deps,
    );
    expect(code).toBe(2);
    expect(h.resolveConflictCalls).toEqual([]);
    expect(h.err.join("\n")).toContain("rationale is required");
  });

  it("maps a 404 to a case-not-found message", async () => {
    const { deps, h } = harness(NO_READ, {
      resolveConflict: async () => {
        throw httpError("not found", 404);
      },
    });
    const code = await runConflicts(
      ["dismiss", "c00-missing", "--rationale", "x"],
      deps,
    );
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("Conflict case not found: c00-missing");
  });

  it("maps a 403 to a login + membership hint", async () => {
    const { deps, h } = harness(NO_READ, {
      resolveConflict: async () => {
        throw httpError("forbidden", 403);
      },
    });
    const code = await runConflicts(
      ["dismiss", "c00-abcd1234", "--rationale", "x"],
      deps,
    );
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("Not authorized to resolve this conflict");
    expect(h.err.join("\n")).toContain("member of the workspace");
  });

  it("maps a 400 to a rejected-verdict message and includes the server detail", async () => {
    const { deps, h } = harness(NO_READ, {
      resolveConflict: async () => {
        const e = httpError("bad", 400);
        e.body = "case is already CLOSED";
        throw e;
      },
    });
    const code = await runConflicts(
      ["resolve", "c00-abcd1234", "--outcome", "uphold-subject", "--rationale", "x"],
      deps,
    );
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe(
      "Could not resolve c00-abcd1234: the verdict was rejected (case is already CLOSED).",
    );
  });

  it("maps a network failure (no status) to an unreachable message", async () => {
    const { deps, h } = harness(NO_READ, {
      resolveConflict: async () => {
        throw httpError("boom");
      },
    });
    const code = await runConflicts(
      ["dismiss", "c00-abcd1234", "--rationale", "x"],
      deps,
    );
    expect(code).toBe(1);
    expect(h.err).toEqual(["Could not reach the backend to resolve the conflict."]);
  });
});
