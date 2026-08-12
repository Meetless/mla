import {
  renderKbAddReceipt,
  renderKbShow,
  renderKbPurgeReceipt,
  type KbAddReceipt,
  type KbShowView,
  type KbPurgeReceipt,
} from "../../src/lib/render";

// B1 (notes/20260603-mla-kb-agent-proxy §3 Track B, §7.4): the `kb add` receipt
// must state that relationship extraction is queued/async (or, in sync mode,
// report its result). A bare `outbox event: KB_INGESTED` is provenance, not a
// user signal about what happens next. These tests lock the honesty contract.

function baseReceipt(): KbAddReceipt {
  return {
    mode: "file",
    workspaceId: "ws_an_local",
    outcome: "ingested",
    documentId: "kbdoc_1",
    canonicalPath: "notes/foo.md",
    parentUuid: "uuid-1",
    provenance: "external_imported",
    revisionId: "rev_1",
    revisionStatus: "ACTIVE",
    chunkCount: 4,
    normalizedBodyHash: "abc123def456",
    fullDocumentHash: "def456abc789",
    outboxEventType: "KB_INGESTED",
  };
}

describe("renderKbAddReceipt B1 extraction honesty", () => {
  // The lane changed under this block. `mla kb add` used to report the whole-doc
  // GRAPH_EXTRACT relationship lane, which An retired 2026-06-26 because nothing
  // consumed its accepted candidates. The claim-grain ONTOLOGY_EXTRACT job is the
  // only mining lane left, so the receipt reports CLAIMS and points at
  // `mla kb claims --pending`, the queue that actually fills.
  //
  // These assertions used to demand the word "relationship". Keeping them would have
  // pinned the receipt to a lane that no longer runs, which is how the old poll
  // survived: every test agreed with it, and none of them talked to the server.

  it("states claim extraction is queued/async on a fresh ingest that enqueued a job", () => {
    const r = baseReceipt();
    r.extractionJobId = "job-1";
    const out = renderKbAddReceipt(r);
    expect(out.toLowerCase()).toContain("claim");
    expect(out.toLowerCase()).toMatch(/queued|extracting|async/);
  });

  it("does not leave a bare outbox event as the only post-ingest signal", () => {
    const r = baseReceipt();
    r.extractionJobId = "job-1";
    const out = renderKbAddReceipt(r);
    expect(out.includes("KB_INGESTED") && /claim/i.test(out)).toBe(true);
  });

  it("says UNKNOWN, never queued, when the ingest produced no job to poll", () => {
    // THE REGRESSION THIS BLOCK MISSED. With no job id there is nothing to watch,
    // and printing the queued sentence there is exactly what made a dead poll
    // indistinguishable from a slow one on every successful add for months.
    const out = renderKbAddReceipt(baseReceipt());
    expect(out.toLowerCase()).toContain("unknown");
    expect(out.toLowerCase()).not.toMatch(/extraction queued|claim extraction queued/);
  });

  it("renders the real extraction result when the poll resolves it", () => {
    const r = baseReceipt();
    r.extractionJobId = "job-1";
    r.extraction = { state: "completed", candidateCount: 3, conflictCount: 0 };
    const out = renderKbAddReceipt(r);
    expect(out).toMatch(/3 claims awaiting review/i);
    expect(out).toMatch(/mla kb claims --pending/);
  });

  it("distinguishes 'completed with zero claims' from 'status never arrived'", () => {
    // The two sentences the old renderer collapsed. A terminal empty extraction is a
    // finished fact; an unknown status is a missing one, and they call for opposite
    // operator actions.
    const done = baseReceipt();
    done.extractionJobId = "job-1";
    done.extraction = { state: "completed", candidateCount: 0, conflictCount: 0 };
    const doneOut = renderKbAddReceipt(done);
    expect(doneOut).toMatch(/no claims staged/i);
    expect(doneOut.toLowerCase()).not.toContain("unknown");

    const unknownOut = renderKbAddReceipt(baseReceipt());
    expect(unknownOut.toLowerCase()).toContain("unknown");
    expect(unknownOut).not.toMatch(/no claims staged/i);
  });

  it("reports a failed extraction as failed, with a retry that exists", () => {
    const r = baseReceipt();
    r.extractionJobId = "job-1";
    r.extraction = { state: "failed", candidateCount: null, conflictCount: null };
    const out = renderKbAddReceipt(r);
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/mla kb reingest/);
  });

  it("never points the operator at the retired relationship queue", () => {
    for (const st of ["queued", "running", "completed", "failed", "unknown"] as const) {
      const r = baseReceipt();
      r.extraction = { state: st, candidateCount: 0, conflictCount: 0 };
      const out = renderKbAddReceipt(r);
      expect(out).not.toMatch(/`mla kb pending`/);
      expect(out).not.toMatch(/CONTRADICTS\/SUPERSEDES/);
    }
  });


  it("reports a failed extraction with a retry pointer", () => {
    const r = baseReceipt();
    r.extraction = { state: "failed" };
    const out = renderKbAddReceipt(r);
    expect(out.toLowerCase()).toContain("fail");
    expect(out).toMatch(/reingest|retry/i);
  });

  it("does not claim extraction for a content-identical no-op (nothing minted)", () => {
    const r = baseReceipt();
    r.outcome = "noop_unchanged";
    r.revisionId = null;
    r.revisionStatus = null;
    const out = renderKbAddReceipt(r);
    expect(out.toLowerCase()).not.toContain("extraction queued");
  });

  it("does not claim extraction on a failed ingest", () => {
    const r = baseReceipt();
    r.outcome = "failed";
    r.failure = { code: "INGEST_ERROR", reason: "boom", failedAt: "2026-06-04T00:00:00Z" };
    const out = renderKbAddReceipt(r);
    expect(out.toLowerCase()).not.toContain("extraction queued");
  });
});

