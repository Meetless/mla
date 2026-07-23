// One 0-byte file used to cost nine healthy notes their ingest.
//
// The intel route declares `content: str = Field(..., min_length=1)` INSIDE the request
// model (intel `app/api/routes/kb_add.py:119`), so an empty body is a pydantic
// REQUEST-validation error: FastAPI 422s the whole POST before the route function runs and
// not one document is processed. The CLI batched the corpus, so a single empty note took
// its entire batch down and every sibling was stamped `ingest_post_failed` with a reason
// describing a DIFFERENT file's emptiness. Verified against the real vault: two 0-byte
// notes, ten notes missing from the KB, nine of them perfectly healthy.
//
// These tests lock the two halves of the fix:
//   1. The client never sends an unsendable file. It skips it and NAMES it (`empty_file`),
//      without spending a batch or a health signal on it.
//   2. When the server does reject a batch at request validation, the offenders named in
//      the 422 are isolated and the survivors are re-sent. That retry is licensed by the
//      pre-handler trace (zero side effects); an AMBIGUOUS post-handler failure gets no
//      such retry, and the tests pin that asymmetry too.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  EMPTY_FILE_FAILURE_CODE,
  KB_ADD_BATCH_SIZE,
  enumerateDocuments,
  isIngestableContent,
  mergeSkippedReceipts,
  postDocumentsInBatches,
  stampMergedCorpusRollup,
  validationRejectedIndices,
} from "../../src/commands/kb_add";
import type { HttpError } from "../../src/lib/http";
import type { KbAddReceipt } from "../../src/lib/render";

type Doc = { relPath: string; content: string };

const CTX = {
  mode: "corpus" as const,
  workspaceId: "ws_1",
  provenance: "human_authored",
  now: () => "2026-07-22T00:00:00.000Z",
};

const CORPUS_FLAGS = {
  mode: "corpus" as const,
  path: "",
  provenance: "human_authored",
  allowProvenanceChange: false,
  queue: false,
  open: false,
  reingestIfActive: false,
};

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A vault of `n` healthy notes plus whatever unsendable bodies the caller names. */
function mkVault(prefix: string, healthy: number, unsendable: Record<string, string> = {}): string {
  const root = mkTmp(prefix);
  for (let i = 0; i < healthy; i++) fs.writeFileSync(path.join(root, `n${i}.md`), `body ${i}\n`);
  for (const [name, body] of Object.entries(unsendable)) fs.writeFileSync(path.join(root, name), body);
  return root;
}

/** A server that lands every document it is handed: one `ingested` receipt per doc, in order. */
function healthyServer(seen?: string[][]) {
  return jest.fn(async (body: unknown) => {
    const docs = (body as { documents: Doc[] }).documents;
    seen?.push(docs.map((d) => d.relPath));
    return {
      receipts: docs.map((d) => ({
        mode: "corpus",
        workspaceId: "ws_1",
        outcome: "ingested",
        documentId: `doc_${d.relPath}`,
        canonicalPath: d.relPath,
        parentUuid: "",
        provenance: "external_imported",
      })) as KbAddReceipt[],
    };
  });
}

/**
 * The REAL 422 this route produces. Intel replaces FastAPI's default handler with a
 * scrubbed projection that keeps exactly `type`, `loc`, `msg` (intel
 * `app/api/validation_errors.py:32,52`) — `loc` is what carries the offending document's
 * index, and dropping it is what would make isolation impossible. Reproduced faithfully
 * so this test fails if that contract ever changes.
 */
function pydantic422(offendingIndices: number[]): HttpError {
  const e = new Error("POST /internal/v1/kb/add -> HTTP 422") as HttpError;
  e.status = 422;
  e.body = JSON.stringify({
    detail: offendingIndices.map((i) => ({
      type: "string_too_short",
      loc: ["body", "documents", i, "content"],
      msg: "String should have at least 1 character",
    })),
  });
  return e;
}

