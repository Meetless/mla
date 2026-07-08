import { NotesPathScope } from "../../../src/lib/rules/notes-path";
import { PathClassification, RuleApplicability } from "../../../src/lib/rules/types";
import {
  OBSERVE_TIMEOUT_MS,
  observePreToolUse,
  parsePreToolUseInput,
} from "../../../src/lib/rules/observe-adapter";

// R0 observe-only PreToolUse adapter. It parses the real (snake_case) hook input,
// runs the pure selector + four-state evaluator over an injectable classifier, and
// reports what it OBSERVED. It NEVER emits a permissionDecision (deny is a later
// slice) and NEVER turns an infrastructure problem (malformed input, timeout,
// evaluator failure) into a rule violation. Every branch defers to the normal
// Claude Code permission flow by returning an empty response.

const notesAction: RuleApplicability = {
  mode: "action",
  tools: ["Write", "Edit"],
  matcher: { field: "file_path", glob: "*.md" },
};

const ambient: RuleApplicability = { mode: "ambient" };

const scope: NotesPathScope = {
  canonicalProjectRoot: "/repo",
  configuredRelativeForbiddenPath: "notes",
};

const classifyTo =
  (c: PathClassification) =>
  async (): Promise<PathClassification> =>
    c;

function input(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: "s-1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu-1",
    permission_mode: "default",
  };
}

