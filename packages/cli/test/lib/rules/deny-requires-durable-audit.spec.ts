import { runInternalPretoolObserve } from "../../../src/commands/internal-pretool-observe";
import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
} from "../../../src/lib/rules/durable-observation";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import type { EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import type { RuleBundle, RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";
import type { BundleCacheRead } from "../../../src/lib/rules/bundle-cache";
import type { RulePayloadV1 } from "../../../src/lib/rules/types";
import type { EligibleEnforcement } from "../../../src/lib/rules/deny-admission";

// INV-8 Phase A: "the active enforcement path cannot claim a complete durable audit record before
// blocking" is a doctrine violation only if a block can outrun its own audit row. It can today: the
// deny branch awaits the local append, but the emitter is fail-soft and swallows every fault, so a
// spool that cannot be written still yields permissionDecision: deny. The block happens and nothing
// durable records that it happened.
//
// INV-8 requires "a complete audit record" as a PRECONDITION of blocking, so the correct behavior is
// to degrade to the existing safe non-blocking advisory rather than to block unaudited. That is
// strictly safer in both directions: the user's work is never stopped by our telemetry fault, and we
// never assert authority we cannot evidence.
//
// WARN keeps the opposite contract and that asymmetry is deliberate. A warn is already non-blocking,
// so a telemetry fault there costs a measurement, not accountability; failing it closed would turn a
// spool problem into a silenced advisory.

const SCOPE = "/work/meetless";

function denyPayload(ceiling: EligibleEnforcement = "DENY"): RulePayloadV1 {
  return {
    text: "Notes go in the standalone vault.",
    applicability: {
      mode: "action",
      tools: ["Edit", "Write"],
      matcher: { field: "file_path", glob: "*.md" },
    },
    compliance: {
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
      config: { forbiddenRootRelativePath: "notes" },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: ceiling,
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
  };
}

function entry(nodeId: string, payload: RulePayloadV1): RuleBundleEntry {
  return {
    ruleNodeId: nodeId,
    ruleVersionId: `${nodeId}_v1`,
    authorityScope: "WORKSPACE",
    ownerUserId: null,
    projectId: null,
    payload,
    canonicalPayloadHash: ruleVersionHash(payload),
    attestedByUserId: "user_an",
    attestedAt: "2026-07-21T16:04:01.673Z",
    supersedesVersionId: null,
  };
}

function fresh(rules: RuleBundleEntry[]): BundleCacheRead {
  const bundle: RuleBundle = {
    schemaVersion: 1,
    principalUserId: "user_an",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 7,
    generatedAt: "2026-06-27T00:00:00.000Z",
    validUntil: "2026-06-27T01:00:00.000Z",
    rules,
  };
  return { status: "fresh", bundle, ageMs: 1000, droppedForIntegrity: 0, reason: null };
}

const STDIN = JSON.stringify({
  session_id: "s-audit",
  tool_name: "Write",
  tool_input: { file_path: "notes/x.md", content: "hi" },
  cwd: SCOPE,
});

/** Drive the real observe core with the audit emit seam pinned to succeed or fail. */
async function observe(opts: {
  ceiling?: EligibleEnforcement;
  cap?: EligibleEnforcement;
  auditOk: boolean;
  seen?: unknown[];
  redeem?: unknown;
}) {
  const out: string[] = [];
  await runInternalPretoolObserve([], {
    readStdin: async () => STDIN,
    redeemConsent: opts.redeem ?? (() => ({ consumed: false, reason: "no_grant" })),
    consentHome: "/unused",
    resolvePrincipal: () => ({ workspaceId: "ws_1", userId: "user_an", projectId: null }),
    readBundle: () => fresh([entry("r_1", denyPayload(opts.ceiling ?? "DENY"))]),
    resolveMaxEnforcement: () => opts.cap ?? "DENY",
    classifyRuntime: async (raw: unknown): Promise<EvaluationTarget> => ({
      kind: "RUNTIME_RELATIVE",
      path: String(raw),
    }),
    resolveScope: () => ({ runtimeProjectRoot: SCOPE, runtimeScopeId: SCOPE }),
    emitIncident: async (input: unknown) => {
      opts.seen?.push(input);
      if (!opts.auditOk) throw new Error("spool unwritable");
    },
    writeOut: (l: string) => out.push(l),
  } as never);
  return out.join("\n");
}

describe("INV-8: a hard DENY requires its durable audit row", () => {
  it("blocks when the audit append succeeds", async () => {
    const body = await observe({ auditOk: true });
    expect(body).toContain('"permissionDecision":"deny"');
  });

  it("DOES NOT block when the audit append fails: it degrades to the non-blocking advisory", async () => {
    // The doctrine requirement. Blocking here would assert an authority we cannot evidence.
    const body = await observe({ auditOk: false });
    expect(body).not.toContain('"permissionDecision":"deny"');
    // The user still sees the concern; only the enforcement is withheld.
    expect(body).toContain("Meetless");
  });

  it("still attempts the audit before deciding, so the degrade is a fallback and not a skip", async () => {
    const seen: unknown[] = [];
    await observe({ auditOk: false, seen });
    expect(seen).toHaveLength(1);
  });

  it("the deny incident carries the ATTESTED ceiling explicitly, not a hardcoded fallback", async () => {
    const seen: Record<string, unknown>[] = [];
    await observe({ auditOk: true, seen: seen as unknown[] });
    expect(seen[0].enforcementCeiling).toBe("DENY");
  });

  it("WARN stays fail-soft: a telemetry fault must never silence a non-blocking advisory", async () => {
    // The asymmetry, pinned. A warn is already non-blocking, so there is no unaudited authority to
    // withhold; failing it closed would only cost the user the advisory.
    const body = await observe({ ceiling: "WARN", auditOk: false });
    expect(body).not.toContain('"permissionDecision":"deny"');
    expect(body).toContain("Meetless");
  });

  it("a DENY-attested rule under the WARN session cap stays a warn and is unaffected by audit failure", async () => {
    const body = await observe({ ceiling: "DENY", cap: "WARN", auditOk: false });
    expect(body).not.toContain('"permissionDecision":"deny"');
  });
});

describe("INV-8: a redeemed consent grant permits the exact action, once", () => {
  it("withholds the block when a grant is redeemed, and still surfaces the concern", async () => {
    const body = await observe({
      auditOk: true,
      redeem: () => ({
        consumed: true,
        grant: {
          incidentId: "inc_x",
          ruleVersionId: "r_1_v1",
          actionKey: "k",
          sessionId: "s-audit",
          grantedAtMs: 0,
        },
      }),
    });
    expect(body).not.toContain('"permissionDecision":"deny"');
    // Never a silent pass: the operator still sees which rule they overrode.
    expect(body).toContain("Meetless");
  });

  it("records the override on the SAME audit path, as consentState overridden", async () => {
    const seen: Record<string, unknown>[] = [];
    await observe({
      auditOk: true,
      seen: seen as unknown[],
      redeem: () => ({
        consumed: true,
        grant: {
          incidentId: "inc_x",
          ruleVersionId: "r_1_v1",
          actionKey: "k",
          sessionId: "s-audit",
          grantedAtMs: 0,
        },
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].consentState).toBe("overridden");
    // The override cites the incident it answers, so consent and block share one business key.
    expect(seen[0].incidentId).toBe("inc_x");
  });

  it("a REFUSED grant leaves the block standing", async () => {
    const body = await observe({
      auditOk: true,
      redeem: () => ({ consumed: false, reason: "action_mismatch" }),
    });
    expect(body).toContain('"permissionDecision":"deny"');
  });
});

describe("INV-8: the block TELLS the operator how to override it", () => {
  it("prints the exact, copyable scoped-override command naming this incident", async () => {
    // A technically-available command nobody is told about is not an immediate override mechanism.
    // The blocked operator must be able to copy one line out of the block they are looking at.
    const seen: Record<string, unknown>[] = [];
    const body = await observe({ auditOk: true, seen: seen as unknown[] });
    const parsed = JSON.parse(body);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason as string;
    const incidentId = seen[0].incidentId as string;

    expect(incidentId).toBeTruthy();
    // The id in the message is the id of the incident this block just recorded, so the command
    // resolves against a real row rather than sending the operator to go find one.
    expect(reason).toContain(`mla enforcement allow ${incidentId}`);
  });

  it("says the override authorizes ONE retry, so nobody reads it as disabling the rule", async () => {
    const body = await observe({ auditOk: true });
    const reason = JSON.parse(body).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason.toLowerCase()).toMatch(/once|one retry|single/);
  });

  it("still carries the adjudication CTA: overriding and judging are different acts", async () => {
    const body = await observe({ auditOk: true });
    const reason = JSON.parse(body).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("mla enforcement");
    expect(reason).toMatch(/confirm|dismiss/);
  });

  it("does NOT advertise the override on a degraded (unaudited) block, which is not a block at all", async () => {
    // The degrade path permits the action already, so pointing at an override there would be
    // incoherent and would invite a pointless grant.
    const body = await observe({ auditOk: false });
    expect(body).not.toContain("mla enforcement allow");
  });
});
