import {
  installOrphanGuard,
  ORPHAN_POLL_MS,
  type OrphanGuardDeps,
} from "../../src/lib/orphan-guard";

// Tier 1 Phase 1 (notes/20260622-mla-mcp-process-leak-findings-and-fix.md): the
// long-lived `mla mcp` worker blocks on stdin EOF as its ONLY exit path, so a
// client that dies without closing the pipe orphans it to pid 1 forever. This
// guard reaps the worker via signal handlers and a parent-death watchdog.
//
// Everything is injected so the invariants are asserted without registering real
// process listeners or wall-clock timers. Each test pins behaviour that a wrong
// implementation would break, not merely that the function ran.

interface Captured {
  deps: OrphanGuardDeps;
  signals: Record<string, () => void>;
  exits: number[];
  intervals: { fn: () => void; ms: number }[];
  unrefs: number;
  setPpid: (n: number) => void;
}

function capture(initialPpid = 4242): Captured {
  const signals: Record<string, () => void> = {};
  const exits: number[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  let unrefs = 0;
  let ppid = initialPpid;
  const deps: OrphanGuardDeps = {
    on: (signal, handler) => {
      signals[signal] = handler;
    },
    exit: (code) => {
      exits.push(code);
    },
    getPpid: () => ppid,
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms });
      return {
        unref: () => {
          unrefs += 1;
        },
      };
    },
  };
  return {
    deps,
    signals,
    exits,
    intervals,
    get unrefs() {
      return unrefs;
    },
    setPpid: (n: number) => {
      ppid = n;
    },
  } as Captured;
}

describe("installOrphanGuard", () => {
  it("exits 0 once the parent is gone (ppid === 1)", () => {
    const c = capture(500);
    installOrphanGuard(c.deps);
    // One watchdog poll is scheduled at the 5s cadence.
    expect(c.intervals).toHaveLength(1);
    expect(c.intervals[0].ms).toBe(ORPHAN_POLL_MS);

    // Parent still alive: a tick must NOT exit.
    c.intervals[0].fn();
    expect(c.exits).toEqual([]);

    // Parent reaped (reparented to launchd): the next tick exits cleanly.
    c.setPpid(1);
    c.intervals[0].fn();
    expect(c.exits).toEqual([0]);
  });

  it("exits 0 on SIGTERM, SIGINT, and SIGHUP", () => {
    const c = capture();
    installOrphanGuard(c.deps);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      expect(typeof c.signals[sig]).toBe("function");
    }
    c.signals.SIGTERM();
    c.signals.SIGINT();
    c.signals.SIGHUP();
    expect(c.exits).toEqual([0, 0, 0]);
  });

  it("unrefs the watchdog timer so it never, by itself, keeps the worker alive", () => {
    const c = capture();
    installOrphanGuard(c.deps);
    expect(c.unrefs).toBe(1);
  });

  it("honors an injected poll cadence", () => {
    const c = capture();
    installOrphanGuard({ ...c.deps, pollMs: 250 });
    expect(c.intervals[0].ms).toBe(250);
  });
});

// The supervisor (runMcpSupervisor) reuses this same guard so it gets the
// parent-death watchdog too: the orphaned-supervisor case was the MAJORITY of
// the measured leak (148 vs 61 workers), and the worker's own watchdog cannot
// cover it (a live-but-orphaned supervisor is still the worker's parent, so the
// worker's ppid is not 1). It passes onTerminate = killCurrentWorker and
// signalExitCode = 143 so the whole tree collapses cleanly. These tests pin that
// the worker is reaped BEFORE the process exits, on BOTH the signal and the
// watchdog path, and that the orphan path always exits 0.
describe("installOrphanGuard onTerminate + signalExitCode (supervisor delegation)", () => {
  // Like capture(), but onTerminate and exit append to ONE ordered log so we can
  // assert reap-before-exit ordering, not just that both happened.
  function captureOrdered(initialPpid: number) {
    const events: string[] = [];
    const intervals: { fn: () => void; ms: number }[] = [];
    const signals: Record<string, () => void> = {};
    let ppid = initialPpid;
    const deps: OrphanGuardDeps = {
      on: (signal, handler) => {
        signals[signal] = handler;
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      getPpid: () => ppid,
      setIntervalFn: (fn, ms) => {
        intervals.push({ fn, ms });
        return { unref: () => {} };
      },
      onTerminate: () => {
        events.push("terminate");
      },
    };
    return {
      deps,
      events,
      intervals,
      signals,
      setPpid: (n: number) => {
        ppid = n;
      },
    };
  }

  it("reaps via onTerminate, THEN exits with signalExitCode, on a signal", () => {
    const c = captureOrdered(500);
    installOrphanGuard({ ...c.deps, signalExitCode: 143 });
    c.signals.SIGTERM();
    // Worker killed first, then the supervisor exits 143 (not 0).
    expect(c.events).toEqual(["terminate", "exit:143"]);
  });

  it("reaps via onTerminate, THEN exits 0, on the parent-death watchdog (signalExitCode ignored)", () => {
    const c = captureOrdered(500);
    installOrphanGuard({ ...c.deps, signalExitCode: 143 });
    // Parent still alive: no teardown.
    c.intervals[0].fn();
    expect(c.events).toEqual([]);
    // Orphaned (ppid -> 1): reap the worker, then exit 0. A gone parent is a
    // clean shutdown, so the orphan path exits 0 REGARDLESS of signalExitCode.
    c.setPpid(1);
    c.intervals[0].fn();
    expect(c.events).toEqual(["terminate", "exit:0"]);
  });

  it("defaults (the worker's bare call) keep the legacy behaviour: exit 0, no terminate effect", () => {
    // runMcp calls installOrphanGuard() with neither new dep, so its behaviour
    // must be byte-identical to before: signal -> exit 0, watchdog -> exit 0,
    // and the absent onTerminate is a harmless no-op (asserted by it not
    // throwing here).
    const c = capture(500);
    installOrphanGuard(c.deps);
    c.signals.SIGTERM();
    c.setPpid(1);
    c.intervals[0].fn();
    expect(c.exits).toEqual([0, 0]);
  });
});
