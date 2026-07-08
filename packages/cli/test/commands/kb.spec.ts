import { isReviewListInvocation, pendingAliasArgs } from "../../src/commands/kb";
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
