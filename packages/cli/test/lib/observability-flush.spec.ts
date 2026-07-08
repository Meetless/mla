// P1.T5 acceptance: boundedTraceFlush prints exactly ONE stderr line on flush
// failure, never retries, and never throws. (notes/20260530-mla-observability-
// diagnostic-spine.md §6.2 + §10.P1 must-test 5.)
//
// Also covers makeHttpFlush body shape: workspaceId is injected from the CLI's
// run-local workspace config, X-Trace-ID stamped, bearer set. This is the
// receiving-end contract control's AgentTracesService validates against.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  boundedTraceFlush,
  makeHttpFlush,
  didTraceFlushSucceed,
  resetTraceFlushOutcomeForTesting,
  setWorkspaceConfig,
  TRACE_FLUSH_CEILING_MS,
  HTTP_FLUSH_TIMEOUT_MS,
} from "../../src/lib/observability";
import {
  FAILURE_TELEMETRY_UPLOAD_FAILED,
  deadletterPath,
  loadDeadletter,
} from "../../src/lib/failure-telemetry";
import type { Tracer } from "@meetless/trace-core";

function stubTracer(flushImpl: () => Promise<void>): Tracer {
  return {
    traceId: "a".repeat(32),
    root: { spanId: "root", parentSpanId: null } as any,
    startSpan: jest.fn() as any,
    endRoot: jest.fn(),
    snapshot: jest.fn(),
    flush: flushImpl,
  } as unknown as Tracer;
}

