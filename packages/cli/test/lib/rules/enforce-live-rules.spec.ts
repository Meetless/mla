import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import { getToolAttempt } from "../../../src/lib/rules/interception-store";
import {
  insertLocalRuleVersion,
  listLiveLocalRuleVersions,
  type LocalRuleVersionRecord,
} from "../../../src/lib/rules/local-rule-version-repo";
import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
} from "../../../src/lib/rules/durable-observation";
import { type EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import { serializeRuleVersion, ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import {
  resolveInputAuthority,
  type HookConfigLayer,
  type InputAuthorityResolution,
} from "../../../src/lib/rules/input-authority-resolver";
import { evaluateAndEnforceLiveRules } from "../../../src/lib/rules/enforce-notes-version";
import { type RulePayloadV1, type RuleEffect } from "../../../src/lib/rules/types";
import { CONSULT_EVIDENCE_RULE_PAYLOAD } from "../../../src/lib/rules/ce0-rule";

// A3.3: the rule-driven enforce dispatch. The R1 seam was hardwired to one ruleId (notes-location);
// this dispatch faces EVERY LIVE rule in the scope against one tool attempt and emits at most ONE deny.
// The whole PROHIBIT forbidden-root family is provably conflict-free (proposal section 2.0: a conflict
// needs an effect that EFFECTIVELY REQUIRES an action, and PROHIBIT never requires), so when more than
// one family rule would deny the same action the dispatch is free to pick a deterministic winner (the
// lowest ruleId) and record the rest as observed arms. The explicit R4 boundary: the moment any LIVE
// rule is OUTSIDE that family (a REQUIRE/REQUIRE_APPROVAL effect, an ambient rule) the dispatch can no
// longer prove the absence of a conflict, so it fails OPEN for the whole attempt rather than enforce a
// deny it cannot reason about. Runs against one real ce0 store, no mock store. ULIDs come from the
// production CSPRNG (no injected rand) so the many ids minted across per-rule seam calls never collide.

let dir: string;
let store: Ce0Store;
let mlaHooksDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "enforce-live-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
  mlaHooksDir = path.join(dir, "hooks");
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const SCOPE = "/work/meetless";
const RUNTIME_ROOT = "/runtime/root";

/** A PROHIBIT forbidden-root payload over the given root: the enforceable family the dispatch denies. */
function familyPayload(forbiddenRoot: string, over: Partial<RulePayloadV1> = {}): RulePayloadV1 {
  return {
    text: `Files MUST NOT be written under the repo ${forbiddenRoot} directory.`,
    applicability: { mode: "action", tools: ["Edit", "Write"], matcher: { field: "file_path", glob: "*.md" } },
    compliance: {
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
      config: { forbiddenRootRelativePath: forbiddenRoot },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: "DENY",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
    ...over,
  };
}

function liveVersion(
  ruleId: string,
  payload: RulePayloadV1,
  over: Partial<LocalRuleVersionRecord> = {},
): LocalRuleVersionRecord {
  return {
    versionId: `ver_${ruleId}`,
    ruleId,
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

function seed(ruleId: string, payload: RulePayloadV1): void {
  insertLocalRuleVersion(store, liveVersion(ruleId, payload));
}

/** Seed a LIVE row whose payload is an arbitrary (non-RulePayloadV1) object, the way a code-defined rule
 * such as the CE0 consult-evidence forcing function is stored: opaque canonical bytes, opaque hash. The
 * dispatch only ever JSON.parses rulePayload to classify it, so the hash value is immaterial here. */
function seedRaw(ruleId: string, payload: object): void {
  insertLocalRuleVersion(store, {
    versionId: `ver_${ruleId}`,
    ruleId,
    runtimeScopeId: SCOPE,
    rulePayload: JSON.stringify(payload),
    canonicalPayloadHash: "c".repeat(64),
    lifecycleStatus: "LIVE",
    attestationMethod: "AGENT_ON_USER_REQUEST",
    attestedBy: "user_an",
    supersedesVersionId: null,
    derivedFromObservedHash: null,
    attestedAt: "2026-06-19T00:00:00.000Z",
  });
}

// The only Write/Edit PreToolUse hook is MLA's managed pre-tool-use.sh: MLA is the sole input authority.
function mlaSoleAuthority(): InputAuthorityResolution {
  const mlaCommand = path.join(mlaHooksDir, "pre-tool-use.sh");
  const userLayer: HookConfigLayer = {
    name: "user",
    settings: { hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: mlaCommand }] }] } },
  };
  return resolveInputAuthority([userLayer], { mlaHooksDir });
}

