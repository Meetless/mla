// command-event normalization (spec section 6.2, INV-ARGV-1, INV-POSTHOG-PII-1).
// Pure functions, no I/O. The headline contract is the privacy invariant: a raw
// argv carrying a query, a path, an id, and a secret-shaped flag value must
// normalize to a shape that contains NONE of those substrings.

import { COMMANDS } from "../../src/cli";
import {
  KNOWN_COMMANDS,
  classifyOutcome,
  classifyScope,
  isReportableFault,
  normalizeCommand,
} from "../../src/lib/analytics/command-event";

describe("normalizeCommand", () => {
  it("keeps a known command and a known subcommand", () => {
    const n = normalizeCommand(["kb", "review", "ddx_secret_case_id", "--accept"]);
    expect(n.command).toBe("kb");
    expect(n.subcommand).toBe("review");
    expect(n.flags_shape).toEqual(["accept"]);
  });

  it("normalizes an unknown command to 'unknown'", () => {
    const n = normalizeCommand(["/Users/an/secret/path", "x"]);
    expect(n.command).toBe("unknown");
    expect(n.subcommand).toBeNull();
  });

  it("recognizes the auth and debug commands (mirrors the cli.ts dispatch set)", () => {
    // These dispatch in cli.ts but had drifted out of KNOWN_COMMANDS, so every
    // `mla login|logout|whoami|debug ...` invocation collapsed to "unknown",
    // erasing its command dimension from the journey funnel.
    for (const cmd of ["login", "logout", "whoami", "debug"]) {
      expect(normalizeCommand([cmd]).command).toBe(cmd);
      // Local-effect commands: not workspace-scoped, so they anchor to "local".
      expect(classifyScope(cmd, [])).toBe("local");
    }
  });

  it("KNOWN_COMMANDS is a BIJECTION with the cli.ts command registry (drift pin)", () => {
    // This used to be a hand-maintained list of 41 strings kept "in lockstep" with
    // the dispatch switch by eye. The T6 registry made that unnecessary: COMMANDS
    // IS the dispatch table, so the expectation is DERIVED from it and the drift
    // it was written to catch is now impossible to introduce.
    //
    // Both directions matter. A dispatchable command missing from KNOWN_COMMANDS
    // normalizes to "unknown" and erases its own dimension from every failure and
    // retention view (the 2026-07-09 `rules` bug). A word in KNOWN_COMMANDS that
    // NOTHING dispatches is a stale allowlist entry: harmless to privacy, but it
    // means a removed command still looks live in the funnel.
    const dispatchable = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).sort();
    expect([...KNOWN_COMMANDS].sort()).toEqual(dispatchable);

    // ...and every one of them really does survive normalization (hidden entries
    // like `cases` included: they still dispatch, so they must still be counted).
    for (const cmd of dispatchable) {
      expect(normalizeCommand([cmd]).command).toBe(cmd);
    }
  });

  it("recognizes the 18 commands reconciled after the 2026-07-09 cohort forensics", () => {
    // These dispatch in cli.ts but had drifted out of KNOWN_COMMANDS, so every
    // invocation collapsed to command="unknown" and every FAILURE of theirs was
    // uncountable in the funnel. `rules` is the headline case: the cohort filed
    // bugs about `mla rules ...` while its failures were invisible in analytics.
    const RECONCILED = [
      "wire", "uninstall", "status", "scan", "context", "queue", "rules",
      "enforcement", "conflicts", "agent-memory", "enrich", "graph", "cg",
      "turn", "bug", "evidence", "mcp", "upgrade",
    ];
    for (const cmd of RECONCILED) {
      expect(normalizeCommand([cmd]).command).toBe(cmd);
      expect(normalizeCommand([cmd]).command).not.toBe("unknown");
    }
  });

  it("captures the new subcommand keywords without leaking the positional after them", () => {
    // Each sub-bearing command emits argv[1] as `subcommand` ONLY for a known
    // keyword; the id/path that follows is a positional and must stay off-wire.
    const cases: Array<[string[], string, string]> = [
      [["rules", "edit", "rul_secret_id"], "rules", "edit"],
      [["rules", "revoke", "rul_secret_id"], "rules", "revoke"],
      [["enforcement", "confirm", "inc_secret_id"], "enforcement", "confirm"],
      [["conflicts", "resolve", "cfl_secret_id"], "conflicts", "resolve"],
      [["queue", "prune"], "queue", "prune"],
      [["session", "reconcile"], "session", "reconcile"],
      [["enrich", "ingest"], "enrich", "ingest"],
      [["graph", "review", "ddx_secret"], "graph", "review"],
      [["cg", "review", "ddx_secret"], "cg", "review"], // alias shares the set
      [["workspace", "members"], "workspace", "members"],
      [["agent-memory", "scan"], "agent-memory", "scan"],
      [["evidence", "ce0-export"], "evidence", "ce0-export"],
    ];
    for (const [argv, command, subcommand] of cases) {
      const n = normalizeCommand(argv);
      expect(n.command).toBe(command);
      expect(n.subcommand).toBe(subcommand);
      expect(JSON.stringify(n)).not.toContain("secret");
    }
  });

  it("maps the help/version shortcuts", () => {
    expect(normalizeCommand([]).command).toBe("help");
    expect(normalizeCommand(["--help"]).command).toBe("help");
    expect(normalizeCommand(["-h"]).command).toBe("help");
    expect(normalizeCommand(["--version"]).command).toBe("version");
    expect(normalizeCommand(["-v"]).command).toBe("version");
  });

  it("does NOT treat a positional after a command as a subcommand", () => {
    // `mla review <case-id>`: the id is a positional, not a known keyword.
    const n = normalizeCommand(["review", "ddx_1a2b3c"]);
    expect(n.command).toBe("review");
    expect(n.subcommand).toBeNull();
  });

  it("treats a non-keyword second token of a sub-bearing command as a positional", () => {
    // `mla kb <doc-path>` where the path is not a known kb subcommand.
    const n = normalizeCommand(["kb", "/Users/an/notes/secret.md"]);
    expect(n.command).toBe("kb");
    expect(n.subcommand).toBeNull();
  });

  it("dedupes and sorts the flags_shape for a stable funnel key", () => {
    const n = normalizeCommand(["ask", "--json", "--verbose", "--json"]);
    expect(n.flags_shape).toEqual(["json", "verbose"]);
  });

  it("keeps only approved flag names and drops unknown flags", () => {
    const n = normalizeCommand(["ask", "--json", "--totally-made-up-flag"]);
    expect(n.flags_shape).toEqual(["json"]);
  });

  it("strips the value from a --flag=value token, keeping only the name", () => {
    const n = normalizeCommand(["kb", "retime", "--effective-date=2026-01-01"]);
    expect(n.flags_shape).toEqual(["effective-date"]);
  });

  it("INV-ARGV-1: no positional or flag value survives normalization", () => {
    const SECRETS = [
      "what is our pricing strategy", // a query positional
      "/Users/an/private/roadmap.md", // a path positional
      "ddx_super_secret_case_id", // an id positional
      "sk-live-deadbeefsecrettoken", // a secret pasted as a flag value
      "an@meetless.ai", // PII as a value
    ];
    const argv = [
      "ask",
      SECRETS[0],
      "--doc",
      SECRETS[1],
      SECRETS[2],
      "--control-token",
      SECRETS[3],
      "--actor",
      SECRETS[4],
      "--json",
    ];
    const n = normalizeCommand(argv);
    const emitted = JSON.stringify(n);
    for (const secret of SECRETS) {
      expect(emitted).not.toContain(secret);
    }
    // Only the flag NAMES (and the leading command) survive.
    expect(n.command).toBe("ask");
    expect(n.subcommand).toBeNull();
    expect(n.flags_shape).toEqual(["actor", "control-token", "doc", "json"]);
  });
});

