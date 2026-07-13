import { citationMeta, meaningful, renderPlain } from "../../src/lib/ask-render";

// The presenter shared by `mla ask` and `mla docs ask` (proposal 20260711 §7.4, T21).
//
// It exists so the two ask surfaces cannot drift into looking like two products.
// What is pinned here is the part that makes sharing SAFE: every section renders
// only if its field is present, so `mla docs ask` (which deliberately has no
// confidence: an answer is cited or it is an abstention, and anything in between
// would be a number we invented) does not print an empty footer, and `mla ask`
// keeps the exact output it had before the extraction.

describe("meaningful", () => {
  it("treats the UNKNOWN sentinel as absent", () => {
    // ask-core stamps "UNKNOWN" when intel returned no value. Rendering it printed
    // a useless `[UNKNOWN]` on every grounded note.
    expect(meaningful("UNKNOWN")).toBeNull();
    expect(meaningful("unknown")).toBeNull();
    expect(meaningful("  ")).toBeNull();
    expect(meaningful(undefined)).toBeNull();
    expect(meaningful(42)).toBeNull();
    expect(meaningful(" SHIPPED ")).toBe("SHIPPED");
  });
});

describe("citationMeta", () => {
  it("is kind-first, status-when-real", () => {
    expect(citationMeta({ docType: "note", status: "UNKNOWN" })).toBe(" [note]");
    expect(citationMeta({ docType: "decision-diff", status: "SHIPPED" })).toBe(" [decision-diff, SHIPPED]");
    expect(citationMeta({})).toBe("");
  });
});

describe("renderPlain", () => {
  it("keeps the `mla ask` footer byte-identical", () => {
    const out = renderPlain({
      answer: "stub answer text",
      results: [{ path: "notes/x.md", docType: "note", status: "SHIPPED" }],
      warnings: ["stub:answer"],
      workspace: "ws_test",
      mode: "answer",
      confidence: "high",
    });

    expect(out).toBe(
      [
        "stub answer text",
        "",
        "Citations (1):",
        "  - notes/x.md [note, SHIPPED]",
        "",
        "Warnings:",
        "  ! stub:answer",
        "",
        "(workspace: ws_test, mode: answer, confidence: high)",
      ].join("\n"),
    );
  });

  it("omits the footer entirely when the surface has no run metadata", () => {
    const out = renderPlain({
      answer: "Run `mla login`.",
      results: [{ path: "Signing in > Browser login", hint: "mla docs cli/login  |  https://meetless.ai/docs/cli/login" }],
    });

    // `mla docs ask` has no workspace, no mode, and no confidence: the corpus is the
    // same for everyone and the answer is cited or abstained. An empty
    // `(workspace: , mode: )` would be a lie dressed as metadata.
    expect(out).toBe(
      [
        "Run `mla login`.",
        "",
        "Citations (1):",
        "  - Signing in > Browser login",
        "      mla docs cli/login  |  https://meetless.ai/docs/cli/login",
      ].join("\n"),
    );
  });

  it("renders a partial footer from only the fields that are present", () => {
    const out = renderPlain({ answer: "x", workspace: "ws_1", confidence: "" });
    expect(out).toContain("(workspace: ws_1)");
  });

  it("renders citations with no answer (search mode) and no hint noise", () => {
    const out = renderPlain({
      results: [{ title: "a.md" }, { path: "b.md" }],
      mode: "search",
    });
    expect(out).toBe(
      ["Citations (2):", "  - a.md", "  - b.md", "", "(mode: search)"].join("\n"),
    );
  });
});
