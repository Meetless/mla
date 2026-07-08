import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  runRulesAddBackend,
  runRulesAttestBackend,
  runRulesDemoteBackend,
  runRulesEditBackend,
  runRulesListBackend,
  runRulesRemoveBackend,
  runRulesRevokeBackend,
} from "../../src/commands/rules-backend";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import type {
  RuleClientHttp,
  RuleNodeView,
  RuleBundle,
} from "../../src/lib/rules/control-rule-client";
import type { BundleCacheRead, BundlePrincipal } from "../../src/lib/rules/bundle-cache";
import { makeManagedRule } from "../../src/lib/scanner/managed-rules";
import { managedRuleToRulePayload } from "../../src/lib/rules/rule-import-mapping";
import { ruleVersionHash } from "../../src/lib/rules/rule-version-hash";
import { openCe0Store, closeCe0Store, type Ce0Store } from "../../src/lib/rules/ce0-store";
import {
  insertToolAttempt,
  insertRuleEvaluationRecord,
  type ToolAttemptRecord,
  type RuleEvaluationRecord,
} from "../../src/lib/rules/interception-store";
import { observedRuleHash, serializeObservedRule } from "../../src/lib/rules/observed-rule-hash";
import { convertNotesLocationSnapshot } from "../../src/lib/rules/attest-notes-location";
import type { ObservedRuleSpec, RulePayloadV1 } from "../../src/lib/rules/types";

// P1E (rules-store-unification §7 / G1): the backend `mla rules` verbs. The http seam
// (RuleClientHttp) is the established CLI test boundary (the publish-bridge convention), not an
// internal-service mock: a programmable fake records every call and returns a node or throws a
// status-bearing HTTP error / a status-less offline error. attest's LOCAL observed-snapshot
// resolution is exercised against one REAL ce0 database (no store mock), mirroring the legacy
// attest spec; only the SINK (the backend mint) is the injected http seam.

const WS = "ws_1";

function cfg(): WorkspaceCliConfig {
  return {
    workspaceId: WS,
    controlUrl: "https://control.test",
    controlToken: "tok",
    auth: { mode: "shared-key", accessToken: "tok" },
  } as WorkspaceCliConfig;
}

interface RecordedCall {
  verb: "get" | "post" | "patch";
  path: string;
  body?: unknown;
}

type Handler = (path: string, body?: unknown) => unknown;

