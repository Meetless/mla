import { Ce0Store } from "./ce0-store";
import {
  EvaluationInputV1,
  EvaluationTarget,
  evaluationInputHash,
  serializeEvaluationInput,
} from "./evaluation-input-hash";
import {
  advanceDenyEmissionToResponseEmitted,
  insertToolAttempt,
  ToolAttemptRecord,
} from "./interception-store";
import {
  getLiveLocalRuleVersion,
  insertVersionEvaluationRecord,
  listLiveLocalRuleVersions,
  LocalRuleVersionRecord,
  VersionEvaluationInput,
} from "./local-rule-version-repo";
import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
  observeAndRecordNotesRule,
  type R0DurableOutcome,
} from "./durable-observation";
import { classifyRuntimeTarget } from "./notes-path";
import { isInertNonEnforcingRule } from "./inert-rule-families";
import { ObserveHookResponse, parsePreToolUseInput } from "./observe-adapter";
import { selectRule, ToolCall } from "./evaluator";
import { NOTES_LOCATION_RULE_ID } from "./attest-notes-location";
import { RulePayloadV1, VerdictReasonCode } from "./types";
import { RandInt32, ulid } from "./ulid";
import {
  admitEnforcement,
  planDenyAccounting,
  projectEligibleEnforcement,
  resolveAttestedPathRoot,
  type EffectiveEnforcement,
  type EligibleEnforcement,
  type EnforcementGateReasonCode,
  type EvaluationResult,
} from "./deny-admission";
import {
  recordVersionEvaluation,
  versionBackedVerdict,
  type VersionPersistenceContext,
} from "./version-evaluation";
import { type InputAuthorityResolution } from "./input-authority-resolver";
import { type Directive } from "../scanner/types";

// Slice 10 (Phase B.10): the single notes-location pilot DENY, the first and only place R1 actually
// emits an enforcement decision (notes/20260615-rules-as-node-and-action-interception-consolidated
// -proposal.md §10.1/§10.2, R1-1 through R1-5, and the P0.52 deny-linearization contract lines
// 1291-1312). Everything beneath this seam already exists: the version-backed evaluation (slice 8),
// the pure deny-admission kernel (slice 9), and the one legal deny-emission advance on tool_attempt
// (interception-store). This seam wires them into one PreToolUse decision:
//
//   parse -> resolve the LIVE attested version -> applicability -> classify the target ->
//   version-backed verdict -> project eligibility through the attested enforcement ceiling.
//
// If the projected eligibility is not DENY (COMPLIANT, UNKNOWN, or a non-DENY ceiling) the call
// OBSERVES exactly like slice 8 and passes through, and input authority is NEVER resolved (R1-3/R1-5
// timing: the authority is read at a would-be deny, never speculatively). Only a would-be deny
// re-resolves the multi-layer input authority (P0.58) and the attested immutable path root (P0.63) and
// runs the admission kernel. On an admitted effective DENY the durable DECISION_RECORDED row is
// committed BEFORE the deny response is emitted, then advanced to RESPONSE_EMITTED (R1-4): a crash in
// that window leaves an honest DECISION_RECORDED, never NO_DECISION. A gate miss or a generation churn
// in the deny window fails OPEN to effective NONE / RULE_ENFORCEMENT_UNAVAILABLE: the action passes,
// the honest NONE arm is recorded, and `mla doctor` is what surfaces the unavailability. There is no
// machine-authored deny path: a deny exists only against the one human-attested LIVE version.

/** The hook response the seam returns. A pass-through is the empty, permission-granting-nothing object
 * (INV-SURFACE-DOES-NOT-GRANT-PERMISSION); an admitted deny is the only shape that carries a decision. */
export type EnforceHookResponse = ObserveHookResponse | { permissionDecision: "deny"; reason: string };

const PASS_THROUGH: EnforceHookResponse = {};

/** The durable, audit-facing outcome of one enforced interception. DENIED and ENFORCEMENT_UNAVAILABLE
 * both carry the written row ids; OBSERVED carries the version-arm verdict; the skip kinds persist
 * nothing. The hook response travels separately so the side channel can never silently grant. */
