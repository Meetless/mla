// The run's HANDLED-failure declaration: one process-level slot a command fills when it
// fails on purpose, read once by finalize.
//
// Why it exists: classifyOutcome can only classify what it is given, and a handled failure
// gives it nothing. A command that returns non-zero WITHOUT throwing (every `failInMode`
// call site, plus the enrich-ingest exit-1) reaches finalize as a bare exit code, so the
// whole handled surface of the CLI collapsed into one undiagnosable bucket: outcome
// `user_error`, error_class `null`. The call site always knew its reason (failInMode has
// carried a class token as its `code` argument all along), but that token went into the
// machine envelope only, so in human mode (the overwhelming majority of runs) it was
// dropped on the floor. A prod workspace burned three `enrich ingest` attempts and left
// nothing behind to say why.
//
// An ambient rather than a return value: the exit code travels up through many layers
// (helpers returning `{ok:false, exitCode}`, dispatch, the registry), and threading a
// second value through every one of them to reach finalize would touch far more code than
// the defect is worth. This mirrors the `machineCommand` ambient in machine-output.ts,
// including its lifecycle: cli.ts resets it at bootstrap and reads it at finalize.
import type { CommandOutcome } from "./envelope";

export interface HandledFailure {
  /** A stable snake_case class token (NEVER a message). Shape-guarded in classifyOutcome. */
  error_class: string;
  /** Defaults to `user_error` at classification: a handled failure is the user's to act on
   *  unless the call site says otherwise (an infra fault declares `system_error`). */
  outcome?: CommandOutcome;
  retryable?: boolean;
}

let declared: HandledFailure | null = null;

/**
 * Declare why this run is about to fail. FIRST declaration wins: the proximate cause is the
 * most diagnostic one, and a coarser outer handler must not overwrite it on the way up.
 */
export function noteHandledFailure(failure: HandledFailure): void {
  if (declared === null) declared = failure;
}

export function getHandledFailure(): HandledFailure | null {
  return declared;
}

export function resetHandledFailure(): void {
  declared = null;
}
