import * as fs from "fs";
import * as path from "path";

import { CANONICALIZATION_FAILED, EvaluationTarget } from "./evaluation-input-hash";
import { PathClassification } from "./types";

// R0 notes-location path matcher. Given a configured, repository-relative
// forbidden root, it canonicalizes a concrete target path and decides whether it
// lands under that root. The polarity is a denylist: "compliant" means NOT under
// the forbidden root. Canonicalization follows symlinks only through the existing
// prefix, validates every not-yet-existing tail component lexically, and degrades
// to INDETERMINATE whenever it cannot prove the answer (the evaluator turns
// INDETERMINATE into UNKNOWN, never a verdict).
//
// Scope note: this matcher classifies a path. The Write/Edit-only restriction
// and the Bash-is-unsupported rule live at the adapter/selector layer; a path is
// a path here.

export interface NotesPathScope {
  /** The activated project root. Relative targets resolve from here. */
  canonicalProjectRoot: string;
  /** The forbidden root, relative to the project root (e.g. "notes"). */
  configuredRelativeForbiddenPath: string;
}

export interface ClassifyOptions {
  /**
   * Injectable case-sensitivity probe for deterministic tests. Returns true for
   * a case-insensitive volume, false for case-sensitive, null when it cannot be
   * determined. When omitted, a read-only per-device probe is used.
   */
  caseProbe?: (existingDir: string) => boolean | null;
  /** Per-device cache (device id -> isCaseInsensitive). Defaults to a fresh map. */
  caseCache?: Map<number, boolean>;
}

export const NOTE_VAULT_EVALUATOR_CONTRACT_VERSION =
  "date-prefixed-note-vault-evaluator-v1";
export const NOTE_VAULT_MATCHER_SCHEMA_VERSION =
  "date-prefixed-markdown-action-v1";
export const NOTE_VAULT_PATH_CANONICALIZER_VERSION = "note-vault-path-v1";
export const NOTE_VAULT_FILENAME_PREFIX_PATTERN = "^\\d{8}-" as const;

export type NoteVaultClassification =
  | "DATE_PREFIXED_UNDER_ALLOWED_ROOT"
  | "DATE_PREFIXED_OUTSIDE_ALLOWED_ROOT"
  | "NOT_DATE_PREFIXED_NOTE"
  | "INDETERMINATE";

const moduleCaseCache = new Map<number, boolean>();

/** A tail component must be a single, safe, lexical name (no FS lookup). */
function isValidTailComponent(component: string): boolean {
  return (
    component.length > 0 &&
    component !== "." &&
    component !== ".." &&
    !component.includes("/") &&
    !component.includes(path.sep) &&
    !component.includes("\0")
  );
}

interface Canonical {
  canonical: string;
  /** Deepest existing directory on the path, used for the per-device case probe. */
  existingDir: string;
}

/**
 * Canonicalize an absolute path. Walks up to the nearest existing ancestor,
 * realpaths it (following symlinks), validates each not-yet-existing tail
 * component lexically, and re-appends the tail. Returns null when the path
 * cannot be canonicalized (permission errors, ambiguous `..` past a missing
 * directory, etc.).
 */
async function canonicalize(absPath: string): Promise<Canonical | null> {
  const tail: string[] = [];
  let cur = absPath;

  for (;;) {
    let resolved: string;
    try {
      resolved = await fs.promises.realpath(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // EACCES, ELOOP, ENOTDIR, invalid argument (NUL), etc.: cannot prove.
        return null;
      }
      const base = path.basename(cur);
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached the filesystem root without finding an existing ancestor.
        return null;
      }
      if (!isValidTailComponent(base)) {
        return null;
      }
      tail.push(base);
      cur = parent;
      continue;
    }

    const canonical = tail.length > 0 ? path.join(resolved, ...tail.reverse()) : resolved;
    let existingDir: string;
    try {
      const st = await fs.promises.stat(resolved);
      existingDir = st.isDirectory() ? resolved : path.dirname(resolved);
    } catch {
      return null;
    }
    return { canonical, existingDir };
  }
}

