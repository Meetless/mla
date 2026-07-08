import {
  PROTOCOL_VERSION,
  MAX_STATEMENT_LENGTH,
  MAX_EVIDENCE_PER_CANDIDATE,
  normalizeStatement,
  candidateAnchors,
  candidateId,
  candidateSlug,
  candidateRelPath,
  stableStringify,
  computePlanDigest,
  defaultLimits,
  commitAllowlist,
  resolveAllowedCommit,
  validateCandidateShape,
  validateScoutResultShape,
  validateIngestRequestShape,
  MAX_RATIONALE_LENGTH,
  RATIONALE_SOURCES,
  type EnrichmentCandidate,
  type OnboardingRun,
} from "../../../src/lib/enrichment/protocol";

const fileCandidate = (over: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate => ({
  kind: "constraint",
  statement: "Slack approval target is 60 seconds.",
  sourceScout: "documentation",
  evidence: [{ type: "file", path: "notes/flows.md", startLine: 10, endLine: 14 }],
  ...over,
});

const historyCandidate = (over: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate => ({
  kind: "decision",
  statement: "Decision Diff state machine added PROPAGATED state.",
  sourceScout: "history",
  evidence: [{ type: "commit", commit: "abcdef1234567890", path: "control/sm.ts" }],
  ...over,
});

describe("normalizeStatement", () => {
  it("trims and collapses internal whitespace without semantic changes", () => {
    expect(normalizeStatement("  the   quick\tbrown\nfox  ")).toBe("the quick brown fox");
  });
  it("does not lowercase or strip punctuation", () => {
    expect(normalizeStatement("Don't ship!")).toBe("Don't ship!");
  });
});

describe("candidateAnchors", () => {
  it("includes file paths and commit SHAs only, type-tagged, deduped and sorted", () => {
    const c = fileCandidate({
      evidence: [
        { type: "file", path: "b.md", startLine: 2, endLine: 9 },
        { type: "file", path: "a.md", startLine: 1, endLine: 3 },
        { type: "file", path: "b.md", startLine: 50, endLine: 60 }, // dup path, diff lines
      ],
    });
    expect(candidateAnchors(c)).toEqual(["f:a.md", "f:b.md"]);
  });
  it("lowercases commit SHAs and ignores the historical path for identity", () => {
    const c = historyCandidate({
      evidence: [{ type: "commit", commit: "ABCDEF1234", path: "whatever.ts" }],
    });
    expect(candidateAnchors(c)).toEqual(["c:abcdef1234"]);
  });
});

describe("candidateId", () => {
  it("is stable for identical content", () => {
    expect(candidateId(fileCandidate())).toBe(candidateId(fileCandidate()));
  });
  it("is insensitive to line-number drift (identity excludes lines)", () => {
    const a = candidateId(fileCandidate());
    const b = candidateId(fileCandidate({ evidence: [{ type: "file", path: "notes/flows.md", startLine: 999, endLine: 1200 }] }));
    expect(a).toBe(b);
  });
  it("is insensitive to statement whitespace (normalized)", () => {
    const a = candidateId(fileCandidate());
    const b = candidateId(fileCandidate({ statement: "  Slack approval target   is 60 seconds.  " }));
    expect(a).toBe(b);
  });
  it("changes when the statement content changes", () => {
    expect(candidateId(fileCandidate())).not.toBe(candidateId(fileCandidate({ statement: "different claim" })));
  });
  it("changes when the kind changes", () => {
    expect(candidateId(fileCandidate())).not.toBe(candidateId(fileCandidate({ kind: "decision" })));
  });
  it("changes when an anchor changes", () => {
    const other = fileCandidate({ evidence: [{ type: "file", path: "notes/other.md", startLine: 10, endLine: 14 }] });
    expect(candidateId(fileCandidate())).not.toBe(candidateId(other));
  });
  it("returns a 64-char hex sha256", () => {
    expect(candidateId(fileCandidate())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("candidateSlug + candidateRelPath", () => {
  it("kebab-cases, strips punctuation, and bounds length", () => {
    expect(candidateSlug("Slack approval target is 60 seconds.")).toBe("slack-approval-target-is-60-seconds");
  });
  it("never ends with a trailing hyphen after truncation", () => {
    const slug = candidateSlug("word ".repeat(40), 20);
    expect(slug).not.toMatch(/-$/);
    expect(slug.length).toBeLessThanOrEqual(20);
  });
  it("falls back to 'candidate' for an empty slug", () => {
    expect(candidateSlug("!!! ???")).toBe("candidate");
  });
  it("builds an onboarding/<id>-<slug>.md path", () => {
    const p = candidateRelPath(fileCandidate());
    expect(p).toMatch(/^onboarding\/[0-9a-f]{64}-slack-approval-target-is-60-seconds\.md$/);
  });
});

describe("stableStringify", () => {
  it("sorts object keys so order does not change the output", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
  it("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });
  it("omits undefined object values", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("handles null and nesting", () => {
    expect(stableStringify({ z: null, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":null}');
  });
});

describe("computePlanDigest", () => {
  const baseRun = (): OnboardingRun => ({
    protocolVersion: PROTOCOL_VERSION,
    runId: "run-1",
    workspaceId: "ws_x",
    repositoryRoot: "/repo",
    createdAt: "2026-06-26T00:00:00Z",
    deadlineAt: "2026-06-26T00:04:00Z",
    planDigest: "placeholder",
    limits: defaultLimits(),
    documentationTargets: [{ path: "CLAUDE.md", tier: "T1", rank: 1 }],
    historyEvidence: [
      { commit: "aaaa111", timestamp: "2026-06-01T00:00:00Z", subject: "x", body: "", changedFiles: [] },
    ],
  });

  it("is stable across runs of the same content", () => {
    expect(computePlanDigest(baseRun())).toBe(computePlanDigest(baseRun()));
  });
  it("ignores runId, createdAt, deadlineAt, and the stored planDigest", () => {
    const a = computePlanDigest(baseRun());
    const mutated = { ...baseRun(), runId: "run-2", createdAt: "2099-01-01T00:00:00Z", deadlineAt: "2099-01-01T00:09:00Z", planDigest: "different" };
    expect(computePlanDigest(mutated)).toBe(a);
  });
  it("changes when an integrity-bearing field changes (a target)", () => {
    const a = computePlanDigest(baseRun());
    const mutated = { ...baseRun(), documentationTargets: [{ path: "OTHER.md", tier: "T1" as const, rank: 1 }] };
    expect(computePlanDigest(mutated)).not.toBe(a);
  });
  it("changes when the commit allowlist changes", () => {
    const a = computePlanDigest(baseRun());
    const mutated = {
      ...baseRun(),
      historyEvidence: [{ commit: "bbbb222", timestamp: "2026-06-01T00:00:00Z", subject: "x", body: "", changedFiles: [] }],
    };
    expect(computePlanDigest(mutated)).not.toBe(a);
  });
});

describe("defaultLimits", () => {
  it("uses the default budget when none is given", () => {
    expect(defaultLimits().budgetMs).toBe(240_000);
    expect(defaultLimits().maxCandidatesTotal).toBe(20);
  });
  it("splits the per-scout cap from the run-total backstop, no reallocation (verdict item 8)", () => {
    const limits = defaultLimits();
    expect(limits.maxCandidatesPerScout).toBe(10);
    expect(limits.maxCandidatesTotal).toBe(20);
    // Per-scout caps must be able to sum to the run total so the per-scout cap is the binding
    // limit on a fresh run (no scout is silently throttled below its own cap).
    expect(limits.maxCandidatesPerScout * 2).toBeGreaterThanOrEqual(limits.maxCandidatesTotal);
  });
  it("splits the history scan window from the inlined-commit cap (verdict item 7)", () => {
    const limits = defaultLimits();
    expect(limits.maxHistoryScanCommits).toBe(300);
    expect(limits.maxHistorySelectedCommits).toBe(40);
    expect(limits.maxHistoryScanCommits).toBeGreaterThanOrEqual(limits.maxHistorySelectedCommits);
  });
  it("threads a custom budget", () => {
    expect(defaultLimits(1000).budgetMs).toBe(1000);
  });
});

describe("commitAllowlist + resolveAllowedCommit", () => {
  const run = {
    historyEvidence: [
      { commit: "ABCDEF1234567890", timestamp: "", subject: "", body: "", changedFiles: [] },
      { commit: "abc9999999999999", timestamp: "", subject: "", body: "", changedFiles: [] },
    ],
  };
  it("lowercases the allowlist", () => {
    expect(commitAllowlist(run)).toEqual(["abcdef1234567890", "abc9999999999999"]);
  });
  it("resolves an exact full SHA", () => {
    expect(resolveAllowedCommit(commitAllowlist(run), "ABCDEF1234567890")).toBe("abcdef1234567890");
  });
  it("resolves an unambiguous abbreviation to the full SHA", () => {
    expect(resolveAllowedCommit(commitAllowlist(run), "abcdef1")).toBe("abcdef1234567890");
  });
  it("rejects an ambiguous prefix", () => {
    expect(resolveAllowedCommit(commitAllowlist(run), "abc")).toBeNull();
  });
  it("rejects a too-short prefix", () => {
    expect(resolveAllowedCommit(commitAllowlist(run), "abcde")).toBeNull();
  });
  it("rejects a non-hex string", () => {
    expect(resolveAllowedCommit(commitAllowlist(run), "zzzzzzz")).toBeNull();
  });
  it("rejects a commit not in the allowlist", () => {
    expect(resolveAllowedCommit(commitAllowlist(run), "deadbeef")).toBeNull();
  });
});

describe("validateCandidateShape", () => {
  it("accepts a well-formed documentation candidate", () => {
    const res = validateCandidateShape(fileCandidate(), 0);
    expect(res.ok).toBe(true);
  });
  it("accepts a well-formed history candidate and lowercases its commit", () => {
    const res = validateCandidateShape(historyCandidate({ evidence: [{ type: "commit", commit: "ABCDEF1234" }] }), 0);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.candidate.evidence[0]).toEqual({ type: "commit", commit: "abcdef1234" });
  });
  it("rejects a non-object", () => {
    const res = validateCandidateShape(42, 3);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].index).toBe(3);
      expect(res.errors[0].code).toBe("not_an_object");
    }
  });
  it("rejects unknown top-level fields", () => {
    const res = validateCandidateShape({ ...fileCandidate(), extra: 1 }, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "unknown_field")).toBe(true);
  });
  it("rejects a bad kind", () => {
    const res = validateCandidateShape(fileCandidate({ kind: "nonsense" as never }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_kind")).toBe(true);
  });
  it("rejects a bad sourceScout", () => {
    const res = validateCandidateShape(fileCandidate({ sourceScout: "rumor" as never }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_source_scout")).toBe(true);
  });
  it("rejects an empty statement", () => {
    const res = validateCandidateShape(fileCandidate({ statement: "   " }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "empty_statement")).toBe(true);
  });
  it("rejects an over-long statement", () => {
    const res = validateCandidateShape(fileCandidate({ statement: "x".repeat(MAX_STATEMENT_LENGTH + 1) }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "statement_too_long")).toBe(true);
  });
  it("rejects empty evidence", () => {
    const res = validateCandidateShape(fileCandidate({ evidence: [] }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "no_evidence")).toBe(true);
  });
  it("rejects too much evidence", () => {
    const evidence = Array.from({ length: MAX_EVIDENCE_PER_CANDIDATE + 1 }, (_, i) => ({
      type: "file" as const,
      path: `f${i}.md`,
      startLine: 1,
      endLine: 2,
    }));
    const res = validateCandidateShape(fileCandidate({ evidence }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "too_much_evidence")).toBe(true);
  });
  it("rejects a file evidence with an inverted line range", () => {
    const res = validateCandidateShape(fileCandidate({ evidence: [{ type: "file", path: "a.md", startLine: 10, endLine: 2 }] }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_range")).toBe(true);
  });
  it("rejects a non-integer line", () => {
    const res = validateCandidateShape(fileCandidate({ evidence: [{ type: "file", path: "a.md", startLine: 1.5 as never, endLine: 2 }] }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_line")).toBe(true);
  });
  it("rejects an unknown field on file evidence", () => {
    const res = validateCandidateShape(fileCandidate({ evidence: [{ type: "file", path: "a.md", startLine: 1, endLine: 2, junk: 1 } as never] }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "unknown_field")).toBe(true);
  });
  it("rejects a malformed commit SHA", () => {
    const res = validateCandidateShape(historyCandidate({ evidence: [{ type: "commit", commit: "xyz" }] }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_commit")).toBe(true);
  });
  it("rejects a bad evidence type", () => {
    const res = validateCandidateShape(fileCandidate({ evidence: [{ type: "thread" } as never] }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_evidence_type")).toBe(true);
  });
  it("enforces the documentation -> file-anchor cross-check", () => {
    const res = validateCandidateShape(
      { kind: "constraint", statement: "x", sourceScout: "documentation", evidence: [{ type: "commit", commit: "abcdef1" }] },
      0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "missing_file_anchor")).toBe(true);
  });
  it("enforces the history -> commit-anchor cross-check", () => {
    const res = validateCandidateShape(
      { kind: "decision", statement: "x", sourceScout: "history", evidence: [{ type: "file", path: "a.md", startLine: 1, endLine: 2 }] },
      0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "missing_commit_anchor")).toBe(true);
  });
  it("collects multiple errors at once", () => {
    const res = validateCandidateShape({ kind: "bad", statement: "", sourceScout: "bad", evidence: [] }, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(1);
  });
});

describe("validateCandidateShape: rationale provenance (memo Phase 1)", () => {
  // A candidate may carry a short "why", but the WHY and its provenance are paired so an
  // agent's paraphrase is never laundered into the user's own words. The two enumerated
  // sources are the only valid provenance, and a missing rationale always beats a fabricated
  // one, so the field is fully optional.
  it("treats absent rationale as the canonical null/null pair (no rationale required)", () => {
    const res = validateCandidateShape(fileCandidate(), 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidate.rationale).toBeNull();
      expect(res.candidate.rationaleSource).toBeNull();
    }
  });

  it("canonicalizes an explicit null rationale to null/null", () => {
    const res = validateCandidateShape(fileCandidate({ rationale: null, rationaleSource: null }), 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidate.rationale).toBeNull();
      expect(res.candidate.rationaleSource).toBeNull();
    }
  });

  it("accepts a USER_EXPLICIT rationale and trims it", () => {
    const res = validateCandidateShape(
      fileCandidate({ rationale: "  the user wrote this verbatim  ", rationaleSource: "USER_EXPLICIT" }),
      0,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidate.rationale).toBe("the user wrote this verbatim");
      expect(res.candidate.rationaleSource).toBe("USER_EXPLICIT");
    }
  });

  it("accepts an AGENT_SUMMARY rationale (a scout's paraphrase)", () => {
    const res = validateCandidateShape(
      fileCandidate({ rationale: "scout's distilled why", rationaleSource: "AGENT_SUMMARY" }),
      0,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.candidate.rationaleSource).toBe("AGENT_SUMMARY");
  });

  it("sanitizes an orphan rationaleSource (no rationale) by dropping it, keeping the candidate", () => {
    // The rationale block is optional metadata; dropping a source with no rationale
    // attributes nothing, so an otherwise-valid candidate must survive rather than be lost.
    const res = validateCandidateShape(fileCandidate({ rationaleSource: "USER_EXPLICIT" }), 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidate.rationale).toBeNull();
      expect(res.candidate.rationaleSource).toBeNull();
    }
  });

  it("rejects a rationale with no rationaleSource (provenance must be declared)", () => {
    const res = validateCandidateShape(fileCandidate({ rationale: "a reason without a source" }), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "missing_rationale_source")).toBe(true);
  });

  it("rejects an unknown rationaleSource value", () => {
    const res = validateCandidateShape(
      fileCandidate({ rationale: "why", rationaleSource: "HEARSAY" as never }),
      0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_rationale_source")).toBe(true);
  });

  it("rejects a non-string, non-null rationale", () => {
    const res = validateCandidateShape(
      fileCandidate({ rationale: 42 as never, rationaleSource: "AGENT_SUMMARY" }),
      0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "bad_rationale")).toBe(true);
  });

  it("rejects a whitespace-only rationale (omit it or send null instead)", () => {
    const res = validateCandidateShape(
      fileCandidate({ rationale: "   ", rationaleSource: "AGENT_SUMMARY" }),
      0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "empty_rationale")).toBe(true);
  });

  it("rejects a rationale longer than the cap", () => {
    const res = validateCandidateShape(
      fileCandidate({ rationale: "x".repeat(MAX_RATIONALE_LENGTH + 1), rationaleSource: "AGENT_SUMMARY" }),
      0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "rationale_too_long")).toBe(true);
  });

  it("exposes exactly the two enumerated provenance sources", () => {
    expect([...RATIONALE_SOURCES]).toEqual(["USER_EXPLICIT", "AGENT_SUMMARY"]);
  });
});

describe("validateScoutResultShape", () => {
  it("accepts a minimal valid envelope", () => {
    const res = validateScoutResultShape({ scout: "documentation", status: "complete", candidates: [] });
    expect(res.ok).toBe(true);
  });
  it("passes candidates through as raw unknown[] (no per-candidate validation here)", () => {
    const res = validateScoutResultShape({ scout: "history", status: "complete", candidates: [{ junk: true }] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.candidates).toHaveLength(1);
  });
  it("threads truncated and error when present", () => {
    const res = validateScoutResultShape({ scout: "history", status: "timed_out", candidates: [], truncated: true, error: "slow" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.truncated).toBe(true);
      expect(res.result.error).toBe("slow");
    }
  });
  it("rejects a bad scout name", () => {
    expect(validateScoutResultShape({ scout: "spy", status: "complete", candidates: [] }).ok).toBe(false);
  });
  it("rejects a bad status", () => {
    expect(validateScoutResultShape({ scout: "history", status: "weird", candidates: [] }).ok).toBe(false);
  });
  it("rejects non-array candidates", () => {
    expect(validateScoutResultShape({ scout: "history", status: "complete", candidates: {} }).ok).toBe(false);
  });
});

describe("validateIngestRequestShape", () => {
  it("accepts a valid envelope", () => {
    const res = validateIngestRequestShape({ protocolVersion: 1, runId: "run-1", results: [] });
    expect(res.ok).toBe(true);
  });
  it("rejects a wrong protocol version", () => {
    expect(validateIngestRequestShape({ protocolVersion: 2, runId: "run-1", results: [] }).ok).toBe(false);
  });
  it("rejects a missing runId", () => {
    expect(validateIngestRequestShape({ protocolVersion: 1, runId: "  ", results: [] }).ok).toBe(false);
  });
  it("rejects non-array results", () => {
    expect(validateIngestRequestShape({ protocolVersion: 1, runId: "run-1", results: "nope" }).ok).toBe(false);
  });
});
