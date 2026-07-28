// The ONLY module in the CLI allowed to name an outbound network primitive.
//
// `test/lib/egress-ownership.spec.ts` enforces that: it greps production source
// for `fetch(`, `globalThis.fetch`, `undici`, `node:http`, `node:https`, `axios`
// and `curl`, and fails on any hit outside this file. That test is the reason
// the boundary cannot be forgotten rather than merely documented, and it is what
// caught the seam this whole exercise nearly missed: lib/turn-recap-emit.ts
// POSTed a body to intel through an INJECTED fetch-like, so it was invisible to
// a `\bfetch\(` sweep while being a real, unclassified egress.
//
// Every request routes through egressFetch, which serializes the body ITSELF
// after the policy has rewritten it. Callers hand over a parsed value and never
// a pre-stringified one, so there is no way to compute the wire bytes before the
// boundary has seen them.

import {
  applyEgressPolicy,
  EgressPolicyError,
  EgressService,
  normalizePathname,
} from "./policy";
import { EGRESS_RULES } from "./rules";

export { EgressPolicyError, EgressService };

/** Verbs that carry a body and therefore must resolve a rule. */
const BODY_VERBS = new Set(["POST", "PATCH", "PUT"]);

/**
 * A socket. NOT a policy seam.
 *
 * Callers may substitute where the bytes GO (tests capture them; the turn-recap
 * emitter injects one). Nobody may substitute WHAT the bytes are: the registry
 * runs before this is called, every time, and there is no argument that skips
 * it. This is the §1 distinction that the old `redactFn` parameter got wrong.
 * A test that wants to prove redaction reads the body this receives.
 */
// Generic in the response so a caller with a narrower structural fetch shape
// (turn-recap-emit's FetchLike) can hand one over without widening to the DOM
// Response type.
export type EgressSocket<R> = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<R>;

export interface EgressRequest<R = Response> {
  method: string;
  headers?: Record<string, string>;
  /** A PARSED value. Never a JSON string: the boundary serializes. */
  body?: unknown;
  signal?: AbortSignal;
  /** Override the socket only. The policy above still runs unconditionally. */
  socket?: EgressSocket<R>;
}

/**
 * Send a request through the egress boundary.
 *
 * Throws EgressPolicyError BEFORE any socket is opened when the route is
 * unregistered, ambiguous, blocked, or carries an unclassified top-level field.
 * Callers decide whether that is fatal: see the note on applyEgressPolicy.
 */
export async function egressFetch<R = Response>(
  service: EgressService,
  url: string,
  init: EgressRequest<R>,
): Promise<R> {
  const method = init.method.toUpperCase();
  const hasBody = init.body !== undefined && init.body !== null;

  let wireBody: string | undefined;
  if (hasBody) {
    if (!BODY_VERBS.has(method)) {
      // A GET or DELETE with a body is a contradiction the registry cannot
      // classify (no rule can have a non-body method), so refuse rather than
      // silently drop the body or silently send it.
      throw new EgressPolicyError(
        "no_rule",
        service,
        method,
        normalizePathname(url),
        `${method} must not carry a body`,
      );
    }
    const sanitized = applyEgressPolicy(
      EGRESS_RULES,
      service,
      method,
      url,
      init.body,
    );
    wireBody = JSON.stringify(sanitized);
  }

  const socket =
    init.socket ??
    ((u: string, i: unknown) => fetch(u, i as RequestInit) as Promise<R>);
  return await socket(url, {
    method,
    headers: init.headers ?? {},
    body: wireBody as string,
    signal: init.signal as AbortSignal,
  });
}
