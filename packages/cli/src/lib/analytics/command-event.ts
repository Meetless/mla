// mla_command normalization (spec section 6.2, INV-ARGV-1, INV-POSTHOG-PII-1).
//
// Turns a raw argv into the three privacy-safe shape fields the journey event
// carries: a known `command`, a known `subcommand` (or null), and a `flags_shape`
// built from approved flag NAMES only. Raw argv is never emitted: positional
// arguments (queries, paths, ids) do not start with a dash and are dropped; flag
// VALUES are split off at `=` or live in a separate token and are likewise
// dropped; an unrecognized command or flag is normalized away rather than passed
// through. This is the single chokepoint that keeps INV-ARGV-1 true.

import {
  CommandOutcome,
  CommandScope,
} from "./envelope";

// The closed set of top-level commands `mla` dispatches (cli.ts:215). A first
// token outside this set is normalized to "unknown" so a typo'd path or secret
// pasted as argv[0] never reaches the wire.
export const KNOWN_COMMANDS = new Set<string>([
  "init",
  "rewire",
  "activate",
  "deactivate",
  "mute",
  "unmute",
  "workspace",
  "doctor",
  "flush",
  "review",
  "cases",
  "session",
  "ask",
  "kb",
  "summary",
  "label",
  "adoption",
  "stats",
  "whoami",
  "login",
  "logout",
  "debug",
  "_internal",
]);

// Known subcommand keywords per command. A second token is emitted as
// `subcommand` ONLY when it is in this set; otherwise it is a positional (an id,
// a query, a doc path) and `subcommand` is null. This is what stops
// `mla review <case-id>` or `mla ask "<query>"` from leaking the positional as a
// subcommand.
export const KNOWN_SUBCOMMANDS: Record<string, Set<string>> = {
  kb: new Set([
    "add",
    "show",
    "reingest",
    "forget",
    "purge",
    "move",
    "review",
    "pending",
    "personal",
    "promote",
    "share",
    "retime",
    "summary",
  ]),
  workspace: new Set(["show", "use"]),
  session: new Set(["show"]),
  stats: new Set(["evidence"]),
  _internal: new Set(["finalize-session", "active-review", "auto-index"]),
};

// Approved flag NAMES (INV-ARGV-1). A token starting with a dash is reduced to
// its name (leading dashes stripped, anything after `=` discarded) and kept only
// if it is in this set. The set is flag NAMES the CLI actually parses; values are
// never emitted regardless of allowlisting. Unknown flag names are dropped, not
// surfaced, so a future flag is invisible to analytics until it is added here
// (privacy-conservative by construction).
export const APPROVED_FLAGS = new Set<string>([
  "accept",
  "actor",
  "agent",
  "all",
  "allow-file-missing",
  "allow-provenance-change",
  "anchor-type",
  "apply",
  "as-of",
  "audit-all",
  "cached",
  "control-token",
  "control-url",
  "create",
  "doc",
  "dry-run",
  "effective-date",
  "evidence",
  "force",
  "from-root",
  "gc",
  "glob",
  "global",
  "harmful",
  "help",
  "here",
  "include-tombstoned",
  "ingest-run-id",
  "intel-url",
  "is-inside-work-tree",
  "json",
  "last",
  "markdown",
  "marker",
  "max",
  "min",
  "mode",
  "name",
  "no-flush",
  "no-install-flock",
  "no-post-tool-use",
  "no-project-rules",
  "no-relation",
  "noisy",
  "note",
  "oneline",
  "open",
  "path",
  "plain",
  "posture",
  "prevented-mistake",
  "profile",
  "provenance",
  "purge-expired",
  "queue",
  "quiet",
  "reap-only",
  "reason",
  "reclassify",
  "reject",
  "repair",
  "scope-section",
  "session",
  "show-current",
  "show-toplevel",
  "skill-only",
  "stat",
  "unsafe-capture-non-bash",
  "useful",
  "verbose",
  "window",
  "workspace",
  "workspace-id",
  "yes",
]);

// Coarse command-to-scope map (where the command's effect primarily lands).
// Command-granularity on purpose: a per-subcommand effect tracker is not worth
// the maintenance for a breakdown dimension. Anchored to the spec's own example
// (section 11: `kb review` -> scope "local"), so `kb` is local even though some
// subcommands sync. `ask` / `adoption` / `summary` fundamentally read or compute
// over workspace data, so they are "workspace". A `--global` flag overrides to
// "global". Anything unrecognized is "unknown" (never guessed).
const WORKSPACE_SCOPE_COMMANDS = new Set<string>(["ask", "adoption", "summary"]);

export interface NormalizedCommand {
  command: string;
  subcommand: string | null;
  flags_shape: string[];
}

// Normalize the first token to a known command, "help"/"version" for the usage
// and version shortcuts, or "unknown".
function normalizeCommandToken(first: string | undefined): string {
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return "help";
  }
  if (first === "--version" || first === "-v") return "version";
  if (KNOWN_COMMANDS.has(first)) return first;
  return "unknown";
}

// Reduce a raw token to its flag name, or null if it is not a flag (positional)
// or not approved. `--window=7d` -> "window"; `--window 7d` -> "window" (the
// "7d" is a separate token that returns null here); `query text` -> null.
function flagName(token: string): string | null {
  if (!token.startsWith("-")) return null;
  const stripped = token.replace(/^-+/, "");
  if (!stripped) return null;
  const name = stripped.split("=", 1)[0].toLowerCase();
  return APPROVED_FLAGS.has(name) ? name : null;
}

