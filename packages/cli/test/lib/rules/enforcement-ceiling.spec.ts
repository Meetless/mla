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
import { decideBundleEnforcement } from "../../../src/lib/rules/bundle-enforce";
import type { EligibleEnforcement } from "../../../src/lib/rules/deny-admission";
import { ENFORCEMENT_CEILINGS } from "../../../src/lib/analytics/envelope";

// D.4 (notes/20260804-value-program-closeout-and-browser-delivery.md §4.3): every incident-producing
// branch must snapshot the ceiling the rule was ATTESTED at.
//
// The point of this file is the OMISSION guard, not a presence assertion. A test that hands a ceiling
// in and reads the same ceiling out proves only that an object literal copies fields; it passes just
// as happily against a producer that never sets one. So these specs drive the REAL
// decideBundleEnforcement over real bundle fixtures and assert, for every arm that yields an incident,
// that the value it carries is a recognised member of the closed wire enum. A producer that omits the
// field, or forwards `undefined` through a cast, or invents a fifth rung, fails here.
//
// The load-bearing case is `deny attested, warn effective`: the session cap
// (MEETLESS_ACTION_INTERCEPT_MAX, DEFAULT_MAX_ENFORCEMENT = "WARN" since 30b7aa259) clamps a
// DENY-attested rule to a non-blocking advisory. The incident must then report
// {decision: warn, enforcement_ceiling: DENY}. Collapsing those two into one field would erase the
// only signal that separates "this rule is advisory" from "this rule would have blocked but the cap
// stopped it", which is exactly the question the overturned-denial rate has to answer before anything
// is promoted to DENY.

const SCOPE = "/work/meetless";
const FORBIDDEN_ROOT = "notes";

function payloadAt(ceiling: EligibleEnforcement): RulePayloadV1 {
  return {
    text: "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
    applicability: {
      mode: "action",
      tools: ["Edit", "Write"],
      matcher: { field: "file_path", glob: "*.md" },
    },
    compliance: {
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
      config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
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
    attestedAt: "2026-06-27T00:00:00.000Z",
    supersedesVersionId: null,
  };
}

function fresh(rules: RuleBundleEntry[]): BundleCacheRead {
  const b: RuleBundle = {
    schemaVersion: 1,
    principalUserId: "user_an",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 7,
    generatedAt: "2026-06-27T00:00:00.000Z",
    validUntil: "2026-06-27T01:00:00.000Z",
    rules,
  };
  return { status: "fresh", bundle: b, ageMs: 1000, droppedForIntegrity: 0, reason: null };
}

const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function writeMd(filePath: string): ToolCall {
  return { toolName: "Write", toolInput: { file_path: filePath, content: "hi" } };
}

function decide(read: BundleCacheRead, call: ToolCall, maxEnforcement?: EligibleEnforcement) {
  return decideBundleEnforcement({
    call,
    read,
    runtimeProjectRoot: "/runtime/root",
    runtimeScopeId: SCOPE,
    classifyRuntime,
    ...(maxEnforcement ? { maxEnforcement } : {}),
  });
}

// The single assertion every incident-producing arm must satisfy. Deliberately a membership test
// against the wire enum rather than an equality test against an expected literal: that is what makes
// an omitted or undefined value fail rather than silently comparing undefined to undefined.
function expectRecognisedCeiling(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(ENFORCEMENT_CEILINGS as readonly string[]).toContain(value as string);
}

describe("D.4: every incident-producing branch snapshots the attested ceiling", () => {
  it("DENY carries the attested ceiling (uncapped session)", async () => {
    const d = await decide(fresh([entry("r_deny", payloadAt("DENY"))]), writeMd("notes/x.md"), "DENY");
    expect(d.kind).toBe("DENY");
    if (d.kind !== "DENY") throw new Error("unreachable");
    expectRecognisedCeiling(d.enforcementCeiling);
    expect(d.enforcementCeiling).toBe("DENY");
  });

  it("WARN carries the attested ceiling on a natively-WARN rule", async () => {
    const d = await decide(fresh([entry("r_warn", payloadAt("WARN"))]), writeMd("notes/x.md"), "DENY");
    expect(d.kind).toBe("WARN");
    if (d.kind !== "WARN") throw new Error("unreachable");
    expect(d.warnings).toHaveLength(1);
    expectRecognisedCeiling(d.warnings[0].enforcementCeiling);
    expect(d.warnings[0].enforcementCeiling).toBe("WARN");
  });

  it("THE CLAMP CASE: a DENY-attested rule capped to WARN reports decision=warn, ceiling=DENY", async () => {
    // The session cap is what production runs at by default. Without the ceiling on the incident this
    // case is indistinguishable from a rule that was only ever advisory.
    const d = await decide(fresh([entry("r_deny", payloadAt("DENY"))]), writeMd("notes/x.md"), "WARN");
    expect(d.kind).toBe("WARN");
    if (d.kind !== "WARN") throw new Error("unreachable");
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0].enforcementCeiling).toBe("DENY");
  });

  it("every warned rule in an aggregate carries its OWN attested ceiling, uncapped by the display cap", async () => {
    // The reason string is capped at WARN_AGGREGATE_CAP, but `warnings` is deliberately uncapped so
    // every warned rule reaches the review queue. Each must carry its own ceiling, not the first one's.
    const d = await decide(
      fresh([
        entry("r_a", payloadAt("WARN")),
        entry("r_b", payloadAt("DENY")),
        entry("r_c", payloadAt("WARN")),
        entry("r_d", payloadAt("DENY")),
      ]),
      writeMd("notes/x.md"),
      "WARN",
    );
    expect(d.kind).toBe("WARN");
    if (d.kind !== "WARN") throw new Error("unreachable");
    expect(d.warnings).toHaveLength(4);
    for (const w of d.warnings) expectRecognisedCeiling(w.enforcementCeiling);
    expect(d.warnings.map((w) => w.enforcementCeiling)).toEqual(["WARN", "DENY", "WARN", "DENY"]);
  });

  it("OMISSION GUARD: no incident-producing arm yields a missing or unrecognised ceiling, across every attested rung", async () => {
    // Drive the real decision function across the full cross-product of attested ceiling and session
    // cap. Whatever arm each combination lands on, if it produces an incident it must carry a
    // recognised ceiling. This is the assertion a future producer breaks.
    const rungs: EligibleEnforcement[] = ["OBSERVE", "WARN", "ASK", "DENY"];
    let incidentArms = 0;
    for (const attested of rungs) {
      for (const cap of rungs) {
        const d = await decide(fresh([entry(`r_${attested}_${cap}`, payloadAt(attested))]), writeMd("notes/x.md"), cap);
        if (d.kind === "DENY") {
          incidentArms++;
          expectRecognisedCeiling(d.enforcementCeiling);
        } else if (d.kind === "WARN") {
          incidentArms++;
          for (const w of d.warnings) expectRecognisedCeiling(w.enforcementCeiling);
        }
        // ASK, PASS and UNAVAILABLE produce no enforcement incident, so they carry no ceiling.
      }
    }
    // Guard the guard: if a refactor stopped producing incidents entirely, the loop above would pass
    // vacuously. Pin that this cross-product really does exercise incident arms.
    expect(incidentArms).toBeGreaterThan(0);
  });
});
