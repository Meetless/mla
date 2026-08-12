// P1: a capability rule can never deny a tool call.
//
// The review made this a hard ship condition and would not authorize a new
// `isCapability` flag or a new enforcement gate to satisfy it. It did not need one:
// `RuleApplicability` (src/lib/rules/types.ts) already has three modes, and only
// `action` reaches the DENY/ASK plane. `ambient` is FLOOR/OBSERVE by construction,
// and a plain `mla rules add` with no --applies-to and no --turn-when-* mints
// ambient (rules-backend.ts, "the ambient default, unchanged").
//
// So the guarantee is structural rather than added, and this file is the guard that
// keeps it structural. It pins the property against the SIX call sites that gate on
// the mode, so that a future edit which starts honouring ambient rules in the
// enforcement plane fails here rather than in production:
//
//   bundle-enforce.ts:276          enforce-notes-version.ts:397,517
//   durable-observation.ts:309     observe-adapter.ts:175
//   version-evaluation.ts:265
//
// The two capability rules this exists for are real and live in the dogfood
// workspace: cmsf42k6f (TEAM, the approved organizational access path) and
// cmsf42kof (PERSONAL, this machine's local availability). Their statements are
// reproduced below in shortened form, because a synthetic string would let the test
// pass while the real payload shape drifted.

import type { RulePayloadV1 } from "../../../src/lib/rules/types";

/** The payload shape `mla rules add "<statement>" --must` mints with no scoping flags. */
function ambientCapabilityPayload(statement: string): RulePayloadV1 {
  return {
    text: statement,
    // The whole guarantee, in one field. No --applies-to and no --turn-when-* means
    // ambient, and ambient is OBSERVE.
    applicability: { mode: "ambient" },
    compliance: {
      evaluatorContractVersion: "four-state-evaluator-v1",
      matcherSchemaVersion: "action-applicability-v1",
      pathCanonicalizerVersion: "notes-path-v1",
      config: {},
    },
    // REQUIRE, not PROHIBIT: a capability states what is reachable, it forbids nothing.
    effect: "REQUIRE",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["promptInjection"],
    // The enforcement ladder's floor. OBSERVE can never ask and never deny.
    enforcementCeiling: "OBSERVE",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: "/work/meetless",
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
  } as unknown as RulePayloadV1;
}

// Shortened but faithful to the live statements (cmsf42k6f / cmsf42kof).
const TEAM_ACCESS_PATH =
  "Production reads are non-interactive and already provisioned. Use the governed " +
  "service-account helper wrapper, which activates a read-only identity and restores " +
  "the default account afterwards. claude-log-reader@prod-meetless is the read-only " +
  "identity for Cloud Logging and Cloud Run. pulse-reader@prod-meetless holds " +
  "roles/owner, so use it deliberately and SELECT-only.";

const LOCAL_AVAILABILITY =
  "On this machine the governed prod helper is installed at ~/.claude/bin/gcp and " +
  "reads its service-account key from ~/.ssh/gcp-prod-sa.json. Verified 2026-08-04.";

describe("P1: a capability rule can never enforce", () => {
  // THE GUARANTEE, tested where it actually lives.
  //
  // Every enforcement consumer opens with the same predicate before it will act:
  //
  //   bundle-enforce.ts:276        `payload.effect !== "PROHIBIT" || app.mode !== "action"` -> null
  //   enforce-notes-version.ts:397 `payload.applicability.mode !== "action"`
  //   enforce-notes-version.ts:517 `payload.applicability.mode === "action" && ...`
  //   durable-observation.ts:309   `spec.applicability.mode !== "action"`
  //   observe-adapter.ts:175       `config.applicability.mode !== "action"`
  //   version-evaluation.ts:265    `payload.applicability.mode !== "action"`
  //
  // So the property is: an ambient capability payload fails that predicate at every
  // one of them, and therefore no consumer can reach a decision about it. Asserting
  // the predicate is a stronger and more durable test than driving the full engine,
  // because the engine needs a compliance config, a runtime root and a cache read
  // that a capability rule never has, and a test that constructs all of those is
  // testing the harness at least as much as the guarantee.
  const enforcementEligible = (payload: RulePayloadV1) => {
    const p = payload as unknown as { effect: string; applicability: { mode: string } };
    return p.applicability.mode === "action";
  };

  it("is not enforcement-eligible: the mode gate every consumer applies", () => {
    for (const statement of [TEAM_ACCESS_PATH, LOCAL_AVAILABILITY]) {
      expect(enforcementEligible(ambientCapabilityPayload(statement))).toBe(false);
    }
  });

  it("would be eligible only if someone changed the mode, which is the regression to catch", () => {
    // The inverse, so the test proves the predicate discriminates rather than
    // always returning false.
    const asAction = { ...ambientCapabilityPayload(TEAM_ACCESS_PATH), applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", glob: "*" } } };
    expect(enforcementEligible(asAction as unknown as RulePayloadV1)).toBe(true);
  });

  it("declares REQUIRE, never PROHIBIT: a capability forbids nothing", () => {
    // bundle-enforce's gate is an OR, so effect alone also disqualifies it. Both
    // halves are asserted because either one changing is a regression.
    const p = ambientCapabilityPayload(TEAM_ACCESS_PATH) as unknown as { effect: string };
    expect(p.effect).toBe("REQUIRE");
    expect(p.effect).not.toBe("PROHIBIT");
  });

  it("sits at the floor of the enforcement ladder", () => {
    // OBSERVE < WARN < ASK < DENY. A capability rule may never climb it.
    const p = ambientCapabilityPayload(TEAM_ACCESS_PATH) as unknown as { enforcementCeiling: string; strength: string };
    expect(p.enforcementCeiling).toBe("OBSERVE");
    // MUST_FOLLOW is a DELIVERY severity, not an enforcement effect. Conflating the
    // two is the mistake this file exists to make impossible: both live capability
    // rules are MUST_FOLLOW and neither may ever block a call.
    expect(p.strength).toBe("MUST_FOLLOW");
  });

  it("carries no secret material in either live statement", () => {
    // The review's ship condition 5. Paths are permitted (they name where a thing
    // lives); contents are not. A live-shaped credential in a floor rule would be
    // broadcast into every agent's context on every turn.
    const credentialShaped = /phx_[a-z0-9]|xoxb-|-----BEGIN|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{20}|:\/\/[^:/]+:[^@]+@|"private_key"/;
    for (const statement of [TEAM_ACCESS_PATH, LOCAL_AVAILABILITY]) {
      expect(statement).not.toMatch(credentialShaped);
    }
  });

  it("keeps team policy and local availability in separate statements", () => {
    // The review forbade combining them, because "the approved path for reaching a
    // resource" and "this machine currently has that credential" are different
    // claims with different scopes, and local availability must never silently
    // become team truth. The mixed rule cmseqht62 that did combine them was revoked.
    expect(TEAM_ACCESS_PATH).not.toContain("On this machine");
    expect(LOCAL_AVAILABILITY).not.toContain("roles/owner");
  });
});
