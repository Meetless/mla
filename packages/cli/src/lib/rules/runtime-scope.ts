import * as fs from "fs";

import { resolveProjectRoot } from "../wire";

// The active runtime scope id (proposal §2.3 / §10.1, P0.51 / decision 7). Every local interception
// row, the tool attempts, the evaluation records, and the attested versions, is keyed by
// runtime_scope_id, NEVER by a bare workspaceId. The id is the realpath-resolved checkout root of the
// activated runtime project: from the working directory, walk to the repo root and canonicalize. For
// R0/R1 there is NO runtime-scope table (decision 2); the resolved path string IS the identity, so a
// read or write derives it deterministically from the cwd rather than reading a row. resolveProjectRoot
// performs the git-toplevel walk (falling back to the cwd outside a repo); realpath then canonicalizes
// SYMLINKED paths to one stable identity.
//
// It does NOT fold a linked worktree onto its origin checkout, and must not. This comment used to
// claim it did ("worktrees and symlinked paths resolve to one stable identity"), which was false:
// realpath resolves symlinks, and a linked worktree is a different real directory with a different
// real path. The claim mattered, because it made a missing capability read as a shipped one in the
// two files anyone investigating D1 would open first (see also resolveScanRootIdentity). Corrected
// 2026-08-10, notes/20260810-worktree-binding-loss-and-multi-repo-shared-workspace.md.
//
// Per-checkout separation here is deliberate, not an oversight: `git rev-parse --show-toplevel` in a
// linked worktree returns the WORKTREE, so each checkout keeps its own runtime scope for
// interception, evaluation and attestation. A worktree inherits only the WORKSPACE binding
// (lib/activation.ts findActivation), never this identity.
export function resolveActiveRuntimeScopeId(cwd?: string): string {
  const root = resolveProjectRoot(cwd);
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}
