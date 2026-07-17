// §5.2 placeholder-in-runnable-command guard. The mechanical backstop for the §3 bug 3
// defect: the CLI once printed `mla enrich accept --run-id <runId> --all` with the literal
// token `<runId>`, a command no human could run and no agent should relay. The fix (Phase 0)
// interpolates the real run id; this guard makes a regression impossible to land silently.
//
// Per §5.2 we do NOT blanket-reject `<...>`: usage text legitimately shows placeholders, and
// `--only <id-prefix>` is a genuine user choice the reader fills in. We test ONLY the renderer
// that produces a runnable next-step command (`renderAcceptReview`) and assert: every required
// argument is present and interpolated, an unresolved argument makes the renderer fail, and the
// only literal placeholder permitted is the user's `<id-prefix>` choice.
//
// This spec imports `renderAcceptReview` directly, so it is the guard's SUBJECT: if that
// renderer is renamed or removed, this file stops compiling. A guard that cannot find its
// subject must scream, not skip (§5 closing line).

import { renderAcceptReview } from "../../src/commands/enrich";
import type { OnboardingCandidateRecord } from "../../src/lib/enrichment/protocol";

const RUN_ID = "run_7f3a9c21b8e4"; // a realistic run id with no `<`/`>` in it

function durable(id: string, statement: string): OnboardingCandidateRecord {
  return {
    candidateId: id,
    kind: "constraint",
    statement,
    evidence: [],
    sourceScouts: ["documentation"],
    rationale: null,
    rationaleSource: null,
    relPath: `onboarding/${id.slice(0, 8)}-rule.md`,
    landed: "materialized",
  } as unknown as OnboardingCandidateRecord;
}

// Only these tokens are system placeholders the renderer must never emit: a required argument
// left uninterpolated. `<id-prefix>` is intentionally absent from this list; it is the user's
// own choice and is allowed to appear literally.
const FORBIDDEN_SYSTEM_PLACEHOLDERS = ["<runId>", "<run-id>", "<runid>", "<id>", "<RUN_ID>"];

// The subject line: the runnable command whose required `--run-id` argument must be interpolated.
const RUNNABLE_SUBJECT = /^Accept all durable rules:\s+mla enrich accept --run-id (\S+) --all$/m;

describe("§5.2 placeholder-in-runnable-command guard (renderAcceptReview)", () => {
  it("interpolates the real run id into every runnable next-step command", () => {
    const out = renderAcceptReview(RUN_ID, [durable("a1a1a1a1a1a1a1a1", "Use 127.0.0.1 not localhost")], []);
    // The subject line exists and carries the ACTUAL run id, not a placeholder token.
    const m = out.match(RUNNABLE_SUBJECT);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(RUN_ID);
    // The `--only` runnable line also interpolates the real run id.
    expect(out).toContain(`mla enrich accept --run-id ${RUN_ID} --only`);
  });

  it("emits no forbidden SYSTEM placeholder token in the runnable lines", () => {
    const out = renderAcceptReview(RUN_ID, [durable("b2b2b2b2b2b2b2b2", "Prefer relative imports")], []);
    for (const token of FORBIDDEN_SYSTEM_PLACEHOLDERS) {
      expect(out.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  it("permits the user's own `<id-prefix>` choice as a literal placeholder", () => {
    // §5.2: only help and usage may show a literal placeholder, and `<id-prefix>` is the value
    // the user supplies to `--only`. It is a genuine choice, not an unresolved system argument,
    // so the guard explicitly allows it (and asserts it stays, so the affordance is not lost).
    const out = renderAcceptReview(RUN_ID, [durable("c3c3c3c3c3c3c3c3", "Control owns the state machine")], []);
    expect(out).toContain("--only <id-prefix>");
  });

  it("fails loudly when the required run id is unresolved (empty or blank)", () => {
    // "an unresolved argument makes the renderer fail" (§5.2). The renderer must not fall back
    // to printing `--run-id ` with nothing after it.
    const rec = [durable("d4d4d4d4d4d4d4d4", "some rule")];
    expect(() => renderAcceptReview("", rec, [])).toThrow(/unresolved argument/i);
    expect(() => renderAcceptReview("   ", rec, [])).toThrow(/unresolved argument/i);
  });

  it("does not render runnable accept commands when there is nothing durable to accept", () => {
    // With no durable rules the review shows no next-step command at all, so there is no runnable
    // subject to leak a placeholder into. (A blank run id is still rejected up front, above.)
    const out = renderAcceptReview(RUN_ID, [], [durable("e5e5e5e5e5e5e5e5", "knowledge-ish")]);
    expect(out).not.toMatch(RUNNABLE_SUBJECT);
    expect(out).not.toContain("mla enrich accept --run-id");
  });
});