describe("kb add: an unsendable file is skipped and named, never sent", () => {
  test("isIngestableContent refuses empty and whitespace-only bodies", () => {
    expect(isIngestableContent("")).toBe(false);
    expect(isIngestableContent("\n \t\n")).toBe(false);
    expect(isIngestableContent("#")).toBe(true);
  });

  test("enumeration partitions 0-byte files out instead of loading the batch with a guaranteed 422", () => {
    const root = mkVault("mla-empty-enum-", 3, { "empty.md": "", "blank.md": "\n\n" });

    const { documents, skipped } = enumerateDocuments({ ...CORPUS_FLAGS, path: root }, root, root, null);

    expect(documents.map((d) => d.relPath).sort()).toEqual(["n0.md", "n1.md", "n2.md"]);
    expect(skipped.map((s) => s.relPath).sort()).toEqual(["blank.md", "empty.md"]);
    // The reason has to name the actual defect, because the operator's next action is to
    // open that file. "a batch failed" is not an action.
    expect(skipped.find((s) => s.relPath === "empty.md")?.reason).toMatch(/0 bytes/);
  });

  test("the skipped file gets its own `empty_file` receipt and its batch still lands", async () => {
    const root = mkVault("mla-empty-batch-", 4, { "empty.md": "" });
    const seen: string[][] = [];
    const post = healthyServer(seen);

    const { documents, skipped } = enumerateDocuments({ ...CORPUS_FLAGS, path: root }, root, root, null);
    const posted = await postDocumentsInBatches(documents, {}, { ...CTX, post });
    const receipts = mergeSkippedReceipts(posted.receipts, skipped, CTX);

    // The empty file never touched the wire — that is the whole fix.
    expect(seen.flat()).not.toContain("empty.md");
    // ...and none of its siblings paid for it.
    expect(posted.errors).toEqual([]);
    expect(receipts.filter((r) => r.outcome === "ingested").map((r) => r.canonicalPath).sort()).toEqual(["n0.md", "n1.md", "n2.md", "n3.md"]);

    const skip = receipts.find((r) => r.canonicalPath === "empty.md");
    expect(skip?.outcome).toBe("failed");
    expect(skip?.failure?.code).toBe(EMPTY_FILE_FAILURE_CODE);
    expect(skip?.failure?.failedAt).toBe("2026-07-22T00:00:00.000Z");
  });

  test("skipped receipts splice back into enumeration order, so the rollup reads like the vault", async () => {
    // "empty.md" sorts first in the glob, so it is index 0 of the enumeration. Appending
    // its receipt at the end would make the rollup disagree with the folder listing the
    // operator is reading it against.
    const root = mkVault("mla-empty-order-", 2, { "empty.md": "" });
    const { documents, skipped } = enumerateDocuments({ ...CORPUS_FLAGS, path: root }, root, root, null);
    const posted = await postDocumentsInBatches(documents, {}, { ...CTX, post: healthyServer() });

    const receipts = mergeSkippedReceipts(posted.receipts, skipped, CTX);
    stampMergedCorpusRollup(receipts, "vault", root);

    expect(receipts.map((r) => r.canonicalPath)).toEqual(["empty.md", "n0.md", "n1.md"]);
    expect(receipts[0].corpus).toMatchObject({ ingested: 2, failed: 1, noChange: 0 });
    expect(receipts[0].corpus?.perDoc[0]).toMatchObject({ canonicalPath: "empty.md", outcome: "failed", failureCode: EMPTY_FILE_FAILURE_CODE });
  });

  test("a skipped empty never counts as a transport failure, so it cannot trip the down-server abort", async () => {
    // One empty file per batch, across enough batches to blow past
    // MAX_CONSECUTIVE_BATCH_FAILURES twice over. If skips were routed through the batching
    // loop's failure path, the run would give up after two batches and stamp the rest
    // `ingest_not_attempted` — reporting a healthy server as dead.
    const healthyPerBatch = KB_ADD_BATCH_SIZE;
    const batches = 6;
    const unsendable: Record<string, string> = {};
    for (let b = 0; b < batches; b++) unsendable[`zz-empty-${b}.md`] = "";
    const root = mkVault("mla-empty-abort-", healthyPerBatch * batches, unsendable);

    const post = healthyServer();
    const { documents, skipped } = enumerateDocuments({ ...CORPUS_FLAGS, path: root }, root, root, null);
    const posted = await postDocumentsInBatches(documents, {}, { ...CTX, post });
    const receipts = mergeSkippedReceipts(posted.receipts, skipped, CTX);

    expect(skipped).toHaveLength(batches);
    expect(post).toHaveBeenCalledTimes(Math.ceil(documents.length / KB_ADD_BATCH_SIZE));
    expect(receipts.filter((r) => r.failure?.code === "ingest_not_attempted")).toHaveLength(0);
    expect(receipts.filter((r) => r.outcome === "ingested")).toHaveLength(healthyPerBatch * batches);
    expect(receipts.filter((r) => r.failure?.code === EMPTY_FILE_FAILURE_CODE)).toHaveLength(batches);
  });
});

