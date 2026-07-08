import * as fs from "fs";
import {
  CFG_PATH,
  CliAuth,
  CliConfig,
  DEFAULT_CONTROL_URL,
  DEFAULT_INTEL_URL,
  QUEUE_DIR,
  configExists,
  readConfig,
  writeConfig,
} from "../lib/config";
import { printWireResult, resolveMlaPath, runWire } from "../lib/wire";

// `mla init` (§3 hour 6, §4.9, Correction 7, Correction 11, PRD §17.1)
//
// First-time setup AND idempotent re-configuration. Writes
// ~/.meetless/cli-config.json with absolute mlaPath, then calls the
// shared runWire() to copy hook scripts, register Claude Code hooks,
// install the /mla skill, and ensure `flock` is present.
//
// Contract:
//   - First run (no cli-config.json): --control-token is REQUIRED.
//   - Re-run (cli-config.json exists): every flag is OPTIONAL. Unset
//     flags inherit from the existing config (token rotation works by
//     passing --control-token on a re-run; other fields update the same
//     way).
//   - Always idempotent; safe to run any number of times.
//
// For "the binary upgraded, refresh hooks only" use `mla rewire` instead.
// It takes no token and never touches credentials.
//
// Folder = workspace (T3.1): `mla init` is machine setup only (creds + hooks).
// It no longer writes a `workspaceId` into cli-config; the workspace binding is
// per-folder, resolved from the nearest `.meetless.json` marker (`mla activate`
// creates/binds it). The `--workspace-id` flag is gone.
//
// Flags:
//   --control-url <url>        default https://control.meetless.ai (hosted prod)
//   --control-token <token>    optional; opt-in to the headless shared-key mode.
//                              Omit it to default to auth.mode none (logged out;
//                              `mla login` next). On re-run it rotates the key.
//   --intel-url <url>          default https://intel.meetless.ai (hosted prod)
//   --actor <id>               WorkspaceUser id this CLI acts as (KB curation)
//   --no-post-tool-use         skip post-tool-use.sh install (Bash capture escape hatch)
//   --unsafe-capture-non-bash  v0.1; rejected for now
//   --skill-only               only re-install the /mla skill
//   --no-install-flock         skip auto-install of flock (macOS)
//   --no-project-rules         skip writing the foreign-repo CLAUDE.md rules block
//   --no-mcp                   skip registering the Meetless MCP server in ~/.claude.json

interface InitFlags {
  controlUrl?: string;
  controlToken?: string;
  intelUrl?: string;
  actorUserId?: string;
  noPostToolUse?: boolean;
  unsafeCaptureNonBash?: boolean;
  skillOnly?: boolean;
  noInstallFlock?: boolean;
  noProjectRules?: boolean;
  noMcp?: boolean;
}

// Strict argv parsing for `mla init` (Wedge v6 Epoch 54).
//
// The old parser used `const next = () => argv[++i]` and switched on
// the flag name. That shape had three real silent-drop classes, the
// first one is genuinely dangerous because it writes a corrupt
// 0o600-mode config that breaks every subsequent CLI call:
//
//   1. `mla init --control-token --intel-url http://x` bound
//      controlToken = "--intel-url" (next() ate the next flag) and
//      then "http://x" fell through the switch's `default` branch
//      (positional, no `--` prefix) and was silently dropped. The
//      operator's intent ("set token AND intel url") flipped to "set
//      token to the string '--intel-url'", and the config was written
//      at 0o600 perms with a wrong token. Every downstream `mla` call
//      then 401'd with no obvious cause. (The trap applies to any value
//      flag; `--workspace-id` was the original example before T3.1
//      removed that flag.)
//
//   2. `mla init -x` (any short flag) hit the `default` branch's
//      `if (a.startsWith("--"))` guard which is `--` only -- so `-x`
//      was silently dropped with no diagnostic.
//
//   3. `mla init some_positional --control-token T` silently dropped
//      the positional. No `mla init` flow takes positionals.
//
// Strict rules below:
//   - Unknown `--`-prefixed or `-`-prefixed token throws with the
//     supported set.
//   - Value flags MUST be followed by a non-`--`/`-` value; missing
//     or flag-shape value throws.
//   - Positional arguments throw; `mla init` takes none.
const VALUE_FLAGS = new Set([
  "--control-url",
  "--control-token",
  "--intel-url",
  "--actor",
]);
const BOOLEAN_FLAGS = new Set([
  "--no-post-tool-use",
  "--unsafe-capture-non-bash",
  "--skill-only",
  "--no-install-flock",
  "--no-project-rules",
  "--no-mcp",
]);