export type EnforceOutcome =
  | {
      kind: "DENIED";
      attemptId: string;
      evaluationId: string;
      ruleVersionId: string;
      canonicalPayloadHash: string;
      inputAuthorityConfigHash: string;
    }
  | {
      kind: "ENFORCEMENT_UNAVAILABLE";
      cause: "INPUT_AUTHORITY" | "PATH_ROOT" | "GENERATION_CHURN";
      attemptId: string;
      evaluationId: string;
    }
  | {
      kind: "OBSERVED";
      attemptId: string;
      evaluationId: string;
      result: EvaluationResult;
      verdictReasonCode: VerdictReasonCode;
      ruleVersionId: string;
      canonicalPayloadHash: string;
    }
  | { kind: "NO_LIVE_VERSION" }
  // ONLY_INERT_RULES: the scope HAS one or more LIVE rules, but every one is provably inert (RECORD_ONLY),
  // so no enforceable version is armed. Distinct from NO_LIVE_VERSION (a literally empty scope) so the audit
  // trail never claims "no live version" when an inert rule is in fact live. Both fold into the observe
  // fallback at the composed seam; the distinction is for honesty, not control flow.
  | { kind: "ONLY_INERT_RULES" }
  | { kind: "NOT_APPLICABLE" }
  | { kind: "R4_UNSUPPORTED_RULE_KIND"; ruleId: string }
  | { kind: "INFRA"; diagnostic: string };

/** Everything one enforced interception needs. `rand`, `classifyRuntime`, and `beforeDenyCommit` are
 * injected for deterministic, filesystem-free tests; production omits them and gets a CSPRNG, the real
 * notes-path canonicalizer, and no concurrent-attest injection. `resolveInputAuthority` is a thunk so
 * the IO that reads the effective hook-config layers runs ONLY at a would-be deny (R1-5 timing), and
 * the pure resolver behind it stays where slice-9 `mla doctor` already exercises it. */
export interface EvaluateAndEnforceInput {
  /** The raw PreToolUse payload: the JSON string from stdin, or an already-parsed object. */
  rawStdin: unknown;
  /** The activated runtime project root (absolute). The attested path root (P0.63) anchors here. */
  runtimeProjectRoot: string;
  /** The runtime scope whose LIVE version is faced and whose rows are written. */
  runtimeScopeId: string;
  /** Which logical rule's LIVE version to face. Defaults to the notes-location pilot for backward
   * compatibility; the rule-driven dispatch sets it per family rule so one tool attempt can be faced
   * against every LIVE PROHIBIT forbidden-root rule in turn. */
  ruleId?: string;
  /** The ISO timestamp stamped on every written row. */
  createdAt: string;
  /** ULID mint clock. */
  now: number;
  /** ULID randomness source; omit in production for a CSPRNG. */
  rand?: RandInt32;
  /** Runtime-scope path classifier; defaults to the real filesystem canonicalizer. */
  classifyRuntime?: (rawFilePath: unknown, runtimeProjectRoot: string) => Promise<EvaluationTarget>;
  /** Re-resolve the live multi-layer input authority at THIS would-be deny (P0.58). Invoked ONLY on the
   * deny path; the OBSERVE/UNKNOWN/skip paths never call it. */
  resolveInputAuthority: () => InputAuthorityResolution;
  /** Test seam: a concurrent attest landing in the deny linearization window (P0.52), invoked just
   * before the deny-commit transaction opens. Production omits it. */
  beforeDenyCommit?: () => void;
}

/** The subject of a linearized deny commit: the tool, the canonicalized target, the LIVE version the
 * deny was evaluated against, its payload, the VIOLATION verdict, and the input-authority config hash
 * resolved at this deny. */
export interface DenyDecisionSubject {
  toolName: "Write" | "Edit";
  target: EvaluationTarget;
  version: LocalRuleVersionRecord;
  payload: RulePayloadV1;
  result: EvaluationResult;
  verdictReasonCode: VerdictReasonCode;
  inputAuthorityConfigHash: string;
}

/** The outcome of a linearized deny commit: COMMITTED carries the durable row ids; a GENERATION_CHURN
 * wrote nothing and the caller must fail open. */
