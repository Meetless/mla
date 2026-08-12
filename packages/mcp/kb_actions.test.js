/**
 * D5 §12.6 behavioral test for runKbDocDetail.
 *
 * Run: node --test
 *
 * The schema no longer advertises workspace_id; the handler must ALSO stop
 * reading args.workspace_id so a smuggled value cannot reach another tenant.
 * Workspace is pinned from the env-derived defaultWorkspaceId.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runKbDocDetail } from "./kb_actions.js";

// A stub intelFetch that records every path it is asked to fetch and returns a
// minimal detail bundle for the */detail route.
function makeRecordingFetch() {
  const paths = [];
  const intelFetch = async (pathAndQuery) => {
    paths.push(pathAndQuery);
    if (pathAndQuery.includes("/detail")) {
      return { id: "doc-1", revisions: [], chunks: [] };
    }
    return {};
  };
  return { intelFetch, paths };
}

function workspaceParamOf(pathAndQuery) {
  const qs = pathAndQuery.split("?")[1] || "";
  return new URLSearchParams(qs).get("workspaceId");
}

function pathParamOf(pathAndQuery) {
  const qs = pathAndQuery.split("?")[1] || "";
  return new URLSearchParams(qs).get("path");
}

test("§12.6: a smuggled args.workspace_id is IGNORED; env-pinned workspace is used", async () => {
  const { intelFetch, paths } = makeRecordingFetch();
  await runKbDocDetail(
    { document_id: "11111111-2222-3333-4444-555555555555", workspace_id: "ws_foreign" },
    { intelFetch, defaultWorkspaceId: "ws_an_local" },
  );
  // Every intel call must carry the env-pinned workspace, never the smuggled one.
  assert.ok(paths.length > 0, "intel must have been called");
  for (const p of paths) {
    assert.equal(
      workspaceParamOf(p),
      "ws_an_local",
      `path ${p} must use the env-pinned workspace, not the smuggled ws_foreign`,
    );
    assert.ok(!p.includes("ws_foreign"), `path ${p} must not contain the smuggled workspace`);
  }
});

test("the receipt envelope reports the env-pinned workspace, not the smuggled one", async () => {
  const { intelFetch } = makeRecordingFetch();
  const result = await runKbDocDetail(
    { document_id: "note:20260101-foo.md", workspace_id: "ws_foreign" },
    {
      intelFetch: async (p) => {
        if (p.includes("/resolve")) return { documentId: "doc-9" };
        if (p.includes("/detail")) return { id: "doc-9" };
        return {};
      },
      defaultWorkspaceId: "ws_an_local",
    },
  );
  assert.equal(result.workspaceId, "ws_an_local");
});

// The two-layer handoff: meetless__retrieve_knowledge emits note citations as
// `NT:<path>` (e.g. NT:notes/foo.md). For "open any citation with kb_doc_detail"
// to actually work, the handler must treat an NT: citation as the SAME artifact
// as note:<path> and route it through the resolve route, not the raw-uuid branch
// (which 404s). The substring after NT: is the note path the resolve route
// canonicalizes server-side.
test("NT: note citation resolves through the note resolve route (two-layer handoff)", async () => {
  const seen = [];
  const result = await runKbDocDetail(
    { document_id: "NT:notes/foo.md" },
    {
      intelFetch: async (p) => {
        seen.push(p);
        if (p.includes("/resolve")) return { documentId: "doc-7" };
        if (p.includes("/detail")) return { id: "doc-7" };
        return {};
      },
      defaultWorkspaceId: "ws_an_local",
    },
  );
  const resolveCall = seen.find((p) => p.includes("/resolve"));
  assert.ok(resolveCall, "an NT: citation must be sent through the resolve route");
  assert.equal(
    pathParamOf(resolveCall),
    "notes/foo.md",
    "the path passed to resolve must be the citation minus the NT: prefix",
  );
  // It must NOT be treated as a raw uuid (that would skip resolve and 404).
  const detailCall = seen.find((p) => p.includes("/detail"));
  assert.ok(detailCall.includes("doc-7"), "detail must fetch the RESOLVED kbdoc id");
  assert.ok(
    !detailCall.includes("NT") && !detailCall.includes("notes%2Ffoo"),
    "the raw NT: citation must never reach the /detail path",
  );
  assert.equal(result.resolvedDocumentId, "doc-7");
});

test("NT: citation prefix is accepted case-insensitively", async () => {
  const seen = [];
  await runKbDocDetail(
    { document_id: "nt:notes/bar.md" },
    {
      intelFetch: async (p) => {
        seen.push(p);
        if (p.includes("/resolve")) return { documentId: "doc-3" };
        if (p.includes("/detail")) return { id: "doc-3" };
        return {};
      },
      defaultWorkspaceId: "ws_an_local",
    },
  );
  const resolveCall = seen.find((p) => p.includes("/resolve"));
  assert.ok(resolveCall, "a lowercased nt: citation must still route through resolve");
  assert.equal(pathParamOf(resolveCall), "notes/bar.md");
});

