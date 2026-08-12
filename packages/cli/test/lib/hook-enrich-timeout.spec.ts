import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

// WHAT A TIMED-OUT ENRICH IS ALLOWED TO SAY.
//
// Turn 4 of session 5734f9de recorded `status: timeout` and nothing else. From the
// log you could not tell whether the budget was 6s or 600ms, whether it died
// connecting or waiting on a slow retrieval, how long it actually took, or whether
// anything had been retrieved before the cut. "Timeout" alone is not a diagnosis;
// it is the absence of one, and it is why the proposal could only say "raise it or
// do not" rather than "here is where it went".
//
// THE BUDGET IS 10 SECONDS AS OF 2026-08-09, RAISED FROM 6. It was 6s and this file
// used to say it stayed there. Measured on the operator's own ask-traces.jsonl that
// day: 377 of 4,701 traced enrich turns ended `timeout`, and of the 298 carrying a
// latency (the field landed 2026-06-03; the other 79 predate it), 270 land in
// 6,000-6,100ms. That is the CLIENT deadline firing, every time, not a hung backend.
// The successful tail runs right up to the wall (ok-only max 5,890ms, seven rows in
// 5,000-6,000, and ZERO above 6,000 because the deadline censors them), so nobody has
// ever seen what the cut costs. The distribution's own p95 of 6,017ms is an artifact
// of counting the timeouts in the sample, not evidence that the service is slow.
//
// Raising it is a MEASUREMENT, not a belief: `mla stats ask` now reports the
// recovery cohort (crossed 6,000ms, then finished / delivered / still died), and the
// pre-registered stop condition is in
// notes/20260809-mla-the-answer-existed-in-1086ms-and-the-budget-cut-it-at-6000.md.
// Revert to 6s if the recovered fraction is small.
//
// The rule for what gets recorded: ONLY what is already known at the moment of the
// cut. Specifically NOT "what would have been offered" -- learning that would mean
// letting the request finish out-of-band, which spends real compute on a turn that
// has already moved on and reports a result nobody can act on.
//
// WHAT IS CANCELLED IS OUR SIDE, AND ONLY OUR SIDE. This block used to claim "the
// remaining work is CANCELLED", full stop, and the tests below never checked the
// half that matters: curl's --max-time ends the CLIENT (one process, no detached
// continuation, no second request), and the SERVER never learns we left. Measured
// 2026-08-09 against uvicorn 0.40.0, the version the dogfood stack runs, with a
// handler that marks a file only if it reaches its own end: the client was cut at
// 1,002ms, the 4-second handler ran to completion, and the file said `completed`,
// not `cancelled`. `grep -rn "is_disconnected" intel/app/` returns nothing, so
// intel never checks either. Every timed-out enrich turn therefore paid full
// retrieval cost on the server and threw the answer away.
//
// That is the load-bearing fact behind G1c (retry once on timeout), and it is why
// G1c is HELD rather than shipped: an immediate retry would add a second full
// retrieval on top of a first that is still running, precisely during the window
// where the service is already too slow to answer.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const HOOK = "user-prompt-submit.sh";

function requireTools(...tools: string[]): void {
  for (const t of tools) {
    if (spawnSync(t, ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error(`${t} required`);
  }
}

interface Stub {
  port: number;
  requests: () => number;
  close: () => Promise<void>;
}

/** An intel that never answers, so the client-side budget is what ends the call. */
async function startHangingStub(): Promise<Stub & { healthProbes: () => number }> {
  const sockets = new Set<import("net").Socket>();
  let requests = 0;
  let healthProbes = 0;
  const server = http.createServer((req) => {
    // `requests` counts WORK requests only. The health path is counted separately
    // because the two are different claims: a second WORK request would be a retry
    // spending a second retrieval on an abandoned turn, which is the thing these
    // tests forbid; a health probe does no work, returns no evidence, and cannot
    // inject. Before 2026-08-10 one counter carried both, so the invariant read
    // "no second request of any kind" -- broader than what it protects, and it
    // would have forbidden the one call that distinguishes a slow service from a
    // service that was not running at all. See the D1 block at the end of this file.
    if ((req.url ?? "").includes("/health")) {
      healthProbes++;
      // Dark on every path, health included: a listening socket with no worker
      // behind it, which is what `uvicorn --reload` leaves for 36-40s per restart.
      return;
    }
    requests++;
    req.on("data", () => {});
    // Deliberately never respond and never end: only the hook's --max-time can
    // close this, which is exactly the condition under test.
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        healthProbes: () => healthProbes,
        requests: () => requests,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

interface Harness {
  tmp: string;
  home: string;
  workdir: string;
  hook: string;
}

function makeHarness(port: number): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-enrich-timeout-"));
  for (const f of ["common.sh", "home.sh", HOOK]) {
    fs.copyFileSync(path.join(HOOKS_DIR, f), path.join(tmp, f));
  }
  fs.chmodSync(path.join(tmp, HOOK), 0o755);
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, "queue"));
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl: `http://127.0.0.1:${port}`,
      controlToken: "ik-test",
      workspaceId: "ws_test",
      mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/usr/bin/true",
    }),
  );
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");
  return { tmp, home, workdir, hook: path.join(tmp, HOOK) };
}

