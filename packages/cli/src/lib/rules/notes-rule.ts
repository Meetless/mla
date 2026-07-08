import { parseApplicability } from "./applicability";
import { ObservedRuleSpec } from "./types";
import { Directive } from "../scanner/types";

// The R0 notes-location pilot (proposal §2.4): the single, named rule R0 observes.
// This is NOT a generic rule-language framework and deliberately stays one rule:
// its applicability, forbidden root, and effect are fixed pilot constants, and the
// scan cache's only job is to tell us whether THIS workspace actually declares the
// rule (so we observe it only where it is in force) and to hand us the exact prose
// the agent was shown. Generalizing past one rule is explicitly a later ring.

// The explicit applicability descriptor for the pilot. It is run through the same
// parseApplicability validator every other applicability passes (never inferred):
// action-scoped, file-writing tools only, gated to Markdown by the file_path field.
const NOTES_LOCATION_APPLICABILITY_DESCRIPTOR: unknown = {
  mode: "action",
  tools: ["Write", "Edit"],
  matcher: { field: "file_path", glob: "*.md" },
};

// The forbidden root the pilot protects, relative to the runtime project root. A
// Write/Edit of a Markdown file UNDER this root is the violation; anything outside
// is compliant. Kept as relative CONTENT so the rule is machine-independent.
export const NOTES_FORBIDDEN_ROOT_RELATIVE = "notes";

// The effect the rule asserts when violated. PROHIBIT: rules constrain, never grant.
const NOTES_EFFECT = "PROHIBIT" as const;

/**
 * Select the single notes-location directive out of a scanned directive set, or
 * null if this workspace declares no such rule. The predicate is deliberately
 * TIGHT (one pilot, not a classifier): a directive qualifies only when its prose
 * is about the notes/design-doc SUBJECT *and* carries a PLACEMENT sense (where it
 * must or must not live). That keeps a bare "add release notes" mention from being
 * mistaken for the rule. In observe-only R0 a false miss is a harmless
 * NOT_APPLICABLE and a false match is a harmless OBSERVED; neither can enforce.
 */
export function selectNotesLocationDirective(directives: Directive[]): Directive | null {
  return directives.find(isNotesLocationDirective) ?? null;
}

function isNotesLocationDirective(d: Directive): boolean {
  const t = d.text.toLowerCase();
  const mentionsSubject = /\bnotes?\b/.test(t) || t.includes("design doc") || t.includes("design-doc");
  const mentionsPlacement =
    t.includes("vault") ||
    t.includes("standalone") ||
    t.includes("not the") ||
    t.includes("never the") ||
    /\bgo(?:es)? in\b/.test(t) ||
    /\bbelongs?\b/.test(t);
  return mentionsSubject && mentionsPlacement;
}

/**
 * Convert a selected notes-location directive into the in-memory ObservedRuleSpec
 * the evaluator reads. The text comes from the scanned directive (the exact prose
 * the agent saw); the applicability is parsed-and-validated from the pilot
 * descriptor; the effect and forbidden root are pilot constants. Returns an error
 * only if the pilot's own descriptor fails to parse, which is an infrastructure
 * fault in MLA itself, never a rule violation.
 */
export function buildObservedNotesRuleSpec(
  directive: Directive,
): { ok: true; spec: ObservedRuleSpec } | { ok: false; diagnostic: string } {
  const parsed = parseApplicability(NOTES_LOCATION_APPLICABILITY_DESCRIPTOR);
  if (parsed.status !== "OK" || !parsed.applicability) {
    return {
      ok: false,
      diagnostic: `notes-location applicability ${parsed.status}: ${parsed.diagnostic ?? "unparseable"}`,
    };
  }
  return {
    ok: true,
    spec: {
      text: directive.text,
      applicability: parsed.applicability,
      effect: NOTES_EFFECT,
      forbiddenRootRelativePath: NOTES_FORBIDDEN_ROOT_RELATIVE,
    },
  };
}
