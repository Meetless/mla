import {
  CaptureRecord,
  WorkProductDigest,
} from "../../src/lib/analytics/work-product-capture";
import {
  WORK_PRODUCT_CAPTURE_PATH,
  buildSealBody,
} from "../../src/lib/analytics/work-product-seal";
import { EGRESS_RULES } from "../../src/lib/egress/rules";
import {
  EgressPolicyError,
  applyEgressPolicy,
  resolveRule,
} from "../../src/lib/egress/policy";
import { redactPayloadWithProfile } from "../../src/lib/redactor";

/**
 * The work-product seal, end to end through the real egress boundary.
 *
 * Two separate defects live here, and both were invisible to every existing test
 * because every existing test built the body by hand:
 *
 * 1. THE RULE'S FIELD LIST WAS WRITTEN FROM THE ROUTE NAME, NOT THE BODY. It named
 *    `sessionId`, `turnIndex` and `prompts`, none of which exist, and omitted seven
 *    keys that do. Since an unclassified top-level field fails closed, the rule
 *    refused EVERY real seal from the moment the registry landed. Before Phase 1f's
 *    body-free diagnostic it did so silently, because the correlator swallows
 *    capture failures on purpose. So the guard here is not "the list looks right":
 *    it runs a real `buildSealBody` output through the real registry.
 *
 * 2. THE DIGEST USED TO RIDE AS A JSON STRING, WHICH BLINDED THE REDACTOR. The
 *    boundary redacts a body by walking it to its string leaves. A packed digest is
 *    ONE leaf, and JSON escaping destroys the token boundaries the credential rules
 *    anchor on: a `ghp_` PAT at the start of a captured line serializes as
 *    `...\nghp_...`, so the character before the prefix is a literal `n`, `\b` does
 *    not match, and the rule walks past a live credential. Both encodings are
 *    measured below, so the cutover's value is a number and not an argument.
 *
 *    The measurement uses two tokens on purpose, because the leak depends on what
 *    precedes the prefix. A PAT inside quotes redacted correctly even when packed; a
 *    PAT at line start did not. That is why nobody noticed: whether a given seal
 *    leaked was a property of the captured content, so most fixtures looked clean.
 *
 * The second one matters even though `prepareContent` redacts at CAPTURE time:
 * `assembleTurnCaptures` reads `rec.hunk` straight off the staged record and never
 * re-redacts, so anything an older CLI staged (or a future capture path forgets)
 * reaches the wire with the egress boundary as its only remaining check.
 */
