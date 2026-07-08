import { MCP_RESTART_EXIT_CODE } from "../../src/lib/mcp-restart";
import {
  runMcpSupervisor,
  MCP_RESTART_MAX,
  MCP_RESTART_WINDOW_MS,
  type RunMcpSupervisorDeps,
} from "../../src/commands/mcp-supervisor";

// The supervising parent for `mla mcp`. It owns no protocol logic: it spawns a
// `mla mcp --child` worker (which inherits the parent's stdio, so the MCP client
// keeps talking to the SAME pipe across reloads), waits for it to exit, and:
//   - on MCP_RESTART_EXIT_CODE: respawns a fresh worker (loads the new dist),
//   - on anything else (0 clean disconnect, 1/2 error): propagates and exits.
// A storm cap stops a pathological reload loop (e.g. a build-info clock skew)
// from respawning forever; outside the window the count slides so legitimate
// back-to-back dev rebuilds keep self-healing. spawnChild/now are injected so
// this is driven without real child processes or wall-clock.

interface SupHarness {
  deps: RunMcpSupervisorDeps;
  spawns: string[][];
  errors: string[];
  // Indices (into spawns) of the workers whose kill() the supervisor invoked.
  kills: number[];
  // Fires the supervisor's installed teardown, simulating a SIGTERM to the
  // supervisor. No-op until runMcpSupervisor has called installTeardown.
  fireTeardown: () => void;
}

function harness(codes: number[], over: Partial<RunMcpSupervisorDeps> = {}): SupHarness {
  const spawns: string[][] = [];
  const errors: string[] = [];
  const kills: number[] = [];
  const queue = [...codes];
  let teardownKill: () => void = () => {};
  const deps: RunMcpSupervisorDeps = {
    spawnChild: async (childArgv: string[], onChild) => {
      const index = spawns.length;
      spawns.push(childArgv);
      // Hand the supervisor a killer that records WHICH worker it reaped, so a
      // test can prove the in-flight worker (not a stale one) was targeted.
      onChild?.(() => kills.push(index));
      const code = queue.shift();
      // Default queued-but-empty to a clean disconnect so a test can never spin.
      return code ?? 0;
    },
    errorLog: (m) => errors.push(m),
    now: () => 0,
    // Capture the supervisor's killCurrent so a test can fire a signal at will,
    // without registering a real process listener that would outlive the test.
    installTeardown: (killCurrent) => {
      teardownKill = killCurrent;
    },
    env: {},
    ...over,
  };
  return { deps, spawns, errors, kills, fireTeardown: () => teardownKill() };
}