// Echo the raw path as a runtime-relative target so the seam never touches the filesystem.
const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function stdin(filePath: string): string {
  return JSON.stringify({
    session_id: "sess_1",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "hi" },
  });
}

function input(filePath: string, over: Record<string, unknown> = {}) {
  return {
    rawStdin: stdin(filePath),
    runtimeProjectRoot: RUNTIME_ROOT,
    runtimeScopeId: SCOPE,
    createdAt: "2026-06-19T00:00:00.000Z",
    now: 1718700000000,
    classifyRuntime,
    resolveInputAuthority: () => mlaSoleAuthority(),
    ...over,
  };
}

describe("evaluateAndEnforceLiveRules: denies against whichever LIVE family rule the action violates", () => {
  it("emits one deny naming the violated rule when a later-evaluated rule is the violator", async () => {
    seed("notes-location-v1", familyPayload("notes"));
    seed("secrets-location-v1", familyPayload("secrets"));

    // notes-location-v1 sorts first and is COMPLIANT here; secrets-location-v1 is the violator.
    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("secrets/api-key.md"));

    if (response.permissionDecision !== "deny") throw new Error("expected a deny response");
    expect(response.reason).toContain("secrets-location-v1");
    expect(response.reason).not.toContain("notes-location-v1");
    expect(outcome.kind).toBe("DENIED");
  });

  it("records the non-violating earlier rule as an OBSERVE arm (others' arms are recorded)", async () => {
    seed("notes-location-v1", familyPayload("notes"));
    seed("secrets-location-v1", familyPayload("secrets"));

    await evaluateAndEnforceLiveRules(store, input("secrets/api-key.md"));

    // Both rules ran and each left exactly one arm: notes observed COMPLIANT, secrets emitted the deny.
    const denyAttempt = findAttemptForVersion(store, "ver_secrets-location-v1");
    const observeAttempt = findAttemptForVersion(store, "ver_notes-location-v1");
    expect(denyAttempt?.denyEmissionStatus).toBe("RESPONSE_EMITTED");
    expect(observeAttempt?.denyEmissionStatus).toBe("NOT_APPLICABLE");
  });
});

describe("evaluateAndEnforceLiveRules: deterministic winner among multiple violating rules", () => {
  it("emits the deny of the lowest ruleId when two family rules both forbid the violated root", async () => {
    // Both rules forbid the SAME root, so the write violates both; the lowest ruleId is the winner.
    seed("aaa-secrets-v1", familyPayload("secrets"));
    seed("zzz-secrets-v1", familyPayload("secrets"));

    const { response } = await evaluateAndEnforceLiveRules(store, input("secrets/api-key.md"));

    if (response.permissionDecision !== "deny") throw new Error("expected a deny response");
    expect(response.reason).toContain("aaa-secrets-v1");
    expect(response.reason).not.toContain("zzz-secrets-v1");
  });
});

describe("evaluateAndEnforceLiveRules: R4 conflict-safety guard (an unmodeled rule fails OPEN)", () => {
  it("does NOT deny when a non-family LIVE rule is present, even though a family rule would deny", async () => {
    seed("secrets-location-v1", familyPayload("secrets"));
    // A REQUIRE rule is exactly the conflict-capable kind section 2.0 warns about; we cannot prove the
    // absence of a conflict, so the whole attempt fails open.
    seed("requires-changelog-v1", familyPayload("anything", { effect: "REQUIRE" as RuleEffect }));

    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("secrets/api-key.md"));

    expect("permissionDecision" in response).toBe(false);
    expect(outcome.kind).toBe("R4_UNSUPPORTED_RULE_KIND");
  });

  it("does NOT deny when an ambient LIVE rule is present", async () => {
    seed("secrets-location-v1", familyPayload("secrets"));
    seed("ambient-policy-v1", familyPayload("secrets", { applicability: { mode: "ambient" } }));

    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("secrets/api-key.md"));

    expect("permissionDecision" in response).toBe(false);
    expect(outcome.kind).toBe("R4_UNSUPPORTED_RULE_KIND");
  });
});

