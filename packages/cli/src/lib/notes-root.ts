import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { userHomeDir } from "./config";

// The ONE resolver for "where is the notes vault on this machine?".
//
// Before this module there were four, and they disagreed:
//
//   kb add       env -> git root of the FILE's directory        (correct)
//   kb reingest  env -> git root of the CWD                     (WRONG for an
//                                                                identity ref)
//   mcp          env -> <markerDir>/../notes                     (correct)
//   ask          env -> a __dirname-relative ../../../../notes   (dead once the
//                                                                CLI is installed)
//
// The divergence is not cosmetic. `mla kb add <vault>/foo.md` anchors on the
// file, walks up to the notes repo, and mints the identity `notes/foo.md`.
// `mla kb reingest note:notes/foo.md` run from the code repo (where you actually
// work) anchored on cwd, walked up to the MONOREPO, and reverse-mapped the same
// identity to `<monorepo>/foo.md`, which does not exist. The reingest of a
// document `kb add` had happily accepted failed with "does not resolve to a
// readable file", and the only way through was an undocumented env var. Two
// commands, one identity, two answers: that is the bug.
//
// A vault root is a property of the OPERATOR'S MACHINE, not of the working
// directory, so it cannot be derived from cwd alone. What we can do is enumerate
// the layouts that actually exist and VERIFY the candidate before trusting it
// (see resolveNotesSourceFile): a checked candidate is not a guess.
//
// Deliberately NOT a candidate: `<gitRoot>/notes`. In the sibling layout the
// code repo has its own `notes/` directory, and a file there would collide with
// a same-named file in the real vault, silently reingesting the wrong bytes. It
// is also unnecessary: a vault nested at `<repo>/notes` mints its identity
// against the REPO root (the walk-up from the file lands there), so its rel path
// already carries the `notes/` segment and candidate 2 resolves it.

export function expandHome(p: string): string {
  if (p === "~") return userHomeDir();
  if (p.startsWith("~/")) return path.join(userHomeDir(), p.slice(2));
  return p;
}

// Walk up from `start` looking for a `.git` entry; return the containing dir.
// Mirrors the worker's `_git_root_for` (first/closest match wins).
export function gitRootForVault(start: string): string | null {
  let cur: string;
  try {
    cur = fs.realpathSync(start);
  } catch {
    cur = path.resolve(start);
  }
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export class NotesRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotesRootError";
  }
}

export interface NotesRootCandidate {
  root: string;
  // Human-readable provenance, printed when every candidate misses so the
  // operator sees exactly where we looked instead of one dead absolute path.
  source: string;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// An explicit MEETLESS_NOTES_ROOT is AUTHORITATIVE, never one option among
// several: the operator has said where the vault is. A bad value throws rather
// than falling through, because silently ignoring an override is how you end up
// reading the wrong vault and never knowing.
export function explicitNotesRoot(): string | null {
  const envRoot = process.env.MEETLESS_NOTES_ROOT;
  if (!envRoot) return null;
  const expanded = path.resolve(expandHome(envRoot));
  if (!isDir(expanded)) {
    throw new NotesRootError(`MEETLESS_NOTES_ROOT=${envRoot} is not a directory`);
  }
  return realOrSelf(expanded);
}

// Every plausible vault root for `anchorDir`, most-authoritative first, deduped,
// directories only. An explicit env root short-circuits the list.
export function notesRootCandidates(anchorDir: string): NotesRootCandidate[] {
  const explicit = explicitNotesRoot();
  if (explicit) {
    return [{ root: explicit, source: "MEETLESS_NOTES_ROOT" }];
  }

  const out: NotesRootCandidate[] = [];
  const seen = new Set<string>();
  const push = (root: string | null, source: string): void => {
    if (!root || !isDir(root)) return;
    const real = realOrSelf(root);
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ root: real, source });
  };

  // 2. The repo you are standing in IS the vault (the standalone-vault operator
  //    running from inside it), or the vault is nested under it.
  const gitRoot = gitRootForVault(anchorDir);
  push(gitRoot, `git root of ${anchorDir}`);

  // 3. The vault is a standalone repo BESIDE the code repo (the dogfood layout:
  //    projects/<x>/meetless + projects/<x>/notes). This is the rule `mla mcp`
  //    already uses; reingest and ask now use the same one.
  const base = gitRoot ?? anchorDir;
  push(path.resolve(base, "..", "notes"), "sibling notes vault");

  return out;
}

// The file that marks a directory as the vault ROOT rather than merely a
// directory that exists. Every candidate is a real directory by construction, so
// without this the first candidate always wins and "best effort" degenerates
// into "the repo you happen to be standing in".
const VAULT_MARKER = "INDEX.md";

