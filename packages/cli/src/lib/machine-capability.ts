/**
 * Machine-output capability: which normalized operations can emit an envelope.
 *
 * Support is per OPERATION, not per top-level command (§4.3): `enrich plan` may
 * be converted while `enrich accept`'s mutation form is not, so a single boolean
 * on the `enrich` registry entry cannot tell the truth. No family has a
 * subcommand table (every subcommand route is control flow, not data), so this
 * resolves capability in two steps at the single dispatch choke point, before
 * any handler emits output:
 *
 *   1. resolveOperation(command, argv): OperationId | null  -- normalize the
 *      canonical top-level command name plus its arguments to a canonical
 *      operation id (the same value the envelope's `command` field carries).
 *   2. supportsMachineOutput(op): boolean  -- look that id up in the capability set.
 *
 * The resolver is CONSERVATIVE: it returns a known operation only when the
 * argument shape is unambiguous, and null for anything unknown, malformed, or
 * ambiguous. On null, best-effort env mode falls back to the legacy handler and
 * strict flag mode returns `unsupported_output_mode`. This is NOT a second
 * command registry and NOT a general router; it identifies only the operations
 * needed for output capability.
 */

/**
 * A canonical operation id. Doubles as the envelope `command` field. The `.apply`
 * variant of an authority operation is a distinct id so the read-only preview
 * (Phase 1) and the mutation (Phase 3) resolve independently by argv shape,
 * exactly as §A3.1 splits a list from its verdict.
 */
export type OperationId =
  | "activate"
  | "activate.repair"
  | "enrich.plan"
  | "enrich.ingest"
  | "enrich.accept"
  | "enrich.accept.apply";

/**
 * The operations with full machine-envelope coverage (§A6), grown one phase at a
 * time. Capability is enabled for an operation only after it can emit a valid
 * envelope for every exit; an unlisted operation falls back to human text in
 * best-effort mode and returns `unsupported_output_mode` in strict mode.
 *
 * - Phase 1 (onboarding read path): `activate` (plus its onboarding nudge),
 *   `enrich plan`, `enrich ingest`, and `enrich accept`'s read-only review form.
 * - Phase 3 (enrichment authority): `enrich accept`'s mutation form
 *   (`enrich.accept.apply`), which now carries the typed `decision_request`
 *   workflow (§4.5, §4.6) on its read-only preview and emits a result envelope on
 *   apply. No other authority operation is converted here.
 *
 * The mutation form of `activate` (the diagnostic `activate --repair`) is still
 * absent, deferred to Phase 4.
 */
// Exported so the §5.1 envelope-boundary guard can cross-check its per-operation
// coverage manifest against the authoritative capability set: adding a supported
// operation without a boundary driver makes that guard fail (scream-on-drift),
// which is the whole point of a guard that must find its subject.
export const SUPPORTED_OPERATIONS: ReadonlySet<OperationId> = new Set<OperationId>([
  "activate",
  "enrich.plan",
  "enrich.ingest",
  "enrich.accept",
  "enrich.accept.apply",
]);

export function supportsMachineOutput(op: OperationId): boolean {
  return SUPPORTED_OPERATIONS.has(op);
}

/**
 * `enrich accept` becomes a mutation the moment a selection flag is present
 * (`--all` / `--only` / `--only=<...>`); without one it is the read-only review.
 * This is the argv-shape split that keeps the review (Phase 1) and the apply
 * (Phase 3) as distinct operation ids (§4.6, §A3.1).
 */
function hasAcceptSelection(argv: string[]): boolean {
  return argv.some(
    (a) => a === "--all" || a === "--only" || a.startsWith("--only="),
  );
}

/**
 * Normalize a canonical top-level command plus its full argv (argv[0] is the
 * command word, as handlers receive it) to a canonical operation id, or null
 * when the shape is unknown or ambiguous.
 */
export function resolveOperation(
  command: string,
  argv: string[],
): OperationId | null {
  switch (command) {
    case "activate":
      // The diagnostic repair path is a different operation and is not converted.
      return argv.includes("--repair") ? "activate.repair" : "activate";
    case "enrich": {
      switch (argv[1]) {
        case "plan":
          return "enrich.plan";
        case "ingest":
          return "enrich.ingest";
        case "accept":
          return hasAcceptSelection(argv) ? "enrich.accept.apply" : "enrich.accept";
        default:
          return null;
      }
    }
    default:
      return null;
  }
}
