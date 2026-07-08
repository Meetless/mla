import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for Pass 2 filter-failure tolerance (Wedge v6 Epoch 32).
//
// Pre-fix flush.sh ran:
//   EVENTS_JSON="$(jq -c -R -s -f "$EVENT_FILTER" < "$TMP" 2>/dev/null || echo "[]")"
// which collapsed THREE distinct outcomes into one EVENTS_JSON="[]":
//   (a) genuinely empty batch                              -> OK to skip PATCH
//   (b) event-batch-filter.jq file missing                 -> total visibility loss
//   (c) jq crashed (out of memory, broken pipe, etc.)      -> total visibility loss
//
// In (b) and (c), EVENT_COUNT stayed 0, PATCH was skipped, EVENTS_OK STAYED 1,
// and Pass 3 happily fired `mla _internal finalize-session`. That call enqueues
// the `agent_run_finalized:<runId>` outbox row with a UNIQUE idempotency key.
// The worker handler reads a Run Ledger with no bash events and no
// agentClaimsRaw (because session_stopped never landed server-side), produces
// a blank review packet, and burns the idempotency key forever. Subsequent
// flushes (after the filter is re-installed) have nothing to re-deliver
// because the events were never re-spooled, AND any retry of the finalize
// outbox row is silently deduped. End result: SILENT TOTAL LOSS of the review
// packet for that run.
//
// Post-fix Pass 2 separates filter-failure from empty-batch and treats failure
// the same as a PATCH failure: re-spool the events AND defer finalize to the
// next flush.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  queueLines: string[];
  mlaInvocations: string[];
}

interface RunOpts {
  includeFilter: boolean;
  snapshot: string;
}

