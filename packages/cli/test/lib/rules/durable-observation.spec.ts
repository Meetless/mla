import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import { getToolAttempt, getRuleEvaluationRecord, listEvaluationsForAttempt } from "../../../src/lib/rules/interception-store";
import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
  verdictFromEvaluationInput,
  recordR0Observation,
  observeAndRecordNotesRule,
  type R0PersistenceContext,
} from "../../../src/lib/rules/durable-observation";
import { serializeEvaluationInput, evaluationInputHash, type EvaluationInputV1, type EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import { serializeObservedRule, observedRuleHash } from "../../../src/lib/rules/observed-rule-hash";
import { type ObservedRuleSpec } from "../../../src/lib/rules/types";
import { type RandInt32 } from "../../../src/lib/rules/ulid";
import { type Directive } from "../../../src/lib/scanner/types";

// Persistence slice 3 (durable R0 observation), proposal §10.1: on an applicable interception,
// mint two local ULIDs, persist one tool_attempt (carrying the canonical evaluation-input-v1
// snapshot + hash) and one observed-arm rule_evaluation_record in ONE transaction, then return.
// The persisted verdict is derived PURELY from the stored target (verdictFromEvaluationInput),
// so a later replay over the snapshot alone reproduces it byte-for-byte. observe never grants:
// the attempt is always NO_DECISION / NOT_APPLICABLE deny status and the eval arm is OBSERVE/OBSERVE.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-observation-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const FORBIDDEN_ROOT = "notes";

function notesSpec(over: Partial<ObservedRuleSpec> = {}): ObservedRuleSpec {
  return {
    text: "Notes go in the standalone vault, not the repo.",
    applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
    effect: "PROHIBIT",
    forbiddenRootRelativePath: FORBIDDEN_ROOT,
    ...over,
  };
}

// A deterministic ULID randomness source: a counter so two ulids in one call differ.
function counterRand(): RandInt32 {
  let n = 0;
  return () => n++ % 32;
}

function ctx(over: Partial<R0PersistenceContext> = {}): R0PersistenceContext {
  return {
    runtimeScopeId: "scope_a",
    sessionId: "sess_1",
    createdAt: "2026-06-19T00:00:00.000Z",
    now: 1718700000000,
    rand: counterRand(),
    ...over,
  };
}

describe("verdictFromEvaluationInput: the snapshot-pure verdict (the replay rule)", () => {
  it("RUNTIME_RELATIVE under the forbidden root is a VIOLATION", () => {
    expect(verdictFromEvaluationInput({ kind: "RUNTIME_RELATIVE", path: "notes/x.md" }, FORBIDDEN_ROOT)).toEqual({
      result: "VIOLATION",
      verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });

  it("RUNTIME_RELATIVE equal to the forbidden root itself is a VIOLATION", () => {
    expect(verdictFromEvaluationInput({ kind: "RUNTIME_RELATIVE", path: "notes" }, FORBIDDEN_ROOT).result).toBe("VIOLATION");
  });

  it("a sibling of the forbidden root is COMPLIANT (boundary-correct prefix)", () => {
    expect(verdictFromEvaluationInput({ kind: "RUNTIME_RELATIVE", path: "notes-archive/x.md" }, FORBIDDEN_ROOT)).toEqual({
      result: "COMPLIANT",
      verdictReasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
    });
  });

  it("a runtime-relative path elsewhere is COMPLIANT", () => {
    expect(verdictFromEvaluationInput({ kind: "RUNTIME_RELATIVE", path: "src/app/main.md" }, FORBIDDEN_ROOT).result).toBe("COMPLIANT");
  });

  it("OUTSIDE_RUNTIME_SCOPE is COMPLIANT (not under the forbidden root)", () => {
    expect(verdictFromEvaluationInput({ kind: "OUTSIDE_RUNTIME_SCOPE" }, FORBIDDEN_ROOT)).toEqual({
      result: "COMPLIANT",
      verdictReasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
    });
  });

  it("UNKNOWN degrades to UNKNOWN, never a verdict", () => {
    expect(
      verdictFromEvaluationInput({ kind: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" }, FORBIDDEN_ROOT),
    ).toEqual({ result: "UNKNOWN", verdictReasonCode: "CANONICALIZATION_FAILED" });
  });
});

describe("the version constants equal the Slice 4 golden corpus values", () => {
  it("pins the evaluation-input-v1 version triple", () => {
    expect(EVALUATOR_CONTRACT_VERSION).toBe("four-state-evaluator-v1");
    expect(MATCHER_SCHEMA_VERSION).toBe("action-applicability-v1");
    expect(PATH_CANONICALIZER_VERSION).toBe("notes-path-v1");
  });
});

describe("recordR0Observation persists the two-record R0 observation atomically", () => {
  const target: EvaluationTarget = { kind: "RUNTIME_RELATIVE", path: "notes/x.md" };

  function expectedInput(): EvaluationInputV1 {
    return {
      toolName: "Write",
      target,
      forbiddenRootRelativePath: FORBIDDEN_ROOT,
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
    };
  }

  it("mints two distinct ULIDs and returns the snapshot-pure verdict", () => {
    const res = recordR0Observation(store, { toolName: "Write", target, spec: notesSpec() }, ctx());
    expect(res.attemptId).toHaveLength(26);
    expect(res.evaluationId).toHaveLength(26);
    expect(res.attemptId).not.toBe(res.evaluationId);
    expect(res.result).toBe("VIOLATION");
    expect(res.verdictReasonCode).toBe("FORBIDDEN_PATH_MATCH");
  });

  it("writes exactly one tool_attempt carrying the canonical snapshot + hash, observe-never-grants", () => {
    const res = recordR0Observation(store, { toolName: "Write", target, spec: notesSpec() }, ctx());
    const att = getToolAttempt(store, res.attemptId);
    expect(att).not.toBeNull();
    expect(att?.runtimeScopeId).toBe("scope_a");
    expect(att?.sessionId).toBe("sess_1");
    expect(att?.toolName).toBe("Write");
    expect(att?.evaluationInputSnapshot).toBe(serializeEvaluationInput(expectedInput()));
    expect(att?.evaluationInputHash).toBe(evaluationInputHash(expectedInput()));
    expect(att?.aggregateDecision).toBe("NO_DECISION");
    expect(att?.denyEmissionStatus).toBe("NOT_APPLICABLE");
    expect(att?.inputAuthorityConfigHash).toBeNull();
    expect(att?.createdAt).toBe("2026-06-19T00:00:00.000Z");
  });

  it("writes exactly one observed-arm rule_evaluation_record (OBSERVE/OBSERVE, no version arm)", () => {
    const res = recordR0Observation(store, { toolName: "Write", target, spec: notesSpec() }, ctx());
    const evals = listEvaluationsForAttempt(store, res.attemptId);
    expect(evals).toHaveLength(1);
    const ev = evals[0];
    expect(ev.result).toBe("VIOLATION");
    expect(ev.verdictReasonCode).toBe("FORBIDDEN_PATH_MATCH");
    expect(ev.eligibleEnforcement).toBe("OBSERVE");
    expect(ev.effectiveEnforcement).toBe("OBSERVE");
    expect(ev.evaluatorContractVersion).toBe(EVALUATOR_CONTRACT_VERSION);
    expect(ev.observedRuleSnapshot).toBe(serializeObservedRule(notesSpec()));
    expect(ev.observedRuleHash).toBe(observedRuleHash(notesSpec()));
    expect(ev.ruleVersionId).toBeNull();
    expect(ev.canonicalPayloadHash).toBeNull();
    expect(ev.runtimeScopeId).toBe(att(res.attemptId)?.runtimeScopeId);
  });

  it("persists the COMPLIANT arm for a path outside the forbidden root", () => {
    const res = recordR0Observation(
      store,
      { toolName: "Edit", target: { kind: "RUNTIME_RELATIVE", path: "src/app/main.md" }, spec: notesSpec() },
      ctx(),
    );
    expect(res.result).toBe("COMPLIANT");
    expect(getRuleEvaluationRecord(store, res.evaluationId)?.result).toBe("COMPLIANT");
  });

  function att(attemptId: string) {
    return getToolAttempt(store, attemptId);
  }
});

describe("observeAndRecordNotesRule: the durable PreToolUse seam", () => {
  function directive(): Directive {
    return {
      id: "dir_notes",
      text: "Notes go in the standalone vault, not the repo.",
      source: "CLAUDE.md",
      kind: "RULE",
      strength: "MUST_FOLLOW",
      attestation: "human_attested",
    };
  }

  function stdin(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: "sess_1",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "notes/x.md", content: "hi" },
      ...over,
    });
  }

  // An injected runtime classifier so the seam test never touches the filesystem.
  // It echoes the raw path back as a runtime-relative one; the forbidden-root verdict
  // is then derived purely from that path by verdictFromEvaluationInput.
  const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
    kind: "RUNTIME_RELATIVE",
    path: String(rawFilePath),
  });

  function input(over: Partial<Parameters<typeof observeAndRecordNotesRule>[1]> = {}) {
    return {
      rawStdin: stdin(),
      directives: [directive()],
      runtimeProjectRoot: "/runtime/root",
      runtimeScopeId: "scope_a",
      createdAt: "2026-06-19T00:00:00.000Z",
      now: 1718700000000,
      rand: counterRand(),
      classifyRuntime,
      ...over,
    };
  }

  it("always returns an empty (decision-free) hook response", async () => {
    const { response } = await observeAndRecordNotesRule(store, input());
    expect(response).toEqual({});
  });

  it("persists a row for an applicable, matching interception", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, input());
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind === "PERSISTED") {
      expect(outcome.result).toBe("VIOLATION");
      expect(getToolAttempt(store, outcome.attemptId)).not.toBeNull();
    }
  });

  it("persists NOTHING when no notes-location rule is declared", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, input({ directives: [] }));
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("persists NOTHING when the tool is not Write/Edit", async () => {
    const { outcome } = await observeAndRecordNotesRule(
      store,
      input({ rawStdin: stdin({ tool_name: "Bash", tool_input: { command: "ls" } }) }),
    );
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("persists NOTHING when the file is not Markdown (glob non-match)", async () => {
    const { outcome } = await observeAndRecordNotesRule(
      store,
      input({ rawStdin: stdin({ tool_input: { file_path: "notes/x.txt" } }) }),
    );
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("surfaces malformed stdin as INFRA and persists NOTHING", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, input({ rawStdin: "not json" }));
    expect(outcome.kind).toBe("INFRA");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });

  it("surfaces a missing session_id as INFRA and persists NOTHING (no fabricated identity)", async () => {
    const raw = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "notes/x.md" } });
    const { outcome } = await observeAndRecordNotesRule(store, input({ rawStdin: raw }));
    expect(outcome.kind).toBe("INFRA");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get()).toEqual({ n: 0 });
  });
});