// DD: (the retired Decision Diff marker, folded into CC:) and TH: (threads) are NOT
// KB documents, so they must never be sent to the note resolve route. That half of
// this test is unchanged and is the invariant it exists to hold.
//
// The OTHER half was rewritten by F4. It used to assert that both "fall through to the
// raw branch and surface a clean not found", and the word `clean` was doing work it had
// not earned: the message read "KB document not found", which asserts the object does
// not exist. For TH: that is a claim we have no evidence for -- the thread is in the
// corpus, retrieve_knowledge just served a snippet of it -- so TH: now raises a NAMED
// unresolvable-class error instead. DD: is not in the emitted vocabulary at all
// (`_PUBLIC_CITATION_PREFIXES` is NT/CC/TH/DE), so it keeps the legacy raw-uuid path.
test("DD: and TH: citations are NOT routed through the note resolve route", async () => {
  const seen = [];
  const intelFetch = async (p) => {
    seen.push(p);
    if (p.includes("/detail")) return { id: "x" };
    return {};
  };
  await runKbDocDetail(
    { document_id: "DD:cmdiff123" },
    { intelFetch, defaultWorkspaceId: "ws_an_local" },
  );
  await assert.rejects(
    () => runKbDocDetail({ document_id: "TH:1700000000.0001" }, { intelFetch, defaultWorkspaceId: "ws_an_local" }),
    /TH:/,
  );
  assert.ok(
    !seen.some((p) => p.includes("/resolve")),
    "neither citation may hit the note resolve route (neither is a KB document)",
  );
});

// ---------------------------------------------------------------------------
// A2: the governed READ path must return the DOCUMENT, not the substrate.
//
// Measured on session cdf1553e (2026-08-07). `kb_doc_detail` on a 15,574-char
// note produced a 53,970-unit MCP result. The host's MCP ceiling sits near
// 50,000, so it persisted the whole thing and injected a 2,000-char preview --
// which, because `document` / `serving` / `headRevision` / `revisions` all
// serialize before `chunks`, contained a uuid, a revision id and a content hash
// and ZERO characters of the document. The agent then grepped the vault file.
//
// The overhead is per-chunk substrate identity (`chunkId`, `revisionId`,
// `runId`, `normalizedContentHash`, `normalizationVersion`, `createdAt`)
// repeated across 67 chunks. Consumer audit (2026-08-07, non-test callers):
//   - Console `/kb/[id]`  -> startOffset, endOffset, indexedText, chunkId (React key)
//   - `mla kb show`       -> chunkId, revisionId, startOffset, endOffset, indexedText
//   - MCP kb_doc_detail   -> nothing; it is passed to a language model
// Both real consumers read intel's HTTP route DIRECTLY. Nothing downstream of
// the MCP tool reads a single chunk field, so the projection lives here and the
// backend representation is untouched.
// ---------------------------------------------------------------------------

// The largest MCP result observed to stay INLINE on this host, in JS String.length
// units. Reported, never enforced: it is the host's dial, not ours. It is the unit
// the host counts in -- the persisted artifact for cdf1553e is 53,970 units and the
// host announced "52.7KB", i.e. it measured the OUTER serialized content array.
const MCP_INLINE_OBSERVED_MAX_UNITS = 49752;

// The geometry of the real reproducer, measured off the persisted artifact:
// notes/20260806-did-mla-help-session-5734f9de-measured-and-fix-proposal.md,
// 67 chunks, 15,574 chars of indexed text, contiguous [0, 15574).
const REPRO_CHUNKS = 67;
const REPRO_TEXT_CHARS = 15574;

function reproDetail() {
  const uuid = (n) => `${String(n).padStart(8, "0")}-d146-4a1c-8fc5-b73b15dd27ee`;
  const sha = (n) => String(n).padStart(64, "a");
  const per = Math.floor(REPRO_TEXT_CHARS / REPRO_CHUNKS);
  const chunks = [];
  let off = 0;
  for (let i = 0; i < REPRO_CHUNKS; i++) {
    const len = i === REPRO_CHUNKS - 1 ? REPRO_TEXT_CHARS - off : per;
    chunks.push({
      chunkId: uuid(i),
      revisionId: uuid(9000),
      runId: uuid(8000),
      normalizedContentHash: sha(i),
      startOffset: off,
      endOffset: off + len,
      normalizationVersion: "content-normalization-v1",
      indexedText: `## section ${i} `.padEnd(len, "x").slice(0, len),
      createdAt: "2026-08-07T02:02:15.011000Z",
    });
    off += len;
  }
  return {
    document: { documentId: uuid(1), workspaceId: "ws_an_local", scope: "PERSON" },
    serving: true,
    servingStatus: "SERVING",
    headRevision: { revisionId: uuid(9000), status: "ACTIVE", normalizedContentHash: sha(1) },
    revisions: [{ revisionId: uuid(9000), status: "ACTIVE", createdAt: "2026-08-07T02:02:15Z" }],
    chunks,
    claims: [],
    audit: [],
  };
}

