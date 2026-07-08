import { RuleEvaluation, VerdictReasonCode } from "./types";
import { ToolCall } from "./evaluator";
import { evaluateLocalMatcher, LocalMatcherRule } from "./local-matcher";
import { parsePreToolUseInput } from "./observe-adapter";

// GAP2 slice 4 (the SAFE half): run the observe-only CONTENT and COMMAND matchers
// against the REAL PreToolUse hook payload and return the per-rule observations.
//
// What this slice deliberately does NOT do: persist. The live deny pilot records
// observations into the CE0 store keyed by an observed-rule snapshot + hash. The
// content/command families have no attested version and no agreed identity/hash
// shape yet; minting one is the document agent's open schema lane (see the sibling
// note in local-matcher.ts). So this slice computes exactly the observations a
// future recording slice will persist once that contract lands, and proves the
// matchers run end-to-end against the real wire shape. It touches neither the live
// hot path nor the notes-location DENY pilot.
//
// Fail-open is total: a payload that does not parse as a usable PreToolUse call
// yields an empty observation list, never a throw. parsePreToolUseInput is the same
// total parser the notes-path adapter uses, so the wire contract stays single-sourced.

/** One rule's verdict against a single observed tool call. */
export interface LocalObservation {
  ruleId: string;
  result: RuleEvaluation;
  reasonCode: VerdictReasonCode;
}

/** A candidate observe-only rule, carrying a stable id for telemetry. */
export interface IdentifiedLocalRule {
  id: string;
  rule: LocalMatcherRule;
}

/**
 * Evaluate every supplied local matcher rule against a raw PreToolUse payload
 * (an object or the JSON string delivered on stdin). Rules that do not select the
 * call (wrong tool) are omitted; only rules that actually applied contribute an
 * observation. A payload that is not a usable PreToolUse call yields [].
 */
export function observeLocalMatchers(
  rawInput: unknown,
  rules: readonly IdentifiedLocalRule[],
): LocalObservation[] {
  const parsed = parsePreToolUseInput(rawInput);
  if (parsed === null) {
    return [];
  }
  const call: ToolCall = { toolName: parsed.tool_name, toolInput: parsed.tool_input };

  const observations: LocalObservation[] = [];
  for (const { id, rule } of rules) {
    const verdict = evaluateLocalMatcher(call, rule);
    if (verdict !== null) {
      observations.push({ ruleId: id, result: verdict.result, reasonCode: verdict.reasonCode });
    }
  }
  return observations;
}

// Candidate observe-only rules derived directly from An's own documented rules
// (global CLAUDE.md + this repo's feedback memory). They are DATA, not armed: nothing
// in this slice wires them onto the hot path or denies on them. They exist so the
// future recording/arming slice (An-owned, once the identity contract lands) has a
// concrete, well-formed starting set rather than an empty one. Each is a sound,
// observe-only matcher: a CONTENT rule produces a real COMPLIANT/VIOLATION (the field
// is fully observable); a COMMAND rule only ever produces VIOLATION-or-UNKNOWN.
export const BUILTIN_LOCAL_OBSERVE_RULES: readonly IdentifiedLocalRule[] = [
  {
    // An's #1 AI-smell rule: never write an em dash or a double dash into a file.
    id: "no-em-dash-or-double-dash-in-writes",
    rule: {
      kind: "content",
      tools: ["Write", "Edit"],
      fields: ["content", "new_string"],
      forbiddenSubstrings: ["—", "--"],
    },
  },
  {
    // "push only when explicitly asked" (merge != push).
    id: "no-unrequested-git-push",
    rule: {
      kind: "command",
      tools: ["Bash"],
      fields: ["command"],
      forbiddenSequences: [["git", "push"]],
    },
  },
  {
    // "NEVER create feature branches; work directly on main."
    id: "no-feature-branch",
    rule: {
      kind: "command",
      tools: ["Bash"],
      fields: ["command"],
      forbiddenSequences: [
        ["git", "checkout", "-b"],
        ["git", "switch", "-c"],
      ],
    },
  },
  {
    // "never hand-roll prisma migrate deploy; use make test-db."
    id: "no-hand-rolled-prisma-migrate-deploy",
    rule: {
      kind: "command",
      tools: ["Bash"],
      fields: ["command"],
      forbiddenSequences: [["prisma", "migrate", "deploy"]],
    },
  },
];
