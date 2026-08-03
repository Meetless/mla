// P2 acceptance tests for the mla observability spine (notes/20260530-mla-
// observability-diagnostic-spine.md §10.P2). One test per "must test" bullet:
//
//   1. Root + 2 child spans, parent linkage, names match contract.
//   2. Deep-link printed on flush success.
//   3. Deep-link suppressed on flush failure with no intel echo.
//   4. Deep-link printed when only intel echoed the trace id.
//   5. Deep-link suppressed when tracing.enabled is false.
//   6. argv REDUCTION on the root span attribute (was: redaction; see
//      trace-argv-reduction.spec.ts for why a secret redactor was not enough).

import {
  createRunTracer,
  setRunTraceId,
  setRunTracer,
  resetRunTracerForTesting,
  maybePrintDeepLink,
  reduceArgvForSpan,
  loadBuildInfo,
  type WorkspaceConfigForTracing,
} from "../../src/lib/observability";
import { get as controlGet } from "../../src/lib/http";
import type { CliConfig } from "../../src/lib/config";

function fakeCfg(): CliConfig {
  return {
    controlUrl: "http://127.0.0.1:3006",
    controlToken: "tok",
    workspaceId: "ws_an_local",
    mlaPath: "",
    auth: { mode: "shared-key", accessToken: "tok" },
  };
}

describe("P2.T1: root + child spans shape", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    resetRunTracerForTesting();
    setRunTraceId(""); // benign reset; module read-only otherwise
    jest.clearAllMocks();
  });

  it("produces one root + two children with parentSpanId === root.spanId and correct names", async () => {
    const traceId = "a".repeat(32);
    setRunTraceId(traceId);

    // Real tracer (not noop) so child spans are tracked. flushFn is a stub so
    // the spec never touches the network; the focus is the in-memory shape.
    const tracer = createRunTracer({
      traceId,
      rootName: "mla.ask.none",
      buildInfo: loadBuildInfo(),
      flushFn: async () => undefined,
    });
    setRunTracer(tracer);

    // Mock fetch so both control GETs resolve as 200 with empty bodies.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })) as any;

    await controlGet(fakeCfg(), "/internal/v1/workspaces/me?workspaceId=ws_an_local");
    await controlGet(fakeCfg(), "/internal/v1/coordination-cases/cse_ABCD1234");

    const snap = tracer.snapshot();
    expect(snap.rootSpan.name).toBe("mla.ask.none");
    expect(snap.spans).toHaveLength(2);

    // Parent linkage: every child's parentSpanId equals the root's spanId.
    for (const child of snap.spans) {
      expect(child.parentSpanId).toBe(snap.rootSpan.spanId);
    }

    // Names: first call -> control.workspaces.me (no query, id-shape miss).
    // Second call -> control.coordination-cases.:id (cse_ABCD1234 collapses).
    const names = snap.spans.map((s) => s.name).sort();
    expect(names).toEqual([
      "control.coordination-cases.:id",
      "control.workspaces.me",
    ]);

    // Each child carries http.method, route, http.status, latency_ms.
    for (const child of snap.spans) {
      expect(child.attributes).toBeDefined();
      expect(child.attributes!["http.method"]).toBe("GET");
      expect(typeof child.attributes!["latency_ms"]).toBe("number");
      expect(child.attributes!["http.status"]).toBe(200);
    }
  });
});

describe("P2.T2: deep-link printed on flush success", () => {
  let outBuf: string;
  let outSpy: jest.SpyInstance;

  beforeEach(() => {
    outBuf = "";
    outSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      outBuf += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
  });

  it("prints exactly one trace: line when tracing.enabled + projectId + flushSucceeded", () => {
    const traceId = "b".repeat(32);
    const config: WorkspaceConfigForTracing = {
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: "p_xyz" },
    };

    const printed = maybePrintDeepLink({
      traceId,
      config,
      flushSucceeded: true,
      intelEchoed: false,
    });

    expect(printed).toBe(true);
    const matches = outBuf.match(/^trace: https:\/\/cloud\.langfuse\.com\/project\/p_xyz\/traces\/[0-9a-f]{32}\n$/);
    expect(matches).not.toBeNull();
    expect(outBuf).toContain(traceId);
  });
});

