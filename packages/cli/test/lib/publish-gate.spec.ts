// Behavioral lock for the publish gate (proposal T34b, refined by the release-
// testing proposal Phase 0.4). The gate now aborts a publish iff the BUILT CLI
// is missing any of login/logout/whoami; the old AUTH_BROWSER_LOGIN_READY env
// flag was removed once browser login shipped, so command registration is the
// sole abort condition. `main()` exits non-zero iff `evaluatePublishGate(...).ok`
// is false, so locking the pure decision core IS the lock on the publish-abort
// behavior. The .js gate script loads as plain CommonJS (jest only transforms
// .ts), so require() exercises it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require("../../scripts/check-publish-gate.js") as {
  evaluatePublishGate: (input: { helpText: string }) => {
    ok: boolean;
    reason: string;
  };
  REQUIRED_COMMANDS: string[];
};

// A faithful slice of the real `mla --help` USAGE block: the three command lines
// verbatim, so the regex is locked against the shipped manifest format (leading
// indentation, a flag tail on `login`, bare `logout`/`whoami` lines).
const REAL_HELP = `mla: Meetless Agent CLI

usage:
  mla init [--control-url <url>] [--control-token <token>] [--intel-url <url>]
  mla login [--no-browser] [--console-url <url>] [--port <n>]
                    (browser login: opens the Console authorize page ...)
  mla logout
                    (revoke the current user session server-side ...)
  mla whoami
                    (print the identity behind the current cli-config.json ...)
  mla review [--plain] [--no-flush]
`;

describe("evaluatePublishGate (T34b)", () => {
  it("passes when all three required commands are registered", () => {
    const r = gate.evaluatePublishGate({ helpText: REAL_HELP });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/publish gate OK/);
  });

  it("fails (and names the command) when whoami is missing from the built manifest", () => {
    const without = REAL_HELP.split("\n")
      .filter((l) => !/mla whoami/.test(l))
      .join("\n");
    const r = gate.evaluatePublishGate({ helpText: without });
    expect(r.ok).toBe(false);
    // The enumerated missing-list contains ONLY whoami (the prose tail may still
    // say "Browser login", so assert against the list, not the whole message).
    expect(r.reason).toMatch(/command\(s\): whoami\./);
  });

  it("lists every missing command when none are registered", () => {
    const bare = "mla: Meetless Agent CLI\n\nusage:\n  mla init [...]\n  mla review\n";
    const r = gate.evaluatePublishGate({ helpText: bare });
    expect(r.ok).toBe(false);
    for (const cmd of gate.REQUIRED_COMMANDS) {
      expect(r.reason).toMatch(new RegExp(cmd));
    }
  });

  it("fails when the login command line is absent (a missing command aborts)", () => {
    const without = REAL_HELP.replace(/  mla login.*\n/, "");
    const r = gate.evaluatePublishGate({ helpText: without });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing required command/);
    expect(r.reason).toMatch(/login/);
  });

  it("does not match the word 'login' in prose, only the registered command", () => {
    // 'browser login' appears in prose but the command line is gone: must fail.
    const proseOnly = `usage:
  mla logout
  mla whoami
                    (browser login flow described here, but no command line)
`;
    const r = gate.evaluatePublishGate({ helpText: proseOnly });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/login/);
  });
});