describe("work-product seal: the real body through the real egress boundary", () => {
  const SESSION = "sess-egress-1";

  // Low-entropy on purpose: `A` repeated cannot clear the `full` profile's entropy
  // bar, so if these disappear it is the ghp_ credential rule that removed them and
  // not the generic heuristic. That isolation is the whole point; a token both rules
  // catch would prove nothing about escaping.
  //
  // TWO tokens, because the leak is CONDITIONAL on the character in front of the
  // prefix, and that is exactly what makes it dangerous:
  //   QUOTED sits after a `"`, which escapes to `\"`. A quote is not a word
  //     character, so `\bghp_` still matches and the packed form redacts fine.
  //   LINE_START sits after a newline, which escapes to a literal `\` + `n`. `n` IS
  //     a word character, the boundary dies, and the packed form ships it verbatim.
  // So whether a packed digest leaked depended on the shape of the captured content.
  // Most fixtures would have looked clean.
  const PAT_QUOTED = `ghp_${"A".repeat(36)}`;
  const PAT_LINE_START = `ghp_${"B".repeat(36)}`;

  const hunkCapture = (over: Partial<CaptureRecord> = {}): CaptureRecord => ({
    session_id: SESSION,
    turn_index: 5,
    kind: "hunk",
    ts: "2026-07-26T00:00:00.000Z",
    file: "src/auth.ts",
    tool: "Edit",
    hunk: `-const token = ""\n+const token = "${PAT_QUOTED}"`,
    ...over,
  });

  const outputCapture = (): CaptureRecord => ({
    session_id: SESSION,
    turn_index: 5,
    kind: "assistant_output",
    ts: "2026-07-26T00:00:00.000Z",
    text: `Wired it up. The token I used:\n${PAT_LINE_START}\nRotate it when you are done.`,
  });

  const seal = (captures: CaptureRecord[]) =>
    buildSealBody({
      inject: {
        injectId: "inject-1",
        workspaceId: "ws-1",
        sessionId: SESSION,
        turnIndex: 5,
      },
      captures,
      promptsByTurn: new Map([[5, ["wire up the token"]]]),
      window: 3,
      captureContractVersion: 1,
      sealedAtIso: "2026-07-26T00:00:01.000Z",
    });

  const send = (body: unknown) =>
    applyEgressPolicy(
      EGRESS_RULES,
      "control",
      "POST",
      WORK_PRODUCT_CAPTURE_PATH,
      body,
    );

  it("classifies every top-level key a real seal can emit", () => {
    // The drift guard. A sealed seal carries the digest; a failed one omits it
    // (§6.4), so the union of both is the exhaustive key set the rule must classify.
    // Comparing SETS, not counts, so a rename fails as loudly as an addition.
    const sealed = seal([hunkCapture()]);
    const failed = seal([]);
    expect(sealed.status).toBe("sealed");
    expect(failed.status).toBe("failed");
    expect(failed.workProductDigest).toBeUndefined();

    const emitted = new Set([...Object.keys(sealed), ...Object.keys(failed)]);

    const rule = resolveRule(
      EGRESS_RULES,
      "control",
      "POST",
      WORK_PRODUCT_CAPTURE_PATH,
    );
    if (rule.mode !== "redact") throw new Error("expected a redact rule");
    expect(new Set(Object.keys(rule.fields))).toEqual(emitted);
  });

  it("sends a real sealed body without failing closed", () => {
    // The regression that would have caught the original bug on day one. The
    // previous field list produced exactly:
    //   unknown_field: captureContractVersion, capturedTurnEnd, capturedTurnStart,
    //   injectId, redactedSubstance, status, truncated
    const wire = send(seal([hunkCapture()])) as Record<string, unknown>;

    // Structural fields arrive byte-exact: control keys the seal on injectId and
    // resolves idempotency on (injectId, captureContractVersion), so a redacted one
    // would be a silently wrong row rather than a missing one.
    expect(wire.workspaceId).toBe("ws-1");
    expect(wire.injectId).toBe("inject-1");
    expect(wire.captureContractVersion).toBe(1);
    expect(wire.status).toBe("sealed");
    expect(wire.capturedTurnStart).toBe(5);
    expect(wire.capturedTurnEnd).toBe(8);
    expect(wire.truncated).toBe(false);
    expect(wire.redactedSubstance).toBe(false);
  });

  it("a failed seal (no digest) is sendable too", () => {
    const wire = send(seal([])) as Record<string, unknown>;
    expect(wire.status).toBe("failed");
    expect("workProductDigest" in wire).toBe(false);
  });

  it("redacts credentials in both a captured hunk and an assistant output", () => {
    const wire = send(seal([hunkCapture(), outputCapture()])) as {
      workProductDigest: WorkProductDigest;
    };
    const turn = wire.workProductDigest.turns[0];
    const hunk = turn.changed_hunks[0];

    expect(hunk.hunk).not.toContain(PAT_QUOTED);
    expect(hunk.hunk).toContain("[REDACTED]");
    // The surrounding diff survives. Redaction that ate the hunk would make the
    // capture useless to the judge, which is the failure mode on the other side.
    expect(hunk.hunk).toContain("const token");
    // And the join keys the server records the hunk against are untouched.
    expect(hunk.file).toBe("src/auth.ts");
    expect(hunk.tool).toBe("Edit");

    const output = turn.assistant_outputs[0].text;
    expect(output).not.toContain(PAT_LINE_START);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("Rotate it when you are done.");
  });

  it("measures the leak the old JSON-string encoding caused", () => {
    // Same digest, same tokens, same profile, same walker. The ONLY difference is
    // whether the digest reaches the walker as an object or as one packed leaf.
    const digest = seal([
      hunkCapture(),
      outputCapture(),
    ]).workProductDigest as WorkProductDigest;

    const asObject = JSON.stringify(redactPayloadWithProfile(digest, "full"));
    expect(asObject).not.toContain(PAT_QUOTED);
    expect(asObject).not.toContain(PAT_LINE_START);

    const asPackedString = redactPayloadWithProfile(
      JSON.stringify(digest),
      "full",
    ) as string;
    // The leak, pinned. A newline before the prefix serializes to a literal
    // backslash and a literal `n`; `n` is a word character, so `\bghp_` never
    // matches and the PAT ships verbatim. If this ever stops being true, the
    // encoding stopped mattering and this assertion should be re-derived, not
    // deleted.
    expect(asPackedString).toContain(`n${PAT_LINE_START}`);
    // And the reason it went unnoticed: the OTHER token in the same body, one
    // character class away, redacted correctly under the same packed encoding. A
    // fixture that happened to quote its secrets would have looked completely clean.
    expect(asPackedString).not.toContain(PAT_QUOTED);
  });

  it("still fails closed on a field nobody classified", () => {
    // The property the whole registry exists for, asserted on THIS route: a new key
    // is exactly how content sneaks onto an already-approved body.
    const body = { ...seal([hunkCapture()]), notes: "an unreviewed new field" };
    let err: unknown;
    try {
      send(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EgressPolicyError);
    const policyErr = err as EgressPolicyError;
    expect(policyErr.reason).toBe("unknown_field");
    expect(policyErr.message).toContain("notes");
    // Body-free: the diagnostic names the field, never the value or the credential
    // that was sitting in the same body.
    expect(policyErr.message).not.toContain("an unreviewed new field");
    expect(policyErr.message).not.toContain(PAT_QUOTED);
  });
});
