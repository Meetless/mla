import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  getTurnMemoryAssessment,
  getTurnRuleObligation,
  type Ce0Store,
} from "../../../src/lib/rules/ce0-store";
import {
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_RULE_VERSION_ID,
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
} from "../../../src/lib/rules/ce0-rule";
import { buildRequiredSubjectFromPrompt } from "../../../src/lib/rules/requirement-subject";
import { samplingBucketFor } from "../../../src/lib/rules/ce0-sampling-bucket";
import { sha256Hex } from "../../../src/lib/rules/canonical-json";
import { type ConsultEvidenceRuleBinding } from "../../../src/lib/rules/consult-evidence-binding";
import {
  observeUserPromptSubmit,
  parseUserPromptSubmitInput,
  type PromptSubmitAdapterConfig,
} from "../../../src/lib/rules/prompt-submit-adapter";

// Commit 6c: the UserPromptSubmit adapter, the CE0 obligation-creation seam
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §1.3, req 1). It
// mirrors the observe-only PreToolUse adapter's discipline:
//   - It NEVER injects. The response is the empty object on EVERY branch, even when it
//     creates an obligation. RECORD_ONLY (ce0-rule) means observe + record, never steer
//     the turn. additionalContext injection is a deferred CE2 concern.
//   - It NEVER turns an infrastructure problem into anything but INFRA: malformed input,
//     a missing session coordinate, or a persistence failure surface as INFRA with a
//     diagnostic and an empty response, never a thrown error and never a partial write.
//   - Only a REQUIRED turn creates a TurnRuleObligation; NOT_REQUIRED and UNKNOWN turns
//     still record their assessment (memory_requirement_assessed fires per EVERY turn).

let dir: string;
let dbPath: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-prompt-"));
  dbPath = path.join(dir, "ce0.db");
  store = openCe0Store(dbPath);
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const FIXED_NOW = 1718700000000;

/** Deterministic id minting: asm_1, obl_1, asm_2, ... so tests can name the rows. */
function seqIds(): (kind: "assessment" | "obligation") => string {
  const counters = { assessment: 0, obligation: 0 };
  return (kind) => {
    counters[kind] += 1;
    return `${kind === "assessment" ? "asm" : "obl"}_${counters[kind]}`;
  };
}

// The unarmed binding the entrypoint resolves when no LIVE consult-evidence version is attested: the
// frozen compile-time identity. CE0 measures identically armed or unarmed, so the existing assertions
// (which check the constant version id + hash) hold against this default.
const UNARMED_BINDING: ConsultEvidenceRuleBinding = {
  ruleId: CONSULT_EVIDENCE_RULE_ID,
  ruleVersionId: CONSULT_EVIDENCE_RULE_VERSION_ID,
  canonicalPayloadHash: CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  attested: false,
};

function config(over: Partial<PromptSubmitAdapterConfig> = {}): PromptSubmitAdapterConfig {
  return {
    store,
    workspaceId: "ws_abc",
    now: () => FIXED_NOW,
    newId: seqIds(),
    ruleBinding: UNARMED_BINDING,
    ...over,
  };
}

