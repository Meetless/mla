// Owner+workspace+repo+path keyed cache mapping a governed path to its KB doc id,
// with separate personal/shared namespaces. A bare-path key would cross owners and
// repos once Personal KB exists; this never uses one. 3-day TTL. See spec test 33.
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export type CacheNamespace = "personal" | "shared";

export interface GovernedPathKeyInput {
  workspaceId: string;
  ownerUserId: string;
  repoRootHash: string;
  canonicalPath: string;
  namespace: CacheNamespace;
}

const TTL_MS = 3 * 24 * 3600 * 1000;

export function governedPathCacheKey(k: GovernedPathKeyInput): string {
  return [k.namespace, k.workspaceId, k.ownerUserId, k.repoRootHash, k.canonicalPath].join("|");
}

function cacheFile(k: GovernedPathKeyInput, home: string): string {
  const dir = join(home, "logs", "governed-path", k.namespace);
  mkdirSync(dir, { recursive: true });
  const h = createHash("sha256").update(governedPathCacheKey(k)).digest("hex").slice(0, 24);
  return join(dir, `${h}.json`);
}

export function writeGovernedPath(k: GovernedPathKeyInput, docId: string, home: string): void {
  writeFileSync(cacheFile(k, home), JSON.stringify({ key: governedPathCacheKey(k), docId, ts: 0, written: Date.now() }));
}

export function readGovernedPath(k: GovernedPathKeyInput, home: string): string | null {
  const f = cacheFile(k, home);
  if (!existsSync(f)) return null;
  try {
    const body = JSON.parse(readFileSync(f, "utf8"));
    if (body.key !== governedPathCacheKey(k)) return null; // hash-collision guard
    if (Date.now() - body.written > TTL_MS) return null; // TTL
    return body.docId as string;
  } catch {
    return null;
  }
}

// Map an ingest receipt to its governed-path cache entry, or null when the receipt
// did not produce a live doc body (no-op restore / failure / corpus skip). namespace
// is "shared" for a LIVE-posture doc, "personal" for a SHADOW-posture (owner-private)
// doc. canonicalPath comes from the receipt (server-canonicalized; the CLI cannot
// canonicalize on its own), so this records the AUTHORITATIVE path, never a raw input.
export interface GovernedPathEntry {
  key: GovernedPathKeyInput;
  docId: string;
}

// The receipt slice this mapper reads. These are the real KbAddReceipt fields
// (lib/render.ts): the document id, the server-canonicalized path, the outcome,
// the file/corpus mode, and the effective posture string.
export interface ReceiptForGovernedPath {
  mode: "file" | "corpus";
  outcome: string;
  documentId: string;
  canonicalPath: string;
  posture?: string | null;
}

// Reuse of kb_add.ts receiptEnqueuesExtraction: only a body-changing FILE ingest
// (a minted, activated revision) produced a live doc body worth caching. A corpus
// rollup, a noop_unchanged delivery, or a failed ingest produced nothing, so it
// must not be cached.
//
// NOTE (posture removal): the born-PENDING model dropped posture from the receipt,
// so `receipt.posture` is now always absent and namespace routing below degrades
// to the "personal" namespace for every entry. This is graceful (the cache is
// best-effort and never gated on; a miss just costs a server round-trip), but the
// shared/personal split is no longer meaningful here. Re-key on document scope
// (WORKSPACE vs PERSON) in a follow-up if the split needs to be honored.
function receiptProducedLiveBody(r: ReceiptForGovernedPath): boolean {
  return r.mode === "file" && r.outcome === "ingested";
}

export function governedPathEntryForReceipt(
  receipt: ReceiptForGovernedPath,
  ctx: {
    workspaceId: string;
    ownerUserId: string;
    repoRootHash: string;
    defaultPosture?: string;
  },
): GovernedPathEntry | null {
  if (!receiptProducedLiveBody(receipt)) return null;
  if (!receipt.documentId || !receipt.canonicalPath) return null;
  // Effective posture from the receipt; fall back to ctx.defaultPosture (then
  // "SHADOW" -> personal) when the receipt carries no posture. Only an explicit
  // LIVE doc goes to the shared namespace; everything else is owner-private.
  const posture = (receipt.posture || ctx.defaultPosture || "SHADOW").toUpperCase();
  const namespace: CacheNamespace = posture === "LIVE" ? "shared" : "personal";
  return {
    key: {
      namespace,
      workspaceId: ctx.workspaceId,
      ownerUserId: ctx.ownerUserId,
      repoRootHash: ctx.repoRootHash,
      canonicalPath: receipt.canonicalPath,
    },
    docId: receipt.documentId,
  };
}
