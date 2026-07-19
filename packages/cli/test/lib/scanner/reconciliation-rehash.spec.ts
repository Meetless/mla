import {
  ArtifactByteReader,
  filterReconciliationFindings,
} from "../../../src/lib/scanner/reconciliation-rehash";
import { ReconciliationFinding } from "../../../src/lib/scanner/types";
import {
  CONTENT_NORMALIZATION_V1,
  normalizedContentHash,
} from "../../../src/lib/scanner/content-normalization";

// ADR Phase 2A test 9, part (a): the pure prompt-time rehash gate (§3.3 item 9,
// notes/20260717-adr-decision-record-projection-and-reconciliation.md). The gate re-derives each
// cited file's content-normalization-v1 digest from its CURRENT bytes and keeps the finding only
// when it still equals the evaluated digest. A mismatch (edit-between-scan), an unreadable path, or
// a normalization the helper refuses is NEEDS_REEVALUATION: dropped from this prompt, never
// auto-resolved. These tests pin the partition, the reason classification, order preservation, and
// the totality guarantee (never throws) with the real vendored normalization helper, no mocks.

const CLAUDE = "CLAUDE.md";
const RULES = ".claude/rules/x.md";

const CONTENT = "# CLAUDE.md\n\nAlways prefer 127.0.0.1 over localhost.\n";
const DIGEST = normalizedContentHash(CONTENT, CONTENT_NORMALIZATION_V1);
const OTHER_DIGEST = normalizedContentHash("something else entirely\n", CONTENT_NORMALIZATION_V1);

function finding(over: Partial<ReconciliationFinding> = {}): ReconciliationFinding {
  return {
    path: CLAUDE,
    evaluatedDigest: DIGEST,
    reason: "a scoped decision superseded this instruction",
    ...over,
  };
}

// A reader backed by an in-memory map. A path absent from the map returns null (unreadable),
// exactly as the filesystem reader does for a missing file.
function readerFor(files: Record<string, string>): ArtifactByteReader {
  return (path: string): string | null =>
    Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
}

describe("filterReconciliationFindings — the prompt-time rehash gate", () => {
  it("KEEPS a finding whose file still hashes to the evaluated digest (digest_match)", () => {
    const result = filterReconciliationFindings(
      [finding()],
      readerFor({ [CLAUDE]: CONTENT }),
    );
    expect(result.kept).toHaveLength(1);
    expect(result.needsReevaluation).toHaveLength(0);
    expect(result.kept[0].reason).toBe("digest_match");
    expect(result.kept[0].finding.path).toBe(CLAUDE);
  });

  it("DROPS a finding whose file drifted since evaluation (digest_drift, edit-between-scan)", () => {
    // The file's current bytes normalize to DIGEST, but the finding was evaluated against a
    // different revision (OTHER_DIGEST): the operator edited the file after the detector read it.
    const result = filterReconciliationFindings(
      [finding({ evaluatedDigest: OTHER_DIGEST })],
      readerFor({ [CLAUDE]: CONTENT }),
    );
    expect(result.kept).toHaveLength(0);
    expect(result.needsReevaluation).toHaveLength(1);
    expect(result.needsReevaluation[0].reason).toBe("digest_drift");
  });

  it("DROPS a finding whose file cannot be read (unreadable) — null from the reader", () => {
    const result = filterReconciliationFindings([finding()], readerFor({}));
    expect(result.kept).toHaveLength(0);
    expect(result.needsReevaluation[0].reason).toBe("unreadable");
  });

  it("DROPS a finding whose reader THROWS (contained, classified unreadable, batch survives)", () => {
    const thrower: ArtifactByteReader = () => {
      throw new Error("io error");
    };
    // The throw must not escape: the whole call still returns a partition.
    let result!: ReturnType<typeof filterReconciliationFindings>;
    expect(() => {
      result = filterReconciliationFindings([finding()], thrower);
    }).not.toThrow();
    expect(result.needsReevaluation).toHaveLength(1);
    expect(result.needsReevaluation[0].reason).toBe("unreadable");
  });

  it("DROPS a finding under an unknown normalization version (normalization_error, fail-closed)", () => {
    // The file is readable, but the finding claims a version the helper refuses. We cannot verify
    // the digest, so we must not assert the finding still holds.
    const result = filterReconciliationFindings(
      [finding({ contentNormalizationVersion: "content-normalization-v2" })],
      readerFor({ [CLAUDE]: CONTENT }),
    );
    expect(result.kept).toHaveLength(0);
    expect(result.needsReevaluation[0].reason).toBe("normalization_error");
  });

  it("preserves input order within each partition", () => {
    // Interleave keeps and drops; the partitions must each hold their members in input order.
    const keepA = finding({ path: "a/CLAUDE.md", evaluatedDigest: DIGEST });
    const dropB = finding({ path: "b/CLAUDE.md", evaluatedDigest: OTHER_DIGEST });
    const keepC = finding({ path: "c/CLAUDE.md", evaluatedDigest: DIGEST });
    const dropD = finding({ path: "d/CLAUDE.md" }); // unreadable: not in the map
    const result = filterReconciliationFindings(
      [keepA, dropB, keepC, dropD],
      readerFor({ "a/CLAUDE.md": CONTENT, "b/CLAUDE.md": CONTENT, "c/CLAUDE.md": CONTENT }),
    );
    expect(result.kept.map((o) => o.finding.path)).toEqual(["a/CLAUDE.md", "c/CLAUDE.md"]);
    expect(result.needsReevaluation.map((o) => o.finding.path)).toEqual([
      "b/CLAUDE.md",
      "d/CLAUDE.md",
    ]);
  });

  it("reads each finding's path at most once and returns empty partitions for no findings", () => {
    let reads = 0;
    const counting: ArtifactByteReader = (path) => {
      reads += 1;
      return path === CLAUDE ? CONTENT : null;
    };
    const empty = filterReconciliationFindings([], counting);
    expect(empty.kept).toHaveLength(0);
    expect(empty.needsReevaluation).toHaveLength(0);
    expect(reads).toBe(0);

    filterReconciliationFindings([finding({ path: CLAUDE }), finding({ path: RULES })], counting);
    // One read per finding, never more.
    expect(reads).toBe(2);
  });
});
