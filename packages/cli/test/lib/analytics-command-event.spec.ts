// command-event normalization (spec section 6.2, INV-ARGV-1, INV-POSTHOG-PII-1).
// Pure functions, no I/O. The headline contract is the privacy invariant: a raw
// argv carrying a query, a path, an id, and a secret-shaped flag value must
// normalize to a shape that contains NONE of those substrings.

import {
  classifyOutcome,
  classifyScope,
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

  it("error_class for an unknown throw is the class NAME, never a message", () => {
    const res = classifyOutcome(1, true, new RangeError("an@meetless.ai exploded at /secret/path"));
    expect(res.outcome).toBe("system_error");
    expect(res.error_class).toBe("RangeError");
    // The message (which could carry PII) is not surfaced.
    expect(JSON.stringify(res)).not.toContain("meetless.ai");
    expect(JSON.stringify(res)).not.toContain("/secret/path");
  });
});
