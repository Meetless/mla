// src/lib/agent-memory-capture/upsert-client.ts
//
// The network seam for LIVE agent-memory capture (proposal §4 UPSERT_SOURCE_REVISION
// + WITHDRAW_SOURCE). The live pipeline depends ONLY on the narrow `UpsertClient`
// interface below, so unit tests inject a fake and the pipeline's COMMIT-1/RETRY-2
// logic is exercised without a server. The REAL implementation
// (`createIntelUpsertClient`) maps that interface onto the existing governed
// ingest front door, `POST /internal/v1/kb/add` (the same rail `mla kb add` uses),
// so agent-auto-memory revisions flow through the proven intake_delivery ->
// execute_run_set -> activation CAS pipeline rather than a parallel one.
//
// PHASE B SEAM (intel changes this client assumes; built in Phase B, not here):
//   1. `/internal/v1/kb/add` accepts an optional `captureMethod` ("agent_auto_memory");
//      when present the route derives provenance accordingly and marks the
//      revision DERIVED_ONLY / non-publishing (the raw never grounds, §5.1).
//   2. Each receipt echoes `contentSha256`: the server's sha256 of the RAW content
//      it received, so the CLI can verify hash equality before committing the
//      ledger (COMMIT-1). Older intel that omits it degrades to an outcome-only
//      commit (documented weaker guarantee; see the pipeline).
//   3. A withdraw-by-path route `POST /internal/v1/kb/withdraw` marks the logical
//      source WITHDRAWN (reuse intel `tombstone_document()`), retires PENDING
//      derived artifacts, and leaves ACCEPTED ones (§4 WITHDRAW_SOURCE).
//
// SECRET-1: this module performs NETWORK uploads. The caller (live pipeline) MUST
// run the credential denylist FIRST and never hand a credential-bearing body here.
// This module does not scan; it transports.
import type { CliConfig } from "../config";
import { intelPost } from "../http";

// Narrow capture-domain result of an upsert, decoupled from the kb/add wire
// receipt so the pipeline never sees route-specific field names.
export interface UpsertResult {
  // True when the round trip itself succeeded (HTTP 2xx + a parseable receipt).
  // False on any transport/parse error; the pipeline treats false as a retryable
  // failure that leaves the ledger untouched (RETRY-2).
  ok: boolean;
  // The server's disposition of the content. "failed" is a per-document intake
  // failure reported inside a 2xx receipt (ok stays true, but do not commit).
  outcome: "created" | "unchanged" | "failed";
  // The server's sha256 of the RAW content it received. null when the server did
  // not echo it; the pipeline then commits on outcome-success alone (weaker).
  serverContentHash: string | null;
  // Server revision id of the minted/deduped revision; null on failure.
  revisionId: string | null;
  // Server logical source id (the document id) the revision belongs to.
  logicalSourceId: string | null;
  reason: string;
}

export interface WithdrawResult {
  ok: boolean;
  withdrawn: boolean;
  // Count of PENDING derived artifacts retired by the withdraw; null when the
  // server did not report it.
  retiredPendingDerived: number | null;
  reason: string;
}

export interface UpsertInput {
  workspaceId: string;
  actor: string;
  // The synthetic reserved source path `_external/agent-auto-memory/<bindingId>/<rel>`.
  relPath: string;
  content: string;
  // The CLI's raw sha256 of `content`; sent so the server can verify + echo it.
  contentHash: string;
  bindingId: string;
  consentedAt: string;
}

export interface WithdrawInput {
  workspaceId: string;
  actor: string;
  relPath: string;
  reason: "deleted" | "reclassified";
}

export interface UpsertClient {
  upsert(input: UpsertInput): Promise<UpsertResult>;
  withdraw(input: WithdrawInput): Promise<WithdrawResult>;
}

// The capture method the route uses to branch provenance + non-publication.
export const CAPTURE_METHOD = "agent_auto_memory" as const;

