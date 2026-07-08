// P0.T3 / P0.T4 / P0.T5 acceptance tests for capture helpers + bootstrap
// orchestration (notes/20260530-mla-observability-diagnostic-spine.md §10.P0).
//
// Strategy: mock @sentry/node so we can assert which capture path fired (event
// kind, tags, level) without standing up a real DSN. Reset module state between
// tests so sentryAvailable and the workspace config gate are isolated.

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
  initSentry,
  setWorkspaceConfig,
  captureBootstrapError,
  captureCliError,
} from "../../src/lib/observability";
import { runCliBootstrap } from "../../src/cli";

let errSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  // Each test re-inits with a DSN so sentryAvailable flips true.
  initSentry({
    version: "0.0.1",
    sha: "deadbeef",
    branch: "test",
    dirty: false,
    builtAt: "2026-05-30T00:00:00Z",
    sentryDsn: "https://test@sentry.io/123",
  });
});

afterEach(() => {
  setWorkspaceConfig(null);
  errSpy.mockRestore();
  jest.restoreAllMocks();
});

describe("captureBootstrapError (P0.T3)", () => {
  it("fires on captureException with phase=bootstrap + trace_id, bypasses workspace gate", () => {
    setWorkspaceConfig(null); // simulate config-not-loaded
    const err = new Error("control unreachable");
    captureBootstrapError(err, { traceId: "a".repeat(32) });

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException).toHaveBeenCalledWith(err);
    expect(scope.setTag).toHaveBeenCalledWith("trace_id", "a".repeat(32));
    expect(scope.setTag).toHaveBeenCalledWith("phase", "bootstrap");
    expect(scope.setLevel).toHaveBeenCalledWith("error");
  });

  it("does NOT call workspace-aware capture helpers from the bootstrap path", () => {
    captureBootstrapError(new Error("x"), { traceId: "b".repeat(32) });
    // The bootstrap capture path uses captureException, not captureMessage
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });
});

describe("runCliBootstrap non-zero exit (P0.T4)", () => {
  it("captures a Sentry message with exit_code tag when dispatch returns 2 without throwing", async () => {
    // Set workspace config that PASSES the gate so the capture fires.
    setWorkspaceConfig({
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: null },
    });

    // "garbage" command -> dispatch returns 2 without throwing
    const code = await runCliBootstrap(["garbage-command"]);
    expect(code).toBe(2);

    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("exited 2"),
    );
    expect(scope.setTag).toHaveBeenCalledWith("exit_code", "2");
    expect(scope.setTag).toHaveBeenCalledWith("command", "garbage-command");
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
    // trace_id tag is non-empty and 32-hex
    const traceTagCalls = (scope.setTag as jest.Mock).mock.calls.filter(
      (c) => c[0] === "trace_id",
    );
    expect(traceTagCalls.length).toBeGreaterThan(0);
    expect(traceTagCalls[0][1]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does NOT call captureException for the non-zero (non-throw) path", async () => {
    setWorkspaceConfig({
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: null },
    });
    await runCliBootstrap(["garbage-command"]);
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it("workspace gate suppresses the non-zero capture for non-dogfood tenants", async () => {
    setWorkspaceConfig({
      workspaceId: "ws_some_tenant",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: null },
    });
    const code = await runCliBootstrap(["garbage-command"]);
    expect(code).toBe(2);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });
});

describe("captureCliError uncaught throw (P0.T5)", () => {
  it("captures an exception with error level + command/trace_id tags", async () => {
    setWorkspaceConfig({
      workspaceId: "ws_an_local",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: null },
    });

    const err = new Error("boom from dispatch");
    captureCliError(err, {
      traceId: "c".repeat(32),
      command: "mission",
      sub: "new",
    });

    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException).toHaveBeenCalledWith(err);
    expect(scope.setLevel).toHaveBeenCalledWith("error");
    expect(scope.setTag).toHaveBeenCalledWith("trace_id", "c".repeat(32));
    expect(scope.setTag).toHaveBeenCalledWith("command", "mission");
    expect(scope.setTag).toHaveBeenCalledWith("sub", "new");
  });

  it("workspace gate suppresses captureCliError for non-dogfood tenants", () => {
    setWorkspaceConfig({
      workspaceId: "ws_some_tenant",
      tracing: { enabled: true, sentryEnabled: true, langfuseProjectId: null },
    });
    captureCliError(new Error("x"), {
      traceId: "d".repeat(32),
      command: "any",
      sub: null,
    });
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });
});
