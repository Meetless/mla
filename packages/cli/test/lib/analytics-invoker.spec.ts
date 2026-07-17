// deriveInvoker: the §4.11 telemetry dimension. Pure, context-only derivation of WHO
// ran a command. These lock the three behaviors that matter: the agent transport is
// the sole agent marker, CI is recognized only in the absence of that marker, and
// everything else is the residual human bucket. argv is NEVER an input (INV-ARGV-1),
// so there is nothing argv-shaped to test here by construction.

import { deriveInvoker } from "../../src/lib/analytics/invoker";
import { INVOKERS } from "../../src/lib/analytics/envelope";

// A clean env with no CI markers set, so a case that does not opt into CI truly has
// none of them present (the ambient shell running jest may itself set CI).
const NO_CI: NodeJS.ProcessEnv = {};

describe("deriveInvoker", () => {
  it("marks the agent when resolve-mla's MEETLESS_OUTPUT=json transport is present", () => {
    expect(deriveInvoker({ requestedOutput: "json", env: NO_CI })).toBe("agent");
  });

  it("marks the agent even under a CI marker (the transport wins, order matters)", () => {
    // A run can be BOTH agent-driven and inside CI; the agent marker is checked first
    // because separating agent from human is the whole point of the dimension.
    expect(deriveInvoker({ requestedOutput: "json", env: { CI: "true" } })).toBe("agent");
  });

  it("marks ci for a headless run under a standard CI marker with no transport", () => {
    expect(deriveInvoker({ requestedOutput: undefined, env: { CI: "true" } })).toBe("ci");
    expect(deriveInvoker({ requestedOutput: undefined, env: { GITHUB_ACTIONS: "true" } })).toBe("ci");
  });

  it("falls back to human_tty for a plain human run (no transport, no CI)", () => {
    expect(deriveInvoker({ requestedOutput: undefined, env: NO_CI })).toBe("human_tty");
  });

  it("does not treat a non-json MEETLESS_OUTPUT value as the agent", () => {
    // Only the exact "json" transport marks the agent; any other value is not the
    // resolver's signal, so the run classifies by its remaining context.
    expect(deriveInvoker({ requestedOutput: "text", env: NO_CI })).toBe("human_tty");
    expect(deriveInvoker({ requestedOutput: "", env: NO_CI })).toBe("human_tty");
  });

  it("only ever returns a member of the closed INVOKERS enum", () => {
    const cases = [
      { requestedOutput: "json", env: NO_CI },
      { requestedOutput: undefined, env: { CI: "1" } },
      { requestedOutput: undefined, env: NO_CI },
      { requestedOutput: "nonsense", env: { GITLAB_CI: "true" } },
    ];
    for (const c of cases) {
      expect(INVOKERS).toContain(deriveInvoker(c));
    }
  });
});
