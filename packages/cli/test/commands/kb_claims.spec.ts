import {
  looksLikeDocumentRef,
  parseKbClaimsArgs,
  parseKbClaimVerdictArgs,
  runKbClaimVerdict,
} from "../../src/commands/kb_claims";

// `accept` and `reject` now serve TWO grains under one word: a document ref gets the
// retirement notice, a claim id records a verdict. `looksLikeDocumentRef` is the entire
// rule that separates them. It shipped untested, which is how the suite could go red on
// a message while saying nothing at all about the routing that message describes.
describe("looksLikeDocumentRef", () => {
  it.each([
    ["kbdoc:ckz1abcd0000xyz", "the explicit kbdoc prefix"],
    ["note:notes/20260714-thing.md", "the explicit note prefix"],
    ["notes/20260714-thing.md", "a bare path (has a separator)"],
    ["a/b", "any separator at all"],
    ["README.md", "a markdown suffix"],
    ["README.MD", "a markdown suffix, shouted"],
    ["  kbdoc:ckz1  ", "surrounding whitespace is trimmed first"],
  ])("%s is a DOCUMENT ref (%s)", (ref) => {
    expect(looksLikeDocumentRef(ref)).toBe(true);
  });

  // The load-bearing negative. A claim id is an opaque cuid: no separator, no prefix, no
  // suffix. If any of these ever read as a document, a real human verdict would be
  // swallowed by the retirement notice and never recorded, and the user would be told the
  // command is retired while their claim sat PENDING.
  it.each([
    ["ckz1abcd0000xyz", "a cuid"],
    ["clm_01HXYZ", "an underscore is not a separator"],
    ["kbdoc", "the bare word, without its colon"],
    ["note", "the bare word, without its colon"],
    ["somethingmd", "a suffix only counts with its dot"],
    ["", "nothing"],
  ])("%s is NOT a document ref (%s)", (ref) => {
    expect(looksLikeDocumentRef(ref)).toBe(false);
  });
});

describe("parseKbClaimsArgs", () => {
  it("defaults to one page of everything, human-readable", () => {
    expect(parseKbClaimsArgs([])).toEqual({
      pending: false,
      outcomes: [],
      doc: null,
      limit: null,
      all: false,
      json: false,
      workspace: null,
    });
  });

  it("collects repeated --outcome and upcases them", () => {
    const a = parseKbClaimsArgs(["--outcome", "accepted", "--outcome", "REJECTED"]);
    expect(a.outcomes).toEqual(["ACCEPTED", "REJECTED"]);
  });

  it("takes --doc, --limit, --all, --json, --workspace", () => {
    const a = parseKbClaimsArgs([
      "--doc", "kbdoc:x", "--limit", "3", "--all", "--json", "--workspace", "ws_1",
    ]);
    expect(a).toMatchObject({ doc: "kbdoc:x", limit: 3, all: true, json: true, workspace: "ws_1" });
  });

  it.each([
    [["--outcome", "MAYBE"], /--outcome must be one of/],
    [["--outcome"], /--outcome must be one of/],
    [["--doc"], /--doc requires a document id/],
    [["--doc", "  "], /--doc requires a document id/],
    [["--workspace"], /--workspace requires a workspace id/],
    [["--nope"], /unknown flag "--nope"/],
    // Not a typo tolerance: --pending IS --outcome PENDING plus a backlog badge, and the
    // two are served by DIFFERENT routes. Silently picking one would answer a question
    // the user did not ask.
    [["--pending", "--outcome", "ACCEPTED"], /mutually exclusive/],
  ])("refuses %j", (argv, msg) => {
    expect(() => parseKbClaimsArgs(argv as string[])).toThrow(msg as RegExp);
  });

  // A limit is a count of rows. Zero, negative, and fractional are all nonsense, and a
  // silently-coerced 0 would page forever fetching nothing.
  it.each([["0"], ["-1"], ["1.5"], ["lots"], [""]])("refuses --limit %j", (n) => {
    expect(() => parseKbClaimsArgs(["--limit", n])).toThrow(/positive integer/);
  });
});

describe("parseKbClaimVerdictArgs", () => {
  it("maps the verb to the outcome, and expects PENDING by default", () => {
    expect(parseKbClaimVerdictArgs("accept", ["c1"])).toEqual({
      claimId: "c1",
      outcome: "ACCEPTED",
      expect: "PENDING",
      json: false,
      agent: false,
      workspace: null,
    });
    expect(parseKbClaimVerdictArgs("reject", ["c1"]).outcome).toBe("REJECTED");
  });

  it("takes --expect, --json, --agent, --workspace", () => {
    const a = parseKbClaimVerdictArgs("accept", [
      "c1", "--expect", "rejected", "--json", "--agent", "--workspace", "ws_1",
    ]);
    expect(a).toMatchObject({ expect: "REJECTED", json: true, agent: true, workspace: "ws_1" });
  });

  // The claim id is positional and first. A leading flag means the user forgot it, and
  // consuming the flag AS the id would send a verdict to a claim named "--json".
  it.each([[[]], [["--json"]], [["  "]], [["--expect", "PENDING"]]])(
    "refuses a missing claim id: %j",
    (argv) => {
      expect(() => parseKbClaimVerdictArgs("accept", argv as string[])).toThrow(/a claim id is required/);
    },
  );

  it.each([
    [["c1", "--expect", "MAYBE"], /--expect must be one of/],
    [["c1", "--expect"], /--expect must be one of/],
    [["c1", "--workspace"], /--workspace requires a workspace id/],
    [["c1", "--nope"], /unknown flag "--nope"/],
  ])("refuses %j", (argv, msg) => {
    expect(() => parseKbClaimVerdictArgs("reject", argv as string[])).toThrow(msg as RegExp);
  });
});

// Human-only authority. This refusal has to fire BEFORE the workspace config is loaded
// and before anything is posted, or an agent's auto-verdict reaches the audit log and
// becomes institutional memory that no human ever ruled. The test proves it exits without
// a workspace: it runs with no config on disk and never touches the network.
describe("runKbClaimVerdict refuses --agent", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it.each(["accept", "reject"] as const)("`mla kb %s --agent` exits 2 and records nothing", async (verb) => {
    const code = await runKbClaimVerdict(verb, ["c1", "--agent"]);
    expect(code).toBe(2);
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain(`\`mla kb ${verb} --agent\` is refused`);
    expect(msg).toContain("only a\nhuman may record one");
    expect(msg).toContain("mla kb claims --pending");
  });

  it("a usage error is exit 2, not a fault", async () => {
    expect(await runKbClaimVerdict("accept", [])).toBe(2);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/a claim id is required/);
  });
});