// Reshaped detail bundle (kb-console re-home, notes/20260621-kb-console-rehome-two-axis.md
// §3.2): the renderer consumes a document-centric view. Relationship edges (the
// old candidates / promoted-edge sections) and the GRAPH_EXTRACT status moved to
// the Console navigation lane and are NOT part of this view. What the renderer
// must surface instead: the governed-liveness rollup (serving / servingStatus)
// and the derived claim rail.

function baseShowView(): KbShowView {
  return {
    workspaceId: "ws_an_local",
    document: {
      id: "kbdoc_1",
      ownerUserId: "u_an",
      sourceSystem: "notes",
      sourceTenantId: "an",
      externalObjectId: "notes/foo.md",
      scope: "PERSON",
      currentRevisionId: "rev_1",
      headGeneration: 1,
      tombstoneState: "ACTIVE",
    },
    serving: true,
    servingStatus: "SERVING",
    headRevision: {
      id: "rev_1",
      status: "ACTIVE",
      reviewOutcome: "ACCEPTED",
      provenance: "operator_curated",
      actorType: "human",
      scopeAtIngest: "PERSON",
      rawContentHash: "raw000",
      normalizedContentHash: "norm000",
      contentNormalizationVersion: "v1",
      externalRevisionId: null,
      redactionState: "NONE",
      reviewedBy: null,
      reviewedAt: null,
      createdAt: "2026-06-04T00:00:00Z",
    },
    revisionHistory: [],
    revisionHistoryTruncated: false,
    chunks: { totalCount: 0, totalBytes: 0, preview: [] },
    claims: { totalCount: 0, preview: [] },
    audit: [],
    auditTruncated: false,
  };
}

