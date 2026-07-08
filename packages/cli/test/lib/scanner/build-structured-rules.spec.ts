import { buildStructuredRules } from "../../../src/lib/scanner/scan";
import { bundleEntriesToDirectives } from "../../../src/lib/rules/bundle-directives";
import type { Directive } from "../../../src/lib/scanner/types";
import type { RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";
import type { TurnTrigger } from "../../../src/lib/rules/types";

// The read partition (targeted-rule-injection §5.5, change 1): the deduped directive set splits into
// the always-on FLOOR and the per-turn SCOPED inputs the assembler consumes. Three disjoint branches:
// bundle-global-no-glob-no-trigger -> floor; glob-bearing or trigger-bearing -> scoped. This is a POSITIVE
// end-to-end pin (bundle entry -> injectionTupleOK -> directive -> partition), the replacement for the old
// reader-shape fixture: it proves a turn rule lands in scopedRules ONLY, never taxing the floor.

const SCOPE = "scope_a";

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
    strength: "MUST_FOLLOW",
    deliveryChannels: ["runtimeInject"],
    enforcementCeiling: "OBSERVE",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
    ...over,
  };
}

function entry(nodeId: string, p: Record<string, unknown>): RuleBundleEntry {
  return {
    ruleNodeId: nodeId,
    ruleVersionId: `${nodeId}_v1`,
    authorityScope: "TEAM",
    ownerUserId: null,
    projectId: null,
    payload: p,
    // buildStructuredRules never reads the hash; a fixed 64-hex stand-in keeps the entry
    // well-formed without pulling the typed hasher over a Record<string, unknown> payload.
    canonicalPayloadHash: "0".repeat(64),
    attestedByUserId: null,
    attestedAt: "2026-07-07T00:00:00.000Z",
    supersedesVersionId: null,
  };
}

// A file-sourced (.claude/rules) glob directive: no bundle identity, carries globs, no trigger.
function globDirective(): Directive {
  return {
    id: "file_glob_1",
    text: "keep intel prompts in Langfuse",
    source: ".claude/rules/intel.md",
    kind: "RULE",
    strength: "SHOULD_FOLLOW",
    attestation: "human_attested",
    globs: ["intel/**/*.py"],
  };
}

describe("buildStructuredRules — turn rules route to SCOPED only (§5.5 partition)", () => {
  const TRIGGER: TurnTrigger = { promptAny: ["design doc"], explicitPathAny: ["notes/**/*.md"] };

  it("routes a governed turn rule to scopedRules and NOTHING to floorRules", () => {
    const dirs = bundleEntriesToDirectives([
      entry("node_turn", payload({ text: "include a Mermaid diagram", applicability: { mode: "turn", trigger: TRIGGER } })),
    ]);
    const { floorRules, scopedRules } = buildStructuredRules(dirs);

    expect(floorRules).toEqual([]);
    expect(scopedRules).toEqual([
      {
        ruleId: "node_turn",
        versionId: "node_turn_v1",
        text: "include a Mermaid diagram",
        strength: "MUST", // the payload() default is MUST_FOLLOW -> short strength MUST
        globs: [], // a turn-only rule has no globs, so the required explicit-path path never fires for it
        trigger: TRIGGER,
      },
    ]);
  });

  it("keeps the partition disjoint: an ambient rule floors, a turn rule scopes, in one pass", () => {
    const dirs = bundleEntriesToDirectives([
      entry("node_floor", payload({ text: "work on main branch", strength: "MUST_FOLLOW" })),
      entry("node_turn", payload({ text: "cite the privacy doc", applicability: { mode: "turn", trigger: TRIGGER } })),
    ]);
    const { floorRules, scopedRules } = buildStructuredRules(dirs);

    expect(floorRules.map((r) => r.ruleId)).toEqual(["node_floor"]);
    expect(scopedRules.map((r) => r.ruleId)).toEqual(["node_turn"]);
    // No rule is delivered by both planes.
    const floorIds = new Set(floorRules.map((r) => r.ruleId));
    expect(scopedRules.some((r) => floorIds.has(r.ruleId))).toBe(false);
  });

  it("a glob rule scopes with an empty trigger; a turn rule scopes with empty globs", () => {
    const turnDir = bundleEntriesToDirectives([
      entry("node_turn", payload({ text: "turn rule", applicability: { mode: "turn", trigger: TRIGGER } })),
    ]);
    const { scopedRules } = buildStructuredRules([...turnDir, globDirective()]);

    const byText = Object.fromEntries(scopedRules.map((r) => [r.text, r]));
    expect(byText["turn rule"].globs).toEqual([]);
    expect(byText["turn rule"].trigger).toEqual(TRIGGER);
    expect(byText["keep intel prompts in Langfuse"].globs).toEqual(["intel/**/*.py"]);
    expect(byText["keep intel prompts in Langfuse"].trigger).toBeUndefined();
  });
});
