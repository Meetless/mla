import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  runLiveCollector,
  appendLiveDecisions,
  DEFAULT_MAX_UPLOADS_PER_PASS,
} from "../../../src/lib/agent-memory-capture/live-collector";
import { enableBinding, disableBinding } from "../../../src/lib/agent-memory-capture/binding";
import { acquireBindingLock } from "../../../src/lib/agent-memory-capture/lock";
import { readLiveLedger } from "../../../src/lib/agent-memory-capture/live-ledger";
import { liveDecisionLogPath } from "../../../src/lib/agent-memory-capture/paths";
import { syntheticSourceId } from "../../../src/lib/agent-memory-capture/pipeline";
import type {
  UpsertClient,
  UpsertInput,
  UpsertResult,
  WithdrawInput,
  WithdrawResult,
} from "../../../src/lib/agent-memory-capture/upsert-client";
import type { LiveRecord } from "../../../src/lib/agent-memory-capture/types";

const NOW = "2026-06-27T00:00:00.000Z";

function projectFile(body: string): string {
  return `---\nname: x\nmetadata:\n  type: project\n---\n${body}\n`;
}

interface FakeClient extends UpsertClient {
  upsertCount: number;
  withdrawCount: number;
  upsertedPaths: string[];
}

// A fake UpsertClient that ACKS with a server-echoed hash equal to the local hash
// (COMMIT-1 passes) unless an override forces a failure/throw.
function makeClient(opts?: {
  upsertImpl?: (input: UpsertInput, n: number) => UpsertResult | Promise<UpsertResult>;
  withdrawImpl?: (input: WithdrawInput, n: number) => WithdrawResult | Promise<WithdrawResult>;
}): FakeClient {
  let upserts = 0;
  let withdraws = 0;
  const upsertedPaths: string[] = [];
  return {
    get upsertCount() {
      return upserts;
    },
    get withdrawCount() {
      return withdraws;
    },
    upsertedPaths,
    async upsert(input: UpsertInput): Promise<UpsertResult> {
      const n = ++upserts;
      upsertedPaths.push(input.relPath);
      if (opts?.upsertImpl) return opts.upsertImpl(input, n);
      return {
        ok: true,
        outcome: "created",
        serverContentHash: input.contentHash,
        revisionId: `rev-${n}`,
        logicalSourceId: `src-${n}`,
        reason: "ingested",
      };
    },
    async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
      const n = ++withdraws;
      if (opts?.withdrawImpl) return opts.withdrawImpl(input, n);
      return { ok: true, withdrawn: true, retiredPendingDerived: 0, reason: "withdrawn" };
    },
  };
}

