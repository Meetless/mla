import { runRedactEntry } from "../../src/redact-entry";
import { runAssembleEntry } from "../../src/assemble-entry";

// D1 (notes/20260809-did-mla-help-session-0e61cbd5-...): latency lever A, extended from
// the PreToolUse path to UserPromptSubmit. `user-prompt-submit.sh` spawns `mla` twice
// before it dials intel and both spawns paid for cli.js's eager 30+ command registry plus
// Sentry/analytics top-level init, which neither subcommand uses.
//
// Measured 2026-08-09, interleaved to defeat page-cache ordering, median of 9:
//
//     empty node script                           25ms
//     redact-capture closure alone                26ms
//     assemble-context closure alone             144ms
//     BOTH closures in one process               141ms
//     dist/cli.js --version (does NOTHING)       334ms
//
// End to end through the real entries, same method: 463ms -> 167ms per turn (-64%).
//
// The entries are thin IO shells over the SAME cores cli.ts dispatches to, so the head,
// the stderr payload and the redacted body are identical by construction (verified live:
// byte-identical stdout AND stderr against `mla _internal <sub>` on both). What these
// specs pin is the part that is NOT identical by construction, and where the two entries
// deliberately DISAGREE with each other: the exit code on an unexpected throw.
describe("the lean UserPromptSubmit entrypoints", () => {
  describe("redact-entry: fails CLOSED", () => {
    it("forwards the redact core's exit code", async () => {
      const exits: number[] = [];
      await runRedactEntry(async () => 0, (c) => exits.push(c));
      expect(exits).toEqual([0]);
    });

    it("forwards a non-zero exit code unchanged, so the caller can record redaction_failed", async () => {
      const exits: number[] = [];
      await runRedactEntry(async () => 1, (c) => exits.push(c));
      expect(exits).toEqual([1]);
    });

    it("exits 1 (NOT 0) when the core throws -- an empty body that reads as success is how an unredacted secret reaches disk", async () => {
      const exits: number[] = [];
      await runRedactEntry(async () => {
        throw new Error("boom");
      }, (c) => exits.push(c));
      expect(exits).toEqual([1]);
    });

    it("invokes the core with no argv (the payload rides stdin, never the args)", async () => {
      let seen: string[] | null = null;
      await runRedactEntry(async (argv) => {
        seen = argv;
        return 0;
      }, () => {});
      expect(seen).toEqual([]);
    });
  });

  describe("assemble-entry: fails SOFT, and preserves the load-bearing rc 3", () => {
    it("forwards rc 3 UNTOUCHED -- it is the fail-closed delivery signal", async () => {
      // Collapsing 3 to 0 would silently disarm floor enforcement: the hook turns rc 3
      // into DELIVERY_STATUS=DELIVERY_FAILED so a turn is never reported INJECTED while a
      // MUST went undelivered.
      const exits: number[] = [];
      await runAssembleEntry(async () => 3, (c) => exits.push(c));
      expect(exits).toEqual([3]);
    });

    it("forwards rc 0 and rc 2 unchanged", async () => {
      for (const rc of [0, 2]) {
        const exits: number[] = [];
        await runAssembleEntry(async () => rc, (c) => exits.push(c));
        expect(exits).toEqual([rc]);
      }
    });

    it("exits 0 when the core throws, matching the core's fail-soft contract", async () => {
      // The OPPOSITE of redact-entry, deliberately. Exit 0 with no stdout is exactly the
      // state in which user-prompt-submit.sh emits its own LAYER1 + floor head; a non-zero
      // here would turn a recoverable assembly fault into a blocked prompt, which is
      // strictly worse than the floor the bash fallback already delivers.
      const exits: number[] = [];
      await runAssembleEntry(async () => {
        throw new Error("boom");
      }, (c) => exits.push(c));
      expect(exits).toEqual([0]);
    });

    it("invokes the core with no argv", async () => {
      let seen: string[] | null = null;
      await runAssembleEntry(async (argv) => {
        seen = argv;
        return 0;
      }, () => {});
      expect(seen).toEqual([]);
    });
  });

  it("the two entries disagree on a throw, and that asymmetry is the point", async () => {
    // Non-vacuity for both blocks above. If a later refactor unified the catch, this is
    // the test that goes red rather than a silent change of failure semantics on the one
    // path that guards secrets.
    const redact: number[] = [];
    const assemble: number[] = [];
    const boom = async () => {
      throw new Error("boom");
    };
    await runRedactEntry(boom, (c) => redact.push(c));
    await runAssembleEntry(boom, (c) => assemble.push(c));
    expect(redact).toEqual([1]);
    expect(assemble).toEqual([0]);
  });
});
