#!/usr/bin/env node
/**
 * Meetless MCP server.
 *
 * Exposes meetless__query (+ kb_doc_detail / retrieve_knowledge /
 * relationship_verdict) that route Claude Code's questions to intel /v1/ask and
 * control /internal/v1 with optional INDEX.md-based canonical resolution. The
 * server itself never calls an LLM directly (Rule 5: Intel owns ALL LLM/AI
 * decisions).
 *
 * Two front doors share one implementation:
 *
 *   1. `mla mcp` (preferred): the CLI injects cli-config user-token closures
 *      (auto-refreshing) + the marker-resolved workspace via createMcpServer().
 *      No service key, ACL-scoped to the logged-in human.
 *
 *   2. Legacy `meetless-mcp` bin (this file run directly): reads env and builds
 *      the same deps from a shared service key. Kept for CI / headless installs.
 *
 * Legacy env (path 2 only):
 *   MEETLESS_WORKSPACE_ID
 *   MEETLESS_CONTROL_TOKEN   (bearer for control + intel /internal/v1; legacy
 *                       alias INTERNAL_API_KEY still accepted)
 * Optional:
 *   MEETLESS_INTEL_URL  (default http://127.0.0.1:8100; alias INTEL_BASE_URL)
 *   MEETLESS_BACKEND_URL (control base URL, default http://127.0.0.1:3006;
 *                       alias CONTROL_BASE_URL)
 *   MEETLESS_NOTES_ROOT (default: ../../notes relative to repo)
 *   MEETLESS_OPERATOR_USER_ID (default userId for the verdict tool)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeControlFetch,
  runRelationships,
  runVerdict,
} from "./relationship_actions.js";
import { makeIntelFetch, runKbDocDetail } from "./kb_actions.js";
import { runRetrieveKnowledge } from "./evidence_actions.js";
import { TOOLS, assertReadOnlyManifest } from "./tool_manifest.js";
// Shared ask implementation (proposal 20260529 T5). The mode routing, the
// status-fallback rule, and the INDEX.md matcher all live in @meetless/ask-core
// so the MCP and the `mla` CLI are two front-ends over one implementation.
// Imported by relative path (ask-core is a sibling package, not npm-installed).
import { statusFallback } from "../ask-core/status_fallback.js";
import { makeIntelAsk, makeAskModes } from "../ask-core/ask_modes.js";
import { makeMatchCanonical } from "../ask-core/match_canonical.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Pure tool dispatch ----------------------------------------------
//
// Maps an MCP CallTool request to a content result. All I/O is via the injected
// closures; this function reads NO env and never connects a transport, so both
// front doors and the unit tests share one dispatch path.
//
// deps = {
//   controlFetch, intelFetch,                      // env-free fetch closures
//   askModes: { runAnswer, runSearch, runCanonical, runCompare },
//   defaultWorkspaceId,                            // the effective workspace
//   operatorUserId,                                // verdict actorUserId default
// }
export async function dispatchTool(name, args, deps) {
  const {
    controlFetch,
    intelFetch,
    askModes,
    defaultWorkspaceId,
    operatorUserId = null,
  } = deps;

  if (name === "meetless__kb_doc_detail") {
    try {
      const result = await runKbDocDetail(args || {}, {
        intelFetch,
        defaultWorkspaceId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              tool: "meetless__kb_doc_detail",
              error: String(err.message || err),
              status: err && err.status ? err.status : undefined,
            }),
          },
        ],
        isError: true,
      };
    }
  }

  if (name === "meetless__retrieve_knowledge") {
    try {
      const result = await runRetrieveKnowledge(args || {}, {
        intelFetch,
        defaultWorkspaceId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      // err is already masked by runRetrieveKnowledge for intel-side failures
      // (SEC-3.2); validation errors (empty query, bad limit) surface as-is so
      // the LLM can self-correct. Either way, no intel substrate leaks here.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              tool: "meetless__retrieve_knowledge",
              error: String(err.message || err),
              status: err && err.status ? err.status : undefined,
            }),
          },
        ],
        isError: true,
      };
    }
  }

  if (name === "meetless__relationship_verdict") {
    try {
      const result = await runVerdict(args || {}, {
        intelFetch,
        defaultWorkspaceId,
        defaultUserId: operatorUserId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              tool: "meetless__relationship_verdict",
              error: String(err.message || err),
            }),
          },
        ],
        isError: true,
      };
    }
  }

  if (name !== "meetless__query") {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  const mode = args?.mode || "answer";
  try {
    let result;
    if (mode === "answer") result = await askModes.runAnswer(args);
    else if (mode === "search") result = await askModes.runSearch(args);
    else if (mode === "canonical") result = await askModes.runCanonical(args);
    else if (mode === "compare") result = await askModes.runCompare(args);
    else if (mode === "relationships")
      result = await runRelationships(args, {
        intelFetch,
        defaultWorkspaceId,
      });
    else throw new Error(`unsupported mode: ${mode}`);

    // Echo the effective workspace on every result so the caller always sees
    // which corpus answered. §12.6: the MCP answers ONLY from the resolved
    // workspace (marker under `mla mcp`, or the env pin under the legacy bin);
    // there is no per-call workspace_id override. Surfacing it here makes silent
    // workspace drift between ingest and answer impossible to miss.
    if (result && typeof result === "object") {
      result.workspace = defaultWorkspaceId;
      // The relationships queue is the claim-grain RelationAssertion backlog
      // (intel), the same trust model Ask serves and relationship_verdict acts
      // on. Restate the lifecycle so a reader never mistakes a PENDING row for a
      // served edge: a born-PENDING assertion is review-visible only; serving
      // requires an ACCEPTED verdict, recorded via meetless__relationship_verdict
      // with the row's assertionId.
      if (mode === "relationships") {
        result.review_policy =
          "Rows are born-PENDING RelationAssertions (claim-grain) awaiting human review: " +
          "review-visible only, NOT yet serving. Accept/reject one with " +
          "meetless__relationship_verdict using its assertionId; Ask grounds on ACCEPTED assertions.";
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode,
            error: String(err.message || err),
            warnings: ["meetless__query encountered an error; falling back to grep is OK"],
          }),
        },
      ],
      isError: true,
    };
  }
}

// ---------- Server factory ---------------------------------------------------
//
// Builds a configured MCP Server from injected deps. Reads NO env. The INDEX.md
// matcher and the four ask-mode handlers are built here from the env-free deps
// (intelAsk closure + notesRoot) so the dispatch stays pure.
//
// deps = {
//   controlFetch, intelFetch,        // env-free fetch closures (control + intel)
//   intelAsk,                         // env-free /v1/ask closure (ask_modes shape)
//   defaultWorkspaceId,               // the effective workspace for this server
//   notesRoot,                        // INDEX.md root for canonical resolution
//   operatorUserId?,                  // verdict actorUserId default (optional)
// }
/**
 * Wrap a CallTool result with a staleness hint. `staleCheck` is an optional
 * per-call probe (see the cli's makeMcpStaleCheck): it returns a one-line warning
 * when THIS long-lived server now runs code older than the build on disk, else
 * null. When it returns a non-empty string, we PREPEND it as a text block so the
 * operator sees inline that the answer came from stale code (Node never hot-
 * reloads dist; this is the footgun behind the "This operation was aborted"
 * reports). It is fail-open by construction: no probe, a null/empty result, a
 * throwing probe, or a result without a content[] all pass the result through
 * untouched. A staleness hint must never corrupt or block a real tool response.
 */