export type RecordDenyDecisionResult =
  | { committed: true; attemptId: string; evaluationId: string }
  | { committed: false; cause: "GENERATION_CHURN" };

/** The enforcement fields one version-arm row pair carries beyond its subject and ids. */
interface ArmEnforcement {
  result: EvaluationResult;
  verdictReasonCode: VerdictReasonCode;
  eligibleEnforcement: EligibleEnforcement;
  effectiveEnforcement: EffectiveEnforcement;
  gateReasonCode: EnforcementGateReasonCode | null;
  inputAuthorityConfigHash: string | null;
}

/** What a version-arm interception writes: the tool, the canonicalized target, the LIVE version, and
 * its payload (for the snapshot's forbidden root). */
interface ArmSubject {
  toolName: "Write" | "Edit";
  target: EvaluationTarget;
  version: LocalRuleVersionRecord;
  payload: RulePayloadV1;
}

/**
 * Build the tool_attempt + version-arm rule_evaluation_record pair for one interception. The
 * evaluation-input-v1 snapshot carries the RUNNING evaluator's supported triple, byte-identical to
 * slice 8's observe writer, so a snapshot-only replay reproduces the verdict. The deny accounting
 * (aggregate decision + emission status) is derived from the effective enforcement through the slice-9
 * kernel so this seam never re-decides what the kernel already owns.
 */
function buildArmRows(
  ids: { attemptId: string; evaluationId: string },
  subject: ArmSubject,
  enforcement: ArmEnforcement,
  ctx: VersionPersistenceContext,
): { attempt: ToolAttemptRecord; evaluation: VersionEvaluationInput } {
  const evaluationInput: EvaluationInputV1 = {
    toolName: subject.toolName,
    target: subject.target,
    forbiddenRootRelativePath: subject.payload.compliance.config.forbiddenRootRelativePath,
    evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
    matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
    pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
  };
  const accounting = planDenyAccounting(enforcement.effectiveEnforcement);
  const attempt: ToolAttemptRecord = {
    attemptId: ids.attemptId,
    runtimeScopeId: ctx.runtimeScopeId,
    sessionId: ctx.sessionId,
    toolName: subject.toolName,
    evaluationInputSnapshot: serializeEvaluationInput(evaluationInput),
    evaluationInputHash: evaluationInputHash(evaluationInput),
    aggregateDecision: accounting.aggregateDecision,
    denyEmissionStatus: accounting.denyEmissionStatus,
    inputAuthorityConfigHash: enforcement.inputAuthorityConfigHash,
    createdAt: ctx.createdAt,
  };
  const evaluation: VersionEvaluationInput = {
    evaluationId: ids.evaluationId,
    attemptId: ids.attemptId,
    runtimeScopeId: ctx.runtimeScopeId,
    result: enforcement.result,
    eligibleEnforcement: enforcement.eligibleEnforcement,
    effectiveEnforcement: enforcement.effectiveEnforcement,
    verdictReasonCode: enforcement.verdictReasonCode,
    gateReasonCode: enforcement.gateReasonCode,
    evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
    ruleVersionId: subject.version.versionId,
    canonicalPayloadHash: subject.version.canonicalPayloadHash,
    createdAt: ctx.createdAt,
  };
  return { attempt, evaluation };
}

/** Write a version-arm row pair atomically (a single BEGIN IMMEDIATE), so an interception is never
 * half-recorded. */
function writeArm(
  store: Ce0Store,
  attempt: ToolAttemptRecord,
  evaluation: VersionEvaluationInput,
): void {
  store.db
    .transaction(() => {
      insertToolAttempt(store, attempt);
      insertVersionEvaluationRecord(store, evaluation);
    })
    .immediate();
}

/**
 * Persist a would-be deny that a gate (or a generation churn) lowered to effective NONE, and report
 * the row ids. The eligible enforcement stays DENY (the rule WOULD have denied) but the effective
 * enforcement is NONE with the single primary gate reason RULE_ENFORCEMENT_UNAVAILABLE, the deny
 * status is NOT_APPLICABLE, and the input-authority config hash resolved at this deny is recorded for
 * the audit and for `mla doctor`. This is the honest record behind a fail-open.
 */
