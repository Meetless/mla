// test/lib/rules/snapshot-upload.spec.ts
//
// The scan-time snapshot PUSH (ADR §4.2, Phase 2B). Only the two seams are faked: the network (the
// injected snapshot-client `post`) and the file read (so a test drives content without a temp tree).
// The normalization + digest are the REAL vendored ones, because the contract this pass must honor
// is that the digest it sends equals `normalizedContentHash(bytes)` for the SAME bytes; faking that
// would prove nothing.
import { uploadSnapshotsForScan, type SnapshotUploadArgs } from "../../../src/lib/rules/snapshot-upload";
import type { RepoInstructionSnapshotClientHttp } from "../../../src/lib/rules/repo-instruction-snapshot-client";
import { normalizedContentHash } from "../../../src/lib/scanner/content-normalization";
import type { WorkspaceCliConfig } from "../../../src/lib/config";

const WS = "ws_1";
const REPO = "/Users/an/checkout-a"; // a per-checkout identity, deliberately NOT the workspaceId

function cfg(): WorkspaceCliConfig {
  return {
    backendUrl: "http://127.0.0.1:3006",
    workspaceId: WS,
    auth: { mode: "user-token", accessToken: "tok", user: { id: "user_an" } },
  } as unknown as WorkspaceCliConfig;
}

function fakeHttp(): {
  http: RepoInstructionSnapshotClientHttp;
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const http: RepoInstructionSnapshotClientHttp = {
    post: (async (_cfg: unknown, _path: string, body: Record<string, unknown>) => {
      bodies.push(body);
      return { snapshot: { id: `snap_${bodies.length}` }, deduped: false };
    }) as RepoInstructionSnapshotClientHttp["post"],
  };
  return { http, bodies };
}

function args(over: Partial<SnapshotUploadArgs> = {}): SnapshotUploadArgs {
  return {
    workspaceId: WS,
    repositoryId: REPO,
    scanRoot: "/Users/an/checkout-a",
    paths: ["CLAUDE.md"],
    observedCommitSha: "deadbeef",
    observedAt: "2026-07-23T00:00:00.000Z",
    ...over,
  };
}

describe("uploadSnapshotsForScan", () => {
  it("re-reads, normalizes, digests, and uploads one revision per path with the per-checkout repositoryId", async () => {
    const { http, bodies } = fakeHttp();
    const files: Record<string, string> = {
      "/Users/an/checkout-a/CLAUDE.md": "# rules\nhello\n",
      "/Users/an/checkout-a/.cursor/rules": "be terse\n",
    };

    const outcome = await uploadSnapshotsForScan(
      args({ paths: ["CLAUDE.md", ".cursor/rules"] }),
      { loadConfig: () => cfg(), http, readFile: (abs) => files[abs] ?? null },
    );

    expect(outcome).toEqual({ delivered: true, attempted: 2, uploaded: 2, skipped: 0, failed: 0 });
    expect(bodies).toHaveLength(2);
    // repositoryId is the per-checkout id, NEVER the workspaceId (the cross-checkout stomp guard).
    expect(bodies[0].repositoryId).toBe(REPO);
    expect(bodies[0].repositoryId).not.toBe(WS);
    // The digest sent is the real hash of the re-read bytes: server re-normalization must agree.
    expect(bodies[0].normalizedContentHash).toBe(normalizedContentHash("# rules\nhello\n"));
    expect(bodies[0].relativePath).toBe("CLAUDE.md");
    expect(bodies[0].observedCommitSha).toBe("deadbeef");
    expect(bodies[0].observedAt).toBe("2026-07-23T00:00:00.000Z");
    expect(bodies[1].relativePath).toBe(".cursor/rules");
  });

  it("normalizes CRLF to LF in the uploaded content (content-normalization-v1)", async () => {
    const { http, bodies } = fakeHttp();
    const raw = "line1\r\nline2\r\n";

    await uploadSnapshotsForScan(args(), {
      loadConfig: () => cfg(),
      http,
      readFile: () => raw,
    });

    expect(bodies[0].normalizedContent).toBe("line1\nline2\n");
    expect(String(bodies[0].normalizedContent)).not.toContain("\r");
    // And the hash matches the normalized form, computed from the RAW bytes.
    expect(bodies[0].normalizedContentHash).toBe(normalizedContentHash(raw));
  });

  it("skips an unreadable file (readFile null) without failing the pass", async () => {
    const { http, bodies } = fakeHttp();

    const outcome = await uploadSnapshotsForScan(
      args({ paths: ["CLAUDE.md", "GONE.md"] }),
      {
        loadConfig: () => cfg(),
        http,
        readFile: (abs) => (abs.endsWith("GONE.md") ? null : "ok\n"),
      },
    );

    expect(outcome).toEqual({ delivered: true, attempted: 2, uploaded: 1, skipped: 1, failed: 0 });
    expect(bodies).toHaveLength(1);
  });

  it("counts a per-file upload throw as failed and keeps going (delivered stays true)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    const http: RepoInstructionSnapshotClientHttp = {
      post: (async (_c: unknown, _p: string, body: Record<string, unknown>) => {
        n += 1;
        if (n === 1) throw new Error("transient 503");
        bodies.push(body);
        return { snapshot: { id: "snap" }, deduped: false };
      }) as RepoInstructionSnapshotClientHttp["post"],
    };

    const outcome = await uploadSnapshotsForScan(
      args({ paths: ["A.md", "B.md"] }),
      { loadConfig: () => cfg(), http, readFile: () => "x\n" },
    );

    expect(outcome).toEqual({ delivered: true, attempted: 2, uploaded: 1, skipped: 0, failed: 1 });
    // The second file still uploaded despite the first throwing.
    expect(bodies).toHaveLength(1);
    expect(bodies[0].relativePath).toBe("B.md");
  });

  it("does not start the pass when there is no observed commit sha", async () => {
    const { http, bodies } = fakeHttp();
    let loaded = false;

    const outcome = await uploadSnapshotsForScan(args({ observedCommitSha: "" }), {
      loadConfig: () => {
        loaded = true;
        return cfg();
      },
      http,
      readFile: () => "x\n",
    });

    expect(outcome.delivered).toBe(false);
    expect(bodies).toHaveLength(0);
    // Short-circuits BEFORE loading config: an unborn HEAD has nothing to anchor a revision to.
    expect(loaded).toBe(false);
  });

  it("reports delivered:false when config cannot load (logged out / unbound)", async () => {
    const { http, bodies } = fakeHttp();

    const outcome = await uploadSnapshotsForScan(args(), {
      loadConfig: () => {
        throw new Error("not logged in");
      },
      http,
      readFile: () => "x\n",
    });

    expect(outcome).toEqual({ delivered: false, error: "not logged in" });
    expect(bodies).toHaveLength(0);
  });

  it("an empty path list delivers with zero attempts (a repo with no instruction files)", async () => {
    const { http, bodies } = fakeHttp();

    const outcome = await uploadSnapshotsForScan(args({ paths: [] }), {
      loadConfig: () => cfg(),
      http,
      readFile: () => "x\n",
    });

    expect(outcome).toEqual({ delivered: true, attempted: 0, uploaded: 0, skipped: 0, failed: 0 });
    expect(bodies).toHaveLength(0);
  });
});
