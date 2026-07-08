import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  getToolAttempt,
  getRuleEvaluationRecord,
  listEvaluationsForAttempt,
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
  replayVerdictFromSnapshot,
} from "../../../src/lib/rules/durable-observation";
import {
  serializeEvaluationInput,
  evaluationInputHash,
  type EvaluationInputV1,
  type EvaluationTarget,
} from "../../../src/lib/rules/evaluation-input-hash";
import { serializeRuleVersion, ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { NOTES_LOCATION_RULE_ID } from "../../../src/lib/rules/attest-notes-location";
import {
  versionBackedVerdict,
  recordVersionEvaluation,
  evaluateAndRecordNotesVersion,
  type VersionPersistenceContext,
} from "../../../src/lib/rules/version-evaluation";
import { type RulePayloadV1 } from "../../../src/lib/rules/types";
import { type RandInt32 } from "../../../src/lib/rules/ulid";

// Slice 8 (Phase B.8): version-backed evaluation
// (notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §3.5 / §3.6, the
// version arm of RuleEvaluationRecord). Once a notes-location rule is attested, an interception is
// evaluated against the LIVE LocalRuleVersion's RulePayloadV1 (not the observed rule), and a
// VERSION-arm rule_evaluation_record is written carrying ruleVersionId + canonicalPayloadHash. This
// slice is OBSERVE-only: enforcement stays OBSERVE/OBSERVE and no deny is emitted; the eligible-DENY
// projection and the §10.2 admission gates are deny admission (slice 9). The one enforcement-free
// evaluation behavior added here is honest semantics: if the version declares a compliance triple
// this MLA build cannot reproduce, the verdict degrades to UNKNOWN / EVALUATOR_UNSUPPORTED and never
// reads the path. It runs against one real ce0 database, no mock store.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "version-eval-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const PILOT_SCOPE = "/work/meetless";
const FORBIDDEN_ROOT = "notes";

// The attested payload faced at runtime: the exact §3.6 RulePayloadV1 shape the §2.4 conversion mints
// for the notes-location pilot (DENY ceiling, the supported compliance triple, the *.md matcher).
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

// Serialize a payload into a LIVE LocalRuleVersion row: rule_payload + canonical_payload_hash are the
// real serializer/hash outputs, exactly what the attest verb persists.
function liveVersion(
  payload: RulePayloadV1,
  over: Partial<LocalRuleVersionRecord> = {},
): LocalRuleVersionRecord {
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

// A deterministic ULID randomness source: a counter so two ulids in one call differ.
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

describe("versionBackedVerdict: the verdict from the attested payload", () => {
  it("is a VIOLATION for a runtime-relative path under the version's forbidden root", () => {
    expect(versionBackedVerdict(pilotPayload(), { kind: "RUNTIME_RELATIVE", path: "notes/x.md" })).toEqual({
      result: "VIOLATION",
      verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });

  it("is COMPLIANT for a runtime-relative path outside the forbidden root", () => {
    expect(versionBackedVerdict(pilotPayload(), { kind: "RUNTIME_RELATIVE", path: "src/app/x.md" })).toEqual({
      result: "COMPLIANT",
      verdictReasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
    });
  });

  it("is COMPLIANT for a target outside the runtime scope", () => {
    expect(versionBackedVerdict(pilotPayload(), { kind: "OUTSIDE_RUNTIME_SCOPE" }).result).toBe("COMPLIANT");
  });

  it("is UNKNOWN / CANONICALIZATION_FAILED for an uncanonicalizable target", () => {
    expect(
      versionBackedVerdict(pilotPayload(), { kind: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" }),
    ).toEqual({ result: "UNKNOWN", verdictReasonCode: "CANONICALIZATION_FAILED" });
  });

  it("degrades to UNKNOWN / EVALUATOR_UNSUPPORTED when the evaluator contract version is foreign, even for a would-be violation", () => {
    const foreign = pilotPayload({
      compliance: {
        evaluatorContractVersion: "four-state-evaluator-v2",
        matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
        pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
        config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
      },
    });
    expect(versionBackedVerdict(foreign, { kind: "RUNTIME_RELATIVE", path: "notes/x.md" })).toEqual({
      result: "UNKNOWN",
      verdictReasonCode: "EVALUATOR_UNSUPPORTED",
    });
  });

  it("degrades to UNKNOWN / EVALUATOR_UNSUPPORTED when the matcher or canonicalizer version is foreign", () => {
    const foreignMatcher = pilotPayload({
      compliance: {
        evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
        matcherSchemaVersion: "action-applicability-v2",
        pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
        config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
      },
    });
    const foreignCanon = pilotPayload({
      compliance: {
        evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
        matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
        pathCanonicalizerVersion: "notes-path-v2",
        config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
      },
    });
    expect(versionBackedVerdict(foreignMatcher, { kind: "RUNTIME_RELATIVE", path: "notes/x.md" }).verdictReasonCode).toBe(
      "EVALUATOR_UNSUPPORTED",
    );
    expect(versionBackedVerdict(foreignCanon, { kind: "RUNTIME_RELATIVE", path: "notes/x.md" }).verdictReasonCode).toBe(
      "EVALUATOR_UNSUPPORTED",
    );
  });
});

describe("recordVersionEvaluation: the durable version-arm writer", () => {
  const target: EvaluationTarget = { kind: "RUNTIME_RELATIVE", path: "notes/x.md" };

  it("mints two distinct ULIDs and writes both rows in one transaction", () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const res = recordVersionEvaluation(store, { toolName: "Write", target, version }, ctx());
    expect(res.attemptId).not.toBe(res.evaluationId);
    expect(getToolAttempt(store, res.attemptId)).not.toBeNull();
    expect(getRuleEvaluationRecord(store, res.evaluationId)).not.toBeNull();
  });

  it("writes a tool_attempt that grants nothing (NO_DECISION / NOT_APPLICABLE) with the version's evaluation-input snapshot", () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const res = recordVersionEvaluation(store, { toolName: "Edit", target, version }, ctx());
    const att = getToolAttempt(store, res.attemptId);
    expect(att?.aggregateDecision).toBe("NO_DECISION");
    expect(att?.denyEmissionStatus).toBe("NOT_APPLICABLE");
    expect(att?.inputAuthorityConfigHash).toBeNull();
    expect(att?.toolName).toBe("Edit");
    expect(att?.runtimeScopeId).toBe(PILOT_SCOPE);
    expect(att?.sessionId).toBe("sess_1");

    const expectedInput: EvaluationInputV1 = {
      toolName: "Edit",
      target,
      forbiddenRootRelativePath: FORBIDDEN_ROOT,
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
    };
    expect(att?.evaluationInputSnapshot).toBe(serializeEvaluationInput(expectedInput));
    expect(att?.evaluationInputHash).toBe(evaluationInputHash(expectedInput));
  });

  it("writes exactly one VERSION-arm rule_evaluation_record (ruleVersionId + canonicalPayloadHash, OBSERVE/OBSERVE, no observed arm)", () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const res = recordVersionEvaluation(store, { toolName: "Write", target, version }, ctx());
    const evals = listEvaluationsForAttempt(store, res.attemptId);
    expect(evals).toHaveLength(1);
    const ev = evals[0];
    expect(ev.result).toBe("VIOLATION");
    expect(ev.verdictReasonCode).toBe("FORBIDDEN_PATH_MATCH");
    expect(ev.eligibleEnforcement).toBe("OBSERVE");
    expect(ev.effectiveEnforcement).toBe("OBSERVE");
    expect(ev.gateReasonCode).toBeNull();
    expect(ev.evaluatorContractVersion).toBe(EVALUATOR_CONTRACT_VERSION);
    expect(ev.ruleVersionId).toBe(version.versionId);
    expect(ev.canonicalPayloadHash).toBe(version.canonicalPayloadHash);
    expect(ev.observedRuleSnapshot).toBeNull();
    expect(ev.observedRuleHash).toBeNull();
    expect(res.ruleVersionId).toBe(version.versionId);
    expect(res.canonicalPayloadHash).toBe(version.canonicalPayloadHash);
  });

  it("persists the COMPLIANT version arm for a path outside the forbidden root", () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const res = recordVersionEvaluation(
      store,
      { toolName: "Edit", target: { kind: "RUNTIME_RELATIVE", path: "src/app/main.md" }, version },
      ctx(),
    );
    expect(res.result).toBe("COMPLIANT");
    expect(getRuleEvaluationRecord(store, res.evaluationId)?.result).toBe("COMPLIANT");
  });

  it("persists a snapshot whose R0 replay reproduces the supported-triple verdict", () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const res = recordVersionEvaluation(store, { toolName: "Write", target, version }, ctx());
    const att = getToolAttempt(store, res.attemptId);
    expect(replayVerdictFromSnapshot(att!.evaluationInputSnapshot)).toEqual({
      result: "VIOLATION",
      verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });

  it("records an UNKNOWN / EVALUATOR_UNSUPPORTED version arm for a version declaring a foreign contract, stamping the running evaluator's supported triple on the snapshot", () => {
    // A version whose declared evaluator contract this MLA build cannot reproduce. The verdict is a
    // refusal (UNKNOWN), never a silent application of v1 semantics to a v2 rule. The snapshot still
    // carries the RUNNING supported triple: evaluation-input-v1's triple denotes the evaluator that
    // ran, and the version's declared triple lives in the version payload behind canonicalPayloadHash.
    const foreign = pilotPayload({
      compliance: {
        evaluatorContractVersion: "four-state-evaluator-v2",
        matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
        pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
        config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
      },
    });
    const version = liveVersion(foreign);
    insertLocalRuleVersion(store, version);
    const res = recordVersionEvaluation(store, { toolName: "Write", target, version }, ctx());
    expect(res.result).toBe("UNKNOWN");
    const ev = getRuleEvaluationRecord(store, res.evaluationId);
    expect(ev?.verdictReasonCode).toBe("EVALUATOR_UNSUPPORTED");
    expect(ev?.eligibleEnforcement).toBe("OBSERVE");
    expect(ev?.effectiveEnforcement).toBe("OBSERVE");
    expect(ev?.evaluatorContractVersion).toBe(EVALUATOR_CONTRACT_VERSION);
    expect(ev?.canonicalPayloadHash).toBe(version.canonicalPayloadHash);
    const att = getToolAttempt(store, res.attemptId);
    expect(att?.evaluationInputSnapshot).toContain(EVALUATOR_CONTRACT_VERSION);
    expect(att?.evaluationInputSnapshot).not.toContain("four-state-evaluator-v2");
  });
});

describe("evaluateAndRecordNotesVersion: the version-backed PreToolUse seam", () => {
  // An injected runtime classifier so the seam test never touches the filesystem. It echoes the raw
  // path back as a runtime-relative one; the forbidden-root verdict is derived purely from it.
  const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
    kind: "RUNTIME_RELATIVE",
    path: String(rawFilePath),
  });

  function stdin(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: "sess_1",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "notes/x.md", content: "hi" },
      ...over,
    });
  }

  function input(over: Partial<Parameters<typeof evaluateAndRecordNotesVersion>[1]> = {}) {
    return {
      rawStdin: stdin(),
      runtimeProjectRoot: "/runtime/root",
      runtimeScopeId: PILOT_SCOPE,
      createdAt: "2026-06-19T00:00:00.000Z",
      now: 1718700000000,
      rand: counterRand(),
      classifyRuntime,
      ...over,
    };
  }

  it("always returns an empty (decision-free) hook response", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { response } = await evaluateAndRecordNotesVersion(store, input());
    expect(response).toEqual({});
  });

  it("records nothing and reports NO_LIVE_VERSION when no version is attested for the scope", async () => {
    const { outcome } = await evaluateAndRecordNotesVersion(store, input());
    expect(outcome).toEqual({ kind: "NO_LIVE_VERSION" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("evaluates against the LIVE version and records the version arm for an applicable interception", async () => {
    const version = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, version);
    const { outcome } = await evaluateAndRecordNotesVersion(store, input());
    expect(outcome.kind).toBe("RECORDED");
    if (outcome.kind === "RECORDED") {
      expect(outcome.result).toBe("VIOLATION");
      expect(outcome.ruleVersionId).toBe(version.versionId);
      expect(outcome.canonicalPayloadHash).toBe(version.canonicalPayloadHash);
      expect(getRuleEvaluationRecord(store, outcome.evaluationId)?.ruleVersionId).toBe(version.versionId);
    }
  });

  it("records nothing for a non-Write/Edit tool", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { outcome } = await evaluateAndRecordNotesVersion(
      store,
      input({ rawStdin: stdin({ tool_name: "Bash", tool_input: { command: "ls" } }) }),
    );
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("records nothing for a non-Markdown file (glob non-match)", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { outcome } = await evaluateAndRecordNotesVersion(
      store,
      input({ rawStdin: stdin({ tool_input: { file_path: "notes/x.txt" } }) }),
    );
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("surfaces malformed stdin as INFRA and records nothing", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const { outcome } = await evaluateAndRecordNotesVersion(store, input({ rawStdin: "not json" }));
    expect(outcome.kind).toBe("INFRA");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("surfaces a missing session_id as INFRA and records nothing (no fabricated identity)", async () => {
    insertLocalRuleVersion(store, liveVersion(pilotPayload()));
    const raw = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "notes/x.md" } });
    const { outcome } = await evaluateAndRecordNotesVersion(store, input({ rawStdin: raw }));
    expect(outcome.kind).toBe("INFRA");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("faces the LIVE successor after a supersession, never the superseded predecessor", async () => {
    const v1 = liveVersion(pilotPayload());
    insertLocalRuleVersion(store, v1);
    // Attest an edited successor (different text -> different payload + hash) and supersede v1.
    const v2Payload = pilotPayload({ text: "Notes MUST live in the standalone vault (revised)." });
    const v2 = supersedeLiveLocalRuleVersion(
      store,
      liveVersion(v2Payload, { versionId: "ver_2", supersedesVersionId: v1.versionId }),
    );
    const { outcome } = await evaluateAndRecordNotesVersion(store, input());
    expect(outcome.kind).toBe("RECORDED");
    if (outcome.kind === "RECORDED") {
      expect(outcome.ruleVersionId).toBe("ver_2");
      expect(outcome.canonicalPayloadHash).toBe(v2.canonicalPayloadHash);
      expect(outcome.canonicalPayloadHash).not.toBe(v1.canonicalPayloadHash);
    }
  });
});