function rowCount(table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const requiredPrompt = "What did we decide about the soft gate enforcement?";

describe("observeUserPromptSubmit: a REQUIRED turn records assessment + obligation", () => {
  it("never injects: the hook response is the empty object even when an obligation is created", () => {
    const { response } = observeUserPromptSubmit(
      { session_id: "sess_1", hook_event_name: "UserPromptSubmit", prompt: requiredPrompt },
      config(),
    );
    expect(response).toEqual({});
    expect(Object.keys(response)).toEqual([]);
  });

  it("classifies REQUIRED, mints the turn, and reports the created obligation", () => {
    const { outcome } = observeUserPromptSubmit(
      { session_id: "sess_1", prompt: requiredPrompt },
      config(),
    );
    expect(outcome).toEqual({
      kind: "ASSESSED",
      requirement: "REQUIRED",
      assessmentId: "asm_1",
      localTurnSequence: 1,
      obligationId: "obl_1",
    });
  });

  it("persists the TurnMemoryAssessment with the classifier verdict and seed versions", () => {
    observeUserPromptSubmit({ session_id: "sess_1", prompt: requiredPrompt }, config());
    const asm = getTurnMemoryAssessment(store, "asm_1");
    expect(asm).toEqual({
      assessmentId: "asm_1",
      workspaceId: "ws_abc",
      sessionId: "sess_1",
      localTurnSequence: 1,
      requirement: "REQUIRED",
      markersMatched: ["what did we decide"],
      exclusionsMatched: [],
      classifierVersion: "raw-prompt-substring-v1",
      markerSetVersion: "seed-v1",
      exclusionSetVersion: "seed-v1",
      createdAt: FIXED_NOW,
      samplingBucket: samplingBucketFor({
        workspaceId: "ws_abc",
        sessionId: "sess_1",
        localTurnSequence: 1,
      }),
      promptHash: sha256Hex(requiredPrompt),
    });
  });

  // R4 P0.1 recall snapshot (proposal lines 287-295): the adapter computes the prompt's
  // identity-only hash at classification and persists it on EVERY assessment, so the offline
  // ce0-export can resolve the prompt for false-negative grading without the SQLite record ever
  // duplicating the raw prompt text. The hash is the prompt's verbatim sha256, content-free.
  it("persists the prompt's identity hash, the verbatim sha256 of the raw prompt", () => {
    observeUserPromptSubmit({ session_id: "sess_1", prompt: requiredPrompt }, config());
    const asm = getTurnMemoryAssessment(store, "asm_1");
    expect(asm?.promptHash).toBe(sha256Hex(requiredPrompt));
    expect(asm?.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists an OPEN obligation stamped with the frozen rule identity and an empty proof set", () => {
    observeUserPromptSubmit({ session_id: "sess_1", prompt: requiredPrompt }, config());
    const obl = getTurnRuleObligation(store, "obl_1");
    expect(obl).toEqual({
      obligationId: "obl_1",
      workspaceId: "ws_abc",
      sessionId: "sess_1",
      localTurnSequence: 1,
      ruleId: CONSULT_EVIDENCE_RULE_ID,
      ruleVersionId: CONSULT_EVIDENCE_RULE_VERSION_ID,
      requiredSubjects: [buildRequiredSubjectFromPrompt(requiredPrompt)],
      subjectSatisfaction: [],
      status: "OPEN",
      stateVersion: 0,
      deadlineClaimedAt: null,
      deadlineClaimedVersion: null,
      responseHash: null,
      outcome: null,
      canonicalPayloadHash: CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
    });
  });

  it("accepts the raw JSON string delivered on stdin, not only a parsed object", () => {
    const raw = JSON.stringify({ session_id: "sess_1", prompt: requiredPrompt });
    const { outcome } = observeUserPromptSubmit(raw, config());
    expect(outcome).toMatchObject({ kind: "ASSESSED", requirement: "REQUIRED", obligationId: "obl_1" });
    expect(getTurnRuleObligation(store, "obl_1")).not.toBeNull();
  });

  it("delegates sequence minting, so a second REQUIRED turn in the session is sequence 2", () => {
    // One shared minter across both turns: the real hook uses unique UUIDs per call, so
    // re-using the deterministic counter here keeps assessment ids distinct across turns.
    const cfg = config();
    observeUserPromptSubmit({ session_id: "sess_1", prompt: requiredPrompt }, cfg);
    const { outcome } = observeUserPromptSubmit({ session_id: "sess_1", prompt: requiredPrompt }, cfg);
    expect(outcome).toMatchObject({ localTurnSequence: 2 });
  });
});

describe("observeUserPromptSubmit: the obligation binds to config.ruleBinding, not a compile-time constant", () => {
  // GAP 3 slice 3: the obligation's identity triple {ruleId, ruleVersionId, canonicalPayloadHash} is
  // stamped from the binding the entrypoint resolved, NOT read from ce0-rule's constants. When an operator
  // has attested a LIVE consult-evidence version, the entrypoint passes its REAL version id (and stored
  // hash); the adapter must stamp exactly those. A distinct sentinel version id + hash here proves the
  // adapter reads the binding rather than the frozen constant (the resolver's hash-invariance is its own
  // concern, tested in consult-evidence-binding.spec.ts).
  const ARMED_BINDING: ConsultEvidenceRuleBinding = {
    ruleId: CONSULT_EVIDENCE_RULE_ID,
    ruleVersionId: "ver_armed_1",
    canonicalPayloadHash: "a".repeat(64),
    attested: true,
  };

  it("stamps the obligation with the armed version id + hash from the binding", () => {
    observeUserPromptSubmit(
      { session_id: "sess_1", prompt: requiredPrompt },
      config({ ruleBinding: ARMED_BINDING }),
    );
    const obl = getTurnRuleObligation(store, "obl_1");
    expect(obl?.ruleId).toBe(CONSULT_EVIDENCE_RULE_ID);
    expect(obl?.ruleVersionId).toBe("ver_armed_1");
    expect(obl?.ruleVersionId).not.toBe(CONSULT_EVIDENCE_RULE_VERSION_ID);
    expect(obl?.canonicalPayloadHash).toBe("a".repeat(64));
  });
});

describe("observeUserPromptSubmit: a REQUIRED turn opens atomically (no half-open assessment)", () => {
  // Force the obligation insert to fail on the SECOND REQUIRED turn by minting a DUPLICATE obligation
  // id while keeping assessment ids distinct. The obligation insert throws on the primary-key collision;
  // the assessment minted in the same turn, and the sequence it consumed, must roll back with it. A
  // REQUIRED assessment left without an obligation to grade would silently undercount the graded
  // obligation set against the assessed-REQUIRED denominator (proposal §1.3 req 1, R4 P0.4).
  function dupObligationIds(): (kind: "assessment" | "obligation") => string {
    let asm = 0;
    return (kind) => (kind === "assessment" ? `asm_${(asm += 1)}` : "obl_dup");
  }

  it("rolls the assessment and the sequence back when the obligation insert fails (INFRA, no orphan)", () => {
    const cfg = config({ newId: dupObligationIds() });
    const first = observeUserPromptSubmit({ session_id: "sess_1", prompt: requiredPrompt }, cfg);
    expect(first.outcome).toMatchObject({ kind: "ASSESSED", obligationId: "obl_dup", localTurnSequence: 1 });

    const second = observeUserPromptSubmit({ session_id: "sess_1", prompt: requiredPrompt }, cfg);
    expect(second.outcome.kind).toBe("INFRA");

    // The half-open assessment must NOT survive: only turn 1's assessment and obligation remain.
    expect(rowCount("turn_memory_assessment")).toBe(1);
    expect(rowCount("turn_rule_obligation")).toBe(1);

    // The sequence was not consumed by the failed turn: a clean third turn is sequence 2, not 3.
    const third = observeUserPromptSubmit(
      { session_id: "sess_1", prompt: requiredPrompt },
      config({ newId: (k) => (k === "assessment" ? "asm_ok" : "obl_ok") }),
    );
    expect(third.outcome).toMatchObject({ kind: "ASSESSED", localTurnSequence: 2 });
  });
});

describe("observeUserPromptSubmit: NOT_REQUIRED / UNKNOWN turns record only the assessment", () => {
  it("records a NOT_REQUIRED assessment and creates NO obligation", () => {
    const { response, outcome } = observeUserPromptSubmit(
      { session_id: "sess_1", prompt: "What is a soft gate?" },
      config(),
    );
    expect(response).toEqual({});
    expect(outcome).toEqual({
      kind: "ASSESSED",
      requirement: "NOT_REQUIRED",
      assessmentId: "asm_1",
      localTurnSequence: 1,
      obligationId: null,
    });
    expect(getTurnMemoryAssessment(store, "asm_1")?.requirement).toBe("NOT_REQUIRED");
    expect(rowCount("turn_rule_obligation")).toBe(0);
  });

  it("records an UNKNOWN assessment and creates NO obligation", () => {
    const { outcome } = observeUserPromptSubmit(
      { session_id: "sess_1", prompt: "Refactor the prompt parser into smaller helpers" },
      config(),
    );
    expect(outcome).toMatchObject({ kind: "ASSESSED", requirement: "UNKNOWN", obligationId: null });
    expect(rowCount("turn_rule_obligation")).toBe(0);
  });
});

describe("observeUserPromptSubmit: infrastructure problems never become writes or throws", () => {
  it("maps malformed (unparseable) input to INFRA, an empty response, and zero writes", () => {
    const { response, outcome } = observeUserPromptSubmit("not json at all", config());
    expect(response).toEqual({});
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "malformed hook input" });
    expect(rowCount("turn_memory_assessment")).toBe(0);
    expect(rowCount("turn_rule_obligation")).toBe(0);
  });

  it("maps a payload with no string prompt to INFRA and zero writes", () => {
    expect(observeUserPromptSubmit({ session_id: "sess_1" }, config()).outcome).toEqual({
      kind: "INFRA",
      diagnostic: "malformed hook input",
    });
    expect(observeUserPromptSubmit({ session_id: "sess_1", prompt: 123 }, config()).outcome.kind).toBe(
      "INFRA",
    );
    expect(rowCount("turn_memory_assessment")).toBe(0);
  });

  it("maps a missing session coordinate to INFRA (no coordinate to mint) and zero writes", () => {
    const { response, outcome } = observeUserPromptSubmit({ prompt: requiredPrompt }, config());
    expect(response).toEqual({});
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "missing session_id coordinate" });
    expect(rowCount("turn_memory_assessment")).toBe(0);
    expect(rowCount("turn_rule_obligation")).toBe(0);
  });
});

describe("parseUserPromptSubmitInput: defensive shape gate", () => {
  it("returns null for unparseable strings, non-objects, and a missing / non-string prompt", () => {
    expect(parseUserPromptSubmitInput("{not json")).toBeNull();
    expect(parseUserPromptSubmitInput(42)).toBeNull();
    expect(parseUserPromptSubmitInput(null)).toBeNull();
    expect(parseUserPromptSubmitInput({ session_id: "s" })).toBeNull();
    expect(parseUserPromptSubmitInput({ prompt: "" })).toBeNull();
    expect(parseUserPromptSubmitInput({ prompt: 5 })).toBeNull();
  });

  it("returns the normalized input for a well-formed payload, string or object", () => {
    expect(parseUserPromptSubmitInput({ session_id: "s", prompt: "hi" })).toEqual({
      session_id: "s",
      transcript_path: undefined,
      cwd: undefined,
      hook_event_name: undefined,
      prompt: "hi",
    });
    expect(parseUserPromptSubmitInput(JSON.stringify({ prompt: "hi" }))?.prompt).toBe("hi");
  });
});
