import {
  CFG_PATH,
  CliConfig,
  configExists,
  getConsoleUrl,
  loadWorkspaceConfig,
  readConfig,
  type WorkspaceCliConfig,
} from "../lib/config";
import { get, HttpError } from "../lib/http";
import {
  inviteMember,
  listMembers,
  removeMember,
  type WorkspaceMemberClientHttp,
} from "../lib/control-workspace-member-client";
import {
  reactivateWorkspace,
  type WorkspaceLifecycleClientHttp,
} from "../lib/control-workspace-lifecycle-client";
import { extractWorkspaceOverride } from "./rules-backend";
import { staleCommandHint } from "../lib/update-notifier";
import {
  MarkerMissingWorkspaceIdError,
  NotActivatedError,
  resolveWorkspaceContext,
  WorkspaceContext,
} from "../lib/workspace";

// `mla workspace` (folder = workspace, T1.3 / T3.2,
// notes/20260604-folder-equals-workspace-binding-design.md; membership doorway,
// notes/20260710-mla-team-shared-workspace-membership.md)
//
// Repurposed for the folder-binding model. The workspace a directory runs under
// is no longer a machine-global cli-config pointer; it is resolved from the
// nearest `.meetless.json` marker, walking UP from cwd (nearest-wins, mirroring
// how Claude Code resolves CLAUDE.md). So:
//
//   mla workspace              show the workspace bound to this folder + health
//   mla workspace show         (alias for the above)
//   mla workspace use <id>     REMOVED. Hard error pointing at `mla activate`.
//   mla workspace invite <em>  add a teammate's email as a MEMBER (owner/admin)
//   mla workspace members      list the workspace's active members
//   mla workspace remove <em>  revoke a MEMBER's access (owner/admin)
//
// The invite/members/remove verbs are the Shared-Workspace Membership Doorway:
// they let a whole team share ONE workspace's governed memory, cases, and
// conflict detection. Membership is bridged purely by WorkspaceUser.email, so
// inviting an email IS the grant; when that person runs `mla login`, the auth
// fan-out finds their invited row. Billing is unaffected: usage stays charged to
// the workspace's billingAccountId no matter who is a member. Every verb honors
// the `--workspace <id>` admin override (BUG-3/BUG-4) and the control server
// enforces the owner/admin gate against the marker-resolved workspace.
//
// `use` used to rewrite the global cli-config `workspaceId`, which is no longer
// a workspace source. Switching workspaces is now "cd to (or activate) the
// folder bound to that workspace", not flipping one machine-global pointer. We
// fail loud rather than silently no-op so muscle memory gets corrected, not
// swallowed.

const WORKSPACE_INVITE_USAGE =
  "usage: mla workspace invite <email> [--json] [--workspace <id>]\n" +
  "  Add a teammate's email as a MEMBER of the folder-bound workspace so they\n" +
  "  can bind their own `mla login` to it. Owner/admin only.\n" +
  "  --workspace <id>  target the given workspace instead of the folder-bound one.";

const WORKSPACE_MEMBERS_USAGE =
  "usage: mla workspace members [--json] [--workspace <id>]\n" +
  "  List the active members of the folder-bound workspace.\n" +
  "  --workspace <id>  target the given workspace instead of the folder-bound one.";

const WORKSPACE_REMOVE_USAGE =
  "usage: mla workspace remove <email> [--json] [--workspace <id>]\n" +
  "  Revoke a MEMBER's access to the folder-bound workspace. Owner/admin only.\n" +
  "  --workspace <id>  target the given workspace instead of the folder-bound one.";

const WORKSPACE_REACTIVATE_USAGE =
  "usage: mla workspace reactivate [<id>] [--json] [--workspace <id>]\n" +
  "  Reactivate a deactivated (retired) workspace so it rejoins the active\n" +
  "  switcher list. Owner/admin only. Idempotent (an already-active workspace\n" +
  "  is a no-op).\n" +
  "  <id>              the workspace to reactivate (defaults to the folder-bound\n" +
  "                    one). After `mla deactivate` unbinds the folder, pass the\n" +
  "                    id it printed here.\n" +
  "  --workspace <id>  same as the positional; target a workspace by id.\n" +
  "  (The Console switcher's Reactivate button is the other way in.)";

