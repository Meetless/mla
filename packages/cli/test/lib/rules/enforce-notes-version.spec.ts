import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  getToolAttempt,
  getRuleEvaluationRecord,
  listEvaluationsForAttempt,
  advanceDenyEmissionToResponseEmitted,
} from "../../../src/lib/rules/interception-store";
import {
  insertLocalRuleVersion,
  supersedeLiveLocalRuleVersion,
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
import {
  evaluateAndEnforceNotesVersion,
  recordDenyDecision,
  type DenyDecisionSubject,
} from "../../../src/lib/rules/enforce-notes-version";
import { type VersionPersistenceContext } from "../../../src/lib/rules/version-evaluation";
import { type RulePayloadV1 } from "../../../src/lib/rules/types";
import { type RandInt32 } from "../../../src/lib/rules/ulid";

// Slice 10 (Phase B.10): the single notes-location pilot DENY (R1-1 through R1-5,
// notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §10.1/§10.2 and the
// deny linearization contract P0.52 lines 1291-1312). The seam dispatches the version-backed
// evaluation, projects eligibility through the attested DENY ceiling, re-resolves input authority
// (P0.58) and the attested path root (P0.63) at every would-be deny, admits, and on an effective DENY
// persists DENY + DECISION_RECORDED, COMMITS, emits permissionDecision: "deny", then advances the row
// to RESPONSE_EMITTED. A gate miss or a generation churn fails OPEN to effective NONE
// (RULE_ENFORCEMENT_UNAVAILABLE), passes the action through, and never denies. Runs against one real
// ce0 database, no mock store; the input-authority resolution is built from the real pure resolver.

let dir: string;
let store: Ce0Store;
let mlaHooksDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "enforce-notes-"));
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

function counterRand(): RandInt32 {
  let n = 0;
  return () => n++ % 32;
}

function ctx(over: Partial<VersionPersistenceContext> = {}): VersionPersistenceContext {
  return {
    runtimeScopeId: PILOT_SCOPE,
    sessionId: "sess_1",
    createdAt: "2026-06-19T00:00:00.000Z",
    now: 1718700000000,
    rand: counterRand(),
    ...over,
  };
}

// Build a real MLA_SOLE_AUTHORITY resolution from the pure resolver: the only Write/Edit PreToolUse
// hook is MLA's managed pre-tool-use.sh.
function mlaSoleAuthority(): InputAuthorityResolution {
  const mlaCommand = path.join(mlaHooksDir, "pre-tool-use.sh");
  const userLayer: HookConfigLayer = {
    name: "user",
    settings: { hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: mlaCommand }] }] } },
  };
  return resolveInputAuthority([userLayer], { mlaHooksDir });
}

// A real UNAVAILABLE resolution: a foreign Write/Edit PreToolUse mutator is also present.
function foreignMutator(): InputAuthorityResolution {
  const foreignLayer: HookConfigLayer = {
    name: "user",
    settings: { hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/other.sh" }] }] } },
  };
  return resolveInputAuthority([foreignLayer], { mlaHooksDir });
}

// An injected runtime classifier so the seam never touches the filesystem: echoes the raw path as a
// runtime-relative target. The forbidden-root verdict is derived purely from it.
const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function stdin(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess_1",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "notes/scratch.md", content: "hi" },
    ...over,
  });
}

function input(over: Partial<Parameters<typeof evaluateAndEnforceNotesVersion>[1]> = {}) {
  return {
    rawStdin: stdin(),
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

describe("evaluateAndEnforceNotesVersion: an admitted deny (R1-1..R1-5 happy path)", () => {
  it("emits permissionDecision: deny with a reason naming the rule and the target", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { response, outcome } = await evaluateAndEnforceNotesVersion(store, input());
    expect(outcome.kind).toBe("DENIED");
    if (response.permissionDecision !== "deny") throw new Error("expected a deny response");
    expect(response.permissionDecision).toBe("deny");
    expect(response.reason).toContain(NOTES_LOCATION_RULE_ID);
    expect(response.reason).toContain("notes/scratch.md");
    expect(response.reason.length).toBeGreaterThan(0);
  });

  it("persists the deny durably and advances DECISION_RECORDED -> RESPONSE_EMITTED (R1-4)", async () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const { outcome } = await evaluateAndEnforceNotesVersion(store, input());
    if (outcome.kind !== "DENIED") throw new Error("expected DENIED");
    const att = getToolAttempt(store, outcome.attemptId);
    expect(att?.aggregateDecision).toBe("DENY");
    expect(att?.denyEmissionStatus).toBe("RESPONSE_EMITTED");
    expect(att?.inputAuthorityConfigHash).toBe(mlaSoleAuthority().configHash);
  });

  it("records the DENY-eligible, DENY-effective version arm with no gate reason (R1-3)", async () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const { outcome } = await evaluateAndEnforceNotesVersion(store, input());
    if (outcome.kind !== "DENIED") throw new Error("expected DENIED");
    const evals = listEvaluationsForAttempt(store, outcome.attemptId);
    expect(evals).toHaveLength(1);
    const ev = evals[0];
    expect(ev.result).toBe("VIOLATION");
    expect(ev.verdictReasonCode).toBe("FORBIDDEN_PATH_MATCH");
    expect(ev.eligibleEnforcement).toBe("DENY");
    expect(ev.effectiveEnforcement).toBe("DENY");
    expect(ev.gateReasonCode).toBeNull();
    expect(ev.ruleVersionId).toBe(version.versionId);
    expect(ev.canonicalPayloadHash).toBe(version.canonicalPayloadHash);
  });
});

