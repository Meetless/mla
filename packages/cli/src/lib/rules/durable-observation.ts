import { Ce0Store } from "./ce0-store";
import {
  EvaluationInputV1,
  EvaluationTarget,
  evaluationInputHash,
  serializeEvaluationInput,
} from "./evaluation-input-hash";
import {
  insertRuleEvaluationRecord,
  insertToolAttempt,
  RuleEvaluationRecord,
  ToolAttemptRecord,
} from "./interception-store";
import { observedRuleHash, serializeObservedRule } from "./observed-rule-hash";
import { buildObservedNotesRuleSpec, selectNotesLocationDirective } from "./notes-rule";
import { classifyRuntimeTarget } from "./notes-path";
import { ObserveHookResponse, parsePreToolUseInput } from "./observe-adapter";
import { selectRule, ToolCall } from "./evaluator";
import { ComplianceEvaluatorConfig, ObservedRuleSpec, VerdictReasonCode } from "./types";
import { RandInt32, ulid } from "./ulid";
import { Directive } from "../scanner/types";

// Persistence slice 3 (proposal §10.1): the durable R0 observation seam. The observe-only
// pipeline computed a verdict in process but persisted NOTHING; this module gives an applicable
// interception a durable home. On an applicable Write/Edit of a Markdown file it mints two local
// ULIDs and writes, in ONE transaction, a tool_attempt (carrying the canonical evaluation-input-v1
// snapshot + hash) and one observed-arm rule_evaluation_record. Then it returns the same empty,
// decision-free hook response the observe slice always returned.
//
// Two invariants make the durable record trustworthy, both load-bearing for the Slice 6 replay:
//   - The persisted verdict is derived PURELY from the stored target + forbidden root by
//     verdictFromEvaluationInput. The host-aware classifyTargetPath stays a side channel; only this
//     snapshot-pure verdict is persisted, so a replay over the stored snapshot reproduces it exactly.
//   - Observe never grants: the attempt is NO_DECISION / NOT_APPLICABLE deny status and the
//     evaluation arm is OBSERVE/OBSERVE with no attested version (rule_version_id NULL).
//
// NOT_APPLICABLE (no rule, wrong tool, glob non-match) and INFRA (malformed payload, missing
// session id, misconfigured pilot) persist nothing: an absent rule is not an observation, and an
// MLA infrastructure-health fact is never a rule verdict.

// The evaluation-input-v1 version triple. These pin the exact contract the four-state evaluator,
// the action-applicability matcher, and the notes-path canonicalizer agreed on; they are part of
// the persisted snapshot and MUST equal the Slice 4 golden-vector corpus values byte-for-byte.
export const EVALUATOR_CONTRACT_VERSION = "four-state-evaluator-v1";
export const MATCHER_SCHEMA_VERSION = "action-applicability-v1";
export const PATH_CANONICALIZER_VERSION = "notes-path-v1";

/**
 * The one canonical spelling of a forbidden root: no leading "./", no trailing slash.
 *
 * The prefix test below is `path === root || path.startsWith(root + "/")`. A root stored with the
 * trailing slash a human naturally types ("legacy/") therefore tests `startsWith("legacy//")`, which
 * NOTHING can match. Such a rule mints, lists, syncs into the bundle, and renders as ACTIVE at its
 * attested ceiling, and enforces nothing at all. It is a rule that lies.
 *
 * Both sides of the wire normalize. The writer (`rules attest --forbidden-root`) pins the stored
 * spelling so no new rule is born inert. The reader normalizes too, because rule payloads are
 * immutable history: every "legacy/" rule already minted in the field starts enforcing what its
 * author meant. Widening here can only ever turn an inert rule live; it cannot change the verdict of
 * any rule that already matched, because a trailing-slash root matched no path in the first place.
 * Replay stays deterministic: normalization is pure, and a snapshot replays to the same verdict the
 * live evaluation now returns.
 */
