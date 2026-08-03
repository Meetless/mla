// INV-ARGV-1 on the trace plane, fifth seam: the ERROR.
//
// The argv reduction (trace-argv-reduction.spec.ts) closed the span name, the
// argv attribute, the Sentry tags and the HTTP route. It did not close this
// one. An uncaught error's `message` went to the wire verbatim, and this CLI
// interpolates raw argv into its own error text at 133 throw sites, so
// `mla review --my-unreleased-project` shipped that flag to Langfuse twice:
// once as the message, once again inside the stack's header line, which is
// `${name}: ${message}`.
//
// A message is prose by construction. That is the whole lesson of the argv fix:
// a redactor that strips token shapes and paths does nothing to English. So the
// error is reduced to what is ours to say (type name, HTTP status, our own
// stack frames) and the message is dropped.
//
// As with the argv spec, the assertions are on the SERIALIZED FLUSH PAYLOAD.
// A capture path is only as narrow as its widest field.

import {
  createRunTracer,
  loadBuildInfo,
  resetRunTracerForTesting,
} from "../../src/lib/observability";
import type { FlushPayload } from "@meetless/trace-core";

// A real throw site, verbatim from src/commands/review.ts, with the kind of
// flag a user actually typos: their own project name.
const SECRET_FLAG = "--acme-sso-q3-pilot-secret";
const USAGE_MESSAGE = `Unknown flag: ${SECRET_FLAG}. Supported flags: --plain, --no-flush`;

async function flushWithError(err: unknown): Promise<FlushPayload> {
  let captured: FlushPayload | null = null;
  const tracer = createRunTracer({
    traceId: "a".repeat(32),
    rootName: "mla.review.none",
    buildInfo: loadBuildInfo(),
    flushFn: async (payload) => {
      captured = payload;
    },
  });
  tracer.endRoot({ status: "error", output: { exitCode: 1 }, error: err });
  await tracer.flush();
  if (!captured) throw new Error("flushFn never ran");
  return captured;
}

describe("a failing run ships no error TEXT", () => {
  afterEach(() => {
    resetRunTracerForTesting();
  });

  it("drops the message that carried the user's own flag", async () => {
    const wire = JSON.stringify(await flushWithError(new Error(USAGE_MESSAGE)));
    expect(wire).not.toContain(SECRET_FLAG);
    expect(wire).not.toContain("Unknown flag");
    expect(wire).not.toContain("acme");
  });

  it("drops the stack HEADER too, which is name + the same message", async () => {
    // The header line is the trap: dropping `message` alone leaves the message
    // in `stack`, one newline away, which is exactly how it shipped twice.
    const wire = JSON.stringify(await flushWithError(new Error(USAGE_MESSAGE)));
    expect(wire).not.toContain(`Error: ${USAGE_MESSAGE}`);
    expect(wire.split(SECRET_FLAG).length - 1).toBe(0);
  });

  it("keeps the type name and our own frames, so the run is still triageable", async () => {
    const payload = await flushWithError(new TypeError("reading 'reduce' of undefined"));
    const error = (payload.rootSpan.attributes ?? {}).error as {
      name?: string;
      frames?: string[];
    };
    expect(error.name).toBe("TypeError");
    expect(Array.isArray(error.frames)).toBe(true);
    expect(error.frames!.length).toBeGreaterThan(0);
    // Every retained line is a frame, never the header.
    for (const f of error.frames!) expect(f.startsWith("at ")).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("reduce");
  });

  it("keeps an HTTP status, which is a number and says what happened", async () => {
    const httpErr = Object.assign(
      new Error("HTTP 403: GET https://control.meetless.ai/internal/v1/x -> denied"),
      { status: 403 },
    );
    const payload = await flushWithError(httpErr);
    const error = (payload.rootSpan.attributes ?? {}).error as { status?: number };
    expect(error.status).toBe(403);
    // ...but not the URL that was in the message.
    expect(JSON.stringify(payload)).not.toContain("control.meetless.ai");
    expect(JSON.stringify(payload)).not.toContain("/internal/v1/");
  });

  it("emits only a type for a thrown non-Error, which can be a bare string", async () => {
    const payload = await flushWithError("why did we defer SSO for the Q3 pilot with Acme?");
    const error = (payload.rootSpan.attributes ?? {}).error as { name?: string };
    expect(error.name).toBe("NonError:string");
    expect(JSON.stringify(payload)).not.toContain("SSO");
    expect(JSON.stringify(payload)).not.toContain("Acme");
  });
});
