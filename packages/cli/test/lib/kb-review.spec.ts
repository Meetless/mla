import {
  parseKbReviewArgs,
  evaluateReviewPolicy,
  runKbReviewWith,
  KbReviewDeps,
} from "../../src/commands/kb_review";
import {
  classifyMechanicalInvalidity,
  AUTO_REJECT_CONFIDENCE_FLOOR,
  RelationshipCandidate,
} from "../../src/lib/kb-candidate";

// Behavioral lock for B5 (`mla kb review`, the agent-proxy verdict command) from
// notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 (B5) and §7.4.
// The contract, restated:
//
//   - `mla kb review <id> --accept | --reject [--note] [--agent]` routes a verdict
//     through the EXISTING control finalize primitive (POST
//     /internal/v1/relationship-candidates/<id>/{accept,reject}), the same one the
//     Console and MCP use. It never writes the knowledge graph directly and never
//     bypasses the promotion gate (status==ACCEPTED && posture==LIVE is the
//     server's job; the CLI only records the verdict).
//   - Auto-resolution is REJECT-ONLY in MVP (P2). An automated proxy (`--agent`)
//     may AUTO-REJECT a MECHANICALLY-invalid candidate (self-edge; unsupported
//     low-confidence) and may NOT auto-accept ANY relationship, because a wrong
//     auto-accept creates false governance and poisons retrieval (worse than no
//     edge). So `--accept --agent` is always refused, and `--reject --agent` is
//     refused unless the candidate is mechanically invalid.
//   - A HUMAN (no `--agent`) is the authority: both verbs proceed unconditionally.
//
// The network boundary (control is a separate process) is injected via KbReviewDeps
// so the policy gate is asserted without a live control: the test proves which
// calls fire (fetchCandidate / submitVerdict) and which are refused before any
// mutation.

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
    evidenceJson: { sourceQuote: "a quote", targetQuote: "b quote", reasoning: "because" },
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...over,
  };
}

describe("mla kb review: arg parsing", () => {
  it("parses an id plus --accept", () => {
    expect(parseKbReviewArgs(["c123", "--accept"])).toEqual({
      candidateId: "c123",
      verdict: "accept",
      note: null,
      agent: false,
    });
  });

  it("parses an id plus --reject plus --note plus --agent", () => {
    expect(parseKbReviewArgs(["c123", "--reject", "--note", "junk edge", "--agent"])).toEqual({
      candidateId: "c123",
      verdict: "reject",
      note: "junk edge",
      agent: true,
    });
  });

  it("requires exactly one of --accept / --reject (neither)", () => {
    expect(() => parseKbReviewArgs(["c123"])).toThrow(/--accept or --reject/);
  });

  it("requires exactly one of --accept / --reject (both)", () => {
    expect(() => parseKbReviewArgs(["c123", "--accept", "--reject"])).toThrow(/exactly one/i);
  });

  it("requires a candidate id", () => {
    expect(() => parseKbReviewArgs(["--accept"])).toThrow(/Usage/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseKbReviewArgs(["c123", "--accept", "--bogus"])).toThrow(/Unknown flag/);
  });

  it("rejects a second positional", () => {
    expect(() => parseKbReviewArgs(["c1", "c2", "--accept"])).toThrow(/extra/i);
  });

  it("rejects --note with no value", () => {
    expect(() => parseKbReviewArgs(["c123", "--reject", "--note"])).toThrow(/--note requires a value/);
  });

  // A-2 write-side: --reclassify / --no-relation map to the propose-correction verb.
  it("parses --reclassify <TYPE> into a RELATION_TYPE_CORRECTION", () => {
    expect(parseKbReviewArgs(["c123", "--reclassify", "REFINES"])).toEqual({
      candidateId: "c123",
      verdict: "propose-correction",
      note: null,
      agent: false,
      correction: {
        correctionKind: "RELATION_TYPE_CORRECTION",
        correctedRelationType: "REFINES",
      },
    });
  });

  it("uppercases a lowercase --reclassify type (control owns the authoritative set)", () => {
    const out = parseKbReviewArgs(["c123", "--reclassify", "refines"]);
    expect(out.correction?.correctedRelationType).toBe("REFINES");
  });

  it("rejects a malformed --reclassify value (shape only; not the registry)", () => {
    expect(() => parseKbReviewArgs(["c123", "--reclassify", "bad type!"])).toThrow(/relation type/i);
  });

  it("rejects --reclassify with no value", () => {
    expect(() => parseKbReviewArgs(["c123", "--reclassify"])).toThrow(/--reclassify requires/);
    expect(() => parseKbReviewArgs(["c123", "--reclassify", "--agent"])).toThrow(/--reclassify requires/);
  });

  it("parses --no-relation into a NO_RELATION correction with no corrected type", () => {
    expect(parseKbReviewArgs(["c123", "--no-relation"])).toEqual({
      candidateId: "c123",
      verdict: "propose-correction",
      note: null,
      agent: false,
      correction: { correctionKind: "NO_RELATION" },
    });
  });

  it("parses --reclassify + --scope-section into a section-scoped SCOPE_CORRECTION", () => {
    expect(parseKbReviewArgs(["c123", "--reclassify", "REFINES", "--scope-section", "## Goals"])).toEqual({
      candidateId: "c123",
      verdict: "propose-correction",
      note: null,
      agent: false,
      correction: {
        correctionKind: "SCOPE_CORRECTION",
        correctedRelationType: "REFINES",
        scopeKind: "SECTION",
        sourceSectionPath: "## Goals",
      },
    });
  });

  it("rejects --scope-section without --reclassify (a scope correction still needs the type)", () => {
    expect(() => parseKbReviewArgs(["c123", "--no-relation", "--scope-section", "## Goals"])).toThrow(
      /--scope-section requires --reclassify/,
    );
  });

  it("rejects --scope-section with no value", () => {
    expect(() => parseKbReviewArgs(["c123", "--reclassify", "REFINES", "--scope-section"])).toThrow(
      /--scope-section requires a value/,
    );
  });

  it("rejects combining a correction verb with --accept / --reject", () => {
    expect(() => parseKbReviewArgs(["c123", "--accept", "--reclassify", "REFINES"])).toThrow(/exactly one/i);
    expect(() => parseKbReviewArgs(["c123", "--reject", "--no-relation"])).toThrow(/exactly one/i);
    expect(() => parseKbReviewArgs(["c123", "--reclassify", "REFINES", "--no-relation"])).toThrow(/exactly one/i);
  });
});