describe("runMcpSupervisor", () => {
  it("respawns the worker on a restart-code exit, then returns the worker's clean exit", async () => {
    const h = harness([MCP_RESTART_EXIT_CODE, 0]);
    const code = await runMcpSupervisor([], h.deps);
    expect(code).toBe(0);
    expect(h.spawns).toHaveLength(2);
  });

  it("returns a clean disconnect (0) without respawning", async () => {
    const h = harness([0]);
    const code = await runMcpSupervisor([], h.deps);
    expect(code).toBe(0);
    expect(h.spawns).toHaveLength(1);
  });

  it("propagates a worker error code (1) without respawning", async () => {
    const h = harness([1]);
    const code = await runMcpSupervisor([], h.deps);
    expect(code).toBe(1);
    expect(h.spawns).toHaveLength(1);
  });

  it("propagates a guard-failure code (2) without respawning", async () => {
    const h = harness([2]);
    const code = await runMcpSupervisor([], h.deps);
    expect(code).toBe(2);
    expect(h.spawns).toHaveLength(1);
  });

  it("passes the supervisor argv through to every spawned worker", async () => {
    const h = harness([MCP_RESTART_EXIT_CODE, 0]);
    await runMcpSupervisor(["--dir", "/x"], h.deps);
    expect(h.spawns).toEqual([
      ["--dir", "/x"],
      ["--dir", "/x"],
    ]);
  });

  it("gives up after a restart storm inside the window (never loops forever)", async () => {
    // Worker keeps asking to reload; clock is frozen so every restart lands in
    // the window. The parent must bail rather than respawn without bound.
    const h = harness(
      Array(MCP_RESTART_MAX + 5).fill(MCP_RESTART_EXIT_CODE),
      { now: () => 0 },
    );
    const code = await runMcpSupervisor([], h.deps);
    expect(code).toBe(MCP_RESTART_EXIT_CODE);
    // MCP_RESTART_MAX rapid reloads are tolerated; the (MAX+1)th trips the cap.
    expect(h.spawns).toHaveLength(MCP_RESTART_MAX + 1);
    expect(h.errors.join("\n")).toMatch(/restart your editor/i);
  });

  it("slides the window so reloads spread beyond it never trip the storm cap", async () => {
    // Each restart is stamped a full window past the previous, so the recent
    // count never exceeds 1. Far more than MAX reloads still self-heal.
    let clock = 0;
    const reloads = MCP_RESTART_MAX + 3;
    const h = harness(
      [...Array(reloads).fill(MCP_RESTART_EXIT_CODE), 0],
      {
        now: () => {
          const t = clock;
          clock += MCP_RESTART_WINDOW_MS + 1;
          return t;
        },
      },
    );
    const code = await runMcpSupervisor([], h.deps);
    expect(code).toBe(0);
    expect(h.spawns).toHaveLength(reloads + 1);
    expect(h.errors.join("\n")).not.toMatch(/giving up|storm/i);
  });

  // Tier 1 Phase 2 (notes/20260622-mla-mcp-process-leak-findings-and-fix.md):
  // the supervisor must reap its worker on its OWN death. Before this, a SIGTERM
  // to the supervisor exited it while the worker, still blocked on a stdin whose
  // EOF never came, was reparented to pid 1 and leaked.
  describe("teardown", () => {
    it("kills the in-flight worker when the supervisor itself is signalled", async () => {
      let resolveChild: (code: number) => void = () => {};
      const kills: number[] = [];
      let teardownKill: () => void = () => {};
      const deps: RunMcpSupervisorDeps = {
        spawnChild: (_argv, onChild) => {
          onChild?.(() => kills.push(0));
          return new Promise<number>((res) => {
            resolveChild = res;
          });
        },
        installTeardown: (k) => {
          teardownKill = k;
        },
        errorLog: () => {},
        now: () => 0,
        env: {},
      };

      const running = runMcpSupervisor([], deps);
      // Worker is in-flight (spawn promise still pending). The supervisor's
      // teardown must SIGTERM it rather than orphan it.
      teardownKill();
      expect(kills).toEqual([0]);

      // Let the worker finish so the loop returns and the test settles.
      resolveChild(143);
      await running;
    });

    it("does not kill a worker that has already exited (no stale / double kill)", async () => {
      const h = harness([0]);
      await runMcpSupervisor([], h.deps);
      // The worker exited cleanly, so killCurrent was reset to a no-op. A late
      // signal must reap nothing: the pid is dead, and the OS may have recycled
      // it for an unrelated process we must never kill.
      h.fireTeardown();
      expect(h.kills).toEqual([]);
    });

    it("after a reload, teardown targets the NEW worker, not the replaced one", async () => {
      let resolveSecond: (code: number) => void = () => {};
      const kills: number[] = [];
      let teardownKill: () => void = () => {};
      let index = -1;
      const deps: RunMcpSupervisorDeps = {
        spawnChild: (_argv, onChild) => {
          index += 1;
          const i = index;
          onChild?.(() => kills.push(i));
          if (i === 0) return Promise.resolve(MCP_RESTART_EXIT_CODE);
          return new Promise<number>((res) => {
            resolveSecond = res;
          });
        },
        installTeardown: (k) => {
          teardownKill = k;
        },
        errorLog: () => {},
        now: () => 0,
        env: {},
      };

      const running = runMcpSupervisor([], deps);
      // Flush microtasks so the first worker reloads and the second spawns and
      // stays in-flight.
      await new Promise((r) => setImmediate(r));

      teardownKill();
      // Only the live (second) worker is reaped; the replaced one is long gone.
      expect(kills).toEqual([1]);

      resolveSecond(0);
      await running;
    });
  });
});