describe("kb add: a request-validation rejection fails only the documents it names", () => {
  test("validationRejectedIndices reads the offending index out of the scrubbed 422 body", () => {
    expect(validationRejectedIndices(pydantic422([2]), 5)).toEqual([2]);
    // Pydantic reports every error in one response, which is why one isolation round is enough.
    expect(validationRejectedIndices(pydantic422([0, 3]), 5)).toEqual([0, 3]);
  });

  test("validationRejectedIndices refuses to guess when the body does not blame a document", () => {
    const routeLevel = Object.assign(new Error("422"), { status: 422, body: JSON.stringify({ detail: "unsupported captureMethod='typo'" }) });
    expect(validationRejectedIndices(routeLevel, 5)).toBeNull();

    const requestLevel = Object.assign(new Error("422"), {
      status: 422,
      body: JSON.stringify({ detail: [{ type: "string_too_short", loc: ["body", "workspaceId"], msg: "too short" }] }),
    });
    expect(validationRejectedIndices(requestLevel, 5)).toBeNull();

    // An index outside the batch we sent means the body is not about our request.
    expect(validationRejectedIndices(pydantic422([9]), 5)).toBeNull();
    // A 5xx carries no per-document verdict at all.
    expect(validationRejectedIndices(Object.assign(new Error("500"), { status: 500, body: "boom" }), 5)).toBeNull();
    expect(validationRejectedIndices(new Error("ECONNREFUSED"), 5)).toBeNull();
  });

  test("the healthy siblings of a rejected document still ingest", async () => {
    // The server rejects the batch outright on the first attempt (as FastAPI does), naming
    // document 1. The retry — legal because a pre-handler 422 committed nothing — carries
    // the survivors only.
    const healthy = healthyServer();
    let call = 0;
    const post = jest.fn(async (body: unknown) => {
      call += 1;
      if (call === 1) throw pydantic422([1]);
      return healthy(body);
    });

    const docs: Doc[] = Array.from({ length: KB_ADD_BATCH_SIZE }, (_, i) => ({ relPath: `n${i}.md`, content: i === 1 ? "" : `body ${i}` }));
    const { receipts } = await postDocumentsInBatches(docs, {}, { ...CTX, post });

    expect(post).toHaveBeenCalledTimes(2);
    expect(receipts).toHaveLength(docs.length);
    // Receipts stay aligned to input order even though the retry sent a shorter list.
    expect(receipts.map((r) => r.canonicalPath)).toEqual(docs.map((d) => d.relPath));
    expect(receipts[1].outcome).toBe("failed");
    expect(receipts[1].failure?.code).toBe("ingest_rejected_invalid");
    expect(receipts.filter((r) => r.outcome === "ingested")).toHaveLength(docs.length - 1);
  });

  test("a 422 is not evidence the server is down, so later batches are still attempted", async () => {
    // A request-level 422 (nothing to isolate) fails every batch. It must NOT trip the
    // down-server abort: the server answered, immediately, so there is no budget to
    // protect and `ingest_not_attempted` would be a lie about why the documents are missing.
    const err = Object.assign(new Error("422"), { status: 422, body: JSON.stringify({ detail: [{ type: "missing", loc: ["body", "actor"], msg: "Field required" }] }) });
    const post = jest.fn().mockRejectedValue(err);
    const docs: Doc[] = Array.from({ length: KB_ADD_BATCH_SIZE * 4 }, (_, i) => ({ relPath: `n${i}.md`, content: `body ${i}` }));

    const { receipts } = await postDocumentsInBatches(docs, {}, { ...CTX, post });

    expect(post).toHaveBeenCalledTimes(4);
    expect(receipts.every((r) => r.failure?.code === "ingest_rejected_invalid")).toBe(true);
  });

  test("an ambiguous post-handler failure is NOT auto-retried", async () => {
    // The route commits each document independently (`kb_add.py:595`, per-doc faults caught
    // at :607-619), so a 5xx or a severed connection can leave part of the batch governed.
    // Retrying under that ambiguity is how you turn "some landed" into "we think it is
    // fine": a revision minted but never activated dedups back as `noop_unchanged`.
    const post = jest.fn().mockRejectedValue(Object.assign(new Error("503 Service Unavailable"), { status: 503, body: "" }));
    const docs: Doc[] = Array.from({ length: 3 }, (_, i) => ({ relPath: `n${i}.md`, content: `body ${i}` }));

    const { receipts, errors } = await postDocumentsInBatches(docs, {}, { ...CTX, post });

    expect(post).toHaveBeenCalledTimes(1); // one attempt, no bisection
    expect(errors).toHaveLength(1);
    expect(receipts.every((r) => r.failure?.code === "ingest_post_failed")).toBe(true);
    expect(receipts[0].failure?.reason).toMatch(/Not auto-retried/);
    // The suspects are named: with an ambiguous failure these are exactly the documents
    // whose state the operator cannot infer.
    expect(receipts[0].failure?.reason).toContain("n0.md");
    expect(receipts[0].failure?.reason).toContain("n2.md");
  });

  test("a 422 whose retry also fails ambiguously reports the survivors honestly", async () => {
    const post = jest
      .fn()
      .mockRejectedValueOnce(pydantic422([0]))
      .mockRejectedValueOnce(Object.assign(new Error("504 Gateway Timeout"), { status: 504, body: "" }));
    const docs: Doc[] = [
      { relPath: "bad.md", content: "" },
      { relPath: "a.md", content: "A" },
      { relPath: "b.md", content: "B" },
    ];

    const { receipts } = await postDocumentsInBatches(docs, {}, { ...CTX, post });

    expect(receipts[0].failure?.code).toBe("ingest_rejected_invalid");
    expect(receipts[1].failure?.code).toBe("ingest_post_failed");
    expect(receipts[2].failure?.code).toBe("ingest_post_failed");
    // The transport half of that batch DID die, so the down-server counter must have moved.
    expect(post).toHaveBeenCalledTimes(2);
  });
});
