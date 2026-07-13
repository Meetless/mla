import { COMMANDS } from "../../src/cli";
import { KNOWN_COMMANDS, normalizeCommand } from "../../src/lib/analytics/command-event";

/**
 * KNOWN_COMMANDS is a hand-maintained copy of the dispatch registry, and
 * normalizeCommandToken folds anything missing from it into `command: "unknown"`.
 * That is not a cosmetic mislabel: a command absent from the allowlist is erased
 * from the funnel, and the erasure is invisible because "unknown" looks like a
 * user typo rather than a reporting bug.
 *
 * It has already happened. Across the 0.2.0 through 0.2.11 field clients, 49% of
 * every mla_command event in prod PostHog carries command="unknown" with an empty
 * flags_shape and a `success` outcome, which is the signature of a real command
 * that ran fine and was then thrown away at the reporting layer. The two lists
 * agree again today; these tests are what keeps them agreeing.
 */
describe("analytics command allowlist", () => {
  const registry = new Set<string>();
  for (const spec of COMMANDS) {
    registry.add(spec.name);
    for (const alias of spec.aliases ?? []) registry.add(alias);
  }

  // Resolved by normalizeCommandToken before the allowlist is consulted, so they
  // are legitimately in KNOWN_COMMANDS without being dispatch entries.
  const SYNTHETIC = new Set(["help", "version"]);

  it("covers every dispatchable command and alias", () => {
    const missing = [...registry].filter((name) => !KNOWN_COMMANDS.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("has no entry that is not dispatchable", () => {
    const stale = [...KNOWN_COMMANDS]
      .filter((name) => !registry.has(name) && !SYNTHETIC.has(name))
      .sort();
    expect(stale).toEqual([]);
  });

  it("reports every real command under its own name, never as unknown", () => {
    for (const name of registry) {
      expect(normalizeCommand([name]).command).toBe(name);
    }
  });

  it("still folds a genuine typo into unknown", () => {
    expect(normalizeCommand(["not-a-real-command"]).command).toBe("unknown");
  });

  it("keeps _internal dispatchable so the journey event can skip it", () => {
    // captureCommandEvent drops the event when this returns exactly "_internal".
    // If _internal ever fell out of the allowlist it would normalize to "unknown"
    // and every hook-spawned run would pollute the command funnel instead.
    expect(normalizeCommand(["_internal", "evidence-inject"]).command).toBe("_internal");
  });
});
