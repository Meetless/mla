import { CliConfig, readConfig } from "../lib/config";
import { refreshUserToken, RefreshOutcome } from "../lib/http";

// `mla _internal refresh [--quiet] [--if-expiring-within <secs>]` (Part 3, T2).
//
// A thin policy wrapper over the existing concurrency-safe `refreshUserToken`
// (lib/http.ts). It reimplements NOTHING: it reads the config, guards the mode,
// optionally short-circuits on a comfortably-fresh token, then calls
// refreshUserToken and maps its RefreshOutcome to a sysexits process exit code
// the bash hooks branch on with a clean `case "$rc"`.
//
// Wire contract (the 75/77/64 numbers are hardcoded in common.sh; keep in sync):
//   refreshed -> 0   token rotated, adopted from a concurrent winner, or the
//                    `--if-expiring-within` gate found it comfortably fresh.
//   busy      -> 75  EX_TEMPFAIL: sidecar lock contended past cap, or transient
//                    outage. Session untouched; the hook keeps events queued.
//   expired   -> 77  EX_NOPERM: the refresh token itself is dead server-side.
//                    The hook surfaces enrichment_unauthorized + "run `mla login`".
//   wrong mode-> 64  EX_USAGE: shared-key / none / unreadable config / bad args.
//                    Refresh is meaningless; the hook surfaces a mode message.
//
// SECURITY: this command NEVER prints a token. It prints at most a one-line
// status to stdout (suppressed by --quiet) and a one-line error to stderr.

const EX_OK = 0;
const EX_USAGE = 64; // EX_USAGE: wrong mode, unreadable config, or bad args.
const EX_TEMPFAIL = 75; // EX_TEMPFAIL: busy/transient; retry later.
const EX_NOPERM = 77; // EX_NOPERM: refresh token dead; re-login required.

// Injectable seams (matches the LoginDeps pattern). Production wiring is the
// defaults below; tests substitute a fake refresh (so no network/lock is touched)
// and a fixed clock (for the --if-expiring-within gate).
export interface InternalRefreshDeps {
  refresh?: (cfg: CliConfig) => Promise<RefreshOutcome>;
  now?: () => number;
}

export interface RefreshFlags {
  quiet: boolean;
  // Seconds of remaining access-token runway below which we refresh. When set
  // and the token has MORE than this much runway, the command no-ops (exit 0)
  // with no network call: the proactive "refresh-ahead" gate (Part 3 §A).
  ifExpiringWithinSecs?: number;
}

const VALUE_FLAGS = new Set(["--if-expiring-within"]);
const BOOLEAN_FLAGS = new Set(["--quiet"]);

// Strict argv parsing, mirroring `mla login`'s VALUE_FLAGS/BOOLEAN_FLAGS shape.
// `mla _internal refresh` takes no positionals. Throws on any unknown flag,
// stray positional, missing value, or non-integer --if-expiring-within.
export function parseRefreshArgs(argv: string[]): RefreshFlags {
  const out: RefreshFlags = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--") || v.startsWith("-")) {
        throw new Error(`Missing value for ${a}`);
      }
      if (a === "--if-expiring-within") {
        const secs = Number(v);
        if (!Number.isInteger(secs) || secs < 0) {
          throw new Error(
            `Invalid --if-expiring-within value "${v}": expected a non-negative integer (seconds).`,
          );
        }
        out.ifExpiringWithinSecs = secs;
      }
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === "--quiet") out.quiet = true;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. Supported flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")}`,
      );
    }
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla _internal refresh\` takes no positionals.`,
    );
  }
  return out;
}

export async function runInternalRefresh(
  argv: string[],
  deps: InternalRefreshDeps = {},
): Promise<number> {
  const refresh = deps.refresh ?? refreshUserToken;
  const now = deps.now ?? (() => Date.now());

  let flags: RefreshFlags;
  try {
    flags = parseRefreshArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return EX_USAGE;
  }

  // Read config. readConfig throws loudly on a missing/corrupt config or the
  // Gate-4 env conflict (user-token on disk + MEETLESS_CONTROL_TOKEN). Any of
  // these means we cannot name a refreshable user session: surface and bail 64.
  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    console.error((e as Error).message);
    return EX_USAGE;
  }

  // Mode guard BEFORE refreshUserToken so we can distinguish "wrong mode" (64)
  // from "dead refresh token" (77). shared-key and none have no refresh token.
  if (cfg.auth.mode !== "user-token") {
    if (cfg.auth.mode === "shared-key") {
      console.error(
        "This is a shared-key session (no refresh token to rotate). " +
          "Re-key with `mla init --control-token <T>` if it is invalid.",
      );
    } else {
      console.error("Not logged in. Run `mla login` first.");
    }
    return EX_USAGE;
  }

  // Proactive gate (Part 3 §A): if --if-expiring-within is set and the access
  // token has MORE than that much runway, no-op with no network call. An
  // unparseable expiry parses to NaN; we treat that as "cannot prove fresh" and
  // fall through to a real refresh rather than trust a broken timestamp (same
  // NaN-safe philosophy as `mla login`).
  if (flags.ifExpiringWithinSecs !== undefined) {
    const remainingMs = Date.parse(cfg.auth.accessExpiresAt) - now();
    const thresholdMs = flags.ifExpiringWithinSecs * 1000;
    if (!Number.isNaN(remainingMs) && remainingMs > thresholdMs) {
      if (!flags.quiet) {
        console.log("Access token still fresh; no refresh needed.");
      }
      return EX_OK;
    }
  }

  const outcome = await refresh(cfg);
  switch (outcome) {
    case "refreshed":
      if (!flags.quiet) console.log("Access token refreshed.");
      return EX_OK;
    case "busy":
      console.error("Refresh busy (lock contended or transient outage); will retry later.");
      return EX_TEMPFAIL;
    case "expired":
      console.error("Session expired server-side. Run `mla login`.");
      return EX_NOPERM;
    default: {
      // Exhaustiveness guard: a new RefreshOutcome must be mapped explicitly
      // rather than silently treated as success.
      const _never: never = outcome;
      console.error(`Unexpected refresh outcome: ${String(_never)}`);
      return EX_TEMPFAIL;
    }
  }
}
