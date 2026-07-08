import { SCOUT_TOOL_ALLOWLIST, SCOUT_AGENT_NAME, buildScoutPrompt } from "../../../src/lib/enrichment/scout-brief";
import { OnboardingRun, SCOUT_NAMES, MAX_STATEMENT_LENGTH } from "../../../src/lib/enrichment/protocol";

function run(over: Partial<OnboardingRun> = {}): OnboardingRun {
  return {
    protocolVersion: 1,
    runId: over.runId ?? "run-fixture-1",
    workspaceId: over.workspaceId ?? "ws_demo",
    repositoryRoot: over.repositoryRoot ?? "/repo",
    createdAt: over.createdAt ?? "2026-06-26T00:00:00.000Z",
    deadlineAt: over.deadlineAt ?? "2026-06-26T00:04:00.000Z",
    planDigest: over.planDigest ?? "digest-abc",
    limits: over.limits ?? {
      maxDocumentTargets: 20,
      maxHistoryScanCommits: 300,
      maxHistorySelectedCommits: 40,
      maxPreparedInputBytes: 200_000,
      maxCandidatesTotal: 20,
      maxCandidatesPerScout: 10,
      budgetMs: 240_000,
    },
    documentationTargets: over.documentationTargets ?? [
      { path: "CLAUDE.md", tier: "T1", rank: 1 },
      { path: "notes/flows.md", tier: "T2", rank: 2 },
    ],
    historyEvidence: over.historyEvidence ?? [
      {
        commit: "1111111111111111111111111111111111111111",
        timestamp: "2026-06-20T10:00:00.000Z",
        subject: "feat: add the soft gate",
        body: "We chose a soft gate before a hard gate to ramp adoption.",
        changedFiles: [{ path: "control/gate.ts", status: "A" }],
      },
      {
        commit: "2222222222222222222222222222222222222222",
        timestamp: "2026-06-21T11:00:00.000Z",
        subject: "revert: drop the in-memory queue",
        body: "Reverted; Postgres SKIP LOCKED is the queue.",
        changedFiles: [
          { path: "worker/queue.ts", status: "R100", renamedFrom: "worker/old-queue.ts" },
        ],
        diffExcerpt: "- const q = new InMemoryQueue()\n+ // use the DB-backed queue",
      },
    ],
  };
}

describe("SCOUT_TOOL_ALLOWLIST (gate 7: no shell, mutation, or network tools)", () => {
  it("grants the documentation scout Read only", () => {
    expect(SCOUT_TOOL_ALLOWLIST.documentation).toEqual(["Read"]);
  });

  it("grants the history scout no tools at all", () => {
    expect(SCOUT_TOOL_ALLOWLIST.history).toEqual([]);
  });

  it("never grants any scout a shell, mutation, network, or discovery tool", () => {
    // Shell / mutation / network would break the security claim; Glob/Grep are forbidden
    // because the deterministic plan already discovered and ranked the inputs (plan §4).
    const forbidden = [
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Glob",
      "Grep",
      "Task",
      "Agent",
    ];
    for (const scout of SCOUT_NAMES) {
      for (const tool of SCOUT_TOOL_ALLOWLIST[scout]) {
        expect(forbidden).not.toContain(tool);
      }
    }
  });

  it("covers exactly the two known scout roles", () => {
    expect(Object.keys(SCOUT_TOOL_ALLOWLIST).sort()).toEqual([...SCOUT_NAMES].sort());
  });
});