export function normalizeForbiddenRoot(forbiddenRootRelativePath: string): string {
  return forbiddenRootRelativePath.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * The ONE operator-facing spelling of a rule's root, for BOTH families.
 *
 * A forbidden root renders normalized and slash-suffixed ("legacy/"): the evaluator normalizes before
 * it matches, so rendering the stored string would show the operator a root that is not the one they
 * were actually judged against. A note vault renders as its bare absolute path, where a trailing slash
 * would be noise.
 *
 * Every surface that names a root to a human goes through here: the mint-time attestation prompt and
 * every enforcement reason string. That is the point. These two drifted once already, so the prompt
 * asked the operator to confirm "legacy" while every later block said "legacy/". One helper means the
 * confirmation and the block can never again name the root differently.
 */
export function displayComplianceRoot(config: ComplianceEvaluatorConfig): string {
  return "forbiddenRootRelativePath" in config
    ? `${normalizeForbiddenRoot(config.forbiddenRootRelativePath)}/`
    : config.allowedRootAbsolutePath;
}

/** The snapshot-pure verdict: the SOLE rule by which a stored observation (and its later replay)
 * derives a three-state result from the stored target + forbidden root. It is a pure string
 * comparison over the already-canonicalized posix relative path, with no filesystem probe, so a
 * replay from the snapshot alone is deterministic. The prefix test is boundary-correct: a sibling
 * of the forbidden root (e.g. "notes-archive/x.md" against "notes") is NOT under it. */
export function verdictFromEvaluationInput(
  target: EvaluationTarget,
  forbiddenRootRelativePath: string,
): { result: "COMPLIANT" | "VIOLATION" | "UNKNOWN"; verdictReasonCode: VerdictReasonCode } {
  switch (target.kind) {
    case "UNKNOWN":
      return { result: "UNKNOWN", verdictReasonCode: "CANONICALIZATION_FAILED" };
    case "OUTSIDE_RUNTIME_SCOPE":
      return { result: "COMPLIANT", verdictReasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT" };
    case "RUNTIME_RELATIVE": {
      const root = normalizeForbiddenRoot(forbiddenRootRelativePath);
      // An empty root (a rule forbidding the repo root) stays inert here, exactly as before: a
      // runtime-relative path is never "" and never starts with "/". The mint-time admission gate
      // (FORBIDDEN_ROOT_EMPTY) is what rejects it, and it stays the only place that decides.
      const underForbidden = root.length > 0 && (target.path === root || target.path.startsWith(root + "/"));
      return underForbidden
        ? { result: "VIOLATION", verdictReasonCode: "FORBIDDEN_PATH_MATCH" }
        : { result: "COMPLIANT", verdictReasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT" };
    }
  }
}

/** The three-state verdict recomputed by a replay. Same shape as verdictFromEvaluationInput's
 * return, surfaced as a named type so a replay caller (e.g. the Slice 6 acceptance gate) can hold
 * it without re-importing the inline literal. */
export interface R0ReplayVerdict {
  result: "COMPLIANT" | "VIOLATION" | "UNKNOWN";
  verdictReasonCode: VerdictReasonCode;
}

/**
 * Replay the durable R0 verdict from a tool_attempt's stored evaluation_input_snapshot ALONE
 * (proposal §10.2 R0-5). Parses the canonical evaluation-input-v1 JSON and re-derives the verdict
 * via verdictFromEvaluationInput over its `target` + `forbiddenRootRelativePath`. It reads no
 * version table, no rule_evaluation_record, and never touches the filesystem: the snapshot is the
 * whole replay basis. Because recordR0Observation persisted the verdict by this very same pure rule
 * over the very same fields, a replay reproduces the stored result by construction, so a stored row
 * can be audited for tamper by re-deriving its verdict from its own snapshot.
 */
export function replayVerdictFromSnapshot(evaluationInputSnapshot: string): R0ReplayVerdict {
  const input = JSON.parse(evaluationInputSnapshot) as EvaluationInputV1;
  return verdictFromEvaluationInput(input.target, input.forbiddenRootRelativePath);
}

/** The deterministic inputs the durable core needs beyond the subject: the runtime scope the rows
 * belong to, the (non-fabricated) session id, the created_at stamp, and the ULID mint sources.
 * `now` and `rand` are injected so the build and its tests stay deterministic; production omits
 * `rand` and gets a CSPRNG. */
export interface R0PersistenceContext {
  runtimeScopeId: string;
  sessionId: string;
  createdAt: string;
  now: number;
  rand?: RandInt32;
}

/** What an applicable interception decided to persist: the tool, the canonicalized target, and the
 * observed rule spec the agent was shown. */
export interface R0ObservationSubject {
  toolName: "Write" | "Edit";
  target: EvaluationTarget;
  spec: ObservedRuleSpec;
}

/** The ids and verdict of a persisted observation, returned for the caller and the Slice 6 replay. */
export interface R0PersistResult {
  attemptId: string;
  evaluationId: string;
  result: "COMPLIANT" | "VIOLATION" | "UNKNOWN";
  verdictReasonCode: VerdictReasonCode;
}

/**
 * Persist one R0 observation as the two-record pair, atomically. Mints two distinct ULIDs (one
 * attempt, one evaluation), builds the canonical evaluation-input-v1 snapshot + hash and the inline
 * observed-rule snapshot + hash, derives the snapshot-pure verdict, and writes both rows inside a
 * single BEGIN IMMEDIATE transaction so an interception is never half-recorded. Pure of I/O beyond
 * the local store: no filesystem, no network.
 */
export function recordR0Observation(
  store: Ce0Store,
  subject: R0ObservationSubject,
  ctx: R0PersistenceContext,
): R0PersistResult {
  const attemptId = ulid(ctx.now, ctx.rand);
  const evaluationId = ulid(ctx.now, ctx.rand);

  const evaluationInput: EvaluationInputV1 = {
    toolName: subject.toolName,
    target: subject.target,
    forbiddenRootRelativePath: subject.spec.forbiddenRootRelativePath,
    evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
    matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
    pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
  };

  const verdict = verdictFromEvaluationInput(subject.target, subject.spec.forbiddenRootRelativePath);

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

  const evaluation: RuleEvaluationRecord = {
    evaluationId,
    attemptId,
    runtimeScopeId: ctx.runtimeScopeId,
    result: verdict.result,
    eligibleEnforcement: "OBSERVE",
    effectiveEnforcement: "OBSERVE",
    verdictReasonCode: verdict.verdictReasonCode,
    gateReasonCode: null,
    evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
    observedRuleSnapshot: serializeObservedRule(subject.spec),
    observedRuleHash: observedRuleHash(subject.spec),
    ruleVersionId: null,
    canonicalPayloadHash: null,
    createdAt: ctx.createdAt,
  };

  store.db
    .transaction(() => {
      insertToolAttempt(store, attempt);
      insertRuleEvaluationRecord(store, evaluation);
    })
    .immediate();

  return {
    attemptId,
    evaluationId,
    result: verdict.result,
    verdictReasonCode: verdict.verdictReasonCode,
  };
}

/** The durable outcome of one intercepted PreToolUse call. PERSISTED carries the written ids and
 * verdict; NOT_APPLICABLE and INFRA persist nothing (and carry no ids). */
export type R0DurableOutcome =
  | {
      kind: "PERSISTED";
      attemptId: string;
      evaluationId: string;
      result: "COMPLIANT" | "VIOLATION" | "UNKNOWN";
      verdictReasonCode: VerdictReasonCode;
    }
  | { kind: "NOT_APPLICABLE" }
  | { kind: "INFRA"; diagnostic: string };

/** Everything the durable seam needs for one interception. `rand` and `classifyRuntime` are
 * injected for deterministic, filesystem-free tests; production omits both and gets a CSPRNG and
 * the real notes-path canonicalizer. */
export interface ObserveAndRecordNotesInput {
  /** The raw PreToolUse payload: the JSON string from stdin, or an already-parsed object. */
  rawStdin: unknown;
  /** The scanned directives (the scan cache's `directives`), the source of the pilot rule. */
  directives: Directive[];
  /** The activated runtime project root (absolute). Relative targets resolve from here. */
  runtimeProjectRoot: string;
  /** The runtime scope the persisted rows belong to. */
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
 * The durable PreToolUse seam for the notes-location pilot. Parses the hook payload, selects the
 * pilot directive, runs the pure selector, classifies the target, and on an applicable call persists
 * the two-record observation. Always returns the empty, decision-free hook response; the durable
 * outcome travels on the side channel.
 *
 * Skip semantics (persist nothing): a malformed payload or a missing session id is INFRA (a hook
 * without a session id is malformed; we refuse to fabricate the NOT NULL session_id); no declared
 * rule, a non-Write/Edit tool, or a glob non-match is NOT_APPLICABLE; a misconfigured pilot
 * descriptor is INFRA.
 */
export async function observeAndRecordNotesRule(
  store: Ce0Store,
  input: ObserveAndRecordNotesInput,
): Promise<{ response: ObserveHookResponse; outcome: R0DurableOutcome }> {
  const parsed = parsePreToolUseInput(input.rawStdin);
  if (!parsed) {
    return { response: NO_DECISION, outcome: { kind: "INFRA", diagnostic: "malformed hook input" } };
  }
  // tool_attempt.session_id is NOT NULL and we never fabricate identity: a payload without one is
  // an infrastructure fault, not an observation.
  if (parsed.session_id === undefined) {
    return { response: NO_DECISION, outcome: { kind: "INFRA", diagnostic: "missing session_id" } };
  }

  const directive = selectNotesLocationDirective(input.directives);
  if (!directive) {
    return { response: NO_DECISION, outcome: { kind: "NOT_APPLICABLE" } };
  }

  const built = buildObservedNotesRuleSpec(directive);
  if (!built.ok) {
    return { response: NO_DECISION, outcome: { kind: "INFRA", diagnostic: built.diagnostic } };
  }
  const spec = built.spec;

  const call: ToolCall = { toolName: parsed.tool_name, toolInput: parsed.tool_input };
  if (selectRule(call, spec.applicability) === "NOT_APPLICABLE" || spec.applicability.mode !== "action") {
    return { response: NO_DECISION, outcome: { kind: "NOT_APPLICABLE" } };
  }

  // The selector proved the tool is in the pilot's {Write, Edit} list and the matcher field holds a
  // *.md string, so this narrowing is sound.
  const toolName = parsed.tool_name as "Write" | "Edit";
  const rawFilePath = parsed.tool_input[spec.applicability.matcher.field];

  const classify = input.classifyRuntime ?? classifyRuntimeTarget;
  const target = await classify(rawFilePath, input.runtimeProjectRoot);

  const persisted = recordR0Observation(
    store,
    { toolName, target, spec },
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
      kind: "PERSISTED",
      attemptId: persisted.attemptId,
      evaluationId: persisted.evaluationId,
      result: persisted.result,
      verdictReasonCode: persisted.verdictReasonCode,
    },
  };
}