/**
 * Classify the v2 notes-location rule without leaking an absolute target path.
 * The fixed discriminator deliberately governs only YYYYMMDD-* working notes;
 * README.md and ordinary docs are compliant wherever they live.
 */
export async function classifyDatePrefixedNoteVaultTarget(
  rawFilePath: unknown,
  runtimeProjectRoot: string,
  allowedRootAbsolutePath: string,
  filenamePrefixPattern: string,
  opts: ClassifyOptions = {},
): Promise<NoteVaultClassification> {
  if (
    typeof rawFilePath !== "string" ||
    rawFilePath.length === 0 ||
    rawFilePath.includes("\0") ||
    !path.isAbsolute(allowedRootAbsolutePath) ||
    filenamePrefixPattern !== NOTE_VAULT_FILENAME_PREFIX_PATTERN
  ) {
    return "INDETERMINATE";
  }
  if (!/^\d{8}-/.test(path.basename(rawFilePath))) {
    return "NOT_DATE_PREFIXED_NOTE";
  }

  const absTarget = path.isAbsolute(rawFilePath)
    ? rawFilePath
    : path.join(runtimeProjectRoot, rawFilePath);
  const [target, allowedRoot] = await Promise.all([
    canonicalize(absTarget),
    canonicalize(allowedRootAbsolutePath),
  ]);
  if (!target || !allowedRoot) return "INDETERMINATE";

  const caseInsensitive = resolveCasePolicy(allowedRoot.existingDir, opts);
  if (caseInsensitive === null) return "INDETERMINATE";
  return isUnderRoot(target.canonical, allowedRoot.canonical, caseInsensitive)
    ? "DATE_PREFIXED_UNDER_ALLOWED_ROOT"
    : "DATE_PREFIXED_OUTSIDE_ALLOWED_ROOT";
}

/**
 * Read-only per-device case-sensitivity probe: flip the case of the deepest
 * existing directory's name and stat the sibling. Same inode -> case-insensitive;
 * ENOENT -> case-sensitive; anything else (or no alphabetic character to flip)
 * -> undeterminable.
 */
function defaultCaseProbe(existingDir: string): boolean | null {
  let real: string;
  try {
    real = fs.realpathSync(existingDir);
  } catch {
    return null;
  }
  const base = path.basename(real);
  const parent = path.dirname(real);
  const flipped = flipCase(base);
  if (flipped === base) {
    // No alphabetic character to flip; cannot probe non-destructively.
    return null;
  }
  let origStat: fs.Stats;
  try {
    origStat = fs.statSync(real);
  } catch {
    return null;
  }
  try {
    const flipStat = fs.statSync(path.join(parent, flipped));
    return flipStat.ino === origStat.ino && flipStat.dev === origStat.dev;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    return null;
  }
}

