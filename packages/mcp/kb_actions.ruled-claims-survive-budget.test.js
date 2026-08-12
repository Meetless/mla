/**
 * P2: `kb_doc_detail` must actually deliver the thing the retrieve_knowledge contract
 * sends the agent here for.
 *
 * Run: node --test
 *
 * P2 rewrites the band contract to say, in effect: "the band is the document-level fold
 * of its claims; when a claim matters, open the citation with kb_doc_detail and read the
 * per-claim verdict, its author and its time." That sentence is only honest if the
 * verdicts survive the trip.
 *
 * They did not. Measured 2026-08-09 against the live local stack: kb_doc_detail on
 * `notes/20260704-mla-durable-product-doctrine.md` returned `claimCount: 61`,
 * `claimsOnPriorRevisions: 0` and `claims: []`. The document is 348 chunks, the
 * chunk-first budget (M2) correctly gave the text priority, and `claims` is the FIRST
 * provenance array trimmed -- to zero, which the budget explicitly documents as a
 * legitimate outcome. So on exactly the large, heavily-governed documents where a
 * verdict is worth reading, every verdict was dropped.
 *
 * The scarcity argument is what settles it. There were 107 human verdicts in the entire
 * corpus against 63,222 claims: a ruled claim is ~0.17% of the population and it is the
 * only part of the array a human paid for. Ordering ruled claims ahead of unruled ones
 * costs nothing (the array is already re-ordered for page relevance) and makes the P2
 * sentence true. Page relevance still orders WITHIN each band, so the M2 property that
 * a caller paging into the middle of a note gets that page's claims is preserved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runKbDocDetail } from "./kb_actions.js";

const detailFetch = (bundle) => async (pathAndQuery) => (pathAndQuery.includes("/detail") ? bundle : {});
const callDetail = (bundle, args = {}) =>
  runKbDocDetail({ document_id: "doc-under-test", ...args }, { intelFetch: detailFetch(bundle), defaultWorkspaceId: "ws_test" });

/** A document big enough that the chunk page consumes the budget, holding a few ruled
 *  claims among many unruled ones: the shipped shape of a governed note. */
function makeMostlyUnruledBundle({ chunkCount = 300, claimCount = 60, ruledEvery = 20 } = {}) {
  let cursor = 0;
  const chunks = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const text = `Paragraph ${i}. ` + "governed prose that carries the actual answer. ".repeat(6);
    chunks.push({
      chunkId: `chunk-${i}`,
      revisionId: "rev-head",
      runId: "run-1",
      normalizedContentHash: `hash-${i}`,
      normalizationVersion: 3,
      createdAt: "2026-07-11T00:00:00Z",
      startOffset: cursor,
      endOffset: cursor + text.length,
      indexedText: text,
    });
    cursor += text.length;
  }
  const total = cursor;
  const claims = [];
  for (let i = 0; i < claimCount; i += 1) {
    // Ruled claims sit LATE in document order on purpose: a document-order prefix (the
    // pre-fix behaviour) would keep the unruled ones and drop every verdict.
    const start = Math.floor((i / claimCount) * total);
    const ruled = i % ruledEvery === ruledEvery - 1;
    claims.push({
      claimId: `claim-${i}`,
      sourceRevisionId: "rev-head",
      ontologyRunId: "run-1",
      claimExtractionKind: "NORMALIZED",
      verbatimText: `Claim ${i}: ` + "a sentence long enough to cost real budget. ".repeat(4),
      normalizedText: `Normalized claim ${i}: ` + "restated at similar length. ".repeat(4),
      groundingStatus: "UNKNOWN",
      reviewOutcome: ruled ? (i % (ruledEvery * 2) === ruledEvery - 1 ? "ACCEPTED" : "REJECTED") : "PENDING",
      reviewedBy: ruled ? "user-1" : null,
      reviewedAt: ruled ? "2026-07-12T00:00:00Z" : null,
      lifecycleStatus: "ACTIVE",
      startOffset: start,
      endOffset: start + 120,
      createdAt: "2026-07-11T00:00:00Z",
    });
  }
  return {
    document: {
      id: "doc-mostly-unruled",
      sourceSystem: "notes",
      externalObjectId: "notes/20260704-mla-durable-product-doctrine.md",
      title: "MLA Durable Product Doctrine",
    },
    serving: true,
    servingStatus: "SERVING",
    headRevision: { revisionId: "rev-head", reviewOutcome: "ACCEPTED" },
    revisions: [{ revisionId: "rev-head", reviewOutcome: "ACCEPTED" }],
    chunks,
    claims,
    audit: [],
    claimsAnchorRevisionId: "rev-head",
    claimCount,
    claimsOnPriorRevisions: 0,
  };
}

