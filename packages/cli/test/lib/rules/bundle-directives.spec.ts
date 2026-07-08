import {
  RULE_BUNDLE_DIRECTIVE_SOURCE,
  bundleEntriesToDirectives,
  injectionTupleOK,
} from "../../../src/lib/rules/bundle-directives";
import { managedRuleToRulePayload } from "../../../src/lib/rules/rule-import-mapping";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { directiveId } from "../../../src/lib/scanner/types";
import { makeManagedRule } from "../../../src/lib/scanner/managed-rules";
import type { RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";
import type { TurnTrigger } from "../../../src/lib/rules/types";

// The bundle -> directive adapter (G3 injection path). Pure: it reshapes already-validated
// bundle entries into the same Directive shape `managedRulesToDirectives` emits, so the
// renderer and dedupe stay untouched. The key behavior under test is the injection filter:
// only `runtimeInject` payloads become directives, mirroring the pre-cutover boundary where
// managed rules were injected and CE0 enforcement rules were not.

const SCOPE = "scope_a";

function entry(over: Partial<RuleBundleEntry> = {}): RuleBundleEntry {
  const payload = managedRuleToRulePayload(
    makeManagedRule({ statement: "include a Mermaid diagram in design docs", strength: "MUST_FOLLOW" }),
    SCOPE,
  );
  return {
    ruleNodeId: "node_1",
    ruleVersionId: "ver_1",
    authorityScope: "TEAM",
    ownerUserId: null,
    projectId: null,
    payload,
    canonicalPayloadHash: ruleVersionHash(payload),
    attestedByUserId: null,
    attestedAt: "2026-06-20T00:00:00.000Z",
    supersedesVersionId: null,
    ...over,
  };
}

/** A payload with a chosen text/strength/channels, bypassing the managed mapper for control. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: "a rule",
    applicability: { mode: "ambient" },
    compliance: {
      evaluatorContractVersion: "none",
      matcherSchemaVersion: "none",
      pathCanonicalizerVersion: "none",
      config: { forbiddenRootRelativePath: "" },
    },
    effect: "REQUIRE",
    strength: "SHOULD_FOLLOW",
    deliveryChannels: ["runtimeInject"],
    enforcementCeiling: "OBSERVE",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
    ...over,
  };
}

describe("bundleEntriesToDirectives — happy path", () => {
  it("converts an injectable bundle entry into a human_attested RULE directive", () => {
    const dirs = bundleEntriesToDirectives([entry()]);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toEqual({
      id: directiveId(RULE_BUNDLE_DIRECTIVE_SOURCE, "include a Mermaid diagram in design docs"),
      text: "include a Mermaid diagram in design docs",
      source: RULE_BUNDLE_DIRECTIVE_SOURCE,
      kind: "RULE",
      strength: "MUST_FOLLOW",
      attestation: "human_attested",
      // Durable backend identities threaded from the bundle entry (P2.1): the scan cache,
      // shared matcher, overflow audit, and best-effort omission log name the rule by these
      // rather than the content-hash `id`. File-sourced directives fall back to `id`.
      ruleNodeId: "node_1",
      ruleVersionId: "ver_1",
    });
  });

  it("preserves SHOULD_FOLLOW and degrades ADVISORY to SHOULD_FOLLOW", () => {
    const dirs = bundleEntriesToDirectives([
      entry({ payload: payload({ text: "should rule", strength: "SHOULD_FOLLOW" }) }),
      entry({ payload: payload({ text: "advisory rule", strength: "ADVISORY" }) }),
    ]);
    expect(dirs.map((d) => [d.text, d.strength])).toEqual([
      ["should rule", "SHOULD_FOLLOW"],
      ["advisory rule", "SHOULD_FOLLOW"],
    ]);
  });

  it("honors a custom source label for id derivation and provenance", () => {
    const dirs = bundleEntriesToDirectives([entry()], "rule-bundle:ws_1");
    expect(dirs[0].source).toBe("rule-bundle:ws_1");
    expect(dirs[0].id).toBe(directiveId("rule-bundle:ws_1", "include a Mermaid diagram in design docs"));
  });

  it("trims surrounding whitespace from the rule text", () => {
    const dirs = bundleEntriesToDirectives([entry({ payload: payload({ text: "  spaced rule  " }) })]);
    expect(dirs[0].text).toBe("spaced rule");
  });
});

describe("bundleEntriesToDirectives — injection filter (the pre-cutover boundary)", () => {
  it("drops a GLOBAL (ambient) preToolUse-only enforcement rule (never injected, only enforced)", () => {
    // The unscoped tool-only case: an ambient (mode:"ambient", no matcher.glob) enforcement
    // rule carries only preToolUse and must stay out of the prompt.
    const denyOnly = entry({ payload: payload({ text: "deny under /notes", deliveryChannels: ["preToolUse"] }) });
    expect(bundleEntriesToDirectives([denyOnly])).toEqual([]);
  });

  it("drops a SCOPED (glob-bearing, mode:action) tool-only rule too, not only ambient ones", () => {
    // P2.7 / §8 unsupported-delivery inventory: a tool-only rule is excluded from injection at
    // EVERY scope, not just the global one. A Plane-B enforcement rule expresses its scope as an
    // action-mode `matcher.glob`; the injection filter keys ONLY on `deliveryChannels`, so that
    // glob can never smuggle a preToolUse rule into the prompt. This is the boundary guarantee:
    // injection never surfaces a Plane-B glob, so the two planes cannot cross via a scoped rule.
    const scopedDenyOnly = entry({
      payload: payload({
        text: "deny Write under notes/**",
        deliveryChannels: ["preToolUse"],
        applicability: {
          mode: "action",
          tools: ["Write", "Edit"],
          matcher: { field: "file_path", glob: "notes/**" },
        },
      }),
    });
    expect(bundleEntriesToDirectives([scopedDenyOnly])).toEqual([]);
  });

  it("drops a rule that carries runtimeInject ALONGSIDE another channel (§5.4 exact tuple)", () => {
    // The §5.4 tightening over the old channel-only `includes` filter: the legal injection tuple
    // requires deliveryChannels to be EXACTLY ["runtimeInject"]. A payload that also lists
    // preToolUse is precisely the "stray runtimeInject channel" case the read boundary exists to
    // reject: an enforcement rule cannot smuggle itself into the prompt by tacking on the inject
    // channel. This is a deliberate behavior change from the pre-boundary permissive filter.
    const both = entry({
      payload: payload({ text: "mixed rule", deliveryChannels: ["preToolUse", "runtimeInject"] }),
    });
    expect(bundleEntriesToDirectives([both])).toEqual([]);
  });

  it("drops an entry whose deliveryChannels is missing or not an array (fail closed)", () => {
    const noChannels = entry({ payload: payload({ deliveryChannels: undefined }) });
    const badChannels = entry({ payload: payload({ deliveryChannels: "runtimeInject" }) });
    expect(bundleEntriesToDirectives([noChannels, badChannels])).toEqual([]);
  });

  it("drops an ambient rule with a non-OBSERVE ceiling (injection never carries ASK/DENY)", () => {
    expect(bundleEntriesToDirectives([entry({ payload: payload({ enforcementCeiling: "DENY" }) })])).toEqual([]);
    expect(bundleEntriesToDirectives([entry({ payload: payload({ enforcementCeiling: "ASK" }) })])).toEqual([]);
  });

  it("drops a rule wired to a real compliance evaluator (injection requires evaluator 'none')", () => {
    const wired = entry({
      payload: payload({
        compliance: {
          evaluatorContractVersion: "four-state-evaluator-v1",
          matcherSchemaVersion: "none",
          pathCanonicalizerVersion: "none",
          config: { forbiddenRootRelativePath: "" },
        },
      }),
    });
    expect(bundleEntriesToDirectives([wired])).toEqual([]);
  });
});

describe("bundleEntriesToDirectives — malformed payloads are dropped, not thrown", () => {
  it("drops a non-object payload", () => {
    expect(bundleEntriesToDirectives([entry({ payload: "not an object" })])).toEqual([]);
    expect(bundleEntriesToDirectives([entry({ payload: null })])).toEqual([]);
  });

  it("drops a payload with a non-string or blank text", () => {
    expect(bundleEntriesToDirectives([entry({ payload: payload({ text: 42 }) })])).toEqual([]);
    expect(bundleEntriesToDirectives([entry({ payload: payload({ text: "   " }) })])).toEqual([]);
  });
});

describe("bundleEntriesToDirectives — turn variant threads the trigger (§5.4/§5.5)", () => {
  const TRIGGER: TurnTrigger = { promptAny: ["design doc", "architecture"], explicitPathAny: ["notes/**/*.md"] };

  function turnEntry(over: Record<string, unknown> = {}) {
    return entry({
      payload: payload({ text: "include a Mermaid diagram", applicability: { mode: "turn", trigger: TRIGGER }, ...over }),
    });
  }

  it("converts a valid turn rule into a directive that CARRIES the trigger", () => {
    const [dir] = bundleEntriesToDirectives([turnEntry()]);
    expect(dir.trigger).toEqual(TRIGGER);
    expect(dir.text).toBe("include a Mermaid diagram");
    expect(dir.strength).toBe("SHOULD_FOLLOW");
    expect(dir.attestation).toBe("human_attested");
  });

  it("an ambient rule carries NO trigger (the key is omitted, not null)", () => {
    const [dir] = bundleEntriesToDirectives([entry()]);
    expect(dir.trigger).toBeUndefined();
    expect("trigger" in dir).toBe(false);
  });

  it("drops a turn rule whose trigger is malformed (empty lists) — the grammar owner rejects it", () => {
    const empty = turnEntry({ applicability: { mode: "turn", trigger: { promptAny: [] } } });
    expect(bundleEntriesToDirectives([empty])).toEqual([]);
  });
});

