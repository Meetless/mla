import { openUrl, OpenRunResult } from "../../src/lib/open-url";

// B4b (notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 B4, §5 #5).
// The `--open` opt-in launcher. The resolved decision (§5 #5) is "print the URL
// ALWAYS, `--open` opt-in, NO browser auto-open, including for kb add", because the
// agent-proxy loop (§1) drives the CLI headless and auto-launching a browser would
// be hostile. So this helper exists ONLY to back the explicit `--open` flag, never
// to auto-fire. The platform launcher is injected so the suite never opens a real
// browser.

describe("openUrl: platform launcher selection", () => {
  function rec() {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = (cmd: string, args: string[]): OpenRunResult => {
      calls.push({ cmd, args });
      return { status: 0 };
    };
    return { calls, run };
  }

  it("uses `open` on darwin", () => {
    const { calls, run } = rec();
    const r = openUrl("https://console.example.test/relationships", { platform: "darwin", run });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ cmd: "open", args: ["https://console.example.test/relationships"] }]);
  });

  it("uses `xdg-open` on linux", () => {
    const { calls, run } = rec();
    const r = openUrl("https://x.test/y", { platform: "linux", run });
    expect(r.ok).toBe(true);
    expect(calls[0].cmd).toBe("xdg-open");
  });

  it("uses cmd start on win32", () => {
    const { calls, run } = rec();
    const r = openUrl("https://x.test/y", { platform: "win32", run });
    expect(r.ok).toBe(true);
    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args).toContain("start");
    expect(calls[0].args).toContain("https://x.test/y");
  });
});

describe("openUrl: safety + failure surfacing", () => {
  it("refuses a non-http(s) URL without invoking the launcher", () => {
    const calls: string[] = [];
    const run = (cmd: string): OpenRunResult => {
      calls.push(cmd);
      return { status: 0 };
    };
    const r = openUrl("file:///etc/passwd", { platform: "darwin", run });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-http/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses a shell-ish argument that is not an http(s) URL", () => {
    const run = (): OpenRunResult => ({ status: 0 });
    expect(openUrl("; rm -rf /", { platform: "darwin", run }).ok).toBe(false);
  });

  it("surfaces a launcher spawn error (e.g. xdg-open missing)", () => {
    const run = (): OpenRunResult => ({ error: new Error("spawn xdg-open ENOENT") });
    const r = openUrl("https://x.test/y", { platform: "linux", run });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT/);
  });

  it("surfaces a non-zero launcher exit", () => {
    const run = (): OpenRunResult => ({ status: 3 });
    const r = openUrl("https://x.test/y", { platform: "darwin", run });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exit/i);
  });
});
