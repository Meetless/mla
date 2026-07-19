// `mla _internal capture-work-product` -- the LIVE hook entry that stages the agent's own
// work product for the material-incorporation correlator (P1). These lock the two hook
// contracts the shell wires: post_tool_use composes diff-shaped hunk(s) from the raw
// PostToolUse tool_input, and stop stages the closing assistant message piped as raw text.
// Behavioral end to end: an absolute MEETLESS_HOME points the store at a temp dir, stdin is
// injected, and every assertion reads the ACTUAL staged records via readCaptures (no mock of
// the store). Consent, missing session/turn, and malformed input are all fail-soft (exit 0),
// while a strict argv parse error is the only exit-2 path.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runInternalCaptureWorkProduct } from "../../src/commands/internal-capture-work-product";
import {
  captureStoreDir,
  readCaptures,
} from "../../src/lib/analytics/work-product-capture";

const NOW = "2026-07-17T12:00:00.000Z";
const SESSION = "sess-abc";

function tmpEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpc-cmd-"));
  // Absolute MEETLESS_HOME -> resolveMeetlessHome returns it verbatim, so the capture store
  // lands under <dir>/work-product-capture with no real-home leakage. Trace upload defaults
  // ON (absence = enabled), so consent is granted unless a case sets MEETLESS_TRACE_UPLOAD.
  return { MEETLESS_HOME: dir, ...over } as NodeJS.ProcessEnv;
}

// A stdin injector so no real pipe is needed; mirrors the hook piping tool JSON / final text.
const stdin = (s: string) => () => Promise.resolve(s);

// A minimal PostToolUse hook payload for a file tool.
function postToolUse(tool: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ tool_name: tool, tool_input: toolInput });
}

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

// The status line the command prints to stdout (its single console.log). Lets a case assert
// the machine-readable outcome without coupling to the exit code alone.
function lastStatus(): Record<string, unknown> {
  const calls = logSpy.mock.calls;
  return JSON.parse(String(calls[calls.length - 1][0])) as Record<string, unknown>;
}

describe("stop event (closing assistant message)", () => {
  it("stages one assistant_output capture from the piped final text", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "stop", "--session", SESSION, "--turn", "7"],
      { env, readStdin: stdin("Here is the final summary of the turn."), nowIso: NOW },
    );
    expect(rc).toBe(0);
    const recs = readCaptures(SESSION, env);
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("assistant_output");
    expect(recs[0].turn_index).toBe(7);
    expect(recs[0].text).toBe("Here is the final summary of the turn.");
    expect(recs[0].ts).toBe(NOW);
  });

  it("stages nothing for an empty / whitespace-only final message", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "stop", "--session", SESSION, "--turn", "7"],
      { env, readStdin: stdin("   \n  ") },
    );
    expect(rc).toBe(0);
    expect(readCaptures(SESSION, env)).toHaveLength(0);
    expect(lastStatus().reason).toBe("empty_output");
  });
});