export function withStalenessWarning(result, staleCheck) {
  if (typeof staleCheck !== "function") return result;
  let warning;
  try {
    warning = staleCheck();
  } catch {
    return result;
  }
  if (!warning || typeof warning !== "string") return result;
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: [{ type: "text", text: warning }, ...result.content] };
}

/**
 * The self-heal decision: should a SUPERVISED child reload itself right now?
 * Only when it is idle (no tool call mid-execution) AND the staleness probe
 * reports a newer build on disk. The in-flight gate is the safety contract: a
 * reload must never abort a request that is already running. Fails open: a
 * missing or throwing probe returns false so the poller can never crash the
 * server or reload on a phantom signal.
 */
export function shouldRestartForStaleness({ inFlight, staleCheck }) {
  if (inFlight > 0) return false;
  if (typeof staleCheck !== "function") return false;
  try {
    return Boolean(staleCheck());
  } catch {
    return false;
  }
}

/**
 * Track in-flight tool calls and decide reloads against that count. `track(fn)`
 * wraps a tool execution so the count is accurate even when the handler throws;
 * `tick()` is the idle poll the scheduler runs, firing onStaleRestart only when
 * shouldRestartForStaleness says it is safe. Used ONLY when a parent supervisor
 * can respawn this worker; a bare server never builds one.
 */
