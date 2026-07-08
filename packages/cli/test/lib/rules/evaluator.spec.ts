import { RuleApplicability } from "../../../src/lib/rules/types";
import {
  selectRule,
  verdictForForbiddenRoot,
  isEnforcementEligible,
} from "../../../src/lib/rules/evaluator";

// R0 pure selector + four-state evaluator. No I/O, no persistence: selection and
// verdict are computed from the in-memory rule and a pre-computed path
// classification. Selection produces no output for non-matching rules
// (NOT_APPLICABLE is selector-internal). Of the verdicts only VIOLATION is
// enforcement-eligible; UNKNOWN never asks or denies.

const ambient: RuleApplicability = { mode: "ambient" };
const notesAction: RuleApplicability = {
  mode: "action",
  tools: ["Write", "Edit"],
  matcher: { field: "file_path", glob: "*.md" },
};

describe("selectRule", () => {
  it("treats an ambient rule as not applicable at an action point", () => {
    const call = { toolName: "Write", toolInput: { file_path: "/x/y.md" } };
    expect(selectRule(call, ambient)).toBe("NOT_APPLICABLE");
  });

  it("applies an action rule when the tool and glob both match", () => {
    const call = { toolName: "Write", toolInput: { file_path: "/repo/notes/a.md" } };
    expect(selectRule(call, notesAction)).toBe("APPLIES");
  });

  it("does not apply when the tool is not in the rule's tool list", () => {
    const call = { toolName: "Bash", toolInput: { command: "ls" } };
    expect(selectRule(call, notesAction)).toBe("NOT_APPLICABLE");
  });

  it("does not apply when the glob does not match the field value", () => {
    const call = { toolName: "Write", toolInput: { file_path: "/repo/src/a.ts" } };
    expect(selectRule(call, notesAction)).toBe("NOT_APPLICABLE");
  });

  it("applies on any field value when the matcher has no glob", () => {
    const anyWrite: RuleApplicability = {
      mode: "action",
      tools: ["Write"],
      matcher: { field: "file_path" },
    };
    const call = { toolName: "Write", toolInput: { file_path: "/repo/src/a.ts" } };
    expect(selectRule(call, anyWrite)).toBe("APPLIES");
  });

  it("does not apply when a glob is required but the field value is missing", () => {
    const call = { toolName: "Write", toolInput: {} };
    expect(selectRule(call, notesAction)).toBe("NOT_APPLICABLE");
  });

  it("does not apply when a glob is required but the field value is not a string", () => {
    const call = { toolName: "Write", toolInput: { file_path: 7 } };
    expect(selectRule(call, notesAction)).toBe("NOT_APPLICABLE");
  });

  it("matches a nested path against a ** glob", () => {
    const deep: RuleApplicability = {
      mode: "action",
      tools: ["Edit"],
      matcher: { field: "file_path", glob: "**/*.md" },
    };
    const call = { toolName: "Edit", toolInput: { file_path: "/a/b/c/deep.md" } };
    expect(selectRule(call, deep)).toBe("APPLIES");
  });
});

describe("verdictForForbiddenRoot", () => {
  it("maps a path under the forbidden root to a VIOLATION", () => {
    expect(verdictForForbiddenRoot("UNDER_FORBIDDEN_ROOT")).toEqual({
      result: "VIOLATION",
      reasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });

  it("maps a path outside the forbidden root to COMPLIANT", () => {
    expect(verdictForForbiddenRoot("OUTSIDE_FORBIDDEN_ROOT")).toEqual({
      result: "COMPLIANT",
      reasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
    });
  });

  it("maps an indeterminate classification to UNKNOWN, never a violation", () => {
    expect(verdictForForbiddenRoot("INDETERMINATE")).toEqual({
      result: "UNKNOWN",
      reasonCode: "CANONICALIZATION_FAILED",
    });
  });

  it("maps an unsupported evaluator input to UNKNOWN", () => {
    expect(verdictForForbiddenRoot("UNSUPPORTED")).toEqual({
      result: "UNKNOWN",
      reasonCode: "EVALUATOR_UNSUPPORTED",
    });
  });
});

describe("isEnforcementEligible", () => {
  it("is true only for VIOLATION", () => {
    expect(isEnforcementEligible("VIOLATION")).toBe(true);
  });

  it("is false for COMPLIANT", () => {
    expect(isEnforcementEligible("COMPLIANT")).toBe(false);
  });

  it("is false for UNKNOWN", () => {
    expect(isEnforcementEligible("UNKNOWN")).toBe(false);
  });

  it("is false for NOT_APPLICABLE", () => {
    expect(isEnforcementEligible("NOT_APPLICABLE")).toBe(false);
  });
});
