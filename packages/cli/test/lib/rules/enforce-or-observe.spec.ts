import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  listEvaluationsForAttempt,
  listObservedRulesInScope,
} from "../../../src/lib/rules/interception-store";
import {
  insertLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "../../../src/lib/rules/local-rule-version-repo";
import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
} from "../../../src/lib/rules/durable-observation";
import { type EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import { serializeRuleVersion, ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { NOTES_LOCATION_RULE_ID } from "../../../src/lib/rules/attest-notes-location";
import {
  resolveInputAuthority,
  type HookConfigLayer,
  type InputAuthorityResolution,
} from "../../../src/lib/rules/input-authority-resolver";
import { evaluateEnforceOrObserveNotesRule } from "../../../src/lib/rules/enforce-notes-version";
import { CONSULT_EVIDENCE_RULE_PAYLOAD } from "../../../src/lib/rules/ce0-rule";
import { type RulePayloadV1, type RuleEffect } from "../../../src/lib/rules/types";
import { type RandInt32 } from "../../../src/lib/rules/ulid";
import { type Directive } from "../../../src/lib/scanner/types";

// The bootstrap seam (proposal §3.6: observe is the always-on R0 substrate, enforce layers on the
// attested LIVE version). The live PreToolUse hook composes the two: it ENFORCES against the LIVE
// attested version when one exists, and otherwise records the R0 observed substrate so a rule that has
// never been attested still leaves an observed snapshot the operator can attest from. Without this an
// empty store can never be armed: enforce-only writes nothing when there is no LIVE version, so there
// is no observed snapshot to convert. Runs against one real ce0 database, no mock store.

let dir: string;
let store: Ce0Store;
let mlaHooksDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "enforce-or-observe-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
  mlaHooksDir = path.join(dir, "hooks");
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const PILOT_SCOPE = "/work/meetless";
const FORBIDDEN_ROOT = "notes";
const RUNTIME_ROOT = "/runtime/root";

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

function liveVersion(payload: RulePayloadV1, over: Partial<LocalRuleVersionRecord> = {}): LocalRuleVersionRecord {
  return {
    versionId: "ver_1",
    ruleId: NOTES_LOCATION_RULE_ID,
    runtimeScopeId: payload.runtimeScopeId,
    rulePayload: serializeRuleVersion(payload),
    canonicalPayloadHash: ruleVersionHash(payload),
    lifecycleStatus: "LIVE",
    attestationMethod: "AGENT_ON_USER_REQUEST",
    attestedBy: "user_an",
    supersedesVersionId: null,
    derivedFromObservedHash: "a".repeat(64),
    attestedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

/** A LIVE row carrying the real CE0 consult-evidence payload (an inert RECORD_ONLY rule), stored opaque
 *  exactly as a future mint would write it. It is NOT an enforceable family rule. */
function inertLiveVersion(over: Partial<LocalRuleVersionRecord> = {}): LocalRuleVersionRecord {
  return {
    versionId: "ver_inert",
    ruleId: "consult-evidence",
    runtimeScopeId: PILOT_SCOPE,
    rulePayload: JSON.stringify(CONSULT_EVIDENCE_RULE_PAYLOAD),
    canonicalPayloadHash: "c".repeat(64),
    lifecycleStatus: "LIVE",
    attestationMethod: "AGENT_ON_USER_REQUEST",
    attestedBy: "user_an",
    supersedesVersionId: null,
    derivedFromObservedHash: null,
    attestedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

function counterRand(): RandInt32 {
  let n = 0;
  return () => n++ % 32;
}

const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function mlaSoleAuthority(): InputAuthorityResolution {
  const mlaCommand = path.join(mlaHooksDir, "pre-tool-use.sh");
  const userLayer: HookConfigLayer = {
    name: "user",
    settings: { hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: mlaCommand }] }] } },
  };
  return resolveInputAuthority([userLayer], { mlaHooksDir });
}

function notesDirective(over: Partial<Directive> = {}): Directive {
  return {
    id: "dir_notes",
    text: "Notes and design docs go in the standalone vault, never the repo notes directory.",
    source: "CLAUDE.md",
    kind: "RULE",
    strength: "MUST_FOLLOW",
    attestation: "human_attested",
    ...over,
  };
}

function stdin(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess_1",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "notes/scratch.md", content: "hi" },
    ...over,
  });
}

function input(over: Partial<Parameters<typeof evaluateEnforceOrObserveNotesRule>[1]> = {}) {
  return {
    rawStdin: stdin(),
    directives: [notesDirective()],
    runtimeProjectRoot: RUNTIME_ROOT,
    runtimeScopeId: PILOT_SCOPE,
    createdAt: "2026-06-19T00:00:00.000Z",
    now: 1718700000000,
    rand: counterRand(),
    classifyRuntime,
    resolveInputAuthority: () => mlaSoleAuthority(),
    ...over,
  };
}

