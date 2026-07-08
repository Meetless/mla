// The ONE glob matcher shared by both delivery planes: prompt-time rule INJECTION
// (the targeted-rule-injection assembler) and action-time ENFORCEMENT (the PreToolUse
// evaluator). Sharing the exact same pure function is the §4.7 guarantee that a rule
// surfaced in the prompt and a rule enforced at the tool boundary agree on what its
// globs match, with no drift between two hand-rolled matchers.
//
// Minimal R0 glob: an optional literal prefix (before the first "*") and an optional
// literal suffix (after the last "*"). Covers "*.md", "**/*.md", "foo*", "*bar", and
// "*". Anything between the first and last "*" is ignored, which is sufficient for the
// configured matchers (path suffixes, directory prefixes) and keeps the surface tiny on
// purpose. Path NORMALIZATION (./ stripping, repo-root containment, backtick/quote
// stripping) is the caller's job (the extraction/containment step); this function
// assumes both sides are already normalized, repo-relative strings.
export function matchesGlob(value: string, glob: string): boolean {
  const firstStar = glob.indexOf("*");
  if (firstStar === -1) {
    return value === glob;
  }
  const lastStar = glob.lastIndexOf("*");
  const prefix = glob.slice(0, firstStar);
  const suffix = glob.slice(lastStar + 1);
  return (
    value.length >= prefix.length + suffix.length &&
    value.startsWith(prefix) &&
    value.endsWith(suffix)
  );
}
