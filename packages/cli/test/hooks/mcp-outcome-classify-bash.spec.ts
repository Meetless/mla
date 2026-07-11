// Regression: classify_mcp_outcome in common.sh must honestly map a PostToolUse
// hook INPUT to success | error | unknown for the agent's own meetless MCP calls.
//
// This drives the REAL function (sourced from common.sh, not a re-implementation)
// exactly like the canonicalize_agent_session_id bash twin, because the bug this
// guards against was precisely a classifier that drifted from the real hook-input
// shape: Claude Code delivers a SUCCESSFUL MCP tool_response as the UNWRAPPED
// content-block ARRAY ([{type:"text",text:"{...}"}]) with no isError, but the
// original classifier only matched a {content,isError} OBJECT, so every governed
// pull landed as "unknown" and the value dimension was under-counted. Verified
// against a raw hook-input dump 2026-07-11. A copy of the jq here could re-drift;
// sourcing the real function cannot.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");

// Source the real common.sh (its stdout/stderr suppressed), read the hook INPUT
// json from stdin, and print exactly what classify_mcp_outcome returns.
const SCRIPT =
  'source "$COMMON_SH" >/dev/null 2>&1; classify_mcp_outcome';

interface OutcomeCase {
  name: string;
  input: unknown;
  expected: "success" | "error" | "unknown";
}

// A real successful retrieve_knowledge hit: tool_response is the unwrapped MCP
// content-block array whose one text block is the tool's JSON result. This is the
// exact shape the original classifier misread as "unknown".
const REAL_SUCCESS_ARRAY = {
  tool_name: "mcp__meetless__meetless__retrieve_knowledge",
  tool_response: [
    {
      type: "text",
      text: JSON.stringify({
        tool: "meetless__retrieve_knowledge",
        workspace: "ws_x",
        query: "anything",
        count: 2,
        candidates: [{ citation: "NT:notes/a.md" }],
      }),
    },
  ],
};

const cases: OutcomeCase[] = [
  { name: "real success content-block array", input: REAL_SUCCESS_ARRAY, expected: "success" },
  {
    name: "server error envelope in array text (defensive, if CC ever fires the hook)",
    input: {
      tool_response: [
        { type: "text", text: JSON.stringify({ tool: "x", error: "not found", status: 404 }) },
      ],
    },
    expected: "error",
  },
  {
    name: "legacy wrapped object with isError:true",
    input: { tool_response: { isError: true, content: [] } },
    expected: "error",
  },
  {
    name: "legacy wrapped object with content, no isError",
    input: { tool_response: { content: [{ type: "text", text: "ok" }] } },
    expected: "success",
  },
  {
    name: "non-empty array whose text is not JSON is still a completed pull",
    input: { tool_response: [{ type: "text", text: "plain non-json result" }] },
    expected: "success",
  },
  {
    name: "array text carrying status 200 only is success",
    input: { tool_response: [{ type: "text", text: JSON.stringify({ status: 200, ok: true }) }] },
    expected: "success",
  },
  { name: "empty array is unknown", input: { tool_response: [] }, expected: "unknown" },
  { name: "null tool_response is unknown", input: { tool_response: null }, expected: "unknown" },
  { name: "missing tool_response is unknown", input: { foo: 1 }, expected: "unknown" },
  { name: "bare-string tool_response is unknown", input: { tool_response: "just a string" }, expected: "unknown" },
  {
    name: "falls back to tool_result when tool_response absent",
    input: { tool_result: [{ type: "text", text: JSON.stringify({ count: 1 }) }] },
    expected: "success",
  },
];

describe("classify_mcp_outcome bash twin (governed MCP outcome, §3.3)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-mcp-outcome-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function classify(input: unknown): string {
    return execFileSync("bash", ["-c", SCRIPT], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", COMMON_SH },
    });
  }

  it.each(cases)("classifies: $name", ({ input, expected }) => {
    expect(classify(input)).toBe(expected);
  });

  it("only ever emits one of the three honest values", () => {
    for (const c of cases) {
      expect(["success", "error", "unknown"]).toContain(classify(c.input));
    }
  });
});
