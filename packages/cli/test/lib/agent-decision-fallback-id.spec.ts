// test/lib/agent-decision-fallback-id.spec.ts
//
// T6 / INV-STABLE-FALLBACK-ID (spec sections 5 and 7).
//
// deriveFallbackProviderEventId is the dedup anchor for any provider that does
// NOT hand us a stable per-event id. The PostToolUse path and the Stop
// transcript-scan backstop both derive it independently, so it MUST be:
//   1. byte-stable across repeated derivations of the SAME content,
//   2. independent of capture timestamp (occurredAt is not an input at all),
//   3. distinct whenever any identity-bearing field differs.
// If any of these break, the two capture paths produce different ids and the
// same human decision is written twice.

import {
  deriveFallbackProviderEventId,
  type FallbackIdInput,
} from "../../src/lib/agent-decision";

function input(overrides: Partial<FallbackIdInput> = {}): FallbackIdInput {
  return {
    provider: "synthetic_test",
    providerSessionId: "sess-42",
    sourceOrdinal: "3#0",
    prompt: { title: "Deploy target", body: "Where should this ship?" },
    choices: [
      { id: "choice_0", label: "Staging", description: "safe" },
      { id: "choice_1", label: "Production" },
    ],
    answer: { type: "choice_label", value: "Staging" },
    ...overrides,
  };
}

describe("deriveFallbackProviderEventId stability (T6)", () => {
  it("is a 64-char lowercase hex sha256 digest", () => {
    const id = deriveFallbackProviderEventId(input());
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is byte-stable across repeated derivations of identical content", () => {
    const a = deriveFallbackProviderEventId(input());
    const b = deriveFallbackProviderEventId(input());
    expect(a).toBe(b);
  });

  it("does NOT take any capture timestamp as input (occurredAt is not a field)", () => {
    // The two capture paths stamp different occurredAt values for the same
    // decision. The type has no slot for it, and a stray extra property must not
    // change the digest. Cast through unknown to attach one anyway.
    const withTs = { ...input(), occurredAt: "2026-06-09T01:02:03Z" } as unknown as FallbackIdInput;
    const withoutTs = input();
    expect(deriveFallbackProviderEventId(withTs)).toBe(deriveFallbackProviderEventId(withoutTs));
  });

  it("changes when sourceOrdinal changes (two decisions in one event do not collide)", () => {
    const first = deriveFallbackProviderEventId(input({ sourceOrdinal: "3#0" }));
    const second = deriveFallbackProviderEventId(input({ sourceOrdinal: "3#1" }));
    expect(first).not.toBe(second);
  });

  it("changes when the prompt changes", () => {
    const base = deriveFallbackProviderEventId(input());
    const other = deriveFallbackProviderEventId(
      input({ prompt: { title: "Deploy target", body: "When should this ship?" } }),
    );
    expect(base).not.toBe(other);
  });

  it("changes when a choice label changes", () => {
    const base = deriveFallbackProviderEventId(input());
    const other = deriveFallbackProviderEventId(
      input({
        choices: [
          { id: "choice_0", label: "Staging", description: "safe" },
          { id: "choice_1", label: "Prod" },
        ],
      }),
    );
    expect(base).not.toBe(other);
  });

  it("changes when the answer value changes", () => {
    const base = deriveFallbackProviderEventId(input());
    const other = deriveFallbackProviderEventId(input({ answer: { type: "choice_label", value: "Production" } }));
    expect(base).not.toBe(other);
  });

  it("changes when provider or providerSessionId changes", () => {
    const base = deriveFallbackProviderEventId(input());
    expect(deriveFallbackProviderEventId(input({ provider: "other_agent" }))).not.toBe(base);
    expect(deriveFallbackProviderEventId(input({ providerSessionId: "sess-99" }))).not.toBe(base);
  });

  it("does not collide under field-boundary ambiguity (NUL fence)", () => {
    // ("Staging","Production") choices vs a single label that concatenates them
    // must not hash the same. The NUL separator is what guarantees this.
    const a = deriveFallbackProviderEventId(
      input({ choices: [{ id: "choice_0", label: "a" }, { id: "choice_1", label: "bc" }] }),
    );
    const b = deriveFallbackProviderEventId(
      input({ choices: [{ id: "choice_0", label: "ab" }, { id: "choice_1", label: "c" }] }),
    );
    expect(a).not.toBe(b);
  });

  it("is insensitive to a choice description default (undefined vs absent)", () => {
    // A choice with no description and one with description:undefined are the
    // same decision; the digest normalizes both to "".
    const withUndef = deriveFallbackProviderEventId(
      input({ choices: [{ id: "choice_0", label: "Staging", description: undefined }, { id: "choice_1", label: "Production" }] }),
    );
    const withAbsent = deriveFallbackProviderEventId(
      input({ choices: [{ id: "choice_0", label: "Staging" }, { id: "choice_1", label: "Production" }] }),
    );
    expect(withUndef).toBe(withAbsent);
  });
});