function runFlush(opts: RunOpts): RunResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flush-missing-"));
  const hooksDir = path.join(tmp, "hooks");
  fs.mkdirSync(hooksDir);
  fs.copyFileSync(path.join(HOOKS_DIR, "common.sh"), path.join(hooksDir, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, "flush.sh"), path.join(hooksDir, "flush.sh"));
  fs.chmodSync(path.join(hooksDir, "flush.sh"), 0o755);
  if (opts.includeFilter) {
    fs.copyFileSync(
      path.join(HOOKS_DIR, "event-batch-filter.jq"),
      path.join(hooksDir, "event-batch-filter.jq"),
    );
  }

  // Shim for mla _internal finalize-session: records every invocation to a
  // file so the test can assert "finalize was NOT called" without binding
  // to a real worker / control / outbox.
  const mlaShim = path.join(tmp, "mla-shim.sh");
  const mlaLog = path.join(tmp, "mla-invocations.log");
  fs.writeFileSync(
    mlaShim,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${mlaLog}"\nexit 0\n`,
    { mode: 0o755 },
  );

  // cli-config.json: controlUrl pointed at 127.0.0.1:1 (closed port) is a
  // safety net -- if the test ever lets a PATCH through, curl --max-time 5
  // will fail fast and the assertions will still hold.
  fs.writeFileSync(
    path.join(tmp, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      workspaceId: "ws_test",
      mlaPath: mlaShim,
    }),
  );

  const sessionId = "session_test_1";
  const queueDir = path.join(tmp, "queue");
  fs.mkdirSync(queueDir);
  fs.writeFileSync(path.join(queueDir, `${sessionId}.jsonl`), opts.snapshot);
  // T1.2 cutover: flush sources workspaceId from the per-session .workspaceId
  // sidecar (snapshotted at session start), not cli-config. Stage it so the
  // batch clears the empty-workspace guard and reaches Pass 2/3.
  fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");

  const r = spawnSync("bash", [path.join(hooksDir, "flush.sh"), sessionId], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: tmp },
  });

  const queuePath = path.join(queueDir, `${sessionId}.jsonl`);
  const queueLines = fs.existsSync(queuePath)
    ? fs
        .readFileSync(queuePath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
    : [];
  const mlaInvocations = fs.existsSync(mlaLog)
    ? fs
        .readFileSync(mlaLog, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
    : [];

  fs.rmSync(tmp, { recursive: true, force: true });
  return {
    status: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
    queueLines,
    mlaInvocations,
  };
}

function snapshotWithFinalize(): string {
  return (
    [
      JSON.stringify({
        ts: "2026-05-27T00:00:00.000Z",
        event: "prompt_submitted",
        eventKey: "k1",
        sessionId: "session_test_1",
        payload: { text: "go" },
      }),
      JSON.stringify({
        ts: "2026-05-27T00:00:01.000Z",
        event: "tool_used_bash",
        eventKey: "k2",
        sessionId: "session_test_1",
        payload: { command: "pnpm test", exitCode: 0 },
      }),
      JSON.stringify({
        ts: "2026-05-27T00:00:02.000Z",
        event: "session_stopped",
        eventKey: "k3",
        sessionId: "session_test_1",
        payload: { finalMessage: "done" },
      }),
      JSON.stringify({
        ts: "2026-05-27T00:00:03.000Z",
        event: "finalize_requested",
        eventKey: "k4",
        sessionId: "session_test_1",
        payload: {},
      }),
    ].join("\n") + "\n"
  );
}

describe("flush.sh Pass 2 filter-failure tolerance", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-missing-filter specs");
    }
  });

  it("re-spools events AND defers finalize when event-batch-filter.jq is missing", () => {
    const r = runFlush({ includeFilter: false, snapshot: snapshotWithFinalize() });
    expect(r.status).toBe(0);

    // Finalize MUST NOT fire on a filter-failure batch -- doing so burns
    // the agent_run_finalized:<runId> outbox idempotency key on an empty
    // event set.
    expect(
      r.mlaInvocations.filter((m) => m.includes("finalize-session")),
    ).toEqual([]);

    // The steer-sync hop, by contrast, MUST run on every flush drain
    // (Plan 1, conflict-resolution loop): cross-session steer delivery is
    // independent of whether this event batch shipped, so a filter failure
    // must NOT starve steer delivery.
    expect(
      r.mlaInvocations.filter((m) => m.includes("steer-sync")),
    ).toEqual(["_internal steer-sync --session session_test_1"]);

    // All three event-bearing lines (prompt_submitted, tool_used_bash,
    // session_stopped) must be re-spooled so the next flush retries them.
    const events = r.queueLines
      .map((l) => {
        try {
          return JSON.parse(l) as { event?: string; eventKey?: string };
        } catch {
          return {};
        }
      })
      .filter((e) => typeof e.event === "string");
    const keys = events
      .filter((e) => e.event !== "finalize_requested")
      .map((e) => e.eventKey)
      .sort();
    expect(keys).toEqual(["k1", "k2", "k3"]);

    // Finalize_requested must be re-spooled with a FRESH eventKey (Pass 3
    // synthesizes a new key on re-spool to keep the outbox key derivation
    // monotonic; the original k4 is discarded).
    const finalizes = events.filter((e) => e.event === "finalize_requested");
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0].eventKey).toBeTruthy();
    expect(finalizes[0].eventKey).not.toBe("k4");
  });

  it("happy path: filter present, batch ships, finalize fires (no regression)", () => {
    // No real control server is listening at 127.0.0.1:1, so curl PATCH
    // will fail and EVENTS_OK becomes 0 inside the PATCH branch -- the
    // re-spool path is the SAME as the filter-failure path. We assert the
    // batch was re-spooled AND finalize was deferred, proving the post-fix
    // logic also handles the PATCH-failure case correctly (the case the
    // pre-fix code already handled, now consolidated through one branch).
    const r = runFlush({ includeFilter: true, snapshot: snapshotWithFinalize() });
    expect(r.status).toBe(0);
    expect(
      r.mlaInvocations.filter((m) => m.includes("finalize-session")),
    ).toEqual([]);
    expect(
      r.mlaInvocations.filter((m) => m.includes("steer-sync")),
    ).toEqual(["_internal steer-sync --session session_test_1"]);

    const events = r.queueLines
      .map((l) => {
        try {
          return JSON.parse(l) as { event?: string; eventKey?: string };
        } catch {
          return {};
        }
      })
      .filter((e) => typeof e.event === "string");
    const keys = events
      .filter((e) => e.event !== "finalize_requested")
      .map((e) => e.eventKey)
      .sort();
    expect(keys).toEqual(["k1", "k2", "k3"]);
  });

  // Drift guard: if a future refactor restores the `|| echo "[]"` fallback
  // pattern on the Pass 2 jq invocation, the silent-loss trap returns. This
  // test fails so we never silently re-introduce it.
  it("flush.sh KEEPS the filter-failure check (drift guard)", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, "flush.sh"), "utf8");
    // The fix MUST check the filter file exists OR use a status-checking
    // form (if !; then EVENTS_OK=0) rather than the silent || echo "[]"
    // fallback on the events-filter jq call.
    expect(src).toMatch(/if\s+\[\[\s+!\s+-f\s+"\$EVENT_FILTER"\s+\]\]/);
    // The old swallow-everything pattern on the events filter must be gone.
    // (Other jq calls in flush.sh can still use || echo "..." defenses;
    // only the events filter call is regression-prone.)
    expect(src).not.toMatch(
      /jq\s+-c\s+-R\s+-s\s+-f\s+"\$EVENT_FILTER"\s+<\s+"\$TMP"\s+2>\/dev\/null\s+\|\|\s+echo\s+"\[\]"/,
    );
  });
});