describe("evaluateAndEnforceNotesVersion: deny admission fails OPEN, never a silent deny (R1-5)", () => {
  it("a foreign input mutator yields effective NONE / RULE_ENFORCEMENT_UNAVAILABLE and passes through", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { response, outcome } = await evaluateAndEnforceNotesVersion(
      store,
      input({ resolveInputAuthority: () => foreignMutator() }),
    );
    expect(response).toEqual({});
    expect(outcome.kind).toBe("ENFORCEMENT_UNAVAILABLE");
    if (outcome.kind !== "ENFORCEMENT_UNAVAILABLE") throw new Error("unreachable");
    expect(outcome.cause).toBe("INPUT_AUTHORITY");
    const ev = getRuleEvaluationRecord(store, outcome.evaluationId);
    expect(ev?.eligibleEnforcement).toBe("DENY");
    expect(ev?.effectiveEnforcement).toBe("NONE");
    expect(ev?.gateReasonCode).toBe("RULE_ENFORCEMENT_UNAVAILABLE");
    const att = getToolAttempt(store, outcome.attemptId);
    expect(att?.aggregateDecision).toBe("NO_DECISION");
    expect(att?.denyEmissionStatus).toBe("NOT_APPLICABLE");
    expect(att?.inputAuthorityConfigHash).toBe(foreignMutator().configHash);
  });

  it("an unresolvable runtime root yields effective NONE / RULE_ENFORCEMENT_UNAVAILABLE (P0.63)", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { response, outcome } = await evaluateAndEnforceNotesVersion(
      store,
      input({ runtimeProjectRoot: "" }),
    );
    expect(response).toEqual({});
    expect(outcome.kind).toBe("ENFORCEMENT_UNAVAILABLE");
    if (outcome.kind !== "ENFORCEMENT_UNAVAILABLE") throw new Error("unreachable");
    expect(outcome.cause).toBe("PATH_ROOT");
    expect(getRuleEvaluationRecord(store, outcome.evaluationId)?.effectiveEnforcement).toBe("NONE");
  });
});

describe("evaluateAndEnforceNotesVersion: only a would-be deny resolves input authority", () => {
  // The resolver THROWS if invoked: proving the OBSERVE/UNKNOWN paths never touch input-authority IO,
  // i.e. it is resolved at a would-be deny, never speculatively (R1-5 timing).
  const explodingResolver = () => {
    throw new Error("input authority must not be resolved off the deny path");
  };

  it("UNKNOWN never denies and never resolves input authority (R1-3)", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const unknownTarget = async (): Promise<EvaluationTarget> => ({ kind: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" });
    const { response, outcome } = await evaluateAndEnforceNotesVersion(
      store,
      input({ classifyRuntime: unknownTarget, resolveInputAuthority: explodingResolver }),
    );
    expect(response).toEqual({});
    expect(outcome.kind).toBe("OBSERVED");
    if (outcome.kind !== "OBSERVED") throw new Error("unreachable");
    const ev = getRuleEvaluationRecord(store, outcome.evaluationId);
    expect(ev?.result).toBe("UNKNOWN");
    expect(ev?.eligibleEnforcement).toBe("OBSERVE");
    expect(ev?.effectiveEnforcement).toBe("OBSERVE");
    expect(getToolAttempt(store, outcome.attemptId)?.aggregateDecision).toBe("NO_DECISION");
  });

  it("a COMPLIANT path observes, passes through, and never resolves input authority", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { response, outcome } = await evaluateAndEnforceNotesVersion(
      store,
      input({
        rawStdin: stdin({ tool_input: { file_path: "src/app/main.md" } }),
        resolveInputAuthority: explodingResolver,
      }),
    );
    expect(response).toEqual({});
    expect(outcome.kind).toBe("OBSERVED");
    if (outcome.kind !== "OBSERVED") throw new Error("unreachable");
    expect(getRuleEvaluationRecord(store, outcome.evaluationId)?.result).toBe("COMPLIANT");
  });
});