describe("renderKbShow reshaped bundle (governed-liveness + claims)", () => {
  it("surfaces the serving rollup, never re-deriving it", () => {
    const out = renderKbShow(baseShowView());
    expect(out).toContain("GROUNDING");
    expect(out).toMatch(/serving:\s*YES/i);
    expect(out).toContain("SERVING");
  });

  it("renders a NOT-serving posture honestly when there is no activated head", () => {
    const v = baseShowView();
    v.serving = false;
    v.servingStatus = "NO_HEAD";
    v.headRevision = null;
    const out = renderKbShow(v);
    expect(out).toMatch(/serving:\s*NO/i);
    expect(out).toContain("NO_HEAD");
    expect(out.toLowerCase()).toContain("no activated head");
  });

  it("renders the claim rail with the lifecycle/trust/grounding tri-state", () => {
    const v = baseShowView();
    v.claims = {
      totalCount: 1,
      preview: [
        {
          id: "clm_1",
          kind: "ATOMIC",
          groundingStatus: "GROUNDED",
          reviewOutcome: null,
          lifecycleStatus: "ACTIVE",
          preview: "The doctrine asserts durable value.",
        },
      ],
    };
    const out = renderKbShow(v);
    expect(out).toContain("CLAIMS  (1)");
    expect(out).toContain("[ACTIVE/unreviewed/GROUNDED]");
    expect(out).toContain("The doctrine asserts durable value.");
  });

  it("shows a truncation hint when the claim rail exceeds the preview cap", () => {
    const v = baseShowView();
    v.claims = {
      totalCount: 12,
      preview: Array.from({ length: 8 }, (_v, i) => ({
        id: `clm_${i}`,
        kind: "ATOMIC",
        groundingStatus: "GROUNDED",
        reviewOutcome: null,
        lifecycleStatus: "ACTIVE",
        preview: `claim ${i}`,
      })),
    };
    const out = renderKbShow(v);
    expect(out).toContain("CLAIMS  (12)");
    expect(out).toContain("... and 4 more");
  });

  it("does not render the removed relationship-edge sections", () => {
    const out = renderKbShow(baseShowView());
    expect(out).not.toContain("CANDIDATES TOUCHING THIS DOC");
    expect(out).not.toContain("PROMOTED EDGES");
  });
});

// B4a (notes/20260603-mla-kb-agent-proxy §3 Track B, §6 #5, §7.2): both the
// `kb add` receipt and `kb show` must ALWAYS print the clickable Console review
// URL so the operator can jump to the human surface for anything visual. The
// renderer stays pure (no config / env access); the command layer computes the
// URL via getConsoleUrl(cfg) and hands it in. Auto-open is NOT a render concern
// (the renderer cannot launch a browser); B4a is print-only.

describe("renderKbAddReceipt B4a console URL", () => {
  it("prints the Console review URL when the command layer provides it", () => {
    const r = baseReceipt();
    r.consoleUrl = "https://console.example.test/relationships";
    const out = renderKbAddReceipt(r);
    expect(out).toContain("https://console.example.test/relationships");
    expect(out.toLowerCase()).toContain("console");
  });

  it("does not crash or print a stray label when no console URL is set", () => {
    const r = baseReceipt();
    const out = renderKbAddReceipt(r);
    // No URL means no console line; the receipt still renders the next: hint.
    expect(out).not.toMatch(/console:\s*$/m);
    expect(out).toContain("next:");
  });

  it("prints the console URL even on a failed ingest (operator can still review)", () => {
    const r = baseReceipt();
    r.outcome = "failed";
    r.failure = { code: "INGEST_ERROR", reason: "boom", failedAt: "2026-06-04T00:00:00Z" };
    r.consoleUrl = "https://console.example.test/relationships";
    const out = renderKbAddReceipt(r);
    expect(out).toContain("https://console.example.test/relationships");
  });
});

describe("renderKbShow B4a console URL", () => {
  it("prints the Console review URL when the command layer provides it", () => {
    const v = baseShowView();
    v.consoleUrl = "https://console.example.test/relationships";
    const out = renderKbShow(v);
    expect(out).toContain("https://console.example.test/relationships");
    expect(out.toUpperCase()).toContain("CONSOLE");
  });

  it("renders fine (no stray CONSOLE block) when no console URL is set", () => {
    const v = baseShowView();
    const out = renderKbShow(v);
    expect(out).not.toMatch(/^\s*CONSOLE\s*$/m);
  });

  it("does not auto-open: the URL is printed as text, not launched", () => {
    // Guard against a future regression that shells out to `open`. The render
    // layer is pure text; assert the URL appears verbatim and nothing more.
    const v = baseShowView();
    v.consoleUrl = "https://console.example.test/relationships";
    const out = renderKbShow(v);
    expect(typeof out).toBe("string");
    expect(out).toContain("https://console.example.test/relationships");
  });
});

// Slice-A cutover lock for the `mla kb purge` receipt: purge = redact every
// revision + tombstone the document. The renderer must reflect the governed
// shape (revision counts + tombstoneState) and must NOT resurrect the dead
// posture-era machinery (phase1_committed/blocked outcome, --force banner,
// chunks-tombstoned / weaviate / graph-cleanup job lines, blocking/dropped
// edges). It must also be honest that the doc is TOMBSTONED, not PURGED.

