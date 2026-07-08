import { doctorExitCode } from "../../src/commands/doctor";

// `mla doctor` is only usable as a CI / script gate against a degraded enforcement store if its
// PROCESS EXIT CODE reflects the check results: non-zero when a real posture check is RED, zero
// otherwise. The orchestrator `runDoctor` is an IO shell (it reaches control, intel, the filesystem),
// so the aggregation that turns the check array into the exit code is extracted here as a pure function
// and pinned directly. The load-bearing invariant is the `level: "info"` carve-out: the append-only
// accounting rows (historical fail-open count, deny-emission backlog) are reported as info and must
// NEVER fail the gate, because the ledger is append-only and one transient install-time fail-open would
// otherwise pin every future `mla doctor` non-zero forever. A genuine store fault (corrupt ce0, schema
// drift, busy_timeout drift, an inadmissible attested root) is NOT info, so it must drive a non-zero
// exit. Synthetic check arrays, no IO: this pins the contract, not the environment.

describe("doctorExitCode: the CI-gate exit contract", () => {
  it("returns 0 when every non-info check passes", () => {
    expect(
      doctorExitCode([
        { ok: true, label: "interception schema matches" },
        { ok: true, label: "journal_mode = WAL" },
      ]),
    ).toBe(0);
  });

  it("returns 0 for the empty check set (nothing to gate on)", () => {
    expect(doctorExitCode([])).toBe(0);
  });

  it("returns 1 when a non-info posture check is RED (a corrupt store must fail the gate)", () => {
    expect(
      doctorExitCode([
        { ok: true, label: "journal_mode = WAL" },
        { ok: false, label: "ce0 integrity (PRAGMA quick_check)", detail: "database disk image is malformed" },
      ]),
    ).toBe(1);
  });

  it("does NOT fail the gate on a non-ok INFO row (append-only accounting never pins doctor RED)", () => {
    // This is the invariant a refactor could silently flip: an info row whose `ok` is false (e.g. a
    // historical fail-open count surfaced as not-clean) must still exit 0, while real faults exit 1.
    expect(
      doctorExitCode([
        { ok: false, label: "enforcement has failed open before", level: "info" },
        { ok: true, label: "interception schema matches" },
      ]),
    ).toBe(0);
  });

  it("returns 1 when a real RED coexists with a non-ok info row (the fault still wins)", () => {
    expect(
      doctorExitCode([
        { ok: false, label: "historical fail-open count", level: "info" },
        { ok: false, label: "busy_timeout drift", detail: "200ms" },
      ]),
    ).toBe(1);
  });
});
