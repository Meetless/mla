// INV-ARGV-1 on the RUN-TRACE plane.
//
// The PostHog plane reduces argv to a known command, a known subcommand and
// approved flag NAMES (lib/analytics/command-event.ts, the single chokepoint
// that keeps INV-ARGV-1 true). The trace plane did not. It mapped argv through
// the SECRET redactor, which strips token shapes and filesystem paths but
// leaves ordinary prose alone, and it built the root span NAME from the raw
// argv[0] / argv[1]. So `mla ask "<question>"` shipped the whole question to
// Langfuse Cloud twice: once in the span name, once in the "argv" attribute.
// The HTTP child spans had the same shape of bug one layer down: the span NAME
// used the routeNameFromPath rollup while the "route" ATTRIBUTE kept the raw
// path, query string and all.
//
// These tests pin the SERIALIZED FLUSH PAYLOAD, not one field at a time. A
// capture path is only as narrow as its widest field, so the load-bearing
// assertion is "this string appears nowhere in the bytes that leave the
// machine", which keeps holding when someone adds a new attribute.

import {
  createRunTracer,
  setRunTraceId,
  setRunTracer,
  resetRunTracerForTesting,
  reduceArgvForSpan,
  traceRootName,
  loadBuildInfo,
} from "../../src/lib/observability";
import { get as controlGet } from "../../src/lib/http";
import { applyEgressPolicy } from "../../src/lib/egress/policy";
import { EGRESS_RULES } from "../../src/lib/egress/rules";
import type { CliConfig } from "../../src/lib/config";
import type { FlushPayload } from "@meetless/trace-core";

// The realistic leak payload, kept in one place so every assertion below is
// about the same bytes. This is the shape that actually reaches the CLI:
// process.argv.slice(2), so argv[0] is the command and argv[1] is whatever the
// user typed next, which for `ask` is free text.
const QUESTION = "why did we defer SSO for the Q3 pilot with Acme?";
const ASK_ARGV = ["ask", QUESTION, "--json"];

function fakeCfg(): CliConfig {
  return {
    controlUrl: "http://127.0.0.1:3006",
    controlToken: "tok",
    workspaceId: "ws_an_local",
    mlaPath: "",
    auth: { mode: "shared-key", accessToken: "tok" },
  };
}

describe("reduceArgvForSpan: argv is REDUCED, not merely redacted", () => {
  it("drops positional free text and keeps only the known command + approved flag names", () => {
    const out = reduceArgvForSpan(ASK_ARGV);

    expect(out).toEqual({ command: "ask", subcommand: null, flags: ["json"] });
    expect(JSON.stringify(out)).not.toContain("SSO");
    expect(JSON.stringify(out)).not.toContain(QUESTION);
  });

  it("keeps a known subcommand but never the positional that follows it", () => {
    // `mla decisions show <id>`: the keyword is a dimension worth having, the
    // id is a positional and must never reach the wire.
    const out = reduceArgvForSpan(["decisions", "show", "dec_01J9XYZSECRET"]);

    expect(out).toEqual({ command: "decisions", subcommand: "show", flags: [] });
    expect(JSON.stringify(out)).not.toContain("dec_01J9XYZSECRET");
  });

  it("drops flag VALUES whether they are separate tokens or joined with =", () => {
    const joined = reduceArgvForSpan(["review", "--actor=an@meetless.ai"]);
    const split = reduceArgvForSpan(["review", "--actor", "an@meetless.ai"]);

    expect(joined.flags).toEqual(["actor"]);
    expect(split.flags).toEqual(["actor"]);
    expect(JSON.stringify(joined)).not.toContain("an@meetless.ai");
    expect(JSON.stringify(split)).not.toContain("an@meetless.ai");
  });

  it("normalizes an unrecognized first token instead of passing it through", () => {
    // A typo'd path or a secret pasted as argv[0] collapses to "unknown"
    // rather than riding along as a span attribute.
    const out = reduceArgvForSpan(["/Users/alice/projects/acme-secret/prd.md"]);

    expect(out.command).toBe("unknown");
    expect(JSON.stringify(out)).not.toContain("acme-secret");
  });

  it("drops an unapproved flag name rather than surfacing it", () => {
    const out = reduceArgvForSpan(["ask", "--not-a-real-flag", "value"]);

    expect(out.flags).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("not-a-real-flag");
  });
});

describe("traceRootName: the span NAME is built from the reduced command", () => {
  it("never carries the positional that follows the command", () => {
    expect(traceRootName(ASK_ARGV)).toBe("mla.ask.none");
    expect(traceRootName(ASK_ARGV)).not.toContain("SSO");
  });

  it("keeps a known subcommand in the name (it is a real dimension)", () => {
    expect(traceRootName(["kb", "show", "kbdoc_SECRETID"])).toBe("mla.kb.show");
    expect(traceRootName(["kb", "show", "kbdoc_SECRETID"])).not.toContain("SECRETID");
  });

  it("collapses an unknown command and an empty argv", () => {
    expect(traceRootName(["/tmp/leaked-path.md"])).toBe("mla.unknown.none");
    expect(traceRootName([])).toBe("mla.help.none");
  });
});

