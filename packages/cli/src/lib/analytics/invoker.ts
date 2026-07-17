// The `invoker` telemetry dimension (§4.11 of
// notes/20260715-mla-the-agent-is-the-only-executor.md). One closed enum, the same
// shape as the existing `source`, recording WHO ran this command. It is derived
// from EXECUTION CONTEXT only, never from argv, so it cannot touch INV-ARGV-1 and a
// spoofed flag can never move it. It lands on the local `mla_command` event and
// forwards to control on the existing wire; central (PostHog) visibility is a
// separate, explicitly deferred control-side change (§4.11), so the CLI ships the
// local observation only.
//
// Why observe this at all: the wedge fix (the agent is the only executor) closes the
// leak on OUR printed surface, but docs, blog posts, and muscle memory still hand
// humans bare `mla` commands (§7). Splitting agent traffic from human traffic sizes
// how much of the remaining leak is ours versus inherited. That split is the whole
// value, and only the resolver's env transport marks the agent, so the derivation
// leans on that one reliable signal and stays conservative everywhere else.

import { isCI } from "../update-check";
import { Invoker } from "./envelope";

// Who invoked this run. `Invoker` is the closed enum ratified in §4.11, defined once
// in envelope.ts (INVOKERS) alongside the other payload enums so the privacy boundary
// can validate its membership. Only `agent`, `ci`, and `human_tty` are emitted by the
// top-level command-event path today:
//   - `agent`     the coding agent, via resolve-mla's `MEETLESS_OUTPUT=json` transport.
//   - `ci`        a headless run under a standard CI marker (never the agent).
//   - `human_tty` the residual human bucket (a person running mla directly).
//   - `hook`      RESERVED. A hook-spawned mla run is an `_internal` subcommand, which
//                 capture.ts drops from the `mla_command` funnel BEFORE this dimension
//                 is read, so a hook never reaches an emitted command event today.
//   - `mcp`       RESERVED. `mla mcp` is the long-lived stdio daemon the output-mode
//                 bootstrap structurally excludes; it does not emit per-command events.
// The two reserved members keep the wire enum complete so a future command-emitting
// hook/mcp path can set them without a schema bump.
export type { Invoker };

export interface InvokerContext {
  /**
   * `MEETLESS_OUTPUT` captured at bootstrap, BEFORE containment deletes it (§4.10).
   * resolve-mla sets it to "json" on the agent path and nothing else sets it, so it
   * is the one reliable agent marker. This MUST be the captured value, not a live
   * `process.env` read: by the time a command finalizes, the variable is gone.
   */
  requestedOutput: string | undefined;
  /** Process env, read for the standard CI markers only. Never argv. */
  env: NodeJS.ProcessEnv;
}

/**
 * Derive the invoker from execution context. Pure. Order is significant: the agent
 * marker is checked first because separating agent from human is the entire point,
 * and a run that carries the resolver transport IS the agent regardless of anything
 * else. Anything without that marker is never labelled the agent, so the dimension
 * cannot over-count agent traffic.
 *
 * TTY is deliberately NOT a signal. The closed enum has one human bucket, `human_tty`,
 * and no separate value for a non-interactive human script, so a human run collapses
 * to `human_tty` whether or not a terminal is attached; checking `isTTY` could not
 * change the classification.
 */
export function deriveInvoker(ctx: InvokerContext): Invoker {
  if (ctx.requestedOutput === "json") return "agent";
  if (isCI(ctx.env)) return "ci";
  return "human_tty";
}
