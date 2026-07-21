// test/commands/activate-repo-path.spec.ts
//
// `mla activate` sends the folder path as the re-activation key: control hands
// back the workspace this human already owns at that path instead of minting a
// twin every time they deactivate and activate again
// (notes/20260721-mla-activate-path-keyed-workspace.md).
//
// That makes the key STRING the whole feature. Control compares it exactly, so
// two spellings of one directory are two workspaces, and the dedup silently does
// nothing while looking like it works. Both spellings below happen by default on
// a stock Mac, which is why this is a spec and not a comment.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { canonicalRepoPath } from "../../src/commands/activate";

describe("canonicalRepoPath", () => {
  it("returns an absolute path", () => {
    expect(path.isAbsolute(canonicalRepoPath(process.cwd()))).toBe(true);
  });

  it("resolves symlinks so /tmp and /private/tmp are ONE key", () => {
    // os.tmpdir() is /var/folders/... on macOS, which is itself reached through
    // the /private symlink. Skip where the platform has no such indirection
    // rather than assert a Linux-specific truth.
    const real = fs.realpathSync.native(os.tmpdir());
    if (real === os.tmpdir()) {
      return;
    }
    expect(canonicalRepoPath(os.tmpdir())).toBe(real);
  });

  it("collapses case variants of the same directory to one key", () => {
    // The duplicate-workspace bug in miniature: a human types `cd ~/Projects/app`
    // one day and `cd ~/projects/app` the next. On a case-INSENSITIVE volume (the
    // macOS default) those are the same folder, so they must yield the same key.
    // realpathSync.native returns the on-disk canonical case; path.resolve alone
    // would preserve whatever the human typed and mint a second workspace.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "MlaCase-"));
    const swapped = path.join(path.dirname(dir), path.basename(dir).toUpperCase());

    let caseInsensitive = false;
    try {
      caseInsensitive = fs.statSync(swapped).isDirectory();
    } catch {
      caseInsensitive = false;
    }
    // On a case-SENSITIVE volume the swapped name is a genuinely different
    // directory, so there is nothing to collapse and nothing to assert.
    if (!caseInsensitive) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    expect(canonicalRepoPath(swapped)).toBe(canonicalRepoPath(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to a resolved path instead of throwing when the folder is gone", () => {
    // A failure to canonicalize must never block activation: an un-canonical key
    // still dedupes against itself, whereas a thrown error loses the workspace.
    const missing = path.join(os.tmpdir(), `mla-missing-${Date.now()}`);
    expect(canonicalRepoPath(missing)).toBe(path.resolve(missing));
  });
});
