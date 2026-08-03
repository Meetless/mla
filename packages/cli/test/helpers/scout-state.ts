import { SCOUT_NAMES, ScoutName, ScoutRunState } from "../../src/lib/enrichment/protocol";

/**
 * Build a TOTAL per-scout state record for an `OnboardingState` fixture.
 *
 * Fixtures used to hand-write `{ documentation: ..., history: ... }`, which is a two-key
 * object literal: adding a third role made every one of them describe a run in which the
 * new scout does not exist. Worse, before `OnboardingState.scouts` became a
 * `Record<ScoutName, ...>` those literals compiled fine, so the fixtures would have gone
 * on passing while asserting a roster the product no longer has.
 *
 * Named roles override. Every other role in SCOUT_NAMES takes `fallback`, so a new scout
 * joins each fixture with a defined, deliberate state rather than by being lumped in with
 * whichever role happened to be last.
 */
export function scoutStates(
  overrides: Partial<Record<ScoutName, ScoutRunState>>,
  fallback: ScoutRunState = { status: "complete", candidateCount: 0 },
): Record<ScoutName, ScoutRunState> {
  return Object.fromEntries(SCOUT_NAMES.map((role) => [role, overrides[role] ?? fallback])) as Record<
    ScoutName,
    ScoutRunState
  >;
}

/**
 * Complete the roster of an `ingestRun` results array.
 *
 * A run reaches `status: "complete"` only when EVERY role in SCOUT_NAMES is complete, so a
 * test that hand-lists two results and asserts "complete" is really asserting the roster
 * size. Appending an empty complete envelope for each unnamed role states the intent that
 * such a test actually has ("the scouts under test finished, nothing else is outstanding")
 * without pinning the roster.
 *
 * Zero candidates with status `complete` is a genuinely finished scout, not a stranded one:
 * completion keys off `received > 0 && accepted === 0`, so an empty envelope lands complete.
 * Use this ONLY where the extra role is beside the point. A test about capacity, ordering,
 * or per-role behavior should name every role it depends on.
 */
export function withIdleScouts(
  results: Array<{ scout: string; status: string; candidates: unknown[]; error?: string }>,
): unknown[] {
  const named = new Set(results.map((r) => r.scout));
  return [
    ...results,
    ...SCOUT_NAMES.filter((role) => !named.has(role)).map((role) => ({
      scout: role,
      status: "complete",
      candidates: [],
    })),
  ];
}