describe("classifyScope", () => {
  it("--global wins over everything", () => {
    expect(classifyScope("kb", ["global"])).toBe("global");
    expect(classifyScope("ask", ["global"])).toBe("global");
  });

  it("ask / adoption / summary are workspace-scoped", () => {
    expect(classifyScope("ask", [])).toBe("workspace");
    expect(classifyScope("adoption", [])).toBe("workspace");
    expect(classifyScope("summary", [])).toBe("workspace");
  });

  it("an unknown command is unknown scope", () => {
    expect(classifyScope("unknown", [])).toBe("unknown");
  });

  it("anchors kb to local (spec section 11 example)", () => {
    expect(classifyScope("kb", [])).toBe("local");
  });
});

describe("classifyOutcome", () => {
  it("exit 0 is success with no error_class", () => {
    expect(classifyOutcome(0, false, null)).toEqual({
      outcome: "success",
      error_class: null,
      retryable: false,
    });
  });

  it("non-zero without a throw is a user_error", () => {
    expect(classifyOutcome(2, false, null)).toEqual({
      outcome: "user_error",
      error_class: null,
      retryable: false,
    });
  });

  it("maps HTTP status to closed-enum outcomes and class tokens", () => {
    expect(classifyOutcome(1, true, { status: 401 })).toMatchObject({
      outcome: "auth_error",
      error_class: "http_401",
      retryable: false,
    });
    expect(classifyOutcome(1, true, { status: 403 })).toMatchObject({
      outcome: "permission_denied",
      error_class: "http_403",
    });
    expect(classifyOutcome(1, true, { status: 408 })).toMatchObject({
      outcome: "timeout",
      retryable: true,
    });
    expect(classifyOutcome(1, true, { status: 429 })).toMatchObject({
      outcome: "system_error",
      retryable: true,
    });
    expect(classifyOutcome(1, true, { status: 422 })).toMatchObject({
      outcome: "validation_error",
      error_class: "http_422",
    });
    expect(classifyOutcome(1, true, { status: 503 })).toMatchObject({
      outcome: "system_error",
      error_class: "http_503",
      retryable: true,
    });
    expect(classifyOutcome(1, true, { status: 404 })).toMatchObject({
      outcome: "user_error",
      error_class: "http_404",
    });
  });

  it("maps network-layer errors without a status", () => {
    expect(classifyOutcome(1, true, { code: "ECONNREFUSED" })).toMatchObject({
      outcome: "network_error",
      error_class: "network_error",
      retryable: true,
    });
    expect(classifyOutcome(1, true, { name: "AbortError" })).toMatchObject({
      outcome: "timeout",
      retryable: true,
    });
    expect(classifyOutcome(1, true, { name: "TypeError" })).toMatchObject({
      outcome: "network_error",
    });
  });

  it("maps app-level user-actionable errors by their type name (never system_error)", () => {
    // These are thrown at their sites (http.ts, workspace.ts) with a stable
    // `name`; the classifier must not let them fall through to system_error,
    // which would fire the bug-report nudge for a "run mla login / activate" case.
    expect(classifyOutcome(1, true, { name: "ConfigError" })).toMatchObject({
      outcome: "user_error",
      error_class: "config_error",
      retryable: false,
    });
    expect(classifyOutcome(1, true, { name: "NotLoggedInError" })).toMatchObject({
      outcome: "auth_error",
      error_class: "not_logged_in",
      retryable: false,
    });
    expect(classifyOutcome(1, true, { name: "NotActivatedError" })).toMatchObject({
      outcome: "user_error",
      error_class: "not_activated",
    });
    expect(
      classifyOutcome(1, true, { name: "MarkerMissingWorkspaceIdError" }),
    ).toMatchObject({
      outcome: "user_error",
      error_class: "marker_missing_workspace_id",
    });
    expect(classifyOutcome(1, true, { name: "RefreshBusyError" })).toMatchObject({
      outcome: "timeout",
      error_class: "refresh_busy",
      retryable: true,
    });
  });

  it("error_class for an unknown throw is the class NAME, never a message", () => {
    const res = classifyOutcome(1, true, new RangeError("an@meetless.ai exploded at /secret/path"));
    expect(res.outcome).toBe("system_error");
    expect(res.error_class).toBe("RangeError");
    // The message (which could carry PII) is not surfaced.
    expect(JSON.stringify(res)).not.toContain("meetless.ai");
    expect(JSON.stringify(res)).not.toContain("/secret/path");
  });

  it("passes a filesystem errno through as the error_class (fresh-box diagnosability)", () => {
    // Before this, a Node fs error (name "Error", code "ENOENT") collapsed to the
    // opaque error_class "Error"; the fresh-box first-run failure surface (missing
    // dir, unwritable ~/.meetless, full disk) was undiagnosable. The errno is now
    // preserved, lowercased to match the http_*/config_error token style.
    expect(classifyOutcome(1, true, { name: "Error", code: "ENOENT" })).toEqual({
      outcome: "system_error",
      error_class: "enoent",
      retryable: false,
    });
    expect(classifyOutcome(1, true, { code: "ENOSPC" })).toMatchObject({
      outcome: "system_error",
      error_class: "enospc",
    });
    expect(classifyOutcome(1, true, { code: "EISDIR" })).toMatchObject({
      outcome: "system_error",
      error_class: "eisdir",
    });
  });

  it("classifies a local permission errno as permission_denied (quiet, not our bug)", () => {
    // EACCES/EPERM writing to the local FS is the user's to fix (chmod), not a
    // backend permission (http_403) and not a bug to report.
    expect(classifyOutcome(1, true, { code: "EACCES" })).toEqual({
      outcome: "permission_denied",
      error_class: "eacces",
      retryable: false,
    });
    expect(classifyOutcome(1, true, { code: "EPERM" })).toMatchObject({
      outcome: "permission_denied",
      error_class: "eperm",
    });
  });

  it("the errno shape guard is itself the PII filter: a non-errno .code never leaks", () => {
    // The `^E[A-Z0-9]+$` guard only admits an uppercase E-prefixed alnum token. A
    // path/email/secret pasted where a code would be cannot match (slashes, dots,
    // @, dashes, lowercase), so it falls through to the class-NAME path and never
    // surfaces the raw value.
    const res = classifyOutcome(1, true, {
      name: "Error",
      code: "/Users/an/secret/eaccestoken@meetless.ai",
    });
    expect(res.error_class).toBe("Error");
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(JSON.stringify(res)).not.toContain("meetless.ai");
  });
});

