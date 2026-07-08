/**
 * MEMORY-REQUIREMENT CLASSIFIER (vendored into the CLI for the UserPromptSubmit hook).
 *
 * Given the operator's current prompt, derive whether asserting an answer WITHOUT
 * consulting governed memory plausibly violates an operator expectation. The CE0
 * obligation forms ONLY on a REQUIRED turn, so this classifier is the relevance
 * trigger for CONSULT_GOVERNED_EVIDENCE_ON_MEMORY_REQUIRED_TURN_V1
 * (notes/20260617-evidence-consultation-forcing-function-proposal.md §1.3).
 *
 * Why vendored, not imported: the CLI intentionally does not depend on
 * @meetless/utils (see kb-candidate.ts). This is a byte-faithful copy of the utils
 * classifier (packages/utils/src/memory-requirement.ts); the seed-set versions
 * (raw-prompt-substring-v1 / seed-v1) are pinned so the two implementations cannot
 * silently diverge on which turns are governed. The classification is pure: no hash,
 * no persistence, no runtime. The TurnMemoryAssessment record and the obligation it
 * may create live in the store and the adapter.
 *
 * Three-valued band (R3 P1.2 removed HELPFUL): REQUIRED | NOT_REQUIRED | UNKNOWN.
 * Only REQUIRED creates an obligation (P0.3); NOT_REQUIRED and UNKNOWN are telemetry.
 * A REQUIRED seed marker wins (the seed catches "why did we choose X" even though
 * "why" is itself an excluded generic lead-in); failing that, an EXCLUSION match is
 * what makes a turn CONFIDENTLY NOT_REQUIRED; matching NEITHER is undecidable from
 * shape, so it is UNKNOWN (the population recall improvements later promote).
 */

export type MemoryRequirement = "REQUIRED" | "NOT_REQUIRED" | "UNKNOWN";

/** Frozen seed-set versions, stamped on every classification (P1.3 attestation). */
export const MEMORY_REQUIREMENT_CLASSIFIER_VERSION = "raw-prompt-substring-v1";
export const MEMORY_REQUIREMENT_MARKER_SET_VERSION = "seed-v1";
export const MEMORY_REQUIREMENT_EXCLUSION_SET_VERSION = "seed-v1";

// Sorted for byte-stable identity; de-duplicated by construction.
const sortedFrozen = (markers: string[]): readonly string[] =>
  Object.freeze(Array.from(new Set(markers)).sort());

/**
 * Seed REQUIRED markers (proposal lines 290-301): high precision, deliberately low
 * recall. A match means the prompt points at workspace-internal decisions, ownership,
 * policy, architecture, or cross-session history.
 */
export const REQUIRED_MARKERS: readonly string[] = sortedFrozen([
  "what did we decide",
  "why did we choose",
  "are we still doing",
  "our canonical",
  "previous session",
  "earlier agent",
  "who owns",
  "who approves",
  "our policy",
  "our architecture decision",
]);

/**
 * Explicitly EXCLUDED generic-conceptual lead-ins (proposal lines 305-310), stored as
 * their placeholder-free, matchable prefixes. A match (absent any REQUIRED marker)
 * makes the turn CONFIDENTLY NOT_REQUIRED.
 */
export const EXCLUSION_MARKERS: readonly string[] = sortedFrozen([
  "why",
  "how does",
  "what is",
  "difference between",
]);

export interface MemoryRequirementClassification {
  requirement: MemoryRequirement;
  /** REQUIRED seed markers that matched, sorted and de-duplicated. */
  markersMatched: string[];
  /** EXCLUSION markers that matched, sorted and de-duplicated (factual, not erasing). */
  exclusionsMatched: string[];
  classifierVersion: string;
  markerSetVersion: string;
  exclusionSetVersion: string;
}

/**
 * Normalize text to a space-padded, lowercased, single-spaced token stream so a marker
 * can be matched on token boundaries via plain substring containment (" who owns " is
 * in " who owns this " but not in " whoever owns "). Any run of non-alphanumeric
 * characters becomes a single space; an empty / all-punctuation input reduces to a
 * single pad space.
 */
export function normalizeForMarkerMatch(text: string): string {
  const core = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return core === "" ? " " : ` ${core} `;
}

/** Which of `markers` appear as whole-token substrings of the padded prompt. */
function matched(paddedPrompt: string, markers: readonly string[]): string[] {
  return markers.filter((m) => paddedPrompt.includes(` ${m} `));
}

/**
 * Classify the current prompt's MemoryRequirement. Pure and deterministic: REQUIRED if
 * any seed marker matches; else NOT_REQUIRED if any exclusion marker matches; else
 * UNKNOWN.
 */
export function classifyMemoryRequirement(prompt: string): MemoryRequirementClassification {
  const padded = normalizeForMarkerMatch(prompt);
  const markersMatched = matched(padded, REQUIRED_MARKERS);
  const exclusionsMatched = matched(padded, EXCLUSION_MARKERS);

  let requirement: MemoryRequirement;
  if (markersMatched.length > 0) {
    requirement = "REQUIRED";
  } else if (exclusionsMatched.length > 0) {
    requirement = "NOT_REQUIRED";
  } else {
    requirement = "UNKNOWN";
  }

  return {
    requirement,
    markersMatched,
    exclusionsMatched,
    classifierVersion: MEMORY_REQUIREMENT_CLASSIFIER_VERSION,
    markerSetVersion: MEMORY_REQUIREMENT_MARKER_SET_VERSION,
    exclusionSetVersion: MEMORY_REQUIREMENT_EXCLUSION_SET_VERSION,
  };
}
