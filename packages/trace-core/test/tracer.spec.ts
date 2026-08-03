// Unit tests for the trace-core tracer (notes/20260530-mla-observability-
// diagnostic-spine.md §6 / §10.P1). P1.T6 (endRoot idempotent) is the
// acceptance test; the rest cover invariants that protect §6.2.

import { makeTracer, makeNoopTracer, FlushPayload } from "../src";

describe("makeTracer (P1.1 / P1.T6)", () => {
  const traceId = "a".repeat(32);
  const client = { mlaVersion: "0.1.0 (dev)", platform: "darwin" };

  function makeFakeFlush() {
    const calls: FlushPayload[] = [];
    const fn = jest.fn(async (payload: FlushPayload) => {
      calls.push(payload);
    });
    return { fn, calls };
  }

  it("creates a root span with parentSpanId=null and the supplied name", () => {
    const t = makeTracer({ traceId, rootName: "mla.review.latest", client });
    expect(t.traceId).toBe(traceId);
    expect(t.root.parentSpanId).toBeNull();
    const snap = t.snapshot();
    expect(snap.rootSpan.name).toBe("mla.review.latest");
    expect(snap.rootSpan.parentSpanId).toBeNull();
    expect(snap.spans).toHaveLength(0);
  });

  it("startSpan attaches children to the supplied parent (defaults to root)", () => {
    const t = makeTracer({ traceId, rootName: "mla.cmd", client });
    const child = t.startSpan({ name: "intel.ask" });
    const grand = t.startSpan({ name: "intel.retrieve", parent: child });
    const snap = t.snapshot();
    expect(snap.spans).toHaveLength(2);
    const childOut = snap.spans.find((s) => s.name === "intel.ask")!;
    const grandOut = snap.spans.find((s) => s.name === "intel.retrieve")!;
    expect(childOut.parentSpanId).toBe(t.root.spanId);
    expect(grandOut.parentSpanId).toBe(childOut.spanId);
  });

  it("endRoot is idempotent: second call is a no-op (P1.T6 acceptance)", () => {
    const t = makeTracer({ traceId, rootName: "mla.cmd", client });
    t.endRoot({ status: "ok", output: { exitCode: 0 } });
    t.endRoot({ status: "error", error: new Error("late") });
    const snap = t.snapshot();
    // First status wins, second call must NOT clobber it.
    expect(snap.rootSpan.status).toBe("ok");
    expect((snap.rootSpan.output as { exitCode: number }).exitCode).toBe(0);
  });

  it("incomplete child span serializes as status=aborted at flush time", () => {
    const t = makeTracer({ traceId, rootName: "mla.cmd", client });
    t.startSpan({ name: "intel.ask" }); // never ended
    t.endRoot({ status: "ok" });
    const snap = t.snapshot();
    const orphan = snap.spans.find((s) => s.name === "intel.ask")!;
    expect(orphan.status).toBe("aborted");
    expect(orphan.endTime).not.toBeNull();
  });

  it("flush() POSTs exactly one payload and is itself idempotent", async () => {
    const { fn, calls } = makeFakeFlush();
    const t = makeTracer({ traceId, rootName: "mla.cmd", client, flushFn: fn });
    t.endRoot({ status: "ok", output: { exitCode: 0 } });
    await t.flush();
    await t.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].traceId).toBe(traceId);
    expect(calls[0].rootSpan.status).toBe("ok");
    expect(calls[0].client).toEqual(client);
  });

  it("flush payload carries every child span with parent linkage preserved", async () => {
    const { fn, calls } = makeFakeFlush();
    const t = makeTracer({ traceId, rootName: "mla.cmd", client, flushFn: fn });
    const a = t.startSpan({ name: "control.foo" });
    a.end({ status: "ok" });
    const b = t.startSpan({ name: "intel.bar" });
    b.end({ status: "ok" });
    t.endRoot({ status: "ok" });
    await t.flush();
    expect(calls[0].spans).toHaveLength(2);
    expect(calls[0].spans.every((s) => s.parentSpanId === t.root.spanId)).toBe(true);
  });

  it("span.setAttribute and addEvent end up on the serialized snapshot", () => {
    const t = makeTracer({ traceId, rootName: "mla.cmd", client });
    const s = t.startSpan({ name: "intel.ask" });
    s.setAttribute("http.status", 200);
    s.addEvent("retrieved", { count: 5 });
    s.end({ status: "ok", output: { ok: true } });
    const snap = t.snapshot();
    const out = snap.spans[0];
    expect(out.attributes?.["http.status"]).toBe(200);
    expect(out.events?.[0].name).toBe("retrieved");
    expect((out.events?.[0].attributes as { count: number })?.count).toBe(5);
    expect(out.output).toEqual({ ok: true });
  });

  it("error attribute on a span is serialized into attributes.error, REDUCED", () => {
    // This assertion used to read `expect(errAttr.message).toBe("boom")`, which
    // is how the message reached the wire for as long as it did: a passing test
    // vouching for the leak. `message` is prose written by whichever throw site
    // fired, and this CLI interpolates raw argv into 133 of them, so the span
    // carried the user's flags and paths verbatim. It is dropped now; what
    // survives is what is OURS to say. See serializeError's comment in
    // ../src/index.ts and the guards in the CLI's trace-error-reduction.spec.ts.
    const t = makeTracer({ traceId, rootName: "mla.cmd", client });
    const s = t.startSpan({ name: "intel.ask" });
    s.end({ status: "error", error: new Error("boom --acme-pilot /Users/an/prd.md") });
    const snap = t.snapshot();
    const out = snap.spans[0];
    expect(out.status).toBe("error");
    const errAttr = out.attributes?.["error"] as {
      name: string;
      message?: string;
      stack?: string;
      frames?: string[];
    };
    expect(errAttr.name).toBe("Error");
    expect(errAttr.message).toBeUndefined();
    expect(errAttr.stack).toBeUndefined();
    // Frames stay: "which code path failed" is the actual triage question.
    expect(errAttr.frames?.every((f) => f.startsWith("at "))).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("--acme-pilot");
    expect(JSON.stringify(snap)).not.toContain("prd.md");
  });
});

describe("makeNoopTracer", () => {
  it("returns a tracer whose operations are all no-ops and flush resolves", async () => {
    const t = makeNoopTracer({ traceId: "b".repeat(32) });
    expect(t.traceId).toBe("b".repeat(32));
    const child = t.startSpan({ name: "anything", parent: t.root });
    child.end({ status: "ok" });
    t.endRoot({ status: "ok" });
    await expect(t.flush()).resolves.toBeUndefined();
    const snap = t.snapshot();
    expect(snap.spans).toHaveLength(0);
  });
});
