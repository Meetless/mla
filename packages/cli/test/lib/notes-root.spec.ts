import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Only readdirSync is made mockable, and only so the ambiguity case below can be
// staged: no case-insensitive filesystem can hold README.md and readme.md in one
// directory, so on this laptop that listing has to be faked. Everything else is
// the real fs (jest.spyOn cannot touch it: fs's exports are non-configurable).
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return { ...actual, readdirSync: jest.fn(actual.readdirSync) };
});
const readdirMock = fs.readdirSync as unknown as jest.Mock;

import {
  bestEffortNotesRoot,
  NotesRootError,
  notesRootCandidates,
  resolveNotesSourceFile,
  resolveVaultRootForFile,
} from "../../src/lib/notes-root";

// The layout this module exists for, and the one that broke `mla kb reingest`:
//
//   <tmp>/projects/code/     <- a git repo, where the operator actually works
//   <tmp>/projects/notes/    <- a SEPARATE git repo, the governed vault
//
// `mla kb add <tmp>/projects/notes/foo.md` anchors on the FILE, walks up to the
// notes repo, and mints the identity `notes/foo.md`. Reingesting that identity
// from inside the code repo used to anchor on CWD, walk up to the CODE repo, and
// look for `<tmp>/projects/code/foo.md`, which does not exist. Same identity,
// two answers. Every case below is a face of that bug.

let tmpRoot: string;
let codeRepo: string;
let vaultRepo: string;
const savedEnv = process.env.MEETLESS_NOTES_ROOT;

function mkGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

beforeEach(() => {
  delete process.env.MEETLESS_NOTES_ROOT;
  tmpRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "notes-root-")),
  );
  codeRepo = path.join(tmpRoot, "projects", "code");
  vaultRepo = path.join(tmpRoot, "projects", "notes");
  mkGitRepo(codeRepo);
  mkGitRepo(vaultRepo);
  fs.writeFileSync(path.join(vaultRepo, "20260513-taxonomy.md"), "# real\n");
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MEETLESS_NOTES_ROOT;
  else process.env.MEETLESS_NOTES_ROOT = savedEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("notesRootCandidates", () => {
  it("offers the code repo AND its sibling vault, in that order", () => {
    const got = notesRootCandidates(path.join(codeRepo, "apps", "control"));
    expect(got.map((c) => c.root)).toEqual([codeRepo, vaultRepo]);
  });

  it("never offers <gitRoot>/notes: a same-named file there would shadow the real vault", () => {
    // The code repo has its own notes/ directory (ours does). A file in it must
    // not be able to answer for an identity minted against the standalone vault.
    const decoy = path.join(codeRepo, "notes");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "20260513-taxonomy.md"), "# DECOY\n");

    const got = notesRootCandidates(codeRepo);
    expect(got.map((c) => c.root)).not.toContain(decoy);
  });

  it("treats an explicit MEETLESS_NOTES_ROOT as the only candidate", () => {
    process.env.MEETLESS_NOTES_ROOT = vaultRepo;
    const got = notesRootCandidates(codeRepo);
    expect(got).toEqual([{ root: vaultRepo, source: "MEETLESS_NOTES_ROOT" }]);
  });

  it("throws on an explicit root that is not a directory instead of silently ignoring it", () => {
    process.env.MEETLESS_NOTES_ROOT = path.join(tmpRoot, "nope");
    expect(() => notesRootCandidates(codeRepo)).toThrow(NotesRootError);
  });
});