function flipCase(name: string): string {
  let out = "";
  for (const ch of name) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower !== upper) {
      out += ch === lower ? upper : lower;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Pure prefix comparison under a case policy. A path is "under" the root when it
 * equals the root or is a descendant (boundary-correct: "/a/notes-archive" is
 * NOT under "/a/notes").
 */
export function isUnderRoot(target: string, root: string, caseInsensitive: boolean): boolean {
  const t = caseInsensitive ? target.toLowerCase() : target;
  const r = caseInsensitive ? root.toLowerCase() : root;
  if (t === r) {
    return true;
  }
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export async function classifyTargetPath(
  rawFilePath: unknown,
  scope: NotesPathScope,
  opts: ClassifyOptions = {},
): Promise<PathClassification> {
  if (typeof rawFilePath !== "string" || rawFilePath.length === 0) {
    return "INDETERMINATE";
  }
  if (rawFilePath.includes("\0")) {
    return "INDETERMINATE";
  }

  const absTarget = path.isAbsolute(rawFilePath)
    ? rawFilePath
    : scope.canonicalProjectRoot + path.sep + rawFilePath;

  const forbiddenRaw = path.isAbsolute(scope.configuredRelativeForbiddenPath)
    ? scope.configuredRelativeForbiddenPath
    : path.join(scope.canonicalProjectRoot, scope.configuredRelativeForbiddenPath);

  const target = await canonicalize(absTarget);
  if (!target) {
    return "INDETERMINATE";
  }
  const forbidden = await canonicalize(forbiddenRaw);
  if (!forbidden) {
    return "INDETERMINATE";
  }

  const caseInsensitive = resolveCasePolicy(forbidden.existingDir, opts);
  if (caseInsensitive === null) {
    return "INDETERMINATE";
  }

  return isUnderRoot(target.canonical, forbidden.canonical, caseInsensitive)
    ? "UNDER_FORBIDDEN_ROOT"
    : "OUTSIDE_FORBIDDEN_ROOT";
}

/**
 * Classify a target path into the evaluation-input-v1 `target` union (the
 * pathCanonicalizerVersion="notes-path-v1" canonicalizer feeding the persisted
 * snapshot). This is the runtime-SCOPE axis, distinct from the forbidden-root denylist
 * of classifyTargetPath: it answers "where does this action write, relative to the
 * runtime project root?", never leaking an absolute home path.
 *
 *   RUNTIME_RELATIVE { path }  the target canonicalizes under the runtime root; `path`
 *                              is the posix, machine-independent relative path.
 *   OUTSIDE_RUNTIME_SCOPE      the target canonicalizes outside the runtime root; no
 *                              path is carried (privacy).
 *   UNKNOWN / CANONICALIZATION_FAILED  canonicalization or the case policy cannot prove
 *                              the answer (mirrors classifyTargetPath's INDETERMINATE).
 *
 * The stored target plus forbiddenRootRelativePath are sufficient for a later replay to
 * recompute the verdict from the snapshot alone, with no second filesystem probe.
 */
export async function classifyRuntimeTarget(
  rawFilePath: unknown,
  runtimeProjectRoot: string,
  opts: ClassifyOptions = {},
): Promise<EvaluationTarget> {
  const unknown: EvaluationTarget = { kind: "UNKNOWN", reasonCode: CANONICALIZATION_FAILED };

  if (typeof rawFilePath !== "string" || rawFilePath.length === 0) {
    return unknown;
  }
  if (rawFilePath.includes("\0")) {
    return unknown;
  }

  const absTarget = path.isAbsolute(rawFilePath)
    ? rawFilePath
    : runtimeProjectRoot + path.sep + rawFilePath;

  const target = await canonicalize(absTarget);
  if (!target) {
    return unknown;
  }
  const root = await canonicalize(runtimeProjectRoot);
  if (!root) {
    return unknown;
  }

  const caseInsensitive = resolveCasePolicy(root.existingDir, opts);
  if (caseInsensitive === null) {
    return unknown;
  }

  if (!isUnderRoot(target.canonical, root.canonical, caseInsensitive)) {
    return { kind: "OUTSIDE_RUNTIME_SCOPE" };
  }

  const relative = path.relative(root.canonical, target.canonical);
  return { kind: "RUNTIME_RELATIVE", path: relative.split(path.sep).join("/") };
}

function resolveCasePolicy(existingDir: string, opts: ClassifyOptions): boolean | null {
  const probe = opts.caseProbe ?? defaultCaseProbe;
  // The process-wide cache is only consulted/written for the default probe. An
  // injected probe is an explicit per-call override: it must neither be shadowed
  // by a cached value nor poison the cache for other callers. A caller that wants
  // a custom probe to be cached can pass its own caseCache.
  const cache = opts.caseCache ?? (opts.caseProbe ? undefined : moduleCaseCache);

  let dev: number | undefined;
  try {
    dev = fs.statSync(existingDir).dev;
  } catch {
    dev = undefined;
  }
  if (cache && dev !== undefined && cache.has(dev)) {
    return cache.get(dev) as boolean;
  }
  const result = probe(existingDir);
  if (cache && result !== null && dev !== undefined) {
    cache.set(dev, result);
  }
  return result;
}