// Build the privacy-safe command shape from argv. Pure, no I/O.
export function normalizeCommand(argv: string[]): NormalizedCommand {
  const command = normalizeCommandToken(argv[0]);

  let subcommand: string | null = null;
  const knownSubs = KNOWN_SUBCOMMANDS[command];
  if (knownSubs && typeof argv[1] === "string" && knownSubs.has(argv[1])) {
    subcommand = argv[1];
  }

  // Scan ALL tokens for approved flags (flags can follow positionals). Dedupe and
  // sort for a stable shape so PostHog funnels group identical invocations.
  const flags = new Set<string>();
  for (const token of argv) {
    const name = flagName(token);
    if (name) flags.add(name);
  }
  const flags_shape = [...flags].sort();

  return { command, subcommand, flags_shape };
}

// Scope of the command's effect (best-effort, command-granularity). `--global`
// in flags_shape wins.
export function classifyScope(
  command: string,
  flags_shape: string[],
): CommandScope {
  if (flags_shape.includes("global")) return "global";
  if (command === "unknown") return "unknown";
  if (WORKSPACE_SCOPE_COMMANDS.has(command)) return "workspace";
  return "local";
}

export interface OutcomeClassification {
  outcome: CommandOutcome;
  error_class: string | null;
  retryable: boolean;
}

// Map a finished run (exit code + optional thrown error) to a closed-enum
// outcome, a PII-safe error_class (a class/category token, NEVER a message), and
// a retryable hint. The error's `status` (set by lib/http.buildError on HTTP
// failures) drives the HTTP mapping; otherwise the error code/name is inspected
// for the common network failure modes.
export function classifyOutcome(
  exitCode: number,
  threw: boolean,
  thrown: unknown,
): OutcomeClassification {
  if (exitCode === 0) {
    return { outcome: "success", error_class: null, retryable: false };
  }

  if (!threw) {
    // A command returned non-zero without throwing: a handled, user-facing
    // failure (bad input, not found, usage error -> exit 2). No exception object
    // to classify, so no error_class.
    return { outcome: "user_error", error_class: null, retryable: false };
  }

  const err = thrown as { status?: number; code?: string; name?: string } | null;
  const status = err?.status;
  if (typeof status === "number") {
    if (status === 401) return { outcome: "auth_error", error_class: "http_401", retryable: false };
    if (status === 403) return { outcome: "permission_denied", error_class: "http_403", retryable: false };
    if (status === 408) return { outcome: "timeout", error_class: "http_408", retryable: true };
    if (status === 429) return { outcome: "system_error", error_class: "http_429", retryable: true };
    if (status === 400 || status === 422) {
      return { outcome: "validation_error", error_class: `http_${status}`, retryable: false };
    }
    if (status >= 500) return { outcome: "system_error", error_class: `http_${status}`, retryable: true };
    // Other 4xx: a client-side problem the user must fix.
    return { outcome: "user_error", error_class: `http_${status}`, retryable: false };
  }

  // No HTTP status: an app-level, network-layer, or programmatic error. fetch()
  // rejects with a TypeError ("fetch failed") wrapping a cause; AbortController
  // aborts surface as an AbortError; node socket errors carry an errno code.
  const code = (err?.code || "").toUpperCase();
  const name = err?.name || "";

  // App-level, user-actionable failures carry a stable type name (set at their
  // throw sites: config.ts, http.ts, workspace.ts). They are the user's to act on
  // (fix config, log in, activate, retry), never an internal fault, so they must
  // NOT fall through to system_error and fire the "file a bug report" nudge
  // (isReportableFault).
  if (name === "ConfigError") {
    // Any config/auth-load failure (config.ts): missing/corrupt cli-config,
    // unrecognized auth.mode, MEETLESS_CONTROL_TOKEN-while-logged-in, missing
    // actorUserId. All are "fix your setup" (run `mla init` / `mla login` /
    // unset an env var), never an internal fault.
    return { outcome: "user_error", error_class: "config_error", retryable: false };
  }
  if (name === "NotLoggedInError") {
    return { outcome: "auth_error", error_class: "not_logged_in", retryable: false };
  }
  if (name === "NotActivatedError") {
    return { outcome: "user_error", error_class: "not_activated", retryable: false };
  }
  if (name === "MarkerMissingWorkspaceIdError") {
    return { outcome: "user_error", error_class: "marker_missing_workspace_id", retryable: false };
  }
  if (name === "RefreshBusyError") {
    return { outcome: "timeout", error_class: "refresh_busy", retryable: true };
  }

  if (code === "ETIMEDOUT" || name === "AbortError" || name === "TimeoutError") {
    return { outcome: "timeout", error_class: "timeout", retryable: true };
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    name === "FetchError" ||
    name === "TypeError" // node's fetch wraps network failures as TypeError
  ) {
    return { outcome: "network_error", error_class: "network_error", retryable: true };
  }

  // Unknown thrown error: a class name is PII-safe (it is a type, not a message).
  return { outcome: "system_error", error_class: name || "Error", retryable: false };
}

// True when a run's classification is a genuinely unexpected fault on OUR side,
// and so should surface the "file a bug report" nudge: a 5xx from a reachable
// backend, or an unhandled in-process crash. A 429 is bucketed as system_error
// for analytics but is a client-side throttle (back off, not a bug), so it is
// excluded. Everything else (auth, permission, validation, user error,
// offline/timeout/network) is the user's to act on and stays quiet. This is the
// single source of truth for the nudge policy so the analytics outcome and the
// user-facing nudge can never disagree.
export function isReportableFault(c: OutcomeClassification): boolean {
  if (c.outcome !== "system_error") return false;
  if (c.error_class === "http_429") return false;
  return true;
}
