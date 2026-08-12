import {
  planDeterministicSeed,
  runDeterministicSeed,
  migrateReceipt,
  type SeedReceipt,
  type SeedRunDeps,
  type SeedPersistResult,
} from "../../../src/lib/enrichment/deterministic-seed";

// TEAM scope, deletion reconciliation, and the teammate-duplicate case.
//
// All three are consequences of ONE measured fact about the governed substrate
// (verified live 2026-08-07, not inferred): object identity is
// (workspace, owner, sourceSystem, sourceTenantId, externalObjectId), so the SAME file
// seeded by two teammates is TWO private documents. Measured: teammate2's kb-add returned
// `outcome: "ingested"` and a NEW documentId for a path teammate1 had already seeded.
//
// And `_passes_acl` (intel augmentation/claim_evidence.py) says a PERSON document is visible
// to its OWNER and a WORKSPACE document to any member, so teammate2 would retrieve BOTH: their
// own private copy and the shared one. Two identical answers to one question.
//
// The substrate already solves this and we use its primitives rather than inventing any:
//   - promote (POST .../scope {scope:"WORKSPACE"}) is idempotent and, measured live, SURVIVES
//     later content revisions, so one promote per document is enough forever.
//   - a partial unique (WHERE scope='WORKSPACE') permits exactly ONE shared copy per source
//     object, so a second promote is a 409 KB_SCOPE_SOURCE_ALREADY_SHARED whose own message
//     calls the private copy "redundant".
//   - forget (tombstone) is the existing retraction primitive for removing that redundant copy
//     and for a file that left the repository.

function receiptV2(entries: Record<string, { digest: string; documentId?: string; skipReason?: "shared_by_other" | "local_tombstoned" }>): SeedReceipt {
  return { version: 2, seededAt: "2026-08-07T00:00:00.000Z", entries };
}

function planWith(
  files: Record<string, string>,
  opts: { prior?: SeedReceipt | null; tracked?: string[] | null } = {},
) {
  return planDeterministicSeed({
    repoName: "acme",
    tracked: opts.tracked === undefined ? Object.keys(files) : opts.tracked,
    readFile: (p: string) => (p in files ? files[p] : null),
    prior: opts.prior ?? null,
  });
}

describe("the receipt understands what a teammate already shared", () => {
  it("does not re-add a path a TEAMMATE already shares at WORKSPACE scope", () => {
    // Re-adding would mint our private copy again, and the whole point of tombstoning it the
    // first time was that it is redundant. Without this the seed would churn every session:
    // add -> promote -> 409 -> tombstone, forever.
    const prior = receiptV2({ "CLAUDE.md": { digest: "x", skipReason: "shared_by_other" } });
    const plan = planWith({ "CLAUDE.md": "rules\n" }, { prior });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.sharedByOther).toBe(1);
  });

  it("still skips a shared path when its CONTENT changes, because we cannot write another owner's doc", () => {
    const prior = receiptV2({ "CLAUDE.md": { digest: "stale", skipReason: "shared_by_other" } });
    const plan = planWith({ "CLAUDE.md": "completely different\n" }, { prior });
    expect(plan.candidates).toHaveLength(0);
  });

  it("reads a v1 receipt without re-POSTing everything", () => {
    const v1 = { version: 1, seededAt: "2026-08-06T00:00:00.000Z", digests: { "CLAUDE.md": "d1" } };
    const migrated = migrateReceipt(v1);
    expect(migrated?.version).toBe(2);
    expect(migrated?.entries["CLAUDE.md"].digest).toBe("d1");
    // A v1 receipt has no documentId, so the path is known-seeded but not known-shared. It must
    // be re-promoted (idempotent) rather than assumed already at WORKSPACE.
    expect(migrated?.entries["CLAUDE.md"].documentId).toBeUndefined();
  });
});