describe("P2.T3: deep-link suppressed on flush failure with no intel echo", () => {
  let outBuf: string;
  let outSpy: jest.SpyInstance;

  beforeEach(() => {
    outBuf = "";
    outSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      outBuf += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
  });

  it("prints NO trace: line when flushSucceeded=false AND intelEchoed=false", () => {
    const config: WorkspaceConfigForTracing = {
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: "p_xyz" },
    };

    const printed = maybePrintDeepLink({
      traceId: "c".repeat(32),
      config,
      flushSucceeded: false,
      intelEchoed: false,
    });

    expect(printed).toBe(false);
    expect(outBuf).not.toMatch(/trace:/);
  });
});

describe("P2.T4: deep-link printed when only intel echoed the id", () => {
  let outBuf: string;
  let outSpy: jest.SpyInstance;

  beforeEach(() => {
    outBuf = "";
    outSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      outBuf += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
  });

  it("prints the deep link when flushSucceeded=false but intelEchoed=true (intel produced the server-side trace)", () => {
    const traceId = "d".repeat(32);
    const config: WorkspaceConfigForTracing = {
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: "p_abc" },
    };

    const printed = maybePrintDeepLink({
      traceId,
      config,
      flushSucceeded: false,
      intelEchoed: true,
    });

    expect(printed).toBe(true);
    expect(outBuf).toContain(`https://cloud.langfuse.com/project/p_abc/traces/${traceId}`);
  });
});

describe("P2.T5: deep-link suppressed when tracing.enabled is false (tenant safety)", () => {
  let outBuf: string;
  let outSpy: jest.SpyInstance;

  beforeEach(() => {
    outBuf = "";
    outSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      outBuf += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
  });

  it("never prints the link when tracing.enabled=false, even with projectId set and a successful echo", () => {
    const config: WorkspaceConfigForTracing = {
      workspaceId: "ws_an_local",
      tracing: { enabled: false, sentryEnabled: false, langfuseProjectId: "p_should_not_leak" },
    };

    const printed = maybePrintDeepLink({
      traceId: "e".repeat(32),
      config,
      flushSucceeded: true,
      intelEchoed: true,
    });

    expect(printed).toBe(false);
    expect(outBuf).toBe("");
  });

  it("suppresses the link when the workspace config is null entirely (no preload)", () => {
    const printed = maybePrintDeepLink({
      traceId: "f".repeat(32),
      config: null,
      flushSucceeded: true,
      intelEchoed: true,
    });

    expect(printed).toBe(false);
    expect(outBuf).toBe("");
  });
});

describe("P2.T6: argv reduction on root span attribute", () => {
  it("keeps the command and approved flag names, drops every value and positional", () => {
    // The spec's must-test 6 was written as "argv redaction" and was satisfied
    // by mapping argv through the secret redactor. That stripped the token on
    // line 4 and nothing else, so the prose on the last line survived. The
    // contract is now reduction: a token cannot leak because no VALUE is
    // emitted at all, whatever its shape.
    const input = [
      "init",
      "--control-token",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
      "--workspace-id",
      "ws_an_local",
      "--note",
      "the quick brown fox jumps over the lazy dog",
    ];

    const out = reduceArgvForSpan(input);

    expect(out.command).toBe("init");
    expect(out.subcommand).toBeNull();
    expect(out.flags).toEqual(["control-token", "note", "workspace-id"]);

    const wire = JSON.stringify(out);
    expect(wire).not.toContain("ghp_");
    expect(wire).not.toContain("ws_an_local");
    expect(wire).not.toContain("the quick brown fox");
  });

  it("emits nothing at all for env-style assignments and inline bearer headers", () => {
    // These used to be the interesting cases because the redactor had to find
    // the secret inside a larger string. Now they are positionals, so they are
    // dropped whole and the redactor is not in the path.
    const input = [
      "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv",
      'curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.payload.sig" api',
    ];

    const out = reduceArgvForSpan(input);

    expect(out).toEqual({ command: "unknown", subcommand: null, flags: [] });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("sk-proj-");
    expect(wire).not.toContain("eyJhbGci");
  });
});
