import {
  planCorpusWithdrawals,
  corpusGlobMatches,
  storedIdInCorpusScope,
  type KbCorpusDocument,
} from "../../src/lib/kb-withdraw-plan";

// Withdrawal reconciliation for a pinned notes corpus.
//
// THE DEFECT THIS PINS. `notes/20260731-proposal-d-intervention-legibility.md` was deleted from
// disk on 2026-08-01. On 2026-08-05 the KB still held it `tombstoneState: ACTIVE`,
// `servingStatus: SERVING`, with the sentence "That is INV-8 and it is correct" intact in a chunk
// and its claim still `lifecycleStatus: ACTIVE`. A session asking what INV-8 requires got the
// deleted document's refuted paraphrase back at high relevance, in the same result set as the
// correction, with no signal telling the two apart.
//
// Nothing in the pipeline noticed the file had left disk. `kb add --mode corpus` enumerates the
// marker-pinned glob, so it ALREADY knows the complete current set; it simply never compared that
// set against what the KB holds. This planner is that comparison, and nothing more.
//
// WHAT WITHDRAWAL MEANS HERE (deliberately narrow): the source is no longer current at its
// authoritative location. It is NOT a claim that the content was refuted. The document survives
// for history and audit; it stops being served as current. That is the same lifecycle act
// `mla kb forget` performs, which is why this routes through `kb/forget` (the route that owns the
// notes keyspace) rather than `kb/withdraw`, whose own contract refuses `sourceSystem=notes` so it
// cannot become a general note-tombstone backdoor.

const NOTES = "notes";

function doc(overrides: Partial<KbCorpusDocument> & { externalObjectId: string }): KbCorpusDocument {
  return {
    documentId: `doc_${overrides.externalObjectId}`,
    sourceSystem: NOTES,
    tombstoneState: "ACTIVE",
    ...overrides,
  };
}

// The corpus is pinned to `notes/**/*.md` under the vault root, mirroring
// `.meetless-kb-corpus.json` for the live `meetless-notes` corpus.
const inScope = (id: string) => id.startsWith("notes/") && id.endsWith(".md");

describe("planCorpusWithdrawals: a source that left disk stops being current", () => {
  it("WITHDRAWS a document present in an earlier scan and absent from a complete one", () => {
    // The reproduced defect, reduced to its decision.
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/20260801-mla-value-program.md"],
      known: [
        doc({ externalObjectId: "notes/20260801-mla-value-program.md" }),
        doc({ externalObjectId: "notes/20260731-proposal-d-intervention-legibility.md" }),
      ],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw.map((d) => d.externalObjectId)).toEqual([
      "notes/20260731-proposal-d-intervention-legibility.md",
    ]);
  });

  it("withdraws ALL five deleted 20260731 proposals in one reconciliation", () => {
    const deleted = [
      "notes/20260731-proposal-a-receipts.md",
      "notes/20260731-proposal-b-receipt-vocabulary.md",
      "notes/20260731-proposal-c-dashboard.md",
      "notes/20260731-proposal-d-intervention-legibility.md",
      "notes/20260731-proposal-review-e.md",
    ];
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/20260801-mla-value-program.md"],
      known: [doc({ externalObjectId: "notes/20260801-mla-value-program.md" }), ...deleted.map((p) => doc({ externalObjectId: p }))],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw.map((d) => d.externalObjectId).sort()).toEqual([...deleted].sort());
  });

  it("leaves a document that is still on disk ACTIVE", () => {
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/a.md", "notes/b.md"],
      known: [doc({ externalObjectId: "notes/a.md" }), doc({ externalObjectId: "notes/b.md" })],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw).toEqual([]);
    expect(plan.keptActive).toBe(2);
  });
});

