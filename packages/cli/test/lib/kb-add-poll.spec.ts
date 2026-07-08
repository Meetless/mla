import {
  pollReceiptsToTerminal,
  PolledExtraction,
  ExtractionPollDeps,
} from "../../src/commands/kb_add";
import { KbAddReceipt } from "../../src/lib/render";

// Behavioral lock for B3 (sync-extract-by-default poll) from
// notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 (B3) and §7.4
// ("B3 polling idempotency"). The contract, restated:
//
//   - `kb add <file>` (no --queue) blocks on the worker-owned GRAPH_EXTRACT job
//     by POLLING the intel detail route to a terminal state (completed/failed)
//     or a wall-clock budget (~25s). It never forks an inline executor: the
//     single-writer invariant holds because the CLI only READS job state.
//   - On timeout it degrades to the honest queued/running state (so the receipt
//     points the operator at `mla kb show` / `mla kb pending`), never a false
//     "done".
//   - `--queue` returns immediately (no poll); corpus / bulk ingest is
//     async-default and is never polled serially.
//   - Only a body-changing FILE ingest enqueues extraction, so only those
//     receipts are polled. A no-op restore / a failed ingest / a corpus rollup
//     is skipped.
//
// We test the poll state machine in isolation by injecting fetchExtraction +
// sleep + now, so the suite runs instantly and deterministically and asserts
// the exact stop conditions (terminal, timeout, pre-B2 null, transient error)
// without a live intel.

function receipt(over: Partial<KbAddReceipt> = {}): KbAddReceipt {
  return {
    mode: "file",
    workspaceId: "ws_test",
    outcome: "ingested",
    documentId: "doc_1",
    canonicalPath: "notes/x.md",
    parentUuid: "p".repeat(32),
    provenance: "external_imported",
    ...over,
  };
}

// A deterministic clock: now() reads a counter that sleep() advances. Lets a
// test drive the budget deadline without real timers.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

// Drive fetchExtraction from a scripted sequence; record the call count so a
// test can assert "never polled" / "polled exactly N times".
function scriptedFetch(seq: Array<PolledExtraction | null>) {
  let i = 0;
  const calls: string[] = [];
  const fetchExtraction: ExtractionPollDeps["fetchExtraction"] = async (id) => {
    calls.push(id);
    // After the script is exhausted, keep returning the last value so a
    // timeout test (always queued/running) can poll until the budget.
    const v = i < seq.length ? seq[i] : seq[seq.length - 1];
    i += 1;
    return v;
  };
  return { fetchExtraction, calls };
}

const FAST_OPTS = { budgetMs: 4500, intervalMs: 1500 };

describe("B3 pollReceiptsToTerminal: --queue opt-out", () => {
  it("never polls when queue=true and leaves the inferred state untouched", async () => {
    const r = receipt();
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([{ state: "completed" }]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: true },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    expect(calls).toHaveLength(0);
    expect(r.extraction).toBeUndefined();
  });
});

