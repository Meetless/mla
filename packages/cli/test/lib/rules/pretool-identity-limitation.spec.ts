import * as fs from "fs";
import * as path from "path";

import { observeNotesRule } from "../../../src/lib/rules/notes-observe";
import { NotesPathScope } from "../../../src/lib/rules/notes-path";
import { observePreToolUse, parsePreToolUseInput } from "../../../src/lib/rules/observe-adapter";
import { Directive } from "../../../src/lib/scanner/types";
import { RuleApplicability } from "../../../src/lib/rules/types";

// Slice 5: pin the PreToolUse IDENTITY LIMITATION.
//
// The pinned contract (claude-code-pretooluse-contract.md, contract-fixtures.spec.ts)
// records that PreToolUse input is snake_case and has no `tool_use_id`. This spec
// pins the CONSEQUENCE the deny / persistence slice must respect: at PreToolUse,
// Claude Code hands MLA NO per-tool-call identity of any kind, so an observation
// cannot be correlated to its later PostToolUse counterpart, and MLA must never
// fabricate a synthetic identity to paper over that gap.
//
// What is pinned here, and why it has teeth:
//   1. The supported input carries no per-call id field at all (not `tool_use_id`,
//      and not an alternative like `id` / `call_id` / `tool_call_id`).
//   2. The parser surfaces a strictly-undefined `tool_use_id` and never substitutes
//      a value; serialization drops the key entirely (no null, no "").
//   3. No observe path mints an identity: the adapter and the full notes pipeline
//      return output that contains no identity-bearing key anywhere.
//   4. Two distinct tool calls in one session are indistinguishable to MLA: their
//      observations are content-addressed by rule + verdict and carry nothing that
//      could tell call A from call B (or bind either to a PostToolUse).
//
// These assertions are a regression lock. If a future change defaults `tool_use_id`
// to the `session_id`, generates a uuid, or attaches a correlation id to the
// observation, the relevant assertion below fails.

const FIXTURES = path.join(__dirname, "fixtures");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
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

const underForbidden = async (): Promise<"UNDER_FORBIDDEN_ROOT"> => "UNDER_FORBIDDEN_ROOT";

// Any of these keys appearing in MLA's OUTPUT would be a fabricated per-call
// identity. `id` is included because the adapter output legitimately has none.
const FABRICATED_ID_KEYS = new Set([
  "tool_use_id",
  "tooluseid",
  "id",
  "call_id",
  "callid",
  "tool_call_id",
  "toolcallid",
  "correlation_id",
  "correlationid",
]);

function fabricatedIdKeys(value: unknown, trail = ""): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...fabricatedIdKeys(v, `${trail}[${i}]`)));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FABRICATED_ID_KEYS.has(k.toLowerCase())) {
        hits.push(`${trail}.${k}`);
      }
      hits.push(...fabricatedIdKeys(v, `${trail}.${k}`));
    }
  }
  return hits;
}

describe("the supported PreToolUse input exposes no per-tool-call identity", () => {
  it.each(["pretooluse-input-write.json", "pretooluse-input-edit.json"])(
    "%s carries no per-call id field (only session/transcript scope)",
    (file) => {
      const raw = readJson(file);
      // No `tool_use_id`, and no alternative per-call handle either.
      for (const k of ["tool_use_id", "id", "call_id", "tool_call_id", "tool_use"]) {
        expect(k in raw).toBe(false);
      }
      // The only identifiers present are session/transcript scoped, never per-call.
      expect(typeof raw.session_id).toBe("string");
    },
  );

  it.each(["pretooluse-input-write.json", "pretooluse-input-edit.json"])(
    "the parser leaves tool_use_id strictly undefined for %s and never fabricates one",
    (file) => {
      const parsed = parsePreToolUseInput(readJson(file));
      expect(parsed).not.toBeNull();
      expect(parsed?.tool_use_id).toBeUndefined();
      // Undefined, not "" and not a generated value: it drops on serialization.
      const round = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
      expect("tool_use_id" in round).toBe(false);
    },
  );
});

describe("the observe path mints no identity (code exposes no fake value)", () => {
  it("the adapter output carries no identity-bearing key on a real input", async () => {
    const res = await observePreToolUse(readJson("pretooluse-input-write.json"), {
      applicability: notesAction,
      notesScope: scope,
      classify: underForbidden,
    });
    expect(fabricatedIdKeys(res)).toEqual([]);
    expect(res.response).toEqual({});
    expect(res.observation).toEqual({
      kind: "OBSERVED",
      result: "VIOLATION",
      reasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });

  it("the full notes pipeline output carries no identity-bearing key", async () => {
    const directive: Directive = {
      id: "dir-notes-location",
      text: "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
      source: "CLAUDE.md",
      kind: "RULE",
      strength: "MUST_FOLLOW",
      attestation: "human_attested",
    };
    const res = await observeNotesRule({
      rawStdin: readJson("pretooluse-input-write.json"),
      directives: [directive],
      runtimeProjectRoot: scope.canonicalProjectRoot,
      classify: underForbidden,
    });
    expect(fabricatedIdKeys(res)).toEqual([]);
    expect(res.response).toEqual({});
    expect(res.observation.kind).toBe("OBSERVED");
  });
});

describe("two calls in one session are indistinguishable to MLA (the deferred-deny limitation)", () => {
  it("observations are content-addressed by rule + verdict, with no per-call handle", async () => {
    const base = {
      session_id: "ses_same_session",
      transcript_path: "/Users/dev/.claude/projects/example/transcript.jsonl",
      cwd: scope.canonicalProjectRoot,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
    };
    const callA = { ...base, tool_input: { file_path: `${scope.canonicalProjectRoot}/notes/a.md`, content: "a" } };
    const callB = { ...base, tool_input: { file_path: `${scope.canonicalProjectRoot}/notes/b.md`, content: "b" } };

    const resA = await observePreToolUse(callA, { applicability: notesAction, notesScope: scope, classify: underForbidden });
    const resB = await observePreToolUse(callB, { applicability: notesAction, notesScope: scope, classify: underForbidden });

    // Same session, two genuinely different writes, yet the observations are byte
    // identical: MLA holds nothing that distinguishes call A from call B, which is
    // exactly why a future deny slice cannot correlate a PreToolUse decision with
    // the PostToolUse that follows. The limitation is pinned, not worked around.
    expect(resA.observation).toEqual(resB.observation);
    expect(fabricatedIdKeys(resA)).toEqual([]);
    expect(fabricatedIdKeys(resB)).toEqual([]);
  });
});