describe("boundedTraceFlush failure path (P1.T5)", () => {
  let writeSpy: jest.SpyInstance;
  let stderrBuf: string;

  beforeEach(() => {
    stderrBuf = "";
    writeSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: any) => {
        stderrBuf += String(chunk);
        return true;
      });
    resetTraceFlushOutcomeForTesting();
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("prints exactly ONE stderr line matching `warn: trace upload failed` when flush rejects", async () => {
    const tracer = stubTracer(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:3006");
    });

    await boundedTraceFlush(tracer);

    const matches = stderrBuf.match(/warn: trace upload failed/g) ?? [];
    expect(matches).toHaveLength(1);
    // Exit-path contract: the helper itself MUST NOT throw so it cannot
    // promote a successful command into a failed exit (§6.2).
    expect(didTraceFlushSucceed()).toBe(false);
  });

  it("prints the warning with `timeout` annotation when flush never resolves (exceeds the ceiling)", async () => {
    const tracer = stubTracer(
      () => new Promise<void>(() => undefined), // never resolves
    );

    // Drive with an explicit small ceiling so the test is fast and does not wait
    // out the (wider) default; the timeout path is what is under test, not the
    // exact duration.
    await boundedTraceFlush(tracer, 50);

    expect(stderrBuf).toMatch(/warn: trace upload failed/);
    expect(stderrBuf).toMatch(/timeout/);
    expect(didTraceFlushSucceed()).toBe(false);
  });

  // Finding #2 regression lock (the literal root cause). The outer ceiling that
  // boundedTraceFlush races tracer.flush() against was hardcoded to 500ms while
  // the HTTP flush (makeHttpFlush) allowed 1500ms. So a slow-but-successful
  // upload taking 500-1500ms succeeded at the transport layer but was killed by
  // the outer race, dropped, and reported as a false "timeout". The outer
  // ceiling MUST stay >= the inner HTTP deadline so the HTTP AbortController is
  // the authoritative timeout and the outer race is only a backstop for a flush
  // that hangs WITHOUT honoring its own deadline.
  it("keeps the outer flush ceiling no tighter than the HTTP per-request timeout (Finding #2)", () => {
    expect(TRACE_FLUSH_CEILING_MS).toBeGreaterThanOrEqual(HTTP_FLUSH_TIMEOUT_MS);
  });

  it("honors the supplied ceiling: a flush slower than the ceiling times out (Finding #2)", async () => {
    // Under the old code the ceiling was hardcoded at 500ms and the second arg
    // was ignored, so a 120ms flush was (wrongly) treated as a success. With a
    // tunable ceiling, a flush slower than the supplied ceiling must time out.
    const tracer = stubTracer(
      () => new Promise<void>((resolve) => setTimeout(resolve, 120)),
    );

    await boundedTraceFlush(tracer, 40);

    expect(stderrBuf).toMatch(/timeout/);
    expect(didTraceFlushSucceed()).toBe(false);
  });

  it("does NOT drop a slow-but-successful flush that resolves within the ceiling (Finding #2)", async () => {
    // The bug it prevents: a flush that takes longer than the OLD 500ms bound but
    // finishes within budget must be recorded as a success with no warning.
    const tracer = stubTracer(
      () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
    );

    await boundedTraceFlush(tracer, 400);

    expect(stderrBuf).toBe("");
    expect(didTraceFlushSucceed()).toBe(true);
  });

  it("prints NO stderr line and marks success when flush resolves cleanly", async () => {
    const tracer = stubTracer(async () => undefined);

    await boundedTraceFlush(tracer);

    expect(stderrBuf).toBe("");
    expect(didTraceFlushSucceed()).toBe(true);
  });

  it("does not throw even when the underlying flush throws synchronously", async () => {
    // tracer.flush() is async per the Tracer interface, but a synchronous
    // throw inside the function body is still possible. boundedTraceFlush
    // must absorb it the same way it absorbs an awaited rejection.
    const tracer = stubTracer(((): Promise<void> => {
      throw new Error("sync boom");
    }) as any);

    await expect(boundedTraceFlush(tracer)).resolves.toBeUndefined();
    expect(stderrBuf).toMatch(/warn: trace upload failed/);
  });

  // §9 tenant tracing guardrail interplay. When the active workspace is not
  // tracing-enabled (the common case once `mla workspace use <id>` switches to
  // any workspace that is not ws_an_local or a tracingDogfood workspace),
  // control answers the relay with 403 TRACING_NOT_ENABLED_FOR_WORKSPACE. That
  // is a deliberate POLICY refusal, not a failure: there is nothing wrong, the
  // tenant simply does not relay CLI self-traces. Nagging the user with
  // "warn: trace upload failed (HTTP 403)" on every single command under such a
  // workspace is alarming and wrong. boundedTraceFlush must treat that one code
  // as a silent skip while still warning loudly on every real failure (auth,
  // 5xx, connection refused, timeout).
  it("stays SILENT (no warning) when the relay is refused by the §9 tracing policy", async () => {
    const tracer = stubTracer(async () => {
      const e = new Error(
        "POST http://127.0.0.1:3006/internal/v1/agent-traces/ingest -> HTTP 403: " +
          '{"code":"TRACING_NOT_ENABLED_FOR_WORKSPACE"}',
      ) as Error & { status?: number; tracingDisabledByPolicy?: boolean };
      e.status = 403;
      e.tracingDisabledByPolicy = true;
      throw e;
    });

    await boundedTraceFlush(tracer);

    expect(stderrBuf).toBe("");
    // The trace was still not relayed, so there is no URL to advertise: the
    // success flag (which cli.ts uses to gate trace links) stays false.
    expect(didTraceFlushSucceed()).toBe(false);
  });

  it("recognizes the policy refusal by body code even when the flag is absent", async () => {
    // Defense in depth: if the tag is ever dropped, the message-borne code
    // still classifies the 403 as a policy skip.
    const tracer = stubTracer(async () => {
      const e = new Error(
        "POST .../agent-traces/ingest -> HTTP 403: " +
          '{"code":"TRACING_NOT_ENABLED_FOR_WORKSPACE"}',
      ) as Error & { status?: number };
      e.status = 403;
      throw e;
    });

    await boundedTraceFlush(tracer);

    expect(stderrBuf).toBe("");
  });

  it("STILL warns on a non-policy 403 (e.g. auth/token), not all 403s", async () => {
    const tracer = stubTracer(async () => {
      const e = new Error(
        "POST .../agent-traces/ingest -> HTTP 403: " +
          '{"code":"FORBIDDEN","message":"Token not authorized for this workspace"}',
      ) as Error & { status?: number };
      e.status = 403;
      throw e;
    });

    await boundedTraceFlush(tracer);

    const matches = stderrBuf.match(/warn: trace upload failed/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(didTraceFlushSucceed()).toBe(false);
  });
});