describe("evaluateAndEnforceNotesVersion: skip semantics (nothing persisted)", () => {
  it("reports NO_LIVE_VERSION when nothing is attested for the scope", async () => {
    const { outcome } = await evaluateAndEnforceNotesVersion(store, input());
    expect(outcome).toEqual({ kind: "NO_LIVE_VERSION" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("reports NOT_APPLICABLE for a non-Write/Edit tool", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { outcome } = await evaluateAndEnforceNotesVersion(
      store,
      input({ rawStdin: stdin({ tool_name: "Bash", tool_input: { command: "ls" } }) }),
    );
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("surfaces malformed stdin as INFRA", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { outcome } = await evaluateAndEnforceNotesVersion(store, input({ rawStdin: "not json" }));
    expect(outcome.kind).toBe("INFRA");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });
});

describe("recordDenyDecision: the linearized deny commit (P0.52, R1-1, R1-4)", () => {
  const subject = (version: LocalRuleVersionRecord): DenyDecisionSubject => ({
    toolName: "Write",
    target: { kind: "RUNTIME_RELATIVE", path: "notes/scratch.md" },
    version,
    payload: pilotPayload(),
    result: "VIOLATION",
    verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    inputAuthorityConfigHash: "feedface".repeat(8),
  });

  it("commits the deny at DECISION_RECORDED (the honest pre-emission crash state)", () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const res = recordDenyDecision(store, subject(version), ctx());
    expect(res.committed).toBe(true);
    if (!res.committed) throw new Error("unreachable");
    const att = getToolAttempt(store, res.attemptId);
    expect(att?.aggregateDecision).toBe("DENY");
    expect(att?.denyEmissionStatus).toBe("DECISION_RECORDED");
    expect(att?.inputAuthorityConfigHash).toBe("feedface".repeat(8));
  });

  it("advanceDenyEmissionToResponseEmitted flips DECISION_RECORDED -> RESPONSE_EMITTED", () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const res = recordDenyDecision(store, subject(version), ctx());
    if (!res.committed) throw new Error("unreachable");
    advanceDenyEmissionToResponseEmitted(store, res.attemptId);
    expect(getToolAttempt(store, res.attemptId)?.denyEmissionStatus).toBe("RESPONSE_EMITTED");
  });

  it("a generation churn between evaluation and commit is inadmissible and writes nothing (P0.52)", () => {
    const v1 = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, v1);
    const v2Payload = pilotPayload({ text: "Notes MUST live in the standalone vault (revised)." });
    supersedeLiveLocalRuleVersion(store, liveVersion(v2Payload, { versionId: "ver_2", supersedesVersionId: v1.versionId }));
    // The deny was evaluated against v1, but v1 is no longer the LIVE generation.
    const res = recordDenyDecision(store, subject(v1), ctx());
    expect(res.committed).toBe(false);
    if (res.committed) throw new Error("unreachable");
    expect(res.cause).toBe("GENERATION_CHURN");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });
});

describe("evaluateAndEnforceNotesVersion: a concurrent supersede in the deny window fails open", () => {
  it("churns to effective NONE / GENERATION_CHURN and passes the action through", async () => {
    const v1 = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, v1);
    const beforeDenyCommit = () => {
      const v2Payload = pilotPayload({ text: "Notes MUST live in the standalone vault (revised)." });
      supersedeLiveLocalRuleVersion(store, liveVersion(v2Payload, { versionId: "ver_2", supersedesVersionId: v1.versionId }));
    };
    const { response, outcome } = await evaluateAndEnforceNotesVersion(store, input({ beforeDenyCommit }));
    expect(response).toEqual({});
    expect(outcome.kind).toBe("ENFORCEMENT_UNAVAILABLE");
    if (outcome.kind !== "ENFORCEMENT_UNAVAILABLE") throw new Error("unreachable");
    expect(outcome.cause).toBe("GENERATION_CHURN");
    // No deny row was committed; only the fail-open NONE record exists.
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt WHERE aggregate_decision = 'DENY'").get()).toEqual({ n: 0 });
    expect(getRuleEvaluationRecord(store, outcome.evaluationId)?.effectiveEnforcement).toBe("NONE");
  });
});
