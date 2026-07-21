import { Ce0Store } from "./ce0-store";
import {
  EvaluationInputV1,
  EvaluationTarget,
  evaluationInputHash,
  serializeEvaluationInput,
} from "./evaluation-input-hash";
import {
  insertToolAttempt,
  ToolAttemptRecord,
} from "./interception-store";
import {
  getLiveLocalRuleVersion,
  insertVersionEvaluationRecord,
  LocalRuleVersionRecord,
  VersionEvaluationInput,
} from "./local-rule-version-repo";
import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
  verdictFromEvaluationInput,
} from "./durable-observation";
import { classifyRuntimeTarget } from "./notes-path";
import { ObserveHookResponse, parsePreToolUseInput } from "./observe-adapter";
import { selectRule, ToolCall } from "./evaluator";
import { NOTES_LOCATION_RULE_ID } from "./attest-notes-location";
import { RulePayloadV1, VerdictReasonCode } from "./types";
import { RandInt32, ulid } from "./ulid";

// Persistence slice 8 (proposal §10.1, §3.5/§3.6 the version arm of RuleEvaluationRecord): the
// version-backed evaluation seam. Once a notes-location rule has been attested (slice 7), an
// applicable interception is no longer evaluated against the live OBSERVED rule (R0); it is
// evaluated against the LIVE LocalRuleVersion's immutable RulePayloadV1, and the verdict is written
// as a VERSION-arm rule_evaluation_record carrying the version identity (ruleVersionId +
// canonicalPayloadHash). That binding is the slice's entire value-add: a stored verdict now points
// at the exact attested version it was computed from.
//
// This slice is OBSERVE-only and grants nothing. Both enforcement levels stay OBSERVE and the deny
// status stays NOT_APPLICABLE: projecting the version's DENY enforcement ceiling onto an eligible
// level, and the §10.2 gates that lower eligible to effective, are deny admission (slice 9) and are
// inseparable from it, so neither is built here. gateReasonCode stays null (nothing lowered an
// enforcement level), exactly mirroring the R0 observed arm.
//
// The one evaluation-semantics guard this slice does add (because it is evaluation, not deny
// admission): a version-backed evaluator MUST refuse to evaluate a version whose declared compliance
// contract it cannot reproduce, rather than silently applying its own semantics to a foreign rule.
// When the version's declared (evaluatorContractVersion, matcherSchemaVersion, pathCanonicalizerVersion)
// triple is not the one this MLA build supports, the verdict degrades to UNKNOWN /
// EVALUATOR_UNSUPPORTED and the path is never read. In the notes-location pilot the attest verb mints
// exactly the supported triple, so this never fires for a real pilot version; it guards the future
// case of a binary facing a rule authored under a newer contract.

/** The verdict from an attested version's payload. Mirrors R0's three-state shape. */
export interface VersionBackedVerdict {
  result: "COMPLIANT" | "VIOLATION" | "UNKNOWN";
  verdictReasonCode: VerdictReasonCode;
}

/**
 * The verdict computed FROM the attested payload. First it checks that the version's declared
 * compliance triple is the one this MLA build can reproduce; on any mismatch it refuses with UNKNOWN
 * / EVALUATOR_UNSUPPORTED WITHOUT reading the path (it cannot honor semantics it does not implement).
 * On a match it delegates to the same snapshot-pure rule R0 uses, over the payload's forbidden root,
 * so a supported-triple version evaluates byte-for-byte like the observed rule it was attested from.
 */
export function versionBackedVerdict(payload: RulePayloadV1, target: EvaluationTarget): VersionBackedVerdict {
  const c = payload.compliance;
  if (!("forbiddenRootRelativePath" in c.config)) {
    return { result: "UNKNOWN", verdictReasonCode: "EVALUATOR_UNSUPPORTED" };
  }
  const supported =
    c.evaluatorContractVersion === EVALUATOR_CONTRACT_VERSION &&
    c.matcherSchemaVersion === MATCHER_SCHEMA_VERSION &&
    c.pathCanonicalizerVersion === PATH_CANONICALIZER_VERSION;
  if (!supported) {
    return { result: "UNKNOWN", verdictReasonCode: "EVALUATOR_UNSUPPORTED" };
  }
  return verdictFromEvaluationInput(target, c.config.forbiddenRootRelativePath);
}

/** The deterministic inputs the durable version-arm writer needs beyond the subject: the runtime
 * scope the rows belong to, the (non-fabricated) session id, the created_at stamp, and the ULID mint
 * sources. `now` and `rand` are injected so the build and its tests stay deterministic; production
 * omits `rand` and gets a CSPRNG. Identical in shape to R0PersistenceContext by design. */
