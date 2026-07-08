// CONTENT matcher: the pure classifier for the em-dash-ban rule class (GAP2).
//
// The proposal routes the BEHAVIORAL em-dash ban (over the agent's chat output,
// emitted at Stop) to a Stop-hook detect-only check, because the output text is
// not a tool call and so is not observable at PreToolUse. This module handles a
// DIFFERENT, mechanically-decidable case the proposal did not cover: a forbidden
// substring written INTO a file, i.e. literally present in a Write `content` or
// Edit `new_string` payload field. That field is fully observable at PreToolUse,
// so BOTH polarities are provable here:
//
//   needle present  -> CONTAINS_FORBIDDEN  (the bytes are right there)
//   string, no needle -> NO_FORBIDDEN      (absence is provable: we see the whole field)
//   non-string / no needles -> INDETERMINATE
//
// This is the key asymmetry versus Bash (see command-match.ts): for an opaque
// shell string, absence of a pattern cannot prove the effect is absent, so a
// non-match degrades to UNKNOWN. For a concrete content field, we hold the entire
// value, so a non-match is a genuine COMPLIANT. The two checks COMPLEMENT each
// other: Stop catches an em-dash in chat output; this catches an em-dash written
// into a file.
//
// Matching is codepoint-exact with NO normalization: an em-dash needle (U+2014)
// must never be conflated with an en-dash (U+2013) or an ASCII hyphen. The rule
// is a byte-level ban, and normalizing would silently widen or narrow it.

/**
 * The three observable states of a content field against a forbidden-substring
 * set. Pure: no I/O, no canonicalization (unlike the path matcher). Mirrors the
 * PathClassification triad in spirit, but every state is decided in memory.
 */
export type ContentClassification = "CONTAINS_FORBIDDEN" | "NO_FORBIDDEN" | "INDETERMINATE";

/**
 * Classify a candidate content value against a set of forbidden substrings.
 *
 * INDETERMINATE (degrades to UNKNOWN, never a verdict) when:
 *  - the value is not a string (the field is absent or the tool input is shaped
 *    unexpectedly), or
 *  - there is nothing meaningful to look for: an empty needle set, or a set whose
 *    every needle is the empty string. An empty needle would `.includes("")`-match
 *    every string, so empty needles are DROPPED, never allowed to flag all content.
 *
 * Otherwise CONTAINS_FORBIDDEN iff any non-empty needle occurs as an exact
 * (codepoint) substring; NO_FORBIDDEN if none do. An empty content string with a
 * real needle set is observably clean -> NO_FORBIDDEN, not indeterminate.
 */
export function classifyContent(
  rawValue: unknown,
  forbiddenSubstrings: readonly string[],
): ContentClassification {
  if (typeof rawValue !== "string") {
    return "INDETERMINATE";
  }
  const needles = forbiddenSubstrings.filter((n) => typeof n === "string" && n.length > 0);
  if (needles.length === 0) {
    return "INDETERMINATE";
  }
  for (const needle of needles) {
    if (rawValue.includes(needle)) {
      return "CONTAINS_FORBIDDEN";
    }
  }
  return "NO_FORBIDDEN";
}
