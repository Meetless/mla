// A client-side egress refusal is a LOCAL VERDICT, and this client used to file it
// as a server outage.
//
// `/internal/v1/kb/add` is `block_on_detect`: the boundary scans every string leaf and
// THROWS before the network when the high-confidence denylist fires. That throw is an
// `EgressPolicyError`, which carries no `.status`, so `httpStatusOf(e)` returns
// `undefined` and the batching loop's careful 422-vs-ambiguous reasoning classified it
// as "the post died in transit". Three consequences, all measured against the real vault
// (2094 notes) before any of this was written:
//
//   1. one refused note failed its whole batch of 5, and the four healthy siblings that
//      never had a credential in them were reported as lost
//   2. two refused batches in a row tripped MAX_CONSECUTIVE_BATCH_FAILURES, so the run
//      abandoned everything downstream with "the server is treated as down", about a
//      server that was never contacted
//   3. the receipt told the operator the batch "may already be governed" and to re-run,
//      which is false twice over: nothing left the machine, and an identical re-run
//      refuses identically forever
//
// End to end that read `governed: 5 / 2094 (0.2%)`. The corpus was not blocked by a
// credential; it was blocked by a misclassification of one.
//
// The property these tests lock: an egress refusal fails ONLY the documents that
// actually carry the credential, never contributes to the down-server abort, and says
// so in words that lead to the fix. Everything below drives the REAL batching loop
// through the REAL `applyEgressPolicy` against the REAL rule registry. The only thing
// absent is the network, which is correct: the refusal fires before it.

import { postDocumentsInBatches, KB_ADD_BATCH_SIZE } from "../../src/commands/kb_add";
import { applyEgressPolicy } from "../../src/lib/egress/policy";
import { EGRESS_RULES } from "../../src/lib/egress/rules";
import type { KbAddReceipt } from "../../src/lib/render";

const KB_ADD_URL = "https://intel.invalid/internal/v1/kb/add";