/** Exactly what server.js hands the host: the serialized content array. */
function wireLength(result) {
  return JSON.stringify([{ type: "text", text: JSON.stringify(result, null, 2) }]).length;
}

async function runRepro(detail = reproDetail()) {
  return runKbDocDetail(
    { document_id: "note:notes/repro.md" },
    {
      intelFetch: async (p) => {
        if (p.includes("/resolve")) return { documentId: "doc-repro" };
        if (p.includes("/detail")) return detail;
        return {};
      },
      defaultWorkspaceId: "ws_an_local",
    },
  );
}

test("A2 reproducer: the UNPROJECTED bundle really does cross the MCP ceiling", async () => {
  // Validates the defect before the fix is credited with removing it. If this ever
  // stops being true the fix below is measuring nothing.
  const raw = { mode: "kb_doc_detail", workspaceId: "ws", detail: reproDetail() };
  assert.ok(
    wireLength(raw) > MCP_INLINE_OBSERVED_MAX_UNITS,
    `the raw bundle must exceed the ceiling to be a reproducer, got ${wireLength(raw)}`,
  );
});

test("A2-1: the complete document text is returned, chunk for chunk", async () => {
  const out = await runRepro();
  const text = out.detail.chunks.map((c) => c.indexedText).join("");
  assert.equal(text.length, REPRO_TEXT_CHARS, "the whole document, not a prefix");
  assert.equal(
    text,
    reproDetail().chunks.map((c) => c.indexedText).join(""),
    "and byte-identical to what intel served",
  );
});

test("A2-1: no chunk is dropped, capped or reordered", async () => {
  const out = await runRepro();
  assert.equal(out.detail.chunks.length, REPRO_CHUNKS, "no chunk_limit; truncation hides text");
  let prev = -1;
  for (const c of out.detail.chunks) {
    assert.ok(c.startOffset > prev, "chunks stay in document order");
    prev = c.startOffset;
  }
  assert.equal(out.detail.chunks[0].startOffset, 0);
  assert.equal(out.detail.chunks.at(-1).endOffset, REPRO_TEXT_CHARS, "contiguous to the end");
});

test("A2-1: per-chunk substrate identity is ABSENT from the model-facing response", async () => {
  const out = await runRepro();
  const dropped = [
    "chunkId",
    "revisionId",
    "runId",
    "normalizedContentHash",
    "normalizationVersion",
    "createdAt",
  ];
  for (const c of out.detail.chunks) {
    assert.deepEqual(
      Object.keys(c).sort(),
      ["endOffset", "indexedText", "startOffset"],
      "a chunk carries the text and its span, and nothing a reader cannot use",
    );
    for (const k of dropped) {
      assert.ok(!(k in c), `${k} must not reach the model`);
    }
  }
  // And not merely hidden behind a key rename: the VALUES are gone from the wire.
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes("content-normalization-v1"), "normalizationVersion value is gone");
  assert.ok(!wire.includes(String("a").repeat(64)), "chunk content hashes are gone");
});

test("A2-1: a REDACTED chunk keeps its withheld marker and its span", async () => {
  // indexedText null + offsets retained is how intel says "text withheld". Dropping
  // endOffset would make a redacted gap indistinguishable from an empty chunk, and
  // the reader could no longer tell that text is missing or how much.
  const d = reproDetail();
  d.chunks[3].indexedText = null;
  const out = await runRepro(d);
  const c = out.detail.chunks[3];
  assert.equal(c.indexedText, null);
  assert.equal(c.endOffset - c.startOffset, d.chunks[3].endOffset - d.chunks[3].startOffset);
});

test("A2-1: everything OUTSIDE chunks still passes through verbatim", async () => {
  const d = reproDetail();
  const out = await runRepro(d);
  for (const k of ["document", "serving", "servingStatus", "headRevision", "revisions", "claims", "audit"]) {
    assert.deepEqual(out.detail[k], d[k], `${k} is not ours to project`);
  }
  // The revision rail still carries the hashes; nothing was lost from the bundle,
  // it was moved off the 67x-repeated grain.
  assert.equal(out.detail.headRevision.normalizedContentHash, d.headRevision.normalizedContentHash);
});

