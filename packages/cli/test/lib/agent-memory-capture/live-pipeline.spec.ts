import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  collectAndUploadOnce,
  isLiveActionable,
  type LiveCollectDeps,
} from "../../../src/lib/agent-memory-capture/live-pipeline";
import { syntheticSourceId } from "../../../src/lib/agent-memory-capture/pipeline";
import { MAX_FILE_BYTES } from "../../../src/lib/agent-memory-capture/containment";
import { readLiveLedger } from "../../../src/lib/agent-memory-capture/live-ledger";
import type {
  UpsertClient,
  UpsertInput,
  UpsertResult,
  WithdrawInput,
  WithdrawResult,
} from "../../../src/lib/agent-memory-capture/upsert-client";
import type {
  LiveRecord,
  MemoryBinding,
} from "../../../src/lib/agent-memory-capture/types";

const NOW = "2026-06-27T00:00:00.000Z";

function projectFile(body: string): string {
  return `---\nname: x\nmetadata:\n  type: project\n---\n${body}\n`;
}
function userFile(): string {
  return `---\nname: x\nmetadata:\n  type: user\n---\nbody\n`;
}

function byRel(records: LiveRecord[], rel: string): LiveRecord | undefined {
  return records.find((r) => r.relativePath === rel);
}

interface FakeCall {
  type: "upsert" | "withdraw";
  input: UpsertInput | WithdrawInput;
}

interface FakeClient extends UpsertClient {
  calls: FakeCall[];
  upsertCount: number;
  withdrawCount: number;
}

// A fake UpsertClient that records every call and, by default, ACKS with a
// server-echoed content hash equal to the local hash (so COMMIT-1 passes). Tests
// override upsert/withdraw per scenario to drive failure/mismatch paths.
function makeClient(opts?: {
  upsertImpl?: (input: UpsertInput, n: number) => UpsertResult | Promise<UpsertResult>;
  withdrawImpl?: (input: WithdrawInput, n: number) => WithdrawResult | Promise<WithdrawResult>;
}): FakeClient {
  const calls: FakeCall[] = [];
  let upserts = 0;
  let withdraws = 0;
  const client: FakeClient = {
    calls,
    get upsertCount() {
      return upserts;
    },
    get withdrawCount() {
      return withdraws;
    },
    async upsert(input: UpsertInput): Promise<UpsertResult> {
      calls.push({ type: "upsert", input });
      const n = ++upserts;
      if (opts?.upsertImpl) return opts.upsertImpl(input, n);
      return {
        ok: true,
        outcome: "created",
        serverContentHash: input.contentHash, // honest echo -> COMMIT-1 passes
        revisionId: `rev-${n}`,
        logicalSourceId: `src-${n}`,
        reason: "ingested",
      };
    },
    async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
      calls.push({ type: "withdraw", input });
      const n = ++withdraws;
      if (opts?.withdrawImpl) return opts.withdrawImpl(input, n);
      return { ok: true, withdrawn: true, retiredPendingDerived: 0, reason: "withdrawn" };
    },
  };
  return client;
}

