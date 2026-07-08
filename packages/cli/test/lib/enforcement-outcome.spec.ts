// The STAR "R" classifier (enforcement-outcome.ts) -- "the result of our action". Given a
// set of deny incidents and the raw session transcript, it derives what the agent did NEXT
// after each block: redirected to an allowed path, stopped, or retried and got blocked
// again. These are pure tests: no fs, no network. They pin (a) the three terminal classes,
// (b) the order-zip that survives a suffix collision (wrong-dir vs vault, both ending in the
// same relative path), (c) pending / indeterminate (never emitted), and (d) the primitives
// parseTranscriptAttempts + pathMatches.

import {
  IncidentFacts,
  ClassifiedIncident,
  deriveEnforcementOutcomes,
  parseTranscriptAttempts,
  pathMatches,
} from "../../src/lib/analytics/enforcement-outcome";

// --- transcript line builders (mirror the real Claude Code JSONL shape) ------------------

function asstWrite(tool: "Write" | "Edit", filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: tool, input: { file_path: filePath } }] },
  });
}

function asstText(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

function userText(text: string): string {
  return JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });
}

function inc(over: Partial<IncidentFacts> = {}): IncidentFacts {
  return {
    incidentId: "INC1",
    enforcedTool: "Write",
    blockedPath: "notes/x.md",
    occurredAtMs: 1000,
    ...over,
  };
}

function byId(results: ClassifiedIncident[]): Record<string, ClassifiedIncident> {
  const out: Record<string, ClassifiedIncident> = {};
  for (const r of results) out[r.incidentId] = r;
  return out;
}

describe("deriveEnforcementOutcomes -- terminal classes", () => {
  it("complied_redirected: the immediate next attempt goes to a non-blocked path", () => {
    const lines = [
      asstWrite("Write", "/repo/notes/wrong.md"), // the blocked attempt (seq 0)
      asstWrite("Write", "/repo/notes/correct.md"), // redirect -> matches no incident (seq 1)
    ];
    const [r] = deriveEnforcementOutcomes([inc({ blockedPath: "notes/wrong.md" })], lines);
    expect(r.status).toBe("terminal");
    expect(r.outcome).toBe("complied_redirected");
    expect(r.followupAttempts).toBe(1);
    expect(r.retriedBlockedCount).toBe(0);
  });

  it("complied_stopped: agent takes another turn but never re-mutates", () => {
    const lines = [
      asstWrite("Write", "/repo/notes/x.md"), // blocked attempt (assistant line 0)
      asstText("Understood, I'll leave that file alone."), // reacted, no further Write/Edit (line 1)
    ];
    const [r] = deriveEnforcementOutcomes([inc()], lines);
    expect(r.status).toBe("terminal");
    expect(r.outcome).toBe("complied_stopped");
    expect(r.followupAttempts).toBe(0);
    expect(r.retriedBlockedCount).toBe(0);
  });

  it("retried_blocked: the immediate next attempt hits a (new) incident on the same path", () => {
    // A retry mints a NEW incident, so the same blocked path yields two incidents. The
    // transcript has two blocked writes; the older incident claims the first, the newer the
    // second (order-zip). The older incident's next attempt is itself blocked -> retried.
    const lines = [
      asstWrite("Write", "/repo/notes/x.md"), // seq 0 -> claimed by A
      asstWrite("Write", "/repo/notes/x.md"), // seq 1 -> claimed by B (also blocked)
      asstText("Both attempts were blocked; stopping."), // line 2
    ];
    const results = byId(
      deriveEnforcementOutcomes(
        [
          inc({ incidentId: "A", occurredAtMs: 1000 }),
          inc({ incidentId: "B", occurredAtMs: 2000 }),
        ],
        lines,
      ),
    );
    expect(results.A.outcome).toBe("retried_blocked");
    expect(results.A.followupAttempts).toBe(1);
    expect(results.A.retriedBlockedCount).toBe(1);
    // B has no further attempt but did react (line 2) -> stopped.
    expect(results.B.outcome).toBe("complied_stopped");
  });
});

