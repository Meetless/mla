import { canonicalize, sha256Hex } from "../../../src/lib/rules/canonical-json";
import {
  MEMORY_REQUIREMENT_CLASSIFIER_VERSION,
  MEMORY_REQUIREMENT_MARKER_SET_VERSION,
  MEMORY_REQUIREMENT_EXCLUSION_SET_VERSION,
} from "../../../src/lib/rules/memory-requirement";
import {
  REQUIREMENT_SUBJECT_EXTRACTOR_VERSION,
  SUBJECT_FINGERPRINT_SCHEMA_VERSION,
  SUBJECT_STOPWORD_SET_VERSION,
} from "../../../src/lib/rules/requirement-subject";
import {
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_RULE_VERSION_ID,
  CONSULT_EVIDENCE_RESPONSE_CEILING,
  CONSULT_EVIDENCE_RULE_PAYLOAD,
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
} from "../../../src/lib/rules/ce0-rule";

// Commit 6c (rule-identity half): the single CE0 rule the UserPromptSubmit obligation
// is stamped with (notes/20260617-evidence-consultation-forcing-function-proposal.md
// §1.3). This is NOT a second rule engine: the canonical Rules primitive (types.ts /
// applicability.ts) models PreToolUse action gates; "turn" mode is inert there, so the
// turn-scoped obligation is created by the prompt-submit adapter and merely STAMPED with
// this rule's frozen identity + a payload hash that attests which compiled rule produced
// it.

describe("the CE0 consult-evidence rule identity is frozen", () => {
  it("pins the rule id, version, and the RECORD_ONLY response ceiling (CE0/CE1 never AUTO_CORRECT)", () => {
    expect(CONSULT_EVIDENCE_RULE_ID).toBe("consult-evidence");
    expect(CONSULT_EVIDENCE_RULE_VERSION_ID).toBe("consult-evidence@ce0-v1");
    expect(CONSULT_EVIDENCE_RESPONSE_CEILING).toBe("RECORD_ONLY");
  });
});

describe("the canonical payload binds the exact compiled trigger + subject seeds", () => {
  it("reads the live classifier / extractor seed versions, never a hand-copied literal", () => {
    expect(CONSULT_EVIDENCE_RULE_PAYLOAD).toEqual({
      schemaVersion: "ce0-rule-v1",
      ruleId: "consult-evidence",
      ruleVersionId: "consult-evidence@ce0-v1",
      responseCeiling: "RECORD_ONLY",
      trigger: {
        classifierVersion: MEMORY_REQUIREMENT_CLASSIFIER_VERSION,
        markerSetVersion: MEMORY_REQUIREMENT_MARKER_SET_VERSION,
        exclusionSetVersion: MEMORY_REQUIREMENT_EXCLUSION_SET_VERSION,
      },
      subject: {
        extractorVersion: REQUIREMENT_SUBJECT_EXTRACTOR_VERSION,
        fingerprintSchemaVersion: SUBJECT_FINGERPRINT_SCHEMA_VERSION,
        stopwordSetVersion: SUBJECT_STOPWORD_SET_VERSION,
      },
    });
  });
});

describe("the canonicalPayloadHash is the RFC 8785 sha256 of that payload", () => {
  it("is self-consistent with the vendored canonicalizer", () => {
    expect(CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH).toBe(
      sha256Hex(canonicalize(CONSULT_EVIDENCE_RULE_PAYLOAD)),
    );
  });

  it("matches the pinned golden digest (a seed-version drift rotates it)", () => {
    expect(CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH).toBe(
      "360198c32ed56f1082ee08ad5758f0ca88c554edc179119027271532b38c0dc8",
    );
  });
});
