// Dedicated owner-check spec (the one kb-add-safety.spec.ts:37 promises exists).
//
// Locks verifyKbActorIsOwner's §9.3 owner gate AND its transient-failure
// resilience. Incident (session 2c881e60, 2026-06-14): the per-doc owner check
// inside runKbAdd hit a single undici "fetch failed" connection blip right after
// a heavy ingest, threw with NO retry, and auto-index counted the produced doc
// `failed` with no in-run recovery -> the note was silently orphaned from the KB.
//
// The gate's verdict for a member/non-owner is deterministic and MUST NOT retry
// (retrying a "you are not the owner" answer is pointless and slow). Only a
// transient transport failure (no HTTP status = network/abort/DNS/ECONNRESET, or
// a 5xx) is retried, bounded, with injectable backoff so the loop is testable
// without real timers.

const mockGet = jest.fn();
jest.mock("../../src/lib/http", () => ({
  get: (...args: unknown[]) => mockGet(...args),
}));

import { verifyKbActorIsOwner, KbOwnerCheckError } from "../../src/lib/kb_acl";
import type { KbCliConfig } from "../../src/lib/config";

const cfg = { workspaceId: "ws_1", actorUserId: "u_owner" } as unknown as KbCliConfig;

// undici rejects a connection-level failure as a raw TypeError with no `status`
// (see HttpError doc-comment in http.ts). A 5xx arrives via buildError WITH a
// status. A deterministic 4xx/401 also carries a status.
function transportErr(msg = "fetch failed"): Error {
  return new TypeError(msg);
}
function httpErr(status: number, msg = "boom"): Error {
  const e = new Error(msg) as Error & { status?: number; body?: string };
  e.status = status;
  e.body = "";
  return e;
}

const OWNER_BODY = { actorIsOwner: true, actor: { role: "OWNER" } };

beforeEach(() => {
  mockGet.mockReset();
});

describe("verifyKbActorIsOwner — happy path", () => {
  it("resolves on the first try for an OWNER and calls control exactly once", async () => {
    mockGet.mockResolvedValueOnce(OWNER_BODY);
    await expect(verifyKbActorIsOwner(cfg)).resolves.toBeUndefined();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("trusts actor.role === OWNER when the typed actorIsOwner flag is absent", async () => {
    mockGet.mockResolvedValueOnce({ actor: { role: "OWNER" } });
    await expect(verifyKbActorIsOwner(cfg)).resolves.toBeUndefined();
  });
});

describe("verifyKbActorIsOwner — deterministic verdicts never retry", () => {
  it("throws for a non-OWNER role after a SINGLE call (no retry, no sleep)", async () => {
    mockGet.mockResolvedValue({ actor: { role: "MEMBER" } });
    const sleep = jest.fn();
    await expect(verifyKbActorIsOwner(cfg, { sleep })).rejects.toBeInstanceOf(
      KbOwnerCheckError,
    );
    await expect(verifyKbActorIsOwner(cfg, { sleep })).rejects.toThrow(/requires OWNER/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws 'not a member' when the body carries no actor (single call)", async () => {
    mockGet.mockResolvedValue({});
    const sleep = jest.fn();
    await expect(verifyKbActorIsOwner(cfg, { sleep })).rejects.toThrow(/not a member/);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry a deterministic 401 (auth already refreshed upstream)", async () => {
    mockGet.mockRejectedValue(httpErr(401, "unauthorized"));
    const sleep = jest.fn();
    await expect(
      verifyKbActorIsOwner(cfg, { sleep, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(KbOwnerCheckError);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry a deterministic 4xx", async () => {
    mockGet.mockRejectedValue(httpErr(400, "bad request"));
    const sleep = jest.fn();
    await expect(verifyKbActorIsOwner(cfg, { sleep, maxAttempts: 3 })).rejects.toThrow(
      /could not reach control/,
    );
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe("verifyKbActorIsOwner — transient transport failures retry then succeed", () => {
  it("absorbs a single 'fetch failed' blip and succeeds on the retry (the incident)", async () => {
    mockGet
      .mockRejectedValueOnce(transportErr("fetch failed"))
      .mockResolvedValueOnce(OWNER_BODY);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(verifyKbActorIsOwner(cfg, { sleep })).resolves.toBeUndefined();
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx (server transient) then succeeds", async () => {
    mockGet
      .mockRejectedValueOnce(httpErr(503, "service unavailable"))
      .mockResolvedValueOnce(OWNER_BODY);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(verifyKbActorIsOwner(cfg, { sleep })).resolves.toBeUndefined();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts transient failures with a KbOwnerCheckError", async () => {
    mockGet.mockRejectedValue(transportErr("fetch failed"));
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(
      verifyKbActorIsOwner(cfg, { sleep, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(KbOwnerCheckError);
    expect(mockGet).toHaveBeenCalledTimes(3);
    // backoff slept between each of the 3 attempts, i.e. twice.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("surfaces the underlying transport message in the final error", async () => {
    mockGet.mockRejectedValue(transportErr("fetch failed"));
    await expect(
      verifyKbActorIsOwner(cfg, { sleep: async () => {}, maxAttempts: 2 }),
    ).rejects.toThrow(/could not reach control[\s\S]*fetch failed/);
  });
});
