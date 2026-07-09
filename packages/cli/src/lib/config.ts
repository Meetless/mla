import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveWorkspaceId } from "./workspace";

// Every config/auth-load failure is the operator's to fix (run `mla init`,
// `mla login`, unset an env var, populate a field), NEVER an internal mla fault.
// A stable, PII-safe `name` lets the message-blind outcome classifier
// (analytics/command-event.classifyOutcome) bucket these as `user_error` and,
// critically, keep the "file a bug report" nudge (isReportableFault) silent for
// them. config.ts is the single chokepoint for config/auth loading, so stamping
// the marker here covers the whole surface at its source rather than per command.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Credential state of the CLI, as a single nested discriminated union (§6.4,
// §0.01 clause 3). This REPLACES the old habit of piling credential fields onto
// the top level of CliConfig. New auth modes land as new variants here, never as
// new sibling fields on CliConfig (the hard rule that locks the surface).
export type CliAuth =
  | {
      // Post-logout / pre-login terminal state. Written by `mla logout` (§6.6)
      // and the external-pilot bootstrap (§10.1); carries NO credential. Every
      // control/intel call in this mode fails fast with "not logged in" (http.ts).
      mode: "none";
    }
  | {
      // The legacy shared bearer that doubles as intel's INTERNAL_API_KEY. Kept
      // forever for scripted/CI installs and `mla init --control-token <T>`.
      mode: "shared-key";
      accessToken: string;
    }
  | {
      // Browser-login user session (`mla login`). The accessToken is the correct
      // bearer for BOTH control and intel (intel validates it via control, §7).
      mode: "user-token";
      accessToken: string; // ~24h CLI access token
      refreshToken: string; // ~30d CLI refresh token (sliding; resets on each rotation)
      accessExpiresAt: string; // ISO 8601
      refreshExpiresAt: string; // ISO 8601
      sessionId: string; // for `mla logout` + audit correlation
      user: {
        id: string;
        displayName: string;
        email: string | null;
        role: string; // display-only (mla whoami); NEVER an authz input (§4.6)
      };
    };

// Self-upgrade preferences (proposal section 5.6). Non-credential. The default
// is auto-apply ON ("on by default, easy opt-out", the fork An locked in §3/§5.6):
// a curl install stages the newer binary in the background and promotes it at the
// next launch with zero ceremony. Only an explicit `autoApply: false` opts back
// out to nag-only. The whole self-replace path is additionally hard-gated to the
// curl install method downstream (update-notifier stage + upgrade-apply promote),
// so this default is inert for brew/npm/unknown installs no matter what it says.
// Env opt-outs (MLA_DISABLE_UPGRADE / MLA_DISABLE_AUTO_UPGRADE /
// MLA_NO_UPDATE_NOTIFIER) always override this on the more-restrictive side; see
// resolveAutoApply.
export interface UpdateConfig {
  autoApply: boolean; // default true: auto-apply on launch (curl-gated downstream)
  channel: string; // default "stable"
}

export interface CliConfig {
  controlUrl: string;
  // DERIVED, read-only projection of `auth` (= auth.accessToken, or "" when
  // auth.mode === 'none'). It is NEVER written to disk: writeConfig serializes
  // only the nested `auth`. It exists so every existing reader (http.ts,
  // observability flush, ask.ts, doctor) and the shell hooks keep working
  // unchanged through the auth.* migration. New code branches on `auth`.
  controlToken: string;
  intelUrl?: string;
  // DEPRECATED as a workspace source (folder = workspace, T1.1). cli-config no
  // longer carries the per-folder workspace binding; the workspaceId is resolved
  // from the nearest `.meetless.json` marker via the shared resolver. Kept
  // optional so a stale field on an old config is tolerated (ignored), not a
  // crash. Workspace-scoped commands obtain the id through loadWorkspaceConfig /
  // readKbConfig, never by reading this field.
  workspaceId?: string;
  mlaPath: string;
  // Absolute path to the intel service checkout (sibling of the meetless repo).
  // Optional: `mla session remember` shells out to `poetry run python
  // tools/remember.py` from here. When unset, it is derived from the mla repo
  // location (../intel) or MEETLESS_INTEL_ROOT. Never required by readConfig.
  intelRoot?: string;
  // Console base URL used by `mla review` to emit deep links. Trailing slash
  // is stripped at read time. Default is a generic localhost dev console;
  // override via cli-config.json or the MEETLESS_CONSOLE_URL env var to point
  // at your own console deployment.
  consoleUrl?: string;
  // Workspace user id this CLI invocation acts as. Required for KB curation
  // commands (§9.1) so every outbox event carries an audited actor. Optional
  // on this interface for backwards compatibility with pre-curation
  // cli-config.json files; readKbConfig() enforces presence at command time.
  // Operator identity, NOT a credential (P3): the one permitted top-level
  // non-secret field. Under auth.mode === 'user-token' it is pinned to
  // auth.user.id so X-Meetless-Actor and the authenticated session never disagree.
  actorUserId?: string;
  // Self-upgrade preferences (proposal section 5.6). Optional and omitted when
  // absent so a config that predates the field is tolerated and a write does not
  // bloat the file with defaults. readUpdateConfig() reads this throw-free for
  // the upgrade hot path; readConfig attaches it when present so a hand-set
  // value survives the next login/refresh rewrite.
  update?: UpdateConfig;
  // Canonical credential state. readConfig ALWAYS populates this (never
  // undefined); the three on-disk shapes are normalized here by the compat shim.
  auth: CliAuth;
}

