// A corpus ingest is not one atomic act, and this client used to pretend it was.
//
// `mla kb add --mode corpus` sent the whole vault in ONE POST whose timeout was 20s per
// document. Intel is Cloudflare-proxied, and the edge severs an origin response at 100s, so
// at 6 documents the client was already asking for longer than the request is ever permitted
// to live. Past that wall the connection dies mid-write, and the old code answered by printing
// `kb add failed`, discarding the entire response, and returning 1. Documents HAD landed.
// The operator was told none had, was given no way to learn which, and had no run record
// to resume from. A corpus over ~15 files was structurally unshippable, and got worse the
// more notes you wrote. This is the exact shape that destroyed a real onboarding.
//
// These tests lock the batching that replaces it. The load-bearing property is not
// "we send several requests" (that is the mechanism); it is that PARTIAL PROGRESS IS
// KEPT AND NAMED. Every document comes back with a receipt saying whether it landed, so
// a rerun re-delivers the survivors as cheap `noop_unchanged` upserts and retries only
// what is genuinely missing. Progress becomes monotonic and a big corpus converges.

import { KB_ADD_BATCH_SIZE, postDocumentsInBatches, stampMergedCorpusRollup } from "../../src/commands/kb_add";
import { EDGE_ORIGIN_TIMEOUT_MS } from "../../src/lib/intel-ingest-budget";
import type { KbAddReceipt } from "../../src/lib/render";

type Doc = { relPath: string; content: string };

const nDocs = (n: number): Doc[] => Array.from({ length: n }, (_, i) => ({ relPath: `notes/n${i}.md`, content: `body ${i}` }));

// The corpus used by every batching test below, and the layout the batch size implies for it.
// Derived, never written out: KB_ADD_BATCH_SIZE is a MEASURED number that has already moved
// once (10 -> 5, when the binding ceiling turned out to be Cloudflare's 100s rather than Cloud
// Run's 300s). A test that scripts "the poster is called exactly three times" is not testing
// batching, it is testing that nobody re-measured.
const CORPUS = 25;
const BATCHES = Math.ceil(CORPUS / KB_ADD_BATCH_SIZE);
const nthBatch = (i: number): Doc[] => nDocs(CORPUS).slice(i * KB_ADD_BATCH_SIZE, (i + 1) * KB_ADD_BATCH_SIZE);

const CTX = {
  mode: "corpus" as const,
  workspaceId: "ws_1",
  provenance: "human_authored",
  now: () => "2026-07-14T00:00:00.000Z",
};

/** A server that lands every document it is handed: one `ingested` receipt per doc, in order. */
function healthyServer(onCall?: (docs: Doc[]) => void) {
  return jest.fn(async (body: unknown) => {
    const docs = (body as { documents: Doc[] }).documents;
    onCall?.(docs);
    return {
      receipts: docs.map((d, i) => ({
        mode: "corpus",
        workspaceId: "ws_1",
        outcome: "ingested",
        documentId: `doc_${d.relPath}`,
        canonicalPath: d.relPath,
        parentUuid: "",
        provenance: "human_authored",
        // The server stamps its rollup on the FIRST receipt of every response, which is
        // why a batched corpus comes back with several partial ones to reconcile.
        ...(i === 0 ? { corpus: { corpusName: "vault", rootPath: "", ingested: docs.length, restored: 0, noChange: 0, failed: 0, perDoc: [] } } : {}),
      })) as KbAddReceipt[],
    };
  });
}

/**
 * A server that is healthy except on the given 0-based BATCH indexes, where it dies with
 * `err`. Selecting the casualty by batch index rather than by scripting one
 * `mockImplementationOnce` per call is what lets these tests survive a change to the batch
 * size: "the second batch dies" stays the second batch whether that is 5 documents or 10.
 */
function serverFailingOnBatches(indexes: number[], err = new Error("504 Gateway Timeout")) {
  const healthy = healthyServer();
  let call = -1;
  return jest.fn(async (body: unknown) => {
    call += 1;
    if (indexes.includes(call)) throw err;
    return healthy(body);
  });
}

