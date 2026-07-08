// The generalized-R4 inert-family registry. The live PreToolUse enforce dispatch (enforce-notes-version.ts)
// loads EVERY live rule in scope and must decide what each one means for the attempt. Today it knows two
// answers: a rule it can face (the PROHIBIT forbidden-root family) or "I do not understand this", which
// fails the WHOLE attempt open. That binary is too coarse: it cannot tell a genuinely unknown rule apart
// from a rule it understands well enough to prove imposes NO effect on a tool attempt.
//
// This module owns that third answer. A rule is INERT-NON-ENFORCING when its maximum authority on a tool
// attempt is RECORD_ONLY: it observes and records, it never injects, steers, asks, or denies. Per P0.13
// (INV-CONFLICT-NEVER-SILENTLY-DENIES, NT:20260615 consolidated proposal), a conflict is two LIVE rules
// imposing INCOMPATIBLE effects. A rule that imposes no effect at all cannot be incompatible with a
// PROHIBIT's deny, so it is provably non-conflicting and the dispatch is safe to SKIP it rather than fail
// the attempt open. That skip is exactly what lets a CE0 consult-evidence RECORD_ONLY rule coexist in the
// same scope as the live notes-location DENY pilot without disarming it.
//
// SAFETY CONTRACT (why this is recognition, not a wildcard):
//   * POSITIVE: each inert family is named by its EXACT schema tag. An unrecognized schema returns false,
//     so the dispatch's fail-open boundary for the genuinely-unknown is preserved unchanged. The dangerous
//     inversion ("anything we do not understand is inert") is precisely what this must never become.
//   * NARROW: recognizing the schema is necessary but NOT sufficient. Within a recognized family the
//     predicate re-derives that THIS version's response ceiling is RECORD_ONLY. The same ce0-rule-v1 schema
//     can carry an AUTO_CORRECT ceiling (a CE2 concern that steers/injects and demands a new immutable rule
//     version); that version is NOT inert and must NOT be skipped. The ceiling proof, not the schema tag,
//     is the load-bearing safety property.

/** A recognized inert family: its exact schema tag plus the proof that a GIVEN version of it is inert.
 *  The proof receives the already-narrowed object and returns true only when that version imposes no
 *  effect on a tool attempt (its response ceiling is record-only). */
interface InertRuleFamily {
  readonly schemaVersion: string;
  readonly isInertVersion: (payload: Record<string, unknown>) => boolean;
}

/** The closed registry of provably non-enforcing rule families. One entry today: the CE0 consult-evidence
 *  forcing function at its RECORD_ONLY ceiling. New families are added here deliberately, each with its own
 *  ceiling proof; membership is never inferred. */
const INERT_RULE_FAMILIES: readonly InertRuleFamily[] = [
  {
    schemaVersion: "ce0-rule-v1",
    // Inert iff the ceiling is RECORD_ONLY. An AUTO_CORRECT version of the same schema can steer/inject and
    // is therefore enforcing, not inert.
    isInertVersion: (payload) => payload.responseCeiling === "RECORD_ONLY",
  },
];

/**
 * True iff `payload` is a LIVE rule the enforce dispatch can prove imposes NO effect on a tool attempt and
 * may therefore SKIP (treat as inert) instead of failing the attempt open. Returns false for anything
 * unrecognized, so an unknown rule still trips the dispatch's fail-open boundary. See the safety contract
 * above: recognition is positive (exact schema) AND narrow (per-version ceiling proof).
 */
export function isInertNonEnforcingRule(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const obj = payload as Record<string, unknown>;
  const family = INERT_RULE_FAMILIES.find((f) => f.schemaVersion === obj.schemaVersion);
  return family ? family.isInertVersion(obj) : false;
}
