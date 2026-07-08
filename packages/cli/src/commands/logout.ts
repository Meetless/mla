import {
  CliConfig,
  configExists,
  readConfig,
  writeConfig,
} from "../lib/config";

// `mla logout` (proposal §6.6, §9 "Stale-access revoke", T25).
//
// Revokes the current user-token session server-side, then rewrites
// cli-config.json with `auth.mode: none`. Key invariants (§6.6 Patch 7):
//   - NEVER restores the prior shared-key value. `none` is the explicit terminal
//     state; the only way back to shared-key is `mla init --control-token <T>`.
//   - The local clear ALWAYS happens. A network failure, a 401, or a 410 from the
//     revoke endpoint all mean "the session is gone (or unreachable) server-side";
//     we treat every one as success and clear locally so the operator is never
//     stuck logged in against a dead/expired session.
//   - Sends the body proof `{ sessionId, refreshToken }` with NO Authorization
//     header: the access token may already be expired (that is the whole point of
//     proof-of-possession), so the refresh token is the credential. NEVER logged.
//   - No `--all` flag (v1.2): killing every session for a user is a Console admin
//     action, not a CLI primitive.

export interface RevokeResult {
  // true when control confirmed the revoke (200) OR reported the session already
  // gone (401/410). false when control was unreachable or returned an unexpected
  // status: we still clear locally, but warn the session may linger server-side.
  serverCleared: boolean;
  detail: string; // human-readable, carries NO secret
}

// Raw fetch to the guardless revoke route. Deliberately bypasses http.ts's
// doFetch (which always stamps an Authorization header): the refresh token in the
// body is the proof, and we send no bearer because the access token may be dead.
// Never throws: a network failure becomes a non-cleared result so the caller can
// still clear local state.
export async function revokeCliSession(
  controlUrl: string,
  sessionId: string,
  refreshToken: string,
  timeoutMs = 10000,
): Promise<RevokeResult> {
  const url = `${controlUrl.replace(/\/+$/, "")}/internal/v1/auth/sessions/revoke`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      // Content-Type only; NO Authorization header (body proof-of-possession).
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, refreshToken }),
      signal: controller.signal,
    });
    if (res.ok) return { serverCleared: true, detail: "session revoked" };
    if (res.status === 401 || res.status === 410) {
      return {
        serverCleared: true,
        detail: "session was already revoked server-side",
      };
    }
    return { serverCleared: false, detail: `control returned HTTP ${res.status}` };
  } catch (e) {
    // Timeout / DNS / connection refused: do not block the local clear.
    return {
      serverCleared: false,
      detail: `control unreachable (${(e as Error).name})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface LogoutDeps {
  log?: (msg: string) => void;
  revokeFn?: (
    controlUrl: string,
    sessionId: string,
    refreshToken: string,
  ) => Promise<RevokeResult>;
}

export async function runLogout(
  argv: string[],
  deps: LogoutDeps = {},
): Promise<number> {
  if (argv.length > 0) {
    console.error(
      `\`mla logout\` takes no arguments (got: ${argv.join(" ")}). ` +
        "There is no --all flag; revoke other sessions from the Console.",
    );
    return 2;
  }

  const log = deps.log ?? ((m: string) => console.log(m));
  const revokeFn = deps.revokeFn ?? revokeCliSession;

  if (!configExists()) {
    // Nothing to log out of, and nothing to write. Idempotent success.
    log("Not logged in (no cli-config.json). Nothing to do.");
    return 0;
  }

  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    // A corrupt/conflicting config can't be safely rewritten here; surface it.
    console.error((e as Error).message);
    return 1;
  }

  if (cfg.auth.mode !== "user-token") {
    // shared-key or none: there is no user session to revoke. We deliberately do
    // NOT touch a shared-key config (logout is not "downgrade my shared key");
    // the operator manages that via `mla init`.
    if (cfg.auth.mode === "shared-key") {
      log("Logged in with a shared key, not a user session; nothing to revoke.");
      log("To remove it, edit cli-config.json or re-run `mla init`.");
    } else {
      log("Already logged out (auth.mode: none).");
    }
    return 0;
  }

  const { sessionId, refreshToken } = cfg.auth;
  const who = cfg.auth.user.displayName || cfg.auth.user.id;

  // Best-effort server revoke. Missing sessionId/refreshToken (corrupt session)
  // skips the network call and goes straight to local clear.
  if (sessionId && refreshToken) {
    const result = await revokeFn(cfg.controlUrl, sessionId, refreshToken);
    if (result.serverCleared) {
      log(`Revoked: ${result.detail}.`);
    } else {
      log(`Local logout complete, but ${result.detail}.`);
      log("The session may still be active server-side until it expires.");
    }
  } else {
    log("Local session was incomplete; clearing it without a server revoke.");
  }

  // Clear auth.* to the terminal `none` state. NEVER restore shared-key (§6.6).
  // Top-level controlUrl/intelUrl/mlaPath/etc. survive so the next
  // `mla init --control-token` or `mla login` runs cleanly. writeConfig
  // re-derives controlToken ("") and drops actorUserId under none.
  writeConfig({
    ...cfg,
    auth: { mode: "none" },
    controlToken: "",
    actorUserId: undefined,
  });

  log(`Logged out ${who}. Run \`mla login\` to log back in.`);
  return 0;
}