test("A2-1: the real reproducer lands comfortably under the MCP ceiling", async () => {
  const out = await runRepro();
  const len = wireLength(out);
  assert.ok(len < MCP_INLINE_OBSERVED_MAX_UNITS, `still over the ceiling at ${len} units`);
  assert.ok(
    len < MCP_INLINE_OBSERVED_MAX_UNITS * 0.75,
    `no headroom: ${len} units is within 25% of the ceiling, and the ceiling is the host's dial`,
  );
});

test("A2-2: an oversized document puts DOCUMENT TEXT in the model-visible prefix", async () => {
  // The host's preview is a literal PREFIX of the serialized content array (proven
  // against the persisted artifact: `persisted.startsWith(previewPayload)` with the
  // cut landing mid-token). So key order decides what a truncated read contains.
  // This is degraded-preview behaviour, NOT a size reduction and NOT a contract:
  // JSON key order is a courtesy to the truncator.
  const d = reproDetail();
  d.revisions = Array.from({ length: 200 }, (_, i) => ({
    revisionId: `${String(i).padStart(8, "0")}-d146-4a1c-8fc5-b73b15dd27ee`,
    status: "SUPERSEDED",
    normalizedContentHash: String(i).padStart(64, "b"),
    createdAt: "2026-08-07T02:02:15.011000Z",
  }));
  const out = await runRepro(d);
  const wire = JSON.stringify([{ type: "text", text: JSON.stringify(out, null, 2) }]);
  const preview = wire.slice(0, 2000);
  assert.ok(
    preview.includes("## section 0"),
    "the first 2KB must carry the document's opening, not its uuid",
  );
});

// ---------------------------------------------------------------------------
// The tool advertised two knobs the server had already stopped honouring.
//
// The re-homed detail route (slice-A, kb_document_detail.py) takes ONLY
// workspaceId. FastAPI ignores unknown query params, so `revisionLimit` /
// `auditLimit` were accepted, forwarded and silently discarded. Proven live
// against the running service on 2026-08-07: the same document with and without
// `revisionLimit=1&auditLimit=1` returned byte-identical bodies (42,771 bytes,
// revisions=1 chunks=67 audit=0 both times). No 422, no effect.
//
// The CLI already knew -- `kb_show.ts` says "there are no revision / audit /
// chunk knobs to forward" and `kb-show.spec.ts` asserts the URL does NOT contain
// them. Only the MCP kept sending them, and only the MCP advertises them to a
// model, which is the surface where a knob that does nothing costs the most: it
// invites a reader to "just trim the payload" and quietly does not.
// ---------------------------------------------------------------------------

test("no query param is sent that the detail route does not honour", async () => {
  const seen = [];
  await runKbDocDetail(
    { document_id: "doc-1", revision_limit: 1, audit_limit: 1 },
    {
      intelFetch: async (p) => {
        seen.push(p);
        return p.includes("/detail") ? { chunks: [] } : {};
      },
      defaultWorkspaceId: "ws_an_local",
    },
  );
  const detailCall = seen.find((p) => p.includes("/detail"));
  const qs = new URLSearchParams(detailCall.split("?")[1] || "");
  assert.deepEqual([...qs.keys()], ["workspaceId"], "the route honours workspaceId and nothing else");
});

test("the tool does not advertise a parameter the route ignores", async () => {
  const { TOOLS } = await import("./tool_manifest.js");
  const tool = TOOLS.find((t) => t.name === "meetless__kb_doc_detail");
  // `offset` / `limit` are HANDLER-side paging over the returned chunk rail, not
  // intel query params. They are advertised because they are honoured HERE; the
  // rule the old assertion encoded is "no knob the server discards", and the
  // sibling test above still holds the wire side of it.
  assert.deepEqual(
    Object.keys(tool.inputSchema.properties).sort(),
    ["document_id", "limit", "offset"],
    "advertising a knob the server discards teaches the model a control it does not have",
  );
});

test("paging args are handled HERE and never forwarded to intel", async () => {
  const seen = [];
  await runKbDocDetail(
    { document_id: "doc-1", offset: 3, limit: 2 },
    {
      intelFetch: async (p) => {
        seen.push(p);
        return p.includes("/detail") ? { chunks: [] } : {};
      },
      defaultWorkspaceId: "ws_an_local",
    },
  );
  const detailCall = seen.find((p) => p.includes("/detail"));
  const qs = new URLSearchParams(detailCall.split("?")[1] || "");
  assert.deepEqual([...qs.keys()], ["workspaceId"]);
});

