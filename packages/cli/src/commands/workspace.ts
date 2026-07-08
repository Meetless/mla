import { CFG_PATH, CliConfig, configExists, readConfig } from "../lib/config";
import { get, HttpError } from "../lib/http";
import {
  MarkerMissingWorkspaceIdError,
  NotActivatedError,
  resolveWorkspaceContext,
  WorkspaceContext,
} from "../lib/workspace";

// `mla workspace` (folder = workspace, T1.3 / T3.2,
// notes/20260604-folder-equals-workspace-binding-design.md)
//
// Repurposed for the folder-binding model. The workspace a directory runs under
// is no longer a machine-global cli-config pointer; it is resolved from the
// nearest `.meetless.json` marker, walking UP from cwd (nearest-wins, mirroring
// how Claude Code resolves CLAUDE.md). So:
//
//   mla workspace            show the workspace bound to this folder + health
//   mla workspace show       (alias for the above)
//   mla workspace use <id>   REMOVED. Hard error pointing at `mla activate`.
//
// `use` used to rewrite the global cli-config `workspaceId`, which is no longer
// a workspace source. Switching workspaces is now "cd to (or activate) the
// folder bound to that workspace", not flipping one machine-global pointer. We
// fail loud rather than silently no-op so muscle memory gets corrected, not
// swallowed.

// Loads machine credentials (controlUrl, controlToken, actor) from
// cli-config.json. NOTE: cli-config no longer carries the workspaceId (T1.1);
// the workspace is resolved from the folder marker, not here. This only fetches
// the creds the server probe needs.
function loadConfigOrExplain(): CliConfig | number {
  if (!configExists()) {
    console.error(
      `cli-config.json not found at ${CFG_PATH}. Run 'mla init --control-token <token>' first.`,
    );
    return 2;
  }
  try {
    return readConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
}

// `mla workspace show`: resolve the folder's workspace binding from the nearest
// marker and report its health.
//
// Pure-local states (not activated, stale marker) never touch the network. A
// healthy binding is corroborated against control so a marker pointing at a
// deleted / inaccessible workspace reads as a precise, actionable state here
// rather than an opaque 401/403/404 later mid-capture. The server probe is
// best-effort: control being down must NOT mask the local binding (which is
// printed first, before the probe).
async function runWorkspaceShow(): Promise<number> {
  const loaded = loadConfigOrExplain();
  if (typeof loaded === "number") return loaded;
  const cfg = loaded;

  let ctx: WorkspaceContext;
  try {
    ctx = resolveWorkspaceContext();
  } catch (e) {
    if (e instanceof NotActivatedError) {
      console.log("No workspace is bound to this folder.");
      console.log("  Run 'mla activate' here to bind (or create) one.");
      console.log(
        "  Meetless resolves the workspace from the nearest .meetless.json, " +
          "walking up from the current directory.",
      );
      return 0;
    }
    if (e instanceof MarkerMissingWorkspaceIdError) {
      console.log(`Stale binding: ${e.markerPath} has no usable workspaceId.`);
      console.log("  Run 'mla activate --repair' to re-stamp the marker.");
      return 0;
    }
    throw e;
  }

  // Healthy local binding. Print it FIRST so the answer is always visible even
  // when the server probe below is offline.
  const nameSuffix = ctx.workspaceName ? ` (${ctx.workspaceName})` : "";
  console.log(`Workspace: ${ctx.workspaceId}${nameSuffix}`);
  console.log(`  Bound by ${ctx.markerPath}`);

  // Corroborate against control. The marker is local truth for "which id"; only
  // the server knows whether that id still exists and is reachable.
  try {
    await get(
      cfg,
      `/internal/v1/workspaces/me?workspaceId=${encodeURIComponent(ctx.workspaceId)}`,
      5000,
    );
    console.log("  Status: active (exists and reachable).");
    return 0;
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 404) {
      console.log(
        `  Status: this repo is bound to ${ctx.workspaceId}, but the ` +
          `workspace does not exist or is inaccessible.`,
      );
      console.log("  Options: 'mla activate --repair' or 'mla deactivate'.");
      return 0;
    }
    // 401/403: shared internal bearer rejected, or (post-T1.4, when the CLI
    // sends X-Meetless-Actor) the caller is not a member. Today's shared key
    // does not 403 on non-membership, so this branch is forward-compatible.
    if (err.status === 401 || err.status === 403) {
      console.log(
        `  Status: this repo is bound to ${ctx.workspaceId}, but your token ` +
          `is not a member. Ask a workspace owner to add you.`,
      );
      return 0;
    }
    // Network error / control down / unexpected status: never fail the report.
    console.log(
      `  Status: could not verify with control (${err.status ?? "offline"}). ` +
        `The local binding above still applies.`,
    );
    return 0;
  }
}

// `mla workspace use <id>` is removed (T3.2). It rewrote the global cli-config
// workspaceId, which is no longer a workspace source under folder = workspace.
// Hard-error with a pointer to the replacement verb instead of silently doing
// nothing, so existing muscle memory / scripts get a clear migration signal.
function runWorkspaceUseRemoved(): number {
  console.error(
    "`mla workspace use` has been removed. Workspaces are now bound per folder " +
      "by a .meetless.json marker, not a global cli-config pointer.",
  );
  console.error(
    "  To switch workspace: cd to the folder bound to it, or run 'mla activate' " +
      "in this folder to bind (or create) a workspace here.",
  );
  return 2;
}

export async function runWorkspace(argv: string[]): Promise<number> {
  const [sub] = argv;
  if (sub === undefined || sub === "show") {
    return runWorkspaceShow();
  }
  if (sub === "use") {
    return runWorkspaceUseRemoved();
  }
  console.error(
    `Unknown workspace subcommand: ${sub}. Usage: mla workspace [show] ` +
      `(use 'mla activate' / 'mla deactivate' to change the binding).`,
  );
  return 2;
}
