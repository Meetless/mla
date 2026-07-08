import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readKbConfig, KbCliConfig } from "../lib/config";
import { intelPost, HttpError } from "../lib/http";
import { verifyKbActorIsOwner, KbOwnerCheckError } from "../lib/kb_acl";
import { canonicalizeSessionId } from "../lib/observability";
import { KbReingestReceipt, renderKbReingestReceipt } from "../lib/render";
import { gitRootForVault, vaultRelPath } from "./kb_add";

// `mla kb reingest <kbdoc:<id>|note:<externalObjectId>|<path>> [flags]`.
//
// Remote-capable: this command drives the intel route
// `POST /internal/v1/kb/reingest`, which owns the governed §5.1 UPSERT front
// door (intake_delivery -> execute_run_set -> activation CAS head swap), the
// same spine `mla kb add` uses. The CLI no longer spawns a local python
// subprocess (tools/mla_kb_reingest.py) or needs an intel checkout on the
// operator's machine, so reingest works from any laptop against any backend
// the same way every other `mla` command does (INV-OSS-1).
//
// A reingest re-delivers an EXISTING governed document's CURRENT on-disk
// content. The one thing the server cannot do remotely is read that content,
// so the CLIENT (the only side that holds the filesystem) locates the source
// file and ships its bytes. How it locates the file depends on the input:
//
//   - bare path / `note:<path>` that is a REAL local file: the client holds it
//     directly. It reads the bytes and POSTs APPLY mode with the vault-relative
//     POSIX path (`relPath`); the server prefixes the single `notes/` root and
//     canonicalizes, reproducing exactly the externalObjectId `kb add` minted
//     (dedup parity).
//   - `kbdoc:<id>` / a stored `note:<externalObjectId>` (NOT a local file): the
//     client cannot map an opaque id (or the casefolded identity string) to a
//     file on its own. It POSTs RESOLVE mode first (mints nothing, runs the
//     PURGED/TOMBSTONED guards), learns the document's stored externalObjectId,
//     reverse-maps it to a file under the vault root, reads the bytes, then POSTs
//     APPLY mode by exact `documentId`.
//
// The server carries the DOCUMENT's owner (not the operator) into the UPSERT, so
// intake resolves THIS document; content-identical re-delivery dedups
// (noop_unchanged), changed content mints + activates a new revision (ingested).
// Provenance is server-derived per revision and is never relabelled here.
//
// `--path` (the old combined move-then-reingest) stays GONE: move is a blocked
// capability in slice A, so parseKbReingestArgs rejects it as an unknown flag.
//
// Exit codes mirror the worker: 0 on success (ingested / noop_unchanged), 2 on a
// precondition (unknown doc 404, terminal state 409, bad args 422, unresolved
// vault root, missing source file), 1 on an operational failure (a failed intake
// receipt, a network error, or a 5xx).

interface KbReingestFlags {
  input: string;
  workspace?: string;
  profile?: string;
  ingestRunId?: string;
  reason?: string;
  agentSession?: string;
}

const VALUE_FLAGS = new Set([
  "--workspace",
  "--profile",
  "--ingest-run-id",
  "--reason",
  "--agent-session",
]);

const DEFAULT_PROFILE = "markdown_atomic_v1";
const NOTES_IDENTITY_ROOT = "notes";
const KBDOC_PREFIX = "kbdoc:";
const NOTE_PREFIX = "note:";

// RESOLVE mints nothing (a DB lookup + guards), so it is fast. APPLY runs the
// heavy inline LDM body + embeds for a body change, so it gets the kb-add
// single-file floor.
const RESOLVE_TIMEOUT_MS = 15_000;
const REINGEST_TIMEOUT_MS = 120_000;

export function parseKbReingestArgs(argv: string[]): KbReingestFlags {
  const out: Partial<KbReingestFlags> = {};
  let positional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`Missing value for ${a}`);
      }
      if (v.startsWith("--") || v.startsWith("-")) {
        throw new Error(
          `Missing value for ${a} (got the next flag ${v} instead)`,
        );
      }
      switch (a) {
        case "--workspace":
          out.workspace = v;
          break;
        case "--profile":
          out.profile = v;
          break;
        case "--ingest-run-id":
          out.ingestRunId = v;
          break;
        case "--reason":
          out.reason = v;
          break;
        case "--agent-session":
          out.agentSession = v;
          break;
      }
      i += 1;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. Supported flags: ${[...VALUE_FLAGS].sort().join(", ")}`,
      );
    }
    if (positional !== null) {
      throw new Error(
        `\`mla kb reingest\` takes exactly one positional input (got '${positional}' and '${a}')`,
      );
    }
    positional = a;
  }

  if (positional === null) {
    throw new Error(
      "`mla kb reingest` requires a positional input: kbdoc:<id>, note:<externalObjectId>, or a bare note path",
    );
  }
  return {
    input: positional,
    workspace: out.workspace,
    profile: out.profile,
    ingestRunId: out.ingestRunId,
    reason: out.reason,
    agentSession: out.agentSession,
  };
}

