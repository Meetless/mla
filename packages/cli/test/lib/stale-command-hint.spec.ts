import { formatStaleCommandHint } from "../../src/lib/update-check";

// The hint appended to an "unknown command / unknown subcommand" error so an
// operator (or a coding agent driving mla over a pipe, where the TTY-gated update
// nag never shows) never concludes "mla can't do this" when the real cause is a
// stale binary that predates the verb.
describe("formatStaleCommandHint", () => {
  it("names the cached newer version and points at `mla upgrade`", () => {
    const hint = formatStaleCommandHint({
      current: "0.2.10",
      latestVersion: "0.2.12",
      minVersion: null,
    });
    expect(hint).toContain("A newer mla is available");
    expect(hint).toContain("0.2.10");
    expect(hint).toContain("0.2.12");
    expect(hint).toContain("mla upgrade");
  });

  it("uses required wording when current is below the floor", () => {
    const hint = formatStaleCommandHint({
      current: "0.2.10",
      latestVersion: "0.2.12",
      minVersion: "0.2.11",
    });
    expect(hint).toContain("below the minimum supported version");
    expect(hint).toContain("0.2.12");
    expect(hint).toContain("mla upgrade");
  });

  it("falls back to a soft pointer when the cache has no newer version", () => {
    const hint = formatStaleCommandHint({
      current: "0.2.12",
      latestVersion: null,
      minVersion: null,
    });
    expect(hint).toContain("may be out of date");
    expect(hint).toContain("mla upgrade");
    expect(hint).not.toContain("A newer mla is available");
  });

  it("stays soft (no false 'newer available') when already on the latest", () => {
    const hint = formatStaleCommandHint({
      current: "0.2.12",
      latestVersion: "0.2.12",
      minVersion: "0.2.11",
    });
    expect(hint).toContain("may be out of date");
    expect(hint).not.toContain("A newer mla is available");
    expect(hint).not.toContain("below the minimum supported version");
  });

  it("stays soft for an unparseable dev build (never claims it is behind)", () => {
    const hint = formatStaleCommandHint({
      current: "b6a81f7a-dirty",
      latestVersion: "0.2.12",
      minVersion: "0.2.11",
    });
    expect(hint).toContain("may be out of date");
    expect(hint).not.toContain("A newer mla is available");
    expect(hint).not.toContain("below the minimum supported version");
  });

  it("always begins with a newline so it appends cleanly after a usage block", () => {
    for (const latestVersion of [null, "0.2.12"]) {
      const hint = formatStaleCommandHint({ current: "0.2.10", latestVersion, minVersion: null });
      expect(hint.startsWith("\n")).toBe(true);
    }
  });
});
