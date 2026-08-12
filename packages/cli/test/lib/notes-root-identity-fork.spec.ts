import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveVaultRootForFile, NOTES_IDENTITY_ROOT } from "../../src/lib/notes-root";
import { vaultRelPath } from "../../src/commands/kb_add";

// S4 (2026-08-05): `NT:notes/notes/20260628-rev9-augmentation-audit.md`.
//
// The 08-05 audit filed the doubled segment as a citation-rendering bug. It is not.
// The dev corpus holds BOTH of these as separate governed documents:
//
//   notes/20260628-rev9-augmentation-audit.md          created 2026-06-28
//   notes/notes/20260628-rev9-augmentation-audit.md    created 2026-06-28
//
// One file, two governed identities. That is exactly the fracture
// `notes_external_object_id` promises never to allow, and the citation faithfully
// reported a corrupted `externalObjectId` rather than corrupting a good one.
//
// The cause is that the vault root is DISCOVERED, not configured. `mla kb add` anchors
// on the file and walks up to the first `.git`, so the identity of a note is a function
// of where `.git` happens to sit ON THE DAY IT WAS INGESTED:
//
//   vault is its own git repo    -> root = <vault>          -> notes/<file>
//   vault is a plain subdirectory-> root = <parent repo>    -> notes/notes/<file>
//
// The operator's vault became its own repo at some point between June and August, and
// every note ingested before that flip carries the doubled identity. Nothing is wrong
// with either string; what is wrong is that the same file can mint two.
//
// The fix is An's clause 1, "the configured source root": prefer the candidate that
// DECLARES ITSELF a vault (holds the INDEX.md marker) over the one that merely
// contains it. `bestEffortNotesRoot` has always applied that rule; the write path that
// mints identities did not, which is the asymmetry. A marker is a property of the
// vault, so it survives a `git init` that the walk-up does not.

let tmpRoot: string;
const savedEnv = process.env.MEETLESS_NOTES_ROOT;

beforeEach(() => {
  delete process.env.MEETLESS_NOTES_ROOT;
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notes-fork-")));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MEETLESS_NOTES_ROOT;
  else process.env.MEETLESS_NOTES_ROOT = savedEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function mkGit(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

// The governed externalObjectId exactly as the server computes it: prefix the single
// identity root onto the vault-relative path, once (intel `kb_add._external_object_id`).
function eoidFor(vaultRoot: string, file: string): string {
  return `${NOTES_IDENTITY_ROOT}/${vaultRelPath(vaultRoot, file)}`;
}

describe("a note's governed identity must not depend on where .git happens to sit", () => {
  it("mints ONE identity whether or not the vault is its own git repo", () => {
    // Layout: <tmp>/repo/.git and <tmp>/repo/notes/INDEX.md, vault NOT its own repo.
    const repo = path.join(tmpRoot, "repo");
    const vault = path.join(repo, "notes");
    fs.mkdirSync(vault, { recursive: true });
    mkGit(repo);
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(vault, "20260628-rev9-augmentation-audit.md");
    fs.writeFileSync(note, "# audit\n");

    const nested = eoidFor(resolveVaultRootForFile(path.dirname(note)), note);

    // Now the operator runs `git init` inside the vault, which is what happened
    // between June and August. The identity must NOT move.
    mkGit(vault);
    const standalone = eoidFor(resolveVaultRootForFile(path.dirname(note)), note);

    expect(nested).toBe(standalone);
    expect(nested).toBe("notes/20260628-rev9-augmentation-audit.md");
    expect(nested).not.toBe("notes/notes/20260628-rev9-augmentation-audit.md");
  });

  it("still prefixes the root exactly once for a standalone vault repo", () => {
    const vault = path.join(tmpRoot, "notes");
    fs.mkdirSync(vault, { recursive: true });
    mkGit(vault);
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(vault, "20260805-plan.md");
    fs.writeFileSync(note, "# plan\n");

    expect(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)).toBe("notes/20260805-plan.md");
  });

  it("keeps a genuinely nested subdirectory in the relative path", () => {
    // The precision guard for An's clause "avoid corrupting legitimate nested folders
    // that happen to share names". A `notes/` directory INSIDE the vault is a real
    // path segment and must survive; only the ROOT is applied once.
    const vault = path.join(tmpRoot, "vault");
    const inner = path.join(vault, "notes", "archive");
    fs.mkdirSync(inner, { recursive: true });
    mkGit(vault);
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(inner, "old.md");
    fs.writeFileSync(note, "# old\n");

    expect(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)).toBe("notes/notes/archive/old.md");
  });

  it("an explicit MEETLESS_NOTES_ROOT still wins over any marker", () => {
    const repo = path.join(tmpRoot, "repo");
    const vault = path.join(repo, "notes");
    fs.mkdirSync(vault, { recursive: true });
    mkGit(repo);
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(vault, "x.md");
    fs.writeFileSync(note, "# x\n");

    process.env.MEETLESS_NOTES_ROOT = repo;
    expect(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)).toBe("notes/notes/x.md");
  });

  it("falls back to the git walk-up when no candidate declares itself a vault", () => {
    // Unchanged behaviour for a vault with no INDEX.md: this is what keeps every
    // already-correct identity in the corpus exactly as it is.
    const vault = path.join(tmpRoot, "unmarked");
    fs.mkdirSync(vault, { recursive: true });
    mkGit(vault);
    const note = path.join(vault, "y.md");
    fs.writeFileSync(note, "# y\n");

    expect(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)).toBe("notes/y.md");
  });

  it("is idempotent: resolving twice yields the same identity", () => {
    const vault = path.join(tmpRoot, "notes");
    fs.mkdirSync(vault, { recursive: true });
    mkGit(vault);
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(vault, "z.md");
    fs.writeFileSync(note, "# z\n");

    const once = eoidFor(resolveVaultRootForFile(path.dirname(note)), note);
    const twice = eoidFor(resolveVaultRootForFile(path.dirname(note)), note);
    expect(once).toBe(twice);
  });
});