describe("the whole flush payload carries no user content", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    resetRunTracerForTesting();
    setRunTraceId("");
    jest.clearAllMocks();
  });

  it("ships neither the question, nor a raw id, nor a query string to the relay", async () => {
    const traceId = "b".repeat(32);
    setRunTraceId(traceId);

    let captured: FlushPayload | null = null;
    const tracer = createRunTracer({
      traceId,
      rootName: traceRootName(ASK_ARGV),
      buildInfo: loadBuildInfo(),
      flushFn: async (payload) => {
        captured = payload;
      },
    });
    // Exactly what cli.ts stamps on the root before dispatch.
    tracer.root.setAttribute("command_shape", reduceArgvForSpan(ASK_ARGV));
    setRunTracer(tracer);

    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })) as any;

    // One call with a query string, one with an id-shaped path segment. Both
    // are ordinary traffic; both used to land verbatim in the `route`
    // attribute even though the span NAME already rolled them up.
    await controlGet(fakeCfg(), "/internal/v1/workspaces/me?workspaceId=ws_an_local");
    await controlGet(fakeCfg(), "/internal/v1/coordination-cases/cse_ABCD1234");

    tracer.endRoot({ status: "ok" });
    await tracer.flush();

    expect(captured).not.toBeNull();
    const wire = JSON.stringify(captured);

    // The reason this test exists.
    expect(wire).not.toContain(QUESTION);
    expect(wire).not.toContain("SSO");
    // The route attribute must carry the rollup, not the raw path.
    expect(wire).not.toContain("workspaceId=ws_an_local");
    expect(wire).not.toContain("cse_ABCD1234");
    expect(wire).not.toContain("/internal/v1/");

    // ...and the span is still USEFUL: the rollup, the method, the status and
    // the timing all survive. A reduction that deleted the diagnostic value
    // would pass the assertions above and be worthless.
    const payload = captured as unknown as FlushPayload;
    expect(payload.rootSpan.name).toBe("mla.ask.none");
    expect(payload.spans).toHaveLength(2);
    const routes = payload.spans.map((s) => s.attributes?.["route"]).sort();
    expect(routes).toEqual(["coordination-cases.:id", "workspaces.me"]);
    for (const child of payload.spans) {
      expect(child.attributes?.["http.method"]).toBe("GET");
      expect(child.attributes?.["http.status"]).toBe(200);
      expect(typeof child.attributes?.["latency_ms"]).toBe("number");
    }
  });
});

describe("the egress redactor is NOT a second net for this", () => {
  // The agent-traces egress rule marks rootSpan/spans "redact" and records, in
  // its own comment, that a span `name` survives because it is "short, low
  // entropy". That was an assumption about names, and for `mla ask` it was
  // false: the name was the user's whole question, which is long but has the
  // entropy of English.
  //
  // This test asserts the HOLE, deliberately. It exists so nobody deletes
  // traceRootName on the theory that egress catches it downstream. Egress does
  // not catch it. The safety of the span name is a CONSTRUCTION guarantee made
  // upstream by traceRootName, and this is the proof that it has to be.
  it("passes a prose span name straight through, question and all", () => {
    const leaky = {
      traceId: "d".repeat(32),
      workspaceId: "ws_an_local",
      client: { mlaVersion: "0.2.31", platform: "darwin" },
      rootSpan: {
        spanId: "0123456789abcdef",
        parentSpanId: null,
        name: `mla.ask.${QUESTION}`,
        startTime: "2026-08-02T00:00:00.000Z",
        endTime: "2026-08-02T00:00:01.000Z",
        status: "ok",
      },
      spans: [],
    };

    const sent = applyEgressPolicy(
      EGRESS_RULES,
      "control",
      "POST",
      "/internal/v1/agent-traces/ingest",
      leaky,
    );

    // Not a typo. The redactor leaves it entirely intact.
    expect(JSON.stringify(sent)).toContain(QUESTION);
  });

  it("and DOES scrub a token in the same position, which is why it looked sufficient", () => {
    // The contrast that made the old design feel safe: put a credential where
    // the question was and the redactor eats it. Secrets were never the leak.
    const withToken = {
      traceId: "d".repeat(32),
      workspaceId: "ws_an_local",
      client: { mlaVersion: "0.2.31", platform: "darwin" },
      rootSpan: {
        spanId: "0123456789abcdef",
        parentSpanId: null,
        name: "mla.init.none",
        startTime: "2026-08-02T00:00:00.000Z",
        endTime: "2026-08-02T00:00:01.000Z",
        status: "ok",
        attributes: { legacy_argv: ["init", "gh" + "p_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"] },
      },
      spans: [],
    };

    const sent = applyEgressPolicy(
      EGRESS_RULES,
      "control",
      "POST",
      "/internal/v1/agent-traces/ingest",
      withToken,
    );

    expect(JSON.stringify(sent)).not.toContain("gh" + "p_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });
});
