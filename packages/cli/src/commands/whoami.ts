import { CliConfig, configExists, readConfig } from "../lib/config";
import { get, HttpError } from "../lib/http";

// `mla whoami` (proposal §6.6, §4.1, T26).
//
// Prints the identity behind the current cli-config.json. Three modes, three
// behaviours (the CliAuth union is three-variant, §0.01 clause 3):
//   - user-token: GET /internal/v1/auth/me with the current access token
//     (Authorization: Bearer only, no token-in-query). Control reads the live
//     WorkspaceUser + Session, so a role change or revoke surfaces here, not
//     from the cli-config cache. Goes through http.ts `get`, so once T27 lands
//     it transparently auto-refreshes a near-expired access token.
//   - shared-key: prints `auth.mode: shared-key` + the cached workspaceId. Does
//     NOT call /auth/me: a shared key carries no user identity.
//   - none: prints "not configured", exits 1 with a hint to log in.
//
// SECURITY: never prints the access token, refresh token, or any bearer. Only
// identity (user / email / workspace / role) and non-secret expiry timestamps.

// /auth/me response (control auth.service.ts getMe). We deliberately type only
// the fields we render; control may carry more (avatarUrl, canCreateDiff) that
// `mla whoami` has no reason to surface.
interface MeResponse {
  mode: "cli-session" | "shared-key";
  user?: {
    id: string;
    displayName: string;
    email: string | null;
    role: string;
  };
  workspace?: {
    id: string;
    name: string;
    slug: string;
  };
  sessionId?: string;
  accessExpiresAt?: string | null;
  refreshExpiresAt?: string | null;
}

// Best-effort humanizer for an ISO expiry. Mirrors login.ts formatRemaining:
// null for an unparseable/absent timestamp so callers degrade gracefully.
function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 48) return `in ~${hours}h`;
  return `in ~${Math.floor(hours / 24)}d`;
}

export interface WhoamiDeps {
  log?: (msg: string) => void;
  // Injectable seam: defaults to the real control call. Specs pass a stub so the
  // command is exercised without a live server.
  getMeFn?: (cfg: CliConfig) => Promise<MeResponse>;
}

export async function runWhoami(
  argv: string[],
  deps: WhoamiDeps = {},
): Promise<number> {
  if (argv.length > 0) {
    console.error(
      `\`mla whoami\` takes no arguments (got: ${argv.join(" ")}).`,
    );
    return 2;
  }

  const log = deps.log ?? ((m: string) => console.log(m));
  const getMeFn =
    deps.getMeFn ?? ((cfg: CliConfig) => get<MeResponse>(cfg, "/internal/v1/auth/me"));

  // `auth.mode: none` is also the shape of a box that never ran `mla init`.
  if (!configExists()) {
    log("Not configured (no cli-config.json).");
    log("Run `mla init --control-token <T>` or `mla login` to get started.");
    return 1;
  }

  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  if (cfg.auth.mode === "none") {
    log("Not configured (auth.mode: none).");
    log("Run `mla init --control-token <T>` or `mla login` to log in.");
    return 1;
  }

  if (cfg.auth.mode === "shared-key") {
    // A shared key authenticates AS the workspace's internal key; there is no
    // user behind it. Print the mode + the folder/config workspace without a
    // network call (the §6.6 contract: "does NOT call /auth/me").
    log("auth.mode: shared-key (no user identity)");
    log(`  Control:   ${cfg.controlUrl}`);
    if (cfg.workspaceId) {
      log(`  Workspace: ${cfg.workspaceId} (from cli-config.json)`);
    } else {
      log("  Workspace: resolved per-folder from .meetless.json (run `mla workspace`)");
    }
    return 0;
  }

  // user-token: resolve live identity from control.
  let me: MeResponse;
  try {
    me = await getMeFn(cfg);
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 401) {
      // After T27's auto-refresh has tried and failed, a 401 means the session
      // is gone (expired or revoked). Point the operator at re-login.
      console.error("Your CLI session has expired or was revoked. Run `mla login`.");
      return 1;
    }
    // Network failure, control down, or unexpected status. The cached identity
    // is still useful, so print it with a clear "could not reach control" note
    // rather than failing blind.
    console.error(`Could not reach control to verify the session (${err.message}).`);
    const who = cfg.auth.user.displayName || cfg.auth.user.id;
    const email = cfg.auth.user.email ? ` <${cfg.auth.user.email}>` : "";
    log(`Cached identity: ${who}${email} (role ${cfg.auth.user.role}, unverified).`);
    return 1;
  }

  if (me.mode === "shared-key" || !me.user) {
    // Should not happen for a user-token bearer, but stay honest if control
    // reports shared-key (e.g. the token happened to equal INTERNAL_API_KEY).
    log("auth.mode: shared-key (no user identity)");
    return 0;
  }

  const email = me.user.email ? ` <${me.user.email}>` : "";
  log(`Logged in as ${me.user.displayName}${email}.`);
  log(`  User:      ${me.user.id}`);
  log(`  Role:      ${me.user.role}`);
  if (me.workspace) {
    log(`  Workspace: ${me.workspace.name} (${me.workspace.slug})`);
  }
  if (me.sessionId) {
    log(`  Session:   ${me.sessionId}`);
  }
  log(`  Access token expires ${formatExpiry(me.accessExpiresAt)}.`);
  log(`  Refresh token expires ${formatExpiry(me.refreshExpiresAt)}.`);
  return 0;
}
