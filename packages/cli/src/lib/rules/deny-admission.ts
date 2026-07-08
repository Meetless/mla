import * as path from "path";

import { type InputAuthorityResolution } from "./input-authority-resolver";

/*
 * Slice 9 (Phase B.9): the PURE deny-admission decision machinery for the R1 notes-location pilot.
 *
 * notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md, §10.2 (R1-3,
 * R1-5) and the eligible/effective enforcement computation. This module is the decision kernel
 * only: it is side-effect free, it records nothing, and it emits no deny. Recording the durable
 * DECISION_RECORDED row and emitting the actual deny response is slice 10.
 *
 * Three properties are load-bearing and proven by the spec:
 *
 *   1. Eligibility is projected through the evaluation `result` ONLY. A VIOLATION rises to the
 *      attested enforcement ceiling; every other result (COMPLIANT and, critically, UNKNOWN)
 *      stays at OBSERVE. The no-machine-deny and UNKNOWN-never-denies guarantees therefore live
 *      at the eligibility step, not as a post-hoc gate. The UNKNOWN_EVALUATION_NEVER_DENIES gate
 *      remains a declared member of the closed enum but is unreachable for the pilot by design.
 *
 *   2. The only thing standing between an attested DENY ceiling and an effective deny is the
 *      P0.12 deny-admission gates. For the pilot the single reachable gate is
 *      RULE_ENFORCEMENT_UNAVAILABLE, produced when MLA is not the sole effective input authority
 *      (P0.58) or the attested immutable path root cannot be resolved (P0.63). Either lowers the
 *      effective enforcement to NONE: the action passes (fail open, decision 5), an alert fires,
 *      and `mla doctor` fails. A gate NEVER downgrades a deny to a silent OBSERVE.
 *
 *   3. The gate-reason enum is a CLOSED set, recorded as a single primary code. Closure is an
 *      application-layer invariant; the `gate_reason_code` column is bare TEXT.
 */

export type EvaluationResult = "COMPLIANT" | "VIOLATION" | "UNKNOWN";
export type EligibleEnforcement = "OBSERVE" | "ASK" | "DENY";
export type EffectiveEnforcement = "NONE" | "OBSERVE" | "ASK" | "DENY";

/*
 * The closed set of primary deny-admission gate reasons, in precedence order: the first whose
 * condition holds is the single recorded `gate_reason_code`. RULE_ENFORCEMENT_UNAVAILABLE is the
 * only member reachable in the R1 pilot; the remaining four are declared-but-unreached members
 * that keep the enum complete for R4 and the LIVE/lifecycle and conflict gates.
 */
export type EnforcementGateReasonCode =
  | "RULE_ENFORCEMENT_UNAVAILABLE"
  | "NOT_LIVE_CAPS_AT_OBSERVE"
  | "UNKNOWN_EVALUATION_NEVER_DENIES"
  | "WORKSPACE_POLICY_FORBIDS_DENY"
  | "UNRESOLVED_CONFLICT_NEVER_DENIES";

export const ENFORCEMENT_GATE_REASON_CODES: readonly EnforcementGateReasonCode[] = [
  "RULE_ENFORCEMENT_UNAVAILABLE",
  "NOT_LIVE_CAPS_AT_OBSERVE",
  "UNKNOWN_EVALUATION_NEVER_DENIES",
  "WORKSPACE_POLICY_FORBIDS_DENY",
  "UNRESOLVED_CONFLICT_NEVER_DENIES",
];

export function isEnforcementGateReasonCode(x: unknown): x is EnforcementGateReasonCode {
  return (
    typeof x === "string" &&
    (ENFORCEMENT_GATE_REASON_CODES as readonly string[]).includes(x)
  );
}

/*
 * R1-3: eligibility is projected through the evaluation `result` only. The attested enforcement
 * ceiling applies exclusively to a VIOLATION; anything else (including UNKNOWN) is OBSERVE.
 */
export function projectEligibleEnforcement(
  result: EvaluationResult,
  enforcementCeiling: EligibleEnforcement,
): EligibleEnforcement {
  return result === "VIOLATION" ? enforcementCeiling : "OBSERVE";
}

/*
 * P0.63: the forbidden path root is the attested immutable relative path joined to the active
 * runtime project root (the realpath-resolved root of THIS checkout, resolved from the active
 * runtime scope, never the target's git context). Either input being empty refuses admission with
 * a distinct reason, so a would-be deny with no resolvable root degrades to NONE rather than
 * denying on a bad anchor.
 */
export type PathRootAdmission =
  | { admitted: true; forbiddenRoot: string }
  | { admitted: false; reason: "ATTESTED_ROOT_CONTENT_MISSING" | "ACTIVE_RUNTIME_ROOT_UNRESOLVED" };

export function resolveAttestedPathRoot(input: {
  configuredRelativeForbiddenPath?: string;
  activeRuntimeProjectRoot?: string;
}): PathRootAdmission {
  const relative = (input.configuredRelativeForbiddenPath ?? "").trim();
  const root = (input.activeRuntimeProjectRoot ?? "").trim();
  if (relative.length === 0) {
    return { admitted: false, reason: "ATTESTED_ROOT_CONTENT_MISSING" };
  }
  if (root.length === 0) {
    return { admitted: false, reason: "ACTIVE_RUNTIME_ROOT_UNRESOLVED" };
  }
  return { admitted: true, forbiddenRoot: path.join(root, relative) };
}

/*
 * R1-5: lower the eligible enforcement to effective enforcement through the deny-admission gates.
 * Only a DENY eligibility is gated; OBSERVE and ASK pass through untouched with no gate reason.
 * A DENY is admitted only when MLA is the sole effective input authority AND the attested path
 * root is admissible; otherwise it fails open to NONE with the single primary gate reason
 * RULE_ENFORCEMENT_UNAVAILABLE. The decision is gated by admissibility, never by deny "strength".
 */
export function admitEnforcement(args: {
  eligibleEnforcement: EligibleEnforcement;
  inputAuthority: InputAuthorityResolution;
  pathRoot: PathRootAdmission;
}): { effectiveEnforcement: EffectiveEnforcement; gateReasonCode: EnforcementGateReasonCode | null } {
  if (args.eligibleEnforcement !== "DENY") {
    return { effectiveEnforcement: args.eligibleEnforcement, gateReasonCode: null };
  }
  if (args.inputAuthority.kind !== "MLA_SOLE_AUTHORITY" || !args.pathRoot.admitted) {
    return { effectiveEnforcement: "NONE", gateReasonCode: "RULE_ENFORCEMENT_UNAVAILABLE" };
  }
  return { effectiveEnforcement: "DENY", gateReasonCode: null };
}

/*
 * P0.60: honest deny-emission accounting. An effective DENY is planned as an aggregate DENY whose
 * emission state begins at DECISION_RECORDED: slice 10 persists and commits this row BEFORE
 * emitting the deny response, so a crash after the commit but before emission leaves an honest
 * DECISION_RECORDED (recoverable, never NO_DECISION). Any non-deny effective enforcement plans no
 * decision at all.
 */
export function planDenyAccounting(effective: EffectiveEnforcement): {
  aggregateDecision: "NO_DECISION" | "DENY";
  denyEmissionStatus: "NOT_APPLICABLE" | "DECISION_RECORDED";
} {
  return effective === "DENY"
    ? { aggregateDecision: "DENY", denyEmissionStatus: "DECISION_RECORDED" }
    : { aggregateDecision: "NO_DECISION", denyEmissionStatus: "NOT_APPLICABLE" };
}
