import { randomUUID } from "node:crypto";
import type { CliConfig } from "./config";
import type { HttpError, RefreshOutcome } from "./http";
import {
  get as controlGet,
  post as controlPost,
  patch as controlPatch,
  intelGet,
  intelPost,
  intelPatch,
  refreshUserToken,
} from "./http";

// Slice 1 of the `mla mcp` refactor. The MCP server's tool handlers
// (relationship_actions.js, kb_actions.js, evidence_actions.js, ask_modes.js)
// were deliberately written to be auth-agnostic: each takes an env-free fetch
// closure and never reads a token or workspace itself. Historically those
// closures were built over the shared service key + an env-pinned workspace.
//
// These adapters rebuild the same closures over http.ts instead, so the MCP
// authenticates as the logged-in human (user-token, auto-refreshing) exactly
// like the rest of `mla`. No service key, no MEETLESS_WORKSPACE_ID. The handler
// contract is unchanged:
//
//   controlFetch / intelFetch: async (pathAndQuery, init?) => parsedJson
//   intelAsk:                   async ({question, workspaceId, ...}) => parsedJson
//
// where init is undefined (GET), {method:"GET"}, or
// {method:"POST"|"PATCH", body: JSON.stringify(obj)}.

/** The fetch-closure contract the JS handlers consume. */
export type McpFetch = (
  pathAndQuery: string,
  init?: McpFetchInit,
) => Promise<unknown>;

export interface McpFetchInit {
  method?: string;
  // The handlers always JSON.stringify their body before calling. We parse it
  // back so http.ts (which re-stringifies) receives a plain object, never a
  // double-encoded string.
  body?: string;
}

