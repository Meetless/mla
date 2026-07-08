import { classifyCommand, CommandClassification } from "./command-match";
import { classifyContent, ContentClassification } from "./content-match";
import {
  EvaluationResult,
  ToolCall,
  verdictForForbiddenCommand,
  verdictForForbiddenContent,
} from "./evaluator";
import { ToolName } from "./types";

// GAP2 slice 3: the observe-only dispatcher for the CONTENT and COMMAND matcher
// families. It turns the pure classifiers into a per-tool-call four-state verdict.
//
// LocalMatcherRule is a SIBLING of the hashed RuleApplicability, deliberately NOT
// an extension of it. RuleApplicability lives inside canonicalPayloadHash (the
// attested-rule identity), and these matchers are OBSERVE-ONLY in this slice: they
// are never attested, never enter the hashed payload, and never deny. Keeping them
// in their own value type means the notes-path golden vectors and the document
// agent's still-open schema contract are untouched. Promotion to an attested,
// enforceable rule is a future slice that, when that contract lands, adds a
// discriminated matcher kind to RuleApplicability additively (absent kind => every
// existing path rule serializes byte-identically, so its hash is unchanged).
//
// Unlike the notes-path adapter this is pure and synchronous: no filesystem I/O,
// no canonicalization, no timeout. Selection is tool membership; the verdict reads
// the named payload field(s) directly.

/** An observe-only rule over a fully-observable Write/Edit payload field. */
export interface LocalContentRule {
  kind: "content";
  tools: ToolName[];
  /** The payload fields to inspect, e.g. ["content", "new_string"]. */
  fields: string[];
  /** Codepoint-exact forbidden substrings, e.g. ["—", "--"]. */
  forbiddenSubstrings: string[];
}

/** An observe-only rule over a Bash command string. */
export interface LocalCommandRule {
  kind: "command";
  tools: ToolName[];
  /** The payload fields to inspect, typically ["command"]. */
  fields: string[];
  /** Forbidden contiguous token runs, e.g. [["git", "push"]]. */
  forbiddenSequences: string[][];
}

export type LocalMatcherRule = LocalContentRule | LocalCommandRule;

/**
 * Evaluate a tool call against an observe-only local matcher rule. Returns null
 * when the rule does not select this call (the tool is not in its list), which is
 * distinct from an applied rule that returns UNKNOWN. When it applies, the verdict
 * is the reduction over every named field:
 *   - content: any field CONTAINS_FORBIDDEN wins (VIOLATION); else any provably
 *     clean string field is COMPLIANT; else INDETERMINATE (UNKNOWN). A present,
 *     clean field is not dragged down by an absent sibling field.
 *   - command: any field MATCHES_FORBIDDEN wins (VIOLATION); else NO_MATCH
 *     (UNKNOWN, opaque, never COMPLIANT); else INDETERMINATE (UNKNOWN).
 */
export function evaluateLocalMatcher(call: ToolCall, rule: LocalMatcherRule): EvaluationResult | null {
  if (!rule.tools.includes(call.toolName)) {
    return null;
  }
  const values = rule.fields.map((field) => call.toolInput[field]);

  if (rule.kind === "content") {
    const classes = values.map((v) => classifyContent(v, rule.forbiddenSubstrings));
    return verdictForForbiddenContent(reduceContent(classes));
  }
  const classes = values.map((v) => classifyCommand(v, rule.forbiddenSequences));
  return verdictForForbiddenCommand(reduceCommand(classes));
}

/** A forbidden hit anywhere wins; else a provable clean read; else indeterminate. */
function reduceContent(classes: ContentClassification[]): ContentClassification {
  if (classes.includes("CONTAINS_FORBIDDEN")) {
    return "CONTAINS_FORBIDDEN";
  }
  if (classes.includes("NO_FORBIDDEN")) {
    return "NO_FORBIDDEN";
  }
  return "INDETERMINATE";
}

/** A forbidden hit anywhere wins; else an opaque non-match; else indeterminate. */
function reduceCommand(classes: CommandClassification[]): CommandClassification {
  if (classes.includes("MATCHES_FORBIDDEN")) {
    return "MATCHES_FORBIDDEN";
  }
  if (classes.includes("NO_MATCH")) {
    return "NO_MATCH";
  }
  return "INDETERMINATE";
}

/** Outcome of validating a raw local matcher rule descriptor. */
export interface LocalMatcherParseResult {
  status: "OK" | "INVALID";
  rule?: LocalMatcherRule;
  diagnostic?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
}

function invalid(diagnostic: string): LocalMatcherParseResult {
  return { status: "INVALID", diagnostic };
}

/**
 * Validate an untrusted local matcher rule descriptor (e.g. read from disk). A
 * misconfiguration that could never fire usefully (empty tools, empty fields, no
 * usable forbidden needle) is rejected at parse time rather than silently always
 * returning UNKNOWN at evaluation time.
 */
export function parseLocalMatcherRule(raw: unknown): LocalMatcherParseResult {
  if (!isPlainObject(raw)) {
    return invalid("rule must be an object");
  }
  if (!isNonEmptyStringArray(raw.tools)) {
    return invalid("tools must be a non-empty array of non-empty strings");
  }
  if (!isNonEmptyStringArray(raw.fields)) {
    return invalid("fields must be a non-empty array of non-empty strings");
  }

  if (raw.kind === "content") {
    if (!isNonEmptyStringArray(raw.forbiddenSubstrings)) {
      return invalid("content rule needs at least one non-empty forbidden substring");
    }
    return {
      status: "OK",
      rule: {
        kind: "content",
        tools: [...raw.tools],
        fields: [...raw.fields],
        forbiddenSubstrings: [...raw.forbiddenSubstrings],
      },
    };
  }

  if (raw.kind === "command") {
    const sequences = raw.forbiddenSequences;
    if (
      !Array.isArray(sequences) ||
      sequences.length === 0 ||
      !sequences.every((seq) => isNonEmptyStringArray(seq))
    ) {
      return invalid("command rule needs at least one non-empty forbidden token sequence");
    }
    return {
      status: "OK",
      rule: {
        kind: "command",
        tools: [...raw.tools],
        fields: [...raw.fields],
        forbiddenSequences: (sequences as string[][]).map((seq) => [...seq]),
      },
    };
  }

  return invalid(`unknown matcher kind: ${String(raw.kind)}`);
}
