import {
  createIntelUpsertClient,
  CAPTURE_METHOD,
  type IntelPostFn,
} from "../../../src/lib/agent-memory-capture/upsert-client";
import type { CliConfig } from "../../../src/lib/config";

// Minimal CliConfig: the client only forwards it to the injected post fn, so the
// fields are inert here. auth in "none" mode would fail-fast in the REAL intelPost,
// but we inject a fake post, so the auth shape is irrelevant to these unit tests.
const cfg = {
  controlUrl: "http://127.0.0.1:8080",
  controlToken: "tok",
  intelUrl: "http://127.0.0.1:8100",
  mlaPath: "/tmp/mla",
  actorUserId: "user-1",
  auth: { mode: "shared-key", controlToken: "tok" },
} as unknown as CliConfig;

const baseUpsert = {
  workspaceId: "ws-1",
  actor: "user-1",
  relPath: "_external/agent-auto-memory/bind-1/a.md",
  content: "body",
  contentHash: "a".repeat(64),
  bindingId: "bind-1",
  consentedAt: "2026-06-27T00:00:00.000Z",
};

describe("createIntelUpsertClient (wire contract)", () => {
  it("upsert posts /internal/v1/kb/add with captureMethod + a single document carrying contentSha256", async () => {
    let seenPath = "";
    let seenBody: any = null;
    const post: IntelPostFn = async <T>(_c: CliConfig, path: string, body: unknown) => {
      seenPath = path;
      seenBody = body;
      return { receipts: [{ outcome: "ingested", documentId: "doc-1", revisionId: "rev-1", contentSha256: baseUpsert.contentHash }] } as T;
    };
    const client = createIntelUpsertClient(cfg, post);
    const res = await client.upsert(baseUpsert);

    expect(seenPath).toBe("/internal/v1/kb/add");
    expect(seenBody.captureMethod).toBe(CAPTURE_METHOD);
    expect(seenBody.workspaceId).toBe("ws-1");
    expect(seenBody.actor).toBe("user-1");
    expect(seenBody.bindingId).toBe("bind-1");
    expect(seenBody.consentedAt).toBe(baseUpsert.consentedAt);
    expect(seenBody.mode).toBe("file");
    expect(Array.isArray(seenBody.documents)).toBe(true);
    expect(seenBody.documents).toHaveLength(1);
    expect(seenBody.documents[0]).toEqual({
      relPath: baseUpsert.relPath,
      content: "body",
      contentSha256: baseUpsert.contentHash,
    });

    expect(res).toEqual({
      ok: true,
      outcome: "created",
      serverContentHash: baseUpsert.contentHash,
      revisionId: "rev-1",
      logicalSourceId: "doc-1",
      reason: "ingested",
    });
  });

  it("maps noop_unchanged -> unchanged", async () => {
    const post: IntelPostFn = async <T>() =>
      ({ receipts: [{ outcome: "noop_unchanged", documentId: "doc-1", revisionId: "rev-1" }] }) as T;
    const res = await createIntelUpsertClient(cfg, post).upsert(baseUpsert);
    expect(res.outcome).toBe("unchanged");
    expect(res.ok).toBe(true);
  });

  it("maps a per-document failed receipt -> failed (ok stays true)", async () => {
    const post: IntelPostFn = async <T>() =>
      ({ receipts: [{ outcome: "failed", reason: "intake_failed" }] }) as T;
    const res = await createIntelUpsertClient(cfg, post).upsert(baseUpsert);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("failed");
    expect(res.reason).toBe("intake_failed");
  });

  it("absent contentSha256 (older intel) -> serverContentHash null", async () => {
    const post: IntelPostFn = async <T>() =>
      ({ receipts: [{ outcome: "ingested", documentId: "doc-1", revisionId: "rev-1" }] }) as T;
    const res = await createIntelUpsertClient(cfg, post).upsert(baseUpsert);
    expect(res.serverContentHash).toBeNull();
    expect(res.outcome).toBe("created");
  });

  it("no receipt in the response -> ok:false, no_receipt", async () => {
    const post: IntelPostFn = async <T>() => ({ receipts: [] }) as T;
    const res = await createIntelUpsertClient(cfg, post).upsert(baseUpsert);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_receipt");
  });

  it("a transport error -> ok:false with upload_failed reason (never throws)", async () => {
    const post: IntelPostFn = async <T>() => {
      throw new Error("ECONNREFUSED");
    };
    const res = await createIntelUpsertClient(cfg, post).upsert(baseUpsert);
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("failed");
    expect(res.reason).toContain("upload_failed");
    expect(res.reason).toContain("ECONNREFUSED");
  });

  it("withdraw posts /internal/v1/kb/withdraw with captureMethod + reason", async () => {
    let seenPath = "";
    let seenBody: any = null;
    const post: IntelPostFn = async <T>(_c: CliConfig, path: string, body: unknown) => {
      seenPath = path;
      seenBody = body;
      return { withdrawn: true, retiredPendingDerived: 3, reason: "withdrawn" } as T;
    };
    const res = await createIntelUpsertClient(cfg, post).withdraw({
      workspaceId: "ws-1",
      actor: "user-1",
      relPath: baseUpsert.relPath,
      reason: "deleted",
    });
    expect(seenPath).toBe("/internal/v1/kb/withdraw");
    expect(seenBody.captureMethod).toBe(CAPTURE_METHOD);
    expect(seenBody.relPath).toBe(baseUpsert.relPath);
    expect(seenBody.reason).toBe("deleted");
    expect(res).toEqual({ ok: true, withdrawn: true, retiredPendingDerived: 3, reason: "withdrawn" });
  });

  it("withdraw transport error -> ok:false, not withdrawn (never throws)", async () => {
    const post: IntelPostFn = async <T>() => {
      throw new Error("503");
    };
    const res = await createIntelUpsertClient(cfg, post).withdraw({
      workspaceId: "ws-1",
      actor: "user-1",
      relPath: baseUpsert.relPath,
      reason: "reclassified",
    });
    expect(res.ok).toBe(false);
    expect(res.withdrawn).toBe(false);
    expect(res.reason).toContain("withdraw_failed");
  });
});