function recordEnforcementUnavailable(
  store: Ce0Store,
  subject: ArmSubject,
  verdict: { result: EvaluationResult; verdictReasonCode: VerdictReasonCode },
  inputAuthorityConfigHash: string,
  ctx: VersionPersistenceContext,
): { attemptId: string; evaluationId: string } {
  const ids = { attemptId: ulid(ctx.now, ctx.rand), evaluationId: ulid(ctx.now, ctx.rand) };
  const { attempt, evaluation } = buildArmRows(
    ids,
    subject,
    {
      result: verdict.result,
      verdictReasonCode: verdict.verdictReasonCode,
      eligibleEnforcement: "DENY",
      effectiveEnforcement: "NONE",
      gateReasonCode: "RULE_ENFORCEMENT_UNAVAILABLE",
      inputAuthorityConfigHash,
    },
    ctx,
  );
  writeArm(store, attempt, evaluation);
  return ids;
}

/**
 * The linearized deny commit (P0.52). Mints the two ULIDs and builds the DENY / DECISION_RECORDED row
 * pair OUTSIDE any write transaction, then opens a single BEGIN IMMEDIATE and RE-READS the LIVE version
 * for the deny's (scope, rule). It persists ONLY when that is still the exact generation the deny was
 * evaluated against; if a concurrent attest superseded it in the window, the deny is inadmissible, the
 * transaction writes nothing, and it fails open with GENERATION_CHURN.
 *
 * This is the minimal safe floor of the contract: the spec permits one retry, but we treat the first
 * observed churn as inadmissible (no retry loop), which is strictly more conservative. `beforeCommit`
 * is the test seam that lands a supersede in the window; it runs BEFORE the IMMEDIATE acquires the
 * write lock, exactly as a real concurrent attest that commits ahead of our deny-commit would.
 */
export function recordDenyDecision(
  store: Ce0Store,
  subject: DenyDecisionSubject,
  ctx: VersionPersistenceContext,
  opts: { beforeCommit?: () => void } = {},
): RecordDenyDecisionResult {
  const attemptId = ulid(ctx.now, ctx.rand);
  const evaluationId = ulid(ctx.now, ctx.rand);
  const { attempt, evaluation } = buildArmRows(
    { attemptId, evaluationId },
    subject,
    {
      result: subject.result,
      verdictReasonCode: subject.verdictReasonCode,
      eligibleEnforcement: "DENY",
      effectiveEnforcement: "DENY",
      gateReasonCode: null,
      inputAuthorityConfigHash: subject.inputAuthorityConfigHash,
    },
    ctx,
  );

  // The concurrent attest, if any, commits ahead of our write lock (it cannot land once BEGIN IMMEDIATE
  // holds the lock, so the realistic race is "it committed in the window before us").
  opts.beforeCommit?.();

  let churned = false;
  store.db
    .transaction(() => {
      const live = getLiveLocalRuleVersion(store, subject.version.runtimeScopeId, subject.version.ruleId);
      if (!live || live.versionId !== subject.version.versionId) {
        churned = true;
        return;
      }
      insertToolAttempt(store, attempt);
      insertVersionEvaluationRecord(store, evaluation);
    })
    .immediate();

  if (churned) {
    return { committed: false, cause: "GENERATION_CHURN" };
  }
  return { committed: true, attemptId, evaluationId };
}

/** Describe the blocked target for the deny reason; a non-relative target degrades to a generic phrase
 * rather than leaking an unclassified path shape. */
function describeTarget(target: EvaluationTarget): string {
  return target.kind === "RUNTIME_RELATIVE" ? target.path : "the requested file";
}

/**
 * Build the human-facing deny reason for any PROHIBIT forbidden-root rule. It is grounded in the
 * attested prose (`payload.text`, the human-attested directive) plus the concrete blocked target and
 * the configured forbidden root, and it names the violated rule id so the block is self-explaining in
 * the Claude Code surface. No rule-specific copy is hard-coded here: the attested prose carries the
 * steer (where the file SHOULD go), so the one reason builder serves the whole family, not just the
 * notes pilot.
 */
