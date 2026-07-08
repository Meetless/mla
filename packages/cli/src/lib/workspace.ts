import { findActivation } from "./activation";

// Folder = workspace (notes/20260604-folder-equals-workspace-binding-design.md,
// T1.1). The single shared resolver for "which workspace is this directory bound
// to?". It walks UP from a start dir to the nearest `.meetless.json` marker
// (nearest-wins, mirroring how Claude Code resolves CLAUDE.md and how the bash
// gate `meetless_activated` behaves) and returns the marker's workspaceId.
//
// The marker is the ONLY source of the workspaceId. There is no cli-config
// fallback: cli-config carries machine creds (controlUrl, controlToken, actor),
// never the per-folder workspace binding. A directory with no usable marker is
// "not activated" and workspace-scoped commands refuse with a clear pointer to
// `mla activate`.

export class NotActivatedError extends Error {
  constructor(public readonly startDir: string) {
    super(
      `No Meetless workspace is activated for this directory ` +
        `(${startDir}). Run 'mla activate' here to bind this repository to a ` +
        `workspace. Meetless resolves the workspace from the nearest ` +
        `.meetless.json, walking up from the current directory.`,
    );
    this.name = "NotActivatedError";
  }
}

export class MarkerMissingWorkspaceIdError extends Error {
  constructor(public readonly markerPath: string) {
    super(
      `The Meetless marker at ${markerPath} has no usable workspaceId ` +
        `(missing or malformed). Re-run 'mla activate' to repair the binding.`,
    );
    this.name = "MarkerMissingWorkspaceIdError";
  }
}

export interface WorkspaceContext {
  workspaceId: string;
  // Display-only label from the marker; never used for authorization.
  workspaceName?: string;
  markerPath: string;
  markerDir: string;
}

// Non-throwing lookup: returns the resolved context, or null when no usable
// marker exists up the tree (no marker at all, or a marker with no workspaceId).
// Use this on best-effort paths (CLI bootstrap trace flush, prefetch) that must
// degrade silently rather than fail a non-workspace command.
export function findWorkspaceContext(
  startDir: string = process.cwd(),
): WorkspaceContext | null {
  const found = findActivation(startDir);
  if (!found || !found.workspaceId) return null;
  return {
    workspaceId: found.workspaceId,
    workspaceName: found.workspaceName,
    markerPath: found.path,
    markerDir: found.dir,
  };
}

// Throwing lookup for command bodies that REQUIRE an activated workspace.
// Distinguishes "no marker" (NotActivatedError) from "marker present but no
// usable workspaceId" (MarkerMissingWorkspaceIdError) so callers and `mla
// doctor` / `mla workspace show` can report a stale binding precisely.
export function resolveWorkspaceContext(
  startDir: string = process.cwd(),
): WorkspaceContext {
  const found = findActivation(startDir);
  if (!found) throw new NotActivatedError(startDir);
  if (!found.workspaceId) throw new MarkerMissingWorkspaceIdError(found.path);
  return {
    workspaceId: found.workspaceId,
    workspaceName: found.workspaceName,
    markerPath: found.path,
    markerDir: found.dir,
  };
}

export function resolveWorkspaceId(startDir: string = process.cwd()): string {
  return resolveWorkspaceContext(startDir).workspaceId;
}

export function tryResolveWorkspaceId(
  startDir: string = process.cwd(),
): string | null {
  const ctx = findWorkspaceContext(startDir);
  return ctx ? ctx.workspaceId : null;
}

// Shared resolver for commands that require a workspace: checks the
// MEETLESS_WORKSPACE_ID env var first (operator override), then walks up from
// process.cwd() via tryResolveWorkspaceId to the nearest .meetless.json marker.
// Returns undefined when neither source yields an id. Never throws.
export function resolveWorkspaceIdWithEnv(): string | undefined {
  const envWs = (process.env.MEETLESS_WORKSPACE_ID ?? "").trim();
  if (envWs) return envWs;
  try {
    return tryResolveWorkspaceId() ?? undefined;
  } catch {
    return undefined;
  }
}
