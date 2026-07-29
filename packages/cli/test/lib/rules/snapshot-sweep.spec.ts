// test/lib/rules/snapshot-sweep.spec.ts
//
// The REMOVAL half of the artifact-revision contract (ADR §4.2, Phase 2B).
//
// `uploadSnapshotsForScan` publishes a revision for every instruction file the scan sees, and
// nothing has ever published the absence of one. Delete or rename a CLAUDE.md and its last revision
// stays live in control forever, so the detector keeps scanning bytes that are not on disk and the
// findings read keeps serving them: no code anywhere moves a ReconciliationItem to RESOLVED or
// DISMISSED, so the snapshot tombstone is the ONLY retirement mechanism in the system, and it had
// no producer.
//
// The single-path DELETE cannot close that: the CLI would have to know which paths control still
// holds, which needs a LIST route plus one round trip per stale path. The sweep inverts it. The scan
// already enumerates the whole checkout, so it sends that set and control retires the live rows not
// in it. One round trip, authoritative rather than differential, so it converges on a fresh machine
// and after an evicted cache, not just on the machine that did the deleting.
//
// The dangerous edge is that a sweep with an EMPTY observed set is indistinguishable, on the wire,
// from a scan that could not enumerate the checkout at all. Both would retire the entire corpus.
// So the enumeration's completeness is carried explicitly: `observedPaths: undefined` means "I have
// no authoritative list, do NOT sweep", and `observedPaths: []` means "I looked, and there are
// genuinely zero instruction files, DO sweep". Refusing to sweep a single-CLAUDE.md repo that just
// lost its only file would leave the most common instance of this bug permanently unfixed.
//
// Same fake boundary as snapshot-upload.spec.ts: only the network (injected `post`) and the file
// read. The path assembly, workspace stamping, and pass sequencing are the real code under test.
import {
  sweepRepoInstructionSnapshots,
  type RepoInstructionSnapshotClientHttp,
} from "../../../src/lib/rules/repo-instruction-snapshot-client";
import { uploadSnapshotsForScan, type SnapshotUploadArgs } from "../../../src/lib/rules/snapshot-upload";
import { EgressPolicyError } from "../../../src/lib/egress/policy";
import type { WorkspaceCliConfig } from "../../../src/lib/config";

const WS = "ws_1";
const REPO = "/Users/an/checkout-a";
const SWEEP_PATH = "/internal/v1/repo-instruction-snapshots/sweep";
const UPSERT_PATH = "/internal/v1/repo-instruction-snapshots";

function cfg(workspaceId = WS): WorkspaceCliConfig {
  return {
    backendUrl: "http://127.0.0.1:3006",
    workspaceId,
    auth: { mode: "user-token", accessToken: "tok", user: { id: "user_an" } },
  } as unknown as WorkspaceCliConfig;
}

/** Records every call so a test can assert BOTH what was sent and in what order. */
function fakeHttp(impl?: (path: string, body: Record<string, unknown>) => unknown): {
  http: RepoInstructionSnapshotClientHttp;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const http: RepoInstructionSnapshotClientHttp = {
    post: (async (_cfg: unknown, path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      if (impl) return impl(path, body);
      return path === SWEEP_PATH
        ? { tombstonedCount: 0 }
        : { snapshot: { id: `snap_${calls.length}` }, deduped: false };
    }) as RepoInstructionSnapshotClientHttp["post"],
  };
  return { http, calls };
}

function args(over: Partial<SnapshotUploadArgs> = {}): SnapshotUploadArgs {
  return {
    workspaceId: WS,
    repositoryId: REPO,
    scanRoot: "/Users/an/checkout-a",
    paths: ["CLAUDE.md"],
    observedCommitSha: "deadbeef",
    observedAt: "2026-07-28T00:00:00.000Z",
    ...over,
  };
}

