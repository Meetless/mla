import { canonicalize } from "./canonical-json";
import {
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_RULE_PAYLOAD,
} from "./ce0-rule";

// The code-rule registry: the small, closed table of rules the PRODUCT ships in source (their payload
// is frozen in code, never observed from a directive scan). It exists so an operator can attest such a
// rule onto a durable LocalRuleVersion row WITHOUT re-expressing it as a forbidden-root RulePayloadV1
// (which a turn-scoped, RECORD_ONLY rule like CE0 consult-evidence is not, and cannot be).
//
// The repo (local-rule-version-repo.ts) stores rule_payload + canonical_payload_hash as OPAQUE strings;
// this registry is the SOLE place a code rule's bytes and its plain-sha256 digest are paired. The digest
// is the SAME one the rest of the system already stamps on its obligations (e.g.
// CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH): a plain sha256 over the RFC 8785 canonical JSON, NOT the
// domain-separated rule-version-v1 hash the forbidden-root family uses. Storing that exact hash is what
// keeps a future rebind of the live adapters onto the minted row a clean byte-for-byte swap.

/** A rule whose payload is defined in source, resolved to the opaque pair the repo stores verbatim. */
export interface CodeRuleDefinition {
  /** The logical rule id, stable across versions of the same rule. */
  ruleId: string;
  /** The RFC 8785 canonical-JSON serialization of the frozen payload. Opaque to the repo. */
  serializedPayload: string;
  /** Plain sha256 over `serializedPayload` (NO domain tag): the exact hash obligations are stamped with. */
  canonicalPayloadHash: string;
}

/** The closed registry, keyed by code-rule name. Adding a rule here is the only way to enroll one. */
const CODE_RULES: Readonly<Record<string, CodeRuleDefinition>> = {
  [CONSULT_EVIDENCE_RULE_ID]: {
    ruleId: CONSULT_EVIDENCE_RULE_ID,
    serializedPayload: canonicalize(CONSULT_EVIDENCE_RULE_PAYLOAD),
    canonicalPayloadHash: CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  },
};

/** Resolve a code-rule by name; null when no such rule ships in source (never fabricates one). */
export function getCodeRule(name: string): CodeRuleDefinition | null {
  return CODE_RULES[name] ?? null;
}
