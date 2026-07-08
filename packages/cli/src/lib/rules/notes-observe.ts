import { buildObservedNotesRuleSpec, selectNotesLocationDirective } from "./notes-rule";
import {
  ObservationOutcome,
  ObserveAdapterConfig,
  ObserveHookResponse,
  observePreToolUse,
} from "./observe-adapter";
import { NotesPathScope, classifyTargetPath } from "./notes-path";
import { PathClassification } from "./types";
import { Directive } from "../scanner/types";

// R0 Slice 3: the observe-only notes-location pipeline. It connects the local
// directive scan cache to the pure rule layer (selector + four-state evaluator +
// notes-path classifier) through the observe-only adapter, and returns BOTH the
// decision-free hook response (always `{}`) and the in-process ObservationOutcome.
//
// Invariants this layer preserves (the adapter guarantees them per call; this
// layer must not weaken them):
//   - It NEVER emits a permissionDecision and NEVER denies/asks. Observe-only.
//   - It performs NO network call. The only I/O is the local-filesystem path
//     classifier, bounded by the adapter's hard timeout.
//   - An infrastructure problem (malformed input, a misconfigured pilot, a timeout)
//     surfaces as INFRA, never as a VIOLATION.
//   - It persists NOTHING. The ObservationOutcome is an in-process value; a later
//     slice gives it a durable destination once the schema/identity contract lands.

export interface NotesObserveInput {
  /** The raw PreToolUse payload: the JSON string from stdin, or an already-parsed object. */
  rawStdin: unknown;
  /** The scanned directives (the scan cache's `directives`), the source of the pilot rule. */
  directives: Directive[];
  /** The activated runtime project root (absolute). Relative targets resolve from here. */
  runtimeProjectRoot: string;
  /**
   * Injectable path classifier. Defaults to the real notes-path matcher (no
   * network I/O). Left open for callers that need a deterministic classification
   * without touching the filesystem; the end-to-end tests use the real one.
   */
  classify?: (rawFilePath: unknown, scope: NotesPathScope) => Promise<PathClassification>;
  /** Hard evaluation timeout in milliseconds. Defaults to the adapter's 500ms. */
  timeoutMs?: number;
}

export interface NotesObserveResult {
  response: ObserveHookResponse;
  observation: ObservationOutcome;
}

const NO_DECISION: ObserveHookResponse = {};

/**
 * Observe a single PreToolUse call against the notes-location pilot. Selects the
 * pilot directive from the scan cache, normalizes it into an ObservedRuleSpec,
 * derives the runtime forbidden-root scope, and hands the call to the observe-only
 * adapter. Always returns an empty (decision-free) response; the verdict travels on
 * the observation side channel.
 */
export async function observeNotesRule(input: NotesObserveInput): Promise<NotesObserveResult> {
  // No notes-location rule declared in this workspace: nothing to observe. This is
  // genuinely NOT_APPLICABLE (absence of a rule), not an infrastructure fault.
  const directive = selectNotesLocationDirective(input.directives);
  if (!directive) {
    return { response: NO_DECISION, observation: { kind: "NOT_APPLICABLE" } };
  }

  const built = buildObservedNotesRuleSpec(directive);
  if (!built.ok) {
    return { response: NO_DECISION, observation: { kind: "INFRA", diagnostic: built.diagnostic } };
  }

  const notesScope: NotesPathScope = {
    canonicalProjectRoot: input.runtimeProjectRoot,
    configuredRelativeForbiddenPath: built.spec.forbiddenRootRelativePath,
  };

  const config: ObserveAdapterConfig = {
    applicability: built.spec.applicability,
    notesScope,
    classify: input.classify ?? classifyTargetPath,
    timeoutMs: input.timeoutMs,
  };

  // The adapter runs selection + compliance evaluation and always returns
  // `response: {}`. We pass its result straight through.
  return observePreToolUse(input.rawStdin, config);
}
