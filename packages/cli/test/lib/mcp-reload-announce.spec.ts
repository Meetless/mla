import {
  MCP_RESTART_EXIT_CODE,
  MCP_RELOAD_FLAG,
  isMcpReload,
} from "../../src/lib/mcp-restart";
import { runMcpSupervisor, type RunMcpSupervisorDeps } from "../../src/commands/mcp-supervisor";

// M1: a supervised reload has to move the model-visible tool CONTRACT, not just
// the handler code.
//
// The supervisor holds fd 0/1 across a worker swap on purpose, so the MCP client
// never sees a disconnect. The price is that the client also never re-handshakes:
// it keeps feeding the model the tool schema it cached at spawn. That is exactly
// the M1 defect (a session served a `kb_doc_detail` schema with no `offset`, two
// days after `offset` landed on disk and while `runKbDocDetail` was already
// reading it).
//
// Measured against the real hosts on 2026-08-09 (raw JSON-RPC log, not model
// narration): Claude Code 2.1.211 re-requests tools/list 5 ms after
// `notifications/tools/list_changed` and the new schema reaches the model. A
// clean-exit respawn does NOT work for this: Claude Code respawns the process
// but never asks it for tools/list, and Codex 0.144.6 treats the exit as a fatal
// "Transport closed". So the reloaded worker must ANNOUNCE, and the supervisor is
// the only party that knows a boot is a reload.

function harness(codes: number[], over: Partial<RunMcpSupervisorDeps> = {}) {
  const spawns: string[][] = [];
  const queue = [...codes];
  const deps: RunMcpSupervisorDeps = {
    spawnChild: async (childArgv: string[]) => {
      spawns.push(childArgv);
      return queue.shift() ?? 0;
    },
    errorLog: () => {},
    now: () => 0,
    installTeardown: () => {},
    env: {},
    ...over,
  };
  return { deps, spawns };
}

describe("MCP_RELOAD_FLAG / isMcpReload", () => {
  it("is a distinct flag from --child (a worker is not necessarily a reload)", () => {
    expect(MCP_RELOAD_FLAG).not.toBe("--child");
    expect(MCP_RELOAD_FLAG.startsWith("--")).toBe(true);
  });

  it("is true only when the supervisor marked this boot as a reload", () => {
    expect(isMcpReload([MCP_RELOAD_FLAG], {})).toBe(true);
    expect(isMcpReload(["--child", MCP_RELOAD_FLAG], {})).toBe(true);
    expect(isMcpReload(["--child"], {})).toBe(false);
    expect(isMcpReload([], {})).toBe(false);
  });

  it("also honours the env signal, mirroring isMcpChild", () => {
    expect(isMcpReload([], { MEETLESS_MCP_RELOADED: "1" })).toBe(true);
    expect(isMcpReload([], { MEETLESS_MCP_RELOADED: "0" })).toBe(false);
  });
});

describe("runMcpSupervisor reload marking", () => {
  it("does NOT mark the FIRST worker as a reload (the handshake lists anyway)", async () => {
    const h = harness([0]);
    await runMcpSupervisor([], h.deps);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]).not.toContain(MCP_RELOAD_FLAG);
  });

  it("marks every RESPAWNED worker as a reload so it announces the new contract", async () => {
    const h = harness([MCP_RESTART_EXIT_CODE, MCP_RESTART_EXIT_CODE, 0]);
    await runMcpSupervisor([], h.deps);
    expect(h.spawns).toHaveLength(3);
    expect(h.spawns[0]).not.toContain(MCP_RELOAD_FLAG);
    expect(h.spawns[1]).toContain(MCP_RELOAD_FLAG);
    expect(h.spawns[2]).toContain(MCP_RELOAD_FLAG);
  });

  it("keeps the operator's argv intact and appends the marker exactly once", async () => {
    const h = harness([MCP_RESTART_EXIT_CODE, MCP_RESTART_EXIT_CODE, 0]);
    await runMcpSupervisor(["--dir", "/x"], h.deps);
    expect(h.spawns[0]).toEqual(["--dir", "/x"]);
    expect(h.spawns[1]).toEqual(["--dir", "/x", MCP_RELOAD_FLAG]);
    // No accumulation across reloads: the marker is derived from the loop state,
    // never appended to a mutated argv that grows each time round.
    expect(h.spawns[2]).toEqual(["--dir", "/x", MCP_RELOAD_FLAG]);
  });

  it("never double-marks when the operator already passed the flag", async () => {
    const h = harness([MCP_RESTART_EXIT_CODE, 0]);
    await runMcpSupervisor([MCP_RELOAD_FLAG], h.deps);
    expect(h.spawns[1].filter((a) => a === MCP_RELOAD_FLAG)).toHaveLength(1);
  });
});