async function fire(h: Harness, sid: string, env: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [h.hook], {
      cwd: h.workdir,
      env: { ...process.env, MEETLESS_HOME: h.home, MEETLESS_DEBUG: "0", ...env },
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", () => resolve());
    child.stdin.write(JSON.stringify({ session_id: sid, prompt: "Fix the enrichment router." }));
    child.stdin.end();
  });
}

function traces(h: Harness): Array<Record<string, any>> {
  const p = path.join(h.home, "logs", "ask-traces.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("a timed-out enrich records what it knew, and cancels the rest", () => {
  let stub: Stub & { healthProbes: () => number };
  let h: Harness;
  let row: Record<string, any>;

  beforeAll(async () => {
    requireTools("jq", "curl");
    stub = await startHangingStub();
    h = makeHarness(stub.port);
    // A 1s budget so the suite does not pay 6s; the FIELDS are what is under test,
    // and the budget being configurable is itself one of them.
    await fire(h, "sess-timeout", { MEETLESS_INTERCEPT_MAX_S: "1" });
    const rows = traces(h);
    expect(rows).toHaveLength(1);
    row = rows[0];
  }, 60000);

  afterAll(async () => {
    await stub.close();
    fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("still writes exactly one terminal row, and it is honest about the failure", () => {
    expect(row.enrichment.status).toBe("timeout");
    expect(row.arbitration.reason).toBe("enrichment_timeout");
    expect(row.hook.fail_open_reason).toBe("timeout");
    // The floor still injected: a timeout costs Layer 2, never Layer 1.
    expect(row.hook.injected).toBe(true);
    expect(row.hook.layer2_injected).toBe(false);
  });

  it("records the CONFIGURED budget, not a hardcoded one", () => {
    expect(row.hook.budget_ms).toBe(1000);
    expect(row.enrich_timeout.budget_ms).toBe(1000);
  });

  it("records the elapsed time, and it is consistent with the budget", () => {
    expect(row.enrich_timeout.elapsed_ms).toBeGreaterThanOrEqual(900);
    expect(row.enrich_timeout.elapsed_ms).toBeLessThan(6000);
    expect(row.hook.enrich_latency_ms).toBeGreaterThanOrEqual(900);
  });

  it("records the stage it died in", () => {
    // The stub ACCEPTS the connection and then hangs, so this is a response-stage
    // timeout, not a connect-stage one. Naming the stage is the difference between
    // "intel is unreachable" and "intel is slow", which have opposite fixes.
    expect(stub.requests()).toBe(1);
    expect(row.enrich_timeout.stage).toBe("response");
  });

  it("records the stage timings that DID complete before the call", () => {
    // Everything the hook did before dialing intel (touched-file scan, Layer 1
    // build, context assembly) is a completed stage with a real duration. Without
    // it a 6s budget and a 5.4s pre-flight are indistinguishable from a 6s server.
    expect(typeof row.enrich_timeout.pre_enrich_ms).toBe("number");
    expect(row.enrich_timeout.pre_enrich_ms).toBeGreaterThanOrEqual(0);
    expect(row.enrich_timeout.pre_enrich_ms).toBeLessThan(row.hook.intercept_latency_ms + 1);
  });

  it("records the candidate count ALREADY AVAILABLE, which on an aborted call is zero", () => {
    // Zero is recorded explicitly rather than omitted. "No candidates were in hand"
    // is a fact about this timeout; a missing field is a fact about the writer.
    expect(row.enrich_timeout.candidates_available).toBe(0);
    expect(row.enrich_timeout.bytes_received).toBe(0);
  });

  it("records the terminal status", () => {
    expect(row.enrich_timeout.status).toBe("timeout");
  });

  it("issues NO second request and no background finish on OUR side of the wire", async () => {
    // One request total, and it stays one after the hook exits. A client-side
    // finisher would show as a second request here (or as a mutated trace row) and
    // would be spending on a turn that already moved on.
    //
    // THE TITLE USED TO SAY "CANCELS THE REMAINING WORK" AND THAT WAS FALSE, in the
    // half it did not test. This assertion only ever covered the CLIENT. See
    // `the server keeps working after we hang up` below for what the other side does,
    // which is the opposite of what this file claimed for two months.
    const before = stub.requests();
    await new Promise((r) => setTimeout(r, 1200));
    expect(stub.requests()).toBe(before);
    expect(traces(h)).toHaveLength(1);
    expect(traces(h)[0].enrich_timeout.status).toBe("timeout");
    // The one call that IS made, pinned rather than hidden by the counter split.
    // Exactly one, to a path that does no work: if this ever grows a second, or
    // starts hitting the work path, the "no retry" claim above has quietly died.
    expect((stub as unknown as { healthProbes: () => number }).healthProbes()).toBe(1);
  }, 20000);

  it("emits NO enrich_timeout block on a turn that did not time out", async () => {
    // The block is a diagnosis of a specific failure. Emitting it always (nulled)
    // would put a timeout-shaped field on every healthy row.
    const ok = await startOkStub();
    const h2 = makeHarness(ok.port);
    try {
      await fire(h2, "sess-ok", {});
      const rows = traces(h2);
      expect(rows).toHaveLength(1);
      expect(rows[0].enrich_timeout).toBeNull();
    } finally {
      await ok.close();
      fs.rmSync(h2.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 30000);
});

async function startOkStub(): Promise<Stub> {
  const sockets = new Set<import("net").Socket>();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          enrichment: { status: "ok", confidence: "low", markdown: "", context_items: [] },
          steps: [],
        }),
      );
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests: () => requests,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * An intel that finishes its work `delayMs` after the request arrives and RECORDS
 * whether it got there, regardless of whether anyone was still listening.
 *
 * `completions()` is the whole instrument: it counts handlers that reached their own
 * end. A server that had been told to stop would never increment it.
 */
async function startWorkTrackingStub(delayMs: number): Promise<Stub & { completions: () => number; aborts: () => number; healthProbes: () => number }> {
  const sockets = new Set<import("net").Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let requests = 0;
  let healthProbes = 0;
  let completions = 0;
  let aborts = 0;
  const server = http.createServer((req, res) => {
    // WORK requests only; see the note in startHangingStub.
    if ((req.url ?? "").includes("/health")) {
      healthProbes++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    requests++;
    req.on("data", () => {});
    req.on("aborted", () => {
      aborts++;
    });
    req.on("end", () => {
      const t = setTimeout(() => {
        timers.delete(t);
        // Reached the end of the work. Whether the socket is still there is a
        // separate question and deliberately not consulted.
        completions++;
        try {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ enrichment: { status: "ok", confidence: "low", markdown: "", context_items: [] }, steps: [] }));
        } catch {
          // The peer is gone; the WORK still happened, which is the point.
        }
      }, delayMs);
      timers.add(t);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests: () => requests,
        healthProbes: () => healthProbes,
        completions: () => completions,
        aborts: () => aborts,
        close: () =>
          new Promise<void>((r) => {
            timers.forEach((t) => clearTimeout(t));
            timers.clear();
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

/** An intel that answers correctly, but only after `delayMs`. The wall is the subject. */
async function startSlowOkStub(delayMs: number): Promise<Stub> {
  const sockets = new Set<import("net").Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.on("data", () => {});
    req.on("end", () => {
      const t = setTimeout(() => {
        timers.delete(t);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            enrichment: {
              status: "ok",
              confidence: "high",
              markdown: "- [accepted][NT:notes/late.md] the answer that used to be cut",
              context_items: [{ kind: "kb_document", source_id: "NT:notes/late.md", text: "late but real" }],
            },
            steps: [],
          }),
        );
      }, delayMs);
      timers.add(t);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests: () => requests,
        close: () =>
          new Promise<void>((r) => {
            timers.forEach((t) => clearTimeout(t));
            timers.clear();
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

// G1b (2026-08-09). THE DEADLINE ITSELF, asserted through the hook rather than read
// off the script. Both tests below pay real wall-clock on purpose: the thing under
// test is a duration, and a static grep for `:-10` would pass against a hook that
// never applies it.
describe("the enrich deadline is 10 seconds by default, and it is what the trace reports", () => {
  it("delivers an answer that arrives AFTER the old 6s wall and before the new one", async () => {
    // THE WHOLE POINT OF G1b, and the only test here that would have caught the
    // defect. Under the old 6,000ms deadline this exact turn recorded
    // `status: timeout`, `layer2_injected: false`, and threw away evidence the
    // service had already produced. Turn 1 of session 2276951e was this shape: cut
    // at 6,016ms, replayed at 1,086ms with both citations in hand.
    requireTools("jq", "curl");
    const slow = await startSlowOkStub(7000);
    const h = makeHarness(slow.port);
    try {
      await fire(h, "sess-late-but-served", {});
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].enrichment.status).toBe("ok");
      // Empty is normalized to null on the way out; what matters is that nothing
      // reported a failure on a turn the service answered.
      expect(rows[0].hook.fail_open_reason ?? "").toBe("");
      expect(rows[0].hook.layer2_injected).toBe(true);
      expect(rows[0].enrich_timeout).toBeNull();
      // It really did cross the old wall; otherwise this passes for the wrong reason.
      expect(rows[0].hook.enrich_latency_ms).toBeGreaterThan(6000);
    } finally {
      await slow.close();
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60000);

  it("still cuts a genuinely hung intel, at 10s, and records 10,000 as the budget", async () => {
    // The deadline moved; it did not disappear. A hung service must still cost a
    // bounded turn, and the trace must report the budget that actually applied so a
    // later audit is not reading a number the hook stopped using.
    requireTools("jq", "curl");
    const hung = await startHangingStub();
    const h = makeHarness(hung.port);
    try {
      await fire(h, "sess-default-budget", {});
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].enrichment.status).toBe("timeout");
      expect(rows[0].hook.budget_ms).toBe(10000);
      expect(rows[0].enrich_timeout.budget_ms).toBe(10000);
      expect(rows[0].hook.enrich_latency_ms).toBeGreaterThanOrEqual(9800);
    } finally {
      await hung.close();
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60000);

  it("names the applied budget in the same-turn degraded notice, not a stale literal", async () => {
    // G1d. The notice is how the agent learns that governed evidence was UNAVAILABLE
    // rather than absent, and it quotes the budget so "the wall cut it" can be told
    // from "the service is broken". Hardcoding 6 there would have made it lie today.
    requireTools("jq", "curl");
    const hung = await startHangingStub();
    const h = makeHarness(hung.port);
    let ctx = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("bash", [h.hook], {
          cwd: h.workdir,
          env: { ...process.env, MEETLESS_HOME: h.home, MEETLESS_DEBUG: "0", MEETLESS_INTERCEPT_MAX_S: "2" },
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (d) => (ctx += d));
        child.stderr.on("data", () => {});
        child.on("error", reject);
        child.on("close", () => resolve());
        child.stdin.write(JSON.stringify({ session_id: "sess-deg", prompt: "Fix the enrichment router." }));
        child.stdin.end();
      });
      // Read the payload the agent actually receives, not the JSON envelope: an
      // assertion against the raw stdout matches the backslash-escaped spelling and
      // would pass even if the block never reached `additionalContext`.
      const injected = JSON.parse(ctx).hookSpecificOutput.additionalContext as string;
      expect(injected).toContain('kind="evidence-unavailable"');
      expect(injected).toMatch(/over the 2s budget/);
      // The distinguishing claim, and the reason the block exists at all: a healthy
      // turn that found nothing emits exactly what an outage emits, so the degraded
      // turn has to say which one this was.
      expect(injected).toMatch(/absence here is unknown, not settled/i);
    } finally {
      await hung.close();
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 40000);
});

// G1c (2026-08-09). THE PREMISE BEHIND HOLDING THE RETRY, pinned so it cannot rot
// into an assumption. The proposal offered "retry once, immediately, on a timeout"
// and priced it as "doubles the worst case to two budgets". That pricing is only
// right if the first attempt STOPS when we hang up. It does not.
describe("the server keeps working after we hang up, so a retry would be additive load", () => {
  it("completes its work even though the client abandoned the request", async () => {
    // Measured the same way against the real stack before this test was written:
    // uvicorn 0.40.0 (the dogfood version) ran a 4s handler to completion after curl
    // was cut at 1,002ms, and intel has no `is_disconnected` check anywhere. So the
    // cost of a timed-out enrich is paid IN FULL and the answer is discarded.
    //
    // What follows for G1c: an immediate retry does not cost two budgets, it costs
    // two CONCURRENT retrievals, and it adds the second one exactly when the service
    // is already too slow to finish the first. That is why the retry stays unbuilt
    // until the recovery cohort says whether the tail is variance or cost.
    requireTools("jq", "curl");
    const stub = await startWorkTrackingStub(2500);
    const h = makeHarness(stub.port);
    try {
      await fire(h, "sess-server-keeps-going", { MEETLESS_INTERCEPT_MAX_S: "1" });

      // The hook gave up and said so.
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].enrichment.status).toBe("timeout");
      // At the moment of the cut the server had NOT finished. Without this leg the
      // assertion below could pass on a server that answered in time.
      expect(stub.completions()).toBe(0);

      // Well past the handler's own duration, with nobody listening.
      await new Promise((r) => setTimeout(r, 3000));
      expect(stub.completions()).toBe(1);
      // And it was one request, not two: the hook did not retry. Both halves matter.
      expect(stub.requests()).toBe(1);
    } finally {
      await stub.close();
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60000);
});

describe("connect-stage timeout is distinguished from response-stage", () => {
  it("labels an unreachable intel `connect`, not `response`", async () => {
    // The two need opposite fixes ("intel is down" vs "intel is slow"), and the
    // first version of this discriminator inferred the stage from elapsed time and
    // got it backwards whenever the budget and the connect timeout were close.
    requireTools("jq", "curl");
    // A port nothing listens on, plus a non-routable dial so the connect itself
    // is what expires rather than being refused instantly.
    const h = makeHarness(9);
    fs.writeFileSync(
      path.join(h.home, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: "http://10.255.255.1:8100",
        controlToken: "ik-test",
        workspaceId: "ws_test",
        mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/usr/bin/true",
      }),
    );
    try {
      await fire(h, "sess-connect", { MEETLESS_INTERCEPT_MAX_S: "2", MEETLESS_INTEL_CONNECT_TIMEOUT_S: "1" });
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      // A connect that never completes surfaces as rc 28 with a connect-stage
      // message; a refused one surfaces as rc 7 and is not a timeout at all.
      if (rows[0].enrich_timeout) {
        expect(rows[0].enrich_timeout.stage).toBe("connect");
        expect(rows[0].enrich_timeout.candidates_available).toBe(0);
      } else {
        // Connection refused rather than timed out: still no timeout block, and the
        // failure is recorded as an error rather than mislabelled as a timeout.
        expect(rows[0].hook.fail_open_reason).toBe("intel_down");
      }
    } finally {
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 40000);
});

// ---------------------------------------------------------------------------
// D1: A RESPONSE-STAGE TIMEOUT CANNOT TELL "SLOW" FROM "NOT RUNNING", AND THAT
// AMBIGUITY HAS NOW COST TWO WORKSTREAMS.
//
// Every one of the 57 recorded `enrich_timeout` objects on this machine reads
// `stage: response`, `bytes_received: 0`, `connect` fine. That was read as "intel is
// slow", twice: once to propose a retry (F1, refused), once to hunt a compute
// bottleneck (this workstream). Measured on 2026-08-10, it is neither.
//
// WHAT IT ACTUALLY IS, measured live against the dogfood stack rather than inferred.
// intel's dev instance runs `uvicorn --reload` (Makefile:58) with `--workers 1`. One
// `touch` of an intel source file was followed by health probes every 250ms:
//
//     t=1.35s   touch app/server.py
//     t=4.90s   http 000, connect 0.40ms, 0 bytes   <- dark
//     ...       36 seconds of exactly that ...
//     t=40.93s  http 000, connect 0.29ms, 0 bytes
//     t=41.37s  http 200 in 181ms                   <- worker back
//
// The reloader parent keeps the listening socket, so `connect()` succeeds in ~0.3ms
// throughout while nothing serves. That is byte-for-byte the shape of all 57
// timeouts, and the dark window is 36-40s against a 6-10s budget, so every request
// arriving inside it times out with certainty and every concurrent session times out
// together (measured: 5 timeouts inside 38s across 2 sessions on 08-08).
//
// AND THE COMPUTE STORY DOES NOT HOLD. Of 240 August enrich turns that RETURNED, the
// server-side maximum is 7,538ms and ZERO exceed 8s. The timeouts are not the tail of
// that distribution; they are a disjoint population with no server behind them.
//
// SO THE DEFECT IS IN THE INSTRUMENT, not in retrieval. `stage: response` already
// separates "never reached it" from "reached it"; nothing separates "reached a
// service that was thinking" from "reached a socket with no worker behind it", and
// those have opposite fixes. One probe of an endpoint that does no work answers it.
//
// NOT A RETRY, and the distinction is the reason this is allowed to exist at all: it
// re-requests nothing, can return no evidence, cannot inject, and cannot change the
// turn's outcome. The turn has already failed and already spent its budget. This only
// decides which of two sentences the trace gets to say about why.
describe("a response-stage timeout says whether anything was serving", () => {
  it("reports the service as LIVE when it was up and merely too slow", async () => {
    // The genuine-latency shape: /v1/ask hangs past the budget, /health answers at
    // once. This is the case where "intel is slow" is the true reading, and where a
    // retrieval or budget change would be the right conversation to have.
    const stub = await startSlowAskHealthyStub();
    const h = makeHarness(stub.port);
    try {
      await fire(h, "sess-live", { MEETLESS_INTERCEPT_MAX_S: "1" });
      const row = traces(h)[0];
      expect(row.enrich_timeout.stage).toBe("response");
      expect(row.enrich_timeout.service_live_after_cut).toBe(true);
      expect(typeof row.enrich_timeout.service_probe_ms).toBe("number");
    } finally {
      await stub.close();
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 40000);

  it("reports the service as NOT live when the socket answers and no worker does", async () => {
    // The `--reload` shape, reproduced: connections are accepted (the listener is
    // real) and nothing is served on ANY path, health included. Under the shipped
    // code this row is indistinguishable from the one above.
    const stub = await startHangingStub();
    const h = makeHarness(stub.port);
    try {
      await fire(h, "sess-dark", { MEETLESS_INTERCEPT_MAX_S: "1" });
      const row = traces(h)[0];
      expect(row.enrich_timeout.stage).toBe("response");
      expect(row.enrich_timeout.service_live_after_cut).toBe(false);
    } finally {
      await stub.close();
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 40000);

  it("costs the turn a bounded amount and never a second budget", async () => {
    // The probe rides a turn that has already blown its deadline, so its own budget
    // has to be small and hard. A dark service makes the probe pay its full timeout,
    // which is the worst case and the one measured here.
    const stub = await startHangingStub();
    const h = makeHarness(stub.port);
    try {
      await fire(h, "sess-bounded", { MEETLESS_INTERCEPT_MAX_S: "1" });
      const row = traces(h)[0];
      expect(row.enrich_timeout.service_probe_ms).toBeLessThan(2500);
      // The enrich measurement itself must not absorb the probe: `elapsed_ms` is the
      // enrich round trip and nothing else, or every timeout's latency starts lying
      // by the width of its own diagnosis.
      expect(row.enrich_timeout.elapsed_ms).toBeLessThan(2500);
    } finally {
      await stub.close();
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 40000);

  it("does not probe on a CONNECT-stage timeout, where the answer is already known", async () => {
    // Nothing was reached, so "was it serving" is already answered and a probe would
    // be a second unanswerable call on a turn that has none to spare. UNKNOWN is
    // written as null, never as false: absent-because-unasked is not absent-because-down.
    const h = makeHarness(1);
    fs.writeFileSync(
      path.join(h.home, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: "http://10.255.255.1:8100",
        controlToken: "ik-test",
        workspaceId: "ws_test",
        mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/usr/bin/true",
      }),
    );
    try {
      await fire(h, "sess-connect-noprobe", {
        MEETLESS_INTERCEPT_MAX_S: "2",
        MEETLESS_INTEL_CONNECT_TIMEOUT_S: "1",
      });
      const row = traces(h)[0];
      if (row.enrich_timeout && row.enrich_timeout.stage === "connect") {
        expect(row.enrich_timeout.service_live_after_cut).toBeNull();
        expect(row.enrich_timeout.service_probe_ms).toBeNull();
      }
    } finally {
      fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 40000);
});

/**
 * An intel whose WORK path hangs while its HEALTH path answers instantly: a process
 * that is up, serving, and simply slower than the caller's deadline.
 *
 * This is the discriminator's whole point. `startHangingStub` above hangs on every
 * path and models a socket with no worker behind it; this one models a worker that
 * is thinking. The shipped trace records the two identically.
 */
async function startSlowAskHealthyStub(): Promise<Stub> {
  const sockets = new Set<import("net").Socket>();
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    if ((req.url ?? "").includes("/health")) {
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
      return;
    }
    requests++;
    // The enrich path never answers: the hook's own budget ends it.
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests: () => requests,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}
