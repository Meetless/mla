// test/commands/status-observed-delivery.spec.ts
//
// `status` could describe what is CONFIGURED and never what was OBSERVED.
//
// After 9f18551e8 it stopped counting scanned directives as injected rules, which
// was the outright lie. What remained is subtler and is the same epistemic bug in a
// different field: `floorRules.length === 2` is a statement about a cache on disk,
// and printing it as "2 governed rules injected on every prompt" promotes a
// configuration fact into a delivery claim. Every state below has a populated cache,
// so that line reads identically across all of them: hook never installed, hook
// firing from a different checkout, hook firing and delivering nothing, hook
// delivering fine. Those are four different problems with one rendering.
//
// The 2026-08-07 audit (§2.2) put eight states in front of a user and found six
// indistinguishable, because every surface read local configuration files and none
// reported whether a turn actually delivered. The receipt that answers it already
// exists: hooks-template/user-prompt-submit.sh writes hook-receipt.json on EVERY
// arm, including the ones where the assembler never runs, and it now carries counts
// (`floorRules`, `scopedRules`, `path`, `delivery`, `degraded`, `cwd`).
//
// Two rules this pins, both from the review:
//   1. Observed is reported SEPARATELY from configured, never merged into one count.
//   2. It is observational, never a gate. An old or missing receipt means "last seen
//      X ago" / "nothing observed", never "broken", and `status` still exits 0.
//
// The `cwd` check is load-bearing rather than defensive. The receipt is keyed by
// WORKSPACE, and one workspace is routinely bound by several markers (this repo has
// three: the umbrella, meetless/, and intel/). Without it, standing in a checkout
// whose hook has never fired would confidently report a sibling checkout's delivery.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { renderStatus } from "../../src/commands/status";
import { writeScanCache, deliveryReceiptPath } from "../../src/lib/scanner/cache";
import type { PersistedDeliveryReceipt } from "../../src/lib/scanner/cache";

const WS = "ws-observed";

function seedCache(home: string): void {
  writeScanCache(home, WS, {
    schemaVersion: 2,
    workspaceId: WS,
    commitSha: "abc",
    generatedAt: "t",
    inventory: {
      instructionFiles: 1,
      decisionDocs: 0,
      legacyNotes: 0,
      staleSignals: 0,
      agentMemoryRules: 0,
    },
    directives: [
      {
        id: "a",
        text: "w",
        source: "CLAUDE.md",
        kind: "RULE",
        strength: "MUST_FOLLOW",
        attestation: "human_attested",
      },
    ],
    staleSignals: [],
    confirmedRulesXml: "",
    floorRulesXml: "x",
    staleContextXml: "",
    advisoryDirectives: [],
    // Two governed floor rules CONFIGURED. Whether they were ever delivered is a
    // separate question and is exactly what this suite is about.
    floorRules: [
      { id: "f1", text: "one", source: "bundle", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
      { id: "f2", text: "two", source: "bundle", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
    ],
    scopedRules: [],
  } as Parameters<typeof writeScanCache>[2]);
}

function writeReceipt(home: string, r: Partial<PersistedDeliveryReceipt>): void {
  const p = deliveryReceiptPath(WS, home);
  mkdirSync(dirname(p), { recursive: true });
  const full: PersistedDeliveryReceipt = {
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
    path: "assembler",
    delivery: "emitted",
    floorRules: 2,
    scopedRules: 1,
    bytes: 900,
    cwd: "/repo/here",
    freshness: "fresh",
    bundleId: "b1",
    ...r,
  };
  writeFileSync(p, JSON.stringify(full), "utf8");
}

describe("renderStatus: observed delivery is reported apart from configuration", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-status-obs-"));
    seedCache(home);
  });
  afterEach(() =>
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
  );

  it("never calls a configured floor count an injected one", () => {
    writeReceipt(home, {});
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    // A cache is not a delivery. The configured line must be phrased as configuration.
    expect(out).not.toContain("injected on every prompt");
    expect(out).toMatch(/configured for injection/);
    expect(out).toContain("2 governed floor rules");
  });

  it("reports the observed delivery, with counts, from the receipt", () => {
    writeReceipt(home, { floorRules: 2, scopedRules: 1 });
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).toMatch(/last delivery/i);
    expect(out).toContain("2 floor");
    expect(out).toContain("1 scoped");
  });

  it("says nothing has been observed when no hook has ever fired here", () => {
    // No receipt written at all: the hook has never run in this workspace.
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).toMatch(/no delivery observed/i);
    // It must NOT read as a failure. Silence here is the honest state on a fresh
    // install, not a diagnosis.
    expect(out).not.toMatch(/broken|error|FAIL/i);
  });

  it("refuses to credit this checkout with a sibling checkout's delivery", () => {
    // Same workspace, different root. This repo binds one workspace from three
    // markers, so this is the normal case, not a corner one.
    writeReceipt(home, { cwd: "/some/other/checkout" });
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).toMatch(/another checkout|different checkout/i);
    expect(out).toContain("/some/other/checkout");
    // And it must not present those counts as this repo's delivery.
    expect(out).not.toMatch(/last delivery: [^\n]*2 floor/);
  });

  // The hook writes `cwd: $PWD`, the raw working directory, NOT a resolved repo root
  // (hooks-template/user-prompt-submit.sh, emit_delivery_receipt). Anyone who starts
  // their agent from a subdirectory therefore produces a receipt whose cwd sits below
  // the root `status` resolves. Comparing for equality would tell most of those users
  // their delivery belongs to "another checkout", which is both wrong and alarming.
  it("counts a receipt written from a SUBDIRECTORY as this checkout", () => {
    writeReceipt(home, { cwd: "/repo/here/services/api" });
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).not.toMatch(/another checkout/i);
    expect(out).toContain("2 floor");
  });

  // The other direction of the same mistake: a plain prefix test would swallow a
  // sibling checkout whose path merely starts with the root's characters.
  it("does not mistake a sibling checkout sharing a path prefix for this one", () => {
    writeReceipt(home, { cwd: "/repo/here-other" });
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).toMatch(/another checkout/i);
    expect(out).toContain("/repo/here-other");
  });

  it("distinguishes a delivering turn from one that delivered no floor rules", () => {
    writeReceipt(home, { delivery: "missing", floorRules: 0, reason: "cache_root_mismatch" });
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).toMatch(/no floor rules/i);
    expect(out).toContain("cache_root_mismatch");
  });

  it("treats an inject-nothing turn as by design, not as a fault", () => {
    // `path: "none"` is the pull_only control arm. doctor already grades this info;
    // status must not contradict it.
    writeReceipt(home, { path: "none", delivery: "missing", floorRules: 0, reason: "pull_only" });
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).toMatch(/by design/i);
    expect(out).not.toMatch(/no floor rules delivered/i);
  });

  it("surfaces a degraded delivery without turning status into a gate", () => {
    writeReceipt(home, { degraded: "delivery-incomplete" });
    const out = renderStatus({
      home,
      workspaceId: WS,
      hooksInstalled: true,
      repoRoot: "/repo/here",
    });
    expect(out).toContain("delivery-incomplete");
  });

  it("stays silent about delivery when the caller cannot say which root it is in", () => {
    // No repoRoot: every existing caller and spec that omits it must keep working,
    // and an unattributable receipt is worse than no line at all.
    writeReceipt(home, {});
    const out = renderStatus({ home, workspaceId: WS, hooksInstalled: true });
    expect(out).toContain("Meetless is active");
    expect(out).not.toMatch(/last delivery/i);
  });
});