function buildDenyReason(ruleId: string, payload: RulePayloadV1, target: EvaluationTarget): string {
  const where = describeTarget(target);
  const forbidden = payload.compliance.config.forbiddenRootRelativePath;
  return (
    `Blocked by Meetless rule ${ruleId}. Writing ${where} under the forbidden ` +
    `"${forbidden}/" root is prohibited. ${payload.text}`
  );
}

/**
 * The enforced version-backed PreToolUse seam for the notes-location pilot. See the module header for
 * the full pipeline. Returns the hook response (pass-through, or the one admitted deny) plus the
 * durable outcome on the side channel. Skip semantics match slice 8 exactly: malformed payload or
 * absent session id is INFRA, no LIVE version is NO_LIVE_VERSION, a non-Write/Edit tool or a glob
 * non-match is NOT_APPLICABLE, and none of those persist a row.
 */
export async function evaluateAndEnforceNotesVersion(
  store: Ce0Store,
  input: EvaluateAndEnforceInput,
): Promise<{ response: EnforceHookResponse; outcome: EnforceOutcome }> {
  const parsed = parsePreToolUseInput(input.rawStdin);
  if (!parsed) {
    return { response: PASS_THROUGH, outcome: { kind: "INFRA", diagnostic: "malformed hook input" } };
  }
  if (parsed.session_id === undefined) {
    return { response: PASS_THROUGH, outcome: { kind: "INFRA", diagnostic: "missing session_id" } };
  }

  const ruleId = input.ruleId ?? NOTES_LOCATION_RULE_ID;
  const version = getLiveLocalRuleVersion(store, input.runtimeScopeId, ruleId);
  if (!version) {
    return { response: PASS_THROUGH, outcome: { kind: "NO_LIVE_VERSION" } };
  }

  const payload = JSON.parse(version.rulePayload) as RulePayloadV1;
  const call: ToolCall = { toolName: parsed.tool_name, toolInput: parsed.tool_input };
  if (selectRule(call, payload.applicability) === "NOT_APPLICABLE" || payload.applicability.mode !== "action") {
    return { response: PASS_THROUGH, outcome: { kind: "NOT_APPLICABLE" } };
  }

  // The selector proved the tool is in the version's {Write, Edit} list and the matcher field holds a
  // matching string, so this narrowing is sound (mirrors slice 8).
  const toolName = parsed.tool_name as "Write" | "Edit";
  const rawFilePath = parsed.tool_input[payload.applicability.matcher.field];
  const classify = input.classifyRuntime ?? classifyRuntimeTarget;
  const target = await classify(rawFilePath, input.runtimeProjectRoot);

  const verdict = versionBackedVerdict(payload, target);
  const eligible = projectEligibleEnforcement(verdict.result, payload.enforcementCeiling);

  const ctx: VersionPersistenceContext = {
    runtimeScopeId: input.runtimeScopeId,
    sessionId: parsed.session_id,
    createdAt: input.createdAt,
    now: input.now,
    rand: input.rand,
  };
  const subject: ArmSubject = { toolName, target, version, payload };

  // Not a would-be deny (COMPLIANT, UNKNOWN, or a non-DENY ceiling): OBSERVE and pass through, WITHOUT
  // resolving input authority. This is byte-identical to slice 8's writer.
  if (eligible !== "DENY") {
    const persisted = recordVersionEvaluation(store, { toolName, target, version }, ctx);
    return {
      response: PASS_THROUGH,
      outcome: {
        kind: "OBSERVED",
        attemptId: persisted.attemptId,
        evaluationId: persisted.evaluationId,
        result: persisted.result,
        verdictReasonCode: persisted.verdictReasonCode,
        ruleVersionId: persisted.ruleVersionId,
        canonicalPayloadHash: persisted.canonicalPayloadHash,
      },
    };
  }

  // A would-be deny. Re-resolve the input authority (P0.58) and the attested path root (P0.63) at THIS
  // deny, then run the pure admission kernel (slice 9).
  const inputAuthority = input.resolveInputAuthority();
  const pathRoot = resolveAttestedPathRoot({
    configuredRelativeForbiddenPath: payload.compliance.config.forbiddenRootRelativePath,
    activeRuntimeProjectRoot: input.runtimeProjectRoot,
  });
  const admission = admitEnforcement({ eligibleEnforcement: eligible, inputAuthority, pathRoot });

  if (admission.effectiveEnforcement !== "DENY") {
    // A gate lowered the deny to NONE: record the honest NONE arm and fail open. The cause distinguishes
    // a non-sole input authority (P0.58) from an unresolved path root (P0.63); both are recorded as the
    // single gate reason RULE_ENFORCEMENT_UNAVAILABLE.
    const ids = recordEnforcementUnavailable(store, subject, verdict, inputAuthority.configHash, ctx);
    const cause = inputAuthority.kind !== "MLA_SOLE_AUTHORITY" ? "INPUT_AUTHORITY" : "PATH_ROOT";
    return {
      response: PASS_THROUGH,
      outcome: { kind: "ENFORCEMENT_UNAVAILABLE", cause, attemptId: ids.attemptId, evaluationId: ids.evaluationId },
    };
  }

  // Admitted DENY. Linearize the durable commit against the LIVE generation (P0.52).
  const deny = recordDenyDecision(
    store,
    {
      toolName,
      target,
      version,
      payload,
      result: verdict.result,
      verdictReasonCode: verdict.verdictReasonCode,
      inputAuthorityConfigHash: inputAuthority.configHash,
    },
    ctx,
    { beforeCommit: input.beforeDenyCommit },
  );

  if (!deny.committed) {
    // The LIVE generation churned in the deny window: inadmissible. Record the NONE arm and fail open.
    const ids = recordEnforcementUnavailable(store, subject, verdict, inputAuthority.configHash, ctx);
    return {
      response: PASS_THROUGH,
      outcome: { kind: "ENFORCEMENT_UNAVAILABLE", cause: "GENERATION_CHURN", attemptId: ids.attemptId, evaluationId: ids.evaluationId },
    };
  }

  // The deny is committed durably at DECISION_RECORDED. Produce the emission, then advance the row to
  // RESPONSE_EMITTED (R1-4). The DECISION_RECORDED commit is durable before this point, so a crash in
  // the post-commit window leaves an honest DECISION_RECORDED, never NO_DECISION; the actual stdout
  // write of this response is the runtime caller's, immediately after the seam returns.
  const response: EnforceHookResponse = {
    permissionDecision: "deny",
    reason: buildDenyReason(ruleId, payload, target),
  };
  advanceDenyEmissionToResponseEmitted(store, deny.attemptId);
  return {
    response,
    outcome: {
      kind: "DENIED",
      attemptId: deny.attemptId,
      evaluationId: deny.evaluationId,
      ruleVersionId: version.versionId,
      canonicalPayloadHash: version.canonicalPayloadHash,
      inputAuthorityConfigHash: inputAuthority.configHash,
    },
  };
}