// ---------------------------------------------------------------------------
// Client-side source resolution (was tools/mla_kb_reingest.py)
//
// The governed identity is the vault-relative POSIX path under a single
// `notes/` root. The CLIENT alone holds the filesystem, so it resolves the
// vault root and reverse-maps the stored externalObjectId to a file here,
// exactly mirroring the python worker's `_resolve_vault_root` /
// `_abs_path_from_external_object_id`.
// ---------------------------------------------------------------------------

// A client-side precondition (unresolved vault root, missing source file, a
// malformed identity). Maps to exit code 2, distinct from an HTTP failure.
export class ReingestPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReingestPreconditionError";
  }
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Resolve the notes vault root the governed identity is relative to. Order
// (mirrors the worker, minus the removed `--vault-root` flag): MEETLESS_NOTES_ROOT,
// else a git-repo-root walk-up from `anchor` (the source file's directory for a
// path input, else cwd). Throws a precondition when neither resolves: reingest
// cannot read the source otherwise.
export function resolveReingestVaultRoot(anchor: string): string {
  const envRoot = process.env.MEETLESS_NOTES_ROOT;
  if (envRoot) {
    const expanded = path.resolve(expandHome(envRoot));
    if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
      throw new ReingestPreconditionError(
        `MEETLESS_NOTES_ROOT=${envRoot} is not a directory`,
      );
    }
    return fs.realpathSync(expanded);
  }
  const gitRoot = gitRootForVault(anchor);
  if (gitRoot) return gitRoot;
  throw new ReingestPreconditionError(
    "could not resolve a notes vault root to read the source file; set MEETLESS_NOTES_ROOT or run inside a git repo",
  );
}

// Reverse the governed identity mapping: `notes/<rel>` -> <vaultRoot>/<rel>.
// Mirrors the worker's `_abs_path_from_external_object_id`. The stored id is
// NFC + (case-insensitive fs) casefolded; lookup on such a fs is case-
// insensitive, so the reverse-mapped path still reads the real file. Guards a
// non-notes-rooted id and a `..` escape, and that the target is a real file.
export function reverseMapEoidToFile(
  externalObjectId: string,
  vaultRoot: string,
): string {
  const prefix = `${NOTES_IDENTITY_ROOT}/`;
  if (!externalObjectId.startsWith(prefix)) {
    throw new ReingestPreconditionError(
      `externalObjectId ${JSON.stringify(externalObjectId)} is not under the '${NOTES_IDENTITY_ROOT}/' identity root; reingest only supports notes-sourced documents`,
    );
  }
  const rel = externalObjectId.slice(prefix.length);
  if (!rel) {
    throw new ReingestPreconditionError(
      `externalObjectId ${JSON.stringify(externalObjectId)} has an empty relative path`,
    );
  }
  const root = fs.realpathSync(vaultRoot);
  const abs = path.resolve(root, rel);
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new ReingestPreconditionError(
      `resolved source path ${abs} escapes vault root ${root}`,
    );
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new ReingestPreconditionError(
      `source file for ${JSON.stringify(externalObjectId)} does not resolve to a readable file at ${abs}. Set MEETLESS_NOTES_ROOT, or re-add it with \`mla kb add\`.`,
    );
  }
  return abs;
}

// The APPLY-mode document handle + bytes the route needs: exactly one of
// documentId (after a RESOLVE) or relPath (a real local file), plus content.
interface ApplyTarget {
  documentId?: string;
  relPath?: string;
  content: string;
}

interface KbReingestResolveResponse {
  documentId: string;
  externalObjectId: string;
  ownerUserId: string;
  tombstoneState: string;
  currentRevisionId?: string | null;
}

// RESOLVE an identity reference (kbdoc:<id> or a stored note:<eoid>) server-side
// -- the SAME canonicalize + guards the worker ran -- then reverse-map the
// returned externalObjectId to a file and read its bytes for an APPLY-by-id.
async function resolveViaServer(
  cfg: KbCliConfig,
  workspaceId: string,
  ref: string,
  anchor: string,
): Promise<ApplyTarget> {
  const resolved = await intelPost<KbReingestResolveResponse>(
    cfg,
    "/internal/v1/kb/reingest",
    { workspaceId, actor: cfg.actorUserId, ref },
    RESOLVE_TIMEOUT_MS,
  );
  // RESOLVE already ran the PURGED/TOMBSTONED guards (409) and unknown-doc (404),
  // so a terminal/missing doc threw before we touch the filesystem.
  const vaultRoot = resolveReingestVaultRoot(anchor);
  const file = reverseMapEoidToFile(resolved.externalObjectId, vaultRoot);
  const content = fs.readFileSync(file, "utf8");
  return { documentId: resolved.documentId, content };
}

