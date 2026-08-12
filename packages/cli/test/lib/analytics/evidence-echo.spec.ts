import { ECHO_NGRAM, scanEchoes } from "../../../src/lib/analytics/evidence-echo";

// F1b: the heuristic half of the push-path signal, and the one that must not be allowed to
// flatter us.
//
// The proposal put it plainly: a substring test is "cheap to get wrong in the flattering
// direction, which is the one direction we must not err in for a self-reported value
// metric". So the design target is PRECISION, not recall. It fires only on a verbatim run of
// ECHO_NGRAM consecutive words carrying at least MIN_CONTENT_TOKENS distinct non-stopword
// terms, which is a quotation, not a coincidence. Everything it misses is a miss we can live
// with; a false positive is a number we would then quote at ourselves.
//
// It is also why nothing here asserts "helped". An echo is the text reappearing. The agent
// may be quoting the snippet in order to REJECT it, which is the case that motivated turn 7
// of session 85d97591 in the first place, and it is exactly why the recap keeps this out of
// the engaged set.

const ID = "NT:notes/20260808-acceptance-census.md";

function snippet(text: string) {
  return [{ source_id: ID, text }];
}

describe("scanEchoes: what counts as an echo", () => {
  it("fires on a verbatim run of the snippet in the agent's output", () => {
    const text = "is_claim_trusted_for_generation gates the claim span evidence arm and pending claims are dropped there";
    const out = `I need to correct myself. ${text} So the earlier finding is wrong.`;
    expect(scanEchoes(snippet(text), out)).toEqual([ID]);
  });

  it("survives reflowed whitespace and case, which is reformatting rather than rewriting", () => {
    const text = "the string dispatch grep artifact means a symbol grep cannot see the call";
    const out = `THE STRING DISPATCH   GREP ARTIFACT\n  MEANS a symbol grep cannot\tsee the call.`;
    expect(scanEchoes(snippet(text), out)).toEqual([ID]);
  });

  it("does not fire on a paraphrase", () => {
    const text = "the acceptance census shows retry exhaustion recovers on its own at the designed threshold";
    const out = "The census suggests that exhausted retries eventually recover once the threshold is reached.";
    expect(scanEchoes(snippet(text), out)).toEqual([]);
  });

  it("does not fire on a run of pure filler, however long", () => {
    // Eight consecutive stopwords is not a quotation, it is English.
    const text = "and then it was that there is not one of the things";
    const out = "and then it was that there is not one of the things";
    expect(scanEchoes(snippet(text), out)).toEqual([]);
  });

  it("does not fire on a short overlap below the window", () => {
    const text = "claim span evidence arm";
    const out = "I checked the claim span evidence arm myself.";
    expect(scanEchoes(snippet(text), out)).toEqual([]);
  });

  it("returns only the ids that actually echoed, not every offered id", () => {
    const items = [
      { source_id: "NT:a.md", text: "the queue ceiling is a single poller election rather than a heavy semaphore" },
      { source_id: "NT:b.md", text: "a supersedes edge is decorative and the claim lifecycle status is the authority" },
    ];
    const out = "Correcting course: the queue ceiling is a single poller election rather than a heavy semaphore.";
    expect(scanEchoes(items, out)).toEqual(["NT:a.md"]);
  });

  it("is empty for an empty output, an empty snippet, or no items", () => {
    expect(scanEchoes(snippet("some text that is quite long and specific about retrieval"), "")).toEqual([]);
    expect(scanEchoes(snippet(""), "anything at all here")).toEqual([]);
    expect(scanEchoes([], "anything at all here")).toEqual([]);
  });

  it("never reports the same id twice", () => {
    const text = "the extractor cannot tell an assertion from a mention in the document body";
    const items = [
      { source_id: ID, text },
      { source_id: ID, text },
    ];
    expect(scanEchoes(items, `... ${text} ...`)).toEqual([ID]);
  });

  it("is bounded on pathological input rather than quadratic", () => {
    // A 400k-char snippet against a 200k-char output must still answer promptly: this runs at
    // Stop, inside a hook budget, and a scan that blows its deadline silently produces the
    // same output as a scan that found nothing.
    const filler = "alpha beta gamma delta epsilon zeta eta theta ".repeat(10000);
    const started = Date.now();
    const res = scanEchoes(snippet(filler), filler.slice(0, 200000));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res).toEqual([ID]);
  });
});
