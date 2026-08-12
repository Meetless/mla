import {
  buildForbiddenCommandPayload,
  parseCommandConjunction,
} from "../../../src/lib/rules/attest-command-rule";
import {
  FORBIDDEN_COMMAND_CANONICALIZER_VERSION,
  FORBIDDEN_COMMAND_EVALUATOR_CONTRACT_VERSION,
  FORBIDDEN_COMMAND_MATCHER_SCHEMA_VERSION,
  classifyCommandAllOf,
} from "../../../src/lib/rules/command-match";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";

// The AUTHORING half of F2: turning what An types into the payload the enforcer
// faces. The two halves have to agree exactly, so the round-trip test at the
// bottom is the real assertion here -- the parser and the matcher share one
// notion of a clause, or a rule reads as armed and enforces nothing.

describe("parseCommandConjunction", () => {
  it("splits clauses on ' + ' and tokenizes each on whitespace", () => {
    expect(parseCommandConjunction("comp-credit.cjs + --apply")).toEqual({
      sequences: [["comp-credit.cjs"], ["--apply"]],
    });
  });

  it("keeps a multi-token clause as one ordered run", () => {
    expect(parseCommandConjunction("git push + --force")).toEqual({
      sequences: [["git", "push"], ["--force"]],
    });
  });

  it("accepts a single clause", () => {
    expect(parseCommandConjunction("prisma migrate deploy")).toEqual({
      sequences: [["prisma", "migrate", "deploy"]],
    });
  });

  it("tolerates irregular spacing around the separator", () => {
    expect(parseCommandConjunction("  comp-credit.cjs   +   --apply  ")).toEqual({
      sequences: [["comp-credit.cjs"], ["--apply"]],
    });
  });

  // A `+` INSIDE a token is not a separator. `find . -name '*.ts' -exec x +` is
  // shell syntax, and a rule author writing a real token containing a plus must
  // not have it silently cut in half.
  it("only treats a WHITESPACE-DELIMITED + as the clause separator", () => {
    expect(parseCommandConjunction("a+b + c")).toEqual({ sequences: [["a+b"], ["c"]] });
  });

  // Every rejection is an error, never a smaller conjunction. Dropping an empty
  // clause would REMOVE a condition and broaden the rule, which is the exact
  // inversion the matcher refuses at evaluation time; refusing it at the writer
  // means no such rule is ever born.
  it("rejects an empty clause rather than dropping it", () => {
    expect(parseCommandConjunction("comp-credit.cjs +  + --apply").error).toBeDefined();
    expect(parseCommandConjunction("+ --apply").error).toBeDefined();
    expect(parseCommandConjunction("--apply +").error).toBeDefined();
  });

  it("rejects an empty or whitespace-only specification", () => {
    expect(parseCommandConjunction("").error).toBeDefined();
    expect(parseCommandConjunction("   ").error).toBeDefined();
  });
});

describe("buildForbiddenCommandPayload", () => {
  const payload = buildForbiddenCommandPayload({
    sequences: [["comp-credit.cjs"], ["--apply"]],
    runtimeScopeId: "/work/meetless",
    text: "A prod billing comp is an ADJUSTMENT/PREPAID entry.",
  });

  it("mints the exact version triple the enforcer gates on", () => {
    expect(payload.compliance.evaluatorContractVersion).toBe(
      FORBIDDEN_COMMAND_EVALUATOR_CONTRACT_VERSION,
    );
    expect(payload.compliance.matcherSchemaVersion).toBe(FORBIDDEN_COMMAND_MATCHER_SCHEMA_VERSION);
    expect(payload.compliance.pathCanonicalizerVersion).toBe(
      FORBIDDEN_COMMAND_CANONICALIZER_VERSION,
    );
  });

  it("is a PROHIBIT Bash action rule delivered to preToolUse", () => {
    expect(payload.effect).toBe("PROHIBIT");
    expect(payload.deliveryChannels).toEqual(["preToolUse"]);
    expect(payload.applicability).toEqual({
      mode: "action",
      tools: ["Bash"],
      matcher: { field: "command" },
    });
  });

  // INV-8: a freshly armed rule warns before it blocks. A cold DENY on a command
  // could block a real operator action on a matcher nobody has watched yet.
  it("defaults to the non-blocking WARN rung", () => {
    expect(payload.enforcementCeiling).toBe("WARN");
  });

  it("hashes, which proves the closed canonical schema admits the family", () => {
    expect(ruleVersionHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  // Clause ORDER is not identity (a conjunction is unordered), but token order
  // inside a clause IS. Both directions matter: the first keeps one rule from
  // minting two nodes, the second keeps two different operations apart.
  it("hashes identically when clause ORDER differs", () => {
    const flipped = buildForbiddenCommandPayload({
      sequences: [["--apply"], ["comp-credit.cjs"]],
      runtimeScopeId: "/work/meetless",
      text: "A prod billing comp is an ADJUSTMENT/PREPAID entry.",
    });
    expect(ruleVersionHash(flipped)).toBe(ruleVersionHash(payload));
  });

  it("hashes DIFFERENTLY when token order INSIDE a clause differs", () => {
    const a = buildForbiddenCommandPayload({
      sequences: [["git", "push"]],
      runtimeScopeId: "/work/meetless",
      text: "t",
    });
    const b = buildForbiddenCommandPayload({
      sequences: [["push", "git"]],
      runtimeScopeId: "/work/meetless",
      text: "t",
    });
    expect(ruleVersionHash(a)).not.toBe(ruleVersionHash(b));
  });
});

// THE ROUND TRIP. What An types must be what the enforcer matches. A drift here
// mints a rule that reads as armed in `mla rules list` and never fires, which is
// strictly worse than no rule: it spends the operator's trust and buys nothing.
describe("authoring round trip: typed spec -> payload -> live verdict", () => {
  it("the spec An would type fires on the invocation it was written for", () => {
    const parsed = parseCommandConjunction("comp-credit.cjs + --apply");
    if (parsed.error) throw new Error(parsed.error);
    const payload = buildForbiddenCommandPayload({
      sequences: parsed.sequences,
      runtimeScopeId: "/work/meetless",
      text: "t",
    });
    const config = payload.compliance.config;
    if (!("forbiddenCommandAllOf" in config)) throw new Error("wrong family");

    expect(
      classifyCommandAllOf(
        "node tools/billing/comp-credit.cjs --account acc_1 --amount 200 --apply",
        config.forbiddenCommandAllOf,
      ),
    ).toBe("MATCHES_FORBIDDEN");
    expect(
      classifyCommandAllOf(
        "node tools/billing/comp-credit.cjs --account acc_1 --dry-run",
        config.forbiddenCommandAllOf,
      ),
    ).toBe("NO_MATCH");
  });
});