// Best-effort single root, for the callers where a miss DEGRADES rather than
// fails (the mcp INDEX.md canonical matcher, `mla ask`). Unlike the write paths
// this never throws: a bogus explicit root is handed back as-is and the caller
// falls back to plain retrieval, because crashing a long-lived mcp server over a
// stale env var would be a far worse failure than a missing canonical match.
//
// Picks the first candidate that actually LOOKS like a vault (holds INDEX.md).
// When none does, returns the standalone-sibling path whether or not it exists,
// which is the dogfood layout and the answer this used to hard-code.
export function bestEffortNotesRoot(anchorDir: string = process.cwd()): string {
  const envRoot = process.env.MEETLESS_NOTES_ROOT;
  if (envRoot) return path.resolve(expandHome(envRoot));

  const candidates = notesRootCandidates(anchorDir);
  const hit = candidates.find((c) => holdsVaultMarker(c.root));
  if (hit) return hit.root;

  const gitRoot = gitRootForVault(anchorDir);
  return path.resolve(gitRoot ?? anchorDir, "..", "notes");
}

// The vault root for a file the caller ALREADY HOLDS. Anchoring on the file's
// own directory is what makes this correct, and it is what `mla kb add` does;
// keep it that way. Throws when nothing resolves: the caller cannot mint a
// governed identity without a root.
//
// S4 (2026-08-05): prefer a candidate that DECLARES ITSELF a vault. This is the write
// path that MINTS identities, and until now it took candidates[0] unconditionally --
// the first `.git` above the file -- while `bestEffortNotesRoot` beside it has always
// checked the marker first. That asymmetry forked the corpus. Both of these are in the
// dev KB right now, one file, two governed documents:
//
//   notes/20260628-rev9-augmentation-audit.md
//   notes/notes/20260628-rev9-augmentation-audit.md
//
// Neither string is malformed. The defect is that a note's identity was a function of
// where `.git` happened to sit ON THE DAY IT WAS INGESTED: with the vault as a plain
// subdirectory the walk-up lands on the parent repo and the rel path carries a `notes/`
// segment that the server then prefixes again; once someone runs `git init` inside the
// vault, the same file mints a different id. A marker is a property of the VAULT, so it
// survives that flip and the identity stops moving underneath the corpus.
//
// Deliberately NOT a `notes/notes` string fix. A `notes/` directory INSIDE a vault is a
// real path segment and still appears in the identity; what is applied exactly once is
// the ROOT (see the server's `_external_object_id`). The marker decides where the root
// is, and nothing inspects the resulting string for repeated segments.
//
// Falls back to candidates[0] when nothing declares itself, which is byte-for-byte the
// old behaviour and is what keeps every already-correct identity in the corpus unchanged.
export function resolveVaultRootForFile(fileDir: string): string {
  // An explicit root is AUTHORITATIVE and short-circuits everything, exactly as it
  // does for every other caller: the operator has said where the vault is.
  const explicit = explicitNotesRoot();
  if (explicit) return explicit;

  // The nearest ancestor that DECLARES itself a vault wins. This is a walk, not a new
  // entry in `notesRootCandidates`, and the difference matters: that list is also used
  // by `resolveNotesSourceFile`, which starts from an IDENTITY and must guess where the
  // file lives, which is why it deliberately refuses to consider `<gitRoot>/notes` (two
  // vaults could hold the same relative path and it would silently open the wrong one).
  // Here we already HOLD the file. There is nothing to guess: we only need to know
  // which of its own ancestors is the vault, and the marker answers that directly.
  const declared = nearestMarkedVaultAbove(fileDir);
  if (declared) return declared;

  const candidates = notesRootCandidates(fileDir);
  if (candidates.length === 0) {
    throw new NotesRootError(
      "could not resolve a notes vault root for the governed identity; set MEETLESS_NOTES_ROOT or run inside a git repo",
    );
  }
  return candidates[0].root;
}