describe("deriveEnforcementOutcomes -- reaction-burst window (late-correlation resilience)", () => {
  it("counts only the redirect, not the dozens of unrelated edits that trail it", () => {
    // The 42-inflation case, shrunk: a deny whose window is closed LATE (a straggler Stop,
    // or a long turn with the deny early) must still report the reaction burst -- one
    // redirect -- not every Write/Edit the agent did for the rest of the session. Without
    // the window, followupAttempts here would be 4.
    const lines = [
      asstWrite("Write", "/repo/notes/wrong.md"), // blocked (seq 0)
      asstWrite("Write", "/repo/notes/correct.md"), // redirect, resolves the block (seq 1)
      asstWrite("Edit", "/repo/src/a.ts"), // unrelated later work (seq 2)
      asstWrite("Edit", "/repo/src/b.ts"), // unrelated later work (seq 3)
      asstWrite("Edit", "/repo/src/c.ts"), // unrelated later work (seq 4)
    ];
    const [r] = deriveEnforcementOutcomes([inc({ blockedPath: "notes/wrong.md" })], lines);
    expect(r.outcome).toBe("complied_redirected");
    expect(r.followupAttempts).toBe(1);
    expect(r.retriedBlockedCount).toBe(0);
  });

  it("extends the window across a retry burst but stops at the redirect that resolves it", () => {
    // deny_A -> retry (blocked, mints incident B) -> redirect -> unrelated edit. Incident A's
    // window spans the retry and the redirect (2 attempts, 1 re-block) and then STOPS -- the
    // trailing unrelated edit is not follow-through to A.
    const lines = [
      asstWrite("Write", "/repo/notes/x.md"), // seq 0 -> A
      asstWrite("Write", "/repo/notes/x.md"), // seq 1 -> B (blocked retry)
      asstWrite("Write", "/repo/notes/correct.md"), // seq 2 -> redirect resolves A's block
      asstWrite("Edit", "/repo/src/z.ts"), // seq 3 -> unrelated trailing work
    ];
    const results = byId(
      deriveEnforcementOutcomes(
        [inc({ incidentId: "A", occurredAtMs: 1000 }), inc({ incidentId: "B", occurredAtMs: 2000 })],
        lines,
      ),
    );
    expect(results.A.outcome).toBe("retried_blocked");
    expect(results.A.followupAttempts).toBe(2);
    expect(results.A.retriedBlockedCount).toBe(1);
    // B redirected on its very next attempt, so its window is a single redirect.
    expect(results.B.outcome).toBe("complied_redirected");
    expect(results.B.followupAttempts).toBe(1);
    expect(results.B.retriedBlockedCount).toBe(0);
  });
});

describe("deriveEnforcementOutcomes -- order-zip suffix collision", () => {
  it("claims the earlier blocked attempt, not the vault redirect that shares the suffix", () => {
    // Both absolute paths end in "/notes/x.md", so both suffix-match the incident. Only the
    // FIRST (wrong-dir) is the real deny; the SECOND (the vault) passed. Earliest-unclaimed
    // must pair the incident with seq 0, leaving seq 1 as an un-denied redirect ->
    // complied_redirected. If it wrongly claimed seq 1, there'd be no later attempt.
    const lines = [
      asstWrite("Write", "/repo/notes/x.md"), // wrong dir, blocked (seq 0)
      asstWrite("Write", "/Users/dev/projects/acme/notes/x.md"), // vault, passed (seq 1)
    ];
    const [r] = deriveEnforcementOutcomes([inc({ blockedPath: "notes/x.md" })], lines);
    expect(r.outcome).toBe("complied_redirected");
    expect(r.retriedBlockedCount).toBe(0);
    expect(r.followupAttempts).toBe(1);
  });
});

