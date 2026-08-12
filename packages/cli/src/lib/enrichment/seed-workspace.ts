// src/lib/enrichment/seed-workspace.ts
//
// The real-world wiring for the deterministic seed: git, the filesystem, the per-root receipt,
// and the kb-add POST. `deterministic-seed.ts` holds the decisions and stays pure; this holds the
// I/O and stays dumb, so every bound in the policy is a unit test rather than a live probe.
//
// This module runs on the SessionStart path. Two rules follow from that and neither is optional:
//   - it must never throw (a nudge is not a gate), and
//   - it must never wait long (a slow intel costs the user a moment, never a session).
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { KbCliConfig, CliConfig } from "../config";
import { intelPost } from "../http";
import { scanCacheRootKey, scanCacheRootsDir } from "../scanner/cache";
import {
  migrateReceipt,
  runDeterministicSeed,
  type SeedOutcome,
  type SeedPersistResult,
  type SeedPromoteResult,
  type SeedReceipt,
} from "./deterministic-seed";
import type { PersistDocument, PersistOutcome } from "./ingest";

export type { SeedOutcome } from "./deterministic-seed";

/**
 * The whole seed's network budget, and it is deliberately small.
 *
 * The interactive ingest path allows 90s (`INGEST_TIMEOUT_MS`), sized against Cloudflare's 100s
 * origin-response wall. That is the right number for a human who typed `mla enrich ingest` and is
 * watching it. It is the wrong number in front of a session start, where the user typed nothing
 * and is waiting on us. A measured single-document POST against local intel is ~1.3s, so 8s
 * covers a batch of three with room, and a slower backend simply converges over the next few
 * sessions: the receipt makes the seed resumable, so a timeout is a delay, never a loss.
 */
export const SEED_POST_TIMEOUT_MS = 8_000;

/** A KbAddReceipt, narrowed to the two fields this path reads. */
interface SeedReceiptRow {
  outcome?: PersistOutcome;
  documentId?: string;
}

export interface SeedWorkspaceArgs {
  /** The activation root (the marker directory), which is the repository we seed. */
  cwd: string;
  /** From the RESOLVED marker, never from cli-config: we seed the repo we are standing in. */
  workspaceId: string;
  cfg: CliConfig;
  /** State-root override, for tests. Undefined lets the cache module honor MEETLESS_HOME. */
  home?: string;
}

/**
 * Seed this checkout's agent-instruction files into the workspace's governed memory.
 *
 * Returns an outcome; never throws.
 */
export async function seedWorkspaceInstructions(args: SeedWorkspaceArgs): Promise<SeedOutcome> {
  const kbCfg: KbCliConfig = {
    ...args.cfg,
    workspaceId: args.workspaceId,
    actorUserId: args.cfg.actorUserId ?? "",
  };

  return runDeterministicSeed(args.cwd, {
    listTracked: gitLsFiles,
    readFile: safeRead,
    repoName: resolveRepoName,
    readReceipt: () => readSeedReceipt(args.workspaceId, args.cwd, args.home),
    writeReceipt: (r) => writeSeedReceipt(args.workspaceId, args.cwd, r, args.home),
    persist: (docs) => postDocuments(kbCfg, docs),
    promote: (documentId) => promoteToWorkspace(kbCfg, documentId),
    tombstone: (documentId, reason) => tombstoneDocument(kbCfg, documentId, reason),
    now: () => new Date().toISOString(),
  });
}

