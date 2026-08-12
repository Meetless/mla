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

// ASK observability.
//
// MLA can interrupt a human two ways: a natively-attested ASK ceiling, and a DENY whose bundle lease
// went stale and degrades to a single confirmation (§6.4). Both PAUSE the user's work. Neither
// emitted anything, so an ASK was invisible to `mla enforcement`, to the console review queue, and
// to every metric: the one intervention class that costs a human their attention was the one class
// with no record at all.
//
// This is the same accountability hole the consent record closed for overrides, one rung down the
// ladder. WARN and DENY have carried incidents for a while; ASK was simply never wired.
//
// What is deliberately NOT claimed here: that the user approved. Claude Code does not hand a hook
// the answer to its own prompt, so the incident records that ASK was ISSUED and stops. Inferring
// approval from "the tool ran afterwards" would be exactly the kind of fabricated evidence this
// codebase refuses everywhere else.

const SCOPE = "/work/meetless";

function payloadAt(ceiling: EligibleEnforcement): RulePayloadV1 {
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

function read(rules: RuleBundleEntry[], status: "fresh" | "stale"): BundleCacheRead {
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
  return status === "fresh"
    ? { status, bundle, ageMs: 1000, droppedForIntegrity: 0, reason: null }
    : { status, bundle, ageMs: 7_200_000, droppedForIntegrity: 0, reason: "bundle lease expired" };
}

const STDIN = JSON.stringify({
  session_id: "s-ask",
  tool_name: "Write",
  tool_input: { file_path: "notes/x.md", content: "hi" },
  cwd: SCOPE,
});

async function observe(opts: {
  ceiling: EligibleEnforcement;
  bundle?: "fresh" | "stale";
  emitOk?: boolean;
  seen?: Record<string, unknown>[];
}) {
  const out: string[] = [];
  await runInternalPretoolObserve([], {
    readStdin: async () => STDIN,
    redeemConsent: () => ({ consumed: false, reason: "no_grant" }),
    consentHome: "/unused",
    resolvePrincipal: () => ({ workspaceId: "ws_1", userId: "user_an", projectId: null }),
    readBundle: () => read([entry("r_ask", payloadAt(opts.ceiling))], opts.bundle ?? "fresh"),
    resolveMaxEnforcement: () => "DENY",
    classifyRuntime: async (raw: unknown): Promise<EvaluationTarget> => ({
      kind: "RUNTIME_RELATIVE",
      path: String(raw),
    }),
    resolveScope: () => ({ runtimeProjectRoot: SCOPE, runtimeScopeId: SCOPE }),
    emitIncident: async (input: unknown) => {
      opts.seen?.push(input as Record<string, unknown>);
      if (opts.emitOk === false) throw new Error("spool unwritable");
    },
    writeOut: (l: string) => out.push(l),
  } as never);
  return out.join("\n");
}

describe("ASK observability: an interruption that records nothing", () => {
  it("a natively-attested ASK still renders the host prompt", async () => {
    const body = await observe({ ceiling: "ASK" });
    expect(body).toContain('"permissionDecision":"ask"');
  });

  it("EMITS an incident for a natively-attested ASK", async () => {
    // The defect. Before this, ASK emitted nothing: the one intervention class that spends a human's
    // attention was the only class with no record.
    const seen: Record<string, unknown>[] = [];
    await observe({ ceiling: "ASK", seen });
    expect(seen).toHaveLength(1);
    expect(seen[0].decision).toBe("ask");
  });

  it("EMITS an incident for a stale-degraded DENY, which is also an interruption", async () => {
    // §6.4: a DENY whose lease expired degrades to one confirmation rather than blocking on a
    // possibly-revoked rule. It pauses the user just the same, so it records just the same.
    const seen: Record<string, unknown>[] = [];
    const body = await observe({ ceiling: "DENY", bundle: "stale", seen });
    expect(body).toContain('"permissionDecision":"ask"');
    expect(seen).toHaveLength(1);
    expect(seen[0].decision).toBe("ask");
  });

  it("carries the SAME birth facts WARN and DENY carry", async () => {
    const seen: Record<string, unknown>[] = [];
    await observe({ ceiling: "ASK", seen });
    const inc = seen[0];
    expect(inc.ruleNodeId).toBe("r_ask");
    expect(inc.ruleVersionId).toBe("r_ask_v1");
    expect(inc.enforcementCeiling).toBe("ASK");
    expect(inc.blockedPath).toBe("notes/x.md");
    expect(inc.ruleText).toContain("standalone vault");
    expect(inc.tool).toBe("Write");
  });

  it("records the ATTESTED ceiling on a degraded ask, not the effective one", async () => {
    // A stale DENY asks. The rule is still attested at DENY, and collapsing that into "ask" would
    // erase why the user was interrupted, exactly as it would for a capped warn.
    const seen: Record<string, unknown>[] = [];
    await observe({ ceiling: "DENY", bundle: "stale", seen });
    expect(seen[0].decision).toBe("ask");
    expect(seen[0].enforcementCeiling).toBe("DENY");
  });

  it("NEVER claims the user approved: no outcome is inferred from the prompt being issued", async () => {
    // Claude Code does not hand a hook the answer to its own prompt. The honest record is that ASK
    // was issued. A field asserting approval, or a later inference from "the tool ran", would be
    // fabricated evidence.
    const seen: Record<string, unknown>[] = [];
    await observe({ ceiling: "ASK", seen });
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).not.toMatch(/approved|granted|accepted/i);
    expect(seen[0].consentState).toBeUndefined();
  });

  it("is FAIL-SOFT: a telemetry fault must not change what the user is asked", async () => {
    // Unlike a hard DENY, an ASK is answered by a human, so the accountability lives in their answer
    // rather than in our row. Withholding the prompt on a spool fault would silently let a governed
    // action through unasked, which is the wrong direction.
    const body = await observe({ ceiling: "ASK", emitOk: false });
    expect(body).toContain('"permissionDecision":"ask"');
  });
});