const ruledIds = (bundle) => bundle.claims.filter((c) => c.reviewedBy).map((c) => c.claimId);

test("the default page still spends the budget on TEXT, not provenance", async () => {
  // M2's policy is unchanged and this pins it: asked for a document with no limit, the
  // tool answers with the document. It is the reason a reservation was NOT added here.
  // Live on the real corpus 2026-08-09: the 348-chunk doctrine note returns 176 chunks
  // and 0 of its 61 claims by default. That is correct for "what does this note say?"
  // and useless for "what was ruled?", which is why the contract now tells the agent
  // which question a small `limit` answers.
  const bundle = makeMostlyUnruledBundle();
  const result = await callDetail(bundle);
  assert.equal(result.claimCount, bundle.claims.length, "the count rail always reports the WHOLE head");
  assert.ok(result.detail.chunks.length > 50, "the text must still win the default budget");
});

test("a bounded chunk page delivers the verdicts, ruled first", async () => {
  // What P2 actually promises, and the shape the contract now instructs: a caller that
  // wants the verdicts bounds the text page, and then the verdicts arrive WITH their
  // author and time. Measured live the same day on the real doctrine note: `limit: 1`
  // returns 39 of its 61 claims and every one of them is a human-ruled claim.
  const bundle = makeMostlyUnruledBundle();
  const expected = ruledIds(bundle);
  assert.ok(expected.length > 0, "fixture must carry ruled claims or it proves nothing");

  const result = await callDetail(bundle, { limit: 1 });
  assert.equal(result.claimCount, bundle.claims.length);

  const returned = result.detail.claims ?? [];
  const returnedIds = returned.map((c) => c.claimId);
  for (const id of expected) {
    assert.ok(returnedIds.includes(id), `ruled claim ${id} was dropped even under a bounded page`);
  }
  for (const c of returned.filter((x) => expected.includes(x.claimId))) {
    assert.ok(c.reviewedBy, "a surviving ruled claim must still carry its author");
    assert.ok(c.reviewedAt, "a surviving ruled claim must still carry its time");
    assert.ok(["ACCEPTED", "REJECTED"].includes(c.reviewOutcome));
  }
  // And they LEAD, so a further-trimmed page still shows verdicts before pending noise.
  const firstUnruled = returned.findIndex((c) => !c.reviewedBy);
  if (firstUnruled !== -1) {
    assert.ok(returned.slice(firstUnruled).every((c) => !c.reviewedBy), "ruled claims must be a prefix");
  }
});

test("page relevance still orders within the unruled band", async () => {
  // The M2 property must survive: among claims with the SAME ruling state, the ones
  // overlapping the requested chunk page come first.
  const bundle = makeMostlyUnruledBundle({ chunkCount: 60, claimCount: 20, ruledEvery: 100 });
  assert.equal(ruledIds(bundle).length, 0, "this fixture is deliberately all-unruled");

  const result = await callDetail(bundle, { offset: 40, limit: 10 });

  const returned = result.detail.claims ?? [];
  if (returned.length === 0 || returned.length === bundle.claims.length) return; // nothing trimmed: no ordering to assert
  const page = result.detail.chunks;
  const pageStart = page[0].startOffset;
  const pageEnd = page[page.length - 1].endOffset;
  const overlaps = (c) => c.endOffset > pageStart && c.startOffset < pageEnd;
  const firstOffPage = returned.findIndex((c) => !overlaps(c));
  if (firstOffPage === -1) return; // every survivor is on-page, which is the strongest form
  assert.ok(
    returned.slice(firstOffPage).every((c) => !overlaps(c)),
    "on-page claims must form a prefix of the surviving claims",
  );
});

test("ruled claims outrank unruled ones even when the unruled ones are on-page", async () => {
  // The two heuristics can disagree. When they do, the verdict wins: a human ruling is
  // scarce (107 in the whole corpus) and page overlap is not.
  const bundle = makeMostlyUnruledBundle({ chunkCount: 300, claimCount: 60, ruledEvery: 20 });
  const result = await callDetail(bundle, { offset: 0, limit: 5 });
  const returned = result.detail.claims ?? [];
  const firstUnruled = returned.findIndex((c) => !c.reviewedBy);
  if (firstUnruled === -1) return;
  assert.ok(
    returned.slice(firstUnruled).every((c) => !c.reviewedBy),
    "ruled claims must form a prefix of the surviving claims",
  );
});
