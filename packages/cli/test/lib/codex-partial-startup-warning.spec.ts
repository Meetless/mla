// Ordinary `mla` must NOTICE a partial Codex install and must never repair it.
//
// `mla doctor` already fails one (`05cbc5fd2`), which only helps an operator who runs
// doctor. The condition is severe enough to surface on any command: an integration
// that records events all day and produces zero durable knowledge looks, from the
// outside, exactly like a working one.
//
// The hot paths are excluded and that is load-bearing. `_internal codex-hook`,
// `_internal pretool-observe` and `flush` are invoked BY a coding agent on every
// event; a stderr line there is noise in someone's editor on every keystroke-ish
// event, and `pretool-observe` writes a deny envelope on stdout whose contract is
// exact. The wrapper gets its own once-per-session warning instead
// (`codex-partial-wrapper.spec.ts`).

import { shouldWarnCodexPartial } from "../../src/lib/codex-startup-warning";

describe("which commands may carry the Codex warning", () => {
  it("warns on ordinary operator commands", () => {
    for (const cmd of ["status", "review", "ask", "kb", "session", "stats", "rules"]) {
      expect(shouldWarnCodexPartial(cmd)).toBe(true);
    }
  });

  it("stays silent on the hook hot paths, which run per agent event", () => {
    for (const cmd of ["_internal", "flush", "queue"]) {
      expect(shouldWarnCodexPartial(cmd)).toBe(false);
    }
  });

  it("stays silent on the commands that already say it better", () => {
    // doctor renders the full check; codex install IS the repair and prints its own
    // result; help/version are read by scripts.
    for (const cmd of ["doctor", "codex", "help", "--help", "-h", "--version", "-v"]) {
      expect(shouldWarnCodexPartial(cmd)).toBe(false);
    }
  });

  it("stays silent with no command at all (bare `mla` prints the catalog)", () => {
    expect(shouldWarnCodexPartial(undefined)).toBe(false);
    expect(shouldWarnCodexPartial("")).toBe(false);
  });
});

// Item 6 of the 08-19 ruling: "if an existing explicit MLA upgrade/setup flow owns
// integration maintenance, reuse the same reconciler there."
//
// It already does, and it is NOT `mla upgrade`. Two facts decide this:
//
//   * `mla init` / `mla wire` own integration maintenance and call `autoWireCodex`,
//     which calls `ensureCodexHooks` -- the same single reconciler `mla codex install`
//     calls. There is no second implementation to converge.
//   * `runUpgrade` is a signed-binary swap whose documented purpose is exactly that,
//     and which ends with "the new version takes effect on your next command". The
//     swapping process is still the OLD binary, so reconciling there would register
//     against a stale `CODEX_MANAGED_HOOKS` and a stale mla path. Adding a write to it
//     would be a NEW mutation boundary, which the ruling's condition does not
//     authorize.
//
// What `upgrade` DOES need is to be the loudest possible place to hear about it,
// because a new release is the most likely way to acquire a newly-managed hook. So it
// carries the warning like any other ordinary command, and this test exists so nobody
// "tidies" it into the silent list.
describe("the upgrade path", () => {
  it("carries the warning, because a release is how a new managed hook arrives", () => {
    expect(shouldWarnCodexPartial("upgrade")).toBe(true);
  });

  it("so do the explicit setup commands that DO reconcile, before they reconcile", () => {
    // `init`/`wire` repair it via autoWireCodex; hearing why first is not noise.
    expect(shouldWarnCodexPartial("init")).toBe(true);
    expect(shouldWarnCodexPartial("wire")).toBe(true);
  });
});