export interface VersionPersistenceContext {
  runtimeScopeId: string;
  sessionId: string;
  createdAt: string;
  now: number;
  rand?: RandInt32;
}

/** What an applicable interception decided to persist against an attested version: the tool, the
 * canonicalized target, and the LIVE version it is bound to. */
export interface VersionObservationSubject {
  toolName: "Write" | "Edit";
  target: EvaluationTarget;
  version: LocalRuleVersionRecord;
}

/** The ids, verdict, and version identity of a persisted version-arm evaluation. */
export interface VersionPersistResult {
  attemptId: string;
  evaluationId: string;
  result: "COMPLIANT" | "VIOLATION" | "UNKNOWN";
  verdictReasonCode: VerdictReasonCode;
  ruleVersionId: string;
  canonicalPayloadHash: string;
}

/**
 * Persist one version-backed evaluation as the two-record pair, atomically. Mints two distinct ULIDs
 * (one attempt, one evaluation), parses the version's immutable payload for its forbidden root,
 * computes the version-backed verdict, builds the canonical evaluation-input-v1 snapshot + hash, and
 * writes a tool_attempt (NO_DECISION / NOT_APPLICABLE deny status) plus one VERSION-arm
 * rule_evaluation_record inside a single BEGIN IMMEDIATE transaction so an interception is never
 * half-recorded.
 *
 * The evaluation-input-v1 snapshot carries the RUNNING evaluator's supported triple, exactly like
 * R0: those fields denote the evaluator that ran, and the version's own declared triple is recoverable
 * from the version payload behind the recorded canonicalPayloadHash. Consequently R0's snapshot-only
 * replay reproduces the stored verdict for any supported-triple version (the entire pilot); for a
 * foreign-triple version the verdict is UNKNOWN / EVALUATOR_UNSUPPORTED and its authoritative replay
 * basis is the referenced version row, not the snapshot alone.
 */
export function recordVersionEvaluation(
  store: Ce0Store,
  subject: VersionObservationSubject,
  ctx: VersionPersistenceContext,
): VersionPersistResult {
  const payload = JSON.parse(subject.version.rulePayload) as RulePayloadV1;
  const attemptId = ulid(ctx.now, ctx.rand);
  const evaluationId = ulid(ctx.now, ctx.rand);

  const evaluationInput: EvaluationInputV1 = {
    toolName: subject.toolName,
    target: subject.target,
    forbiddenRootRelativePath:
      "forbiddenRootRelativePath" in payload.compliance.config
        ? payload.compliance.config.forbiddenRootRelativePath
        : "",
    evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
    matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
    pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
  };

  const verdict = versionBackedVerdict(payload, subject.target);

  const attempt: ToolAttemptRecord = {
    attemptId,
    runtimeScopeId: ctx.runtimeScopeId,
    sessionId: ctx.sessionId,
    toolName: subject.toolName,
    evaluationInputSnapshot: serializeEvaluationInput(evaluationInput),
    evaluationInputHash: evaluationInputHash(evaluationInput),
    aggregateDecision: "NO_DECISION",
    denyEmissionStatus: "NOT_APPLICABLE",
    inputAuthorityConfigHash: null,
    createdAt: ctx.createdAt,
  };

  const evaluation: VersionEvaluationInput = {
    evaluationId,
    attemptId,
    runtimeScopeId: ctx.runtimeScopeId,
    result: verdict.result,
    eligibleEnforcement: "OBSERVE",
    effectiveEnforcement: "OBSERVE",
    verdictReasonCode: verdict.verdictReasonCode,
    gateReasonCode: null,
    evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
    ruleVersionId: subject.version.versionId,
    canonicalPayloadHash: subject.version.canonicalPayloadHash,
    createdAt: ctx.createdAt,
  };

  store.db
    .transaction(() => {
      insertToolAttempt(store, attempt);
      insertVersionEvaluationRecord(store, evaluation);
    })
    .immediate();

  return {
    attemptId,
    evaluationId,
    result: verdict.result,
    verdictReasonCode: verdict.verdictReasonCode,
    ruleVersionId: subject.version.versionId,
    canonicalPayloadHash: subject.version.canonicalPayloadHash,
  };
}

/** The durable outcome of one version-backed PreToolUse call. RECORDED carries the written ids,
 * verdict, and version identity; NO_LIVE_VERSION, NOT_APPLICABLE and INFRA persist nothing. */
export type VersionEvaluationOutcome =
  | {
      kind: "RECORDED";
      attemptId: string;
      evaluationId: string;
      result: "COMPLIANT" | "VIOLATION" | "UNKNOWN";
      verdictReasonCode: VerdictReasonCode;
      ruleVersionId: string;
      canonicalPayloadHash: string;
    }
  | { kind: "NO_LIVE_VERSION" }
  | { kind: "NOT_APPLICABLE" }
  | { kind: "INFRA"; diagnostic: string };