// Walk up from `start` for the first directory holding the vault marker. Returns null
// when none does, which is the unmarked-vault case and keeps the old walk-up behaviour.
function nearestMarkedVaultAbove(start: string): string | null {
  let cur = realOrSelf(start);
  for (;;) {
    if (holdsVaultMarker(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Does this directory declare itself the vault root, rather than merely existing?
// Shared by the read path (`bestEffortNotesRoot`) and the write path
// (`resolveVaultRootForFile`) so the root a citation resolves through is the same one
// that minted it. Two copies of this predicate is how they drifted apart.
function holdsVaultMarker(root: string): boolean {
  try {
    return fs.statSync(path.join(root, VAULT_MARKER)).isFile();
  } catch {
    return false;
  }
}

export const NOTES_IDENTITY_ROOT = "notes";

// Match ONE path segment under `dir` against its CASEFOLDED form, by listing the
// directory and folding each entry back. `null` when nothing folds to it.
//
// Two entries that fold to the same name (README.md and readme.md side by side,
// which only a case-sensitive fs can even hold) make the identity genuinely
// ambiguous: both files mint the same externalObjectId. Refuse rather than pick,
// and name both, because silently reingesting the wrong one is the failure this
// whole path exists to prevent.
//
// Caveat: JS toLowerCase() is not Python str.casefold(). They disagree on a
// handful of characters (German ß folds to "ss" under casefold, stays ß under
// toLowerCase). Such a name simply will not match here and the caller reports an
// honest "not found" instead of opening the wrong file.
function matchFoldedSegment(dir: string, folded: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hits = entries.filter(
    (e) => e.normalize("NFC").toLowerCase() === folded,
  );
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    throw new NotesRootError(
      `the governed identity segment ${JSON.stringify(folded)} is ambiguous under ${dir}: ${hits
        .sort()
        .map((h) => JSON.stringify(h))
        .join(" and ")} both fold to it, so both mint the same externalObjectId. Rename one.`,
    );
  }
  return hits[0];
}

// Walk a casefolded relative path segment by segment against the real on-disk
// names. This is the fallback for a case-SENSITIVE filesystem, where the stored
// identity (folded) is not a path that exists.
function resolveFoldedPath(root: string, rel: string): string | null {
  let cur = root;
  for (const segment of rel.split("/")) {
    const real = matchFoldedSegment(cur, segment);
    if (!real) return null;
    cur = path.join(cur, real);
  }
  try {
    return fs.statSync(cur).isFile() ? cur : null;
  } catch {
    return null;
  }
}

// Reverse the governed identity mapping (`notes/<rel>` -> <vaultRoot>/<rel>)
// against ONE candidate root. Returns null when the candidate does not hold the
// file; throws only on a malformed identity or a `..` escape, which are
// properties of the identity itself and true for every candidate.
export function reverseMapEoidUnder(
  externalObjectId: string,
  vaultRoot: string,
): string | null {
  const prefix = `${NOTES_IDENTITY_ROOT}/`;
  if (!externalObjectId.startsWith(prefix)) {
    throw new NotesRootError(
      `externalObjectId ${JSON.stringify(externalObjectId)} is not under the '${NOTES_IDENTITY_ROOT}/' identity root; reingest only supports notes-sourced documents`,
    );
  }
  const rel = externalObjectId.slice(prefix.length);
  if (!rel) {
    throw new NotesRootError(
      `externalObjectId ${JSON.stringify(externalObjectId)} has an empty relative path`,
    );
  }
  const root = realOrSelf(vaultRoot);
  const abs = path.resolve(root, rel);
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new NotesRootError(
      `resolved source path ${abs} escapes vault root ${root}`,
    );
  }
  // Deliberately NOT `statSync(abs)`. The stored identity is casefolded (see
  // intel's canonicalize_note_path), so it is not a path: nothing on disk is
  // named notes/hermes-agent/readme.md when the file is README.md. That stat
  // happens to succeed on macOS, which folds case in the kernel, and returns
  // null on Linux, which does not. `mla kb reingest` of any note with an
  // uppercase letter in its name (INDEX.md, README.md) therefore worked on this
  // laptop and failed on every Linux box, and the ONE path that resolved returned
  // a different string than the other.
  //
  // Fold the directory LISTING instead. That is a property of the identity rather
  // than of the host, so both hosts resolve the same file and name it the same
  // way: the real on-disk name.
  return resolveFoldedPath(root, rel);
}

export interface ResolvedNotesSource {
  file: string;
  vaultRoot: string;
  source: string;
}

// Locate the on-disk file behind a governed identity, without a file to anchor
// on. Walks the candidate roots and takes the first that ACTUALLY HOLDS the
// file: the layout is checked, never assumed, so a machine with two vaults can
// only ever resolve to the one that has the document.
//
// The stored id is NFC + casefolded, unconditionally and on every host (see
// intel's canonicalize_note_path). It is therefore NOT a path: on a
// case-sensitive fs nothing is named `notes/hermes-agent/readme.md` when the
// file is README.md. reverseMapEoidUnder folds the directory listing to close
// that gap, so this resolves the same file on macOS and on Linux.
export function resolveNotesSourceFile(
  externalObjectId: string,
  anchorDir: string,
): ResolvedNotesSource {
  const candidates = notesRootCandidates(anchorDir);
  if (candidates.length === 0) {
    throw new NotesRootError(
      `could not resolve a notes vault root to read the source for ${JSON.stringify(externalObjectId)}; set MEETLESS_NOTES_ROOT or run inside a git repo`,
    );
  }

  const tried: string[] = [];
  for (const c of candidates) {
    const hit = reverseMapEoidUnder(externalObjectId, c.root);
    if (hit) return { file: hit, vaultRoot: c.root, source: c.source };
    tried.push(`  ${path.join(c.root, externalObjectId.slice(`${NOTES_IDENTITY_ROOT}/`.length))}  (${c.source})`);
  }

  throw new NotesRootError(
    `source file for ${JSON.stringify(externalObjectId)} was not found in any notes vault root. Looked in:\n${tried.join("\n")}\nSet MEETLESS_NOTES_ROOT to the vault that holds it, or re-add it with \`mla kb add\`.`,
  );
}
