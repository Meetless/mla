// The HTTP `mla kb reingest` re-delivers an EXISTING governed document's
// current on-disk content. The server holds the governed identity (the
// canonicalized externalObjectId) but NOT the filesystem, so the CLIENT
// locates the source file: it resolves the notes vault root and reverse-maps
// the stored `notes/<rel>` externalObjectId back to a file. This spec pins that
// client contract, which used to live in the python worker
// (tools/mla_kb_reingest.py: _resolve_vault_root /
// _abs_path_from_external_object_id). It is the replacement for the deleted
// kb-reingest-parse.spec.ts (which pinned the now-gone subprocess stdout
// scanner; reingest no longer spawns a subprocess).
//
// The resolution ITSELF now lives in src/lib/notes-root.ts, shared with kb add,
// mcp, and ask, and is specced there (test/lib/notes-root.spec.ts). What this
// file still guards is the part that is reingest's own: every resolution failure
// must surface as a ReingestPreconditionError, because that is what maps to exit
// code 2 ("your input is wrong") rather than exit code 1 ("we are broken"). A
// leaked NotesRootError would exit 1 and tell the operator to retry a command
// that can never succeed.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  reingestSourceFileForEoid,
  resolveReingestVaultRoot,
  ReingestPreconditionError,
} from "../../src/commands/kb_reingest";

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe("reingestSourceFileForEoid", () => {
  const vault = mkTmp("mla-reingest-rev-");
  const savedEnv = process.env.MEETLESS_NOTES_ROOT;

  beforeAll(() => {
    fs.mkdirSync(path.join(vault, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(vault, "decisions", "no-redis.md"), "body\n");
  });

  beforeEach(() => {
    // Pin the vault so the candidate ladder is deterministic under a tmp dir
    // (which has neither a git root nor a sibling vault). The ladder itself is
    // specced in test/lib/notes-root.spec.ts.
    process.env.MEETLESS_NOTES_ROOT = vault;
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env.MEETLESS_NOTES_ROOT;
    else process.env.MEETLESS_NOTES_ROOT = savedEnv;
  });

  test("strips the `notes/` identity root and joins under the vault", () => {
    // The stored id is `notes/<rel>`; the vault root holds `<rel>`. (Case-
    // folding of the id is the FS's job on a case-insensitive volume; the spec
    // uses matching case so it is deterministic on any FS.)
    const abs = reingestSourceFileForEoid(
      "notes/decisions/no-redis.md",
      os.tmpdir(),
    );
    expect(abs).toBe(path.join(vault, "decisions", "no-redis.md"));
  });

  test("does not depend on the CWD: the anchor never decides the answer alone", () => {
    // THE BUG. Reingest used to walk up from process.cwd(), so running it from
    // the code repo reverse-mapped the identity into the code repo and died.
    // The identity resolves to the same file from any anchor.
    const fromElsewhere = reingestSourceFileForEoid(
      "notes/decisions/no-redis.md",
      path.join(vault, "decisions"),
    );
    expect(fromElsewhere).toBe(path.join(vault, "decisions", "no-redis.md"));
  });

  test("rejects an id not under the `notes/` identity root", () => {
    expect(() =>
      reingestSourceFileForEoid("decisions/no-redis.md", os.tmpdir()),
    ).toThrow(ReingestPreconditionError);
    expect(() =>
      reingestSourceFileForEoid("decisions/no-redis.md", os.tmpdir()),
    ).toThrow(/identity root/);
  });

  test("rejects a `..` escape out of the vault root", () => {
    expect(() =>
      reingestSourceFileForEoid("notes/../../etc/passwd", os.tmpdir()),
    ).toThrow(ReingestPreconditionError);
    expect(() =>
      reingestSourceFileForEoid("notes/../../etc/passwd", os.tmpdir()),
    ).toThrow(/escapes vault root/);
  });

  test("rejects an id that maps to a missing file, naming where it looked", () => {
    expect(() =>
      reingestSourceFileForEoid("notes/decisions/ghost.md", os.tmpdir()),
    ).toThrow(ReingestPreconditionError);
    expect(() =>
      reingestSourceFileForEoid("notes/decisions/ghost.md", os.tmpdir()),
    ).toThrow(/was not found in any notes vault root[\s\S]*ghost\.md/);
  });
});

describe("resolveReingestVaultRoot", () => {
  test("honors MEETLESS_NOTES_ROOT", () => {
    const vault = mkTmp("mla-reingest-env-");
    const prev = process.env.MEETLESS_NOTES_ROOT;
    process.env.MEETLESS_NOTES_ROOT = vault;
    try {
      expect(resolveReingestVaultRoot(os.tmpdir())).toBe(vault);
    } finally {
      if (prev === undefined) delete process.env.MEETLESS_NOTES_ROOT;
      else process.env.MEETLESS_NOTES_ROOT = prev;
    }
  });

  test("falls back to a git-repo-root walk-up from the anchor", () => {
    const repo = mkTmp("mla-reingest-git-");
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(repo, "notes"), { recursive: true });
    const anchor = path.join(repo, "notes");
    const prev = process.env.MEETLESS_NOTES_ROOT;
    delete process.env.MEETLESS_NOTES_ROOT;
    try {
      expect(resolveReingestVaultRoot(anchor)).toBe(repo);
    } finally {
      if (prev !== undefined) process.env.MEETLESS_NOTES_ROOT = prev;
    }
  });

  test("throws a precondition when neither env nor git resolves a root", () => {
    // A bare tmp dir with no `.git` ancestor and no env override.
    const stray = mkTmp("mla-reingest-none-");
    const prev = process.env.MEETLESS_NOTES_ROOT;
    delete process.env.MEETLESS_NOTES_ROOT;
    try {
      expect(() => resolveReingestVaultRoot(stray)).toThrow(
        ReingestPreconditionError,
      );
    } finally {
      if (prev !== undefined) process.env.MEETLESS_NOTES_ROOT = prev;
    }
  });
});