describe("evaluateEnforceOrObserveNotesRule: the unarmed observe substrate (bootstrap)", () => {
  it("records an observed snapshot when no LIVE version is armed but a notes-location directive is scanned", async () => {
    const { response, outcome } = await evaluateEnforceOrObserveNotesRule(store, input());

    // observe never grants: pass-through response, no decision.
    expect(response).toEqual({});
    expect(outcome.kind).toBe("PERSISTED");

    // The observed snapshot is now attestable: it shows up in the scope's observed-rule listing.
    const observed = listObservedRulesInScope(store, PILOT_SCOPE);
    expect(observed.length).toBe(1);
    expect(observed[0].hasLocalVersion).toBe(false);
  });

  it("the recorded substrate is the OBSERVED arm (no version FK), not a version evaluation", async () => {
    const { outcome } = await evaluateEnforceOrObserveNotesRule(store, input());
    if (outcome.kind !== "PERSISTED") throw new Error("expected PERSISTED");
    const evals = listEvaluationsForAttempt(store, outcome.attemptId);
    expect(evals.length).toBe(1);
    expect(evals[0].ruleVersionId).toBeNull();
    expect(evals[0].eligibleEnforcement).toBe("OBSERVE");
    expect(evals[0].effectiveEnforcement).toBe("OBSERVE");
  });

  it("records nothing when unarmed and no notes-location directive is scanned (NOT_APPLICABLE)", async () => {
    const { response, outcome } = await evaluateEnforceOrObserveNotesRule(store, input({ directives: [] }));
    expect(response).toEqual({});
    expect(outcome.kind).toBe("NOT_APPLICABLE");
    expect(listObservedRulesInScope(store, PILOT_SCOPE).length).toBe(0);
  });

  it("STILL records the observed substrate when ONLY an inert CE0 rule is LIVE (the seam folds ONLY_INERT_RULES into the observe fallback)", async () => {
    // The consumer-condition guard. The dispatch now reports ONLY_INERT_RULES (not NO_LIVE_VERSION) when an
    // inert rule is the only LIVE row. The composed seam must treat that as an observe-fallback trigger
    // exactly like NO_LIVE_VERSION: an inert rule arms no enforceable version, so the scope still needs its
    // R0 observed snapshot to remain attestable. If the seam returned the bare ONLY_INERT_RULES pass-through
    // instead of folding it into the fallback, the snapshot would be silently dropped and the rule could
    // never be attested. The deny pilot is untouched: observe never grants.
    insertLocalRuleVersion(store, inertLiveVersion());

    const { response, outcome } = await evaluateEnforceOrObserveNotesRule(store, input());

    expect(response).toEqual({});
    expect(outcome.kind).toBe("PERSISTED");
    const observed = listObservedRulesInScope(store, PILOT_SCOPE);
    expect(observed.length).toBe(1);
    expect(observed[0].hasLocalVersion).toBe(false);
  });
});

describe("evaluateEnforceOrObserveNotesRule: delegates to enforce when armed", () => {
  it("emits the admitted deny against the LIVE version (delegation unchanged)", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { response, outcome } = await evaluateEnforceOrObserveNotesRule(store, input());
    expect(outcome.kind).toBe("DENIED");
    if (response.permissionDecision !== "deny") throw new Error("expected a deny response");
    expect(response.reason).toContain(NOTES_LOCATION_RULE_ID);
    expect(response.reason).toContain("notes/scratch.md");
  });

  it("does NOT record a second observed-arm row when armed (the version arm is the substrate)", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { outcome } = await evaluateEnforceOrObserveNotesRule(store, input());
    if (outcome.kind !== "DENIED") throw new Error("expected DENIED");
    const evals = listEvaluationsForAttempt(store, outcome.attemptId);
    expect(evals.length).toBe(1);
    expect(evals[0].ruleVersionId).toBe("ver_1");
  });
});

describe("evaluateEnforceOrObserveNotesRule: carries the R4 conflict-safety guard through the seam", () => {
  it("fails OPEN (no deny) when an out-of-family LIVE rule co-exists with the armed notes pilot", async () => {
    // The live PreToolUse hook calls THIS composed seam, not evaluateAndEnforceLiveRules directly. This
    // pins that the seam routes through the multi-rule dispatch, so the R4 conflict-safety guard stays on
    // the live path. The direct dispatch test (enforce-live-rules.spec.ts) proves the guard exists; the
    // armed-deny test above only ever seeds the single notes pilot, so neither would catch a regression
    // that re-hardwired the seam to one ruleId. This one does: a REQUIRE rule is the conflict-capable kind
    // proposal section 2.0 warns about, so the WHOLE attempt must fail open even though the armed notes
    // pilot would otherwise deny notes/scratch.md.
    insertLocalRuleVersion(store, liveVersion(pilotPayload())); // the armed family pilot: would deny.
    insertLocalRuleVersion(
      store,
      liveVersion(pilotPayload({ effect: "REQUIRE" as RuleEffect }), {
        versionId: "ver_require",
        ruleId: "requires-changelog-v1",
      }),
    );

    const { response, outcome } = await evaluateEnforceOrObserveNotesRule(store, input());

    expect("permissionDecision" in response).toBe(false);
    expect(outcome.kind).toBe("R4_UNSUPPORTED_RULE_KIND");
  });
});