export function createStaleRestartPoller({ staleCheck, onStaleRestart }) {
  let inFlight = 0;
  return {
    async track(fn) {
      inFlight++;
      try {
        return await fn();
      } finally {
        inFlight--;
      }
    },
    tick() {
      if (shouldRestartForStaleness({ inFlight, staleCheck })) onStaleRestart();
    },
  };
}

// Default poll scheduler: a self-unref'd interval so the loop never keeps the
// process alive on its own. Injected in tests to capture the poll fn directly.
function defaultSchedule(fn, ms) {
  const timer = setInterval(fn, ms);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

// How often the supervised child checks whether a newer build has landed. Small
// enough that a rebuild self-heals within seconds, large enough to be free.
const DEFAULT_STALE_POLL_MS = 3000;

// ---------- Inactive (status-only) front door -------------------------------
//
// When `mla mcp` boots in a directory that is not activated, not logged in, or
// whose marker is broken, it still completes the MCP handshake (so Claude Code
// shows a CONNECTED server, never a misleading red "failed to connect") but
// advertises ONLY this status tool and performs NO backend requests. The CLI
// builds the InactiveStatus struct (reason + message + action) and passes it as
// deps.status; this module just renders it. Active runs are anything WITHOUT
// `mode === "inactive"`, including the legacy env path (which carries no mode),
// so existing behavior is untouched.
const INACTIVE_STATUS_TOOL = {
  name: "meetless__status",
  description:
    "Report why Meetless is inactive in this repository and how to enable it. " +
    "Meetless injects no knowledge here until activated; call this for the exact " +
    "reason and the next step.",
  inputSchema: { type: "object", properties: {} },
};

function renderInactiveStatus(status) {
  const lines = [status.message, "", `Next step: ${status.action.command}`];
  // The action already points at doctor for the invalid-marker case; only add
  // the diagnosis line when it is not already the next step.
  if (status.action.command !== "mla doctor") {
    lines.push("For a full diagnosis: mla doctor");
  }
  return lines.join("\n");
}

function inactiveStatusResult(status) {
  return { content: [{ type: "text", text: renderInactiveStatus(status) }] };
}

function createInactiveServer(status) {
  const server = new Server(
    { name: "meetless-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [INACTIVE_STATUS_TOOL],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === INACTIVE_STATUS_TOOL.name) {
      return inactiveStatusResult(status);
    }
    // Do NOT return status for an arbitrary tool name: in inactive mode an
    // unknown tool is a real error, not a silent fallback to the status text.
    throw new Error(`Unknown tool: ${request.params.name}`);
  });
  return server;
}

export function createMcpServer(deps) {
  // Inactive (status-only) front door: a KNOWN not-activated / not-authenticated
  // / invalid-activation state. Complete the handshake, advertise only the status
  // tool, touch no backend. Anything else (incl. the legacy env path, which has
  // no `mode`) is an active server, unchanged below.
  if (deps && deps.mode === "inactive") {
    return createInactiveServer(deps.status);
  }
  const {
    controlFetch,
    intelFetch,
    intelAsk,
    defaultWorkspaceId,
    notesRoot,
    operatorUserId = null,
    // Per-call staleness probe (cli wires makeMcpStaleCheck()). Optional: the
    // legacy buildDepsFromEnv path leaves it undefined, so the wrap is a no-op.
    staleCheck = null,
    // Self-heal hook for a supervised child: when present, an idle poller calls
    // it once staleCheck reports a newer build, and the cli exits with the
    // restart sentinel so the parent respawns a fresh worker. Absent (null) for
    // a bare / kill-switched run, which only warns inline via withStalenessWarning.
    onStaleRestart = null,
    staleCheckIntervalMs = DEFAULT_STALE_POLL_MS,
    schedule = defaultSchedule,
  } = deps;

  // §6.8.2 / §12.2.1: fail loudly if the read-only evidence manifest and the
  // mutating tool registry ever overlap. The read-only claim is a boundary.
  assertReadOnlyManifest();

  const matchCanonical = makeMatchCanonical({ notesRoot });
  const { runAnswer, runSearch, runCanonical, runCompare } = makeAskModes({
    intelAsk,
    defaultWorkspaceId,
    matchCanonical,
    statusFallback,
  });
  const askModes = { runAnswer, runSearch, runCanonical, runCompare };

  const dispatchDeps = {
    controlFetch,
    intelFetch,
    askModes,
    defaultWorkspaceId,
    operatorUserId,
  };

  const server = new Server(
    { name: "meetless-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Only a supervised child self-heals: it can be respawned, so it tracks
  // in-flight calls and reloads when idle. A bare server has no parent to come
  // back to, so it skips the poller and relies on the inline staleness warning.
  const poller = onStaleRestart
    ? createStaleRestartPoller({ staleCheck, onStaleRestart })
    : null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Wrap under the poller so a reload can never fire mid-request.
    const run = () => dispatchTool(name, args, dispatchDeps);
    const result = poller ? await poller.track(run) : await run();
    return withStalenessWarning(result, staleCheck);
  });

  if (poller) schedule(() => poller.tick(), staleCheckIntervalMs);

  return server;
}