export function parseInitArgs(argv: string[]): InitFlags {
  const out: InitFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`Missing value for ${a}`);
      }
      if (v.startsWith("--") || v.startsWith("-")) {
        throw new Error(
          `Missing value for ${a} (got the next flag ${v} instead)`,
        );
      }
      if (a === "--control-url") out.controlUrl = v;
      else if (a === "--control-token") out.controlToken = v;
      else if (a === "--intel-url") out.intelUrl = v;
      else if (a === "--actor") out.actorUserId = v;
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === "--no-post-tool-use") out.noPostToolUse = true;
      else if (a === "--unsafe-capture-non-bash") out.unsafeCaptureNonBash = true;
      else if (a === "--skill-only") out.skillOnly = true;
      else if (a === "--no-install-flock") out.noInstallFlock = true;
      else if (a === "--no-project-rules") out.noProjectRules = true;
      else if (a === "--no-mcp") out.noMcp = true;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. Supported flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")}`,
      );
    }
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla init\` takes no positional arguments.`,
    );
  }
  return out;
}

// Assemble the cli-config that `mla init` writes, inheriting unset fields from a
// prior config (idempotent re-run / token rotation). Pure (no I/O beyond
// resolveMlaPath reading argv) so the folder = workspace contract is unit-pinned
// in init-config-shape.spec.ts.
//
// Folder = workspace (T3.1): the assembled config carries NO `workspaceId`. The
// field is omitted from the literal entirely, so even a stale workspaceId on a
// pre-cutover `prior` is dropped rather than carried forward. The workspace
// binding lives only in the per-folder `.meetless.json` marker.
export function buildInitConfig(
  flags: InitFlags,
  prior: CliConfig | null,
): CliConfig {
  // `mla init` is the SHARED-KEY bootstrap (scripted / CI / `--control-token`),
  // never the browser-login path. So it only ever assembles a shared-key or a
  // 'none' auth. The one exception is idempotence: a re-run while a browser
  // session is live (prior.auth.mode === 'user-token') must PRESERVE that login
  // rather than silently downgrade it to a shared key (which would also freeze a
  // short-lived access token as if it were permanent). `mla login`/`mla logout`
  // own the user-token lifecycle (§6.6).
  let auth: CliAuth;
  if (flags.controlToken) {
    auth = { mode: "shared-key", accessToken: flags.controlToken };
  } else if (prior?.auth) {
    // Preserve whatever was canonically on disk (none / shared-key / user-token).
    auth = prior.auth;
  } else if (prior?.controlToken) {
    // Legacy prior (pre-nested-auth) with only a top-level token: shared-key.
    auth = { mode: "shared-key", accessToken: prior.controlToken };
  } else {
    // Fresh init with no token: logged out until `mla login` or a later
    // `mla init --control-token`.
    auth = { mode: "none" };
  }

  // P3: under a preserved user session the actor is pinned to the authenticated
  // user; otherwise it is the explicit flag or the inherited value.
  const actorUserId =
    auth.mode === "user-token"
      ? auth.user.id
      : (flags.actorUserId ?? prior?.actorUserId);

  return {
    controlUrl: flags.controlUrl ?? prior?.controlUrl ?? DEFAULT_CONTROL_URL,
    // Derived projection of auth (= accessToken, "" for none). Never persisted.
    controlToken: auth.mode === "none" ? "" : auth.accessToken,
    intelUrl: flags.intelUrl ?? prior?.intelUrl ?? DEFAULT_INTEL_URL,
    mlaPath: resolveMlaPath(),
    intelRoot: prior?.intelRoot,
    consoleUrl: prior?.consoleUrl,
    actorUserId,
    auth,
  };
}

