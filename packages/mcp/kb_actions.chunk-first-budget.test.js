/**
 * M2: even WITH paging, the provenance rails crowded the document out.
 *
 * Run: node --test
 *
 * Measured 2026-08-09 (session 4caa06b9): kb_doc_detail on a 147-chunk note
 * returned `chunkCount: 147` and ONE chunk of 89 characters (the title),
 * alongside 50 claims and 10 full revision records. `fitChunkPage` binary-searches
 * for the chunks that fit in WHAT THE METADATA LEAVES, so on a claim-rich document
 * that is one chunk, and the tool whose whole job is "give me the document text"
 * returned a title and a pile of provenance.
 *
 * The fix is ordering, not a new constant and not a new knob: budget the CHUNK
 * page first (still governed by the existing offset/limit), then fit the
 * provenance arrays into what is left. Scalar counts are always preserved, so a
 * trimmed array is never a silent lie about how much exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runKbDocDetail, CHUNK_PAGE_BUDGET_UNITS } from "./kb_actions.js";

// The same unit the host counts and fitChunkPage budgets against.
function outerUnits(result) {
  return JSON.stringify([{ type: "text", text: JSON.stringify(result, null, 2) }]).length;
}

// A claim-rich document shaped like the measured reproducer: many chunks of real
// prose, 50 claims carrying verbatim text, 10 full revision records.
function makeClaimRichBundle({ chunkCount = 147, claimCount = 50, revisionCount = 10 } = {}) {
  let cursor = 0;
  const chunks = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const text =
      i === 0
        ? "# The canonical note title, which is all a truncated read used to return"
        : `Paragraph ${i}. ` + "governed prose that carries the actual answer. ".repeat(6);
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
    // Spread the claims across the whole document so "relevant to this page" is a
    // real discriminator rather than an accident of ordering.
    const start = Math.floor((i / claimCount) * total);
    claims.push({
      claimId: `claim-${i}`,
      sourceRevisionId: "rev-head",
      ontologyRunId: "run-1",
      claimExtractionKind: "NORMALIZED",
      verbatimText: `Claim ${i}: ` + "a sentence long enough to cost real budget. ".repeat(4),
      normalizedText: `Normalized claim ${i}: ` + "restated at similar length. ".repeat(4),
      groundingStatus: "GROUNDED",
      reviewOutcome: "ACCEPTED",
      reviewedBy: "user-1",
      reviewedAt: "2026-07-12T00:00:00Z",
      lifecycleStatus: "ACTIVE",
      startOffset: start,
      endOffset: start + 120,
      createdAt: "2026-07-11T00:00:00Z",
    });
  }
  const revisions = [];
  for (let i = 0; i < revisionCount; i += 1) {
    revisions.push({
      revisionId: i === 0 ? "rev-head" : `rev-${i}`,
      revisionNumber: revisionCount - i,
      contentHash: `content-hash-${i}`,
      normalizationVersion: 3,
      ingestRunId: `ingest-${i}`,
      byteLength: 15574,
      createdAt: `2026-07-${String(10 - i).padStart(2, "0")}T00:00:00Z`,
      activatedAt: `2026-07-${String(10 - i).padStart(2, "0")}T00:05:00Z`,
      supersededAt: i === 0 ? null : `2026-07-${String(11 - i).padStart(2, "0")}T00:00:00Z`,
      redactedAt: null,
      sourceUri: "notes/20260624-mla-new-user-value-and-brownfield-proof.md",
      summary: "an imported revision record carrying a paragraph of provenance. ".repeat(3),
    });
  }
  return {
    document: {
      id: "doc-claim-rich",
      sourceSystem: "notes",
      externalObjectId: "notes/20260624-mla-new-user-value-and-brownfield-proof.md",
      title: "MLA new user value and brownfield proof",
    },
    serving: true,
    servingStatus: "SERVING",
    headRevision: revisions[0],
    revisions,
    chunks,
    claims,
    audit: [],
    claimsAnchorRevisionId: "rev-head",
    claimCount,
    claimsOnPriorRevisions: 0,
  };
}

function detailFetch(bundle) {
  return async (pathAndQuery) => (pathAndQuery.includes("/detail") ? bundle : {});
}

async function callDetail(bundle, args = {}) {
  return runKbDocDetail(
    { document_id: "doc-claim-rich", ...args },
    { intelFetch: detailFetch(bundle), defaultWorkspaceId: "ws_test" },
  );
}

test("M2 REPRODUCER: a claim-rich document does not collapse to one chunk", async () => {
  const bundle = makeClaimRichBundle();
  const out = await callDetail(bundle);
  assert.equal(out.chunkCount, 147, "the whole-document count must still be reported");
  assert.ok(
    out.detail.chunks.length > 1,
    `the document text must win the budget over provenance; got ${out.detail.chunks.length} chunk(s)`,
  );
  // Not just "more than one": the page has to be worth reading.
  assert.ok(
    out.detail.chunks.length >= 20,
    `expected a substantial page of a 147-chunk document, got ${out.detail.chunks.length}`,
  );
});

test("the page still fits the budget the host actually counts", async () => {
  const out = await callDetail(makeClaimRichBundle());
  assert.ok(
    outerUnits(out) <= CHUNK_PAGE_BUDGET_UNITS,
    `page measured ${outerUnits(out)} units, budget is ${CHUNK_PAGE_BUDGET_UNITS}`,
  );
});

test("scalar counts survive even when the arrays behind them are trimmed", async () => {
  const out = await callDetail(makeClaimRichBundle());
  assert.equal(out.claimCount, 50, "claimCount is the whole-document count, never the page's");
  assert.equal(out.revisionCount, 10, "the reader must be able to tell a trimmed array from a short one");
  assert.equal(out.claimsOnPriorRevisions, 0);
  assert.equal(out.claimsAnchorRevisionId, "rev-head");
  assert.ok(
    out.detail.claims.length <= out.claimCount,
    "a trimmed claims array can never exceed the count it is trimmed from",
  );
});

test("claims are ordered by relevance to the RETURNED chunk page (they carry offsets already)", async () => {
  const bundle = makeClaimRichBundle();
  // Ask for a page deep inside the document, so "relevant" is unambiguous.
  const out = await callDetail(bundle, { offset: 100, limit: 10 });
  const page = out.detail.chunks;
  assert.ok(page.length > 0, "expected a non-empty page");
  const pageStart = page[0].startOffset;
  const pageEnd = page[page.length - 1].endOffset;

  const returned = out.detail.claims;
  assert.ok(returned.length > 0, "expected at least one claim to survive the budget");
  // The first claim returned must overlap the page. Before the fix, claims were a
  // document-order prefix and the first one sat at offset 0, nowhere near a page
  // that starts a hundred chunks in.
  const first = returned[0];
  assert.ok(
    first.endOffset > pageStart && first.startOffset < pageEnd,
    `first claim [${first.startOffset},${first.endOffset}) must overlap the returned page [${pageStart},${pageEnd})`,
  );
});

test("revision detail is capped to fit, and the HEAD is never lost", async () => {
  const out = await callDetail(makeClaimRichBundle());
  const revs = out.detail.revisions;
  assert.ok(Array.isArray(revs));
  assert.ok(revs.length <= 10, "the array is capped, never grown");
  // The head is carried by the SCALAR `headRevision` rail, which chunk-first
  // budgeting never trims. So even a revisions array trimmed to empty still
  // answers "which revision is live?", and `revisionCount` still answers "how
  // many exist?". That is why the array is safe to cap all the way down.
  assert.equal(out.detail.headRevision?.revisionId, "rev-head");
  assert.equal(out.revisionCount, 10);
  if (revs.length > 0) {
    assert.equal(revs[0].revisionId, "rev-head", "a surviving prefix starts at the head");
  }
});

test("`limit` is the dial that buys provenance: a smaller page frees budget for claims", async () => {
  // The contract chunk-first budgeting creates, stated explicitly because it is
  // the reason no reserved percentage is needed. With no limit the document text
  // takes the whole envelope, which is what the tool is FOR. A caller who wants
  // the claims for a region says so with the offset/limit that already exist,
  // and the budget those chunks did not spend goes to the provenance arrays.
  const bundle = makeClaimRichBundle();

  const greedy = await callDetail(bundle);
  const narrow = await callDetail(bundle, { limit: 5 });

  assert.ok(greedy.detail.chunks.length > narrow.detail.chunks.length);
  assert.ok(
    narrow.detail.claims.length > greedy.detail.claims.length,
    `a narrower page must buy more claims: narrow=${narrow.detail.claims.length} greedy=${greedy.detail.claims.length}`,
  );
  // Both are still inside the budget; the dial moves the split, never the ceiling.
  assert.ok(outerUnits(greedy) <= CHUNK_PAGE_BUDGET_UNITS);
  assert.ok(outerUnits(narrow) <= CHUNK_PAGE_BUDGET_UNITS);
  // And the counts never move: they describe the document, not the page.
  assert.equal(greedy.claimCount, narrow.claimCount);
  assert.equal(greedy.revisionCount, narrow.revisionCount);
});

test("claims outrank revisions for the leftover budget (a claim carries text, a revision carries lineage)", async () => {
  const out = await callDetail(makeClaimRichBundle(), { limit: 5 });
  assert.ok(out.detail.claims.length > 0, "expected claims to survive at limit=5");
  assert.ok(
    out.detail.claims.length >= out.detail.revisions.length,
    "claims must not be starved by revisions",
  );
});

test("a document with no provenance is unchanged (no regression on the simple case)", async () => {
  const bundle = makeClaimRichBundle({ chunkCount: 3, claimCount: 0, revisionCount: 1 });
  const out = await callDetail(bundle);
  assert.equal(out.chunkCount, 3);
  assert.equal(out.detail.chunks.length, 3, "a small document still comes back whole");
  assert.equal(out.detail.claims.length, 0);
  assert.equal(out.detail.revisions.length, 1);
});

test("PAGINATION always advances and eventually exposes the whole document, with no gaps or duplicates", async () => {
  const bundle = makeClaimRichBundle();
  const seen = [];
  let offset = 0;
  let calls = 0;
  while (offset < bundle.chunks.length) {
    calls += 1;
    assert.ok(calls <= 200, "pagination must terminate");
    const out = await callDetail(bundle, { offset });
    assert.equal(out.chunkOffset, offset, "the tool must echo the offset it paged from");
    const n = out.detail.chunks.length;
    assert.ok(n > 0, `page at offset ${offset} returned zero chunks: the caller has no legal next offset`);
    for (const c of out.detail.chunks) seen.push(c.startOffset);
    offset += n;
  }
  assert.equal(offset, bundle.chunks.length, "paging must land exactly on the end, never past it");
  // No gaps, no duplicates: the concatenation is the document.
  const expected = bundle.chunks.map((c) => c.startOffset);
  assert.deepEqual(seen, expected, "the paged sequence must reconstruct the document exactly once");
});

test("the ADVERTISED schema and the handler agree on offset/limit", async () => {
  const { TOOLS } = await import("./tool_manifest.js");
  const tool = TOOLS.find((t) => t.name === "meetless__kb_doc_detail");
  const props = Object.keys(tool.inputSchema.properties || {});
  // M1's other half: a rail the handler reads but the manifest does not advertise
  // is a rail the model cannot reach. This is the contract-level assertion.
  assert.ok(props.includes("offset"), "offset must be advertised, not just implemented");
  assert.ok(props.includes("limit"), "limit must be advertised, not just implemented");

  // And the handler must honour them, so the two cannot drift apart silently.
  const bundle = makeClaimRichBundle({ chunkCount: 20, claimCount: 0, revisionCount: 1 });
  const out = await callDetail(bundle, { offset: 5, limit: 3 });
  assert.equal(out.chunkOffset, 5);
  assert.equal(out.detail.chunks.length, 3);
  assert.equal(out.detail.chunks[0].startOffset, bundle.chunks[5].startOffset);
});