// Hosted prod defaults. A freshly-installed `mla` reaches the Meetless
// production backend out of the box with zero flags. Override to staging or
// local with the MEETLESS_BACKEND_URL / MEETLESS_INTEL_URL / MEETLESS_CONSOLE_URL
// env vars (or the matching cli-config.json fields), which always win over these.
export const DEFAULT_CONTROL_URL = "https://control.meetless.ai";
export const DEFAULT_INTEL_URL = "https://intel.meetless.ai";
export const DEFAULT_CONSOLE_URL = "https://app.meetless.ai";

// Strip trailing slash so callers can always concatenate `${base}/relationships/<id>`
// without producing a `//` in the URL.
export function getConsoleUrl(cfg: CliConfig): string {
  const raw = process.env.MEETLESS_CONSOLE_URL || cfg.consoleUrl || DEFAULT_CONSOLE_URL;
  return raw.replace(/\/+$/, "");
}

export const HOME = process.env.MEETLESS_HOME || path.join(os.homedir(), ".meetless");
export const CFG_PATH = path.join(HOME, "cli-config.json");
export const QUEUE_DIR = path.join(HOME, "queue");
export const HOOKS_DIR = path.join(HOME, "hooks");
// Per-session OFF sentinels (`<sid>.off`) written by `mla mute` (removed by
// `mla unmute`) and read by meetless_session_disabled in common.sh. This is the
// per-session capture lifecycle, distinct from the `.meetless.json` workspace
// binding that `mla activate` / `mla deactivate` manage. Must match
// SESSION_GATE_DIR in common.sh.
export const SESSION_GATE_DIR = path.join(HOME, "session-gate");

// The master telemetry kill switch. The single source of truth for "no telemetry
// of any kind leaves (or, for the local deadletter, is even recorded on) this
// machine." It lives here in low-level config (not in observability.ts) so the
// trace plane, the analytics-consent gate, the debug command, AND the
// failure-telemetry deadletter can all share it without an import cycle.
// observability.ts re-exports it for back-compat. MEETLESS_TELEMETRY in
// {off,0,false,no} hard-disables; a truthy MEETLESS_NO_TELEMETRY does the same.
// An unset MEETLESS_TELEMETRY is NOT disabled here: per-plane opt-IN (analytics
// forwarding) is enforced at the forwarding sites, not by this hard switch.
export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const t = (env.MEETLESS_TELEMETRY || "").trim().toLowerCase();
  if (t === "off" || t === "0" || t === "false" || t === "no") return true;
  const no = (env.MEETLESS_NO_TELEMETRY || "").trim().toLowerCase();
  if (no && no !== "0" && no !== "false" && no !== "no") return true;
  return false;
}

