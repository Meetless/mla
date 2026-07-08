import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readKbConfig, KbCliConfig } from "../lib/config";
import { verifyKbActorIsOwner, KbOwnerCheckError } from "../lib/kb_acl";
import { KbForgetReceipt, renderKbForgetReceipt } from "../lib/render";
import { get, post, intelPost, HttpError } from "../lib/http";
import type { RelationshipCandidate } from "../lib/kb-candidate";
import { buildPendingCandidateQuery } from "../lib/relationship-candidate-query";
import { noteKey } from "../lib/session-scope";
import { vaultRelPath } from "./kb_add";
import { resolveReingestVaultRoot, ReingestPreconditionError } from "./kb_reingest";

// `mla kb forget <kbdoc:<id>|note:<externalObjectId>|<path>> [--reason <text>]`.
//
// Remote-capable: this command drives the intel route
// `POST /internal/v1/kb/forget`, which owns the governed tombstone primitive
// (KbDocumentService.tombstone_document: ACTIVE -> TOMBSTONED, idempotent on
// TOMBSTONED, PURGED is terminal). The CLI no longer spawns a local python
// subprocess (tools/mla_kb_forget.py) or needs an intel checkout on the
// operator's machine, so forget works from any laptop against any backend the
// same way every other `mla` command does (INV-OSS-1).
//
// Unlike reingest, forget needs NO content: it resolves a document identity and
// flips one column. Identity resolution is entirely server-side, so there is no
// resolve/apply round-trip. The CLIENT only picks the handle the server can
// resolve filesystem-free, mirroring the worker's two resolution candidates split
// across the wire:
//   - bare path / `note:<path>` that is a REAL local file: the client holds it, so
//     it computes the vault-relative POSIX path (`relPath`) the SAME way `mla kb
//     add` / `mla kb reingest` do (identical vault-root resolution -> identity
//     parity; a different root would 404 a doc that exists). The server prefixes
//     the single `notes/` root and canonicalizes.
//   - `kbdoc:<id>` / a stored `note:<externalObjectId>` / a bare identity string
//     (NOT a local file): the server resolves it directly from `ref` (exact PK
//     load for kbdoc, else canonicalize + resolve over the notes source tuple).
//
// This wrapper still owns: strict argv parsing, readKbConfig (actorUserId required
// so every forget carries an audited actor), the §13.14 owner-only ACL preflight,
// and the post-tombstone cascade that rejects PENDING relationship candidates
// pointing at the now-dead doc (keyed on receipt.canonicalPath, driven over control
// HTTP -- unchanged by the python -> HTTP move).
//
// Exit codes mirror the worker: 0 on success/idempotent (tombstoned /
// already_tombstoned), 2 on a precondition (unknown doc 404, PURGED 409, bad args
// 422, unresolved vault root for a local file), 1 on an operational failure (a
// network error, a 5xx, or a write-time state race the server reports as 500).

interface KbForgetFlags {
  input: string;
  workspace?: string;
  reason?: string;
}

const VALUE_FLAGS = new Set(["--workspace", "--reason"]);

const KBDOC_PREFIX = "kbdoc:";
const NOTE_PREFIX = "note:";

const FORGET_TIMEOUT_MS = 30_000;

export function parseKbForgetArgs(argv: string[]): KbForgetFlags {
  const out: Partial<KbForgetFlags> = {};
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
        case "--reason":
          out.reason = v;
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
        `\`mla kb forget\` takes exactly one positional input (got '${positional}' and '${a}')`,
      );
    }
    positional = a;
  }

  if (positional === null) {
    throw new Error(
      "`mla kb forget` requires a positional input: kbdoc:<id>, note:<path>, or a bare note path",
    );
  }
  return {
    input: positional,
    workspace: out.workspace,
    reason: out.reason,
  };
}

// ---------------------------------------------------------------------------
// Client-side handle resolution (was the python worker's identity-vs-filesystem
// candidate logic, minus the disk read forget never does).
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// EXACTLY ONE of `ref` (a filesystem-free identity) or `relPath` (a real local
// file's vault-relative POSIX path). The server canonicalizes either into the
// governed externalObjectId and resolves.
interface ForgetHandle {
  ref?: string;
  relPath?: string;
}

// Map the operator's input to the handle the route resolves. A real local file is
// mapped to its vault-relative path (the SAME mapping `kb add` / `kb reingest`
// use, so the identity matches); anything else (an opaque kbdoc id, a stored
// externalObjectId, or a path that is not a local file) is passed through as `ref`
// for the server to canonicalize and resolve. Throws ReingestPreconditionError
// (-> exit 2) only when a real local file's vault root cannot be resolved.
export function resolveForgetHandle(input: string): ForgetHandle {
  const raw = input.trim();
  if (!raw) {
    throw new ReingestPreconditionError(
      "`mla kb forget` requires a non-empty input",
    );
  }

  // kbdoc:<id>: opaque, never a file. The server does an exact PK load.
  if (raw.startsWith(KBDOC_PREFIX)) {
    const id = raw.slice(KBDOC_PREFIX.length).trim();
    if (!id) {
      throw new ReingestPreconditionError("kbdoc: prefix requires an id");
    }
    return { ref: raw };
  }

  // note:<X> or bare <X>. If X is a real local file, the client maps it to its
  // vault-relative path (filesystem form). Otherwise it is a stored
  // externalObjectId / identity string; pass it through for the server to resolve.
  const rawPath = raw.startsWith(NOTE_PREFIX) ? raw.slice(NOTE_PREFIX.length) : raw;
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
    return { relPath };
  }
  return { ref: raw };
}

