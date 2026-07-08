import { readKbConfig, KbCliConfig } from "../lib/config";
import { verifyKbActorIsOwner, KbOwnerCheckError } from "../lib/kb_acl";
import { KbPurgeReceipt, renderKbPurgeReceipt } from "../lib/render";
import { get, post, intelPost, HttpError } from "../lib/http";
import type { RelationshipCandidate } from "../lib/kb-candidate";
import { resolveForgetHandle, cascadeRejectForDoc, CascadeDeps } from "./kb_forget";
import { ReingestPreconditionError } from "./kb_reingest";

// `mla kb purge <kbdoc:<id>|note:<externalObjectId>|<path>> --reason "<text>"`.
//
// Remote-capable: this command drives the intel route
// `POST /internal/v1/kb/purge`, which owns the governed redact-all-revisions +
// tombstone primitive. Purge is the harder sibling of forget: the route redacts
// EVERY revision of the resolved document (KbDocumentService.redact_revision
// removes served content while keeping audit metadata) and then tombstones the
// document. The CLI no longer spawns a local python subprocess
// (tools/mla_kb_purge.py) or needs an intel checkout on the operator's machine,
// so purge works from any laptop against any backend (INV-OSS-1), in lockstep
// with kb add / reingest / forget.
//
// Slice A ships no physical-purge primitive (no PURGED setter), so a purged
// document ends TOMBSTONED with all revisions REDACTED; the terminal physical
// hard-delete stays deferred.
//
// Identity dispatch is SHARED with forget, deliberately: purge reuses
// `resolveForgetHandle`, so `mla kb purge X` produces the exact same `ref` /
// `relPath` handle `mla kb forget X` would, and the route resolves it through the
// SAME server-side resolver. The guarantee is end-to-end: purge redacts exactly
// the document forget would tombstone. A real local file maps to its
// vault-relative POSIX path (computed the same way `kb add` does -> identity
// parity); anything else passes through as `ref` for the server to canonicalize.
//
// This wrapper still owns: strict argv parsing (--reason MANDATORY at >=16 chars
// because redaction is irreversible in slice A; the route re-checks as a
// boundary), readKbConfig (actorUserId required so every purge carries an audited
// actor), the §13.14 owner-only ACL preflight (purge is the most destructive KB
// write), and the post-purge cascade that rejects PENDING relationship candidates
// pointing at the now-dead doc (shared verbatim with forget, driven over control
// HTTP).
//
// Exit codes mirror the worker: 0 on success/idempotent (purged / already_purged),
// 2 on a precondition (unknown doc 404, PURGED 409, bad args / short reason 422,
// unresolved vault root for a local file), 1 on an operational failure (a network
// error, a 5xx, or a write-time state race the server reports as 500).

interface KbPurgeFlags {
  input: string;
  workspace?: string;
  reason: string;
}

const VALUE_FLAGS = new Set(["--workspace", "--reason"]);
const MIN_REASON_CHARS = 16;

const PURGE_TIMEOUT_MS = 30_000;

export function parseKbPurgeArgs(argv: string[]): KbPurgeFlags {
  const out: Partial<KbPurgeFlags> = {};
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
        `\`mla kb purge\` takes exactly one positional input (got '${positional}' and '${a}')`,
      );
    }
    positional = a;
  }

  if (positional === null) {
    throw new Error(
      "`mla kb purge` requires a positional input: kbdoc:<id>, note:<path>, or a bare note path",
    );
  }
  if (!out.reason || !out.reason.trim()) {
    throw new Error(
      "--reason \"...\" is required: purge redacts every revision, which is irreversible in slice A",
    );
  }
  if (out.reason.trim().length < MIN_REASON_CHARS) {
    throw new Error(
      `--reason must be at least ${MIN_REASON_CHARS} characters of rationale (purge is irreversible)`,
    );
  }
  return {
    input: positional,
    workspace: out.workspace,
    reason: out.reason,
  };
}

function printPreflight(flags: KbPurgeFlags, cfg: KbCliConfig): void {
  const ws = flags.workspace || cfg.workspaceId;
  console.log(
    `mla kb purge workspace=${ws} input=${flags.input} reason=${JSON.stringify(flags.reason)}`,
  );
}

// Map an HTTP/network failure to the worker's exit semantics: a 404 (unknown
// doc), 409 (PURGED terminal), or 422 (bad args / short reason) is a precondition
// -> 2; a network error (no status), a 5xx, or the 500 write-time state race is an
// operational failure -> 1. Identical to forget's mapping.
function exitForHttpError(e: unknown): number {
  const status = (e as HttpError)?.status;
  if (status === 404 || status === 409 || status === 422) return 2;
  return 1;
}

export async function runKbPurge(argv: string[]): Promise<number> {
  // Parse flags BEFORE loading config so `--workspace <id>` can override the
  // marker-resolved workspace (T1.1 folder = workspace) without requiring the
  // current directory to be activated.
  let flags: KbPurgeFlags;
  try {
    flags = parseKbPurgeArgs(argv);
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

  // §13.14 owner-only ACL: purge is the most destructive KB write; the gate runs
  // before the route so a non-owner cannot trigger redact-all + tombstone.
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

  // Pick the server-resolvable handle, SHARED with forget so `purge X` and
  // `forget X` produce the same handle. A real local file maps to its
  // vault-relative path (vault root resolved client-side); an unresolved vault
  // root for a real file is a precondition (-> 2).
  let handle: ReturnType<typeof resolveForgetHandle>;
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
    reason: flags.reason,
    ...handle,
  };

  let receipt: KbPurgeReceipt;
  try {
    const res = await intelPost<{ receipt: KbPurgeReceipt }>(
      cfg,
      "/internal/v1/kb/purge",
      body,
      PURGE_TIMEOUT_MS,
    );
    receipt = res.receipt;
  } catch (e) {
    console.error(`kb purge failed: ${(e as Error).message}`);
    return exitForHttpError(e);
  }

  if (!receipt) {
    console.error("kb purge: the route returned no receipt.");
    return 1;
  }

  console.log(renderKbPurgeReceipt(receipt));
  console.log("");

  // Cascade: a purged doc is dead the same way a forgotten one is, so its PENDING
  // relationship candidates point at a dead artifact and should not linger in the
  // review queue. Only a fresh purge needs it; an already_purged doc's candidates
  // were cleared on the first purge/forget. Reuse forget's best-effort cascade.
  if (receipt.outcome === "purged") {
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
    const c = await cascadeRejectForDoc(
      receipt.canonicalPath,
      { workspaceId: cfg.workspaceId, actorUserId: cfg.actorUserId },
      cascadeDeps,
    );
    if (c.rejected > 0) {
      console.log(`Also cleared ${c.rejected} orphaned relationship candidate${c.rejected === 1 ? "" : "s"} that referenced this doc.`);
    }
    if (c.fetchFailed) {
      console.error("Warning: could not check for orphaned relationship candidates; some may remain in the review queue.");
    } else if (c.failed > 0) {
      console.error(`Warning: ${c.failed} orphaned relationship candidate${c.failed === 1 ? "" : "s"} could not be cleared; clear them with mla kb review <id> --reject.`);
    }
  }

  return 0;
}
