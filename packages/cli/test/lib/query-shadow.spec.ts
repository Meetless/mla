import { compareEvidence, formatShadow, runQueryShadow } from "../../src/lib/query-shadow";

const legacyWith = (citations: unknown[]) => ({ answer: "prose", citations });

describe("compareEvidence", () => {
  it("calls the SAME governed evidence the same, across the two vocabularies", () => {
    // The legacy shape is one flat object per source class; the canonical one is a `ref`
    // string. Same evidence, two spellings, and the comparison is the point of D0.
    const cmp = compareEvidence(
      legacyWith([{ note_path: "notes/x.md" }, { diff_id: "cc_1" }]),
      { citations: [{ ref: "CC:cc_1" }, { ref: "NT:notes/x.md" }] },
    );
    expect(cmp.same).toBe(true);
    expect(cmp.onlyLegacy).toEqual([]);
    expect(cmp.onlyCanonical).toEqual([]);
  });

  it("does NOT compare prose, because the model is non-deterministic", () => {
    // Diffing answers would produce a permanent stream of false alarms that teaches
    // everyone to ignore the log. The `evals/ask` conflict suite already flips rows across
    // identical runs; that is a property of the model, not a regression.
    const cmp = compareEvidence(
      { answer: "one wording", citations: [{ note_path: "notes/x.md" }] },
      { answer: "a completely different wording", citations: [{ ref: "NT:notes/x.md" }] },
    );
    expect(cmp.same).toBe(true);
  });

  it("names what each side has that the other does not", () => {
    const cmp = compareEvidence(
      legacyWith([{ note_path: "notes/x.md" }, { diff_id: "cc_gone" }]),
      { citations: [{ ref: "NT:notes/x.md" }, { ref: "TH:th_new" }] },
    );
    expect(cmp.same).toBe(false);
    expect(cmp.onlyLegacy).toEqual(["CC:cc_gone"]);
    expect(cmp.onlyCanonical).toEqual(["TH:th_new"]);
  });

  it("reads a current_thread citation the same way the tier does", () => {
    const cmp = compareEvidence(
      legacyWith([{ channel_id: "C1", thread_ts: "1699.1" }]),
      { citations: [{ ref: "TH:C1:1699.1" }] },
    );
    expect(cmp.same).toBe(true);
  });

  it("treats two empty evidence sets as agreement, not as a missing comparison", () => {
    expect(compareEvidence(legacyWith([]), { citations: [] }).same).toBe(true);
  });
});

describe("runQueryShadow never affects the real answer", () => {
  it("does nothing when disabled", async () => {
    const cmp = await runQueryShadow({
      enabled: false,
      platformUrl: "http://127.0.0.1:3020",
      accessToken: "t",
      question: "q",
      legacyResult: legacyWith([]),
    });
    expect(cmp).toEqual({ ran: false, skipped: "disabled" });
  });

  it("SKIPS rather than errors on a shared-key CLI", async () => {
    // "Not applicable" and "broken" are different facts. A skip counted as a failure
    // would hide a real one.
    const cmp = await runQueryShadow({
      enabled: true,
      platformUrl: "http://127.0.0.1:3020",
      accessToken: undefined,
      question: "q",
      legacyResult: legacyWith([]),
    });
    expect(cmp.ran).toBe(false);
    expect(cmp.skipped).toMatch(/shared-key/);
  });

  it("swallows an unreachable tier: a shadow must never fail a real ask", async () => {
    const cmp = await runQueryShadow({
      enabled: true,
      // A port nothing listens on. The real ask has already been rendered by this point.
      platformUrl: "http://127.0.0.1:9",
      accessToken: "t",
      question: "q",
      legacyResult: legacyWith([]),
    });
    expect(cmp.ran).toBe(false);
    expect(cmp.error ?? cmp.skipped).toBeTruthy();
  });
});

