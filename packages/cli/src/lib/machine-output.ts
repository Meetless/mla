/**
 * Machine-output mode: the CLI's second voice, for the agent that orchestrates it.
 *
 * The CLI has one output surface today (human prose on stdout) read by two very
 * different consumers: a person at a terminal, and a coding agent that must parse
 * what it gets. This module gives the CLI a second, machine voice, requested
 * explicitly over an env-var transport (`MEETLESS_OUTPUT=json`, set by
 * `resolve-mla`) or the strict developer flag (`--output=json`). See
 * `notes/20260715-mla-the-agent-is-the-only-executor.md` §4.1-§4.2, §4.10.
 *
 * Under machine mode, stdout is a SINGLE well-formed JSON envelope and nothing
 * else; stderr is silent for expected progress (the Bash tool merges the two
 * streams, so a stray stderr line would corrupt the agent's parse, §4.2/§A5).
 *
 * This is the PURE half: constants, the envelope types, the module-level mode
 * singleton (with `resetOutputMode()` for tests, §4.10 bar 2), the flag helpers,
 * central precedence resolution, and the single envelope emitter. The dispatch
 * wiring (env containment, capability resolution) lives in cli.ts next to the
 * choke point it guards.
 */

import { getRunTraceId } from "./observability";

/** The protocol discriminator. The connector recognizes an envelope only by a
 * FULL-schema match, never by "JSON.parse succeeded" (§4.2), and this constant
 * is the first thing it checks. Do NOT reword. */
export const MACHINE_PROTOCOL = "mla.cli.output" as const;

/** The envelope schema version. Bump only on a breaking envelope-shape change. */
export const MACHINE_SCHEMA_VERSION = 1 as const;

/**
 * The one closed control transition the envelope can carry (§4.8). Both fields
 * are closed enums with a single value each today; the connector NEVER executes
 * an unknown value, it reports an unsupported protocol action and stops. There
 * are no shell-command strings here, ever; it names a skill.
 */
export interface NextAction {
  kind: "skill";
  ref: "onboard";
}

/**
 * A typed, deterministically executable selection for a `decision_request`
 * (§4.5). Closed per kind; carries NO shell command. The connector adapter maps
 * the chosen selection to CLI arguments. `none` performs no mutation. (Phase 3
 * consumer; the types live here so the envelope shape is defined in one place.)
 */
export type DecisionSelection =
  | { mode: "all" }
  | { mode: "only"; candidate_ids: string[] }
  | { mode: "none" };

/** One option the human may pick in a `decision_request`. */
export interface DecisionOption {
  id: string;
  label: string;
  selection: DecisionSelection;
}

/**
 * Ephemeral control data emitted BEFORE a mutation (§4.5, §4.6). Not the
 * completed transcript (that stays hook-owned). `kind` is a closed enum; Phase 3
 * ships only enrichment acceptance.
 */
export interface DecisionRequest {
  kind: "enrich.accept";
  subject: { run_id: string };
  prompt: string;
  options: DecisionOption[];
}

/** The error body: a machine-readable code, a human message, and the run's trace id. */
export interface MachineErrorBody {
  code: string;
  message: string;
  trace_id: string;
}

export interface SuccessEnvelope {
  protocol: typeof MACHINE_PROTOCOL;
  schema_version: typeof MACHINE_SCHEMA_VERSION;
  command: string;
  ok: true;
  /** The operation's payload. May be a top-level array (`rules list`, §4.4). Untrusted by the connector. */
  result: unknown;
  next_action?: NextAction;
  decision_request?: DecisionRequest;
  /** Product-authored convenience prose the agent MAY relay. Never a command. */
  human_summary?: string;
}

export interface ErrorEnvelope {
  protocol: typeof MACHINE_PROTOCOL;
  schema_version: typeof MACHINE_SCHEMA_VERSION;
  command: string;
  ok: false;
  error: MachineErrorBody;
}

export type MachineEnvelope = SuccessEnvelope | ErrorEnvelope;

// ---------------------------------------------------------------------------
// Mode singleton (§4.10). One process per invocation in production; `mcp` is
// structurally excluded, so the single long-lived in-process consumer never
// enters the mode. Tests reset between runs via resetOutputMode().
// ---------------------------------------------------------------------------

export type OutputMode = "human" | "machine-best-effort" | "machine-strict";

let outputMode: OutputMode = "human";

export function getOutputMode(): OutputMode {
  return outputMode;
}

export function setOutputMode(mode: OutputMode): void {
  outputMode = mode;
}

export function resetOutputMode(): void {
  outputMode = "human";
}

/** True in either machine mode (best-effort or strict). */
export function isMachineMode(): boolean {
  return outputMode !== "human";
}

// ---------------------------------------------------------------------------
// The resolved operation id becomes the envelope's `command`. Capability
// resolution (dispatch side) sets it; converted handlers read it back so the
// envelope command and the resolved operation can never drift.
// ---------------------------------------------------------------------------

let machineCommand: string | null = null;

export function getMachineCommand(): string | null {
  return machineCommand;
}

export function setMachineCommand(command: string): void {
  machineCommand = command;
}

export function resetMachineCommand(): void {
  machineCommand = null;
}