describe("post_tool_use event (changed-code hunks)", () => {
  it("Edit -> one diff-shaped before/after hunk keyed to the turn", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "3"],
      {
        env,
        nowIso: NOW,
        readStdin: stdin(
          postToolUse("Edit", {
            file_path: "/repo/src/a.ts",
            old_string: "const x = 1;",
            new_string: "const x = 2;",
          }),
        ),
      },
    );
    expect(rc).toBe(0);
    const recs = readCaptures(SESSION, env);
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("hunk");
    expect(recs[0].turn_index).toBe(3);
    expect(recs[0].file).toBe("/repo/src/a.ts");
    expect(recs[0].tool).toBe("Edit");
    expect(recs[0].hunk).toBe("- const x = 1;\n+ const x = 2;");
  });

  it("MultiEdit -> one hunk per edit, in order", async () => {
    const env = tmpEnv();
    await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "4"],
      {
        env,
        readStdin: stdin(
          postToolUse("MultiEdit", {
            file_path: "/repo/src/b.ts",
            edits: [
              { old_string: "a", new_string: "A" },
              { old_string: "b", new_string: "B" },
            ],
          }),
        ),
      },
    );
    const recs = readCaptures(SESSION, env).filter((r) => r.kind === "hunk");
    expect(recs).toHaveLength(2);
    expect(recs[0].hunk).toBe("- a\n+ A");
    expect(recs[1].hunk).toBe("- b\n+ B");
    expect(recs.every((r) => r.file === "/repo/src/b.ts")).toBe(true);
  });

  it("Write -> one all-additions hunk", async () => {
    const env = tmpEnv();
    await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "1"],
      {
        env,
        readStdin: stdin(
          postToolUse("Write", { file_path: "/repo/new.md", content: "line 1\nline 2" }),
        ),
      },
    );
    const recs = readCaptures(SESSION, env);
    expect(recs).toHaveLength(1);
    expect(recs[0].hunk).toBe("+ line 1\n+ line 2");
    expect(recs[0].file).toBe("/repo/new.md");
  });

  it("NotebookEdit -> uses notebook_path and new_source", async () => {
    const env = tmpEnv();
    await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "2"],
      {
        env,
        readStdin: stdin(
          postToolUse("NotebookEdit", {
            notebook_path: "/repo/nb.ipynb",
            new_source: "print(1)",
          }),
        ),
      },
    );
    const recs = readCaptures(SESSION, env);
    expect(recs).toHaveLength(1);
    expect(recs[0].file).toBe("/repo/nb.ipynb");
    expect(recs[0].hunk).toBe("+ print(1)");
  });

  it("redacts a secret inside a hunk before it touches disk", async () => {
    const env = tmpEnv();
    const secret = "b".repeat(40);
    await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "5"],
      {
        env,
        readStdin: stdin(
          postToolUse("Write", {
            file_path: "/repo/.env",
            content: `API_TOKEN=${secret}`,
          }),
        ),
      },
    );
    const recs = readCaptures(SESSION, env);
    expect(recs).toHaveLength(1);
    expect(recs[0].hunk).not.toContain(secret);
    expect(recs[0].hunk).toContain("[REDACTED]");
  });

  it("a non-file tool composes zero hunks and stages nothing (captured:false)", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "6"],
      { env, readStdin: stdin(postToolUse("Bash", { command: "ls" })) },
    );
    expect(rc).toBe(0);
    expect(readCaptures(SESSION, env)).toHaveLength(0);
    expect(lastStatus().captured).toBe(false);
  });

  it("malformed hook JSON is fail-soft (exit 0, nothing staged)", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "6"],
      { env, readStdin: stdin("{not json") },
    );
    expect(rc).toBe(0);
    expect(readCaptures(SESSION, env)).toHaveLength(0);
    expect(lastStatus().reason).toBe("bad_json");
  });
});

describe("session + turn resolution", () => {
  it("falls back to CLAUDE_CODE_SESSION_ID when --session is absent", async () => {
    const env = tmpEnv({ CLAUDE_CODE_SESSION_ID: "env-sess" });
    await runInternalCaptureWorkProduct(
      ["--event", "stop", "--turn", "9"],
      { env, readStdin: stdin("final") },
    );
    expect(readCaptures("env-sess", env)).toHaveLength(1);
  });

  it("stages nothing when no session id can be resolved", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "stop", "--turn", "9"],
      { env, readStdin: stdin("final") },
    );
    expect(rc).toBe(0);
    expect(lastStatus().reason).toBe("no_session");
    // No file was created for any session.
    expect(fs.existsSync(captureStoreDir(env))).toBe(false);
  });

  it("stages nothing when the turn is missing or non-integer", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "stop", "--session", SESSION],
      { env, readStdin: stdin("final") },
    );
    expect(rc).toBe(0);
    expect(lastStatus().reason).toBe("no_turn");
    expect(readCaptures(SESSION, env)).toHaveLength(0);
  });
});

describe("consent gate (§11)", () => {
  it("stages nothing when trace upload is turned off", async () => {
    const env = tmpEnv({ MEETLESS_TRACE_UPLOAD: "off" });
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "post_tool_use", "--session", SESSION, "--turn", "3"],
      {
        env,
        readStdin: stdin(
          postToolUse("Edit", {
            file_path: "/repo/a.ts",
            old_string: "x",
            new_string: "y",
          }),
        ),
      },
    );
    expect(rc).toBe(0);
    expect(lastStatus().reason).toBe("consent_off");
    expect(readCaptures(SESSION, env)).toHaveLength(0);
  });

  it("stages nothing when the master telemetry kill switch is set", async () => {
    const env = tmpEnv({ MEETLESS_TELEMETRY: "off" });
    await runInternalCaptureWorkProduct(
      ["--event", "stop", "--session", SESSION, "--turn", "3"],
      { env, readStdin: stdin("final message") },
    );
    expect(readCaptures(SESSION, env)).toHaveLength(0);
  });
});

describe("argv discipline", () => {
  it("returns 2 on an invalid --event and stages nothing", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "bogus", "--session", SESSION, "--turn", "3"],
      { env, readStdin: stdin("x") },
    );
    expect(rc).toBe(2);
    expect(readCaptures(SESSION, env)).toHaveLength(0);
  });

  it("returns 2 on an unknown flag", async () => {
    const env = tmpEnv();
    const rc = await runInternalCaptureWorkProduct(
      ["--event", "stop", "--bogus"],
      { env, readStdin: stdin("x") },
    );
    expect(rc).toBe(2);
  });
});