// Map the operator's input to an APPLY target. A real local file is read
// directly (APPLY by relPath); an opaque/identity reference round-trips through
// RESOLVE (APPLY by documentId). This mirrors the worker's two resolution
// candidates (filesystem form vs identity form), split across the wire.
async function resolveApplyTarget(
  cfg: KbCliConfig,
  flags: KbReingestFlags,
  workspaceId: string,
): Promise<ApplyTarget> {
  const raw = flags.input.trim();
  if (!raw) {
    throw new ReingestPreconditionError(
      "`mla kb reingest` requires a non-empty input",
    );
  }

  // kbdoc:<id>: opaque, never a file. Resolve server-side, anchored on cwd.
  if (raw.startsWith(KBDOC_PREFIX)) {
    const id = raw.slice(KBDOC_PREFIX.length).trim();
    if (!id) {
      throw new ReingestPreconditionError("kbdoc: prefix requires an id");
    }
    return resolveViaServer(cfg, workspaceId, raw, process.cwd());
  }

  // note:<X> or bare <X>. If X is a real local file, the client holds it: read
  // it and APPLY by relPath. Otherwise it is a stored externalObjectId string;
  // resolve it server-side (anchored on cwd) and APPLY by documentId.
  const rawPath = raw.startsWith(NOTE_PREFIX)
    ? raw.slice(NOTE_PREFIX.length)
    : raw;
  const abs = path.resolve(expandHome(rawPath));
  let isFile = false;
  try {
    isFile = fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) {
    const vaultRoot = resolveReingestVaultRoot(path.dirname(abs));
    const relPath = vaultRelPath(vaultRoot, abs);
    const content = fs.readFileSync(abs, "utf8");
    return { relPath, content };
  }
  return resolveViaServer(cfg, workspaceId, raw, process.cwd());
}

function printPreflight(flags: KbReingestFlags, cfg: KbCliConfig): void {
  const ws = flags.workspace || cfg.workspaceId;
  const reasonHint = flags.reason ? ` reason=${JSON.stringify(flags.reason)}` : "";
  console.log(
    `mla kb reingest workspace=${ws} input=${flags.input}${reasonHint}`,
  );
}

// Map an HTTP/network failure to the worker's exit semantics: a 404 (unknown
// doc), 409 (terminal state), or 422 (bad args) is a precondition -> 2; a
// network error (no status) or a 5xx is an operational failure -> 1.
function exitForHttpError(e: unknown): number {
  const status = (e as HttpError)?.status;
  if (status === 404 || status === 409 || status === 422) return 2;
  return 1;
}

export async function runKbReingest(argv: string[]): Promise<number> {
  // Parse flags BEFORE loading config so `--workspace <id>` can override the
  // marker-resolved workspace (T1.1 folder = workspace) without requiring the
  // current directory to be activated.
  let flags: KbReingestFlags;
  try {
    flags = parseKbReingestArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // §13.14 owner-only ACL: reingest mints new revisions and activates them.
  try {
    await verifyKbActorIsOwner(cfg);
  } catch (e) {
    if (e instanceof KbOwnerCheckError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  const workspaceId = flags.workspace || cfg.workspaceId;

  printPreflight(flags, cfg);

  // Resolve the source file + the document handle. A RESOLVE round-trip (for an
  // opaque/identity reference) can fail with an HTTP status; a client-side
  // precondition (vault root, missing file) throws ReingestPreconditionError.
  let target: ApplyTarget;
  try {
    target = await resolveApplyTarget(cfg, flags, workspaceId);
  } catch (e) {
    if (e instanceof ReingestPreconditionError) {
      console.error(e.message);
      return 2;
    }
    console.error(`kb reingest failed: ${(e as Error).message}`);
    return exitForHttpError(e);
  }

  // Relay the session UUID, canonicalized (defense in depth: a direct
  // `mla kb reingest --agent-session X` may carry a non-canonical value). The
  // server canonicalizes again and is the authoritative gate; an invalid value
  // yields no session, never a composed value.
  const agentSession = canonicalizeSessionId(flags.agentSession ?? null);

  const body = {
    workspaceId,
    actor: cfg.actorUserId,
    profile: flags.profile || DEFAULT_PROFILE,
    reason: flags.reason ?? undefined,
    agentSession: agentSession ?? undefined,
    content: target.content,
    ...(target.documentId
      ? { documentId: target.documentId }
      : { relPath: target.relPath }),
  };

  let receipt: KbReingestReceipt;
  try {
    const res = await intelPost<{ receipt: KbReingestReceipt }>(
      cfg,
      "/internal/v1/kb/reingest",
      body,
      REINGEST_TIMEOUT_MS,
    );
    receipt = res.receipt;
  } catch (e) {
    console.error(`kb reingest failed: ${(e as Error).message}`);
    return exitForHttpError(e);
  }

  if (!receipt) {
    console.error("kb reingest: the route returned no receipt.");
    return 1;
  }

  console.log(renderKbReingestReceipt(receipt));
  console.log("");

  // A per-doc intake failure is reported in the receipt, not the HTTP status;
  // mirror the worker's exit (failed -> 1, ingested / noop_unchanged -> 0).
  return receipt.outcome === "failed" ? 1 : 0;
}
