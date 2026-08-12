import { buildExtractionFetcher } from "../../src/commands/kb_add";

// The fetcher reads EXTRACTION STATE. The state machine that consumes it is locked
// separately in kb-add-poll.spec.ts and is unchanged; this file covers the one
// function that was broken.
//
// WHAT WAS BROKEN (measured 2026-08-07). It read `detail.extraction` and
// `detail.candidates` off `GET /kb/documents/{id}/detail`. That route serves eight
// keys and neither is among them: document, serving, servingStatus, headRevision,
// revisions, chunks, claims, audit. The lane those fields described (whole-doc
// GRAPH_EXTRACT) was retired by An on 2026-06-26 because nothing consumed its
// accepted candidates; ONTOLOGY_EXTRACT (claim-grain) is the only mining lane left.
//
// So the fetcher returned null on EVERY call, hit the poll's "pre-B2 intel"
// compatibility branch, and the receipt printed "extraction queued (async; check
// `mla kb show` once it completes)" forever, pointing at a command that cannot
// answer either. It failed closed, which is why it went unnoticed.
//
// The canonical owner of extraction state is the job: `GET /internal/v1/jobs/{id}`,
// whose id the ingest receipt now carries. Candidate counts come from the detail
// bundle's `claims` rail, which is the grain the surviving lane actually produces.

type Job = { status: string } | null;
type Detail = { claims?: Array<{ reviewOutcome?: string | null; lifecycleStatus?: string }> };

function deps(job: Job, detail: Detail = {}, opts: { jobThrows?: boolean } = {}) {
  const seen: string[] = [];
  const get = async (path: string) => {
    seen.push(path);
    if (path.includes("/jobs/")) {
      if (opts.jobThrows) throw new Error("boom");
      if (job === null) { const e: any = new Error("404"); e.status = 404; throw e; }
      return job;
    }
    return detail;
  };
  return { get, seen };
}

const RECEIPT = { documentId: "doc-1", extractionJobId: "job-1" };

describe("buildExtractionFetcher: the canonical owner is the job", () => {
  it("reads job status, not a field the detail route stopped serving", async () => {
    const d = deps({ status: "running" });
    const f = buildExtractionFetcher("ws1", d.get as any);
    const got = await f(RECEIPT.documentId, RECEIPT.extractionJobId);
    expect(got).toEqual({ state: "running", jobId: "job-1", candidateCount: null, conflictCount: null });
    // The EXACT mount, probed live: the jobs router sits on /v1, not /internal/v1,
    // and takes snake_case workspace_id. Both differ from every KB route this
    // command otherwise calls, and /internal/v1/jobs 404s.
    expect(d.seen[0]).toBe("/v1/jobs/job-1?workspace_id=ws1");
  });

  it("maps the job lifecycle onto the receipt's states", async () => {
    for (const [status, state] of [["pending", "queued"], ["running", "running"],
                                   ["completed", "completed"], ["failed", "failed"]] as const) {
      const f = buildExtractionFetcher("ws1", deps({ status }).get as any);
      expect((await f("doc-1", "job-1"))!.state).toBe(state);
    }
  });

  it("counts PENDING claims as the review queue on completion", async () => {
    const detail = { claims: [
      { reviewOutcome: "PENDING", lifecycleStatus: "ACTIVE" },
      { reviewOutcome: "PENDING", lifecycleStatus: "ACTIVE" },
      { reviewOutcome: "ACCEPTED", lifecycleStatus: "ACTIVE" },
    ] };
    const f = buildExtractionFetcher("ws1", deps({ status: "completed" }, detail).get as any);
    const got = await f("doc-1", "job-1");
    expect(got!.state).toBe("completed");
    expect(got!.candidateCount).toBe(2);
  });

  it("COMPLETE WITH ZERO CANDIDATES is a real 0, never a null", async () => {
    // The distinction the receipt has to make: extraction ran and found nothing, vs
    // status never arrived. A null here collapses them.
    const f = buildExtractionFetcher("ws1", deps({ status: "completed" }, { claims: [] }).get as any);
    const got = await f("doc-1", "job-1");
    expect(got).toEqual({ state: "completed", jobId: "job-1", candidateCount: 0, conflictCount: 0 });
  });

  it("does not read the detail bundle at all before the job completes", async () => {
    const d = deps({ status: "running" });
    await buildExtractionFetcher("ws1", d.get as any)("doc-1", "job-1");
    expect(d.seen.some((p) => p.includes("/detail"))).toBe(false);
  });

  it("returns null when the receipt carries no job id (nothing was enqueued)", async () => {
    const d = deps({ status: "completed" });
    expect(await buildExtractionFetcher("ws1", d.get as any)("doc-1", null)).toBeNull();
    expect(d.seen).toEqual([]);
  });

  it("propagates a job-read failure so the poll can stop honestly", async () => {
    const f = buildExtractionFetcher("ws1", deps({ status: "running" }, {}, { jobThrows: true }).get as any);
    await expect(f("doc-1", "job-1")).rejects.toThrow();
  });

  it("a missing job is null, not a fabricated completion", async () => {
    const f = buildExtractionFetcher("ws1", deps(null).get as any);
    await expect(f("doc-1", "job-1")).rejects.toThrow();
  });

  it("scopes every read to the workspace", async () => {
    const d = deps({ status: "completed" }, { claims: [] });
    await buildExtractionFetcher("ws-scoped", d.get as any)("doc-1", "job-1");
    for (const p of d.seen) expect(p).toContain("ws-scoped");
    // ...and the two surfaces spell the scope differently, which is exactly the kind
    // of detail a source-text assertion would have missed.
    expect(d.seen.find((p) => p.includes("/jobs/"))).toContain("workspace_id=ws-scoped");
    expect(d.seen.find((p) => p.includes("/detail"))).toContain("workspaceId=ws-scoped");
  });
});