// ---------------------------------------------------------------------------
// The read path returned a uuid where a citation was needed, so nothing could
// see it -- not the agent, and not the ledger that counts citation-opens.
//
// Measured 2026-08-07 over ~/.meetless/logs/mcp-calls.jsonl: 104 kb_doc_detail
// calls, and `source_ids` is non-empty on exactly the 43 whose record happens to
// contain an `NT:` token. 104 of 104 split that cleanly, because the PostToolUse
// hook derives the pull's citations by grepping the call record for the
// `(DD|TH|NT|CC|...)` grammar, and a detail bundle carries uuids, not citation
// tokens. So the ONLY thing that ever matched was the caller's own argument.
// Address the same document as `note:<path>` or a bare uuid instead of
// `NT:<path>` and the open is invisible: no InjectionTrace row, and the turn
// reads in the pull ledger as though no governed memory was fetched.
//
// That happened on the turn this workstream is about. cdf1553e turn 4 opened two
// governed documents by hand at 04:20:20Z; control's injection_traces has five
// rows for that session and none of them is a citation-open.
//
// The envelope is where this is cheap to fix: the bundle already knows the note
// path (`document.externalObjectId` under `sourceSystem: "notes"`), so the tool
// can hand back the canonical token instead of making every caller reconstruct
// it. The agent gets the string it is measured on citing, and the hook's existing
// grammar finds it in the RESPONSE rather than only in a lucky argument.
// ---------------------------------------------------------------------------

function noteDetail(extra = {}) {
  return {
    document: {
      documentId: "883177c9-d146-4a1c-8fc5-b73b15dd27ee",
      sourceSystem: "notes",
      externalObjectId: "notes/20260806-did-mla-help.md",
      ...extra,
    },
    chunks: [{ chunkId: "c1", startOffset: 0, endOffset: 3, indexedText: "hi" }],
  };
}

async function runWith(detail, documentId = "note:notes/20260806-did-mla-help.md") {
  return runKbDocDetail(
    { document_id: documentId },
    {
      intelFetch: async (p) =>
        p.includes("/resolve") ? { documentId: "883177c9" } : detail,
      defaultWorkspaceId: "ws_an_local",
    },
  );
}

test("the envelope carries the canonical NT: citation for a note", async () => {
  const out = await runWith(noteDetail());
  assert.equal(out.citation, "NT:notes/20260806-did-mla-help.md");
});

test("the citation is canonical no matter how the document was addressed", async () => {
  // A bare uuid and a kbdoc: artifact must yield the SAME citation as NT:<path>.
  // Deriving it from the caller's argument is what made the ledger measure typing
  // style instead of behaviour.
  for (const id of [
    "883177c9-d146-4a1c-8fc5-b73b15dd27ee",
    "kbdoc:883177c9-d146-4a1c-8fc5-b73b15dd27ee",
    "NT:notes/20260806-did-mla-help.md",
    "note:notes/20260806-did-mla-help.md",
  ]) {
    const out = await runWith(noteDetail(), id);
    assert.equal(out.citation, "NT:notes/20260806-did-mla-help.md", `addressed as ${id}`);
  }
});

test("a non-note document gets a null citation, never a fabricated NT:", async () => {
  // NT: is the NOTE citation grammar. Minting one for a Slack-sourced or
  // Confluence-sourced document would hand the agent an id that resolves nowhere.
  const out = await runWith(noteDetail({ sourceSystem: "slack", externalObjectId: "C123/17000.1" }));
  assert.equal(out.citation, null);
});

test("a malformed bundle yields null rather than throwing", async () => {
  assert.equal((await runWith({ chunks: [] })).citation, null);
  assert.equal((await runWith({ document: {}, chunks: [] })).citation, null);
  assert.equal((await runWith({ document: { sourceSystem: "notes" }, chunks: [] })).citation, null);
});

test("the citation is inside the model-visible preview window", async () => {
  // A citation the host's 2KB cut removes is a citation the agent cannot use, and
  // it is the token this whole read path is measured on.
  const out = await runWith(noteDetail());
  const wire = JSON.stringify([{ type: "text", text: JSON.stringify(out, null, 2) }]);
  assert.ok(wire.slice(0, 2000).includes("NT:notes/20260806-did-mla-help.md"));
});

// ---------------------------------------------------------------------------
// D5 (2026-08-07): kb_doc_detail cannot open a large governed document.
//
// The canonical relations note is 295 chunks / 94,866 characters of text, and the
// projected result measures 135,264 outer String.length units against a host
// ceiling near 50,000. The tool "succeeds", the host persists the body and injects
// a 2KB preview, and the documented citation path (retrieve_knowledge -> snippet,
// kb_doc_detail -> full text) structurally fails on exactly the biggest and most
// canonical documents. These tests fix the shape of the paged contract.
// ---------------------------------------------------------------------------

/** The unit the host actually counts: the OUTER content array, escaping included. */
function outerUnits(result) {
  return JSON.stringify([{ type: "text", text: JSON.stringify(result, null, 2) }]).length;
}