/** POST one batch to the governed ingestion front door. See the `provenance` note inline. */
async function postDocuments(
  cfg: KbCliConfig,
  docs: PersistDocument[],
): Promise<{ docs: SeedPersistResult[] }> {
  const res = await intelPost<{ receipts: SeedReceiptRow[] }>(
    cfg,
    "/internal/v1/kb/add",
    {
      workspaceId: cfg.workspaceId,
      actor: cfg.actorUserId,
      documents: docs.map((d) => ({ relPath: d.relPath, content: d.content })),
      // No `provenance`. The field is ADVISORY ONLY: the server derives the immutable lineage
      // label from the request envelope (kb_add.py, "provenance is SERVER-DERIVED"), and a
      // measured probe confirmed it: we sent `human_authored` and the stored revision came back
      // `external_imported`. That derived label is also the CORRECT one, because these bytes
      // reach us as a machine-read git-tracked file, not through an authenticated human
      // authoring surface. Stating a value the server ignores only misrepresents our own intent.
      //
      // The distinction is not cosmetic: `is_authenticated_human_authoring` co-derives the BORN
      // TRUST verdict, and a request that satisfied it would mint revisions born ACCEPTED,
      // bypassing the human gate entirely. The notes lane cannot reach that branch (it sends no
      // `captureMethod`), which is why our seeds are provably born PENDING. Do not "fix" the
      // label by claiming human authorship.
      profile: "markdown_atomic_v1",
      mode: "file",
    },
    SEED_POST_TIMEOUT_MS,
  );
  const receipts = res.receipts ?? [];
  // Zip by position, the route's contract. A missing receipt reads as "failed", which makes the
  // file retry next session rather than be recorded as seeded on evidence we never got.
  return {
    docs: docs.map((d, i) => ({
      relPath: d.relPath,
      outcome: receipts[i]?.outcome ?? "failed",
      documentId: receipts[i]?.documentId,
    })),
  };
}

/**
 * Share one seeded document with the workspace.
 *
 * This is the CANONICAL scope transition (`mla kb promote` drives the same route through the
 * same shared helper), not a new mechanism: `POST /kb/documents/<id>/scope {scope:"WORKSPACE"}`.
 * It is idempotent server-side (a document already at the target scope is a no-op that appends
 * no lifecycle event), and, verified live on 2026-08-07, the WORKSPACE scope SURVIVES later
 * content revisions, so one successful promote per document holds forever.
 *
 * Authorization is unchanged and still the substrate's: the route runs `_load_document_for_viewer`,
 * and a PERSON document is loadable only by its owner, so this can only ever promote a document
 * this very run just created as this very user. It cannot reach anyone else's private document.
 *
 * The 409 `KB_SCOPE_SOURCE_ALREADY_SHARED` is not an error, it is the answer: a partial unique
 * index (WHERE scope='WORKSPACE') permits exactly ONE shared copy per source object, so this
 * says a teammate already shared this file and our copy is redundant.
 */
async function promoteToWorkspace(
  cfg: KbCliConfig,
  documentId: string,
): Promise<SeedPromoteResult> {
  const qs = new URLSearchParams({ workspaceId: cfg.workspaceId }).toString();
  try {
    await intelPost(
      cfg,
      `/internal/v1/kb/documents/${encodeURIComponent(documentId)}/scope?${qs}`,
      {
        scope: "WORKSPACE",
        actorBy: cfg.actorUserId,
        reason: "deterministic seed of a git-tracked agent-instruction file",
      },
      SEED_POST_TIMEOUT_MS,
    );
    return { shared: true };
  } catch (e) {
    if (conflictCode(e, "KB_SCOPE_SOURCE_ALREADY_SHARED")) {
      return { shared: false, alreadySharedByOther: true };
    }
    if (conflictCode(e, "KB_DOCUMENT_NOT_RESCOPABLE")) {
      return { shared: false, notRescopable: true };
    }
    throw e;
  }
}

// Match the server's CODE, never its prose. The route returns two DIFFERENT 409s and they mean
// opposite things: SOURCE_ALREADY_SHARED says a teammate owns the shared copy (retract ours),
// NOT_RESCOPABLE says our own copy is tombstoned (abandon the path). Collapsing them would
// either claim a teammate that does not exist or retry a document that can never change state.
function conflictCode(e: unknown, code: string): boolean {
  const err = e as { status?: number; body?: unknown };
  if (err?.status !== 409) return false;
  const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "");
  return body.includes(code);
}