describe("collectAndUploadOnce (live §4 router)", () => {
  let home: string;
  let mem: string;
  let binding: MemoryBinding;

  function deps(client: UpsertClient, over?: Partial<LiveCollectDeps>): LiveCollectDeps {
    return { client, actor: "user-1", nowIso: NOW, home, ...over };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amp-live-home-"));
    mem = mkdtempSync(join(tmpdir(), "amp-live-mem-"));
    binding = {
      bindingId: "bind-1",
      memoryDir: mem,
      workspaceId: "ws-1",
      enabled: true,
      consentedAt: NOW,
    };
  });
  afterEach(() => {
    for (const d of [home, mem]) rmSync(d, { recursive: true, force: true });
  });

  it("new clean project file -> uploaded; ledger settles to the acked hash (COMMIT-1)", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("durable claim"));
    const client = makeClient();
    const sum = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum.records, "a.md")!;
    expect(r.outcome).toBe("uploaded");
    expect(r.reason).toBe("new");
    expect(r.revisionId).toBe("rev-1");
    expect(client.upsertCount).toBe(1);
    expect((client.calls[0].input as UpsertInput).relPath).toBe(
      syntheticSourceId("bind-1", "a.md"),
    );

    const led = readLiveLedger("bind-1", home).entries["a.md"];
    expect(led.lastUploadedHash).toBe(r.hash);
    expect(led.lastUploadedRevisionId).toBe("rev-1");
    expect(led.lastLogicalSourceId).toBe("src-1");
    expect(led.lastSourceId).toBe(syntheticSourceId("bind-1", "a.md"));
  });

  it("unchanged on a second pass -> unchanged; the client is NOT called again", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("same"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client));
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sum2.records, "a.md")!.outcome).toBe("unchanged");
    expect(client.upsertCount).toBe(1); // not re-uploaded
  });

  it("changed content -> re-uploads with reason 'changed' and re-settles the ledger", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("v1"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client));
    const h1 = readLiveLedger("bind-1", home).entries["a.md"].lastUploadedHash;
    writeFileSync(join(mem, "a.md"), projectFile("v2 different"));
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum2.records, "a.md")!;
    expect(r.outcome).toBe("uploaded");
    expect(r.reason).toBe("changed");
    expect(client.upsertCount).toBe(2);
    expect(readLiveLedger("bind-1", home).entries["a.md"].lastUploadedHash).not.toBe(h1);
  });

  it("COMMIT-1: a server hash that disagrees -> failed (hash_mismatch); ledger NOT advanced", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const client = makeClient({
      upsertImpl: (input, n) => ({
        ok: true,
        outcome: "created",
        serverContentHash: "deadbeef".repeat(8), // lies about the bytes
        revisionId: `rev-${n}`,
        logicalSourceId: `src-${n}`,
        reason: "ingested",
      }),
    });
    const sum = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum.records, "a.md")!;
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("hash_mismatch");
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("COMMIT-1 degraded: server omits the echo (null) -> commits on outcome alone", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const client = makeClient({
      upsertImpl: (input, n) => ({
        ok: true,
        outcome: "created",
        serverContentHash: null, // older intel: no echo
        revisionId: `rev-${n}`,
        logicalSourceId: `src-${n}`,
        reason: "ingested",
      }),
    });
    const sum = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum.records, "a.md")!;
    expect(r.outcome).toBe("uploaded");
    expect(readLiveLedger("bind-1", home).entries["a.md"].lastUploadedHash).toBe(r.hash);
  });

  it("RETRY-2: a transport failure leaves the ledger empty and re-attempts next pass", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    let fail = true;
    const client = makeClient({
      upsertImpl: (input, n) => {
        if (fail) {
          return {
            ok: false,
            outcome: "failed",
            serverContentHash: null,
            revisionId: null,
            logicalSourceId: null,
            reason: "upload_failed: ECONNREFUSED",
          };
        }
        return {
          ok: true,
          outcome: "created",
          serverContentHash: input.contentHash,
          revisionId: `rev-${n}`,
          logicalSourceId: `src-${n}`,
          reason: "ingested",
        };
      },
    });
    const sum1 = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sum1.records, "a.md")!.outcome).toBe("failed");
    // No bare entry created for a never-settled file (so deletion reconciliation
    // can never later withdraw something that was never uploaded).
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();

    fail = false;
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sum2.records, "a.md")!.outcome).toBe("uploaded");
    expect(client.upsertCount).toBe(2); // re-attempted
    expect(readLiveLedger("bind-1", home).entries["a.md"].lastUploadedHash).toBeTruthy();
  });

  it("RETRY-2: a per-document 'failed' inside a 2xx receipt does not advance the ledger", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const client = makeClient({
      upsertImpl: () => ({
        ok: true,
        outcome: "failed",
        serverContentHash: null,
        revisionId: null,
        logicalSourceId: null,
        reason: "intake_failed",
      }),
    });
    const sum = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sum.records, "a.md")!.outcome).toBe("failed");
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("a failed re-upload of a SETTLED file keeps lastUploadedHash (only stamps the attempt)", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("v1"));
    let n = 0;
    const client = makeClient({
      upsertImpl: (input, callNo) => {
        n = callNo;
        if (callNo === 1) {
          return {
            ok: true,
            outcome: "created",
            serverContentHash: input.contentHash,
            revisionId: "rev-1",
            logicalSourceId: "src-1",
            reason: "ingested",
          };
        }
        return {
          ok: false,
          outcome: "failed",
          serverContentHash: null,
          revisionId: null,
          logicalSourceId: null,
          reason: "upload_failed: ETIMEDOUT",
        };
      },
    });
    await collectAndUploadOnce(binding, deps(client));
    const settled = readLiveLedger("bind-1", home).entries["a.md"].lastUploadedHash;
    writeFileSync(join(mem, "a.md"), projectFile("v2"));
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sum2.records, "a.md")!.outcome).toBe("failed");
    const led = readLiveLedger("bind-1", home).entries["a.md"];
    expect(led.lastUploadedHash).toBe(settled); // unchanged: still points at v1
    expect(led.lastAttemptAt).toBe(NOW);
    expect(n).toBe(2);
  });

  it("SECRET-1: a credential-format file is BLOCKED pre-upload and never reaches the client", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("config: requirepass O3o7j8zX"));
    const client = makeClient();
    const sum = await collectAndUploadOnce(binding, deps(client, { scannerVersion: "vTest" }));
    const r = byRel(sum.records, "a.md")!;
    expect(r.outcome).toBe("blocked");
    expect(r.secretRuleIds).toContain("redis_directive");
    expect(client.upsertCount).toBe(0); // never transmitted
    const led = readLiveLedger("bind-1", home).entries["a.md"];
    expect(led.blockedHash).toBe(r.hash);
    expect(led.blockedScannerVersion).toBe("vTest");
    expect(led.lastUploadedHash).toBeUndefined();
  });

  it("block: same bytes + same scanner version -> unchanged (no re-emit)", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("requirepass O3o7j8zX"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client, { scannerVersion: "vTest" }));
    const sum2 = await collectAndUploadOnce(binding, deps(client, { scannerVersion: "vTest" }));
    expect(byRel(sum2.records, "a.md")!.outcome).toBe("unchanged");
    expect(client.upsertCount).toBe(0);
  });

  it("block: re-evaluated when the scanner version bumps (RETRY-2 for blocks)", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("requirepass O3o7j8zX"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client, { scannerVersion: "v1" }));
    const sum2 = await collectAndUploadOnce(binding, deps(client, { scannerVersion: "v2" }));
    expect(byRel(sum2.records, "a.md")!.outcome).toBe("blocked");
    expect(readLiveLedger("bind-1", home).entries["a.md"].blockedScannerVersion).toBe("v2");
  });

  it("block then revert to a previously-uploaded clean hash -> unchanged + clears the block marker", async () => {
    const clean = projectFile("clean v1");
    writeFileSync(join(mem, "a.md"), clean);
    const client = makeClient();
    // 1) upload clean
    await collectAndUploadOnce(binding, deps(client, { scannerVersion: "vTest" }));
    // 2) introduce a credential -> blocked, but the prior upload settle is kept
    writeFileSync(join(mem, "a.md"), projectFile("requirepass O3o7j8zX"));
    await collectAndUploadOnce(binding, deps(client, { scannerVersion: "vTest" }));
    let led = readLiveLedger("bind-1", home).entries["a.md"];
    expect(led.blockedHash).toBeTruthy();
    expect(led.lastUploadedHash).toBeTruthy();
    // 3) revert to the exact clean bytes -> unchanged (already on the server),
    // block marker cleared, client not called again
    writeFileSync(join(mem, "a.md"), clean);
    const sum3 = await collectAndUploadOnce(binding, deps(client, { scannerVersion: "vTest" }));
    expect(byRel(sum3.records, "a.md")!.outcome).toBe("unchanged");
    led = readLiveLedger("bind-1", home).entries["a.md"];
    expect(led.blockedHash).toBeUndefined();
    expect(led.blockedScannerVersion).toBeUndefined();
    expect(client.upsertCount).toBe(1); // only the first clean upload
  });

  it("off mode: the scanner is never invoked and a secret-bearing file uploads", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("requirepass O3o7j8zX"));
    let called = false;
    const client = makeClient();
    const sum = await collectAndUploadOnce(
      binding,
      deps(client, {
        scannerMode: "off",
        scan: () => {
          called = true;
          return ["redis_directive"];
        },
      }),
    );
    expect(called).toBe(false);
    expect(byRel(sum.records, "a.md")!.outcome).toBe("uploaded");
    expect(client.upsertCount).toBe(1);
  });

  it("block mode: a scanner outage -> failed scanner_unavailable; nothing uploaded, no ledger mutation", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("clean body"));
    const client = makeClient();
    const sum = await collectAndUploadOnce(
      binding,
      deps(client, {
        scan: () => {
          throw new Error("scanner down");
        },
      }),
    );
    const r = byRel(sum.records, "a.md")!;
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("scanner_unavailable");
    expect(client.upsertCount).toBe(0);
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("reclassify: a tracked project file turns non-project -> WITHDRAW_SOURCE; entry removed on success", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("was project"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client));
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeDefined();
    writeFileSync(join(mem, "a.md"), userFile());
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum2.records, "a.md")!;
    expect(r.outcome).toBe("reclassified");
    expect(client.withdrawCount).toBe(1);
    expect((client.calls.find((c) => c.type === "withdraw")!.input as WithdrawInput).reason).toBe(
      "reclassified",
    );
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("reclassify withdraw FAILS -> entry kept for retry, failed record", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("was project"));
    const client = makeClient({
      withdrawImpl: () => ({
        ok: false,
        withdrawn: false,
        retiredPendingDerived: null,
        reason: "withdraw_failed: 503",
      }),
    });
    await collectAndUploadOnce(binding, deps(client));
    writeFileSync(join(mem, "a.md"), userFile());
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sum2.records, "a.md")!.outcome).toBe("failed");
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeDefined();
  });

  it("non-project never tracked -> skipped; no network call", async () => {
    writeFileSync(join(mem, "u.md"), userFile());
    const client = makeClient();
    const sum = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sum.records, "u.md")!.outcome).toBe("skipped");
    expect(client.upsertCount).toBe(0);
    expect(client.withdrawCount).toBe(0);
    expect(readLiveLedger("bind-1", home).entries["u.md"]).toBeUndefined();
  });

  it("delete: tracked file absent after a COMPLETE scan -> WITHDRAW_SOURCE(deleted); entry removed", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("here"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client));
    unlinkSync(join(mem, "a.md"));
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum2.records, "a.md")!;
    expect(r.outcome).toBe("deleted");
    expect((client.calls.find((c) => c.type === "withdraw")!.input as WithdrawInput).reason).toBe(
      "deleted",
    );
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("delete withdraw FAILS -> entry kept for the next complete pass", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("here"));
    let phase = 0;
    const client = makeClient({
      withdrawImpl: () => {
        if (phase === 1) {
          return {
            ok: false,
            withdrawn: false,
            retiredPendingDerived: null,
            reason: "withdraw_failed: 500",
          };
        }
        return { ok: true, withdrawn: true, retiredPendingDerived: 0, reason: "withdrawn" };
      },
    });
    await collectAndUploadOnce(binding, deps(client));
    unlinkSync(join(mem, "a.md"));
    phase = 1;
    const sumFail = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sumFail.records, "a.md")!.outcome).toBe("failed");
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeDefined();
    phase = 2;
    const sumOk = await collectAndUploadOnce(binding, deps(client));
    expect(byRel(sumOk.records, "a.md")!.outcome).toBe("deleted");
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("deletions are NOT reconciled when the scan is incomplete (memory dir vanished)", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("here"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client));
    // Point the binding at a path that cannot be enumerated -> complete=false.
    const gone = join(mem, "does-not-exist");
    const sum2 = await collectAndUploadOnce(
      { ...binding, memoryDir: gone },
      deps(client),
    );
    expect(sum2.scanComplete).toBe(false);
    expect(sum2.records.some((r) => r.outcome === "deleted")).toBe(false);
    expect(client.withdrawCount).toBe(0);
    // The ledger entry survives the incomplete pass.
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeDefined();
  });

  it("malformed frontmatter -> failed; no network call, no lifecycle change", async () => {
    writeFileSync(join(mem, "a.md"), "---\nname: x\ntype: project\nno closing fence\n");
    const client = makeClient();
    const sum = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum.records, "a.md")!;
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("malformed_frontmatter");
    expect(client.upsertCount).toBe(0);
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("oversized file -> failed (oversized); never read, never uploaded", async () => {
    writeFileSync(join(mem, "big.md"), projectFile("z".repeat(MAX_FILE_BYTES + 10)));
    const client = makeClient();
    const sum = await collectAndUploadOnce(binding, deps(client));
    const r = byRel(sum.records, "big.md")!;
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("oversized");
    expect(r.hash).toBeNull();
    expect(client.upsertCount).toBe(0);
  });

  it("a clean scan that just runs again does not invent deletions", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("present"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client));
    const sum2 = await collectAndUploadOnce(binding, deps(client));
    expect(sum2.records.some((r) => r.outcome === "deleted")).toBe(false);
    expect(client.withdrawCount).toBe(0);
  });

  it("no-backfill cap (§6): uploads up to the cap, defers the rest, leaves them UNSETTLED", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("one"));
    writeFileSync(join(mem, "b.md"), projectFile("two"));
    writeFileSync(join(mem, "c.md"), projectFile("three"));
    const client = makeClient();
    const sum = await collectAndUploadOnce(binding, deps(client, { maxUploadsPerPass: 1 }));
    const uploaded = sum.records.filter((r) => r.outcome === "uploaded");
    const deferred = sum.records.filter((r) => r.outcome === "deferred");
    expect(uploaded).toHaveLength(1);
    expect(deferred).toHaveLength(2);
    expect(client.upsertCount).toBe(1);
    // A deferred file is left UNSETTLED: no ledger entry, so the next pass re-attempts.
    const led = readLiveLedger("bind-1", home).entries;
    expect(Object.keys(led)).toHaveLength(1); // only the one uploaded file settled
    expect(deferred.every((r) => led[r.relativePath] === undefined)).toBe(true);
  });

  it("the deferred backlog drains across successive passes (cap per pass)", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("one"));
    writeFileSync(join(mem, "b.md"), projectFile("two"));
    const client = makeClient();
    const sum1 = await collectAndUploadOnce(binding, deps(client, { maxUploadsPerPass: 1 }));
    expect(sum1.records.filter((r) => r.outcome === "uploaded")).toHaveLength(1);
    expect(sum1.records.filter((r) => r.outcome === "deferred")).toHaveLength(1);
    // Second pass: the already-uploaded file is unchanged; the deferred one uploads.
    const sum2 = await collectAndUploadOnce(binding, deps(client, { maxUploadsPerPass: 1 }));
    expect(sum2.records.filter((r) => r.outcome === "uploaded")).toHaveLength(1);
    expect(sum2.records.filter((r) => r.outcome === "deferred")).toHaveLength(0);
    expect(client.upsertCount).toBe(2);
    expect(Object.keys(readLiveLedger("bind-1", home).entries)).toHaveLength(2);
  });

  it("the cap counts upload ATTEMPTS, not files: unchanged/blocked/withdraw do not consume budget", async () => {
    // a.md is already settled (unchanged this pass), u.md reclassifies (withdraw),
    // and two fresh project files compete for a cap of 1.
    writeFileSync(join(mem, "a.md"), projectFile("settled"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client)); // settle a.md (uncapped)
    expect(client.upsertCount).toBe(1);

    writeFileSync(join(mem, "b.md"), projectFile("fresh one"));
    writeFileSync(join(mem, "c.md"), projectFile("fresh two"));
    const sum = await collectAndUploadOnce(binding, deps(client, { maxUploadsPerPass: 1 }));
    expect(byRel(sum.records, "a.md")!.outcome).toBe("unchanged"); // no upload attempt
    // exactly one of b/c uploaded, the other deferred
    const fresh = [byRel(sum.records, "b.md")!.outcome, byRel(sum.records, "c.md")!.outcome].sort();
    expect(fresh).toEqual(["deferred", "uploaded"]);
    expect(client.upsertCount).toBe(2); // 1 from setup + 1 fresh this pass
  });

  it("withdraws are uncapped (cleanup, not backfill): a delete still reconciles under a cap of 0", async () => {
    writeFileSync(join(mem, "a.md"), projectFile("here"));
    const client = makeClient();
    await collectAndUploadOnce(binding, deps(client)); // settle (uncapped)
    unlinkSync(join(mem, "a.md"));
    const sum = await collectAndUploadOnce(binding, deps(client, { maxUploadsPerPass: 0 }));
    expect(byRel(sum.records, "a.md")!.outcome).toBe("deleted");
    expect(client.withdrawCount).toBe(1);
    expect(readLiveLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("isLiveActionable omits the no-op outcomes", () => {
    expect(isLiveActionable("unchanged")).toBe(false);
    expect(isLiveActionable("skipped")).toBe(false);
    expect(isLiveActionable("uploaded")).toBe(true);
    expect(isLiveActionable("blocked")).toBe(true);
    expect(isLiveActionable("deleted")).toBe(true);
    expect(isLiveActionable("reclassified")).toBe(true);
    expect(isLiveActionable("failed")).toBe(true);
    expect(isLiveActionable("deferred")).toBe(true);
  });
});