/** A bundle with `n` chunks of `size` characters each, in document order. */
function bigDetail(n, size = 1200) {
  const chunks = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    // Distinct text per chunk so a duplicated or skipped page is detectable.
    const text = `c${i}:` + "x".repeat(Math.max(0, size - String(i).length - 2));
    chunks.push({
      chunkId: `chunk-${i}`,
      revisionId: "rev-1",
      startOffset: cursor,
      endOffset: cursor + text.length,
      indexedText: text,
      normalizedContentHash: "deadbeef".repeat(8),
      createdAt: "2026-08-07T00:00:00Z",
    });
    cursor += text.length;
  }
  return {
    document: { sourceSystem: "notes", externalObjectId: "notes/20260430-relations-handling-reference.md" },
    serving: {},
    headRevision: { id: "rev-1" },
    revisions: [{ id: "rev-1" }],
    chunks,
    claims: [],
    audit: [],
  };
}

async function page(detail, args) {
  const intelFetch = async (p) =>
    p.includes("/detail") ? detail : { documentId: "42cd4ea5-fa31-4bbf-840c-89f16e35c6f3" };
  return runKbDocDetail(
    { document_id: "NT:notes/20260430-relations-handling-reference.md", ...args },
    { intelFetch, defaultWorkspaceId: "ws_an_local" },
  );
}

test("D5: the default page of a 295-chunk document stays under the MCP result ceiling", async () => {
  const out = await page(bigDetail(295, 320));
  const units = outerUnits(out);
  assert.ok(
    units < 50000,
    `default page must fit the ~50,000-unit MCP ceiling, measured ${units}`,
  );
  assert.ok(out.detail.chunks.length > 0, "a non-empty document must return chunks");
});

test("D5: a document whose chunks are all large also fits (count caps are not size caps)", async () => {
  // 295 x 1,200 chars. A fixed per-page COUNT would blow the ceiling here while
  // passing on the 320-char document above; the bound has to be measured in size.
  const units = outerUnits(await page(bigDetail(295, 1200)));
  assert.ok(units < 50000, `large-chunk document must still fit, measured ${units}`);
});

test("D5: chunkCount and offset are reported so the caller can page deterministically", async () => {
  const out = await page(bigDetail(295, 320));
  assert.equal(out.chunkCount, 295, "chunkCount is the WHOLE document, not the page");
  assert.equal(out.chunkOffset, 0);
  assert.ok(
    out.chunkOffset + out.detail.chunks.length < out.chunkCount,
    "more chunks remain, and the caller can see that from offset + page length",
  );
});

test("D5: repeated offset calls recover every chunk exactly once, in document order", async () => {
  const detail = bigDetail(295, 320);
  const seen = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const out = await page(detail, { offset });
    assert.equal(out.chunkOffset, offset);
    assert.ok(out.detail.chunks.length > 0, `page at offset ${offset} must not be empty`);
    assert.ok(outerUnits(out) < 50000, `page at offset ${offset} must fit the ceiling`);
    for (const c of out.detail.chunks) seen.push(c.indexedText);
    offset += out.detail.chunks.length;
    if (offset >= out.chunkCount) break;
    if (++pages > 100) assert.fail("paging did not terminate");
  }
  assert.equal(seen.length, 295, "every chunk returned exactly once");
  const expected = detail.chunks.map((c) => c.indexedText);
  assert.deepEqual(seen, expected, "chunks arrive in document order with no gaps or repeats");
});

test("D5: a small document still returns whole, in one page", async () => {
  const out = await page(bigDetail(3, 100));
  assert.equal(out.chunkCount, 3);
  assert.equal(out.chunkOffset, 0);
  assert.equal(out.detail.chunks.length, 3);
});

test("D5: an out-of-range offset is an ordinary empty page, not an exception", async () => {
  const out = await page(bigDetail(3, 100), { offset: 99 });
  assert.equal(out.chunkCount, 3);
  assert.equal(out.chunkOffset, 99);
  assert.deepEqual(out.detail.chunks, []);
});

test("D5: an explicit limit caps the page below the size budget", async () => {
  const out = await page(bigDetail(295, 320), { limit: 5 });
  assert.equal(out.detail.chunks.length, 5);
  assert.equal(out.detail.chunks[0].indexedText.startsWith("c0:"), true);
});

test("D5: offset + limit together address an exact window", async () => {
  const out = await page(bigDetail(295, 320), { offset: 10, limit: 2 });
  assert.equal(out.chunkOffset, 10);
  assert.deepEqual(
    out.detail.chunks.map((c) => c.indexedText.slice(0, 4)),
    ["c10:", "c11:"],
  );
});

