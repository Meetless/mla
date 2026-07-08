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

// kb_doc_detail is note-only: DD: (decision diffs) and TH: (threads) are NOT KB
// documents, so they must NOT be sent to the note resolve route. They fall
// through to the raw branch and surface a clean "not found", documenting that
// the "open any citation" handoff is note-scoped.
test("DD: and TH: citations are NOT routed through the note resolve route", async () => {
  for (const cite of ["DD:cmdiff123", "TH:1700000000.0001"]) {
    const seen = [];
    await runKbDocDetail(
      { document_id: cite },
      {
        intelFetch: async (p) => {
          seen.push(p);
          if (p.includes("/detail")) return { id: "x" };
          return {};
        },
        defaultWorkspaceId: "ws_an_local",
      },
    );
    assert.ok(
      !seen.some((p) => p.includes("/resolve")),
      `${cite} must not hit the note resolve route (it is not a KB document)`,
    );
  }
});
