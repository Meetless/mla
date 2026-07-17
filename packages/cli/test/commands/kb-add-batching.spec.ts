// A corpus ingest is not one atomic act, and this client used to pretend it was.
//
// `mla kb add --mode corpus` sent the whole vault in ONE POST whose timeout was 20s per
// document. Intel sits behind a HARD 300s Cloud Run ceiling, so at 16 documents the
// client was already asking for longer than the server is ever permitted to take. Past
// the ceiling the connection dies mid-write, and the old code answered by printing
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
import type { KbAddReceipt } from "../../src/lib/render";

type Doc = { relPath: string; content: string };

const nDocs = (n: number): Doc[] => Array.from({ length: n }, (_, i) => ({ relPath: `notes/n${i}.md`, content: `body ${i}` }));

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

describe("kb add corpus: batched ingest (a dead batch must not erase what landed)", () => {
  it("splits the corpus into bounded POSTs instead of one request the server cannot honor", async () => {
    const sizes: number[] = [];
    const post = healthyServer((docs) => sizes.push(docs.length));

    const { receipts, errors } = await postDocumentsInBatches(nDocs(25), { workspaceId: "ws_1" }, { ...CTX, post });

    expect(sizes).toEqual([KB_ADD_BATCH_SIZE, KB_ADD_BATCH_SIZE, 5]);
    expect(receipts).toHaveLength(25);
    expect(errors).toEqual([]);
    expect(receipts.every((r) => r.outcome === "ingested")).toBe(true);
  });

  it("bounds every request under the 300s server ceiling, which is the whole point", async () => {
    const timeouts: number[] = [];
    const server = healthyServer();
    const post = jest.fn(async (body: unknown, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      return server(body);
    });

    await postDocumentsInBatches(nDocs(60), {}, { ...CTX, post });

    // 20s/doc * 10 = 200s, a full 100s of margin under Cloud Run's hard 300s wall. The
    // old single POST asked for 1200s here and was killed by the platform every time.
    expect(Math.max(...timeouts)).toBeLessThan(300_000);
  });

  it("keeps the documents that landed when a later batch dies", async () => {
    const post = jest
      .fn()
      .mockImplementationOnce(healthyServer())
      .mockRejectedValueOnce(new Error("504 Gateway Timeout"))
      .mockImplementationOnce(healthyServer());

    const { receipts, errors } = await postDocumentsInBatches(nDocs(25), {}, { ...CTX, post });

    // The old code returned NOTHING here and told the operator the run failed outright.
    const landed = receipts.filter((r) => r.outcome === "ingested");
    expect(landed).toHaveLength(15);
    expect(errors).toHaveLength(1);

    // And the ten that died are NAMED, by path, so the operator can see the hole in
    // their KB rather than believing an empty one.
    const lost = receipts.filter((r) => r.outcome === "failed").map((r) => r.canonicalPath);
    expect(lost).toEqual(nDocs(20).slice(10).map((d) => d.relPath));
  });

  it("carries the real transport cause onto every document the dead batch was holding", async () => {
    const post = jest.fn().mockRejectedValue(new Error("504 Gateway Timeout"));

    const { receipts } = await postDocumentsInBatches(nDocs(5), {}, { ...CTX, post });

    expect(receipts[0].failure).toEqual({
      code: "ingest_post_failed",
      reason: "504 Gateway Timeout",
      failedAt: "2026-07-14T00:00:00.000Z",
    });
  });

  it("keeps going past a single poison batch rather than abandoning the corpus", async () => {
    const post = jest
      .fn()
      .mockRejectedValueOnce(new Error("500 boom"))
      .mockImplementationOnce(healthyServer())
      .mockImplementationOnce(healthyServer());

    const { receipts } = await postDocumentsInBatches(nDocs(25), {}, { ...CTX, post });

    expect(post).toHaveBeenCalledTimes(3);
    expect(receipts.filter((r) => r.outcome === "ingested")).toHaveLength(15);
  });

  it("stops hammering a server that is simply down, and says what it never attempted", async () => {
    const post = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { receipts } = await postDocumentsInBatches(nDocs(50), {}, { ...CTX, post });

    // Two consecutive failures is a down server, not a bad batch. Proving it costs a
    // 200s timeout per remaining batch: without this the operator waits ~15 minutes to
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

    const docs = nDocs(25);
    const flaky = jest.fn().mockImplementationOnce(post).mockRejectedValueOnce(new Error("504")).mockImplementationOnce(post);
    const first = await postDocumentsInBatches(docs, {}, { ...CTX, post: flaky });
    expect(first.receipts.filter((r) => r.outcome === "failed")).toHaveLength(10);

    const second = await postDocumentsInBatches(docs, {}, { ...CTX, post });

    expect(second.receipts.filter((r) => r.outcome === "failed")).toHaveLength(0);
    // The 15 already-governed docs cost nothing to re-deliver; only the 10 that were
    // lost are actually ingested. The corpus converges.
    expect(second.receipts.filter((r) => r.outcome === "noop_unchanged")).toHaveLength(15);
    expect(second.receipts.filter((r) => r.outcome === "ingested")).toHaveLength(10);
  });
});

describe("kb add corpus: the rollup the operator reads must count the whole run", () => {
  it("collapses the per-response partial rollups into one true total", async () => {
    const post = jest.fn().mockImplementationOnce(healthyServer()).mockRejectedValueOnce(new Error("504")).mockImplementationOnce(healthyServer());
    const { receipts } = await postDocumentsInBatches(nDocs(25), {}, { ...CTX, post });

    stampMergedCorpusRollup(receipts, "vault", "/notes");

    // Without this, three responses mean three "totals" lines and none of them is the
    // total: the operator reads `ingested: 10` on a 25-document run.
    expect(receipts.filter((r) => r.corpus)).toHaveLength(1);
    expect(receipts[0].corpus).toMatchObject({ corpusName: "vault", rootPath: "/notes", ingested: 15, noChange: 0, failed: 10, restored: 0 });
    expect(receipts[0].corpus?.perDoc).toHaveLength(25);
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
