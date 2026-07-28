import {
  codexConnectorCompleteCheck,
  codexHookDoctorCheck,
  codexLifecycleCoverageCheck,
  codexMcpDoctorCheck,
  doctorJson,
} from "../../src/commands/doctor";

describe("Codex connector doctor checks", () => {
  it("reports installed hooks with a stable passing id", () => {
    const out = doctorJson([codexHookDoctorCheck(true, "/tmp/codex/hooks.json")]);
    expect(out.checks).toEqual([
      expect.objectContaining({ id: "codex.hooks.registered", status: "pass" }),
    ]);
  });

  it("reports the full Codex capture lifecycle without claiming transcript parity", () => {
    const out = doctorJson([codexLifecycleCoverageCheck(true)]);
    expect(out.checks[0]).toEqual(
      expect.objectContaining({
        id: "codex.hooks.coverage",
        status: "info",
        message: expect.stringContaining(
          "Codex hook coverage: full session capture lifecycle",
        ),
      }),
    );
    expect(out.checks[0]?.message).toContain("SessionStart");
    expect(out.checks[0]?.message).toContain("PostToolUse");
    expect(out.checks[0]?.message).toContain("Stop");
    expect(out.checks[0]?.message).toContain("transcript replay remains limited");
  });

  it("keeps an unused optional Codex connector informational", () => {
    const out = doctorJson([
      codexHookDoctorCheck(false, "/tmp/codex/hooks.json"),
      codexMcpDoctorCheck({ kind: "absent", detail: "install plugin" }),
    ]);
    expect(out.status).toBe("green");
    expect(out.checks.map((check) => check.status)).toEqual(["info", "info"]);
  });

  it("reports a configured MCP server with a stable passing id", () => {
    const out = doctorJson([
      codexMcpDoctorCheck({ kind: "configured", detail: "meetless -> mla mcp" }),
    ]);
    expect(out.checks).toEqual([
      expect.objectContaining({ id: "codex.mcp.registered", status: "pass" }),
    ]);
  });

  it("fails doctor on a foreign meetless MCP entry (RC4 wiring conflict)", () => {
    const out = doctorJson([
      codexMcpDoctorCheck({
        kind: "conflict",
        detail: "a meetless MCP entry MLA does not own is registered (runs: /usr/bin/false pretend)",
      }),
    ]);
    expect(out.status).toBe("red");
    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.mcp.registered", status: "fail" }),
    );
    expect(out.checks[0]?.message).toContain("wiring conflict");
    expect(out.checks[0]?.message).toContain("/usr/bin/false pretend");
  });

  it("keeps a user-disabled meetless MCP entry informational, not a failure (RC4)", () => {
    const out = doctorJson([
      codexMcpDoctorCheck({
        kind: "disabled",
        detail: "the meetless MCP server is registered but disabled",
      }),
    ]);
    expect(out.status).toBe("green");
    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.mcp.registered", status: "info" }),
    );
    expect(out.checks[0]?.message).toContain("registered but disabled");
  });

  it("treats a disabled MCP entry as NOT installed for the half-install gate (RC4)", () => {
    // Disabled means governed retrieval is unavailable, so hooks-present +
    // MCP-disabled is a half install and must fail, exactly like a conflict.
    const out = doctorJson([
      codexConnectorCompleteCheck(true, {
        kind: "disabled",
        detail: "registered but disabled",
      }),
    ]);
    expect(out.status).toBe("red");
    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.connector.complete", status: "fail" }),
    );
  });

  it("keeps Codex optional when neither connector half is installed", () => {
    const out = doctorJson([
      codexConnectorCompleteCheck(false, { kind: "absent", detail: "missing" }),
    ]);
    expect(out.status).toBe("green");
    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.connector.complete", status: "info" }),
    );
  });

  it("fails doctor when only one Codex connector half is installed", () => {
    for (const check of [
      codexConnectorCompleteCheck(true, { kind: "absent", detail: "missing" }),
      codexConnectorCompleteCheck(false, {
        kind: "configured",
        detail: "meetless -> mla mcp",
      }),
    ]) {
      const out = doctorJson([check]);
      expect(out.status).toBe("red");
      expect(out.checks[0]).toEqual(
        expect.objectContaining({ id: "codex.connector.complete", status: "fail" }),
      );
    }
  });

  it("passes when hooks and MCP are both installed", () => {
    const out = doctorJson([
      codexConnectorCompleteCheck(true, {
        kind: "configured",
        detail: "meetless -> mla mcp",
      }),
    ]);
    expect(out.checks[0]).toEqual(
      expect.objectContaining({ id: "codex.connector.complete", status: "pass" }),
    );
    expect(out.checks[0]?.message).toContain("fully registered");
    expect(out.checks[0]?.message).toContain("/hooks trust");
  });
});
