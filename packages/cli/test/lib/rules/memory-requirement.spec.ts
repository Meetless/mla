import {
  classifyMemoryRequirement,
  normalizeForMarkerMatch,
  REQUIRED_MARKERS,
  EXCLUSION_MARKERS,
  MEMORY_REQUIREMENT_CLASSIFIER_VERSION,
  MEMORY_REQUIREMENT_MARKER_SET_VERSION,
  MEMORY_REQUIREMENT_EXCLUSION_SET_VERSION,
} from "../../../src/lib/rules/memory-requirement";

// Commit 6a: the memory-requirement classifier, vendored into the CLI
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §1.3). The CLI
// does not depend on @meetless/utils, so the UserPromptSubmit hook reimplements the
// classifier here. It MUST stay behaviorally and version-identical to the utils seed
// (raw-prompt-substring-v1 / seed-v1): the obligation only ever forms on a REQUIRED
// turn, so divergence here silently changes which turns are governed. These tests pin
// the band logic, the precedence, the token-boundary guard, and the frozen seed sets.

describe("classifyMemoryRequirement: the three-valued band", () => {
  it("returns REQUIRED when a seed marker matches, recording only the marker", () => {
    const c = classifyMemoryRequirement("What did we decide about the soft gate enforcement?");
    expect(c.requirement).toBe("REQUIRED");
    expect(c.markersMatched).toEqual(["what did we decide"]);
    expect(c.exclusionsMatched).toEqual([]);
  });

  it("returns NOT_REQUIRED when only an exclusion lead-in matches", () => {
    const c = classifyMemoryRequirement("What is a soft gate?");
    expect(c.requirement).toBe("NOT_REQUIRED");
    expect(c.markersMatched).toEqual([]);
    expect(c.exclusionsMatched).toEqual(["what is"]);
  });

  it("returns UNKNOWN when neither a marker nor an exclusion matches", () => {
    const c = classifyMemoryRequirement("Refactor the prompt parser into smaller helpers");
    expect(c.requirement).toBe("UNKNOWN");
    expect(c.markersMatched).toEqual([]);
    expect(c.exclusionsMatched).toEqual([]);
  });

  it("lets a REQUIRED marker win even when an exclusion lead-in also matches (proposal line 313)", () => {
    // "why" is an excluded generic lead-in, but "why did we choose" is a seed marker.
    const c = classifyMemoryRequirement("Why did we choose Postgres over Dynamo?");
    expect(c.requirement).toBe("REQUIRED");
    expect(c.markersMatched).toEqual(["why did we choose"]);
    expect(c.exclusionsMatched).toEqual(["why"]);
  });

  it("matches markers only on whole-token boundaries, never mid-word", () => {
    // " who owns " is not a substring of " whoever owns this ".
    const c = classifyMemoryRequirement("Whoever owns this can decide");
    expect(c.requirement).toBe("UNKNOWN");
    expect(c.markersMatched).toEqual([]);
    expect(c.exclusionsMatched).toEqual([]);
  });

  it("stamps the frozen seed-set versions on every classification", () => {
    const c = classifyMemoryRequirement("our canonical ingestion model");
    expect(c.requirement).toBe("REQUIRED");
    expect(c.classifierVersion).toBe(MEMORY_REQUIREMENT_CLASSIFIER_VERSION);
    expect(c.markerSetVersion).toBe(MEMORY_REQUIREMENT_MARKER_SET_VERSION);
    expect(c.exclusionSetVersion).toBe(MEMORY_REQUIREMENT_EXCLUSION_SET_VERSION);
    expect(c.classifierVersion).toBe("raw-prompt-substring-v1");
    expect(c.markerSetVersion).toBe("seed-v1");
    expect(c.exclusionSetVersion).toBe("seed-v1");
  });
});

describe("normalizeForMarkerMatch: space-padded token stream", () => {
  it("lowercases, collapses punctuation to single spaces, and pads the ends", () => {
    expect(normalizeForMarkerMatch("Who  Owns?? this!")).toBe(" who owns this ");
  });

  it("reduces an all-punctuation / empty input to a single pad space", () => {
    expect(normalizeForMarkerMatch("")).toBe(" ");
    expect(normalizeForMarkerMatch("!!!")).toBe(" ");
  });
});

describe("the frozen seed sets are byte-identical to the utils seed", () => {
  it("ships the exact REQUIRED marker set, sorted and deduped", () => {
    expect([...REQUIRED_MARKERS]).toEqual(
      [
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
      ].sort(),
    );
  });

  it("ships the exact EXCLUSION marker set, sorted and deduped", () => {
    expect([...EXCLUSION_MARKERS]).toEqual(["why", "how does", "what is", "difference between"].sort());
  });

  it("freezes both seed sets against mutation", () => {
    expect(Object.isFrozen(REQUIRED_MARKERS)).toBe(true);
    expect(Object.isFrozen(EXCLUSION_MARKERS)).toBe(true);
  });
});