test("D5: one chunk larger than the whole budget is still returned (paging cannot deadlock)", async () => {
  // Never return an empty page while chunks remain: a caller that sees zero
  // chunks and a remaining count has no legal next offset and stalls forever.
  const out = await page(bigDetail(2, 60000));
  assert.equal(out.chunkOffset, 0);
  assert.equal(out.detail.chunks.length, 1, "exactly one oversized chunk, never zero");
});

test("D5: a malformed offset/limit fails loudly so the model can self-correct", async () => {
  await assert.rejects(() => page(bigDetail(3, 100), { offset: -1 }), /offset/);
  await assert.rejects(() => page(bigDetail(3, 100), { offset: 1.5 }), /offset/);
  await assert.rejects(() => page(bigDetail(3, 100), { limit: 0 }), /limit/);
  await assert.rejects(() => page(bigDetail(3, 100), { limit: "many" }), /limit/);
});

test("D5: a bundle without a chunks array is passed through untouched", async () => {
  const intelFetch = async (p) => (p.includes("/detail") ? { document: {}, note: "no chunks rail" } : {});
  const out = await runKbDocDetail(
    { document_id: "11111111-2222-3333-4444-555555555555" },
    { intelFetch, defaultWorkspaceId: "ws_an_local" },
  );
  assert.equal(out.detail.note, "no chunks rail");
  assert.equal(out.chunkCount, undefined, "no chunk rail means no paging rails to report");
});

test("D5: the paging rails sit inside the model-visible preview window", async () => {
  // Same reason as the citation: a rail the host's 2KB cut removes is a rail the
  // agent cannot act on, and paging is useless if the agent cannot see it is paged.
  const out = await page(bigDetail(295, 320));
  const wire = JSON.stringify([{ type: "text", text: JSON.stringify(out, null, 2) }]);
  const head = wire.slice(0, 2000);
  assert.ok(head.includes("chunkCount"), "chunkCount must survive the preview cut");
  assert.ok(head.includes("chunkOffset"), "chunkOffset must survive the preview cut");
});

// --- F4: every namespace retrieve_knowledge can return must be openable -------
//
// THE DEFECT (reproduced live 2026-08-08 against the dogfood workspace). The query
// "workspace scope decision accepted ruling" returned `DE:cmexample0000000000000006`
// as its single non-note candidate, and it was the ACCEPTED, highest-relevance hit.
// `kb_doc_detail("DE:cmexample0000000000000006")` answered:
//
//   KB document not found for "DE:..." in workspace "cmexample0000000000000001" (404)
//
// intel's `_PUBLIC_CITATION_PREFIXES` is exactly ("NT:", "CC:", "TH:", "DE:"), so the
// retrieval tool emits four namespaces and the detail tool resolved ONE. The 404 was
// not "no such decision": the decision exists, and control's own
// `GET /internal/v1/decisions/:id` returns it. The two tools ship together and
// disagreed about what a citation is.
//
// The contract these tests pin is COMPOSITION, not a message: whatever
// retrieve_knowledge hands back, kb_doc_detail either resolves through that class's
// own backing lookup or says, by name, that this class has no resolver. A 404 that
// reads as "the document does not exist" is the one answer that is never allowed,
// because it is false.

function makeDecisionDeps({ decision = { id: "d1", title: "T", status: "ACCEPTED" }, onFetch } = {}) {
  const calls = [];
  const controlFetch = async (pathAndQuery) => {
    calls.push(pathAndQuery);
    if (onFetch) return onFetch(pathAndQuery);
    return decision;
  };
  const intelFetch = async () => {
    throw new Error("intel must not be called for a DE: citation");
  };
  return { calls, deps: { intelFetch, controlFetch, defaultWorkspaceId: "ws_an_local" } };
}

test("F4: a DE: citation resolves through the decision-record lookup, not a KB 404", async () => {
  const { calls, deps } = makeDecisionDeps({
    decision: { id: "cmry1", title: "Workspace scope is the default", status: "ACCEPTED" },
  });
  const out = await runKbDocDetail({ document_id: "DE:cmry1" }, deps);

  assert.equal(out.mode, "decision_record");
  assert.equal(out.requestedDocumentId, "DE:cmry1");
  assert.equal(out.resolvedDocumentId, "cmry1");
  assert.equal(out.resolverSource, "decision");
  // The citation the agent should quote is the one it asked with: the metric counts
  // the DE: token, and minting a different string here would break that join.
  assert.equal(out.citation, "DE:cmry1");
  assert.equal(out.detail.title, "Workspace scope is the default");
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].startsWith("/internal/v1/decisions/cmry1?"),
    `expected the decision-record lookup, got ${calls[0]}`,
  );
  assert.ok(calls[0].includes("workspaceId=ws_an_local"));
});