describe("kb-candidate classifyMechanicalInvalidity", () => {
  it("flags a self-edge (same artifact on both ends) regardless of confidence", () => {
    const v = classifyMechanicalInvalidity(
      cand({ sourceArtifactId: "note:x.md", targetArtifactId: "note:x.md", confidence: 0.99 }),
    );
    expect(v.autoRejectable).toBe(true);
    expect(v.reasonCode).toBe("self_edge");
  });

  it("flags very-low confidence with NO supporting quote", () => {
    const v = classifyMechanicalInvalidity(
      cand({
        confidence: AUTO_REJECT_CONFIDENCE_FLOOR - 0.05,
        evidenceJson: { sourceQuote: "", targetQuote: null, reasoning: "thin" },
      }),
    );
    expect(v.autoRejectable).toBe(true);
    expect(v.reasonCode).toBe("low_confidence_no_quote");
  });

  it("does NOT flag low confidence when a supporting quote is present (quote saves it)", () => {
    const v = classifyMechanicalInvalidity(
      cand({
        confidence: AUTO_REJECT_CONFIDENCE_FLOOR - 0.05,
        evidenceJson: { sourceQuote: "a real quote", targetQuote: null },
      }),
    );
    expect(v.autoRejectable).toBe(false);
    expect(v.reasonCode).toBeNull();
  });

  it("does NOT flag a normal, distinct-endpoint candidate", () => {
    expect(classifyMechanicalInvalidity(cand()).autoRejectable).toBe(false);
  });

  it("does NOT flag a unary candidate with a null target as a self-edge", () => {
    const v = classifyMechanicalInvalidity(
      cand({ targetArtifactId: null, targetType: null }),
    );
    expect(v.reasonCode).not.toBe("self_edge");
  });
});

describe("evaluateReviewPolicy: human is the authority", () => {
  it("human accept proceeds and passes the note through", () => {
    const d = evaluateReviewPolicy({ candidateId: "c1", verdict: "accept", agent: false, note: "ok" });
    expect(d).toEqual({ action: "proceed", note: "ok" });
  });

  it("human reject proceeds with no note", () => {
    const d = evaluateReviewPolicy({ candidateId: "c1", verdict: "reject", agent: false, note: null });
    expect(d).toEqual({ action: "proceed", note: undefined });
  });
});

