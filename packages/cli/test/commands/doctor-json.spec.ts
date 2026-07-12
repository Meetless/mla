import { doctorJson, checkStatus } from "../../src/commands/doctor";

// Behavioral lock for the `mla doctor --json` emitter (release-testing proposal
// §212, §217). The integration harness (§6.3) asserts NAMED checks off this
// payload instead of grepping fragile English labels, so the contract under
// test is: a green/red roll-up that agrees with the exit code, one entry per
// check carrying a stable `id`, a three-value `status`, and a human `message`.
//
// doctorJson is a pure function of a Check[], so it is exercised directly here
// with hand-built checks (no control, no filesystem), exactly like
// doctorExitCode is pinned in doctor-exit-code.spec.ts.

describe("checkStatus (three-value per-check status)", () => {
  it("maps ok non-info to pass", () => {
    expect(checkStatus({ ok: true, label: "x" })).toBe("pass");
  });

  it("maps not-ok non-info to fail", () => {
    expect(checkStatus({ ok: false, label: "x" })).toBe("fail");
  });

  it("maps info to info regardless of ok (the exit-code carve-out)", () => {
    expect(checkStatus({ ok: true, label: "x", level: "info" })).toBe("info");
    expect(checkStatus({ ok: false, label: "x", level: "info" })).toBe("info");
  });
});

describe("doctorJson (mla doctor --json payload)", () => {
  it("rolls up to green when no non-info check fails", () => {
    const out = doctorJson([
      { id: "control.reachable", ok: true, label: "control reachable" },
      { ok: true, label: "auth.mode", detail: "shared-key", level: "info" },
    ]);
    expect(out.status).toBe("green");
  });

  it("rolls up to red when any non-info check fails, mirroring the exit code", () => {
    const out = doctorJson([
      { id: "control.reachable", ok: false, label: "control reachable" },
      // an info FAIL must NOT flip the roll-up (append-only accounting rows)
      { ok: false, label: "fail-open ledger", level: "info" },
    ]);
    expect(out.status).toBe("red");
  });

  it("an info-only failure never turns the roll-up red", () => {
    const out = doctorJson([
      { ok: true, label: "control reachable", id: "control.reachable" },
      { ok: false, label: "muted session", level: "info" },
    ]);
    expect(out.status).toBe("green");
  });

  it("preserves explicit stable ids verbatim (the harness contract)", () => {
    const out = doctorJson([
      { id: "control.reachable", ok: true, label: "control reachable (GET /internal/v1/health)" },
      { id: "actor.member", ok: true, label: "actor resolves (workspace member)" },
      { id: "actor.owner", ok: true, label: "actor is workspace OWNER" },
      { id: "casekind.seeded", ok: true, label: "CaseKind 'agent_review' seeded" },
    ]);
    expect(out.checks.map((c) => c.id)).toEqual([
      "control.reachable",
      "actor.member",
      "actor.owner",
      "casekind.seeded",
    ]);
  });

  it("derives a slug id from the label when none is set, dropping parentheticals", () => {
    const out = doctorJson([
      { ok: true, label: "cli-config.json present (http://x)" },
    ]);
    // every non-alphanumeric run collapses to a single dot (the '-' too), and
    // the parenthetical detail is dropped before slugging.
    expect(out.checks[0].id).toBe("cli.config.json.present");
  });

  it("suffixes derived-slug collisions so ids stay unique", () => {
    const out = doctorJson([
      { ok: true, label: "hook event registered" },
      { ok: true, label: "hook event registered" },
    ]);
    expect(out.checks.map((c) => c.id)).toEqual([
      "hook.event.registered",
      "hook.event.registered.2",
    ]);
  });

  it("composes message from label + detail", () => {
    const out = doctorJson([
      { id: "control.reachable", ok: true, label: "control reachable", detail: "http://127.0.0.1:3106" },
      { ok: true, label: "no detail here" },
    ]);
    expect(out.checks[0].message).toBe("control reachable: http://127.0.0.1:3106");
    expect(out.checks[1].message).toBe("no detail here");
  });
});
