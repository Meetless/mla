import { join } from "path";
import { spawnSync } from "child_process";

// N1 (2026-08-15), the hook half. THE OTHER HALF SHIPS IN INTEL and neither half does
// anything alone: intel gained a `rule_citations` field and a `rule_citation` selector,
// and this is what puts anything on that field. A wire contract with no producer is the
// inert-component shape, so the producer gets its own regression here rather than
// riding the server's tests.
//
// THE DEFECT, from `notes/20260809-did-mla-help-session-d8cb21d1-...md` N1 and
// `notes/20260810-did-mla-help-session-ef697800-...md` D1: a `[MUST]` rule can name a
// governed document by citation, the hook injects that rule, and no selector on the
// enrich path ever fetches the document, because every selector reads the operator
// prompt and the rule text was never on the request. Measured across the corpus: 17
// rules live, 2 naming a citation, 31 turns delivering any citation, 0 delivering the
// document their own rule names.
//
// WHAT IS EXTRACTED AND FROM WHERE. Only the RULE blocks of the assembled head
// (`kind="floor-rules"` and `kind="scoped-rules"`), never the whole head. The head also
// carries the static grounding block and, later in the turn, the evidence block; pulling
// citations out of those would feed intel the ids it just served us, which is a
// self-echo loop wearing a governance label, and it would report a delivery this hook
// caused as a rule obligation.
//
// NO CAP HERE, DELIBERATELY. Intel caps at `RULE_CITATION_CAP` and reports the overflow
// as `rule_citations_dropped_for_cap`. Capping on this side too would truncate the
// denominator before intel ever sees it, so the drop counter would read 0 while
// documents went missing, which is the silent-cap failure this workstream keeps finding.

const HOOKS = join(__dirname, "../../src/hooks-template");

function extract(head: string): string[] {
  const script = `source "${HOOKS}/common.sh"; extract_rule_citations "$MLA_TEST_HEAD"`;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, MLA_TEST_HEAD: head },
  });
  const out = (r.stdout || "").trim();
  return out ? out.split("\n").filter(Boolean) : [];
}

// The real block shapes, copied from an actual injected head rather than invented.
const FLOOR = (body: string) => `<meetless-context kind="floor-rules" trust="must-follow">\n${body}\n</meetless-context>`;
const SCOPED = (body: string) => `<meetless-context kind="scoped-rules">\n${body}\n</meetless-context>`;
const STATIC = (body: string) => `<meetless-context kind="static" trace="abc123">\n${body}\n</meetless-context>`;
const EVIDENCE = (body: string) => `<meetless-context kind="evidence" trace="abc123">\n${body}\n</meetless-context>`;

// Verbatim, the scoped rule that fired on turns 2 and 3 of d8cb21d1 and on both turns of
// ef697800. This is the string the whole feature exists for.
const DOCTRINE_RULE =
  "- [MUST] Design-doc turn: run the doctrine gate (classify Core/Enabler/Wedge/Reject, " +
  "§§7-9) + §19 alignment first, against NT:notes/20260704-mla-durable-product-doctrine.md; " +
  "if Wedge/Reject or it fails, STOP and raise with An.";