/** Everything the version-backed seam needs for one interception. `rand` and `classifyRuntime` are
 * injected for deterministic, filesystem-free tests; production omits both and gets a CSPRNG and the
 * real notes-path canonicalizer. The pilot rule is resolved from the LIVE attested version, not from
 * the scanned directives, so this seam takes no directive list. */
export interface EvaluateNotesVersionInput {
  /** The raw PreToolUse payload: the JSON string from stdin, or an already-parsed object. */
  rawStdin: unknown;
  /** The activated runtime project root (absolute). Relative targets resolve from here. */
  runtimeProjectRoot: string;
  /** The runtime scope whose LIVE version is faced and whose rows are written. */
  runtimeScopeId: string;
  /** The ISO timestamp stamped on both rows. */
  createdAt: string;
  /** ULID mint clock. */
  now: number;
  /** ULID randomness source; omit in production for a CSPRNG. */
  rand?: RandInt32;
  /** Runtime-scope path classifier; defaults to the real filesystem canonicalizer. */
  classifyRuntime?: (rawFilePath: unknown, runtimeProjectRoot: string) => Promise<EvaluationTarget>;
}

const NO_DECISION: ObserveHookResponse = {};

/**
 * The version-backed PreToolUse seam for the notes-location pilot. Parses the hook payload, resolves
 * the LIVE attested version for the scope, runs the pure selector against the version's applicability,
 * classifies the target, and on an applicable call persists the version-arm evaluation. Always returns
 * the empty, decision-free hook response; the durable outcome travels on the side channel.
 *
 * Skip semantics (persist nothing): a malformed payload or a missing session id is INFRA (we refuse
 * to fabricate the NOT NULL session_id); no LIVE version for the scope is NO_LIVE_VERSION (nothing has
 * been attested, so there is no version to evaluate against); a non-Write/Edit tool or a glob non-match
 * is NOT_APPLICABLE. Resolution order puts the infrastructure faults first, then the absent version,
 * then applicability, so an unattested-but-applicable call reports NO_LIVE_VERSION (not NOT_APPLICABLE).
 */
export async function evaluateAndRecordNotesVersion(
  store: Ce0Store,
  input: EvaluateNotesVersionInput,
): Promise<{ response: ObserveHookResponse; outcome: VersionEvaluationOutcome }> {
  const parsed = parsePreToolUseInput(input.rawStdin);
  if (!parsed) {
    return { response: NO_DECISION, outcome: { kind: "INFRA", diagnostic: "malformed hook input" } };
  }
  if (parsed.session_id === undefined) {
    return { response: NO_DECISION, outcome: { kind: "INFRA", diagnostic: "missing session_id" } };
  }

  const version = getLiveLocalRuleVersion(store, input.runtimeScopeId, NOTES_LOCATION_RULE_ID);
  if (!version) {
    return { response: NO_DECISION, outcome: { kind: "NO_LIVE_VERSION" } };
  }

  const payload = JSON.parse(version.rulePayload) as RulePayloadV1;
  const call: ToolCall = { toolName: parsed.tool_name, toolInput: parsed.tool_input };
  if (selectRule(call, payload.applicability) === "NOT_APPLICABLE" || payload.applicability.mode !== "action") {
    return { response: NO_DECISION, outcome: { kind: "NOT_APPLICABLE" } };
  }

  // The selector proved the tool is in the version's {Write, Edit} list and the matcher field holds a
  // *.md string, so this narrowing is sound.
  const toolName = parsed.tool_name as "Write" | "Edit";
  const rawFilePath = parsed.tool_input[payload.applicability.matcher.field];

  const classify = input.classifyRuntime ?? classifyRuntimeTarget;
  const target = await classify(rawFilePath, input.runtimeProjectRoot);

  const persisted = recordVersionEvaluation(
    store,
    { toolName, target, version },
    {
      runtimeScopeId: input.runtimeScopeId,
      sessionId: parsed.session_id,
      createdAt: input.createdAt,
      now: input.now,
      rand: input.rand,
    },
  );

  return {
    response: NO_DECISION,
    outcome: {
      kind: "RECORDED",
      attemptId: persisted.attemptId,
      evaluationId: persisted.evaluationId,
      result: persisted.result,
      verdictReasonCode: persisted.verdictReasonCode,
      ruleVersionId: persisted.ruleVersionId,
      canonicalPayloadHash: persisted.canonicalPayloadHash,
    },
  };
}