/**
 * The PROHIBIT forbidden-root family: the one rule shape R1's evaluator and deny-admission kernel can
 * enforce today, and (proposal §2.0) the shape that is conflict-free BY CONSTRUCTION. A rule is in the
 * family when it PROHIBITs (never an effect that could effectively REQUIRE an action, which is the
 * precondition for a conflict), is action-scoped (ambient rules are prompt-time grounding, not action
 * gates), and carries a non-empty forbidden root for the path evaluator to face. Everything else is the
 * R4 frontier the dispatch refuses to reason about.
 */
function isProhibitForbiddenRootFamily(payload: RulePayloadV1): boolean {
  return (
    payload.effect === "PROHIBIT" &&
    payload.applicability.mode === "action" &&
    typeof payload.compliance?.config?.forbiddenRootRelativePath === "string" &&
    payload.compliance.config.forbiddenRootRelativePath.length > 0
  );
}

/**
 * The rule-driven enforce dispatch (R4, conflict mechanization P0.13). Faces ONE tool attempt against
 * EVERY LIVE rule in the scope, not just the notes pilot, by delegating per rule to the proven
 * single-rule seam ({@link evaluateAndEnforceNotesVersion}) with that rule's id. Each delegated face
 * writes its own attempt+eval arm, so the 1-attempt:N-evaluations schema is realized as N attempts that
 * each record their own rule's verdict (the deliberately conservative reuse of the armed-deny machinery
 * over a risky single-attempt linearization refactor).
 *
 * Two invariants make this safe:
 *
 *   1. R4 conflict-safety guard (three-class partition, P0.13). We can prove the absence of conflicts in
 *      two cases, and only those. (a) WITHIN the PROHIBIT forbidden-root family (§2.0: a conflict needs an
 *      effect that effectively REQUIRES an action, which PROHIBIT never does, so any number of PROHIBIT
 *      forbidden-root rules are mutually compatible) the rule is enforceable and we face it. (b) A
 *      provably INERT rule (one whose response ceiling is RECORD_ONLY, per {@link isInertNonEnforcingRule})
 *      imposes no effect at all on the attempt; no effect cannot be incompatible with a PROHIBIT deny, so
 *      it is non-conflicting by construction and we SKIP it. The moment a LIVE rule is NEITHER (an effect
 *      that could require an action, an unrecognized schema, a payload that will not parse) we cannot rule
 *      out a conflict, so we fail OPEN for the WHOLE attempt (R4_UNSUPPORTED_RULE_KIND) rather than enforce
 *      a deny we cannot reason about. The inert-skip is what lets a CE0 consult-evidence rule coexist in
 *      the same scope as the deny pilot without disarming it; the fail-open boundary for the genuinely
 *      unrecognized is unchanged.
 *
 *   2. Deterministic single block. Rules are faced in ruleId order (the repo returns them ordered by
 *      rule_id). The dispatch STOPS at the first deny: the family is conflict-free, so the lowest-ruleId
 *      deny is a deterministic, sufficient single block (the action is blocked once; the remaining rules
 *      need not run). Rules faced before the winner have already recorded their honest OBSERVE arms.
 *
 * Returns one of two distinct observe-fallback triggers when no enforceable rule is armed: NO_LIVE_VERSION
 * when the scope is literally empty, or ONLY_INERT_RULES when live rules exist but every one is provably
 * inert (RECORD_ONLY). Both are kept distinct from NOT_APPLICABLE (enforceable rules exist but none selected
 * this call), and from each other so the audit never claims "no live version" when an inert rule is live.
 */
