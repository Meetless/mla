// The shared live-reconciliation gate (ADR §3.5 / §3.7, T11).
//
// This module is the single answer to "may this finding still be spoken as governed", consumed by
// three surfaces: the always-on hook injection, `mla context list`, and the `mla ask`
// documentation-impact section. What is pinned here is the composition, because the composition is
// the part a second consumer could get wrong: freshness FIRST, short-circuiting to an empty list, so
// a stale cache never reaches the filesystem at all.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECONCILIATION_MAX_AGE_MS,
  isReconciliationFresh,
  liveReconciliationFindings,
  makeArtifactByteReader,
} from "../../../src/lib/scanner/reconciliation-live";
import { normalizedContentHash } from "../../../src/lib/scanner/content-normalization";
import type { ReconciliationFinding } from "../../../src/lib/scanner/types";

const NOW = "2026-07-22T12:00:00.000Z";
const BODY = "# House rules\n\nUse localhost for every local service example.\n";

function at(offsetMs: number): string {
  return new Date(Date.parse(NOW) - offsetMs).toISOString();
}

function finding(over: Partial<ReconciliationFinding> = {}): ReconciliationFinding {
  return {
    path: "CLAUDE.md",
    evaluatedDigest: normalizedContentHash(BODY),
    reason: "a governed decision superseded this instruction",
    acceptedStatement: "Use 127.0.0.1, never localhost.",
    sourceCaseId: "case_1",
    ...over,
  };
}

describe("isReconciliationFresh", () => {
  it("accepts the boundary itself and rejects one millisecond past it", () => {
    // Inclusive by choice: a pull taken exactly 24h ago is the oldest evidence we still let speak,
    // and an exclusive boundary would make the rule un-testable at its own edge.
    expect(isReconciliationFresh(at(RECONCILIATION_MAX_AGE_MS), NOW)).toBe(true);
    expect(isReconciliationFresh(at(RECONCILIATION_MAX_AGE_MS + 1), NOW)).toBe(false);
  });

  it("treats an absent stamp as infinitely stale, not as 'assume fresh'", () => {
    // A list with no stamp never came from a pull we can date (a pre-stamp cache from an older CLI,
    // or a hand-edited one). trust="governed" has to be backed by dated evidence.
    expect(isReconciliationFresh(undefined, NOW)).toBe(false);
  });

  it("rejects a FUTURE stamp instead of reading it as maximally fresh", () => {
    // Clock skew or a hand-edited cache. A negative age is not evidence, so it cannot buy trust,
    // and the naive `age <= MAX` check would have made it the freshest possible pull.
    expect(isReconciliationFresh(at(-60_000), NOW)).toBe(false);
  });

  it("rejects unparseable dates rather than throwing on the prompt path", () => {
    expect(isReconciliationFresh("yesterday-ish", NOW)).toBe(false);
    expect(isReconciliationFresh(at(0), "not-a-date")).toBe(false);
  });
});

describe("makeArtifactByteReader", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mla-recon-live-"));
    writeFileSync(join(root, "CLAUDE.md"), BODY);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads a repo-relative path and refuses to escape the repo", () => {
    const read = makeArtifactByteReader(root);
    expect(read("CLAUDE.md")).toBe(BODY);
    // A finding's `path` arrives from the network. Containment is what stops it addressing the
    // operator's home directory, and it must fail to null (unreadable), never throw.
    expect(read("../outside.md")).toBeNull();
    expect(read("/etc/passwd")).toBeNull();
    expect(read("")).toBeNull();
    expect(read("missing.md")).toBeNull();
  });
});

describe("liveReconciliationFindings", () => {
  it("keeps a fresh finding whose cited file still hashes to the evaluated digest", () => {
    const out = liveReconciliationFindings(
      { reconciliationFindings: [finding()], reconciliationFetchedAt: at(60_000) },
      () => BODY,
      NOW,
    );
    expect(out.kept.map((o) => o.reason)).toEqual(["digest_match"]);
    expect(out.needsReevaluation).toEqual([]);
  });

  it("holds back a fresh finding whose file drifted, and never auto-resolves it", () => {
    const out = liveReconciliationFindings(
      { reconciliationFindings: [finding()], reconciliationFetchedAt: at(60_000) },
      () => BODY + "\nAlso: use 127.0.0.1.\n",
      NOW,
    );
    expect(out.kept).toEqual([]);
    // Dropped from THIS moment's output, still present as a thing to re-evaluate. A drifted file
    // means "re-evaluate", never "the concern went away".
    expect(out.needsReevaluation.map((o) => o.reason)).toEqual(["digest_drift"]);
  });

  it("does ZERO file reads once the pull ages out", () => {
    // Not a performance note. It is why the ordering is freshness-then-rehash and not the reverse:
    // a stale cache must cost nothing on the always-on prompt path, and a stat of a path we are no
    // longer entitled to assert is work done on behalf of an expired claim.
    let reads = 0;
    const out = liveReconciliationFindings(
      {
        reconciliationFindings: [finding(), finding({ path: "docs/rules.md" })],
        reconciliationFetchedAt: at(RECONCILIATION_MAX_AGE_MS + 1),
      },
      () => {
        reads++;
        return BODY;
      },
      NOW,
    );
    expect(out).toEqual({ kept: [], needsReevaluation: [] });
    expect(reads).toBe(0);
  });

  it("is empty and read-free for a cache that carries no findings at all", () => {
    // Every pre-Phase-3 cache on disk. It must parse and gate to silence, not throw.
    let reads = 0;
    const read = () => {
      reads++;
      return BODY;
    };
    expect(liveReconciliationFindings(null, read, NOW)).toEqual({ kept: [], needsReevaluation: [] });
    expect(liveReconciliationFindings({}, read, NOW)).toEqual({ kept: [], needsReevaluation: [] });
    expect(reads).toBe(0);
  });
});