function printPreflight(flags: KbForgetFlags, cfg: KbCliConfig): void {
  const ws = flags.workspace || cfg.workspaceId;
  const reasonHint = flags.reason ? ` reason=${JSON.stringify(flags.reason)}` : "";
  console.log(
    `mla kb forget workspace=${ws} input=${flags.input}${reasonHint}`,
  );
}

// Map an HTTP/network failure to the worker's exit semantics: a 404 (unknown
// doc), 409 (PURGED terminal), or 422 (bad args) is a precondition -> 2; a
// network error (no status), a 5xx, or the 500 write-time state race is an
// operational failure -> 1.
function exitForHttpError(e: unknown): number {
  const status = (e as HttpError)?.status;
  if (status === 404 || status === 409 || status === 422) return 2;
  return 1;
}

export interface CascadeResult {
  fetched: number;
  rejected: number;
  failed: number;
  fetchFailed: boolean;
}

export interface CascadeDeps {
  fetchPending: (qs: string) => Promise<{ items: RelationshipCandidate[]; nextCursor: unknown }>;
  submitReject: (id: string, body: { workspaceId: string; userId: string; note?: string }) => Promise<void>;
}

// Best-effort: after a doc is tombstoned, its PENDING relationship candidates point
// at a dead artifact and should not linger in the review queue. Keys on the note
// basename; the route matches either endpoint. A forgotten doc with >200 pending
// candidates is not realistic, so this reads a single page. Failures are caught and
// COUNTED (never thrown) so a cascade hiccup cannot mask a successful tombstone,
// but the caller reports them so the operator knows dangling edges may remain.
export async function cascadeRejectForDoc(
  canonicalPath: string,
  ctx: { workspaceId: string; actorUserId: string },
  deps: CascadeDeps,
): Promise<CascadeResult> {
  const key = noteKey(canonicalPath);
  let page: { items: RelationshipCandidate[]; nextCursor: unknown };
  try {
    page = await deps.fetchPending(buildPendingCandidateQuery(ctx.workspaceId, key, 200));
  } catch {
    return { fetched: 0, rejected: 0, failed: 0, fetchFailed: true };
  }
  let rejected = 0;
  let failed = 0;
  for (const c of page.items) {
    try {
      await deps.submitReject(c.id, {
        workspaceId: ctx.workspaceId,
        userId: ctx.actorUserId,
        note: "[forget-cascade] source document tombstoned",
      });
      rejected++;
    } catch {
      failed++;
    }
  }
  return { fetched: page.items.length, rejected, failed, fetchFailed: false };
}

export async function runKbForget(argv: string[]): Promise<number> {
  // Parse flags BEFORE loading config so `--workspace <id>` can override the
  // marker-resolved workspace (T1.1 folder = workspace) without requiring the
  // current directory to be activated.
  let flags: KbForgetFlags;
  try {
    flags = parseKbForgetArgs(argv);
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

  // §13.14 owner-only ACL: verify the configured actor is a workspace OWNER
  // before the tombstone side effect.
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

  // Pick the server-resolvable handle. A real local file maps to its vault-relative
  // path (vault root resolved client-side); an unresolved vault root for a real
  // file is a precondition (-> 2).
  let handle: ForgetHandle;
  try {
    handle = resolveForgetHandle(flags.input);
  } catch (e) {
    if (e instanceof ReingestPreconditionError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  const body = {
    workspaceId,
    actor: cfg.actorUserId,
    reason: flags.reason ?? undefined,
    ...handle,
  };

  let receipt: KbForgetReceipt;
  try {
    const res = await intelPost<{ receipt: KbForgetReceipt }>(
      cfg,
      "/internal/v1/kb/forget",
      body,
      FORGET_TIMEOUT_MS,
    );
    receipt = res.receipt;
  } catch (e) {
    console.error(`kb forget failed: ${(e as Error).message}`);
    return exitForHttpError(e);
  }

  if (!receipt) {
    console.error("kb forget: the route returned no receipt.");
    return 1;
  }

  console.log(renderKbForgetReceipt(receipt));
  console.log("");

  // Cascade: clear PENDING relationship candidates that referenced the now-dead doc.
  // Only a fresh tombstone needs it; an already_tombstoned doc's candidates were
  // cleared on the first forget.
  if (receipt.outcome === "tombstoned") {
    const cascadeDeps: CascadeDeps = {
      fetchPending: (qs) =>
        get<{ items: RelationshipCandidate[]; nextCursor: unknown }>(
          cfg,
          `/internal/v1/relationship-candidates?${qs}`,
          12000,
        ),
      submitReject: async (id, rejectBody) => {
        await post(
          cfg,
          `/internal/v1/relationship-candidates/${encodeURIComponent(id)}/reject`,
          rejectBody,
          12000,
        );
      },
    };
    const r = await cascadeRejectForDoc(
      receipt.canonicalPath,
      { workspaceId: cfg.workspaceId, actorUserId: cfg.actorUserId },
      cascadeDeps,
    );
    if (r.rejected > 0) {
      console.log(`Also cleared ${r.rejected} orphaned relationship candidate${r.rejected === 1 ? "" : "s"} that referenced this doc.`);
    }
    if (r.fetchFailed) {
      console.error("Warning: could not check for orphaned relationship candidates; some may remain in the review queue.");
    } else if (r.failed > 0) {
      console.error(`Warning: ${r.failed} orphaned relationship candidate${r.failed === 1 ? "" : "s"} could not be cleared; clear them with mla kb review <id> --reject.`);
    }
  }

  return 0;
}
