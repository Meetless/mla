import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import type { EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import type { RuleBundle, RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";
import type { BundleCacheRead } from "../../../src/lib/rules/bundle-cache";
import type { RulePayloadV1 } from "../../../src/lib/rules/types";
import type { ToolCall } from "../../../src/lib/rules/evaluator";
import { decideBundleEnforcement } from "../../../src/lib/rules/bundle-enforce";
import {
  FORBIDDEN_COMMAND_CANONICALIZER_VERSION,
  FORBIDDEN_COMMAND_EVALUATOR_CONTRACT_VERSION,
  FORBIDDEN_COMMAND_MATCHER_SCHEMA_VERSION,
} from "../../../src/lib/rules/command-match";

// F2 (2026-08-07). The THIRD compliance-config family on the bundle enforcement
// plane: a rule whose subject is the COMMAND ABOUT TO RUN, not a path it writes.
//
// WHY. Session 48a29003 authorized `node tools/billing/comp-credit.cjs --apply`,
// a real write to the production billing ledger, and the governed plane said
// nothing. The plane was not asleep: the same hook had warned correctly minutes
// earlier about a notes-vault path. It had no vocabulary for the subject. The
// router structurally cannot recover the operation either -- the prompt was the
// four words "do it for lam" -- so the only surface that can see this action is
// the one holding the command string, at PreToolUse, which is exactly here.
//
// WHAT THIS IS NOT. It is not a new plane, not a policy DSL, and not a shell
// parser. `bundle-enforce` already documented the extension point ("A third
// family may be added on the same footing"); the tokenizer already existed,
// sound and tested, in command-match.ts, where it had sat with ZERO non-test
// callers since it was written. This wires it to the live path and adds nothing
// else.
//
// The soundness posture is inherited and is deliberately asymmetric: a positive
// literal match is a VIOLATION, and a non-match is UNKNOWN rather than COMPLIANT,
// because an alias / wrapper / eval could perform the operation without the
// tokens appearing. UNKNOWN never warns, so every miss fails silent.

const SCOPE = "/work/meetless";

function commandPayload(over: Partial<RulePayloadV1> = {}): RulePayloadV1 {
  return {
    text: "A prod billing comp is an ADJUSTMENT/PREPAID entry; never forge a PREPAID_TOPUP. See the register note before applying.",
    applicability: { mode: "action", tools: ["Bash"], matcher: { field: "command" } },
    compliance: {
      evaluatorContractVersion: FORBIDDEN_COMMAND_EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: FORBIDDEN_COMMAND_MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: FORBIDDEN_COMMAND_CANONICALIZER_VERSION,
      config: { forbiddenCommandAllOf: [["comp-credit.cjs"], ["--apply"]] },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: "WARN",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
    ...over,
  };
}

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
    attestedAt: "2026-08-07T00:00:00.000Z",
    supersedesVersionId: null,
    ...over,
  };
}

function bundle(rules: RuleBundleEntry[]): RuleBundle {
  return {
    schemaVersion: 1,
    principalUserId: "user_an",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 7,
    generatedAt: "2026-08-07T00:00:00.000Z",
    validUntil: "2026-08-07T01:00:00.000Z",
    rules,
  };
}

function fresh(rules: RuleBundleEntry[]): BundleCacheRead {
  return { status: "fresh", bundle: bundle(rules), ageMs: 1000, droppedForIntegrity: 0, reason: null };
}

const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function bash(command: string): ToolCall {
  return { toolName: "Bash", toolInput: { command } };
}

function decide(read: BundleCacheRead, call: ToolCall, maxEnforcement?: "OBSERVE" | "WARN" | "ASK" | "DENY") {
  return decideBundleEnforcement({
    call,
    read,
    runtimeProjectRoot: "/runtime/root",
    runtimeScopeId: SCOPE,
    classifyRuntime,
    ...(maxEnforcement ? { maxEnforcement } : {}),
  });
}

const REAL_INVOCATION = "node tools/billing/comp-credit.cjs --account acc_1 --amount 200 --apply";

describe("bundle enforcement: the COMMAND compliance family", () => {
  it("WARNs on the real comp-credit apply invocation", async () => {
    const result = await decide(fresh([entry("node_comp", commandPayload())]), bash(REAL_INVOCATION));
    expect(result.kind).toBe("WARN");
    if (result.kind === "WARN") {
      expect(result.warnings[0].ruleNodeId).toBe("node_comp");
      expect(result.reason).toContain("node_comp");
      // The rule's own text has to reach the operator: the whole point is that
      // the conventions were in the corpus and the agent learned them from a
      // script header comment instead.
      expect(result.reason).toContain("never forge a PREPAID_TOPUP");
    }
  });

  it("stays silent on the same script WITHOUT the mutating flag", async () => {
    const result = await decide(
      fresh([entry("node_comp", commandPayload())]),
      bash("node tools/billing/comp-credit.cjs --account acc_1 --dry-run"),
    );
    expect(result.kind).toBe("PASS");
  });

  it("stays silent on an unrelated Bash command", async () => {
    const result = await decide(fresh([entry("node_comp", commandPayload())]), bash("git status"));
    expect(result.kind).toBe("PASS");
  });

  // The noise budget is the whole risk here: a rule that fires wrongly trains the
  // operator to scroll past the banner that currently works. `--apply` alone is
  // common; the conjunction is what keeps this narrow.
  it("stays silent on a DIFFERENT script that also takes --apply", async () => {
    const result = await decide(
      fresh([entry("node_comp", commandPayload())]),
      bash("node tools/billing/refund.cjs --apply"),
    );
    expect(result.kind).toBe("PASS");
  });

  it("does not fire for a non-Bash tool", async () => {
    const result = await decide(fresh([entry("node_comp", commandPayload())]), {
      toolName: "Write",
      toolInput: { file_path: "comp-credit.cjs", content: "--apply" },
    });
    expect(result.kind).toBe("PASS");
  });

  // A command rule has NO path. `targetPath` is the runtime-relative file an
  // incident was about, and inventing one here would put a script path into the
  // review queue's blocked-path column as though we had judged a write to it.
  it("records the incident with a null targetPath", async () => {
    const result = await decide(fresh([entry("node_comp", commandPayload())]), bash(REAL_INVOCATION));
    if (result.kind !== "WARN") throw new Error(`expected WARN, got ${result.kind}`);
    expect(result.warnings[0].targetPath).toBeNull();
  });

  it("carries the ATTESTED ceiling on the warning", async () => {
    const result = await decide(fresh([entry("node_comp", commandPayload())]), bash(REAL_INVOCATION));
    if (result.kind !== "WARN") throw new Error(`expected WARN, got ${result.kind}`);
    expect(result.warnings[0].enforcementCeiling).toBe("WARN");
  });
});

describe("bundle enforcement: COMMAND family safety gates", () => {
  // Same gate the note-vault family carries: a payload minted against a different
  // evaluator contract is NOT enforced, rather than enforced under semantics its
  // attester never saw.
  it("does not enforce a payload whose evaluator contract version disagrees", async () => {
    const payload = commandPayload();
    const drifted: RulePayloadV1 = {
      ...payload,
      compliance: { ...payload.compliance, evaluatorContractVersion: "some-future-evaluator-v2" },
    };
    expect((await decide(fresh([entry("node_comp", drifted)]), bash(REAL_INVOCATION))).kind).toBe("PASS");
  });

  it("does not enforce a payload whose matcher schema version disagrees", async () => {
    const payload = commandPayload();
    const drifted: RulePayloadV1 = {
      ...payload,
      compliance: { ...payload.compliance, matcherSchemaVersion: "forbidden-command-allof-v2" },
    };
    expect((await decide(fresh([entry("node_comp", drifted)]), bash(REAL_INVOCATION))).kind).toBe("PASS");
  });

  it("does not enforce a rule that is not delivered to preToolUse", async () => {
    const payload = commandPayload({ deliveryChannels: ["nativeRule"] });
    expect((await decide(fresh([entry("node_comp", payload)]), bash(REAL_INVOCATION))).kind).toBe("PASS");
  });

  it("does not enforce a non-PROHIBIT effect", async () => {
    const payload = commandPayload({ effect: "REQUIRE" } as Partial<RulePayloadV1>);
    expect((await decide(fresh([entry("node_comp", payload)]), bash(REAL_INVOCATION))).kind).toBe("PASS");
  });

  it("does not enforce an OBSERVE ceiling", async () => {
    const payload = commandPayload({ enforcementCeiling: "OBSERVE" });
    expect((await decide(fresh([entry("node_comp", payload)]), bash(REAL_INVOCATION))).kind).toBe("PASS");
  });

  // A PERSONAL rule binds to the ONE checkout it was attested from. Same gate the
  // path families carry; a command rule must not be the hole that skips it.
  it("does not enforce a PERSONAL rule attested in a DIFFERENT checkout", async () => {
    const payload = commandPayload({ runtimeScopeId: "/some/other/checkout" });
    const result = await decide(
      fresh([entry("node_comp", payload, { authorityScope: "PERSONAL", ownerUserId: "user_an" })]),
      bash(REAL_INVOCATION),
    );
    expect(result.kind).toBe("PASS");
  });

  // An empty conjunction is unevaluable, never "matches everything". A rule that
  // silently degenerated into match-all would warn on every Bash call in the
  // session, which is the one outcome that would damage the working path rules.
  it("does not fire on a degenerate empty conjunction", async () => {
    const payload = commandPayload();
    const empty: RulePayloadV1 = {
      ...payload,
      compliance: { ...payload.compliance, config: { forbiddenCommandAllOf: [] } },
    };
    expect((await decide(fresh([entry("node_comp", empty)]), bash(REAL_INVOCATION))).kind).toBe("PASS");
    expect((await decide(fresh([entry("node_comp", empty)]), bash("ls"))).kind).toBe("PASS");
  });

  it("clamps a DENY-attested command rule to WARN under a WARN session cap", async () => {
    const payload = commandPayload({ enforcementCeiling: "DENY" });
    const result = await decide(fresh([entry("node_comp", payload)]), bash(REAL_INVOCATION), "WARN");
    expect(result.kind).toBe("WARN");
    if (result.kind === "WARN") {
      // The ATTESTED ceiling is preserved on the incident even though the session
      // clamped the effective decision; erasing it would hide the clamp.
      expect(result.warnings[0].enforcementCeiling).toBe("DENY");
    }
  });
});

// The WARN wrapper copy, which is a separate authorship surface from the reason
// body and had a path assumption baked into it.
//
// Measured live on 2026-08-07, first end-to-end firing of this family: the
// advisory correctly named the rule, the ceiling and the billing conventions,
// and then closed with "correct it (for example, write to the allowed
// location)". There is no location. The rule judged a command. That sentence is
// the same defect class F5 fixed one banner over: copy that asserts something
// the hook has no evidence for, on the turn where the operator is deciding what
// to do. The rule's own text is the authority on what correcting means, so the
// wrapper must not guess a remedy shape on its behalf.
import { runInternalPretoolObserve } from "../../../src/commands/internal-pretool-observe";

describe("the governed-rule WARN wrapper is family-neutral", () => {
  it("does not suggest a PATH remedy, because not every rule judges a path", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../../../src/commands/internal-pretool-observe.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/write to the allowed location/);
    // The generic instruction stays: the agent is still told to correct it.
    expect(source).toMatch(/before continuing/);
  });

  it("keeps runInternalPretoolObserve exported (the wrapper's only entry point)", () => {
    expect(typeof runInternalPretoolObserve).toBe("function");
  });
});

// THE VERSION TRIPLE IS NOT DECORATION. v1 of this evaluator read heredoc bodies
// as code and warned on a commit message that quoted an invocation. v2 does not.
// A payload An attested under v1 semantics must therefore stop being enforced,
// not be silently re-judged by rules he never saw. This is the specific pin: the
// literal retired string, not a variable, so a future bump cannot make this test
// pass by moving with it.
describe("a v1-attested command payload is NOT enforced by the v2 evaluator", () => {
  it("refuses the retired contract version by literal", async () => {
    const payload = commandPayload();
    const v1: RulePayloadV1 = {
      ...payload,
      compliance: {
        ...payload.compliance,
        evaluatorContractVersion: "forbidden-command-allof-evaluator-v1",
      },
    };
    expect((await decide(fresh([entry("node_v1", v1)]), bash(REAL_INVOCATION))).kind).toBe("PASS");
  });
});
