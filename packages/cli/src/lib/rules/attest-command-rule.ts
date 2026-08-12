import {
  FORBIDDEN_COMMAND_CANONICALIZER_VERSION,
  FORBIDDEN_COMMAND_EVALUATOR_CONTRACT_VERSION,
  FORBIDDEN_COMMAND_MATCHER_SCHEMA_VERSION,
} from "./command-match";
import type { EligibleEnforcement } from "./deny-admission";
import type { RulePayloadV1 } from "./types";

// The AUTHORING half of the COMMAND family (F2, 2026-08-07). `bundle-enforce`
// owns the verdict; this owns turning what An types into the payload that
// verdict faces. They share exactly one notion of a clause, and the round-trip
// test in the sibling spec is what holds them together: a drift here mints a
// rule that reads as armed in `mla rules list` and enforces nothing, which is
// worse than no rule at all because it spends the operator's trust and buys
// nothing.

/** The typed clause separator. ` + ` reads as the conjunction it is ("this AND
 * that"), and it is the SAME string `mla rules attest` prints back in the
 * confirmation label, so the prompt and the later warning can never name the
 * rule differently. That symmetry is the notes-location lesson: the display and
 * the enforcement drifted once, and the prompt asked the operator to confirm
 * "legacy" while every block said "legacy/". */
const CLAUSE_SEPARATOR = /\s\+\s/;

export type CommandConjunctionParse =
  | { sequences: string[][]; error?: undefined }
  | { sequences?: undefined; error: string };

/**
 * Parse an operator-typed conjunction spec into the token runs the matcher reads.
 *
 *     "comp-credit.cjs + --apply"  ->  [["comp-credit.cjs"], ["--apply"]]
 *
 * Clauses split on a WHITESPACE-DELIMITED `+` only, so a `+` inside a real token
 * (`a+b`, and the `+` that terminates a `find -exec`) is left alone.
 *
 * Every malformed input is an ERROR, never a smaller conjunction. Silently
 * dropping an empty clause would REMOVE a condition and BROADEN the rule: the
 * exact inversion the matcher refuses at evaluation time. Refusing it at the
 * writer means no such rule is ever born, rather than born inert.
 */
export function parseCommandConjunction(spec: string): CommandConjunctionParse {
  if (typeof spec !== "string" || spec.trim().length === 0) {
    return { error: "a command rule needs at least one clause, e.g. --command \"comp-credit.cjs + --apply\"" };
  }
  const clauses = spec.trim().split(CLAUSE_SEPARATOR);
  const sequences: string[][] = [];
  for (const clause of clauses) {
    const tokens = clause.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return {
        error:
          `empty clause in --command "${spec}": every clause must carry at least one token. ` +
          "An empty clause would drop a condition and BROADEN the rule, so it is refused rather than ignored.",
      };
    }
    // A leading or trailing `+` has whitespace on only ONE side, so the separator
    // regex leaves it as a literal token. Nothing a governed command clause names
    // is a bare plus, and a dangling separator is overwhelmingly an authoring
    // typo, so reject it rather than mint a rule whose conjunction silently
    // requires the token "+" to appear in the command and can never fire.
    if (tokens.includes("+")) {
      return {
        error:
          `dangling '+' in --command "${spec}": a clause separator needs whitespace on BOTH sides ` +
          "and a clause on each side, e.g. \"comp-credit.cjs + --apply\".",
      };
    }
    sequences.push(tokens);
  }
  return { sequences };
}

/**
 * Build the frozen RulePayloadV1 for a COMMAND rule.
 *
 * Fixed by the family, not by the caller:
 *  - `tools: ["Bash"]` and `matcher.field: "command"`, because that is the only
 *    tool input this matcher can read;
 *  - `PROHIBIT`, because collapsing across bundle entries is only sound when
 *    every surviving entry says "block" (bundle-enforce §2.0);
 *  - `preToolUse`, because the verdict is worthless anywhere else: the whole
 *    point is to arrive while the command is still about to run.
 *
 * WARN by default (INV-8): a freshly armed rule warns before it blocks. On this
 * family that matters more than on the path families, because a cold DENY on a
 * matcher nobody has watched yet blocks a real operator action, and the first
 * false block is what would teach An to disarm the plane.
 */
export function buildForbiddenCommandPayload(input: {
  sequences: string[][];
  runtimeScopeId: string;
  text: string;
  ceiling?: EligibleEnforcement;
}): RulePayloadV1 {
  return {
    text: input.text,
    applicability: {
      mode: "action",
      tools: ["Bash"],
      matcher: { field: "command" },
    },
    compliance: {
      evaluatorContractVersion: FORBIDDEN_COMMAND_EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: FORBIDDEN_COMMAND_MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: FORBIDDEN_COMMAND_CANONICALIZER_VERSION,
      config: { forbiddenCommandAllOf: input.sequences.map((seq) => [...seq]) },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: input.ceiling ?? "WARN",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: input.runtimeScopeId,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
  };
}
