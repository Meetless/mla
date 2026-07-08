import { Ce0Store } from "./ce0-store";
import {
  getLiveLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "./local-rule-version-repo";
import { mintAttestedRuleVersion, type AttestIdentity, type MintOutcome } from "./attest-rule-version";
import {
  ComplianceEvaluatorSpec,
  DeliveryChannel,
  RuleApplicability,
  RuleEffect,
  RulePayloadV1,
  RuleStrength,
} from "./types";

// The pilot's mint-or-supersede outcome is the canonical writer's outcome, re-exported so the command
// shell keeps importing a single name regardless of which writer produced it.
export type { MintOutcome };

// Slice 7 (Phase B.7): the ObservedRuleSpec -> RulePayloadV1 conversion, the §2.4 pilot admission
// gate, and the mint-or-supersede orchestration behind `mla rules attest --from-observed <hash>`
// (proposal §2.4 conversion table lines 921-945, the admission gate lines 2076-2085, the worked
// attest flow lines 2037-2069). This module is the PURE core: it never reads the config, never
// prompts, never resolves the runtime scope, and never reads the observed snapshot from the store
// (that is the A.3 resolver). It converts the four observed fields plus the active runtime scope into
// the frozen RulePayloadV1, and it drives the A.4 repo's one-LIVE-per-(scope, rule) supersession. The
// command shell (commands/rules.ts) supplies the operator identity, the confirmation, and the IO.

/** R1 has exactly one logical pilot rule; the identity is FIXED, never chosen (proposal §2.4, P0.55). */
export const NOTES_LOCATION_RULE_ID = "notes-location-v1";

// The fields of the pilot payload that are FIXED by the §2.4 contract (everything except text,
// applicability, and the carried forbidden root). Naming them as constants makes the conversion table
// auditable against the proposal line by line.
const PILOT_EFFECT: RuleEffect = "PROHIBIT";
const PILOT_STRENGTH: RuleStrength = "MUST_FOLLOW";
const PILOT_DELIVERY_CHANNELS: DeliveryChannel[] = ["preToolUse"];
const PILOT_ENFORCEMENT_CEILING = "DENY" as const;
const PILOT_INFRASTRUCTURE_FAILURE_POLICY = "PASS_WITH_ALERT" as const;
const PILOT_EVALUATOR_CONTRACT_VERSION = "four-state-evaluator-v1";
const PILOT_MATCHER_SCHEMA_VERSION = "action-applicability-v1";
const PILOT_PATH_CANONICALIZER_VERSION = "notes-path-v1";
const PILOT_FORBIDDEN_ROOT = "notes";
const PILOT_PAYLOAD_SCHEMA_VERSION = "rule-payload-v1";
const PILOT_CANONICAL_SERIALIZATION_VERSION = "v1";

// The supported tool SET for the pilot: EXACTLY {Write, Edit} (admission gate condition 2).
const PILOT_TOOLS = ["Edit", "Write"] as const;

// The closed observed-rule-v1 schema key sets (must match observed-rule-hash.ts). An out-of-schema
// field already fails the observed hash (P0.53), so it can never be admitted into the pilot either.
const OBSERVED_RULE_KEYS = new Set(["text", "applicability", "effect", "forbiddenRootRelativePath"]);
const APPLICABILITY_AMBIENT_KEYS = new Set(["mode"]);
const APPLICABILITY_ACTION_KEYS = new Set(["mode", "tools", "matcher"]);
const MATCHER_KEYS = new Set(["field", "glob"]);

/** Why an observed snapshot was NOT admitted into the notes-location pilot (proposal §2.4 gate). */
export type AttestRejectionReason =
  | "SNAPSHOT_UNPARSEABLE" // not valid JSON
  | "UNKNOWN_FIELD" // a field outside the closed observed-rule-v1 schema (fail closed, P0.53)
  | "MALFORMED_SNAPSHOT" // a required field is missing or the wrong type
  | "NOT_ACTION_SCOPED" // applicability.mode != "action" (condition 1)
  | "TOOLS_NOT_WRITE_EDIT" // applicability.tools != {Write, Edit} (condition 2)
  | "EFFECT_NOT_PROHIBIT" // effect != "PROHIBIT" (condition 4)
  | "FORBIDDEN_ROOT_EMPTY" // forbiddenRootRelativePath is empty/whitespace (a rule forbidding the repo root)
  | "FORBIDDEN_ROOT_UNSUPPORTED"; // forbiddenRootRelativePath != "notes" (notes-pilot pin only, condition 5)

/** The result of converting an observed snapshot: an admitted frozen payload, or a typed refusal. */
export type AttestConversion =
  | { admitted: true; payload: RulePayloadV1 }
  | { admitted: false; reason: AttestRejectionReason; detail: string };

function reject(reason: AttestRejectionReason, detail: string): AttestConversion {
  return { admitted: false, reason, detail };
}

/** Strictly parse a snapshot string into the closed observed-rule-v1 shape, or a typed refusal. */
function parseObservedSnapshot(
  snapshotJson: string,
): { ok: true; spec: { text: string; applicability: RuleApplicability; effect: RuleEffect; forbiddenRootRelativePath: string } } | AttestConversion {
  let raw: unknown;
  try {
    raw = JSON.parse(snapshotJson);
  } catch {
    return reject("SNAPSHOT_UNPARSEABLE", "the observed snapshot is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return reject("MALFORMED_SNAPSHOT", "the observed snapshot is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const unknownTop = Object.keys(obj).find((k) => !OBSERVED_RULE_KEYS.has(k));
  if (unknownTop) {
    return reject("UNKNOWN_FIELD", `unknown field '${unknownTop}' is outside the observed-rule-v1 schema`);
  }
  if (typeof obj.text !== "string") return reject("MALFORMED_SNAPSHOT", "text must be a string");
  if (typeof obj.effect !== "string") return reject("MALFORMED_SNAPSHOT", "effect must be a string");
  if (typeof obj.forbiddenRootRelativePath !== "string") {
    return reject("MALFORMED_SNAPSHOT", "forbiddenRootRelativePath must be a string");
  }
  const applicability = parseApplicability(obj.applicability);
  if ("admitted" in applicability) return applicability;
  return {
    ok: true,
    spec: {
      text: obj.text,
      applicability: applicability.value,
      effect: obj.effect as RuleEffect,
      forbiddenRootRelativePath: obj.forbiddenRootRelativePath,
    },
  };
}

function parseApplicability(raw: unknown): { value: RuleApplicability } | AttestConversion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return reject("MALFORMED_SNAPSHOT", "applicability must be a JSON object");
  }
  const a = raw as Record<string, unknown>;
  if (a.mode === "ambient") {
    const unknown = Object.keys(a).find((k) => !APPLICABILITY_AMBIENT_KEYS.has(k));
    if (unknown) return reject("UNKNOWN_FIELD", `unknown field '${unknown}' in applicability(ambient)`);
    return { value: { mode: "ambient" } };
  }
  // A `turn` rule is prompt-time injection (Layer B, targeted-rule-injection §5.1), never an
  // action-gating attestation. Reject it EXPLICITLY here rather than letting the generic non-action
  // catch-all below swallow it, so the refusal names the right authoring path. This branch is
  // deliberately grammar-free: the turn trigger struct is owned solely by applicability.ts
  // `parseApplicability`; rejecting the mode requires no knowledge of the trigger's shape, so there is
  // no second grammar here to drift out of sync with the owner.
  if (a.mode === "turn") {
    return reject(
      "NOT_ACTION_SCOPED",
      "turn-scoped rules are prompt-time injection, not action gates; author them with " +
        "`mla rules add --turn-when-prompt/--turn-when-path`, never via --from-observed attestation",
    );
  }
  if (a.mode !== "action") {
    return reject("NOT_ACTION_SCOPED", `applicability.mode '${String(a.mode)}' is not 'action'`);
  }
  const unknown = Object.keys(a).find((k) => !APPLICABILITY_ACTION_KEYS.has(k));
  if (unknown) return reject("UNKNOWN_FIELD", `unknown field '${unknown}' in applicability(action)`);
  if (!Array.isArray(a.tools) || !a.tools.every((t) => typeof t === "string")) {
    return reject("MALFORMED_SNAPSHOT", "applicability.tools must be a string array");
  }
  const matcher = parseMatcher(a.matcher);
  if ("admitted" in matcher) return matcher;
  return { value: { mode: "action", tools: a.tools as string[], matcher: matcher.value } };
}

function parseMatcher(raw: unknown): { value: { field: string; glob?: string } } | AttestConversion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return reject("MALFORMED_SNAPSHOT", "applicability.matcher must be a JSON object");
  }
  const m = raw as Record<string, unknown>;
  const unknown = Object.keys(m).find((k) => !MATCHER_KEYS.has(k));
  if (unknown) return reject("UNKNOWN_FIELD", `unknown field '${unknown}' in applicability.matcher`);
  if (typeof m.field !== "string") return reject("MALFORMED_SNAPSHOT", "matcher.field must be a string");
  if (m.glob !== undefined && typeof m.glob !== "string") {
    return reject("MALFORMED_SNAPSHOT", "matcher.glob must be a string when present");
  }
  const value: { field: string; glob?: string } = { field: m.field };
  if (m.glob !== undefined) value.glob = m.glob as string;
  return { value };
}

