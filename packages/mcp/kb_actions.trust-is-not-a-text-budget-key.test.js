/**
 * INVARIANT: governance state must never decide how much DOCUMENT TEXT a caller gets.
 *
 * Run: node --test
 *
 * Added 2026-08-09 after review of `521050445` ("ruled claims first"). The concern was
 * precise and worth guarding permanently: retrieval relevance decides what consumes
 * scarce slots; governance/trust decides what may ground an answer and how evidence is
 * annotated. A change that let ruled claims take slots from more relevant material would
 * make the trust axis a ranking key, which is the exact coupling the surrounding
 * workstream exists to remove.
 *
 * The audit found `521050445` on the right side of that line, and these tests are what
 * keep it there rather than a paragraph asserting it:
 *
 *   - `runKbDocDetail` serves ONE tool, `meetless__kb_doc_detail` (server.js), and takes
 *     a single `document_id` the caller already chose. There is no selection among
 *     documents for trust to bias, and `meetless__retrieve_knowledge` is a different
 *     handler that never calls it.
 *   - the chunk page is sized as `fitChunkPage(k => paged(k, emptyProvenance))`, with
 *     `claims: []`. The document text is budgeted BEFORE any claim is considered, so the
 *     claims array structurally cannot take budget from it.
 *   - `orderClaimsForPage` reorders one already-resolved document's `detail.claims`
 *     array, and its only caller is the provenance loop that runs after the page is
 *     final.
 *
 * So the budget "ruled claims first" governs is the RESIDUAL PROVENANCE budget inside an
 * already-selected payload: which claim records survive trimming, never which text or
 * which document is returned. These tests pin that, and would fail the moment someone
 * budgeted claims ahead of the page or let ruling state reach the chunk arithmetic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runKbDocDetail } from "./kb_actions.js";

const detailFetch = (bundle) => async (p) => (p.includes("/detail") ? bundle : {});
const callDetail = (bundle, args = {}) =>
  runKbDocDetail({ document_id: "doc-under-test", ...args }, { intelFetch: detailFetch(bundle), defaultWorkspaceId: "ws_test" });

/** `ruledIdx` selects which claims carry a human verdict. Everything else is identical
 *  between bundles, so any difference in the returned TEXT is attributable to ruling
 *  state alone. */
function makeBundle({ chunkCount = 300, claimCount = 60, ruled = () => false } = {}) {
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
    const isRuled = ruled(i);
    const start = Math.floor((i / claimCount) * total);
    claims.push({
      claimId: `claim-${i}`,
      sourceRevisionId: "rev-head",
      ontologyRunId: "run-1",
      claimExtractionKind: "NORMALIZED",
      // Byte-identical between the two bundles: only the verdict fields differ, so the
      // payload SIZE of a claim is the same whether or not a human ruled on it.
      verbatimText: `Claim ${i}: ` + "a sentence long enough to cost real budget. ".repeat(4),
      normalizedText: `Normalized claim ${i}: ` + "restated at similar length. ".repeat(4),
      groundingStatus: "UNKNOWN",
      reviewOutcome: isRuled ? "ACCEPTED" : "PENDING",
      reviewedBy: isRuled ? "user-1" : null,
      reviewedAt: isRuled ? "2026-07-12T00:00:00Z" : null,
      lifecycleStatus: "ACTIVE",
      startOffset: start,
      endOffset: start + 120,
      createdAt: "2026-07-11T00:00:00Z",
    });
  }
  return {
    document: { id: "doc-under-test", sourceSystem: "notes", externalObjectId: "notes/x.md", title: "x" },
    serving: true,
    servingStatus: "SERVING",
    headRevision: { revisionId: "rev-head" },
    revisions: [{ revisionId: "rev-head" }],
    chunks,
    claims,
    audit: [],
    claimsAnchorRevisionId: "rev-head",
    claimCount,
    claimsOnPriorRevisions: 0,
  };
}

const textOf = (r) => (r.detail.chunks ?? []).map((c) => c.indexedText).join("");
const chunkIdsOf = (r) => (r.detail.chunks ?? []).map((c) => c.chunkId);

test("ruling state does not change WHICH document text is returned", async () => {
  // Two bundles identical except that one has verdicts on a third of its claims.
  const none = makeBundle({ ruled: () => false });
  const some = makeBundle({ ruled: (i) => i % 3 === 0 });

  for (const args of [{}, { limit: 5 }, { offset: 40, limit: 10 }]) {
    const a = await callDetail(none, args);
    const b = await callDetail(some, args);
    const label = JSON.stringify(args);
    assert.equal(b.chunkCount, a.chunkCount, `chunkCount moved with ruling state at ${label}`);
    assert.equal(b.chunkOffset, a.chunkOffset, `chunkOffset moved with ruling state at ${label}`);
    assert.deepEqual(chunkIdsOf(b), chunkIdsOf(a), `the chunk PAGE moved with ruling state at ${label}`);
    assert.equal(textOf(b), textOf(a), `the returned TEXT moved with ruling state at ${label}`);
  }
});

test("ruling state does not change how many claims survive, only which ones", async () => {
  // The residual provenance budget is a size, and ruling state must not buy more of it.
  // Claim records are byte-identical apart from the verdict fields, so an equal count
  // with a different membership is exactly "prioritisation, not allocation".
  const none = makeBundle({ ruled: () => false });
  const some = makeBundle({ ruled: (i) => i % 3 === 0 });

  const a = await callDetail(none, { limit: 1 });
  const b = await callDetail(some, { limit: 1 });
  const aIds = (a.detail.claims ?? []).map((c) => c.claimId);
  const bIds = (b.detail.claims ?? []).map((c) => c.claimId);

  assert.ok(aIds.length > 0 && bIds.length > 0, "fixture must return claims or this proves nothing");
  assert.equal(bIds.length, aIds.length, "ruling state must not enlarge the provenance budget");
  // Not vacuous: the ORDER really did change, which is the whole point of the change
  // under audit. If this ever passes trivially the test above stops meaning anything.
  assert.notDeepEqual(bIds, aIds, "ruled-claims-first must actually reorder, or this guard is vacuous");
  assert.ok((b.detail.claims ?? []).some((c) => c.reviewedBy), "the ruled bundle must surface a verdict");
});

test("the claims array cannot starve the document text, whatever its ruling state", async () => {
  // The structural reason the invariant holds: the chunk page is sized against a result
  // carrying NO provenance, so a document with 60 ruled claims returns the same page as
  // one with none. This is the assertion that fails first if someone ever budgets
  // provenance ahead of the page.
  const allRuled = makeBundle({ ruled: () => true });
  const noneRuled = makeBundle({ ruled: () => false });

  const a = await callDetail(allRuled);
  const b = await callDetail(noneRuled);
  assert.equal(a.detail.chunks.length, b.detail.chunks.length);
  assert.ok(a.detail.chunks.length > 50, "the text must still win the default budget in both cases");
});