function basePurgeReceipt(): KbPurgeReceipt {
  return {
    workspaceId: "ws_an_local",
    outcome: "purged",
    documentId: "kbdoc_1",
    canonicalPath: "notes/foo.md",
    priorRevisionId: "rev_2",
    revisionsTotal: 2,
    revisionsRedacted: 2,
    revisionsAlreadyRedacted: 0,
    tombstoneState: "TOMBSTONED",
    reason: "stale duplicate, superseded by canonical doc",
  };
}

describe("renderKbPurgeReceipt slice-A governed shape", () => {
  it("renders the governed redact-all + tombstone summary", () => {
    const out = renderKbPurgeReceipt(basePurgeReceipt());
    expect(out).toContain("mla kb purge");
    expect(out).toContain("purged");
    expect(out).toContain("kbdoc_1");
    expect(out).toContain("notes/foo.md");
    expect(out).toContain("TOMBSTONED");
    expect(out).toMatch(/revisions redacted:\s*2/i);
    expect(out).toContain("stale duplicate, superseded by canonical doc");
  });

  it("is honest that the doc is TOMBSTONED, not PURGED (no physical-purge primitive)", () => {
    const out = renderKbPurgeReceipt(basePurgeReceipt());
    expect(out.toLowerCase()).toMatch(/tombstoned rather than purged|no physical-purge/);
  });

  it("does not resurrect dead posture-era machinery", () => {
    const out = renderKbPurgeReceipt(basePurgeReceipt());
    expect(out.toLowerCase()).not.toContain("--force");
    expect(out.toLowerCase()).not.toContain("weaviate");
    expect(out.toLowerCase()).not.toContain("graph");
    expect(out.toLowerCase()).not.toContain("hard_delete_pending");
    expect(out.toLowerCase()).not.toContain("blocking edges");
    expect(out.toLowerCase()).not.toContain("phase-1");
  });

  it("renders the idempotent already_purged outcome distinctly", () => {
    const r = basePurgeReceipt();
    r.outcome = "already_purged";
    r.revisionsRedacted = 0;
    r.revisionsAlreadyRedacted = 2;
    const out = renderKbPurgeReceipt(r);
    expect(out).toContain("already_purged");
    expect(out.toLowerCase()).toMatch(/already redacted|nothing to do/);
  });
});

// ---------------------------------------------------------------------------
// `noop_unchanged` was one word for two opposite states.
//
// Measured 2026-08-07 against the real CLI: `mla kb add` on a 350 KB note that is
// present on disk printed `outcome: noop_unchanged`, `revisionId: (unset)`,
// `chunk count: 0`. An operator reads that as "already governed, nothing to do".
// The truth was the opposite: the document is TOMBSTONED, so it is not chunked, not
// retrievable, and not governed at all. A healthy already-current document prints a
// byte-identical receipt, so the two could not be told apart from the surface the
// operator uses. That note sat in a coverage backlog looking like an unexplained
// failure until the tombstone was found by querying the database directly.
//
// Declining to revive a tombstoned document stays the governed behaviour and is
// correct. Only the silence is fixed.
// ---------------------------------------------------------------------------
describe("kb add receipt: a no-op says WHY when the answer is not 'nothing changed'", () => {
  const base = {
    mode: "file" as const,
    workspaceId: "ws_1",
    outcome: "noop_unchanged",
    documentId: "doc_1",
    canonicalPath: "notes/x.md",
    parentUuid: "doc_1",
    provenance: "human_authored",
    revisionId: null,
    revisionStatus: null,
    chunkCount: 0,
    normalizedBodyHash: null,
    fullDocumentHash: null,
    outboxEventType: null,
  };

  it("names the tombstone, so the reader knows the document is NOT served", () => {
    const out = renderKbAddReceipt({ ...base, noopReason: "tombstoned" } as any);

    expect(out).toMatch(/no-op reason:\s+tombstoned/);
    // And it must not read as an error: a tombstone is a governed decision, not a
    // transport failure, so the failure channel stays untouched.
    expect(out).not.toContain("FAILED");
  });

  it("an ordinary no-op grows no line at all", () => {
    // The common case is a content-identical re-delivery of a healthy document.
    // That is not a finding and must not acquire a field that reads as one.
    const out = renderKbAddReceipt(base as any);

    expect(out).not.toMatch(/no-op reason/);
  });
});
