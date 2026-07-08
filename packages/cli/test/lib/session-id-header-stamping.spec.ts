// S1-CLI (Channel A transport): the run-local session singleton and the
// X-Agent-Session-ID stamping in buildIntelHeaders. This is the CLI half of the
// session-grouping handoff: bootstrap canonicalizes CLAUDE_CODE_SESSION_ID once
// into the singleton, and every intel call carries the raw canonical UUID so the
// workspace-authoritative sink composes the Langfuse session exactly once
// (INV-COMPOSE-ONCE). When no run-local session exists the header is simply
// omitted (intel then falls back to its console grouping); the CLI never sends a
// composed value and never invents a console key.

import { buildIntelHeaders } from "../../src/lib/http";
import {
  getRunSessionId,
  resetRunSessionIdForTesting,
  setRunSessionId,
} from "../../src/lib/observability";

const VALID = "e1b29b04-7467-412d-bdd6-80ee8de19de0";

describe("run-local session singleton + X-Agent-Session-ID stamping (S1-CLI)", () => {
  beforeEach(() => resetRunSessionIdForTesting());
  afterEach(() => resetRunSessionIdForTesting());

  it("starts cleared and round-trips set/get/reset", () => {
    expect(getRunSessionId()).toBeNull();
    setRunSessionId(VALID);
    expect(getRunSessionId()).toBe(VALID);
    setRunSessionId(null);
    expect(getRunSessionId()).toBeNull();
    setRunSessionId(VALID);
    resetRunSessionIdForTesting();
    expect(getRunSessionId()).toBeNull();
  });

  it("stamps X-Agent-Session-ID from the run-local singleton (body and no-body)", () => {
    setRunSessionId(VALID);
    expect(buildIntelHeaders("tok", true)["X-Agent-Session-ID"]).toBe(VALID);
    expect(buildIntelHeaders("tok", false)["X-Agent-Session-ID"]).toBe(VALID);
  });

  it("omits X-Agent-Session-ID entirely when there is no run-local session", () => {
    expect(getRunSessionId()).toBeNull();
    const h = buildIntelHeaders("tok", true);
    expect("X-Agent-Session-ID" in h).toBe(false);
  });

  it("stops stamping after the singleton is reset", () => {
    setRunSessionId(VALID);
    expect(buildIntelHeaders("tok", true)["X-Agent-Session-ID"]).toBe(VALID);
    resetRunSessionIdForTesting();
    expect("X-Agent-Session-ID" in buildIntelHeaders("tok", true)).toBe(false);
  });

  it("always carries the Authorization bearer regardless of session presence", () => {
    expect(buildIntelHeaders("tok", true).Authorization).toBe("Bearer tok");
    setRunSessionId(VALID);
    expect(buildIntelHeaders("tok", true).Authorization).toBe("Bearer tok");
  });
});
