// Schema-independent R0 core for "rules as node and action interception"
// (notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md).
//
// This module declares ONLY the in-memory shapes the pure logic operates on. It
// deliberately contains no persistence, no SQLite rows, no deny behavior, and no
// rollout state: those are the documented seam left for a later slice. Everything
// here is the value-level contract the parser, selector, evaluator, and the
// observe-only adapter agree on.

/** A Claude Code tool name as it appears in the hook payload, e.g. "Write". */
export type ToolName = string;

/**
 * Narrows an action rule to a specific field of the tool input and, optionally,
 * a glob the field value must match for the rule to apply. The matcher is pure
 * data: it names WHICH field carries the path and WHICH shape it must have. It
 * carries no policy and performs no I/O.
 */
export interface PathOrArgMatcher {
  /** The tool-input field carrying the value, e.g. "file_path". */
  field: string;
  /**
   * Optional glob the field value must match for the rule to apply. R0 supports
   * a deliberately tiny subset: a leading "*" or "** /" followed by a literal
   * suffix (e.g. "*.md"). Absent means "any value of this field".
   */
  glob?: string;
}

/**
 * A deterministic, LLM-free predicate over the turn envelope that decides whether
 * a `turn`-mode rule is delivered on THIS turn (Layer B, targeted-rule-injection
 * §5.1). It is explicitly NOT intent detection: it is a proxy for intent built from
 * literal prompt keywords and explicit-prompt-path globs. It will fire on "do not
 * write a design doc" (the phrase is present), miss "continue with that" (no
 * keyword), and false-fire on a pasted error that contains "architecture". That is
 * acceptable: the ceiling is OBSERVE, so a wrong trigger is only a wasted-budget
 * soft reminder or a missed one, never a correctness fault. Do NOT call it intent
 * matching anywhere in code.
 *
 * v1 is a closed, tiny struct, NOT a general DSL (there is one consumer, the
 * doctrine-gate delta; a richer language is added only with a second real consumer).
 */
export interface TurnTrigger {
  /**
   * Literal phrases (NOT regex). Matched case-insensitively after whitespace
   * normalization: a phrase hits when it is a substring of the normalized prompt.
   * Any hit fires the trigger.
   */
  promptAny?: string[];
  /**
   * Globs matched ONLY against the paths the user named explicitly in THIS prompt
   * (`extractExplicitPaths(input.prompt)`). NEVER matched against the git working
   * set: dirty-file relevance is Layer A's `.claude/rules` glob concern (§5.3).
   */
  explicitPathAny?: string[];
  // Semantics (enforced by the parser): at least one of the two lists must be
  // non-empty; the trigger fires iff any `promptAny` phrase OR any `explicitPathAny`
  // glob matches (OR, recall over precision).
}

/**
 * The parsed, validated applicability of a rule. Three modes, mapping to the three
 * delivery planes: `ambient` -> FLOOR (every turn, OBSERVE), `action` -> Plane B
 * (preToolUse gate, DENY/ASK), `turn` -> SCOPED injection (best-effort, OBSERVE,
 * delivered only when its {@link TurnTrigger} matches this turn). The grammar is
 * owned by ONE parser (`applicability.ts` `parseApplicability`); other consumers
 * reuse it and, where their contract is narrower, post-check the mode explicitly.
 */
export type RuleApplicability =
  | { mode: "ambient" }
  | { mode: "action"; tools: ToolName[]; matcher: PathOrArgMatcher }
  | { mode: "turn"; trigger: TurnTrigger };

/** Outcome class of parsing a raw applicability descriptor. */
export type ApplicabilityParseStatus = "OK" | "INVALID" | "DISABLED";

/**
 * Result of {@link parseApplicability}. `applicability` is present iff status is
 * "OK". `diagnostic` is present iff status is "INVALID" or "DISABLED".
 */
export interface ApplicabilityParseResult {
  status: ApplicabilityParseStatus;
  applicability?: RuleApplicability;
  diagnostic?: string;
}

/**
 * The four-state evaluation result. NOT_APPLICABLE is selector-internal: it is
 * never persisted and never emitted as a verdict (the selector simply produces
 * no evaluation output for non-matching rules). Of the remaining three, only
 * VIOLATION is potentially enforcement-eligible; UNKNOWN must never ask or deny.
 */
