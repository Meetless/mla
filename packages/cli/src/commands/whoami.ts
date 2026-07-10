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
  // `--json` (BUG-6 Issue 2): every terminal branch emits a single parseable
  // object to stdout instead of the human lines, so an operator can lift the
  // workspace CUID (and identity) into `--workspace <id>` or a script without
  // scraping formatted text. It is the ONLY accepted argument; anything else is
  // still a usage error (exit 2) so a typo never silently succeeds.
  const jsonMode = argv.includes("--json");
  const stray = argv.filter((a) => a !== "--json");
  if (stray.length > 0) {
    console.error(
      `\`mla whoami\` takes no arguments except --json (got: ${stray.join(" ")}).`,
    );
    return 2;
  }

  const log = deps.log ?? ((m: string) => console.log(m));
  const getMeFn =
    deps.getMeFn ?? ((cfg: CliConfig) => get<MeResponse>(cfg, "/internal/v1/auth/me"));

  // Emit the human lines OR the JSON object for a non-error branch. Error
  // branches route the human copy to stderr and are handled inline.
  const emit = (human: string[], json: unknown): void => {
    if (jsonMode) log(JSON.stringify(json, null, 2));
    else for (const line of human) log(line);
  };

  // `auth.mode: none` is also the shape of a box that never ran `mla init`.
  if (!configExists()) {
    emit(
      [
        "Not configured (no cli-config.json).",
        "Run `mla init --control-token <T>` or `mla login` to get started.",
      ],
      { configured: false, reason: "no-cli-config" },
    );
    return 1;
  }

  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    if (jsonMode) log(JSON.stringify({ configured: false, error: (e as Error).message }, null, 2));
    else console.error((e as Error).message);
    return 1;
  }

  if (cfg.auth.mode === "none") {
    emit(
      [
        "Not configured (auth.mode: none).",
        "Run `mla init --control-token <T>` or `mla login` to log in.",
      ],
      { configured: false, authMode: "none" },
    );
    return 1;
  }

  if (cfg.auth.mode === "shared-key") {
    // A shared key authenticates AS the workspace's internal key; there is no
    // user behind it. Print the mode + the folder/config workspace without a
    // network call (the §6.6 contract: "does NOT call /auth/me").
    emit(
      [
        "auth.mode: shared-key (no user identity)",
        `  Control:   ${cfg.controlUrl}`,
        cfg.workspaceId
          ? `  Workspace: ${cfg.workspaceId} (from cli-config.json)`
          : "  Workspace: resolved per-folder from .meetless.json (run `mla workspace`)",
      ],
      {
        authMode: "shared-key",
        control: cfg.controlUrl,
        workspace: cfg.workspaceId ? { id: cfg.workspaceId } : null,
      },
    );
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
      if (jsonMode) log(JSON.stringify({ authMode: "user-token", error: "session-expired" }, null, 2));
      else console.error("Your CLI session has expired or was revoked. Run `mla login`.");
      return 1;
    }
    // Network failure, control down, or unexpected status. The cached identity
    // is still useful, so print it with a clear "could not reach control" note
    // rather than failing blind.
    if (jsonMode) {
      log(
        JSON.stringify(
          {
            authMode: "user-token",
            error: "control-unreachable",
            detail: err.message,
            cachedIdentity: {
              id: cfg.auth.user.id,
              displayName: cfg.auth.user.displayName,
              email: cfg.auth.user.email ?? null,
              role: cfg.auth.user.role,
              verified: false,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`Could not reach control to verify the session (${err.message}).`);
      const who = cfg.auth.user.displayName || cfg.auth.user.id;
      const email = cfg.auth.user.email ? ` <${cfg.auth.user.email}>` : "";
      log(`Cached identity: ${who}${email} (role ${cfg.auth.user.role}, unverified).`);
    }
    return 1;
  }

  if (me.mode === "shared-key" || !me.user) {
    // Should not happen for a user-token bearer, but stay honest if control
    // reports shared-key (e.g. the token happened to equal INTERNAL_API_KEY).
    emit(["auth.mode: shared-key (no user identity)"], { authMode: "shared-key" });
    return 0;
  }

  const email = me.user.email ? ` <${me.user.email}>` : "";
  const human = [
    `Logged in as ${me.user.displayName}${email}.`,
    `  User:      ${me.user.id}`,
    `  Role:      ${me.user.role}`,
  ];
  if (me.workspace) {
    human.push(`  Workspace: ${me.workspace.name} (${me.workspace.slug})`);
    // The workspace CUID is what `--workspace <id>` wants (BUG-6 Issue 2); the
    // slug is human-facing and not accepted by the admin override.
    human.push(`  Workspace ID: ${me.workspace.id}`);
  }
  if (me.sessionId) {
    human.push(`  Session:   ${me.sessionId}`);
  }
  human.push(`  Access token expires ${formatExpiry(me.accessExpiresAt)}.`);
  human.push(`  Refresh token expires ${formatExpiry(me.refreshExpiresAt)}.`);
  emit(human, {
    authMode: "user-token",
    user: {
      id: me.user.id,
      displayName: me.user.displayName,
      email: me.user.email ?? null,
      role: me.user.role,
    },
    workspace: me.workspace
      ? { id: me.workspace.id, name: me.workspace.name, slug: me.workspace.slug }
      : null,
    sessionId: me.sessionId ?? null,
    accessExpiresAt: me.accessExpiresAt ?? null,
    refreshExpiresAt: me.refreshExpiresAt ?? null,
  });
  return 0;
}