function isExactlyWriteEdit(tools: string[]): boolean {
  const set = new Set(tools);
  return set.size === PILOT_TOOLS.length && PILOT_TOOLS.every((t) => set.has(t));
}

/**
 * Convert one frozen observed-rule-v1 snapshot into the immutable RulePayloadV1, for the WHOLE PROHIBIT
 * forbidden-root family, or REFUSE it. The admission gate runs BEFORE any payload is built: a snapshot
 * that is not an action-scoped, exactly-{Write, Edit}, field/glob-matcher, effect-PROHIBIT rule with a
 * non-empty forbidden root (closed schema) is never converted, so it can never mint a version.
 *
 * Generalizing the forbidden root beyond the notes pilot is provably conflict-free (proposal §2.0: a
 * conflict requires a LIVE rule whose effect EFFECTIVELY REQUIRES the action that another PROHIBITs;
 * a PROHIBIT rule never requires a write, so two members of this family can never conflict). The
 * evaluator/matcher/canonicalizer contract versions and the path canonicalizer (`notes-path.ts`) are
 * already generic over the configured root, so the same frozen payload shape serves any root. Anything
 * OUTSIDE this family (a different evaluator, PERMIT/EXCLUSION effects, ambient rules) stays R4.
 *
 * The conversion itself is the §2.4 table: text/applicability verbatim, every other field fixed by the
 * family contract, the forbidden root carried AS CONTENT (P0.63), the runtime scope bound from the
 * active evaluation scope. The compliance version triple is supported by construction (the minimal
 * observed spec carries no compliance spec), satisfying gate condition 6.
 */
