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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  reverseMapEoidToFile,
  resolveReingestVaultRoot,
  ReingestPreconditionError,
} from "../../src/commands/kb_reingest";

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe("reverseMapEoidToFile", () => {
  const vault = mkTmp("mla-reingest-rev-");
  beforeAll(() => {
    fs.mkdirSync(path.join(vault, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(vault, "decisions", "no-redis.md"), "body\n");
  });

  test("strips the `notes/` identity root and joins under the vault", () => {
    // The stored id is `notes/<rel>`; the vault root holds `<rel>`. (Case-
    // folding of the id is the FS's job on a case-insensitive volume; the spec
    // uses matching case so it is deterministic on any FS.)
    const abs = reverseMapEoidToFile("notes/decisions/no-redis.md", vault);
    expect(abs).toBe(path.join(vault, "decisions", "no-redis.md"));
  });

  test("rejects an id not under the `notes/` identity root", () => {
    expect(() => reverseMapEoidToFile("decisions/no-redis.md", vault)).toThrow(
      ReingestPreconditionError,
    );
    expect(() => reverseMapEoidToFile("decisions/no-redis.md", vault)).toThrow(
      /identity root/,
    );
  });

  test("rejects a `..` escape out of the vault root", () => {
    expect(() =>
      reverseMapEoidToFile("notes/../../etc/passwd", vault),
    ).toThrow(/escapes vault root/);
  });

  test("rejects an id that maps to a missing file", () => {
    expect(() =>
      reverseMapEoidToFile("notes/decisions/ghost.md", vault),
    ).toThrow(/does not resolve to a readable file/);
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
