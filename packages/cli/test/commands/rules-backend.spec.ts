import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  extractWorkspaceOverride,
  runRulesAddBackend,
  runRulesAttestBackend,
  runRulesDemoteBackend,
  runRulesPromoteBackend,
  runRulesEditBackend,
  runRulesListBackend,
  runRulesRemoveBackend,
  runRulesRevokeBackend,
  type RuleDeliveryFn,
} from "../../src/commands/rules-backend";
import type { DeliveryOutcome } from "../../src/commands/rule-delivery";
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

// After a verb mutates the authority it delivers the change down to the local caches an agent reads
// (src/commands/rule-delivery.ts). Real delivery fetches a bundle over http AND writes into the real
// homedir(), so every mutating call site injects this stub: leaving it out would put a unit test on
// the network and let it scribble in the operator's own ~/.meetless. `calls` is what a test asserts
// on to prove the verb delivered at all; pass an outcome to simulate a refresh that did not land.
type DeliverStub = RuleDeliveryFn & { calls: string[] };
function deliver(outcome: DeliveryOutcome = { delivered: true }): DeliverStub {
  const calls: string[] = [];
  const fn = (async (_cfg: WorkspaceCliConfig, repositoryRoot: string) => {
    calls.push(repositoryRoot);
    return outcome;
  }) as DeliverStub;
  fn.calls = calls;
  return fn;
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

  it("humanizes the scope column: [TEAM] for a team rule, [PERSONAL owner:<id>] for a personal one", async () => {
    const { http } = fakeHttp({
      get: () => [
        node({ id: "node_team", authorityScopeId: "TEAM", ownerUserId: null }),
        node({ id: "node_mine", authorityScopeId: "PERSONAL", ownerUserId: "user_an" }),
      ],
    });
    const { rec, out, err } = sink();
    await runRulesListBackend([], { loadConfig: cfg, http, out, err });
    expect(rec.out[0]).toContain("[TEAM/ACTIVE]");
    expect(rec.out[1]).toContain("[PERSONAL owner:user_an/ACTIVE]");
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
  it("defaults to a PERSONAL rule owned by the operator, with the triple-safe payload and a content-addressed idempotency key", async () => {
    let captured: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node({ id: "node_p", authorityScopeId: "PERSONAL", ownerUserId: "user_an" });
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["include a Mermaid diagram"], {
      refreshDelivery: deliver(),
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
    // An overrode the TEAM recommendation: add defaults PERSONAL (owner = the operator), the
    // lower-blast-radius scope. Only --team opts into workspace-wide enforcement.
    expect(captured!.authorityScope).toBe("PERSONAL");
    expect(captured!.ownerUserId).toBe("user_an");
    expect(captured!.projectId).toBeNull();
    expect(captured!.requestIdempotencyKey).toBe(ruleVersionHash(expectedPayload));
    expect((captured!.payload as RulePayloadV1).text).toBe(expectedPayload.text);
    expect((captured!.payload as RulePayloadV1).strength).toBe("SHOULD_FOLLOW");
    const outText = rec.out.join("\n");
    expect(outText).toContain("MINTED PERSONAL rule node_p");
    // The one mitigation for a PERSONAL default undercutting team propagation: a loud promote nudge.
    expect(outText).toContain("enforces for you alone");
    expect(outText).toContain("mla rules promote node_p");
  });

  it("mints a TEAM rule (owner null) when --team is passed, after confirming", async () => {
    let captured: Record<string, unknown> | undefined;
    let confirmPrompt: string | undefined;
    const { http } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node({ id: "node_t", authorityScopeId: "TEAM", ownerUserId: null });
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["always test", "--team"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      isInteractive: () => true,
      confirm: (p) => {
        confirmPrompt = p;
        return true;
      },
      out,
      err,
    });
    expect(code).toBe(0);
    expect(captured!.authorityScope).toBe("TEAM");
    expect(captured!.ownerUserId).toBeNull();
    expect(confirmPrompt).toContain("TEAM rule");
    const outText = rec.out.join("\n");
    expect(outText).toContain("MINTED TEAM rule node_t");
    expect(outText).toContain("every member of the workspace");
    // No personal promote nudge on a team rule.
    expect(outText).not.toContain("mla rules promote");
  });

  it("mints nothing when the --team confirmation is declined (exit 1)", async () => {
    const { http, calls } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["always test", "--team"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      isInteractive: () => true,
      confirm: () => false,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("not confirmed");
  });

  it("refuses to mint a TEAM rule non-interactively without --yes (no wire call)", async () => {
    const { http, calls } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["always test", "--team"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      isInteractive: () => false,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("--yes");
  });

  it("mints a TEAM rule non-interactively when --yes is passed (no confirm needed)", async () => {
    let captured: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node({ id: "node_t", authorityScopeId: "TEAM", ownerUserId: null });
      },
    });
    const { out, err } = sink();
    const code = await runRulesAddBackend(["always test", "--team", "--yes"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      isInteractive: () => false,
      confirm: () => {
        throw new Error("confirm must not be called when --yes is present");
      },
      out,
      err,
    });
    expect(code).toBe(0);
    expect(captured!.authorityScope).toBe("TEAM");
  });

  it("treats --personal as the explicit spelling of the default (PERSONAL, owner = operator)", async () => {
    let captured: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node({ id: "node_p", authorityScopeId: "PERSONAL", ownerUserId: "user_an" });
      },
    });
    const { out, err } = sink();
    const code = await runRulesAddBackend(["prefer real doc over mocks", "--personal"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(0);
    expect(captured!.authorityScope).toBe("PERSONAL");
    expect(captured!.ownerUserId).toBe("user_an");
  });

  it("rejects --team and --personal together as a usage error (exit 2, no wire call)", async () => {
    const { http, calls } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["x", "--team", "--personal"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(2);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("not both");
  });

  it("accepts --applies-to as the glob flag, equivalent to the deprecated --scope alias", async () => {
    let appliesToBody: Record<string, unknown> | undefined;
    const { http: h1 } = fakeHttp({
      post: (_p, body) => {
        appliesToBody = body as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: "user_an" });
      },
    });
    const s1 = sink();
    await runRulesAddBackend(["guard the public API", "--applies-to", "src/**"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http: h1,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out: s1.out,
      err: s1.err,
    });

    let scopeBody: Record<string, unknown> | undefined;
    const { http: h2 } = fakeHttp({
      post: (_p, body) => {
        scopeBody = body as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: "user_an" });
      },
    });
    const s2 = sink();
    await runRulesAddBackend(["guard the public API", "--scope", "src/**"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http: h2,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out: s2.out,
      err: s2.err,
    });

    // Both flags feed the same applicability glob: statement is clean and the payloads match.
    expect((appliesToBody!.payload as RulePayloadV1).text).toBe("guard the public API");
    expect(appliesToBody!.payload).toEqual(scopeBody!.payload);

    // ...and the glob actually LANDS. Asserting the two payloads merely match each other is what let
    // this ship broken: --applies-to and --scope both dropped the glob, both minted an ambient rule,
    // and two identically-wrong payloads are equal. Pin the applicability itself, against the value
    // the flag promises, never against its twin.
    expect((appliesToBody!.payload as RulePayloadV1).applicability).toEqual({
      mode: "turn",
      trigger: { explicitPathAny: ["src/**"] },
    });
  });

  // The regression in full. `--applies-to` reached makeManagedRule and stopped: it landed in
  // ManagedRule.scope, which feeds only the content-derived `managed.id`, and mintManagedRule never
  // puts that id on the wire. The rule minted AMBIENT and was injected on every turn, which is the
  // precise opposite of "restrict the rule to matching paths" as the help text puts it.
  describe("--applies-to restricts the rule, rather than parsing the glob and dropping it", () => {
    // Mint through the real command and hand back the body that reached the wire.
    async function mint(argv: string[]): Promise<Record<string, unknown>> {
      let body: Record<string, unknown> | undefined;
      const { http } = fakeHttp({
        post: (_p, b) => {
          body = b as Record<string, unknown>;
          return node();
        },
      });
      const { out, err } = sink();
      const code = await runRulesAddBackend(argv, {
      refreshDelivery: deliver(),
        loadConfig: cfg,
        http,
        resolveOperator: HUMAN,
        resolveRuntimeScopeId: () => "scope_1",
        out,
        err,
      });
      expect(code).toBe(0);
      return body!;
    }
    const applicabilityOf = (body: Record<string, unknown>) => (body.payload as RulePayloadV1).applicability;

    it("mints a turn applicability, exactly as the internal --turn-when-path spelling does", async () => {
      const body = await mint(["no raw fetch in the API layer", "--applies-to", "src/api/**"]);
      expect(applicabilityOf(body)).toEqual({ mode: "turn", trigger: { explicitPathAny: ["src/api/**"] } });
      // A restricted rule is still delivery-only: narrowing WHEN it is injected never arms it.
      const payload = body.payload as RulePayloadV1;
      expect(payload.deliveryChannels).toEqual(["runtimeInject"]);
      expect(payload.enforcementCeiling).toBe("OBSERVE");
    });

    it("keeps a rule with no --applies-to ambient, so the floor is untouched", async () => {
      expect(applicabilityOf(await mint(["never commit a secret"]))).toEqual({ mode: "ambient" });
    });

    it("accumulates repeated --applies-to globs into one trigger", async () => {
      const body = await mint(["use the Money type", "--applies-to", "src/api/**", "--applies-to", "src/db/**"]);
      expect(applicabilityOf(body)).toEqual({
        mode: "turn",
        trigger: { explicitPathAny: ["src/api/**", "src/db/**"] },
      });
    });

    it("merges --applies-to with --turn-when-prompt rather than one clobbering the other", async () => {
      const body = await mint(["cite the privacy doc", "--applies-to", "notes/**", "--turn-when-prompt", "privacy"]);
      expect(applicabilityOf(body)).toEqual({
        mode: "turn",
        trigger: { promptAny: ["privacy"], explicitPathAny: ["notes/**"] },
      });
    });

    // The hash covers applicability, so before the fix two rules with the same text and DIFFERENT
    // globs hashed identically: the mint-dedup (alreadyMintedHashes) could not tell them apart, and
    // the second one looked already minted. Two different restrictions are two different rules.
    it("gives two different globs two different payload hashes", async () => {
      const a = await mint(["use the Money type", "--applies-to", "src/api/**"]);
      const b = await mint(["use the Money type", "--applies-to", "src/db/**"]);
      expect(a.canonicalPayloadHash).not.toBe(b.canonicalPayloadHash);
    });

    it("edit: --applies-to restricts a rule that was minted ambient", async () => {
      let patched: Record<string, unknown> | undefined;
      const { http } = fakeHttp({
        get: () => node({ currentVersionId: "ver_1" }),
        patch: (_p, b) => {
          patched = b as Record<string, unknown>;
          return node({ currentVersionId: "ver_2" });
        },
      });
      const { out, err } = sink();
      const code = await runRulesEditBackend(
        ["node_1", "no raw fetch in the API layer", "--applies-to", "src/api/**"],
        {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, out, err },
      );
      expect(code).toBe(0);
      expect((patched!.payload as RulePayloadV1).applicability).toEqual({
        mode: "turn",
        trigger: { explicitPathAny: ["src/api/**"] },
      });
    });
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
    const code = await runRulesAddBackend([], {
      refreshDelivery: deliver(), loadConfig: cfg, resolveOperator: HUMAN, out, err });
    expect(code).toBe(2);
  });

  it("fails fast (exit 2) when the workspace is unbound: offline binding writes fail fast", async () => {
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["x"], {
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
    );
    expect(code).toBe(0);
    expect((read()!.payload as RulePayloadV1).text).toBe("guard the public API");
  });

  it("add: an unquoted multi-word statement is joined (legacy parity, not truncated to the first word)", async () => {
    const { http, read } = capturingHttp();
    const { out, err } = sink();
    // firstPositional() would have minted just "Defer".
    const code = await runRulesAddBackend(["Defer", "SSO", "to", "Q3"], {
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, out, err },
    );
    expect(code).toBe(0);
    // The GET targets the nodeId (positional[0]), not the source value, and carries
    // the workspace marker so the tenant guard scopes the read to cfg's workspace.
    expect(calls[0].path).toBe("/internal/v1/rules/node_1?workspaceId=ws_1");
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
      {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
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
      {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
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
      {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, resolveRuntimeScopeId: () => "scope_1", out, err },
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, out, err },
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
      {
      refreshDelivery: deliver(), loadConfig: cfg, http, resolveOperator: HUMAN, out, err },
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
    expect(await runRulesEditBackend(["node_1"], {
      refreshDelivery: deliver(), loadConfig: cfg, resolveOperator: HUMAN, out, err })).toBe(2);
  });

  it("refuses without an authenticated human", async () => {
    const { out, err } = sink();
    const code = await runRulesEditBackend(["node_1", "x"], {
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
    expect(await runRulesRevokeBackend(["--yes"], {
      refreshDelivery: deliver(), loadConfig: cfg, resolveOperator: HUMAN, out, err })).toBe(2);
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
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    // Order: read the node, mint the personal copy, THEN revoke the team node.
    expect(calls.map((c) => `${c.verb} ${c.path}`)).toEqual([
      "get /internal/v1/rules/node_1?workspaceId=ws_1",
      "post /internal/v1/rules",
      "post /internal/v1/rules/node_1/revoke",
    ]);
    expect(bodies.mint!.authorityScope).toBe("PERSONAL");
    expect(bodies.mint!.ownerUserId).toBe("user_an");
    expect(bodies.mint!.projectId).toBe("proj_9");
    expect(bodies.mint!.payload).toEqual(expectedPayload);
    expect(bodies.mint!.requestIdempotencyKey).toBe(ruleVersionHash(expectedPayload as RulePayloadV1));
    // MOVE provenance: the new PERSONAL node records the TEAM origin it was demoted FROM, so
    // /rules/[id] can reconstruct the cross-node lifecycle (the move-kind is derived from scopes).
    expect(bodies.mint!.movedFromRuleId).toBe("node_1");
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
      refreshDelivery: deliver(),
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
    expect(await runRulesDemoteBackend(["--yes"], {
      refreshDelivery: deliver(), loadConfig: cfg, resolveOperator: HUMAN, out, err })).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// promote (PERSONAL -> TEAM): mint-copy-owned-by-no-one, then revoke the personal node
// ───────────────────────────────────────────────────────────────────────────

describe("runRulesPromoteBackend", () => {
  // Distinguish the two POSTs (mint at BASE, revoke at BASE/:id/revoke) inside one handler.
  function promoteHttp(over: { onRevoke?: () => unknown; personalNode?: RuleNodeView } = {}) {
    const bodies: { mint?: Record<string, unknown>; revoke?: Record<string, unknown> } = {};
    const { http, calls } = fakeHttp({
      get: () =>
        over.personalNode ??
        node({
          authorityScopeId: "PERSONAL",
          ownerUserId: "user_an",
          projectId: "proj_9",
          currentVersionId: "ver_1",
        }),
      post: (p, body) => {
        if (p.endsWith("/revoke")) {
          bodies.revoke = body as Record<string, unknown>;
          return (over.onRevoke ?? (() => node({ lifecycleStatusId: "REVOKED" })))();
        }
        bodies.mint = body as Record<string, unknown>;
        return node({ id: "node_team", authorityScopeId: "TEAM", ownerUserId: null });
      },
    });
    return { http, calls, bodies };
  }

  it("mints a TEAM copy (owner null, projectId + payload preserved) then revokes the personal node", async () => {
    const personalNode = node({
      authorityScopeId: "PERSONAL",
      ownerUserId: "user_an",
      projectId: "proj_9",
      currentVersionId: "ver_1",
    });
    const expectedPayload = personalNode.currentVersion!.payload;
    const { http, calls, bodies } = promoteHttp({ personalNode });
    const { rec, out, err } = sink();

    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    // Order: read the node, mint the team copy, THEN revoke the personal node.
    expect(calls.map((c) => `${c.verb} ${c.path}`)).toEqual([
      "get /internal/v1/rules/node_1?workspaceId=ws_1",
      "post /internal/v1/rules",
      "post /internal/v1/rules/node_1/revoke",
    ]);
    expect(bodies.mint!.authorityScope).toBe("TEAM");
    expect(bodies.mint!.ownerUserId).toBeNull();
    expect(bodies.mint!.projectId).toBe("proj_9");
    expect(bodies.mint!.payload).toEqual(expectedPayload);
    expect(bodies.mint!.requestIdempotencyKey).toBe(ruleVersionHash(expectedPayload as RulePayloadV1));
    // MOVE provenance: the new TEAM node records the PERSONAL origin it was promoted FROM, so
    // /rules/[id] can reconstruct the cross-node lifecycle (the move-kind is derived from scopes).
    expect(bodies.mint!.movedFromRuleId).toBe("node_1");
    // Revoke carries the compare-and-swap token read from the personal node.
    expect(bodies.revoke!.expectedCurrentVersionId).toBe("ver_1");
    expect(rec.out.join("\n")).toContain("PROMOTED rule node_1");
    expect(rec.out.join("\n")).toContain("node_team (TEAM)");
  });

  it("rejects a non-PERSONAL node (exit 1, mints nothing)", async () => {
    const { http, calls } = promoteHttp({
      personalNode: node({ authorityScopeId: "TEAM", ownerUserId: null }),
    });
    const { rec, out, err } = sink();
    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("not a PERSONAL rule");
  });

  it("rejects another member's personal rule (exit 1, mints nothing)", async () => {
    const { http, calls } = promoteHttp({
      personalNode: node({ authorityScopeId: "PERSONAL", ownerUserId: "user_someone_else" }),
    });
    const { rec, out, err } = sink();
    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(calls.some((c) => c.verb === "post")).toBe(false);
    expect(rec.err.join("\n")).toContain("owned by user_someone_else");
  });

  it("rejects a revoked node (exit 1, mints nothing)", async () => {
    const { http, calls } = promoteHttp({
      personalNode: node({ authorityScopeId: "PERSONAL", ownerUserId: "user_an", lifecycleStatusId: "REVOKED" }),
    });
    const { rec, out, err } = sink();
    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: deliver(),
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

  it("reports a half-done promotion when the mint succeeds but the revoke fails", async () => {
    const { http, calls } = promoteHttp({
      onRevoke: () => {
        throw httpError(409);
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    // The team copy WAS minted; the operator is told exactly how to finish.
    expect(calls.filter((c) => c.verb === "post" && c.path === "/internal/v1/rules")).toHaveLength(1);
    const errText = rec.err.join("\n");
    expect(errText).toContain("half-done");
    expect(errText).toContain("STILL ACTIVE");
    expect(errText).toContain("mla rules revoke node_1");
  });

  it("leaves the personal rule untouched when the mint fails offline (no revoke)", async () => {
    const { http, calls } = fakeHttp({
      get: () => node({ authorityScopeId: "PERSONAL", ownerUserId: "user_an", currentVersionId: "ver_1" }),
      post: () => {
        throw offlineError();
      },
    });
    const { rec, out, err } = sink();
    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(1);
    // Exactly one POST was attempted (the mint); no revoke followed.
    expect(calls.filter((c) => c.verb === "post")).toHaveLength(1);
    expect(rec.err.join("\n")).toContain("your personal rule is untouched");
  });

  it("refuses to promote non-interactively without --yes (no mint)", async () => {
    const { http, calls } = promoteHttp();
    const { rec, out, err } = sink();
    const code = await runRulesPromoteBackend(["node_1"], {
      refreshDelivery: deliver(),
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
    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: deliver(),
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
    expect(await runRulesPromoteBackend(["--yes"], {
      refreshDelivery: deliver(), loadConfig: cfg, resolveOperator: HUMAN, out, err })).toBe(2);
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
    const delivery = deliver();
    return {
      rec,
      delivery,
      deps: {
        refreshDelivery: delivery,
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

  // Delivery. attest is the verb that ARMS a rule (an observed snapshot becomes an enforced one),
  // so a mint that never reaches this machine's caches enforces nothing: the operator is told the
  // rule is live while their own agent has never heard of it. The other five mutating verbs assert
  // this in the "rule delivery" block below; attest was the one that did not, even though it has
  // always called the same seam.
  it("delivers the newly armed rule to the local caches", async () => {
    const hash = seedObserved();
    const { http } = fakeHttp({ post: () => node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID }) });
    const { rec, delivery, deps } = attestDeps({ http });

    const code = await runRulesAttestBackend(["--from-observed", hash, "--agent-on-user-request", "--yes"], deps);

    expect(code).toBe(0);
    expect(delivery.calls.length).toBe(1);
    expect(rec.out.join("\n")).toContain("Delivered");
  });

  // Best effort, exactly as elsewhere: the authority write already committed, so the verb still
  // succeeds. What must not happen is a silent claim that it reached the agent.
  it("a failed refresh does not fail the attest, and says the change did NOT reach this machine", async () => {
    const hash = seedObserved();
    const { http } = fakeHttp({ post: () => node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID }) });
    const { rec, deps } = attestDeps({
      http,
      refreshDelivery: deliver({ delivered: false, error: "ECONNREFUSED" }),
    });

    const code = await runRulesAttestBackend(["--from-observed", hash, "--agent-on-user-request", "--yes"], deps);

    expect(code).toBe(0); // the mint committed on the authority; the rule IS live
    expect(rec.out.join("\n")).not.toContain("Delivered:");
    const warning = rec.err.join("\n");
    expect(warning).toContain("NOT delivered");
    expect(warning).toContain("ECONNREFUSED");
    expect(warning).toContain("mla scan");
  });

  // The mirror image: nothing was minted, so there is nothing to deliver. A refresh here would be a
  // lie in the other direction (it would report "Delivered" for a rule that does not exist).
  it("never delivers when the mint was refused", async () => {
    const { delivery, deps } = attestDeps({ resolveOperator: () => null });

    const code = await runRulesAttestBackend(["--from-observed", "abc", "--agent-on-user-request", "--yes"], deps);

    expect(code).toBe(1);
    expect(delivery.calls.length).toBe(0);
  });

  // ── --forbidden-root / --ceiling: the WARN-first direct-authoring arming surface ──
  // A brand-new mechanically-evaluable rule must WARN (non-blocking) before it can earn DENY (INV-8),
  // so the generic path arms at WARN by default and refuses a cold DENY/ASK. Direct authoring needs
  // no prior observation: the spec is synthesized and run through the SAME production admission gate
  // (convertForbiddenRootSnapshot), so no CE0 store is opened.

  it("mints a generic WARN rule from --forbidden-root directly, opening no store", async () => {
    let body: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      post: (_p, b) => {
        body = b as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID });
      },
    });
    // A throwing openStore proves the direct path never touches the CE0 ledger.
    const { rec, deps } = attestDeps({
      http,
      openStore: () => {
        throw new Error("store must not be opened for direct authoring");
      },
    });
    const code = await runRulesAttestBackend(
      ["--forbidden-root", "references", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(0);
    expect(calls[0].path).toBe("/internal/v1/rules");
    const payload = body!.payload as RulePayloadV1;
    expect(payload.enforcementCeiling).toBe("WARN");
    expect(payload.compliance.config.forbiddenRootRelativePath).toBe("references");
    // The wire key is the canonical hash of the admitted payload, round-tripped verbatim.
    expect(body!.requestIdempotencyKey).toBe(ruleVersionHash(payload));
    expect(body!.canonicalPayloadHash).toBe(ruleVersionHash(payload));
    // The label is the generic family (NOT the notes-location pilot id) and the note explains WARN.
    expect(rec.out.join("\n")).toContain("forbidden-root:references");
    expect(rec.out.join("\n")).toContain("WARN");
    expect(rec.out.join("\n")).toContain("INV-8");
  });

  it("arms at OBSERVE under --forbidden-root <path> --ceiling observe (watch-only rung)", async () => {
    let body: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, b) => {
        body = b as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID });
      },
    });
    const { deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--forbidden-root", "references", "--ceiling", "observe", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(0);
    expect((body!.payload as RulePayloadV1).enforcementCeiling).toBe("OBSERVE");
  });

  it("refuses --ceiling deny on a cold arming (INV-8: warn before block), minting nothing", async () => {
    const { http, calls } = fakeHttp({
      post: () => node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID }),
    });
    const { rec, deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--forbidden-root", "references", "--ceiling", "deny", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("INV-8");
    // Refused before any backend mint.
    expect(calls).toHaveLength(0);
  });

  it("refuses --ceiling ask on a cold arming (only observe|warn are armable here)", async () => {
    const { http, calls } = fakeHttp({
      post: () => node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID }),
    });
    const { deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--forbidden-root", "references", "--ceiling", "ask", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("carries --text as the rule rationale into the payload", async () => {
    let body: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, b) => {
        body = b as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID });
      },
    });
    const { deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--forbidden-root", "references", "--text", "keep references pristine", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(0);
    expect((body!.payload as RulePayloadV1).text).toBe("keep references pristine");
  });

  it("mints a generic WARN rule from --from-observed <hash> --ceiling warn (NOT the DENY pilot)", async () => {
    const hash = seedObserved();
    let body: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, b) => {
        body = b as Record<string, unknown>;
        return node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID });
      },
    });
    const { rec, deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--from-observed", hash, "--ceiling", "warn", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(0);
    const payload = body!.payload as RulePayloadV1;
    // Same observed snapshot as the DENY pilot, but --ceiling flips it to the generic WARN family.
    expect(payload.enforcementCeiling).toBe("WARN");
    expect(payload.compliance.config.forbiddenRootRelativePath).toBe("notes");
    // Labelled as the generic family, NOT notes-location-v1 (that id is reserved for the earned DENY pilot).
    expect(rec.out.join("\n")).toContain("forbidden-root:notes");
    expect(rec.out.join("\n")).not.toContain("notes-location-v1");
  });

  it("rejects passing both --from-observed and --forbidden-root (exit 2), minting nothing", async () => {
    const hash = seedObserved();
    const { http, calls } = fakeHttp({
      post: () => node({ authorityScopeId: "PERSONAL", ownerUserId: OPERATOR_ID }),
    });
    const { rec, deps } = attestDeps({ http });
    const code = await runRulesAttestBackend(
      ["--from-observed", hash, "--forbidden-root", "references", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("not both");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown --ceiling token with a usage error (exit 2)", async () => {
    const { rec, deps } = attestDeps();
    const code = await runRulesAttestBackend(
      ["--forbidden-root", "references", "--ceiling", "bogus", "--agent-on-user-request", "--yes"],
      deps,
    );
    expect(code).toBe(2);
    expect(rec.err.join("\n")).toContain("observe|warn|ask|deny");
  });

  it("flags a dangling --forbidden-root (no value) with the usage (exit 2)", async () => {
    const { deps } = attestDeps();
    expect(await runRulesAttestBackend(["--forbidden-root", "--agent-on-user-request", "--yes"], deps)).toBe(2);
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

// ───────────────────────────────────────────────────────────────────────────
// --workspace override (BUG-3 / BUG-4). Pulling `--workspace <id>` out FIRST does two
// jobs: (1) it never leaks into the verb's positional parse (statement / nodeId), and
// (2) it is threaded into loadWorkspaceConfig so the outgoing call carries THAT workspace,
// which the backend tenant guard then authorizes (a non-member id 403s server-side). The
// pure extractor is unit-tested for the leak; the verb tests prove the thread-through.
// ───────────────────────────────────────────────────────────────────────────

describe("extractWorkspaceOverride", () => {
  it("pulls --workspace <id> out and returns the rest without it", () => {
    expect(extractWorkspaceOverride(["--workspace", "ws_team", "node_1", "--yes"])).toEqual({
      workspace: "ws_team",
      rest: ["node_1", "--yes"],
    });
  });

  it("accepts the --workspace-id alias", () => {
    expect(extractWorkspaceOverride(["a", "--workspace-id", "ws_team", "b"])).toEqual({
      workspace: "ws_team",
      rest: ["a", "b"],
    });
  });

  it("passes argv through untouched when no --workspace is present", () => {
    expect(extractWorkspaceOverride(["Defer SSO", "--must"])).toEqual({
      workspace: undefined,
      rest: ["Defer SSO", "--must"],
    });
  });

  it("flags a dangling --workspace at end-of-argv (no value)", () => {
    const r = extractWorkspaceOverride(["node_1", "--workspace"]);
    expect(r.danglingFlag).toBe("--workspace");
    expect(r.workspace).toBeUndefined();
  });

  it("treats a following flag as a missing value (dangling), never eating the next flag", () => {
    const r = extractWorkspaceOverride(["--workspace", "--yes", "node_1"]);
    expect(r.danglingFlag).toBe("--workspace");
    expect(r.workspace).toBeUndefined();
  });

  it("keeps every other positional and flag in rest, in order", () => {
    expect(extractWorkspaceOverride(["stmt", "--scope", "a/**", "--workspace", "ws_x", "--source", "s1"])).toEqual({
      workspace: "ws_x",
      rest: ["stmt", "--scope", "a/**", "--source", "s1"],
    });
  });
});

describe("rules verbs thread --workspace into loadWorkspaceConfig", () => {
  /** A loadConfig seam that records the override it was handed and echoes it into workspaceId. */
  function capturingLoadConfig(): {
    loadConfig: (override?: string) => WorkspaceCliConfig;
    seen: (string | undefined)[];
  } {
    const seen: (string | undefined)[] = [];
    const loadConfig = (override?: string): WorkspaceCliConfig => {
      seen.push(override);
      return { ...cfg(), workspaceId: override ?? WS } as WorkspaceCliConfig;
    };
    return { loadConfig, seen };
  }

  it("list --workspace <id> loads that workspace and queries it on the wire", async () => {
    const { loadConfig, seen } = capturingLoadConfig();
    const { http, calls } = fakeHttp({ get: () => [] });
    const { out, err } = sink();
    const code = await runRulesListBackend(["--workspace", "ws_team"], { loadConfig, http, out, err });
    expect(code).toBe(0);
    expect(seen).toEqual(["ws_team"]);
    expect(calls[0].path).toBe("/internal/v1/rules?workspaceId=ws_team&lifecycleStatus=ACTIVE");
  });

  it("add --workspace <id> files into that workspace, and the id never leaks into the statement", async () => {
    const { loadConfig, seen } = capturingLoadConfig();
    let captured: Record<string, unknown> | undefined;
    const { http } = fakeHttp({
      post: (_p, body) => {
        captured = body as Record<string, unknown>;
        return node();
      },
    });
    const { out, err } = sink();
    const code = await runRulesAddBackend(["--workspace", "ws_team", "Defer SSO"], {
      refreshDelivery: deliver(),
      loadConfig,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["ws_team"]);
    expect(captured!.workspaceId).toBe("ws_team");
    // The statement is exactly "Defer SSO"; had the ws id leaked, the text would carry "ws_team".
    const expected = managedRuleToRulePayload(
      makeManagedRule({ statement: "Defer SSO", strength: "SHOULD_FOLLOW", scope: [], sources: [] }),
      "scope_1",
    );
    expect((captured!.payload as RulePayloadV1).text).toBe(expected.text);
  });

  it("revoke --workspace <id> targets that workspace, and the id is never mistaken for the nodeId", async () => {
    const { loadConfig, seen } = capturingLoadConfig();
    let revokeBody: Record<string, unknown> | undefined;
    const { http, calls } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      post: (_p, body) => {
        revokeBody = body as Record<string, unknown>;
        return node({ lifecycleStatusId: "REVOKED" });
      },
    });
    const { out, err } = sink();
    const code = await runRulesRevokeBackend(["--workspace", "ws_team", "node_1", "--yes"], {
      refreshDelivery: deliver(),
      loadConfig,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["ws_team"]);
    // The nodeId positional resolved to node_1 (not ws_team): the GET hit the node detail route,
    // carrying ?workspaceId=ws_team so the preflight read is scoped to the --workspace target
    // (without it the guard falls back to home and 404s -- the bug this verb path exercises).
    expect(calls[0].path).toBe("/internal/v1/rules/node_1?workspaceId=ws_team");
    expect(revokeBody!.workspaceId).toBe("ws_team");
  });

  it("add exits 2 on a dangling --workspace (no value), never reaching auth or the wire", async () => {
    const { http, calls } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();
    const code = await runRulesAddBackend(["--workspace"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(rec.err.join("\n")).toContain("--workspace needs a value");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// delivery: every verb that mutates the AUTHORITY must also reach the local caches
// ───────────────────────────────────────────────────────────────────────────
//
// The backend RuleNode store is the source of truth, but nothing on the agent hot path fetches it:
// the prompt hook reads the scan cache, which is built from the rule-bundle cache. So a verb that
// mints or revokes on the authority and stops there has changed the governance an agent SEES by
// exactly nothing. That was the 0.2.17 "accept never reached the agent" bug, and it was never a
// property of accept: it was a property of the seam, and every one of these verbs had it. `revoke`
// is the sharpest case: the kill switch disarmed nothing locally, so the killed rule kept being
// injected until something else happened to rescan.
//
// These are the regression tests for the seam. Each asserts the verb DELIVERED after its mutation,
// which is the part that no amount of correct backend behavior can substitute for.
describe("rule delivery", () => {
  it("add delivers the new rule to the local caches", async () => {
    const { http } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();
    const delivery = deliver();

    const code = await runRulesAddBackend(["include a Mermaid diagram"], {
      refreshDelivery: delivery,
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });

    expect(code).toBe(0);
    expect(delivery.calls.length).toBe(1);
    expect(rec.out.join("\n")).toContain("Delivered");
  });

  it("edit delivers the amended rule", async () => {
    const { http } = fakeHttp({
      get: () => node(),
      patch: () => node({ currentVersionId: "ver_2" }),
    });
    const { rec, out, err } = sink();
    const delivery = deliver();

    const code = await runRulesEditBackend(["node_1", "the new statement"], {
      refreshDelivery: delivery,
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    expect(delivery.calls.length).toBe(1);
    expect(rec.out.join("\n")).toContain("Delivered");
  });

  // The kill switch. Revoking on the authority while this machine keeps injecting the dead rule is
  // the worst failure of the set: the operator is told the rule is gone and their agent still obeys it.
  it("revoke delivers the removal (the kill switch must disarm locally too)", async () => {
    const { http } = fakeHttp({
      get: () => node({ currentVersionId: "ver_1" }),
      post: () => node({ lifecycleStatusId: "REVOKED" }),
    });
    const { rec, out, err } = sink();
    const delivery = deliver();

    const code = await runRulesRevokeBackend(["node_1", "--yes"], {
      refreshDelivery: delivery,
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    expect(delivery.calls.length).toBe(1);
    expect(rec.out.join("\n")).toContain("Delivered");
  });

  // A rule revoked from the Console leaves this laptop still injecting it. The local no-op is
  // exactly when a refresh matters most, so "already revoked" delivers rather than returning early.
  it("revoke delivers even when the node was ALREADY revoked elsewhere (local cache is the stale one)", async () => {
    const { http } = fakeHttp({ get: () => node({ lifecycleStatusId: "REVOKED" }) });
    const { rec, out, err } = sink();
    const delivery = deliver();

    const code = await runRulesRevokeBackend(["node_1", "--yes"], {
      refreshDelivery: delivery,
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    expect(rec.out.join("\n")).toContain("no-op");
    expect(delivery.calls.length).toBe(1);
  });

  it("promote delivers the TEAM copy", async () => {
    const { http } = fakeHttp({
      get: () => node({ authorityScopeId: "PERSONAL", ownerUserId: "user_an", currentVersionId: "ver_1" }),
      post: (p) =>
        p.endsWith("/revoke")
          ? node({ lifecycleStatusId: "REVOKED" })
          : node({ id: "node_team", authorityScopeId: "TEAM", ownerUserId: null }),
    });
    const { rec, out, err } = sink();
    const delivery = deliver();

    const code = await runRulesPromoteBackend(["node_1", "--yes"], {
      refreshDelivery: delivery,
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    expect(delivery.calls.length).toBe(1);
    expect(rec.out.join("\n")).toContain("Delivered");
  });

  it("demote delivers the PERSONAL copy", async () => {
    const { http } = fakeHttp({
      get: () => node({ authorityScopeId: "TEAM", currentVersionId: "ver_1" }),
      post: (p) =>
        p.endsWith("/revoke")
          ? node({ lifecycleStatusId: "REVOKED" })
          : node({ id: "node_personal", authorityScopeId: "PERSONAL", ownerUserId: "user_an" }),
    });
    const { rec, out, err } = sink();
    const delivery = deliver();

    const code = await runRulesDemoteBackend(["node_1", "--yes"], {
      refreshDelivery: delivery,
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      out,
      err,
    });

    expect(code).toBe(0);
    expect(delivery.calls.length).toBe(1);
    expect(rec.out.join("\n")).toContain("Delivered");
  });

  // Delivery is BEST EFFORT and must never fail a mutation that already committed on the authority:
  // the rule IS live. But the operator must not be told it reached their agent when it did not, and
  // must be told how to finish the job.
  it("a failed refresh does not fail the verb, and says the change did NOT reach this machine", async () => {
    const { http } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();

    const code = await runRulesAddBackend(["include a Mermaid diagram"], {
      refreshDelivery: deliver({ delivered: false, error: "ECONNREFUSED" }),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });

    expect(code).toBe(0); // the authority write committed; the rule is live
    expect(rec.out.join("\n")).not.toContain("Delivered:");
    const warning = rec.err.join("\n");
    expect(warning).toContain("NOT delivered");
    expect(warning).toContain("ECONNREFUSED");
    expect(warning).toContain("still sees the OLD rules");
    expect(warning).toContain("mla scan");
  });

  // --json is a machine surface: the success line stays out of stdout so it cannot corrupt the
  // payload, but a FAILED delivery still has to reach a human, so it goes to stderr in both modes.
  it("under --json the failure still reaches stderr and stdout stays parseable", async () => {
    const { http } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();

    const code = await runRulesAddBackend(["include a Mermaid diagram", "--json"], {
      refreshDelivery: deliver({ delivered: false, error: "ECONNREFUSED" }),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });

    expect(code).toBe(0);
    expect(() => JSON.parse(rec.out.join("\n"))).not.toThrow();
    expect(rec.err.join("\n")).toContain("NOT delivered");
  });

  it("under --json a successful delivery keeps stdout pure JSON", async () => {
    const { http } = fakeHttp({ post: () => node() });
    const { rec, out, err } = sink();

    const code = await runRulesAddBackend(["include a Mermaid diagram", "--json"], {
      refreshDelivery: deliver(),
      loadConfig: cfg,
      http,
      resolveOperator: HUMAN,
      resolveRuntimeScopeId: () => "scope_1",
      out,
      err,
    });

    expect(code).toBe(0);
    expect(() => JSON.parse(rec.out.join("\n"))).not.toThrow();
    expect(rec.err).toEqual([]);
  });
});