describe("sweepRepoInstructionSnapshots", () => {
  it("posts the observed set to the sweep path and returns the retired count", async () => {
    const { http, calls } = fakeHttp(() => ({ tombstonedCount: 3 }));

    const got = await sweepRepoInstructionSnapshots(
      cfg(),
      { repositoryId: REPO, observedPaths: ["CLAUDE.md", ".cursor/rules"] },
      http,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(SWEEP_PATH);
    expect(calls[0].body.repositoryId).toBe(REPO);
    expect(calls[0].body.observedPaths).toEqual(["CLAUDE.md", ".cursor/rules"]);
    expect(got.tombstonedCount).toBe(3);
  });

  it("stamps workspaceId from cfg and cannot be overridden by the caller", async () => {
    // Identical posture to the upsert client, and it matters MORE here: this call is destructive, so
    // a smuggled workspaceId would retire another tenant's corpus rather than merely add a row to it.
    const { http, calls } = fakeHttp(() => ({ tombstonedCount: 0 }));

    const poisoned = {
      repositoryId: REPO,
      observedPaths: ["CLAUDE.md"],
      workspaceId: "ws_attacker",
    } as unknown as { repositoryId: string; observedPaths: string[] };
    await sweepRepoInstructionSnapshots(cfg("ws_owner"), poisoned, http);

    expect(calls[0].body.workspaceId).toBe("ws_owner");
  });

  it("propagates a transport error (best-effort handling belongs to the caller)", async () => {
    const { http } = fakeHttp(() => {
      throw new Error("boom");
    });

    await expect(
      sweepRepoInstructionSnapshots(cfg(), { repositoryId: REPO, observedPaths: [] }, http),
    ).rejects.toThrow("boom");
  });
});

describe("uploadSnapshotsForScan: the sweep leg", () => {
  it("sweeps exactly once, after the uploads, naming every observed path", async () => {
    // Order is load-bearing. Sweeping FIRST would retire a path this very scan is about to re-upload,
    // and a crash in between would leave the corpus short of a file that is on disk.
    const { http, calls } = fakeHttp();

    const outcome = await uploadSnapshotsForScan(
      args({
        paths: ["CLAUDE.md", ".cursor/rules"],
        observedPaths: ["CLAUDE.md", ".cursor/rules", "docs/HUGE.md"],
      }),
      { loadConfig: () => cfg(), http, readFile: () => "x\n" },
    );

    expect(calls.map((c) => c.path)).toEqual([UPSERT_PATH, UPSERT_PATH, SWEEP_PATH]);
    // The swept set is the full ENUMERATION, not the uploaded set: an oversized or unreadable file is
    // still on disk, and sweeping by uploaded paths would tombstone it on every scan and then
    // re-detect nothing, quietly deleting a rule the operator can still see in their editor.
    expect(calls[2].body.observedPaths).toEqual(["CLAUDE.md", ".cursor/rules", "docs/HUGE.md"]);
    expect(calls[2].body.repositoryId).toBe(REPO);
    expect(outcome).toMatchObject({ delivered: true, uploaded: 2, swept: 0 });
  });

  it("does NOT sweep when the scan could not enumerate the checkout", async () => {
    // `observedPaths: undefined` is the degraded-scan signal (git ls-files failed, or the caller
    // predates the field). Sweeping on it would read "no files observed" and retire everything.
    const { http, calls } = fakeHttp();

    const outcome = await uploadSnapshotsForScan(args({ observedPaths: undefined }), {
      loadConfig: () => cfg(),
      http,
      readFile: () => "x\n",
    });

    expect(calls.map((c) => c.path)).toEqual([UPSERT_PATH]);
    expect(outcome).toMatchObject({ delivered: true, uploaded: 1 });
    expect((outcome as { swept?: number | null }).swept ?? null).toBeNull();
  });

  it("DOES sweep an empty observed set (the repo genuinely has no instruction file left)", async () => {
    // The whole point. A repo whose only CLAUDE.md was deleted observes zero paths, and that is
    // precisely the state that must converge. Refusing to sweep here (the tempting "only sweep when
    // we saw at least one file" guard) would never fix the single-file repo, which is the common case.
    const { http, calls } = fakeHttp(() => ({ tombstonedCount: 2 }));

    const outcome = await uploadSnapshotsForScan(args({ paths: [], observedPaths: [] }), {
      loadConfig: () => cfg(),
      http,
      readFile: () => "x\n",
    });

    expect(calls.map((c) => c.path)).toEqual([SWEEP_PATH]);
    expect(calls[0].body.observedPaths).toEqual([]);
    expect(outcome).toMatchObject({ delivered: true, attempted: 0, swept: 2 });
  });

  it("sweeps even when some per-file uploads failed", async () => {
    // A failed upload is a transport blip against a path that IS on disk, and the sweep only ever
    // retires paths NOT in the observed set. Skipping the sweep on any failure would make removal
    // hostage to an unrelated flake.
    const { http, calls } = fakeHttp((path) => {
      if (path === UPSERT_PATH) throw new Error("transient 503");
      return { tombstonedCount: 1 };
    });

    const outcome = await uploadSnapshotsForScan(
      args({ paths: ["A.md"], observedPaths: ["A.md"] }),
      { loadConfig: () => cfg(), http, readFile: () => "x\n" },
    );

    expect(calls.map((c) => c.path)).toEqual([UPSERT_PATH, SWEEP_PATH]);
    expect(outcome).toMatchObject({ delivered: true, failed: 1, swept: 1 });
  });

  it("does not start the pass at all on a degraded scan (no observed commit sha)", async () => {
    const { http, calls } = fakeHttp();

    const outcome = await uploadSnapshotsForScan(
      args({ observedCommitSha: "", observedPaths: [] }),
      { loadConfig: () => cfg(), http, readFile: () => "x\n" },
    );

    expect(outcome.delivered).toBe(false);
    // Nothing uploaded AND nothing swept: a scan that cannot anchor a revision has no standing to
    // decide what is no longer on disk either.
    expect(calls).toHaveLength(0);
  });

  it("a thrown sweep leaves the scan delivered, with swept null and the uploads intact", async () => {
    const { http, calls } = fakeHttp((path) => {
      if (path === SWEEP_PATH) throw new Error("transient 503");
      return { snapshot: { id: "snap" }, deduped: false };
    });

    const outcome = await uploadSnapshotsForScan(
      args({ paths: ["CLAUDE.md"], observedPaths: ["CLAUDE.md"] }),
      { loadConfig: () => cfg(), http, readFile: () => "x\n" },
    );

    expect(calls.map((c) => c.path)).toEqual([UPSERT_PATH, SWEEP_PATH]);
    expect(outcome).toMatchObject({ delivered: true, uploaded: 1, swept: null });
  });

  it("surfaces an egress refusal from the sweep in the existing refusal channel", async () => {
    // An unregistered route refuses forever, in every environment, and retries nothing. A caller
    // that only ever hears "0 retired" would read a permanently broken removal leg as a clean repo.
    const { http } = fakeHttp((path) => {
      if (path === SWEEP_PATH) {
        throw new EgressPolicyError("no_rule", "control", "POST", SWEEP_PATH, "no registry row");
      }
      return { snapshot: { id: "snap" }, deduped: false };
    });

    const outcome = await uploadSnapshotsForScan(
      args({ paths: ["CLAUDE.md"], observedPaths: ["CLAUDE.md"] }),
      { loadConfig: () => cfg(), http, readFile: () => "x\n" },
    );

    const got = outcome as { refusal?: string; swept?: number | null };
    expect(got.swept).toBeNull();
    expect(got.refusal).toContain("egress");
    // Body-free by construction: a refusal line never carries what was being sent.
    expect(got.refusal).not.toContain("CLAUDE.md");
  });
});