// Human-readable one-liner for the auth state a fresh/updated init just wrote,
// shown in the init summary. `none` is the DEFAULT (no --control-token): the
// machine is wired but logged out, so `mla login` is the next step. shared-key
// is the opt-in headless path; user-token only appears on an idempotent re-run
// over a live browser session (init preserves it, never downgrades).
function describeInitAuthMode(mode: CliAuth["mode"]): string {
  if (mode === "user-token") return "user-token (browser login preserved)";
  if (mode === "shared-key") return "shared-key (headless)";
  return "none (logged out; run `mla login` to sign in)";
}

export async function runInit(argv: string[]): Promise<number> {
  let flags: InitFlags;
  try {
    flags = parseInitArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (flags.unsafeCaptureNonBash) {
    console.error("--unsafe-capture-non-bash is v0.1; rejected in v0.");
    return 2;
  }

  if (flags.skillOnly) {
    const res = runWire({ skillOnly: true });
    printWireResult(res, { skillOnly: true });
    return 0;
  }

  // Idempotent re-run: when cli-config.json exists, inherit each field
  // the operator did not explicitly override. This lets `mla init` double
  // as "rotate token" (`mla init --control-token NEW`) or "change backend"
  // (`mla init --control-url ...`) without forcing the operator to retype
  // every previously-set value. On a first run with nothing to inherit, the
  // auth defaults to 'none' (see below) rather than demanding a token.
  let prior: CliConfig | null = null;
  if (configExists()) {
    try {
      prior = readConfig();
    } catch {
      prior = null;
    }
  }

  // §6.4: `mla init` DEFAULTS to auth.mode 'none' (machine wired, logged out)
  // when no --control-token is given. The shared-key bootstrap is now opt-in via
  // --control-token (headless / CI); the interactive path is `mla init` then
  // `mla login`. buildInitConfig already assembles the 'none' auth, and a
  // tokenless re-run over a live user-token PRESERVES it (no downgrade), so there
  // is no token guard here: a tokenless first run is a supported, audited-by-login
  // setup, not an error.
  const cfg = buildInitConfig(flags, prior);

  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  writeConfig(cfg);

  const wire = runWire({
    noPostToolUse: !!flags.noPostToolUse,
    noInstallFlock: !!flags.noInstallFlock,
    noProjectRules: !!flags.noProjectRules,
    noMcp: !!flags.noMcp,
  });

  const authMode = cfg.auth.mode;
  console.log(`Wrote ${CFG_PATH}${prior ? " (updated)" : ""}`);
  console.log(`  controlUrl:  ${cfg.controlUrl}`);
  console.log(`  intelUrl:    ${cfg.intelUrl}`);
  console.log(`  mlaPath:     ${cfg.mlaPath}`);
  console.log(`  auth:        ${describeInitAuthMode(authMode)}`);
  if (cfg.actorUserId) {
    console.log(`  actorUserId: ${cfg.actorUserId}`);
  } else if (authMode !== "none") {
    // Under 'none' the actor is stamped by `mla login` (pinned to auth.user.id),
    // so only the headless shared-key path needs the explicit --actor nag.
    console.log(
      "  actorUserId: (unset; required for `mla kb` curation commands. " +
        "Re-run `mla init --actor <id>` to set it.)",
    );
  }
  printWireResult(wire);
  // 4.4 first-run telemetry disclosure. Stated once, at setup, rather than on
  // every invocation (a per-run notice would pollute scriptable output). Crash
  // reporting is OFF unless a Sentry DSN is configured; run traces, when a
  // backend enables them, go ONLY to the control URL above (your own server).
  // Product-health analytics is ON by default but ids/counts/enums only (never
  // your prompts, paths, argv, or file contents) and is sent to your configured
  // control, not directly to Meetless. Opt out of everything with
  // MEETLESS_TELEMETRY=off.
  console.log(
    "Telemetry: crash reporting OFF (no Sentry DSN); run traces go only to " +
      "your configured control. Product-health analytics is ON by default " +
      "(ids/counts/enums only, never prompts/paths/content). Opt out with " +
      "MEETLESS_TELEMETRY=off. See TELEMETRY.md.",
  );
  // A logged-out machine's next step is the browser login; a headless shared-key
  // install goes straight to doctor.
  console.log(`Next: ${authMode === "none" ? "mla login" : "mla doctor"}`);
  return wire.flock?.ok ? 0 : 1;
}
