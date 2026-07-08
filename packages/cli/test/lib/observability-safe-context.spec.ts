// Phase 2 (spec gap 6.3 / OBS-9): the CLI allowlist drops payloads, and the
// capture helpers attach the Langfuse URL through that allowlist so a Sentry
// event one-clicks to its Langfuse trace while never carrying content.
//
// @sentry/node is mocked so the capture-wiring assertions can inspect the scope
// without a live DSN, mirroring observability-capture.spec.ts.

const sentryMock = {
  init: jest.fn(),
  setTags: jest.fn(),
  withScope: jest.fn((fn: (s: any) => void) => fn(scope)),
  withIsolationScope: jest.fn((fn: (s: any) => void) => fn(scope)),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
};
const scope = {
  setTag: jest.fn(),
  setLevel: jest.fn(),
  setContext: jest.fn(),
};

jest.mock("@sentry/node", () => sentryMock);

import {
  pickSafeObservabilityFields,
  setSafeObservabilityContext,
  captureCliError,
  captureCliNonZeroExit,
  initSentry,
  setWorkspaceConfig,
} from "../../src/lib/observability";

describe("pickSafeObservabilityFields (P2-T1, OBS-9 allowlist)", () => {
  it("keeps exactly the allowlisted keys", () => {
    const out = pickSafeObservabilityFields({
      traceId: "a".repeat(32),
      langfuseUrl: "https://cloud.langfuse.com/project/p/traces/x",
      release: "deadbeef",
      command: "ask",
      exitCode: 0,
      traceSource: "mla-cli",
      workspaceIdOrHash: "ws_an_local",
    });
    expect(out).toEqual({
      traceId: "a".repeat(32),
      langfuseUrl: "https://cloud.langfuse.com/project/p/traces/x",
      release: "deadbeef",
      command: "ask",
      exitCode: 0,
      traceSource: "mla-cli",
      workspaceIdOrHash: "ws_an_local",
    });
  });

  it("drops payload-bearing keys (OBS-9 negative): prompts, evidence, tool payloads, diffs, raw requests, tokens", () => {
    const out = pickSafeObservabilityFields({
      traceId: "a".repeat(32),
      prompt: "secret system prompt",
      evidence: "retrieved doc body with PII",
      toolPayload: { foo: "bar" },
      diff: "--- a/secret\n+++ b/secret",
      rawRequest: "POST /v1/ask {...}",
      token: "ghp_secrettoken",
      authorization: "Bearer abc",
    });
    expect(out).toEqual({ traceId: "a".repeat(32) });
    for (const k of [
      "prompt",
      "evidence",
      "toolPayload",
      "diff",
      "rawRequest",
      "token",
      "authorization",
    ]) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("drops null/undefined and non-scalar values smuggled into allowlisted keys", () => {
    const out = pickSafeObservabilityFields({
      traceId: "a".repeat(32),
      langfuseUrl: undefined,
      command: null as unknown as string,
      workspaceIdOrHash: { nested: "x" } as unknown as string,
    });
    expect(out).toEqual({ traceId: "a".repeat(32) });
  });
});

describe("setSafeObservabilityContext (P2-T1 / OBS-9)", () => {
  it("sets a single 'observability' context with only safe keys", () => {
    const calls: Array<[string, unknown]> = [];
    const fakeScope = {
      setContext: (k: string, v: Record<string, unknown> | null) => {
        calls.push([k, v]);
        return undefined;
      },
    };
    const returned = setSafeObservabilityContext(fakeScope, {
      traceId: "b".repeat(32),
      langfuseUrl: "https://cloud.langfuse.com/project/p/traces/y",
      prompt: "LEAK",
      evidence: "LEAK",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("observability");
    expect(calls[0][1]).toEqual({
      traceId: "b".repeat(32),
      langfuseUrl: "https://cloud.langfuse.com/project/p/traces/y",
    });
    expect(returned).toEqual({
      traceId: "b".repeat(32),
      langfuseUrl: "https://cloud.langfuse.com/project/p/traces/y",
    });
  });

  it("sets the context to null when nothing safe survives (no empty leak frame)", () => {
    const calls: Array<[string, unknown]> = [];
    const fakeScope = {
      setContext: (k: string, v: Record<string, unknown> | null) => {
        calls.push([k, v]);
        return undefined;
      },
    };
    setSafeObservabilityContext(fakeScope, { prompt: "LEAK", evidence: "LEAK" });
    expect(calls[0]).toEqual(["observability", null]);
  });
});

describe("capture helpers attach the Langfuse URL via the allowlist (P2-T2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    initSentry({
      version: "0.0.1",
      sha: "deadbeef",
      branch: "test",
      dirty: false,
      builtAt: "2026-06-07T00:00:00Z",
      sentryDsn: "https://test@sentry.io/123",
    });
  });

  afterEach(() => {
    setWorkspaceConfig(null);
  });

  it("captureCliError attaches an 'observability' context with the Langfuse URL built from the workspace project id", () => {
    setWorkspaceConfig({
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: "p_abc" },
    });
    captureCliError(new Error("boom"), {
      traceId: "c".repeat(32),
      command: "ask",
      sub: null,
    });
    const ctxCalls = (scope.setContext as jest.Mock).mock.calls.filter(
      (c) => c[0] === "observability",
    );
    expect(ctxCalls).toHaveLength(1);
    expect(ctxCalls[0][1]).toMatchObject({
      traceId: "c".repeat(32),
      langfuseUrl: `https://cloud.langfuse.com/project/p_abc/traces/${"c".repeat(32)}`,
      command: "ask",
      traceSource: "mla-cli",
      workspaceIdOrHash: "ws_an_local",
    });
  });

  it("omits the Langfuse URL when no project id is configured (allowlist drops the undefined)", () => {
    setWorkspaceConfig({
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: null },
    });
    captureCliNonZeroExit({
      traceId: "d".repeat(32),
      command: "kb",
      sub: "review",
      exitCode: 2,
    });
    const ctxCalls = (scope.setContext as jest.Mock).mock.calls.filter(
      (c) => c[0] === "observability",
    );
    expect(ctxCalls).toHaveLength(1);
    const attached = ctxCalls[0][1] as Record<string, unknown>;
    expect(attached).not.toHaveProperty("langfuseUrl");
    expect(attached).toMatchObject({
      traceId: "d".repeat(32),
      command: "kb review",
      exitCode: 2,
      traceSource: "mla-cli",
    });
  });
});
