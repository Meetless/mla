import * as fs from "fs";
import * as path from "path";

// Folder = workspace test helper (T1.1, notes/20260604-folder-equals-workspace-
// binding-design.md). After the hard cutover, the CLI resolves workspaceId by
// walking up from cwd to the nearest `.meetless.json` marker, NOT from the
// machine-global cli-config. Specs that exercise a workspace-scoped command must
// therefore bind a real marker in a real directory and run from inside it; a
// `workspaceId` field in the written cli-config is now ignored.
//
// bindWorkspaceMarker writes a marker into `dir` and chdirs into it, returning a
// restore() that puts cwd back. Call it in beforeEach/beforeAll and the returned
// restore in the matching afterEach/afterAll so the global cwd never leaks across
// tests. Each spec file runs in its own jest worker, so process.chdir here is
// isolated to that file.
export function bindWorkspaceMarker(
  dir: string,
  workspaceId: string,
  extra: Record<string, unknown> = {},
): () => void {
  fs.writeFileSync(
    path.join(dir, ".meetless.json"),
    JSON.stringify({
      workspaceId,
      activatedAt: "2026-06-04T00:00:00.000Z",
      ...extra,
    }),
  );
  const prev = process.cwd();
  process.chdir(dir);
  return () => process.chdir(prev);
}