// Injectable seams so the membership verbs are unit-testable with no network and
// no on-disk config, mirroring the rules-backend command deps convention.
export interface WorkspaceMemberDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: WorkspaceMemberClientHttp;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

// Same injectable-seam convention as WorkspaceMemberDeps, but the lifecycle client
// only needs get/post (no del), so it takes the lifecycle http shape.
export interface WorkspaceLifecycleDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: WorkspaceLifecycleClientHttp;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

// Prefer the control server's human-readable `message` over the raw
// "METHOD URL -> HTTP 409: {json}" HttpError.message. The control error body is
// `{ statusCode, code, message, ... }` (api-exception.ts); a network error (no
// body) or a non-JSON body falls through to the raw message.
function serverMessage(e: unknown): string {
  const err = e as HttpError;
  if (err && typeof err.body === "string" && err.body) {
    try {
      const parsed = JSON.parse(err.body) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message) {
        return err.status ? `${parsed.message} (HTTP ${err.status})` : parsed.message;
      }
    } catch {
      // non-JSON body: fall through to the raw error message
    }
  }
  return (e as Error).message;
}

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

// `mla workspace invite <email>`: pre-authorize a teammate's email as an active
// MEMBER of the target workspace. Owner/admin only (enforced server-side against
// the marker-resolved workspace). Role-preserving: the backend can only
// create/reactivate a MEMBER, never elevate or reinstate a privileged row.
export async function runWorkspaceInvite(
  argv: string[],
  deps: WorkspaceMemberDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so its value never lands in the email
  // positional, then thread it into loadWorkspaceConfig so the server authorizes
  // the target (BUG-3/BUG-4).
  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${WORKSPACE_INVITE_USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");
  const email = rest.find((a) => !a.startsWith("-"));
  if (!email) {
    err(`an email is required\n${WORKSPACE_INVITE_USAGE}`);
    return 2;
  }

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`workspace invite: ${(e as Error).message}`);
    return 2;
  }

  try {
    const res = await inviteMember(cfg, email, deps.http);
    // The invitee's primary path is the web join link: click it, sign in with
    // Google, land in the workspace. No CLI, no clone. The token is single-use
    // context; we build the link but never store it. Guard on joinToken so an
    // older control that does not mint one degrades to the legacy message.
    const joinUrl = res.joinToken
      ? `${getConsoleUrl(cfg)}/join/${res.joinToken}`
      : undefined;
    if (json) {
      out(JSON.stringify({ email: res.email, role: res.role, joinUrl }, null, 2));
      return 0;
    }
    out(`${res.email} is now a ${res.role} of workspace ${cfg.workspaceId}.`);
    if (joinUrl) {
      out(`Join link: ${joinUrl}`);
      out("Share this link so they can join by signing in with Google.");
    } else {
      out("They can run 'mla login' with this email to bind to it.");
    }
    return 0;
  } catch (e) {
    err(`workspace invite failed: ${serverMessage(e)}`);
    return 1;
  }
}

// `mla workspace members`: list the active members of the target workspace. Open
// to any active member (no owner/admin gate).
export async function runWorkspaceMembers(
  argv: string[],
  deps: WorkspaceMemberDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${WORKSPACE_MEMBERS_USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`workspace members: ${(e as Error).message}`);
    return 2;
  }

  try {
    const res = await listMembers(cfg, deps.http);
    if (json) {
      out(JSON.stringify(res.members, null, 2));
      return 0;
    }
    out(`Members of workspace ${cfg.workspaceId}:`);
    if (res.members.length === 0) {
      out("  (no active members)");
      return 0;
    }
    for (const m of res.members) {
      out(`  ${m.role.padEnd(6)}  ${m.email ?? "(no email)"}`);
    }
    return 0;
  } catch (e) {
    err(`workspace members failed: ${serverMessage(e)}`);
    return 1;
  }
}