test("F4: a lowercase de: citation resolves too (the agent retypes citations)", async () => {
  const { deps } = makeDecisionDeps();
  const out = await runKbDocDetail({ document_id: "de:d1" }, deps);
  assert.equal(out.mode, "decision_record");
  assert.equal(out.resolvedDocumentId, "d1");
});

test("F4: a DE: id that control does not hold reports the DECISION not found, never the KB", async () => {
  const { deps } = makeDecisionDeps({
    onFetch: () => {
      const e = new Error("control 404");
      e.status = 404;
      throw e;
    },
  });
  await assert.rejects(
    () => runKbDocDetail({ document_id: "DE:ghost" }, deps),
    (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /decision/i);
      assert.ok(
        !/KB document not found/.test(err.message),
        "a decision miss must not be reported as a missing KB document",
      );
      return true;
    },
  );
});

test("F4: a DE: citation with no control lookup wired says so, and names the tool that has one", async () => {
  // The legacy env bin and any embedder that binds only intelFetch. Degrading to the
  // KB 404 here would resurrect exactly the defect: an honest "this surface cannot
  // reach control" is a different claim from "the decision does not exist".
  await assert.rejects(
    () => runKbDocDetail({ document_id: "DE:d1" }, { intelFetch: async () => ({}), defaultWorkspaceId: "ws" }),
    /decision_record|control/i,
  );
});

test("F4: a CC: citation dispatches to the case lookup rather than 404ing as a KB document", async () => {
  const calls = [];
  const controlFetch = async (p) => {
    calls.push(p);
    return { id: "case1", title: "A scope change", statusId: "APPROVED" };
  };
  const out = await runKbDocDetail(
    { document_id: "CC:case1" },
    {
      intelFetch: async () => {
        throw new Error("intel must not be called for a CC: citation");
      },
      controlFetch,
      defaultWorkspaceId: "ws_an_local",
      operatorUserId: "u1",
    },
  );
  assert.equal(out.mode, "coordination_case");
  assert.equal(out.citation, "CC:case1");
  assert.equal(out.resolvedDocumentId, "case1");
  assert.equal(out.detail.title, "A scope change");
  assert.ok(calls[0].startsWith("/internal/v1/cases/case1?"), `got ${calls[0]}`);
  assert.ok(calls[0].includes("workspaceId=ws_an_local"));
  assert.ok(calls[0].includes("actorUserId=u1"));
});

test("F4: a CC: read the caller has no viewer for names the missing identity, not a missing case", async () => {
  await assert.rejects(
    () =>
      runKbDocDetail(
        { document_id: "CC:case1" },
        { intelFetch: async () => ({}), controlFetch: async () => ({}), defaultWorkspaceId: "ws" },
      ),
    (err) => {
      assert.match(err.message, /viewer|mla login|actor/i);
      assert.ok(!/not found/i.test(err.message));
      return true;
    },
  );
});

test("F4: TH: is the ONE namespace with no resolver, and it says so by name", async () => {
  // Inventoried 2026-08-08: control exposes no thread-detail route on /internal/v1,
  // and intel's ACL-enforcing artifact repo is reachable only from inside the ask
  // graph, never over HTTP. So TH: is genuinely unresolvable today. It must say that
  // -- naming the namespace and what the agent CAN do -- and must never reuse the
  // "KB document not found" line, which asserts the thread does not exist.
  await assert.rejects(
    () =>
      runKbDocDetail(
        { document_id: "TH:t-123" },
        { intelFetch: async () => ({}), controlFetch: async () => ({}), defaultWorkspaceId: "ws" },
      ),
    (err) => {
      assert.match(err.message, /TH:/);
      assert.match(err.message, /retrieve_knowledge/);
      assert.ok(
        !/KB document not found/.test(err.message),
        "an unresolvable class must not claim the object is missing",
      );
      return true;
    },
  );
});

test("F4: NT:/note:/kbdoc:/uuid keep resolving exactly as before", async () => {
  // The regression fence. The dispatch is additive; the note path is untouched.
  for (const id of [
    "NT:notes/20260101-foo.md",
    "note:20260101-foo.md",
    "kbdoc:11111111-2222-3333-4444-555555555555",
    "11111111-2222-3333-4444-555555555555",
  ]) {
    const intelFetch = async (p) => {
      if (p.includes("/resolve")) return { documentId: "doc-1" };
      return { id: "doc-1", chunks: [], document: {} };
    };
    const out = await runKbDocDetail(
      { document_id: id },
      { intelFetch, controlFetch: async () => ({}), defaultWorkspaceId: "ws_an_local" },
    );
    assert.equal(out.mode, "kb_doc_detail", `${id} must still take the KB path`);
  }
});
