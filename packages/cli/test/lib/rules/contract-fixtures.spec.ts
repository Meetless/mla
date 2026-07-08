import * as fs from "fs";
import * as path from "path";

import { NotesPathScope } from "../../../src/lib/rules/notes-path";
import { observePreToolUse, parsePreToolUseInput } from "../../../src/lib/rules/observe-adapter";
import { RuleApplicability } from "../../../src/lib/rules/types";

// Slice 5: pinned Claude Code hook contract. These fixtures freeze the ACTUAL
// PreToolUse input/response shapes verified against the installed CLI (2.1.153)
// and the official docs. They are the regression lock for the future deny slice:
// if the real contract shifts, or if the observe adapter ever starts emitting a
// permission decision, these tests break.
//
// Verified facts pinned here:
//   - PreToolUse INPUT is snake_case and has NO tool_use_id (that field exists
//     only on PostToolUse and later, post-execution events).
//   - A DENY response lives at hookSpecificOutput.permissionDecision = "deny"
//     with hookSpecificOutput.hookEventName = "PreToolUse" and a
//     permissionDecisionReason. (Pinned for the LATER slice; not emitted now.)
//   - The documented-safe "no decision" pass-through is exit 0 with an empty
//     "{}" body. The observe adapter must match this exactly.

const FIXTURES = path.join(__dirname, "fixtures");

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

const notesAction: RuleApplicability = {
  mode: "action",
  tools: ["Write", "Edit"],
  matcher: { field: "file_path", glob: "*.md" },
};

const scope: NotesPathScope = {
  canonicalProjectRoot: "/Users/dev/projects/example",
  configuredRelativeForbiddenPath: "notes",
};

describe("pinned PreToolUse input fixtures (real 2.1.x shape)", () => {
  it.each(["pretooluse-input-write.json", "pretooluse-input-edit.json"])(
    "parses the pinned %s payload",
    (file) => {
      const parsed = parsePreToolUseInput(readJson(file));
      expect(parsed).not.toBeNull();
      expect(typeof parsed?.tool_name).toBe("string");
      expect(typeof parsed?.tool_input.file_path).toBe("string");
      expect(parsed?.hook_event_name).toBe("PreToolUse");
    },
  );

  it("pins that PreToolUse input carries NO tool_use_id", () => {
    const raw = readJson("pretooluse-input-write.json") as Record<string, unknown>;
    expect("tool_use_id" in raw).toBe(false);
    // The adapter tolerates this: the optional field simply stays undefined.
    expect(parsePreToolUseInput(raw)?.tool_use_id).toBeUndefined();
  });
});

describe("observe adapter conforms to the pinned pass-through contract", () => {
  it("returns the documented empty no-decision body on a real input payload", async () => {
    const noDecision = readJson("pretooluse-no-decision-response.json");
    const res = await observePreToolUse(readJson("pretooluse-input-write.json"), {
      applicability: notesAction,
      notesScope: scope,
      classify: async () => "UNDER_FORBIDDEN_ROOT",
    });
    // Observe mode emits exactly the documented pass-through and nothing more.
    expect(res.response).toEqual(noDecision);
    expect(res.observation).toEqual({
      kind: "OBSERVED",
      result: "VIOLATION",
      reasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });
});

describe("pinned DENY response shape (for the future deny slice, NOT emitted now)", () => {
  it("matches the verified hookSpecificOutput.permissionDecision contract", () => {
    const deny = readJson("pretooluse-deny-response.json") as {
      hookSpecificOutput?: Record<string, unknown>;
    };
    expect(deny.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(deny.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof deny.hookSpecificOutput?.permissionDecisionReason).toBe("string");
  });

  it("is NOT what the observe adapter produces (deny stays unimplemented in R0)", async () => {
    const deny = readJson("pretooluse-deny-response.json");
    const res = await observePreToolUse(readJson("pretooluse-input-write.json"), {
      applicability: notesAction,
      notesScope: scope,
      classify: async () => "UNDER_FORBIDDEN_ROOT",
    });
    expect(res.response).not.toEqual(deny);
    expect("hookSpecificOutput" in res.response).toBe(false);
  });
});
