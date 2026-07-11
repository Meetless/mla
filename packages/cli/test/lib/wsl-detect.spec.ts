import {
  detectWslUnderWindows,
  shouldSurfaceWslHint,
  WSL_MLA_HINT,
} from "../../src/lib/wsl-detect";

// WSL-under-Windows detection drives the `mla doctor` cross-boundary invocation
// nudge (pilot user trunglx, 2026-07-10: a Windows-side coding agent path-mangled
// a leading-slash mla arg into `C:/Program Files/...`). Detection is pure and
// dependency-injected so these assertions pin the Windows-only behavior on
// macOS/Linux CI, where there is no real WSL to run under.

describe("detectWslUnderWindows", () => {
  it("is true on Linux when $WSL_DISTRO_NAME is set", () => {
    expect(
      detectWslUnderWindows({ platform: "linux", wslDistroName: "Ubuntu" }),
    ).toBe(true);
  });

  it("is true on Linux when the kernel release carries the microsoft marker", () => {
    expect(
      detectWslUnderWindows({
        platform: "linux",
        wslDistroName: "",
        osRelease: "5.15.153.1-microsoft-standard-WSL2",
      }),
    ).toBe(true);
  });

  it("is true when the kernel release carries a bare WSL marker", () => {
    expect(
      detectWslUnderWindows({
        platform: "linux",
        wslDistroName: "",
        osRelease: "6.6.36.6-WSL2-standard",
      }),
    ).toBe(true);
  });

  it("is false on plain Linux (no WSL signals)", () => {
    expect(
      detectWslUnderWindows({
        platform: "linux",
        wslDistroName: "",
        osRelease: "6.8.0-45-generic",
      }),
    ).toBe(false);
  });

  it("is false on macOS regardless of a stray WSL env var", () => {
    // Short-circuits on platform before ever reading env/proc.
    expect(
      detectWslUnderWindows({ platform: "darwin", wslDistroName: "Ubuntu" }),
    ).toBe(false);
  });

  it("is false on native Windows", () => {
    expect(detectWslUnderWindows({ platform: "win32" })).toBe(false);
  });

  it("treats a whitespace-only distro name as no signal", () => {
    expect(
      detectWslUnderWindows({
        platform: "linux",
        wslDistroName: "   ",
        osRelease: "6.8.0-45-generic",
      }),
    ).toBe(false);
  });
});

describe("shouldSurfaceWslHint", () => {
  it("fires under WSL for a non-interactive (agent-driven) invocation", () => {
    expect(shouldSurfaceWslHint(true, false)).toBe(true);
  });

  it("stays quiet under WSL for an interactive human at a TTY", () => {
    expect(shouldSurfaceWslHint(true, true)).toBe(false);
  });

  it("never fires off WSL, interactive or not", () => {
    expect(shouldSurfaceWslHint(false, false)).toBe(false);
    expect(shouldSurfaceWslHint(false, true)).toBe(false);
  });
});

describe("WSL_MLA_HINT", () => {
  it("shows the single-quoted, $HOME-relative WSL invocation", () => {
    // Single quotes + literal $HOME + no leading slash: the exact form that
    // survives Git Bash path conversion on the Windows side.
    expect(WSL_MLA_HINT).toContain(
      "wsl -e bash -c '$HOME/.meetless/bin/mla <args>'",
    );
  });

  it("states the community-support posture and where to report", () => {
    expect(WSL_MLA_HINT).toContain("community-supported");
    expect(WSL_MLA_HINT).toContain("macOS and Linux");
    expect(WSL_MLA_HINT).toContain("https://github.com/Meetless/mla");
  });

  it("never embeds a Windows-mangled path literal", () => {
    // The hint documents the failure ("C:/Program Files/...") but must never ship
    // a real backslash Windows path that a copy-paste could execute.
    expect(WSL_MLA_HINT).not.toContain("\\");
  });
});