describe("kb add corpus: batched ingest (a dead batch must not erase what landed)", () => {
  it("splits the corpus into bounded POSTs instead of one request the server cannot honor", async () => {
    const sizes: number[] = [];
    const post = healthyServer((docs) => sizes.push(docs.length));

    const { receipts, errors } = await postDocumentsInBatches(nDocs(CORPUS), { workspaceId: "ws_1" }, { ...CTX, post });

    expect(sizes).toEqual(Array.from({ length: BATCHES }, (_, i) => nthBatch(i).length));
    expect(sizes.every((n) => n <= KB_ADD_BATCH_SIZE)).toBe(true);
    expect(sizes.length).toBeGreaterThan(1); // it batched at all
    expect(receipts).toHaveLength(CORPUS);
    expect(errors).toEqual([]);
    expect(receipts.every((r) => r.outcome === "ingested")).toBe(true);
  });

  it("bounds every request under the ceiling that actually fires, which is the whole point", async () => {
    const timeouts: number[] = [];
    const server = healthyServer();
    const post = jest.fn(async (body: unknown, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      return server(body);
    });

    await postDocumentsInBatches(nDocs(60), {}, { ...CTX, post });

    // The wall to clear is Cloudflare's origin-response timeout, NOT Cloud Run's 300s: intel
    // is proxied, so the edge severs the request 200s before the origin would. This assertion
    // used to read `< 300_000` and passed happily on a budget of 200s, which is 100s PAST the
    // ceiling that fires. A bound checked against the looser of two ceilings bounds nothing.
    expect(Math.max(...timeouts)).toBeLessThan(EDGE_ORIGIN_TIMEOUT_MS);
  });

  it("keeps the documents that landed when a later batch dies", async () => {
    const post = serverFailingOnBatches([1]);

    const { receipts, errors } = await postDocumentsInBatches(nDocs(CORPUS), {}, { ...CTX, post });

    // The old code returned NOTHING here and told the operator the run failed outright.
    const landed = receipts.filter((r) => r.outcome === "ingested");
    expect(landed).toHaveLength(CORPUS - KB_ADD_BATCH_SIZE);
    expect(errors).toHaveLength(1);

    // And the ones that died are NAMED, by path, so the operator can see the hole in
    // their KB rather than believing an empty one.
    const lost = receipts.filter((r) => r.outcome === "failed").map((r) => r.canonicalPath);
    expect(lost).toEqual(nthBatch(1).map((d) => d.relPath));
  });

  it("carries the real transport cause onto every document the dead batch was holding", async () => {
    const post = jest.fn().mockRejectedValue(new Error("504 Gateway Timeout"));

    const { receipts } = await postDocumentsInBatches(nDocs(5), {}, { ...CTX, post });

    expect(receipts[0].failure?.code).toBe("ingest_post_failed");
    expect(receipts[0].failure?.failedAt).toBe("2026-07-14T00:00:00.000Z");
    expect(receipts[0].failure?.reason).toMatch(/^504 Gateway Timeout/);
    // An ambiguous post-handler failure is NOT auto-retried (the route commits each
    // document independently, so this batch may be half-governed). The receipt has to
    // say so, and name the documents whose fate is unknown, or the operator has no way
    // to tell "nothing landed" from "some landed".
    expect(receipts[0].failure?.reason).toMatch(/Not auto-retried/);
    expect(receipts[0].failure?.reason).toContain("notes/n0.md");
  });

  it("keeps going past a single poison batch rather than abandoning the corpus", async () => {
    const post = serverFailingOnBatches([0], new Error("500 boom"));

    const { receipts } = await postDocumentsInBatches(nDocs(CORPUS), {}, { ...CTX, post });

    // Every remaining batch is still attempted, and everything but the poison one lands.
    expect(post).toHaveBeenCalledTimes(BATCHES);
    expect(receipts.filter((r) => r.outcome === "ingested")).toHaveLength(CORPUS - KB_ADD_BATCH_SIZE);
  });

  it("stops hammering a server that is simply down, and says what it never attempted", async () => {
    const post = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { receipts } = await postDocumentsInBatches(nDocs(50), {}, { ...CTX, post });

    // Two consecutive failures is a down server, not a bad batch. Proving it costs a full
    // request budget per remaining batch: without this the operator waits many minutes to
    // be told what the second failure already knew.
    expect(post).toHaveBeenCalledTimes(2);
    expect(receipts).toHaveLength(50);
    expect(receipts.every((r) => r.outcome === "failed")).toBe(true);
    expect(receipts[45].failure?.code).toBe("ingest_not_attempted");
  });

  it("fails a batch whose receipt count does not match, rather than mis-attributing an outcome to a file", async () => {
    // A short response leaves us unable to say which receipt belongs to which document.
    // Guessing would report a file as governed when it is not, which is the one lie a
    // receipt may never tell.
    const post = jest.fn(async () => ({ receipts: [{ outcome: "ingested", canonicalPath: "notes/n0.md" }] as unknown as KbAddReceipt[] }));

    const { receipts, errors } = await postDocumentsInBatches(nDocs(3), {}, { ...CTX, post });

    expect(errors[0]).toMatch(/returned 1 receipt\(s\) for 3 document\(s\)/);
    expect(receipts.every((r) => r.outcome === "failed")).toBe(true);
  });

  it("resumes: a rerun re-delivers the survivors as cheap no-ops and finishes the hole", async () => {
    // The governed front door is an idempotent per-document upsert with no reconciliation
    // pass, so re-sending a landed document is free and re-sending a missing one fixes it.
    // That is what makes a partial run safe to simply run again.
    const store = new Set<string>();
    const post = jest.fn(async (body: unknown) => {
      const docs = (body as { documents: Doc[] }).documents;
      return {
        receipts: docs.map((d) => {
          const seen = store.has(d.relPath);
          store.add(d.relPath);
          return { mode: "corpus", workspaceId: "ws_1", outcome: seen ? "noop_unchanged" : "ingested", documentId: `doc_${d.relPath}`, canonicalPath: d.relPath, parentUuid: "", provenance: "human_authored" };
        }) as KbAddReceipt[],
      };
    });

    const docs = nDocs(CORPUS);
    let call = -1;
    const flaky = jest.fn(async (body: unknown) => {
      call += 1;
      if (call === 1) throw new Error("504");
      return post(body);
    });
    const first = await postDocumentsInBatches(docs, {}, { ...CTX, post: flaky });
    expect(first.receipts.filter((r) => r.outcome === "failed")).toHaveLength(KB_ADD_BATCH_SIZE);

    const second = await postDocumentsInBatches(docs, {}, { ...CTX, post });

    expect(second.receipts.filter((r) => r.outcome === "failed")).toHaveLength(0);
    // The already-governed docs cost nothing to re-deliver; only the ones that were lost are
    // actually ingested. The corpus converges.
    expect(second.receipts.filter((r) => r.outcome === "noop_unchanged")).toHaveLength(CORPUS - KB_ADD_BATCH_SIZE);
    expect(second.receipts.filter((r) => r.outcome === "ingested")).toHaveLength(KB_ADD_BATCH_SIZE);
  });
});