describe("resolveNotesSourceFile", () => {
  it("finds the vault file from inside the CODE repo (the reingest bug)", () => {
    const got = resolveNotesSourceFile(
      "notes/20260513-taxonomy.md",
      path.join(codeRepo, "apps", "control"),
    );
    expect(got.file).toBe(path.join(vaultRepo, "20260513-taxonomy.md"));
    expect(got.vaultRoot).toBe(vaultRepo);
  });

  it("prefers the candidate that actually HOLDS the file, not the first that exists", () => {
    // The code repo is candidate 1 and is a perfectly good directory. It just
    // does not have the document. A resolver that stops at the first existing
    // root reads the wrong vault (or, as before, nothing at all).
    const got = resolveNotesSourceFile("notes/20260513-taxonomy.md", codeRepo);
    expect(got.vaultRoot).toBe(vaultRepo);
  });

  it("resolves an identity whose file lives at the code repo root when that IS the vault", () => {
    fs.writeFileSync(path.join(codeRepo, "inline.md"), "# inline\n");
    const got = resolveNotesSourceFile("notes/inline.md", codeRepo);
    expect(got.file).toBe(path.join(codeRepo, "inline.md"));
  });

  it("resolves a vault NESTED at <repo>/notes, whose identity carries the extra segment", () => {
    // A nested vault mints its rel path against the REPO root, so the identity
    // is notes/notes/<x>.md and candidate 1 (the git root) resolves it. This is
    // why <gitRoot>/notes is not, and must not be, a candidate root.
    const nested = path.join(codeRepo, "notes");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "nested.md"), "# nested\n");

    const got = resolveNotesSourceFile("notes/notes/nested.md", codeRepo);
    expect(got.file).toBe(path.join(nested, "nested.md"));
    expect(got.vaultRoot).toBe(codeRepo);
  });

  it("names every root it looked in when the file is nowhere", () => {
    expect(() =>
      resolveNotesSourceFile("notes/ghost.md", codeRepo),
    ).toThrow(/ghost\.md.*was not found[\s\S]*code[\s\S]*notes/);
  });

  it("refuses an identity outside the notes/ root", () => {
    expect(() => resolveNotesSourceFile("blobs/x.md", codeRepo)).toThrow(
      /identity root/,
    );
  });

  it("refuses a `..` escape out of the vault", () => {
    expect(() =>
      resolveNotesSourceFile("notes/../../etc/passwd", codeRepo),
    ).toThrow(/escapes vault root/);
  });

  it("does not fall through to another vault when an explicit root misses", () => {
    // The operator said where the vault is. Quietly reading a different one is
    // exactly the silent-wrong-bytes failure this module exists to prevent.
    process.env.MEETLESS_NOTES_ROOT = codeRepo;
    expect(() =>
      resolveNotesSourceFile("notes/20260513-taxonomy.md", codeRepo),
    ).toThrow(/was not found/);
  });

  it("resolves a CASEFOLDED identity to the real on-disk name, on any filesystem", () => {
    // The stored identity is casefolded unconditionally, so it is not a path:
    // nothing is named hermes-agent/readme.md. macOS folds case in the kernel and
    // used to resolve it by accident; Linux does not, so every note with an
    // uppercase letter in its name (INDEX.md, README.md) was unreingestable there.
    // The resolver folds the directory listing instead, which is why this asserts
    // the REAL name and gets the same answer on both hosts.
    const dir = path.join(vaultRepo, "Hermes-Agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# readme\n");

    const got = resolveNotesSourceFile(
      "notes/hermes-agent/readme.md",
      codeRepo,
    );
    expect(got.file).toBe(path.join(dir, "README.md"));
    expect(fs.readFileSync(got.file, "utf8")).toBe("# readme\n");
  });

  it("refuses to guess when two files fold to the same identity", () => {
    // Only a case-sensitive fs can hold README.md and readme.md side by side, so
    // the listing is faked rather than written: the point is the resolver's
    // arbitration, not the kernel's. Both mint the SAME externalObjectId, so
    // picking either one is picking at random.
    readdirMock.mockReturnValueOnce(["readme.md", "README.md"]);
    expect(() => resolveNotesSourceFile("notes/readme.md", codeRepo)).toThrow(
      /ambiguous[\s\S]*README\.md[\s\S]*readme\.md/,
    );
  });
});

describe("resolveVaultRootForFile", () => {
  it("anchors on the file's own directory, which is what makes `kb add` correct", () => {
    expect(resolveVaultRootForFile(vaultRepo)).toBe(vaultRepo);
  });
});

describe("bestEffortNotesRoot", () => {
  it("picks the candidate that looks like a vault (holds INDEX.md), not the first directory", () => {
    fs.writeFileSync(path.join(vaultRepo, "INDEX.md"), "# index\n");
    expect(bestEffortNotesRoot(codeRepo)).toBe(vaultRepo);
  });

  it("falls back to the sibling path when no candidate carries INDEX.md", () => {
    expect(bestEffortNotesRoot(codeRepo)).toBe(vaultRepo);
  });

  it("never throws on a bogus explicit root: the canonical matcher degrades, the server must not die", () => {
    process.env.MEETLESS_NOTES_ROOT = path.join(tmpRoot, "gone");
    expect(bestEffortNotesRoot(codeRepo)).toBe(path.join(tmpRoot, "gone"));
  });
});