export async function evaluateAndEnforceLiveRules(
  store: Ce0Store,
  input: EvaluateAndEnforceInput,
): Promise<{ response: EnforceHookResponse; outcome: EnforceOutcome }> {
  const liveVersions = listLiveLocalRuleVersions(store, input.runtimeScopeId);
  if (liveVersions.length === 0) {
    return { response: PASS_THROUGH, outcome: { kind: "NO_LIVE_VERSION" } };
  }

  // Invariant 1: partition the LIVE rules into THREE classes (generalized-R4, P0.13). (a) An ENFORCEABLE
  // family rule (PROHIBIT forbidden-root) is collected to be faced. (b) A provably INERT rule (one whose
  // response ceiling is RECORD_ONLY, so it imposes no effect on the attempt and CANNOT conflict with a
  // PROHIBIT deny) is SKIPPED: its presence neither enforces nor poisons the attempt, which is exactly
  // what lets a CE0 consult-evidence rule coexist with the live deny pilot instead of disarming it. (c)
  // Anything else is the R4 frontier we cannot reason about, so we fail OPEN for the whole attempt. A
  // payload that will not even parse is, a fortiori, one we cannot reason about: fail open.
  const enforceable: LocalRuleVersionRecord[] = [];
  for (const version of liveVersions) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(version.rulePayload);
    } catch {
      payload = null;
    }
    if (payload && isProhibitForbiddenRootFamily(payload as RulePayloadV1)) {
      enforceable.push(version);
      continue;
    }
    if (isInertNonEnforcingRule(payload)) {
      continue;
    }
    return {
      response: PASS_THROUGH,
      outcome: { kind: "R4_UNSUPPORTED_RULE_KIND", ruleId: version.ruleId },
    };
  }

  // Only inert rules were live: no ENFORCEABLE armed rule exists, so the enforce path has nothing to
  // enforce and hands off to the R0 observe substrate exactly as an empty scope would. ONLY_INERT_RULES (not
  // NO_LIVE_VERSION) records that the scope was NOT empty: a live inert rule existed but imposed no effect.
  // The composed seam folds it into the observe fallback identically; the distinct tag keeps the audit honest.
  if (enforceable.length === 0) {
    return { response: PASS_THROUGH, outcome: { kind: "ONLY_INERT_RULES" } };
  }

  // Invariant 2: face each in-family rule in ruleId order; stop at the first deny.
  let firstNonDeny: { response: EnforceHookResponse; outcome: EnforceOutcome } | null = null;
  for (const version of enforceable) {
    const perRule = await evaluateAndEnforceNotesVersion(store, { ...input, ruleId: version.ruleId });
    switch (perRule.outcome.kind) {
      case "DENIED":
        return perRule;
      case "INFRA":
        // Input-level (malformed hook payload / missing session): identical for every rule, so the
        // first rule's diagnosis is the attempt's diagnosis.
        return perRule;
      case "OBSERVED":
      case "ENFORCEMENT_UNAVAILABLE":
        // Applicable but did not (could not) deny. Remember the first such outcome so the aggregate
        // reports an applicable-but-not-denied attempt rather than a spurious NOT_APPLICABLE.
        if (!firstNonDeny) firstNonDeny = perRule;
        break;
      case "NOT_APPLICABLE":
      case "NO_LIVE_VERSION":
        // NOT_APPLICABLE: this rule's matcher did not select the call. NO_LIVE_VERSION: the version was
        // revoked between the list and the face (a benign race). Both are skips for this rule.
        break;
      case "R4_UNSUPPORTED_RULE_KIND":
        // Unreachable (the guard above already rejected any out-of-family rule); fail open defensively.
        return perRule;
    }
  }

  // No rule denied. Surface the first applicable rule's outcome if any; otherwise no matcher selected
  // this call and the attempt is NOT_APPLICABLE.
  return firstNonDeny ?? { response: PASS_THROUGH, outcome: { kind: "NOT_APPLICABLE" } };
}

