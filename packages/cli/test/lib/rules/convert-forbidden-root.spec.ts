import {
  convertForbiddenRootSnapshot,
  convertNotesLocationSnapshot,
} from "../../../src/lib/rules/attest-notes-location";
import { serializeObservedRule } from "../../../src/lib/rules/observed-rule-hash";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { ObservedRuleSpec } from "../../../src/lib/rules/types";

// A3.2: the generic PROHIBIT forbidden-root converter. The notes pilot is ONE member of a family of
// rules that all share the same enforceable shape: action-scoped, exactly {Write, Edit}, the field/glob
// matcher, effect PROHIBIT, a non-empty forbidden root carried AS CONTENT (P0.63). `convertForbiddenRoot
// Snapshot` admits the WHOLE family (any non-empty root); `convertNotesLocationSnapshot` is the family
// member pinned to the "notes" root (the armed R1 pilot). Generalizing the root is provably conflict-free
// (proposal §2.0: a conflict needs an effect that EFFECTIVELY REQUIRES an action; PROHIBIT rules never
// require, so two PROHIBIT forbidden-root rules can never conflict). Anything outside this family stays
// R4.

const SCOPE = "/work/meetless";

function spec(over: Partial<ObservedRuleSpec> = {}): ObservedRuleSpec {
  return {
    text: "Secrets MUST NOT be written under the repo secrets directory.",
    applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*" } },
    effect: "PROHIBIT",
    forbiddenRootRelativePath: "secrets",
    ...over,
  };
}

function snapshot(over: Partial<ObservedRuleSpec> = {}): string {
  return serializeObservedRule(spec(over));
}

describe("convertForbiddenRootSnapshot admits the whole PROHIBIT forbidden-root family", () => {
  it("admits a non-'notes' forbidden root the notes converter refuses, carrying the root as content", () => {
    const result = convertForbiddenRootSnapshot(snapshot(), SCOPE);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.payload.compliance.config).toEqual({ forbiddenRootRelativePath: "secrets" });
    expect(result.payload.effect).toBe("PROHIBIT");
    expect(result.payload.runtimeScopeId).toBe(SCOPE);
  });

  it("is byte-identical to the notes converter for the 'notes' root (same admitted payload hash)", () => {
    const notesSnap = snapshot({ forbiddenRootRelativePath: "notes" });
    const generic = convertForbiddenRootSnapshot(notesSnap, SCOPE);
    const pilot = convertNotesLocationSnapshot(notesSnap, SCOPE);
    expect(generic.admitted && pilot.admitted).toBe(true);
    if (!generic.admitted || !pilot.admitted) return;
    expect(ruleVersionHash(generic.payload)).toBe(ruleVersionHash(pilot.payload));
  });

  it("rejects an empty (or whitespace-only) forbidden root: a rule that forbids the repo root is nonsensical", () => {
    const empty = convertForbiddenRootSnapshot(snapshot({ forbiddenRootRelativePath: "" }), SCOPE);
    const blank = convertForbiddenRootSnapshot(snapshot({ forbiddenRootRelativePath: "   " }), SCOPE);
    expect(empty.admitted).toBe(false);
    expect(blank.admitted).toBe(false);
    if (!empty.admitted) expect(empty.reason).toBe("FORBIDDEN_ROOT_EMPTY");
    if (!blank.admitted) expect(blank.reason).toBe("FORBIDDEN_ROOT_EMPTY");
  });

  it("still enforces the rest of the family gate (effect, tools, action-scope, closed schema)", () => {
    const notProhibit = convertForbiddenRootSnapshot(snapshot({ effect: "REQUIRE" }), SCOPE);
    const wrongTools = convertForbiddenRootSnapshot(
      snapshot({ applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", glob: "*" } } }),
      SCOPE,
    );
    const ambient = convertForbiddenRootSnapshot(snapshot({ applicability: { mode: "ambient" } }), SCOPE);
    expect(notProhibit.admitted).toBe(false);
    expect(wrongTools.admitted).toBe(false);
    expect(ambient.admitted).toBe(false);
    if (!notProhibit.admitted) expect(notProhibit.reason).toBe("EFFECT_NOT_PROHIBIT");
    if (!wrongTools.admitted) expect(wrongTools.reason).toBe("TOOLS_NOT_WRITE_EDIT");
    if (!ambient.admitted) expect(ambient.reason).toBe("NOT_ACTION_SCOPED");
  });
});
