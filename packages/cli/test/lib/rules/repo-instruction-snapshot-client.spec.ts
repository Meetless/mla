// test/lib/rules/repo-instruction-snapshot-client.spec.ts
//
// The typed client for control's repo-instruction-snapshot upsert. Only the network (the injected
// `post`) is faked, the established CLI test boundary; the client's own path + body assembly is the
// real code under test.
import {
  upsertRepoInstructionSnapshot,
  type RepoInstructionSnapshotClientHttp,
  type RepoInstructionSnapshotUpsertResponseWire,
  type RepoInstructionSnapshotUpsertWire,
} from "../../../src/lib/rules/repo-instruction-snapshot-client";
import type { WorkspaceCliConfig } from "../../../src/lib/config";

const WS = "ws_1";

function cfg(workspaceId = WS): WorkspaceCliConfig {
  return {
    backendUrl: "http://127.0.0.1:3006",
    workspaceId,
    auth: { mode: "user-token", accessToken: "tok", user: { id: "user_an" } },
  } as unknown as WorkspaceCliConfig;
}

function fakeHttp(impl: (path: string, body: Record<string, unknown>) => unknown): {
  http: RepoInstructionSnapshotClientHttp;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const http: RepoInstructionSnapshotClientHttp = {
    post: (async (_cfg: unknown, path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      return impl(path, body);
    }) as RepoInstructionSnapshotClientHttp["post"],
  };
  return { http, calls };
}

function response(
  over: Partial<RepoInstructionSnapshotUpsertResponseWire> = {},
): RepoInstructionSnapshotUpsertResponseWire {
  return {
    snapshot: {
      id: "snap_1",
      workspaceId: WS,
      repositoryId: "/repo",
      relativePath: "CLAUDE.md",
      normalizedContentHash: "abc",
      contentNormalizationVersion: "content-normalization-v1",
      observedCommitSha: "deadbeef",
      observedAt: "2026-07-23T00:00:00.000Z",
      tombstonedAt: null,
      createdAt: "2026-07-23T00:00:00.000Z",
    },
    deduped: false,
    ...over,
  };
}

const rev: RepoInstructionSnapshotUpsertWire = {
  repositoryId: "/repo",
  relativePath: "CLAUDE.md",
  normalizedContent: "hello\n",
  normalizedContentHash: "abc",
  contentNormalizationVersion: "content-normalization-v1",
  observedCommitSha: "deadbeef",
  observedAt: "2026-07-23T00:00:00.000Z",
};

describe("upsertRepoInstructionSnapshot", () => {
  it("posts to the repo-instruction-snapshots path and returns the response", async () => {
    const { http, calls } = fakeHttp(() => response({ deduped: true }));

    const got = await upsertRepoInstructionSnapshot(cfg(), rev, http);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/v1/repo-instruction-snapshots");
    expect(got.deduped).toBe(true);
    expect(got.snapshot.id).toBe("snap_1");
  });

  it("forwards every rev field and stamps workspaceId from cfg", async () => {
    const { http, calls } = fakeHttp(() => response());

    await upsertRepoInstructionSnapshot(cfg("ws_authoritative"), rev, http);

    const body = calls[0].body;
    expect(body.workspaceId).toBe("ws_authoritative");
    expect(body.repositoryId).toBe("/repo");
    expect(body.relativePath).toBe("CLAUDE.md");
    expect(body.normalizedContent).toBe("hello\n");
    expect(body.normalizedContentHash).toBe("abc");
    expect(body.contentNormalizationVersion).toBe("content-normalization-v1");
    expect(body.observedCommitSha).toBe("deadbeef");
    expect(body.observedAt).toBe("2026-07-23T00:00:00.000Z");
  });

  it("cfg workspaceId wins even against a workspaceId smuggled into the rev body (no cross-workspace stomp)", async () => {
    const { http, calls } = fakeHttp(() => response());

    // The type forbids workspaceId on the wire; force a malformed runtime object to prove the
    // client's stamp-last order cannot be overridden by a caller.
    const poisoned = { ...rev, workspaceId: "ws_attacker" } as unknown as RepoInstructionSnapshotUpsertWire;
    await upsertRepoInstructionSnapshot(cfg("ws_owner"), poisoned, http);

    expect(calls[0].body.workspaceId).toBe("ws_owner");
  });

  it("propagates a transport error to the caller (best-effort handling is the caller's job)", async () => {
    const { http } = fakeHttp(() => {
      throw new Error("boom");
    });

    await expect(upsertRepoInstructionSnapshot(cfg(), rev, http)).rejects.toThrow("boom");
  });
});
