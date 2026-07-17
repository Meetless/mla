// Only the two network verbs are faked. `looksLikeDocumentRef` stays REAL: it is the
// rule the routing rests on, and a stubbed one would let the router pass while shipping
// the wrong grain.
jest.mock("../../src/commands/kb_claims", () => ({
  ...jest.requireActual("../../src/commands/kb_claims"),
  runKbClaims: jest.fn(async () => 0),
  runKbClaimVerdict: jest.fn(async () => 0),
}));

import { isReviewListInvocation, pendingAliasArgs, runKb, runKbDocumentReviewRetired } from "../../src/commands/kb";
import { runKbClaimVerdict } from "../../src/commands/kb_claims";
import { parseKbPendingArgs } from "../../src/commands/kb_pending";

describe("isReviewListInvocation", () => {
  it("no args => list", () => {
    expect(isReviewListInvocation([])).toBe(true);
  });
  it("leading flag => list", () => {
    expect(isReviewListInvocation(["--all"])).toBe(true);
    expect(isReviewListInvocation(["--session", "current"])).toBe(true);
    expect(isReviewListInvocation(["--json"])).toBe(true);
  });
  it("leading bare token (candidate id) => verdict", () => {
    expect(isReviewListInvocation(["abc123", "--reject"])).toBe(false);
  });
});

describe("pendingAliasArgs (back-compat)", () => {
  it("injects --all when no explicit scope is present", () => {
    expect(pendingAliasArgs([])).toEqual(["--all"]);
    expect(pendingAliasArgs(["--json"])).toEqual(["--all", "--json"]);
  });
  it("preserves an explicit --doc (no --all injected)", () => {
    expect(pendingAliasArgs(["--doc", "foo.md"])).toEqual(["--doc", "foo.md"]);
    expect(pendingAliasArgs(["--json", "--doc", "foo.md"])).toEqual(["--json", "--doc", "foo.md"]);
  });
  it("preserves an explicit --session", () => {
    expect(pendingAliasArgs(["--session", "latest"])).toEqual(["--session", "latest"]);
  });
  // The alias must NOT silently rewrite an invalid invocation into a valid one: a
  // user who typed `pending --all --doc x` should still hit the mutual-exclusion
  // guard, not have it papered over.
  it("does not paper over a conflicting invocation", () => {
    expect(pendingAliasArgs(["--all", "--doc", "foo.md"])).toEqual(["--all", "--doc", "foo.md"]);
    expect(() => parseKbPendingArgs(pendingAliasArgs(["--all", "--doc", "foo.md"]))).toThrow(/at most one/i);
  });
});

// §14 test 23 (CLI arm): the DOCUMENT-grain trust verdict is retired under Design A.
// `mla kb accept <document>` / `mla kb reject <document>` no longer record a verdict;
// they exit non-zero with a pointer to claim-grain review, and touch no workspace or
// network. The VERBS themselves are alive: they now carry the claim-grain verdict.
describe("runKbDocumentReviewRetired (mla kb accept / reject <document> retirement)", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it.each(["accept", "reject"])("`mla kb %s <document>` exits 2 and points at claim review", (sub) => {
    const code = runKbDocumentReviewRetired(sub);
    expect(code).toBe(2);
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // Name the DOCUMENT form. This assertion used to read "`mla kb accept` is
    // retired", which stopped being true the moment the claim verbs took the same
    // word: `mla kb accept <claimId>` is now the live verdict path. A notice that
    // retires the bare verb would be telling the user the wrong thing, so the test
    // must pin the qualified sentence, and it must also prove the notice hands back
    // the replacement invocation rather than just saying no.
    expect(msg).toContain(`\`mla kb ${sub} <document>\` is retired`);
    expect(msg).toContain("navigate + withdraw only");
    expect(msg).toContain(`mla kb ${sub} <claimId>`);
    expect(msg).toMatch(/claim/i);
  });
});

// The load-bearing branch. `accept` and `reject` answer to BOTH grains now, and the
// ONLY thing separating them is the shape of the first argument. Nothing covered it:
// when the retirement notice was rewritten for the new world, the suite went red on
// the wording and stayed completely silent about the routing, which is the half that
// can misfile a real verdict.
describe("runKb routes accept/reject on the SHAPE of the argument", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it.each([
    ["accept", "kbdoc:ckz1"],
    ["accept", "note:notes/foo.md"],
    ["accept", "notes/foo.md"],
    ["accept", "FOO.MD"],
    ["reject", "kbdoc:ckz1"],
    ["reject", "note:notes/foo.md"],
  ])("`mla kb %s %s` is a DOCUMENT ref: retired, and never reaches the verdict route", async (sub, ref) => {
    const code = await runKb([sub, ref]);
    expect(code).toBe(2);
    expect(runKbClaimVerdict).not.toHaveBeenCalled();
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain(`\`mla kb ${sub} <document>\` is retired`);
  });

  it.each([
    ["accept", "ckz1abcd0000xyz"],
    ["reject", "ckz1abcd0000xyz"],
  ])("`mla kb %s %s` is a CLAIM id: it records the verdict", async (sub, claimId) => {
    const code = await runKb([sub, claimId, "--json"]);
    expect(code).toBe(0);
    expect(runKbClaimVerdict).toHaveBeenCalledWith(sub, [claimId, "--json"]);
    // The retirement notice must not fire on the live path. Printing "retired" over a
    // verdict we DID record is how a user learns to ignore the message.
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).not.toContain("is retired");
  });
});