// ---------------------------------------------------------------------------
// Flag helpers. Only `--output=json` activates strict machine mode; every other
// `--output=<value>` is stripped centrally and treated as human (§4.1), so no
// `--output=` token ever reaches a command's strict argv parser (which would
// throw on the unknown flag, the very crash the env-var transport avoids).
// ---------------------------------------------------------------------------

export const OUTPUT_FLAG_PREFIX = "--output=";

/** The value of the first `--output=<value>` token, or null if none is present. */
export function outputFlagValue(argv: string[]): string | null {
  const hit = argv.find((a) => a.startsWith(OUTPUT_FLAG_PREFIX));
  return hit === undefined ? null : hit.slice(OUTPUT_FLAG_PREFIX.length);
}

export function hasOutputFlag(argv: string[]): boolean {
  return argv.some((a) => a.startsWith(OUTPUT_FLAG_PREFIX));
}

/** argv with every `--output=<value>` token removed. Stripped centrally in the
 * bootstrap before dispatch so the flag never reaches a handler's parser. */
export function stripOutputFlag(argv: string[]): string[] {
  return argv.filter((a) => !a.startsWith(OUTPUT_FLAG_PREFIX));
}

/**
 * Central precedence (§4.1), defined once:
 *   1. `--output=json` present  -> strict machine mode.
 *   2. else `MEETLESS_OUTPUT=json` -> best-effort machine mode (legacy fallback).
 *   3. else -> human.
 * An `--output=<other>` value is not machine mode (human); it is still stripped
 * from argv by the bootstrap so it cannot crash a strict parser.
 */
export function resolveOutputMode(
  argv: string[],
  envValue: string | undefined,
): OutputMode {
  const flag = outputFlagValue(argv);
  if (flag !== null) {
    return flag === "json" ? "machine-strict" : "human";
  }
  if (envValue === "json") return "machine-best-effort";
  return "human";
}

// ---------------------------------------------------------------------------
// Envelope builders + the single emitter.
// ---------------------------------------------------------------------------

/** Optional control directives a success envelope may carry. At most one of
 * `nextAction` / `decisionRequest` (§4.2); the builder throws if both are set. */
export interface SuccessControl {
  nextAction?: NextAction;
  decisionRequest?: DecisionRequest;
  humanSummary?: string;
}

export function successEnvelope(
  command: string,
  result: unknown,
  control: SuccessControl = {},
): SuccessEnvelope {
  if (control.nextAction && control.decisionRequest) {
    throw new Error(
      "machine envelope may carry at most one of next_action / decision_request",
    );
  }
  const env: SuccessEnvelope = {
    protocol: MACHINE_PROTOCOL,
    schema_version: MACHINE_SCHEMA_VERSION,
    command,
    ok: true,
    result,
  };
  if (control.nextAction) env.next_action = control.nextAction;
  if (control.decisionRequest) env.decision_request = control.decisionRequest;
  if (control.humanSummary) env.human_summary = control.humanSummary;
  return env;
}

export function errorEnvelope(
  command: string,
  error: MachineErrorBody,
): ErrorEnvelope {
  return {
    protocol: MACHINE_PROTOCOL,
    schema_version: MACHINE_SCHEMA_VERSION,
    command,
    ok: false,
    error,
  };
}

/**
 * Emit the single `unsupported_output_mode` error envelope for a STRICT
 * (`--output=json`) request against an operation that has no machine emitter
 * (§4.3), and return exit code 2. Best-effort env mode never reaches this; it
 * falls back to the legacy human path instead.
 */
export function emitUnsupportedOutputMode(command: string): number {
  return emitEnvelope(
    errorEnvelope(command, {
      code: "unsupported_output_mode",
      message: `machine output is not supported for \`${command}\``,
      trace_id: getRunTraceId() ?? "",
    }),
    2,
  );
}

/**
 * Emit the envelope as the process's single stdout document and return the
 * process exit code. Asserts the one invariant that keeps `ok` and the exit code
 * from drifting (§4.2): `ok === (exitCode === 0)`. A violation is a programmer
 * error at the call site, not a runtime condition, so it throws.
 */
export function emitEnvelope(env: MachineEnvelope, exitCode: number): number {
  if (env.ok !== (exitCode === 0)) {
    throw new Error(
      `machine envelope ok=${env.ok} contradicts exit code ${exitCode}`,
    );
  }
  process.stdout.write(`${JSON.stringify(env)}\n`);
  return exitCode;
}

/**
 * Emit an error envelope for a failed operation when in machine mode; otherwise
 * fall back to the caller's existing human behavior (write `message` to stderr
 * and return `exitCode`), byte for byte. This is the drop-in replacement for the
 * ubiquitous `console.error(msg); return N;` inside a converted handler, so a
 * failure exit becomes a single error envelope under machine mode and stays
 * unchanged for humans. The trace id is the run's own (or empty when absent).
 */
export function failInMode(
  command: string,
  code: string,
  message: string,
  exitCode: number,
): number {
  if (isMachineMode()) {
    return emitEnvelope(
      errorEnvelope(command, { code, message, trace_id: getRunTraceId() ?? "" }),
      exitCode,
    );
  }
  console.error(message);
  return exitCode;
}