export type RuleEvaluation = "NOT_APPLICABLE" | "COMPLIANT" | "VIOLATION" | "UNKNOWN";

/**
 * The effect a rule asserts when violated. There is deliberately NO general
 * ALLOW: rules constrain, they do not grant.
 */
export type RuleEffect = "PROHIBIT" | "REQUIRE" | "REQUIRE_APPROVAL";

/**
 * Result of classifying a concrete target path against a configured forbidden
 * root. INDETERMINATE means canonicalization or comparison could not be proven
 * (it must degrade to UNKNOWN, never to a verdict). Computed by the I/O path
 * matcher and consumed by the pure evaluator.
 */
export type PathClassification =
  | "UNDER_FORBIDDEN_ROOT"
  | "OUTSIDE_FORBIDDEN_ROOT"
  | "INDETERMINATE";

/** Machine-readable reason attached to a verdict for reporting and the seam. */
export type VerdictReasonCode =
  | "FORBIDDEN_PATH_MATCH"
  | "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT"
  | "COMPLIANT_NO_MATCH"
  | "EVALUATOR_UNSUPPORTED"
  | "CANONICALIZATION_FAILED"
  // CONTENT matcher (GAP2, the em-dash-ban class). A forbidden substring inside a
  // fully-observable Write/Edit payload field is provable in BOTH polarities, so
  // unlike Bash it can produce a real COMPLIANT, not only a VIOLATION.
  | "FORBIDDEN_CONTENT_MATCH"
  | "COMPLIANT_NO_FORBIDDEN_CONTENT"
  | "CONTENT_INDETERMINATE"
  // COMMAND matcher (GAP2, the git/prisma class). A Bash string is opaque, so only
  // a POSITIVE literal token-run match is sound (a VIOLATION). There is NO command
  // COMPLIANT: a non-match degrades to UNKNOWN (opaque), because an alias, a script,
  // eval, or $VAR expansion could still perform the operation without the tokens.
  | "FORBIDDEN_COMMAND_MATCH"
  | "COMMAND_NO_MATCH_OPAQUE"
  | "COMMAND_INDETERMINATE";

/**
 * The normalized OBSERVED rule: the ephemeral, un-attested spec the scanner
 * produced and the evaluator reads (proposal §2.0a, P0.49). It is deliberately
 * MINIMAL here: exactly the enforcement-relevant fields the R0 evaluator actually
 * consumes to produce a verdict. The fuller `observed-rule-v1` field family from
 * the proposal (rationale, the compliance-evaluator version triple,
 * deliveryChannels, the observed enforcementCeiling, runtimeScopeId, the schema /
 * canonical-serialization version tags) is intentionally NOT frozen here: that
 * field set is owned by the schema/identity contract the document agent has not
 * yet committed, and freezing it now would mint a hash boundary we would have to
 * break. Slice 4 hashes EXACTLY this object under domain `observed-rule-v1`; when
 * the contract lands, both this shape and its golden vectors expand together.
 *
 * No persistence, no `ruleId`, no version: an ObservedRuleSpec is a value, not a
 * row. R1 attestation is what copies these fields into a frozen RulePayloadV1.
 */
export interface ObservedRuleSpec {
  /**
   * The scanned directive prose this rule was observed from. Human prose, so the
   * hash contract NFC-normalizes it (P0.53).
   */
  text: string;
  /** The parsed, validated applicability. The tools list is a SET for hashing. */
  applicability: RuleApplicability;
  /** The effect asserted on violation. The R0 notes-location pilot is PROHIBIT. */
  effect: RuleEffect;
  /**
   * The configured forbidden root, RELATIVE to the runtime project root (e.g.
   * "notes"). Filesystem-derived content: byte-preserved by the hash and
   * machine-independent. The absolute project root is a runtime binding resolved
   * at evaluation time, never part of the spec (so the same rule on two checkouts
   * hashes identically).
   */
  forbiddenRootRelativePath: string;
}

/**
 * DESCRIPTIVE severity metadata only; NOT an input to the gated enforcement decision and
 * never the deny/ask/advise trigger (proposal §2.0, P0.9 / P0.12). Inside the hash because
 * it is part of what a human attested, not because the evaluator reads it.
 */