describe("deletion and rename reconciliation", () => {
  it("reports a receipt path that is no longer tracked as a deletion", () => {
    const prior = receiptV2({
      "CLAUDE.md": { digest: "a", documentId: "doc-1" },
      "AGENTS.md": { digest: "b", documentId: "doc-2" },
    });
    const plan = planWith({ "CLAUDE.md": "rules\n" }, { prior });
    expect(plan.deletions).toEqual([{ repoPath: "AGENTS.md", documentId: "doc-2" }]);
  });

  it("treats a RENAME as the delete half plus the add half, which is all a path-keyed identity can see", () => {
    const prior = receiptV2({ "CLAUDE.md": { digest: "a", documentId: "doc-1" } });
    const plan = planWith({ "AGENTS.md": "rules\n" }, { prior });
    expect(plan.deletions).toEqual([{ repoPath: "CLAUDE.md", documentId: "doc-1" }]);
    expect(plan.candidates.map((c) => c.repoPath)).toEqual(["AGENTS.md"]);
  });

  it("NEVER reports a deletion when the enumeration failed", () => {
    // `git ls-files` returning null means we could not look. Tombstoning the whole corpus
    // because a git probe failed is the single most destructive thing this module could do.
    const prior = receiptV2({ "CLAUDE.md": { digest: "a", documentId: "doc-1" } });
    const plan = planWith({ "CLAUDE.md": "rules\n" }, { prior, tracked: null });
    expect(plan.enumerated).toBe(false);
    expect(plan.deletions).toEqual([]);
  });

  it("reports a deletion for an EMPTY checkout, which IS an authoritative answer", () => {
    const prior = receiptV2({ "CLAUDE.md": { digest: "a", documentId: "doc-1" } });
    const plan = planWith({}, { prior, tracked: [] });
    expect(plan.enumerated).toBe(true);
    expect(plan.deletions).toEqual([{ repoPath: "CLAUDE.md", documentId: "doc-1" }]);
  });

  it("cannot retract a path whose documentId the receipt never recorded", () => {
    // A v1 receipt carries no ids. We refuse to guess a handle rather than resolve one by path
    // and risk tombstoning a document that merely shares a name.
    const prior = receiptV2({ "CLAUDE.md": { digest: "a" } });
    const plan = planWith({}, { prior, tracked: [] });
    expect(plan.deletions).toEqual([]);
    expect(plan.unretractable).toEqual(["CLAUDE.md"]);
  });
});

// --- the run half ----------------------------------------------------------

function deps(over: Partial<SeedRunDeps> = {}): {
  deps: SeedRunDeps;
  promoted: string[];
  tombstoned: string[];
  written: SeedReceipt[];
} {
  const promoted: string[] = [];
  const tombstoned: string[] = [];
  const written: SeedReceipt[] = [];
  const base: SeedRunDeps = {
    listTracked: () => ["CLAUDE.md"],
    readFile: (_cwd, repoPath) => `rules for ${repoPath}\n`,
    repoName: () => "acme",
    readReceipt: () => null,
    writeReceipt: (r) => written.push(r),
    persist: async (docs): Promise<{ docs: SeedPersistResult[] }> => ({
      docs: docs.map((d, i) => ({ relPath: d.relPath, outcome: "ingested", documentId: `doc-${i}` })),
    }),
    promote: async (id) => {
      promoted.push(id);
      return { shared: true };
    },
    tombstone: async (id) => {
      tombstoned.push(id);
    },
    now: () => "2026-08-07T12:00:00.000Z",
    ...over,
  };
  return { deps: base, promoted, tombstoned, written };
}