describe("deriveEnforcementOutcomes -- non-emitted classes", () => {
  it("pending: the deny is the last assistant activity (reaction not observable yet)", () => {
    const lines = [asstWrite("Write", "/repo/notes/x.md")];
    const [r] = deriveEnforcementOutcomes([inc()], lines);
    expect(r.status).toBe("pending");
    expect(r.outcome).toBeNull();
  });

  it("pending: a user turn after the deny is not an agent reaction", () => {
    const lines = [asstWrite("Write", "/repo/notes/x.md"), userText("why did that fail?")];
    const [r] = deriveEnforcementOutcomes([inc()], lines);
    expect(r.status).toBe("pending");
    expect(r.outcome).toBeNull();
  });

  it("indeterminate: the blocked attempt is not locatable in the transcript", () => {
    const lines = [asstWrite("Write", "/repo/notes/somethingelse.md")];
    const [r] = deriveEnforcementOutcomes([inc({ blockedPath: "notes/x.md" })], lines);
    expect(r.status).toBe("indeterminate");
    expect(r.outcome).toBeNull();
  });

  it("indeterminate: a null blocked path is unmatchable", () => {
    const lines = [asstWrite("Write", "/repo/notes/x.md")];
    const [r] = deriveEnforcementOutcomes([inc({ blockedPath: null })], lines);
    expect(r.status).toBe("indeterminate");
    expect(r.outcome).toBeNull();
  });

  it("tool mismatch does not match: an Edit incident against a Write attempt is indeterminate", () => {
    const lines = [asstWrite("Write", "/repo/notes/x.md")];
    const [r] = deriveEnforcementOutcomes([inc({ enforcedTool: "Edit" })], lines);
    expect(r.status).toBe("indeterminate");
  });
});

describe("deriveEnforcementOutcomes -- shape", () => {
  it("returns exactly one classification per input incident, in input order", () => {
    const lines = [asstWrite("Write", "/repo/notes/x.md"), asstText("stopping")];
    const results = deriveEnforcementOutcomes(
      [inc({ incidentId: "first" }), inc({ incidentId: "second", blockedPath: "notes/none.md" })],
      lines,
    );
    expect(results.map((r) => r.incidentId)).toEqual(["first", "second"]);
  });
});

describe("parseTranscriptAttempts", () => {
  it("pulls Write and Edit tool_use blocks in transcript order", () => {
    const { attempts } = parseTranscriptAttempts([
      asstWrite("Write", "/a.md"),
      asstWrite("Edit", "/b.ts"),
    ]);
    expect(attempts.map((a) => [a.tool, a.absPath])).toEqual([
      ["Write", "/a.md"],
      ["Edit", "/b.ts"],
    ]);
    expect(attempts.map((a) => a.seq)).toEqual([0, 1]);
  });

  it("ignores non-Write/Edit tool_use and blocks without a file_path", () => {
    const bash = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    const noPath = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: {} }] },
    });
    const { attempts } = parseTranscriptAttempts([bash, noPath, asstWrite("Write", "/a.md")]);
    expect(attempts.map((a) => a.absPath)).toEqual(["/a.md"]);
  });

  it("skips malformed / non-JSON / non-assistant lines without throwing", () => {
    const { attempts, maxAssistantLineIndex } = parseTranscriptAttempts([
      "not json",
      "",
      userText("hi"),
      asstWrite("Write", "/a.md"),
    ]);
    expect(attempts).toHaveLength(1);
    expect(maxAssistantLineIndex).toBe(3);
  });

  it("tracks the last assistant line index (the pending signal), ignoring later user lines", () => {
    const { maxAssistantLineIndex } = parseTranscriptAttempts([
      asstWrite("Write", "/a.md"),
      userText("later user turn"),
    ]);
    expect(maxAssistantLineIndex).toBe(0);
  });
});

describe("pathMatches", () => {
  it("matches a segment-aligned suffix", () => {
    expect(pathMatches("/repo/notes/x.md", "notes/x.md")).toBe(true);
  });

  it("matches an exact-equal path", () => {
    expect(pathMatches("notes/x.md", "notes/x.md")).toBe(true);
  });

  it("does NOT match a non-segment-aligned suffix (footnotes vs notes)", () => {
    expect(pathMatches("/repo/footnotes/x.md", "notes/x.md")).toBe(false);
  });

  it("strips a leading ./ on the blocked path before matching", () => {
    expect(pathMatches("/repo/notes/x.md", "./notes/x.md")).toBe(true);
  });

  it("normalizes windows separators", () => {
    expect(pathMatches("C:\\repo\\notes\\x.md", "notes/x.md")).toBe(true);
  });

  it("never matches an empty blocked path", () => {
    expect(pathMatches("/repo/notes/x.md", "")).toBe(false);
  });
});
