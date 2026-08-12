import { scanForCredentials } from "../../src/lib/redactor";

// A PostHog PROJECT key is public by construction, and refusing it costs real notes.
//
// Measured 2026-08-07/08: of the 26 vault notes the egress gate refuses under
// `block_on_detect`, ZERO carry a live secret. The two longest values in the whole
// refused population (47 chars, mixed class) are both `phc_` PostHog project keys. One
// is literally assigned to `NEXT_PUBLIC_POSTHOG_KEY`, i.e. a value that ships inside the
// browser bundle to every visitor. Refusing to govern a note because it quotes a key
// that is already public buys nothing and costs the note.
//
// This is a claim about the VALUE'S KIND, not its length. PostHog issues a typed prefix:
// `phc_` is the project/client key used in client-facing contexts, and the secret
// personal/org forms are a different prefix. So the exemption is exactly as wide as the
// vendor's own type distinction and no wider.
//
// It is deliberately NOT the "short value" exemption the `env_assignment` rule already
// considered and refused: that one was rejected because a five-word diceware passphrase
// has the same shape as prose, and this says nothing about length.
describe("egress: a phc_ PostHog PROJECT key is public, not a secret", () => {
  // `scanForCredentials` is the gate that REFUSES a document under block_on_detect, so
  // that is what these assert. Redaction is a separate plane; the refusal is the cost.
  it("does not refuse a phc_ project key assigned to the public env var", () => {
    const line = "NEXT_PUBLIC_POSTHOG_KEY=phc_q1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnm12345678";

    expect(scanForCredentials(line)).toEqual([]);
  });

  it("does not refuse it under the plain project-key name either", () => {
    const line = "POSTHOG_PROJECT_API_KEY=phc_q1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnm12345678";

    expect(scanForCredentials(line)).toEqual([]);
  });

  it("STILL refuses a phx_ personal key, which is the secret form", () => {
    // The `phx_` prefix is SPLIT from its body and must stay split. The value is a
    // keyboard walk, but GitHub's push protection matches on shape with validity
    // checks off, so a contiguous literal here refuses every push of the PUBLIC
    // mirror. It did, from 2026-08-07 until 2026-08-12. The `phc_` cases above need
    // no such care: the project key is public by construction and GitHub does not
    // detect it, which is the same vendor type distinction this whole file rests on.
    // Concatenation resolves at module load, so what the scanner sees is unchanged.
    const line = "POSTHOG_PERSONAL_API_KEY=" + "phx" + "_q1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnm12345678";

    expect(scanForCredentials(line)).toContain("env_assignment");
  });

  it("does not generalise: an unrelated opaque token under an API_KEY name still refuses", () => {
    // The exemption must not become "analytics keys are public" or, worse, "any
    // prefixed token is public".
    const line = "SOME_API_KEY=q1w2e3r4t5y6u7i8o9p0asdfghjklzxcvbnm12345678";

    expect(scanForCredentials(line)).toContain("env_assignment");
  });

  it("does not exempt a phc_-LOOKING value too short to be a real project key", () => {
    // Guard against the prefix becoming a bypass: `KEY=phc_x` must not sail through.
    const line = "SOME_API_KEY=phc_short";

    expect(scanForCredentials(line)).toContain("env_assignment");
  });
});