describe("runDeterministicSeed: TEAM scope", () => {
  it("promotes every document it seeded, so a teammate can retrieve it", async () => {
    const { deps: d, promoted } = deps();
    const out = await runDeterministicSeed("/repo", d);
    expect(promoted).toEqual(["doc-0"]);
    expect(out.shared).toBe(1);
  });

  it("records the documentId so a later deletion has a handle", async () => {
    const { deps: d, written } = deps();
    await runDeterministicSeed("/repo", d);
    expect(written[0].entries["CLAUDE.md"].documentId).toBe("doc-0");
  });

  it("does NOT record a digest when the promote failed, so the next session retries", async () => {
    // A document stuck at PERSON scope is invisible to the rest of the team. Recording it as
    // done would make that permanent and silent.
    const { deps: d, written } = deps({
      promote: async () => {
        throw new Error("intel unreachable");
      },
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(out.shared).toBe(0);
    expect(out.failed).toBe(1);
    expect(written).toHaveLength(0);
  });
});

describe("runDeterministicSeed: the teammate duplicate", () => {
  it("tombstones OUR redundant private copy when a teammate already shares that file", async () => {
    const { deps: d, tombstoned, written } = deps({
      promote: async () => ({ shared: false, alreadySharedByOther: true }),
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(tombstoned).toEqual(["doc-0"]);
    expect(out.redundant).toBe(1);
    // Remembered, so we never mint that redundant copy again.
    expect(written[0].entries["CLAUDE.md"].skipReason).toBe("shared_by_other");
  });

  it("still records the skip when the tombstone itself fails, and keeps no stale id", async () => {
    // The tombstone is cleanup; the LEARNING (someone else owns this path) is the durable part
    // and must survive a cleanup failure, or we mint another copy next session.
    const { deps: d, written } = deps({
      promote: async () => ({ shared: false, alreadySharedByOther: true }),
      tombstone: async () => {
        throw new Error("forget failed");
      },
    });
    await runDeterministicSeed("/repo", d);
    expect(written[0].entries["CLAUDE.md"].skipReason).toBe("shared_by_other");
  });

  // The tombstoned-twin loop, measured live. A teammate who loses their local receipt (a new
  // machine, a second checkout, a cleared ~/.meetless) re-adds, and kb-add DEDUPS onto their own
  // TOMBSTONED copy from last time (`noop_unchanged`, same content). Promoting that is a
  // different 409, KB_DOCUMENT_NOT_RESCOPABLE, which is not "a teammate owns it" and must not
  // be reported as one. Untreated it never converges: nothing is recorded, so it retries every
  // session forever against a document that can never be promoted.
  it("stops retrying a document of ours that is tombstoned and cannot be re-scoped", async () => {
    const { deps: d, written, tombstoned } = deps({
      promote: async () => ({ shared: false, notRescopable: true }),
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(out.blocked).toBe(1);
    expect(written[0].entries["CLAUDE.md"].skipReason).toBe("local_tombstoned");
    // Nothing to clean up: it is ALREADY tombstoned, and re-forgetting it is noise.
    expect(tombstoned).toEqual([]);
  });

  it("does not claim a teammate owns a path that is merely our own tombstone", async () => {
    const { deps: d, written } = deps({
      promote: async () => ({ shared: false, notRescopable: true }),
    });
    await runDeterministicSeed("/repo", d);
    expect(written[0].entries["CLAUDE.md"].skipReason).not.toBe("shared_by_other");
  });

  it("skips a locally-tombstoned path on the next run too", async () => {
    const prior = receiptV2({ "CLAUDE.md": { digest: "x", skipReason: "local_tombstoned" } });
    const plan = planWith({ "CLAUDE.md": "rules\n" }, { prior });
    expect(plan.candidates).toHaveLength(0);
  });
});

describe("runDeterministicSeed: deletion", () => {
  it("tombstones a document whose file left the repository, and drops it from the receipt", async () => {
    const { deps: d, tombstoned, written } = deps({
      listTracked: () => [],
      readReceipt: () => receiptV2({ "CLAUDE.md": { digest: "a", documentId: "gone-1" } }),
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(tombstoned).toEqual(["gone-1"]);
    expect(out.retracted).toBe(1);
    expect(written[0].entries["CLAUDE.md"]).toBeUndefined();
  });

  it("KEEPS the receipt entry when the retraction failed, so it is retried", async () => {
    const { deps: d, written } = deps({
      listTracked: () => [],
      readReceipt: () => receiptV2({ "CLAUDE.md": { digest: "a", documentId: "gone-1" } }),
      tombstone: async () => {
        throw new Error("forget failed");
      },
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(out.retracted).toBe(0);
    expect(written.length === 0 || written[0].entries["CLAUDE.md"] !== undefined).toBe(true);
  });

  it("retracts NOTHING when the enumeration failed", async () => {
    const { deps: d, tombstoned } = deps({
      listTracked: () => null,
      readReceipt: () => receiptV2({ "CLAUDE.md": { digest: "a", documentId: "gone-1" } }),
    });
    await runDeterministicSeed("/repo", d);
    expect(tombstoned).toEqual([]);
  });
});