describe("observePreToolUse - observation outcomes", () => {
  it("reports NOT_APPLICABLE for a tool the rule does not gate", async () => {
    const res = await observePreToolUse(input("Bash", { command: "ls" }), {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("UNDER_FORBIDDEN_ROOT"),
    });
    expect(res.observation).toEqual({ kind: "NOT_APPLICABLE" });
  });

  it("reports NOT_APPLICABLE for an ambient rule (never an action gate)", async () => {
    const res = await observePreToolUse(input("Write", { file_path: "/repo/notes/x.md" }), {
      applicability: ambient,
      notesScope: scope,
      classify: classifyTo("UNDER_FORBIDDEN_ROOT"),
    });
    expect(res.observation).toEqual({ kind: "NOT_APPLICABLE" });
  });

  it("OBSERVES a VIOLATION for a write under the forbidden root", async () => {
    const res = await observePreToolUse(input("Write", { file_path: "/repo/notes/x.md" }), {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("UNDER_FORBIDDEN_ROOT"),
    });
    expect(res.observation).toEqual({
      kind: "OBSERVED",
      result: "VIOLATION",
      reasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });

  it("OBSERVES COMPLIANT for a write outside the forbidden root", async () => {
    const res = await observePreToolUse(input("Edit", { file_path: "/repo/src/x.md" }), {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("OUTSIDE_FORBIDDEN_ROOT"),
    });
    expect(res.observation).toEqual({
      kind: "OBSERVED",
      result: "COMPLIANT",
      reasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
    });
  });

  it("OBSERVES UNKNOWN (never a violation) when classification is indeterminate", async () => {
    const res = await observePreToolUse(input("Write", { file_path: "/repo/notes/x.md" }), {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("INDETERMINATE"),
    });
    expect(res.observation).toEqual({
      kind: "OBSERVED",
      result: "UNKNOWN",
      reasonCode: "CANONICALIZATION_FAILED",
    });
  });

  it("parses the real snake_case JSON-string payload from stdin", async () => {
    const raw = JSON.stringify(input("Write", { file_path: "/repo/notes/x.md" }));
    const res = await observePreToolUse(raw, {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("UNDER_FORBIDDEN_ROOT"),
    });
    expect(res.observation).toEqual({
      kind: "OBSERVED",
      result: "VIOLATION",
      reasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });
});

describe("observePreToolUse - infrastructure failures are never violations", () => {
  it("treats a non-object payload as INFRA", async () => {
    const res = await observePreToolUse(42, {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("UNDER_FORBIDDEN_ROOT"),
    });
    expect(res.observation.kind).toBe("INFRA");
  });

  it("treats a payload missing tool_name as INFRA", async () => {
    const res = await observePreToolUse(
      { tool_input: { file_path: "/repo/notes/x.md" } },
      { applicability: notesAction, notesScope: scope, classify: classifyTo("UNDER_FORBIDDEN_ROOT") },
    );
    expect(res.observation.kind).toBe("INFRA");
  });

  it("treats a payload whose tool_input is not an object as INFRA", async () => {
    const res = await observePreToolUse(
      { tool_name: "Write", tool_input: "nope" },
      { applicability: notesAction, notesScope: scope, classify: classifyTo("UNDER_FORBIDDEN_ROOT") },
    );
    expect(res.observation.kind).toBe("INFRA");
  });

  it("treats an unparseable JSON string as INFRA", async () => {
    const res = await observePreToolUse("{not json", {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("UNDER_FORBIDDEN_ROOT"),
    });
    expect(res.observation.kind).toBe("INFRA");
  });

  it("treats an evaluator throw as INFRA, never a violation", async () => {
    const res = await observePreToolUse(input("Write", { file_path: "/repo/notes/x.md" }), {
      applicability: notesAction,
      notesScope: scope,
      classify: async () => {
        throw new Error("boom");
      },
    });
    expect(res.observation.kind).toBe("INFRA");
  });

  it("treats a timeout as INFRA, never a violation", async () => {
    const res = await observePreToolUse(input("Write", { file_path: "/repo/notes/x.md" }), {
      applicability: notesAction,
      notesScope: scope,
      timeoutMs: 10,
      classify: () => new Promise((resolve) => setTimeout(() => resolve("UNDER_FORBIDDEN_ROOT"), 80)),
    });
    expect(res.observation.kind).toBe("INFRA");
  });
});

describe("observePreToolUse - never emits a permission decision", () => {
  const cases: Array<{ name: string; classify: () => Promise<PathClassification>; tool: string }> = [
    { name: "violation", classify: classifyTo("UNDER_FORBIDDEN_ROOT"), tool: "Write" },
    { name: "compliant", classify: classifyTo("OUTSIDE_FORBIDDEN_ROOT"), tool: "Write" },
    { name: "unknown", classify: classifyTo("INDETERMINATE"), tool: "Write" },
  ];

  it.each(cases)("returns an empty response with no permissionDecision ($name)", async ({ classify, tool }) => {
    const res = await observePreToolUse(input(tool, { file_path: "/repo/notes/x.md" }), {
      applicability: notesAction,
      notesScope: scope,
      classify,
    });
    expect(res.response).toEqual({});
    expect("permissionDecision" in res.response).toBe(false);
    expect("hookSpecificOutput" in res.response).toBe(false);
  });

  it("returns an empty response on INFRA too (defers to normal permission flow)", async () => {
    const res = await observePreToolUse(99, {
      applicability: notesAction,
      notesScope: scope,
      classify: classifyTo("UNDER_FORBIDDEN_ROOT"),
    });
    expect(res.response).toEqual({});
    expect("permissionDecision" in res.response).toBe(false);
  });
});

describe("observePreToolUse - does no unnecessary work", () => {
  it("does not invoke the classifier for a non-applicable tool", async () => {
    const classify = jest.fn(classifyTo("UNDER_FORBIDDEN_ROOT"));
    await observePreToolUse(input("Bash", { command: "ls" }), {
      applicability: notesAction,
      notesScope: scope,
      classify,
    });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("OBSERVE_TIMEOUT_MS", () => {
  it("defaults the hard timeout to 500ms", () => {
    expect(OBSERVE_TIMEOUT_MS).toBe(500);
  });
});

describe("parsePreToolUseInput", () => {
  it("returns the typed snake_case shape for a valid payload", () => {
    const parsed = parsePreToolUseInput(input("Write", { file_path: "/repo/notes/x.md" }));
    expect(parsed).not.toBeNull();
    expect(parsed?.tool_name).toBe("Write");
    expect(parsed?.tool_input.file_path).toBe("/repo/notes/x.md");
    expect(parsed?.tool_use_id).toBe("tu-1");
    expect(parsed?.session_id).toBe("s-1");
  });

  it("returns null for a malformed payload", () => {
    expect(parsePreToolUseInput(null)).toBeNull();
    expect(parsePreToolUseInput({ tool_name: "Write" })).toBeNull();
    expect(parsePreToolUseInput({ tool_input: {} })).toBeNull();
  });
});