// The four symmetric invariant tests are the acceptance gate for §5.4. Invariant 1 (a turn
// rule never reaches the Plane-B enforcement gate) lives with that gate in bundle-enforce.spec.ts;
// invariants 2-4 pin the injection read boundary here.
describe("injectionTupleOK — §5.4 read-boundary invariants", () => {
  it("invariant 2: action never reaches injection even when it lists runtimeInject", () => {
    // The channel is legal but the mode is not: an action rule cannot inject however its channels read.
    const p = payload({
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", glob: "*.md" } },
      deliveryChannels: ["runtimeInject"],
    });
    expect(injectionTupleOK(p)).toEqual({ injectable: false });
  });

  it("invariant 3: a turn rule with an ASK or DENY ceiling is rejected", () => {
    const trigger: TurnTrigger = { promptAny: ["x"] };
    const ask = payload({ applicability: { mode: "turn", trigger }, enforcementCeiling: "ASK" });
    const deny = payload({ applicability: { mode: "turn", trigger }, enforcementCeiling: "DENY" });
    expect(injectionTupleOK(ask)).toEqual({ injectable: false });
    expect(injectionTupleOK(deny)).toEqual({ injectable: false });
  });

  it("invariant 4: an ambient payload carrying a stray trigger is rejected as malformed", () => {
    // parseApplicability tolerates the stray key on ambient (it reads only `mode`); the read
    // boundary itself must reject it, because an ambient rule with a trigger is a malformed turn rule.
    const p = payload({ applicability: { mode: "ambient", trigger: { promptAny: ["x"] } } });
    expect(injectionTupleOK(p)).toEqual({ injectable: false });
  });

  it("accepts the two legal tuples: ambient (no trigger) and turn (trigger carried)", () => {
    expect(injectionTupleOK(payload())).toEqual({ injectable: true });
    const trigger: TurnTrigger = { explicitPathAny: ["notes/**"] };
    expect(injectionTupleOK(payload({ applicability: { mode: "turn", trigger } }))).toEqual({
      injectable: true,
      trigger,
    });
  });
});