describe("planCorpusWithdrawals: scope and completeness guards", () => {
  it("WITHDRAWS NOTHING when the scan is not known to be complete", () => {
    // The single stop-condition. A partial scan cannot distinguish "deleted" from "not looked at",
    // and acting on that difference would tombstone live documents. Absent proof of completeness
    // the planner does nothing at all, which is the only safe direction.
    const plan = planCorpusWithdrawals({
      scannedRelPaths: [],
      known: [doc({ externalObjectId: "notes/still-here.md" })],
      scanComplete: false,
      inScope,
    });

    expect(plan.withdraw).toEqual([]);
    expect(plan.abstained).toBe(true);
  });

  it("never touches a document OUTSIDE the scanned source scope", () => {
    // A Jira-captured or agent-memory source is not in this corpus's glob. The scan says nothing
    // about it, so its absence from the scan is not evidence of anything.
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/a.md"],
      known: [
        doc({ externalObjectId: "notes/a.md" }),
        doc({ externalObjectId: "_external/agent-auto-memory/b1/mem.md" }),
        doc({ externalObjectId: "notes/deep/nested.md" }),
      ],
      scanComplete: true,
      inScope: (id) => id.startsWith("notes/") && !id.includes("/deep/"),
    });

    expect(plan.withdraw).toEqual([]);
    expect(plan.outOfScope).toBe(2);
  });

  it("never withdraws a document from a different source system", () => {
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/a.md"],
      known: [doc({ externalObjectId: "notes/a.md" }), doc({ externalObjectId: "notes/jira-ish.md", sourceSystem: "jira" })],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw).toEqual([]);
    expect(plan.outOfScope).toBe(1);
  });

  it("is idempotent: an already-tombstoned document is not withdrawn twice", () => {
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/a.md"],
      known: [
        doc({ externalObjectId: "notes/a.md" }),
        doc({ externalObjectId: "notes/gone.md", tombstoneState: "TOMBSTONED" }),
      ],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw).toEqual([]);
    expect(plan.alreadyWithdrawn).toBe(1);
  });

  it("does not withdraw a PURGED document (terminal, nothing left to forget)", () => {
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/a.md"],
      known: [
        doc({ externalObjectId: "notes/a.md" }),
        doc({ externalObjectId: "notes/purged.md", tombstoneState: "HARD_DELETED" }),
      ],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw).toEqual([]);
  });
});

describe("planCorpusWithdrawals: rename and path identity", () => {
  it("a rename yields old-withdrawn plus new-active, never two active copies", () => {
    // v1 does not detect renames by content. The old path is genuinely absent from its
    // authoritative location and the new path is genuinely present, so both statements are true
    // and the pair is self-consistent. Content-identity carry-over is a later refinement, not a
    // blocker: the failure this prevents (a stale path serving as current) is fixed either way.
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/20260805-renamed.md"],
      known: [
        doc({ externalObjectId: "notes/20260805-original.md" }),
        doc({ externalObjectId: "notes/20260805-renamed.md" }),
      ],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw.map((d) => d.externalObjectId)).toEqual(["notes/20260805-original.md"]);
    expect(plan.keptActive).toBe(1);
  });

  it("matches an absolute scanned path against a repo-relative stored id", () => {
    // The scan yields whatever the caller hands it; the KB stores vault-relative POSIX ids. If
    // these two representations are compared raw, EVERY document looks absent and the planner
    // tombstones the entire corpus. Normalization is the guard against that.
    // A synthetic root, not a real operator home. This repo mirrors publicly and the lint gate
    // scrubs operator literals; the assertion is about prefix stripping and does not care whose
    // machine the path came from.
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["/home/agent/workspace/notes/a.md"],
      known: [doc({ externalObjectId: "notes/a.md" })],
      scanComplete: true,
      inScope,
      repoRoot: "/home/agent/workspace",
    });

    expect(plan.withdraw).toEqual([]);
  });

  it("treats backslash and redundant-segment forms as the same path", () => {
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/./sub/../a.md"],
      known: [doc({ externalObjectId: "notes/a.md" })],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw).toEqual([]);
  });

  it("REFUSES to withdraw everything when the scan normalizes to nothing usable", () => {
    // A caller that hands in only unusable paths has effectively performed no scan. Withdrawing
    // the whole corpus on that basis is the catastrophic failure mode; abstain instead.
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["", "   ", "../../escape.md"],
      known: [doc({ externalObjectId: "notes/a.md" }), doc({ externalObjectId: "notes/b.md" })],
      scanComplete: true,
      inScope,
    });

    expect(plan.withdraw).toEqual([]);
    expect(plan.abstained).toBe(true);
  });
});

describe("corpusGlobMatches: the scope predicate must mirror the scanning glob exactly", () => {
  // THE TRAP THIS PINS. The default corpus glob is `*.md`, and a `*` segment matches WITHIN one
  // path segment. So `*.md` covers `20260805-x.md` and does NOT cover `onboarding/x.md`. The KB
  // holds both. If the scope predicate is looser than the glob that produced the scan, every
  // document the scan never looked for reads as "absent" and gets tombstoned. That is the
  // whole-corpus wipe, and it arrives silently.
  it("matches a top-level file", () => {
    expect(corpusGlobMatches("20260805-note.md", "*.md")).toBe(true);
  });

  it("does NOT match a nested file under a single-star glob", () => {
    expect(corpusGlobMatches("onboarding/note.md", "*.md")).toBe(false);
  });

  it("matches nested files under a double-star glob", () => {
    expect(corpusGlobMatches("onboarding/note.md", "**/*.md")).toBe(true);
    expect(corpusGlobMatches("note.md", "**/*.md")).toBe(true);
  });

  it("skips dotfiles on a star segment, as the scanner does", () => {
    expect(corpusGlobMatches(".hidden.md", "*.md")).toBe(false);
  });

  it("respects the extension", () => {
    expect(corpusGlobMatches("note.txt", "*.md")).toBe(false);
  });
});