/** A status-bearing HTTP error (what buildError produces for a 4xx/5xx). */
function httpError(status: number): Error {
  const e = new Error(`HTTP ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

/** A status-LESS transport error (ECONNREFUSED / abort): the backend was never reached. */
function offlineError(): Error {
  return new Error("connect ECONNREFUSED 127.0.0.1:3000");
}

function fakeHttp(handlers: { get?: Handler; post?: Handler; patch?: Handler }): {
  http: RuleClientHttp;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const mk =
    (verb: "get" | "post" | "patch") =>
    async (_cfg: unknown, p: string, body?: unknown) => {
      calls.push({ verb, path: p, body });
      const h = handlers[verb];
      if (!h) throw new Error(`unexpected ${verb} ${p}`);
      return h(p, body);
    };
  const http: RuleClientHttp = {
    get: mk("get") as RuleClientHttp["get"],
    post: mk("post") as RuleClientHttp["post"],
    patch: mk("patch") as RuleClientHttp["patch"],
  };
  return { http, calls };
}

interface Rec {
  out: string[];
  err: string[];
}
function sink(): { rec: Rec; out: (l: string) => void; err: (l: string) => void } {
  const rec: Rec = { out: [], err: [] };
  return { rec, out: (l) => rec.out.push(l), err: (l) => rec.err.push(l) };
}

function node(over: Partial<RuleNodeView> = {}): RuleNodeView {
  return {
    id: "node_1",
    workspaceId: WS,
    authorityScopeId: "TEAM",
    ownerUserId: null,
    projectId: null,
    lifecycleStatusId: "ACTIVE",
    currentVersionId: "ver_1",
    currentVersion: {
      id: "ver_1",
      ruleId: "node_1",
      payload: managedRuleToRulePayload(makeManagedRule({ statement: "old rule" }), "scope_existing"),
      canonicalPayloadHash: "h1",
      supersedesVersionId: null,
      attestedByUserId: "user_an",
      attestedAt: "2026-06-28T00:00:00.000Z",
      requestIdempotencyKey: null,
    },
    ...over,
  };
}

const HUMAN = () => ({ userId: "user_an", displayName: "An" });
const NO_OPERATOR = () => null;

// ───────────────────────────────────────────────────────────────────────────
// list
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesListBackend", () => {
  it("reads ACTIVE rules from the backend and renders one line per rule", async () => {
    const { http, calls } = fakeHttp({ get: () => [node(), node({ id: "node_2" })] });
    const { rec, out, err } = sink();
    const code = await runRulesListBackend([], { loadConfig: cfg, http, out, err });
    expect(code).toBe(0);
    expect(calls).toEqual([
      { verb: "get", path: "/internal/v1/rules?workspaceId=ws_1&lifecycleStatus=ACTIVE", body: undefined },
    ]);
    expect(rec.out).toHaveLength(2);
    expect(rec.out[0]).toContain("node_1");
  });

  it("includes revoked rules with --revoked (no lifecycle filter)", async () => {
    const { http, calls } = fakeHttp({ get: () => [] });
    const { out, err } = sink();
    await runRulesListBackend(["--revoked"], { loadConfig: cfg, http, out, err });
    expect(calls[0].path).toBe("/internal/v1/rules?workspaceId=ws_1");
  });

  it("--json dumps the raw node array", async () => {
    const nodes = [node()];
    const { http } = fakeHttp({ get: () => nodes });
    const { rec, out, err } = sink();
    await runRulesListBackend(["--json"], { loadConfig: cfg, http, out, err });
    expect(JSON.parse(rec.out.join("\n"))).toEqual(nodes);
  });

  it("prints (no rules) on an empty backend set", async () => {
    const { http } = fakeHttp({ get: () => [] });
    const { rec, out, err } = sink();
    const code = await runRulesListBackend([], { loadConfig: cfg, http, out, err });
    expect(code).toBe(0);
    expect(rec.out).toEqual(["(no rules)"]);
  });

  it("falls back to the principal bundle when OFFLINE, stamping revision + age (acceptance 16)", async () => {
    const { http } = fakeHttp({
      get: () => {
        throw offlineError();
      },
    });
    const bundle: RuleBundle = {
      schemaVersion: 1,
      principalUserId: "user_an",
      workspaceId: WS,
      projectId: null,
      bundleRevision: 7,
      generatedAt: "2026-06-28T00:00:00.000Z",
      validUntil: "2026-06-29T00:00:00.000Z",
      rules: [
        {
          ruleNodeId: "node_9",
          ruleVersionId: "ver_9",
          authorityScope: "TEAM",
          ownerUserId: null,
          projectId: null,
          payload: managedRuleToRulePayload(makeManagedRule({ statement: "cached rule" }), "scope_1"),
          canonicalPayloadHash: "hc",
          attestedByUserId: null,
          attestedAt: "2026-06-28T00:00:00.000Z",
          supersedesVersionId: null,
        },
      ],
    };
    const read: BundleCacheRead = {
      status: "fresh",
      bundle,
      ageMs: 120000,
      droppedForIntegrity: 0,
      reason: null,
    };
    const { rec, out, err } = sink();
    const resolvePrincipal = (ws: string): BundlePrincipal => ({
      workspaceId: ws,
      principalUserId: "user_an",
      projectId: null,
    });
    const code = await runRulesListBackend([], {
      loadConfig: cfg,
      http,
      out,
      err,
      readBundle: () => read,
      resolvePrincipal,
    });
    expect(code).toBe(0);
    expect(rec.out[0]).toBe("(offline) bundle revision 7, age 2m");
    expect(rec.out.join("\n")).toContain("node_9");
  });

  it("exits 1 when offline AND no bundle is cached", async () => {
    const { http } = fakeHttp({
      get: () => {
        throw offlineError();
      },
    });
    const read: BundleCacheRead = {
      status: "unavailable",
      bundle: null,
      ageMs: null,
      droppedForIntegrity: 0,
      reason: "no cache",
    };
    const { rec, out, err } = sink();
    const code = await runRulesListBackend([], {
      loadConfig: cfg,
      http,
      out,
      err,
      readBundle: () => read,
      resolvePrincipal: (ws) => ({ workspaceId: ws, principalUserId: null, projectId: null }),
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("unreachable");
  });

  it("surfaces a real HTTP error (NOT the offline bundle path) on a 500", async () => {
    let bundleRead = false;
    const { http } = fakeHttp({
      get: () => {
        throw httpError(500);
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesListBackend([], {
      loadConfig: cfg,
      http,
      out,
      err,
      readBundle: () => {
        bundleRead = true;
        return { status: "fresh", bundle: null, ageMs: 0, droppedForIntegrity: 0, reason: null };
      },
    });
    expect(code).toBe(1);
    expect(bundleRead).toBe(false);
    expect(rec.err.join("\n")).toContain("failed");
  });

  it("exits 2 when the workspace is unbound (loadConfig throws)", async () => {
    const { rec, out, err } = sink();
    const code = await runRulesListBackend([], {
      loadConfig: () => {
        throw new Error("no workspace marker");
      },
      out,
      err,
    });
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("no workspace marker");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// add
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesAddBackend", () => {
  it("mints a TEAM rule with the triple-safe payload and a content-addressed idempotency key", async () => {
    let captured: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node();
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["include a Mermaid diagram"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(0);
    expect(calls[0].path).toBe("/internal/v1/rules");
    const expectedPayload = managedRuleToRulePayload(
      makeManagedRule({ statement: "include a Mermaid diagram", strength: "SHOULD_FOLLOW", scope: [], sources: [] }),
      "scope_1",
    );
    expect(captured!.authorityScope).toBe("TEAM");
    expect(captured!.ownerUserId).toBeNull();
    expect(captured!.projectId).toBeNull();
    expect(captured!.requestIdempotencyKey).toBe(ruleVersionHash(expectedPayload));
    expect((captured!.payload as RulePayloadV1).text).toBe(expectedPayload.text);
    expect((captured!.payload as RulePayloadV1).strength).toBe("SHOULD_FOLLOW");
    expect(rec.out.join("\n")).toContain("MINTED");
  });

  it("honors --must as a MUST_FOLLOW strength", async () => {
    let captured: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node();
      },
    });
    const { out, err } = sink();
    await runRulesAddBackend(["always test", "--must"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect((captured!.payload as RulePayloadV1).strength).toBe("MUST_FOLLOW");
  });

  it("refuses a binding rule when not an authenticated human, never reaching the wire (acceptance 8)", async () => {
    const { http, calls } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["x"], {
      loadConfig: cfg,
      http,
      resolveOperator: NO_OPERATOR,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(rec.err.join("\n")).toContain("mla login");
  });

  it("exits 2 on a missing statement", async () => {
    const { out, err } = sink();
    const code = await runRulesAddBackend([], { loadConfig: cfg, resolveOperator: HUMAN, out, err });
    expect(code).toBe(2);
  });

  it("fails fast (exit 2) when the workspace is unbound: offline binding writes fail fast", async () => {
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["x"], {
      loadConfig: () => {
        throw new Error("no workspace marker");
      },
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("no workspace marker");
  });

  it("exits 1 when the backend is unreachable, making clear the rule was NOT minted", async () => {
    const { http } = fakeHttp({
      post: () => {
        throw offlineError();
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["x"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("NOT minted");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Backend flag/positional ordering (regression: value-flags must be consumed, never
// leaked into the statement). The legacy runRulesAdd parser walked argv once; the
// backend mirrors it. payload.text is the proof: it carries the statement only, so
// a --source/--scope value that LEAKED would show up here.
// ───────────────────────────────────────────────────────────────────────────

describe("backend rule arg parsing", () => {
  function capturingHttp() {
    let captured: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node();
      },
    });
    return { http, read: () => captured };
  }

  it("add: a --source value BEFORE the statement is consumed, not stolen as the statement", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    // The old two-scan parser returned firstPositional() === "slack-42" here (the source
    // value), silently minting a rule whose statement was the citation. The statement must
    // be the real one.
    const code = await runRulesAddBackend(["--source", "slack-42", "Defer SSO to Q3"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(0);
    expect((read()!.payload as RulePayloadV1).text).toBe("Defer SSO to Q3");
  });

  it("add: a --scope value before the statement is consumed too", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    const code = await runRulesAddBackend(["--scope", "src/**", "guard the public API"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(0);
    expect((read()!.payload as RulePayloadV1).text).toBe("guard the public API");
  });

  it("add: flags AFTER the statement parse to the identical statement (order-independent)", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    const code = await runRulesAddBackend(
      ["guard the public API", "--scope", "src/**", "--source", "slack-42"],
      { loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
    );
    expect(code).toBe(0);
    expect((read()!.payload as RulePayloadV1).text).toBe("guard the public API");
  });

  it("add: an unquoted multi-word statement is joined (legacy parity, not truncated to the first word)", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    // firstPositional() would have minted just "Defer".
    const code = await runRulesAddBackend(["Defer", "SSO", "to", "Q3"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(0);
    expect((read()!.payload as RulePayloadV1).text).toBe("Defer SSO to Q3");
  });

  it("add: a --scope with no following value is a usage error (exit 2), never a silent empty scope", async () => {
    const { out, err, rec } = sink();
    const code = await runRulesAddBackend(["a real statement", "--scope"], {
      loadConfig: cfg,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("--scope needs a value");
  });

  it("edit: a --source between the nodeId and the statement does not steal the statement", async () => {
    let patched: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      patch: (_p, body) => {
        patched = body as Record<string, unknown>;
        return node({ currentVersionId: "ver_2" });
      },
    });
    const { out, err } = sink();
    const code = await runRulesEditBackend(
      ["node_1", "--source", "slack-42", "the new statement"],
      { loadConfig: cfg, http, resolveOperator: HUMAN, out, err },
    );
    expect(code).toBe(0);
    // The GET targets the nodeId (positional[0]), not the source value.
    expect(calls[0].path).toBe("/internal/v1/rules/node_1");
    expect((patched!.payload as RulePayloadV1).text).toBe("the new statement");
  });

  // ── Layer B: --turn-when-prompt / --turn-when-path (targeted-rule-injection §5.3) ──
  // The flags are hidden from usage until the whole read+assemble path ships (§7), but
  // they are functional at P1 so the P4 doctrine migration (ambient -> turn) can run.

  it("add: --turn-when-prompt/--turn-when-path mint a turn applicability, not ambient", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    const code = await runRulesAddBackend(
      ["cite the privacy doc", "--turn-when-prompt", "privacy", "--turn-when-path", "notes/**/*.md"],
      { loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
    );
    expect(code).toBe(0);
    const payload = read()!.payload as RulePayloadV1;
    // The statement is still only the real convention (flags did not leak into it).
    expect(payload.text).toBe("cite the privacy doc");
    expect(payload.applicability).toEqual({
      mode: "turn",
      trigger: { promptAny: ["privacy"], explicitPathAny: ["notes/**/*.md"] },
    });
    // Turn rules are as incapable of asking/denying as ambient ones (delivery-only change).
    expect(payload.deliveryChannels).toEqual(["runtimeInject"]);
    expect(payload.enforcementCeiling).toBe("OBSERVE");
  });

  it("add: repeated --turn-when-prompt accumulate as set members (one phrase each, no comma splitting)", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    const code = await runRulesAddBackend(
      ["draft with citations", "--turn-when-prompt", "design doc", "--turn-when-prompt", "RFC,proposal"],
      { loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
    );
    expect(code).toBe(0);
    const payload = read()!.payload as RulePayloadV1;
    // "RFC,proposal" is ONE phrase: no comma splitting, two repeats = two members.
    expect(payload.applicability).toEqual({
      mode: "turn",
      trigger: { promptAny: ["design doc", "RFC,proposal"] },
    });
  });

  it("add: sends canonicalPayloadHash = ruleVersionHash(payload) so the bundle read-path keeps the turn rule", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    // Unsorted, multi-element promptAny: the read-path re-hash (verifyEntryIntegrity) set-sorts
    // these before hashing, so a backend that RECOMPUTED with a generic preserve-order
    // canonicalizer would produce a different hash, and the rule would be silently dropped at
    // bundle-verify time. Sending the CLI hash for verbatim storage is the only fix that holds.
    const code = await runRulesAddBackend(
      ["cite the roadmap", "--turn-when-prompt", "roadmap", "--turn-when-prompt", "design doc", "--turn-when-prompt", "PRD"],
      { loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
    );
    expect(code).toBe(0);
    const body = read()!;
    const payload = body.payload as RulePayloadV1;
    // The payload carries the phrases in INSERTION order (unsorted): canonicalization matters.
    expect(payload.applicability).toEqual({
      mode: "turn",
      trigger: { promptAny: ["roadmap", "design doc", "PRD"] },
    });
    // The contract: the sent canonicalPayloadHash IS ruleVersionHash(payload) -- byte-for-byte
    // what verifyEntryIntegrity recomputes on read. Before the fix this field was absent (undefined).
    expect(body.canonicalPayloadHash).toBe(ruleVersionHash(payload));
  });

  it("add: with no turn flags the payload stays ambient (unchanged default)", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    const code = await runRulesAddBackend(["a plain rule"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(0);
    expect((read()!.payload as RulePayloadV1).applicability).toEqual({ mode: "ambient" });
  });

  it("add: --turn-when-prompt with no value is a usage error (exit 2), never a silent empty phrase", async () => {
    const { out, err, rec } = sink();
    const code = await runRulesAddBackend(["a real statement", "--turn-when-prompt"], {
      loadConfig: cfg,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("--turn-when-prompt needs a value");
  });

  it("edit: --turn-when-* flips an ambient rule to turn in one supersede (the P4 migration path)", async () => {
    let patched: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      patch: (_p, body) => {
        patched = body as Record<string, unknown>;
        return node({ currentVersionId: "ver_2" });
      },
    });
    const { out, err } = sink();
    const code = await runRulesEditBackend(
      ["node_1", "draft with citations before code", "--turn-when-prompt", "proposal", "--turn-when-prompt", "design doc"],
      { loadConfig: cfg, http, resolveOperator: HUMAN, out, err },
    );
    expect(code).toBe(0);
    const payload = patched!.payload as RulePayloadV1;
    expect(payload.text).toBe("draft with citations before code");
    expect(payload.applicability).toEqual({
      mode: "turn",
      trigger: { promptAny: ["proposal", "design doc"] },
    });
    // The machine checkout fingerprint is still preserved across the flip.
    expect(payload.runtimeScopeId).toBe("scope_existing");
  });

  it("edit: sends canonicalPayloadHash = ruleVersionHash(payload) (same read-path contract as add)", async () => {
    let patched: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      patch: (_p, body) => {
        patched = body as Record<string, unknown>;
        return node({ currentVersionId: "ver_2" });
      },
    });
    const { out, err } = sink();
    const code = await runRulesEditBackend(
      ["node_1", "draft with citations", "--turn-when-prompt", "proposal", "--turn-when-prompt", "design doc"],
      { loadConfig: cfg, http, resolveOperator: HUMAN, out, err },
    );
    expect(code).toBe(0);
    const payload = patched!.payload as RulePayloadV1;
    expect(patched!.canonicalPayloadHash).toBe(ruleVersionHash(payload));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// edit (NEW verb)
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesEditBackend", () => {
  it("mints the next version carrying expectedCurrentVersionId, preserving the prior (acceptance 3)", async () => {
    let patched: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      patch: (_p, body) => {
        patched = body as Record<string, unknown>;
        return node({ currentVersionId: "ver_2" });
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesEditBackend(["node_1", "the new statement"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(calls.map((c) => c.verb)).toEqual(["get", "patch"]);
    expect(calls[1].path).toBe("/internal/v1/rules/node_1");
    expect(patched!.expectedCurrentVersionId).toBe("ver_1");
    expect((patched!.payload as RulePayloadV1).text).toBe("the new statement");
    expect(rec.out.join("\n")).toContain("ver_1 -> ver_2");
  });

  it("preserves the existing runtimeScopeId so an edit never relocates the rule", async () => {
    let patched: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      get: () => node(), // currentVersion.payload.runtimeScopeId === "scope_existing"
      patch: (_p, body) => {
        patched = body as Record<string, unknown>;
        return node({ currentVersionId: "ver_2" });
      },
    });
    const { out, err } = sink();
    await runRulesEditBackend(["node_1", "moved?"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect((patched!.payload as RulePayloadV1).runtimeScopeId).toBe("scope_existing");
  });

  it("surfaces a 409 as a friendly conflict (acceptance 6/7)", async () => {
    const { http } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      patch: () => {
        throw httpError(409);
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesEditBackend(["node_1", "x"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("changed since you read it");
  });

  it("exits 1 with 'no rule' on a 404", async () => {
    const { http } = fakeHttp({
      get: () => {
        throw httpError(404);
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesEditBackend(["nope", "x"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("no rule");
  });

  it("refuses to edit a revoked rule", async () => {
    const { http } = fakeHttp({ get: () => node({ lifecycleStatusId: "REVOKED" }) });
    const { rec, out, err } = sink();
    const code = await runRulesEditBackend(["node_1", "x"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("revoked");
  });

  it("exits 2 on missing args", async () => {
    const { out, err } = sink();
    expect(await runRulesEditBackend(["node_1"], { loadConfig: cfg, resolveOperator: HUMAN, out, err })).toBe(2);
  });

  it("refuses without an authenticated human", async () => {
    const { out, err } = sink();
    const code = await runRulesEditBackend(["node_1", "x"], {
      loadConfig: cfg,
      resolveOperator: NO_OPERATOR,
      out,
      err,
    });
    expect(code).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// revoke (kill switch)
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesRevokeBackend", () => {
  it("compare-and-swaps the node to REVOKED carrying expectedCurrentVersionId", async () => {
    let revokeBody: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      post: (_p, body) => {
        revokeBody = body as Record<string, unknown>;
        return node({ lifecycleStatusId: "REVOKED" });
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesRevokeBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(calls[1].path).toBe("/internal/v1/rules/node_1/revoke");
    expect(revokeBody!.expectedCurrentVersionId).toBe("ver_1");
    expect(rec.out.join("\n")).toContain("REVOKED");
  });

  it("is an idempotent no-op (exit 0, no POST) when already revoked", async () => {
    const { http, calls } = fakeHttp({ get: () => node({ lifecycleStatusId: "REVOKED" }) });
    const { rec, out, err } = sink();
    const code = await runRulesRevokeBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(calls.map((c) => c.verb)).toEqual(["get"]);
    expect(rec.out.join("\n")).toContain("already revoked");
  });

  it("surfaces a 409 as a friendly conflict", async () => {
    const { http } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      post: () => {
        throw httpError(409);
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesRevokeBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("changed since you read it");
  });

  it("refuses to revoke non-interactively without --yes", async () => {
    const { http, calls } = fakeHttp({ get: () => node() });
    const { rec, out, err } = sink();
    const code = await runRulesRevokeBackend(["node_1"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      isInteractive: () => false,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("--yes");
  });

  it("proceeds on an interactive confirm=yes", async () => {
    const { http, calls } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      post: () => node({ lifecycleStatusId: "REVOKED" }),
    });
    const { out, err } = sink();
    const code = await runRulesRevokeBackend(["node_1"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      isInteractive: () => true,
      confirm: () => true,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.verb === "post")).toBe(true);
  });

  it("aborts (exit 1, no POST) on an interactive confirm=no", async () => {
    const { http, calls } = fakeHttp({ get: () => node() });
    const { out, err } = sink();
    const code = await runRulesRevokeBackend(["node_1"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      isInteractive: () => true,
      confirm: () => false,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
  });

  it("exits 2 on a missing nodeId", async () => {
    const { out, err } = sink();
    expect(await runRulesRevokeBackend(["--yes"], { loadConfig: cfg, resolveOperator: HUMAN, out, err })).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// demote (TEAM -> PERSONAL): mint-copy-owned-by-operator, then revoke the team node
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesDemoteBackend", () => {
  // Distinguish the two POSTs (mint at BASE, revoke at BASE/:id/revoke) inside one handler.
  function demoteHttp(over: { onRevoke?: () => unknown; teamNode?: RuleNodeView } = {}) {
    const bodies: { mint?: Record<string, unknown>; revoke?: Record<string, unknown> } = {};
    const { http, calls } = fakeHttp({
      get: () => over.teamNode ?? node({ authorityScopeId: "TEAM", projectId: "proj_9", currentVersionId: "ver_1" }),
      post: (p, body) => {
        if (p.endsWith("/revoke")) {
          bodies.revoke = body as Record<string, unknown>;
          return (over.onRevoke ?? (() => node({ lifecycleStatusId: "REVOKED" })))();
        }
        bodies.mint = body as Record<string, unknown>;
        return node({ id: "node_personal", authorityScopeId: "PERSONAL", ownerUserId: "user_an" });
      },
    });
    return { http, calls, bodies };
  }

  it("mints a PERSONAL copy (owner=operator, projectId + payload preserved) then revokes the team node", async () => {
    const teamNode = node({ authorityScopeId: "TEAM", projectId: "proj_9", currentVersionId: "ver_1" });
    const expectedPayload = teamNode.currentVersion!.payload;
    const { http, calls, bodies } = demoteHttp({ teamNode });
    const { rec, out, err } = sink();

    const code = await runRulesDemoteBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    // Order: read the node, mint the personal copy, THEN revoke the team node.
    expect(calls.map((c) => `${c.verb} ${c.path}`)).toEqual([
      "get /internal/v1/rules/node_1",
      "post /internal/v1/rules",
      "post /internal/v1/rules/node_1/revoke",
    ]);
    expect(bodies.mint!.authorityScope).toBe("PERSONAL");
    expect(bodies.mint!.ownerUserId).toBe("user_an");
    expect(bodies.mint!.projectId).toBe("proj_9");
    expect(bodies.mint!.payload).toEqual(expectedPayload);
    expect(bodies.mint!.requestIdempotencyKey).toBe(ruleVersionHash(expectedPayload as RulePayloadV1));
    // Revoke carries the compare-and-swap token read from the team node.
    expect(bodies.revoke!.expectedCurrentVersionId).toBe("ver_1");
    expect(rec.out.join("\n")).toContain("DEMOTED rule node_1");
    expect(rec.out.join("\n")).toContain("node_personal (PERSONAL, owner user_an)");
  });

  it("rejects a non-TEAM node (exit 1, mints nothing)", async () => {
    const { http, calls } = demoteHttp({
      teamNode: node({ authorityScopeId: "PERSONAL", ownerUserId: "user_an" }),
    });
    const { rec, out, err } = sink();
    const code = await runRulesDemoteBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("not a TEAM rule");
  });

  it("rejects a revoked node (exit 1, mints nothing)", async () => {
    const { http, calls } = demoteHttp({
      teamNode: node({ authorityScopeId: "TEAM", lifecycleStatusId: "REVOKED" }),
    });
    const { rec, out, err } = sink();
    const code = await runRulesDemoteBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("revoked");
  });

  it("reports a half-done demotion when the mint succeeds but the revoke fails", async () => {
    const { http, calls } = demoteHttp({
      onRevoke: () => {
        throw httpError(409);
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesDemoteBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    // The personal copy WAS minted; the operator is told exactly how to finish.
    expect(calls.filter((c) => c.verb === "post" && c.path === "/internal/v1/rules")).toHaveLength(1);
    const errText = rec.err.join("\n");
    expect(errText).toContain("half-done");
    expect(errText).toContain("STILL ACTIVE");
    expect(errText).toContain("mla rules revoke node_1");
  });

  it("leaves the team rule untouched when the mint fails offline (no revoke)", async () => {
    const { http, calls } = fakeHttp({
      get: () => node({ authorityScopeId: "TEAM", currentVersionId: "ver_1" }),
      post: () => {
        throw offlineError();
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesDemoteBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    // Exactly one POST was attempted (the mint); no revoke followed.
    expect(calls.filter((c) => c.verb === "post")).toHaveLength(1);
    expect(rec.err.join("\n")).toContain("the team rule is untouched");
  });

  it("refuses to demote non-interactively without --yes (no mint)", async () => {
    const { http, calls } = demoteHttp();
    const { rec, out, err } = sink();
    const code = await runRulesDemoteBackend(["node_1"], {
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      isInteractive: () => false,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("--yes");
  });

  it("refuses without an authenticated human operator (exit 1)", async () => {
    const { rec, out, err } = sink();
    const code = await runRulesDemoteBackend(["node_1", "--yes"], {
      loadConfig: cfg,
      resolveOperator: NO_OPERATOR,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("authenticated human");
  });

  it("exits 2 on a missing nodeId", async () => {
    const { out, err } = sink();
    expect(await runRulesDemoteBackend(["--yes"], { loadConfig: cfg, resolveOperator: HUMAN, out, err })).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// attest (fork #7): local resolution against a REAL ce0 db; backend mint via the http seam
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesAttestBackend", () => {
  const PILOT_SCOPE = "/work/meetless";
  const OPERATOR_ID = "user_an";
  let dir: string;
  let dbPath: string;
  let store: Ce0Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-backend-attest-"));
    dbPath = path.join(dir, "ce0.db");
    store = openCe0Store(dbPath);
  });
  afterEach(() => {
    closeCe0Store(store);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function pilotObservedSpec(over: Partial<ObservedRuleSpec> = {}): ObservedRuleSpec {
    return {
      text: "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
      applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
      effect: "PROHIBIT",
      forbiddenRootRelativePath: "notes",
      ...over,
    };
  }
  function attempt(over: Partial<ToolAttemptRecord> = {}): ToolAttemptRecord {
    return {
      attemptId: "att_1",
      runtimeScopeId: PILOT_SCOPE,
      sessionId: "sess_1",
      toolName: "Write",
      evaluationInputSnapshot: "{}",
      evaluationInputHash: "a".repeat(64),
      aggregateDecision: "NO_DECISION",
      denyEmissionStatus: "NOT_APPLICABLE",
      inputAuthorityConfigHash: null,
      createdAt: "2026-06-19T00:00:00.000Z",
      ...over,
    };
  }
  function observedEval(over: Partial<RuleEvaluationRecord> = {}): RuleEvaluationRecord {
    return {
      evaluationId: "eval_1",
      attemptId: "att_1",
      runtimeScopeId: PILOT_SCOPE,
      result: "VIOLATION",
      eligibleEnforcement: "OBSERVE",
      effectiveEnforcement: "OBSERVE",
      verdictReasonCode: "FORBIDDEN_PATH_MATCH",
      gateReasonCode: null,
      evaluatorContractVersion: "four-state-evaluator-v1",
      observedRuleSnapshot: serializeObservedRule(pilotObservedSpec()),
      observedRuleHash: observedRuleHash(pilotObservedSpec()),
      ruleVersionId: null,
      canonicalPayloadHash: null,
      createdAt: "2026-06-19T00:00:00.000Z",
      ...over,
    };
  }
  function seedObserved(): string {
    insertToolAttempt(store, attempt());
    const hash = observedRuleHash(pilotObservedSpec());
    insertRuleEvaluationRecord(store, observedEval({ observedRuleHash: hash }));
    return hash;
  }

  function attestDeps(over: Record<string, unknown> = {}) {
    const { rec, out, err } = sink();
    return {
      rec,
      deps: {
        loadConfig: cfg,
        storePath: dbPath,
        resolveRuntimeScopeId: () => PILOT_SCOPE,
        resolveOperator: () => ({ userId: OPERATOR_ID, displayName: "An" }),
        isInteractive: () => false,
        out,
        err,
        ...over,
      },
    };
  }

  it("mints a PERSONAL backend rule (the kill-switch arm) from a local observed snapshot", async () => {
    const hash = seedObserved();
    let body: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      post: (_p, b) => {
        body = b as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID });
      },
    });
    const { rec, deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(["--from-observed", hash, "--agent-on-user-request", "--yes"], deps);
    expect(code).toBe(0);
    expect(calls[0].path).toBe("/internal/v1/rules");
    expect(body!.authorityScope).toBe("PERSONAL");
    expect(body!.ownerUserId).toBe(OPERATOR_ID);
    expect(body!.projectId).toBeNull();
    // requestIdempotencyKey is the canonicalPayloadHash of the admitted notes-location payload.
    const expected = convertNotesLocationSnapshot(serializeObservedRule(pilotObservedSpec()), PILOT_SCOPE);
    expect(expected.admitted).toBe(true);
    if (expected.admitted) {
      expect(body!.requestIdempotencyKey).toBe(ruleVersionHash(expected.payload));
      expect((body!.payload as RulePayloadV1).enforcementCeiling).toBe("DENY");
    }
    expect(rec.out.join("\n")).toContain("PERSONAL");
  });

  it("mints a TEAM rule (ownerUserId null, enforced workspace-wide) under --scope team", async () => {
    const hash = seedObserved();
    let body: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      post: (_p, b) => {
        body = b as Record<string, unknown>;
        return node({ authorityScopeId: "TEAM", ownerUserId: null });
      },
    });
    const { rec, deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--from-observed", hash, "--scope", "team", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls[0].path).toBe("/internal/v1/rules");
    // The plane flips to TEAM and the owner drops to null: the backend re-derives this via
    // resolveOwner, but the wire value must already carry the shared-rule shape. The enforcing
    // payload is UNCHANGED (still DENY) so the one scope-blind enforcer binds it for everyone.
    expect(body!.authorityScope).toBe("TEAM");
    expect(body!.ownerUserId).toBeNull();
    expect(body!.projectId).toBeNull();
    expect((body!.payload as RulePayloadV1).enforcementCeiling).toBe("DENY");
    // The idempotency key is the SAME canonical payload hash regardless of plane.
    const expected = convertNotesLocationSnapshot(serializeObservedRule(pilotObservedSpec()), PILOT_SCOPE);
    expect(expected.admitted).toBe(true);
    if (expected.admitted) {
      expect(body!.requestIdempotencyKey).toBe(ruleVersionHash(expected.payload));
    }
    expect(rec.out.join("\n")).toContain("TEAM");
    expect(rec.out.join("\n")).toContain("every member of the workspace");
  });

  it("mints a PERSONAL rule under an explicit --scope personal (same as the default)", async () => {
    const hash = seedObserved();
    let body: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, b) => {
        body = b as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID });
      },
    });
    const { deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--from-observed", hash, "--scope", "personal", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(0);
    expect(body!.authorityScope).toBe("PERSONAL");
    expect(body!.ownerUserId).toBe(OPERATOR_ID);
  });

  it("rejects an unknown --scope value with a usage error (exit 2), minting nothing", async () => {
    const hash = seedObserved();
    const { http, calls } = fakeHttp({
      post: () => node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID }),
    });
    const { rec, deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--from-observed", hash, "--scope", "workspace", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("'team' or 'personal'");
    // A rejected scope must short-circuit before any backend mint.
    expect(calls).toHaveLength(0);
  });

  it("defers --from-code-rule with a clear pointer (exit 2)", async () => {
    const { rec, deps } = attestDeps();
    const code = await runRulesAttestBackend(["--from-code-rule", "consult-evidence"], deps);
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("Phase 2");
  });

  it("rejects --new-rule (subsumed by the nodeId model) with exit 2", async () => {
    const { rec, deps } = attestDeps();
    const code = await runRulesAttestBackend(["--from-observed", "abc", "--new-rule", "x-v1"], deps);
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("subsumed");
  });

  it("rejects --rule (subsumed) with exit 2", async () => {
    const { rec, deps } = attestDeps();
    const code = await runRulesAttestBackend(["--from-observed", "abc", "--rule", "x-v1"], deps);
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("subsumed");
  });

  it("exits 2 when --from-observed is absent", async () => {
    const { deps } = attestDeps();
    expect(await runRulesAttestBackend([], deps)).toBe(2);
  });

  it("refuses without an authenticated operator (exit 1), never opening the store", async () => {
    const { rec, deps } = attestDeps({ resolveOperator: () => null });
    const code = await runRulesAttestBackend(["--from-observed", "abc", "--agent-on-user-request", "--yes"], deps);
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("mla login");
  });

  it("exits 1 when no observed snapshot matches the hash", async () => {
    const { rec, deps } = attestDeps();
    const code = await runRulesAttestBackend(
      ["--from-observed", "deadbeef", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("not found");
  });

  it("exits 1 when the backend is unreachable, making clear the rule was NOT minted", async () => {
    const hash = seedObserved();
    const { http } = fakeHttp({
      post: () => {
        throw offlineError();
      },
    });
    const { rec, deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(["--from-observed", hash, "--agent-on-user-request", "--yes"], deps);
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("NOT minted");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// remove (unsupported)
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesRemoveBackend", () => {
  it("is unsupported and points the operator at revoke (exit 2)", () => {
    const { rec, err } = sink();
    const code = runRulesRemoveBackend([], { err });
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("mla rules revoke");
  });
});