describe("isReportableFault (bug-report nudge policy)", () => {
  // Behavioral contract for the failure-footer nudge: it fires ONLY on a genuine
  // fault on our side (a 5xx from a reachable backend, or an unhandled in-process
  // crash), never on a user-actionable or transient failure. Each row is a real
  // thrown-error shape run through the full classify -> predicate path, mirroring
  // exactly what the cli.ts catch does.
  const cases: Array<{ label: string; thrown: unknown; nudge: boolean }> = [
    // Our faults -> nudge.
    { label: "HTTP 500", thrown: { status: 500 }, nudge: true },
    { label: "HTTP 502", thrown: { status: 502 }, nudge: true },
    { label: "HTTP 503", thrown: { status: 503 }, nudge: true },
    { label: "unhandled in-process crash", thrown: new RangeError("boom"), nudge: true },
    // User-actionable / transient -> quiet.
    { label: "HTTP 401 (auth)", thrown: { status: 401 }, nudge: false },
    { label: "HTTP 403 (permission)", thrown: { status: 403 }, nudge: false },
    { label: "HTTP 400 (validation)", thrown: { status: 400 }, nudge: false },
    { label: "HTTP 404 (bad ref)", thrown: { status: 404 }, nudge: false },
    { label: "HTTP 429 (rate limit)", thrown: { status: 429 }, nudge: false },
    { label: "config missing / corrupt (run mla init)", thrown: { name: "ConfigError" }, nudge: false },
    { label: "not logged in", thrown: { name: "NotLoggedInError" }, nudge: false },
    { label: "repo not activated", thrown: { name: "NotActivatedError" }, nudge: false },
    {
      label: "marker missing workspaceId",
      thrown: { name: "MarkerMissingWorkspaceIdError" },
      nudge: false,
    },
    { label: "refresh busy", thrown: { name: "RefreshBusyError" }, nudge: false },
    { label: "backend unreachable (ECONNREFUSED)", thrown: { code: "ECONNREFUSED" }, nudge: false },
    { label: "fetch failed (TypeError)", thrown: { name: "TypeError" }, nudge: false },
    { label: "aborted / timeout", thrown: { name: "AbortError" }, nudge: false },
    // Local permission denial -> the user's chmod, not a bug (permission_denied).
    { label: "local EACCES (unwritable ~/.meetless)", thrown: { code: "EACCES" }, nudge: false },
    { label: "local EPERM", thrown: { code: "EPERM" }, nudge: false },
    // Environment-capacity errnos -> the user's environment, filing a bug is useless.
    { label: "disk full (ENOSPC)", thrown: { code: "ENOSPC" }, nudge: false },
    { label: "read-only fs (EROFS)", thrown: { code: "EROFS" }, nudge: false },
    { label: "over quota (EDQUOT)", thrown: { code: "EDQUOT" }, nudge: false },
    // A generic fs errno CAN be our missing bundled asset / uncreated dir -> report.
    { label: "missing path (ENOENT)", thrown: { code: "ENOENT" }, nudge: true },
    { label: "not a directory (ENOTDIR)", thrown: { code: "ENOTDIR" }, nudge: true },
  ];

  it.each(cases)("$label -> nudge=$nudge", ({ thrown, nudge }) => {
    expect(isReportableFault(classifyOutcome(1, true, thrown))).toBe(nudge);
  });

  it("a bare 429 classification is system_error but excluded from the nudge", () => {
    // Guards the one special-case: 429 is analytics-bucketed as system_error yet
    // must stay quiet (client-side throttle, not a bug).
    const c = classifyOutcome(1, true, { status: 429 });
    expect(c.outcome).toBe("system_error");
    expect(isReportableFault(c)).toBe(false);
  });
});