// F8 (telemetry-upload-failed) wiring. On a real, non-policy flush failure
// boundedTraceFlush must record the failure to the local deadletter (so a
// silently-broken transport still leaves a trace), join-keyed by trace_id and
// workspace. A §9 policy refusal is NOT a failure and must write nothing.
describe("boundedTraceFlush F8 deadletter wiring", () => {
  let writeSpy: jest.SpyInstance;
  let homeDir: string;
  const savedHome = process.env.MEETLESS_HOME;
  const savedTelemetry = process.env.MEETLESS_TELEMETRY;
  const savedNoTelemetry = process.env.MEETLESS_NO_TELEMETRY;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flush-f8-"));
    process.env.MEETLESS_HOME = homeDir;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    writeSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    resetTraceFlushOutcomeForTesting();
    setWorkspaceConfig({ workspaceId: "ws_an_local" });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    setWorkspaceConfig(null);
    if (savedHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = savedHome;
    if (savedTelemetry === undefined) delete process.env.MEETLESS_TELEMETRY;
    else process.env.MEETLESS_TELEMETRY = savedTelemetry;
    if (savedNoTelemetry === undefined) delete process.env.MEETLESS_NO_TELEMETRY;
    else process.env.MEETLESS_NO_TELEMETRY = savedNoTelemetry;
  });

  it("writes an F8 deadletter record on a real (non-policy) flush failure", async () => {
    const tracer = stubTracer(async () => {
      const e = new Error("POST .../agent-traces/ingest -> HTTP 500: {}") as Error & {
        status?: number;
      };
      e.status = 500;
      throw e;
    });

    await boundedTraceFlush(tracer);

    const records = loadDeadletter();
    expect(records).toHaveLength(1);
    expect(records[0].failure_class).toBe(FAILURE_TELEMETRY_UPLOAD_FAILED);
    expect(records[0].event.trace_id).toBe("a".repeat(32));
    expect(records[0].event.workspace_id).toBe("ws_an_local");
    expect(records[0].event.metadata_only_context).toEqual({
      status: 500,
      reason_code: "trace_upload_failed",
    });
  });

  it("writes NOTHING to the deadletter on a §9 tracing-policy refusal", async () => {
    const tracer = stubTracer(async () => {
      const e = new Error("HTTP 403: TRACING_NOT_ENABLED_FOR_WORKSPACE") as Error & {
        status?: number;
        tracingDisabledByPolicy?: boolean;
      };
      e.status = 403;
      e.tracingDisabledByPolicy = true;
      throw e;
    });

    await boundedTraceFlush(tracer);

    expect(fs.existsSync(deadletterPath())).toBe(false);
  });

  it("records NOTHING when the telemetry kill switch is on", async () => {
    process.env.MEETLESS_TELEMETRY = "off";
    const tracer = stubTracer(async () => {
      const e = new Error("HTTP 500") as Error & { status?: number };
      e.status = 500;
      throw e;
    });

    await boundedTraceFlush(tracer);

    expect(fs.existsSync(deadletterPath())).toBe(false);
  });
});