/**
 * Retract one governed document: the existing tombstone primitive, the same route `mla kb forget`
 * drives (`POST /internal/v1/kb/forget`, KbDocumentService.tombstone_document, idempotent on an
 * already-TOMBSTONED document).
 *
 * Two callers, one meaning ("this document no longer has a source worth serving"): a redundant
 * private copy of a file a teammate already shares, and a document whose file left the checkout.
 * Addressed by `kbdoc:<id>` rather than by path, because a deleted file cannot be resolved from
 * the filesystem and resolving a tombstone target by name is how the wrong document gets killed.
 */
async function tombstoneDocument(
  cfg: KbCliConfig,
  documentId: string,
  reason: string,
): Promise<void> {
  await intelPost(
    cfg,
    "/internal/v1/kb/forget",
    { workspaceId: cfg.workspaceId, actor: cfg.actorUserId, ref: `kbdoc:${documentId}`, reason },
    SEED_POST_TIMEOUT_MS,
  );
}

// --- filesystem + git seams -------------------------------------------------

/**
 * Returns null (not []) when the probe itself failed, mirroring the scanner's `gitLsFiles`. The
 * distinction is load-bearing: [] is "this checkout tracks nothing", null is "I could not look",
 * and only the first is an authoritative statement about what is on disk.
 */
function gitLsFiles(cwd: string): string[] | null {
  try {
    return execFileSync("git", ["ls-files"], {
      cwd,
      encoding: "utf8",
      // Discard git's stderr: a non-git scan root is a SUPPORTED state (the marker can sit above
      // the checkouts), and the inherited default printed "fatal: not a git repository" straight
      // into the operator's terminal on every session start.
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function safeRead(cwd: string, repoPath: string): string | null {
  try {
    return readFileSync(join(cwd, repoPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * The repository's name for KB identity. The git toplevel's basename, falling back to the scan
 * root's basename outside a checkout. Never an absolute path: see `seedRelPath` for why the
 * identity must be stable across machines.
 */
function resolveRepoName(cwd: string): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return basename(top);
  } catch {
    /* not a checkout: fall through */
  }
  return basename(cwd) || "repo";
}

// --- the per-root receipt ---------------------------------------------------

/**
 * The seed receipt path, keyed by workspace AND root.
 *
 * Per-ROOT is not a nicety. One workspace id can be bound by several `.meetless.json` markers
 * (this dogfood workspace is bound by three), and a workspace-keyed file is last-writer-wins
 * across them: repo A would record its digests, repo B would overwrite them, and each would then
 * re-POST its own files forever while believing the other's were its own. That is the exact shape
 * of the scan-cache poisonings of 2026-07-28 and 2026-08-02, and it is cheaper to not build it
 * again than to diagnose it again. It reuses the scan cache's own root-key hash so both artifacts
 * partition identically.
 */
function seedReceiptPath(workspaceId: string, root: string, home?: string): string {
  return join(scanCacheRootsDir(workspaceId, home), `seed-receipt-${scanCacheRootKey(root)}.json`);
}

function readSeedReceipt(workspaceId: string, root: string, home?: string): SeedReceipt | null {
  try {
    const raw = readFileSync(seedReceiptPath(workspaceId, root, home), "utf8");
    // migrateReceipt reads BOTH shapes: a v1 receipt keeps its digests (so upgrading does not
    // re-POST an entire corpus) and gains no document ids, which it never had. Anything else,
    // including a future version, reads as absent and re-POSTs idempotently.
    return migrateReceipt(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeSeedReceipt(
  workspaceId: string,
  root: string,
  receipt: SeedReceipt,
  home?: string,
): void {
  const path = seedReceiptPath(workspaceId, root, home);
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename: several sessions in this repo start concurrently, and a half-written
  // receipt read by the next one would parse as absent and silently re-POST the whole set.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(receipt), "utf8");
  renameSync(tmp, path);
}