describe("storedIdInCorpusScope: the notes/ prefix the server adds, undone", () => {
  // THE OTHER HALF OF THE SAME TRAP. `vaultRelPath` yields `20260805-x.md`; the server prefixes the
  // single `notes/` identity root before storing, so the KB holds `notes/20260805-x.md`. Comparing
  // the scanned form to the stored form without accounting for that prefix makes every document
  // look absent.
  it("accepts a stored id whose vault-relative remainder matches the glob", () => {
    expect(storedIdInCorpusScope("notes/20260805-x.md", "*.md")).toBe(true);
  });

  it("rejects a stored id outside the notes identity root", () => {
    expect(storedIdInCorpusScope("_external/agent-auto-memory/b1/mem.md", "*.md")).toBe(false);
  });

  it("rejects a nested stored id when the glob is single-star", () => {
    expect(storedIdInCorpusScope("notes/onboarding/x.md", "*.md")).toBe(false);
  });

  it("accepts a nested stored id when the glob is double-star", () => {
    expect(storedIdInCorpusScope("notes/onboarding/x.md", "**/*.md")).toBe(true);
  });

  it("rejects the bare identity root itself", () => {
    expect(storedIdInCorpusScope("notes/", "*.md")).toBe(false);
    expect(storedIdInCorpusScope("notes", "*.md")).toBe(false);
  });
});

// --- Case folding: the server casefolds note identities, the scan does not ----
// Found 2026-08-06 by running the human-authored backfill under observation, which
// is the only way it could have been found: it needs a mixed-case filename to
// actually be INGESTED before reconcile can mis-compare it.
//
// intel/app/services/kb_canonicalize.py:105 ends `return posix.casefold()`, so a
// stored note identity is casefolded BY DESIGN. The scan produces the on-disk
// path with its real case. Comparing the two case-sensitively therefore mismatches
// for EVERY mixed-case filename, and a mismatch here does not mean "unchanged", it
// means "this file left disk".
//
// Live blast radius at the moment of discovery: 51 of 2,207 vault notes carry an
// uppercase letter, and 4 had already been ingested and were already listed under
// `MISSING from disk`. `kb reconcile --apply` would have tombstoned live documents
// whose files were sitting right there. This is the exact failure the module
// docstring calls strictly worse than a missed withdrawal.
describe("stored identities are casefolded, so the comparison must be too", () => {
  it("does NOT withdraw a note whose file differs only by case", () => {
    const plan = planCorpusWithdrawals({
      // What the scanner reads off disk, capitals and all.
      scannedRelPaths: ["notes/20250709-apply-Roberts-rules-to-Meetless-v0.md"],
      known: [doc({ externalObjectId: "notes/20250709-apply-roberts-rules-to-meetless-v0.md" })],
      scanComplete: true,
      inScope,
    });
    expect(plan.withdraw).toEqual([]);
    expect(plan.keptActive).toBe(1);
  });

  it("handles spaces and capitals together, the real shape that broke", () => {
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/20250712-ChatGPT-Meetless Research Clarification.md"],
      known: [doc({ externalObjectId: "notes/20250712-chatgpt-meetless research clarification.md" })],
      scanComplete: true,
      inScope,
    });
    expect(plan.withdraw).toEqual([]);
  });

  it("still withdraws a note that genuinely left disk, case or not", () => {
    // The guard must not degrade into "never withdraw anything".
    const plan = planCorpusWithdrawals({
      scannedRelPaths: ["notes/20250709-apply-Roberts.md"],
      known: [doc({ externalObjectId: "notes/20250709-really-gone.md" })],
      scanComplete: true,
      inScope,
    });
    expect(plan.withdraw.map((d) => d.externalObjectId)).toEqual(["notes/20250709-really-gone.md"]);
  });

  it("scope matching is casefolded too, or a mixed-case note reads as out of scope", () => {
    expect(storedIdInCorpusScope("notes/20250712-ChatGPT-Notes.MD", "*.md")).toBe(true);
  });
});
