import * as fs from "node:fs";
import * as path from "node:path";

// A5 carry-forward: WHY IT WAS REMOVED, and the guard that keeps it removed.
//
// The feature is gone (owner ruling 2026-08-09). This file outlives it because the
// reasoning is the reusable part: two separate proposals to "fix" carry-forward were
// both self-defeating, and the next person to reach for the same idea should meet that
// before rebuilding it.
//
// ---------------------------------------------------------------------------------
// WHAT IT DID. On a turn that injected Layer 2 evidence, `compute_carry` selected the
// intersection of (a) what was injected LAST turn at carry_count 0 and (b) THIS turn's
// `enrichment.context_items`, then appended a block naming those ids: "These surfaced
// last turn and are still the closest match to your current question; you may not have
// consulted them yet."
//
// THE GATE IS THE WHOLE STORY. "Still surfaced" was half the definition of a carry, so
// every carried id was ALREADY in this turn's evidence block. Always. For every item, on
// every turn. The mechanism was never rescuing information that would otherwise be
// absent from the payload; it spent bytes and attention re-naming evidence the same
// payload already carried.
//
// ---------------------------------------------------------------------------------
// PROPOSAL 1, from the 345a4bce review: "carry-forward must not add a citation already
// selected for the current payload." Applied literally that empties the block on every
// turn, because it forbids exactly the condition the gate requires. There was no
// duplicate subset to remove. The overlap WAS the feature.
//
// PROPOSAL 2, from the note itself: "do not re-surface an item that was delivered last
// turn and neither opened nor cited." Measured over the same 227 fires, the agent had
// consulted the carried item on the PRIOR turn in 0 of them. The gate would have fired
// zero times. (Its polarity is also inverted: suppressing on NON-use suppresses the one
// case the feature was built for.)
//
// ---------------------------------------------------------------------------------
// THE LEDGER THAT DECIDED IT, over 4,754 ask-trace rows spanning roughly two months:
//
//   carry-forward fired                                        227 turns
//   carried item consumed on or after the carry turn             3 (1.3%)
//     ...and one of those three is the agent NAMING the
//        document as a magnet in the note it was writing
//   baseline: turns that injected any evidence                  968
//   baseline: an injected item consumed on or after that turn    60 (6.2%)
//
// A fifth of the consumption rate of the ordinary injection sitting beside it, for
// evidence that injection had already delivered.
//
// WHAT WAS NEVER WRONG WITH IT, stated so the removal is not over-claimed: nothing
// double-COUNTED the carried id. `summary.evidenceCount` sums `itemCount` over blocks of
// kind "evidence" and excluded the carry block by kind, and the pull ledger aggregates
// `injection_traces.contextItems` filtered to `sourceSurface='MCP'`, which no
// UserPromptSubmit block reaches. The cost was bytes and attention, not accounting.

const HOOKS = path.join(__dirname, "..", "..", "src", "hooks-template");
const read = (f: string) => fs.readFileSync(path.join(HOOKS, f), "utf8");

describe("A5 carry-forward is removed and stays removed", () => {
  it("no hook emits a carry-forward block", () => {
    const hook = read("user-prompt-submit.sh");

    // The emitter, not the word: the removal comment names the mechanism on purpose and
    // must not trip this. What must be absent is a block being BUILT with that kind.
    expect(hook).not.toMatch(/CARRY_BLOCK=/);
    expect(hook).not.toMatch(/<meetless-context kind=\\?"carry-forward\\?"/);
  });

  it("the two helpers are gone from common.sh, with no caller left behind", () => {
    const common = read("common.sh");
    const hook = read("user-prompt-submit.sh");

    expect(common).not.toMatch(/^compute_carry\(\)/m);
    expect(common).not.toMatch(/^read_prior_carry_state\(\)/m);
    // A dangling call would be a runtime `command not found` on the hot path, and the
    // hook's `set -e` would take the turn down with it.
    expect(hook).not.toMatch(/^\s*(local\s+\w+=)?"?\$\(compute_carry/m);
    expect(hook).not.toMatch(/\$\(read_prior_carry_state/);
  });

  it("the trace field survives as a permanent null rather than vanishing", () => {
    // Deliberate. `ask-traces.jsonl` holds months of rows where this field was
    // populated, and a field that DISAPPEARS makes "this turn did not carry"
    // indistinguishable from "this build predates the field". Pinned null says the first
    // thing and only the first thing.
    const hook = read("user-prompt-submit.sh");

    expect(hook).toMatch(/CARRY_FORWARD_JSON="null"/);
    expect(hook).toMatch(/--argjson carry_forward "\$\{CARRY_FORWARD_JSON:-null\}"/);
    // ...and nothing assigns it anything else.
    const assignments = hook.match(/CARRY_FORWARD_JSON=/g) ?? [];
    expect(assignments).toHaveLength(1);
  });

  it("the kill switch is gone too, so there is no flag suggesting it can come back", () => {
    const hook = read("user-prompt-submit.sh");

    expect(hook).not.toMatch(/MEETLESS_CARRY_FORWARD/);
  });

  it("the plugin copy of both hooks matches the source template (modulo the note-slug strip)", () => {
    // The plugin ships its own copy (sync-plugin.mjs). A removal that lands in one and
    // not the other leaves the feature alive for every plugin user, which is the worst
    // of both outcomes: gone from the tests, present in the payload.
    //
    // sync-plugin.mjs deliberately strips internal note-filename references from the
    // GENERATED artifact's comments (to keep the ~14 slugs out of the public mirror's
    // scrub gate) while the source template keeps them for dev traceability. Apply the
    // SAME comment-only transform here so this still guards real (code) drift between the
    // two copies, not the intended comment difference.
    const stripSlugs = (s: string) =>
      s.replace(/notes\/\d{8}-[a-z0-9-]+(?:\.md)?/g, "an internal design note");
    const plugin = (f: string) => fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "plugin", "hooks", f), "utf8");

    expect(plugin("user-prompt-submit.sh")).toEqual(stripSlugs(read("user-prompt-submit.sh")));
    expect(plugin("common.sh")).toEqual(stripSlugs(read("common.sh")));
  });
});
