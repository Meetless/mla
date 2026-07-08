import { CommandClassification } from "./command-match";
import { ContentClassification } from "./content-match";
import { matchesGlob } from "./glob-match";
import {
  PathClassification,
  RuleApplicability,
  RuleEvaluation,
  VerdictReasonCode,
} from "./types";

// R0 pure selector + four-state evaluator. Deliberately free of I/O and
// persistence: it decides applicability from the in-memory rule and maps a
// pre-computed path classification to a verdict. The actual path canonicalization
// (the I/O) lives in the notes-path matcher; the observe-only adapter wires the
// two together.

/** A normalized view of a tool invocation, as carried by the PreToolUse hook. */
export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export type SelectionResult = "APPLIES" | "NOT_APPLICABLE";

export interface EvaluationResult {
  result: RuleEvaluation;
  reasonCode: VerdictReasonCode;
}

// The glob matcher is now shared with the injection assembler (lib/rules/glob-match.ts),
// the §4.7 "one matcher across both planes" guarantee.

/**
 * Pure selection. Ambient rules are prompt-time grounding, not action gates:
 * they never produce a per-call verdict, so at an action point they are
 * NOT_APPLICABLE. An action rule applies when the tool is in its list and,
 * if the matcher carries a glob, the named field holds a string matching it.
 *
 * A `turn` rule is prompt-time injection (Layer B), never an action gate: the
 * §5.4 read boundary routes it to the assembler and it must never reach this
 * selector. If one does, that is a routing bug, not a NOT_APPLICABLE: fail loud
 * rather than silently swallow a mis-routed rule (invariant #1). This also lets
 * TS narrow `applicability` to the action variant for the `.tools`/`.matcher`
 * accesses below.
 */
export function selectRule(call: ToolCall, applicability: RuleApplicability): SelectionResult {
  if (applicability.mode === "ambient") {
    return "NOT_APPLICABLE";
  }
  if (applicability.mode === "turn") {
    throw new Error(
      "selectRule received a turn-mode applicability; turn rules are prompt-time " +
        "injection, never action gates (targeted-rule-injection §5.4 invariant #1)",
    );
  }

  if (!applicability.tools.includes(call.toolName)) {
    return "NOT_APPLICABLE";
  }

  const { matcher } = applicability;
  if (matcher.glob !== undefined) {
    const value = call.toolInput[matcher.field];
    if (typeof value !== "string" || !matchesGlob(value, matcher.glob)) {
      return "NOT_APPLICABLE";
    }
  }

  return "APPLIES";
}

/**
 * Pure verdict for a PROHIBIT forbidden-root rule. Maps the path classification
 * (or the "UNSUPPORTED" sentinel from an evaluator that cannot handle the input)
 * to a four-state verdict. The only enforcement-eligible outcome is VIOLATION;
 * every uncertainty degrades to UNKNOWN.
 */
export function verdictForForbiddenRoot(
  classification: PathClassification | "UNSUPPORTED",
): EvaluationResult {
  switch (classification) {
    case "UNDER_FORBIDDEN_ROOT":
      return { result: "VIOLATION", reasonCode: "FORBIDDEN_PATH_MATCH" };
    case "OUTSIDE_FORBIDDEN_ROOT":
      return { result: "COMPLIANT", reasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT" };
    case "INDETERMINATE":
      return { result: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" };
    case "UNSUPPORTED":
      return { result: "UNKNOWN", reasonCode: "EVALUATOR_UNSUPPORTED" };
  }
}

/**
 * Pure verdict for a PROHIBIT forbidden-content rule (the em-dash-ban class).
 * Unlike the path/command matchers, a content field is fully observable, so a
 * "no needle" result is a genuine COMPLIANT rather than an UNKNOWN: we hold the
 * entire payload, so absence of the forbidden bytes is proven, not merely
 * unobserved. INDETERMINATE (non-string field or empty needle set) degrades to
 * UNKNOWN, which never asks or denies.
 */
export function verdictForForbiddenContent(
  classification: ContentClassification,
): EvaluationResult {
  switch (classification) {
    case "CONTAINS_FORBIDDEN":
      return { result: "VIOLATION", reasonCode: "FORBIDDEN_CONTENT_MATCH" };
    case "NO_FORBIDDEN":
      return { result: "COMPLIANT", reasonCode: "COMPLIANT_NO_FORBIDDEN_CONTENT" };
    case "INDETERMINATE":
      return { result: "UNKNOWN", reasonCode: "CONTENT_INDETERMINATE" };
  }
}

/**
 * Pure verdict for a PROHIBIT forbidden-command rule (the git/prisma class). The
 * inverse of the content verdict: because a shell string is opaque, there is NO
 * COMPLIANT outcome. Only a positive literal token-run match is a verdict
 * (VIOLATION); both NO_MATCH and INDETERMINATE degrade to UNKNOWN, since a
 * non-match cannot prove the command will not perform the operation (an alias, a
 * wrapper script, eval, or $VAR expansion could). The distinct UNKNOWN reason
 * codes keep "tokenized, found nothing" observably separate from "could not
 * evaluate".
 */
export function verdictForForbiddenCommand(
  classification: CommandClassification,
): EvaluationResult {
  switch (classification) {
    case "MATCHES_FORBIDDEN":
      return { result: "VIOLATION", reasonCode: "FORBIDDEN_COMMAND_MATCH" };
    case "NO_MATCH":
      return { result: "UNKNOWN", reasonCode: "COMMAND_NO_MATCH_OPAQUE" };
    case "INDETERMINATE":
      return { result: "UNKNOWN", reasonCode: "COMMAND_INDETERMINATE" };
  }
}

/** Only VIOLATION is potentially enforcement-eligible. */
export function isEnforcementEligible(result: RuleEvaluation): boolean {
  return result === "VIOLATION";
}
