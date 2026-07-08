import { canonicalize, sha256Hex, type CanonicalObject } from "./canonical-json";
import {
  MEMORY_REQUIREMENT_CLASSIFIER_VERSION,
  MEMORY_REQUIREMENT_MARKER_SET_VERSION,
  MEMORY_REQUIREMENT_EXCLUSION_SET_VERSION,
} from "./memory-requirement";
import {
  REQUIREMENT_SUBJECT_EXTRACTOR_VERSION,
  SUBJECT_FINGERPRINT_SCHEMA_VERSION,
  SUBJECT_STOPWORD_SET_VERSION,
} from "./requirement-subject";

/**
 * The ONE CE0 rule the forcing function records against:
 * CONSULT_GOVERNED_EVIDENCE_ON_MEMORY_REQUIRED_TURN_V1
 * (notes/20260617-evidence-consultation-forcing-function-proposal.md §1.3).
 *
 * This is NOT a second obligation framework. The canonical Rules primitive
 * (types.ts / applicability.ts, commit 7cdbee1a) models PreToolUse ACTION gates;
 * its "turn" mode is explicitly inert there. The turn-scoped obligation lives as the
 * TurnRuleObligation record, created by the prompt-submit adapter and STAMPED with
 * this module's frozen identity. This file only pins that identity; it owns no
 * lifecycle and selects nothing.
 *
 * THE RESPONSE CEILING is RECORD_ONLY for CE0 and CE1: the hook observes and records,
 * it NEVER injects, steers, asks, or denies. Raising the ceiling to AUTO_CORRECT is a
 * CE2 concern that requires a NEW immutable rule version (a new ruleVersionId) minted
 * after a separate policy ratification, never an in-place edit of this one.
 *
 * THE canonicalPayloadHash binds the obligation to the EXACT compiled rule that
 * produced it: the rule identity plus the live trigger-classifier and subject-extractor
 * seed versions. Because the payload reads those seed constants (it never hand-copies
 * the literals), bumping any seed set rotates this hash, so an obligation is always
 * attributable to a reproducible (classifier, extractor, seed-set) tuple. The digest is
 * sha256 over RFC 8785 canonical JSON, the same discipline as the subject fingerprint.
 */

export const CONSULT_EVIDENCE_RULE_ID = "consult-evidence";
export const CONSULT_EVIDENCE_RULE_VERSION_ID = "consult-evidence@ce0-v1";

/** The CE0/CE1 ceiling. A higher ceiling demands a new immutable rule version. */
export type ObligationResponseCeiling = "RECORD_ONLY" | "AUTO_CORRECT";
export const CONSULT_EVIDENCE_RESPONSE_CEILING: ObligationResponseCeiling = "RECORD_ONLY";

/** The closed, hashable identity of the compiled rule. All fields are strings; the seed
 * versions are read from their owning modules so the payload cannot drift from the
 * classifier / extractor actually wired into the adapter. */
export const CONSULT_EVIDENCE_RULE_PAYLOAD: CanonicalObject = {
  schemaVersion: "ce0-rule-v1",
  ruleId: CONSULT_EVIDENCE_RULE_ID,
  ruleVersionId: CONSULT_EVIDENCE_RULE_VERSION_ID,
  responseCeiling: CONSULT_EVIDENCE_RESPONSE_CEILING,
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
};

/** sha256(RFC 8785 canonical JSON of the rule payload). Stamped on every obligation as
 * its canonicalPayloadHash so the obligation attests which compiled rule produced it. */
export const CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH = sha256Hex(
  canonicalize(CONSULT_EVIDENCE_RULE_PAYLOAD),
);