export type RuleStrength = "MUST_FOLLOW" | "SHOULD_FOLLOW" | "ADVISORY";

/**
 * The channel a rule is delivered through (proposal §2.0, P0.11). `nativeRule` compiles into
 * CLAUDE.md, `runtimeInject` injects prompt-time context, `preToolUse` is action-time
 * enforcement. Delivery is its own axis; an action rule defaults to `preToolUse`. Hashed as a
 * SET (sorted + deduped), so two logically-equal channel lists hash identically.
 */
export type DeliveryChannel = "nativeRule" | "runtimeInject" | "preToolUse";

/**
 * The per-rule matcher config: the body the compliance evaluator reads (P0.63). For the path
 * evaluator it carries the IMMUTABLE configured forbidden root AS CONTENT (the path relative
 * to the runtime-scope root), never a mutable id, so repointing an id can never silently
 * change a rule's meaning.
 */
export interface ComplianceEvaluatorConfig {
  forbiddenRootRelativePath: string;
}

/**
 * The evaluator SEMANTICS that produce a verdict, version-bound so a later MLA build cannot
 * silently reinterpret an attested rule (same config, different verdict, same hash). Every
 * field is inside canonicalPayloadHash (P0.25).
 */
export interface ComplianceEvaluatorSpec {
  /** The exact compliance-evaluator behavior (matcher + verdict semantics). */
  evaluatorContractVersion: string;
  /** The matcher config schema this evaluator reads. */
  matcherSchemaVersion: string;
  /** The path-canonicalization algorithm version (P0.14 / P0.26). */
  pathCanonicalizerVersion: string;
  /** The per-rule matcher config. */
  config: ComplianceEvaluatorConfig;
}

/**
 * The IMMUTABLE rule specification, physically separated from the version envelope (P0.54).
 * EVERY field here is inside canonicalPayloadHash; nothing mutable, issuance-related, or
 * lineage-related may live here. The hashed boundary is the object boundary, not a comment.
 * (proposal §3.6, lines 978-991.)
 *
 * `rationale` is the sole optional field and is OMITTED, never null, when absent (P0.53).
 * `runtimeScopeId` is enforcement-relevant (a rule binds to one checkout scope) and so is
 * INSIDE the hash; the writer and loader both reject a version whose payload.runtimeScopeId
 * disagrees with its row's runtime_scope_id (the payload-scope == envelope-scope rule, §3.6).
 */
export interface RulePayloadV1 {
  text: string;
  rationale?: string;
  applicability: RuleApplicability;
  compliance: ComplianceEvaluatorSpec;
  effect: RuleEffect;
  /** DESCRIPTIVE severity only; NOT an enforcement input (P0.9 / P0.12). */
  strength: RuleStrength;
  deliveryChannels: DeliveryChannel[];
  /**
   * The MAX authority the human attested (P0.20). The ladder is OBSERVE < WARN < ASK < DENY.
   * WARN is the non-blocking middle rung (INV-8): a VIOLATION surfaces a model-facing advisory
   * (allow + additionalContext, read next turn), never a permissionDecision, so it can never
   * false-positive-block. DENY stays reserved for deterministic, high-cost, explicitly-attested
   * violations; ASK is the interactive human gate. A newly-armed forbidden-root rule defaults to
   * WARN; DENY is a deliberate promotion earned end-to-end (notes-location-v1).
   */
  enforcementCeiling: "OBSERVE" | "WARN" | "ASK" | "DENY";
  /** v1-locked; OnInfrastructureFailure (P0.15) is the future home. */
  infrastructureFailurePolicy: "PASS_WITH_ALERT";
  /** The project/checkout scope this rule binds to (P0.51); enforcement-relevant, so INSIDE the hash. NOT a bare workspaceId. */
  runtimeScopeId: string;
  /** Which RulePayloadV1 field-set this payload conforms to (P0.25). v1 pilot value: "rule-payload-v1". */
  payloadSchemaVersion: string;
  /** How canonicalPayloadHash is computed (P0.25). v1 pilot value: "v1", the existing P0.36/P0.53 JCS instance; NOT a new tag. */
  canonicalSerializationVersion: string;
}