// Default LDM profile; agent-memory bodies are markdown like notes. Kept here so
// the route input is explicit rather than relying on a server default.
const DEFAULT_PROFILE = "markdown_atomic_v1";

// The slice of the kb/add receipt this client reads. Kept local (not the full
// KbAddReceipt) so an unrelated server-side field add never breaks the mapping.
// `contentSha256` is the Phase B addition (#2 above).
interface KbAddReceiptSlice {
  outcome?: "ingested" | "noop_unchanged" | "failed" | string;
  documentId?: string | null;
  revisionId?: string | null;
  contentSha256?: string | null;
  reason?: string | null;
}

function mapOutcome(outcome: string | undefined): UpsertResult["outcome"] {
  if (outcome === "ingested") return "created";
  if (outcome === "noop_unchanged") return "unchanged";
  return "failed";
}

// The intel POST signature this client depends on. Injectable so a unit test can
// assert the request body + receipt mapping without a server, mirroring
// mcp-fetchers' makeIntelAskFromCli(cfg, intelPostFn) idiom.
export type IntelPostFn = <T>(
  cfg: CliConfig,
  path: string,
  body: unknown,
  timeoutMs?: number,
) => Promise<T>;

// The real client. Closes over a CliConfig-compatible config (controlToken +
// intelUrl + auth) and reuses intelPost, so it inherits the intel auth fail-fast,
// trace/session headers, and timeout handling already proven on `mla kb add`.
export function createIntelUpsertClient(
  cfg: CliConfig,
  post: IntelPostFn = intelPost,
): UpsertClient {
  return {
    async upsert(input: UpsertInput): Promise<UpsertResult> {
      const body = {
        workspaceId: input.workspaceId,
        actor: input.actor,
        captureMethod: CAPTURE_METHOD,
        bindingId: input.bindingId,
        consentedAt: input.consentedAt,
        provenance: CAPTURE_METHOD, // advisory; the server derives the recorded value
        profile: DEFAULT_PROFILE,
        mode: "file" as const,
        documents: [
          {
            relPath: input.relPath,
            content: input.content,
            // Sent so the server can verify it received the exact bytes and echo
            // its own sha256 back for the COMMIT-1 hash check.
            contentSha256: input.contentHash,
          },
        ],
      };
      let res: { receipts?: KbAddReceiptSlice[] };
      try {
        res = await post<{ receipts?: KbAddReceiptSlice[] }>(
          cfg,
          "/internal/v1/kb/add",
          body,
        );
      } catch (e) {
        return {
          ok: false,
          outcome: "failed",
          serverContentHash: null,
          revisionId: null,
          logicalSourceId: null,
          reason: `upload_failed: ${(e as Error).message}`,
        };
      }
      const receipt = res.receipts?.[0];
      if (!receipt) {
        return {
          ok: false,
          outcome: "failed",
          serverContentHash: null,
          revisionId: null,
          logicalSourceId: null,
          reason: "no_receipt",
        };
      }
      return {
        ok: true,
        outcome: mapOutcome(receipt.outcome),
        serverContentHash: receipt.contentSha256 ?? null,
        revisionId: receipt.revisionId ?? null,
        logicalSourceId: receipt.documentId ?? null,
        reason: receipt.reason ?? receipt.outcome ?? "",
      };
    },

    async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
      const body = {
        workspaceId: input.workspaceId,
        actor: input.actor,
        captureMethod: CAPTURE_METHOD,
        relPath: input.relPath,
        reason: input.reason,
      };
      try {
        const res = await post<{
          withdrawn?: boolean;
          retiredPendingDerived?: number | null;
          reason?: string | null;
        }>(cfg, "/internal/v1/kb/withdraw", body);
        return {
          ok: true,
          withdrawn: res.withdrawn === true,
          retiredPendingDerived: res.retiredPendingDerived ?? null,
          reason: res.reason ?? "",
        };
      } catch (e) {
        return {
          ok: false,
          withdrawn: false,
          retiredPendingDerived: null,
          reason: `withdraw_failed: ${(e as Error).message}`,
        };
      }
    },
  };
}