// `mla workspace remove <email>`: revoke a MEMBER's access to the target
// workspace. Owner/admin only, MEMBER-only target (removing an owner/admin 409s;
// demote or transfer first). Idempotent: a missing / already-removed MEMBER
// reports "nothing to remove" and exits 0.
export async function runWorkspaceRemove(
  argv: string[],
  deps: WorkspaceMemberDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${WORKSPACE_REMOVE_USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");
  const email = rest.find((a) => !a.startsWith("-"));
  if (!email) {
    err(`an email is required\n${WORKSPACE_REMOVE_USAGE}`);
    return 2;
  }

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`workspace remove: ${(e as Error).message}`);
    return 2;
  }

  try {
    const res = await removeMember(cfg, email, deps.http);
    if (json) {
      out(JSON.stringify(res, null, 2));
      return 0;
    }
    if (res.removed) {
      out(`Removed ${res.email} from workspace ${cfg.workspaceId}.`);
    } else {
      out(
        `${res.email} was not an active member of workspace ${cfg.workspaceId}; ` +
          `nothing to remove.`,
      );
    }
    return 0;
  } catch (e) {
    err(`workspace remove failed: ${serverMessage(e)}`);
    return 1;
  }
}

// `mla workspace reactivate`: clear Workspace.retiredAt so a deactivated workspace
// rejoins the active switcher list. Owner/admin only (server-gated). Idempotent: an
// already-active workspace is a no-op. This is the CLI counterpart to the Console
// switcher's Reactivate button, and the recovery path for `mla deactivate` when the
// folder marker was already unbound (use `--workspace <id>` to target it by id).
// There is intentionally no `mla workspace deactivate`: retiring a workspace flows
// through `mla deactivate` (which also unbinds the folder), matching the two-verbs
// model (notes/20260710-mla-workspace-deactivate-retired-state.md §7.2).
export async function runWorkspaceReactivate(
  argv: string[],
  deps: WorkspaceLifecycleDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${WORKSPACE_REACTIVATE_USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");

  // Accept the workspace id as a positional (`mla workspace reactivate <id>`),
  // the natural syntax and the recovery path after `mla deactivate` unbinds the
  // folder marker (the retired id is no longer folder-resolvable, so it MUST be
  // passed by hand). `--workspace <id>` keeps working for consistency with the
  // other subcommands. Never silently ignore an extra positional: that would
  // no-op on the folder-bound workspace instead of the one the operator named.
  const positionals = rest.filter((a) => !a.startsWith("-"));
  if (positionals.length > 1) {
    err(`reactivate takes at most one workspace id\n${WORKSPACE_REACTIVATE_USAGE}`);
    return 2;
  }
  // Normalize an empty / whitespace-only `--workspace ""` to "absent" up front.
  // `??` would treat "" as a present value, skip the conflict guard, and (via
  // loadWorkspaceConfig's `(override||"").trim() || resolveWorkspaceId()`) fall
  // back to the folder-bound workspace: the exact silent-wrong-target bug this
  // command was fixed to prevent. A blank override reaching here (e.g. an unset
  // `--workspace "$VAR"` in a script) must defer to the positional, not win.
  const flagWorkspace = workspace && workspace.trim() ? workspace : undefined;
  if (flagWorkspace && positionals[0] && flagWorkspace !== positionals[0]) {
    err(
      `conflicting workspace ids: --workspace ${flagWorkspace} vs ${positionals[0]}\n` +
        WORKSPACE_REACTIVATE_USAGE,
    );
    return 2;
  }
  const target = flagWorkspace ?? positionals[0];

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(target);
  } catch (e) {
    err(`workspace reactivate: ${(e as Error).message}`);
    return 2;
  }

  try {
    const res = await reactivateWorkspace(cfg, deps.http);
    if (json) {
      out(JSON.stringify(res, null, 2));
      return 0;
    }
    out(
      `Workspace ${cfg.workspaceId} is active again; it rejoins the switcher list.`,
    );
    return 0;
  } catch (e) {
    err(`workspace reactivate failed: ${serverMessage(e)}`);
    return 1;
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
  if (sub === "invite") {
    return runWorkspaceInvite(argv.slice(1));
  }
  if (sub === "members") {
    return runWorkspaceMembers(argv.slice(1));
  }
  if (sub === "remove") {
    return runWorkspaceRemove(argv.slice(1));
  }
  if (sub === "reactivate") {
    return runWorkspaceReactivate(argv.slice(1));
  }
  console.error(
    `Unknown workspace subcommand: ${sub}. Usage: mla workspace ` +
      `[show | invite <email> | members | remove <email> | reactivate] ` +
      `(use 'mla activate' / 'mla deactivate' to change the folder binding).` +
      staleCommandHint(),
  );
  return 2;
}