describe("formatShadow", () => {
  it("is one greppable line and says whether the evidence matched", () => {
    const line = formatShadow(compareEvidence(legacyWith([{ diff_id: "cc_1" }]), { citations: [{ ref: "CC:cc_1" }] }));
    expect(line).toBe("d0_shadow same=true overlap=1 legacy=1 canonical=1");
  });

  it("names the divergence when there is one, so the log is actionable", () => {
    const line = formatShadow(compareEvidence(legacyWith([{ diff_id: "cc_1" }]), { citations: [] }));
    expect(line).toContain("same=false");
    expect(line).toContain("only_legacy=[CC:cc_1]");
  });

  it("reports a skip as a skip", () => {
    expect(formatShadow({ ran: false, skipped: "disabled" })).toBe("d0_shadow skipped=disabled");
  });
});

describe("the legacy shape the CLI ACTUALLY returns", () => {
  // MEASURED after the shadow's first live run reported `same=false legacy=0 canonical=1`,
  // which looked exactly like a contract regression and was a defect in the comparator:
  // `mla ask` does not return intel's `AskResponse`. It returns ask-core's reshaping,
  // `{ answer, confidence, mode, results, warnings }`, with `results[].path` and no
  // citation object anywhere.
  const cliShape = {
    answer: "the platform tier owns no database",
    confidence: "high",
    mode: "answer",
    warnings: [],
    results: [
      {
        path: "notes/20260816-meetless-platform-api-standardization-proposal.md",
        docType: "note",
        title: "the proposal",
        snippet: "C1: the platform tier owns no database",
      },
    ],
  };

  it("reads ask-core's results[], which is what the CLI produces", () => {
    const cmp = compareEvidence(cliShape, {
      citations: [{ ref: "NT:notes/20260816-meetless-platform-api-standardization-proposal.md" }],
    });
    expect(cmp.same).toBe(true);
  });

  it("still reads intel's citations[], for a caller that hits /v1/ask directly", () => {
    const cmp = compareEvidence({ citations: [{ note_path: "notes/x.md" }] }, { citations: [{ ref: "NT:notes/x.md" }] });
    expect(cmp.same).toBe(true);
  });

  it("does not double-count a source that appears in both shapes", () => {
    const both = { results: [{ path: "notes/x.md" }], citations: [{ note_path: "notes/x.md" }] };
    expect(compareEvidence(both, { citations: [{ ref: "NT:notes/x.md" }] }).legacy).toEqual(["NT:notes/x.md"]);
  });
});


describe("overlap, because one same=false is not a regression", () => {
  // MEASURED 2026-08-20 on one question: three consecutive LEGACY runs returned an
  // identical 4 documents, while four consecutive CANONICAL runs returned 3, 0, 0 and 5.
  // The two paths are two SEPARATE Ask invocations over a model-led retrieval loop, so the
  // variance is in the loop and is present on both sides. A single `same=false` therefore
  // cannot distinguish a contract regression from the loop, and `overlap` is the number
  // that lets a reader tell them apart.
  it("separates near-agreement from total disagreement", () => {
    const near = compareEvidence(
      { results: [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }, { path: "d.md" }] },
      { citations: [{ ref: "NT:a.md" }, { ref: "NT:b.md" }, { ref: "NT:c.md" }, { ref: "NT:e.md" }] },
    );
    const total = compareEvidence(
      { results: [{ path: "a.md" }] },
      { citations: [{ ref: "NT:z.md" }] },
    );

    expect(near.same).toBe(false);
    expect(total.same).toBe(false);
    // Same verdict, very different facts. Zero overlap on a question that returned
    // evidence is worth looking at; three of four shared is the loop.
    expect(near.overlap).toBe(3);
    expect(total.overlap).toBe(0);
  });

  it("puts overlap on the log line, so the distinction survives into the log", () => {
    const line = formatShadow(
      compareEvidence({ results: [{ path: "a.md" }] }, { citations: [{ ref: "NT:z.md" }] }),
    );
    expect(line).toContain("overlap=0");
  });
});