describe("SCOUT_AGENT_NAME (role -> Claude Code subagent name)", () => {
  it("maps each role to a distinct, namespaced, kebab-case agent name", () => {
    expect(SCOUT_AGENT_NAME.documentation).toBe("meetless-doc-scout");
    expect(SCOUT_AGENT_NAME.history).toBe("meetless-history-scout");
    for (const role of SCOUT_NAMES) {
      const name = SCOUT_AGENT_NAME[role];
      // Namespaced so it cannot collide with an operator's own agents.
      expect(name).toMatch(/^meetless-/);
      // Claude Code subagent names are lowercase letters, numbers, and hyphens only.
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
    // Two roles must not collapse to one subagent.
    expect(new Set(Object.values(SCOUT_AGENT_NAME)).size).toBe(SCOUT_NAMES.length);
  });

  it("covers exactly the two known scout roles", () => {
    expect(Object.keys(SCOUT_AGENT_NAME).sort()).toEqual([...SCOUT_NAMES].sort());
  });
});

describe("buildScoutPrompt (shared policy atoms, both roles)", () => {
  for (const role of SCOUT_NAMES) {
    it(`states the scout policy for the ${role} scout`, () => {
      const out = buildScoutPrompt(run(), role);
      expect(out).toMatch(/scout/i);
      // Non-authoritative posture: never owns acceptance.
      expect(out).toMatch(/do not (mark|accept|promote)/i);
      // Untrusted content guard.
      expect(out).toMatch(/untrusted/i);
      expect(out).toMatch(/do not comply|not as instructions/i);
      // Evidence requirement + the run + the deadline steer.
      expect(out).toMatch(/evidence/i);
      expect(out).toContain("run-fixture-1");
      expect(out).toContain("2026-06-26T00:04:00.000Z");
      // The output contract carries the role's own sourceScout.
      expect(out).toContain(`"sourceScout": "${role}"`);
      expect(out).toContain(`"scout": "${role}"`);
      // Each scout is told its OWN independent hard cap (10), explicitly NOT a shared or
      // reallocated budget (verdict item 8: no reallocation). The run-wide backstop (20) is
      // surfaced as a ceiling, but the binding instruction is the per-scout cap, so the brief
      // must not revive the old "fair share" framing that implied surplus moves between scouts.
      expect(out).toContain("10 candidates or fewer");
      expect(out).toContain("20 candidates");
      expect(out).toMatch(/yours alone|not (shared|reallocated)/i);
      expect(out).not.toMatch(/shares that budget fairly/);
      expect(out).not.toMatch(/fair share/i);
    });

    it(`tells the ${role} scout to emit one JSON object and nothing after it (ingest does a whole-file JSON.parse)`, () => {
      const out = buildScoutPrompt(run(), role);
      // The output contract must stay self-consistent. The old brief said "no prose
      // before or after" the JSON in one breath and then "note any contradictions in a
      // short prose summary after the JSON" in the next: a scout that obeyed the second
      // produced a file extractResults() (JSON.parse on the whole payload) rejects.
      expect(out).toContain("Return EXACTLY one JSON object and nothing else");
      expect(out).not.toMatch(/prose summary after the JSON/i);
      expect(out).toMatch(/the JSON\s*\n?\s*object above is the entire output/i);
      // Contradictions are not dropped: they are redirected into the candidate model,
      // which is the only thing ingest persists.
      expect(out).toMatch(/contradict/i);
      expect(out).toMatch(/`decision` or `deprecation` candidate/);
    });

    it(`warns the ${role} scout that an over-length statement is hard-rejected (not truncated) at ingest`, () => {
      // The cap rule already says over-budget candidates are "dropped at ingest"; the
      // length rule used to only hint "500 characters or fewer" with no consequence, so a
      // verbose scout lost a whole candidate to `statement_too_long` instead of trimming.
      // Mirror the cap warning's explicit-consequence framing.
      // Sourced from the validator's own MAX_STATEMENT_LENGTH: a hardcoded literal that
      // diverged from the constant would fail this toContain.
      const out = buildScoutPrompt(run(), role);
      expect(out).toContain(`${MAX_STATEMENT_LENGTH} characters or fewer`);
      expect(out).toMatch(/rejected outright at ingest/i);
      expect(out).toMatch(/not truncated/i);
    });

    it(`tells the ${role} scout that rationale is optional and always its own AGENT_SUMMARY`, () => {
      // A scout is an agent, so any rationale it writes is its paraphrase, never the user's
      // words. The brief must say the fields are optional, pin the scout's source to
      // AGENT_SUMMARY, and prefer omission over a fabricated reason (memo Phase 1).
      const out = buildScoutPrompt(run(), role);
      expect(out).toContain('"rationaleSource"');
      expect(out).toMatch(/OPTIONAL/);
      expect(out).toMatch(/AGENT_SUMMARY/);
      expect(out).toMatch(/better than a fabricated reason/i);
    });
  }
});

describe("buildScoutPrompt (documentation role)", () => {
  it("lists the exact ranked document targets and grants Read", () => {
    const out = buildScoutPrompt(run(), "documentation");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("notes/flows.md");
    expect(out).toMatch(/Read ONLY these documents/);
    expect(out).toMatch(/Your only tools are: Read/);
    // File-shaped evidence, never commit-shaped.
    expect(out).toContain('"type": "file"');
    expect(out).not.toContain('"type": "commit"');
  });

  it("forbids rediscovery (no glob/search of other files)", () => {
    const out = buildScoutPrompt(run(), "documentation");
    expect(out).toMatch(/do not search for, glob, or open any other file/i);
  });

  it("anchors reads to the repository root so a scout dispatched from another cwd resolves paths", () => {
    const out = buildScoutPrompt(run({ repositoryRoot: "/abs/path/to/intel" }), "documentation");
    // The listed paths are repo-relative; a subagent's cwd may differ from the scanned
    // root (a subdir, or another repo in the same workspace), so the brief must name the
    // absolute root for the Read step.
    expect(out).toContain("/abs/path/to/intel");
    expect(out).toMatch(/relative to the repository root/i);
    expect(out).toMatch(/absolute path/i);
    // Evidence paths must stay relative: ingest rejects absolute file anchors.
    expect(out).toMatch(/exactly as listed below \(relative\)/);
  });

  it("handles zero document targets as a valid empty result", () => {
    const out = buildScoutPrompt(run({ documentationTargets: [] }), "documentation");
    expect(out).toMatch(/no document targets/i);
    expect(out).toContain('"status": "complete"');
  });
});

describe("buildScoutPrompt (history role)", () => {
  it("inlines the bounded git evidence and grants no tools", () => {
    const out = buildScoutPrompt(run(), "history");
    expect(out).toContain("1111111111111111111111111111111111111111");
    expect(out).toContain("2222222222222222222222222222222222222222");
    expect(out).toContain("feat: add the soft gate");
    expect(out).toContain("revert: drop the in-memory queue");
    // The prepared message body and rename evidence are present.
    expect(out).toContain("Postgres SKIP LOCKED is the queue.");
    expect(out).toContain("(from worker/old-queue.ts)");
    expect(out).toContain("use the DB-backed queue");
    // No tools at all.
    expect(out).toMatch(/You have NO tools/);
    expect(out).toMatch(/cannot open files/i);
    // Commit-shaped evidence, never file-shaped.
    expect(out).toContain('"type": "commit"');
    expect(out).not.toContain('"type": "file"');
  });

  it("handles zero commit history as a valid empty result", () => {
    const out = buildScoutPrompt(run({ historyEvidence: [] }), "history");
    expect(out).toMatch(/no commit history/i);
    expect(out).toContain('"status": "complete"');
  });
});

describe("buildScoutPrompt (deterministic)", () => {
  it("returns an identical brief for the same run and role", () => {
    expect(buildScoutPrompt(run(), "documentation")).toBe(buildScoutPrompt(run(), "documentation"));
    expect(buildScoutPrompt(run(), "history")).toBe(buildScoutPrompt(run(), "history"));
  });
});
