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
import type { ToolCall } from "../../../src/lib/rules/evaluator";
import {
  decideBundleEnforcement,
  RULE_PROTECTION_UNAVAILABLE,
} from "../../../src/lib/rules/bundle-enforce";

// P1G / G4 (notes/20260627-rules-store-unification-backend-sot-proposal.md §6.3, §6.4, §7): the
// PreToolUse enforcement decision, faced over the principal-bound rule bundle instead of the
// local CE0 store. Pure: every fixture is a real RuleBundle entry (real ruleVersionHash digest) wrapped
// in a real BundleCacheRead, and the path classifier is supplied through the documented injection seam,
// so no mock store, no filesystem, and no network. The verdict math is the SAME versionBackedVerdict +
// projectEligibleEnforcement the legacy version-arm used, so these tests pin the cutover behavior, not
// a re-implementation of the evaluator.

const PILOT_SCOPE = "/work/meetless";
const FORBIDDEN_ROOT = "notes";

// The §3.6 RulePayloadV1 the §2.4 conversion mints for the notes-location pilot: a PROHIBIT forbidden-root
// action rule, the supported compliance triple, the *.md matcher, a DENY ceiling, delivered to preToolUse.
function pilotPayload(over: Partial<RulePayloadV1> = {}): RulePayloadV1 {
  return {
    text: "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
    applicability: { mode: "action", tools: ["Edit", "Write"], matcher: { field: "file_path", glob: "*.md" } },
    compliance: {
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
      config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: "DENY",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: PILOT_SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
    ...over,
  };
}

// A real bundle entry: the carried canonicalPayloadHash is the actual v1 digest of the payload, exactly
// what the bundle endpoint stamps, so these fixtures are byte-honest (the reader already verified them).
function entry(nodeId: string, payload: RulePayloadV1, over: Partial<RuleBundleEntry> = {}): RuleBundleEntry {
  return {
    ruleNodeId: nodeId,
    ruleVersionId: `${nodeId}_v1`,
    authorityScope: "WORKSPACE",
    ownerUserId: null,
    projectId: null,
    payload,
    canonicalPayloadHash: ruleVersionHash(payload),
    attestedByUserId: "user_an",
    attestedAt: "2026-06-27T00:00:00.000Z",
    supersedesVersionId: null,
    ...over,
  };
}

function bundle(rules: RuleBundleEntry[], over: Partial<RuleBundle> = {}): RuleBundle {
  return {
    schemaVersion: 1,
    principalUserId: "user_an",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 7,
    generatedAt: "2026-06-27T00:00:00.000Z",
    validUntil: "2026-06-27T01:00:00.000Z",
    rules,
    ...over,
  };
}

function fresh(rules: RuleBundleEntry[]): BundleCacheRead {
  return { status: "fresh", bundle: bundle(rules), ageMs: 1000, droppedForIntegrity: 0, reason: null };
}

function stale(rules: RuleBundleEntry[]): BundleCacheRead {
  return { status: "stale", bundle: bundle(rules), ageMs: 7_200_000, droppedForIntegrity: 0, reason: "bundle lease expired" };
}

function writeMd(filePath: string): ToolCall {
  return { toolName: "Write", toolInput: { file_path: filePath, content: "hi" } };
}

// The injected runtime classifier: echoes the raw path back as a runtime-relative one, exactly like the
// version-evaluation seam test. The forbidden-root verdict is derived purely from the returned target.
const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function decide(read: BundleCacheRead, call: ToolCall) {
  return decideBundleEnforcement({ call, read, runtimeProjectRoot: "/runtime/root", classifyRuntime });
}

describe("decideBundleEnforcement: no usable bundle (§6.3, acceptance 15)", () => {
  it("is UNAVAILABLE with the carried reason when the read is unavailable", async () => {
    const read: BundleCacheRead = { status: "unavailable", bundle: null, ageMs: null, droppedForIntegrity: 0, reason: "no cached rule bundle" };
    expect(await decide(read, writeMd("notes/x.md"))).toEqual({ kind: "UNAVAILABLE", reason: "no cached rule bundle" });
  });

  it("falls back to 'rule protection unavailable' when no reason is carried", async () => {
    const read: BundleCacheRead = { status: "unavailable", bundle: null, ageMs: null, droppedForIntegrity: 0, reason: null };
    expect(await decide(read, writeMd("notes/x.md"))).toEqual({ kind: "UNAVAILABLE", reason: RULE_PROTECTION_UNAVAILABLE });
  });

  it("is UNAVAILABLE defensively when status is not unavailable but the bundle is null", async () => {
    const read = { status: "fresh", bundle: null, ageMs: 0, droppedForIntegrity: 0, reason: null } as BundleCacheRead;
    expect((await decide(read, writeMd("notes/x.md"))).kind).toBe("UNAVAILABLE");
  });
});

describe("decideBundleEnforcement: fresh bundle DENY (the hard block)", () => {
  it("DENIES a forbidden-root write against a fresh DENY rule, carrying the node + version identity + the runtime-relative blocked path", async () => {
    const res = await decide(fresh([entry("node_a", pilotPayload())]), writeMd("notes/x.md"));
    expect(res.kind).toBe("DENY");
    if (res.kind === "DENY") {
      expect(res.ruleNodeId).toBe("node_a");
      expect(res.ruleVersionId).toBe("node_a_v1");
      expect(res.reason).toContain("node_a");
      expect(res.reason).toContain("notes/x.md");
      expect(res.reason).toContain(pilotPayload().text);
      // The blocked path travels on the decision so the deny incident records WHAT was blocked (the
      // evidence the review queue needs). It is the runtime-relative form, never absolute (micro-decision A).
      expect(res.targetPath).toBe("notes/x.md");
      // The deciding rule's OWN statement travels too, snapshotted at block time so the review queue
      // shows the rule text verbatim without joining a version id that can rot across a store cutover.
      expect(res.ruleText).toBe(pilotPayload().text);
    }
  });

  it("PASSES a write outside the forbidden root (COMPLIANT verdict)", async () => {
    expect((await decide(fresh([entry("node_a", pilotPayload())]), writeMd("src/app/main.md"))).kind).toBe("PASS");
  });

  it("PASSES a non-Write/Edit tool (selector NOT_APPLICABLE)", async () => {
    const call: ToolCall = { toolName: "Bash", toolInput: { command: "ls" } };
    expect((await decide(fresh([entry("node_a", pilotPayload())]), call)).kind).toBe("PASS");
  });

  it("PASSES a non-Markdown target (glob non-match)", async () => {
    expect((await decide(fresh([entry("node_a", pilotPayload())]), writeMd("notes/x.txt"))).kind).toBe("PASS");
  });

  it("does NOT DENY an out-of-runtime-scope target, so an absolute path can never reach path capture (INV-POSTHOG-PII-1, micro-decision A)", async () => {
    // An absolute / out-of-project path canonicalizes to OUTSIDE_RUNTIME_SCOPE, which the forbidden-root
    // verdict scores COMPLIANT. A DENY (the only decision carrying targetPath) can therefore fire ONLY on a
    // RUNTIME_RELATIVE target: an absolute path is structurally unable to reach the capture site, so the
    // "blocked path is never absolute" guarantee holds by construction, not by a runtime scrub.
    const outsideScope = async (): Promise<EvaluationTarget> => ({ kind: "OUTSIDE_RUNTIME_SCOPE" });
    const res = await decideBundleEnforcement({
      call: writeMd("/Users/an/private/notes/x.md"),
      read: fresh([entry("node_a", pilotPayload())]),
      runtimeProjectRoot: "/runtime/root",
      classifyRuntime: outsideScope,
    });
    expect(res.kind).toBe("PASS");
  });
});

describe("decideBundleEnforcement: stale bundle degrades DENY to ASK (§6.4, acceptance 17)", () => {
  it("degrades a would-be DENY to ASK with degraded:true when the bundle is past its lease", async () => {
    const res = await decide(stale([entry("node_a", pilotPayload())]), writeMd("notes/x.md"));
    expect(res.kind).toBe("ASK");
    if (res.kind === "ASK") {
      expect(res.degraded).toBe(true);
      expect(res.ruleNodeId).toBe("node_a");
      expect(res.ruleVersionId).toBe("node_a_v1");
      expect(res.reason).toContain("confirmation");
    }
  });

  it("PASSES a compliant write even on a stale bundle (no rule selected)", async () => {
    expect((await decide(stale([entry("node_a", pilotPayload())]), writeMd("src/app/main.md"))).kind).toBe("PASS");
  });
});

describe("decideBundleEnforcement: native ASK ceiling", () => {
  it("ASKS (degraded:false) for a fresh rule whose attested ceiling is ASK, not DENY", async () => {
    const res = await decide(fresh([entry("node_a", pilotPayload({ enforcementCeiling: "ASK" }))]), writeMd("notes/x.md"));
    expect(res.kind).toBe("ASK");
    if (res.kind === "ASK") expect(res.degraded).toBe(false);
  });

  it("OBSERVE ceiling never blocks or asks (PASS)", async () => {
    expect(
      (await decide(fresh([entry("node_a", pilotPayload({ enforcementCeiling: "OBSERVE" }))]), writeMd("notes/x.md"))).kind,
    ).toBe("PASS");
  });
});

describe("decideBundleEnforcement: only enforceable shapes are faced", () => {
  it("PASSES a rule not delivered to the preToolUse channel", async () => {
    const offSurface = pilotPayload({ deliveryChannels: ["nativeRule", "runtimeInject"] });
    expect((await decide(fresh([entry("node_a", offSurface)]), writeMd("notes/x.md"))).kind).toBe("PASS");
  });

  it("PASSES a non-PROHIBIT effect", async () => {
    const req = pilotPayload({ effect: "REQUIRE" });
    expect((await decide(fresh([entry("node_a", req)]), writeMd("notes/x.md"))).kind).toBe("PASS");
  });

  it("§5.4 invariant 1: a turn rule never reaches the Plane-B gate (turn is runtimeInject, never preToolUse)", async () => {
    // A turn rule is an injection-plane artifact: it carries the runtimeInject channel and a turn
    // applicability. Even crafted to otherwise look enforceable (PROHIBIT, DENY ceiling, the notes
    // forbidden root) it must PASS the action-time gate, because the gate faces only action-mode
    // preToolUse rules. This is the mirror of injection invariants 2-4 (in bundle-directives.spec):
    // turn never crosses into Plane B, action never crosses into injection.
    const turnRule = pilotPayload({
      applicability: { mode: "turn", trigger: { promptAny: ["design doc"] } } as unknown as RulePayloadV1["applicability"],
      deliveryChannels: ["runtimeInject"],
    });
    expect((await decide(fresh([entry("node_a", turnRule)]), writeMd("notes/x.md"))).kind).toBe("PASS");
  });

  it("PASSES (honest semantics) a foreign-contract version: UNKNOWN verdict is never enforced", async () => {
    const foreign = pilotPayload({
      compliance: {
        evaluatorContractVersion: "four-state-evaluator-v2",
        matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
        pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
        config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
      },
    });
    expect((await decide(fresh([entry("node_a", foreign)]), writeMd("notes/x.md"))).kind).toBe("PASS");
  });
});

describe("decideBundleEnforcement: deterministic collapse across entries", () => {
  it("DENIES on the lowest ruleNodeId when two fresh DENY rules both match", async () => {
    const read = fresh([entry("node_z", pilotPayload()), entry("node_a", pilotPayload())]);
    const res = await decide(read, writeMd("notes/x.md"));
    expect(res.kind).toBe("DENY");
    if (res.kind === "DENY") expect(res.ruleNodeId).toBe("node_a");
  });

  it("a fresh DENY wins over a lower-id ASK match (DENY is the hard ceiling)", async () => {
    const read = fresh([
      entry("node_a", pilotPayload({ enforcementCeiling: "ASK" })),
      entry("node_b", pilotPayload({ enforcementCeiling: "DENY" })),
    ]);
    const res = await decide(read, writeMd("notes/x.md"));
    expect(res.kind).toBe("DENY");
    if (res.kind === "DENY") expect(res.ruleNodeId).toBe("node_b");
  });

  it("on a stale bundle the lowest-id match becomes the single degraded ASK", async () => {
    const read = stale([
      entry("node_b", pilotPayload()),
      entry("node_a", pilotPayload({ enforcementCeiling: "ASK" })),
    ]);
    const res = await decide(read, writeMd("notes/x.md"));
    expect(res.kind).toBe("ASK");
    if (res.kind === "ASK") expect(res.ruleNodeId).toBe("node_a");
  });

  it("skips a malformed entry without throwing and still enforces a valid sibling", async () => {
    const broken = entry("node_a", pilotPayload(), { payload: { not: "a rule" } as unknown as RulePayloadV1 });
    const read = fresh([broken, entry("node_b", pilotPayload())]);
    const res = await decide(read, writeMd("notes/x.md"));
    expect(res.kind).toBe("DENY");
    if (res.kind === "DENY") expect(res.ruleNodeId).toBe("node_b");
  });

  it("PASSES an empty bundle (a usable bundle with no rules)", async () => {
    expect((await decide(fresh([]), writeMd("notes/x.md"))).kind).toBe("PASS");
  });
});