// The loose on-disk shape readConfig parses before normalization. It is a union
// of the new nested form and the two legacy top-level forms the compat shim
// (§6.4) must accept. Everything is optional/unknown until normalized.
interface RawDiskConfig {
  controlUrl?: string;
  intelUrl?: string;
  workspaceId?: string;
  mlaPath?: string;
  intelRoot?: string;
  consoleUrl?: string;
  actorUserId?: string;
  update?: unknown;
  auth?: unknown;
  // Legacy top-level credential fields (pre-nested-auth). Tolerated on read,
  // never written back.
  controlToken?: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  sessionId?: string;
  authMode?: string;
  user?: {
    id?: string;
    displayName?: string;
    email?: string | null;
    role?: string;
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Normalize the optional on-disk `update` object into a UpdateConfig, or
// undefined when absent/empty so OnDiskConfig omits it (no defaults written to
// disk). autoApply now DEFAULTS ON: an absent field means auto-apply, and only an
// explicit boolean `false` opts back out to nag-only. We track "was the field
// explicitly present" separately from its value so an explicit `false` survives
// (it must be persisted and honored), while a bare `{}` still returns undefined
// and falls through to the readUpdateConfig default rather than being written back.
// channel falls back to "stable".
function normalizeUpdate(value: unknown): UpdateConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const channel = asString(o.channel);
  const hasAutoApply = typeof o.autoApply === "boolean";
  const autoApply = o.autoApply !== false; // absent or true -> true; only explicit false opts out
  // Nothing meaningful set (no channel, no explicit autoApply): leave it to the
  // default via the undefined return; do not persist a bare `{}`.
  if (!hasAutoApply && !channel) return undefined;
  return { autoApply, channel: channel ?? "stable" };
}

// Normalize a parsed user-token-shaped object (either `auth: {mode:'user-token'}`
// or a legacy expanded top-level) into the CliAuth user-token variant. Throws if
// the access token is absent: a user-token config with no bearer is corrupt and
// must fail loud, not silently degrade.
function normalizeUserToken(src: {
  accessToken?: unknown;
  refreshToken?: unknown;
  accessExpiresAt?: unknown;
  refreshExpiresAt?: unknown;
  sessionId?: unknown;
  user?: { id?: unknown; displayName?: unknown; email?: unknown; role?: unknown };
}): Extract<CliAuth, { mode: "user-token" }> {
  const accessToken = asString(src.accessToken);
  if (!accessToken) {
    throw new ConfigError(
      `cli-config.json at ${CFG_PATH} has auth.mode 'user-token' but no access token. ` +
        "The login is corrupt. Run `mla logout` then `mla login`, or " +
        "`mla init --control-token <T>` to fall back to shared-key.",
    );
  }
  const user = src.user ?? {};
  return {
    mode: "user-token",
    accessToken,
    refreshToken: asString(src.refreshToken) ?? "",
    accessExpiresAt: asString(src.accessExpiresAt) ?? "",
    refreshExpiresAt: asString(src.refreshExpiresAt) ?? "",
    sessionId: asString(src.sessionId) ?? "",
    user: {
      id: asString(user.id) ?? "",
      displayName: asString(user.displayName) ?? "",
      email: typeof user.email === "string" ? user.email : null,
      role: asString(user.role) ?? "",
    },
  };
}

// The §6.4 compat shim: collapse the three accepted on-disk shapes into one
// CliAuth. (1) new nested `auth`; (2) legacy shared-key (top-level controlToken,
// no refresh); (3) legacy expanded user-token (top-level controlToken + refresh
// + authMode==='user-token'); absent everything => 'none'.
function normalizeAuthFromDisk(cfg: RawDiskConfig): CliAuth {
  // (1) New nested shape wins when present and well-formed.
  if (cfg.auth !== null && typeof cfg.auth === "object") {
    const a = cfg.auth as { mode?: unknown } & Record<string, unknown>;
    if (a.mode === "none") return { mode: "none" };
    if (a.mode === "shared-key") {
      const accessToken = asString(a.accessToken);
      if (accessToken) return { mode: "shared-key", accessToken };
      // shared-key with no token is meaningless; treat as logged out.
      return { mode: "none" };
    }
    if (a.mode === "user-token") {
      return normalizeUserToken(
        a as Parameters<typeof normalizeUserToken>[0],
      );
    }
    // Unknown mode: fail loud rather than guess a credential path.
    throw new ConfigError(
      `cli-config.json at ${CFG_PATH} has an unrecognized auth.mode. ` +
        "Run `mla logout` then `mla login`, or `mla init --control-token <T>`.",
    );
  }
  // (2)/(3) Legacy top-level controlToken.
  const legacyToken = asString(cfg.controlToken);
  if (legacyToken) {
    if (asString(cfg.refreshToken) && cfg.authMode === "user-token") {
      return normalizeUserToken({ ...cfg, accessToken: legacyToken });
    }
    return { mode: "shared-key", accessToken: legacyToken };
  }
  // Nothing on disk => terminal logged-out state.
  return { mode: "none" };
}

export function readConfig(): CliConfig {
  if (!fs.existsSync(CFG_PATH)) {
    throw new ConfigError(
      `cli-config.json not found at ${CFG_PATH}. Run 'mla init' first.`,
    );
  }
  const raw = fs.readFileSync(CFG_PATH, "utf8");
  let cfg: RawDiskConfig;
  try {
    cfg = JSON.parse(raw) as RawDiskConfig;
  } catch {
    // A malformed cli-config.json is the operator's to fix (re-init or edit),
    // not an internal fault. Wrap the raw SyntaxError so it stays out of the
    // bug-report nudge, same as every other config-load failure.
    throw new ConfigError(
      `cli-config.json at ${CFG_PATH} is not valid JSON. ` +
        "Fix it, or run `mla init --control-token <T>` / `mla login` to rewrite it.",
    );
  }

  // Non-credential env aliases select WHICH control plane, not WHO you are, so
  // they are honored in every auth mode (CI / containers). MEETLESS_INTEL_ROOT
  // is handled separately in the intel-root resolver.
  const controlUrl =
    process.env.MEETLESS_BACKEND_URL || cfg.controlUrl || DEFAULT_CONTROL_URL;
  const intelUrl =
    process.env.MEETLESS_INTEL_URL || cfg.intelUrl || DEFAULT_INTEL_URL;

  const diskAuth = normalizeAuthFromDisk(cfg);

  // §0.01 clause 4 / Finding H: under an on-disk user-token, MEETLESS_CONTROL_TOKEN
  // is REJECTED loudly, never silently honored. Falling back to shared-key here
  // would mis-attribute the operator's audited actions to INTERNAL_API_KEY.
  const envSharedKey = process.env.MEETLESS_CONTROL_TOKEN;
  let auth: CliAuth;
  if (diskAuth.mode === "user-token" && envSharedKey) {
    throw new ConfigError(
      `MEETLESS_CONTROL_TOKEN is set but you are logged in as ${diskAuth.user.displayName}.\n` +
        "Unset it (`unset MEETLESS_CONTROL_TOKEN`) or run `mla logout` first.",
    );
  } else if (envSharedKey) {
    // Env-driven shared key overrides a shared-key / none on-disk state (the
    // documented CI / container path). It never silently overrides user-token
    // (handled above).
    auth = { mode: "shared-key", accessToken: envSharedKey };
  } else {
    auth = diskAuth;
  }

  // workspaceId is intentionally NOT resolved here (folder = workspace, T1.1);
  // loadWorkspaceConfig / readKbConfig add it from the `.meetless.json` marker.
  // controlUrl/intelUrl always resolve (hosted prod default is the final
  // fallback above), so there is no missing-config branch to guard here.

  // actorUserId: pinned to auth.user.id under user-token (P3, so the actor
  // header and session identity can never disagree); otherwise the preserved
  // top-level value (migrated across the rewrite, Finding G).
  const actorUserId =
    auth.mode === "user-token" ? auth.user.id : asString(cfg.actorUserId);

  // Derived controlToken: the bearer for shared-key / user-token; empty for
  // 'none' (a none-mode request fails fast at the http layer, §6.5).
  const controlToken = auth.mode === "none" ? "" : auth.accessToken;

  return {
    controlUrl,
    controlToken,
    intelUrl,
    mlaPath: cfg.mlaPath || "",
    intelRoot: cfg.intelRoot,
    consoleUrl: cfg.consoleUrl,
    actorUserId,
    update: normalizeUpdate(cfg.update),
    auth,
  };
}

// A CliConfig with the per-folder workspace binding resolved and guaranteed
// present. Workspace-scoped commands take this shape so `cfg.workspaceId` is a
// non-optional string at the call site without per-site `!` assertions.
export type WorkspaceCliConfig = CliConfig & { workspaceId: string };

// Load the machine config AND resolve the active workspace from the nearest
// `.meetless.json` marker (folder = workspace, T1.1). This is the single entry
// point every workspace-scoped command uses instead of readConfig(): it threads
// the marker-resolved id onto cfg.workspaceId so existing `cfg.workspaceId`
// call sites keep working, now sourced from the marker rather than cli-config.
//
// `override` is the admin `--workspace <id>` escape hatch (KB ops against
// another workspace): when provided and non-empty it short-circuits marker
// resolution, so the command never throws NotActivatedError just because the
// operator is acting cross-workspace from an unbound directory. When absent,
// resolveWorkspaceId() walks up from cwd and throws a clean "not activated"
// error if no marker is found.
export function loadWorkspaceConfig(override?: string): WorkspaceCliConfig {
  const cfg = readConfig();
  const workspaceId = (override || "").trim() || resolveWorkspaceId();
  return { ...cfg, workspaceId };
}

// Stricter loader used by KB curation commands (§9.1, §9.4). All KB writes
// stamp `actorUserId` into the outbox event so the audit trail is complete;
// missing the field is a hard fail with a hint to populate it. The hint
// names BOTH `mla init` (sets it for new configs) and direct cli-config.json
// editing for operators who set up before the field landed; there is no
// `mla auth` subcommand by design (§9.4).
export interface KbCliConfig extends WorkspaceCliConfig {
  actorUserId: string;
}

// KB curation loader: resolves the workspace from the marker (via
// loadWorkspaceConfig, honoring the optional `--workspace` admin override) AND
// enforces an actorUserId. `workspaceId` is therefore marker-sourced just like
// every other workspace-scoped command; cli-config is never consulted for it.
export function readKbConfig(override?: string): KbCliConfig {
  const cfg = loadWorkspaceConfig(override);
  const actor = (cfg.actorUserId || "").trim();
  if (!actor) {
    throw new ConfigError(
      `cli-config.json is missing required field 'actorUserId'. ` +
        `KB curation commands stamp this onto every outbox event so the ` +
        `audit trail records who acted. Re-run 'mla init --actor <id>' ` +
        `or edit ${CFG_PATH} directly to add it.`,
    );
  }
  return { ...cfg, actorUserId: actor };
}

// The exact on-disk JSON shape. Credentials live ONLY under nested `auth`; the
// derived top-level `controlToken` projection is never persisted (§6.4). Optional
// fields are omitted when empty so the file stays minimal and a legacy reader
// never sees a null it cannot parse.
interface OnDiskConfig {
  controlUrl: string;
  intelUrl?: string;
  workspaceId?: string;
  mlaPath: string;
  intelRoot?: string;
  consoleUrl?: string;
  actorUserId?: string;
  update?: UpdateConfig;
  auth: CliAuth;
}

export function writeConfig(cfg: CliConfig): void {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.mkdirSync(HOOKS_DIR, { recursive: true });

  // P3: under a user session the actor is the authenticated user, full stop, so
  // it can never drift from auth.user.id even if a caller passed a stale value.
  const actorUserId =
    cfg.auth.mode === "user-token" ? cfg.auth.user.id : cfg.actorUserId;

  // Serialize ONLY the canonical fields. `controlToken` is intentionally dropped:
  // it is a read-time projection of auth.accessToken, persisting it would create
  // two sources of truth that can silently diverge on the next login/refresh.
  const onDisk: OnDiskConfig = {
    controlUrl: cfg.controlUrl,
    ...(cfg.intelUrl ? { intelUrl: cfg.intelUrl } : {}),
    ...(cfg.workspaceId ? { workspaceId: cfg.workspaceId } : {}),
    mlaPath: cfg.mlaPath,
    ...(cfg.intelRoot ? { intelRoot: cfg.intelRoot } : {}),
    ...(cfg.consoleUrl ? { consoleUrl: cfg.consoleUrl } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(cfg.update ? { update: cfg.update } : {}),
    auth: cfg.auth,
  };

  fs.writeFileSync(CFG_PATH, JSON.stringify(onDisk, null, 2) + "\n", { mode: 0o600 });
  // The `mode` option above is honored ONLY when writeFileSync CREATES the file;
  // on an overwrite (every token refresh / re-login / workspace switch) it is a
  // no-op, so a config that was ever created loose (older CLI, permissive umask)
  // would stay loose forever. Re-assert 0600 explicitly on every write so the
  // token file is always owner-only, regardless of how it first landed.
  fs.chmodSync(CFG_PATH, 0o600);
}

export function configExists(): boolean {
  return fs.existsSync(CFG_PATH);
}

// Throw-free reader for the self-upgrade hot path. The upgrade machinery (the
// apply-on-launch promote step and `mla upgrade`) can run BEFORE `mla init`
// exists, so it must never throw the "run mla init first" error readConfig
// raises on a missing file. Returns auto-apply-on defaults (autoApply true,
// channel "stable") on a missing/corrupt/empty config, matching the §5.6 "on by
// default" fork; only an explicit on-disk `update.autoApply: false` opts out. The
// self-replace itself is still curl-gated downstream, so this default is inert
// for brew/npm/unknown installs.
export function readUpdateConfig(): UpdateConfig {
  const fallback: UpdateConfig = { autoApply: true, channel: "stable" };
  try {
    if (!fs.existsSync(CFG_PATH)) return fallback;
    const raw = JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) as RawDiskConfig;
    return normalizeUpdate(raw.update) ?? fallback;
  } catch {
    return fallback;
  }
}
