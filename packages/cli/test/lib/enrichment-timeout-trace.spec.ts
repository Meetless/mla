import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { createServer, Server } from "http";
import type { AddressInfo } from "net";

// What a timeout actually records, pinned against the real hook.
//
// The 2026-08-06 fix proposal made this its defect 3: "Two turns ended
// enrichment.status timeout with latency_ms null and governed_kb_trace {}. Not a partial
// trace. Empty. So for 2 of 7 turns there is no record of which surface was slow, how long
// it ran, or how close it came." It proposed writing the trace incrementally, stamping
// surfaces_attempted before the first surface call and emitting the accumulation plus
// `timed_out_during: <surface>` on the timeout path.
//
// Two thirds of that is false, and the remaining third cannot be implemented where it was
// aimed. The live rows for the audited session say so:
//
//   ts                    status   enrichment.latency_ms  hook.enrich_latency_ms  budget_ms
//   2026-07-31T21:05:43Z  timeout  null                   6017                    6000
//   2026-08-04T03:37:40Z  timeout  null                   6015                    6000
//
// 1. `governed_kb_trace` is `null`, not `{}`. Null is the correct typed representation of
//    "no trace exists", and the hook writes it deliberately so a prior call's value cannot
//    leak into this turn's line.
// 2. "no record of how long it ran" is wrong. hook.enrich_latency_ms carries the elapsed
//    milliseconds to sub-percent precision, and hook.budget_ms carries the cap it ran
//    into, which is what lets a reader see the sample is RIGHT-CENSORED rather than
//    mistaking 6017ms for how long the work needed.
// 3. "which surface was slow" is the one genuinely missing fact, and it is missing
//    structurally. The timeout is enforced by curl's own `--max-time` inside this hook
//    (user-prompt-submit.sh, the enrich call). curl aborts before any response body
//    exists, so the hook never receives a surface list; the surfaces are attempted inside
//    intel, in a different process, whose reply never arrives. There is nothing
//    accumulated locally to emit, and no amount of incremental writing on this side can
//    invent it. Reporting it needs a server-side deadline shorter than the client's, so
//    intel can answer with a partial trace instead of not answering.
//
// So this suite pins the contract instead of "fixing" it, because the next reader of these
// rows will otherwise re-derive the same wrong conclusion for a third time.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_timeout";
const BUDGET_S = 2;

/** A server that accepts the connection and never answers: a real read timeout. */
function hangingServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer(() => {
      /* deliberately never responds */
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

type Row = {
  enrichment: { status: string; latency_ms: number | null };
  governed_kb_trace: unknown;
  hook: { enrich_latency_ms: number; budget_ms: number; fail_open_reason: string | null; injected: boolean };
  arbitration: { reason: string };
};

async function runTimedOutHook(): Promise<Row> {
  const server = await hangingServer();
  try {
    const home = mkdtempSync(join(tmpdir(), "mla-timeout-home-"));
    const repo = mkdtempSync(join(tmpdir(), "mla-timeout-repo-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      // `controlToken` is a DERIVED projection that readConfig() computes from
      // auth.accessToken; there is no top-level token on disk. Hand-building the config
      // without a live-shaped `auth` block makes the hook short-circuit on `missing_token`
      // and never reach the network, which looks exactly like a passing timeout test that
      // never timed out.
      JSON.stringify({
        workspaceId: WORKSPACE_ID,
        actorUserId: "user_a",
        intelUrl: server.url,
        auth: {
          mode: "user-token",
          accessToken: "probe-access-token",
          refreshToken: "probe-refresh-token",
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        },
      }),
    );

    spawnSync("bash", [HOOK], {
      input: JSON.stringify({
        session_id: "timeout_probe",
        prompt: "what did we decide about the coordination case state machine",
        cwd: repo,
      }),
      encoding: "utf8",
      cwd: repo,
      env: {
        ...process.env,
        MEETLESS_HOME: home,
        HOME: home,
        MEETLESS_INTEL_URL: server.url,
        MEETLESS_INTERCEPT_MAX_S: String(BUDGET_S),
      },
      timeout: 30000,
    });

    return readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .pop() as Row;
  } finally {
    server.close();
  }
}

describe("what a timeout records", () => {
  let row: Row;

  beforeAll(async () => {
    row = await runTimedOutHook();
  }, 60000);

  it("reaches the timeout path at all, so the rest of this suite is not vacuous", () => {
    expect(row.enrichment.status).toBe("timeout");
    expect(row.hook.fail_open_reason).toBe("timeout");
  });

  it("records the elapsed time, contradicting `no record of how long it ran`", () => {
    expect(typeof row.hook.enrich_latency_ms).toBe("number");
    expect(row.hook.enrich_latency_ms).toBeGreaterThanOrEqual(BUDGET_S * 1000);
  });

  it("records the cap, so the latency is visibly right-censored", () => {
    // Without the budget beside it, 6017ms reads as "the work took 6 seconds". It does not;
    // it means we stopped waiting at 6. Any budget tuning that forgets this is measuring a
    // distribution that its own cap produced.
    expect(row.hook.budget_ms).toBe(BUDGET_S * 1000);
    expect(row.hook.enrich_latency_ms).toBeGreaterThanOrEqual(row.hook.budget_ms);
  });

  it("writes governed_kb_trace as null, not an empty object", () => {
    // The distinction matters for the analyzer: null is "no trace exists, and could not",
    // whereas {} would suggest a trace was produced and came back blank. curl aborted
    // before any body existed, so null is the only honest value.
    expect(row.governed_kb_trace).toBeNull();
    expect(row.governed_kb_trace).not.toEqual({});
  });

  it("still injects Layer 1, because a timeout must fail open", () => {
    expect(row.hook.injected).toBe(true);
    expect(row.arbitration.reason).toBe("enrichment_timeout");
  });
});