// http.ts verbs, dependency-injected so the adapters are unit-testable without
// a live control/intel server. Defaults wire the real verbs. Results are typed
// `unknown` here (the adapters never narrow them); the real generic
// http.ts verbs (`get<T>` etc.) remain assignable to these signatures.
export interface HttpVerbs {
  get: (cfg: CliConfig, path: string, timeoutMs?: number) => Promise<unknown>;
  post: (
    cfg: CliConfig,
    path: string,
    body: unknown,
    timeoutMs?: number,
  ) => Promise<unknown>;
  patch: (
    cfg: CliConfig,
    path: string,
    body: unknown,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

type RefreshFn = (cfg: CliConfig) => Promise<RefreshOutcome>;

type IntelPostFn = (
  cfg: CliConfig,
  path: string,
  body: unknown,
  timeoutMs?: number,
) => Promise<unknown>;

// LLM answer synthesis at /v1/ask routinely runs 15+ seconds (retrieval plus
// generation), past intelPost's 15s default, which is sized for fast control
// and intel POSTs. Without its own deadline the AbortController fires mid-flight
// and the MCP query tool's answer mode returns "This operation was aborted".
// Give synthesis a generous timeout; override via env for slower models.
const ASK_SYNTHESIS_TIMEOUT_MS =
  Number(process.env.MEETLESS_ASK_TIMEOUT_MS) || 60_000;

const DEFAULT_CONTROL_VERBS: HttpVerbs = {
  get: controlGet,
  post: controlPost,
  patch: controlPatch,
};

const DEFAULT_INTEL_VERBS: HttpVerbs = {
  get: intelGet,
  post: intelPost,
  patch: intelPatch,
};

function parseBody(init?: McpFetchInit): unknown {
  if (!init || init.body === undefined) return undefined;
  return JSON.parse(init.body);
}

function dispatch(
  verbs: HttpVerbs,
  cfg: CliConfig,
  pathAndQuery: string,
  init?: McpFetchInit,
): Promise<unknown> {
  const method = (init?.method ?? "GET").toUpperCase();
  switch (method) {
    case "GET":
      return verbs.get(cfg, pathAndQuery);
    case "POST":
      return verbs.post(cfg, pathAndQuery, parseBody(init));
    case "PATCH":
      return verbs.patch(cfg, pathAndQuery, parseBody(init));
    default:
      throw new Error(`mcp-fetchers: unsupported method ${method}`);
  }
}

/**
 * Reactive single-retry refresh: control's verbs auto-refresh internally, but
 * intel's (intelGet/intelPost/intelPatch) do NOT. So for the intel surface we
 * wrap the call: on a 401 in user-token mode, rotate the token once
 * (refreshUserToken mutates cfg.controlToken in place) and retry. Any other
 * error, or a refresh that did not actually rotate ("expired"/"busy"), is
 * rethrown untouched so handlers can still read err.status (e.g. kb 404).
 */
async function withIntelRefresh<T>(
  cfg: CliConfig,
  refresh: RefreshFn,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = (err as HttpError)?.status;
    if (status === 401 && cfg.auth.mode === "user-token") {
      const outcome = await refresh(cfg);
      if (outcome === "refreshed") {
        return await fn();
      }
    }
    throw err;
  }
}

/** Control fetch closure over http.ts (auto-refreshing) bound to this cfg. */
export function makeControlFetchFromCli(
  cfg: CliConfig,
  verbs: HttpVerbs = DEFAULT_CONTROL_VERBS,
): McpFetch {
  return (pathAndQuery, init) => dispatch(verbs, cfg, pathAndQuery, init);
}

/** Intel fetch closure over http.ts with a reactive 401 refresh-and-retry. */
export function makeIntelFetchFromCli(
  cfg: CliConfig,
  verbs: HttpVerbs = DEFAULT_INTEL_VERBS,
  refresh: RefreshFn = refreshUserToken,
): McpFetch {
  return (pathAndQuery, init) =>
    withIntelRefresh(cfg, refresh, () =>
      dispatch(verbs, cfg, pathAndQuery, init),
    );
}

export interface IntelAskParams {
  question: string;
  workspaceId: string;
  mode?: string;
  filters?: Record<string, unknown>;
  maxResults?: number;
  minResults?: number;
  asOf?: string | null;
  threadText?: string | null;
  language?: string;
  surface?: string;
  /**
   * Per-tool-call delivery key. `mla mcp` mints one at the tool-call boundary and
   * passes it here; a direct CLI caller that mints nothing gets one minted below,
   * so a metered ask NEVER reaches admission without a key (Control requires the
   * delivery triple and denies a keyless spend).
   */
  submissionId?: string;
}

/**
 * /v1/ask closure, byte-compatible with ask_modes.js makeIntelAsk (same payload
 * keys + defaults: surface "mcp", mode "answer", filters {}, max 8 / min 3,
 * as_of omitted when absent/null), but posting through http.ts (intelPost) so it
 * carries the user-token bearer and inherits the same reactive refresh.
 */
export function makeIntelAskFromCli(
  cfg: CliConfig,
  intelPostFn: IntelPostFn = intelPost,
  refresh: RefreshFn = refreshUserToken,
): (params: IntelAskParams) => Promise<unknown> {
  return (params) => {
    const payload: Record<string, unknown> = {
      workspace_id: params.workspaceId,
      question: params.question,
      surface: params.surface ?? "mcp",
      stream: false,
      language: params.language ?? "en",
      thread_text: params.threadText ?? null,
      mode: params.mode ?? "answer",
      filters: params.filters ?? {},
      max_results: params.maxResults ?? 8,
      min_results: params.minResults ?? 3,
      // Minted once per closure CALL, outside the retry below on purpose: a 401
      // refresh re-posts the SAME body, so both attempts carry one key and collapse
      // onto one money authorization instead of buying the run twice.
      submission_id: params.submissionId ?? randomUUID(),
    };
    // Keep the body byte-identical to today when no cutoff is supplied.
    if (params.asOf !== undefined && params.asOf !== null) {
      payload.as_of = params.asOf;
    }
    return withIntelRefresh(cfg, refresh, async () => {
      try {
        return await intelPostFn(cfg, "/v1/ask", payload, ASK_SYNTHESIS_TIMEOUT_MS);
      } catch (err) {
        if (isSynthesisTimeout(err)) {
          throw synthesisTimeoutError();
        }
        throw err;
      }
    });
  };
}

/**
 * The deadline fired before synthesis returned. undici rejects an aborted fetch
 * with a DOMException named "AbortError" (message "This operation was aborted"),
 * which intelPost rethrows raw. We discriminate on the name, not the message.
 */
function isSynthesisTimeout(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/**
 * Replaces the cryptic raw "This operation was aborted" with a message that
 * names the failure and tells the operator what to do. Two real causes produce
 * this: intel synthesis genuinely ran long, OR this `mla mcp` server process was
 * spawned before the timeout fix landed and is running stale in-memory code
 * (Node does not hot-reload dist) — so "restart your editor" is a real remedy.
 */
function synthesisTimeoutError(): Error {
  const secs = Math.round(ASK_SYNTHESIS_TIMEOUT_MS / 1000);
  return new Error(
    `Meetless answer synthesis timed out after ${secs}s. Intel may be under ` +
      `load, or this MCP server process predates the timeout fix (restart your ` +
      `editor to respawn it). For an immediate result, use mode "search" or the ` +
      `retrieve_knowledge tool (no synthesis), or raise MEETLESS_ASK_TIMEOUT_MS.`,
  );
}