describe("kb add corpus: the rollup the operator reads must count the whole run", () => {
  it("collapses the per-response partial rollups into one true total", async () => {
    const post = serverFailingOnBatches([1]);
    const { receipts } = await postDocumentsInBatches(nDocs(CORPUS), {}, { ...CTX, post });

    stampMergedCorpusRollup(receipts, "vault", "/notes");

    // Without this, N responses mean N "totals" lines and none of them is the total: the
    // operator reads one batch's `ingested` count as the whole run's.
    expect(receipts.filter((r) => r.corpus)).toHaveLength(1);
    expect(receipts[0].corpus).toMatchObject({
      corpusName: "vault",
      rootPath: "/notes",
      ingested: CORPUS - KB_ADD_BATCH_SIZE,
      noChange: 0,
      failed: KB_ADD_BATCH_SIZE,
      restored: 0,
    });
    expect(receipts[0].corpus?.perDoc).toHaveLength(CORPUS);
  });

  it("names the failed documents in perDoc with their failure code", async () => {
    const post = jest.fn().mockRejectedValue(new Error("504 Gateway Timeout"));
    const { receipts } = await postDocumentsInBatches(nDocs(3), {}, { ...CTX, post });

    stampMergedCorpusRollup(receipts, "vault", "/notes");

    expect(receipts[0].corpus?.perDoc).toEqual([
      { canonicalPath: "notes/n0.md", outcome: "failed", revisionId: null, chunkCount: null, failureCode: "ingest_post_failed" },
      { canonicalPath: "notes/n1.md", outcome: "failed", revisionId: null, chunkCount: null, failureCode: "ingest_post_failed" },
      { canonicalPath: "notes/n2.md", outcome: "failed", revisionId: null, chunkCount: null, failureCode: "ingest_post_failed" },
    ]);
  });
});
