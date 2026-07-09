import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the `mla activate` inline login offer (T4,
// notes/20260709-mla-install-login-flow.md). When the machine is wired but the
// operator is logged out, activate folds the browser login into itself instead of
// making them discover `mla login` separately, mirroring Claude Code's first-run
// auth. The offer is STRICTLY gated and best-effort:
//   - no config on disk        -> stay silent (activate's own "run mla init" path)
//   - auth.mode !== 'none'      -> stay silent (user-token / shared-key untouched)
//   - not a TTY                 -> stay silent (headless/hook contexts never prompt)
//   - decline                  -> print a nudge, DO NOT log in, let activate continue
//   - accept                   -> run the login flow, then continue
//
// The gating (configExists / readConfig / isTTY) is driven for REAL through
// MEETLESS_HOME + an isTTY toggle, so the guards run against the actual config
// loader. Only the two genuinely-external seams are injected: the stdin prompt
// (`confirm`) and the browser login (`login`).

// CFG_PATH is `${MEETLESS_HOME}/cli-config.json`, resolved at module import time,
// so every case sets MEETLESS_HOME then imports activate fresh via jest.resetModules.
function stageHome(auth: Record<string, unknown> | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-offer-login-"));
  if (auth !== null) {
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({ controlUrl: "http://127.0.0.1:1", mlaPath: "/bin/true", auth }, null, 2),
    );
  }
  return home;
}

interface RunResult {
  logs: string[];
  confirmCalls: Array<{ question: string; defaultYes: boolean }>;
  loginCalls: number;
}

// Invoke maybeOfferLogin in-process with an isolated MEETLESS_HOME and a forced
// isTTY, capturing every console.log line plus the injected-seam call records.
async function offerLoginIn(opts: {
  home: string;
  isTTY: boolean;
  confirmReturns?: boolean;
  loginThrows?: boolean;
}): Promise<RunResult> {
  const prevHome = process.env.MEETLESS_HOME;
  const prevControlToken = process.env.MEETLESS_CONTROL_TOKEN;
  const prevTTY = (process.stdin as { isTTY?: boolean }).isTTY;
  const logs: string[] = [];
  const confirmCalls: Array<{ question: string; defaultYes: boolean }> = [];
  let loginCalls = 0;
  const outSpy = jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  try {
    process.env.MEETLESS_HOME = opts.home;
    // A stray shared-key env var makes readConfig throw for a user-token config
    // (Gate 4); it must not leak in from the ambient shell and skew these cases.
    delete process.env.MEETLESS_CONTROL_TOKEN;
    (process.stdin as { isTTY?: boolean }).isTTY = opts.isTTY;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/activate");
    await mod.maybeOfferLogin({
      confirm: async (question: string, defaultYes: boolean) => {
        confirmCalls.push({ question, defaultYes });
        return opts.confirmReturns ?? false;
      },
      login: async () => {
        loginCalls += 1;
        if (opts.loginThrows) throw new Error("disk exploded post-auth");
        return 0;
      },
    });
  } finally {
    outSpy.mockRestore();
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevControlToken === undefined) delete process.env.MEETLESS_CONTROL_TOKEN;
    else process.env.MEETLESS_CONTROL_TOKEN = prevControlToken;
    (process.stdin as { isTTY?: boolean }).isTTY = prevTTY;
  }
  return { logs, confirmCalls, loginCalls };
}

describe("maybeOfferLogin gating", () => {
  it("stays silent when no config exists (activate's own 'run mla init' path owns it)", async () => {
    const home = stageHome(null);
    const r = await offerLoginIn({ home, isTTY: true });
    expect(r.logs).toEqual([]);
    expect(r.confirmCalls).toHaveLength(0);
    expect(r.loginCalls).toBe(0);
  });

  it("stays silent when already signed in via shared-key (CI key untouched)", async () => {
    const home = stageHome({ mode: "shared-key", accessToken: "k" });
    const r = await offerLoginIn({ home, isTTY: true });
    expect(r.logs).toEqual([]);
    expect(r.confirmCalls).toHaveLength(0);
    expect(r.loginCalls).toBe(0);
  });

  it("stays silent when logged out but NOT on a TTY (never hangs a headless run)", async () => {
    const home = stageHome({ mode: "none" });
    const r = await offerLoginIn({ home, isTTY: false });
    expect(r.logs).toEqual([]);
    expect(r.confirmCalls).toHaveLength(0);
    expect(r.loginCalls).toBe(0);
  });
});

describe("maybeOfferLogin prompt (logged out + TTY)", () => {
  it("offers with a default-yes prompt and runs login on accept", async () => {
    const home = stageHome({ mode: "none" });
    const r = await offerLoginIn({ home, isTTY: true, confirmReturns: true });
    expect(r.logs[0]).toBe("You're not signed in to Meetless.");
    expect(r.confirmCalls).toHaveLength(1);
    // Default-yes: a bare Enter logs the user in (the happy path).
    expect(r.confirmCalls[0].defaultYes).toBe(true);
    expect(r.confirmCalls[0].question).toContain("[Y/n]");
    expect(r.loginCalls).toBe(1);
  });

  it("does NOT log in on decline, and tells the user activate continues", async () => {
    const home = stageHome({ mode: "none" });
    const r = await offerLoginIn({ home, isTTY: true, confirmReturns: false });
    expect(r.confirmCalls).toHaveLength(1);
    expect(r.loginCalls).toBe(0);
    const joined = r.logs.join("\n");
    expect(joined).toContain("You're not signed in to Meetless.");
    expect(joined).toContain("Skipping login");
    expect(joined).toContain("mla login");
    expect(joined).toContain("activate continues");
  });

  it("swallows a throwing login so a wired activate never crashes (best-effort)", async () => {
    const home = stageHome({ mode: "none" });
    // maybeOfferLogin must resolve, not reject, even if login throws post-auth.
    const r = await offerLoginIn({ home, isTTY: true, confirmReturns: true, loginThrows: true });
    expect(r.loginCalls).toBe(1);
    expect(r.logs.join("\n")).toContain("activate continues");
  });

  it("prints no em dash or double dash in any branch (writing-style guard)", async () => {
    const home = stageHome({ mode: "none" });
    for (const confirmReturns of [true, false]) {
      const r = await offerLoginIn({ home, isTTY: true, confirmReturns });
      const joined = r.logs.join("\n");
      expect(joined).not.toContain("—"); // em dash
      expect(joined).not.toMatch(/ -- /);
    }
  });
});
