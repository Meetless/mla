/**
 * Slice 2 of the `mla mcp` refactor.
 *
 * Run: node --test
 *
 * server.js used to read MEETLESS_WORKSPACE_ID / MEETLESS_CONTROL_TOKEN at module
 * top level and process.exit(2) when absent, then connect a stdio transport on
 * import. That makes it impossible to drive from the `mla mcp` (CJS) command,
 * which must inject the cli-config user-token closures instead of an env service
 * key. This test pins the two new seams:
 *
 *   createMcpServer(deps) -> a configured Server, built from INJECTED deps with
 *                            ZERO env reads and no transport side effect.
 *   dispatchTool(name,args,deps) -> the pure tool-dispatch, echoing the INJECTED
 *                            defaultWorkspaceId (never an env pin) and masking
 *                            handler errors into an isError result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpServer,
  dispatchTool,
  withStalenessWarning,
  shouldRestartForStaleness,
  createStaleRestartPoller,
} from "./server.js";

function stubAskModes(overrides = {}) {
  return {
    runAnswer: async (args) => ({ mode: "answer", answer: `A:${args.query}`, results: [] }),
    runSearch: async () => ({ mode: "search", results: [] }),
    runCanonical: async () => ({ mode: "canonical", results: [] }),
    runCompare: async () => ({ mode: "compare", results: [] }),
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    controlFetch: async () => ({}),
    intelFetch: async () => ({}),
    askModes: stubAskModes(),
    defaultWorkspaceId: "ws_injected",
    operatorUserId: null,
    ...overrides,
  };
}

function parseResult(result) {
  assert.ok(result && Array.isArray(result.content), "result must carry content[]");
  return JSON.parse(result.content[0].text);
}

test("createMcpServer builds a Server from injected deps with NO env (no exit, no transport)", () => {
  // Prove the env pin is gone: with both required env vars absent, the old code
  // would process.exit(2) at construction. The factory must not read them.
  const savedWs = process.env.MEETLESS_WORKSPACE_ID;
  const savedTok = process.env.MEETLESS_CONTROL_TOKEN;
  delete process.env.MEETLESS_WORKSPACE_ID;
  delete process.env.MEETLESS_CONTROL_TOKEN;
  try {
    const server = createMcpServer({
      controlFetch: async () => ({}),
      intelFetch: async () => ({}),
      intelAsk: async () => ({ answer: "x", results: [] }),
      defaultWorkspaceId: "ws_injected",
      notesRoot: "/tmp/meetless-mcp-test-notes-does-not-exist",
    });
    assert.equal(typeof server.connect, "function", "must return a connectable Server");
  } finally {
    if (savedWs !== undefined) process.env.MEETLESS_WORKSPACE_ID = savedWs;
    if (savedTok !== undefined) process.env.MEETLESS_CONTROL_TOKEN = savedTok;
  }
});

test("dispatchTool meetless__query/answer echoes the INJECTED workspace, not an env pin", async () => {
  const result = await dispatchTool(
    "meetless__query",
    { mode: "answer", query: "what is X?" },
    baseDeps(),
  );
  const body = parseResult(result);
  assert.equal(body.answer, "A:what is X?");
  assert.equal(body.workspace, "ws_injected");
});

test("dispatchTool meetless__query/relationships uses injected intelFetch+ws and stamps review_policy", async () => {
  let sawPath;
  const askModes = stubAskModes();
  // relationships is NOT one of the askModes; dispatchTool calls runRelationships
  // with the injected intelFetch + defaultWorkspaceId (the claim-grain pending
  // queue, NOT control's retired candidate graph). We assert via an intel closure
  // that records the path the handler queried.
  const intelFetch = async (pathAndQuery) => {
    sawPath = pathAndQuery;
    return { items: [], count: 0 };
  };
  const result = await dispatchTool(
    "meetless__query",
    { mode: "relationships" },
    baseDeps({ askModes, intelFetch }),
  );
  const body = parseResult(result);
  assert.equal(body.workspace, "ws_injected");
  assert.ok(typeof body.review_policy === "string" && body.review_policy.length > 0);
  assert.ok(
    sawPath && sawPath.includes("/relation-assertions/pending"),
    "must hit intel's claim-grain pending queue",
  );
  assert.ok(sawPath.includes("ws_injected"), "intel path must carry injected ws");
});

test("dispatchTool routes meetless__kb_doc_detail to the injected intelFetch with the injected ws", async () => {
  const paths = [];
  const intelFetch = async (pathAndQuery) => {
    paths.push(pathAndQuery);
    if (pathAndQuery.includes("/detail")) return { id: "doc-1", revisions: [], chunks: [] };
    return {};
  };
  const result = await dispatchTool(
    "meetless__kb_doc_detail",
    { document_id: "11111111-2222-3333-4444-555555555555" },
    baseDeps({ intelFetch }),
  );
  const body = parseResult(result);
  assert.equal(body.workspaceId, "ws_injected");
  assert.ok(paths.length > 0, "intel must have been called");
  for (const p of paths) {
    assert.ok(p.includes("ws_injected"), `path ${p} must carry the injected workspace`);
  }
});

test("dispatchTool returns an isError result (does not throw) when a handler throws", async () => {
  const askModes = stubAskModes({
    runAnswer: async () => {
      throw new Error("intel boom");
    },
  });
  const result = await dispatchTool(
    "meetless__query",
    { mode: "answer", query: "x" },
    baseDeps({ askModes }),
  );
  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.ok(String(body.error).includes("intel boom"));
});

test("dispatchTool reports unknown tools as isError", async () => {
  const result = await dispatchTool("meetless__nope", {}, baseDeps());
  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.ok(String(body.error).includes("unknown tool"));
});

// withStalenessWarning wraps every CallTool result: when the injected staleCheck
// reports this long-lived server is running code older than the build on disk
// (the stale-dist footgun behind the "This operation was aborted" reports), it
// PREPENDS a one-line warning so the operator sees it inline. It must be inert
// and fail-open in every other case: no probe, null/empty probe, a throwing
// probe, or a result without a content array must all pass the result through
// untouched. A staleness hint must never corrupt or block a real tool response.

function okResult() {
  return { content: [{ type: "text", text: '{"ok":true}' }] };
}

test("withStalenessWarning prepends the warning text when the probe reports staleness", () => {
  const out = withStalenessWarning(okResult(), () => "STALE: restart your editor");
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, "STALE: restart your editor");
  // Original payload is preserved, just pushed down.
  assert.equal(out.content[1].text, '{"ok":true}');
});

test("withStalenessWarning preserves other result fields (e.g. isError) while prepending", () => {
  const errResult = { isError: true, content: [{ type: "text", text: "boom" }] };
  const out = withStalenessWarning(errResult, () => "STALE");
  assert.equal(out.isError, true);
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0].text, "STALE");
});

test("withStalenessWarning returns the result unchanged when the probe says fresh (null)", () => {
  const result = okResult();
  const out = withStalenessWarning(result, () => null);
  assert.equal(out, result);
  assert.equal(out.content.length, 1);
});

test("withStalenessWarning returns the result unchanged for an empty-string probe", () => {
  const result = okResult();
  assert.equal(withStalenessWarning(result, () => ""), result);
});

test("withStalenessWarning returns the result unchanged when there is no probe", () => {
  const result = okResult();
  assert.equal(withStalenessWarning(result, null), result);
  assert.equal(withStalenessWarning(result, undefined), result);
});

test("withStalenessWarning never throws (fails open) when the probe throws", () => {
  const result = okResult();
  let out;
  assert.doesNotThrow(() => {
    out = withStalenessWarning(result, () => {
      throw new Error("probe boom");
    });
  });
  assert.equal(out, result);
});

test("withStalenessWarning passes through a result that has no content array", () => {
  const weird = { isError: true };
  assert.equal(withStalenessWarning(weird, () => "STALE"), weird);
});

// Self-heal poller. Beyond WARNING about a stale server, a SUPERVISED child can
// reload itself: an idle poller checks the same staleCheck probe and, when a
// newer build is on disk AND no tool call is in flight, fires onStaleRestart
// (the cli wires that to exit with the restart sentinel; the parent respawns a
// fresh worker on the new dist). The in-flight gate is the safety contract: a
// reload must NEVER abort a request that is mid-execution. Every check fails
// open: a missing or throwing probe must never crash the poller.

test("shouldRestartForStaleness is true only when idle AND the probe reports staleness", () => {
  assert.equal(shouldRestartForStaleness({ inFlight: 0, staleCheck: () => "STALE" }), true);
});

test("shouldRestartForStaleness is false while a tool call is in flight, even if stale", () => {
  assert.equal(shouldRestartForStaleness({ inFlight: 1, staleCheck: () => "STALE" }), false);
  assert.equal(shouldRestartForStaleness({ inFlight: 3, staleCheck: () => "STALE" }), false);
});

test("shouldRestartForStaleness is false when the probe says fresh (null/empty)", () => {
  assert.equal(shouldRestartForStaleness({ inFlight: 0, staleCheck: () => null }), false);
  assert.equal(shouldRestartForStaleness({ inFlight: 0, staleCheck: () => "" }), false);
});

test("shouldRestartForStaleness is false when there is no probe", () => {
  assert.equal(shouldRestartForStaleness({ inFlight: 0, staleCheck: null }), false);
  assert.equal(shouldRestartForStaleness({ inFlight: 0 }), false);
});

test("shouldRestartForStaleness fails open (false, no throw) when the probe throws", () => {
  let out;
  assert.doesNotThrow(() => {
    out = shouldRestartForStaleness({
      inFlight: 0,
      staleCheck: () => {
        throw new Error("probe boom");
      },
    });
  });
  assert.equal(out, false);
});

test("createStaleRestartPoller.tick reloads when idle and stale", () => {
  let restarts = 0;
  const poller = createStaleRestartPoller({
    staleCheck: () => "STALE",
    onStaleRestart: () => {
      restarts++;
    },
  });
  poller.tick();
  assert.equal(restarts, 1);
});

test("createStaleRestartPoller.tick does NOT reload while a tracked call is in flight, then DOES once it settles", async () => {
  let restarts = 0;
  const poller = createStaleRestartPoller({
    staleCheck: () => "STALE",
    onStaleRestart: () => {
      restarts++;
    },
  });

  // Drive a real in-flight tool call: track() holds a pending promise.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const inFlightCall = poller.track(async () => {
    await gate;
    return "done";
  });

  // A reload tick during the call must be suppressed (would abort the request).
  poller.tick();
  assert.equal(restarts, 0, "must not reload mid-request");

  // Let the call finish, then a tick reloads as expected.
  release();
  assert.equal(await inFlightCall, "done");
  poller.tick();
  assert.equal(restarts, 1, "reloads once the request has settled");
});

test("createStaleRestartPoller.track returns the wrapped value and decrements even when it throws", async () => {
  const poller = createStaleRestartPoller({
    staleCheck: () => "STALE",
    onStaleRestart: () => {},
  });
  assert.equal(await poller.track(async () => 42), 42);
  await assert.rejects(
    poller.track(async () => {
      throw new Error("handler boom");
    }),
    /handler boom/,
  );
  // The throw must not leak an in-flight count: a later idle tick can reload.
  let restarted = false;
  const p2 = createStaleRestartPoller({
    staleCheck: () => "STALE",
    onStaleRestart: () => {
      restarted = true;
    },
  });
  await assert.rejects(p2.track(async () => {
    throw new Error("x");
  }));
  p2.tick();
  assert.equal(restarted, true);
});

test("createMcpServer schedules the idle poll when onStaleRestart is wired (supervised child)", () => {
  const scheduled = [];
  let restarts = 0;
  createMcpServer({
    controlFetch: async () => ({}),
    intelFetch: async () => ({}),
    intelAsk: async () => ({ answer: "x", results: [] }),
    defaultWorkspaceId: "ws_injected",
    notesRoot: "/tmp/meetless-mcp-test-notes-does-not-exist",
    staleCheck: () => "STALE",
    onStaleRestart: () => {
      restarts++;
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
    },
  });
  assert.equal(scheduled.length, 1, "exactly one poll loop scheduled");
  assert.ok(scheduled[0].ms > 0, "poll interval must be positive");
  // The scheduled fn is the idle poll: invoking it (idle + stale) reloads.
  scheduled[0].fn();
  assert.equal(restarts, 1);
});

test("createMcpServer does NOT schedule a poll when onStaleRestart is absent (bare / kill-switched run)", () => {
  const scheduled = [];
  createMcpServer({
    controlFetch: async () => ({}),
    intelFetch: async () => ({}),
    intelAsk: async () => ({ answer: "x", results: [] }),
    defaultWorkspaceId: "ws_injected",
    notesRoot: "/tmp/meetless-mcp-test-notes-does-not-exist",
    staleCheck: () => "STALE",
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
    },
  });
  assert.equal(scheduled.length, 0);
});
