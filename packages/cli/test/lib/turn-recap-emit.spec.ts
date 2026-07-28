import { CliConfig } from "../../src/lib/config";
import { TurnRecap, renderFooter } from "../../src/lib/analytics/turn-recap";
import { FetchLike, postTurnRecapToIntel } from "../../src/lib/turn-recap-emit";

// Layer D emitter (notes/20260609-mla-per-turn-assist-recap-plan.md §4.4): POST a
// just-finished turn's recap to intel's /v1/observability/turn-recap so intel
// attaches the mla_ran / mla_assist Langfuse scores. The contract that matters:
//   - X-Trace-ID is pinned to the RECAP's trace id (the just-finished turn), NOT
//     the current run's, so header and body name the same trace and the endpoint's
//     mismatch guard is satisfied. (This is why the generic intelPost helper, which
//     stamps the run-local trace id, can't be reused here.)
//   - the body carries the verdict + footer + full recap intel needs to score.
//   - no trace id  -> no-op (nothing to attach a score to).
//   - best-effort  -> a non-2xx throws so the caller can swallow it.

const TRACE_ID = "0123456789abcdef0123456789abcdef";

function cfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    controlToken: "tok-123",
    intelUrl: "http://intel.test:9999",
    ...overrides,
  } as unknown as CliConfig;
}

function recapFixture(overrides: Partial<TurnRecap> = {}): TurnRecap {
  return {
    session_id: "sess-x",
    turn_index: 4,
    trace_id: TRACE_ID,
    ran: true,
    injected_floor: true,
    injected_evidence: true,
    not_run_reason: null,
    enrich_latency_ms: 321,
    evidence_offered: true,
    offered_source_ids: ["DD:abc"],
    zero_results: false,
    coverage_gap_type: null,
    evidence_layer_down: false,
    retrieved_count: null,
    selected_count: null,
    abstain_class: null,
    evidence_tools_pulled: ["retrieve_knowledge"],
    pull_count: 1,
    referenced_source_ids: ["DD:abc"],
    cited_source_ids: ["DD:abc"],
    verdict: "USED",
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  init: Parameters<FetchLike>[1];
}

function stubFetch(res: { ok: boolean; status?: number; text?: string }): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 500),
      text: async () => res.text ?? "",
    };
  };
  return { fetchImpl, calls };
}

describe("postTurnRecapToIntel", () => {
  it("POSTs to intel turn-recap with the recap's trace id pinned as X-Trace-ID", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true });
    const recap = recapFixture();

    await postTurnRecapToIntel(cfg(), recap, { fetchImpl });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("http://intel.test:9999/v1/observability/turn-recap");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // The whole point: header trace id == the just-finished turn's trace id.
    expect(init.headers["X-Trace-ID"]).toBe(TRACE_ID);

    const body = JSON.parse(init.body as string);
    expect(body.traceId).toBe(TRACE_ID);
    expect(body.sessionId).toBe("sess-x");
    expect(body.turnIndex).toBe(4);
    expect(body.verdict).toBe("USED");
    expect(body.footer).toBe(renderFooter(recap));
    expect(body.notRunReason).toBeNull();
    expect(body.recap).toEqual(recap);
  });

  // The egress rule for this route is `passthrough`, and a passthrough allowlist
  // only names TOP-LEVEL keys, so `recap` rides as one object: whatever is inside
  // it ships. The emitter therefore projects field by field instead of sending
  // `recap` whole, and this is the pin that makes adding a field a DECISION
  // rather than a side effect.
  //
  // The failure it is built for: someone adds a field to TurnRecap carrying turn
  // content (a prompt excerpt, a file body, an error string) and it reaches
  // intel's trace metadata because nothing asked. With this pin the new field
  // fails here first, and the fix is either "add it to the projection knowingly"
  // or "leave it local".
  //
  // Asserted against the emitted BODY, not against a copy of the source list, so
  // the pin cannot agree with a projection it never saw.
  it("pins the recap projection: exactly these keys reach intel", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true });
    await postTurnRecapToIntel(cfg(), recapFixture(), { fetchImpl });

    const body = JSON.parse(calls[0].init.body as string);
    expect(Object.keys(body.recap).sort()).toEqual([
      "abstain_class",
      "cited_source_ids",
      "coverage_gap_type",
      "enrich_latency_ms",
      "evidence_layer_down",
      "evidence_offered",
      "evidence_tools_pulled",
      "injected_evidence",
      "injected_floor",
      "not_run_reason",
      "offered_source_ids",
      "pull_count",
      "ran",
      "referenced_source_ids",
      "retrieved_count",
      "selected_count",
      "session_id",
      "trace_id",
      "turn_index",
      "verdict",
      "zero_results",
    ]);
    // And the top-level body keys, for the same reason: the passthrough row
    // allowlists these seven and nothing else.
    expect(Object.keys(body).sort()).toEqual([
      "footer",
      "notRunReason",
      "recap",
      "sessionId",
      "traceId",
      "turnIndex",
      "verdict",
    ]);
  });

  // A new TurnRecap field does NOT silently ride along. Simulated by handing the
  // emitter a recap carrying an extra field, exactly what a future edit to the
  // interface produces.
  it("omits a field the projection does not name", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true });
    const withExtra = {
      ...recapFixture(),
      raw_prompt_excerpt: "OPENAI_API_KEY=sk-proj-should-never-ship",
    } as unknown as TurnRecap;

    await postTurnRecapToIntel(cfg(), withExtra, { fetchImpl });

    const wire = calls[0].init.body as string;
    expect(wire).not.toContain("raw_prompt_excerpt");
    expect(wire).not.toContain("sk-proj-should-never-ship");
  });

  it("defaults to the local intel base url when cfg.intelUrl is unset", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true });
    await postTurnRecapToIntel(cfg({ intelUrl: undefined }), recapFixture(), {
      fetchImpl,
    });
    expect(calls[0].url).toBe(
      "http://127.0.0.1:8100/v1/observability/turn-recap",
    );
  });

  it("no-ops without calling fetch when the recap has no trace id", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true });
    await postTurnRecapToIntel(cfg(), recapFixture({ trace_id: null }), {
      fetchImpl,
    });
    expect(calls).toHaveLength(0);
  });

  it("throws on a non-2xx response (best-effort; the caller swallows it)", async () => {
    const { fetchImpl } = stubFetch({ ok: false, status: 503, text: "down" });
    await expect(
      postTurnRecapToIntel(cfg(), recapFixture(), { fetchImpl }),
    ).rejects.toThrow();
  });

  it("carries notRunReason + NOT_RUN through for a muted turn that still has a trace", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true });
    const recap = recapFixture({
      verdict: "NOT_RUN",
      not_run_reason: "muted",
      ran: false,
      injected_floor: false,
      injected_evidence: false,
      evidence_offered: false,
      offered_source_ids: [],
    });

    await postTurnRecapToIntel(cfg(), recap, { fetchImpl });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.verdict).toBe("NOT_RUN");
    expect(body.notRunReason).toBe("muted");
  });
});
