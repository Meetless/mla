import {
  runDeterministicSeed,
  SEED_BATCH_SIZE,
  type SeedReceipt,
  type SeedRunDeps,
} from "../../../src/lib/enrichment/deterministic-seed";
import type { PersistDocument } from "../../../src/lib/enrichment/ingest";
import type { SeedPersistResult } from "../../../src/lib/enrichment/deterministic-seed";

// The I/O half of the deterministic seed. Everything here is about the two properties that
// decide whether this is safe to run on EVERY SessionStart forever:
//
//   1. It converges. A file is recorded as seeded only when the server actually took it, so a
//      failure retries next session instead of being marked done and going dark forever.
//   2. It costs nothing when it fails. It never throws, never blocks past its budget, and never
//      turns a slow intel into a broken session start.

function deps(over: Partial<SeedRunDeps> = {}): { deps: SeedRunDeps; posted: PersistDocument[][]; written: SeedReceipt[] } {
  const posted: PersistDocument[][] = [];
  const written: SeedReceipt[] = [];
  const base: SeedRunDeps = {
    listTracked: () => ["CLAUDE.md", "AGENTS.md"],
    readFile: (_cwd, repoPath) => `rules for ${repoPath}\n`,
    repoName: () => "acme",
    readReceipt: () => null,
    writeReceipt: (r) => written.push(r),
    persist: async (docs) => {
      posted.push(docs);
      return {
        docs: docs.map((d, i) => ({
          relPath: d.relPath,
          outcome: "ingested",
          documentId: `doc-${d.relPath}-${i}`,
        })) as SeedPersistResult[],
      };
    },
    promote: async () => ({ shared: true }),
    tombstone: async () => {},
    now: () => "2026-08-06T12:00:00.000Z",
    ...over,
  };
  return { deps: base, posted, written };
}

describe("runDeterministicSeed: the happy path", () => {
  it("posts the T1 files and reports what landed", async () => {
    const { deps: d, posted } = deps();
    const out = await runDeterministicSeed("/repo", d);

    expect(posted).toHaveLength(1);
    expect(posted[0].map((x) => x.relPath).sort()).toEqual([
      "repo-instructions/acme/AGENTS.md",
      "repo-instructions/acme/CLAUDE.md",
    ]);
    expect(out).toMatchObject({ ingested: 2, noop: 0, failed: 0, unchanged: 0 });
  });

  it("writes a receipt so the next session posts nothing", async () => {
    const { deps: d, written } = deps();
    await runDeterministicSeed("/repo", d);
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0].entries).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);

    const { deps: d2, posted: posted2 } = deps({ readReceipt: () => written[0] });
    const out2 = await runDeterministicSeed("/repo", d2);
    expect(posted2).toHaveLength(0);
    expect(out2.unchanged).toBe(2);
  });

  it("counts a server-side dedup as success, not as work", async () => {
    const { deps: d } = deps({
      persist: async (docs) => ({
        docs: docs.map((x, i) => ({
          relPath: x.relPath,
          outcome: "noop_unchanged",
          documentId: `doc-${i}`,
        })) as SeedPersistResult[],
      }),
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(out).toMatchObject({ ingested: 0, noop: 2, failed: 0 });
  });
});

describe("runDeterministicSeed: convergence", () => {
  // The failure this prevents is the worst one available here: a file recorded as seeded that
  // the server never took. It would never be retried, and the workspace would stay dark while
  // the receipt claimed it was seeded.
  it("does NOT record a digest for a document the server refused", async () => {
    const { deps: d, written } = deps({
      persist: async (docs) => ({
        docs: docs.map((x, i) => ({
          relPath: x.relPath,
          outcome: x.relPath.endsWith("CLAUDE.md") ? "failed" : "ingested",
          documentId: x.relPath.endsWith("CLAUDE.md") ? undefined : `doc-${i}`,
        })) as SeedPersistResult[],
      }),
    });
    const out = await runDeterministicSeed("/repo", d);

    expect(out).toMatchObject({ ingested: 1, failed: 1 });
    expect(Object.keys(written[0].entries)).toEqual(["AGENTS.md"]);
  });

  it("retries the refused file on the next run", async () => {
    const { deps: d, written } = deps({
      persist: async (docs) => ({
        docs: docs.map((x, i) => ({
          relPath: x.relPath,
          outcome: x.relPath.endsWith("CLAUDE.md") ? "failed" : "ingested",
          documentId: x.relPath.endsWith("CLAUDE.md") ? undefined : `doc-${i}`,
        })) as SeedPersistResult[],
      }),
    });
    await runDeterministicSeed("/repo", d);

    const { deps: d2, posted: posted2 } = deps({ readReceipt: () => written[0] });
    await runDeterministicSeed("/repo", d2);
    expect(posted2[0].map((x) => x.relPath)).toEqual(["repo-instructions/acme/CLAUDE.md"]);
  });

  it("writes NO receipt when the POST itself threw, so nothing is falsely marked seeded", async () => {
    const { deps: d, written } = deps({
      persist: async () => {
        throw new Error("intel unreachable");
      },
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(out.failed).toBe(2);
    expect(out.ingested).toBe(0);
    expect(written).toHaveLength(0);
  });
});

describe("runDeterministicSeed: bounds and safety", () => {
  it("posts at most ONE batch per session, and the rest converge later", async () => {
    const many: Record<string, string> = {};
    const tracked: string[] = [];
    for (let i = 0; i < SEED_BATCH_SIZE + 3; i++) {
      tracked.push(`pkg${i}/CLAUDE.md`);
      many[`pkg${i}/CLAUDE.md`] = `rules ${i}\n`;
    }
    const { deps: d, posted } = deps({
      listTracked: () => tracked,
      readFile: (_cwd, repoPath) => many[repoPath] ?? null,
    });
    const out = await runDeterministicSeed("/repo", d);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveLength(SEED_BATCH_SIZE);
    expect(out.remaining).toBe(3);
  });

  it("never throws when the git enumeration fails, and posts nothing", async () => {
    const { deps: d, posted, written } = deps({ listTracked: () => null });
    const out = await runDeterministicSeed("/repo", d);
    expect(out).toMatchObject({ enumerated: false, ingested: 0, failed: 0 });
    expect(posted).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("never throws when the receipt on disk is corrupt; it reseeds instead", async () => {
    const { deps: d, posted } = deps({
      readReceipt: () => {
        throw new Error("EACCES");
      },
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(out.ingested).toBe(2);
    expect(posted).toHaveLength(1);
  });

  it("never throws when the receipt cannot be written; the documents still landed", async () => {
    const { deps: d } = deps({
      writeReceipt: () => {
        throw new Error("EROFS");
      },
    });
    const out = await runDeterministicSeed("/repo", d);
    expect(out.ingested).toBe(2);
  });

  it("posts nothing at all when the repo carries no instruction file", async () => {
    const { deps: d, posted, written } = deps({ listTracked: () => ["src/index.ts", "README.md"] });
    const out = await runDeterministicSeed("/repo", d);
    expect(posted).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(out).toMatchObject({ enumerated: true, ingested: 0, candidates: 0 });
  });
});
