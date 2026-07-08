import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  resolveWorkspaceContext,
  resolveWorkspaceId,
  tryResolveWorkspaceId,
  findWorkspaceContext,
  NotActivatedError,
  MarkerMissingWorkspaceIdError,
} from "../../src/lib/workspace";

// T1.1 (folder = workspace, notes/20260604-folder-equals-workspace-binding-
// design.md): the shared TS resolver is the ONLY source of the workspaceId.
// It walks UP from a start dir to the nearest `.meetless.json` (nearest-wins,
// CLAUDE.md-style), returns the marker's workspaceId/workspaceName, and refuses
// with a clean "not activated" error when no usable marker is found. cli-config
// is no longer a fallback. This spec locks every branch the CLI relies on.

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-ws-resolver-"));
}

function writeMarker(dir: string, body: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".meetless.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

describe("shared workspace resolver (T1.1)", () => {
  const created: string[] = [];
  afterAll(() => {
    for (const d of created) fs.rmSync(d, { recursive: true, force: true });
  });

  it("resolves workspaceId + workspaceName from a marker in the start dir", () => {
    const root = mkTmp();
    created.push(root);
    writeMarker(root, { workspaceId: "ws_alpha", workspaceName: "Alpha" });

    const ctx = resolveWorkspaceContext(root);
    expect(ctx.workspaceId).toBe("ws_alpha");
    expect(ctx.workspaceName).toBe("Alpha");
    // findActivation uses path.resolve (not realpath), so the dir matches the
    // start dir verbatim when the marker lives in it.
    expect(ctx.markerPath).toBe(path.join(path.resolve(root), ".meetless.json"));
    expect(ctx.markerDir).toBe(path.resolve(root));
  });

  it("walks UP to the nearest marker (nearest-wins from a nested subdir)", () => {
    const root = mkTmp();
    created.push(root);
    writeMarker(root, { workspaceId: "ws_root" });
    const nested = path.join(root, "apps", "control", "src");
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveWorkspaceId(nested)).toBe("ws_root");
  });

  it("prefers a deeper marker over a parent marker (sub-project wins)", () => {
    const root = mkTmp();
    created.push(root);
    writeMarker(root, { workspaceId: "ws_root" });
    const sub = path.join(root, "packages", "widget");
    writeMarker(sub, { workspaceId: "ws_widget" });

    expect(resolveWorkspaceId(sub)).toBe("ws_widget");
    // The parent still resolves to its own marker from above the sub-project.
    expect(resolveWorkspaceId(root)).toBe("ws_root");
  });

  it("throws NotActivatedError when no marker exists anywhere up the tree", () => {
    const root = mkTmp();
    created.push(root);
    const bare = path.join(root, "no", "marker", "here");
    fs.mkdirSync(bare, { recursive: true });

    expect(() => resolveWorkspaceId(bare)).toThrow(NotActivatedError);
    expect(() => resolveWorkspaceId(bare)).toThrow(/mla activate/i);
  });

  it("throws MarkerMissingWorkspaceIdError when the marker has no workspaceId", () => {
    const root = mkTmp();
    created.push(root);
    writeMarker(root, { note: "bound but id stripped" });

    expect(() => resolveWorkspaceContext(root)).toThrow(
      MarkerMissingWorkspaceIdError,
    );
  });

  it("treats a malformed marker as missing-workspaceId (not a hard crash)", () => {
    const root = mkTmp();
    created.push(root);
    writeMarker(root, "{ this is : not json");

    expect(() => resolveWorkspaceContext(root)).toThrow(
      MarkerMissingWorkspaceIdError,
    );
  });

  it("tryResolveWorkspaceId returns null instead of throwing when not activated", () => {
    const root = mkTmp();
    created.push(root);
    const bare = path.join(root, "unmarked");
    fs.mkdirSync(bare, { recursive: true });

    expect(tryResolveWorkspaceId(bare)).toBeNull();
  });

  it("tryResolveWorkspaceId returns the id when a marker is present", () => {
    const root = mkTmp();
    created.push(root);
    writeMarker(root, { workspaceId: "ws_beta" });

    expect(tryResolveWorkspaceId(root)).toBe("ws_beta");
  });

  it("findWorkspaceContext returns null (not throw) when not activated", () => {
    const root = mkTmp();
    created.push(root);
    const bare = path.join(root, "unmarked");
    fs.mkdirSync(bare, { recursive: true });

    expect(findWorkspaceContext(bare)).toBeNull();
  });
});
