import {
  parseReportArgs,
  extractWorkspaceOverride,
  isWorkspaceAccessDenied,
  workspaceAccessDeniedGuidance,
  workspaceAccessDeniedReadGuidance,
} from "../../src/commands/bug";

// BUG-2 I: `mla bug report|list|status` must accept a `--workspace <id>` admin
// override so an operator running from an unbound directory (or one whose marker
// points at a workspace they are not a member of) can still file/track a report,
// and a marker-model 403 must surface actionable guidance instead of a raw
// `POST ... -> HTTP 403: {...}` wire error.

describe("parseReportArgs --workspace", () => {
  it("parses --workspace <id>", () => {
    const f = parseReportArgs(["--workspace", "ws_abc", "--message", "boom"]);
    expect(f.workspace).toBe("ws_abc");
    expect(f.message).toBe("boom");
  });

  it("parses the -w alias", () => {
    expect(parseReportArgs(["-w", "ws_xyz"]).workspace).toBe("ws_xyz");
  });

  it("rejects --workspace with no value (never silently drops)", () => {
    expect(() => parseReportArgs(["--workspace"])).toThrow(/Missing value for --workspace/);
    // A following flag is not a value.
    expect(() => parseReportArgs(["--workspace", "--yes"])).toThrow(/Missing value for --workspace/);
  });

  it("leaves workspace undefined when the flag is absent", () => {
    expect(parseReportArgs(["--message", "x"]).workspace).toBeUndefined();
  });
});

describe("extractWorkspaceOverride (list/status positional argv)", () => {
  it("pulls --workspace out and returns the remaining argv", () => {
    expect(extractWorkspaceOverride(["--workspace", "ws1", "BUG-7"])).toEqual({
      workspace: "ws1",
      rest: ["BUG-7"],
    });
  });

  it("pulls -w from anywhere in the argv", () => {
    expect(extractWorkspaceOverride(["BUG-9", "-w", "ws2"])).toEqual({
      workspace: "ws2",
      rest: ["BUG-9"],
    });
  });

  it("no override -> argv unchanged, workspace undefined", () => {
    expect(extractWorkspaceOverride(["BUG-1"])).toEqual({ workspace: undefined, rest: ["BUG-1"] });
    expect(extractWorkspaceOverride([])).toEqual({ workspace: undefined, rest: [] });
  });

  it("throws on -w with no value", () => {
    expect(() => extractWorkspaceOverride(["-w"])).toThrow(/Missing value for -w/);
  });
});

describe("isWorkspaceAccessDenied", () => {
  it("true only for a 403 carrying the WORKSPACE_ACCESS_DENIED code", () => {
    const e = Object.assign(
      new Error('POST /internal/v1/bug-reports/upload-url -> HTTP 403: {"code":"WORKSPACE_ACCESS_DENIED"}'),
      { status: 403 },
    );
    expect(isWorkspaceAccessDenied(e)).toBe(true);
  });

  it("false for a 403 that is a different policy (e.g. tracing disabled)", () => {
    const e = Object.assign(
      new Error('POST x -> HTTP 403: {"code":"TRACING_NOT_ENABLED_FOR_WORKSPACE"}'),
      { status: 403 },
    );
    expect(isWorkspaceAccessDenied(e)).toBe(false);
  });

  it("false for a non-403 even if the body mentions the code", () => {
    const e = Object.assign(new Error("HTTP 500: WORKSPACE_ACCESS_DENIED"), { status: 500 });
    expect(isWorkspaceAccessDenied(e)).toBe(false);
  });

  it("false for a plain network error (no status)", () => {
    expect(isWorkspaceAccessDenied(new Error("ECONNREFUSED"))).toBe(false);
    expect(isWorkspaceAccessDenied(null)).toBe(false);
  });
});

describe("workspaceAccessDeniedGuidance", () => {
  it("marker path: names the workspace and points at --workspace as the escape hatch", () => {
    const g = workspaceAccessDeniedGuidance("ws_marker", false);
    expect(g).toContain("ws_marker");
    expect(g).toContain(".meetless.json");
    expect(g).toContain("mla bug report --workspace <id>");
  });

  it("override path: does not blame the marker, tells them to pick a workspace they belong to", () => {
    const g = workspaceAccessDeniedGuidance("ws_override", true);
    expect(g).toContain("ws_override");
    expect(g).not.toContain(".meetless.json");
    expect(g).toContain("--workspace <id>");
  });
});

describe("workspaceAccessDeniedReadGuidance (BUG-7: list/status is a lookup, not a filing)", () => {
  // A 403 body carrying the canonical server message; the read path leads with it.
  const deniedErr = Object.assign(
    new Error(
      'GET /internal/v1/bug-reports -> HTTP 403: {"code":"WORKSPACE_ACCESS_DENIED",' +
        '"message":"You are not a member of workspace \'ws_marker\'. Ask a workspace admin to add you to it."}',
    ),
    {
      status: 403,
      body:
        '{"code":"WORKSPACE_ACCESS_DENIED",' +
        '"message":"You are not a member of workspace \'ws_marker\'. Ask a workspace admin to add you to it.",' +
        '"details":{"requestedWorkspaceId":"ws_marker"}}',
    },
  );

  it("leads with the canonical membership line, never the filing lie 'was not filed'", () => {
    const g = workspaceAccessDeniedReadGuidance(deniedErr, "ws_marker", false);
    expect(g).toContain("You are not a member of workspace 'ws_marker'.");
    // The read path must NOT claim the report was not filed: it is a lookup, and
    // the report may well exist in the workspace being read.
    expect(g).not.toContain("was not filed");
  });

  it("marker path: names the bound workspace + the .meetless.json marker + the --workspace escape hatch", () => {
    const g = workspaceAccessDeniedReadGuidance(deniedErr, "ws_marker", false);
    expect(g).toContain(".meetless.json");
    expect(g).toContain("ws_marker");
    expect(g).toContain("--workspace <id>");
  });

  it("override path: does not blame the marker", () => {
    const g = workspaceAccessDeniedReadGuidance(deniedErr, "ws_override", true);
    expect(g).not.toContain(".meetless.json");
    expect(g).toContain("--workspace <id>");
  });
});
