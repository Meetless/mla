// Human-facing vocabulary for the coverage-gap breakdown in `mla stats`.
//
// The dashboard's roadmap section (spec §7.5) groups each unhelpful retrieval by
// its raw `CoverageGapType` enum slug (envelope.ts COVERAGE_GAP_TYPES:
// no_candidate_found, low_confidence_candidates, candidates_found_not_used,
// stale_or_conflicting_candidates, retrieval_error, permission_filtered). Printed
// verbatim those slugs read like debug output, not the roadmap they are meant to
// be. This module is the single place that maps each slug to a plain-English
// label plus a one-line hint naming what the gap means and where its fix lives
// (capture vs. rank vs. reconcile vs. access vs. bug). Pure and framework-free so
// the render and its test run the identical code with no I/O.
//
// Labels match the Console Value page's coverage-gap vocabulary
// (apps/console/lib/value/coverage-gaps.ts) so the two surfaces name the same
// gap the same way; each surface keeps its own copy (separate packages, no shared
// module) and each is pinned by its own spec so drift trips a test.
//
// A slug we do not recognize (a future gap type this build predates) falls back
// to a humanized form of the slug, so it never leaks the raw identifier and never
// renders blank.

export interface CoverageGapPresentation {
  /** Plain-English label shown in place of the raw slug. */
  label: string;
  /** One-line hint: what the gap means and where the fix lives. */
  hint: string;
}

// The closed vocabulary, keyed by the raw enum slug. Meanings mirror the
// classifier that emits them (coverage-gap.ts). Hints are sentence fragments (no
// leading capital, no trailing period) so they read cleanly inside the "(...)"
// the dashboard wraps them in.
const COVERAGE_GAP_PRESENTATION: Record<string, CoverageGapPresentation> = {
  no_candidate_found: {
    label: "Nothing matched",
    hint: "nothing came back; the knowledge to answer it is not captured yet",
  },
  low_confidence_candidates: {
    label: "Weak matches",
    hint: "candidates existed but ranked too low to stand behind; a retrieval and ranking fix, not a missing-knowledge one",
  },
  candidates_found_not_used: {
    label: "Found but unused",
    hint: "usable evidence was surfaced, but the answer referenced none of it",
  },
  stale_or_conflicting_candidates: {
    label: "Stale or conflicting",
    hint: "candidates existed but were out of date or disagreed with each other; a knowledge-base reconcile",
  },
  retrieval_error: {
    label: "Retrieval error",
    hint: "a lookup threw an error instead of returning results; a bug to chase down",
  },
  permission_filtered: {
    label: "Blocked by permissions",
    hint: "matches existed but were filtered out by access rules; an access gap, not a knowledge gap",
  },
};

/** SCREAMING_SNAKE / kebab token -> "Sentence case" for unknown enum members. */
function humanizeToken(token: string): string {
  const words = token.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!words) return token;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Presentation for one coverage-gap type. Falls back to a humanized slug and a
 * generic hint for a type this build does not yet know about, so a new enum
 * member never prints the raw identifier or a blank hint.
 */
export function coverageGapPresentation(type: string): CoverageGapPresentation {
  return (
    COVERAGE_GAP_PRESENTATION[type] ?? {
      label: humanizeToken(type),
      hint: "a lookup that did not produce a usable answer",
    }
  );
}