describe("evaluateAndEnforceLiveRules: a provably INERT LIVE rule coexists without disarming the deny", () => {
  it("still denies the family violation when an inert CE0 RECORD_ONLY rule is also LIVE in scope", async () => {
    // THE coexistence proof (generalized-R4, P0.13). Before the fix, the CE0 rule is out-of-family and
    // fails the WHOLE attempt open, silently disarming the live notes-location DENY pilot. After it, the
    // CE0 rule is recognized as imposing no effect (RECORD_ONLY ceiling => cannot conflict with a PROHIBIT
    // deny) and is SKIPPED, so the family rule still denies. The seeded payload is the ACTUAL shipped CE0
    // rule, so this also pins the dispatch to the real bytes a future mint would write.
    seed("notes-location-v1", familyPayload("notes"));
    seedRaw("consult-evidence", CONSULT_EVIDENCE_RULE_PAYLOAD);

    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("notes/scratch.md"));

    if (response.permissionDecision !== "deny") throw new Error("expected a deny response");
    expect(response.reason).toContain("notes-location-v1");
    expect(outcome.kind).toBe("DENIED");
  });

  it("reports ONLY_INERT_RULES (a distinct observe-fallback trigger) when ONLY an inert rule is LIVE", async () => {
    // An inert rule is not an ENFORCEABLE armed rule, so the enforce path has nothing to enforce and must
    // hand off to the R0 observe substrate exactly as an empty scope would. It must NOT fail open R4. The
    // outcome is ONLY_INERT_RULES, not NO_LIVE_VERSION: the scope is NOT empty (an inert rule IS live), so
    // reporting "no live version" would be an audit lie. Both kinds trigger the observe fallback, but the
    // audit trail must record which of the two actually occurred.
    seedRaw("consult-evidence", CONSULT_EVIDENCE_RULE_PAYLOAD);

    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("notes/scratch.md"));

    expect("permissionDecision" in response).toBe(false);
    expect(outcome.kind).toBe("ONLY_INERT_RULES");
  });

  it("still fails OPEN when a ce0-rule-v1 rule carries an AUTO_CORRECT ceiling (wiring respects the ceiling, not the schema)", async () => {
    // Wiring guard: a near-miss with the inert SCHEMA but a non-inert CEILING is enforcing, not inert, so
    // the dispatch must NOT skip it. This proves the dispatch routes through the ceiling-proof predicate
    // rather than a sloppier "schema looks like CE0 => skip" shortcut that would let an enforcing rule slip
    // past the R4 conflict guard.
    seed("notes-location-v1", familyPayload("notes"));
    seedRaw("steering-rule", { schemaVersion: "ce0-rule-v1", responseCeiling: "AUTO_CORRECT" });

    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("notes/scratch.md"));

    expect("permissionDecision" in response).toBe(false);
    expect(outcome.kind).toBe("R4_UNSUPPORTED_RULE_KIND");
  });
});

describe("evaluateAndEnforceLiveRules: pass-through semantics", () => {
  it("passes through (NOT_APPLICABLE) when no LIVE family rule's matcher selects the target", async () => {
    seed("notes-location-v1", familyPayload("notes"));
    seed("secrets-location-v1", familyPayload("secrets"));

    // The matcher glob is "*.md"; a ".ts" write is selected by no rule, so every rule is NOT_APPLICABLE.
    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("src/widget.ts"));

    expect("permissionDecision" in response).toBe(false);
    expect(outcome.kind).toBe("NOT_APPLICABLE");
  });

  it("reports NO_LIVE_VERSION when the scope has no LIVE rule (the observe-fallback trigger)", async () => {
    const { response, outcome } = await evaluateAndEnforceLiveRules(store, input("secrets/api-key.md"));

    expect("permissionDecision" in response).toBe(false);
    expect(outcome.kind).toBe("NO_LIVE_VERSION");
  });
});

/** Find the single tool_attempt whose version-arm evaluation binds the given ruleVersionId. */
function findAttemptForVersion(s: Ce0Store, ruleVersionId: string) {
  const rows = s.db
    .prepare(`SELECT attempt_id FROM rule_evaluation_record WHERE rule_version_id = ?`)
    .all(ruleVersionId) as { attempt_id: string }[];
  expect(rows.length).toBe(1);
  return getToolAttempt(s, rows[0].attempt_id);
}