// THE S4 INVARIANT, in the form the owner ruled on 2026-08-08:
//
//   The same logical vault artifact has the same canonical document identity
//   regardless of invocation working directory or repository discovery root.
//
// The doubled `notes/notes/...` path was the SYMPTOM. The defect was that identity was
// computed from repository DISCOVERY, which is a property of the machine and the moment,
// not of the artifact. The rows above vary the repository layout; this one varies the
// two other inputs discovery depends on, because those are how it will regress next.
describe("identity is a property of the artifact, not of how the CLI was invoked", () => {
  it("does not move when the process cwd moves", () => {
    const repo = path.join(tmpRoot, "repo");
    const vault = path.join(repo, "notes");
    const elsewhere = path.join(tmpRoot, "somewhere", "deep");
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    mkGit(repo);
    mkGit(elsewhere);
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(vault, "20260808-invariant.md");
    fs.writeFileSync(note, "# invariant\n");

    const saved = process.cwd();
    try {
      const ids = new Set<string>();
      for (const cwd of [repo, vault, elsewhere, tmpRoot]) {
        process.chdir(cwd);
        ids.add(eoidFor(resolveVaultRootForFile(path.dirname(note)), note));
      }
      expect([...ids]).toEqual(["notes/20260808-invariant.md"]);
    } finally {
      process.chdir(saved);
    }
  });

  it("does not move when a NEW git repo appears above or below the vault", () => {
    // The 2026-06 to 2026-08 drift, replayed as a property: the vault gains its own
    // repo, then an ancestor gains one too. Neither is a fact about the note.
    const outer = path.join(tmpRoot, "outer");
    const repo = path.join(outer, "repo");
    const vault = path.join(repo, "notes");
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(vault, "20260808-drift.md");
    fs.writeFileSync(note, "# drift\n");

    const ids = new Set<string>();
    ids.add(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)); // no repo at all
    mkGit(repo);
    ids.add(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)); // repo above
    mkGit(vault);
    ids.add(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)); // repo at the vault
    mkGit(outer);
    ids.add(eoidFor(resolveVaultRootForFile(path.dirname(note)), note)); // repo above that

    expect([...ids]).toEqual(["notes/20260808-drift.md"]);
  });

  it("is stable across repeated ingest, which is what makes re-adding idempotent", () => {
    const vault = path.join(tmpRoot, "stable");
    fs.mkdirSync(vault, { recursive: true });
    mkGit(vault);
    fs.writeFileSync(path.join(vault, "INDEX.md"), "# vault\n");
    const note = path.join(vault, "20260808-repeat.md");
    fs.writeFileSync(note, "# one\n");

    const first = eoidFor(resolveVaultRootForFile(path.dirname(note)), note);
    fs.writeFileSync(note, "# the content changed, the identity did not\n");
    const second = eoidFor(resolveVaultRootForFile(path.dirname(note)), note);

    expect(first).toBe(second);
  });
});