describe("evaluateReviewPolicy: agent proxy is reject-only and mechanically gated (P2)", () => {
  it("refuses agent --accept always (auto-accept disallowed)", () => {
    const d = evaluateReviewPolicy({ candidateId: "c1", verdict: "accept", agent: true, note: null });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.exitCode).toBe(2);
      expect(d.message).toMatch(/human must accept/i);
    }
  });

  it("allows agent --reject on a mechanically-invalid candidate and stamps the reason", () => {
    const d = evaluateReviewPolicy({
      candidateId: "c1",
      verdict: "reject",
      agent: true,
      note: null,
      candidate: cand({ sourceArtifactId: "note:x.md", targetArtifactId: "note:x.md" }),
    });
    expect(d.action).toBe("proceed");
    if (d.action === "proceed") {
      expect(d.note).toMatch(/auto-reject:self_edge/);
    }
  });

  it("combines the operator note with the auto-reject reason without a double-dash", () => {
    const d = evaluateReviewPolicy({
      candidateId: "c1",
      verdict: "reject",
      agent: true,
      note: "obvious junk",
      candidate: cand({ sourceArtifactId: "note:x.md", targetArtifactId: "note:x.md" }),
    });
    if (d.action === "proceed") {
      expect(d.note).toMatch(/auto-reject:self_edge/);
      expect(d.note).toMatch(/obvious junk/);
      expect(d.note).not.toContain("--");
    } else {
      throw new Error("expected proceed");
    }
  });

  it("refuses agent --reject on a semantically-valid candidate (surface to human)", () => {
    const d = evaluateReviewPolicy({
      candidateId: "c1",
      verdict: "reject",
      agent: true,
      note: null,
      candidate: cand(),
    });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.exitCode).toBe(2);
      expect(d.message).toMatch(/not mechanically invalid/i);
    }
  });

  it("refuses agent --reject when the candidate cannot be fetched (not found)", () => {
    const d = evaluateReviewPolicy({
      candidateId: "c1",
      verdict: "reject",
      agent: true,
      note: null,
      candidate: null,
    });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.exitCode).toBe(1);
  });

  // A-2 write-side: propose-correction is propose-only (no live-graph edit; a human
  // applies it later), so it is ALWAYS allowed -- this is the whole point of the
  // agent-proxy flow ("agent proposes; user applies"). It must NOT be gated like
  // accept (human-only) or reject (mechanically-gated for an agent).
  it("allows propose-correction for a human (proceeds, note passed through)", () => {
    const d = evaluateReviewPolicy({
      candidateId: "c1",
      verdict: "propose-correction",
      agent: false,
      note: "should be REFINES",
    });
    expect(d).toEqual({ action: "proceed", note: "should be REFINES" });
  });

  it("allows propose-correction for an agent proxy (proceeds without any fetch/gate)", () => {
    const d = evaluateReviewPolicy({
      candidateId: "c1",
      verdict: "propose-correction",
      agent: true,
      note: null,
    });
    expect(d).toEqual({ action: "proceed", note: undefined });
  });
});

interface Recorder {
  fetched: string[];
  submitted: Array<{ id: string; verdict: string; body: unknown }>;
  corrections: Array<{ id: string; body: unknown }>;
}

function deps(over: Partial<KbReviewDeps> & { candidate?: RelationshipCandidate | null; throwStatus?: number } = {}): {
  deps: KbReviewDeps;
  rec: Recorder;
} {
  const rec: Recorder = { fetched: [], submitted: [], corrections: [] };
  const d: KbReviewDeps = {
    fetchCandidate: async (id) => {
      rec.fetched.push(id);
      return over.candidate === undefined ? cand({ id }) : over.candidate;
    },
    submitVerdict: async (id, verdict, body) => {
      rec.submitted.push({ id, verdict, body });
      if (over.throwStatus) {
        const e = new Error(`HTTP ${over.throwStatus}`) as Error & { status?: number; body: string };
        e.status = over.throwStatus;
        e.body = "";
        throw e;
      }
      return { id, statusId: verdict === "accept" ? "ACCEPTED" : "REJECTED" };
    },
    submitCorrection: async (id, body) => {
      rec.corrections.push({ id, body });
      if (over.throwStatus) {
        const e = new Error(`HTTP ${over.throwStatus}`) as Error & { status?: number; body: string };
        e.status = over.throwStatus;
        e.body = "";
        throw e;
      }
      const correction = (body as { correction: { correctionKind: string; correctedRelationType?: string } }).correction;
      return {
        id: "rrc_" + id,
        candidateId: id,
        correctionKindId: correction.correctionKind,
        correctedRelationTypeKey: correction.correctedRelationType ?? "__NO_RELATION__",
        curationStatusId: "PROPOSED",
        graphApplicationStatusId: "NOT_APPLIED",
        deduped: false,
      };
    },
    ...(over.fetchCandidate ? { fetchCandidate: over.fetchCandidate } : {}),
    ...(over.submitVerdict ? { submitVerdict: over.submitVerdict } : {}),
    ...(over.submitCorrection ? { submitCorrection: over.submitCorrection } : {}),
  };
  return { deps: d, rec };
}