describe("extract_rule_citations (N1, the hook half)", () => {
  beforeAll(() => {
    if (spawnSync("bash", ["--version"], { encoding: "utf8" }).status !== 0) {
      throw new Error("bash must be available to run the hook helper specs");
    }
  });

  it("pulls the citation out of the scoped MUST that fired on d8cb21d1", () => {
    expect(extract(SCOPED(DOCTRINE_RULE))).toEqual(["NT:notes/20260704-mla-durable-product-doctrine.md"]);
  });

  it("reads the floor block too, because a floor rule may cite", () => {
    expect(extract(FLOOR("- [MUST] see NT:notes/20260724-pulse-readonly-service-account.md"))).toEqual([
      "NT:notes/20260724-pulse-readonly-service-account.md",
    ]);
  });

  it("finds citations across both rule blocks in one head, in head order", () => {
    const head = [STATIC("grounding prose"), FLOOR("- [MUST] a NT:notes/a.md"), SCOPED("- [MUST] b NT:notes/b.md")].join("\n");
    expect(extract(head)).toEqual(["NT:notes/a.md", "NT:notes/b.md"]);
  });

  it("IGNORES the static grounding block", () => {
    // The grounding text names citation KINDS as documentation ("NT:<note>") and must
    // never be mined for them.
    expect(extract(STATIC("citations look like NT:notes/example.md"))).toEqual([]);
  });

  it("IGNORES the evidence block, so a served id is never fed back as an obligation", () => {
    // The self-echo loop this guards: intel serves NT:notes/x.md, the hook renders it
    // into the evidence block, and the next turn would hand it back as a rule citation.
    // That would report OUR OWN delivery as a governance requirement, and it would pin
    // the payload to whatever was served once.
    expect(extract(EVIDENCE("- [pending][NT:notes/served.md] a snippet we were just given"))).toEqual([]);
  });

  it("dedupes a document two rules both cite", () => {
    const head = SCOPED(`- [MUST] a NT:notes/same.md\n- [MUST] b NT:notes/same.md`);
    expect(extract(head)).toEqual(["NT:notes/same.md"]);
  });

  it("does NOT cap, because intel owns the cap and reports the overflow", () => {
    const rules = Array.from({ length: 8 }, (_, i) => `- [MUST] r${i} NT:notes/n${i}.md`).join("\n");
    expect(extract(SCOPED(rules))).toHaveLength(8);
  });

  it("emits nothing for a head whose rules cite nothing, which is ~98% of turns", () => {
    expect(extract(SCOPED("- [MUST] Work directly on main; never create feature branches."))).toEqual([]);
  });

  it("emits nothing for an empty or absent head rather than failing the turn", () => {
    expect(extract("")).toEqual([]);
  });

  it("survives a rule body carrying quotes, backticks and a dollar sign", () => {
    // Rule text is operator-authored prose and reaches this helper as data. A body that
    // can terminate a string or command-substitute is the one input class that could
    // turn a governance feature into an execution bug.
    const nasty = "- [MUST] use `git commit -F \"$FILE\"` per NT:notes/20260804-register-implementation-report.md";
    expect(extract(SCOPED(nasty))).toEqual(["NT:notes/20260804-register-implementation-report.md"]);
  });

  it("stops the citation at the trailing punctuation of the sentence", () => {
    // `...doctrine.md;` and `...doctrine.md.` must not resolve to a path with the
    // punctuation glued on, which would be an unresolvable id delivered as silence.
    expect(extract(SCOPED("- [MUST] a NT:notes/x.md; and b"))).toEqual(["NT:notes/x.md"]);
    expect(extract(SCOPED("- [MUST] a NT:notes/y.md."))).toEqual(["NT:notes/y.md"]);
    expect(extract(SCOPED("- [MUST] see (NT:notes/z.md)"))).toEqual(["NT:notes/z.md"]);
  });

  // Both of the following were REAL defects, in two other implementations of this same
  // helper that landed on this shared tree within minutes of each other on 2026-08-15.
  // Three sessions built N1's hook half at once; the three were consolidated into this
  // one, and the two behaviours the losing versions had are pinned here rather than
  // described in a commit message nobody greps.
  it("does not mine a citation that appears OUTSIDE any rule block (defect 1)", () => {
    // One losing version grepped the whole head. On a turn where intel had served
    // `NT:notes/x.md`, that hands our own delivery back as a rule obligation next turn.
    const head = [STATIC("prose naming NT:notes/leak-a.md"), EVIDENCE("- [pending][NT:notes/leak-b.md] snippet"), SCOPED("- [MUST] real NT:notes/real.md")].join("\n");
    expect(extract(head)).toEqual(["NT:notes/real.md"]);
  });

  it("does not cap on the hook side (defect 2)", () => {
    // The other losing version applied `MEETLESS_RULE_CITATION_CAP` here. Intel's
    // `rule_citations_offered` is documented as "what the hook HANDED us, before any
    // cap", and `rule_citations_dropped_for_cap` is computed against it. Capping here
    // truncates the denominator before intel sees it, so the drop counter reads 0 while
    // documents go missing: full coverage on precisely the turns that lost something.
    const rules = Array.from({ length: 6 }, (_, i) => `- [MUST] r${i} NT:notes/n${i}.md`).join("\n");
    const r = spawnSync("bash", ["-c", `source "${HOOKS}/common.sh"; extract_rule_citations "$MLA_TEST_HEAD"`], {
      encoding: "utf8",
      env: { ...process.env, MLA_TEST_HEAD: SCOPED(rules), MEETLESS_RULE_CITATION_CAP: "2" },
    });
    expect((r.stdout || "").trim().split("\n").filter(Boolean)).toHaveLength(6);
  });

  it("strips the full prose punctuation set, not just a trailing dot", () => {
    // A citation ending in `)` or `",` or a backtick is ordinary rule prose. Leaving the
    // punctuation attached ships an id that cannot resolve, and an unresolvable id
    // degrades to silence, which is indistinguishable from the rule never citing at all.
    for (const tail of [".", ",", ";", ":", "!", "?", ")", "]", "}", ">", '"', "`"]) {
      expect(extract(SCOPED(`- [MUST] see NT:notes/p.md${tail} next`))).toEqual(["NT:notes/p.md"]);
    }
  });

  // The title used to read "takes only NT:", which is the opposite of what the body
  // asserts and of what the helper does. A reader trusting titles would have concluded
  // CC:/DE: are filtered here and that intel therefore never sees them, which is exactly
  // backwards: emitting them is what lets intel report `rule_citations_unsupported`.
  it("emits every citation KIND, leaving intel to count the ones it cannot resolve", () => {
    // `CC:` and `DE:` live on other substrates. Sending them lets intel report
    // `rule_citations_unsupported` honestly; extracting them here as if they were notes
    // would produce an unresolvable lookup that degrades to silence and says nothing.
    const head = SCOPED("- [MUST] a NT:notes/a.md and case CC:abc123 and decision DE:xyz789");
    expect(extract(head)).toEqual(["NT:notes/a.md", "CC:abc123", "DE:xyz789"]);
  });
});
