import { openBrowser } from "../../src/lib/login";

// Regression lock for a real Windows prod `mla login` failure: the browser opened,
// but only `?state=...` reached Console -- code_challenge / redirect_uri were gone.
// Root cause: `cmd /c start "" <url>` lets cmd.exe re-parse the command line and
// treat `&` as a command separator, truncating the OAuth URL at the first query
// param. The fix quotes the URL as one token and passes args verbatim. See
// notes/20260710-mla-login-windows-cmd-ampersand-truncation.md.
describe("openBrowser: platform launcher selection", () => {
  function rec() {
    const calls: Array<{
      cmd: string;
      args: string[];
      opts?: { windowsVerbatimArguments?: boolean };
    }> = [];
    const run = async (
      cmd: string,
      args: string[],
      opts?: { windowsVerbatimArguments?: boolean },
    ): Promise<number> => {
      calls.push({ cmd, args, opts });
      return 0;
    };
    return { calls, run };
  }

  const OAUTH_URL =
    "https://app.meetless.ai/cli/authorize?state=ux5RtVtgv3R9TctPsdCZtA" +
    "&code_challenge=KFGVfiGZyxcanJqchQI6nNRtpxaTJzqPPBdOl2xWrsQ" +
    "&code_challenge_method=S256" +
    "&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback" +
    "&client_id=mla&machine_hint=neutrino&os=Windows_NT+10.0.26200";

  it("uses `open` on darwin with the raw URL", async () => {
    const { calls, run } = rec();
    const code = await openBrowser(OAUTH_URL, { platform: "darwin", run });
    expect(code).toBe(0);
    expect(calls).toEqual([{ cmd: "open", args: [OAUTH_URL], opts: undefined }]);
  });

  it("uses `xdg-open` on linux with the raw URL", async () => {
    const { calls, run } = rec();
    const code = await openBrowser(OAUTH_URL, { platform: "linux", run });
    expect(code).toBe(0);
    expect(calls[0].cmd).toBe("xdg-open");
    expect(calls[0].args).toEqual([OAUTH_URL]);
  });

  it("quotes the URL as ONE token and passes args verbatim on win32", async () => {
    const { calls, run } = rec();
    const code = await openBrowser(OAUTH_URL, { platform: "win32", run });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("cmd");
    // Empty "" window title, then the whole URL as a single quoted argv element.
    expect(calls[0].args).toEqual(["/c", "start", '""', `"${OAUTH_URL}"`]);
    expect(calls[0].opts).toEqual({ windowsVerbatimArguments: true });
  });

  it("keeps code_challenge and redirect_uri inside the single win32 token", async () => {
    const { calls, run } = rec();
    await openBrowser(OAUTH_URL, { platform: "win32", run });
    const urlToken = calls[0].args[calls[0].args.length - 1];
    // Everything past the first `&` (which cmd would otherwise drop) is present.
    expect(urlToken).toContain("code_challenge=KFGVfiGZyxcanJqchQI6nNRtpxaTJzqPPBdOl2xWrsQ");
    expect(urlToken).toContain("redirect_uri=");
    // The token is a SINGLE argv element -- no extra args got split off on `&`.
    expect(calls[0].args).toHaveLength(4);
  });
});