const CTX = { workspaceId: "ws_test", actorUserId: "user_an", consoleBase: "https://console.example.test" };

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

describe("runKbReviewWith: end-to-end wiring + exit codes", () => {
  it("human accept submits an accept verdict stamped with the actor (the policy gate needs no candidate, so nothing is fetched)", async () => {
    const { deps: d, rec } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--accept"], CTX, d));
    expect(res.code).toBe(0);
    // A human verdict consults no candidate row: the policy gate is pure and the
    // client no longer derives any analytics, so the accept path never fetches.
    expect(rec.fetched).toHaveLength(0);
    expect(rec.submitted).toHaveLength(1);
    expect(rec.submitted[0].verdict).toBe("accept");
    expect(rec.submitted[0].body).toEqual({ workspaceId: "ws_test", userId: "user_an" });
    expect(res.stdout).toMatch(/ACCEPTED/);
    // Deep link pins the active workspace via /open; the relative path is URL-encoded.
    expect(res.stdout).toContain(
      `https://console.example.test/open?workspaceId=ws_test&to=%2Frelationships%2F${cand().id}`,
    );
  });

  // A-0 (A4 surface 1): an accept is a governed change. The CLI caller is unknown
  // (human or agent run the identical command), so the success footer dual-addresses
  // both: it records that the accept carried the user's authority and reminds an agent
  // that the UX default is to propose rather than run --accept directly.
  it("accept footer carries the dual-audience governed-change note", async () => {
    const { deps: d } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--accept"], CTX, d));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/user's authority/i);
    expect(res.stdout).toMatch(/propose/i);
  });

  it("reject footer does NOT carry the governed-change note (reject is freely allowed)", async () => {
    const { deps: d } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--reject"], CTX, d));
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/user's authority/i);
  });

  it("human reject with a note submits that note", async () => {
    const { deps: d, rec } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--reject", "--note", "stale"], CTX, d));
    expect(res.code).toBe(0);
    expect(rec.submitted[0].verdict).toBe("reject");
    expect(rec.submitted[0].body).toEqual({ workspaceId: "ws_test", userId: "user_an", note: "stale" });
  });

  it("agent accept is refused before any fetch or submit (exit 2)", async () => {
    const { deps: d, rec } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--accept", "--agent"], CTX, d));
    expect(res.code).toBe(2);
    expect(rec.fetched).toHaveLength(0);
    expect(rec.submitted).toHaveLength(0);
    expect(res.stderr).toMatch(/human must accept/i);
  });

  it("agent reject on a semantically-valid candidate fetches but never submits (exit 2)", async () => {
    const { deps: d, rec } = deps({ candidate: cand() });
    const res = await capture(() => runKbReviewWith([cand().id, "--reject", "--agent"], CTX, d));
    expect(res.code).toBe(2);
    expect(rec.fetched).toHaveLength(1);
    expect(rec.submitted).toHaveLength(0);
    expect(res.stderr).toMatch(/not mechanically invalid/i);
  });

  it("agent reject on a self-edge candidate submits a reject with the auto-reject reason (exit 0)", async () => {
    const selfEdge = cand({ sourceArtifactId: "note:x.md", targetArtifactId: "note:x.md" });
    const { deps: d, rec } = deps({ candidate: selfEdge });
    const res = await capture(() => runKbReviewWith([selfEdge.id, "--reject", "--agent"], CTX, d));
    expect(res.code).toBe(0);
    expect(rec.fetched).toHaveLength(1);
    expect(rec.submitted).toHaveLength(1);
    expect(rec.submitted[0].verdict).toBe("reject");
    const body = rec.submitted[0].body as { note?: string };
    expect(body.note).toMatch(/auto-reject:self_edge/);
  });

  it("agent reject when the candidate is missing returns 1 and never submits", async () => {
    const { deps: d, rec } = deps({ candidate: null });
    const res = await capture(() => runKbReviewWith([cand().id, "--reject", "--agent"], CTX, d));
    expect(res.code).toBe(1);
    expect(rec.submitted).toHaveLength(0);
  });

  it("renders a not-found message and returns 1 when control 404s the verdict", async () => {
    const { deps: d } = deps({ throwStatus: 404 });
    const res = await capture(() => runKbReviewWith([cand().id, "--accept"], CTX, d));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/not found/i);
  });

  it("returns 2 on an arg-parse error", async () => {
    const { deps: d } = deps();
    const res = await capture(() => runKbReviewWith([cand().id], CTX, d));
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/--accept or --reject/);
  });
});