describe("B3 pollReceiptsToTerminal: terminal states", () => {
  it("polls a body-changing file ingest to completed and records the candidate counts", async () => {
    const r = receipt();
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([
      { state: "queued" },
      { state: "running" },
      { state: "completed", candidateCount: 3, conflictCount: 1, jobId: "job_done" },
    ]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    // It walked queued -> running -> completed and STOPPED at the terminal state.
    expect(calls).toHaveLength(3);
    expect(r.extraction).toEqual({
      state: "completed",
      candidateCount: 3,
      conflictCount: 1,
      jobId: "job_done",
    });
  });

  it("stops on a failed extraction and records the failed state", async () => {
    const r = receipt();
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([
      { state: "running" },
      { state: "failed", jobId: "job_fail" },
    ]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    expect(calls).toHaveLength(2);
    expect(r.extraction?.state).toBe("failed");
    expect(r.extraction?.jobId).toBe("job_fail");
  });
});

describe("B3 pollReceiptsToTerminal: timeout honesty", () => {
  it("renders the honest queued state on budget exhaustion (never a false 'done')", async () => {
    const r = receipt();
    const clock = fakeClock();
    // The job never finishes within the budget.
    const { fetchExtraction, calls } = scriptedFetch([{ state: "queued" }]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    // budget 4500 / interval 1500 -> polls at t=0,1500,3000,4500 then the
    // deadline check fires: bounded, not infinite.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(5);
    // The receipt carries the last-observed in-progress state, NOT completed.
    expect(r.extraction?.state).toBe("queued");
  });

  it("carries a still-running state through to the timeout", async () => {
    const r = receipt();
    const clock = fakeClock();
    const { fetchExtraction } = scriptedFetch([{ state: "running", jobId: "job_slow" }]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    expect(r.extraction?.state).toBe("running");
    expect(r.extraction?.jobId).toBe("job_slow");
  });
});

describe("B3 pollReceiptsToTerminal: which receipts are eligible", () => {
  it("never polls a corpus rollup receipt (async-default)", async () => {
    const r = receipt({ mode: "corpus" });
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([{ state: "completed" }]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    expect(calls).toHaveLength(0);
    expect(r.extraction).toBeUndefined();
  });

  it("never polls a content-identical no-op (no body change enqueues no extraction)", async () => {
    const r = receipt({ outcome: "noop_unchanged" });
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([{ state: "completed" }]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    expect(calls).toHaveLength(0);
    expect(r.extraction).toBeUndefined();
  });

  it("polls a body-changing ingest that completes with zero candidates", async () => {
    const r = receipt({ outcome: "ingested" });
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([{ state: "completed", candidateCount: 0 }]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    expect(calls).toHaveLength(1);
    expect(r.extraction?.state).toBe("completed");
  });

  it("never polls a failed ingest", async () => {
    const r = receipt({ outcome: "failed" });
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([{ state: "completed" }]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    expect(calls).toHaveLength(0);
  });
});

describe("B3 pollReceiptsToTerminal: degradation", () => {
  it("leaves the inferred state untouched against a pre-B2 intel (no extraction field)", async () => {
    const r = receipt();
    const clock = fakeClock();
    const { fetchExtraction, calls } = scriptedFetch([null]);
    await pollReceiptsToTerminal(
      [r],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    // One probe, then it stops (no job state to read).
    expect(calls).toHaveLength(1);
    expect(r.extraction).toBeUndefined();
  });

  it("does not throw and stops polling on a transient read failure (ingest already committed)", async () => {
    const r = receipt();
    const clock = fakeClock();
    const fetchExtraction: ExtractionPollDeps["fetchExtraction"] = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(
      pollReceiptsToTerminal(
        [r],
        { ...FAST_OPTS, queue: false },
        { fetchExtraction, sleep: clock.sleep, now: clock.now },
      ),
    ).resolves.toBeUndefined();
    expect(r.extraction).toBeUndefined();
  });
});

describe("B3 pollReceiptsToTerminal: multi-receipt budget", () => {
  it("polls each eligible receipt and skips ineligible ones in one pass", async () => {
    const a = receipt({ documentId: "doc_a" });
    const b = receipt({ documentId: "doc_b", mode: "corpus" });
    const c = receipt({ documentId: "doc_c", outcome: "ingested" });
    const clock = fakeClock();
    const seen: string[] = [];
    const fetchExtraction: ExtractionPollDeps["fetchExtraction"] = async (id) => {
      seen.push(id);
      return { state: "completed", candidateCount: 1 };
    };
    await pollReceiptsToTerminal(
      [a, b, c],
      { ...FAST_OPTS, queue: false },
      { fetchExtraction, sleep: clock.sleep, now: clock.now },
    );
    // doc_a + doc_c eligible (file + body-changing); doc_b (corpus) skipped.
    expect(seen.sort()).toEqual(["doc_a", "doc_c"]);
    expect(a.extraction?.state).toBe("completed");
    expect(c.extraction?.state).toBe("completed");
    expect(b.extraction).toBeUndefined();
  });
});