/** Everything the composed enforce-or-observe seam needs: the full enforce input plus the scanned
 * directives that source the R0 observed substrate when no LIVE version is armed. */
export interface EvaluateEnforceOrObserveInput extends EvaluateAndEnforceInput {
  /** The scanned directives (the scan cache's `directives`); the observe fallback selects the pilot
   * directive from these to mint the attestable observed snapshot. */
  directives: Directive[];
}

/**
 * The composed PreToolUse seam the live hook calls (proposal §3.6: observe is the always-on R0
 * substrate, enforce layers on the human-attested LIVE version). It ENFORCES against the LIVE attested
 * version when one exists; otherwise (NO_LIVE_VERSION) it records the R0 observed substrate so a rule
 * that has never been attested still leaves an attestable observed snapshot. This closes the bootstrap
 * gap: enforce-only writes nothing when unarmed, so an empty store could never produce the snapshot an
 * operator attests from. Observe never grants, so the fallback's response stays pass-through; the deny
 * path is reached only through the enforce seam against an attested version, never through observe.
 */
export async function evaluateEnforceOrObserveNotesRule(
  store: Ce0Store,
  input: EvaluateEnforceOrObserveInput,
): Promise<{ response: EnforceHookResponse; outcome: EnforceOutcome | R0DurableOutcome }> {
  const enforced = await evaluateAndEnforceLiveRules(store, input);
  // Both NO_LIVE_VERSION (empty scope) and ONLY_INERT_RULES (live rules exist but all are inert) mean no
  // enforceable version is armed, so both hand off to the R0 observe substrate. The two tags are kept
  // distinct in the dispatch outcome for audit honesty, but the fallback decision is identical here.
  const k = enforced.outcome.kind;
  if (k !== "NO_LIVE_VERSION" && k !== "ONLY_INERT_RULES") {
    return enforced;
  }
  const observed = await observeAndRecordNotesRule(store, {
    rawStdin: input.rawStdin,
    directives: input.directives,
    runtimeProjectRoot: input.runtimeProjectRoot,
    runtimeScopeId: input.runtimeScopeId,
    createdAt: input.createdAt,
    now: input.now,
    rand: input.rand,
    classifyRuntime: input.classifyRuntime,
  });
  return { response: observed.response, outcome: observed.outcome };
}