export function convertForbiddenRootSnapshot(snapshotJson: string, runtimeScopeId: string): AttestConversion {
  const parsed = parseObservedSnapshot(snapshotJson);
  if ("admitted" in parsed) return parsed;
  const spec = parsed.spec;

  if (spec.applicability.mode !== "action") {
    return reject("NOT_ACTION_SCOPED", "an ambient rule is never an action-gating version");
  }
  if (!isExactlyWriteEdit(spec.applicability.tools)) {
    return reject("TOOLS_NOT_WRITE_EDIT", `tools must be exactly {Write, Edit}, got [${spec.applicability.tools.join(", ")}]`);
  }
  if (spec.effect !== PILOT_EFFECT) {
    return reject("EFFECT_NOT_PROHIBIT", `effect '${spec.effect}' is not 'PROHIBIT'`);
  }
  if (spec.forbiddenRootRelativePath.trim() === "") {
    return reject("FORBIDDEN_ROOT_EMPTY", "forbidden root is empty: a rule forbidding the repo root is nonsensical");
  }

  const compliance: ComplianceEvaluatorSpec = {
    evaluatorContractVersion: PILOT_EVALUATOR_CONTRACT_VERSION,
    matcherSchemaVersion: PILOT_MATCHER_SCHEMA_VERSION,
    pathCanonicalizerVersion: PILOT_PATH_CANONICALIZER_VERSION,
    config: { forbiddenRootRelativePath: spec.forbiddenRootRelativePath },
  };
  const payload: RulePayloadV1 = {
    text: spec.text,
    applicability: spec.applicability,
    compliance,
    effect: PILOT_EFFECT,
    strength: PILOT_STRENGTH,
    deliveryChannels: PILOT_DELIVERY_CHANNELS,
    enforcementCeiling: PILOT_ENFORCEMENT_CEILING,
    infrastructureFailurePolicy: PILOT_INFRASTRUCTURE_FAILURE_POLICY,
    runtimeScopeId,
    payloadSchemaVersion: PILOT_PAYLOAD_SCHEMA_VERSION,
    canonicalSerializationVersion: PILOT_CANONICAL_SERIALIZATION_VERSION,
  };
  return { admitted: true, payload };
}