// A real credential FORMAT with a fake value, assembled at runtime rather than written
// as one literal: a `ghp_`-prefixed string in source trips GitHub's push-protection
// pattern check, and a test fixture is not worth a blocked push. The denylist matches on
// shape, so the shape has to be right; this was never a live secret.
const PAT = ["ghp", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("_");

type Doc = { relPath: string; content: string };

const CTX = {
  mode: "corpus" as const,
  workspaceId: "ws_1",
  provenance: "human_authored",
  now: () => "2026-07-28T00:00:00.000Z",
};

const BASE = { workspaceId: "ws_1", actor: "user-1", mode: "corpus", corpusName: "vault" };

/** N documents, with a credential planted in the ones at `poison`. */
const nDocs = (n: number, poison: number[] = []): Doc[] =>
  Array.from({ length: n }, (_, i) => ({
    relPath: `notes/n${i}.md`,
    content: poison.includes(i) ? `deploy with ${PAT}\n` : `an ordinary note ${i}`,
  }));

/**
 * The real boundary in front of a server that lands everything it is handed.
 *
 * `applyEgressPolicy` is the same call `intelPost` makes, with the same registry, so a
 * body that would be refused on the wire is refused here for the same reason and with
 * the same error object. Nothing is simulated except the 200.
 */
function boundaryThenHealthyServer() {
  const wire: unknown[] = [];
  const post = jest.fn(async (body: unknown) => {
    const sent = applyEgressPolicy(EGRESS_RULES, "intel", "POST", KB_ADD_URL, body);
    wire.push(sent);
    const docs = (sent as { documents: Doc[] }).documents;
    return {
      receipts: docs.map((d) => ({
        mode: "corpus",
        workspaceId: "ws_1",
        outcome: "ingested",
        documentId: `doc_${d.relPath}`,
        canonicalPath: d.relPath,
        parentUuid: "",
        provenance: "human_authored",
      })) as KbAddReceipt[],
    };
  });
  return { post, wire };
}

const pathsWith = (receipts: KbAddReceipt[], outcome: string) =>
  receipts.filter((r) => r.outcome === outcome).map((r) => r.canonicalPath);

describe("kb add: an egress refusal is a local verdict, not a server outage", () => {
  it("fails only the document carrying the credential, and lands its siblings", async () => {
    // The batch is 5 and exactly one document is poisoned. Before this, all 5 came back
    // failed: four files the operator could have governed were reported lost because of
    // a neighbour's content.
    const { post, wire } = boundaryThenHealthyServer();

    const { receipts } = await postDocumentsInBatches(nDocs(KB_ADD_BATCH_SIZE, [2]), BASE, { ...CTX, post });

    expect(pathsWith(receipts, "failed")).toEqual(["notes/n2.md"]);
    expect(pathsWith(receipts, "ingested")).toHaveLength(KB_ADD_BATCH_SIZE - 1);
    // And the siblings genuinely went out: the isolation re-POSTs, it does not fabricate
    // a receipt for a document that never left.
    expect((wire[wire.length - 1] as { documents: Doc[] }).documents.map((d) => d.relPath)).toEqual(
      ["notes/n0.md", "notes/n1.md", "notes/n3.md", "notes/n4.md"],
    );
  });

  it("gives the refusal its own failure code, not the transport one", async () => {
    const { post } = boundaryThenHealthyServer();

    const { receipts } = await postDocumentsInBatches(nDocs(KB_ADD_BATCH_SIZE, [2]), BASE, { ...CTX, post });

    const blocked = receipts.find((r) => r.canonicalPath === "notes/n2.md")!;
    expect(blocked.failure?.code).toBe("egress_blocked");
    expect(blocked.failure?.failedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("never tells the operator the document may already be governed", async () => {
    // The specific lie. `ambiguousBatchReason` is correct for a severed connection and
    // catastrophically wrong here: a refusal happens before the socket, so the server
    // holds nothing, and "re-run, it dedups to noop_unchanged" describes a recovery that
    // cannot occur. Re-running refuses identically until the file changes.
    const { post } = boundaryThenHealthyServer();

    const { receipts } = await postDocumentsInBatches(nDocs(KB_ADD_BATCH_SIZE, [2]), BASE, { ...CTX, post });

    const reason = receipts.find((r) => r.canonicalPath === "notes/n2.md")!.failure!.reason;
    expect(reason).not.toContain("may already be governed");
    expect(reason).not.toContain("noop_unchanged");
    expect(reason).not.toMatch(/Re-run the same/);
  });

  it("names the rule id and the remedy, and never the matched text", async () => {
    // A refusal explains itself by RULE. The operator needs the class (which line, what
    // shape) and the fix; quoting the match would move the credential into a receipt
    // that gets printed, logged and pasted into tickets.
    const { post } = boundaryThenHealthyServer();

    const { receipts } = await postDocumentsInBatches(nDocs(KB_ADD_BATCH_SIZE, [2]), BASE, { ...CTX, post });

    const reason = receipts.find((r) => r.canonicalPath === "notes/n2.md")!.failure!.reason;
    expect(reason).toContain("provider_token");
    expect(reason).not.toContain(PAT);
    expect(reason).not.toContain("ghp_");
    // The remedy, stated where the operator is already looking.
    expect(reason).toMatch(/quote the shape/i);
  });

  it("does NOT count toward the down-server abort, however many batches it hits", async () => {
    // The escalation that turned a 363-file problem into a 2089-file one. Two refused
    // batches in a row are two deterministic local verdicts, not two outages: every
    // later batch must still be attempted.
    const B = KB_ADD_BATCH_SIZE;
    const { post } = boundaryThenHealthyServer();
    const docs = nDocs(B * 6, [0, B, B * 2, B * 3, B * 4, B * 5]);

    const { receipts } = await postDocumentsInBatches(docs, BASE, { ...CTX, post });

    expect(receipts.filter((r) => r.failure?.code === "ingest_not_attempted")).toHaveLength(0);
    expect(pathsWith(receipts, "ingested")).toHaveLength(B * 6 - 6);
    expect(pathsWith(receipts, "failed")).toEqual([
      "notes/n0.md", `notes/n${B}.md`, `notes/n${B * 2}.md`, `notes/n${B * 3}.md`, `notes/n${B * 4}.md`, `notes/n${B * 5}.md`,
    ]);
  });

  it("still aborts on a genuinely dead server, so the refusal fix does not disarm the guard", async () => {
    // The control arm. `transportFailed` exists to stop a 100-doc corpus hammering a
    // dead intel for many minutes; reclassifying the refusal must not cost us that.
    const post = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { receipts } = await postDocumentsInBatches(nDocs(KB_ADD_BATCH_SIZE * 10), BASE, { ...CTX, post });

    expect(post).toHaveBeenCalledTimes(2);
    expect(receipts.filter((r) => r.failure?.code === "ingest_not_attempted").length).toBeGreaterThan(0);
  });

  it("fails the whole batch when the credential is in the envelope, not in any document", async () => {
    // Isolation is only honest when a document is actually the offender. If the
    // credential rides in a field every batch carries, dropping documents cannot fix it,
    // so the batch settles as blocked rather than bisecting toward an empty set. Still
    // not a transport failure: the run continues.
    const { post } = boundaryThenHealthyServer();
    const poisonedBase = { ...BASE, corpusName: `vault-${PAT}` };

    const { receipts } = await postDocumentsInBatches(nDocs(KB_ADD_BATCH_SIZE * 3), poisonedBase, { ...CTX, post });

    expect(receipts).toHaveLength(KB_ADD_BATCH_SIZE * 3);
    expect(receipts.every((r) => r.failure?.code === "egress_blocked")).toBe(true);
    // Every batch was attempted: no batch was skipped as "server down".
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("keeps a clean corpus byte-exact through the same path", async () => {
    // If the boundary refused everything the assertions above would pass for the wrong
    // reason.
    const { post, wire } = boundaryThenHealthyServer();
    const docs = nDocs(KB_ADD_BATCH_SIZE);

    const { receipts, errors } = await postDocumentsInBatches(docs, BASE, { ...CTX, post });

    expect(errors).toEqual([]);
    expect(pathsWith(receipts, "ingested")).toHaveLength(KB_ADD_BATCH_SIZE);
    expect((wire[0] as { documents: Doc[] }).documents).toEqual(docs);
  });
});