describe("runKbReviewWith: propose-correction (A-2 write-side)", () => {
  it("human --reclassify submits a correction to the propose-correction boundary (not the verdict one)", async () => {
    const { deps: d, rec } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--reclassify", "REFINES"], CTX, d));
    expect(res.code).toBe(0);
    expect(rec.submitted).toHaveLength(0); // never hits the accept/reject primitive
    // corrections need no mechanical classification, so the policy path fetches
    // nothing; with the client-side analytics gone, the propose path never fetches.
    expect(rec.fetched).toHaveLength(0);
    expect(rec.corrections).toHaveLength(1);
    expect(rec.corrections[0].body).toEqual({
      workspaceId: "ws_test",
      userId: "user_an",
      correction: { correctionKind: "RELATION_TYPE_CORRECTION", correctedRelationType: "REFINES" },
    });
    expect(res.stdout).toMatch(/proposed/i);
    expect(res.stdout).toMatch(/REFINES/);
    expect(res.stdout).toContain(
      `https://console.example.test/open?workspaceId=ws_test&to=%2Frelationships%2F${cand().id}`,
    );
  });

  it("--reclassify carries an optional reviewer note alongside the structured correction", async () => {
    const { deps: d, rec } = deps();
    await capture(() =>
      runKbReviewWith([cand().id, "--reclassify", "REFINES", "--note", "narrower claim"], CTX, d),
    );
    expect(rec.corrections[0].body).toEqual({
      workspaceId: "ws_test",
      userId: "user_an",
      note: "narrower claim",
      correction: { correctionKind: "RELATION_TYPE_CORRECTION", correctedRelationType: "REFINES" },
    });
  });

  it("--no-relation proposes a NO_RELATION correction", async () => {
    const { deps: d, rec } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--no-relation"], CTX, d));
    expect(res.code).toBe(0);
    expect(rec.corrections[0].body).toEqual({
      workspaceId: "ws_test",
      userId: "user_an",
      correction: { correctionKind: "NO_RELATION" },
    });
  });

  it("an AGENT may propose a correction (propose-only is always allowed)", async () => {
    const { deps: d, rec } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--reclassify", "REFINES", "--agent"], CTX, d));
    expect(res.code).toBe(0);
    expect(rec.corrections).toHaveLength(1);
  });

  it("--reclassify + --scope-section submits a section-scoped SCOPE_CORRECTION", async () => {
    const { deps: d, rec } = deps();
    await capture(() =>
      runKbReviewWith([cand().id, "--reclassify", "REFINES", "--scope-section", "## Goals"], CTX, d),
    );
    expect(rec.corrections[0].body).toEqual({
      workspaceId: "ws_test",
      userId: "user_an",
      correction: {
        correctionKind: "SCOPE_CORRECTION",
        correctedRelationType: "REFINES",
        scopeKind: "SECTION",
        sourceSectionPath: "## Goals",
      },
    });
  });

  it("a propose-correction footer does NOT claim the user's authority (it is propose-only, not a governed live change)", async () => {
    const { deps: d } = deps();
    const res = await capture(() => runKbReviewWith([cand().id, "--reclassify", "REFINES"], CTX, d));
    expect(res.stdout).not.toMatch(/user's authority/i);
  });

  it("surfaces a deduped re-proposal without claiming a new record", async () => {
    const { deps: d } = deps({
      submitCorrection: async (id) => ({
        id: "rrc_" + id,
        candidateId: id,
        correctionKindId: "RELATION_TYPE_CORRECTION",
        correctedRelationTypeKey: "REFINES",
        curationStatusId: "PROPOSED",
        graphApplicationStatusId: "NOT_APPLIED",
        deduped: true,
      }),
    });
    const res = await capture(() => runKbReviewWith([cand().id, "--reclassify", "REFINES"], CTX, d));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/dedup|already/i);
  });

  it("returns 1 when control 404s the correction", async () => {
    const { deps: d } = deps({ throwStatus: 404 });
    const res = await capture(() => runKbReviewWith([cand().id, "--reclassify", "REFINES"], CTX, d));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/not found/i);
  });
});
