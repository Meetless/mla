import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { governedPathCacheKey, writeGovernedPath, readGovernedPath, governedPathEntryForReceipt } from "../../src/lib/governed-path-cache";
import { KbAddReceipt } from "../../src/lib/render";

function liveReceipt(over: Partial<KbAddReceipt> = {}): KbAddReceipt {
  return {
    mode: "file",
    workspaceId: "ws_1",
    outcome: "ingested",
    documentId: "doc_live",
    canonicalPath: "notes/x.md",
    parentUuid: "p",
    provenance: "external_imported",
    ...over,
  };
}

describe("governed-path-cache (test 33)", () => {
  it("key includes owner, workspace, repo, path and namespace; never bare path", () => {
    const k = governedPathCacheKey({ workspaceId: "ws_1", ownerUserId: "user_a", repoRootHash: "repoA", canonicalPath: "notes/x.md", namespace: "personal" });
    expect(k).toContain("ws_1");
    expect(k).toContain("user_a");
    expect(k).toContain("repoA");
    expect(k).toContain("personal");
  });

  it("owner A's add never reads owner B's cached doc (test 33)", () => {
    const home = mkdtempSync(join(tmpdir(), "gpc-"));
    const a = { workspaceId: "ws_1", ownerUserId: "user_a", repoRootHash: "repoA", canonicalPath: "notes/x.md", namespace: "personal" as const };
    const b = { ...a, ownerUserId: "user_b" };
    writeGovernedPath(a, "doc_a", home);
    expect(readGovernedPath(b, home)).toBeNull(); // different owner -> miss
    expect(readGovernedPath(a, home)).toBe("doc_a");
  });

  it("repoRootHash also isolates (test 33)", () => {
    const home = mkdtempSync(join(tmpdir(), "gpc-"));
    const a = { workspaceId: "ws_1", ownerUserId: "user_a", repoRootHash: "repoA", canonicalPath: "notes/x.md", namespace: "personal" as const };
    writeGovernedPath(a, "doc_a", home);
    expect(readGovernedPath({ ...a, repoRootHash: "repoB" }, home)).toBeNull();
  });

  it("personal and shared namespaces do not collide", () => {
    const home = mkdtempSync(join(tmpdir(), "gpc-"));
    const base = { workspaceId: "ws_1", ownerUserId: "user_a", repoRootHash: "repoA", canonicalPath: "notes/x.md" };
    writeGovernedPath({ ...base, namespace: "personal" }, "p", home);
    expect(readGovernedPath({ ...base, namespace: "shared" }, home)).toBeNull();
  });
});

describe("governedPathEntryForReceipt (test 33)", () => {
  const ctx = { workspaceId: "ws_1", ownerUserId: "user_a", repoRootHash: "repoA" };

  it("an ingested receipt maps to the personal namespace by default (posture-blind after born-PENDING)", () => {
    const entry = governedPathEntryForReceipt(liveReceipt({ documentId: "doc_live", canonicalPath: "notes/live.md" }), ctx);
    expect(entry).not.toBeNull();
    expect(entry!.docId).toBe("doc_live");
    expect(entry!.key.namespace).toBe("personal");
    expect(entry!.key.canonicalPath).toBe("notes/live.md");
    expect(entry!.key.workspaceId).toBe("ws_1");
    expect(entry!.key.ownerUserId).toBe("user_a");
    expect(entry!.key.repoRootHash).toBe("repoA");
  });

  it("ctx.defaultPosture=LIVE routes the entry to the shared namespace", () => {
    const entry = governedPathEntryForReceipt(liveReceipt({ documentId: "doc_shared" }), { ...ctx, defaultPosture: "LIVE" });
    expect(entry).not.toBeNull();
    expect(entry!.docId).toBe("doc_shared");
    expect(entry!.key.namespace).toBe("shared");
  });

  it("a body-changing ingested receipt produces an entry (live body)", () => {
    const entry = governedPathEntryForReceipt(liveReceipt({ outcome: "ingested" }), ctx);
    expect(entry).not.toBeNull();
  });

  it("a content-identical no-op / failed / corpus receipt yields null (no live body)", () => {
    expect(governedPathEntryForReceipt(liveReceipt({ outcome: "noop_unchanged" }), ctx)).toBeNull();
    expect(governedPathEntryForReceipt(liveReceipt({ outcome: "failed" }), ctx)).toBeNull();
    expect(governedPathEntryForReceipt(liveReceipt({ mode: "corpus" }), ctx)).toBeNull();
  });

  it("a receipt missing the document id or canonical path yields null", () => {
    expect(governedPathEntryForReceipt(liveReceipt({ documentId: "" }), ctx)).toBeNull();
    expect(governedPathEntryForReceipt(liveReceipt({ canonicalPath: "" }), ctx)).toBeNull();
  });
});
