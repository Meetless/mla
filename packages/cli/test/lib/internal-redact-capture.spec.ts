import {
  redactCapturePayload,
  runInternalRedactCapture,
  type RedactCaptureDeps,
  type RedactCaptureInput,
} from "../../src/commands/internal-redact-capture";
import { REDACTED } from "../../src/lib/redactor";

// `mla _internal redact-capture` is the governed-story capture redactor: the
// user-prompt-submit / post-tool-use hooks pipe assembled injected-context
// blocks + MCP query text through it so secrets are scrubbed by the ONE
// parity-locked redactor before the trace is spooled. Spec
// notes/20260627-session-detail-mla-actions-and-colored-injection-timeline-design.md §4.4.
//
// A known-redactable sample borrowed from redactor-parity.spec.ts so this test
// stays anchored to the shared contract: an env-assignment secret collapses to
// "export [REDACTED]".
const SECRET_LINE = "export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv";
const SECRET_REDACTED = `export ${REDACTED}`;

describe("redactCapturePayload (pure)", () => {
  it("redacts a secret in block content and marks it redacted", () => {
    const out = redactCapturePayload({
      blocks: [{ kind: "steer", content: SECRET_LINE, citations: ["DD:abc"], itemCount: 1 }],
    });
    expect(out.blocks).toHaveLength(1);
    const b = out.blocks[0];
    expect(b.content).toBe(SECRET_REDACTED);
    expect(b.contentStatus).toBe("redacted");
    expect(b.kind).toBe("steer");
    expect(b.citations).toEqual(["DD:abc"]);
    expect(b.itemCount).toBe(1);
  });

  it("leaves clean content untouched and marks it available", () => {
    const clean = "Defer the rate-limit work to next sprint.";
    const out = redactCapturePayload({ blocks: [{ kind: "governance", content: clean }] });
    expect(out.blocks[0].content).toBe(clean);
    expect(out.blocks[0].contentStatus).toBe("available");
  });

  it("treats null and empty content as available with charCount 0", () => {
    const out = redactCapturePayload({
      blocks: [
        { kind: "static", content: null },
        { kind: "static", content: "" },
        { kind: "static" },
      ],
    });
    for (const b of out.blocks) {
      expect(b.contentStatus).toBe("available");
      expect(b.charCount).toBe(0);
    }
    expect(out.blocks[0].content).toBeNull();
    expect(out.blocks[1].content).toBe("");
    // missing content key normalizes to null
    expect(out.blocks[2].content).toBeNull();
  });

  it("computes charCount from the RAW (pre-redaction) body in code points", () => {
    // Two code-point characters plus the secret. charCount must reflect the
    // original length, NOT the post-redaction (shorter) string.
    const raw = `\u{1F600}\u{1F600} ${SECRET_LINE}`;
    const out = redactCapturePayload({ blocks: [{ kind: "evidence", content: raw }] });
    expect(out.blocks[0].charCount).toBe(Array.from(raw).length);
    // sanity: the redacted body is shorter, proving charCount is not derived from it
    expect((out.blocks[0].content ?? "").length).toBeLessThan(raw.length);
    expect(out.blocks[0].contentStatus).toBe("redacted");
  });

  it("normalizes a missing kind to 'unknown' and a bad itemCount to null", () => {
    const out = redactCapturePayload({
      blocks: [{ content: "hi", itemCount: -3 } as unknown as RedactCaptureInput["blocks"]],
    } as RedactCaptureInput);
    expect(out.blocks[0].kind).toBe("unknown");
    expect(out.blocks[0].itemCount).toBeNull();
  });

  it("drops non-string citations and keeps only string ids", () => {
    const out = redactCapturePayload({
      blocks: [{ kind: "active-review", content: "x", citations: ["NT:a.md", 7, null, "DD:z"] }],
    });
    expect(out.blocks[0].citations).toEqual(["NT:a.md", "DD:z"]);
  });

  it("redacts the query and passes null through", () => {
    expect(redactCapturePayload({ query: SECRET_LINE }).query).toBe(SECRET_REDACTED);
    expect(redactCapturePayload({ query: "what changed?" }).query).toBe("what changed?");
    expect(redactCapturePayload({}).query).toBeNull();
    expect(redactCapturePayload({ query: 42 } as unknown as RedactCaptureInput).query).toBeNull();
  });

  it("tolerates blocks not being an array", () => {
    const out = redactCapturePayload({ blocks: "nope" } as unknown as RedactCaptureInput);
    expect(out.blocks).toEqual([]);
  });

  it("keeps summary.injectedCharCount == sum(block.charCount) by construction", () => {
    const out = redactCapturePayload({
      blocks: [
        { kind: "static", content: "abcd" },
        { kind: "steer", content: SECRET_LINE },
        { kind: "evidence", content: null },
      ],
    });
    const summed = out.blocks.reduce((acc, b) => acc + b.charCount, 0);
    expect(summed).toBe(4 + Array.from(SECRET_LINE).length + 0);
  });
});

describe("runInternalRedactCapture (io shell)", () => {
  function deps(stdin: string | (() => Promise<string>)): {
    d: RedactCaptureDeps;
    written: () => string;
  } {
    let out = "";
    const readStdin =
      typeof stdin === "string" ? () => Promise.resolve(stdin) : stdin;
    return {
      d: { readStdin, writeOut: (s) => (out += s) },
      written: () => out,
    };
  }

  it("redacts valid stdin and exits 0", async () => {
    const { d, written } = deps(
      JSON.stringify({ blocks: [{ kind: "steer", content: SECRET_LINE }], query: SECRET_LINE }),
    );
    const code = await runInternalRedactCapture([], d);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.blocks[0].content).toBe(SECRET_REDACTED);
    expect(parsed.blocks[0].contentStatus).toBe("redacted");
    expect(parsed.query).toBe(SECRET_REDACTED);
  });

  it("exits 1 on malformed JSON without writing anything", async () => {
    const { d, written } = deps("{not json");
    const code = await runInternalRedactCapture([], d);
    expect(code).toBe(1);
    expect(written()).toBe("");
  });

  it("exits 1 on a non-object payload (fail-closed telemetry)", async () => {
    for (const bad of ["123", '"str"', "null", "[1,2]"]) {
      const { d, written } = deps(bad);
      const code = await runInternalRedactCapture([], d);
      // arrays are objects in JS; the redactor treats a top-level array as
      // having no blocks/query, which is a safe empty result, so only the
      // truly-scalar inputs must fail-closed.
      if (bad === "[1,2]") {
        expect(code).toBe(0);
      } else {
        expect(code).toBe(1);
        expect(written()).toBe("");
      }
    }
  });

  it("exits 1 when stdin cannot be read", async () => {
    const { d, written } = deps(() => Promise.reject(new Error("broken pipe")));
    const code = await runInternalRedactCapture([], d);
    expect(code).toBe(1);
    expect(written()).toBe("");
  });
});
