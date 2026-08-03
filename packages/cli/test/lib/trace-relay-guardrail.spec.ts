// The §9 tenant guardrail, client side.
//
// notes/20260530-mla-observability-diagnostic-spine.md §7.1 + §9 permit the
// agent-trace relay ONLY for ws_an_local or a workspace explicitly flagged
// tracingDogfood. Control enforces that in AgentTracesService. The CLI enforced
// it on the Sentry plane (workspaceSentryAllowed) and NOT on the trace-upload
// plane, so every run under every other workspace POSTed a span batch control
// was guaranteed to refuse: measured in prod on 2026-08-01 at ~25 denials/min,
// ~36k/day, zero 2xx in 7 days, silent for 30+ days because the refusal is on
// the deliberately-silenced error list.
//
// Two invariants live here:
//   D1  a workspace that cannot relay must produce ZERO network calls, proven by
//       counting fetches through the real createRunTracer -> boundedTraceFlush
//       path, not by trusting a predicate in isolation.
//   D3  a suppressed relay must NOT report flush success, or maybePrintDeepLink
//       advertises a Langfuse URL for a trace that was never uploaded.

import {
  workspaceTraceRelayAllowed,
  workspaceSentryAllowed,
  makeTraceFlushIfPermitted,
  createRunTracer,
  boundedTraceFlush,
  didTraceFlushSucceed,
  resetTraceFlushOutcomeForTesting,
  maybePrintDeepLink,
  type BuildInfo,
  type WorkspaceConfigForTracing,
} from "../../src/lib/observability";

const BUILD_INFO: BuildInfo = {
  version: "0.2.31",
  sha: "deadbeef",
  branch: "main",
  dirty: false,
  builtAt: "2026-08-01T00:00:00.000Z",
};

const TRACE_ID = "a".repeat(32);

function cfg(
  over: Partial<WorkspaceConfigForTracing> = {},
): WorkspaceConfigForTracing {
  return {
    workspaceId: "ws_customer_acme",
    tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: "proj_1" },
    tracingDogfood: false,
    ...over,
  };
}

describe("workspaceTraceRelayAllowed mirrors control's §9 gate exactly", () => {
  it("denies a null config (fail closed: no config means no permission)", () => {
    expect(workspaceTraceRelayAllowed(null)).toBe(false);
  });

  it("denies an ordinary workspace with tracingDogfood false", () => {
    expect(workspaceTraceRelayAllowed(cfg())).toBe(false);
  });

  it("denies an ordinary workspace with tracingDogfood absent", () => {
    expect(workspaceTraceRelayAllowed(cfg({ tracingDogfood: undefined }))).toBe(
      false,
    );
  });

  it("allows ws_an_local without consulting any tracing setting", () => {
    expect(
      workspaceTraceRelayAllowed({ workspaceId: "ws_an_local", tracing: null }),
    ).toBe(true);
  });

  it("allows any workspace flagged tracingDogfood === true", () => {
    expect(workspaceTraceRelayAllowed(cfg({ tracingDogfood: true }))).toBe(true);
  });

  it("does NOT require sentryEnabled: control's trace gate never reads it, so requiring it here would refuse relays control would accept", () => {
    // The two planes share the tenant gate, not the Sentry toggle. Coupling the
    // trace plane to sentryEnabled would make the client stricter than the
    // server and silently drop traces for a dogfood workspace with Sentry off.
    const dogfoodSentryOff = cfg({
      tracingDogfood: true,
      tracing: { enabled: true, sentryEnabled: false, langfuseProjectId: null },
    });
    expect(workspaceTraceRelayAllowed(dogfoodSentryOff)).toBe(true);
    expect(workspaceSentryAllowed(dogfoodSentryOff)).toBe(false);
  });

  it("keeps workspaceSentryAllowed composed on the same tenant gate so the two planes cannot drift", () => {
    // Anything the tenant gate refuses, the Sentry plane must refuse too.
    for (const c of [
      null,
      cfg(),
      cfg({ tracingDogfood: undefined }),
      cfg({ workspaceId: "ws_other" }),
    ]) {
      if (!workspaceTraceRelayAllowed(c)) {
        expect(workspaceSentryAllowed(c)).toBe(false);
      }
    }
  });
});