describe("appendLiveDecisions", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amlc-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function rec(outcome: LiveRecord["outcome"], rel: string): LiveRecord {
    return {
      sourceId: syntheticSourceId("b", rel),
      relativePath: rel,
      hash: "f".repeat(64),
      bytes: 1,
      outcome,
      reason: "x",
      secretRuleIds: [],
      observedAt: NOW,
    };
  }

  it("persists only the actionable outcomes (drops unchanged/skipped)", () => {
    const n = appendLiveDecisions(
      "b",
      [rec("uploaded", "a.md"), rec("unchanged", "b.md"), rec("skipped", "c.md"), rec("deferred", "d.md")],
      home,
    );
    expect(n).toBe(2);
    const lines = readFileSync(liveDecisionLogPath("b", home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const outcomes = lines.map((l) => JSON.parse(l).outcome).sort();
    expect(outcomes).toEqual(["deferred", "uploaded"]);
  });

  it("writes nothing when there is no actionable record", () => {
    const n = appendLiveDecisions("b", [rec("unchanged", "a.md")], home);
    expect(n).toBe(0);
    expect(existsSync(liveDecisionLogPath("b", home))).toBe(false);
  });
});

describe("runLiveCollector (gates + per-binding pass)", () => {
  let home: string;
  let mem: string;

  function enable(memDir: string): string {
    const out = enableBinding(memDir, "ws-1", NOW, home);
    if (!out.ok) throw new Error("enable failed: " + out.reason);
    return out.binding.bindingId;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amlc-home-"));
    mem = mkdtempSync(join(tmpdir(), "amlc-mem-"));
  });
  afterEach(() => {
    for (const d of [home, mem]) rmSync(d, { recursive: true, force: true });
  });

  it("Gate 1: an injected client with no actor is refused (never upload anonymously)", async () => {
    enable(mem);
    writeFileSync(join(mem, "a.md"), projectFile("durable"));
    const client = makeClient();
    const res = await runLiveCollector({ nowIso: NOW, home, client, actor: "" });
    expect(res).toEqual([]);
    expect(client.upsertCount).toBe(0);
  });

  it("Gate 2: no enabled bindings -> [] and no client call", async () => {
    const client = makeClient();
    const res = await runLiveCollector({ nowIso: NOW, home, client, actor: "u" });
    expect(res).toEqual([]);
    expect(client.upsertCount).toBe(0);
  });

  it("Gate 2: a disabled binding is not enumerated", async () => {
    enable(mem);
    disableBinding(mem, home);
    writeFileSync(join(mem, "a.md"), projectFile("durable"));
    const client = makeClient();
    const res = await runLiveCollector({ nowIso: NOW, home, client, actor: "u" });
    expect(res).toEqual([]);
    expect(client.upsertCount).toBe(0);
  });

  it("uploads a clean project file, appends the actionable outcome, advances the live ledger", async () => {
    const id = enable(mem);
    writeFileSync(join(mem, "a.md"), projectFile("durable claim"));
    const client = makeClient();
    const res = await runLiveCollector({ nowIso: NOW, home, client, actor: "u" });

    expect(res).toHaveLength(1);
    expect(res[0].locked).toBe(true);
    expect(res[0].summary).not.toBeNull();
    expect(res[0].appended).toBe(1);
    expect(client.upsertCount).toBe(1);
    expect(client.upsertedPaths[0]).toBe(syntheticSourceId(id, "a.md"));

    // The live ledger settled to the acked hash (COMMIT-1).
    const led = readLiveLedger(id, home).entries["a.md"];
    expect(led.lastUploadedHash).toMatch(/^[0-9a-f]{64}$/);

    // The decision log holds the actionable outcome and never the raw content.
    const log = readFileSync(liveDecisionLogPath(id, home), "utf8").trim();
    expect(JSON.parse(log).outcome).toBe("uploaded");
    expect(log).not.toContain("durable claim");
  });

  it("with no injected client, resolves the actor from cfg and builds the real client (no network at Gate 2)", async () => {
    // No client injected -> resolveClientAndActor reads cfg (bypassing readConfig),
    // takes the actor from cfg.actorUserId, and constructs createIntelUpsertClient.
    // Disabling the binding stops the run at Gate 2 BEFORE any network op, so this
    // proves actor/client resolution without uploading.
    enable(mem);
    disableBinding(mem, home);
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const res = await runLiveCollector({
      nowIso: NOW,
      home,
      cfg: { actorUserId: "cfg-user" } as never,
    });
    expect(res).toEqual([]);
  });

  it("no-client + cfg without an actor -> [] (Gate 1 via config)", async () => {
    enable(mem);
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const res = await runLiveCollector({
      nowIso: NOW,
      home,
      cfg: { actorUserId: "" } as never,
    });
    expect(res).toEqual([]);
  });

  it("per-binding lock contention surfaces locked:false with no client call", async () => {
    const id = enable(mem);
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const held = acquireBindingLock(id, NOW, home);
    expect(held).not.toBeNull();
    const client = makeClient();
    try {
      const res = await runLiveCollector({ nowIso: NOW, home, client, actor: "u" });
      expect(res).toHaveLength(1);
      expect(res[0].locked).toBe(false);
      expect(res[0].summary).toBeNull();
      expect(res[0].appended).toBe(0);
      expect(client.upsertCount).toBe(0);
    } finally {
      held!.release();
    }
  });

  it("is fail-soft: one binding whose pipeline throws is caught; the lock is released", async () => {
    const id = enable(mem);
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const throwing = makeClient({
      upsertImpl: () => {
        throw new Error("boom");
      },
    });
    const res = await runLiveCollector({ nowIso: NOW, home, client: throwing, actor: "u" });
    expect(res).toHaveLength(1);
    expect(res[0].locked).toBe(false);
    expect(res[0].summary).toBeNull();

    // The lock must have been released (finally), so a subsequent good pass works.
    const good = makeClient();
    const res2 = await runLiveCollector({ nowIso: NOW, home, client: good, actor: "u" });
    expect(res2[0].locked).toBe(true);
    expect(good.upsertCount).toBe(1);
    expect(readLiveLedger(id, home).entries["a.md"].lastUploadedHash).toBeTruthy();
  });

  it("honors an explicit per-pass upload cap: the rest defer (no-backfill, §6)", async () => {
    enable(mem);
    writeFileSync(join(mem, "a.md"), projectFile("one"));
    writeFileSync(join(mem, "b.md"), projectFile("two"));
    writeFileSync(join(mem, "c.md"), projectFile("three"));
    const client = makeClient();
    const res = await runLiveCollector({
      nowIso: NOW,
      home,
      client,
      actor: "u",
      maxUploadsPerPass: 1,
    });
    const outcomes = res[0].summary!.records.map((r) => r.outcome).sort();
    expect(client.upsertCount).toBe(1);
    expect(outcomes).toEqual(["deferred", "deferred", "uploaded"]);
  });

  it("resolves the cap from MEETLESS_AGENT_MEMORY_MAX_UPLOADS when not passed explicitly", async () => {
    enable(mem);
    writeFileSync(join(mem, "a.md"), projectFile("one"));
    writeFileSync(join(mem, "b.md"), projectFile("two"));
    const client = makeClient();
    const res = await runLiveCollector({
      nowIso: NOW,
      home,
      client,
      actor: "u",
      env: { MEETLESS_AGENT_MEMORY_MAX_UPLOADS: "1" } as NodeJS.ProcessEnv,
    });
    expect(client.upsertCount).toBe(1);
    expect(res[0].summary!.records.filter((r) => r.outcome === "deferred")).toHaveLength(1);
  });

  it("exposes a conservative default cap", () => {
    expect(DEFAULT_MAX_UPLOADS_PER_PASS).toBe(25);
  });
});
