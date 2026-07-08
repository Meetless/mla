// tools/meetless-agent/src/lib/identity-envelope.ts
// Canonical identity-envelope contract for Zone 1 (Active Review). The bash
// PostToolUse hook computes the same fields; these helpers define the one true
// shape so the TS reader and the bash writer cannot drift. See
// notes/20260604-auto-propose-produced-docs-to-kb.md (identity envelope, dedup key).

export type CaptureKind = "produced_doc" | "tagged_reference";

export interface IdentityEnvelope {
  workspaceId: string;
  ownerUserId: string;
  repoRootHash: string;
  canonicalPath: string;
  contentHash: string;
  sessionId: string;
  turnIndex: number;
  sourceProduct: string; // "claude_code"
  kind: CaptureKind;
  createdAt: string; // ISO8601 UTC
}

// Owner-scoped partition key. Active Review dedup and TTL are evaluated WITHIN a
// scope, which is what makes cross-owner isolation (test 32) hold even though the
// dedup tuple below names content, not owner.
export function scopeKey(e: Pick<IdentityEnvelope, "workspaceId" | "repoRootHash" | "ownerUserId">): string {
  return `${e.workspaceId}|${e.repoRootHash}|${e.ownerUserId}`;
}

// Full dedup identity. Spec lists the dedup tuple as
// workspaceId+repoRootHash+canonicalPath+contentHash+kind; we prefix it with the
// owner-scoped partition so identical content under two owners (test 32) or two
// repos (test 5) never collapses. This is the explicit resolution of the spec's
// dedup-key vs scope-key ambiguity: dedup is partitioned by scope.
export function dedupIdentity(
  e: Pick<IdentityEnvelope, "workspaceId" | "repoRootHash" | "ownerUserId" | "canonicalPath" | "contentHash" | "kind">,
): string {
  return [scopeKey(e), e.canonicalPath, e.contentHash, e.kind].join("|");
}