describe("D1: a non-dogfood workspace produces ZERO trace-ingest requests", () => {
  const originalFetch = global.fetch;
  let calls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    }) as any;
    resetTraceFlushOutcomeForTesting();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  async function runFlushFor(config: WorkspaceConfigForTracing | null) {
    const flushFn = makeTraceFlushIfPermitted({
      config,
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "TOK_123",
      workspaceId: config?.workspaceId ?? "ws_missing",
      actorUserId: "wu_actor",
    });
    const tracer = createRunTracer({
      traceId: TRACE_ID,
      rootName: "mla.doctor.none",
      buildInfo: BUILD_INFO,
      flushFn,
    });
    tracer.endRoot({ status: "ok" });
    await boundedTraceFlush(tracer);
    return flushFn;
  }

  it("installs no flush and sends nothing for an ordinary customer workspace", async () => {
    const flushFn = await runFlushFor(cfg());
    expect(flushFn).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("sends nothing when the workspace config was never fetched (fail closed)", async () => {
    const flushFn = await runFlushFor(null);
    expect(flushFn).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("still POSTs the span batch for a dogfood workspace (the guardrail must not disable relay outright)", async () => {
    const flushFn = await runFlushFor(cfg({ tracingDogfood: true }));
    expect(flushFn).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://127.0.0.1:3006/internal/v1/agent-traces/ingest",
    );
    expect(JSON.parse(calls[0].init.body as string).workspaceId).toBe(
      "ws_customer_acme",
    );
  });

  it("still POSTs for ws_an_local", async () => {
    const flushFn = await runFlushFor({
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: "p" },
    });
    expect(flushFn).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("D3: a suppressed relay must not report flush success", () => {
  let writeSpy: jest.SpyInstance;
  let stdoutBuf: string;

  beforeEach(() => {
    stdoutBuf = "";
    writeSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        stdoutBuf += String(chunk);
        return true;
      });
    resetTraceFlushOutcomeForTesting();
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("didTraceFlushSucceed() is false after flushing a no-op tracer (its flush resolves, which is not an upload)", async () => {
    const tracer = createRunTracer({
      traceId: TRACE_ID,
      rootName: "mla.doctor.none",
      buildInfo: BUILD_INFO,
      flushFn: null,
    });
    tracer.endRoot({ status: "ok" });
    await boundedTraceFlush(tracer);
    expect(didTraceFlushSucceed()).toBe(false);
  });

  it("prints no Langfuse deep link for a run whose trace was never uploaded", async () => {
    const tracer = createRunTracer({
      traceId: TRACE_ID,
      rootName: "mla.doctor.none",
      buildInfo: BUILD_INFO,
      flushFn: null,
    });
    tracer.endRoot({ status: "ok" });
    await boundedTraceFlush(tracer);

    const printed = maybePrintDeepLink({
      traceId: TRACE_ID,
      // tracing.enabled + a langfuseProjectId are exactly the conditions under
      // which the link WOULD print; only the flush outcome should stop it.
      config: cfg(),
      flushSucceeded: didTraceFlushSucceed(),
      intelEchoed: false,
    });
    expect(printed).toBe(false);
    expect(stdoutBuf).toBe("");
  });

  it("still prints when intel echoed the trace id, even with the relay suppressed (intel recorded it itself)", async () => {
    const tracer = createRunTracer({
      traceId: TRACE_ID,
      rootName: "mla.ask.none",
      buildInfo: BUILD_INFO,
      flushFn: null,
    });
    tracer.endRoot({ status: "ok" });
    await boundedTraceFlush(tracer);

    const printed = maybePrintDeepLink({
      traceId: TRACE_ID,
      config: cfg(),
      flushSucceeded: didTraceFlushSucceed(),
      intelEchoed: true,
    });
    expect(printed).toBe(true);
    expect(stdoutBuf).toContain(TRACE_ID);
  });

  it("reports success again once a real relay is installed and the POST lands", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }) as Response) as any;
    try {
      const flushFn = makeTraceFlushIfPermitted({
        config: cfg({ tracingDogfood: true }),
        controlUrl: "http://127.0.0.1:3006",
        controlToken: "TOK_123",
        workspaceId: "ws_customer_acme",
      });
      const tracer = createRunTracer({
        traceId: TRACE_ID,
        rootName: "mla.doctor.none",
        buildInfo: BUILD_INFO,
        flushFn,
      });
      tracer.endRoot({ status: "ok" });
      await boundedTraceFlush(tracer);
      expect(didTraceFlushSucceed()).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
