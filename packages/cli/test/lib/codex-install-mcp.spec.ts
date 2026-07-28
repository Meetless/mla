// The command layer (`mla codex install`) reporting AND exit semantics for the
// MCP half. Unlike the automatic `runWire` path (which stays fail-soft so Claude
// wiring is never blocked by Codex), an operator who TYPED `mla codex install` is
// asking to COMPLETE the Codex connector: the command exits 0 only when hooks
// reconciled AND the MCP server is present-and-usable (`added`, or canonical
// enabled `unchanged`). A conflict, a disabled entry, or a skip prints the full
// partial result (hooks stay registered, trust notice still prints) and then
// exits NONZERO (§RC2). Reporting is source-neutral: only `added` names
// config.toml, because `codex mcp get`/`list` cannot prove where a present entry
// was declared (§RC1). Every seam (scripts, hooks, MCP) is injected so no real
// Codex, filesystem, or child process is involved.

import { runCodexInstall, CODEX_INSTALL_TRUST_NOTICE } from "../../src/commands/codex";
import type { CodexMcpResult } from "../../src/connectors/codex/wire";
import type { ReconcileResult } from "../../src/lib/hook-reconcile";

const HOOKS: ReconcileResult = {
  changed: true,
  filePath: "/tmp/cx/hooks.json",
  added: [],
} as unknown as ReconcileResult;

async function install(
  mcp: CodexMcpResult,
  opts: { ensureHooks?: () => ReconcileResult } = {},
) {
  const logs: string[] = [];
  const errs: string[] = [];
  const code = await runCodexInstall([], {
    log: (m) => logs.push(m),
    errlog: (m) => errs.push(m),
    ensureScripts: () => [],
    ensureHooks: opts.ensureHooks ?? (() => HOOKS),
    ensureMcp: () => mcp,
  });
  return { code, out: logs.join("\n"), err: errs.join("\n") };
}

describe("runCodexInstall: MCP reporting + exit semantics (RC1 source-neutral, RC2 exit)", () => {
  it("exits 0 on `added`, names config.toml, and always prints the trust notice", async () => {
    const { code, out } = await install({ action: "added", configPath: "/tmp/cx/config.toml" });
    expect(code).toBe(0);
    expect(out).toContain("Registered the Meetless MCP server in /tmp/cx/config.toml.");
    expect(out).toContain(CODEX_INSTALL_TRUST_NOTICE);
  });

  it("exits 0 on `unchanged` and reports source-neutrally, never naming config.toml", async () => {
    const { code, out } = await install({
      action: "unchanged",
      configPath: "/tmp/cx/config.toml",
    });
    expect(code).toBe(0);
    expect(out).toContain(
      "Meetless MCP server already available to Codex; no configuration change was made.",
    );
    expect(out).not.toContain("/tmp/cx/config.toml");
    expect(out).not.toContain("provided by a plugin");
    expect(out).toContain(CODEX_INSTALL_TRUST_NOTICE);
  });

  it("exits NONZERO on a preserved-disabled entry (incomplete connector) but still prints the trust notice", async () => {
    const { code, out } = await install({
      action: "preserved-disabled",
      configPath: "/tmp/cx/config.toml",
      detail: "registered but disabled",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("Meetless MCP server is available but disabled; preserving the existing setting.");
    // The successful half is NOT rolled back: hooks + trust notice still printed.
    expect(out).toContain(CODEX_INSTALL_TRUST_NOTICE);
  });

  it("exits NONZERO on a conflict, surfacing the exact existing command+args on stderr", async () => {
    const { code, out, err } = await install({
      action: "conflict",
      configPath: "/tmp/cx/config.toml",
      detail: "an entry MLA does not own already exists",
      existingCommand: "/usr/bin/false",
      existingArgs: ["pretend"],
    });
    expect(code).not.toBe(0);
    expect(err).toContain("A different Meetless MCP registration already exists; MLA did not replace it.");
    expect(err).toContain("/usr/bin/false pretend");
    // Hooks succeeded, so the trust notice still prints (no rollback).
    expect(out).toContain(CODEX_INSTALL_TRUST_NOTICE);
  });

  it("exits NONZERO when codex is absent (skip), printing the reason and the trust notice", async () => {
    const { code, out, err } = await install({
      action: "skipped",
      configPath: "/tmp/cx/config.toml",
      detail: "the `codex` executable is not on PATH; skipped Codex MCP registration.",
    });
    expect(code).not.toBe(0);
    expect(err).toContain("Meetless MCP server NOT registered");
    expect(err).toContain("not on PATH");
    expect(out).toContain(CODEX_INSTALL_TRUST_NOTICE);
  });

  it("exits NONZERO when Codex config would not load (skip)", async () => {
    const { code, err } = await install({
      action: "skipped",
      configPath: "/tmp/cx/config.toml",
      detail: "Codex could not load its config, so MLA left it untouched: TOML parse error.",
    });
    expect(code).not.toBe(0);
    expect(err).toContain("Meetless MCP server NOT registered");
    expect(err).toContain("could not load its config");
  });

  it("exits NONZERO and never reaches MCP when hook reconciliation throws (malformed hooks.json)", async () => {
    const { code, out } = await install(
      { action: "added", configPath: "/tmp/cx/config.toml" },
      {
        ensureHooks: () => {
          throw new Error("hooks.json is not valid JSON");
        },
      },
    );
    expect(code).not.toBe(0);
    // A hook failure aborts before the trust notice: hooks were NOT registered.
    expect(out).not.toContain(CODEX_INSTALL_TRUST_NOTICE);
  });
});