/**
 * The notes-location pilot member of the forbidden-root family: the generic converter pinned to the
 * "notes" root (proposal §2.4 condition 5). This is the converter the no-flag `mla rules attest` default
 * uses, preserving the exact armed R1 behavior. An explicit `--new-rule`/`--rule` identity uses the
 * generic `convertForbiddenRootSnapshot` instead.
 */
export function convertNotesLocationSnapshot(snapshotJson: string, runtimeScopeId: string): AttestConversion {
  const generic = convertForbiddenRootSnapshot(snapshotJson, runtimeScopeId);
  if (!generic.admitted) return generic;
  const root = generic.payload.compliance.config.forbiddenRootRelativePath;
  if (root !== PILOT_FORBIDDEN_ROOT) {
    return reject("FORBIDDEN_ROOT_UNSUPPORTED", `forbidden root '${root}' is not 'notes'`);
  }
  return generic;
}

/** The inputs the command shell hands the mint after it has converted, confirmed, and resolved. */
export interface MintInput {
  /** The admitted, frozen payload (the SOLE source of the stored serialization + hash). */
  payload: RulePayloadV1;
  /** The observed-rule-v1 hash this version was attested from (provenance, P0.35). */
  observedRuleHash: string;
  /** The accountable human, resolved from the authenticated operator (never a free arg, P0.55). */
  attestedBy: string;
  attestationMethod: LocalRuleVersionRecord["attestationMethod"];
  /** The minted version identity (ULID), supplied by the caller so the mint is deterministic in tests. */
  versionId: string;
  attestedAt: string;
}

/**
 * Mint the LIVE notes-location version for the payload's runtime scope (proposal worked attest flow
 * lines 2058-2068) by deferring to the canonical R1 writer. The pilot's logical identity is FIXED to
 * notes-location-v1, but it still flows through the P0.55 identity choice rather than re-deriving it:
 * the FIRST attest in a scope mints that id as a NEW rule (no predecessor), and every later attest is a
 * SUCCESSOR of the prior LIVE version of the same rule (idempotent no-op when the payload hash is
 * unchanged, otherwise a supersession with backward lineage). Serialization, the rule-version-v1 hash,
 * the one-LIVE supersession transaction, and the at-the-attested-ceiling guarantee all live in the
 * canonical writer; attestation and effective enforcement stay separate (§10.2, lines 2117-2124).
 */
export function mintAttestedNotesLocationVersion(store: Ce0Store, input: MintInput): MintOutcome {
  const scope = input.payload.runtimeScopeId;
  const live = getLiveLocalRuleVersion(store, scope, NOTES_LOCATION_RULE_ID);
  const identity: AttestIdentity = live
    ? { mode: "SUCCESSOR", ruleId: NOTES_LOCATION_RULE_ID }
    : { mode: "NEW_RULE", ruleId: NOTES_LOCATION_RULE_ID };
  return mintAttestedRuleVersion(store, { ...input, identity });
}