/**
 * Build a server from injected deps and serve it over stdio. Resolves only when
 * the client disconnects (stdin EOF / transport close), NOT right after connect.
 * `mla mcp` awaits this, and its entrypoint calls process.exit() on resolve, so
 * resolving early would tear the server down mid-session. The legacy
 * `meetless-mcp` bin (which never exits on resolve) is unaffected.
 *
 * Why we listen on stdin ourselves: the MCP SDK's StdioServerTransport wires
 * only stdin "data" and "error", never "end"/"close". So when a client
 * disconnects the normal way (it closes the pipe, sending EOF, without an
 * in-band shutdown), server.onclose never fires and this await would hang
 * forever. The worker then blocks as an orphan reparented to pid 1, which is
 * exactly the process leak we chase in notes/20260622-mla-mcp-process-leak-
 * findings-and-fix.md. Adding the missing EOF -> shutdown edge here makes the
 * worker exit the instant its stdin closes, the primary reap path that does not
 * depend on the parent-death watchdog (which an intervening volta shim defeats,
 * since the shim, not the worker, becomes the pid-1 orphan).
 */
export async function runStdioServer(deps) {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Explicit transport close (in-band client shutdown).
    server.onclose = finish;
    // Pipe-close EOF: the client went away without an in-band shutdown. "end"
    // fires when no more data will arrive (last writer gone); "close" when the
    // fd itself is gone; "error" covers an EPIPE/ECONNRESET on the read side.
    const stdin = process.stdin;
    stdin.once("end", finish);
    stdin.once("close", finish);
    stdin.once("error", finish);
  });
  return server;
}

// ---------- Legacy env path (the `meetless-mcp` bin) -------------------------
//
// Reads env and builds createMcpServer deps from a shared service key. ONLY used
// when this file is run directly; importing it (e.g. from `mla mcp`) has no env
// side effect.
export function buildDepsFromEnv(env = process.env) {
  const workspaceId = env.MEETLESS_WORKSPACE_ID;
  // OSS-facing env names win; legacy names kept as fallbacks for existing configs.
  const intelBaseUrl =
    env.MEETLESS_INTEL_URL || env.INTEL_BASE_URL || "http://127.0.0.1:8100";
  const controlBaseUrl =
    env.MEETLESS_BACKEND_URL || env.CONTROL_BASE_URL || "http://127.0.0.1:3006";
  const controlToken = env.MEETLESS_CONTROL_TOKEN || env.INTERNAL_API_KEY;
  const operatorUserId = env.MEETLESS_OPERATOR_USER_ID || null;
  const notesRoot =
    env.MEETLESS_NOTES_ROOT ||
    path.resolve(__dirname, "..", "..", "..", "notes");

  if (!workspaceId) {
    console.error("[meetless-mcp] MEETLESS_WORKSPACE_ID env var required");
    process.exit(2);
  }
  if (!controlToken) {
    console.error(
      "[meetless-mcp] MEETLESS_CONTROL_TOKEN env var required (legacy alias INTERNAL_API_KEY also accepted)",
    );
    process.exit(2);
  }

  return {
    controlFetch: makeControlFetch({ baseUrl: controlBaseUrl, apiKey: controlToken }),
    // intelFetch reuses the same control token (Rule 5: one bearer for
    // /internal/v1 across services).
    intelFetch: makeIntelFetch({ baseUrl: intelBaseUrl, apiKey: controlToken }),
    intelAsk: makeIntelAsk({ intelBaseUrl, apiKey: controlToken }),
    defaultWorkspaceId: workspaceId,
    notesRoot,
    operatorUserId,
  };
}

// Auto-run ONLY when executed directly as the `meetless-mcp` bin, never on
// import (so `mla mcp` can dynamic-import this module without side effects).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  runStdioServer(buildDepsFromEnv()).catch((err) => {
    console.error("[meetless-mcp] fatal:", err);
    process.exit(1);
  });
}
