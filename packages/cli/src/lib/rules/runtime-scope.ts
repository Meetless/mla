import * as fs from "fs";

import { resolveProjectRoot } from "../wire";

// The active runtime scope id (proposal §2.3 / §10.1, P0.51 / decision 7). Every local interception
// row, the tool attempts, the evaluation records, and the attested versions, is keyed by
// runtime_scope_id, NEVER by a bare workspaceId. The id is the realpath-resolved checkout root of the
// activated runtime project: from the working directory, walk to the repo root and canonicalize. For
// R0/R1 there is NO runtime-scope table (decision 2); the resolved path string IS the identity, so a
// read or write derives it deterministically from the cwd rather than reading a row. resolveProjectRoot
// performs the git-toplevel walk (falling back to the cwd outside a repo); realpath then canonicalizes
// it so worktrees and symlinked paths resolve to one stable identity.
export function resolveActiveRuntimeScopeId(cwd?: string): string {
  const root = resolveProjectRoot(cwd);
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}