describe("makeHttpFlush body shape (P1.T4 client-side contract)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("POSTs to /internal/v1/agent-traces/ingest with bearer + X-Trace-ID + workspaceId in body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    }) as any;

    const flush = makeHttpFlush({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "TOK_123",
      workspaceId: "ws_an_local",
    });

    const traceId = "a".repeat(32);
    await flush({
      traceId,
      rootSpan: { spanId: "s1", parentSpanId: null, name: "mla.cmd", startTime: "t", status: "ok" } as any,
      spans: [],
      client: { mlaVersion: "0.1.0", platform: "darwin" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:3006/internal/v1/agent-traces/ingest");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer TOK_123");
    expect(h["X-Trace-ID"]).toBe(traceId);
    expect(h["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.workspaceId).toBe("ws_an_local");
    expect(body.traceId).toBe(traceId);
    expect(body.client.mlaVersion).toBe("0.1.0");
  });

  it("stamps X-Meetless-Actor when an actorUserId is supplied (control's INV-AUTH-1 guard requires it)", async () => {
    // Regression: control's agent-traces ingest is a workspace-bound write
    // behind AgentReviewWorkspaceGuard, which rejects with 403 FORBIDDEN
    // "Actor identity required for this write" when no actor is presented.
    // lib/http.ts stamps X-Meetless-Actor on every other control hop; the
    // hand-rolled flush MUST do the same or every self-trace 403s.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    }) as any;

    const flush = makeHttpFlush({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "TOK_123",
      workspaceId: "ws_an_local",
      actorUserId: "wu_an_local_owner",
    });

    await flush({
      traceId: "a".repeat(32),
      rootSpan: { spanId: "s1", parentSpanId: null, name: "mla.cmd", startTime: "t", status: "ok" } as any,
      spans: [],
      client: { mlaVersion: "0.1.0", platform: "darwin" },
    });

    const h = calls[0].init.headers as Record<string, string>;
    expect(h["X-Meetless-Actor"]).toBe("wu_an_local_owner");
  });

  it("omits X-Meetless-Actor when the actorUserId is absent or blank (mirrors lib/http.ts)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    }) as any;

    const flush = makeHttpFlush({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "TOK_123",
      workspaceId: "ws_an_local",
      actorUserId: "   ",
    });

    await flush({
      traceId: "a".repeat(32),
      rootSpan: { spanId: "s1", parentSpanId: null, name: "mla.cmd", startTime: "t", status: "ok" } as any,
      spans: [],
      client: { mlaVersion: "0.1.0", platform: "darwin" },
    });

    const h = calls[0].init.headers as Record<string, string>;
    expect(h["X-Meetless-Actor"]).toBeUndefined();
  });

  it("throws with HTTP status when control returns non-2xx (so boundedTraceFlush can react)", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => '{"code":"INTERNAL_ERROR"}',
    })) as any;

    const flush = makeHttpFlush({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "TOK_X",
      workspaceId: "ws_blocked",
    });

    await expect(
      flush({
        traceId: "a".repeat(32),
        rootSpan: { spanId: "s1", parentSpanId: null, name: "mla.cmd", startTime: "t", status: "ok" } as any,
        spans: [],
        client: { mlaVersion: "0.1.0", platform: "darwin" },
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("tags a §9 tracing-policy 403 so the flusher can skip the warning", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '{"code":"TRACING_NOT_ENABLED_FOR_WORKSPACE"}',
    })) as any;

    const flush = makeHttpFlush({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "TOK_X",
      workspaceId: "ws_dogfood_a",
    });

    await expect(
      flush({
        traceId: "a".repeat(32),
        rootSpan: { spanId: "s1", parentSpanId: null, name: "mla.cmd", startTime: "t", status: "ok" } as any,
        spans: [],
        client: { mlaVersion: "0.1.0", platform: "darwin" },
      }),
    ).rejects.toMatchObject({ status: 403, tracingDisabledByPolicy: true });
  });

  it("does NOT tag a non-policy 403 (auth/token) as a tracing-policy skip", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () =>
        '{"code":"FORBIDDEN","message":"Token not authorized for this workspace"}',
    })) as any;

    const flush = makeHttpFlush({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "TOK_X",
      workspaceId: "ws_dogfood_a",
    });

    await flush({
      traceId: "a".repeat(32),
      rootSpan: { spanId: "s1", parentSpanId: null, name: "mla.cmd", startTime: "t", status: "ok" } as any,
      spans: [],
      client: { mlaVersion: "0.1.0", platform: "darwin" },
    }).then(
      () => {
        throw new Error("expected flush to reject");
      },
      (e: any) => {
        expect(e.status).toBe(403);
        expect(e.tracingDisabledByPolicy).toBeUndefined();
      },
    );
  });
});
